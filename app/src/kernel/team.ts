// 协作（docs/specs/parallel-agents-taskboard.md §5–§13）：每个用户会话一个 Team，在后台进程里管这个用户会话的 TaskBoard、
// 协作模式、实例会话（立项、结案、task、临时提问、订阅）、投递队列与唤醒、调度（同时运行上限、写入锁）、后台批准卡、
// 事件（mori.team_state、mori.board 合并发送）。会话表经 TeamHost 替它建、开、关实例与投递（teamHost.ts）。
// 运行结束后的处理在 teamRuns.ts（§9.4），工具的执行在 teamTools.ts（§6.3、§7、§10），视图在 teamView.ts（§13.10）。
// TaskBoard 的每次写入：校验 → 改内存 → 原子地写出 board.json → 发 mori.board → 唤醒（§3、§6.2）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  AgentSessionEvent, BeforeAgentStartEvent, ExtensionAPI, ExtensionFactory, ToolCallEventResult, ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { REASON_TEXTS, isUntilReason, plainReasonText, type ModelEvent, type ModelPick } from '../shared/models';
import type { ApprovalDecision, KernelEvent, SessionInfo } from '../shared/protocol';
import {
  BASE_ROLE, TEAM_ENTRY_TYPES, TEAM_TOOLS, TeamEntrySchema, canStopTask, seatRolesOf, type DecidingMessage,
  type PromptBehavior, type ReceiptEntryData, type RoleSummary, type SessionOf, type TaskDetail, type TeamApprovalEnd,
  type TeamApprovalRequest, type TeamDeciding, type TeamHolders, type TeamMode, type TeamState, type TeamSwitch,
  type TeamToolName, type TitleContext, type ToolCallBrief, type WakeKind, type InstanceKind,
} from '../shared/team';
import {
  applyRestartRecovery, findRequest, findTask, isTaskEnded, liveTaskIds, loadBoard, markAsked, markStopped, newBoard,
  requestsAwaitingClose, saveBoard, teamStopTargets,
} from './board';
import {
  RUN_CAP, USER_SESSION, deliveryText as joinDeliveries, dropStale, scheduleStarts, wakesAfter,
} from './boardRoute';
import {
  cardTokens, createCatchUp, deliveryText, segments, userSessionSection, withCatchUp, workCard, type DeliveryArgs,
  type DeliveryKind,
} from './boardText';
import { boardTools, guardToolCall, type BoardToolExecutor, type ToolSessionInfo } from './boardTools';
import { nextTag, tagResult } from './evidence';
import { shapeFor as formShape, writeModeOf, type WriteMode } from './handoffForm';
import { instanceSeats, memoryCallerFor } from './memoryAssemble';
import type { RequestShape, ShapeAttempt } from './modelSession';
import type { CandidateSource, SchedClass } from './modelTypes';
import {
  dialogTools, findRole, hasOtherRoles, matchesToolEntries, roleCandidates, toolAllowlist, type RoleDef,
} from './roles';
import { messageText, turnCount, type SessionEntryLike } from './sessionReader';
import { teamExtension, type TeamHooks } from './teamExtension';
import { UserFlow, missingProgress } from './teamFlow';
import {
  MEMORY_TOOL, type HeldItem, type InstanceApprovalRequest, type InstanceSpec, type StopReason, type TeamArgs,
  type TeamHost, type TeamLike, type UserAttach,
} from './teamHost';
import {
  LANE_IDS, hasQueued, laneActive, newLane, takeBatch, type DeliveryMeta, type Lane, type TeamDelivery,
} from './teamLanes';
import { STOPPED_BY_USER, runEnded, runStarted, startUserJudgment } from './teamRuns';
import { readBackgroundSession, runTool } from './teamTools';
import {
  BOARD_EVENT_INTERVAL_MS, Throttle, boardEdited, boardView, handedOver, taskDetail, type TaskLive,
} from './teamView';
import type { Board, BoardWake, BoardWrite, DeliveryCause, ScheduleWait, Subscriber } from './teamTypes';

/** @brief 用户会话 system prompt 的自定义段名（§8.5，同 pi 内置 MCP 扩展的 mcp_servers 段）。 */
export const TEAM_SECTION = 'mori_team';

/** @brief 实例会话文件的目录名，在 <userData>/teams/<用户会话 id>/ 下（§3）。 */
export const SESSIONS_DIR = 'sessions';

/** @brief 关闭模式下 TaskBoard 上有过需求时，用户会话保留的两个只读工具（§5.2、§6.3）。 */
const OFF_READERS: readonly TeamToolName[] = ['board_read', 'read_session'];

/** @brief 协作模式下对话调用了这次运行之外的工具（§5.5）。 */
export const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';

/** @brief 等槽位的订阅（§9.5）。 */
interface PendingSubscription {
  /** 调度用的标识（订阅实例的键） */
  id: string;
  /** 命中的时刻（ms） */
  readyAt: number;
  /** 订阅者 */
  role: string;
  /** 关闭的需求 */
  request: number;
}

/** @brief 挂起的后台批准卡。 */
interface PendingApproval {
  /** 卡片的内容（mori.team_approval_request） */
  request: TeamApprovalRequest;
  /** 实例的 pi 会话 id */
  instance: string;
}

/** @brief 用户会话的一次运行开始前（before_agent_start）定下的、agent_start 时交给 LaneRun 的东西。 */
interface UserRunStart {
  /** 这次运行的协作模式 */
  mode: TeamMode;
  /** 这次运行允许的工具条目（§5.5）；不限制时为 null */
  allowed: string[] | null;
}

/** @brief 读会话文件里最后一条 mori.team（打开会话、mori-team 加载时，§5.1、§6.3）；没有时为 null。 */
function savedTeamEntry(file: string | null): { mode: TeamMode; tools: string[] | null } | null {
  if (file === null || !existsSync(file)) return null;
  let mode: TeamMode | null = null;
  let tools: string[] | null = null;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes(TEAM_ENTRY_TYPES.team)) continue;
      const entry = JSON.parse(line) as { type?: string; customType?: string; data?: unknown };
      if (entry.type !== 'custom' || entry.customType !== TEAM_ENTRY_TYPES.team) continue;
      const data = TeamEntrySchema.safeParse(entry.data);
      if (!data.success) continue;
      mode = data.data.mode;
      tools = data.data.tools ?? tools;
    }
  } catch (error) {
    console.error(`[kernel] cannot read the team mode from ${file}: ${(error as Error).message}`);
  }
  return mode === null ? null : { mode, tools };
}

/** @brief 一个实例会话文件里有成功的 edit、write 工具结果（§13.12）；读不出时记日志、当作没有。 */
async function sessionEdited(file: string): Promise<boolean> {
  try {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.includes('"toolResult"')) continue;
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; toolName?: string;
        isError?: boolean } };
      const message = entry.type === 'message' ? entry.message : undefined;
      if (message?.role === 'toolResult' && (message.toolName === 'edit' || message.toolName === 'write')
        && !message.isError) return true;
    }
  } catch (error) {
    console.error(`[kernel] cannot read the instance session ${file}: ${(error as Error).message}`);
  }
  return false;
}

/** @brief 一个用户会话的协作（TeamLike 由会话表调用；其余成员是 teamRuns.ts、teamTools.ts 用的内部入口）。 */
export class Team implements TeamLike {
  /** 用户会话 id */
  readonly userId: string;
  /** 三项权限的持有者 */
  readonly holders: TeamHolders;
  /** 全部角色（基座在最后） */
  readonly roles: readonly RoleDef[];
  /** 全部角色名（含 mori） */
  readonly roleNames: string[];
  /** 角色文件定义的角色（不含基座），附加段与界面用 */
  readonly summaries: RoleSummary[];
  /** 对话与立项由同一个角色持有（合并会话） */
  readonly merged: boolean;
  /** 实例会话文件的目录 */
  readonly sessionsDir: string;
  /** 订阅者（§9.5） */
  readonly subscribers: Subscriber[];
  /** 这个用户会话的 TaskBoard（内存里的，写入后写出 board.json） */
  board: Board = newBoard();
  /** 协作模式 */
  mode: TeamMode = 'off';
  /** 全部会话，按键；含用户会话 */
  readonly lanes = new Map<string, Lane>();
  /** 用户会话 */
  readonly user: Lane;
  /** 用户会话的 pi 会话与模型层（attachUser 之后） */
  userSession: UserAttach | null = null;
  /** 用户会话的扩展 API（mori-team 加载时拿到） */
  userApi: ExtensionAPI | null = null;
  /** 用户会话的 TaskBoard 工具已经注册（§6.3：之后不再增删） */
  userToolsRegistered = false;
  /** 挂起的后台批准卡，按 requestId，按到达顺序 */
  readonly approvals = new Map<string, PendingApproval>();
  /** 协作模式下 agent_message 已经发出的条数（boardRoute 的 countKey，§10.1） */
  readonly sent = new Map<string, number>();
  /** 正在等回复的会话：等待的一方 → 它等的一方（会话键，§10.1） */
  readonly waits = new Map<string, string>();
  /** 调度结果里没开始的 task（排队、等写入锁） */
  waiting: ScheduleWait[] = [];
  /** 等槽位的订阅 */
  waitingSubs: PendingSubscription[] = [];
  /** 有实例做过成功的 edit、write（§13.12） */
  teamEdited = false;
  /** 实例的 pi 会话 id → 会话文件（打开会话时扫一次目录，建立实例时记下） */
  readonly knownFiles = new Map<string, string>();
  /** 交回 task 的原因（task_back 投递，§8.5）：task → 原因 */
  readonly backReasons = new Map<string, string>();
  /** 实例的候选来源建立时会话的范围（角色没写 models 时用它，§12.1）：实例的 pi 会话 id → 范围 */
  private readonly sourcePicks = new Map<string, ModelPick | null>();
  /** 分开时协作模式下你的消息的走法：待判断队列、交给对话的消息与立项的决定（teamFlow.ts，§5.3） */
  readonly flow: UserFlow;
  /** 停止或重启之后，你的下一条消息交给立项时同时唤醒 task 都已结束的需求的结案（§11.4、§11.6） */
  endedWake = false;
  /** 进入协作模式前最后一次关闭模式的运行启用的工具名（写进 mori.team 的 tools，§5.5） */
  lastOffTools: string[] | null = null;
  /** 回到关闭模式时要恢复的工具（最后一条带 tools 的 mori.team）；恢复后清掉 */
  offRestore: string[] | null = null;
  /** 模式改变时对话正在运行：这次运行结束后再改模型层的锁定（§5.1、§12.11） */
  pendingLock = false;
  /** 要在对话的当前助手消息结束后写的用户会话条目（§5.1 mori.team、§13.2 回执） */
  pendingEntries: { customType: string; data: unknown; event: KernelEvent | null }[] = [];
  /** 用户会话正在输出一条助手消息（它的 message_start 到 message_end）：这时要写的条目等它结束（§13.2） */
  userOutputting = false;
  /** 用户会话下一次运行（before_agent_start 定下） */
  nextUserRun: UserRunStart = { mode: 'off', allowed: null };
  /** 程序投递到用户会话、还没写下 mori.wake 条目的消息（§5.6） */
  expectWake: { text: string; kind: WakeKind } | null = null;
  /** Team 已关闭（会话关闭） */
  closed = false;
  /** board.json 的写出排成一条（同一个临时文件，§3） */
  private saving: Promise<void> = Promise.resolve();
  /** 已经写进内存、还没写出到 board.json 的写入数（不为 0 时 pump 等写出之后再开始运行，§3） */
  private unsaved = 0;
  /** 协作模式下你的消息按发送顺序处理（/task 进入 once 时先写模式、改模型层的锁定） */
  private inbox: Promise<void> = Promise.resolve();
  /** 上一次发出的 mori.team_state（没变时不重发） */
  private lastState = '';
  /**
   * 还没做完的后续：运行结束后排着或做着的 afterRun、TaskBoard 写出之后的唤醒与调度。不为 0 时下一步可能还没排上，
   * busy() 仍为真（增强运行的结束条件，记忆规格 §9.6）
   */
  private followUps = 0;
  /** mori.board 的合并发送（§13.3） */
  private readonly boardEvents: Throttle;

