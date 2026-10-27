// Rewind 单元测试（rewind.test.mjs）共用的工具（docs/specs/file-system.md §5.5–§5.11、§19.1）：
// - 把 rewind.ts、snapshots.ts、git.ts、workspace.ts、sessionWorkspace.ts 打成一个包（同一份模块状态：快照队列、时间线、
//   正在 Rewind 的会话），用真实 git、临时目录里 synthetic 的项目；快照目录在临时目录里，上限按 §19.1 注入很小的值；
// - git 的 spawn 换成转给 node:child_process 的包装（configureGit），测试经钩子在某一步之前做事（锁住文件、在恢复中途
//   写文件、让下一次 git add 失败），按 --work-tree 分到各自的工作路径，几个场景可以并行；
// - 用户会话是替身（synthetic）：pi 的内存 SessionManager 存消息，mori-snapshots 注册在一个只记处理函数的假 pi 上，
//   一轮 = before_agent_start、写下你的消息、agent_start、改文件、写下回复、agent_settled，记录由真实的快照写下
//   （个别用例的记录是手写的，提交仍是 snapshotNow 拍的真实快照）；
//   RewindSession 的 navigateTree 照 pi 的 navigateTree 移动叶子（不带 summarize），busy、openRequests、recordPick、
//   refsOf、emit 由测试控制、记下调用。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { build } from 'esbuild';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REAL_GIT, realGitCandidates } from './real-git.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * pi 1.3.0 的 SessionManager（版本锁定）：直接载入它所在的模块文件。从包根载入要把整个 pi 都载进来（本机约 2 秒，
 * 这个文件的用例不需要别的部分），这个模块约 0.6 秒；类是同一个，打包的内核模块运行时不载入 pi。loadRewind 时与打包同时载入
 */
const SESSION_MANAGER = join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core',
  'session-manager.js');
const outDir = join(appRoot, 'test-results', 'unit-bundles');

/** pi 的 SessionManager 类（loadRewind 载入后才有） */
let SessionManager = null;

/** 打进一个包的模块（同一份模块状态） */
const MODULES = {
  rewind: 'src/kernel/rewind.ts',
  snapshots: 'src/kernel/snapshots.ts',
  git: 'src/kernel/git.ts',
  workspace: 'src/kernel/workspace.ts',
  sw: 'src/kernel/sessionWorkspace.ts',
};

/** @brief §19.1 注入的小上限：单个文件 1 KB、新文件 20 个、每批 5 条、保留 3 轮。 */
export const SMALL_LIMITS = Object.freeze({ maxFileBytes: 1024, maxNewFiles: 20, batch: 5, keepTurns: 3 });

/** @brief 让 git add 失败的参数（synthetic）：git 报 unknown option。 */
export const BAD_OPTION = '--mori-synthetic-bad-option';

/** @brief 上面那个参数让 git 打出的原文（gitError 去掉 error: 之后）。 */
export const BAD_OPTION_ERROR = 'unknown option `mori-synthetic-bad-option\'';

/** @brief libuv 在 Windows 上的 UV_FS_O_EXLOCK：共享方式为 0 打开（别的句柄读写删都不行）。 */
const EXCLUSIVE_LOCK = 0x10000000;

/** @brief 测试提交用的身份与选项（只用于 synthetic 的用户仓库）。 */
const IDENTITY = ['-c', 'user.name=Mori Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false'];

// ---- 打包与设置 ----

