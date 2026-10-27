// 文件系统规格真实模型一层（docs/specs/file-system.md §19.1“真实”一行）的场景模块 wt：快照、命令语料与 worktree，
// 由 tests/ui/fs-real.mjs 按 WT_STEPS 跑（上下文、启动、截图、重跑与结果都在 fs-real-setup.mjs）。
// - FS-21 snapshots：不经模型。在这个进程里用 esbuild 打包内核的 snapshots.ts 与 git.ts（同 tests/unit/filesystem/
//   snap-helpers.mjs：两者共用一份状态），快照目录是新的临时目录；在 Mori 仓库（appRoot/..）与 --repo 给的仓库上各拍
//   三张（inQueue 里 takeSnapshot，同 rewind.ts 的用法），记每张的耗时、内部仓库的大小与 refs/mori 下的 ref 数。拍之前
//   与之后各读一次那个仓库的 git 状态（--no-optional-locks 的 status、全部 ref、worktree 列表、共用的 config 与
//   info/exclude），核对没有变。量完删掉临时的快照目录（里面是那个仓库文件的副本）。
// - FS-55 command-corpus：对 tests/fixtures/** 与数据目录（--source 或 key 方式建的目录，以及这次运行复制出的目录）
//   里的会话文件中每个 bash、powershell 调用跑 kernel/commandScan.ts 的 scanCommand（tests/unit/load.mjs 打包），
//   没有抛错即通过；§7.13 的数字（总数、认出写入的、有看不出来的目标的、有 leave 的、解析失败的比例与按 reason 的分布、
//   Full access 下会出卡的）写进 detail，不写命令原文。Full access 下会不会出卡按 pathGate.ts 的 classifyCall 算，
//   文件系统探针是不碰磁盘的替身（synthetic：每个路径都当作不存在，真实路径就是词法路径；语料里的工作路径多半已不在）。
//   这个步骤排在模型的步骤之后，这次运行的会话也算进去。
// - FS-113 worktree-merge：临时项目（synthetic：一次提交的 git 仓库，分支 main，提交者只在这个仓库里设），经界面开会话、
//   切到 Full access、打开 Worktree 开关，让真实模型改 config.txt 并提交；再让它合并到主分支，主文件夹里跑合并的命令
//   出卡时点 Allow once（卡上的目标都在这个临时目录里才允许，否则 Deny）。只断言程序保证的事：worktree 会话建好（同一个
//   会话 id、cwd 与 SessionInfo.worktree、分支在仓库里、Full access 带过来）；改与提交的那一轮不出卡、主文件夹的文件与
//   分支不变；换到工作路径外跑的命令（scanCommand 认出的 leave）都有批准卡，第一张 scope 为 outside、原因里有 leaves、
//   界面上的卡也是 outside；允许之后主文件夹的 git log 里有 worktree 的提交。模型怎么做（命令、回复、用了哪个模型）写进
//   note；模型没提交、走到外面、没在主文件夹跑合并时按前提没满足重跑（withAttempts，最多 3 次）。
// 只读页面和磁盘、发界面操作；不改 Mori 的源码，不碰 key（fs-real-setup.mjs 在被 import 时已从环境里删掉）。

// fs-real-setup.mjs 先 import：它一被执行就把 key 的环境变量读走并删掉
import { briefSafe, errorText, newRealProject, realRequests, shotReal, withAttempts } from './fs-real-setup.mjs';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadKernelModule } from '../unit/load.mjs';
import {
  answerCard, bashPath, cardOf, cardsSince, gateEvents, kernelEvents, liveInfo, openFsSession, paneSel, paneState, poll,
  readJsonl, readText, samePath, setPermission, toolCallsIn, underPath, waitCardOrIdle,
} from './fs-helpers.mjs';
import { git, gitRun } from './fs-git-helpers.mjs';
import { appRoot, oneLine } from './lib.mjs';
import { sendMessage, userSession } from './tb-helpers.mjs';
import { stagesOf } from './v1-switch-helpers.mjs';

/** 命令工具（§7.2 的 shell） */
const SHELLS = new Set(['bash', 'powershell']);

// ---------- 共用：内核的纯函数模块（esbuild 打包，同单元测试） ----------

/** commandScan.ts 与 pathGate.ts 的导出（第一次用时打包，之后共用） */
let kernelLoad = null;

/**
 * @brief 打包并导入 kernel/commandScan.ts（scan）与 kernel/pathGate.ts（gate，insideDir、classifyCall）；只打包一次，
 *        失败时下一次重试。
 * @return { scan, gate }
 */
function kernelKits() {
  kernelLoad ??= Promise.all([loadKernelModule('src/kernel/commandScan.ts'),
    loadKernelModule('src/kernel/pathGate.ts')]).then(([scan, gate]) => ({ scan, gate }), (error) => {
    kernelLoad = null;
    throw error;
  });
  return kernelLoad;
}

