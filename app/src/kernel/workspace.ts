// 工作区模块（docs/specs/file-system.md §2，后台进程第 9 件事“工作区”）。这里有三部分：
// .work（docs/specs/file-system-permissions.md §7.10、§7.11）：Agent 的草稿、过程脚本与临时文件放在 <工作路径>\.work，
// 路径闸放行命令或写进 .work 的 write / edit 之前建它（不递归 mkdir，不覆盖你改过的 .gitignore，每次都检查、不缓存）；
// bash 与 PowerShell 工具经 customTools 换成同样的定义加上 spawnHook，在 env 的副本里把 TEMP、TMP、TMPDIR 指到
// .work\tmp 并去掉 CDPATH。从不改 process.env（所有会话共用一个后台进程）。
// git 状态（docs/specs/file-system.md §3.4、§3.5）：认仓库（两个 rev-parse，不缓存）、读 git status（porcelain v2，
// 解析在 timeline.ts），同一工作路径同一时刻只读一个、读的过程中再来的请求合成一次再读；每读完一次发给这个工作路径上
// 所有打开的用户会话；工具执行完的读去抖 500 毫秒；快照状态变了时用最近一次的结果加新的快照状态再发一次。
// worktree 与 Initialize git（docs/specs/file-system.md §11）：取名、建 worktree 的检查与 git 步骤、失败后按顺序撤掉、
// 打开时从分支恢复、列出与清理拥有 worktree 的会话的 worktree、从没打开的会话文件里读 mori.worktree、Initialize git。
// 都经 git.ts 的 runGit（同一仓库按 common dir 排队），只在命令里做，不在后台扫。
// 三部分都不监视、不轮询：只有去抖用的 setTimeout。

