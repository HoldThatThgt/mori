// MD-03 读一行（docs/specs/model-discovery.md §4.1、§4.3，§13.2 单元层）：每个字段的每条路径、正整数字符串、明确报告
// “没有”、不小于窗口的输出上限不算报告（DeepInfra、LiteLLM 样本）、LiteLLM 的假、LoRA 行用 parent 的窗口、chat 的每种判断、
// no_tools 只记“没有”、reported 的逐字段取值；DeepSeek 与 OpenRouter 的样本读出的窗口、输出上限、思考、图片与样本一致。
// 逐条路径的行是手写的（synthetic，依据规格 §4.1 的表），种类样本在 tests/fixtures/discovery/bodies/。
// DeepSeek 样本的期望按样本的每一行独立推算（MD-14 的录制把手写的样本换成真实列表）；同一份推算也用于 MD-12 的
// 第 0 步（§7.1、§7.2 单模型模式），那一条因此也在这个文件里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIOS, discoverScenario, discoverWith, modelOf, newRequest, providerRequest, readModel, readerWith, rules, sample,
  table,
} from './rules-helpers.mjs';

/** 默认的上下文：种类 unknown、不是 Anthropic 形状。 */
const PLAIN = Object.freeze({ kind: 'unknown', anthropicShape: false });

/** 按 a.b.c 路径造一个只有这个字段的行（synthetic）。 */
function at(path, value, base = { id: 'm' }) {
  const row = structuredClone(base);
  const parts = path.split('.');
  let node = row;
  for (const part of parts.slice(0, -1)) node = node[part] ??= {};
  node[parts.at(-1)] = value;
  return row;
}

/** 没报告时的输出上限（§4.1：16384 与窗口一半中较小的）。 */
function unreportedMax(window) {
  return Math.min(16384, Math.floor(window / 2));
}

// ---- contextWindow ----

/** §4.1 窗口的路径，按顺序（规格更正 2：三个 meta.* 在 context_length 之前） */
const WINDOW_PATHS = ['max_model_len', 'context_window', 'meta.max_model_len', 'meta.n_ctx', 'meta.max_total_tokens',
  'context_length', 'max_context_length', 'context_size', 'max_input_tokens', 'top_provider.context_length',
  'metadata.context_length'];

test('MD-03 §4.1 every contextWindow path is read, as a number or a digits-only string', () => {
  for (const path of WINDOW_PATHS) {
    for (const value of [40960, '40960']) {
      const model = readModel(at(path, value));
      assert.equal(model.contextWindow, 40960, `${path} ${typeof value}`);
      assert.equal(model.reported.contextWindow, true, path);
    }
  }
});

test('MD-03 §4.1 contextWindow takes the first path in the listed order', () => {
  for (let index = 0; index + 1 < WINDOW_PATHS.length; index += 1) {
    const row = at(WINDOW_PATHS[index + 1], 2000, at(WINDOW_PATHS[index], 1000));
    assert.equal(readModel(row).contextWindow, 1000, `${WINDOW_PATHS[index]} before ${WINDOW_PATHS[index + 1]}`);
  }
  const all = WINDOW_PATHS.reduce((row, path, index) => at(path, 1000 + index, row), { id: 'm' });
  assert.equal(readModel(all).contextWindow, 1000);
  // 规格更正 2（2026-10-23）：llama.cpp router 已加载的模型 context_length 是训练窗口，meta.n_ctx 是在用的窗口
  assert.equal(readModel({ id: 'm', context_length: 40960, meta: { n_ctx: 16384 } }).contextWindow, 16384);
});

test('MD-03 §4.1 a value that is not a positive integer is skipped and the default is 128000 not reported', () => {
  for (const bad of [0, -1, 1.5, '0', '-5', '12.5', '4k', ' 4096', '', '1e4', null, true, [4096], { n: 1 }]) {
    const model = readModel({ id: 'm', max_model_len: bad });
    assert.equal(model.contextWindow, 128000, JSON.stringify(bad));
    assert.equal(model.reported.contextWindow, false, JSON.stringify(bad));
    assert.equal(readModel({ id: 'm', max_model_len: bad, context_length: 8192 }).contextWindow, 8192,
      JSON.stringify(bad));
  }
});

// ---- maxTokens ----

test('MD-03 §4.1 maxTokens paths in order; max_tokens only for Anthropic-shaped lists and Qianfan', () => {
  const paths = ['max_output_tokens', 'max_completion_tokens', 'top_provider.max_completion_tokens'];
  for (const path of paths) {
    const model = readModel(at(path, '8192', { id: 'm', context_window: 65536 }));
    assert.equal(model.maxTokens, 8192, path);
    assert.equal(model.reported.maxTokens, true, path);
  }
  const ordered = { id: 'm', context_window: 65536, max_output_tokens: 1000, max_completion_tokens: 2000,
    top_provider: { max_completion_tokens: 3000 }, max_tokens: 4000 };
  assert.equal(readModel(ordered).maxTokens, 1000);
  assert.equal(readModel({ ...ordered, max_output_tokens: undefined }).maxTokens, 2000);
  const maxTokensOnly = { id: 'm', context_window: 65536, max_tokens: 4000 };
  assert.equal(readModel(maxTokensOnly).reported.maxTokens, false);
  assert.equal(readModel(maxTokensOnly, { kind: 'unknown', anthropicShape: true }).maxTokens, 4000);
  assert.equal(readModel(maxTokensOnly, { kind: 'qianfan', anthropicShape: false }).maxTokens, 4000);
  assert.equal(readModel(maxTokensOnly, { kind: 'newapi', anthropicShape: false }).maxTokens, unreportedMax(65536));
});

