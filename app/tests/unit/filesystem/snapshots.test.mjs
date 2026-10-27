// 内部仓库与快照的单元测试（docs/specs/file-system.md §4.1–§4.4、§4.6、§4.7；验收 §19.2 FS-06、FS-07、FS-08、FS-26 的
// 单元层，以及评审修过的几处：FS-06 建立被打断、删不掉的锁，FS-20 删除会话的整理，FS-11 记录写到哪个会话文件）。
// 用真实 git（Git for Windows）在 os.tmpdir() 下很短的临时目录里建 synthetic 的项目；上限按 §19.1 注入很小的值
// （单个文件 1 KB、新文件 20 个、每批 5 条）。整个文件把 HOME、USERPROFILE 指到测试目录，那里的全局配置（synthetic）设
// core.autocrlf=true、core.excludesFile 与一个找不到程序的 LFS 过滤器（filter.lfs.required=true）：你的仓库的调用读它，
// 内部仓库的调用不读（§4.1 隔离的配置）。嵌套仓库与 CRLF 的 Rewind 经 rewind.ts（同一个包里的 R）。
// 本机每秒只能起五六十个 git 进程（§19.1 要求整组单元测试不超过 20 秒），所以互不相干的测试并行跑，能共用的共用一张
// 快照与一份内核模块（各用自己的工作路径：队列、上一张、归属都按工作路径分，新的工作路径就是“这次后台进程里的第一个
// 作业”）；换了 spawn、上限或要等队列做完的测试各用一份全新的内核模块（等于各自一次后台进程；git --version 由替身回答，
// 见 snap-helpers.mjs）。超时用挂住的替身进程加只给它的很短的每步超时（timingOutKit），不用假计时器，也就能和别的测试
// 并行。日志统一收起来，各测试按自己的路径或会话 id 查。测试先用 check 收集，文件末尾一个并行的 describe 登记。

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, relative } from 'node:path';
import * as H from './snap-helpers.mjs';

// ---- 原文（file-system.md §4.1、§4.4，照 snapshots.ts 的常量） ----

const COUNT_PAUSE = 'Snapshots are paused for this folder: more than 20,000 new files would be added. '
  + 'Add generated folders to .gitignore to resume.';
const TIMEOUT_PAUSE = 'Snapshots are paused for this folder: a snapshot took longer than 2 minutes. '
  + 'They resume when Mori restarts.';
const TIMEOUT_ERROR = 'a snapshot step took longer than 2 minutes';
/** @brief 归属冲突的原因（§4.1）。 */
const ownerText = (owner) => `Snapshots are off for this folder: its snapshot folder belongs to ${owner}.`;
/** CRLF 的文件内容 */
const CRLF = 'one\r\ntwo\r\n';
/** 后台实例的运行标出的 Agent（实例的段同样记进用户会话，§4.6） */
const TASK_AGENT = { role: 'Executor', task: 'T1', self: false };
/** 替身让列新文件失败时的 stderr（synthetic）与 gitError 给出的原文 */
const SYNTHETIC_FAILURE = 'synthetic failure';

// ---- 整个文件的环境：测试用的全局配置、收起的日志、记下的 stat ----

const { root, remove } = H.tempRoot('mfs-');
const home = join(root, 'home');
mkdirSync(home);
writeFileSync(join(home, 'global-ignore'), '*.gtmp\n');
writeFileSync(join(home, '.gitconfig'), globalConfig(home));
/** 共用的内核模块用的快照目录 */
const sharedSnaps = join(root, 's');

/** @brief 测试用的全局配置（synthetic）：自动换行、全局忽略文件、找不到程序却 required 的 LFS 过滤器。 */
function globalConfig(dir) {
  return ['[core]', '\tautocrlf = true', `\texcludesFile = ${dir.replace(/\\/g, '/')}/global-ignore`,
    '[filter "lfs"]', '\trequired = true', '\tclean = mori-no-such-lfs clean -- %f',
    '\tsmudge = mori-no-such-lfs smudge -- %f', '\tprocess = mori-no-such-lfs filter-process', ''].join('\n');
}

const savedEnv = new Map(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'].map((name) => [name, process.env[name]]));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;

const logLines = [];
const savedConsole = { error: console.error, log: console.log };
console.error = (...args) => logLines.push(args.map(String).join(' '));
console.log = (...args) => logLines.push(args.map(String).join(' '));

// 快照模块经 node:fs/promises 的 stat 量新文件的大小（§4.4 第 4 步）：换成记下路径再照常 stat 的版本
const statted = [];
const realStat = fsp.stat;
fsp.stat = function countedStat(path, ...rest) {
  statted.push(String(path));
  return realStat.call(this, path, ...rest);
};
syncBuiltinESMExports();

after(() => {
  fsp.stat = realStat;
  syncBuiltinESMExports();
  console.error = savedConsole.error;
  console.log = savedConsole.log;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    remove();
  } catch (error) {
    console.error(`could not remove ${root}: ${error.message}`);
  }
});

// ---- 小工具 ----

/** 共用的内核模块（默认的小上限，真的 spawn） */
const sharedKit = H.once(() => H.freshKit(sharedSnaps));

/** 收集的测试：[名字, 函数]，文件末尾的 describe 一起并行登记 */
const TESTS = [];

/**
 * @brief 收集一个测试（名字以验收编号开头）。
 * @param name 测试名
 * @param fn 测试函数
 */
function check(name, fn) {
  TESTS.push([name, fn]);
}

/** @brief 与 text 完全相同的日志行数。 */
function logged(text) {
  return logLines.filter((line) => line === text).length;
}

/** @brief 以 text 开头的日志行数。 */
function loggedStart(text) {
  return logLines.filter((line) => line.startsWith(text)).length;
}

/** @brief 对 dir 里的文件做过的 stat。 */
function statsUnder(dir) {
  const prefix = `${dir}\\`.toLowerCase();
  return statted.filter((path) => path.toLowerCase().startsWith(prefix));
}

/** @brief 快照状态里的 state、reason、error。 */
function stateOf(kit, cwd) {
  const { state, reason, error } = kit.S.snapshotState(cwd);
  return { state, reason, error };
}

/** @brief 快照状态里的嵌套仓库与 error。 */
function nestedOf(kit, cwd) {
  const { nested, nestedTotal, error } = kit.S.snapshotState(cwd);
  return { nested, nestedTotal, error };
}

/** @brief 拍一张，必须拍成；返回提交。 */
async function shot(kit, cwd) {
  const result = await H.shoot(kit, cwd);
  assert.ok('oid' in result, `the snapshot failed: ${JSON.stringify(result)}`);
  return result.oid;
}

