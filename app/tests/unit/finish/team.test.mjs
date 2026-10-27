// mori-team 与 mori-approval 的配合改动（docs/specs/finish-check.md §4.3、§4.4、§8、§11，验收 FC-03、FC-04、FC-18、FC-19
// 的单元层）：文件系统合并之后（§11 左列，2026-10-27），用户会话每次运行只动职责工具（applyDutyTools），finish 不在它的
// 表里、一直启用；finish 是路径闸的职责工具（DUTY_TOOLS，种类 duty，免批准、不被收窄），协作模式下对话的收窄
// TEAM_DIALOG_LIMITS 也放过它；一次 pi 运行只有一份运行记录（runStarted），强制填写的运行压缩后重试时照样套写法
// （laneEvent 的 compaction_end）；用户会话里检查那次请求出错时这次运行当作已完成（onMessageEnd）。用平行 Agent 的测试
// 会话表（taskboard/teamHarness.mjs，synthetic）驱动 Team，路径闸用真实的 approval.ts：pi 事件、检查那一行与出错的
// 助手消息都是手写的（synthetic），不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  B, SPLIT, addTask, assistantTurn, beginRun, deps, finishRun, nextDelivery, nextDialog, roles, runDelivery, setup,
  until,
} from '../taskboard/teamHarness.mjs';

const FC = await loadKernelModule('src/kernel/finishCheck.ts');
const { ApprovalPolicy } = await loadKernelModule('src/kernel/approval.ts');
const PG = await loadKernelModule('src/kernel/pathGate.ts');
const { TEAM_DIALOG_LIMITS } = await loadKernelModule('src/kernel/limits.ts');

const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';
/** 基座的默认工具（teamHarness 的 baseTools）：碰文件的那一组，模式改变不动它们（file-system-permissions.md §8.6）。 */
const OFF_SET = ['read', 'bash', 'edit', 'write'];
/** 合并会话的角色：没有角色文件（基座持有三项权限）。 */
const MERGED = roles.parseRoleFiles([], deps);
/** synthetic：chat 持有对话（关闭模式下另有 agent_message，因为有别的角色）、planner 持有立项与结案、executor。 */
const CHAT = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
], deps);
/** synthetic：只有 executor，基座持有三项权限（合并会话），task 实例发给 mori 的消息进用户会话。 */
const EXECUTOR_ONLY = roles.parseRoleFiles([
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
], deps);
assert.deepEqual([CHAT.problems, EXECUTOR_ONLY.problems], [[], []]);
assert.equal(EXECUTOR_ONLY.merged, true);

const SUBMIT = { name: 'request_submit', args: { title: 'Login page is blank', goal: 'Fix it' } };
/** 一次模型请求（流函数包装问 shape 时给的）。 */
const ATTEMPT = { ref: 'fake/model', api: 'openai-completions', context: { messages: [] } };

// ---- synthetic 的 pi ----

/**
 * synthetic：mori-memory 在用户会话注册了 finish、pi 建会话时按 defaultActive 启用它（teamHarness 的 setup 的
 * prepareUser）。定义取 kernel/finishCheck.ts 的 finishTool；测试会话表执行工具时总调 prepareArguments，这里给原样
 * 返回的那个（pi 没有 prepareArguments 时就是原样校验）。
 */
function registerFinish(user) {
  user.api.registerTool({ ...FC.finishTool(), prepareArguments: (args) => args });
  user.api.setActiveTools([...user.api.getActiveTools(), 'finish']);
}

/** 用户会话的一次运行开始：before_agent_start（mori-team 设好这次的工具），agent_start；返回这次的运行记录。 */
function beginUserRun(team, user) {
  user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
  return team.user.run;
}

/**
 * @brief 用户会话的路径闸（真实的 ApprovalPolicy，同 sessions.ts startUser 的 gate：narrowing 每次调用时取
 *        team.userNarrowing()）；对一个调用先预告、再交给 tool_call 处理器。
 * @param team 协作
 * @param cwd 工作路径
 * @param policy 共用的批准状态（默认 Ask each time）
 * @return (toolName, input) => { gates：这个调用的 mori.tool_gate 值, result：处理器的结果, requests：批准请求 }
 */
