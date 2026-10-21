// TaskBoard 工具的执行（docs/specs/parallel-agents-taskboard.md §5.4、§6.2–§6.4、§7.1–§7.3、§7.6、§7.7、§10.1、§10.2）：
// board_read、read_session、agent_message（发到 task、进座位会话、临时提问，等回复）、task_handoff（task 实例与结案会话）、
// request_close，以及立项持有者的六个工具（一次判断一种决定，§5.4）。参数已由 boardTools.prepareToolArgs 归一、经 pi 校验；
// 被拒绝时返回原因，boardTools 写成两行（§6.2）。强制填写的运行里表单工具的结果总带 terminate（§7.5 第 1 步）。

import { readFile } from 'node:fs/promises';
import {
  cancelRequest, closeRequest, createTask, editTask, findRequest, findTask, isHandBackOnly, judgmentError, markAsked,
  noteJudgment, recordHandoff, startJudgment, submitRequest, updateRequest, addTaskMessage, type EditTaskInput,
  type UserWords,
} from './board';
import { routeAgentMessage } from './boardRoute';
import { boardReadText, USER_ANSWERED, type LiveTask } from './boardText';
import type { BoardToolCall, BoardToolReply } from './boardTools';
import { authorCheck, evidenceRejection, outcomeEvidenceError, parseEvidence, verifyEvidence } from './evidence';
import type { HandoffForm } from './handoffForm';
import { loadPi } from './pi';
import { entryMessage, messageText, readSessionText, type SessionEntryLike } from './sessionReader';
import type { Team } from './team';
import { LANE_IDS, newLane, type DeliveryMeta, type Lane, type Waiter } from './teamLanes';
import { STOPPED_BY_USER, batonOf } from './teamRuns';
import type { MessageRoute, MessageSender } from './teamTypes';
import {
  TEAM_ENTRY_TYPES, TEXT_LIMITS, roleLabel, seatRolesOf, type HandoffOutcome, type TeamToolName,
} from '../shared/team';

/** @brief 成功。 */
function ok(text: string): BoardToolReply {
  return { ok: true, text };
}

/** @brief 规则不允许（§6.2：第二行加正确的写法）。 */
function refused(reason: string): BoardToolReply {
  return { ok: false, reason, usage: true };
}

/** @brief 不是写法错误的失败（停止、选不到模型、出错）。 */
function failed(reason: string): BoardToolReply {
  return { ok: false, reason, usage: false };
}

/** @brief 字符串参数；没写时为 null。 */
function str(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' ? value : null;
}