  /**
   * @param host 会话表提供的操作
   * @param args 用户会话、角色、目录与共用的信任和批准状态
   */
  constructor(readonly host: TeamHost, readonly args: TeamArgs) {
    this.userId = args.userSessionId;
    this.holders = args.roles.holders;
    this.roles = args.roles.roles;
    this.roleNames = [...new Set([BASE_ROLE, ...this.roles.map((role) => role.name)])];
    this.summaries = this.roles.filter((role) => role.name !== BASE_ROLE)
      .map((role) => ({ name: role.name, description: role.description }));
    this.merged = args.roles.merged;
    this.sessionsDir = join(args.teamDir, SESSIONS_DIR);
    this.subscribers = this.roles.filter((role) => role.subscribe.length > 0).map((role) => ({
      role: role.name,
      requestClosed: role.subscribe.map((sub) => ({ ruledOut: sub.ruledOut ?? undefined,
        outcome: sub.outcome ?? undefined })),
    }));
    this.user = newLane({ key: USER_SESSION, id: this.userId, kind: 'user', role: this.holders.dialog, task: null,
      request: null, readOnly: false, team: false });
    this.user.open = true;
    this.lanes.set(this.user.key, this.user);
    this.boardEvents = new Throttle(BOARD_EVENT_INTERVAL_MS, () => this.sendBoard());
    this.flow = new UserFlow(this);
  }

  // ---- TeamLike：会话表的入口 ----

  /** @brief 用户会话的 mori-team（§6.3、§8.5）：工具在有别的角色或用过协作模式时注册，否则第一次进入协作模式时注册。 */
  userExtension(): ExtensionFactory {
    return teamExtension(this.userHooks());
  }

  /**
   * @brief 用户会话建好之后：读 TaskBoard 与 mori.team，重新打开时把非终态的 task 停下（§11.6，没有自动恢复），
   *        记下已有的实例会话文件，协作模式下锁定模型层的范围（§12.11）。
   * @param user 用户会话的 pi 会话与模型层
   */
  async attachUser(user: UserAttach): Promise<void> {
    this.userSession = user;
    this.board = await loadBoard(this.args.teamDir);
    const saved = savedTeamEntry(user.session.sessionManager.getSessionFile() ?? this.args.userSessionFile);
    this.mode = saved?.mode ?? 'off';
    // 关闭模式下重新打开也一样：pi 从会话记录恢复的可能是最后一次协作模式运行的那一组（§5.5）
    this.offRestore = saved?.tools ?? null;
    this.scanInstanceFiles();
    this.teamEdited = boardEdited(this.board) || await this.instancesEdited();
    await this.flow.prepare();
    if (this.args.restored) this.recoverAfterRestart(user);
    if (this.mode !== 'off' || this.boardUsed()) this.registerUserTools();
    if (this.mode !== 'off') await user.model.setTeamLock(true, this.dialogSource(true));
    this.emitState();
    this.emitBoard();
  }

  /**
   * @brief 重新打开用户会话（§11.6，没有自动恢复）：非终态的 task 停下（角色不在了的交给结案）；TaskBoard 上有、
   *        用户会话里没有 mori.progress 的需求在对话流末尾补写；你的下一条消息交给立项时唤醒全部结束而没关闭的需求的结案。
   * @param user 用户会话
   */
  private recoverAfterRestart(user: UserAttach): void {
    const recovered = applyRestartRecovery(this.board, this.roleNames);
    if (recovered.stopped.length) {
      console.log(`[kernel] ${this.userId}: stopped after restart: ${recovered.stopped.join(', ')}`);
      this.write(() => ({ board: recovered.board, error: null }));
    }
    const manager = user.session.sessionManager;
    for (const request of missingProgress(this.board, manager.getBranch() as SessionEntryLike[])) {
      console.log(`[kernel] ${this.userId}: placing the missing progress summary of request ${request}`);
      manager.appendCustomEntry(TEAM_ENTRY_TYPES.progress, { request });
    }
    this.endedWake = true;
  }

  /**
   * @brief 这条消息是否交给 Team（§5.1、§5.3）：协作模式下，或带 team: 'once'；pi 的扩展命令照 v0 直接交给对话会话
   *        （记下它，它用 sendUserMessage 开始的运行的工作卡写 No decision）。
   * @param text 你输入的原文
   * @param team 以 /task <文字> 发出
   */
  takesPrompt(text: string, team: 'once' | undefined): boolean {
    if (this.mode === 'off' && team !== 'once') return false;
    const command = /^\/(\S+)/.exec(text.trim())?.[1];
    const runner = this.userSession?.session.extensionRunner;
    if (command === undefined || runner?.getCommand(command) === undefined) return true;
    this.flow.noteCommand(command);
    return false;
  }

  /**
   * @brief /task /<扩展命令>（§5.1、§5.3）：命令照 v0 直接交给对话会话，关闭模式下先进入 once（按发送顺序，
   *        写 mori.team、改模型层的锁定），命令开始的运行用协作模式的工具。
   * @return 模式改好之后兑现，从不拒绝
   */
  enterOnce(): Promise<void> {
    this.inbox = this.inbox.then(async () => {
      if (this.mode === 'off' && !this.closed) await this.changeMode('once');
    }).catch((error: unknown) => {
      console.error(`[kernel] ${this.userId}: entering once failed: ${(error as Error).message}`);
    });
    return this.inbox;
  }

  /**
   * @brief 协作模式下的一条你的消息（§5.3），按发送顺序处理；/task <文字> 在关闭模式下先进入 once。
   * @param item 消息与引用芯片
   * @param behavior 回复中发送时的选择
   * @param team 以 /task <文字> 发出
   */
  onUserPrompt(item: HeldItem, behavior: PromptBehavior | undefined, team: 'once' | undefined): void {
    this.inbox = this.inbox.then(() => this.takeUserPrompt(item, behavior, team)).catch((error: unknown) => {
      console.error(`[kernel] ${this.userId}: the message was not taken: ${(error as Error).message}`);
    });
  }

  /**
   * @brief 一条你的消息交给立项：分开时进待判断队列（teamFlow.ts）；合并会话照普通发送交给用户会话（空闲时开始回复，
   *        回复中按 Enter / Ctrl+Enter），这个回合里的判断由 mori-team 的 message_start 开始。停止或重启之后的第一条
   *        同时唤醒全部结束而没关闭的需求的结案（§11.4、§11.6）。
   */
  private async takeUserPrompt(item: HeldItem, behavior: PromptBehavior | undefined,
    team: 'once' | undefined): Promise<void> {
    if (team === 'once' && this.mode === 'off') await this.changeMode('once');
    if (this.closed) return;
    if (this.endedWake) {
      this.endedWake = false;
      this.wakeEndedRequests();
    }
    if (!this.merged) {
      this.flow.prompt(item, behavior);
      return;
    }
    this.flow.handMerged(item.text);
    const status = this.host.status(this.userId);
    if (status && (status.running || status.preparing)) {
      this.host.dialogQueue(this.userId, item, behavior ?? 'followUp');
      return;
    }
    this.user.busy = true;
    void this.host.dialogStart(this.userId, item).finally(() => this.userReplyDone());
  }

  /**
   * @brief 用户会话的每个 pi 事件：运行的开始与结束（§9.4）、回复里的消息（mori.wake 条目、回执的写入时机，§5.6、§13.2）。
   * @param event pi 事件
   */
  onUserEvent(event: AgentSessionEvent): void {
    this.laneEvent(this.user, event);
  }

  /**
   * @brief session.setTeam（§5.1）：打开为 always；关掉时满足“回到 off 的条件”为 off，否则 once；协作模式下对话会话
   *        被拒绝启动时直接回到 off（拒绝启动卡的 Turn off task mode）。
   * @param mode on / off
   */
  async setMode(mode: TeamSwitch): Promise<TeamState> {
    if (mode === 'on') await this.changeMode('always');
    else if (this.mode !== 'off' && this.userSession?.model.isBlocked()) await this.turnOffBlocked();
    else await this.changeMode(this.canReturnOff() ? 'off' : 'once');
    return this.teamState();
  }

  /**
   * @brief 协作模式下对话会话被拒绝启动时关掉协作模式（§5.1 第 3 条）：不看回到 off 的条件；未关闭需求的非终态 task
   *        变为 stopped（stopReason user，它们的实例一并停下），需求留在 TaskBoard 上。
   */
  private async turnOffBlocked(): Promise<void> {
    const live = liveTaskIds(this.board);
    const lanes = [...this.lanes.values()].filter((lane) => (lane.kind === 'task' || lane.kind === 'close')
      && lane.request !== null && findRequest(this.board, lane.request)?.status === 'open');
    for (const lane of lanes) this.dropQueue(lane);
    if (live.length) this.write((board) => ({ board: markStopped(board, live, 'user'), error: null }));
    await Promise.all(lanes.map((lane) => this.stopLane(lane, 'user')));
    console.log(`[kernel] ${this.userId}: team mode off while blocked; stopped ${live.join(', ') || 'none'}`);
    await this.changeMode('off');
  }

  /**
   * @brief Stop agents（§11.4）：清空全部投递队列（记日志），交给角色的与结案正在处理的 task 变为 stopped，
   *        停止全部 Agent（原因 user；挂起的批准按拒绝处理），待判断的消息回到输入框。
   * @return 回到输入框的消息，按发送顺序
   */
  async stopTeam(): Promise<{ texts: string[] }> {
    const texts = await this.flow.withdrawAll(() => this.stopAllAgents());
    this.endedWake = true;
    return { texts };
  }

