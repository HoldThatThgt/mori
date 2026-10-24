// kernel/probes.ts 的单元测试（规格 §7.3、§7.4）：各步的请求写法、思考强度、判定、首个内容的时限、取消，
// 以及与合成端点（tests/fake-endpoint/probes.mjs）的约定一致。替身 streamSimple 只在本文件里用（synthetic）。
// 第 0 步改为调用读取器的单模型模式（docs/specs/model-discovery.md §7.1）：这里的 ProbeDeps.readServer 是替身，
// 给出读取器对合成端点默认形状读到的结果；第 0 步本身的用例按 §3.3 改写后在 tests/unit/discovery/profile-step0.test.mjs。
// 2026-10-24（§7.7，MP-38 单元层）：第 2 步判出 off_refused 时本组各步的强度、第 1–7 步发给没有“没有 Off”标记的副本、
// 第 8、9 步按参数 offRefused 选强度、回复停在输出上限只有思考时为出错（合成端点的 -thinklong 回复）。
// 第 2 步判定表的纯函数用例与经 pi-ai 真实组装的用例（-nooff、deepseek.com 的地址）在 probes-nooff.test.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContext } from '@earendil-works/pi-ai';
import { loadKernelModule } from './load.mjs';
import { NOOFF_MESSAGE, probeReply, probeStep, replayRejected } from '../fake-endpoint/probes.mjs';

const probes = await loadKernelModule('src/kernel/probes.ts');
const forced = await loadKernelModule('src/kernel/forcedWrite.ts');
const profiles = await loadKernelModule('src/kernel/modelProfiles.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 第 5–7 步的取值列表（与 probes.ts 的 OUTCOMES 相同）。 */
const OK_FAIL = ['ok', 'fail'];

/** 缩短的时长：首个内容的时限 40 ms，取消探针的窗口 5 ms。 */
const TIMINGS = { ...MODEL_TIMINGS, probeStepTimeoutMs: 40, cancelProbeWindowMs: 5 };

// ---- 替身（synthetic） ----

/** pi 的实际模型。 */
function piModel(overrides = {}) {
  return {
    id: 'fake-coder', name: 'fake-coder', api: 'openai-completions', provider: 'local',
    baseUrl: 'http://127.0.0.1:4319/v1', input: ['text'], reasoning: false, contextWindow: 131072, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides,
  };
}

/** 一条结束的助手消息。 */
function assistant(model, { text = '', thinking = '', signature, toolCalls = [], stopReason, errorMessage } = {}) {
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking, thinkingSignature: signature });
  if (text) content.push({ type: 'text', text });
  content.push(...toolCalls);
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason ?? (toolCalls.length ? 'toolUse' : 'stop'), errorMessage, timestamp: 1,
  };
}

/** 一条成功消息对应的事件。 */
function eventsOf(message) {
  const events = [{ type: 'start', partial: message }];
  message.content.forEach((block, contentIndex) => {
    if (block.type === 'thinking') {
      events.push({ type: 'thinking_start', contentIndex, partial: message },
        { type: 'thinking_delta', contentIndex, delta: block.thinking, partial: message });
    } else if (block.type === 'text') {
      events.push({ type: 'text_start', contentIndex, partial: message },
        { type: 'text_delta', contentIndex, delta: block.text, partial: message });
    } else {
      events.push({ type: 'toolcall_start', contentIndex, partial: message },
        { type: 'toolcall_end', contentIndex, toolCall: block, partial: message });
    }
  });
  events.push({ type: 'done', reason: message.stopReason, message });
  return events;
}

/**
 * 替身 streamSimple：plan(model, context, options) 给出这次请求的结果——
 * { message } 成功；{ status, error } HTTP 错误；{ error } 连接错误（没有响应）；{ hang: true } 发出后不发内容。
 * 每次请求先经 options.fetch（模型池的 fetch 替身），记下 calls。
 */
function stubStream(plan) {
  const calls = [];
  const streamSimple = (model, context, options) => {
    const call = { model, context, options };
    calls.push(call);
    let final;
    return {
      async *[Symbol.asyncIterator]() {
        const step = await plan(model, context, options, calls.length - 1);
        call.plan = step;
        if (step.error && step.status === undefined) {
          final = assistant(model, { stopReason: 'error', errorMessage: step.error });
          yield { type: 'error', reason: 'error', error: final };
          return;
        }
        await options.fetch('http://stub.test/v1/chat/completions', { stubStatus: step.status ?? 200 });
        if (step.hang) {
          await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
          final = assistant(model, { stopReason: 'aborted', errorMessage: 'Request was aborted' });
          yield { type: 'error', reason: 'aborted', error: final };
          return;
        }
        if (step.status && step.status >= 400) {
          final = assistant(model, { stopReason: 'error', errorMessage: step.error });
          yield { type: 'error', reason: 'error', error: final };
          return;
        }
        final = step.message;
        for (const event of eventsOf(step.message)) {
          if (options.signal.aborted) break;
          yield event;
        }
      },
      result: async () => final,
    };
  };
  return { streamSimple, calls };
}

/** 模型池 fetch 的替身：记下请求，回调 onSent，按替身计划的状态返回；delayMs 模拟排队。 */
function stubPool({ delayMs = 0 } = {}) {
  const requests = [];
  const fetchFor = (request) => {
    requests.push(request);
    return async (_url, init) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      request.onSent();
      return new Response(null, { status: init.stubStatus });
    };
  };
  return { fetchFor, requests };
}

/** 第 9 步 GET 的替身（也给 §5.7 的读指标）：url → 正文（没有的为 null）。 */
function stubGet(bodies) {
  const urls = [];
  const getText = async (url) => {
    urls.push(url);
    const body = bodies[new URL(url).pathname];
    return typeof body === 'function' ? body() : body ?? null;
  };
  return { getText, urls };
}

/**
 * 第 0 步读取器的结果（synthetic）：读取器对合成端点默认形状（owned_by "vllm"、max_model_len 65536、/version 0.10.1，
 * model-discovery.md §13.1）读到的种类、版本、报告的窗口与 meta。
 */
const SERVER_READ = Object.freeze({ kind: 'vllm', version: '0.10.1', reported: 65536,
  meta: Object.freeze({ maxTokens: null, reasoning: null, image: null }) });

/** 第 0 步 readServer 的替身：记下每次调用的 signal，给出 server。 */
function stubReadServer(server = SERVER_READ) {
  const signals = [];
  const readServer = async (signal) => {
    signals.push(signal);
    return server;
  };
  return { readServer, signals };
}

/** 探针的依赖。 */
function depsFor({ stream, pool = stubPool(), get = stubGet({}), read = stubReadServer(),
  signal = new AbortController().signal, ...rest }) {
  const steps = [];
  const deps = { streamSimple: stream.streamSimple, fetchFor: pool.fetchFor, readServer: read.readServer,
    getText: get.getText, now: () => 1000, timings: TIMINGS, signal, onStep: (step, of) => steps.push([step, of]),
    ...rest };
  return { deps, steps, pool, get, read, stream };
}

/** 一次探针的目标。 */
function targetFor(model) {
  return { ref: `local/${model.id}`, model };
}

/** pi 消息 → OpenAI 兼容请求的消息（合成端点认得的形状）。 */
function openAiMessages(model, context) {
  return context.messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'toolResult') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    const thinking = message.content.find((block) => block.type === 'thinking');
    const calls = message.content.filter((block) => block.type === 'toolCall');
    const out = { role: 'assistant', content: message.content.filter((b) => b.type === 'text').map((b) => b.text)
      .join('') };
    if (calls.length) {
      out.tool_calls = calls.map((call) => ({ id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    }
    if (thinking) out.reasoning_content = thinking.thinking;
    else if (model.compat?.requiresReasoningContentOnAssistantMessages) out.reasoning_content = '';
    return out;
  });
}

/**
 * 按合成端点（tests/fake-endpoint/probes.mjs）回答的替身：请求体按 OpenAI 兼容的形状组装，经 onPayload 改写，
 * 再交给端点自己的 probeStep / probeReply / replayRejected。
 */
