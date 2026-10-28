// 协作（team.ts）与会话表（sessions.ts、instances.ts）之间的接口（平行 Agent 规格 §2、§8.2、§14）：
// 会话表替 Team 建、开、关实例的 pi 会话，投递程序的消息，开始对话的回复；Team 接手协作模式下的用户消息与用户会话的事件。
// 这里是类型，加上两边共用的 memory 工具名（会话表注册它，Team 把它追加到启用的工具与白名单，docs/specs/memory.md §7.6）。

import type { AgentSession, AgentSessionEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ModelEvent } from '../shared/models';
import type { ApprovalDecision, KernelEvent, QuoteRef, SessionInfo } from '../shared/protocol';
import type {
  InstanceEntryData, InstanceKind, PromptBehavior, SessionOf, TaskDetail, TeamApprovalEnd, TeamApprovalRequest,
  TeamMode, TeamState, TeamSwitch,
} from '../shared/team';
import type { AskAnswer, AskQuestion, AwayDecision, RunAgent } from '../shared/workspace';
import type { ApprovalPolicy } from './approval';
import type { Narrowing } from './limits';
import type { EnhanceSessionSpec, MemorySessionSpec } from './memoryExtension';
import type { ModelSession, ModelSessionOptions } from './modelSession';
import type { RoleLoad } from './roles';
import type { TrustDecision } from './trust';

/** @brief memory 工具的名字（记忆规格 §7.1）：mori-memory 注册它，批准扩展免批准（§7.5），Team 按 §7.6 追加它。 */
export const MEMORY_TOOL = 'memory';

/** @brief 停止一次运行的原因（§9.4 第 0 行）：你按了 Stop agents、你停止了对话的回复、撤销需求。 */
export type StopReason = 'user' | 'dialog' | 'cancel';

/** @brief 一条用户消息（或程序投递到用户会话的消息）和它的引用芯片。 */
export interface HeldItem {
  /** 全文 */
  text: string;
  /** 引用芯片；没有时省略 */
  refs?: QuoteRef[];
}

/** @brief 段开始时选模型的偏好（§12.4、§12.6、§12.9）：首选的候选、排除的候选（`provider/model`）。 */
export interface SegmentPreference {
  /** 优先的候选 */
  prefer?: string;
  /** 排除的候选 */
  exclude?: string[];
}

