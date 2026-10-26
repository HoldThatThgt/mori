// Background tasks 的后台进程部分（docs/specs/parallel-agents-taskboard.md §13.10、§13.13；docs/v1/screens/team-tasks.md）：
// TaskView 与 RequestView 的新字段、board.readTask 的 task 详情、board.readSession 读实例会话与结案会话、两个只读命令
// 不写任何东西，以及 session.stopTask 只停一个 task。用测试写的会话表（teamHarness.mjs，synthetic TeamHost）驱动 Team，
// 不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  B, SPLIT, addTask, beginRun, finishRun, nextDelivery, runDelivery, setup, until, workThen,
} from './teamHarness.mjs';
import { loadKernelModule } from '../load.mjs';

const shared = await loadKernelModule('src/shared/team.ts');

/** 等 Team 处理完（setTimeout(0) 的 afterRun、写出 board.json）。 */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** 视图里的一个 task。 */
const viewOf = (team, id) => team.view().requests.flatMap((request) => request.tasks).find((task) => task.id === id);

/** 一个只有一次投递与一条助手回复的实例会话文件（synthetic），写进这个用户会话的实例会话目录。 */
function writeInstanceFile(cwd, id, reply) {
  const sm = SessionManager.inMemory(cwd);
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: '[Mori] You are executor on T1.' }],
    timestamp: 1 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: reply }], provider: 'fake', model: 'old',
    stopReason: 'stop', timestamp: 2, api: 'openai-completions', usage: {} });
  const dir = join(cwd, 'teams', 'U', 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-10-26T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, [sm.getHeader(), ...sm.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

/**
 * 登记需求 1 与交给 executor 的 T1，同一次写入里把它停下（stopped，持有者保留），所以不开实例会话：
 * 读它的会话时读的是会话文件（synthetic 的写入，直接调用 board.ts）。
 */
function stoppedTask(team) {
  team.write((board) => {
    const request = B.submitRequest(board, { title: 'Login page is blank', goal: 'Fix it', acceptance: null,
      quote: null }, { message: 'fix the login page', history: [] }, Date.now());
    const created = B.createTask(request.board, { request: 1, title: 'Find and fix', description: 'Fix it',
      assignee: 'executor', readOnly: false, dependsOn: [] }, Date.now());
    return { board: B.markStopped(created.board, ['T1'], 'user'), error: null };
  });
}

/** 目录下全部文件的内容与修改时间（只读命令前后比较）。 */
function snapshot(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    out[path] = `${statSync(path).mtimeMs}:${readFileSync(path, 'utf8')}`;
  }
  return out;
}

// ---- TB-81 视图的新字段 ----

test('TB-81 board view tasks carry createdAt, closedAt, dependsOn and sessionRoles; requests carry closeSession',
  async () => {
    const { team, host } = await setup(SPLIT, 'A');
    addTask(team);
    addTask(team, { title: 'Review the fix', assignee: 'reviewer', readOnly: true, dependsOn: ['T1'] });
    const pending = viewOf(team, 'T2');
    assert.deepEqual([pending.dependsOn, pending.sessionRoles, pending.closedAt], [['T1'], [], null]);
    assert.equal(pending.createdAt, B.findTask(team.board, 'T2').createdAt);
    const start = await nextDelivery(host, 'U.t1.executor');
    assert.deepEqual(viewOf(team, 'T1').sessionRoles, ['executor'], 'the open instance counts as a session');
    assert.equal(team.view().requests[0].closeSession, false);
    await runDelivery(host, start, workThen('done'));
    const close = await nextDelivery(host, 'U.close.1');
    await until(() => team.view().requests[0].closeSession, 'the close session in the view');
    await runDelivery(host, close, [{ calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Closed.',
      outcome: 'close_done' } }] }]);
    const review = await nextDelivery(host, 'U.t2.reviewer');
    const done = viewOf(team, 'T1');
    assert.equal(done.closedAt, B.findTask(team.board, 'T1').closedAt);
    assert.notEqual(done.closedAt, null);
    assert.deepEqual(viewOf(team, 'T2').sessionRoles, ['reviewer']);
    review.resolve();
  });

test('TB-81 sessionRoles follow the order the roles first took the task, and only roles with a session',
  async () => {
    const { team, host } = await setup(SPLIT, 'A');
    addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    await runDelivery(host, start, [{ calls: [{ name: 'task_handoff', args: { conclusion: 'Needs a review.',
      outcome: 'continue', next: 'reviewer' } }] }]);
    const review = await nextDelivery(host, 'U.t1.reviewer');
    assert.deepEqual(viewOf(team, 'T1').sessionRoles, ['executor', 'reviewer']);
    review.resolve();
  });

// ---- TB-82 board.readTask ----