function fakeEndpoint({ flags = [], window = 131072 } = {}) {
  const set = new Set(flags);
  const reasoned = new Set();
  let next = 0;
  return stubStream(async (model, context, options) => {
    let body = { model: model.id, messages: openAiMessages(model, context),
      tools: (context.tools ?? []).map((tool) => ({ type: 'function', function: { name: tool.name } })) };
    // pi 按模型收紧：没标支持思考的模型不发思考参数
    if (options.reasoning && model.reasoning) body.reasoning_effort = options.reasoning;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
    body = (await options.onPayload?.(body, model)) ?? body;
    if (replayRejected(body, set, reasoned)) return { status: 400, error: '400 reasoning_content must be passed back' };
    const reply = probeReply(probeStep(body.messages), body, set, window);
    const toolCalls = reply.toolCalls.map((call) => ({ type: 'toolCall', id: `call_${next += 1}`, name: call.name,
      arguments: call.args }));
    if (reply.thinking && set.has('replay')) toolCalls.forEach((call) => reasoned.add(call.id));
    // -thinklong 以 finish_reason "length" 结束，pi-ai 记为 stopReason "length"（§7.7 的输出上限）
    const stopReason = reply.finishReason === 'length' ? 'length' : undefined;
    return { message: assistant(model, { text: reply.text, thinking: reply.thinking, signature: 'reasoning_content',
      toolCalls, stopReason }) };
  });
}

/** 一次请求的最后一条用户消息的文字。 */
function lastUserText(context) {
  const last = [...context.messages].reverse().find((message) => message.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

// ---- 提示原文与合成端点的约定 ----

test('MP-10 probe prompts are the spec texts and the fake endpoint recognises each step', () => {
  const P = probes.PROBE_PROMPTS;
  assert.equal(P.ready, 'Reply with the single word: ready.');
  assert.equal(P.weather, 'Use the tool to get the weather for Paris for the next 3 days.');
  assert.equal(P.weatherResult, 'Paris: 21°C, sunny for 3 days.');
  assert.equal(P.temperature, 'What temperature did the tool report?');
  assert.equal(P.outcome, 'Call submit_outcome with outcome banana.');
  assert.equal(P.json, 'Reply with JSON whose outcome is banana.');
  assert.equal(P.tagged, 'Answer in exactly this format: <summary>one sentence</summary><outcome>ok or fail</outcome>.'
    + ' Question: is 2 + 2 equal to 4?');
  assert.equal(P.passphrase, 'What is the passphrase?');
  assert.equal(P.count, 'Count from 1 to 400, one number per line.');
  const ask = (text) => probeStep([{ role: 'user', content: text }]);
  assert.deepEqual([P.ready, P.weather, P.temperature, P.outcome, P.json, P.tagged,
    probes.longInputPrompt('amber1234', 100), P.count].map(ask), [1, 3, 4, 5, 6, 7, 8, 9]);
});

test('MP-10 tool schemas: get_weather(city string, days integer), submit_outcome(outcome ok|fail)', () => {
  assert.equal(probes.WEATHER_TOOL.name, 'get_weather');
  assert.deepEqual(probes.WEATHER_TOOL.parameters.properties, { city: { type: 'string' }, days: { type: 'integer' } });
  assert.equal(probes.OUTCOME_TOOL.name, 'submit_outcome');
  assert.deepEqual(probes.OUTCOME_TOOL.parameters.properties.outcome, { type: 'string', enum: ['ok', 'fail'] });
});

// ---- 第 0–7 步：合成端点上的判定 ----

test('MP-10 all-pass model on the fake endpoint: tool calling verified, tier A, vLLM server', async () => {
  const { deps, steps, read, get } = depsFor({ stream: fakeEndpoint() });
  const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
  assert.deepEqual(auto.server, { kind: 'vllm', version: '0.10.1' });
  assert.equal(auto.reported, 65536);
  // 第 0 步只经读取器（model-discovery.md §7.1），带这组探针自己的 signal；结果总带 meta（§7.2）
  assert.deepEqual(read.signals, [deps.signal]);
  assert.deepEqual(get.urls, [], 'step 0 sends no GET of its own');
  assert.deepEqual(auto.meta, { maxTokens: null, reasoning: null, image: null });
  const outcomes = Object.fromEntries(Object.entries(auto.steps).map(([name, result]) => [name, result.outcome]));
  assert.deepEqual(outcomes, { ready: 'pass', thinking: 'not_applicable', call: 'pass', result: 'pass',
    replay: 'not_applicable', a: 'pass', b: 'pass', c: 'not_run' });
  assert.equal(auto.field, 'none');
  assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'A');
  assert.deepEqual(steps.map(([step]) => step), [0, 1, 3, 4, 5, 6, 7]);
  assert.ok(steps.every(([, of]) => of === 8));
});

test('MP-10 every probe request uses the background pool fetch, maxRetries 0, no SDK timeout, 256 tokens', async () => {
  const { deps, pool, stream } = depsFor({ stream: fakeEndpoint() });
  await probes.runAutoProbes(targetFor(piModel()), deps);
  assert.equal(stream.calls.length, 5);
  assert.equal(pool.requests.length, stream.calls.length);
  for (const request of pool.requests) {
    assert.equal(request.cls, 'background');
    assert.equal(request.ref, 'local/fake-coder');
    assert.equal(request.signal, deps.signal);
  }
  for (const { options } of stream.calls) {
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeoutMs, 2147483647);
    assert.equal(options.maxTokens, 256);
    assert.equal(options.apiKey, 'mori-pool');
  }
});

test('MP-10 thinking per step: step 1 medium (reasoning) or off, 2 off+medium, 3/5/6/7 off, replay medium',
  async () => {
    const model = piModel({ id: 'fake-coder-nochoice-noschema', reasoning: true });
    const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['nochoice', 'noschema'] }) });
    await probes.runAutoProbes(targetFor(model), deps);
    const seen = stream.calls.map(({ context, options }) => [lastUserText(context), options.reasoning ?? 'off']);
    const P = probes.PROBE_PROMPTS;
    const plain = depsFor({ stream: fakeEndpoint() });
    await probes.runAutoProbes(targetFor(piModel()), plain.deps);
    const first = plain.stream.calls[0];
    assert.deepEqual([lastUserText(first.context), first.options.reasoning ?? 'off'], [P.ready, 'off']);
    assert.deepEqual(seen, [
      [P.ready, 'medium'], [P.ready, 'off'], [P.ready, 'medium'],
      [P.weather, 'off'], [P.temperature, 'off'],
      [P.weather, 'medium'], [P.temperature, 'medium'], [P.temperature, 'medium'],
      [P.outcome, 'off'], [P.json, 'off'], [P.tagged, 'off'], [P.tagged, 'off'], [P.tagged, 'off'],
    ]);
  });

test('MP-10 reasoning model on the fake endpoint: field reasoning_content, can disable, replay not required',
  async () => {
    const { deps } = depsFor({ stream: fakeEndpoint() });
    const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), deps);
    assert.equal(auto.field, 'reasoning_content');
    assert.equal(auto.steps.thinking.outcome, 'pass');
    assert.equal(auto.steps.replay.outcome, 'pass');
    assert.equal(auto.offRefused, false);
    assert.deepEqual(profiles.reasoningOf('openai-completions', auto),
      { field: 'reasoning_content', can_disable: true, replay: 'not_required', off_refused: false });
  });

test('MP-10 -replay model: dropping reasoning_content is rejected with 4xx, so replay is required', async () => {
  const model = piModel({ id: 'fake-coder-replay', reasoning: true });
  const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['replay'] }) });
  const auto = await probes.runAutoProbes(targetFor(model), deps);
  assert.equal(auto.steps.replay.outcome, 'fail');
  assert.equal(profiles.reasoningOf('openai-completions', auto).replay, 'required');
  const followUps = stream.calls.filter(({ context, options }) => lastUserText(context) === probes.PROBE_PROMPTS
    .temperature && options.reasoning === 'medium');
  assert.equal(followUps.length, 2);
  const [withThinking, without] = followUps;
  const assistantOf = (call) => call.context.messages.find((message) => message.role === 'assistant');
  assert.ok(assistantOf(withThinking).content.some((block) => block.type === 'thinking'));
  assert.ok(!assistantOf(without).content.some((block) => block.type === 'thinking'));
  // §7.7：第 1–7 步发给没有“没有 Off”标记的副本（这里没有标记，副本与注册的模型内容相同）
  assert.deepEqual(withThinking.model, model);
  assert.equal(without.model.compat.requiresReasoningContentOnAssistantMessages, false);
  assert.equal(without.model.id, model.id);
  assert.equal(model.compat, undefined, 'the registered model is not changed');
  assert.equal(auto.steps.call.outcome, 'pass', 'the base step 3/4 is not affected by -replay');
  assert.equal(auto.steps.result.outcome, 'pass');
});

