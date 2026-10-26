// 平行 Agent 与 TaskBoard 的进程桥协议（docs/specs/parallel-agents-taskboard.md §1、§3、§6、§8.1、§13、§15）：
// 角色与权限、协作模式、TaskBoard 的视图、事件、会话文件里的自定义条目，以及界面与后台进程共用的文字
// （回执、进展摘要、工具调用标题）和参数归一。board.json 本身的结构只在后台进程里（kernel/board.ts），界面只看到这里的视图。

import { z } from 'zod';
import type { ApprovalEndBy } from './protocol';

// ---- 角色与权限（§1、§4） ----

/** @brief 基座 Agent 的角色名（§1、§4.2）：没有角色文件，就是 v0 的 Agent。 */
export const BASE_ROLE = 'mori';

/** @brief 基座在界面上的名字（§1）。 */
export const BASE_ROLE_LABEL = 'Mori';

/**
 * @brief 基座在“Other roles”、next 与 assignee 说明里的一句话（§6.3、附录 A）：基座没有角色文件，也就没有 description，
 *        规格没给这句话，这是临时文字（docs/v1/defaults.md）。
 */
export const BASE_ROLE_DESCRIPTION = 'General-purpose agent with the default tools';

/** @brief 角色名的规则（§4.1、§15）。 */
export const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** @brief 像 task 或需求编号、不能用作角色名的写法（§4.1、§15）。 */
export const NUMBER_LIKE_PATTERN = /^(t|r)?[0-9]+$/;

/** @brief 三项权限（§1）：对话、立项、结案；每项恰好一个持有者。 */
export const SEATS = ['dialog', 'create', 'close'] as const;
export type Seat = (typeof SEATS)[number];

/** @brief 每项权限的持有者：角色名，没人认领的为基座 mori（§4.2）。 */
export type TeamHolders = Record<Seat, string>;

/** @brief 角色文件定义的一个角色，界面与工作卡用。 */
export interface RoleSummary {
  /** 角色名（frontmatter 的 name） */
  name: string;
  /** 一句话说明（frontmatter 的 description，≤ 200 字符） */
  description: string;
}

/** @brief 只有基座时三项权限的持有者（§4.2：没有角色文件时基座持有三项权限）。 */
export function baseHolders(): TeamHolders {
  return { dialog: BASE_ROLE, create: BASE_ROLE, close: BASE_ROLE };
}

/**
 * @brief 角色在界面上的名字：基座显示 Mori，其余是你写的角色名，原样显示（§0 语言、§1）。
 * @param role 角色名
 */
export function roleLabel(role: string): string {
  return role === BASE_ROLE ? BASE_ROLE_LABEL : role;
}

// ---- 协作模式（§5.1、§13.10） ----

/** @brief 协作模式（§1、§5.1）：关闭、这一次（做完为止）、一直打开。 */
export const TEAM_MODES = ['off', 'once', 'always'] as const;
export type TeamMode = (typeof TEAM_MODES)[number];

/** @brief session.setTeam 的取值：开关打开、/team on 为 on；开关关掉、/team off 为 off（§5.1）。 */
export const TEAM_SWITCH = ['on', 'off'] as const;
export type TeamSwitch = (typeof TEAM_SWITCH)[number];

/** @brief 一个用户会话的协作状态（§13.10）。 */
export interface TeamState {
  /** 协作模式 */
  mode: TeamMode;
  /** 三项权限的持有者 */
  holders: TeamHolders;
  /** 角色文件定义的角色（不含基座），按读出的顺序；没有角色文件时为空 */
  roles: RoleSummary[];
  /**
   * 这个用户会话里有任何 Agent 在运行或排队（对话、立项、结案、实例），或有待判断的消息；
   * 停止按钮、侧栏、归档与删除用它
   */
  busy: boolean;
  /**
   * 除对话这次运行之外还有 Agent 在运行或排队（立项、结案、实例，投递队列里等着的运行），或有待判断的消息；
   * 输入框旁的 Stop agents 按它显示（§11.4、§13.6）
   */
  background: boolean;
}

