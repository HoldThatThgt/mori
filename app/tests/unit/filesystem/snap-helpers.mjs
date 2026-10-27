// snapshots.test.mjs 的测试工具（docs/specs/file-system.md §4、§19.1）：内部仓库与快照用真实 git（Git for Windows），
// 在 os.tmpdir() 下很短的临时目录里建 synthetic 的项目。快照模块（snapshots.ts）、Rewind（rewind.ts）、git 的运行
// （git.ts）与 git 状态（workspace.ts）各有一份全局状态（队列、上一张、找到的 git、快照目录），所以把它们打包进同一个
// 结果（esbuild 的 stdin 入口，选项同 tests/unit/load.mjs），每个测试按不同的查询串重新导入，得到一份全新的状态（等于
// 后台进程重启一次）。mori-snapshots 由手写的 pi 接口（synthetic：只记下 on 注册的处理器）驱动，会话用 pi 的
// SessionManager（内存里的或写文件的）；给 rewind.ts 的会话接口同样是手写的（synthetic）。替身 git 进程（synthetic）
// 经 git.ts 的 configureGit 注入，其余调用交给真的 spawn。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { execFile, spawn as realSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleInMemory } from '../load.mjs';
import { REAL_GIT, realGitCandidates } from './real-git.mjs';

/** app/ 目录 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 打包入口：快照（连同它用到的 git 状态）、Rewind、git 与记忆文件（projectDirName）放进同一个结果，共用一份状态 */
const ENTRY = [
  "export * as S from './src/kernel/snapshots.ts';",
  "export * as R from './src/kernel/rewind.ts';",
  "export * as G from './src/kernel/git.ts';",
  "export * as M from './src/kernel/memoryFiles.ts';",
].join('\n');

/** @brief §19.1 注入的小上限：单个文件 1 KB、新文件 20 个、分批 5 条、保留 3 轮（超时保持默认）。 */
export const SMALL_LIMITS = Object.freeze({ maxFileBytes: 1024, maxNewFiles: 20, batch: 5, keepTurns: 3 });

/** @brief 内部仓库的 info/attributes（§4.1 原文）。 */
export const ATTRIBUTES_TEXT = '* -text !eol -filter -ident -working-tree-encoding\n';

/** @brief 隔离的全局配置（§4.1 原文）。 */
export const ISOLATED_CONFIG_TEXT = '[safe]\n\tdirectory = *\n';

/** 打包结果的地址（每个进程只打包一次） */
let bundled = null;
/** 已导入的次数：每次用不同的查询串 */
let imports = 0;

/** @brief 打包一次（tests/unit/load.mjs 的 bundleInMemory：结果在内存里，地址按进程命名）。 */
function bundleUrl() {
  bundled ??= bundleInMemory({ stdin: { contents: ENTRY, resolveDir: appRoot, sourcefile: 'snap-entry.mjs',
    loader: 'js' } }, 'tests_unit_filesystem_snapEntry');
  return bundled;
}

/**
 * @brief 一份全新的内核模块（S 快照、R Rewind、G git、M 记忆文件），设好快照目录与小上限；git --version 由替身回答
 *        （spyGit），其余调用交给真的 spawn。
 * @param snapsDir 快照目录（MORI_SNAPSHOTS_DIR 的作用）
 * @param limits 另外要换的上限
 */
export async function freshKit(snapsDir, limits = {}) {
  const url = await bundleUrl();
  imports += 1;
  const kit = await import(`${url}?fresh=${imports}`);
  kit.G.configureGit({ candidates: realGitCandidates });
  kit.G.setSnapshotsDir(snapsDir);
  kit.S.configureSnapshots({ limits: { ...SMALL_LIMITS, ...limits } });
  spyGit(kit);
  return kit;
}

/**
 * @brief pi 的 SessionManager。按文件路径导入 dist/core/session-manager.js（同 FS-27 按文件路径导入 path-utils.js）：
 *        包的入口会载入整个 pi，本机要三四秒；这个文件连同它用到的不到一秒，类是同一个。
 */
export async function loadSessionManager() {
  const file = join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core',
    'session-manager.js');
  return (await import(pathToFileURL(file).href)).SessionManager;
}

// ---- 临时目录 ----

/**
 * @brief 测试文件的根目录（os.tmpdir() 下，名字很短：内部仓库的路径是快照目录加 projectDirName(cwd)）。
 * @param prefix 目录名前缀
 */
