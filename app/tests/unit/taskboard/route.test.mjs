// kernel/boardRoute.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §8.2、§9.1、§9.2、§9.5、§10.1）：
// 同时运行上限与写入锁、留给 task 的消息、Agent 消息的去向（座位会话、临时提问、互相等待、上限）、订阅的过滤与唤醒、
// 投递队列的合并与过期。时刻一律由测试给出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const B = await loadKernelModule('src/kernel/board.ts');
const R = await loadKernelModule('src/kernel/boardRoute.ts');

const ROLES = ['mori', 'chat', 'planner', 'executor', 'reviewer', 'memory'];

/** 写入成功，返回新的 TaskBoard。 */
function ok(result) {
  assert.equal(result.error, null);
  return result.board;
}

/** 有 n 个需求的 TaskBoard。 */
function requests(n) {
  let board = B.newBoard();
  for (let i = 1; i <= n; i += 1) {
    board = ok(B.submitRequest(board, { title: `Request ${i}`, goal: 'Goal', acceptance: null, quote: null },
      { message: `message ${i}`, history: [] }, 1000 + i));
  }
  return board;
}

/** 在需求 1 建一个 task；readyAt 就是 now。 */
function create(board, over = {}, now = 2000) {
  return ok(B.createTask(board, { request: 1, title: 'Task', description: 'Do it', assignee: 'executor',
    readOnly: false, dependsOn: [], ...over }, now));
}

/** task 实例的一棒交接。 */
function handoff(board, role, task, outcome, over = {}, now = 3000) {
  return ok(B.recordHandoff(board, { sender: { kind: 'task', role, task }, task, outcome, conclusion: 'Done',
    next: null, openItems: [], evidence: [], session: null, authorFamilies: [], forced: false, ...over }, ROLES, now));
}

/** 结案会话的一棒交接。 */
function closeHandoff(board, task, outcome, over = {}, now = 4000) {
  return ok(B.recordHandoff(board, { sender: { kind: 'close', role: 'planner', request: 1, decided: [] }, task,
    outcome, conclusion: 'Closed', next: null, openItems: [], evidence: [], session: null, authorFamilies: [],
    forced: false, ...over }, ROLES, now));
}

/** 正在跑的 task 实例。 */
const running = (task, role = 'executor') => ({ kind: 'task', role, task });

// ---- TB-22 同时运行上限 ----

test('TB-22 the fifth instance is queued and starts after one of the first four ends, in order', () => {
  let board = requests(1);
  for (let i = 1; i <= 6; i += 1) board = create(board, { readOnly: true, title: `T${i}` }, 2000 + (7 - i) * 10);
  const first = R.scheduleStarts(board, []);
  assert.deepEqual(first.starts.map((item) => item.task), ['T6', 'T5', 'T4', 'T3'], 'first come, first started');
  assert.deepEqual(first.waiting, [
    { task: 'T2', phase: 'queued', lockHolder: null }, { task: 'T1', phase: 'queued', lockHolder: null }]);
  assert.equal(R.RUN_CAP, 4);
  const full = ['T6', 'T5', 'T4', 'T3'].map((id) => running(id));
  assert.deepEqual(R.scheduleStarts(board, full).starts, []);
  board = handoff(board, 'executor', 'T6', 'done');
  const oneEnded = R.scheduleStarts(board, full.slice(1));
  assert.deepEqual(oneEnded.starts, [{ task: 'T2', role: 'executor' }]);
  assert.deepEqual(oneEnded.waiting, [{ task: 'T1', phase: 'queued', lockHolder: null }]);
});

test('TB-22 the cap counts task and subscription instances only; subscriptions queue with tasks by readyAt', () => {
  let board = requests(1);
  board = create(board, { readOnly: true }, 2000);
  board = create(board, { readOnly: true }, 2100);
  const others = ['create', 'close', 'ask'].map((kind) => ({ kind, role: 'planner', task: null }));
  const subs = [{ id: 'memory@1', readyAt: 2050 }, { id: 'auditor@1', readyAt: 2200 }];
  const result = R.scheduleStarts(board, [...others, { kind: 'subscription', role: 'memory', task: null }], 3, subs);
  assert.deepEqual(result.starts, [{ task: 'T1', role: 'executor' }]);
  assert.deepEqual(result.subscriptions, ['memory@1']);
  assert.deepEqual(result.waiting, [{ task: 'T2', phase: 'queued', lockHolder: null }]);
  assert.deepEqual(R.scheduleStarts(board, [], 4, subs).subscriptions, ['memory@1', 'auditor@1']);
});

