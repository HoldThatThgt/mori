// worktree 与 Initialize git（docs/specs/file-system.md §11.2、§11.3、§11.5.2、§11.5.3、§11.5.5、§11.6、§11.9、§11.11、§17；
// 验收 §19.2 FS-94–FS-97、FS-105、FS-106、FS-108、FS-109、FS-111 的单元层）：kernel/workspace.ts 的 worktreeName、
// createWorktree、removeCreatedWorktree、restoreWorktree、worktreeRegistered、unregisteredText、listWorktrees、
// cleanUpWorktrees、readWorktreeEntry、initGit，与 shared/workspace.ts 的 worktreeOf、projectFolder、refsInto。
// 真实 git（Git for Windows）在 os.tmpdir() 下的临时仓库（synthetic 的项目）里跑：先建两个基础仓库，每个场景用
// fs.cpSync 复制一份（不再起 git 重建），互不相干的场景并行；git 进程尽量少（检查结果时能直接读 .git 里的文件就不起 git）。
// 超时按 §19.1 注入很小的值；经 configureGit 注入的 spawn 只在三处换掉调用：worktree add 先跑完再装作没退出、
// 到超时被结束（synthetic 的替身），worktree add 的切出点换成不存在的提交，认仓库的 rev-parse 由替身报 dubious ownership。
// 没装 git 的情况用同一个包的另一份模块（候选为空）。说明你的身份的全局配置放在临时主目录里，结束时恢复环境变量。

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addWorktree, branchTip, callsIn, captureLogs, checkedOut, finishThenHang, fixed, git, gitText, isWorktreeAdd,
  loadKits, loadSessionManager, makeBranch, makeRepo, messageLine, once, pathKey, put, readText, registered,
  repoState, sequence, setEnv, standIn, tempRoot, useHome, within, worktreeLine, writeSession,
} from './wt-helpers.mjs';

const tmp = tempRoot('mwk-');
const restoreEnv = setEnv({ MORI_GIT_PATH: undefined });
const restoreHome = useHome(join(tmp.root, 'home'), true);
const logs = captureLogs();
after(() => {
  logs.restore();
  restoreHome();
  restoreEnv();
  tmp.remove();
});

/**
 * 基础仓库 A：README、.gitignore（*.log）、app 子文件夹与一个 src 文件（synthetic）。文件少：每个场景的检出都写这些文件，
 * 本机上新文件越多越慢
 */
const BASE_A = {
  'README.md': '# tool\n', '.gitignore': '*.log\n', 'app/main.js': 'main();\n', 'app/lib/util.js': 'util();\n',
  'src/index.ts': 'export {};\n',
};
/** 基础仓库 B：只有一个文件（synthetic；app 子文件夹没提交） */
const BASE_B = { 'a.txt': 'a\n' };

/** 两个基础仓库与它们 main 分支的提交（新仓库的 ref 是散文件，直接读）；在打包内核模块的同时就开始建 */
const bases = once(async () => {
  const [a, b] = await Promise.all([makeRepo(join(tmp.root, 'A'), BASE_A), makeRepo(join(tmp.root, 'B'), BASE_B)]);
  return { a, b, headA: readText(join(a, '.git', 'refs', 'heads', 'main')).trim() };
});
bases().catch(() => undefined);

/**
 * pi 的 SessionManager（只有列表场景用）：载入要在主线程上编译一阵，放在开头与打包内核模块一起做，不在并行的用例
 * 跑到一半时卡住所有 git 进程的回调
 */
const sessionManager = once(loadSessionManager);
const { real, none, calls, onGit } = (await Promise.all([loadKits(), sessionManager()]))[0];
const { W, S } = real;
const N = none.W;

// ---- 原文（照抄规格 §11.5.2、§11.5.3、§11.9、§11.11、屏幕表 fs-worktree.md 与 fs-checks.md 第 16 条） ----

const GIT_FOR_CREATE = 'Git is required to create a worktree.';
const NOT_REPO = 'This folder isn’t a git repository.';
const NO_COMMITS = 'This repository has no commits yet.';
const CORE_WORKTREE = 'This repository sets core.worktree, so Mori can’t create a worktree here. '
  + 'Move it to the main worktree’s config.worktree first.';
const GIT_FOR_RESTORE = 'Git is required to restore this session’s worktree.';
const GIT_FOR_CLEANUP = 'Git is required to clean up worktrees.';
const GIT_FOR_INIT = 'Git is required to initialize a repository.';
const ALREADY_REPO = 'This folder is already a git repository.';
const IDENTITY = 'Git needs your name and email for the first commit. '
  + 'Set user.name and user.email with git config --global, then try again.';
const notCommitted = (sub) => `The folder ${sub} isn’t committed yet, so a worktree can’t start there. `
  + 'Commit it first.';
const rootMismatch = (top) => `This folder’s path doesn’t lead to its repository root ${top}, `
  + 'so Mori can’t place a worktree here.';
const branchGone = (branch) => `The branch ${branch} no longer exists, so this session’s worktree can’t be restored.`;
const unregistered = (path) => `The worktree folder ${path} exists but isn’t registered with git. `
  + 'Move or delete it, then open this session again.';
const notMori = (path) => `Not a Mori worktree: ${path}`;
/** exclude 里的一行（§11.5.3 第 3 步） */
const EXCLUDE_LINE = '.mori/worktrees/';
/** worktree add / remove 都带的长路径设置（§11.5.3 第 4 步、清理第 1 步、§11.9.1 第 5 步） */
const LONG = ['-c', 'core.longpaths=true'];
/** 宿主（synthetic）：没有开着的会话 */
const NO_HOST = Object.freeze({ openCwds: () => [], ownedBy: () => null });

// ---- 场景的复制 ----

/**
 * @brief 复制一个基础仓库给一个场景（fs.cpSync，不起 git）。
 * @param which 'a' 或 'b'
 * @param name 场景目录名（短，在临时根目录下）
 */
async function copyRepo(which, name) {
  const base = (await bases())[which];
  const dir = join(tmp.root, name);
  cpSync(base, dir, { recursive: true });
  return dir;
}

/** @brief Mori worktree 的位置：<R>\.mori\worktrees\<名字>。 */
const wtPath = (root, name) => join(root, '.mori', 'worktrees', name);

/** @brief 期望 promise 以这句原文失败。 */
async function rejectsWith(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, message);
    return true;
  });
}

/** @brief worktreeOf(新 cwd) 与建出的 worktree（mori.worktree 的 path、branch、mainFolder）相同（FS-95）。 */
function assertPlace(created) {
  const place = S.worktreeOf(created.cwd);
  assert.deepEqual({ path: place.path, branch: place.branch, mainFolder: place.mainFolder },
    { path: created.path, branch: created.branch, mainFolder: created.mainFolder });
  assert.equal(S.projectFolder(created.cwd), created.mainFolder);
}

/**
 * @brief 建了一半的 worktree 都撤干净了（§11.5.3 失败后的清理）：没有文件夹、登记里只剩主文件夹（与 others）、
 *        没有 mori/<名字> 分支；第 2、3 步写的配置与 exclude 行留着。
 * @param root 仓库根
 * @param target 失败的那个 worktree 的 path、branch
 * @param others 仓库里原有的别的 worktree
 */
async function assertCleaned(root, target, others = []) {
  assert.equal(existsSync(target.path), false);
  assert.deepEqual(await registered(root), [root, ...others].map(pathKey));
  assert.equal(branchTip(root, target.branch), null);
  assert.match(readText(join(root, '.git', 'config')), /worktreeConfig = true/);
  assert.ok(readText(join(root, '.git', 'info', 'exclude')).split('\n').includes(EXCLUDE_LINE));
}

/** @brief 最后一次 worktree add 之后的清理调用（remove、prune、branch），按先后。 */
function cleanupCalls(root) {
  const list = callsIn(calls, root);
  const at = list.findLastIndex(isWorktreeAdd);
  assert.ok(at >= 0, 'worktree add was called');
  return list.slice(at + 1).filter((args) => args.includes('remove') || args.includes('prune') || args[0] === 'branch');
}

/** @brief 清理调用的期望（§11.5.3：remove --force --force、prune、branch -D；恢复时没有 branch -D）。 */
function expectedCleanup(target, deleteBranch = true) {
  const steps = [[...LONG, 'worktree', 'remove', '--force', '--force', target.path], ['worktree', 'prune']];
  return deleteBranch ? [...steps, ['branch', '-D', target.branch]] : steps;
}

// ---- FS-94 名字（§11.2） ----

