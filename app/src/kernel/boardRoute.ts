// 路由与调度（docs/specs/parallel-agents-taskboard.md §8.2、§9.1、§9.2、§9.5、§10.1），全是纯函数：
// 这一刻该开始哪些实例（同时运行上限、写入锁）、Agent 消息进哪条会话（含互相等待与条数上限）、一次写入要唤醒谁、
// 订阅的过滤、投递队列的合并与过期。

import { BASE_ROLE, normalizeTaskId, roleLabel, type TeamHolders, type TeamMode } from '../shared/team';
import {
  findRequest, findTask, isTaskEnded, requestWriteError, ruledOut, taskWriteError, tasksOf, unfinishedTasks,
} from './board';
import type {
  Board, BoardRequest, BoardTask, BoardWake, Delivery, DeliveryCause, MessageRoute, MessageSender,
  RequestClosedFilter, RunningInstance, ScheduleResult, Subscriber, WaitingSubscription,
} from './teamTypes';

/** @brief 一个用户会话同时运行的 task 实例与订阅实例合计的上限（§9.2、§15）。 */
export const RUN_CAP = 4;

/** @brief 同一需求里同一对（发送角色，收件角色）、或不在需求里的发送方同一对的 Agent 消息上限（§10.1、§15）。 */
export const MESSAGE_PAIR_CAP = 10;

/** @brief 关闭模式下对话 Agent 每个回合的 Agent 消息上限（§10.1、§15）。 */
export const MESSAGE_TURN_CAP_OFF = 5;

// ---- 调度（§9.2） ----

/** @brief 调度队列里的一项：交给了角色的 task，或等槽位的订阅。 */
type QueueItem =
  | { kind: 'task'; task: BoardTask & { holder: { kind: 'role'; role: string } }; readyAt: number; order: number }
  | { kind: 'subscription'; id: string; readyAt: number; order: number };

/** @brief 交给了角色、还没有实例在跑的 task 与等槽位的订阅，按 readyAt 先后（同一时刻 task 在前、按编号）。 */
function queueOrder(board: Board, busy: ReadonlySet<string>,
  subscriptions: readonly WaitingSubscription[]): QueueItem[] {
  const tasks = board.tasks.flatMap((task): QueueItem[] => {
    const holder = task.holder;
    if (task.status !== 'active' || holder?.kind !== 'role' || busy.has(task.id)) return [];
    return [{ kind: 'task', task: { ...task, holder }, readyAt: task.readyAt ?? 0, order: Number(task.id.slice(1)) }];
  });
  const subs = subscriptions.map((sub, index): QueueItem => ({
    kind: 'subscription', id: sub.id, readyAt: sub.readyAt,
    order: Number.MAX_SAFE_INTEGER - subscriptions.length + index,
  }));
  return [...tasks, ...subs].sort((a, b) => a.readyAt - b.readyAt || a.order - b.order);
}

/**
 * @brief 这一刻要开始的实例（§9.2）：task 实例与订阅实例合计不超过上限（对话、立项、结案、临时提问不计），
 *        超出的按 readyAt 先后排队；写 task（不是只读的）在它的第一个实例开始时取得写入锁，持有到 task 结束，
 *        锁被别的 task 占着时排队；只读的 task 不取锁。一个 task 上已有实例在跑时不再开始它的另一个实例。
 * @param running 正在运行的实例
 * @param cap 上限
 * @param subscriptions 等槽位的订阅实例
 * @return 取得写入锁之后的 TaskBoard、要开始的实例、没开始的 task 及原因
 */
export function scheduleStarts(board: Board, running: readonly RunningInstance[], cap: number = RUN_CAP,
  subscriptions: readonly WaitingSubscription[] = []): ScheduleResult {
  let free = Math.max(0, cap - running.filter((item) => item.kind === 'task' || item.kind === 'subscription').length);
  const busy = new Set(running.flatMap((item) => (item.kind === 'task' && item.task ? [item.task] : [])));
  let lock = board.lock;
  const result: Omit<ScheduleResult, 'board'> = { starts: [], subscriptions: [], waiting: [] };
  for (const item of queueOrder(board, busy, subscriptions)) {
    if (item.kind === 'subscription') {
      if (free > 0) {
        free -= 1;
        result.subscriptions.push(item.id);
      }
      continue;
    }
    const { task } = item;
    if (!task.readOnly && lock !== null && lock !== task.id) {
      result.waiting.push({ task: task.id, phase: 'lock_wait', lockHolder: lock });
    } else if (free === 0) {
      result.waiting.push({ task: task.id, phase: 'queued', lockHolder: null });
    } else {
      free -= 1;
      if (!task.readOnly) lock = task.id;
      result.starts.push({ task: task.id, role: task.holder.role });
    }
  }
  return { board: lock === board.lock ? board : { ...structuredClone(board), lock }, ...result };
}

