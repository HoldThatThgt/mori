// MD-16（docs/specs/model-discovery.md §4.1、§4.4、§5.2、§7.1、§7.2，2026-10-26 负责人走查回答 1，WP-15）：服务没报告的
// 窗口、最大输出、是否支持思考取 pi 自带模型表的哪几项（discoverRead.ts fromCatalog、readRow、finalizeModel；条目是手写的
// synthetic），读取器对真实录制的 z.ai 列表（glm-models-1.json，地址 https://api.z.ai/api/anthropic）与 OpenRouter、
// DeepSeek 列表的结果（catalogEntry 查的是安装的 pi-ai 1.3.0 的真实模型表），第 0 步的报告值仍只有服务的，以及档案视图的
// catalog（modelProfiles.ts profileView）。替身 fetch 是 synthetic（rules-helpers.mjs）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  SCENARIOS, discoverWith, modelOf, newRequest, providerRequest, readerWith, routeOf, rules, sample, table,
} from './rules-helpers.mjs';

const P = await loadKernelModule('src/kernel/modelProfiles.ts');
const C = await loadKernelModule('src/kernel/piCatalog.ts');
await C.loadCatalog();

/** @brief 同模型层（modelLayer.ts profileOf）拼档案视图：pi 的条目按 target 的地址与 id 查好传进去。 */
const layerView = (target, stored, running) => P.profileView(target, stored, running,
  C.catalogEntry(target.baseUrl, target.model.id));

