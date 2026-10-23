// 发现命令的单元测试（docs/specs/model-discovery.md §13.2 MD-06，单元层）：同一时刻只做一次 models.discover，新的一次取消
// 正在进行的那次、discoverCancel 取消它，被取消的返回 cancelled: true（§5.3）；探针第 0 步（single）与读版本（version）
// 不被它们取消，只随自己的 signal 停止（§5.3，D10）；结束时的日志（§5.3，A9）。替身 fetch 与列表都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  captureConsole, deferred, empty, existing, hang, json, newRequest, providerRequest, readerWith, settle, stubFetch,
} from './io-helpers.mjs';

const { DiscoverReader } = await loadKernelModule('src/kernel/modelDiscover.ts');

/** vLLM 形状的列表（synthetic）。 */
function vllmList(ids) {
  return json({ object: 'list',
    data: ids.map((id) => ({ id, object: 'model', owned_by: 'vllm', max_model_len: 8192 })) });
}

/** @brief 按地址回答：slow 的 origin 的列表请求一直不回答（只随 signal 中止），其余回 vLLM 列表与 /version。 */
function slowOrigin(slow) {
  return stubFetch((call) => {
    if (call.origin === slow && call.path.endsWith('/models')) return hang(call);
    if (call.path.endsWith('/models')) return vllmList(['a', 'b']);
    return call.path === '/version' ? json({ version: '0.10.1' }) : empty(404);
  });
}

test('MD-06 a new models.discover cancels the running one: cancelled: true, its request aborted', async (t) => {
  const lines = captureConsole(t);
  const stub = slowOrigin('http://192.0.2.70:8000');
  const reader = readerWith(DiscoverReader, stub.fetch);
  const first = reader.command(newRequest('http://192.0.2.70:8000/v1'));
  await settle();
  const second = await reader.command(newRequest('http://192.0.2.71:8000/v1'));
  const cancelled = await first;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.server, null);
  assert.deepEqual(cancelled.models, []);
  assert.equal(cancelled.listError, null);
  assert.equal(cancelled.baseUrl, 'http://192.0.2.70:8000/v1');
  assert.equal(stub.calls[0].signal.aborted, true, 'the request of the cancelled discovery is aborted');
  assert.equal(second.cancelled, false);
  assert.deepEqual(second.models.map((model) => model.id), ['a', 'b']);
  assert.ok(lines.some((line) => /discover 192\.0\.2\.70:8000 cancelled ms=\d+/.test(line)), lines.join('\n'));
});

test('MD-06 discoverCancel cancels the running discovery; with none running it does nothing', async (t) => {
  captureConsole(t);
  const stub = slowOrigin('http://192.0.2.72:8000');
  const reader = readerWith(DiscoverReader, stub.fetch);
  reader.cancelCommand();
  const running = reader.command(newRequest('http://192.0.2.72:8000/v1'));
  await settle();
  reader.cancelCommand();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(stub.calls[0].signal.aborted, true);
  reader.cancelCommand();
  const next = await reader.command(newRequest('http://192.0.2.73:8000/v1'));
  assert.equal(next.cancelled, false, 'an earlier cancel does not reach a discovery started afterwards');
  assert.deepEqual(next.models.map((model) => model.id), ['a', 'b']);
});

test('MD-06 a discovery cancelled while it reads details is cancelled too', async (t) => {
  captureConsole(t);
  const stub = stubFetch((call) => {
    if (call.path === '/v1/models') {
      return json({ object: 'list', data: [{ id: 'q', object: 'model', owned_by: 'sglang', max_model_len: 4096 }] });
    }
    return call.path === '/model_info' ? hang(call) : json({ version: '0.5.0' });
  });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const running = reader.command(providerRequest('http://192.0.2.74:30000/v1'));
  await settle();
  assert.ok(stub.calls.some((call) => call.path === '/model_info'), 'it is reading /model_info');
  reader.cancelCommand();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.models, []);
  assert.equal(stub.calls.find((call) => call.path === '/model_info').signal.aborted, true);
});

