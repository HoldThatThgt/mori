// 快照模块（docs/specs/file-system.md §4、§5.3，后台进程第 9 件事“工作区”）：每个工作路径一个内部仓库
// （<快照目录>\<projectDirName 编码>，在工作路径外，mori.json 记归属、info/attributes 按字节存取），用户会话和它的后台实例
// 每次运行开始、结束各拍一张快照（inline extension mori-snapshots：before_agent_start 等开始快照做完，agent_settled 只排结束
// 快照）；快照作业、Rewind 与 Undo（rewind.ts 经 inQueue）、snapshots.diff、snapshots.drop 按工作路径排队，一个做完再做下一个。
// 相邻两张快照之间的一段记给当时在运行的用户会话（时间线与归属的纯函数在 timeline.ts），写成 mori.turn_changes 条目
// （经登记时给出的 SessionManager 写进用户会话的文件）并在它的信封上发同名事件；ref 按会话、按轮保住用到的提交，
// 每个会话保留最近 keepTurns 轮，删除会话时整理。所有 git 调用都经 git.ts（内部仓库用隔离的配置与固定的 -c）；
// 对你的仓库只有只读的 rev-parse（workspace.repoInfo）与 ls-files。不监视、不轮询：只在运行前后、你操作时做。

import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import type {
  BeforeAgentStartEvent, ExtensionContext, ExtensionFactory, SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { KernelEvent } from '../shared/protocol';
import {
  MIN_GIT_VERSION, WORKSPACE_ENTRY_TYPES, type ChangedFile, type GitState, type RepoInfo, type RunAgent,
  type SnapshotDiff, type SnapshotState, type TurnChanges,
} from '../shared/workspace';
import {
  GIT_OUTPUT, GIT_TIMEOUTS, findGit, gitError, gitState, internalArgs, runGit, snapshotsDir, type GitResult,
  type GitRun,
} from './git';
import { projectDirName } from './memoryFiles';
import { callKind, insideDir } from './pathGate';
import {
  argBatches, closeSegment, emptyTimeline, excludeText, nulList, parseGitlinks, parseRawNumstat, roundsToDrop,
  segmentBase, turnEntries, withoutRun, type ActiveRun, type CloseResult, type Snap, type Timeline, type UserView,
} from './timeline';
import { readStatus, repoInfo, resendStatus, scheduleStatus } from './workspace';

// ---- 对外的类型与常量 ----

/** @brief 快照的上限（§4.4、§4.7、§19.1）：都是参数，单元测试传很小的值。 */
export interface SnapshotLimits {
  /** 单个未跟踪的新文件大于它（字节）时不进快照（§4.4 第 4 步） */
  maxFileBytes: number;
  /** 一次要加入的新文件多于它时暂停快照（§4.4 第 3 步） */
  maxNewFiles: number;
  /** 新文件多于它时分批加入，每批最多这么多条路径（§4.4 第 5 步） */
  batch: number;
  /** 快照与恢复里每个 git 进程的超时（毫秒） */
  stepTimeoutMs: number;
  /** 每个会话保留最近多少轮的 ref（§4.7） */
  keepTurns: number;
}

/** @brief 默认的上限（§17）：10 MB、20000 个、每批 2000 条、120 秒、100 轮。 */
export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024, maxNewFiles: 20_000, batch: 2_000, stepTimeoutMs: GIT_TIMEOUTS.snapshot,
  keepTurns: 100,
});

/** @brief 用户会话在快照模块里的登记（打开时登记、释放时注销，§4.6）。 */
export interface SnapshotUser {
  /** 用户会话 id */
  sessionId: string;
  /** 工作路径（会话的 cwd 原样） */
  cwd: string;
  /** 记录写进的那个对象（会话 dispose 之后仍能写文件） */
  sessionManager: SessionManager;
  /** @brief 在这个会话的信封上发事件。 */
  emit(event: KernelEvent): void;
  /** 增强任务的看不见的会话：不拍快照、不写记录 */
  headless: boolean;
}

/** @brief mori-snapshots 所在的会话（sessions.ts 建扩展时给）。 */
export interface RunSource {
  /** 所属的用户会话（实例为它的 owner） */
  userSessionId: string;
  /** 是用户会话自己（不是实例） */
  self: boolean;
  /** 增强任务的看不见的会话：只做工具执行完的刷新 */
  headless: boolean;
  /** @brief 这次运行标出的 Agent（before_agent_start 时取）。 */
  agent(): RunAgent;
}

/** @brief inline extension 的名字（§4.5）；pi 用 `<inline:mori-snapshots>` 标出它的加载错误（必需的扩展）。 */
export const SNAPSHOT_EXTENSION = 'mori-snapshots';

/** @brief 整理过的轮的原文（§4.7）：snapshots.diff、Rewind 到这一轮时给出。 */
export const PRUNED_TEXT = 'Mori keeps snapshots for the last 100 turns of a session. '
  + 'This turn’s snapshots were removed.';

// ---- 内部常量 ----

/** 归属文件与 info/attributes 的内容（§4.1） */
const MORI_FILE = 'mori.json';
const ATTRIBUTES = '* -text !eol -filter -ident -working-tree-encoding\n';
/** 提交身份与消息（§4.2、§17） */
const COMMIT_IDENTITY = ['-c', 'user.name=Mori', '-c', 'user.email=mori@localhost'];
const COMMIT_MESSAGE = 'Mori snapshot';
/** ref 的位置（§4.7） */
const LAST_REF = 'refs/mori/last';
const SESSION_REFS = 'refs/mori/s/';
/** ref 里会话 id、轮的条目 id 的写法 */
const REF_PART = /^[A-Za-z0-9_-]+$/;
/** 原文（§4.1、§4.4、§5.1） */
const COUNT_PAUSE = 'Snapshots are paused for this folder: more than 20,000 new files would be added. '
  + 'Add generated folders to .gitignore to resume.';
const TIMEOUT_PAUSE = 'Snapshots are paused for this folder: a snapshot took longer than 2 minutes. '
  + 'They resume when Mori restarts.';
const TIMEOUT_ERROR = 'a snapshot step took longer than 2 minutes';
const GIT_REQUIRED = 'Git is required to track changes and rewind.';
const NOT_LISTED = 'This turn has no changes to this file.';
/** 连续几张超时才暂停（§4.4） */
const TIMEOUT_PAUSE_COUNT = 3;
/** skipped、nested 最多列出几个（§17） */
const LIST_LIMIT = 20;
/** 作参数传的路径每批命令行的字符数上限（§3.3） */
const CMDLINE_LIMIT = 30_000;
/** 同时 stat 的文件数（不阻塞后台进程，也不一次开上万个文件句柄） */
const STAT_BATCH = 64;
/** snapshots.diff 的结果上限（§5.3） */
const DIFF_LIMIT = 1024 * 1024;
/** git diff 的二进制说明行 */
const BINARY_PATCH = /^Binary files .* differ$/m;
/** 上次被强行结束时可能留下的锁（§4.1），refs\ 下另找 *.lock */
const ROOT_LOCKS = ['index.lock', 'packed-refs.lock'];
/**
 * 快照里用到的 git 参数。add 都带 --no-warn-embedded-repo：否则加入已有提交的嵌套仓库时 git 先打一行 warning 和一段 hint，
 * 同一张里还有没提交的嵌套仓库时 stderr 的第一行就不是那句 error（§4.4“其他失败”、FS-26）
 */
/** 被忽略的文件，一次问你的 git（§4.3）：-t 的标签 ? 是没跟踪的（写进排除），其余是你用 add -f 跟踪的（要 add -f） */
const IGNORED_ARGS = ['ls-files', '-z', '-t', '--others', '--cached', '--ignored', '--exclude-standard', '--directory'];
const NEW_FILES_ARGS = ['ls-files', '-z', '--others', '--exclude-standard'];
const ADD = ['add', '--no-warn-embedded-repo'];
const BATCH_ADD_ARGS = ['--literal-pathspecs', ...ADD, '--pathspec-from-file=-', '--pathspec-file-nul'];
const ADD_EXCLUDING_ARGS = [...ADD, '-A', '--pathspec-from-file=-', '--pathspec-file-nul'];
const ADD_ALL_ARGS = [...ADD, '-A', '--', '.'];
const FORCE_ADD_ARGS = ['--literal-pathspecs', ...ADD, '-f', '--pathspec-from-file=-', '--pathspec-file-nul'];
/** 总被排除、强制加入时也不加的两个目录（工作路径根，§4.3“总是”） */
const NEVER_FORCED = /^(?:\.work|\.mori\/worktrees)(?:\/|$)/i;

// ---- 状态 ----

/** @brief 一个内部仓库的作业队列（按内部仓库的目录，不分大小写：Windows 上大小写不同的编码是同一个目录）。 */
interface Queue {
  /** 排队的键（目录的小写），也是 git.ts 的键 */
  key: string;
  /** 内部仓库的目录 */
  repo: string;
  /** 队尾：新作业排在它之后 */
  tail: Promise<void>;
  /** 排着的与正在做的作业数 */
  pending: number;
  /** 这次后台进程里还没做过作业：第一个作业前清陈旧的锁 */
  fresh: boolean;
  /** 有 git 进程被结束（超时、超过上限、停止）：下一个作业前清锁 */
  dirty: boolean;
  /** 正在 Rewind / Undo 的用户会话（inQueue 带 rewinder 时）与它们排着的作业数 */
  rewinding: Map<string, number>;
}

