// kernel/modelPool.ts 的单元测试：§8 的槽位、排队与优先级、不可用记录与恢复、发请求用的 fetch（§8.4）。
// MP-41（§8.3 的 2026-10-26 补）：测试连接不看任何不可用记录、总是发出，成功后清除它证明不成立的记录。
// 端点是替身 fetch（synthetic），时钟与定时器是假的（§12）；key 都是测试用的假值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, loadKernelModule } from './load.mjs';

const { createModelPool, ModelUnavailableError, authHeaders } = await loadKernelModule('src/kernel/modelPool.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 让 promise 链与流的读取跑完。 */
async function flush() {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 假时钟加假定时器：advance 按时刻顺序触发到期的定时器。 */
function fakeTimers() {
  const clock = fakeClock(1_000_000);
  const timers = new Map();
  let nextId = 0;
  return {
    now: clock.now,
    setTimeout(callback, ms) {
      nextId += 1;
      timers.set(nextId, { at: clock.now() + ms, callback });
      return nextId;
    },
    clearTimeout(handle) { timers.delete(handle); },
    async advance(ms) {
      const target = clock.now() + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock.set(Math.max(clock.now(), due[1].at));
        due[1].callback();
        await flush();
      }
      clock.set(target);
      await flush();
    },
  };
}

/** 一个可控的响应：push 推正文，end 结束；signal 触发时像 Node fetch 一样让响应体出错。 */
function controlled(signal, { status = 200, headers = {} } = {}) {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  signal?.addEventListener('abort', () => {
    try { controller.error(new DOMException('This operation was aborted', 'AbortError')); } catch { /* 已结束 */ }
  });
  return {
    response: new Response(body, { status, headers }),
    push: (text) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

/** 替身 fetch：记下每次调用；handler 决定怎么回答，默认回一个立即结束的 200。 */
function stubFetch() {
  const calls = [];
  const stub = {
    calls,
    handler: () => new Response('data: ok\n\n', { status: 200 }),
    fetch: (url, init) => {
      const call = { url, init, headers: new Headers(init.headers), body: init.body, signal: init.signal };
      calls.push(call);
      return Promise.resolve().then(() => stub.handler(call, calls.length));
    },
  };
  return stub;
}

/** 等 signal 触发才拒绝的 fetch 回答（-hang：不回响应头）。 */
function hang(call) {
  return new Promise((_resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  });
}

/** §4.1 形状的提供商（synthetic）。 */
function provider(id, overrides = {}) {
  return {
    id, name: `${id.toUpperCase()} name`, api: 'openai-completions', baseUrl: `http://127.0.0.1:9000/${id}`,
    compat: {}, concurrency: 4, keys: [], nextKeyNumber: 1,
    models: [
      { id: 'm1', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] },
      { id: 'm2', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] },
    ],
    ...overrides,
  };
}

/** 建一个池：一个提供商 p，key 由 keys 给出（明文为 secret-<ref>）。 */
function setup({ keys = ['p#1'], concurrency = 4, api = 'openai-completions', timings = MODEL_TIMINGS } = {}) {
  const timers = fakeTimers();
  const stub = stubFetch();
  const logs = [];
  const pool = createModelPool({ timings, clock: timers, fetch: stub.fetch, log: (line) => logs.push(line) });
  const config = provider('p', { api, concurrency, keys: keys.map((ref, i) => ({ ref, label: `Key ${i + 1}` })) });
  pool.setProviders([config]);
  pool.setKeys('p', keys.map((ref) => ({ ref, secret: `secret-${ref}` })));
  return { pool, timers, stub, logs, config };
}

/** 建一个 fetch 并记下它的回调。 */
function poolFetch(pool, overrides = {}) {
  const seen = { records: [], sent: 0, queue: [], retries: [] };
  const fetch = pool.createFetch({
    ref: 'p/m1', api: 'openai-completions', sessionKey: 's1', cls: 'conversation',
    onSent: () => { seen.sent += 1; },
    onRecord: (record) => seen.records.push(record),
    onQueue: (notice) => seen.queue.push(notice),
    onRetryWait: (notice) => seen.retries.push(notice),
    ...overrides,
  });
  return { fetch, seen };
}

/** pi 发来的请求（带占位 key）。 */
const PI_INIT = { method: 'POST', headers: { authorization: 'Bearer mori-pool', 'content-type': 'application/json' },
  body: '{"model":"m1"}' };

// ---- MP-32 认证头 ----

test('MP-32 openai-completions sends Bearer with the pool key, never the placeholder', async () => {
  const { pool, stub } = setup();
  const { fetch } = poolFetch(pool);
  await (await fetch('http://127.0.0.1:9000/p/chat/completions', PI_INIT)).text();
  assert.equal(stub.calls[0].headers.get('authorization'), 'Bearer secret-p#1');
  assert.equal(stub.calls[0].headers.get('x-api-key'), null);
  assert.equal(stub.calls[0].headers.get('content-type'), 'application/json');
  assert.ok(!JSON.stringify([...stub.calls[0].headers]).includes('mori-pool'));
});

test('MP-32 openai-responses sends Bearer with the pool key', async () => {
  const { pool, stub } = setup({ api: 'openai-responses' });
  const { fetch } = poolFetch(pool, { api: 'openai-responses' });
  await (await fetch('http://127.0.0.1:9000/p/responses', PI_INIT)).text();
  assert.equal(stub.calls[0].headers.get('authorization'), 'Bearer secret-p#1');
  assert.equal(stub.calls[0].headers.get('x-api-key'), null);
});

test('MP-32 anthropic-messages sends x-api-key and drops Authorization', async () => {
  const { pool, stub } = setup({ api: 'anthropic-messages' });
  const { fetch } = poolFetch(pool, { api: 'anthropic-messages' });
  const init = { ...PI_INIT, headers: { 'x-api-key': 'mori-pool', authorization: 'Bearer mori-pool' } };
  await (await fetch('http://127.0.0.1:9000/p/v1/messages', init)).text();
  assert.equal(stub.calls[0].headers.get('x-api-key'), 'secret-p#1');
  assert.equal(stub.calls[0].headers.get('authorization'), null);
});

test('MP-32 a keyless provider sends no auth header for any API type', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
    const { pool, stub } = setup({ keys: [], api });
    const { fetch } = poolFetch(pool, { api });
    const init = { ...PI_INIT, headers: { 'x-api-key': 'mori-pool', authorization: 'Bearer mori-pool' } };
    await (await fetch('http://127.0.0.1:9000/p/x', init)).text();
    assert.equal(stub.calls[0].headers.get('authorization'), null, api);
    assert.equal(stub.calls[0].headers.get('x-api-key'), null, api);
  }
});