// ---- 会话的键（§10.1：发给自己、互相等待） ----

/** @brief 用户会话（对话；合并会话时也是立项）的键。 */
export const USER_SESSION = 'user';

/**
 * @brief 立项会话的键：合并会话时就是用户会话。
 * @param merged 对话与立项由同一个角色持有
 */
export function createSessionKey(merged: boolean): string {
  return merged ? USER_SESSION : 'create';
}

/** @brief 一个需求的结案会话的键。 */
export function closeSessionKey(request: number): string {
  return `close:${request}`;
}

/** @brief 一个（task，角色）的 task 实例会话的键。 */
export function taskSessionKey(task: string, role: string): string {
  return `task:${task}:${role}`;
}

// ---- Agent 消息（§10.1） ----

/** @brief routeAgentMessage 的输入。 */
export interface MessageRouteInput {
  /** 这次运行开始时的协作模式 */
  mode: TeamMode;
  /** 发送方 */
  sender: MessageSender;
  /** 参数 to：角色名或 task 编号（原样） */
  to: string;
  /** 参数 request；没写为 null */
  request: number | null;
  /** 三项权限的持有者 */
  holders: TeamHolders;
  /** 全部角色名（mori 总是算在内） */
  roles: readonly string[];
  /** TaskBoard */
  board: Board;
  /** 正在等回复的会话：键是等待的一方，值是它在等的那一方（会话键） */
  waits: ReadonlyMap<string, string>;
  /** 协作模式下已经发出的条数，按 countKey 计 */
  sent: ReadonlyMap<string, number>;
  /** 关闭模式下对话这个回合已经发出的条数 */
  sentThisTurn: number;
}

/** @brief routeAgentMessage 的结果。 */
export interface MessageRouteResult {
  /** 去向；被拒绝时为 null */
  route: MessageRoute | null;
  /** 拒绝的原因；可以发时为 null */
  error: string | null;
  /** 发出后要加一的计数键（协作模式下发给角色时）；不计数时为 null */
  countKey: string | null;
}

/** @brief 拒绝。 */
function refused(error: string): MessageRouteResult {
  return { route: null, error, countKey: null };
}

/**
 * @brief agent_message 的去向（§10.1）：关闭模式下一律开临时提问、发到 task 被拒绝；协作模式下发到 task 留在 task 上，
 *        发给角色按顺序取第一条符合的：1. 收件角色持有结案，且发送方是立项会话或收件角色不持有立项 → 结案会话；
 *        2. 收件角色持有立项 → 立项会话；3. 其余 → 临时提问。不能发给自己这条会话；不能发进在等发送方回复的座位会话；
 *        条数上限按 §10.1。
 */
export function routeAgentMessage(input: MessageRouteInput): MessageRouteResult {
  const target = input.to.trim();
  const task = normalizeTaskId(target);
  if (task !== null) {
    if (input.mode === 'off') return refused('There are no tasks when task mode is off.');
    const error = taskWriteError(input.board, task);
    return error ? refused(error) : { route: { kind: 'task', task }, error: null, countKey: null };
  }
  const roles = [...new Set([BASE_ROLE, ...input.roles])];
  const role = target.toLowerCase();
  if (!roles.includes(role)) {
    return refused(`Unknown recipient "${target}": write a role (${roles.join(', ')}) or a task (T1).`);
  }
  if (input.mode === 'off') {
    return input.sentThisTurn >= MESSAGE_TURN_CAP_OFF
      ? refused(`Message limit reached: at most ${MESSAGE_TURN_CAP_OFF} questions per turn.`)
      : { route: { kind: 'ask', role }, error: null, countKey: null };
  }
  const routed = seatRoute(input, role);
  if ('error' in routed) return refused(routed.error);
  return checkedRoute(input, role, routed.route);
}

/** @brief 协作模式下发给角色的三条规则（§10.1）。 */
function seatRoute(input: MessageRouteInput, role: string): { route: MessageRoute } | { error: string } {
  const { holders, sender } = input;
  const merged = holders.dialog === holders.create;
  const fromCreate = sender.kind === 'create' || (merged && sender.kind === 'dialog');
  if (role === holders.close && (fromCreate || role !== holders.create)) {
    const request = input.request ?? sender.request;
    if (request === null) return { error: 'Say which request (request: N).' };
    const error = requestWriteError(input.board, request);
    return error ? { error } : { route: { kind: 'close', request, session: closeSessionKey(request) } };
  }
  if (role === holders.create) return { route: { kind: 'create', session: createSessionKey(merged) } };
  return { route: { kind: 'ask', role } };
}

