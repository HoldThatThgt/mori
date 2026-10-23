// 发现命令的单元测试（docs/specs/model-discovery.md §13.2 MD-06，单元层）：响应体最多读 8 MB（§5.3、§11：列表为 invalid
// “The model list is larger than 8 MB.”，详情按失败，D5）；每个请求的时限取 options.timings（§11 默认 15 秒；从拿到 origin 的
// 位置、发出到读完响应体，D6），超时为 unreachable “Timed out after <秒>s”（D4）。替身 fetch 与响应体都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  captureConsole, deferred, empty, existing, hang, json, newRequest, providerRequest, readerWith, settle, stubFetch,
} from './io-helpers.mjs';

const { DiscoverReader, BODY_MAX_BYTES, ORIGIN_LIMIT } = await loadKernelModule('src/kernel/modelDiscover.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 已有提供商的地址（synthetic）：§3.2 只试 <baseUrl>/models。 */
const BASE = 'http://192.0.2.60:8000/v1';
const MB = 1024 * 1024;

/**
 * @brief 一个流式响应体：每次 pull 给 chunkBytes 个字节（ASCII 空格），共 totalBytes 个；记下读了多少。
 * @return { response, pulled() }
 */
function streamed(totalBytes, chunkBytes = MB) {
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: 200 }), pulled: () => sent };
}

/** @brief 正好 bytes 个字节的模型列表 JSON（一行 m，用空白补足）。 */
function exactList(bytes) {
  const head = '{"object":"list","data":[{"id":"m","object":"model"}]}';
  return head + ' '.repeat(bytes - head.length);
}

test('MD-06 a list body over 8 MB is invalid "The model list is larger than 8 MB." and reading stops', async (t) => {
  captureConsole(t);
  assert.equal(BODY_MAX_BYTES, 8 * MB);
  const big = streamed(64 * MB);
  const stub = stubFetch(() => big.response);
  const result = await readerWith(DiscoverReader, stub.fetch).command(providerRequest(BASE));
  assert.deepEqual(result.listError, { kind: 'invalid', detail: 'The model list is larger than 8 MB.' });
  assert.equal(result.server, null);
  assert.deepEqual(result.models, []);
  assert.ok(big.pulled() <= BODY_MAX_BYTES + MB, `read ${big.pulled()} bytes of a 64 MB body`);
});

test('MD-06 a list body of exactly 8 MB is read; one byte more is invalid', async (t) => {
  captureConsole(t);
  const fits = stubFetch(() => new Response(exactList(BODY_MAX_BYTES)));
  const ok = await readerWith(DiscoverReader, fits.fetch).command(providerRequest(BASE));
  assert.equal(ok.listError, null);
  assert.deepEqual(ok.models.map((model) => model.id), ['m']);
  const over = stubFetch(() => new Response(exactList(BODY_MAX_BYTES + 1)));
  const bad = await readerWith(DiscoverReader, over.fetch).command(providerRequest(BASE));
  assert.deepEqual(bad.listError, { kind: 'invalid', detail: 'The model list is larger than 8 MB.' });
});

test('MD-06 a new provider tries the next list address after an over-8 MB attempt (D5)', async (t) => {
  captureConsole(t);
  const stub = stubFetch((call) => (call.path === '/models' ? streamed(9 * MB).response
    : json({ object: 'list', data: [{ id: 'm', object: 'model', owned_by: 'vllm' }] })));
  const result = await readerWith(DiscoverReader, stub.fetch).command(newRequest('http://192.0.2.61:8000'));
  assert.deepEqual(stub.calls.slice(0, 2).map((call) => call.url),
    ['http://192.0.2.61:8000/models', 'http://192.0.2.61:8000/v1/models']);
  assert.equal(result.listError, null);
  assert.equal(result.baseUrl, 'http://192.0.2.61:8000/v1');
  // ② 是 404 时最后一次决定：no_list
  const none = stubFetch((call) => (call.path === '/models' ? streamed(9 * MB).response : empty(404)));
  const missing = await readerWith(DiscoverReader, none.fetch).command(newRequest('http://192.0.2.62:8000'));
  assert.deepEqual(missing.listError, { kind: 'no_list', detail: '' });
});

test('MD-06 a detail body over 8 MB fails only that detail: the model is listed without it, one log line',
  async (t) => {
    const lines = captureConsole(t);
    const stub = stubFetch((call) => {
      if (call.path === '/v1/models') {
        return json({ object: 'list', data: [{ id: 'q', object: 'model', owned_by: 'sglang', parent: null,
          max_model_len: 40960 }] });
      }
      if (call.path === '/model_info') return streamed(9 * MB).response;
      return call.path === '/version' ? json({ version: '0.5.0' }) : empty(404);
    });
    const result = await readerWith(DiscoverReader, stub.fetch).command(providerRequest(BASE));
    assert.equal(result.listError, null);
    assert.deepEqual(result.server, { kind: 'sglang', version: '0.5.0' });
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].contextWindow, 40960);
    assert.equal(result.models[0].reported.reasoning, false, '/model_info was not merged');
    const failed = lines.filter((line) => line.includes('/model_info'));
    assert.equal(failed.length, 1, lines.join('\n'));
    assert.match(failed[0], /response larger than 8 MB/);
  });

