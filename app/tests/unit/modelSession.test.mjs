// kernel/modelSession.ts 的单元测试：首个内容时限（§5.4 timeout）只在请求真正发出时计时，
// 换 key、原地重试的等待（模型池的 onPause）不计入。定时器用 node:test 的假定时器。
// 2026-10-24（§11.2 第 2.3 步、§7.7，MP-39 单元层）：换模型后重发的强度（resendReasoning）用 pi-ai 真正的
// clampThinkingLevel 按新模型收紧，收紧后是 off 才不传；新模型按 modelCompile.ts 编译（带不带“没有 Off”的标记）。
// 另经真正的 ModelSession 走一次段内换模型（流函数包装里的重发，StreamWrapper.retarget）：模型层、模型池的 fetch、
// pi 会话与 pi 的流函数都是替身（synthetic，同 tests/unit/taskboard/model.test.mjs 的 TB-18），第一个候选回 429。
// 2026-10-26（§5.7，负责人走查 M7）：同一套替身走一次发出后超时（MP-18）：第一个候选不回答，等满 held 再换，
// 换模型带 unconfirmed，等待期间不发别的请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { loadKernelModule } from './load.mjs';

const { FirstContentTimer, ModelSession, resendReasoning } = await loadKernelModule('src/kernel/modelSession.ts');
const C = await loadKernelModule('src/kernel/modelCompile.ts');
const selector = await loadKernelModule('src/kernel/selector.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 时限 120 s 的计时器与它到时的次数。 */
function timer() {
  const fired = [];
  return { fired, timer: new FirstContentTimer(120_000, () => fired.push(Date.now())) };
}

test('MP-18 first-content timer: a 504 just before the limit, then a retry wait, does not count as a timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { fired, timer: watch } = timer();
  watch.restart();
  t.mock.timers.tick(115_000);
  // 504 到了：模型池转去原地重试，等 8 s（onPause），等待期间不计时。
  watch.pause();
  t.mock.timers.tick(8_000);
  assert.equal(watch.fired, false);
  assert.deepEqual(fired, []);
  // 重试发出（onSent）：重新计时，之后收到内容就停。
  watch.restart();
  t.mock.timers.tick(119_000);
  watch.stop();
  t.mock.timers.tick(10_000);
  assert.equal(watch.fired, false);
  assert.deepEqual(fired, []);
});

test('MP-18 first-content timer: after a pause the next send still times out at the full limit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { fired, timer: watch } = timer();
  watch.restart();
  t.mock.timers.tick(60_000);
  watch.pause();
  t.mock.timers.tick(60_000);
  watch.restart();
  t.mock.timers.tick(119_999);
  assert.equal(watch.fired, false);
  t.mock.timers.tick(1);
  assert.equal(watch.fired, true);
  assert.equal(fired.length, 1);
});

test('MP-18 first-content timer: once stopped, a later send does not start it again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { timer: watch } = timer();
  watch.restart();
  watch.stop();
  watch.restart();
  t.mock.timers.tick(200_000);
  assert.equal(watch.fired, false);
});

// ---- 换模型后重发的思考强度（§11.2 第 2.3 步、§7.7） ----

/**
 * 换到的实际模型（synthetic 配置）：按 modelCompile.ts 编译出的注册内容，补上 pi 注册后才有的 provider、baseUrl。
 * @param reasoning 配置里勾了 Supports thinking
 * @param offRefused 档案判出思考关不掉（编译出 thinkingLevelMap: { off: null }）
 */
function switchedTo(reasoning, offRefused) {
  const provider = { id: 'or', name: 'OpenRouter', api: 'openai-completions', compat: {},
    baseUrl: 'http://127.0.0.1:4319/openrouter.ai/v1', concurrency: 4, keys: [], nextKeyNumber: 1,
    models: [{ id: 'next', family: '', contextWindow: 131072, maxTokens: 8192, reasoning, input: ['text'] }] };
  const [input] = C.providerInput(provider, () => ({ replayRequired: false, offRefused }), 'mori-pool').models;
  return { ...input, provider: provider.id, baseUrl: provider.baseUrl };
}