test('TB-22 a task with a running instance does not start another; tasks with close or pending are not scheduled',
  () => {
  let board = requests(1);
  board = create(board, { readOnly: true });
  board = handoff(board, 'executor', 'T1', 'continue', { next: 'reviewer' });
  assert.deepEqual(R.scheduleStarts(board, [running('T1')]).starts, [], 'the executor run is still ending');
  assert.deepEqual(R.scheduleStarts(board, []).starts, [{ task: 'T1', role: 'reviewer' }]);
  board = create(board, { readOnly: true, dependsOn: ['T1'] });
  board = handoff(board, 'reviewer', 'T1', 'pass');
  const result = R.scheduleStarts(board, []);
  assert.deepEqual([result.starts, result.waiting], [[], []]);
});

// ---- TB-23 写入排队 ----

test('TB-23 two write tasks do not run at the same time: the second waits for the lock', () => {
  let board = requests(1);
  board = create(board, {}, 2000);
  board = create(board, {}, 2100);
  const result = R.scheduleStarts(board, []);
  assert.deepEqual(result.starts, [{ task: 'T1', role: 'executor' }]);
  assert.equal(result.board.lock, 'T1');
  assert.equal(board.lock, null, 'the input board is not changed');
  assert.deepEqual(result.waiting, [{ task: 'T2', phase: 'lock_wait', lockHolder: 'T1' }]);
  const again = R.scheduleStarts(result.board, [running('T1')]);
  assert.equal(again.board, result.board, 'no change, same board');
  assert.deepEqual(again.waiting, [{ task: 'T2', phase: 'lock_wait', lockHolder: 'T1' }]);
});

test('TB-23 the lock stays through review, a user question and a stop, and is released when the task ends', () => {
  let board = requests(1);
  board = create(board, {}, 2000);
  board = create(board, {}, 2100);
  board = R.scheduleStarts(board, []).board;
  board = handoff(board, 'executor', 'T1', 'continue', { next: 'reviewer' });
  let result = R.scheduleStarts(board, []);
  assert.deepEqual(result.starts, [{ task: 'T1', role: 'reviewer' }], 'the reviewer works under the same lock');
  assert.deepEqual(result.waiting, [{ task: 'T2', phase: 'lock_wait', lockHolder: 'T1' }]);
  board = handoff(board, 'reviewer', 'T1', 'need_user', { conclusion: 'Q?' });
  assert.equal(board.lock, 'T1');
  assert.deepEqual(R.scheduleStarts(board, []).starts, []);
  board = B.markStopped(board, ['T1'], 'user');
  assert.equal(board.lock, 'T1');
  board = ok(B.editTask(board, { task: 'T1', title: null, description: null, assignee: null, dependsOn: null }, 5000));
  board = handoff(board, 'reviewer', 'T1', 'pass', {}, 5100);
  board = closeHandoff(board, 'T1', 'close_done', {}, 5200);
  assert.equal(board.lock, null);
  result = R.scheduleStarts(board, []);
  assert.deepEqual([result.starts, result.board.lock], [[{ task: 'T2', role: 'executor' }], 'T2']);
});

test('TB-23 read-only tasks run beside a write task and never take the lock', () => {
  let board = requests(1);
  board = create(board, {}, 2000);
  board = create(board, { readOnly: true, assignee: 'reviewer' }, 2100);
  board = create(board, {}, 2200);
  board = create(board, { readOnly: true }, 2300);
  const result = R.scheduleStarts(board, []);
  assert.deepEqual(result.starts.map((item) => item.task), ['T1', 'T2', 'T4']);
  assert.deepEqual(result.waiting, [{ task: 'T3', phase: 'lock_wait', lockHolder: 'T1' }]);
  const readOnlyOnly = R.scheduleStarts(create(requests(1), { readOnly: true }), []);
  assert.equal(readOnlyOnly.board.lock, null);
});

// ---- Agent 消息的输入 ----

const PLANNER = { dialog: 'chat', create: 'planner', close: 'planner' };

