// 平行 Agent 与 TaskBoard 只在后台进程里用的类型（docs/specs/parallel-agents-taskboard.md §5.4、§6.1、§8.2、§9、§10.1）：
// board.json 的结构（zod，读文件时校验；task 的收窄 limits 见 docs/specs/file-system-permissions.md §8.2、§8.8）、
// 立项一次判断的状态、唤醒、程序投递、调度与 Agent 消息路由的输入输出。
// 界面也要看到的类型与取值在 shared/team.ts。

import { z } from 'zod';
import {
  HANDOFF_OUTCOMES, HANDOFF_REASONS, REQUEST_STATUSES, TASK_STATUSES, type InstanceKind, type RequestStatus,
} from '../shared/team';

// ---- board.json（§6.1） ----

/** @brief task 的持有者（BoardTask.holder）：某个角色，或这个需求的结案会话。 */
export const HolderSchema = z.discriminatedUnion('kind', [
  z.object({
    /** 角色在做 */
    kind: z.literal('role'),
    /** 角色名 */
    role: z.string().min(1),
  }),
  z.object({
    /** 在这个需求的结案会话里 */
    kind: z.literal('close'),
  }),
]);
export type Holder = z.infer<typeof HolderSchema>;

/** @brief 一棒交接的去向（Handoff.routedTo，§7.1）。 */
export const RoutedToSchema = z.discriminatedUnion('kind', [
  z.object({
    /** 交给一个角色 */
    kind: z.literal('role'),
    /** 角色名 */
    role: z.string().min(1),
  }),
  z.object({
    /** 交给这个需求的结案会话 */
    kind: z.literal('close'),
  }),
  z.object({
    /** 交给立项（need_user：等用户拿主意） */
    kind: z.literal('create'),
  }),
  z.object({
    /** task 关闭 */
    kind: z.literal('end'),
    /** 关闭的状态 */
    status: z.enum(['done', 'failed']),
  }),
]);
export type RoutedTo = z.infer<typeof RoutedToSchema>;

/** @brief 交接引用的一条证据（§7.3），已经由程序核对过。 */
export const EvidenceSchema = z.object({
  /** 引用的编号，写作 #3 */
  tag: z.string().min(1),
  /** pi 的 toolCallId */
  toolCallId: z.string().min(1),
  /** 工具名 */
  toolName: z.string().min(1),
  /** 工具调用的标题（§13.8） */
  title: z.string(),
  /** 结果不是错误 */
  ok: z.boolean(),
});
export type EvidenceRecord = z.infer<typeof EvidenceSchema>;

/** @brief 一棒在实例会话里的位置（§7.2、§10.2）：会话文件与这一棒的回合范围（回合从 1 编号）。 */
export const SessionSpanSchema = z.object({
  /** 实例会话文件 */
  file: z.string().min(1),
  /** 这一棒的第一个与最后一个回合 */
  turns: z.tuple([z.number().int().positive(), z.number().int().positive()]),
});
export type SessionSpan = z.infer<typeof SessionSpanSchema>;

