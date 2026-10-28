// Team 一侧的你不在与提问（docs/specs/file-system-permissions.md §9.7、§9.8、§10.1、§10.7、§10.8；file-system.md §14 的原文、
// §19.2 FS-72、FS-78、FS-83 的单元部分与 FS-90、FS-91、FS-92）：后台实例的卡到时后 Team 写的 mori.away_decision、
// 已交接的 task 实例不补提醒、用户会话一直启用 ask_user_question、提问卡的答复转给立项（合成端点 scripts.mjs 把 §8.4
// 那一段对话之后的答复认作立项最后一次投递）、交接里的选项与推荐项、
// 三种投递里的选项行。用平行 Agent 单元测试的会话表（tests/unit/taskboard/teamHarness.mjs，synthetic TeamHost，只读引用）
// 驱动 Team；Team、实例的批准扩展与 away.ts 在 awayEntry.mjs 的同一个打包结果里（共用 away.ts 的状态）。
// 不连模型，也不起 Electron；工具调用与会话内容都是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  B, SPLIT, addTask, assistantTurn, beginRun, deps, fakeHost, finishRun, nextDelivery, profile, roles, runDelivery,
  until, workThen,
} from '../taskboard/teamHarness.mjs';
import * as scripts from '../../fake-endpoint/scripts.mjs';
import {
  DB_QUESTION, PARTS_QUESTION, awayKit, driveGate, eventsOf, freshKernel, indexOf, settle, tempDir,
} from './awayKit.mjs';

/** 5 分钟（默认时长，§9.6） */
const FIVE_MINUTES = 300_000;
/** 实例拒绝原文（§14） */
const DENIED_HANDOFF = "The user was away and didn’t answer within 5 minutes, so this was denied. Don’t retry it. "
  + 'Mention it in your handoff.';
const DENIED_SUMMARY = "The user was away and didn’t answer within 5 minutes, so this was denied. Don’t retry it. "
  + 'Mention it in your final summary.';
/** 选项与推荐项（§14 的例子） */
const OPTIONS = { options: ['PostgreSQL', 'SQLite'], recommended: 'PostgreSQL' };
/** 带选项的投递的最后一句（§14） */
const ASK_WITH = 'Ask the user with ask_user_question, using these options and this recommendation.';
/** 合并会话（只有基座 mori 持有全部席位，synthetic） */
const MERGED = roles.parseRoleFiles([], deps);
/**
 * 分开时的角色加一个订阅 done 的 request_closed 的 memory（synthetic，同 taskboard/team.test.mjs 的 WITH_MEMORY）；
 * 角色文件不写 tools（写了就是 unknown field "tools"，file-system-permissions.md §8.6）
 */
const WITH_MEMORY = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/memory.md', text: '---\nname: memory\ndescription: Keeps notes\nsubscribe:\n'
    + '  - request_closed:\n      outcome: [done]\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
  { file: '.mori/agents/reviewer.md', text: '---\nname: reviewer\ndescription: Reviews\n---\n' },
], deps);
assert.deepEqual(WITH_MEMORY.problems, []);

/**
 * @brief 一个用户会话 U 的 Team（分开时的角色，同 teamHarness 的 setup），但 Team、批准状态与提问工具取自
 *        awayEntry.mjs 的打包结果：用户会话注册 ask_user_question（pi 的 defaultActive：注册即启用），答复交给
 *        team.onAskAnswered（同 sessions.ts）；Team 在用户会话信封上发的事件也按顺序记进 kit.log。
 */
