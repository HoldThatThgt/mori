// shared/team.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §6.2、§13.2、§13.3、§13.8、§13.10）：
// 工具调用标题、参数归一、回执与进展摘要的文字、会话文件里自定义条目的校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const team = await loadKernelModule('src/shared/team.ts');
const { toolCallTitle } = team;

const CWD = 'D:\\work\\app';
const holders = { dialog: 'chat', create: 'planner', close: 'planner' };
const teamOn = { cwd: CWD, seatRoles: team.seatRolesOf({ mode: 'always', holders }), task: null };
const teamOff = { cwd: CWD, seatRoles: team.seatRolesOf({ mode: 'off', holders }), task: null };

test('TB-55 TaskBoard tool titles follow the §13.8 table', () => {
  assert.equal(toolCallTitle('board_read', {}, teamOn), 'Read the board');
  assert.equal(toolCallTitle('board_read', { request: 'R1' }, teamOn), 'Read request 1');
  assert.equal(toolCallTitle('board_read', { task_id: 't3' }, teamOn), 'Read T3');
  assert.equal(toolCallTitle('read_session', { task: '2', role: 'reviewer' }, teamOn), 'Read reviewer’s work on T2');
  assert.equal(toolCallTitle('task_handoff', { task: 'T1' }, teamOn), 'Hand off T1');
  assert.equal(toolCallTitle('task_handoff', {}, { ...teamOn, task: 'T4' }), 'Hand off T4');
  assert.equal(toolCallTitle('request_submit', { title: 'x' }, teamOn), 'Register a request');
  assert.equal(toolCallTitle('request_update', { requestId: 'request 2' }, teamOn), 'Add to request 2');
  assert.equal(toolCallTitle('request_cancel', { request: 1 }, teamOn), 'Cancel request 1');
  assert.equal(toolCallTitle('task_create', { request: 1 }, teamOn), 'Create a task');
  assert.equal(toolCallTitle('task_edit', { Task: 'T5' }, teamOn), 'Edit T5');
  assert.equal(toolCallTitle('reply_via_dialog', {}, teamOn), 'Answer directly');
  assert.equal(toolCallTitle('request_close', { request: '3' }, teamOn), 'Close request 3');
});

test('TB-55 agent_message titles: task, seat session, ad-hoc question', () => {
  assert.equal(toolCallTitle('agent_message', { to: 't1', text: 'x' }, teamOn), 'Message T1');
  assert.equal(toolCallTitle('agent_message', { to: 'planner', text: 'x' }, teamOn), 'Message planner');
  assert.equal(toolCallTitle('agent_message', { to: 'memory', text: 'x' }, teamOn), 'Ask memory');
  assert.equal(toolCallTitle('agent_message', { to: 'planner', text: 'x' }, teamOff), 'Ask planner');
  const base = { cwd: CWD, seatRoles: team.seatRolesOf({ mode: 'once', holders: team.baseHolders() }), task: null };
  assert.equal(toolCallTitle('agent_message', { to: 'mori', text: 'x' }, base), 'Message Mori');
});

test('TB-55 missing arguments show … like v0 tool cards', () => {
  assert.equal(toolCallTitle('read_session', {}, teamOn), 'Read …’s work on …');
  assert.equal(toolCallTitle('task_edit', { task: 'abc' }, teamOn), 'Edit …');
  assert.equal(toolCallTitle('agent_message', {}, teamOn), 'Message …');
  assert.equal(toolCallTitle('bash', {}, teamOn), 'Run …');
});

test('TB-55 v0 tools use the English words with paths relative to the working folder', () => {
  assert.equal(toolCallTitle('read', { path: 'D:\\work\\app\\src\\a.ts' }, teamOn), 'Read src/a.ts');
  assert.equal(toolCallTitle('read', { path: 'src/a.ts', offset: 5, limit: 10 }, teamOn), 'Read src/a.ts · lines 5–14');
  assert.equal(toolCallTitle('edit', { path: 'D:/work/app/src/b.ts' }, teamOn), 'Edit src/b.ts');
  assert.equal(toolCallTitle('write', { path: 'C:\\other\\c.ts' }, teamOn), 'Write C:\\other\\c.ts');
  assert.equal(toolCallTitle('bash', { command: 'npm test\necho done' }, teamOn), 'Run npm test …');
  assert.equal(toolCallTitle('grep', { pattern: 'TODO' }, teamOn), 'Search TODO');
  assert.equal(toolCallTitle('find', { pattern: '*.ts' }, teamOn), 'Find *.ts');
  assert.equal(toolCallTitle('ls', {}, teamOn), 'List .');
  assert.equal(toolCallTitle('mcp__docs__search', {}, teamOn), 'docs · search');
  assert.equal(toolCallTitle('constructor', {}, teamOn), 'constructor');
  assert.equal(team.TEAM_TOOLS.length, 11);
});