/** @brief 一棒交接（§6.1 Handoff）。 */
export const HandoffSchema = z.object({
  /** 这个 task 上的第几棒，从 1 开始 */
  n: z.number().int().positive(),
  /** 角色名；结案会话写 close:<角色名>；程序写的为 mori */
  from: z.string().min(1),
  /** 交接的结果；程序兜底时为 null */
  outcome: z.enum(HANDOFF_OUTCOMES).nullable(),
  /** 结论（≤ 600）；need_user 时是要用户拿主意的问题 */
  conclusion: z.string(),
  /** 写下的下一棒；没写为 null */
  next: z.string().nullable(),
  /** 未结事项 */
  openItems: z.array(z.string()),
  /** 证据 */
  evidence: z.array(EvidenceSchema),
  /** 会话位置；程序写的、task 没运行过时为 null */
  session: SessionSpanSchema.nullable(),
  /** 去向 */
  routedTo: RoutedToSchema,
  /** 程序写的一棒的原因（§7.4）；实例自己的交接为 null */
  reason: z.enum(HANDOFF_REASONS).nullable(),
  /** 写了却不生效的 next（§7.1、§7.5）；没有时为 null */
  suggestedNext: z.string().nullable(),
  /** 这一棒里产生成功的 edit、write 调用的模型族（§12.9） */
  authorFamilies: z.array(z.string()),
  /** 交接的时刻（ms） */
  at: z.number(),
  /** 给用户的 2–4 个选项（file-system-permissions.md §10.8）；只有带选项的 need_user 交接才有 */
  options: z.array(z.string()).optional(),
  /** 推荐的选项，等于 options 的某一项；只有带选项的 need_user 交接才有 */
  recommended: z.string().nullable().optional(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

/** @brief 需求上记下的一条用户原话（§5.4“用户原话照记”）。 */
export const UserWordSchema = z.object({
  /** 原文 */
  text: z.string(),
  /** 记下的时刻（ms） */
  at: z.number(),
  /** 登记时的原话，或之后的补充 */
  kind: z.enum(['original', 'supplement']),
});
export type UserWord = z.infer<typeof UserWordSchema>;

/** @brief 一个需求（§6.1 BoardRequest）。 */
export const BoardRequestSchema = z.object({
  /** 编号，从 1 开始，不复用 */
  no: z.number().int().positive(),
  /** 立项写的一句话（≤ 80），进展摘要的标题 */
  title: z.string(),
  /** 目标（≤ 600） */
  goal: z.string(),
  /** 验收（≤ 600）；没写为 null */
  acceptance: z.string().nullable(),
  /** 用户原话，照记：登记时的原话在前，补充按时间 */
  words: z.array(UserWordSchema),
  /** 状态 */
  status: z.enum(REQUEST_STATUSES),
  /** 结案写下的结论；撤销时为理由；没有时为 null */
  conclusion: z.string().nullable(),
  /** 需要决定的需求级问题（§7.6）；没有时为 null */
  question: z.string().nullable(),
  /** question 已经问过用户（§5.4） */
  asked: z.boolean(),
  /** 立项没建新 task 时已经再唤醒过结案一次（§5.4 兜底表第 3 行） */
  closeRetry: z.boolean(),
  /** 登记的时刻（ms） */
  createdAt: z.number(),
  /** 关闭或撤销的时刻（ms）；还开着为 null */
  closedAt: z.number().nullable(),
});
export type BoardRequest = z.infer<typeof BoardRequestSchema>;

/** @brief 留给一个 task 的消息（§10.1）。 */
export const TaskMessageSchema = z.object({
  /** 发送方的角色名 */
  from: z.string().min(1),
  /** 正文（≤ 4000） */
  text: z.string(),
  /** 留下的时刻（ms） */
  at: z.number(),
});
export type TaskMessage = z.infer<typeof TaskMessageSchema>;

/**
 * @brief task 的收窄（docs/specs/file-system-permissions.md §8.2、§8.8）：只有 false 才存，不写表示不限；
 *        与 limits.ts 的 Limits 同形。不认识的键（例如旧版本的 readOnly 写在这里）校验不过。
 */
export const LimitsSchema = z.strictObject({
  /** false：不能改文件（含写 .work）；命令照常按 commands 与路径闸第 3、4 步判断（§8.11，2026-10-28 照 Claude 的做法） */
  write: z.literal(false).optional(),
  /** false：不能跑命令 */
  commands: z.literal(false).optional(),
  /** false：不能用 MCP 与扩展注册的、不是职责工具的工具 */
  mcp: z.literal(false).optional(),
  /** 可写的范围：相对工作路径、/ 分隔、末尾带 /，1–10 项；.work/ 总是可写 */
  writePaths: z.array(z.string()).min(1).max(10).optional(),
});

/** @brief 一个 task（§6.1 BoardTask）。 */
export const BoardTaskSchema = z.object({
  /** 编号 T1、T2…，在一块 TaskBoard 内递增，不复用 */
  id: z.string().regex(/^T[1-9][0-9]*$/),
  /** 所属需求 */
  request: z.number().int().positive(),
  /** 标题（≤ 80） */
  title: z.string(),
  /** 要做什么（≤ 1200） */
  description: z.string(),
  /**
   * 这个 task 的所有实例受的收窄：立项建 task 时写（task_create 的 limits），之后不能改；必填，没有限制时为 {}
   * （file-system-permissions.md §8.8：只有 readOnly、没有 limits 的 board.json 校验不过）
   */
  limits: LimitsSchema,
  /** 指派给谁（角色名） */
  assignee: z.string().min(1),
  /** 依赖的 task，同一需求内 */
  dependsOn: z.array(z.string()),
  /** 状态；done、failed、cancelled 是终态 */
  status: z.enum(TASK_STATUSES),
  /** 谁在做：active 时非空；waiting_user、stopped 时保留提问或被停止时的持有者；pending、终态为 null */
  holder: HolderSchema.nullable(),
  /** 交到结案时的原因（§7.4），显示与工作卡用；不在结案时为 null */
  holderReason: z.string().nullable(),
  /** waiting_user 时要用户拿主意的问题 */
  question: z.string().nullable(),
  /** waiting_user 时，对话 Agent 已经问过用户 */
  asked: z.boolean(),
  /** stopped 时：用户按了停止，或 App 重启 */
  stopReason: z.enum(['user', 'restart']).nullable(),
  /** 全部交接，按先后 */
  handoffs: z.array(HandoffSchema),
  /** 留给这个 task 的消息，按先后 */
  messages: z.array(TaskMessageSchema),
  /** 建立的时刻（ms） */
  createdAt: z.number(),
  /** 结束的时刻（ms）；没结束为 null */
  closedAt: z.number().nullable(),
  /** 最近一次交到某个角色的时刻（ms），排队按它；没交给过角色为 null */
  readyAt: z.number().nullable(),
});
export type BoardTask = z.infer<typeof BoardTaskSchema>;

/** @brief 一个用户会话的 TaskBoard，board.json 的全文（§6.1）。 */
export const BoardSchema = z.object({
  /** 文件格式版本 */
  version: z.literal(1),
  /** 下一个需求编号，从 1 开始 */
  nextRequest: z.number().int().positive(),
  /** 下一个 task 编号 */
  nextTask: z.number().int().positive(),
  /** 下一个临时提问编号 */
  nextAsk: z.number().int().positive(),
  /** 正在写工作区的 task（§9.2）；没有时为 null */
  lock: z.string().nullable(),
  /** 全部需求，按编号 */
  requests: z.array(BoardRequestSchema),
  /** 全部 task，按编号 */
  tasks: z.array(BoardTaskSchema),
});
export type Board = z.infer<typeof BoardSchema>;

/** @brief 一次写入的结果：成功时为新的 TaskBoard、error 为 null；被拒绝时 board 不变、error 是原因（第一行）。 */
export type BoardWrite<Extra = object> = {
  /** 写入之后的 TaskBoard（被拒绝时就是传入的那块） */
  board: Board;
  /** 被拒绝的原因；成功时为 null */
  error: string | null;
} & Extra;

// ---- 立项的一次判断（§5.4） ----

/** @brief 立项的决定：新的请求、补充约束、取消、不需要协作（直接回答）。 */
export type DecisionKind = 'submit' | 'update' | 'cancel' | 'reply';

/** @brief 立项一次判断的状态：判断一条用户消息，或一次程序唤醒的立项回合。 */
export interface Judgment {
  /** 判断的是一条用户消息；程序唤醒的立项回合为 false */
  user: boolean;
  /** 合并会话（对话与立项是同一条会话） */
  merged: boolean;
  /** 这次判断的决定，由第一个决定类工具定下；还没有时为 null */
  kind: DecisionKind | null;
  /** 这次判断里已经成功调过 request_submit 或 request_update（task_create、task_edit 可用） */
  recorded: boolean;
  /** 这次判断登记的需求编号，按登记顺序 */
  registered: number[];
}

// ---- 唤醒（§9.1） ----

/** @brief 一次写入要唤醒的会话，由写入前后的 TaskBoard 比较得出（boardRoute.wakesAfter）。 */
export type BoardWake =
  /** task 交给了一个角色（第一次、交回、依赖完成、改派）：进调度（§9.2） */
  | { kind: 'schedule'; task: string; role: string }
  /** task 交给了这个需求的结案会话 */
  | { kind: 'close_task'; request: number; task: string }
  /** 需求下的 task 都结束了、需求还开着 */
  | { kind: 'close_all_ended'; request: number }
  /** 交接 need_user：task 等用户拿主意，唤醒立项（§7.7） */
  | { kind: 'create_need_user'; task: string }
  /** 需求有了新的需求级问题，唤醒立项（§7.6） */
  | { kind: 'create_question'; request: number }
  /** 需求关闭（done、failed）：对话去向用户汇报（§5.6 request_closed） */
  | { kind: 'dialog_closed'; request: number }
  /** 订阅的时刻命中（§9.5） */
  | { kind: 'subscription'; role: string; request: number };

// ---- 程序投递（§8.2） ----

/** @brief 一次程序投递要它处理的事，开始运行前据此检查是否过期（§8.2）。 */
export type DeliveryCause =
  /** 分开时的立项会话：判断一条用户消息（不过期） */
  | { kind: 'user_message' }
  /** task 交给这个角色（第一次或交回）；task 不再由它持有时过期 */
  | { kind: 'task_start'; task: string; role: string }
  /** task 中途换模型后继续（§12.4）；task 不再由它持有时过期 */
  | { kind: 'task_restart'; task: string; role: string }
  /** task 实例的强制填写或格式重试（§7.5）；task 不再由它持有时过期 */
  | { kind: 'forced_task'; task: string; role: string }
  /** task 交给结案、或结案的强制填写；task 不再在结案时过期 */
  | { kind: 'close_task'; task: string }
  /** 需求的 task 都结束了、立项没建新 task、强制关闭；需求关闭或又有未结束的 task 时过期 */
  | { kind: 'close_all_ended'; request: number }
  /** 需求没有 task（提醒立项、唤醒结案）；需求关闭或有了 task 时过期 */
  | { kind: 'no_tasks'; request: number }
  /** task 等用户拿主意，唤醒立项；task 不再是 waiting_user 时过期 */
  | { kind: 'need_user'; task: string }
  /** 需求级问题，唤醒立项；需求关闭或问题清掉时过期 */
  | { kind: 'question'; request: number }
  /** 请对话问用户（ask_user）；列出的 task 都不再等、列出的需求都没有问题时过期 */
  | { kind: 'ask_user'; tasks: readonly string[]; requests: readonly number[] }
  /** Agent 消息、需求关闭的汇报、转告、订阅等（不过期） */
  | { kind: 'message' };

/** @brief 一个会话投递队列里的一项（§8.2）。 */
export interface Delivery {
  /** 用户消息的投递（分开时的立项会话）：从不与别的投递合并，排在程序投递之前 */
  user: boolean;
  /** 投递的文字（[Mori] 开头，或带对话的用户消息投递） */
  text: string;
  /** 要它处理的事 */
  cause: DeliveryCause;
  /** 到达的时刻（ms） */
  at: number;
}

// ---- 调度（§9.2） ----

/** @brief 一个正在运行的实例（调度的输入）。 */
export interface RunningInstance {
  /** 实例的种类；只有 task 与 subscription 计入上限 */
  kind: InstanceKind;
  /** 角色名 */
  role: string;
  /** task 实例所在的 task；其他种类为 null */
  task: string | null;
}

/** @brief 等槽位的订阅实例（§9.5：受同时运行上限约束）。 */
export interface WaitingSubscription {
  /** 调用方给的标识 */
  id: string;
  /** 命中的时刻（ms），与 task 的 readyAt 一起排队 */
  readyAt: number;
}

/** @brief 这一刻没有开始的 task：排队（上限）或等写入锁。 */
export interface ScheduleWait {
  /** task 编号 */
  task: string;
  /** queued：同时运行的实例已满；lock_wait：别的 task 持有写入锁 */
  phase: 'queued' | 'lock_wait';
  /** lock_wait 时持有写入锁的 task；queued 时为 null */
  lockHolder: string | null;
}

/** @brief 调度的结果（boardRoute.scheduleStarts）。 */
export interface ScheduleResult {
  /** 取得写入锁之后的 TaskBoard（锁没变时就是传入的那块） */
  board: Board;
  /** 这一刻要开始的 task 实例，按 readyAt 先后 */
  starts: { task: string; role: string }[];
  /** 这一刻要开始的订阅实例（WaitingSubscription.id），按 readyAt 先后 */
  subscriptions: string[];
  /** 交给了角色却没有开始的 task */
  waiting: ScheduleWait[];
}

// ---- Agent 消息（§10.1） ----

/** @brief agent_message 发送方会话的种类：对话（用户会话），或实例的种类。 */
export type MessageSenderKind = 'dialog' | InstanceKind;

/** @brief agent_message 的发送方。 */
export interface MessageSender {
  /** 会话的种类 */
  kind: MessageSenderKind;
  /** 发送方的角色名 */
  role: string;
  /** 发送方所在的需求：task 实例的 task 所属的需求、结案会话与订阅的需求；对话、立项、临时提问为 null */
  request: number | null;
  /** 发送方这条会话的键（boardRoute.sessionKey），判断“发给自己”与互相等待 */
  session: string;
}

/** @brief agent_message 的去向（§10.1）。 */
export type MessageRoute =
  /** 留在 task 上，不唤醒任何人 */
  | { kind: 'task'; task: string }
  /** 进立项会话（合并会话时就是用户会话） */
  | { kind: 'create'; session: string }
  /** 进这个需求的结案会话 */
  | { kind: 'close'; request: number; session: string }
  /** 新开一个临时提问实例（程序收窄为 write: false，回答完就结束） */
  | { kind: 'ask'; role: string };

// ---- 订阅（§9.5） ----

/** @brief request_closed 时刻的过滤（只用“与”）；没写的项不过滤。 */
export interface RequestClosedFilter {
  /** 需求有没有已排除的方案 */
  ruledOut?: boolean;
  /** 需求的结局（done、failed、cancelled 的子集） */
  outcome?: readonly Exclude<RequestStatus, 'open'>[];
}

/** @brief 一个订阅者：角色与它订阅的 request_closed 时刻（每项一个过滤，命中任一项即唤醒）。 */
export interface Subscriber {
  /** 角色名 */
  role: string;
  /** subscribe 里的每个 request_closed 项；不带过滤的写作 {} */
  requestClosed: readonly RequestClosedFilter[];
}