/** @brief 名字 <prefix>00 … 的列表。 */
function numbered(prefix, count, suffix = '') {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, '0')}${suffix}`);
}

/** @brief 写一组文件（相对路径 → 内容；内容省略时为路径加换行）。 */
function putAll(base, files) {
  const entries = Array.isArray(files) ? files.map((rel) => [rel, `${rel}\n`]) : Object.entries(files);
  for (const [rel, content] of entries) H.put(base, rel, content);
}

/** @brief 工作路径里一个文件的文字（相对路径 / 分隔）。 */
function textAt(cwd, rel) {
  return readFileSync(join(cwd, ...rel.split('/')), 'utf8');
}

/** 读过的快照的树（内部仓库 + 提交 → treeOf 的结果）：提交不会变，几个测试读同一张时只起一个 git */
const trees = new Map();

/** @brief 一张快照（提交）的树里的条目，同一张只读一次。 */
function treeAt(repo, oid) {
  const key = `${repo}\0${oid}`;
  if (!trees.has(key)) trees.set(key, H.treeOf(repo, oid));
  return trees.get(key);
}

/** @brief 一张快照（提交）的树里的路径，排好序。 */
async function pathsAt(repo, oid) {
  return (await treeAt(repo, oid)).map((item) => item.path).sort();
}

/**
 * @brief 一个刚建的仓库检出的提交：读 .git/HEAD 与它指向的分支文件（刚建的仓库没有 packed-refs），不起 git。
 * @param dir 仓库目录（.git 是目录）
 */
function headOf(dir) {
  const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  return readFileSync(join(dir, '.git', ...head.slice('ref: '.length).split('/')), 'utf8').trim();
}

/** @brief 一张快照里每个文件的 blob id（路径 → id）。 */
async function blobIds(repo, oid) {
  return new Map((await treeAt(repo, oid)).map((item) => [item.path, item.id]));
}

/** @brief 在内部仓库里把文件恢复到一张快照（rewind.ts 的做法：git restore --source --worktree，在队列里）。 */
function restoreFrom(kit, cwd, oid, files) {
  const args = ['--literal-pathspecs', 'restore', `--source=${oid}`, '--worktree', '--', ...files];
  return kit.S.inQueue(cwd, () => kit.S.snapshotGit(cwd, args));
}

/** 你的 git 看到的文件（工作路径 → gitSees 的结果）：拍完之后这些工作路径不再变 */
const seenBy = new Map();

/** @brief 你的 git 看到的工作路径里的文件（git status 的规则：已跟踪的加上没被忽略的），去掉总被排除的两处。 */
function gitSees(cwd) {
  if (!seenBy.has(cwd)) {
    seenBy.set(cwd, H.git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).then((out) => H
      .nulSplit(out.stdout).filter((path) => !path.startsWith('.work/') && !path.startsWith('.mori/worktrees/'))
      .sort()));
  }
  return seenBy.get(cwd);
}

/** @brief 你的仓库这一刻的样子：ref、index 的字节、git status、工作路径里的 .git。 */
async function userRepoState(cwd) {
  const status = await H.git(cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z']);
  return {
    refs: await H.gitText(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: createHash('sha256').update(readFileSync(join(cwd, '.git', 'index'))).digest('hex'),
    status: status.stdout.toString('utf8'),
    gits: H.gitEntries(cwd),
  };
}

/**
 * @brief 用户会话（登记进快照模块）里先有一条你的消息，再让它的一个后台实例（synthetic 的 pi 会话，self 为假）
 *        开始一次运行：实例的段记进用户会话（§4.6），轮是你最近的那条消息；实例的运行不在结束后读 git 状态。
 * @return { handle, ctx, message }：message 是你的消息的条目 id
 */
async function taskRun(kit, sessionId, cwd, sessionManager) {
  const message = sessionManager.appendMessage(H.userMessage('Do the task'));
  const handle = H.snapUser(kit, { sessionId, cwd, sessionManager, self: false, agent: TASK_AGENT });
  const ctx = await H.startRun(handle, null, { cwd, sessionManager: SessionManager.inMemory(cwd) });
  return { handle, ctx, message };
}

// ---- 共用的 synthetic 项目 ----

/** 仓库根的 .gitignore（含按字面的 [ ] # !、空格与非 ASCII 的名字） */
const IGNORE_RULES = ['node_modules/', '*.log', '/top-only.txt', '\\[x\\].txt', '\\#hash.txt', '\\!bang.txt',
  'my notes.txt', 'déjà vu/', ''].join('\n');
/** 提交进你的仓库的文件（keep.log 匹配 *.log，用 add -f 跟踪） */
const TRACKED = { '.gitignore': IGNORE_RULES, 'a.txt': 'a\n', 'src/b.txt': 'b\n', 'app/main.js': 'main\n',
  'keep.log': 'kept\n' };
/** 没跟踪、也没被忽略的文件：进快照 */
const UNTRACKED = ['x.txt', 'my notes 2.txt', 'café.txt', '报告.md', 'app/top-only.txt',
  '.mori/agents/a.md', 'sub/.work/k.txt', 'app/.work/t.txt'];
/** 被忽略的文件：各级 .gitignore、info/exclude、全局 core.excludesFile */
const IGNORED = ['node_modules/m.js', 'app/node_modules/x.js', 'app.log', 'app/debug.log', 'top-only.txt',
  '[x].txt', '#hash.txt', '!bang.txt', 'my notes.txt', 'déjà vu/v.txt', 'café.log', 'local-only.txt',
  'temp.gtmp'];
/** 工作路径根上总被排除的 */
const ALWAYS_OUT = ['.work/w.txt', '.mori/worktrees/wt/f.txt'];

/** 你的仓库（有暂存与未暂存的改动）：在仓库根与子文件夹 app 各拍一张，前后记下仓库的样子 */
const ignoreProject = H.once(async () => {
  const kit = await sharedKit();
  const { cwd } = H.newBox(root, sharedSnaps);
  putAll(cwd, TRACKED);
  await H.git(cwd, ['init', '--quiet']);
  await H.git(cwd, ['add', '-A', '-f']);
  await H.git(cwd, ['commit', '--quiet', '-m', 'init']);
  writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'local-only.txt\n');
  putAll(cwd, [...UNTRACKED, ...IGNORED, ...ALWAYS_OUT]);
  H.put(cwd, 'a.txt', 'a staged\n');
  await H.git(cwd, ['add', 'a.txt']);
  H.put(cwd, 'src/b.txt', 'b unstaged\n');
  const before = await userRepoState(cwd);
  const [rootOid, appOid] = await Promise.all([shot(kit, cwd), shot(kit, join(cwd, 'app'))]);
  return { cwd, kit, rootOid, appOid, before, after: await userRepoState(cwd) };
});

/** 你的仓库：logs/ 眼下全被忽略，build/ 整个被忽略（FS-07 的最后两条） */
const wholeProject = H.once(async () => {
  const kit = await sharedKit();
  const box = H.newBox(root, sharedSnaps);
  putAll(box.cwd, { '.gitignore': '*.log\nbuild/\n', 'a.txt': 'a\n' });
  // 认仓库与忽略列表不需要提交
  await H.git(box.cwd, ['init', '--quiet', '--template=']);
  putAll(box.cwd, ['logs/a.log', 'build/out.txt', 'build/sub/o.txt']);
  return { box, kit };
});

/** 默认排除的五个目录：留下的（同名的文件、更深处的 .work、.mori/worktrees）与排除的 */
const DEFAULT_KEPT = ['src/main.c', 'deep/dist', 'deep/x/build.txt', 'my target/t.txt', 'sub/.work/k.txt',
  'sub/.mori/worktrees/w.txt', '.mori/agents/a.md'];
const DEFAULT_DROPPED = ['node_modules/a.js', '.venv/b.py', 'dist/c.js', 'build/d.o', 'target/e.class',
  'deep/x/node_modules/f.js', 'deep/x/.venv/g.py', 'deep/y/dist/h.js', 'deep/y/build/i.o', 'deep/z/target/j.class',
  '.work/w.txt', '.mori/worktrees/wt/f.txt'];
/**
 * 按字节存取的文件：.gitattributes 要求换行转换与 LFS 过滤器，CRLF、LF、二进制；note.gtmp 匹配测试的全局
 * core.excludesFile（不是仓库时只排除五个默认目录，它要进快照：内部仓库的调用读了你的全局配置就会丢掉它）
 */
const BYTE_FILES = {
  '.gitattributes': '* text=auto eol=lf\n*.bin filter=lfs diff=lfs merge=lfs -text\n',
  'crlf.txt': CRLF, 'lf.txt': 'one\ntwo\n', 'data.bin': Buffer.from([0, 1, 13, 10, 255, 13, 10, 0]),
  'note.gtmp': 'kept\n',
};

/**
 * 不是 git 仓库的工作路径（FS-06 的位置、按字节存取、隔离的配置，FS-07 的默认排除）：它的内部仓库目录是上次建立到
 * 一半留下的（只有两个锁、没有 HEAD）
 */
const defaultsProject = H.once(async () => {
  const kit = await sharedKit();
  const box = H.newBox(root, sharedSnaps);
  const repo = join(box.snaps, H.encodedName(box.cwd));
  putAll(repo, { 'config.lock': '', 'HEAD.lock': '' });
  putAll(box.cwd, [...DEFAULT_KEPT, ...DEFAULT_DROPPED]);
  putAll(box.cwd, BYTE_FILES);
  return { box, kit, repo, oid: await shot(kit, box.cwd) };
});

/**
 * 上次的后台进程留下的内部仓库：三种锁、没有 info/attributes；工作路径里有 .gitattributes 与 CRLF 文件。
 * 拍完之后 Mori 不再碰这个内部仓库（各测试只读），归属的测试（FS-06）就用它：那里“重启”的内核模块的第一个作业先清锁，
 * 换成还有作业在跑的内部仓库会删掉别人正持有的锁（§0 已知的限制：两个实例同时开）
 */
const LOCKS = ['index.lock', 'packed-refs.lock', join('refs', 'mori', 'x.lock')];
const lockProject = H.once(async () => {
  const kit = await sharedKit();
  const box = H.newBox(root, sharedSnaps);
  const repo = await H.oldRepo(box, null);
  for (const lock of LOCKS) H.put(repo, lock.replace(/\\/g, '/'), '');
  putAll(box.cwd, { '.gitattributes': '* text=auto eol=lf\n', 'crlf.txt': CRLF });
  return { box, kit, repo, oid: await shot(kit, box.cwd) };
});

/** 你的 git 拒绝这个文件夹（替身给出 dubious ownership）；内部仓库是上次留下的、info/attributes 内容不对 */
const dubiousProject = H.once(async () => {
  const box = H.newBox(root);
  const repo = await H.oldRepo(box, '* text=auto\n');
  H.put(box.cwd, 'a.txt', 'a\n');
  const kit = await H.freshKit(box.snaps);
  const line = `detected dubious ownership in repository at '${box.cwd.replace(/\\/g, '/')}'`;
  const userRevParse = (args) => !H.internalCall(args) && args[0] === 'rev-parse' && args.includes('--show-toplevel');
  const spy = H.spyGit(kit, (args) => (userRevParse(args)
    ? { stderr: `fatal: ${line}\nTo add an exception for this directory, call:\n`, code: 128 } : null));
  return { box, kit, repo, line, spy, result: await H.shoot(kit, box.cwd) };
});

/** 你的仓库：已跟踪的大文件、21 个没跟踪的大文件、正好 1 KB 的、小文件与 12 个新文件（上限 40 个新文件，每批 5 条） */
const sizeProject = H.once(async () => {
  const box = H.newBox(root);
  H.put(box.cwd, 'tracked-big.bin', Buffer.alloc(2048, 1));
  await H.initRepo(box.cwd);
  const big = numbered('big', 21, '.bin');
  for (const rel of big) H.put(box.cwd, rel, Buffer.alloc(1025, 2));
  const small = numbered('n', 12, '.txt');
  putAll(box.cwd, [...small, 'small.txt']);
  H.put(box.cwd, 'edge.bin', Buffer.alloc(1024, 3));
  const kit = await H.freshKit(box.snaps, { maxNewFiles: 40 });
  const spy = H.spyGit(kit);
  return { box, kit, spy, big, small, oid: await shot(kit, box.cwd) };
});

/**
 * @brief 两个嵌套的仓库（FS-26）：vendor/mod 照子模块的样子摆好（.git 是指向你的 .git/modules/mod 的文件，你的仓库里
 *        有 .gitmodules 与 gitlink；git submodule add 在 Windows 上要一秒多，所以逐项摆）；vendor/lib 是不是子模块、
 *        已有提交的独立仓库。两个仓库同时建（本机起 git 进程慢）。工作路径里另有 .gitattributes 与 CRLF 文件
 *        （FS-06：Rewind 之后逐字节相同），你的仓库不跟踪它们。
 * @param cwd 工作路径（你的仓库根）
 */
async function nestedRepos(cwd) {
  putAll(cwd, { 'a.txt': 'a\n', 'vendor/lib/x.txt': 'x\n', 'vendor/mod/y.txt': 'y\n',
    '.gitattributes': '* text=auto eol=lf\n', 'crlf.txt': CRLF });
  const mod = join(cwd, 'vendor', 'mod');
  const modDir = `--separate-git-dir=${join(cwd, '.git', 'modules', 'mod')}`;
  const submodule = async () => {
    await H.git(cwd, ['init', '--quiet', '--template=']);
    mkdirSync(join(cwd, '.git', 'modules'));
    await H.git(cwd, ['init', '--quiet', '--template=', modDir, mod]);
    await H.git(mod, ['add', '-A']);
    await H.git(mod, ['commit', '--quiet', '-m', 'init']);
  };
  await Promise.all([H.initRepo(join(cwd, 'vendor', 'lib'), { template: '' }), submodule()]);
  H.put(cwd, '.gitmodules', '[submodule "mod"]\n\tpath = vendor/mod\n\turl = ../mod-origin\n');
  await H.git(cwd, ['add', 'a.txt', '.gitmodules', 'vendor/mod']);
}

/**
 * 嵌套仓库（FS-26）：你的会话自己的一次运行（由你的消息开始，所以有 run 记录、能 Rewind）里改两个嵌套仓库里面的文件
 * （vendor/lib 还多了一个提交）、改 a.txt 与 crlf.txt，再把 vendor/lib 复制成 19 个已有提交的仓库（共 21 个）。
 */
const nestedProject = H.once(async () => {
  const box = H.newBox(root);
  const [kit, Sessions] = await Promise.all([H.freshKit(box.snaps, { batch: 30 }), H.loadSessionManager(),
    nestedRepos(box.cwd)]);
  const sm = Sessions.inMemory(box.cwd);
  const handle = H.snapUser(kit, { sessionId: 'nested26', cwd: box.cwd, sessionManager: sm });
  const ctx = await H.startRun(handle, 'Change things');
  const message = sm.getLeafId();
  const atStart = nestedOf(kit, box.cwd);
  putAll(box.cwd, { 'vendor/lib/x.txt': 'x2\n', 'vendor/lib/new.txt': 'new\n', 'vendor/mod/y.txt': 'y2\n',
    'a.txt': 'a2\n', 'crlf.txt': 'changed\n' });
  const lib = join(box.cwd, 'vendor', 'lib');
  const heads = { init: headOf(lib) };
  await H.git(lib, ['commit', '--quiet', '-am', 'second']);
  heads.second = headOf(lib);
  const copies = numbered('vendor/more/r', 19);
  for (const rel of copies) cpSync(lib, join(box.cwd, ...rel.split('/')), { recursive: true });
  await H.endRun(kit, handle, ctx);
  return { box, kit, handle, message, atStart, atEnd: nestedOf(kit, box.cwd), records: H.turnRecords(sm), copies,
    heads };
});

/** 上面那次运行之后只恢复代码，Rewind 到它的那条消息（rewind.ts） */
const nestedRewind = H.once(async () => {
  const project = await nestedProject();
  const { box, kit, handle, message } = project;
  const input = { entryId: message, code: true, conversation: false };
  const result = await kit.R.rewind(H.rewindSession(handle), input);
  return { ...project, result, libHead: headOf(join(box.cwd, 'vendor', 'lib')) };
});

// 嵌套仓库这一串（准备、运行开始与结束的快照、Rewind，四十多个依次起的 git 进程）最长，在这里就开始：下面载入 pi 的
// SessionManager 要半秒多，这段时间里没有别的测试在起 git。失败由等它的测试报告（先挂上空的 catch）
nestedRewind().catch(() => undefined);

/** 两个会话的 ref：删除其中一个（git prune），再看别的会话打开时内部仓库目录留不留（FS-20） */
const pruneProject = H.once(async () => {
  const kit = await sharedKit();
  const { cwd } = H.newBox(root, sharedSnaps);
  H.put(cwd, 'a.txt', 'one\n');
  const keep = (sessionId, oid) => kit.S.inQueue(cwd, () => kit.S.keepRefs(cwd, sessionId, 'rewind/e1', [oid]));
  const first = await shot(kit, cwd);
  await keep('keep20', first);
  H.put(cwd, 'a.txt', 'two\n');
  await keep('gone20b', await shot(kit, cwd));
  const repo = kit.S.snapshotRepo(cwd);
  const stray = await H.strayObject(repo, 'nobody refers to this\n');
  const dropped = await kit.S.dropSnapshots('gone20b', cwd);
  const [strayLeft, firstLeft, kept, restored] = await Promise.all([H.hasObject(repo, stray),
    H.hasObject(repo, first), kit.S.inQueue(cwd, () => kit.S.refsKept(cwd, 'keep20', 'rewind/e1', [first])),
    restoreFrom(kit, cwd, first, ['a.txt'])]);
  const text = readFileSync(join(cwd, 'a.txt'), 'utf8');
  return { kit, cwd, repo, first, dropped, strayLeft, firstLeft, kept, restored, text };
});

/** @brief 一个登记进快照模块的用户会话（synthetic；headless 为增强会话）。 */
function plainUser(sessionId, cwd, headless) {
  return { sessionId, cwd, headless, emit: () => undefined, sessionManager: SessionManager.inMemory(cwd) };
}

/**
 * 接着上面：工作路径上面的文件夹被删掉之后再删除会话（FS-20，负责人不在时定下的第 7 条：只碰 ref 与对象的 git 调用
 * 以内部仓库的目录为 cwd 与 --work-tree）。先删 keep20，还有 other20 的 ref：git prune 在内部仓库目录里跑；再删 other20，
 * 没有 ref 了，但同一个工作路径上还开着一个非增强会话 open20：目录留着；再删 open20，只剩增强会话 bg20：整个目录删掉。
 */
const goneProject = H.once(async () => {
  const { kit, cwd, repo, first: oid } = await pruneProject();
  const kept = await kit.S.inQueue(cwd, () => kit.S.keepRefs(cwd, 'other20', 'rewind/e2', [oid]));
  rmSync(join(cwd, '..'), { recursive: true, force: true });
  const stray = await H.strayObject(repo, 'nobody refers to this either\n');
  const pruned = await kit.S.dropSnapshots('keep20', cwd);
  const [strayLeft, refs] = await Promise.all([H.hasObject(repo, stray), H.moriRefs(repo)]);
  const afterPrune = { head: existsSync(join(repo, 'HEAD')), strayLeft, refs: refs.sort() };
  kit.S.registerSnapshotUser(plainUser('open20', cwd, false));
  const whileOpen = await kit.S.dropSnapshots('other20', cwd);
  const afterOpen = { head: existsSync(join(repo, 'HEAD')), refs: await H.moriRefs(repo) };
  kit.S.unregisterSnapshotUser('open20');
  kit.S.registerSnapshotUser(plainUser('bg20', cwd, true));
  const last = await kit.S.dropSnapshots('open20', cwd);
  kit.S.unregisterSnapshotUser('bg20');
  return { repo, oid, kept, pruned, afterPrune, whileOpen, afterOpen, last, removed: !existsSync(repo) };
});

/**
 * 同一个工作路径上两个用户会话各有一个后台实例在跑（FS-11）。结束快照排着时：gone11 已释放、会话文件被删；
 * reopen11 已释放又重新打开（新的 SessionManager 与 emit）。这一段同时记给两个会话。
 */
const releasedProject = H.once(async () => {
  const box = H.newBox(root);
  H.put(box.cwd, 'a.txt', 'a\n');
  const kit = await H.freshKit(box.snaps);
  const sessions = join(box.dir, 'sessions');
  const gone = await taskRun(kit, 'gone11', box.cwd, SessionManager.create(box.cwd, sessions));
  const old = SessionManager.create(box.cwd, sessions);
  const kept = await taskRun(kit, 'reopen11', box.cwd, old);
  H.put(box.cwd, 'a.txt', 'a\nb\n');
  const goneFile = gone.handle.user.sessionManager.getSessionFile();
  const existed = existsSync(goneFile);
  kit.S.unregisterSnapshotUser('gone11');
  rmSync(goneFile);
  kit.S.unregisterSnapshotUser('reopen11');
  const reopened = SessionManager.open(old.getSessionFile(), sessions);
  const events = [];
  kit.S.registerSnapshotUser({ sessionId: 'reopen11', cwd: box.cwd, sessionManager: reopened, headless: false,
    emit: (event) => events.push(event) });
  const sent = { gone: gone.handle.events.length, kept: kept.handle.events.length };
  await H.endRun(kit, gone.handle, gone.ctx);
  await H.endRun(kit, kept.handle, kept.ctx);
  return { gone, kept, goneFile, existed, old, reopened, events, sent };
});

/** 挂住的那一步的超时（毫秒）：只给替身进程用，真的 git 调用照常用默认的 120 秒 */
const SHORT_STEP_MS = 50;

/**
 * @brief 超时测试的内核模块：hangNext('batch') 让下一张快照的第 2 批 add 挂住（并照被结束的 git add 的样子留下
 *        index.lock，§4.1），hangNext('list') 让下一张快照列新文件的 ls-files 挂住（替身进程不结束），hangNext('fail')
 *        让它以 synthetic 的原文失败，hangNext(null) 都照常。挂住的那一步之前，经 configureSnapshots 把每步的超时换成
 *        SHORT_STEP_MS（内部仓库的调用在发起时读这个上限：第 1 批 add 起来时换，第 2 批就用短的；列新文件是这张快照里
 *        第一个内部仓库调用，在拍之前换），git.ts 的计时器到点结束替身；之后换回默认值。
 * @param box newBox 的结果
 * @return { kit, spy, hangNext }
 */
async function timingOutKit(box) {
  const kit = await H.freshKit(box.snaps);
  const step = (ms) => kit.S.configureSnapshots({ limits: { stepTimeoutMs: ms } });
  let mode = null;
  let batches = 0;
  const batchStand = () => {
    batches += 1;
    if (batches === 1) step(SHORT_STEP_MS);
    if (batches !== 2) return null;
    writeFileSync(join(kit.S.snapshotRepo(box.cwd), 'index.lock'), '');
    return { hang: true };
  };
  const listing = (args) => H.subcommandOf(args) === 'ls-files';
  const spy = H.spyGit(kit, (args) => {
    if (!H.internalCall(args)) return null;
    if (mode === 'batch' && isBatchAdd(args)) return batchStand();
    if (mode === 'list' && listing(args)) return { hang: true };
    return mode === 'fail' && listing(args) ? { stderr: `fatal: ${SYNTHETIC_FAILURE}\n`, code: 128 } : null;
  });
  const hangNext = (next) => {
    mode = next;
    batches = 0;
    step(next === 'list' ? SHORT_STEP_MS : kit.S.DEFAULT_SNAPSHOT_LIMITS.stepTimeoutMs);
  };
  return { kit, spy, hangNext };
}

/** @brief 分批加入的一次 add（--literal-pathspecs、经 stdin 给路径、不是 -A）。 */
function isBatchAdd(args) {
  return args.includes('--literal-pathspecs') && args.includes('--pathspec-from-file=-') && !args.includes('-A');
}

/**
 * 某一批超时（FS-08）：12 个新文件、每批 5 条，第 2 批挂住到超时；下一张快照照常（只加剩下的 7 个）。
 * 之后的超时计数测试接着用这份内核模块（上一张成功，计数从 0 开始）。
 */
const timeoutProject = H.once(async () => {
  const box = H.newBox(root);
  const names = numbered('n', 12, '.txt');
  putAll(box.cwd, names);
  const { kit, spy, hangNext } = await timingOutKit(box);
  hangNext('batch');
  const failed = await H.shoot(kit, box.cwd);
  const failedState = stateOf(kit, box.cwd);
  const repo = kit.S.snapshotRepo(box.cwd);
  const lock = join(repo, 'index.lock');
  const lockLeft = existsSync(lock);
  const index = await H.indexOf(repo, box.cwd);
  hangNext(null);
  const before = spy.calls.length;
  const next = await H.shoot(kit, box.cwd);
  const batchAdds = spy.calls.slice(before).filter(isBatchAdd).length;
  const paths = 'oid' in next ? await H.pathsOf(repo, next.oid) : [];
  return { box, kit, spy, hangNext, names, repo, failed, failedState, lockLeft, index, next, batchAdds, paths,
    lockGone: !existsSync(lock) };
});

// ---- FS-26 嵌套的 git 仓库 ----

check('FS-26 changes inside a submodule and a standalone nested repo are not recorded; snapshots.nested lists '
  + 'both paths relative to the working path', async () => {
  const { box, kit, atStart, records } = await nestedProject();
  assert.deepEqual(atStart, { nested: ['vendor/lib', 'vendor/mod'], nestedTotal: 2, error: null });
  assert.deepEqual(records.map((record) => record.kind), ['changes', 'run']);
  assert.deepEqual(records[0].files.map((file) => file.path), ['a.txt', 'crlf.txt']);
  assert.deepEqual(records[0].files[0], { path: 'a.txt', status: 'M', added: 1, removed: 1 });
  const tree = await H.treeOf(kit.S.snapshotRepo(box.cwd), records[0].head);
  const inVendor = tree.filter((item) => item.path.startsWith('vendor/'));
  assert.deepEqual(inVendor.filter((item) => item.mode !== '160000'), [], 'only gitlinks under vendor/');
  assert.deepEqual(inVendor.slice(0, 2).map((item) => item.path), ['vendor/lib', 'vendor/mod']);
});

check('FS-26 with 21 nested repos snapshots.nested lists the first 20 and nestedTotal is 21', async () => {
  const { atEnd, copies } = await nestedProject();
  assert.deepEqual(atEnd, { nested: ['vendor/lib', 'vendor/mod', ...copies.slice(0, 18)], nestedTotal: 21,
    error: null });
});

check('FS-26 Rewind restores a.txt and leaves the nested repos alone: their files, the new commit and the 19 repos '
  + 'created after the message', async () => {
  const { box, result, heads, libHead, copies } = await nestedRewind();
  assert.equal(result.kind, 'done', JSON.stringify(result));
  const { restored, deleted, failed } = result.record;
  assert.deepEqual({ restored, deleted, failed }, { restored: ['a.txt', 'crlf.txt'], deleted: [], failed: [] });
  assert.equal(textAt(box.cwd, 'a.txt'), 'a\n');
  const inside = ['vendor/lib/x.txt', 'vendor/lib/new.txt', 'vendor/mod/y.txt'];
  assert.deepEqual(inside.map((rel) => textAt(box.cwd, rel)), ['x2\n', 'new\n', 'y2\n']);
  assert.notEqual(heads.second, heads.init);
  assert.equal(libHead, heads.second, 'vendor/lib still has its new commit checked out');
  assert.deepEqual(copies.filter((rel) => !existsSync(join(box.cwd, ...rel.split('/'), '.git'))), []);
});

check('FS-26 a nested repo without a commit fails the snapshot with git’s text; after its first commit the '
  + 'next snapshot works and lists it; once it is removed the next snapshot clears snapshots.nested', async () => {
  const kit = await sharedKit();
  const { cwd } = H.newBox(root, sharedSnaps);
  putAll(cwd, ['a.txt', 'sub/f.txt']);
  const sub = join(cwd, 'sub');
  await H.git(sub, ['init', '--quiet', '--template=']);
  const text = "'sub/' does not have a commit checked out";
  assert.deepEqual(await H.shoot(kit, cwd), { error: text });
  assert.deepEqual(stateOf(kit, cwd), { state: 'on', reason: null, error: text });
  await H.git(sub, ['add', '-A']);
  await H.git(sub, ['commit', '--quiet', '-m', 'first']);
  await shot(kit, cwd);
  assert.deepEqual(nestedOf(kit, cwd), { nested: ['sub'], nestedTotal: 1, error: null });
  rmSync(sub, { recursive: true, force: true });
  await shot(kit, cwd);
  assert.deepEqual(nestedOf(kit, cwd), { nested: [], nestedTotal: 0, error: null });
});

// ---- FS-07 排除与 git status 一致 ----

check('FS-07 at the repo root the snapshot holds what git status sees: .gitignore, info/exclude, the global '
  + 'core.excludesFile, literal [ ] # ! names, spaces and non-ASCII names', async () => {
  const { cwd, kit, rootOid } = await ignoreProject();
  const taken = await pathsAt(kit.S.snapshotRepo(cwd), rootOid);
  // keep.log（add -f 跟踪又匹配忽略规则）单独一条测试
  const seen = (await gitSees(cwd)).filter((rel) => rel !== 'keep.log');
  assert.deepEqual(taken.filter((rel) => rel !== 'keep.log'), seen);
  for (const rel of [...UNTRACKED, ...Object.keys(TRACKED).filter((name) => name !== 'keep.log')]) {
    assert.ok(taken.includes(rel), `${rel} is missing from the snapshot`);
  }
  for (const rel of [...IGNORED, ...ALWAYS_OUT]) assert.ok(!taken.includes(rel), `${rel} was taken`);
});

check('FS-07 a file you track with git add -f that matches an ignore rule is in the snapshot', async () => {
  const { cwd, kit, rootOid } = await ignoreProject();
  assert.ok((await gitSees(cwd)).includes('keep.log'), 'git status shows the tracked keep.log');
  assert.ok((await pathsAt(kit.S.snapshotRepo(cwd), rootOid)).includes('keep.log'),
    'keep.log is missing from the snapshot');
});

check('FS-07 in a subfolder the repo root’s .gitignore still leaves out node_modules and *.log, and a rule '
  + 'anchored at the repo root does not apply', async () => {
  const { cwd, kit, appOid } = await ignoreProject();
  const app = join(cwd, 'app');
  const taken = await H.pathsOf(kit.S.snapshotRepo(app), appOid);
  assert.deepEqual(taken, await gitSees(app));
  assert.deepEqual(taken, ['main.js', 'top-only.txt']);
});

check('FS-06 in your repo a snapshot adds no ref, leaves the index bytes and git status as they were and puts no '
  + '.git in the working path', async () => {
  const { before, after: now } = await ignoreProject();
  assert.deepEqual(now, before);
  assert.ok(!now.refs.includes('refs/mori'));
  assert.deepEqual(now.gits, ['.git']);
});

check('FS-07 outside a repo node_modules, .venv, dist, build and target are left out at any depth; .work/ and '
  + '.mori/worktrees/ only at the root', async () => {
  const { repo, oid } = await defaultsProject();
  assert.deepEqual(await pathsAt(repo, oid), [...DEFAULT_KEPT, ...Object.keys(BYTE_FILES)].sort());
  assert.equal(readFileSync(join(repo, 'info', 'exclude'), 'utf8'),
    '/.work/\n/.mori/worktrees/\nnode_modules/\n.venv/\ndist/\nbuild/\ntarget/\n');
});

check('FS-07 a folder that is ignored as a whole today: once a file in it is not ignored, the next snapshot '
  + 'takes that file', async () => {
  const { box, kit } = await wholeProject();
  const repo = kit.S.snapshotRepo(box.cwd);
  const exclude = () => readFileSync(join(repo, 'info', 'exclude'), 'utf8');
  const first = await shot(kit, box.cwd);
  assert.deepEqual(await H.pathsOf(repo, first), ['.gitignore', 'a.txt']);
  assert.equal(exclude(), '/.work/\n/.mori/worktrees/\n/build/\n/logs/\n/logs/a.log\n');
  H.put(box.cwd, 'logs/keep.txt', 'keep\n');
  const second = await shot(kit, box.cwd);
  assert.deepEqual(await H.pathsOf(repo, second), ['.gitignore', 'a.txt', 'logs/keep.txt']);
  assert.equal(exclude(), '/.work/\n/.mori/worktrees/\n/build/\n/logs/a.log\n');
});

check('FS-07 a working path that is ignored as a whole gives an empty snapshot', async () => {
  const { box, kit } = await wholeProject();
  const cwd = join(box.cwd, 'build');
  const oid = await shot(kit, cwd);
  const repo = kit.S.snapshotRepo(cwd);
  assert.deepEqual(await H.treeOf(repo, oid), []);
  assert.equal(readFileSync(join(repo, 'info', 'exclude'), 'utf8'), '/.work/\n/.mori/worktrees/\n/*\n');
});

// ---- FS-06 内部仓库 ----

check('FS-06 the internal repo is <snapshots dir>\\<projectDirName(cwd)>, outside the working path, with '
  + 'mori.json, info/attributes and the isolated gitconfig', async () => {
  const { box, kit, repo } = await defaultsProject();
  assert.equal(kit.M.projectDirName(box.cwd), H.encodedName(box.cwd));
  assert.equal(kit.S.snapshotRepo(box.cwd), repo);
  assert.ok(relative(box.cwd, repo).startsWith('..'));
  assert.equal(existsSync(join(repo, 'HEAD')), true);
  assert.equal(readFileSync(join(repo, 'mori.json'), 'utf8'), `${JSON.stringify({ cwd: box.cwd })}\n`);
  assert.equal(readFileSync(join(repo, 'info', 'attributes'), 'utf8'), H.ATTRIBUTES_TEXT);
  assert.equal(readFileSync(join(box.snaps, 'gitconfig'), 'utf8'), H.ISOLATED_CONFIG_TEXT);
  assert.ok(readdirSync(box.snaps).includes(basename(repo)));
});

check('FS-06 a snapshot outside a repo puts no .git in the working path', async () => {
  const { box } = await defaultsProject();
  assert.deepEqual(H.gitEntries(box.cwd), []);
});

check('FS-06 with .gitattributes "* text=auto eol=lf" and a global config with core.autocrlf=true, a '
  + 'core.excludesFile and filter.lfs.required=true (no lfs program) the internal repo reads none of it: CRLF and '
  + 'binary files are stored and restored byte for byte, and a file the global ignore matches is taken', async () => {
  const { box, kit, oid, repo } = await defaultsProject();
  const ids = await blobIds(repo, oid);
  assert.ok(ids.has('note.gtmp'), 'note.gtmp is in the snapshot: the global core.excludesFile is not read');
  for (const [rel, content] of Object.entries(BYTE_FILES)) {
    assert.equal(ids.get(rel), H.blobId(content), `${rel} is stored byte for byte`);
  }
  putAll(box.cwd, { 'crlf.txt': 'changed\n', 'lf.txt': 'changed\r\n', 'note.gtmp': 'changed\n' });
  rmSync(join(box.cwd, 'data.bin'));
  const restored = await restoreFrom(kit, box.cwd, oid, ['crlf.txt', 'lf.txt', 'data.bin', 'note.gtmp']);
  assert.equal(restored.code, 0, restored.stderr);
  for (const [rel, content] of Object.entries(BYTE_FILES)) {
    assert.deepEqual(readFileSync(join(box.cwd, rel)), Buffer.from(content), `${rel} after the restore`);
  }
  assert.equal(kit.S.snapshotState(box.cwd).error, null);
});

check('FS-06 a CRLF file under .gitattributes "* text=auto eol=lf" is byte for byte the same after a Rewind',
  async () => {
    const { box, result } = await nestedRewind();
    assert.equal(result.kind, 'done', JSON.stringify(result));
    assert.deepEqual(readFileSync(join(box.cwd, 'crlf.txt')), Buffer.from(CRLF));
  });

check('FS-06 a snapshot folder whose mori.json names another working path with the same encoding: snapshots '
  + 'are off with the exact reason, also after a restart', async () => {
  const { box, kit, repo } = await lockProject();
  const other = join(root, `${basename(box.dir)}-p`);
  H.put(other, 'two.txt', '2\n');
  assert.equal(kit.M.projectDirName(other), kit.M.projectDirName(box.cwd));
  const reason = ownerText(box.cwd);
  assert.deepEqual(await H.shoot(kit, other), { error: reason });
  assert.deepEqual(stateOf(kit, other), { state: 'off', reason, error: null });
  assert.equal(kit.S.snapshotState(box.cwd).state, 'on');
  assert.equal(readFileSync(join(repo, 'mori.json'), 'utf8'), `${JSON.stringify({ cwd: box.cwd })}\n`);
  const restarted = await H.freshKit(box.snaps);
  assert.deepEqual(await H.shoot(restarted, other), { error: reason });
  assert.deepEqual(stateOf(restarted, other), { state: 'off', reason, error: null });
});

check('FS-06 index.lock, packed-refs.lock and refs\\…\\*.lock left by an earlier kernel are removed before the '
  + 'first job', async () => {
  const { box, kit, repo, oid } = await lockProject();
  assert.deepEqual(LOCKS.filter((lock) => existsSync(join(repo, lock))), []);
  assert.deepEqual(await pathsAt(repo, oid), ['.gitattributes', 'crlf.txt']);
  assert.equal(logged(`[kernel] snapshots: removed stale lock files in ${repo}: ${LOCKS.join(', ')}`), 1);
  assert.equal(kit.S.snapshotState(box.cwd).error, null);
});

check('FS-06 a repo with HEAD but no info/attributes (creation cut short) gets it written on the first job, so '
  + 'CRLF is still stored as bytes', async () => {
  const { repo, oid } = await lockProject();
  assert.equal(readFileSync(join(repo, 'info', 'attributes'), 'utf8'), H.ATTRIBUTES_TEXT);
  assert.equal((await blobIds(repo, oid)).get('crlf.txt'), H.blobId(CRLF));
  assert.equal(logged(`[kernel] snapshots: info/attributes was missing or different in ${repo}; rewriting it`), 1);
});

check('FS-06 a repo whose info/attributes has other content gets it rewritten (and logged) on the first job',
  async () => {
    const { repo } = await dubiousProject();
    assert.equal(readFileSync(join(repo, 'info', 'attributes'), 'utf8'), H.ATTRIBUTES_TEXT);
    assert.equal(logged(`[kernel] snapshots: info/attributes was missing or different in ${repo}; rewriting it`),
      1);
  });

check('FS-06 a lock that can’t be removed (a folder named index.lock) fails that snapshot and is tried again '
  + 'before the next job', async () => {
  const kit = await sharedKit();
  const box = H.newBox(root, sharedSnaps);
  const repo = await H.oldRepo(box);
  const lock = join(repo, 'index.lock');
  H.put(lock, 'held.txt', 'held\n');
  H.put(box.cwd, 'a.txt', 'a\n');
  const failed = await H.shoot(kit, box.cwd);
  assert.match(failed.error ?? '', /index\.lock/);
  assert.equal(kit.S.snapshotState(box.cwd).error, failed.error);
  assert.equal(loggedStart(`[kernel] snapshots: couldn't remove ${lock}: `), 1);
  rmSync(lock, { recursive: true });
  writeFileSync(lock, '');
  const oid = await shot(kit, box.cwd);
  assert.equal(existsSync(lock), false);
  assert.equal(kit.S.snapshotState(box.cwd).error, null);
  assert.equal(logged(`[kernel] snapshots: removed stale lock files in ${repo}: index.lock`), 1);
  assert.deepEqual(await H.pathsOf(repo, oid), ['a.txt']);
});

