// kernel/modelCompile.ts 的单元测试（规格 §4.4、§7.6，MP-02 单元层）：配置与档案 → registerProvider 的输入、
// pi 里只有占位 key、配置里删掉的提供商 unregisterProvider、只重新注册改动过的提供商、出错时回滚。
// pi 的运行时是替身（synthetic），只记下注册、去掉与刷新。
// 2026-10-24（§7.7，MP-39 单元层）：档案的 off_refused 编译成模型上的 thinkingLevelMap: { off: null }（三种接口，
// 不放进 compat，每个模型一个新对象），与回传推理的 compat 并存；off_refused 变了只重新注册那个提供商，变回 false
// 时标记去掉；标记交给 pi-ai 自己的 getSupportedThinkingLevels、clampThinkingLevel 检查确实起作用。
// 这一组的提供商、配置与档案编译项（noOff、thinkingProvider、asPiModel 建的）都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { loadKernelModule } from './load.mjs';

const C = await loadKernelModule('src/kernel/modelCompile.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

const PLACEHOLDER = MODEL_TIMINGS.placeholderApiKey;

/** 档案给一个模型的编译项（ProfileLookup 的返回值，§7.6）。 */
const flags = (replayRequired = false, offRefused = false) => ({ replayRequired, offRefused });
/** 没有档案（或档案什么都不要求）：两项都为 false。 */
const never = () => flags();

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
  const replay = (prov, m) => flags(prov.id === 'ds' && m.id === 'reasoner');
  const input = C.providerInput(p, replay, PLACEHOLDER);
  assert.deepEqual(input.models[0].compat, { maxTokensField: 'max_tokens', supportsStore: false,
    requiresReasoningContentOnAssistantMessages: true });
  assert.deepEqual(input.models[1].compat, { maxTokensField: 'max_tokens', supportsStore: false });
});

