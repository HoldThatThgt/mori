// 读取规则单元测试（docs/specs/model-discovery.md §13.1、§13.2 的 MD-01…MD-05）共用的工具：读响应体样本
// （tests/fixtures/discovery/bodies/，README.md 写明每个样本的来源与应得）、替身 fetch（synthetic：按地址回答样本或
// 手写的响应，记下每个请求的地址、方法、请求头与正文），以及按样本配好路由的发现场景。
// 替身 fetch 只在单元测试里用，依据是规格 §13.1“modelDiscover.ts 用替身 fetch 检查请求顺序、认证头”。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernelModule } from '../load.mjs';

const bodiesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'discovery', 'bodies');

/** discoverRead.ts 的导出（纯函数的规则） */
export const rules = await loadKernelModule('src/kernel/discoverRead.ts');
/** modelDiscover.ts 的导出（DiscoverReader） */
export const reader = await loadKernelModule('src/kernel/modelDiscover.ts');

/** 测试用的假 key（synthetic，不是任何服务的 key） */
export const TEST_KEY = 'sk-unit-rules-0042-synthetic';

/** 规格 §11 的发现请求时限（毫秒） */
export const DISCOVER_TIMEOUT_MS = 15_000;

/**
 * @brief 读一个响应体样本。
 * @param name 文件名（不含 .json）
 * @return { url, status, headers, body, source, synthetic }
 */
export function sample(name) {
  const file = JSON.parse(readFileSync(join(bodiesDir, `${name}.json`), 'utf8'));
  return { url: file.url, status: file.status, headers: file.headers ?? {}, body: file.body, source: file.source,
    synthetic: file.synthetic === true };
}

/**
 * @brief 替身 fetch 的一个回答（synthetic）。
 * @param spec { status, body, headers, statusText } 回答；{ fail: '<原文>' } 连接失败；{ hang: true } 不回答
 */
async function respond(spec) {
  if (spec.fail) throw new TypeError('fetch failed', { cause: new Error(spec.fail) });
  if (spec.hang) return new Promise(() => {});
  const text = spec.body === undefined || spec.body === null ? ''
    : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  return new Response(text, { status: spec.status ?? 200, statusText: spec.statusText ?? '',
    headers: spec.headers ?? {} });
}

/** 没有路由的请求的回答：404（synthetic） */
const NOT_FOUND = Object.freeze({ status: 404, statusText: 'Not Found', body: '404 page not found' });

/**
 * @brief 替身 fetch（synthetic）：handler(call) 给出回答，返回 undefined 时为 404。
 * @param handler (call) => spec；call 为 { url, method, headers（小写键的对象）, body, redirect }
 * @return { fetch, calls }：calls 按发出的顺序
 */
export function stubFetch(handler) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers ?? {})), body: init.body ?? null,
      redirect: init.redirect };
    calls.push(call);
    return respond((await handler(call)) ?? NOT_FOUND);
  };
  return { fetch, calls };
}

/**
 * @brief 按地址回答的路由：键为完整地址（GET）或 "POST <地址>"；值为回答，或 (call) => 回答。
 * @param entries [[键, 值]]
 */
export function table(entries) {
  const map = new Map(entries);
  return (call) => {
    const route = map.get(call.method === 'GET' ? call.url : `${call.method} ${call.url}`);
    return typeof route === 'function' ? route(call) : route;
  };
}

/** @brief 样本作为回答：键为样本的地址。 */
export function routeOf(name) {
  const { url, status, headers, body } = sample(name);
  return [url, { status, headers, body }];
}

/** @brief 几个样本组成的路由表。 */
export function samples(...names) {
  return names.map(routeOf);
}

/**
 * @brief 新建一个读取器，用替身 fetch。
 * @param handler 替身 fetch 的回答
 * @param timeoutMs 每个请求的时限
 * @return { discoverReader, calls }
 */
export function readerWith(handler, timeoutMs = DISCOVER_TIMEOUT_MS) {
  const stub = stubFetch(handler);
  const discoverReader = new reader.DiscoverReader({ timings: { discoverRequestTimeoutMs: timeoutMs },
    fetch: stub.fetch });
  return { discoverReader, calls: stub.calls };
}

/**
 * @brief 新提供商的一次发现（§5.1 kind: 'new'）：地址按 §3.1 整理（同 modelCommands.ts 的 newTarget）。
 * @param raw 表单里填的 Base URL
 * @param options { secret, api }：key 的明文与你改过的 API type，默认都没有
 */