async function teamSetup(t, load = SPLIT) {
  const kit = await awayKit(t);
  const host = fakeHost({ profile: profile(null) });
  host.emitUser = (id, event) => {
    host.events.push(event);
    kit.log.push({ sessionId: id, event });
  };
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'mori-fs-team-')));
  const approval = new kit.K.approval.ApprovalPolicy();
  const team = kit.K.team.createTeam(host, { userSessionId: 'U', cwd, roles: load, teamDir: join(cwd, 'teams', 'U'),
    baseTools: ['read', 'bash', 'edit', 'write'], trust: {}, approval, restored: false, userSessionFile: null });
  // 先关 Team（等它写完 board.json），再删项目目录：分成两个 after 的话目录先被删，Team 还在写
  t.after(async () => {
    await team.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const user = host.newEntry('U', cwd, null);
  user.spec = { onEvent: (event) => team.onUserEvent(event), model: {} };
  team.userExtension()(user.api);
  const asks = new kit.K.ask.AskQuestions({ sessionId: 'U', send: (event) => kit.log.push({ sessionId: 'U', event }),
    onAnswered: (questions, answers) => team.onAskAnswered(questions, answers) });
  asks.extension()(user.api);
  user.api.setActiveTools([...user.api.getActiveTools(), 'ask_user_question']);
  await team.attachUser({ sessionId: 'U', session: user.session, model: user.model });
  return { kit, host, team, user, cwd, approval, asks, askTool: user.api.tools.get('ask_user_question') };
}

/**
 * @brief 用户会话的批准扩展，照 sessions.ts 的 startUser：收窄每次调用时取 team.userNarrowing()（协作模式下对话的
 *        限制在路径闸第 2 步，file-system-permissions.md §8.3、§8.5）。
 */
function userGate(s) {
  const gate = s.approval.gate({ prefix: '', cwd: s.cwd, kind: 'user', userSessionId: 'U',
    send: (event) => s.kit.log.push({ sessionId: 'U', event }), narrowing: () => s.team.userNarrowing() });
  return driveGate(gate, 'U', s.cwd);
}

/** @brief 一个实例的批准扩展，照 sessions.ts 的 createEntry：instanceSetup 的 gate 加上 kind、cwd 与 send。 */
function instanceGate(s, id) {
  const spec = s.host.entry(id).spec;
  const setup = s.kit.K.instances.instanceSetup(spec, null, spec.id);
  const gate = setup.approval.gate({ ...setup.gate, kind: setup.kind, cwd: spec.cwd,
    send: (event) => s.kit.log.push({ sessionId: spec.id, event }) });
  return driveGate(gate, spec.id, spec.cwd);
}

/**
 * @brief 失焦，出一张卡，到时，再切回；返回 pi 拿到的结果、toolCallId 与到时的时刻。
 * @param ms 此刻设置的时长（毫秒，默认 5 分钟）
 */
async function expire(s, gate, toolName, input, ms = FIVE_MINUTES) {
  s.kit.A.setFocus(false);
  const call = gate.call(toolName, input);
  await settle();
  const at = s.kit.clock.now() + ms;
  s.kit.clock.advance(ms);
  const result = await call.result;
  s.kit.A.setFocus(true);
  return { result, toolCallId: call.toolCallId, at };
}

/**
 * @brief 走一遍 WITH_MEMORY 的 T1：executor 开工，用 agent_message 问 reviewer 一次（临时提问实例），做完交接；结案关闭
 *        T1 与需求 1，订阅的 memory 实例随之打开。每个实例开始运行之后调用 visit(id)，等它做完这个实例才往下走。
 */
async function walkInstances(s, visit) {
  addTask(s.team);
  const start = await nextDelivery(s.host, 'U.t1.executor');
  await beginRun(s.host, start);
  await visit('U.t1.executor');
  const message = s.host.entry('U.t1.executor').api.tools.get('agent_message');
  const answer = message.execute('a1', message.prepareArguments({ to: 'reviewer', text: 'Quick check?' }), undefined,
    undefined, {});
  const question = await nextDelivery(s.host, 'U.ask.1.reviewer');
  await beginRun(s.host, question);
  await visit('U.ask.1.reviewer');
  await finishRun(s.host, question, [{ text: 'Looks fine.' }]);
  await answer;
  await finishRun(s.host, start, workThen('done'));
  const close = await nextDelivery(s.host, 'U.close.1');
  await beginRun(s.host, close);
  await visit('U.close.1');
  await finishRun(s.host, close, [
    { calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Works.', outcome: 'close_done' } }] },
    { calls: [{ name: 'request_close', args: { request: 1, outcome: 'done', conclusion: 'Done.' } }] },
  ]);
  const sub = await nextDelivery(s.host, 'U.sub.1.memory');
  await beginRun(s.host, sub);
  await visit('U.sub.1.memory');
  await finishRun(s.host, sub, [{ text: 'Nothing worth keeping.' }]);
}

/** @brief 用户会话里某种自定义条目的内容。 */
function customs(user, type) {
  return user.session.sessionManager.getEntries().filter((entry) => entry.type === 'custom'
    && entry.customType === type).map((entry) => entry.data);
}

/** @brief 用户会话条目的简写：消息写角色，自定义条目写 customType。 */
function shape(user) {
  return user.session.sessionManager.getEntries().map((entry) => (entry.type === 'custom' ? entry.customType
    : entry.type === 'message' ? entry.message.role : entry.type));
}

// ---- FS-70 后台卡失焦时到达：Team 发的请求事件在前 ----

test('FS-70 a background card that arrives while away: mori.team_approval_request first, then mori.away_timer with '
  + 'its arrival time plus the timeout', async (t) => {
  const s = await teamSetup(t);
  addTask(s.team);
  const start = await nextDelivery(s.host, 'U.t1.executor');
  await beginRun(s.host, start);
  const executor = instanceGate(s, 'U.t1.executor');
  const requestId = 'U.t1.executor:approval-1';
  s.kit.A.setFocus(false);
  s.kit.clock.advance(7000);
  const arrival = s.kit.clock.now();
  const call = executor.call('bash', { command: 'npm publish' });
  await settle();
  const request = indexOf(s.kit.log, 'mori.team_approval_request', requestId);
  assert.equal(s.kit.log[request]?.sessionId, 'U', 'the Team shows the card on the user session envelope');
  assert.ok(request >= 0 && request < indexOf(s.kit.log, 'mori.away_timer', requestId),
    'mori.team_approval_request comes before its mori.away_timer');
  assert.deepEqual(eventsOf(s.kit.log, 'mori.away_timer', requestId).map((item) => [item.sessionId,
    item.event.deadline]), [['U', arrival + FIVE_MINUTES]]);
  assert.deepEqual(s.kit.A.awayTimers('U'), [{ requestId, deadline: arrival + FIVE_MINUTES }]);
  executor.gate.answer(requestId, 'reject');
  assert.equal((await call.result).block, true);
  assert.deepEqual(s.kit.A.awayTimers('U'), []);
  s.kit.A.setFocus(true);
  await finishRun(s.host, start, [{ text: 'Stopped here.' }]);
});

// ---- FS-72 后台实例的卡到时：Team 写的记录 ----

test('FS-72 a task card that expires: team_approval_end by away, the handoff text, and a record with the agent '
  + 'in the user session', async (t) => {
  const s = await teamSetup(t);
  addTask(s.team);
  const start = await nextDelivery(s.host, 'U.t1.executor');
  await beginRun(s.host, start);
  const executor = instanceGate(s, 'U.t1.executor');
  const requestId = 'U.t1.executor:approval-1';
  const { result, toolCallId, at } = await expire(s, executor, 'bash', { command: 'npm publish' });
  assert.deepEqual(result, { block: true, reason: DENIED_HANDOFF });
  assert.deepEqual(eventsOf(s.kit.log, 'mori.away_timer', requestId).map((item) => [item.sessionId,
    item.event.deadline]), [['U', at]], 'one timer on the user session; the expired card sends no null');
  const [end] = eventsOf(s.kit.log, 'mori.team_approval_end', requestId);
  assert.deepEqual([end.sessionId, end.event.decision, end.event.by, end.event.reason],
    ['U', 'reject', 'away', DENIED_HANDOFF]);
  const decision = { requestId, kind: 'approval', at, timeout: '5m',
    agent: { instance: 'U.t1.executor', role: 'executor', task: 'T1', taskTitle: 'Find and fix' }, toolCallId,
    toolName: 'bash', args: { command: 'npm publish' }, title: null, answers: null, result: 'denied' };
  assert.deepEqual(eventsOf(s.kit.log, 'mori.away_decision').map((item) => [item.sessionId, item.event]),
    [['U', { type: 'mori.away_decision', decision }]]);
  assert.deepEqual(customs(s.user, 'mori.away_decision'), [decision], 'written in the user session file');
  assert.deepEqual(customs(s.host.entry('U.t1.executor'), 'mori.away_decision'), [],
    'not in the instance session file');
  assert.deepEqual(s.kit.records, [], 'away.ts leaves instance records to the Team');
  assert.deepEqual(s.team.info().teamApprovals, []);
  await finishRun(s.host, start, [{ text: 'Stopped here.' }]);
});

test('FS-72 the Team record takes the timeout of the current setting and cuts the card args like away.ts does',
  async (t) => {
    const s = await teamSetup(t);
    await s.kit.A.setAway('60s');
    addTask(s.team);
    const start = await nextDelivery(s.host, 'U.t1.executor');
    await beginRun(s.host, start);
    const path = `${'docs/'.repeat(70)}notes.md`;
    const write = { path, content: 'x'.repeat(301) };
    const done = await expire(s, instanceGate(s, 'U.t1.executor'), 'write', write, 60_000);
    const reason = "The user was away and didn’t answer within 60 seconds, so this was denied. Don’t retry it. "
      + 'Mention it in your handoff.';
    assert.deepEqual(done.result, { block: true, reason });
    const [end] = eventsOf(s.kit.log, 'mori.team_approval_end', 'U.t1.executor:approval-1');
    assert.deepEqual([end.event.by, end.event.reason], ['away', reason]);
    const [record] = customs(s.user, 'mori.away_decision');
    assert.deepEqual([record.timeout, record.at, record.toolName, record.toolCallId],
      ['60s', done.at, 'write', done.toolCallId]);
    assert.deepEqual(record.args, { path: path.slice(0, 300) }, 'no content, and no string over 300 characters');
    s.kit.K.shared.AwayDecisionSchema.parse(record);
    assert.deepEqual(eventsOf(s.kit.log, 'mori.away_decision').map((item) => item.event.decision), [record]);
    await finishRun(s.host, start, [{ text: 'Stopped here.' }]);
  });

test('FS-72 one-time question and subscription instances of the Team get the final-summary sentence', async (t) => {
  const s = await teamSetup(t, WITH_MEMORY);
  const expired = new Map();
  await walkInstances(s, async (id) => {
    if (!id.includes('.ask.') && !id.includes('.sub.')) return;
    const kind = s.host.entry(id).spec.kind;
    expired.set(id, { kind, ...await expire(s, instanceGate(s, id), 'mcp__github__create_issue', { title: 'Bug' }) });
  });
  assert.deepEqual([...expired].map(([id, done]) => [id, done.kind]),
    [['U.ask.1.reviewer', 'ask'], ['U.sub.1.memory', 'subscription']]);
  for (const [id, done] of expired) assert.equal(done.result.reason, DENIED_SUMMARY, id);
  const cards = eventsOf(s.kit.log, 'mori.team_approval_request').map((item) => item.event);
  const records = eventsOf(s.kit.log, 'mori.away_decision').map((item) => item.event.decision);
  assert.deepEqual(records.map((item) => [item.agent.instance, item.agent.role, item.toolCallId, item.result]), [
    ['U.ask.1.reviewer', 'reviewer', expired.get('U.ask.1.reviewer').toolCallId, 'denied'],
    ['U.sub.1.memory', 'memory', expired.get('U.sub.1.memory').toolCallId, 'denied']]);
  assert.deepEqual(records.map((item) => item.agent), cards.map((card) => ({
    instance: card.instance, role: card.role, task: card.task, taskTitle: card.taskTitle })));
  assert.deepEqual(customs(s.user, 'mori.away_decision'), records, 'written in the user session file');
});

test('FS-72 create gets the final-summary sentence and close the handoff sentence; the record takes the card',
  async (t) => {
    const s = await teamSetup(t);
    addTask(s.team);
    addTask(s.team, { title: 'Look', limits: { write: false } });
    // T1 要你拿主意（唤醒立项），T2 受阻（交给结案）
    await runDelivery(s.host, await nextDelivery(s.host, 'U.t1.executor'), [{ calls: [{ name: 'task_handoff',
      args: { conclusion: 'Which database?', outcome: 'need_user' } }] }]);
    await runDelivery(s.host, await nextDelivery(s.host, 'U.t2.executor'), [{ calls: [{ name: 'task_handoff',
      args: { conclusion: 'Cannot read it.', outcome: 'blocked' } }] }]);
    const create = await nextDelivery(s.host, 'U.create');
    const close = await nextDelivery(s.host, 'U.close.1');
    await beginRun(s.host, create);
    // 立项、结案会话收窄为不改文件（第 3 步）时 MCP 工具照样出卡：用它
    const planner = await expire(s, instanceGate(s, 'U.create'), 'mcp__github__create_issue', { title: 'Bug' });
    assert.equal(planner.result.reason, DENIED_SUMMARY);
    await finishRun(s.host, create, [{ text: 'Ask the user.' }]);
    await beginRun(s.host, close);
    const closer = await expire(s, instanceGate(s, 'U.close.1'), 'mcp__github__create_issue', { title: 'Bug' });
    assert.equal(closer.result.reason, DENIED_HANDOFF);
    const cards = eventsOf(s.kit.log, 'mori.team_approval_request').map((item) => item.event);
    const records = eventsOf(s.kit.log, 'mori.away_decision').map((item) => item.event.decision);
    assert.deepEqual(records.map((item) => item.agent), cards.map((card) => ({
      instance: card.instance, role: card.role, task: card.task, taskTitle: card.taskTitle })));
    assert.deepEqual(records.map((item) => [item.agent.instance, item.agent.role]),
      [['U.create', 'planner'], ['U.close.1', 'planner']]);
    await finishRun(s.host, close, [{ text: 'Nothing more.' }]);
  });

test('FS-72 while the dialog writes a reply, the away records wait until that assistant message ends', async (t) => {
  const s = await teamSetup(t);
  addTask(s.team);
  const start = await nextDelivery(s.host, 'U.t1.executor');
  await beginRun(s.host, start);
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }], provider: 'fake',
    model: 'model', stopReason: 'stop', timestamp: Date.now(), api: 'openai-completions', usage: {} };
  s.team.onUserEvent({ type: 'message_start', message: reply });
  await expire(s, instanceGate(s, 'U.t1.executor'), 'bash', { command: 'npm publish' });
  // 用户会话自己的卡到时：sessions.ts 的 recordAwayDecision 经 Team.recordAway 写（synthetic 的记录）
  const own = { requestId: 'approval-1', kind: 'approval', at: s.kit.clock.now(), timeout: '5m', agent: null,
    toolCallId: 'c9', toolName: 'bash', args: { command: 'ls' }, title: null, answers: null, result: 'denied' };
  s.team.recordAway(own);
  assert.deepEqual(customs(s.user, 'mori.away_decision'), [], 'nothing is written while the reply streams');
  assert.deepEqual(eventsOf(s.kit.log, 'mori.away_decision'), []);
  s.user.session.sessionManager.appendMessage(reply);
  s.team.onUserEvent({ type: 'message_end', message: reply });
  await settle();
  assert.deepEqual(shape(s.user).filter((kind) => kind !== 'mori.team'),
    ['assistant', 'mori.away_decision', 'mori.away_decision']);
  assert.deepEqual(customs(s.user, 'mori.away_decision').map((item) => item.requestId),
    ['U.t1.executor:approval-1', 'approval-1']);
  assert.equal(eventsOf(s.kit.log, 'mori.away_decision').length, 2, 'each record is also one event');
  await finishRun(s.host, start, [{ text: 'Stopped here.' }]);
});

