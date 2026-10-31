// 读版本的单元测试（docs/specs/model-discovery.md §7.3；§13.2 MD-12 单元层）：versionChanged 按读版本的结果判断
// （拿到列表且种类不同 → 重新探测；种类相同只看读到的版本；拿不到列表不变；没有版本请求的种类只比种类）；读版本不发
// §4.2 的详情请求；第 6 步的请求没有得到 HTTP 回答、种类因此为 unknown 时按拿不到列表处理，404 照样算回答
// （§7.3，2026-10-23 补）；checkVersions 每个提供商（baseUrl + api）读一次。替身 fetch、档案与配置都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  captureConsole, configOf, configProvider, connectionFailure, empty, existing, hang, json, probesIdle, readerWith,
  sampleFetch, scratchLayer, shapeFetch, stubFetch, stubGlobalFetch,
} from './io-helpers.mjs';

const { DiscoverReader } = await loadKernelModule('src/kernel/modelDiscover.ts');
const P = await loadKernelModule('src/kernel/modelProfiles.ts');
const { ModelLayer } = await loadKernelModule('src/kernel/modelLayer.ts');
const { reservedIds } = await loadKernelModule('src/kernel/modelConfig.ts');

const pass = { outcome: 'pass', detail: null };
const na = { outcome: 'not_applicable', detail: null };
const NOT_READ = { listed: false, kind: 'unknown', version: null, versionRead: false };
const signal = () => new AbortController().signal;

/** 一个已存的档案（synthetic）：种类 kind，版本 version（没有版本时为 unknown）。 */
function profile(kind, version, { baseUrl = 'http://127.0.0.1:4319/v1', modelId = 'fake-coder' } = {}) {
  const target = { baseUrl, api: 'openai-completions', compat: {},
    model: { id: modelId, family: '', contextWindow: 131072, maxTokens: 16384, reasoning: false, input: ['text'] } };
  const auto = { server: { kind, version }, reported: null, field: 'none', meta: { maxTokens: null, reasoning: null,
    image: null }, steps: { ready: pass, thinking: na, call: pass, result: pass, replay: na, a: pass, b: pass,
    c: { outcome: 'not_run', detail: null }, image: { outcome: 'not_run', detail: null } } };
  return P.buildProfile({ target, auto, now: 1 });
}

/** @brief 读版本的结果：读到了这个种类与版本。 */
function read(kind, version, versionRead = version !== null) {
  return { listed: true, kind, version, versionRead };
}

// ---- versionChanged（§7.3） ----

test('MD-12 versionChanged: a listed server of another kind is probed again, a version read failure is not',
  () => {
    const vllm = profile('vllm', '0.10.1');
    assert.equal(P.versionChanged(vllm, read('sglang', '0.10.1')), true, 'kind differs');
    assert.equal(P.versionChanged(vllm, read('localai', null)), true, 'kind differs, no version request');
    assert.equal(P.versionChanged(vllm, read('vllm', '0.10.1')), false);
    assert.equal(P.versionChanged(vllm, read('vllm', '0.11.0')), true, 'same kind, another version read');
    assert.equal(P.versionChanged(vllm, read('vllm', null, false)), false, 'the version request failed');
    assert.equal(P.versionChanged(vllm, { listed: true, kind: 'vllm', version: '0.11.0', versionRead: false }),
      false, 'only a version that was read counts');
    assert.equal(P.versionChanged(vllm, NOT_READ), false, 'no list: the profile stays');
    assert.equal(P.versionChanged(vllm, { ...NOT_READ, kind: 'sglang' }), false, 'not listed: kind is not compared');
    assert.equal(P.versionChanged(undefined, read('sglang', '1')), false, 'no profile, nothing to compare');
  });

test('MD-12 versionChanged: kinds without a version request compare the kind only', () => {
  const deepseek = profile('deepseek', 'unknown');
  assert.equal(P.versionChanged(deepseek, read('deepseek', null, false)), false);
  assert.equal(P.versionChanged(deepseek, read('openrouter', null, false)), true);
  // 原来被认成 vLLM 的 LocalAI：读版本认出种类变了，重新探测一次；之后版本为 unknown，不再重新探测（§3.3）
  const misjudged = profile('vllm', '2.9.0 (abc)');
  assert.equal(P.versionChanged(misjudged, read('localai', null, false)), true);
  const reprobed = profile('localai', 'unknown');
  assert.equal(reprobed.key, 'http://127.0.0.1:4319/v1|openai-completions|fake-coder|unknown');
  assert.equal(P.versionChanged(reprobed, read('localai', null, false)), false);
  const tensorrt = profile('tensorrt', 'unknown');
  assert.equal(P.versionChanged(tensorrt, read('tensorrt', null, false)), false);
  assert.equal(P.versionChanged(profile('vllm', '0.10.1'), read('tensorrt', null, false)), true,
    'TensorRT-LLM misjudged as vLLM is probed again once too');
});