  /**
   * @brief 你停止了对话的回复（§11.4）：这次回复开出的临时提问、正在为你的消息判断的立项一并停止（原因 dialog），
   *        待判断的消息回到输入框；后台的 task 实例、结案、订阅照常，投递队列里给用户会话的程序投递保留。
   * @return 撤回的待判断消息，按发送顺序（对话正在为它准备中的那条由会话表随准备中撤回）
   */
  async onDialogStop(): Promise<string[]> {
    const asks = [...this.lanes.values()].filter((lane) => lane.kind === 'ask' && lane.parent === this.user.key);
    return this.flow.withdrawAll(async (judging) => {
      const create = judging ? [this.stopLane(this.createLane(), 'dialog')] : [];
      await Promise.all([...asks.map((lane) => this.stopLane(lane, 'dialog')), ...create]);
    });
  }

  /** @brief session.clearQueue（§5.3）：撤回立项还没开始判断的消息。 */
  withdrawDeciding(): string[] {
    return this.flow.withdraw();
  }

  /**
   * @brief 你在后台批准卡上的选择（§11.3）：交给那个实例。
   * @return 是后台批准卡时为 true；不是时为 false（交给对话自己的批准扩展）
   */
  answerApproval(requestId: string, decision: ApprovalDecision, reason?: string): boolean {
    const pending = this.approvals.get(requestId);
    if (!pending) return false;
    if (!this.host.answerApproval(pending.instance, requestId, decision, reason)) {
      throw new Error(`Approval request ${requestId} is no longer pending`);
    }
    return true;
  }

  /** @brief SessionInfo 与快照的协作部分（§13.10）。 */
  info(): Pick<SessionInfo, 'team' | 'board' | 'teamApprovals' | 'deciding'> {
    return { team: this.teamState(), board: this.view(), teamApprovals: [...this.approvals.values()]
      .map((item) => item.request), deciding: this.decidingState() };
  }

  /** @brief 侧栏的状态（LiveStatus）。 */
  live(): { teamBusy: boolean; teamApproval: boolean } {
    return { teamBusy: this.background(), teamApproval: this.approvals.size > 0 };
  }

  /** @brief 用户会话这次请求的工作卡的 token 估算（用户会话 ModelSession 的 extraContextTokens，§8.3、§12.6）。 */
  cardTokens(): number {
    const card = this.cardText(this.user, []);
    return card === null ? 0 : cardTokens(card);
  }

  /**
   * @brief 有任何 Agent 在运行或排队、或有待判断的消息（拒绝关闭、归档、删除，§11.5）；一次运行结束或 TaskBoard 写入之后
   *        下一步还没排上时也算（followUps，记忆规格 §9.6：增强运行等 Team 空闲才结束）。
   */
  busy(): boolean {
    const status = this.host.status(this.userId);
    return this.followUps > 0 || this.background() || this.user.busy || Boolean(status?.running || status?.preparing);
  }

  /** @brief 关闭用户会话前：关闭全部实例会话（会话文件与 board.json 留着），不再发事件。 */
  async close(): Promise<void> {
    this.closed = true;
    this.boardEvents.cancel();
    this.flow.close();
    const open = [...this.lanes.values()].filter((lane) => lane !== this.user && lane.open);
    await Promise.all(open.map((lane) => this.releaseLane(lane)));
    await this.saving;
  }

  // ---- 状态与事件（§13.10） ----

  /** @brief 待判断、还没交给对话的消息（§5.3）。 */
  get deciding(): DecidingMessage[] {
    return this.flow.deciding();
  }

  /** @brief 除对话这次运行之外还有 Agent 在运行或排队，或有待判断的消息（TeamState.background）。 */
  background(): boolean {
    for (const lane of this.lanes.values()) {
      if (lane === this.user ? hasQueued(lane) : laneActive(lane)) return true;
    }
    return this.deciding.length > 0 || this.waitingSubs.length > 0 || this.waiting.length > 0;
  }

  /** @brief 协作状态（mori.team_state）。 */
  teamState(): TeamState {
    return { mode: this.mode, holders: this.holders, roles: this.summaries, busy: this.busy(),
      background: this.background() };
  }

  /** @brief 协作状态变了时发 mori.team_state。 */
  emitState(): void {
    if (this.closed) return;
    const state = this.teamState();
    const text = JSON.stringify(state);
    if (text === this.lastState) return;
    this.lastState = text;
    this.host.emitUser(this.userId, { type: 'mori.team_state', ...state });
  }

  /** @brief 开始一段后续（followUps）：做完之前 busy() 仍为真。 */
  private holdFollowUp(): void {
    this.followUps += 1;
  }

  /** @brief 一段后续做完：都做完时协作状态变了就发 mori.team_state（看它重新判断的一方由此看到真正的空闲）。 */
  private releaseFollowUp(): void {
    this.followUps -= 1;
    if (this.followUps === 0) this.emitState();
  }

  /**
   * @brief 排一次运行结束之后的处理（setTimeout(0)，§14.2），排着与做着的期间算一段后续。
   * @param lane 结束的会话
   * @param first 在 afterRun 之前要做的（可以没有）
   */
  private queueAfterRun(lane: Lane, first?: () => void): void {
    this.holdFollowUp();
    setTimeout(() => {
      try {
        first?.();
        this.afterRun(lane);
      } finally {
        this.releaseFollowUp();
      }
    }, 0);
  }

  /** @brief TaskBoard 视图变了（合并发送，最多每 250 毫秒一次）。 */
  emitBoard(): void {
    if (!this.closed) this.boardEvents.request();
  }

  /** @brief 发 mori.board；有还没写出到 board.json 的写入时等它写出再发（§3：写出之后才发事件）。 */
  private sendBoard(): void {
    if (this.closed) return;
    if (this.unsaved > 0) {
      void this.saving.then(() => this.emitBoard());
      return;
    }
    this.host.emitUser(this.userId, { type: 'mori.board', ...this.view() });
    this.emitState();
  }

  /** @brief 立项判断你的消息（mori.team_deciding 的载荷、SessionInfo.deciding，§13.10）。 */
  decidingState(): TeamDeciding {
    return { role: this.holders.create, since: this.flow.since(), queue: this.deciding };
  }

  /** @brief 发 mori.team_deciding（阶段行与排队区，§5.3）。 */
  emitDeciding(): void {
    if (this.closed) return;
    this.host.emitUser(this.userId, { type: 'mori.team_deciding', ...this.decidingState() });
    this.emitState();
  }

  /** @brief TaskBoard 的视图（§13.10）。 */
  view(): ReturnType<typeof boardView> {
    const live = new Map<string, TaskLive>();
    for (const task of this.board.tasks) {
      const info = this.taskLive(task.id);
      if (info) live.set(task.id, info);
    }
    return boardView(this.board, { holders: this.holders, waiting: this.waiting, live, teamEdited: this.teamEdited,
      hasSession: (of) => this.hasSession(of) });
  }

  /**
   * @brief 一条实例会话有没有（Background tasks 的 View transcript，§13.13）：开着，或会话文件已写盘（pi 在第一条助手
   *        消息之后才写，§14.5）。
   * @param of task 上某个角色的 task 实例会话，或一个需求的结案会话
   */
  hasSession(of: SessionOf): boolean {
    const ids = of.kind === 'task' ? LANE_IDS.task(this.userId, of.task, of.role)
      : LANE_IDS.close(this.userId, of.request);
    if (this.host.entry(ids.id)) return true;
    const file = this.lanes.get(ids.key)?.file ?? this.knownFiles.get(ids.id) ?? null;
    return file !== null && existsSync(file);
  }

  /**
   * @brief board.readTask（§13.13.3，只读）：一个 task 的详情。
   * @param id task 编号
   * @return 详情；没有这个 task 时抛出 T9 does not exist.
   */
  readTask(id: string): TaskDetail {
    const detail = taskDetail(this.board, id, (task, file) => this.instanceRole(task, file));
    if (!detail) throw new Error(`${id} does not exist.`);
    return detail;
  }

  /**
   * @brief 一个实例会话文件是这个 task 上哪个角色的（程序写的一棒的 View transcript，§13.13.3）：开着的实例按它的文件，
   *        没开着的按 knownFiles（id 为 <用户>.<task>.<角色>）；按文件名比，不比目录的写法。
   * @return 不是这个 task 的实例会话时为 null
   */
  private instanceRole(task: string, file: string): string | null {
    const name = basename(file);
    const lane = [...this.lanes.values()].find((item) => item.kind === 'task' && item.task === task
      && item.file !== null && basename(item.file) === name);
    if (lane) return lane.role;
    const prefix = LANE_IDS.task(this.userId, task, '').id;
    const known = [...this.knownFiles].find(([id, path]) => id.startsWith(prefix) && basename(path) === name);
    return known ? known[0].slice(prefix.length) : null;
  }

  /** @brief board.readSession（§13.13.4，只读）：见 teamTools.readBackgroundSession。 */
  readSession(of: SessionOf): ReturnType<typeof readBackgroundSession> {
    return readBackgroundSession(this, of);
  }

  /** @brief 一个 task 此刻的运行状态：持有它的角色的实例（没有时取这个 task 上最近有提示的实例）。 */
  private taskLive(task: string): TaskLive | null {
    const item = findTask(this.board, task);
    const holder = item?.holder?.kind === 'role' ? item.holder.role : null;
    const lanes = [...this.lanes.values()].filter((lane) => lane.kind === 'task' && lane.task === task);
    const lane = lanes.find((candidate) => candidate.role === holder) ?? lanes.find((candidate) => candidate.modelNote);
    if (!lane) return null;
    const approval = [...this.approvals.values()].some((pending) => pending.instance === lane.id);
    const phase = lane.role !== holder || !lane.busy ? null : approval ? 'approval'
      : lane.started && lane.current ? 'running' : 'starting';
    return { phase, current: lane.current, modelNote: lane.modelNote };
  }

  // ---- 会话（§8.1） ----

  /** @brief 立项会话：合并会话时就是用户会话；分开时这个用户会话一条连续的立项会话（§8.1）。 */
  createLane(): Lane {
    if (this.merged) return this.user;
    const ids = LANE_IDS.create(this.userId);
    return this.laneFor(ids, { kind: 'create', role: this.holders.create, task: null, request: null });
  }

  /**
   * @brief 一个需求的结案会话（§8.1）。
   * @param request 需求编号
   */
  closeLane(request: number): Lane {
    const ids = LANE_IDS.close(this.userId, request);
    return this.laneFor(ids, { kind: 'close', role: this.holders.close, task: null, request });
  }

  /**
   * @brief 结案在这个需求上发给立项的消息还有没处理完的（§7.6）：还在立项的投递队列里，或立项收到它的那次运行还没结束
   *        （还没开始，或开始了还没处理完结束）。
   * @param request 需求编号
   */
  closeAskPending(request: number): boolean {
    const lane = this.merged ? this.user : this.lanes.get(LANE_IDS.create(this.userId).key);
    if (!lane) return false;
    const inRun = lane.busy && (!lane.started || lane.run !== null);
    return [...lane.solo, ...lane.queue, ...(inRun ? lane.inflight : [])]
      .some((item) => item.meta.closeAsk === request);
  }

