// kernel/probes.ts 的单元测试（规格 §7.3、§7.4、§7.8）：两段四轮的请求、各请求的思考强度、判定、首个内容的时限、取消，
// 以及与合成端点（tests/fake-endpoint/probes.mjs）的约定一致。替身 streamSimple 只在本文件里用（synthetic）。
// 第 0 步改为调用读取器的单模型模式（docs/specs/model-discovery.md §7.1）：这里的 ProbeDeps.readServer 是替身，
// 给出读取器对合成端点默认形状读到的结果；第 0 步本身的用例按 §3.3 改写后在 tests/unit/discovery/profile-step0.test.mjs。
// 2026-10-24（§7.7，MP-38 单元层）：第 2 步判出 off_refused 时本组各请求的强度、全部请求发给没有“没有 Off”标记的副本、
// 回复停在输出上限只有思考时为出错（合成端点的 -thinklong 回复）。
// 2026-10-26（负责人走查 M7）：需要同意的第 8、9 步（长输入、取消）删掉，它们的用例（原 MP-11）同删。
// 2026-10-31（§7.8，MP-42、MP-44、MP-45 的探针部分）：请求合并成必需一段 E1–E4、后台一段 B1–B4（含图片探针 B3），同一轮
// 同时发出；首个内容的时限由依赖给出（按模型学的），收到首个内容、超时都告诉依赖。原来第 1–7 步的用例按 §7.8 的判定表改写。
// 第 2 步判定表的纯函数用例与经 pi-ai 真实组装的用例（-nooff、deepseek.com 的地址）在 probes-nooff.test.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { normalizeContext } from '@earendil-works/pi-ai';
import { loadKernelModule } from './load.mjs';
import { NOOFF_MESSAGE, probeReply, probeStep, replayRejected } from '../fake-endpoint/probes.mjs';

const probes = await loadKernelModule('src/kernel/probes.ts');
const forced = await loadKernelModule('src/kernel/forcedWrite.ts');
const profiles = await loadKernelModule('src/kernel/modelProfiles.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 第 5–7 步的取值列表（与 probes.ts 的 OUTCOMES 相同）。 */
const OK_FAIL = ['ok', 'fail'];

/** 缩短的首个内容时限：40 ms（依赖 firstTokenLimitMs 给出，§7.8）。 */
const LIMIT_MS = 40;

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
 * 替身 streamSimple：plan(model, context, options, index) 给出这次请求的结果——
 * { message } 成功；{ status, error } HTTP 错误；{ error } 连接错误（没有响应）；{ hang: true } 发出后不发内容。
 * 每次请求先经 options.fetch（模型池的 fetch 替身），记下 calls（含开始、结束的序号，看同一轮是否同时发出）。
 */
function stubStream(plan) {
  const calls = [];
  let tick = 0;
  const streamSimple = (model, context, options) => {
    const call = { model, context, options, started: tick += 1, ended: null };
    calls.push(call);
    let final;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield* answer(call, calls.length - 1);
        } finally {
          call.ended = tick += 1;
        }
      },
      result: async () => final,
    };
    async function* answer(current, index) {
      const step = await plan(model, context, options, index);
      current.plan = step;
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
    }
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

/** 探针的依赖：首个内容的时限 LIMIT_MS；记下进度、首个内容的用时、超时与 onEssentials。 */
function depsFor({ stream, pool = stubPool(), read = stubReadServer(), signal = new AbortController().signal,
  ...rest }) {
  const steps = [];
  const seen = { firstTokens: [], timeouts: [], essentials: [] };
  const deps = { streamSimple: stream.streamSimple, fetchFor: pool.fetchFor, readServer: read.readServer,
    now: () => 1000, timings: MODEL_TIMINGS, signal, onStep: (step, of) => steps.push([step, of]),
    firstTokenLimitMs: () => LIMIT_MS, onFirstToken: (ms) => seen.firstTokens.push(ms),
    onFirstTokenTimeout: (ms) => seen.timeouts.push(ms),
    onEssentials: async (auto) => { seen.essentials.push({ auto, sentBefore: stream.calls.length }); }, ...rest };
  return { deps, steps, pool, read, stream, seen };
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
function fakeEndpoint({ flags = [] } = {}) {
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
    const reply = probeReply(probeStep(body.messages), body, set);
    const toolCalls = reply.toolCalls.map((call) => ({ type: 'toolCall', id: `call_${next += 1}`, name: call.name,
      arguments: call.args }));
    if (reply.thinking && set.has('replay')) toolCalls.forEach((call) => reasoned.add(call.id));
    // -thinklong 以 finish_reason "length" 结束，pi-ai 记为 stopReason "length"（§7.7 的输出上限）
    const stopReason = reply.finishReason === 'length' ? 'length' : undefined;
    return { message: assistant(model, { text: reply.text, thinking: reply.thinking, signature: 'reasoning_content',
      toolCalls, stopReason }) };
  });
}