test('MP-10 -notools: tool calling failed and step 4 not run', async () => {
  const { deps } = depsFor({ stream: fakeEndpoint({ flags: ['notools'] }) });
  const auto = await probes.runAutoProbes(targetFor(piModel({ id: 'fake-coder-notools' })), deps);
  assert.equal(auto.steps.call.outcome, 'fail');
  assert.equal(auto.steps.result.outcome, 'not_run');
  assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'failed');
});

test('MP-10 -nochoice: tier B; -nochoice -noschema: step 7 runs 3 times and gives tier C', async () => {
  const b = depsFor({ stream: fakeEndpoint({ flags: ['nochoice'] }) });
  const autoB = await probes.runAutoProbes(targetFor(piModel({ id: 'fake-coder-nochoice' })), b.deps);
  assert.equal(profiles.tierOf(autoB.steps.a, autoB.steps.b, autoB.steps.c), 'B');
  assert.equal(autoB.steps.c.outcome, 'not_run');
  const c = depsFor({ stream: fakeEndpoint({ flags: ['nochoice', 'noschema'] }) });
  const autoC = await probes.runAutoProbes(targetFor(piModel({ id: 'fake-coder-nochoice-noschema' })), c.deps);
  assert.equal(profiles.tierOf(autoC.steps.a, autoC.steps.b, autoC.steps.c), 'C');
  const tagged = c.stream.calls.filter(({ context }) => lastUserText(context) === probes.PROBE_PROMPTS.tagged);
  assert.equal(tagged.length, 3);
  assert.equal(profiles.structuredOutputOf('openai-completions', autoC.steps.b), 'failed');
});

/** 按步骤脚本回答的替身：answers[提示] = 计划或计划的函数；没写的步骤按全通过回答。 */
function scripted(answers, api = 'openai-completions') {
  const P = probes.PROBE_PROMPTS;
  return stubStream((model, context, options, index) => {
    const prompt = lastUserText(context);
    const custom = answers[prompt];
    if (custom) return typeof custom === 'function' ? custom(model, context, options, index) : custom;
    const ok = (fields) => ({ message: assistant(model, fields) });
    if (prompt === P.ready) return ok({ text: 'ready' });
    if (prompt === P.weather) {
      return ok({ toolCalls: [{ type: 'toolCall', id: 'c1', name: 'get_weather',
        arguments: { city: 'Paris', days: 3 } }] });
    }
    if (prompt === P.temperature) return ok({ text: '21°C' });
    if (prompt === P.outcome) {
      return ok({ toolCalls: [{ type: 'toolCall', id: 'c2', name: 'submit_outcome', arguments: { outcome: 'ok' } }] });
    }
    if (prompt === P.json) return ok({ text: '{"outcome":"ok"}' });
    if (prompt === P.tagged) return ok({ text: '<summary>Yes it is.</summary><outcome>ok</outcome>' });
    throw new Error(`unexpected prompt ${prompt.slice(0, 40)} for ${api}`);
  });
}

test('MP-10 step 3 fails when days is a string or the call is to another tool', async () => {
  const P = probes.PROBE_PROMPTS;
  for (const args of [{ city: 'Paris', days: '3' }, { city: 7, days: 3 }, { city: 'Paris', days: 2.5 }]) {
    const stream = scripted({ [P.weather]: (model) => ({ message: assistant(model,
      { toolCalls: [{ type: 'toolCall', id: 'c', name: 'get_weather', arguments: args }] }) }) });
    const { deps } = depsFor({ stream });
    const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
    assert.equal(auto.steps.call.outcome, 'fail', JSON.stringify(args));
  }
  const other = scripted({ [P.weather]: (model) => ({ message: assistant(model,
    { toolCalls: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }] }) }) });
  const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream: other }).deps);
  assert.match(auto.steps.call.detail, /did not call get_weather/);
});

test('MP-10 step 4 sends the call, the tool result and the question; fails without 21', async () => {
  const P = probes.PROBE_PROMPTS;
  const stream = scripted({ [P.temperature]: (model) => ({ message: assistant(model, { text: 'It was warm.' }) }) });
  const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream }).deps);
  assert.equal(auto.steps.call.outcome, 'pass');
  assert.equal(auto.steps.result.outcome, 'fail');
  assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'failed');
  const step4 = stream.calls.find(({ context }) => lastUserText(context) === P.temperature);
  const roles = step4.context.messages.map((message) => message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'user']);
  const result = step4.context.messages[2];
  assert.equal(result.toolCallId, 'c1');
  assert.equal(result.toolName, 'get_weather');
  assert.deepEqual(result.content, [{ type: 'text', text: 'Paris: 21°C, sunny for 3 days.' }]);
});

test('MP-10 an HTTP error or connection error leaves tool calling unverified with the error text', async () => {
  const P = probes.PROBE_PROMPTS;
  const http = scripted({ [P.weather]: { status: 500, error: '500 Internal Server Error' } });
  const autoHttp = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream: http }).deps);
  assert.deepEqual(autoHttp.steps.call, { outcome: 'error', detail: '500 Internal Server Error' });
  assert.equal(autoHttp.steps.result.outcome, 'not_run');
  assert.equal(profiles.toolCallingOf(autoHttp.steps.call, autoHttp.steps.result), 'unverified');
  const connection = scripted({ [P.temperature]: { error: 'Connection error.' } });
  const autoConn = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream: connection }).deps);
  assert.deepEqual(autoConn.steps.result, { outcome: 'error', detail: 'Connection error.' });
  assert.equal(profiles.toolCallingOf(autoConn.steps.call, autoConn.steps.result), 'unverified');
});

test('MP-10 first-content timeout aborts the attempt and makes the step an error', async () => {
  const P = probes.PROBE_PROMPTS;
  const stream = scripted({ [P.ready]: { hang: true } });
  const { deps, pool } = depsFor({ stream });
  const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
  assert.deepEqual(auto.steps.ready, { outcome: 'error', detail: 'No response within 0.04 s' });
  assert.equal(pool.requests[0].attemptSignal.aborted, true);
  assert.equal(auto.steps.call.outcome, 'pass', 'later steps still run');
});

test('MP-10 first-content timeout counts from onSent, not from queueing', async () => {
  const { deps } = depsFor({ stream: scripted({}), pool: stubPool({ delayMs: 100 }) });
  const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
  assert.equal(auto.steps.ready.outcome, 'pass');
  assert.equal(auto.steps.call.outcome, 'pass');
});

test('MP-10 a 4xx on steps 5 and 6 is a judged fail with the error text; step 7 runs and tags give tier C',
  async () => {
    const P = probes.PROBE_PROMPTS;
    const choice = '400 Thinking mode does not support this tool_choice';
    const format = '400 This response_format type is unavailable';
    const stream = scripted({ [P.outcome]: { status: 400, error: choice }, [P.json]: { status: 400, error: format } });
    const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream }).deps);
    assert.deepEqual(auto.steps.a, { outcome: 'fail', detail: choice });
    assert.deepEqual(auto.steps.b, { outcome: 'fail', detail: format });
    assert.equal(stream.calls.filter(({ context }) => lastUserText(context) === P.tagged).length, 3);
    assert.equal(auto.steps.c.outcome, 'pass');
    assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
    assert.equal(profiles.protocolWriteOf(auto.steps.a, auto.steps.b, auto.steps.c), 'verified');
    assert.equal(profiles.structuredOutputOf('openai-completions', auto.steps.b), 'failed');
  });

test('MP-10 a 4xx on step 5 of anthropic-messages is a fail, so step 7 runs and gives tier C', async () => {
  const P = probes.PROBE_PROMPTS;
  const stream = scripted({ [P.outcome]: { status: 400, error: '400 tool_choice is not supported' } });
  const auto = await probes.runAutoProbes(targetFor(piModel({ api: 'anthropic-messages' })), depsFor({ stream }).deps);
  assert.equal(auto.steps.a.outcome, 'fail');
  assert.equal(auto.steps.b.outcome, 'not_applicable');
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
});

