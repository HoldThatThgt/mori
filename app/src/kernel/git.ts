// 工作区模块的 git 部分（docs/specs/file-system.md §3.2、§3.3、§4.1，后台进程第 9 件事“工作区”）：找 git、运行 git。
// Mori 不自带 git，用系统的 git；所有 git 调用（git 状态、认仓库、快照、Rewind、worktree）都经这里的 runGit：
// 不经 shell、参数原样传；环境是 process.env 的副本（去掉 GIT_*，加 LC_ALL=C、GIT_TERMINAL_PROMPT=0），从不改 process.env；
// 内部仓库的调用另用隔离的全局配置（<快照目录>\gitconfig，调用前不存在就写出）并且不读系统配置；
// 每次调用有超时与 stdout 上限，到时或超过时结束进程并记日志；按键排队，同一个键同一时刻只有一个 git 进程。
// spawn、找 git 的候选与“文件是否存在”可以注入（configureGit），单元测试据此换成替身。不监视、不轮询。

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { MIN_GIT_VERSION, type GitState } from '../shared/workspace';

// ---- 对外的类型与常量 ----

/** @brief 一次 git 调用（§3.3）。 */
export interface GitRun {
  /** git 之后的参数（不含 git 本身）；-c 与 --git-dir 等全局选项由调用方放在最前（内部仓库用 internalArgs） */
  args: string[];
  /** 进程的工作目录 */
  cwd: string;
  /** 排队的键：同一个键同一时刻只有一个 git 进程（用户仓库用仓库根，没有仓库时用工作路径；内部仓库用它的目录） */
  key: string;
  /** 内部仓库的调用（§4.2）：用隔离的配置；用户仓库的调用省略 */
  isolated?: boolean;
  /** 写进 stdin 的内容（--pathspec-from-file=-）；没有时 stdin 关掉 */
  stdin?: Buffer;
  /** 超时（毫秒），到时结束进程 */
  timeoutMs: number;
  /** stdout 的上限（字节），超过时结束进程 */
  maxOutput: number;
  /** 中止时结束进程（快照被停止，§4.5）；排队时已经中止就不起进程，结果的 error 为 stopped */
  signal?: AbortSignal;
}

/** @brief 一次 git 调用的结果；进程起不来（或 git 不可用、隔离配置写不出）时 code 为 null、error 为原文。 */
export interface GitResult {
  /** 退出码；被结束、起不来时为 null */
  code: number | null;
  /** stdout（最多 maxOutput 字节） */
  stdout: Buffer;
  /** stderr 的前 GIT_OUTPUT.stderr 字节（UTF-8） */
  stderr: string;
  /** 超时被结束 */
  timedOut: boolean;
  /** stdout 超过上限被结束，只留了前 maxOutput 字节 */
  truncated: boolean;
  /** 进程起不来等的原文；进程跑起来了为 null */
  error: string | null;
}

/** @brief 可注入的依赖（§3.2、§19.1）：起进程的 spawn、找 git 的候选、文件是否存在。 */
export interface GitDeps {
  /** 起进程（默认 node:child_process 的 spawn） */
  spawn: typeof nodeSpawn;
  /** 找 git 的候选，按顺序（默认 PATH 里每个目录下的 git.exe，然后 Program Files 里的） */
  candidates(): string[];
  /** 文件是否存在（默认 statSync 是文件）；只看文件，不起进程 */
  exists(path: string): boolean;
}

/** @brief git 进程的超时（毫秒，§17）：--version、rev-parse / status / 给界面的 diff、快照与恢复、删除会话时的 prune。 */
export const GIT_TIMEOUTS = Object.freeze({
  version: 5_000, quick: 10_000, snapshot: 120_000, prune: 300_000,
} as const);

/** @brief 输出上限（字节，§17）：status 的 stdout、其他调用的 stdout、stderr 只留的前一段。 */
export const GIT_OUTPUT = Object.freeze({ status: 4 * 1024 * 1024, other: 16 * 1024 * 1024, stderr: 64 * 1024 });

// ---- 内部常量 ----

