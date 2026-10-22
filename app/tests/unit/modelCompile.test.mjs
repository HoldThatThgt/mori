// kernel/modelCompile.ts 的单元测试（规格 §4.4、§7.6，MP-02 单元层）：配置与档案 → registerProvider 的输入、
// pi 里只有占位 key、配置里删掉的提供商 unregisterProvider、只重新注册改动过的提供商、出错时回滚。
// pi 的运行时是替身（synthetic），只记下注册、去掉与刷新。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const C = await loadKernelModule('src/kernel/modelCompile.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

const PLACEHOLDER = MODEL_TIMINGS.placeholderApiKey;
const never = () => false;

/** 一个模型。 */
function model(id, overrides = {}) {
  return { id, family: '', contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ['text'], ...overrides };
}

/** 一个提供商。 */
function provider(id, overrides = {}) {
  return {
    id, name: `Provider ${id}`, api: 'openai-completions', baseUrl: `http://127.0.0.1:4319/${id}/v1`, zone: 'local',
    compat: {}, concurrency: 4, keys: [{ ref: `${id}#1`, label: 'Key 1' }], nextKeyNumber: 2,
    models: [model('chat')], ...overrides,
  };
}

/** 一份配置。 */
function config(providers) {
  return { version: 1, providers, groups: [], normalDefault: null, allowedZones: ['local', 'intranet'],
    projectZones: {} };
}

/** 替身运行时：记下每次调用；throwOn 里的提供商 id 在注册时抛错。 */
function fakeRuntime(throwOn = new Set()) {
  const calls = [];
  const registered = new Map();
  return {
    calls,
    registered,
    registerProvider(id, input) {
      calls.push(['register', id]);
      if (throwOn.has(id)) throw new Error(`Provider ${id}: invalid`);
      registered.set(id, structuredClone(input));
    },
    unregisterProvider(id) {
      calls.push(['unregister', id]);
      registered.delete(id);
    },
    async refresh(options) {
      calls.push(['refresh', options.allowNetwork]);
    },
  };
}

test('MP-02 providerInput: placeholder key, name = id, zero cost, config fields', () => {
  const input = C.providerInput(provider('glm', { models: [model('glm-4.6', { reasoning: true,
    input: ['text', 'image'], contextWindow: 200000, maxTokens: 16384 })] }), never, PLACEHOLDER);
  assert.equal(input.apiKey, 'mori-pool');
  assert.equal(input.name, 'Provider glm');
  assert.equal(input.baseUrl, 'http://127.0.0.1:4319/glm/v1');
  assert.equal(input.api, 'openai-completions');
  assert.deepEqual(input.models, [{
    id: 'glm-4.6', name: 'glm-4.6', api: 'openai-completions', input: ['text', 'image'], reasoning: true,
    contextWindow: 200000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }]);
  assert.ok(!JSON.stringify(input).includes('#1'), 'key refs do not reach pi');
});

test('MP-02 compat: the six config fields plus requiresReasoningContentOnAssistantMessages from the profile', () => {
  const p = provider('ds', { compat: { maxTokensField: 'max_tokens', supportsStore: false },
    models: [model('reasoner', { reasoning: true }), model('chat')] });
  const replay = (prov, m) => prov.id === 'ds' && m.id === 'reasoner';
  const input = C.providerInput(p, replay, PLACEHOLDER);
  assert.deepEqual(input.models[0].compat, { maxTokensField: 'max_tokens', supportsStore: false,
    requiresReasoningContentOnAssistantMessages: true });
  assert.deepEqual(input.models[1].compat, { maxTokensField: 'max_tokens', supportsStore: false });
});

test('MP-02 compat: omitted when empty and for the other two APIs', () => {
  assert.equal(C.providerInput(provider('a'), never, PLACEHOLDER).models[0].compat, undefined);
  for (const api of ['openai-responses', 'anthropic-messages']) {
    const input = C.providerInput(provider('b', { api, compat: { supportsStore: false } }), () => true, PLACEHOLDER);
    assert.equal(input.models[0].compat, undefined, api);
    assert.equal(input.models[0].api, api);
  }
});

test('MP-02 compileInputs: one entry per provider; null config has none', () => {
  const inputs = C.compileInputs(config([provider('a'), provider('b')]), never, PLACEHOLDER);
  assert.deepEqual([...inputs.keys()], ['a', 'b']);
  assert.equal(C.compileInputs(null, never, PLACEHOLDER).size, 0);
});

