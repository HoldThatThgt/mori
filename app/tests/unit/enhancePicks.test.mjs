// kernel/enhance.ts 的 pickThinking 的单元测试（docs/specs/model-providers.md §7.7，MP-39 单元层；记忆规格 §8
// enhance.get 一行与 §10.4 的 2026-10-24 注）：每个选择范围按记忆规格 §9.1 取到的第一个候选（静态校验后的第一个，
// 没有时展开的第一个）的档案 reasoning.off_refused 为真时，这个范围在 noOffPicks 里；没有档案按假；取不到候选的范围
// 两边都不出现；effortPicks 的值不变（仍按第一个候选是否勾了 Supports thinking）。
// 先用替身的模型层（synthetic PickLayer：展开、静态校验的输入与档案都由测试给出），再用真正的 ModelLayer（照
// tests/unit/modelLayer.test.mjs 的做法：pi 的运行时是替身，配置与档案文件写在临时目录，提供商没有 key）。
// enhance.get、enhance.set 两条路（enhanceInfo、setEnhance）经 tests/unit/memory/enhance-harness.mjs 的打包
// （模型层、会话表与一次运行换成替身，synthetic）检查 noOffPicks 确实交到 EnhanceInfo 里。
// 同一套真正的 ModelLayer 还检查存探针结果时的重新编译（§7.4 的 2026-10-24 补、§7.7“变了时重新编译这个提供商”）：
// 有旧档案时只在 off_refused（或 replay）变了才重新注册那个提供商，变回 false 时标记去掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from './load.mjs';
import { at, hooks, loadBundle, scenario, timerClock } from './memory/enhance-harness.mjs';

const E = await loadKernelModule('src/kernel/enhance.ts');
const { ModelLayer } = await loadKernelModule('src/kernel/modelLayer.ts');
const mc = await loadKernelModule('src/kernel/modelConfig.ts');
const mp = await loadKernelModule('src/kernel/modelProfiles.ts');

// ---- 替身的模型层（synthetic PickLayer） ----

/**
 * 配置里的模型（synthetic）：reasoning 为勾了 Supports thinking；tools 为选择器第 3 步的 tool_calling；
 * offRefused 为档案的 reasoning.off_refused，null 表示没有档案。
 */
const MODELS = {
  'or/nooff': { reasoning: true, tools: 'verified', offRefused: true },
  'or/think': { reasoning: true, tools: 'verified', offRefused: false },
  'or/bare': { reasoning: true, tools: 'verified', offRefused: null },
  'lab/raw': { reasoning: true, tools: 'failed', offRefused: true },
  'plain/chat': { reasoning: false, tools: 'verified', offRefused: false },
};

/** 分组（synthetic）：成员的顺序决定第一个候选。 */
const GROUPS = [
  { id: 'strict', members: ['or/nooff', 'or/think'] },
  { id: 'loose', members: ['or/think', 'or/nooff'] },
  { id: 'skips', members: ['lab/raw', 'or/think'] },
  { id: 'fallback', members: ['lab/raw'] },
  { id: 'unprofiled', members: ['or/bare', 'or/nooff'] },
  { id: 'empty', members: [] },
];

/** MODELS 与 GROUPS 的模型配置（synthetic，只有 pickThinking 读到的字段）。 */
function syntheticConfig() {
  const providers = new Map();
  for (const [ref, model] of Object.entries(MODELS)) {
    const [providerId, modelId] = ref.split('/');
    if (!providers.has(providerId)) providers.set(providerId, { id: providerId, name: providerId, models: [] });
    providers.get(providerId).models.push({ id: modelId, reasoning: model.reasoning });
  }
  return { version: 1, providers: [...providers.values()], groups: GROUPS, normalDefault: 'strict',
    allowedZones: ['local'], projectZones: {} };
}

/** 档案（synthetic ProfileView，只填 pickThinking 读到的 reasoning）；没有档案时为 null。 */
function syntheticView(ref) {
  const offRefused = MODELS[ref]?.offRefused ?? null;
  if (offRefused === null) return null;
  return { status: 'ready', reasoning: { field: 'reasoning_content', can_disable: !offRefused,
    replay: 'not_required', off_refused: offRefused } };
}

/**
 * 替身的模型层（synthetic PickLayer）：expandPickIn 按配置展开（不认识的名字为 null），staticBase 按 MODELS 的 tools
 * 做第 3 步，profileOf 按 MODELS 的 offRefused；asked 记下 profileOf 被问到的模型。
 */
