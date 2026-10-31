// 收尾检查与模型层的单元测试（docs/specs/finish-check.md §9.2、§9.3、§9.5；FC-21、FC-22 的窗口部分、FC-29）：
// modelContext.ts 的 followsToolFreeReply、隐藏区间里的检查那一行一起隐藏、带 afterReply 的条目不改重做说明、接手判断；
// modelSession.ts 的 switchFrom 在跟在没有工具调用的回复之后的请求上不隐藏（kind: 'task' 也不重来），
// 检查那次请求换模型时窗口判断经 extraContextTokens 算上检查块，段内正在用的模型只经 checkCurrent。
// 消息按 pi 的两种形状构造：AgentMessage（检查那一行是 custom 消息，会话投影里没有检查块；路由、context 钩子）与
// pi-ai Message（pi 把它转成 user 消息，context 钩子已接上检查块；流函数包装）。消息都是手写的（synthetic）；
// 模型层、模型池的 fetch、pi 会话与 pi 的流函数都是替身（synthetic，同 tests/unit/taskboard/model.test.mjs 的 TB-39）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const context = await loadKernelModule('src/kernel/modelContext.ts');
const { ModelSession } = await loadKernelModule('src/kernel/modelSession.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');
const selector = await loadKernelModule('src/kernel/selector.ts');
const finish = await loadKernelModule('src/kernel/finishCheck.ts');
const shared = await loadKernelModule('src/shared/finishCheck.ts');

// ---- 消息（synthetic） ----

/** 模型 A、B 的身份（两种消息形状的助手消息都带）。 */
const A = { provider: 'a', api: 'openai-completions', model: 'm1' };
const B = { provider: 'b', api: 'openai-completions', model: 'm1' };

/** 一个 text 块。 */
const text = (body) => ({ type: 'text', text: body });

/** 一个工具调用块。 */
const call = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });

/** 一条助手消息（who 为 A 或 B）。 */
function assistant(who, content, timestamp, extra = {}) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const calls = content.some((block) => block.type === 'toolCall');
  return { role: 'assistant', content, ...who, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0, cost: zero }, stopReason: calls ? 'toolUse' : 'stop', timestamp, ...extra };
}

/** 一条用户消息（字符串内容，两种形状相同）。 */
const user = (body, timestamp) => ({ role: 'user', content: body, timestamp });

/** 一条工具结果。 */
const result = (id, name, timestamp, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: name,
  content: [text(name === 'finish' ? finish.FINISH_RESULT : 'ok')], isError, timestamp });

/** 检查那一行的原文与这次运行的检查块（taste、review 两段都有）。 */
const LINE = finish.checkLine(['taste', 'review']);
const BLOCK = finish.checkBlock({ taste: '- Lead with the answer.', review: '- Run the tests before you say done.' });

/** 检查那一行，AgentMessage 形状：custom 消息，会话投影里没有检查块。 */
const checkCustom = (timestamp) => ({ role: 'custom', customType: shared.FINISH_CHECK_TYPE, content: LINE,
  display: false, timestamp });

/** 检查那一行，pi-ai 形状：pi 把 custom 转成 user，context 钩子已接上检查块。 */
const checkUser = (timestamp) => ({ role: 'user', content: [text(`${LINE}\n\n${BLOCK}`)], timestamp });

/** 两种形状的检查那一行。 */
const SHAPES = [['AgentMessage', checkCustom], ['pi-ai Message', checkUser]];

/** 工作卡（pi-ai 形状）。 */
const card = (timestamp) => ({ role: 'user', content: [text(`${context.WORK_CARD_OPEN}\nYou are the dialog agent.\n`
  + `${context.WORK_CARD_CLOSE}`)], timestamp });

