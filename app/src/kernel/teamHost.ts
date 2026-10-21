// 协作（team.ts）与会话表（sessions.ts、instances.ts）之间的接口（平行 Agent 规格 §2、§8.2、§14）：
// 会话表替 Team 建、开、关实例的 pi 会话，投递程序的消息，开始对话的回复；Team 接手协作模式下的用户消息与用户会话的事件。
// 这里只有类型。

import type { AgentSession, AgentSessionEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ModelEvent } from '../shared/models';
import type { ApprovalDecision, KernelEvent, QuoteRef, SessionInfo } from '../shared/protocol';
import type {
  InstanceEntryData, InstanceKind, PromptBehavior, TeamApprovalEnd, TeamApprovalRequest, TeamState, TeamSwitch,
} from '../shared/team';
import type { ApprovalPolicy } from './approval';
import type { ModelSession, ModelSessionOptions } from './modelSession';
import type { RoleLoad } from './roles';
import type { TrustDecision } from './trust';

/** @brief 停止一次运行的原因（§9.4 第 0 行）：你按了 Stop team、你停止了对话的回复、撤销需求。 */
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
  /** pi 的工具白名单（roles.ts toolAllowlist 的结果） */
  tools: string[];
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
  /** @brief 实例会话的 pi 事件（不发给界面，§8.1）。 */
  onEvent(event: AgentSessionEvent): void;
  /** @brief 实例会话的模型层事件（不发给界面，§8.2；Team 用它写 TaskView.modelNote，§12.12）。 */
  onModelEvent(event: ModelEvent): void;
  /**
   * @brief 实例的工具要批准（§11.3）：实例的批准扩展不在实例的信封上发 mori.approval_request，改为调用它；
   *        requestId 为 `<实例 id>:approval-<n>`，Team 补上角色与 task，在用户会话的信封上发 mori.team_approval_request。
   */
  onApprovalRequest(request: InstanceApprovalRequest): void;
  /** @brief 实例的批准请求结束（允许、拒绝、全部允许、停止、关闭）：Team 发 mori.team_approval_end。 */
  onApprovalEnd(end: TeamApprovalEnd): void;
  /** 所属的用户会话 id */
  owner: string;
}

/** @brief 实例的批准扩展交给 Team 的一次批准请求（TeamApprovalRequest 去掉 Team 补上的角色与 task）。 */
export type InstanceApprovalRequest = Omit<TeamApprovalRequest, 'role' | 'task' | 'taskTitle'>;

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
  /** 基座的默认工具（pi 默认启用的工具名），toolAllowlist 的 baseDefaults */
  baseTools: readonly string[];
  /** 用户会话的信任结果（实例沿用） */
  trust: TrustDecision;
  /** 用户会话的批准状态（实例共用） */
  approval: ApprovalPolicy;
  /** 打开已保存的用户会话（读 board.json、mori.team，做重启恢复） */
  restored: boolean;
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
  /** @brief 用户会话的 `mori-team` 扩展（在建用户会话的资源加载器时取）。 */
  userExtension(): ExtensionFactory;
  /** @brief 用户会话的 pi 会话建好、扩展绑定之后：读 mori.team，恢复（§11.6），设对话的工具（§5.5）。 */
  attachUser(user: UserAttach): Promise<void>;
  /** @brief 这条消息是否交给 Team：模式不是 off，或带 team: 'once'（§5.1）；以 `/` 开头的扩展命令不交（§5.3）。 */
  takesPrompt(text: string, team: 'once' | undefined): boolean;
  /** @brief 协作模式下的一条用户消息（§5.3）：排进待判断队列，判断完经 host.dialogStart / dialogQueue 交给对话。 */
  onUserPrompt(item: HeldItem, behavior: PromptBehavior | undefined, team: 'once' | undefined): void;
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
  /** @brief 侧栏的状态（LiveStatus 的 teamBusy、teamApproval）。 */
  live(): { teamBusy: boolean; teamApproval: boolean };
  /**
   * @brief 用户会话这次请求的工作卡的 token 估算（字符数 ÷ 4）：会话表把它作为用户会话 ModelSession 的
   *        extraContextTokens，接手判断与窗口估算算进去（§8.3 最后一条、§12.6）；没有卡片时为 0。
   */
  cardTokens(): number;
  /** @brief 有任何 Agent 在运行或排队、或有待判断的消息（拒绝关闭、归档、删除，§11.5）。 */
  busy(): boolean;
  /** @brief 关闭用户会话前：关闭全部实例会话，释放内存（board.json 留着）。 */
  close(): Promise<void>;
}