/** 一次请求的最后一条用户消息的文字（图片探针的内容是数组，取文字部分）。 */
function lastUserText(context) {
  const last = [...context.messages].reverse().find((message) => message.role === 'user');
  if (typeof last?.content === 'string') return last.content;
  return (last?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
}

/** 每次请求的提示与思考强度（没有 reasoning 选项记为 off）。 */
function seenOf(calls) {
  return calls.map(({ context, options }) => [lastUserText(context), options.reasoning ?? 'off']);
}

/** seenOf 排好序（同一轮同时发出的请求之间不比先后）。 */
function sortedSeen(calls) {
  return seenOf(calls).map((pair) => pair.join(' @ ')).sort();
}

/** 各步的 outcome。 */
function outcomesOf(auto) {
  return Object.fromEntries(Object.entries(auto.steps).map(([name, result]) => [name, result.outcome]));
}

/** 一个 get_weather 调用（synthetic）。 */
const weatherCall = (id = 'c1') => ({ type: 'toolCall', id, name: 'get_weather',
  arguments: { city: 'Paris', days: 3 } });

/**
 * 按提示回答的替身：answers[提示] = 计划或计划的函数；没写的提示按全通过回答（开了思考时带一段思考）。
 */
function scripted(answers) {
  const P = probes.PROBE_PROMPTS;
  return stubStream((model, context, options, index) => {
    const prompt = lastUserText(context);
    const custom = answers[prompt];
    if (custom) return typeof custom === 'function' ? custom(model, context, options, index) : custom;
    const thinking = options.reasoning ? { thinking: 'Thinking first.', signature: 'reasoning_content' } : {};
    const ok = (fields) => ({ message: assistant(model, { ...thinking, ...fields }) });
    if (prompt === P.weather) return ok({ toolCalls: [weatherCall()] });
    if (prompt === P.temperature) return ok({ text: '21°C' });
    if (prompt === P.outcome) {
      return ok({ toolCalls: [{ type: 'toolCall', id: 'c2', name: 'submit_outcome', arguments: { outcome: 'ok' } }] });
    }
    if (prompt === P.json) return ok({ text: '{"outcome":"ok"}' });
    if (prompt === P.tagged) return ok({ text: '<summary>Yes it is.</summary><outcome>ok</outcome>' });
    if (prompt === P.image) return ok({ text: 'Red.' });
    throw new Error(`unexpected prompt ${prompt.slice(0, 40)}`);
  });
}

/** 后台一段要用的必需一段结果（synthetic）：全部通过，后台各步 not_run。 */
function essentialsBase(overrides = {}) {
  const pass = { outcome: 'pass', detail: null };
  const notRun = { outcome: 'not_run', detail: null };
  return { server: { kind: 'vllm', version: '0.10.1' }, reported: null, meta: SERVER_READ.meta, field: 'none',
    steps: { ready: pass, thinking: { outcome: 'not_applicable', detail: null }, call: pass, result: pass,
      replay: { outcome: 'not_applicable', detail: null }, a: notRun, b: notRun, c: notRun, image: notRun },
    offRefused: false, phase: 'essentials', ...overrides };
}

// ---- 提示原文与合成端点的约定 ----

test('MP-10 probe prompts are the spec texts and the fake endpoint recognises each step', () => {
  const P = probes.PROBE_PROMPTS;
  assert.equal(P.ready, undefined, 'the ready prompt of steps 1 and 2 is no longer sent (§7.8)');
  assert.equal(P.weather, 'Use the tool to get the weather for Paris for the next 3 days.');
  assert.equal(P.weatherResult, 'Paris: 21°C, sunny for 3 days.');
  assert.equal(P.temperature, 'What temperature did the tool report?');
  assert.equal(P.outcome, 'Call submit_outcome with outcome banana.');
  assert.equal(P.json, 'Reply with JSON whose outcome is banana.');
  assert.equal(P.tagged, 'Answer in exactly this format: <summary>one sentence</summary><outcome>ok or fail</outcome>.'
    + ' Question: is 2 + 2 equal to 4?');
  assert.equal(P.image, 'What color is this image? Answer with one word.');
  const ask = (text) => probeStep([{ role: 'user', content: text }]);
  assert.deepEqual([P.weather, P.temperature, P.outcome, P.json, P.tagged].map(ask), [3, 4, 5, 6, 7]);
  assert.equal(probeStep([{ role: 'user', content: [{ type: 'text', text: P.image }, { type: 'image_url' }] }]), 8);
  assert.equal(ask('Reply with the single word: ready.'), 0);
});

test('MP-10 tool schemas: get_weather(city string, days integer), submit_outcome(outcome ok|fail)', () => {
  assert.equal(probes.WEATHER_TOOL.name, 'get_weather');
  assert.deepEqual(probes.WEATHER_TOOL.parameters.properties, { city: { type: 'string' }, days: { type: 'integer' } });
  assert.equal(probes.OUTCOME_TOOL.name, 'submit_outcome');
  assert.deepEqual(probes.OUTCOME_TOOL.parameters.properties.outcome, { type: 'string', enum: ['ok', 'fail'] });
});

/** 解开一张 8 位 RGB、不隔行的 PNG：宽、高与每个像素（[r, g, b]）。 */
function decodePng(base64) {
  const bytes = Buffer.from(base64, 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9] };
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const pixels = [];
  for (let y = 0; y < header.height; y += 1) {
    const row = y * (header.width * 3 + 1);
    assert.equal(raw[row], 0, 'no filter');
    for (let x = 0; x < header.width; x += 1) pixels.push([...raw.subarray(row + 1 + x * 3, row + 4 + x * 3)]);
  }
  return { ...header, pixels };
}

test('MP-44 the probe image is a 16x16 PNG whose every pixel is pure red', () => {
  assert.equal(probes.PROBE_IMAGE.mimeType, 'image/png');
  const png = decodePng(probes.PROBE_IMAGE.data);
  assert.deepEqual([png.width, png.height, png.depth, png.color], [16, 16, 8, 2]);
  assert.equal(png.pixels.length, 256);
  assert.ok(png.pixels.every(([r, g, b]) => r === 255 && g === 0 && b === 0));
});

// ---- 两段四轮（§7.8）：合成端点上的判定与请求 ----