test('MD-12 localai and tensorrt shapes once judged vLLM: probed again once, then left alone',
  { timeout: 20_000 }, async (t) => {
    const lines = captureConsole(t);
    // 合成端点的形状（synthetic）：两种都回答 /version，原来的第 0 步因此认成 vLLM 0.10.1（§3.3）
    let served = null;
    const stub = stubGlobalFetch(t, (call) => served.fetch(call.url, { method: call.method, headers: call.headers,
      body: call.body ?? undefined }));
    for (const [shape, port] of [['localai', 9040], ['tensorrt', 9041]]) {
      const base = `http://127.0.0.1:${port}/v1`;
      served = shapeFetch({ shape });
      const config = configOf([configProvider('p', base, ['fake-coder'])]);
      const old = profile('vllm', '0.10.1', { baseUrl: base });
      const { layer, runtime } = scratchLayer(ModelLayer, reservedIds(['openai']), { config, profiles: [old] });
      await layer.load({}, [], null);
      await layer.checkVersions(['p/fake-coder']);
      assert.deepEqual(layer.getProfiles().running().map((item) => item.ref), ['p/fake-coder'], shape);
      await probesIdle(layer);
      const reprobed = layer.getProfiles().lookupRef('p/fake-coder');
      assert.deepEqual(reprobed.auto.server, { kind: shape, version: 'unknown' }, shape);
      assert.equal(reprobed.key, `${base}|openai-completions|fake-coder|unknown`, shape);
      const streamed = runtime.streamed.length;
      assert.ok(streamed > 0, `${shape}: steps 1-7 ran`);
      // 第二次读版本：种类没变、没有版本请求，不再重新探测
      await layer.checkVersions(['p/fake-coder']);
      assert.deepEqual(layer.getProfiles().running(), [], shape);
      assert.equal(runtime.streamed.length, streamed, shape);
      const own = stub.calls.filter((call) => call.origin === `http://127.0.0.1:${port}`);
      assert.ok(own.length > 0 && !own.some((call) => call.path === '/version'), `${shape}: /version is not read`);
      assert.equal(lines.filter((line) => line === `log [kernel] server of p/fake-coder changed to ${shape} unknown; `
        + 'probing again').length, 1, shape);
    }
  });

// ---- 读版本不发 §4.2 的详情请求 ----

/** @brief 这些请求的路径（含 query）。 */
const paths = (stub) => stub.calls.map((call) => `${call.method === 'GET' ? '' : `${call.method} `}${call.path}`
  + call.search);

test('MD-12 a version read sends no §4.2 detail request on the ollama, sglang and llamacpp shapes', async (t) => {
  captureConsole(t);
  const ollama = shapeFetch({ shape: 'ollama' });
  assert.deepEqual(await readerWith(DiscoverReader, ollama.fetch).version(existing('http://127.0.0.1:4330/v1'),
    signal()), read('ollama', '0.10.1'));
  for (const detail of ['/api/tags', '/api/ps', 'POST /api/show']) assert.ok(!paths(ollama).includes(detail), detail);
  assert.equal(paths(ollama).filter((path) => path === '/api/version').length, 1, 'step 6 /api/version is reused');
  const sglang = shapeFetch({ shape: 'sglang' });
  assert.deepEqual(await readerWith(DiscoverReader, sglang.fetch).version(existing('http://127.0.0.1:4331/v1'),
    signal()), read('sglang', '0.10.1'));
  assert.deepEqual(paths(sglang), ['/v1/models', '/version'], 'no /model_info');
  const llamacpp = shapeFetch({ shape: 'llamacpp' });
  assert.deepEqual(await readerWith(DiscoverReader, llamacpp.fetch).version(existing('http://127.0.0.1:4332/v1'),
    signal()), read('llamacpp', '0.10.1'));
  assert.deepEqual(paths(llamacpp), ['/v1/models', '/props'], '/props once, as the version request');
});

