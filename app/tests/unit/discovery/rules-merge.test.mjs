// MD-04 按种类合并（docs/specs/model-discovery.md §4.2，§13.2 单元层）：§4.2 每一行——SGLang 的解析器与图片、llama.cpp
// 的 n_ctx 与 router 模式、Ollama 的窗口顺序与 trained_window、/api/tags 没有 capabilities 时用 /api/show、LM Studio、
// GPUStack 的 with_meta、MindIE、TGI、LocalAI、百炼翻页；详情失败时只用列表。每个种类用 tests/fixtures/discovery/bodies/
// 的样本（README.md 的“规格应得”一栏），经替身 fetch 交给 DiscoverReader.command；失败与边界的回答是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureErrors, countOf, discoverScenario, discoverWith, modelOf, newRequest, openaiList, providerRequest, readerWith,
  rules, sample, samples, table, urlsOf,
} from './rules-helpers.mjs';

/** 一个模型里 §4.2 合并相关的值。 */
function picked(model) {
  const { contextWindow, maxTokens, reasoning, image, family, chat, hints } = model;
  return { contextWindow, maxTokens, reasoning, image, family, chat, hints, reported: { ...model.reported } };
}

/** 报告了的字段（reported 为真的那些）。 */
function reportedKeys(model) {
  return Object.entries(model.reported).filter(([, value]) => value).map(([key]) => key);
}

// ---- SGLang ----

test('MD-04 §4.2 SGLang /model_info: parsers and image understanding merge into rows with a null parent', async () => {
  const { result, calls } = await discoverScenario('sglang');
  assert.equal(countOf(calls, 'http://192.0.2.11:30000/model_info'), 1);
  const base = modelOf(result, 'Qwen/Qwen3-8B');
  assert.deepEqual([base.contextWindow, base.reasoning, base.image, base.chat, base.hints],
    [40960, true, false, null, ['no_tools']]);
  assert.deepEqual([base.reported.reasoning, base.reported.image], [true, true]);
  // LoRA 行不合并 /model_info，只取 parent 的窗口
  const lora = modelOf(result, 'math-lora');
  assert.deepEqual([lora.contextWindow, lora.reported.reasoning, lora.reported.image, lora.hints],
    [40960, false, false, []]);
});

test('MD-04 §4.2 SGLang: a null reasoning parser is an explicit "no"; is_generation false is not chat', async () => {
  const routes = samples('sglang-models-embedding', 'sglang-model-info-embedding');
  const { result } = await discoverWith(table(routes), newRequest('http://192.0.2.31:30000/v1'));
  assert.equal(result.server.kind, 'sglang');
  const model = modelOf(result, 'BAAI/bge-m3');
  assert.deepEqual([model.chat, model.reasoning, model.reported.reasoning, model.hints], [false, false, true,
    ['no_tools']]);
  // tool_call_parser 不为 null 时没有 no_tools；has_image_understanding 为真时图片为真
  const info = { ...sample('sglang-model-info').body, tool_call_parser: 'qwen25', has_image_understanding: true };
  const other = await discoverScenario('sglang', [['http://192.0.2.11:30000/model_info', { status: 200, body: info }]]);
  const base = modelOf(other.result, 'Qwen/Qwen3-8B');
  assert.deepEqual([base.hints, base.image], [[], true]);
});

// ---- llama.cpp ----

test('MD-04 §4.2 llama.cpp single-model mode: meta.n_ctx window and /props modalities.vision', async () => {
  const { result, calls } = await discoverScenario('llamacpp');
  assert.equal(countOf(calls, 'http://192.0.2.12:8080/props'), 1);
  const model = modelOf(result, 'gemma-3-4b-it-Q4_K_M.gguf');
  assert.deepEqual([model.contextWindow, model.image, model.reported.contextWindow], [8192, true, true]);
  // vision 为假时图片明确没有（/props 的值优先于行里的 input_modalities）
  const props = structuredClone(sample('llamacpp-props').body);
  props.modalities.vision = false;
  const off = await discoverScenario('llamacpp', [['http://192.0.2.12:8080/props', { status: 200, body: props }]]);
  const plain = modelOf(off.result, 'gemma-3-4b-it-Q4_K_M.gguf');
  assert.deepEqual([plain.image, plain.reported.image], [false, true]);
});