test('MP-42 all-pass model on the fake endpoint: tool calling verified, tier A, vLLM server, image fails', async () => {
  const { deps, steps, read } = depsFor({ stream: fakeEndpoint() });
  const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
  assert.deepEqual(auto.server, { kind: 'vllm', version: '0.10.1' });
  assert.equal(auto.reported, 65536);
  // 第 0 步只经读取器（model-discovery.md §7.1），带这组探针自己的 signal；结果总带 meta（§7.2）
  assert.deepEqual(read.signals, [deps.signal]);
  assert.deepEqual(auto.meta, { maxTokens: null, reasoning: null, image: null });
  assert.deepEqual(outcomesOf(auto), { ready: 'pass', thinking: 'not_applicable', call: 'pass', result: 'pass',
    replay: 'not_applicable', a: 'pass', b: 'pass', c: 'not_run', image: 'fail' });
  assert.equal(auto.phase, 'all');
  assert.equal(auto.field, 'none');
  assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'A');
  assert.deepEqual(steps, [[1, 4], [2, 4], [3, 4]], 'rounds 1-3; round 4 only when A and B both fail');
  assert.equal(probes.PROBE_ROUNDS, 4);
});

test('MP-42 a model without thinking: essentials are E1 then E3, background B1, B2, B3 at once; 5 requests',
  async () => {
    const { deps, stream } = depsFor({ stream: fakeEndpoint() });
    await probes.runAutoProbes(targetFor(piModel()), deps);
    const P = probes.PROBE_PROMPTS;
    assert.deepEqual(seenOf(stream.calls.slice(0, 2)), [[P.weather, 'off'], [P.temperature, 'off']]);
    assert.deepEqual(sortedSeen(stream.calls.slice(2)),
      [`${P.image} @ off`, `${P.json} @ off`, `${P.outcome} @ off`].sort());
    assert.equal(stream.calls.length, 5);
    const [e1, e3, ...background] = stream.calls;
    assert.ok(e3.started > e1.ended, 'round 2 starts after round 1 ended');
    assert.ok(background.every((call) => call.started > e3.ended), 'the background starts after the essentials');
    assert.ok(background.every((call) => background.every((other) => call.started < other.ended)),
      'B1, B2 and B3 are all sent before any of them ends');
  });

test('MP-42 a thinking openai-completions model: E1 and E2 together, then E3 and E4 together; 7 requests', async () => {
  const { deps, stream } = depsFor({ stream: fakeEndpoint() });
  const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), deps);
  const P = probes.PROBE_PROMPTS;
  const [e1, e2, e3, e4] = stream.calls;
  assert.deepEqual(seenOf([e1, e2, e3, e4]), [[P.weather, 'off'], [P.weather, 'medium'], [P.temperature, 'medium'],
    [P.temperature, 'medium']]);
  assert.ok(e2.started < e1.ended && e1.started < e2.ended, 'E1 and E2 are in flight together');
  assert.ok(e3.started > Math.max(e1.ended, e2.ended) && e4.started > Math.max(e1.ended, e2.ended));
  assert.ok(e4.started < e3.ended, 'E3 and E4 are in flight together');
  assert.equal(stream.calls.length, 7);
  assert.deepEqual(outcomesOf(auto), { ready: 'pass', thinking: 'pass', call: 'pass', result: 'pass', replay: 'pass',
    a: 'pass', b: 'pass', c: 'not_run', image: 'fail' });
  assert.equal(auto.field, 'reasoning_content');
});

test('MP-42 a thinking anthropic-messages model: essentials E1, E2, E3 (no E4); background without B2', async () => {
  const { deps, stream } = depsFor({ stream: scripted({}) });
  const auto = await probes.runAutoProbes(targetFor(piModel({ api: 'anthropic-messages', reasoning: true })), deps);
  const P = probes.PROBE_PROMPTS;
  assert.deepEqual(seenOf(stream.calls.slice(0, 3)), [[P.weather, 'off'], [P.weather, 'medium'],
    [P.temperature, 'medium']]);
  assert.deepEqual(sortedSeen(stream.calls.slice(3)), [`${P.image} @ off`, `${P.outcome} @ off`].sort());
  assert.equal(auto.steps.replay.outcome, 'not_applicable');
  assert.equal(auto.steps.b.outcome, 'not_applicable');
  assert.equal(auto.field, 'native');
});

test('MP-42 at most 10 requests: a thinking model whose A and B both fail sends 7 plus 3 tagged', async () => {
  const model = piModel({ id: 'fake-coder-nochoice-noschema', reasoning: true });
  const { deps, stream, steps } = depsFor({ stream: fakeEndpoint({ flags: ['nochoice', 'noschema'] }) });
  const auto = await probes.runAutoProbes(targetFor(model), deps);
  assert.equal(stream.calls.length, 10);
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
  assert.deepEqual(steps.map(([step]) => step), [1, 2, 3, 4]);
  const tagged = stream.calls.filter(({ context }) => lastUserText(context) === probes.PROBE_PROMPTS.tagged);
  for (let i = 1; i < tagged.length; i += 1) assert.ok(tagged[i].started > tagged[i - 1].ended, 'one after another');
});

test('MP-42 step 0 runs together with round 1', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const asked = [];
  const read = { readServer: async (signal) => { asked.push(signal); await gate; return SERVER_READ; } };
  const { deps, stream } = depsFor({ stream: scripted({}), read });
  const pending = probes.runAutoProbes(targetFor(piModel()), deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asked.length, 1, 'step 0 is reading');
  assert.equal(stream.calls.length, 1, 'E1 was sent while step 0 is still reading');
  release();
  const auto = await pending;
  assert.equal(auto.steps.result.outcome, 'pass');
});