/** routeAgentMessage 的输入（默认协作模式、executor 在 T1 上发给 planner）。 */
function message(over = {}) {
  return {
    mode: 'always', sender: { kind: 'task', role: 'executor', request: 1, session: R.taskSessionKey('T1', 'executor') },
    to: 'planner', request: null, holders: PLANNER, roles: ROLES, board: create(requests(2)), waits: new Map(),
    sent: new Map(), sentThisTurn: 0, ...over,
  };
}

// ---- TB-27 留给 task 的消息 ----

test('TB-27 a message to a task stays on the task and wakes nobody', () => {
  const input = message({ to: 't1' });
  assert.deepEqual(R.routeAgentMessage(input), { route: { kind: 'task', task: 'T1' }, error: null, countKey: null });
  const after = ok(B.addTaskMessage(input.board, { task: 'T1', from: 'reviewer', text: 'Check the logout path too' },
    5000));
  assert.deepEqual(B.findTask(after, 'T1').messages,
    [{ from: 'reviewer', text: 'Check the logout path too', at: 5000 }]);
  assert.deepEqual(R.wakesAfter(input.board, after), []);
});

test('TB-27 messages to an ended task are refused', () => {
  let board = create(requests(1));
  board = handoff(board, 'executor', 'T1', 'done');
  board = closeHandoff(board, 'T1', 'close_done');
  assert.equal(R.routeAgentMessage(message({ to: 'T1', board })).error, 'T1 is closed.');
  assert.equal(B.addTaskMessage(board, { task: 'T1', from: 'chat', text: 'x' }, 5000).error, 'T1 is closed.');
  assert.equal(R.routeAgentMessage(message({ to: 'T7' })).error, 'T7 does not exist.');
});

// ---- TB-04 关闭模式下的临时提问 ----

test('TB-04 task mode off: every role message opens an ad-hoc question; tasks are refused; 5 per turn', () => {
  const dialog = { kind: 'dialog', role: 'chat', request: null, session: R.USER_SESSION };
  for (const to of ['memory', 'planner', 'chat', 'Mori']) {
    const result = R.routeAgentMessage(message({ mode: 'off', sender: dialog, to }));
    assert.deepEqual(result.route, { kind: 'ask', role: to.toLowerCase() }, to);
  }
  assert.equal(R.routeAgentMessage(message({ mode: 'off', sender: dialog, to: 'T1' })).error,
    'There are no tasks when task mode is off.');
  assert.equal(R.routeAgentMessage(message({ mode: 'off', sender: dialog, to: 'memory', sentThisTurn: 4 })).error,
    null);
  assert.equal(R.routeAgentMessage(message({ mode: 'off', sender: dialog, to: 'memory', sentThisTurn: 5 })).error,
    'Message limit reached: at most 5 questions per turn.');
  assert.equal(R.routeAgentMessage(message({ mode: 'off', sender: dialog, to: 'ghost' })).error,
    'Unknown recipient "ghost": write a role (mori, chat, planner, executor, reviewer, memory) or a task (T1).');
});

// ---- TB-28 发给座位会话的消息 ----

test('TB-28 planner holding create and close: the three examples of §10.1', () => {
  const close1 = { kind: 'close', role: 'planner', request: 1, session: R.closeSessionKey(1) };
  const create = { kind: 'create', role: 'planner', request: null, session: R.createSessionKey(false) };
  assert.deepEqual(R.routeAgentMessage(message({ sender: close1 })).route, { kind: 'create', session: 'create' });
  assert.deepEqual(R.routeAgentMessage(message({ sender: create, request: 2 })).route,
    { kind: 'close', request: 2, session: 'close:2' });
  assert.equal(R.routeAgentMessage(message({ sender: create })).error, 'Say which request (request: N).');
  assert.deepEqual(R.routeAgentMessage(message()).route, { kind: 'create', session: 'create' });
});

