// kernel/team.ts（与 teamRuns.ts、teamTools.ts、teamView.ts）的单元测试（docs/specs/parallel-agents-taskboard.md §7、§8.2、
// §8.3、§9、§10.1、§11.3）：用测试写的会话表（synthetic TeamHost：内存里的 pi SessionManager，运行由测试一步步发出 pi 事件）
// 驱动 Team，检查交接之后的拒绝与 terminate、证据编号、路由、没交接时的兜底与强制填写、投递合并、同时运行上限、
// 后台批准卡、关闭模式下的临时提问。会话表在 teamHarness.mjs。不连模型，也不起 Electron。
// 文件系统规格之后（docs/specs/file-system-permissions.md §8.3、§8.5、§8.6）：实例的工具白名单都是默认工具 + mcp__* +
// 职责工具，收窄（Team.narrowingFor）随实例的设置交给路径闸；对话会话每次运行只动职责工具，协作模式下的限制在路径闸第 2 步。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  B, SPLIT, addTask, beginRun, deps, finishRun, nextDelivery, roles, runDelivery, setup, text, until, workThen,
} from './teamHarness.mjs';

const { ApprovalPolicy } = await loadKernelModule('src/kernel/approval.ts');
const instances = await loadKernelModule('src/kernel/instances.ts');

/** pi 的默认工具（setup 的 baseTools）加全部 MCP 工具：五种实例碰文件的部分都是它（§8.6） */
const FILE_TOOLS = ['read', 'bash', 'edit', 'write', 'mcp__*'];
/** 协作模式下对话会话的拒绝原文（§8.3，整句） */
const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';

/**
 * @brief 一个批准扩展的 tool_call 处理器（synthetic 的 pi：只收下这个处理器，ctx 带工作路径与会话 id）。
 * @param output GateOutput（send 由这里补上）
 * @param sessionId pi 会话 id
 * @return call(toolName, input)：pi 拿到的结果的 Promise
 */
function gateCall(output, sessionId) {
  const gate = new ApprovalPolicy().gate({ ...output, send: () => undefined });
  let handler;
  gate.extension()({ on: (name, fn) => { if (name === 'tool_call') handler = fn; } });
  const ctx = { cwd: output.cwd, signal: undefined, sessionManager: { getSessionId: () => sessionId } };
  let n = 0;
  return (toolName, input = {}) => handler({ type: 'tool_call', toolCallId: `c${(n += 1)}`, toolName, input }, ctx);
}

/** @brief 实例的批准扩展，照 sessions.ts 的 createEntry：instanceSetup 的 gate 加上 kind 与 send。 */
function instanceCall(spec) {
  const setup = instances.instanceSetup(spec, null, spec.id);
  return gateCall({ ...setup.gate, kind: setup.kind }, spec.id);
}

/** @brief 用户会话的批准扩展，照 sessions.ts 的 startUser：收窄每次调用时取 team.userNarrowing()。 */
function userCall(team, cwd) {
  return gateCall({ prefix: '', cwd, kind: 'user', userSessionId: 'U', narrowing: () => team.userNarrowing() }, 'U');
}

// ---- TB-15、TB-16、TB-14 ----