test('TB-82 board.readTask gives the prompt, dependencies with status, messages and every handoff field in full',
  async () => {
    const { team, host } = await setup(SPLIT, 'A');
    addTask(team, { description: 'Find why the login page is blank.\n\n| a | b |\n| - | - |\n| 1 | 2 |' });
    addTask(team, { title: 'Check it', assignee: 'reviewer', readOnly: true, dependsOn: ['T1'] });
    const start = await nextDelivery(host, 'U.t1.executor');
    const long = `Fixed the blank page. ${'The cause was a missing route. '.repeat(15)}`.trim();
    await beginRun(host, start);
    const message = host.entry('U.t1.executor').api.tools.get('agent_message');
    await message.execute('m1', message.prepareArguments({ to: 'T1', text: '| step | result |\n| - | - |\n| 1 | ok |' }),
      undefined, undefined, {});
    await finishRun(host, start, [{ calls: [{ name: 'bash', args: { command: 'npm test' }, result: 'ok' }] },
      { calls: [{ name: 'task_handoff', args: { conclusion: long, outcome: 'done', evidence: ['#1'],
        open_items: ['Add a test for the route'] } }] }]);
    await until(() => B.findTask(team.board, 'T1').handoffs.length === 1, 'the handoff');
    const detail = team.readTask('T1');
    assert.equal(detail.description, B.findTask(team.board, 'T1').description, 'the prompt in full');
    assert.deepEqual([detail.id, detail.request, detail.requestTitle, detail.readOnly, detail.assignee],
      ['T1', 1, 'Login page is blank', false, 'executor']);
    assert.deepEqual(detail.messages.map((item) => [item.from, item.text]),
      [['executor', '| step | result |\n| - | - |\n| 1 | ok |']]);
    const [baton] = detail.handoffs;
    assert.equal(baton.conclusion, long, 'the conclusion in full, not the first sentence');
    assert.deepEqual([baton.n, baton.role, baton.byClose, baton.outcome, baton.reason, baton.openItems],
      [1, 'executor', false, 'done', null, ['Add a test for the route']]);
    assert.deepEqual(baton.evidence.map((item) => [item.tag, item.ok]), [['#1', true]]);
    assert.match(baton.evidence[0].title, /npm test/);
    assert.deepEqual(baton.routedTo, { kind: 'close' });
    assert.deepEqual(baton.session, { role: 'executor', turns: [1, 1] });
    const check = team.readTask('T2');
    assert.deepEqual(check.dependsOn, [{ id: 'T1', title: 'Find and fix', status: B.findTask(team.board, 'T1').status }]);
    assert.equal(check.readOnly, true);
  });

test('TB-82 a baton the close session writes is byClose with the close role; a program baton has its reason',
  async () => {
    // 没有写入等级的模型：没交接就结束时程序写一棒交给结案（§7.4），不强制填写
    const { team, host } = await setup();
    addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    await runDelivery(host, start, [{ text: 'I stopped without a handoff.' }]);
    const close = await nextDelivery(host, 'U.close.1');
    await runDelivery(host, close, [{ calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Closing it.',
      outcome: 'close_done' } }] }]);
    await until(() => B.findTask(team.board, 'T1').handoffs.length === 2, 'two batons');
    const [program, closing] = team.readTask('T1').handoffs;
    assert.deepEqual([program.role, program.outcome, program.reason, program.byClose],
      ['mori', null, 'no_handoff', false]);
    assert.deepEqual([closing.role, closing.byClose, closing.outcome], ['planner', true, 'close_done']);
    assert.equal(closing.session?.role ?? 'planner', 'planner');
  });

test('TB-82 board.readTask for a task that does not exist says so', async () => {
  const { team } = await setup(SPLIT, 'A');
  assert.throws(() => team.readTask('T9'), { message: 'T9 does not exist.' });
});

// ---- TB-83 board.readSession ----

test('TB-83 board.readSession gives the open instance branch while it runs and running is true', async () => {
  const { team, host } = await setup(SPLIT, 'A');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await beginRun(host, start);
  const read = await team.readSession({ kind: 'task', task: 'T1', role: 'executor' });
  assert.equal(read.running, true);
  assert.deepEqual(read.entries.filter((entry) => entry.type === 'message').map((entry) => entry.message.role),
    ['user']);
  assert.match(read.entries.find((entry) => entry.type === 'message').message.content[0].text, /^\[Mori\] You are/);
  await finishRun(host, start, workThen('done'));
  await settle();
  const after = await team.readSession({ kind: 'task', task: 'T1', role: 'executor' });
  assert.equal(after.running, false);
});