test('MD-06 probe step 0 and version reads are not cancelled by a new discovery or by discoverCancel', async (t) => {
  captureConsole(t);
  const list = deferred();
  const stub = stubFetch((call) => {
    if (call.origin === 'http://192.0.2.75:8000' && call.path === '/v1/models') return list.promise;
    if (call.path.endsWith('/models')) return vllmList(['x']);
    return call.path === '/version' ? json({ version: '0.10.1' }) : empty(404);
  });
  const reader = readerWith(DiscoverReader, stub.fetch);
  const shareKey = 'http://192.0.2.75:8000/v1|openai-completions|p#1';
  const target = existing('http://192.0.2.75:8000/v1', { shareKey });
  const single = reader.single(target, 'a', new AbortController().signal);
  const version = reader.version(target, new AbortController().signal);
  // 同一个提供商的命令加入同一次列表读取（§5.3），随后被新的一次与 discoverCancel 取消
  const command = reader.command(providerRequest('http://192.0.2.75:8000/v1', { shareKey }));
  await settle();
  const newer = reader.command(newRequest('http://192.0.2.76:8000/v1'));
  reader.cancelCommand();
  assert.equal((await command).cancelled, true);
  assert.equal((await newer).cancelled, true);
  const listCalls = stub.calls.filter((call) => call.origin === 'http://192.0.2.75:8000' && call.path === '/v1/models');
  assert.equal(listCalls.length, 1, 'step 0, the version read and the command share one list request');
  assert.equal(listCalls[0].signal.aborted, false, 'cancelling the command does not abort the shared read');
  list.resolve(vllmList(['a', 'b']));
  assert.deepEqual(await single, { kind: 'vllm', version: '0.10.1', reported: 8192,
    meta: { maxTokens: null, reasoning: null, image: null } });
  assert.deepEqual(await version, { listed: true, kind: 'vllm', version: '0.10.1', versionRead: true });
});

test('MD-06 step 0 and version reads stop only with their own signal', async (t) => {
  captureConsole(t);
  const stub = stubFetch(hang);
  const reader = readerWith(DiscoverReader, stub.fetch);
  const probe = new AbortController();
  const single = reader.single(existing('http://192.0.2.77:8000/v1'), 'a', probe.signal);
  const versions = new AbortController();
  const version = reader.version(existing('http://192.0.2.78:8000/v1'), versions.signal);
  await settle();
  // 两个列表请求都已发出（否则下面的 every 对空数组总成立）
  assert.deepEqual(stub.calls.map((call) => call.url).sort(),
    ['http://192.0.2.77:8000/v1/models', 'http://192.0.2.78:8000/v1/models']);
  reader.cancelCommand();
  // 再来一次新的命令：它取消的只是自己之前的命令，同样不碰第 0 步与读版本
  const newer = reader.command(newRequest('http://192.0.2.79:8000/v1'));
  reader.cancelCommand();
  assert.equal((await newer).cancelled, true);
  await settle();
  const own = stub.calls.filter((call) => call.origin !== 'http://192.0.2.79:8000');
  assert.equal(own.length, 2);
  assert.ok(own.every((call) => !call.signal.aborted), 'discoverCancel and a new discovery reach neither');
  probe.abort(new Error('probe set cancelled'));
  await assert.rejects(single, /probe set cancelled/);
  versions.abort(new Error('version read stopped'));
  await assert.rejects(version, /version read stopped/);
  assert.ok(stub.calls.every((call) => call.signal.aborted));
});

test('MD-06 the end of a discovery logs "discover <host> kind=<kind> models=<n> ms=<ms>" (kind=none without list)',
  async (t) => {
    const lines = captureConsole(t);
    let clock = 1000;
    const stub = stubFetch((call) => {
      clock += 7;
      if (call.origin === 'http://192.0.2.79:8000') return empty(404);
      return call.path.endsWith('/models') ? vllmList(['a', 'b', 'c']) : json({ version: '0.10.1' });
    });
    const reader = readerWith(DiscoverReader, stub.fetch, { now: () => clock });
    await reader.command(newRequest('http://192.0.2.80:8000/v1'));
    assert.ok(lines.includes('log [kernel] discover 192.0.2.80:8000 kind=vllm models=3 ms=14'), lines.join('\n'));
    await reader.command(newRequest('http://192.0.2.79:8000'));
    assert.ok(lines.includes('log [kernel] discover 192.0.2.79:8000 kind=none models=0 ms=14'), lines.join('\n'));
    assert.ok(lines.includes('error [kernel] discover 192.0.2.79:8000 listError=no_list ""'), lines.join('\n'));
  });