/** 测试用的环境变量：有值时只试这一个路径（§3.2 第 0 步） */
const GIT_PATH_ENV = 'MORI_GIT_PATH';
/** PATH 之后的候选：Git for Windows 的默认位置（§17） */
const PROGRAM_FILES_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
/** Git for Windows 的启动器（<安装目录>\cmd\git.exe）与它启动的真正的 git（按安装的架构找） */
const LAUNCHER = /[\\/]cmd[\\/]git\.exe$/i;
const REAL_GITS = ['mingw64\\bin\\git.exe', 'clangarm64\\bin\\git.exe', 'mingw32\\bin\\git.exe'];
/** 隔离的全局配置的文件名与内容（§4.1） */
const ISOLATED_CONFIG_FILE = 'gitconfig';
const ISOLATED_CONFIG = '[safe]\n\tdirectory = *\n';
/** git --version 的输出 */
const VERSION_LINE = /^git version (\d+)\.(\d+)(?:\.(\d+))?/m;
/**
 * Mori 结束进程（超时或超过上限）之后最多再等 'close' 多久（毫秒）：git 起的孙进程继承了输出管道时 'close'
 * 可能一直不来，不能让这个键的队列一直卡住。正常退出之后不用它：一直等 'close'（输出读完），'close' 不来时
 * 由超时结束，结果标 timedOut，不会把读了一半的输出当成成功
 */
const CLOSE_GRACE_MS = 2_000;
/** taskkill 最多等多久（毫秒）就开始算等 'close' 的宽限：taskkill 卡住时也要能给出结果 */
const TASKKILL_WAIT_MS = 10_000;

// ---- 状态 ----

/** @brief 找到的 git：状态与可执行文件的路径（ok 时有）。 */
interface Found {
  /** git 的状态：ok 带版本，old 是版本太低，missing 是没找到或 --version 失败 */
  state: GitState;
  /** git 可执行文件的路径；只有 ok 时有，其余为 null */
  path: string | null;
  /**
   * 内部仓库的调用用的可执行文件：path 是 Git for Windows 的启动器 cmd\git.exe 时为它旁边真正的 git.exe（§3.3），
   * 否则同 path；只有 ok 时有
   */
  internal: string | null;
}

/** 当前的依赖 */
let deps: GitDeps = { spawn: nodeSpawn, candidates: defaultCandidates, exists: fileExists };
/** 上次找的结果；还没找过为 null */
let found: Found | null = null;
/** 正在找（合并同时到来的 findGit） */
let finding: Promise<GitState> | null = null;
/** 依赖的版本：configureGit 换依赖时加一，换之前开始的查找结果不再记下 */
let generation = 0;
/** 快照目录（setSnapshotsDir）；没设为 null */
let snapshotsFolder: string | null = null;
/** 每个键的队尾：新调用排在它之后 */
const tails = new Map<string, Promise<void>>();

// ---- 依赖与设置 ----