test('TB-15 after task_handoff the later calls of the run are refused with terminate; the handoff routes to close',
  async () => {
    const { team, host } = await setup();
    const task = addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    assert.match(start.text, /^\[Mori\] You are executor on T1 \(request 1\)\. Start work\./);
    const results = await runDelivery(host, start, [
      { calls: [{ name: 'bash', args: { command: 'npm test' }, result: 'all tests pass' }] },
      { calls: [{ name: 'task_handoff', args: { conclusion: 'Fixed the login page.', outcome: 'done',
        evidence: ['#1'] } }, { name: 'read', args: { path: 'a.ts' } }] },
      { calls: [{ name: 'bash', args: { command: 'echo more' } }] },
    ]);
    assert.match(results[0].content[0].text, /^\[#1\] all tests pass/, 'tool results are numbered (§7.3)');
    assert.equal(results[1].terminate, true, 'the handoff result carries terminate');
    for (const refused of results.slice(2)) {
      assert.equal(refused.isError, true);
      assert.equal(refused.terminate, true);
      assert.equal(refused.content[0].text, `You handed off ${task}; stop here.`);
    }
    const handed = await until(() => B.findTask(team.board, task)?.holder?.kind === 'close' && B.findTask(team.board,
      task), 'T1 with close');
    const handoff = handed.handoffs[0];
    assert.equal(handoff.from, 'executor');
    assert.deepEqual(handoff.evidence.map((item) => [item.tag, item.title, item.ok]), [['#1', 'Run npm test', true]]);
    assert.deepEqual(handoff.session.turns, [1, 1]);
    const close = await nextDelivery(host, 'U.close.1');
    assert.match(close.text, /^\[Mori\] T1 was handed to you: executor handed it off \(done\)\./);
  });

test('TB-16 evidence that is not a finished tool call of this session is refused with the recent numbers', async () => {
  const { team, host } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  const results = await runDelivery(host, start, [
    { calls: [{ name: 'read', args: { path: 'src/a.ts' }, result: 'code' }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Done.', outcome: 'done', evidence: ['#7'] } }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Done.', outcome: 'done', evidence: [1] } }] },
  ]);
  const refused = results[1].content[0].text.split('\n');
  assert.equal(results[1].isError, true);
  assert.match(refused[0], /^\[#2\] evidence: #7 is not a finished tool call in your session\./);
  assert.match(refused[1], /recent ones: #1 Read src\/a\.ts ✓/);
  assert.equal(results[2].terminate, true, 'integer evidence 1 is read as #1');
});

test('TB-17 an instance that edited files cannot pass its own work', async () => {
  const { team, host } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  const results = await runDelivery(host, start, [
    { calls: [{ name: 'edit', args: { path: 'src/a.ts' }, result: 'edited' }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Looks right.', outcome: 'pass', evidence: ['#1'] } }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Changed it.', outcome: 'continue', next: 'reviewer' } }] },
  ]);
  assert.match(results[1].content[0].text,
    /You changed files on T1 \(#1 Edit src\/a\.ts\); another role must verify\./);
  assert.equal(results[2].terminate, true);
  const reviewer = await nextDelivery(host, 'U.t1.reviewer');
  assert.match(reviewer.text, /^\[Mori\] You are reviewer on T1/);
  assert.deepEqual(B.findTask(team.board, 'T1').handoffs[0].authorFamilies, ['fake/model'], '§12.9');
});

// ---- TB-19、TB-18 没交接 ----

test('TB-19 a run that ends without a handoff and has no write tier is handed to close with its last text',
  async () => {
  const { team, host } = await setup(SPLIT, null);
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await runDelivery(host, start, [{ text: 'I looked around but stopped.' }]);
  const task = await until(() => B.findTask(team.board, 'T1')?.holder?.kind === 'close' && B.findTask(team.board, 'T1'),
    'T1 with close');
  const handoff = task.handoffs[0];
  assert.deepEqual([handoff.from, handoff.outcome, handoff.reason, handoff.conclusion],
    ['mori', null, 'no_handoff', 'I looked around but stopped.']);
  assert.equal(handoff.routedTo.kind, 'close');
});

test('TB-18 without a handoff a C-tier model gets one forced fill; the tags it writes go to close', async () => {
  const { team, host } = await setup(SPLIT, 'C');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await runDelivery(host, start, [{ calls: [{ name: 'bash', args: { command: 'npm test' }, result: 'pass' }] },
    { text: 'All good.' }]);
  const forced = await nextDelivery(host, 'U.t1.executor', 1);
  assert.match(forced.text, /^\[Mori\] Your turn ended without task_handoff\. Hand off T1 now\./);
  assert.match(forced.text, /<conclusion>…<\/conclusion><outcome>continue\|dead_end/);
  const results = await runDelivery(host, forced, [{ calls: [{ name: 'read', args: { path: 'a.ts' } }] },
    { text: '<conclusion>Tests pass.</conclusion><outcome>done</outcome><next>reviewer</next>'
      + '<open_items></open_items><evidence>#1</evidence>' }]);
  assert.equal(results[0].terminate, true, 'other calls are refused in a forced run');
  assert.match(results[0].content[0].text, /^Only task_handoff works in this turn/);
  const task = await until(() => B.findTask(team.board, 'T1')?.holder?.kind === 'close' && B.findTask(team.board, 'T1'),
    'T1 with close');
  const handoff = task.handoffs[0];
  assert.deepEqual([handoff.outcome, handoff.suggestedNext, handoff.routedTo.kind], ['done', 'reviewer', 'close']);
});

test('TB-18 a forced fill that cannot be used is retried once, then handed to close', async () => {
  const { team, host } = await setup(SPLIT, 'C');
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), [{ text: 'Thinking aloud.' }]);
  const forced = await nextDelivery(host, 'U.t1.executor', 1);
  await runDelivery(host, forced, [{ text: '<conclusion>x</conclusion>' }]);
  const retry = await nextDelivery(host, 'U.t1.executor', 2);
  assert.match(retry.text, /^\[Mori\] Your handoff could not be used: outcome is required\. Hand off T1 now\./);
  await runDelivery(host, retry, [{ text: 'still no tags' }]);
  const task = await until(() => B.findTask(team.board, 'T1')?.holder?.kind === 'close' && B.findTask(team.board, 'T1'),
    'T1 with close');
  assert.deepEqual([task.handoffs[0].reason, task.handoffs[0].conclusion], ['no_handoff', 'Thinking aloud.']);
  assert.equal(host.deliveries.filter((item) => item.id === 'U.t1.executor').length, 3, 'exactly one retry');
});

// ---- TB-30 工作卡 ----

test('TB-30 an instance request ends with its work card; the card is not written to the session', async () => {
  const { team, host } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  const entry = host.entry('U.t1.executor');
  const messages = [text('user', start.text)];
  const out = entry.api.handlers.get('context')({ type: 'context', messages });
  const card = out.messages.at(-1);
  assert.equal(card.customType, 'mori.work_card');
  assert.match(card.content,
    /^<mori-work-card>\nYou are executor on T1 \(request 1\)\.\nRequest 1: Login page is blank/);
  assert.match(card.content, /User's words:\n- \[\d\d:\d\d\] "fix the login page"/);
  assert.equal(entry.session.sessionManager.getEntries().some((item) => JSON.stringify(item).includes('work-card')),
    false);
  start.resolve();
});

// ---- TB-51 投递队列、TB-22 上限 ----

test('TB-51 program deliveries that arrive while the session runs are merged into one run, in order', async () => {
  const { team, host } = await setup();
  addTask(team);
  addTask(team, { title: 'Second', limits: { write: false } });
  addTask(team, { title: 'Third', limits: { write: false } });
  const blocked = (conclusion) => [{ calls: [{ name: 'task_handoff', args: { conclusion, outcome: 'blocked' } }] }];
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), blocked('One.'));
  const first = await nextDelivery(host, 'U.close.1');
  assert.match(first.text, /^\[Mori\] T1 was handed to you/);
  await beginRun(host, first);
  await runDelivery(host, await nextDelivery(host, 'U.t2.executor'), blocked('Two.'));
  await runDelivery(host, await nextDelivery(host, 'U.t3.executor'), blocked('Three.'));
  await until(() => team.lanes.get('close:1').queue.length === 2, 'two queued deliveries');
  const before = host.deliveries.length;
  await finishRun(host, first, [{ calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Done.',
    outcome: 'close_done' } }] }]);
  const merged = await nextDelivery(host, 'U.close.1', before);
  const parts = merged.text.split('\n\n');
  assert.equal(parts.length, 2, 'one run, one paragraph each');
  assert.match(parts[0], /^\[Mori\] T2 was handed to you: executor handed it off \(blocked\)\./);
  assert.match(parts[1], /^\[Mori\] T3 was handed to you/);
  merged.resolve();
});

test('TB-22 the fifth task instance is queued and shows Queued', async () => {
  const { team, host } = await setup();
  for (let i = 0; i < 5; i += 1) addTask(team, { title: `Read ${i}`, limits: { write: false } });
  await until(() => host.deliveries.length >= 4, 'four starts');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.deliveries.length, 4);
  const phases = team.view().requests[0].tasks.map((task) => task.phase);
  assert.deepEqual(phases.filter((phase) => phase === 'queued').length, 1);
  await runDelivery(host, host.deliveries[0], [{ calls: [{ name: 'task_handoff', args: { conclusion: 'x',
    outcome: 'blocked' } }] }]);
  await until(() => host.deliveries.filter((item) => /^U\.t\d\.executor$/.test(item.id)).length === 5, 'fifth start');
});

test('TB-23 a second write task waits for the lock and shows Waiting to change files', async () => {
  const { team, host } = await setup();
  addTask(team);
  addTask(team, { title: 'Also change' });
  await nextDelivery(host, 'U.t1.executor');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.deliveries.some((item) => item.id === 'U.t2.executor'), false);
  const view = team.view().requests[0].tasks.find((task) => task.id === 'T2');
  assert.deepEqual([view.phase, view.waitingFor], ['lock_wait', ['T1']]);
  assert.equal(team.board.lock, 'T1');
});

// ---- TB-34 后台批准卡 ----

test('TB-34 an instance approval becomes a card on the user envelope with role, task and reason lines; '
  + 'the answer goes back', async () => {
    const { team, host } = await setup();
    addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    const spec = host.entry('U.t1.executor').spec;
    // 手写的批准请求（synthetic）：带第 1 步的 scope、targets、allowDirs，后台卡除角色与 task 外还要带原因行
    // （file-system.md §19.4 平行 Agent 规格 TB-34 一行）
    const reason = { scope: 'outside', targets: [{ reason: 'outside', path: 'D:\\out\\a.log', text: 'D:\\out\\a.log' }],
      allowDirs: ['D:\\out'] };
    spec.onApprovalRequest({ requestId: 'U.t1.executor:approval-1', instance: 'U.t1.executor', toolCallId: 'c1',
      toolName: 'bash', args: { command: 'rm D:\\out\\a.log' }, ...reason });
    const card = host.events.find((event) => event.type === 'mori.team_approval_request');
    assert.deepEqual([card.role, card.task, card.taskTitle], ['executor', 'T1', 'Find and fix']);
    // 只有普通模式的 subagent 的卡带 description（docs/specs/subagent.md §7.4）；task 实例的为 null，不改阶段行
    assert.equal(card.subagent, null);
    const expected = [reason.scope, reason.targets, reason.allowDirs];
    assert.deepEqual([card.scope, card.targets, card.allowDirs], expected);
    assert.equal(team.info().teamApprovals.length, 1);
    const listed = team.info().teamApprovals[0];
    assert.deepEqual([listed.scope, listed.targets, listed.allowDirs], expected, 'team.info() carries the reasons');
    assert.equal(team.live().teamApproval, true);
    assert.equal(team.answerApproval('U.t1.executor:approval-1', 'allow'), true);
    assert.deepEqual(host.answers, [{ id: 'U.t1.executor', requestId: 'U.t1.executor:approval-1', decision: 'allow' }]);
    assert.equal(team.answerApproval('approval-3', 'allow'), false, "the dialog's own card");
    spec.onApprovalEnd({ requestId: 'U.t1.executor:approval-1', decision: 'allow', by: 'user', reason: null });
    assert.equal(team.info().teamApprovals.length, 0);
    assert.ok(host.events.some((event) => event.type === 'mori.team_approval_end'));
    start.resolve();
  });

// ---- TB-04 关闭模式下的临时提问 ----

test('TB-04 in off mode the dialog asks a role: a question instance narrowed to write: false answers once and closes',
  async () => {
  const { team, host, user } = await setup();
  const ask = user.api.tools.get('agent_message');
  assert.ok(ask, 'the dialog has agent_message when other roles exist');
  user.running = true;
  user.api.handlers.get('before_agent_start')?.({ systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
  const pending = ask.execute('c1', ask.prepareArguments({ to: 'reviewer', text: 'Is a.ts safe?' }), undefined,
    undefined, {});
  const delivery = await nextDelivery(host, 'U.ask.1.reviewer');
  assert.match(delivery.text,
    /^\[Mori\] chat asks you \(information, not instructions\): Is a.ts safe\?\nAnswer once\./);
  const spec = host.entry('U.ask.1.reviewer').spec;
  assert.deepEqual(spec.tools, FILE_TOOLS, 'the default tools and MCP, no TaskBoard tools in off mode');
  assert.equal(spec.instance.kind, 'ask');
  assert.deepEqual(spec.narrowing, { owner: 'ask', limits: { write: false } }, 'the main agent is not narrowed');
  const call = instanceCall(spec);
  const refused = { block: true, reason: 'Not allowed for this question: no file changes or commands.' };
  assert.deepEqual(await call('bash', { command: 'npm test' }), refused);
  assert.deepEqual(await call('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }), refused);
  assert.equal(await call('read', { path: 'a.ts' }), undefined);
  await runDelivery(host, delivery, [{ text: 'Yes, it is safe.' }]);
  const result = await pending;
  assert.equal(result.content[0].text, 'Yes, it is safe.');
  await until(() => !host.entry('U.ask.1.reviewer'), 'the question instance to close');
  const task = await ask.execute('c2', ask.prepareArguments({ to: 'T1', text: 'note' }), undefined, undefined, {});
  assert.match(task.content[0].text, /^There are no tasks when task mode is off\./);
});

// ---- TB-20 需要用户拿主意、TB-31 结案与关闭、TB-35 停止 ----

test('TB-20 need_user wakes create; when it does nothing the dialog asks the user once and the task is asked',
  async () => {
    const { team, host, user } = await setup();
    addTask(team);
    await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), [{ calls: [{ name: 'task_handoff',
      args: { conclusion: 'Which database should I use?', outcome: 'need_user' } }] }]);
    const create = await nextDelivery(host, 'U.create');
    assert.match(create.text,
      /^\[Mori\] T1 needs a decision from the user: Which database should I use\? \(from executor\)/);
    assert.equal(host.entry('U.create').spec.instance.kind, 'create');
    assert.equal(B.findTask(team.board, 'T1').status, 'waiting_user');
    await runDelivery(host, create, [{ text: 'Let me think about it.' }]);
    const ask = await nextDelivery(host, 'U');
    assert.equal(ask.text, '[Mori] T1 needs a decision from the user: Which database should I use? Ask the user.');
    assert.ok(host.events.some((event) => event.type === 'mori.wake' && event.kind === 'ask_user'
      && event.text === ask.text), 'mori.wake goes out before the delivery');
    assert.equal(B.findTask(team.board, 'T1').asked, true);
    await runDelivery(host, ask, [{ text: 'Which database should I use?' }]);
    const wake = await until(() => user.session.sessionManager.getEntries().find((entry) => entry.type === 'custom'
      && entry.customType === 'mori.wake'), 'the mori.wake entry');
    const message = user.session.sessionManager.getEntries().find((entry) => entry.type === 'message'
      && entry.message.role === 'user');
    assert.deepEqual(wake.data, { messageId: message.id, kind: 'ask_user' });
    assert.equal(host.deliveries.filter((item) => item.id === 'U').length, 1, 'asked once');
  });

test('TB-31 the close session closes the task and the request; the dialog is woken to report', async () => {
  const { team, host } = await setup();
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
  const close = await nextDelivery(host, 'U.close.1');
  await runDelivery(host, close, [
    { calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'The login page renders.',
      outcome: 'close_done' } }] },
    { calls: [{ name: 'request_close', args: { request: 1, outcome: 'done', conclusion: 'Fixed the blank page.' } }] },
  ]);
  const report = await nextDelivery(host, 'U');
  assert.match(report.text, /^\[Mori\] Request 1 is closed \(done\)\.\nConclusion: Fixed the blank page\./);
  assert.equal(B.findRequest(team.board, 1).status, 'done');
  await until(() => !host.entry('U.close.1') && !host.entry('U.t1.executor'), 'idle instances to close');
  assert.equal(host.deliveries.filter((item) => item.id === 'U.close.1').length, 1,
    'the stale "all tasks ended" delivery is dropped');
  report.resolve();
});

test('TB-31 when close leaves an ended request open (no write tier), create gets the request question', async () => {
  const { team, host } = await setup();
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
  const close = await nextDelivery(host, 'U.close.1');
  await runDelivery(host, close, [{ calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Works.',
    outcome: 'close_done' } }] }]);
  const ended = await nextDelivery(host, 'U.close.1', host.deliveries.indexOf(close) + 1);
  assert.match(ended.text, /^\[Mori\] All tasks of request 1 have ended\. Close it with request_close/);
  await runDelivery(host, ended, [{ text: 'Nothing to add.' }]);
  const create = await nextDelivery(host, 'U.create');
  assert.match(create.text, /\[Mori\] Request 1 has no open tasks and planner didn’t close it\./);
  assert.equal(B.findRequest(team.board, 1).question, 'Request 1 has no open tasks and planner didn’t close it');
});

