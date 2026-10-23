// MD-02 服务种类（docs/specs/model-discovery.md §3.3，§13.2 单元层）：§3.3 每一条按顺序判断，各用一份响应体样本；
// LocalAI、TensorRT-LLM 不再是 vLLM；第 6 步的响应不重复请求；版本按 §3.3 读，已有种类的档案键不变；默认合成端点
// （owned_by 改成 vllm 后）认作 vllm、档案键不变。样本在 tests/fixtures/discovery/bodies/（README.md 写明来源与应得）；
// 默认合成端点的回答直接取 tests/fake-endpoint/discovery.mjs 的 listAnswer、detailAnswer（synthetic，规格 §13.1）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailAnswer, isListPath, listAnswer, listServed } from '../../fake-endpoint/discovery.mjs';
import { loadKernelModule } from '../load.mjs';
import {
  SCENARIOS, STEP6_PATHS, countOf, discoverScenario, discoverWith, newRequest, openaiList, providerRequest,
  readerWith, rules, sample, samples, table, urlsOf,
} from './rules-helpers.mjs';

const { profileKey, UNKNOWN_VERSION } = await loadKernelModule('src/kernel/modelProfiles.ts');
const shared = await loadKernelModule('src/shared/models.ts');

/** 新建 Headers（§3.3 第 1 步看响应头）。 */
function headersOf(entries = {}) {
  return new Headers(entries);
}

/** §3.3 第 1–5 步要看的列表信息。 */
function facts(rows, { host = '192.0.2.50', headers = {}, body = { data: rows } } = {}) {
  return { newApi: rules.newApiMarked(headersOf(headers), body), host, rows };
}

/** 第 6 步各路径都请求了一次。 */
function assertStep6Once(calls, origin, label) {
  for (const path of STEP6_PATHS) assert.equal(countOf(calls, `${origin}${path}`), 1, `${label} ${path}`);
}

/** 第 6 步的路径一个也没请求。 */
function assertNoStep6(calls, origin, label) {
  for (const path of STEP6_PATHS) assert.equal(countOf(calls, `${origin}${path}`), 0, `${label} ${path}`);
}

// ---- 每个种类各用一份样本 ----

/** 种类 → [场景, 版本]：版本按 §3.3 读（sglang 的 /version 为手写，见 rules-helpers.mjs 的 SCENARIOS） */
const KIND_SAMPLES = [
  ['vllm', 'vllm', '0.32.0'], ['sglang', 'sglang', '0.5.9'], ['llamacpp', 'llamacpp', 'b9104-6d1f0a2'],
  ['llamacppRouter', 'llamacpp', 'b9104-6d1f0a2'], ['ollama', 'ollama', '0.40.9'], ['lmstudio', 'lmstudio', null],
  ['xinference', 'xinference', null], ['gpustack', 'gpustack', null], ['mindie', 'mindie', null],
  ['tgi', 'tgi', null], ['lmdeploy', 'lmdeploy', null], ['localai', 'localai', null],
  ['tensorrt', 'tensorrt', null], ['litellm', 'litellm', null], ['newapi', 'newapi', null],
  ['oneapi', 'oneapi', null], ['deepseek', 'deepseek', null], ['moonshot', 'moonshot', null],
  ['dashscope', 'dashscope', null], ['qianfan', 'qianfan', null], ['openrouter', 'openrouter', null],
  ['anthropic', 'anthropic', null], ['together', 'unknown', null], ['mistral', 'unknown', null],
  ['edge', 'unknown', null], ['deepinfra', 'unknown', null],
];

test('MD-02 §3.3 every server kind is recognised from its body sample, with the version §3.3 reads', async () => {
  const seen = new Set();
  for (const [scenario, kind, version] of KIND_SAMPLES) {
    const { result } = await discoverScenario(scenario);
    assert.equal(result.listError, null, scenario);
    assert.deepEqual(result.server, { kind, version }, scenario);
    seen.add(kind);
  }
  // 每个种类都至少有一份样本
  assert.deepEqual([...shared.SERVER_KINDS].filter((kind) => !seen.has(kind)), []);
});

// ---- 第 1 步：New API ----

