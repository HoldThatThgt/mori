// MD-01、MD-02 的 Anthropic 形状（docs/specs/model-discovery.md §3.2、§3.3、§5.2，§13.2 单元层；规格更正（规划会话，
// 2026-10-23）：z.ai 的 Anthropic 兼容列表用 hasMore、lastId，见录下的 glm-models-1.json）：对象有 has_more 或 hasMore
// 即为 Anthropic 形状，翻页的游标取 last_id 或 lastId，查询参数仍是 after_id；两种写法都有时用 has_more、last_id；
// 两个字段都没有的不是 Anthropic 形状。列表体是真实录制的 tests/fixtures/discovery/bodies/glm-models-1.json；
// 两页的列表由它分成（synthetic：第 1 页的 hasMore 改为真），替身 fetch 的其余回答是 404（synthetic，rules-helpers.mjs）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import { TEST_KEY, discoverWith, newRequest, rules, sample, table } from './rules-helpers.mjs';

const shared = await loadKernelModule('src/shared/models.ts');

/** 录下的 z.ai 列表（真实录制） */
const GLM = sample('glm-models-1');
/** 录下的列表里每一行的 id，按列表顺序 */
const GLM_IDS = GLM.body.data.map((row) => row.id);
/** 表单里填的 Base URL：§3.1 整理后有 Anthropic 提示，§3.2 的第 ① 个列表地址就是录制的地址 */
const GLM_RAW = 'https://api.z.ai/api/anthropic';
/** §3.2 列表地址（第 ① 个）的前缀；§3.3 第 6 步的 /api/v1/models 不以它开头 */
const LIST_PREFIX = 'https://api.z.ai/api/anthropic/v1/models';
/** 第 1 页的行数（synthetic 的分页） */
const FIRST_PAGE_ROWS = 6;

/** @brief 列表请求（第 ① 个地址与翻页）的地址，按发出的顺序。 */
function listUrls(calls) {
  return calls.map((call) => call.url).filter((url) => url.startsWith(LIST_PREFIX));
}

/** @brief 带 after_id 的列表地址（§3.2：在成功的那次列表地址上设 after_id）。 */
function pageAddress(afterId) {
  const url = new URL(GLM.url);
  url.searchParams.set('after_id', afterId);
  return url.href;
}

/**
 * @brief 由录下的列表分成的两页（synthetic）：第 1 页是前 FIRST_PAGE_ROWS 行、还有下一页，第 2 页是其余的行、没有下一页。
 * @param fields (page, rows) => 这一页的翻页字段；page 为 1 或 2，rows 为这一页的行
 * @return [第 1 页的 body, 第 2 页的 body]
 */
function splitPages(fields) {
  const rows = structuredClone(GLM.body.data);
  const pages = [rows.slice(0, FIRST_PAGE_ROWS), rows.slice(FIRST_PAGE_ROWS)];
  return pages.map((data, index) => ({ data, ...fields(index + 1, data) }));
}

/** @brief z.ai 写法的翻页字段（同录下的 body：firstId、hasMore、lastId）。 */
function camelFields(page, rows) {
  return { firstId: rows[0].id, hasMore: page === 1, lastId: rows.at(-1).id };
}

/**
 * @brief 跑一次两页的发现：第 ① 个列表地址回答第 1 页，after_id=<cursor> 的地址回答第 2 页，其余 404。
 * @param first 第 1 页的 body
 * @param second 第 2 页的 body
 * @param cursor 第 2 页地址里的 after_id
 */
function discoverPages(first, second, cursor) {
  return discoverWith(table([[GLM.url, { status: 200, body: first }], [pageAddress(cursor), { status: 200,
    body: second }]]), newRequest(GLM_RAW, { secret: TEST_KEY }));
}

test('MD-02 §3.3 the recorded z.ai list (hasMore, lastId) is Anthropic-shaped: Detected says Anthropic-compatible',
  async () => {
    assert.equal(GLM.source, 'real');
    assert.deepEqual(Object.keys(GLM.body).sort(), ['data', 'firstId', 'hasMore', 'lastId']);
    assert.equal(rules.isAnthropicShape(GLM.body), true);
    assert.equal(rules.hasMore(GLM.body), false);
    const { result, calls } = await discoverWith(table([[GLM.url, { status: GLM.status, body: GLM.body }]]),
      newRequest(GLM_RAW, { secret: TEST_KEY }));
    // hasMore 为假：只请求第 ① 个列表地址，不翻页
    assert.deepEqual(listUrls(calls), [GLM.url]);
    assert.equal(result.anthropicShape, true);
    assert.deepEqual(result.server, { kind: 'unknown', version: null });
    assert.equal(shared.serverKindLabel(result.server.kind, result.anthropicShape), 'Anthropic-compatible server');
    assert.deepEqual(result.models.map((model) => model.id), GLM_IDS);
    assert.equal(result.truncated, false);
    // API type 仍只看地址（§3.4）
    assert.deepEqual([result.api, result.baseUrl], ['anthropic-messages', GLM_RAW]);
  });