/** @brief 一个工作路径（解析后的路径）的快照状态与时间线。 */
interface PathState {
  /** 解析后的工作路径 */
  cwd: string;
  /** 会话用的 cwd 原样（resendStatus 按它找 git 状态） */
  raw: Set<string>;
  /** 它的内部仓库的作业队列（编码相同的工作路径共用） */
  queue: Queue;
  /** 时间线：上一张、正在运行的、每个会话这一段的开始（§4.5） */
  timeline: Timeline;
  /** active 里每个用户会话的 SessionManager（读叶子与条目、写记录） */
  managers: Map<string, SessionManager>;
  /** 快照状态（WorkspaceStatus.snapshots） */
  snap: SnapshotState;
  /** 暂停的原因：文件数（每个快照点重新数）、连续超时（到后台进程重启） */
  pause: 'count' | 'timeout' | null;
  /** 连续超时的张数 */
  timeouts: number;
  /** 这次后台进程里已经确认归属 */
  owned: boolean;
  /** info/exclude 在磁盘上的内容；还没读过为 null */
  exclude: string | null;
  /** 这一段里包含它或在它里面的工作路径上有过运行（nestedOverlap） */
  nestedSeen: boolean;
}

/** @brief 一次运行在快照模块里的记录（键为 pi 会话 id）。 */
interface RunTicket {
  /** 运行所在的 pi 会话 id */
  pi: string;
  /** 运行所在的工作路径 */
  path: PathState;
  /** ctx.cwd 原样 */
  rawCwd: string;
  /** 所属的用户会话 */
  user: string;
  /** 用户会话登记时给的 SessionManager */
  manager: SessionManager;
  /** 登记进时间线 active 的那一项（同一个对象，endJob 据此认出它） */
  run: ActiveRun;
  /** 发 mori.snapshot_stage（用户会话自己的运行） */
  stage: boolean;
  /** 开始快照还没做完 */
  starting: boolean;
  /** pi 发了 agent_start */
  started: boolean;
  /** 开始快照做完之前被停止 */
  cancelled: boolean;
  /** 结束开始快照的 git 进程 */
  abort: AbortController;
  /** 停止时兑现，before_agent_start 不再等 */
  stopped: Promise<void>;
  /** 兑现 stopped */
  release: () => void;
}

/** @brief 一次 git 调用的选项。 */
interface CallOptions {
  /** 写进 git 的 stdin */
  stdin?: Buffer;
  /** stdout 的上限（字节）；省略时为 GIT_OUTPUT.other */
  maxOutput?: number;
  /** 超时（毫秒）；省略时为 stepTimeoutMs */
  timeoutMs?: number;
  /** 中止时结束这个 git 进程（git.ts 的 GitRun.signal） */
  signal?: AbortSignal;
  /**
   * 只碰 ref 与对象的调用（for-each-ref、update-ref、prune）：进程的工作目录与 --work-tree 都给内部仓库的目录，
   * 否则都是工作路径（§4.2）。它们不用工作树，但 git 仍会检查 --work-tree（不给时检查 config 里的 core.worktree），
   * 工作路径或它上面的文件夹已经不在（worktree 先被删掉、文件夹被你删了）时报 Invalid path；给内部仓库的目录，
   * 删除会话照样能整理（§4.7）
   */
  refsOnly?: boolean;
}

/** @brief 一次拍快照的结果。 */
type Shot =
  | { kind: 'taken'; snap: Snap; changed: boolean }
  | { kind: 'skipped' }
  | { kind: 'failed'; error: string }
  | { kind: 'aborted' };

/** @brief 这一张是谁的开始、谁的结束，以及恢复集合（Rewind 的恢复后快照，§5.7 第 4 步）。 */
interface Mark {
  /** 这一张是它的开始快照的运行；没有为 null */
  start: RunTicket | null;
  /** 这一张是它的结束快照的运行；没有为 null */
  end: RunTicket | null;
  /** 恢复集合 R（相对工作路径）：之前那一段里这些文件不记给任何人；不是恢复后快照为 null */
  restoring: ReadonlySet<string> | null;
}

/** @brief 一步失败：git 报错、超时、被停止。 */
class StepError extends Error {
  /**
   * @param message 原文
   * @param kind 种类
   */
  constructor(message: string, readonly kind: 'error' | 'timeout' | 'aborted') {
    super(message);
  }
}

/** 当前的上限 */
let limits: SnapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS };
/** 登记的用户会话 */
const users = new Map<string, SnapshotUser>();
/** 按解析后的工作路径 */
const paths = new Map<string, PathState>();
/** 按内部仓库目录的小写 */
const queues = new Map<string, Queue>();
/** 按 pi 会话 id 的运行 */
const tickets = new Map<string, RunTicket>();

// ---- 小工具 ----

/** @brief 异常的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief 系统错误的 code。 */
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** @brief 新的快照状态：照常。 */
function freshState(): SnapshotState {
  return { state: 'on', reason: null, error: null, skipped: [], skippedTotal: 0, nested: [], nestedTotal: 0 };
}

/** @brief 快照状态的副本。 */
function copyState(state: SnapshotState): SnapshotState {
  return { ...state, skipped: [...state.skipped], nested: [...state.nested] };
}

/** @brief git 不是 ok 时快照状态的原因（与右栏的原文相同，§5.1）。 */
function gitReason(git: GitState): string {
  return git.state === 'old'
    ? `Git ${MIN_GIT_VERSION} or newer is required to track changes and rewind (found ${git.version}).`
    : GIT_REQUIRED;
}

/** @brief 归属冲突的原因（§4.1）。 */
function ownerText(owner: string): string {
  return `Snapshots are off for this folder: its snapshot folder belongs to ${owner}.`;
}

/** @brief 文件是否存在。 */
async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
}

/** @brief 读文本文件；不存在时为空串。 */
async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return '';
    throw error;
  }
}

/** @brief NUL 分隔的 stdin（--pathspec-from-file=- --pathspec-file-nul）。 */
function nulJoin(items: readonly string[]): Buffer {
  return Buffer.from(items.join('\0'), 'utf8');
}

/** @brief 一行 git 输出（write-tree、commit-tree 的对象 id）。 */
function objectId(result: GitResult): string {
  const text = result.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(text)) throw new StepError(`git gave an unexpected object id: ${text}`, 'error');
  return text;
}

/** @brief for-each-ref 列出的 ref 名。 */
function refNames(result: GitResult): string[] {
  return result.stdout.toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

// ---- 设置与登记 ----

/**
 * @brief 换上限（单元测试传很小的值，§19.1）；省略的保持原样。
 * @param options 要换的上限
 */
export function configureSnapshots(options: { limits?: Partial<SnapshotLimits> }): void {
  const given = Object.entries(options.limits ?? {}).filter(([, value]) => value !== undefined);
  limits = { ...limits, ...Object.fromEntries(given) };
}

/**
 * @brief 用户会话打开时登记（§4.6）：记录写进它的 sessionManager，事件发在它的 emit 上。
 * @param user 登记的内容
 */
export function registerSnapshotUser(user: SnapshotUser): void {
  users.set(user.sessionId, user);
}

/**
 * @brief 用户会话释放时注销：之后做完的结束快照仍写进运行登记时记下的 SessionManager（会话文件已不在时不写），
 *        但不再发事件；会话重新打开、再次登记之后改写进新登记的那个（recordTarget）。
 * @param sessionId 用户会话 id
 */
export function unregisterSnapshotUser(sessionId: string): void {
  users.delete(sessionId);
}

// ---- 工作路径与队列 ----

/** @brief 这个工作路径的内部仓库目录（§4.1）；快照目录没设时抛错。 */
function repoDir(cwd: string): string {
  return win32.join(snapshotsDir(), projectDirName(cwd));
}

/** @brief 内部仓库的队列（没有就建）。 */
function queueOf(repo: string): Queue {
  const key = repo.toLowerCase();
  let queue = queues.get(key);
  if (queue === undefined) {
    queue = { key, repo, tail: Promise.resolve(), pending: 0, fresh: true, dirty: false, rewinding: new Map() };
    queues.set(key, queue);
  }
  return queue;
}

/** @brief 工作路径的状态（没有就建）；记下会话用的 cwd 原样。快照目录没设时抛错。 */
function pathOf(cwd: string): PathState {
  const resolved = resolve(cwd);
  let path = paths.get(resolved);
  if (path === undefined) {
    path = { cwd: resolved, raw: new Set(), queue: queueOf(repoDir(resolved)), timeline: emptyTimeline(),
      managers: new Map(), snap: freshState(), pause: null, timeouts: 0, owned: false, exclude: null,
      nestedSeen: false };
    paths.set(resolved, path);
  }
  path.raw.add(cwd);
  return path;
}

/**
 * @brief 排一个作业（§4.5“排队”）：同一个内部仓库一个做完再做下一个；第一个作业前、有 git 进程被结束之后先清锁。
 * @param path 工作路径
 * @param job 作业
 * @return 作业的结果
 */
function enqueue<T>(path: PathState, job: () => Promise<T>): Promise<T> {
  const queue = path.queue;
  queue.pending += 1;
  const run = queue.tail.then(async () => {
    await cleanLocks(queue);
    return job();
  });
  const done = (): void => {
    queue.pending -= 1;
  };
  queue.tail = run.then(done, done);
  return run;
}

/** @brief 删一个文件：删掉为 removed，不存在为 absent，其他失败（例如还被占用）记日志、为 failed。 */
async function removeFile(file: string): Promise<'removed' | 'absent' | 'failed'> {
  try {
    await rm(file);
    return 'removed';
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return 'absent';
    console.error(`[kernel] snapshots: couldn't remove ${file}: ${errorText(error)}`);
    return 'failed';
  }
}

/** @brief refs\ 下的 *.lock（相对内部仓库）。 */
async function refLocks(repo: string): Promise<string[]> {
  try {
    const names = await readdir(win32.join(repo, 'refs'), { recursive: true });
    return names.filter((name) => name.endsWith('.lock')).map((name) => win32.join('refs', name));
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      console.error(`[kernel] snapshots: couldn't list ${repo}\\refs: ${errorText(error)}`);
    }
    return [];
  }
}

