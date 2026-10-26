// 真实层与录制脚本共用的测试准备（tests/ui/lib.mjs 的 useRealGroup，docs/specs/model-providers.md §14.1）：在复制出的
// model-config.json 上建一个分组作为默认范围（m0-shell --real、m1–m6 的 *-real 与 *-record 都经它）。真实层与录制脚本只在
// 推送前由负责人用数据目录跑；2026-10-26（WP-05，负责人走查 M3）它去掉了给临时项目授权公网的一步，集成时没有一个用到它的
// 脚本跑过，所以这里在合成的配置上（synthetic test setup，临时目录，没有 key、不连任何服务）单独查它（2026-10-26 补，
// WP-05 的覆盖审查）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REAL_GROUP, useRealGroup } from '../ui/lib.mjs';

/** @brief 一个提供商的配置（synthetic）：一个模型、没有 key。 */
const providerOf = (id, baseUrl) => ({ id, name: id.toUpperCase(), api: 'openai-completions', baseUrl, compat: {},
  concurrency: 4, keys: [], nextKeyNumber: 1,
  models: [{ id: `${id}-model`, family: '', contextWindow: 131072, maxTokens: 8192, reasoning: false,
    input: ['text'] }] });

/** @brief 在新的临时目录里写 model-config.json（synthetic），返回目录。 */
function seedDir(config) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-real-setup-'));
  writeFileSync(join(dir, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

/** @brief 目录里的 model-config.json。 */
const configIn = (dir) => JSON.parse(readFileSync(join(dir, 'model-config.json'), 'utf8'));

test('real-layer setup: useRealGroup makes a group of the DeepSeek and the GLM provider (in that order) the default '
  + 'range, replaces an older group of that id, keeps the other groups and writes no zone fields', () => {
  const dir = seedDir({ version: 1, providers: [providerOf('local', 'http://127.0.0.1:9/v1'),
    providerOf('glm', 'https://open.bigmodel.cn/api/paas/v4'), providerOf('ds', 'https://api.deepseek.com')],
  groups: [{ id: REAL_GROUP, members: ['local'] }, { id: 'mine', members: ['local'] }], normalDefault: 'mine' });
  try {
    const used = useRealGroup(dir);
    const config = configIn(dir);
    assert.deepEqual(used.map((item) => item.provider), ['ds', 'glm']);
    assert.deepEqual(config.groups, [{ id: 'mine', members: ['local'] }, { id: REAL_GROUP, members: ['ds', 'glm'] }]);
    assert.equal(config.normalDefault, REAL_GROUP);
    const keys = [...Object.keys(config), ...config.providers.flatMap((item) => Object.keys(item))];
    assert.equal(keys.some((key) => ['zone', 'allowedZones', 'projectZones'].includes(key)), false);
    assert.deepEqual(config.providers.map((item) => item.id), ['local', 'glm', 'ds']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real-layer setup: with one provider the group is just it; without providers useRealGroup throws (the data dir '
  + 'must be opened with Mori v1 first)', () => {
  const one = seedDir({ version: 1, providers: [providerOf('ds', 'https://api.deepseek.com')], groups: [],
    normalDefault: null });
  const none = seedDir({ version: 1, providers: [], groups: [], normalDefault: null });
  try {
    useRealGroup(one);
    assert.deepEqual(configIn(one).groups, [{ id: REAL_GROUP, members: ['ds'] }]);
    assert.throws(() => useRealGroup(none), /No providers in /);
  } finally {
    rmSync(one, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});
