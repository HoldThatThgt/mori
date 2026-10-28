// kernel/away.ts 的单元测试（docs/specs/file-system-permissions.md §9；file-system.md §14 的原文、§19.2 FS-70–FS-76、
// FS-78、FS-81 的单元部分）：焦点与计时（注入的时钟）、MORI_AWAY_TIMEOUT_MS、所有卡同一个截止时刻、请求事件先于
// mori.away_timer、请求不论怎么结束都注销、<userData>/away.json 的读写与错误、到时的默认答案（批准经 ApprovalGate、
// 提问经 AskQuestions、扩展询问经 ExtensionUi）、记录的内容与参数截短、agent_before_settle 的提醒。
// 工具调用、pi 的事件与会话 id 都是手写的（synthetic）；awayKit.mjs 每个测试给一份全新的模块状态。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DB_QUESTION, PARTS_QUESTION, asksOf, awayKit, eventsOf, gateOf, indexOf, settle, tempDir, textOf, uiOf,
} from './awayKit.mjs';

/** 三档时长的毫秒数（§9.6） */
const MS = { '60s': 60_000, '5m': 300_000, '10m': 600_000 };
/** 到时拒绝的原文（§14），时长与最后一句可换 */
const denied = (duration, end = 'Mention it in your final summary.') =>
  `The user was away and didn’t answer within ${duration}, so this was denied. Don’t retry it. ${end}`;
/** 提醒原文的第一行与两种最后一句（§14） */
const REMINDER_HEAD = '[Mori] The user was away, so Mori decided these without them during this turn:';
const REMINDER_SUMMARY = "Don't retry the denied calls. Mention all of these in your final summary.";
const REMINDER_HANDOFF = "Don't retry the denied calls. Mention all of these in your handoff.";

/** @brief 一个用户会话 U 与它的批准状态、对话的批准扩展（工作路径是临时目录）。 */
async function userSetup(t, options = {}) {
  const kit = await awayKit(t, options);
  const cwd = tempDir(t, 'mori-away-cwd-');
  const policy = new kit.K.approval.ApprovalPolicy();
  const dialog = gateOf(kit, policy, { sessionId: 'U', cwd });
  return { kit, cwd, policy, dialog };
}

/** @brief 同一个用户会话 U 里的一个后台实例（task 实例 executor，或 kind 指定的种类）。 */
function instanceGate(setup, kind = 'task', extra = {}) {
  const id = extra.id ?? `U.${kind}.1`;
  return gateOf(setup.kit, setup.policy, { sessionId: id, userSessionId: 'U', kind, instance: true,
    cwd: setup.cwd, ...extra });
}

/** @brief 这个用户会话正在计时的卡的请求 id。 */
function timing(kit, userSessionId = 'U') {
  return kit.A.awayTimers(userSessionId).map((timer) => timer.requestId).sort();
}

// ---- FS-70 焦点与计时 ----

test('FS-70 while the window has focus a pending card waits past the timeout and gets no mori.away_timer',
  async (t) => {
    const { kit, dialog } = await userSetup(t);
    const asks = asksOf(kit, 'U');
    const { context, ui } = uiOf(kit, 'U');
    void dialog.call('bash', { command: 'npm test' });
    void asks.run([DB_QUESTION]);
    void context.confirm('Continue?', 'Run the migration');
    await settle();
    kit.clock.advance(MS['10m'] * 10);
    await settle();
    assert.deepEqual(eventsOf(kit.log, 'mori.away_timer'), []);
    assert.equal(dialog.gate.requests().length, 1, 'the approval card still waits');
    assert.equal(asks.asks.requests().length, 1, 'the question card still waits');
    assert.equal(ui.requests().length, 1, 'the extension question still waits');
    assert.deepEqual(kit.records, []);
    assert.deepEqual(kit.A.awayTimers('U'), []);
  });

test('FS-70 losing focus gives every pending card the same deadline on the user session envelope', async (t) => {
  // 时钟每读一次 now() 前进 1 毫秒：每项各读一次 now() 的话截止时刻就各不相同
  const setup = await userSetup(t, { tick: 1 });
  const { kit, dialog } = setup;
  const executor = instanceGate(setup);
  const asks = asksOf(kit, 'U');
  const { context } = uiOf(kit, 'U');
  void dialog.call('bash', { command: 'npm test' });
  kit.clock.advance(1000);
  void executor.call('bash', { command: 'npm run build' });
  kit.clock.advance(1000);
  void asks.run([DB_QUESTION]);
  kit.clock.advance(1000);
  void context.select('Pick one', ['a', 'b']);
  await settle();
  kit.clock.advance(5000);
  const blurAt = kit.clock.peek();
  kit.A.setFocus(false);
  const timers = eventsOf(kit.log, 'mori.away_timer');
  assert.deepEqual(timers.map((item) => item.event.requestId).sort(),
    ['U.task.1:approval-1', 'approval-1', 'ask-1', 'question-1']);
  assert.deepEqual(timers.map((item) => [item.sessionId, item.event.deadline]),
    Array(4).fill(['U', blurAt + MS['5m']]), 'the user session envelope and the deadline of the first read at blur');
  assert.deepEqual(kit.A.awayTimers('U').map((timer) => timer.deadline), Array(4).fill(blurAt + MS['5m']));
  assert.deepEqual(timing(kit), ['U.task.1:approval-1', 'approval-1', 'ask-1', 'question-1']);
});