test('MD-01 §3.2 hasMore true on the z.ai list fetches again with after_id=<lastId> and reads both pages',
  async () => {
    const [first, second] = splitPages(camelFields);
    const cursor = first.lastId;
    assert.equal(rules.hasMore(first), true);
    assert.equal(rules.afterIdOf(first), cursor);
    const { result, calls } = await discoverPages(first, second, cursor);
    assert.deepEqual(listUrls(calls), [GLM.url, pageAddress(cursor)]);
    assert.equal(new URL(listUrls(calls)[1]).searchParams.get('after_id'), GLM_IDS[FIRST_PAGE_ROWS - 1]);
    // 翻页的请求带同样的认证头（§3.2 ①）
    const page2 = calls.find((call) => call.url === pageAddress(cursor));
    assert.equal(page2.headers['x-api-key'], TEST_KEY);
    assert.equal(page2.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(result.models.map((model) => model.id), GLM_IDS);
    assert.equal(result.anthropicShape, true);
    assert.equal(result.truncated, false);
  });

test('MD-01 §3.2 the after_id is the lastId cursor itself, not the id of the last row', async () => {
  // 游标与最后一行的 id 不同（synthetic）：只按行的 id 翻页时第 2 页的地址对不上
  const [first, second] = splitPages((page, rows) => ({ ...camelFields(page, rows), lastId: `cursor-page-${page}` }));
  assert.equal(rules.afterIdOf(first), 'cursor-page-1');
  const { result, calls } = await discoverPages(first, second, 'cursor-page-1');
  assert.deepEqual(listUrls(calls), [GLM.url, pageAddress('cursor-page-1')]);
  assert.deepEqual(result.models.map((model) => model.id), GLM_IDS);
  // 没有 lastId 也没有 last_id 时，after_id 取这一页最后一行的 id（D8）
  const noCursor = { ...first };
  delete noCursor.lastId;
  assert.equal(rules.afterIdOf(noCursor), GLM_IDS[FIRST_PAGE_ROWS - 1]);
});

test('MD-01 §3.2 snake_case has_more and last_id still page the same list', async () => {
  const [first, second] = splitPages((page, rows) => ({ first_id: rows[0].id, has_more: page === 1,
    last_id: `snake-${page}` }));
  assert.equal(rules.isAnthropicShape(first), true);
  assert.equal(rules.hasMore(first), true);
  assert.equal(rules.hasMore(second), false);
  const { result, calls } = await discoverPages(first, second, 'snake-1');
  assert.deepEqual(listUrls(calls), [GLM.url, pageAddress('snake-1')]);
  assert.deepEqual(result.models.map((model) => model.id), GLM_IDS);
  assert.equal(result.anthropicShape, true);
});

test('MD-01 §3.2 when both spellings are present, has_more and last_id are used', async () => {
  const both = (page, rows) => ({ ...camelFields(page, rows), has_more: page === 1, last_id: `snake-${page}`,
    lastId: `camel-${page}` });
  const [first, second] = splitPages(both);
  assert.equal(rules.afterIdOf(first), 'snake-1');
  const { result, calls } = await discoverPages(first, second, 'snake-1');
  assert.deepEqual(listUrls(calls), [GLM.url, pageAddress('snake-1')]);
  assert.deepEqual(result.models.map((model) => model.id), GLM_IDS);
  // has_more 为假、hasMore 为真：按 has_more，不翻页
  const stop = { ...structuredClone(GLM.body), has_more: false, hasMore: true };
  assert.equal(rules.hasMore(stop), false);
  const once = await discoverWith(table([[GLM.url, { status: 200, body: stop }]]),
    newRequest(GLM_RAW, { secret: TEST_KEY }));
  assert.deepEqual(listUrls(once.calls), [GLM.url]);
  assert.equal(once.result.anthropicShape, true);
  // 两种写法都有时用 last_id：它不是字符串时按 D8 取这一页最后一行的 id，不改用 lastId
  assert.equal(rules.afterIdOf({ ...first, last_id: null }), GLM_IDS[FIRST_PAGE_ROWS - 1]);
});

test('MD-02 §3.3 a list with neither has_more nor hasMore is not Anthropic-shaped', async () => {
  const { hasMore, firstId, lastId, ...plain } = structuredClone(GLM.body);
  assert.deepEqual([hasMore, typeof firstId, typeof lastId], [false, 'string', 'string']);
  assert.equal(rules.isAnthropicShape(plain), false);
  // 只有游标字段、没有 has_more 与 hasMore：也不是
  assert.equal(rules.isAnthropicShape({ ...plain, lastId, last_id: lastId }), false);
  // 只要有这个字段就是，值为假也是
  assert.equal(rules.isAnthropicShape({ ...plain, hasMore: false }), true);
  assert.equal(rules.isAnthropicShape({ ...plain, has_more: false }), true);
  assert.equal(rules.isAnthropicShape(plain.data), false);
  const { result, calls } = await discoverWith(table([[GLM.url, { status: 200, body: plain }]]),
    newRequest(GLM_RAW, { secret: TEST_KEY }));
  assert.deepEqual(listUrls(calls), [GLM.url]);
  assert.equal(result.anthropicShape, false);
  assert.equal(shared.serverKindLabel(result.server.kind, result.anthropicShape), 'OpenAI-compatible server');
  assert.deepEqual(result.models.map((model) => model.id), GLM_IDS);
  // 列表的形状不改 API type（§3.4）
  assert.equal(result.api, 'anthropic-messages');
});