test('MP-02 compilePlan: registers new and changed providers, unregisters removed ones, skips unchanged', () => {
  const current = C.compileInputs(config([provider('a'), provider('b'), provider('c')]), never, PLACEHOLDER);
  const next = C.compileInputs(config([provider('a'), provider('b', { name: 'Renamed' }), provider('d')]), never,
    PLACEHOLDER);
  const plan = C.compilePlan(next, current);
  assert.deepEqual(plan.register.map(([id]) => id), ['b', 'd']);
  assert.deepEqual(plan.unregister, ['c']);
});

test('MP-02 compilePlan: a replay change re-registers only that provider', () => {
  const cfg = config([provider('a'), provider('b', { models: [model('r', { reasoning: true })] })]);
  const current = C.compileInputs(cfg, never, PLACEHOLDER);
  const next = C.compileInputs(cfg, (p) => p.id === 'b', PLACEHOLDER);
  const plan = C.compilePlan(next, current);
  assert.deepEqual(plan.register.map(([id]) => id), ['b']);
  assert.deepEqual(plan.unregister, []);
});

test('MP-02 rollbackPlan: changed providers get their old input back, added ones go, removed ones come back', () => {
  const current = C.compileInputs(config([provider('a'), provider('b')]), never, PLACEHOLDER);
  const next = C.compileInputs(config([provider('a', { name: 'New name' }), provider('n')]), never, PLACEHOLDER);
  const plan = C.compilePlan(next, current);
  const back = C.rollbackPlan(plan, current);
  assert.deepEqual(back.register.map(([id, input]) => [id, input.name]), [['a', 'Provider a'], ['b', 'Provider b']]);
  assert.deepEqual(back.unregister, ['n']);
});

test('MP-02 ModelCompiler: registers, awaits refresh without network, then only changes', async () => {
  const runtime = fakeRuntime();
  const compiler = new C.ModelCompiler(runtime, PLACEHOLDER);
  await compiler.compile(config([provider('a'), provider('b')]), never);
  assert.deepEqual(runtime.calls, [['register', 'a'], ['register', 'b'], ['refresh', false]]);
  assert.equal(runtime.registered.get('a').apiKey, 'mori-pool');
  runtime.calls.length = 0;
  await compiler.compile(config([provider('a')]), never);
  assert.deepEqual(runtime.calls, [['unregister', 'b'], ['refresh', false]]);
  assert.deepEqual(compiler.registeredIds(), ['a']);
  runtime.calls.length = 0;
  await compiler.compile(config([provider('a')]), never);
  assert.deepEqual(runtime.calls, [], 'nothing changed: pi is not touched');
});

test('MP-02 ModelCompiler: a pi error rolls back and keeps the previous registration', async () => {
  const runtime = fakeRuntime(new Set(['bad']));
  const compiler = new C.ModelCompiler(runtime, PLACEHOLDER);
  await compiler.compile(config([provider('a'), provider('gone')]), never);
  runtime.calls.length = 0;
  const broken = config([provider('a', { name: 'Edited' }), provider('bad')]);
  await assert.rejects(compiler.compile(broken, never), /Provider bad: invalid/);
  assert.deepEqual(runtime.calls, [
    ['register', 'a'], ['register', 'bad'],
    ['register', 'a'], ['register', 'gone'], ['unregister', 'bad'], ['refresh', false],
  ]);
  assert.equal(runtime.registered.get('a').name, 'Provider a');
  assert.ok(runtime.registered.has('gone'));
  assert.ok(!runtime.registered.has('bad'));
  assert.deepEqual(compiler.registeredIds(), ['a', 'gone']);
  runtime.calls.length = 0;
  await compiler.compile(config([provider('a'), provider('gone')]), never);
  assert.deepEqual(runtime.calls, [], 'after the rollback pi matches the previous configuration');
});

test('MP-02 ModelCompiler: a failing refresh also rolls back', async () => {
  const runtime = fakeRuntime();
  const compiler = new C.ModelCompiler(runtime, PLACEHOLDER);
  await compiler.compile(config([provider('a')]), never);
  let fail = true;
  runtime.refresh = async (options) => {
    runtime.calls.push(['refresh', options.allowNetwork]);
    if (fail) {
      fail = false;
      throw new Error('refresh failed');
    }
  };
  runtime.calls.length = 0;
  await assert.rejects(compiler.compile(config([provider('a'), provider('b')]), never), /refresh failed/);
  assert.deepEqual(runtime.calls, [['register', 'b'], ['refresh', false], ['unregister', 'b'], ['refresh', false]]);
  assert.deepEqual(compiler.registeredIds(), ['a']);
});