test('MP-42 the base: E2 when its call passes (E3 and E4 continue it); E1 when only E1 calls; none without a call',
  async () => {
    const P = probes.PROBE_PROMPTS;
    const model = piModel({ reasoning: true });
    const full = depsFor({ stream: scripted({}) });
    await probes.runAutoProbes(targetFor(model), full.deps);
    const [e3, e4] = full.stream.calls.filter(({ context }) => lastUserText(context) === P.temperature);
    const assistantOf = (call) => call.context.messages.find((message) => message.role === 'assistant');
    assert.ok(assistantOf(e3).content.some((block) => block.type === 'thinking'), 'E3 continues E2 with its thinking');
    assert.ok(!assistantOf(e4).content.some((block) => block.type === 'thinking'), 'E4 drops the thinking');
    const onlyOff = scripted({ [P.weather]: (m, _c, options) => (options.reasoning === 'medium'
      ? { message: assistant(m, { text: 'sunny', thinking: 'hm', signature: 'reasoning_content' }) }
      : { message: assistant(m, { toolCalls: [weatherCall()] }) }) });
    const viaOff = depsFor({ stream: onlyOff });
    const autoOff = await probes.runAutoProbes(targetFor(model), viaOff.deps);
    assert.deepEqual(seenOf(viaOff.stream.calls.slice(2, 3)), [[P.temperature, 'off']], 'E3 continues E1 with off');
    assert.equal(viaOff.stream.calls.filter(({ context }) => lastUserText(context) === P.temperature).length, 1);
    assert.deepEqual(autoOff.steps.replay, { outcome: 'not_run',
      detail: 'The thinking request did not produce a valid call' });
    assert.equal(autoOff.steps.result.outcome, 'pass');
    const none = scripted({ [P.weather]: (m) => ({ message: assistant(m, { text: 'It is sunny.' }) }) });
    const viaNone = depsFor({ stream: none });
    const autoNone = await probes.runAutoProbes(targetFor(model), viaNone.deps);
    assert.equal(viaNone.stream.calls.length, 2, 'no round 2 and no background');
    assert.deepEqual(autoNone.steps.result, { outcome: 'not_run',
      detail: 'No request produced a valid get_weather call' });
    assert.equal(profiles.toolCallingOf(autoNone.steps.call, autoNone.steps.result), 'failed');
  });

test('MP-42 ready: pass when E1 and E2 both answer; an error is an error (E2’s first); no answer is a fail', () => {
  const m = piModel();
  const reply = (fields) => ({ message: assistant(m, fields), error: null, status: 200, content: true });
  const failed = (error, status = 500) => ({ message: null, error, status, content: false });
  const call = reply({ toolCalls: [weatherCall()] });
  assert.deepEqual(probes.judgeReady([call, reply({ text: 'sunny' })]), { outcome: 'pass', detail: null });
  assert.deepEqual(probes.judgeReady([call, failed('500 E2')]), { outcome: 'error', detail: '500 E2' });
  assert.deepEqual(probes.judgeReady([failed('500 E1'), call]), { outcome: 'error', detail: '500 E1' });
  assert.deepEqual(probes.judgeReady([failed('500 E1'), failed('500 E2')]), { outcome: 'error', detail: '500 E2' });
  assert.deepEqual(probes.judgeReady([reply({ thinking: 'only thinking' })]),
    { outcome: 'fail', detail: 'The reply has no text or tool call' });
  assert.equal(probes.answered(call), true);
  assert.equal(probes.answered(reply({ thinking: 'x' })), false);
});

test('MP-42 essentials are stored before the background: onEssentials gets phase essentials, background not_run',
  async () => {
    const { deps, stream, seen } = depsFor({ stream: fakeEndpoint() });
    const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
    assert.equal(seen.essentials.length, 1);
    const [{ auto: stored, sentBefore }] = seen.essentials;
    assert.equal(sentBefore, 2, 'stored after E1 and E3, before any background request');
    assert.equal(stored.phase, 'essentials');
    assert.deepEqual(['a', 'b', 'c', 'image'].map((name) => stored.steps[name].outcome), Array(4).fill('not_run'));
    assert.equal(profiles.toolCallingOf(stored.steps.call, stored.steps.result), 'verified');
    assert.equal(auto.phase, 'all');
    assert.deepEqual(auto.steps.call, stored.steps.call);
  });

test('MP-42 tool calling not verified: no background round, no onEssentials, background steps not_run, phase all',
  async () => {
    const { deps, stream, seen } = depsFor({ stream: fakeEndpoint({ flags: ['notools'] }) });
    const auto = await probes.runAutoProbes(targetFor(piModel({ id: 'fake-coder-notools' })), deps);
    assert.equal(stream.calls.length, 1, 'only E1');
    assert.equal(seen.essentials.length, 0);
    assert.equal(auto.phase, 'all');
    assert.deepEqual(['a', 'b', 'c', 'image'].map((name) => auto.steps[name].outcome), Array(4).fill('not_run'));
    assert.equal(auto.steps.call.outcome, 'fail');
    assert.equal(auto.steps.result.outcome, 'not_run');
  });

test('MP-42 runBackgroundProbes sends only the background round on the stored base and returns phase all',
  async () => {
    const { deps, stream, steps } = depsFor({ stream: fakeEndpoint() });
    const base = essentialsBase();
    const auto = await probes.runBackgroundProbes(targetFor(piModel()), deps, base);
    const P = probes.PROBE_PROMPTS;
    assert.deepEqual(sortedSeen(stream.calls), [`${P.image} @ off`, `${P.json} @ off`, `${P.outcome} @ off`].sort());
    assert.deepEqual(steps, [[3, 4]]);
    assert.equal(auto.phase, 'all');
    assert.deepEqual(auto.steps.call, base.steps.call);
    assert.equal(auto.steps.a.outcome, 'pass');
    const refused = depsFor({ stream: scripted({}) });
    await probes.runBackgroundProbes(targetFor(piModel({ reasoning: true })), refused.deps,
      essentialsBase({ offRefused: true }));
    assert.deepEqual(sortedSeen(refused.stream.calls), [`${P.image} @ medium`, `${P.json} @ medium`].sort(),
      'the stored off_refused picks medium and skips B1');
  });

// ---- 原来第 1–7 步的用例，按 §7.8 的判定表 ----

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

