// kernel/modelFailure.ts 的单元测试：§5.4 的失败分类（含三种 Retry-After 写法与额度关键词）、
// §8.3 的不可用记录、恢复与配置改变时的清除、§5.7 超时后的记录。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, loadKernelModule } from './load.mjs';

const failure = await loadKernelModule('src/kernel/modelFailure.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');
const {
  classifyResponse, classifyThrown, parseRetryAfter, hasQuotaKeyword, isNetworkError, failureEffect, timeoutEffect,
  isRecordActive, earliestRecovery, providerChange, clearedByEndpointChange,
} = failure;

/** 分类一个响应（synthetic 响应头）。 */
function classify(status, { headers = {}, body = '', now = 1_000_000 } = {}) {
  return classifyResponse({ status, headers: new Headers(headers), body, now });
}

/** 带 code 的网络错误，放在 TypeError('fetch failed') 的 cause 上，与 Node fetch 的形状相同。 */
function fetchFailed(code) {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError('fetch failed', { cause });
}

/** §4.1 形状的提供商（synthetic）。 */
function provider(overrides = {}) {
  return {
    id: 'p', name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000/v1', zone: 'local',
    compat: { supportsStore: false }, concurrency: 4, keys: [], nextKeyNumber: 1,
    models: [
      { id: 'a', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] },
      { id: 'b', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] },
    ],
    ...overrides,
  };
}

test('MP-28 HTTP 429 is rate_limited with Retry-After in seconds', () => {
  assert.deepEqual(classify(429, { headers: { 'Retry-After': '7' } }), { cls: 'rate_limited', retryAfterMs: 7000 });
  assert.deepEqual(classify(429, { headers: { 'retry-after': '1.5' } }), { cls: 'rate_limited', retryAfterMs: 1500 });
});

test('MP-28 Retry-After as an HTTP date counts from now; a past date gives 0', () => {
  const clock = fakeClock(Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'));
  const later = { 'Retry-After': 'Wed, 21 Oct 2026 07:28:12 GMT' };
  assert.equal(parseRetryAfter(new Headers(later), clock.now()), 12_000);
  assert.deepEqual(classify(429, { headers: later, now: clock.now() }), { cls: 'rate_limited', retryAfterMs: 12_000 });
  const past = { 'Retry-After': 'Wed, 21 Oct 2026 07:27:00 GMT' };
  assert.equal(parseRetryAfter(new Headers(past), clock.now()), 0);
});

test('MP-28 retry-after-ms is used and wins over Retry-After', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }), 0), 250);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }), 0), 250);
  assert.deepEqual(classify(429, { headers: { 'retry-after-ms': '800' } }), { cls: 'rate_limited', retryAfterMs: 800 });
});

test('MP-28 missing or unreadable Retry-After gives null', () => {
  assert.equal(parseRetryAfter(new Headers(), 0), null);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': 'soon' }), 0), null);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after-ms': 'x', 'retry-after': '-3' }), 0), null);
  assert.deepEqual(classify(429), { cls: 'rate_limited', retryAfterMs: null });
});

test('MP-28 HTTP 401 and 403 are auth', () => {
  assert.equal(classify(401).cls, 'auth');
  assert.equal(classify(403, { body: '{"error":"forbidden"}' }).cls, 'auth');
});

test('MP-28 HTTP 402 is quota even without keywords', () => {
  assert.equal(classify(402).cls, 'quota');
  assert.equal(classify(402, { body: 'payment required' }).cls, 'quota');
});

test('MP-28 400, 403 and 429 with a quota keyword are quota, case-insensitive', () => {
  for (const word of ['insufficient_quota', 'Quota', 'BILLING', 'Balance']) {
    for (const status of [400, 403, 429]) {
      assert.equal(classify(status, { body: `{"error":{"code":"x","message":"${word} problem"}}` }).cls, 'quota',
        `${status} ${word}`);
    }
  }
  assert.equal(hasQuotaKeyword('Your account BALANCE is too low'), true);
  assert.equal(hasQuotaKeyword('bad request'), false);
});

test('MP-28 quota keywords only count for 400, 403 and 429', () => {
  assert.equal(classify(401, { body: 'insufficient_quota' }).cls, 'auth');
  assert.equal(classify(404, { body: 'quota' }).cls, 'not_found');
  assert.equal(classify(500, { body: 'billing backend down' }).cls, 'server');
  assert.equal(classify(422, { body: 'balance' }).cls, 'request');
});

test('MP-28 HTTP 404 is not_found', () => {
  assert.equal(classify(404).cls, 'not_found');
});

test('MP-28 HTTP 500, 502, 503 and 504 are server', () => {
  for (const status of [500, 502, 503, 504]) assert.equal(classify(status).cls, 'server', String(status));
});

