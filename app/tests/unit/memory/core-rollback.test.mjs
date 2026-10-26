// 回滚（docs/specs/memory.md §6.6，验收 MEM-09 的单元层）：新增回滚为删除、删除回滚为恢复（加在末尾）、修改恢复原文与 source；
// 提升、放回被回滚：回到原层（末尾、同名加后缀、source 恢复），目标层不再有它，回滚移动的修订写进两层、可以再回滚；
// 之后又被改过时整次拒绝、原因写出那次修订；超出预算时拒绝；回滚写一条 Rollback 修订、可以再回滚；运行中的修订不能回滚；
// 水位不动；修订标题里的 slug 不能用作文件名时这次修订读不出来、回滚不碰任何文件。
// 手写的条目、手改的修订与 enhance.json 为 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MORI, PAGE, ROLLBACK, cjk, enhancer, freshUserData, loadMemoryKernel, ok, revisionIds, seedKind, seedProject,
  snapshotDir,
} from './core-helpers.mjs';

const K = await loadMemoryKernel();

/** @brief 一层一种的索引原文。 */
function indexText(base, file = 'TASTE.md') {
  return readFileSync(join(base, file), 'utf8');
}

/** @brief 一层里一条的 detail 原文；不存在时为 null。 */
function entryText(base, slug) {
  const path = join(base, 'entries', `${slug}.md`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** @brief 记忆页新增一条。 */
function add(cwd, layer, kind, abstract, detail = '') {
  return K.save(PAGE, { cwd, layer, kind, abstract, detail, evidence: [] });
}

/** @brief 一次修订的全文。 */
async function revisionOf(cwd, layer, id) {
  return (await K.revision(layer === 'user' ? null : cwd, layer, id)).revision;
}

test('MEM-09 rolling back an add deletes the entry and its index line', async (t) => {
  const { cwd } = freshUserData(t, K);
  const a = ok(await add(cwd, 'project', 'taste', 'Keep A'));
  ok(await add(cwd, 'project', 'taste', 'Keep B'));
  const dir = K.projectDir(cwd).dir;
  const textA = entryText(dir, a.id);
  const back = ok(await K.rollback(ROLLBACK, cwd, 'project', a.revision));
  assert.equal(indexText(dir), '# TASTE\n- [Keep B](entries/keep-b.md)\n');
  assert.equal(entryText(dir, a.id), null);
  const revision = await revisionOf(cwd, 'project', back.revision);
  assert.deepEqual([revision.by, revision.rollbackOf, revision.title], ['Rollback', a.revision,
    'Rolled back: You · Added TASTE: Keep A']);
  assert.deepEqual(revision.changes, [{ action: 'deleted', kind: 'taste', from: { layer: 'project', slug: a.id },
    to: null, before: textA, after: '' }]);
});

test('MEM-09 rolling back a delete restores the entry at the end of the index, byte for byte', async (t) => {
  const { cwd } = freshUserData(t, K);
  const dir = seedProject(K, cwd);
  seedKind(dir, 'strategy', [{ slug: 'a', abstract: 'Alpha', source: 'learned', details: 'Why: [[b]]' },
    { slug: 'b', abstract: 'Beta' }, { slug: 'c', abstract: 'Gamma' }]);
  const original = entryText(dir, 'a');
  const removed = ok(await K.forget(PAGE, { target: { cwd, layer: 'project', id: 'a' }, note: '' }));
  ok(await K.rollback(ROLLBACK, cwd, 'project', removed.revision));
  assert.equal(indexText(dir, 'STRATEGY.md'),
    '# STRATEGY\n- [Beta](entries/b.md)\n- [Gamma](entries/c.md)\n- [Alpha](entries/a.md)\n');
  assert.equal(entryText(dir, 'a'), original);
  assert.equal((await K.get(cwd, 'project', 'a')).entry.source, 'learned');
});

test('MEM-09 rolling back a change restores the text and the source', async (t) => {
  const { cwd } = freshUserData(t, K);
  const dir = seedProject(K, cwd);
  seedKind(dir, 'strategy', [{ slug: 'plan', abstract: 'Plan big changes', source: 'learned', details: 'v1' }]);
  const original = entryText(dir, 'plan');
  const index = indexText(dir, 'STRATEGY.md');
  const changed = ok(await K.update(MORI, { target: { cwd, layer: 'project', id: 'plan' },
    abstract: 'Plan changes over three modules', detail: 'v2', note: 'The user said so', asked: true,
    evidence: [{ at: '2026-10-22', session: 'C:\\s.jsonl', entry: 'e1', title: 'T', quote: 'only big ones' }] }));
  assert.equal((await K.get(cwd, 'project', 'plan')).entry.source, 'user');
  ok(await K.rollback(ROLLBACK, cwd, 'project', changed.revision));
  assert.equal(entryText(dir, 'plan'), original);
  assert.equal((await K.get(cwd, 'project', 'plan')).entry.source, 'learned');
  assert.equal(indexText(dir, 'STRATEGY.md'), index);
});

test('MEM-09 rolling back a promotion returns the entry to the end of its project, with a suffix if taken',
  async (t) => {
    const { cwd, userBase } = freshUserData(t, K);
    const dir = seedProject(K, cwd);
    seedKind(dir, 'taste', [{ slug: 'a', abstract: 'Alpha', source: 'learned' }, { slug: 'b', abstract: 'Beta' }]);
    const original = entryText(dir, 'a');
    const up = ok(await K.move(PAGE, cwd, 'project', 'a'));
    const moved = entryText(userBase, up.id);
    assert.equal((await add(cwd, 'project', 'taste', 'A')).id, 'a', 'the slug is free again in the project');
    const back = ok(await K.rollback(ROLLBACK, cwd, 'project', up.revision));
    assert.equal(indexText(dir), '# TASTE\n- [Beta](entries/b.md)\n- [A](entries/a.md)\n- [Alpha](entries/a-2.md)\n');
    assert.equal(entryText(dir, 'a-2'), original, 'back with its old source and text');
    assert.equal(entryText(userBase, up.id), null);
    assert.deepEqual((await K.list(null, 'user', 'taste')).entries, []);
    assert.ok(revisionIds(userBase).includes(back.revision) && revisionIds(dir).includes(back.revision),
      'the rollback of a move is written into both layers');
    const revision = await revisionOf(cwd, 'user', back.revision);
    assert.deepEqual(revision.changes.map((change) => [change.action, change.from, change.to]), [['moved',
      { layer: 'user', slug: 'a' }, { layer: 'project', slug: 'a-2' }]]);
    ok(await K.rollback(ROLLBACK, cwd, 'project', back.revision));
    assert.equal(entryText(userBase, 'a'), moved, 'rolled back again: at the user level once more');
    assert.equal(entryText(dir, 'a-2'), null);
  });

test('MEM-09 rolling back a demotion returns the entry to the end of the user level', async (t) => {
  const { cwd, userBase } = freshUserData(t, K);
  const first = ok(await add(cwd, 'user', 'review', 'Run the tests'));
  ok(await add(cwd, 'user', 'review', 'Read the output'));
  const original = entryText(userBase, first.id);
  const down = ok(await K.move(PAGE, cwd, 'user', first.id));
  assert.deepEqual((await K.list(cwd, 'project', 'review')).entries.map((row) => row.id), [down.id]);
  ok(await K.rollback(ROLLBACK, cwd, 'user', down.revision));
  assert.equal(indexText(userBase, 'REVIEW.md'),
    '# REVIEW\n- [Read the output](entries/read-the-output.md)\n- [Run the tests](entries/run-the-tests.md)\n');
  assert.equal(entryText(userBase, first.id), original);
  assert.deepEqual((await K.list(cwd, 'project', 'review')).entries, []);
});

test('MEM-09 an entry changed later refuses the whole rollback and names that revision', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const first = ok(await add(cwd, 'project', 'taste', 'Lead with the conclusion', 'v1'));
  const edit = ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: first.id }, detail: 'v2', note: '' }));
  const before = snapshotDir(memoryRoot);
  const refused = await K.rollback(ROLLBACK, cwd, 'project', first.revision);
  assert.equal(refused.error, '“Lead with the conclusion” changed later '
    + '(You · Changed TASTE: Lead with the conclusion). Roll back that revision first.');
  assert.deepEqual(snapshotDir(memoryRoot), before, 'nothing changed');
  ok(await K.rollback(ROLLBACK, cwd, 'project', edit.revision));
  ok(await K.rollback(ROLLBACK, cwd, 'project', first.revision));
  assert.deepEqual((await K.list(cwd, 'project', 'taste')).entries, []);
  const hand = ok(await add(cwd, 'project', 'taste', 'Zed'));
  const file = join(K.projectDir(cwd).dir, 'entries', `${hand.id}.md`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}hand edit\n`);
  assert.equal((await K.rollback(ROLLBACK, cwd, 'project', hand.revision)).error, '“Zed” changed later.');
});

test('MEM-09 a revision heading whose slug leaves the memory folder is unreadable and touches nothing', async (t) => {
  const { cwd, userData, memoryRoot } = freshUserData(t, K);
  const dir = K.projectDir(cwd).dir;
  const added = ok(await add(cwd, 'project', 'taste', 'Keep A'));
  const kept = ok(await add(cwd, 'project', 'taste', 'Keep B'));
  const moved = ok(await K.move(PAGE, cwd, 'project', kept.id));
  const slug = '../../../../outside';
  const outside = join(dir, 'entries', `${slug}.md`);
  assert.ok(outside.startsWith(userData) && !outside.startsWith(memoryRoot), outside);
  // synthetic：手改的修订标题指向记忆目录以外，那里的文件内容与 after 块相同
  writeFileSync(outside, entryText(dir, added.id));
  const edit = (id, from, to) => {
    const file = join(dir, 'revisions', `${id}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
  };
  edit(added.revision, `## Added · TASTE · ${added.id}\n`, `## Added · TASTE · ${slug}\n`);
  edit(moved.revision, `→ ${moved.id}\n`, `→ ..\\${moved.id}\n`);
  const before = snapshotDir(memoryRoot);
  for (const [id, line] of [[added.revision, `## Added · TASTE · ${slug}`],
    [moved.revision, `## Moved to user level · TASTE · ${kept.id} → ..\\${moved.id}`]]) {
    const reason = `The slug in “${line}” isn’t a valid file name.`;
    assert.deepEqual(await K.revision(cwd, 'project', id), { revision: null, error: reason });
    assert.equal((await K.rollback(ROLLBACK, cwd, 'project', id)).error, reason);
  }
  assert.equal(readFileSync(outside, 'utf8'), entryText(dir, added.id), 'the file outside is still there');
  assert.deepEqual(snapshotDir(memoryRoot), before, 'nothing changed');
});