check('FS-06 a repo folder left by an interrupted creation (config.lock and HEAD.lock, no HEAD) is rebuilt by '
  + 'the next snapshot', async () => {
  const { box, repo, oid } = await defaultsProject();
  assert.equal(existsSync(join(repo, 'HEAD')), true);
  assert.deepEqual(['config.lock', 'HEAD.lock'].filter((name) => existsSync(join(repo, name))), []);
  assert.equal(readFileSync(join(repo, 'info', 'attributes'), 'utf8'), H.ATTRIBUTES_TEXT);
  assert.equal(readFileSync(join(repo, 'mori.json'), 'utf8'), `${JSON.stringify({ cwd: box.cwd })}\n`);
  assert.ok((await treeAt(repo, oid)).length > 0);
});

check('FS-06 your git refusing the folder (dubious ownership on rev-parse) fails this snapshot; snapshots.error '
  + 'is git’s line without fatal:', async () => {
  const { box, kit, line, spy, result } = await dubiousProject();
  assert.deepEqual(result, { error: line });
  assert.deepEqual(stateOf(kit, box.cwd), { state: 'on', reason: null, error: line });
  assert.equal(spy.spawned.length, 1);
  assert.deepEqual(spy.calls.filter(H.internalCall), [], 'nothing was added or committed');
  assert.equal(logged(`[kernel] snapshot failed in ${box.cwd}: ${line}`), 1);
});

