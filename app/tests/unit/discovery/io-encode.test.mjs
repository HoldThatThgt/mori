// 发现命令的单元测试（docs/specs/model-discovery.md §13.2 MD-06，单元层；审查 C14）：模型 id 放进详情地址时
// encodeURIComponent 会对含单独代理项的 id 抛错，这时只算这个模型的详情请求失败（§4.2：只用列表本身，记一行日志），
// 不让整次发现或探针第 0 步失败；MindIE（D15）与百炼单模型模式（D14）。列表与详情都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import { captureConsole, empty, existing, json, providerRequest, readerWith, stubFetch } from './io-helpers.mjs';

const { DiscoverReader } = await loadKernelModule('src/kernel/modelDiscover.ts');

/** 含单独代理项（U+D800）的 id：JSON 里写作 \ud800，解析后 encodeURIComponent 会抛 URIError。 */
const LONE = 'bad-\ud800-id';
const MINDIE = 'http://192.0.2.100:1025/v1';

/** @brief MindIE 的列表与 config（形状同 tests/fixtures/discovery/bodies/mindie-*.json）。 */
function mindieFetch() {
  return stubFetch((call) => {
    if (call.path === '/v1/models') {
      return json({ object: 'list', data: [LONE, 'llama3-70b'].map((id) => ({ id, object: 'model', created: 1,
        owned_by: 'MindIE Server' })) });
    }
    if (call.path === '/v2/models/llama3-70b/config') return json({ max_seq_len: 2560 });
    return empty(404);
  });
}

test('MD-06 a lone-surrogate id fails only its MindIE detail request; the other model keeps its config', async (t) => {
  const lines = captureConsole(t);
  assert.throws(() => encodeURIComponent(LONE), URIError);
  const stub = mindieFetch();
  const result = await readerWith(DiscoverReader, stub.fetch).command(providerRequest(MINDIE));
  assert.equal(result.error, null);
  assert.equal(result.listError, null);
  assert.equal(result.server.kind, 'mindie');
  assert.deepEqual(result.models.map((model) => model.id), [LONE, 'llama3-70b']);
  const [bad, good] = result.models;
  assert.equal(bad.contextWindow, 128000, 'its detail failed: the list alone gives no window');
  assert.equal(bad.reported.contextWindow, false);
  assert.equal(bad.unusable, null, 'the id itself is listed as the server gives it');
  assert.equal(good.contextWindow, 2560);
  assert.equal(good.reported.contextWindow, true);
  assert.deepEqual(stub.calls.filter((call) => call.path.startsWith('/v2/')).map((call) => call.path),
    ['/v2/models/llama3-70b/config'], 'no request is sent for the id that cannot be encoded');
  const failed = lines.filter((line) => line.includes('detail request for'));
  assert.equal(failed.length, 1, lines.join('\n'));
  assert.match(failed[0], /^error \[kernel\] discover detail request for ".*" failed: URI malformed$/);
});

test('MD-06 probe step 0 of a lone-surrogate MindIE id reads the kind and fails only its detail', async (t) => {
  const lines = captureConsole(t);
  const stub = mindieFetch();
  const reader = readerWith(DiscoverReader, stub.fetch);
  const read = await reader.single(existing(MINDIE), LONE, new AbortController().signal);
  assert.deepEqual(read, { kind: 'mindie', version: null, reported: null,
    meta: { maxTokens: null, reasoning: null, image: null } });
  assert.ok(!stub.calls.some((call) => call.path.startsWith('/v2/')));
  // 这一行在列表里、它的详情请求失败了（只记这一行），不是没找到这一行
  assert.equal(lines.filter((line) => line.includes('detail request for')).length, 1, lines.join('\n'));
  const good = await reader.single(existing(MINDIE), 'llama3-70b', new AbortController().signal);
  assert.equal(good.reported, 2560);
});

test('MD-06 DashScope step 0 of a lone-surrogate id skips its ?model= request and uses the list (D14)',
  async (t) => {
    const lines = captureConsole(t);
    const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const stub = stubFetch((call) => {
      if (call.path === '/compatible-mode/v1/models') {
        return json({ object: 'list', data: [{ id: LONE, object: 'model', owned_by: 'system' }] });
      }
      return empty(404);
    });
    const read = await readerWith(DiscoverReader, stub.fetch).single(existing(base), LONE,
      new AbortController().signal);
    assert.equal(read.kind, 'dashscope');
    assert.equal(read.reported, null);
    assert.deepEqual(stub.calls.map((call) => call.path), ['/compatible-mode/v1/models']);
    assert.equal(lines.filter((line) => line.includes('detail request for')).length, 1, lines.join('\n'));
  });