test('MP-10 a 5xx, 401, 429 or connection error on step 5 is an error: step 7 not run, protocol_write unverified', async () => {
  const P = probes.PROBE_PROMPTS;
  const bad = (model) => ({ message: assistant(model, { text: 'banana' }) });
  for (const plan of [{ status: 500, error: '500 Internal Server Error' }, { error: 'Connection error.' },
    { status: 429, error: '429 Too Many Requests' }, { status: 401, error: '401 Unauthorized' }]) {
    const stream = scripted({ [P.outcome]: plan, [P.json]: bad });
    const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream }).deps);
    assert.deepEqual(auto.steps.a, { outcome: 'error', detail: plan.error });
    assert.equal(auto.steps.b.outcome, 'fail');
    assert.equal(auto.steps.c.outcome, 'not_run');
    assert.ok(!stream.calls.some(({ context }) => lastUserText(context) === P.tagged), 'step 7 is not sent');
    assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), null);
    assert.equal(profiles.protocolWriteOf(auto.steps.a, auto.steps.b, auto.steps.c), 'unverified');
  }
});

test('MP-10 step 7 stops at the first reply that does not parse; all fail gives tier null and failed', async () => {
  const P = probes.PROBE_PROMPTS;
  const bad = (model) => ({ message: assistant(model, { text: 'banana' }) });
  const stream = scripted({ [P.outcome]: bad, [P.json]: bad,
    [P.tagged]: (model, _c, _o, index) => ({ message: assistant(model,
      { text: index % 2 ? 'Yes.' : '<summary>Yes.</summary><outcome>ok</outcome>' }) }) });
  const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream }).deps);
  assert.equal(auto.steps.c.outcome, 'fail');
  assert.ok(stream.calls.filter(({ context }) => lastUserText(context) === P.tagged).length < 3);
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), null);
  assert.equal(profiles.protocolWriteOf(auto.steps.a, auto.steps.b, auto.steps.c), 'failed');
});

test('MP-10 anthropic-messages: step 6 not run; A fails and C passes is C; A and C fail is tier null', async () => {
  const P = probes.PROBE_PROMPTS;
  const model = piModel({ api: 'anthropic-messages' });
  const bad = (m) => ({ message: assistant(m, { text: 'banana' }) });
  const passC = scripted({ [P.outcome]: bad });
  const autoC = await probes.runAutoProbes(targetFor(model), depsFor({ stream: passC }).deps);
  assert.equal(autoC.steps.b.outcome, 'not_applicable');
  assert.ok(!passC.calls.some(({ context }) => lastUserText(context) === P.json), 'step 6 is not sent');
  assert.equal(profiles.tierOf(autoC.steps.a, autoC.steps.b, autoC.steps.c), 'C');
  assert.equal(autoC.field, 'native');
  const failC = scripted({ [P.outcome]: bad, [P.tagged]: bad });
  const autoNull = await probes.runAutoProbes(targetFor(model), depsFor({ stream: failC }).deps);
  assert.equal(profiles.tierOf(autoNull.steps.a, autoNull.steps.b, autoNull.steps.c), null);
  assert.equal(profiles.protocolWriteOf(autoNull.steps.a, autoNull.steps.b, autoNull.steps.c), 'failed');
  assert.equal(profiles.structuredOutputOf('anthropic-messages', autoNull.steps.b), 'unverified');
});

test('MP-10 replay check: inconclusive when the thinking rerun makes no call; error when it fails', async () => {
  const P = probes.PROBE_PROMPTS;
  const model = piModel({ reasoning: true });
  const noCall = scripted({ [P.weather]: (m, _c, options) => (options.reasoning === 'medium'
    ? { message: assistant(m, { text: 'sunny' }) }
    : { message: assistant(m, { toolCalls: [{ type: 'toolCall', id: 'c1', name: 'get_weather',
      arguments: { city: 'Paris', days: 3 } }] }) }) });
  const autoA = await probes.runAutoProbes(targetFor(model), depsFor({ stream: noCall }).deps);
  assert.equal(autoA.steps.replay.outcome, 'not_run');
  assert.equal(profiles.reasoningOf('openai-completions', autoA).replay, 'unknown');
  const failing = scripted({ [P.temperature]: (m, _c, options) => (options.reasoning === 'medium'
    ? { error: 'Connection error.' } : { message: assistant(m, { text: '21' }) }) });
  const autoB = await probes.runAutoProbes(targetFor(model), depsFor({ stream: failing }).deps);
  assert.deepEqual(autoB.steps.replay, { outcome: 'error', detail: 'Connection error.' });
});

test('MP-10 can_disable is false when thinking off still returns thinking', async () => {
  const P = probes.PROBE_PROMPTS;
  const stream = scripted({ [P.ready]: (m) => ({ message: assistant(m, { text: 'ready', thinking: 'hmm',
    signature: 'reasoning' }) }) });
  const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), depsFor({ stream }).deps);
  assert.equal(auto.steps.thinking.outcome, 'fail');
  assert.equal(auto.field, 'reasoning');
  assert.equal(profiles.reasoningOf('openai-completions', auto).can_disable, false);
});

test('MP-10 reasoning field from thinkingSignature; reasoning_details JSON counts as reasoning_content', () => {
  const m = piModel();
  const msg = (signature, thinking = 'x') => assistant(m, { text: 'a', thinking, signature });
  assert.equal(probes.reasoningFieldOf([msg('reasoning_content')]), 'reasoning_content');
  assert.equal(probes.reasoningFieldOf([msg('reasoning')]), 'reasoning');
  assert.equal(probes.reasoningFieldOf([msg('reasoning_text')]), 'reasoning_text');
  assert.equal(probes.reasoningFieldOf([msg('[{"type":"reasoning.text"}]')]), 'reasoning_content');
  assert.equal(probes.reasoningFieldOf([null, assistant(m, { text: 'a' }), msg('reasoning')]), 'reasoning');
  assert.equal(probes.reasoningFieldOf([msg('reasoning', '  ')]), 'none');
  assert.equal(probes.reasoningFieldOf([]), 'none');
});

test('MP-10 judging functions: ready, JSON outcome, tagged format', () => {
  const m = piModel();
  const reply = (fields) => ({ message: assistant(m, fields), error: null, status: 200, content: true });
  assert.equal(probes.judgeReady(reply({ text: 'ready' })).outcome, 'pass');
  assert.equal(probes.judgeReady(reply({ thinking: 'only thinking' })).outcome, 'fail');
  assert.equal(probes.judgeJsonOutcome(reply({ text: ' {"outcome":"fail"} ' })).outcome, 'pass');
  assert.equal(probes.judgeJsonOutcome(reply({ text: '{"outcome":"banana"}' })).outcome, 'fail');
  assert.equal(probes.judgeJsonOutcome(reply({ text: 'outcome: ok' })).outcome, 'fail');
  assert.equal(probes.judgeOutcomeCall(reply({ toolCalls: [{ type: 'toolCall', id: 'x', name: 'submit_outcome',
    arguments: { outcome: 'banana' } }] })).outcome, 'fail');
  assert.equal(forced.parseTagged('<summary>Yes.</summary><outcome>ok</outcome>', OK_FAIL), true);
  assert.equal(forced.parseTagged('<summary>Yes.</summary>\n<outcome> fail </outcome>', OK_FAIL), true);
  assert.equal(forced.parseTagged('<summary>Yes.</summary><outcome>maybe</outcome>', OK_FAIL), false);
  assert.equal(forced.parseTagged('<summary></summary><outcome>ok</outcome>', OK_FAIL), false);
  assert.equal(forced.parseTagged('ok', OK_FAIL), false);
  const failed = { message: null, error: '502 Bad Gateway', status: 502, content: false };
  assert.deepEqual(probes.judgeTagged([failed]), { outcome: 'error', detail: '502 Bad Gateway' });
});

// ---- 三种接口的请求写法：用 pi-ai 真实的组装，替身 fetch 截下请求体 ----

/** 用 pi-ai 的接口模块组装请求、替身 fetch 截下请求体（一律回 400）。 */
async function capturedBodies(api) {
  const mod = await import(`@earendil-works/pi-ai/api/${api}`);
  const bodies = [];
  const fetchFor = (request) => async (_url, init) => {
    request.onSent();
    bodies.push(JSON.parse(init.body));
    return new Response('{"error":{"message":"captured"}}', { status: 400,
      headers: { 'content-type': 'application/json' } });
  };
  const stream = { streamSimple: (model, context, options) => mod.streamSimple(model, normalizeContext(context),
    options) };
  const { deps } = depsFor({ stream, pool: { fetchFor } });
  await probes.runAutoProbes(targetFor(piModel({ api })), deps);
  return bodies;
}