test('MD-04 §4.2 llama.cpp: a row without a window takes /props n_ctx, only when it is above 0', async () => {
  const rows = structuredClone(sample('llamacpp-models').body);
  for (const row of rows.data) delete row.meta;
  const routes = [['http://192.0.2.12:8080/v1/models', { status: 200, body: rows }]];
  const { result } = await discoverScenario('llamacpp', routes);
  const model = modelOf(result, 'gemma-3-4b-it-Q4_K_M.gguf');
  assert.deepEqual([model.contextWindow, model.reported.contextWindow], [8192, true]);
  const props = structuredClone(sample('llamacpp-props').body);
  props.default_generation_settings.n_ctx = 0;
  const zero = await discoverScenario('llamacpp', [...routes,
    ['http://192.0.2.12:8080/props', { status: 200, body: props }]]);
  const unreported = modelOf(zero.result, 'gemma-3-4b-it-Q4_K_M.gguf');
  assert.deepEqual([unreported.contextWindow, unreported.reported.contextWindow], [128000, false]);
});

test('MD-04 §4.2 llama.cpp router mode: the loaded model reads meta.n_ctx 16384, not context_length', async () => {
  const { result } = await discoverScenario('llamacppRouter');
  assert.deepEqual(result.server, { kind: 'llamacpp', version: 'b9104-6d1f0a2' });
  const rows = sample('llamacpp-router-models').body.data;
  assert.deepEqual([rows[0].context_length, rows[0].meta.n_ctx], [40960, 16384]);
  // 规格更正 2（2026-10-23）；router 的 /props n_ctx 是占位的 0，不算
  assert.deepEqual(result.models.map((model) => [model.id, model.contextWindow, model.reported.contextWindow]), [
    ['qwen3-8b', 16384, true], ['llama-3.2-3b', 131072, true], ['phi-4-mini', 128000, false],
    ['ggml-org/gemma-3-12b-it-GGUF', 128000, false]]);
  for (const model of result.models) assert.deepEqual([model.image, model.reported.image], [false, true], model.id);
});

// ---- Ollama ----

/** README“Ollama 的四个模型”：两份 /api/tags 结果相同 */
const OLLAMA_EXPECTED = {
  'qwen3:8b': { contextWindow: 8192, reasoning: true, image: false, family: 'qwen3', chat: true, hints: [] },
  'gemma2:9b': { contextWindow: 4096, reasoning: false, image: false, family: 'gemma2', chat: true,
    hints: ['no_tools'] },
  'llava:7b': { contextWindow: 32768, reasoning: false, image: true, family: 'llama', chat: true,
    hints: ['no_tools', 'trained_window'] },
  'nomic-embed-text:latest': { contextWindow: 2048, reasoning: false, image: false, family: 'nomic-bert', chat: false,
    hints: ['no_tools', 'trained_window'] },
};

/** 断言 Ollama 四个模型的读取结果。 */
function assertOllama(result, label) {
  assert.deepEqual(result.server, { kind: 'ollama', version: '0.40.9' }, label);
  assert.deepEqual(result.models.map((model) => model.id), Object.keys(OLLAMA_EXPECTED), label);
  for (const [id, expected] of Object.entries(OLLAMA_EXPECTED)) {
    const { contextWindow, reasoning, image, family, chat, hints } = picked(modelOf(result, id));
    assert.deepEqual({ contextWindow, reasoning, image, family, chat, hints }, expected, `${label} ${id}`);
    assert.equal(modelOf(result, id).reported.contextWindow, true, `${label} ${id}`);
  }
}