test('MD-06 the request time limit comes from options.timings: a hanging list is unreachable "Timed out"',
  async (t) => {
    captureConsole(t);
    const stub = stubFetch(hang);
    const started = Date.now();
    const result = await readerWith(DiscoverReader, stub.fetch, { timeoutMs: 150 }).command(providerRequest(BASE));
    assert.deepEqual(result.listError, { kind: 'unreachable', detail: 'Timed out after 0.15s' });
    assert.equal(result.cancelled, false);
    assert.ok(Date.now() - started >= 140, 'not before the limit');
    assert.equal(stub.calls[0].signal.aborted, true, 'the request is aborted at the limit');
  });

test('MD-06 the limit covers the body read: headers then a stalled body also time out (D6)', async (t) => {
  captureConsole(t);
  const stub = stubFetch(() => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })));
  const result = await readerWith(DiscoverReader, stub.fetch, { timeoutMs: 150 }).command(providerRequest(BASE));
  assert.deepEqual(result.listError, { kind: 'unreachable', detail: 'Timed out after 0.15s' });
});

test('MD-06 time spent waiting for the per-origin slot does not count toward the limit (D6)', async (t) => {
  captureConsole(t);
  const late = deferred();
  const stub = stubFetch((call) => {
    if (call.path.startsWith('/busy')) return hang(call);
    return new Promise((res) => setTimeout(() => res(json({ data: [{ id: 'm' }] })), 100)).then((response) => {
      late.resolve();
      return response;
    });
  });
  const reader = readerWith(DiscoverReader, stub.fetch, { timeoutMs: 300 });
  const busy = Array.from({ length: ORIGIN_LIMIT },
    (_, i) => reader.version(existing(`http://192.0.2.63:8000/busy${i}`), new AbortController().signal));
  await settle();
  const queuedAt = Date.now();
  const queued = reader.version(existing('http://192.0.2.63:8000/v1'), new AbortController().signal);
  const read = await queued;
  await late.promise;
  assert.ok(Date.now() - queuedAt >= 300, 'it waited for a slot, then 100 ms for the answer');
  assert.equal(read.listed, true, 'queued ~300 ms + 100 ms answer is still within the 300 ms limit after sending');
  assert.ok((await Promise.all(busy)).every((item) => item.listed === false), 'the hanging ones timed out');
});

test('MD-06 a detail request that times out fails only that detail; the list result stays', async (t) => {
  const lines = captureConsole(t);
  const stub = stubFetch((call) => {
    if (call.path === '/v1/models') {
      return json({ object: 'list', data: [{ id: 'q', object: 'model', owned_by: 'sglang', max_model_len: 4096 }] });
    }
    return call.path === '/model_info' ? hang(call) : empty(404);
  });
  const result = await readerWith(DiscoverReader, stub.fetch, { timeoutMs: 150 }).command(providerRequest(BASE));
  assert.equal(result.listError, null);
  assert.equal(result.models[0].contextWindow, 4096);
  assert.ok(lines.some((line) => /\/model_info failed: Timed out after 0\.15s/.test(line)), lines.join('\n'));
});

test('MD-06 step 0 and version reads are bounded by the same limit', async (t) => {
  captureConsole(t);
  const stub = stubFetch(hang);
  const reader = readerWith(DiscoverReader, stub.fetch, { timeoutMs: 100 });
  const target = existing(BASE);
  const version = await reader.version(target, new AbortController().signal);
  assert.deepEqual(version, { listed: false, kind: 'unknown', version: null, versionRead: false });
  const single = await reader.single(target, 'm', new AbortController().signal);
  assert.deepEqual(single, { kind: 'unknown', version: null, reported: null,
    meta: { maxTokens: null, reasoning: null, image: null } });
});

test('MD-06 the default limit is 15 s (§11): not timed out at 14.999 s, "Timed out after 15s" at 15 s', async (t) => {
  captureConsole(t);
  assert.equal(MODEL_TIMINGS.discoverRequestTimeoutMs, 15_000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = stubFetch(hang);
  const reader = new DiscoverReader({ timings: MODEL_TIMINGS, fetch: stub.fetch });
  let result = null;
  const pending = reader.command(providerRequest(BASE)).then((value) => {
    result = value;
  });
  await settle();
  assert.equal(stub.calls.length, 1);
  t.mock.timers.tick(14_999);
  await settle();
  assert.equal(result, null, 'still waiting at 14.999 s');
  t.mock.timers.tick(1);
  await settle();
  await pending;
  assert.deepEqual(result.listError, { kind: 'unreachable', detail: 'Timed out after 15s' });
});
