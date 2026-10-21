// TaskBoard 的状态与写入规则（docs/specs/parallel-agents-taskboard.md §5.4、§6.1、§6.2、§7.1、§7.2、§7.4、§7.6、§7.7、
// §9.3、§11.4、§11.6、§13.3）。每个写入是纯函数：传入 TaskBoard 与此刻，返回新的 TaskBoard，或原样返回并给出拒绝的原因
// （规格的原文，工具结果的第一行）；不改传入的对象。立项一次判断的决定规则（§5.4）也在这里。
// 只有 loadBoard、saveBoard 读写文件（board.json，先写临时文件再改名，§3）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BASE_ROLE, normalizeTaskId, roleLabel, TEXT_LIMITS, type HandoffOutcome, type HandoffReason, type RequestState,
  type TaskStatus, type TeamToolName,
} from '../shared/team';
import { writeFileAtomic } from './agents';
import {
  BoardSchema, type Board, type BoardRequest, type BoardTask, type BoardWrite, type DecisionKind, type EvidenceRecord,
  type Handoff, type Holder, type Judgment, type RoutedTo, type SessionSpan,
} from './teamTypes';

/** @brief board.json 的文件名，在 <userData>/teams/<用户会话 id>/ 下（§3）。 */
export const BOARD_FILE = 'board.json';

/** 终态：不能回到其他状态（§6.2） */
const ENDED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'failed', 'cancelled']);

/** task 实例的交接结果（§6.3） */
const TASK_OUTCOMES: readonly HandoffOutcome[] = [
  'continue', 'dead_end', 'blocked', 'need_user', 'done', 'pass', 'fail',
];
/** 结案会话的交接结果（§6.3） */
const CLOSE_OUTCOMES: readonly HandoffOutcome[] = ['close_done', 'close_failed', 'continue', 'need_user'];
/** 交给结案、写了 next 也只记为建议的结果（§7.1 第 2 行） */
const TO_CLOSE_OUTCOMES: readonly HandoffOutcome[] = ['done', 'pass', 'blocked'];

// ---- 基本查询 ----

/** @brief 一块空的 TaskBoard：编号都从 1 开始。 */
export function newBoard(): Board {
  return { version: 1, nextRequest: 1, nextTask: 1, nextAsk: 1, lock: null, requests: [], tasks: [] };
}

/** @brief task 是否已结束（done、failed、cancelled）。 */
export function isTaskEnded(task: Pick<BoardTask, 'status'>): boolean {
  return ENDED.has(task.status);
}

/** @brief 按编号找需求；没有时为 undefined。 */
export function findRequest(board: Board, no: number): BoardRequest | undefined {
  return board.requests.find((request) => request.no === no);
}

/** @brief 按编号找 task；没有时为 undefined。 */
export function findTask(board: Board, id: string): BoardTask | undefined {
  return board.tasks.find((task) => task.id === id);
}

/** @brief 一个需求下的全部 task，按编号。 */
export function tasksOf(board: Board, request: number): BoardTask[] {
  return board.tasks.filter((task) => task.request === request);
}

/** @brief 一个需求下还没结束的 task。 */
export function unfinishedTasks(board: Board, request: number): BoardTask[] {
  return tasksOf(board, request).filter((task) => !isTaskEnded(task));
}

/**
 * @brief “任何写入”对需求的检查（§6.2 写入与状态表第 1 行）。
 * @return 可以写为 null；否则为原因：Request 1 does not exist. / Request 1 is closed.
 */
export function requestWriteError(board: Board, no: number): string | null {
  const request = findRequest(board, no);
  if (!request) return `Request ${no} does not exist.`;
  return request.status === 'open' ? null : `Request ${no} is closed.`;
}

/**
 * @brief “任何写入”对 task 的检查（§6.2 写入与状态表第 1 行）：task 存在、需求是 open、task 不是终态。
 * @return 可以写为 null；否则为原因：T1 does not exist. / Request 1 is closed. / T1 is closed.
 */
export function taskWriteError(board: Board, id: string): string | null {
  const task = findTask(board, id);
  if (!task) return `${id} does not exist.`;
  return requestWriteError(board, task.request) ?? (isTaskEnded(task) ? `${id} is closed.` : null);
}

/** @brief 原样返回、带上拒绝的原因。 */
function refuse<Extra extends object>(board: Board, error: string, extra: Extra): BoardWrite<Extra> {
  return { board, error, ...extra };
}

/** @brief 改一个对象的几个字段（按字段的类型检查取值）。 */
function patch<Target extends object>(target: Target, values: Partial<Target>): void {
  Object.assign(target, values);
}

/** @brief 按字符（码点）计的长度。 */
function charCount(text: string): number {
  return [...text].length;
}

/** @brief 超过 max 个字符时截断，连 … 在内不超过 max。 */
function clipTo(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** @brief 必填文字：去掉首尾空白后不能为空，且不超过 max 个字符。 */
function requiredTextError(field: string, text: string, max: number): string | null {
  return !text.trim() || charCount(text) > max ? `${field} must be 1–${max} characters.` : null;
}

/** @brief 可选文字：不超过 max 个字符。 */
function optionalTextError(field: string, text: string | null, max: number): string | null {
  return text !== null && charCount(text) > max ? `${field} must be at most ${max} characters.` : null;
}

// ---- 用户原话（§5.4） ----

/** @brief 一次判断里核对用户原话要用的文字。 */
export interface UserWords {
  /** 这次判断的用户消息全文（你输入的原文）；程序唤醒的立项回合为 null */
  message: string | null;
  /** 这个用户会话里全部用户消息的原文（核对 quote；可以含这次的消息） */
  history: readonly string[];
}

/** @brief quote 不是用户说过的原文（§5.4）。 */
export const QUOTE_MISMATCH = "quote must be the user's exact words";

/** @brief 程序唤醒的回合没有“这次的用户消息”，必须给出 quote（§5.4）。 */
export const QUOTE_REQUIRED = 'quote is required: this turn has no user message.';

/** @brief 正则里的特殊字符转义。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @brief 在用户消息里找 quote（比较时把连续空白当作一个空格，§5.4），从最近的消息找起。
 * @param quote 立项给出的原话
 * @param messages 用户消息的原文
 * @return 用户消息里对应的那段原文（空白照用户的写法）；不是任何一条的片段时为 null
 */
export function findQuote(quote: string, messages: readonly string[]): string | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const pattern = new RegExp(words.map(escapeRegExp).join('\\s+'));
  for (const message of [...messages].reverse()) {
    const match = pattern.exec(message);
    if (match) return match[0];
  }
  return null;
}

