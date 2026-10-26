// 修订记录（docs/specs/memory.md §3.3、§6.5、§6.7、§9.8，验收 MEM-08 的单元层）：一次工具调用、一次记忆页保存/修改/删除/移动、
// 一次回滚、一次增强运行各一条；移动写进两层；frontmatter 的 kinds、counts；列表时间倒序、最多 200 条；每处改动的前后原文与
// 依据或说明；记忆页修改与移动的固定文字；detail 里单独一行 ~~~~ 时能解析、回滚后逐字相同；增强写入进行中记忆页的写入按调用
// 顺序；修订写失败时返回原因、条目改动保留；Running、Failed、Rollback 与 No changes；增强运行的日子、会话数、反馈数、token。
// 依据、手写的修订文件为 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  MORI, PAGE, ROLLBACK, enhancer, freshUserData, loadMemoryKernel, monDay, ok, revisionIds, seedKind, seedProject,
  todayKey,
} from './core-helpers.mjs';

const R = await loadKernelModule('src/kernel/memoryRules.ts');
const S = await loadKernelModule('src/shared/memory.ts');
const K = await loadMemoryKernel();

/** synthetic：对话里记下的依据（§7.3） */
const SESSION = (quote) => ({ at: '2026-10-22', session: 'C:\\work\\s.jsonl', entry: 'e1', title: 'Setup', quote });
/** synthetic：增强运行的反馈依据 */
const FEEDBACK = (name, quote) => ({ at: '2026-10-24', feedback: name, quote });

/** @brief 一次修订的全文。 */
async function revisionOf(cwd, layer, id) {
  const { revision, error } = await K.revision(layer === 'user' ? null : cwd, layer, id);
  assert.equal(error, null);
  return revision;
}

test('MEM-08 one revision for each tool call, page save, edit, delete, move and rollback', async (t) => {
  const { cwd, userBase } = freshUserData(t, K);
  const projectIds = () => revisionIds(K.projectDir(cwd).dir);
  const fact = ok(await K.save(MORI, { cwd, layer: 'project', kind: 'fact', abstract: 'Intranet model is at 10.0.0.9',
    detail: '', evidence: [SESSION('note it')] }));
  const taste = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'Lead with the conclusion',
    detail: '', evidence: [] }));
  const edit = ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: taste.id },
    abstract: 'Lead with the answer', note: '' }));
  const removed = ok(await K.forget(PAGE, { target: { cwd, layer: 'project', id: fact.id }, note: '' }));
  assert.deepEqual(projectIds(), [fact.revision, taste.revision, edit.revision, removed.revision]);
  assert.deepEqual(revisionIds(userBase), []);
  const titles = [];
  for (const id of projectIds()) {
    const revision = await revisionOf(cwd, 'project', id);
    titles.push(`${revision.by} | ${revision.title}`);
  }
  assert.deepEqual(titles, ['Mori | Mori · Added Facts: Intranet model is at 10.0.0.9',
    'You | You · Added TASTE: Lead with the conclusion', 'You | You · Changed TASTE: Lead with the answer',
    'You | You · Deleted Facts: Intranet model is at 10.0.0.9']);
  const moved = ok(await K.move(PAGE, cwd, 'project', taste.id));
  assert.equal(projectIds().at(-1), moved.revision);
  assert.deepEqual(revisionIds(userBase), [moved.revision], 'a move is written into both layers');
  const projectText = readFileSync(join(K.projectDir(cwd).dir, 'revisions', `${moved.revision}.md`), 'utf8');
  assert.equal(readFileSync(join(userBase, 'revisions', `${moved.revision}.md`), 'utf8'), projectText);
  assert.equal((await revisionOf(cwd, 'user', moved.revision)).title,
    'You · Moved to user level: Lead with the answer');
  const back = ok(await K.rollback(ROLLBACK, cwd, 'user', moved.revision));
  assert.deepEqual(revisionIds(userBase), [moved.revision, back.revision]);
  assert.equal(projectIds().length, 6);
  const rollback = await revisionOf(cwd, 'project', back.revision);
  assert.equal(rollback.by, 'Rollback');
  assert.equal(rollback.title, 'Rolled back: You · Moved to user level: Lead with the answer');
  assert.equal(rollback.rollbackOf, moved.revision);
  const long = 'A fact whose abstract is much longer than sixty characters, so the title cuts it';
  const cut = ok(await K.save(MORI, { cwd, layer: 'project', kind: 'fact', abstract: long, detail: '',
    evidence: [SESSION('q')] }));
  assert.equal((await revisionOf(cwd, 'project', cut.revision)).title, `Mori · Added Facts: ${long.slice(0, 60)}`);
});