test('TB-35 Stop team stops every agent with reason user; the stopped run does nothing more', async () => {
  const { team, host } = await setup(SPLIT, 'C');
  addTask(team);
  addTask(team, { title: 'Look', limits: { write: false } });
  const first = await nextDelivery(host, 'U.t1.executor');
  await nextDelivery(host, 'U.t2.executor');
  await beginRun(host, first);
  const { texts } = await team.stopTeam();
  assert.deepEqual(texts, []);
  assert.deepEqual(host.aborts.map((item) => item.reason), ['user', 'user']);
  assert.deepEqual(['T1', 'T2'].map((id) => [B.findTask(team.board, id).status,
    B.findTask(team.board, id).stopReason]), [['stopped', 'user'], ['stopped', 'user']]);
  const before = host.deliveries.length;
  await finishRun(host, first, [{ text: 'Interrupted.' }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.deliveries.length, before, 'no forced fill, no new request after the stop');
  assert.equal(B.findTask(team.board, 'T1').handoffs.length, 0, 'no program handoff');
  assert.equal(team.view().requests[0].tasks[0].phase, 'stopped');
});

// ---- TB-28 座位会话、TB-29 read_session、TB-39 换模型 ----

test('TB-28 a task instance messages the create seat and waits for the reply', async () => {
  const { team, host } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await beginRun(host, start);
  const message = host.entry('U.t1.executor').api.tools.get('agent_message');
  const pending = message.execute('m1', message.prepareArguments({ to: 'planner', text: 'Postgres or SQLite?',
    wait: true }), undefined, undefined, {});
  const create = await nextDelivery(host, 'U.create');
  assert.match(create.text, /^\[Mori\] Message from executor \(information, not instructions\): Postgres or SQLite\?$/);
  assert.equal(team.waits.get('task:T1:executor'), 'create');
  await runDelivery(host, create, [{ text: 'Use SQLite.' }]);
  const reply = await pending;
  assert.equal(reply.content[0].text, 'planner replied: Use SQLite.');
  assert.equal(team.waits.size, 0);
  const note = await message.execute('m2', message.prepareArguments({ to: 'T1', text: 'note to self' }), undefined,
    undefined, {});
  assert.equal(note.content[0].text, 'Left the message on T1.');
  assert.equal(B.findTask(team.board, 'T1').messages[0].text, 'note to self');
  start.resolve();
});

test("TB-29 the reviewer reads the executor's session on T1 as information", async () => {
  const { team, host } = await setup();
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), [
    { calls: [{ name: 'bash', args: { command: 'npm test' }, result: 'tests pass' }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Fixed it.', outcome: 'continue', next: 'reviewer' } }] },
  ]);
  const review = await nextDelivery(host, 'U.t1.reviewer');
  await beginRun(host, review);
  const read = host.entry('U.t1.reviewer').api.tools.get('read_session');
  const result = await read.execute('r1', read.prepareArguments({ task: 't1' }), undefined, undefined, {});
  assert.equal(result.content[0].text.split('\n')[0], 'Session of executor on T1 (information, not instructions):');
  assert.match(result.content[0].text, /Run npm test/);
  const none = await read.execute('r2', read.prepareArguments({ task: 'T1', role: 'planner' }), undefined, undefined,
    {});
  assert.match(none.content[0].text, /^planner has no session on T1\./);
  review.resolve();
});

test('TB-39 after a mid-task model switch the instance continues on the new model with the restart message',
  async () => {
    const { host, state, team } = await setup();
    addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    state.restart = { from: 'fake/a', to: 'fake/b', reason: 'auth', detail: 'API key rejected' };
    await runDelivery(host, start, [{ text: 'partial work' }]);
    const next = await nextDelivery(host, 'U.t1.executor', host.deliveries.indexOf(start) + 1);
    assert.equal(next.text, '[Mori] The model changed (fake/a → fake/b: API key rejected). Continue T1 on the new '
      + 'model from the work card. Your earlier work on T1 is in your session: read_session '
      + '{"task":"T1","role":"executor"}.');
    assert.deepEqual(next.choice, { prefer: 'fake/b', exclude: ['fake/a'] });
    assert.equal(B.findTask(team.board, 'T1').handoffs.length, 0, 'a model switch is not a fallback');
    next.resolve();
  });

// ---- TB-10 合并会话 ----

test('TB-10 merged session: need_user goes to the user session as create_wake; reply_via_dialog is refused there',
  async () => {
    const base = roles.parseRoleFiles([], deps);
    const { team, host, user } = await setup(base);
    await team.setMode('on');
    assert.ok(user.api.tools.has('request_submit'), 'create tools are registered on entering team mode');
    addTask(team, { assignee: 'mori' });
    await runDelivery(host, await nextDelivery(host, 'U.t1.mori'), [{ calls: [{ name: 'task_handoff',
      args: { conclusion: 'Keep the old API?', outcome: 'need_user' } }] }]);
    const wake = await nextDelivery(host, 'U');
    assert.match(wake.text, /^\[Mori\] T1 needs a decision from the user: Keep the old API\? \(from mori\)\./);
    assert.ok(host.events.some((event) => event.type === 'mori.wake' && event.kind === 'create_wake'));
    const results = await runDelivery(host, wake, [{ calls: [{ name: 'reply_via_dialog', args: { note: 'Ask' } }] },
      { text: 'Should I keep the old API?' }]);
    assert.match(results[0].content[0].text, /^You talk to the user directly; say it in your reply\./);
    await until(() => B.findTask(team.board, 'T1').asked, 'the task asked by the reply');
    assert.equal(host.deliveries.filter((item) => item.id === 'U').length, 1, 'only one hidden delivery');
  });

test('TB-10 merged session in team mode: the file tools stay, the create tools are on, and bash gets RELAY_ONLY',
  async () => {
    const { team, user, cwd } = await setup(roles.parseRoleFiles([], deps));
    await team.setMode('on');
    user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
    team.onUserEvent({ type: 'agent_start' });
    assert.deepEqual(user.api.getActiveTools(), ['read', 'bash', 'edit', 'write', 'board_read', 'read_session',
      'agent_message', 'request_submit', 'request_update', 'request_cancel', 'task_create', 'task_edit',
      'reply_via_dialog'], 'memory is not registered in this synthetic host, so it is not turned on');
    assert.deepEqual(team.userNarrowing(), { owner: 'dialog', limits: { write: false, mcp: false } });
    assert.deepEqual(await userCall(team, cwd)('bash', { command: 'npm test' }), { block: true, reason: RELAY_ONLY });
    team.onUserEvent({ type: 'agent_settled' });
  });

// ---- TB-33 订阅、TB-38 / TB-41 模型选项、TB-43 实例会话、TB-44 用户会话的段 ----

/** 加上订阅者 memory（只在需求关闭且排除过方案时）与 differ_from: author 的 reviewer 的角色（synthetic）。 */
const WITH_MEMORY = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/memory.md', text: '---\nname: memory\ndescription: Keeps notes\nsubscribe:\n'
    + '  - request_closed:\n      outcome: [done]\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
  { file: '.mori/agents/reviewer.md', text: '---\nname: reviewer\ndescription: Reviews\ndiffer_from: author\n---\n' },
], deps);
assert.deepEqual(WITH_MEMORY.problems, []);

