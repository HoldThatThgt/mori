// 移到另一种（重新归类）的单元测试（docs/specs/memory.md §6.9、§7.1、§7.4、§9.8、MEM-38；2026-10-26，§0 第 5 条）：
// 增强任务的 memory move 把本项目 Mori 记的条目（source agent）移进或移出这次运行的种类：slug 与文件名不变、detail 的
// kind 改为目标种类、source 不变、## Revisions 一行、原种类的索引去掉、目标种类的索引末尾；不带依据可以，带了照样核对
// 并追加；目标种类超出 500 时拒绝且什么都不写；修订一节 `## Changed · <原> → <目标> · <slug>`、kinds 含两种；同一次运行
// 先改后移合成一节，移回原种类是普通的 Changed；回滚恢复原文与原种类。条目由 agent 调用方的工具写下（没给 asked），
// 会话文件是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE, callTool, freshUserData, loadTextKernel, localDay, ok, snapshotDir, writeSessionFile } from
  './text-helpers.mjs';

const K = await loadTextKernel();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = '2026-10-22';
const monDay = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;

/** @brief agent 调用方的工具（没给 asked：记下的条目算 Mori 记的）。 */
function agentTool(cwd) {
  return K.tool.memoryTool({ cwd, caller: { kind: 'agent' }, run: null, scope: null,
    position: () => ({ session: 'C:\\synthetic\\user.jsonl', entry: 'u1', title: 'Synthetic session' }) });
}

/** @brief synthetic：Mori 主动记下的一条，返回它的 id。 */
async function agentSaved(cwd, kind, abstract) {
  const result = await callTool(agentTool(cwd), { action: 'save', kind, abstract, quote: `${abstract} (said)` });
  assert.equal(result.isError, false, result.text);
  return result.details.entry;
}

/**
 * @brief synthetic：一次增强运行（beginRun）、一个列出的会话文件与这个任务的工具。
 * @param t node:test 的测试上下文
 * @param cwd 项目
 * @param task 任务
 */
async function enhancement(t, cwd, task) {
  const session = join(cwd, '..', 'sessions', 'listed.jsonl');
  writeSessionFile(session, cwd, [{ id: 'a1b2c3d4', role: 'user', text: 'no tables please',
    timestamp: '2026-10-22T09:00:00.000Z' }]);
  const run = await K.memory.beginRun({ cwd, task, day: DAY, sessions: 1, feedback: 0 });
  let ended = false;
  const end = async () => {
    ended = true;
    return K.memory.endRun(run, { status: 'done', tokens: 0, notes: null });
  };
  t.after(() => (ended ? undefined : end().catch(() => undefined)));
  const tool = K.tool.memoryTool({ cwd, caller: { kind: 'enhance', task }, run,
    scope: { sessions: [{ file: session, title: 'Listed' }], instanceFiles: [], feedback: [] },
    position: () => { throw new Error('an enhancement caller has no position'); } });
  return { tool, run, end, session };
}

/** @brief 一层一种的索引里的 slug（按顺序）。 */
async function indexSlugs(cwd, kind) {
  return (await K.memory.list(cwd, 'project', kind)).entries.map((entry) => entry.id);
}

