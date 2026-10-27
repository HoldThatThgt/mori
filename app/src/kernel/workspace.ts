// 工作区模块（docs/specs/file-system.md §2，后台进程第 9 件事“工作区”）。这里有两部分：
// .work（docs/specs/file-system-permissions.md §7.10、§7.11）：Agent 的草稿、过程脚本与临时文件放在 <工作路径>\.work，
// 路径闸放行命令或写进 .work 的 write / edit 之前建它（不递归 mkdir，不覆盖你改过的 .gitignore，每次都检查、不缓存）；
// bash 与 PowerShell 工具经 customTools 换成同样的定义加上 spawnHook，在 env 的副本里把 TEMP、TMP、TMPDIR 指到
// .work\tmp 并去掉 CDPATH。从不改 process.env（所有会话共用一个后台进程）。
// git 状态（docs/specs/file-system.md §3.4、§3.5）：认仓库（两个 rev-parse，不缓存）、读 git status（porcelain v2，
// 解析在 timeline.ts），同一工作路径同一时刻只读一个、读的过程中再来的请求合成一次再读；每读完一次发给这个工作路径上
// 所有打开的用户会话；工具执行完的读去抖 500 毫秒；快照状态变了时用最近一次的结果加新的快照状态再发一次。
// 两部分都不监视、不轮询：只有去抖用的 setTimeout。

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { BashSpawnContext, SettingsManager, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { KernelEvent } from '../shared/protocol';
import {
  STATUS_FILE_LIMIT, WORK_DENIAL_PREFIX, type RepoInfo, type SnapshotState, type WorkspaceStatus,
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
  return `${WORK_DENIAL_PREFIX} (${reason}), so this call didn't run. Tell the user.`;
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