/** 请求体里的全部文字（找某一步的请求）。 */
function bodyHas(body, text) {
  return JSON.stringify(body).includes(text);
}

test('MP-10 openai-completions payload: tool_choice function, function.strict, response_format json_schema',
  async () => {
    const bodies = await capturedBodies('openai-completions');
    const step5 = bodies.find((body) => bodyHas(body, 'Call submit_outcome'));
    assert.deepEqual(step5.tool_choice, { type: 'function', function: { name: 'submit_outcome' } });
    assert.equal(step5.tools[0].function.name, 'submit_outcome');
    assert.equal(step5.tools[0].function.strict, true);
    assert.equal(step5.reasoning_effort, undefined);
    assert.equal(step5.max_completion_tokens, 256);
    const step6 = bodies.find((body) => bodyHas(body, 'Reply with JSON'));
    assert.deepEqual(step6.response_format, { type: 'json_schema', json_schema: { name: 'outcome',
      schema: { type: 'object', properties: { outcome: { type: 'string', enum: ['ok', 'fail'] } },
        required: ['outcome'], additionalProperties: false }, strict: true } });
  });

test('MP-10 openai-responses payload: tool_choice {type, name}, tools[i].strict, text.format json_schema',
  async () => {
    const bodies = await capturedBodies('openai-responses');
    const step5 = bodies.find((body) => bodyHas(body, 'Call submit_outcome'));
    assert.deepEqual(step5.tool_choice, { type: 'function', name: 'submit_outcome' });
    assert.equal(step5.tools[0].name, 'submit_outcome');
    assert.equal(step5.tools[0].strict, true);
    const step6 = bodies.find((body) => bodyHas(body, 'Reply with JSON'));
    assert.equal(step6.text.format.type, 'json_schema');
    assert.equal(step6.text.format.name, 'outcome');
    assert.equal(step6.text.format.strict, true);
    assert.deepEqual(step6.text.format.schema.properties.outcome.enum, ['ok', 'fail']);
    assert.equal(step6.response_format, undefined);
  });

test('MP-10 anthropic-messages payload: tool_choice {type: tool, name}, tools[i].strict, no step 6', async () => {
  const bodies = await capturedBodies('anthropic-messages');
  const step5 = bodies.find((body) => bodyHas(body, 'Call submit_outcome'));
  assert.deepEqual(step5.tool_choice, { type: 'tool', name: 'submit_outcome' });
  assert.equal(step5.tools[0].name, 'submit_outcome');
  assert.equal(step5.tools[0].strict, true);
  assert.ok(!bodies.some((body) => bodyHas(body, 'Reply with JSON')));
});

test('MP-10 payload helpers leave other fields alone and keep existing text options', () => {
  const body = { model: 'm', text: { verbosity: 'low' } };
  assert.deepEqual(forced.withJsonSchema('openai-responses', body, 'outcome', probes.OUTCOME_SCHEMA).text.verbosity,
    'low');
  assert.deepEqual(body, { model: 'm', text: { verbosity: 'low' } }, 'input is not changed');
  assert.deepEqual(forced.withStrictTools('openai-completions', { model: 'm' }, 'x'), { model: 'm' });
  assert.deepEqual(forced.forcedToolChoice('anthropic-messages', 'x'), { type: 'tool', name: 'x' });
  // withStrictTools 只给指定名字的工具加 strict（平行 Agent 规格 §12.7）
  const fn = (name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
  const completions = forced.withStrictTools('openai-completions', { tools: [fn('read'), fn('submit_outcome')] },
    'submit_outcome');
  assert.equal(completions.tools[0].function.strict, undefined);
  assert.equal(completions.tools[1].function.strict, true);
  const flat = (name) => ({ type: 'function', name, parameters: { type: 'object' } });
  const responses = forced.withStrictTools('openai-responses', { tools: [flat('submit_outcome'), flat('read')] },
    'submit_outcome');
  assert.deepEqual(responses.tools.map((tool) => tool.strict), [true, undefined]);
  const anthropic = forced.withStrictTools('anthropic-messages', { tools: [{ name: 'read' },
    { name: 'submit_outcome' }] }, 'submit_outcome');
  assert.deepEqual(anthropic.tools.map((tool) => tool.strict), [undefined, true]);
});

// ---- 取消：同一个模型同时只跑一组 ----

test('MP-10 a new probe set for the same model cancels the old one', async () => {
  const runs = new probes.ProbeRuns();
  const first = runs.begin('local/a');
  const other = runs.begin('local/b');
  const second = runs.begin('local/a');
  assert.equal(first.aborted, true);
  assert.equal(other.aborted, false);
  assert.equal(runs.end('local/a', first), false, 'the old set must not save');
  assert.equal(runs.end('local/a', second), true);
  assert.equal(runs.isRunning('local/a'), false);
  runs.cancel('local/b');
  assert.equal(other.aborted, true);
  assert.equal(runs.end('local/b', other), false);
});

test('MP-10 a cancelled probe set stops sending and returns null', async () => {
  const controller = new AbortController();
  const P = probes.PROBE_PROMPTS;
  const stream = scripted({ [P.weather]: (model) => {
    controller.abort();
    return { message: assistant(model, { text: 'late' }) };
  } });
  const { deps } = depsFor({ stream, signal: controller.signal });
  assert.equal(await probes.runAutoProbes(targetFor(piModel()), deps), null);
  assert.ok(!stream.calls.some(({ context }) => lastUserText(context) === P.temperature));
});

test('MP-10 a probe set cancelled during step 0 returns null and sends no request of steps 1-7', async () => {
  const controller = new AbortController();
  const stream = scripted({});
  // 读取器只随这组探针的 signal 停止（model-discovery.md §5.3）：取消时以 signal.reason 拒绝
  const asked = [];
  const readServer = (signal) => new Promise((_resolve, reject) => {
    asked.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const { deps } = depsFor({ stream, signal: controller.signal, read: { readServer } });
  const pending = probes.runAutoProbes(targetFor(piModel()), deps);
  assert.deepEqual(asked, [controller.signal], 'step 0 is reading when the probe set is cancelled');
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(stream.calls.length, 0);
});

// ---- 第 8 步：长输入（需要同意） ----

test('MP-11 long-input prompt: passphrase first, padded to the token estimate, question last', () => {
  const prompt = probes.longInputPrompt('lantern4821', 1000);
  assert.ok(prompt.startsWith('The passphrase is lantern4821.'));
  assert.ok(prompt.endsWith('What is the passphrase?'));
  assert.equal(prompt.length, 4000);
  assert.equal((prompt.match(/passphrase/g) ?? []).length, 2);
  assert.ok(probes.longInputPrompt('x', 0).endsWith('What is the passphrase?'));
});

test('MP-11 long-input lengths are 50% and 90% of the effective window; the dialog estimate is their sum', () => {
  assert.deepEqual(probes.longInputLengths(100000, TIMINGS), [50000, 90000]);
  assert.equal(probes.longInputTokenEstimate(100000, TIMINGS), 140000);
});

test('MP-11 fake endpoint -truncate: 50% passes, 90% is silent, effective drops to the 50% length', async () => {
  const window = 4000;
  const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['truncate'], window }),
    randomWord: () => 'quartz7777' });
  const result = await probes.runLongInputProbe(targetFor(piModel({ id: 'fake-coder-truncate' })), window, false,
    deps);
  assert.deepEqual(result, { step: { outcome: 'pass', detail: 'Silently truncates long input' },
    truncation: 'silent', limit: 2000 });
  assert.equal(stream.calls.length, 2);
  assert.ok(stream.calls.every(({ options }) => options.reasoning === undefined && options.maxTokens === 256));
  const model = { id: 'm', family: '', contextWindow: 8000, maxTokens: 1000, reasoning: false, input: ['text'] };
  assert.equal(profiles.contextOf(model, 4000, result).effective, 2000);
});

test('MP-11 fake endpoint without -truncate: both lengths pass, truncation none', async () => {
  const { deps } = depsFor({ stream: fakeEndpoint({ window: 4000 }) });
  const result = await probes.runLongInputProbe(targetFor(piModel()), 4000, false, deps);
  assert.deepEqual(result, { step: { outcome: 'pass', detail: null }, truncation: 'none', limit: null });
});

