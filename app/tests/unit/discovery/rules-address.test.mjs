// MD-01 整理地址与列表地址（docs/specs/model-discovery.md §3.1、§3.2，§13.2 单元层）：§3.1 的每一步；§3.2 每种情况的
// 请求顺序与认证头、最多 3 次、401/403 与连接失败、超时即停、其余试下一个、no_list 与 invalid 的区分；补 /v1 时的建议地址；
// Anthropic 前缀的列表不改 baseUrl 与 api；已存的 …/anthropic 提供商从前缀拿到列表；Anthropic 形状的翻页与凑够条数即停；
// 去重；超过条数时 truncated；所有请求同一个 origin。替身 fetch 的回答是手写的（synthetic，依据规格 §3.2 的表），
// 列表体用 tests/fixtures/discovery/bodies/ 的样本。§3.1 第 1 步的命令文字经 modelCommands.ts 的 handleModelsCommand 检查：
// 模型层换成替身（synthetic，tests/unit/memory/enhance-harness.mjs 的 loadBundle，只给出读取器）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hooks, loadBundle } from '../memory/enhance-harness.mjs';
import {
  SCENARIOS, TEST_KEY, discoverScenario, discoverWith, modelOf, newRequest, openaiList, originsOf, providerRequest,
  reader, readerWith, rules, sample, table, urlsOf,
} from './rules-helpers.mjs';

/** modelCommands.ts，其中的 ./modelLayer 换成替身（getModelLayer 返回 hooks().modelLayer） */
const { commands } = await loadBundle({ commands: 'src/kernel/modelCommands.ts' }, ['modelLayer']);

/** §3.1 整理后的地址（没有 Anthropic 提示）。 */
function plain(base) {
  return { base, anthropicHint: false };
}

/** §3.1 整理后的地址（有 Anthropic 提示）。 */
function hinted(base) {
  return { base, anthropicHint: true };
}

/** vLLM 样本的列表回答（一个能用的模型列表）。 */
const VLLM_LIST = { status: 200, body: sample('vllm-models').body };

/** 只回答列表请求的路由：answers 按请求顺序给出每一次的回答（synthetic）。 */
function sequence(...answers) {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)];
}

/** 列表请求的个数：路径以 /models 结尾（不含 §3.3 第 6 步的 /api/v1/models 与详情）。 */
function listCalls(calls) {
  return calls.filter((call) => /\/models(\?|$)/.test(call.url) && !call.url.includes('/api/v1/models'));
}

// ---- §3.1 ----

test('MD-01 §3.1 trims spaces, drops the query, the hash and the trailing slash', () => {
  const normalize = rules.normalizeBaseUrl;
  assert.deepEqual(normalize('  http://192.0.2.40:8000/v1  '), plain('http://192.0.2.40:8000/v1'));
  assert.deepEqual(normalize('\thttp://192.0.2.40:8000/v1\n'), plain('http://192.0.2.40:8000/v1'));
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1?team=a&x=1'), plain('http://192.0.2.40:8000/v1'));
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1#top'), plain('http://192.0.2.40:8000/v1'));
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1/?team=a#top'), plain('http://192.0.2.40:8000/v1'));
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1/'), plain('http://192.0.2.40:8000/v1'));
  assert.deepEqual(normalize('http://192.0.2.40:8000/'), plain('http://192.0.2.40:8000'));
  assert.deepEqual(normalize('https://api.example.test'), plain('https://api.example.test'));
});

test('MD-01 §3.1 an address that is not an http or https URL is rejected', () => {
  for (const raw of ['', '   ', 'not a url', '192.0.2.40:8000/v1', 'localhost:8000', 'ftp://192.0.2.40/v1',
    'file:///C:/models', 'ws://192.0.2.40:8000/v1', 'mailto:ops@example.test']) {
    assert.equal(rules.normalizeBaseUrl(raw), null, raw);
  }
});