/** @brief 一个工作路径的 vars（同 workspace.workVars：TEMP、TMP、TMPDIR → <cwd>\.work\tmp，§7.2、§7.11）。 */
function varsOf(cwd) {
  const tmp = win32.join(cwd, '.work', 'tmp');
  return { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
}

/** @brief 计数表里 key 加一。 */
function bump(table, key) {
  table[key] = (table[key] ?? 0) + 1;
}

/** @brief 计数表按次数从多到少，最多 limit 项（detail 不过长）。 */
function topCounts(table, limit = 20) {
  return Object.fromEntries(Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

// ---------- FS-21：快照的耗时与大小，仓库不变 ----------

/** FS-21 每个仓库拍几张快照 */
const SHOTS = 3;
/** 快照与 git 两个内核模块打进同一个包（共用一份状态，同 tests/unit/filesystem/snap-helpers.mjs） */
const SNAP_ENTRY = ["export * as S from './src/kernel/snapshots.ts';", "export * as G from './src/kernel/git.ts';"]
  .join('\n');
/** detail 里最多列出几条 git 状态的变化 */
const CHANGES_SHOWN = 12;

/** @brief 打包快照模块（esbuild，选项同 tests/unit/load.mjs）；返回打包结果的路径（用完由调用方删掉）。 */
async function buildSnapshotKit() {
  const dir = join(appRoot, 'test-results', 'unit-bundles');
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `fs-real-snapshots.${process.pid}.mjs`);
  await build({
    stdin: { contents: SNAP_ENTRY, resolveDir: appRoot, sourcefile: 'fs-real-snapshots-entry.mjs', loader: 'js' },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', outfile,
    logLevel: 'silent',
  });
  return outfile;
}

/** git 读仓库状态时输出的上限（大仓库的 status 与 ref 列表也读得完整；读不完整时算读不出） */
const READ_BUFFER = 256 * 1024 * 1024;

/** @brief 文件内容的 sha1；没有路径或文件不存在时为 'missing'。 */
function digestOf(file) {
  if (!file || !existsSync(file)) return 'missing';
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

/**
 * @brief 在 repo 里跑一次只读的 git（去掉 GIT_ 开头的环境变量、LC_ALL=C，同 fs-git-helpers.mjs gitRun，输出上限
 *        READ_BUFFER）。
 * @return { ok, text（stdout；失败时为一句原因） }
 */
function readGit(repo, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)));
  const result = spawnSync('git', args, { cwd: repo, env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', windowsHide: true, maxBuffer: READ_BUFFER });
  if (result.status === 0 && !result.error) return { ok: true, text: result.stdout };
  const why = result.error?.message ?? oneLine(result.stderr ?? '', 300);
  return { ok: false, text: `git ${args.find((item) => !item.startsWith('-'))} failed: ${why}` };
}

/**
 * @brief 一个仓库此刻的 git 状态（拍快照之前与之后各读一次）：status（--no-optional-locks：不刷新、不写回 index）、
 *        全部 ref、worktree 列表、共用的 config 与 info/exclude 的摘要；index 的摘要只写进 detail（编辑器自己的 git
 *        可能刷新它）。读不出的写进 errors（核对按没通过算）。
 */
function repoState(repo) {
  const errors = [];
  const text = (args) => {
    const result = readGit(repo, args);
    if (!result.ok) errors.push(result.text);
    return result.text;
  };
  const gitPath = (name) => readGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', name]).text.trim();
  return {
    status: text(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    refs: text(['for-each-ref', '--format=%(refname) %(objectname)']),
    worktrees: text(['worktree', 'list', '--porcelain']),
    config: digestOf(gitPath('config')), exclude: digestOf(gitPath('info/exclude')), index: digestOf(gitPath('index')),
    errors,
  };
}

/** @brief 两组条目的差别：少了的记 "<label> gone: …"，多了的记 "<label> new: …"。 */
function setChanges(label, before, after) {
  const left = new Set(before);
  const right = new Set(after);
  return [...before.filter((item) => !right.has(item)).map((item) => `${label} gone: ${oneLine(item, 160)}`),
    ...after.filter((item) => !left.has(item)).map((item) => `${label} new: ${oneLine(item, 160)}`)];
}

/**
 * @brief 两次 repoState 之间变了的地方（每条一句），读不出的也算一条；没变时为空。index 不在其中（见 repoState）。
 */
function stateChanges(before, after) {
  const split = (text, by) => text.split(by).filter(Boolean);
  const changes = [...before.errors, ...after.errors].map((error) => `could not read: ${error}`);
  changes.push(...['config', 'exclude'].filter((key) => before[key] !== after[key]).map((key) => `${key} changed`));
  changes.push(...setChanges('status', split(before.status, '\0'), split(after.status, '\0')));
  changes.push(...setChanges('ref', split(before.refs, /\r?\n/), split(after.refs, /\r?\n/)));
  changes.push(...setChanges('worktree', split(before.worktrees, /\r?\n/), split(after.worktrees, /\r?\n/)));
  return changes;
}

/** @brief 目录里全部文件的字节数与个数（不跟链接）。 */
function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const folder = stack.pop();
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) {
        bytes += statSync(path).size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

/** @brief 内部仓库的大小（字节、文件数）与 refs/mori/ 下的 ref 数（同 snap-helpers.mjs：--work-tree 也给内部仓库）。 */
function internalView(repoDir) {
  if (!existsSync(repoDir)) return { bytes: 0, files: 0, moriRefs: 0, missing: true };
  const refs = gitRun(repoDir, [`--git-dir=${repoDir}`, `--work-tree=${repoDir}`, 'for-each-ref',
    '--format=%(refname)', 'refs/mori/']);
  return { ...dirSize(repoDir), moriRefs: refs.code === 0 ? refs.stdout.split(/\r?\n/).filter(Boolean).length : null };
}

/** @brief 拍一张（快照模块的队列里 takeSnapshot），记耗时（毫秒）与成败。 */
async function timedShot(kit, repo) {
  const start = performance.now();
  const taken = await kit.S.inQueue(repo, () => kit.S.takeSnapshot(repo, null))
    .catch((error) => ({ error: String(error?.message ?? error) }));
  const ms = Math.round(performance.now() - start);
  return taken.oid ? { ms, ok: true } : { ms, ok: false, error: oneLine(taken.error, 300) };
}

/**
 * @brief 在一个仓库上拍 SHOTS 张（kit 已设好快照目录），前后各读一次它的 git 状态。
 * @return { repo, shots: [{ ms, ok, error? }], internal（internalView）, state（快照状态）, changes, indexChanged }
 */
async function measureRepo(kit, repo) {
  const before = repoState(repo);
  const shots = [];
  for (let i = 0; i < SHOTS; i += 1) shots.push(await timedShot(kit, repo));
  await kit.S.drainSnapshots();
  const after = repoState(repo);
  const state = kit.S.snapshotState(repo);
  let internal;
  try {
    internal = internalView(kit.S.snapshotRepo(repo));
  } catch (error) {
    internal = { error: errorText(error, 300) };
  }
  return { repo, shots, internal, state: { state: state.state, reason: state.reason, error: state.error,
    skippedTotal: state.skippedTotal, nestedTotal: state.nestedTotal }, changes: stateChanges(before, after),
  indexChanged: before.index !== after.index };
}

/**
 * @brief 用一份全新的快照模块（同一个打包结果按不同的查询串导入，等于一次新的后台进程）量一个仓库：快照目录 snaps，
 *        先找 git（不算进第一张的耗时）。
 */
async function measureWith(outfile, repo, snaps, index) {
  const kit = await import(`${pathToFileURL(outfile).href}?repo=${index}`);
  kit.G.setSnapshotsDir(snaps);
  const found = await kit.G.findGit();
  if (found.state !== 'ok') return { repo, git: found, shots: [], changes: [], indexChanged: false };
  return { git: found, ...(await measureRepo(kit, repo)) };
}

/**
 * @brief 量的时候把内核模块自己的日志（[kernel] 开头）收进 lines，别的照常打印。
 * @return 恢复 console 的函数
 */
function captureKernelLogs(lines) {
  const saved = { log: console.log, error: console.error };
  const wrap = (original) => (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[kernel]')) lines.push(oneLine(args.join(' '), 300));
    else original(...args);
  };
  console.log = wrap(saved.log);
  console.error = wrap(saved.error);
  return () => Object.assign(console, saved);
}

/** @brief 一个仓库的量法写进 detail 的样子：第一张的耗时、第二张起每张的耗时、内部仓库、快照状态。 */
function shotSummary(result) {
  return { repo: result.repo, git: result.git?.version ?? result.git?.state ?? null,
    ok: result.shots.length === SHOTS && result.shots.every((shot) => shot.ok), firstMs: result.shots[0]?.ms ?? null,
    afterFirstMs: result.shots.slice(1).map((shot) => shot.ms), errors: result.shots.filter((shot) => !shot.ok)
      .map((shot) => shot.error), internal: result.internal ?? null, snapshots: result.state ?? null };
}

/** @brief FS-21 的两条检查：快照都成功（耗时与大小在 detail），量过的仓库的 git 状态没有变。 */
function recordSnapshots(ctx, results, logs) {
  const [mori, other] = results.map(shotSummary);
  ctx.record(`FS-21 real snapshots: ${SHOTS} snapshots each on the Mori repository (appRoot/..) and on the --repo `
    + 'repository when given all succeed (the time of the first snapshot and of each one after it, and the internal '
    + 'repo size, in the detail)', [mori, other].filter(Boolean).every((item) => item.ok),
  { mori, repo: other ?? 'no --repo given: only the Mori repository was measured', snapshotsDir: 'a new temp dir per '
    + 'repository (MORI_SNAPSHOTS_DIR role), removed after measuring' },
  logs.length ? { kernelLogs: logs.length, first: logs.slice(0, 3) } : '');
  ctx.record('FS-21 real snapshots: taking them leaves each measured repository untouched (git status, refs, '
    + 'worktree list, config and info/exclude are the same before and after)',
  results.every((result) => result.changes.length === 0), results.map((result) => ({ repo: result.repo,
    changes: result.changes.length, shown: result.changes.slice(0, CHANGES_SHOWN),
    indexChanged: result.indexChanged })));
  ctx.note('FS-21: copy the snapshot times and internal repo sizes into docs/v1/fs-checks.md');
}

/**
 * @brief FS-21（§19.2）：在 Mori 仓库（appRoot/..）与 --repo（ctx.repo）上各拍三张快照，记两条检查。每个仓库用新的
 *        临时快照目录；量完删掉打包结果与这些目录。
 */
export async function snapshotsScenario(ctx) {
  const repos = [resolve(appRoot, '..'), ...(ctx.repo ? [resolve(ctx.repo)] : [])];
  const dir = mkdtempSync(join(tmpdir(), 'mori-fs-real-snaps-'));
  const logs = [];
  const results = [];
  const outfile = await buildSnapshotKit();
  const restore = captureKernelLogs(logs);
  try {
    for (const [index, repo] of repos.entries()) {
      results.push(await measureWith(outfile, repo, join(dir, `r${index}`), index));
    }
  } finally {
    restore();
    rmSync(outfile, { force: true });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  recordSnapshots(ctx, results, logs);
}

// ---------- FS-55：命令语料统计 ----------

/** 不进去找调用的事件：流式的半截消息（参数可能不完整；同一个调用在 message_end、tool_execution_start 里完整） */
const PARTIAL_EVENTS = new Set(['message_update', 'message_start']);
/** 找不到工作路径时用的（synthetic，同 §7.9 的记号 P） */
const SYNTHETIC_CWD = 'C:\\w\\proj';
/** 数据目录里放会话文件的地方：用户会话、协作的实例会话、增强的会话 */
const SESSION_ROOTS = [['pi', 'sessions'], ['teams'], ['memory', 'projects']];
/**
 * 不碰磁盘的文件系统探针（synthetic）：每个路径都当作不存在，classifyCall 的真实路径就是词法路径（§6.3 第 2 条
 * 一直走到根）；语料里的工作路径多半已经不在，碰磁盘反而按此刻别的文件判断
 */
const LEXICAL_PROBE = Object.freeze({
  lstat: () => {
    throw Object.assign(new Error('synthetic: lexical classification'), { code: 'ENOENT' });
  },
  realpath: (path) => path,
});

/**
 * @brief 一个节点是不是命令工具的调用：pi 消息里的 toolCall 块（优先级 1），或 tool_execution_start 事件（优先级 2，
 *        pi 校验过的参数）。
 * @return { id, shell, command, prio }；不是时为 null
 */
function callOf(node) {
  if (node.type === 'toolCall' && SHELLS.has(node.name)) {
    return { id: node.id ?? null, shell: node.name, command: node.arguments?.command, prio: 1 };
  }
  if (node.type === 'tool_execution_start' && SHELLS.has(node.toolName)) {
    return { id: node.toolCallId ?? null, shell: node.toolName, command: node.args?.command, prio: 2 };
  }
  return null;
}

/**
 * @brief 记下一个调用：有 id 时同一个 id 只算一次（优先级高的、同级时命令更长的为准），没有 id 时同一条命令只算一次。
 *        command 不是字符串的（参数没能解析，pi 记了 argumentsError）记进 calls.skipped（按 id 去重）。
 */
function addCall(calls, call) {
  if (typeof call.command !== 'string') {
    calls.skipped.add(call.id ?? Symbol('no id'));
    return;
  }
  const key = call.id ? `id:${call.id}` : `cmd:${call.shell}:${call.command}`;
  const known = calls.map.get(key);
  if (!known || call.prio > known.prio || (call.prio === known.prio && call.command.length > known.command.length)) {
    calls.map.set(key, call);
  }
}

/** @brief 在一个 JSON 值里找命令工具的调用（不进流式的半截消息），记进 calls。 */
function collectCalls(root, calls) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (PARTIAL_EVENTS.has(node.type)) continue;
    const call = callOf(node);
    if (call) addCall(calls, call);
    stack.push(...Object.values(node));
  }
}

/** @brief fixture 里的工作路径：第一个 session.create 的 cwd，没有时第一个绝对 Windows 路径的 cwd 字段。 */
function fixtureCwd(root) {
  let any = null;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && typeof node.cwd === 'string' && /^[A-Za-z]:[\\/]/.test(node.cwd)) {
      if (node.type === 'session.create') return node.cwd;
      any ??= node.cwd;
    }
    stack.push(...(Array.isArray(node) ? node : Object.values(node)).reverse());
  }
  return any;
}