  /**
   * @brief 一个（task，角色）的 task 实例（§8.1：交回同一角色就继续这条会话）。
   * @param task task 编号
   * @param role 角色
   */
  taskLane(task: string, role: string): Lane {
    const ids = LANE_IDS.task(this.userId, task, role);
    const item = findTask(this.board, task);
    return this.laneFor(ids, { kind: 'task', role, task, request: item?.request ?? null,
      readOnly: item?.readOnly ?? false });
  }

  /** @brief 按键取会话，没有时新建（协作模式下建立）。 */
  private laneFor(ids: { key: string; id: string },
    fields: Pick<Lane, 'kind' | 'role' | 'task' | 'request'> & { readOnly?: boolean }): Lane {
    const found = this.lanes.get(ids.key);
    if (found) return found;
    const lane = newLane({ ...ids, ...fields, readOnly: fields.readOnly ?? false, team: true });
    this.lanes.set(lane.key, lane);
    return lane;
  }

  /** @brief 打开会话时记下已有的实例会话文件（<时刻>_<id>.jsonl，§3、§14.5）。 */
  private scanInstanceFiles(): void {
    let names: string[];
    try {
      names = existsSync(this.sessionsDir) ? readdirSync(this.sessionsDir) : [];
    } catch (error) {
      console.error(`[kernel] cannot list ${this.sessionsDir}: ${(error as Error).message}`);
      return;
    }
    for (const name of names.filter((item) => item.endsWith('.jsonl')).sort()) {
      const id = name.slice(name.indexOf('_') + 1, -'.jsonl'.length);
      this.knownFiles.set(id, join(this.sessionsDir, name));
    }
  }

  /**
   * @brief 打开会话时：这个 TaskBoard 的 task 实例会话里有没有成功的 edit、write（§13.10 teamEdited、§13.12）。
   *        交接的 authorFamilies 记不下被停止、撤销、重启前没交接的那一棒，所以读实例会话文件。
   */
  private async instancesEdited(): Promise<boolean> {
    const prefix = `${this.userId}.`;
    for (const [id, file] of this.knownFiles) {
      if (id.startsWith(prefix) && /^t\d+\./.test(id.slice(prefix.length)) && await sessionEdited(file)) return true;
    }
    return false;
  }

  // ---- TaskBoard 的写入（§3、§6.2） ----

  /**
   * @brief 一次写入：在内存里改（校验与改写由 change 做，纯函数），成功时排队写出 board.json，写出之后发 mori.board、
   *        唤醒与调度。
   * @param change 写入（board.ts 的写入函数）
   * @return 写入的结果；被拒绝时 TaskBoard 不变
   */
  write<Extra extends object>(change: (board: Board) => BoardWrite<Extra>): BoardWrite<Extra> {
    const before = this.board;
    const result = change(before);
    if (result.error === null && result.board !== before) {
      this.board = result.board;
      const over = handedOver(before, result.board);
      for (const lane of this.lanes.values()) if (lane.task !== null && over.includes(lane.task)) lane.modelNote = null;
      this.committed(before, result.board);
    }
    return result;
  }

  /**
   * @brief 写出之后：发 mori.board，按写入前后的比较唤醒（§9.1），重新调度（§9.2）。写出之前 pump 不开始任何运行
   *        （§3：board.json 先写出，再唤醒或开始任何人）。写出到唤醒、调度做完算一段后续（followUps）。
   */
  private committed(before: Board, after: Board): void {
    this.unsaved += 1;
    this.holdFollowUp();
    const saved = this.saving.then(() => saveBoard(this.args.teamDir, after)).catch((error: unknown) => {
      console.error(`[kernel] ${this.userId}: the TaskBoard was not written: ${(error as Error).message}`);
    }).finally(() => {
      this.unsaved -= 1;
    });
    this.saving = saved;
    void saved.then(() => {
      if (this.closed) return;
      this.emitBoard();
      for (const wake of wakesAfter(before, after, this.subscribers)) this.wake(wake);
      for (const lane of this.lanes.values()) if (lane.kind === 'task') this.releaseIfDone(lane);
      this.schedule();
    }).finally(() => this.releaseFollowUp());
  }

  /** @brief 一次唤醒（§9.1）：交给结案、结案的全部结束、立项、对话汇报、订阅；交给角色的由调度开始。 */
  private wake(wake: BoardWake): void {
    switch (wake.kind) {
      case 'schedule': return;
      case 'close_task': {
        const task = findTask(this.board, wake.task);
        this.enqueue(this.closeLane(wake.request), this.delivery('close_task', { task: wake.task,
          reason: task?.holderReason ?? 'handed to you', latest: task?.handoffs.at(-1) ?? null },
        { kind: 'close_task', task: wake.task }));
        return;
      }
      case 'close_all_ended':
        this.enqueue(this.closeLane(wake.request), this.delivery('close_all_ended', { request: wake.request,
          createRole: this.holders.create }, { kind: 'close_all_ended', request: wake.request }));
        return;
      case 'create_need_user': return this.wakeCreateForTask(wake.task);
      case 'create_question': {
        const question = findRequest(this.board, wake.request)?.question ?? '';
        this.enqueueCreate(this.delivery('create_question', { question }, { kind: 'question', request: wake.request }));
        return;
      }
      case 'dialog_closed': return this.reportClosed(wake.request);
      case 'subscription':
        this.waitingSubs.push({ id: LANE_IDS.subscription(this.userId, wake.request, wake.role).key,
          readyAt: Date.now(), role: wake.role, request: wake.request });
    }
  }

  /** @brief task 等用户拿主意：唤醒立项（§7.7 第 1 步）。 */
  private wakeCreateForTask(id: string): void {
    const task = findTask(this.board, id);
    if (!task) return;
    const from = task.holder?.kind === 'role' ? task.holder.role : `close:${this.holders.close}`;
    this.enqueueCreate(this.delivery('create_need_user', { task: id, question: task.question ?? '', from,
      merged: this.merged }, { kind: 'need_user', task: id }));
  }

  /** @brief 需求关闭：对话去向你汇报（§5.6 request_closed）；它的结案会话与 task 实例在空闲后关闭（§7.6）。 */
  private reportClosed(no: number): void {
    const request = findRequest(this.board, no);
    if (!request) return;
    this.enqueueUser(this.delivery('request_closed', { board: this.board, request }, { kind: 'message' }),
      'request_closed');
    for (const lane of this.lanes.values()) if (lane.request === no) this.releaseIfDone(lane);
  }

  // ---- 调度（§9.2） ----

  /** @brief 重新调度：这一刻要开始的 task 实例与订阅实例（同时运行上限、写入锁）。 */
  schedule(): void {
    if (this.closed || !this.userSession) return;
    const running = [...this.lanes.values()].filter((lane) => (lane.kind === 'task' || lane.kind === 'subscription')
      && laneActive(lane)).map((lane) => ({ kind: lane.kind as 'task' | 'subscription', role: lane.role,
      task: lane.task }));
    const result = scheduleStarts(this.board, running, RUN_CAP, this.waitingSubs);
    this.waiting = result.waiting;
    if (result.board !== this.board) this.write(() => ({ board: result.board, error: null }));
    for (const start of result.starts) this.startTask(start.task, start.role);
    for (const id of result.subscriptions) this.startSubscription(id);
    this.emitBoard();
    this.emitState();
  }

  /** @brief task 交给一个角色：这个角色在这个 task 上已有实例就继续，没有就新开（§9.1、§8.5 的两种投递）。 */
  private startTask(id: string, role: string): void {
    const task = findTask(this.board, id);
    if (!task) return;
    const lane = this.taskLane(id, role);
    const ran = this.hasRun(lane);
    const reason = this.backReasons.get(id) ?? null;
    this.backReasons.delete(id);
    const text = ran
      ? deliveryText('task_back', { task: id, latest: task.handoffs.at(-1) ?? null, reason })
      : deliveryText('task_start', { role, task: id, request: task.request });
    this.enqueue(lane, { user: false, text, cause: { kind: 'task_start', task: id, role }, at: Date.now(), meta: {} });
  }

  /**
   * @brief 这个实例会话收到过投递（task_back 还是 task_start，§8.5）：开着的看会话里有没有回合；没开着的看会话文件是否
   *        已写盘（pi 在第一条用户或助手消息之后才写，§14.5）。只建了会话、第一次投递没开始运行的不算。
   */
  private hasRun(lane: Lane): boolean {
    if (this.host.entry(lane.id)) return turnCount(this.branchOf(lane)) > 0;
    const file = lane.file ?? this.knownFiles.get(lane.id) ?? null;
    return file !== null && existsSync(file);
  }

  /**
   * @brief task 都已结束而需求还开着的需求，按 §7.6 唤醒它们的结案（§11.4、§11.6：停止或重启之后，由你的下一条消息
   *        交给立项时调用，不算自动恢复）。
   */
  wakeEndedRequests(): void {
    for (const request of requestsAwaitingClose(this.board)) {
      this.enqueue(this.closeLane(request), this.delivery('close_all_ended', { request,
        createRole: this.holders.create }, { kind: 'close_all_ended', request }));
    }
  }

  /** @brief 订阅的时刻命中、轮到它（§9.5）：新开一个订阅实例，投递需求关闭的文字。 */
  private startSubscription(id: string): void {
    const index = this.waitingSubs.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [sub] = this.waitingSubs.splice(index, 1);
    const request = sub ? findRequest(this.board, sub.request) : undefined;
    if (!sub || !request) return;
    const ids = LANE_IDS.subscription(this.userId, sub.request, sub.role);
    const lane = this.laneFor(ids, { kind: 'subscription', role: sub.role, task: null, request: sub.request });
    this.enqueue(lane, this.delivery('subscription', { board: this.board, request }, { kind: 'message' }));
  }

  // ---- 投递（§5.6、§8.2） ----

  /**
   * @brief 一次程序投递。
   * @param kind 投递的种类（boardText.deliveryText）
   * @param args 这种投递的参数
   * @param cause 要它处理的事（开始运行前据此检查是否过期）
   * @param meta 队列之外要带着的东西
   */
  delivery<K extends DeliveryKind>(kind: K, args: DeliveryArgs[K], cause: DeliveryCause,
    meta: DeliveryMeta = {}): TeamDelivery {
    return { user: false, text: deliveryText(kind, args), cause, at: Date.now(), meta };
  }

  /** @brief 排进一个会话的投递队列，空闲时开始。 */
  enqueue(lane: Lane, delivery: TeamDelivery): void {
    if (this.closed) return;
    lane.queue.push(delivery);
    this.pump(lane);
  }

  /** @brief 排进单独占一次运行的投递（强制填写、换模型继续）。 */
  enqueueSolo(lane: Lane, delivery: TeamDelivery): void {
    if (this.closed) return;
    lane.solo.push(delivery);
    this.pump(lane);
  }

  /** @brief 投递给立项：合并会话时进用户会话（§5.6 create_wake）。 */
  enqueueCreate(delivery: TeamDelivery): void {
    if (this.merged) delivery.meta.wake = 'create_wake';
    this.enqueue(this.createLane(), delivery);
  }

  /**
   * @brief 程序投递到用户会话（§5.6）。
   * @param delivery 投递
   * @param kind mori.wake 的种类
   */
  enqueueUser(delivery: TeamDelivery, kind: WakeKind): void {
    delivery.meta.wake = kind;
    this.enqueue(this.user, delivery);
  }