test('MEM-08 an enhancement run with several writes leaves exactly one revision', async (t) => {
  const { cwd } = freshUserData(t, K);
  const run = await K.beginRun({ cwd, task: 'strategy', day: '2026-10-23', sessions: 2, feedback: 1 });
  const dir = K.projectDir(cwd).dir;
  assert.deepEqual(revisionIds(dir), [run.id]);
  const enh = enhancer('strategy', run);
  const a = ok(await K.save(enh, { cwd, layer: 'project', kind: 'strategy', abstract: 'Plan big changes', detail: 'v1',
    evidence: [FEEDBACK('a.json', 'first')] }));
  const b = ok(await K.save(enh, { cwd, layer: 'project', kind: 'strategy', abstract: 'Small fixes go straight in',
    detail: '', evidence: [FEEDBACK('a.json', 'first')] }));
  ok(await K.update(enh, { target: { cwd, layer: 'project', kind: 'strategy', id: a.id }, detail: 'v2',
    note: 'Narrowed', evidence: [FEEDBACK('b.json', 'second')] }));
  assert.equal(a.revision, run.id);
  assert.equal(b.revision, run.id);
  assert.deepEqual(revisionIds(dir), [run.id], 'writes in a run go into its revision');
  const ended = await K.endRun(run, { status: 'done', tokens: 1234, notes: 'Summary' });
  assert.deepEqual(ended, { counts: { added: 2, changed: 0, deleted: 0, moved: 0 }, revision: run.id });
  assert.deepEqual(revisionIds(dir), [run.id]);
  const revision = await revisionOf(cwd, 'project', run.id);
  assert.deepEqual(revision.counts, { added: 2, changed: 0, deleted: 0, moved: 0 });
  assert.deepEqual(revision.kinds, ['strategy']);
  assert.deepEqual(revision.changes.map((change) => [change.action, change.to?.slug]), [['added', a.id],
    ['added', b.id]]);
  assert.equal(revision.changes[0].before, '');
  assert.equal(revision.changes[0].after, readFileSync(join(dir, 'entries', `${a.id}.md`), 'utf8'));
  assert.equal(revision.changes[0].evidence, 'Oct 24 · Feedback: “first”; Oct 24 · Feedback: “second”');
  assert.equal(revision.notes, 'Summary');
});