test('TB-49 task and request numbers and key spellings are normalized', () => {
  for (const value of ['T3', 't3', '3', 3, ' T3 ']) assert.equal(team.normalizeTaskId(value), 'T3', String(value));
  for (const value of ['R3', 'x3', 0, -1, 1.5, null, 'T']) {
    assert.equal(team.normalizeTaskId(value), null, String(value));
  }
  for (const value of [1, '1', 'R1', 'r1', 'request 1', 'Request 1']) {
    assert.equal(team.normalizeRequestNo(value), 1, String(value));
  }
  for (const value of ['T1', 'one', 0, null]) assert.equal(team.normalizeRequestNo(value), null, String(value));
  assert.equal(team.argOf({ task_id: 'T1' }, 'task'), 'T1');
  assert.equal(team.argOf({ taskId: 'T2' }, 'task'), 'T2');
  assert.equal(team.argOf({ TASK: 'T3' }, 'task'), 'T3');
  assert.equal(team.argOf({ openItems: ['a'] }, 'open_items')[0], 'a');
  assert.equal(team.argOf({ title: 'x' }, 'task'), undefined);
});

test('TB-08 receipt texts, with the quote cut at 120 characters', () => {
  const base = { request: 1, title: 'Login page is blank', at: 0 };
  assert.equal(team.receiptText({ ...base, kind: 'registered', quote: null }),
    'Request 1 registered · Login page is blank');
  assert.equal(team.receiptText({ ...base, kind: 'added', quote: 'Keep the old API' }),
    'Added to request 1: “Keep the old API”');
  const long = 'x'.repeat(130);
  assert.equal(team.receiptText({ ...base, kind: 'added', quote: long }), `Added to request 1: “${'x'.repeat(120)}…”`);
  assert.equal(team.receiptText({ ...base, kind: 'cancelled', quote: null }), 'Request 1 cancelled');
});

/** @brief 一个 task 视图。 */
function taskView(fields) {
  return { id: 'T1', title: 'Find and fix', status: 'active', holder: 'executor', phase: 'running', waitingFor: [],
    current: null, modelNote: null, chain: [], ...fields };
}

test('TB-37 progress words: duration, request state, task phase, handoff chain', () => {
  assert.equal(team.durationText(59_000), '<1 min');
  assert.equal(team.durationText(6 * 60_000 + 5_000), '6 min');
  assert.equal(team.durationText(72 * 60_000), '1 h 12 min');
  assert.equal(team.requestStateText('waiting_create', holders), 'Waiting for planner');
  assert.equal(team.requestStateText('with_close', team.baseHolders()), 'With Mori');
  const stopped = taskView({ id: 'T2', status: 'stopped', phase: 'stopped' });
  const waiting = taskView({ id: 'T3', status: 'active', phase: 'lock_wait', waitingFor: ['T2'] });
  const view = { requests: [{ no: 1, title: 'x', status: 'open', state: 'running', createdAt: 0, closedAt: null,
    conclusion: null, ruledOut: [], question: null, tasks: [stopped, waiting] }] };
  assert.equal(team.taskPhaseText(waiting, view, holders, CWD), 'Waiting to change files (T2, stopped)');
  const running = taskView({ current: { toolName: 'bash', args: { command: 'npm test' } } });
  assert.equal(team.taskPhaseText(running, view, holders, CWD), 'Run npm test');
  assert.equal(team.taskPhaseText(taskView({ current: null }), view, holders, CWD), 'Starting');
  assert.equal(team.taskPhaseText(taskView({ phase: 'pending', waitingFor: ['T2', 'T4'] }), view, holders, CWD),
    'Waiting for T2, T4');
  assert.equal(team.taskPhaseText(taskView({ phase: 'stopped_restart' }), view, holders, CWD),
    'Stopped (Mori restarted)');
  const chain = [{ role: 'executor', outcome: 'done', line: 'Fixed' },
    { role: 'mori', outcome: null, line: team.PROGRAM_HANDOFF_LINES.no_handoff }];
  assert.equal(team.chainText(chain, true), 'executor: Fixed → Mori: no handoff');
  assert.equal(team.chainText(chain, false), 'Fixed → no handoff', 'TB-37 no role files: no role names (M13)');
});

test('TB-58 the mode notice reads Task mode on / on until done / off, like Claude\'s Fast mode on / off', () => {
  assert.deepEqual(['always', 'once', 'off'].map(team.modeNoticeText),
    ['Task mode on', 'Task mode on until done', 'Task mode off']);
});

test('TB-12 custom entries written by Mori parse with their schemas', () => {
  assert.deepEqual(team.TeamEntrySchema.parse({ mode: 'always' }), { mode: 'always' });
  // 旧条目里的 tools（synthetic）读得出、被丢掉：mori.team 只有 mode（file-system-permissions.md §8.6）
  assert.deepEqual(team.TeamEntrySchema.parse({ mode: 'always', tools: ['read', 'bash'] }), { mode: 'always' });
  assert.ok(!team.TeamEntrySchema.safeParse({ mode: 'on' }).success);
  assert.ok(team.ReceiptEntrySchema.safeParse({ kind: 'added', request: 1, title: 't', quote: 'q', at: 1 }).success);
  assert.ok(team.WakeEntrySchema.safeParse({ messageId: 'e1', kind: 'request_closed' }).success);
  assert.ok(team.InstanceEntrySchema.safeParse({ kind: 'task', role: 'executor', task: 'T3' }).success);
  assert.ok(!team.InstanceEntrySchema.safeParse({ kind: 'task', role: 'executor', task: 't3' }).success);
  assert.ok(team.CreateCursorEntrySchema.safeParse({ entryId: null }).success);
  assert.deepEqual(Object.values(team.TEAM_ENTRY_TYPES).sort(), ['mori.create_cursor', 'mori.instance',
    'mori.progress', 'mori.receipt', 'mori.team', 'mori.wake']);
});