  /** @brief 用户会话空闲：没有在运行或准备中，也没有 Team 开始、还没结束的回复。 */
  userIdle(): boolean {
    const status = this.host.status(this.userId);
    return !this.user.busy && this.user.settling === null && !status?.running && !status?.preparing;
  }

  /**
   * @brief 会话空闲时开始下一次运行（§8.2）：过期的投递丢弃并记日志，相邻的程序投递合并。
   *        有还没写出的 TaskBoard 写入时等它写出再开始（§3、§6.2：运行结束后重新调度时也一样）。
   */
  pump(lane: Lane): void {
    if (this.closed || lane.busy || lane.settling !== null || !hasQueued(lane)) return;
    if (this.unsaved > 0) {
      void this.saving.then(() => this.pump(lane));
      return;
    }
    if (lane === this.user && (!this.userSession || !this.userIdle())) return;
    if (lane === this.user && this.pendingLock) {
      // 模式在上一次回复中改过：先改锁定，这次投递按此刻的模式选模型（§12.1、§12.11）
      void this.applyLock().catch((error: unknown) => this.lockFailed(error)).then(() => this.pump(lane));
      return;
    }
    for (const list of [lane.solo, lane.queue]) {
      const { kept, dropped } = dropStale(list, this.board);
      for (const item of dropped as TeamDelivery[]) {
        console.log(`[kernel] ${lane.id}: dropped a stale delivery (${item.cause.kind})`);
        item.meta.waiter?.settle('The message is no longer needed.', true);
      }
      list.splice(0, list.length, ...(kept as TeamDelivery[]));
    }
    const batch = takeBatch(lane);
    if (!batch.length) {
      this.releaseIfDone(lane);
      return;
    }
    lane.busy = true;
    lane.started = false;
    lane.inflight = batch;
    lane.startUnavailable = null;
    if (lane.kind === 'create') this.flow.judgingStarted(batch);
    void this.deliverBatch(lane, batch);
  }

  /**
   * @brief 开始一次投递：打开会话，合并文字（立项会话加上自上次以来的对话），经会话表的发送路径投递。
   *        用户会话不用打开，从 pump 到 host.deliver 之间没有等待，你这时发的消息看到的就是准备中（§5.6）。
   */
  private async deliverBatch(lane: Lane, batch: TeamDelivery[]): Promise<void> {
    try {
      if (lane !== this.user) await this.ensureOpen(lane);
      // 建、开实例会话期间到来的停止（Stop agents、Esc、撤销需求）：这次投递不发出，按被停止、没开始的运行处理（§9.4、§11.4）
      if (lane.stop !== null || this.closed) return await this.deliveryDone(lane);
      let text = joinDeliveries(batch);
      if (lane.kind === 'create') text = this.withCatchUp(lane, text);
      const wake = batch.find((item) => item.meta.wake)?.meta.wake;
      if (lane === this.user && wake) {
        this.expectWake = { text, kind: wake };
        this.host.emitUser(this.userId, { type: 'mori.wake', text, kind: wake });
      }
      const choice = batch.find((item) => item.meta.choice)?.meta.choice;
      this.emitState();
      await this.host.deliver(lane.id, text, choice);
    } catch (error) {
      console.error(`[kernel] ${lane.id}: the delivery failed: ${(error as Error).message}`);
    }
    await this.deliveryDone(lane);
  }

  /**
   * @brief 一次投递结束：没开始运行的按 §9.4 处理（停止、选不到模型、没能开始），然后开始下一次。
   *        Team 已关闭（会话关闭、后台进程退出）时与 laneEvent 一样不再处理（§11.6 没有自动恢复）。
   */
  private async deliveryDone(lane: Lane): Promise<void> {
    if (!lane.started && !this.closed) {
      lane.settling = runEnded(this, lane).catch((error: unknown) => {
        console.error(`[kernel] ${lane.id}: handling the end of the run failed: ${(error as Error).message}`);
      });
      await lane.settling;
      lane.settling = null;
    }
    await lane.settling;
    lane.busy = false;
    lane.started = false;
    lane.inflight = [];
    lane.stop = null;
    lane.pendingCursor = undefined;
    this.queueAfterRun(lane);
  }

  /**
   * @brief 一次运行结束之后（setTimeout(0)，§14.2）：开始队列里的下一次，关闭用完的实例，重新调度。
   *        用户会话空闲了：没写进对话就离开的消息写回执（§13.2），写挂起的条目，运行中（或准备中）改过模式的现在改
   *        模型层的锁定（准备中就结束、没有运行时也一样，§5.1、§12.11），满足回到 off 的条件时 once 结束（§5.1）。
   */
  private afterRun(lane: Lane): void {
    if (this.closed) return;
    if (lane === this.user && this.pendingLock && this.userIdle()) {
      // 先改锁定，再开始下一次（投递队列里的程序投递按此刻的模式选模型，§12.1）；改锁定的期间也算后续
      this.holdFollowUp();
      void this.applyLock().catch((error: unknown) => this.lockFailed(error)).then(() => this.afterRun(lane))
        .finally(() => this.releaseFollowUp());
      return;
    }
    this.pump(lane);
    if (lane !== this.user) this.pump(this.user);
    else if (this.userIdle()) {
      this.flow.userIdle();
      this.flushEntries();
      if (this.mode === 'once' && this.canReturnOff()) {
        void this.changeMode('off').catch((error: unknown) => this.lockFailed(error));
      }
    }
    this.releaseIfDone(lane);
    this.schedule();
  }

  /** @brief 改模型层的锁定失败（读项目配置出错等）：记日志。 */
  private lockFailed(error: unknown): void {
    console.error(`[kernel] ${this.userId}: changing the model lock failed: ${(error as Error).message}`);
  }

  /** @brief Team 开始的对话回复结束（host.dialogStart 兑现）：没开始运行就结束时清掉停止原因（§9.4 第 0 行）。 */
  userReplyDone(): void {
    this.user.busy = false;
    if (this.user.run === null && this.user.settling === null) this.user.stop = null;
    this.queueAfterRun(this.user);
  }

  /**
   * @brief 会话表开始、Team 不跟踪的一次对话回复结束（关闭模式的发送、交给对话的扩展命令；准备中就结束或运行结束）：
   *        没开始运行就结束时清掉停止原因，然后同一次运行结束之后一样开始投递队列里的下一次、改模型层的锁定（§5.6）。
   */
  replyEnded(): void {
    if (this.closed) return;
    this.queueAfterRun(this.user, () => {
      if (this.userIdle() && this.user.run === null) this.user.stop = null;
    });
  }

  /**
   * @brief 分开时给立项的投递开头带上自上次投递以来的对话（§8.4）；带到了哪里在这次投递开始运行时记下（commitCursor），
   *        没开始运行就结束的投递不算，下一次投递仍从上一个 mori.create_cursor 带起。
   */
  private withCatchUp(lane: Lane, text: string): string {
    const createManager = this.host.entry(lane.id)?.session.sessionManager;
    const userManager = this.userSession?.session.sessionManager;
    if (!createManager || !userManager) return text;
    if (lane.cursor === undefined) {
      const cursors = createManager.getBranch().filter((entry) => entry.type === 'custom'
        && entry.customType === TEAM_ENTRY_TYPES.createCursor);
      const data = (cursors.at(-1) as { data?: { entryId?: unknown } } | undefined)?.data;
      lane.cursor = typeof data?.entryId === 'string' ? data.entryId : null;
    }
    const catchUp = createCatchUp(userManager.getBranch() as SessionEntryLike[], { after: lane.cursor,
      dialogRole: this.holders.dialog });
    lane.pendingCursor = catchUp.cursor;
    return withCatchUp(catchUp.text, text);
  }

  /** @brief 立项的这次投递开始运行（agent_start）：在立项会话里写 mori.create_cursor，记下带到了哪里（§8.4）。 */
  private commitCursor(lane: Lane): void {
    const cursor = lane.pendingCursor;
    if (cursor === undefined) return;
    lane.pendingCursor = undefined;
    lane.cursor = cursor;
    this.host.entry(lane.id)?.session.sessionManager.appendCustomEntry(TEAM_ENTRY_TYPES.createCursor,
      { entryId: cursor });
  }

  // ---- 实例会话（§8.2） ----

  /** @brief 打开实例会话：开着就用；有会话文件就从文件重新打开（pi 恢复上下文）；否则新建。 */
  async ensureOpen(lane: Lane): Promise<void> {
    if (lane === this.user) return;
    if (this.host.entry(lane.id)) {
      lane.open = true;
      await this.refreshSource(lane);
      return;
    }
    const spec = this.instanceSpec(lane);
    const file = lane.file ?? this.knownFiles.get(lane.id) ?? null;
    if (file !== null && existsSync(file)) await this.host.openInstance(file, spec);
    else await this.host.createInstance(spec);
    lane.file = this.host.entry(lane.id)?.sessionFile ?? file;
    if (lane.file !== null) this.knownFiles.set(lane.id, lane.file);
    lane.open = true;
    lane.tagNext = null;
    lane.cursor = undefined;
  }

  /** @brief 建或开一个实例会话的设置（§8.1、§8.2、§8.5、§12）。 */
  private instanceSpec(lane: Lane): InstanceSpec {
    const role = this.roleOf(lane.role);
    const kind = lane.kind === 'user' ? 'create' : lane.kind;
    const appendPrompt = [role.body, ...segments(kind, { role: role.name, roles: this.summaries,
      holders: this.holders, request: lane.request ?? undefined })].filter((part) => part.trim() !== '');
    const instance = {
      kind, role: role.name, ...(kind === 'task' && lane.task ? { task: lane.task } : {}),
      ...((kind === 'close' || kind === 'subscription') && lane.request !== null ? { request: lane.request } : {}),
    };
    return {
      id: lane.id, dir: this.sessionsDir, parentSession: this.userSessionFile(), cwd: this.args.cwd, kind, instance,
      tools: [...toolAllowlist(role, kind, lane.readOnly, this.args.baseTools, lane.team), ...this.memoryTools(kind)],
      appendPrompt, teamExtension: teamExtension(this.laneHooks(lane)), model: this.modelOptions(lane, role),
      trust: this.args.trust, approval: this.args.approval, memory: { enhance: this.args.enhance }, owner: this.userId,
      onEvent: (event) => this.laneEvent(lane, event),
      onModelEvent: (event) => this.onModelEvent(lane, event),
      onApprovalRequest: (request) => this.onApprovalRequest(lane, request),
      onApprovalEnd: (end) => this.onApprovalEnd(end),
    };
  }

  /**
   * @brief 追加在白名单（roles.ts toolAllowlist 的结果）后面的 memory（记忆规格 §7.6）：分开时的立项实例；增强会话的
   *        Team 里另有 task 实例（含只读 task）。其他实例没有，pi 按白名单不注册它。
   * @param kind 实例的种类
   */
  private memoryTools(kind: InstanceKind): string[] {
    const caller = memoryCallerFor(instanceSeats(kind), this.args.enhance?.task ?? null, kind);
    return caller === null ? [] : [MEMORY_TOOL];
  }

