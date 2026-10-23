// 发现命令的单元测试（docs/specs/model-discovery.md §13.2 MD-06，单元层）：服务原文里的 key 换成 ***（§5.1、§9：
// listError.detail、重定向的 Location、连接错误、日志，A6），先换再截到 2000 字（§11）；跨 origin 的重定向不跟随，
// 按 invalid（§9，D5）。替身 fetch 与服务原文都是 synthetic；key 是测试用的假值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  SECRET, captureConsole, connectionFailure, empty, existing, json, newRequest, providerRequest, readerWith,
  stubFetch,
} from './io-helpers.mjs';

const { DiscoverReader, DETAIL_MAX_CHARS } = await loadKernelModule('src/kernel/modelDiscover.ts');

/** 已有提供商的地址（synthetic，RFC 5737 文档地址）：§3.2 只试 <baseUrl>/models。 */
const BASE = 'http://192.0.2.50:8000/v1';

/** @brief 结果与日志里都没有 key，也没有 key 的前 8 个字符（截断后剩下的一截同样算泄露）。 */
function assertNoKey(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(SECRET.slice(0, 8)), `${label} must not contain the key: ${text.slice(0, 300)}`);
}

test('MD-06 a 401 body that echoes the key: listError.detail has *** and the request still sent the key', async (t) => {
  const lines = captureConsole(t);
  const body = { error: { message: `Incorrect API key provided: ${SECRET}.`, type: 'invalid_request_error' } };
  const stub = stubFetch(() => json(body, { status: 401 }));
  const result = await readerWith(DiscoverReader, stub.fetch).command(providerRequest(BASE, { secret: SECRET }));
  assert.equal(result.listError.kind, 'rejected');
  assert.equal(result.listError.detail, JSON.stringify(body).split(SECRET).join('***'));
  assert.equal(stub.calls.length, 1, '401 stops at once (§3.2)');
  assert.equal(stub.calls[0].headers.authorization, `Bearer ${SECRET}`);
  assertNoKey(result, 'the result');
  assertNoKey(lines, 'the log');
  assert.ok(lines.some((line) => line.includes('listError=rejected') && line.includes('***')), lines.join('\n'));
});

test('MD-06 a 5xx body with the key is invalid with *** in the detail; new providers too', async (t) => {
  const lines = captureConsole(t);
  const stub = stubFetch(() => new Response(`upstream rejected key=${SECRET} (bad gateway)`, { status: 502 }));
  const reader = readerWith(DiscoverReader, stub.fetch);
  const old = await reader.command(providerRequest(BASE, { secret: SECRET }));
  assert.deepEqual(old.listError, { kind: 'invalid', detail: 'upstream rejected key=*** (bad gateway)' });
  // 新提供商：① <base>/models、② <base>/v1/models 都回 502，最后一次决定 listError（D5）
  const fresh = await reader.command(newRequest('http://192.0.2.51:8000', { secret: SECRET }));
  assert.deepEqual(fresh.listError, { kind: 'invalid', detail: 'upstream rejected key=*** (bad gateway)' });
  assert.deepEqual(stub.calls.slice(1).map((call) => call.url),
    ['http://192.0.2.51:8000/models', 'http://192.0.2.51:8000/v1/models']);
  assertNoKey([old, fresh], 'the results');
  assertNoKey(lines, 'the log');
});

test('MD-06 the key is replaced before the 2000-character cap, so no part of it survives the cut', async (t) => {
  captureConsole(t);
  const text = `${'x'.repeat(DETAIL_MAX_CHARS - 5)}${SECRET}${'y'.repeat(100)}`;
  const stub = stubFetch(() => new Response(text, { status: 403 }));
  const result = await readerWith(DiscoverReader, stub.fetch).command(providerRequest(BASE, { secret: SECRET }));
  assert.equal(DETAIL_MAX_CHARS, 2000);
  assert.equal(result.listError.kind, 'rejected');
  assert.equal(result.listError.detail, `${'x'.repeat(DETAIL_MAX_CHARS - 5)}***yy`);
  assert.equal(result.listError.detail.length, DETAIL_MAX_CHARS);
  assertNoKey(result, 'the result');
  // 没有 key 的长原文同样只留 2000 字
  const long = stubFetch(() => new Response('z'.repeat(5000), { status: 500 }));
  const plain = await readerWith(DiscoverReader, long.fetch).command(providerRequest(BASE));
  assert.equal(plain.listError.detail, 'z'.repeat(DETAIL_MAX_CHARS));
});