test('MP-10 thinking per request: E1 off, E2 medium, E3 and E4 medium, B1 off, B2 B3 B4 off', async () => {
  const model = piModel({ id: 'fake-coder-nochoice-noschema', reasoning: true });
  const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['nochoice', 'noschema'] }) });
  await probes.runAutoProbes(targetFor(model), deps);
  const P = probes.PROBE_PROMPTS;
  assert.deepEqual(seenOf(stream.calls.slice(0, 4)), [[P.weather, 'off'], [P.weather, 'medium'],
    [P.temperature, 'medium'], [P.temperature, 'medium']]);
  assert.deepEqual(sortedSeen(stream.calls.slice(4, 7)), [`${P.image} @ off`, `${P.json} @ off`,
    `${P.outcome} @ off`].sort());
  assert.deepEqual(seenOf(stream.calls.slice(7)), [[P.tagged, 'off'], [P.tagged, 'off'], [P.tagged, 'off']]);
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
  // §7.7：全部请求发给没有“没有 Off”标记的副本（这里没有标记，副本与注册的模型内容相同）
  assert.deepEqual(withThinking.model, model);
  assert.equal(without.model.compat.requiresReasoningContentOnAssistantMessages, false);
  assert.equal(without.model.id, model.id);
  assert.equal(model.compat, undefined, 'the registered model is not changed');
  assert.equal(auto.steps.call.outcome, 'pass', 'E1 is not affected by -replay');
  assert.equal(auto.steps.result.outcome, 'pass', 'E3 carries the reasoning, so it passes');
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

test('MP-10 step 4 (E3) sends the call, the tool result and the question; fails without 21', async () => {
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
  assert.deepEqual(autoHttp.steps.ready, { outcome: 'error', detail: '500 Internal Server Error' });
  assert.equal(autoHttp.steps.result.outcome, 'not_run');
  assert.equal(profiles.toolCallingOf(autoHttp.steps.call, autoHttp.steps.result), 'unverified');
  const connection = scripted({ [P.temperature]: { error: 'Connection error.' } });
  const autoConn = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream: connection }).deps);
  assert.deepEqual(autoConn.steps.result, { outcome: 'error', detail: 'Connection error.' });
  assert.equal(profiles.toolCallingOf(autoConn.steps.call, autoConn.steps.result), 'unverified');
});

test('MP-45 probe first-content limit comes from the deps; a timeout aborts the attempt and is reported', async () => {
  const P = probes.PROBE_PROMPTS;
  const stream = scripted({ [P.weather]: { hang: true } });
  const { deps, pool, seen } = depsFor({ stream });
  const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
  assert.deepEqual(auto.steps.ready, { outcome: 'error', detail: 'No response within 0.04 s' });
  assert.deepEqual(auto.steps.call, { outcome: 'error', detail: 'No response within 0.04 s' });
  assert.equal(pool.requests[0].attemptSignal.aborted, true);
  assert.deepEqual(seen.timeouts, [LIMIT_MS], 'the timeout is reported with the limit used');
  assert.deepEqual(seen.firstTokens, []);
  const limits = [];
  const slower = depsFor({ stream: scripted({}), firstTokenLimitMs: () => { limits.push(5000); return 5000; } });
  await probes.runAutoProbes(targetFor(piModel()), slower.deps);
  assert.equal(limits.length, slower.stream.calls.length, 'every request asks for the current limit');
});