test('MD-02 §3.3 step 1: X-New-Api-Version or success: true is New API, before host and owned_by', () => {
  const rows = [{ id: 'gpt-4o', owned_by: 'vllm', created: 1677610602 }];
  const versionHeader = { 'X-New-Api-Version': 'v0.9.6' };
  assert.equal(rules.judgeListKind(facts(rows, { headers: versionHeader })), 'newapi');
  assert.equal(rules.judgeListKind(facts(rows, { body: { success: true, data: rows } })), 'newapi');
  assert.equal(rules.judgeListKind(facts(rows, { host: 'api.deepseek.com', headers: versionHeader })), 'newapi');
  assert.equal(rules.judgeListKind(facts(rows, { body: { success: 'true', data: rows } })), 'vllm');
  assert.equal(rules.judgeListKind(facts(rows, { body: { success: false, data: rows } })), 'vllm');
});

test('MD-02 §3.3 step 1: the New API sample is New API with only the header or only success', async () => {
  const { url, status, headers, body } = sample('newapi-models');
  const request = newRequest(SCENARIOS.newapi.raw);
  const headerOnly = await discoverWith(table([[url, { status, headers, body: { ...body, success: undefined } }]]),
    request);
  assert.equal(headerOnly.result.server.kind, 'newapi');
  const successOnly = await discoverWith(table([[url, { status, body }]]), request);
  assert.equal(successOnly.result.server.kind, 'newapi');
  // New API 按 Anthropic 形状回答时没有 success，仍有响应头
  const anthropic = sample('newapi-models-anthropic');
  const shaped = await discoverWith(table([[anthropic.url, anthropic]]),
    providerRequest('http://192.0.2.24:3000', 'anthropic-messages'));
  assert.deepEqual(shaped.result.server, { kind: 'newapi', version: null });
  assert.equal(shaped.result.anthropicShape, true);
});

// ---- 第 2 步：主机 ----

test('MD-02 §3.3 step 2: hosts name the cloud kinds, before owned_by', () => {
  const rows = [{ id: 'some-model', owned_by: 'vllm' }];
  const hosts = [['api.deepseek.com', 'deepseek'], ['api.moonshot.cn', 'moonshot'], ['api.moonshot.ai', 'moonshot'],
    ['api.kimi.com', 'moonshot'], ['dashscope.aliyuncs.com', 'dashscope'], ['dashscope-intl.aliyuncs.com', 'dashscope'],
    ['ws-1a2b.cn-beijing.dashscope.aliyuncs.com', 'dashscope'], ['bailian-ws.cn-hangzhou.maas.aliyuncs.com',
      'dashscope'], ['qianfan.baidubce.com', 'qianfan'], ['openrouter.ai', 'openrouter'],
    ['api.anthropic.com', 'anthropic']];
  for (const [host, kind] of hosts) assert.equal(rules.judgeListKind(facts(rows, { host })), kind, host);
  // 只认这些主机：子串、相似的主机不算
  for (const host of ['deepseek.com', 'api.deepseek.com.example.test', 'moonshot.cn', 'maas.aliyuncs.com',
    'aliyuncs.com', 'www.openrouter.ai', 'anthropic.com']) {
    assert.equal(rules.judgeListKind(facts(rows, { host })), 'vllm', host);
  }
});

test('MD-02 §3.3 step 2: the Kimi host variants and the international Model Studio host are recognised', async () => {
  const body = sample('moonshot-models').body;
  for (const [raw, kind] of [['https://api.moonshot.ai/v1', 'moonshot'], ['https://api.kimi.com/v1', 'moonshot'],
    ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'dashscope']]) {
    const base = rules.normalizeBaseUrl(raw).base;
    const { result } = await discoverWith(table([[`${base}/models`, { status: 200, body }]]), newRequest(raw));
    assert.equal(result.server.kind, kind, raw);
  }
});

// ---- 第 3 步：第一行的 owned_by ----