function syntheticLayer(config) {
  const asked = [];
  const refsOf = (pick) => {
    const group = config.groups.find((item) => item.id === pick);
    if (group) return [...group.members];
    if (pick.includes('/')) return MODELS[pick] ? [pick] : null;
    const provider = config.providers.find((item) => item.id === pick);
    return provider ? provider.models.map((model) => `${pick}/${model.id}`) : null;
  };
  const layer = {
    expandPickIn: (_context, pick) => refsOf(pick),
    staticBase: () => ({ configError: null, projectError: null, projectZones: null, allowedZones: ['local'],
      exists: (ref) => ref in MODELS, zoneOf: () => 'local', toolCalling: (ref) => MODELS[ref].tools,
      capabilities: () => ({}), familyOf: (ref) => ref }),
    profileOf: (ref) => {
      asked.push(ref);
      return syntheticView(ref);
    },
  };
  return { layer, asked };
}

/** 按 effortPicks 原来的规则（第一个候选勾了 Supports thinking）期望的值：每个取得到候选的范围。 */
const EXPECTED_EFFORT = {
  strict: true, loose: true, skips: true, fallback: true, unprofiled: true,
  or: true, lab: true, plain: false,
  'or/nooff': true, 'or/think': true, 'or/bare': true, 'lab/raw': true, 'plain/chat': false,
};

test('MP-39 enhance: a range whose first candidate has off_refused in its profile is in noOffPicks', () => {
  const { layer } = syntheticLayer(syntheticConfig());
  const { effortPicks, noOffPicks } = E.pickThinking(layer, { path: 'synthetic' }, syntheticConfig());
  assert.deepEqual(noOffPicks, ['strict', 'fallback', 'or', 'lab', 'or/nooff', 'lab/raw'],
    'in the order of the model ranges: groups, providers, models');
  assert.deepEqual(effortPicks, EXPECTED_EFFORT, 'effortPicks values are unchanged');
});

test('MP-39 enhance: groups and providers use their first candidate, the same one effortPicks uses', () => {
  const { layer, asked } = syntheticLayer(syntheticConfig());
  const { noOffPicks } = E.pickThinking(layer, { path: 'synthetic' }, syntheticConfig());
  const has = (pick) => noOffPicks.includes(pick);
  assert.equal(has('strict'), true, '[nooff, think]: the first candidate cannot turn thinking off');
  assert.equal(has('loose'), false, '[think, nooff]: the first candidate can');
  assert.equal(has('skips'), false, '[raw, think]: the static check skips raw, so think is the first candidate');
  assert.equal(has('fallback'), true, '[raw]: no candidate passes, so the first expanded one (raw) is used');
  assert.equal(has('or'), true, 'provider or: its first model is nooff');
  assert.equal(has('plain'), false);
  assert.equal(has('or/think'), false, 'off_refused false');
  assert.equal(has('unprofiled'), false, '[bare, nooff]: bare has no profile, which counts as false');
  assert.equal(has('or/bare'), false, 'no profile counts as false');
  assert.ok(asked.includes('or/think') && asked.includes('or/bare'), JSON.stringify(asked));
});

test('MP-39 enhance: a range without a first candidate is in neither effortPicks nor noOffPicks', () => {
  const config = syntheticConfig();
  const ghost = { ...config, groups: [...config.groups, { id: 'ghost', members: ['gone/model'] }] };
  const { layer } = syntheticLayer(ghost);
  // loose 展开为 null（同范围指向的名字不存在，pick_missing）
  const expand = (context, pick) => (pick === 'loose' ? null : layer.expandPickIn(context, pick));
  const narrowed = { ...layer, expandPickIn: expand };
  const { effortPicks, noOffPicks } = E.pickThinking(narrowed, { path: 'synthetic' }, ghost);
  assert.ok(!('empty' in effortPicks) && !noOffPicks.includes('empty'), 'a group without members');
  assert.ok(!('loose' in effortPicks) && !noOffPicks.includes('loose'), 'a range that expands to nothing');
  assert.equal(effortPicks.ghost, false, 'a missing member is still the first expanded candidate');
  assert.ok(!noOffPicks.includes('ghost'), 'it has no profile');
  const { loose: _loose, ...rest } = EXPECTED_EFFORT;
  assert.deepEqual(effortPicks, { ...rest, ghost: false });
});