/** @brief 目录下（递归，不跟链接）名字符合 pattern 的文件；目录不在时为空。 */
function walkFiles(dir, pattern) {
  if (!dir || !existsSync(dir)) return [];
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const folder = stack.pop();
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && pattern.test(entry.name)) found.push(path);
    }
  }
  return found.sort();
}

/** @brief 数据目录里的会话文件（SESSION_ROOTS 下、路径里有一段 sessions 的 .jsonl）。 */
function sessionFilesIn(dataDir) {
  if (!dataDir) return [];
  return SESSION_ROOTS.flatMap((parts) => walkFiles(join(dataDir, ...parts), /\.jsonl$/i))
    .filter((file) => relative(dataDir, file).split(sep).includes('sessions'));
}

/**
 * @brief 读一个文件里的调用：.jsonl（pi 的会话文件）逐行解析，工作路径取头一行（type session）的 cwd；.json（fixture）
 *        整个解析，工作路径按 fixtureCwd。坏行跳过。
 * @return { cwd, calls: [{ id, shell, command, prio }], skipped（没有命令文字的调用数，别处有完整参数的不算） }
 */
function readCalls(file) {
  const calls = { map: new Map(), skipped: new Set() };
  const text = readFileSync(file, 'utf8');
  let cwd = null;
  if (/\.jsonl$/i.test(file)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // 写到一半的行或坏行：跳过
        continue;
      }
      if (entry?.type === 'session' && typeof entry.cwd === 'string') cwd ??= entry.cwd;
      else collectCalls(entry, calls);
    }
  } else {
    const root = JSON.parse(text);
    cwd = fixtureCwd(root);
    collectCalls(root, calls);
  }
  const skipped = [...calls.skipped].filter((id) => typeof id !== 'string' || !calls.map.has(`id:${id}`)).length;
  return { cwd: cwd ?? SYNTHETIC_CWD, calls: [...calls.map.values()], skipped };
}