test('MD-03 §4.1 an output limit not smaller than the window is not reported', () => {
  for (const [window, max] of [[8192, 8192], [8192, 9000], [128000, 128000]]) {
    const model = readModel({ id: 'm', context_window: window, max_output_tokens: max });
    assert.equal(model.reported.maxTokens, false, `${window}/${max}`);
    assert.equal(model.maxTokens, unreportedMax(window), `${window}/${max}`);
    assert.ok(model.maxTokens < model.contextWindow);
  }
  // 窗口没报告时按默认窗口 128000 比较
  assert.equal(readModel({ id: 'm', max_output_tokens: 200000 }).reported.maxTokens, false);
  assert.equal(readModel({ id: 'm', max_output_tokens: 100000 }).maxTokens, 100000);
  // 没报告的默认值：16384 与窗口一半中较小的
  assert.equal(readModel({ id: 'm', context_window: 20000 }).maxTokens, 10000);
  assert.equal(readModel({ id: 'm', context_window: 1048576 }).maxTokens, 16384);
  assert.equal(readModel({ id: 'm' }).maxTokens, 16384);
});

test('MD-03 §4.1 LiteLLM: an output limit equal to the window is not reported (LiteLLM sample)', async () => {
  const { result } = await discoverScenario('litellm');
  assert.equal(result.server.kind, 'litellm');
  const equal = modelOf(result, 'deepseek-chat');
  assert.equal(equal.contextWindow, 128000);
  assert.deepEqual([equal.maxTokens, equal.reported.maxTokens], [16384, false]);
  const below = modelOf(result, 'gpt-4o');
  assert.deepEqual([below.contextWindow, below.maxTokens, below.reported.maxTokens], [128000, 16384, true]);
  const claude = modelOf(result, 'claude-sonnet');
  assert.deepEqual([claude.contextWindow, claude.maxTokens, claude.reported.maxTokens], [200000, 64000, true]);
});

test('MD-03 §4.1 DeepInfra: metadata.max_tokens equal to the window does not become a reported limit', async () => {
  // README：DeepInfra 的输出上限在 metadata.max_tokens（等于 metadata.context_length），不在 §4.1 的路径里
  const { result } = await discoverScenario('deepinfra');
  const rows = sample('deepinfra-models').body.data;
  assert.equal(result.models.length, rows.length);
  for (const row of rows) {
    const model = modelOf(result, row.id);
    const window = row.metadata.context_length;
    assert.equal(model.reported.maxTokens, false, row.id);
    assert.equal(model.contextWindow, window ?? 128000, row.id);
    assert.equal(model.reported.contextWindow, window !== null, row.id);
    assert.equal(model.maxTokens, unreportedMax(model.contextWindow), row.id);
    if (window !== null) assert.equal(row.metadata.max_tokens, window, row.id);
  }
  assert.deepEqual(modelOf(result, 'zai-org/GLM-4.7').reasoning, true);
  assert.deepEqual(modelOf(result, 'Qwen/Qwen3.5-35B-A3B').image, true);
});

test('MD-03 §4.1 DeepInfra\'s own limit at an output path equals the window and is not reported', () => {
  // README 已知问题 3：metadata.max_tokens 不在 §4.1 的路径里。把样本每行自己的值放到 §4.1 的三条输出上限路径上
  // （synthetic，由真实录制的行推出），规则才走到“不小于窗口的不算报告”；比窗口小 1 时照样是报告值。
  const rows = sample('deepinfra-models').body.data.filter((row) => row.metadata.max_tokens !== null);
  assert.ok(rows.length >= 4);
  for (const row of rows) {
    const { context_length: window, max_tokens: max } = row.metadata;
    assert.equal(max, window, row.id);
    for (const path of ['max_output_tokens', 'max_completion_tokens', 'top_provider.max_completion_tokens']) {
      const equal = readModel(at(path, max, row));
      assert.deepEqual([equal.contextWindow, equal.maxTokens, equal.reported.maxTokens],
        [window, unreportedMax(window), false], `${row.id} ${path}`);
      const below = readModel(at(path, max - 1, row));
      assert.deepEqual([below.maxTokens, below.reported.maxTokens], [max - 1, true], `${row.id} ${path} below`);
    }
  }
});

// ---- reasoning ----