/** T1 由 executor 做完、结案关闭 T1 与需求 1（done）。 */
async function closeRequestDone(team, host) {
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
  await runDelivery(host, await nextDelivery(host, 'U.close.1'), [
    { calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Works.', outcome: 'close_done' } }] },
    { calls: [{ name: 'request_close', args: { request: 1, outcome: 'done', conclusion: 'Done.' } }] },
  ]);
}

test('TB-33 a matching subscription opens a background instance narrowed to write: false with the request_closed '
  + 'delivery',
  async () => {
    const { team, host } = await setup(WITH_MEMORY);
    await closeRequestDone(team, host);
    const sub = await nextDelivery(host, 'U.sub.1.memory');
    assert.match(sub.text,
      /^\[Mori\] request_closed: Request 1 "Login page is blank" closed \(done\)\.\nConclusion: Done\./);
    const spec = host.entry('U.sub.1.memory').spec;
    assert.deepEqual(spec.tools, [...FILE_TOOLS, 'board_read', 'read_session', 'agent_message']);
    assert.deepEqual(spec.narrowing, { owner: 'subscription', limits: { write: false } });
    const refused = { block: true, reason: 'Not allowed in a subscription: no file changes or commands.' };
    assert.deepEqual(await instanceCall(spec)('write', { path: 'notes.md', content: 'x' }), refused);
    assert.equal(spec.model.schedClass, 'background');
    assert.deepEqual(spec.instance, { kind: 'subscription', role: 'memory', request: 1 });
    await runDelivery(host, sub, [{ text: 'Nothing worth keeping.' }]);
    await until(() => !host.entry('U.sub.1.memory'), 'the subscription instance to close');
  });

test('TB-33 a subscription whose filter does not match wakes nobody', async () => {
  const { team, host } = await setup(WITH_MEMORY);
  addTask(team);
  team.write((board) => B.cancelRequest(board, { request: 1, reason: 'not needed' }, Date.now()));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.deliveries.some((item) => item.id.startsWith('U.sub.')), false, 'outcome [done] only');
});