// ---- FS-78 已交接的 task 实例不补提醒；有工作卡的实例，工作卡在提醒后面 ----

/**
 * @brief 多一次请求的上下文经实例的 mori-team context 钩子之后，最后三条消息的简写（消息写角色，custom 消息写 customType）。
 *        上下文是手写的（synthetic）：上一条助手消息，然后是 pi 把提醒条目（custom_message）变成的 custom 消息。
 */
function contextTail(s, id, reminder) {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Work on T2.' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Pushing.' }], provider: 'fake', model: 'model',
      stopReason: 'stop', timestamp: 2, api: 'openai-completions', usage: {} },
    { role: 'custom', customType: reminder.customType, content: reminder.content, display: reminder.display,
      timestamp: 3 },
  ];
  const changed = s.host.entry(id).api.handlers.get('context')({ type: 'context', messages });
  return changed.messages.slice(-3).map((message) => (message.role === 'custom' ? message.customType : message.role));
}

test('FS-78 a task instance that handed off in this run gets no reminder; one that did not gets the handoff '
  + 'sentence, and its work card comes after the reminder', async (t) => {
  const s = await teamSetup(t);
  // T1 不改文件（不取写入锁，与写 task T2 同时运行）：它的 bash 会被收窄拒绝、不出卡，所以它用 MCP 工具出卡
  addTask(s.team, { title: 'Look', limits: { write: false } });
  addTask(s.team);
  const one = await nextDelivery(s.host, 'U.t1.executor');
  const two = await nextDelivery(s.host, 'U.t2.executor');
  await beginRun(s.host, one);
  await beginRun(s.host, two);
  const first = instanceGate(s, 'U.t1.executor');
  const second = instanceGate(s, 'U.t2.executor');
  await expire(s, first, 'mcp__github__create_issue', { title: 'Bug' });
  await expire(s, second, 'bash', { command: 'git push' });
  await assistantTurn(s.host.entry('U.t1.executor'), { calls: [{ name: 'task_handoff', args: {
    conclusion: 'Could not publish.', outcome: 'blocked' } }] });
  assert.equal(first.beforeSettle('completed'), undefined, 'handed off: another request would be refused');
  const [reminder] = second.beforeSettle('completed').entries;
  assert.deepEqual(reminder.content, [
    '[Mori] The user was away, so Mori decided these without them during this turn:', '- Denied bash: git push',
    "Don't retry the denied calls. Mention all of these in your handoff."].join('\n'));
  assert.deepEqual(contextTail(s, 'U.t2.executor', reminder), ['assistant', 'mori.away_reminder', 'mori.work_card'],
    'the work card comes after the reminder');
  await finishRun(s.host, one, []);
  await finishRun(s.host, two, [{ calls: [{ name: 'task_handoff', args: { conclusion: 'Looked.',
    outcome: 'blocked' } }] }]);
});

