// 探针第 0 步经读取器的单模型模式（docs/specs/model-discovery.md §7.1、§7.2；§13.2 MD-12 单元层），以及从
// tests/unit/probes.test.mjs 移来、按 §3.3 改写的第 0 步用例（§13.4：名字仍以 MP-10、MP-12 开头）：
// 已有提供商只发 <baseUrl>/models，种类按 §3.3（不再只凭 /version 认 vLLM），版本按 §3.3 的读法。
// 合成端点的形状来自 tests/fake-endpoint/discovery.mjs，响应体样本来自 tests/fixtures/discovery/bodies/（都是 synthetic，
// 依据见那里的 README.md）；pi 的 streamSimple 是替身（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  captureConsole, deferred, empty, existing, json, providerRequest, readerWith, sampleFetch, settle, shapeFetch,
  stubFetch,
} from './io-helpers.mjs';

const { DiscoverReader } = await loadKernelModule('src/kernel/modelDiscover.ts');
const probes = await loadKernelModule('src/kernel/probes.ts');
const P = await loadKernelModule('src/kernel/modelProfiles.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

const NO_META = { maxTokens: null, reasoning: null, image: null };
const signal = () => new AbortController().signal;

/** @brief 已有提供商 base 的第 0 步（§7.1）。 */
function stepZero(stub, base, modelId, options = {}) {
  return readerWith(DiscoverReader, stub.fetch, options).single(existing(base), modelId, signal());
}

/** @brief 只认列表与版本接口的替身：bodies 为 路径 → JSON，没有的为 404。 */
function bodiesFetch(bodies) {
  return stubFetch((call) => (call.path in bodies ? json(bodies[call.path]) : empty(404)));
}

/** pi 的 streamSimple 替身（synthetic）：每个请求立即以连接错误结束，第 1–7 步因此为 error，第 0 步照常。 */
function failingStream(model) {
  const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: 'Connection error.', timestamp: 1 };
  return {
    async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'error', error: message }; },
    result: async () => message,
  };
}

/**
 * @brief 跑自动探针（第 0–7 步），第 0 步的 readServer 是读取器的单模型模式（同 modelLayer.ts 的接线）。
 * @return runAutoProbes 的结果
 */