test('MP-11 long-input judgement: silent at 50% is 0, HTTP rejection is none, connection error keeps old', () => {
  const t = (tokens, outcome, detail = null) => ({ tokens, outcome, detail });
  assert.deepEqual(probes.judgeLongInput([t(50, 'silent'), t(90, 'silent')]).limit, 0);
  assert.deepEqual(probes.judgeLongInput([t(50, 'pass'), t(90, 'rejected', '400 too long')]),
    { step: { outcome: 'pass', detail: null }, truncation: 'none', limit: null });
  assert.deepEqual(probes.judgeLongInput([t(50, 'pass'), t(90, 'error', 'Connection error.')]),
    { step: { outcome: 'error', detail: 'Connection error.' }, truncation: null, limit: null });
  const m = piModel();
  const ok = { message: assistant(m, { text: 'It is QUARTZ7777.' }), error: null, status: 200, content: true };
  assert.equal(probes.judgeLongInputTrial(ok, 'quartz7777', 5).outcome, 'pass');
  const rejected = { message: null, error: '400 context too long', status: 400, content: false };
  assert.equal(probes.judgeLongInputTrial(rejected, 'w', 5).outcome, 'rejected');
  const dropped = { message: null, error: 'Connection error.', status: null, content: false };
  assert.equal(probes.judgeLongInputTrial(dropped, 'w', 5).outcome, 'error');
});

// ---- 第 9 步：取消（需要同意） ----

/** 进行中请求数会变化的 /metrics 替身。 */
function metrics(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value === null ? null : `# HELP x\nvllm:num_requests_running{model_name="m"} ${value}\n`;
  };
}

/** 第 9 步的替身：数数的回复，收到内容即被断开。 */
function counting() {
  return scripted({ [probes.PROBE_PROMPTS.count]: (model) => ({ message: assistant(model,
    { text: '1\n2\n3\n' }) }) });
}

test('MP-11 cancel probe: count back to baseline is true; still above is false; first output then disconnect',
  async () => {
    const back = depsFor({ stream: counting(), get: stubGet({ '/metrics': metrics([2, 2]) }) });
    const target = targetFor(piModel());
    assert.deepEqual(await probes.runCancelProbe(target, 'vllm', false, back.deps),
      { step: { outcome: 'pass', detail: null }, verified: true });
    const call = back.stream.calls[0];
    assert.equal(call.options.maxTokens, 2048);
    assert.equal(call.options.reasoning, undefined);
    assert.equal(call.options.signal.aborted, true, 'disconnected after the first output');
    assert.deepEqual(back.get.urls, ['http://127.0.0.1:4319/metrics', 'http://127.0.0.1:4319/metrics']);
    const stuck = depsFor({ stream: counting(), get: stubGet({ '/metrics': metrics([0, 1]) }) });
    assert.equal((await probes.runCancelProbe(target, 'vllm', false, stuck.deps)).verified, false);
  });

test('MP-11 cancel probe: no metrics endpoint or no counter is unknown; other servers are unknown', async () => {
  const target = targetFor(piModel());
  const none = depsFor({ stream: counting(), get: stubGet({}) });
  const result = await probes.runCancelProbe(target, 'vllm', false, none.deps);
  assert.equal(result.verified, 'unknown');
  assert.equal(none.stream.calls.length, 0, 'no request without a baseline');
  const noCounter = depsFor({ stream: counting(), get: stubGet({ '/metrics': '# nothing\nother_metric 3\n' }) });
  assert.equal((await probes.runCancelProbe(target, 'vllm', false, noCounter.deps)).verified, 'unknown');
  const gone = depsFor({ stream: counting(), get: stubGet({ '/metrics': metrics([1, null]) }) });
  assert.equal((await probes.runCancelProbe(target, 'vllm', false, gone.deps)).verified, 'unknown');
  for (const kind of ['ollama', 'unknown']) {
    const other = depsFor({ stream: counting() });
    assert.deepEqual(await probes.runCancelProbe(target, kind, false, other.deps),
      { step: { outcome: 'not_applicable', detail: null }, verified: 'unknown' });
    assert.equal(other.stream.calls.length, 0);
  }
});

test('MP-11 cancel probe: a request error before any output is an error with unknown', async () => {
  const stream = scripted({ [probes.PROBE_PROMPTS.count]: { status: 503, error: '503 Service Unavailable' } });
  const { deps } = depsFor({ stream, get: stubGet({ '/metrics': metrics([0]) }) });
  assert.deepEqual(await probes.runCancelProbe(targetFor(piModel()), 'vllm', false, deps),
    { step: { outcome: 'error', detail: '503 Service Unavailable' }, verified: 'unknown' });
});

test('MP-11 running-request counters: vLLM, SGLang /metrics and llama.cpp /slots', async () => {
  const text = 'vllm:num_requests_running{model_name="a"} 1.0\nvllm:num_requests_running{model_name="b"} 2\n'
    + 'vllm:num_requests_waiting 5\n';
  assert.equal(probes.prometheusValue(text, 'vllm:num_requests_running'), 3);
  assert.equal(probes.prometheusValue(text, 'sglang:num_running_reqs'), null);
  const signal = new AbortController().signal;
  const sglang = stubGet({ '/metrics': 'sglang:num_running_reqs{tp_rank="0"} 4\n' });
  assert.equal(await probes.readRunningRequests(sglang, 'http://h:30000/v1', 'sglang', signal), 4);
  const slots = stubGet({ '/slots': JSON.stringify([{ id: 0, is_processing: true },
    { id: 1, is_processing: false }]) });
  assert.equal(await probes.readRunningRequests(slots, 'http://h:8080', 'llamacpp', signal), 1);
  assert.deepEqual(slots.urls, ['http://h:8080/slots']);
  const badSlots = stubGet({ '/slots': '{"error":"disabled"}' });
  assert.equal(await probes.readRunningRequests(badSlots, 'http://h:8080', 'llamacpp', signal), null);
  assert.equal(await probes.readRunningRequests(sglang, 'http://h', 'ollama', signal), null);
  assert.equal(probes.judgeCancel(2, 2), true);
  assert.equal(probes.judgeCancel(2, 3), false);
  assert.equal(probes.judgeCancel(2, null), 'unknown');
});

test('MP-11 cancelling the cancel probe while it waits returns null', async () => {
  const controller = new AbortController();
  const { deps } = depsFor({ stream: counting(), get: stubGet({ '/metrics': metrics([0, 0]) }),
    signal: controller.signal, timings: { ...TIMINGS, cancelProbeWindowMs: 10_000 } });
  const pending = probes.runCancelProbe(targetFor(piModel()), 'vllm', false, deps);
  setTimeout(() => controller.abort(), 20);
  assert.equal(await pending, null);
});

// ---- §7.7 思考关不掉的模型（MP-38） ----
// 本节的错误原文、回复、模型与档案除标明出自规格的以外都是 synthetic。

/** -nooff 关闭思考被拒的原文（合成端点 probes.mjs 的 NOOFF_MESSAGE 加状态前缀；synthetic）。 */
const OFF_REFUSED_TEXT = `400 ${NOOFF_MESSAGE}`;

/** §7.7 输出上限那一句（规格原文）。 */
const OUTPUT_LIMIT = 'Stopped at the probe output limit before answering';

/**
 * 第 1、2 步的计划（synthetic）：这组的第一个 ready 请求是第 1 步（回 ready），之后不带思考的是第 2 步的 off、
 * 带思考的是第 2 步的 medium。off、medium 是计划或计划的函数（参数为模型）。
 */
function readyThenStepTwo(off, medium) {
  let count = 0;
  return (model, _context, options) => {
    count += 1;
    const plan = count === 1 ? { message: assistant(model, { text: 'ready' }) }
      : options.reasoning === undefined ? off : medium;
    return typeof plan === 'function' ? plan(model) : plan;
  };
}

/** 有正文的 medium 回复（synthetic）。 */
const mediumReady = (model) => ({ message: assistant(model, { text: 'ready', thinking: 'Thinking first.',
  signature: 'reasoning_content' }) });

/** 只有思考、停在输出上限的回复（synthetic）。 */
const thinkingOnlyAtLimit = (model) => ({ message: assistant(model, { thinking: 'Still thinking.',
  signature: 'reasoning_content', stopReason: 'length' }) });

/** 每次请求的提示与思考强度（没有 reasoning 选项记为 off）。 */
function seenOf(calls) {
  return calls.map(({ context, options }) => [lastUserText(context), options.reasoning ?? 'off']);
}

