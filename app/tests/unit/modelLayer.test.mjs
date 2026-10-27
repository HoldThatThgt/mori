// kernel/modelLayer.ts 的单元测试：保存改地址时 key 先撤下（§4.1）、项目配置无效时不放宽（§4.3）、
// credentials.json 读不出时不迁移（§4.5）、启动时对没有档案的模型自动探测（§7.4）。pi 的运行时是替身（synthetic），文件写在临时目录，key 都是测试用的假值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from './load.mjs';

const { ModelLayer } = await loadKernelModule('src/kernel/modelLayer.ts');
const mc = await loadKernelModule('src/kernel/modelConfig.ts');
const mp = await loadKernelModule('src/kernel/modelProfiles.ts');
const RESERVED = mc.reservedIds(['openai']);

/** §4.1 形状的提供商 p（synthetic），带一个 key p#1。 */
function provider(overrides = {}) {
  return {
    id: 'p', name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000/p', zone: 'local', compat: {},
    concurrency: 4, keys: [{ ref: 'p#1', label: 'Key 1' }], nextKeyNumber: 2,
    models: [
      { id: 'm1', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] },
      { id: 'm2', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] },
    ],
    ...overrides,
  };
}

/** 只有提供商 p 的配置。 */
function configWith(p = provider()) {
  return { version: 1, providers: [p], groups: [], normalDefault: 'p/m1', allowedZones: ['local', 'intranet'],
    projectZones: {} };
}

/** pi 运行时的替身：记下注册的提供商；hooks.refresh 在每次刷新时调用。 */
function fakeRuntime(hooks) {
  return {
    registered: new Map(),
    registerProvider(id, input) { this.registered.set(id, input); },
    unregisterProvider(id) { this.registered.delete(id); },
    async refresh() { await hooks.refresh?.(this); },
    getModel() { return undefined; },
    getProviders() { return []; },
  };
}