/** 换模型条目（默认来自 A：a/m1，API key 被拒绝）。 */
function entry(replyStartedAt, anchorAt, hideUntil, over = {}) {
  return { from: 'a/m1', to: 'b/m1', reason: 'auth', detail: 'API key rejected', unconfirmed: false, replyStartedAt,
    anchorAt, hideUntil, ...over };
}

/** A 的重做说明（原因的界面文字为 API key rejected，同 tests/unit/modelContext.test.mjs 的 MP-15）。 */
const NOTE_A = context.redoNote('a/m1', 'API key rejected');

// ---- FC-21 followsToolFreeReply ----

test('FC-21 followsToolFreeReply: true after a text reply, a reply with its own finish, a finish after work',
  () => {
    for (const [shape, check] of SHAPES) {
      const textReply = [user('fix it', 1), assistant(A, [text('Done.')], 2), check(3)];
      assert.equal(context.followsToolFreeReply(textReply), true, `${shape}: text reply, check line`);
      const ownFinish = [user('fix it', 1), assistant(A, [text('Done.'), call('f1', 'finish')], 2),
        result('f1', 'finish', 3), check(4)];
      assert.equal(context.followsToolFreeReply(ownFinish), true, `${shape}: reply with finish, its result, check`);
      const afterWork = [user('fix it', 1), assistant(A, [text('I will run the tests.')], 2), check(3),
        assistant(A, [call('c1', 'bash', { command: 'npm test' })], 4), result('c1', 'bash', 5),
        assistant(A, [text('The tests passed.')], 6), check(7), assistant(A, [call('f2', 'finish')], 8)];
      assert.equal(context.followsToolFreeReply(afterWork), true, `${shape}: worked before, finish-only last`);
      assert.equal(context.followsToolFreeReply([...afterWork, result('f2', 'finish', 9)]), true,
        `${shape}: finish-only last with its result`);
      const failedFinish = [...textReply, assistant(A, [call('f3', 'finish', { reply: 'Done.' })], 4),
        result('f3', 'finish', 5, true)];
      assert.equal(context.followsToolFreeReply(failedFinish), true, `${shape}: a failed finish is not work`);
    }
    const carded = [user('fix it', 1), assistant(A, [text('Done.')], 2), checkUser(3), card(4)];
    assert.equal(context.followsToolFreeReply(carded), true, 'a work card after the check line changes nothing');
  });

test('FC-21 followsToolFreeReply: false when a tool result other than finish follows, or with no reply', () => {
  for (const [shape, check] of SHAPES) {
    const worked = [user('fix it', 1), assistant(A, [text('Done.')], 2), check(3),
      assistant(A, [call('c1', 'bash', { command: 'echo fc-b' })], 4), result('c1', 'bash', 5)];
    assert.equal(context.followsToolFreeReply(worked), false, `${shape}: after a bash result`);
    const mixed = [user('fix it', 1), assistant(A, [text('Done.')], 2), check(3),
      assistant(A, [call('f1', 'finish'), call('c1', 'bash', { command: 'ls' })], 4), result('f1', 'finish', 5),
      result('c1', 'bash', 6)];
    assert.equal(context.followsToolFreeReply(mixed), false, `${shape}: finish in one batch with bash`);
    assert.equal(context.followsToolFreeReply(worked.slice(0, 4)), false, `${shape}: the bash call has no result yet`);
  }
  // synthetic：最后一条助手消息没有工具调用，之后却有别的工具结果（只为测第二个条件）
  const orphan = [user('fix it', 1), assistant(A, [text('Done.')], 2), result('c9', 'read', 3)];
  assert.equal(context.followsToolFreeReply(orphan), false, 'a tool result other than finish after it');
  assert.equal(context.followsToolFreeReply([user('fix it', 1)]), false, 'no assistant message');
  assert.equal(context.followsToolFreeReply([]), false, 'empty context');
});

// ---- FC-21 重做说明与隐藏区间（纯函数） ----