test('MP-32 auth headers are rewritten on a Request input and with a stubbed global fetch', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(new Headers(init.headers)); return new Response('ok'); };
  try {
    const pool = createModelPool({ clock: fakeTimers(), log: () => {} });
    pool.setProviders([provider('p', { keys: [{ ref: 'p#1', label: 'Key 1' }] })]);
    pool.setKeys('p', [{ ref: 'p#1', secret: 'secret-1' }]);
    const fetch = pool.createFetch({ ref: 'p/m1', api: 'openai-responses', sessionKey: 's', cls: 'conversation' });
    const request = new Request('http://127.0.0.1:9000/p/responses',
      { headers: { authorization: 'Bearer mori-pool' } });
    await (await fetch(request)).text();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0].get('authorization'), 'Bearer secret-1');
  assert.equal(authHeaders(new Headers({ 'x-api-key': 'a' }), 'openai-completions', null).has('x-api-key'), false);
});

test('MP-32 key secrets never reach the log or the attempt records', async () => {
  const { pool, stub, logs } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = (_call, n) => (n === 1 ? new Response('limited', { status: 429 }) : new Response('ok'));
  const { fetch, seen } = poolFetch(pool);
  await (await fetch('http://127.0.0.1:9000/p', PI_INIT)).text();
  const text = JSON.stringify([logs, seen.records, pool.keyStatus()]);
  assert.ok(!text.includes('secret-'), text);
  assert.ok(logs.length > 0);
});

// ---- MP-31 槽位不泄漏 ----

test('MP-31 a 2xx body read to the end frees the slot', async () => {
  const { pool, stub } = setup();
  let handle;
  stub.handler = (call) => { handle = controlled(call.signal); return handle.response; };
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(pool.inFlight('p'), 1);
  handle.push('data: 1\n\n');
  handle.end();
  assert.equal(await response.text(), 'data: 1\n\n');
  assert.equal(pool.inFlight('p'), 0);
  assert.deepEqual(seen.records.map((r) => r.cls), ['ok']);
  assert.equal(seen.records[0].keyRef, 'p#1');
  assert.equal(seen.records[0].status, 200);
});

test('MP-31 cancelling the body (SDK after [DONE]) frees the slot', async () => {
  const { pool, stub } = setup();
  let handle;
  stub.handler = (call) => { handle = controlled(call.signal); return handle.response; };
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  handle.push('data: [DONE]\n\n');
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(pool.inFlight('p'), 0);
  assert.deepEqual(seen.records.map((r) => r.cls), ['ok']);
});

test('MP-31 a body error after output frees the slot and records partial', async () => {
  const { pool, stub } = setup();
  let handle;
  stub.handler = (call) => { handle = controlled(call.signal); return handle.response; };
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  handle.push('data: 1\n\n');
  const reader = response.body.getReader();
  await reader.read();
  handle.fail(new TypeError('terminated'));
  await assert.rejects(reader.read());
  assert.equal(pool.inFlight('p'), 0);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.hadOutput]), [['ok', false], ['partial', true]]);
});

test('MP-31 user stop while streaming frees the slot at once and records aborted', async () => {
  const { pool, stub } = setup();
  stub.handler = (call) => controlled(call.signal).response;
  const stop = new AbortController();
  const { fetch, seen } = poolFetch(pool, { signal: stop.signal });
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(pool.inFlight('p'), 1);
  stop.abort();
  assert.equal(pool.inFlight('p'), 0);
  await assert.rejects(response.text());
  assert.deepEqual(seen.records.map((r) => r.cls), ['ok', 'aborted']);
});

test('MP-31 a 4xx body is read and the slot freed before the response is handed back', async () => {
  const { pool, stub } = setup();
  stub.handler = () => new Response('{"error":"bad template"}', { status: 400, statusText: 'Bad Request',
    headers: { 'x-trace': 't1', 'content-type': 'application/json' } });
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(pool.inFlight('p'), 0);
  assert.equal(response.status, 400);
  assert.equal(response.statusText, 'Bad Request');
  assert.equal(response.headers.get('x-trace'), 't1');
  assert.equal(await response.text(), '{"error":"bad template"}');
  assert.deepEqual(seen.records.map((r) => [r.cls, r.status]), [['request', 400]]);
});

test('MP-31 at most errorBodyMaxBytes of a 4xx body are read', async () => {
  const { pool, stub } = setup({ timings: { ...MODEL_TIMINGS, errorBodyMaxBytes: 8 } });
  let cancelled = false;
  stub.handler = () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new TextEncoder().encode('0123456789')); },
    cancel() { cancelled = true; },
  }), { status: 400 });
  const { fetch } = poolFetch(pool);
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(await response.text(), '01234567');
  assert.equal(cancelled, true);
  assert.equal(pool.inFlight('p'), 0);
});

test('MP-31 a connection error frees the slot and rethrows the original error', async () => {
  const { pool, stub } = setup();
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
  stub.handler = () => { throw error; };
  const { fetch, seen } = poolFetch(pool);
  await assert.rejects(fetch('http://127.0.0.1:9000/p', PI_INIT), (thrown) => thrown === error);
  assert.equal(pool.inFlight('p'), 0);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.status, r.keyRef]), [['connection', null, 'p#1']]);
});

test('MP-31 stopping during a retry wait leaves no slot and sends nothing more', async () => {
  const { pool, stub, timers } = setup();
  stub.handler = () => new Response('busy', { status: 503 });
  const stop = new AbortController();
  const { fetch, seen } = poolFetch(pool, { signal: stop.signal });
  const pending = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  assert.equal(seen.retries.length, 1);
  stop.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await timers.advance(60_000);
  assert.equal(stub.calls.length, 1);
  assert.equal(pool.inFlight('p'), 0);
  assert.deepEqual(seen.records.map((r) => r.cls), ['server', 'aborted']);
});

// ---- MP-28 原地重试（§5.5，5xx 的处理列） ----

test('MP-28 5xx retries in place after 2, 4 and 8 s, calling onRetryWait before each wait', async () => {
  const { pool, stub, timers } = setup();
  stub.handler = (_call, n) => (n <= 3 ? new Response('busy', { status: 503 }) : new Response('ok'));
  const { fetch, seen } = poolFetch(pool);
  const pending = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  assert.deepEqual(seen.retries, [{ attempt: 1, max: 3, status: 503, delayMs: 2000 }]);
  await timers.advance(1999);
  assert.equal(stub.calls.length, 1);
  await timers.advance(1);
  assert.equal(stub.calls.length, 2);
  await timers.advance(4000);
  await timers.advance(8000);
  const response = await pending;
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(seen.retries.map((r) => r.delayMs), [2000, 4000, 8000]);
  assert.equal(seen.sent, 4);
  assert.deepEqual(seen.records.map((r) => r.cls), ['server', 'server', 'server', 'ok']);
  assert.ok(stub.calls.every((call) => call.body === PI_INIT.body));
});