export function tempRoot(prefix) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  return {
    root,
    remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/**
 * @brief 内部仓库目录名（§4.1：同 projectDirName 的编码，测试按规格自己算一遍）：解析后的路径去掉开头的分隔符，
 *        \、/、: 换成 -，前后各加 --。
 * @param cwd 已解析的工作路径
 */
export function encodedName(cwd) {
  return `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** @brief 只算一次的异步准备（几个测试共用同一份 synthetic 的项目与快照）。 */
export function once(fn) {
  let promise = null;
  return () => {
    promise ??= fn();
    return promise;
  };
}

/**
 * @brief 目录里所有名为 .git 的条目（相对 dir，/ 分隔；不进 .git 里面）。
 * @param dir 目录
 */
export function gitEntries(dir) {
  const found = [];
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name === '.git') found.push(rel);
      else if (entry.isDirectory()) walk(join(folder, entry.name), rel);
    }
  };
  walk(dir, '');
  return found.sort();
}

/** 已建的盒子数 */
let boxes = 0;

/**
 * @brief 一个测试的盒子：<root>\b<n>\p 是工作路径（已建），快照目录默认是 <root>\b<n>\s。
 * @param root tempRoot 的根目录
 * @param snaps 几个测试共用的快照目录（共用一份内核模块时）；省略时用盒子自己的
 */
export function newBox(root, snaps = null) {
  boxes += 1;
  const dir = join(root, `b${boxes}`);
  const cwd = join(dir, 'p');
  mkdirSync(cwd, { recursive: true });
  return { dir, snaps: snaps ?? join(dir, 's'), cwd };
}

/**
 * @brief 写一个文件（需要时建上级目录）。
 * @param base 目录
 * @param rel 相对路径（/ 分隔）
 * @param content 内容（字符串或 Buffer）
 */
export function put(base, rel, content) {
  const file = join(base, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

// ---- 测试自己的 git（准备与检查；不经 Mori） ----

/** @brief 去掉 GIT_* 的环境副本（同 git.ts 的做法，测试的准备不受父进程的 GIT_DIR 等影响）。 */
function cleanEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value;
  }
  return env;
}

/** 测试准备用的固定 -c：不转换换行、固定的身份、不签名、允许 file 协议的子模块 */
const SETUP_ARGS = ['-c', 'core.autocrlf=false', '-c', 'user.name=Mori Test', '-c', 'user.email=test@localhost',
  '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main'];

/**
 * @brief 跑一次 git（测试的准备与检查，不经 shell）；失败时抛错。
 * @param cwd 工作目录
 * @param args 参数
 * @param options allowFail：失败时返回结果而不抛错；input：写进 stdin 的内容
 * @return { code, stdout (Buffer), stderr }
 */
export function git(cwd, args, options = {}) {
  return new Promise((done, fail) => {
    const child = execFile(REAL_GIT, [...SETUP_ARGS, ...args], { cwd, env: cleanEnv(), encoding: 'buffer',
      windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const result = { code: error ? (error.code ?? 1) : 0, stdout, stderr: stderr.toString('utf8') };
      if (error && !options.allowFail) fail(new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`));
      else done(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

/** @brief git 的文字输出（去掉结尾的换行）。 */
export async function gitText(cwd, args) {
  return (await git(cwd, args)).stdout.toString('utf8').trimEnd();
}

/**
 * @brief 建一个仓库并提交里面已有的全部文件（有文件时）。
 * @param dir 目录（已有）
 * @param options template：给 git init 的 --template（'' 时不复制模板，.git 很小）
 */
export async function initRepo(dir, options = {}) {
  const template = options.template === undefined ? [] : [`--template=${options.template}`];
  await git(dir, ['init', '--quiet', ...template]);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
}

/** @brief NUL 分隔的输出拆成列表。 */
export function nulSplit(stdout) {
  return stdout.toString('utf8').split('\0').filter((item) => item !== '');
}

/**
 * @brief 测试自己的 git 对内部仓库只碰 ref 与对象时的前缀（同 snapshots.ts 的 refsOnly）：--work-tree 也给内部仓库的
 *        目录。Mori 带 --work-tree 跑的 git init 在内部仓库的 config 里记下 core.worktree，工作路径或它上面的文件夹
 *        已经不在时只给 --git-dir 的调用报 Invalid path。
 * @param repo 内部仓库目录
 */
function onRepo(repo) {
  return [`--git-dir=${repo}`, `--work-tree=${repo}`];
}

/**
 * @brief 一张快照的树里的条目（测试自己的 git，--git-dir 指向内部仓库）。
 * @param repo 内部仓库目录
 * @param oid 快照的提交
 * @return [{ mode, id, path }]，按树的顺序；id 是对象 id
 */
export async function treeOf(repo, oid) {
  const result = await git(repo, [...onRepo(repo), '-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', oid]);
  return nulSplit(result.stdout).map((item) => {
    const tab = item.indexOf('\t');
    const [mode, , id] = item.slice(0, tab).split(' ');
    return { mode, id, path: item.slice(tab + 1) };
  });
}

/** @brief 一张快照的树里的路径，排好序。 */
export async function pathsOf(repo, oid) {
  return (await treeOf(repo, oid)).map((item) => item.path).sort();
}

/**
 * @brief 按字节存下这些内容时 git 给的 blob id（sha1("blob <长度>\0" + 字节)）：树里的 id 等于它，就是原样存的字节，
 *        不用再起 git 读出来比。
 * @param content 字符串（UTF-8）或 Buffer
 */
export function blobId(content) {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** @brief 内部仓库的 refs/mori/ 下的全部 ref 名。 */
export async function moriRefs(repo) {
  const text = await gitText(repo, [...onRepo(repo), 'for-each-ref', '--format=%(refname)', 'refs/mori/']);
  return text === '' ? [] : text.split('\n');
}

/** @brief 内部仓库里这个对象在不在。 */
export async function hasObject(repo, oid) {
  return (await git(repo, [...onRepo(repo), 'cat-file', '-e', oid], { allowFail: true })).code === 0;
}

/** @brief 内部仓库里的全部对象（没有对象时为空）。 */
export async function allObjects(repo) {
  const text = await gitText(repo, [...onRepo(repo), 'cat-file', '--batch-all-objects',
    '--batch-check=%(objectname)']);
  return text === '' ? [] : text.split('\n');
}

/** @brief 往内部仓库里写一个谁都不引用的对象（git prune 会删掉它）。 */
export async function strayObject(repo, text) {
  const result = await git(repo, [...onRepo(repo), 'hash-object', '-w', '--stdin'], { input: text });
  return result.stdout.toString('utf8').trim();
}

/**
 * @brief 上一次后台进程留下的内部仓库（测试自己的 git 照 Mori 的方式建：带 --git-dir、--work-tree 跑 git init），
 *        写上 mori.json 与 info/attributes。
 * @param box newBox 的结果
 * @param attributes info/attributes 的内容；null 时没有这个文件
 * @return 内部仓库目录
 */
export async function oldRepo(box, attributes = ATTRIBUTES_TEXT) {
  const repo = join(box.snaps, encodedName(box.cwd));
  mkdirSync(repo, { recursive: true });
  await git(box.cwd, [`--git-dir=${repo}`, `--work-tree=${box.cwd}`, 'init', '--quiet']);
  writeFileSync(join(repo, 'mori.json'), `${JSON.stringify({ cwd: box.cwd })}\n`);
  if (attributes === null) rmSync(join(repo, 'info', 'attributes'), { force: true });
  else put(repo, 'info/attributes', attributes);
  return repo;
}

/** @brief 内部仓库 index 里的路径（排好序）。 */
export async function indexOf(repo, cwd) {
  const args = [`--git-dir=${repo}`, `--work-tree=${cwd}`, '-c', 'core.quotepath=false', 'ls-files', '-z'];
  return nulSplit((await git(cwd, args)).stdout).sort();
}

// ---- 驱动快照模块 ----

/**
 * @brief 在这个工作路径的队列里拍一张（rewind.ts 的用法：inQueue 里 takeSnapshot）。
 * @param kit freshKit 的结果
 * @param cwd 工作路径
 */
export function shoot(kit, cwd) {
  return kit.S.inQueue(cwd, () => kit.S.takeSnapshot(cwd, null));
}

/** @brief 等已排好的微任务与回调跑完。 */
export const settle = () => new Promise((done) => setImmediate(done));

/**
 * @brief 手写的 pi 接口（synthetic）：snapshotExtension 的工厂在它上面 on 注册处理器，fire 按名字调用。
 * @param factory snapshotExtension(source) 的结果
 */
export function fakePi(factory) {
  const handlers = new Map();
  factory({ on: (name, handler) => handlers.set(name, handler) });
  return {
    handlers,
    fire: async (name, event, ctx) => handlers.get(name)?.({ type: name, ...event }, ctx),
  };
}

/**
 * @brief 登记一个用户会话并给它装上 mori-snapshots（self：用户会话自己的运行；Agent 为基座 Mori）。
 * @param kit freshKit 的结果
 * @param options sessionId、cwd、sessionManager、headless、self、agent
 * @return { user, ext, events }：events 记下 emit 的事件
 */
export function snapUser(kit, options) {
  const events = [];
  const user = { sessionId: options.sessionId, cwd: options.cwd, sessionManager: options.sessionManager,
    headless: options.headless ?? false, emit: (event) => events.push(event) };
  kit.S.registerSnapshotUser(user);
  const agent = options.agent ?? { role: 'Mori', task: null, self: options.self ?? true };
  const ext = fakePi(kit.S.snapshotExtension({ userSessionId: options.sessionId, self: options.self ?? true,
    headless: user.headless, agent: () => agent }));
  return { user, ext, events };
}

/** @brief 一条你的消息（pi 的 user 消息）。 */
export function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

/**
 * @brief 开始一次运行：before_agent_start（等开始快照做完）、写下起始消息、agent_start。
 * @param handle snapUser 的结果
 * @param text 起始消息（null 时不写消息，messageType 为 custom）
 * @param ctx 处理器的 ctx；省略时用会话的 cwd 与 SessionManager
 */
export async function startRun(handle, text, ctx = undefined) {
  const runCtx = ctx ?? { cwd: handle.user.cwd, sessionManager: handle.user.sessionManager };
  const messageType = text === null ? 'custom' : 'user';
  await handle.ext.fire('before_agent_start', { messageType, prompt: text ?? '' }, runCtx);
  if (text !== null) runCtx.sessionManager.appendMessage(userMessage(text));
  await handle.ext.fire('agent_start', {}, runCtx);
  return runCtx;
}

/**
 * @brief 结束一次运行：agent_settled（只排结束快照），再等这份内核模块的所有队列做完。
 * @param kit freshKit 的结果
 * @param handle snapUser 的结果
 * @param runCtx startRun 返回的 ctx
 */
export async function endRun(kit, handle, runCtx) {
  await handle.ext.fire('agent_settled', {}, runCtx);
  await kit.S.drainSnapshots();
  await settle();
}

/**
 * @brief 给 rewind.ts 的会话接口（synthetic）：会话不忙、没有开着的需求、消息没有引用；只恢复代码的 Rewind 不移动对话，
 *        所以 navigateTree 被调用时抛错；emit 的事件记进 handle.events。
 * @param handle snapUser 的结果
 */
export function rewindSession(handle) {
  const { user } = handle;
  return {
    sessionId: user.sessionId, cwd: user.cwd, sessionManager: user.sessionManager,
    navigateTree: async () => {
      throw new Error('navigateTree is not expected in a code-only rewind');
    },
    busy: () => false, openRequests: () => [], recordPick: () => undefined, refsOf: () => null,
    emit: (event) => handle.events.push(event),
  };
}

/** @brief 会话条目里的 mori.turn_changes 记录（按先后）。 */
export function turnRecords(sessionManager) {
  return sessionManager.getEntries()
    .filter((entry) => entry.type === 'custom' && entry.customType === 'mori.turn_changes')
    .map((entry) => entry.data);
}

// ---- 替身 git 进程（synthetic） ----

/**
 * @brief 一个替身 git 进程（synthetic）：没有 pid（git.ts 的 killTree 只 child.kill()），按 script 发 stdout、stderr
 *        再以 code 结束；hang 为真时一直不结束，直到 kill()。
 * @param script { stdout?: Buffer, stderr?: string, code?: number, hang?: boolean }
 */
export function stubChild(script) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: () => undefined, end: () => undefined };
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  let closed = false;
  const close = (code) => {
    if (closed) return;
    closed = true;
    child.emit('close', code);
  };
  child.kill = () => {
    child.killed = true;
    setImmediate(() => close(null));
    return true;
  };
  setImmediate(() => {
    if (script.stdout) child.stdout.emit('data', script.stdout);
    if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
    if (!script.hang) setImmediate(() => close(script.code ?? 0));
  });
  return child;
}

