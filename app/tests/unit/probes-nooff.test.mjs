// kernel/probes.ts 的单元测试，思考关不掉的模型（docs/specs/model-providers.md §7.7，MP-38 单元层）：
// 第 2 步判定表的每一行（judgeThinkingStep）、去掉“没有 Off”标记的副本、输出上限的规则、强度的选法；
// 以及经 pi-ai 1.3.0 真实的 openai-completions 组装、替身 fetch 截下请求体的三种模型：fake-coder（普通地址）、
// 地址含 deepseek.com 的模型（关闭思考写成 thinking: { type: "disabled" }）、OpenRouter 前缀地址下的 -nooff 模型
// （关闭思考写成 reasoning: { effort: "none" }，被合成端点的 400 原文拒绝），判定后经 modelCompile.compileInputs
// 与 modelProfiles.compileFlagsOf 编译，看有没有标记。
// 替身 fetch 按合成端点（tests/fake-endpoint/probes.mjs）的 probeStep、probeReply、noOffRejected 回答，SSE 的写法照
// server.mjs（synthetic）；本文件里的模型、配置与回复都是 synthetic。其余探针用例在 probes.test.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { loadKernelModule } from './load.mjs';
import { NOOFF_ERROR_BODY, NOOFF_MESSAGE, NOOFF_STATUS, noOffRejected, probeReply, probeStep }
  from '../fake-endpoint/probes.mjs';

const probes = await loadKernelModule('src/kernel/probes.ts');
const profiles = await loadKernelModule('src/kernel/modelProfiles.ts');
const compiler = await loadKernelModule('src/kernel/modelCompile.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 首个内容的时限放宽到 5 秒：这里经 pi-ai 真实地解析 SSE，不测超时（超时的用例在 probes.test.mjs）。 */
const TIMINGS = { ...MODEL_TIMINGS, probeStepTimeoutMs: 5000 };

/** §7.7 输出上限那一句、第 2 步说明的开头（规格原文）。 */
const OUTPUT_LIMIT = 'Stopped at the probe output limit before answering';
const REFUSED_PREFIX = 'Thinking can’t be turned off: ';

// ---- 替身（synthetic） ----

/** pi 的实际模型（synthetic）。 */
function piModel(overrides = {}) {
  return {
    id: 'fake-coder', name: 'fake-coder', api: 'openai-completions', provider: 'local',
    baseUrl: 'http://127.0.0.1:4319/v1', input: ['text'], reasoning: true, contextWindow: 131072, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides,
  };
}

/** 一条结束的助手消息（synthetic）。 */
function assistant({ text = '', thinking = '', toolCalls = [], stopReason } = {}) {
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking, thinkingSignature: 'reasoning_content' });
  if (text) content.push({ type: 'text', text });
  content.push(...toolCalls);
  return { role: 'assistant', content, api: 'openai-completions', provider: 'local', model: 'fake-coder',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason ?? (toolCalls.length ? 'toolUse' : 'stop'), timestamp: 1 };
}

/** 一次探针请求的结果（ProbeReply 的形状）：成功的回复。 */
function answered(fields, status = 200) {
  return { message: assistant(fields), error: null, status, content: true };
}

/** 一次探针请求的结果：出错（status 为 null 即没有收到响应）。 */
function failed(error, status, message = null) {
  return { message, error, status, content: message !== null };
}

/** 第 0 步读取器的结果（synthetic，同 probes.test.mjs 的 SERVER_READ）。 */
const SERVER_READ = Object.freeze({ kind: 'vllm', version: '0.10.1', reported: 65536,
  meta: Object.freeze({ maxTokens: null, reasoning: null, image: null }) });

/** pi-ai 真实的 openai-completions 组装；请求经 options.fetch（下面的替身）发出。 */
const piStream = { streamSimple: (model, context, options) => completionsStream(model, normalizeContext(context),
  options) };

/**
 * 模型池 fetch 的替身：记下 pi-ai 组装好的请求体，交给 answer(body) 给出响应（synthetic）。
 * @return { fetchFor, bodies }
 */
function endpoint(answer) {
  const bodies = [];
  const fetchFor = (request) => async (_url, init) => {
    request.onSent();
    const body = JSON.parse(init.body);
    bodies.push(body);
    return answer(body);
  };
  return { fetchFor, bodies };
}