test('FC-21 an earlier hiding entry from A and an afterReply entry from B: A hidden, B kept, one note from A',
  () => {
    for (const [shape, check] of SHAPES) {
      const messages = [user('u201', 201), assistant(A, [call('c1', 'edit', { path: 'a.txt' })], 210),
        result('c1', 'edit', 220), assistant(B, [text('Done.')], 300), check(310)];
      const e1 = entry(200, 201, 220);
      const e2 = entry(200, 201, 200, { from: 'b/m1', to: 'a/m2', reason: 'rate_limited', detail: 'rate limited',
        afterReply: true });
      const out = context.applySwitchEntries(messages, [e1, e2]);
      assert.deepEqual(out, [user(`u201\n\n${NOTE_A}`, 201), messages[3], messages[4]], shape);
      const notes = out.filter((m) => JSON.stringify(m.content).includes('[Mori] The previous model ('));
      assert.equal(notes.length, 1, `${shape}: one redo note`);
      assert.deepEqual(context.applySwitchEntries(out, [e1, e2]), out, `${shape}: processing twice gives the same`);
    }
  });

test('FC-21 an afterReply entry alone hides nothing and adds no note', () => {
  for (const [shape, check] of SHAPES) {
    const messages = [user('u201', 201), assistant(A, [text('Done.')], 210), check(220)];
    const out = context.applySwitchEntries(messages, [entry(200, 201, 200, { afterReply: true })]);
    assert.deepEqual(out, messages, shape);
  }
});

test('FC-21 applySwitchEntries hides the check line inside a hidden range and puts the note on the anchor', () => {
  for (const [shape, check] of SHAPES) {
    const process = [user('u201', 201), assistant(A, [text('I will run the tests.')], 210), check(215),
      assistant(A, [call('c1', 'bash', { command: 'echo fc-b' })], 220), result('c1', 'bash', 225)];
    const out = context.applySwitchEntries(process, [entry(200, 201, 225)]);
    assert.deepEqual(out, [user(`u201\n\n${NOTE_A}`, 201)], `${shape}: only the anchor with the note is left`);
    const stale = check(150);
    const after = [stale, ...process, assistant(B, [text('The tests passed.')], 400), check(410)];
    const kept = context.applySwitchEntries(after, [entry(200, 201, 225)]);
    assert.deepEqual(kept, [stale, user(`u201\n\n${NOTE_A}`, 201), after[6], after[7]],
      `${shape}: check lines outside the range stay`);
  }
});

test('FC-21 other custom messages and a quoted check line are not taken for a check line', () => {
  const reminder = { role: 'custom', customType: 'mori.away_reminder', content: 'reminder', display: false,
    timestamp: 212 };
  const quoted = user(`Why did you get "${shared.CHECK_LINE_HEAD}"?`, 213);
  const messages = [user('u201', 201), assistant(A, [text('Done.')], 210), reminder, quoted,
    assistant(A, [call('c1', 'read', { path: 'a.txt' })], 220), result('c1', 'read', 225)];
  const out = context.applySwitchEntries(messages, [entry(200, 201, 225)]);
  assert.deepEqual(out, [user('u201', 201), reminder, user(`${quoted.content}\n\n${NOTE_A}`, 213)]);
});

test('FC-21 compaction drops a check line inside a hidden range with the hidden process', () => {
  const summarize = [user('u201', 201), assistant(A, [text('I will run the tests.')], 210), checkCustom(215),
    assistant(A, [call('c1', 'bash', { command: 'echo fc-b' })], 220), result('c1', 'bash', 225)];
  const prep = { messagesToSummarize: summarize, turnPrefixMessages: [],
    fileOps: { read: new Set(), written: new Set(), edited: new Set() } };
  context.stripForCompaction(prep, [entry(200, 201, 225)]);
  assert.deepEqual(summarize.map((m) => [m.role, m.timestamp]), [['user', 201]]);
});

// ---- 替身：模型层与 pi 会话（synthetic） ----