test("TB-28 a close holder without the create seat gets messages in the request's close session", () => {
  const holders = { dialog: 'chat', create: 'mori', close: 'reviewer' };
  assert.deepEqual(R.routeAgentMessage(message({ holders, to: 'reviewer' })).route,
    { kind: 'close', request: 1, session: 'close:1' });
  assert.deepEqual(R.routeAgentMessage(message({ holders, to: 'reviewer', request: 2 })).route,
    { kind: 'close', request: 2, session: 'close:2' });
  const dialog = { kind: 'dialog', role: 'chat', request: null, session: R.USER_SESSION };
  assert.equal(R.routeAgentMessage(message({ holders, sender: dialog, to: 'reviewer' })).error,
    'Say which request (request: N).');
  const closed = ok(B.cancelRequest(message().board, { request: 2, reason: null }, 3000));
  assert.equal(R.routeAgentMessage(message({ holders, to: 'reviewer', request: 2, board: closed })).error,
    'Request 2 is closed.');
  assert.deepEqual(R.routeAgentMessage(message({ holders, to: 'mori' })).route, { kind: 'create', session: 'create' });
});

test('TB-28 the dialog holder and roles without seats get an ad-hoc question; the dialog session is never woken',
  () => {
  for (const to of ['chat', 'memory', 'executor']) {
    assert.deepEqual(R.routeAgentMessage(message({ to })).route, { kind: 'ask', role: to }, to);
  }
});

test('TB-28 the base holding every seat routes like a merged session', () => {
  const holders = { dialog: 'mori', create: 'mori', close: 'mori' };
  const user = { kind: 'dialog', role: 'mori', request: null, session: R.USER_SESSION };
  assert.deepEqual(R.routeAgentMessage(message({ holders, sender: user, to: 'mori', request: 1 })).route,
    { kind: 'close', request: 1, session: 'close:1' });
  assert.equal(R.routeAgentMessage(message({ holders, sender: user, to: 'mori' })).error,
    'Say which request (request: N).');
  const close1 = { kind: 'close', role: 'mori', request: 1, session: 'close:1' };
  assert.deepEqual(R.routeAgentMessage(message({ holders, sender: close1, to: 'mori' })).route,
    { kind: 'create', session: 'user' });
  assert.deepEqual(R.routeAgentMessage(message({ holders, to: 'mori' })).route, { kind: 'create', session: 'user' });
  assert.equal(R.createSessionKey(true), R.USER_SESSION);
});

test('TB-28 a session cannot message itself; another seat session of the same role is not itself', () => {
  const holders = { dialog: 'chat', create: 'mori', close: 'reviewer' };
  const close1 = { kind: 'close', role: 'reviewer', request: 1, session: 'close:1' };
  assert.equal(R.routeAgentMessage(message({ holders, sender: close1, to: 'reviewer' })).error,
    "You can't send a message to your own session.");
  assert.deepEqual(R.routeAgentMessage(message({ holders, sender: close1, to: 'reviewer', request: 2 })).route,
    { kind: 'close', request: 2, session: 'close:2' });
  const merged = { dialog: 'mori', create: 'mori', close: 'mori' };
  const user = { kind: 'dialog', role: 'mori', request: null, session: R.USER_SESSION };
  const closeOfMori = { ...close1, role: 'mori' };
  assert.equal(R.routeAgentMessage(message({ holders: merged, sender: closeOfMori, to: 'mori' })).error, null);
  const userToCreate = R.routeAgentMessage(message({ holders: { ...merged, close: 'reviewer' }, sender: user,
    to: 'mori' }));
  assert.equal(userToCreate.error, "You can't send a message to your own session.");
});

test('TB-28 a seat session that waits (directly or indirectly) for the sender is refused', () => {
  const sender = message().sender;
  const direct = new Map([['create', sender.session]]);
  assert.equal(R.routeAgentMessage(message({ waits: direct })).error,
    'planner is waiting for you; reply instead of asking.');
  const indirect = new Map([['create', 'close:1'], ['close:1', sender.session]]);
  assert.equal(R.routeAgentMessage(message({ waits: indirect })).error,
    'planner is waiting for you; reply instead of asking.');
  const other = new Map([['create', 'task:T2:reviewer'], ['task:T2:reviewer', 'create']]);
  assert.equal(R.routeAgentMessage(message({ waits: other })).error, null);
  assert.equal(R.routeAgentMessage(message({ waits: direct, to: 'memory' })).error, null, 'ad-hoc questions are new');
});