test('TB-38 a differ_from: author reviewer avoids the families that changed files on the task', async () => {
  const { team, host } = await setup(WITH_MEMORY);
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), [
    { calls: [{ name: 'write', args: { path: 'a.ts' }, result: 'written' }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Wrote it.', outcome: 'continue', next: 'reviewer' } }] },
  ]);
  const review = await nextDelivery(host, 'U.t1.reviewer');
  const source = host.entry('U.t1.reviewer').spec.model.source;
  assert.deepEqual([...source.avoidFamilies()], ['fake/model']);
  assert.deepEqual(source.models, ['strong'], "no models written: the session's range");
  assert.equal(host.entry('U.t1.executor').spec.model.source.avoidFamilies, undefined);
  review.resolve();
});

test('TB-41 scheduling classes: task, decision for create and close, inherited by a question', async () => {
  const { team, host } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  assert.equal(host.entry('U.t1.executor').spec.model.schedClass, 'task');
  await beginRun(host, start);
  const ask = host.entry('U.t1.executor').api.tools.get('agent_message');
  const pending = ask.execute('a1', ask.prepareArguments({ to: 'reviewer', text: 'Quick check?' }), undefined,
    undefined, {});
  const question = await nextDelivery(host, 'U.ask.1.reviewer');
  assert.equal(host.entry('U.ask.1.reviewer').spec.model.schedClass, 'task', 'inherits the sender');
  assert.deepEqual(host.entry('U.ask.1.reviewer').spec.tools, [...FILE_TOOLS, 'board_read', 'read_session'],
    'a team-mode question can read the board but not message');
  await runDelivery(host, question, [{ text: 'Looks fine.' }]);
  assert.equal((await pending).content[0].text, 'Looks fine.');
  await finishRun(host, start, workThen('done'));
  await nextDelivery(host, 'U.close.1');
  assert.equal(host.entry('U.close.1').spec.model.schedClass, 'decision');
});