// ---- FS-83 用户会话一直有 ask_user_question ----

test('FS-83 the user session keeps ask_user_question in off mode, in team mode and merged; the narrowed dialog gate '
  + 'lets it through; instances do not list it', async (t) => {
  const s = await teamSetup(t);
  const start = () => s.user.api.handlers.get('before_agent_start')({ type: 'before_agent_start',
    systemPromptOptions: { sections: {} } });
  start();
  assert.ok(s.user.api.getActiveTools().includes('ask_user_question'), 'off mode');
  await s.team.setMode('on');
  start();
  s.team.onUserEvent({ type: 'agent_start' });
  assert.ok(s.user.api.getActiveTools().includes('ask_user_question'), 'team mode, split');
  assert.equal(s.user.api.handlers.get('tool_call'), undefined, 'the Team adds no tool_call guard to the user session');
  const gate = userGate(s);
  assert.equal(await gate.call('ask_user_question', { questions: [DB_QUESTION] }).result, undefined,
    'a duty tool passes step 1 of the path gate');
  assert.deepEqual(await gate.call('bash', { command: 'npm test' }).result, { block: true,
    reason: 'Task mode is on: the dialog agent only relays; the work is done in tasks.' });
  s.team.onUserEvent({ type: 'agent_settled' });
  await s.team.setMode('off');
  start();
  assert.ok(s.user.api.getActiveTools().includes('ask_user_question'), 'back in off mode');
  addTask(s.team);
  await nextDelivery(s.host, 'U.t1.executor');
  assert.equal(s.host.entry('U.t1.executor').spec.tools.includes('ask_user_question'), false, 'not for a task');
  const merged = await teamSetup(t, MERGED);
  await merged.team.setMode('on');
  merged.user.api.handlers.get('before_agent_start')({ type: 'before_agent_start',
    systemPromptOptions: { sections: {} } });
  assert.ok(merged.user.api.getActiveTools().includes('ask_user_question'), 'merged session');
});