/** @brief 系统错误的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief 默认的候选（§3.2 第 1 步）：PATH 里每个绝对目录下的 git.exe，然后 Program Files 里的。 */
function defaultCandidates(): string[] {
  const dirs = (process.env.PATH ?? '').split(win32.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    // 相对的目录（例如 .）会随进程的当前目录变，不从那里起 git
    .filter((dir) => dir !== '' && win32.isAbsolute(dir));
  return [...dirs.map((dir) => win32.join(dir, 'git.exe')), PROGRAM_FILES_GIT];
}

/** @brief 默认的“文件是否存在”：stat 得到的是文件；任何错误都算不存在。 */
function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * @brief 换掉依赖（单元测试注入替身进程与候选）；省略的保持原样。换了依赖之前找到的 git 作废，下一次 findGit 重新找。
 * @param next 要换的依赖
 */
export function configureGit(next: Partial<GitDeps>): void {
  deps = { ...deps, ...next };
  found = null;
  finding = null;
  generation += 1;
}

/**
 * @brief 设快照目录（kernel/index.ts 在 start 时，§4.1）：内部仓库在它下面，isolated 调用的 GIT_CONFIG_GLOBAL 指向它下面的 gitconfig。
 * @param dir 快照目录（MORI_SNAPSHOTS_DIR 或 %LOCALAPPDATA%\Mori\snapshots）
 */
export function setSnapshotsDir(dir: string): void {
  snapshotsFolder = dir;
}

/**
 * @brief 快照目录。
 * @return setSnapshotsDir 设的目录；还没设时抛错（接线错误，不能把内部仓库建到相对路径里）
 */
export function snapshotsDir(): string {
  if (snapshotsFolder === null) throw new Error('The snapshots folder is not set.');
  return snapshotsFolder;
}

/**
 * @brief 内部仓库的固定前缀（§3.3）：--git-dir、--work-tree 与 5 个 -c，放在子命令之前，每次都带。
 * @param gitDir 内部仓库的目录
 * @param workTree 工作路径
 */
export function internalArgs(gitDir: string, workTree: string): string[] {
  return [
    `--git-dir=${gitDir}`, `--work-tree=${workTree}`,
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.longpaths=true',
    '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false',
  ];
}

// ---- 找 git ----

/** @brief 解析 git --version 的输出；认不出时为 null。version 是数字部分（例如 2.55.0）。 */
function parseVersion(text: string): { version: string; major: number; minor: number } | null {
  const match = VERSION_LINE.exec(text);
  if (!match) return null;
  const version = match[3] === undefined ? `${match[1]}.${match[2]}` : `${match[1]}.${match[2]}.${match[3]}`;
  return { version, major: Number(match[1]), minor: Number(match[2]) };
}

/** @brief 版本是否不低于 MIN_GIT_VERSION（§3.2 第 2 步）。 */
function newEnough(major: number, minor: number): boolean {
  const [needMajor, needMinor] = MIN_GIT_VERSION.split('.').map(Number);
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

/** @brief 没找到 git 的结果，并记下原因。 */
function missing(reason: string): Found {
  console.error(`[kernel] git: ${reason}`);
  return { state: { state: 'missing' }, path: null, internal: null };
}

/**
 * @brief 内部仓库的调用用哪个 git（§3.3）：Git for Windows 的 cmd\git.exe 只是启动器，它再起真正的 git.exe，
 *        每次调用两个进程；内部仓库的调用用隔离的配置、不跑过滤器与钩子，不需要启动器设的 PATH，直接起它旁边真正的 git。
 *        你的仓库的调用照旧用找到的 git（LFS 等过滤器要启动器设的 PATH）。
 * @param path 找到的 git
 */
function internalExecutable(path: string): string {
  if (!LAUNCHER.test(path)) return path;
  const root = win32.dirname(win32.dirname(path));
  return REAL_GITS.map((name) => win32.join(root, name)).find((candidate) => deps.exists(candidate)) ?? path;
}

/**
 * @brief 找一次 git（§3.2）：MORI_GIT_PATH 有值时只试它；否则按候选找第一个存在的；再跑 git --version（5 秒）。
 * @return 找到的状态与路径；不抛错
 */
async function locate(): Promise<Found> {
  const override = process.env[GIT_PATH_ENV];
  const candidates = override ? [override] : deps.candidates();
  const path = candidates.find((candidate) => deps.exists(candidate));
  if (path === undefined) {
    return missing(override ? `${GIT_PATH_ENV} points to a missing file: ${override}` : 'git.exe was not found');
  }
  const result = await spawnGit(path, {
    args: ['--version'], cwd: win32.dirname(path), key: path,
    timeoutMs: GIT_TIMEOUTS.version, maxOutput: GIT_OUTPUT.other,
  }, gitEnv(null));
  if (result.code !== 0) return missing(`${path} --version failed: ${gitError(result)}`);
  const output = result.stdout.toString('utf8');
  const parsed = parseVersion(output);
  if (parsed === null) return missing(`${path} --version gave unexpected output: ${output.trim()}`);
  if (!newEnough(parsed.major, parsed.minor)) {
    console.error(`[kernel] git: ${path} is ${parsed.version}; ${MIN_GIT_VERSION} or newer is required`);
    return { state: { state: 'old', version: parsed.version }, path: null, internal: null };
  }
  const internal = internalExecutable(path);
  const also = internal === path ? '' : `; internal repos use ${internal}`;
  console.log(`[kernel] git: using ${path} (${parsed.version})${also}`);
  return { state: { state: 'ok', version: parsed.version }, path, internal };
}

/**
 * @brief 找 git（§3.2 第 3 步）：结果在后台进程里记住；ok 一直用；missing、old 时只有 force 为真才再找
 *        （workspace.status 命令），别处不重找。同时到来的调用共用一次查找。
 * @param force 上次是 missing、old 时重新找
 * @return git 的状态；不抛错
 */
export function findGit(force = false): Promise<GitState> {
  if (finding) return finding;
  if (found && (found.state.state === 'ok' || !force)) return Promise.resolve(found.state);
  const started = generation;
  const search = locate()
    .catch((error: unknown) => missing(`finding git failed: ${errorText(error)}`))
    .then((result) => {
      if (started === generation) {
        found = result;
        finding = null;
      }
      return result.state;
    });
  finding = search;
  return search;
}

/** @brief 上次找的结果；还没找过时为 missing。 */
export function gitState(): GitState {
  return found?.state ?? { state: 'missing' };
}

// ---- 运行 git ----

/**
 * @brief git 进程的环境（§3.3）：process.env 的副本，去掉所有 GIT_ 开头的变量（不分大小写）与各种写法的 LC_ALL，
 *        加 LC_ALL=C、GIT_TERMINAL_PROMPT=0；内部仓库的调用另加 GIT_CONFIG_NOSYSTEM=1、GIT_CONFIG_GLOBAL。
 * @param globalConfig 隔离的全局配置文件；用户仓库的调用为 null
 */
function gitEnv(globalConfig: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith('GIT_') && upper !== 'LC_ALL') env[name] = value;
  }
  env.LC_ALL = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  if (globalConfig !== null) {
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = globalConfig;
  }
  return env;
}