function dialogGate(team, cwd, policy = new ApprovalPolicy()) {
  const sent = [];
  const gate = policy.gate({ prefix: '', send: (event) => sent.push(event), cwd, kind: 'user', userSessionId: 'U',
    narrowing: () => team.userNarrowing() });
  let handler;
  gate.extension()({ on: (name, fn) => { if (name === 'tool_call') handler = fn; } });
  let next = 0;
  return async (toolName, input = {}) => {
    next += 1;
    const id = `g-${toolName}-${next}`;
    gate.announce(id, toolName, input);
    const result = await handler({ type: 'tool_call', toolCallId: id, toolName, input }, { cwd, signal: undefined,
      sessionManager: { getSessionId: () => 'U' } });
    const gates = sent.filter((event) => event.type === 'mori.tool_gate' && event.toolCallId === id)
      .map((event) => event.gate);
    return { gates, result, requests: sent.filter((event) => event.type === 'mori.approval_request') };
  };
}

/** 排过序的启用的工具。 */
const activeOf = (user) => [...user.api.getActiveTools()].sort();

/**
 * synthetic：运行要结束时 mori-memory 在边界加了检查那一行，pi 在同一次运行里接着跑：只有 agent_start，
 * 没有 before_agent_start（§3 第 2 条）。
 * @param entry 用户会话（测试会话表的条目）
 */
function checkAndContinue(entry) {
  entry.session.sessionManager.appendCustomMessageEntry('mori.finish_check', FC.checkLine(['taste']), false);
  entry.spec.onEvent({ type: 'agent_start' });
}

/**
 * synthetic：一条没成功的助手消息（出错，或被截断），照 pi 的顺序先发 message_end、再写进会话文件（§3 第 14 条）。
 * @param entry 会话（测试会话表的条目）
 * @param reply { text：带着的文字（可以为空），stopReason，errorMessage }
 */
function failedReply(entry, reply) {
  const message = { role: 'assistant', content: reply.text ? [{ type: 'text', text: reply.text }] : [],
    provider: 'fake', model: 'model', stopReason: reply.stopReason ?? 'error', errorMessage: reply.errorMessage,
    timestamp: Date.now(), api: 'openai-completions', usage: {} };
  entry.spec.onEvent({ type: 'message_start', message });
  entry.spec.onEvent({ type: 'message_end', message });
  entry.session.sessionManager.appendMessage(message);
}

/** synthetic：一条只有文字的助手消息，不经过 shape（这条消息的请求已经问过了）。 */
function textReply(entry, text) {
  const message = { role: 'assistant', content: [{ type: 'text', text }], provider: 'fake', model: 'model',
    stopReason: 'stop', timestamp: Date.now(), api: 'openai-completions', usage: {} };
  entry.spec.onEvent({ type: 'message_start', message });
  entry.session.sessionManager.appendMessage(message);
  entry.spec.onEvent({ type: 'message_end', message });
}

/** 某个 id 的会话在 Team 里的状态。 */
const laneOf = (team, id) => [...team.lanes.values()].find((lane) => lane.id === id);

/** 记下 console.error 的每一行，测试结束后还原。 */
function captureErrors(t) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => {
    lines.push(args.join(' '));
  });
  return lines;
}

// ---- FC-03 一直启用（文件系统合并之后：applyDutyTools 不动 finish，路径闸放过它，§11） ----

test('FC-03 off mode with the base as dialog: finish stays on in both runs, nothing narrows the run and the gate '
  + 'lets finish through', async () => {
  const { team, user, cwd } = await setup(MERGED, null, { prepareUser: registerFinish });
  const call = dialogGate(team, cwd);
  for (const n of [1, 2]) {
    beginUserRun(team, user);
    assert.ok(user.api.getActiveTools().includes('finish'), `run ${n}: finish is on`);
    assert.equal(team.userNarrowing(), null, `run ${n}: off mode is not narrowed`);
    const finish = await call('finish');
    assert.deepEqual([finish.gates, finish.result, finish.requests], [['free'], undefined, []], `run ${n}`);
    team.onUserEvent({ type: 'agent_settled' });
  }
});