test('FS-83 no Team instance lists ask_user_question: task, one-time question, close, subscription, create (split)',
  async (t) => {
    // 单元层查 Team 建实例时给的工具清单；增强会话与重新打开旧版本存下的会话由 App 层的 FS-83 验
    const s = await teamSetup(t, WITH_MEMORY);
    const seen = [];
    const look = (host, id) => {
      const spec = host.entry(id).spec;
      seen.push([id, spec.kind, spec.tools.includes('ask_user_question')]);
    };
    await walkInstances(s, (id) => look(s.host, id));
    const split = await teamSetup(t);
    addTask(split.team);
    await runDelivery(split.host, await nextDelivery(split.host, 'U.t1.executor'), [{ calls: [{ name: 'task_handoff',
      args: { conclusion: 'Which database?', outcome: 'need_user' } }] }]);
    const create = await nextDelivery(split.host, 'U.create');
    look(split.host, 'U.create');
    create.resolve();
    assert.deepEqual(seen, [['U.t1.executor', 'task', false], ['U.ask.1.reviewer', 'ask', false],
      ['U.close.1', 'close', false], ['U.sub.1.memory', 'subscription', false], ['U.create', 'create', false]]);
  });

// ---- FS-90 转给立项 ----

/** @brief 用户会话开始一次运行（before_agent_start、agent_start：这次运行的模式按此刻的协作模式）。 */
function userRun(s) {
  s.user.running = true;
  s.user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  s.team.onUserEvent({ type: 'agent_start' });
}

/** @brief 对话调用一次 ask_user_question（参数已经 pi 校验），返回工具结果的 Promise。 */
async function askOnce(s, questions, callId = 'ask-call') {
  const result = s.askTool.execute(callId, { questions }, undefined);
  await settle();
  return result;
}

/**
 * @brief 回答 ask-1，并在回答的同一时刻查出有没有转给立项（转发是同步的：onAskAnswered 直接排进立项的投递队列）：
 *        这次回答里 Team.enqueue 排进的投递（哪个会话、文字）。
 * @param answers question.answer 的答复；null 为拒绝回答
 */
function answerAndWatch(t, s, answers) {
  const enqueue = t.mock.method(s.team, 'enqueue');
  try {
    s.asks.answer('ask-1', answers);
  } finally {
    enqueue.mock.restore();
  }
  const create = s.team.createLane();
  return {
    enqueued: enqueue.mock.calls.map((call) => [call.arguments[0] === create ? 'create' : call.arguments[0].id,
      call.arguments[1].text]),
  };
}

/** @brief 转给立项的投递最后两行（§14）。 */
function forwarded(answer) {
  return `[Mori] New user message: Answer to the dialog agent's question (ask_user_question): ${answer}\n`
    + 'Make exactly one decision for it.';
}

test('FS-90 split team mode: the answer reaches create as a user message and starts a judgment; it is not queued, '
  + 'not returned on Esc and not handed to the dialog', async (t) => {
  const s = await teamSetup(t);
  await s.team.setMode('on');
  userRun(s);
  const pending = askOnce(s, [DB_QUESTION]);
  const watched = answerAndWatch(t, s, [{ selected: ['SQLite'], other: null }]);
  assert.deepEqual(watched.enqueued.map(([lane]) => lane), ['create'], 'queued for create at once');
  await (await pending);
  const judge = await nextDelivery(s.host, 'U.create');
  assert.ok(judge.text === forwarded('"Which database should I use?"="SQLite"')
    || judge.text.endsWith(`\n${forwarded('"Which database should I use?"="SQLite"')}`), judge.text);
  assert.deepEqual(s.team.info().deciding.queue, [], 'not in the queue area');
  assert.equal(eventsOf(s.kit.log, 'mori.team_deciding').some((item) => item.event.queue.length > 0), false);
  await beginRun(s.host, judge);
  assert.equal(s.team.createLane().run.judgment?.user, true, 'a judgment of a user message');
  assert.deepEqual(await s.team.onDialogStop(), [], 'Esc does not put it back in the input');
  await finishRun(s.host, judge, [{ text: 'Noted.' }]);
  // 判断结束（teamFlow 的 judgmentEnded，交给对话就在这里）在立项这次运行的结束处理里；处理完立项会话才不再忙
  await until(() => !s.team.createLane().busy, 'the end of the judgment run');
  assert.deepEqual([s.host.dialogs.length, s.host.queued.length], [0, 0], 'not handed to the dialog');
  s.team.onUserEvent({ type: 'agent_settled' });
});

test("FS-90 when the user is away the forwarded answer says it was not the user's choice; questions join with ;",
  async (t) => {
    const s = await teamSetup(t);
    await s.team.setMode('on');
    userRun(s);
    s.kit.A.setFocus(false);
    const pending = askOnce(s, [DB_QUESTION, PARTS_QUESTION]);
    await settle();
    s.kit.clock.advance(FIVE_MINUTES);
    await (await pending);
    const judge = await nextDelivery(s.host, 'U.create');
    const note = " (not the user's choice: they were away, so the recommended option was used)";
    assert.ok(judge.text.endsWith(forwarded(`"Which database should I use?"="PostgreSQL"${note}; `
      + `"Which parts?"="API"${note}`)), judge.text);
    const text = s.kit.K.boardText.forwardedAnswerText([
      { question: 'Which parts?', header: 'Scope', selected: ['API', 'CLI'], other: 'tests', auto: false }]);
    assert.equal(text, 'Answer to the dialog agent\'s question (ask_user_question): "Which parts?"="API, CLI, tests"');
    judge.resolve();
    s.team.onUserEvent({ type: 'agent_settled' });
  });