/** 一个临时 userData（可带 model-config.json、model-profiles.json 与 v0 的 models.json）上的模型层。 */
function scratchLayer({ config = null, v0Models = null, profiles = null, emit = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-layer-'));
  const paths = { config: join(dir, 'model-config.json'), profiles: join(dir, 'model-profiles.json'),
    notice: join(dir, 'model-migration.json'), v0Models: join(dir, 'agent', 'models.json') };
  if (config) writeFileSync(paths.config, JSON.stringify(config));
  if (profiles) writeFileSync(paths.profiles, JSON.stringify({ version: 1, profiles }));
  if (v0Models) {
    mkdirSync(join(dir, 'agent'));
    writeFileSync(paths.v0Models, JSON.stringify(v0Models));
  }
  const hooks = {};
  const runtime = fakeRuntime(hooks);
  const layer = new ModelLayer(runtime, RESERVED, paths, emit);
  return { dir, paths, hooks, runtime, layer };
}

/** 模型池里只用 key p#1 发一次请求；返回响应文字或错误原文。 */
function sendWithKey(layer, url) {
  const fetch = layer.getPool().createFetch({ ref: 'p/m1', api: 'openai-completions', sessionKey: 'test',
    cls: 'conversation', keyRef: 'p#1', serverRetries: false });
  return fetch(url, { method: 'POST', body: '{}' }).then((response) => response.text(), (error) => error.message);
}

/** 把全局 fetch 换成替身，记下每次请求的地址与认证头。 */
function stubGlobalFetch(t) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return new Response('ok');
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/** 静默 console.error（删除密文时没有主进程，会记一条错误）。 */
function quiet(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
}

test('MP-24 an origin change withdraws the old key from the pool before pi sees the new address', async (t) => {
  quiet(t);
  const calls = stubGlobalFetch(t);
  const config = configWith();
  const { layer, hooks } = scratchLayer({ config });
  await layer.load({ 'p#1': 'sk-old-SECRET' }, ['p#1'], null);
  const during = [];
  hooks.refresh = async (runtime) => {
    if (runtime.registered.get('p')?.baseUrl !== 'http://127.0.0.1:9100/p') return;
    during.push(await sendWithKey(layer, 'http://127.0.0.1:9100/p/chat/completions'));
  };
  const next = configWith(provider({ baseUrl: 'http://127.0.0.1:9100/p', keys: [] }));
  await layer.edit(() => layer.save(next, { previous: config, removedKeyRefs: ['p#1'] }));
  assert.equal(during.length, 1);
  assert.match(during[0], /Key p#1 is not saved/);
  assert.ok(calls.every((call) => !String(call.auth).includes('sk-old')), JSON.stringify(calls));
});

test('MP-24 a save that pi rejects puts the withdrawn key back', async (t) => {
  quiet(t);
  const calls = stubGlobalFetch(t);
  const config = configWith();
  const { layer, hooks } = scratchLayer({ config });
  await layer.load({ 'p#1': 'sk-old-SECRET' }, ['p#1'], null);
  hooks.refresh = async (runtime) => {
    if (runtime.registered.get('p')?.baseUrl === 'http://127.0.0.1:9100/p') throw new Error('pi refused');
  };
  const next = configWith(provider({ baseUrl: 'http://127.0.0.1:9100/p', keys: [] }));
  await assert.rejects(layer.edit(() => layer.save(next, { previous: config, removedKeyRefs: ['p#1'] })),
    /pi refused/);
  assert.equal(await sendWithKey(layer, 'http://127.0.0.1:9000/p/chat/completions'), 'ok');
  assert.deepEqual(calls.map((call) => [call.url, call.auth]),
    [['http://127.0.0.1:9000/p/chat/completions', 'Bearer sk-old-SECRET']]);
});

test('MP-07 an invalid .mori/models.json allows no zone and expands to no candidate', async (t) => {
  quiet(t);
  const { layer } = scratchLayer({ config: configWith() });
  await layer.load({ 'p#1': 'sk-x' }, ['p#1'], null);
  const project = mkdtempSync(join(tmpdir(), 'mori-project-'));
  const valid = await layer.projectContext(project);
  assert.deepEqual(valid.allowedZones, ['local', 'intranet']);
  assert.deepEqual(layer.expandPickIn(valid, 'p'), ['p/m1', 'p/m2']);
  mkdirSync(join(project, '.mori'));
  writeFileSync(join(project, '.mori', 'models.json'), '{ "allowedZones": ');
  const invalid = await layer.projectContext(project);
  assert.notEqual(invalid.projectError, null);
  assert.deepEqual(invalid.allowedZones, []);
  assert.deepEqual(layer.expandPickIn(invalid, 'p'), []);
  assert.equal(layer.staticBase(invalid).projectError, invalid.projectError);
});

test('MP-08 when the saved keys cannot be read, migration waits and no config is written', async (t) => {
  quiet(t);
  const v0Models = { providers: { e: { name: 'E', baseUrl: 'http://127.0.0.1:8000/v1', api: 'openai-completions',
    models: [{ id: 'm' }] } } };
  const { layer, paths } = scratchLayer({ v0Models });
  assert.equal(await layer.load({}, [], 'safeStorage is not available'), false);
  assert.equal(layer.migrationError(), 'Cannot read saved keys: safeStorage is not available');
  assert.equal(layer.getConfig(), null);
  assert.equal(layer.isFirstRun(), true);
  assert.equal(existsSync(paths.config), false);
});

/** 提供商 p 里模型 modelId 的档案目标（§7.1）。 */
function targetIn(p, modelId) {
  return { baseUrl: p.baseUrl, api: p.api, model: p.models.find((model) => model.id === modelId), compat: p.compat };
}

/** 一份全部通过的已存档案（synthetic），指纹与当前配置一致。 */
function storedProfile(target) {
  const pass = { outcome: 'pass', detail: null };
  const auto = { server: { kind: 'unknown', version: 'unknown' }, reported: null, field: 'none',
    steps: { ready: pass, thinking: { outcome: 'not_applicable', detail: null }, call: pass, result: pass,
      replay: { outcome: 'not_applicable', detail: null }, a: pass, b: pass,
      c: { outcome: 'not_run', detail: null } } };
  return mp.buildProfile({ target, auto, previous: undefined, now: 5 });
}

/** 给运行时补上 getModel 与 streamSimple（synthetic）：每次请求记下模型 id，立即以连接错误结束。 */
function failingStreams(runtime) {
  const sent = [];
  runtime.getModel = (providerId, modelId) => ({ id: modelId, name: modelId, api: 'openai-completions',
    provider: providerId, baseUrl: 'http://127.0.0.1:9000/p', reasoning: false, input: ['text'],
    contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  runtime.streamSimple = (model) => {
    sent.push(model.id);
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'error', errorMessage: 'Connection error.', timestamp: 1 };
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'error', error: message }; },
      result: async () => message,
    };
  };
  return sent;
}

