// 发现读取器单元测试（docs/specs/model-discovery.md §13.1 单元层）的公共工具：替身 fetch（synthetic，按地址回答、记下每个
// 请求）、读 tests/fixtures/discovery/bodies/ 的响应体样本、按合成端点的形状（tests/fake-endpoint/discovery.mjs）回答、
// 可控的延迟应答、收集 console 输出。key 都是测试用的假值。

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detailAnswer, isListPath, listAnswer, listServed } from '../../fake-endpoint/discovery.mjs';

const bodiesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'discovery', 'bodies');

/** 测试用的假 key（synthetic）：服务原文里出现它时读取器要换成 ***。 */
export const SECRET = 'sk-test-SECRET-4821';

/**
 * @brief 已有提供商交给读取器的目标（§5.1：不整理地址）。
 * @param base 配置里的 baseUrl
 * @param options secret、shareKey（省略时为 null，不合并）、anthropicHint
 */
export function existing(base, { secret = null, shareKey = null, anthropicHint = false } = {}) {
  return { base, anthropicHint, existing: true, secret, shareKey };
}

/**
 * @brief 新提供商的一次 models.discover 请求（§5.1：shareKey 为 null）。
 * @param base §3.1 整理后的 base
 * @param options secret、api、anthropicHint
 */
export function newRequest(base, { secret = null, api = null, anthropicHint = false } = {}) {
  return { base, anthropicHint, existing: false, secret, shareKey: null, api, configured: [] };
}

/**
 * @brief 已有提供商的一次 models.discover 请求。
 * @param base 配置里的 baseUrl
 * @param options secret、shareKey、api、configured
 */
export function providerRequest(base, { secret = null, shareKey = null, api = 'openai-completions',
  configured = [] } = {}) {
  return { ...existing(base, { secret, shareKey, anthropicHint: api === 'anthropic-messages' }), api, configured };
}

/** @brief JSON 响应。 */
export function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** @brief 没有正文的响应（404 等）。 */
export function empty(status = 404) {
  return new Response(null, { status });
}

/** @brief 一个可以从外面完成的 promise。 */
export function deferred() {
  let resolveIt;
  let rejectIt;
  const promise = new Promise((res, rej) => {
    resolveIt = res;
    rejectIt = rej;
  });
  return { promise, resolve: resolveIt, reject: rejectIt };
}

/** @brief 等这一轮的微任务与 I/O 回调都跑完（读取器在 promise 链里一步步往下走）。 */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((res) => setImmediate(res));
}

/** @brief 请求头（Headers 或对象）→ 小写名字的对象。 */
function headerObject(headers) {
  return Object.fromEntries(new Headers(headers ?? {}).entries());
}

/**
 * @brief 替身 fetch：每个请求记进 calls（url、path、method、headers、body、redirect、signal），交给 answer 回答。
 * @param answer (call) → Response、它的 promise，或抛出（连接失败）；返回 undefined 时为 404
 * @return { fetch, calls, inFlight(), maxInFlight() }
 */
export function stubFetch(answer) {
  const calls = [];
  let current = 0;
  let peak = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url: url.href, path: url.pathname, search: url.search, origin: url.origin,
      method: init.method ?? 'GET', headers: headerObject(init.headers), body: init.body ?? null,
      redirect: init.redirect, signal: init.signal };
    calls.push(call);
    current += 1;
    peak = Math.max(peak, current);
    try {
      return (await answer(call)) ?? empty(404);
    } finally {
      current -= 1;
    }
  };
  return { fetch, calls, inFlight: () => current, maxInFlight: () => peak };
}

/** @brief 连接失败（undici 的形状：TypeError('fetch failed')，cause 为系统错误）。 */
export function connectionFailure(message) {
  return new TypeError('fetch failed', { cause: new Error(message) });
}

