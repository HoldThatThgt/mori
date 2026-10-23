// 改每天的时刻之后读哪些会话（docs/specs/memory.md §9.1、§9.2、§9.5，MEM-18 的规格例子）：增强调度、真正的增强运行、
// 记忆模块与 pi 的会话列表一起跑，时钟注入。之前读过的部分由水位跳过，不会重复读；改时刻之后白天新建的会话照样列出。
// 会话表换成替身（synthetic）；用户会话文件与 enhance.json（含之前运行留下的水位）由测试手写（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, ended, enhanceJson, listedSessions, messageOf, monDayTime, readEnhance, runSetup as setup, turn, writeEnhance,
  writeSession,
} from './enhance-harness.mjs';

test('MEM-18 spec example: 04:00→23:00 at Oct 23 10:00, Oct 22 runs at 23:00 with only the lines after Oct 23 04:00 '
  + 'and the session created that day', async (t) => {
  const env = await setup(t, at('2026-10-23', '10:00'));
  const cwd = env.project('shop');
  // 10-22（04:00）已经读完：水位停在 10-23 04:00 之前的最后一条
  const old = writeSession(env.agentDir, { id: 'old', cwd, at: at('2026-10-22', '09:00'), items: [
    ...turn('a1', '2026-10-22', '10:00'), ...turn('a2', '2026-10-23', '02:00'), ...turn('a3', '2026-10-23', '09:00'),
    ...turn('a4', '2026-10-23', '23:30')] });
  const fresh = writeSession(env.agentDir, { id: 'fresh', cwd, at: at('2026-10-23', '15:00'),
    items: turn('b1', '2026-10-23', '15:00') });
  writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22',
    watermarks: { [old]: 'a2a' } }));
  await env.startEnhance();
  assert.equal((await env.k.enhance.setEnhance(cwd, { time: '23:00' })).error, null);
  const file = readEnhance(env.k.memory, cwd);
  assert.deepEqual([file.time, file.since, file.tasks.taste.doneThrough], ['23:00', '2026-10-20', '2026-10-21']);
  assert.equal(env.built.length, 0, 'nothing runs at 10:00');
  assert.deepEqual(env.clock.pending(), [at('2026-10-23', '23:00')]);
  env.clock.fire();
  await ended(env, cwd, 'review', '2026-10-22');
  for (const task of ['taste', 'strategy', 'review']) {
    const message = messageOf(env, task, '2026-10-22');
    assert.ok(message.split('\n')[0].endsWith('Day: Oct 22, 2026 (23:00 to 23:00).'), task);
    assert.deepEqual(listedSessions(message).map(({ file: path, from, to, start }) => ({ path, from, to, start })), [
      { path: old, from: 6, to: 7, start: 'after entry a2a' },
      { path: fresh, from: 2, to: 3, start: `from ${monDayTime(at('2026-10-23', '15:00'))}` },
    ], `${task}: Oct 22 10:00 is not read again; Oct 23 23:30 belongs to Oct 23`);
  }
  const after = readEnhance(env.k.memory, cwd).tasks.taste;
  assert.deepEqual([after.doneThrough, after.watermarks], ['2026-10-22', { [old]: 'a3a', [fresh]: 'b1a' }]);
});

test('MEM-18 23:00→04:00: the newly finished Oct 22 runs at once and lists nothing read before', async (t) => {
  const env = await setup(t, at('2026-10-23', '10:00'));
  const cwd = env.project('shop');
  // 23:00 的 10-21（10-21 23:00 到 10-22 23:00）已经读完：水位停在 10-22 22:00 那一轮
  const old = writeSession(env.agentDir, { id: 'old', cwd, at: at('2026-10-22', '09:00'), items: [
    ...turn('c1', '2026-10-22', '10:00'), ...turn('c2', '2026-10-22', '22:00'), ...turn('c3', '2026-10-23', '01:00'),
    ...turn('c4', '2026-10-23', '03:00'), ...turn('c5', '2026-10-23', '09:00')] });
  writeEnhance(env.k.memory, cwd, enhanceJson({ time: '23:00', since: '2026-10-20', doneThrough: '2026-10-21',
    watermarks: { [old]: 'c2a' } }));
  await env.startEnhance();
  assert.equal(env.built.length, 0);
  assert.equal((await env.k.enhance.setEnhance(cwd, { time: '04:00' })).error, null);
  await ended(env, cwd, 'review', '2026-10-22');
  for (const task of ['taste', 'strategy', 'review']) {
    const [listed] = listedSessions(messageOf(env, task, '2026-10-22'));
    assert.deepEqual([listed.file, listed.from, listed.to, listed.start], [old, 6, 9, 'after entry c2a'],
      `${task}: from after the watermark to Oct 23 04:00`);
  }
  assert.deepEqual(readEnhance(env.k.memory, cwd).tasks.taste.watermarks, { [old]: 'c4a' });
  assert.deepEqual(env.clock.pending(), [at('2026-10-24', '04:00')]);
});