test('MD-02 §3.3 step 3: the first row\'s owned_by names the self-hosted kinds', () => {
  const owners = [['vllm', 'vllm'], ['sglang', 'sglang'], ['llamacpp', 'llamacpp'], ['lmdeploy', 'lmdeploy'],
    ['xinference', 'xinference'], ['tensorrt_llm', 'tensorrt'], ['MindIE Server', 'mindie'], ['gpustack', 'gpustack']];
  for (const [owner, kind] of owners) {
    assert.equal(rules.judgeListKind(facts([{ id: 'm', owned_by: owner }])), kind, owner);
  }
  // 只看第一行；值要完全相同
  assert.equal(rules.judgeListKind(facts([{ id: 'a', owned_by: 'acme' }, { id: 'b', owned_by: 'vllm' }])), null);
  for (const owner of ['VLLM', 'mindie', 'tensorrt', 'llama.cpp']) {
    assert.equal(rules.judgeListKind(facts([{ id: 'm', owned_by: owner }])), null, owner);
  }
  // 第 3 步在第 4 步之前
  assert.equal(rules.judgeListKind(facts([{ id: 'm', owned_by: 'vllm', created: 1677610602 }])), 'vllm');
});

// ---- 第 4、5 步：LiteLLM、One API ----

test('MD-02 §3.3 step 4: every row created 1677610602 is LiteLLM', () => {
  const rows = sample('litellm-models').body.data;
  assert.equal(rules.judgeListKind(facts(rows)), 'litellm');
  assert.equal(rules.judgeListKind(facts([...rows, { id: 'other', created: 1677610603 }])), null);
  assert.equal(rules.judgeListKind(facts([...rows, { id: 'no-created' }])), null);
});

test('MD-02 §3.3 step 5: every row created 1626777600 with a permission field is One API', () => {
  const rows = sample('oneapi-models').body.data;
  // 自定义模型的 permission 为 null，也算有这个字段
  assert.equal(rows.at(-1).permission, null);
  assert.equal(rules.judgeListKind(facts(rows)), 'oneapi');
  assert.equal(rules.judgeListKind(facts([...rows, { id: 'x', created: 1626777600 }])), null);
  assert.equal(rules.judgeListKind(facts([...rows, { id: 'y', created: 1626777601, permission: [] }])), null);
});

test('MD-02 §3.3 steps 4 and 5 need a non-empty list (D7)', () => {
  assert.equal(rules.judgeListKind(facts([])), null);
});

// ---- 第 6 步 ----

test('MD-02 §3.3 step 6 runs only when steps 1 to 5 decide nothing, with five parallel GETs', async () => {
  for (const name of ['vllm', 'litellm', 'oneapi', 'newapi', 'deepseek', 'mindie']) {
    const { calls } = await discoverScenario(name);
    assertNoStep6(calls, new URL(SCENARIOS[name].raw).origin, name);
  }
  for (const name of ['together', 'mistral', 'edge', 'deepinfra', 'localai', 'ollama', 'lmstudio', 'tgi']) {
    const { calls } = await discoverScenario(name);
    assertStep6Once(calls, new URL(SCENARIOS[name].raw).origin, name);
  }
});

test('MD-02 §3.3 step 6: LocalAI, Ollama, llama.cpp, LM Studio and TGI from their own answers', async () => {
  const rows = { status: 200, body: openaiList(['local-model']) };
  const props = sample('llamacpp-props');
  const cases = [
    ['localai', samples('localai-models', 'localai-well-known')],
    ['ollama', samples('ollama-v1-models', 'ollama-api-version')],
    ['llamacpp', [['http://192.0.2.51:8080/v1/models', rows], ['http://192.0.2.51:8080/props', props]]],
    ['lmstudio', samples('lmstudio-v1-models', 'lmstudio-api-v1-models')],
    ['tgi', samples('tgi-models', 'tgi-info')],
  ];
  for (const [kind, routes] of cases) {
    const raw = routes[0][0].replace(/\/models$/, '');
    const { result } = await discoverWith(table(routes), newRequest(raw));
    assert.equal(result.server.kind, kind, kind);
  }
});