/** @brief 一直不回答、只在 signal 取消时以连接中断拒绝的 fetch 应答（像 -hang 的服务）。 */
export function hang(call) {
  return new Promise((_res, reject) => {
    call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

/**
 * @brief 读一个响应体样本（tests/fixtures/discovery/bodies/<name>.json，格式见那里的 README.md）。
 * @return 响应：样本的状态、响应头与正文
 */
export function sample(name) {
  const data = JSON.parse(readFileSync(join(bodiesDir, `${name}.json`), 'utf8'));
  const text = typeof data.body === 'string' ? data.body : JSON.stringify(data.body);
  return new Response(text, { status: data.status, headers: data.headers ?? {} });
}

/**
 * @brief 按样本回答：routes 的键为 "<METHOD> <路径><query>"（GET 可省略方法），值为样本名或 (call) → 样本名；
 *        没有的为 404。Ollama 的 POST /api/show 按正文里的 model 选样本。
 * @param routes 键 → 样本名
 */
export function sampleFetch(routes) {
  return stubFetch((call) => {
    const key = `${call.path}${call.search}`;
    const route = routes[`${call.method} ${key}`] ?? (call.method === 'GET' ? routes[key] : undefined);
    const name = typeof route === 'function' ? route(call) : route;
    return name ? sample(name) : empty(404);
  });
}

/** @brief 合成端点（tests/fake-endpoint/server.mjs）的默认环境：两个模型、窗口 131072、版本 0.10.1。 */
export const FAKE_ENV = Object.freeze({ shape: 'vllm', models: ['fake-coder', 'fake-slow'], maxModelLen: 131072,
  version: '0.10.1', noV1Root: false });

/**
 * @brief 按合成端点的形状回答（不经网络，直接调用 tests/fake-endpoint/discovery.mjs 的 listAnswer 与 detailAnswer，
 *        与 server.mjs 的路由一致：列表路径看 isListPath / listServed，其他为详情；不查 key）。
 * @param env FAKE_ENV 的字段，可覆盖 shape、models 等
 */
export function shapeFetch(env) {
  const full = { ...FAKE_ENV, ...env };
  return stubFetch((call) => {
    if (call.method === 'GET' && isListPath(call.path)) {
      if (!listServed(call.path, full)) return empty(404);
      const answer = listAnswer(call.headers, full, null);
      return json(answer.body, { status: answer.status, headers: answer.headers });
    }
    const request = call.body === null ? null : JSON.parse(call.body);
    const answer = detailAnswer(call.method, call.path, request, full);
    return answer ? json(answer.body, { status: answer.status }) : empty(404);
  });
}

/**
 * @brief 收集 console.log / console.error / console.warn 的输出（测试结束时还原）；读取器的日志不能有 key（§5.3、§9）。
 * @param t node:test 的上下文
 * @return 收集到的每一行（"<log|error|warn> <文字>"）
 */
export function captureConsole(t) {
  const lines = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  for (const name of Object.keys(originals)) {
    console[name] = (...args) => lines.push(`${name} ${args.map(String).join(' ')}`);
  }
  t.after(() => Object.assign(console, originals));
  return lines;
}

/** @brief 一个读取器：时限默认 15 s（§11），fetch 为替身，时钟可控。 */
export function readerWith(DiscoverReader, fetch, { timeoutMs = 15_000, now } = {}) {
  return new DiscoverReader({ timings: { discoverRequestTimeoutMs: timeoutMs }, fetch, ...(now ? { now } : {}) });
}

/**
 * @brief 把全局 fetch 换成 stubFetch(answer)（模型层的读取器不传 fetch，用全局的），测试结束时还原。
 * @return stubFetch 的结果
 */
export function stubGlobalFetch(t, answer) {
  const stub = stubFetch(answer);
  const original = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return stub;
}

// ---- 模型层（tests/unit/modelLayer.test.mjs 的写法，synthetic） ----

/** @brief §4.1 形状的一个模型（synthetic）。 */
export function providerModel(id, overrides = {}) {
  return { id, family: '', contextWindow: 131072, maxTokens: 16384, reasoning: false, input: ['text'], ...overrides };
}

/** @brief §4.1 形状的一个提供商（synthetic）：keys 为 ref 的列表，标签 Key 1、Key 2…。 */
export function configProvider(id, baseUrl, modelIds, { keys = [], api = 'openai-completions' } = {}) {
  return { id, name: id.toUpperCase(), api, baseUrl, zone: 'local', compat: {}, concurrency: 4,
    keys: keys.map((ref, index) => ({ ref, label: `Key ${index + 1}` })), nextKeyNumber: keys.length + 1,
    models: modelIds.map((modelId) => providerModel(modelId)) };
}

/** @brief 这些提供商的配置（§4.1）。 */
export function configOf(providers) {
  return { version: 1, providers, groups: [], normalDefault: null, allowedZones: ['local', 'intranet'],
    projectZones: {} };
}

/**
 * @brief pi 运行时的替身：getModel 按配置给出模型；streamSimple 立即以连接错误结束（探针第 1–7 步为 error，
 *        第 0 步照常经读取器）；记下每次请求的模型 id。
 */
function fakeRuntime(config) {
  const streamed = [];
  return {
    streamed,
    registered: new Map(),
    registerProvider(id, input) { this.registered.set(id, input); },
    unregisterProvider(id) { this.registered.delete(id); },
    async refresh() {},
    getProviders() { return []; },
    getModel(providerId, modelId) {
      const provider = config.providers.find((item) => item.id === providerId);
      const model = provider?.models.find((item) => item.id === modelId);
      return model ? { ...model, name: model.id, api: provider.api, provider: providerId, baseUrl: provider.baseUrl,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : undefined;
    },
    streamSimple(model) {
      streamed.push(model.id);
      const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error', errorMessage: 'Connection error.', timestamp: 1 };
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'error', error: message }; },
        result: async () => message,
      };
    },
  };
}

/**
 * @brief 临时 userData（model-config.json、可选的 model-profiles.json）上的模型层。
 * @param ModelLayer kernel/modelLayer.ts 的类
 * @param reserved 保留 id
 * @param options config、profiles（StoredProfile 的列表）
 * @return { layer, runtime, events }
 */
export function scratchLayer(ModelLayer, reserved, { config, profiles = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-discovery-layer-'));
  const paths = { config: join(dir, 'model-config.json'), profiles: join(dir, 'model-profiles.json'),
    notice: join(dir, 'model-migration.json'), v0Models: join(dir, 'agent', 'models.json') };
  writeFileSync(paths.config, JSON.stringify(config));
  if (profiles) writeFileSync(paths.profiles, JSON.stringify({ version: 1, profiles }));
  const runtime = fakeRuntime(config);
  const events = [];
  const layer = new ModelLayer(runtime, reserved, paths, (event) => events.push(event));
  return { layer, runtime, events, paths };
}

/** @brief 等到模型层没有在跑的探针（每次档案变化时检查）。 */
export function probesIdle(layer) {
  return new Promise((res) => {
    const check = () => {
      if (layer.getProfiles().running().length > 0) return;
      stop();
      res();
    };
    const stop = layer.onModelsChanged((change) => {
      if (change.kind === 'profiles') check();
    });
    check();
  });
}