/** @brief 全新的统计表（§7.13 的各项）。 */
function emptyStats() {
  return { total: 0, bash: 0, powershell: 0, failed: 0, failReasons: {}, withWrites: 0, writeForms: {},
    withUnknown: 0, unknownWhy: {}, withLeaves: 0, leaveForms: {}, fullAccessAsks: 0, askScopes: {}, askReasons: {},
    threw: 0, errors: [], skipped: 0, slowestMs: 0 };
}

/** @brief scanCommand 的结果记进统计表：解析失败按 reason；认出的写入、看不出来的目标、leave 按形式。 */
function tally(stats, result) {
  if (!result.ok) {
    stats.failed += 1;
    bump(stats.failReasons, result.reason);
    return;
  }
  if (result.writes.length) stats.withWrites += 1;
  for (const write of result.writes) bump(stats.writeForms, write.form);
  const unknown = result.writes.filter((write) => write.path === null);
  if (unknown.length) stats.withUnknown += 1;
  for (const write of unknown) bump(stats.unknownWhy, write.unknown ?? 'none');
  if (result.leaves.length) stats.withLeaves += 1;
  for (const leave of result.leaves) bump(stats.leaveForms, leave.form);
}

/** @brief 按 pathGate.classifyCall（不碰磁盘）算 Full access 下会不会出卡（scope 不是 inside），记进统计表。 */
function tallyScope(kits, call, stats) {
  const classified = kits.gate.classifyCall(call.shell, { command: call.command }, call.cwd, LEXICAL_PROBE);
  if (classified.scope === 'inside') return;
  stats.fullAccessAsks += 1;
  bump(stats.askScopes, classified.scope);
  for (const target of classified.targets) {
    if (target.cls !== 'inside' && target.cls !== 'work') bump(stats.askReasons, target.cls);
  }
}