/**
 * 两个提供商、一个分组的配置（synthetic）：a/m1、a/m2、b/m1，最大输出都是 100；窗口按参数。
 * @param windows 各模型的窗口（token），省略时 100 000
 */
function pickConfig(windows = {}) {
  const model = (id, ref) => ({ id, family: '', contextWindow: windows[ref] ?? 100_000, maxTokens: 100,
    reasoning: false, input: ['text'] });
  const provider = (id, ids) => ({ id, name: id.toUpperCase(), api: 'openai-completions',
    baseUrl: `http://127.0.0.1:9000/${id}`, compat: {}, concurrency: 4, keys: [], nextKeyNumber: 1,
    models: ids.map((modelId) => model(modelId, `${id}/${modelId}`)) });
  return { version: 1, providers: [provider('a', ['m1', 'm2']), provider('b', ['m1'])],
    groups: [{ id: 'all', members: ['a', 'b'] }], normalDefault: 'all' };
}

/** pi 的实际模型（synthetic）。 */
function physical(providerId, modelId) {
  return { provider: providerId, id: modelId, name: modelId, api: 'openai-completions', reasoning: false,
    input: ['text'], contextWindow: 100_000, maxTokens: 100 };
}

/**
 * 模型层的替身（synthetic）：按 config 回答第 1–4 步，档案为空（窗口取配置的 contextWindow）；avail、status 可以在
 * 测试里改。模型池只建 fetch：发出时按 status[ref]（默认 200）记一次尝试并回答。
 */
function fakeLayer(config) {
  const state = { avail: {}, status: {} };
  const lookup = (ref) => {
    const [providerId, modelId] = ref.split('/');
    const provider = config.providers.find((item) => item.id === providerId);
    const model = provider?.models.find((item) => item.id === modelId);
    return provider && model ? { provider, model } : null;
  };
  const capabilities = (ref) => ({ tier: 'A', protocolWrite: 'verified', structuredOutput: 'verified',
    vision: 'unverified', effectiveWindow: lookup(ref)?.model.contextWindow ?? 0, probing: false });
  const familyOf = (ref) => selector.familyKey(lookup(ref)?.model.family ?? '', ref);
  const pool = {
    createFetch(options) {
      return async () => {
        const status = state.status[options.ref] ?? 200;
        options.onSent?.();
        options.onRecord?.({ ref: options.ref, keyRef: null, cls: status === 429 ? 'rate_limited' : 'ok', status,
          retryAfterMs: null, hadOutput: false, sentAt: Date.now() });
        return new Response('{}', { status });
      };
    },
    markModel() {}, markProvider() {}, clearModelRecord() {},
  };
  const runtime = { registerVirtualModel() {}, async refresh() {}, unregisterVirtualModel() {},
    getModel: (p, id) => physical(p, id), getPhysicalModel: (p, id) => (lookup(`${p}/${id}`) ? physical(p, id)
      : undefined) };
  const layer = {
    timings: { ...MODEL_TIMINGS, exhaustionMaxWaitMs: 0 },
    onModelsChanged: () => () => {}, registerProject() {}, getConfig: () => config,
    projectContext: async () => ({ path: 'd:/p', project: null, projectError: null }),
    expandPicksIn: (_project, picks) => selector.expandPicks(config, picks),
    staticBase: () => ({ configError: null, projectError: null, exists: (ref) => !!lookup(ref),
      toolCalling: () => 'verified', capabilities, familyOf }),
    exists: (ref) => !!lookup(ref), toolCallingOf: () => 'verified',
    availabilityOf: (ref) => state.avail[ref] ?? { available: true }, capabilitiesOf: capabilities, familyOf,
    lookupModel: lookup, profileOf: () => null, getPool: () => pool, async checkVersions() {},
    getRuntime: () => runtime,
    // 2026-10-31（模型层规格 §7.8）：按模型学的首个内容时限；替身没有记录，会话用下限（timings），不记
    firstTokenLimitOf(_ref, use) { return use === 'probe' ? this.timings.firstTokenCeilingMs
      : this.timings.firstContentTimeoutMs; },
    recordFirstToken() {}, recordFirstTokenTimeout() {},
  };
  return { layer, state };
}