/** @brief 日志里的子命令：跳过全局选项（-c、-C 连同它的值）后的第一个参数；没有时为第一个参数。 */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c' || args[i] === '-C') i += 1;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return args[0] ?? '';
}

/** @brief 有上限的输出缓冲：超过上限的部分丢掉。 */
class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  /** @param limit 上限（字节） */
  constructor(private readonly limit: number) {}

  /**
   * @brief 加一段输出。
   * @return 还在上限内为 true；这一段超过上限（只留到上限）为 false
   */
  add(chunk: Buffer): boolean {
    const room = this.limit - this.size;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return true;
    }
    if (room > 0) this.chunks.push(chunk.subarray(0, room));
    this.size = this.limit;
    return false;
  }

  /** @brief 留下的全部输出。 */
  buffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

/**
 * @brief 进程起不来的原文：工作目录不存在时 Node 报的是 spawn <git> ENOENT，看不出是目录的问题，换成一句说明；
 *        其他照 Node 的原文。只在出错时 stat 一次。
 * @param error spawn 的错误
 * @param cwd 进程的工作目录
 */
function startErrorText(error: NodeJS.ErrnoException, cwd: string): string {
  if (error.code !== 'ENOENT') return error.message;
  try {
    if (statSync(cwd).isDirectory()) return error.message;
  } catch {
    return `folder not found: ${cwd}`;
  }
  return `not a folder: ${cwd}`;
}

/** @brief 调用方中止（GitRun.signal）时结果的 error。 */
const STOPPED_TEXT = 'stopped';

/** @brief 没起进程就失败的结果。 */
function failedResult(error: string): GitResult {
  return { code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, truncated: false, error };
}

/** taskkill 的路径：用 System32 里的，不依赖 PATH（同 pi 的 killProcessTree） */
const TASKKILL = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

/**
 * @brief 结束 git 进程连同它起的子进程（§3.3、§4.5、§15）。Git for Windows 的 cmd\git.exe 只是启动器，真正干活的
 *        mingw64\bin\git.exe 是它的子进程；只 child.kill() 时后者继续跑并占着内部仓库的 index.lock，
 *        所以 Windows 上用 taskkill /F /T 结束整棵进程树（不经 shell）。taskkill 直接用 node 的 spawn、不走注入的
 *        deps.spawn：只在 child 是真进程时用。进程已经退出（Node 已记下退出码，pid 可能被复用）、没有 pid
 *        或不是真进程（替身的 exitCode 不是 null）时只 child.kill()；taskkill 起不来或失败时退回 child.kill() 并记日志。
 *        机器忙时 taskkill 自己就要一两秒，所以结束做完（taskkill 退出，最多等 TASKKILL_WAIT_MS）才调 ended。
 * @param child 进程
 * @param label 日志里的说明（子命令与目录）
 * @param ended 结束做完时调用一次（等 'close' 的宽限从这时起算）
 */
function killTree(child: ChildProcess, label: string, ended: () => void): void {
  const running = child.exitCode === null && child.signalCode === null;
  if (process.platform !== 'win32' || typeof child.pid !== 'number' || !running) {
    child.kill();
    ended();
    return;
  }
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(wait);
    ended();
  };
  const fallback = (reason: string): void => {
    console.error(`[kernel] git ${label}: taskkill failed (${reason}); ending only the started process`);
    child.kill();
  };
  const wait = setTimeout(finish, TASKKILL_WAIT_MS);
  try {
    const killer = nodeSpawn(TASKKILL, ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    killer.once('error', (error) => {
      fallback(error.message);
      finish();
    });
    killer.once('close', (code) => {
      // 树里的进程在 taskkill 找到之前自己退出了（启动器跟着子进程退出）时 taskkill 也报错；进程已经结束就不算失败
      if (code !== 0 && child.exitCode === null && child.signalCode === null) fallback(`exit code ${code}`);
      finish();
    });
  } catch (error) {
    fallback(errorText(error));
    finish();
  }
}