test('MD-03 §4.1 reasoning: true booleans, present objects and arrays with reasoning or thinking', () => {
  const yes = [at('supports_reasoning', true), at('capabilities.reasoning', true),
    at('capabilities.thinking.supported', true), at('effort', { supported_levels: ['low'] }), at('reasoning', {}),
    ...['capabilities', 'features', 'supported_parameters', 'model_ability', 'tags', 'metadata.tags']
      .flatMap((path) => [at(path, ['x', 'reasoning']), at(path, ['Thinking'])])];
  for (const row of yes) {
    const model = readModel(row);
    assert.deepEqual([model.reasoning, model.reported.reasoning], [true, true], JSON.stringify(row));
  }
});

test('MD-03 §4.1 reasoning: false booleans and three arrays without the words report "no"', () => {
  const no = [at('supports_reasoning', false), at('capabilities.reasoning', false),
    at('capabilities.thinking.supported', false), at('capabilities', ['completion']),
    at('model_ability', ['chat']), at('supported_parameters', ['temperature'])];
  for (const row of no) {
    const model = readModel(row);
    assert.deepEqual([model.reasoning, model.reported.reasoning], [false, true], JSON.stringify(row));
  }
  // features、tags 存在但不含这两个词不算明确没有；effort 不是对象也不算
  for (const row of [at('features', ['tools']), at('tags', ['chat']), at('metadata.tags', ['chat']),
    at('effort', 'high'), { id: 'm' }]) {
    const model = readModel(row);
    assert.deepEqual([model.reasoning, model.reported.reasoning], [false, false], JSON.stringify(row));
  }
  // 有一处报告支持就为真（A7）
  assert.equal(readModel({ id: 'm', supports_reasoning: true, capabilities: ['completion'] }).reasoning, true);
});

// ---- image ----

test('MD-03 §4.1 image: modality arrays with image, true booleans, vision or vlm arrays and type vlm', () => {
  const yes = [at('input_modalities', ['text', 'image']), at('architecture.input_modalities', ['Image']),
    at('inference_metadata.request_modality', ['Text', 'Image']), at('supports_image_in', true),
    at('supportsImageInput', true), at('capabilities.vision', true), at('capabilities.image_input.supported', true),
    ...['capabilities', 'model_ability', 'tags', 'metadata.tags']
      .flatMap((path) => [at(path, ['vision']), at(path, ['VLM'])]), at('type', 'vlm')];
  for (const row of yes) {
    const model = readModel(row);
    assert.deepEqual([model.image, model.reported.image], [true, true], JSON.stringify(row));
  }
});

test('MD-03 §4.1 image: false booleans, modality arrays without image and two arrays without vision say "no"', () => {
  const no = [at('supports_image_in', false), at('supportsImageInput', false), at('capabilities.vision', false),
    at('capabilities.image_input.supported', false), at('input_modalities', ['text']),
    at('architecture.input_modalities', ['text', 'audio']), at('inference_metadata.request_modality', ['Text']),
    at('capabilities', ['completion']), at('model_ability', ['chat'])];
  for (const row of no) {
    const model = readModel(row);
    assert.deepEqual([model.image, model.reported.image], [false, true], JSON.stringify(row));
  }
  for (const row of [at('tags', ['chat']), at('metadata.tags', ['chat']), at('type', 'chat'), { id: 'm' }]) {
    const model = readModel(row);
    assert.deepEqual([model.image, model.reported.image], [false, false], JSON.stringify(row));
  }
});

// ---- family ----

test('MD-03 §4.1 family: details.family, then model_family; none is empty and not reported', () => {
  assert.deepEqual(readModel(at('details.family', 'qwen3')).family, 'qwen3');
  assert.deepEqual(readModel(at('model_family', 'llama')).family, 'llama');
  const both = { id: 'm', details: { family: 'qwen3' }, model_family: 'llama' };
  assert.equal(readModel(both).family, 'qwen3');
  assert.equal(readModel(both).reported.family, true);
  for (const row of [{ id: 'm' }, at('details.family', ''), at('model_family', 7)]) {
    assert.deepEqual([readModel(row).family, readModel(row).reported.family], ['', false], JSON.stringify(row));
  }
});

// ---- chat ----

test('MD-03 §4.1 chat: capabilities.completion_chat comes before type (spec correction 1, Mistral)', async () => {
  assert.equal(readModel({ id: 'm', type: 'base', capabilities: { completion_chat: true } }).chat, true);
  assert.equal(readModel({ id: 'm', type: 'base', capabilities: { completion_chat: false } }).chat, false);
  assert.equal(readModel({ id: 'm', type: 'chat', capabilities: { completion_chat: false } }).chat, false);
  const { result } = await discoverScenario('mistral');
  const rows = sample('mistral-models').body.data;
  for (const row of rows) {
    assert.equal(row.type, 'base', row.id);
    assert.equal(modelOf(result, row.id).chat, row.capabilities.completion_chat, row.id);
  }
  assert.deepEqual(result.models.map((model) => model.chat), [true, true, true, false]);
});