import { randomBytes } from 'node:crypto';
import {
  appendFile, lstat, mkdir, open, readFile, realpath, rm, rmdir, stat, writeFile, type FileHandle,
} from 'node:fs/promises';
import { win32 } from 'node:path';
import type { BashSpawnContext, SettingsManager, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { KernelEvent } from '../shared/protocol';
import {
  STATUS_FILE_LIMIT, WORK_DENIAL_PREFIX, WORKTREE_ENTRY_TYPE, WorktreeEntrySchema, worktreeOf,
  type RepoInfo, type SnapshotState, type WorkspaceStatus, type WorktreeCleanUp, type WorktreeEntry,
  type WorktreeItem, type WorktreePlace,
} from '../shared/workspace';
import { GIT_OUTPUT, GIT_TIMEOUTS, findGit, gitError, runGit, type GitResult } from './git';
import type { Pi } from './pi';
import { parsePorcelainV2 } from './timeline';

/** @brief 工作路径里 Agent 的草稿与临时文件夹的名字（§7）。 */
export const WORK_DIR = '.work';

/** @brief .work 下放命令临时文件的子文件夹。 */
const TMP_DIR = 'tmp';

/** @brief .work/.gitignore 的内容：忽略整个 .work（含 .gitignore 自己，§7.10）。 */
const WORK_IGNORE = '*\n';

/** @brief spawnHook 设成 workTmp 的变量（§7.11）。 */
const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'] as const;

/** @brief spawnHook 去掉、不设新值的变量（§7.11）。 */
const DROPPED_VARS = ['CDPATH'];

/** @brief 每条命令的临时目录：<cwd>\.work\tmp（§7.11）。 */
export function workTmp(cwd: string): string {
  return win32.join(cwd, WORK_DIR, TMP_DIR);
}

/** @brief commandScan 认得的变量值（§7.2）：TEMP、TMP、TMPDIR → workTmp(cwd)，与 spawnHook 设的值相同。 */
export function workVars(cwd: string): Record<(typeof TEMP_VARS)[number], string> {
  const tmp = workTmp(cwd);
  return { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
}

/**
 * @brief spawnHook（§7.11）：env 的副本里去掉 TEMP、TMP、TMPDIR 的各种大小写写法（Windows 上 env 名字不分大小写，
 *        同名不同写法时 Node 只用排序后第一个），再设成 workTmp(context.cwd)；同时去掉 CDPATH 的各种大小写写法
 *        （不设新值）；command、cwd 不变，传进来的 env 不改。
 * @param context pi 的 bash / PowerShell 工具在 spawn 之前给出的命令、工作路径（ctx.cwd）与环境
 */
export function workEnv(context: BashSpawnContext): BashSpawnContext {
  const replaced = new Set<string>([...TEMP_VARS, ...DROPPED_VARS]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(context.env)) {
    if (!replaced.has(name.toUpperCase())) env[name] = value;
  }
  return { ...context, env: { ...env, ...workVars(context.cwd) } };
}

/** @brief ensureWork 的结果：失败时 reason 为 §7.10 的原因（或 Node 的错误原文）。 */
export type WorkResult = { ok: true } | { ok: false; reason: string };

/** @brief 系统错误的 code；不是系统错误时为 undefined。 */
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * @brief 建一层文件夹（不递归）；已经有了时 stat（链接到文件夹的算文件夹）。
 * @param path 文件夹
 * @param notFolder 已有的不是文件夹时的原因
 * @return 成功为 null；不是文件夹或 stat 失败时为原因；mkdir 的其他错误照原样抛出
 */
async function ensureFolder(path: string, notFolder: string): Promise<string | null> {
  try {
    await mkdir(path);
    return null;
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
  }
  try {
    return (await stat(path)).isDirectory() ? null : notFolder;
  } catch (error) {
    return (error as Error).message;
  }
}

/** @brief 只在没有时写 .work/.gitignore（wx）：你改过的不覆盖。 */
async function writeIgnore(work: string): Promise<void> {
  try {
    await writeFile(win32.join(work, '.gitignore'), WORK_IGNORE, { flag: 'wx' });
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
  }
}

/**
 * @brief 建 .work（§7.10）：mkdir .work、只在没有时写 .gitignore、mkdir .work\tmp。都不递归：工作路径本身不在
 *        （第一步的 mkdir 报 ENOENT）时什么都不建、返回成功，不会把被删掉的 worktree 重新建出来。每次放行都调用，
 *        不缓存“已经建过”。失败时记 `[kernel] couldn't prepare .work in <cwd>: <原因>`。
 * @param cwd 工作路径（ctx.cwd）
 * @return 成功；失败时 reason 为 '.work is a file, not a folder'、'.work/tmp is a file, not a folder' 或 Node 的错误原文
 */
export async function ensureWork(cwd: string): Promise<WorkResult> {
  const work = win32.join(cwd, WORK_DIR);
  let reason: string | null;
  try {
    try {
      reason = await ensureFolder(work, '.work is a file, not a folder');
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return { ok: true };
      throw error;
    }
    if (reason === null) {
      await writeIgnore(work);
      reason = await ensureFolder(win32.join(work, TMP_DIR), '.work/tmp is a file, not a folder');
    }
  } catch (error) {
    reason = (error as Error).message;
  }
  if (reason === null) return { ok: true };
  console.error(`[kernel] couldn't prepare .work in ${cwd}: ${reason}`);
  return { ok: false, reason };
}

/**
 * @brief .work 建不起来时回给模型的拒绝原文（§14），开头是 DENIAL_PREFIXES 里的 WORK_DENIAL_PREFIX。
 * @param reason ensureWork 给出的原因
 */
export function workDenialText(reason: string): string {
  return `${WORK_DENIAL_PREFIX} (${reason}), so this call didn’t run. Tell the user.`;
}

/**
 * @brief 换掉 pi 内置的 bash、powershell（§7.11，createAgentSession 的 customTools）：同样的定义加上 spawnHook: workEnv，
 *        defaultActive 为 false（启用与否只按名字，与内置工具相同）。bash 照 pi 建内置工具时的做法带上设置里的
 *        shellCommandPrefix 与 shellPath，powershell 不带别的选项。
 * @param pi pi 模块
 * @param cwd 会话的工作路径
 * @param settings 这个会话的 pi 设置
 */
export function shellTools(pi: Pi, cwd: string, settings: SettingsManager): ToolDefinition[] {
  const bash = pi.createBashToolDefinition(cwd, { commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(), spawnHook: workEnv });
  const powershell = pi.createPowerShellToolDefinition(cwd, { spawnHook: workEnv });
  // pi 的定义带具体的参数与 details 类型；customTools 的元素类型是不带类型参数的 ToolDefinition，渲染回调的参数逆变，要显式转
  return [{ ...bash, defaultActive: false }, { ...powershell, defaultActive: false }] as ToolDefinition[];
}

// ---- git 状态（docs/specs/file-system.md §3.4、§3.5） ----

/** @brief repoInfo 的结果：不是 git 仓库时 repo、error 都为 null；认不出（例如 dubious ownership）时 error 为原文。 */
export interface RepoResult {
  /** 所在仓库；不是 git 仓库或认不出时为 null */
  repo: RepoInfo | null;
  /** 认仓库失败的原文（例如 dubious ownership、工作路径不存在）；是仓库或不是仓库时为 null */
  error: string | null;
}

/** @brief 这个工作路径上打开的一个用户会话（发 mori.workspace_status 用）。 */
export interface WorkspaceUser {
  /** 用户会话 id */
  sessionId: string;
  /** @brief 在这个会话的信封上发一个事件。 */
  emit(event: KernelEvent): void;
}

/** @brief 由 sessions.ts 在启动时给（configureWorkspace）：打开的用户会话与快照状态。 */
export interface WorkspaceHost {
  /** @brief 这个工作路径上所有打开的用户会话（按会话的 cwd，只算用户会话）。 */
  usersAt(cwd: string): WorkspaceUser[];
  /** @brief 这个工作路径的快照状态（snapshots.ts 的 snapshotState）。 */
  snapshotState(cwd: string): SnapshotState;
}

/** @brief 工具执行完之后读 git 状态的去抖（毫秒，§17）：最后一次之后这么久才读。 */
export const STATUS_DEBOUNCE_MS = 500;

/** @brief 认仓库的第一个 rev-parse（§3.4 第 1 步）。 */
const REV_PARSE_PATHS = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'];

/** @brief 有没有提交（§3.4 第 3 步）。 */
const REV_PARSE_HEAD = ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'];

/** @brief 读 git 状态（§3.5）：不刷新、不写回你的 index。 */
const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z'];

/** @brief 认出“不是 git 仓库”的 stderr（§17，LC_ALL=C）。 */
const NOT_A_REPO = 'not a git repository';

/** @brief 没有 WorkspaceHost 时的快照状态（还没接线时不会有会话，只为类型完整）。 */
const SNAPSHOTS_OFF: SnapshotState = {
  state: 'off', reason: null, error: null, skipped: [], skippedTotal: 0, nested: [], nestedTotal: 0,
};

/** @brief 一个工作路径的读状态。 */
interface StatusSlot {
  /** 正在进行的读；没有为 null */
  running: Promise<WorkspaceStatus> | null;
  /** 读的过程中又来的请求合成的“再读一次”；没有为 null */
  again: Promise<WorkspaceStatus> | null;
  /** 去抖的计时器；没有为 null */
  timer: ReturnType<typeof setTimeout> | null;
  /** 最近一次读到的结果（resendStatus 用）；还没读过为 null */
  last: WorkspaceStatus | null;
}

/** sessions.ts 给的宿主；启动之前为 null */
let host: WorkspaceHost | null = null;
/** 按工作路径（会话的 cwd 原样）的读状态；空闲且没有打开的用户会话时删掉 */
const slots = new Map<string, StatusSlot>();

/**
 * @brief 接上宿主（sessions.ts 启动时调用一次）：之后每次读完发给 usersAt(cwd) 的每个会话。
 * @param next 宿主
 */
export function configureWorkspace(next: WorkspaceHost): void {
  host = next;
}

/** @brief 异常的原文。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief git 给的路径换成反斜杠（§3.4 第 1 步）。 */
function backslashes(path: string): string {
  return path.replace(/\//g, '\\');
}

/** @brief rev-parse 失败是不是“不是 git 仓库”（§3.4 第 2 步）：退出码 128 且 stderr 含 not a git repository。 */
function notARepo(result: GitResult): boolean {
  return result.code === 128 && result.stderr.includes(NOT_A_REPO);
}

/**
 * @brief 认仓库（§3.4）：在工作路径里跑 rev-parse 取仓库根、共用的 .git 与自己的 git 目录，是仓库时再看有没有提交。
 *        不缓存：每次都重新认（你随时可能 git init、删 .git）。
 * @param cwd 工作路径
 * @return 是仓库时 repo；不是仓库时 repo 与 error 都为 null；其他失败时 error 为原文
 */
export async function repoInfo(cwd: string): Promise<RepoResult> {
  const quick = { cwd, timeoutMs: GIT_TIMEOUTS.quick, maxOutput: GIT_OUTPUT.other };
  const paths = await runGit({ ...quick, args: REV_PARSE_PATHS, key: cwd });
  // 超时、超过上限的输出不完整，退出码为 0 也算失败
  if (paths.code !== 0 || paths.timedOut || paths.truncated) {
    if (notARepo(paths)) return { repo: null, error: null };
    const error = gitError(paths);
    console.error(`[kernel] git rev-parse failed in ${cwd}: ${error}`);
    return { repo: null, error };
  }
  const lines = paths.stdout.toString('utf8').split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
  if (lines.length < 3) {
    console.error(`[kernel] git rev-parse gave unexpected output in ${cwd}: ${lines.join(' | ')}`);
    return { repo: null, error: 'git rev-parse gave unexpected output' };
  }
  const [toplevel, commonDir, gitDir] = lines.slice(0, 3).map(backslashes);
  const head = await runGit({ ...quick, args: REV_PARSE_HEAD, key: toplevel });
  if (head.error !== null || head.timedOut) {
    const error = gitError(head);
    console.error(`[kernel] git rev-parse HEAD failed in ${cwd}: ${error}`);
    return { repo: null, error };
  }
  const isWorktree = gitDir.toLowerCase() !== commonDir.toLowerCase();
  return { repo: { toplevel, commonDir, gitDir, isWorktree, hasCommit: head.code === 0 }, error: null };
}

/** @brief 读 git status 得到的部分。 */
type StatusPart = Pick<WorkspaceStatus, 'branch' | 'files' | 'total' | 'truncated' | 'error'>;

/**
 * @brief 在工作路径里跑 git status（§3.5，键是仓库根，10 秒，stdout 4 MB）并解析；路径相对仓库根。
 *        超时、失败时 error 为原文、files 为空、分支也不给；stdout 超过上限时解析到最后一个完整的条目、truncated 为真。
 * @param cwd 工作路径
 * @param repo 这一刻认出的仓库
 */
async function readGitStatus(cwd: string, repo: RepoInfo): Promise<StatusPart> {
  const result = await runGit({
    args: STATUS_ARGS, cwd, key: repo.toplevel, timeoutMs: GIT_TIMEOUTS.quick, maxOutput: GIT_OUTPUT.status,
  });
  if (result.error !== null || result.timedOut || (result.code !== 0 && !result.truncated)) {
    const error = gitError(result);
    console.error(`[kernel] git status failed in ${cwd}: ${error}`);
    return { branch: null, files: [], total: 0, truncated: false, error };
  }
  const parsed = parsePorcelainV2(result.stdout, STATUS_FILE_LIMIT);
  return {
    branch: parsed.branch, files: parsed.files, total: parsed.total,
    truncated: parsed.truncated || result.truncated, error: null,
  };
}

/** @brief 宿主给的快照状态；没有宿主或出错时为 off（出错记日志）。 */
function snapshotsOf(cwd: string): SnapshotState {
  if (host === null) return SNAPSHOTS_OFF;
  try {
    return host.snapshotState(cwd);
  } catch (error) {
    console.error(`[kernel] reading the snapshot state of ${cwd} failed: ${messageOf(error)}`);
    return SNAPSHOTS_OFF;
  }
}

/** @brief 这个工作路径上打开的用户会话；没有宿主或出错时为空（出错记日志）。 */
function usersOf(cwd: string): WorkspaceUser[] {
  if (host === null) return [];
  try {
    return host.usersAt(cwd);
  } catch (error) {
    console.error(`[kernel] listing the sessions at ${cwd} failed: ${messageOf(error)}`);
    return [];
  }
}

/** @brief 给这个工作路径上每个打开的用户会话发一个 mori.workspace_status（各自的信封）。 */
function publish(cwd: string, status: WorkspaceStatus): void {
  for (const user of usersOf(cwd)) {
    try {
      user.emit({ type: 'mori.workspace_status', status });
    } catch (error) {
      console.error(`[kernel] sending the git status to ${user.sessionId} failed: ${messageOf(error)}`);
    }
  }
}

/**
 * @brief 读一次（§3.5）：git 不是 ok 时不跑 git；认仓库；是仓库时读 git status；加上快照状态与读完的时刻，记下并发出。
 * @param cwd 工作路径
 * @param slot 这个工作路径的读状态
 * @return 读到的状态；不抛错
 */
async function readOnce(cwd: string, slot: StatusSlot): Promise<WorkspaceStatus> {
  const status: WorkspaceStatus = {
    cwd, git: { state: 'missing' }, repo: null, branch: null, files: [], total: 0, truncated: false, error: null,
    snapshots: SNAPSHOTS_OFF, at: 0,
  };
  try {
    status.git = await findGit();
    if (status.git.state === 'ok') {
      const found = await repoInfo(cwd);
      status.repo = found.repo;
      status.error = found.error;
      if (found.repo !== null) Object.assign(status, await readGitStatus(cwd, found.repo));
    }
  } catch (error) {
    status.error = messageOf(error);
    console.error(`[kernel] reading the git status of ${cwd} failed: ${status.error}`);
  }
  status.snapshots = snapshotsOf(cwd);
  status.at = Date.now();
  slot.last = status;
  publish(cwd, status);
  return status;
}

/** @brief 这个工作路径的读状态（没有就建）。 */
function slotOf(cwd: string): StatusSlot {
  let slot = slots.get(cwd);
  if (slot === undefined) {
    slot = { running: null, again: null, timer: null, last: null };
    slots.set(cwd, slot);
  }
  return slot;
}

/** @brief 空闲（没在读、没有再读、没有计时器）且这个工作路径上没有打开的用户会话时删掉读状态。 */
function pruneSlot(cwd: string, slot: StatusSlot): void {
  if (slot.running || slot.again || slot.timer) return;
  if (slots.get(cwd) === slot && usersOf(cwd).length === 0) slots.delete(cwd);
}

/** @brief 开始一次读，读完时清掉 running 并试着删掉空闲的读状态。 */
function startRead(cwd: string, slot: StatusSlot): Promise<WorkspaceStatus> {
  const read = readOnce(cwd, slot).finally(() => {
    if (slot.running === read) slot.running = null;
    pruneSlot(cwd, slot);
  });
  slot.running = read;
  return read;
}

/**
 * @brief 立即读 git 状态（§3.5）：同一工作路径同一时刻只读一个；正在读时又来的请求记成“还要再读”，读完后再读一次，
 *        多次请求合成一次，都等这次再读的结果，所以返回的总是请求发出之后开始读到的状态。结果发给这个工作路径上
 *        所有打开的用户会话（workspace.status 命令的结果与事件相同）。git 没找到、太旧时不重找（命令先 findGit(true)）。
 * @param cwd 工作路径（会话的 cwd）
 * @return 读到的状态；不抛错
 */
export function readStatus(cwd: string): Promise<WorkspaceStatus> {
  const slot = slotOf(cwd);
  if (slot.again !== null) return slot.again;
  if (slot.running === null) return startRead(cwd, slot);
  const again = slot.running.then(() => {
    slot.again = null;
    return startRead(cwd, slot);
  });
  slot.again = again;
  return again;
}

/**
 * @brief 改文件的工具执行完（§3.5）：这个工作路径去抖 STATUS_DEBOUNCE_MS，最后一次之后才读一次；只用 setTimeout。
 * @param cwd 工作路径
 */
export function scheduleStatus(cwd: string): void {
  const slot = slotOf(cwd);
  if (slot.timer !== null) clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void readStatus(cwd);
  }, STATUS_DEBOUNCE_MS);
}

/**
 * @brief 快照状态变了（§3.5、§4.4）：用最近一次读到的 git 状态加新的快照状态再发一次，不重新读 git、读完的时刻不变；
 *        这个工作路径还没读过时什么都不做。
 * @param cwd 工作路径
 */
export function resendStatus(cwd: string): void {
  const slot = slots.get(cwd);
  if (!slot?.last) return;
  slot.last = { ...slot.last, snapshots: snapshotsOf(cwd) };
  publish(cwd, slot.last);
}

// ---- worktree 与 Initialize git（docs/specs/file-system.md §11.2、§11.5.3、§11.6、§11.9、§11.11） ----

/** @brief worktree add / remove、Initialize git 的 add -A 与 commit 的默认超时（毫秒，§17）：各 120 秒。 */
export const WORKTREE_TIMEOUT_MS: number = GIT_TIMEOUTS.snapshot;

/** @brief 名字最多几个词（§11.2）。 */
const NAME_WORDS = 5;
/** @brief 名字（不含后缀）最多几个字符（§11.2）。 */
const NAME_CHARS = 30;
/** @brief 一个词也没有时的名字（§11.2）。 */
const NAME_FALLBACK = 'session';
/** @brief 撞名时最多试几个名字（§11.2、§17：都撞上时失败）。 */
const NAME_TRIES = 3;
/** @brief worktree 在 R 下的两段：<R>\.mori\worktrees\<名字>（§11.2）。 */
const WORKTREES_DIR = ['.mori', 'worktrees'];
/** @brief 分支名的前缀：mori/<名字>（§11.2）。 */
const BRANCH_PREFIX = 'mori/';
/** @brief info/exclude 里排除 worktree 的一行（§11.5.3 第 3 步、§17）。 */
const EXCLUDE_LINE = '.mori/worktrees/';
/** @brief 会话文件里 message 条目一行的开头：pi 写条目时 type 是第一个键（§11.6）。 */
const MESSAGE_LINE = '{"type":"message"';
/** @brief worktree add / remove 都带的长路径设置（§11.1 实测：不带时长路径检出失败、删不干净）。 */
const LONG_PATHS = ['-c', 'core.longpaths=true'];
/**
 * @brief 删文件夹（discardWorktree、removeLeftover）：递归、不在也算成功。Windows 上刚结束的进程（git、杀毒、索引）
 *        可能还占着文件，重试 5 次：Node 只对 EBUSY、EMFILE、ENFILE、ENOTEMPTY、EPERM 重试，等待线性递增
 *        （100…500 毫秒，合计约 1.5 秒；临时默认值，同 renameRetry.ts 的做法）。
 */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** @brief 固定的失败原文（§11.5.2、§11.5.3、§11.9、§11.11 与屏幕表 fs-worktree.md，照抄）。 */
const TEXTS = Object.freeze({
  gitForCreate: 'Git is required to create a worktree.',
  notRepo: 'This folder isn’t a git repository.',
  noCommits: 'This repository has no commits yet.',
  coreWorktree: 'This repository sets core.worktree, so Mori can’t create a worktree here. '
    + 'Move it to the main worktree’s config.worktree first.',
  gitForRestore: 'Git is required to restore this session’s worktree.',
  gitForCleanUp: 'Git is required to clean up worktrees.',
  gitForInit: 'Git is required to initialize a repository.',
  alreadyRepo: 'This folder is already a git repository.',
  identity: 'Git needs your name and email for the first commit. '
    + 'Set user.name and user.email with git config --global, then try again.',
});

/** @brief 建好的 worktree（createWorktree 的结果，§11.5.3 第 7 步）。 */
export interface CreatedWorktree {
  /** R：worktree 所在仓库的根（按会话 cwd 的写法） */
  root: string;
  /** worktree 根：<R>\.mori\worktrees\<名字>（mori.worktree 的 path） */
  path: string;
  /** mori/<名字> */
  branch: string;
  /** 主文件夹（§11.3）：R 接上 <sub>；与 worktreeOf(cwd).mainFolder 相同 */
  mainFolder: string;
  /** 会话的新工作路径：<路径>[\<sub>] */
  cwd: string;
}

/** @brief 开着的一个会话（WorktreeHost.openCwds 的一项）。 */
export interface OpenCwd {
  /** 这个会话自己的会话文件（用户会话的，或实例自己的）；没有时为 null */
  sessionFile: string | null;
  /** 这个会话的工作路径 */
  cwd: string;
  /** 实例：它所属用户会话的会话文件（与 worktrees.list 的 sessionFiles 同一种写法）；用户会话为 null */
  owner: string | null;
}

/** @brief worktrees.list / worktrees.cleanUp 要知道的开着的会话（由 sessions.ts 一侧给）。 */
export interface WorktreeHost {
  /** @brief 开着的用户会话与实例的工作路径；拥有某个 worktree 的会话自己与它的实例不算占用它（§11.9.1 inUse）。 */
  openCwds(): OpenCwd[];
  /** @brief 开着的、会话文件为 sessionFile 的用户会话拥有的 worktree（Entry.worktree）；没开着或没有时为 null。 */
  ownedBy(sessionFile: string): WorktreeEntry | null;
}

/** @brief 6 个小写十六进制字符（crypto.randomBytes(3)，§11.2）。 */
function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/**
 * @brief worktree 的名字（§11.2）：text 按空行分段，跳过前 refsCount 段（引用块），剩下的做 NFKD 分解、去掉附加符号、
 *        转小写，按不是 a-z0-9 的字符切成词；从头取最多 5 个词，用 - 连起来、不超过 30 个字符（第一个词就超过时
 *        截到 30 个字符）；一个词也没有时为 session；后面接 - 与后缀。
 * @param text 第一条消息的全文（session.prompt 的 text，引用块在你写的字之前）
 * @param refsCount 引用块的段数（refs.length）
 * @param rand 后缀（默认 6 个小写十六进制字符；测试注入）
 * @return <名字>-<后缀>，只含 a-z0-9-
 */
export function worktreeName(text: string, refsCount: number, rand: () => string = randomSuffix): string {
  const own = text.split('\n\n').slice(Math.max(0, refsCount)).join('\n');
  const words = own.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let name = '';
  for (const word of words.slice(0, NAME_WORDS)) {
    const next = name === '' ? word : `${name}-${word}`;
    if (next.length > NAME_CHARS) {
      if (name === '') name = word.slice(0, NAME_CHARS);
      break;
    }
    name = next;
  }
  return `${name || NAME_FALLBACK}-${rand()}`;
}

/** @brief 路径用的分隔符：有 \ 时为 \，否则为 /（同 shared/workspace.ts 的 worktreeOf）。 */
function sepOf(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

/** @brief 按 \ 与 / 切段，先去掉末尾的分隔符（盘符根 D:\ 得到 ['D:']）。 */
function segmentsOf(path: string): string[] {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/);
}

/** @brief 用 sep 把段接回路径；只剩盘符时补上分隔符，得到盘符根（同 worktreeOf）。 */
function joinPath(segments: string[], sep: string): string {
  const joined = segments.join(sep);
  return /^[A-Za-z]:$/.test(joined) ? `${joined}${sep}` : joined;
}

/** @brief 路径比较用的写法：分隔符统一为 \，去掉末尾的分隔符，小写（不分大小写、不分 \ 与 /）。 */
function pathKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** @brief inner 是 outer 本身或在它里面（按 pathKey 比较）。 */
function within(outer: string, inner: string): boolean {
  const base = pathKey(outer);
  const key = pathKey(inner);
  return key === base || key.startsWith(`${base}\\`);
}

/** @brief 时长的原文（§11.9.4、§11.11）：整秒时为 <n> seconds，否则为毫秒（测试注入的很短的超时）。 */
function durationText(ms: number): string {
  if (ms % 1000 !== 0) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/**
 * @brief 路径上有没有东西（lstat，不跟随链接）。只有 ENOENT、ENOTDIR 算没有；别的错误（例如没有权限）算有，
 *        记日志：撞名检查与清理都宁可当成有。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    console.error(`[kernel] couldn't check ${path}: ${messageOf(error)}`);
    return true;
  }
}

/**
 * @brief 是不是一个文件夹（stat，跟随链接）。任何错误都算不是；ENOENT、ENOTDIR 之外的错误（例如没有权限、
 *        别的进程正在删它）记日志。
 */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = codeOf(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.error(`[kernel] couldn't check ${path}: ${messageOf(error)}`);
    }
    return false;
  }
}