/** @brief 要记下的原话：给了 quote 时核对它，没给时是这次的用户消息全文。 */
function resolveWords(quote: string | null, words: UserWords): { text: string } | { error: string } {
  if (quote === null) return words.message === null ? { error: QUOTE_REQUIRED } : { text: words.message };
  const pool = words.message === null ? words.history : [...words.history, words.message];
  const found = findQuote(quote, pool);
  return found === null ? { error: QUOTE_MISMATCH } : { text: found };
}

// ---- 需求的写入（§5.4、§7.6） ----

/** @brief request_submit 的参数（已经归一）。 */
export interface SubmitRequestInput {
  /** 一句话标题（≤ 80） */
  title: string;
  /** 目标（≤ 600） */
  goal: string;
  /** 验收（≤ 600）；没写为 null */
  acceptance: string | null;
  /** 立项另给的用户原话；没给为 null（记这次的用户消息全文） */
  quote: string | null;
}

/**
 * @brief 登记新需求（request_submit）：原话默认是这次的用户消息全文，给了 quote 时必须是用户说过的原文。
 *        只在判断用户消息时可用由 judgmentError 把关。
 * @param words 这次的用户消息与会话里的全部用户消息
 * @param now 此刻（ms）
 * @return 成功时 request 为新需求的编号
 */
export function submitRequest(board: Board, input: SubmitRequestInput, words: UserWords,
  now: number): BoardWrite<{ request: number | null }> {
  const error = requiredTextError('title', input.title, TEXT_LIMITS.requestTitle)
    ?? requiredTextError('goal', input.goal, TEXT_LIMITS.goal)
    ?? optionalTextError('acceptance', input.acceptance, TEXT_LIMITS.acceptance);
  if (error) return refuse(board, error, { request: null });
  const resolved = resolveWords(input.quote, words);
  if ('error' in resolved) return refuse(board, resolved.error, { request: null });
  const next = structuredClone(board);
  const no = next.nextRequest;
  next.nextRequest += 1;
  next.requests.push({
    no, title: input.title.trim(), goal: input.goal.trim(), acceptance: input.acceptance?.trim() || null,
    words: [{ text: resolved.text, at: now, kind: 'original' }], status: 'open', conclusion: null, question: null,
    asked: false, closeRetry: false, createdAt: now, closedAt: null,
  });
  return { board: next, error: null, request: no };
}

/**
 * @brief 把用户的补充、约束原话记到需求上（request_update），原话规则同 submitRequest；程序唤醒的回合必须给 quote。
 * @param input 需求编号与 quote（没给为 null）
 * @param words 这次的用户消息与会话里的全部用户消息
 * @param now 此刻（ms）
 * @return 成功时 quote 为记下的原话（回执用）
 */
export function updateRequest(board: Board, input: { request: number; quote: string | null }, words: UserWords,
  now: number): BoardWrite<{ quote: string | null }> {
  const error = requestWriteError(board, input.request);
  if (error) return refuse(board, error, { quote: null });
  const resolved = resolveWords(input.quote, words);
  if ('error' in resolved) return refuse(board, resolved.error, { quote: null });
  const next = structuredClone(board);
  findRequest(next, input.request)!.words.push({ text: resolved.text, at: now, kind: 'supplement' });
  return { board: next, error: null, quote: resolved.text };
}

/**
 * @brief 撤销需求（request_cancel，§7.6）：非终态的 task 变为 cancelled（没有程序写的交接），释放写入锁，
 *        需求 cancelled、conclusion 为理由。停止运行中的实例由调用方按 cancelled 列出的 task 做。
 * @param input 需求编号与理由（没写为 null）
 * @param now 此刻（ms）
 * @return 成功时 cancelled 为被撤销的 task
 */
export function cancelRequest(board: Board, input: { request: number; reason: string | null },
  now: number): BoardWrite<{ cancelled: string[] }> {
  const error = requestWriteError(board, input.request);
  if (error) return refuse(board, error, { cancelled: [] });
  const next = structuredClone(board);
  const cancelled = unfinishedTasks(next, input.request).map((task) => {
    endTask(next, task, 'cancelled', now);
    return task.id;
  });
  const request = findRequest(next, input.request)!;
  patch(request, {
    status: 'cancelled', conclusion: input.reason?.trim() || null, closedAt: now, question: null, asked: false,
  });
  return { board: next, error: null, cancelled };
}

/** @brief request_close 的参数。 */
export interface CloseRequestInput {
  /** 要关闭的需求 */
  request: number;
  /** 结局 */
  outcome: string;
  /** 结论（≤ 1200） */
  conclusion: string;
  /** 调用它的结案会话所属的需求 */
  closer: number;
}

/**
 * @brief 关闭需求（request_close，§7.6）：只在这个需求下全部 task 已结束时可用（没有 task 也可以）；
 *        写下状态、结论、closedAt，清掉需求级问题。
 * @param now 此刻（ms）
 */
export function closeRequest(board: Board, input: CloseRequestInput, now: number): BoardWrite {
  const error = requestWriteError(board, input.request) ?? closeRequestError(board, input);
  if (error) return refuse(board, error, {});
  const next = structuredClone(board);
  patch(findRequest(next, input.request)!, {
    status: input.outcome as 'done' | 'failed', conclusion: input.conclusion.trim(), closedAt: now, question: null,
    asked: false,
  });
  return { board: next, error: null };
}

/** @brief request_close 自己的检查：是这个结案会话的需求、结局合法、task 都已结束、结论长度。 */
function closeRequestError(board: Board, input: CloseRequestInput): string | null {
  if (input.closer !== input.request) return `Request ${input.request} is not with you.`;
  if (input.outcome !== 'done' && input.outcome !== 'failed') return 'outcome must be one of: done, failed.';
  const open = unfinishedTasks(board, input.request);
  if (open.length) {
    const list = open.map((task) => `${task.id} (${task.status})`).join(', ');
    return `Request ${input.request} has tasks that have not ended: ${list}.`;
  }
  return requiredTextError('conclusion', input.conclusion, TEXT_LIMITS.requestConclusion);
}