test('MP-28 when retries run out the last 5xx goes back to the caller', async () => {
  const { pool, stub, timers } = setup();
  stub.handler = () => new Response('still busy', { status: 502 });
  const { fetch, seen } = poolFetch(pool);
  const pending = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  await timers.advance(14_000);
  const response = await pending;
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'still busy');
  assert.equal(stub.calls.length, 4);
  assert.equal(seen.records.at(-1).cls, 'server');
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-28 no in-place retry when serverRetries is false (Test connection)', async () => {
  const { pool, stub } = setup();
  stub.handler = () => new Response('busy', { status: 503 });
  const { fetch, seen } = poolFetch(pool, { serverRetries: false });
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(response.status, 503);
  assert.equal(stub.calls.length, 1);
  assert.equal(seen.retries.length, 0);
});

test('MP-28 a non-string body is not resent: no retry and no key rotation', async () => {
  const { pool, stub } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = (_call, n) => new Response('x', { status: n === 1 ? 503 : 429 });
  const { fetch } = poolFetch(pool);
  const bytes = { ...PI_INIT, body: new TextEncoder().encode('{}') };
  assert.equal((await fetch('http://127.0.0.1:9000/p', bytes)).status, 503);
  assert.equal((await fetch('http://127.0.0.1:9000/p', bytes)).status, 429);
  assert.equal(stub.calls.length, 2);
});

// ---- MP-03 / MP-04 多个 key ----

test('MP-03 a 429 on the first key resends the same body with the second key', async () => {
  const { pool, stub } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = (call) => (call.headers.get('authorization') === 'Bearer secret-p#1'
    ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : new Response('ok'));
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(stub.calls.map((c) => c.headers.get('authorization')), ['Bearer secret-p#1', 'Bearer secret-p#2']);
  assert.equal(stub.calls[1].body, PI_INIT.body);
  assert.equal(seen.sent, 2);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.keyRef, r.retryAfterMs]),
    [['rate_limited', 'p#1', 7000], ['ok', 'p#2', null]]);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-03 the cooled key is skipped until Retry-After, then used again', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = (_call, n) => (n === 1 ? new Response('x', { status: 429, headers: { 'retry-after': '7' } })
    : new Response('ok'));
  const statuses = [];
  pool.onKeyStatus((status) => statuses.push(status));
  const { fetch } = poolFetch(pool);
  await (await fetch('http://127.0.0.1:9000/p', PI_INIT)).text();
  assert.deepEqual(pool.keyStatus(), { 'p#1': { state: 'rate_limited', until: timers.now() + 7000 } });
  await (await fetch('http://127.0.0.1:9000/p', PI_INIT)).text();
  assert.equal(stub.calls[2].headers.get('authorization'), 'Bearer secret-p#2');
  await timers.advance(7000);
  assert.deepEqual(pool.keyStatus(), {});
  await (await fetch('http://127.0.0.1:9000/p', PI_INIT)).text();
  assert.equal(stub.calls[3].headers.get('authorization'), 'Bearer secret-p#1');
  assert.equal(statuses.length, 2);
  assert.deepEqual(statuses[1], {});
});

test('MP-03 two sessions at concurrency 1 use the two keys at the same time', async () => {
  const { pool, stub } = setup({ keys: ['p#1', 'p#2'], concurrency: 1 });
  const handles = [];
  stub.handler = (call) => { const h = controlled(call.signal); handles.push(h); return h.response; };
  const a = poolFetch(pool, { sessionKey: 's1' });
  const b = poolFetch(pool, { sessionKey: 's2' });
  const [ra, rb] = await Promise.all([a.fetch('http://127.0.0.1:9000/p', PI_INIT),
    b.fetch('http://127.0.0.1:9000/p', PI_INIT)]);
  assert.deepEqual(stub.calls.map((c) => c.headers.get('authorization')), ['Bearer secret-p#1', 'Bearer secret-p#2']);
  assert.equal(pool.inFlight('p'), 2);
  handles.forEach((h) => h.end());
  await Promise.all([ra.text(), rb.text()]);
  assert.equal(pool.inFlight('p'), 0);
});

test('MP-04 when every key is rate limited the 429 goes back and the model is unavailable', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = (call) => new Response('limited', { status: 429,
    headers: { 'retry-after': call.headers.get('authorization').endsWith('#1') ? '20' : '5' } });
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), 'limited');
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(seen.records.map((r) => r.cls), ['rate_limited', 'rate_limited']);
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'rate_limited', until: timers.now() + 5000 });
  assert.deepEqual(pool.availability('p/m2'), { available: false, reason: 'rate_limited', until: timers.now() + 5000 });
  await timers.advance(5000);
  assert.equal(pool.availability('p/m1').available, true);
});

// ---- MP-19 排队与优先级 ----

test('MP-19 at concurrency 1 the second request queues, reports it, and goes when the slot frees', async () => {
  const { pool, stub } = setup({ concurrency: 1 });
  const handles = [];
  stub.handler = (call) => { const h = controlled(call.signal); handles.push(h); return h.response; };
  const first = poolFetch(pool, { sessionKey: 's1' });
  const second = poolFetch(pool, { sessionKey: 's2' });
  const r1 = await first.fetch('http://127.0.0.1:9000/p', PI_INIT);
  const pending = second.fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  assert.equal(pool.queued('p'), 1);
  assert.deepEqual(second.seen.queue, [{ active: true, provider: 'p', providerName: 'P name' }]);
  assert.equal(stub.calls.length, 1);
  handles[0].end();
  await r1.text();
  await pending;
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(second.seen.queue.map((n) => n.active), [true, false]);
  assert.equal(pool.queued('p'), 0);
});

/** 占满并发 1 的槽位，返回放开它的函数。 */
async function occupy(pool, stub) {
  let handle;
  stub.handler = (call) => { handle = controlled(call.signal); return handle.response; };
  const response = await poolFetch(pool, { sessionKey: 'holder' }).fetch('http://127.0.0.1:9000/p', PI_INIT);
  stub.handler = () => new Response('ok');
  return async () => { handle.end(); await response.text(); await flush(); };
}

test('MP-19 conversation requests go before background ones queued earlier', async () => {
  const { pool, stub, timers } = setup({ concurrency: 1 });
  const free = await occupy(pool, stub);
  const order = [];
  const probe = poolFetch(pool, { cls: 'background', sessionKey: 'probe', onSent: () => order.push('probe') });
  const chat = poolFetch(pool, { cls: 'conversation', sessionKey: 'chat', onSent: () => order.push('chat') });
  const p1 = probe.fetch('http://127.0.0.1:9000/p', PI_INIT).then((r) => r.text());
  await timers.advance(1000);
  const p2 = chat.fetch('http://127.0.0.1:9000/p', PI_INIT).then((r) => r.text());
  await flush();
  await free();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['chat', 'probe']);
});