test('MD-02 §3.3 step 6 is judged in order: LocalAI, Ollama, llama.cpp, LM Studio, TGI', () => {
  const ollamaRows = sample('ollama-v1-models').body.data;
  const all = new Map([['/.well-known/localai.json', { version: 'v4.12.0' }], ['/api/version', { version: '0.40.9' }],
    ['/props', { build_info: 'b9104-6d1f0a2' }], ['/api/v1/models', { models: [{ key: 'qwen/qwen3-8b' }] }],
    ['/info', { router: 'text-generation-router' }]]);
  const order = ['localai', 'ollama', 'llamacpp', 'lmstudio', 'tgi'];
  for (const [index, kind] of order.entries()) {
    const probes = new Map([...all].filter(([path]) => STEP6_PATHS.indexOf(path) >= index));
    assert.equal(rules.judgeProbedKind(probes, ollamaRows), kind, kind);
  }
  assert.equal(rules.judgeProbedKind(new Map(), ollamaRows), 'unknown');
  // Ollama 还要列表第一行有 owned_by 和 created
  const noCreated = sample('lmstudio-v1-models').body.data;
  assert.equal(rules.judgeProbedKind(new Map([['/api/version', { version: '0.40.9' }]]), noCreated), 'unknown');
  // 各条件要的字段
  assert.equal(rules.judgeProbedKind(new Map([['/.well-known/localai.json', { name: 'x' }]]), []), 'unknown');
  assert.equal(rules.judgeProbedKind(new Map([['/props', { n_ctx: 8192 }]]), []), 'unknown');
  assert.equal(rules.judgeProbedKind(new Map([['/api/v1/models', { models: [{ id: 'x' }] }]]), []), 'unknown');
  assert.equal(rules.judgeProbedKind(new Map([['/info', { router: 'other-router' }]]), []), 'unknown');
});

test('MD-02 §3.3 step 6 bodies are not requested twice (version and §4.2 details reuse them)', async () => {
  const cases = [
    ['ollama', ['/api/version']], ['lmstudio', ['/api/v1/models']], ['tgi', ['/info']],
    ['localai', ['/.well-known/localai.json']],
  ];
  for (const [name, paths] of cases) {
    const { calls } = await discoverScenario(name);
    const origin = new URL(SCENARIOS[name].raw).origin;
    for (const path of paths) assert.equal(countOf(calls, `${origin}${path}`), 1, `${name} ${path}`);
    // 每个 GET 只发一次（Ollama 的 POST /api/show 是每个模型一次，正文不同）
    const gets = urlsOf(calls.filter((call) => call.method === 'GET'));
    assert.deepEqual(gets.filter((url, index) => gets.indexOf(url) !== index), [], name);
  }
  // llama.cpp 由第 6 步的 /props 认出：版本与详情都用这一个响应
  const routes = [['http://192.0.2.51:8080/v1/models', { status: 200, body: openaiList(['local-model']) }],
    ['http://192.0.2.51:8080/props', sample('llamacpp-props')]];
  const { result, calls } = await discoverWith(table(routes), newRequest('http://192.0.2.51:8080/v1'));
  assert.deepEqual(result.server, { kind: 'llamacpp', version: 'b9104-6d1f0a2' });
  assert.equal(countOf(calls, 'http://192.0.2.51:8080/props'), 1);
  assert.equal(result.models[0].contextWindow, 8192);
  assert.equal(result.models[0].image, true);
});

/** @brief 一段请求里重复的 GET 地址（POST 不算：Ollama 的 /api/show 每个模型一次，正文不同）。 */
function repeatedGets(calls) {
  const gets = urlsOf(calls.filter((call) => call.method === 'GET'));
  return gets.filter((url, index) => gets.indexOf(url) !== index);
}

test('MD-02 §3.3 step 6 bodies are not requested twice in probe step 0 and version reads either', async () => {
  const llamacppRoutes = [['http://192.0.2.51:8080/v1/models', { status: 200, body: openaiList(['local-model']) }],
    ['http://192.0.2.51:8080/props', sample('llamacpp-props')]];
  const cases = [
    ['ollama', SCENARIOS.ollama.routes(), 'qwen3:8b', ['/api/version']],
    ['lmstudio', SCENARIOS.lmstudio.routes(), 'google/gemma-4-26b-a4b', ['/api/v1/models']],
    ['tgi', SCENARIOS.tgi.routes(), 'meta-llama/Llama-3.1-8B-Instruct', ['/info']],
    ['localai', SCENARIOS.localai.routes(), 'qwen3-8b', ['/.well-known/localai.json']],
    ['llamacpp', llamacppRoutes, 'local-model', ['/props']],
  ];
  for (const [kind, routes, id, paths] of cases) {
    const base = routes[0][0].replace(/\/models$/, '');
    const origin = new URL(base).origin;
    const { discoverReader, calls } = readerWith(table(routes));
    const target = providerRequest(base, 'openai-completions');
    const read = await discoverReader.single(target, id, new AbortController().signal);
    assert.equal(read.kind, kind, `${kind} step 0`);
    const stepZero = calls.splice(0);
    assertStep6Once(stepZero, origin, `${kind} step 0`);
    for (const path of paths) assert.equal(countOf(stepZero, `${origin}${path}`), 1, `${kind} step 0 ${path}`);
    assert.deepEqual(repeatedGets(stepZero), [], `${kind} step 0`);
    const version = await discoverReader.version(target, new AbortController().signal);
    assert.equal(version.kind, kind, `${kind} version read`);
    assertStep6Once(calls, origin, `${kind} version read`);
    assert.deepEqual(repeatedGets(calls), [], `${kind} version read`);
  }
});

