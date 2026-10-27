// worktree 的会话接线（docs/specs/file-system.md §11.5、§11.6、§11.9，后台进程第 9 件事“工作区”）：sessions.ts 只加调用，
// 做法放在这里：第一条消息时建 worktree 并在里面按原 id 重建会话（startInWorktree，照 Check again；closeEntry、startUser、
// promptEntry 由 sessions.ts 传入），建 worktree 期间拒绝这个会话的其他命令（creatingWorktree 集合），会话条目里拥有的
// worktree（mori.worktree），打开 worktree 不在的会话之前先检出（prepareWorktreeOpen），以及 worktrees.list / cleanUp
// 要知道的开着的会话（worktreeHost）。git 步骤都在 workspace.ts。这里不 import sessions.ts（它 import 这里）。

import { existsSync } from 'node:fs';
import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { EventEnvelope, PromptResult, QuoteRef, SessionInfo } from '../shared/protocol';
import type { InstanceKind, PromptBehavior } from '../shared/team';
import {
  refsInto, worktreeOf, WORKTREE_ENTRY_TYPE, WorktreeEntrySchema, type WorktreeEntry, type WorktreePlace,
} from '../shared/workspace';
import type { ApprovalPolicy } from './approval';
import type { ModelSession } from './modelSession';
import { loadPi } from './pi';
import { sessionBusy, STILL_RUNNING } from './sessionWorkspace';
import type { TeamLike } from './teamHost';
import type { TrustDecision } from './trust';
import {
  createWorktree, readStatus, removeCreatedWorktree, restoreWorktree, unregisteredText, worktreeRegistered,
  type CreatedWorktree, type OpenCwd, type WorktreeHost,
} from './workspace';

/** @brief 会话事件的去处（信封发到界面）。 */
type Emit = (envelope: EventEnvelope) => void;

/** @brief 建 worktree 期间这个会话的其他命令的拒绝原文（§11.5.6，临时默认值）。 */
export const WORKTREE_CREATING = 'The worktree is still being created.';

/** @brief 会话里已经有消息（或带了 behavior、已有自己的 worktree）时的原因（§11.5.2）。 */
const HAS_MESSAGES = 'This session already has messages.';

/** @brief 建 worktree 失败时 mori.prompt_error 的开头（§11.5.7）。 */
const CREATE_FAILED = 'Couldn’t create the worktree: ';

/** 正在建 worktree 的会话 id（§11.5.6）：从开始检查到 promptEntry 交出 */
const creating = new Set<string>();

/**
 * 正在恢复的 worktree（§11.9.4），键是 path 的比较写法（restoringKey）：同时打开同一个 worktree 里的两个会话时
 * （拥有它的会话与 Ctrl+N 另开的、界面重新加载后一起打开），后一个等前一个恢复完再看，不各自 worktree add
 * （后一个 add 失败后的清理会删掉前一个刚恢复的）
 */
const restoring = new Map<string, Promise<void>>();

/** @brief sessions.ts 的会话（Entry）里建 worktree 要用的部分。 */
export interface WorktreeSessionEntry {
  /** pi 会话 */
  session: AgentSession;
  /** 工作路径 */
  cwd: string;
  /** 模型层的会话接线：拒绝启动、选择范围、发模型状态 */
  model: Pick<ModelSession, 'isBlocked' | 'state' | 'setPick' | 'emitState'>;
  /** 用户会话的协作；角色文件有问题时为 null */
  team: TeamLike | null;
  /** 正在生成：发出提示到 agent_settled */
  running: boolean;
  /** 你发消息后、pi 开始运行前的准备中；不在准备中时为 null */
  preparing: object | null;
  /** 这次打开时的信任结果（重建时沿用，同 Check again） */
  trust: TrustDecision;
  /** 这个用户会话的批准状态（重建时沿用同一个对象，§11.5.4） */
  approval: ApprovalPolicy;
  /** 这个会话拥有的 worktree（§11.6）；没有为 null */
  worktree: WorktreeEntry | null;
  /** 这个会话的信封事件的去处（界面） */
  emit: Emit;
}

/** @brief session.prompt 带 worktree: true 时的消息（§11.5.1）。 */
export interface WorktreePrompt {
  /** 全文（引用块在你写的字之前） */
  text: string;
  /** 输入框里的引用芯片 */
  refs?: QuoteRef[];
  /** 生成中时的送达方式；第一条消息不该带（带了按“已有消息”拒绝） */
  behavior?: PromptBehavior;
  /** 以 /team <文字> 发出 */
  team?: 'once';
}