test('MP-45 probe first-content time counts from onSent, not from queueing, and every answer reports it', async () => {
  const { deps, seen, stream } = depsFor({ stream: scripted({}), pool: stubPool({ delayMs: 100 }),
    firstTokenLimitMs: () => 5000 });
  const auto = await probes.runAutoProbes(targetFor(piModel()), deps);
  assert.equal(auto.steps.ready.outcome, 'pass');
  assert.equal(auto.steps.call.outcome, 'pass');
  assert.equal(seen.firstTokens.length, stream.calls.length);
  assert.ok(seen.firstTokens.every((ms) => ms >= 0 && ms < 100), JSON.stringify(seen.firstTokens));
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

test('MP-10 a 5xx, 401, 429 or connection error on step 5 is an error: step 7 not run, protocol_write unverified',
  async () => {
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
  let tags = 0;
  const stream = scripted({ [P.outcome]: bad, [P.json]: bad,
    [P.tagged]: (model) => ({ message: assistant(model,
      { text: (tags += 1) % 2 === 0 ? 'Yes.' : '<summary>Yes.</summary><outcome>ok</outcome>' }) }) });
  const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream }).deps);
  assert.equal(auto.steps.c.outcome, 'fail');
  assert.equal(stream.calls.filter(({ context }) => lastUserText(context) === P.tagged).length, 2);
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

test('MP-10 replay: an E2 error while the base is E1 is an error; E3 and E4 failing to connect is an error',
  async () => {
    const P = probes.PROBE_PROMPTS;
    const model = piModel({ reasoning: true });
    const e2Fails = scripted({ [P.weather]: (m, _c, options) => (options.reasoning === 'medium'
      ? { error: 'Connection error.' } : { message: assistant(m, { toolCalls: [weatherCall()] }) }) });
    const autoA = await probes.runAutoProbes(targetFor(model), depsFor({ stream: e2Fails }).deps);
    assert.deepEqual(autoA.steps.replay, { outcome: 'error', detail: 'Connection error.' });
    assert.equal(profiles.reasoningOf('openai-completions', autoA).replay, 'unknown');
    assert.equal(profiles.toolCallingOf(autoA.steps.call, autoA.steps.result), 'verified', 'E1 and E3 at off');
    const failing = scripted({ [P.temperature]: { error: 'Connection error.' } });
    const autoB = await probes.runAutoProbes(targetFor(model), depsFor({ stream: failing }).deps);
    assert.deepEqual(autoB.steps.replay, { outcome: 'error', detail: 'Connection error.' });
  });

test('MP-10 can_disable is false when thinking off still returns thinking', async () => {
  const P = probes.PROBE_PROMPTS;
  const stream = scripted({ [P.weather]: (m) => ({ message: assistant(m, { toolCalls: [weatherCall()],
    thinking: 'hmm', signature: 'reasoning' }) }) });
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

test('MP-10 judging functions: JSON outcome, outcome call, tagged format', () => {
  const m = piModel();
  const reply = (fields) => ({ message: assistant(m, fields), error: null, status: 200, content: true });
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

// ---- 图片探针 B3（§7.8，MP-44） ----

test('MP-44 judgeImage: red in the answer passes, other text fails, 400 and 422 fail with the text, 500 is an error',
  () => {
    const m = piModel();
    const reply = (text) => ({ message: assistant(m, { text }), error: null, status: 200, content: true });
    const failed = (error, status) => ({ message: null, error, status, content: false });
    assert.deepEqual(probes.judgeImage(reply('Red.')), { outcome: 'pass', detail: null });
    assert.deepEqual(probes.judgeImage(reply('It is RED')), { outcome: 'pass', detail: null });
    assert.deepEqual(probes.judgeImage(reply('I can’t see any image.')),
      { outcome: 'fail', detail: 'The answer does not name the color of the image' });
    for (const status of [400, 422]) {
      const text = `${status} image input is not supported`;
      assert.deepEqual(probes.judgeImage(failed(text, status)), { outcome: 'fail', detail: text });
    }
    assert.deepEqual(probes.judgeImage(failed('500 Internal Server Error', 500)),
      { outcome: 'error', detail: '500 Internal Server Error' });
  });

test('MP-44 B3 goes to a copy whose input has image, carries the PNG, and uses this set’s thinking level',
  async () => {
    const model = Object.freeze(piModel());
    const { deps, stream } = depsFor({ stream: scripted({}) });
    const auto = await probes.runAutoProbes(targetFor(model), deps);
    assert.equal(auto.steps.image.outcome, 'pass');
    const call = stream.calls.find(({ context }) => lastUserText(context) === probes.PROBE_PROMPTS.image);
    assert.deepEqual(call.model.input, ['text', 'image']);
    assert.deepEqual(model.input, ['text'], 'the registered model is not changed');
    const content = call.context.messages[0].content;
    assert.deepEqual(content.find((part) => part.type === 'image'),
      { type: 'image', data: probes.PROBE_IMAGE.data, mimeType: 'image/png' });
    assert.equal(call.options.reasoning, undefined, 'off without off_refused');
    assert.deepEqual(probes.withImageInput(model).input, ['text', 'image']);
  });

// ---- 三种接口的请求写法：用 pi-ai 真实的组装，替身 fetch 截下请求体 ----

/** 用 pi-ai 的接口模块组装后台一段的请求、替身 fetch 截下请求体（一律回 400）。 */
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
    options), calls: [] };
  const { deps } = depsFor({ stream, pool: { fetchFor } });
  await probes.runBackgroundProbes(targetFor(piModel({ api })), deps, essentialsBase());
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

test('MP-44 openai-completions payload of B3: the image goes out as an image_url data URL, not a placeholder',
  async () => {
    const bodies = await capturedBodies('openai-completions');
    const image = bodies.find((body) => bodyHas(body, 'What color is this image?'));
    const parts = image.messages.at(-1).content;
    assert.ok(Array.isArray(parts), JSON.stringify(image.messages.at(-1)));
    const url = parts.find((part) => part.type === 'image_url')?.image_url?.url;
    assert.equal(url, `data:image/png;base64,${probes.PROBE_IMAGE.data}`);
    assert.ok(!bodyHas(image, 'image omitted'));
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
    return { message: assistant(model, { toolCalls: [weatherCall()] }) };
  } });
  const { deps, seen } = depsFor({ stream, signal: controller.signal });
  assert.equal(await probes.runAutoProbes(targetFor(piModel()), deps), null);
  assert.ok(!stream.calls.some(({ context }) => lastUserText(context) === P.temperature));
  assert.equal(seen.essentials.length, 0);
});

test('MP-10 a probe set cancelled during step 0 returns null and sends nothing after round 1', async () => {
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
  assert.ok(stream.calls.length <= 1, 'at most E1, sent together with step 0');
});

// ---- §7.7 思考关不掉的模型（MP-38），按 §7.8 的 E1（off）、E2（medium） ----
// 本节的错误原文、回复、模型与档案除标明出自规格的以外都是 synthetic。

/** -nooff 关闭思考被拒的原文（合成端点 probes.mjs 的 NOOFF_MESSAGE 加状态前缀；synthetic）。 */
const OFF_REFUSED_TEXT = `400 ${NOOFF_MESSAGE}`;

/** §7.7 输出上限那一句（规格原文）。 */
const OUTPUT_LIMIT = 'Stopped at the probe output limit before answering';

/** 第 2 步（E1、E2）的计划：不带思考的是 off，带的是 medium。off、medium 是计划或计划的函数（参数为模型）。 */
function stepTwo(off, medium) {
  return (model, _context, options) => {
    const plan = options.reasoning === undefined ? off : medium;
    return typeof plan === 'function' ? plan(model) : plan;
  };
}

/** 有工具调用与思考的 medium 回复（synthetic）。 */
const mediumCall = (model) => ({ message: assistant(model, { toolCalls: [weatherCall()], thinking: 'Thinking first.',
  signature: 'reasoning_content' }) });

/** 只有思考、停在输出上限的回复（synthetic）。 */
const thinkingOnlyAtLimit = (model) => ({ message: assistant(model, { thinking: 'Still thinking.',
  signature: 'reasoning_content', stopReason: 'length' }) });

/** 档案的 status（statusOf 只看 auto）。 */
function statusOfAuto(auto) {
  return profiles.statusOf({ auto });
}

