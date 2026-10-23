// 预算（docs/specs/memory.md §6.3，验收 MEM-07 的单元层）：估算（中日韩字符每个 1，其余 ÷4 向上取整，按层分别估算再相加）；
// 用量恰好 500 时允许、501 时拒绝，错误原文里的和等于两数相加，什么都没写；写用户级时超出某个项目被拒绝并写出项目；
// 回滚、移动同样检查；删除不受限；手改超出时照样全部进 prompt，用量显示超出。
// 条目的长度用中日韩字符凑出确切的 token 数（每行 `- ` 两个字符，行之间一个换行，§6.3）；手写的条目为 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  PAGE, ROLLBACK, cjk, freshUserData, loadMemoryKernel, ok, seedKind, seedProject, snapshotDir,
} from './core-helpers.mjs';

const R = await loadKernelModule('src/kernel/memoryRules.ts');
const S = await loadKernelModule('src/shared/memory.ts');
const K = await loadMemoryKernel();

/** @brief §6.3 的拒绝原文：写本项目时（或写用户级时超出的那个项目）。 */
function over(kind, user, label, other) {
  return `Over the 500-token limit for ${kind}: user ${user} + ${label} ${other} = ${user + other}. `
    + 'Merge or delete entries first.';
}

/** @brief 记忆页新增一条 TASTE。 */
function addTaste(cwd, layer, abstract) {
  return K.save(PAGE, { cwd, layer, kind: 'taste', abstract, detail: '', evidence: [] });
}

test('MEM-07 the estimate counts each CJK character as 1 and the rest ÷ 4 rounded up', () => {
  const tokens = S.estimateMemoryTokens;
  assert.equal(tokens(''), 0);
  assert.equal(tokens('a'), 1);
  assert.equal(tokens('abcd'), 1);
  assert.equal(tokens('abcde'), 2);
  assert.equal(tokens('中文'), 2);
  assert.equal(tokens('中文abcde'), 4);
  assert.equal(tokens('Plan 先'), 3, 'one CJK character plus five others');
  // §6.3 列出的：CJK 标点、平假名、片假名、扩展 A、统一表意文字、韩文音节、全角形式
  const samples = ['、', 'あ', 'カ', '㐀', '中', '한', 'Ａ'];
  for (const char of samples) assert.equal(tokens(char.repeat(4)), 4, `U+${char.codePointAt(0).toString(16)}`);
  assert.equal(tokens(samples.join('')), samples.length);
  assert.equal(tokens('éèêë'), 1, 'other letters are not CJK');
  assert.equal(tokens('\u{20000}'.repeat(4)), 1, 'extension B is not in the §6.3 list: four characters ÷ 4');
});

test('MEM-07 the estimate counts only the §6.3 list as CJK: compatibility ideographs are other characters', () => {
  // U+F900–U+FAFF（CJK 兼容表意文字）不在 §6.3 的列表里（统一表意文字及扩展 A、平假名、片假名、韩文音节、全角形式、CJK 标点）
  assert.equal(S.estimateMemoryTokens('豈更車賈'), 1);
});

test('MEM-07 usage is estimated per layer and then added', async (t) => {
  assert.equal(S.layerUsage([]), 0);
  assert.equal(S.layerUsage(['ab']), S.estimateMemoryTokens('- ab'));
  assert.deepEqual(R.usageOf(['ab'], ['cd']), { used: 2, limit: 500, user: 1, project: 1 });
  assert.equal(S.estimateMemoryTokens('- ab\n- cd'), 3, 'one estimate over both layers would differ');
  const { cwd } = freshUserData(t, K);
  ok(await addTaste(cwd, 'user', cjk(10)));
  ok(await addTaste(cwd, 'project', cjk(20)));
  assert.deepEqual((await K.list(cwd, 'project', 'taste')).usage, { used: 32, limit: 500, user: 11, project: 21 });
  assert.deepEqual((await K.list(cwd, 'user', 'taste')).usage, { used: 11, limit: 500, user: 11, project: 0 });
});

