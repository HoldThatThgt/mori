// 分开时协作模式下你的消息怎么走（kernel/teamFlow.ts 与 team.ts，docs/specs/parallel-agents-taskboard.md §5.1、§5.3、§5.4、
// §8.3、§11.4、§11.6、§13.2、§13.3）：纯函数（认出交给对话的消息、对话卡上的决定、补写进展摘要、提示词模板的展开），
// 以及用测试写的会话表（teamHarness.mjs，synthetic）驱动 Team：待判断队列、回执与进展摘要的位置、撤回、停止、
// once 的结束、拒绝启动时关掉协作模式、重新打开。不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  B, addTask, assistantTurn, beginRun, deps, finishRun, nextDelivery, nextDialog, roles, runDelivery, setup,
  until,
} from './teamHarness.mjs';

const Flow = await loadKernelModule('src/kernel/teamFlow.ts');

/** 用户会话条目的简写：消息写角色，自定义条目写 customType。 */
function shape(user) {
  return user.session.sessionManager.getEntries().map((entry) => (entry.type === 'custom' ? entry.customType
    : entry.type === 'message' ? entry.message.role : entry.type));
}

/** 用户会话里某种自定义条目的内容。 */
function customs(user, type) {
  return user.session.sessionManager.getEntries().filter((entry) => entry.type === 'custom'
    && entry.customType === type).map((entry) => entry.data);
}

/** 最后一次 mori.team_deciding。 */
function lastDeciding(host) {
  return host.events.findLast((event) => event.type === 'mori.team_deciding');
}

/** 用户会话这次请求的工作卡（mori-team 的 context 处理器）。 */
function dialogCard(user, messages) {
  const result = user.api.handlers.get('context')({ type: 'context', messages });
  return result?.messages.at(-1)?.content ?? null;
}