export function newRequest(raw, { secret = null, api = null } = {}) {
  const normalized = rules.normalizeBaseUrl(raw);
  if (!normalized) throw new Error(`not an http or https URL: ${raw}`);
  return { base: normalized.base, anthropicHint: normalized.anthropicHint, existing: false, secret, shareKey: null,
    api, configured: [] };
}

/**
 * @brief 已有提供商的一次发现（§5.1 kind: 'provider'）：地址与 api 用配置里的，不整理（同 modelLayer.ts 的 readTarget）。
 * @param options { secret, configured }：key 的明文、配置里的模型 id
 */
export function providerRequest(baseUrl, api, { secret = null, configured = [] } = {}) {
  return { base: baseUrl, anthropicHint: api === 'anthropic-messages', existing: true, secret,
    shareKey: `${baseUrl}|${api}|key-1`, api, configured };
}

/**
 * @brief 跑一次 models.discover（DiscoverReader.command）。
 * @param handler 替身 fetch 的回答
 * @param request newRequest 或 providerRequest 的结果
 * @param timeoutMs 每个请求的时限
 * @return { result, calls }
 */
export async function discoverWith(handler, request, timeoutMs = DISCOVER_TIMEOUT_MS) {
  const { discoverReader, calls } = readerWith(handler, timeoutMs);
  const result = await discoverReader.command(request);
  return { result, calls };
}

/**
 * @brief 记下这个测试里 console.error 的每一行（读取器的失败日志，§4.2“记一行日志”），测试结束时还原。
 *        同一个文件里的测试依次运行，所以换掉 console.error 不影响别的测试。
 * @param t node:test 的测试上下文
 * @return 记下的行（随日志增长）
 */
export function captureErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

/** @brief 结果里 id 为 id 的模型；没有时抛错。 */
export function modelOf(result, id) {
  const model = result.models.find((item) => item.id === id);
  if (!model) throw new Error(`model ${id} is not in the result (${result.models.map((m) => m.id).join(', ')})`);
  return model;
}

/** @brief 请求的地址，按发出的顺序（POST 前面加 "POST "）。 */
export function urlsOf(calls) {
  return calls.map((call) => (call.method === 'GET' ? call.url : `${call.method} ${call.url}`));
}

/** @brief 某个地址被请求的次数。 */
export function countOf(calls, url) {
  return calls.filter((call) => call.url === url).length;
}

/** @brief 每个请求的 origin。 */
export function originsOf(calls) {
  return [...new Set(calls.map((call) => new URL(call.url).origin))];
}

/** §3.3 第 6 步的五个路径（按判断顺序） */
export const STEP6_PATHS = Object.freeze(['/.well-known/localai.json', '/api/version', '/props', '/api/v1/models',
  '/info']);

/** Ollama 的 /api/show 样本，按模型 id */
const OLLAMA_SHOWS = Object.freeze({
  'qwen3:8b': 'ollama-show-qwen3-8b', 'gemma2:9b': 'ollama-show-gemma2-9b', 'llava:7b': 'ollama-show-llava-7b',
  'nomic-embed-text:latest': 'ollama-show-nomic-embed-text',
});

/** @brief Ollama 的 POST /api/show（{ "model": <id> }）：按正文里的模型回答样本，不认识的模型 404（同 Ollama）。 */
export function ollamaShow(call) {
  const name = OLLAMA_SHOWS[JSON.parse(call.body ?? '{}').model];
  if (!name) return { status: 404, body: { error: 'model not found' } };
  const { status, body } = sample(name);
  return { status, body };
}

/**
 * @brief 各种类的发现场景：raw 为表单里填的地址，routes 为样本组成的路由（地址都取自样本的 url）。
 *        sglang 的 /version 是手写的（synthetic，依据模型层规格 §7.1：SGLang 读 GET <origin>/version 的 version）。
 */