test('MEM-38 one entry changed and moved in one run is one section: the kind before the run, the last kind', () => {
  const place = { layer: 'project', slug: 'a' };
  const step = (kind, fromKind, before, after) => ({ action: before === '' ? 'added' : after === '' ? 'deleted'
    : 'changed', kind, ...(fromKind ? { fromKind } : {}), from: before === '' ? null : { ...place },
  to: after === '' ? null : { ...place }, before, after });
  const updateThenMove = R.mergeRunChange([step('taste', null, 'v0', 'v1')], step('review', 'taste', 'v1', 'v2'));
  assert.deepEqual(updateThenMove, [{ ...step('review', 'taste', 'v0', 'v2') }]);
  const moveThenUpdate = R.mergeRunChange([step('taste', 'fact', 'v0', 'v1')], step('taste', null, 'v1', 'v2'));
  assert.deepEqual(moveThenUpdate, [step('taste', 'fact', 'v0', 'v2')]);
  const thereAndBack = R.mergeRunChange([step('strategy', 'taste', 'v0', 'v1')], step('taste', 'strategy', 'v1', 'v2'));
  assert.deepEqual(thereAndBack, [step('taste', null, 'v0', 'v2')], 'moved back: a plain Changed');
  const moveThenDelete = R.mergeRunChange([step('taste', 'fact', 'v0', 'v1')], step('taste', null, 'v1', ''));
  assert.deepEqual(moveThenDelete, [step('fact', null, 'v0', '')], 'deleted from the kind it had before the run');
  const addThenMove = R.mergeRunChange([step('taste', null, '', 'v1')], step('review', 'taste', 'v1', 'v2'));
  assert.deepEqual(addThenMove, [step('review', null, '', 'v2')], 'added in the run: added to the last kind');
});

test('MEM-08 frontmatter kinds and counts follow the sections', async (t) => {
  const change = (action) => ({ action, kind: 'taste', from: null, to: null, before: '', after: '' });
  assert.deepEqual(R.countChanges([change('added'), change('added'), change('changed'), change('deleted'),
    change('moved')]), { added: 2, changed: 1, deleted: 1, moved: 1 });
  const { cwd } = freshUserData(t, K);
  const saved = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'review', abstract: 'Run the tests', detail: '',
    evidence: [] }));
  const added = await revisionOf(cwd, 'project', saved.revision);
  assert.deepEqual([added.layers, added.kinds, added.counts], [['project'], ['review'],
    { added: 1, changed: 0, deleted: 0, moved: 0 }]);
  const moved = ok(await K.move(PAGE, cwd, 'project', saved.id));
  const move = await revisionOf(cwd, 'user', moved.revision);
  assert.deepEqual([move.layers, move.kinds, move.counts, move.cwd], [['user', 'project'], ['review'],
    { added: 0, changed: 0, deleted: 0, moved: 1 }, cwd]);
  const removed = ok(await K.forget(PAGE, { target: { cwd: null, layer: 'user', id: moved.id }, note: '' }));
  const deleted = await revisionOf(cwd, 'user', removed.revision);
  assert.deepEqual([deleted.layers, deleted.counts, deleted.cwd], [['user'],
    { added: 0, changed: 0, deleted: 1, moved: 0 }, null]);
});

/** synthetic：只有 frontmatter 的修订文件（§3.3 的字段） */
function revisionFile(id) {
  return ['---', `id: ${JSON.stringify(id)}`, 'time: "2026-10-01T00:00:00.000+08:00"', 'by: "You"',
    `title: ${JSON.stringify(`You · Added Facts: ${id}`)}`, 'status: "done"', 'layers: ["user"]', 'kinds: ["fact"]',
    'counts: {"added":1,"changed":0,"deleted":0,"moved":0}', 'cwd: null', 'run: null', 'rollbackOf: null', '---',
    ''].join('\n');
}

test('MEM-08 the revision list is newest first and holds at most 200', async (t) => {
  const { userBase } = freshUserData(t, K);
  mkdirSync(join(userBase, 'revisions'), { recursive: true });
  const pad = (n) => String(n).padStart(2, '0');
  const ids = Array.from({ length: 205 },
    (_, i) => `20261001-00${pad(Math.floor(i / 60))}${pad(i % 60)}-a${String(i).padStart(3, '0')}`);
  for (const id of [...ids].reverse()) writeFileSync(join(userBase, 'revisions', `${id}.md`), revisionFile(id));
  const { revisions, error } = await K.revisions(null, 'user');
  assert.equal(error, null);
  assert.equal(revisions.length, 200);
  assert.deepEqual(revisions.map((row) => row.id), ids.slice(5).reverse());
  assert.equal((await K.list(null, 'user', 'fact')).last.id, ids[204], 'last change is the newest of this kind');
  assert.equal((await K.list(null, 'user', 'taste')).last, null);
});