/**
 * @brief 陈旧的锁（§4.1）：这次后台进程里的第一个作业前、内部仓库的 git 进程被结束之后，删掉 index.lock、packed-refs.lock
 *        与 refs\ 下的 *.lock，删到了就记一行日志。
 */
async function cleanLocks(queue: Queue): Promise<void> {
  if (!queue.fresh && !queue.dirty) return;
  queue.fresh = false;
  queue.dirty = false;
  const removed: string[] = [];
  for (const name of [...ROOT_LOCKS, ...(await refLocks(queue.repo))]) {
    const outcome = await removeFile(win32.join(queue.repo, name));
    if (outcome === 'removed') removed.push(name);
    // 删不掉（还被占用）时下一个作业前再试
    if (outcome === 'failed') queue.dirty = true;
  }
  if (removed.length === 0) return;
  console.log(`[kernel] snapshots: removed stale lock files in ${queue.repo}: ${removed.join(', ')}`);
}

/** @brief 快照状态变了时再发一次 git 状态（§3.5）：用这个工作路径上会话用过的每个 cwd 原样。 */
function resend(path: PathState): void {
  for (const cwd of path.raw) {
    try {
      resendStatus(cwd);
    } catch (error) {
      console.error(`[kernel] snapshots: resending the status of ${cwd} failed: ${errorText(error)}`);
    }
  }
}

/** @brief 做一个作业；快照状态（state、reason、error、skipped、nested）变了时再发一次 git 状态。 */
async function noticeState<T>(path: PathState, job: () => Promise<T>): Promise<T> {
  const before = JSON.stringify(path.snap);
  try {
    return await job();
  } finally {
    if (JSON.stringify(path.snap) !== before) resend(path);
  }
}

// ---- git 调用 ----

/** @brief 中止之后不再起进程时的结果。 */
function abortedResult(): GitResult {
  return { code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, truncated: false, error: 'stopped' };
}

/** @brief 一次 git 调用（带可选的中止信号；已经中止时不起进程）。 */
function startGit(run: GitRun): Promise<GitResult> {
  if (run.signal?.aborted) return Promise.resolve(abortedResult());
  return runGit(run);
}

/**
 * @brief 内部仓库的一次 git 调用（§4.2）：固定的 --git-dir、--work-tree 与 -c，隔离的配置，--work-tree 与进程的 cwd
 *        默认是工作路径（refsOnly 时是内部仓库的目录），按内部仓库排队；超时默认 stepTimeoutMs，stdout 默认 16 MB。
 * @param path 工作路径
 * @param args 子命令及参数（可以以全局选项开头，例如 --literal-pathspecs、-c）
 * @param options 选项
 */