// ---- FS-08 上限与暂停 ----

check('FS-08 untracked new files over the injected 1 KB cap are skipped and listed (20 of 21); a tracked file '
  + 'as big and one of exactly 1 KB are taken', async () => {
  const { box, kit, big, small, oid } = await sizeProject();
  assert.deepEqual(await H.pathsOf(kit.S.snapshotRepo(box.cwd), oid),
    ['edge.bin', ...small, 'small.txt', 'tracked-big.bin']);
  const state = kit.S.snapshotState(box.cwd);
  assert.deepEqual({ skipped: state.skipped, skippedTotal: state.skippedTotal },
    { skipped: big.slice(0, 20), skippedTotal: 21 });
});

check('FS-08 15 files to add with the batch size 5 go in 3 batches, then add -A leaves out the skipped files',
  async () => {
    const { spy } = await sizeProject();
    const adds = spy.calls.filter((args) => H.internalCall(args) && H.subcommandOf(args) === 'add');
    assert.equal(adds.filter(isBatchAdd).length, 3);
    const closing = adds.filter((args) => !isBatchAdd(args));
    assert.equal(closing.length, 1);
    assert.ok(closing[0].includes('-A') && closing[0].includes('--pathspec-from-file=-'), closing[0].join(' '));
  });

check('FS-08 21 new files (cap 20) pause snapshots with the exact text: no snapshot and no stat of the new files; '
  + 'a .gitignore brings them back at the next snapshot and what changed while paused is not recorded', async () => {
  const box = H.newBox(root);
  H.put(box.cwd, 'a.txt', 'a\n');
  const kit = await H.freshKit(box.snaps);
  const sm = SessionManager.inMemory(box.cwd);
  const { handle, ctx } = await taskRun(kit, 'pause08', box.cwd, sm);
  const repo = kit.S.snapshotRepo(box.cwd);
  const names = numbered('f', 21, '.txt');
  putAll(box.cwd, [...names, 'a.txt']);
  const [stats, objects] = [statsUnder(box.cwd).length, await H.allObjects(repo)];
  assert.deepEqual(await H.shoot(kit, box.cwd), { error: COUNT_PAUSE });
  assert.deepEqual(stateOf(kit, box.cwd), { state: 'paused', reason: COUNT_PAUSE, error: null });
  assert.equal(statsUnder(box.cwd).length, stats, 'no stat of the new files');
  assert.deepEqual(await H.allObjects(repo), objects, 'no snapshot');
  H.put(box.cwd, '.gitignore', 'f1*.txt\n');
  await H.endRun(kit, handle, ctx);
  assert.deepEqual(stateOf(kit, box.cwd), { state: 'on', reason: null, error: null });
  const tree = await H.pathsOf(repo, 'refs/mori/last');
  assert.deepEqual(tree, ['.gitignore', 'a.txt', ...names.filter((name) => !name.startsWith('f1'))]);
  assert.ok(statsUnder(box.cwd).length > stats, 'the resumed snapshot measures its new files');
  assert.deepEqual(H.turnRecords(sm), [], 'the changes made while paused are not recorded');
});