test('MP-19 the queue is shared across sessions and ordered by enqueue time', async () => {
  const { pool, stub, timers } = setup({ concurrency: 1 });
  const free = await occupy(pool, stub);
  const order = [];
  const runs = [];
  for (const sessionKey of ['s3', 's1', 's2']) {
    const { fetch } = poolFetch(pool, { sessionKey, onSent: () => order.push(sessionKey) });
    runs.push(fetch('http://127.0.0.1:9000/p', PI_INIT).then((r) => r.text()));
    await timers.advance(10);
  }
  assert.equal(pool.queued('p'), 3);
  await free();
  await Promise.all(runs);
  assert.deepEqual(order, ['s3', 's1', 's2']);
});

test('MP-19 a conversation request queued for 60 s fails with queue_timeout and is never sent', async () => {
  const { pool, stub, timers } = setup({ concurrency: 1 });
  await occupy(pool, stub);
  const { fetch, seen } = poolFetch(pool);
  const pending = fetch('http://127.0.0.1:9000/p', PI_INIT);
  const outcome = assert.rejects(pending, /Waited 60 s for a free slot on P name/);
  await timers.advance(59_999);
  assert.equal(pool.queued('p'), 1);
  await timers.advance(1);
  await outcome;
  assert.equal(stub.calls.length, 1);
  assert.equal(seen.sent, 0);
  assert.deepEqual(seen.records, [{ ref: 'p/m1', keyRef: null, cls: 'queue_timeout', status: null,
    retryAfterMs: null, hadOutput: false, sentAt: null }]);
  assert.deepEqual(seen.queue.map((n) => n.active), [true, false]);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-19 background requests wait without a queue timeout', async () => {
  const { pool, stub, timers } = setup({ concurrency: 1 });
  const free = await occupy(pool, stub);
  const { fetch, seen } = poolFetch(pool, { cls: 'background' });
  const pending = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await timers.advance(10 * 60_000);
  assert.equal(pool.queued('p'), 1);
  await free();
  assert.equal((await pending).status, 200);
  assert.deepEqual(seen.records.map((r) => r.cls), ['ok']);
});

test('MP-19 stop dequeues only that request; the other queued one still goes', async () => {
  const { pool, stub } = setup({ concurrency: 1 });
  const free = await occupy(pool, stub);
  const stop = new AbortController();
  const stopped = poolFetch(pool, { sessionKey: 's1', signal: stop.signal });
  const other = poolFetch(pool, { sessionKey: 's2' });
  const p1 = stopped.fetch('http://127.0.0.1:9000/p', PI_INIT);
  const p2 = other.fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  stop.abort();
  await assert.rejects(p1, { name: 'AbortError' });
  assert.equal(pool.queued('p'), 1);
  assert.deepEqual(stopped.seen.records.map((r) => r.cls), ['aborted']);
  assert.deepEqual(stopped.seen.queue.map((n) => n.active), [true, false]);
  await free();
  assert.equal((await p2).status, 200);
  assert.equal(stub.calls.length, 2);
  assert.equal(stopped.seen.sent, 0);
});

test('MP-19 a request whose stop already fired is not queued or sent', async () => {
  const { pool, stub } = setup();
  const stop = new AbortController();
  stop.abort();
  const { fetch, seen } = poolFetch(pool, { signal: stop.signal });
  await assert.rejects(fetch('http://127.0.0.1:9000/p', PI_INIT), { name: 'AbortError' });
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(seen.records.map((r) => r.cls), ['aborted']);
});

test('MP-19 lowering concurrency lets running requests finish; new ones wait below the new limit', async () => {
  const { pool, stub, config } = setup({ concurrency: 2 });
  const handles = [];
  stub.handler = (call) => { const h = controlled(call.signal); handles.push(h); return h.response; };
  const r1 = await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  const r2 = await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  pool.setProviders([{ ...config, concurrency: 1 }]);
  const third = poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  assert.equal(pool.queued('p'), 1);
  handles[0].end();
  await r1.text();
  await flush();
  assert.equal(pool.queued('p'), 1, 'still at the new limit');
  handles[1].end();
  await r2.text();
  await flush();
  assert.equal(pool.queued('p'), 0);
  assert.equal(stub.calls.length, 3);
  handles[2].end();
  await (await third).text();
  assert.equal(pool.inFlight('p'), 0);
});

test('MP-19 removing a key lets its request finish; queued requests take another key', async () => {
  const { pool, stub, config } = setup({ keys: ['p#1', 'p#2'], concurrency: 1 });
  const handles = [];
  stub.handler = (call) => { const h = controlled(call.signal); handles.push(h); return h.response; };
  const r1 = await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  const r2 = await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  const queued = poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  pool.setProviders([{ ...config, keys: [{ ref: 'p#2', label: 'Key 2' }] }]);
  pool.setKeys('p', [{ ref: 'p#2', secret: 'secret-p#2' }]);
  handles[0].end();
  assert.equal(await r1.text(), '');
  await flush();
  assert.equal(pool.queued('p'), 1, 'p#1 is gone, p#2 is busy');
  handles[1].end();
  await r2.text();
  await flush();
  assert.equal(stub.calls[2].headers.get('authorization'), 'Bearer secret-p#2');
  handles[2].end();
  await (await queued).text();
});

test('MP-19 a newly added key is used at once by a queued request', async () => {
  const { pool, stub } = setup({ keys: ['p#1'], concurrency: 1 });
  await occupy(pool, stub);
  const queued = poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  assert.equal(pool.queued('p'), 1);
  pool.setKeys('p', [{ ref: 'p#1', secret: 'secret-p#1' }, { ref: 'p#2', secret: 'secret-p#2' }]);
  assert.equal((await queued).status, 200);
  assert.equal(stub.calls[1].headers.get('authorization'), 'Bearer secret-p#2');
});

test('MP-19 all keys cooled by another session: the request fails at once without queueing', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1'] });
  stub.handler = () => new Response('limited', { status: 429, headers: { 'retry-after': '30' } });
  await poolFetch(pool, { sessionKey: 's1' }).fetch('http://127.0.0.1:9000/p', PI_INIT);
  const { fetch, seen } = poolFetch(pool, { sessionKey: 's2' });
  await assert.rejects(fetch('http://127.0.0.1:9000/p', PI_INIT), (error) => error instanceof ModelUnavailableError
    && error.reason === 'rate_limited' && error.until === timers.now() + 30_000);
  assert.equal(stub.calls.length, 1);
  assert.equal(seen.queue.length, 0);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.sentAt]), [['rate_limited', null]]);
});