function internalGit(path: PathState, args: readonly string[], options: CallOptions = {}): Promise<GitResult> {
  const tree = options.refsOnly ? path.queue.repo : path.cwd;
  return startGit({
    args: [...internalArgs(path.queue.repo, tree), ...args], cwd: tree, key: path.queue.key,
    isolated: true,
    timeoutMs: options.timeoutMs ?? limits.stepTimeoutMs, maxOutput: options.maxOutput ?? GIT_OUTPUT.other,
    ...(options.stdin ? { stdin: options.stdin } : {}), ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** @brief 你的仓库的一次只读 git 调用（用你的配置，键是仓库根，超时 stepTimeoutMs）。 */
function userGit(path: PathState, repo: RepoInfo, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
  return startGit({ args: [...args], cwd: path.cwd, key: repo.toplevel, timeoutMs: limits.stepTimeoutMs,
    maxOutput: GIT_OUTPUT.other, ...(signal ? { signal } : {}) });
}

/**
 * @brief 检查一次 git 调用：被停止、超时（之后清锁）、失败时抛 StepError。
 * @param path 工作路径
 * @param result 结果
 * @param signal 这个作业的中止信号
 * @param allowTruncated stdout 超过上限时照样返回（调用方看 truncated）
 */
function expectOk(path: PathState, result: GitResult, signal?: AbortSignal, allowTruncated = false): GitResult {
  if (signal?.aborted) {
    path.queue.dirty = true;
    throw new StepError('stopped', 'aborted');
  }
  if (result.timedOut) {
    path.queue.dirty = true;
    throw new StepError(TIMEOUT_ERROR, 'timeout');
  }
  if (result.truncated) {
    path.queue.dirty = true;
    if (allowTruncated) return result;
  }
  if (result.code !== 0 || result.error !== null) throw new StepError(gitError(result), 'error');
  return result;
}

// ---- 拍一张快照（§4.4） ----

/** @brief 写 mori.json（§4.1）。 */
async function writeOwner(repo: string, cwd: string): Promise<void> {
  await writeFile(win32.join(repo, MORI_FILE), `${JSON.stringify({ cwd })}\n`);
}

/** @brief 读 mori.json 记下的工作路径；没有这个文件为 null，内容不对时抛错。 */
async function readOwner(repo: string): Promise<string | null> {
  const text = await readText(win32.join(repo, MORI_FILE));
  if (text === '') return null;
  const cwd = (JSON.parse(text) as { cwd?: unknown } | null)?.cwd;
  if (typeof cwd !== 'string' || cwd === '') throw new Error(`${MORI_FILE} in ${repo} has no working directory`);
  return cwd;
}

/** @brief 写 info/attributes（§4.1）：快照按字节原样存、原样恢复。 */
async function writeAttributes(repo: string): Promise<void> {
  await mkdir(win32.join(repo, 'info'), { recursive: true });
  await writeFile(win32.join(repo, 'info', 'attributes'), ATTRIBUTES);
}

/**
 * @brief 有 HEAD 的内部仓库的 info/attributes 不在或内容不对时重写并记日志：建立在 git init 之后、写它之前被打断
 *        （后台进程被强行结束、写文件失败）时有 HEAD 却没有它，不补上的话之后每张快照都按你的 .gitattributes 转换。
 */
async function repairAttributes(repo: string): Promise<void> {
  if ((await readText(win32.join(repo, 'info', 'attributes'))) === ATTRIBUTES) return;
  console.error(`[kernel] snapshots: info/attributes was missing or different in ${repo}; rewriting it`);
  await writeAttributes(repo);
}

/**
 * @brief 第一次时建立内部仓库（§4.1、§4.4 第 1 步）：没有 HEAD 说明 git init 没做完（里面还没有快照），先删掉半成的目录
 *        （连同它留下的 config.lock、HEAD.lock），再 git init、写 mori.json 与 info/attributes，last 置为 null。
 *        建立作为一个整体做完：git init 不带中止信号（只要几十毫秒），否则停止落在 init 里会留下锁或没有 info/attributes
 *        的仓库；建好之后才看信号，被停止时按停止抛出，快照的其余步骤不做。
 */
async function createRepo(path: PathState, signal?: AbortSignal): Promise<void> {
  const repo = path.queue.repo;
  await rm(repo, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });
  expectOk(path, await internalGit(path, ['init', '--quiet']));
  await writeOwner(repo, path.cwd);
  await writeAttributes(repo);
  path.timeline = { ...path.timeline, last: null };
  path.owned = true;
  path.exclude = null;
  if (signal?.aborted) throw new StepError('stopped', 'aborted');
}

/**
 * @brief 内部仓库在不在、归不归这个工作路径（§4.1）：没有 HEAD 就建立；有时按 mori.json 认归属（没有这个文件时写上），
 *        这次后台进程里第一次确认归属时再检查 info/attributes（repairAttributes）。
 * @return 归属冲突时为 mori.json 里的工作路径，否则为 null
 */
async function ensureRepo(path: PathState, signal?: AbortSignal): Promise<string | null> {
  const repo = path.queue.repo;
  if (!(await fileExists(win32.join(repo, 'HEAD')))) {
    await createRepo(path, signal);
    return null;
  }
  if (path.owned) return null;
  const owner = await readOwner(repo);
  if (owner !== null && resolve(owner) !== path.cwd) return owner;
  if (owner === null) await writeOwner(repo, path.cwd);
  await repairAttributes(repo);
  path.owned = true;
  return null;
}

/**
 * @brief 生成 info/exclude（§4.3），内容变了才写。
 * @param path 工作路径
 * @param ignored 你的 git 说没跟踪、被忽略的（askIgnored）；不是 git 仓库为 null（用默认的五个目录）
 */
async function writeExclude(path: PathState, ignored: readonly string[] | null): Promise<void> {
  const text = excludeText(ignored);
  const file = win32.join(path.queue.repo, 'info', 'exclude');
  if (path.exclude === null) path.exclude = await readText(file);
  if (text === path.exclude) return;
  await mkdir(win32.dirname(file), { recursive: true });
  await writeFile(file, text);
  path.exclude = text;
}

/**
 * @brief 列出新文件 N（§4.4 第 2、3 步）。
 * @return 新文件；多于 maxNewFiles 个或输出被截断时为 null（暂停）
 */
async function listNewFiles(path: PathState, signal?: AbortSignal): Promise<string[] | null> {
  const result = expectOk(path, await internalGit(path, NEW_FILES_ARGS, { signal }), signal, true);
  if (result.truncated) return null;
  const files = nulList(result.stdout);
  return files.length > limits.maxNewFiles ? null : files;
}

/** @brief 因文件数暂停（§4.4 第 3 步）：不拍这一张，last 由 closeSegment 清空。 */
function pauseForCount(path: PathState): void {
  path.pause = 'count';
  path.snap.state = 'paused';
  path.snap.reason = COUNT_PAUSE;
  path.timeouts = 0;
}

/** @brief 降到上限内，恢复（这一张作为新的基准：暂停时 last 已清空）。 */
function resumeFromCount(path: PathState): void {
  path.pause = null;
  path.snap.state = 'on';
  path.snap.reason = null;
}

/** @brief 大于 maxFileBytes 的文件（异步 stat，分批）。 */
async function oversized(cwd: string, files: readonly string[]): Promise<string[]> {
  const big: string[] = [];
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const batch = files.slice(i, i + STAT_BATCH);
    const sizes = await Promise.all(batch.map((file) => stat(win32.join(cwd, file))
      .then((info) => info.size, () => 0)));
    batch.forEach((file, k) => {
      if (sizes[k] > limits.maxFileBytes) big.push(file);
    });
  }
  return big;
}

/**
 * @brief 要跳过的大文件（§4.4 第 4 步）：新文件里大于上限、又没有被你的 git 跟踪的。
 * @param path 工作路径
 * @param files 新文件 N
 * @param repo 这一刻认出的仓库；不是 git 仓库为 null
 */
async function largeFiles(path: PathState, files: readonly string[], repo: RepoInfo | null,
  signal?: AbortSignal): Promise<string[]> {
  const big = await oversized(path.cwd, files);
  if (big.length === 0 || repo === null) return big;
  const tracked = new Set<string>();
  for (const batch of argBatches(big, CMDLINE_LIMIT)) {
    const args = ['--literal-pathspecs', 'ls-files', '-z', '--', ...batch];
    const result = expectOk(path, await userGit(path, repo, args, signal), signal);
    for (const file of nulList(result.stdout)) tracked.add(file);
  }
  return big.filter((file) => !tracked.has(file));
}

/** @brief 问你的 git 得到的被忽略的文件（§4.3）。 */
interface IgnoredFiles {
  /** 没跟踪、被忽略的（目录带结尾的 /）：写进排除；不是 git 仓库时为 null */
  ignored: string[] | null;
  /** 你用 git add -f 跟踪、又匹配忽略规则的：内部仓库要 add -f；不是 git 仓库时为空 */
  forced: string[];
}

/**
 * @brief 一次问你的 git 被忽略的文件（§4.3，ls-files -t）：内部仓库自己读工作树里的 .gitignore，add -A 不加你强制跟踪的
 *        那些，所以另列出来要 add -f；不是 git 仓库时没有。
 * @param path 工作路径
 * @param repo 这一刻认出的仓库；不是 git 仓库为 null
 */
async function askIgnored(path: PathState, repo: RepoInfo | null, signal?: AbortSignal): Promise<IgnoredFiles> {
  if (repo === null) return { ignored: null, forced: [] };
  const result = expectOk(path, await userGit(path, repo, IGNORED_ARGS, signal), signal, true);
  if (result.truncated) console.error(`[kernel] snapshots: the list of ignored files was cut off in ${path.cwd}`);
  const ignored: string[] = [];
  const forced: string[] = [];
  for (const line of nulList(result.stdout)) {
    // -t 的写法：一个标签字母、一个空格、路径
    if (line.startsWith('? ')) ignored.push(line.slice(2));
    else if (line.length > 2 && !NEVER_FORCED.test(line.slice(2))) forced.push(line.slice(2));
  }
  return { ignored, forced: await presentFiles(path.cwd, forced) };
}

/** @brief 还在磁盘上的文件（删掉的由 add -A 记为删除，不 add -f）。 */
async function presentFiles(cwd: string, files: readonly string[]): Promise<string[]> {
  const present: string[] = [];
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const batch = files.slice(i, i + STAT_BATCH);
    const found = await Promise.all(batch.map((file) => lstat(win32.join(cwd, file))
      .then(() => true, () => false)));
    batch.forEach((file, k) => {
      if (found[k]) present.push(file);
    });
  }
  return present;
}

/** @brief 分批加入（每批一个 git 进程，每批都写进 index）。 */
async function addBatches(path: PathState, args: readonly string[], files: readonly string[],
  signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < files.length; i += limits.batch) {
    const stdin = nulJoin(files.slice(i, i + limits.batch));
    expectOk(path, await internalGit(path, args, { stdin, signal }), signal);
  }
}

/**
 * @brief 加入（§4.4 第 5 步）：要加的新文件多于 batch 条时先分批加（每批一个 git 进程，每批都写进 index），
 *        你的仓库强制跟踪的被忽略文件用 add -f 加（§4.3），然后 add -A 收尾改动与删除，跳过的大文件用 :(literal,exclude) 排除。
 */
async function addFiles(path: PathState, files: readonly string[], skipped: readonly string[],
  forced: readonly string[], signal?: AbortSignal): Promise<void> {
  const skip = new Set(skipped);
  const adding = files.filter((file) => !skip.has(file));
  if (adding.length > limits.batch) await addBatches(path, BATCH_ADD_ARGS, adding, signal);
  if (forced.length > 0) await addBatches(path, FORCE_ADD_ARGS, forced, signal);
  if (skipped.length === 0) {
    expectOk(path, await internalGit(path, ADD_ALL_ARGS, { signal }), signal);
    return;
  }
  const stdin = nulJoin(['.', ...skipped.map((file) => `:(literal,exclude)${file}`)]);
  expectOk(path, await internalGit(path, ADD_EXCLUDING_ARGS, { stdin, signal }), signal);
}

/**
 * @brief write-tree、commit-tree 与嵌套仓库（§4.4 第 6、7 步）：树没变时就是上一张（不建提交，nested 沿用）。
 * @return 这一张与树是否变了
 */
async function commitTree(path: PathState, signal?: AbortSignal): Promise<{ snap: Snap; changed: boolean }> {
  const tree = objectId(expectOk(path, await internalGit(path, ['write-tree'], { signal }), signal));
  const last = path.timeline.last;
  if (last !== null && last.tree === tree) return { snap: last, changed: false };
  const args = [...COMMIT_IDENTITY, 'commit-tree', tree, '-m', COMMIT_MESSAGE];
  const oid = objectId(expectOk(path, await internalGit(path, args, { signal }), signal));
  const listing = expectOk(path, await internalGit(path, ['ls-tree', '-r', '-z', tree], { signal }), signal, true);
  if (listing.truncated) console.error(`[kernel] snapshots: the tree listing was cut off in ${path.cwd}`);
  const links = parseGitlinks(listing.stdout);
  path.snap.nested = links.slice(0, LIST_LIMIT);
  path.snap.nestedTotal = links.length;
  return { snap: { oid, tree }, changed: true };
}

/** @brief 快照第 1–7 步（§4.4）；失败时抛错。 */
async function shootSteps(path: PathState, signal?: AbortSignal): Promise<Shot> {
  const owner = await ensureRepo(path, signal);
  if (owner !== null) {
    path.snap.state = 'off';
    path.snap.reason = ownerText(owner);
    return { kind: 'skipped' };
  }
  const info = await repoInfo(path.cwd);
  if (info.error !== null) throw new StepError(info.error, 'error');
  const ignored = await askIgnored(path, info.repo, signal);
  await writeExclude(path, ignored.ignored);
  const fresh = await listNewFiles(path, signal);
  if (fresh === null) {
    pauseForCount(path);
    return { kind: 'skipped' };
  }
  if (path.pause === 'count') resumeFromCount(path);
  const skipped = await largeFiles(path, fresh, info.repo, signal);
  await addFiles(path, fresh, skipped, ignored.forced, signal);
  const taken = await commitTree(path, signal);
  path.snap.error = null;
  path.snap.skipped = skipped.slice(0, LIST_LIMIT);
  path.snap.skippedTotal = skipped.length;
  path.timeouts = 0;
  return { kind: 'taken', ...taken };
}