/**
 * @brief 已排除的方案（§6.1，派生）：这个需求下以 failed 关闭的 task 的关闭结论，按关闭时间。
 * @param request 需求编号
 */
export function ruledOut(board: Board, request: number): string[] {
  return tasksOf(board, request).filter((task) => task.status === 'failed')
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
    .map((task) => closingConclusion(task));
}

/** @brief 结案关闭这个 task 时写的结论（最后一棒 close_done / close_failed）；没有时为空。 */
function closingConclusion(task: BoardTask): string {
  const closing = task.handoffs.findLast((item) => item.outcome === 'close_done' || item.outcome === 'close_failed');
  return closing?.conclusion ?? '';
}

// ---- task 的状态变化（改的是写入函数里的副本） ----

/** @brief 交给一个角色：active、持有者为它、readyAt 为此刻（排队按它）。 */
function handToRole(task: BoardTask, role: string, now: number): void {
  patch(task, { status: 'active', holder: { kind: 'role', role }, holderReason: null, readyAt: now });
}

/** @brief 交给这个需求的结案会话，带上原因（工作卡、投递用）。 */
function handToClose(task: BoardTask, reason: string): void {
  patch(task, { status: 'active', holder: { kind: 'close' }, holderReason: reason });
}

/** @brief 交给立项、等用户拿主意（§7.7）：保留提问的这一方作持有者。 */
function askUser(task: BoardTask, question: string, asker: Holder): void {
  patch(task, { status: 'waiting_user', holder: asker, question, asked: false });
  if (asker.kind === 'role') task.holderReason = null;
}

/** @brief task 结束：清掉持有者与问题，释放它持有的写入锁（§9.2）。 */
function endTask(board: Board, task: BoardTask, status: 'done' | 'failed' | 'cancelled', now: number): void {
  patch(task, {
    status, closedAt: now, holder: null, holderReason: null, question: null, asked: false, stopReason: null,
  });
  if (board.lock === task.id) board.lock = null;
}

/** @brief 记下一棒，编号接着这个 task 已有的棒数。 */
function pushHandoff(task: BoardTask, fields: Omit<Handoff, 'n'>): Handoff {
  const handoff: Handoff = { n: task.handoffs.length + 1, ...fields };
  task.handoffs.push(handoff);
  return handoff;
}

/** @brief 程序写的一棒的固定字段（§7.4：from mori、outcome null）。 */
function programFields(reason: HandoffReason, conclusion: string, routedTo: RoutedTo,
  now: number): Omit<Handoff, 'n'> {
  return {
    from: BASE_ROLE, outcome: null, conclusion: clipTo(conclusion.trim(), TEXT_LIMITS.handoffConclusion), next: null,
    openItems: [], evidence: [], session: null, routedTo, reason, suggestedNext: null, authorFamilies: [], at: now,
  };
}

// ---- 依赖（§9.3） ----

/** @brief depends_on 的各种写法归一成 T<n>（不是 task 编号的照原样留着，校验时报不存在），去重。 */
function normalizeDeps(deps: readonly string[]): string[] {
  return [...new Set(deps.map((dep) => normalizeTaskId(dep) ?? String(dep).trim()))];
}

/**
 * @brief 依赖的检查（§6.2、§9.3）：同一需求下已存在的 task，不能是自己，不能成环。
 * @param task 要设依赖的 task（新建时用将要分配的编号）
 * @param deps 已经归一的依赖
 * @return 合格为 null；否则 depends_on: <原因>
 */
function dependsOnError(board: Board, task: Pick<BoardTask, 'id' | 'request'>, deps: readonly string[]): string | null {
  for (const id of deps) {
    if (id === task.id) return `depends_on: ${id} is the task itself.`;
    const dep = findTask(board, id);
    if (!dep) return `depends_on: ${id} does not exist.`;
    if (dep.request !== task.request) {
      return `depends_on: ${id} belongs to request ${dep.request}, not request ${task.request}.`;
    }
  }
  const cycle = cycleThrough(board, task.id, deps);
  return cycle ? `depends_on: ${cycle.join(' → ')} would be a cycle.` : null;
}

/** @brief 从 deps 出发沿已有的依赖走，能回到 start 时返回这条路径（start → … → start）。 */
function cycleThrough(board: Board, start: string, deps: readonly string[]): string[] | null {
  const seen = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    if (id === start) return [...path, id];
    if (seen.has(id)) return null;
    seen.add(id);
    for (const dep of findTask(board, id)?.dependsOn ?? []) {
      const found = walk(dep, [...path, id]);
      if (found) return found;
    }
    return null;
  };
  for (const dep of deps) {
    const found = walk(dep, [start]);
    if (found) return found;
  }
  return null;
}

/**
 * @brief pending 的 task 按依赖交出去（§9.3）：有一个依赖以 failed 结束，程序写一棒交给结案（dependency_failed）；
 *        全部 done，交给 assignee；否则仍是 pending。
 */
function settlePending(board: Board, task: BoardTask, now: number): void {
  if (task.status !== 'pending') return;
  const deps = task.dependsOn.map((id) => findTask(board, id));
  const failed = deps.find((dep) => dep?.status === 'failed');
  if (failed) {
    const conclusion = `${failed.id} failed: ${closingConclusion(failed)}`;
    pushHandoff(task, programFields('dependency_failed', conclusion, { kind: 'close' }, now));
    handToClose(task, `dependency ${failed.id} failed`);
  } else if (deps.every((dep) => dep?.status === 'done')) {
    handToRole(task, task.assignee, now);
  }
}

/** @brief 每个 pending 的 task 都按依赖重新看一次。 */
function settleAll(board: Board, now: number): void {
  for (const task of board.tasks) settlePending(board, task, now);
}

// ---- task 的写入（§6.2、§7.7、§9.3） ----