check('FS-08 a new-file list cut off at the output cap pauses snapshots the same way, without stat', async () => {
  const box = H.newBox(root);
  putAll(box.cwd, ['a.txt', 'b.txt']);
  const kit = await H.freshKit(box.snaps);
  const flood = Buffer.alloc(kit.G.GIT_OUTPUT.other + 1, 0x61);
  const newFiles = (args) => H.internalCall(args) && H.subcommandOf(args) === 'ls-files' && args.includes('--others');
  const spy = H.spyGit(kit, (args) => (newFiles(args) ? { stdout: flood, hang: true } : null));
  assert.deepEqual(await H.shoot(kit, box.cwd), { error: COUNT_PAUSE });
  assert.equal(spy.spawned.length, 1);
  assert.deepEqual(stateOf(kit, box.cwd), { state: 'paused', reason: COUNT_PAUSE, error: null });
  assert.deepEqual(statsUnder(box.cwd), []);
  assert.deepEqual(spy.calls.filter(H.internalCall).map(H.subcommandOf), ['init', 'ls-files']);
});

check('FS-08 a batch that times out gives the exact error, keeps the earlier batch in the index and leaves an '
  + 'index.lock that is removed before the next job; the next snapshot adds only the files left', async () => {
  const result = await timeoutProject();
  assert.deepEqual(result.failed, { error: TIMEOUT_ERROR });
  assert.deepEqual(result.failedState, { state: 'on', reason: null, error: TIMEOUT_ERROR });
  assert.equal(result.lockLeft, true, 'the killed git add left index.lock');
  assert.deepEqual(result.index, result.names.slice(0, 5));
  assert.ok('oid' in result.next, `the next snapshot failed: ${JSON.stringify(result.next)}`);
  assert.equal(result.lockGone, true);
  assert.equal(logged(`[kernel] snapshots: removed stale lock files in ${result.repo}: index.lock`), 1);
  assert.equal(result.batchAdds, 2, 'only the 7 files left are added');
  assert.deepEqual(result.paths, result.names);
  assert.equal(stateOf(result.kit, result.box.cwd).error, null);
});