/**
 * git --version 的替身输出（synthetic）：找 git（§3.2）不在这个文件的验收里（FS-01、FS-02 的单元测试用真的 git 测它），
 * 每份内核模块都要找一次，本机起 git 进程慢，所以由替身回答
 */
const VERSION_SCRIPT = Object.freeze({ stdout: Buffer.from('git version 2.55.0.windows.1\n'), code: 0 });

/**
 * @brief 换上记录调用的 spawn（经 configureGit）：git --version 由替身回答（不记）；其余调用的参数记进 calls，
 *        stand(args) 返回替身脚本时起替身，返回 null 时交给真的 spawn。configureGit 让下一次调用重新找 git。
 * @param kit freshKit 的结果
 * @param stand (args, options) => 替身脚本或 null
 * @return { calls, spawned }：spawned 记下起了替身的调用（参数）
 */
export function spyGit(kit, stand = () => null) {
  const calls = [];
  const spawned = [];
  kit.G.configureGit({
    spawn: (command, args, options) => {
      if (args.length === 1 && args[0] === '--version') return stubChild(VERSION_SCRIPT);
      calls.push(args);
      const script = stand(args, options);
      if (script === null) return realSpawn(command, args, options);
      spawned.push(args);
      return stubChild(script);
    },
  });
  return { calls, spawned };
}

/** @brief 这是内部仓库的调用（以 --git-dir= 开头）。 */
export function internalCall(args) {
  return args[0]?.startsWith('--git-dir=') ?? false;
}

/** @brief 内部仓库调用的子命令（跳过固定前缀与 -c、--literal-pathspecs 等全局选项）。 */
export function subcommandOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') i += 1;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return '';
}