test('MP-02 compat: omitted when empty and for the other two APIs', () => {
  assert.equal(C.providerInput(provider('a'), never, PLACEHOLDER).models[0].compat, undefined);
  for (const api of ['openai-responses', 'anthropic-messages']) {
    const input = C.providerInput(provider('b', { api, compat: { supportsStore: false } }), () => flags(true),
      PLACEHOLDER);
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
  const next = C.compileInputs(cfg, (p) => flags(p.id === 'b'), PLACEHOLDER);
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

// ---- 思考关不掉的模型：没有 Off 的标记（§7.6 的表、§7.7，MP-39） ----

const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

/** 档案判出 off_refused 的模型（synthetic）：提供商 providerId 里的 modelIds（其余模型两项都为 false）。 */
function noOff(providerId, ...modelIds) {
  return (prov, m) => flags(false, prov.id === providerId && modelIds.includes(m.id));
}

/** 提供商 or（synthetic，接口 api）：两个勾了 Supports thinking 的模型 nooff、think。 */
function thinkingProvider(api = 'openai-completions', overrides = {}) {
  return provider('or', { api, models: [model('nooff', { reasoning: true }), model('think', { reasoning: true })],
    ...overrides });
}

/** 一个模型的注册内容拿去给 pi-ai 读时的样子（registerProvider 补上的 provider、baseUrl，synthetic）。 */
function asPiModel(input) {
  return { ...input, provider: 'or', baseUrl: 'http://127.0.0.1:4319/openrouter.ai/v1' };
}

test('MP-39 compile: off_refused puts thinkingLevelMap { off: null } on the model, all three APIs, never in compat',
  () => {
    for (const api of APIS) {
      const [marked, plain] = C.providerInput(thinkingProvider(api), noOff('or', 'nooff'), PLACEHOLDER).models;
      assert.deepEqual(marked.thinkingLevelMap, { off: null }, api);
      assert.equal(marked.compat, undefined, `${api}: no compat fields, so the marker does not create a compat`);
      assert.ok(!Object.hasOwn(plain, 'thinkingLevelMap'), `${api}: a model without off_refused has no marker`);
      assert.deepEqual(Object.keys(marked), ['id', 'name', 'api', 'input', 'reasoning', 'contextWindow', 'maxTokens',
        'cost', 'thinkingLevelMap'], api);
    }
    const withCompat = thinkingProvider('openai-completions',
      { compat: { supportsStore: false, maxTokensField: 'max_tokens' } });
    const marked = C.providerInput(withCompat, noOff('or', 'nooff'), PLACEHOLDER).models[0];
    assert.deepEqual(marked.compat, { supportsStore: false, maxTokensField: 'max_tokens' },
      'compat keeps only the config fields');
    assert.deepEqual(marked.thinkingLevelMap, { off: null });
    assert.ok(!Object.hasOwn(withCompat.compat, 'thinkingLevelMap'), 'the configured compat is untouched');
  });

test('MP-39 compile: every marked model gets its own thinkingLevelMap object', () => {
  const cfg = config([thinkingProvider(),
    provider('an', { api: 'anthropic-messages', models: [model('a', { reasoning: true })] })]);
  const all = () => flags(false, true);
  const maps = [...C.compileInputs(cfg, all, PLACEHOLDER).values()]
    .flatMap((input) => input.models.map((m) => m.thinkingLevelMap));
  assert.equal(maps.length, 3);
  for (const map of maps) assert.deepEqual(map, { off: null });
  assert.equal(new Set(maps).size, 3, 'no object is shared between models');
  maps[0].minimal = null;
  assert.deepEqual(maps[1], { off: null }, 'changing one model’s map leaves the others alone');
  assert.deepEqual(C.compileInputs(cfg, all, PLACEHOLDER).get('or').models[0].thinkingLevelMap, { off: null },
    'a new compile starts from a fresh object');
});

test('MP-39 compile: replay compat and the no-Off marker work side by side', () => {
  const both = () => flags(true, true);
  const reasoner = () => provider('ds', { compat: { supportsStore: false },
    models: [model('reasoner', { reasoning: true })] });
  const completions = C.providerInput(reasoner(), both, PLACEHOLDER).models[0];
  assert.deepEqual(completions.compat, { supportsStore: false, requiresReasoningContentOnAssistantMessages: true });
  assert.deepEqual(completions.thinkingLevelMap, { off: null });
  const replayOnly = C.providerInput(reasoner(), () => flags(true, false), PLACEHOLDER).models[0];
  assert.deepEqual(replayOnly.compat, { supportsStore: false, requiresReasoningContentOnAssistantMessages: true });
  assert.ok(!Object.hasOwn(replayOnly, 'thinkingLevelMap'), 'replay alone adds no marker');
  for (const api of ['openai-responses', 'anthropic-messages']) {
    const other = C.providerInput(provider('x', { api, models: [model('r', { reasoning: true })] }), both,
      PLACEHOLDER).models[0];
    assert.equal(other.compat, undefined, `${api}: replay compat is only for openai-completions`);
    assert.deepEqual(other.thinkingLevelMap, { off: null }, api);
  }
});

test('MP-39 compile: pi-ai reads the marker: no Off level, and the session’s Off clamps to minimal', () => {
  for (const api of APIS) {
    const models = C.providerInput(thinkingProvider(api), noOff('or', 'nooff'), PLACEHOLDER).models;
    const [marked, plain] = models.map(asPiModel);
    assert.deepEqual(getSupportedThinkingLevels(marked), ['minimal', 'low', 'medium', 'high'], api);
    assert.equal(clampThinkingLevel(marked, 'off'), 'minimal', api);
    assert.equal(clampThinkingLevel(marked, 'high'), 'high', api);
    assert.deepEqual(getSupportedThinkingLevels(plain), ['off', 'minimal', 'low', 'medium', 'high'], api);
    assert.equal(clampThinkingLevel(plain, 'off'), 'off', api);
  }
});

test('MP-39 compilePlan: an off_refused change re-registers only that provider; back to false drops the marker', () => {
  const cfg = config([provider('a', { models: [model('r', { reasoning: true })] }),
    provider('b', { models: [model('r', { reasoning: true }), model('s', { reasoning: true })] })]);
  const before = C.compileInputs(cfg, never, PLACEHOLDER);
  const marked = C.compileInputs(cfg, noOff('b', 'r'), PLACEHOLDER);
  const plan = C.compilePlan(marked, before);
  assert.deepEqual(plan.register.map(([id]) => id), ['b']);
  assert.deepEqual(plan.unregister, []);
  assert.deepEqual(plan.register[0][1].models.map((m) => m.thinkingLevelMap), [{ off: null }, undefined]);
  assert.deepEqual(C.compilePlan(C.compileInputs(cfg, noOff('b', 'r'), PLACEHOLDER), marked).register, [],
    'the same flags again change nothing');
  const back = C.compilePlan(C.compileInputs(cfg, never, PLACEHOLDER), marked);
  assert.deepEqual(back.register.map(([id]) => id), ['b']);
  assert.deepEqual(back.unregister, []);
  assert.ok(back.register[0][1].models.every((m) => !Object.hasOwn(m, 'thinkingLevelMap')), 'the marker is gone');
  assert.deepEqual(back.register[0][1], before.get('b'), 'b is registered as it was before the marker');
});

test('MP-39 ModelCompiler: an off_refused change re-registers that provider in pi; clearing it removes the marker',
  async () => {
    const runtime = fakeRuntime();
    const compiler = new C.ModelCompiler(runtime, PLACEHOLDER);
    const cfg = config([provider('a'), thinkingProvider('openai-responses')]);
    await compiler.compile(cfg, never);
    assert.ok(!Object.hasOwn(runtime.registered.get('or').models[0], 'thinkingLevelMap'));
    runtime.calls.length = 0;
    await compiler.compile(cfg, noOff('or', 'nooff'));
    assert.deepEqual(runtime.calls, [['register', 'or'], ['refresh', false]]);
    assert.deepEqual(runtime.registered.get('or').models[0].thinkingLevelMap, { off: null });
    assert.equal(runtime.registered.get('or').models[0].compat, undefined);
    assert.ok(!Object.hasOwn(runtime.registered.get('or').models[1], 'thinkingLevelMap'));
    runtime.calls.length = 0;
    await compiler.compile(cfg, noOff('or', 'nooff'));
    assert.deepEqual(runtime.calls, [], 'unchanged flags: pi is not touched');
    await compiler.compile(cfg, never);
    assert.deepEqual(runtime.calls, [['register', 'or'], ['refresh', false]]);
    assert.ok(!Object.hasOwn(runtime.registered.get('or').models[0], 'thinkingLevelMap'),
      'back to false: pi gets the model without the marker');
  });