test('TB-83 board.readSession reads a closed instance and a closing session from their files', async () => {
  const { team } = await setup(SPLIT, 'A', {
    prepareUser: (_user, dir) => {
      writeInstanceFile(dir, 'U.t1.executor', 'Done from the file.');
      writeInstanceFile(dir, 'U.close.1', 'Closed from the file.');
    },
  });
  stoppedTask(team);
  await settle();
  const texts = (read) => read.entries.filter((entry) => entry.type === 'message')
    .map((entry) => entry.message.content[0].text);
  const closed = await team.readSession({ kind: 'task', task: 'T1', role: 'executor' });
  assert.deepEqual(texts(closed), ['[Mori] You are executor on T1.', 'Done from the file.']);
  assert.equal(closed.running, false);
  const closing = await team.readSession({ kind: 'close', request: 1 });
  assert.equal(texts(closing).at(-1), 'Closed from the file.');
  assert.deepEqual(viewOf(team, 'T1').sessionRoles, ['executor'], 'a session file counts as a session');
  assert.equal(team.view().requests[0].closeSession, true);
});

// ---- TB-84 只读与边界 ----

test('TB-84 readTask and readSession leave board.json and the session files unchanged and deliver nothing',
  async () => {
    const { team, host, cwd } = await setup(SPLIT, 'A', {
      prepareUser: (_user, dir) => writeInstanceFile(dir, 'U.close.1', 'Closed.'),
    });
    addTask(team, { title: 'Look', readOnly: true });
    const start = await nextDelivery(host, 'U.t1.executor');
    await runDelivery(host, start, workThen('done'));
    await settle(60);
    const dir = join(cwd, 'teams', 'U');
    const before = snapshot(dir);
    const deliveries = host.deliveries.length;
    const events = host.events.length;
    team.readTask('T1');
    await team.readSession({ kind: 'task', task: 'T1', role: 'executor' });
    await team.readSession({ kind: 'close', request: 1 });
    await settle(60);
    assert.deepEqual(snapshot(dir), before, 'board.json and the session files keep content and mtime');
    assert.equal(host.deliveries.length, deliveries, 'no delivery');
    assert.equal(host.events.length, events, 'no event');
  });

test('TB-84 board.readSession reports a missing session, task or request in the spec words', async () => {
  const { team } = await setup(SPLIT, 'A');
  addTask(team, { dependsOn: [] });
  addTask(team, { title: 'Later', dependsOn: ['T1'] });
  await assert.rejects(team.readSession({ kind: 'task', task: 'T2', role: 'reviewer' }),
    { message: 'reviewer has no session on T2.' });
  await assert.rejects(team.readSession({ kind: 'task', task: 'T2', role: 'mori' }),
    { message: 'Mori has no session on T2.' });
  await assert.rejects(team.readSession({ kind: 'close', request: 1 }),
    { message: 'Request 1 has no closing session.' });
  await assert.rejects(team.readSession({ kind: 'task', task: 'T9', role: 'executor' }),
    { message: 'T9 does not exist.' });
  await assert.rejects(team.readSession({ kind: 'close', request: 9 }), { message: 'Request 9 does not exist.' });
});

test('TB-84 the read commands keep working after team mode is turned off', async () => {
  const { team, host } = await setup(SPLIT, 'A');
  await team.setMode('on');
  addTask(team, { readOnly: true });
  const start = await nextDelivery(host, 'U.t1.executor');
  await runDelivery(host, start, workThen('done'));
  await settle(60);
  await team.setMode('off');
  assert.equal(team.readTask('T1').id, 'T1');
  const read = await team.readSession({ kind: 'task', task: 'T1', role: 'executor' });
  assert.ok(read.entries.length > 0);
});

// ---- TB-89 停止一个 task ----

test('TB-89 Stop this task stops only that instance with reason user; the task is stopped and keeps its holder',
  async () => {
    const { team, host } = await setup(SPLIT, 'C');
    addTask(team);
    addTask(team, { title: 'Look around', readOnly: true });
    const first = await nextDelivery(host, 'U.t1.executor');
    const second = await nextDelivery(host, 'U.t2.executor');
    await beginRun(host, first);
    await beginRun(host, second);
    assert.equal(shared.canStopTask(viewOf(team, 'T1')), true);
    await team.stopTask('T1');
    assert.deepEqual(host.aborts, [{ id: 'U.t1.executor', reason: 'user' }], 'only that instance is stopped');
    const task = B.findTask(team.board, 'T1');
    assert.deepEqual([task.status, task.stopReason, task.holder], ['stopped', 'user', { kind: 'role',
      role: 'executor' }]);
    assert.equal(B.findTask(team.board, 'T2').status, 'active', 'the other task runs on');
    const before = host.deliveries.length;
    await finishRun(host, first, [{ text: 'Interrupted.' }]);
    await settle(60);
    assert.equal(host.deliveries.filter((item) => item.id !== 'U.t2.executor').length,
      host.deliveries.slice(0, before).filter((item) => item.id !== 'U.t2.executor').length,
      'no forced fill, no close delivery, no receipt or relay');
    assert.equal(B.findTask(team.board, 'T1').handoffs.length, 0, 'no program handoff');
    assert.equal(viewOf(team, 'T1').phase, 'stopped');
    assert.equal(team.mode, 'off', 'the mode is unchanged');
    await finishRun(host, second, workThen('done'));
  });