test('FS-70 telling the same focus again changes nothing but is still logged', async (t) => {
  const logs = t.mock.method(console, 'log', () => undefined);
  const { kit, dialog } = await userSetup(t);
  const first = dialog.call('bash', { command: 'npm test' });
  await settle();
  const blurAt = kit.clock.now();
  kit.A.setFocus(false);
  kit.clock.advance(60_000);
  const sent = kit.log.length;
  kit.A.setFocus(false);
  assert.deepEqual(kit.log.slice(sent), [], 'a second false sends no mori.away_timer');
  assert.deepEqual(kit.A.awayTimers('U'), [{ requestId: 'approval-1', deadline: blurAt + MS['5m'] }]);
  assert.equal(kit.clock.pending(), 1, 'the timer is not started again');
  kit.clock.advance(MS['5m'] - 60_000 - 1);
  assert.deepEqual(kit.records, []);
  kit.clock.advance(1);
  assert.equal((await first.result).reason, denied('5 minutes'), 'it expires at the first deadline');
  const askAt = kit.clock.now();
  void asksOf(kit, 'U').run([DB_QUESTION]);
  await settle();
  kit.A.setFocus(true);
  const back = kit.log.length;
  kit.A.setFocus(true);
  assert.deepEqual(kit.log.slice(back), [], 'a second true sends no deadline null');
  assert.deepEqual(eventsOf(kit.log, 'mori.away_timer', 'ask-1').map((item) => item.event.deadline),
    [askAt + MS['5m'], null]);
  const lines = logs.mock.calls.map((call) => String(call.arguments[0]))
    .filter((line) => line.startsWith('[kernel] window focus: '));
  assert.deepEqual(lines, ['[kernel] window focus: false', '[kernel] window focus: false',
    '[kernel] window focus: true', '[kernel] window focus: true'], 'one log line per call');
});

test('FS-70 focus may arrive before startAway: a card registered after the start times at once', async (t) => {
  const { kit, dialog } = await userSetup(t, { beforeStart: (K) => K.away.setFocus(false) });
  const at = kit.clock.now();
  const { result } = dialog.call('bash', { command: 'npm test' });
  await settle();
  assert.deepEqual(eventsOf(kit.log, 'mori.away_timer').map((item) => [item.sessionId, item.event.requestId,
    item.event.deadline]), [['U', 'approval-1', at + MS['5m']]]);
  kit.clock.advance(MS['5m']);
  assert.equal((await result).reason, denied('5 minutes'));
});

test('FS-70 a card that arrives while away gets its arrival time plus the timeout, after its request event',
  async (t) => {
    const setup = await userSetup(t);
    const { kit, dialog } = setup;
    kit.A.setFocus(false);
    const arrivals = new Map();
    const arrive = async (requestId, start) => {
      kit.clock.advance(7000);
      arrivals.set(requestId, kit.clock.now());
      start();
      await settle();
    };
    await arrive('approval-1', () => dialog.call('write', { path: 'a.md', content: 'x' }));
    await arrive('U.task.1:approval-1', () => instanceGate(setup).call('bash', { command: 'npm test' }));
    await arrive('ask-1', () => asksOf(kit, 'U').run([DB_QUESTION]));
    await arrive('question-1', () => uiOf(kit, 'U').context.input('Name?'));
    const requestTypes = { 'approval-1': 'mori.approval_request', 'U.task.1:approval-1': 'instance_request',
      'ask-1': 'mori.question_request', 'question-1': 'mori.ui_request' };
    for (const [requestId, at] of arrivals) {
      const [timer] = eventsOf(kit.log, 'mori.away_timer', requestId);
      assert.equal(timer.event.deadline, at + MS['5m'], requestId);
      assert.equal(timer.sessionId, 'U', requestId);
      const request = indexOf(kit.log, requestTypes[requestId], requestId);
      assert.ok(request >= 0 && request < indexOf(kit.log, 'mori.away_timer', requestId),
        `${requestId}: the request event comes before its mori.away_timer`);
    }
  });

test('FS-70 regaining focus sends deadline null to each timing card; losing it again starts over', async (t) => {
  const { kit, dialog } = await userSetup(t);
  const asks = asksOf(kit, 'U');
  const pending = dialog.call('bash', { command: 'npm test' }).result;
  void asks.run([DB_QUESTION]);
  await settle();
  kit.A.setFocus(false);
  kit.clock.advance(MS['5m'] - 1000);
  const before = kit.log.length;
  kit.A.setFocus(true);
  const sent = kit.log.slice(before).map((item) => [item.sessionId, item.event.type, item.event.requestId,
    item.event.deadline]);
  assert.deepEqual(sent.sort((a, b) => a[2].localeCompare(b[2])), [
    ['U', 'mori.away_timer', 'approval-1', null], ['U', 'mori.away_timer', 'ask-1', null]]);
  assert.deepEqual(kit.A.awayTimers('U'), []);
  kit.clock.advance(MS['5m'] * 3);
  assert.deepEqual(kit.records, [], 'nothing expires while the window has focus');
  const blurAt = kit.clock.now();
  kit.A.setFocus(false);
  assert.deepEqual(kit.A.awayTimers('U').map((timer) => timer.deadline), [blurAt + MS['5m'], blurAt + MS['5m']]);
  kit.clock.advance(MS['5m'] - 1);
  assert.deepEqual(kit.records, [], 'the time before focus came back does not count');
  kit.clock.advance(1);
  assert.equal((await pending).reason, denied('5 minutes'));
  assert.deepEqual(kit.records.map((item) => item.decision.requestId).sort(), ['approval-1', 'ask-1']);
});

