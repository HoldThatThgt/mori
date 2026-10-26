// 档案的单元测试（docs/specs/model-discovery.md §7.2；§13.2 MD-12 单元层）：auto.meta 的读写、没有 meta 的旧档案照样读、
// 不重新探测（PROBE_SUITE 不变）、server.kind 为 §3.3 的全部种类、ProfileView.reported（探测中、旧档案、新档案）。
// 档案都是 synthetic（按 kernel/modelProfiles.ts 的形状手写）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  captureConsole, configOf, configProvider, empty, json, scratchLayer, stubGlobalFetch,
} from './io-helpers.mjs';

const P = await loadKernelModule('src/kernel/modelProfiles.ts');
const { SERVER_KINDS } = await loadKernelModule('src/shared/models.ts');
const { ModelLayer } = await loadKernelModule('src/kernel/modelLayer.ts');
const { reservedIds } = await loadKernelModule('src/kernel/modelConfig.ts');

const pass = { outcome: 'pass', detail: null };
const na = { outcome: 'not_applicable', detail: null };
const notRun = { outcome: 'not_run', detail: null };
const META = Object.freeze({ maxTokens: 8192, reasoning: true, image: false });

/** 配置里的一个模型及其提供商字段（synthetic）。 */
function target(model = {}) {
  return { baseUrl: 'http://127.0.0.1:4319/v1', api: 'openai-completions', compat: {},
    model: { id: 'fake-coder', family: '', contextWindow: 131072, maxTokens: 16384, reasoning: false,
      input: ['text'], ...model } };
}

/** 全部通过的第 0–7 步结果（synthetic）；meta 为 undefined 时是 2026-10-23 以前的旧档案。 */
function auto({ meta, kind = 'vllm', version = '0.10.1', reported = 65536 } = {}) {
  const value = { server: { kind, version }, reported, field: 'none',
    steps: { ready: pass, thinking: na, call: pass, result: pass, replay: na, a: pass, b: pass, c: notRun } };
  return meta === undefined ? value : { ...value, meta };
}

/** @brief 一个档案。 */
function stored(results = auto({ meta: META }), t = target()) {
  return P.buildProfile({ target: t, auto: results, now: 5000 });
}

/** 临时目录里的档案文件路径。 */
function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'mori-discovery-profiles-')), 'model-profiles.json');
}

test('MD-12 the profile store round trip keeps auto.meta', async () => {
  const path = tempPath();
  const profile = stored();
  await P.writeProfiles(path, [profile]);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(written.profiles[0].auto.meta, META);
  const [back] = await P.readProfiles(path);
  assert.deepEqual(back, profile);
  assert.deepEqual(back.auto.meta, META);
  // 明确报告“没有”的 false 与没报告的 null 都原样留着
  const mixed = stored(auto({ meta: { maxTokens: null, reasoning: false, image: null } }));
  await P.writeProfiles(path, [mixed]);
  assert.deepEqual((await P.readProfiles(path))[0].auto.meta, { maxTokens: null, reasoning: false, image: null });
});

test('MD-12 an old profile without meta loads, is not probed again and has reported null', async () => {
  const path = tempPath();
  const old = stored(auto());
  assert.equal('meta' in old.auto, false);
  writeFileSync(path, JSON.stringify({ version: 1, profiles: [old] }));
  const [back] = await P.readProfiles(path);
  assert.deepEqual(back, old);
  assert.equal(back.suite, P.PROBE_SUITE, 'PROBE_SUITE is unchanged');
  assert.equal(P.needsProbe(target(), back), false, 'no probe again because meta is missing');
  const view = P.profileView(target(), back, false);
  assert.equal(view.reported, null);
  assert.equal(view.context.reported, 65536, 'the window still comes from auto.reported');
  // ProfileBook 读同一个文件：同样不探测、reported 为 null
  const book = new P.ProfileBook({ path, resolve: (ref) => (ref === 'local/fake-coder' ? target() : null) });
  await book.load();
  assert.equal(book.views(['local/fake-coder'])['local/fake-coder'].reported, null);
});

test('MD-12 the model layer starts with an old profile without meta: not probed again, only the version is read',
  async (t) => {
    const lines = captureConsole(t);
    // 合成服务（synthetic）：vLLM 0.10.1，与旧档案同一种类、同一版本，所以读版本也不重新探测（§7.3）
    const stub = stubGlobalFetch(t, (call) => {
      if (call.path === '/v1/models') {
        return json({ object: 'list', data: [{ id: 'fake-coder', object: 'model', owned_by: 'vllm',
          max_model_len: 65536 }] });
      }
      return call.path === '/version' ? json({ version: '0.10.1' }) : empty(404);
    });
    const old = stored(auto());
    assert.equal('meta' in old.auto, false);
    const config = configOf([configProvider('local', target().baseUrl, ['fake-coder'])]);
    const { layer, runtime } = scratchLayer(ModelLayer, reservedIds(['openai']), { config, profiles: [old] });
    await layer.load({}, [], null);
    assert.equal(layer.needsAutoProbe('local/fake-coder'), false, 'a missing meta does not ask for a probe');
    await layer.startupProbes(false);
    assert.deepEqual(layer.getProfiles().running(), []);
    assert.deepEqual(runtime.streamed, [], 'no probe request was sent');
    assert.deepEqual(stub.calls.map((call) => call.path), ['/v1/models', '/version'], 'only the version read');
    assert.deepEqual(layer.getProfiles().lookupRef('local/fake-coder'), old, 'the old profile is kept as it was');
    const view = layer.getProfiles().views(['local/fake-coder'])['local/fake-coder'];
    assert.equal(view.reported, null);
    assert.equal(view.context.reported, 65536);
    assert.ok(!lines.some((line) => line.includes('probing again')), lines.join('\n'));
  });

