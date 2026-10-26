// 调度类别 subagent（docs/specs/subagent.md §5.4）的单元测试：严格优先 conversation > decision > subagent > task > background，
// 一个 key 上用满并发设置的全部槽位（不留给 conversation、decision），排队不超时。模型池的端点是替身 fetch（synthetic），
// key 是测试用的假值；替身与 tests/unit/taskboard/model.test.mjs 的写法相同。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, loadKernelModule } from '../load.mjs';

const { createModelPool } = await loadKernelModule('src/kernel/modelPool.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 模型池的假时钟加假定时器：advance 按时刻顺序触发到期的定时器。 */
function fakeTimers() {
  const clock = fakeClock(1_000_000);
  const timers = new Map();
  let nextId = 0;
  const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    now: clock.now, flush,
    setTimeout(callback, ms) { nextId += 1; timers.set(nextId, { at: clock.now() + ms, callback }); return nextId; },
    clearTimeout(handle) { timers.delete(handle); },
    async advance(ms) {
      const target = clock.now() + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
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

/** 一个提供商 p（concurrency 由参数给出、一个 key）的模型池；端点的回答一直不结束，直到 release。 */
function poolSetup(concurrency) {
  const timers = fakeTimers();
  const open = [];
  const sent = [];
  const fetch = (_url, init) => new Promise((resolve) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    open.push(() => controller.close());
    sent.push(JSON.parse(init.body).who);
    resolve(new Response(body, { status: 200 }));
  });
  const pool = createModelPool({ timings: MODEL_TIMINGS, clock: timers, fetch, log: () => {} });
  pool.setProviders([{ id: 'p', name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000/p',
    compat: {}, concurrency, keys: [{ ref: 'p#1', label: 'Key 1' }], nextKeyNumber: 2,
    models: [{ id: 'm1', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] }] }]);
  pool.setKeys('p', [{ ref: 'p#1', secret: 'secret-p1' }]);
  const send = (who, cls, queue = []) => pool.createFetch({ ref: 'p/m1', api: 'openai-completions', sessionKey: who,
    cls, onQueue: (notice) => queue.push(notice.active) })('http://127.0.0.1:9000/p',
    { method: 'POST', body: JSON.stringify({ who }) });
  const release = async (index, responses) => {
    open[index]();
    await responses[index].text();
    await timers.flush();
  };
  return { pool, timers, sent, send, release };
}

test('SA-06 six subagents on a concurrency-4 key: four in flight (no slot kept back), two wait for a free slot',
  async () => {
    const { pool, timers, sent, send, release } = poolSetup(4);
    const responses = [];
    for (const who of ['s1', 's2', 's3', 's4']) responses.push(await send(who, 'subagent'));
    const queues = [[], []];
    const waiting = [send('s5', 'subagent', queues[0]), send('s6', 'subagent', queues[1])];
    await timers.flush();
    assert.deepEqual(sent, ['s1', 's2', 's3', 's4'], 'all four slots, unlike task and background');
    assert.equal(pool.inFlight('p'), 4);
    assert.equal(pool.queued('p'), 2);
    assert.deepEqual(queues, [[true], [true]], 'the waiting ones are told they wait for P');
    await timers.advance(10 * 60_000);
    assert.equal(pool.queued('p'), 2, 'no queue timeout: they keep waiting');
    await release(0, responses);
    responses.push(await waiting[0]);
    assert.deepEqual(sent, ['s1', 's2', 's3', 's4', 's5']);
    await release(1, responses);
    responses.push(await waiting[1]);
    assert.deepEqual(sent, ['s1', 's2', 's3', 's4', 's5', 's6']);
  });

test('SA-06 strict priority conversation > decision > subagent > task > background', async () => {
  const { pool, timers, sent, send, release } = poolSetup(1);
  const responses = [await send('holder', 'subagent')];
  const pending = [['bg', 'background'], ['task', 'task'], ['sub', 'subagent'], ['decision', 'decision'],
    ['chat', 'conversation']].map(([who, cls]) => send(who, cls));
  await timers.flush();
  assert.equal(pool.queued('p'), 5);
  for (let i = 0; i < 5; i += 1) {
    await release(i, responses);
    responses.push(await pending[[4, 3, 2, 1, 0][i]]);
  }
  assert.deepEqual(sent, ['holder', 'chat', 'decision', 'sub', 'task', 'bg']);
});

test('SA-06 at concurrency 1 subagents run one after another and all finish', async () => {
  const { pool, timers, sent, send, release } = poolSetup(1);
  const responses = [await send('s1', 'subagent')];
  const rest = [send('s2', 'subagent'), send('s3', 'subagent')];
  await timers.flush();
  assert.equal(pool.queued('p'), 2);
  await release(0, responses);
  responses.push(await rest[0]);
  await release(1, responses);
  responses.push(await rest[1]);
  await release(2, responses);
  assert.deepEqual(sent, ['s1', 's2', 's3']);
  assert.equal(pool.inFlight('p'), 0);
});