/** pi 会话的替身：自定义条目写进内存里的分支。 */
function fakeManager() {
  const entries = [];
  return {
    entries,
    getBranch: () => entries,
    appendCustomEntry(customType, data) {
      entries.push({ type: 'custom', customType, data, id: `e${entries.length + 1}` });
      return `e${entries.length}`;
    },
    buildSessionContext: () => ({ messages: [] }),
  };
}

/** pi 的流函数替身：记下每次调用；经 options.fetch 发出，HTTP 错误时推 error，否则回一段正文。 */
function fakeStream(calls) {
  return (model, transcript, options) => {
    calls.push({ ref: `${model.provider}/${model.id}`, context: transcript });
    return (async function* stream() {
      const response = await options.fetch('http://127.0.0.1:9000/chat', { method: 'POST', body: '{}' });
      const who = { provider: model.provider, api: model.api, model: model.id };
      if (response.status >= 400) {
        yield { type: 'error', reason: 'error', error: assistant(who, [], Date.now(),
          { stopReason: 'error', errorMessage: `${response.status} status code` }) };
        return;
      }
      const message = assistant(who, [call('f1', 'finish')], Date.now());
      yield { type: 'start', partial: message };
      yield { type: 'toolcall_start', contentIndex: 0, partial: message };
      yield { type: 'done', reason: 'toolUse', message };
    })();
  };
}

/** 建一个接好替身的 ModelSession，并开始一段（prepare）；范围为 normalDefault（all），先选 a/m1。 */
async function startedSession(layer, options = {}) {
  const events = [];
  const calls = [];
  const model = await ModelSession.create({ layer, sessionId: 's1', cwd: 'D:\\p', emit: (event) => events.push(event),
    ...options });
  const manager = fakeManager();
  await model.loadPick(manager, true);
  const piSession = { sessionManager: manager, messages: [], thinkingLevel: 'off', settingsManager: {
    applyOverrides() {} }, agent: { streamFunction: fakeStream(calls) }, abortCompaction() {},
  async compact() { throw new Error('Nothing to compact'); } };
  model.attach(piSession);
  const signal = new AbortController().signal;
  assert.deepEqual(await model.prepare('fix it', signal), { kind: 'ok' });
  assert.equal(model.state().current, 'a/m1', 'synthetic setup check: the first candidate is used first');
  return { model, manager, piSession, events, calls, signal };
}

/** 会话里一种自定义条目的数据。 */
const entriesOf = (manager, type) => manager.entries.filter((item) => item.customType === type)
  .map((item) => item.data);

/** A（a/m1）在这一段里的文字回复与检查那一行（AgentMessage 形状，路由时的会话投影），时间戳在 base 之后。 */
function checkRequest(base) {
  return [user('fix it', base + 1), assistant(A, [text('Done.')], base + 5), checkCustom(base + 6)];
}

/** 在路由时换模型（a/m1 不可用，§5.6）：返回选到的模型。 */
async function routeAway(session, state, messages) {
  state.avail['a/m1'] = { available: false, reason: 'rate_limited', until: null };
  const route = await session.model.route({ reason: 'continuation', messages, thinkingLevel: 'off',
    signal: session.signal });
  return `${route.model.provider}/${route.model.id}`;
}

// ---- FC-21 switchFrom 的条目 ----