/** @brief git 调用成功：进程跑完、退出码 0、没超时、stdout 没被截断。 */
function succeeded(result: GitResult): boolean {
  return result.error === null && !result.timedOut && !result.truncated && result.code === 0;
}

/** @brief git 跑完了、退出码为 1（config --get 没设、show-ref 没有这个 ref）。 */
function exitedWithOne(result: GitResult): boolean {
  return result.error === null && !result.timedOut && result.code === 1;
}

/**
 * @brief 在 dir 里跑一次用户仓库的 git（§3.3、§15）：同 git -C <dir>；键是仓库的 common dir，同一个仓库的 worktree
 *        操作排队。
 * @param key 排队的键
 * @param dir 进程的工作目录
 * @param args git 之后的参数
 * @param timeoutMs 超时（默认 GIT_TIMEOUTS.quick）
 */
function repoGit(key: string, dir: string, args: string[], timeoutMs: number = GIT_TIMEOUTS.quick): Promise<GitResult> {
  return runGit({ args, cwd: dir, key, timeoutMs, maxOutput: GIT_OUTPUT.other });
}

/** @brief stderr 里 git 自己报错的一行的开头。 */
const FATAL_LINE = /^(?:fatal|error): /;

/**
 * @brief 失败的 git 原文：stderr 里有 fatal: / error: 开头的一行时取第一行这样的（去掉开头），否则同 gitError。
 *        worktree add 先在 stderr 写 Preparing worktree (…)，第一行不是原因（实测 2.55）。
 */