test('MP-19 a queued request fails at once when its keys become cooled while it waits', async () => {
  const { pool, stub } = setup({ keys: ['p#1'], concurrency: 2 });
  let handle;
  let answer;
  stub.handler = (call, n) => {
    if (n === 1) { handle = controlled(call.signal); return handle.response; }
    return new Promise((resolve) => { answer = resolve; });
  };
  const r1 = await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  const second = poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  const { fetch, seen } = poolFetch(pool);
  const queued = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  assert.equal(pool.queued('p'), 1);
  answer(new Response('limited', { status: 429 }));
  await assert.rejects(queued, (e) => e instanceof ModelUnavailableError && e.reason === 'rate_limited');
  assert.equal((await second).status, 429);
  assert.equal(stub.calls.length, 2);
  assert.equal(seen.sent, 0);
  assert.deepEqual(seen.records.map((r) => r.cls), ['rate_limited']);
  assert.deepEqual(seen.queue.map((n) => n.active), [true, false]);
  handle.end();
  await r1.text();
  assert.equal(pool.inFlight('p'), 0);
});

// ---- MP-29 认证、额度、404、连接失败的记录与恢复 ----

test('MP-29 401 marks the key rejected without expiry and rotates to the next key', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = (call) => new Response('x', { status: call.headers.get('authorization').endsWith('#1') ? 401 : 200 });
  const { fetch, seen } = poolFetch(pool);
  assert.equal((await fetch('http://127.0.0.1:9000/p', PI_INIT)).status, 200);
  assert.deepEqual(seen.records.map((r) => r.cls), ['auth', 'ok']);
  await timers.advance(24 * 3600_000);
  assert.deepEqual(pool.keyStatus(), { 'p#1': { state: 'auth', until: null } });
});

test('MP-29 402 marks quota; Test with that key ignores the record and success clears it', async () => {
  const { pool, stub } = setup({ keys: ['p#1'] });
  stub.handler = () => new Response('{"error":"insufficient_quota"}', { status: 402 });
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.deepEqual(pool.keyStatus(), { 'p#1': { state: 'quota', until: null } });
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'quota', until: null });
  stub.handler = () => new Response('ok');
  const test1 = poolFetch(pool, { keyRef: 'p#1', serverRetries: false });
  assert.equal((await test1.fetch('http://127.0.0.1:9000/p', PI_INIT)).status, 200);
  assert.equal(stub.calls[1].headers.get('authorization'), 'Bearer secret-p#1');
  const changes = [];
  pool.onKeyStatus((status) => changes.push(status));
  pool.clearKeyRecord('p', 'p#1');
  assert.deepEqual(pool.keyStatus(), {});
  assert.deepEqual(changes, [{}]);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-29 Test with a key does not rotate to another key on failure', async () => {
  const { pool, stub } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = () => new Response('no', { status: 401 });
  const { fetch } = poolFetch(pool, { keyRef: 'p#2' });
  assert.equal((await fetch('http://127.0.0.1:9000/p', PI_INIT)).status, 401);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].headers.get('authorization'), 'Bearer secret-p#2');
  await assert.rejects(poolFetch(pool, { keyRef: 'p#9' }).fetch('http://127.0.0.1:9000/p', PI_INIT), /not saved/);
});

test('MP-29 removing a key drops its record; a re-added key starts clean', async () => {
  const { pool, stub } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = () => new Response('no', { status: 401 });
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.deepEqual(Object.keys(pool.keyStatus()).sort(), ['p#1', 'p#2']);
  pool.setKeys('p', [{ ref: 'p#2', secret: 'secret-p#2' }]);
  assert.deepEqual(Object.keys(pool.keyStatus()), ['p#2']);
  assert.equal(pool.availability('p/m1').reason, 'auth');
  pool.setKeys('p', [{ ref: 'p#2', secret: 'secret-p#2' }, { ref: 'p#3', secret: 'secret-p#3' }]);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-29 an address, API or compat change clears auth and quota but not rate limits', async () => {
  const { pool, stub, config } = setup({ keys: ['p#1', 'p#2', 'p#3'] });
  stub.handler = (call) => {
    const key = call.headers.get('authorization');
    if (key.endsWith('#1')) return new Response('x', { status: 401 });
    if (key.endsWith('#2')) return new Response('quota', { status: 429 });
    return new Response('x', { status: 429, headers: { 'retry-after': '100' } });
  };
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.deepEqual(Object.values(pool.keyStatus()).map((s) => s.state), ['auth', 'quota', 'rate_limited']);
  pool.setProviders([{ ...config, name: 'Renamed', concurrency: 2 }]);
  assert.equal(Object.keys(pool.keyStatus()).length, 3, 'name and concurrency keep records');
  pool.setProviders([{ ...config, compat: { supportsStore: false } }]);
  assert.deepEqual(pool.keyStatus(), { 'p#3': pool.keyStatus()['p#3'] });
  assert.equal(pool.keyStatus()['p#3'].state, 'rate_limited');
});

test('MP-29 404 marks only that model until its config or the provider endpoint changes', async () => {
  const { pool, stub, timers, config } = setup();
  stub.handler = () => new Response('no such model', { status: 404 });
  const { fetch, seen } = poolFetch(pool);
  assert.equal((await fetch('http://127.0.0.1:9000/p', PI_INIT)).status, 404);
  assert.deepEqual(seen.records.map((r) => r.cls), ['not_found']);
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'not_found', until: null });
  assert.equal(pool.availability('p/m2').available, true);
  await timers.advance(3600_000);
  pool.setProviders([{ ...config, name: 'Other', concurrency: 3, models: [...config.models].reverse() }]);
  assert.equal(pool.availability('p/m1').reason, 'not_found');
  const models = [{ ...config.models[0], maxTokens: 50 }, config.models[1]];
  pool.setProviders([{ ...config, models }]);
  assert.equal(pool.availability('p/m1').available, true);
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  pool.setProviders([{ ...config, models, baseUrl: 'http://127.0.0.1:9100/p' }]);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-29 a connection failure makes the provider unavailable for 30 s', async () => {
  const { pool, stub, timers } = setup();
  stub.handler = () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT));
  const until = timers.now() + 30_000;
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'connection', until });
  assert.deepEqual(pool.availability('p/m2'), { available: false, reason: 'connection', until });
  const { fetch, seen } = poolFetch(pool);
  await assert.rejects(fetch('http://127.0.0.1:9000/p', PI_INIT), (e) => e instanceof ModelUnavailableError);
  assert.deepEqual(seen.records.map((r) => r.cls), ['connection']);
  await timers.advance(30_000);
  assert.equal(pool.availability('p/m1').available, true);
  assert.deepEqual(pool.keyStatus(), {});
});

