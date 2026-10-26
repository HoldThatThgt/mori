// kernel/modelSession.ts 的单元测试：首个内容时限（§5.4 timeout）只在请求真正发出时计时，
// 换 key、原地重试的等待（模型池的 onPause）不计入。定时器用 node:test 的假定时器。
// 2026-10-24（§11.2 第 2.3 步、§7.7，MP-39 单元层）：换模型后重发的强度（resendReasoning）用 pi-ai 真正的
// clampThinkingLevel 按新模型收紧，收紧后是 off 才不传；新模型按 modelCompile.ts 编译（带不带“没有 Off”的标记）。
// 另经真正的 ModelSession 走一次段内换模型（流函数包装里的重发，StreamWrapper.retarget）：模型层、模型池的 fetch、
// pi 会话与 pi 的流函数都是替身（synthetic，同 tests/unit/taskboard/model.test.mjs 的 TB-18），第一个候选回 429。

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

/**
 * 模型层的替身（synthetic）：按 config 回答静态校验；pi 里的实际模型按 modelCompile.ts 编译（next 的档案判出
 * off_refused 时带标记），补上 pi 注册后才有的 provider、baseUrl。模型池只建 fetch：发出时按 status[ref]（默认 200）
 * 记一次尝试并回答。
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
        options.onRecord?.({ ref: options.ref, keyRef: null, cls: code === 429 ? 'rate_limited' : 'ok', status: code,
          retryAfterMs: null, hadOutput: false, sentAt: Date.now() });
        return new Response('{}', { status: code });
      };
    },
    markModel() {}, markProvider() {}, clearModelRecord() {},
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
  };
  return { layer, status, physical };
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
 * 会话的强度为 level 时走一次段内换模型（synthetic 的会话与端点）：or/first 回 429，包装换到 or/next 重发。
 * @param next { reasoning: next 勾了 Supports thinking, offRefused: next 的档案判出思考关不掉 }
 * @param level 会话的思考强度（pi 会话的 thinkingLevel）
 * @return 每次发出的模型与选项
 */
async function resendAfterSwitch(next, level) {
  const { layer, status, physical } = switchLayer(switchConfig(next.reasoning), next.offRefused);
  const model = await ModelSession.create({ layer, sessionId: 's1', cwd: 'D:\\p', emit: () => {} });
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
  status['or/first'] = 429;
  const sent = { systemPrompt: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }] };
  const message = await piSession.agent.streamFunction(physical('or', 'first'), sent,
    { sessionId: 's1', signal }).result();
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
