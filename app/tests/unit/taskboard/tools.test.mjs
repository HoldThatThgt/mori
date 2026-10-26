// kernel/boardTools.ts 与 kernel/teamExtension.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §6.2、§6.3、§7.1、
// §7.5、§14.6 T-T1/T-P1/T-T5/T-F6）：prepareArguments 的键名与编号写法、执行时错误的两行格式、各会话的 schema 与枚举、
// 交接之后与强制填写的运行里的拒绝（带 terminate）、mori-team 注册工具与钩子。执行一方是测试写的 executor（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';

const T = await loadKernelModule('src/kernel/boardTools.ts');
const X = await loadKernelModule('src/kernel/teamExtension.ts');
const roles = await loadKernelModule('src/kernel/roles.ts');

/** 角色：planner 持有立项与结案，executor、reviewer；基座 mori 持有对话（synthetic）。 */
const LOAD = roles.parseRoleFiles([
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans the work\nseats: [create, close]\n'
    + '---\n' },
  { file: '.mori/agents/reviewer.md', text: '---\nname: reviewer\ndescription: Reviews changes\n---\n' },
], { pickExists: () => true, parseFrontmatter });
const BASE_ONLY = roles.parseRoleFiles([], { pickExists: () => true, parseFrontmatter });

/** 一个会话的工具信息。 */
function info(kind, role, load = LOAD) {
  return { kind, role, roles: load.roles, merged: load.merged, team: true };
}

/** 记下调用、按给定结果回答的 executor。 */
function executor(reply = { ok: true, text: 'fine' }) {
  const calls = [];
  return { calls, run: async (name, args, call) => {
    calls.push({ name, args, call });
    return typeof reply === 'function' ? reply(name, args) : reply;
  } };
}

/** 一个工具的定义。 */
function tool(name, kind = 'task', role = 'executor', exec = executor()) {
  return T.boardTools([name], info(kind, role), exec, true)[0];
}

// ---- TB-49 参数归一与错误格式 ----

test('TB-49 prepareArguments: key spellings are normalized to the schema names', () => {
  const handoff = tool('task_handoff');
  const prepared = handoff.prepareArguments({ Task_ID: 't3', CONCLUSION: 'Fixed', Outcome: 'done',
    openItems: ['check logs'], Evidence: ['#2'] });
  assert.deepEqual(prepared, { task: 'T3', conclusion: 'Fixed', outcome: 'done', open_items: ['check logs'],
    evidence: ['#2'] });
  const create = tool('task_create', 'create', 'planner');
  assert.deepEqual(create.prepareArguments({ requestId: 'R1', title: 'Fix', description: 'Do', assignee: 'executor',
    readOnly: true, dependsOn: ['t1', '2'] }), { request: 1, title: 'Fix', description: 'Do', assignee: 'executor',
    read_only: true, depends_on: ['T1', 'T2'] });
});

test('TB-49 prepareArguments: task numbers T3, t3, 3 and request numbers 1, "1", R1, request 1', () => {
  const read = tool('board_read');
  for (const value of ['T3', 't3', '3', 3]) assert.deepEqual(read.prepareArguments({ task: value }), { task: 'T3' });
  for (const value of [1, '1', 'R1', 'r1', 'request 1', 'Request 1']) {
    assert.deepEqual(read.prepareArguments({ request: value }), { request: 1 }, String(value));
  }
  assert.deepEqual(read.prepareArguments({ task: 'the login task' }), { task: 'the login task' },
    'not a task number: left for the execute-time error');
});

test('TB-49 prepareArguments: integer evidence becomes #n, null means not written, unknown keys are dropped', () => {
  const handoff = tool('task_handoff');
  assert.deepEqual(handoff.prepareArguments({ conclusion: 'Done', outcome: 'done', evidence: [3, '#4', '[#5]'],
    next: null, mood: 'happy' }), { conclusion: 'Done', outcome: 'done', evidence: ['#3', '#4', '[#5]'] });
  const session = tool('read_session');
  assert.deepEqual(session.prepareArguments({ task: '1', from: '2', to: 3 }), { task: 'T1', from: 2, to: 3 });
  assert.equal(session.prepareArguments('not an object'), 'not an object', 'pi reports it');
});

test('TB-49 prepareArguments: enum values are not mapped to synonyms', () => {
  assert.deepEqual(tool('task_handoff').prepareArguments({ conclusion: 'x', outcome: 'finished' }),
    { conclusion: 'x', outcome: 'finished' });
});

test('TB-49 execute-time errors have two lines: the reason, then the correct form', async () => {
  const exec = executor({ ok: false, reason: 'T1 is closed.', usage: true });
  const result = await tool('task_handoff', 'task', 'executor', exec).execute('call-1', { conclusion: 'x',
    outcome: 'done' }, undefined, undefined, {});
  assert.equal(result.isError, true);
  const lines = result.content[0].text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'T1 is closed.');
  assert.match(lines[1], /^Correct form: task_handoff \{/);
  const close = T.errorText('task_handoff', 'close', { ok: false, reason: 'T1 is not with you.', usage: true });
  assert.match(close.split('\n')[1], /close_done/, 'the close session gets its own form');
  for (const name of ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit',
    'request_update', 'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close']) {
    assert.match(T.toolUsage(name, 'task'), new RegExp(`^Correct form: ${name} `), name);
  }
});