/** @brief 建或开一个实例会话要用的全部设置（§8.1、§8.2）。 */
export interface InstanceSpec {
  /** pi 会话 id（§3 的写法，例如 `<用户会话 id>.t3.executor`） */
  id: string;
  /** 实例会话文件所在的目录：`<userData>/teams/<用户会话 id>/sessions` */
  dir: string;
  /** 用户会话的文件（写进头部的 parentSession）；用户会话还没写盘时也是它将来的路径 */
  parentSession: string | null;
  /** 工作目录（与用户会话相同） */
  cwd: string;
  /** 实例的种类 */
  kind: InstanceKind;
  /**
   * 会话的第一条条目 mori.instance（§3、§8.1）：createInstance 在 pi 建会话之前写下它（之后 pi 与模型层会写
   * model_change、mori.pick 等条目，所以 Team 不另写）；openInstance 不写
   */
  instance: InstanceEntryData;
  /** pi 的工具白名单（roles.ts instanceTools 的结果，按记忆规格 §7.6 另加 memory） */
  tools: string[];
  /**
   * 这个实例受的收窄（Team.narrowingFor(lane)，file-system-permissions.md §8.5）：instanceSetup 包成
   * GateOutput.narrowing 放进批准扩展，路径闸第 2 步越界的调用直接拒绝；没有限制时为 null
   */
  narrowing: Narrowing | null;
  /** 加在 system prompt 末尾的段（附录 A，按顺序）与角色正文 */
  appendPrompt: string[];
  /** 这个实例的 `mori-team` 扩展（工具、钩子） */
  teamExtension: ExtensionFactory;
  /** 模型层的选项（候选来源、调度类别、种类、强制填写的改写、候选耗尽的回调等） */
  model: Partial<Pick<ModelSessionOptions, 'source' | 'schedClass' | 'kind' | 'restartText' | 'extraContextTokens'
    | 'shape' | 'onUnavailable'>>;
  /** 用户会话的信任结果：实例不再询问（§8.2） */
  trust: TrustDecision;
  /** 用户会话的批准状态（§11.1） */
  approval: ApprovalPolicy;
  /**
   * 记忆设置（记忆规格 §7.6、§9.6；收尾检查规格 §4.2）：增强会话的 Team 把这次运行交给它的实例；实例都没有收尾检查，
   * 普通会话的实例为 { enhance: null, check: null }
   */
  memory: MemorySessionSpec;
  /** @brief 实例会话的 pi 事件（不发给界面，§8.1）。 */
  onEvent(event: AgentSessionEvent): void;
  /** @brief 实例会话的模型层事件（不发给界面，§8.2；Team 用它写 TaskView.modelNote，§12.12）。 */
  onModelEvent(event: ModelEvent): void;
  /**
   * @brief 实例的工具要批准（§11.3）：实例的批准扩展不在实例的信封上发 mori.approval_request，改为调用它；
   *        requestId 为 `<实例 id>:approval-<n>`，Team 补上角色与 task，在用户会话的信封上发 mori.team_approval_request。
   */
  onApprovalRequest(request: InstanceApprovalRequest): void;
  /**
   * @brief 实例的批准请求结束（允许、拒绝、按工具名或目录放行、Full access、停止、关闭、你不在时到时拒绝）：
   *        Team 发 mori.team_approval_end；到时拒绝（by 为 away）时另在用户会话里写 mori.away_decision
   *        （docs/specs/file-system-permissions.md §9.7）。
   */
  onApprovalEnd(end: TeamApprovalEnd): void;
  /**
   * @brief 这次运行已经成功交接（读 LaneRun.handedOff，file-system-permissions.md §9.2、§9.8）：instanceSetup 放进
   *        批准扩展的 GateOutput.handedOff，为真时 agent_before_settle 不补“你不在”的提醒。
   */
  handedOff(): boolean;
  /**
   * @brief mori-snapshots 给这个实例的运行标出的 Agent（docs/specs/file-system.md §4.5 ActiveRun.agent）：
   *        Team 填实例的角色与 task（不是 task 实例时 task 为 null），self 为假；instanceSetup 放进 SessionSetup.runAgent。
   */
  runAgent(): RunAgent;
  /** 所属的用户会话 id */
  owner: string;
}

/** @brief 实例的批准扩展交给 Team 的一次批准请求（TeamApprovalRequest 去掉 Team 补上的角色、task 与 subagent）。 */
export type InstanceApprovalRequest = Omit<TeamApprovalRequest, 'role' | 'task' | 'taskTitle' | 'subagent'>;

/** @brief 打开着的会话里 Team 读得到的部分。 */
export interface HostEntry {
  /** pi 会话 */
  session: AgentSession;
  /** 模型层的会话接线 */
  model: ModelSession;
  /** 工作目录 */
  cwd: string;
  /** 会话文件；pi 还没写盘时也是它将来的路径 */
  sessionFile: string | null;
}