test('MD-04 §4.2 Ollama: window from /api/ps, then Modelfile num_ctx, then the trained window', async () => {
  const { result, calls } = await discoverScenario('ollama');
  assertOllama(result, 'tags with capabilities');
  assert.equal(countOf(calls, 'http://192.0.2.14:11434/api/tags'), 1);
  assert.equal(countOf(calls, 'http://192.0.2.14:11434/api/ps'), 1);
  const shows = calls.filter((call) => call.url === 'http://192.0.2.14:11434/api/show');
  assert.deepEqual(shows.map((call) => [call.method, JSON.parse(call.body)]),
    Object.keys(OLLAMA_EXPECTED).map((model) => ['POST', { model }]));
  for (const call of shows) assert.equal(call.headers['content-type'], 'application/json');
});

test('MD-04 §4.2 Ollama: /api/tags without capabilities uses /api/show', async () => {
  const { result } = await discoverScenario('ollamaNoCaps');
  assertOllama(result, 'tags without capabilities');
});

test('MD-04 §4.2 Ollama: /api/ps beats num_ctx, num_ctx beats the trained window', async () => {
  // gemma2:9b 也加载着时取 /api/ps 的窗口，不取 num_ctx，也没有 trained_window
  const ps = structuredClone(sample('ollama-ps').body);
  ps.models.push({ ...ps.models[0], name: 'gemma2:9b', model: 'gemma2:9b', context_length: 2048 });
  const { result } = await discoverScenario('ollama', [['http://192.0.2.14:11434/api/ps', { status: 200, body: ps }]]);
  assert.deepEqual([modelOf(result, 'gemma2:9b').contextWindow, modelOf(result, 'gemma2:9b').hints],
    [2048, ['no_tools']]);
  // /api/ps 读不到时，qwen3:8b 只剩训练窗口 40960（/api/tags 的 details.context_length）
  const none = await discoverScenario('ollama', [['http://192.0.2.14:11434/api/ps',
    { status: 200, body: { models: [] } }]]);
  const qwen = modelOf(none.result, 'qwen3:8b');
  assert.deepEqual([qwen.contextWindow, qwen.hints], [40960, ['trained_window']]);
});

test('MD-04 §4.2 Ollama reads /api/show for at most 100 models', async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `model-${index}:latest`);
  const list = openaiList(ids, () => ({ created: 1791853951, owned_by: 'library' }));
  const tags = { models: ids.map((name) => ({ name, model: name, details: { family: 'llama', context_length: 8192 },
    capabilities: ['completion', 'tools'] })) };
  const routes = [['http://192.0.2.14:11434/v1/models', { status: 200, body: list }],
    ['http://192.0.2.14:11434/api/tags', { status: 200, body: tags }],
    ['POST http://192.0.2.14:11434/api/show', (call) => ({ status: 200, body: { parameters: 'num_ctx 4096',
      details: { family: 'llama' }, model_info: {}, capabilities: ['completion', 'tools'],
      model: JSON.parse(call.body).model } })]];
  const { result, calls } = await discoverScenario('ollama', routes);
  const shown = calls.filter((call) => call.method === 'POST').map((call) => JSON.parse(call.body).model);
  assert.deepEqual(shown, ids.slice(0, 100));
  assert.equal(modelOf(result, 'model-99:latest').contextWindow, 4096);
  // 第 101 个不读 /api/show：窗口按 /api/ps、/api/tags 能读到的
  const last = modelOf(result, 'model-100:latest');
  assert.deepEqual([last.contextWindow, last.hints], [8192, ['trained_window']]);
});

// ---- LM Studio ----