test('MD-01 §3.1 each endpoint suffix is removed once, in the listed order', () => {
  const normalize = rules.normalizeBaseUrl;
  for (const suffix of ['/chat/completions', '/completions', '/responses', '/messages', '/embeddings', '/models']) {
    assert.deepEqual(normalize(`http://192.0.2.40:8000/v1${suffix}`), plain('http://192.0.2.40:8000/v1'), suffix);
    assert.deepEqual(normalize(`http://192.0.2.40:8000/v1${suffix}/?stream=true`), plain('http://192.0.2.40:8000/v1'),
      `${suffix} with a slash and a query`);
  }
  // 只去一次：去掉 /models 之后剩下的端点后缀不再去
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1/models/models'), plain('http://192.0.2.40:8000/v1/models'));
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1/chat/completions/models'),
    plain('http://192.0.2.40:8000/v1/chat/completions'));
  // 按顺序先比 /chat/completions，所以不会只去掉 /completions 留下 /chat
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1/chat/completions'), plain('http://192.0.2.40:8000/v1'));
  // 只有整段后缀才去：/mymodels 不是 /models
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1/mymodels'), plain('http://192.0.2.40:8000/v1/mymodels'));
});

/**
 * @brief 经 handleModelsCommand 发一次 models.discover（§5.1 kind: 'new'）；替身模型层只有一个用替身 fetch 的读取器。
 * @param handler 替身 fetch 的回答
 * @param baseUrl 表单里填的 Base URL
 * @param keySecret API key 框的值
 * @return { result, calls }
 */
async function commandDiscover(handler, baseUrl, keySecret = null) {
  const { discoverReader, calls } = readerWith(handler);
  hooks().modelLayer = { reader: discoverReader };
  const result = await commands.handleModelsCommand({ type: 'models.discover',
    target: { kind: 'new', baseUrl, api: null, keySecret } });
  return { result, calls };
}

test('MD-01 §3.1 models.discover with an address that is not http or https fails with the form\'s text', async () => {
  for (const baseUrl of ['', '   ', 'not a url', '192.0.2.40:8000/v1', 'ftp://192.0.2.40/v1', 'ws://192.0.2.40/v1']) {
    const { result, calls } = await commandDiscover(() => ({ status: 200, body: openaiList(['m']) }), baseUrl);
    assert.deepEqual(result, reader.discoverFailure('Base URL must be an http or https URL.'), baseUrl);
    assert.equal(result.error, 'Base URL must be an http or https URL.', baseUrl);
    assert.deepEqual(calls, [], baseUrl);
  }
});

test('MD-01 §3.1 models.discover normalizes the address before the list requests', async () => {
  const handler = table([['http://192.0.2.41:8000/v1/models', VLLM_LIST]]);
  const plainUrl = await commandDiscover(handler, '  http://192.0.2.41:8000/v1/chat/completions/?stream=true#x ', '  ');
  assert.equal(plainUrl.calls[0].url, 'http://192.0.2.41:8000/v1/models');
  assert.ok(plainUrl.calls.length > 1);
  // key 框只有空白：不带认证头（§3.2“没有 key 时不带认证头”）
  for (const call of plainUrl.calls) assert.equal(call.headers.authorization, undefined, call.url);
  assert.deepEqual([plainUrl.result.error, plainUrl.result.listError, plainUrl.result.baseUrl],
    [null, null, 'http://192.0.2.41:8000/v1']);
  const hinted = await commandDiscover(() => undefined, ' https://open.bigmodel.cn/api/anthropic/v1/messages?beta=1 ');
  assert.deepEqual(urlsOf(hinted.calls), ['https://open.bigmodel.cn/api/anthropic/v1/models?limit=1000',
    'https://open.bigmodel.cn/api/models', 'https://open.bigmodel.cn/api/v1/models']);
  assert.deepEqual([hinted.result.baseUrl, hinted.result.api],
    ['https://open.bigmodel.cn/api/anthropic', 'anthropic-messages']);
});

