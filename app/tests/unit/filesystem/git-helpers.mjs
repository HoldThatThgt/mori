// git 单元测试（docs/specs/file-system.md §3.2–§3.5，验收 FS-01–FS-05）共用的帮助函数：
// 把几个内核模块打进同一个包（workspace.ts 与 git.ts 共用一份模块状态，configureGit 才对 readStatus 生效）、
// 替身 git 进程（synthetic：注入 configureGit 的 spawn，按调用给出 stdout、stderr、退出码，或一直不结束）、
// 真实 git 的临时仓库（synthetic 的项目，短路径放在 os.tmpdir() 下；准备数据的 git 是异步的，并行的用例真的同时跑）、
// pi 的 SessionManager、改 process.env 并恢复、截下日志、等条件成立。

import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = join(appRoot, 'test-results', 'unit-bundles');

/** Git for Windows 的启动器（§3.2 第 1 步的第二个候选；真正干活的 git 是它的子进程） */
export const PROGRAM_FILES_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
/** 替身 git 的路径（synthetic，不存在；只给注入的 candidates 与 exists 用） */
export const FAKE_GIT = 'C:\\mori-test\\fake\\git.exe';
/** 替身 git 报的版本 */
export const FAKE_VERSION = 'git version 2.55.0.windows.1\n';
/** 内部仓库的 5 个 -c（§3.3），按顺序 */
export const FIVE_C = [
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.longpaths=true',
  '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false',
];
/** 隔离的全局配置的内容（§17） */
export const ISOLATED_CONFIG = '[safe]\n\tdirectory = *\n';
/**
 * pi 1.3.0 的 SessionManager 所在的模块文件（版本锁定）：只载入它（约 0.6 秒），不载入整个 pi（约 2 秒）；
 * 类是同一个，打包的内核模块运行时不载入 pi（同 rewind-helpers.mjs 的做法）
 */
const SESSION_MANAGER = join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core',
  'session-manager.js');

/**
 * @brief 把几个内核模块打进同一个 ESM 包再导入（同 tests/unit/load.mjs 的做法，入口是内存里的一段 re-export）：
 *        包里每个源文件只有一份，所以 git.ts 的 configureGit 对同一个包里的 workspace.ts 生效。
 * @param modules { 名字: 相对 app/ 的源文件 }，例如 { git: 'src/kernel/git.ts' }
 * @return { 名字: 模块的导出 }
 */
export async function loadKernelBundle(modules) {
  mkdirSync(outDir, { recursive: true });
  const names = Object.keys(modules);
  const contents = names.map((name) => `export * as ${name} from ${JSON.stringify(`./${modules[name]}`)};`).join('\n');
  const outfile = join(outDir, `fs-git-${names.join('-')}.${process.pid}.mjs`);
  await build({
    stdin: { contents, resolveDir: appRoot, sourcefile: 'fs-git-entry.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', outfile, logLevel: 'silent',
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
}

/** @brief 是不是一个存在的文件（真实的 exists，注入 configureGit 时用）。 */
export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * @brief 本机 Git for Windows 的启动器 <安装目录>\cmd\git.exe：Program Files 的那个，不在时从 PATH 里的 git.exe 往上推
 *        （装在别处时，例如负责人机器上的 D:\Git；2026-10-27 合并时补）。FS-02 结束进程树的用例要的正是启动器。
 * @return 找不到时抛出
 */
export function launcherGit() {
  const dirs = (process.env.PATH ?? '').split(';').filter((dir) => dir !== '' && isFile(win32.join(dir, 'git.exe')));
  const roots = dirs.flatMap((dir) => [win32.dirname(dir), win32.dirname(win32.dirname(dir))]);
  const found = [PROGRAM_FILES_GIT, ...roots.map((root) => win32.join(root, 'cmd', 'git.exe'))].find(isFile);
  if (found === undefined) throw new Error('These tests need Git for Windows.');
  return found;
}

/** @brief 本机的真实 git：Program Files 的启动器，没有时用 PATH 里第一个 git.exe。 */
export function realGitPath() {
  if (isFile(PROGRAM_FILES_GIT)) return PROGRAM_FILES_GIT;
  const dirs = (process.env.PATH ?? '').split(';').filter((dir) => dir !== '');
  const found = dirs.map((dir) => win32.join(dir, 'git.exe')).find(isFile);
  if (found === undefined) throw new Error('These tests need Git for Windows.');
  return found;
}

/**
 * @brief 短的临时目录（synthetic 的项目）：取真实路径，内部仓库路径 = 快照目录 + 工作路径编码，要离 git 的路径上限远。
 * @param prefix 目录名前缀（短）
 */
export function tempRoot(prefix) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  return { root, remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/**
 * @brief 设几个环境变量（值为 undefined 时删掉），返回恢复函数。Windows 的 process.env 不分大小写，按给的名字存取。
 * @param vars { 名字: 值 }
 */
export function setEnv(vars) {
  const saved = Object.keys(vars).map((name) => [name, Object.hasOwn(process.env, name), process.env[name]]);
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, had, value] of saved.reverse()) {
      if (had) process.env[name] = value;
      else delete process.env[name];
    }
  };
}

/**
 * @brief 测试用的全局 git 配置：HOME、USERPROFILE 指到 <root>\home（被测代码对用户仓库的调用继承它），
 *        写身份、默认分支 main、core.autocrlf=false，不读你自己的全局配置。
 * @param root 临时目录
 * @return 恢复环境变量的函数
 */
export function testHome(root) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'),
    '[user]\n\tname = Mori Test\n\temail = test@localhost\n[init]\n\tdefaultBranch = main\n'
    + '[core]\n\tautocrlf = false\n[advice]\n\tdetachedHead = false\n');
  return setEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: undefined });
}