test('TB-89 stopping drops the queue of that instance, ends waits on it and keeps the write lock', async () => {
  const { team, host } = await setup(SPLIT, 'A');
  addTask(team);
  addTask(team, { title: 'Also change' });
  addTask(team, { title: 'Ask the executor', assignee: 'reviewer', readOnly: true });
  const first = await nextDelivery(host, 'U.t1.executor');
  const ask = await nextDelivery(host, 'U.t3.reviewer');
  await beginRun(host, first);
  await beginRun(host, ask);
  // 在 T1 实例的投递队列里放一条有人等回复的投递（synthetic：与 agent_message 发给座位会话时同一种 waiter）；
  // T1 正在运行，它留在队列里，停止时清掉，等的一方以 Stopped by the user. 结束。
  let settled = null;
  team.enqueue([...team.lanes.values()].find((lane) => lane.id === 'U.t1.executor'), team.delivery('agent_message',
    { from: 'reviewer', text: 'Which file?' }, { kind: 'message' }, { waiter: { settle: (text) => { settled = text; } } }));
  await team.stopTask('T1');
  assert.equal(settled, 'Stopped by the user.');
  assert.equal(B.findTask(team.board, 'T1').status, 'stopped');
  await finishRun(host, first, [{ text: 'Interrupted.' }]);
  await settle(60);
  assert.equal(team.board.lock, 'T1', 'the stopped write task keeps the lock (§9.2)');
  const waiting = viewOf(team, 'T2');
  assert.deepEqual([waiting.phase, waiting.waitingFor], ['lock_wait', ['T1']]);
  assert.equal(shared.taskPhaseText(waiting, team.view(), team.holders, ''), 'Waiting to change files (T1, stopped)');
  await finishRun(host, ask, workThen('done'));
});

test("TB-89 only starting, running, approval, queued and lock_wait tasks can be stopped; others say T1 isn't running.",
  async () => {
    const phases = shared.TASK_PHASES.filter((phase) => shared.canStopTask({ status: 'active', phase }));
    assert.deepEqual(phases, ['queued', 'lock_wait', 'starting', 'running', 'approval']);
    assert.equal(shared.canStopTask({ status: 'active', phase: 'with_close' }), false);
    assert.equal(shared.canStopTask({ status: 'waiting_user', phase: 'waiting_user' }), false);
    const { team, host } = await setup(SPLIT, 'A');
    addTask(team, { readOnly: true });
    addTask(team, { title: 'After it', dependsOn: ['T1'] });
    await nextDelivery(host, 'U.t1.executor');
    await assert.rejects(team.stopTask('T2'), { message: "T2 isn't running." }, 'pending');
    await assert.rejects(team.stopTask('T9'), { message: 'T9 does not exist.' });
    await team.stopTask('T1');
    await assert.rejects(team.stopTask('T1'), { message: "T1 isn't running." }, 'already stopped');
    assert.equal(B.findTask(team.board, 'T2').status, 'pending', 'a task that depends on it stays pending');
  });

test('TB-89 a queued task is stopped without an instance; handed back with task_edit it continues the same session',
  async () => {
    const { team, host } = await setup(SPLIT, 'A');
    addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    await beginRun(host, start);
    const entry = host.entry('U.t1.executor');
    await team.stopTask('T1');
    await finishRun(host, start, [{ text: 'Interrupted.' }]);
    await settle(60);
    const after = host.deliveries.length;
    team.write((board) => B.editTask(board, { task: 'T1', title: null, description: null, assignee: null,
      dependsOn: null }, Date.now()));
    const back = await until(() => host.deliveries.slice(after).find((item) => item.id === 'U.t1.executor'),
      'the hand-back delivery');
    assert.match(back.text, /^\[Mori\] T1 is back with you\./);
    assert.equal(host.entry('U.t1.executor'), entry, 'the same instance session continues');
    assert.equal(viewOf(team, 'T1').status, 'active');
    back.resolve();
    for (let i = 0; i < 5; i += 1) addTask(team, { title: `Read ${i}`, readOnly: true });
    await until(() => team.view().requests[0].tasks.some((task) => task.phase === 'queued'), 'a queued task');
    const queued = team.view().requests[0].tasks.find((task) => task.phase === 'queued');
    const aborts = host.aborts.length;
    await team.stopTask(queued.id);
    assert.equal(host.aborts.length, aborts, 'no instance to stop');
    assert.equal(B.findTask(team.board, queued.id).status, 'stopped');
  });