test('MD-06 a cross-origin redirect is invalid "Redirected to <location>", not followed, key in it hidden',
  async (t) => {
    const lines = captureConsole(t);
    const location = `https://login.example.test/sso?api_key=${SECRET}`;
    const stub = stubFetch(() => new Response(null, { status: 302, headers: { location } }));
    const result = await readerWith(DiscoverReader, stub.fetch).command(providerRequest(BASE, { secret: SECRET }));
    assert.deepEqual(result.listError,
      { kind: 'invalid', detail: 'Redirected to https://login.example.test/sso?api_key=***' });
    assert.deepEqual(stub.calls.map((call) => call.url), [`${BASE}/models`]);
    assert.equal(stub.calls[0].redirect, 'manual');
    assert.ok(!stub.calls.some((call) => call.origin === 'https://login.example.test'), 'the redirect is not followed');
    assertNoKey(result, 'the result');
    assertNoKey(lines, 'the log');
  });

test('MD-06 a 3xx is not followed for a new provider either: the next list address is tried (D5)', async (t) => {
  captureConsole(t);
  const stub = stubFetch((call) => {
    const moved = { status: 301, headers: { location: 'https://cdn.test/m' } };
    return call.path === '/models' ? new Response(null, moved) : empty(404);
  });
  const result = await readerWith(DiscoverReader, stub.fetch).command(newRequest('http://192.0.2.52:8000'));
  assert.deepEqual(stub.calls.map((call) => call.url),
    ['http://192.0.2.52:8000/models', 'http://192.0.2.52:8000/v1/models']);
  assert.ok(stub.calls.every((call) => call.redirect === 'manual'));
  assert.deepEqual(result.listError, { kind: 'no_list', detail: '' }, 'the last attempt (404) decides');
  // ② 也是重定向时最后一次为 invalid，detail 为它的 Location
  const both = stubFetch(() => new Response(null, { status: 307, headers: { location: 'https://cdn.test/v1' } }));
  const second = await readerWith(DiscoverReader, both.fetch).command(newRequest('http://192.0.2.53:8000'));
  assert.deepEqual(second.listError, { kind: 'invalid', detail: 'Redirected to https://cdn.test/v1' });
  assert.equal(both.calls.length, 2);
});

/**
 * @brief 列表按 rows 回答，keep 里的路径按 bodies 回答，其余（第 6 步、版本、详情）都是跨 origin 的 302（synthetic）。
 * @param rows 列表行
 * @param bodies 路径 → JSON（不重定向的路径）
 */
function redirectingFetch(rows, bodies = {}) {
  return stubFetch((call) => {
    if (call.path === '/v1/models') return json({ object: 'list', data: rows });
    if (call.path in bodies) return json(bodies[call.path]);
    return new Response(null, { status: 302, headers: { location: 'http://elsewhere.test/x' } });
  });
}

/** @brief 每个请求都是 redirect: manual、都在 BASE 的 origin 上，没有跟到 elsewhere.test。 */
function assertManualSameOrigin(stub, label) {
  const sent = JSON.stringify(stub.calls.map((call) => `${call.method} ${call.url}`));
  assert.ok(stub.calls.every((call) => call.redirect === 'manual'), `${label}: ${sent}`);
  assert.ok(stub.calls.every((call) => call.origin === 'http://192.0.2.50:8000'), `${label}: ${sent}`);
}

test('MD-06 every request (list, step 6, version, details) uses redirect: manual and stays on the origin',
  async (t) => {
    captureConsole(t);
    const paths = (stub) => stub.calls.map((call) => `${call.method} ${call.path}`);
    // 第 1–5 步认不出：第 6 步的五个 GET 都回 302，种类为 unknown
    const probe = redirectingFetch([{ id: 'm', object: 'model' }]);
    const unknown = await readerWith(DiscoverReader, probe.fetch).command(providerRequest(BASE));
    assert.equal(unknown.server.kind, 'unknown', 'step 6 answers that redirect decide nothing');
    assert.deepEqual(paths(probe).sort(), ['GET /.well-known/localai.json', 'GET /api/v1/models', 'GET /api/version',
      'GET /info', 'GET /props', 'GET /v1/models']);
    assertManualSameOrigin(probe, 'step 6');
    // SGLang：版本请求 /version 与详情 /model_info 都回 302，命令、第 0 步与读版本照样不跟随
    const sglang = redirectingFetch([{ id: 'q', object: 'model', owned_by: 'sglang', max_model_len: 4096 }]);
    const reader = readerWith(DiscoverReader, sglang.fetch);
    const listed = await reader.command(providerRequest(BASE));
    assert.deepEqual(listed.server, { kind: 'sglang', version: null }, 'a redirected /version gives no version');
    assert.equal(listed.models[0].contextWindow, 4096, 'a redirected detail only drops that detail');
    await reader.single(existing(BASE), 'q', new AbortController().signal);
    await reader.version(existing(BASE), new AbortController().signal);
    assert.deepEqual(paths(sglang), ['GET /v1/models', 'GET /version', 'GET /model_info', 'GET /v1/models',
      'GET /version', 'GET /model_info', 'GET /v1/models', 'GET /version']);
    assertManualSameOrigin(sglang, 'version and details');
    // Ollama：/api/tags、/api/ps 与 POST /api/show 都回 302
    const ollamaRows = [{ id: 'o', object: 'model', created: 1790000000, owned_by: 'library' }];
    const ollama = redirectingFetch(ollamaRows, { '/api/version': { version: '0.9.0' } });
    const local = await readerWith(DiscoverReader, ollama.fetch).command(providerRequest(BASE));
    assert.deepEqual(local.server, { kind: 'ollama', version: '0.9.0' });
    for (const detail of ['GET /api/tags', 'GET /api/ps', 'POST /api/show']) {
      assert.ok(paths(ollama).includes(detail), detail);
    }
    assertManualSameOrigin(ollama, 'Ollama details');
  });