/** @brief task_create 的参数（已经归一）。 */
export interface CreateTaskInput {
  /** 所属需求 */
  request: number;
  /** 标题（≤ 80） */
  title: string;
  /** 要做什么（≤ 1200） */
  description: string;
  /** 指派给谁（角色名） */
  assignee: string;
  /** 只读：不跑命令、不改文件 */
  readOnly: boolean;
  /** 依赖的 task；没写为空 */
  dependsOn: readonly string[];
}

/**
 * @brief 拆 task（task_create）：依赖都完成（或没有依赖）时直接交给 assignee；已经有一个失败时直接交给结案；否则 pending。
 * @param now 此刻（ms）
 * @return 成功时 task 为新 task 的编号
 */
export function createTask(board: Board, input: CreateTaskInput, now: number): BoardWrite<{ task: string | null }> {
  const id = `T${board.nextTask}`;
  const deps = normalizeDeps(input.dependsOn);
  const error = requestWriteError(board, input.request)
    ?? requiredTextError('title', input.title, TEXT_LIMITS.taskTitle)
    ?? requiredTextError('description', input.description, TEXT_LIMITS.taskDescription)
    ?? dependsOnError(board, { id, request: input.request }, deps);
  if (error) return refuse(board, error, { task: null });
  const next = structuredClone(board);
  next.nextTask += 1;
  const task: BoardTask = {
    id, request: input.request, title: input.title.trim(), description: input.description.trim(),
    readOnly: input.readOnly, assignee: input.assignee, dependsOn: deps, status: 'pending', holder: null,
    holderReason: null, question: null, asked: false, stopReason: null, handoffs: [], messages: [], createdAt: now,
    closedAt: null, readyAt: null,
  };
  next.tasks.push(task);
  settlePending(next, task, now);
  return { board: next, error: null, task: id };
}

/** @brief task_edit 的参数（已经归一）；没写的字段为 null。 */
export interface EditTaskInput {
  /** task 编号 */
  task: string;
  /** 新标题 */
  title: string | null;
  /** 新的要做什么 */
  description: string | null;
  /** 新的指派；交回 waiting_user、stopped 的 task 时同时交给它 */
  assignee: string | null;
  /** 新的依赖（只能在 pending 时改） */
  dependsOn: readonly string[] | null;
}

/** @brief 依赖写了、而且与现在的不同（同一组换个顺序不算改）。 */
function dependsOnChanged(task: BoardTask, deps: readonly string[] | null): boolean {
  if (deps === null) return false;
  const wanted = new Set(normalizeDeps(deps));
  return wanted.size !== task.dependsOn.length || task.dependsOn.some((id) => !wanted.has(id));
}

/** @brief task_edit 的检查（§6.2 写入与状态表）。 */
function editError(board: Board, input: EditTaskInput): string | null {
  const gate = taskWriteError(board, input.task);
  if (gate) return gate;
  const task = findTask(board, input.task)!;
  const text = (input.title === null ? null : requiredTextError('title', input.title, TEXT_LIMITS.taskTitle))
    ?? (input.description === null ? null
      : requiredTextError('description', input.description, TEXT_LIMITS.taskDescription));
  if (text) return text;
  if (dependsOnChanged(task, input.dependsOn)) {
    if (task.status !== 'pending') return `depends_on can only change before ${task.id} starts.`;
    const depError = dependsOnError(board, task, normalizeDeps(input.dependsOn!));
    if (depError) return depError;
  }
  if (task.status === 'active' && input.assignee !== null && input.assignee !== task.assignee) {
    return `${task.id} is in progress; it can be reassigned when it is handed back.`;
  }
  return null;
}

/**
 * @brief 这次 task_edit 是不是“只把 stopped、waiting_user 的 task 交回、不改其他字段”（§5.4 的例外）。
 * @param input task_edit 的参数
 */
export function isHandBackOnly(board: Board, input: EditTaskInput): boolean {
  const status = findTask(board, input.task)?.status;
  return (status === 'waiting_user' || status === 'stopped') && input.title === null && input.description === null
    && input.assignee === null && input.dependsOn === null;
}

/**
 * @brief 调整 task（task_edit）。改 title、description 从下一次请求的工作卡起生效；pending 的 task 改了依赖后重新按依赖交出；
 *        waiting_user、stopped 的 task 同时交回（§7.7 第 4 步）：交给持有者（某个角色或结案），这次写了 assignee 时交给它。
 * @param now 此刻（ms）
 * @return 成功时 handedBack 表示这次把 task 交回了
 */
export function editTask(board: Board, input: EditTaskInput, now: number): BoardWrite<{ handedBack: boolean }> {
  const error = editError(board, input);
  if (error) return refuse(board, error, { handedBack: false });
  const next = structuredClone(board);
  const task = findTask(next, input.task)!;
  if (input.title !== null) task.title = input.title.trim();
  if (input.description !== null) task.description = input.description.trim();
  if (dependsOnChanged(task, input.dependsOn)) task.dependsOn = normalizeDeps(input.dependsOn!);
  if (input.assignee !== null) task.assignee = input.assignee;
  const handedBack = task.status === 'waiting_user' || task.status === 'stopped';
  if (handedBack) handBack(next, task, input.assignee !== null, now);
  else settlePending(next, task, now);
  return { board: next, error: null, handedBack };
}

/** @brief 交回 waiting_user、stopped 的 task：持有者为空（停止时还在等依赖）的回到 pending 重新按依赖交出。 */
function handBack(board: Board, task: BoardTask, reassign: boolean, now: number): void {
  patch(task, { question: null, asked: false, stopReason: null });
  const holder = task.holder;
  if (holder === null) {
    task.status = 'pending';
    settlePending(board, task, now);
  } else if (reassign) handToRole(task, task.assignee, now);
  else if (holder.kind === 'role') handToRole(task, holder.role, now);
  else task.status = 'active';
}

/**
 * @brief 留一条消息给 task（agent_message 发到 task，§10.1）：不唤醒任何人；task 已结束时拒绝。
 * @param input task、发送方的角色名、正文（≤ 4000）
 * @param now 此刻（ms）
 */
export function addTaskMessage(board: Board, input: { task: string; from: string; text: string },
  now: number): BoardWrite {
  const error = taskWriteError(board, input.task) ?? requiredTextError('text', input.text, TEXT_LIMITS.agentMessage);
  if (error) return refuse(board, error, {});
  const next = structuredClone(board);
  findTask(next, input.task)!.messages.push({ from: input.from, text: input.text, at: now });
  return { board: next, error: null };
}