/** @brief 帮助函数自己跑 git 时的环境：process.env 去掉 GIT_*。 */
function helperEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value;
  }
  return env;
}

/**
 * @brief 在临时仓库里跑一次真实 git（准备数据用，不经被测代码）；异步（execFile），不挡住同时在跑的别的用例。
 * @param cwd 目录
 * @param args 参数
 * @param allow 允许的退出码（默认只有 0）
 * @param input 写进 stdin 的文字；省略时 stdin 直接关上
 * @return stdout（去掉末尾换行）
 */
export function git(cwd, args, allow = [0], input = undefined) {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(realGitPath(), args, { cwd, env: helperEnv(), encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== 'number') rejectRun(error);
        else if (!allow.includes(code)) rejectRun(new Error(`git ${args.join(' ')} exited with ${code}: ${stderr}`));
        else resolveRun(stdout.replace(/\r?\n$/, ''));
      });
    child.stdin.end(input);
  });
}

/**
 * @brief 写文件（synthetic 的内容），需要时建上级目录。
 * @param root 目录
 * @param files { 相对路径: 内容 }
 */
export function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/**
 * @brief 新的真实仓库（synthetic）：git init -b main，可选写文件并提交一次。
 * @param dir 目录（不存在时建）
 * @param files 第一次提交的文件；省略时不提交
 * @return dir
 */
export async function initRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '--quiet', '-b', 'main']);
  if (files) {
    writeFiles(dir, files);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '-m', 'base']);
  }
  return dir;
}

/** @brief pi 的 SessionManager 类（只载入它所在的模块文件）。 */
export async function loadSessionManager() {
  return (await import(pathToFileURL(SESSION_MANAGER).href)).SessionManager;
}

/** @brief porcelain v2 -z 的输出（synthetic）：每条记录以 NUL 结尾。 */
export function porcelain(records) {
  return Buffer.from(records.map((record) => `${record}\0`).join(''), 'utf8');
}

/** @brief 日志里的子命令：跳过 -c、-C 连同它的值与其他 - 开头的选项后的第一个参数。 */
export function subOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c' || args[i] === '-C') i += 1;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return args[0] ?? '';
}

/**
 * @brief 分块发一段输出（模拟管道，每块 64 KB）；进程被结束（killed() 为真）之后不再发。
 * @param stream stdout 或 stderr
 * @param data 内容
 * @param killed 进程是否已被结束
 */
function emitChunks(stream, data, killed) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  for (let at = 0; at < buffer.length && !killed(); at += 65536) stream.emit('data', buffer.subarray(at, at + 65536));
}

/**
 * @brief 一个替身子进程（synthetic）：EventEmitter 加 stdout、stderr、stdin；没有 pid，所以 git.ts 只调 kill()。
 * @param path git 的路径
 * @param args 参数
 * @param options spawn 的选项
 */