test('MD-04 §4.2 LM Studio: matched by key or loaded instance id; window, vision, reasoning, tools, type', async () => {
  const { result, calls } = await discoverScenario('lmstudio');
  assert.equal(countOf(calls, 'http://192.0.2.15:1234/api/v1/models'), 1);
  const rows = result.models.map((model) => [model.id, model.contextWindow, model.image, model.reasoning,
    model.chat, model.hints]);
  assert.deepEqual(rows, [
    ['google/gemma-4-26b-a4b', 4096, true, true, true, []],
    ['deepseek-r1', 131072, false, true, true, []],
    ['mistralai/mathstral-7b-v0.1', 32768, false, false, true, ['no_tools']],
    ['text-embedding-nomic-embed-text-v1.5', 2048, false, false, false, []],
    ['qwen3-8b-32k', 32768, false, true, true, []],
  ]);
  assert.equal(modelOf(result, 'deepseek-r1').reported.image, true);
  assert.equal(modelOf(result, 'mistralai/mathstral-7b-v0.1').reported.reasoning, false);
  assert.equal(modelOf(result, 'text-embedding-nomic-embed-text-v1.5').reported.image, false);
});

// ---- GPUStack ----

test('MD-04 §4.2 GPUStack: <base>/models?with_meta=true replaces the list and meta.* gives the window', async () => {
  const { result, calls } = await discoverScenario('gpustack');
  assert.deepEqual(urlsOf(calls), ['http://192.0.2.17/v1/models', 'http://192.0.2.17/v1/models?with_meta=true']);
  assert.deepEqual(result.models.map((model) => [model.id, model.contextWindow, model.reported.contextWindow]), [
    ['qwen3-32b', 32768, true], ['llama-3.3-70b', 16384, true], ['deepseek-r1-distill-mindie', 2560, true],
    ['bge-m3', 8192, true]]);
});

// ---- MindIE ----

test('MD-04 §4.2 MindIE: each model reads <origin>/v2/models/<id>/config for max_seq_len', async () => {
  const { result, calls } = await discoverScenario('mindie');
  assert.equal(countOf(calls, 'http://192.0.2.18:1025/v2/models/llama3-70b/config'), 1);
  assert.deepEqual([modelOf(result, 'llama3-70b').contextWindow, modelOf(result, 'llama3-70b').reported.contextWindow],
    [2560, true]);
  const list = openaiList(['llama3-70b', 'org/qwen 7b'], () => ({ owned_by: 'MindIE Server' }));
  const two = await discoverScenario('mindie', [['http://192.0.2.18:1025/v1/models', { status: 200, body: list }]]);
  assert.deepEqual(urlsOf(two.calls).filter((url) => url.endsWith('/config')), [
    'http://192.0.2.18:1025/v2/models/llama3-70b/config', 'http://192.0.2.18:1025/v2/models/org%2Fqwen%207b/config']);
});

// ---- TGI ----

test('MD-04 §4.2 TGI: /info from step 6 gives max_total_tokens as the window', async () => {
  const { result, calls } = await discoverScenario('tgi');
  assert.equal(countOf(calls, 'http://192.0.2.19:8080/info'), 1);
  const model = modelOf(result, 'meta-llama/Llama-3.1-8B-Instruct');
  assert.deepEqual([model.contextWindow, model.reported.contextWindow], [8192, true]);
});

// ---- LocalAI ----

test('MD-04 §4.2 LocalAI: <base>/models/capabilities merges by id and is read by §4.1', async () => {
  const { result, calls } = await discoverScenario('localai');
  assert.equal(countOf(calls, 'http://192.0.2.21:8080/v1/models/capabilities'), 1);
  const rows = result.models.map((model) => [model.id, model.contextWindow, model.reasoning, model.image, model.chat,
    model.hints, model.unusable]);
  assert.deepEqual(rows, [
    ['qwen3-8b', 8192, true, false, true, [], null],
    ['llava-1.6-mistral', 4096, false, true, true, ['no_tools'], null],
    ['text-embedding-ada-002', 8192, false, false, false, ['no_tools'], null],
    ['my model.gguf', 128000, false, false, null, [], 'the ID contains spaces'],
  ]);
  assert.deepEqual(reportedKeys(modelOf(result, 'qwen3-8b')), ['contextWindow', 'reasoning', 'image']);
  assert.deepEqual(reportedKeys(modelOf(result, 'my model.gguf')), []);
});

