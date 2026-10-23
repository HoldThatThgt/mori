// 发现命令的单元测试（docs/specs/model-discovery.md §13.2 MD-06，单元层）：同一个提供商（shareKey = baseUrl + api + key 的
// ref）同时进行的列表与种类判断只做一次，各自只发自己的详情请求；等它的调用全部取消时才中止，读完就丢（§5.3，D10）；
// 每个 origin 同时最多 4 个请求（命令、第 0 步、读版本合计），多出来的先来先得排队，排队时可以取消（§5.3、§11）。
// 合成端点的形状来自 tests/fake-endpoint/discovery.mjs（synthetic），其余替身 fetch 也是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  captureConsole, deferred, empty, existing, hang, json, providerRequest, readerWith, settle, shapeFetch, stubFetch,
} from './io-helpers.mjs';

const { DiscoverReader, ORIGIN_LIMIT } = await loadKernelModule('src/kernel/modelDiscover.ts');

/** 合成端点 ollama 形状的已有提供商（synthetic 地址）。 */
const OLLAMA = 'http://192.0.2.90:11434/v1';
const SHARE = `${OLLAMA}|openai-completions|p#1`;
const MODELS = ['m1', 'm2', 'm3'];
const NO_META = { maxTokens: null, reasoning: null, image: null };

/** @brief 这些请求里路径为 path（方法 method）的个数。 */
function count(calls, path, method = 'GET') {
  return calls.filter((call) => call.path === path && call.method === method).length;
}

test('MD-06 concurrent step 0 reads and a version read of one provider send one list request', async (t) => {
  captureConsole(t);
  const stub = shapeFetch({ shape: 'ollama', models: MODELS });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing(OLLAMA, { shareKey: SHARE });
  const signal = new AbortController().signal;
  const [one, two, three, version] = await Promise.all([...MODELS.map((id) => reader.single(target, id, signal)),
    reader.version(target, signal)]);
  assert.equal(count(stub.calls, '/v1/models'), 1, JSON.stringify(stub.calls.map((call) => call.url)));
  for (const path of ['/.well-known/localai.json', '/api/version', '/props', '/api/v1/models', '/info']) {
    assert.equal(count(stub.calls, path), 1, `step 6 ${path} is part of the shared read`);
  }
  // 各自只发自己的详情请求：每个模型一个 /api/show，正文是它自己的 id；读版本不发详情（§7.3）
  const shows = stub.calls.filter((call) => call.path === '/api/show').map((call) => JSON.parse(call.body).model);
  assert.deepEqual(shows.sort(), MODELS);
  assert.equal(count(stub.calls, '/api/tags'), 3);
  assert.equal(count(stub.calls, '/api/ps'), 3);
  assert.deepEqual(one, { kind: 'ollama', version: '0.10.1', reported: 8192,
    meta: { maxTokens: null, reasoning: true, image: false } });
  assert.equal(two.reported, 16384);
  assert.equal(three.reported, null, 'only the trained window: not reported (§7.2)');
  assert.deepEqual(version, { listed: true, kind: 'ollama', version: '0.10.1', versionRead: true });
});

test('MD-06 step 0 reads without a list share their step-6 judgement as well (D10)', async (t) => {
  captureConsole(t);
  const stub = stubFetch((call) => (call.path === '/api/version' ? json({ version: '0.9.0' }) : empty(404)));
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing(OLLAMA, { shareKey: SHARE });
  const reads = await Promise.all(MODELS.map((id) => reader.single(target, id, new AbortController().signal)));
  assert.equal(count(stub.calls, '/v1/models'), 1);
  for (const path of ['/.well-known/localai.json', '/api/version', '/props', '/api/v1/models', '/info']) {
    assert.equal(count(stub.calls, path), 1, path);
  }
  // 拿不到列表时没有列表行，第 6 步认不出 Ollama（§3.3 第 6 步要列表行有 owned_by 和 created）
  for (const read of reads) assert.deepEqual(read, { kind: 'unknown', version: null, reported: null, meta: NO_META });
});

test('MD-06 a models.discover of the same provider joins a running step 0 read', async (t) => {
  captureConsole(t);
  const stub = shapeFetch({ shape: 'vllm', models: MODELS });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const single = reader.single(existing(OLLAMA, { shareKey: SHARE }), 'm2', new AbortController().signal);
  const command = await reader.command(providerRequest(OLLAMA, { shareKey: SHARE, configured: ['m2'] }));
  assert.equal(count(stub.calls, '/v1/models'), 1);
  assert.deepEqual(command.models.map((model) => [model.id, model.added]), [['m1', false], ['m2', true],
    ['m3', false]]);
  assert.deepEqual(await single, { kind: 'vllm', version: '0.10.1', reported: 131072, meta: NO_META });
});