test('MEM-07 the budget rule: 500 is allowed, 501 is refused (pure)', () => {
  const user = [cjk(200, '甲'), cjk(200, '乙')];
  assert.equal(S.layerUsage(user), 402);
  assert.equal(R.budgetError('taste', 'project', user, [cjk(97)], []), null);
  assert.equal(R.budgetError('taste', 'project', user, [cjk(98)], []), over('TASTE', 402, 'this project', 99));
  const others = [{ cwd: 'D:\\a', abstracts: [cjk(200), cjk(98)] }];
  assert.equal(R.budgetError('strategy', 'user', [cjk(199)], [], others), null);
  assert.equal(R.budgetError('strategy', 'user', [cjk(199), 'x'], [], others),
    over('STRATEGY', 201, 'project D:\\a', 300));
  assert.equal(R.budgetError('review', 'project', [], [cjk(499)], []), null);
  assert.ok(R.budgetError('review', 'user', [cjk(500)], [], [])
    .startsWith('Over the 500-token limit for REVIEW: user 501'),
    'the user level alone over 500 is refused too');
});

test('MEM-07 exactly 500 tokens is allowed; 501 is refused with the sum and nothing is written', async (t) => {
  const { cwd, memoryRoot, events } = freshUserData(t, K);
  ok(await addTaste(cwd, 'user', cjk(200, '甲')));
  ok(await addTaste(cwd, 'user', cjk(200, '乙')));
  assert.equal((await K.list(cwd, 'project', 'taste')).usage.used, 402);
  const before = snapshotDir(memoryRoot);
  const eventCount = events.length;
  const refused = await addTaste(cwd, 'project', cjk(98, '丙'));
  assert.equal(refused.error, over('TASTE', 402, 'this project', 99));
  assert.equal(refused.revision, null);
  assert.deepEqual(snapshotDir(memoryRoot), before, 'nothing was written');
  assert.equal(events.length, eventCount, 'no memory_changed for a refused write');
  ok(await addTaste(cwd, 'project', cjk(97, '丙')));
  assert.deepEqual((await K.list(cwd, 'project', 'taste')).usage, { used: 500, limit: 500, user: 402, project: 98 });
  const update = await K.update(PAGE, { target: { cwd, layer: 'project', kind: 'taste',
    id: (await K.list(cwd, 'project', 'taste')).entries[0].id }, abstract: cjk(98, '丙'), note: '' });
  assert.equal(update.error, over('TASTE', 402, 'this project', 99), 'a longer abstract is checked as well');
});

test('MEM-07 a user-level write that pushes another project over 500 is refused and names it', async (t) => {
  const { userData, cwd, memoryRoot } = freshUserData(t, K);
  const other = join(userData, 'work', 'other');
  ok(await addTaste(other, 'project', cjk(200, '甲')));
  ok(await addTaste(other, 'project', cjk(98, '乙')));
  ok(await addTaste(cwd, 'user', cjk(199, '丙')));
  const before = snapshotDir(memoryRoot);
  const refused = await addTaste(cwd, 'user', cjk(1, '丁'));
  assert.equal(refused.error, over('TASTE', 202, `project ${other}`, 300));
  assert.equal((await addTaste(null, 'user', cjk(1, '丁'))).error, over('TASTE', 202, `project ${other}`, 300),
    'the same from the User view without a project');
  assert.deepEqual(snapshotDir(memoryRoot), before);
  ok(await addTaste(cwd, 'project', cjk(5, '戊')));
  assert.equal((await addTaste(cwd, 'user', cjk(1, '丁'))).error, over('TASTE', 202, `project ${other}`, 300),
    'projects are checked one by one; this project is fine, the other is not');
});