test('MP-29 markProvider (drop before the first content event) makes the provider unavailable until then', async () => {
  const { pool, timers, config } = setup();
  const until = timers.now() + 30_000;
  pool.markProvider('p', 'connection', until);
  assert.deepEqual(pool.availability('p/m2'), { available: false, reason: 'connection', until });
  const { fetch, seen } = poolFetch(pool);
  await assert.rejects(fetch('http://127.0.0.1:9000/p', PI_INIT), (e) => e instanceof ModelUnavailableError);
  assert.deepEqual(seen.records.map((r) => r.cls), ['connection']);
  await timers.advance(30_000);
  assert.equal(pool.availability('p/m1').available, true);
  pool.markProvider('p', 'connection', timers.now() + 30_000);
  pool.setProviders([{ ...config, baseUrl: 'http://127.0.0.1:9200/p' }]);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-29 an address change clears the connection record at once', async () => {
  const { pool, stub, config } = setup();
  stub.handler = () => { throw new TypeError('fetch failed'); };
  await assert.rejects(poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT));
  pool.setProviders([{ ...config, name: 'Only renamed' }]);
  assert.equal(pool.availability('p/m1').reason, 'connection');
  pool.setProviders([{ ...config, baseUrl: 'http://127.0.0.1:9200/p' }]);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-29 a keyless provider: 429 with Retry-After skips it until that time', async () => {
  const { pool, stub, timers } = setup({ keys: [] });
  stub.handler = () => new Response('x', { status: 429, headers: { 'retry-after': '12' } });
  const { fetch, seen } = poolFetch(pool);
  assert.equal((await fetch('http://127.0.0.1:9000/p', PI_INIT)).status, 429);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.keyRef]), [['rate_limited', null]]);
  assert.deepEqual(pool.availability('p/m1'),
    { available: false, reason: 'rate_limited', until: timers.now() + 12_000 });
  assert.deepEqual(pool.keyStatus(), {}, 'the keyless slot is not a key row');
  await timers.advance(11_999);
  assert.equal(pool.availability('p/m1').available, false);
  await timers.advance(1);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-29 a keyless provider: 401 and quota stay until a key is added or the endpoint changes', async () => {
  const { pool, stub, config } = setup({ keys: [] });
  stub.handler = () => new Response('x', { status: 401 });
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'auth', until: null });
  pool.setKeys('p', [{ ref: 'p#1', secret: 'secret-p#1' }]);
  assert.equal(pool.availability('p/m1').available, true);
  pool.setKeys('p', []);
  assert.equal(pool.availability('p/m1').available, true, 'the cleared record does not come back');
  stub.handler = () => new Response('billing', { status: 403 });
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  assert.equal(pool.availability('p/m1').reason, 'quota');
  pool.setProviders([{ ...config, api: 'openai-responses' }]);
  assert.equal(pool.availability('p/m1').available, true);
  pool.clearKeyRecord('p', null);
});

test('MP-29 availability names the earliest-recovering record when several apply', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1'] });
  stub.handler = () => new Response('x', { status: 429, headers: { 'retry-after': '50' } });
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  pool.markModel('p/m1', 'timeout', timers.now() + 20_000);
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'timeout', until: timers.now() + 20_000 });
  assert.deepEqual(pool.availability('p/m2'), { available: false, reason: 'rate_limited',
    until: timers.now() + 50_000 });
});

test('MP-29 a removed provider takes its records with it', async () => {
  const { pool, stub, config } = setup({ keys: ['p#1'] });
  stub.handler = () => new Response('x', { status: 404 });
  await poolFetch(pool).fetch('http://127.0.0.1:9000/p', PI_INIT);
  pool.setProviders([]);
  assert.equal(pool.availability('p/m1').available, true);
  pool.setProviders([config]);
  pool.setKeys('p', [{ ref: 'p#1', secret: 'secret-p#1' }]);
  assert.equal(pool.availability('p/m1').available, true);
});

// ---- MP-18 结果未知：尝试超时与 held ----

test('MP-18 attempt timeout before headers (hang) records timeout, frees the slot, writes no record', async () => {
  const { pool, stub } = setup();
  stub.handler = hang;
  const attempt = new AbortController();
  const { fetch, seen } = poolFetch(pool, { attemptSignal: attempt.signal });
  const pending = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  assert.equal(seen.sent, 1);
  attempt.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(seen.records.map((r) => r.cls), ['timeout']);
  assert.equal(pool.inFlight('p'), 0);
  assert.equal(pool.availability('p/m1').available, true, 'the session decides timeout or held');
});

test('MP-18 attempt timeout after headers (stall) records timeout on the body and frees the slot', async () => {
  const { pool, stub } = setup();
  stub.handler = (call) => controlled(call.signal).response;
  const attempt = new AbortController();
  const { fetch, seen } = poolFetch(pool, { attemptSignal: attempt.signal });
  const response = await fetch('http://127.0.0.1:9000/p', PI_INIT);
  attempt.abort();
  await assert.rejects(response.text());
  assert.deepEqual(seen.records.map((r) => [r.cls, r.hadOutput]), [['ok', false], ['timeout', false]]);
  assert.equal(pool.inFlight('p'), 0);
});

test('MP-18 user stop wins over the attempt timer firing at the same time', async () => {
  const { pool, stub } = setup();
  stub.handler = hang;
  const stop = new AbortController();
  const attempt = new AbortController();
  const { fetch, seen } = poolFetch(pool, { signal: stop.signal, attemptSignal: attempt.signal });
  const pending = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  stop.abort();
  attempt.abort();
  await assert.rejects(pending);
  assert.deepEqual(seen.records.map((r) => r.cls), ['aborted']);
});

test('MP-18 a held model is not sent to until held expires; a timeout model likewise', async () => {
  const { pool, stub, timers } = setup();
  pool.markModel('p/m1', 'held', timers.now() + 120_000);
  const { fetch, seen } = poolFetch(pool);
  await assert.rejects(fetch('http://127.0.0.1:9000/p', PI_INIT), (e) => e.reason === 'held');
  assert.deepEqual(seen.records.map((r) => r.cls), ['timeout']);
  assert.equal(pool.availability('p/m2').available, true);
  await timers.advance(119_999);
  assert.equal(pool.availability('p/m1').reason, 'held');
  await timers.advance(1);
  assert.equal(pool.availability('p/m1').available, true);
  pool.markModel('p/m1', 'timeout', timers.now() + 60_000);
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'timeout', until: timers.now() + 60_000 });
  await timers.advance(60_000);
  assert.equal(pool.availability('p/m1').available, true);
  assert.equal(stub.calls.length, 0);
});

test('MP-18 a queued request for a model that becomes held fails at once', async () => {
  const { pool, stub, timers } = setup({ concurrency: 1 });
  await occupy(pool, stub);
  const { fetch, seen } = poolFetch(pool, { cls: 'background' });
  const queued = fetch('http://127.0.0.1:9000/p', PI_INIT);
  await flush();
  pool.markModel('p/m1', 'held', timers.now() + 1000);
  await assert.rejects(queued, (e) => e instanceof ModelUnavailableError && e.reason === 'held');
  assert.equal(pool.queued('p'), 0);
  assert.deepEqual(seen.records.map((r) => r.cls), ['timeout']);
});

// ---- 评审修正：换 key 的上限、槽位不泄漏、删除提供商、地址与 key、过时的结果、恢复定时器 ----

/** 提供商 p 保存的地址下的请求地址。 */
const P_URL = 'http://127.0.0.1:9000/p/chat/completions';