/** @brief 一张没拍成（§4.4“超时”“其他失败”）：记 error 与日志；连续 3 张超时才暂停到后台进程重启。被停止的不算失败。 */
function failShot(path: PathState, error: unknown): Shot {
  if (error instanceof StepError && error.kind === 'aborted') return { kind: 'aborted' };
  const message = errorText(error);
  if (error instanceof StepError && error.kind === 'timeout') {
    path.timeouts += 1;
    if (path.timeouts >= TIMEOUT_PAUSE_COUNT) {
      path.pause = 'timeout';
      path.snap.state = 'paused';
      path.snap.reason = TIMEOUT_PAUSE;
    }
  } else {
    path.timeouts = 0;
  }
  path.snap.error = message;
  console.error(`[kernel] snapshot failed in ${path.cwd}: ${message}`);
  return { kind: 'failed', error: message };
}

/**
 * @brief 拍一张（§4.4 第 1–7 步）：off、因连续超时暂停时不拍；不抛错。
 * @param path 工作路径
 * @param signal 运行开始的快照被停止时中止（结束正在跑的 git 进程）
 */
async function shoot(path: PathState, signal?: AbortSignal): Promise<Shot> {
  if (path.snap.state === 'off' || path.pause === 'timeout') return { kind: 'skipped' };
  try {
    return await shootSteps(path, signal);
  } catch (error) {
    return failShot(path, error);
  }
}

// ---- 段、记录与 ref（§4.4 第 8 步、§4.5、§4.6、§4.7） ----

/** @brief 一段改动的文件（§4.5 第 2 步）：不算这一段时为 null；恢复集合里的文件去掉。 */
async function segmentFiles(path: PathState, snap: Snap, restoring: ReadonlySet<string> | null):
  Promise<ChangedFile[] | null> {
  const base = segmentBase(path.timeline, snap);
  if (base === null) return null;
  const args = ['diff', '--no-renames', '--raw', '--numstat', '-z', base, snap.oid];
  const files = parseRawNumstat(expectOk(path, await internalGit(path, args)).stdout);
  return restoring ? files.filter((file) => !restoring.has(file.path)) : files;
}

/** @brief 涉及的用户会话的 SessionManager：active 里的、开始的、结束的。 */
function managersFor(path: PathState, start: RunTicket | null, end: RunTicket | null): Map<string, SessionManager> {
  const managers = new Map(path.managers);
  if (start) managers.set(start.user, start.manager);
  if (end) managers.set(end.user, end.manager);
  return managers;
}

/** @brief 每个用户会话现在的叶子与条目；读不出的跳过并记日志。 */
function viewsOf(managers: ReadonlyMap<string, SessionManager>): Map<string, UserView> {
  const views = new Map<string, UserView>();
  for (const [user, manager] of managers) {
    try {
      views.set(user, { leaf: manager.getLeafId(), entries: manager.getEntries() });
    } catch (error) {
      console.error(`[kernel] snapshots: couldn't read the session ${user}: ${errorText(error)}`);
    }
  }
  return views;
}

/** @brief 只留 active 里还有运行的用户会话的 SessionManager。 */
function keepManagers(path: PathState, managers: ReadonlyMap<string, SessionManager>): void {
  const kept = new Map<string, SessionManager>();
  for (const run of path.timeline.active.values()) {
    const manager = managers.get(run.user);
    if (manager) kept.set(run.user, manager);
  }
  path.managers = kept;
}

/** @brief 包含这个工作路径或在它里面的别的工作路径（用 insideDir 比两边的 cwd，不读文件，两个方向都算）。 */
function relatedPaths(path: PathState): PathState[] {
  return [...paths.values()].filter((other) => other !== path
    && (insideDir(path.cwd, other.cwd) || insideDir(other.cwd, path.cwd)));
}

/** @brief 这一刻包含这个工作路径或在它里面的别的工作路径上有运行（§4.5 第 3 步）。 */
function nestedRunning(path: PathState): boolean {
  return relatedPaths(path).some((other) => other.timeline.active.size > 0);
}

/**
 * @brief 一段结束时嵌套的工作路径算不算同时在跑（§4.5 第 3 步、§17）：这一刻有运行，或这一段里有过运行（嵌套的工作路径各有
 *        自己的时间线，那边的运行结束不会把这一段切开，所以段开始时还在跑、中途开始的都记在 nestedSeen 里）；
 *        之后 nestedSeen 只留“这一刻还在跑”。
 */
function nestedOverlap(path: PathState): boolean {
  const running = nestedRunning(path);
  const seen = path.nestedSeen || running;
  path.nestedSeen = running;
  return seen;
}

/** @brief 一次运行在这个工作路径上开始：包含它或在它里面的工作路径的这一段都算有嵌套的运行。 */
function markNested(path: PathState): void {
  for (const other of relatedPaths(path)) other.nestedSeen = true;
}

/**
 * @brief refs/mori/s/<会话 id>/<组>/<提交>（§4.7）；组是轮的条目 id、run 或 rewind/<条目 id>。id 写法不对时为 null 并记日志。
 * @param sessionId 用户会话 id
 * @param group 组
 * @param oid 提交；省略时给出组的前缀（以 / 结尾）
 */
function sessionRef(sessionId: string, group: string, oid = ''): string | null {
  if (!REF_PART.test(sessionId) || !group.split('/').every((part) => REF_PART.test(part))) {
    console.error(`[kernel] snapshots: can't name a ref for session ${sessionId}, ${group}`);
    return null;
  }
  return `${SESSION_REFS}${sessionId}/${group}/${oid}`;
}

/** @brief 这一张要写、要删的 ref（§4.7）：refs/mori/last、每条记录用到的提交、进行中运行的 run/ 下的开始快照。 */
function refLines(result: CloseResult, last: Snap | null, start: RunTicket | null, end: RunTicket | null): string[] {
  const lines = new Map<string, string>();
  const keep = (sessionId: string, group: string, oid: string | null): void => {
    const ref = oid === null ? null : sessionRef(sessionId, group, oid);
    if (ref !== null && oid !== null) lines.set(ref, `update ${ref} ${oid}`);
  };
  if (last) lines.set(LAST_REF, `update ${LAST_REF} ${last.oid}`);
  for (const { user, record } of result.changes) {
    keep(user, record.round, record.base);
    keep(user, record.round, record.head);
  }
  if (result.run) {
    keep(result.run.user, result.run.record.round, result.run.record.start);
    keep(result.run.user, result.run.record.round, result.run.record.end);
  }
  const ended = end?.run.own?.start ?? null;
  const endedRef = end && ended !== null ? sessionRef(end.user, 'run', ended) : null;
  if (endedRef !== null && !lines.has(endedRef)) lines.set(endedRef, `delete ${endedRef}`);
  if (start) keep(start.user, 'run', start.run.own?.start ?? null);
  return [...lines.values()];
}

/**
 * @brief update-ref --stdin 一次写完（§4.4 第 8 步）。
 * @return 失败时为原文（并记日志），否则为 null
 */
async function writeRefs(path: PathState, lines: readonly string[]): Promise<string | null> {
  if (lines.length === 0) return null;
  const stdin = Buffer.from(`${lines.join('\n')}\n`);
  const result = await internalGit(path, ['update-ref', '--stdin'], { stdin, refsOnly: true });
  if (result.code === 0 && !result.timedOut) return null;
  if (result.timedOut) path.queue.dirty = true;
  const message = gitError(result);
  console.error(`[kernel] snapshots: couldn't update refs in ${path.queue.repo}: ${message}`);
  return message;
}

/**
 * @brief 记录写进哪个 SessionManager（§4.6）：会话登记着时用登记的那个（会话在作业排队期间被关掉又重新打开时是新的
 *        SessionManager：经旧的写会把当前分支拉回旧的叶子、界面也收不到事件）；已释放时用运行登记时记下的那个，但会话文件
 *        已经不在（会话被删掉）时不写并记日志，否则 pi 的追加会重新建出一个只有记录、没有会话头的文件。
 *        检查与追加之间没有 await。内存里的 SessionManager（不写文件）照常写。
 * @param userId 用户会话 id
 * @param manager 运行登记时记下的 SessionManager
 * @return 要写进的 SessionManager 与要不要发事件；不写时为 null
 */
function recordTarget(userId: string, manager: SessionManager | undefined):
  { manager: SessionManager; user: SnapshotUser | null } | null {
  const user = users.get(userId);
  if (user) return { manager: user.sessionManager, user };
  if (!manager) return null;
  const file = manager.getSessionFile();
  if (manager.isPersisted() && (file === undefined || !existsSync(file))) {
    console.error(`[kernel] snapshots: the session file of ${userId} is gone; not recording the changes`);
    return null;
  }
  return { manager, user: null };
}