/** @brief 重建会话时交给 sessions.ts startUser 的参数（§11.5.4 第 3 步：trust 为 undefined、restored 为假由它补上）。 */
export interface UserRebuild {
  /** 新的工作路径（失败后为原文件夹） */
  cwd: string;
  /** 按原 id 新建的 SessionManager（worktree 里的已写好 mori.worktree） */
  sessionManager: SessionManager;
  /** 原会话的信封事件的去处 */
  emit: Emit;
  /** 沿用的信任结果 */
  decision: TrustDecision;
  /** 沿用的批准状态（同一个对象） */
  approval: ApprovalPolicy;
}

/** @brief sessions.ts 传入的会话表操作（单元测试注入会抛错的 startUser，FS-100）。 */
export interface WorktreeStartDeps<E> {
  /** @brief 从表里去掉并释放一个空闲的会话。 */
  closeEntry(entry: E): Promise<void>;
  /** @brief 新建一个用户会话（UserStart 加 approval）；失败时已收拾好并抛出。 */
  startUser(args: UserRebuild): Promise<E>;
  /** @brief 发出提示（sessions.ts 的 promptEntry，不带 worktree）。 */
  promptEntry(entry: E, text: string, options: Omit<WorktreePrompt, 'text'>): PromptResult | Promise<PromptResult>;
  /** @brief 打开中的会话的信息。 */
  describe(entry: E): SessionInfo;
}

/** @brief startInWorktree 的结果：带了 worktree: true 时总有 session（§11.5.1）。 */
export interface WorktreeStarted {
  /** 收下了 */
  accepted: true;
  /** 暂存在准备中 */
  held: boolean;
  /** 重建后（或失败后在原文件夹重建的、或没动的）会话信息 */
  session: SessionInfo;
}

/** @brief 重建时沿用的（§11.5.4 的表），在关闭旧会话之前记下。 */
interface Carried {
  /** pi 会话 id（不变） */
  sessionId: string;
  /** 原来的工作路径 */
  cwd: string;
  /** 信封事件的去处 */
  emit: Emit;
  /** 信任结果 */
  decision: TrustDecision;
  /** 批准状态（同一个对象） */
  approval: ApprovalPolicy;
  /** 选择范围；没有为 null */
  pick: string | null;
  /** 思考强度 */
  thinking: AgentSession['thinkingLevel'];
  /** 你在第一条消息前改的名字；没改为 undefined */
  name: string | undefined;
  /** 协作模式是 always（第一条消息之前只会是 off 或 always） */
  teamOn: boolean;
}

/** @brief 错误的原文。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @brief 建 worktree 期间拒绝这个会话的其他命令（§11.5.6）：sessions.ts 的 requireEntry 与 renameSession 先调它。
 * @param sessionId 用户会话 id
 */
export function refuseWhileCreating(sessionId: string): void {
  if (creating.has(sessionId)) throw new Error(WORKTREE_CREATING);
}

/**
 * @brief 会话拥有的 worktree（§11.6）：SessionManager 的条目里最后一条合法的 mori.worktree；不合法的跳过并记日志。
 * @param manager 会话的 SessionManager
 * @return 拥有的 worktree；没有时为 null
 */
export function ownedWorktree(manager: SessionManager): WorktreeEntry | null {
  let owned: WorktreeEntry | null = null;
  for (const item of manager.getEntries()) {
    if (item.type !== 'custom' || item.customType !== WORKTREE_ENTRY_TYPE) continue;
    const data = WorktreeEntrySchema.safeParse(item.data);
    if (data.success) owned = data.data;
    else console.error(`[kernel] malformed ${WORKTREE_ENTRY_TYPE} entry ${item.id} skipped`);
  }
  return owned;
}

/**
 * @brief 在新建的 SessionManager 里写上会话拥有的 worktree（§11.6）：建 worktree 后在里面重建会话时（§11.5.4 第 2 步），
 *        以及还没写盘的会话按原 id 重建时（Check again，不然条目只在旧的 SessionManager 内存里，会话就不再拥有它）。
 * @param manager 按原 id 新建、还没有条目的 SessionManager
 * @param owned 拥有的 worktree；为 null 时什么都不写
 * @return 同一个 manager
 */
export function keepWorktree(manager: SessionManager, owned: WorktreeEntry | null): SessionManager {
  if (owned !== null) manager.appendCustomEntry(WORKTREE_ENTRY_TYPE, owned);
  return manager;
}