test('MP-28 other 4xx are request; unlisted 5xx end the reply as request', () => {
  for (const status of [400, 405, 409, 413, 422]) assert.equal(classify(status).cls, 'request', String(status));
  for (const status of [501, 505]) assert.equal(classify(status).cls, 'request', String(status));
});

test('MP-28 2xx is ok and keeps any Retry-After', () => {
  assert.deepEqual(classify(200), { cls: 'ok', retryAfterMs: null });
  assert.deepEqual(classify(200, { headers: { 'retry-after': '1' } }), { cls: 'ok', retryAfterMs: 1000 });
});

test('MP-28 network errors before the response are connection', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'UND_ERR_SOCKET']) {
    const facts = { error: fetchFailed(code), userAborted: false, attemptAborted: false, afterHeaders: false };
    assert.deepEqual(classifyThrown(facts), { cls: 'connection', retryAfterMs: null }, code);
  }
  assert.equal(isNetworkError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isNetworkError(new TypeError('fetch failed')), true);
});

test('MP-28 a non-network error before the response is request', () => {
  const error = new TypeError('Failed to parse URL from not a url');
  assert.equal(isNetworkError(error), false);
  const facts = { error, userAborted: false, attemptAborted: false, afterHeaders: false };
  assert.equal(classifyThrown(facts).cls, 'request');
});

test('MP-28 user stop is aborted, also when the attempt timer fired too', () => {
  const error = new DOMException('This operation was aborted', 'AbortError');
  assert.equal(classifyThrown({ error, userAborted: true, attemptAborted: false, afterHeaders: false }).cls, 'aborted');
  assert.equal(classifyThrown({ error, userAborted: true, attemptAborted: true, afterHeaders: true }).cls, 'aborted');
});

test('MP-28 attempt timeout is timeout before and after headers', () => {
  const error = new DOMException('This operation was aborted', 'AbortError');
  assert.equal(classifyThrown({ error, userAborted: false, attemptAborted: true, afterHeaders: false }).cls, 'timeout');
  assert.equal(classifyThrown({ error, userAborted: false, attemptAborted: true, afterHeaders: true }).cls, 'timeout');
});

test('MP-28 a break after headers is partial, even when the cause is a network code', () => {
  const facts = { error: fetchFailed('ECONNRESET'), userAborted: false, attemptAborted: false, afterHeaders: true };
  assert.deepEqual(classifyThrown(facts), { cls: 'partial', retryAfterMs: null });
});

test('MP-29 rate_limited cools the key until Retry-After, or 30 s without it', () => {
  const now = 5_000;
  assert.deepEqual(failureEffect({ cls: 'rate_limited', retryAfterMs: 7000 }, now, MODEL_TIMINGS),
    { scope: 'key', record: { state: 'rate_limited', until: 12_000 } });
  assert.deepEqual(failureEffect({ cls: 'rate_limited', retryAfterMs: null }, now, MODEL_TIMINGS),
    { scope: 'key', record: { state: 'rate_limited', until: now + 30_000 } });
});

test('MP-29 Retry-After of 0 or a past date cools the key for the 30 s default, never already expired', () => {
  const now = 5_000;
  const zero = failureEffect({ cls: 'rate_limited', retryAfterMs: 0 }, now, MODEL_TIMINGS);
  assert.deepEqual(zero, { scope: 'key', record: { state: 'rate_limited', until: now + 30_000 } });
  assert.equal(isRecordActive(zero.record, now), true);
  const later = Date.parse('2015-10-21T08:00:00Z');
  const past = classify(429, { headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, now: later });
  assert.equal(past.retryAfterMs, 0);
  assert.deepEqual(failureEffect(past, later, MODEL_TIMINGS).record,
    { state: 'rate_limited', until: later + 30_000 });
  assert.deepEqual(failureEffect({ cls: 'rate_limited', retryAfterMs: 1 }, now, MODEL_TIMINGS).record,
    { state: 'rate_limited', until: now + 1 });
});

test('MP-29 auth and quota mark the key without a recovery time', () => {
  assert.deepEqual(failureEffect({ cls: 'auth', retryAfterMs: null }, 0, MODEL_TIMINGS),
    { scope: 'key', record: { state: 'auth', until: null } });
  assert.deepEqual(failureEffect({ cls: 'quota', retryAfterMs: 5000 }, 0, MODEL_TIMINGS),
    { scope: 'key', record: { state: 'quota', until: null } });
});

test('MP-29 404 marks the model; connection marks the provider for 30 s', () => {
  assert.deepEqual(failureEffect({ cls: 'not_found', retryAfterMs: null }, 0, MODEL_TIMINGS),
    { scope: 'model', record: { state: 'not_found', until: null } });
  assert.deepEqual(failureEffect({ cls: 'connection', retryAfterMs: null }, 100, MODEL_TIMINGS),
    { scope: 'provider', record: { state: 'connection', until: 30_100 } });
});