test('MP-39 resend after a model switch: a marked reasoning model turns the session’s Off into minimal', () => {
  const marked = switchedTo(true, true);
  assert.deepEqual(marked.thinkingLevelMap, { off: null }, 'synthetic: the model carries the compiled marker');
  assert.equal(resendReasoning(marked, 'off', clampThinkingLevel), 'minimal');
  assert.equal(resendReasoning(marked, 'minimal', clampThinkingLevel), 'minimal');
  assert.equal(resendReasoning(marked, 'high', clampThinkingLevel), 'high');
});

test('MP-39 resend after a model switch: an unmarked reasoning model with Off sends no reasoning; high stays high',
  () => {
    const plain = switchedTo(true, false);
    assert.ok(!Object.hasOwn(plain, 'thinkingLevelMap'));
    assert.equal(resendReasoning(plain, 'off', clampThinkingLevel), undefined);
    assert.equal(resendReasoning(plain, 'high', clampThinkingLevel), 'high');
    assert.equal(resendReasoning(plain, 'low', clampThinkingLevel), 'low');
  });

test('MP-39 resend after a model switch: a model without Supports thinking sends no reasoning at any level', () => {
  const none = switchedTo(false, false);
  for (const level of ['off', 'minimal', 'high']) {
    assert.equal(resendReasoning(none, level, clampThinkingLevel), undefined, level);
  }
});

test('MP-39 resend after a model switch: the level is clamped for the new model with the clamp it is given', () => {
  const calls = [];
  const marked = switchedTo(true, true);
  const recording = (model, level) => {
    calls.push([model, level]);
    return clampThinkingLevel(model, level);
  };
  assert.equal(resendReasoning(marked, 'off', recording), 'minimal');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], marked, 'clamped for the model it switches to');
  assert.equal(calls[0][1], 'off', 'from the session’s level');
  assert.equal(resendReasoning(marked, 'off', () => 'off'), undefined, 'a clamped off is not sent');
});

// ---- 段内换模型时流函数包装的重发（StreamWrapper.retarget，§11.2 第 3 步、§7.7） ----

/**
 * 换模型的配置（synthetic）：提供商 or 的 first（没勾 Supports thinking，先选它，回 429）与 next（换到的模型）；
 * 分组 pair 依次为 or/first、or/next，是 normalDefault。
 * @param reasoning next 勾了 Supports thinking
 */
function switchConfig(reasoning) {
  const model = (id, thinks) => ({ id, family: '', contextWindow: 131072, maxTokens: 8192, reasoning: thinks,
    input: ['text'] });
  const provider = { id: 'or', name: 'OR', api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:4319/openrouter.ai/v1', compat: {}, concurrency: 4, keys: [],
    nextKeyNumber: 1, models: [model('first', false), model('next', reasoning)] };
  return { version: 1, providers: [provider], groups: [{ id: 'pair', members: ['or/first', 'or/next'] }],
    normalDefault: 'pair' };
}