/** 档案的 status（statusOf 只看 auto、longInput、cancel）。 */
function statusOfAuto(auto) {
  return profiles.statusOf({ auto, longInput: null, cancel: null });
}

test('MP-38 step 2 via runAutoProbes: off refused with 400 or 422 and medium text is a fail, off_refused true',
  async () => {
    const P = probes.PROBE_PROMPTS;
    for (const off of [{ status: 400, error: OFF_REFUSED_TEXT },
      // synthetic 的 422 原文
      { status: 422, error: '422 Thinking cannot be disabled for this model' }]) {
      const stream = scripted({ [P.ready]: readyThenStepTwo(off, mediumReady) });
      const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), depsFor({ stream }).deps);
      assert.deepEqual(auto.steps.thinking, { outcome: 'fail', detail: `Thinking can’t be turned off: ${off.error}` });
      assert.equal(auto.offRefused, true);
      assert.deepEqual(profiles.reasoningOf('openai-completions', auto),
        { field: 'reasoning_content', can_disable: false, replay: 'not_required', off_refused: true });
      // 不算出错：档案不因此为 error
      assert.deepEqual(statusOfAuto(auto), { status: 'ready', error: null });
    }
  });

test('MP-38 step 2 via runAutoProbes: off refused and medium errored or without text is an error', async () => {
  const P = probes.PROBE_PROMPTS;
  const off = { status: 400, error: OFF_REFUSED_TEXT };
  const noText = (model) => ({ message: assistant(model, { thinking: 'Only thinking.' }) });
  // medium 出错时用它的说明（含输出上限那一句）；medium 没出错但没有正文时用 off 的原文
  const cases = [[{ status: 500, error: '500 Internal Server Error' }, '500 Internal Server Error'],
    [{ error: 'Connection error.' }, 'Connection error.'], [thinkingOnlyAtLimit, OUTPUT_LIMIT],
    [noText, OFF_REFUSED_TEXT]];
  for (const [medium, detail] of cases) {
    const stream = scripted({ [P.ready]: readyThenStepTwo(off, medium) });
    const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), depsFor({ stream }).deps);
    assert.deepEqual(auto.steps.thinking, { outcome: 'error', detail }, detail);
    assert.equal(auto.offRefused, false);
    assert.equal(profiles.reasoningOf('openai-completions', auto).can_disable, 'unknown');
    assert.equal(profiles.reasoningOf('openai-completions', auto).off_refused, false);
    assert.deepEqual(statusOfAuto(auto), { status: 'error', error: detail });
    // 没判出 off_refused：第 5 步照常发出，思考 off
    assert.ok(stream.calls.some(({ context, options }) => lastUserText(context) === P.outcome
      && options.reasoning === undefined), 'step 5 is sent with thinking off');
  }
});

test('MP-38 step 2 via runAutoProbes: other off errors (401, 429, 500, connection, timeout) are errors', async () => {
  const P = probes.PROBE_PROMPTS;
  const cases = [[{ status: 401, error: '401 Unauthorized' }, '401 Unauthorized'],
    [{ status: 429, error: '429 Too Many Requests' }, '429 Too Many Requests'],
    [{ status: 500, error: '500 Internal Server Error' }, '500 Internal Server Error'],
    [{ error: 'Connection error.' }, 'Connection error.'], [{ hang: true }, 'No response within 0.04 s'],
    [thinkingOnlyAtLimit, OUTPUT_LIMIT]];
  for (const [off, detail] of cases) {
    // medium 有正文也不改变判定：只有 400、422 才算关闭思考被拒
    const stream = scripted({ [P.ready]: readyThenStepTwo(off, mediumReady) });
    const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), depsFor({ stream }).deps);
    assert.deepEqual(auto.steps.thinking, { outcome: 'error', detail }, detail);
    assert.equal(auto.offRefused, false, detail);
    assert.equal(profiles.reasoningOf('openai-completions', auto).off_refused, false);
    assert.equal(profiles.reasoningOf('openai-completions', auto).can_disable, 'unknown');
  }
});

test('MP-38 off_refused in step 2: steps 3, 4, 6, 7 use medium, step 5 is not applicable and not sent, 7 runs',
  async () => {
    const P = probes.PROBE_PROMPTS;
    const bad = (model) => ({ message: assistant(model, { text: 'banana' }) });
    const stream = scripted({ [P.ready]: readyThenStepTwo({ status: 400, error: OFF_REFUSED_TEXT }, mediumReady),
      [P.json]: bad });
    const { deps, steps } = depsFor({ stream });
    const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), deps);
    assert.equal(auto.offRefused, true);
    assert.deepEqual(seenOf(stream.calls), [
      [P.ready, 'medium'], [P.ready, 'off'], [P.ready, 'medium'],
      [P.weather, 'medium'], [P.temperature, 'medium'],
      [P.weather, 'medium'], [P.temperature, 'medium'], [P.temperature, 'medium'],
      [P.json, 'medium'], [P.tagged, 'medium'], [P.tagged, 'medium'], [P.tagged, 'medium'],
    ]);
    assert.ok(!stream.calls.some(({ context }) => lastUserText(context) === P.outcome), 'step 5 is not sent');
    assert.deepEqual(auto.steps.a, { outcome: 'not_applicable', detail: null });
    assert.equal(auto.steps.b.outcome, 'fail');
    assert.deepEqual(auto.steps.c, { outcome: 'pass', detail: null });
    assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
    assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
    assert.deepEqual(steps.map(([step]) => step), [0, 1, 2, 3, 4, 5, 6, 7], 'progress for every step');
    // 第 7 步照样判定：标签不对时为不通过，三级都没有
    const failing = scripted({ [P.ready]: readyThenStepTwo({ status: 400, error: OFF_REFUSED_TEXT }, mediumReady),
      [P.json]: bad, [P.tagged]: bad });
    const autoFail = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })),
      depsFor({ stream: failing }).deps);
    assert.equal(autoFail.steps.c.outcome, 'fail');
    assert.equal(profiles.protocolWriteOf(autoFail.steps.a, autoFail.steps.b, autoFail.steps.c), 'failed');
  });

test('MP-38 off_refused on anthropic-messages: steps 5 and 6 not applicable, step 7 runs with medium', async () => {
  const P = probes.PROBE_PROMPTS;
  // synthetic 的 400 原文
  const stream = scripted({ [P.ready]: readyThenStepTwo({ status: 400, error: '400 thinking must be enabled' },
    mediumReady) });
  const auto = await probes.runAutoProbes(targetFor(piModel({ api: 'anthropic-messages', reasoning: true })),
    depsFor({ stream }).deps);
  assert.equal(auto.offRefused, true);
  assert.deepEqual(seenOf(stream.calls), [[P.ready, 'medium'], [P.ready, 'off'], [P.ready, 'medium'],
    [P.weather, 'medium'], [P.temperature, 'medium'], [P.tagged, 'medium'], [P.tagged, 'medium'],
    [P.tagged, 'medium']]);
  assert.equal(auto.steps.a.outcome, 'not_applicable');
  assert.equal(auto.steps.b.outcome, 'not_applicable');
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
  assert.deepEqual(profiles.reasoningOf('anthropic-messages', auto),
    { field: 'native', can_disable: false, replay: 'not_required', off_refused: true });
});

/** 冻结模型及其中的对象：探针若改它就抛错（ESM 是严格模式）。 */
function frozen(model) {
  for (const value of Object.values(model)) if (value && typeof value === 'object') Object.freeze(value);
  return Object.freeze(model);
}

test('MP-38 steps 1-7 and the replay check go to a copy without the no-Off marker; the target is untouched',
  async () => {
    const marked = frozen(piModel({ reasoning: true, thinkingLevelMap: { off: null } }));
    const before = structuredClone(marked);
    const { deps, stream } = depsFor({ stream: fakeEndpoint() });
    const auto = await probes.runAutoProbes(targetFor(marked), deps);
    assert.equal(auto.steps.replay.outcome, 'pass', 'the replay check ran');
    const replayCalls = stream.calls.filter(({ context, options }) => lastUserText(context) === probes.PROBE_PROMPTS
      .temperature && options.reasoning === 'medium');
    assert.equal(replayCalls.length, 2);
    for (const { model } of stream.calls) {
      assert.notEqual(model, marked, 'never the registered model itself');
      assert.equal('thinkingLevelMap' in model, false, 'the copy has no thinkingLevelMap left');
      for (const field of ['id', 'api', 'provider', 'baseUrl', 'reasoning', 'contextWindow', 'maxTokens']) {
        assert.equal(model[field], marked[field], field);
      }
    }
    assert.equal(stream.calls.length, 10);
    assert.deepEqual(marked, before, 'the target model is not changed');
    assert.deepEqual(marked.thinkingLevelMap, { off: null });
  });