/** @brief 打包并导入 MODULES（一个包，共用模块状态）。 */
async function loadBundle() {
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `rewind-bundle.${process.pid}.mjs`);
  const contents = Object.entries(MODULES)
    .map(([name, path]) => `export * as ${name} from ${JSON.stringify(`./${path}`)};`).join('\n');
  await build({
    stdin: { contents, resolveDir: appRoot, sourcefile: 'rewind-entry.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', outfile,
    logLevel: 'silent',
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
}

/**
 * @brief 打包导入内核模块，同时载入 pi 的 SessionManager。
 * @return { rewind, snapshots, git, workspace, sw }
 */
export async function loadRewind() {
  const [bundle, pi] = await Promise.all([loadBundle(), import(pathToFileURL(SESSION_MANAGER).href)]);
  SessionManager = pi.SessionManager;
  return bundle;
}

/** 正在生效的 git 钩子：每个收到参数，返回换过的参数或 undefined（不换） */
const gitHooks = new Set();

/** @brief 换进 git.ts 的 spawn：先过一遍钩子，再交给 node:child_process 的 spawn。 */
function hookedSpawn(command, args, options) {
  let next = [...args];
  for (const hook of [...gitHooks]) next = hook(next) ?? next;
  return nodeSpawn(command, next, options);
}

/**
 * @brief 设好快照目录、小上限与带钩子的 spawn（在任何 git 调用之前调用一次）。
 * @param K loadRewind 的结果
 * @param snaps 快照目录（临时目录里，短）
 */
export function setupRewind(K, snaps) {
  K.git.configureGit({ spawn: hookedSpawn, candidates: realGitCandidates });
  K.git.setSnapshotsDir(snaps);
  K.snapshots.configureSnapshots({ limits: { ...SMALL_LIMITS } });
}

// ---- git 钩子 ----

/** @brief 这次调用是不是这个工作路径上内部仓库的某个子命令（--work-tree 为它，参数里有这个词）。 */
function callOf(args, cwd, word) {
  return args.includes(`--work-tree=${cwd}`) && args.includes(word);
}

/**
 * @brief 这个工作路径上内部仓库的下一次 word 调用（restore、add …）起进程之前做一次 action。
 * @param cwd 工作路径
 * @param word 子命令
 * @param action 收到参数，可以返回换过的参数
 */
export function beforeNext(cwd, word, action) {
  const hook = (args) => {
    if (!callOf(args, cwd, word)) return undefined;
    gitHooks.delete(hook);
    return action(args);
  };
  gitHooks.add(hook);
  return () => gitHooks.delete(hook);
}

/** @brief 这个工作路径上内部仓库的下一次 git add 加上 BAD_OPTION（这一张快照失败）。 */
export function failNextAdd(cwd) {
  return beforeNext(cwd, 'add', (args) => {
    const at = args.indexOf('add');
    return [...args.slice(0, at + 1), BAD_OPTION, ...args.slice(at + 1)];
  });
}

/**
 * @brief 用独占的句柄锁住一个文件（Windows：共享方式 0，别的进程读、写、删都失败）。
 * @return 关闭句柄的函数（只关一次）
 */
export function lockFile(path) {
  const fd = openSync(path, constants.O_RDWR | EXCLUSIVE_LOCK);
  let open = true;
  return () => {
    if (open) closeSync(fd);
    open = false;
  };
}

// ---- 临时目录与文件 ----

/** @brief 删掉一个目录；还有进程占着（例如刚结束的 git）时隔 100 毫秒再试，最多 30 次。 */
async function removeDir(root) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 30) throw error;
      await delay(100);
    }
  }
}

/** @brief 一个临时根目录（os.tmpdir 下，名字短）；remove 带重试。 */
export function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, remove: () => removeDir(root) };
}

/**
 * @brief 在 root 下建一个 synthetic 的项目文件夹并写进文件。
 * @param root 临时根目录
 * @param name 文件夹名（短）
 * @param files { 相对路径: 内容 }
 * @return 工作路径（解析后的绝对路径）
 */
export function project(root, name, files) {
  const cwd = resolve(root, name);
  mkdirSync(cwd, { recursive: true });
  for (const [path, text] of Object.entries(files)) put(cwd, path, text);
  return cwd;
}

/** @brief 写一个文件（需要时建上级目录）。 */
export function put(cwd, path, text) {
  const file = join(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** @brief 删一个文件或目录（递归）。 */
export function drop(cwd, path) {
  rmSync(join(cwd, path), { recursive: true, force: true });
}

/** @brief 文件的内容；不在或不是文件时为 null。 */
export function content(cwd, path) {
  try {
    return readFileSync(join(cwd, path), 'utf8');
  } catch {
    return null;
  }
}

/** @brief 几个文件此刻的内容 { 路径: 内容或 null }。 */
export function contents(cwd, paths) {
  return Object.fromEntries(paths.map((path) => [path, content(cwd, path)]));
}

/** @brief 目录里的名字（按磁盘上的大小写），排好序。 */
export function names(cwd, dir = '.') {
  return readdirSync(join(cwd, dir)).sort();
}

/** @brief 路径在不在（文件或目录）。 */
export function present(cwd, path) {
  return existsSync(join(cwd, path));
}

// ---- 你的仓库与内部仓库 ----

/** @brief process.env 的副本，去掉 GIT_ 开头的变量。 */
function plainEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
}

/**
 * @brief 跑一次 git（异步，不挡住并行的场景）。
 * @param cwd 进程的工作目录；省略时为当前目录
 * @param args 参数
 * @return { code, stdout, stderr }
 */
function gitRun(cwd, args) {
  return new Promise((done) => {
    execFile(REAL_GIT, args, { cwd, encoding: 'utf8', env: plainEnv(), windowsHide: true }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    });
  });
}