test('MP-10 at kernel start a model without a profile gets the automatic probes (steps 0-7, background)',
  async (t) => {
    quiet(t);
    stubGlobalFetch(t);
    const p = provider();
    const kept = storedProfile(targetIn(p, 'm1'));
    const events = [];
    const { layer, runtime } = scratchLayer({ config: configWith(p), profiles: [kept],
      emit: (event) => events.push(event) });
    const sent = failingStreams(runtime);
    await layer.load({ 'p#1': 'sk-x' }, ['p#1'], null);
    const pool = layer.getPool();
    const createFetch = pool.createFetch.bind(pool);
    const classes = [];
    pool.createFetch = (options) => {
      classes.push(options.cls);
      return createFetch(options);
    };
    const done = new Promise((resolve) => {
      layer.onModelsChanged((change) => {
        if (change.kind === 'profiles' && !layer.getProfiles().isRunning('p/m2')
          && layer.getProfiles().lookupRef('p/m2')) resolve();
      });
    });
    await layer.startupProbes(false);
    const started = events.some((event) => event.type === 'mori.profiles'
      && event.running.some((item) => item.ref === 'p/m2'));
    assert.ok(started, 'the probes for p/m2 start at kernel start');
    await done;
    const running = events.filter((event) => event.type === 'mori.profiles').flatMap((event) => event.running);
    assert.ok(running.every((item) => item.ref === 'p/m2'), JSON.stringify(running));
    assert.deepEqual(running[0], { ref: 'p/m2', step: 0, of: 8 });
    assert.ok(running.some((item) => item.step === 7), 'the set reaches step 7');
    assert.ok(sent.length > 0 && sent.every((id) => id === 'm2'), JSON.stringify(sent));
    assert.ok(classes.length > 0 && classes.every((cls) => cls === 'background'), JSON.stringify(classes));
    const probed = layer.getProfiles().lookupRef('p/m2');
    assert.deepEqual(probed.auto.steps.ready, { outcome: 'error', detail: 'Connection error.' });
    assert.equal(layer.toolCallingOf('p/m2'), 'unverified');
    assert.deepEqual(layer.getProfiles().lookupRef('p/m1'), kept, 'the model with a profile is not probed again');
  });

// ---- 文件系统 §11.7：Mori worktree 里的会话按主文件夹算（file-system.md §19.4、FS-102） ----

/** @brief 主文件夹 main 里名为 name 的 Mori worktree 的工作路径（file-system.md §11.2 的位置），可带子文件夹。 */
const treeOf = (main, name = 'fix-login-3fa9c1', ...sub) => join(main, '.mori', 'worktrees', name, ...sub);

/**
 * @brief 主文件夹 tool：.mori/models.json 只允许 local、public，本机为它授权 public（projectZones）；它的 worktree 里
 *        有一份坏的 .mori/models.json（不该读到）。临时目录在测试结束时删掉。
 */