// ---- 交接（§7.1、§7.2、§7.4） ----

/** @brief 交出这一棒的会话。 */
export type HandoffSender =
  /** task 实例：它的角色与 task */
  | { kind: 'task'; role: string; task: string }
  /** 结案会话：结案持有者、所属需求，以及这次运行里已经交接过的 task（同一个 task 第二次被拒绝） */
  | { kind: 'close'; role: string; request: number; decided: readonly string[] };

/** @brief task_handoff 的参数（已经归一，证据已由 evidence.ts 核对）。 */
export interface HandoffInput {
  /** 交出这一棒的会话 */
  sender: HandoffSender;
  /** task 编号（task 实例没写时由调用方填它自己的 task） */
  task: string;
  /** 结果 */
  outcome: string;
  /** 结论（1–600）；need_user 时是要用户拿主意的问题 */
  conclusion: string;
  /** 下一棒；没写为 null */
  next: string | null;
  /** 未结事项（≤ 10 条，每条 ≤ 200） */
  openItems: readonly string[];
  /** 合格的证据 */
  evidence: readonly EvidenceRecord[];
  /** 这一棒在实例会话里的位置 */
  session: SessionSpan | null;
  /** 这一棒里产生成功的 edit、write 调用的模型族（§12.9） */
  authorFamilies: readonly string[];
  /** 强制填写的运行（§7.5）：task 实例的交接去向一律是结案，next 记为建议 */
  forced: boolean;
}

/**
 * @brief 记下一棒交接并按 §7.1 的顺序路由（task_handoff）。
 * @param input 交接
 * @param roles 全部角色名（含 mori），next 的取值是它们去掉自己
 * @param now 此刻（ms）
 * @return 成功时 handoff 为记下的一棒
 */
export function recordHandoff(board: Board, input: HandoffInput, roles: readonly string[],
  now: number): BoardWrite<{ handoff: Handoff | null }> {
  const next = input.next?.trim() || null;
  const choices = [...new Set([BASE_ROLE, ...roles])].filter((role) => role !== input.sender.role);
  const error = holdError(board, input) ?? handoffFieldsError(input, next, choices);
  if (error) return refuse(board, error, { handoff: null });
  const result = structuredClone(board);
  const task = findTask(result, input.task)!;
  const route = routeHandoff(input, next);
  const handoff = pushHandoff(task, {
    from: input.sender.kind === 'close' ? `close:${input.sender.role}` : input.sender.role,
    outcome: input.outcome as HandoffOutcome, conclusion: input.conclusion.trim(), next,
    openItems: [...input.openItems],
    evidence: [...input.evidence], session: input.session, routedTo: route.to, reason: null,
    suggestedNext: route.suggested, authorFamilies: [...input.authorFamilies], at: now,
  });
  applyHandoffRoute(result, task, handoff, input.sender);
  return { board: result, error: null, handoff };
}

/** @brief 交接方是否持有这个 task（§6.2 写入与状态表最后两行）。 */
function holdError(board: Board, input: HandoffInput): string | null {
  const { sender } = input;
  if (sender.kind === 'close' && sender.decided.includes(input.task)) return `${input.task} is already decided.`;
  const gate = taskWriteError(board, input.task);
  if (gate) return gate;
  const task = findTask(board, input.task)!;
  if (sender.kind === 'task') {
    const holds = sender.task === task.id && task.status === 'active' && task.holder?.kind === 'role'
      && task.holder.role === sender.role;
    return holds ? null : `You no longer hold ${task.id}; stop working on it.`;
  }
  const withClose = task.request === sender.request && task.status === 'active' && task.holder?.kind === 'close';
  return withClose ? null : `${task.id} is not with you.`;
}

/** @brief 交接单字段的检查（§6.3 的枚举、§7.2）。 */
function handoffFieldsError(input: HandoffInput, next: string | null, choices: readonly string[]): string | null {
  const allowed = input.sender.kind === 'close' ? CLOSE_OUTCOMES : TASK_OUTCOMES;
  if (!(allowed as readonly string[]).includes(input.outcome)) return `outcome must be one of: ${allowed.join(', ')}.`;
  if (input.sender.kind === 'close' && input.outcome === 'continue' && next === null) {
    return 'continue needs next (the role to reassign to).';
  }
  if (next !== null && !choices.includes(next)) {
    return choices.length ? `next must be one of: ${choices.join(', ')}.`
      : 'next is not available: there is no other role.';
  }
  const conclusion = requiredTextError('conclusion', input.conclusion, TEXT_LIMITS.handoffConclusion);
  if (conclusion) return conclusion;
  if (input.openItems.length > TEXT_LIMITS.openItems) {
    return `open_items must have at most ${TEXT_LIMITS.openItems} items.`;
  }
  return input.openItems.some((item) => charCount(item) > TEXT_LIMITS.openItem)
    ? `each of open_items must be at most ${TEXT_LIMITS.openItem} characters.` : null;
}

/** @brief §7.1 的路由表，按顺序；写了却不生效的 next 记为 suggested。 */
function routeHandoff(input: HandoffInput, next: string | null): { to: RoutedTo; suggested: string | null } {
  const outcome = input.outcome as HandoffOutcome;
  if (input.sender.kind === 'close') {
    if (outcome === 'close_done') return { to: { kind: 'end', status: 'done' }, suggested: next };
    if (outcome === 'close_failed') return { to: { kind: 'end', status: 'failed' }, suggested: next };
    if (outcome === 'continue') return { to: { kind: 'role', role: next! }, suggested: null };
    return { to: { kind: 'create' }, suggested: next };
  }
  if (input.forced) return { to: { kind: 'close' }, suggested: next };
  if (outcome === 'need_user') return { to: { kind: 'create' }, suggested: next };
  if (TO_CLOSE_OUTCOMES.includes(outcome)) return { to: { kind: 'close' }, suggested: next };
  if (next !== null) return { to: { kind: 'role', role: next }, suggested: null };
  return { to: { kind: 'close' }, suggested: null };
}