test('FC-03 split team mode: applyDutyTools leaves finish on (not memory); under TEAM_DIALOG_LIMITS the gate gives '
  + 'finish free while bash gets RELAY_ONLY; the dialog calling finish gets Confirmed.', async () => {
  const { team, user, cwd } = await setup(SPLIT, null, { prepareUser: registerFinish });
  await team.setMode('on');
  const call = dialogGate(team, cwd);
  for (const n of [1, 2]) {
    beginUserRun(team, user);
    const active = activeOf(user);
    assert.ok(active.includes('finish') && !active.includes('memory'), `run ${n}: ${active.join(', ')}`);
    assert.deepEqual(team.userNarrowing(), { owner: 'dialog', limits: TEAM_DIALOG_LIMITS }, `run ${n}`);
    const finish = await call('finish');
    assert.deepEqual([finish.gates, finish.result], [['free'], undefined], `run ${n}: finish is not RELAY_ONLY`);
    const bash = await call('bash', { command: 'npm test' });
    assert.deepEqual([bash.gates, bash.result], [['deny'], { block: true, reason: RELAY_ONLY }], `run ${n}`);
    assert.deepEqual(bash.requests, [], 'no approval card');
    team.onUserEvent({ type: 'agent_settled' });
  }
  // 对话调 finish 得到 finish 自己的结果，不是 RELAY_ONLY、也不是 Tool finish not found（§8.2、§11）
  const run = beginUserRun(team, user);
  const [result] = await assistantTurn(user, { calls: [{ name: 'finish' }] });
  assert.deepEqual([result.isError === true, result.content[0].text, result.terminate], [false, 'Confirmed.', true]);
  assert.equal(team.user.run, run);
  team.onUserEvent({ type: 'agent_settled' });
});

test('FC-03 merged session in team mode: finish stays on and the gate lets it through under TEAM_DIALOG_LIMITS',
  async () => {
    const { team, user, cwd } = await setup(MERGED, null, { prepareUser: registerFinish });
    await team.setMode('on');
    const call = dialogGate(team, cwd);
    for (const n of [1, 2]) {
      beginUserRun(team, user);
      assert.ok(user.api.getActiveTools().includes('finish'), `run ${n}: finish is on`);
      assert.deepEqual(team.userNarrowing(), { owner: 'dialog', limits: TEAM_DIALOG_LIMITS }, `run ${n}`);
      assert.deepEqual((await call('finish')).result, undefined, `run ${n}`);
      team.onUserEvent({ type: 'agent_settled' });
    }
  });

test('FC-03 back in off mode after team mode: finish is still on next to the file tools', async () => {
  const { team, user } = await setup(SPLIT, null, { prepareUser: registerFinish });
  beginUserRun(team, user);
  team.onUserEvent({ type: 'agent_settled' });
  await team.setMode('on');
  beginUserRun(team, user);
  team.onUserEvent({ type: 'agent_settled' });
  await team.setMode('off');
  for (const n of [1, 2]) {
    beginUserRun(team, user);
    const active = activeOf(user);
    assert.ok(OFF_SET.every((name) => active.includes(name)) && active.includes('finish'),
      `run ${n}: ${active.join(', ')}`);
    assert.equal(team.userNarrowing(), null);
    team.onUserEvent({ type: 'agent_settled' });
  }
});

// ---- FC-04 免批准（路径闸的职责工具） ----

test('FC-04 finish is a duty tool of the path gate: kind duty, free in Ask each time and Full access, with or '
  + 'without the dialog narrowing; other tools still ask', async () => {
  assert.ok(PG.DUTY_TOOLS.has('finish'));
  assert.equal(PG.callKind('finish', {}), 'duty');
  assert.equal(PG.callKind('finish', { reply: 'Done.' }), 'duty', 'the arguments do not change the kind');
  const { team, cwd } = await setup(SPLIT, null, { prepareUser: registerFinish });
  for (const mode of ['ask', 'full']) {
    for (const on of [false, true]) {
      await team.setMode(on ? 'on' : 'off');
      const call = dialogGate(team, cwd, new ApprovalPolicy({ mode }));
      const finish = await call('finish');
      assert.deepEqual([finish.gates, finish.result, finish.requests], [['free'], undefined, []], `${mode} ${on}`);
    }
  }
  await team.setMode('off');
  const sent = [];
  const gate = new ApprovalPolicy().gate({ prefix: '', send: (event) => sent.push(event), cwd, kind: 'user',
    userSessionId: 'U' });
  gate.announce('c1', 'finish', {});
  gate.announce('c2', 'bash', { command: 'npm test' });
  assert.deepEqual(sent.map((event) => [event.toolName, event.gate]), [['finish', 'free'], ['bash', 'ask']],
    'announced as free, no mori.approval_request; bash still asks');
});