test('FC-21 switchFrom on the check request: hideUntil equals replyStartedAt, afterReply is set, nothing hidden',
  async () => {
    const { layer, state } = fakeLayer(pickConfig());
    const session = await startedSession(layer);
    const base = Date.now();
    assert.equal(await routeAway(session, state, checkRequest(base)), 'a/m2');
    const [switched] = entriesOf(session.manager, 'mori.model_switch');
    assert.equal(switched.afterReply, true);
    assert.equal(switched.hideUntil, switched.replyStartedAt);
    assert.ok(switched.replyStartedAt <= base, 'the segment started before the reply');
    const event = session.events.find((item) => item.type === 'mori.model_switch');
    assert.equal(event.hidden, false);
    const processed = session.model.processMessages([...checkRequest(base)]);
    assert.deepEqual(processed, checkRequest(base), 'the reply and the check line reach the new model, no note');
  });

test('FC-21 switchFrom after a tool result: hideUntil is the latest tool result, no afterReply (unchanged)',
  async () => {
    const { layer, state } = fakeLayer(pickConfig());
    const session = await startedSession(layer);
    const base = Date.now();
    const messages = [user('fix it', base + 1), assistant(A, [text('Done.')], base + 2), checkCustom(base + 3),
      assistant(A, [call('c1', 'bash', { command: 'echo fc-b' })], base + 5), result('c1', 'bash', base + 6)];
    assert.equal(await routeAway(session, state, messages), 'a/m2');
    const [switched] = entriesOf(session.manager, 'mori.model_switch');
    assert.equal(switched.hideUntil, base + 6);
    assert.equal(Object.hasOwn(switched, 'afterReply'), false);
    assert.equal(session.events.find((item) => item.type === 'mori.model_switch').hidden, true);
    const processed = session.model.processMessages(messages);
    assert.deepEqual(processed.map((m) => m.role), ['user'], 'the reply, the check line and the work are hidden');
    assert.ok(processed[0].content.endsWith('check before you redo anything.'), 'the note is on the anchor');
  });

test('FC-21 switch in the stream wrapper on the check request: the resend keeps the reply and the check block',
  async () => {
    const { layer, state } = fakeLayer(pickConfig());
    const session = await startedSession(layer);
    state.status['a/m1'] = 429;
    const base = Date.now();
    const sent = [user('fix it', base + 1), assistant(A, [text('Done.')], base + 5), checkUser(base + 6),
      card(base + 7)];
    const out = session.piSession.agent.streamFunction(physical('a', 'm1'), { systemPrompt: '', messages: sent },
      { sessionId: 's1', signal: session.signal });
    const message = await out.result();
    assert.equal(message.stopReason, 'toolUse', 'the resend answers');
    assert.deepEqual(session.calls.map((item) => item.ref), ['a/m1', 'a/m2']);
    assert.deepEqual(session.calls[1].context.messages, sent, 'reply, check line with its block, card last; no note');
    const [switched] = entriesOf(session.manager, 'mori.model_switch');
    assert.equal(switched.afterReply, true);
    assert.equal(switched.hideUntil, switched.replyStartedAt);
    assert.equal(session.events.find((item) => item.type === 'mori.model_switch').hidden, false);
  });

test('FC-21 a second switch after a hiding one ignores a reply from an earlier run: the note names the last model',
  async () => {
    const { layer, state } = fakeLayer(pickConfig());
    const session = await startedSession(layer);
    const base = Date.now();
    // synthetic：更早一次运行的文字回复（早于这一段），这一段里 A 改了文件；路由时换到 a/m2，包装里 a/m2 再被限流
    const raw = [user('hello', base - 1000), assistant(A, [text('Hi.')], base - 900), user('fix it', base + 1),
      assistant(A, [call('c1', 'edit', { path: 'a.txt' })], base + 2), result('c1', 'edit', base + 3)];
    assert.equal(await routeAway(session, state, raw), 'a/m2');
    state.status['a/m2'] = 429;
    const processed = session.model.processMessages(raw);
    const out = session.piSession.agent.streamFunction(physical('a', 'm2'), { systemPrompt: '', messages: processed },
      { sessionId: 's1', signal: session.signal });
    await out.result();
    const [first, second] = entriesOf(session.manager, 'mori.model_switch');
    assert.ok(first.hideUntil > first.replyStartedAt, 'the first switch hides A’s edit');
    assert.equal(second.from, 'a/m2');
    assert.equal(Object.hasOwn(second, 'afterReply'), false, 'the earlier run’s reply is not this segment’s reply');
    const anchor = session.calls.at(-1).context.messages.find((m) => m.role === 'user' && m.timestamp === base + 1);
    assert.ok(JSON.stringify(anchor.content).includes('The previous model (a/m2)'), 'the note names a/m2');
  });