test('MEM-38 move a fact added by Mori into this run’s kind: same slug and file, new kind, source agent, history, '
  + 'out of the Facts index, at the end of the STRATEGY index', async (t) => {
  const { cwd } = freshUserData(t, K);
  const first = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'strategy', abstract: 'Already here',
    detail: '', evidence: [] }));
  const id = await agentSaved(cwd, 'fact', 'Plan before big changes');
  const file = join(K.memory.projectDir(cwd).dir, 'entries', `${id}.md`);
  const before = readFileSync(file, 'utf8');
  const { tool, run, end } = await enhancement(t, cwd, 'strategy');
  const result = await callTool(tool, { action: 'move', entry: id, kind: 'strategy', note: 'a rule, not a fact' });
  assert.equal(result.text, 'Moved to STRATEGY (this project): Plan before big changes');
  assert.deepEqual(result.details, { revision: run.id, kind: 'strategy', layer: 'project', entry: id,
    action: 'move' });
  const detail = await K.memory.detailOf(cwd, 'project', id);
  assert.deepEqual([detail.kind, detail.source, detail.abstract, detail.file], ['strategy', 'agent',
    'Plan before big changes', file]);
  assert.equal(detail.modified, `${DAY} · Enhancement`);
  assert.equal(detail.history.at(-1), `${monDay(DAY)} · Enhancement: Moved from Facts to STRATEGY: a rule, not a fact`);
  assert.deepEqual(detail.evidence.map((item) => item.quote), ['Plan before big changes (said)'],
    'the evidence and the user\'s words are kept, nothing added');
  assert.deepEqual(await indexSlugs(cwd, 'fact'), []);
  assert.deepEqual(await indexSlugs(cwd, 'strategy'), [first.id, id]);
  await end();
  const revision = (await K.memory.revision(cwd, 'project', run.id)).revision;
  assert.deepEqual(revision.kinds, ['fact', 'strategy'], 'the run revision has both kinds');
  assert.deepEqual(revision.counts, { added: 0, changed: 1, deleted: 0, moved: 0 });
  const [change] = revision.changes;
  assert.deepEqual([change.action, change.fromKind, change.kind, change.before, change.after],
    ['changed', 'fact', 'strategy', before, readFileSync(file, 'utf8')]);
  assert.equal(change.note, 'Moved from Facts to STRATEGY: a rule, not a fact');
  const text = readFileSync(join(K.memory.projectDir(cwd).dir, 'revisions', `${run.id}.md`), 'utf8');
  assert.match(text, new RegExp(`^## Changed · Facts → STRATEGY · ${id}$`, 'm'));
});

test('MEM-38 move an entry of this run’s kind out to Facts; evidence is optional, checked and added when given',
  async (t) => {
    const { cwd, memoryRoot } = freshUserData(t, K);
    const id = await agentSaved(cwd, 'taste', 'The staging database is PostgreSQL 15');
    const { tool, session } = await enhancement(t, cwd, 'taste');
    const snapshot = snapshotDir(memoryRoot);
    const bad = await callTool(tool, { action: 'move', entry: id, kind: 'fact', note: 'a fact',
      evidence: [{ session, entry: 'zzzz0000' }] });
    assert.equal(bad.text, `Evidence 1 isn’t from this run’s material: entry zzzz0000 not in ${session}.`);
    assert.deepEqual(snapshotDir(memoryRoot), snapshot, 'nothing is written');
    const moved = await callTool(tool, { action: 'move', entry: id, kind: 'fact', note: 'a fact, not a taste',
      evidence: [{ session, entry: 'a1b2c3d4', quote: 'no tables please' }] });
    assert.equal(moved.text, 'Moved to Facts (this project): The staging database is PostgreSQL 15');
    const detail = await K.memory.detailOf(cwd, 'project', id);
    assert.deepEqual([detail.kind, detail.source], ['fact', 'agent']);
    assert.deepEqual(detail.evidence.map((item) => [item.entry, item.quote]), [['u1',
      'The staging database is PostgreSQL 15 (said)'], ['a1b2c3d4', 'no tables please']]);
    assert.equal(detail.evidence[1].at, localDay('2026-10-22T09:00:00.000Z'));
    assert.deepEqual(await indexSlugs(cwd, 'taste'), []);
    assert.deepEqual(await indexSlugs(cwd, 'fact'), [id]);
  });