/** 一段引用块（synthetic，同 quoteText.ts 的写法：标题一行，内容每行以 > 开头，空行写成 >） */
const QUOTE_A = 'Quoting src/a.ts, lines 3\u20135:\n> const answer = 42\n>\n> export default answer';
const QUOTE_B = 'Quoting your earlier reply:\n> Use a constant here';

describe('FS-94 worktreeName', () => {
  const name = (text, refs = 0) => W.worktreeName(text, refs, fixed('3fa9c1'));
  test('FS-94 an English sentence: up to five words joined by -, then - and the suffix', () => {
    assert.equal(name('Fix the login redirect bug in auth.ts'), 'fix-the-login-redirect-bug-3fa9c1');
  });
  test('FS-94 diacritics are dropped after NFKD (é → e) and full-width letters become ASCII', () => {
    assert.equal(name('Café résumé über naïve'), 'cafe-resume-uber-naive-3fa9c1');
    assert.equal(name('\uff26\uff49\uff58 \uff4c\uff4f\uff47\uff49\uff4e'), 'fix-login-3fa9c1');
  });
  test('FS-94 all-Chinese text, empty text and only quote chips give session', () => {
    assert.equal(W.worktreeName('\u4fee\u4e00\u4e0b\u767b\u5f55', 0, fixed('08d2e4')), 'session-08d2e4');
    assert.equal(name(''), 'session-3fa9c1');
    assert.equal(name(QUOTE_A, 1), 'session-3fa9c1');
    assert.equal(name(`${QUOTE_A}\n\n${QUOTE_B}`, 2), 'session-3fa9c1');
  });
  test('FS-94 the first refsCount blocks (quote blocks) are skipped; your paragraphs are joined', () => {
    const text = `${QUOTE_A}\n\n${QUOTE_B}\n\nRename the answer\n\nconstant`;
    assert.equal(name(text, 2), 'rename-the-answer-constant-3fa9c1');
    assert.match(name(text, 0), /^quoting-src-a-ts-lines-3fa9c1$/);
    assert.equal(name('First part\n\nSecond part'), 'first-part-second-part-3fa9c1');
    assert.equal(name('Only text', 3), 'session-3fa9c1');
  });
  test('FS-94 a first word over 30 characters is cut to 30', () => {
    assert.equal(name(`${'x'.repeat(45)} tail`), `${'x'.repeat(30)}-3fa9c1`);
  });
  test('FS-94 at most 5 words and at most 30 characters before the suffix', () => {
    assert.equal(name('one two three four five six seven'), 'one-two-three-four-five-3fa9c1');
    assert.equal(name('alpha bravo charlie delta echo foxtrot'), 'alpha-bravo-charlie-delta-echo-3fa9c1');
    assert.equal(name('alpha bravo charlie delta foxtrot'), 'alpha-bravo-charlie-delta-3fa9c1');
  });
  test('FS-94 words split on anything outside a-z0-9; names use only a-z0-9-', () => {
    assert.equal(name('Bump V2 to 3.1 -- now!'), 'bump-v2-to-3-1-3fa9c1');
    assert.equal(name('Fix \u{1F41B} in_parser!!'), 'fix-in-parser-3fa9c1');
    for (const text of ['Fix the login redirect bug in auth.ts', 'Café', 'CON', QUOTE_A, '\u4fee']) {
      assert.match(W.worktreeName(text, 0), /^[a-z0-9-]+$/);
    }
  });
  test('FS-94 the default suffix is 6 lowercase hex characters (crypto.randomBytes(3))', () => {
    const names = Array.from({ length: 20 }, () => W.worktreeName('Fix it', 0));
    for (const item of names) assert.match(item, /^fix-it-[0-9a-f]{6}$/);
    assert.ok(new Set(names).size > 1);
  });
});

// ---- FS-95 worktreeOf / projectFolder / refsInto（§11.3、§11.5.5） ----

/** §11.3 的表与补充的写法：[cwd, worktreeOf 的结果（null 为不在 Mori worktree 里）] */
const PLACES = [
  ['D:\\work\\tool', null],
  ['D:\\work\\tool\\.mori\\worktrees\\fix-login-3fa9c1', {
    root: 'D:\\work\\tool', path: 'D:\\work\\tool\\.mori\\worktrees\\fix-login-3fa9c1', name: 'fix-login-3fa9c1',
    branch: 'mori/fix-login-3fa9c1', mainFolder: 'D:\\work\\tool' }],
  ['D:\\work\\tool\\.mori\\worktrees\\fix-login-3fa9c1\\app', {
    root: 'D:\\work\\tool', path: 'D:\\work\\tool\\.mori\\worktrees\\fix-login-3fa9c1', name: 'fix-login-3fa9c1',
    branch: 'mori/fix-login-3fa9c1', mainFolder: 'D:\\work\\tool\\app' }],
  ['D:\\work\\tool\\.claude\\worktrees\\x', null],
  ['D:\\work\\tool\\.MORI\\Worktrees\\fix-login-3fa9c1', {
    root: 'D:\\work\\tool', path: 'D:\\work\\tool\\.MORI\\Worktrees\\fix-login-3fa9c1', name: 'fix-login-3fa9c1',
    branch: 'mori/fix-login-3fa9c1', mainFolder: 'D:\\work\\tool' }],
];

describe('FS-95 worktreeOf and projectFolder', () => {
  test('FS-95 every row of the §11.3 table, and .MORI\\Worktrees in another case', () => {
    for (const [cwd, place] of PLACES) {
      assert.deepEqual(S.worktreeOf(cwd), place, cwd);
      assert.equal(S.projectFolder(cwd), place === null ? cwd : place.mainFolder, cwd);
    }
  });
  test('FS-95 names outside a-z0-9- and a missing name are not Mori worktrees', () => {
    const cwds = ['D:\\w\\.mori\\worktrees\\Fix-Login', 'D:\\w\\.mori\\worktrees\\fix_login',
      'D:\\w\\.mori\\worktrees', 'D:\\w\\.mori\\worktrees\\', 'D:\\w\\.mori\\trees\\fix-1', '.mori\\worktrees\\fix-1'];
    for (const cwd of cwds) {
      assert.equal(S.worktreeOf(cwd), null, cwd);
      assert.equal(S.projectFolder(cwd), cwd);
    }
  });
  test('FS-95 the result keeps the cwd spelling and its separators', () => {
    assert.deepEqual(S.worktreeOf('d:/Work/tool/.mori/worktrees/fix-1/app'), {
      root: 'd:/Work/tool', path: 'd:/Work/tool/.mori/worktrees/fix-1', name: 'fix-1', branch: 'mori/fix-1',
      mainFolder: 'd:/Work/tool/app' });
    assert.deepEqual(S.worktreeOf('D:\\work/tool\\.mori/worktrees\\n-1\\'), {
      root: 'D:\\work\\tool', path: 'D:\\work\\tool\\.mori\\worktrees\\n-1', name: 'n-1', branch: 'mori/n-1',
      mainFolder: 'D:\\work\\tool' });
  });
  test('FS-95 a drive root and a UNC share as R; the first .mori\\worktrees\\<name> from the left counts', () => {
    assert.deepEqual(S.worktreeOf('D:\\.mori\\worktrees\\n-1'), {
      root: 'D:\\', path: 'D:\\.mori\\worktrees\\n-1', name: 'n-1', branch: 'mori/n-1', mainFolder: 'D:\\' });
    assert.equal(S.worktreeOf('\\\\host\\share\\.mori\\worktrees\\n-1\\app').mainFolder, '\\\\host\\share\\app');
    const nested = S.worktreeOf('D:\\a\\.mori\\worktrees\\x-1\\.mori\\worktrees\\y-2');
    assert.equal(nested.path, 'D:\\a\\.mori\\worktrees\\x-1');
    assert.equal(nested.mainFolder, 'D:\\a\\.mori\\worktrees\\y-2');
  });
});

/** 引用（synthetic）：文件、上一条回复、另一个会话 */
const fileRef = (path) => ({ quote: 'const answer = 42', source: { kind: 'file', path, sha256: 'ab'.repeat(32),
  startLine: 3, endLine: 5 } });
const MESSAGE_REF = { quote: 'Use a constant', source: { kind: 'message', entryId: 'e1', time: null, scope: 'reply' } };
const SESSION_REF = { quote: 'User: hi', source: { kind: 'session', sessionFile: 'D:\\s\\a.jsonl', name: 'Old',
  fromTurn: 1, toTurn: 2, fromEntryId: 'u1', toEntryId: 'u2' } };