test('MD-12 a version read of localai, tensorrt and vllm: no /version for the first two, no details', async (t) => {
  captureConsole(t);
  const localai = shapeFetch({ shape: 'localai' });
  assert.deepEqual(await readerWith(DiscoverReader, localai.fetch).version(existing('http://127.0.0.1:4333/v1'),
    signal()), read('localai', null, false));
  assert.ok(!paths(localai).some((path) => path === '/version' || path.endsWith('/models/capabilities')),
    JSON.stringify(paths(localai)));
  const tensorrt = shapeFetch({ shape: 'tensorrt' });
  assert.deepEqual(await readerWith(DiscoverReader, tensorrt.fetch).version(existing('http://127.0.0.1:4334/v1'),
    signal()), read('tensorrt', null, false));
  assert.deepEqual(paths(tensorrt), ['/v1/models']);
  const vllm = shapeFetch({});
  assert.deepEqual(await readerWith(DiscoverReader, vllm.fetch).version(existing('http://127.0.0.1:4335/v1'),
    signal()), read('vllm', '0.10.1'));
  assert.deepEqual(paths(vllm), ['/v1/models', '/version']);
});

test('MD-12 a version read of the GPUStack, MindIE, DashScope, LM Studio and TGI samples sends no detail',
  async (t) => {
    captureConsole(t);
    const cases = [
      ['http://192.0.2.17/v1', { '/v1/models': 'gpustack-models' }, 'gpustack', ['/v1/models']],
      ['http://192.0.2.18:1025/v1', { '/v1/models': 'mindie-models' }, 'mindie', ['/v1/models']],
      ['https://dashscope.aliyuncs.com/compatible-mode/v1', { '/compatible-mode/v1/models':
        'dashscope-compatible-models' }, 'dashscope', ['/compatible-mode/v1/models']],
    ];
    for (const [base, routes, kind, sent] of cases) {
      const stub = sampleFetch(routes);
      assert.deepEqual(await readerWith(DiscoverReader, stub.fetch).version(existing(base), signal()),
        read(kind, null, false), kind);
      assert.deepEqual(paths(stub), sent, kind);
    }
    const lmstudio = sampleFetch({ '/v1/models': 'lmstudio-v1-models', '/api/v1/models': 'lmstudio-api-v1-models' });
    assert.deepEqual(await readerWith(DiscoverReader, lmstudio.fetch).version(existing('http://192.0.2.15:1234/v1'),
      signal()), read('lmstudio', null, false));
    assert.equal(paths(lmstudio).filter((path) => path === '/api/v1/models').length, 1, 'step 6 only');
    const tgi = sampleFetch({ '/v1/models': 'tgi-models', '/info': 'tgi-info' });
    assert.deepEqual(await readerWith(DiscoverReader, tgi.fetch).version(existing('http://192.0.2.19:8080/v1'),
      signal()), read('tgi', null, false));
    assert.equal(paths(tgi).filter((path) => path === '/info').length, 1, 'step 6 only');
  });

// ---- 第 6 步没有 HTTP 回答（§7.3，2026-10-23 补） ----

/**
 * @brief 列表行没有能认出种类的字段（第 1–5 步判断不了），第 6 步的 failing 路径按 how 失败（connection：连接失败，
 *        hang：一直不回答到超时），其余为 404。
 */
function stepSixFetch(failing, how, rows = [{ id: 'm', object: 'model' }]) {
  return stubFetch((call) => {
    if (call.path === '/v1/models') return json({ object: 'list', data: rows });
    if (call.path !== failing) return empty(404);
    if (how === 'hang') return hang(call);
    throw connectionFailure('connect ECONNREFUSED 192.0.2.110:8080');
  });
}

test('MD-12 a step-6 request with no HTTP answer that leaves the kind unknown keeps the profile', async (t) => {
  const lines = captureConsole(t);
  const stored = profile('localai', 'unknown', { baseUrl: 'http://192.0.2.110:8080/v1' });
  const target = existing('http://192.0.2.110:8080/v1');
  const refused = await readerWith(DiscoverReader, stepSixFetch('/.well-known/localai.json', 'connection').fetch)
    .version(target, signal());
  assert.deepEqual(refused, NOT_READ);
  assert.equal(P.versionChanged(stored, refused), false);
  const timedOut = await readerWith(DiscoverReader, stepSixFetch('/props', 'hang').fetch, { timeoutMs: 100 })
    .version(target, signal());
  assert.deepEqual(timedOut, NOT_READ);
  assert.equal(P.versionChanged(stored, timedOut), false);
  assert.ok(lines.some((line) => line.includes('kind unknown after unanswered probe requests; profiles unchanged')),
    lines.join('\n'));
});

test('MD-12 a 404 from every step-6 request is an answer: unknown is a changed kind', async (t) => {
  captureConsole(t);
  const stored = profile('localai', 'unknown', { baseUrl: 'http://192.0.2.111:8080/v1' });
  const answered = await readerWith(DiscoverReader, stepSixFetch('/none', 'connection').fetch)
    .version(existing('http://192.0.2.111:8080/v1'), signal());
  assert.deepEqual(answered, read('unknown', null, false));
  assert.equal(P.versionChanged(stored, answered), true);
});