test('MD-04 §4.2 detail values take precedence over the same fields in the list row', async () => {
  // LocalAI：列表行自己带的 capabilities、context_size 被详情的值盖过
  const list = { object: 'list', data: [{ id: 'qwen3-8b', object: 'model', capabilities: ['embeddings'],
    context_size: 1000 }] };
  const { result } = await discoverScenario('localai', [['http://192.0.2.21:8080/v1/models',
    { status: 200, body: list }]]);
  const model = modelOf(result, 'qwen3-8b');
  assert.deepEqual([model.contextWindow, model.chat, model.reasoning], [8192, true, true]);
  // SGLang：行里的 supports_reasoning 为假，/model_info 有思考解析器
  const rows = structuredClone(sample('sglang-models').body);
  rows.data[0].supports_reasoning = false;
  const sglang = await discoverScenario('sglang', [['http://192.0.2.11:30000/v1/models', { status: 200, body: rows }]]);
  assert.equal(modelOf(sglang.result, 'Qwen/Qwen3-8B').reasoning, true);
});

// ---- 百炼 ----

test('MD-04 §4.2 Model Studio: native list pages are read until a short page, then merged by model', async () => {
  const { result, calls } = await discoverScenario('dashscope');
  const native = urlsOf(calls).filter((url) => url.includes('/api/v1/models'));
  assert.deepEqual(native, ['https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100',
    'https://dashscope.aliyuncs.com/api/v1/models?page_no=2&page_size=100']);
  assert.deepEqual(picked(modelOf(result, 'qwen3.8-max')), { contextWindow: 131072, maxTokens: 16384,
    reasoning: true, image: false, family: '', chat: true, hints: [],
    reported: { contextWindow: true, maxTokens: true, reasoning: true, image: true, family: false } });
  const vl = modelOf(result, 'qwen-vl-max');
  assert.deepEqual([vl.contextWindow, vl.maxTokens, vl.image, vl.chat, vl.hints], [131072, 8192, true, true,
    ['no_tools']]);
  const imageGen = modelOf(result, 'qwen-image-3.0-pro');
  assert.deepEqual([imageGen.chat, imageGen.reported.contextWindow, imageGen.image, imageGen.reported.image],
    [false, false, false, true]);
  const embedding = modelOf(result, 'text-embedding-v4');
  assert.deepEqual([embedding.chat, embedding.contextWindow, embedding.maxTokens, embedding.reported.maxTokens],
    [false, 8192, 4096, false]);
  // 第 2 页的模型同样并进列表行
  const pro = modelOf(result, 'deepseek-v4-pro');
  assert.deepEqual([pro.contextWindow, pro.maxTokens, pro.reasoning, pro.chat], [1048576, 65536, true, true]);
  // 原生列表里没有的模型只按列表本身
  assert.deepEqual(reportedKeys(modelOf(result, 'qwen-turbo-unlisted')), []);
  assert.equal(modelOf(result, 'qwen-turbo-unlisted').chat, null);
});

test('MD-04 §4.2 Model Studio: a text-only model reports image as false (spec correction 3)', async () => {
  const { result } = await discoverScenario('dashscope');
  for (const id of ['qwen3.8-max', 'deepseek-v4-pro', 'text-embedding-v4']) {
    const model = modelOf(result, id);
    assert.deepEqual([model.reported.image, model.image], [true, false], id);
  }
  assert.deepEqual([modelOf(result, 'qwen-vl-max').reported.image, modelOf(result, 'qwen-vl-max').image], [true, true]);
  // capabilities 不原样合并：["TG"] 不会被 §4.1 读成别的（chat 仍为真、思考没报告）
  assert.equal(modelOf(result, 'qwen-vl-max').reported.reasoning, false);
});