test('FS-70 MORI_AWAY_TIMEOUT_MS replaces all three durations, Never still does not time; the texts and the '
  + 'record keep the setting', async (t) => {
  const { kit, dialog } = await userSetup(t, { envMs: '50' });
  kit.A.setFocus(false);
  const at = kit.clock.now();
  const { result } = dialog.call('bash', { command: 'npm publish' });
  await settle();
  assert.equal(eventsOf(kit.log, 'mori.away_timer')[0].event.deadline, at + 50);
  kit.clock.advance(49);
  assert.deepEqual(kit.records, []);
  kit.clock.advance(1);
  assert.deepEqual(await result, { block: true, reason: denied('5 minutes') });
  assert.equal(kit.records[0].decision.timeout, '5m');
  for (const [timeout, duration] of [['10m', '10 minutes'], ['60s', '60 seconds']]) {
    await kit.A.setAway(timeout);
    const next = dialog.call('bash', { command: 'npm publish' }).result;
    await settle();
    kit.clock.advance(49);
    assert.equal(kit.records.length, timeout === '10m' ? 1 : 2, `${timeout}: not before 50 ms`);
    kit.clock.advance(1);
    assert.equal((await next).reason, denied(duration), `${timeout} becomes the test value`);
    assert.equal(kit.records.at(-1).decision.timeout, timeout);
  }
  await kit.A.setAway('never');
  const never = dialog.call('bash', { command: 'npm publish' });
  await settle();
  kit.clock.advance(10_000);
  assert.deepEqual(eventsOf(kit.log, 'mori.away_timer', 'approval-4'), [], 'Never still does not time');
  assert.equal(kit.clock.pending(), 0);
  assert.equal(kit.records.length, 3);
  dialog.gate.answer('approval-4', 'reject');
  assert.equal((await never.result).block, true);
});

test('FS-70 timers are kept per user session: ask-1 in two sessions are two cards', async (t) => {
  const { kit } = await userSetup(t);
  const inU = asksOf(kit, 'U');
  const inV = asksOf(kit, 'V');
  void inU.run([DB_QUESTION]);
  void inV.run([DB_QUESTION]);
  await settle();
  kit.A.setFocus(false);
  assert.deepEqual(timing(kit, 'U'), ['ask-1']);
  assert.deepEqual(timing(kit, 'V'), ['ask-1']);
  inU.asks.answer('ask-1', [{ selected: ['SQLite'], other: null }]);
  assert.deepEqual(timing(kit, 'U'), []);
  assert.deepEqual(timing(kit, 'V'), ['ask-1'], 'ending ask-1 in U leaves ask-1 in V timing');
});

// ---- FS-71 批准卡到时拒绝 ----

/** @brief 一张批准卡在 timeout 档下到时（先改设置，再失焦、出卡、到时），返回 pi 拿到的结果与这次的记录。 */
async function expireApproval(kit, gate, timeout, toolName, input) {
  await kit.A.setAway(timeout);
  kit.A.setFocus(false);
  const call = gate.call(toolName, input);
  await settle();
  const at = kit.clock.now() + MS[timeout];
  kit.clock.advance(MS[timeout]);
  const result = await call.result;
  kit.A.setFocus(true);
  return { result, record: kit.records.at(-1), toolCallId: call.toolCallId, at };
}

test('FS-71 a dialog approval card that expires is denied with by away, the §14 text for the setting and one record',
  async (t) => {
    const { kit, dialog } = await userSetup(t);
    const durations = { '60s': '60 seconds', '5m': '5 minutes', '10m': '10 minutes' };
    let n = 0;
    for (const [timeout, duration] of Object.entries(durations)) {
      n += 1;
      const done = await expireApproval(kit, dialog, timeout, 'bash', { command: 'npm publish' });
      assert.deepEqual(done.result, { block: true, reason: denied(duration) }, timeout);
      const [end] = eventsOf(kit.log, 'mori.approval_end', `approval-${n}`);
      assert.deepEqual(end, { sessionId: 'U', event: { type: 'mori.approval_end', requestId: `approval-${n}`,
        toolCallId: done.toolCallId, decision: 'reject', by: 'away', reason: denied(duration) } });
      assert.equal(kit.records.length, n, 'one record per automatic decision');
      assert.deepEqual(done.record, { userSessionId: 'U', decision: { requestId: `approval-${n}`, kind: 'approval',
        at: done.at, timeout, agent: null, toolCallId: done.toolCallId, toolName: 'bash',
        args: { command: 'npm publish' }, title: null, answers: null, result: 'denied' } });
      kit.K.shared.AwayDecisionSchema.parse(done.record.decision);
    }
  });