test('MD-12 an unanswered /api/version only counts when the first row could make it Ollama', async (t) => {
  captureConsole(t);
  const target = existing('http://192.0.2.112:11434/v1');
  const plain = await readerWith(DiscoverReader, stepSixFetch('/api/version', 'connection').fetch)
    .version(target, signal());
  assert.deepEqual(plain, read('unknown', null, false), 'rows without owned_by and created cannot be Ollama');
  const ollamaRows = [{ id: 'm', object: 'model', created: 1790000000, owned_by: 'library' }];
  const blocked = await readerWith(DiscoverReader, stepSixFetch('/api/version', 'connection', ollamaRows).fetch)
    .version(target, signal());
  assert.deepEqual(blocked, NOT_READ);
  // 第 6 步别的请求没有回答、但种类已经认出时照常比较
  const known = stubFetch((call) => {
    if (call.path === '/v1/models') return json({ data: [{ id: 'm' }] });
    if (call.path === '/.well-known/localai.json') return json({ version: '2.9.0' });
    if (call.path === '/props') throw connectionFailure('connect ECONNRESET');
    return empty(404);
  });
  assert.deepEqual(await readerWith(DiscoverReader, known.fetch).version(target, signal()),
    read('localai', null, false));
});

// ---- 规格更正 5（规划会话，2026-10-23，审查 C12）：读版本时 /api/version 没有回答不算种类变化 ----

/** Ollama 形状的合成服务（synthetic）：列表行带 owned_by 与 created，/api/version 按 how 回答。 */
const OLLAMA_AT = 'http://127.0.0.1:9020/v1';

/** @brief /v1/models 回答 Ollama 形状的列表；/api/version 按 how：hang 一直不回答（超时），404，或 { version }。 */
function ollamaVersion(how) {
  return (call) => {
    if (call.path === '/v1/models') {
      return json({ object: 'list', data: [{ id: 'qwen3:8b', object: 'model', created: 1790000000,
        owned_by: 'library' }] });
    }
    if (call.path !== '/api/version') return empty(404);
    if (how === 'hang') return hang(call);
    return how === 404 ? empty(404) : json({ version: how });
  };
}

/** @brief 一个提供商 o（qwen3:8b），档案为 ollama 0.12.0。 */
async function ollamaProvider() {
  const config = configOf([configProvider('o', OLLAMA_AT, ['qwen3:8b'])]);
  const profiles = [profile('ollama', '0.12.0', { baseUrl: OLLAMA_AT, modelId: 'qwen3:8b' })];
  const harness = scratchLayer(ModelLayer, reservedIds(['openai']), { config, profiles });
  await harness.layer.load({}, [], null);
  return harness;
}

test('MD-12 checkVersions: list ok and /api/version timing out keeps the ollama profile and probes nothing',
  { timeout: 60_000 }, async (t) => {
    captureConsole(t);
    stubGlobalFetch(t, ollamaVersion('hang'));
    const { layer } = await ollamaProvider();
    const before = layer.getProfiles().lookupRef('o/qwen3:8b');
    await layer.checkVersions(['o/qwen3:8b']);
    assert.deepEqual(layer.getProfiles().running(), [], 'no re-probe after an unanswered /api/version');
    assert.deepEqual(layer.getProfiles().lookupRef('o/qwen3:8b'), before, 'the profile is unchanged');
  });

test('MD-12 checkVersions: list ok and /api/version answering 404 is a changed kind, so the model is probed again',
  { timeout: 60_000 }, async (t) => {
    captureConsole(t);
    stubGlobalFetch(t, ollamaVersion(404));
    const { layer } = await ollamaProvider();
    await layer.checkVersions(['o/qwen3:8b']);
    assert.deepEqual(layer.getProfiles().running().map((item) => item.ref), ['o/qwen3:8b'],
      'an HTTP answer counts as evidence: kind unknown differs from the stored ollama');
    await probesIdle(layer);
  });

// ---- checkVersions：每个提供商（baseUrl + api）读一次 ----

/** 两个提供商 p、q 在同一个服务上，r 在另一个（synthetic）。 */
const SHARED = 'http://127.0.0.1:9000/p';
const OTHER = 'http://127.0.0.1:9001/r';