/**
 * @brief 没有角色文件、没用过协作模式的会话的协作状态：关闭模式、基座持有三项权限、没有角色、没有后台 Agent。
 * @param busy 对话 Agent 是否在运行或准备中（这时只有它一个 Agent）
 */
export function soloTeamState(busy: boolean): TeamState {
  return { mode: 'off', holders: baseHolders(), roles: [], busy, background: false };
}

/** @brief 你在发送时的选择（§5.3）：Enter 为 followUp（排队），Ctrl+Enter 为 steer（插话）。 */
export type PromptBehavior = 'steer' | 'followUp';

/** @brief “待判断”队列里的一条你的消息（§5.3、§13.10 deciding）。 */
export interface DecidingMessage {
  /** 你输入的原文 */
  text: string;
  /** 发送时的选择；空闲时直接发送（没带 behavior）为 null */
  behavior: PromptBehavior | null;
}

/** @brief 立项判断你的消息（mori.team_deciding 的载荷，SessionInfo 与快照的 deciding，§5.3、§13.6、§13.10）。 */
export interface TeamDeciding {
  /** 立项持有者的角色名 */
  role: string;
  /** 正在判断的那条开始判断的时刻（ms）；没有在判断时为 null */
  since: number | null;
  /** 待判断、还没交给对话的消息，按发送顺序（含正在判断的那条） */
  queue: DecidingMessage[];
}

/** @brief 没有待判断的消息时的 deciding（没有 Team 的会话；立项持有者为基座）。 */
export function noDeciding(): TeamDeciding {
  return { role: BASE_ROLE, since: null, queue: [] };
}

// ---- TaskBoard 的取值（§6.1） ----