describe('FS-95 refsInto (§11.5.5)', () => {
  const from = 'D:\\work\\tool';
  const to = 'D:\\work\\tool\\.mori\\worktrees\\fix-1';
  test('FS-95 refsInto moves file references in the old cwd under the new cwd, keeping the rest of the ref', () => {
    const refs = [fileRef('D:\\work\\tool\\src\\a.ts'), fileRef('d:/WORK/Tool/src/B.ts'), fileRef(from)];
    const moved = S.refsInto(refs, from, to);
    assert.deepEqual(moved.map((ref) => ref.source.path),
      [`${to}\\src\\a.ts`, `${to}\\src\\B.ts`, to]);
    assert.deepEqual({ ...moved[0], source: { ...moved[0].source, path: null } },
      { ...refs[0], source: { ...refs[0].source, path: null } });
    assert.equal(refs[0].source.path, 'D:\\work\\tool\\src\\a.ts');
  });
  test('FS-95 refsInto leaves files outside the old cwd, messages and sessions alone', () => {
    const refs = [fileRef('D:\\work\\toolbox\\c.ts'), fileRef('D:\\other\\d.ts'), MESSAGE_REF, SESSION_REF];
    const moved = S.refsInto(refs, from, to);
    refs.forEach((ref, i) => assert.equal(moved[i], ref));
  });
  test('FS-95 refsInto writes the new path with the new cwd’s separators (sub-folder sessions too)', () => {
    const slashed = S.refsInto([fileRef('D:\\work\\tool\\src\\a.ts')], from, 'D:/work/tool/.mori/worktrees/fix-1');
    assert.equal(slashed[0].source.path, 'D:/work/tool/.mori/worktrees/fix-1/src/a.ts');
    const refs = [fileRef(`${from}\\app\\x.ts`), fileRef(`${from}\\README.md`)];
    const sub = S.refsInto(refs, `${from}\\app`, `${to}\\app`);
    assert.deepEqual(sub.map((ref) => ref.source.path), [`${to}\\app\\x.ts`, `${from}\\README.md`]);
  });
});

// ---- 没装 git（§11.5.2、§11.9.1、§11.9.4、§11.11） ----

/** @brief mori.worktree 的数据（path、branch、mainFolder）。 */
const entryOf = (place) => ({ path: place.path, branch: place.branch, mainFolder: place.mainFolder });

describe('without git (no git.exe found)', () => {
  const folder = join(tmp.root, 'nogit');
  const place = S.worktreeOf(wtPath(folder, 'nogit-1'));
  test('FS-96 createWorktree without git: Git is required to create a worktree.', async () => {
    mkdirSync(folder, { recursive: true });
    await rejectsWith(N.createWorktree(folder, 'Fix it', 0), GIT_FOR_CREATE);
    assert.equal(existsSync(join(folder, '.mori')), false);
  });
  test('FS-105 restoring without git: Git is required to restore this session’s worktree.', async () => {
    await rejectsWith(N.restoreWorktree(place), GIT_FOR_RESTORE);
    assert.equal(existsSync(place.path), false);
    assert.equal(await N.worktreeRegistered(place), null);
  });
  test('FS-106 listWorktrees without git: git is false and changes null', async () => {
    mkdirSync(place.path, { recursive: true });
    const file = writeSession(join(folder, 's', 'a.jsonl'), place.path,
      [worktreeLine('w1', entryOf(place)), messageLine('m1', 'hi')]);
    const host = { openCwds: () => [{ sessionFile: 'other.jsonl', cwd: place.path, owner: null }],
      ownedBy: () => null };
    assert.deepEqual(await N.listWorktrees([file], host), { git: false,
      items: [{ ...entryOf(place), sessionFile: file, exists: true, changes: null, inUse: true }] });
  });
  test('FS-108 cleanUpWorktrees without git: each path gets Git is required to clean up worktrees.', async () => {
    const paths = [place.path, folder];
    const { results } = await N.cleanUpWorktrees(paths, true, NO_HOST);
    assert.deepEqual(results, paths.map((path) => ({ path, removed: false, reason: null, error: GIT_FOR_CLEANUP })));
    assert.ok(existsSync(place.path));
  });
  test('FS-109 initGit without git: Git is required to initialize a repository.', async () => {
    await rejectsWith(N.initGit(folder), GIT_FOR_INIT);
    assert.equal(existsSync(join(folder, '.git')), false);
  });
});

// ---- FS-109 没有身份（换主目录，所以在并行的用例之前单独跑） ----

test('FS-109 without user.name and user.email initGit does nothing and says what to set', async () => {
  const dir = join(tmp.root, 'noid');
  put(dir, { 'a.txt': 'a\n' });
  const restore = useHome(join(tmp.root, 'home-empty'), false);
  try {
    await rejectsWith(W.initGit(dir), IDENTITY);
  } finally {
    restore();
  }
  assert.equal(existsSync(join(dir, '.git')), false);
  assert.equal(existsSync(join(dir, '.work')), false);
});

// ---- FS-94 撞名、FS-96 建 worktree 的 git 步骤、FS-97 removeCreatedWorktree（§11.2、§11.5.3） ----

/** 主场景第一条消息里你写的字（§11.2 的例子） */
const MAIN_TEXT = 'Fix the login redirect bug in auth.ts';
/** 它的名字（不带后缀） */
const MAIN_NAME = 'fix-the-login-redirect-bug';

/** @brief 记下这个仓库里每次 worktree add 开始时 info/exclude 的内容；返回 { seen, off }。 */
function watchExclude(root) {
  const seen = [];
  const off = onGit((command, args, options) => {
    if (isWorktreeAdd(args) && within(root, options.cwd)) seen.push(readText(join(root, '.git', 'info', 'exclude')));
    return null;
  });
  return { seen, off };
}

/** @brief worktree 里要看的文件（删掉之前记下）。 */
function filesOf(path) {
  return {
    main: readText(join(path, 'app', 'main.js')), readme: readText(join(path, 'README.md')),
    scratch: existsSync(join(path, 'scratch.txt')), work: readText(join(path, '.work', '.gitignore')),
    tmp: existsSync(join(path, '.work', 'tmp')),
  };
}

/** @brief 建好之后的样子：登记、主文件夹的 git status、分支与检出、共用配置与 config.worktree、exclude、文件与调用。 */
async function observe(root, item) {
  const [regs, status] = await Promise.all([registered(root),
    gitText(root, ['status', '--porcelain', '--untracked-files=all'])]);
  const admin = join(root, '.git', 'worktrees', S.worktreeOf(item.path).name);
  return {
    regs, status, tip: branchTip(root, item.branch), head: checkedOut(item.path),
    config: readText(join(root, '.git', 'config')), wtConfig: readText(join(admin, 'config.worktree')),
    exclude: readText(join(root, '.git', 'info', 'exclude')), files: filesOf(item.path), calls: callsIn(calls, root),
  };
}

/**
 * FS-94、FS-96、FS-97 的主场景：<名字>-aaaaaa 的文件夹已有、mori/<名字>-bbbbbb 分支已有，第三个后缀 3fa9c1 建成；
 * 记下观察，再用 removeCreatedWorktree 删掉它
 */
const mainCase = once(async () => {
  const root = await copyRepo('a', 'c96');
  const { headA } = await bases();
  const infoBefore = existsSync(join(root, '.git', 'info'));
  mkdirSync(wtPath(root, `${MAIN_NAME}-aaaaaa`), { recursive: true });
  makeBranch(root, `mori/${MAIN_NAME}-bbbbbb`, headA);
  const { seen, off } = watchExclude(root);
  try {
    const rand = sequence('aaaaaa', 'bbbbbb', '3fa9c1');
    const first = await W.createWorktree(root, MAIN_TEXT, 0, undefined, rand);
    const observed = await observe(root, first);
    await W.removeCreatedWorktree(first);
    const regs = await registered(root);
    const removed = { exists: existsSync(first.path), regs, tip: branchTip(root, first.branch) };
    return { root, headA, infoBefore, seen, first, used: rand.used(), ...observed, removed };
  } finally {
    off();
  }
});

/**
 * FS-96 在 Mori worktree 里再开的场景：仓库像 Mori 建过一次 worktree 之后那样（共用配置里 extensions.worktreeConfig=true，
 * exclude 里已有那一行）；外层的 worktree outer-3c3c3c 由测试自己的 git 建在 <R>\.mori\worktrees 下，改 README 提交过一次，
 * 还有一个没提交的文件；会话在它里面建新的
 */