test('MD-01 §3.1 an existing provider is not normalized: the saved address is used as it is', async () => {
  // 路径里有 anthropic 段、以 /v1 结尾的 openai-* 提供商：提示只看 api，不去掉 /v1，也不试 ②
  const saved = 'https://gw.example.test/anthropic/v1';
  const { result, calls } = await discoverWith(() => undefined,
    providerRequest(saved, 'openai-completions', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(calls), ['https://gw.example.test/anthropic/v1/models']);
  assert.deepEqual(calls[0].headers, { authorization: `Bearer ${TEST_KEY}` });
  assert.deepEqual([result.baseUrl, result.api, result.name], [saved, 'openai-completions', 'gw.example.test']);
});

test('MD-01 §3.1 an anthropic path segment or api.anthropic.com gives the hint and drops a trailing /v1', () => {
  const normalize = rules.normalizeBaseUrl;
  assert.deepEqual(normalize('https://open.bigmodel.cn/api/anthropic'),
    hinted('https://open.bigmodel.cn/api/anthropic'));
  assert.deepEqual(normalize('https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true'),
    hinted('https://open.bigmodel.cn/api/anthropic'));
  assert.deepEqual(normalize('https://open.bigmodel.cn/api/anthropic/v1/'),
    hinted('https://open.bigmodel.cn/api/anthropic'));
  // 不分大小写
  assert.deepEqual(normalize('https://gw.example.test/ANTHROPIC/v1'), hinted('https://gw.example.test/ANTHROPIC'));
  assert.deepEqual(normalize('https://api.anthropic.com/v1/messages'), hinted('https://api.anthropic.com'));
  assert.deepEqual(normalize('https://api.anthropic.com/v1'), hinted('https://api.anthropic.com'));
  assert.deepEqual(normalize('https://api.anthropic.com'), hinted('https://api.anthropic.com'));
  // 有提示时只去 /v1
  assert.deepEqual(normalize('https://gw.example.test/anthropic/v2'), hinted('https://gw.example.test/anthropic/v2'));
});

test('MD-01 §3.1 without the hint /v1 stays and a segment that only contains "anthropic" is no hint', () => {
  const normalize = rules.normalizeBaseUrl;
  assert.deepEqual(normalize('http://192.0.2.40:8000/v1'), plain('http://192.0.2.40:8000/v1'));
  assert.deepEqual(normalize('https://gw.example.test/anthropic-proxy/v1'),
    plain('https://gw.example.test/anthropic-proxy/v1'));
  assert.deepEqual(normalize('https://anthropic.example.test/v1'), plain('https://anthropic.example.test/v1'));
  assert.deepEqual(normalize('https://gw.example.test/v1?route=anthropic'), plain('https://gw.example.test/v1'));
});

// ---- §3.2 没有 Anthropic 提示 ----

test('MD-01 §3.2 no hint: <base>/models with Bearer, then <base>/v1/models, which suggests <base>/v1', async () => {
  const handler = table([['http://192.0.2.41:8000/v1/models', VLLM_LIST]]);
  const { result, calls } = await discoverWith(handler, newRequest('http://192.0.2.41:8000', { secret: TEST_KEY }));
  const lists = listCalls(calls);
  assert.deepEqual(urlsOf(lists), ['http://192.0.2.41:8000/models', 'http://192.0.2.41:8000/v1/models']);
  for (const call of lists) {
    assert.equal(call.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(call.headers['x-api-key'], undefined);
    assert.equal(call.headers['anthropic-version'], undefined);
  }
  assert.equal(result.listError, null);
  assert.equal(result.baseUrl, 'http://192.0.2.41:8000/v1');
  assert.deepEqual(result.models.map((model) => model.id), ['Qwen/Qwen3-32B', 'sql-lora']);
});

test('MD-01 §3.2 no hint: when <base>/models answers, the base stays the suggested Base URL', async () => {
  const handler = table([['http://192.0.2.41:8000/models', VLLM_LIST]]);
  const { result, calls } = await discoverWith(handler, newRequest('http://192.0.2.41:8000/', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(listCalls(calls)), ['http://192.0.2.41:8000/models']);
  assert.equal(result.baseUrl, 'http://192.0.2.41:8000');
});

test('MD-01 §3.2 no hint: a base path ending in /v<number> is not retried with /v1', async () => {
  for (const raw of ['http://192.0.2.42:8000/v1', 'https://open.bigmodel.cn/api/paas/v4']) {
    const { result, calls } = await discoverWith(() => undefined, newRequest(raw, { secret: TEST_KEY }));
    assert.deepEqual(urlsOf(calls), [`${rules.normalizeBaseUrl(raw).base}/models`], raw);
    assert.deepEqual(result.listError, { kind: 'no_list', detail: '' }, raw);
    assert.equal(result.baseUrl, rules.normalizeBaseUrl(raw).base, raw);
    assert.equal(result.server, null, raw);
  }
});

test('MD-01 §3.2 without a key no authentication header is sent', async () => {
  const handler = table([['http://192.0.2.41:8000/v1/models', VLLM_LIST]]);
  const { calls } = await discoverWith(handler, newRequest('http://192.0.2.41:8000'));
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.equal(call.headers.authorization, undefined, call.url);
    assert.equal(call.headers['x-api-key'], undefined, call.url);
  }
});

// ---- §3.2 有 Anthropic 提示 ----

test('MD-01 §3.2 hint: ① <base>/v1/models?limit=1000 with Anthropic headers, then the prefix lists', async () => {
  const { result, calls } = await discoverWith(() => undefined,
    newRequest('https://open.bigmodel.cn/api/anthropic/v1/messages', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(calls), ['https://open.bigmodel.cn/api/anthropic/v1/models?limit=1000',
    'https://open.bigmodel.cn/api/models', 'https://open.bigmodel.cn/api/v1/models']);
  assert.deepEqual(calls[0].headers, { 'x-api-key': TEST_KEY, authorization: `Bearer ${TEST_KEY}`,
    'anthropic-version': '2023-06-01' });
  for (const call of calls.slice(1)) assert.deepEqual(call.headers, { authorization: `Bearer ${TEST_KEY}` });
  assert.deepEqual(result.listError, { kind: 'no_list', detail: '' });
  assert.equal(result.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(result.api, 'anthropic-messages');
});

test('MD-01 §3.2 hint without a key: ① sends only anthropic-version, ② and ③ send nothing', async () => {
  const { calls } = await discoverWith(() => undefined, newRequest('https://open.bigmodel.cn/api/anthropic'));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].headers, { 'anthropic-version': '2023-06-01' });
  assert.deepEqual(calls[1].headers, {});
  assert.deepEqual(calls[2].headers, {});
});

test('MD-01 §3.2 hint on api.anthropic.com tries only ①', async () => {
  const { result, calls } = await discoverWith(() => undefined,
    newRequest('https://api.anthropic.com/v1', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(calls), ['https://api.anthropic.com/v1/models?limit=1000']);
  assert.deepEqual(result.listError, { kind: 'no_list', detail: '' });
});

test('MD-01 §3.2 hint: a 401 or 403 stops at once, the prefix lists are not tried after it', async () => {
  const first = 'https://open.bigmodel.cn/api/anthropic/v1/models?limit=1000';
  for (const status of [401, 403]) {
    const handler = table([[first, { status, body: 'invalid x-api-key (synthetic)' }]]);
    const { result, calls } = await discoverWith(handler,
      newRequest('https://open.bigmodel.cn/api/anthropic', { secret: TEST_KEY }));
    assert.deepEqual(urlsOf(calls), [first], String(status));
    assert.deepEqual(result.listError, { kind: 'rejected', detail: 'invalid x-api-key (synthetic)' }, String(status));
  }
  // ① 是 404、② 是 401：停在 ②，不试 ③
  const second = table([['https://open.bigmodel.cn/api/models', { status: 401, body: 'token expired (synthetic)' }]]);
  const { result, calls } = await discoverWith(second,
    newRequest('https://open.bigmodel.cn/api/anthropic', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(calls), [first, 'https://open.bigmodel.cn/api/models']);
  assert.deepEqual(result.listError, { kind: 'rejected', detail: 'token expired (synthetic)' });
  assert.equal(result.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
});

test('MD-01 §3.2 a list from the Anthropic prefix keeps baseUrl and api', async () => {
  const handler = table([['https://open.bigmodel.cn/api/models',
    { status: 200, body: openaiList(['glm-5.3', 'glm-5.3-air']) }]]);
  const { result, calls } = await discoverWith(handler,
    newRequest('https://open.bigmodel.cn/api/anthropic', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(listCalls(calls)), ['https://open.bigmodel.cn/api/anthropic/v1/models?limit=1000',
    'https://open.bigmodel.cn/api/models']);
  assert.equal(result.listError, null);
  assert.equal(result.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(result.api, 'anthropic-messages');
  assert.deepEqual(result.models.map((model) => model.id), ['glm-5.3', 'glm-5.3-air']);
});

test('MD-01 §3.2 a list from the third attempt (prefix + /v1/models) keeps baseUrl and api', async () => {
  const handler = table([['https://open.bigmodel.cn/api/v1/models', { status: 200, body: openaiList(['glm-5.3']) }]]);
  const { result, calls } = await discoverWith(handler,
    newRequest('https://open.bigmodel.cn/api/anthropic', { secret: TEST_KEY }));
  // 前缀是 /api，所以 ③ 与 §3.3 第 6 步的 <origin>/api/v1/models 是同一个地址：只看前三个请求
  assert.deepEqual(urlsOf(calls).slice(0, 3), ['https://open.bigmodel.cn/api/anthropic/v1/models?limit=1000',
    'https://open.bigmodel.cn/api/models', 'https://open.bigmodel.cn/api/v1/models']);
  assert.equal(result.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(result.api, 'anthropic-messages');
  assert.deepEqual(result.models.map((model) => model.id), ['glm-5.3']);
});

// ---- §3.2 已有提供商 ----

test('MD-01 §3.2 an existing openai-* provider tries only <baseUrl>/models', async () => {
  for (const api of ['openai-completions', 'openai-responses']) {
    const { result, calls } = await discoverWith(() => undefined,
      providerRequest('http://192.0.2.43:8000', api, { secret: TEST_KEY }));
    assert.deepEqual(urlsOf(calls), ['http://192.0.2.43:8000/models'], api);
    assert.deepEqual(calls[0].headers, { authorization: `Bearer ${TEST_KEY}` }, api);
    assert.deepEqual(result.listError, { kind: 'no_list', detail: '' }, api);
    assert.equal(result.baseUrl, 'http://192.0.2.43:8000', api);
  }
});

test('MD-01 §3.2 a saved …/anthropic provider also gets the list from the prefix', async () => {
  const handler = table([['https://open.bigmodel.cn/api/models',
    { status: 200, body: openaiList(['glm-5.3', 'glm-5.3-air']) }]]);
  const { result, calls } = await discoverWith(handler, providerRequest('https://open.bigmodel.cn/api/anthropic',
    'anthropic-messages', { secret: TEST_KEY, configured: ['glm-5.3'] }));
  assert.deepEqual(urlsOf(listCalls(calls)), ['https://open.bigmodel.cn/api/anthropic/v1/models?limit=1000',
    'https://open.bigmodel.cn/api/models']);
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].headers['x-api-key'], TEST_KEY);
  assert.deepEqual(calls[1].headers, { authorization: `Bearer ${TEST_KEY}` });
  assert.equal(result.listError, null);
  assert.equal(result.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(result.api, 'anthropic-messages');
  assert.equal(modelOf(result, 'glm-5.3').added, true);
  assert.equal(modelOf(result, 'glm-5.3-air').added, false);
});

test('MD-01 §3.2 an existing Anthropic provider without the segment or on api.anthropic.com tries only ①', async () => {
  for (const base of ['https://gw.example.test', 'https://api.anthropic.com']) {
    const { calls } = await discoverWith(() => undefined, providerRequest(base, 'anthropic-messages'));
    assert.deepEqual(urlsOf(calls), [`${base}/v1/models?limit=1000`], base);
  }
});

// ---- §3.2 停止与继续 ----

test('MD-01 §3.2 a 401 stops at once as rejected with the server text (real DeepSeek and GLM samples)', async () => {
  const deepseek = sample('deepseek-models-nokey');
  const glm = sample('glm-models-nokey');
  const cases = [['https://api.deepseek.com', deepseek, 'Authentication Fails (governor)'],
    ['https://open.bigmodel.cn/api/paas/v4', glm, JSON.stringify(glm.body)]];
  for (const [raw, { url, status, body }, detail] of cases) {
    const { result, calls } = await discoverWith(table([[url, { status, body }]]), newRequest(raw));
    assert.deepEqual(urlsOf(calls), [url], raw);
    assert.deepEqual(result.listError, { kind: 'rejected', detail }, raw);
    assert.equal(result.server, null, raw);
    assert.deepEqual(result.models, [], raw);
  }
});

test('MD-01 §3.2 a 403 stops at once; without body text the detail is the status line', async () => {
  const forbidden = table([['http://192.0.2.44:8000/models', { status: 403, body: 'key disabled (synthetic)' }]]);
  const first = await discoverWith(forbidden, newRequest('http://192.0.2.44:8000', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(first.calls), ['http://192.0.2.44:8000/models']);
  assert.deepEqual(first.result.listError, { kind: 'rejected', detail: 'key disabled (synthetic)' });
  const empty = table([['http://192.0.2.44:8000/models', { status: 401, statusText: 'Unauthorized', body: '' }]]);
  const second = await discoverWith(empty, newRequest('http://192.0.2.44:8000', { secret: TEST_KEY }));
  assert.equal(second.calls.length, 1);
  assert.deepEqual(second.result.listError, { kind: 'rejected', detail: 'HTTP 401 Unauthorized' });
});

test('MD-01 §3.2 a connection failure stops at once as unreachable', async () => {
  const refused = () => ({ fail: 'connect ECONNREFUSED 192.0.2.45:8000' });
  const { result, calls } = await discoverWith(refused, newRequest('http://192.0.2.45:8000', { secret: TEST_KEY }));
  assert.deepEqual(urlsOf(calls), ['http://192.0.2.45:8000/models']);
  assert.deepEqual(result.listError, { kind: 'unreachable', detail: 'connect ECONNREFUSED 192.0.2.45:8000' });
  const hinted = await discoverWith(refused, newRequest('https://gw.example.test/anthropic'));
  assert.equal(hinted.calls.length, 1);
  assert.equal(hinted.result.listError.kind, 'unreachable');
});

test('MD-01 §3.2 a timeout stops at once as unreachable', async () => {
  const { result, calls } = await discoverWith(() => ({ hang: true }),
    newRequest('http://192.0.2.46:8000', { secret: TEST_KEY }), 50);
  assert.deepEqual(urlsOf(calls), ['http://192.0.2.46:8000/models']);
  assert.deepEqual(result.listError, { kind: 'unreachable', detail: 'Timed out after 0.05s' });
});

test('MD-01 §3.2 404, 405, other 4xx, 5xx, not JSON and no array try the next address', async () => {
  const failures = [{ status: 404, body: 'not found' }, { status: 405, body: 'method not allowed' },
    { status: 400, body: 'bad request' }, { status: 429, body: 'slow down' }, { status: 500, body: 'oops' },
    { status: 502, body: 'bad gateway' }, { status: 200, body: '<html>login</html>' },
    { status: 200, body: { object: 'list' } }, { status: 200, body: { data: { id: 'x' } } },
    { status: 200, body: 'null' }];
  for (const failure of failures) {
    const { result, calls } = await discoverWith(sequence(failure, VLLM_LIST),
      newRequest('http://192.0.2.47:8000', { secret: TEST_KEY }));
    const label = JSON.stringify(failure);
    assert.deepEqual(urlsOf(listCalls(calls)), ['http://192.0.2.47:8000/models', 'http://192.0.2.47:8000/v1/models'],
      label);
    assert.equal(result.listError, null, label);
    assert.equal(result.baseUrl, 'http://192.0.2.47:8000/v1', label);
  }
});

test('MD-01 §3.2 the last attempt decides: 404 or 405 is no_list, anything else is invalid', async () => {
  const cases = [
    [[{ status: 500, body: 'upstream down' }, { status: 404, body: 'nope' }], { kind: 'no_list', detail: '' }],
    [[{ status: 500, body: 'upstream down' }, { status: 405, body: 'nope' }], { kind: 'no_list', detail: '' }],
    [[{ status: 404, body: 'nope' }, { status: 502, body: 'Bad gateway (synthetic)' }],
      { kind: 'invalid', detail: 'Bad gateway (synthetic)' }],
    [[{ status: 404, body: 'nope' }, { status: 200, body: '<html>login</html>' }],
      { kind: 'invalid', detail: '<html>login</html>' }],
    [[{ status: 404, body: 'nope' }, { status: 200, body: { data: 'none' } }],
      { kind: 'invalid', detail: '{"data":"none"}' }],
    [[{ status: 404, body: 'nope' }, { status: 503, statusText: 'Service Unavailable', body: '' }],
      { kind: 'invalid', detail: 'HTTP 503 Service Unavailable' }],
  ];
  for (const [answers, listError] of cases) {
    const { result, calls } = await discoverWith(sequence(...answers), newRequest('http://192.0.2.48:8000'));
    assert.equal(calls.length, 2, JSON.stringify(answers));
    assert.deepEqual(result.listError, listError, JSON.stringify(answers));
    assert.equal(result.server, null);
    // ② 没成功：结果的 baseUrl 仍是 base，不是 <base>/v1（§3.2“没拿到列表时也给出”）
    assert.equal(result.baseUrl, 'http://192.0.2.48:8000', JSON.stringify(answers));
  }
});

test('MD-01 §3.2 at most 3 list attempts', async () => {
  const { result, calls } = await discoverWith(() => ({ status: 500, body: 'oops' }),
    newRequest('https://gw.example.test/proxy/anthropic', { secret: TEST_KEY }));
  assert.equal(calls.length, 3);
  assert.equal(rules.LIST_ATTEMPTS, 3);
  assert.deepEqual(result.listError, { kind: 'invalid', detail: 'oops' });
});

// ---- §3.2 翻页、去重、条数 ----

test('MD-01 §3.2 an Anthropic-shaped list with has_more is fetched again with after_id=<last_id>', async () => {
  const { result, calls } = await discoverScenario('anthropic');
  assert.deepEqual(urlsOf(calls), ['https://api.anthropic.com/v1/models?limit=1000',
    'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5-5']);
  for (const call of calls) {
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.headers['x-api-key'], TEST_KEY);
  }
  assert.deepEqual(result.models.map((model) => model.id),
    ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022']);
  assert.equal(result.anthropicShape, true);
  assert.equal(result.truncated, false);
});

test('MD-01 §3.2 Anthropic paging stops after 5 pages', async () => {
  const pages = (call) => {
    const page = Number(new URL(call.url).searchParams.get('after_id')?.slice(1) ?? 0) + 1;
    return { status: 200, body: { data: [{ id: `m${page}`, type: 'model' }], has_more: true, last_id: `p${page}` } };
  };
  const { result, calls } = await discoverWith(pages, newRequest('https://api.anthropic.com'));
  assert.equal(calls.length, 5);
  assert.equal(calls[4].url, 'https://api.anthropic.com/v1/models?limit=1000&after_id=p4');
  assert.deepEqual(result.models.map((model) => model.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  // 读满 5 页仍不到 1000 条：不算超过条数（A8）
  assert.equal(result.truncated, false);
});

test('MD-01 §3.2 Anthropic paging stops once 1000 models are listed and marks the list truncated', async () => {
  const rows = (from, count) => Array.from({ length: count }, (_, index) => ({ id: `m${from + index}` }));
  const full = { status: 200, body: { data: rows(0, 1000), has_more: true, last_id: 'm999' } };
  const one = await discoverWith(() => full, newRequest('https://api.anthropic.com'));
  assert.equal(one.calls.length, 1);
  assert.equal(one.result.models.length, 1000);
  assert.equal(one.result.truncated, true);
  const two = await discoverWith(sequence(
    { status: 200, body: { data: rows(0, 600), has_more: true, last_id: 'm599' } },
    { status: 200, body: { data: rows(600, 600), has_more: true, last_id: 'm1199' } }),
  newRequest('https://api.anthropic.com'));
  assert.equal(two.calls.length, 2);
  assert.equal(two.calls[1].url, 'https://api.anthropic.com/v1/models?limit=1000&after_id=m599');
  assert.equal(two.result.models.length, 1000);
  assert.equal(two.result.models.at(-1).id, 'm999');
  assert.equal(two.result.truncated, true);
});

test('MD-01 §3.2 the same id is kept only the first time it appears', async () => {
  const { result } = await discoverScenario('edge');
  assert.deepEqual(result.models.map((model) => model.id), ['acme-large', 'acme-small', 'acme-embed', '',
    'acme large v2']);
  // 第一次出现的行：窗口是只含数字的字符串 "65536"，不是第二行的 4096
  assert.equal(modelOf(result, 'acme-large').contextWindow, 65536);
  const paged = await discoverWith(sequence(
    { status: 200, body: { data: [{ id: 'a', max_input_tokens: 1000 }, { id: 'b' }], has_more: true } },
    { status: 200, body: { data: [{ id: 'a', max_input_tokens: 2000 }, { id: 'c' }], has_more: false } }),
  newRequest('https://api.anthropic.com'));
  // 第一页没有 last_id：after_id 取这一页最后一行的 id（D8）
  assert.equal(paged.calls[1].url, 'https://api.anthropic.com/v1/models?limit=1000&after_id=b');
  assert.deepEqual(paged.result.models.map((model) => model.id), ['a', 'b', 'c']);
  assert.equal(modelOf(paged.result, 'a').contextWindow, 1000);
});

test('MD-01 §3.2 a list longer than 1000 keeps the first 1000 and is truncated; 1000 is not', async () => {
  const ids = (count) => Array.from({ length: count }, (_, index) => `model-${String(index).padStart(4, '0')}`);
  const run = (body) => discoverWith(table([['http://192.0.2.49:8000/v1/models', { status: 200, body }]]),
    newRequest('http://192.0.2.49:8000/v1'));
  const over = await run(openaiList(ids(1001)));
  assert.equal(over.result.models.length, 1000);
  assert.equal(over.result.truncated, true);
  assert.deepEqual(over.result.models.map((model) => model.id), ids(1000));
  const exact = await run(openaiList(ids(1000)));
  assert.equal(exact.result.models.length, 1000);
  assert.equal(exact.result.truncated, false);
  // 先去重再数（D9）：1001 行里有一个重复，去重后 1000 条，不算超过
  const duplicated = await run(openaiList([...ids(1000), 'model-0007']));
  assert.equal(duplicated.result.models.length, 1000);
  assert.equal(duplicated.result.truncated, false);
});

test('MD-01 §0 every request of a discovery goes to the origin of the address you entered', async () => {
  for (const name of ['vllm', 'ollama', 'localai', 'dashscope', 'gpustack', 'mindie', 'lmstudio', 'tgi', 'anthropic',
    'together']) {
    const { calls } = await discoverScenario(name);
    const origin = new URL(SCENARIOS[name].raw).origin;
    assert.ok(calls.length > 1, name);
    assert.deepEqual(originsOf(calls), [origin], name);
    // §9：不跟随重定向，所以也不会被带到别的 origin
    for (const call of calls) assert.equal(call.redirect, 'manual', `${name} ${call.url}`);
  }
  const prefix = await discoverWith(() => undefined, newRequest('https://open.bigmodel.cn/api/anthropic'));
  assert.deepEqual(originsOf(prefix.calls), ['https://open.bigmodel.cn']);
});