/** @brief 会话表为 Team 提供的操作（sessions.ts、instances.ts 实现）。 */
export interface TeamHost {
  /**
   * @brief 新建实例会话：`SessionManager.create(cwd, dir, { id, parentSession })`，按 spec 建 pi 会话并开始转发事件。
   * @return 实例的 pi 会话 id（等于 spec.id）
   */
  createInstance(spec: InstanceSpec): Promise<string>;
  /**
   * @brief 从会话文件重新打开实例会话（继续已有实例、重启后交回，§8.2、§11.6）；已经开着时直接返回它的 id。
   * @param file 实例会话文件
   */
  openInstance(file: string, spec: InstanceSpec): Promise<string>;
  /** @brief 关闭一个空闲的实例会话，释放 pi 会话与虚拟模型（§8.2）。 */
  closeInstance(sessionId: string): Promise<void>;
  /**
   * @brief 程序的投递（§8.2、§14.2）：准备中 → 模型层 prepare（带偏好）→ `prompt(text, { expandPromptTemplates: false })`。
   *        调用方保证会话空闲；准备中选不到模型时经模型层的 onUnavailable 回到 Team。
   * @param sessionId 实例或用户会话
   * @param text 投递的文字
   * @param choice 段开始时选模型的偏好
   * @return 这次投递结束时兑现（运行结束；或准备中就结束：选不到模型、被停止、被拒绝启动、prompt() 抛错），从不拒绝；
   *         开始了运行时在它的 agent_settled 之后兑现（prompt() 本来就在它之后兑现，§14.6 T-S5）。
   *         Team 据此在“准备中没有开始运行就结束”时开始投递队列里的下一次（§5.6、§8.2）。用户会话的准备中在调用时就开始
   *         （status().preparing 立即为真）
   */
  deliver(sessionId: string, text: string, choice?: SegmentPreference): Promise<void>;
  /**
   * @brief 开始对话的一次回复（与关闭模式的发送相同）；before（分开时立项的判断）在准备中、模型层 prepare 之前执行，
   *        停止（session.abort）中止它并撤回消息。before 抛错时按准备中出错撤回。
   * @param userSessionId 用户会话
   * @param item 这条消息
   * @param before 准备中先做的事；省略时直接准备
   * @return 这次回复结束时兑现（运行结束，或准备中就结束），从不拒绝（同 deliver）
   */
  dialogStart(userSessionId: string, item: HeldItem, before?: (signal: AbortSignal) => Promise<void>): Promise<void>;
  /** @brief 对话生成中交给 pi（排队或插话，与关闭模式相同）。 */
  dialogQueue(userSessionId: string, item: HeldItem, behavior: PromptBehavior): void;
  /** @brief 停止一个会话的运行（实例或对话），先记下原因；准备中时取消准备。 */
  abort(sessionId: string, reason: StopReason): Promise<void>;
  /**
   * @brief 你在后台批准卡上的选择（§11.3）：交给 requestId 所属实例的批准扩展（共用的批准状态照 §11.1 生效）。
   * @param sessionId 实例的 pi 会话 id
   * @return 请求还挂着并已处理时为 true；已经结束时为 false
   */
  answerApproval(sessionId: string, requestId: string, decision: ApprovalDecision, reason?: string): boolean;
  /**
   * @brief 会话是否在运行、在准备中，以及最近一次停止的原因（abort 记下，下一次运行开始时清掉；§9.4 在 agent_settled 时看它）；
   *        会话不在时为 null。
   */
  status(sessionId: string): { running: boolean; preparing: boolean; stop: StopReason | null } | null;
  /** @brief 打开着的会话；不在时为 null。 */
  entry(sessionId: string): HostEntry | null;
  /** @brief 在用户会话的信封上发一个事件。 */
  emitUser(userSessionId: string, event: KernelEvent): void;
}

/** @brief 建 Team 的参数（用户会话打开时，角色文件合格）。 */
export interface TeamArgs {
  /** 用户会话 id */
  userSessionId: string;
  /** 用户会话的文件 */
  userSessionFile: string | null;
  /** 工作目录 */
  cwd: string;
  /** 角色（roles.ts loadRoles 的结果，没有问题） */
  roles: RoleLoad;
  /** `<userData>/teams/<用户会话 id>` */
  teamDir: string;
  /** pi 设置的默认工具（没设时 read、bash、edit、write），instanceTools 的 baseDefaults（file-system-permissions.md §8.6） */
  baseTools: readonly string[];
  /**
   * @brief 此刻装了程序的搜索工具（defaultTools.ts installedSearchTools：grep 要 rg.exe，find 要 fd.exe），只读会话的实例
   *        每次建或打开时查一次（file-system-permissions.md §8.11）。
   */
  searchTools(): readonly string[];
  /** 用户会话的信任结果（实例沿用） */
  trust: TrustDecision;
  /** 用户会话的批准状态（实例共用） */
  approval: ApprovalPolicy;
  /** 打开已保存的用户会话（读 board.json、mori.team，做重启恢复） */
  restored: boolean;
  /** 增强会话的 Team：这次增强运行（记忆规格 §9.6，实例经 InstanceSpec.memory 继承）；普通会话为 null */
  enhance: EnhanceSessionSpec | null;
}