test('MD-12 server.kind accepts every §3.3 kind; an unknown kind or a bad meta drops only that entry',
  async (t) => {
    const lines = captureConsole(t);
    const path = tempPath();
    // 期望值照抄规格 §3.3 的表（第 1–7 步右栏的种类），不取产品自己的 SERVER_KINDS：少一种、多一种都要失败
    const spec = ['newapi', 'deepseek', 'moonshot', 'dashscope', 'qianfan', 'openrouter', 'anthropic', 'vllm', 'sglang',
      'llamacpp', 'lmdeploy', 'xinference', 'tensorrt', 'mindie', 'gpustack', 'litellm', 'oneapi', 'localai', 'ollama',
      'lmstudio', 'tgi', 'unknown'];
    assert.deepEqual([...SERVER_KINDS].sort(), [...spec].sort());
    const all = spec.map((kind, index) => stored(auto({ kind, meta: META }), target({ id: `m${index}` })));
    await P.writeProfiles(path, all);
    assert.deepEqual((await P.readProfiles(path)).map((item) => item.auto.server.kind), spec);
    // 模型层原来的五种（旧档案里的值，没有 meta）照样读出（§7.2“旧值都在其中”）
    const olds = ['vllm', 'sglang', 'ollama', 'llamacpp', 'unknown'].map((kind, index) => stored(auto({ kind }),
      target({ id: `old${index}` })));
    writeFileSync(path, JSON.stringify({ version: 1, profiles: olds }));
    assert.deepEqual(await P.readProfiles(path), olds);
    const good = stored();
    const badKind = { ...stored(auto({ meta: META }), target({ id: 'x' })) };
    badKind.auto = { ...badKind.auto, server: { kind: 'made-up', version: '1' } };
    const badMeta = { ...stored(auto({ meta: META }), target({ id: 'y' })) };
    badMeta.auto = { ...badMeta.auto, meta: { maxTokens: 0, reasoning: true, image: false } };
    const noField = { ...stored(auto({ meta: META }), target({ id: 'z' })) };
    noField.auto = { ...noField.auto, meta: { maxTokens: null, reasoning: null } };
    writeFileSync(path, JSON.stringify({ version: 1, profiles: [badKind, good, badMeta, noField] }));
    assert.deepEqual(await P.readProfiles(path), [good]);
    const skipped = lines.filter((line) => line.includes('skipping invalid profile'));
    assert.deepEqual(skipped.map((line) => /profile (\d+):/.exec(line)?.[1]), ['0', '2', '3'], lines.join('\n'));
  });

test('MD-12 ProfileView.reported: null while a new model is probing, the stored values for a new profile',
  async () => {
    assert.equal(P.profileView(target(), undefined, true).reported, null, 'probing without a profile');
    const fresh = P.profileView(target(), stored(), false);
    assert.deepEqual(fresh.reported, { contextWindow: 65536, maxTokens: 8192, reasoning: true, image: false });
    const nothing = stored(auto({ reported: null, meta: { maxTokens: null, reasoning: null, image: null } }));
    assert.deepEqual(P.profileView(target(), nothing, false).reported,
      { contextWindow: null, maxTokens: null, reasoning: null, image: null }, 'a new profile with nothing reported');
    // 重新验证期间按旧结果显示（模型层规格 §7.4）：reported 也是档案里的
    assert.deepEqual(P.profileView(target(), stored(), true).reported, fresh.reported);
    assert.equal(P.profileView(target(), stored(auto()), true).reported, null, 'an old profile while re-verifying');
    assert.deepEqual(P.reportedOf(auto({ meta: META })), fresh.reported);
    assert.equal(P.reportedOf(auto()), null);
  });

test('MD-12 the ProfileBook views give reported per ref and keep meta through save and reload', async () => {
  const path = tempPath();
  const targets = { 'local/fake-coder': target(), 'local/old': target({ id: 'old' }),
    'local/new': target({ id: 'new' }) };
  const book = new P.ProfileBook({ path, resolve: (ref) => targets[ref] ?? null });
  await book.load();
  await book.save(stored());
  await book.save(stored(auto(), targets['local/old']));
  book.setRunning('local/new', 0, 8);
  const again = new P.ProfileBook({ path, resolve: (ref) => targets[ref] ?? null });
  await again.load();
  again.setRunning('local/new', 0, 8);
  const views = again.views(Object.keys(targets));
  assert.deepEqual(views['local/fake-coder'].reported, { contextWindow: 65536, maxTokens: 8192, reasoning: true,
    image: false });
  assert.equal(views['local/old'].reported, null);
  assert.equal(views['local/new'].status, 'probing');
  assert.equal(views['local/new'].reported, null);
});