test('MD-03 §4.1 chat: type, then mode, then model_type', () => {
  for (const type of ['chat', 'llm', 'vlm', 'language', 'code']) assert.equal(readModel(at('type', type)).chat, true);
  for (const type of ['embedding', 'image', 'base', 'rerank', 'audio']) {
    assert.equal(readModel(at('type', type)).chat, false, type);
  }
  // type 为 model 不看，接着看后面的
  assert.equal(readModel({ id: 'm', type: 'model' }).chat, null);
  assert.equal(readModel({ id: 'm', type: 'model', mode: 'chat' }).chat, true);
  for (const mode of ['chat', 'responses', 'completion']) assert.equal(readModel(at('mode', mode)).chat, true, mode);
  for (const mode of ['embedding', 'image_generation', 'audio_transcription', 'rerank']) {
    assert.equal(readModel(at('mode', mode)).chat, false, mode);
  }
  assert.equal(readModel({ id: 'm', type: 'embedding', mode: 'chat' }).chat, false);
  assert.equal(readModel(at('model_type', 'LLM')).chat, true);
  assert.equal(readModel({ id: 'm', model_type: 'LLM', model_ability: ['generate'] }).chat, false);
  assert.equal(readModel({ id: 'm', model_type: 'LLM', model_ability: ['generate', 'chat'] }).chat, true);
  for (const modelType of ['embedding', 'rerank', 'image', 'llm']) {
    assert.equal(readModel(at('model_type', modelType)).chat, false, modelType);
  }
  assert.equal(readModel({ id: 'm', mode: 'embedding', model_type: 'LLM' }).chat, false);
});

test('MD-03 §4.1 chat: capabilities arrays, output modalities and supported_endpoint_types', () => {
  for (const capabilities of [['completion'], ['chat'], ['Completion', 'tools'], ['embedding', 'chat']]) {
    assert.equal(readModel(at('capabilities', capabilities)).chat, true, JSON.stringify(capabilities));
  }
  for (const capabilities of [['embedding'], ['embeddings'], ['vision', 'tools']]) {
    assert.equal(readModel(at('capabilities', capabilities)).chat, false, JSON.stringify(capabilities));
  }
  assert.equal(readModel(at('output_modalities', ['image'])).chat, false);
  assert.equal(readModel(at('architecture.output_modalities', ['audio'])).chat, false);
  assert.equal(readModel(at('architecture.output_modalities', ['text', 'image'])).chat, null);
  for (const types of [['openai'], ['openai-response'], ['anthropic'], ['gemini', 'openai']]) {
    assert.equal(readModel(at('supported_endpoint_types', types)).chat, true, JSON.stringify(types));
  }
  for (const types of [['embeddings'], ['gemini'], ['image-generation'], []]) {
    assert.equal(readModel(at('supported_endpoint_types', types)).chat, false, JSON.stringify(types));
  }
  assert.equal(readModel({ id: 'm' }).chat, null);
  // 按顺序：output_modalities 在 supported_endpoint_types 之前
  assert.equal(readModel({ id: 'm', output_modalities: ['image'], supported_endpoint_types: ['openai'] }).chat, false);
});

test('MD-03 §4.1 chat: the first judgement that decides wins over the ones after it', () => {
  // 每一对相邻的判断都给出相反的结论（synthetic，依据 §4.1 chat 一格的顺序）
  const cases = [
    [{ capabilities: { completion_chat: true }, type: 'embedding' }, true],
    [{ type: 'embedding', mode: 'chat' }, false],
    [{ type: 'chat', mode: 'embedding' }, true],
    [{ mode: 'embedding', model_type: 'LLM' }, false],
    [{ mode: 'chat', model_type: 'embedding' }, true],
    [{ model_type: 'embedding', capabilities: ['chat'] }, false],
    [{ model_type: 'LLM', capabilities: ['embedding'] }, true],
    [{ capabilities: ['chat'], output_modalities: ['image'] }, true],
    [{ capabilities: ['embedding'], supported_endpoint_types: ['openai'] }, false],
    [{ architecture: { output_modalities: ['image'] }, supported_endpoint_types: ['openai'] }, false],
    [{ output_modalities: ['text'], supported_endpoint_types: ['gemini'] }, false],
  ];
  for (const [fields, chat] of cases) {
    assert.equal(readModel({ id: 'm', ...fields }).chat, chat, JSON.stringify(fields));
  }
});

test('MD-03 §4.1 chat in the samples: New API, Together, Xinference and the edge rows', async () => {
  const newapi = await discoverScenario('newapi');
  assert.deepEqual(newapi.result.models.map((model) => model.chat), [true, true, false, false, false]);
  const together = await discoverScenario('together');
  assert.deepEqual(together.result.models.map((model) => model.chat), [true, true, false, false]);
  // 图片模型的 context_length 为 0，不是正整数
  assert.equal(modelOf(together.result, 'black-forest-labs/FLUX.1-schnell').reported.contextWindow, false);
  const xinference = await discoverScenario('xinference');
  assert.deepEqual(xinference.result.models.map((model) => model.chat), [true, true, false, false]);
  const edge = await discoverScenario('edge');
  assert.equal(modelOf(edge.result, 'acme-small').chat, null);
  assert.equal(modelOf(edge.result, 'acme-embed').chat, false);
});