// ---- FC-18 一次运行一份运行记录 ----

test('FC-18 the user session keeps one run record per pi run: the finish check continues it unchanged', async () => {
  const { team, host, user } = await setup(CHAT, null, { prepareUser: registerFinish });
  user.running = true;
  const run = beginUserRun(team, user);
  const ask = user.api.tools.get('agent_message');
  const pending = ask.execute('a1', ask.prepareArguments({ to: 'executor', text: 'Is a.ts safe? (synthetic)' }),
    undefined, undefined, {});
  await runDelivery(host, await nextDelivery(host, 'U.ask.1.executor'), [{ text: 'Yes.' }]);
  await pending;
  assert.equal(team.user.sentThisTurn, 1);
  await assistantTurn(user, { text: 'The executor says a.ts is safe.' });
  checkAndContinue(user);
  assert.equal(team.user.run, run, 'the same run record');
  assert.deepEqual([run.mode, team.userNarrowing()], ['off', null], 'the mode this run started with, not narrowed');
  assert.equal(run.lastText, 'The executor says a.ts is safe.');
  assert.equal(team.user.sentThisTurn, 1, 'the per-turn question count is not reset');
  await assistantTurn(user, { calls: [{ name: 'finish' }] });
  assert.equal(run.lastText, 'The executor says a.ts is safe.', 'a finish-only message has no text');
  checkAndContinue(user);
  // FC-11 fc-a-text：确认时在同一条消息里写的那句话就是最终回复（规格 §8.4）
  await assistantTurn(user, { text: 'The reply stands.', calls: [{ name: 'finish' }] });
  assert.equal(run.lastText, 'The reply stands.', 'FC-11: text written with finish becomes run.lastText');
  user.running = false;
  team.onUserEvent({ type: 'agent_settled' });
  assert.equal(team.user.run, null);
  const next = beginUserRun(team, user);
  assert.notEqual(next, run, 'the next run gets a new record');
  assert.deepEqual([next.lastText, team.user.sentThisTurn], ['', 0]);
  team.onUserEvent({ type: 'agent_settled' });
});

test('FC-18 merged session: the command and the judgment of a run survive the finish check; mori.progress once',
  async () => {
    const { team, host, user } = await setup(MERGED, null, { prepareUser: registerFinish, commands: ['deploy'] });
    await team.setMode('on');
    assert.equal(team.takesPrompt('/deploy now', undefined), false);
    const command = { id: 'U', text: 'Generated by the deploy command (synthetic)', resolve: () => undefined };
    await beginRun(host, command);
    const first = team.user.run;
    assert.equal(first.command, 'deploy');
    await assistantTurn(user, { text: 'Deployed.' });
    checkAndContinue(user);
    assert.deepEqual([team.user.run, first.command], [first, 'deploy'], 'the work card still says the command');
    await finishRun(host, command, [{ calls: [{ name: 'finish' }] }]);
    team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
    const reply = await nextDialog(host);
    await reply.ready;
    await beginRun(host, reply);
    const run = team.user.run;
    assert.ok(run !== first && run.judgment?.user, 'a new run that judges your message');
    await assistantTurn(user, { calls: [SUBMIT] });
    await assistantTurn(user, { text: 'Registered request 1.' });
    const judgment = run.judgment;
    assert.deepEqual(judgment.registered, [1]);
    checkAndContinue(user);
    assert.deepEqual([team.user.run, run.judgment, run.ended], [run, judgment, null], 'the judgment goes on');
    assert.equal(run.lastText, 'Registered request 1.');
    await finishRun(host, reply, [{ calls: [{ name: 'finish' }] }]);
    const progress = () => user.session.sessionManager.getEntries().filter((entry) => entry.type === 'custom'
      && entry.customType === 'mori.progress');
    await until(() => progress().length === 1, 'mori.progress');
    assert.deepEqual(progress().map((entry) => entry.data), [{ request: 1 }]);
    const reminder = await nextDelivery(host, 'U');
    assert.match(reminder.text, /\[Mori\] Request 1 has no tasks\./, 'the judgment ended normally');
    reminder.resolve();
  });