check('FS-08 three snapshot timeouts in a row pause snapshots with the exact text; a success or another failure '
  + 'in between starts the count again; no git process runs while paused', async () => {
  const { box, kit, spy, hangNext } = await timeoutProject();
  const timeout = async (round, paused) => {
    hangNext('list');
    assert.deepEqual(await H.shoot(kit, box.cwd), { error: TIMEOUT_ERROR }, `timeout ${round}`);
    assert.deepEqual(stateOf(kit, box.cwd), { state: paused ? 'paused' : 'on',
      reason: paused ? TIMEOUT_PAUSE : null, error: TIMEOUT_ERROR }, `after timeout ${round}`);
  };
  // 上一张（timeoutProject 的最后一张）成功：从 0 数起，两张超时之后仍是 on
  await timeout(1, false);
  await timeout(2, false);
  hangNext('fail');
  assert.deepEqual(await H.shoot(kit, box.cwd), { error: SYNTHETIC_FAILURE });
  assert.deepEqual(stateOf(kit, box.cwd), { state: 'on', reason: null, error: SYNTHETIC_FAILURE });
  await timeout(3, false);
  await timeout(4, false);
  await timeout(5, true);
  hangNext(null);
  const calls = spy.calls.length;
  assert.deepEqual(await H.shoot(kit, box.cwd), { error: TIMEOUT_PAUSE });
  assert.equal(spy.calls.length, calls, 'no git process runs while paused');
});

