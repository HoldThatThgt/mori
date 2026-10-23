// 一次命令一次编译、一次写入（docs/specs/model-discovery.md §5.4）：models.saveProvider（新建）、models.addModels、
// models.firstRun 带几个模型时，模型层只编译一次（compiler.compile 一次；pi 的 registerProvider 只对改动的提供商一次、
// refresh 一次）、只写一次 model-config.json（一个临时文件改名一次），模型按清单顺序，加入的每个模型都开始探测
// （每次加入的模型里有一个已有档案、指纹相同，不会自动探测，只有命令把全部加入的模型放进 probeRefs 时它才探测）；
// addModels 整次拒绝时不编译、不写、models.get 里的配置不变。§13.2 的 MD-09（Add provider 的 Add）、MD-10（卡上的 Add）、
// MD-11（首次启动）。模型层是真的（modelLayer.ts），pi 的运行时、主进程、fetch 是替身（synthetic，见 commands-helpers.mjs）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  configWithP, form, layerScenario, listed, measured, profiledAt, providerP, runCommand,
} from './commands-helpers.mjs';

/** 清单里勾选的三个模型，按清单顺序（故意不按字母序） */
const TICKED = Object.freeze(['qwen3-32b', 'llama-3.3-70b', 'qwen3-8b']);

/** 表单里填的假 key（synthetic，不是任何服务的 key） */
const KEY = 'sk-md-once-synthetic-7731';

/** 提供商 p 已存的 key 的明文（synthetic） */
const P_SECRETS = Object.freeze({ 'p#1': 'sk-md-once-p-synthetic-0042' });

/**
 * @brief 一次编译、一次写入：compile 一次；registerProvider 只对 providerId 一次、注册的模型为 models；refresh 一次；
 *        写到 model-config.json 的只有一个临时文件，它被改名成 model-config.json。
 * @param run measured 的结果
 * @param providerId 改动的提供商
 * @param models 注册内容里这个提供商的模型 id，按顺序
 */
function assertOneCompileOneWrite(run, providerId, models) {
  assert.equal(run.compiles, 1, 'compiler.compile calls');
  assert.deepEqual(run.registers, [{ id: providerId, models: [...models] }], 'registerProvider calls');
  assert.deepEqual([run.unregisters, run.refreshes], [[], 1], 'unregisterProvider calls and refreshes');
  assert.equal(run.writes.length, 1, `writes of model-config.json: ${run.writes.join(', ')}`);
  assert.match(run.writes[0], /model-config\.json\.[0-9a-f-]+\.tmp$/);
  assert.deepEqual(run.renames, run.writes, 'the one temp file is renamed to model-config.json');
}

/** @brief 提供商 providerId 下这些模型的 ref，排好序（同 measured 的 running）。 */
function refsOf(providerId, ids) {
  return ids.map((id) => `${providerId}/${id}`).sort();
}

test('MD-09 one models.saveProvider (id null) with three ticked models compiles once and writes the config once',
  async (t) => {
    const lab = 'http://127.0.0.1:9/lab/v1';
    // 同一地址上 llama-3.3-70b 以前探测过（档案还在）：它也要开始探测
    const scenario = await layerScenario(t, { config: configWithP(), secrets: P_SECRETS,
      profiled: [profiledAt(lab, ['llama-3.3-70b'])] });
    const run = await measured(scenario, { type: 'models.saveProvider', id: null,
      provider: form('Lab server', lab), keySecret: KEY, models: TICKED.map(listed) });
    assert.deepEqual(run.result, { providerId: 'lab-server', error: null });
    // p 没有改动，不重新注册
    assertOneCompileOneWrite(run, 'lab-server', TICKED);
    const saved = scenario.readConfig();
    assert.deepEqual(saved.providers.map((provider) => provider.id), ['p', 'lab-server']);
    assert.deepEqual(saved.providers[1].models.map((model) => model.id), TICKED);
    assert.deepEqual(saved.providers[1].keys, [{ ref: 'lab-server#1', label: 'Key 1' }]);
    assert.deepEqual(scenario.main.stored, [{ ref: 'lab-server#1', key: KEY }], 'the new key is stored once');
    // 加入的三个模型都开始探测（含已有档案的 llama-3.3-70b）；p 的模型有档案、没加入，不再探测
    assert.deepEqual(run.running, refsOf('lab-server', TICKED));
  });