test('FC-18 a task instance keeps one run record per pi run; the next run gets a new one', async () => {
  const { team, host } = await setup(SPLIT, 'C');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  const entry = host.entry('U.t1.executor');
  const lane = laneOf(team, 'U.t1.executor');
  await beginRun(host, start);
  const run = lane.run;
  await assistantTurn(entry, { calls: [{ name: 'bash', args: { command: 'npm test' }, result: 'pass' }] });
  await assistantTurn(entry, { text: 'All good.' });
  // synthetic：同一次 pi 运行里再来一个 agent_start（溢出压缩后的重试、文件系统的提醒）
  entry.spec.onEvent({ type: 'agent_start' });
  assert.deepEqual([lane.run, run.lastText, run.assistants], [run, 'All good.', 2]);
  await finishRun(host, start, []);
  const forced = await nextDelivery(host, 'U.t1.executor', 1);
  await beginRun(host, forced);
  assert.notEqual(lane.run, run, 'the forced fill is a new run');
  assert.ok(lane.run.forced);
  forced.resolve();
});

/**
 * 强制填写的实例运行（C 级，synthetic）：第一条消息没成功（溢出出错或可恢复的截断），compaction_end 带 willRetry
 * 之后 pi 在同一次运行里重试；重试的请求照样套写法，正常回答之后的请求不套，填出来的交接按这次的写法解析。
 * @param failed 第一条消息（failedReply 的参数）
 */
async function forcedRetry(failed) {
  const { team, host } = await setup(SPLIT, 'C');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  const entry = host.entry('U.t1.executor');
  await runDelivery(host, start, [{ calls: [{ name: 'bash', args: { command: 'npm test' }, result: 'pass' }] },
    { text: 'All good.' }]);
  const forced = await nextDelivery(host, 'U.t1.executor', 1);
  await beginRun(host, forced);
  const lane = laneOf(team, 'U.t1.executor');
  const run = lane.run;
  const shape = () => entry.spec.model.shape(ATTEMPT);
  const first = shape();
  assert.deepEqual([first?.mode, run.formMode], ['C', 'C'], 'the first request is shaped');
  failedReply(entry, failed);
  assert.equal(shape(), null, 'without a reset the retry would not be shaped');
  entry.spec.onEvent({ type: 'compaction_end', reason: 'overflow', result: { summary: 's' }, aborted: false,
    willRetry: true });
  assert.deepEqual([run.assistants, run.formMode], [0, null]);
  entry.spec.onEvent({ type: 'agent_start' });
  assert.equal(lane.run, run, 'the retry stays in the same run record');
  const retry = shape();
  assert.deepEqual(retry, first, 'the retried request is shaped');
  assert.equal(run.formMode, retry.mode);
  textReply(entry, '<conclusion>Tests pass.</conclusion><outcome>done</outcome><next>reviewer</next>'
    + '<open_items></open_items><evidence>#1</evidence>');
  assert.equal(shape(), null, 'after a normal answer the next request is not shaped');
  entry.spec.onEvent({ type: 'compaction_end', reason: 'threshold', result: { summary: 's' }, aborted: false,
    willRetry: false });
  assert.equal(run.assistants, 1, 'a compaction without retry changes nothing');
  await finishRun(host, forced, []);
  const task = await until(() => B.findTask(team.board, 'T1')?.holder?.kind === 'close'
    && B.findTask(team.board, 'T1'), 'T1 with close');
  assert.deepEqual([task.handoffs[0].outcome, task.handoffs[0].suggestedNext], ['done', 'reviewer'],
    'the C-tier answer of the retry was parsed');
}

test('FC-18 a forced fill whose first message overflows is shaped again on the retry after compaction', async () => {
  await forcedRetry({ stopReason: 'error', errorMessage: 'prompt is too long: context overflow (synthetic)' });
});

test('FC-18 a forced fill whose first reply is recoverably truncated is shaped again on the retry', async () => {
  await forcedRetry({ stopReason: 'length', text: '<conclusion>Tests pa' });
});

// ---- FC-19 检查那次请求出错按已完成算（onMessageEnd） ----