test('FS-71 a write card that expires: the record args have no content or edits and no string over 300 characters',
  async (t) => {
    const { kit, dialog } = await userSetup(t);
    const path = `${'docs/'.repeat(70)}notes.md`;
    const done = await expireApproval(kit, dialog, '5m', 'write', { path, content: 'x'.repeat(301) });
    assert.equal(done.result.reason, denied('5 minutes'));
    const { args } = done.record.decision;
    assert.deepEqual(Object.keys(args), ['path']);
    assert.equal(args.path, path.slice(0, 300));
    const edit = await expireApproval(kit, dialog, '5m', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'a',
      newText: 'b' }] });
    assert.deepEqual(edit.record.decision.args, { path: 'src/a.ts' });
    const nested = kit.A.awayArgs({ path: 'a.ts', content: 'c', edits: [], note: 'y'.repeat(400),
      list: ['z'.repeat(301), 2], deep: { text: 'w'.repeat(500), flag: true } });
    assert.deepEqual(nested, { path: 'a.ts', note: 'y'.repeat(300), list: ['z'.repeat(300), 2],
      deep: { text: 'w'.repeat(300), flag: true } });
  });

// ---- FS-72 后台实例的卡到时（away.ts 与批准扩展的部分；Team 写记录见 team-ask.test.mjs） ----

test('FS-72 an instance card that expires: task and close mention the handoff, the other kinds the final summary',
  async (t) => {
    const setup = await userSetup(t);
    const { kit } = setup;
    const cases = [
      ['task', null, 'Mention it in your handoff.'],
      ['task', { owner: 'task', limits: {} }, 'Mention it in your handoff.'],
      ['close', { owner: 'close', limits: { write: false } }, 'Mention it in your handoff.'],
      ['create', null, 'Mention it in your final summary.'],
      ['ask', null, 'Mention it in your final summary.'],
      ['subscription', null, 'Mention it in your final summary.'],
    ];
    for (const [index, [kind, narrowing, end]] of cases.entries()) {
      const gate = instanceGate(setup, kind, { id: `U.${kind}.${index}`, narrowing });
      // 收窄会拒绝写入与命令：用不受收窄的 MCP 工具出卡（没写 mcp: false）
      const done = await expireApproval(kit, gate, '60s', 'mcp__github__create_issue', { title: 'Bug' });
      assert.equal(done.result.reason, denied('60 seconds', end), `${kind} ${JSON.stringify(narrowing)}`);
      const [ended] = eventsOf(kit.log, 'instance_end', `U.${kind}.${index}:approval-1`);
      assert.deepEqual([ended.event.by, ended.event.decision, ended.event.reason],
        ['away', 'reject', done.result.reason]);
      const [timer] = eventsOf(kit.log, 'mori.away_timer', `U.${kind}.${index}:approval-1`);
      assert.equal(timer.sessionId, 'U', 'the background card times on the user session envelope');
    }
    assert.deepEqual(kit.records, [], 'away.ts does not write records for instances: the Team does');
    for (const kind of ['user', 'create', 'ask', 'subscription']) {
      assert.equal(kit.A.awayDenialText('10m', kind), denied('10 minutes'));
    }
    for (const kind of ['task', 'close']) {
      assert.equal(kit.A.awayDenialText('5m', kind), denied('5 minutes', 'Mention it in your handoff.'));
    }
  });

// ---- FS-73 提问卡到时 ----

test('FS-73 an ask card that expires answers each question with its recommended option and records the answers',
  async (t) => {
    const { kit } = await userSetup(t);
    await kit.A.setAway('10m');
    const asks = asksOf(kit, 'U');
    kit.A.setFocus(false);
    const call = asks.run([DB_QUESTION, PARTS_QUESTION]);
    await settle();
    kit.clock.advance(MS['10m']);
    const result = await call.result;
    const answers = [
      { question: 'Which database should I use?', header: 'Database', selected: ['PostgreSQL'], other: null,
        auto: true },
      { question: 'Which parts?', header: 'Scope', selected: ['API'], other: null, auto: true },
    ];
    assert.equal(textOf(result), "The user was away and didn’t answer within 10 minutes, so your recommended options "
      + 'were used: "Which database should I use?"="PostgreSQL", "Which parts?"="API". Continue with them, and '
      + 'mention this in your final summary.');
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.details, { answers, by: 'away' });
    const [end] = eventsOf(kit.log, 'mori.question_end', 'ask-1');
    assert.deepEqual(end.event, { type: 'mori.question_end', requestId: 'ask-1', toolCallId: call.toolCallId,
      by: 'away', answers });
    assert.deepEqual(kit.records, [{ userSessionId: 'U', decision: { requestId: 'ask-1', kind: 'question',
      at: kit.clock.now(), timeout: '10m', agent: null, toolCallId: call.toolCallId, toolName: 'ask_user_question',
      args: null, title: null, answers, result: 'recommended' } }]);
  });

// ---- FS-74 扩展询问到时 ----

test('FS-74 an extension question that expires is cancelled: confirm false, select and input empty, no reminder',
  async (t) => {
    const { kit, dialog } = await userSetup(t);
    const { context } = uiOf(kit, 'U');
    kit.A.setFocus(false);
    const confirm = context.confirm('Delete the cache?', 'It will be rebuilt');
    const select = context.select('Pick a profile', ['dev', 'prod']);
    const input = context.input('Tag name', 'v1.0');
    await settle();
    kit.clock.advance(MS['5m']);
    assert.deepEqual(await Promise.all([confirm, select, input]), [false, undefined, undefined]);
    assert.deepEqual(eventsOf(kit.log, 'mori.ui_end').map((item) => item.event.requestId),
      ['question-1', 'question-2', 'question-3']);
    const titles = ['Delete the cache?', 'Pick a profile', 'Tag name'];
    assert.deepEqual(kit.records, titles.map((title, index) => ({ userSessionId: 'U', decision: {
      requestId: `question-${index + 1}`, kind: 'extension', at: kit.clock.now(), timeout: '5m', agent: null,
      toolCallId: null, toolName: null, args: null, title, answers: null, result: 'cancelled' } })));
    assert.equal(dialog.beforeSettle('completed'), undefined, 'extension questions are not in the reminder');
  });