/** @brief 会话里有你的消息或助手回复。 */
function hasMessages(session: AgentSession): boolean {
  return session.sessionManager.getEntries().some((item) => item.type === 'message'
    && (item.message.role === 'user' || item.message.role === 'assistant'));
}

/**
 * @brief §11.5.2 会话一侧的前提（被拒绝启动另由 promptEntry 照现在处理）：还没有消息、没有自己的 worktree、没带 behavior；
 *        会话空闲（不在准备中、不在运行，Team 不忙）。
 * @return 不满足时的原因；满足时为 null
 */
function sessionRefusal(entry: WorktreeSessionEntry, input: WorktreePrompt): string | null {
  if (input.behavior !== undefined || entry.worktree !== null || hasMessages(entry.session)) return HAS_MESSAGES;
  return sessionBusy(entry) ? STILL_RUNNING : null;
}

/**
 * @brief 建 worktree 失败（§11.5.7）：在这个会话的信封上发 mori.prompt_error，你的消息撤回、文字与芯片回到输入框。
 * @param entry 这时的会话（没动的旧会话，或在原文件夹重建的）
 * @param input 这条消息
 * @param reason 原因或 git 原文
 */
function reportFailure(entry: WorktreeSessionEntry, input: WorktreePrompt, reason: string): void {
  const sessionId = entry.session.sessionId;
  const message = `${CREATE_FAILED}${reason}`;
  console.error(`[kernel] ${sessionId}: ${message}`);
  entry.emit({ kind: 'event', sessionId, event: { type: 'mori.prompt_error', message, text: input.text,
    refs: input.refs ?? null, running: false, queued: [] } });
}

/** @brief 关闭旧会话之前记下要沿用的（§11.5.4 第 1 步）。 */
function carriedOf(entry: WorktreeSessionEntry): Carried {
  const { session } = entry;
  return { sessionId: session.sessionId, cwd: entry.cwd, emit: entry.emit, decision: entry.trust,
    approval: entry.approval, pick: entry.model.state().pick, thinking: session.thinkingLevel,
    name: session.sessionName, teamOn: entry.team?.mode === 'always' };
}

/**
 * @brief 在新会话上把记下的设置设回去（§11.5.4 第 4 步），与新会话的默认相同的不设，按顺序：选择范围、思考强度、
 *        会话名，最后协作模式（打开后范围被锁定，setPick 会拒绝）。
 */
async function carryOver(next: WorktreeSessionEntry, carried: Carried): Promise<void> {
  if (carried.pick !== null && next.model.state().pick !== carried.pick) await next.model.setPick(carried.pick);
  if (next.session.thinkingLevel !== carried.thinking) {
    next.session.setThinkingLevel(carried.thinking);
    next.model.emitState();
  }
  if (carried.name !== undefined && next.session.sessionName !== carried.name) {
    next.session.setSessionName(carried.name);
  }
  if (carried.teamOn && next.team !== null && next.team.mode !== 'always') await next.team.setMode('on');
}

/**
 * @brief 按原 id 新建会话并沿用设置（§11.5.4 第 2–4 步）：在 worktree 里时先写 mori.worktree（§11.6），created 为 null
 *        时在原文件夹（§11.5.7 第二行）。设回设置失败时关掉刚建的会话再抛出。
 * @param carried 沿用的
 * @param created 建好的 worktree；在原文件夹重建时为 null
 * @param deps sessions.ts 的操作
 */
async function rebuild<E extends WorktreeSessionEntry>(carried: Carried, created: CreatedWorktree | null,
  deps: WorktreeStartDeps<E>): Promise<E> {
  const pi = await loadPi();
  const cwd = created?.cwd ?? carried.cwd;
  const owned: WorktreeEntry | null = created === null ? null
    : { path: created.path, branch: created.branch, mainFolder: created.mainFolder };
  const sessionManager = keepWorktree(pi.SessionManager.create(cwd, undefined, { id: carried.sessionId }), owned);
  const next = await deps.startUser({ cwd, sessionManager, emit: carried.emit, decision: carried.decision,
    approval: carried.approval });
  try {
    await carryOver(next, carried);
  } catch (error) {
    console.error(`[kernel] ${carried.sessionId}: carrying the settings over failed: ${messageOf(error)}`);
    await deps.closeEntry(next);
    throw error;
  }
  return next;
}

