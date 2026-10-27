// 文件系统第 2 步的会话接线（docs/specs/file-system.md §3.5、§4.5–§4.7、§5.5–§5.11，后台进程第 9 件事“工作区”）：
// sessions.ts 只加调用，接线的做法放在这里：git 状态发给同一工作路径上打开的用户会话（WorkspaceHost）、mori-snapshots
// 的工厂与它标出的 Agent、用户会话在快照模块里的登记与释放时的通知、关闭时等它的结束快照写完、正在 Rewind 时拒绝发消息，
// 以及 workspace.status、snapshots.diff、rewind、rewind.undo 命令要的会话接口（RewindSession 由打开的用户会话建出）。
// 第 3 步（file-system-permissions.md §8.6、file-system.md §11.11）：重新打开时检查 pi 恢复出的默认工具、
// workspace.initGit 的会话检查与之后的 git 状态；会话忙的判断（sessionBusy）也给 worktreeSession.ts 用。
// 这里不 import sessions.ts（它 import 这里）：会话表经 configureSessionWorkspace 交进来，会话只用 WorkspaceEntry 这一部分。

import type { AgentSession, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import {
  QuoteRefSchema, REF_ENTRY_TYPE, type EventEnvelope, type KernelEvent, type QuoteRef,
} from '../shared/protocol';
import { BASE_ROLE, type InstanceKind } from '../shared/team';
import type { RewindResult, RunAgent, SnapshotDiff, WorkspaceStatus } from '../shared/workspace';
import { findGit, gitState } from './git';
import { rewind, rewinding, undoRewind, type RewindInput, type RewindSession, type UndoInput } from './rewind';
import {
  inQueue, registerSnapshotUser, snapshotDiff, snapshotExtension, snapshotState, stopStartSnapshot,
  unregisterSnapshotUser, type SnapshotUser,
} from './snapshots';
import type { TeamLike } from './teamHost';
import { configureWorkspace, initGit, readStatus, type WorkspaceUser } from './workspace';

/** @brief sessions.ts 的会话（Entry）里这里用到的部分。 */
export interface WorkspaceEntry {
  /** pi 会话 */
  session: AgentSession;
  /** 工作路径（会话的 cwd 原样：git 状态按这个字符串分，§3.5） */
  cwd: string;
  /** 会话的种类：用户会话或实例会话的种类 */
  kind: 'user' | InstanceKind;
  /** 增强任务的看不见的会话（记忆规格 §9.6）：没有右栏，不收 git 状态 */
  headless: boolean;
  /** 用户会话的协作；角色文件有问题时与实例会话为 null */
  team: TeamLike | null;
  /** 模型层的会话接线：恢复对话后在新的叶子之后再记一条 mori.pick（§5.8） */
  model: { recordPick(): void };
  /** 正在生成：发出提示到 agent_settled */
  running: boolean;
  /** 你发消息后、pi 开始运行前的准备中；不在准备中时为 null */
  preparing: object | null;
  /** @brief 发这个会话的信封事件（用户会话发给界面）。 */
  emit(envelope: EventEnvelope): void;
}

/** @brief 建 mori-snapshots 要的、这个会话的设置（sessions.ts 的 SessionSetup 里的几项）。 */
export interface SnapshotSetup {
  /** 会话的种类 */
  kind: 'user' | InstanceKind;
  /** 实例所属的用户会话 id；用户会话为 null */
  owner: string | null;
  /** 记忆设置：增强会话与它的实例带这次增强运行（enhance 不为 null） */
  memory: { enhance: unknown };
  /** @brief 这次运行标出的 Agent（before_agent_start 时取，§4.5）。 */
  runAgent(): RunAgent;
}

/** @brief 正在 Rewind / Undo 时 session.prompt 的拒绝原文（§5.10）。 */
export const REWINDING_PROMPT = 'This session is rewinding. Send your message when it’s done.';

/** @brief 正在 Rewind / Undo 时关闭会话、Check again 的拒绝原文（沿用 §5.10 再来 rewind 时的原文）。 */
export const ALREADY_REWINDING = 'This session is already rewinding.';

/**
 * @brief 会话在生成（含协作模式下有 Agent 在运行、排队或有待判断的消息）时拒绝的原文：关闭、换范围、建 worktree
 *        （file-system.md §11.5.2）、Initialize git（§11.11）。
 */
export const STILL_RUNNING = 'This session is still running. Stop it first.';

/** @brief 工具被旧版本裁过的会话重新打开时的拒绝原文（file-system-permissions.md §8.6）。 */
export const OLDER_VERSION = 'This session was saved by an older version of Mori and can’t be opened.';

/** @brief 第 2 步的命令给的会话不是用户会话时的原文（同 sessions.ts 的 requireEntry）。 */
function unknownSession(sessionId: string): Error {
  return new Error(`Unknown session ${sessionId}`);
}

// ---- mori-snapshots 与快照模块的登记 ----

/**
 * @brief 没有 Team（角色文件有问题）时用户会话自己的运行标出的 Agent（§4.5）：基座持有对话，记录里存 mori
 *        （界面显示 Mori，fs-changes.md），没有 task。
 */
export function baseAgent(): RunAgent {
  return { role: BASE_ROLE, task: null, self: true };
}

/** 每个用户会话已结束的运行在快照队列里的记号（键为用户会话 id，实例的运行记在 owner 下）；做完即去掉 */
const endMarks = new Map<string, Set<Promise<void>>>();

/**
 * @brief agent_settled 时在工作路径的队列里排一个空作业作记号（§4.6、§4.7）：它紧跟在 mori-snapshots 刚排的结束快照
 *        作业之后，做到它时结束快照的 mori.turn_changes 已写进会话文件。git 不是 ok 时没有快照作业，不排。不抛错。
 * @param userSessionId 所属的用户会话 id
 * @param cwd 会话的工作路径
 */
function markEnd(userSessionId: string, cwd: string): void {
  if (gitState().state !== 'ok') return;
  const mark = inQueue(cwd, async () => undefined).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kernel] waiting for the end snapshots of ${userSessionId} failed: ${message}`);
  });
  const marks = endMarks.get(userSessionId) ?? new Set<Promise<void>>();
  endMarks.set(userSessionId, marks);
  marks.add(mark);
  void mark.then(() => {
    marks.delete(mark);
    if (marks.size === 0 && endMarks.get(userSessionId) === marks) endMarks.delete(userSessionId);
  });
}

/**
 * @brief inline extension mori-snapshots 的工厂（§4.5）：用户会话与实例都注册，必需。所属的用户会话是实例的 owner
 *        （用户会话为自己）；增强任务的看不见的会话与它的实例都只刷新 git 状态、不拍快照（§4.5“不拍的”）。
 *        拍快照的会话另在 mori-snapshots 的 agent_settled 之后排记号（markEnd）：pi 按注册顺序逐个 await 同一个扩展的
 *        处理函数，endRun 同步排好结束快照作业，所以记号排在它之后。
 * @param setup 这个会话的设置
 * @param sessionId 这个会话的 pi 会话 id
 */
export function snapshotFactory(setup: SnapshotSetup, sessionId: string): ExtensionFactory {
  const userSessionId = setup.owner ?? sessionId;
  const headless = setup.memory.enhance !== null;
  const snapshots = snapshotExtension({ userSessionId, self: setup.kind === 'user', headless,
    agent: () => setup.runAgent() });
  return (pi) => {
    snapshots(pi);
    if (!headless) pi.on('agent_settled', (_event, ctx) => markEnd(userSessionId, ctx.cwd));
  };
}

/** @brief 在这个会话的信封上发一个事件的函数。 */
function emitterOf(entry: WorkspaceEntry): (event: KernelEvent) => void {
  const sessionId = entry.session.sessionId;
  return (event) => entry.emit({ kind: 'event', sessionId, event });
}

/** @brief 用户会话在快照模块里的登记内容（§4.6）：记录经它的 SessionManager 写进会话文件，事件发在它的信封上。 */
function snapshotUserOf(entry: WorkspaceEntry): SnapshotUser {
  return { sessionId: entry.session.sessionId, cwd: entry.cwd, sessionManager: entry.session.sessionManager,
    emit: emitterOf(entry), headless: entry.headless };
}

/**
 * @brief 会话进了会话表之后调用：用户会话（含看不见的会话，快照模块按 headless 不拍）在快照模块里登记；实例不登记，
 *        它们的段写进 owner 登记的 SessionManager（§4.6）。
 * @param entry 刚建好的会话
 */
export function registerEntry(entry: WorkspaceEntry): void {
  if (entry.kind === 'user') registerSnapshotUser(snapshotUserOf(entry));
}

/**
 * @brief release 在 await session.abort() 之前调用（§4.5“停止”）：结束这个会话正在等的开始快照作业（pi 的 abort 要等
 *        before_agent_start 返回），用户会话在快照模块里注销。之后做完的结束快照仍写进运行登记时记下的 SessionManager，
 *        但不再发事件（§4.6）。
 * @param entry 要释放的会话
 */
export function releaseEntry(entry: WorkspaceEntry): void {
  stopStartSnapshot(entry.session.sessionId);
  if (entry.kind === 'user') unregisterSnapshotUser(entry.session.sessionId);
}

/**
 * @brief closeEntry 释放用户会话之后调用（§4.6、§4.7）：等这个会话与它的实例已结束的运行排的结束快照做完、
 *        mori.turn_changes 写进会话文件，之后才删除会话文件（mori:delete-session）或从文件重新打开（Check again、
 *        取消归档后打开）：晚到的记录不会重建删掉的文件，也不会落在重新打开后的旁支上。只等这个会话自己的记号，
 *        不等别的会话之后排的作业；有序退出不走这里（drainSnapshots）。实例会话不等。
 * @param entry 刚释放的会话
 */
export async function settleEntry(entry: WorkspaceEntry): Promise<void> {
  if (entry.kind !== 'user') return;
  const marks = endMarks.get(entry.session.sessionId);
  if (marks) await Promise.all([...marks]);
}

/**
 * @brief 正在 Rewind / Undo 的会话拒绝 session.prompt（§5.10）：用 rewind.ts 的 rewinding()，它在检查 git、排队之前
 *        就同步设好。
 * @param sessionId 用户会话 id
 */
export function refuseWhileRewinding(sessionId: string): void {
  if (rewinding(sessionId)) throw new Error(REWINDING_PROMPT);
}

/**
 * @brief 正在 Rewind / Undo 的会话拒绝关闭（归档、删除前）与 Check again（§5.10：Rewind 不改 Team 的 busy，会话的
 *        空闲检查拦不住）：rewind.ts 还拿着这条会话建出的 RewindSession，关掉后它会在释放了的 pi 会话上导航，
 *        mori.rewind 也会经旧的 SessionManager 写进（可能已删掉、或已被重新打开的）会话文件。
 * @param sessionId 用户会话 id
 */
export function refuseCloseWhileRewinding(sessionId: string): void {
  if (rewinding(sessionId)) throw new Error(ALREADY_REWINDING);
}

// ---- git 状态 ----

/**
 * @brief 这个工作路径上打开的用户会话（§3.5“结果发给谁”）：按会话的 cwd 原样比较；实例与看不见的会话不算。
 * @param entries 会话表里的全部会话
 * @param cwd 工作路径
 */
function usersAt(entries: Iterable<WorkspaceEntry>, cwd: string): WorkspaceUser[] {
  const users: WorkspaceUser[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'user' || entry.headless || entry.cwd !== cwd) continue;
    users.push({ sessionId: entry.session.sessionId, emit: emitterOf(entry) });
  }
  return users;
}

/**
 * @brief 后台进程启动时调用一次（sessions.ts 载入时）：把会话表交给 git 状态模块（WorkspaceHost）。
 * @param entries 此刻会话表里的全部会话（每次发 git 状态时现取）
 */
export function configureSessionWorkspace(entries: () => Iterable<WorkspaceEntry>): void {
  configureWorkspace({ usersAt: (cwd) => usersAt(entries(), cwd), snapshotState: (cwd) => snapshotState(cwd) });
}

/** @brief 第 2 步的命令只认用户会话（实例不在界面上）；不是时报错。 */
function requireUser(entry: WorkspaceEntry): WorkspaceEntry {
  if (entry.kind !== 'user') throw unknownSession(entry.session.sessionId);
  return entry;
}

/**
 * @brief workspace.status（§3.2 第 3 步、§3.5）：先重找 git（只有这里会在 missing、old 时重找），再立即读这个工作路径的
 *        git 状态；结果与发给同一工作路径上每个打开的用户会话的 mori.workspace_status 相同，晚于命令发出的时刻。
 * @param entry 用户会话
 */
export async function workspaceStatus(entry: WorkspaceEntry): Promise<WorkspaceStatus> {
  requireUser(entry);
  await findGit(true);
  return readStatus(entry.cwd);
}

/**
 * @brief snapshots.diff（§5.3）：这一轮这个文件的 diff，在工作路径的队列里跑（snapshots.ts）。
 * @param entry 用户会话
 * @param round 轮的条目 id
 * @param path 相对工作路径的路径
 */
export function sessionDiff(entry: WorkspaceEntry, round: string, path: string): Promise<SnapshotDiff> {
  return snapshotDiff(snapshotUserOf(requireUser(entry)), round, path);
}

// ---- Rewind 与 Undo ----

/** mori.ref 条目里的引用（读出来不合法时跳过并记日志，§12） */
const RefsSchema = z.array(QuoteRefSchema);

/**
 * @brief 一条你的消息的引用（§5.8）：分支上 messageId 是它的那条 mori.ref；rewind.ts 在导航之前取，当前分支就够了。
 * @param branch 当前分支
 * @param entryId 你的消息的条目 id
 * @return 引用，按芯片顺序；没有 mori.ref 或它不合法时为 null
 */
function refsOf(branch: readonly SessionEntry[], entryId: string): QuoteRef[] | null {
  const found = branch.findLast((item) => item.type === 'custom' && item.customType === REF_ENTRY_TYPE
    && (item.data as { messageId?: unknown } | undefined)?.messageId === entryId);
  if (found?.type !== 'custom') return null;
  const parsed = RefsSchema.safeParse((found.data as { refs?: unknown }).refs);
  if (parsed.success) return parsed.data;
  console.error(`[kernel] malformed ${REF_ENTRY_TYPE} entry ${found.id} skipped`);
  return null;
}

/** @brief 判断会话忙要用的部分（sessions.ts 的 Entry）。 */
export interface BusyEntry {
  /** pi 会话：是否在生成 */
  session: Pick<AgentSession, 'isStreaming'>;
  /** 正在生成：发出提示到 agent_settled */
  running: boolean;
  /** 你发消息后、pi 开始运行前的准备中；不在准备中时为 null */
  preparing: object | null;
  /** 用户会话的协作；没有时为 null */
  team: Pick<TeamLike, 'busy'> | null;
}

/** @brief 没有 Team 时会话忙（§5.5）：对话在运行或准备中。 */
function soloBusy(entry: BusyEntry): boolean {
  return entry.running || entry.session.isStreaming || entry.preparing !== null;
}

/**
 * @brief 会话忙（同 sessions.ts closeSession 的检查）：对话在运行或准备中，或 Team 有 Agent 在运行、排队或有待判断的消息。
 * @param entry 用户会话
 */
export function sessionBusy(entry: BusyEntry): boolean {
  return soloBusy(entry) || (entry.team?.busy() ?? false);
}

/**
 * @brief 由打开的用户会话建出 rewind.ts 要的会话接口（§5.5–§5.10）：navigateTree 不带 summarize（不发模型请求）；
 *        忙按 Team 的 busy()（有 Agent 在运行、排队或有待判断的消息），没有 Team 时为对话在运行或准备中；
 *        open 的需求编号来自 TaskBoard；mori.pick 经模型层再记一条。
 * @param entry 用户会话
 */
export function rewindSession(entry: WorkspaceEntry): RewindSession {
  const { session } = requireUser(entry);
  return {
    sessionId: session.sessionId, cwd: entry.cwd, sessionManager: session.sessionManager,
    navigateTree: (targetId) => session.navigateTree(targetId),
    busy: () => entry.team?.busy() ?? soloBusy(entry),
    openRequests: () => entry.team?.openRequests() ?? [],
    recordPick: () => entry.model.recordPick(),
    refsOf: (entryId) => refsOf(session.sessionManager.getBranch(), entryId),
    emit: emitterOf(entry),
  };
}

/**
 * @brief rewind（§5.6–§5.11）：错误原文由 rewind.ts 给出（界面加 Couldn’t rewind: 的开头）。
 * @param entry 用户会话
 * @param input 命令参数
 */
export function rewindEntry(entry: WorkspaceEntry, input: RewindInput): Promise<RewindResult> {
  return rewind(rewindSession(entry), input);
}

/**
 * @brief rewind.undo（§5.9）：错误原文由 rewind.ts 给出（界面加 Couldn’t undo: 的开头）。
 * @param entry 用户会话
 * @param input 命令参数
 */
export function undoEntry(entry: WorkspaceEntry, input: UndoInput): Promise<RewindResult> {
  return undoRewind(rewindSession(entry), input);
}

// ---- 重新打开时的工具（file-system-permissions.md §8.6） ----

/**
 * @brief 重新打开已保存的用户会话时检查 pi 按会话记录恢复出的启用工具：缺了这个会话应有的 pi 默认工具（pi 设置的
 *        defaultTools，没设时 read、bash、edit、write）就拒绝打开，不补工具。只比默认工具，扩展工具（memory、
 *        ask_user_question、TaskBoard 工具）的有无不影响（FS-65、FS-68）。
 * @param activeToolNames pi 恢复出的启用工具（getActiveToolNames()）
 * @param baseTools 这个会话应有的 pi 默认工具
 */
export function checkRestoredTools(activeToolNames: readonly string[], baseTools: readonly string[]): void {
  const missing = baseTools.filter((name) => !activeToolNames.includes(name));
  if (missing.length === 0) return;
  console.error(`[kernel] the restored tools lack ${missing.join(', ')}; the session is not opened`);
  throw new Error(OLDER_VERSION);
}

/**
 * @brief sessions.ts createEntry 在 refreshTools 之前（也就在绑定扩展之前）调用：checkRestoredTools 不过时照
 *        必需扩展没加载上的做法先 dispose 这条 pi 会话再抛出，由建立失败的收拾接着做（会话不打开）。
 * @param session 刚按会话记录建好的 pi 会话
 * @param baseTools 这个会话应有的 pi 默认工具
 */
export function refuseRestoredTools(session: AgentSession, baseTools: readonly string[]): void {
  try {
    checkRestoredTools(session.getActiveToolNames(), baseTools);
  } catch (error) {
    session.dispose();
    throw error;
  }
}

// ---- Initialize git（file-system.md §11.11） ----

/**
 * @brief workspace.initGit：会话（含后台 Agent）在运行或准备中时拒绝（§11.11 第 1 步）；否则 initGit（workspace.ts）。
 *        这一步的拒绝也算失败：成功、失败之后都为这个工作路径读一次 git 状态（§11.11“之后”，发给它上面开着的用户会话，
 *        结果晚于命令的结果也可以）。
 * @param entry 用户会话
 * @return 成功；失败时抛出原因（界面前面接 Couldn’t initialize git: ）
 */
export async function initGitEntry(entry: WorkspaceEntry): Promise<{ initialized: true }> {
  requireUser(entry);
  try {
    if (sessionBusy(entry)) throw new Error(STILL_RUNNING);
    return await initGit(entry.cwd);
  } finally {
    void readStatus(entry.cwd);
  }
}