/** @brief 结束 git 进程的开关（watchChild 用）。 */
interface Stopper {
  /** 结束进程树（只第一次生效）并启动等 'close' 的宽限计时 */
  kill(): void;
  /** 收起宽限计时（结果已经给出） */
  clear(): void;
}

/**
 * @brief 结束 git 进程的开关：kill() 只第一次生效，结束整棵进程树（killTree），再最多等 CLOSE_GRACE_MS 的 'close'，
 *        到时记一行错误日志并调 onGrace。
 * @param child 进程
 * @param label 日志里的说明（子命令与目录）
 * @param onGrace 宽限到时调用
 */
function stopper(child: ChildProcess, label: string, onGrace: () => void): Stopper {
  let killing = false;
  let cleared = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  // 到时先让事件循环再走两轮（setImmediate 在 poll 之后）：机器忙、循环卡过 2 秒时到期的计时器排在还没读的 EOF 之前，
  // 不能把已经关上的管道当成一直开着
  const expire = (): void => {
    if (cleared) return;
    console.error(`[kernel] git ${label}: its output stayed open after it was stopped`);
    onGrace();
  };
  const arm = (): void => {
    if (cleared) return;
    grace = setTimeout(() => setImmediate(() => setImmediate(expire)), CLOSE_GRACE_MS);
  };
  return {
    kill: () => {
      if (killing) return;
      killing = true;
      killTree(child, label, arm);
    },
    clear: () => {
      cleared = true;
      if (grace !== null) clearTimeout(grace);
    },
  };
}

/**
 * @brief 接上一个已起的 git 进程的输出、超时与结束（§3.3）：超时或 stdout 超过上限时结束进程树（killTree）
 *        并记一行错误日志。
 * @param child 进程
 * @param run 这次调用
 * @param finish 结束时调用一次（重复调用由它忽略）
 */
function watchChild(child: ChildProcess, run: GitRun, finish: (result: GitResult) => void): void {
  const sub = subcommand(run.args);
  const out = new CappedOutput(run.maxOutput);
  const err = new CappedOutput(GIT_OUTPUT.stderr);
  let timedOut = false;
  let truncated = false;
  let stopped = false;
  // 宽限只由 kill() 启动：这时 timedOut、truncated 或 stopped 已经为真；不等 'close' 就结束时输出不完整，退出码给 null
  const ender = stopper(child, `${sub} in ${run.cwd}`, () => done(null, null));
  const done = (code: number | null, error: string | null): void => {
    clearTimeout(timer);
    ender.clear();
    run.signal?.removeEventListener('abort', stop);
    const stderr = err.buffer().toString('utf8');
    const text = error ?? (stopped ? STOPPED_TEXT : null);
    // Mori 结束的进程（停止、超时、超过上限）退出码给 null：taskkill 的退出码会传过来，不是 git 的
    const killed = stopped || timedOut || truncated;
    finish({ code: killed ? null : code, stdout: out.buffer(), stderr, timedOut, truncated, error: text });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`[kernel] git ${sub} timed out after ${run.timeoutMs} ms in ${run.cwd}`);
    ender.kill();
  }, run.timeoutMs);
  // 调用方中止（快照被停止）：结束进程，结果标 error stopped
  const stop = (): void => {
    stopped = true;
    ender.kill();
  };
  run.signal?.addEventListener('abort', stop, { once: true });
  child.stdout?.on('data', (chunk: Buffer) => {
    if (out.add(chunk) || truncated) return;
    truncated = true;
    console.error(`[kernel] git ${sub} output exceeded ${run.maxOutput} bytes in ${run.cwd}`);
    ender.kill();
  });
  child.stderr?.on('data', (chunk: Buffer) => err.add(chunk));
  child.on('error', (error) => {
    const text = startErrorText(error, run.cwd);
    console.error(`[kernel] git ${sub} failed in ${run.cwd}: ${text}`);
    done(null, text);
  });
  // 只认 'close'（输出读完）：'exit' 时输出可能还没读完；退出了却一直不 close 时由超时结束，结果标 timedOut
  child.on('close', (code) => done(code, null));
}

/**
 * @brief 起一个 git 进程并等它结束（不排队）：不经 shell，参数原样传，windowsHide；有 stdin 时写进去并关上，没有时关掉。
 * @param path git 可执行文件
 * @param run 这次调用
 * @param env 进程的环境（gitEnv 的结果）
 * @return 结果；不抛错
 */
