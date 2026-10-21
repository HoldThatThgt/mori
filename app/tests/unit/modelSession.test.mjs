// kernel/modelSession.ts 的单元测试：首个内容时限（§5.4 timeout）只在请求真正发出时计时，
// 换 key、原地重试的等待（模型池的 onPause）不计入。定时器用 node:test 的假定时器。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const { FirstContentTimer } = await loadKernelModule('src/kernel/modelSession.ts');

/** 时限 120 s 的计时器与它到时的次数。 */
function timer() {
  const fired = [];
  return { fired, timer: new FirstContentTimer(120_000, () => fired.push(Date.now())) };
}

test('MP-18 first-content timer: a 504 just before the limit, then a retry wait, does not count as a timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { fired, timer: watch } = timer();
  watch.restart();
  t.mock.timers.tick(115_000);
  // 504 到了：模型池转去原地重试，等 8 s（onPause），等待期间不计时。
  watch.pause();
  t.mock.timers.tick(8_000);
  assert.equal(watch.fired, false);
  assert.deepEqual(fired, []);
  // 重试发出（onSent）：重新计时，之后收到内容就停。
  watch.restart();
  t.mock.timers.tick(119_000);
  watch.stop();
  t.mock.timers.tick(10_000);
  assert.equal(watch.fired, false);
  assert.deepEqual(fired, []);
});

test('MP-18 first-content timer: after a pause the next send still times out at the full limit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { fired, timer: watch } = timer();
  watch.restart();
  t.mock.timers.tick(60_000);
  watch.pause();
  t.mock.timers.tick(60_000);
  watch.restart();
  t.mock.timers.tick(119_999);
  assert.equal(watch.fired, false);
  t.mock.timers.tick(1);
  assert.equal(watch.fired, true);
  assert.equal(fired.length, 1);
});

test('MP-18 first-content timer: once stopped, a later send does not start it again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { timer: watch } = timer();
  watch.restart();
  watch.stop();
  watch.restart();
  t.mock.timers.tick(200_000);
  assert.equal(watch.fired, false);
});