/**
 * @brief 重建失败之后（§11.5.7 第二、三行）：撤掉刚建的 worktree 与分支，在原文件夹按原 id 再建一次（同样沿用设置），
 *        由它发 mori.prompt_error；在原文件夹也建不起来时抛出（命令失败，后台进程里没有这个会话了）。
 * @param carried 沿用的
 * @param created 刚建的 worktree
 * @param input 这条消息
 * @param reason 重建失败的原文
 * @param deps sessions.ts 的操作
 */
async function backToFolder<E extends WorktreeSessionEntry>(carried: Carried, created: CreatedWorktree,
  input: WorktreePrompt, reason: string, deps: WorktreeStartDeps<E>): Promise<WorktreeStarted> {
  console.error(`[kernel] ${carried.sessionId} couldn't start in the worktree ${created.path}: ${reason}`);
  await removeCreatedWorktree(created);
  let back: E;
  try {
    back = await rebuild(carried, null, deps);
  } catch (error) {
    console.error(`[kernel] ${carried.sessionId} couldn't be rebuilt in ${carried.cwd}: ${messageOf(error)}`);
    throw error;
  }
  reportFailure(back, input, reason);
  return { accepted: true, held: false, session: deps.describe(back) };
}

/**
 * @brief worktree 建好之后（§11.5.4、§11.5.5）：关掉旧会话、在 worktree 里按原 id 重建并沿用设置，为新的工作路径读一次
 *        git 状态，把引用芯片的路径换进 worktree（refsInto），再交给 promptEntry（不带 worktree）。重建失败时回到原文件夹。
 * @param entry 旧会话（已检查过空闲、没有消息）
 * @param created 建好的 worktree
 * @param input 这条消息
 * @param deps sessions.ts 的操作
 */
async function moveInto<E extends WorktreeSessionEntry>(entry: E, created: CreatedWorktree, input: WorktreePrompt,
  deps: WorktreeStartDeps<E>): Promise<WorktreeStarted> {
  const carried = carriedOf(entry);
  let next: E;
  try {
    await deps.closeEntry(entry);
    next = await rebuild(carried, created, deps);
  } catch (error) {
    return backToFolder(carried, created, input, messageOf(error), deps);
  }
  console.log(`[kernel] ${carried.sessionId} now works in the worktree ${created.cwd}`);
  // 界面在建 worktree 中不发 workspace.status（§11.5.6）：由这里为新的工作路径读一次，发给它上面开着的用户会话
  void readStatus(created.cwd);
  const refs = input.refs === undefined ? undefined : refsInto(input.refs, carried.cwd, created.cwd);
  const accepted = await deps.promptEntry(next, input.text, { behavior: input.behavior, refs, team: input.team });
  return { accepted: true, held: accepted.held, session: deps.describe(next) };
}

/**
 * @brief session.prompt 带 worktree: true（§11.5）：被拒绝启动时同现在（promptEntry 发 BLOCKED_PROMPT_MESSAGE），
 *        会话一侧的前提不满足、或 createWorktree（§11.5.2 的 git 一侧、§11.5.3）失败时会话不动、发
 *        Couldn’t create the worktree: <原因>；建好后在 worktree 里重建会话并发出这条消息。从开始检查到 promptEntry
 *        交出，会话 id 在 creatingWorktree 集合里（§11.5.6）。
 * @param entry 用户会话（界面的命令能用的）
 * @param input 这条消息
 * @param deps sessions.ts 传入的 closeEntry、startUser、promptEntry、describe
 * @return 结果总带 session；在原文件夹也建不起来时抛出
 */
export async function startInWorktree<E extends WorktreeSessionEntry>(entry: E, input: WorktreePrompt,
  deps: WorktreeStartDeps<E>): Promise<WorktreeStarted> {
  const sessionId = entry.session.sessionId;
  creating.add(sessionId);
  try {
    if (entry.model.isBlocked()) {
      const options = { behavior: input.behavior, refs: input.refs, team: input.team };
      const blocked = await deps.promptEntry(entry, input.text, options);
      return { accepted: true, held: blocked.held, session: deps.describe(entry) };
    }
    const refused = sessionRefusal(entry, input);
    if (refused !== null) return notCreated(entry, input, refused, deps);
    let created: CreatedWorktree;
    try {
      created = await createWorktree(entry.cwd, input.text, input.refs?.length ?? 0);
    } catch (error) {
      return notCreated(entry, input, messageOf(error), deps);
    }
    return await moveInto(entry, created, input, deps);
  } finally {
    creating.delete(sessionId);
  }
}

/**
 * @brief 没建成 worktree（§11.5.7 第一行）：会话没动，仍是原文件夹里那个空闲的会话；发 mori.prompt_error。
 * @param entry 旧会话
 * @param input 这条消息
 * @param reason 原因或 git 原文
 * @param deps sessions.ts 的操作
 */