test('MP-38 step 2 via runAutoProbes: off refused with 400 or 422 and medium answered is a fail, off_refused true',
  async () => {
    const P = probes.PROBE_PROMPTS;
    for (const off of [{ status: 400, error: OFF_REFUSED_TEXT },
      // synthetic 的 422 原文
      { status: 422, error: '422 Thinking cannot be disabled for this model' }]) {
      const stream = scripted({ [P.weather]: stepTwo(off, mediumCall) });
      const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), depsFor({ stream }).deps);
      assert.deepEqual(auto.steps.thinking, { outcome: 'fail', detail: `Thinking can’t be turned off: ${off.error}` });
      assert.equal(auto.offRefused, true);
      assert.deepEqual(auto.steps.ready, { outcome: 'pass', detail: null }, 'only E2 counts for ready');
      assert.deepEqual(auto.steps.call, { outcome: 'pass', detail: null }, 'the call is judged on E2');
      assert.deepEqual(profiles.reasoningOf('openai-completions', auto),
        { field: 'reasoning_content', can_disable: false, replay: 'not_required', off_refused: true });
      // 不算出错：档案不因此为 error
      assert.deepEqual(statusOfAuto(auto), { status: 'ready', error: null });
    }
  });

test('MP-38 step 2 via runAutoProbes: off refused and medium errored or without an answer is an error', async () => {
  const P = probes.PROBE_PROMPTS;
  const off = { status: 400, error: OFF_REFUSED_TEXT };
  const noAnswer = (model) => ({ message: assistant(model, { thinking: 'Only thinking.' }) });
  // medium 出错时用它的说明（含输出上限那一句）；medium 没出错但没有回答时用 off 的原文
  const cases = [[{ status: 500, error: '500 Internal Server Error' }, '500 Internal Server Error'],
    [{ error: 'Connection error.' }, 'Connection error.'], [thinkingOnlyAtLimit, OUTPUT_LIMIT],
    [noAnswer, OFF_REFUSED_TEXT]];
  for (const [medium, detail] of cases) {
    const stream = scripted({ [P.weather]: stepTwo(off, medium) });
    const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), depsFor({ stream }).deps);
    assert.deepEqual(auto.steps.thinking, { outcome: 'error', detail }, detail);
    assert.equal(auto.offRefused, false);
    assert.equal(profiles.reasoningOf('openai-completions', auto).can_disable, 'unknown');
    assert.equal(profiles.reasoningOf('openai-completions', auto).off_refused, false);
    assert.deepEqual(statusOfAuto(auto), { status: 'error', error: detail });
    // 没判出 off_refused：call 按 E1（被拒）判，tool calling 没验证，后台一段不跑
    assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'unverified');
    assert.ok(!stream.calls.some(({ context }) => lastUserText(context) === P.outcome), 'no background round');
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
    // medium 有回答也不改变判定：只有 400、422 才算关闭思考被拒
    const stream = scripted({ [P.weather]: stepTwo(off, mediumCall) });
    const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), depsFor({ stream }).deps);
    assert.deepEqual(auto.steps.thinking, { outcome: 'error', detail }, detail);
    assert.equal(auto.offRefused, false, detail);
    assert.equal(profiles.reasoningOf('openai-completions', auto).off_refused, false);
    assert.equal(profiles.reasoningOf('openai-completions', auto).can_disable, 'unknown');
  }
});

test('MP-38 off_refused: E3, E4, B2, B3, B4 use medium, B1 is not applicable and not sent, B4 runs', async () => {
  const P = probes.PROBE_PROMPTS;
  const bad = (model) => ({ message: assistant(model, { text: 'banana' }) });
  const stream = scripted({ [P.weather]: stepTwo({ status: 400, error: OFF_REFUSED_TEXT }, mediumCall),
    [P.json]: bad });
  const { deps, steps } = depsFor({ stream });
  const auto = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })), deps);
  assert.equal(auto.offRefused, true);
  assert.deepEqual(seenOf(stream.calls.slice(0, 4)), [[P.weather, 'off'], [P.weather, 'medium'],
    [P.temperature, 'medium'], [P.temperature, 'medium']]);
  assert.deepEqual(sortedSeen(stream.calls.slice(4, 6)), [`${P.image} @ medium`, `${P.json} @ medium`].sort());
  assert.deepEqual(seenOf(stream.calls.slice(6)), [[P.tagged, 'medium'], [P.tagged, 'medium'], [P.tagged, 'medium']]);
  assert.ok(!stream.calls.some(({ context }) => lastUserText(context) === P.outcome), 'B1 (step 5) is not sent');
  assert.deepEqual(auto.steps.a, { outcome: 'not_applicable', detail: null });
  assert.equal(auto.steps.b.outcome, 'fail');
  assert.deepEqual(auto.steps.c, { outcome: 'pass', detail: null });
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
  assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
  assert.deepEqual(steps.map(([step]) => step), [1, 2, 3, 4], 'progress for every round');
  // B4 照样判定：标签不对时为不通过，三级都没有
  const failing = scripted({ [P.weather]: stepTwo({ status: 400, error: OFF_REFUSED_TEXT }, mediumCall),
    [P.json]: bad, [P.tagged]: bad });
  const autoFail = await probes.runAutoProbes(targetFor(piModel({ reasoning: true })),
    depsFor({ stream: failing }).deps);
  assert.equal(autoFail.steps.c.outcome, 'fail');
  assert.equal(profiles.protocolWriteOf(autoFail.steps.a, autoFail.steps.b, autoFail.steps.c), 'failed');
});