/**
 * @brief 跑一次 git；失败时抛出带 stderr 的错误。
 * @param cwd 进程的工作目录
 * @param args 参数
 * @return stdout（去掉首尾空白）
 */
export async function sh(cwd, args) {
  const result = await gitRun(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** @brief 把工作路径变成 synthetic 的 git 仓库（分支 main，一次提交）。 */
export async function initUserRepo(cwd) {
  await sh(cwd, ['init', '-q', '-b', 'main']);
  await sh(cwd, ['add', '-A']);
  await sh(cwd, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', 'synthetic initial commit']);
}

/** @brief 你的仓库此刻的 HEAD、分支、index 与暂存的改动（Rewind 前后比较；三个只读的 git 并行）。 */
export async function repoState(cwd) {
  const [heads, index, staged] = await Promise.all([['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
    ['ls-files', '-s'], ['diff', '--cached', '--name-status']].map((args) => sh(cwd, args)));
  const [head, branch] = heads.split(/\r?\n/);
  return { head, branch, index, staged };
}

/** @brief 对内部仓库跑一次 git（只碰 ref 与对象）。 */
function repoGit(K, cwd, args) {
  return gitRun(undefined, [`--git-dir=${K.snapshots.snapshotRepo(cwd)}`, ...args]);
}

/** @brief 内部仓库里这个前缀下的 ref 名。 */
export async function internalRefs(K, cwd, prefix) {
  const result = await repoGit(K, cwd, ['for-each-ref', '--format=%(refname)', prefix]);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').sort();
}

/** @brief 内部仓库里有没有这个提交（git cat-file -e）。 */
export async function commitExists(K, cwd, oid) {
  return (await repoGit(K, cwd, ['cat-file', '-e', `${oid}^{commit}`])).code === 0;
}

/**
 * @brief 在这个工作路径的队列里拍一张（同 Rewind 的保险快照；不在任何运行里，不写记录）；没拍成时抛错。
 * @return 这一张的提交
 */
export async function snapshotNow(K, cwd) {
  const shot = await K.snapshots.inQueue(cwd, () => K.snapshots.takeSnapshot(cwd, null));
  if (!('oid' in shot)) throw new Error(`snapshot failed in ${cwd}: ${shot.error}`);
  return shot.oid;
}

/** @brief 在内部仓库里给一轮的提交建 ref（同快照模块，refs/mori/s/<会话 id>/<轮>/<提交>）；失败时抛错。 */
export async function keepRoundRefs(K, user, round, commits) {
  const error = await K.snapshots.inQueue(user.cwd,
    () => K.snapshots.keepRefs(user.cwd, user.sessionId, round, commits));
  if (error !== null) throw new Error(`keeping the refs of ${round} failed: ${error}`);
}

/** @brief 删掉内部仓库里的一个 ref（git update-ref -d，做出被整理的轮）。 */
export async function deleteRef(K, cwd, ref) {
  const result = await repoGit(K, cwd, ['update-ref', '-d', ref]);
  if (result.code !== 0) throw new Error(`git update-ref -d ${ref} failed: ${result.stderr}`);
}

// ---- 会话替身（synthetic） ----

/** @brief 一条你的消息（pi 的 user 消息）。 */
export function userMessage(text) {
  return { role: 'user', content: text, timestamp: Date.now() };
}

/** @brief 一条回复（pi 的 assistant 消息，synthetic 的模型字段）。 */
export function assistantMessage(text) {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'synthetic', provider: 'synthetic', model: 'synthetic',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

/** @brief 正文的文字（同 pi 的 contentText：字符串原样，数组取 text 块拼接）。 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

/**
 * @brief 照 pi 1.3.0 的 AgentSession.navigateTree（不带 summarize）移动叶子：目标是当前叶子时什么都不做；
 *        user 消息、custom_message → 叶子到它的父条目（没有时回到根）并给出它的文字；其他条目 → 叶子到它。
 * @param manager 会话的 SessionManager
 * @param targetId 目标条目
 */
export function piNavigate(manager, targetId) {
  if (targetId === manager.getLeafId()) return { cancelled: false };
  const target = manager.getEntry(targetId);
  if (!target) throw new Error(`Entry ${targetId} not found`);
  const back = target.type === 'custom_message' || (target.type === 'message' && target.message.role === 'user');
  const leaf = back ? target.parentId : targetId;
  if (leaf === null) manager.resetLeaf();
  else manager.branch(leaf);
  if (!back) return { cancelled: false };
  const body = target.type === 'custom_message' ? target.content : target.message.content;
  return { cancelled: false, editorText: textOf(body) };
}

/** @brief 由用户会话替身建出 rewind.ts 的 RewindSession（记下导航与 recordPick 的调用）。 */
function rewindSessionOf(user) {
  return {
    sessionId: user.sessionId, cwd: user.cwd, sessionManager: user.manager,
    navigateTree: async (targetId) => {
      user.navigations.push(targetId);
      return user.navigate ? user.navigate(targetId) : piNavigate(user.manager, targetId);
    },
    busy: () => user.busy,
    openRequests: () => [...user.requests],
    recordPick: () => {
      user.picks += 1;
      user.manager.appendCustomEntry('mori.pick', { pick: user.pick });
    },
    refsOf: (entryId) => user.refs.get(entryId) ?? null,
    emit: (event) => user.events.push(event),
  };
}

/**
 * @brief 打开一个用户会话替身：在快照模块里登记，mori-snapshots 注册在假 pi 上（用户会话自己的运行，基座 mori）。
 * @param K loadRewind 的结果
 * @param cwd 工作路径
 * @return 会话替身：session 是给 rewind.ts 的 RewindSession；navigate 可换成测试的导航；busy、requests、refs、pick 可改
 */
export function openUser(K, cwd) {
  const manager = SessionManager.inMemory(cwd);
  const sessionId = manager.getSessionId();
  const user = {
    sessionId, cwd, manager, events: [], navigations: [], picks: 0, pick: 'A', busy: false, requests: [],
    refs: new Map(), navigate: null, handlers: new Map(),
  };
  const emit = (event) => user.events.push(event);
  K.snapshots.registerSnapshotUser({ sessionId, cwd, sessionManager: manager, emit, headless: false });
  const pi = { on: (name, fn) => user.handlers.set(name, [...(user.handlers.get(name) ?? []), fn]) };
  const agent = { role: 'mori', task: null, self: true };
  K.snapshots.snapshotExtension({ userSessionId: sessionId, self: true, headless: false, agent: () => agent })(pi);
  user.session = rewindSessionOf(user);
  return user;
}

/** @brief 依次 await 假 pi 上这个事件的处理函数（同 pi 的扩展执行）。 */
async function fire(user, name, event) {
  const ctx = { cwd: user.cwd, sessionManager: user.manager };
  for (const fn of user.handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx);
}

/**
 * @brief 一次运行开始（由你的消息开始）：before_agent_start 等开始快照做完，写下你的消息，agent_start。
 * @return 你的消息的条目 id
 */
export async function beginTurn(user, text) {
  await fire(user, 'before_agent_start', { prompt: text, messageType: 'user' });
  const id = user.manager.appendMessage(userMessage(text));
  await fire(user, 'agent_start', {});
  return id;
}

/** @brief 一次运行结束：写下回复、agent_settled，再等这个工作路径的队列做完结束快照。 */
export async function endTurn(K, user) {
  user.manager.appendMessage(assistantMessage('Done.'));
  await fire(user, 'agent_settled', {});
  await K.snapshots.inQueue(user.cwd, async () => undefined);
}

/**
 * @brief 完整的一轮：开始、change() 改文件、结束。
 * @return 你的消息的条目 id
 */
export async function turn(K, user, text, change) {
  const id = await beginTurn(user, text);
  await change();
  await endTurn(K, user);
  return id;
}

/** @brief 会话里（全部条目，文件顺序）某种自定义条目：{ id, parentId, data }。 */
export function customEntries(user, customType) {
  return user.manager.getEntries()
    .filter((entry) => entry.type === 'custom' && entry.customType === customType)
    .map((entry) => ({ id: entry.id, parentId: entry.parentId, data: entry.data }));
}

/** @brief 一组条目的简短写法：message 为 role，custom 为 customType。 */
export function shapes(entries) {
  return entries.map((entry) => (entry.type === 'message' ? entry.message.role : entry.customType ?? entry.type));
}

/** @brief 等一个可能失败的调用：{ ok: true, value } 或 { ok: false, error: 原文 }。 */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** @brief 立刻开始一个场景；先挂上空的 catch，测试 await 时照样拿到失败。 */
export function start(fn) {
  const run = fn();
  run.catch(() => undefined);
  return run;
}