test('MP-39 enhance: enhance.get and enhance.set give noOffPicks by each range’s first candidate', async (t) => {
  const s = scenario(t);
  const k = await loadBundle({ enhance: 'src/kernel/enhance.ts', memory: 'src/kernel/memory.ts' },
    ['enhanceRun', 'sessions', 'modelLayer']);
  k.memory.startMemory(s.userData, () => {});
  s.stops.push(() => k.enhance.stopEnhance());
  const config = syntheticConfig();
  // 打包里的模型层替身（synthetic）转给 hooks().modelLayer：同上面的 PickLayer，加上 getConfig、projectContext
  hooks().modelLayer = { ...syntheticLayer(config).layer, getConfig: () => config,
    projectContext: async () => ({ path: 'synthetic' }) };
  const clock = timerClock(at('2026-10-24', '05:00'));
  await k.enhance.startEnhance({ userData: s.userData, emitGlobal: () => {}, clock });
  const cwd = s.project('a-shop');
  const info = await k.enhance.enhanceInfo(cwd);
  assert.equal(info.error, null);
  assert.deepEqual(info.noOffPicks, ['strict', 'fallback', 'or', 'lab', 'or/nooff', 'lab/raw']);
  assert.deepEqual(info.effortPicks, EXPECTED_EFFORT, 'effortPicks values are unchanged');
  const set = await k.enhance.setEnhance(cwd, { team: true });
  assert.equal(set.error, null);
  assert.deepEqual([set.info.noOffPicks, set.info.effortPicks], [info.noOffPicks, info.effortPicks],
    'enhance.set returns the same two lists');
});

// ---- 真正的 ModelLayer（照 tests/unit/modelLayer.test.mjs） ----

/** 提供商（synthetic，没有 key）。 */
function provider(id, models) {
  return { id, name: id.toUpperCase(), api: 'openai-completions', baseUrl: `http://127.0.0.1:9000/${id}`,
    zone: 'local', compat: {}, concurrency: 4, keys: [], nextKeyNumber: 1,
    models: models.map(([modelId, reasoning]) => ({ id: modelId, family: '', contextWindow: 1000, maxTokens: 100,
      reasoning, input: ['text'] })) };
}

/** 第 0–7 步的结果（synthetic AutoResults）：第 3、4 步通过；offRefused 时第 2 步按 §7.7 判为 fail。 */
function autoResults(offRefused) {
  const pass = { outcome: 'pass', detail: null };
  const na = { outcome: 'not_applicable', detail: null };
  const thinking = offRefused ? { outcome: 'fail', detail: 'Thinking can’t be turned off: 400 synthetic' } : pass;
  return { server: { kind: 'unknown', version: 'unknown' }, reported: null, field: 'reasoning_content',
    steps: { ready: pass, thinking, call: pass, result: pass, replay: pass, a: offRefused ? na : pass, b: pass,
      c: { outcome: 'not_run', detail: null } }, offRefused };
}

/** 一份已存档案（synthetic）：autoResults(offRefused) 建成的档案。 */
function storedProfile(p, modelId, offRefused) {
  const target = { baseUrl: p.baseUrl, api: p.api, model: p.models.find((m) => m.id === modelId), compat: p.compat };
  return mp.buildProfile({ target, auto: autoResults(offRefused), now: 5 });
}

/** pi 运行时的替身（synthetic）：记下注册的提供商与每次注册、去掉。 */
function fakeRuntime() {
  return {
    calls: [],
    registered: new Map(),
    registerProvider(id, input) {
      this.calls.push(`register ${id}`);
      this.registered.set(id, input);
    },
    unregisterProvider(id) {
      this.calls.push(`unregister ${id}`);
      this.registered.delete(id);
    },
    async refresh() {},
    getModel() { return undefined; },
    getProviders() { return []; },
  };
}

/** 提供商 or（synthetic）：nooff、think 都勾了 Supports thinking。 */
const OR = provider('or', [['nooff', true], ['think', true]]);
/** 提供商 plain（synthetic）：chat 没勾。 */
const PLAIN = provider('plain', [['chat', false]]);

/**
 * 真正的 ModelLayer：配置（synthetic）为 OR、PLAIN 与分组 strict [or/nooff, or/think]、loose [or/think, or/nooff]，
 * 和 profiles 一起写在临时目录，测试结束删掉；载入（编译到替身的运行时）之后交出。
 * @param t node:test 的测试上下文
 * @param profiles 已存的档案（synthetic）
 */