test('MEM-08 a revision holds the before and after of each change and its evidence or note', async (t) => {
  const { cwd } = freshUserData(t, K);
  const saved = ok(await K.save(MORI, { cwd, layer: 'project', kind: 'fact', abstract: 'Port is 8080', detail: '',
    evidence: [SESSION('it runs on 8080')] }));
  const file = join(K.projectDir(cwd).dir, 'entries', `${saved.id}.md`);
  const v1 = readFileSync(file, 'utf8');
  const target = { cwd, layer: 'project', kind: 'fact', id: saved.id };
  const updated = ok(await K.update(MORI, { target, abstract: 'Port is 8081', note: 'The user corrected it',
    evidence: [SESSION('it is 8081'), FEEDBACK('f.json', 'wrong port')] }));
  const v2 = readFileSync(file, 'utf8');
  assert.ok(v2.endsWith(`## Revisions\n- ${monDay(todayKey())} · Mori: The user corrected it\n`));
  assert.deepEqual((await revisionOf(cwd, 'project', updated.revision)).changes, [{ action: 'changed', kind: 'fact',
    from: { layer: 'project', slug: saved.id }, to: { layer: 'project', slug: saved.id },
    evidence: 'Oct 22 · Session “Setup”: “it is 8081”; Oct 24 · Feedback: “wrong port”', note: 'The user corrected it',
    before: v1, after: v2 }]);
  const removed = ok(await K.forget(MORI, { target, note: 'Not true any more' }));
  assert.deepEqual((await revisionOf(cwd, 'project', removed.revision)).changes, [{ action: 'deleted', kind: 'fact',
    from: { layer: 'project', slug: saved.id }, to: null, note: 'Not true any more', before: v2, after: '' }]);
});

test('MEM-08 Memory page edits and moves write the fixed Revisions and Note lines', async (t) => {
  const { cwd } = freshUserData(t, K);
  const today = todayKey();
  const md = monDay(today);
  // synthetic：一条它学的条目
  seedKind(seedProject(K, cwd), 'taste', [{ slug: 'short-answers', abstract: 'Short answers', source: 'learned',
    created: '2026-10-20 · Enhancement' }]);
  const edit = ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: 'short-answers' },
    detail: 'Unless the user asks for depth.', note: 'whatever the page sends' }));
  let entry = (await K.get(cwd, 'project', 'short-answers')).entry;
  assert.deepEqual(entry.history, [`${md} · You: Edited on the Memory page`]);
  assert.equal(entry.source, 'user', 'an edited Learned entry becomes You said');
  assert.equal((await revisionOf(cwd, 'project', edit.revision)).changes[0].note, 'Edited on the Memory page');
  const up = ok(await K.move(PAGE, cwd, 'project', 'short-answers'));
  entry = (await K.get(cwd, 'user', up.id)).entry;
  assert.deepEqual(entry.history, [`${md} · You: Edited on the Memory page`, `${md} · You: Moved to user level`]);
  assert.deepEqual([entry.source, entry.modified, entry.created],
    ['user', `${today} · You`, '2026-10-20 · Enhancement']);
  assert.equal((await revisionOf(cwd, 'user', up.revision)).changes[0].note, 'Moved to user level');
  const down = ok(await K.move(PAGE, cwd, 'user', up.id));
  entry = (await K.get(cwd, 'project', down.id)).entry;
  assert.equal(entry.history.at(-1), `${md} · You: Moved to this project`);
  const back = await revisionOf(cwd, 'project', down.revision);
  assert.equal(back.title, 'You · Moved to this project: Short answers');
  assert.equal(back.changes[0].note, 'Moved to this project');
  const added = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'New', detail: '',
    evidence: [] }));
  assert.deepEqual((await K.get(cwd, 'project', added.id)).entry.history, [], 'adding writes no Revisions line');
  const removed = ok(await K.forget(PAGE, { target: { cwd, layer: 'project', id: added.id }, note: '' }));
  const deletion = (await revisionOf(cwd, 'project', removed.revision)).changes[0];
  assert.equal(deletion.note, undefined);
  assert.equal(deletion.evidence, undefined);
});