/** @brief 合成服务：两个 origin 都是 vLLM 形状，/version 按 origin 给出。 */
function versionsAt(versions) {
  return (call) => {
    if (call.path.endsWith('/models')) {
      return json({ object: 'list', data: ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id, object: 'model',
        owned_by: 'vllm', max_model_len: 65536 })) });
    }
    return call.path === '/version' ? json({ version: versions[call.origin] }) : empty(404);
  };
}

/** @brief p（m1、m2，key p#1）与 q（m3，没有 key）在 SHARED，r（m4）在 OTHER，全部已有 0.10.1 的档案。 */
async function threeProviders() {
  const config = configOf([configProvider('p', SHARED, ['m1', 'm2'], { keys: ['p#1'] }),
    configProvider('q', SHARED, ['m3']), configProvider('r', OTHER, ['m4'])]);
  const profiles = [['m1', SHARED], ['m2', SHARED], ['m3', SHARED], ['m4', OTHER]]
    .map(([modelId, baseUrl]) => profile('vllm', '0.10.1', { baseUrl, modelId }));
  const harness = scratchLayer(ModelLayer, reservedIds(['openai']), { config, profiles });
  await harness.layer.load({ 'p#1': 'sk-test-p1' }, ['p#1'], null);
  return harness;
}

test('MD-12 checkVersions reads the version once per provider and leaves unchanged profiles alone',
  { timeout: 20_000 }, async (t) => {
    captureConsole(t);
    const stub = stubGlobalFetch(t, versionsAt({ 'http://127.0.0.1:9000': '0.10.1',
      'http://127.0.0.1:9001': '0.10.1' }));
    const { layer } = await threeProviders();
    for (const ref of ['p/m1', 'p/m2', 'q/m3', 'r/m4']) assert.equal(layer.needsAutoProbe(ref), false, ref);
    await layer.checkVersions(['p/m1', 'p/m2', 'q/m3', 'r/m4']);
    assert.deepEqual(stub.calls.map((call) => call.url).sort(), ['http://127.0.0.1:9000/p/models',
      'http://127.0.0.1:9000/version', 'http://127.0.0.1:9001/r/models', 'http://127.0.0.1:9001/version']);
    const shared = stub.calls.find((call) => call.url === 'http://127.0.0.1:9000/p/models');
    assert.equal(shared.headers.authorization, 'Bearer sk-test-p1', 'the group reads with the key of p (§5.1)');
    assert.deepEqual(layer.getProfiles().running(), [], 'the same kind and version: nothing is probed again');
  });

test('MD-12 checkVersions probes again every model of the provider whose version changed, only those',
  { timeout: 20_000 }, async (t) => {
    const lines = captureConsole(t);
    const stub = stubGlobalFetch(t, versionsAt({ 'http://127.0.0.1:9000': '0.11.0',
      'http://127.0.0.1:9001': '0.10.1' }));
    const { layer, runtime } = await threeProviders();
    await layer.checkVersions(['p/m1', 'p/m2', 'q/m3', 'r/m4']);
    assert.deepEqual(layer.getProfiles().running().map((item) => item.ref).sort(), ['p/m1', 'p/m2', 'q/m3']);
    for (const ref of ['p/m1', 'p/m2', 'q/m3']) {
      assert.ok(lines.includes(`log [kernel] server of ${ref} changed to vllm 0.11.0; probing again`), ref);
    }
    await probesIdle(layer);
    assert.deepEqual([...new Set(runtime.streamed)].sort(), ['m1', 'm2', 'm3']);
    const at = (origin, path) => stub.calls.filter((call) => call.origin === origin && call.path === path);
    assert.equal(at('http://127.0.0.1:9001', '/r/models').length, 1, 'r: one version read, no probe');
    assert.equal(at('http://127.0.0.1:9001', '/version').length, 1);
    // SHARED：读版本 1 次；重新探测的第 0 步里 p/m1、p/m2 合并成 1 次列表请求（§5.3），q/m3 用另一个 key ref（没有 key）
    // 再读 1 次；第 0 步的版本请求每个模型各 1 次
    const lists = at('http://127.0.0.1:9000', '/p/models');
    assert.equal(lists.length, 3);
    assert.deepEqual(lists.map((call) => call.headers.authorization ?? null).sort(),
      ['Bearer sk-test-p1', 'Bearer sk-test-p1', null]);
    assert.equal(at('http://127.0.0.1:9000', '/version').length, 4);
    for (const ref of ['p/m1', 'p/m2', 'q/m3']) {
      assert.equal(layer.getProfiles().lookupRef(ref).auto.server.version, '0.11.0', ref);
    }
    assert.equal(layer.getProfiles().lookupRef('r/m4').auto.server.version, '0.10.1');
  });
