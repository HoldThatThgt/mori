// 协作里每条会话（用户会话与实例）在 Team 里的状态（docs/specs/parallel-agents-taskboard.md §3、§8.1、§8.2、§9.4）：
// 会话的键与 pi 会话 id、投递队列（程序投递合并、单独占一次运行的强制填写与换模型继续）、一次运行里程序要记下的事。
// 这里是类型与纯函数；状态的变化由 team.ts、teamRuns.ts、teamTools.ts 做。

import type { WakeKind, InstanceKind, TeamMode, ToolCallBrief } from '../shared/team';
import type { FillTarget } from './boardText';
import { closeSessionKey, createSessionKey, mergeDeliveries, taskSessionKey } from './boardRoute';
import type { HandoffForm, WriteMode } from './handoffForm';
import type { UnavailableInfo } from './modelTypes';
import type { SegmentPreference, StopReason } from './teamHost';
import type { Delivery, Judgment } from './teamTypes';

/** @brief 会话的种类：用户会话（对话；合并会话时也是立项），或实例的种类。 */
export type LaneKind = 'user' | InstanceKind;

/** @brief 等一次运行的回复的一方（agent_message 的 wait、临时提问的发送方，§10.1）。 */
export interface Waiter {
  /**
   * @brief 等到了：回复是那次运行的最后一段文字；error 为真时 text 是失败的原因（停止、出错、选不到模型）。
   * @param text 回复或原因
   * @param error 是否失败
   */
  settle(text: string, error: boolean): void;
}

/** @brief 一次强制填写（§7.5）：表单、投递里写明的对象、第几次（格式重试最多 1 次）。 */
export interface ForcedFill {
  /** 要填的表单（handoffForm.ts） */
  form: HandoffForm;
  /** 投递文字里的对象（boardText.ts） */
  target: FillTarget;
  /** 第 1 次，或格式重试的第 2 次 */
  attempt: 1 | 2;
  /** 填不出来时程序写的一棒的结论：没交接的那次运行的最后一段文字（task 实例） */
  fallbackText: string;
}

/** @brief 一次投递在队列之外要带着的东西。 */
export interface DeliveryMeta {
  /** 用户会话的程序投递：mori.wake 的种类（§5.6） */
  wake?: WakeKind;
  /** 段开始时选模型的偏好（task 中途换模型后继续，§12.4） */
  choice?: SegmentPreference;
  /** 强制填写（§7.5） */
  forced?: ForcedFill;
  /** 等这次投递所在运行的回复的一方（agent_message wait，§10.1） */
  waiter?: Waiter;
  /** 立项会话：这是结案请它为这个需求再建 task 的消息（§5.4 兜底表第 3 行） */
  closeAsk?: number;
  /** 分开时的立项会话：用户消息的投递（Delivery.user）里你输入的原文，这次运行开始判断它（§5.3、§5.4） */
  userText?: string;
  /** 转告与问你拿主意（relay、ask_user）标了 asked 的 task 与需求：被 Stop team 丢弃时改回假（§11.4） */
  asked?: { tasks: string[]; requests: number[] };
}

/** @brief Team 投递队列里的一项（boardRoute 的 Delivery 加上 meta）。 */
export interface TeamDelivery extends Delivery {
  /** 队列之外要带着的东西 */
  meta: DeliveryMeta;
}