/**
 * @brief 写一条 mori.turn_changes（§4.6）：写进 recordTarget 选出的 SessionManager；会话还登记着时发同名事件。
 * @return 写进的 SessionManager（retain 用它读条目）；没写时为 undefined
 */
function writeTurn(userId: string, manager: SessionManager | undefined, record: TurnChanges):
  SessionManager | undefined {
  try {
    const target = recordTarget(userId, manager);
    if (target === null) return undefined;
    const entryId = target.manager.appendCustomEntry(WORKSPACE_ENTRY_TYPES.turnChanges, record);
    target.user?.emit({ type: 'mori.turn_changes', entryId, record });
    return target.manager;
  } catch (error) {
    console.error(`[kernel] snapshots: couldn't record the changes in ${userId}: ${errorText(error)}`);
    return undefined;
  }
}

/** @brief 列出一个前缀下的 ref；失败时抛 StepError。 */
async function listRefs(path: PathState, prefix: string, count?: number): Promise<string[]> {
  const args = ['for-each-ref', '--format=%(refname)', ...(count ? [`--count=${count}`] : []), prefix];
  const options = { timeoutMs: GIT_TIMEOUTS.quick, refsOnly: true };
  return refNames(expectOk(path, await internalGit(path, args, options)));
}

/**
 * @brief 保留最近 keepTurns 轮（§4.7）：写下一条 run 记录后，按会话文件里 mori.turn_changes 的先后删掉最早那些轮的 ref；
 *        记录不删，rewind/、run/ 下的 ref 不算轮。
 */
async function retain(path: PathState, user: string, manager: SessionManager | undefined): Promise<void> {
  if (!manager || !REF_PART.test(user)) return;
  const drop = new Set(roundsToDrop(manager.getEntries(), limits.keepTurns));
  if (drop.size === 0) return;
  try {
    const refs = await listRefs(path, `${SESSION_REFS}${user}/`);
    const lines = refs.filter((ref) => {
      const parts = ref.split('/');
      return parts.length === 6 && drop.has(parts[4]);
    }).map((ref) => `delete ${ref}`);
    await writeRefs(path, lines);
  } catch (error) {
    console.error(`[kernel] snapshots: couldn't remove old turns of ${user}: ${errorText(error)}`);
  }
}

/**
 * @brief 一张快照做完（或没拍成）之后（§4.4 第 8 步）：算这一段的文件（diff 失败时这一张按失败算）；开始的运行填上开始快照；
 *        closeSegment 得出记录与新的时间线；先写 ref，再写记录；写了 run 记录时按保留的轮数整理。
 *        停止可能落在这一段的 diff 里：被停止的运行在 diff 之后、登记之前（中间没有 await）才排除，不登记进 active；
 *        登记之后（写 ref 时）的停止由 startJob 在同一个作业里去掉。
 * @param path 工作路径
 * @param shot 这一张
 * @param mark 这一张是谁的开始、谁的结束，恢复集合
 */
async function closeShot(path: PathState, shot: Shot, mark: Mark): Promise<void> {
  let snap = shot.kind === 'taken' ? shot.snap : null;
  let files: ChangedFile[] | null = null;
  try {
    files = snap ? await segmentFiles(path, snap, mark.restoring) : null;
  } catch (error) {
    failShot(path, error);
    snap = null;
  }
  const start = mark.start !== null && !mark.start.cancelled ? mark.start : null;
  if (start?.run.own) start.run.own.start = shot.kind === 'taken' ? shot.snap.oid : null;
  const managers = managersFor(path, start, mark.end);
  const result = closeSegment({
    timeline: path.timeline, snap, files, start: start ? { key: start.pi, run: start.run } : null,
    end: mark.end?.pi ?? null, views: viewsOf(managers), nested: nestedOverlap(path), at: Date.now(),
  });
  path.timeline = result.timeline;
  keepManagers(path, managers);
  if (start) markNested(path);
  const changed = shot.kind === 'taken' && shot.changed;
  await writeRefs(path, refLines(result, snap && changed ? snap : null, start, mark.end));
  for (const { user, record } of result.changes) writeTurn(user, managers.get(user), record);
  if (result.run) {
    const written = writeTurn(result.run.user, managers.get(result.run.user), result.run.record);
    await retain(path, result.run.user, written);
  }
}

// ---- 运行的开始与结束（§4.5） ----

/** @brief 在用户会话的信封上发 mori.snapshot_stage（会话还登记着时）。 */
function emitStage(user: SnapshotUser, active: boolean): void {
  if (users.get(user.sessionId) !== user) return;
  try {
    user.emit({ type: 'mori.snapshot_stage', active });
  } catch (error) {
    console.error(`[kernel] snapshots: couldn't send the snapshot stage to ${user.sessionId}: ${errorText(error)}`);
  }
}

/**
 * @brief 运行开始的快照作业：被停止的不拍；拍完（或不拍、失败）后登记这次运行。停止落在登记之后（closeShot 还在写 ref）时，
 *        在这个作业里按没开始的运行去掉（§4.5“停止”：不登记、没有结束快照）：这时运行记录已不在表里，之后的 agent_settled、
 *        promptEnded 都找不到它，不在这里去掉就会一直留在 active 里。
 */
async function startJob(ticket: RunTicket): Promise<void> {
  try {
    if (ticket.cancelled) return;
    const path = ticket.path;
    await noticeState(path, async () => {
      const shot = await shoot(path, ticket.abort.signal);
      if (shot.kind !== 'aborted') await closeShot(path, shot, { start: ticket, end: null, restoring: null });
    });
    if (ticket.cancelled) await dropRunJob(ticket);
  } finally {
    ticket.starting = false;
  }
}

/** @brief 运行结束的快照作业：这次运行登记着时拍结束快照、去掉它并写 run 记录。 */
async function endJob(ticket: RunTicket): Promise<void> {
  const path = ticket.path;
  if (path.timeline.active.get(ticket.pi) !== ticket.run) return;
  await noticeState(path, async () => {
    const shot = await shoot(path);
    await closeShot(path, shot, { start: null, end: ticket, restoring: null });
  });
}

/** @brief 没开始的运行（§4.5）：从 active 去掉，删掉 run/ 下的开始快照 ref，不拍结束快照。 */
async function dropRunJob(ticket: RunTicket): Promise<void> {
  const path = ticket.path;
  if (path.timeline.active.get(ticket.pi) !== ticket.run) return;
  path.timeline = withoutRun(path.timeline, ticket.pi);
  keepManagers(path, path.managers);
  const start = ticket.run.own?.start ?? null;
  const ref = start === null ? null : sessionRef(ticket.user, 'run', start);
  if (ref !== null) await writeRefs(path, [`delete ${ref}`]);
}

/** @brief 去掉一个运行记录；还没停止的排一个 dropRunJob。 */
function dropTicket(ticket: RunTicket): void {
  tickets.delete(ticket.pi);
  if (ticket.cancelled) return;
  void enqueue(ticket.path, () => dropRunJob(ticket)).catch((error: unknown) => {
    console.error(`[kernel] snapshots: dropping the run of ${ticket.pi} failed: ${errorText(error)}`);
  });
}

/** @brief before_agent_start 时记下这次运行（同一个 pi 会话还留着上一次的记录时按没开始的运行去掉）。 */
function openTicket(source: RunSource, event: BeforeAgentStartEvent, ctx: ExtensionContext,
  user: SnapshotUser): RunTicket {
  const pi = ctx.sessionManager.getSessionId();
  const stale = tickets.get(pi);
  if (stale) dropTicket(stale);
  const path = pathOf(ctx.cwd);
  const own = source.self
    ? { start: null, leaf: ctx.sessionManager.getLeafId(), byUser: event.messageType === 'user' } : null;
  let release: () => void = () => undefined;
  const stopped = new Promise<void>((resolveStop) => {
    release = resolveStop;
  });
  const ticket: RunTicket = {
    pi, path, rawCwd: ctx.cwd, user: source.userSessionId, manager: user.sessionManager,
    run: { user: source.userSessionId, agent: source.agent(), own }, stage: source.self, starting: true,
    started: false, cancelled: false, abort: new AbortController(), stopped, release,
  };
  tickets.set(pi, ticket);
  return ticket;
}

/** @brief 去掉一个还没排作业的运行记录（git 不是 ok、已被停止）。 */
function closeTicket(ticket: RunTicket): void {
  ticket.starting = false;
  if (tickets.get(ticket.pi) === ticket) tickets.delete(ticket.pi);
}

/**
 * @brief before_agent_start（§4.5）：增强会话、没登记的会话、git 不是 ok 时什么都不做；否则排运行开始的快照作业并等它做完
 *        （或被停止）。用户会话自己的运行在排作业之前发 mori.snapshot_stage { active: true }，结束时发 { active: false }。
 *        git 的状态用 findGit()（还没找过时找一次，§3.2 第 3 步；找过就用记下的）：后台进程刚启动、界面的 workspace.status
 *        还没回来时开始的运行也拍快照。先记下运行再等它，这期间的停止也能找到这次运行、不用等找完。
 */