test('MD-06 connection errors become unreachable with the cause text, key hidden; inner errors joined (A14)',
  async (t) => {
    const lines = captureConsole(t);
    const refused = stubFetch(() => {
      throw connectionFailure(`connect ECONNREFUSED 192.0.2.50:8000 while sending ${SECRET}`);
    });
    const result = await readerWith(DiscoverReader, refused.fetch).command(providerRequest(BASE, { secret: SECRET }));
    assert.deepEqual(result.listError,
      { kind: 'unreachable', detail: 'connect ECONNREFUSED 192.0.2.50:8000 while sending ***' });
    assert.equal(result.server, null);
    const cause = Object.assign(new Error(''), { errors: [new Error('connect ECONNREFUSED ::1:8000'),
      new Error('connect ECONNREFUSED 127.0.0.1:8000')] });
    const both = stubFetch(() => {
      throw new TypeError('fetch failed', { cause });
    });
    const joined = await readerWith(DiscoverReader, both.fetch).command(providerRequest('http://localhost:8000/v1'));
    assert.equal(joined.listError.detail, 'connect ECONNREFUSED ::1:8000; connect ECONNREFUSED 127.0.0.1:8000');
    assertNoKey(lines, 'the log');
  });

test('MD-06 logs never contain the key: failed detail URLs are hidden while parsed ids stay as listed (A6)',
  async (t) => {
    const lines = captureConsole(t);
    // MindIE 按 id 读 /v2/models/<id>/config（§4.2）：id 里有 key 时，失败日志里的地址也要换成 ***
    const stub = stubFetch((call) => {
      if (call.path === '/v1/models') {
        return json({ object: 'list', data: [{ id: `tenant-${SECRET}`, object: 'model', owned_by: 'MindIE Server' }] });
      }
      return new Response(`no such model ${SECRET}`, { status: 500 });
    });
    const result = await readerWith(DiscoverReader, stub.fetch).command(providerRequest(BASE, { secret: SECRET }));
    assert.equal(result.server.kind, 'mindie');
    assert.equal(result.models[0].id, `tenant-${SECRET}`, 'parsed values are not rewritten (A6)');
    assert.ok(stub.calls.some((call) => call.path === `/v2/models/tenant-${SECRET}/config`));
    const failed = lines.filter((line) => line.includes('detail request'));
    assert.equal(failed.length, 1, lines.join('\n'));
    assert.match(failed[0], /\/v2\/models\/tenant-\*\*\*\/config failed: HTTP 500/);
    assertNoKey(lines, 'the log');
  });

test('MD-06 probe step 0 and version reads hide the key in their own log lines too', async (t) => {
  const lines = captureConsole(t);
  const stub = stubFetch(() => new Response(`key ${SECRET} is disabled`, { status: 401 }));
  const reader = readerWith(DiscoverReader, stub.fetch);
  const target = existing(BASE, { secret: SECRET, shareKey: `${BASE}|openai-completions|p#1` });
  const read = await reader.single(target, 'm', new AbortController().signal);
  assert.equal(read.kind, 'unknown');
  const version = await reader.version(target, new AbortController().signal);
  assert.equal(version.listed, false);
  assert.ok(lines.some((line) => line.includes('probe step 0 listError=rejected') && line.includes('***')));
  assert.ok(lines.some((line) => line.includes('version read listError=rejected') && line.includes('***')));
  assertNoKey(lines, 'the log');
});