const nestedCase = once(async () => {
  const root = await copyRepo('a', 'c96n');
  appendFileSync(join(root, '.git', 'config'), '[extensions]\n\tworktreeConfig = true\n');
  put(root, { '.git/info/exclude': `${EXCLUDE_LINE}\n` });
  const outer = S.worktreeOf(wtPath(root, 'outer-3c3c3c'));
  await addWorktree(root, outer.path, outer.branch);
  put(outer.path, { 'README.md': '# changed in the worktree\n' });
  await git(outer.path, ['commit', '--quiet', '-am', 'inner base']);
  put(outer.path, { 'scratch.txt': 'not committed\n' });
  const innerBase = branchTip(root, outer.branch);
  const { seen, off } = watchExclude(root);
  try {
    const inner = await W.createWorktree(outer.path, 'Second worktree', 0, undefined, fixed('0a0b0c'));
    return { root, outer, inner, innerBase, seen, ...(await observe(root, inner)) };
  } finally {
    off();
  }
});
// 两串最长的 git 调用：不等前面的用例，载入后就开始
mainCase().catch(() => undefined);
nestedCase().catch(() => undefined);

/** 超过 260 个字符的相对路径的段（synthetic） */
const LONG_REL = ['deep', ...Array.from({ length: 4 }, (_, i) => `${i}${'d'.repeat(49)}`), 'long.txt'];

/**
 * FS-111 子文件夹的场景（也是 FS-96 长路径的场景）：仓库里提交了一个超过 260 个字符的路径；会话在 <仓库>\app，
 * cwd 的字符串全是小写（R 从它推出）；共用配置里 extensions.worktreeConfig 原来是 false；exclude 里已有前后带空格的那一行
 */
const subCase = once(async () => {
  const root = await copyRepo('a', 'c111');
  put(root, { [LONG_REL.join('/')]: 'long\n', '.git/info/exclude': `  ${EXCLUDE_LINE}  \n` });
  await git(root, ['add', '-A']);
  await git(root, ['commit', '--quiet', '-m', 'long']);
  appendFileSync(join(root, '.git', 'config'), '[extensions]\n\tworktreeConfig = false\n');
  const cwd = join(root.toLowerCase(), 'app');
  const created = await W.createWorktree(cwd, 'Sub folder work', 0, undefined, fixed('111111'));
  // 不带 -c core.longpaths：只靠 config.worktree 里的设置
  const status = (await git(created.path, ['status', '--porcelain'], false, true)).stdout;
  return { root, cwd, created, status, base: branchTip(root, 'main'), config: readText(join(root, '.git', 'config')),
    calls: callsIn(calls, root), exclude: readText(join(root, '.git', 'info', 'exclude')) };
});

/** FS-94 三次都撞上的场景（另一份仓库）：<名字>-aaaaaa 的文件夹已有，后缀总是 aaaaaa */
const collideCase = once(async () => {
  const root = await copyRepo('a', 'c94');
  mkdirSync(wtPath(root, `${MAIN_NAME}-aaaaaa`), { recursive: true });
  const before = repoState(root);
  const again = sequence('aaaaaa');
  const collide = await W.createWorktree(root, MAIN_TEXT, 0, undefined, again).then(() => null, (error) => error);
  return { root, collide, againUsed: again.used(), before, after: repoState(root) };
});

/** @brief FS-94 撞名的用例。 */
function collisionCases() {
  test('FS-94 a taken folder, then a taken branch, get new suffixes; the third name is used', async () => {
    const { root, first, used } = await mainCase();
    assert.equal(used, 3);
    assert.equal(first.path, wtPath(root, `${MAIN_NAME}-3fa9c1`));
  });
  test('FS-94 three taken names fail with <path> already exists. and change nothing', async () => {
    const { root, collide, againUsed, before, after: state } = await collideCase();
    assert.equal(collide?.message, `${wtPath(root, `${MAIN_NAME}-aaaaaa`)} already exists.`);
    assert.equal(againUsed, 3);
    assert.deepEqual(state, before);
  });
}

/** @brief 这串调用里设 extensions.worktreeConfig 的次数。 */
const extensionSets = (list) => list.filter((args) => args.join(' ') === 'config extensions.worktreeConfig true')
  .length;

/** @brief FS-96 的用例：结果与 §11.5.3 每一步的效果。 */
function createCases() {
  test('FS-96 createWorktree returns R, the root <R>\\.mori\\worktrees\\<name>, the branch, main folder and cwd',
    async () => {
      const { root, first } = await mainCase();
      const path = wtPath(root, `${MAIN_NAME}-3fa9c1`);
      assert.deepEqual(first, { root, path, branch: `mori/${MAIN_NAME}-3fa9c1`, mainFolder: root, cwd: path });
    });
  test('FS-96 the branch mori/<name> points at the session folder’s HEAD and is checked out in the worktree',
    async () => {
      const { root, headA, first, tip, head, regs, files } = await mainCase();
      assert.equal(tip, headA);
      assert.equal(head, first.branch);
      assert.deepEqual(regs, [root, first.path].map(pathKey));
      assert.equal(files.main, 'main();\n');
    });
  test('FS-96 from inside a Mori worktree the new one sits beside it under the same R, cut from its HEAD',
    async () => {
      const { root, outer, inner, innerBase, tip, head, regs, files } = await nestedCase();
      const path = wtPath(root, 'second-worktree-0a0b0c');
      assert.deepEqual(inner, { root, path, branch: 'mori/second-worktree-0a0b0c', mainFolder: root, cwd: path });
      assert.equal(tip, innerBase);
      assert.equal(head, inner.branch);
      assert.deepEqual(regs, [root, outer.path, path].map(pathKey));
      assert.deepEqual([files.readme, files.scratch], ['# changed in the worktree\n', false]);
    });
  test('FS-96 extensions.worktreeConfig=true is set in the shared config, only when it is not true yet', async () => {
    const [main, nested, sub] = await Promise.all([mainCase(), nestedCase(), subCase()]);
    assert.match(main.config, /\[extensions\]\s+worktreeConfig = true/);
    assert.deepEqual([extensionSets(main.calls), extensionSets(nested.calls), extensionSets(sub.calls)], [1, 0, 1]);
    assert.match(sub.config, /worktreeConfig = true/);
    assert.doesNotMatch(sub.config, /worktreeConfig = false/);
  });
  test('FS-96 config.worktree has core.longpaths=true; the shared config has no core.longpaths', async () => {
    const [main, nested] = await Promise.all([mainCase(), nestedCase()]);
    for (const [item, made] of [[main, main.first], [nested, nested.inner]]) {
      assert.match(item.wtConfig, /\[core\]\s+longpaths = true/);
      assert.doesNotMatch(item.config, /longpaths/i);
      assert.ok(calls.some((call) => call.args.join(' ') === 'config --worktree core.longpaths true'
        && pathKey(call.cwd) === pathKey(made.path)), made.path);
    }
  });
  test('FS-96 info/exclude gets one .mori/worktrees/ line before worktree add (info made), never a second one',
    async () => {
      const [main, nested] = await Promise.all([mainCase(), nestedCase()]);
      assert.equal(main.infoBefore, false);
      assert.deepEqual([main.seen, main.exclude], [[`${EXCLUDE_LINE}\n`], `${EXCLUDE_LINE}\n`]);
      assert.deepEqual([nested.seen, nested.exclude], [[`${EXCLUDE_LINE}\n`], `${EXCLUDE_LINE}\n`]);
    });
}

/** @brief FS-96、FS-95、FS-97 的用例（续）：exclude 的写法、git status、.work、调用、长路径、worktreeOf、删掉。 */
function createMoreCases() {
  test('FS-96 an exclude without a final newline gets the line on its own line; one with spaces counts', async () => {
    assert.equal((await badBaseCase()).exclude, `# local\n*.tmp\n${EXCLUDE_LINE}\n`);
    assert.equal((await subCase()).exclude, `  ${EXCLUDE_LINE}  \n`);
  });
  test('FS-96 the main folder’s git status does not show the worktrees', async () => {
    const [main, nested] = await Promise.all([mainCase(), nestedCase()]);
    assert.deepEqual([main.status, nested.status], ['', '']);
  });
  test('FS-96 the worktree has .work/.gitignore with * and .work/tmp', async () => {
    const { files } = await mainCase();
    assert.deepEqual([files.work, files.tmp], ['*\n', true]);
  });
  test('FS-96 worktree add runs as git -c core.longpaths=true worktree add -b mori/<name> <path> <cut point>',
    async () => {
      const [main, nested] = await Promise.all([mainCase(), nestedCase()]);
      assert.deepEqual(main.calls.filter(isWorktreeAdd),
        [[...LONG, 'worktree', 'add', '-b', main.first.branch, main.first.path, main.headA]]);
      assert.deepEqual(nested.calls.filter(isWorktreeAdd),
        [[...LONG, 'worktree', 'add', '-b', nested.inner.branch, nested.inner.path, nested.innerBase]]);
    });
  test('FS-96 a repo with a path over 260 characters checks out; git status in the worktree is clean', async () => {
    const { created, status } = await subCase();
    const file = join(created.path, ...LONG_REL);
    assert.ok(file.length > 260, `${file.length} characters`);
    assert.equal(readText(file), 'long\n');
    assert.equal(status, '');
  });
  test('FS-95 worktreeOf of each new cwd gives the path, branch and main folder written to mori.worktree', async () => {
    const [main, nested, sub] = await Promise.all([mainCase(), nestedCase(), subCase()]);
    for (const item of [main.first, nested.inner, sub.created]) assertPlace(item);
  });
  test('FS-97 removeCreatedWorktree removes the folder, the registration and the branch; config stays', async () => {
    const { root, first, removed } = await mainCase();
    assert.deepEqual(removed, { exists: false, regs: [pathKey(root)], tip: null });
    assert.match(readText(join(root, '.git', 'config')), /worktreeConfig = true/);
    assert.equal(readText(join(root, '.git', 'info', 'exclude')), `${EXCLUDE_LINE}\n`);
    assert.deepEqual(cleanupCalls(root).slice(-3), expectedCleanup(first));
  });
}