test('MP-29 a 429 with Retry-After: 0 on the only key is sent once, cools the key 30 s and goes back', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1'] });
  stub.handler = () => new Response('limited', { status: 429, headers: { 'retry-after': '0' } });
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch(P_URL, PI_INIT);
  assert.equal(response.status, 429);
  assert.equal(stub.calls.length, 1);
  assert.equal(seen.sent, 1);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.keyRef, r.retryAfterMs]), [['rate_limited', 'p#1', 0]]);
  assert.deepEqual(pool.keyStatus(), { 'p#1': { state: 'rate_limited', until: timers.now() + 30_000 } });
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'rate_limited',
    until: timers.now() + 30_000 });
});

test('MP-04 keys whose short Retry-After ends during the call are not used again in it', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1', 'p#2'] });
  stub.handler = async () => {
    await timers.advance(5);
    return new Response('limited', { status: 429, headers: { 'retry-after-ms': '1' } });
  };
  const { fetch, seen } = poolFetch(pool);
  const response = await fetch(P_URL, PI_INIT);
  assert.equal(response.status, 429);
  assert.deepEqual(stub.calls.map((c) => c.headers.get('authorization')), ['Bearer secret-p#1', 'Bearer secret-p#2']);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.keyRef]), [['rate_limited', 'p#1'], ['rate_limited', 'p#2']]);
  assert.equal(pool.inFlight('p'), 0);
});

test('MP-31 a key that cannot be written into a header fails unsent, frees the slot and is not quoted', async () => {
  const { pool, stub, logs } = setup({ keys: ['p#1'], concurrency: 1 });
  for (const secret of ['sk-line\nbreak-SECRET', 'sk-zero​width-SECRET', 'sk-Ａ-SECRET']) {
    pool.setKeys('p', [{ ref: 'p#1', secret }]);
    const { fetch, seen } = poolFetch(pool);
    await assert.rejects(fetch(P_URL, PI_INIT),
      (error) => /cannot be sent in a header/.test(error.message) && !error.message.includes('SECRET'));
    assert.equal(pool.inFlight('p'), 0);
    assert.equal(pool.queued('p'), 0);
    assert.equal(seen.sent, 0);
    assert.deepEqual(seen.records.map((r) => [r.cls, r.keyRef, r.sentAt]), [['request', 'p#1', null]]);
  }
  assert.equal(stub.calls.length, 0);
  assert.ok(logs.every((line) => !line.includes('SECRET')), logs.join('\n'));
});

test('MP-19 a request queued on a provider that is then deleted fails at once and is never sent', async () => {
  const { pool, stub, timers } = setup({ concurrency: 1 });
  await occupy(pool, stub);
  const { fetch, seen } = poolFetch(pool);
  const pending = fetch(P_URL, PI_INIT);
  await flush();
  assert.equal(pool.queued('p'), 1);
  pool.setProviders([]);
  await assert.rejects(pending, /p\/m1 was removed from your model settings/);
  assert.equal(pool.queued('p'), 0);
  assert.deepEqual(seen.queue.map((n) => n.active), [true, false]);
  await timers.advance(60_000);
  assert.equal(stub.calls.length, 1);
  assert.equal(seen.sent, 0);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.sentAt]), [['request', null]]);
});

test('MP-24 a key is never sent to an origin other than its provider\'s saved address', async () => {
  const { pool, stub, logs } = setup({ keys: ['p#1'] });
  const { fetch, seen } = poolFetch(pool);
  await assert.rejects(fetch('http://127.0.0.1:9100/p/chat/completions', PI_INIT), /base URL of p changed/);
  assert.equal(stub.calls.length, 0);
  assert.equal(pool.inFlight('p'), 0);
  assert.deepEqual(seen.records.map((r) => [r.cls, r.keyRef, r.sentAt]), [['request', 'p#1', null]]);
  assert.ok(logs.every((line) => !line.includes('secret-p#1')));
  assert.equal((await poolFetch(pool).fetch(P_URL, PI_INIT)).status, 200, 'same origin, other path is fine');
});

test('MP-24 a request built for the old address does not get a key added for the new address', async () => {
  const { pool, stub, config } = setup({ keys: [], concurrency: 1 });
  await occupy(pool, stub);
  const pending = poolFetch(pool).fetch(P_URL, PI_INIT);
  await flush();
  pool.setProviders([{ ...config, baseUrl: 'http://127.0.0.1:9100/p', keys: [{ ref: 'p#2', label: 'Key 2' }] }]);
  pool.setKeys('p', [{ ref: 'p#2', secret: 'secret-p#2' }]);
  await assert.rejects(pending, /base URL of p changed/);
  assert.equal(stub.calls.length, 1);
  assert.ok(stub.calls.every((c) => c.headers.get('authorization') === null));
});

test('MP-29 a 404 that arrives after the address was fixed does not mark the model', async () => {
  const { pool, stub, config } = setup();
  let answer;
  stub.handler = () => new Promise((resolve) => { answer = resolve; });
  const pending = poolFetch(pool).fetch(P_URL, PI_INIT);
  await flush();
  pool.setProviders([{ ...config, baseUrl: 'http://127.0.0.1:9000/v2' }]);
  answer(new Response('no such model', { status: 404 }));
  assert.equal((await pending).status, 404);
  assert.equal(pool.availability('p/m1').available, true);
});

test('MP-29 a 401 on a key removed while its request ran leaves no record for that key', async () => {
  const { pool, stub } = setup({ keys: ['p#1', 'p#2'] });
  let answer;
  stub.handler = (_call, n) => (n === 1 ? new Promise((resolve) => { answer = resolve; }) : new Response('ok'));
  const pending = poolFetch(pool).fetch(P_URL, PI_INIT);
  await flush();
  pool.setKeys('p', [{ ref: 'p#2', secret: 'secret-p#2' }]);
  answer(new Response('no', { status: 401 }));
  assert.equal((await pending).status, 200);
  assert.equal(stub.calls[1].headers.get('authorization'), 'Bearer secret-p#2');
  assert.deepEqual(pool.keyStatus(), {});
});

test('MP-29 a recovery timer that fires a little early still reports the key recovered', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1'] });
  const statuses = [];
  pool.onKeyStatus((status) => statuses.push(status));
  const original = timers.setTimeout;
  let early = true;
  timers.setTimeout = (callback, ms) => {
    const delay = early ? ms - 1 : ms;
    early = false;
    return original(callback, delay);
  };
  stub.handler = () => new Response('limited', { status: 429, headers: { 'retry-after': '7' } });
  await (await poolFetch(pool).fetch(P_URL, PI_INIT)).text();
  assert.equal(statuses.length, 1);
  await timers.advance(6_999);
  assert.equal(statuses.length, 1);
  await timers.advance(1);
  assert.deepEqual(statuses.at(-1), {});
});