test('MEM-07 moving to the user level checks every project’s budget', async (t) => {
  const { userData, cwd, memoryRoot } = freshUserData(t, K);
  const other = join(userData, 'work', 'other');
  ok(await addTaste(other, 'project', cjk(200, '甲')));
  ok(await addTaste(other, 'project', cjk(98, '乙')));
  ok(await addTaste(cwd, 'user', cjk(199, '丙')));
  const moving = ok(await addTaste(cwd, 'project', cjk(50, '戊')));
  const before = snapshotDir(memoryRoot);
  const refused = await K.move(PAGE, cwd, 'project', moving.id);
  assert.equal(refused.error, over('TASTE', 251, `project ${other}`, 300));
  assert.deepEqual(snapshotDir(memoryRoot), before, 'nothing moved');
  assert.deepEqual((await K.list(cwd, 'project', 'taste')).entries.map((row) => row.id), [moving.id]);
});

test('MEM-07 moving back to this project checks the budget as well', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  // 用户级 [A, U]：中日韩 199，其余 8 → 201；本项目 [P1, P2]：中日韩 297，其余 8 → 299；合计 500
  ok(await addTaste(cwd, 'user', `${cjk(199, '甲')}a`));
  const u = ok(await addTaste(cwd, 'user', 'xx'));
  ok(await addTaste(cwd, 'project', cjk(200, '乙')));
  ok(await addTaste(cwd, 'project', `${cjk(97, '丙')}abc`));
  assert.equal((await K.list(cwd, 'project', 'taste')).usage.used, 500);
  const before = snapshotDir(memoryRoot);
  // 放回之后：用户级 [A] → 200；本项目 [P1, P2, U]：中日韩 297，其余 13 → 301；合计 501
  const refused = await K.move(PAGE, cwd, 'user', u.id);
  assert.equal(refused.error, over('TASTE', 200, 'this project', 301));
  assert.deepEqual(snapshotDir(memoryRoot), before, 'nothing moved');
});

test('MEM-07 rolling back is checked against the budget and refused when it would go over', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  ok(await addTaste(cwd, 'user', cjk(200, '甲')));
  ok(await addTaste(cwd, 'user', cjk(200, '乙')));
  const first = ok(await addTaste(cwd, 'project', cjk(90, '丙')));
  const removed = ok(await K.forget(PAGE, { target: { cwd, layer: 'project', id: first.id }, note: '' }));
  ok(await addTaste(cwd, 'project', cjk(97, '丁')));
  const before = snapshotDir(memoryRoot);
  const refused = await K.rollback(ROLLBACK, cwd, 'project', removed.revision);
  assert.equal(refused.error, over('TASTE', 402, 'this project', 189));
  assert.deepEqual(snapshotDir(memoryRoot), before, 'nothing was restored');
});

test('MEM-07 hand-edited entries over the limit all go into the prompt; only deleting still works', async (t) => {
  const { cwd } = freshUserData(t, K);
  const dir = seedProject(K, cwd);
  // synthetic：手改的索引，三条 200 个中日韩字符的条目，合计 602
  seedKind(dir, 'taste', [{ slug: 'a', abstract: cjk(200, '甲') }, { slug: 'b', abstract: cjk(200, '乙') },
    { slug: 'c', abstract: cjk(200, '丙') }]);
  const snapshot = await K.abstracts(cwd);
  assert.deepEqual(snapshot.project.taste, [cjk(200, '甲'), cjk(200, '乙'), cjk(200, '丙')], 'not cut');
  const listed = await K.list(cwd, 'project', 'taste');
  assert.deepEqual(listed.usage, { used: 602, limit: 500, user: 0, project: 602 });
  assert.equal((await addTaste(cwd, 'project', 'x')).error, over('TASTE', 0, 'this project', 603));
  const edit = await K.update(PAGE, { target: { cwd, layer: 'project', id: 'a' }, detail: 'More', note: '' });
  assert.equal(edit.error, over('TASTE', 0, 'this project', 602), 'the next write of this kind is refused');
  ok(await K.forget(PAGE, { target: { cwd, layer: 'project', id: 'a' }, note: '' }));
  assert.equal((await K.list(cwd, 'project', 'taste')).usage.used, 402);
});