// ---- §11.5.2 的前提与 §11.5.3 第 1 步的检查（不满足时什么都不改） ----

/** 认仓库报错时 git 的 stderr（synthetic） */
const DUBIOUS = "detected dubious ownership in repository at 'C:/mori-test/dubious'";

/** @brief 让 dir 里的 rev-parse 由替身报 dubious ownership（synthetic）；返回取消登记的函数。 */
function dubiousIn(dir) {
  return onGit((command, args, options) => (args[0] === 'rev-parse' && within(dir, options.cwd)
    ? standIn({ code: 128, stderr: `fatal: ${DUBIOUS}\n` }) : null));
}

/** @brief 这个仓库里没有调用过 worktree add，也没建 .mori。 */
function assertUntouched(root) {
  assert.equal(callsIn(calls, root).some(isWorktreeAdd), false);
  assert.equal(existsSync(join(root, '.mori')), false);
}

/**
 * FS-111 与 FS-97 拒绝的场景（基础仓库 B：app 没提交）：<仓库>\app 只有没跟踪的文件；仓库里没跟踪的联接 link 指向 app；
 * 仓库外的联接 jl 也指向 app。三次都拒绝之后，再在共用配置里设 core.worktree 试一次。
 */
const refuseCase = once(async () => {
  const root = await copyRepo('b', 'r111');
  put(root, { 'app/new.txt': 'new\n' });
  const outside = join(tmp.root, 'jl');
  symlinkSync(join(root, 'app'), outside, 'junction');
  symlinkSync(join(root, 'app'), join(root, 'link'), 'junction');
  const fail = (cwd) => W.createWorktree(cwd, 'Fix it', 0).then(() => null, (error) => error.message);
  const before = repoState(root);
  // 三次都不改任何东西，一起跑
  const [app, link, out] = await Promise.all([fail(join(root, 'app')), fail(join(root, 'link')), fail(outside)]);
  const sub = { app, link, outside: out };
  const middle = repoState(root);
  appendFileSync(join(root, '.git', 'config'), `[core]\n\tworktree = ${root.replace(/\\/g, '/')}\n`);
  const lists = () => Promise.all([gitText(root, ['worktree', 'list', '--porcelain']), gitText(root, ['branch'])]);
  const ruled = { before: repoState(root), lists: await lists() };
  const coreWorktree = await fail(root);
  return { root, before, sub, middle, ruled, coreWorktree, after: repoState(root), lists: await lists() };
});

/** @brief §11.5.2、§11.5.3 第 1 步的用例。 */
function checkCases() {
  test('FS-96 a folder that is not a git repository: This folder isn’t a git repository.', async () => {
    const dir = join(tmp.root, 'plain');
    put(dir, { 'a.txt': 'a\n' });
    await rejectsWith(W.createWorktree(dir, 'Fix it', 0), NOT_REPO);
    assertUntouched(dir);
  });
  test('FS-96 a repository without commits: This repository has no commits yet.', async () => {
    const dir = join(tmp.root, 'nocommit');
    mkdirSync(dir, { recursive: true });
    await git(dir, ['init', '--quiet', '--template=']);
    await rejectsWith(W.createWorktree(dir, 'Fix it', 0), NO_COMMITS);
    assertUntouched(dir);
  });
  test('FS-96 repoInfo’s error (dubious ownership) is the reason; nothing is done', async () => {
    const dir = join(tmp.root, 'dubious-c');
    put(dir, { 'a.txt': 'a\n' });
    const off = dubiousIn(dir);
    try {
      await rejectsWith(W.createWorktree(dir, 'Fix it', 0), DUBIOUS);
    } finally {
      off();
    }
    assertUntouched(dir);
  });
  test('FS-97 core.worktree in the shared config: refused; worktree list, branches and shared config unchanged',
    async () => {
      const { root, ruled, coreWorktree, after: state, lists } = await refuseCase();
      assert.equal(coreWorktree, CORE_WORKTREE);
      assert.deepEqual(state, ruled.before);
      assert.deepEqual(lists, ruled.lists);
      assertUntouched(root);
    });
}

/** @brief FS-111 的用例。 */
function subFolderCases() {
  test('FS-111 a session in <repo>\\app: worktree <repo>\\.mori\\worktrees\\<name>, cwd its app, '
    + 'main folder <repo>\\app', async () => {
    const { cwd, created } = await subCase();
    const root = cwd.slice(0, -'\\app'.length);
    const path = join(root, '.mori', 'worktrees', 'sub-folder-work-111111');
    assert.deepEqual(created, { root, path, branch: 'mori/sub-folder-work-111111', mainFolder: cwd,
      cwd: join(path, 'app') });
    assert.equal(readText(join(created.cwd, 'main.js')), 'main();\n');
    assertPlace(created);
  });
  test('FS-95 R comes from the cwd string (here all lowercase), not from git’s spelling of the repository root',
    async () => {
      const { root, cwd, created } = await subCase();
      assert.notEqual(root, root.toLowerCase());
      assert.ok(created.path.startsWith(cwd.slice(0, -'\\app'.length)));
      assert.equal(S.projectFolder(created.cwd), cwd);
    });
  test('FS-111 .work is made in the session’s cwd inside the worktree, not at the worktree root', async () => {
    const { created } = await subCase();
    assert.equal(readText(join(created.cwd, '.work', '.gitignore')), '*\n');
    assert.equal(existsSync(join(created.path, '.work')), false);
  });
  test('FS-111 git cat-file -e <cut point>:app runs before anything changes', async () => {
    const { calls: list, base } = await subCase();
    const check = list.findIndex((args) => args.join(' ') === `cat-file -e ${base}:app`);
    const change = list.findIndex((args) => args.join(' ') === 'config extensions.worktreeConfig true');
    assert.ok(check >= 0 && change > check, `cat-file at ${check}, first change at ${change}`);
  });
  test('FS-111 <repo>\\app with only untracked files: The folder app isn’t committed yet…; nothing changes',
    async () => {
      const { root, before, middle, sub } = await refuseCase();
      assert.equal(sub.app, notCommitted('app'));
      assert.deepEqual(middle, before);
      assertUntouched(root);
    });
  test('FS-111 a junction into the repo as the session folder is refused (decision 16); nothing changes',
    async () => {
      const { root, before, middle, sub } = await refuseCase();
      assert.equal(sub.outside, rootMismatch(root));
      assert.equal(sub.link, notCommitted('link'));
      assert.deepEqual(middle, before);
    });
}

// ---- FS-97 建 worktree 失败的清理（§11.5.3 最后两段） ----

/** @brief 失败的那个 worktree 的 path 与 branch。 */
const targetOf = (root, name) => ({ path: wtPath(root, name), branch: `mori/${name}` });

/** @brief 只有这个仓库里的 worktree add 按 make 换掉；返回取消登记的函数。 */
function onAdd(root, make) {
  return onGit((command, args, options) => (isWorktreeAdd(args) && within(root, options.cwd)
    ? make(command, args, options) : null));
}

/** @brief 期望这次失败按 §11.5.3 撤干净：状态、清理调用的顺序与错误日志。 */
async function assertUndone(root, target) {
  await assertCleaned(root, target);
  assert.deepEqual(cleanupCalls(root), expectedCleanup(target));
  assert.ok(logs.errors.some((line) => line.includes(`creating the worktree ${target.path} failed, cleaning up`)));
}

/** 无效的切出点（synthetic） */
const BAD_BASE = 'f'.repeat(40);

/**
 * FS-97 切出点无效的场景：worktree add 交给真的 git 时最后一个参数（切出点）换成不存在的提交；exclude 原有两行、
 * 末尾没有换行（FS-96 的 exclude 写法也看这个场景）
 */
