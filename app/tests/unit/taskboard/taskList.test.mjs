// 界面 state/taskList.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §13.13、§15；docs/v1/screens/team-tasks.md）：
// 页签出现的条件、Running / Finished、阶段行按钮的文字、task 卡的第二行、View transcript 的按钮、交接的头一行、
// 依赖与消息的一行、会话视图的标题与模型一行、只读对话流里的 Running…。视图与会话条目是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const L = await loadKernelModule('src/renderer/src/state/taskList.ts');

const HOLDERS = { dialog: 'chat', create: 'planner', close: 'planner' };
const T0 = Date.UTC(2026, 9, 26, 1, 0, 0);

/** synthetic 的 TaskView。 */
function task(id, over = {}) {
  return { id, title: `Task ${id}`, status: 'active', assignee: 'executor', holder: 'executor', phase: 'starting',
    waitingFor: [], current: null, modelNote: null, chain: [], createdAt: T0, closedAt: null, dependsOn: [],
    sessionRoles: [], ...over };
}

/** synthetic 的 BoardView：需求 1 带这些 task。 */
function board(tasks, over = {}) {
  return { requests: [{ no: 1, title: 'Login page is blank', status: 'open', state: 'running', createdAt: T0,
    closedAt: null, conclusion: null, ruledOut: [], question: null, tasks, closeSession: false, ...over }],
  teamEdited: false };
}

const context = (view) => ({ view, holders: HOLDERS, cwd: 'D:\\work' });

// ---- TB-81 列表 ----

test('TB-81 the tabs show when the board has a request or team mode is on, not otherwise', () => {
  const empty = { requests: [], teamEdited: false };
  assert.equal(L.tasksShown(empty, 'off'), false);
  assert.equal(L.tasksShown(empty, 'always'), true);
  assert.equal(L.tasksShown(empty, 'once'), true);
  assert.equal(L.tasksShown(board([]), 'off'), true, 'after team mode is turned off');
});

test('TB-81 Running lists pending, active and waiting_user by id; Finished the rest, stopped included, newest first',
  () => {
    const view = board([task('T1', { status: 'done', phase: 'done' }), task('T2', { status: 'pending', phase: 'pending',
      holder: null }), task('T3', { status: 'stopped', phase: 'stopped' }), task('T4'),
    task('T5', { status: 'waiting_user', phase: 'asked' }), task('T6', { status: 'failed', phase: 'failed' }),
    task('T10', { status: 'cancelled', phase: 'cancelled' })]);
    const { running, finished } = L.taskSections(view);
    assert.deepEqual(running.map((item) => item.task.id), ['T2', 'T4', 'T5']);
    assert.deepEqual(finished.map((item) => item.task.id), ['T10', 'T6', 'T3', 'T1']);
    const back = board([task('T3')]);
    assert.deepEqual(L.taskSections(back).running.map((item) => item.task.id), ['T3'], 'a task handed back');
  });

test('TB-81 the stage-line button counts running tasks, else finished ones (stopped counts as finished)', () => {
  assert.equal(L.tasksButtonText({ requests: [], teamEdited: false }), null);
  assert.equal(L.tasksButtonText(board([])), null, 'no task yet: no button');
  assert.equal(L.tasksButtonText(board([task('T1')])), '1 running task');
  assert.equal(L.tasksButtonText(board([task('T1'), task('T2', { status: 'pending', phase: 'pending' }),
    task('T3', { status: 'done', phase: 'done' })])), '2 running tasks');
  assert.equal(L.tasksButtonText(board([task('T1', { status: 'stopped', phase: 'stopped' })])), '1 task finished');
  assert.equal(L.tasksButtonText(board([task('T1', { status: 'done', phase: 'done' }),
    task('T2', { status: 'stopped', phase: 'stopped_restart' })])), '2 tasks finished');
});

test('TB-81 a card line is Request · role · what it is doing (with the model note) · duration', () => {
  const running = task('T1', { phase: 'running', current: { toolName: 'bash', args: { command: 'npm test' } },
    modelNote: 'Switched to fake/b' });
  const view = board([running, task('T2', { status: 'pending', phase: 'pending', holder: null, assignee: 'mori',
    waitingFor: ['T1'] }), task('T3', { status: 'done', phase: 'done', holder: null, closedAt: T0 + 6 * 60_000 })]);
  const [first, second, third] = view.requests[0].tasks.map((item) => ({ task: item, request: view.requests[0] }));
  const parts = L.cardParts(first, context(view), T0 + 72 * 60_000);
  assert.equal(parts.request, 'Request 1');
  assert.equal(parts.role, 'executor');
  assert.match(parts.doing, /npm test · Switched to fake\/b$/);
  assert.equal(parts.duration, '1 h 12 min');
  assert.deepEqual(L.cardParts(second, context(view), T0 + 1000), { request: 'Request 1', role: 'Mori',
    doing: 'Waiting for T1', duration: '<1 min' }, 'no holder: the assignee; the base role is Mori');
  assert.equal(L.cardParts(third, context(view), T0 + 60 * 60_000).duration, '6 min', 'until closedAt');
});

test('TB-81 one session role gives View transcript; several give View transcript (<role>)', () => {
  assert.deepEqual(L.transcriptButtons(task('T1')), []);
  assert.deepEqual(L.transcriptButtons(task('T1', { sessionRoles: ['mori'] })), [{ of: { kind: 'task', task: 'T1',
    role: 'mori' }, label: 'View transcript', aria: 'View transcript for Mori on T1' }]);
  const two = L.transcriptButtons(task('T1', { sessionRoles: ['executor', 'reviewer'] }));
  assert.deepEqual(two.map((item) => item.label),
    ['View transcript (executor)', 'View transcript (reviewer)']);
});