test('FS-90 off mode, a merged session and a declined question do not forward', async (t) => {
  const off = await teamSetup(t);
  userRun(off);
  const merged = await teamSetup(t, MERGED);
  await merged.team.setMode('on');
  userRun(merged);
  const split = await teamSetup(t);
  await split.team.setMode('on');
  userRun(split);
  const cases = [['off', off, [{ selected: ['SQLite'], other: null }]],
    ['merged', merged, [{ selected: ['SQLite'], other: null }]], ['declined', split, null]];
  for (const [name, s, answers] of cases) {
    const pending = askOnce(s, [DB_QUESTION]);
    assert.deepEqual(answerAndWatch(t, s, answers), { enqueued: [] }, name);
    await (await pending);
  }
});

test('FS-90 the mode of the run that asked decides, not the mode when the answer comes', async (t) => {
  const started = await teamSetup(t);
  await started.team.setMode('on');
  userRun(started);
  const first = askOnce(started, [DB_QUESTION]);
  assert.equal((await started.team.setMode('off')).mode, 'off', 'switched off while the run goes on');
  const kept = answerAndWatch(t, started, [{ selected: ['SQLite'], other: null }]);
  assert.deepEqual(kept.enqueued.map(([lane]) => lane), ['create'], 'a run started in team mode still forwards');
  await (await first);
  const judge = await nextDelivery(started.host, 'U.create');
  assert.ok(judge.text.endsWith(forwarded('"Which database should I use?"="SQLite"')), judge.text);
  judge.resolve();
  started.team.onUserEvent({ type: 'agent_settled' });
  const plain = await teamSetup(t);
  userRun(plain);
  const second = askOnce(plain, [DB_QUESTION]);
  assert.equal((await plain.team.setMode('on')).mode, 'always', 'switched on while the run goes on');
  assert.deepEqual(answerAndWatch(t, plain, [{ selected: ['SQLite'], other: null }]), { enqueued: [] },
    'a run started in off mode does not forward');
  await (await second);
  plain.team.onUserEvent({ type: 'agent_settled' });
});

test('FS-90 the synthetic endpoint takes the forwarded answer after the §8.4 catch-up as the create agent\'s last '
  + 'delivery, so lines quoted in the catch-up are not run again', async () => {
  const { boardText } = await freshKernel();
  assert.equal(scripts.CATCH_UP_TITLE, boardText.CATCH_UP_TITLE);
  // 你的消息带脚本的行（App 套件的写法），对话 Agent 回了一句；立项上次投递之后的这一段写进转给它的答复前面
  const said = [{ type: 'text', text: 'Asking the user.' }];
  const entries = [
    { type: 'message', id: 'u1', message: { role: 'user', content: 'fs-call: say: Task fs83.\ntb-scenario:fs-team' } },
    { type: 'message', id: 'a1', message: { role: 'assistant', content: said } },
  ];
  const catchUp = boardText.createCatchUp(entries, { after: null, dialogRole: 'chat' });
  const answer = boardText.forwardedAnswerText([{ question: DB_QUESTION.question, header: DB_QUESTION.header,
    selected: ['SQLite'], other: null, auto: false }]);
  const delivery = boardText.deliveryText('create_user_message', { text: answer, expanded: null });
  const text = boardText.withCatchUp(catchUp.text, delivery);
  assert.ok(text.startsWith(boardText.CATCH_UP_TITLE) && text.includes('fs-call: say: Task fs83.'), text);
  const info = scripts.sessionOf([{ role: 'system', content: 'synthetic' }, { role: 'user', content: text }]);
  assert.equal(info.last, delivery);
  assert.equal(info.last, forwarded('"Which database should I use?"="SQLite"'));
  assert.equal(scripts.lineValue([{ role: 'user', content: info.last }], 'fs-call'), null);
  // 没有那一段的投递原样不变
  assert.equal(scripts.sessionOf([{ role: 'user', content: delivery }]).last, delivery);
});

// ---- FS-91 交接带选项 ----

/** @brief 需求 1 与 T1（executor）的 TaskBoard（board.ts 的纯函数，synthetic）。 */
function boardWithTask(Bk) {
  let board = Bk.newBoard();
  board = Bk.submitRequest(board, { title: 'Login page is blank', goal: 'Fix it', acceptance: null, quote: null },
    { message: 'fix the login page', history: [] }, 1000).board;
  return Bk.createTask(board, { request: 1, title: 'Find and fix', description: 'Fix it', assignee: 'executor',
    limits: {}, dependsOn: [] }, 2000).board;
}

/** @brief T1 的一棒交接（task 实例 executor）。 */
function handoff(Bk, board, outcome, over = {}) {
  return Bk.recordHandoff(board, { sender: { kind: 'task', role: 'executor', task: 'T1' }, task: 'T1', outcome,
    conclusion: 'Which database should I use?', next: null, openItems: [], evidence: [], session: null,
    authorFamilies: [], forced: false, ...over }, ['mori', 'executor', 'reviewer', 'planner'], 3000);
}

test('FS-91 a need_user handoff records options and recommended; without them the handoff has neither field',
  async (t) => {
    const { K } = await awayKit(t);
    const Bk = K.board;
    const asked = handoff(Bk, boardWithTask(Bk), 'need_user', OPTIONS);
    assert.equal(asked.error, null);
    assert.deepEqual([asked.handoff.options, asked.handoff.recommended], [['PostgreSQL', 'SQLite'], 'PostgreSQL']);
    const task = Bk.findTask(asked.board, 'T1');
    assert.deepEqual([task.status, task.question], ['waiting_user', 'Which database should I use?']);
    assert.deepEqual(K.boardText.handoffChoices(task), { from: 'executor', ...OPTIONS });
    const plain = handoff(Bk, boardWithTask(Bk), 'need_user');
    assert.equal(plain.error, null);
    assert.equal('options' in plain.handoff, false);
    assert.equal('recommended' in plain.handoff, false);
    assert.equal(K.boardText.handoffChoices(Bk.findTask(plain.board, 'T1')), null);
  });