test('MD-04 §4.2 Model Studio: paging stops after 10 pages', async () => {
  const page = (call) => {
    const number = Number(new URL(call.url).searchParams.get('page_no'));
    const models = Array.from({ length: 100 }, (_, index) => ({ model: `m-${number}-${index}`, capabilities: ['TG'],
      model_info: { context_window: 32768 } }));
    return { status: 200, body: { success: true, output: { page_no: number, page_size: 100, models } } };
  };
  const { calls } = await discoverScenario('dashscope', [
    ...Array.from({ length: 12 }, (_, index) => [
      `https://dashscope.aliyuncs.com/api/v1/models?page_no=${index + 1}&page_size=100`, page])]);
  const native = urlsOf(calls).filter((url) => url.includes('/api/v1/models'));
  assert.equal(native.length, 10);
  assert.equal(native.at(-1), 'https://dashscope.aliyuncs.com/api/v1/models?page_no=10&page_size=100');
});

// 规格更正 3（docs/v1/discovery-checks.md）：百炼的 capabilities、features、model_info 不原样合并进行，只按 §4.2 的对应。
// 下面每个原生模型（synthetic，字段名照 help.aliyun.com/zh/model-studio/list-models）都有一个字段，原样并进行再按 §4.1
// 读时结果会变：每条先用 readRow 算出那样合并的结果、确认它与 §4.2 的结果不同（所以检查在原样合并时会失败），
// 再看发现命令与第 0 步给出的是 §4.2 的结果。

/** §4.2 的读法：只按百炼一行的对应合并，§4.1 只另读 inference_metadata.request_modality。 */
const DASHSCOPE_CTX = Object.freeze({ kind: 'dashscope', anthropicShape: false });

/** 没报告的字段（§4.1 的“没报告时”）。 */
const NONE_REPORTED = Object.freeze({ contextWindow: false, maxTokens: false, reasoning: false, image: false,
  family: false });

/** 原样合并时会读出别的结果的原生模型（synthetic）：merged 为原样并进行的字段，expected 为 §4.2 的结果。 */
const RAW_CASES = Object.freeze([
  // features 是 §4.1 reasoning 的数组路径：原样并进行时 thinking 读作支持思考；§4.2 只看 capabilities 的 Reasoning
  {
    native: { model: 'qwen-feature-think', capabilities: ['TG'], features: ['thinking', 'function-calling'],
      inference_metadata: { request_modality: ['Text'], response_modality: ['Text'] },
      model_info: { context_window: 131072, max_output_tokens: 8192 } },
    merged: (native) => ({ features: native.features }),
    expected: { contextWindow: 131072, maxTokens: 8192, reasoning: false, image: false, family: '', chat: true,
      hints: [], reported: { ...NONE_REPORTED, contextWindow: true, maxTokens: true, image: true } },
  },
  // 只有 capabilities ["TG"]：原样并进行时 §4.1 读成明确没有思考、没有图片，并加 no_tools；§4.2 只得出 chat 真
  {
    native: { model: 'qwen-tg-only', capabilities: ['TG'] },
    merged: (native) => ({ capabilities: native.capabilities }),
    expected: { contextWindow: 128000, maxTokens: 16384, reasoning: false, image: false, family: '', chat: true,
      hints: [], reported: NONE_REPORTED },
  },
  // capabilities 里有 §4.1 认的 Thinking、Vision（不在 §4.2 的对应里，只有 Reasoning、VU 算）
  {
    native: { model: 'qwen-caps-words', capabilities: ['TG', 'Thinking', 'Vision'], features: ['function-calling'] },
    merged: (native) => ({ capabilities: native.capabilities }),
    expected: { contextWindow: 128000, maxTokens: 16384, reasoning: false, image: false, family: '', chat: true,
      hints: [], reported: NONE_REPORTED },
  },
  // model_info 只有 max_input_tokens（§4.1 的窗口路径名）：§4.2 的窗口只取 model_info.context_window
  {
    native: { model: 'qwen-info-input', capabilities: ['TG'], features: ['function-calling'],
      model_info: { max_input_tokens: 30720, max_output_tokens: 8192 } },
    merged: (native) => ({ ...native.model_info }),
    expected: { contextWindow: 128000, maxTokens: 8192, reasoning: false, image: false, family: '', chat: true,
      hints: [], reported: { ...NONE_REPORTED, maxTokens: true } },
  },
]);