/** @brief 发给自己、互相等待与条数上限的检查（§10.1）。 */
function checkedRoute(input: MessageRouteInput, role: string, route: MessageRoute): MessageRouteResult {
  const { sender } = input;
  if (route.kind === 'create' || route.kind === 'close') {
    if (route.session === sender.session) return refused("You can't send a message to your own session.");
    if (waitsFor(input.waits, route.session, sender.session)) {
      return refused(`${roleLabel(role)} is waiting for you; reply instead of asking.`);
    }
  }
  const scope = sender.request === null ? 'session' : `request:${sender.request}`;
  const countKey = `${scope}:${sender.role}>${role}`;
  if ((input.sent.get(countKey) ?? 0) >= MESSAGE_PAIR_CAP) {
    const where = sender.request === null ? 'in this session' : `in request ${sender.request}`;
    return refused(`Message limit reached: ${roleLabel(sender.role)} has sent ${MESSAGE_PAIR_CAP} messages to `
      + `${roleLabel(role)} ${where}.`);
  }
  return { route, error: null, countKey };
}

/** @brief from 是否（直接或间接）在等 target 的回复。 */
function waitsFor(waits: ReadonlyMap<string, string>, from: string, target: string): boolean {
  const seen = new Set<string>();
  for (let current = waits.get(from); current !== undefined && !seen.has(current); current = waits.get(current)) {
    if (current === target) return true;
    seen.add(current);
  }
  return false;
}

// ---- 唤醒（§9.1、§9.5） ----

/** @brief 持有者的比较用写法。 */
function holderKey(task: BoardTask): string {
  const holder = task.holder;
  return holder === null ? '' : holder.kind === 'role' ? `role:${holder.role}` : 'close';
}

/** @brief task 的“交到谁手里”没变（状态、持有者、readyAt、棒数都一样）。 */
function sameHolding(before: BoardTask | undefined, after: BoardTask): boolean {
  return before !== undefined && before.status === after.status && holderKey(before) === holderKey(after)
    && before.readyAt === after.readyAt && before.handoffs.length === after.handoffs.length;
}

/** @brief 需求开着、至少有一个 task 且全部已结束。 */
function allEnded(board: Board, request: BoardRequest | undefined): boolean {
  if (request?.status !== 'open') return false;
  const tasks = tasksOf(board, request.no);
  return tasks.length > 0 && tasks.every(isTaskEnded);
}

/** @brief task 的交接、交回、依赖带来的唤醒。 */
function taskWakes(before: Board, after: Board): BoardWake[] {
  return after.tasks.flatMap((task): BoardWake[] => {
    if (sameHolding(findTask(before, task.id), task)) return [];
    const holder = task.holder;
    if (task.status === 'active' && holder?.kind === 'role') {
      return [{ kind: 'schedule', task: task.id, role: holder.role }];
    }
    if (task.status === 'active' && holder?.kind === 'close') {
      return [{ kind: 'close_task', request: task.request, task: task.id }];
    }
    return task.status === 'waiting_user' ? [{ kind: 'create_need_user', task: task.id }] : [];
  });
}

/** @brief 需求的关闭、全部结束、需求级问题带来的唤醒。 */
function requestWakes(before: Board, after: Board, subscribers: readonly Subscriber[]): BoardWake[] {
  return after.requests.flatMap((request): BoardWake[] => {
    const old = findRequest(before, request.no);
    if (old?.status === 'open' && request.status !== 'open') {
      const report: BoardWake[] = request.status === 'cancelled' ? []
        : [{ kind: 'dialog_closed', request: request.no }];
      return [...report, ...subscriptionWakes(after, request, subscribers)];
    }
    const wakes: BoardWake[] = [];
    if (allEnded(after, request) && !allEnded(before, old)) {
      wakes.push({ kind: 'close_all_ended', request: request.no });
    }
    if (request.status === 'open' && request.question !== null && request.question !== old?.question) {
      wakes.push({ kind: 'create_question', request: request.no });
    }
    return wakes;
  });
}

/**
 * @brief 一次写入要唤醒的会话（§9.1），由写入前后的 TaskBoard 比较得出：task 交给角色（进调度）、交给结案、
 *        need_user（立项）；需求下的 task 都结束了（结案）；新的需求级问题（立项）；需求关闭（对话汇报，撤销时不汇报）
 *        与命中的订阅。需求没有 task 的提醒与唤醒由立项回合结束时的检查发起，不在这里。
 * @param before 写入之前
 * @param after 写入之后
 * @param subscribers 订阅者
 */