// ---- MP-41 测试连接总是发出（§8.3 的 2026-10-26 补） ----

/** 测试连接用的 fetch 选项（config.ts testConnection：conversation 类别、不原地重试、不看记录） */
const TEST_OPTIONS = { sessionKey: 'connection test', serverRetries: false, ignoreRecords: true };
/** @brief 一次调用的认证头。 */
const authOf = (call) => call.headers.get('authorization');

test('MP-41 after a 404 a test is still sent and gets the 404 again; a session request is not', async () => {
  const { pool, stub } = setup();
  stub.handler = () => new Response('no such model', { status: 404 });
  assert.equal((await poolFetch(pool, TEST_OPTIONS).fetch(P_URL, PI_INIT)).status, 404);
  assert.deepEqual(pool.availability('p/m1'), { available: false, reason: 'not_found', until: null });
  const again = poolFetch(pool, TEST_OPTIONS);
  assert.equal((await again.fetch(P_URL, PI_INIT)).status, 404);
  assert.equal(stub.calls.length, 2, 'the second test reached the server');
  assert.deepEqual(again.seen.records.map((r) => r.cls), ['not_found']);
  await assert.rejects(poolFetch(pool).fetch(P_URL, PI_INIT), (e) => e instanceof ModelUnavailableError);
  assert.equal(stub.calls.length, 2, 'a session request is still held back by the record');
});

test('MP-41 after a 401 on the only key the next test is still sent with that key', async () => {
  const { pool, stub } = setup({ keys: ['p#1'] });
  stub.handler = () => new Response('bad key', { status: 401 });
  assert.equal((await poolFetch(pool, TEST_OPTIONS).fetch(P_URL, PI_INIT)).status, 401);
  assert.deepEqual(pool.keyStatus(), { 'p#1': { state: 'auth', until: null } });
  const again = poolFetch(pool, TEST_OPTIONS);
  assert.equal((await again.fetch(P_URL, PI_INIT)).status, 401);
  assert.deepEqual(stub.calls.map(authOf), ['Bearer secret-p#1', 'Bearer secret-p#1']);
  assert.deepEqual(again.seen.records.map((r) => [r.cls, r.keyRef]), [['auth', 'p#1']]);
});

test('MP-41 a test uses the first key without a record, and the first key when every key has one', async () => {
  const { pool, stub } = setup({ keys: ['p#1', 'p#2', 'p#3'] });
  stub.handler = (call) => new Response('x', { status: authOf(call).endsWith('#3') ? 200 : 429,
    headers: { 'retry-after': '60' } });
  await (await poolFetch(pool).fetch(P_URL, PI_INIT)).text();
  assert.deepEqual(Object.keys(pool.keyStatus()).sort(), ['p#1', 'p#2']);
  stub.calls.length = 0;
  stub.handler = (call) => new Response('x', { status: authOf(call).endsWith('#3') ? 401 : 200 });
  // p#3 is the only key without a record: the test uses it; after its 401 no key without a record is left to rotate to
  assert.equal((await poolFetch(pool, TEST_OPTIONS).fetch(P_URL, PI_INIT)).status, 401);
  assert.deepEqual(stub.calls.map(authOf), ['Bearer secret-p#3']);
  assert.equal(pool.availability('p/m1').available, false);
  stub.calls.length = 0;
  await (await poolFetch(pool, TEST_OPTIONS).fetch(P_URL, PI_INIT)).text();
  assert.deepEqual(stub.calls.map(authOf), ['Bearer secret-p#1'], 'every key has a record: the first key');
});

test('MP-41 a test still rotates past a 401 to the next key without a record, skipping keys that have one',
  async () => {
    const { pool, stub } = setup({ keys: ['p#1', 'p#2', 'p#3'] });
    stub.handler = () => new Response('x', { status: 429, headers: { 'retry-after': '60' } });
    await poolFetch(pool, { keyRef: 'p#2' }).fetch(P_URL, PI_INIT);
    assert.deepEqual(Object.keys(pool.keyStatus()), ['p#2']);
    stub.calls.length = 0;
    stub.handler = (call) => new Response('x', { status: authOf(call).endsWith('#1') ? 401 : 200 });
    const response = await poolFetch(pool, TEST_OPTIONS).fetch(P_URL, PI_INIT);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(stub.calls.map(authOf), ['Bearer secret-p#1', 'Bearer secret-p#3']);
  });

test('MP-41 a test is sent while the provider is in connection and the model is in timeout or held', async () => {
  const { pool, stub, timers } = setup();
  const send = async () => {
    const response = await poolFetch(pool, TEST_OPTIONS).fetch(P_URL, PI_INIT);
    await response.text();
    return response.status;
  };
  pool.markProvider('p', 'connection', timers.now() + 30_000);
  assert.equal(await send(), 200);
  pool.markModel('p/m1', 'held', timers.now() + 120_000);
  assert.equal(await send(), 200);
  pool.markModel('p/m1', 'timeout', timers.now() + 60_000);
  assert.equal(await send(), 200);
  assert.equal(stub.calls.length, 3);
  await assert.rejects(poolFetch(pool).fetch(P_URL, PI_INIT), (e) => e instanceof ModelUnavailableError);
  assert.equal(stub.calls.length, 3, 'a session request is still held back');
});

test('MP-41 a keyless provider: a test is sent although its pseudo key is in auth', async () => {
  const { pool, stub } = setup({ keys: [] });
  stub.handler = () => new Response('no', { status: 401 });
  await poolFetch(pool).fetch(P_URL, PI_INIT);
  assert.equal(pool.availability('p/m1').reason, 'auth');
  stub.handler = () => new Response('ok');
  const response = await poolFetch(pool, TEST_OPTIONS).fetch(P_URL, PI_INIT);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(stub.calls.length, 2);
  assert.equal(authOf(stub.calls[1]), null);
});

test('MP-41 after a successful test clearAfterTest clears the key record, the provider connection and the '
  + 'model not_found, and keeps held', async () => {
  const { pool, stub, timers } = setup({ keys: ['p#1'] });
  stub.handler = () => new Response('no such model', { status: 404 });
  await poolFetch(pool).fetch(P_URL, PI_INIT);
  stub.handler = () => new Response('bad', { status: 401 });
  await poolFetch(pool, { ...TEST_OPTIONS, ref: 'p/m2' }).fetch(P_URL, PI_INIT);
  pool.markProvider('p', 'connection', timers.now() + 30_000);
  pool.clearAfterTest('p/m1', 'p#1');
  assert.deepEqual(pool.keyStatus(), {});
  assert.equal(pool.availability('p/m1').available, true);
  assert.equal(pool.availability('p/m2').available, true);
  pool.markModel('p/m2', 'held', timers.now() + 120_000);
  pool.clearAfterTest('p/m2', 'p#1');
  assert.equal(pool.availability('p/m2').reason, 'held');
});