/** 一直不回答的请求（synthetic）：这次尝试被中止时以中止的原因出错。 */
function untilAborted(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * 模型层的替身（synthetic）：按 config 回答静态校验；pi 里的实际模型按 modelCompile.ts 编译（next 的档案判出
 * off_refused 时带标记），补上 pi 注册后才有的 provider、baseUrl。模型池只建 fetch：发出时按 status[ref]（默认 200）
 * 记一次尝试并回答；status[ref] 为 'hang' 时发出后不回答（同合成端点的 -hang），直到这次尝试被中止。
 * @param config switchConfig 的配置
 * @param offRefused next 的档案判出思考关不掉
 */
function switchLayer(config, offRefused) {
  const status = {};
  const [provider] = config.providers;
  const lookup = (ref) => {
    const model = provider.models.find((item) => `${provider.id}/${item.id}` === ref);
    return model ? { provider, model } : null;
  };
  const flagsOf = (_p, m) => ({ replayRequired: false, offRefused: offRefused && m.id === 'next' });
  const compiled = C.providerInput(provider, flagsOf, 'mori-pool').models;
  const physical = (p, id) => {
    const input = compiled.find((item) => item.id === id);
    return p === provider.id && input ? { ...input, provider: p, baseUrl: provider.baseUrl } : undefined;
  };
  const caps = { tier: 'A', protocolWrite: 'verified', structuredOutput: 'verified', vision: 'unverified',
    effectiveWindow: 131072, probing: false };
  const pool = {
    createFetch(options) {
      return async () => {
        const code = status[options.ref] ?? 200;
        options.onSent?.();
        if (code === 'hang') return untilAborted(options.attemptSignal);
        options.onRecord?.({ ref: options.ref, keyRef: null, cls: code === 429 ? 'rate_limited' : 'ok', status: code,
          retryAfterMs: null, hadOutput: false, sentAt: Date.now() });
        return new Response('{}', { status: code });
      };
    },
    markModel() {}, markProvider() {},
  };
  const runtime = { registerVirtualModel() {}, async refresh() {}, unregisterVirtualModel() {},
    getModel: physical, getPhysicalModel: physical };
  const layer = {
    timings: { ...MODEL_TIMINGS, exhaustionMaxWaitMs: 0 },
    onModelsChanged: () => () => {}, getConfig: () => config,
    projectContext: async () => ({ project: null, projectError: null }),
    expandPicksIn: (_project, picks) => selector.expandPicks(config, picks),
    staticBase: () => ({ configError: null, projectError: null, exists: (ref) => !!lookup(ref),
      toolCalling: () => 'verified', capabilities: () => caps, familyOf: (ref) => ref }),
    exists: (ref) => !!lookup(ref), toolCallingOf: () => 'verified',
    availabilityOf: () => ({ available: true }), capabilitiesOf: () => caps, familyOf: (ref) => ref,
    lookupModel: lookup, profileOf: () => null, getPool: () => pool, async checkVersions() {},
    getRuntime: () => runtime,
    // §7.8：按模型学的首个内容时限；替身没有记录，会话用下限（这里的 timings），记下的用时与超时在 firstTokens 里
    firstTokens: [],
    firstTokenLimitOf: (_ref, use) => (use === 'probe' ? layer.timings.firstTokenCeilingMs
      : layer.timings.firstContentTimeoutMs),
    recordFirstToken: (ref, ms) => layer.firstTokens.push({ ref, ms }),
    recordFirstTokenTimeout: (ref, limitMs) => layer.firstTokens.push({ ref, timeout: limitMs }),
  };
  return { layer, status };
}

/** pi 的流函数替身（synthetic）：记下每次调用；经 options.fetch 发出，HTTP 错误时推 error，否则回一段正文。 */
function recordingStream(calls) {
  return (model, _transcript, options) => {
    calls.push({ ref: `${model.provider}/${model.id}`, model, options });
    return (async function* stream() {
      const response = await options.fetch('http://127.0.0.1:4319/chat', { method: 'POST', body: '{}' });
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      const message = (content, extra) => ({ role: 'assistant', content, api: model.api, provider: model.provider,
        model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
        stopReason: 'stop', timestamp: Date.now(), ...extra });
      if (response.status >= 400) {
        yield { type: 'error', reason: 'error',
          error: message([], { stopReason: 'error', errorMessage: `${response.status} status code` }) };
        return;
      }
      const done = message([{ type: 'text', text: 'ok' }], {});
      yield { type: 'start', partial: done };
      yield { type: 'text_start', contentIndex: 0, partial: done };
      yield { type: 'done', reason: 'stop', message: done };
    })();
  };
}

/** pi 会话的替身（synthetic）：自定义条目写进内存里的分支。 */
function syntheticManager() {
  const entries = [];
  return {
    entries,
    getBranch: () => entries,
    buildSessionContext: () => ({ messages: [] }),
    appendCustomEntry(customType, data) {
      entries.push({ type: 'custom', customType, data, id: `e${entries.length + 1}` });
      return `e${entries.length}`;
    },
  };
}

/**
 * 开始一段回复（synthetic 的会话）：建 ModelSession、载入范围、接上 pi 会话的替身，按“hi”准备好这一段。
 * @param layer switchLayer 的模型层替身
 * @param level 会话的思考强度（pi 会话的 thinkingLevel）
 * @param emit 收后台进程的事件
 * @return { reply（发这段回复的请求，返回 pi 的结果）, compact（同一个模型上的一个压缩请求：sessionId 不是这个会话的，
 *         §11.2 第 1 步）, calls（每次发出的模型与选项） }
 */
async function startReply(layer, level, emit = () => {}) {
  const model = await ModelSession.create({ layer, sessionId: 's1', cwd: 'D:\\p', emit });
  const manager = syntheticManager();
  await model.loadPick(manager, true);
  const calls = [];
  const piSession = { sessionManager: manager, messages: [], thinkingLevel: level,
    settingsManager: { applyOverrides() {} }, agent: { streamFunction: recordingStream(calls) },
    abortCompaction() {}, async compact() {} };
  model.attach(piSession);
  const signal = new AbortController().signal;
  await model.prepare('hi', signal);
  assert.equal(model.state().current, 'or/first', 'synthetic setup check: the first candidate is used first');
  const sent = { systemPrompt: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }] };
  const first = layer.getRuntime().getPhysicalModel('or', 'first');
  const reply = () => piSession.agent.streamFunction(first, sent, { sessionId: 's1', signal }).result();
  const compact = () => piSession.agent.streamFunction(first, sent, { sessionId: 'compaction', signal }).result();
  return { reply, compact, calls };
}