// ---- FS-75 Never ----

test('FS-75 with Never no timer starts and nothing is decided, however long the window is away', async (t) => {
  const setup = await userSetup(t);
  const { kit, dialog } = setup;
  await kit.A.setAway('never');
  const first = dialog.call('bash', { command: 'npm test' });
  await settle();
  kit.A.setFocus(false);
  void instanceGate(setup).call('bash', { command: 'npm run lint' });
  void asksOf(kit, 'U').run([DB_QUESTION]);
  void uiOf(kit, 'U').context.confirm('Go?', 'Now');
  await settle();
  kit.clock.advance(MS['10m'] * 1000);
  kit.A.setFocus(true);
  assert.deepEqual(eventsOf(kit.log, 'mori.away_timer'), []);
  assert.deepEqual(kit.records, []);
  assert.equal(kit.clock.pending(), 0);
  assert.deepEqual(kit.A.awayTimers('U'), []);
  assert.equal(dialog.gate.has('approval-1'), true, 'the card still waits for an answer');
  dialog.gate.answer('approval-1', 'allow');
  assert.equal(await first.result, undefined);
});

// ---- FS-76 设置 ----

test('FS-76 the default is 5 minutes; away.set writes away.json and a restart reads it back', async (t) => {
  const kit = await awayKit(t);
  assert.deepEqual(kit.A.getAway(), { timeout: '5m', error: null });
  assert.equal(kit.A.awayTimeout(), '5m');
  assert.deepEqual(await kit.A.setAway('10m'), { timeout: '10m', error: null });
  assert.deepEqual(JSON.parse(readFileSync(join(kit.userData, 'away.json'), 'utf8')), { timeout: '10m' });
  assert.equal(kit.A.awayTimeout(), '10m');
  const restarted = await awayKit(t, { userData: kit.userData });
  assert.deepEqual(restarted.A.getAway(), { timeout: '10m', error: null });
  assert.deepEqual(await restarted.A.setAway('never'), { timeout: 'never', error: null });
  const again = await awayKit(t, { userData: kit.userData });
  assert.deepEqual(again.A.getAway(), { timeout: 'never', error: null });
});

/**
 * @brief 坏掉的 away.json 的原文（§9.6“error 带原文”）：JSON 读不出时为 JSON.parse 的错误，值不对时为按 §9.6 的取值
 *        （{ timeout: AwayTimeout }）校验的错误。
 */
function brokenText(K, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return error.message;
  }
  const schema = z.object({ timeout: z.enum(K.shared.AWAY_TIMEOUTS) });
  return schema.safeParse(json).error.issues[0].message;
}

test('FS-76 a broken away.json gives the default with the original error text and an error log', async (t) => {
  for (const text of ['{ "timeout": ', '{ "timeout": "2m" }', '["5m"]']) {
    const userData = tempDir(t, 'mori-away-broken-');
    writeFileSync(join(userData, 'away.json'), text);
    const errors = t.mock.method(console, 'error', () => undefined);
    const kit = await awayKit(t, { userData });
    errors.mock.restore();
    const got = kit.A.getAway();
    assert.equal(got.timeout, '5m', text);
    const original = brokenText(kit.K, text);
    assert.ok(original.length > 0, text);
    assert.ok(got.error.includes(original), `${text}: ${got.error} has ${original}`);
    const lines = errors.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(lines.some((line) => line.startsWith('[kernel] ') && line.includes(got.error)),
      `logged: ${lines.join(' | ')}`);
  }
});

test('FS-76 when away.json cannot be written the value stays and error has the original text', async (t) => {
  const { kit, dialog } = await userSetup(t);
  const temp = join(kit.userData, 'away.json.tmp');
  mkdirSync(temp);
  // 同一个写法自己写一次，得到这个错误的原文（写 away.json 先写它旁边的 .tmp，§9.6 的 writeFileAtomic）
  const original = await writeFile(temp, 'x').then(() => '', (error) => error.message);
  assert.ok(original.includes(temp), original);
  const errors = t.mock.method(console, 'error', () => undefined);
  const result = await kit.A.setAway('60s');
  errors.mock.restore();
  assert.deepEqual(result, { timeout: '5m', error: original });
  const lines = errors.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(lines.some((line) => line.startsWith('[kernel] ') && line.includes(original)),
    `logged: ${lines.join(' | ')}`);
  assert.deepEqual(kit.A.getAway(), { timeout: '5m', error: null }, 'the value is unchanged');
  kit.A.setFocus(false);
  const at = kit.clock.now();
  void dialog.call('bash', { command: 'npm test' });
  await settle();
  assert.equal(kit.A.awayTimers('U')[0].deadline, at + MS['5m'], 'timers keep the old value');
});

// ---- FS-78 提醒 ----

/** @brief 出一张批准卡、失焦到时、再切回（自动拒绝一次）。 */
async function denyOnce(kit, gate, toolName, input) {
  kit.A.setFocus(false);
  const call = gate.call(toolName, input);
  await settle();
  kit.clock.advance(MS['5m']);
  await call.result;
  kit.A.setFocus(true);
}