/** 一个 task 实例的 ModelSession（executor，候选 all）。 */
function taskSession(layer) {
  return startedSession(layer, { kind: 'task', schedClass: 'task',
    source: { kind: 'role', role: 'executor', models: ['all'], requires: [{ kind: 'tool_calling' }] },
    restartText: (restart) => `[Mori] The model changed (${restart.from} → ${restart.to}). Continue T1.` });
}

test('FC-21 a task session does not restart on a request after a tool-free reply; after a tool result it does',
  async () => {
    const { layer, state } = fakeLayer(pickConfig());
    const session = await taskSession(layer);
    const base = Date.now();
    const steer = [user('[Mori] Start work.', base + 1), assistant(A, [text('Plan: read a.ts first.')], base + 5),
      user('Go ahead.', base + 6)];
    assert.equal(await routeAway(session, state, steer), 'a/m2', 'switched like a normal session');
    assert.equal(session.model.takeRestart(), null);
    assert.equal(entriesOf(session.manager, 'mori.task_restart').length, 0);
    assert.equal(entriesOf(session.manager, 'mori.model_switch')[0].afterReply, true);
    const other = fakeLayer(pickConfig());
    const restarted = await taskSession(other.layer);
    const at = Date.now();
    const process = [user('[Mori] Start work.', at + 1), assistant(A, [text('Plan: read a.ts first.')], at + 2),
      user('Go ahead.', at + 3), assistant(A, [call('c1', 'read', { path: 'a.ts' })], at + 5),
      result('c1', 'read', at + 6)];
    await assert.rejects(routeAway(restarted, other.state, process), { message: 'MODEL_RESTART' });
    assert.deepEqual(restarted.model.takeRestart(), { from: 'a/m1', to: 'a/m2', reason: 'rate_limited',
      detail: 'rate limited' });
    assert.equal(entriesOf(restarted.manager, 'mori.task_restart').length, 1);
  });

// ---- FC-22 窗口估算加检查块（模型层的窗口判断部分） ----

/**
 * 检查那次请求在路由时换模型，候选的窗口按 extraContextTokens（工作卡 + 还没接上的检查块）判断。
 * @param windows 各模型的窗口
 * @param pendingTokens 检查块的估算（FinishCheckLink.pendingTokens，sessions.ts 把它加进 extraContextTokens）
 * @param onUnavailable 候选耗尽时的回调
 */
async function switchOnCheck(windows, pendingTokens, onUnavailable) {
  const { layer, state } = fakeLayer(pickConfig(windows));
  const link = { pendingTokens: 0 };
  const session = await startedSession(layer, { extraContextTokens: () => 20 + link.pendingTokens, onUnavailable });
  link.pendingTokens = pendingTokens;
  const base = Date.now();
  state.avail['a/m1'] = { available: false, reason: 'rate_limited', until: null };
  return session.model.route({ reason: 'continuation', messages: checkRequest(base), thinkingLevel: 'off',
    signal: session.signal }).then((route) => `${route.model.provider}/${route.model.id}`);
}