  /** @brief 用户会话的文件（实例头部的 parentSession）。 */
  private userSessionFile(): string | null {
    return this.userSession?.session.sessionManager.getSessionFile() ?? this.args.userSessionFile;
  }

  /** @brief 角色定义；不是现在的角色时抛出（重新打开时已按 §11.6 处理）。 */
  roleOf(name: string): RoleDef {
    const role = findRole(this.roles, name);
    if (!role) throw new Error(`Role ${name} is not among the roles of this session`);
    return role;
  }

  /** @brief 实例的模型层选项（§12.1、§12.4、§12.5、§12.7、§12.9、§12.10）。 */
  private modelOptions(lane: Lane, role: RoleDef): InstanceSpec['model'] {
    return {
      source: this.roleSource(lane, role),
      schedClass: this.schedClassOf(lane),
      kind: lane.kind === 'task' ? 'task' : 'normal',
      restartText: (restart) => deliveryText('model_restart', { from: restart.from, to: restart.to,
        reason: plainReasonText(restart.reason, restart.detail), task: lane.task ?? '', role: lane.role }),
      extraContextTokens: () => {
        const card = this.cardText(lane, []);
        return card === null ? 0 : cardTokens(card);
      },
      shape: (attempt) => this.shapeAttempt(lane, attempt),
      onUnavailable: (info) => {
        if (info.firstRequest || !lane.run) lane.startUnavailable = info;
        else lane.run.unavailable = info;
      },
    };
  }

  /** @brief 角色会话的候选来源（§12.1）：角色的 models，没写时用会话的范围；关闭模式下的临时提问取交集；评审避开同族。 */
  private roleSource(lane: Lane, role: RoleDef): CandidateSource {
    const pick = this.userSession?.model.state().pick ?? null;
    this.sourcePicks.set(lane.id, pick);
    const source: CandidateSource = { kind: 'role', role: role.name, models: roleCandidates(role, pick),
      requires: role.requires };
    if (lane.kind === 'ask' && !lane.team) source.within = () => this.userSession?.model.candidateRefs() ?? null;
    if (lane.kind === 'task' && role.differFromAuthor && lane.task) {
      const task = lane.task;
      source.avoidFamilies = () => new Set(findTask(this.board, task)?.handoffs.flatMap((h) => h.authorFamilies));
    }
    return source;
  }

  /**
   * @brief 开着的实例会话的候选来源跟上会话的范围（§12.1：没写 models 的角色用你最后选的范围）：你在关闭模式下改了
   *        范围，之后继续的实例（停下的 task、分开时的立项）按新的范围选；范围没变时不做。
   * @param lane 开着的实例
   */
  private async refreshSource(lane: Lane): Promise<void> {
    const role = findRole(this.roles, lane.role);
    const model = this.host.entry(lane.id)?.model;
    const pick = this.userSession?.model.state().pick ?? null;
    if (!role || role.models || !model || this.sourcePicks.get(lane.id) === pick) return;
    console.log(`[kernel] ${lane.id}: the session range changed; using ${pick ?? 'none'}`);
    await model.setTeamLock(false, this.roleSource(lane, role));
  }

  /**
   * @brief 调度类别（§12.10）：task、订阅、立项与结案；临时提问继承发送方的类别。
   *        增强会话的对话是 background（记忆规格 §9.6），从它发出的临时提问随之为 background。
   */
  private schedClassOf(lane: Lane): SchedClass {
    switch (lane.kind) {
      case 'task': return 'task';
      case 'subscription': return 'background';
      case 'create':
      case 'close': return 'decision';
      case 'user': return this.args.enhance ? 'background' : 'conversation';
      case 'ask': {
        const parent = lane.parent === null ? undefined : this.lanes.get(lane.parent);
        return parent ? this.schedClassOf(parent) : 'conversation';
      }
    }
  }

  /** @brief 对话会话的候选来源（§12.1）：协作模式下按对话持有者的 models，关闭模式下你选的范围。 */
  dialogSource(team: boolean): CandidateSource {
    const role = this.roleOf(this.holders.dialog);
    if (!team) return { kind: 'pick', requires: role.requires };
    const pick = this.userSession?.model.state().pick ?? null;
    return { kind: 'role', role: role.name, models: roleCandidates(role, pick), requires: role.requires };
  }

  /**
   * @brief 用完的实例在空闲时关闭（§7.6、§8.2）：task 结束、需求关闭或撤销后的 task 实例与结案会话，回答完的临时提问，
   *        订阅实例；会话文件留着。
   */
  releaseIfDone(lane: Lane): void {
    if (lane === this.user || !lane.open || laneActive(lane)) return;
    const request = lane.request === null ? undefined : findRequest(this.board, lane.request);
    const task = lane.task === null ? undefined : findTask(this.board, lane.task);
    const done = lane.kind === 'ask' || lane.kind === 'subscription'
      || (lane.kind === 'close' && request?.status !== 'open')
      || (lane.kind === 'task' && (task === undefined || isTaskEnded(task) || request?.status !== 'open'));
    if (done) void this.releaseLane(lane);
  }

  /** @brief 关闭一个实例会话（释放 pi 会话与虚拟模型）；临时提问与订阅的会话不再继续，去掉它的状态。 */
  async releaseLane(lane: Lane): Promise<void> {
    lane.open = false;
    this.sourcePicks.delete(lane.id);
    if (lane.kind === 'ask' || lane.kind === 'subscription') this.lanes.delete(lane.key);
    try {
      await this.host.closeInstance(lane.id);
    } catch (error) {
      console.error(`[kernel] cannot close the instance ${lane.id}: ${(error as Error).message}`);
    }
  }

  /** @brief 会话的当前分支（开着的会话读内存里的；没开着的为空）。 */
  branchOf(lane: Lane): SessionEntryLike[] {
    const manager = lane === this.user ? this.userSession?.session.sessionManager
      : this.host.entry(lane.id)?.session.sessionManager;
    return (manager?.getBranch() ?? []) as SessionEntryLike[];
  }

  // ---- 会话的事件（§9.4、§12.12、§13.3） ----

