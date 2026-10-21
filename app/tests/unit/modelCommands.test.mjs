// kernel/modelCommands.ts 的单元测试：要保存的 key 必须能写进认证头（§8.4 第 2 步）。key 都是测试用的假值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const { headerSafeSecret } = await loadKernelModule('src/kernel/modelCommands.ts');

test('MP-32 a key is trimmed and must be printable ASCII without spaces before it is saved', () => {
  assert.equal(headerSafeSecret('  sk-abc_DEF.123\n'), 'sk-abc_DEF.123');
  for (const bad of ['sk-ab​cd-SECRET', 'sk-Ａ-SECRET', 'sk-line\nbreak-SECRET', 'sk two-SECRET', '   ']) {
    assert.throws(() => headerSafeSecret(bad),
      (error) => /cannot be sent in a header/.test(error.message) && !error.message.includes('SECRET'));
  }
});