// ---- FS-20 删除会话后的整理（评审修过的几处） ----

check('FS-20 after a delete, git prune keeps the commits only another session’s refs hold, and they still '
  + 'restore', async () => {
  const result = await pruneProject();
  assert.deepEqual(result.dropped, { error: null });
  assert.equal(result.strayLeft, false, 'git prune ran');
  assert.equal(result.firstLeft, true);
  assert.equal(result.kept, true);
  assert.equal(result.restored.code, 0, result.restored.stderr);
  assert.equal(result.text, 'one\n');
});

check('FS-20 with the folder above the working path gone and another session’s refs left, deleting a session '
  + 'runs git prune in the internal repo folder and keeps those refs', async () => {
  const { repo, oid, kept, pruned, afterPrune } = await goneProject();
  assert.equal(kept, null);
  assert.deepEqual(pruned, { error: null });
  assert.deepEqual(afterPrune, { head: true, strayLeft: false,
    refs: ['refs/mori/last', `refs/mori/s/other20/rewind/e2/${oid}`] });
  assert.equal(loggedStart(`[kernel] snapshots: git prune failed in ${repo}`), 0);
});

check('FS-20 the repo folder stays while another non-headless session is open on the working path; a headless '
  + 'one does not keep it, and the folder is removed with the working path gone', async () => {
  const { repo, whileOpen, afterOpen, last, removed } = await goneProject();
  assert.deepEqual(whileOpen, { error: null });
  assert.deepEqual(afterOpen, { head: true, refs: ['refs/mori/last'] });
  assert.deepEqual(last, { error: null });
  assert.equal(removed, true);
  assert.equal(logged(`[kernel] snapshots: removed ${repo}`), 1);
});