test('MP-29 server, request, partial, timeout, queue_timeout, aborted and ok write no record', () => {
  for (const cls of ['server', 'request', 'partial', 'timeout', 'queue_timeout', 'aborted', 'ok']) {
    assert.equal(failureEffect({ cls, retryAfterMs: 1000 }, 0, MODEL_TIMINGS), null, cls);
  }
});

test('MP-18 timeout with cancel verified is unavailable for 60 s; otherwise held for 2 min', () => {
  assert.deepEqual(timeoutEffect(true, 1000, MODEL_TIMINGS),
    { scope: 'model', record: { state: 'timeout', until: 61_000 } });
  assert.deepEqual(timeoutEffect(false, 1000, MODEL_TIMINGS),
    { scope: 'model', record: { state: 'held', until: 121_000 } });
  assert.deepEqual(timeoutEffect('unknown', 1000, MODEL_TIMINGS),
    { scope: 'model', record: { state: 'held', until: 121_000 } });
});

test('MP-18 shortened timings flow through the effect helpers', () => {
  const timings = { ...MODEL_TIMINGS, timeoutCooldownMs: 10, heldMs: 20, rateLimitCooldownMs: 5,
    connectionCooldownMs: 7 };
  assert.equal(timeoutEffect(true, 0, timings).record.until, 10);
  assert.equal(timeoutEffect('unknown', 0, timings).record.until, 20);
  assert.equal(failureEffect({ cls: 'rate_limited', retryAfterMs: null }, 0, timings).record.until, 5);
  assert.equal(failureEffect({ cls: 'connection', retryAfterMs: null }, 0, timings).record.until, 7);
});

test('MP-29 timed records recover at their time; auth, quota and not_found never by time', () => {
  const clock = fakeClock(0);
  const limited = { state: 'rate_limited', until: 1000 };
  assert.equal(isRecordActive(limited, clock.now()), true);
  clock.set(999);
  assert.equal(isRecordActive(limited, clock.now()), true);
  clock.set(1000);
  assert.equal(isRecordActive(limited, clock.now()), false);
  clock.advance(10 ** 9);
  for (const state of ['auth', 'quota', 'not_found']) {
    assert.equal(isRecordActive({ state, until: null }, clock.now()), true, state);
  }
  assert.equal(isRecordActive(null, 0), false);
  assert.equal(isRecordActive(undefined, 0), false);
});

test('MP-29 earliest recovery picks the soonest time and puts permanent records last', () => {
  const auth = { state: 'auth', until: null };
  const soon = { state: 'rate_limited', until: 100 };
  const later = { state: 'connection', until: 200 };
  assert.equal(earliestRecovery([auth, later, soon]), soon);
  assert.equal(earliestRecovery([auth, { state: 'quota', until: null }]), auth);
  assert.equal(earliestRecovery([]), null);
  const tie = { state: 'timeout', until: 100 };
  assert.equal(earliestRecovery([soon, tie]), soon);
});

test('MP-29 address, API type and compat changes clear endpoint records', () => {
  const base = provider();
  assert.equal(providerChange(base, provider({ baseUrl: 'http://127.0.0.1:9001/v1' })).endpoint, true);
  assert.equal(providerChange(base, provider({ api: 'openai-responses' })).endpoint, true);
  assert.equal(providerChange(base, provider({ compat: { supportsStore: false, supportsDeveloperRole: false } }))
    .endpoint, true);
  assert.equal(providerChange(base, provider({ compat: {} })).endpoint, true);
});

test('MP-29 name, concurrency, zone, keys and model order changes clear nothing', () => {
  const base = provider();
  const next = provider({ name: 'Renamed', concurrency: 1, zone: 'public', keys: [{ ref: 'p#1', label: 'Key 1' }],
    nextKeyNumber: 2, models: [...base.models].reverse() });
  assert.deepEqual(providerChange(base, next), { endpoint: false, changedModels: [] });
  const reordered = provider({ compat: { supportsStore: false } });
  assert.equal(providerChange(base, reordered).endpoint, false);
});

test('MP-29 a changed or new model is listed for clearing its not_found', () => {
  const base = provider();
  const edited = provider({ models: [{ ...base.models[0], contextWindow: 2000 }, base.models[1],
    { id: 'c', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] }] });
  assert.deepEqual(providerChange(base, edited), { endpoint: false, changedModels: ['a', 'c'] });
});

test('MP-29 endpoint change clears auth, quota, connection and not_found, not timed model or key cooldowns', () => {
  for (const state of ['auth', 'quota', 'connection', 'not_found']) assert.equal(clearedByEndpointChange(state), true);
  for (const state of ['rate_limited', 'timeout', 'held']) assert.equal(clearedByEndpointChange(state), false);
});