test('FS-91 options on another outcome, only one of the two, a recommended outside them or bad items are refused',
  async (t) => {
    const { K } = await awayKit(t);
    const Bk = K.board;
    const cases = [
      ['blocked', OPTIONS, 'options and recommended are only for need_user.'],
      ['done', { options: ['A', 'B'] }, 'options and recommended are only for need_user.'],
      ['need_user', { options: ['A', 'B'] }, 'Give options and recommended together.'],
      ['need_user', { recommended: 'A' }, 'Give options and recommended together.'],
      ['need_user', { options: ['A', 'B'], recommended: 'C' }, 'recommended must be one of options.'],
      ['need_user', { options: ['A'], recommended: 'A' }, 'options must have 2-4 different items of 1-60 characters.'],
      ['need_user', { options: ['A', 'B', 'C', 'D', 'E'], recommended: 'A' },
        'options must have 2-4 different items of 1-60 characters.'],
      ['need_user', { options: ['A', 'A'], recommended: 'A' },
        'options must have 2-4 different items of 1-60 characters.'],
      ['need_user', { options: ['A', ''], recommended: 'A' },
        'options must have 2-4 different items of 1-60 characters.'],
      ['need_user', { options: ['A', 'x'.repeat(61)], recommended: 'A' },
        'options must have 2-4 different items of 1-60 characters.'],
    ];
    for (const [outcome, over, error] of cases) {
      const board = boardWithTask(Bk);
      const result = handoff(Bk, board, outcome, { evidence: [], ...over });
      assert.equal(result.error, error, `${outcome} ${JSON.stringify(over)}`);
      assert.equal(result.board, board, 'the TaskBoard is unchanged');
    }
    const edge = handoff(Bk, boardWithTask(Bk), 'need_user', { options: ['A', 'B', 'C', 'x'.repeat(60)],
      recommended: 'x'.repeat(60) });
    assert.equal(edge.error, null, 'four items of up to 60 characters');
  });

test('FS-91 board.json reads and writes handoffs with and without options', async (t) => {
  const { K } = await awayKit(t);
  const Bk = K.board;
  const dir = tempDir(t, 'mori-fs-board-');
  const withOptions = handoff(Bk, boardWithTask(Bk), 'need_user', OPTIONS).board;
  await Bk.saveBoard(dir, withOptions);
  const loaded = await Bk.loadBoard(dir);
  assert.deepEqual(loaded, withOptions);
  const plain = handoff(Bk, boardWithTask(Bk), 'blocked').board;
  await Bk.saveBoard(dir, plain);
  const read = await Bk.loadBoard(dir);
  assert.deepEqual(read, plain);
  const [only] = Bk.findTask(read, 'T1').handoffs;
  assert.deepEqual(['options' in only, 'recommended' in only], [false, false]);
});

test('FS-91 task_handoff takes options and recommended: the schema texts, the refusal reaches the model, '
  + 'the close session records its own', async (t) => {
  const s = await teamSetup(t);
  const { taskHandoffSchema, closeHandoffSchema, strictSchema, checkForm, taskForm } = s.kit.K.handoffForm;
  for (const schema of [taskHandoffSchema([]), closeHandoffSchema([])]) {
    assert.equal(schema.properties.options.description,
      'With need_user: 2-4 short choices for the user, at most 60 characters each.');
    assert.equal(schema.properties.recommended.description,
      'With need_user and options: the choice you recommend; one of options.');
    assert.equal(schema.required.includes('options'), false);
    const strict = strictSchema(schema);
    assert.ok(strict.properties.options.type.includes('null') && strict.properties.recommended.type.includes('null'));
  }
  const form = taskForm('T1', []);
  assert.deepEqual(checkForm(form, { conclusion: 'Which one?', outcome: 'need_user', next: null, open_items: null,
    evidence: null, ...OPTIONS }).args, { task: 'T1', conclusion: 'Which one?', outcome: 'need_user', ...OPTIONS });
  addTask(s.team);
  const results = await runDelivery(s.host, await nextDelivery(s.host, 'U.t1.executor'), [
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Blocked.', outcome: 'blocked', ...OPTIONS } }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Blocked.', outcome: 'blocked' } }] },
  ]);
  assert.equal(results[0].isError, true);
  // task 实例的工具结果带证据编号（平行 Agent 规格 §7.3），原因接在编号后面
  assert.match(results[0].content[0].text.split('\n')[0],
    /^\[#\d+\] options and recommended are only for need_user\.$/);
  assert.equal(results[1].terminate, true, 'the handoff without options goes through');
  const close = await nextDelivery(s.host, 'U.close.1');
  const decided = await runDelivery(s.host, close, [{ calls: [{ name: 'task_handoff', args: { task: 'T1',
    conclusion: 'Which database should I use?', outcome: 'need_user', ...OPTIONS } }] }]);
  assert.notEqual(decided[0].isError, true, decided[0].content[0].text);
  const task = await until(() => B.findTask(s.team.board, 'T1')?.status === 'waiting_user'
    && B.findTask(s.team.board, 'T1'), 'T1 waiting for the user');
  const last = task.handoffs.at(-1);
  assert.deepEqual([last.from, last.options, last.recommended], ['close:planner', OPTIONS.options, 'PostgreSQL']);
  const create = await nextDelivery(s.host, 'U.create');
  assert.ok(create.text.includes('(from close:planner).\nOptions from close:planner: PostgreSQL; SQLite. '
    + 'Recommended: PostgreSQL.\n'), create.text);
  create.resolve();
});

// ---- FS-92 选项进投递 ----