function failureText(result: GitResult): string {
  if (result.error !== null || result.timedOut) return gitError(result);
  const line = result.stderr.split(/\r?\n/).map((text) => text.trim()).find((text) => FATAL_LINE.test(text));
  return line === undefined ? gitError(result) : line.replace(FATAL_LINE, '');
}

/**
 * @brief 一次必须成功的 git 调用的结果：成功时为 stdout 去掉首尾空白；失败时记日志并抛出原文
 *        （超时为 timed out after <时长>，否则 failureText）。
 * @param result 结果
 * @param args 调用的参数（日志用）
 * @param dir 工作目录（日志用）
 * @param timeoutMs 这次调用的超时（原文用）
 */
function outputOf(result: GitResult, args: string[], dir: string, timeoutMs: number): string {
  if (succeeded(result)) return result.stdout.toString('utf8').trim();
  const error = result.timedOut ? `timed out after ${durationText(timeoutMs)}` : failureText(result);
  console.error(`[kernel] git ${args.join(' ')} failed in ${dir}: ${error}`);
  throw new Error(error);
}

/** @brief 跑一次必须成功的 git（参数同 repoGit）：返回 stdout 去掉首尾空白，失败时抛出原文（outputOf）。 */
async function mustGit(key: string, dir: string, args: string[],
  timeoutMs: number = GIT_TIMEOUTS.quick): Promise<string> {
  return outputOf(await repoGit(key, dir, args, timeoutMs), args, dir, timeoutMs);
}

/** @brief 跑一次清理用的 git（参数同 repoGit）：失败只记日志（mustGit 记），不抛错。 */
async function tryGit(key: string, dir: string, args: string[], timeoutMs: number = GIT_TIMEOUTS.quick): Promise<void> {
  try {
    await mustGit(key, dir, args, timeoutMs);
  } catch {
    // 原文已由 outputOf 记进日志；清理的每一步失败都接着做下一步（§11.5.3）
  }
}

/**
 * @brief 读一项 git 配置（args 如 ['--local', '--get', 'core.worktree']，在 dir 里跑）。
 * @return 值（去掉首尾空白）；没设（退出码 1）时为空串；其他失败时抛出原文
 */