test('MEM-08 a detail with a lone ~~~~ line parses in its revision and rolls back to the same bytes', async (t) => {
  const { cwd } = freshUserData(t, K);
  const saved = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'review', abstract: 'Check fences',
    detail: 'Steps:\n~~~~\nnot a fence\n~~~~~\nend', evidence: [] }));
  const dir = K.projectDir(cwd).dir;
  const file = join(dir, 'entries', `${saved.id}.md`);
  const v1 = readFileSync(file, 'utf8');
  assert.ok(readFileSync(join(dir, 'revisions', `${saved.revision}.md`), 'utf8').includes('\n~~~~~~after\n---\n'));
  assert.equal((await revisionOf(cwd, 'project', saved.revision)).changes[0].after, v1);
  const edited = ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: saved.id }, detail: 'Changed',
    note: '' }));
  const change = (await revisionOf(cwd, 'project', edited.revision)).changes[0];
  assert.equal(change.before, v1);
  assert.equal(change.after, readFileSync(file, 'utf8'));
  ok(await K.rollback(ROLLBACK, cwd, 'project', edited.revision));
  assert.equal(readFileSync(file, 'utf8'), v1);
});

test('MEM-08 Memory page writes during an enhancement run are written in call order', async (t) => {
  const { cwd, events } = freshUserData(t, K);
  const run = await K.beginRun({ cwd, task: 'taste', day: todayKey(), sessions: 1, feedback: 0 });
  const enh = enhancer('taste', run);
  const evidence = [FEEDBACK('a.json', 'q')];
  events.splice(0);
  const results = await Promise.all([
    K.save(enh, { cwd, layer: 'project', kind: 'taste', abstract: 'First from the run', detail: '', evidence }),
    K.save(PAGE, { cwd: null, layer: 'user', kind: 'taste', abstract: 'From the page', detail: '', evidence: [] }),
    K.save(enh, { cwd, layer: 'project', kind: 'taste', abstract: 'Second from the run', detail: '', evidence }),
    K.update(PAGE, { target: { cwd: null, layer: 'user', id: 'from-the-page' }, detail: 'Edited', note: '' }),
  ]);
  for (const result of results) ok(result);
  assert.deepEqual(events.map((event) => [event.revision, event.layers]), [[run.id, ['project']],
    [results[1].revision, ['user']], [run.id, ['project']], [results[3].revision, ['user']]]);
  assert.ok(results[1].revision < results[3].revision);
  const index = readFileSync(join(K.projectDir(cwd).dir, 'TASTE.md'), 'utf8');
  assert.equal(index, '# TASTE\n- [First from the run](entries/first-from-the-run.md)\n'
    + '- [Second from the run](entries/second-from-the-run.md)\n');
  await K.endRun(run, { status: 'done', tokens: 0, notes: null });
});

test('MEM-08 a revision that can’t be written gives its reason and keeps the entry change', async (t) => {
  const { userBase } = freshUserData(t, K);
  mkdirSync(userBase, { recursive: true });
  writeFileSync(join(userBase, 'revisions'), 'synthetic: a file where the revisions folder should be\n');
  const result = await K.save(PAGE, { cwd: null, layer: 'user', kind: 'fact', abstract: 'Kept anyway', detail: '',
    evidence: [] });
  assert.match(result.error, /^The revision wasn’t written: \S/);
  assert.equal(result.revision, null);
  assert.equal(readFileSync(join(userBase, 'MEMORY.md'), 'utf8'), '# Facts\n- [Kept anyway](entries/kept-anyway.md)\n');
  // 拿掉挡路的文件（它也挡住了读修订列表），条目照常列出
  rmSync(join(userBase, 'revisions'));
  assert.deepEqual((await K.list(null, 'user', 'fact')).entries.map((row) => row.id), ['kept-anyway']);
  assert.deepEqual((await K.revisions(null, 'user')).revisions, [], 'that change has no revision');
});

