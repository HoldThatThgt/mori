// kernel/board.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §5.4、§6.1、§6.2、§7.1、§7.2、§7.4、§7.6、§7.7、
// §9.3、§11.4、§11.6、§13.3）：立项的决定规则、用户原话照记、写入与状态表的每一格、交接路由、依赖、结案与需求关闭、
// 停止与重启后的状态、board.json 的读写。时刻一律由测试给出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';

const B = await loadKernelModule('src/kernel/board.ts');
const route = await loadKernelModule('src/kernel/boardRoute.ts');

/** 全部角色名（含 mori） */
const ROLES = ['mori', 'executor', 'reviewer', 'planner', 'writer'];
/** 第一条用户消息 */
const MESSAGE = 'The login page is blank. Please fix it   and keep the old API.';

/** 写入成功，返回结果。 */
function ok(result) {
  assert.equal(result.error, null);
  return result;
}

/** 写入被拒绝：原因与预期相同、TaskBoard 不变。 */
function refused(before, result, error) {
  assert.equal(result.error, error);
  assert.equal(result.board, before);
}

/** 登记一个需求（默认原话是这次的用户消息全文）。 */
function submit(board, title = 'Login page is blank', message = MESSAGE, now = 1000) {
  const input = { title, goal: 'The login page renders again', acceptance: null, quote: null };
  return ok(B.submitRequest(board, input, { message, history: [] }, now)).board;
}

/** 建一个 task（默认写 task、指派给 executor、没有依赖）。 */
function create(board, over = {}, now = 2000) {
  const input = { request: 1, title: 'Find and fix', description: 'Find why the page is blank and fix it',
    assignee: 'executor', readOnly: false, dependsOn: [], ...over };
  return ok(B.createTask(board, input, now)).board;
}

/** task 实例的一棒交接。 */
function handoff(board, role, task, outcome, over = {}, now = 3000) {
  const input = { sender: { kind: 'task', role, task }, task, outcome, conclusion: 'Fixed the render bug',
    next: null, openItems: [], evidence: [], session: null, authorFamilies: [], forced: false, ...over };
  return B.recordHandoff(board, input, ROLES, now);
}

/** 需求 1 的结案会话（planner）的一棒交接。 */
function closeHandoff(board, task, outcome, over = {}, now = 4000) {
  const { decided = [], request = 1, ...rest } = over;
  const input = { sender: { kind: 'close', role: 'planner', request, decided }, task, outcome,
    conclusion: 'Verified by the test run', next: null, openItems: [], evidence: [], session: null,
    authorFamilies: [], forced: false, ...rest };
  return B.recordHandoff(board, input, ROLES, now);
}

/** task_edit 的参数，没写的字段为 null。 */
function edit(task, over = {}) {
  return { task, title: null, description: null, assignee: null, dependsOn: null, ...over };
}

/** 需求 1 加上 T1（executor 在做）。 */
function oneTask() {
  return create(submit(B.newBoard()));
}

const T = (board, id) => B.findTask(board, id);

// ---- TB-06 立项的决定 ----

test('TB-06 the first decision tool fixes the decision; another kind is refused, the same kind repeats', () => {
  let judgment = B.startJudgment(true, false);
  assert.equal(B.judgmentError(judgment, 'request_submit', false), null);
  judgment = B.noteJudgment(judgment, 'request_submit', false, 1);
  assert.equal(judgment.kind, 'submit');
  assert.equal(B.judgmentError(judgment, 'request_submit', false), null);
  const already = 'This message already has a decision: new request (request_submit)';
  assert.equal(B.judgmentError(judgment, 'request_update', false), already);
  assert.equal(B.judgmentError(judgment, 'request_cancel', false), already);
  assert.equal(B.judgmentError(judgment, 'reply_via_dialog', false), already);
  judgment = B.noteJudgment(judgment, 'request_submit', false, 2);
  assert.deepEqual(judgment.registered, [1, 2]);
  assert.equal(B.judgmentError(judgment, 'board_read', false), null);
  assert.equal(B.judgmentError(judgment, 'agent_message', false), null);
  let reply = B.noteJudgment(B.startJudgment(true, false), 'reply_via_dialog', false, null);
  assert.equal(B.judgmentError(reply, 'request_submit', false),
    'This message already has a decision: answer directly (reply_via_dialog)');
  reply = B.noteJudgment(B.startJudgment(true, false), 'request_cancel', false, null);
  assert.equal(B.judgmentError(reply, 'request_update', false),
    'This message already has a decision: cancel (request_cancel)');
});

test('TB-06 a judgment that made no decision counts as answer directly', () => {
  assert.equal(B.judgmentDecision(B.startJudgment(true, false)), 'reply');
  const judgment = B.noteJudgment(B.startJudgment(true, false), 'board_read', false, null);
  assert.equal(B.judgmentDecision(judgment), 'reply');
  assert.equal(B.judgmentDecision(B.noteJudgment(judgment, 'request_update', false, null)), 'update');
});

test("TB-06 task_create and task_edit need the user's words recorded first in this judgment", () => {
  const fresh = B.startJudgment(true, false);
  assert.equal(B.judgmentError(fresh, 'task_create', false), B.RECORD_FIRST);
  assert.equal(B.judgmentError(fresh, 'task_edit', false), B.RECORD_FIRST);
  assert.equal(B.RECORD_FIRST, "Record the user's words first (request_submit or request_update).");
  const replied = B.noteJudgment(fresh, 'reply_via_dialog', false, null);
  assert.equal(B.judgmentError(replied, 'task_create', false), B.RECORD_FIRST);
  for (const tool of ['request_submit', 'request_update']) {
    const recorded = B.noteJudgment(fresh, tool, false, tool === 'request_submit' ? 1 : null);
    assert.equal(B.judgmentError(recorded, 'task_create', false), null);
    assert.equal(B.judgmentError(recorded, 'task_edit', false), null);
  }
});