/** 百炼兼容模式列表的一行（同 dashscope-compatible-models 样本的形状）。 */
function compatibleRow(id) {
  return { id, object: 'model', created: 1792000100, owned_by: 'system' };
}

/**
 * @brief 原样合并时的读法：§4.2 的值照旧，另把 merged 的字段原样并进行，再按 §4.1 读。
 * @param item RAW_CASES 的一项
 */
function readRawMerged(item) {
  const detail = rules.dashscopeDetail(item.native);
  const values = rules.readRow(compatibleRow(item.native.model), DASHSCOPE_CTX,
    { fields: { ...detail.fields, ...item.merged(item.native) }, values: detail.values });
  return picked(rules.finalizeModel(item.native.model, values, { trained: false, added: false, catalog: null }));
}

/** @brief 百炼的路由（synthetic）：兼容模式列表为 RAW_CASES 的 id，原生列表第 1 页（不满 100 个，读完即停）为它们的原生项。 */
function rawCaseRoutes() {
  const ids = RAW_CASES.map((item) => item.native.model);
  const models = RAW_CASES.map((item) => item.native);
  return [['https://dashscope.aliyuncs.com/compatible-mode/v1/models', { status: 200, body: openaiList(ids,
    () => ({ created: 1792000100, owned_by: 'system' })) }],
  ['https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100', { status: 200,
    body: { success: true, output: { page_no: 1, page_size: 100, total: models.length, models } } }]];
}

test('MD-04 §4.2 Model Studio: capabilities, features and model_info are not merged as-is (spec correction 3)',
  async () => {
    const { result } = await discoverScenario('dashscope', rawCaseRoutes());
    assert.equal(result.server.kind, 'dashscope');
    for (const item of RAW_CASES) {
      const id = item.native.model;
      assert.notDeepEqual(readRawMerged(item), item.expected, `${id}: merged as-is it would read the same`);
      assert.deepEqual(picked(modelOf(result, id)), item.expected, id);
    }
  });

test('MD-04 §4.2 Model Studio step 0 (single mode, D14) does not merge capabilities, features or model_info as-is',
  async () => {
    const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const [list] = rawCaseRoutes();
    const singles = RAW_CASES.map((item) => [
      `https://dashscope.aliyuncs.com/api/v1/models?model=${encodeURIComponent(item.native.model)}`,
      { status: 200, body: { success: true,
        output: { page_no: 1, page_size: 20, total: 1, models: [item.native] } } }]);
    const { discoverReader, calls } = readerWith(table([list, ...singles]));
    for (const item of RAW_CASES) {
      const read = await discoverReader.single(providerRequest(base, 'openai-completions'), item.native.model,
        new AbortController().signal);
      const { expected } = item;
      assert.deepEqual(read, { kind: 'dashscope', version: null,
        reported: expected.reported.contextWindow ? expected.contextWindow : null,
        meta: { maxTokens: expected.reported.maxTokens ? expected.maxTokens : null,
          reasoning: expected.reported.reasoning ? expected.reasoning : null,
          image: expected.reported.image ? expected.image : null } }, item.native.model);
    }
    assert.ok(!calls.some((call) => call.url.includes('page_no')), 'single mode does not page (D14)');
  });

// ---- 其他种类 ----