export function wakesAfter(before: Board, after: Board, subscribers: readonly Subscriber[] = []): BoardWake[] {
  return [...taskWakes(before, after), ...requestWakes(before, after, subscribers)];
}

/**
 * @brief request_closed 时刻的过滤是否命中（§9.5，只用“与”）。
 * @param filter 过滤；没写的项不过滤
 * @param outcome 需求的结局
 * @param hasRuledOut 需求有没有已排除的方案
 */
export function matchesRequestClosed(filter: RequestClosedFilter, outcome: 'done' | 'failed' | 'cancelled',
  hasRuledOut: boolean): boolean {
  if (filter.ruledOut !== undefined && filter.ruledOut !== hasRuledOut) return false;
  return filter.outcome === undefined || filter.outcome.includes(outcome);
}

/** @brief 一个需求关闭或撤销时命中的订阅者（每个角色最多一次）。 */
function subscriptionWakes(board: Board, request: BoardRequest, subscribers: readonly Subscriber[]): BoardWake[] {
  if (request.status === 'open') return [];
  const outcome = request.status;
  const hasRuledOut = ruledOut(board, request.no).length > 0;
  return subscribers.filter((sub) => sub.requestClosed.some((filter) => matchesRequestClosed(filter, outcome,
    hasRuledOut))).map((sub) => ({ kind: 'subscription', role: sub.role, request: request.no }));
}

// ---- 投递队列（§8.2） ----

/**
 * @brief 取出下一次运行要投递的内容（§8.2）：队列里有用户消息的投递时，最早的那条单独占一次运行、排在程序投递之前；
 *        否则全部程序投递合并成一次（按到达顺序，每条一段，见 deliveryText）。
 * @param queue 一个会话的投递队列，按到达顺序
 * @return batch：这次运行投递的；rest：留在队列里的
 */
export function mergeDeliveries(queue: readonly Delivery[]): { batch: Delivery[]; rest: Delivery[] } {
  const user = queue.findIndex((item) => item.user);
  if (user >= 0) return { batch: [queue[user]], rest: queue.filter((_, index) => index !== user) };
  return { batch: [...queue], rest: [] };
}

/**
 * @brief 一次运行的投递文字：每条一段，按到达顺序，段之间空一行。
 * @param batch mergeDeliveries 取出的 batch
 */
export function deliveryText(batch: readonly Delivery[]): string {
  return batch.map((item) => item.text).join('\n\n');
}

/** @brief task 仍由这个角色持有。 */
function heldBy(board: Board, task: string, role: string): boolean {
  const item = findTask(board, task);
  return item?.status === 'active' && item.holder?.kind === 'role' && item.holder.role === role;
}

/** @brief 需求开着、还有需求级问题。 */
function hasQuestion(board: Board, request: number): boolean {
  const item = findRequest(board, request);
  return item?.status === 'open' && item.question !== null;
}

/**
 * @brief 投递要它处理的事是否已经不成立（§8.2：开始运行前重新检查，过期的不发出、记日志）。
 * @param cause 投递的事由
 */
export function isStaleDelivery(cause: DeliveryCause, board: Board): boolean {
  switch (cause.kind) {
    case 'user_message':
    case 'message':
      return false;
    case 'task_start':
    case 'task_restart':
    case 'forced_task':
      return !heldBy(board, cause.task, cause.role);
    case 'close_task': {
      const task = findTask(board, cause.task);
      return !(task?.status === 'active' && task.holder?.kind === 'close');
    }
    case 'close_all_ended':
      return requestWriteError(board, cause.request) !== null || unfinishedTasks(board, cause.request).length > 0;
    case 'no_tasks':
      return requestWriteError(board, cause.request) !== null || tasksOf(board, cause.request).length > 0;
    case 'need_user':
      return findTask(board, cause.task)?.status !== 'waiting_user';
    case 'question':
      return !hasQuestion(board, cause.request);
    case 'ask_user':
      if (!cause.tasks.length && !cause.requests.length) return false;
      return !cause.tasks.some((task) => findTask(board, task)?.status === 'waiting_user')
        && !cause.requests.some((request) => hasQuestion(board, request));
  }
}

/**
 * @brief 把队列里过期的投递挑出来（§8.2）。
 * @param queue 一个会话的投递队列
 * @return kept：仍要投递的，顺序不变；dropped：过期的（调用方记日志）
 */
export function dropStale(queue: readonly Delivery[], board: Board): { kept: Delivery[]; dropped: Delivery[] } {
  const kept: Delivery[] = [];
  const dropped: Delivery[] = [];
  for (const item of queue) (isStaleDelivery(item.cause, board) ? dropped : kept).push(item);
  return { kept, dropped };
}
