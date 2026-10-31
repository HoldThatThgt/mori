// kernel/modelLayer.ts 的单元测试：保存改地址时 key 先撤下（§4.1）、项目配置无效时没有候选（§4.3）、
// credentials.json 读不出时不迁移（§4.5）、启动时对没有档案的模型自动探测（§7.4）。pi 的运行时是替身（synthetic），文件写在临时目录，key 都是测试用的假值。
// 2026-10-31（§7.8）：两段各自保存、后台一段进行中模型已能选、启动时只补后台一段、出错自动重试、图片探针通过时写进配置、
// 按模型学的首个内容时限（MP-42–MP-45 的模型层部分）。模型池用经全局 fetch 的替身（模型池默认用 undici 的 fetch）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    id: 'p', name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000/p', compat: {},
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
  return { version: 1, providers: [p], groups: [], normalDefault: 'p/m1' };
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
  const layer = new ModelLayer(runtime, RESERVED, paths, emit, (input, init) => globalThis.fetch(input, init));
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

test('MP-07 an invalid .mori/models.json expands to no candidate; the context has no zone fields', async (t) => {
  quiet(t);
  const { layer } = scratchLayer({ config: configWith() });
  await layer.load({ 'p#1': 'sk-x' }, ['p#1'], null);
  const project = mkdtempSync(join(tmpdir(), 'mori-project-'));
  const valid = await layer.projectContext(project);
  assert.deepEqual(valid, { project: null, projectError: null });
  assert.deepEqual(layer.expandPickIn(valid, 'p'), ['p/m1', 'p/m2']);
  mkdirSync(join(project, '.mori'));
  writeFileSync(join(project, '.mori', 'models.json'), '{ "groups": ');
  const invalid = await layer.projectContext(project);
  assert.notEqual(invalid.projectError, null);
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

/** 一份全部通过的已存档案（synthetic），指纹与当前配置一致；overrides 改 auto，steps 改各步。 */
function storedProfile(target, overrides = {}, steps = {}) {
  const pass = { outcome: 'pass', detail: null };
  const auto = { server: { kind: 'unknown', version: 'unknown' }, reported: null, field: 'none',
    steps: { ready: pass, thinking: { outcome: 'not_applicable', detail: null }, call: pass, result: pass,
      replay: { outcome: 'not_applicable', detail: null }, a: pass, b: pass,
      c: { outcome: 'not_run', detail: null }, image: { outcome: 'fail', detail: 'synthetic' }, ...steps },
    ...overrides };
  return mp.buildProfile({ target, auto, now: 5 });
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

test('MP-10 at kernel start a model without a profile gets the automatic probes (two phases, background)',
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
    assert.deepEqual(running[0], { ref: 'p/m2', step: 1, of: 4 });
    assert.ok(running.every((item) => item.step === 1), 'E1 fails to connect: no round 2, no background (§7.8)');
    assert.ok(sent.length > 0 && sent.every((id) => id === 'm2'), JSON.stringify(sent));
    assert.ok(classes.length > 0 && classes.every((cls) => cls === 'background'), JSON.stringify(classes));
    const probed = layer.getProfiles().lookupRef('p/m2');
    assert.deepEqual(probed.auto.steps.ready, { outcome: 'error', detail: 'Connection error.' });
    assert.equal(layer.toolCallingOf('p/m2'), 'unverified');
    assert.deepEqual(layer.getProfiles().lookupRef('p/m1'), kept, 'the model with a profile is not probed again');
  });

// ---- 文件系统 §11.7：Mori worktree 里的会话按主文件夹算（file-system.md §19.4、FS-102；2026-10-26 起没有网络区域与
// Project access，只查项目配置） ----

/** @brief 主文件夹 main 里名为 name 的 Mori worktree 的工作路径（file-system.md §11.2 的位置），可带子文件夹。 */
const treeOf = (main, name = 'fix-login-3fa9c1', ...sub) => join(main, '.mori', 'worktrees', name, ...sub);

/**
 * @brief 主文件夹 tool：.mori/models.json 写一个项目分组；它的 worktree 里有一份坏的 .mori/models.json（不该读到）。
 *        临时目录在测试结束时删掉。
 */
async function worktreeProject(t) {
  quiet(t);
  const root = mkdtempSync(join(tmpdir(), 'mori-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const main = join(root, 'tool');
  mkdirSync(join(main, '.mori'), { recursive: true });
  writeFileSync(join(main, '.mori', 'models.json'), JSON.stringify({ groups: { team: ['p/m1'] } }));
  mkdirSync(join(treeOf(main), '.mori'), { recursive: true });
  writeFileSync(join(treeOf(main), '.mori', 'models.json'), '{ "groups": ');
  const config = { ...configWith(), groups: [{ id: 'team', members: ['p'] }] };
  const { dir, layer } = scratchLayer({ config });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  await layer.load({ 'p#1': 'sk-x' }, ['p#1'], null);
  return { root, main, layer };
}

test('MP-07 FS-102 projectContext of a worktree session reads the main folder’s .mori/models.json',
  async (t) => {
    const { main, layer } = await worktreeProject(t);
    const own = await layer.projectContext(main);
    assert.deepEqual(own, { project: { groups: { team: ['p/m1'] } }, projectError: null });
    assert.deepEqual(await layer.projectContext(treeOf(main)), own, 'the worktree’s own broken copy is not read');
    assert.deepEqual(await layer.projectContext(treeOf(main, 'add-search-0b12ef')), own,
      'a worktree folder that has no .mori/models.json');
    const sub = await layer.projectContext(treeOf(main, 'fix-login-3fa9c1', 'app'));
    assert.deepEqual(sub, { project: null, projectError: null }, 'a worktree of a subfolder is that subfolder');
  });

// ---- 两段探针（§7.8，2026-10-31）：模型层的保存、重试、图片与首个内容时限 ----

const sel = await loadKernelModule('src/kernel/selector.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');
const { PROBE_PROMPTS: PP } = await loadKernelModule('src/kernel/probes.ts');

/** 后台一段的提示（B1、B2、B3、B4）。 */
const BACKGROUND = [PP.outcome, PP.json, PP.image, PP.tagged];

/** 一条请求的最后一条用户消息的文字（图片探针取文字部分）。 */
function promptOf(context) {
  const last = [...context.messages].reverse().find((message) => message.role === 'user');
  if (typeof last?.content === 'string') return last.content;
  return (last?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
}

/** 全部通过的回答（synthetic，同合成端点）；image 为图片探针的回答。 */
function passing(prompt, image = 'Red.') {
  if (prompt === PP.weather) {
    return { toolCalls: [{ type: 'toolCall', id: 'c1', name: 'get_weather', arguments: { city: 'Paris', days: 3 } }] };
  }
  if (prompt === PP.temperature) return { text: '21°C' };
  if (prompt === PP.outcome) {
    return { toolCalls: [{ type: 'toolCall', id: 'c2', name: 'submit_outcome', arguments: { outcome: 'ok' } }] };
  }
  if (prompt === PP.json) return { text: '{"outcome":"ok"}' };
  if (prompt === PP.image) return { text: image };
  return { text: '<summary>Yes.</summary><outcome>ok</outcome>' };
}

/** 一条助手消息（synthetic）。 */
function replyMessage(model, reply) {
  const content = [...(reply.text ? [{ type: 'text', text: reply.text }] : []), ...(reply.toolCalls ?? [])];
  return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: reply.error ? 'error' : reply.toolCalls ? 'toolUse' : 'stop', errorMessage: reply.error,
    timestamp: 1 };
}

/**
 * 给运行时补上 getModel 与按提示回答的 streamSimple（synthetic）：answer({ prompt, model, n }) 给出
 * { text?, toolCalls?, error?, gate? }（gate 是要等的 promise）；记下每次请求的模型 id 与提示。
 */
function answeringStreams(runtime, answer) {
  const sent = [];
  failingStreams(runtime);
  runtime.streamSimple = (model, context) => {
    const prompt = promptOf(context);
    sent.push({ id: model.id, prompt });
    const reply = answer({ prompt, model, n: sent.length });
    const message = replyMessage(model, reply);
    return {
      async *[Symbol.asyncIterator]() {
        if (reply.gate) await reply.gate;
        if (reply.error) {
          yield { type: 'error', reason: 'error', error: message };
          return;
        }
        yield { type: 'start', partial: message };
        if (reply.text) yield { type: 'text_delta', contentIndex: 0, delta: reply.text, partial: message };
        for (const call of reply.toolCalls ?? []) {
          yield { type: 'toolcall_start', contentIndex: 0, partial: message, call };
        }
        yield { type: 'done', reason: message.stopReason, message };
      },
      result: async () => message,
    };
  };
  return sent;
}

/** 等到 check() 为真（最多 3 秒）。 */
async function until(check, what) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 只有模型 m1 的提供商 p（synthetic）。 */
function oneModel() {
  return provider({ models: [{ id: 'm1', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false,
    input: ['text'] }] });
}

/** 一个装好 key、运行时按 answer 回答的模型层；临时目录在测试结束时删掉。 */
async function answeringLayer(t, answer, { profiles = null, p = oneModel() } = {}) {
  quiet(t);
  stubGlobalFetch(t);
  const scratch = scratchLayer({ config: configWith(p), profiles });
  t.after(() => rmSync(scratch.dir, { recursive: true, force: true, maxRetries: 5 }));
  const sent = answeringStreams(scratch.runtime, answer);
  await scratch.layer.load({ 'p#1': 'sk-x' }, ['p#1'], null);
  return { ...scratch, sent, p };
}

/** 这个模型的探针已结束、档案存到了 phase all。 */
function settled(layer, ref) {
  const book = layer.getProfiles();
  return book.lookupRef(ref)?.auto.phase === 'all' && !book.isRunning(ref);
}

test('MP-42 the essentials are stored first: the model is selectable while the background round runs, then '
  + 'the tier is filled in', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { layer } = await answeringLayer(t, ({ prompt }) => ({ ...passing(prompt),
    gate: BACKGROUND.includes(prompt) ? gate : null }));
  const book = layer.getProfiles();
  layer.startProbes(['p/m1']);
  await until(() => book.lookupRef('p/m1')?.auto.phase === 'essentials', 'the essentials');
  assert.equal(book.isRunning('p/m1'), true, 'the background round is still running');
  assert.equal(layer.toolCallingOf('p/m1'), 'verified', 'selectable from now on');
  const base = layer.staticBase({ project: null, projectError: null });
  assert.equal(sel.selectStatic({ ...base, candidates: ['p/m1'] }).model, 'p/m1');
  const needsTier = { ...base, candidates: ['p/m1'], requires: [{ kind: 'protocol_write', min: 'C' }] };
  const role = sel.selectStatic(needsTier);
  assert.deepEqual([role.model, role.excluded[0]?.reason], [null, 'probing'], 'a role that needs the tier waits');
  assert.equal(layer.profileOf('p/m1').tier.level, null);
  release();
  await until(() => settled(layer, 'p/m1'), 'the background');
  assert.equal(layer.profileOf('p/m1').tier.level, 'A');
  assert.equal(sel.selectStatic(needsTier).model, 'p/m1');
});

test('MP-42 at start a profile stored with phase essentials only runs the background round', async (t) => {
  const p = oneModel();
  const notRun = { outcome: 'not_run', detail: null };
  const kept = storedProfile(targetIn(p, 'm1'), { phase: 'essentials' }, { a: notRun, b: notRun, image: notRun });
  const { layer, sent } = await answeringLayer(t, ({ prompt }) => passing(prompt), { profiles: [kept], p });
  await layer.startupProbes(false);
  await until(() => settled(layer, 'p/m1'), 'the background');
  assert.deepEqual(sent.map((item) => item.prompt).sort(), [PP.image, PP.json, PP.outcome].sort());
  assert.equal(layer.profileOf('p/m1').tier.level, 'A');
});

test('MP-43 an essential error is retried after 1, 5, 15 and 60 minutes, then no more until the next probe',
  async (t) => {
    const { layer, sent } = await answeringLayer(t, () => ({ error: 'Connection error.' }));
    // synthetic 的短间隔（§12 是 1、5、15、60 分钟）
    layer.timings = { ...MODEL_TIMINGS, probeRetryDelaysMs: [20, 20, 20, 20] };
    assert.deepEqual(MODEL_TIMINGS.probeRetryDelaysMs, [60_000, 300_000, 900_000, 3_600_000]);
    const runs = () => sent.filter((item) => item.prompt === PP.weather).length;
    layer.startProbes(['p/m1']);
    await until(() => runs() === 5, 'four retries');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(runs(), 5, 'no fifth retry');
    assert.equal(layer.toolCallingOf('p/m1'), 'unverified');
    layer.startProbes(['p/m1']);
    await until(() => runs() === 10, 'Verify again resets the count');
  });

test('MP-43 only background errors retry only the background round; a clean set stops the retries', async (t) => {
  let images = 0;
  const { layer, sent } = await answeringLayer(t, ({ prompt }) => {
    if (prompt === PP.image) images += 1;
    if (prompt === PP.image && images === 1) return { error: '429 Too Many Requests' };
    return passing(prompt, 'Blue.');
  });
  layer.timings = { ...MODEL_TIMINGS, probeRetryDelaysMs: [20, 20, 20, 20] };
  layer.startProbes(['p/m1']);
  await until(() => images === 2 && settled(layer, 'p/m1'), 'the background retry');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sent.filter((item) => item.prompt === PP.weather).length, 1, 'the essentials are not sent again');
  assert.equal(images, 2, 'the clean background run stops the retries');
  assert.equal(layer.getProfiles().lookupRef('p/m1').auto.steps.image.outcome, 'fail');
});

test('MP-43 at start a profile with an error step is probed again at once', async (t) => {
  const p = oneModel();
  const kept = storedProfile(targetIn(p, 'm1'), {}, { ready: { outcome: 'error', detail: '429 Too Many Requests' } });
  const { layer, sent } = await answeringLayer(t, ({ prompt }) => passing(prompt), { profiles: [kept], p });
  await layer.startupProbes(false);
  await until(() => sent.some((item) => item.prompt === PP.weather) && settled(layer, 'p/m1'), 'the probe again');
  assert.equal(layer.getProfiles().lookupRef('p/m1').auto.steps.ready.outcome, 'pass');
});

test('MP-44 an image probe that passes turns on image input in the config without probing again', async (t) => {
  const { layer, sent, paths } = await answeringLayer(t, ({ prompt }) => passing(prompt));
  layer.startProbes(['p/m1']);
  await until(() => settled(layer, 'p/m1'), 'the probes');
  await until(() => layer.lookupModel('p/m1').model.input.includes('image'), 'the config');
  const file = JSON.parse(readFileSync(paths.config, 'utf8'));
  assert.deepEqual(file.providers[0].models[0].input, ['text', 'image'], 'written to model-config.json');
  assert.equal(layer.needsAutoProbe('p/m1'), false, 'the profile matches the new config');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sent.filter((item) => item.prompt === PP.weather).length, 1, 'not probed again');
  assert.equal(layer.profileOf('p/m1').vision, 'verified');
});

test('MP-44 an image probe that fails leaves the config alone and records vision failed', async (t) => {
  const p = oneModel();
  p.models[0].input = ['text', 'image'];
  const { layer } = await answeringLayer(t, ({ prompt }) => passing(prompt, 'Blue.'), { p });
  layer.startProbes(['p/m1']);
  await until(() => settled(layer, 'p/m1'), 'the probes');
  assert.deepEqual(layer.lookupModel('p/m1').model.input, ['text', 'image'], 'Image input stays checked');
  assert.equal(layer.profileOf('p/m1').vision, 'failed');
});

test('MP-45 the layer’s first-token limit per model: 120 s for sessions and 30 min for tests without a record, '
  + 'then learned', async (t) => {
  const { layer } = await answeringLayer(t, ({ prompt }) => passing(prompt));
  assert.equal(layer.firstTokenLimitOf('p/m1', 'session'), 120_000);
  assert.equal(layer.firstTokenLimitOf('p/m1', 'probe'), 1_800_000);
  layer.recordFirstToken('p/m1', 125_000);
  assert.equal(layer.firstTokenLimitOf('p/m1', 'session'), 375_000);
  assert.equal(layer.firstTokenLimitOf('p/m1', 'probe'), 375_000);
  layer.recordFirstTokenTimeout('p/m1', 375_000);
  assert.equal(layer.firstTokenLimitOf('p/m1', 'session'), 750_000, 'doubled after a timeout');
  layer.recordFirstToken('p/m1', 10_000);
  assert.equal(layer.firstTokenLimitOf('p/m1', 'session'), 375_000, 'a first token clears the boost');
  assert.equal(layer.firstTokenLimitOf('gone/model', 'session'), 120_000);
  layer.recordFirstToken('gone/model', 500_000);
  assert.equal(layer.firstTokenLimitOf('gone/model', 'probe'), 1_800_000, 'not in the config: nothing recorded');
});