function autoProbes(reader, target, modelId) {
  const model = { id: modelId, name: modelId, api: 'openai-completions', provider: 'local', baseUrl: target.base,
    input: ['text'], reasoning: false, contextWindow: 131072, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const deps = { streamSimple: failingStream, fetchFor: () => globalThis.fetch,
    readServer: (readSignal) => reader.single(target, modelId, readSignal), now: () => 1000,
    timings: MODEL_TIMINGS, signal: signal() };
  return probes.runAutoProbes({ ref: `local/${modelId}`, model }, deps);
}

// ---- 从 probes.test.mjs 移来的第 0 步（§13.4） ----

test('MP-10 step 0 GETs <baseUrl>/models, then the §3.3 step 6 GETs when the list decides nothing', async (t) => {
  const lines = captureConsole(t);
  const stub = stubFetch(() => empty(404));
  const info = await stepZero(stub, 'http://10.0.0.5:8000/v1/', 'qwen');
  assert.deepEqual(info, { kind: 'unknown', version: null, reported: null, meta: NO_META });
  assert.deepEqual(stub.calls.map((call) => call.url).sort(), ['http://10.0.0.5:8000/.well-known/localai.json',
    'http://10.0.0.5:8000/api/v1/models', 'http://10.0.0.5:8000/api/version', 'http://10.0.0.5:8000/info',
    'http://10.0.0.5:8000/props', 'http://10.0.0.5:8000/v1/models']);
  assert.ok(!stub.calls.some((call) => call.path === '/version'), 'unknown has no version request');
  assert.ok(lines.some((line) => line.includes('probe step 0 listError=no_list')), lines.join('\n'));
});

test('MP-10 step 0 server kinds by §3.3: vLLM and SGLang by owned_by, Ollama, llama.cpp, unknown', async (t) => {
  captureConsole(t);
  const base = 'http://10.0.0.6:8000/v1';
  const list = (ownedBy, extra = {}) => ({ object: 'list', data: [{ id: 'q', owned_by: ownedBy, ...extra }] });
  const vllm = await stepZero(bodiesFetch({ '/v1/models': list('vllm', { max_model_len: 32768 }),
    '/version': { version: '0.10.1' } }), base, 'q');
  assert.deepEqual(vllm, { kind: 'vllm', version: '0.10.1', reported: 32768, meta: NO_META });
  const sglang = await stepZero(bodiesFetch({ '/v1/models': list('sglang'), '/version': { version: '0.4.9' } }),
    base, 'q');
  assert.deepEqual(sglang, { kind: 'sglang', version: '0.4.9', reported: null, meta: NO_META });
  // /api/version 有 version，且列表行有 owned_by 与 created（§3.3 第 6 步）
  const ollama = await stepZero(bodiesFetch({ '/v1/models': list('library', { created: 1790000000 }),
    '/api/version': { version: '0.9.0' } }), base, 'q');
  assert.deepEqual(ollama, { kind: 'ollama', version: '0.9.0', reported: null, meta: NO_META });
  const llamacpp = await stepZero(bodiesFetch({ '/v1/models': { data: [{ id: 'q' }] },
    '/props': { default_generation_settings: { n_ctx: 8192 }, build_info: 'b5000-abc' } }), base, 'q');
  assert.deepEqual(llamacpp, { kind: 'llamacpp', version: 'b5000-abc', reported: 8192, meta: NO_META });
  // /props 没有 build_info 时不是 llama.cpp（§3.3 第 6 步），顶层的 n_ctx 也不是 §4.1 的路径
  const props = await stepZero(bodiesFetch({ '/v1/models': { data: [{ id: 'q' }] }, '/props': { n_ctx: 4096 } }),
    base, 'q');
  assert.deepEqual(props, { kind: 'unknown', version: null, reported: null, meta: NO_META });
  const missing = await stepZero(bodiesFetch({ '/v1/models': { data: [{ id: 'other', max_model_len: 1 }] } }),
    base, 'q');
  assert.deepEqual(missing, { kind: 'unknown', version: null, reported: null, meta: NO_META });
});

test('MP-10 a /version answer alone no longer makes vLLM: owned_by "fake" with /version is unknown', async (t) => {
  captureConsole(t);
  const stub = bodiesFetch({ '/v1/models': { object: 'list',
    data: [{ id: 'fake-coder', owned_by: 'fake', max_model_len: 65536 }] }, '/version': { version: '0.10.1' } });
  const info = await stepZero(stub, 'http://127.0.0.1:4319/v1', 'fake-coder');
  assert.deepEqual(info, { kind: 'unknown', version: null, reported: 65536, meta: NO_META });
  assert.ok(!stub.calls.some((call) => call.path === '/version'), 'no version request for unknown');
  // 合成端点的默认形状把 owned_by 改成了 vllm（§13.1）：认作 vLLM，版本照旧读 /version
  const fixed = await stepZero(shapeFetch({ maxModelLen: 65536 }), 'http://127.0.0.1:4319/v1', 'fake-coder');
  assert.deepEqual(fixed, { kind: 'vllm', version: '0.10.1', reported: 65536, meta: NO_META });
  const blank = await stepZero(bodiesFetch({ '/v1/models': { data: [{ id: 'q', owned_by: 'vllm' }] },
    '/version': { version: '' } }), 'http://10.0.0.7:8000/v1', 'q');
  assert.equal(blank.version, null, 'an empty version is no version');
});

test('MP-12 a server without a version gives profile version unknown and an unchanged profile key', async (t) => {
  captureConsole(t);
  const stub = bodiesFetch({ '/v1/models': { object: 'list',
    data: [{ id: 'fake-coder', owned_by: 'vllm', max_model_len: 65536 }] } });
  const target = existing('http://127.0.0.1:4319/v1');
  const auto = await autoProbes(readerWith(DiscoverReader, stub.fetch), target, 'fake-coder');
  assert.deepEqual(auto.server, { kind: 'vllm', version: 'unknown' });
  assert.equal(auto.reported, 65536);
  const profileTarget = { baseUrl: target.base, api: 'openai-completions', compat: {},
    model: { id: 'fake-coder', family: '', contextWindow: 131072, maxTokens: 16384, reasoning: false,
      input: ['text'] } };
  const stored = P.buildProfile({ target: profileTarget, auto, now: 1 });
  assert.equal(stored.key, 'http://127.0.0.1:4319/v1|openai-completions|fake-coder|unknown');
});

// ---- MD-12：第 0 步经读取器得出种类、窗口与 meta ----

test('MD-12 step 0 on the sglang shape: kind, version, window and meta from /model_info', async (t) => {
  captureConsole(t);
  const stub = shapeFetch({ shape: 'sglang' });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing('http://127.0.0.1:4320/v1');
  const read = await reader.single(target, 'fake-coder', signal());
  assert.deepEqual(read, { kind: 'sglang', version: '0.10.1', reported: 131072,
    meta: { maxTokens: null, reasoning: true, image: false } });
  assert.equal(stub.calls.filter((call) => call.path === '/model_info').length, 1);
  const auto = await autoProbes(reader, target, 'fake-coder');
  assert.deepEqual(auto.server, { kind: 'sglang', version: '0.10.1' });
  assert.equal(auto.reported, 131072);
  assert.deepEqual(auto.meta, { maxTokens: null, reasoning: true, image: false });
});

test('MD-12 step 0 on the ollama shape: /api/ps and num_ctx are reported, the trained window is not', async (t) => {
  captureConsole(t);
  const stub = shapeFetch({ shape: 'ollama', models: ['fake-coder', 'fake-slow', 'fake-third'] });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing('http://127.0.0.1:4321/v1');
  const first = await reader.single(target, 'fake-coder', signal());
  assert.deepEqual(first, { kind: 'ollama', version: '0.10.1', reported: 8192,
    meta: { maxTokens: null, reasoning: true, image: false } });
  const second = await reader.single(target, 'fake-slow', signal());
  assert.deepEqual(second, { kind: 'ollama', version: '0.10.1', reported: 16384,
    meta: { maxTokens: null, reasoning: false, image: false } });
  const third = await reader.single(target, 'fake-third', signal());
  assert.equal(third.reported, null, 'only the trained window: reported null (§7.2)');
  assert.deepEqual(third.meta, { maxTokens: null, reasoning: false, image: false });
  // 单模型模式只 POST 这一个模型的 /api/show（§7.1）
  const shows = stub.calls.filter((call) => call.path === '/api/show').map((call) => JSON.parse(call.body).model);
  assert.deepEqual(shows, ['fake-coder', 'fake-slow', 'fake-third']);
  const auto = await autoProbes(reader, target, 'fake-third');
  assert.equal(auto.reported, null);
  assert.deepEqual(auto.meta, { maxTokens: null, reasoning: false, image: false });
});

test('MD-12 step 0 on the rich shape: window, max output, thinking and image as reported', async (t) => {
  captureConsole(t);
  const stub = shapeFetch({ shape: 'rich' });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing('http://127.0.0.1:4322/v1');
  assert.deepEqual(await reader.single(target, 'fake-coder', signal()), { kind: 'unknown', version: null,
    reported: 131072, meta: { maxTokens: 8192, reasoning: true, image: true } });
  assert.deepEqual(await reader.single(target, 'fake-slow', signal()), { kind: 'unknown', version: null,
    reported: 131072, meta: { maxTokens: 8192, reasoning: null, image: false } });
  const auto = await autoProbes(reader, target, 'fake-coder');
  assert.deepEqual(auto.server, { kind: 'unknown', version: 'unknown' });
  assert.deepEqual(auto.meta, { maxTokens: 8192, reasoning: true, image: true });
});

test('MD-12 step 0 on the recorded-shape Ollama samples, with and without /api/tags capabilities', async (t) => {
  captureConsole(t);
  for (const tags of ['ollama-tags', 'ollama-tags-nocaps']) {
    const stub = sampleFetch({ '/v1/models': 'ollama-v1-models', '/api/version': 'ollama-api-version',
      '/api/tags': tags, '/api/ps': 'ollama-ps',
      'POST /api/show': (call) => `ollama-show-${JSON.parse(call.body).model.replace(/[:.]/g, '-')
        .replace(/-latest$/, '')}` });
    const target = existing('http://192.0.2.14:11434/v1');
    const reader = readerWith(DiscoverReader, stub.fetch);
    const qwen = await reader.single(target, 'qwen3:8b', signal());
    assert.deepEqual(qwen, { kind: 'ollama', version: '0.40.9', reported: 8192,
      meta: { maxTokens: null, reasoning: true, image: false } }, tags);
    assert.equal((await reader.single(target, 'gemma2:9b', signal())).reported, 4096, tags);
    const llava = await reader.single(target, 'llava:7b', signal());
    assert.equal(llava.reported, null, `${tags}: llava has only the trained window`);
    assert.equal(llava.meta.image, true, tags);
  }
});

// DeepSeek 样本的第 0 步在 rules-rows.test.mjs：deepseek-models.json 开始是手写的，MD-14 的录制把它换成真实列表，
// 所以那里对样本的每一行按 §4.1 独立推算期望，不写死手写样本里的 id 与值。
test('MD-12 step 0 on the DashScope sample gives the reported max output, thinking and image', async (t) => {
  captureConsole(t);
  const dashscope = sampleFetch({ '/compatible-mode/v1/models': 'dashscope-compatible-models',
    '/api/v1/models?model=qwen3.8-max': 'dashscope-native-models-single' });
  const read = await stepZero(dashscope, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max');
  assert.deepEqual(read, { kind: 'dashscope', version: null, reported: 131072,
    meta: { maxTokens: 16384, reasoning: true, image: false } });
  assert.ok(!dashscope.calls.some((call) => call.search.includes('page_no')), 'single mode does not page (D14)');
});

test('MD-12 a reported Ollama window lowers the effective window; the trained-only one keeps the configured',
  async (t) => {
    captureConsole(t);
    const reader = readerWith(DiscoverReader, shapeFetch({ shape: 'ollama', models: ['fake-coder', 'fake-slow',
      'fake-third'] }).fetch);
    const target = existing('http://127.0.0.1:4323/v1');
    const profileTarget = (id) => ({ baseUrl: target.base, api: 'openai-completions', compat: {},
      model: { id, family: '', contextWindow: 131072, maxTokens: 16384, reasoning: false, input: ['text'] } });
    for (const [id, effective, reported] of [['fake-coder', 8192, 8192], ['fake-third', 131072, null]]) {
      const auto = await autoProbes(reader, target, id);
      const view = P.profileView(profileTarget(id), P.buildProfile({ target: profileTarget(id), auto, now: 1 }),
        false, null);
      assert.equal(view.context.effective, effective, id);
      assert.equal(view.context.reported, reported, id);
      assert.equal(view.reported.contextWindow, reported, id);
    }
  });

test('MD-12 three models added at once: one list read, every result has the kind and meta', async (t) => {
  captureConsole(t);
  const stub = shapeFetch({ shape: 'sglang', models: ['a', 'b', 'c'] });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing('http://127.0.0.1:4324/v1', { shareKey: 'http://127.0.0.1:4324/v1|openai-completions|' });
  const results = await Promise.all(['a', 'b', 'c'].map((id) => autoProbes(reader, target, id)));
  assert.equal(stub.calls.filter((call) => call.path === '/v1/models').length, 1);
  for (const auto of results) {
    assert.deepEqual(auto.server, { kind: 'sglang', version: '0.10.1' });
    assert.deepEqual(auto.meta, { maxTokens: null, reasoning: true, image: false });
    assert.equal(auto.reported, 131072);
  }
});

test('MD-12 Fetch models or Cancel during the step 0 of three added models does not cancel their probes',
  async (t) => {
    captureConsole(t);
    const base = 'http://127.0.0.1:4325/v1';
    const shareKey = `${base}|openai-completions|`;
    // 列表请求等 release 才回答（synthetic）：第 0 步在读列表时，卡上点 Fetch models（同一个提供商的命令）再点 Cancel
    const shape = shapeFetch({ shape: 'sglang', models: ['a', 'b', 'c'] });
    const release = deferred();
    const stub = stubFetch(async (call) => {
      if (call.path === '/v1/models') await release.promise;
      return shape.fetch(call.url, { method: call.method, headers: call.headers, body: call.body ?? undefined });
    });
    const reader = readerWith(DiscoverReader, stub.fetch);
    const target = existing(base, { shareKey });
    const pending = Promise.all(['a', 'b', 'c'].map((id) => autoProbes(reader, target, id)));
    await settle();
    const fetchModels = reader.command(providerRequest(base, { shareKey, configured: ['a', 'b', 'c'] }));
    await settle();
    reader.cancelCommand();
    assert.equal((await fetchModels).cancelled, true);
    const again = reader.command(providerRequest(base, { shareKey, configured: ['a', 'b', 'c'] }));
    const newer = reader.command(providerRequest('http://127.0.0.1:4326/v1'));
    assert.equal((await again).cancelled, true, 'a newer Fetch models cancels the earlier one');
    const lists = stub.calls.filter((call) => call.origin === 'http://127.0.0.1:4325' && call.path === '/v1/models');
    assert.equal(lists.length, 1, 'step 0 and both commands share one list request');
    assert.equal(lists[0].signal.aborted, false, 'the cancelled commands do not abort it');
    release.resolve();
    await newer;
    const results = await pending;
    for (const auto of results) {
      assert.notEqual(auto, null, 'the probe set was not cancelled');
      assert.deepEqual(auto.server, { kind: 'sglang', version: '0.10.1' });
      assert.deepEqual(auto.meta, { maxTokens: null, reasoning: true, image: false });
    }
  });
