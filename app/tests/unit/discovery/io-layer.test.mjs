// 发现命令的单元测试（docs/specs/model-discovery.md §13.2 MD-06，单元层）：已有提供商交给读取器的目标（§5.1、§3.1：
// 地址与 Anthropic 提示按配置、不整理；key 用第一个不在 rate_limited、auth、quota 记录里的、有明文的 key，都在时用第一个，
// 没有 key 时不带认证头，A1；shareKey = baseUrl + api + key 的 ref，§5.3），以及命令的参数（§5.1、§5.2、§5.3）。
// 配置、key 与 key 的记录都是 synthetic；模型池的记录用替身给出（记录本身的规则见 tests/unit/modelPool.test.mjs 的 MP-29）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  captureConsole, configOf, configProvider, json, scratchLayer, stubGlobalFetch,
} from './io-helpers.mjs';

const { ModelLayer } = await loadKernelModule('src/kernel/modelLayer.ts');
const { reservedIds } = await loadKernelModule('src/kernel/modelConfig.ts');
const { headerSafeSecret } = await loadKernelModule('src/kernel/modelCommands.ts');
const { discoverFailure } = await loadKernelModule('src/kernel/modelDiscover.ts');
const models = await loadKernelModule('src/shared/models.ts');

const BASE = 'http://127.0.0.1:9000/p';
const ANTHROPIC = 'http://127.0.0.1:9002/api/anthropic';

/** @brief p（三个 key，p#3 的明文不在内存里）、a（Anthropic Messages，一个 key）、n（没有 key）的模型层。 */
async function layerWithKeys(t) {
  captureConsole(t);
  const config = configOf([configProvider('p', BASE, ['m1'], { keys: ['p#1', 'p#2', 'p#3'] }),
    configProvider('a', ANTHROPIC, ['claude'], { keys: ['a#1'], api: 'anthropic-messages' }),
    configProvider('n', 'http://127.0.0.1:9003/v1', ['m'])]);
  const { layer } = scratchLayer(ModelLayer, reservedIds(['openai']), { config });
  await layer.load({ 'p#1': 'sk-test-p1', 'p#2': 'sk-test-p2', 'a#1': 'sk-test-a1' }, ['p#1', 'p#2', 'p#3', 'a#1'],
    null);
  const provider = (id) => layer.getConfig().providers.find((item) => item.id === id);
  return { layer, provider };
}

/** @brief 让模型池报告这些 key 的记录（替身；真实的记录来自请求的结果）。 */
function recordKeys(layer, records) {
  const pool = layer.getPool();
  pool.keyStatus = () => Object.fromEntries(Object.entries(records).map(([ref, state]) => [ref,
    { state, until: state === 'rate_limited' ? Date.now() + 60_000 : null }]));
}

test('MD-06 an existing provider is read with its saved address and first key; shareKey is baseUrl|api|ref',
  async (t) => {
    const { layer, provider } = await layerWithKeys(t);
    assert.deepEqual(layer.readTarget(provider('p')), { base: BASE, anthropicHint: false, existing: true,
      secret: 'sk-test-p1', shareKey: `${BASE}|openai-completions|p#1` });
    assert.deepEqual(layer.readTarget(provider('a')), { base: ANTHROPIC, anthropicHint: true, existing: true,
      secret: 'sk-test-a1', shareKey: `${ANTHROPIC}|anthropic-messages|a#1` });
    assert.deepEqual(layer.readTarget(provider('n')), { base: 'http://127.0.0.1:9003/v1', anthropicHint: false,
      existing: true, secret: null, shareKey: 'http://127.0.0.1:9003/v1|openai-completions|' });
  });