// ---- no_tools ----

test('MD-03 §4.1 no_tools only records "no": false booleans and three arrays without tools', () => {
  const no = [at('capabilities.function_calling', false), at('supports_function_calling', false),
    at('capabilities.trained_for_tool_use', false), at('capabilities', ['completion']),
    at('model_ability', ['chat']), at('supported_parameters', ['temperature'])];
  for (const row of no) assert.deepEqual(readModel(row).hints, ['no_tools'], JSON.stringify(row));
  const yesOrNothing = [at('capabilities.function_calling', true), at('supports_function_calling', true),
    at('capabilities', ['completion', 'tools']), at('model_ability', ['chat', 'tools']),
    at('supported_parameters', ['tools']), at('features', ['chat']), at('tags', ['chat']), { id: 'm' }];
  for (const row of yesOrNothing) assert.deepEqual(readModel(row).hints, [], JSON.stringify(row));
});

// ---- LiteLLM 的假 ----

test('MD-03 §4.1 LiteLLM fills unknown abilities with false: those count as not reported', async () => {
  const { result } = await discoverScenario('litellm');
  const flags = modelOf(result, 'gpt-4o-mini-flags');
  assert.equal(flags.reported.reasoning, false);
  assert.equal(flags.reasoning, false);
  assert.deepEqual(flags.hints, []);
  const context = { kind: 'litellm', anthropicShape: false };
  for (const row of [at('supports_image_in', false), at('capabilities.vision', false)]) {
    assert.equal(readModel(row, context).reported.image, false, JSON.stringify(row));
  }
  assert.deepEqual(readModel(at('supports_function_calling', false), context).hints, []);
  assert.equal(readModel(at('capabilities.completion_chat', false), context).chat, null);
  // 同样的行在别的种类里是明确报告没有
  assert.equal(readModel(at('supports_reasoning', false)).reported.reasoning, true);
  assert.equal(modelOf(result, 'text-embedding-3-small').chat, false);
});

// ---- LoRA 行 ----

test('MD-03 §4.1 vLLM and SGLang LoRA rows use the parent row\'s window', async () => {
  const vllm = await discoverScenario('vllm');
  assert.deepEqual(vllm.result.models.map((model) => [model.id, model.contextWindow, model.reported.contextWindow]),
    [['Qwen/Qwen3-32B', 32768, true], ['sql-lora', 32768, true]]);
  const sglang = await discoverScenario('sglang');
  assert.equal(modelOf(sglang.result, 'math-lora').contextWindow, 40960);
  // 只有 vLLM、SGLang 这样做；LoRA 行自己有窗口时用自己的
  const rows = [{ id: 'base', max_model_len: 32768 }, { id: 'lora', parent: 'base' },
    { id: 'own', parent: 'base', max_model_len: 4096 }];
  const values = rows.map((row) => rules.readRow(row, PLAIN));
  assert.deepEqual(rules.parentWindows('vllm', rows, values).map((value) => value.contextWindow), [32768, 32768, 4096]);
  assert.deepEqual(rules.parentWindows('sglang', rows, values).map((value) => value.contextWindow),
    [32768, 32768, 4096]);
  for (const kind of ['lmdeploy', 'unknown', 'oneapi']) {
    assert.deepEqual(rules.parentWindows(kind, rows, values).map((value) => value.contextWindow), [32768, null, 4096],
      kind);
  }
});

test('MD-03 §4.1 a LoRA row gets the parent window in probe step 0 too (single-model mode)', async () => {
  for (const [name, id, window] of [['vllm', 'sql-lora', 32768], ['sglang', 'math-lora', 40960]]) {
    const base = rules.normalizeBaseUrl(SCENARIOS[name].raw).base;
    const { discoverReader } = readerWith(table(SCENARIOS[name].routes()));
    const read = await discoverReader.single(providerRequest(base, 'openai-completions'), id,
      new AbortController().signal);
    assert.deepEqual([read.kind, read.reported], [name, window], name);
  }
});

test('MD-03 §4.3 the output limit is checked again against the final window (a LoRA row\'s own limit)', async () => {
  // LoRA 行自己报告了输出上限（synthetic，依据 §4.1 LoRA 一条与 §4.3）：读行时按默认窗口 128000 比较算报告值，
  // 换成 parent 的窗口后不小于它，按没报告取默认值
  const lora = (id, max) => ({ id, object: 'model', owned_by: 'vllm', parent: 'base', max_model_len: null,
    max_output_tokens: max });
  const list = { object: 'list', data: [
    { id: 'base', object: 'model', owned_by: 'vllm', parent: null, max_model_len: 32768 },
    lora('lora-big', 65536), lora('lora-small', 4096)] };
  const { result } = await discoverWith(table([['http://192.0.2.65:8000/v1/models', { status: 200, body: list }]]),
    newRequest('http://192.0.2.65:8000/v1'));
  assert.equal(result.server.kind, 'vllm');
  const big = modelOf(result, 'lora-big');
  assert.deepEqual([big.contextWindow, big.maxTokens, big.reported.maxTokens], [32768, 16384, false]);
  const small = modelOf(result, 'lora-small');
  assert.deepEqual([small.contextWindow, small.maxTokens, small.reported.maxTokens], [32768, 4096, true]);
  for (const model of result.models) assert.ok(model.maxTokens < model.contextWindow, model.id);
});