test('TB-43 an instance session is created in the team folder with mori.instance, the allowlist and the segments',
  async () => {
    const { team, host, cwd } = await setup();
    addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    const spec = host.entry('U.t1.executor').spec;
    assert.equal(spec.dir, join(cwd, 'teams', 'U', 'sessions'));
    assert.deepEqual(spec.instance, { kind: 'task', role: 'executor', task: 'T1' });
    assert.deepEqual(spec.tools, [...FILE_TOOLS, 'board_read', 'read_session', 'agent_message', 'task_handoff']);
    assert.equal(spec.narrowing, null, 'a task without limits is not narrowed');
    assert.equal(spec.appendPrompt[0], 'MORI-ROLE-executor', 'the role body first');
    assert.match(spec.appendPrompt[1],
      /^You are executor, one of several agents that work together on Mori's TaskBoard\./);
    assert.match(spec.appendPrompt[2], /^You work on one task of the TaskBoard\./);
    assert.equal(spec.owner, 'U');
    assert.equal(spec.model.kind, 'task');
    start.resolve();
  });

test('TB-44 the user session section mori_team follows the mode: off with other roles, then team mode (split)',
  async () => {
    const { team, user } = await setup();
    const sections = {};
    user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections } });
    assert.match(sections.mori_team, /^You can ask another role one question with agent_message;/);
    assert.deepEqual(user.api.getActiveTools(), ['read', 'bash', 'edit', 'write', 'agent_message', 'subagent'],
      'off mode with other roles: the default tools, agent_message and subagent (subagent spec §2)');
    await team.setMode('on');
    user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections } });
    assert.match(sections.mori_team, /^You are chat, one of several agents/);
    assert.match(sections.mori_team, /\n\nYou are the only agent that talks to the user, and in task mode you relay;/);
    assert.deepEqual(user.api.getActiveTools(), ['read', 'bash', 'edit', 'write', 'board_read', 'read_session',
      'agent_message'], 'team mode: the default tools stay; only the duty tools change (file-system-permissions §8.6)');
    const solo = await setup(roles.parseRoleFiles([], deps));
    const sets = [];
    const setActive = solo.user.api.setActiveTools;
    solo.user.api.setActiveTools = (names) => { sets.push(names); setActive(names); };
    const empty = {};
    solo.user.api.handlers.get('before_agent_start')({ type: 'before_agent_start',
      systemPromptOptions: { sections: empty } });
    assert.deepEqual(empty, {}, 'off mode without other roles writes nothing (v0)');
    assert.deepEqual([...solo.user.api.tools.keys()], ['subagent'],
      'and registers no TaskBoard tools; only subagent (docs/specs/subagent.md §2)');
    assert.deepEqual(solo.user.api.getActiveTools(), ['read', 'bash', 'edit', 'write', 'subagent'],
      'off mode without other roles: the default tools and subagent, no TaskBoard tools');
    assert.deepEqual(sets, [['read', 'bash', 'edit', 'write', 'subagent']],
      'only the duty tools change: subagent is turned on (§8.6, U52)');
  });