/** @brief 出一张提问卡、失焦到时（按推荐项回答一次）。 */
async function recommendOnce(kit, asks, questions) {
  kit.A.setFocus(false);
  const call = asks.run(questions);
  await settle();
  kit.clock.advance(MS['5m']);
  await call.result;
  kit.A.setFocus(true);
}

test('FS-78 one reminder per run after automatic decisions: the exact text, display false, continue', async (t) => {
  const { kit, dialog } = await userSetup(t);
  const asks = asksOf(kit, 'U');
  await denyOnce(kit, dialog, 'bash', { command: 'npm publish' });
  await recommendOnce(kit, asks, [DB_QUESTION]);
  const earlier = { type: 'custom_message', customType: 'other.extension', content: 'kept', display: false };
  const boundary = dialog.beforeSettle('completed', [earlier]);
  const content = [REMINDER_HEAD, '- Denied bash: npm publish',
    '- Used your recommended option for "Which database should I use?": PostgreSQL', REMINDER_SUMMARY].join('\n');
  assert.deepEqual(boundary, { continue: true, entries: [earlier, { type: 'custom_message',
    customType: 'mori.away_reminder', display: false, content }] });
  assert.equal(dialog.beforeSettle('completed'), undefined, 'only once in a run');
  await denyOnce(kit, dialog, 'bash', { command: 'npm publish --force' });
  assert.equal(dialog.beforeSettle('completed'), undefined, 'a decision in the extra request is not reminded again');
  kit.A.clearAwayReminder('U');
  assert.equal(dialog.beforeSettle('completed'), undefined, 'agent_settled empties the list');
  await denyOnce(kit, dialog, 'write', { path: 'dist/out.js', content: 'x' });
  assert.equal(dialog.beforeSettle('completed').entries[0].content,
    [REMINDER_HEAD, '- Denied write: dist/out.js', REMINDER_SUMMARY].join('\n'), 'the next run is reminded again');
});

test('FS-78 the reminder list lives until clearAwayReminder: the approval extension has no agent_start or '
  + 'turn_start handler that could empty it', async (t) => {
  const { kit, dialog } = await userSetup(t);
  // 单元层只能查到批准扩展这一边：它只注册这两个处理器，重试（auto_retry）再发的 agent_start、turn_start 都碰不到清单；
  // 会话表只在 agent_settled 清（sessions.ts），重试之后补提醒由 App 层的 FS-78 验
  assert.deepEqual(dialog.events, ['tool_call', 'agent_before_settle']);
  await denyOnce(kit, dialog, 'bash', { command: 'npm publish' });
  await denyOnce(kit, dialog, 'bash', { command: 'git push' });
  const boundary = dialog.beforeSettle('completed');
  assert.equal(boundary.entries[0].content,
    [REMINDER_HEAD, '- Denied bash: npm publish', '- Denied bash: git push', REMINDER_SUMMARY].join('\n'));
});

test('FS-78 no reminder after a stop or an error, for a handed-off instance, or for extension questions only',
  async (t) => {
    const setup = await userSetup(t);
    const { kit, dialog } = setup;
    await denyOnce(kit, dialog, 'bash', { command: 'npm publish' });
    assert.equal(dialog.beforeSettle('aborted'), undefined);
    assert.equal(dialog.beforeSettle('error'), undefined);
    let handedOff = false;
    const executor = instanceGate(setup, 'task', { handedOff: () => handedOff });
    await denyOnce(kit, executor, 'bash', { command: 'rm -rf build' });
    handedOff = true;
    assert.equal(executor.beforeSettle('completed'), undefined, 'a handed-off task instance is not reminded');
    handedOff = false;
    assert.equal(executor.beforeSettle('completed').entries[0].content,
      [REMINDER_HEAD, '- Denied bash: rm -rf build', REMINDER_HANDOFF].join('\n'));
    const other = await userSetup(t);
    const { context } = uiOf(other.kit, 'U');
    other.kit.A.setFocus(false);
    const confirm = context.confirm('Go?', 'Now');
    await settle();
    other.kit.clock.advance(MS['5m']);
    assert.equal(await confirm, false);
    assert.equal(other.kit.records.length, 1, 'the extension question has a record');
    assert.equal(other.dialog.beforeSettle('completed'), undefined, 'but no reminder');
  });