test('MEM-08 revision rows carry running, failed and rollback, and counts read as text', async (t) => {
  assert.equal(S.countsText({ added: 1, changed: 2, deleted: 0, moved: 0 }), 'Added 1, changed 2');
  assert.equal(S.countsText({ added: 0, changed: 0, deleted: 1, moved: 0 }), 'Deleted 1');
  assert.equal(S.countsText({ added: 0, changed: 0, deleted: 0, moved: 0 }), 'No changes');
  const { cwd } = freshUserData(t, K);
  const run = await K.beginRun({ cwd, task: 'review', day: '2026-10-23', sessions: 1, feedback: 0 });
  let [row] = (await K.revisions(cwd, 'project')).revisions;
  assert.deepEqual([row.id, row.status, row.by, S.countsText(row.counts)], [run.id, 'running', 'Enhancement',
    'No changes']);
  await K.endRun(run, { status: 'failed', tokens: 10, notes: 'Endpoint error' });
  [row] = (await K.revisions(cwd, 'project')).revisions;
  assert.equal(row.status, 'failed');
  const saved = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'review', abstract: 'A', detail: '',
    evidence: [] }));
  const back = ok(await K.rollback(ROLLBACK, cwd, 'project', saved.revision));
  const rows = (await K.revisions(cwd, 'project')).revisions;
  assert.deepEqual(rows.map((each) => each.id), [back.revision, saved.revision, run.id]);
  assert.deepEqual([rows[0].by, rows[0].rollbackOf, rows[0].status], ['Rollback', saved.revision, 'done']);
  assert.equal(rows[1].rollbackOf, null);
});

test('MEM-08 an enhancement run revision records its day, sessions, feedback, tokens and notes', async (t) => {
  const { cwd } = freshUserData(t, K);
  const run = await K.beginRun({ cwd, task: 'strategy', day: '2026-10-23', sessions: 2, feedback: 1 });
  let revision = await revisionOf(cwd, 'project', run.id);
  assert.deepEqual([revision.title, revision.by, revision.status, revision.layers, revision.kinds, revision.cwd],
    ['STRATEGY enhancement · Oct 23', 'Enhancement', 'running', ['project'], ['strategy'], cwd]);
  assert.deepEqual(revision.run, { task: 'strategy', day: '2026-10-23', tokens: null, sessions: 2, feedback: 1 });
  const saved = ok(await K.save(enhancer('strategy', run), { cwd, layer: 'project', kind: 'strategy',
    abstract: 'Plan first', detail: '', evidence: [FEEDBACK('a.json', 'q')] }));
  const entry = (await K.get(cwd, 'project', saved.id)).entry;
  assert.deepEqual([entry.source, entry.created, entry.modified], ['learned', '2026-10-23 · Enhancement',
    '2026-10-23 · Enhancement']);
  await K.endRun(run, { status: 'done', tokens: 38214, notes: 'x'.repeat(4100) });
  revision = await revisionOf(cwd, 'project', run.id);
  assert.equal(revision.status, 'done');
  assert.equal(revision.run.tokens, 38214);
  assert.ok(revision.notes.startsWith('x'.repeat(4000)), 'the first 4000 characters are kept');
  assert.ok(!revision.notes.includes('x'.repeat(4001)), 'the rest is cut');
  assert.ok(revision.notes.endsWith('(truncated)'));
  const other = await K.beginRun({ cwd, task: 'taste', day: '2026-10-23', sessions: 1, feedback: 0 });
  await K.endRun(other, { status: 'done', tokens: 5, notes: 'No changes needed.' });
  assert.equal((await revisionOf(cwd, 'project', other.id)).notes, 'No changes needed.');
});