async function configValue(key: string, dir: string, args: string[]): Promise<string> {
  const all = ['config', ...args];
  const result = await repoGit(key, dir, all);
  return exitedWithOne(result) ? '' : outputOf(result, all, dir, GIT_TIMEOUTS.quick);
}

/** @brief refs/heads/<branch> 在不在（show-ref --verify --quiet：退出码 0 在、1 不在）；读不出时抛出原文。 */
async function branchExists(key: string, dir: string, branch: string): Promise<boolean> {
  const args = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`];
  const result = await repoGit(key, dir, args);
  if (exitedWithOne(result)) return false;
  outputOf(result, args, dir, GIT_TIMEOUTS.quick);
  return true;
}

/** @brief dir 所在仓库的 common dir（rev-parse --git-common-dir，反斜杠）：worktree 操作排队的键；失败时抛出原文。 */
async function commonDir(dir: string): Promise<string> {
  return backslashes(await mustGit(dir, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

/** @brief git worktree list --porcelain 里登记的 worktree（pathKey 的写法）；失败时抛出原文。 */
async function registeredPaths(key: string, root: string): Promise<Set<string>> {
  const lines = (await mustGit(key, root, ['worktree', 'list', '--porcelain'])).split('\n');
  const paths = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('worktree ')) paths.add(pathKey(line.slice('worktree '.length).replace(/\r$/, '')));
  }
  return paths;
}

/**
 * @brief 这个 Mori worktree 在不在登记里（§11.9.1 第 1 步：不分大小写、不分 \ 与 /）。git 登记的是真实路径，
 *        R 经过目录联接、subst 盘符时与会话 cwd 的写法不同，所以 R 的真实路径接上 .mori\worktrees\<名字> 也比一次。
 */
async function isRegistered(paths: Set<string>, place: WorktreePlace): Promise<boolean> {
  if (paths.has(pathKey(place.path))) return true;
  try {
    const real = await realpath(place.root);
    return paths.has(pathKey(win32.join(real, ...WORKTREES_DIR, place.name)));
  } catch (error) {
    console.error(`[kernel] couldn't resolve ${place.root}: ${messageOf(error)}`);
    return false;
  }
}

/**
 * @brief 撤掉建了一半（或恢复了一半）的 worktree（§11.5.3 失败后的清理，按顺序，每一步失败只记日志）：
 *        worktree remove --force --force、worktree prune、文件夹还在就删掉，deleteBranch 为真时再 branch -D。
 * @param key 排队的键
 * @param root R（在它里面跑 git）
 * @param target worktree 根与分支
 * @param deleteBranch 删分支（建的时候为真；恢复时分支不是这次建的，为假）
 */
async function discardWorktree(key: string, root: string, target: { path: string; branch: string },
  deleteBranch: boolean): Promise<void> {
  const remove = [...LONG_PATHS, 'worktree', 'remove', '--force', '--force', target.path];
  await tryGit(key, root, remove, WORKTREE_TIMEOUT_MS);
  await tryGit(key, root, ['worktree', 'prune']);
  if (await pathExists(target.path)) {
    try {
      await rm(target.path, RM_OPTIONS);
    } catch (error) {
      console.error(`[kernel] couldn't delete the folder ${target.path}: ${messageOf(error)}`);
    }
  }
  if (deleteBranch) await tryGit(key, root, ['branch', '-D', target.branch]);
}

/**
 * @brief 删掉刚建的 worktree 与它的分支（§11.5.7 第二行：重建会话失败后由 worktreeSession.ts 调用），步骤同建 worktree
 *        失败后的清理；不抛错，每一步失败只记日志。
 * @param created createWorktree 的结果
 */
export async function removeCreatedWorktree(created: CreatedWorktree): Promise<void> {
  let key = created.root;
  try {
    key = await commonDir(created.root);
  } catch {
    // 原文已记进日志；仍按 R 排队做清理
  }
  await discardWorktree(key, created.root, created, true);
  console.log(`[kernel] removed the worktree ${created.path} and its branch ${created.branch}`);
}

// ---- 建 worktree（§11.2、§11.5.2、§11.5.3） ----

/** @brief 建 worktree 的计划（§11.5.3 第 1 步）：R 与 <sub> 从会话 cwd 的字符串推出，git 只用来核对。 */
interface WorktreePlan {
  /** 会话的工作路径 */
  cwd: string;
  /** 排队的键：仓库的 common dir */
  key: string;
  /** cwd 里用的分隔符（新路径照它写） */
  sep: string;
  /** R 的段（会话在 Mori worktree 里时为那个 worktree 所在仓库的 R，不嵌套） */
  root: string[];
  /** <sub> 的段（按 cwd 的写法）；会话在仓库根时为空 */
  sub: string[];
  /** 切出点：会话所在文件夹的 HEAD 指向的提交 */
  base: string;
}

/** @brief cwd 在仓库里的位置：R 与 <sub> 的段，<sub> 的 git 写法（/ 分隔，在仓库根时为空串）。 */
interface RootPlace {
  /** R 的段（按 cwd 的写法） */
  root: string[];
  /** <sub> 的段（按 cwd 的写法）；会话在仓库根时为空 */
  sub: string[];
  /** <sub> 的 git 写法（rev-parse --show-prefix 去掉末尾的 /，cat-file 用）；在仓库根时为空串 */
  prefix: string;
}

/** @brief cwd 的字符串推不到 git 给的仓库根时的原因（例如会话文件夹本身是指进仓库子文件夹的联接）。 */
function rootMismatchText(toplevel: string): string {
  return `This folder’s path doesn’t lead to its repository root ${toplevel}, so Mori can’t place a worktree here.`;
}

/** @brief 子文件夹不在切出点的树里时的原因（§11.5.2 最后一行，照抄）。 */
function notCommittedText(sub: string): string {
  return `The folder ${sub} isn’t committed yet, so a worktree can’t start there. Commit it first.`;
}

/**
 * @brief 算 R 与 <sub>（§11.2）：<sub> 的段数取 git rev-parse --show-prefix（git 按真实路径算，联接、subst 盘符下也对），
 *        R 是 cwd 的字符串去掉末尾这几段；去掉之后的文件夹的真实路径必须是 git 给的仓库根。<sub>（按 cwd 的写法）
 *        还必须就是 git 的前缀（不分大小写），否则同 §11.5.2 最后一行拒绝。都在改任何东西之前。仓库根本身是一个
 *        Mori worktree 的根时，R 取那个 worktree 所在仓库的 R（新的与它并列，不嵌套）。
 * @param cwd 会话的工作路径
 * @param key 排队的键
 * @param toplevel repoInfo 给的仓库根
 */
async function locateRoot(cwd: string, key: string, toplevel: string): Promise<RootPlace> {
  const prefix = (await mustGit(key, cwd, ['rev-parse', '--show-prefix'])).split('/').filter(Boolean);
  const segments = segmentsOf(cwd);
  const repoSegments = segments.slice(0, segments.length - prefix.length);
  const repoRoot = joinPath(repoSegments, sepOf(cwd));
  let real: string | null = null;
  if (prefix.length < segments.length) {
    try {
      real = await realpath(repoRoot);
    } catch (error) {
      console.error(`[kernel] couldn't resolve ${repoRoot}: ${messageOf(error)}`);
    }
  }
  if (real === null || pathKey(real) !== pathKey(toplevel)) {
    console.error(`[kernel] ${cwd} doesn't lead to its repository root ${toplevel}; no worktree created`);
    throw new Error(rootMismatchText(toplevel));
  }
  const sub = segments.slice(repoSegments.length);
  // 仓库里的联接（例如没跟踪的 link 指向 app）让 git 的前缀（app）与 cwd 的写法（link）不同：新的工作路径在检出里
  // 不存在，照规格对 <sub> 做 cat-file 也会失败。只差大小写时照常（cat-file 用 git 的前缀）
  if (pathKey(sub.join('\\')) !== pathKey(prefix.join('\\'))) {
    const text = sub.join(sepOf(cwd));
    console.error(`[kernel] ${cwd} is ${prefix.join('/')} in its repository, not ${text}; no worktree created`);
    throw new Error(notCommittedText(text));
  }
  const inside = worktreeOf(repoRoot);
  const nested = inside !== null && inside.path === repoRoot;
  return {
    root: nested ? repoSegments.slice(0, -(WORKTREES_DIR.length + 1)) : repoSegments,
    sub,
    prefix: prefix.join('/'),
  };
}