const badBaseCase = once(async () => {
  const root = await copyRepo('a', 'f1');
  put(root, { '.git/info/exclude': '# local\n*.tmp' });
  const off = onAdd(root, (command, args, options) => realSpawn(command, [...args.slice(0, -1), BAD_BASE], options));
  try {
    const error = await W.createWorktree(root, 'Bad base', 0, undefined, fixed('b0b0b0'))
      .then(() => null, (failure) => failure);
    return { root, error, target: targetOf(root, 'bad-base-b0b0b0'),
      exclude: readText(join(root, '.git', 'info', 'exclude')) };
  } finally {
    off();
  }
});

/** @brief FS-97 的用例。 */
function failureCases() {
  test('FS-97 worktree add failing on an invalid cut point leaves no folder, registration or branch', async () => {
    const { root, error, target } = await badBaseCase();
    assert.equal(error?.message, `invalid reference: ${BAD_BASE}`);
    await assertUndone(root, target);
  });
  test('FS-97 a worktree add stopped at the timeout after it made everything, leaving locked, is undone', async () => {
    const root = await copyRepo('a', 'f2');
    const target = targetOf(root, 'stopped-add-c0c0c0');
    const admin = join(root, '.git', 'worktrees', 'stopped-add-c0c0c0');
    let made = null;
    // worktree add 做完之后再写 locked：同 §11.1 实测里检出中途被结束时留下的登记
    const off = onAdd(root, (command, args, options) => finishThenHang(command, args, options, () => {
      made = { folder: existsSync(target.path), branch: branchTip(root, target.branch) !== null };
      if (existsSync(admin)) writeFileSync(join(admin, 'locked'), 'initializing\n');
    }));
    try {
      await rejectsWith(W.createWorktree(root, 'Stopped add', 0, 1000, fixed('c0c0c0')), 'timed out after 1 second');
    } finally {
      off();
    }
    assert.deepEqual(made, { folder: true, branch: true });
    await assertUndone(root, target);
  });
  test('FS-97 the default timeout of worktree add and remove, add -A and commit is 120 seconds', () => {
    assert.equal(W.WORKTREE_TIMEOUT_MS, 120_000);
  });
}

// ---- FS-105 打开 worktree 不在的会话（§11.9.4） ----

/** @brief 删掉一个文件夹（递归）。 */
const remove = (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * FS-105 恢复的场景：back-1 有自己的提交，登记带 locked（worktree add 被结束时留下的），文件夹被删掉；会话在它的 app 里。
 * worktree 由测试自己的 git 建，共用配置照 createWorktree 建过之后的样子写上 extensions.worktreeConfig=true（§11.5.3 第 2 步）
 */
const restoreCase = once(async () => {
  const root = await copyRepo('a', 'r105');
  appendFileSync(join(root, '.git', 'config'), '[extensions]\n\tworktreeConfig = true\n');
  const back = S.worktreeOf(wtPath(root, 'back-1'));
  await addWorktree(root, back.path, back.branch);
  await git(back.path, ['commit', '--quiet', '--allow-empty', '-m', 'tip']);
  const tip = branchTip(root, back.branch);
  writeFileSync(join(root, '.git', 'worktrees', 'back-1', 'locked'), 'initializing\n');
  remove(back.path);
  await W.restoreWorktree(back, join(back.path, 'app'));
  return { root, back, tip, regs: await registered(root), calls: callsIn(calls, root) };
});

/** @brief FS-105 的用例。 */
function restoreCases() {
  test('FS-105 restoring when R is gone fails with Project folder not found: <R>', async () => {
    const place = S.worktreeOf(wtPath(join(tmp.root, 'gone'), 'x-1'));
    await rejectsWith(W.restoreWorktree(place), `Project folder not found: ${join(tmp.root, 'gone')}`);
  });
  test('FS-105 a registered (locked) worktree whose folder was deleted is checked out again at its branch tip',
    async () => {
      const { root, back, tip, regs } = await restoreCase();
      assert.ok(regs.includes(pathKey(back.path)));
      assert.equal(checkedOut(back.path), back.branch);
      assert.equal(branchTip(root, back.branch), tip);
      assert.equal(readText(join(back.path, 'README.md')), '# tool\n');
      assert.equal(existsSync(join(root, '.git', 'worktrees', 'back-1', 'locked')), false);
    });
  test('FS-105 the old registration goes first (remove --force --force, prune), then worktree add without -b',
    async () => {
      const { back, calls: list } = await restoreCase();
      const add = [...LONG, 'worktree', 'add', back.path, back.branch];
      assert.deepEqual(list.filter((args) => args.includes(back.path)),
        [['worktree', 'remove', '--force', '--force', back.path], add]);
      const prune = list.findIndex((args) => args.join(' ') === 'worktree prune');
      assert.ok(prune >= 0 && prune < list.findIndex((args) => args.join(' ') === add.join(' ')));
    });
  test('FS-105 the restored worktree gets core.longpaths in config.worktree and .work in the session cwd', async () => {
    const { root, back } = await restoreCase();
    assert.match(readText(join(root, '.git', 'worktrees', 'back-1', 'config.worktree')), /longpaths = true/);
    assert.equal(readText(join(back.path, 'app', '.work', '.gitignore')), '*\n');
    assert.equal(existsSync(join(back.path, '.work')), false);
  });
}

/** @brief FS-105 恢复不了的用例：分支不在、文件夹在而登记没有、超时。 */
function restoreFailureCases() {
  test('FS-105 a missing branch fails with The branch <branch> no longer exists…; registration tells', async () => {
    const root = await copyRepo('a', 'g105');
    const known = S.worktreeOf(wtPath(root, 'reg-6'));
    const stray = S.worktreeOf(wtPath(root, 'stray-7'));
    await addWorktree(root, known.path, known.branch);
    mkdirSync(stray.path, { recursive: true });
    const gone = S.worktreeOf(wtPath(root, 'gone-3'));
    await rejectsWith(W.restoreWorktree(gone), branchGone('mori/gone-3'));
    assert.equal(existsSync(gone.path), false);
    assert.equal(await W.worktreeRegistered(S.worktreeOf(known.path.toLowerCase().replace(/\\/g, '/'))), true);
    assert.equal(await W.worktreeRegistered(stray), false);
    assert.equal(W.unregisteredText(stray.path), unregistered(stray.path));
    assert.ok(existsSync(stray.path));
  });
  test('FS-105 restoring times out: the half-made worktree goes, the branch stays', async () => {
    const root = await copyRepo('a', 't105');
    makeBranch(root, 'mori/slow-5', (await bases()).headA);
    const place = S.worktreeOf(wtPath(root, 'slow-5'));
    // worktree add 真的做完了，在 Mori 看来却到超时才被结束：清理要撤掉一个完整的 worktree
    const off = onAdd(root, (command, args, options) => finishThenHang(command, args, options));
    try {
      await rejectsWith(W.restoreWorktree(place, place.path, 1000), 'Restoring the worktree timed out after 1 second.');
    } finally {
      off();
    }
    assert.equal(existsSync(place.path), false);
    assert.deepEqual(await registered(root), [pathKey(root)]);
    assert.notEqual(branchTip(root, 'mori/slow-5'), null);
    assert.deepEqual(cleanupCalls(root), expectedCleanup(place, false));
  });
}

// ---- FS-106 worktrees.list 与没打开的会话文件（§11.6、§11.9.1） ----

/**
 * FS-106 列表的场景：五个 worktree（只有被忽略的文件、有新文件、文件夹不在、.git 坏了、开着的会话拥有的）
 */
const listCase = once(async () => {
  const root = await copyRepo('a', 'l106');
  const names = ['l-clean', 'l-dirty', 'l-gone', 'l-broken', 'l-open'];
  const place = Object.fromEntries(names.map((name) => [name, S.worktreeOf(wtPath(root, name))]));
  for (const name of names) await addWorktree(root, place[name].path, place[name].branch);
  put(place['l-clean'].path, { '.work/.gitignore': '*\n', '.work/draft.md': 'draft\n', 'debug.log': 'log\n' });
  put(place['l-dirty'].path, { 'new.txt': 'new\n' });
  remove(place['l-gone'].path);
  // worktree 里的 .git 文件是隐藏的（core.hideDotFiles），Windows 上不能直接覆盖写：先删再写
  remove(join(place['l-broken'].path, '.git'));
  writeFileSync(join(place['l-broken'].path, '.git'), 'gitdir: C:/mori-test/nowhere\n');
  const files = await sessionFiles(join(tmp.root, 'l106s'), place);
  const order = [files.clean, files.dirty, files.dirty.toUpperCase(), files.plain, files.late, files.missing,
    files.gone, files.broken, files.open];
  return { root, place, files, result: await W.listWorktrees(order, listHost(files, place)) };
});

/**
 * @brief 列表场景的会话文件：干净的那个由 pi 的 SessionManager 写（真实的写法），其余 synthetic；plain 没有
 *        mori.worktree，late 的 mori.worktree 在第一条消息之后，missing 不存在，open 只在开着的会话里（不在磁盘上）。
 */
async function sessionFiles(dir, place) {
  mkdirSync(dir, { recursive: true });
  const manager = (await sessionManager()).create(place['l-clean'].path, dir);
  manager.appendCustomEntry('mori.worktree', entryOf(place['l-clean']));
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() });
  const own = (name) => writeSession(join(dir, `${name}.jsonl`), place[`l-${name}`].path,
    [worktreeLine('w1', entryOf(place[`l-${name}`])), messageLine('m1', 'hi')]);
  const clean = place['l-clean'].path;
  const late = [messageLine('m1', 'x'), worktreeLine('w1', entryOf(place['l-clean']))];
  return {
    clean: manager.getSessionFile(), dirty: own('dirty'), gone: own('gone'), broken: own('broken'),
    plain: writeSession(join(dir, 'plain.jsonl'), clean, [messageLine('m1', 'x')]),
    late: writeSession(join(dir, 'late.jsonl'), clean, late),
    missing: join(dir, 'missing.jsonl'), open: join(dir, 'open.jsonl'),
  };
}