/** @brief 抛错的位置（错误名与栈的第一帧，不带错误原文：原文里可能有命令的片段）。 */
function errorWhere(error) {
  const frame = String(error?.stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  return `${error?.name ?? 'Error'} ${oneLine(frame.trim(), 200)}`;
}

/** @brief 分析一个调用（scanCommand，再 classifyCall），记进统计表；scanCommand 抛错时记位置，不再分类。 */
function scanOne(kits, call, stats) {
  stats.total += 1;
  bump(stats, call.shell);
  const start = performance.now();
  let result;
  try {
    result = kits.scan.scanCommand({ command: call.command, shell: call.shell, cwd: call.cwd, vars: varsOf(call.cwd) });
  } catch (error) {
    stats.threw += 1;
    if (stats.errors.length < 5) stats.errors.push(errorWhere(error));
    return;
  } finally {
    stats.slowestMs = Math.max(stats.slowestMs, Math.round(performance.now() - start));
  }
  tally(stats, result);
  tallyScope(kits, call, stats);
}

/**
 * @brief 一处来源的全部文件：逐个读出调用并分析。读不出的文件只计数（会话文件可能正被 Mori 写着）。
 * @return { name, files, calls, unreadable }
 */
function scanSource(kits, source, stats) {
  const summary = { name: source.name, files: source.files.length, calls: 0, unreadable: 0 };
  for (const file of source.files) {
    let read;
    try {
      read = readCalls(file);
    } catch {
      // 读不出或不是 JSON 的文件：只计数
      summary.unreadable += 1;
      continue;
    }
    stats.skipped += read.skipped;
    summary.calls += read.calls.length;
    for (const call of read.calls) scanOne(kits, { ...call, cwd: read.cwd }, stats);
  }
  return summary;
}

/** @brief 语料的三处来源：tests/fixtures/**、数据目录（--source 或 key 方式建的）、这次运行复制出的数据目录。 */
function corpusSources(ctx) {
  return [
    { name: 'tests/fixtures/**', files: walkFiles(join(appRoot, 'tests', 'fixtures'), /\.jsonl?$/i) },
    { name: ctx.keyMode ? 'the data dir built through the UI (key mode)' : 'the --source data dir',
      files: sessionFilesIn(ctx.sourceDir) },
    { name: 'this run\'s copied data dir', files: sessionFilesIn(ctx.userData) },
  ];
}

/** @brief FS-55 的 detail：§7.13 的数字（不含命令原文）。 */
function corpusDetail(stats, sources, ms) {
  const ratio = stats.total ? (stats.failed / stats.total).toFixed(4) : null;
  return { total: stats.total, bash: stats.bash ?? 0, powershell: stats.powershell ?? 0, failed: stats.failed,
    failedRatio: ratio, failReasons: topCounts(stats.failReasons), withWrites: stats.withWrites,
    withUnknownTargets: stats.withUnknown, unknownWhy: topCounts(stats.unknownWhy), withLeaves: stats.withLeaves,
    fullAccessAsks: stats.fullAccessAsks, askScopes: stats.askScopes, askReasons: stats.askReasons,
    threw: stats.threw, errors: stats.errors, noCommandString: stats.skipped, sources, ms, slowestMs: stats.slowestMs,
    method: 'one call per toolCallId (tool_execution_start args, else the complete toolCall block; streamed partial '
      + 'messages skipped); cwd per file (the session header, or the fixture\'s session.create); Full access asks = '
      + 'pathGate.classifyCall scope other than inside with a probe that never touches the disk (lexical paths)' };
}

/**
 * @brief FS-55（§19.2、§7.13）：tests/fixtures/** 与数据目录的会话文件里每个 bash、powershell 调用跑 scanCommand，
 *        没有抛错即通过（还要求至少分析了一个调用，否则是没找到语料）；数字写进 detail，写入与 leave 的形式写进 note。
 */
export async function commandCorpusScenario(ctx) {
  const kits = await kernelKits();
  const stats = emptyStats();
  const start = performance.now();
  const sources = corpusSources(ctx).map((source) => scanSource(kits, source, stats));
  const ms = Math.round(performance.now() - start);
  ctx.record('FS-55 real command-corpus: scanCommand runs over every bash and powershell call in tests/fixtures/** '
    + 'and in the session files of the data dirs without throwing (§7.13 numbers in the detail, no command text)',
  stats.threw === 0 && stats.total > 0, corpusDetail(stats, sources, ms),
  { writeForms: topCounts(stats.writeForms, 30), leaveForms: topCounts(stats.leaveForms, 15) });
  ctx.note('FS-55: copy the command-corpus numbers (counts, parse-failure ratio, reasons) into docs/v1/fs-checks.md');
}

// ---------- FS-113：真实模型在 worktree 里工作 ----------

/** 这个场景的步骤名与编号（withAttempts 用它截图、记前提没满足） */
const WORKTREE_DRIVE = Object.freeze({ name: 'worktree-merge', ids: ['FS-113'] });
/** 模型要改的文件与它原来的内容（synthetic） */
const WT_FILE = 'config.txt';
const WT_BEFORE = 'name = wt-project\nversion = 1\n';
/** 临时仓库的本地配置（synthetic）：模型在 worktree 里提交时用的身份，不签名 */
const LOCAL_CONFIG = [['user.name', 'Mori Test'], ['user.email', 'mori-test@example.invalid'],
  ['commit.gpgsign', 'false']];
/** 一次运行最多等多久（驱动脚本的时限，不是程序保证的事） */
const RUN_MS = 8 * 60 * 1000;
/** 判断运行结束：连续空闲这么久 */
const IDLE_MS = 3000;
/** worktree 的名字（§11.2：小写字母、数字与 -，后接 - 与 6 个十六进制字符） */
const WORKTREE_NAME = /^[a-z0-9-]+-[0-9a-f]{6}$/;
/** 发给模型的两条消息（第一条也决定 worktree 的名字） */
const PROMPTS = Object.freeze({
  edit: `In this folder, change the line "version = 1" in ${WT_FILE} to "version = 2". Then commit that change `
    + `with git (git add ${WT_FILE}, then git commit -m "Bump version"). Work only in this folder and don't ask me `
    + 'anything.',
  merge: (main) => 'Now merge that commit into the main branch. The main branch is checked out in the main folder '
    + `${main}, so run the merge there. Don't ask me anything.`,
});

/**
 * @brief 测试准备（synthetic）：临时目录里的 git 仓库 project（README.md 与 config.txt，一次提交，分支 main），本地设
 *        提交者与不签名（LOCAL_CONFIG，worktree 共用这份配置），授权公网（newRealProject）。
 * @return { root, realRoot, project, base（main 的提交） }
 */
async function wtProject(ctx) {
  const { root, project } = await newRealProject(ctx, 'wt', { repo: true, files: { [WT_FILE]: WT_BEFORE },
    branch: 'main' });
  for (const [key, value] of LOCAL_CONFIG) git(project, 'config', key, value);
  return { root, realRoot: realpathSync.native(root), project, base: git(project, 'rev-parse', 'HEAD') };
}

/**
 * @brief 经界面在 project 里开会话，等 Worktree 开关出现（git 状态到了），切到 Full access，打开开关。
 * @return who（openFsSession 的结果）加 before（发消息之前的会话 id 与会话文件）
 */
async function openWorktreeTab(ctx, setup) {
  const who = await openFsSession(ctx, setup.project);
  const css = `${paneSel(who.tab)} [data-testid="worktree-toggle"]`;
  await ctx.page.locator(css).waitFor({ timeout: 30000 });
  await setPermission(ctx, who.tab, 'full');
  await ctx.page.locator(css).click();
  await ctx.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'true', css,
    { timeout: 5000 });
  return { ...who, before: { sessionId: who.sessionId ?? null, sessionFile: who.sessionFile ?? null } };
}

/** @brief 等这个标签换成 worktree 会话（侧栏行的会话文件换了、后台进程给出 SessionInfo.worktree），最多 60 秒。 */
function worktreeSession(ctx, tab) {
  return poll(async () => {
    const found = await userSession(ctx, tab);
    const info = found?.sessionFile ? await liveInfo(ctx, found.sessionFile).catch(() => null) : null;
    return info?.worktree ? { ...found, info } : null;
  }, 60000, 500);
}