// ---- reported ----

test('MD-03 §4.1 reported is set field by field', () => {
  assert.deepEqual(readModel({ id: 'm' }).reported,
    { contextWindow: false, maxTokens: false, reasoning: false, image: false, family: false });
  assert.deepEqual(readModel({ id: 'm', context_window: 65536 }).reported,
    { contextWindow: true, maxTokens: false, reasoning: false, image: false, family: false });
  assert.deepEqual(readModel({ id: 'm', max_output_tokens: 4096, input_modalities: ['text'] }).reported,
    { contextWindow: false, maxTokens: true, reasoning: false, image: true, family: false });
  assert.deepEqual(readModel({ id: 'm', supports_reasoning: false, details: { family: 'qwen3' } }).reported,
    { contextWindow: false, maxTokens: false, reasoning: true, image: false, family: true });
  assert.deepEqual(Object.keys(readModel({ id: 'm' })).sort(), ['added', 'chat', 'contextWindow', 'family', 'hints',
    'id', 'image', 'maxTokens', 'reasoning', 'reported', 'unusable']);
});

// ---- §4.3 ----

test('MD-03 §4.3 an empty id or an id with spaces is listed but cannot be added', async () => {
  assert.equal(readModel({ id: '' }).unusable, 'the ID is empty');
  assert.equal(readModel({ id: 'my model.gguf' }).unusable, 'the ID contains spaces');
  assert.equal(readModel({ id: 'tab\tmodel' }).unusable, 'the ID contains spaces');
  assert.equal(readModel({ id: 7 }).unusable, 'the ID is empty');
  assert.equal(readModel({ id: 'qwen3:8b' }).unusable, null);
  const { result } = await discoverScenario('edge');
  assert.equal(modelOf(result, '').unusable, 'the ID is empty');
  assert.equal(modelOf(result, 'acme large v2').unusable, 'the ID contains spaces');
  assert.equal(modelOf(result, 'acme-large').unusable, null);
  const oneapi = await discoverScenario('oneapi');
  assert.equal(modelOf(oneapi.result, 'my custom model').unusable, 'the ID contains spaces');
});

test('MD-03 §4.1 the edge-rows sample: digit strings, explicit "no", an output limit equal to the window', async () => {
  const { result } = await discoverScenario('edge');
  const large = modelOf(result, 'acme-large');
  assert.deepEqual([large.contextWindow, large.maxTokens], [65536, 8192]);
  assert.deepEqual([large.reasoning, large.image], [false, false]);
  assert.deepEqual(large.reported, { contextWindow: true, maxTokens: true, reasoning: true, image: true,
    family: false });
  assert.deepEqual(large.hints, ['no_tools']);
  const small = modelOf(result, 'acme-small');
  assert.deepEqual([small.contextWindow, small.maxTokens, small.reported.maxTokens], [32768, 16384, false]);
  assert.equal(modelOf(result, 'acme-embed').contextWindow, 8192);
  assert.equal(modelOf(result, 'acme large v2').contextWindow, 131072);
});

// ---- 样本：DeepSeek、OpenRouter ----

// deepseek-models.json 开始是手写的（synthetic），MD-14 的录制把它换成带 key 的真实列表（README“真实录制”一节）。
// 所以期望不按手写样本里的 id 写、也不假定每行都报告思考和图片：对样本的每一行按 §4.1 独立推算（不调用读取器），
// 两种样本都成立。种类是 deepseek（§3.3 第 2 步按主机）：没有 §4.2 的详情，LiteLLM 的假与 LoRA 一条都不适用；
// 只在列表是 Anthropic 形状时再看 max_tokens。

/** §4.1 输出上限的路径，依次 */
const MAX_TOKEN_PATHS = ['max_output_tokens', 'max_completion_tokens', 'top_provider.max_completion_tokens'];

/**
 * §4.1 思考、图片两格。报告支持：bools 里的布尔为真、objects 里的对象存在、arrays 的 [路径, 词] 里数组含其中一个词、
 * type 为 types 中的值；明确没有：bools 里的布尔为假、noArrays 里的数组存在（且上面没有一处报告支持）。
 */