function notCreated<E extends WorktreeSessionEntry>(entry: E, input: WorktreePrompt, reason: string,
  deps: WorktreeStartDeps<E>): WorktreeStarted {
  reportFailure(entry, input, reason);
  return { accepted: true, held: false, session: deps.describe(entry) };
}

/** @brief restoring 的键：worktree 根的比较写法（分隔符统一为 \，小写；同 workspace.ts 比较登记时的写法）。 */
function restoringKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * @brief 按 path、branch 恢复不在的 worktree，恢复期间登记在 restoring 里（同一个 worktree 的其他打开先等它）。
 *        调用方在同一个同步段里查过文件夹不在、也没有进行中的恢复。
 * @param key restoringKey(place.path)
 * @param place worktreeOf(cwd)
 * @param cwd 会话的工作路径（建 .work 的地方）
 */
async function restoreOnce(key: string, place: WorktreePlace, cwd: string): Promise<void> {
  const restored = restoreWorktree(place, cwd);
  restoring.set(key, restored);
  try {
    await restored;
  } finally {
    restoring.delete(key);
  }
}

/**
 * @brief 从会话文件打开会话、报 Project folder not found 之前（§11.9.4）：cwd 在 Mori worktree 里时按它的 path 分三种——
 *        文件夹不在就按 path、branch 恢复（失败时抛出打开失败的原文）；文件夹在而 git 登记里没有它时打开失败
 *        （没装 git、读不出登记时照常打开）；都在时什么都不做（cwd 那个子文件夹不在由调用方照现在报）。
 *        同一个 worktree 正在恢复时先等它结束（不论成败）再看，所以同时打开的会话只恢复一次。
 * @param cwd 会话文件记下的工作路径
 */
export async function prepareWorktreeOpen(cwd: string): Promise<void> {
  const place = worktreeOf(cwd);
  if (place === null) return;
  const key = restoringKey(place.path);
  for (let pending = restoring.get(key); pending !== undefined; pending = restoring.get(key)) {
    // 失败由发起恢复的那次打开报告；这里只等它结束，再按此刻的文件夹与登记判断
    await pending.catch(() => undefined);
  }
  if (!existsSync(place.path)) {
    await restoreOnce(key, place, cwd);
    return;
  }
  if ((await worktreeRegistered(place)) === false) {
    console.error(`[kernel] ${place.path} exists but isn't registered with git; the session is not opened`);
    throw new Error(unregisteredText(place.path));
  }
}

/** @brief 会话表里 worktreeHost 要用的部分（sessions.ts 的 Entry）。 */
export interface WorktreeOpenEntry {
  /** pi 会话：id 与会话文件（还没写盘的也有将来的路径） */
  session: Pick<AgentSession, 'sessionId' | 'sessionFile'>;
  /** 工作路径 */
  cwd: string;
  /** 会话的种类 */
  kind: 'user' | InstanceKind;
  /** 实例所属的用户会话 id；用户会话为 null */
  owner: string | null;
  /** 增强任务的看不见的会话 */
  headless: boolean;
  /** 拥有的 worktree（§11.6）；没有为 null */
  worktree: WorktreeEntry | null;
}

/**
 * @brief 开着的会话的工作路径（§11.9.1 inUse）：用户会话（含看不见的会话）与实例都算；实例的 owner 是它所属用户会话的
 *        会话文件（拥有 worktree 的会话的实例不算占用它）。
 */
function openCwdsOf(all: readonly WorktreeOpenEntry[]): OpenCwd[] {
  const fileOf = (id: string | null): string | null => (id === null ? null
    : all.find((entry) => entry.session.sessionId === id)?.session.sessionFile ?? null);
  return all.map((entry) => ({ sessionFile: entry.session.sessionFile ?? null, cwd: entry.cwd,
    owner: fileOf(entry.owner) }));
}

/**
 * @brief worktrees.list / worktrees.cleanUp 要知道的开着的会话（§11.9.1），每次调用时现取会话表。
 * @param entries 此刻会话表里的全部会话
 */
export function worktreeHost(entries: () => Iterable<WorktreeOpenEntry>): WorktreeHost {
  return {
    openCwds: () => openCwdsOf([...entries()]),
    ownedBy: (sessionFile) => [...entries()].find((entry) => entry.kind === 'user' && !entry.headless
      && entry.session.sessionFile === sessionFile)?.worktree ?? null,
  };
}