/**
 * 合并会话里 T1 的实例给 mori（立项，就是用户会话）发消息并等回复（synthetic）；返回等回复的结果与用户会话的那次投递。
 */
async function waitingOnUser() {
  const ctx = await setup(EXECUTOR_ONLY, null);
  const { team, host } = ctx;
  await team.setMode('on');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await beginRun(host, start);
  const message = host.entry('U.t1.executor').api.tools.get('agent_message');
  const pending = message.execute('m1', message.prepareArguments({ to: 'mori', text: 'Postgres or SQLite?',
    wait: true }), undefined, undefined, {});
  const delivery = await nextDelivery(host, 'U');
  await beginRun(host, delivery);
  return { ...ctx, pending, delivery, start };
}

test('FC-19 the finish check request fails: the run counts as completed and the waiter gets the reply', async (t) => {
  const errors = captureErrors(t);
  const { team, host, user, pending, delivery, start } = await waitingOnUser();
  await assistantTurn(user, { text: 'Use SQLite.' });
  checkAndContinue(user);
  failedReply(user, { text: 'Use Postg', errorMessage: '400 Bad Request (synthetic)' });
  const run = team.user.run;
  assert.equal(run.error, null, 'the error is not recorded');
  assert.equal(run.lastText, 'Use SQLite.', 'the partial text of the failed message does not count');
  assert.deepEqual(errors.filter((line) => line.includes('finish check')), ['[kernel] U: the finish check request '
    + 'failed (400 Bad Request (synthetic)); the run counts as completed']);
  await finishRun(host, delivery, []);
  const reply = await pending;
  assert.equal(reply.isError === true, false);
  assert.equal(reply.content[0].text, 'Mori replied: Use SQLite.');
  start.resolve();
});

test('FC-19 the check request is cut off, retried after compaction and fails: the run still counts as completed and '
  + 'the waiter gets the reply before the check', async (t) => {
  const errors = captureErrors(t);
  const { team, host, user, pending, delivery, start } = await waitingOnUser();
  await assistantTurn(user, { text: 'Use SQLite.' });
  checkAndContinue(user);
  failedReply(user, { text: 'Use Postg', stopReason: 'length' });
  assert.equal(team.user.run.lastText, 'Use Postg', 'the cut-off reply counts until pi omits it');
  const sm = user.session.sessionManager;
  sm.appendContextEdit(sm.getLeafId(), null);
  sm.appendCompaction('Summary (synthetic).', null, 9000);
  failedReply(user, { text: 'Use Po', errorMessage: '500 Internal Server Error (synthetic)' });
  assert.equal(team.user.run.error, null);
  assert.equal(team.user.run.lastText, 'Use SQLite.');
  assert.equal(errors.filter((line) => line.includes('finish check request failed')).length, 1);
  await finishRun(host, delivery, []);
  const reply = await pending;
  assert.equal(reply.isError === true, false);
  assert.equal(reply.content[0].text, 'Mori replied: Use SQLite.');
  start.resolve();
});

test('FC-19 an error after work following the check, or with no check at all, still fails the run', async (t) => {
  const errors = captureErrors(t);
  const cases = [
    ['work after the check', async (user) => {
      await assistantTurn(user, { text: 'Use SQLite.' });
      checkAndContinue(user);
      await assistantTurn(user, { calls: [{ name: 'bash', args: { command: 'echo fc' }, result: 'fc' }] });
    }],
    ['the first request', async () => undefined],
  ];
  for (const [label, before] of cases) {
    const { team, host, user, pending, delivery, start } = await waitingOnUser();
    await before(user);
    failedReply(user, { text: 'Half an answ', errorMessage: '400 Bad Request (synthetic)' });
    assert.equal(team.user.run.error, '400 Bad Request (synthetic)', label);
    assert.equal(team.user.run.lastText, 'Half an answ', `${label}: unchanged behaviour`);
    await finishRun(host, delivery, []);
    const reply = await pending;
    assert.equal(reply.isError, true, `${label}: the waiter gets the failure`);
    assert.match(reply.content[0].text, /400 Bad Request \(synthetic\)/, label);
    start.resolve();
  }
  assert.deepEqual(errors.filter((line) => line.includes('finish check')), []);
});