// ---- 不再只凭 /version 认 vLLM ----

test('MD-02 §3.3 LocalAI and TensorRT-LLM answer /version but are not vLLM, and /version is not read', async () => {
  for (const [name, kind] of [['localai', 'localai'], ['tensorrt', 'tensorrt']]) {
    const { result, calls } = await discoverScenario(name);
    assert.deepEqual(result.server, { kind, version: null }, name);
    assert.equal(countOf(calls, `${new URL(SCENARIOS[name].raw).origin}/version`), 0, name);
  }
});

test('MD-02 §3.3 the synthetic endpoint\'s localai and tensorrt shapes are not vLLM either', async () => {
  for (const shape of ['localai', 'tensorrt']) {
    const { discoverReader, calls } = readerWith(fakeEndpoint(shape));
    const read = await discoverReader.version(providerRequest(FAKE_BASE, 'openai-completions'),
      new AbortController().signal);
    assert.deepEqual(read, { listed: true, kind: shape, version: null, versionRead: false }, shape);
    assert.equal(countOf(calls, 'http://127.0.0.1:4319/version'), 0, shape);
  }
});

// ---- 版本与档案键 ----

test('MD-02 §3.3 versions: vLLM and SGLang /version, Ollama /api/version, llama.cpp /props build_info', async () => {
  const cases = [['vllm', '/version'], ['sglang', '/version'], ['ollama', '/api/version'], ['llamacpp', '/props']];
  for (const [name, path] of cases) {
    const { calls } = await discoverScenario(name);
    assert.equal(countOf(calls, `${new URL(SCENARIOS[name].raw).origin}${path}`), 1, name);
  }
  // 其他种类没有版本请求
  for (const name of ['deepseek', 'openrouter', 'xinference', 'gpustack', 'mindie', 'lmdeploy', 'litellm']) {
    const { calls } = await discoverScenario(name);
    assert.equal(countOf(calls, `${new URL(SCENARIOS[name].raw).origin}/version`), 0, name);
  }
  // 版本请求失败时版本为 null，种类不变
  const failed = await discoverScenario('vllm', [['http://192.0.2.10:8000/version', { status: 500, body: 'x' }]]);
  assert.deepEqual(failed.result.server, { kind: 'vllm', version: null });
  for (const [kind, body] of [['vllm', { version: '' }], ['llamacpp', { n_ctx: 1 }], ['unknown', { version: '1' }]]) {
    assert.equal(rules.versionOf(kind, body), null, kind);
  }
});

/** 档案对应的目标（modelProfiles.ts 的 ProfileTarget）。 */
function profileTarget(baseUrl, id) {
  return { baseUrl, api: 'openai-completions', model: { id }, compat: {} };
}

test('MD-02 §3.3 profile keys of the kinds that existed before keep the same version part', async () => {
  // 原来的读法（模型层规格 §7.1）：vllm、sglang 的 /version，ollama 的 /api/version，llamacpp 的 /props，其他 unknown
  const cases = [['vllm', 'Qwen/Qwen3-32B', '0.32.0'], ['sglang', 'Qwen/Qwen3-8B', '0.5.9'],
    ['ollama', 'qwen3:8b', '0.40.9'], ['llamacpp', 'gemma-3-4b-it-Q4_K_M.gguf', 'b9104-6d1f0a2'],
    ['edge', 'acme-small', UNKNOWN_VERSION]];
  for (const [name, id, version] of cases) {
    const base = rules.normalizeBaseUrl(SCENARIOS[name].raw).base;
    const { discoverReader } = readerWith(table(SCENARIOS[name].routes()));
    const read = await discoverReader.single(providerRequest(base, 'openai-completions'), id,
      new AbortController().signal);
    assert.equal(profileKey(profileTarget(base, id), read.version), `${base}|openai-completions|${id}|${version}`,
      name);
  }
});