/** @brief 一次运行里程序要记下的事（§5.4、§7.1、§7.4、§7.5、§7.6、§9.4）。 */
export interface LaneRun {
  /** 这次运行开始时的协作模式（工作卡、工具、附加段按它，§5.1） */
  mode: TeamMode;
  /** 开始这次运行的投递；你的消息开始的运行为空 */
  batch: TeamDelivery[];
  /** 强制填写的运行；不是时为 null */
  forced: ForcedFill | null;
  /** 强制填写这次实际用的写法（流函数包装第一次问 shape 时记下）；没套用时为 null */
  formMode: WriteMode | null;
  /** 强制填写的运行里表单工具在执行时被拒绝的原文（交给格式重试，§7.5 第 3 步） */
  formError: string | null;
  /** task 实例：这次运行里成功交接的 task；没有时为 null */
  handedOff: string | null;
  /** 结案会话：这次运行里已经交接的 task */
  decided: string[];
  /** 结案会话：这次运行开始前就交给它的 task */
  heldAtStart: string[];
  /** 结案会话：因为“全部已结束”或“没有 task”被唤醒（§7.6） */
  wokenForEnd: boolean;
  /** 立项会话：这次运行给哪些需求的结案会话发过消息 */
  messagedClose: number[];
  /** 立项会话：这次运行调过 reply_via_dialog { note }（程序唤醒的回合，§5.4） */
  relayed: boolean;
  /** 这次运行里结束的助手消息数（强制填写只改第一个请求，§7.5 第 2 步） */
  assistants: number;
  /** 最后一段助手文字 */
  lastText: string;
  /** 运行以出错结束时的错误原文；没有时为 null */
  error: string | null;
  /** 运行中候选耗尽（§12.5）；没有时为 null */
  unavailable: UnavailableInfo | null;
  /** 立项的这次判断（分开时的立项会话、合并会话的用户会话）；不判断时为 null */
  judgment: Judgment | null;
  /** 这次判断的用户消息原文（程序唤醒的回合为 null） */
  judgedText: string | null;
  /** 最近结束的一次判断（endJudgment 记下；分开时立项的决定按它记，§5.4）；还没有时为 null */
  ended: Judgment | null;
  /** 用户会话：照 v0 交给对话的扩展命令用 sendUserMessage 开始的运行（工作卡写 No decision，§5.3）；其他为 null */
  command: string | null;
  /** 对话会话：这次运行允许的工具条目（§5.5 的 tool_call 限制）；不限制时为 null */
  allowed: string[] | null;
  /** 运行开始的时刻（ms）：程序唤醒的立项回合判断“有没有新的未结束的 task”（§5.4 兜底表） */
  startedAt: number;
}

/** @brief 一条会话在 Team 里的状态。 */
export interface Lane {
  /** 会话的键（boardRoute：user、create、close:<n>、task:<T>:<role>、ask:<n>、sub:<n>:<role>） */
  key: string;
  /** pi 会话 id（§3） */
  id: string;
  /** 种类 */
  kind: LaneKind;
  /** 角色 */
  role: string;
  /** task 实例所在的 task；其他为 null */
  task: string | null;
  /** 结案、订阅所属的需求；task 实例的 task 所属的需求；临时提问的发送方所在的需求；其他为 null */
  request: number | null;
  /** task 实例：task 是只读的 */
  readOnly: boolean;
  /** 在协作模式下建立（关闭模式下的临时提问没有 TaskBoard 工具与工作卡） */
  team: boolean;
  /** 实例会话文件；还不知道（没建过）时为 null */
  file: string | null;
  /** pi 会话开着 */
  open: boolean;
  /** 程序投递的队列（相邻的合并成一次运行，§8.2） */
  queue: TeamDelivery[];
  /** 单独占一次运行的投递（强制填写、换模型继续），排在 queue 之前 */
  solo: TeamDelivery[];
  /** 有一次投递（或 Team 开始的对话回复）还没结束：准备中或运行中 */
  busy: boolean;
  /** 这次投递已经开始运行（agent_start） */
  started: boolean;
  /** 正在进行的投递（开始运行时成为 LaneRun.batch）；你的消息开始的运行为空 */
  inflight: TeamDelivery[];
  /** 这次投递在段开始时就选不到模型（onUnavailable 的 firstRequest，§12.5）；没有时为 null */
  startUnavailable: UnavailableInfo | null;
  /** 运行结束后程序正在处理（§9.4，可能要写 TaskBoard）；处理完之前会话仍算忙 */
  settling: Promise<void> | null;
  /** 正在进行的运行；没有时为 null */
  run: LaneRun | null;
  /** Team 发起的停止的原因（§9.4 第 0 行），运行结束时清掉 */
  stop: StopReason | null;
  /** 最近一次工具调用（TaskView.current）；运行结束时清掉 */
  current: ToolCallBrief | null;
  /** 最近一条换模型、等待的提示（§12.12），下一次运行开始时清掉 */
  modelNote: string | null;
  /** task 实例的下一个证据编号；还没从会话里读出时为 null（§7.3） */
  tagNext: number | null;
  /** task 实例这一棒开始的回合（从 1 编号，§7.2）；还没开始时为 null */
  batonStart: number | null;
  /** 关闭模式下对话这个回合已经发出的 agent_message 条数（§10.1） */
  sentThisTurn: number;
  /** 临时提问：发送方会话的键（停止对话的回复时一并停止，§11.4）；其他为 null */
  parent: string | null;
  /** 临时提问：等回答的发送方；其他为 null */
  asker: Waiter | null;
  /** 分开时的立项会话：上一次投递带到的用户会话条目（mori.create_cursor）；还没读出时为 undefined */
  cursor: string | null | undefined;
  /** 分开时的立项会话：这次投递带到的用户会话条目，开始运行时写成 mori.create_cursor（§8.4）；没有时为 undefined */
  pendingCursor: string | null | undefined;
}