test('MEM-38 a move that takes the target kind over 500 tokens is refused and nothing is written', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  for (let i = 0; i < 2; i += 1) {
    ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'strategy', abstract: '规'.repeat(200), detail: '',
      evidence: [] }));
  }
  const id = await agentSaved(cwd, 'fact', '则'.repeat(99));
  const { tool } = await enhancement(t, cwd, 'strategy');
  const before = snapshotDir(memoryRoot);
  const result = await callTool(tool, { action: 'move', entry: id, kind: 'strategy', note: 'n' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'Over the 500-token limit for STRATEGY: user 0 + this project 501 = 501. Merge or delete '
    + 'entries first.');
  assert.deepEqual(snapshotDir(memoryRoot), before);
});

test('MEM-38 in one run, update then move is one section from the kind before the run; moving back is a plain '
  + 'Changed', async (t) => {
  const { cwd } = freshUserData(t, K);
  const a = await agentSaved(cwd, 'taste', 'Taste that is really a review rule');
  const b = await agentSaved(cwd, 'taste', 'Taste moved and moved back');
  const { tool, run, end, session } = await enhancement(t, cwd, 'taste');
  const evidence = [{ session, entry: 'a1b2c3d4' }];
  const steps = [
    { action: 'update', entry: a, abstract: 'Run the tests before saying done', note: 'reworded', evidence },
    { action: 'move', entry: a, kind: 'review', note: 'a check, not a taste' },
    { action: 'move', entry: b, kind: 'strategy', note: 'maybe strategy' },
    { action: 'move', entry: b, kind: 'taste', note: 'no, it is a taste' },
  ];
  for (const args of steps) {
    const result = await callTool(tool, args);
    assert.equal(result.isError, false, `${JSON.stringify(args)}: ${result.text}`);
  }
  await end();
  const revision = (await K.memory.revision(cwd, 'project', run.id)).revision;
  const byId = Object.fromEntries(revision.changes.map((change) => [change.to?.slug, change]));
  assert.equal(revision.changes.length, 2, 'one section per entry');
  assert.deepEqual([byId[a].action, byId[a].fromKind, byId[a].kind], ['changed', 'taste', 'review']);
  assert.deepEqual([byId[b].action, byId[b].fromKind, byId[b].kind], ['changed', undefined, 'taste'],
    'moved there and back: a plain Changed in TASTE');
  assert.deepEqual(revision.kinds, ['taste', 'review']);
  assert.deepEqual(await indexSlugs(cwd, 'taste'), [b]);
  assert.deepEqual(await indexSlugs(cwd, 'review'), [a]);
});

test('MEM-38 rolling the run back restores the file and the original kind; the rollback is a reverse Changed',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    const keep = await agentSaved(cwd, 'fact', 'Deploys happen on Thursdays');
    const id = await agentSaved(cwd, 'fact', 'Answer with the conclusion first');
    const file = join(K.memory.projectDir(cwd).dir, 'entries', `${id}.md`);
    const before = readFileSync(file, 'utf8');
    const { tool, run, end } = await enhancement(t, cwd, 'taste');
    const moved = await callTool(tool, { action: 'move', entry: id, kind: 'taste', note: 'how to talk' });
    assert.equal(moved.isError, false, moved.text);
    await end();
    const back = ok(await K.memory.rollback({ by: 'You', caller: null, run: null }, cwd, 'project', run.id));
    assert.equal(readFileSync(file, 'utf8'), before, 'the file is the before block word for word');
    assert.deepEqual(await indexSlugs(cwd, 'taste'), []);
    assert.deepEqual(await indexSlugs(cwd, 'fact'), [keep, id], 'back in Facts (at the end)');
    const undo = (await K.memory.revision(cwd, 'project', back.revision)).revision;
    assert.deepEqual(undo.kinds, ['fact', 'taste']);
    assert.deepEqual(undo.changes.map((change) => [change.action, change.fromKind, change.kind]),
      [['changed', 'taste', 'fact']]);
    ok(await K.memory.rollback({ by: 'You', caller: null, run: null }, cwd, 'project', back.revision));
    assert.deepEqual(await indexSlugs(cwd, 'taste'), [id], 'rolling the rollback back moves it again');
  });