/** @brief 交接写入后 task 的持有者改为去向（§7.1）；结案改派时 assignee 一并改为新的角色。 */
function applyHandoffRoute(board: Board, task: BoardTask, handoff: Handoff, sender: HandoffSender): void {
  const to = handoff.routedTo;
  const asker: Holder = sender.kind === 'close' ? { kind: 'close' } : { kind: 'role', role: sender.role };
  switch (to.kind) {
    case 'role':
      if (sender.kind === 'close') task.assignee = to.role;
      handToRole(task, to.role, handoff.at);
      return;
    case 'close':
      handToClose(task, `${roleLabel(sender.role)} handed it off (${handoff.outcome})`);
      return;
    case 'create':
      askUser(task, handoff.conclusion, asker);
      return;
    case 'end':
      endTask(board, task, to.status, handoff.at);
      settleAll(board, handoff.at);
  }
}

/** @brief 程序写的一棒（§7.4 第 1–3 行、第 5 行，§12.5 结案一行）。 */
export interface ProgramHandoffInput {
  /** task 编号 */
  task: string;
  /** 原因（dependency_failed 由依赖规则自己写） */
  reason: Exclude<HandoffReason, 'dependency_failed'>;
  /** 结论：实例最后一段文字、错误原文、候选被排除的原因，或交给立项的问题；超过 600 截断 */
  conclusion: string;
  /** 兜底时这个 task 的持有者：某个角色的 task 实例交给结案；结案会话交给立项（need_user，结论就是问题） */
  holder: Holder;
  /** 这一棒在实例会话里的位置；task 没运行过时为 null */
  session: SessionSpan | null;
  /** 这一棒里产生成功的 edit、write 调用的模型族 */
  authorFamilies: readonly string[];
}

/**
 * @brief 程序写一棒（from mori、outcome null）：task 实例的兜底交给结案，结案的兜底交给立项（§7.4、§12.5）。
 *        持有者已经变了（例如被停止、被撤销）时拒绝，调用方记日志。
 * @param now 此刻（ms）
 */
export function recordProgramHandoff(board: Board, input: ProgramHandoffInput,
  now: number): BoardWrite<{ handoff: Handoff | null }> {
  const error = taskWriteError(board, input.task) ?? programHoldError(findTask(board, input.task)!, input.holder);
  if (error) return refuse(board, error, { handoff: null });
  const next = structuredClone(board);
  const task = findTask(next, input.task)!;
  const to: RoutedTo = input.holder.kind === 'role' ? { kind: 'close' } : { kind: 'create' };
  const handoff = pushHandoff(task, {
    ...programFields(input.reason, input.conclusion, to, now), session: input.session,
    authorFamilies: [...input.authorFamilies],
  });
  if (input.holder.kind === 'role') handToClose(task, programReasonText(input.reason, input.holder.role));
  else askUser(task, handoff.conclusion, { kind: 'close' });
  return { board: next, error: null, handoff };
}

/** @brief 兜底时 task 仍由那一方持有。 */
function programHoldError(task: BoardTask, holder: Holder): string | null {
  if (task.status !== 'active') return `${task.id} is ${task.status}; nothing to hand off.`;
  const same = holder.kind === 'close' ? task.holder?.kind === 'close'
    : task.holder?.kind === 'role' && task.holder.role === holder.role;
  return same ? null : `${task.id} has moved on; nothing to hand off.`;
}

/** @brief 程序交给结案时的原因（holderReason）。 */
function programReasonText(reason: ProgramHandoffInput['reason'], role: string): string {
  const who = roleLabel(role);
  switch (reason) {
    case 'no_handoff': return `${who} ended without a handoff`;
    case 'error': return `${who}'s run ended with an error`;
    case 'no_model': return `no model available for ${who}`;
    case 'close_undecided': return `${who} didn't decide`;
  }
}

/**
 * @brief 结案没处理交给它的 task、强制填写也没填出来时交给立项的问题（§7.4 最后一行）。
 * @param closeRole 结案持有者
 * @param task task 编号
 */
export function closeUndecidedQuestion(closeRole: string, task: string): string {
  return `${roleLabel(closeRole)} didn't decide on ${task}`;
}

/**
 * @brief 结案选不到模型时交给立项的问题（§12.5）。
 * @param closeRole 结案持有者
 */
export function closeNoModelQuestion(closeRole: string): string {
  return `${roleLabel(closeRole)} can't run: no model available`;
}

/**
 * @brief 结案强制关闭也没关闭需求时的需求级问题（§7.6）。
 * @param request 需求编号
 * @param closeRole 结案持有者
 */
export function notClosedQuestion(request: number, closeRole: string): string {
  return `Request ${request} has no open tasks and ${roleLabel(closeRole)} didn't close it`;
}

// ---- 结案的回合结束（§7.4 最后一行、§7.6） ----

/** @brief 结案会话一次运行结束时要检查的事。 */
export interface CloseRunInput {
  /** 结案会话所属的需求 */
  request: number;
  /** 这次运行开始前就交给结案的 task（运行中才交来的留给下一次运行） */
  heldAtStart: readonly string[];
  /** 这次运行里结案已经交接的 task */
  decided: readonly string[];
  /** 这次运行是因为“全部已结束”或“没有 task”被唤醒的（含 §5.4 兜底表第 3 行的再唤醒） */
  wokenForEnd: boolean;
  /** 这次运行给立项发过消息 */
  messagedCreate: boolean;
}

/**
 * @brief 结案会话的运行结束（不是被停止）时程序要做什么：对没处理的 task 强制填写（§7.4），
 *        需求仍开着、没有未结束的 task、也没请立项建 task（或已经再唤醒过一次）时强制关闭（§7.6）。
 * @return undecided：要强制填写的 task；forceClose：要强制关闭需求
 */
export function closeRunOutcome(board: Board, input: CloseRunInput): { undecided: string[]; forceClose: boolean } {
  const undecided = input.heldAtStart.filter((id) => {
    const task = findTask(board, id);
    return task !== undefined && task.status === 'active' && task.holder?.kind === 'close'
      && !input.decided.includes(id);
  });
  const request = findRequest(board, input.request);
  const forceClose = input.wokenForEnd && request?.status === 'open' && !unfinishedTasks(board, request.no).length
    && (!input.messagedCreate || request.closeRetry);
  return { undecided, forceClose };
}