test('MD-10 one models.addModels with three models compiles once and writes the config once, after p\'s models',
  async (t) => {
    // p 的地址上 qwen3-8b 以前探测过（档案还在）：它也要开始探测
    const scenario = await layerScenario(t, { config: configWithP(), secrets: P_SECRETS,
      profiled: [profiledAt(providerP().baseUrl, ['qwen3-8b'])] });
    const run = await measured(scenario, { type: 'models.addModels', providerId: 'p', models: TICKED.map(listed) });
    assert.deepEqual(run.result, { error: null });
    assertOneCompileOneWrite(run, 'p', ['m1', 'm2', ...TICKED]);
    assert.deepEqual(scenario.readConfig().providers[0].models.map((model) => model.id), ['m1', 'm2', ...TICKED]);
    assert.deepEqual(scenario.main.stored, [], 'no key is stored or deleted');
    assert.deepEqual(run.running, refsOf('p', TICKED));
  });

test('MD-10 models.addModels with an id already in p, or twice in one call, compiles nothing and writes nothing',
  async (t) => {
    const scenario = await layerScenario(t, { config: configWithP(), secrets: P_SECRETS });
    const before = readFileSync(scenario.paths.config, 'utf8');
    for (const [ids, repeated] of [[['qwen3-8b', 'm2'], 'm2'], [['qwen3-8b', 'qwen3-8b'], 'qwen3-8b']]) {
      const run = await measured(scenario, { type: 'models.addModels', providerId: 'p', models: ids.map(listed) });
      const label = ids.join(', ');
      assert.deepEqual(run.result, { error: `${repeated} is already in P.` }, label);
      assert.deepEqual([run.compiles, run.registers, run.refreshes], [0, [], 0], `${label}: no compile`);
      assert.deepEqual([run.writes, run.renames], [[], []], `${label}: no write`);
      assert.deepEqual(run.running, [], `${label}: nothing starts probing`);
    }
    assert.equal(readFileSync(scenario.paths.config, 'utf8'), before);
    // 后台进程里的配置同样不变：models.get 里 p 仍只有 m1、m2
    const info = await runCommand({ type: 'models.get' });
    assert.equal(info.error, null);
    assert.deepEqual(info.config.providers.map((item) => [item.id, item.models.map((model) => model.id)]),
      [['p', ['m1', 'm2']]], 'models.get after the rejected adds');
  });

test('MD-11 one models.firstRun with three ticked models compiles once and writes once; saving again does the same',
  async (t) => {
    // 同一地址上 qwen3-32b 以前探测过（档案还在，配置文件没有）：它也要开始探测
    const scenario = await layerScenario(t, { profiled: [profiledAt('http://127.0.0.1:9/v1', ['qwen3-32b'])] });
    const provider = form('Mori endpoint', 'http://127.0.0.1:9/v1');
    const first = await measured(scenario, { type: 'models.firstRun', providerId: null, provider,
      models: TICKED.map(listed), keySecret: KEY });
    assert.deepEqual(first.result, { providerId: 'mori-endpoint', error: null });
    assertOneCompileOneWrite(first, 'mori-endpoint', TICKED);
    const created = scenario.readConfig();
    assert.deepEqual([created.providers.map((item) => item.id), created.providers[0].models.map((model) => model.id),
      created.normalDefault], [['mori-endpoint'], TICKED, 'mori-endpoint']);
    assert.deepEqual(scenario.main.stored, [{ ref: 'mori-endpoint#1', key: KEY }], 'the key is stored once');
    assert.deepEqual(first.running, refsOf('mori-endpoint', TICKED));
    // 同一张表单再次保存（key 框空着）：整体替换这个提供商的模型，仍是一次编译、一次写入
    const again = ['qwen3-8b', 'qwen3-14b'];
    const second = await measured(scenario, { type: 'models.firstRun', providerId: 'mori-endpoint', provider,
      models: again.map(listed), keySecret: null });
    assert.deepEqual(second.result, { providerId: 'mori-endpoint', error: null });
    assertOneCompileOneWrite(second, 'mori-endpoint', again);
    const replaced = scenario.readConfig();
    assert.deepEqual([replaced.providers.map((item) => item.id), replaced.providers[0].models.map((model) => model.id),
      replaced.normalDefault, replaced.providers[0].keys],
    [['mori-endpoint'], again, 'mori-endpoint', [{ ref: 'mori-endpoint#1', label: 'Key 1' }]]);
    assert.equal(scenario.main.stored.length, 1, 'saving again stores and deletes no key');
    assert.deepEqual(second.running, refsOf('mori-endpoint', again));
  });
