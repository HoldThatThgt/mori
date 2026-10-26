// kernel/modelCommands.ts 的单元测试：要保存的 key 必须能写进认证头（§8.4 第 2 步）。key 都是测试用的假值。
// 2026-10-26（负责人走查 M5，§9.1“拖动排序”、§9.5）：models.moveModel、models.moveKey 的 moved 一次移动多格。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const { headerSafeSecret, moved } = await loadKernelModule('src/kernel/modelCommands.ts');

test('MP-32 a key is trimmed and must be printable ASCII without spaces before it is saved', () => {
  assert.equal(headerSafeSecret('  sk-abc_DEF.123\n'), 'sk-abc_DEF.123');
  for (const bad of ['sk-ab​cd-SECRET', 'sk-Ａ-SECRET', 'sk-line\nbreak-SECRET', 'sk two-SECRET', '   ']) {
    assert.throws(() => headerSafeSecret(bad),
      (error) => /cannot be sent in a header/.test(error.message) && !error.message.includes('SECRET'));
  }
});

test('MP-24 one move takes an item several places at once (a drop is one write), forward and back', () => {
  const items = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moved(items, 3, -3, 'p/d'), ['d', 'a', 'b', 'c'], 'last to first in one move');
  assert.deepEqual(moved(items, 0, 2, 'p/a'), ['b', 'c', 'a', 'd'], 'first forward by two');
  assert.deepEqual(moved(items, 2, -1, 'p/c'), ['a', 'c', 'b', 'd'], 'one place back (arrow key)');
  assert.deepEqual(moved(items, 1, 2, 'p/b'), ['a', 'c', 'd', 'b'], 'to the end');
  assert.deepEqual(items, ['a', 'b', 'c', 'd'], 'the list passed in is not changed');
});

test('MP-24 a move past either end or of an item that is not there is an error', () => {
  assert.throws(() => moved(['a', 'b', 'c'], 0, -1, 'p/a'), /^Error: Cannot move p\/a further$/);
  assert.throws(() => moved(['a', 'b', 'c'], 1, 2, 'p/b'), /^Error: Cannot move p\/b further$/);
  assert.throws(() => moved(['a', 'b', 'c'], 2, -3, 'Key p#3'), /^Error: Cannot move Key p#3 further$/);
  assert.throws(() => moved(['a', 'b', 'c'], -1, 1, 'p/x'), /^Error: p\/x is not in your model settings$/);
});