function spawnGit(path: string, run: GitRun, env: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = deps.spawn(path, run.args, {
        cwd: run.cwd, env, windowsHide: true, stdio: [run.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      console.error(`[kernel] git ${subcommand(run.args)} couldn't start in ${run.cwd}: ${errorText(error)}`);
      finish(failedResult(errorText(error)));
      return;
    }
    watchChild(child, run, finish);
    if (run.stdin === undefined) return;
    child.stdin?.on('error', (error) => {
      console.error(`[kernel] git ${subcommand(run.args)}: couldn't write stdin: ${error.message}`);
    });
    child.stdin?.end(run.stdin);
  });
}

/**
 * @brief 隔离的全局配置（§4.1）：每次内部仓库调用之前检查，不存在就写出（wx，不覆盖；没有快照目录就建）。
 * @return 配置文件的路径；快照目录没设或写不出时为 { error }
 */
async function isolatedConfig(): Promise<string | { error: string }> {
  if (snapshotsFolder === null) {
    console.error('[kernel] git: the snapshots folder is not set; internal-repo call refused');
    return { error: 'The snapshots folder is not set.' };
  }
  const file = win32.join(snapshotsFolder, ISOLATED_CONFIG_FILE);
  try {
    await mkdir(snapshotsFolder, { recursive: true });
    await writeFile(file, ISOLATED_CONFIG, { flag: 'wx' });
  } catch (error) {
    // 只有配置文件已经存在（wx 的 EEXIST）算好；快照目录建不起来（例如它是一个文件）照样失败
    const exists = (error as NodeJS.ErrnoException | null)?.code === 'EEXIST' && fileExists(file);
    if (!exists) {
      console.error(`[kernel] git: couldn't write ${file}: ${errorText(error)}`);
      return { error: errorText(error) };
    }
  }
  return file;
}

/** @brief git 不可用时调用的原文。 */
function unavailableText(state: GitState): string {
  return state.state === 'old'
    ? `Git ${MIN_GIT_VERSION} or newer is required (found ${state.version}).`
    : 'Git was not found.';
}

/** @brief 排到之后做一次调用：确认 git 可用、准备隔离配置、起进程；不抛错。 */
async function execute(run: GitRun): Promise<GitResult> {
  if (run.signal?.aborted) return failedResult(STOPPED_TEXT);
  try {
    const state = await findGit();
    const path = (run.isolated ? found?.internal : found?.path) ?? null;
    if (state.state !== 'ok' || path === null) return failedResult(unavailableText(state));
    let globalConfig: string | null = null;
    if (run.isolated) {
      const config = await isolatedConfig();
      if (typeof config !== 'string') return failedResult(config.error);
      globalConfig = config;
    }
    if (run.signal?.aborted) return failedResult(STOPPED_TEXT);
    return await spawnGit(path, run, gitEnv(globalConfig));
  } catch (error) {
    console.error(`[kernel] git ${subcommand(run.args)} failed in ${run.cwd}: ${errorText(error)}`);
    return failedResult(errorText(error));
  }
}

/** @brief 排队用的键：统一分隔符、不分大小写（Windows 的路径）。 */
function queueKey(key: string): string {
  return key.replace(/\//g, '\\').toLowerCase();
}

/**
 * @brief 运行一次 git（§3.3）：按 key 排队，同一个键先到先跑、同一时刻一个进程，不同的键并行；
 *        还没找过 git 时先找一次；超时或 stdout 超过上限时结束进程、标记并记日志。
 * @param run 这次调用
 * @return 结果；不抛错（失败在 code、error、timedOut 里）
 */
export function runGit(run: GitRun): Promise<GitResult> {
  const key = queueKey(run.key);
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(() => execute(run));
  const tail = result.then(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

/**
 * @brief 失败的原文（§3.3）：起不来时为 error；超时为固定的一句；否则 stderr 第一行非空文字（去掉开头的 fatal: 、error: ）；
 *        没有 stderr 时按超过上限、退出码给一句。
 * @param result 失败的结果
 */
export function gitError(result: GitResult): string {
  if (result.error !== null) return result.error;
  if (result.timedOut) return 'git took too long and was stopped';
  const line = result.stderr.split(/\r?\n/).map((text) => text.trim()).find((text) => text !== '');
  if (line !== undefined) return line.replace(/^(?:fatal|error): /, '');
  if (result.truncated) return 'git printed more output than Mori reads';
  return `git exited with code ${result.code}`;
}