export const SCENARIOS = Object.freeze({
  vllm: { raw: 'http://192.0.2.10:8000/v1', routes: () => samples('vllm-models', 'vllm-version') },
  sglang: { raw: 'http://192.0.2.11:30000/v1', routes: () => [...samples('sglang-models', 'sglang-model-info'),
    ['http://192.0.2.11:30000/version', { status: 200, body: { version: '0.5.9' } }]] },
  llamacpp: { raw: 'http://192.0.2.12:8080/v1', routes: () => samples('llamacpp-models', 'llamacpp-props') },
  llamacppRouter: { raw: 'http://192.0.2.13:8080/v1',
    routes: () => samples('llamacpp-router-models', 'llamacpp-router-props') },
  ollama: { raw: 'http://192.0.2.14:11434/v1', routes: () => [...samples('ollama-v1-models', 'ollama-api-version',
    'ollama-tags', 'ollama-ps'), ['POST http://192.0.2.14:11434/api/show', ollamaShow]] },
  ollamaNoCaps: { raw: 'http://192.0.2.14:11434/v1', routes: () => [...samples('ollama-v1-models',
    'ollama-api-version', 'ollama-tags-nocaps', 'ollama-ps'), ['POST http://192.0.2.14:11434/api/show', ollamaShow]] },
  lmstudio: { raw: 'http://192.0.2.15:1234/v1',
    routes: () => samples('lmstudio-v1-models', 'lmstudio-api-v1-models') },
  xinference: { raw: 'http://192.0.2.16:9997/v1', routes: () => samples('xinference-models') },
  gpustack: { raw: 'http://192.0.2.17/v1', routes: () => samples('gpustack-models', 'gpustack-models-meta') },
  mindie: { raw: 'http://192.0.2.18:1025/v1', routes: () => samples('mindie-models', 'mindie-config') },
  tgi: { raw: 'http://192.0.2.19:8080/v1', routes: () => samples('tgi-models', 'tgi-info') },
  lmdeploy: { raw: 'http://192.0.2.20:23333/v1', routes: () => samples('lmdeploy-models') },
  localai: { raw: 'http://192.0.2.21:8080/v1', routes: () => samples('localai-models', 'localai-well-known',
    'localai-version', 'localai-api-version', 'localai-models-capabilities') },
  tensorrt: { raw: 'http://192.0.2.22:8000/v1', routes: () => samples('tensorrt-models', 'tensorrt-version') },
  litellm: { raw: 'http://192.0.2.23:4000/v1', routes: () => samples('litellm-models') },
  newapi: { raw: 'http://192.0.2.24:3000/v1', routes: () => samples('newapi-models') },
  oneapi: { raw: 'http://192.0.2.25:3000/v1', routes: () => samples('oneapi-models') },
  deepseek: { raw: 'https://api.deepseek.com', routes: () => samples('deepseek-models') },
  moonshot: { raw: 'https://api.moonshot.cn/v1', routes: () => samples('moonshot-models') },
  dashscope: { raw: 'https://dashscope.aliyuncs.com/compatible-mode/v1', routes: () => samples(
    'dashscope-compatible-models', 'dashscope-native-models-page1', 'dashscope-native-models-page2') },
  qianfan: { raw: 'https://qianfan.baidubce.com/v2', routes: () => samples('qianfan-models') },
  openrouter: { raw: 'https://openrouter.ai/api/v1', routes: () => samples('openrouter-models') },
  anthropic: { raw: 'https://api.anthropic.com', routes: () => samples('anthropic-models-page1',
    'anthropic-models-page2') },
  together: { raw: 'https://api.together.xyz/v1', routes: () => samples('together-models') },
  mistral: { raw: 'https://api.mistral.ai/v1', routes: () => samples('mistral-models') },
  edge: { raw: 'http://192.0.2.30:8000/v1', routes: () => samples('openai-compatible-edge-rows') },
  deepinfra: { raw: 'https://api.deepinfra.com/v1/openai', routes: () => samples('deepinfra-models') },
});

/**
 * @brief 跑一个场景的新提供商发现（带 TEST_KEY）。
 * @param name SCENARIOS 的键
 * @param extra 追加的路由（同 table 的 entries）；与样本同一个键时用它
 * @param timeoutMs 每个请求的时限
 * @return { result, calls }
 */
export function discoverScenario(name, extra = [], timeoutMs = DISCOVER_TIMEOUT_MS) {
  const scenario = SCENARIOS[name];
  return discoverWith(table([...scenario.routes(), ...extra]), newRequest(scenario.raw, { secret: TEST_KEY }),
    timeoutMs);
}

/**
 * @brief 按 §4.1 读一行并补上默认值（discoverRead.ts 的 readRow 与 finalizeModel）。
 * @param row 列表的一行
 * @param context { kind, anthropicShape }，默认 unknown 且不是 Anthropic 形状
 */
export function readModel(row, context = { kind: 'unknown', anthropicShape: false }) {
  return rules.finalizeModel(rules.rowId(row), rules.readRow(row, context), { trained: false, added: false });
}

/** @brief 一页 OpenAI 形状的列表（synthetic）：ids 依次为行的 id。 */
export function openaiList(ids, extra = () => ({})) {
  return { object: 'list', data: ids.map((id, index) => ({ id, object: 'model', ...extra(id, index) })) };
}