async function realLayer(t, profiles) {
  const config = { version: 1, providers: [OR, PLAIN], normalDefault: 'strict', allowedZones: ['local', 'intranet'],
    projectZones: {}, groups: [{ id: 'strict', members: ['or/nooff', 'or/think'] },
      { id: 'loose', members: ['or/think', 'or/nooff'] }] };
  const dir = mkdtempSync(join(tmpdir(), 'mori-enhance-picks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { config: join(dir, 'model-config.json'), profiles: join(dir, 'model-profiles.json'),
    notice: join(dir, 'model-migration.json'), v0Models: join(dir, 'agent', 'models.json') };
  writeFileSync(paths.config, JSON.stringify(config));
  writeFileSync(paths.profiles, JSON.stringify({ version: 1, profiles }));
  const runtime = fakeRuntime();
  const layer = new ModelLayer(runtime, mc.reservedIds(['openai']), paths, () => {});
  await layer.load({}, [], null);
  return { layer, runtime, dir };
}

test('MP-39 enhance: with a real ModelLayer, noOffPicks follows the stored profile of each first candidate',
  async (t) => {
    const { layer, runtime, dir } = await realLayer(t,
      [storedProfile(OR, 'nooff', true), storedProfile(OR, 'think', false)]);
    assert.equal(layer.profileOf('or/nooff').reasoning.off_refused, true);
    assert.equal(layer.profileOf('or/think').reasoning.off_refused, false);
    assert.equal(layer.profileOf('plain/chat'), null, 'plain/chat has no profile');
    assert.deepEqual(runtime.registered.get('or').models.map((m) => m.thinkingLevelMap), [{ off: null }, undefined],
      'synthetic setup check: the layer compiled the stored flag');
    const project = join(dir, 'project');
    mkdirSync(project);
    const context = await layer.projectContext(project);
    const { effortPicks, noOffPicks } = E.pickThinking(layer, context, layer.getConfig());
    assert.deepEqual(noOffPicks, ['strict', 'or', 'or/nooff']);
    assert.deepEqual(effortPicks, { strict: true, loose: true, or: true, plain: false, 'or/nooff': true,
      'or/think': true, 'plain/chat': false });
  });

// ---- 存探针结果时的重新编译（§7.4 的 2026-10-24 补、§7.7） ----

/**
 * 模型层存一次 or/nooff 的第 0–7 步结果（同探针结束时：在 edit 里调 storeProbe）。storeProbe 在 TS 里是 private，
 * 打包后的模块里照样能调；model 是 pi 里注册的实际模型（synthetic，storeProbe 不读它）。
 * @param layer 真正的 ModelLayer
 * @param offRefused 这次判出思考关不掉（synthetic 的 autoResults）
 */
function storeAuto(layer, offRefused) {
  const job = { ref: 'or/nooff', target: layer.profileTarget('or/nooff'), model: { provider: 'or', id: 'nooff' } };
  return layer.edit(() => layer.storeProbe(job, autoResults(offRefused)));
}

test('MP-39 modelLayer: a stored probe result whose off_refused changed re-registers only that provider in pi',
  async (t) => {
    const { layer, runtime } = await realLayer(t,
      [storedProfile(OR, 'nooff', false), storedProfile(OR, 'think', false)]);
    const markers = () => runtime.registered.get('or').models.map((m) => m.thinkingLevelMap);
    assert.deepEqual(markers(), [undefined, undefined], 'synthetic setup check: the old profile has off_refused false');
    runtime.calls.length = 0;
    await storeAuto(layer, true);
    assert.equal(layer.profileOf('or/nooff').reasoning.off_refused, true);
    assert.deepEqual(runtime.calls, ['register or'], 'only or is registered again, plain is not touched');
    assert.deepEqual(markers(), [{ off: null }, undefined]);
    assert.ok(!Object.hasOwn(runtime.registered.get('or').models[1], 'thinkingLevelMap'));
    runtime.calls.length = 0;
    await storeAuto(layer, true);
    assert.deepEqual(runtime.calls, [], 'the same flags again: pi is not touched');
    assert.deepEqual(markers(), [{ off: null }, undefined]);
    await storeAuto(layer, false);
    assert.equal(layer.profileOf('or/nooff').reasoning.off_refused, false);
    assert.deepEqual(runtime.calls, ['register or']);
    assert.ok(!Object.hasOwn(runtime.registered.get('or').models[0], 'thinkingLevelMap'),
      'back to false: or/nooff is registered without the marker');
  });