test('MP-38 off_refused on anthropic-messages: B1 and B2 not applicable, B4 runs with medium', async () => {
  const P = probes.PROBE_PROMPTS;
  // synthetic 的 400 原文
  const stream = scripted({ [P.weather]: stepTwo({ status: 400, error: '400 thinking must be enabled' },
    mediumCall) });
  const auto = await probes.runAutoProbes(targetFor(piModel({ api: 'anthropic-messages', reasoning: true })),
    depsFor({ stream }).deps);
  assert.equal(auto.offRefused, true);
  assert.deepEqual(seenOf(stream.calls), [[P.weather, 'off'], [P.weather, 'medium'], [P.temperature, 'medium'],
    [P.image, 'medium'], [P.tagged, 'medium'], [P.tagged, 'medium'], [P.tagged, 'medium']]);
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

test('MP-38 every request goes to a copy without the no-Off marker; the target is untouched', async () => {
  const marked = frozen(piModel({ reasoning: true, thinkingLevelMap: { off: null } }));
  const before = structuredClone(marked);
  const { deps, stream } = depsFor({ stream: fakeEndpoint() });
  const auto = await probes.runAutoProbes(targetFor(marked), deps);
  assert.equal(auto.steps.replay.outcome, 'pass', 'the replay check ran');
  for (const { model } of stream.calls) {
    assert.notEqual(model, marked, 'never the registered model itself');
    assert.equal('thinkingLevelMap' in model, false, 'the copy has no thinkingLevelMap left');
    for (const field of ['id', 'api', 'provider', 'baseUrl', 'reasoning', 'contextWindow', 'maxTokens']) {
      assert.equal(model[field], marked[field], field);
    }
  }
  assert.equal(stream.calls.length, 7);
  assert.deepEqual(marked, before, 'the target model is not changed');
  assert.deepEqual(marked.thinkingLevelMap, { off: null });
});

test('MP-38 a marked model whose step 2 finds it can disable thinking: E1, B1, B2, B3, B4 are sent with off',
  async () => {
    const P = probes.PROBE_PROMPTS;
    const model = piModel({ id: 'fake-coder-nochoice-noschema', reasoning: true, thinkingLevelMap: { off: null } });
    const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['nochoice', 'noschema'] }) });
    const auto = await probes.runAutoProbes(targetFor(model), deps);
    assert.deepEqual(auto.steps.thinking, { outcome: 'pass', detail: null });
    assert.equal(auto.offRefused, false);
    assert.deepEqual(seenOf(stream.calls.slice(0, 4)), [[P.weather, 'off'], [P.weather, 'medium'],
      [P.temperature, 'medium'], [P.temperature, 'medium']]);
    assert.deepEqual(sortedSeen(stream.calls.slice(4, 7)), [`${P.image} @ off`, `${P.json} @ off`,
      `${P.outcome} @ off`].sort());
    assert.deepEqual(seenOf(stream.calls.slice(7)), [[P.tagged, 'off'], [P.tagged, 'off'], [P.tagged, 'off']]);
    // 思考 off = 不带 reasoning 选项（pi 的三种接口都把它当作关闭思考）
    const offCalls = stream.calls.filter(({ options }) => options.reasoning === undefined);
    assert.ok(offCalls.every(({ options }) => !('reasoning' in options)));
    assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'C');
    // 这一次判出能关闭：档案不再要求标记
    assert.deepEqual(profiles.compileFlagsOf('openai-completions', auto), { replayRequired: false, offRefused: false });
  });

test('MP-38 -thinklong: a thinking-only reply stopped at the output limit makes the step an error', async () => {
  const model = piModel({ id: 'fake-coder-thinklong', reasoning: true });
  const { deps, stream } = depsFor({ stream: fakeEndpoint({ flags: ['thinklong'] }) });
  const auto = await probes.runAutoProbes(targetFor(model), deps);
  assert.equal(probes.OUTPUT_LIMIT_TEXT, OUTPUT_LIMIT);
  const limit = { outcome: 'error', detail: OUTPUT_LIMIT };
  assert.deepEqual(auto.steps.ready, limit, 'E2 (medium) stops at the limit');
  assert.deepEqual(auto.steps.replay, limit, 'the replay check has no thinking base, E2 stopped at the limit');
  assert.equal(auto.steps.thinking.outcome, 'pass', 'off answers without thinking');
  assert.equal(auto.offRefused, false);
  assert.equal(profiles.toolCallingOf(auto.steps.call, auto.steps.result), 'verified');
  assert.equal(profiles.tierOf(auto.steps.a, auto.steps.b, auto.steps.c), 'A');
  assert.deepEqual(statusOfAuto(auto), { status: 'error', error: OUTPUT_LIMIT });
  // 停在上限的消息保留下来，推理字段名仍从中读出
  assert.equal(auto.field, 'reasoning_content');
  const e2 = stream.calls[1];
  assert.equal(e2.plan.message.stopReason, 'length');
  assert.ok(!e2.plan.message.content.some((block) => block.type === 'text'), 'the reply had only thinking');
});

test('MP-38 a reply stopped at the output limit with text or a tool call is judged, not an error', async () => {
  const P = probes.PROBE_PROMPTS;
  const atLimit = (fields) => (model) => ({ message: assistant(model, { thinking: 'Thinking.',
    signature: 'reasoning_content', stopReason: 'length', ...fields }) });
  const stream = scripted({ [P.weather]: atLimit({ toolCalls: [weatherCall()] }),
    [P.temperature]: atLimit({ text: 'It was 21°C.' }), [P.json]: atLimit({ text: '{"outcome":"ok"}' }) });
  const auto = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream }).deps);
  assert.deepEqual(auto.steps.ready, { outcome: 'pass', detail: null });
  assert.deepEqual(auto.steps.call, { outcome: 'pass', detail: null });
  assert.equal(auto.steps.result.outcome, 'pass');
  assert.equal(auto.steps.b.outcome, 'pass');
  assert.deepEqual(statusOfAuto(auto), { status: 'ready', error: null });
  const warm = scripted({ [P.temperature]: atLimit({ text: 'It was warm.' }) });
  const autoWarm = await probes.runAutoProbes(targetFor(piModel()), depsFor({ stream: warm }).deps);
  assert.equal(autoWarm.steps.result.outcome, 'fail', 'judged on its text, not an error');
});