test('TB-06 handing back a stopped or waiting task without other changes needs no record and counts as a supplement',
  () => {
    const stopped = B.markStopped(oneTask(), ['T1'], 'user');
    assert.equal(B.isHandBackOnly(stopped, edit('T1')), true);
    assert.equal(B.isHandBackOnly(stopped, edit('T1', { title: 'New title' })), false);
    assert.equal(B.isHandBackOnly(stopped, edit('T1', { assignee: 'reviewer' })), false);
    assert.equal(B.isHandBackOnly(oneTask(), edit('T1')), false);
    const waiting = ok(handoff(oneTask(), 'executor', 'T1', 'need_user', { conclusion: 'Keep the old API?' })).board;
    assert.equal(B.isHandBackOnly(waiting, edit('T1')), true);
    let judgment = B.startJudgment(true, false);
    assert.equal(B.judgmentError(judgment, 'task_edit', true), null);
    judgment = B.noteJudgment(judgment, 'task_edit', true, null);
    assert.equal(judgment.kind, 'update');
    assert.equal(judgment.recorded, false);
    assert.equal(B.judgmentError(judgment, 'task_create', false), B.RECORD_FIRST);
    assert.equal(B.judgmentError(judgment, 'request_submit', false),
      'This message already has a decision: supplement (request_update)');
    const cancelled = B.noteJudgment(B.startJudgment(true, false), 'request_cancel', false, null);
    assert.equal(B.judgmentError(cancelled, 'task_edit', true),
      'This message already has a decision: cancel (request_cancel)');
    const submitted = B.noteJudgment(B.startJudgment(true, false), 'request_submit', false, 1);
    assert.equal(B.noteJudgment(submitted, 'task_edit', true, null).kind, 'submit');
  });

test('TB-06 program-woken create turns refuse request_submit and request_cancel and have no one-decision limit', () => {
  const judgment = B.startJudgment(false, false);
  assert.equal(B.judgmentError(judgment, 'request_submit', false), B.USER_MESSAGE_ONLY);
  assert.equal(B.judgmentError(judgment, 'request_cancel', false), B.USER_MESSAGE_ONLY);
  assert.equal(B.USER_MESSAGE_ONLY, 'Only a user message can register or cancel a request.');
  for (const tool of ['request_update', 'task_create', 'task_edit', 'reply_via_dialog', 'agent_message',
    'board_read', 'read_session']) {
    assert.equal(B.judgmentError(judgment, tool, false), null, tool);
  }
  const after = B.noteJudgment(judgment, 'request_update', false, null);
  assert.equal(B.judgmentError(after, 'reply_via_dialog', false), null);
});

test('TB-06 in a merged session reply_via_dialog is refused only in program-woken turns', () => {
  assert.equal(B.judgmentError(B.startJudgment(false, true), 'reply_via_dialog', false), B.TALK_DIRECTLY);
  assert.equal(B.TALK_DIRECTLY, 'You talk to the user directly; say it in your reply.');
  assert.equal(B.judgmentError(B.startJudgment(true, true), 'reply_via_dialog', false), null);
  assert.equal(B.judgmentError(B.startJudgment(false, true), 'task_create', false), null);
});

test('TB-06 a request registered in the judgment that still has no task is reported at the end', () => {
  const board = submit(B.newBoard());
  assert.deepEqual(B.requestsWithoutTasks(board, [1]), [1]);
  assert.deepEqual(B.requestsWithoutTasks(create(board), [1]), []);
  const cancelled = ok(B.cancelRequest(board, { request: 1, reason: null }, 1500)).board;
  assert.deepEqual(B.requestsWithoutTasks(cancelled, [1]), []);
});

// ---- TB-07 用户原话照记 ----

test('TB-07 request_submit and request_update record the whole user message by default', () => {
  const board = submit(B.newBoard());
  const request = B.findRequest(board, 1);
  assert.deepEqual(request.words, [{ text: MESSAGE, at: 1000, kind: 'original' }]);
  assert.equal(request.status, 'open');
  assert.equal(board.nextRequest, 2);
  const message = 'Also, do not touch the session cookie.';
  const updated = ok(B.updateRequest(board, { request: 1, quote: null }, { message, history: [MESSAGE] }, 5000));
  assert.equal(updated.quote, message);
  assert.deepEqual(B.findRequest(updated.board, 1).words.at(-1), { text: message, at: 5000, kind: 'supplement' });
  assert.equal(B.findRequest(board, 1).words.length, 1, 'the input board is not changed');
});

test("TB-07 quote must be the user's exact words; runs of whitespace compare as one space", () => {
  const board = submit(B.newBoard());
  const words = { message: 'ok go', history: ['First message', MESSAGE] };
  const loose = ok(B.updateRequest(board, { request: 1, quote: 'Please fix it and keep the old API.' }, words, 5000));
  assert.equal(loose.quote, 'Please fix it   and keep the old API.', 'the user\'s own spacing is recorded');
  assert.equal(ok(B.updateRequest(board, { request: 1, quote: 'old AP' }, words, 5000)).quote, 'old AP');
  assert.equal(ok(B.updateRequest(board, { request: 1, quote: 'ok go' }, words, 5000)).quote, 'ok go');
  for (const quote of ['keep the new API', 'Please fixit', '', '   ']) {
    refused(board, B.updateRequest(board, { request: 1, quote }, words, 5000), B.QUOTE_MISMATCH);
  }
  assert.equal(B.QUOTE_MISMATCH, "quote must be the user's exact words");
  const submitted = B.submitRequest(B.newBoard(), { title: 'X', goal: 'Y', acceptance: null, quote: 'never said' },
    words, 1000);
  assert.equal(submitted.error, B.QUOTE_MISMATCH);
  assert.equal(B.findQuote('a.b (c)', ['say a.b  (c) now']), 'a.b  (c)');
  assert.equal(B.findQuote('a.b', ['axb']), null);
});

test('TB-07 a program-woken turn must give a quote', () => {
  const board = submit(B.newBoard());
  const words = { message: null, history: [MESSAGE] };
  refused(board, B.updateRequest(board, { request: 1, quote: null }, words, 5000), B.QUOTE_REQUIRED);
  const updated = ok(B.updateRequest(board, { request: 1, quote: 'keep the old API' }, words, 5000));
  assert.equal(updated.quote, 'keep the old API');
});

// ---- TB-12 TaskBoard 持久化 ----