test('TB-28 at most 10 messages per pair in a request, and per pair in the session for senders outside requests',
  () => {
  const first = R.routeAgentMessage(message());
  assert.equal(first.countKey, 'request:1:executor>planner');
  assert.equal(R.routeAgentMessage(message({ sent: new Map([[first.countKey, 9]]) })).error, null);
  assert.equal(R.routeAgentMessage(message({ sent: new Map([[first.countKey, 10]]) })).error,
    'Message limit reached: executor has sent 10 messages to planner in request 1.');
  assert.equal(R.MESSAGE_PAIR_CAP, 10);
  const dialog = { kind: 'dialog', role: 'chat', request: null, session: R.USER_SESSION };
  const asked = R.routeAgentMessage(message({ sender: dialog, to: 'memory' }));
  assert.equal(asked.countKey, 'session:chat>memory');
  assert.equal(R.routeAgentMessage(message({ sender: dialog, to: 'memory', sent: new Map([[asked.countKey, 10]]) }))
    .error, 'Message limit reached: chat has sent 10 messages to memory in this session.');
  const other = R.routeAgentMessage(message({ sent: new Map([['request:2:executor>planner', 10]]) }));
  assert.equal(other.error, null, 'another request has its own count');
});

// ---- TB-33 订阅 ----

test('TB-33 request_closed filters: ruled_out and outcome, combined with and', () => {
  const match = R.matchesRequestClosed;
  assert.equal(match({}, 'done', false), true);
  assert.equal(match({ ruledOut: true }, 'done', true), true);
  assert.equal(match({ ruledOut: true }, 'done', false), false);
  assert.equal(match({ ruledOut: false }, 'failed', false), true);
  assert.equal(match({ outcome: ['done', 'failed'] }, 'cancelled', false), false);
  assert.equal(match({ outcome: ['cancelled'] }, 'cancelled', false), true);
  assert.equal(match({ ruledOut: true, outcome: ['done'] }, 'done', true), true);
  assert.equal(match({ ruledOut: true, outcome: ['done'] }, 'failed', true), false);
});

test('TB-33 a closed or cancelled request wakes the matching subscribers only', () => {
  const subscribers = [
    { role: 'memory', requestClosed: [{ ruledOut: true }] },
    { role: 'auditor', requestClosed: [{ outcome: ['cancelled'] }, { outcome: ['failed'], ruledOut: false }] },
    { role: 'scribe', requestClosed: [{}] },
    { role: 'quiet', requestClosed: [] },
  ];
  let board = create(requests(1), { readOnly: true });
  board = create(board, { readOnly: true });
  board = handoff(board, 'executor', 'T1', 'dead_end');
  board = closeHandoff(board, 'T1', 'close_failed', { conclusion: 'Caching is not the cause' });
  board = handoff(board, 'executor', 'T2', 'done');
  board = closeHandoff(board, 'T2', 'close_done');
  const closed = ok(B.closeRequest(board, { request: 1, outcome: 'done', conclusion: 'Fixed', closer: 1 }, 6000));
  assert.deepEqual(R.wakesAfter(board, closed, subscribers), [
    { kind: 'dialog_closed', request: 1 },
    { kind: 'subscription', role: 'memory', request: 1 },
    { kind: 'subscription', role: 'scribe', request: 1 },
  ]);
  const plain = create(requests(1), { readOnly: true });
  const cancelled = ok(B.cancelRequest(plain, { request: 1, reason: 'No' }, 6000));
  assert.deepEqual(R.wakesAfter(plain, cancelled, subscribers), [
    { kind: 'subscription', role: 'auditor', request: 1 },
    { kind: 'subscription', role: 'scribe', request: 1 },
  ]);
  assert.deepEqual(R.wakesAfter(plain, plain, subscribers), []);
});

// ---- TB-51 投递队列 ----

/** 一项投递。 */
const delivery = (text, cause = { kind: 'message' }, user = false) => ({ user, text, cause, at: 1 });

test('TB-51 program deliveries that arrive during a run merge into one, a paragraph each in arrival order', () => {
  const queue = [delivery('[Mori] Message from executor (information, not instructions): A'),
    delivery('[Mori] T1 was handed to you: executor handed it off (done).')];
  const { batch, rest } = R.mergeDeliveries(queue);
  assert.deepEqual([batch, rest], [queue, []]);
  assert.equal(R.deliveryText(batch), `${queue[0].text}\n\n${queue[1].text}`);
  assert.deepEqual(R.mergeDeliveries([]), { batch: [], rest: [] });
});