const ABILITY_CELLS = Object.freeze({
  reasoning: {
    bools: ['supports_reasoning', 'capabilities.reasoning', 'capabilities.thinking.supported'],
    objects: ['effort', 'reasoning'],
    arrays: [[['capabilities', 'features', 'supported_parameters', 'model_ability', 'tags', 'metadata.tags'],
      ['reasoning', 'thinking']]],
    types: [],
    noArrays: ['capabilities', 'model_ability', 'supported_parameters'],
  },
  image: {
    bools: ['supports_image_in', 'supportsImageInput', 'capabilities.vision', 'capabilities.image_input.supported'],
    objects: [],
    arrays: [[['input_modalities', 'architecture.input_modalities', 'inference_metadata.request_modality'], ['image']],
      [['capabilities', 'model_ability', 'tags', 'metadata.tags'], ['vision', 'vlm']]],
    types: ['vlm'],
    noArrays: ['input_modalities', 'architecture.input_modalities', 'inference_metadata.request_modality',
      'capabilities', 'model_ability'],
  },
});

/** 是不是对象（不含数组与 null）：§4.1 的“对象存在”。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按 a.b.c 取值（§4.1：路径用 . 分层）；中途不是对象时为 undefined。 */
function valueAt(row, path) {
  return path.split('.').reduce((node, part) => (isPlainObject(node) ? node[part] : undefined), row);
}

/** 路径上的数组里的字符串，转成小写（§4.1“数组比较不分大小写”）；不是数组时为 null。 */
function wordsAt(row, path) {
  const value = valueAt(row, path);
  if (!Array.isArray(value)) return null;
  return value.filter((item) => typeof item === 'string').map((item) => item.toLowerCase());
}

/** 按 §4.1 的一格推算一项能力：任何一处报告支持为真；否则任何一处明确没有为假（A7）；都没有为 null（没报告）。 */
function abilityOf(row, cell) {
  const supported = cell.bools.some((path) => valueAt(row, path) === true)
    || cell.objects.some((path) => isPlainObject(valueAt(row, path)))
    || cell.arrays.some(([paths, words]) => paths.some((path) => (wordsAt(row, path) ?? [])
      .some((word) => words.includes(word))))
    || cell.types.includes(row.type);
  if (supported) return true;
  const no = cell.bools.some((path) => valueAt(row, path) === false)
    || cell.noArrays.some((path) => wordsAt(row, path) !== null);
  return no ? false : null;
}

/**
 * 按 §4.1 独立推算一行的报告值（不调用读取器）：没报告的为 null；思考、图片明确报告没有时为 false。
 * 输出上限“不小于窗口的值不算报告”：这样的值不是有效值，接着看下一条路径（§4.1、§4.3）。
 * family 为 details.family、model_family 中第一个非空字符串（同上面 family 一条的检查）。
 * @param anthropicShape 列表是 Anthropic 形状（对象有 has_more）时再看 max_tokens
 */
function reportedOf(row, anthropicShape) {
  const contextWindow = WINDOW_PATHS.map((path) => positive(valueAt(row, path))).find((value) => value !== null)
    ?? null;
  const window = contextWindow ?? 128000;
  const maxPaths = anthropicShape ? [...MAX_TOKEN_PATHS, 'max_tokens'] : MAX_TOKEN_PATHS;
  const maxTokens = maxPaths.map((path) => positive(valueAt(row, path)))
    .find((value) => value !== null && value < window) ?? null;
  const family = ['details.family', 'model_family'].map((path) => valueAt(row, path))
    .find((value) => typeof value === 'string' && value !== '') ?? null;
  return { contextWindow, maxTokens, reasoning: abilityOf(row, ABILITY_CELLS.reasoning),
    image: abilityOf(row, ABILITY_CELLS.image), family };
}

/** 清单里一行应有的值（§4.1 没报告时：窗口 128000、输出上限 16384 与窗口一半中较小的、思考与图片不勾、族为空）。 */
function listedOf(reported) {
  const contextWindow = reported.contextWindow ?? 128000;
  return {
    contextWindow, maxTokens: reported.maxTokens ?? unreportedMax(contextWindow),
    reasoning: reported.reasoning === true, image: reported.image === true, family: reported.family ?? '',
    reported: { contextWindow: reported.contextWindow !== null, maxTokens: reported.maxTokens !== null,
      reasoning: reported.reasoning !== null, image: reported.image !== null, family: reported.family !== null },
  };
}

/** 行的 id：不是字符串时为空字符串（D9）。 */
function idOf(row) {
  return typeof row.id === 'string' ? row.id : '';
}

/**
 * DeepSeek 样本的列表行，照 §3.2 与 D9：数组，或对象的 data；不是对象的行当作没有字段的行；同一个 id 只留第一次
 * 出现的；最多 1000 条（§11）。
 * @return { rows, anthropicShape, base }：base 为已有提供商的 baseUrl（样本的地址去掉结尾的 /models）
 */