// ---- 默认合成端点 ----

/** 合成端点在单元测试里的地址（只用作字符串，不监听端口） */
const FAKE_BASE = 'http://127.0.0.1:4319/v1';

/**
 * @brief 合成端点（tests/fake-endpoint/discovery.mjs）的回答，经替身 fetch（synthetic）：默认环境同 server.mjs
 *        （FAKE_MODELS "fake-coder,fake-slow"、FAKE_MAX_MODEL_LEN 131072、FAKE_SERVER_VERSION "0.10.1"）。
 * @param shape FAKE_LIST_SHAPE
 */
function fakeEndpoint(shape) {
  const env = { shape, noV1Root: false, models: ['fake-coder', 'fake-slow'], maxModelLen: 131072, version: '0.10.1' };
  return (call) => {
    const { pathname } = new URL(call.url);
    if (call.method === 'GET' && isListPath(pathname)) {
      return listServed(pathname, env) ? listAnswer(call.headers, env, null) : undefined;
    }
    return detailAnswer(call.method, pathname, call.body ? JSON.parse(call.body) : null, env) ?? undefined;
  };
}

test('MD-02 §3.3 the default synthetic endpoint (owned_by vllm) is vLLM and its profile key is unchanged', async () => {
  const { discoverReader, calls } = readerWith(fakeEndpoint('vllm'));
  const target = providerRequest(FAKE_BASE, 'openai-completions');
  const read = await discoverReader.single(target, 'fake-coder', new AbortController().signal);
  assert.equal(read.kind, 'vllm');
  assert.equal(read.version, '0.10.1');
  assert.equal(read.reported, 131072);
  assert.equal(profileKey(profileTarget(FAKE_BASE, 'fake-coder'), read.version),
    'http://127.0.0.1:4319/v1|openai-completions|fake-coder|0.10.1');
  assert.deepEqual(urlsOf(calls), ['http://127.0.0.1:4319/v1/models', 'http://127.0.0.1:4319/version']);
  const version = await discoverReader.version(target, new AbortController().signal);
  assert.deepEqual(version, { listed: true, kind: 'vllm', version: '0.10.1', versionRead: true });
  const { result } = await discoverWith(fakeEndpoint('vllm'), newRequest(FAKE_BASE));
  assert.deepEqual(result.server, { kind: 'vllm', version: '0.10.1' });
});

// ---- 界面显示的名字 ----

test('MD-02 §3.3 the Detected line names every kind as the spec lists them', () => {
  const labels = {
    vllm: 'vLLM', sglang: 'SGLang', llamacpp: 'llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio',
    xinference: 'Xinference', gpustack: 'GPUStack', mindie: 'MindIE', tgi: 'TGI', lmdeploy: 'LMDeploy',
    localai: 'LocalAI', tensorrt: 'TensorRT-LLM', litellm: 'LiteLLM', newapi: 'New API', oneapi: 'One API',
    deepseek: 'DeepSeek', moonshot: 'Moonshot AI', dashscope: 'Alibaba Cloud Model Studio',
    qianfan: 'Baidu Qianfan', openrouter: 'OpenRouter', anthropic: 'Anthropic', unknown: 'OpenAI-compatible server',
  };
  assert.deepEqual({ ...shared.SERVER_KIND_LABELS }, labels);
  for (const [kind, label] of Object.entries(labels)) assert.equal(shared.serverKindLabel(kind, false), label, kind);
  assert.equal(shared.serverKindLabel('unknown', true), 'Anthropic-compatible server');
  assert.equal(shared.serverKindLabel('newapi', true), 'New API');
  assert.equal(shared.serverKindLabel('anthropic', true), 'Anthropic');
});