// ---- 需求级问题与“已问过”（§5.4、§7.6、§11.4） ----

/** @brief 改一个开着的需求；需求不存在或已关闭时原样返回。 */
function withOpenRequest(board: Board, no: number, change: (request: BoardRequest) => void): Board {
  if (requestWriteError(board, no)) return board;
  const next = structuredClone(board);
  change(findRequest(next, no)!);
  return next;
}

/**
 * @brief 写下需求级问题（§7.6 强制关闭也没关闭时），asked 为假；之后的 wakesAfter 唤醒立项。
 * @param question 问题（notClosedQuestion）
 */
export function setRequestQuestion(board: Board, request: number, question: string): Board {
  return withOpenRequest(board, request, (item) => patch(item, { question, asked: false }));
}

/** @brief 清掉需求级问题与 asked（结案会话下一次运行开始时，§7.6）。 */
export function clearRequestQuestion(board: Board, request: number): Board {
  return withOpenRequest(board, request, (item) => patch(item, { question: null, asked: false }));
}

/** @brief 记下“立项没建新 task 时已经再唤醒过结案一次”（§5.4 兜底表第 3 行）。 */
export function markCloseRetry(board: Board, request: number): Board {
  return withOpenRequest(board, request, (item) => patch(item, { closeRetry: true }));
}

/**
 * @brief 标记已经问过用户（转告或程序请对话问你，§5.4），或改回没问过（丢弃的 ask_user、relay，§11.4）。
 *        只改仍在等的：waiting_user 的 task、有问题的需求。
 * @param targets 唤醒那个回合的 task 与需求
 * @param asked 新的取值
 */
export function markAsked(board: Board, targets: { tasks: readonly string[]; requests: readonly number[] },
  asked: boolean): Board {
  const next = structuredClone(board);
  for (const task of next.tasks) {
    if (targets.tasks.includes(task.id) && task.status === 'waiting_user') task.asked = asked;
  }
  for (const request of next.requests) {
    if (targets.requests.includes(request.no) && request.status === 'open' && request.question !== null) {
      request.asked = asked;
    }
  }
  return next;
}

/** @brief 这些需求里还开着、却一个 task 都没有的（§5.4 判断结束时提醒立项）。 */
export function requestsWithoutTasks(board: Board, requests: readonly number[]): number[] {
  return requests.filter((no) => findRequest(board, no)?.status === 'open' && !tasksOf(board, no).length);
}

/** @brief task 都已结束而需求还开着的需求（§11.4、§11.6：下一条用户消息交给立项时同时唤醒结案）。 */
export function requestsAwaitingClose(board: Board): number[] {
  return board.requests.filter((request) => request.status === 'open' && tasksOf(board, request.no).length > 0
    && !unfinishedTasks(board, request.no).length).map((request) => request.no);
}

// ---- 停止与重启（§5.1、§11.4、§11.6） ----

/**
 * @brief 把这些 task 变为 stopped（§9.4 第 0 行、§11.4、§5.1），持有者保留；已结束的不改。
 * @param tasks task 编号
 * @param reason user：你按了停止；restart：App 重启
 */
export function markStopped(board: Board, tasks: readonly string[], reason: 'user' | 'restart'): Board {
  const next = structuredClone(board);
  for (const task of next.tasks) {
    if (tasks.includes(task.id) && !isTaskEnded(task)) patch(task, { status: 'stopped', stopReason: reason });
  }
  return next;
}

/**
 * @brief Stop team 要停下的 task（§11.4）：运行中与排队中的（交给了角色的 active），以及交给结案而结案会话当时
 *        在处理或排队的。
 * @param closeBusy 结案会话正在运行或有排队投递的需求
 */
export function teamStopTargets(board: Board, closeBusy: readonly number[]): string[] {
  return board.tasks.filter((task) => task.status === 'active'
    && (task.holder?.kind === 'role' || closeBusy.includes(task.request))).map((task) => task.id);
}

/** @brief 未关闭需求的全部非终态 task（§5.1：对话被拒绝启动时关掉协作模式，它们变为 stopped）。 */
export function liveTaskIds(board: Board): string[] {
  return board.tasks.filter((task) => !isTaskEnded(task) && findRequest(board, task.request)?.status === 'open')
    .map((task) => task.id);
}

/**
 * @brief 重新打开用户会话时的恢复（§11.6，没有自动恢复）：非终态 task 的 assignee 或持有者不是现在的角色时变为 stopped
 *        （restart），持有者改为结案、holderReason 为 role <name> no longer exists；其余 active 的 task 变为 stopped（restart），
 *        持有者保留；pending、waiting_user、已经 stopped 的不改。
 * @param currentRoles 现在的角色名（mori 总是算在内）
 * @return stopped 为这次变为 stopped 的 task
 */
export function applyRestartRecovery(board: Board,
  currentRoles: readonly string[]): { board: Board; stopped: string[] } {
  const known = new Set([BASE_ROLE, ...currentRoles]);
  const next = structuredClone(board);
  const stopped: string[] = [];
  for (const task of next.tasks) {
    if (isTaskEnded(task)) continue;
    const holderRole = task.holder?.kind === 'role' ? task.holder.role : null;
    const missing = [task.assignee, holderRole].find((role) => role !== null && !known.has(role));
    if (missing) {
      patch(task, {
        status: 'stopped', stopReason: 'restart', holder: { kind: 'close' },
        holderReason: `role ${missing} no longer exists`,
      });
    } else if (task.status === 'active') patch(task, { status: 'stopped', stopReason: 'restart' });
    else continue;
    stopped.push(task.id);
  }
  return { board: stopped.length ? next : board, stopped };
}

// ---- 进展摘要的需求状态（§13.3） ----

/**
 * @brief 进展摘要的需求状态，按 §13.3 的顺序取第一个符合的：终态；Needs your decision（有已问过你的 waiting_user task，
 *        或需求级问题已问你）；Waiting for <create role>（有问题或 waiting_user 还没问你）；Stopped（有 stopped 且没有 active 的）；
 *        With <close role>（task 都已结束、需求还开着）；Running。
 * @param request 需求
 */