/** 手写的条目（synthetic）：同 pi 的 Z.AI 条目给 glm-5.3 的值 */
const ENTRY = Object.freeze({ provider: 'Z.AI', contextWindow: 1000000, maxTokens: 131072, reasoning: true });
/** 服务什么都没报告 */
const NONE = Object.freeze({ contextWindow: null, maxTokens: null, reasoning: null });
/** 一般的列表（不是 Anthropic 形状）的读一行上下文 */
const CTX = Object.freeze({ kind: 'unknown', anthropicShape: false });
/** 负责人的 z.ai 提供商的地址（Anthropic 接口） */
const ZAI = 'https://api.z.ai/api/anthropic';
/** 录下的 z.ai 列表（真实录制，2026-10-24） */
const GLM = sample('glm-models-1');
/** pi 的 Z.AI 条目有的 id（pi-ai 1.3.0）；录下的列表里有的是这五个 */
const ZAI_IDS = ['glm-4.7', 'glm-5-turbo', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash'];

/** @brief finalizeModel 的标记（§4.3、§4.4）。 */
const flags = (catalog) => ({ trained: false, added: false, catalog });

test('MD-16 §4.4 only what the server did not report is taken: window, max output below the window, thinking', () => {
  assert.deepEqual(rules.fromCatalog(ENTRY, NONE),
    { provider: 'Z.AI', contextWindow: 1000000, maxTokens: 131072, reasoning: true });
  // 服务报告了窗口：只取最大输出（小于服务的窗口）与思考
  assert.deepEqual(rules.fromCatalog(ENTRY, { contextWindow: 200000, maxTokens: null, reasoning: null }),
    { provider: 'Z.AI', contextWindow: null, maxTokens: 131072, reasoning: true });
  // 服务报告了最大输出与思考：只取窗口
  assert.deepEqual(rules.fromCatalog(ENTRY, { contextWindow: null, maxTokens: 8192, reasoning: true }),
    { provider: 'Z.AI', contextWindow: 1000000, maxTokens: null, reasoning: false });
  // 服务明确报告没有思考：思考不取
  assert.equal(rules.fromCatalog(ENTRY, { contextWindow: 200000, maxTokens: 8192, reasoning: false }), null);
  assert.equal(rules.fromCatalog(null, NONE), null);
});

test('MD-16 §4.4 pi\'s max output is taken only when below the row\'s window (the server\'s, else pi\'s)', () => {
  const equal = { ...ENTRY, maxTokens: ENTRY.contextWindow };
  assert.equal(rules.fromCatalog(equal, NONE).maxTokens, null);
  assert.equal(rules.fromCatalog(ENTRY, { contextWindow: 65536, maxTokens: null, reasoning: null }).maxTokens, null);
  const model = rules.finalizeModel('x', rules.readRow({ id: 'x' }, CTX, {}, equal.contextWindow), flags(equal));
  assert.equal(model.maxTokens, 16384);
  assert.deepEqual(model.catalog, { provider: 'Z.AI', contextWindow: true, maxTokens: false, reasoning: true });
});

test('MD-16 §4.4 pi saying a model does not think takes nothing for thinking: it stays unticked as unreported', () => {
  const quiet = { ...ENTRY, reasoning: false };
  assert.equal(rules.fromCatalog(quiet, NONE).reasoning, false);
  assert.equal(rules.fromCatalog(quiet, { contextWindow: 200000, maxTokens: 8192, reasoning: null }), null);
  const model = rules.finalizeModel('x', rules.readRow({ id: 'x' }, CTX, {}, quiet.contextWindow), flags(quiet));
  assert.equal(model.reasoning, false);
  assert.equal(model.catalog.reasoning, false);
});

test('MD-16 §4.4 values from pi are not reported: catalog names the provider and the fields taken; image, family and '
  + 'chat are never taken', () => {
  const row = { id: 'glm-5.3', display_name: 'GLM-5.3', type: 'model' };
  const model = rules.finalizeModel(row.id, rules.readRow(row, CTX, {}, ENTRY.contextWindow), flags(ENTRY));
  assert.deepEqual([model.contextWindow, model.maxTokens, model.reasoning, model.image, model.family, model.chat],
    [1000000, 131072, true, false, '', null]);
  assert.deepEqual(model.reported,
    { contextWindow: false, maxTokens: false, reasoning: false, image: false, family: false });
  assert.deepEqual(model.catalog, { provider: 'Z.AI', contextWindow: true, maxTokens: true, reasoning: true });
  const plain = rules.finalizeModel(row.id, rules.readRow(row, CTX), flags(null));
  assert.deepEqual([plain.contextWindow, plain.maxTokens, plain.reasoning, plain.catalog],
    [128000, 16384, false, null]);
});

test('MD-16 §4.1 a row reporting only max output is compared with pi\'s window: then it counts as reported', () => {
  const row = { id: 'x', max_output_tokens: 200000 };
  assert.equal(rules.readRow(row, CTX).maxTokens, null);
  assert.equal(rules.readRow(row, CTX, {}, ENTRY.contextWindow).maxTokens, 200000);
  const model = rules.finalizeModel('x', rules.readRow(row, CTX, {}, ENTRY.contextWindow), flags(ENTRY));
  assert.deepEqual([model.contextWindow, model.maxTokens, model.reported.maxTokens], [1000000, 200000, true]);
  assert.deepEqual(model.catalog, { provider: 'Z.AI', contextWindow: true, maxTokens: false, reasoning: true });
});

test('MD-16 §4.4 Fetch models on the recorded z.ai list: the rows pi\'s Z.AI entries have take pi\'s window, max '
  + 'output and thinking (not reported, catalog names Z.AI); the other rows keep the defaults', async () => {
  const { result } = await discoverWith(table([[GLM.url, { status: GLM.status, body: GLM.body }]]),
    newRequest(ZAI));
  const listed = result.models.filter((model) => model.catalog !== null).map((model) => model.id);
  assert.deepEqual(listed, ZAI_IDS);
  const glm = modelOf(result, 'glm-5.3');
  assert.deepEqual([glm.contextWindow, glm.maxTokens, glm.reasoning, glm.image], [1000000, 131072, true, false]);
  assert.deepEqual(glm.reported,
    { contextWindow: false, maxTokens: false, reasoning: false, image: false, family: false });
  assert.deepEqual(glm.catalog, { provider: 'Z.AI', contextWindow: true, maxTokens: true, reasoning: true });
  assert.equal(modelOf(result, 'glm-4.7').contextWindow, 204800);
  for (const model of result.models.filter((item) => !ZAI_IDS.includes(item.id))) {
    assert.deepEqual([model.contextWindow, model.maxTokens, model.reasoning], [128000, 16384, false], model.id);
  }
});

test('MD-16 §4.4 the real OpenRouter list takes pi\'s OpenRouter max output only on rows whose max output it does '
  + 'not report; the DeepSeek list reports every value and takes nothing', async () => {
  const { result } = await discoverWith(table(SCENARIOS.openrouter.routes()), newRequest(SCENARIOS.openrouter.raw));
  const piRows = result.models.filter((model) => model.catalog !== null);
  assert.ok(piRows.length > 0);
  for (const model of piRows) {
    assert.deepEqual(model.catalog, { provider: 'OpenRouter', contextWindow: false, maxTokens: true,
      reasoning: false }, model.id);
    assert.equal(model.reported.maxTokens, false, model.id);
  }
  assert.ok(piRows.some((model) => model.id === 'openrouter/auto' && model.maxTokens === 4096));
  const deepseek = await discoverWith(table(SCENARIOS.deepseek.routes()), newRequest(SCENARIOS.deepseek.raw));
  assert.ok(deepseek.result.models.length > 0);
  assert.ok(deepseek.result.models.every((model) => model.catalog === null));
});

test('MD-16 §7.1 step 0 on z.ai still records only what the server reported (nothing): reported and meta stay null',
  async () => {
    const { discoverReader } = readerWith(table([routeOf('glm-models-1')]));
    const read = await discoverReader.single(providerRequest(ZAI, 'anthropic-messages'), 'glm-5.3',
      new AbortController().signal);
    assert.equal(read.reported, null);
    assert.deepEqual(read.meta, { maxTokens: null, reasoning: null, image: null });
  });

/** @brief 档案视图用的模型与提供商（synthetic）。 */
function zaiTarget(model = {}) {
  return { baseUrl: ZAI, api: 'anthropic-messages', compat: {},
    model: { id: 'glm-5.3', family: '', contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ['text'],
      ...model } };
}

/** @brief 一个完成了的档案（synthetic），第 0 步读到 meta 与窗口。 */
function zaiProfile(target, { reported = null, meta } = {}) {
  const step = (outcome) => ({ outcome, detail: null });
  const auto = { server: { kind: 'unknown', version: 'unknown' }, reported, field: 'native',
    steps: { ready: step('pass'), thinking: step('pass'), call: step('pass'), result: step('pass'),
      replay: step('not_applicable'), a: step('pass'), b: step('not_applicable'), c: step('not_run'),
      image: step('not_run') },
    ...(meta ? { meta } : {}) };
  return P.buildProfile({ target, auto, previous: undefined, now: 5000 });
}

test('MD-16 §7.2 the profile view\'s catalog has pi\'s values only for what step 0 did not read; none for an old '
  + 'profile (no meta), before any profile, or at an address pi does not know', () => {
  const target = zaiTarget();
  const none = { maxTokens: null, reasoning: null, image: null };
  assert.deepEqual(layerView(target, zaiProfile(target, { meta: none }), false).catalog,
    { provider: 'Z.AI', contextWindow: 1000000, maxTokens: 131072, reasoning: true });
  const partly = zaiProfile(target, { reported: 200000, meta: { maxTokens: 64000, reasoning: null, image: null } });
  assert.deepEqual(layerView(target, partly, false).catalog,
    { provider: 'Z.AI', contextWindow: null, maxTokens: null, reasoning: true });
  assert.equal(layerView(target, zaiProfile(target), false).catalog, null);
  assert.equal(layerView(target, undefined, true).catalog, null);
  const other = { ...target, baseUrl: 'https://llm.example.test/v1' };
  assert.equal(layerView(other, zaiProfile(other, { meta: none }), false).catalog, null);
});

test('MD-16 §7.2 values from pi\'s model list are not reported values: with a catalog window the effective window is '
  + 'still the smaller of the configured and server-reported windows, and context.reported stays the server\'s',
() => {
  const none = { maxTokens: null, reasoning: null, image: null };
  // 配置仍是默认值 128000，pi 的窗口 1,000,000：有效窗口不取 pi 的
  const target = zaiTarget();
  const view = layerView(target, zaiProfile(target, { meta: none }), false);
  assert.equal(view.catalog.contextWindow, 1000000);
  assert.deepEqual([view.context.declared, view.context.reported, view.context.effective], [128000, null, 128000]);
  // 服务报告了 200000：有效窗口是配置与报告中较小的，pi 的值不参与
  const big = zaiTarget({ contextWindow: 1000000 });
  const reported = layerView(big, zaiProfile(big, { reported: 200000, meta: none }), false);
  assert.equal(reported.catalog.contextWindow, null);
  assert.deepEqual([reported.context.declared, reported.context.reported, reported.context.effective],
    [1000000, 200000, 200000]);
});