test('MD-06 the shared read is aborted only when every waiter has aborted (D10)', async (t) => {
  captureConsole(t);
  const list = deferred();
  const stub = stubFetch((call) => {
    if (call.path === '/v1/models') return list.promise;
    return call.path === '/version' ? json({ version: '0.10.1' }) : empty(404);
  });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing(OLLAMA, { shareKey: SHARE });
  const first = new AbortController();
  const a = reader.single(target, 'm1', first.signal);
  const b = reader.single(target, 'm2', new AbortController().signal);
  await settle();
  first.abort(new Error('first probe set cancelled'));
  await assert.rejects(a, /first probe set cancelled/);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].signal.aborted, false, 'one waiter left: the list request goes on');
  list.resolve(json({ data: MODELS.map((id) => ({ id, owned_by: 'vllm', max_model_len: 4096 })) }));
  assert.equal((await b).reported, 4096);
  // 两个都取消：共享的读取中止；之后的读取重新发列表请求（读完就丢、不缓存）
  const hanging = stubFetch(hang);
  const other = readerWith(DiscoverReader, hanging.fetch);
  const c = new AbortController();
  const d = new AbortController();
  const pendingC = other.single(target, 'm1', c.signal);
  const pendingD = other.version(target, d.signal);
  await settle();
  c.abort(new Error('c'));
  d.abort(new Error('d'));
  await Promise.allSettled([pendingC, pendingD]);
  assert.equal(hanging.calls.length, 1);
  assert.equal(hanging.calls[0].signal.aborted, true, 'the last waiter aborting aborts the shared read');
  const last = new AbortController();
  const again = other.version(target, last.signal);
  await settle();
  assert.equal(hanging.calls.length, 2, 'a dropped read is not reused');
  assert.equal(hanging.calls[1].signal.aborted, false);
  last.abort(new Error('done'));
  await assert.rejects(again, /done/);
});

test('MD-06 reads merge only while running and only for the same shareKey; null never merges', async (t) => {
  captureConsole(t);
  const stub = shapeFetch({ shape: 'vllm', models: MODELS });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const signal = new AbortController().signal;
  const target = existing(OLLAMA, { shareKey: SHARE });
  await reader.version(target, signal);
  await reader.version(target, signal);
  assert.equal(count(stub.calls, '/v1/models'), 2, 'done reads are dropped, not cached (§9)');
  const otherKey = existing(OLLAMA, { shareKey: `${OLLAMA}|openai-completions|p#2` });
  await Promise.all([reader.version(target, signal), reader.version(otherKey, signal)]);
  assert.equal(count(stub.calls, '/v1/models'), 4, 'another key ref is another read');
  const unshared = existing(OLLAMA);
  await Promise.all([reader.single(unshared, 'm1', signal), reader.single(unshared, 'm2', signal)]);
  assert.equal(count(stub.calls, '/v1/models'), 6, 'shareKey null never merges');
});

/**
 * @brief 每个 origin 分开计数的替身：slow 的 origin 上的列表请求等 release(path) 才回答（vLLM 列表），其余立即回答。
 * @return { fetch, calls, release(path), peak(origin) }
 */
function gatedFetch(slow) {
  const waiting = new Map();
  const active = new Map();
  const peaks = new Map();
  const stub = stubFetch(async (call) => {
    const now = (active.get(call.origin) ?? 0) + 1;
    active.set(call.origin, now);
    peaks.set(call.origin, Math.max(peaks.get(call.origin) ?? 0, now));
    try {
      if (call.origin === slow && call.path.endsWith('/models')) {
        const gate = deferred();
        waiting.set(call.path, gate);
        await Promise.race([gate.promise, hang(call)]);
      }
      if (call.path.endsWith('/models')) return json({ data: [{ id: 'm', owned_by: 'vllm', max_model_len: 2048 }] });
      return call.path === '/version' ? json({ version: '0.10.1' }) : empty(404);
    } finally {
      active.set(call.origin, active.get(call.origin) - 1);
    }
  });
  return { ...stub, release: (path) => waiting.get(path).resolve(), peak: (origin) => peaks.get(origin) ?? 0 };
}

test('MD-06 at most 4 requests per origin (command, step 0 and version reads together), FIFO, cancel while queued',
  async (t) => {
    captureConsole(t);
    assert.equal(ORIGIN_LIMIT, 4);
    const slow = 'http://192.0.2.91:8000';
    const stub = gatedFetch(slow);
    const reader = readerWith(DiscoverReader, stub.fetch);
    const signal = new AbortController().signal;
    const command = reader.command(providerRequest(`${slow}/c1`));
    const single = reader.single(existing(`${slow}/s1`), 'm', signal);
    const versions = [reader.version(existing(`${slow}/v1`), signal), reader.version(existing(`${slow}/v2`), signal)];
    await settle();
    const onSlow = () => stub.calls.filter((call) => call.origin === slow).map((call) => call.path);
    assert.deepEqual(onSlow(), ['/c1/models', '/s1/models', '/v1/models', '/v2/models']);
    const cancelB = new AbortController();
    const queuedB = reader.version(existing(`${slow}/qb`), cancelB.signal);
    const queuedC = reader.single(existing(`${slow}/qc`), 'm', signal);
    const queuedD = reader.version(existing(`${slow}/qd`), signal);
    const elsewhere = await reader.version(existing('http://192.0.2.92:8000/v1'), signal);
    assert.equal(elsewhere.listed, true, 'another origin is not held up');
    await settle();
    assert.equal(onSlow().length, 4, 'the fifth request waits');
    cancelB.abort(new Error('cancelled while queued'));
    await assert.rejects(queuedB, /cancelled while queued/);
    stub.release('/c1/models');
    await settle();
    assert.deepEqual(onSlow().slice(4), ['/qc/models'], 'first in, first out; the cancelled one is skipped');
    stub.release('/s1/models');
    await settle();
    assert.deepEqual(onSlow().slice(4, 6), ['/qc/models', '/qd/models']);
    for (const path of ['/v1/models', '/v2/models', '/qc/models', '/qd/models']) stub.release(path);
    const results = await Promise.all([command, single, ...versions, queuedC, queuedD]);
    assert.ok(results.every((result) => result.kind === 'vllm' || result.server?.kind === 'vllm'));
    assert.ok(!onSlow().includes('/qb/models'), 'the cancelled queued request is never sent');
    assert.equal(stub.peak(slow), ORIGIN_LIMIT);
  });