  /** @brief 一条会话的 pi 事件。 */
  private laneEvent(lane: Lane, event: AgentSessionEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'agent_start':
        if (lane.kind === 'create') this.commitCursor(lane);
        return runStarted(this, lane);
      case 'message_start':
        if (lane === this.user && (event.message as { role?: string }).role === 'assistant') this.userOutputting = true;
        return;
      case 'tool_execution_start':
        lane.current = toolBrief(event.toolName, event.args);
        this.emitBoard();
        return;
      case 'tool_execution_end':
        if (lane.kind === 'task' && !event.isError && (event.toolName === 'edit' || event.toolName === 'write')
          && !this.teamEdited) {
          // 右栏的说明随 TaskBoard 视图更新（§13.12）：第一次改过文件时就发，不等下一次别的变化
          this.teamEdited = true;
          this.emitBoard();
        }
        return;
      case 'message_end': return this.onMessageEnd(lane, event.message);
      case 'agent_settled': return this.onSettled(lane);
      default:
    }
  }

  /** @brief 运行结束（agent_settled）：按 §9.4 处理，处理完之前会话仍算忙。 */
  private onSettled(lane: Lane): void {
    if (lane === this.user) this.userOutputting = false;
    const settling = runEnded(this, lane).catch((error: unknown) => {
      console.error(`[kernel] ${lane.id}: handling the end of the run failed: ${(error as Error).message}`);
    });
    lane.settling = settling;
    void settling.then(() => {
      if (lane.settling === settling) lane.settling = null;
      if (lane === this.user && !this.user.busy) this.queueAfterRun(this.user);
    });
  }

  /** @brief 一条消息结束：助手的文字与错误（§9.4）；用户会话里程序投递的消息写 mori.wake，挂起的条目写在助手消息之后。 */
  private onMessageEnd(lane: Lane, message: Extract<AgentSessionEvent, { type: 'message_end' }>['message']): void {
    const msg = message as { role?: string; stopReason?: string; errorMessage?: string };
    const run = lane.run;
    if (msg.role === 'assistant' && run) {
      run.assistants += 1;
      const text = messageText(message as never).trim();
      if (text) run.lastText = text;
      run.error = msg.stopReason === 'error' ? msg.errorMessage ?? 'The model request failed.' : null;
    }
    if (msg.role === 'user' && lane.kind === 'task' && lane.batonStart === null) {
      queueMicrotask(() => {
        lane.batonStart = turnCount(this.branchOf(lane));
      });
    }
    if (lane !== this.user) return;
    if (msg.role === 'user' && this.expectWake && messageText(message as never) === this.expectWake.text) {
      const kind = this.expectWake.kind;
      this.expectWake = null;
      queueMicrotask(() => this.writeWakeEntry(kind));
    } else if (msg.role === 'user') {
      this.flow.messageEnd();
    }
    if (msg.role !== 'assistant') return;
    this.userOutputting = false;
    if (this.pendingEntries.length) queueMicrotask(() => this.flushEntries());
  }

  /** @brief 程序投递的消息写进会话文件之后，写一条 mori.wake 指向它（§5.6）。 */
  private writeWakeEntry(kind: WakeKind): void {
    const manager = this.userSession?.session.sessionManager;
    const messageId = manager?.getLeafId();
    if (!manager || !messageId) return;
    manager.appendCustomEntry(TEAM_ENTRY_TYPES.wake, { messageId, kind });
  }

  /**
   * @brief 写一条用户会话的条目（mori.team、回执）：对话空闲时立即写；正在输出时在当前助手消息结束后的微任务里写
   *        （§5.1、§13.2、§14.6 T-S6）。
   * @param customType 条目种类
   * @param data 条目内容
   * @param event 同时发的事件；没有时为 null
   */
  writeUserEntry(customType: string, data: unknown, event: KernelEvent | null): void {
    this.pendingEntries.push({ customType, data, event });
    if (!this.userOutputting) this.flushEntries();
  }

  /** @brief 写出挂起的用户会话条目并发事件。 */
  flushEntries(): void {
    const manager = this.userSession?.session.sessionManager;
    if (!manager) return;
    for (const item of this.pendingEntries.splice(0)) {
      manager.appendCustomEntry(item.customType, item.data);
      if (item.event) this.host.emitUser(this.userId, item.event);
    }
  }

  /**
   * @brief 回执（§13.2）：合并会话在工具执行时写（落在那次调用之后、工具结果之前）；程序唤醒的立项回合写在写入时的对话流末尾；
   *        分开时判断用户消息的，在对话写下那条消息之后写（teamFlow.ts）。
   * @param lane 写入的立项会话
   * @param receipt 回执
   */
  receipt(lane: Lane, receipt: ReceiptEntryData): void {
    const event: KernelEvent = { type: 'mori.receipt', ...receipt };
    if (lane === this.user) {
      this.userSession?.session.sessionManager.appendCustomEntry(TEAM_ENTRY_TYPES.receipt, receipt);
      this.host.emitUser(this.userId, event);
    } else if (lane.run?.judgment?.user) {
      this.flow.holdReceipt(lane.run, receipt);
    } else {
      this.writeUserEntry(TEAM_ENTRY_TYPES.receipt, receipt, event);
    }
  }

  /** @brief 实例的模型层事件：最近一条换模型、等待的提示写进这个 task 的 modelNote（§12.12）。 */
  private onModelEvent(lane: Lane, event: ModelEvent): void {
    if (event.type === 'mori.model_switch') {
      lane.modelNote = `Switched model: ${event.from} → ${event.to} · ${plainReasonText(event.reason, event.detail)}`;
    } else if (event.type === 'mori.model_wait' && event.active && event.kind === 'model') {
      const reason = event.reason !== null && isUntilReason(event.reason) ? REASON_TEXTS[event.reason](event.until)
        : event.detail;
      lane.modelNote = `Waiting for a model · ${reason}`;
    } else {
      return;
    }
    this.emitBoard();
  }

  // ---- 后台批准卡（§11.3） ----

  /** @brief 实例要批准：补上角色与 task，在用户会话的信封上出卡。 */
  private onApprovalRequest(lane: Lane, request: InstanceApprovalRequest): void {
    const task = lane.task === null ? undefined : findTask(this.board, lane.task);
    const card: TeamApprovalRequest = { ...request, role: lane.role, task: lane.task, taskTitle: task?.title ?? null };
    this.approvals.set(request.requestId, { request: card, instance: lane.id });
    this.host.emitUser(this.userId, { type: 'mori.team_approval_request', ...card });
    this.emitBoard();
    this.emitState();
  }

  /** @brief 实例的批准请求结束。 */
  private onApprovalEnd(end: TeamApprovalEnd): void {
    if (!this.approvals.delete(end.requestId)) return;
    this.host.emitUser(this.userId, { type: 'mori.team_approval_end', ...end });
    this.emitBoard();
  }

  // ---- mori-team 的钩子（§8.3、§7.3、§7.1、§7.5、§5.5、§8.5） ----

  /** @brief 执行 TaskBoard 工具的一方（一个会话一个）。 */
  private executor(lane: Lane): BoardToolExecutor {
    return { run: (name, args, call) => runTool(this, lane, name, args, call) };
  }

  /** @brief 实例会话的钩子：它的 TaskBoard 工具（白名单里的）、工作卡、证据编号（task 实例）、交接后与强制运行的拒绝。 */
  private laneHooks(lane: Lane): TeamHooks {
    const kind = lane.kind === 'user' ? 'create' : lane.kind;
    const names = toolAllowlist(this.roleOf(lane.role), kind, lane.readOnly, this.args.baseTools, lane.team);
    const info: ToolSessionInfo = { kind, role: lane.role, roles: this.roles, merged: this.merged, team: lane.team };
    const hooks: TeamHooks = {
      tools: boardTools(names, info, this.executor(lane), true),
      card: (messages) => this.cardText(lane, messages),
      toolCall: (event) => this.guardCall(lane, event.toolName),
    };
    if (lane.kind === 'task') hooks.toolResult = (event) => this.tagToolResult(lane, event);
    return hooks;
  }

  /** @brief 用户会话的钩子：工作卡、§5.5 的工具限制、判断的开始、mori_team 段与本次运行的工具。 */
  private userHooks(): TeamHooks {
    return {
      tools: [],
      onApi: (api) => {
        this.userApi = api;
        const saved = this.args.restored ? savedTeamEntry(this.args.userSessionFile) : null;
        if (hasOtherRoles(this.roles) || (saved !== null && saved.mode !== 'off')) this.registerUserTools();
      },
      card: (messages) => this.cardText(this.user, messages),
      toolCall: (event) => this.guardCall(this.user, event.toolName),
      messageStart: (message) => this.userMessageStart(message),
      beforeAgentStart: (event) => this.beforeUserRun(event),
    };
  }

  /** @brief 这个用户会话的 TaskBoard 上有过需求（关闭模式下保留两个只读工具、带关闭模式的工作卡，§5.2、§8.3）。 */
  boardUsed(): boolean {
    return this.board.requests.length > 0;
  }

  /** @brief 用户会话的 TaskBoard 工具名（§5.5、§6.3）：board_read、read_session、agent_message，合并会话加立项的工具。 */
  private userToolNames(): TeamToolName[] {
    const entries = dialogTools(this.args.roles, true, this.args.baseTools) ?? [];
    return TEAM_TOOLS.filter((name) => entries.includes(name) || name === 'agent_message');
  }

  /** @brief 注册用户会话的 TaskBoard 工具（defaultActive: false，§6.3、§14.6 T-T6）；之后不再增删。 */
  registerUserTools(): void {
    if (this.userToolsRegistered || !this.userApi) return;
    this.userToolsRegistered = true;
    const info: ToolSessionInfo = { kind: 'dialog', role: this.holders.dialog, roles: this.roles,
      merged: this.merged, team: true };
    for (const tool of boardTools(this.userToolNames(), info, this.executor(this.user), false)) {
      this.userApi.registerTool(tool);
    }
  }

  /**
   * @brief 用户会话的一次运行开始前（§5.5、§8.5）：按这次运行的模式写 mori_team 段、启用对话的工具，
   *        记下 tool_call 的限制；关闭模式的运行记下启用的工具（进入协作模式时写进 mori.team）。
   */
  private beforeUserRun(event: BeforeAgentStartEvent): void {
    const mode = this.mode;
    const section = userSessionSection({ mode, holders: this.holders, roles: this.summaries });
    if (section === null) delete event.systemPromptOptions.sections[TEAM_SECTION];
    else event.systemPromptOptions.sections[TEAM_SECTION] = section;
    this.nextUserRun = { mode, allowed: this.applyDialogTools(mode) };
  }

  /**
   * @brief 按模式启用对话的工具（§5.2、§5.5）；返回 tool_call 要限制的条目（不限制时为 null）。dialogTools 给出条目时，
   *        这次运行的身份是主 Agent（关闭模式）或兼立项（合并会话）的，后面加上 memory（记忆规格 §7.6，与 agent_message
   *        一样由 Mori 给，不受角色 tools 限制）；分开时的对话没有它。没有条目、回到关闭模式恢复记下的那一组时也启用
   *        memory（没注册时不启用）；没有记下的那一组时不重设启用的工具。关闭模式下 TaskBoard 上有过需求时另外启用
   *        board_read、read_session（§5.2，M22：关掉 Task mode 后还能回看任务的结果）。
   */
  private applyDialogTools(mode: TeamMode): string[] | null {
    const api = this.userApi;
    if (!api) return null;
    const readers = mode === 'off' && this.boardUsed() ? OFF_READERS : [];
    if (mode !== 'off' || readers.length > 0) this.registerUserTools();
    const listed = dialogTools(this.args.roles, mode !== 'off', this.args.baseTools);
    const registered = api.getAllTools().map((tool) => tool.name);
    if (listed !== null) {
      const entries = mode === 'off' || this.merged ? [...listed, MEMORY_TOOL, ...readers] : listed;
      api.setActiveTools(registered.filter((name) => matchesToolEntries(entries, name)));
      return entries;
    }
    const active = api.getActiveTools();
    const restoring = this.offRestore;
    const wanted = new Set(restoring === null ? active
      : [...restoring, ...active.filter((name) => !this.wasTeamActive(name))]);
    this.offRestore = null;
    if (hasOtherRoles(this.roles)) wanted.add('agent_message');
    for (const name of readers) wanted.add(name);
    // 恢复记下的那一组时 memory 也在关闭模式那一组里（记忆规格 §7.6）：记下的 tools 早于记忆功能时不含它
    if (restoring !== null) wanted.add(MEMORY_TOOL);
    const next = [...wanted].filter((name) => registered.includes(name));
    if (next.length !== active.length || next.some((name) => !active.includes(name))) api.setActiveTools(next);
    this.lastOffTools = api.getActiveTools();
    return null;
  }

  /** @brief 这个工具是协作模式下对话的那一组里的（回到关闭模式时按最后一条 mori.team 的 tools 恢复，不保留它们）。 */
  private wasTeamActive(name: string): boolean {
    const entries = dialogTools(this.args.roles, true, this.args.baseTools) ?? [];
    return matchesToolEntries(entries, name);
  }

  /**
   * @brief 用户会话 role 为 user 的消息开始（程序投递的消息不算，§5.3）：分开时上一段结束、认出交给对话的那条；
   *        合并会话里开始新的一次判断，判断的是你输入的原文（pi 展开了提示词模板、技能命令时也是，§5.3、§5.4）；
   *        扩展命令用 sendUserMessage 发的消息不是你交给对话的任何一条，没有立项的决定（§5.3）。
   */
  private userMessageStart(message: unknown): void {
    if ((message as { role?: string }).role !== 'user') return;
    const text = messageText(message as never);
    const wake = this.expectWake?.text === text;
    if (!this.merged) {
      if (wake) this.flow.segmentEnd();
      else this.flow.messageStart(message);
      return;
    }
    const run = this.user.run;
    if (!run || run.mode === 'off' || wake) return;
    const typed = this.flow.takeMerged(text);
    if (typed === null && run.command !== null) return;
    startUserJudgment(this, this.user, typed ?? text);
  }

  /** @brief 这次请求的工作卡（§8.3）；没有卡片时为 null。 */
  cardText(lane: Lane, messages: readonly unknown[]): string | null {
    const base = { board: this.board, holders: this.holders };
    let card: ReturnType<typeof workCard> = null;
    switch (lane.kind) {
      case 'task': card = workCard('task', { ...base, task: lane.task ?? '', role: lane.role }); break;
      case 'close': card = workCard('close', { ...base, request: lane.request ?? 0, role: lane.role }); break;
      case 'create': card = workCard('create', { ...base, mode: lane.run?.mode ?? this.mode }); break;
      case 'ask':
      case 'subscription':
        card = lane.team ? workCard(lane.kind, { ...base, request: lane.request }) : null;
        break;
      case 'user': card = this.userCard(messages); break;
    }
    if (card?.overLimit) console.error(`[kernel] ${lane.id}: the work card is over its limit (${card.text.length})`);
    return card?.text ?? null;
  }

  /**
   * @brief 用户会话的工作卡（§8.3）：关闭模式下 TaskBoard 上有过需求时为关闭模式的卡片（没有需求时没有，与 v0 相同）；
   *        合并会话为立项的各行加 Task mode；分开时为对话卡。
   */
  private userCard(messages: readonly unknown[]): ReturnType<typeof workCard> {
    const mode = this.user.run?.mode ?? this.mode;
    if (mode === 'off') return workCard('off', { board: this.board, holders: this.holders });
    const base = { board: this.board, holders: this.holders, mode };
    if (this.merged) return workCard('merged', base);
    const command = this.user.run?.command ?? null;
    const decision = this.flow.decisionFor(messages) ?? (command === null ? null : { kind: 'command', command });
    return workCard('dialog', { ...base, decision });
  }

  /** @brief task 实例的工具结果加证据编号（§7.3，返回时保留 details 与 structuredContent，§14.6 T-T4）。 */
  private tagToolResult(lane: Lane, event: ToolResultEvent): ToolResultEventResult | undefined {
    if (event.parentToolCallId !== undefined) return undefined;
    lane.tagNext ??= nextTag(this.branchOf(lane));
    const n = lane.tagNext;
    lane.tagNext += 1;
    return { content: tagResult(event.content, n), details: event.details, structuredContent: event.structuredContent };
  }

  /** @brief tool_call 的拒绝（在批准之前，§14.3）：交接之后、强制填写的运行（§7.1、§7.5），对话的工具限制（§5.5）。 */
  private guardCall(lane: Lane, toolName: string): ToolCallEventResult | undefined {
    const run = lane.run;
    if (!run) return undefined;
    if (lane === this.user) {
      if (run.allowed === null || matchesToolEntries(run.allowed, toolName)) return undefined;
      const reason = run.mode !== 'off' ? RELAY_ONLY : `${toolName} is not one of ${lane.role}'s tools.`;
      return { block: true, reason };
    }
    return guardToolCall({ handedOff: run.handedOff, forcedTool: run.forced?.form.tool ?? null }, toolName);
  }

  /** @brief 强制填写的运行的第一个请求按这次实际用的模型的写入等级改写（§7.5 第 2 步、§12.7）。 */
  private shapeAttempt(lane: Lane, attempt: ShapeAttempt): RequestShape | null {
    const run = lane.run;
    if (!run?.forced || run.assistants > 0) return null;
    const profile = this.host.entry(lane.id)?.model.layer.profileOf(attempt.ref) ?? null;
    const shape = formShape(run.forced.form, profile?.tier ?? null, profile?.reasoning.can_disable ?? 'unknown',
      attempt.api);
    run.formMode = shape?.mode ?? null;
    return shape;
  }

  /** @brief 这次强制填写预计的写法：按实例此刻的模型（投递文字里写明怎么填）；没有等级时为 null（不强制填写）。 */
  expectedMode(lane: Lane): WriteMode | null {
    const model = this.host.entry(lane.id)?.model;
    const ref = model?.state().current ?? null;
    const profile = ref === null ? null : model?.layer.profileOf(ref) ?? null;
    return writeModeOf(profile?.tier ?? null, profile?.reasoning.can_disable ?? 'unknown');
  }

  /** @brief 一个模型的族（§12.9）。 */
  familyOf(ref: string): string | null {
    return this.userSession?.model.layer.familyOf(ref) ?? null;
  }

  /** @brief 一个会话的工具标题上下文（证据、read_session、当前在做什么，§13.8）。 */
  titleContext(lane: Lane): TitleContext {
    return { cwd: this.args.cwd, seatRoles: seatRolesOf({ mode: this.mode, holders: this.holders }),
      task: lane.task };
  }

  // ---- 模式（§5.1、§5.5、§12.11） ----

  /** @brief 回到 off 的条件（§5.1）：没有未关闭的需求、待判断队列为空、立项没有在判断的消息。 */
  canReturnOff(): boolean {
    const judging = [...this.lanes.values()].some((lane) => lane.run?.judgment?.user === true);
    return !this.board.requests.some((request) => request.status === 'open') && this.deciding.length === 0
      && !judging;
  }

  /**
   * @brief 改协作模式（§5.1）：写 mori.team（进入协作模式时带上之前启用的工具，§5.5）并同时发 mori.team_mode（对话流里
   *        一行提示，§13.11），第一次进入时注册对话的 TaskBoard 工具，对话空闲时改模型层的锁定（正在运行的回合按它开始时
   *        的模式跑完，结束后再改）。
   * @param mode 新的模式
   */
  async changeMode(mode: TeamMode): Promise<void> {
    if (mode === this.mode) return;
    const previous = this.mode;
    this.mode = mode;
    if (mode !== 'off') this.registerUserTools();
    const tools = previous === 'off'
      ? this.offRestore ?? this.lastOffTools ?? this.userApi?.getActiveTools() : undefined;
    // 写进 mori.team 的这一组就是回到 off 时要恢复的：回到 off 之后还没有过关闭模式的运行时仍是上一条的那一组
    // （offRestore；重新打开之后此刻启用的可能是协作模式的那一组）；从来没有时取此刻启用的工具（§5.5）
    if (tools) this.lastOffTools = [...tools];
    if (mode === 'off') this.offRestore = this.offRestore ?? this.lastOffTools;
    // 对话流里的模式提示与条目同一时刻（§5.1、§13.11）
    this.writeUserEntry(TEAM_ENTRY_TYPES.team, tools ? { mode, tools } : { mode }, { type: 'mori.team_mode', mode });
    const status = this.host.status(this.userId);
    if (status?.running || status?.preparing) this.pendingLock = true;
    else await this.applyLock();
    this.emitState();
  }

  /** @brief 按此刻的模式改对话会话的模型层锁定与候选来源（§12.1、§12.11）。 */
  async applyLock(): Promise<void> {
    this.pendingLock = false;
    await this.userSession?.model.setTeamLock(this.mode !== 'off', this.dialogSource(this.mode !== 'off'));
    const open = [...this.lanes.values()].filter((lane) => lane !== this.user && lane.open);
    await Promise.all(open.map((lane) => this.refreshSource(lane)));
  }

  // ---- 停止（§9.4、§11.4） ----

  /**
   * @brief 停止一个会话的运行：先记下原因（§9.4 第 0 行），再经会话表停止（准备中时取消准备）。
   * @param lane 会话
   * @param reason 停止的原因
   */
  async stopLane(lane: Lane, reason: StopReason): Promise<void> {
    if (!lane.busy && lane.run === null && lane !== this.user) return;
    lane.stop = reason;
    try {
      await this.host.abort(lane.id, reason);
    } catch (error) {
      console.error(`[kernel] cannot stop ${lane.id}: ${(error as Error).message}`);
    }
  }

  /**
   * @brief 停止全部 Agent（Stop agents，§11.4）：清空全部会话的投递队列（记日志；等回复的以 Stopped by the user. 结束，
   *        丢弃的 ask_user、relay 把 asked 改回假），运行中与排队中的 task、结案在处理或排队的 task 变为 stopped，
   *        停止每个在运行或准备中的会话（原因 user；挂起的批准由会话表按拒绝处理）。
   */
  async stopAllAgents(): Promise<void> {
    const closeBusy = [...this.lanes.values()].filter((lane) => lane.kind === 'close' && laneActive(lane))
      .map((lane) => lane.request ?? 0);
    for (const lane of this.lanes.values()) this.dropQueue(lane);
    this.waitingSubs = [];
    const targets = teamStopTargets(this.board, closeBusy);
    if (targets.length) this.write((board) => ({ board: markStopped(board, targets, 'user'), error: null }));
    const status = this.host.status(this.userId);
    const busy = [...this.lanes.values()].filter((lane) => lane === this.user
      ? Boolean(status?.running || status?.preparing) || lane.busy : lane.busy || lane.run !== null);
    await Promise.all(busy.map((lane) => this.stopLane(lane, 'user')));
    // 停止时正在处理运行结束的会话（§9.4）处理完之后不再留下投递：再清一次。
    await Promise.all([...this.lanes.values()].map((lane) => lane.settling));
    for (const lane of this.lanes.values()) this.dropQueue(lane);
    this.emitBoard();
    this.emitState();
  }

  /**
   * @brief 停止一个 task（Stop this task，§13.13.7）：Stop agents 只作用于这个 task。清空它的实例会话的投递队列（等回复的
   *        以 Stopped by the user. 结束），task 变为 stopped（stopReason user，持有者保留，写入锁照旧持有），停止这个实例的
   *        运行（原因 user；挂起的批准由会话表按拒绝处理）。别的会话照常；不写回执、不投递、模式不变。
   * @param id task 编号
   * @return 停下之后兑现；不能停时抛出 T1 isn't running.，没有这个 task 时抛出 T1 does not exist.
   */
  async stopTask(id: string): Promise<void> {
    const task = findTask(this.board, id);
    if (!task) throw new Error(`${id} does not exist.`);
    const view = this.view().requests.flatMap((request) => request.tasks).find((item) => item.id === id);
    if (!view || !canStopTask(view) || task.holder?.kind !== 'role') throw new Error(`${id} isn't running.`);
    const lane = this.lanes.get(LANE_IDS.task(this.userId, id, task.holder.role).key) ?? null;
    if (lane) this.dropQueue(lane, `Stop task ${id}`);
    this.write((board) => ({ board: markStopped(board, [id], 'user'), error: null }));
    console.log(`[kernel] ${this.userId}: stopped ${id} (${task.holder.role})`);
    if (lane) {
      await this.stopLane(lane, 'user');
      // 停止时正在处理运行结束（§9.4）：处理完之后不再留下投递
      await lane.settling;
      this.dropQueue(lane, `Stop task ${id}`);
    }
    this.emitBoard();
    this.emitState();
  }

  /**
   * @brief 丢弃一个会话的投递队列（Stop agents、Stop this task，§8.2、§11.4、§13.13.7）。
   * @param lane 会话
   * @param by 日志里写的来由
   */
  private dropQueue(lane: Lane, by = 'Stop team'): void {
    const dropped = [...lane.solo, ...lane.queue];
    lane.solo = [];
    lane.queue = [];
    for (const item of dropped) {
      console.log(`[kernel] ${lane.id}: ${by} dropped a delivery (${item.cause.kind})`);
      item.meta.waiter?.settle(STOPPED_BY_USER, true);
      const asked = item.meta.asked;
      if (asked) this.write((board) => ({ board: markAsked(board, asked, false), error: null }));
    }
  }
}