/** @brief worktree 会话合不合 §11.2、§11.5、§11.6：路径、名字、分支、主文件夹、cwd、Full access、会话 id、分支在仓库里。 */
function createdProblems(setup, before, found) {
  const { info } = found;
  const wt = info.worktree;
  const name = basename(wt.path);
  const problems = [];
  if (!samePath(wt.path, join(setup.project, '.mori', 'worktrees', name))) problems.push(`path ${wt.path}`);
  if (!WORKTREE_NAME.test(name)) problems.push(`name ${name}`);
  if (wt.branch !== `mori/${name}`) problems.push(`branch ${wt.branch}`);
  if (!samePath(wt.mainFolder, setup.project)) problems.push(`mainFolder ${wt.mainFolder}`);
  if (!samePath(info.cwd, wt.path)) problems.push(`cwd ${info.cwd}`);
  if (info.approval?.mode !== 'full') problems.push(`approval mode ${info.approval?.mode}`);
  if (before.sessionId && found.sessionId !== before.sessionId) problems.push(`session id ${found.sessionId}`);
  if (gitRun(setup.project, ['show-ref', '--verify', '--quiet', `refs/heads/${wt.branch}`]).code !== 0) {
    problems.push(`branch ${wt.branch} is not in the project's repository`);
  }
  return problems;
}

/**
 * @brief 发第一条消息之后：等 worktree 会话（worktreeSession），核对它（createdProblems）；没建成时带上面板里的错误卡。
 *        建成时把会话 id、会话文件、cwd 与 worktree 记进 who。
 * @return { ok, problems, worktree, cwd, sessionId, stages（阶段行）, errors（错误卡） }
 */
async function createdView(ctx, who, setup, since) {
  const found = await worktreeSession(ctx, who.tab);
  const stages = (await stagesOf(ctx.page, who.tab, since).catch(() => [])).map((item) => item.v ?? item);
  if (!found) {
    const errors = (await paneState(ctx.page, who.tab).catch(() => null))?.errors ?? [];
    return { ok: false, problems: ['no worktree session within 60 s'], stages, errors };
  }
  Object.assign(who, { sessionId: found.sessionId, sessionFile: found.sessionFile, cwd: found.info.cwd,
    cwdKnown: true, worktree: found.info.worktree });
  const problems = createdProblems(setup, who.before, found);
  return { ok: problems.length === 0, problems, worktree: found.info.worktree, cwd: found.info.cwd,
    sessionId: found.sessionId, before: who.before.sessionId, approval: found.info.approval?.mode ?? null, stages };
}

/** @brief 这张卡对应的 mori.approval_request（按请求 id，最多等 5 秒）；没有时为 null。 */
function requestOfCard(ctx, who, requestId) {
  return poll(async () => (await kernelEvents(ctx, who.sessionId, 'mori.approval_request'))
    .map((item) => item.data).find((data) => data.requestId === requestId) ?? null, 5000, 100);
}

/**
 * @brief 回答看得到的那张卡（decide 给出 'allow' 或 'deny'），记下卡与请求。允许之前截图。
 * @return 记下的卡；卡在读之前已经消失时为 null
 */
async function answerOne(ctx, who, decide) {
  const card = await cardOf(ctx, who.tab);
  if (!card) return null;
  const request = await requestOfCard(ctx, who, card.request);
  const choice = decide(request);
  if (choice === 'allow') await shotReal(ctx, `${WORKTREE_DRIVE.name}-card`);
  await answerCard(ctx, who.tab, choice);
  return { request: card.request, uiScope: card.scope, uiReasons: card.reasons, scope: request?.scope ?? null,
    toolCallId: request?.toolCallId ?? null, toolName: request?.toolName ?? card.tool,
    targets: (request?.targets ?? []).map((target) => ({ reason: target.reason, path: target.path })),
    command: request?.args?.command ?? null, choice };
}

/**
 * @brief 等这次运行结束：出卡时按 decide(request) 点 Allow once 或 Deny（记下每张卡），连续 IDLE_MS 空闲时返回。
 * @param deadline 时限（毫秒时刻）；到了还没结束时抛错
 * @return 回答过的卡（answerOne 的结果）
 */