/**
 * @brief 列表场景的宿主（synthetic）：拥有 l-open 的会话开着（它自己与它的一个实例都在 l-open 里），另一个会话开在
 *        l-dirty\app 里，还有一个开在别处。
 */
function listHost(files, place) {
  const open = place['l-open'].path;
  return {
    openCwds: () => [
      { sessionFile: files.open, cwd: open, owner: null },
      { sessionFile: join(tmp.root, 'l106s', 'instance.jsonl'), cwd: join(open, 'app'), owner: files.open },
      { sessionFile: join(tmp.root, 'l106s', 'other.jsonl'), cwd: join(place['l-dirty'].path, 'app'), owner: null },
      { sessionFile: null, cwd: join(tmp.root, 'elsewhere'), owner: null },
    ],
    ownedBy: (file) => (pathKey(file) === pathKey(files.open) ? entryOf(place['l-open']) : null),
  };
}

/** @brief 列表里的一项（期望）。 */
const itemOf = (place, sessionFile, state) => ({ ...entryOf(place), sessionFile, ...state });

/** @brief FS-106 的用例。 */
function listCases() {
  test('FS-106 listWorktrees lists only sessions that own a worktree, each session file once', async () => {
    const { result, files } = await listCase();
    assert.equal(result.git, true);
    assert.deepEqual(result.items.map((item) => item.sessionFile),
      [files.clean, files.dirty, files.gone, files.broken, files.open]);
  });
  test('FS-106 exists and changes: untracked files count, ignored files (.work, *.log) do not', async () => {
    const { result, files, place } = await listCase();
    assert.deepEqual(result.items.slice(0, 2), [
      itemOf(place['l-clean'], files.clean, { exists: true, changes: false, inUse: false }),
      itemOf(place['l-dirty'], files.dirty, { exists: true, changes: true, inUse: true }),
    ]);
  });
  test('FS-106 changes is null when the folder is gone or git can’t read it', async () => {
    const { result, files, place } = await listCase();
    assert.deepEqual(result.items.slice(2, 4), [
      itemOf(place['l-gone'], files.gone, { exists: false, changes: null, inUse: false }),
      itemOf(place['l-broken'], files.broken, { exists: true, changes: null, inUse: false }),
    ]);
  });
  test('FS-106 an open owner (from ownedBy) and its instances do not make its worktree in use', async () => {
    const { result, files, place } = await listCase();
    assert.deepEqual(result.items[4], itemOf(place['l-open'], files.open, { exists: true, changes: false,
      inUse: false }));
  });
  test('FS-106 readWorktreeEntry reads mori.worktree from a file pi wrote, and stops at the first message',
    async () => {
      const { files, place } = await listCase();
      assert.deepEqual(await W.readWorktreeEntry(files.clean), entryOf(place['l-clean']));
      assert.equal(await W.readWorktreeEntry(files.late), null);
      assert.equal(await W.readWorktreeEntry(files.plain), null);
      assert.equal(await W.readWorktreeEntry(files.missing), null);
    });
  test('FS-106 readWorktreeEntry skips malformed lines and entries that fail the schema', async () => {
    const data = { path: 'D:\\t\\.mori\\worktrees\\a-1', branch: 'mori/a-1', mainFolder: 'D:\\t' };
    const file = writeSession(join(tmp.root, 'r106s', 'mixed.jsonl'), data.path, [
      '{"type":"custom","customType":"mori.worktree", broken', worktreeLine('w0', { path: data.path }),
      { type: 'custom', customType: 'mori.other', data, id: 'o1', parentId: null, timestamp: 'x' },
      worktreeLine('w1', data), messageLine('m1', 'hi')]);
    assert.deepEqual(await W.readWorktreeEntry(file), data);
  });
}

// ---- FS-108 worktrees.cleanUp 只删 Mori 的 worktree（§11.9.1） ----

/** FS-108 不删的场景：主文件夹、Claude 的 worktree、没登记的、子文件夹、任意文件夹、文件夹不在的、开着的会话在用的 */
const keepCase = once(async () => {
  const root = await copyRepo('a', 'x108');
  const claude = join(root, '.claude', 'worktrees', 'x');
  const gone = S.worktreeOf(wtPath(root, 'x-gone'));
  const used = S.worktreeOf(wtPath(root, 'x-used'));
  await addWorktree(root, claude, 'claude/x');
  await addWorktree(root, gone.path, gone.branch);
  await addWorktree(root, used.path, used.branch);
  remove(gone.path);
  const stray = wtPath(root, 'y');
  const any = join(tmp.root, 'any108');
  mkdirSync(stray, { recursive: true });
  put(any, { 'a.txt': 'a\n' });
  const host = { openCwds: () => [{ sessionFile: 's.jsonl', cwd: join(used.path, 'app'), owner: null }],
    ownedBy: () => null };
  const foreign = [root, claude, stray, any, join(used.path, 'app')];
  const soft = await W.cleanUpWorktrees([...foreign, gone.path, used.path], false, host);
  const hard = await W.cleanUpWorktrees([used.path], true, host);
  const list = await gitText(root, ['worktree', 'list', '--porcelain']);
  return { root, gone, used, foreign, soft, hard, list };
});

/** FS-108 force 为假的场景（归档）：共用配置设 status.showUntrackedFiles=no */
const softCase = once(async () => {
  const root = await copyRepo('a', 'y108');
  appendFileSync(join(root, '.git', 'config'), '[status]\n\tshowUntrackedFiles = no\n');
  const names = ['y-clean', 'y-new', 'y-bad'];
  const place = Object.fromEntries(names.map((name) => [name, S.worktreeOf(wtPath(root, name))]));
  for (const name of names) await addWorktree(root, place[name].path, place[name].branch);
  put(place['y-clean'].path, { '.work/.gitignore': '*\n', '.work/draft.md': 'draft\n', 'debug.log': 'log\n' });
  put(place['y-new'].path, { 'new.txt': 'new\n' });
  writeFileSync(join(root, '.git', 'worktrees', 'y-bad', 'index'), 'garbage');
  const { results } = await W.cleanUpWorktrees(names.map((name) => place[name].path), false, NO_HOST);
  return { root, place, names, results: Object.fromEntries(names.map((name, i) => [name, results[i]])),
    regs: await registered(root), calls: callsIn(calls, root) };
});

/** FS-108 force 为真的场景（删除、设置页）：有改动又锁着的，里面有目录联接的 */
const hardCase = once(async () => {
  const root = await copyRepo('a', 'z108');
  const names = ['z-edit', 'z-link'];
  const place = Object.fromEntries(names.map((name) => [name, S.worktreeOf(wtPath(root, name))]));
  for (const name of names) await addWorktree(root, place[name].path, place[name].branch);
  put(place['z-edit'].path, { 'README.md': '# changed\n', 'new.txt': 'new\n' });
  writeFileSync(join(root, '.git', 'worktrees', 'z-edit', 'locked'), 'initializing\n');
  const outside = join(tmp.root, 'outside108', 'pkg');
  put(outside, { 'keep.txt': 'keep\n' });
  symlinkSync(outside, join(place['z-link'].path, 'node_modules'), 'junction');
  const { results } = await W.cleanUpWorktrees(names.map((name) => place[name].path), true, NO_HOST);
  return { root, place, names, outside, results, regs: await registered(root), calls: callsIn(calls, root) };
});