test('FS-92 with options: create_need_user and then ask_user carry the option lines (split)', async (t) => {
  const s = await teamSetup(t);
  addTask(s.team);
  await runDelivery(s.host, await nextDelivery(s.host, 'U.t1.executor'), [{ calls: [{ name: 'task_handoff',
    args: { conclusion: 'Which database should I use?', outcome: 'need_user', ...OPTIONS } }] }]);
  const create = await nextDelivery(s.host, 'U.create');
  assert.ok(create.text.endsWith(['[Mori] T1 needs a decision from the user: Which database should I use? '
    + '(from executor).', 'Options from executor: PostgreSQL; SQLite. Recommended: PostgreSQL.',
  'If what the user already said answers it, record their words with request_update (quote) and hand T1 back with '
    + 'task_edit; otherwise ask the user with reply_via_dialog.'].join('\n')), create.text);
  await runDelivery(s.host, create, [{ text: 'Let me think about it.' }]);
  const ask = await nextDelivery(s.host, 'U');
  assert.equal(ask.text, '[Mori] T1 needs a decision from the user: Which database should I use? Options from '
    + `executor: PostgreSQL; SQLite. Recommended: PostgreSQL. ${ASK_WITH}`);
  ask.resolve();
});

test('FS-92 with options: relay adds one line per asked task after the note', async (t) => {
  const s = await teamSetup(t);
  addTask(s.team);
  await runDelivery(s.host, await nextDelivery(s.host, 'U.t1.executor'), [{ calls: [{ name: 'task_handoff',
    args: { conclusion: 'Which database should I use?', outcome: 'need_user', ...OPTIONS } }] }]);
  const create = await nextDelivery(s.host, 'U.create');
  await runDelivery(s.host, create, [{ calls: [{ name: 'reply_via_dialog', args: { note: 'T1 needs a database.' } }] },
    { text: 'Relayed.' }]);
  const relay = await nextDelivery(s.host, 'U');
  assert.equal(relay.text, ['[Mori] planner asks you to tell the user: T1 needs a database.',
    `For T1: options from executor: PostgreSQL; SQLite. Recommended: PostgreSQL. ${ASK_WITH}`].join('\n'));
  relay.resolve();
});

test('FS-92 with options in a merged session: the wake asks with ask_user_question', async (t) => {
  const s = await teamSetup(t, MERGED);
  await s.team.setMode('on');
  addTask(s.team, { assignee: 'mori' });
  await runDelivery(s.host, await nextDelivery(s.host, 'U.t1.mori'), [{ calls: [{ name: 'task_handoff',
    args: { conclusion: 'Keep the old API?', outcome: 'need_user', options: ['Keep it', 'Drop it'],
      recommended: 'Keep it' } }] }]);
  const wake = await nextDelivery(s.host, 'U');
  assert.equal(wake.text, ['[Mori] T1 needs a decision from the user: Keep the old API? (from mori).',
    'Options from mori: Keep it; Drop it. Recommended: Keep it.',
    'If what the user already said answers it, record their words with request_update (quote) and hand T1 back with '
      + 'task_edit; otherwise ask the user with ask_user_question, using these options and this recommendation.']
    .join('\n'));
  wake.resolve();
});

test('FS-92 a close session handoff names close:<role>; without options the three texts are as before',
  async (t) => {
    const { K } = await awayKit(t);
    const text = K.boardText.deliveryText;
    const choices = { from: 'close:planner', ...OPTIONS };
    assert.equal(text('ask_user', { subject: 'T1', question: 'Which database should I use?', choices }),
      '[Mori] T1 needs a decision from the user: Which database should I use? Options from close:planner: '
        + `PostgreSQL; SQLite. Recommended: PostgreSQL. ${ASK_WITH}`);
    const need = { task: 'T1', question: 'Which database should I use?', from: 'executor' };
    const tail = 'If what the user already said answers it, record their words with request_update (quote) and hand '
      + 'T1 back with task_edit; otherwise ';
    for (const plain of [undefined, null]) {
      const extra = plain === undefined ? {} : { choices: plain };
      assert.equal(text('ask_user', { subject: 'T1', question: 'Which database should I use?', ...extra }),
        '[Mori] T1 needs a decision from the user: Which database should I use? Ask the user.');
      assert.equal(text('ask_user', { subject: 'Request 1', question: 'Ship it', ...extra }),
        '[Mori] Request 1 needs a decision from the user: Ship it. Ask the user.');
      assert.equal(text('create_need_user', { ...need, merged: false, ...extra }), ['[Mori] T1 needs a decision '
        + 'from the user: Which database should I use? (from executor).', `${tail}ask the user with reply_via_dialog.`]
        .join('\n'));
      assert.equal(text('create_need_user', { ...need, merged: true, ...extra }), ['[Mori] T1 needs a decision '
        + 'from the user: Which database should I use? (from executor).', `${tail}ask the user in your reply.`]
        .join('\n'));
    }
    for (const plain of [{}, { choices: [] }]) {
      assert.equal(text('relay', { createRole: 'planner', note: 'T1 needs a database.', ...plain }),
        '[Mori] planner asks you to tell the user: T1 needs a database.');
    }
  });

test('FS-92 without options the Team sends ask_user, relay and create_need_user as before', async (t) => {
  const s = await teamSetup(t);
  addTask(s.team);
  await runDelivery(s.host, await nextDelivery(s.host, 'U.t1.executor'), [{ calls: [{ name: 'task_handoff',
    args: { conclusion: 'Which database should I use?', outcome: 'need_user' } }] }]);
  const create = await nextDelivery(s.host, 'U.create');
  assert.ok(create.text.includes('[Mori] T1 needs a decision from the user: Which database should I use? '
    + '(from executor).\nIf what the user already said answers it'), create.text);
  assert.doesNotMatch(create.text, /Options from/);
  await runDelivery(s.host, create, [{ text: 'Let me think about it.' }]);
  const ask = await nextDelivery(s.host, 'U');
  assert.equal(ask.text, '[Mori] T1 needs a decision from the user: Which database should I use? Ask the user.');
  ask.resolve();
});