test('FC-22 switching on the check request: a window that cannot hold context + check block + output is excluded',
  async (t) => {
    const original = console.error;
    console.error = () => {};
    t.after(() => { console.error = original; });
    assert.equal(await switchOnCheck({ 'a/m2': 1000 }, 0, () => {}), 'a/m2', 'without the block a/m2 holds it');
    assert.equal(await switchOnCheck({ 'a/m2': 1000 }, 900, () => {}), 'b/m1',
      'with the block a/m2 cannot hold context + block + 100');
    const unavailable = [];
    await assert.rejects(switchOnCheck({ 'a/m2': 1000, 'b/m1': 1000 }, 900, (info) => unavailable.push(info)),
      /No model available/);
    assert.deepEqual(unavailable[0].candidates.map((item) => [item.ref, item.reason]), [
      ['a/m1', 'rate_limited'], ['a/m2', 'no_handover'], ['b/m1', 'no_handover']]);
  });

test('FC-22 a segment chosen on the check request (selectSegment, step 6) also counts the check block', async () => {
  const chosen = [];
  for (const pendingTokens of [0, 900]) {
    const { layer } = fakeLayer(pickConfig({ 'a/m1': 1000 }));
    const link = { pendingTokens: 0 };
    const session = await startedSession(layer, { extraContextTokens: () => link.pendingTokens });
    // synthetic：结束这一段，让下一次路由从选择器第 1 步起选（selectSegment），回复来自 B（b/m1），a/m1 要接手判断
    session.model.endReply();
    link.pendingTokens = pendingTokens;
    const base = Date.now();
    const messages = [user('fix it', base + 1), assistant(B, [text('Done.')], base + 5), checkCustom(base + 6)];
    const route = await session.model.route({ reason: 'continuation', messages, thinkingLevel: 'off',
      signal: session.signal });
    chosen.push(`${route.model.provider}/${route.model.id}`);
  }
  assert.deepEqual(chosen, ['a/m1', 'a/m2'], 'with the block a/m1 cannot hold context + block + 100');
});

test('FC-22 the model in use in the segment only goes through checkCurrent: no window check on the check request',
  async () => {
    const { layer } = fakeLayer(pickConfig({ 'a/m1': 1000 }));
    const link = { pendingTokens: 0 };
    const session = await startedSession(layer, { extraContextTokens: () => link.pendingTokens });
    link.pendingTokens = 5000;
    const route = await session.model.route({ reason: 'continuation', messages: checkRequest(Date.now()),
      thinkingLevel: 'off', signal: session.signal });
    assert.equal(`${route.model.provider}/${route.model.id}`, 'a/m1');
    assert.equal(entriesOf(session.manager, 'mori.model_switch').length, 0);
  });

// ---- FC-29 换到推理必须回传的模型 ----

test('FC-29 handoverCheck: a chat with one confirmed check is not reasoning-ok for a replay-required model', () => {
  const target = { ...B, replay: 'required', effectiveWindow: 100_000, maxTokens: 100 };
  for (const [shape, check] of SHAPES) {
    const messages = [user('hello', 1), assistant(A, [text('Hi.')], 2), check(3),
      assistant(A, [call('f1', 'finish')], 4), result('f1', 'finish', 5)];
    const verdict = context.handoverCheck({ messages, target, estimateTokens: () => 10 });
    assert.equal(verdict.differs, true, shape);
    assert.equal(verdict.reasoningOk, false, `${shape}: the finish call counts as a foreign tool call`);
    assert.equal(context.handoverAction(verdict, 'start'), 'rebuild', `${shape}: rebuilt at the segment start`);
    const plain = context.handoverCheck({ messages: messages.slice(0, 2), target, estimateTokens: () => 10 });
    assert.equal(plain.reasoningOk, true, `${shape}: without the check the chat needs no rebuild`);
    const relaxed = context.handoverCheck({ messages, target: { ...target, replay: 'not_required' },
      estimateTokens: () => 10 });
    assert.equal(relaxed.reasoningOk, true, `${shape}: a model that needs no replay takes it over`);
  }
});