/** @brief TaskView.current 里 command 保留的字符数（§13.10）。 */
const BRIEF_COMMAND_MAX = 200;

/**
 * @brief 一次工具调用的简要（TaskView.current，§13.10）：只带标题要用的参数（§13.8，含 read 的 offset、limit），
 *        command 截到前 200 字符（不只第一行，toolCallTitle 才能给多行命令加 …）。
 */
export function toolBrief(toolName: string, args: unknown): ToolCallBrief {
  const raw = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const brief: ToolCallBrief['args'] = {};
  for (const key of ['path', 'pattern', 'task', 'role', 'to'] as const) {
    if (typeof raw[key] === 'string') brief[key] = raw[key] as string;
  }
  for (const key of ['offset', 'limit', 'request'] as const) {
    if (typeof raw[key] === 'number') brief[key] = raw[key] as number;
  }
  if (typeof raw.command === 'string') brief.command = raw.command.slice(0, BRIEF_COMMAND_MAX);
  return { toolName, args: brief };
}

/**
 * @brief 建一个用户会话的协作（角色文件合格时，在建用户会话的资源加载器之前）。
 * @param host 会话表提供的操作
 * @param args 用户会话、角色、目录与共用的信任和批准状态
 */
export function createTeam(host: TeamHost, args: TeamArgs): TeamLike {
  return new Team(host, args);
}