/**
 * @brief 子文件夹要在切出点的树里（§11.5.2 最后一行）：git cat-file -e <切出点>:<sub>，退出码不是 0 时不建。
 * @param key 排队的键
 * @param cwd 会话的工作路径
 * @param base 切出点
 * @param place locateRoot 的结果（prefix 不为空）
 */
async function requireCommitted(key: string, cwd: string, base: string, place: RootPlace): Promise<void> {
  const args = ['cat-file', '-e', `${base}:${place.prefix}`];
  const result = await repoGit(key, cwd, args);
  if (result.error !== null || result.timedOut) outputOf(result, args, cwd, GIT_TIMEOUTS.quick);
  if (result.code === 0) return;
  const sub = place.sub.join(sepOf(cwd));
  console.error(`[kernel] ${sub} isn't committed in ${cwd}; no worktree created`);
  throw new Error(notCommittedText(sub));
}

/**
 * @brief §11.5.2 的 git 一侧的前提与 §11.5.3 第 1 步：git 可用、在有提交的仓库里、共用配置没有 core.worktree，
 *        算 R、<sub> 与切出点，子文件夹在切出点里。都不改任何东西；不满足时抛出原因。
 * @param cwd 会话的工作路径
 */
async function planWorktree(cwd: string): Promise<WorktreePlan> {
  if ((await findGit()).state !== 'ok') throw new Error(TEXTS.gitForCreate);
  const found = await repoInfo(cwd);
  if (found.error !== null) throw new Error(found.error);
  if (found.repo === null) throw new Error(TEXTS.notRepo);
  if (!found.repo.hasCommit) throw new Error(TEXTS.noCommits);
  const key = found.repo.commonDir;
  // core.worktree 先查：设了它时 git 给的仓库根不可信，也最该先告诉你
  if ((await configValue(key, cwd, ['--local', '--get', 'core.worktree'])) !== '') {
    console.error(`[kernel] the repository of ${cwd} sets core.worktree; no worktree created`);
    throw new Error(TEXTS.coreWorktree);
  }
  const place = await locateRoot(cwd, key, found.repo.toplevel);
  const base = await mustGit(key, cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (place.prefix !== '') await requireCommitted(key, cwd, base, place);
  return { cwd, key, sep: sepOf(cwd), root: place.root, sub: place.sub, base };
}

/**
 * @brief 取名并避开撞名（§11.2）：<R>\.mori\worktrees\<名字> 已存在或 refs/heads/mori/<名字> 已存在时换一个后缀，
 *        最多试 NAME_TRIES 个；都撞上时抛出 <路径> already exists.
 * @param plan 计划
 * @param text 第一条消息的全文
 * @param refsCount 引用块的段数
 * @param rand 后缀
 */
async function pickTarget(plan: WorktreePlan, text: string, refsCount: number,
  rand: () => string): Promise<{ path: string; branch: string }> {
  let path = '';
  for (let tries = 0; tries < NAME_TRIES; tries += 1) {
    const name = worktreeName(text, refsCount, rand);
    path = joinPath([...plan.root, ...WORKTREES_DIR, name], plan.sep);
    const branch = `${BRANCH_PREFIX}${name}`;
    if (!(await pathExists(path)) && !(await branchExists(plan.key, plan.cwd, branch))) return { path, branch };
    console.log(`[kernel] ${path} or ${branch} already exists; trying another name`);
  }
  console.error(`[kernel] no free worktree name for ${plan.cwd}: ${path} already exists`);
  throw new Error(`${path} already exists.`);
}

/**
 * @brief 在 info/exclude 末尾加 .mori/worktrees/（§11.5.3 第 3 步）：已有一行（去掉首尾空白后）等于它时不加；
 *        没有 info 目录就建。失败时记日志并抛出。
 * @param file info/exclude 的绝对路径
 */
async function addExcludeLine(file: string): Promise<void> {
  try {
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
    if (text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_LINE)) return;
    await mkdir(win32.dirname(file), { recursive: true });
    const lead = text === '' || text.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${lead}${EXCLUDE_LINE}\n`);
  } catch (error) {
    console.error(`[kernel] couldn't add ${EXCLUDE_LINE} to ${file}: ${messageOf(error)}`);
    throw error;
  }
}

/**
 * @brief §11.5.3 第 2、3 步：extensions.worktreeConfig 不是 true 时设成 true（共用的 .git/config），
 *        info/exclude 里补 .mori/worktrees/。写下的都不撤。
 * @param plan 计划
 */
async function prepareRepo(plan: WorktreePlan): Promise<void> {
  const flag = await configValue(plan.key, plan.cwd, ['--local', '--get', 'extensions.worktreeConfig']);
  if (flag !== 'true') await mustGit(plan.key, plan.cwd, ['config', 'extensions.worktreeConfig', 'true']);
  const exclude = await mustGit(plan.key, plan.cwd, ['rev-parse', '--path-format=absolute', '--git-path',
    'info/exclude']);
  await addExcludeLine(backslashes(exclude));
}

/**
 * @brief §11.5.3 第 5、6 步（恢复时同样做）：config.worktree 里写 core.longpaths=true，在工作路径里建 .work。
 *        失败时抛出原因。
 * @param key 排队的键
 * @param path worktree 根
 * @param cwd 会话的工作路径（worktree 根或其中的子文件夹）
 */
async function finishWorktree(key: string, path: string, cwd: string): Promise<void> {
  await mustGit(key, path, ['config', '--worktree', 'core.longpaths', 'true']);
  const work = await ensureWork(cwd);
  if (!work.ok) throw new Error(work.reason);
}

/**
 * @brief 第一条消息时建 worktree（§11.5.3）：先做 §11.5.2 的 git 一侧检查与第 1 步的两项检查（不改任何东西），
 *        再按顺序设 extensions.worktreeConfig、补 info/exclude、worktree add -b、config --worktree、ensureWork。
 *        worktree add 开始之后任何一步失败（含超时）都按顺序撤掉建了一半的 worktree 与分支，配置与 exclude 行留着。
 *        会话一侧的前提（被拒绝启动、已有消息、在运行）由调用方先查。
 * @param cwd 会话的工作路径
 * @param text 第一条消息的全文（取名用，§11.2）
 * @param refsCount 引用块的段数（refs.length）
 * @param timeoutMs worktree add 的超时（默认 120 秒，测试注入）
 * @param rand 名字的后缀（默认 crypto.randomBytes(3)，测试注入）
 * @return 建好的 worktree；失败时抛出 Error，message 是原因（调用方前面接 Couldn’t create the worktree: ）
 */
export async function createWorktree(cwd: string, text: string, refsCount: number,
  timeoutMs: number = WORKTREE_TIMEOUT_MS, rand: () => string = randomSuffix): Promise<CreatedWorktree> {
  const plan = await planWorktree(cwd);
  const target = await pickTarget(plan, text, refsCount, rand);
  await prepareRepo(plan);
  const root = joinPath(plan.root, plan.sep);
  const created: CreatedWorktree = {
    root, path: target.path, branch: target.branch,
    mainFolder: joinPath([...plan.root, ...plan.sub], plan.sep),
    cwd: joinPath([...segmentsOf(target.path), ...plan.sub], plan.sep),
  };
  try {
    const add = [...LONG_PATHS, 'worktree', 'add', '-b', target.branch, target.path, plan.base];
    await mustGit(plan.key, cwd, add, timeoutMs);
    await finishWorktree(plan.key, target.path, created.cwd);
  } catch (error) {
    console.error(`[kernel] creating the worktree ${target.path} failed, cleaning up: ${messageOf(error)}`);
    await discardWorktree(plan.key, root, target, true);
    throw error;
  }
  console.log(`[kernel] created the worktree ${target.path} on ${target.branch} from ${plan.base} for ${cwd}`);
  return created;
}

// ---- 打开 worktree 不在的会话（§11.9.4） ----