test('FS-78 reminder lines: edit and write paths, the first command line cut to 80 characters, other tools by name',
  async (t) => {
    const setup = await userSetup(t);
    const { kit } = setup;
    const lines = async (kind) => {
      const gate = instanceGate(setup, kind, { id: `U.${kind}.1` });
      await denyOnce(kit, gate, 'edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] });
      // 2026-10-28：echo 是只读命令、不出卡（file-system-permissions.md §6.1），接上 tee 才要批准；前 80 个字符不变
      await denyOnce(kit, gate, 'bash', { command: `echo ${'a'.repeat(90)} | tee\necho second` });
      await denyOnce(kit, gate, 'powershell', { command: 'Remove-Item build -Recurse' });
      await denyOnce(kit, gate, 'mcp__github__create_issue', { title: 'Bug' });
      return gate.beforeSettle('completed').entries[0].content.split('\n');
    };
    const body = ['- Denied edit: src/a.ts', `- Denied bash: echo ${'a'.repeat(75)}…`,
      '- Denied powershell: Remove-Item build -Recurse', '- Denied mcp__github__create_issue'];
    assert.deepEqual(await lines('task'), [REMINDER_HEAD, ...body, REMINDER_HANDOFF]);
    assert.deepEqual(await lines('close'), [REMINDER_HEAD, ...body, REMINDER_HANDOFF]);
    assert.deepEqual(await lines('create'), [REMINDER_HEAD, ...body, REMINDER_SUMMARY]);
    assert.deepEqual(await lines('subscription'), [REMINDER_HEAD, ...body, REMINDER_SUMMARY]);
  });

// ---- FS-81 停止与关闭 ----

/** @brief 对话的批准卡、后台实例的卡、提问卡与扩展询问卡各一张，然后失焦。 */
async function fourCards(setup) {
  const { kit, dialog } = setup;
  const executor = instanceGate(setup);
  const asks = asksOf(kit, 'U');
  const { ui, context } = uiOf(kit, 'U');
  const calls = { dialog: dialog.call('bash', { command: 'npm test' }), executor: executor.call('bash',
    { command: 'npm run build' }), ask: asks.run([DB_QUESTION]), ui: context.confirm('Go?', 'Now') };
  await settle();
  kit.A.setFocus(false);
  return { executor, asks, ui, calls };
}

test('FS-81 Esc on the dialog ends its own cards and their timers; the background card keeps timing', async (t) => {
  const setup = await userSetup(t);
  const { kit, dialog } = setup;
  const { asks, ui, calls } = await fourCards(setup);
  const before = eventsOf(kit.log, 'mori.away_timer').length;
  // Esc：stopRun 只停对话自己（ui.beginStop、asks.beginStop、gate.rejectForStop，file-system-permissions.md §9.5）
  ui.beginStop();
  asks.asks.beginStop();
  await stopGate(dialog, calls.dialog);
  asks.asks.endStop();
  ui.endStop();
  assert.equal((await calls.dialog.result).reason, 'Rejected: the user stopped the run.');
  assert.equal(textOf(await calls.ask.result), 'Not answered: the user stopped the run.');
  assert.equal(await calls.ui, false);
  assert.deepEqual(timing(kit), ['U.task.1:approval-1']);
  assert.equal(eventsOf(kit.log, 'mori.away_timer').length, before, 'an ended request sends no mori.away_timer');
  kit.clock.advance(MS['5m']);
  assert.equal((await calls.executor.result).reason, denied('5 minutes', 'Mention it in your handoff.'));
  assert.deepEqual(kit.records, [], 'only the background card expired, and the Team records it');
});

/** @brief 停下一个批准扩展（rejectForStop，pi 记下这次调用的结束），之后解除停止状态。 */
async function stopGate(gate, call) {
  const stopping = gate.gate.rejectForStop();
  gate.gate.noteToolEnd(call.toolCallId);
  await stopping;
  gate.gate.endStop();
}

test('FS-81 Stop team clears every timer, the background cards too', async (t) => {
  const setup = await userSetup(t);
  const { kit, dialog } = setup;
  const { executor, asks, ui, calls } = await fourCards(setup);
  assert.equal(timing(kit).length, 4);
  // Stop team：用户会话与每个实例都被停止（平行 Agent 规格 §11.4）
  ui.beginStop();
  asks.asks.beginStop();
  await stopGate(dialog, calls.dialog);
  await stopGate(executor, calls.executor);
  asks.asks.endStop();
  ui.endStop();
  assert.deepEqual(kit.A.awayTimers('U'), []);
  assert.equal(kit.clock.pending(), 0);
  kit.clock.advance(MS['5m'] * 2);
  assert.deepEqual(kit.records, []);
  assert.equal((await calls.executor.result).reason, 'Rejected: the user stopped the run.');
  assert.equal(textOf(await calls.ask.result), 'Not answered: the user stopped the run.');
});

test('FS-81 closing the session clears every timer', async (t) => {
  const setup = await userSetup(t);
  const { kit, dialog } = setup;
  const { executor, asks, ui, calls } = await fourCards(setup);
  executor.gate.close();
  dialog.gate.close();
  asks.asks.close();
  ui.close();
  assert.deepEqual(kit.A.awayTimers('U'), []);
  assert.equal(kit.clock.pending(), 0);
  kit.clock.advance(MS['5m'] * 2);
  assert.deepEqual(kit.records, []);
  assert.equal((await calls.dialog.result).reason, 'Rejected: the user stopped the run.');
  assert.equal((await calls.ask.result).details.by, 'closed');
  assert.equal(await calls.ui, false);
});

test('FS-81 Allow for this session, Full access and allowing a folder end cards as allowed and clear their timers',
  async (t) => {
    const setup = await userSetup(t);
    const { kit, dialog, policy } = setup;
    const executor = instanceGate(setup);
    const outside = tempDir(t, 'mori-away-outside-');
    const bash = dialog.call('bash', { command: 'npm test' });
    const other = executor.call('bash', { command: 'npm run lint' });
    const write = dialog.call('write', { path: 'a.md', content: 'x' });
    const far = dialog.call('write', { path: join(outside, 'notes.md'), content: 'x' });
    await settle();
    kit.A.setFocus(false);
    assert.equal(timing(kit).length, 4);
    dialog.gate.answer('approval-1', 'allowSession');
    assert.deepEqual(await Promise.all([bash.result, other.result]), [undefined, undefined]);
    assert.deepEqual(timing(kit), ['approval-2', 'approval-3']);
    policy.setMode('full');
    assert.equal(await write.result, undefined);
    assert.deepEqual(timing(kit), ['approval-3'], 'Full access leaves the outside card timing');
    dialog.gate.answer('approval-3', 'allowDir');
    assert.equal(await far.result, undefined);
    assert.deepEqual(kit.A.awayTimers('U'), []);
    kit.clock.advance(MS['5m']);
    assert.deepEqual(kit.records, []);
    assert.deepEqual(eventsOf(kit.log, 'instance_end').map((item) => item.event.by), ['session']);
    assert.deepEqual(eventsOf(kit.log, 'mori.approval_end').map((item) => item.event.by), ['user', 'full', 'user']);
  });

test('FS-81 an answer and the timeout: whichever comes first wins, the other gets no longer pending', async (t) => {
  const { kit, dialog } = await userSetup(t);
  const asks = asksOf(kit, 'U');
  const { ui, context } = uiOf(kit, 'U');
  kit.A.setFocus(false);
  void dialog.call('bash', { command: 'npm test' });
  void asks.run([DB_QUESTION]);
  void context.confirm('Go?', 'Now');
  await settle();
  kit.clock.advance(MS['5m']);
  assert.equal(kit.records.length, 3);
  assert.throws(() => dialog.gate.answer('approval-1', 'allow'),
    { message: 'Approval request approval-1 is no longer pending' });
  assert.throws(() => asks.asks.answer('ask-1', [{ selected: ['SQLite'], other: null }]),
    { message: 'Question ask-1 is no longer pending' });
  assert.throws(() => ui.answer('question-1', true), { message: 'Extension question question-1 is no longer pending' });
  // 回答先到：三种卡各一张，窗口仍不在前台（新卡立即计时），回答之后再到时
  const second = dialog.call('bash', { command: 'npm test' });
  const ask = asks.run([DB_QUESTION]);
  const question = context.confirm('Go again?', 'Now');
  await settle();
  assert.deepEqual(timing(kit), ['approval-2', 'ask-2', 'question-2']);
  dialog.gate.answer('approval-2', 'allow');
  asks.asks.answer('ask-2', [{ selected: ['SQLite'], other: null }]);
  ui.answer('question-2', true);
  assert.equal(await second.result, undefined);
  assert.equal((await ask.result).details.by, 'user');
  assert.equal(await question, true);
  assert.equal(kit.clock.pending(), 0, 'each answer cleared its timer');
  kit.clock.advance(MS['5m']);
  assert.equal(kit.records.length, 3, 'the answers came first: no automatic decision');
  assert.deepEqual(eventsOf(kit.log, 'mori.approval_end', 'approval-2').map((item) => item.event.by), ['user']);
  assert.deepEqual(eventsOf(kit.log, 'mori.question_end', 'ask-2').map((item) => item.event.by), ['user']);
  assert.equal(eventsOf(kit.log, 'mori.ui_end', 'question-2').length, 1);
});

test('FS-81 every other way a request ends unregisters it: signal, the extension timeout, declining, a closed ask',
  async (t) => {
    const { kit, dialog } = await userSetup(t);
    const asks = asksOf(kit, 'U');
    const { context } = uiOf(kit, 'U');
    kit.A.setFocus(false);
    const controller = new AbortController();
    const aborted = dialog.call('bash', { command: 'npm test' }, controller.signal);
    const askController = new AbortController();
    const askAborted = asks.run([DB_QUESTION], askController.signal);
    const declined = asks.run([PARTS_QUESTION]);
    const timedOut = context.confirm('Go?', 'Now', { timeout: 5 });
    await settle();
    assert.equal(timing(kit).length, 4);
    controller.abort();
    askController.abort();
    asks.asks.answer('ask-2', null);
    assert.equal(await timedOut, false);
    assert.equal((await aborted.result).reason, 'Rejected: the user stopped the run.');
    assert.equal((await askAborted.result).details.by, 'closed');
    assert.equal((await declined.result).details.by, 'declined');
    assert.deepEqual(kit.A.awayTimers('U'), []);
    assert.equal(kit.clock.pending(), 0);
    kit.clock.advance(MS['5m']);
    assert.deepEqual(kit.records, []);
  });

test('FS-81 an extension question you answer or whose signal aborts while it is timing is unregistered',
  async (t) => {
    const { kit } = await userSetup(t);
    const { ui, context } = uiOf(kit, 'U');
    kit.A.setFocus(false);
    const answered = context.confirm('Apply the patch?', 'It changes 3 files');
    const controller = new AbortController();
    const aborted = context.input('Branch name', 'main', { signal: controller.signal });
    await settle();
    assert.deepEqual(timing(kit), ['question-1', 'question-2']);
    ui.answer('question-1', true);
    assert.equal(await answered, true);
    assert.deepEqual(timing(kit), ['question-2'], 'your answer clears its timer');
    assert.equal(kit.clock.pending(), 1);
    controller.abort();
    assert.equal(await aborted, undefined);
    assert.deepEqual(kit.A.awayTimers('U'), [], 'the aborted signal clears its timer');
    assert.equal(kit.clock.pending(), 0);
    kit.clock.advance(MS['5m']);
    assert.deepEqual(kit.records, []);
    assert.deepEqual(eventsOf(kit.log, 'mori.ui_end').map((item) => item.event.requestId),
      ['question-1', 'question-2']);
  });