test('TB-09 in team mode the dialog is narrowed at step 2 of the path gate: bash, edit and MCP get RELAY_ONLY',
  async () => {
  const { team, user, cwd } = await setup();
  assert.equal(user.api.handlers.get('tool_call'), undefined, 'the user session has no tool_call guard of its own');
  const call = userCall(team, cwd);
  await team.setMode('on');
  user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
  assert.deepEqual(team.userNarrowing(), { owner: 'dialog', limits: { write: false, mcp: false } });
  const refused = { block: true, reason: RELAY_ONLY };
  assert.deepEqual(await call('bash', { command: 'npm test' }), refused);
  assert.deepEqual(await call('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }), refused);
  assert.deepEqual(await call('mcp__docs__search', { query: 'x' }), refused);
  assert.equal(await call('board_read', {}), undefined, 'duty tools pass');
  assert.equal(await call('read', { path: 'a.ts' }), undefined, 'reading passes');
  assert.equal((await team.setMode('off')).mode, 'off');
  assert.deepEqual(await call('bash', { command: 'npm test' }), refused, 'the run started in team mode stays narrowed');
  team.onUserEvent({ type: 'agent_settled' });
  user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
  assert.equal(team.userNarrowing(), null, 'off mode: the main agent is not narrowed');
  team.onUserEvent({ type: 'agent_settled' });
});