/** 探针的依赖：pi-ai 真实组装、替身 fetch、替身读取器。 */
function depsFor(fetchFor) {
  return { streamSimple: piStream.streamSimple, fetchFor, readServer: async () => SERVER_READ, now: () => 1000,
    timings: TIMINGS, signal: new AbortController().signal };
}

/** 一次 SSE 分块（OpenAI 兼容的 chat.completion.chunk，同 server.mjs 的写法）。 */
function chunk(model, delta, finish = null) {
  const data = { id: 'chatcmpl-synthetic', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finish }] };
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** 合成端点的一次回复（probeReply 的形状）写成 SSE 响应；工具调用的 id 由 nextId 给出。 */
function sseResponse(model, reply, nextId) {
  const parts = [chunk(model, { role: 'assistant', content: '' })];
  if (reply.thinking) parts.push(chunk(model, { reasoning_content: reply.thinking }));
  if (reply.text) parts.push(chunk(model, { content: reply.text }));
  reply.toolCalls.forEach((call, index) => parts.push(chunk(model, { tool_calls: [{ index, id: nextId(),
    type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] })));
  const finish = reply.finishReason ?? (reply.toolCalls.length > 0 ? 'tool_calls' : 'stop');
  parts.push(chunk(model, {}, finish), 'data: [DONE]\n\n');
  return new Response(parts.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** -nooff 的回复总带思考（同 server.mjs：不带思考参数、带强度时都照常回答并带思考内容）。 */
const NOOFF_THINKING = 'Synthetic mandatory reasoning.';

/**
 * 按合成端点回答（synthetic）：-nooff 遇到明确的“关闭思考”回 400 和录下的原文，否则按探针各步回答（开了思考时带
 * reasoning_content）。
 * @param flags 模型 id 的后缀（例如 ['nooff']）
 */
function fakeAnswer(flags) {
  const set = new Set(flags);
  let next = 0;
  return (body) => {
    if (noOffRejected(body, set)) {
      return new Response(NOOFF_ERROR_BODY, { status: NOOFF_STATUS, headers: { 'content-type': 'application/json' } });
    }
    const reply = probeReply(probeStep(body.messages), body, set, SERVER_READ.reported);
    if (set.has('nooff') && !reply.thinking) reply.thinking = NOOFF_THINKING;
    return sseResponse(body.model, reply, () => `call_${next += 1}`);
  };
}

/**
 * 地址含 deepseek.com 的服务（synthetic）：thinking.type 为 "disabled" 时 200、回复没有思考；
 * 开了思考（thinking.type "enabled" 带 reasoning_effort）时同合成端点，带思考内容。
 */
function deepseekAnswer() {
  const fake = fakeAnswer([]);
  return (body) => {
    if (body.thinking?.type !== 'disabled') return fake(body);
    const reply = probeReply(probeStep(body.messages), body, new Set(), SERVER_READ.reported);
    delete reply.thinking;
    return sseResponse(body.model, reply, () => 'call_deepseek');
  };
}

/** 一个提供商的配置（synthetic）：一个勾了 Supports thinking 的模型。 */
function providerOf(id, baseUrl, modelId) {
  return { id, name: id, api: 'openai-completions', baseUrl, zone: 'local', compat: {}, concurrency: 1, keys: [],
    nextKeyNumber: 1, models: [{ id: modelId, family: '', contextWindow: 131072, maxTokens: 16384, reasoning: true,
      input: ['text'] }] };
}

/**
 * 按档案编译（§4.4、§7.6）：compileInputs 加 compileFlagsOf 给出的编译项，返回 pi 里这个模型的实际形状
 * （注册内容加提供商的 id 与地址）。auto 为 undefined 即还没有档案。
 */
function compiledModel(provider, auto) {
  const config = { version: 1, providers: [provider], groups: [], normalDefault: null,
    allowedZones: ['local', 'intranet', 'public'], projectZones: {} };
  const lookup = (p) => profiles.compileFlagsOf(p.api, auto);
  const input = compiler.compileInputs(config, lookup, MODEL_TIMINGS.placeholderApiKey).get(provider.id);
  return { ...input.models[0], provider: provider.id, baseUrl: provider.baseUrl };
}

/** 跑一组自动探针（第 0–7 步）。 */
async function probe(provider, model, answer) {
  const server = endpoint(answer);
  const auto = await probes.runAutoProbes({ ref: `${provider.id}/${model.id}`, model }, depsFor(server.fetchFor));
  return { auto, bodies: server.bodies };
}

/** 请求体里第 1、2 步的那几个（提示为 ready）。 */
function readyBodies(bodies) {
  return bodies.filter((body) => probeStep(body.messages) === 1);
}

// ---- 常量与纯函数 ----

test('MP-38 constants: refused-off level medium, the output-limit text and the step 2 prefix are the spec texts',
  () => {
    assert.equal(probes.REFUSED_OFF_LEVEL, 'medium');
    assert.equal(probes.OUTPUT_LIMIT_TEXT, OUTPUT_LIMIT);
    assert.equal(probes.OFF_REFUSED_PREFIX, REFUSED_PREFIX);
    assert.equal(probes.probeThinking(true), 'medium');
    assert.equal(probes.probeThinking(false), 'off');
  });

test('MP-38 judgeThinkingStep rows 1-2: off answers without thinking is a pass, with thinking a fail', () => {
  const medium = answered({ text: 'ready', thinking: 'x' });
  const plain = probes.judgeThinkingStep(answered({ text: 'ready' }), medium);
  assert.deepEqual(plain, { step: { outcome: 'pass', detail: null }, offRefused: false });
  const thinking = probes.judgeThinkingStep(answered({ text: 'ready', thinking: 'Still thinks.' }), medium);
  assert.deepEqual(thinking, { step: { outcome: 'fail', detail: 'The reply has thinking content with thinking off' },
    offRefused: false });
  // 前两行同 judgeThinkingOff
  assert.deepEqual(probes.judgeThinkingOff(answered({ text: 'ready' })), plain.step);
  assert.deepEqual(probes.judgeThinkingOff(answered({ text: 'ready', thinking: 'Still thinks.' })), thinking.step);
});

test('MP-38 judgeThinkingStep row 3: off refused with 400 or 422 and medium text is a fail with off’s text', () => {
  const medium = answered({ text: 'ready', thinking: 'Thinking.' });
  for (const [status, error] of [[400, `400 ${NOOFF_MESSAGE}`], [422, '422 Unprocessable Entity: thinking']]) {
    assert.deepEqual(probes.judgeThinkingStep(failed(error, status), medium),
      { step: { outcome: 'fail', detail: `${REFUSED_PREFIX}${error}` }, offRefused: true }, error);
  }
});

test('MP-38 judgeThinkingStep row 4: off refused, medium errored uses medium’s detail, no text uses off’s', () => {
  const off = failed(`400 ${NOOFF_MESSAGE}`, 400);
  const limitMessage = assistant({ thinking: 'Still thinking.', stopReason: 'length' });
  const cases = [
    [failed('500 Internal Server Error', 500), '500 Internal Server Error'],
    [failed('Connection error.', null), 'Connection error.'],
    [failed('No response within 0.04 s', 200), 'No response within 0.04 s'],
    [failed(OUTPUT_LIMIT, 200, limitMessage), OUTPUT_LIMIT],
    [answered({ thinking: 'Only thinking.' }), off.error],
    [answered({ text: '   ' }), off.error],
  ];
  for (const [medium, detail] of cases) {
    assert.deepEqual(probes.judgeThinkingStep(off, medium),
      { step: { outcome: 'error', detail }, offRefused: false }, detail);
  }
});

test('MP-38 judgeThinkingStep row 5: other off errors (401, 429, 500, connection, timeout, limit) are errors', () => {
  const medium = answered({ text: 'ready', thinking: 'Thinking.' });
  const limitMessage = assistant({ thinking: 'Still thinking.', stopReason: 'length' });
  const offs = [failed('401 Unauthorized', 401), failed('403 Forbidden', 403), failed('429 Too Many Requests', 429),
    failed('500 Internal Server Error', 500), failed('502 Bad Gateway', 502), failed('Connection error.', null),
    failed('No response within 0.04 s', 200), failed(OUTPUT_LIMIT, 200, limitMessage)];
  for (const off of offs) {
    assert.deepEqual(probes.judgeThinkingStep(off, medium),
      { step: { outcome: 'error', detail: off.error }, offRefused: false }, off.error);
  }
});

test('MP-38 withoutNoOffMarker drops only off: null, keeps the other keys and never changes the input', () => {
  const marked = Object.freeze(piModel({ thinkingLevelMap: Object.freeze({ off: null }) }));
  const copy = probes.withoutNoOffMarker(marked);
  assert.notEqual(copy, marked);
  assert.equal('thinkingLevelMap' in copy, false, 'an empty map is dropped');
  const { thinkingLevelMap: _marker, ...rest } = marked;
  assert.deepEqual(copy, rest);
  const mixed = Object.freeze(piModel({ thinkingLevelMap: Object.freeze({ off: null, high: 'max', minimal: null }) }));
  assert.deepEqual(probes.withoutNoOffMarker(mixed).thinkingLevelMap, { high: 'max', minimal: null });
  assert.deepEqual(mixed.thinkingLevelMap, { off: null, high: 'max', minimal: null });
  // 没有标记的模型：内容相同的副本
  for (const model of [piModel(), piModel({ thinkingLevelMap: { off: 'none' } }),
    piModel({ thinkingLevelMap: { high: 'max' } })]) {
    const same = probes.withoutNoOffMarker(model);
    assert.notEqual(same, model);
    assert.deepEqual(same, model);
  }
});

test('MP-38 stoppedAtLimit: stopReason length with only thinking; text, a tool call or another stop is not', () => {
  const call = { type: 'toolCall', id: 'c', name: 'get_weather', arguments: { city: 'Paris', days: 3 } };
  assert.equal(probes.stoppedAtLimit(assistant({ thinking: 'Still thinking.', stopReason: 'length' })), true);
  assert.equal(probes.stoppedAtLimit(assistant({ thinking: 'x', text: 'ready', stopReason: 'length' })), false);
  assert.equal(probes.stoppedAtLimit(assistant({ thinking: 'x', toolCalls: [call], stopReason: 'length' })), false);
  assert.equal(probes.stoppedAtLimit(assistant({ thinking: 'Only thinking.' })), false);
  assert.equal(probes.stoppedAtLimit(assistant({ stopReason: 'length' })), false, 'no thinking either');
  assert.equal(probes.stoppedAtLimit(null), false);
});

// ---- 经 pi-ai 真实的请求组装 ----

test('MP-38 fake-coder through pi-ai: off sends no thinking field; can_disable true, off_refused false, no marker',
  async () => {
    const provider = providerOf('local', 'http://127.0.0.1:4319/v1', 'fake-coder');
    const { auto, bodies } = await probe(provider, compiledModel(provider, undefined), fakeAnswer([]));
    const [, off, medium] = readyBodies(bodies);
    for (const field of ['reasoning_effort', 'reasoning', 'thinking']) assert.equal(off[field], undefined, field);
    assert.equal(medium.reasoning_effort, 'medium');
    assert.deepEqual(auto.steps.thinking, { outcome: 'pass', detail: null });
    assert.equal(auto.offRefused, false);
    const reasoning = profiles.reasoningOf('openai-completions', auto);
    assert.equal(reasoning.can_disable, true);
    assert.equal(reasoning.off_refused, false);
    assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
    assert.equal('thinkingLevelMap' in compiledModel(provider, auto), false, 'compiled without the marker');
  });

test('MP-38 deepseek.com address through pi-ai: off carries thinking disabled, answered without thinking, no marker',
  async () => {
    const provider = providerOf('deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat');
    const { auto, bodies } = await probe(provider, compiledModel(provider, undefined), deepseekAnswer());
    const [first, off, medium] = readyBodies(bodies);
    assert.deepEqual(off.thinking, { type: 'disabled' }, 'pi-ai writes the explicit off for deepseek.com');
    assert.equal(off.reasoning_effort, undefined);
    for (const body of [first, medium]) {
      assert.deepEqual(body.thinking, { type: 'enabled' });
      assert.equal(body.reasoning_effort, 'medium');
    }
    assert.deepEqual(auto.steps.thinking, { outcome: 'pass', detail: null });
    assert.equal(auto.offRefused, false);
    const reasoning = profiles.reasoningOf('openai-completions', auto);
    assert.equal(reasoning.can_disable, true);
    assert.equal(reasoning.off_refused, false);
    assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
    // 第 3、5 步同原来：思考 off，照样写成 thinking disabled
    const offSteps = bodies.filter((body) => [3, 5].includes(probeStep(body.messages)) && !body.reasoning_effort);
    assert.ok(offSteps.length >= 2 && offSteps.every((body) => body.thinking?.type === 'disabled'));
    assert.equal('thinkingLevelMap' in compiledModel(provider, auto), false, 'compiled without the marker');
  });

test('MP-38 -nooff on an OpenRouter address through pi-ai: the explicit off gets the 400 body, step 2 is a fail',
  async () => {
    const provider = providerOf('or', 'http://127.0.0.1:4319/openrouter.ai/v1', 'fake-coder-nooff');
    const { auto, bodies } = await probe(provider, compiledModel(provider, undefined), fakeAnswer(['nooff']));
    const [, off] = readyBodies(bodies);
    assert.deepEqual(off.reasoning, { effort: 'none' }, 'pi-ai writes the OpenRouter explicit off');
    assert.equal(auto.steps.thinking.outcome, 'fail', 'a refused off is a fail, not an error');
    assert.ok(auto.steps.thinking.detail.startsWith(REFUSED_PREFIX), auto.steps.thinking.detail);
    assert.ok(auto.steps.thinking.detail.includes(NOOFF_MESSAGE), auto.steps.thinking.detail);
    assert.equal(auto.offRefused, true);
    assert.deepEqual(profiles.statusOf({ auto }), { status: 'ready', error: null });
    assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
    const reasoning = profiles.reasoningOf('openai-completions', auto);
    assert.equal(reasoning.can_disable, false);
    assert.equal(reasoning.off_refused, true);
    // 第 2 步的 off 以外，每个请求都带强度 medium；第 5 步不发
    const others = bodies.filter((body) => body !== off);
    assert.ok(others.every((body) => body.reasoning?.effort === 'medium'), 'no other request turns thinking off');
    assert.ok(!bodies.some((body) => probeStep(body.messages) === 5), 'step 5 is not sent');
    assert.deepEqual(compiledModel(provider, auto).thinkingLevelMap, { off: null }, 'compiled with the marker');
  });

test('MP-38 -nooff marked model on Verify: step 2 sends the explicit off on the unmarked copy, same result',
  async () => {
    const provider = providerOf('or', 'http://127.0.0.1:4319/openrouter.ai/v1', 'fake-coder-nooff');
    const first = await probe(provider, compiledModel(provider, undefined), fakeAnswer(['nooff']));
    const marked = compiledModel(provider, first.auto);
    assert.deepEqual(marked.thinkingLevelMap, { off: null });
    const again = await probe(provider, marked, fakeAnswer(['nooff']));
    const offs = again.bodies.filter((body) => body.reasoning?.effort === 'none');
    assert.equal(offs.length, 1, 'only step 2 turns thinking off');
    assert.equal(again.auto.offRefused, true);
    assert.deepEqual(again.auto.steps, first.auto.steps);
    assert.deepEqual(marked.thinkingLevelMap, { off: null }, 'the registered model keeps its marker');
  });

test('MP-38 -nooff on a plain address through pi-ai: no explicit off is sent, thinking content is not off_refused',
  async () => {
    const provider = providerOf('local', 'http://127.0.0.1:4319/v1', 'fake-coder-nooff');
    const { auto, bodies } = await probe(provider, compiledModel(provider, undefined), fakeAnswer(['nooff']));
    const [, off] = readyBodies(bodies);
    for (const field of ['reasoning_effort', 'reasoning', 'thinking']) assert.equal(off[field], undefined, field);
    assert.deepEqual(auto.steps.thinking, { outcome: 'fail',
      detail: 'The reply has thinking content with thinking off' });
    assert.equal(auto.offRefused, false);
    assert.equal('thinkingLevelMap' in compiledModel(provider, auto), false);
  });
