// kernel/config.ts testConnection 的单元测试（docs/specs/model-providers.md §7.8，MP-45 的测试连接部分）：测试连接按这个
// 模型学的首个内容时限（还没有记录时为上限）计时，收到首个内容记下用时，超时记下这次的时限，原文写这次的秒数。
// config.ts 经 esbuild 打包时把 ./modelLayer 与 ./pi 换成本文件里的替身（synthetic）：替身的模型层只有 testConnection
// 用到的几样（lookupModel、getRuntime、getPool、timings、notify 与首个内容时限的三个方法），流与 fetch 由各用例给出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bundleInMemory, freshUrl } from './load.mjs';

/** 替身模块的源码：模型层由测试经 globalThis.__moriTestLayer 给出；pi 只给 globalSettings。 */
const STUBS = {
  modelLayer: 'export const getModelLayer = async () => globalThis.__moriTestLayer;',
  pi: 'export const globalSettings = async () => ({});',
};

/** esbuild 插件：config.ts 里的 ./modelLayer、./pi 换成 STUBS。 */
const stubPlugin = {
  name: 'stub-layer',
  setup(build) {
    build.onResolve({ filter: /^\.\/(modelLayer|pi)$/ }, (args) => ({ path: args.path.slice(2), namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }));
  },
};

const appRoot = join(import.meta.dirname, '..', '..');
const url = await bundleInMemory({ entryPoints: [join(appRoot, 'src/kernel/config.ts')], plugins: [stubPlugin] },
  'src_kernel_config_stubbed');
const { testConnection } = await import(freshUrl(url));

/** @brief 等 signal 被中止（已经中止时马上结束）。 */
function untilAborted(signal) {
  return signal.aborted ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}

/** 一条回答的事件流（synthetic）：发出（经 options.fetch）后 delayMs 毫秒给一段正文；hang 时等到被中止。 */
function stream(options, { delayMs = 0, hang = false } = {}) {
  return (async function* events() {
    await options.fetch('http://127.0.0.1:9/p/chat/completions',
      { method: 'POST', body: '{}', signal: options.signal });
    if (hang) {
      await untilAborted(options.signal);
      yield { type: 'error', error: { errorMessage: 'Request was aborted' } };
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield { type: 'text_delta', delta: 'Hello.' };
    yield { type: 'done' };
  })();
}

/** 替身模型层：limitMs 为这个模型的时限；记下问时限的用法、记下的首个内容与超时。 */
function fakeLayer(limitMs, behaviour) {
  const seen = { uses: [], tokens: [], timeouts: [] };
  globalThis.__moriTestLayer = {
    timings: { placeholderApiKey: 'mori-pool' },
    lookupModel: () => ({ provider: { api: 'openai-completions' }, model: { id: 'm' } }),
    getRuntime: () => ({ getModel: () => ({ id: 'm', reasoning: false }),
      streamSimple: (_model, _context, options) => stream(options, behaviour) }),
    getPool: () => ({
      createFetch: (request) => async (_input, init) => {
        request.onSent();
        if (behaviour.hang) {
          await untilAborted(init.signal);
        }
        return new Response('{}');
      },
      clearAfterTest() {},
    }),
    notify() {},
    firstTokenLimitOf: (ref, use) => { seen.uses.push([ref, use]); return limitMs; },
    recordFirstToken: (ref, ms) => seen.tokens.push([ref, ms]),
    recordFirstTokenTimeout: (ref, ms) => seen.timeouts.push([ref, ms]),
  };
  return seen;
}

test('MP-45 Test connection waits the model’s probe-use limit and reports a timeout with it, in its text', async () => {
  const seen = fakeLayer(40, { hang: true });
  const result = await testConnection({ providerId: 'p', modelId: 'm', keyRef: null });
  assert.deepEqual(seen.uses, [['p/m', 'probe']], 'no record means the ceiling: it asks with the probe use');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'No response within 0.04 s', 'the text names the limit it used');
  assert.deepEqual(seen.timeouts, [['p/m', 40]]);
  assert.deepEqual(seen.tokens, []);
});

test('MP-45 Test connection records the time from the request being sent to its first content', async () => {
  const seen = fakeLayer(5000, { delayMs: 30 });
  const result = await testConnection({ providerId: 'p', modelId: 'm', keyRef: null });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(seen.tokens.length, 1);
  const [[ref, ms]] = seen.tokens;
  assert.equal(ref, 'p/m');
  assert.ok(ms >= 25 && ms < 1000, `${ms} ms`);
  assert.deepEqual(seen.timeouts, []);
});