test('TB-12 board.json is written atomically and reads back the same board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mori-board-'));
  try {
    const dir = join(root, 'teams', 'session-1');
    assert.deepEqual(await B.loadBoard(dir), B.newBoard(), 'no file yet: an empty board');
    const board = ok(handoff(oneTask(), 'executor', 'T1', 'done', { next: 'reviewer' })).board;
    await B.saveBoard(dir, board);
    assert.deepEqual(readdirSync(dir), ['board.json'], 'no temporary file is left behind');
    assert.deepEqual(await B.loadBoard(dir), board);
    await B.saveBoard(dir, B.markStopped(board, ['T1'], 'user'));
    assert.equal((await B.loadBoard(dir)).tasks[0].status, 'stopped');
    assert.deepEqual(readdirSync(dir), ['board.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TB-12 an unreadable board.json is reported, not replaced with an empty board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mori-board-'));
  try {
    for (const text of ['{"version":2}', 'not json']) {
      writeFileSync(join(dir, 'board.json'), text);
      await assert.rejects(B.loadBoard(dir), /board\.json is not (a valid TaskBoard|valid JSON)/);
      assert.equal(readFileSync(join(dir, 'board.json'), 'utf8'), text);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TB-12 request and task numbers are never reused', () => {
  let board = create(submit(B.newBoard()));
  board = ok(B.cancelRequest(board, { request: 1, reason: 'Not needed' }, 3000)).board;
  board = submit(board, 'Second request', 'second', 4000);
  assert.deepEqual(board.requests.map((request) => request.no), [1, 2]);
  board = create(board, { request: 2 }, 5000);
  assert.deepEqual(board.tasks.map((task) => task.id), ['T1', 'T2']);
  assert.equal(board.nextTask, 3);
  assert.equal(board.nextRequest, 3);
});

test('TB-12 an ended task cannot change', () => {
  let board = create(oneTask(), { readOnly: true, title: 'Second' });
  board = ok(handoff(board, 'executor', 'T1', 'done')).board;
  board = ok(closeHandoff(board, 'T1', 'close_done')).board;
  assert.equal(T(board, 'T1').status, 'done');
  refused(board, B.editTask(board, edit('T1', { title: 'Again' }), 5000), 'T1 is closed.');
  refused(board, B.addTaskMessage(board, { task: 'T1', from: 'reviewer', text: 'hi' }, 5000), 'T1 is closed.');
  refused(board, handoff(board, 'executor', 'T1', 'done'), 'T1 is closed.');
  refused(board, closeHandoff(board, 'T1', 'close_failed'), 'T1 is closed.');
  assert.equal(T(B.markStopped(board, ['T1'], 'user'), 'T1').status, 'done');
  const cancelled = ok(B.cancelRequest(board, { request: 1, reason: null }, 6000)).board;
  assert.equal(T(cancelled, 'T1').status, 'done');
  assert.equal(T(cancelled, 'T2').status, 'cancelled');
  assert.deepEqual(B.applyRestartRecovery(cancelled, ['executor']).stopped, []);
});

test('TB-12 reopening after a restart stops active tasks and hands tasks of missing roles to close', () => {
  let board = create(oneTask(), { readOnly: true, assignee: 'reviewer', title: 'Review' });
  board = create(board, { dependsOn: ['T1'], title: 'Changelog', assignee: 'writer' });
  board = create(board, { title: 'Ask', assignee: 'executor', readOnly: true });
  board = ok(handoff(board, 'executor', 'T4', 'need_user', { conclusion: 'Which API?' })).board;
  const { board: after, stopped } = B.applyRestartRecovery(board, ['executor', 'planner']);
  assert.deepEqual(stopped, ['T1', 'T2', 'T3']);
  assert.deepEqual([T(after, 'T1').status, T(after, 'T1').stopReason, T(after, 'T1').holder],
    ['stopped', 'restart', { kind: 'role', role: 'executor' }]);
  for (const [id, role] of [['T2', 'reviewer'], ['T3', 'writer']]) {
    assert.equal(T(after, id).status, 'stopped');
    assert.equal(T(after, id).stopReason, 'restart');
    assert.deepEqual(T(after, id).holder, { kind: 'close' });
    assert.equal(T(after, id).holderReason, `role ${role} no longer exists`);
  }
  assert.equal(T(after, 'T4').status, 'waiting_user', 'waiting_user is left as it was');
  const same = B.applyRestartRecovery(B.newBoard(), []);
  assert.deepEqual(same.stopped, []);
  const back = ok(B.editTask(after, edit('T2'), 9000)).board;
  assert.deepEqual([T(back, 'T2').status, T(back, 'T2').holder], ['active', { kind: 'close' }]);
  const reassigned = ok(B.editTask(after, edit('T2', { assignee: 'executor' }), 9000)).board;
  assert.deepEqual(T(reassigned, 'T2').holder, { kind: 'role', role: 'executor' });
});

// ---- TB-14 交接路由 ----

test('TB-14 need_user goes to create: waiting_user, the question is the conclusion, the asker stays the holder', () => {
  const result = ok(handoff(oneTask(), 'executor', 'T1', 'need_user', { conclusion: 'Keep the old API?' }));
  const task = T(result.board, 'T1');
  assert.deepEqual([task.status, task.question, task.asked], ['waiting_user', 'Keep the old API?', false]);
  assert.deepEqual(task.holder, { kind: 'role', role: 'executor' });
  assert.deepEqual(result.handoff.routedTo, { kind: 'create' });
  assert.deepEqual(route.wakesAfter(oneTask(), result.board), [{ kind: 'create_need_user', task: 'T1' }]);
});

test('TB-14 done, pass and blocked go to close; a written next is only a suggestion', () => {
  for (const outcome of ['done', 'pass', 'blocked']) {
    const result = ok(handoff(oneTask(), 'executor', 'T1', outcome, { next: 'reviewer' }));
    const task = T(result.board, 'T1');
    assert.deepEqual(result.handoff.routedTo, { kind: 'close' }, outcome);
    assert.equal(result.handoff.suggestedNext, 'reviewer');
    assert.equal(result.handoff.next, 'reviewer');
    assert.deepEqual(task.holder, { kind: 'close' });
    assert.equal(task.holderReason, `executor handed it off (${outcome})`);
    assert.deepEqual(route.wakesAfter(oneTask(), result.board), [{ kind: 'close_task', request: 1, task: 'T1' }]);
  }
});

test('TB-14 continue, dead_end and fail with next go to that role', () => {
  for (const outcome of ['continue', 'dead_end', 'fail']) {
    const result = ok(handoff(oneTask(), 'executor', 'T1', outcome, { next: 'reviewer' }, 3500));
    const task = T(result.board, 'T1');
    assert.deepEqual(result.handoff.routedTo, { kind: 'role', role: 'reviewer' }, outcome);
    assert.equal(result.handoff.suggestedNext, null);
    assert.deepEqual([task.status, task.holder, task.readyAt, task.assignee],
      ['active', { kind: 'role', role: 'reviewer' }, 3500, 'executor']);
    assert.deepEqual(route.wakesAfter(oneTask(), result.board), [{ kind: 'schedule', task: 'T1', role: 'reviewer' }]);
  }
});

test('TB-14 without next the rest go to close', () => {
  for (const outcome of ['continue', 'dead_end', 'fail']) {
    const result = ok(handoff(oneTask(), 'executor', 'T1', outcome));
    assert.deepEqual(result.handoff.routedTo, { kind: 'close' }, outcome);
    assert.equal(result.handoff.suggestedNext, null);
  }
  const blank = ok(handoff(oneTask(), 'executor', 'T1', 'continue', { next: '  ' }));
  assert.deepEqual([blank.handoff.routedTo, blank.handoff.next], [{ kind: 'close' }, null]);
});

test('TB-14 a forced handoff always goes to close and keeps next as a suggestion', () => {
  for (const outcome of ['continue', 'need_user', 'fail']) {
    const result = ok(handoff(oneTask(), 'executor', 'T1', outcome, { next: 'reviewer', forced: true }));
    assert.deepEqual(result.handoff.routedTo, { kind: 'close' }, outcome);
    assert.equal(result.handoff.suggestedNext, 'reviewer');
    assert.equal(T(result.board, 'T1').status, 'active');
  }
});

test('TB-14 the close session closes, reassigns or asks the user', () => {
  const withClose = ok(handoff(oneTask(), 'executor', 'T1', 'done')).board;
  const done = ok(closeHandoff(withClose, 'T1', 'close_done'));
  assert.deepEqual(done.handoff.routedTo, { kind: 'end', status: 'done' });
  assert.equal(done.handoff.from, 'close:planner');
  assert.deepEqual([T(done.board, 'T1').status, T(done.board, 'T1').closedAt, T(done.board, 'T1').holder],
    ['done', 4000, null]);
  const failed = ok(closeHandoff(withClose, 'T1', 'close_failed', { next: 'executor' }));
  assert.deepEqual([failed.handoff.routedTo, failed.handoff.suggestedNext], [{ kind: 'end', status: 'failed' }, 'executor']);
  const moved = ok(closeHandoff(withClose, 'T1', 'continue', { next: 'writer' }, 4500));
  assert.deepEqual(moved.handoff.routedTo, { kind: 'role', role: 'writer' });
  assert.deepEqual([T(moved.board, 'T1').holder, T(moved.board, 'T1').assignee, T(moved.board, 'T1').readyAt],
    [{ kind: 'role', role: 'writer' }, 'writer', 4500]);
  const asked = ok(closeHandoff(withClose, 'T1', 'need_user', { conclusion: 'Ship it without tests?' }));
  assert.deepEqual(asked.handoff.routedTo, { kind: 'create' });
  assert.deepEqual([T(asked.board, 'T1').status, T(asked.board, 'T1').holder, T(asked.board, 'T1').question],
    ['waiting_user', { kind: 'close' }, 'Ship it without tests?']);
  assert.deepEqual(route.wakesAfter(withClose, done.board), [{ kind: 'close_all_ended', request: 1 }]);
});

test('TB-14 close continue without next is refused; task and close outcomes are separate sets', () => {
  const withClose = ok(handoff(oneTask(), 'executor', 'T1', 'done')).board;
  refused(withClose, closeHandoff(withClose, 'T1', 'continue'), 'continue needs next (the role to reassign to).');
  refused(withClose, closeHandoff(withClose, 'T1', 'done'),
    'outcome must be one of: close_done, close_failed, continue, need_user.');
  const board = oneTask();
  refused(board, handoff(board, 'executor', 'T1', 'close_done'),
    'outcome must be one of: continue, dead_end, blocked, need_user, done, pass, fail.');
});

test('TB-14 next must be another role', () => {
  const board = oneTask();
  refused(board, handoff(board, 'executor', 'T1', 'continue', { next: 'executor' }),
    'next must be one of: mori, reviewer, planner, writer.');
  refused(board, handoff(board, 'executor', 'T1', 'continue', { next: 'ghost' }),
    'next must be one of: mori, reviewer, planner, writer.');
  const base = create(submit(B.newBoard()), { assignee: 'mori' });
  const input = { sender: { kind: 'task', role: 'mori', task: 'T1' }, task: 'T1', outcome: 'continue',
    conclusion: 'x', next: 'reviewer', openItems: [], evidence: [], session: null, authorFamilies: [], forced: false };
  refused(base, B.recordHandoff(base, input, ['mori'], 3000), 'next is not available: there is no other role.');
});

test('TB-14 handoff fields follow §7.2: conclusion 1–600, at most 10 open items of 200', () => {
  const board = oneTask();
  refused(board, handoff(board, 'executor', 'T1', 'done', { conclusion: ' ' }), 'conclusion must be 1–600 characters.');
  refused(board, handoff(board, 'executor', 'T1', 'done', { conclusion: 'x'.repeat(601) }),
    'conclusion must be 1–600 characters.');
  refused(board, handoff(board, 'executor', 'T1', 'done', { openItems: Array(11).fill('item') }),
    'open_items must have at most 10 items.');
  refused(board, handoff(board, 'executor', 'T1', 'done', { openItems: ['y'.repeat(201)] }),
    'each of open_items must be at most 200 characters.');
  const evidence = [{ tag: '#3', toolCallId: 'c3', toolName: 'bash', title: 'Run npm test', ok: true }];
  const result = ok(handoff(board, 'executor', 'T1', 'done', { conclusion: 'x'.repeat(600), openItems: ['a', 'b'],
    evidence, session: { file: 's.jsonl', turns: [1, 2] }, authorFamilies: ['glm'] }));
  assert.deepEqual([result.handoff.n, result.handoff.openItems, result.handoff.evidence, result.handoff.session,
    result.handoff.authorFamilies, result.handoff.reason], [1, ['a', 'b'], evidence, { file: 's.jsonl', turns: [1, 2] },
    ['glm'], null]);
});

test('TB-14 program handoffs (§7.4): a task instance falls back to close, the close session to create', () => {
  for (const [reason, text] of [['no_handoff', 'executor ended without a handoff'],
    ['error', "executor's run ended with an error"], ['no_model', 'no model available for executor']]) {
    const input = { task: 'T1', reason, conclusion: `  ${'z'.repeat(700)} `, holder: { kind: 'role', role: 'executor' },
      session: null, authorFamilies: [] };
    const result = ok(B.recordProgramHandoff(oneTask(), input, 3000));
    assert.deepEqual([result.handoff.from, result.handoff.outcome, result.handoff.reason, result.handoff.routedTo],
      ['mori', null, reason, { kind: 'close' }]);
    assert.equal([...result.handoff.conclusion].length, 600);
    assert.equal(T(result.board, 'T1').holderReason, text);
  }
  const withClose = ok(handoff(oneTask(), 'executor', 'T1', 'done')).board;
  const question = B.closeUndecidedQuestion('planner', 'T1');
  assert.equal(question, "planner didn't decide on T1");
  assert.equal(B.closeNoModelQuestion('mori'), "Mori can't run: no model available");
  const input = { task: 'T1', reason: 'close_undecided', conclusion: question, holder: { kind: 'close' }, session: null,
    authorFamilies: [] };
  const asked = ok(B.recordProgramHandoff(withClose, input, 5000));
  assert.deepEqual([T(asked.board, 'T1').status, T(asked.board, 'T1').question, T(asked.board, 'T1').holder],
    ['waiting_user', question, { kind: 'close' }]);
  assert.deepEqual(route.wakesAfter(withClose, asked.board), [{ kind: 'create_need_user', task: 'T1' }]);
  const stale = { ...input, holder: { kind: 'role', role: 'executor' }, reason: 'error' };
  assert.equal(B.recordProgramHandoff(withClose, stale, 5000).error, 'T1 has moved on; nothing to hand off.');
  const stopped = B.markStopped(oneTask(), ['T1'], 'user');
  assert.equal(B.recordProgramHandoff(stopped, stale, 5000).error, 'T1 is stopped; nothing to hand off.');
});

// ---- TB-25 依赖 ----

test('TB-25 a task waits for its dependencies and goes to its assignee when all are done', () => {
  let board = create(oneTask(), { title: 'Docs', assignee: 'writer', readOnly: true });
  board = create(board, { title: 'Changelog', assignee: 'writer', dependsOn: ['t1', '2'] });
  assert.deepEqual([T(board, 'T3').status, T(board, 'T3').dependsOn, T(board, 'T3').holder], ['pending', ['T1', 'T2'],
    null]);
  board = ok(handoff(board, 'executor', 'T1', 'done')).board;
  board = ok(closeHandoff(board, 'T1', 'close_done')).board;
  assert.equal(T(board, 'T3').status, 'pending');
  board = ok(handoff(board, 'writer', 'T2', 'done')).board;
  const before = board;
  board = ok(closeHandoff(board, 'T2', 'close_done', {}, 7000)).board;
  assert.deepEqual([T(board, 'T3').status, T(board, 'T3').holder, T(board, 'T3').readyAt],
    ['active', { kind: 'role', role: 'writer' }, 7000]);
  assert.deepEqual(route.wakesAfter(before, board), [{ kind: 'schedule', task: 'T3', role: 'writer' }]);
});

test('TB-25 a failed dependency hands the waiting task to close', () => {
  let board = create(oneTask(), { title: 'Changelog', assignee: 'writer', dependsOn: ['T1'] });
  board = ok(handoff(board, 'executor', 'T1', 'dead_end')).board;
  const before = board;
  board = ok(closeHandoff(board, 'T1', 'close_failed', { conclusion: 'The CSS fix does not work' }, 6000)).board;
  const task = T(board, 'T2');
  assert.deepEqual([task.status, task.holder, task.holderReason], ['active', { kind: 'close' }, 'dependency T1 failed']);
  assert.deepEqual(task.handoffs.map((item) => [item.from, item.outcome, item.reason, item.conclusion, item.routedTo]),
    [['mori', null, 'dependency_failed', 'T1 failed: The CSS fix does not work', { kind: 'close' }]]);
  assert.deepEqual(route.wakesAfter(before, board), [{ kind: 'close_task', request: 1, task: 'T2' }]);
});

test('TB-25 a new task whose dependencies are already done or failed is handed over at once', () => {
  let board = ok(handoff(oneTask(), 'executor', 'T1', 'done')).board;
  board = ok(closeHandoff(board, 'T1', 'close_done')).board;
  board = create(board, { title: 'After', assignee: 'reviewer', dependsOn: ['T1'] }, 8000);
  assert.deepEqual([T(board, 'T2').status, T(board, 'T2').holder], ['active', { kind: 'role', role: 'reviewer' }]);
  let failed = create(oneTask(), { title: 'Other', readOnly: true });
  failed = ok(handoff(failed, 'executor', 'T2', 'fail')).board;
  failed = ok(closeHandoff(failed, 'T2', 'close_failed')).board;
  failed = create(failed, { title: 'After', dependsOn: ['T2'] }, 8000);
  assert.deepEqual([T(failed, 'T3').status, T(failed, 'T3').holder], ['active', { kind: 'close' }]);
  assert.equal(T(failed, 'T3').handoffs[0].reason, 'dependency_failed');
});

test('TB-25 depends_on: unknown tasks, other requests, the task itself and cycles are refused', () => {
  let board = create(oneTask(), { title: 'Two', dependsOn: ['T1'] });
  board = create(board, { title: 'Three', dependsOn: ['T2'] });
  const input = (over) => ({ request: 1, title: 'New', description: 'New task', assignee: 'executor', readOnly: true,
    dependsOn: [], ...over });
  refused(board, B.createTask(board, input({ dependsOn: ['T9'] }), 5000), 'depends_on: T9 does not exist.');
  refused(board, B.createTask(board, input({ dependsOn: ['4'] }), 5000), 'depends_on: T4 is the task itself.');
  const two = submit(board, 'Other', 'other', 5000);
  refused(two, B.createTask(two, input({ request: 2, dependsOn: ['T1'] }), 5000),
    'depends_on: T1 belongs to request 1, not request 2.');
  refused(board, B.editTask(board, edit('T2', { dependsOn: ['T3'] }), 5000), 'depends_on: T2 → T3 → T2 would be a cycle.');
  refused(board, B.editTask(board, edit('T2', { dependsOn: ['T2'] }), 5000), 'depends_on: T2 is the task itself.');
  const changed = ok(B.editTask(board, edit('T3', { dependsOn: ['T1'] }), 5000)).board;
  assert.deepEqual(T(changed, 'T3').dependsOn, ['T1']);
});

// ---- TB-48 写入与状态 ----

test('TB-48 any write on a closed request: Request 1 is closed.', () => {
  const board = ok(B.cancelRequest(oneTask(), { request: 1, reason: 'Changed my mind' }, 3000)).board;
  const words = { message: 'x', history: [] };
  const closed = 'Request 1 is closed.';
  refused(board, B.updateRequest(board, { request: 1, quote: null }, words, 4000), closed);
  refused(board, B.cancelRequest(board, { request: 1, reason: null }, 4000), closed);
  refused(board, B.createTask(board, { request: 1, title: 'a', description: 'b', assignee: 'executor', readOnly: true,
    dependsOn: [] }, 4000), closed);
  refused(board, B.editTask(board, edit('T1', { title: 'x' }), 4000), closed);
  refused(board, B.addTaskMessage(board, { task: 'T1', from: 'reviewer', text: 'x' }, 4000), closed);
  refused(board, handoff(board, 'executor', 'T1', 'done'), closed);
  refused(board, closeHandoff(board, 'T1', 'close_done'), closed);
  refused(board, B.closeRequest(board, { request: 1, outcome: 'done', conclusion: 'x', closer: 1 }, 4000), closed);
  assert.equal(B.updateRequest(board, { request: 7, quote: null }, words, 4000).error, 'Request 7 does not exist.');
  assert.equal(B.editTask(board, edit('T9'), 4000).error, 'T9 does not exist.');
  assert.equal(B.setRequestQuestion(board, 1, 'q'), board);
});

test('TB-48 request_cancel cancels the unfinished tasks, releases the write lock and writes no handoff', () => {
  let board = create(oneTask(), { title: 'Read', readOnly: true });
  board = route.scheduleStarts(board, []).board;
  assert.equal(board.lock, 'T1');
  const result = ok(B.cancelRequest(board, { request: 1, reason: 'Not needed any more' }, 3000));
  assert.deepEqual(result.cancelled, ['T1', 'T2']);
  assert.equal(result.board.lock, null);
  for (const task of result.board.tasks) {
    assert.deepEqual([task.status, task.closedAt, task.holder, task.handoffs.length], ['cancelled', 3000, null, 0]);
  }
  const request = B.findRequest(result.board, 1);
  assert.deepEqual([request.status, request.conclusion, request.closedAt], ['cancelled', 'Not needed any more', 3000]);
  assert.deepEqual(route.wakesAfter(board, result.board), [], 'no close session and no report for a cancel');
});

test('TB-48 task_edit: depends_on only before the task starts, no reassignment while it is in progress', () => {
  const board = create(oneTask(), { title: 'Two', readOnly: true });
  refused(board, B.editTask(board, edit('T1', { dependsOn: ['T2'] }), 5000),
    'depends_on can only change before T1 starts.');
  ok(B.editTask(board, edit('T1', { dependsOn: [] }), 5000));
  const reassign = 'T1 is in progress; it can be reassigned when it is handed back.';
  refused(board, B.editTask(board, edit('T1', { assignee: 'reviewer' }), 5000), reassign);
  ok(B.editTask(board, edit('T1', { assignee: 'executor' }), 5000));
  const withClose = ok(handoff(board, 'executor', 'T1', 'done')).board;
  refused(withClose, B.editTask(withClose, edit('T1', { assignee: 'reviewer' }), 5000), reassign);
  const pending = create(board, { title: 'Three', dependsOn: ['T1'] });
  const moved = ok(B.editTask(pending, edit('T3', { assignee: 'writer', dependsOn: ['T2', 'T1'] }), 5000)).board;
  assert.deepEqual([T(moved, 'T3').assignee, T(moved, 'T3').dependsOn, T(moved, 'T3').status],
    ['writer', ['T2', 'T1'], 'pending']);
});

test('TB-48 task_edit title and description take effect on the task for the next request', () => {
  const result = ok(B.editTask(oneTask(), edit('T1', { title: 'Fix the login page', description: 'Only the CSS' }),
    5000));
  assert.deepEqual([T(result.board, 'T1').title, T(result.board, 'T1').description, result.handedBack],
    ['Fix the login page', 'Only the CSS', false]);
  assert.deepEqual([T(result.board, 'T1').status, T(result.board, 'T1').holder], ['active',
    { kind: 'role', role: 'executor' }]);
  const board = oneTask();
  refused(board, B.editTask(board, edit('T1', { title: 'x'.repeat(81) }), 5000), 'title must be 1–80 characters.');
});

test('TB-48 task_handoff from a task instance that no longer holds the task', () => {
  const moved = ok(handoff(oneTask(), 'executor', 'T1', 'continue', { next: 'reviewer' })).board;
  const lost = 'You no longer hold T1; stop working on it.';
  refused(moved, handoff(moved, 'executor', 'T1', 'done'), lost);
  const stopped = B.markStopped(oneTask(), ['T1'], 'user');
  refused(stopped, handoff(stopped, 'executor', 'T1', 'done'), lost);
  const other = create(oneTask(), { title: 'Two', readOnly: true });
  const input = { sender: { kind: 'task', role: 'executor', task: 'T1' }, task: 'T2', outcome: 'done',
    conclusion: 'x', next: null, openItems: [], evidence: [], session: null, authorFamilies: [], forced: false };
  refused(other, B.recordHandoff(other, input, ROLES, 3000), 'You no longer hold T2; stop working on it.');
});

test('TB-48 the close session: a task that is not with it, and a second decision in one run', () => {
  const board = create(oneTask(), { title: 'Two', readOnly: true });
  refused(board, closeHandoff(board, 'T1', 'close_done'), 'T1 is not with you.');
  const withClose = ok(handoff(board, 'executor', 'T1', 'done')).board;
  refused(withClose, closeHandoff(withClose, 'T1', 'close_done', { request: 2 }), 'T1 is not with you.');
  refused(withClose, closeHandoff(withClose, 'T1', 'close_done', { decided: ['T1'] }), 'T1 is already decided.');
  const decided = ok(closeHandoff(withClose, 'T1', 'continue', { next: 'executor' })).board;
  refused(decided, closeHandoff(decided, 'T1', 'close_done', { decided: ['T1'] }), 'T1 is already decided.');
  const closeIt = { request: 1, outcome: 'done', conclusion: 'Fixed', closer: 2 };
  refused(board, B.closeRequest(board, closeIt, 5000), 'Request 1 is not with you.');
});

test('TB-48 task_edit hands a waiting or stopped task back to its holder, or to the assignee it names', () => {
  const waiting = ok(handoff(oneTask(), 'executor', 'T1', 'need_user', { conclusion: 'Which API?' })).board;
  const back = ok(B.editTask(waiting, edit('T1'), 6000));
  assert.equal(back.handedBack, true);
  const task = T(back.board, 'T1');
  assert.deepEqual([task.status, task.holder, task.question, task.asked, task.readyAt],
    ['active', { kind: 'role', role: 'executor' }, null, false, 6000]);
  assert.deepEqual(route.wakesAfter(waiting, back.board), [{ kind: 'schedule', task: 'T1', role: 'executor' }]);
  const other = ok(B.editTask(waiting, edit('T1', { assignee: 'reviewer' }), 6000)).board;
  assert.deepEqual([T(other, 'T1').holder, T(other, 'T1').assignee], [{ kind: 'role', role: 'reviewer' }, 'reviewer']);
  const withClose = ok(handoff(oneTask(), 'executor', 'T1', 'done')).board;
  const closeAsked = ok(closeHandoff(withClose, 'T1', 'need_user', { conclusion: 'Ship?' })).board;
  const toClose = ok(B.editTask(closeAsked, edit('T1'), 6000)).board;
  assert.deepEqual([T(toClose, 'T1').status, T(toClose, 'T1').holder], ['active', { kind: 'close' }]);
  assert.deepEqual(route.wakesAfter(closeAsked, toClose), [{ kind: 'close_task', request: 1, task: 'T1' }]);
  const stopped = B.markStopped(withClose, ['T1'], 'user');
  assert.deepEqual([T(stopped, 'T1').status, T(stopped, 'T1').stopReason, T(stopped, 'T1').holder],
    ['stopped', 'user', { kind: 'close' }]);
  const resumed = ok(B.editTask(stopped, edit('T1'), 6000)).board;
  assert.deepEqual([T(resumed, 'T1').status, T(resumed, 'T1').stopReason], ['active', null]);
});

test('TB-48 a task stopped while waiting for dependencies goes back to waiting when handed back', () => {
  const board = create(oneTask(), { title: 'Two', dependsOn: ['T1'] });
  const stopped = B.markStopped(board, B.liveTaskIds(board), 'user');
  assert.deepEqual(stopped.tasks.map((task) => task.status), ['stopped', 'stopped']);
  const back = ok(B.editTask(stopped, edit('T2'), 6000)).board;
  assert.deepEqual([T(back, 'T2').status, T(back, 'T2').holder], ['pending', null]);
});

test('TB-48 Stop team stops running and queued tasks, and tasks with a busy close session', () => {
  let board = create(oneTask(), { title: 'Two', readOnly: true });
  board = create(board, { title: 'Three', dependsOn: ['T1'] });
  board = create(board, { title: 'Four', readOnly: true });
  board = ok(handoff(board, 'executor', 'T2', 'done')).board;
  board = ok(handoff(board, 'executor', 'T4', 'need_user', { conclusion: 'Q?' })).board;
  assert.deepEqual(B.teamStopTargets(board, []), ['T1']);
  assert.deepEqual(B.teamStopTargets(board, [1]), ['T1', 'T2']);
  const stopped = B.markStopped(board, B.teamStopTargets(board, [1]), 'user');
  assert.deepEqual(stopped.tasks.map((task) => task.status), ['stopped', 'stopped', 'pending', 'waiting_user']);
  assert.deepEqual(T(stopped, 'T2').holder, { kind: 'close' });
  assert.deepEqual(route.wakesAfter(board, stopped), []);
});

// ---- TB-31 结案与需求关闭 ----

test('TB-31 request_close is refused while tasks are open and closes the request when all have ended', () => {
  let board = create(oneTask(), { title: 'Two', readOnly: true, dependsOn: ['T1'] });
  const input = { request: 1, outcome: 'done', conclusion: 'The page renders; npm test passes', closer: 1 };
  refused(board, B.closeRequest(board, input, 5000), 'Request 1 has tasks that have not ended: T1 (active), T2 (pending).');
  board = ok(handoff(board, 'executor', 'T1', 'done')).board;
  board = ok(closeHandoff(board, 'T1', 'close_done')).board;
  board = ok(handoff(board, 'executor', 'T2', 'done')).board;
  board = ok(closeHandoff(board, 'T2', 'close_done')).board;
  board = B.setRequestQuestion(board, 1, 'q');
  refused(board, B.closeRequest(board, { ...input, outcome: 'cancelled' }, 5000), 'outcome must be one of: done, failed.');
  refused(board, B.closeRequest(board, { ...input, conclusion: '' }, 5000), 'conclusion must be 1–1200 characters.');
  const closed = ok(B.closeRequest(board, input, 9000)).board;
  const request = B.findRequest(closed, 1);
  assert.deepEqual([request.status, request.conclusion, request.closedAt, request.question],
    ['done', input.conclusion, 9000, null]);
  assert.deepEqual(route.wakesAfter(board, closed), [{ kind: 'dialog_closed', request: 1 }]);
  const empty = submit(B.newBoard());
  assert.equal(B.findRequest(ok(B.closeRequest(empty, { ...input, outcome: 'failed' }, 5000)).board, 1).status,
    'failed');
});

test('TB-31 ruled-out approaches are the closing conclusions of tasks closed as failed, by closing time', () => {
  let board = create(oneTask(), { title: 'Two', readOnly: true });
  board = create(board, { title: 'Three', readOnly: true });
  for (const id of ['T1', 'T2', 'T3']) board = ok(handoff(board, 'executor', id, 'dead_end')).board;
  board = ok(closeHandoff(board, 'T2', 'close_failed', { conclusion: 'Caching is not the cause' }, 5000)).board;
  board = ok(closeHandoff(board, 'T3', 'close_done', {}, 5500)).board;
  board = ok(closeHandoff(board, 'T1', 'close_failed', { conclusion: 'The CSS fix does not work' }, 6000)).board;
  assert.deepEqual(B.ruledOut(board, 1), ['Caching is not the cause', 'The CSS fix does not work']);
  assert.deepEqual(B.ruledOut(oneTask(), 1), []);
});

test("TB-31 the close session's run end: undecided tasks get a forced handoff, an unclosed request a forced close",
  () => {
    let board = create(oneTask(), { title: 'Two', readOnly: true });
    board = ok(handoff(board, 'executor', 'T1', 'done')).board;
    board = ok(handoff(board, 'executor', 'T2', 'done')).board;
    const run = { request: 1, heldAtStart: ['T1'], decided: [], wokenForEnd: false, messagedCreate: false };
    assert.deepEqual(B.closeRunOutcome(board, run), { undecided: ['T1'], forceClose: false });
    assert.deepEqual(B.closeRunOutcome(board, { ...run, decided: ['T1'] }).undecided, []);
    board = ok(closeHandoff(board, 'T1', 'close_done')).board;
    board = ok(closeHandoff(board, 'T2', 'close_done')).board;
    const end = { ...run, heldAtStart: [], wokenForEnd: true };
    assert.equal(B.closeRunOutcome(board, end).forceClose, true);
    assert.equal(B.closeRunOutcome(board, { ...end, messagedCreate: true }).forceClose, false);
    assert.equal(B.closeRunOutcome(B.markCloseRetry(board, 1), { ...end, messagedCreate: true }).forceClose, true);
    assert.equal(B.closeRunOutcome(board, { ...end, wokenForEnd: false }).forceClose, false);
    assert.equal(B.closeRunOutcome(create(board, { title: 'More', readOnly: true }), end).forceClose, false);
    const closed = ok(B.closeRequest(board, { request: 1, outcome: 'done', conclusion: 'Done', closer: 1 }, 7000));
    assert.equal(B.closeRunOutcome(closed.board, end).forceClose, false);
    assert.equal(B.closeRunOutcome(submit(B.newBoard()), end).forceClose, true, 'a request without tasks');
  });

test('TB-31 a request-level question wakes create, is asked once and shows as needing a decision', () => {
  let board = ok(handoff(oneTask(), 'executor', 'T1', 'done')).board;
  board = ok(closeHandoff(board, 'T1', 'close_done')).board;
  assert.deepEqual(B.requestsAwaitingClose(board), [1]);
  const question = B.notClosedQuestion(1, 'planner');
  assert.equal(question, "Request 1 has no open tasks and planner didn't close it");
  const asking = B.setRequestQuestion(board, 1, question);
  assert.deepEqual(route.wakesAfter(board, asking), [{ kind: 'create_question', request: 1 }]);
  const request = (b) => B.findRequest(b, 1);
  assert.equal(B.requestState(asking, request(asking)), 'waiting_create');
  const asked = B.markAsked(asking, { tasks: [], requests: [1] }, true);
  assert.equal(B.requestState(asked, request(asked)), 'needs_decision');
  const unasked = B.markAsked(asked, { tasks: [], requests: [1] }, false);
  assert.equal(B.requestState(unasked, request(unasked)), 'waiting_create');
  const cleared = B.clearRequestQuestion(asked, 1);
  assert.deepEqual([request(cleared).question, request(cleared).asked], [null, false]);
  assert.equal(B.requestState(cleared, request(cleared)), 'with_close');
  assert.equal(request(B.markCloseRetry(board, 1)).closeRetry, true);
});

test('TB-31 the request state follows the §13.3 order', () => {
  const state = (b) => B.requestState(b, B.findRequest(b, 1));
  let board = create(oneTask(), { title: 'Two', readOnly: true });
  assert.equal(state(board), 'running');
  const waiting = ok(handoff(board, 'executor', 'T2', 'need_user', { conclusion: 'Q?' })).board;
  assert.equal(state(waiting), 'waiting_create');
  const asked = B.markAsked(waiting, { tasks: ['T2'], requests: [] }, true);
  assert.equal(T(asked, 'T2').asked, true);
  assert.equal(state(asked), 'needs_decision');
  assert.equal(state(B.setRequestQuestion(asked, 1, 'q')), 'needs_decision');
  const stoppedOne = B.markStopped(board, ['T1'], 'user');
  assert.equal(state(stoppedOne), 'running', 'T2 is still active');
  assert.equal(state(B.markStopped(board, ['T1', 'T2'], 'user')), 'stopped');
  for (const [status, reason] of [['cancelled', 'No'], ['done', null], ['failed', null]]) {
    if (status === 'cancelled') board = ok(B.cancelRequest(oneTask(), { request: 1, reason }, 5000)).board;
    else board = ok(B.closeRequest(submit(B.newBoard()), { request: 1, outcome: status, conclusion: 'c', closer: 1 },
      5000)).board;
    assert.equal(state(board), status);
  }
});