test('TB-49 a reason that already has two lines, or is not a usage error, is kept as it is', async () => {
  const twoLines =
    'evidence: #9 is not a finished tool call in your session.\nCite the numbers of your own tool results.';
  assert.equal(T.errorText('task_handoff', 'task', { ok: false, reason: twoLines, usage: false }), twoLines);
  const stopped = await tool('agent_message', 'task', 'executor', executor({ ok: false, reason: 'Stopped by the user.',
    usage: false })).execute('c', { to: 'reviewer', text: 'hi' }, undefined, undefined, {});
  assert.equal(stopped.content[0].text, 'Stopped by the user.');
  assert.equal(stopped.isError, true);
});

test('TB-49 an executor that throws gives an error result and the run goes on', async () => {
  const exec = { run: async () => { throw new Error('disk full'); } };
  const original = console.error;
  console.error = () => {};
  try {
    const result = await tool('board_read', 'task', 'executor', exec).execute('c', {}, undefined, undefined, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /board_read failed: disk full/);
  } finally {
    console.error = original;
  }
});

// ---- TB-14、TB-50 schema 与枚举 ----

test('TB-50 next drops the session itself, includes mori, and notes seats; assignee lists every role', () => {
  const schema = T.toolSchema('task_handoff', info('task', 'executor'));
  assert.deepEqual(schema.properties.next.enum, ['planner', 'reviewer', 'mori']);
  assert.match(schema.properties.next.description, /planner \(create, close\): Plans the work/);
  assert.match(schema.properties.next.description, /mori \(dialog\): General-purpose agent/);
  const create = T.toolSchema('task_create', info('create', 'planner'));
  assert.deepEqual(create.properties.assignee.enum, ['executor', 'planner', 'reviewer', 'mori']);
  assert.deepEqual(Object.keys(create.properties), ['request', 'title', 'description', 'assignee', 'read_only',
    'depends_on'], '§6.3 order');
});

test('TB-50 with only the base agent the task instance has no next', () => {
  const schema = T.toolSchema('task_handoff', info('task', 'mori', BASE_ONLY));
  assert.equal(schema.properties.next, undefined);
  assert.deepEqual(Object.keys(schema.properties), ['task', 'conclusion', 'outcome', 'open_items', 'evidence']);
});

test('TB-14 the close session hands off without evidence; task instances have the §6.3 outcomes', () => {
  const close = T.toolSchema('task_handoff', info('close', 'planner'));
  assert.deepEqual(Object.keys(close.properties), ['task', 'conclusion', 'outcome', 'next']);
  assert.deepEqual(close.properties.outcome.enum, ['close_done', 'close_failed', 'continue', 'need_user']);
  assert.deepEqual(close.required, ['task', 'conclusion', 'outcome']);
  const task = T.toolSchema('task_handoff', info('task', 'executor'));
  assert.deepEqual(task.properties.outcome.enum, ['continue', 'dead_end', 'blocked', 'need_user', 'done', 'pass',
    'fail']);
  assert.deepEqual(task.required, ['conclusion', 'outcome']);
});

test('TB-49 every TaskBoard tool has the §6.3 parameters in order and an English description', () => {
  const expected = {
    board_read: ['request', 'task'], read_session: ['task', 'role', 'from', 'to'],
    agent_message: ['to', 'text', 'wait', 'request'], request_submit: ['title', 'goal', 'acceptance', 'quote'],
    request_update: ['request', 'quote'], request_cancel: ['request', 'reason'],
    task_edit: ['task', 'title', 'description', 'assignee', 'depends_on'], reply_via_dialog: ['note'],
    request_close: ['request', 'outcome', 'conclusion'],
  };
  for (const [name, keys] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(T.toolSchema(name, info('create', 'planner')).properties), keys, name);
    assert.match(T.toolDescription(name, info('create', 'planner')), /^[A-Z][\x20-\x7e]+$/, name);
  }
});

test('TB-49 tools come in the §6.3 order, only the names the session has, with defaultActive as asked', () => {
  const defs = T.boardTools(['read', 'task_handoff', 'board_read', 'agent_message', 'read_session'],
    info('task', 'executor'), executor(), false);
  assert.deepEqual(defs.map((def) => def.name), ['board_read', 'read_session', 'agent_message', 'task_handoff']);
  assert.ok(defs.every((def) => def.defaultActive === false));
  assert.equal(defs[0].parameters.type, 'object', 'a plain JSON Schema object (§14.6 T-T1)');
});