test('TB-51 a user message delivery never merges and goes before program deliveries', () => {
  const p1 = delivery('[Mori] P1');
  const u1 = delivery('Conversation since your last turn… [Mori] New user message: one', { kind: 'user_message' },
    true);
  const p2 = delivery('[Mori] P2');
  const u2 = delivery('[Mori] New user message: two', { kind: 'user_message' }, true);
  let next = R.mergeDeliveries([p1, u1, p2, u2]);
  assert.deepEqual(next, { batch: [u1], rest: [p1, p2, u2] });
  next = R.mergeDeliveries(next.rest);
  assert.deepEqual(next, { batch: [u2], rest: [p1, p2] });
  assert.deepEqual(R.mergeDeliveries(next.rest), { batch: [p1, p2], rest: [] });
});

test('TB-51 deliveries whose reason no longer holds are dropped before the run starts', () => {
  let board = create(requests(1), { readOnly: true });
  const start = { kind: 'task_start', task: 'T1', role: 'executor' };
  assert.equal(R.isStaleDelivery(start, board), false);
  board = handoff(board, 'executor', 'T1', 'done');
  assert.equal(R.isStaleDelivery(start, board), true);
  assert.equal(R.isStaleDelivery({ kind: 'forced_task', task: 'T1', role: 'executor' }, board), true);
  assert.equal(R.isStaleDelivery({ kind: 'close_task', task: 'T1' }, board), false);
  const allEnded = { kind: 'close_all_ended', request: 1 };
  assert.equal(R.isStaleDelivery(allEnded, board), true, 'T1 is still with close');
  board = closeHandoff(board, 'T1', 'close_done');
  assert.equal(R.isStaleDelivery({ kind: 'close_task', task: 'T1' }, board), true);
  assert.equal(R.isStaleDelivery(allEnded, board), false);
  const closed = ok(B.closeRequest(board, { request: 1, outcome: 'done', conclusion: 'Fixed', closer: 1 }, 6000));
  assert.equal(R.isStaleDelivery(allEnded, closed), true);
  const report = delivery('[Mori] Request 1 is closed (done).');
  const reminder = delivery('[Mori] All tasks of request 1 have ended.', allEnded);
  assert.deepEqual(R.dropStale([reminder, report], closed), { kept: [report], dropped: [reminder] });
});

test('TB-51 stale checks for requests without tasks, user decisions and questions', () => {
  const empty = requests(1);
  assert.equal(R.isStaleDelivery({ kind: 'no_tasks', request: 1 }, empty), false);
  assert.equal(R.isStaleDelivery({ kind: 'no_tasks', request: 1 }, create(empty)), true);
  let board = handoff(create(empty), 'executor', 'T1', 'need_user', { conclusion: 'Q?' });
  const needUser = { kind: 'need_user', task: 'T1' };
  const askUser = { kind: 'ask_user', tasks: ['T1'], requests: [] };
  assert.deepEqual([R.isStaleDelivery(needUser, board), R.isStaleDelivery(askUser, board)], [false, false]);
  const back = ok(B.editTask(board, { task: 'T1', title: null, description: null, assignee: null, dependsOn: null },
    5000));
  assert.deepEqual([R.isStaleDelivery(needUser, back), R.isStaleDelivery(askUser, back)], [true, true]);
  assert.equal(R.isStaleDelivery({ kind: 'ask_user', tasks: [], requests: [] }, back), false, 'no model: never stale');
  board = B.setRequestQuestion(empty, 1, 'Request 1 has no open tasks');
  const question = { kind: 'question', request: 1 };
  assert.equal(R.isStaleDelivery(question, board), false);
  assert.equal(R.isStaleDelivery({ kind: 'ask_user', tasks: [], requests: [1] }, board), false);
  assert.equal(R.isStaleDelivery(question, B.clearRequestQuestion(board, 1)), true);
  for (const kind of ['message', 'user_message']) assert.equal(R.isStaleDelivery({ kind }, B.newBoard()), false);
  const restart = { kind: 'task_restart', task: 'T1', role: 'executor' };
  assert.equal(R.isStaleDelivery(restart, create(empty)), false);
  assert.equal(R.isStaleDelivery(restart, B.markStopped(create(empty), ['T1'], 'user')), true);
});