/** @brief 删掉了的结果。 */
const removedResult = (path) => ({ path, removed: true, reason: null, error: null });

/** @brief FS-108 不删的用例。 */
function keepCases() {
  test('FS-108 the main folder, .claude/worktrees/x, an unregistered .mori/worktrees/y, a sub-folder, any folder: '
    + 'Not a Mori worktree, nothing deleted', async () => {
    const { foreign, soft } = await keepCase();
    const expected = foreign.map((path) => ({ path, removed: false, reason: null, error: notMori(path) }));
    assert.deepEqual(soft.results.slice(0, foreign.length), expected);
    for (const path of foreign) assert.ok(existsSync(path), path);
  });
  test('FS-108 a registered worktree whose folder is gone is missing and stays registered (not pruned)', async () => {
    const { root, gone, soft, list } = await keepCase();
    assert.deepEqual(soft.results[5], { path: gone.path, removed: false, reason: 'missing', error: null });
    assert.ok(list.includes(`worktree ${gone.path.replace(/\\/g, '/')}\n`));
    assert.match(list, /\nprunable /);
    assert.notEqual(branchTip(root, gone.branch), null);
  });
  test('FS-108 a worktree an open session uses is in_use, with force true too; it stays', async () => {
    const { used, soft, hard } = await keepCase();
    const expected = { path: used.path, removed: false, reason: 'in_use', error: null };
    assert.deepEqual([soft.results[6], hard.results[0]], [expected, expected]);
    assert.ok(existsSync(join(used.path, 'README.md')));
  });
}

/** @brief FS-108 force 为假与为真的用例。 */
function forceCases() {
  test('FS-108 force false removes a worktree with only ignored files (.work, *.log); its branch stays', async () => {
    const { root, place, names, results, regs } = await softCase();
    assert.deepEqual(results['y-clean'], removedResult(place['y-clean'].path));
    assert.equal(existsSync(place['y-clean'].path), false);
    assert.equal(regs.includes(pathKey(place['y-clean'].path)), false);
    for (const name of names) assert.notEqual(branchTip(root, place[name].branch), null, name);
  });
  test('FS-108 force false keeps untracked files as changes, also with status.showUntrackedFiles=no', async () => {
    const { place, results } = await softCase();
    assert.deepEqual(results['y-new'], { path: place['y-new'].path, removed: false, reason: 'changes', error: null });
    assert.equal(readText(join(place['y-new'].path, 'new.txt')), 'new\n');
  });
  test('FS-108 force false keeps a worktree whose changes can’t be read, with git’s text (decision 21)', async () => {
    const { place, results } = await softCase();
    const result = results['y-bad'];
    assert.deepEqual({ ...result, error: null },
      { path: place['y-bad'].path, removed: false, reason: null, error: null });
    assert.match(result.error ?? '', /index file smaller than expected$/);
    assert.ok(existsSync(place['y-bad'].path));
  });
  test('FS-108 force false runs git -c core.longpaths=true worktree remove <path> without --force', async () => {
    const { place, calls: list } = await softCase();
    const removes = list.filter((args) => args.includes('remove'));
    assert.equal(removes.length, 1, JSON.stringify(removes));
    assert.deepEqual(removes[0].slice(0, 2), LONG);
    assert.deepEqual(removes[0].slice(-3), ['worktree', 'remove', place['y-clean'].path]);
    assert.equal(removes[0].includes('--force'), false);
  });
  test('FS-108 force true removes a locked worktree with changes (--force --force); branches stay', async () => {
    const { root, place, names, results, regs, calls: list } = await hardCase();
    assert.deepEqual(results, names.map((name) => removedResult(place[name].path)));
    for (const name of names) assert.equal(existsSync(place[name].path), false, name);
    assert.deepEqual(regs, [pathKey(root)]);
    for (const name of names) {
      assert.notEqual(branchTip(root, place[name].branch), null, name);
      assert.ok(list.some((args) => args.join(' ') === [...LONG, 'worktree', 'remove', '--force', '--force',
        place[name].path].join(' ')), name);
    }
  });
  test('FS-108 a junction inside the worktree: the folder goes, the folder it points to is untouched', async () => {
    const { outside, place } = await hardCase();
    assert.equal(existsSync(place['z-link'].path), false);
    assert.equal(readText(join(outside, 'keep.txt')), 'keep\n');
  });
}

// ---- FS-109 Initialize git（§11.11） ----

/** @brief 一个要初始化的文件夹（synthetic 的文件）。 */
function initFolder(name, files) {
  const dir = join(tmp.root, name);
  mkdirSync(dir, { recursive: true });
  put(dir, files);
  return dir;
}

/** @brief 很多小文件（git add -A 来不及在 1 毫秒里做完）。 */
const manyFiles = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`m/f${i}.txt`, `${i}\n`]));

/** @brief FS-109 的用例。 */
function initCases() {
  test('FS-109 initGit: git init, .work/.gitignore, add -A by .gitignore, one Initial commit on the default branch',
    async () => {
      const dir = initFolder('i1', { 'a.txt': 'a\n', '.gitignore': '*.log\nbuild/\n', 'x.log': 'x\n',
        'build/out.bin': 'b\n', 'node_modules/pkg/index.js': 'module.exports = 1;\n' });
      assert.deepEqual(await W.initGit(dir), { initialized: true });
      const [tree, log] = await Promise.all([gitText(dir, ['ls-tree', '-r', '--name-only', 'HEAD']),
        gitText(dir, ['log', '--format=%s|%D'])]);
      assert.deepEqual(tree.split('\n'), ['.gitignore', 'a.txt', 'node_modules/pkg/index.js']);
      assert.equal(log, 'Initial commit|HEAD -> main');
      assert.equal(readText(join(dir, '.work', '.gitignore')), '*\n');
      const steps = callsIn(calls, dir).filter((args) => ['init', 'add', 'commit'].includes(args[0]));
      assert.deepEqual(steps, [['init'], ['add', '-A'], ['commit', '--allow-empty', '-m', 'Initial commit']]);
      await rejectsWith(W.initGit(dir), ALREADY_REPO);
    });
  test('FS-109 a timeout removes the .git initGit made (no index.lock left); the next initGit succeeds', async () => {
    const dir = initFolder('i4', manyFiles(100));
    await rejectsWith(W.initGit(dir, 1), 'timed out after 1 ms');
    assert.equal(existsSync(join(dir, '.git')), false);
    assert.equal(readText(join(dir, '.work', '.gitignore')), '*\n');
    assert.deepEqual(await W.initGit(dir), { initialized: true });
    const tree = await gitText(dir, ['ls-tree', '-r', '--name-only', 'HEAD']);
    assert.equal(tree.split('\n').length, 100);
  });
  test('FS-109 a .git that was there before is kept when initGit fails', async () => {
    const empty = initFolder('i5', { ...manyFiles(20), '.git/.keep': '' });
    await rejectsWith(W.initGit(empty, 1), 'timed out after 1 ms');
    assert.ok(existsSync(join(empty, '.git', '.keep')));
  });
  test('FS-109 repoInfo’s error (dubious ownership) is the reason; nothing is done', async () => {
    const dir = initFolder('i7', { 'a.txt': 'a\n' });
    const off = dubiousIn(dir);
    try {
      await rejectsWith(W.initGit(dir), DUBIOUS);
    } finally {
      off();
    }
    assert.equal(existsSync(join(dir, '.git')), false);
    assert.equal(existsSync(join(dir, '.work')), false);
  });
}

// ---- 真实 git 的场景：互不相干的用例并行 ----

describe('worktrees and Initialize git with real git (independent tests in parallel)', { concurrency: true }, () => {
  describe('FS-96 createWorktree', { concurrency: true }, createCases);
  describe('FS-96 FS-95 FS-97 createWorktree, continued', { concurrency: true }, createMoreCases);
  describe('FS-94 name collisions', { concurrency: true }, collisionCases);
  describe('FS-96 FS-97 checks before any change', { concurrency: true }, checkCases);
  describe('FS-111 sub-folder sessions', { concurrency: true }, subFolderCases);
  describe('FS-97 failure cleanup', { concurrency: true }, failureCases);
  describe('FS-105 restoring a worktree', { concurrency: true }, restoreCases);
  describe('FS-105 when a worktree can’t be restored', { concurrency: true }, restoreFailureCases);
  describe('FS-106 worktrees.list', { concurrency: true }, listCases);
  describe('FS-108 worktrees.cleanUp: what is never deleted', { concurrency: true }, keepCases);
  describe('FS-108 worktrees.cleanUp with force false and true', { concurrency: true }, forceCases);
  describe('FS-109 initGit', { concurrency: true }, initCases);
});
