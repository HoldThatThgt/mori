// MD-02 服务种类（docs/specs/model-discovery.md §3.3 第 6 步，§13.2 单元层）里 lmstudio 的条件：
// "/api/v1/models 的 models 是数组、其中的项有 key"。没下载模型的 LM Studio 回答 { models: [] }，空数组也满足这一格，
// 认作 lmstudio（审查修正 C6 去掉了"models 不能为空"的条件，这里防它回来）；有一项没有 key、或 models 不是数组时
// 不认作 lmstudio。响应体都是手写的（synthetic，规格 §13.1）：/v1/models 的空列表与 /api/v1/models 的各种回答写在
// 这里；有模型时的列表行与带 key 的项取 tests/fixtures/discovery/bodies/ 的 lmstudio-v1-models.json、
// lmstudio-api-v1-models.json（同样是手写样本，来历见那里的 README.md）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countOf, discoverWith, newRequest, rules, sample, table } from './rules-helpers.mjs';

/** LM Studio 的 origin（同 rules-helpers.mjs 的 lmstudio 场景） */
const ORIGIN = 'http://192.0.2.15:1234';

/** 第 6 步 LM Studio 的路径 */
const NATIVE_PATH = '/api/v1/models';

/** 没下载模型的 LM Studio 的 /v1/models（synthetic）：data 为空 */
const EMPTY_LIST = Object.freeze({ status: 200, body: { data: [], object: 'list' } });

/** @brief 只有 /api/v1/models 回答时第 6 步判断出的种类（rows 为 /v1/models 的列表行）。 */
function kindOf(nativeBody, rows) {
  return rules.judgeProbedKind(new Map([[NATIVE_PATH, nativeBody]]), rows);
}

/** @brief 去掉一项的 key 字段，其他字段不变。 */
function withoutKey(item) {
  return Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'key'));
}

/**
 * @brief 新提供商的一次发现：/v1/models 与 /api/v1/models 按给的回答，第 6 步的其他路径为 404。
 * @param list /v1/models 的回答 { status, body }
 * @param nativeBody /api/v1/models 的响应体
 * @return { result, calls }
 */
function discoverLmStudio(list, nativeBody) {
  const routes = [[`${ORIGIN}/v1/models`, list], [`${ORIGIN}${NATIVE_PATH}`, { status: 200, body: nativeBody }]];
  return discoverWith(table(routes), newRequest(`${ORIGIN}/v1`));
}

test('MD-02 §3.3 step 6: an LM Studio whose /api/v1/models answers an empty models array is lmstudio', async () => {
  assert.equal(kindOf({ models: [] }, []), 'lmstudio');
  // 整个发现：列表为空、没有列表错误，种类为 lmstudio（版本按 §3.3 不读，为 null），第 6 步的响应只请求一次
  const { result, calls } = await discoverLmStudio(EMPTY_LIST, { models: [] });
  assert.equal(result.listError, null);
  assert.deepEqual(result.server, { kind: 'lmstudio', version: null });
  assert.deepEqual(result.models, []);
  assert.equal(countOf(calls, `${ORIGIN}${NATIVE_PATH}`), 1);
});

test('MD-02 §3.3 step 6: /api/v1/models items without "key" are not lmstudio', async () => {
  const rows = sample('lmstudio-v1-models').body.data;
  const keyed = sample('lmstudio-api-v1-models').body.models;
  assert.equal(kindOf({ models: keyed }, rows), 'lmstudio');
  // 每一项都没有 key、只有一项没有 key、models 不是数组：都不是 lmstudio
  const noKey = keyed.map(withoutKey);
  const cases = [[{ models: noKey }, rows], [{ models: [...keyed, { id: 'extra-model' }] }, rows],
    [{ models: [{ id: 'x' }] }, []], [{ models: {} }, []], [{ data: [] }, []]];
  for (const [body, list] of cases) assert.equal(kindOf(body, list), 'unknown', JSON.stringify(body).slice(0, 80));
  // 整个发现：列表照常列出，种类为 unknown
  const { result } = await discoverLmStudio({ status: 200, body: { data: rows } }, { models: noKey });
  assert.equal(result.listError, null);
  assert.deepEqual(result.server, { kind: 'unknown', version: null });
  assert.equal(result.models.length, rows.length);
});