// ---- FS-11 记录写到哪个会话文件（评审修过的两处） ----

check('FS-11 a released session whose file is gone gets no records, and its file is not recreated', async () => {
  const { gone, goneFile, existed, sent } = await releasedProject();
  assert.equal(existed, true);
  assert.equal(existsSync(goneFile), false);
  assert.equal(gone.handle.events.length, sent.gone);
  assert.deepEqual(H.turnRecords(gone.handle.user.sessionManager), []);
  assert.equal(logged('[kernel] snapshots: the session file of gone11 is gone; not recording the changes'), 1);
});

check('FS-11 a session reopened while its end snapshot waits gets the records in the new SessionManager and '
  + 'its emit; the segment shared with the other session is marked overlap', async () => {
  const { kept, old, reopened, events, sent } = await releasedProject();
  const records = H.turnRecords(reopened);
  assert.deepEqual(records.map((record) => [record.kind, record.round, record.agents, record.overlap]),
    [['changes', kept.message, [TASK_AGENT], true]]);
  assert.deepEqual(records[0].files, [{ path: 'a.txt', status: 'M', added: 1, removed: 0 }]);
  assert.deepEqual(H.turnRecords(old), []);
  assert.deepEqual(events.map((event) => [event.type, event.record]), [['mori.turn_changes', records[0]]]);
  assert.equal(kept.handle.events.length, sent.kept);
  const lines = readFileSync(old.getSessionFile(), 'utf8').split('\n');
  assert.equal(lines.filter((line) => line.includes('"mori.turn_changes"')).length, 1);
});

/** pi 的 SessionManager 类（各测试与场景在登记之后才用到它） */
const SessionManager = await H.loadSessionManager();

describe('snapshots with real git (independent tests in parallel)', { concurrency: true }, () => {
  for (const [name, fn] of TESTS) test(name, fn);
});