async function startRun(source: RunSource, event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
  try {
    const user = users.get(source.userSessionId);
    if (!user || user.headless) return;
    const ticket = openTicket(source, event, ctx, user);
    const git = await Promise.race([findGit(), ticket.stopped.then(() => null)]);
    if (git === null || git.state !== 'ok' || ticket.cancelled) {
      closeTicket(ticket);
      return;
    }
    if (ticket.stage) emitStage(user, true);
    try {
      const job = enqueue(ticket.path, () => startJob(ticket)).catch((error: unknown) => {
        console.error(`[kernel] snapshots: the start snapshot in ${ctx.cwd} failed: ${errorText(error)}`);
      });
      await Promise.race([job, ticket.stopped]);
    } finally {
      if (ticket.stage) emitStage(user, false);
    }
  } catch (error) {
    console.error(`[kernel] snapshots: starting the run in ${ctx.cwd} failed: ${errorText(error)}`);
  }
}

/** @brief agent_start：pi 真的开始了这次运行（promptEnded 据此不去掉它）。 */
function noteStarted(ctx: ExtensionContext): void {
  const ticket = tickets.get(ctx.sessionManager.getSessionId());
  if (ticket) ticket.started = true;
}

/** @brief 一轮结束时立即读 git 状态（§3.5“一轮结束”）；不抛错。 */
function readAfterTurn(cwd: string): void {
  readStatus(cwd).catch((error: unknown) => {
    console.error(`[kernel] snapshots: reading the git status of ${cwd} failed: ${errorText(error)}`);
  });
}

/**
 * @brief agent_settled（§4.5）：排运行结束的快照作业，不等。用户会话自己的运行在结束快照做完（或失败）后立即读 git 状态
 *        （§3.5）；没有结束快照（开始快照前被停止、没登记、git 不是 ok）时立即读。
 * @param source 这个会话是谁
 * @param ctx 事件的 ctx
 */
function endRun(source: RunSource, ctx: ExtensionContext): void {
  const pi = ctx.sessionManager.getSessionId();
  const ticket = tickets.get(pi);
  if (ticket) tickets.delete(pi);
  if (!ticket || ticket.cancelled) {
    if (source.self) readAfterTurn(ctx.cwd);
    return;
  }
  void enqueue(ticket.path, () => endJob(ticket)).catch((error: unknown) => {
    console.error(`[kernel] snapshots: the end snapshot in ${ticket.rawCwd} failed: ${errorText(error)}`);
  }).then(() => {
    if (source.self) readAfterTurn(ticket.rawCwd);
  });
}

/** @brief 改文件的工具执行完（§3.5）：duty、read 之外的调用去抖刷新 git 状态。 */
function refreshAfterTool(toolName: string, cwd: string): void {
  try {
    const kind = callKind(toolName, undefined);
    if (kind !== 'duty' && kind !== 'read') scheduleStatus(cwd);
  } catch (error) {
    console.error(`[kernel] snapshots: scheduling a status read for ${cwd} failed: ${errorText(error)}`);
  }
}

/**
 * @brief inline extension mori-snapshots（§4.5，必需）：用户会话与实例会话都注册；看不见的增强会话只做工具执行完的刷新。
 * @param source 这个会话是谁
 */
export function snapshotExtension(source: RunSource): ExtensionFactory {
  return (pi) => {
    pi.on('tool_execution_end', (event, ctx) => {
      refreshAfterTool(event.toolName, ctx.cwd);
    });
    if (source.headless) return;
    pi.on('before_agent_start', async (event, ctx) => {
      await startRun(source, event, ctx);
    });
    pi.on('agent_start', (_event, ctx) => {
      noteStarted(ctx);
    });
    pi.on('agent_settled', (_event, ctx) => {
      endRun(source, ctx);
    });
  };
}

/**
 * @brief prompt() 结束（§4.5）：pi 发了 before_agent_start 却没有开始运行（没有 agent_start、也不会有 agent_settled）时，
 *        把这次运行从“在运行”里去掉，不拍结束快照。运行已开始（插话、排队的 prompt 先结束）或开始快照还没做完时不动。
 * @param piSessionId 会话的 pi 会话 id
 */
export function promptEnded(piSessionId: string): void {
  const ticket = tickets.get(piSessionId);
  if (!ticket || ticket.starting || ticket.started) return;
  dropTicket(ticket);
}

/**
 * @brief 运行开始的快照还没做完时停止（§4.5“停止”，stopRun / release 在 abort 之前调用）：结束这个作业的 git 进程，
 *        before_agent_start 立刻返回；这次运行不登记、没有结束快照，也就没有 code restore。别人的作业不受影响。
 *        停止落在作业已登记这次运行之后（只剩写 ref）时，startJob 在同一个作业里把它从 active 去掉。
 * @param piSessionId 会话的 pi 会话 id
 */
export function stopStartSnapshot(piSessionId: string): void {
  const ticket = tickets.get(piSessionId);
  if (!ticket || !ticket.starting || ticket.cancelled) return;
  ticket.cancelled = true;
  ticket.abort.abort();
  ticket.release();
  tickets.delete(piSessionId);
}

// ---- 给 rewind.ts 与命令 ----

/**
 * @brief 在这个工作路径的队列里做一个作业（rewind.ts 的 Rewind / Undo）：作业里可以 takeSnapshot、snapshotGit、refsKept、
 *        keepRefs；快照状态变了时再发一次 git 状态。带 rewinder 时作业排着、做着期间 isRewinding(rewinder) 为真。
 * @param cwd 工作路径
 * @param job 作业
 * @param rewinder 正在 Rewind 的用户会话 id
 */
export function inQueue<T>(cwd: string, job: () => Promise<T>, rewinder?: string): Promise<T> {
  let path: PathState;
  try {
    path = pathOf(cwd);
  } catch (error) {
    return Promise.reject(error);
  }
  const counts = path.queue.rewinding;
  if (rewinder !== undefined) counts.set(rewinder, (counts.get(rewinder) ?? 0) + 1);
  const run = enqueue(path, () => noticeState(path, job));
  if (rewinder === undefined) return run;
  return run.finally(() => {
    const left = (counts.get(rewinder) ?? 1) - 1;
    if (left > 0) counts.set(rewinder, left);
    else counts.delete(rewinder);
  });
}

/** @brief 这个用户会话有经 inQueue（带 rewinder）排着或正在做的作业。 */
export function isRewinding(sessionId: string): boolean {
  for (const queue of queues.values()) if (queue.rewinding.has(sessionId)) return true;
  return false;
}

/**
 * @brief 在当前作业里拍一张（只在 inQueue 的作业里调用）：保险快照 P、恢复后快照 Q（§5.6、§5.7）。它是时间线上普通的一张，
 *        之前那一段照常记给当时在运行的会话，恢复集合 restoring 里的文件不记给任何人。
 * @param cwd 工作路径
 * @param restoring 恢复集合 R（P 为 null）
 * @return 这一张的提交；没拍成（失败、暂停、off）时为原文
 */
export async function takeSnapshot(cwd: string, restoring: ReadonlySet<string> | null):
  Promise<{ oid: string } | { error: string }> {
  const git = await findGit();
  if (git.state !== 'ok') return { error: gitReason(git) };
  let path: PathState;
  try {
    path = pathOf(cwd);
  } catch (error) {
    console.error(`[kernel] snapshots: no snapshot folder for ${cwd}: ${errorText(error)}`);
    return { error: errorText(error) };
  }
  const shot = await shoot(path);
  if (shot.kind !== 'aborted') await closeShot(path, shot, { start: null, end: null, restoring });
  if (shot.kind === 'taken') return { oid: shot.snap.oid };
  if (shot.kind === 'failed') return { error: shot.error };
  return { error: path.snap.reason ?? GIT_REQUIRED };
}

/**
 * @brief 这个工作路径的内部仓库目录（rewind.ts 按需要用；快照目录没设时抛错）。
 * @param cwd 工作路径
 */
export function snapshotRepo(cwd: string): string {
  return pathOf(cwd).queue.repo;
}

/**
 * @brief 内部仓库的一次 git 调用（只在 inQueue 的作业里调用）：内部仓库的方式（§4.2），超时默认 stepTimeoutMs。
 * @param cwd 工作路径
 * @param args 子命令及参数（可以以 --literal-pathspecs 等全局选项开头）
 * @param options stdin、stdout 上限、超时
 */
export async function snapshotGit(cwd: string, args: readonly string[],
  options: { stdin?: Buffer; maxOutput?: number; timeoutMs?: number } = {}): Promise<GitResult> {
  const path = pathOf(cwd);
  const result = await internalGit(path, args, options);
  // 被超时结束的进程可能留下锁：下一个作业前清（调用方可以在同一个作业里先自己清）
  if (result.timedOut) path.queue.dirty = true;
  return result;
}