// ---- TB-82 task 的视图 ----

/** synthetic 的一棒。 */
const baton = (over) => ({ n: 1, role: 'executor', byClose: false, outcome: 'done', reason: null, conclusion: 'Done.',
  next: null, suggestedNext: null, openItems: [], evidence: [], routedTo: { kind: 'close' }, at: T0,
  session: null, ...over });

test('TB-82 a handoff head reads #n role · outcome → route in the §15 words', () => {
  const cases = [
    [baton({ outcome: 'continue', routedTo: { kind: 'role', role: 'reviewer' } }), '#1 executor · Continue → reviewer'],
    [baton({ outcome: 'dead_end', routedTo: { kind: 'role', role: 'mori' } }), '#1 executor · Dead end → Mori'],
    [baton({ outcome: 'blocked' }), '#1 executor · Blocked → planner (closing)'],
    [baton({ outcome: 'need_user', routedTo: { kind: 'create' } }),
      '#1 executor · Needs your decision → planner (planning)'],
    [baton({ outcome: 'pass' }), '#1 executor · Pass → planner (closing)'],
    [baton({ outcome: 'fail', routedTo: { kind: 'role', role: 'executor' } }), '#1 executor · Fail → executor'],
    [baton({ n: 3, role: 'planner', byClose: true, outcome: 'close_done', routedTo: { kind: 'end', status: 'done' } }),
      '#3 planner · Closed as done → Done'],
    [baton({ role: 'planner', byClose: true, outcome: 'close_failed', routedTo: { kind: 'end', status: 'failed' } }),
      '#1 planner · Closed as failed → Failed'],
    [baton({ n: 2, role: 'mori', outcome: null, reason: 'no_handoff' }), '#2 Mori · no handoff → planner (closing)'],
    [baton({ role: 'mori', outcome: null, reason: 'close_undecided' }),
      '#1 Mori · close didn’t decide → planner (closing)'],
  ];
  for (const [item, want] of cases) assert.equal(L.handoffHead(item, HOLDERS), want);
});

test('TB-82 evidence, dependency and message lines', () => {
  assert.equal(L.evidenceLine({ tag: '#3', title: 'Run npm test', ok: true }), '✓ #3 Run npm test');
  assert.equal(L.evidenceLine({ tag: '#4', title: 'Run npm run lint', ok: false }), '✗ #4 Run npm run lint');
  const view = board([task('T1', { status: 'done', phase: 'done' }), task('T2', { phase: 'running',
    current: { toolName: 'read', args: { path: 'D:\\work\\src\\a.ts' } } })]);
  assert.equal(L.dependencyLine({ id: 'T1', title: 'Task T1', status: 'done' }, context(view)), 'T1 Task T1 · Done');
  assert.match(L.dependencyLine({ id: 'T2', title: 'Task T2', status: 'active' }, context(view)),
    /^T2 Task T2 · Read /);
  const at = new Date(2026, 9, 26, 9, 5).getTime();
  assert.equal(L.messageHead({ from: 'mori', text: 'x', at }), 'Mori · 09:05');
  assert.deepEqual(L.closeButton(1, HOLDERS), { of: { kind: 'close', request: 1 }, label: 'View transcript (closing)',
    aria: 'View transcript for planner on Request 1' });
});

// ---- TB-83 实例的会话 ----

let seq = 0;
const entry = (message) => ({ type: 'message', id: `e${(seq += 1)}`, parentId: null, timestamp: '', message });

test('TB-83 the transcript title, the Model line from the last assistant message, and No activity yet', () => {
  assert.equal(L.transcriptTitle({ kind: 'task', task: 'T1', role: 'mori' }, HOLDERS, 'Find and fix'),
    'Mori · T1 Find and fix');
  assert.equal(L.transcriptTitle({ kind: 'close', request: 2 }, HOLDERS, ''), 'planner · Request 2 (closing)');
  const entries = [
    entry({ role: 'user', content: [{ type: 'text', text: '[Mori] You are executor on T1.' }], timestamp: T0 }),
    entry({ role: 'assistant', content: [{ type: 'text', text: 'a' }], provider: 'deepseek', model: 'old',
      stopReason: 'stop', timestamp: T0 + 1 }),
    entry({ role: 'assistant', content: [{ type: 'text', text: 'b' }], provider: 'glm', model: 'glm-5.3',
      stopReason: 'stop', timestamp: T0 + 2 }),
  ];
  assert.equal(L.modelLine(entries), 'Model glm/glm-5.3');
  assert.equal(L.modelLine([]), null);
  assert.equal(L.noActivity([]), true);
  assert.equal(L.noActivity([{ type: 'custom', id: 'c', parentId: null, timestamp: '', customType: 'mori.instance',
    data: {} }]), true);
  assert.equal(L.noActivity(entries), false);
});

test('TB-83 a delivery is a user bubble; a tool without a result is Running… while the instance runs', () => {
  const entries = [
    entry({ role: 'user', content: [{ type: 'text', text: '[Mori] You are executor on T1.' }], timestamp: T0 }),
    entry({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
      provider: 'fake', model: 'm', stopReason: 'toolUse', timestamp: T0 + 1 }),
  ];
  const running = L.sessionTranscript(entries, true);
  assert.deepEqual(running.items.map((item) => item.kind), ['user', 'assistant']);
  assert.equal(running.items[0].text, '[Mori] You are executor on T1.');
  assert.equal(running.tools.c1.status, 'running');
  assert.equal(L.sessionTranscript(entries, false).tools.c1.status, 'interrupted', 'after the run: as the chat does');
});