async function settleRun(ctx, who, decide, deadline) {
  const cards = [];
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the run in ${who.tab} did not end within ${RUN_MS / 60000} min`);
    const outcome = await waitCardOrIdle(ctx, who.tab, { timeout: left, stableMs: IDLE_MS });
    if (outcome === 'idle') return cards;
    const answered = await answerOne(ctx, who, decide);
    if (answered) cards.push(answered);
  }
}

/** @brief 会话文件里最后一条有文字的助手消息（写进 note）。 */
function lastReply(file) {
  const texts = readJsonl(file).filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => (Array.isArray(entry.message.content) ? entry.message.content : [])
      .filter((part) => part?.type === 'text').map((part) => part.text).join('').trim()).filter(Boolean);
  return texts.at(-1) ?? '';
}

/** @brief 工具调用的一行（写进 note）：工具名加命令或路径。 */
const callLine = (call) => `${call.name} ${call.args?.command ?? call.args?.path ?? ''}`.trim();

/** @brief 这次运行的请求用了哪些模型（写进 note）：'<provider>/<model> <status>'，去重。 */
function modelsOf(ctx, since, cwd) {
  return [...new Set(realRequests(ctx, { since, cwd }).map((r) => `${r.provider}/${r.model} ${r.status}`))];
}

/**
 * @brief 改与提交的那一轮之后读磁盘：worktree 分支上切出点之后的提交、它们改到的文件、worktree 与主文件夹里的
 *        config.txt、主文件夹的 HEAD。
 */
function editDisk(setup, who) {
  const wtPath = who.worktree.path;
  const commits = Number(gitRun(wtPath, ['rev-list', '--count', `${setup.base}..HEAD`]).stdout.trim()) || 0;
  const files = gitRun(wtPath, ['diff', '--name-only', setup.base, 'HEAD']).stdout.split(/\r?\n/).filter(Boolean);
  return { head: gitRun(wtPath, ['rev-parse', 'HEAD']).stdout.trim(), commits, files,
    committed: commits > 0 && files.includes(WT_FILE), worktreeText: readText(join(wtPath, WT_FILE)),
    mainSame: readText(join(setup.project, WT_FILE)) === WT_BEFORE,
    mainHeadSame: gitRun(setup.project, ['rev-parse', 'HEAD']).stdout.trim() === setup.base };
}

/**
 * @brief 等这个会话（system 里有它的 cwd）向模型发出 since 之后的第一个请求，最多 60 秒；没有时抛错（运行没开始）。
 *        探针的请求不算（它们的 system 里没有项目的路径）。
 */
async function waitAsked(ctx, since, cwd) {
  const asked = await poll(() => realRequests(ctx, { since, cwd }).length > 0, 60000, 200);
  if (!asked) throw new Error(`no model request from the session in ${cwd} within 60 s`);
}

/**
 * @brief 第一轮（发消息时建 worktree）：发 PROMPTS.edit，核对 worktree 会话（createdView；没建成时 Mori 撤回消息、不发
 *        请求，直接返回）；建成时等模型的请求与这一轮结束（出卡一律 Deny：Full access 下工作路径里的改与提交不该出卡），
 *        读磁盘（editDisk）。
 * @return { since, created, cards?, requests?, gates?, disk?, calls?, reply?, models? }
 */
async function editRun(ctx, who, setup) {
  const since = Date.now();
  await sendMessage(ctx, who.tab, PROMPTS.edit);
  const created = await createdView(ctx, who, setup, since);
  if (!created.ok) return { since, created };
  await waitAsked(ctx, since, who.cwd);
  const cards = await settleRun(ctx, who, () => 'deny', since + RUN_MS);
  await shotReal(ctx, `${WORKTREE_DRIVE.name}-edit`);
  const requests = (await kernelEvents(ctx, who.sessionId, 'mori.approval_request', since)).map((item) => item.data);
  const gates = (await gateEvents(ctx, who.sessionId, since)).map((item) => `${item.toolName}:${item.gate}`);
  const calls = toolCallsIn(who.sessionFile);
  return { since, created, cards, requests, uiCards: await cardsSince(ctx, since), gates, disk: editDisk(setup, who),
    calls, reply: lastReply(who.sessionFile), models: modelsOf(ctx, since, who.cwd) };
}

/** @brief 第一轮的前提（随模型）：没走到工作路径外（没有 scope 不是 inside 的卡），有改到 config.txt 的提交。 */
function editUnmet(edit) {
  const outside = edit.cards.filter((card) => card.scope !== 'inside');
  if (outside.length) {
    return `the model left the worktree in the edit run (${outside.length} approval card(s) with scope `
      + `${outside.map((card) => card.scope).join(', ')}, denied)`;
  }
  if (!edit.disk.committed) return `no commit that changes ${WT_FILE} on the worktree branch`;
  return null;
}

/**
 * @brief 合并那一轮的卡怎么答：命令工具、scope outside、每个目标的路径都在这个临时目录里（词法或真实路径）时
 *        'allow'，否则 'deny'（不让模型改临时目录之外的东西）。
 */
function mergeChoice(setup, request) {
  const inRoot = (path) => Boolean(path) && (underPath(path, setup.root) || underPath(path, setup.realRoot));
  const ok = request && SHELLS.has(request.toolName) && request.scope === 'outside' && request.targets.length > 0
    && request.targets.every((target) => inRoot(target.path));
  return ok ? 'allow' : 'deny';
}

/**
 * @brief 合并那一轮的命令里换到 worktree 外跑的（scanCommand 认出的 leave，目录看不出或不在 cwd 里）：路径闸要为它们
 *        出卡（§6.4、§7.7）。
 */
async function leaveCalls(calls, cwd) {
  const kits = await kernelKits();
  return calls.filter((call) => SHELLS.has(call.name) && typeof call.args?.command === 'string').filter((call) => {
    const result = kits.scan.scanCommand({ command: call.args.command, shell: call.name, cwd, vars: varsOf(cwd) });
    return result.ok && result.leaves.some((leave) => leave.dir === null || !kits.gate.insideDir(cwd, leave.dir));
  });
}

/** @brief 合并之后主文件夹的 git：worktree 的提交在不在 HEAD 的历史里，最近几条提交与工作区状态（写进 detail）。 */
function mergedDisk(setup, head) {
  const reachable = Boolean(head) && gitRun(setup.project, ['merge-base', '--is-ancestor', head, 'HEAD']).code === 0;
  return { reachable, log: gitRun(setup.project, ['log', '--oneline', '-5']).stdout.trim().split(/\r?\n/),
    status: gitRun(setup.project, ['status', '--porcelain']).stdout.trim() };
}

/**
 * @brief 第二轮：发 PROMPTS.merge（主文件夹的路径），出卡时按 mergeChoice 答，等结束；找出换到外面跑的命令（leaveCalls）
 *        与它们的批准请求，读主文件夹的 git（mergedDisk）。
 * @return { since, cards, requests, calls, leaves, allowed（有卡被允许）, disk, reply, models }
 */
async function mergeRun(ctx, who, setup, edit) {
  const since = Date.now();
  const before = toolCallsIn(who.sessionFile).length;
  await sendMessage(ctx, who.tab, PROMPTS.merge(bashPath(setup.project)));
  await waitAsked(ctx, since, who.cwd);
  const cards = await settleRun(ctx, who, (request) => mergeChoice(setup, request), since + RUN_MS);
  await shotReal(ctx, `${WORKTREE_DRIVE.name}-merged`);
  const calls = toolCallsIn(who.sessionFile).slice(before);
  const requests = (await kernelEvents(ctx, who.sessionId, 'mori.approval_request', since)).map((item) => item.data);
  return { since, cards, requests, calls, leaves: await leaveCalls(calls, who.cwd),
    allowed: cards.some((card) => card.choice === 'allow'), disk: mergedDisk(setup, edit.disk.head),
    reply: lastReply(who.sessionFile), models: modelsOf(ctx, since, who.cwd) };
}

/** @brief 第二轮的前提（随模型）：在主文件夹跑了命令（有 leave），并且有一张卡可以允许。 */
function mergeUnmet(merge) {
  if (!merge.leaves.length) return 'the model ran no command in the main folder (no leave out of the worktree)';
  const withCard = merge.leaves.filter((call) => merge.requests.some((r) => r.toolCallId === call.id));
  if (withCard.length === merge.leaves.length && !merge.allowed) {
    return 'no card of the merge run could be allowed (a target outside the temp folder or not resolved)';
  }
  return null;
}

/**
 * @brief 一次尝试：新的临时项目与会话，第一轮（editRun），前提满足时第二轮（mergeRun）。worktree 没建成是程序的问题，
 *        不算前提没满足（不重跑，记失败）。
 * @return { setup, edit, merge?, unmet? }
 */
async function worktreeAttempt(ctx) {
  const setup = await wtProject(ctx);
  const who = await openWorktreeTab(ctx, setup);
  const edit = await editRun(ctx, who, setup);
  if (!edit.created.ok) return { setup, edit };
  const unmetEdit = editUnmet(edit);
  if (unmetEdit) return { setup, edit, unmet: unmetEdit };
  const merge = await mergeRun(ctx, who, setup, edit);
  return { setup, edit, merge, unmet: mergeUnmet(merge) };
}

/** @brief 第一轮里模型怎么做的（note）。 */
const editNote = (edit) => ({ commands: edit.calls?.map(callLine).map((line) => briefSafe(line, 300)) ?? [],
  gates: edit.gates ?? [], reply: briefSafe(edit.reply ?? '', 600), models: edit.models ?? [],
  worktreeFile: briefSafe(edit.disk?.worktreeText ?? '', 200) });

/** @brief 第二轮里模型怎么做的（note）。 */
const mergeNote = (merge) => ({ commands: merge.calls.map(callLine).map((line) => briefSafe(line, 300)),
  cards: merge.cards.map((card) => ({ scope: card.scope, choice: card.choice, targets: card.targets })),
  reply: briefSafe(merge.reply, 600), models: merge.models });

/** @brief 记第一条（worktree 会话建好）与第二条（改与提交那一轮不出卡、主文件夹不变）检查。 */
function recordEdit(ctx, take) {
  const { edit } = take;
  ctx.record('FS-113 real worktree-merge: the first message with Worktree on and Full access starts the session in a '
    + 'new worktree <project>\\.mori\\worktrees\\<name> on branch mori/<name> (same session id, SessionInfo.worktree '
    + 'with the project as main folder, Full access kept, the branch in the project\'s repository)', edit.created.ok,
  edit.created, editNote(edit));
  if (!edit.disk?.committed || editUnmet(edit)) return;
  const quiet = edit.cards.length === 0 && edit.requests.length === 0 && edit.uiCards.length === 0;
  ctx.record('FS-113 real worktree-merge: in Full access the run that edited and committed in the worktree showed no '
    + `approval card, and the main folder's ${WT_FILE} and its branch stayed unchanged`,
  quiet && edit.disk.mainSame && edit.disk.mainHeadSame, { cards: edit.cards, requests: edit.requests.length,
    uiCards: edit.uiCards, mainSame: edit.disk.mainSame, mainHeadSame: edit.disk.mainHeadSame,
    commits: edit.disk.commits, files: edit.disk.files, head: edit.disk.head }, editNote(edit));
}