/**
 * 会话的强度为 level 时走一次段内换模型（synthetic 的会话与端点）：or/first 回 429，包装换到 or/next 重发。
 * @param next { reasoning: next 勾了 Supports thinking, offRefused: next 的档案判出思考关不掉 }
 * @param level 会话的思考强度（pi 会话的 thinkingLevel）
 * @return 每次发出的模型与选项
 */
async function resendAfterSwitch(next, level) {
  const { layer, status } = switchLayer(switchConfig(next.reasoning), next.offRefused);
  const { reply, calls } = await startReply(layer, level);
  status['or/first'] = 429;
  const message = await reply();
  assert.equal(message.stopReason, 'stop', 'the resend on or/next answers');
  assert.deepEqual(calls.map((call) => call.ref), ['or/first', 'or/next']);
  return calls;
}

test('MP-39 model switch in a reply: a marked reasoning model gets the session’s Off as minimal, high stays high',
  async () => {
    const off = await resendAfterSwitch({ reasoning: true, offRefused: true }, 'off');
    assert.deepEqual(off[1].model.thinkingLevelMap, { off: null }, 'synthetic: or/next carries the compiled marker');
    assert.equal(off[1].options.reasoning, 'minimal', 'clamped for or/next: it has no Off level');
    const high = await resendAfterSwitch({ reasoning: true, offRefused: true }, 'high');
    assert.equal(high[1].options.reasoning, 'high');
  });

test('MP-39 model switch in a reply: an unmarked reasoning model with Off sends no reasoning, high stays high',
  async () => {
    const off = await resendAfterSwitch({ reasoning: true, offRefused: false }, 'off');
    assert.ok(!Object.hasOwn(off[1].model, 'thinkingLevelMap'));
    assert.equal(off[1].options.reasoning, undefined, 'Off stays off on or/next: no reasoning is sent');
    const high = await resendAfterSwitch({ reasoning: true, offRefused: false }, 'high');
    assert.equal(high[1].options.reasoning, 'high');
  });

test('MP-39 model switch in a reply: a model without Supports thinking gets no reasoning at high', async () => {
  const calls = await resendAfterSwitch({ reasoning: false, offRefused: false }, 'high');
  assert.equal(calls[1].options.reasoning, undefined, 'clamped for or/next: it only has Off');
});

// ---- 发出后超时（§5.7；2026-10-26 改：总是等满 held 再换） ----