/**
 * @brief 新的一条会话的状态。
 * @param fields 键、id、种类、角色与所在的 task、需求
 */
export function newLane(fields: Pick<Lane, 'key' | 'id' | 'kind' | 'role' | 'task' | 'request' | 'readOnly'
  | 'team'>): Lane {
  return {
    ...fields, file: null, open: false, queue: [], solo: [], busy: false, started: false, inflight: [],
    startUnavailable: null, settling: null, run: null, stop: null,
    current: null, modelNote: null, tagNext: null, batonStart: null, sentThisTurn: 0, parent: null, asker: null,
    cursor: undefined, pendingCursor: undefined,
  };
}

/**
 * @brief 新的一次运行。
 * @param mode 运行开始时的协作模式
 * @param batch 开始它的投递
 */
export function newRun(mode: TeamMode, batch: TeamDelivery[]): LaneRun {
  const forced = batch.find((item) => item.meta.forced)?.meta.forced ?? null;
  return {
    mode, batch, forced, formMode: null, formError: null, handedOff: null, decided: [], heldAtStart: [],
    wokenForEnd: batch.some((item) => item.cause.kind === 'close_all_ended' || item.cause.kind === 'no_tasks'),
    messagedClose: [], relayed: false, assistants: 0, lastText: '', error: null,
    unavailable: null, judgment: null, judgedText: null, ended: null, command: null, allowed: null,
    startedAt: Date.now(),
  };
}

// ---- 会话的键与 pi 会话 id（§3） ----

/** @brief 各种实例会话的键与 pi 会话 id。 */
export const LANE_IDS = Object.freeze({
  /** 分开时的立项会话 */
  create: (user: string) => ({ key: createSessionKey(false), id: `${user}.create` }),
  /** 一个需求的结案会话 */
  close: (user: string, request: number) => ({ key: closeSessionKey(request), id: `${user}.close.${request}` }),
  /** 一个（task，角色）的 task 实例 */
  task: (user: string, task: string, role: string) => ({
    key: taskSessionKey(task, role), id: `${user}.${task.toLowerCase()}.${role}`,
  }),
  /** 一次临时提问（n 取 board.nextAsk） */
  ask: (user: string, n: number, role: string) => ({ key: `ask:${n}`, id: `${user}.ask.${n}.${role}` }),
  /** 一次订阅（需求号与订阅者） */
  subscription: (user: string, request: number, role: string) => ({
    key: `sub:${request}:${role}`, id: `${user}.sub.${request}.${role}`,
  }),
});

// ---- 投递队列（§8.2） ----

/**
 * @brief 下一次运行要投递的：单独占一次运行的（强制填写、换模型继续）先，各占一次；否则按 boardRoute.mergeDeliveries
 *        （用户消息的投递单独占一次、排在前面，其余程序投递合并成一次）。
 * @param lane 会话（取出的项从队列里去掉）
 * @return 这次运行投递的；队列为空时为空数组
 */
export function takeBatch(lane: Lane): TeamDelivery[] {
  const solo = lane.solo.shift();
  if (solo) return [solo];
  const { batch, rest } = mergeDeliveries(lane.queue);
  lane.queue = rest as TeamDelivery[];
  return batch as TeamDelivery[];
}

/** @brief 会话的队列里还有要投递的。 */
export function hasQueued(lane: Lane): boolean {
  return lane.solo.length > 0 || lane.queue.length > 0;
}

/** @brief 会话在运行、准备中、运行结束后程序还在处理，或还有要投递的（调度、busy、关闭会话的判断用）。 */
export function laneActive(lane: Lane): boolean {
  return lane.busy || lane.settling !== null || hasQueued(lane);
}