test('MD-06 a key with a rate_limited, auth or quota record is skipped; all recorded uses the first (§5.1)',
  async (t) => {
    const { layer, provider } = await layerWithKeys(t);
    for (const state of ['rate_limited', 'auth', 'quota']) {
      recordKeys(layer, { 'p#1': state });
      const target = layer.readTarget(provider('p'));
      assert.equal(target.secret, 'sk-test-p2', state);
      assert.equal(target.shareKey, `${BASE}|openai-completions|p#2`, state);
    }
    // p#3 没有记录，但明文不在内存里（A1）：p#1、p#2 都有记录时用第一个有明文的 key
    recordKeys(layer, { 'p#1': 'auth', 'p#2': 'quota' });
    assert.equal(layer.readTarget(provider('p')).secret, 'sk-test-p1');
    assert.equal(layer.readTarget(provider('p')).shareKey, `${BASE}|openai-completions|p#1`);
  });

test('MD-06 the chosen key reaches the list request of an existing provider and never the result', async (t) => {
  const { layer, provider } = await layerWithKeys(t);
  recordKeys(layer, { 'p#1': 'auth' });
  const stub = stubGlobalFetch(t, (call) => (call.path === '/p/models'
    ? json({ object: 'list', data: [{ id: 'm1', owned_by: 'vllm' }] }) : json({ version: '0.10.1' })));
  const result = await layer.reader.command({ ...layer.readTarget(provider('p')), api: 'openai-completions',
    configured: ['m1'] });
  assert.equal(stub.calls[0].url, `${BASE}/models`);
  assert.equal(stub.calls[0].headers.authorization, 'Bearer sk-test-p2');
  assert.deepEqual(result.models.map((model) => [model.id, model.added]), [['m1', true]]);
  assert.ok(!JSON.stringify(result).includes('sk-test'), 'the key does not come back');
});

/** @brief 按 ModelCommandSchemas 里 type 对应的那个 schema 校验一条命令。 */
function parseCommand(command) {
  const schema = models.ModelCommandSchemas.find((item) => item.shape.type.value === command.type);
  return schema.safeParse(command);
}

test('MD-06 models.discover takes a new target or a provider target; discoverCancel takes nothing', () => {
  const ok = [
    { kind: 'new', baseUrl: 'http://10.0.0.5:8000', api: null, keySecret: null },
    { kind: 'new', baseUrl: 'https://api.example.test/v1', api: 'anthropic-messages', keySecret: 'sk-test-x' },
    { kind: 'new', baseUrl: 'not a url', api: 'openai-responses', keySecret: '' },
    { kind: 'provider', providerId: 'glm' },
  ];
  for (const target of ok) {
    assert.equal(parseCommand({ type: 'models.discover', target }).success, true, JSON.stringify(target));
  }
  const bad = [
    { kind: 'new', baseUrl: 'http://10.0.0.5:8000', api: 'openai', keySecret: null },
    { kind: 'new', baseUrl: 'http://10.0.0.5:8000', keySecret: null },
    { kind: 'provider', providerId: '' },
    { kind: 'other' },
  ];
  for (const target of bad) {
    assert.equal(parseCommand({ type: 'models.discover', target }).success, false, JSON.stringify(target));
  }
  assert.equal(parseCommand({ type: 'models.discover' }).success, false);
  assert.equal(parseCommand({ type: 'models.discoverCancel' }).success, true);
  assert.deepEqual(parseCommand({ type: 'models.discoverCancel', target: { kind: 'provider', providerId: 'p' } }).data,
    { type: 'models.discoverCancel' });
});

test('MD-06 a new target key follows the saved-key rule; its error text never carries the key', () => {
  assert.equal(headerSafeSecret('  sk-test-ok_1.2\n'), 'sk-test-ok_1.2');
  for (const key of ['sk-test with-space-SECRET', 'sk-test-​zero-width-SECRET', 'sk-test-Ａ-fullwidth-SECRET']) {
    assert.throws(() => headerSafeSecret(key), (error) => error.message
      === 'API key contains characters that cannot be sent in a header' && !error.message.includes('SECRET'));
  }
});

test('MD-06 a failed command gives the §5.2 error result: not cancelled, no server, nothing listed', () => {
  assert.deepEqual(discoverFailure('Base URL must be an http or https URL.'), {
    error: 'Base URL must be an http or https URL.', cancelled: false, server: null, api: 'openai-completions',
    baseUrl: '', name: '', anthropicShape: false, listError: null, models: [], truncated: false, notListed: [],
  });
});