/** @brief 文件夹在、git 登记里没有它时的打开失败原文（§11.9.4）。 */
export function unregisteredText(path: string): string {
  return `The worktree folder ${path} exists but isn’t registered with git. `
    + 'Move or delete it, then open this session again.';
}

/**
 * @brief 文件夹在时查它在不在 git 的登记里（§11.9.4 第二种）：git worktree list --porcelain（在 R 里跑），
 *        路径比较不分大小写、不分 \ 与 /。
 * @param place worktreeOf(cwd)
 * @return 在为 true，不在为 false（调用方按 unregisteredText 打开失败）；没装 git 或读不出登记时为 null（照常打开）
 */
export async function worktreeRegistered(place: WorktreePlace): Promise<boolean | null> {
  if ((await findGit()).state !== 'ok') return null;
  try {
    const key = await commonDir(place.root);
    return await isRegistered(await registeredPaths(key, place.root), place);
  } catch (error) {
    console.error(`[kernel] couldn't read the worktrees of ${place.root}: ${messageOf(error)}`);
    return null;
  }
}

/**
 * @brief 文件夹不在时按 path、branch 恢复 worktree（§11.9.4 第 1–4 步）：R 要在、git 要可用；登记里还有它（含
 *        locked 的）时先 worktree remove --force --force 再 prune；分支要在；worktree add <path> <branch>（不带 -b）；
 *        失败或超时时撤掉建了一半的（不删分支）；然后 config.worktree 与 ensureWork。
 * @param place worktreeOf(cwd)
 * @param cwd 会话的工作路径（建 .work 的地方；默认 worktree 根）
 * @param timeoutMs worktree add 的超时（默认 120 秒，测试注入）
 * @return 失败时抛出 Error，message 是打开失败的原文
 */
export async function restoreWorktree(place: WorktreePlace, cwd: string = place.path,
  timeoutMs: number = WORKTREE_TIMEOUT_MS): Promise<void> {
  if (!(await isFolder(place.root))) throw new Error(`Project folder not found: ${place.root}`);
  if ((await findGit()).state !== 'ok') throw new Error(TEXTS.gitForRestore);
  // 只恢复不在的：文件夹在时 worktree add 会失败，失败后的清理会删掉它
  if (await pathExists(place.path)) throw new Error(`${place.path} already exists.`);
  const key = await commonDir(place.root);
  if (await isRegistered(await registeredPaths(key, place.root), place)) {
    await tryGit(key, place.root, ['worktree', 'remove', '--force', '--force', place.path], WORKTREE_TIMEOUT_MS);
    await tryGit(key, place.root, ['worktree', 'prune']);
  }
  if (!(await branchExists(key, place.root, place.branch))) {
    console.error(`[kernel] the branch ${place.branch} is gone; ${place.path} can't be restored`);
    throw new Error(`The branch ${place.branch} no longer exists, so this session’s worktree can’t be restored.`);
  }
  try {
    const args = [...LONG_PATHS, 'worktree', 'add', place.path, place.branch];
    const add = await repoGit(key, place.root, args, timeoutMs);
    if (add.timedOut) throw new Error(`Restoring the worktree timed out after ${durationText(timeoutMs)}.`);
    outputOf(add, args, place.root, timeoutMs);
    await finishWorktree(key, place.path, cwd);
  } catch (error) {
    console.error(`[kernel] restoring the worktree ${place.path} failed, cleaning up: ${messageOf(error)}`);
    await discardWorktree(key, place.root, place, false);
    throw error;
  }
  console.log(`[kernel] restored the worktree ${place.path} from ${place.branch}`);
}

// ---- 列出与清理（§11.9.1） ----

/**
 * @brief 有没有未提交或未跟踪的文件（§11.9.1 changes）：git --no-optional-locks status --porcelain 不为空；被忽略的不算。
 *        明写 --untracked-files=normal，不受你的 status.showUntrackedFiles 影响（否则未跟踪的文件会被当成干净删掉）。
 *        同其他 worktree 调用，在仓库的 common dir 下排队、超时 WORKTREE_TIMEOUT_MS（大仓库的 status 慢）。
 * @param key 排队的键：仓库的 common dir
 * @param path worktree 根
 * @return 有为 true，没有为 false；读不出时为原文（已记日志）
 */
async function readChanges(key: string, path: string): Promise<boolean | string> {
  const args = ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'];
  const result = await runGit({
    args, cwd: path, key, timeoutMs: WORKTREE_TIMEOUT_MS, maxOutput: GIT_OUTPUT.status,
  });
  // 输出多到超过上限也就是有改动
  if (result.truncated) return true;
  try {
    return outputOf(result, args, path, WORKTREE_TIMEOUT_MS) !== '';
  } catch (error) {
    return messageOf(error);
  }
}

/** @brief worktrees.list 的 changes（§11.9.1）：先取 worktree 所在仓库的 common dir 再 readChanges；读不出为 null。 */
async function changesOf(path: string): Promise<boolean | null> {
  try {
    const changes = await readChanges(await commonDir(path), path);
    return typeof changes === 'string' ? null : changes;
  } catch {
    // commonDir 的原文已由 outputOf 记进日志
    return null;
  }
}

/**
 * @brief 有开着的会话的工作路径是 path 或在它里面（§11.9.1 inUse）；ownerFile 不为 null 时不算拥有它的会话
 *        （会话文件为 ownerFile）与它的实例（owner 为 ownerFile）。
 */
function usedBy(rows: OpenCwd[], path: string, ownerFile: string | null): boolean {
  const owner = ownerFile === null ? null : pathKey(ownerFile);
  return rows.some((row) => {
    const mine = owner !== null
      && [row.sessionFile, row.owner].some((file) => file !== null && pathKey(file) === owner);
    return !mine && within(path, row.cwd);
  });
}

/**
 * @brief worktrees.list（§11.9.1）：只列出拥有 worktree 的会话（开着的从 host.ownedBy，没开着的从会话文件里找），
 *        每项给文件夹在不在、有没有改动、是不是正被别的开着的会话用着。只在你操作时调用。
 * @param sessionFiles 界面交来的会话文件（worktreeOf(cwd) 不为 null 的）
 * @param host 开着的会话
 * @return git 是否可用与各项；git 不可用时 changes 都为 null
 */
export async function listWorktrees(sessionFiles: string[],
  host: WorktreeHost): Promise<{ git: boolean; items: WorktreeItem[] }> {
  const git = (await findGit()).state === 'ok';
  const open = host.openCwds();
  const seen = new Set<string>();
  const items: WorktreeItem[] = [];
  for (const sessionFile of sessionFiles) {
    if (seen.has(pathKey(sessionFile))) continue;
    seen.add(pathKey(sessionFile));
    const entry = host.ownedBy(sessionFile) ?? await readWorktreeEntry(sessionFile);
    if (entry === null) continue;
    const exists = await isFolder(entry.path);
    items.push({
      path: entry.path, branch: entry.branch, mainFolder: entry.mainFolder, sessionFile, exists,
      changes: exists && git ? await changesOf(entry.path) : null,
      inUse: usedBy(open, entry.path, sessionFile),
    });
  }
  return { git, items };
}

/**
 * @brief worktree remove 之后文件夹还在时删掉它（§11.9.1 第 6 步：里面有目录联接时 git 只删登记；Node 的递归删除
 *        不跟进联接）。rm 没报错而文件夹仍在时（例如 Windows 上别的进程还开着它、删除挂起），再 rmdir 一次这个文件夹：
 *        删掉了就算干净，删不掉时它的错误就是原文。
 * @return 删干净了为 null；仍在时为 Node 的错误原文
 */
async function removeLeftover(path: string): Promise<string | null> {
  if (!(await pathExists(path))) return null;
  try {
    await rm(path, RM_OPTIONS);
    if (await pathExists(path)) await rmdir(path);
    return null;
  } catch (error) {
    // rmdir 之前文件夹刚好没了：已经删干净
    if (codeOf(error) === 'ENOENT') return null;
    console.error(`[kernel] couldn't delete the folder ${path}: ${messageOf(error)}`);
    return messageOf(error);
  }
}