/** @brief 需求的状态。 */
export const REQUEST_STATUSES = ['open', 'done', 'failed', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** @brief task 的状态；done、failed、cancelled 是终态，不能回到其他状态（§6.2）。 */
export const TASK_STATUSES = ['pending', 'active', 'waiting_user', 'stopped', 'done', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** @brief 交接的结果（§6.1 Outcome、§6.3）。 */
export const HANDOFF_OUTCOMES = [
  'continue', 'dead_end', 'blocked', 'need_user', 'done', 'pass', 'fail', 'close_done', 'close_failed',
] as const;
export type HandoffOutcome = (typeof HANDOFF_OUTCOMES)[number];

/** @brief 程序写的一棒的原因（§6.1 Handoff.reason、§7.4）。 */
export const HANDOFF_REASONS = ['no_handoff', 'error', 'no_model', 'dependency_failed', 'close_undecided'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** @brief 实例会话的种类（§8.1；对话会话就是用户会话，不是实例）。 */
export const INSTANCE_KINDS = ['create', 'close', 'task', 'ask', 'subscription'] as const;
export type InstanceKind = (typeof INSTANCE_KINDS)[number];

// ---- TaskBoard 的视图（§13.10） ----

/** @brief 进展摘要里 task 的一行在做什么（§13.3），由 TaskBoard 与调度算出。 */
export const TASK_PHASES = [
  'pending', 'queued', 'lock_wait', 'starting', 'running', 'approval', 'waiting_user', 'asked', 'with_close',
  'stopped', 'stopped_restart', 'done', 'failed', 'cancelled',
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

/** @brief 进展摘要的需求状态（§13.3，按这个顺序取第一个符合的；文字见 requestStateText）。 */
export const REQUEST_STATES = [
  'done', 'failed', 'cancelled', 'needs_decision', 'waiting_create', 'stopped', 'with_close', 'running',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** @brief 实例最近一次工具调用（§13.10 TaskView.current）：只带标题要用的参数。 */
export interface ToolCallBrief {
  /** 工具名 */
  toolName: string;
  /**
   * 标题要用的参数（§13.8）：v0 工具的 path、offset、limit、command、pattern，TaskBoard 工具的 task、request、role、to；
   * command 截到前 200 字符（标题取第一行，多行时加 …）
   */
  args: { path?: string; offset?: number; limit?: number; command?: string; pattern?: string; task?: string;
    request?: number; role?: string; to?: string };
}

/** @brief 交接链的一棒（§13.3 展开时）。 */
export interface HandoffLink {
  /** 交出这一棒的角色名；结案会话写的取结案持有者的角色名，程序写的为 mori */
  role: string;
  /** 交接的结果；程序写的一棒为 null */
  outcome: HandoffOutcome | null;
  /** 结论的第一句（≤ 80 字符）；程序写的一棒为 PROGRAM_HANDOFF_LINES 的文字 */
  line: string;
}

/** @brief 一个 task 的视图（§13.10）。 */
export interface TaskView {
  /** 编号，例如 T1 */
  id: string;
  /** 标题（立项写的） */
  title: string;
  /** 状态 */
  status: TaskStatus;
  /** 指派给谁（角色名） */
  assignee: string;
  /** 谁在做：持有者的角色名，交到结案时为结案持有者；pending 与终态为 null */
  holder: string | null;
  /** 在做什么 */
  phase: TaskPhase;
  /** pending 时未完成的依赖；lock_wait 时持有写入锁的 task；其余为空 */
  waitingFor: string[];
  /** running 时最近一次工具调用；其余为 null */
  current: ToolCallBrief | null;
  /** 最近一条换模型或等待的提示（§12.12），实例的下一次运行开始时清掉；没有时为 null */
  modelNote: string | null;
  /** 交接链，按先后 */
  chain: HandoffLink[];
}

/** @brief 一个需求的视图（§13.10）。 */
export interface RequestView {
  /** 需求编号 */
  no: number;
  /** 标题（立项写的一句话） */
  title: string;
  /** 状态 */
  status: RequestStatus;
  /** 进展摘要的需求状态（§13.3） */
  state: RequestState;
  /** 登记的时刻（ms） */
  createdAt: number;
  /** 关闭或撤销的时刻（ms）；还开着时为 null */
  closedAt: number | null;
  /** 结案写下的结论，撤销时为理由；没有时为 null */
  conclusion: string | null;
  /** 已排除的方案：以 failed 关闭的 task 的关闭结论，按关闭时间（§6.1） */
  ruledOut: string[];
  /** 需要决定的需求级问题（§7.6）；没有时为 null */
  question: string | null;
  /** 这个需求的全部 task，按编号 */
  tasks: TaskView[];
}

/** @brief 一个用户会话的 TaskBoard 视图（§13.10）。 */
export interface BoardView {
  /** 全部需求，按编号 */
  requests: RequestView[];
  /** 有实例做过成功的 edit、write（右栏写明它们不在“本会话的改动”里，§13.12） */
  teamEdited: boolean;
}

/** @brief 没有需求的 TaskBoard 视图（还没用过协作模式的会话）。 */
export function emptyBoard(): BoardView {
  return { requests: [], teamEdited: false };
}

// ---- Agent 用的工具（§6.3） ----

/** @brief TaskBoard 的 11 个工具，由内联扩展 mori-team 注册，免批准（§11.2）；顺序同 §6.3 的表。 */
export const TEAM_TOOLS = [
  'board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close',
] as const;
export type TeamToolName = (typeof TEAM_TOOLS)[number];

/** @brief 工具名是不是 TaskBoard 的工具。 */
export function isTeamTool(name: string): name is TeamToolName {
  return (TEAM_TOOLS as readonly string[]).includes(name);
}

/** @brief 文字长度上限（§15），单位为字符；openItems 为条数。 */
export const TEXT_LIMITS = Object.freeze({
  /** 需求标题 */
  requestTitle: 80,
  /** task 标题 */
  taskTitle: 80,
  /** 需求的目标 */
  goal: 600,
  /** 需求的验收 */
  acceptance: 600,
  /** task 要做什么 */
  taskDescription: 1200,
  /** 交接的结论 */
  handoffConclusion: 600,
  /** 交接的未结事项条数 */
  openItems: 10,
  /** 每条未结事项 */
  openItem: 200,
  /** agent_message 的 text */
  agentMessage: 4000,
  /** reply_via_dialog 的 note */
  note: 1200,
  /** request_close 的需求结论 */
  requestConclusion: 1200,
  /** 角色说明 */
  roleDescription: 200,
  /** 回执里原话的显示长度（§13.2） */
  receiptQuote: 120,
  /** 进展摘要交接链每棒（§13.3） */
  chainLine: 80,
});

// ---- 后台实例的批准（§11.3） ----

/** @brief 后台实例等你批准的一次工具调用（mori.team_approval_request），在用户会话的信封上。 */
export interface TeamApprovalRequest {
  /** <实例的 pi 会话 id>:<批准编号>；approval.answer 用它答复 */
  requestId: string;
  /** 实例的 pi 会话 id */
  instance: string;
  /** 实例的角色名 */
  role: string;
  /** 实例所在的 task；没有 task 的实例（临时提问、订阅、立项、结案）为 null */
  task: string | null;
  /** 那个 task 的标题；没有 task 时为 null */
  taskTitle: string | null;
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 完整的调用参数 */
  args: Record<string, unknown>;
}

/** @brief 后台实例的批准请求结束（mori.team_approval_end）。 */
export interface TeamApprovalEnd {
  /** 结束的请求 id（mori.team_approval_request） */
  requestId: string;
  /** 允许或拒绝 */
  decision: 'allow' | 'reject';
  /** 由谁结束 */
  by: ApprovalEndBy;
  /** 拒绝时回给模型的工具结果原文；允许时为 null */
  reason: string | null;
}

// ---- 会话文件里的自定义条目（§3），经 pi 的 appendCustomEntry 写 ----

/** @brief Mori 写进用户会话与实例会话的自定义条目的 customType。 */
export const TEAM_ENTRY_TYPES = Object.freeze({
  /** 用户会话：协作模式（§5.1），以最后一条为准 */
  team: 'mori.team',
  /** 用户会话：回执（§13.2） */
  receipt: 'mori.receipt',
  /** 用户会话：进展摘要的位置（§13.3） */
  progress: 'mori.progress',
  /** 用户会话：指向一条程序投递的消息（§5.6） */
  wake: 'mori.wake',
  /** 实例会话的第一条：种类与角色（§3、§8.1），供恢复使用 */
  instance: 'mori.instance',
  /** 分开时的立项会话：上一次投递带到了用户会话的哪个条目（§8.4） */
  createCursor: 'mori.create_cursor',
} as const);

/** @brief task 编号的写法：T 加从 1 起的整数。 */
export const TASK_ID_PATTERN = /^T[1-9][0-9]*$/;

/** @brief mori.team 条目：协作模式（§5.1、§5.5）。 */
export const TeamEntrySchema = z.object({
  /** 模式 */
  mode: z.enum(TEAM_MODES),
  /** 进入协作模式前最后一次关闭模式的运行启用的工具名；只在进入协作模式时写的那条里有 */
  tools: z.array(z.string()).optional(),
});
export type TeamEntryData = z.infer<typeof TeamEntrySchema>;

/** @brief 回执的种类（§13.2）：登记、补充、撤销。 */
export const RECEIPT_KINDS = ['registered', 'added', 'cancelled'] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

/** @brief mori.receipt 条目与同名事件：立项实际写入的一次需求登记、补充或撤销（§13.2）。 */
export const ReceiptEntrySchema = z.object({
  /** 种类 */
  kind: z.enum(RECEIPT_KINDS),
  /** 需求编号 */
  request: z.number().int().positive(),
  /** 写入时需求的标题 */
  title: z.string(),
  /** added 时记下的原话全文（界面截断显示）；其他种类为 null */
  quote: z.string().nullable(),
  /** 写入的时刻（ms） */
  at: z.number(),
});
export type ReceiptEntryData = z.infer<typeof ReceiptEntrySchema>;

/** @brief mori.progress 条目：这个需求的进展摘要挂在这里（§5.3 第 6 步、§13.3）。 */
export const ProgressEntrySchema = z.object({
  /** 需求编号 */
  request: z.number().int().positive(),
});
export type ProgressEntryData = z.infer<typeof ProgressEntrySchema>;

/** @brief 程序投递到用户会话的种类（§5.6）。 */
export const WAKE_KINDS = ['request_closed', 'relay', 'ask_user', 'create_wake'] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];

/** @brief mori.wake 条目：它指向的用户消息是程序投递的，界面不显示为你的消息（§5.6、§13.7）。 */
export const WakeEntrySchema = z.object({
  /** 那条用户消息的条目 id */
  messageId: z.string().min(1),
  /** 投递的种类 */
  kind: z.enum(WAKE_KINDS),
});
export type WakeEntryData = z.infer<typeof WakeEntrySchema>;

/** @brief mori.instance 条目：实例会话的第一条，供恢复使用（§3、§8.1）。 */
export const InstanceEntrySchema = z.object({
  /** 会话的种类 */
  kind: z.enum(INSTANCE_KINDS),
  /** 角色名 */
  role: z.string().min(1),
  /** task 实例所在的 task；其他种类没有 */
  task: z.string().regex(TASK_ID_PATTERN).optional(),
  /** 结案会话、订阅所属的需求编号；其他种类没有 */
  request: z.number().int().positive().optional(),
});
export type InstanceEntryData = z.infer<typeof InstanceEntrySchema>;

/** @brief mori.create_cursor 条目：分开时的立项会话里，上一次投递带到了用户会话的哪个条目（§8.4）。 */
export const CreateCursorEntrySchema = z.object({
  /** 用户会话的条目 id；那次投递时用户会话还没有条目为 null */
  entryId: z.string().min(1).nullable(),
});
export type CreateCursorEntryData = z.infer<typeof CreateCursorEntrySchema>;

// ---- 事件（§13.10），都在用户会话的信封上 ----

/** @brief 协作的会话事件，由 protocol.ts 并进 KernelEvent。 */
export type TeamEvent =
  /** 协作状态变了：模式、持有者、角色、busy */
  | ({ type: 'mori.team_state' } & TeamState)
  /** TaskBoard 视图（后台进程合并发送，最多每 250 毫秒一次） */
  | ({ type: 'mori.board' } & BoardView)
  /** 一行回执，与同一时刻写下的 mori.receipt 条目内容相同 */
  | ({ type: 'mori.receipt' } & ReceiptEntryData)
  /** 进展摘要的位置，与同一时刻写下的 mori.progress 条目对应 */
  | {
    type: 'mori.progress';
    /** 需求编号 */
    request: number;
    /** 写条目的时刻（ms） */
    at: number;
  }
  /** 下一条文字相同的 role 为 user 的 message_start 是程序投递，界面不显示为你的消息（§13.7） */
  | {
    type: 'mori.wake';
    /** 投递的全文（[Mori] 开头） */
    text: string;
    /** 投递的种类 */
    kind: WakeKind;
  }
  /** 立项判断你的消息：阶段行与排队区（§5.3、§13.6） */
  | ({ type: 'mori.team_deciding' } & TeamDeciding)
  /** 后台实例在等你批准 */
  | ({ type: 'mori.team_approval_request' } & TeamApprovalRequest)
  /** 后台实例的批准请求结束 */
  | ({ type: 'mori.team_approval_end' } & TeamApprovalEnd);

// ---- 参数归一（§6.2）：工具的 prepareArguments 与界面的工具标题共用 ----

/** @brief 键名比较用的写法：不分大小写，不看 _ 与 -。 */
function keyForm(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/**
 * @brief 按 §6.2 的键名归一取一个参数：键名不分大小写、不看 _ 与 -，<name>_id、<name>Id 也算 <name>
 *        （例如 task_id、taskId、Task 都是 task）。
 * @param args 原始参数
 * @param name schema 里的键名
 * @return 第一个对得上的键的值；没有时为 undefined
 */
export function argOf(args: Readonly<Record<string, unknown>>, name: string): unknown {
  if (Object.hasOwn(args, name)) return args[name];
  const want = keyForm(name);
  const key = Object.keys(args).find((item) => keyForm(item) === want || keyForm(item) === `${want}id`);
  return key === undefined ? undefined : args[key];
}

/** @brief task 编号的写法：T3、t3、3（§6.2）。 */
const TASK_REF = /^\s*t?\s*0*([1-9][0-9]*)\s*$/i;
/** @brief 需求编号的写法：1、R1、request 1（§6.2）。 */
const REQUEST_REF = /^\s*(?:r|request)?\s*0*([1-9][0-9]*)\s*$/i;

/**
 * @brief 把 task 编号的各种写法归一成 T<n>（§6.2：T3、t3、3 都认）。
 * @param value 原始参数值
 * @return 例如 'T3'；不是 task 编号时为 null
 */
export function normalizeTaskId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? `T${value}` : null;
  if (typeof value !== 'string') return null;
  const match = TASK_REF.exec(value);
  return match ? `T${match[1]}` : null;
}

/**
 * @brief 把需求编号的各种写法归一成数字（§6.2：1、"1"、R1、request 1 都认）。
 * @param value 原始参数值
 * @return 需求编号；不是需求编号时为 null
 */
export function normalizeRequestNo(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = REQUEST_REF.exec(value);
  return match ? Number(match[1]) : null;
}

// ---- 工具调用标题（§13.8；v0 的工具用 english-ui 的英文词，进展摘要、证据、read_session 用） ----

/** @brief 工具调用标题的上下文。 */
export interface TitleContext {
  /** 会话的工作目录：在它之内的路径显示为相对路径 */
  cwd: string;
  /** agent_message 发给这些角色时进它们的座位会话（Message <role>），发给其他角色开临时提问（Ask <role>）；见 seatRolesOf */
  seatRoles: readonly string[];
  /** 这个会话所在的 task（task 实例）：task_handoff 没写 task 时用它；其他会话为 null */
  task: string | null;
}

/**
 * @brief agent_message 发给哪些角色时进座位会话（§10.1）：协作模式下是立项与结案的持有者，关闭模式下一律开临时提问。
 * @param team 这次运行开始时的协作模式与持有者
 */
export function seatRolesOf(team: Pick<TeamState, 'mode' | 'holders'>): string[] {
  return team.mode === 'off' ? [] : [...new Set([team.holders.create, team.holders.close])];
}

/** 命令标题最多显示的字数（同 v0 工具卡） */
const COMMAND_MAX = 80;
/** 参数还没有、或不是字符串时标题里的占位（同 v0 工具卡“参数还没写完”） */
const MISSING = '…';

/** @brief v0 工具的动词（english-ui 的词）。 */
const BASIC_VERBS: ReadonlyMap<string, string> = new Map([
  ['read', 'Read'], ['bash', 'Run'], ['powershell', 'Run'], ['edit', 'Edit'], ['write', 'Write'],
  ['grep', 'Search'], ['find', 'Find'], ['ls', 'List'],
]);

/** @brief 在工作目录之内的路径显示为相对路径（同 v0 工具卡）。 */
function displayPath(path: string, cwd: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return normalized.slice(base.length + 1);
  return path;
}

/** @brief 命令只取第一行并截断（同 v0 工具卡）。 */
function commandLine(command: string): string {
  const lines = command.trim().split(/\r?\n/);
  const first = lines[0] ?? '';
  const cut = first.length > COMMAND_MAX ? `${first.slice(0, COMMAND_MAX)}…` : first;
  return lines.length > 1 && cut === first ? `${cut} …` : cut;
}

/** @brief read 的行范围后缀：" · lines a–b" 或 " · from line a"。 */
function lineRange(args: Readonly<Record<string, unknown>>): string {
  const offset = Number(args.offset);
  const limit = Number(args.limit);
  if (!Number.isFinite(offset) || offset <= 0) return '';
  return Number.isFinite(limit) && limit > 0 ? ` · lines ${offset}–${offset + limit - 1}` : ` · from line ${offset}`;
}

/** @brief 取一个字符串参数；没有或不是字符串时为 null。 */
function textArg(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' ? value : null;
}

/** @brief v0 工具与 MCP 工具的标题（docs/v0/screens/tool-cards.md 的规则，english-ui 的词）。 */
function basicToolTitle(toolName: string, args: Readonly<Record<string, unknown>>, cwd: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  const verb = BASIC_VERBS.get(toolName);
  if (!verb) return toolName;
  if (toolName === 'bash' || toolName === 'powershell') {
    const command = textArg(args, 'command');
    return `${verb} ${command === null ? MISSING : commandLine(command)}`;
  }
  if (toolName === 'grep' || toolName === 'find') return `${verb} ${textArg(args, 'pattern') ?? MISSING}`;
  const path = textArg(args, 'path');
  if (toolName === 'ls') return `${verb} ${path ? displayPath(path, cwd) : '.'}`;
  const target = path === null ? MISSING : displayPath(path, cwd);
  return `${verb} ${target}${toolName === 'read' ? lineRange(args) : ''}`;
}

/** @brief agent_message 的标题：发到 task、进座位会话、开临时提问（§13.8）。 */
function messageTitle(to: unknown, seatRoles: readonly string[]): string {
  const task = normalizeTaskId(to);
  if (task !== null) return `Message ${task}`;
  if (typeof to !== 'string' || !to.trim()) return `Message ${MISSING}`;
  const role = to.trim();
  return `${seatRoles.includes(role) ? 'Message' : 'Ask'} ${roleLabel(role)}`;
}

/** @brief TaskBoard 工具的标题（§13.8）；参数按 §6.2 归一，缺的部分写作 …。 */
function teamToolTitle(name: TeamToolName, args: Readonly<Record<string, unknown>>, context: TitleContext): string {
  const task = normalizeTaskId(argOf(args, 'task'));
  const request = normalizeRequestNo(argOf(args, 'request'));
  const requestText = request === null ? MISSING : String(request);
  switch (name) {
    case 'board_read':
      if (task !== null) return `Read ${task}`;
      return request === null ? 'Read the board' : `Read request ${request}`;
    case 'read_session': {
      const role = argOf(args, 'role');
      const who = typeof role === 'string' && role.trim() ? roleLabel(role.trim()) : MISSING;
      return `Read ${who}’s work on ${task ?? MISSING}`;
    }
    case 'agent_message': return messageTitle(argOf(args, 'to'), context.seatRoles);
    case 'task_handoff': return `Hand off ${task ?? context.task ?? MISSING}`;
    case 'request_submit': return 'Register a request';
    case 'request_update': return `Add to request ${requestText}`;
    case 'request_cancel': return `Cancel request ${requestText}`;
    case 'task_create': return 'Create a task';
    case 'task_edit': return `Edit ${task ?? MISSING}`;
    case 'reply_via_dialog': return 'Answer directly';
    case 'request_close': return `Close request ${requestText}`;
  }
}

/**
 * @brief 一次工具调用的英文标题（§13.8）：TaskBoard 工具按 §13.8 的表，其余按 v0 工具卡的规则。
 *        进展摘要的当前在做什么（§13.3）、证据的 title（§7.3）、read_session 的工具标题（§10.2）都用它。
 * @param toolName 工具名
 * @param args 调用参数（原始参数，按 §6.2 归一）
 * @param context 工作目录、座位角色、所在的 task
 */
export function toolCallTitle(toolName: string, args: Readonly<Record<string, unknown>>,
  context: TitleContext): string {
  if (isTeamTool(toolName)) return teamToolTitle(toolName, args, context);
  return basicToolTitle(toolName, args, context.cwd);
}

// ---- 回执与进展摘要的文字（§13.2、§13.3） ----

/**
 * @brief 超过上限的文字截断并加 …（按字符计）。
 * @param text 原文
 * @param max 最多保留的字符数
 */
export function clipText(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/**
 * @brief 回执的一行（§13.2）：Request 1 registered · <title>、Added to request 1: “<原话>”（超过 120 字符截断加 …）、
 *        Request 1 cancelled。
 * @param receipt mori.receipt 的内容
 */
export function receiptText(receipt: Pick<ReceiptEntryData, 'kind' | 'request' | 'title' | 'quote'>): string {
  switch (receipt.kind) {
    case 'registered': return `Request ${receipt.request} registered · ${receipt.title}`;
    case 'added': {
      const quote = clipText(receipt.quote ?? '', TEXT_LIMITS.receiptQuote);
      return `Added to request ${receipt.request}: “${quote}”`;
    }
    case 'cancelled': return `Request ${receipt.request} cancelled`;
  }
}

/**
 * @brief 进展摘要的时长（§13.3）：<1 min、6 min、1 h 12 min。
 * @param elapsedMs createdAt 到现在或到 closedAt 的毫秒数
 */
export function durationText(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * @brief 进展摘要的需求状态文字（§13.3）。
 * @param state 需求状态
 * @param holders 权限的持有者（Waiting for <create role>、With <close role>）
 */
export function requestStateText(state: RequestState, holders: TeamHolders): string {
  switch (state) {
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'needs_decision': return 'Needs your decision';
    case 'waiting_create': return `Waiting for ${roleLabel(holders.create)}`;
    case 'stopped': return 'Stopped';
    case 'with_close': return `With ${roleLabel(holders.close)}`;
    case 'running': return 'Running';
  }
}

/** @brief lock_wait 的文字：持有写入锁的 task 被停止时注明 stopped（§13.3）。 */
function lockWaitText(task: TaskView, view: BoardView): string {
  const holder = task.waitingFor[0] ?? MISSING;
  const stopped = view.requests.some((request) => request.tasks.some((item) => item.id === holder
    && item.status === 'stopped'));
  return `Waiting to change files (${holder}${stopped ? ', stopped' : ''})`;
}

/**
 * @brief 进展摘要里 task 一行的“在做什么”（§13.3 的 phase 文字）；模型提示（modelNote）由界面接在这一行末尾。
 * @param task task 的视图
 * @param view 整块 TaskBoard 的视图（找持有写入锁的 task）
 * @param holders 权限的持有者
 * @param cwd 会话的工作目录（工具标题里的路径）
 */
export function taskPhaseText(task: TaskView, view: BoardView, holders: TeamHolders, cwd: string): string {
  switch (task.phase) {
    case 'pending': return `Waiting for ${task.waitingFor.join(', ')}`;
    case 'queued': return 'Queued';
    case 'lock_wait': return lockWaitText(task, view);
    case 'starting': return 'Starting';
    case 'running': return task.current === null ? 'Starting' : toolCallTitle(task.current.toolName,
      task.current.args, { cwd, seatRoles: [holders.create, holders.close], task: task.id });
    case 'approval': return 'Waiting for your approval';
    case 'waiting_user': return `Waiting for ${roleLabel(holders.create)}`;
    case 'asked': return 'Needs your decision';
    case 'with_close': return `With ${roleLabel(holders.close)}`;
    case 'stopped': return 'Stopped';
    case 'stopped_restart': return 'Stopped (Mori restarted)';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
  }
}

/** @brief 程序写的一棒在交接链里的文字（§13.3，链里写作 Mori: <文字>）。 */
export const PROGRAM_HANDOFF_LINES: Readonly<Record<HandoffReason, string>> = Object.freeze({
  no_handoff: 'no handoff',
  error: 'error',
  no_model: 'no model',
  dependency_failed: 'dependency failed',
  close_undecided: "close didn’t decide",
});

/**
 * @brief 交接链的一行（§13.3 展开时）：executor: Fixed → reviewer: Failed, logout test fails → …
 * @param chain task 视图的交接链
 */
export function chainText(chain: readonly HandoffLink[]): string {
  return chain.map((link) => `${roleLabel(link.role)}: ${link.line}`).join(' → ');
}