test('MD-04 §4.2 other kinds send no detail requests', async () => {
  const cases = [['deepseek', 1], ['openrouter', 1], ['moonshot', 1], ['qianfan', 1], ['xinference', 1],
    ['lmdeploy', 1], ['oneapi', 1], ['newapi', 1], ['litellm', 1], ['vllm', 2], ['tensorrt', 1]];
  for (const [name, count] of cases) {
    const { calls } = await discoverScenario(name);
    assert.equal(calls.length, count, `${name}: ${urlsOf(calls).join(', ')}`);
  }
});

// ---- 详情失败 ----

test('MD-04 §4.2 a failed detail request only uses the list and is not a discovery failure', async (t) => {
  const errors = captureErrors(t);
  const failures = [[{ status: 500, body: 'oops' }, 'HTTP 500'], [{ status: 200, body: 'not json' }, 'not JSON'],
    [{ fail: 'connect ECONNRESET 192.0.2.11:30000' }, 'connect ECONNRESET 192.0.2.11:30000']];
  for (const [failure, reason] of failures) {
    const start = errors.length;
    const { result } = await discoverScenario('sglang', [['http://192.0.2.11:30000/model_info', failure]]);
    const label = JSON.stringify(failure);
    assert.equal(result.listError, null, label);
    assert.equal(result.server.kind, 'sglang', label);
    const model = modelOf(result, 'Qwen/Qwen3-8B');
    assert.deepEqual([model.contextWindow, model.reported.reasoning, model.hints], [40960, false, []], label);
    // §4.2：记一行日志（地址与原因），这次发现没有别的错误日志
    const logged = errors.slice(start);
    assert.equal(logged.length, 1, `${label}: ${logged.join(' | ')}`);
    assert.ok(logged[0].includes('http://192.0.2.11:30000/model_info') && logged[0].includes(reason), logged[0]);
  }
  const ollama = await discoverScenario('ollama', [['http://192.0.2.14:11434/api/tags', { fail: 'socket hang up' }],
    ['http://192.0.2.14:11434/api/ps', { status: 200, body: '<html>' }],
    ['POST http://192.0.2.14:11434/api/show', { status: 500, body: 'boom' }]]);
  assert.equal(ollama.result.listError, null);
  assert.equal(ollama.result.models.length, 4);
  for (const model of ollama.result.models) assert.deepEqual(reportedKeys(model), [], model.id);
  const gpustack = await discoverScenario('gpustack', [['http://192.0.2.17/v1/models?with_meta=true',
    { status: 502, body: 'bad gateway' }]]);
  assert.deepEqual(gpustack.result.models.map((model) => model.id), ['qwen3-32b', 'llama-3.3-70b',
    'deepseek-r1-distill-mindie', 'bge-m3']);
  assert.equal(gpustack.result.models.every((model) => !model.reported.contextWindow), true);
  const localai = await discoverScenario('localai', [['http://192.0.2.21:8080/v1/models/capabilities',
    { status: 200, body: 'not json' }]]);
  assert.equal(localai.result.models.length, 4);
  assert.equal(modelOf(localai.result, 'qwen3-8b').reported.contextWindow, false);
  const dashscope = await discoverScenario('dashscope', [[
    'https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100', { status: 500, body: 'x' }]]);
  assert.equal(dashscope.result.models.length, 6);
  assert.equal(urlsOf(dashscope.calls).filter((url) => url.includes('/api/v1/models')).length, 1);
  assert.deepEqual(reportedKeys(modelOf(dashscope.result, 'qwen3.8-max')), []);
});

test('MD-04 §4.2 a detail request that times out only uses the list', async () => {
  const { result } = await discoverScenario('mindie', [['http://192.0.2.18:1025/v2/models/llama3-70b/config',
    { hang: true }]], 200);
  assert.equal(result.listError, null);
  assert.deepEqual([modelOf(result, 'llama3-70b').contextWindow, modelOf(result, 'llama3-70b').reported.contextWindow],
    [128000, false]);
});