/** @brief 用户会话交给 Team 的部分（attachUser 的参数）。 */
export interface UserAttach {
  /** 用户会话 id */
  sessionId: string;
  /** 用户会话的 pi 会话 */
  session: AgentSession;
  /** 用户会话的模型层接线 */
  model: ModelSession;
}

/** @brief 一个用户会话的协作（team.ts 实现；会话表经它路由协作模式下的消息、事件与命令）。 */
export interface TeamLike {
  /** 此刻的协作模式；运行开始时（before_agent_start）就是这次运行的模式（记忆规格 §5.1 用它定用户会话的身份） */
  readonly mode: TeamMode;
  /** 对话与立项由同一个角色持有（合并会话） */
  readonly merged: boolean;
  /** @brief 用户会话的 `mori-team` 扩展（在建用户会话的资源加载器时取）。 */
  userExtension(): ExtensionFactory;
  /** @brief 用户会话的 pi 会话建好、扩展绑定之后：读 TaskBoard 与 mori.team，恢复（§11.6），协作模式下注册对话的 TaskBoard 工具。 */
  attachUser(user: UserAttach): Promise<void>;
  /** @brief 这条消息是否交给 Team：模式不是 off，或带 team: 'once'（§5.1）；以 `/` 开头的扩展命令不交（§5.3）。 */
  takesPrompt(text: string, team: 'once' | undefined): boolean;
  /** @brief 协作模式下的一条用户消息（§5.3）：排进待判断队列，判断完经 host.dialogStart / dialogQueue 交给对话。 */
  onUserPrompt(item: HeldItem, behavior: PromptBehavior | undefined, team: 'once' | undefined): void;
  /**
   * @brief 以 /task 发出、照 v0 交给对话的扩展命令（§5.1、§5.3）：关闭模式下先进入 once；会话表在它兑现后再交给对话。
   * @return 模式改好之后兑现，从不拒绝
   */
  enterOnce(): Promise<void>;
  /**
   * @brief 会话表开始、Team 不跟踪的一次对话回复结束（准备中就结束或运行结束，§5.6）：Team 开始投递队列里给用户会话的
   *        程序投递、改模型层的锁定。
   */
  replyEnded(): void;
  /** @brief 用户会话的每个 pi 事件（判断、回执、程序投递、进展摘要的位置）。 */
  onUserEvent(event: AgentSessionEvent): void;
  /** @brief session.setTeam（§5.1）。 */
  setMode(mode: TeamSwitch): Promise<TeamState>;
  /** @brief session.stopTeam（§11.4）：停止全部 Agent，返回回到输入框的待判断消息。 */
  stopTeam(): Promise<{ texts: string[] }>;
  /** @brief 你停止了对话的回复（Esc、停止按钮，§11.4）：停为它判断的立项，返回撤回的待判断消息。 */
  onDialogStop(): Promise<string[]>;
  /** @brief session.clearQueue（§5.3）：撤回还没开始判断的消息，返回它们的原文（按发送顺序）。 */
  withdrawDeciding(): string[];
  /**
   * @brief 你在后台批准卡上的选择（§11.3）。
   * @return 这是后台批准卡并已处理时为 true；不是时为 false（交给对话自己的批准扩展）
   */
  answerApproval(requestId: string, decision: ApprovalDecision, reason?: string): boolean;
  /** @brief SessionInfo 与快照的协作部分（§13.10）。 */
  info(): Pick<SessionInfo, 'team' | 'board' | 'teamApprovals' | 'deciding'>;
  /** @brief board.readTask（§13.13.3，只读）：task 的详情；没有这个 task 时抛错。 */
  readTask(task: string): TaskDetail;
  /** @brief board.readSession（§13.13.4，只读）：实例会话或结案会话的当前分支；task、需求或会话不存在时抛错。 */
  readSession(of: SessionOf): Promise<{ entries: unknown[]; running: boolean }>;
  /** @brief session.stopTask（§13.13.7）：停止一个 task；不能停或不存在时抛错。 */
  stopTask(task: string): Promise<void>;
  /** @brief 侧栏的状态（LiveStatus 的 teamBusy、teamApproval）。 */
  live(): { teamBusy: boolean; teamApproval: boolean };
  /**
   * @brief 用户会话这次请求的工作卡的 token 估算（字符数 ÷ 4）：会话表把它作为用户会话 ModelSession 的
   *        extraContextTokens，接手判断与窗口估算算进去（§8.3 最后一条、§12.6）；没有卡片时为 0。
   */
  cardTokens(): number;
  /**
   * @brief 有任何 Agent 在运行或排队、或有待判断的消息（拒绝关闭、归档、删除，§11.5；Rewind 与 Undo 的“不能用”，
   *        docs/specs/file-system.md §5.5 的 TeamState.busy）。
   */
  busy(): boolean;
  /**
   * @brief 用户会话自己的运行在 mori-snapshots 里标出的 Agent（docs/specs/file-system.md §4.5）：此刻持有对话的角色
   *        （基座为 BASE_ROLE mori，界面显示 Mori），self 为真，task 为 null。startUser 的 SessionSetup.runAgent 用它。
   */
  holderAgent(): RunAgent;
  /**
   * @brief TaskBoard 上状态为 open 的需求编号（BoardView.requests，按编号）：Rewind 恢复对话的协作模式限制
   *        （docs/specs/file-system.md §5.5，RewindSession.openRequests）。
   */
  openRequests(): number[];
  /**
   * @brief 用户会话的提问卡以你提交或你不在时按推荐项结束（AskSetup.onAnswered，file-system-permissions.md §10.7）：
   *        发起这次调用的那次运行的模式不是 off、也不是合并会话时，把“问题 + 你的答复”当成你的一条消息排进立项会话的
   *        投递队列（UserFlow.forwardAnswer），不进待判断队列；其余情况不做。
   * @param questions 这次调用的问题，按参数的顺序
   * @param answers 每个问题的答案，与 questions 一一对应
   */
  onAskAnswered(questions: AskQuestion[], answers: AskAnswer[]): void;
  /**
   * @brief 用户会话自己的请求你不在时被自动处理（sessions.ts 的 recordAwayDecision，file-system-permissions.md §9.7）：
   *        经 writeUserEntry 写 mori.away_decision 条目（对话正在输出时等这条助手消息结束再写）并在用户会话的信封上发
   *        同名事件。后台实例的批准由 Team 自己在 onApprovalEnd 里写，不经这里。
   * @param decision 自动处理记录
   */
  recordAway(decision: AwayDecision): void;
  /**
   * @brief 用户会话自己的调用受的收窄（= narrowingFor(user)，file-system-permissions.md §8.3、§8.5）：这次运行
   *        （LaneRun.mode，万一没有按此刻的模式）在协作模式下时为 { owner: 'dialog', limits: TEAM_DIALOG_LIMITS }，
   *        关闭模式下为 null。startUser 的 GateOutput.narrowing 每次调用时取它。
   */
  userNarrowing(): Narrowing | null;
  /** @brief 关闭用户会话前：关闭全部实例会话，释放内存（board.json 留着）。 */
  close(): Promise<void>;
}