test('MEM-09 with two later changes the refusal names the earliest of them', async (t) => {
  const { cwd } = freshUserData(t, K);
  const first = ok(await add(cwd, 'project', 'strategy', 'Plan first', 'v1'));
  const target = { cwd, layer: 'project', id: first.id };
  ok(await K.update(MORI, { target, detail: 'v2', note: 'Second thoughts',
    evidence: [{ at: '2026-10-22', session: 'C:\\s.jsonl', entry: 'e1', title: 'T', quote: 'q' }] }));
  ok(await K.update(PAGE, { target, detail: 'v3', note: '' }));
  assert.equal((await K.rollback(ROLLBACK, cwd, 'project', first.revision)).error,
    '“Plan first” changed later (Mori · Changed STRATEGY: Plan first). Roll back that revision first.');
});

test('MEM-09 a moved entry edited at its new level refuses rolling back the move', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const saved = ok(await add(cwd, 'project', 'taste', 'Be brief'));
  const up = ok(await K.move(PAGE, cwd, 'project', saved.id));
  ok(await K.update(PAGE, { target: { cwd: null, layer: 'user', id: up.id }, detail: 'Edited up here', note: '' }));
  const before = snapshotDir(memoryRoot);
  const refused = await K.rollback(ROLLBACK, cwd, 'project', up.revision);
  assert.equal(refused.error,
    '“Be brief” changed later (You · Changed TASTE: Be brief). Roll back that revision first.');
  assert.deepEqual(snapshotDir(memoryRoot), before);
});