test('TB-04 agent_message for an off-mode question and for the dialog session that has both modes', () => {
  const off = T.toolDescription('agent_message', { ...info('ask', 'executor'), team: false });
  assert.match(off, /^Ask another role one question/);
  const dialog = T.toolDescription('agent_message', info('dialog', 'mori'));
  assert.match(dialog, /^Ask another role one question.*In task mode: send a message to a role/);
  assert.match(dialog, / The user never sees these messages\.$/, 'M26: task messages are not for the user');
  assert.match(T.toolDescription('agent_message', info('task', 'executor')), /The user never sees these messages\.$/);
});

test('TB-44 reply_via_dialog in a merged session says the answer is your own reply (M26); split keeps the dialog '
  + 'agent', () => {
  assert.equal(T.toolDescription('reply_via_dialog', { ...info('dialog', 'mori'), merged: true }),
    'No collaboration needed: you answer the user directly in your reply.');
  assert.match(T.toolDescription('reply_via_dialog', { ...info('create', 'planner'), merged: false }),
    /^No collaboration needed: the dialog agent answers the user directly\./);
});

test('TB-29 the read_session usage line names no particular role ("<role>", not executor)', () => {
  assert.equal(T.toolUsage('read_session', 'dialog'),
    'Correct form: read_session {"task":"T1","role":"<role>"}; page with "from" and "to" (turn numbers)');
});

// ---- TB-15 一回合一次交接 ----

test('TB-15 after a handoff every later call in the run is refused with terminate, before the approval card', () => {
  const guard = { handedOff: 'T1', forcedTool: null };
  for (const name of ['read', 'bash', 'task_handoff', 'board_read']) {
    assert.deepEqual(T.guardToolCall(guard, name), { block: true, reason: 'You handed off T1; stop here.',
      terminate: true }, name);
  }
  assert.equal(T.guardToolCall({ handedOff: null, forcedTool: null }, 'bash'), undefined, 'no handoff yet');
});

test('TB-15 the task instance handoff result carries terminate so the batch ends the run', async () => {
  const exec = executor({ ok: true, text: 'Handed off T1 (done) to Mori (closing).', terminate: true });
  const result = await tool('task_handoff', 'task', 'executor', exec).execute('call-7', { conclusion: 'Fixed',
    outcome: 'done', evidence: ['#1'] }, undefined, undefined, {});
  assert.equal(result.terminate, true);
  assert.equal(result.isError, undefined);
  assert.equal(exec.calls[0].call.toolCallId, 'call-7');
});

test('TB-18 a forced run refuses every tool but the form tool, with terminate', () => {
  const guard = { handedOff: null, forcedTool: 'task_handoff' };
  assert.equal(T.guardToolCall(guard, 'task_handoff'), undefined);
  assert.deepEqual(T.guardToolCall(guard, 'read'), { block: true,
    reason: 'Only task_handoff works in this turn; call it now.', terminate: true });
  assert.deepEqual(T.guardToolCall({ handedOff: null, forcedTool: 'request_close' }, 'task_handoff').terminate, true);
});

// ---- mori-team 扩展 ----

/** 记下注册的工具与处理器的 pi 扩展 API（synthetic）。 */
function fakeApi() {
  const tools = [];
  const handlers = new Map();
  return {
    tools, handlers,
    registerTool: (def) => tools.push(def),
    on: (event, handler) => handlers.set(event, handler),
  };
}

test('TB-15 mori-team registers the tools and puts the tool_call guard before approval', () => {
  const api = fakeApi();
  let guard = { handedOff: null, forcedTool: null };
  const defs = T.boardTools(['task_handoff'], info('task', 'executor'), executor(), true);
  X.teamExtension({ tools: defs, toolCall: (event) => T.guardToolCall(guard, event.toolName) })(api);
  assert.deepEqual(api.tools.map((def) => def.name), ['task_handoff']);
  const onCall = api.handlers.get('tool_call');
  assert.equal(onCall({ toolName: 'read', toolCallId: 'a', input: {} }), undefined);
  guard = { handedOff: 'T1', forcedTool: null };
  assert.deepEqual(onCall({ toolName: 'read', toolCallId: 'b', input: {} }).terminate, true);
  assert.equal(api.handlers.has('context'), false, 'hooks that are not given are not registered');
});

test('TB-30 the context hook appends the work card as a separate last custom message', () => {
  const api = fakeApi();
  X.teamExtension({ tools: [],
    card: () => '<mori-work-card>\nYou are executor on T1 (request 1).\n</mori-work-card>' })(api);
  const messages = [{ role: 'user', content: 'start', timestamp: 1 },
    { role: 'toolResult', content: [], timestamp: 2 }];
  const result = api.handlers.get('context')({ type: 'context', messages });
  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.messages.slice(0, 2), messages, 'earlier messages are not changed');
  const card = result.messages.at(-1);
  assert.equal(card.role, 'custom');
  assert.equal(card.customType, 'mori.work_card');
  assert.equal(card.display, false);
  assert.match(card.content, /^<mori-work-card>\n/);
  assert.equal(messages.length, 2, 'the input list is not changed (nothing is written to the session)');
  const none = fakeApi();
  X.teamExtension({ tools: [], card: () => null })(none);
  assert.equal(none.handlers.get('context')({ type: 'context', messages }), undefined, 'no card, no change');
});