async function worktreeProject(t) {
  quiet(t);
  const root = mkdtempSync(join(tmpdir(), 'mori-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const main = join(root, 'tool');
  mkdirSync(join(main, '.mori'), { recursive: true });
  writeFileSync(join(main, '.mori', 'models.json'), JSON.stringify({ allowedZones: ['local', 'public'] }));
  mkdirSync(join(treeOf(main), '.mori'), { recursive: true });
  writeFileSync(join(treeOf(main), '.mori', 'models.json'), '{ "allowedZones": ');
  const config = { ...configWith(), projectZones: { [mc.normalizeProjectPath(main)]: ['public'] } };
  const { dir, layer } = scratchLayer({ config });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  await layer.load({ 'p#1': 'sk-x' }, ['p#1'], null);
  return { root, main, layer };
}

/** @brief 一个 pi 会话文件（synthetic）：头与一条你的消息，pi 的 listAll 能列出它。 */
function writePiSession(agentDir, id, cwd) {
  const dir = join(agentDir, 'sessions', `--synthetic-${id}--`);
  mkdirSync(dir, { recursive: true });
  const at = '2026-10-22T09:00:00.000Z';
  const lines = [{ type: 'session', version: 3, id, timestamp: at, cwd },
    { type: 'message', id: `${id}u`, parentId: null, timestamp: at,
      message: { role: 'user', content: [{ type: 'text', text: 'Hello (synthetic)' }], timestamp: Date.parse(at) } }];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

/** @brief 把 pi 的会话目录指到 agentDir；测试结束时还原环境变量。 */
function piAgentDir(t, agentDir) {
  const names = ['PI_OFFLINE', 'PI_TELEMETRY', 'PI_CODING_AGENT_DIR'];
  const saved = names.map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: agentDir });
}

test('MP-07 FS-102 projectContext of a worktree session reads the main folder’s .mori/models.json and zones',
  async (t) => {
    const { main, layer } = await worktreeProject(t);
    const own = await layer.projectContext(main);
    assert.deepEqual(own, { path: mc.normalizeProjectPath(main), project: { allowedZones: ['local', 'public'] },
      projectError: null, allowedZones: ['local', 'public'], projectZones: ['local', 'public'] });
    assert.deepEqual(await layer.projectContext(treeOf(main)), own, 'the worktree’s own broken copy is not read');
    assert.deepEqual(await layer.projectContext(treeOf(main, 'add-search-0b12ef')), own,
      'a worktree folder that has no .mori/models.json');
    const sub = await layer.projectContext(treeOf(main, 'fix-login-3fa9c1', 'app'));
    assert.deepEqual([sub.path, sub.project, sub.allowedZones], [mc.normalizeProjectPath(join(main, 'app')), null,
      ['local', 'intranet']], 'a worktree of a subfolder is that subfolder');
  });

test('MP-06 FS-102 registerProject and Project access use the main folder; worktree sessions add no row',
  async (t) => {
    const { root, main, layer } = await worktreeProject(t);
    const agentDir = join(root, 'pi');
    mkdirSync(agentDir);
    piAgentDir(t, agentDir);
    layer.registerProject(treeOf(main));
    writePiSession(agentDir, 'tree', treeOf(main, 'add-search-0b12ef'));
    writePiSession(agentDir, 'claude', join(main, '.claude', 'worktrees', 'x'));
    const rows = (await layer.projectAccess()).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(rows, [
      { path: mc.normalizeProjectPath(main), zones: ['public'], projectZones: ['local', 'public'],
        projectConfig: null },
      { path: mc.normalizeProjectPath(join(main, '.claude', 'worktrees', 'x')), zones: [], projectZones: null,
        projectConfig: null },
    ], 'only the main folder for its worktrees; other folders as before');
  });