test('MP-38 a marked model whose step 2 finds it can disable thinking: steps 3-7 are sent with thinking off',
  async () => {
    const P = probes.PROBE_PROMPTS;
    const model = piModel({ id: 'fake-coder-nochoice-noschema', reasoning: true, thinkingLevelMap: { off: null } });
    const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['nochoice', 'noschema'] }) });
    const auto = await probes.runAutoProbes(targetFor(model), deps);
    assert.deepEqual(auto.steps.thinking, { outcome: 'pass', detail: null });
    assert.equal(auto.offRefused, false);
    assert.deepEqual(seenOf(stream.calls), [
      [P.ready, 'medium'], [P.ready, 'off'], [P.ready, 'medium'],
      [P.weather, 'off'], [P.temperature, 'off'],
      [P.weather, 'medium'], [P.temperature, 'medium'], [P.temperature, 'medium'],
      [P.outcome, 'off'], [P.json, 'off'], [P.tagged, 'off'], [P.tagged, 'off'], [P.tagged, 'off'],
    ]);
    // 思考 off = 不带 reasoning 选项（pi 的三种接口都把它当作关闭思考）
    const offCalls = stream.calls.filter(({ options }) => options.reasoning === undefined);
    assert.ok(offCalls.every(({ options }) => !('reasoning' in options)));
    assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
    // 这一次判出能关闭：档案不再要求标记
    assert.deepEqual(profiles.compileFlagsOf('openai-completions', auto), { replayRequired: false, offRefused: false });
  });

/**
 * 第 8、9 步各发一次（synthetic 的替身），返回各次请求。
 * @param model 编译后的模型
 * @param offRefused 档案里存的 off_refused
 */
async function stepsEightNine(model, offRefused) {
  const long = depsFor({ stream: fakeEndpoint({ window: 4000 }) });
  const result = await probes.runLongInputProbe(targetFor(model), 4000, offRefused, long.deps);
  assert.deepEqual(result, { step: { outcome: 'pass', detail: null }, truncation: 'none', limit: null });
  const cancel = depsFor({ stream: counting(), get: stubGet({ '/metrics': metrics([0, 0]) }) });
  assert.equal((await probes.runCancelProbe(targetFor(model), 'vllm', offRefused, cancel.deps)).verified, true);
  return { long: long.stream.calls, cancel: cancel.stream.calls };
}

test('MP-38 steps 8 and 9 go to the compiled model and pick the level from offRefused: true medium, false none',
  async () => {
    const marked = piModel({ reasoning: true, thinkingLevelMap: { off: null } });
    const plain = piModel({ reasoning: true });
    // 交叉组合：强度只看 offRefused 参数，不看模型上有没有标记
    for (const [offRefused, model, level] of [[true, marked, 'medium'], [true, plain, 'medium'],
      [false, marked, undefined], [false, plain, undefined]]) {
      const label = `offRefused ${offRefused}, ${model === marked ? 'marked' : 'unmarked'} model`;
      const { long, cancel } = await stepsEightNine(model, offRefused);
      assert.equal(long.length, 2, label);
      for (const call of long) {
        assert.equal(call.model, model, `step 8 uses the compiled model (${label})`);
        assert.equal(call.options.reasoning, level, `step 8 level (${label})`);
        if (level === undefined) assert.equal('reasoning' in call.options, false, `step 8 has no option (${label})`);
      }
      assert.equal(cancel.length, 1, label);
      assert.equal(cancel[0].model, model, `step 9 uses the compiled model (${label})`);
      assert.equal(cancel[0].options.reasoning, level, `step 9 level (${label})`);
      if (level === undefined) assert.equal('reasoning' in cancel[0].options, false, `step 9 has no option (${label})`);
    }
  });

test('MP-38 -thinklong: a thinking-only reply stopped at the output limit makes the step an error', async () => {
  const model = piModel({ id: 'fake-coder-thinklong', reasoning: true });
  const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['thinklong'] }) });
  const auto = await probes.runAutoProbes(targetFor(model), deps);
  assert.equal(probes.OUTPUT_LIMIT_TEXT, OUTPUT_LIMIT);
  const limit = { outcome: 'error', detail: OUTPUT_LIMIT };
  assert.deepEqual(auto.steps.ready, limit, 'step 1 (medium) stops at the limit');
  assert.deepEqual(auto.steps.replay, limit, 'the replay check (medium) stops at the limit');
  assert.equal(auto.steps.thinking.outcome, 'pass', 'off answers without thinking');
  assert.equal(auto.offRefused, false);
  assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'A');
  assert.deepEqual(statusOfAuto(auto), { status: 'error', error: OUTPUT_LIMIT });
  // 停在上限的消息保留下来，推理字段名仍从中读出
  assert.equal(auto.field, 'reasoning_content');
  const first = stream.calls[0];
  assert.equal(first.plan.message.stopReason, 'length');
  assert.ok(!first.plan.message.content.some((block) => block.type === 'text'), 'the reply had only thinking');
});

test('MP-38 -thinklong on step 8: an output-limit reply is an error with truncation null, never silent', async () => {
  const model = piModel({ id: 'fake-coder-thinklong', reasoning: true, thinkingLevelMap: { off: null } });
  const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['thinklong'], window: 4000 }),
    randomWord: () => 'quartz7777' });
  const result = await probes.runLongInputProbe(targetFor(model), 4000, true, deps);
  assert.deepEqual(result, { step: { outcome: 'error', detail: OUTPUT_LIMIT }, truncation: null, limit: null });
  assert.equal(stream.calls.length, 2);
  assert.ok(stream.calls.every(({ options }) => options.reasoning === 'medium'));
  // synthetic 的一次尝试：只有思考、停在输出上限
  const atLimit = { message: assistant(model, { thinking: 'Still thinking.', stopReason: 'length' }),
    error: OUTPUT_LIMIT, status: 200, content: true };
  assert.deepEqual(probes.judgeLongInputTrial(atLimit, 'quartz7777', 2000),
    { tokens: 2000, outcome: 'error', detail: OUTPUT_LIMIT });
  // 记进档案：truncation 与有效窗口保持原值，不记 silent（synthetic 的旧档案）
  const stored = { auto: {}, longInput: { step: { outcome: 'pass', detail: null }, truncation: 'none', limit: null },
    cancel: null, probedAt: 1 };
  const updated = profiles.withLongInput(stored, result, 2);
  assert.equal(updated.longInput.truncation, 'none');
  assert.deepEqual(updated.longInput.step, { outcome: 'error', detail: OUTPUT_LIMIT });
  // synthetic 的声明模型
  const declared = { id: 'm', family: '', contextWindow: 4000, maxTokens: 1000, reasoning: true, input: ['text'] };
  assert.equal(profiles.contextOf(declared, 4000, updated.longInput).effective, 4000);
});

test('MP-38 a reply stopped at the output limit with text or a tool call is judged, not an error', async () => {
  const P = probes.PROBE_PROMPTS;
  const atLimit = (fields) => (model) => ({ message: assistant(model, { thinking: 'Thinking.',
    signature: 'reasoning_content', stopReason: 'length', ...fields }) });
  const stream = scripted({ [P.ready]: atLimit({ text: 'ready' }),
    [P.weather]: atLimit({ toolCalls: [{ type: 'toolCall', id: 'c1', name: 'get_weather',
      arguments: { city: 'Paris', days: 3 } }] }),
    [P.temperature]: atLimit({ text: 'It was warm.' }), [P.json]: atLimit({ text: '{"outcome":"ok"}' }) });
  const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream }).deps);
  assert.deepEqual(auto.steps.ready, { outcome: 'pass', detail: null });
  assert.deepEqual(auto.steps.call, { outcome: 'pass', detail: null });
  assert.equal(auto.steps.result.outcome, 'fail', 'judged on its text, not an error');
  assert.equal(auto.steps.b.outcome, 'pass');
  assert.deepEqual(statusOfAuto(auto), { status: 'ready', error: null });
});