test('MEM-09 a run with one entry changed later is refused as a whole', async (t) => {
  const { cwd } = freshUserData(t, K);
  const run = await K.beginRun({ cwd, task: 'taste', day: '2026-10-23', sessions: 1, feedback: 0 });
  const enh = enhancer('taste', run);
  const evidence = [{ at: '2026-10-23', feedback: 'a.json', quote: 'q' }];
  const x = ok(await K.save(enh, { cwd, layer: 'project', kind: 'taste', abstract: 'X', detail: '', evidence }));
  const y = ok(await K.save(enh, { cwd, layer: 'project', kind: 'taste', abstract: 'Y', detail: '', evidence }));
  await K.endRun(run, { status: 'done', tokens: 0, notes: null });
  ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: y.id }, detail: 'Mine now', note: '' }));
  const refused = await K.rollback(ROLLBACK, cwd, 'project', run.id);
  assert.equal(refused.error, '“Y” changed later (You · Changed TASTE: Y). Roll back that revision first.');
  assert.deepEqual((await K.list(cwd, 'project', 'taste')).entries.map((row) => row.id), [x.id, y.id]);
});

test('MEM-09 a rollback that would go over the budget is refused', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  ok(await add(cwd, 'user', 'taste', cjk(200, '甲')));
  ok(await add(cwd, 'user', 'taste', cjk(200, '乙')));
  const long = ok(await add(cwd, 'project', 'taste', cjk(97, '丙')));
  const shorter = ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: long.id }, abstract: cjk(10, '丙'),
    note: '' }));
  ok(await add(cwd, 'project', 'taste', cjk(80, '丁')));
  const before = snapshotDir(memoryRoot);
  const refused = await K.rollback(ROLLBACK, cwd, 'project', shorter.revision);
  assert.equal(refused.error, 'Over the 500-token limit for TASTE: user 402 + this project 179 = 581. '
    + 'Merge or delete entries first.');
  assert.deepEqual(snapshotDir(memoryRoot), before);
});

