// MD-05 API type、名称（docs/specs/model-discovery.md §3.4，§13.2 单元层）：你改过的 API type（target.api）不被改；
// Anthropic 提示 → Anthropic Messages；否则 OpenAI-compatible，Anthropic 形状的列表与 New API 的 supported_endpoint_types
// 都不改 api；名称为主机名加非默认端口。响应体用 tests/fixtures/discovery/bodies/ 的样本，替身 fetch 的其余回答是手写的
// （synthetic，依据规格 §3.2、§3.4）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIOS, discoverScenario, discoverWith, newRequest, openaiList, providerRequest, rules, sample, table,
} from './rules-helpers.mjs';

/** §5.2 DiscoverResult 的字段 */
const RESULT_KEYS = ['anthropicShape', 'api', 'baseUrl', 'cancelled', 'error', 'listError', 'models', 'name',
  'notListed', 'server', 'truncated'];

test('MD-05 §3.4 an API type you changed (target.api) is kept as it is', async () => {
  const cases = [
    ['https://api.anthropic.com', 'openai-completions'], ['https://open.bigmodel.cn/api/anthropic', 'openai-responses'],
    ['http://192.0.2.10:8000/v1', 'openai-responses'], ['http://192.0.2.10:8000/v1', 'anthropic-messages'],
    ['http://192.0.2.10:8000/v1', 'openai-completions'],
  ];
  const routes = table([...SCENARIOS.vllm.routes(), ...SCENARIOS.anthropic.routes()]);
  for (const [raw, api] of cases) {
    const { result } = await discoverWith(routes, newRequest(raw, { api }));
    assert.equal(result.api, api, `${raw} ${api}`);
  }
  // 没拿到列表时同样
  const { result } = await discoverWith(() => undefined, newRequest('http://192.0.2.60:8000/v1',
    { api: 'openai-responses' }));
  assert.deepEqual([result.api, result.listError.kind], ['openai-responses', 'no_list']);
  assert.equal(rules.resultApi('openai-responses', true), 'openai-responses');
});

test('MD-05 §3.4 the Anthropic hint gives Anthropic Messages, also without a list', async () => {
  const { result } = await discoverScenario('anthropic');
  assert.deepEqual([result.api, result.anthropicShape], ['anthropic-messages', true]);
  for (const raw of ['https://open.bigmodel.cn/api/anthropic', 'https://api.anthropic.com/v1/messages']) {
    const missing = await discoverWith(() => undefined, newRequest(raw));
    assert.equal(missing.result.api, 'anthropic-messages', raw);
  }
  assert.equal(rules.resultApi(null, true), 'anthropic-messages');
});

test('MD-05 §3.4 without the hint the API type is OpenAI-compatible, also for an Anthropic-shaped list', async () => {
  // 列表是 Anthropic 形状（has_more），地址里没有提示：api 不变，只是 Detected 一行写法不同（anthropicShape）
  const { body } = sample('newapi-models-anthropic');
  const shaped = await discoverWith(table([['http://192.0.2.61:3000/v1/models', { status: 200, body }]]),
    newRequest('http://192.0.2.61:3000/v1'));
  assert.deepEqual([shaped.result.api, shaped.result.anthropicShape, shaped.result.server.kind],
    ['openai-completions', true, 'unknown']);
  for (const name of ['vllm', 'deepseek', 'openrouter', 'together', 'ollama', 'litellm']) {
    const { result } = await discoverScenario(name);
    assert.equal(result.api, 'openai-completions', name);
  }
  assert.equal(rules.resultApi(null, false), 'openai-completions');
});

test('MD-05 §3.4 New API supported_endpoint_types only decides chat, never the API type', async () => {
  const { result } = await discoverScenario('newapi');
  assert.equal(result.server.kind, 'newapi');
  assert.equal(result.api, 'openai-completions');
  // 行里有 anthropic 端点的模型
  assert.deepEqual(sample('newapi-models').body.data[1].supported_endpoint_types, ['anthropic', 'openai']);
  const list = openaiList(['claude-only'], () => ({ supported_endpoint_types: ['anthropic'] }));
  const anthropicOnly = await discoverWith(table([['http://192.0.2.24:3000/v1/models',
    { status: 200, headers: { 'X-New-Api-Version': 'v0.9.6' }, body: list }]]), newRequest(SCENARIOS.newapi.raw));
  assert.deepEqual([anthropicOnly.result.api, anthropicOnly.result.models[0].chat], ['openai-completions', true]);
});

test('MD-05 §3.4 a saved provider keeps its configured API type whatever the list looks like', async () => {
  const anthropic = sample('newapi-models-anthropic');
  const saved = await discoverWith(table([[anthropic.url, anthropic]]),
    providerRequest('http://192.0.2.24:3000', 'anthropic-messages'));
  assert.deepEqual([saved.result.api, saved.result.server.kind, saved.result.anthropicShape],
    ['anthropic-messages', 'newapi', true]);
  const responses = await discoverWith(table(SCENARIOS.vllm.routes()),
    providerRequest('http://192.0.2.10:8000/v1', 'openai-responses'));
  assert.equal(responses.result.api, 'openai-responses');
});

test('MD-05 §3.4 OpenAI Responses is never chosen without you', async () => {
  for (const name of Object.keys(SCENARIOS)) {
    const { result } = await discoverScenario(name);
    assert.notEqual(result.api, 'openai-responses', name);
    assert.equal(result.api, rules.normalizeBaseUrl(SCENARIOS[name].raw).anthropicHint ? 'anthropic-messages'
      : 'openai-completions', name);
  }
});

test('MD-05 §3.4 the name is the host, with the port when it is not the default for the protocol', async () => {
  const cases = [
    ['https://api.deepseek.com', 'api.deepseek.com'], ['http://10.0.0.5:8000/v1', '10.0.0.5:8000'],
    ['https://api.example.test:443/v1', 'api.example.test'], ['http://192.0.2.62:80/v1', '192.0.2.62'],
    ['http://192.0.2.62:443/v1', '192.0.2.62:443'], ['https://gw.example.test:8443/anthropic', 'gw.example.test:8443'],
    ['http://[::1]:11434/v1', '[::1]:11434'], ['HTTP://LOCALHOST:1234/v1', 'localhost:1234'],
  ];
  for (const [raw, name] of cases) {
    assert.equal(rules.targetName(rules.normalizeBaseUrl(raw).base), name, raw);
    const { result } = await discoverWith(() => undefined, newRequest(raw));
    assert.equal(result.name, name, raw);
  }
  const { result } = await discoverScenario('vllm');
  assert.equal(result.name, '192.0.2.10:8000');
  const saved = await discoverWith(() => undefined, providerRequest('http://192.0.2.63:9997/v1', 'openai-completions'));
  assert.equal(saved.result.name, '192.0.2.63:9997');
});

test('MD-05 §3.4 the network zone is not part of the result', async () => {
  const { result } = await discoverScenario('deepseek');
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
  const failed = await discoverWith(() => undefined, newRequest('http://192.0.2.64:8000/v1'));
  assert.deepEqual(Object.keys(failed.result).sort(), RESULT_KEYS);
});