/** @brief 这个组下这些提交的 ref 都还在；git 失败时抛错。 */
async function refsKeptIn(path: PathState, sessionId: string, group: string, commits: readonly string[]):
  Promise<boolean> {
  const prefix = sessionRef(sessionId, group);
  if (prefix === null) return false;
  const names = new Set(await listRefs(path, prefix));
  return commits.every((oid) => names.has(`${prefix}${oid}`));
}

/**
 * @brief 一轮（或 rewind/<条目 id>）用到的提交的 ref 都还在（§4.7；只在 inQueue 的作业里调用）。为假时报 PRUNED_TEXT。
 * @param cwd 工作路径
 * @param sessionId 用户会话 id
 * @param group 轮的条目 id，或 rewind/<条目 id>
 * @param commits 提交
 */
export async function refsKept(cwd: string, sessionId: string, group: string, commits: readonly string[]):
  Promise<boolean> {
  return refsKeptIn(pathOf(cwd), sessionId, group, commits);
}

/**
 * @brief 在 refs/mori/s/<会话 id>/<组>/ 下给这些提交建 ref（§5.7 第 5 步的 rewind/<条目 id>；只在 inQueue 的作业里调用）。
 * @return 失败时为原文，否则为 null
 */
export async function keepRefs(cwd: string, sessionId: string, group: string, commits: readonly string[]):
  Promise<string | null> {
  const lines: string[] = [];
  for (const oid of commits) {
    const ref = sessionRef(sessionId, group, oid);
    if (ref === null) return `Can't name a ref for ${group}`;
    lines.push(`update ${ref} ${oid}`);
  }
  return writeRefs(pathOf(cwd), lines);
}

/** @brief diff 的失败结果。 */
function diffError(error: string): SnapshotDiff {
  return { patch: null, binary: false, truncated: false, error };
}

/** @brief 这一轮里第一次列出这个文件的记录的 base 与最后一次的 head（当前分支，§5.3）。 */
function diffEnds(manager: SessionManager, round: string, file: string): { base: string; head: string } | null {
  const records = turnEntries(manager.getBranch(), (id) => {
    console.error(`[kernel] snapshots: skipped an invalid mori.turn_changes entry ${id}`);
  }).flatMap(({ record }) => (record.kind === 'changes' && record.round === round
    && record.files.some((item) => item.path === file) ? [record] : []));
  if (records.length === 0) return null;
  return { base: records[0].base, head: records[records.length - 1].head };
}

/** @brief 截断的 patch 只留到最后一个完整的行。 */
function patchText(stdout: Buffer, truncated: boolean): string {
  if (!truncated) return stdout.toString('utf8');
  return stdout.subarray(0, stdout.lastIndexOf(0x0a) + 1).toString('utf8');
}

/** @brief snapshots.diff 在队列里的部分：ref 还在才 diff（10 秒，最多 1 MB）。 */
async function diffJob(path: PathState, sessionId: string, round: string, ends: { base: string; head: string },
  file: string): Promise<SnapshotDiff> {
  if (!(await refsKeptIn(path, sessionId, round, [ends.base, ends.head]))) return diffError(PRUNED_TEXT);
  // 只要这一个文件：路径按字面（:(literal)），去掉同名目录下的文件（文件变成了目录、或反过来时 git 会把它们一起列出）
  const args = ['diff', '--no-renames', ends.base, ends.head, '--', `:(literal)${file}`, `:(exclude,literal)${file}/`];
  const result = await internalGit(path, args, { timeoutMs: GIT_TIMEOUTS.quick, maxOutput: DIFF_LIMIT });
  if (result.timedOut || result.error !== null || (result.code !== 0 && !result.truncated)) {
    return diffError(gitError(result));
  }
  const patch = patchText(result.stdout, result.truncated);
  if (BINARY_PATCH.test(patch)) return { patch: null, binary: true, truncated: false, error: null };
  return { patch, binary: false, truncated: result.truncated, error: null };
}

/**
 * @brief snapshots.diff（§5.3）：这一轮这个文件的 diff，用第一次列出它的记录的 base 到最后一次的 head，在工作路径的队列里跑。
 *        二进制为 binary；没有差别时 patch 为空串；超过 1 MB 只给前 1 MB；ref 已被整理时 error 为 PRUNED_TEXT。
 * @param user 用户会话
 * @param round 轮的条目 id
 * @param file 相对工作路径的路径
 */
export async function snapshotDiff(user: SnapshotUser, round: string, file: string): Promise<SnapshotDiff> {
  const git = await findGit();
  if (git.state !== 'ok') return diffError(gitReason(git));
  try {
    const ends = diffEnds(user.sessionManager, round, file);
    if (ends === null) return diffError(NOT_LISTED);
    const path = pathOf(user.cwd);
    return await enqueue(path, () => diffJob(path, user.sessionId, round, ends, file));
  } catch (error) {
    const message = errorText(error);
    console.error(`[kernel] snapshots: the diff of ${file} in ${user.sessionId} failed: ${message}`);
    return diffError(message);
  }
}

/** @brief 这个内部仓库对应的工作路径上有打开的用户会话（增强会话不算）。 */
function userOpenAt(queue: Queue): boolean {
  for (const user of users.values()) {
    if (user.headless) continue;
    try {
      if (repoDir(user.cwd).toLowerCase() === queue.key) return true;
    } catch (error) {
      console.error(`[kernel] snapshots: checking the session ${user.sessionId} failed: ${errorText(error)}`);
      return true;
    }
  }
  return false;
}

/** @brief 删掉整个内部仓库目录，丢掉用它的工作路径在内存里的时间线与状态（§4.7）。 */
async function removeRepo(queue: Queue): Promise<void> {
  await rm(queue.repo, { recursive: true, force: true });
  console.log(`[kernel] snapshots: removed ${queue.repo}`);
  queue.fresh = false;
  queue.dirty = false;
  for (const path of paths.values()) {
    if (path.queue !== queue) continue;
    path.timeline = emptyTimeline();
    path.managers = new Map();
    path.snap = freshState();
    path.pause = null;
    path.timeouts = 0;
    path.owned = false;
    path.exclude = null;
    path.nestedSeen = false;
  }
}

/** @brief snapshots.drop 在队列里的部分（§4.7）。 */
async function dropJob(path: PathState, sessionId: string): Promise<{ error: string | null }> {
  const repo = path.queue.repo;
  if (!(await fileExists(win32.join(repo, 'HEAD')))) return { error: null };
  const owner = await readOwner(repo);
  if (owner !== null && resolve(owner) !== path.cwd) return { error: null };
  const mine = await listRefs(path, `${SESSION_REFS}${sessionId}/`);
  const failed = await writeRefs(path, mine.map((ref) => `delete ${ref}`));
  if (failed !== null) return { error: failed };
  if ((await listRefs(path, SESSION_REFS, 1)).length === 0 && !userOpenAt(path.queue)) {
    await removeRepo(path.queue);
    return { error: null };
  }
  const pruned = await internalGit(path, ['prune', '--expire=now'], { timeoutMs: GIT_TIMEOUTS.prune, refsOnly: true });
  if (pruned.code === 0 && !pruned.timedOut) return { error: null };
  if (pruned.timedOut) path.queue.dirty = true;
  const message = gitError(pruned);
  console.error(`[kernel] snapshots: git prune failed in ${repo}: ${message}`);
  return { error: message };
}

/**
 * @brief snapshots.drop（§4.7）：删除会话后排进那个工作路径的队列：删掉 refs/mori/s/<会话 id>/ 下的全部 ref；
 *        refs/mori/s/ 下已经没有 ref、也没有打开的用户会话在用这个工作路径时删掉整个内部仓库目录（连同内存里的时间线），
 *        否则 git prune --expire=now。没装 git 时什么都不删、不报错。
 * @param sessionId 删掉的会话 id
 * @param cwd 它的工作路径
 */
export async function dropSnapshots(sessionId: string, cwd: string): Promise<{ error: string | null }> {
  if (!REF_PART.test(sessionId)) return { error: `Not a session id: ${sessionId}` };
  if ((await findGit()).state !== 'ok') return { error: null };
  try {
    const path = pathOf(cwd);
    return await enqueue(path, () => noticeState(path, () => dropJob(path, sessionId)));
  } catch (error) {
    const message = errorText(error);
    console.error(`[kernel] snapshots: dropping the snapshots of ${sessionId} failed: ${message}`);
    return { error: message };
  }
}

/** @brief 有序退出（§4.5）：等所有工作路径的队列做完（被中止的运行的结束快照）；仍受主进程 3 秒的上限。 */
export async function drainSnapshots(): Promise<void> {
  while ([...queues.values()].some((queue) => queue.pending > 0)) {
    await Promise.allSettled([...queues.values()].map((queue) => queue.tail));
  }
}

/**
 * @brief 这个工作路径的快照状态（WorkspaceStatus.snapshots，§4.4）：git 不是 ok 时为 off（原因同右栏的原文）。
 * @param cwd 工作路径
 */
export function snapshotState(cwd: string): SnapshotState {
  const git = gitState();
  if (git.state !== 'ok') return { ...freshState(), state: 'off', reason: gitReason(git) };
  const path = paths.get(resolve(cwd));
  return path ? copyState(path.snap) : freshState();
}