function fakeCall(path, args, options) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  const call = { path, args: [...args], sub: subOf(args), options, child, kills: 0, closed: false, reply: {},
    stdin: [], stdinEnded: false, at: Date.now() };
  child.stdin = options?.stdio?.[0] === 'pipe'
    ? { on() {}, end(chunk) { if (chunk) call.stdin.push(Buffer.from(chunk)); call.stdinEnded = true; } }
    : null;
  call.close = (code, signal = null) => {
    if (call.closed) return;
    call.closed = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  // 输出超过上限时被测代码会结束进程：之后不再发输出，由 kill() 的 close 结束（同真实进程）
  call.finish = ({ code = 0, stdout = '', stderr = '' } = {}) => {
    if (call.closed) return;
    const killed = () => call.kills > 0;
    emitChunks(child.stderr, stderr, killed);
    emitChunks(child.stdout, stdout, killed);
    if (!killed()) call.close(code);
  };
  child.kill = () => {
    call.kills += 1;
    if (!call.reply.ignoreKill) setImmediate(() => call.close(call.reply.killCode ?? null, 'SIGTERM'));
    return true;
  };
  return call;
}

/**
 * @brief 替身 spawn（synthetic，注入 configureGit）。respond(call) 给出这次调用怎样结束：
 *        { code, stdout, stderr }：下一轮 I/O 时输出并退出；{ hold: true }：等测试调 call.finish(…)；
 *        ignoreKill：kill() 之后也不 close；killCode：kill() 之后 close 的退出码；
 *        { throws }：spawn 同步抛错；{ error }：下一轮 I/O 时发 'error'。
 * @param respond 按调用给回应；返回 undefined 时按 { code: 0 }
 * @return { spawn, calls, of(sub) }
 */
export function fakeSpawn(respond) {
  const calls = [];
  const spawn = (path, args, options) => {
    const call = fakeCall(path, args, options);
    calls.push(call);
    const reply = respond(call) ?? {};
    if (reply.throws) throw reply.throws;
    call.reply = reply;
    if (reply.error) setImmediate(() => call.child.emit('error', reply.error));
    else if (!reply.hold) setImmediate(() => call.finish(reply));
    return call.child;
  };
  return { spawn, calls, of: (sub) => calls.filter((call) => call.sub === sub) };
}

/**
 * @brief 替身仓库的回应（synthetic）：--version 报 2.55；rev-parse 给 toplevel 的三行与有提交；
 *        其余交给 more（返回 undefined 时 status 给只有分支的输出，别的退出码 1）。
 * @param toplevel 仓库根（反斜杠）
 * @param more 按调用给特别的回应
 */
export function repoReply(toplevel, more = () => undefined) {
  const slash = toplevel.replace(/\\/g, '/');
  return (call) => {
    if (call.args[0] === '--version') return { stdout: FAKE_VERSION };
    const special = more(call);
    if (special !== undefined) return special;
    if (call.args.includes('--show-toplevel')) return { stdout: `${slash}\n${slash}/.git\n${slash}/.git\n` };
    if (call.args.includes('HEAD^{commit}')) return { stdout: `${'a'.repeat(40)}\n` };
    if (call.sub === 'status') return { stdout: porcelain([`# branch.oid ${'a'.repeat(40)}`, '# branch.head main']) };
    return { code: 1, stderr: 'fatal: unexpected call to the synthetic git\n' };
  };
}

/**
 * @brief 截下 console.error 与 console.log（被测代码的日志），直到调 restore()。跨计时器的流程用它，
 *        一次性的用 gate-helpers.mjs 的 quietly。
 */
export function captureLogs() {
  const errors = [];
  const logs = [];
  const error = console.error;
  const log = console.log;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));
  return { errors, logs, restore: () => { console.error = error; console.log = log; } };
}

/**
 * @brief 等条件成立：每轮 I/O（setImmediate，不受 mock.timers 影响）查一次，真实时间超过 limitMs 时抛错。
 * @param condition 条件
 * @param limitMs 最多等多久（毫秒）
 */
export async function until(condition, limitMs = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > limitMs) throw new Error(`condition not met within ${limitMs} ms`);
    await new Promise((done) => setImmediate(done));
  }
}

/** @brief 等真实时间 ms 毫秒（不用于 mock.timers 的测试里）。 */
export function pause(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