test('MEM-09 a rollback writes a Rollback revision that can be rolled back again', async (t) => {
  const { cwd } = freshUserData(t, K);
  const dir = K.projectDir(cwd).dir;
  const a = ok(await add(cwd, 'project', 'fact', 'Alpha', 'details'));
  const original = entryText(dir, a.id);
  const first = ok(await K.rollback(ROLLBACK, cwd, 'project', a.revision));
  assert.equal(entryText(dir, a.id), null);
  const second = ok(await K.rollback(ROLLBACK, cwd, 'project', first.revision));
  assert.equal(entryText(dir, a.id), original);
  assert.equal(indexText(dir, 'MEMORY.md'), '# Facts\n- [Alpha](entries/alpha.md)\n');
  const rows = (await K.revisions(cwd, 'project')).revisions;
  assert.deepEqual(rows.map((row) => [row.by, row.title, row.rollbackOf]), [
    ['Rollback', 'Rolled back: Rolled back: You · Added Facts: Alpha', first.revision],
    ['Rollback', 'Rolled back: You · Added Facts: Alpha', a.revision],
    ['You', 'You · Added Facts: Alpha', null]]);
  assert.equal(rows[0].id, second.revision);
});

test('MEM-09 a revision whose run is still going can’t be rolled back; a finished or failed one can', async (t) => {
  const { cwd } = freshUserData(t, K);
  const evidence = [{ at: '2026-10-23', feedback: 'a.json', quote: 'q' }];
  for (const status of ['done', 'failed']) {
    const run = await K.beginRun({ cwd, task: 'review', day: '2026-10-23', sessions: 1, feedback: 1 });
    const saved = ok(await K.save(enhancer('review', run), { cwd, layer: 'project', kind: 'review',
      abstract: `Check ${status}`, detail: '', evidence }));
    const refused = await K.rollback(ROLLBACK, cwd, 'project', run.id);
    assert.equal(refused.error, 'This revision’s run is still going.');
    assert.equal(refused.revision, null);
    await K.endRun(run, { status, tokens: 1, notes: null });
    ok(await K.rollback(ROLLBACK, cwd, 'project', run.id));
    assert.equal((await K.get(cwd, 'project', saved.id)).entry, null, status);
  }
});

test('MEM-09 rolling back leaves the enhancement watermarks alone', async (t) => {
  const { cwd } = freshUserData(t, K);
  const dir = seedProject(K, cwd);
  const task = (doneThrough, watermarks) => ({ doneThrough, watermarks, feedbackSeen: null, running: null,
    last: null });
  // synthetic：enhance.json（§9.1 的字段），水位指向一个会话文件的条目
  const settings = { enabled: true, pick: 'cloud', thinking: 'medium', team: false, time: '04:00',
    since: '2026-10-20', tasks: { taste: task('2026-10-22', { 'C:\\work\\s.jsonl': 'e9' }),
      strategy: task('2026-10-22', {}), review: task('2026-10-22', {}) }, notice: null };
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  writeFileSync(join(dir, 'enhance.json'), text);
  const run = await K.beginRun({ cwd, task: 'taste', day: '2026-10-22', sessions: 1, feedback: 0 });
  ok(await K.save(enhancer('taste', run), { cwd, layer: 'project', kind: 'taste', abstract: 'Learned one', detail: '',
    evidence: [{ at: '2026-10-22', feedback: 'a.json' }] }));
  await K.endRun(run, { status: 'done', tokens: 3, notes: null });
  ok(await K.rollback(ROLLBACK, cwd, 'project', run.id));
  assert.equal(readFileSync(join(dir, 'enhance.json'), 'utf8'), text);
});