/** @brief 整数参数；没写时为 null。 */
function int(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** @brief 字符串列表参数；没写时为 null。 */
function list(args: Record<string, unknown>, name: string): string[] | null {
  const value = args[name];
  return Array.isArray(value) ? value.map((item) => String(item)) : null;
}

/**
 * @brief 执行一个 TaskBoard 工具（boardTools.BoardToolExecutor 的实现）。强制填写的运行里表单工具的结果总带 terminate，
 *        被拒绝的原因记下来交给格式重试（§7.5 第 1、3 步）。
 * @param team 协作
 * @param lane 调用它的会话
 * @param name 工具名
 * @param args 参数
 * @param call toolCallId 与中止信号
 */
export async function runTool(team: Team, lane: Lane, name: TeamToolName, args: Record<string, unknown>,
  call: BoardToolCall): Promise<BoardToolReply> {
  const forced = lane.run?.forced ?? null;
  const reply = await dispatch(team, lane, name, args, call);
  if (forced === null || name !== forced.form.tool) return reply;
  if (!reply.ok && lane.run) lane.run.formError = reply.reason;
  return { ...reply, terminate: true };
}

/** @brief 按工具名执行。 */
async function dispatch(team: Team, lane: Lane, name: TeamToolName, args: Record<string, unknown>,
  call: BoardToolCall): Promise<BoardToolReply> {
  switch (name) {
    case 'board_read': return boardRead(team, args);
    case 'read_session': return readSession(team, lane, args);
    case 'agent_message': return agentMessage(team, lane, args, call);
    case 'task_handoff': return lane.kind === 'close' ? executeCloseHandoff(team, lane, args)
      : executeTaskHandoff(team, lane, args, lane.run?.forced != null);
    case 'request_close': return executeRequestClose(team, lane, args);
    default: return createTool(team, lane, name, args);
  }
}

// ---- board_read（§6.4） ----

/** @brief board_read：不带参数读整块板，带 request 读一个需求，带 task 读一个 task 与全部交接；只读，不唤醒。 */
function boardRead(team: Team, args: Record<string, unknown>): BoardToolReply {
  const task = str(args, 'task') ?? undefined;
  const request = int(args, 'request') ?? undefined;
  const live = new Map<string, LiveTask>();
  for (const view of team.view().requests.flatMap((item) => item.tasks)) {
    live.set(view.id, { phase: view.phase, current: view.current, waitingFor: view.waitingFor });
  }
  const text = boardReadText(team.board, { task, request }, { now: Date.now(), mode: team.mode,
    holders: team.holders, cwd: team.args.cwd, live });
  if (text !== null) return ok(text);
  return refused(task !== undefined ? `${task} does not exist.` : `Request ${request} does not exist.`);
}

// ---- read_session（§10.2） ----

/** @brief role 省略时：这个 task 上最近一棒 task 实例交接的角色（不是自己时）；没有时为 null。 */
function defaultReadRole(team: Team, task: string, self: string): string | null {
  const last = findTask(team.board, task)?.handoffs.findLast((handoff) => handoff.outcome !== null
    && !handoff.from.startsWith('close:'));
  return last && last.from !== self ? last.from : null;
}

/** @brief 读一个没开着的实例会话文件（pi 的纯读取路径，不写文件，§14.5）。 */
async function readClosedSession(team: Team, file: string): Promise<SessionEntryLike[]> {
  const pi = await loadPi();
  const entries = pi.parseSessionEntries(await readFile(file, 'utf8'));
  return pi.SessionManager.inMemory(team.args.cwd, undefined, entries).getBranch() as SessionEntryLike[];
}

/**
 * @brief read_session：读这块 TaskBoard 上某个 task、某个角色的 task 实例会话（整理过的文本，第一行标明是资料）；
 *        读不到对话、立项、结案、临时提问、订阅的会话。实例正在运行时只给已完成的回合。
 */
async function readSession(team: Team, lane: Lane, args: Record<string, unknown>): Promise<BoardToolReply> {
  const task = str(args, 'task') ?? '';
  if (!findTask(team.board, task)) return refused(`${task} does not exist.`);
  const role = str(args, 'role')?.trim().toLowerCase() || defaultReadRole(team, task, lane.role);
  if (role === null) return refused(`Say whose session on ${task} to read (role).`);
  const ids = LANE_IDS.task(team.userId, task, role);
  const target = team.lanes.get(ids.key);
  const open = target?.open === true && team.host.entry(ids.id) !== null;
  const file = target?.file ?? team.knownFiles.get(ids.id) ?? null;
  if (!open && file === null) return refused(`${roleLabel(role)} has no session on ${task}.`);
  try {
    const entries = open && target ? team.branchOf(target) : await readClosedSession(team, file as string);
    const running = target?.busy === true && target.started;
    return ok(readSessionText(entries, { task, role, from: int(args, 'from') ?? undefined,
      to: int(args, 'to') ?? undefined, running, cwd: team.args.cwd,
      seatRoles: seatRolesOf({ mode: team.mode, holders: team.holders }) }));
  } catch (error) {
    console.error(`[kernel] read_session ${task} ${role} failed: ${(error as Error).message}`);
    return failed(`Cannot read ${roleLabel(role)}'s session on ${task}: ${(error as Error).message}`);
  }
}

// ---- agent_message（§10.1） ----

/** @brief 发送方所在的需求：task 实例的 task 所属的需求、结案会话与订阅的需求；对话、立项、临时提问为 null。 */
function senderRequest(team: Team, lane: Lane): number | null {
  if (lane.kind === 'task') return findTask(team.board, lane.task ?? '')?.request ?? lane.request;
  return lane.kind === 'close' || lane.kind === 'subscription' ? lane.request : null;
}

/** @brief 发送方的描述（boardRoute.routeAgentMessage 的输入）。 */
function senderOf(team: Team, lane: Lane): MessageSender {
  return { kind: lane.kind === 'user' ? 'dialog' : lane.kind, role: lane.role, request: senderRequest(team, lane),
    session: lane.key };
}

/**
 * @brief agent_message：协作模式下发到 task 留在 task 上（不唤醒任何人），发给角色进座位会话或开临时提问；
 *        关闭模式下一律开临时提问。条数上限、不能发给自己、互相等待由 boardRoute 判断。
 */
async function agentMessage(team: Team, lane: Lane, args: Record<string, unknown>,
  call: BoardToolCall): Promise<BoardToolReply> {
  const text = str(args, 'text') ?? '';
  if (!text.trim() || [...text].length > TEXT_LIMITS.agentMessage) {
    return refused(`text must be 1–${TEXT_LIMITS.agentMessage} characters.`);
  }
  const mode = lane === team.user ? lane.run?.mode ?? team.mode : lane.team ? 'always' : 'off';
  const routed = routeAgentMessage({ mode, sender: senderOf(team, lane), to: str(args, 'to') ?? '',
    request: int(args, 'request'), holders: team.holders, roles: team.roleNames, board: team.board, waits: team.waits,
    sent: team.sent, sentThisTurn: lane.sentThisTurn });
  if (routed.error !== null || routed.route === null) return refused(routed.error ?? 'The message has no recipient.');
  if (routed.countKey !== null) team.sent.set(routed.countKey, (team.sent.get(routed.countKey) ?? 0) + 1);
  const route = routed.route;
  if (route.kind === 'task') {
    const result = team.write((board) => addTaskMessage(board, { task: route.task, from: lane.role, text },
      Date.now()));
    return result.error ? refused(result.error) : ok(`Left the message on ${route.task}.`);
  }
  if (route.kind === 'ask') return askRole(team, lane, { role: route.role, text, team: mode !== 'off' }, call);
  return seatMessage(team, lane, route, { text, wait: args.wait === true }, call);
}

/**
 * @brief 等一次投递所在运行的回复（§10.1）；发送方的运行被停止时立即以 Stopped by the user. 结束（§14.2、§14.6 T-S4）。
 * @param meta 投递的 meta（waiter 写在这里）
 * @param signal 发送方这次运行的中止信号
 */
function waitForReply(meta: DeliveryMeta, signal: AbortSignal | undefined): Promise<{ text: string; error: boolean }> {
  return new Promise((resolve) => {
    const done = (text: string, error: boolean): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ text, error });
    };
    const onAbort = (): void => {
      meta.waiter = undefined;
      done(STOPPED_BY_USER, true);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    meta.waiter = { settle: done };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** @brief 发进座位会话（立项或某个需求的结案会话）；wait 时等处理它的那次运行的最后一段文字（§10.1）。 */
async function seatMessage(team: Team, lane: Lane, route: Extract<MessageRoute, { kind: 'create' | 'close' }>,
  message: { text: string; wait: boolean }, call: BoardToolCall): Promise<BoardToolReply> {
  const role = route.kind === 'create' ? team.holders.create : team.holders.close;
  const target = route.kind === 'create' ? team.createLane() : team.closeLane(route.request);
  const meta: DeliveryMeta = lane.kind === 'close' && route.kind === 'create' && lane.request !== null
    ? { closeAsk: lane.request } : {};
  const delivery = team.delivery('agent_message', { from: lane.role, text: message.text }, { kind: 'message' }, meta);
  const reply = message.wait ? waitForReply(meta, call.signal) : null;
  if (reply) team.waits.set(lane.key, target.key);
  if (route.kind === 'create') team.enqueueCreate(delivery);
  else team.enqueue(target, delivery);
  if (lane.run && route.kind === 'create' && lane.kind === 'close') lane.run.messagedCreate = true;
  if (lane.run && route.kind === 'close') lane.run.messagedClose.push(route.request);
  if (!reply) return ok(`Delivered to ${roleLabel(role)}.`);
  const result = await reply;
  team.waits.delete(lane.key);
  return result.error ? failed(result.text) : ok(`${roleLabel(role)} replied: ${result.text}`);
}

/**
 * @brief 开一个临时提问实例（只读，回答完就结束），等它的回答（§10.1）。关闭模式下对话每回合的条数另计。
 * @param question 被问的角色、问题、是否在协作模式下
 */
async function askRole(team: Team, lane: Lane, question: { role: string; text: string; team: boolean },
  call: BoardToolCall): Promise<BoardToolReply> {
  const n = team.board.nextAsk;
  team.write((board) => ({ board: { ...board, nextAsk: board.nextAsk + 1 }, error: null }));
  const ask = newLane({ ...LANE_IDS.ask(team.userId, n, question.role), kind: 'ask', role: question.role, task: null,
    request: senderRequest(team, lane), readOnly: true, team: question.team });
  ask.parent = lane.key;
  team.lanes.set(ask.key, ask);
  if (!question.team) lane.sentThisTurn += 1;
  const answer = new Promise<{ text: string; error: boolean }>((resolve) => {
    const asker: Waiter = { settle: (text, error) => resolve({ text, error }) };
    ask.asker = asker;
    call.signal?.addEventListener('abort', () => {
      if (ask.asker !== asker) return;
      ask.asker = null;
      resolve({ text: STOPPED_BY_USER, error: true });
      void team.stopLane(ask, lane === team.user ? 'dialog' : 'user');
    }, { once: true });
  });
  team.enqueue(ask, team.delivery('ask', { from: lane.role, text: question.text }, { kind: 'message' }));
  const result = await answer;
  return result.error ? failed(result.text) : ok(result.text);
}

// ---- task_handoff 与 request_close（§7.1–§7.3、§7.6） ----

/**
 * @brief task 实例的交接（§7.1–§7.3）：证据必须是这个实例会话里已经结束的工具调用，done、pass 至少一个 ok 的证据，
 *        改过代码的实例不能写 pass；会话位置与 authorFamilies 由程序填。成功后这一棒结束，结果带 terminate（§7.1）。
 *        强制填写的运行里去向一律是结案（§7.4 第 1 行）。B、C 级解析出的参数也走这里（§7.5）。
 * @param team 协作
 * @param lane task 实例
 * @param args 参数（task 没写时为这个实例的 task）
 * @param forced 强制填写的运行（去向一律是结案）
 */
export async function executeTaskHandoff(team: Team, lane: Lane, args: Record<string, unknown>,
  forced: boolean): Promise<BoardToolReply> {
  const task = str(args, 'task') ?? lane.task ?? '';
  const outcome = str(args, 'outcome') ?? '';
  const entries = team.branchOf(lane);
  const context = team.titleContext(lane);
  const parsed = parseEvidence(list(args, 'evidence') ?? []);
  const check = verifyEvidence(entries, parsed.tags, context);
  if (parsed.invalid.length || check.bad.length) return failed(evidenceRejection([...parsed.invalid, ...check.bad],
    check.recent));
  const rule = outcomeEvidenceError(outcome as HandoffOutcome, check.ok, authorCheck(entries, context), task);
  if (rule) return refused(rule);
  const baton = batonOf(team, lane);
  const result = team.write((board) => recordHandoff(board, {
    sender: { kind: 'task', role: lane.role, task: lane.task ?? '' }, task, outcome,
    conclusion: str(args, 'conclusion') ?? '', next: str(args, 'next'), openItems: list(args, 'open_items') ?? [],
    evidence: check.ok, session: baton.session, authorFamilies: baton.families, forced,
  }, team.roleNames, Date.now()));
  if (result.error || !result.handoff) return refused(result.error ?? 'The handoff was not recorded.');
  if (lane.run) lane.run.handedOff = task;
  lane.batonStart = null;
  return { ok: true, text: `Handed off ${task} (${outcome}) to ${routeText(team, result.handoff.routedTo)}.`,
    terminate: true };
}

/** @brief 去向的文字。 */
function routeText(team: Team, route: NonNullable<ReturnType<typeof recordHandoff>['handoff']>['routedTo']): string {
  switch (route.kind) {
    case 'role': return roleLabel(route.role);
    case 'close': return `${roleLabel(team.holders.close)} (closing)`;
    case 'create': return `${roleLabel(team.holders.create)} (a user decision)`;
    case 'end': return `the end (${route.status})`;
  }
}

/**
 * @brief 结案会话的交接（§7.1 最后两行）：逐个处理交给它的 task，同一次运行里同一个 task 第二次被拒绝；不带证据，不带 terminate。
 * @param team 协作
 * @param lane 结案会话
 * @param args 参数
 */
export function executeCloseHandoff(team: Team, lane: Lane, args: Record<string, unknown>): BoardToolReply {
  const task = str(args, 'task') ?? '';
  const outcome = str(args, 'outcome') ?? '';
  const decided = lane.run?.decided ?? [];
  const result = team.write((board) => recordHandoff(board, {
    sender: { kind: 'close', role: lane.role, request: lane.request ?? 0, decided }, task, outcome,
    conclusion: str(args, 'conclusion') ?? '', next: str(args, 'next'), openItems: [], evidence: [], session: null,
    authorFamilies: [], forced: false,
  }, team.roleNames, Date.now()));
  if (result.error || !result.handoff) return refused(result.error ?? 'The decision was not recorded.');
  lane.run?.decided.push(task);
  return ok(`Decided ${task} (${outcome}): ${routeText(team, result.handoff.routedTo)}.`);
}

/**
 * @brief request_close（§7.6）：只在这个需求下全部 task 已结束时可用；写下状态、结论与关闭时刻。
 * @param team 协作
 * @param lane 结案会话
 * @param args 参数
 */
export function executeRequestClose(team: Team, lane: Lane, args: Record<string, unknown>): BoardToolReply {
  const request = int(args, 'request') ?? 0;
  const outcome = str(args, 'outcome') ?? '';
  const result = team.write((board) => closeRequest(board, { request, outcome,
    conclusion: str(args, 'conclusion') ?? '', closer: lane.request ?? 0 }, Date.now()));
  return result.error ? refused(result.error) : ok(`Request ${request} closed (${outcome}).`);
}

/**
 * @brief 强制填写的表单里这个会话可以写的 next（投递文字里列出，§7.5）。
 * @param form 表单
 */
export function nextRoleNames(form: HandoffForm): string[] {
  return form.next.map((role) => role.name);
}

// ---- 立项持有者的工具（§5.4、§7.6、§7.7） ----

/** @brief 这个用户会话里你的全部消息原文（核对 quote，§5.4；程序投递的消息不算）。 */
function userMessages(team: Team): string[] {
  const entries = team.branchOf(team.user);
  const wakes = new Set(entries.filter((entry) => entry.type === 'custom' && entry.customType === TEAM_ENTRY_TYPES.wake)
    .map((entry) => String((entry.data as { messageId?: unknown } | undefined)?.messageId)));
  return entries.filter((entry) => !wakes.has(entry.id) && entryMessage(entry)?.role === 'user')
    .map((entry) => messageText(entryMessage(entry) as NonNullable<ReturnType<typeof entryMessage>>));
}

/** @brief task_edit 的参数。 */
function editInput(args: Record<string, unknown>): EditTaskInput {
  return { task: str(args, 'task') ?? '', title: str(args, 'title'), description: str(args, 'description'),
    assignee: str(args, 'assignee'), dependsOn: list(args, 'depends_on') };
}

/**
 * @brief 立项持有者的工具：先按这次判断的规则检查（一次判断一种决定、先记用户的原话、程序唤醒的回合不能登记或撤销），
 *        再写 TaskBoard；登记、补充、撤销写回执（§13.2）。
 */
function createTool(team: Team, lane: Lane, name: TeamToolName, args: Record<string, unknown>): BoardToolReply {
  const run = lane.run;
  const judgment = run?.judgment ?? startJudgment(false, lane === team.user);
  if (run && !run.judgment) run.judgment = judgment;
  const handBackOnly = name === 'task_edit' && isHandBackOnly(team.board, editInput(args));
  const error = judgmentError(judgment, name, handBackOnly);
  if (error) return refused(error);
  const words: UserWords = { message: judgment.user ? run?.judgedText ?? null : null, history: userMessages(team) };
  const result = performCreate(team, lane, name, args, words);
  if (result.reply.ok && run) run.judgment = noteJudgment(judgment, name, handBackOnly, result.request);
  return result.reply;
}

/** @brief 立项工具的写入与回执。 */
function performCreate(team: Team, lane: Lane, name: TeamToolName, args: Record<string, unknown>,
  words: UserWords): { reply: BoardToolReply; request: number | null } {
  const now = Date.now();
  switch (name) {
    case 'request_submit': {
      const result = team.write((board) => submitRequest(board, { title: str(args, 'title') ?? '',
        goal: str(args, 'goal') ?? '', acceptance: str(args, 'acceptance'), quote: str(args, 'quote') }, words, now));
      if (result.error || result.request === null) {
        return { reply: refused(result.error ?? 'The request was not registered.'), request: null };
      }
      const title = findRequest(team.board, result.request)?.title ?? '';
      team.receipt(lane, { kind: 'registered', request: result.request, title, quote: null, at: now });
      return { reply: ok(`Registered request ${result.request}: ${title}. Split it into tasks with task_create.`),
        request: result.request };
    }
    case 'request_update': return { reply: updateTool(team, lane, args, words), request: null };
    case 'request_cancel': return { reply: cancelTool(team, lane, args), request: null };
    case 'task_create': return { reply: createTaskTool(team, args), request: null };
    case 'task_edit': return { reply: editTaskTool(team, args), request: null };
    default: return { reply: replyTool(team, lane, args), request: null };
  }
}

/** @brief request_update：把你的补充、约束原话记到需求上，写回执 Added to request N（§5.4、§13.2）。 */
function updateTool(team: Team, lane: Lane, args: Record<string, unknown>, words: UserWords): BoardToolReply {
  const request = int(args, 'request') ?? 0;
  const now = Date.now();
  const result = team.write((board) => updateRequest(board, { request, quote: str(args, 'quote') }, words, now));
  if (result.error || result.quote === null) return refused(result.error ?? 'Not recorded.');
  const title = findRequest(team.board, request)?.title ?? '';
  team.receipt(lane, { kind: 'added', request, title, quote: result.quote, at: now });
  return ok(`Added to request ${request}: "${result.quote}"`);
}

/**
 * @brief request_cancel（§7.6）：这个需求下运行中的实例被停止（先记下原因 cancel），非终态的 task 变为 cancelled，
 *        释放写入锁，需求 cancelled；不唤醒结案，也不另外唤醒对话。写回执 Request N cancelled。
 */
function cancelTool(team: Team, lane: Lane, args: Record<string, unknown>): BoardToolReply {
  const request = int(args, 'request') ?? 0;
  const now = Date.now();
  const result = team.write((board) => cancelRequest(board, { request, reason: str(args, 'reason') }, now));
  if (result.error) return refused(result.error);
  for (const other of team.lanes.values()) {
    if (other.request !== request || (other.kind !== 'task' && other.kind !== 'close')) continue;
    other.queue = [];
    other.solo = [];
    void team.stopLane(other, 'cancel');
    team.releaseIfDone(other);
  }
  const title = findRequest(team.board, request)?.title ?? '';
  team.receipt(lane, { kind: 'cancelled', request, title, quote: null, at: now });
  const tasks = result.cancelled.length ? `; cancelled ${result.cancelled.join(', ')}` : '';
  return ok(`Request ${request} cancelled${tasks}.`);
}

/** @brief task_create（§6.2、§9.3）：依赖都完成时直接交给 assignee，已经有一个失败时交给结案。 */
function createTaskTool(team: Team, args: Record<string, unknown>): BoardToolReply {
  const assignee = str(args, 'assignee') ?? '';
  const result = team.write((board) => createTask(board, { request: int(args, 'request') ?? 0,
    title: str(args, 'title') ?? '', description: str(args, 'description') ?? '', assignee,
    readOnly: args.read_only === true, dependsOn: list(args, 'depends_on') ?? [] }, Date.now()));
  if (result.error || result.task === null) return refused(result.error ?? 'The task was not created.');
  return ok(`Created ${result.task} for ${roleLabel(assignee)}.`);
}

/** @brief task_edit（§6.2、§7.7 第 4 步）：等用户决定或已停止的 task 同时交回。 */
function editTaskTool(team: Team, args: Record<string, unknown>): BoardToolReply {
  const input = editInput(args);
  const before = findTask(team.board, input.task)?.status;
  const result = team.write((board) => editTask(board, input, Date.now()));
  if (result.error) return refused(result.error);
  if (result.handedBack && before === 'waiting_user') team.backReasons.set(input.task, USER_ANSWERED);
  return ok(`Edited ${input.task}${result.handedBack ? ' and handed it back' : ''}.`);
}

/**
 * @brief reply_via_dialog（§5.4）：判断你的消息时表示不需要协作；程序唤醒的回合里（分开时）带 note 时唤醒对话转告你，
 *        唤醒这个回合的 waiting_user task 与需求级问题都标 asked。
 */
function replyTool(team: Team, lane: Lane, args: Record<string, unknown>): BoardToolReply {
  const note = str(args, 'note')?.trim() ?? '';
  if ([...note].length > TEXT_LIMITS.note) return refused(`note must be at most ${TEXT_LIMITS.note} characters.`);
  const run = lane.run;
  if (!run || run.judgment?.user !== false || team.merged || !note) {
    return ok('The dialog agent answers the user directly.');
  }
  const causes = run.batch.map((item) => item.cause);
  const asked = { tasks: causes.flatMap((cause) => (cause.kind === 'need_user' ? [cause.task] : [])),
    requests: causes.flatMap((cause) => (cause.kind === 'question' ? [cause.request] : [])) };
  team.write((board) => ({ board: markAsked(board, asked, true), error: null }));
  run.relayed = true;
  team.enqueueUser(team.delivery('relay', { createRole: team.holders.create, note },
    { kind: 'ask_user', tasks: [], requests: [] }, { asked }), 'relay');
  return ok('The dialog agent will tell the user.');
}