function deepseekSample() {
  const { url, body } = sample('deepseek-models');
  const list = Array.isArray(body) ? body : body?.data;
  assert.ok(Array.isArray(list) && list.length > 0, `the DeepSeek sample is a model list: ${JSON.stringify(body)}`);
  const seen = new Set();
  const rows = [];
  for (const row of list.map((item) => (isPlainObject(item) ? item : {}))) {
    if (seen.has(idOf(row))) continue;
    seen.add(idOf(row));
    rows.push(row);
  }
  return { rows: rows.slice(0, 1000), anthropicShape: isPlainObject(body) && 'has_more' in body,
    base: url.replace(/\/models$/, '') };
}

test('MD-03 §4.1 the DeepSeek sample: window, output limit, thinking, image and family agree with each of its rows',
  async () => {
    const { rows, anthropicShape } = deepseekSample();
    const { result } = await discoverScenario('deepseek');
    assert.equal(result.server.kind, 'deepseek');
    assert.deepEqual(result.models.map((model) => model.id), rows.map(idOf));
    assert.equal(result.anthropicShape, anthropicShape);
    for (const row of rows) {
      const { contextWindow, maxTokens, reasoning, image, family, reported } = modelOf(result, idOf(row));
      assert.deepEqual({ contextWindow, maxTokens, reasoning, image, family, reported },
        listedOf(reportedOf(row, anthropicShape)), idOf(row));
    }
  });

test('MD-12 §7.1 step 0 on each row of the DeepSeek sample gives its reported window, max output, thinking, image',
  async () => {
    const { rows, anthropicShape, base } = deepseekSample();
    const { discoverReader } = readerWith(table(SCENARIOS.deepseek.routes()));
    for (const row of rows) {
      const read = await discoverReader.single(providerRequest(base, 'openai-completions'), idOf(row),
        new AbortController().signal);
      // §7.2：meta 为报告值，没报告为 null；reported 为报告的窗口
      const { contextWindow, maxTokens, reasoning, image } = reportedOf(row, anthropicShape);
      assert.deepEqual(read, { kind: 'deepseek', version: null, reported: contextWindow,
        meta: { maxTokens, reasoning, image } }, idOf(row));
    }
  });

/** §4.1 里 OpenRouter 的行没有的路径：有的话下面的独立推算就不完整 */
const NOT_IN_OPENROUTER = ['max_model_len', 'context_window', 'meta', 'max_context_length', 'context_size',
  'max_input_tokens', 'metadata', 'max_output_tokens', 'max_completion_tokens', 'supports_reasoning', 'capabilities',
  'effort', 'features', 'model_ability', 'tags', 'input_modalities', 'inference_metadata', 'supports_image_in',
  'supportsImageInput', 'type', 'details', 'model_family', 'mode', 'model_type', 'output_modalities',
  'supported_endpoint_types', 'supports_function_calling'];

/** 正整数（§4.1：包括只含数字的字符串），否则 null。 */
function positive(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** 按 §4.1 独立推算 OpenRouter 一行应读出的值（只用这份样本有的路径）。 */
function openrouterExpected(row) {
  const reported = positive(row.context_length) ?? positive(row.top_provider?.context_length);
  const window = reported ?? 128000;
  const max = positive(row.top_provider?.max_completion_tokens);
  const params = row.supported_parameters.map((word) => word.toLowerCase());
  const outputs = row.architecture.output_modalities.map((word) => word.toLowerCase());
  return {
    contextWindow: window, maxTokens: max !== null && max < window ? max : unreportedMax(window),
    reasoning: (typeof row.reasoning === 'object' && row.reasoning !== null) || params.includes('reasoning')
      || params.includes('thinking'),
    image: row.architecture.input_modalities.map((word) => word.toLowerCase()).includes('image'),
    chat: outputs.includes('text') ? null : false,
    reported: { contextWindow: reported !== null, maxTokens: max !== null && max < window, reasoning: true,
      image: true, family: false },
    hints: params.includes('tools') ? [] : ['no_tools'],
  };
}

test('MD-03 §4.1 the real OpenRouter recording reads every row as the sample says', async () => {
  const recording = sample('openrouter-models');
  assert.equal(recording.source, 'real');
  const { result } = await discoverScenario('openrouter');
  assert.equal(result.server.kind, 'openrouter');
  assert.equal(result.models.length, recording.body.data.length);
  assert.ok(result.models.length > 400);
  for (const row of recording.body.data) {
    for (const key of NOT_IN_OPENROUTER) assert.equal(key in row, false, `${row.id} has ${key}`);
    const model = modelOf(result, row.id);
    const { contextWindow, maxTokens, reasoning, image, chat, reported, hints } = model;
    assert.deepEqual({ contextWindow, maxTokens, reasoning, image, chat, reported, hints }, openrouterExpected(row),
      row.id);
  }
  // 样本里两种值都有，推算不是只走一边
  const values = (pick) => new Set(result.models.map(pick));
  assert.deepEqual(values((model) => model.image), new Set([true, false]));
  assert.deepEqual(values((model) => model.reasoning), new Set([true, false]));
  assert.deepEqual(values((model) => model.reported.maxTokens), new Set([true, false]));
  assert.deepEqual(values((model) => model.hints.length), new Set([0, 1]));
});