/** @brief 第三条：换到外面跑的命令都有批准卡，第一张 scope outside、原因有 leaves、界面上的卡也是 outside。 */
function recordMergeCard(ctx, merge) {
  const requestOf = (call) => merge.requests.find((r) => r.toolCallId === call.id) ?? null;
  const missing = merge.leaves.filter((call) => !requestOf(call)).map((call) => call.id);
  const first = requestOf(merge.leaves[0]);
  const ui = first ? merge.cards.find((card) => card.request === first.requestId) ?? null : null;
  const ok = missing.length === 0 && first?.scope === 'outside'
    && first.targets.some((target) => target.reason === 'leaves') && ui?.uiScope === 'outside';
  ctx.record('FS-113 real worktree-merge: asked to merge into the main branch, every command that changed directory '
    + 'out of the worktree came with an approval card, and the first card has scope outside with a leaves reason '
    + '(the card in the window shows scope outside)', ok, { leaves: merge.leaves.length, withoutCard: missing,
    first: first ? { scope: first.scope, targets: first.targets.map((t) => ({ reason: t.reason, path: t.path })) }
      : null, uiScope: ui?.uiScope ?? null, uiReasons: ui?.uiReasons ?? null }, mergeNote(merge));
}

/** @brief 记 FS-113 的检查（withAttempts 之后，按最后一次尝试的结果；前提没满足的部分由 withAttempts 记失败）。 */
function recordWorktree(ctx, take) {
  if (!take.edit) return;
  recordEdit(ctx, take);
  const { merge } = take;
  if (!merge?.leaves.length) return;
  recordMergeCard(ctx, merge);
  if (!merge.allowed) return;
  ctx.record('FS-113 real worktree-merge: after Allow once on the merge card the main folder\'s git log has the '
    + 'commit made in the worktree', merge.disk.reachable, { commit: take.edit.disk.head, mainLog: merge.disk.log,
    mainStatus: merge.disk.status }, mergeNote(merge));
}

/**
 * @brief FS-113（§19.2）：真实模型在 worktree 会话里改文件并提交，再合并到主分支（worktreeAttempt），前提没满足时
 *        重跑（withAttempts，最多 3 次），按最后一次的结果记检查（recordWorktree）。
 */
export async function worktreeScenario(ctx) {
  const { take } = await withAttempts(ctx, WORKTREE_DRIVE, () => worktreeAttempt(ctx));
  recordWorktree(ctx, take);
}

// ---------- 步骤 ----------

/**
 * fs-real.mjs 的步骤（createRealContext({ steps }) 的形状）：snapshots（FS-21，不经模型）、worktree-merge（FS-113，
 * 每次尝试两轮真实模型，最多 3 次）、command-corpus（FS-55，不经模型；排在会跑模型的步骤之后，这次运行的会话也算进去）
 */
export const WT_STEPS = Object.freeze([
  { name: 'snapshots', ids: ['FS-21'], run: snapshotsScenario, timeoutMs: 20 * 60 * 1000 },
  { ...WORKTREE_DRIVE, run: worktreeScenario, timeoutMs: 75 * 60 * 1000 },
  { name: 'command-corpus', ids: ['FS-55'], run: commandCorpusScenario, timeoutMs: 15 * 60 * 1000 },
]);