export function requestState(board: Board, request: BoardRequest): RequestState {
  if (request.status !== 'open') return request.status;
  const tasks = tasksOf(board, request.no);
  const waiting = tasks.filter((task) => task.status === 'waiting_user');
  if (waiting.some((task) => task.asked) || (request.question !== null && request.asked)) return 'needs_decision';
  if (waiting.length || request.question !== null) return 'waiting_create';
  if (tasks.some((task) => task.status === 'stopped') && !tasks.some((task) => task.status === 'active')) {
    return 'stopped';
  }
  return tasks.every(isTaskEnded) ? 'with_close' : 'running';
}

// ---- 立项的一次判断（§5.4） ----

/** 决定类工具与它定下的决定 */
const DECISION_OF: Partial<Record<TeamToolName, DecisionKind>> = {
  request_submit: 'submit', request_update: 'update', request_cancel: 'cancel', reply_via_dialog: 'reply',
};

/** @brief task_create、task_edit 在本次判断还没记下用户的话时被拒绝（§5.4）。 */
export const RECORD_FIRST = "Record the user's words first (request_submit or request_update).";

/** @brief 程序唤醒的立项回合里 request_submit、request_cancel 被拒绝（§5.4）。 */
export const USER_MESSAGE_ONLY = 'Only a user message can register or cancel a request.';

/** @brief 合并会话的程序唤醒回合里 reply_via_dialog 被拒绝（§5.4）。 */
export const TALK_DIRECTLY = 'You talk to the user directly; say it in your reply.';

/**
 * @brief 决定的英文说法（拒绝另一类决定时写进原因）。
 * @param kind 决定
 */
export function decisionText(kind: DecisionKind): string {
  switch (kind) {
    case 'submit': return 'new request (request_submit)';
    case 'update': return 'supplement (request_update)';
    case 'cancel': return 'cancel (request_cancel)';
    case 'reply': return 'answer directly (reply_via_dialog)';
  }
}

/**
 * @brief 开始一次判断：一条用户消息（合并会话里每条你的消息各算一次），或一次程序唤醒的立项回合。
 * @param user 判断的是用户消息
 * @param merged 合并会话
 */
export function startJudgment(user: boolean, merged: boolean): Judgment {
  return { user, merged, kind: null, recorded: false, registered: [] };
}

/** @brief 这一类决定能否跟在已有的决定之后：同一类可以多次。 */
function conflictError(judgment: Judgment, kind: DecisionKind): string | null {
  return judgment.kind === null || judgment.kind === kind ? null
    : `This message already has a decision: ${decisionText(judgment.kind)}`;
}

/**
 * @brief 立项的工具调用在这次判断里能不能执行（§5.4）：一次判断一种决定；task_create、task_edit 要先记下用户的话
 *        （只交回 stopped、waiting_user 的 task_edit 除外，记为补充）；程序唤醒的回合没有一条消息一个决定的限制，
 *        但 request_submit、request_cancel 被拒绝，合并会话里 reply_via_dialog 被拒绝。
 * @param tool 工具名
 * @param handBackOnly task_edit 是否只交回（isHandBackOnly）
 * @return 可以执行为 null；否则为拒绝的原因
 */
export function judgmentError(judgment: Judgment, tool: TeamToolName, handBackOnly: boolean): string | null {
  if (!judgment.user) {
    if (tool === 'request_submit' || tool === 'request_cancel') return USER_MESSAGE_ONLY;
    return tool === 'reply_via_dialog' && judgment.merged ? TALK_DIRECTLY : null;
  }
  if (tool === 'task_create' || tool === 'task_edit') {
    if (judgment.recorded) return null;
    return tool === 'task_edit' && handBackOnly ? conflictError(judgment, 'update') : RECORD_FIRST;
  }
  const kind = DECISION_OF[tool];
  return kind ? conflictError(judgment, kind) : null;
}

/**
 * @brief 工具执行成功之后记进这次判断：第一个决定类工具定下决定；request_submit、request_update 之后 task 工具可用。
 * @param tool 工具名
 * @param handBackOnly task_edit 是否只交回
 * @param request request_submit 登记的需求编号；其他工具为 null
 */
export function noteJudgment(judgment: Judgment, tool: TeamToolName, handBackOnly: boolean,
  request: number | null): Judgment {
  if (!judgment.user) return judgment;
  const kind = tool === 'task_edit' && handBackOnly && !judgment.recorded ? 'update' : DECISION_OF[tool] ?? null;
  return {
    ...judgment,
    kind: judgment.kind ?? kind,
    recorded: judgment.recorded || tool === 'request_submit' || tool === 'request_update',
    registered: tool === 'request_submit' && request !== null ? [...judgment.registered, request] : judgment.registered,
  };
}

/**
 * @brief 判断结束时的决定：没做任何决定按“不需要协作”（§5.4）。
 */
export function judgmentDecision(judgment: Judgment): DecisionKind {
  return judgment.kind ?? 'reply';
}

// ---- board.json（§3） ----

/**
 * @brief 读一个用户会话的 TaskBoard；文件不存在时为一块空的。读不出或格式不对时记错误日志并抛出（不丢弃已有的 TaskBoard）。
 * @param dir <userData>/teams/<用户会话 id>
 */
export async function loadBoard(dir: string): Promise<Board> {
  const path = join(dir, BOARD_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return newBoard();
    console.error(`[kernel] cannot read ${path}: ${(error as Error).message}`);
    throw error;
  }
  const parsed = BoardSchema.safeParse(parseJson(path, text));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  console.error(`[kernel] ${path} is not a valid TaskBoard: ${issues}`);
  throw new Error(`${path} is not a valid TaskBoard: ${issues}`);
}

/** @brief 解析 JSON；不是 JSON 时记错误日志并抛出。 */
function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`[kernel] ${path} is not valid JSON: ${(error as Error).message}`);
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * @brief 整体写出 board.json：先写临时文件再改名（§3），目录不存在时先创建；失败时记错误日志并抛出。
 * @param dir <userData>/teams/<用户会话 id>
 */
export async function saveBoard(dir: string, board: Board): Promise<void> {
  const path = join(dir, BOARD_FILE);
  try {
    await writeFileAtomic(path, `${JSON.stringify(board, null, 2)}\n`);
  } catch (error) {
    console.error(`[kernel] cannot write ${path}: ${(error as Error).message}`);
    throw error;
  }
}