/** 等 Team 处理完消息（onUserPrompt 按发送顺序排在一条 Promise 链上）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const SUBMIT = { name: 'request_submit', args: { title: 'Login page is blank', goal: 'Fix it' } };
const CREATE = { name: 'task_create', args: { request: 1, title: 'Find and fix', description: 'Fix it',
  assignee: 'executor' } };

// ---- 纯函数 ----

test('TB-56 a user message in the dialog session is the handed message with the same text, its template expansion '
  + 'or its skill block; other text matches none', () => {
  const handed = [{ text: 'first', alt: null }, { text: '/fix login', alt: 'Fix login please' },
    { text: 'third', alt: null }, { text: '/skill:fmt a.ts', alt: null }];
  assert.equal(Flow.matchHanded(handed, 'third'), 2);
  assert.equal(Flow.matchHanded(handed, 'Fix login please'), 1, 'pi expanded the template');
  assert.equal(Flow.matchHanded(handed, '<skill name="fmt" location="x">\nbody\n</skill>\n\na.ts'), 3,
    'pi expanded the skill command');
  assert.equal(Flow.matchHanded(handed, 'Sent by an extension with sendUserMessage'), -1,
    'text an extension sends is not taken for a handed /command');
  assert.equal(Flow.matchHanded([{ text: 'a', alt: null }], 'b'), -1);
});

test("TB-06 the dialog card decision: couldn't decide on errors and no model, otherwise the kind or reply", () => {
  const judgment = { user: true, merged: false, kind: 'submit', recorded: true, registered: [1] };
  assert.deepEqual(Flow.decisionNote({ judgment, unavailable: true, error: null, lastText: '', receipts: [] }),
    { kind: 'failed', reason: 'no model available' });
  assert.deepEqual(Flow.decisionNote({ judgment, unavailable: false, error: 'HTTP 500', lastText: '', receipts: [] }),
    { kind: 'failed', reason: 'HTTP 500' });
  assert.deepEqual(Flow.decisionNote({ judgment, unavailable: false, error: null, lastText: 'Registered.',
    receipts: [] }), { kind: 'decided', decision: 'submit', requests: [1], note: 'Registered.' });
  const none = { ...judgment, kind: null, registered: [] };
  assert.equal(Flow.decisionNote({ judgment: none, unavailable: false, error: null, lastText: '', receipts: [] })
    .decision, 'reply', 'no decision is no collaboration needed (§5.4)');
  const update = { ...judgment, kind: 'update', registered: [] };
  const receipts = [{ kind: 'added', request: 2, title: 'T', quote: 'x', at: 1 }];
  assert.deepEqual(Flow.decisionNote({ judgment: update, unavailable: false, error: null, lastText: '', receipts })
    .requests, [2]);
});

test('TB-30 the dialog card decision is for the last user message of the context, by time, else by text', () => {
  const note = (n) => ({ kind: 'decided', decision: 'reply', requests: [], note: n });
  const decisions = [{ text: 'hello', timestamp: 5, note: note('a') },
    { text: 'again', timestamp: null, note: note('b') }];
  const msg = (value, timestamp) => ({ role: 'user', content: value, timestamp });
  assert.equal(Flow.decisionFor(decisions, [msg('expanded text', 5)]).note, 'a', 'by time');
  assert.equal(Flow.decisionFor(decisions, [msg('hello', 5), msg('again', 9)]).note, 'b', 'by text');
  assert.equal(Flow.decisionFor(decisions, [msg('hello', 5), msg('[Mori] Request 1 is closed', 7)]).note, 'a',
    '[Mori] deliveries are not your messages');
  assert.equal(Flow.decisionFor(decisions, [msg('hello', 5), msg('new one', 11)]), null, 'no older lookups');
});

test('TB-36 requests on the board without a mori.progress entry get one when the session reopens', () => {
  let board = B.newBoard();
  for (const title of ['One', 'Two']) {
    board = B.submitRequest(board, { title, goal: 'g', acceptance: null, quote: null }, { message: 'm', history: [] },
      1).board;
  }
  const entries = [{ type: 'custom', id: 'a', customType: 'mori.progress', data: { request: 1 } }];
  assert.deepEqual(Flow.missingProgress(board, entries), [2]);
});

test('TB-56 a prompt template is expanded for create with pi expandPromptTemplate; skills and plain text are not',
  async () => {
    const expand = await Flow.loadTemplateExpander();
    const templates = [{ name: 'fix', description: '', content: 'Fix $1 please', sourceInfo: {}, filePath: 'f' }];
    assert.deepEqual(Flow.templateExpansion('/fix login', templates, expand),
      { name: 'fix', text: 'Fix login please' });
    assert.equal(Flow.templateExpansion('/skill:x go', templates, expand), null);
    assert.equal(Flow.templateExpansion('fix login', templates, expand), null);
  });

// ---- 一条消息的走法（§5.3） ----

test('TB-56 TB-08 TB-37 an idle dialog waits in preparing while create decides; the receipt follows the user message',
  async () => {
    const { team, host, user } = await setup();
    await team.setMode('on');
    team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
    const reply = await nextDialog(host);
    assert.equal(host.entry('U').preparing, true, 'the dialog is preparing (§5.3 step 1)');
    const judge = await nextDelivery(host, 'U.create');
    assert.match(judge.text, /\[Mori\] New user message: fix the login page\nMake exactly one decision for it\.$/);
    assert.deepEqual(lastDeciding(host).queue, [{ text: 'fix the login page', behavior: null }]);
    assert.equal(typeof lastDeciding(host).since, 'number', 'judging started');
    await runDelivery(host, judge, [{ calls: [SUBMIT] }, { calls: [CREATE] }, { text: 'Registered it.' }]);
    await reply.ready;
    assert.equal(reply.aborted, false);
    assert.deepEqual(lastDeciding(host).queue, [], 'handed to the dialog');
    assert.deepEqual(customs(user, 'mori.receipt'), [], 'no receipt before the dialog writes the message');
    await beginRun(host, reply);
    const card = dialogCard(user, user.session.sessionManager.buildSessionContext().messages);
    assert.match(card, /For this message planner decided: new request \(Request 1\); their note: "Registered it\."/);
    await finishRun(host, reply, [{ text: 'Planner registered request 1.' }]);
    await until(() => customs(user, 'mori.progress').length, 'the progress entry');
    assert.deepEqual(shape(user).filter((kind) => kind !== 'mori.team'),
      ['user', 'mori.receipt', 'assistant', 'mori.progress']);
    assert.ok(host.events.some((event) => event.type === 'mori.receipt' && event.kind === 'registered'));
  });

test('TB-56 a message judged after the dialog settled but before its reply resolved starts a reply the Team tracks',
  async () => {
    const { team, host } = await setup();
    await team.setMode('on');
    team.onUserPrompt({ text: 'first' }, undefined, undefined);
    const reply = await nextDialog(host);
    const judge = await nextDelivery(host, 'U.create');
    await runDelivery(host, judge, [{ text: 'Answer it.' }]);
    await reply.ready;
    await beginRun(host, reply);
    team.onUserPrompt({ text: 'second' }, 'followUp', undefined);
    const second = await nextDelivery(host, 'U.create', host.deliveries.indexOf(judge) + 1);
    // synthetic：对话这次运行已经 agent_settled，它的 dialogStart 还没兑现（Team 还认为对话在回复）
    await assistantTurn(host.entry('U'), { text: 'Answered the first.' });
    host.entry('U').running = false;
    host.entry('U').spec.onEvent({ type: 'agent_settled' });
    await runDelivery(host, second, [{ text: 'Answer it too.' }]);
    const next = await nextDialog(host, 1);
    assert.equal(next.text, 'second', 'the Team starts the reply itself');
    assert.equal(host.queued.length, 0, 'not handed to the session table as a queued message');
    reply.resolve();
  });

test('TB-56 messages sent while the dialog replies wait for create one by one; Enter queues, Ctrl+Enter steers',
  async () => {
    const { team, host } = await setup();
    await team.setMode('on');
    host.entry('U').running = true;
    team.onUserPrompt({ text: 'A' }, 'followUp', undefined);
    team.onUserPrompt({ text: 'B' }, 'steer', undefined);
    await settle();
    assert.deepEqual(lastDeciding(host).queue, [{ text: 'A', behavior: 'followUp' }, { text: 'B', behavior: 'steer' }]);
    assert.equal(host.dialogs.length, 0, 'a replying dialog does not start a new reply');
    const first = await nextDelivery(host, 'U.create');
    await runDelivery(host, first, [{ calls: [{ name: 'reply_via_dialog', args: {} }] }]);
    await until(() => host.queued.length === 1, 'A handed to pi');
    assert.deepEqual(host.queued[0], { id: 'U', text: 'A', behavior: 'followUp' });
    const second = await nextDelivery(host, 'U.create', host.deliveries.indexOf(first) + 1);
    assert.match(second.text, /New user message: B/);
    assert.doesNotMatch(second.text, /New user message: A/, 'each message is its own judgment');
    team.onUserPrompt({ text: 'C' }, 'followUp', undefined);
    await settle();
    assert.deepEqual(team.withdrawDeciding(), ['C'], 'the one being judged is not withdrawn');
    await runDelivery(host, second, [{ text: 'Answer it.' }]);
    await until(() => host.queued.length === 2, 'B handed to pi');
    assert.deepEqual(host.queued[1], { id: 'U', text: 'B', behavior: 'steer' });
    await settle();
    assert.equal(host.deliveries.filter((item) => item.id === 'U.create').length, 2, 'C was withdrawn');
  });

test('TB-35 TB-08 Esc stops create for the message it judges; the messages return and the receipt goes to the end',
  async () => {
    const { team, host, user } = await setup();
    await team.setMode('on');
    host.entry('U').running = true;
    team.onUserPrompt({ text: 'fix it' }, 'followUp', undefined);
    team.onUserPrompt({ text: 'and the logout' }, 'followUp', undefined);
    const judge = await nextDelivery(host, 'U.create');
    await beginRun(host, judge);
    await assistantTurn(host.entry('U.create'), { calls: [SUBMIT] });
    host.entry('U').running = false;
    assert.deepEqual(await team.onDialogStop(), ['fix it', 'and the logout']);
    assert.ok(host.aborts.some((item) => item.id === 'U.create' && item.reason === 'dialog'));
    assert.deepEqual(customs(user, 'mori.receipt').map((item) => item.kind), ['registered'], 'written on leaving');
    assert.deepEqual(customs(user, 'mori.progress'), [{ request: 1 }]);
    await finishRun(host, judge, [{ text: 'Done.' }]);
    await settle();
    assert.equal(host.queued.length + host.dialogs.length, 0, 'no new reply starts after the stop (§11.4)');
    assert.deepEqual(lastDeciding(host).queue, []);
  });

test('TB-35 Stop team returns the waiting messages; the message the dialog prepares for goes back with it',
  async () => {
    const { team, host } = await setup();
    await team.setMode('on');
    team.onUserPrompt({ text: 'first' }, undefined, undefined);
    const reply = await nextDialog(host);
    team.onUserPrompt({ text: 'second' }, 'followUp', undefined);
    await nextDelivery(host, 'U.create');
    await settle();
    assert.deepEqual((await team.stopTeam()).texts, ['second']);
    assert.ok(host.aborts.some((item) => item.id === 'U.create' && item.reason === 'user'));
    await reply.ready;
    assert.equal(reply.aborted, true, "the dialog's preparing is stopped and gives back 'first'");
    assert.deepEqual(team.info().deciding.queue, []);
  });

test("TB-06 when create errors the dialog still answers and its card says create couldn't decide", async () => {
  const { team, host, user } = await setup();
  await team.setMode('on');
  team.onUserPrompt({ text: 'hello' }, undefined, undefined);
  const reply = await nextDialog(host);
  const judge = await nextDelivery(host, 'U.create');
  await beginRun(host, judge);
  host.entry('U.create').spec.onEvent({ type: 'message_end', message: { role: 'assistant', content: [],
    stopReason: 'error', errorMessage: 'HTTP 500', timestamp: Date.now() } });
  await finishRun(host, judge, []);
  await reply.ready;
  assert.equal(reply.aborted, false);
  await beginRun(host, reply);
  const card = dialogCard(user, user.session.sessionManager.buildSessionContext().messages);
  assert.match(card, /For this message planner couldn't decide: HTTP 500/);
  await finishRun(host, reply, [{ text: 'Hi.' }]);
});

test('TB-56 an extension command goes to the dialog directly and its run says No decision on the card', async () => {
  const { team, host, user } = await setup(undefined, null, { commands: ['deploy'] });
  await team.setMode('on');
  assert.equal(team.takesPrompt('/deploy now', undefined), false);
  assert.equal(team.takesPrompt('/fix it', undefined), true, 'templates and skills go to create first');
  const run = { id: 'U', text: 'deploy the app', resolve: () => undefined };
  await beginRun(host, run);
  const card = dialogCard(user, user.session.sessionManager.buildSessionContext().messages);
  assert.match(card, /No decision: started by \/deploy/);
  await finishRun(host, run, []);
});

test('TB-56 TB-07 create sees the expanded template; the request records what you typed', async () => {
  const templates = [{ name: 'fix', description: '', content: 'Fix $1 please', sourceInfo: {}, filePath: 'f' }];
  const { team, host } = await setup(undefined, null, { templates });
  await team.setMode('on');
  team.onUserPrompt({ text: '/fix login' }, undefined, undefined);
  const judge = await nextDelivery(host, 'U.create');
  assert.match(judge.text, /New user message: \/fix login\nExpanded from \/fix:\nFix login please\nMake exactly one/);
  await runDelivery(host, judge, [{ calls: [SUBMIT] }]);
  assert.equal(B.findRequest(team.board, 1).words[0].text, '/fix login');
});

// ---- 模式（§5.1、§12.11） ----

test('TB-05 /team in off mode enters once; once returns to off when the turn ends with nothing open', async () => {
  const { team, host, user, state } = await setup();
  team.onUserPrompt({ text: 'quick question' }, undefined, 'once');
  const reply = await nextDialog(host);
  assert.equal(team.info().team.mode, 'once');
  const judge = await nextDelivery(host, 'U.create');
  await runDelivery(host, judge, [{ calls: [{ name: 'reply_via_dialog', args: {} }] }]);
  await reply.ready;
  await runDelivery(host, reply, [{ text: 'An answer.' }]);
  await until(() => team.info().team.mode === 'off', 'once to end');
  assert.deepEqual(customs(user, 'mori.team'), [{ mode: 'once' }, { mode: 'off' }],
    'mori.team holds the mode only: changing the mode changes no file tools (file-system-permissions.md §8.6)');
  assert.deepEqual(state.locks, [true, false], 'the model button is locked in team mode (§12.11)');
});

test('TB-05 turning off with an open request is once; with nothing open it is off', async () => {
  const { team } = await setup();
  await team.setMode('on');
  assert.equal((await team.setMode('off')).mode, 'off');
  await team.setMode('on');
  addTask(team);
  assert.equal((await team.setMode('off')).mode, 'once');
  assert.equal((await team.setMode('on')).mode, 'always');
});

test('TB-38 turning team mode off while the dialog is blocked goes straight to off and stops the open tasks',
  async () => {
    const { team, host, state } = await setup();
    await team.setMode('on');
    addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    await beginRun(host, start);
    state.blocked = true;
    assert.equal((await team.setMode('off')).mode, 'off');
    const task = B.findTask(team.board, 'T1');
    assert.equal(task.status, 'stopped');
    assert.equal(task.stopReason, 'user');
    assert.ok(host.aborts.some((item) => item.id === 'U.t1.executor' && item.reason === 'user'));
    assert.equal(B.findRequest(team.board, 1).status, 'open', 'the request stays on the board');
    await finishRun(host, start, []);
  });

// ---- 重新打开（§11.6） ----

test('TB-36 reopening places missing progress entries; the next message wakes close for an ended open request',
  async () => {
    const prepareUser = async (_user, cwd) => {
      let board = B.newBoard();
      board = B.submitRequest(board, { title: 'Ended', goal: 'g', acceptance: null, quote: null },
        { message: 'm', history: [] }, 1).board;
      board = B.createTask(board, { request: 1, title: 'Only', description: 'd', assignee: 'executor',
        limits: { write: false }, dependsOn: [] }, 2).board;
      board.tasks[0] = { ...board.tasks[0], status: 'done', holder: null, closedAt: 3 };
      await B.saveBoard(join(cwd, 'teams', 'U'), board);
    };
    const { team, host, user } = await setup(undefined, null, { restored: true, prepareUser });
    assert.deepEqual(customs(user, 'mori.progress'), [{ request: 1 }]);
    await team.setMode('on');
    team.onUserPrompt({ text: 'what now?' }, undefined, undefined);
    const close = await nextDelivery(host, 'U.close.1');
    assert.match(close.text, /^\[Mori\] All tasks of request 1 have ended\./);
    assert.ok(host.deliveries.some((item) => item.id === 'U.create'), 'the message still goes to create');
  });

// ---- 回执的其他位置（§13.2） ----

test('TB-08 a judged message withdrawn from the pi queue leaves; its receipt follows the current assistant message',
  async () => {
    const { team, host, user } = await setup();
    await team.setMode('on');
    host.entry('U').running = true;
    team.onUserPrompt({ text: 'fix it' }, 'followUp', undefined);
    await runDelivery(host, await nextDelivery(host, 'U.create'), [{ calls: [SUBMIT] }, { calls: [CREATE] }]);
    await until(() => host.queued.length === 1, 'handed to pi');
    host.entry('U').spec.onEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
    assert.deepEqual(team.withdrawDeciding(), [], 'nothing waits for create');
    assert.deepEqual(customs(user, 'mori.receipt'), [], 'the dialog is outputting');
    await assistantTurn(host.entry('U'), { text: 'Still answering the earlier message.' });
    await Promise.resolve();
    assert.deepEqual(shape(user).filter((kind) => kind !== 'mori.team'),
      ['assistant', 'mori.receipt', 'mori.progress']);
  });

test('TB-10 TB-08 merged session: the message goes to the user session; the receipt lands at the tool call',
  async () => {
    const { team, host, user } = await setup(roles.parseRoleFiles([], deps));
    await team.setMode('on');
    team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
    const reply = await nextDialog(host);
    assert.equal(host.deliveries.some((item) => item.id === 'U.create'), false, 'no create session');
    await reply.ready;
    await runDelivery(host, reply, [{ calls: [SUBMIT] }, { calls: [CREATE] }, { text: 'Registered request 1.' }]);
    await until(() => customs(user, 'mori.progress').length, 'the progress entry');
    assert.deepEqual(shape(user).filter((kind) => kind !== 'mori.team'), ['user', 'assistant', 'mori.receipt',
      'toolResult', 'assistant', 'toolResult', 'assistant', 'mori.progress']);
    assert.equal(lastDeciding(host), undefined, 'merged sessions have no deciding phase');
  });