/**
 * @brief worktree remove 的参数（§11.9.1 第 5 步）：force 时带两个 --force；不带时再加
 *        -c status.showUntrackedFiles=normal，让 git 自己的干净检查也算上未跟踪的文件（它跑的 status 照你的配置，
 *        设成 no 时会把有新文件的 worktree 当成干净删掉，实测 2.55）。
 */
function removeArgs(path: string, force: boolean): string[] {
  const guard = force ? [] : ['-c', 'status.showUntrackedFiles=normal'];
  return [...LONG_PATHS, ...guard, 'worktree', 'remove', ...(force ? ['--force', '--force'] : []), path];
}

/**
 * @brief 清理一个 worktree（§11.9.1 worktrees.cleanUp 的第 1–6 步）：只删 git 登记里的 Mori worktree，分支从不删。
 *        force 为假时只删读得出、确实干净的：读不出改动时留着，error 为原文（归档只记日志，等设置页清理，它先问你）。
 * @param path worktree 根
 * @param force 有改动也删（带两个 --force）
 * @param host 开着的会话
 */
async function cleanUpOne(path: string, force: boolean, host: WorktreeHost): Promise<WorktreeCleanUp> {
  const done = (removed: boolean, reason: WorktreeCleanUp['reason'], error: string | null): WorktreeCleanUp =>
    ({ path, removed, reason, error });
  const place = worktreeOf(path);
  if (place === null || place.path !== path) return done(false, null, `Not a Mori worktree: ${path}`);
  let key: string;
  try {
    key = await commonDir(place.root);
    const registered = await isRegistered(await registeredPaths(key, place.root), place);
    if (!registered) return done(false, null, `Not a Mori worktree: ${path}`);
  } catch (error) {
    // 读不出登记（R 不再是仓库、dubious ownership 等）也就不在登记里（§11.9.1 第 1 步）：git 的原文只记日志
    console.error(`[kernel] couldn't read the worktrees of ${place.root}: ${messageOf(error)}`);
    return done(false, null, `Not a Mori worktree: ${path}`);
  }
  if (!(await isFolder(path))) return done(false, 'missing', null);
  if (usedBy(host.openCwds(), path, null)) return done(false, 'in_use', null);
  if (!force) {
    const changes = await readChanges(key, path);
    if (typeof changes === 'string') return done(false, null, changes);
    if (changes) return done(false, 'changes', null);
  }
  try {
    await mustGit(key, place.root, removeArgs(path, force), WORKTREE_TIMEOUT_MS);
  } catch (error) {
    return done(false, null, messageOf(error));
  }
  const left = await removeLeftover(path);
  return left === null ? done(true, null, null) : done(false, null, left);
}

/**
 * @brief worktrees.cleanUp（§11.9.1）：逐个清理；git 不可用时每项都是 Git is required to clean up worktrees.
 *        只在你操作时调用（归档、删除、设置页），从不在后台扫。
 * @param paths worktree 根
 * @param force 有改动也删
 * @param host 开着的会话
 */
export async function cleanUpWorktrees(paths: string[], force: boolean,
  host: WorktreeHost): Promise<{ results: WorktreeCleanUp[] }> {
  const git = (await findGit()).state === 'ok';
  const results: WorktreeCleanUp[] = [];
  for (const path of paths) {
    const result = git ? await cleanUpOne(path, force, host)
      : { path, removed: false, reason: null, error: TEXTS.gitForCleanUp };
    if (result.error !== null) console.error(`[kernel] couldn't clean up the worktree ${path}: ${result.error}`);
    else console.log(`[kernel] worktree ${path}: ${result.removed ? 'removed' : `kept (${result.reason})`}`);
    results.push(result);
  }
  return { results };
}

// ---- 没打开的会话文件里的 mori.worktree（§11.6） ----

/** @brief 会话文件的一行是合法的 mori.worktree 条目时为它的数据；不是时为 null（坏行记日志后跳过）。 */
function worktreeLine(line: string, sessionFile: string): WorktreeEntry | null {
  if (!line.includes(WORKTREE_ENTRY_TYPE)) return null;
  let entry: { type?: unknown; customType?: unknown; data?: unknown };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch (error) {
    console.error(`[kernel] skipped a malformed line in ${sessionFile}: ${messageOf(error)}`);
    return null;
  }
  if (entry.type !== 'custom' || entry.customType !== WORKTREE_ENTRY_TYPE) return null;
  const data = WorktreeEntrySchema.safeParse(entry.data);
  return data.success ? data.data : null;
}

/**
 * @brief 没打开的会话文件里找 mori.worktree（§11.6）：按行流式读，读到它、或读到第一条 message 条目就停
 *        （它总写在第一条消息之前），不读整个文件。只给 worktrees.list 用。
 * @param sessionFile 会话文件
 * @return 拥有的 worktree；没有、文件不在或读不出时为 null（读不出记日志）
 */
export async function readWorktreeEntry(sessionFile: string): Promise<WorktreeEntry | null> {
  let handle: FileHandle;
  try {
    handle = await open(sessionFile, 'r');
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') console.error(`[kernel] couldn't open ${sessionFile}: ${messageOf(error)}`);
    return null;
  }
  try {
    for await (const line of handle.readLines({ encoding: 'utf8' })) {
      if (line.startsWith(MESSAGE_LINE)) return null;
      const entry = worktreeLine(line, sessionFile);
      if (entry !== null) return entry;
    }
    return null;
  } catch (error) {
    console.error(`[kernel] couldn't read ${sessionFile}: ${messageOf(error)}`);
    return null;
  } finally {
    await handle.close();
  }
}

// ---- Initialize git（§11.11） ----

/**
 * @brief Initialize git 的第 4–7 步：git init、ensureWork、git add -A、git commit --allow-empty -m "Initial commit"。
 *        失败时抛出原因（超时为 timed out after <时长>）。
 * @param key 排队的键（将要建的 .git）
 * @param cwd 工作路径
 * @param timeoutMs add -A 与 commit 的超时
 */
async function initSteps(key: string, cwd: string, timeoutMs: number): Promise<void> {
  await mustGit(key, cwd, ['init']);
  const work = await ensureWork(cwd);
  if (!work.ok) throw new Error(work.reason);
  await mustGit(key, cwd, ['add', '-A'], timeoutMs);
  await mustGit(key, cwd, ['commit', '--allow-empty', '-m', 'Initial commit'], timeoutMs);
}

/**
 * @brief Initialize git（§11.11）：git 要可用、文件夹还不是仓库、user.name 与 user.email 都设了（不满足时什么都不做）；
 *        然后 git init、ensureWork、add -A、commit。git init 起任何一步失败或超时，结束 git 之后删掉本次 git init 建的
 *        .git（原来就有 .git 时不删）；ensureWork 建的 .work 留着。会话在不在运行由调用方先查。
 * @param cwd 会话的工作路径
 * @param timeoutMs add -A 与 commit 的超时（默认 120 秒，测试注入）
 * @return 成功；失败时抛出 Error，message 是原因（界面前面接 Couldn’t initialize git: ）
 */
export async function initGit(cwd: string, timeoutMs: number = WORKTREE_TIMEOUT_MS): Promise<{ initialized: true }> {
  if ((await findGit()).state !== 'ok') throw new Error(TEXTS.gitForInit);
  const found = await repoInfo(cwd);
  if (found.error !== null) throw new Error(found.error);
  if (found.repo !== null) throw new Error(TEXTS.alreadyRepo);
  const dotGit = win32.join(cwd, '.git');
  const name = await configValue(dotGit, cwd, ['--get', 'user.name']);
  const email = await configValue(dotGit, cwd, ['--get', 'user.email']);
  if (name === '' || email === '') {
    console.error(`[kernel] git init in ${cwd} skipped: user.name or user.email is not set`);
    throw new Error(TEXTS.identity);
  }
  const hadGit = await pathExists(dotGit);
  try {
    await initSteps(dotGit, cwd, timeoutMs);
  } catch (error) {
    console.error(`[kernel] initializing git in ${cwd} failed: ${messageOf(error)}`);
    if (!hadGit) await removeLeftover(dotGit);
    throw error;
  }
  console.log(`[kernel] initialized git in ${cwd}`);
  return { initialized: true };
}