test('MP-18 no first content in time: the model is held for the full wait, then the reply switches with '
  + 'unconfirmed; nothing else is sent to the server', async () => {
  const { layer, status } = switchLayer(switchConfig(false), false);
  // synthetic 的短时长：首个内容 30 ms、held 150 ms（§12 是 120 s、2 分钟）
  layer.timings = { ...layer.timings, firstContentTimeoutMs: 30, heldMs: 150 };
  const marks = [];
  layer.getPool().markModel = (ref, state, until) => marks.push({ ref, state, wait: until - Date.now() });
  const events = [];
  const { reply, calls } = await startReply(layer, 'off', (event) => events.push({ event, at: Date.now() }));
  status['or/first'] = 'hang';
  const message = await reply();
  assert.equal(message.stopReason, 'stop', 'or/next answers the same reply');
  assert.deepEqual(calls.map((call) => call.ref), ['or/first', 'or/next'],
    'one request on each model: no second copy on or/first, no request of Mori’s own while waiting');
  assert.deepEqual(marks.map(({ ref, state }) => [ref, state]), [['or/first', 'held']], 'held, not timeout');
  assert.ok(marks[0].wait > 100 && marks[0].wait <= 150, `held until the full wait: ${marks[0].wait} ms`);
  const waits = events.filter(({ event }) => event.type === 'mori.model_wait' && event.kind === 'held');
  assert.deepEqual(waits.map(({ event }) => [event.active, event.model]), [[true, 'or/first'], [false, 'or/first']]);
  assert.ok(waits[1].at - waits[0].at >= 140, `waited ${waits[1].at - waits[0].at} ms of 150`);
  const switched = events.find(({ event }) => event.type === 'mori.model_switch')?.event;
  assert.deepEqual([switched?.from, switched?.to, switched?.reason, switched?.unconfirmed],
    ['or/first', 'or/next', 'timeout', true]);
  assert.ok(events.findIndex(({ event }) => event === switched) > events.indexOf(waits[1]),
    'the switch comes after the wait ends');
});

// ---- §7.8 按模型学的首个内容时限（MP-45） ----

test('MP-45 session requests use the model’s learned first-token limit and report the timeout and the time to '
  + 'first content', async () => {
  const { layer, status } = switchLayer(switchConfig(false), false);
  // synthetic 的短时长：替身没有记录，会话用下限 30 ms；held 150 ms
  layer.timings = { ...layer.timings, firstContentTimeoutMs: 30, heldMs: 150 };
  const asked = [];
  const limitOf = layer.firstTokenLimitOf;
  layer.firstTokenLimitOf = (ref, use) => {
    asked.push([ref, use]);
    return limitOf(ref, use);
  };
  const { reply } = await startReply(layer, 'off');
  status['or/first'] = 'hang';
  const message = await reply();
  assert.equal(message.stopReason, 'stop');
  assert.ok(asked.length >= 2 && asked.every(([, use]) => use === 'session'), JSON.stringify(asked));
  assert.deepEqual(asked.slice(0, 2).map(([ref]) => ref), ['or/first', 'or/next']);
  assert.deepEqual(layer.firstTokens.filter((entry) => 'timeout' in entry), [{ ref: 'or/first', timeout: 30 }],
    'the timeout is reported with the limit it used');
  const answered = layer.firstTokens.filter((entry) => 'ms' in entry);
  assert.deepEqual(answered.map((entry) => entry.ref), ['or/next']);
  assert.ok(answered[0].ms >= 0 && answered[0].ms < 1000, JSON.stringify(answered));
});

test('MP-45 compaction requests use the same learned first-token limit and report a timeout and a first token',
  async () => {
    const { layer, status } = switchLayer(switchConfig(false), false);
    // synthetic 的短时长：替身没有记录，会话的请求（含压缩）用下限 30 ms
    layer.timings = { ...layer.timings, firstContentTimeoutMs: 30, timeoutCooldownMs: 10 };
    const { compact } = await startReply(layer, 'off');
    status['or/first'] = 'hang';
    await compact();
    assert.deepEqual(layer.firstTokens, [{ ref: 'or/first', timeout: 30 }], 'a compaction timeout is reported');
    delete status['or/first'];
    layer.firstTokens.length = 0;
    const message = await compact();
    assert.equal(message.stopReason, 'stop');
    assert.deepEqual(layer.firstTokens.map((entry) => entry.ref), ['or/first']);
    assert.ok(layer.firstTokens[0].ms >= 0, JSON.stringify(layer.firstTokens));
  });
