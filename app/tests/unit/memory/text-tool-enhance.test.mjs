// memory 工具（enhance:<task> 调用方）的单元测试（docs/specs/memory.md §7.3、§9.7、MEM-21）：增强任务只改本项目这一种的
// learned 条目（新增为 learned，update 后仍为 learned）；依据按这次运行的范围核对：列出的会话文件（路径按 /、\ 与大小写
// 不敏感比较，存下列出的那个路径）、列出的 TaskBoard 目录 sessions/ 下的实例会话（会话名 `<会话名> · <实例文件名>`）、
// 列出的反馈文件名；条目 id 用 pi 的 parseSessionEntries 在那个文件里找；at 取条目 timestamp / 反馈 createdAt 的本地日期。
// 不合格时整次调用被拒绝、什么都不写。运行由记忆模块的 beginRun 建立；会话文件、实例文件、反馈名都是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PAGE, callTool, freshUserData, loadTextKernel, localDay, ok, snapshotDir, writeSessionFile } from
  './text-helpers.mjs';

const K = await loadTextKernel();
/** synthetic：协作模式下的 timestamp 选在 UTC 傍晚，东八区已是第二天，用来核对“本地日期” */
const LATE = '2026-10-22T20:30:00.000Z';

/**
 * @brief synthetic：一次 STRATEGY 增强运行的材料（一个列出的会话、它的 TaskBoard 目录下的实例会话、一份反馈）与工具。
 * @param t node:test 的测试上下文
 */
async function enhancement(t) {
  const fresh = freshUserData(t, K);
  const { userData, cwd } = fresh;
  const session = join(userData, 'pi', 'sessions', '--shop--', '2026-10-22T09-00-00_s1.jsonl');
  writeSessionFile(session, cwd, [
    { id: 'a1b2c3d4', role: 'user', text: 'tell me how you plan to change it first',
      timestamp: '2026-10-22T01:00:00Z' },
    { id: 'b2c3d4e5', role: 'assistant', text: 'Sure (synthetic)', timestamp: LATE },
  ]);
  const instance = join(userData, 'teams', 's1', 'sessions', 'executor-t1.jsonl');
  writeSessionFile(instance, cwd, [{ id: 'c3d4e5f6', role: 'user', text: 'T1 review (synthetic)', timestamp: LATE }]);
  const run = await K.memory.beginRun({ cwd, task: 'strategy', day: '2026-10-22', sessions: 1, feedback: 1 });
  const scope = { sessions: [{ file: session, title: 'Payment refactor' }],
    instanceFiles: [{ file: instance, title: 'Payment refactor · executor-t1.jsonl' }],
    feedback: [{ name: '2026-10-22-101500.json', createdAt: LATE }] };
  const tool = K.tool.memoryTool({ cwd, caller: { kind: 'enhance', task: 'strategy' }, run, scope,
    position: () => { throw new Error('an enhancement caller has no position'); } });
  return { ...fresh, session, instance, run, tool };
}

test('MEM-21 save adds a learned entry to this project; the evidence is stored as listed, not as the model wrote it',
  async (t) => {
    const { cwd, session, tool, run } = await enhancement(t);
    const written = session.toUpperCase().replaceAll('\\', '/');
    const result = await callTool(tool, { action: 'save', abstract: 'Plan before changing more than three modules',
      detail: 'List the places first.', evidence: [{ session: written, entry: 'a1b2c3d4', quote: 'plan first' }] });
    assert.equal(result.text, 'Saved to STRATEGY (this project): Plan before changing more than three modules');
    assert.deepEqual(result.details, { revision: run.id, kind: 'strategy', layer: 'project',
      entry: 'plan-before-changing-more-than-three-modules', action: 'save' });
    const detail = await K.memory.detailOf(cwd, 'project', result.details.entry);
    assert.equal(detail.source, 'learned');
    assert.deepEqual(detail.evidence, [{ at: localDay('2026-10-22T01:00:00Z'), session, entry: 'a1b2c3d4',
      title: 'Payment refactor', quote: 'plan first' }], 'the listed path, as listed (case and slashes)');
  });

test('MEM-21 update with evidence only keeps a learned entry learned; instance sessions and feedback are evidence',
  async (t) => {
    const { cwd, instance, tool } = await enhancement(t);
    const saved = await callTool(tool, { action: 'save', abstract: 'Split big work into stages', evidence: [
      { feedback: '2026-10-22-101500.json', quote: 'Tell me how you plan to change it first' }] });
    const id = saved.details.entry;
    const result = await callTool(tool, { action: 'update', entry: id, note: 'confirmed by the review',
      evidence: [{ session: instance.replaceAll('\\', '/'), entry: 'c3d4e5f6' }] });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text, 'Updated STRATEGY (this project): Split big work into stages');
    const detail = await K.memory.detailOf(cwd, 'project', id);
    assert.equal(detail.source, 'learned', 'still learned after an enhancement update');
    assert.equal(detail.abstract, 'Split big work into stages');
    assert.deepEqual(detail.evidence, [
      { at: localDay(LATE), feedback: '2026-10-22-101500.json', quote: 'Tell me how you plan to change it first' },
      { at: localDay(LATE), session: instance, entry: 'c3d4e5f6', title: 'Payment refactor · executor-t1.jsonl' },
    ]);
  });

test('MEM-21 an entry the user wrote and another kind cannot be changed; nothing is written', async (t) => {
  const { cwd, session, tool, memoryRoot } = await enhancement(t);
  const mine = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'strategy', abstract: 'Mine', detail: '',
    evidence: [] }));
  const taste = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'Other kind',
    detail: '', evidence: [] }));
  const evidence = [{ session, entry: 'a1b2c3d4' }];
  const before = snapshotDir(memoryRoot);
  const user = await callTool(tool, { action: 'update', entry: mine.id, abstract: 'Changed', note: 'n', evidence });
  assert.match(user.text, /^“Mine” is an entry the user wrote; it’s read-only for enhancement\./);
  const kind = await callTool(tool, { action: 'forget', entry: taste.id, note: 'n', evidence });
  assert.match(kind.text, /^This run maintains this project’s STRATEGY entries only\./);
  assert.deepEqual(snapshotDir(memoryRoot), before);
  assert.equal((await K.memory.detailOf(cwd, 'project', mine.id)).abstract, 'Mine');
});

test('MEM-21 evidence not from this run is refused and nothing is written', async (t) => {
  const { userData, cwd, session, tool, memoryRoot, run } = await enhancement(t);
  const elsewhere = join(userData, 'pi', 'sessions', '--shop--', 'not-listed.jsonl');
  writeSessionFile(elsewhere, cwd, [{ id: 'a1b2c3d4', role: 'user', text: 'x', timestamp: '2026-10-22T01:00:00Z' }]);
  const unlisted = join(userData, 'teams', 'other', 'sessions', 'x.jsonl');
  writeSessionFile(unlisted, cwd, [{ id: 'c3d4e5f6', role: 'user', text: 'x', timestamp: LATE }]);
  const before = snapshotDir(memoryRoot);
  const cases = [
    [{ session: elsewhere, entry: 'a1b2c3d4' }, 'session not listed'],
    [{ session: unlisted, entry: 'c3d4e5f6' }, 'session not listed'],
    [{ session, entry: 'deadbeef' }, `entry deadbeef not in ${session}`],
    [{ session, entry: 'c3d4e5f6' }, `entry c3d4e5f6 not in ${session}`],
    [{ feedback: 'other.json' }, 'feedback not listed'],
    [{ feedback: `feedback/${'2026-10-22-101500.json'}` }, 'feedback not listed'],
  ];
  for (const [item, reason] of cases) {
    const result = await callTool(tool, { action: 'save', abstract: 'Not allowed', evidence: [item] });
    assert.equal(result.isError, true);
    assert.equal(result.text, `Evidence 1 isn’t from this run’s material: ${reason}.`, JSON.stringify(item));
  }
  assert.deepEqual(snapshotDir(memoryRoot), before, 'no entry, index or revision change');
  const revision = (await K.memory.revision(cwd, 'project', run.id)).revision;
  assert.deepEqual(revision.changes, [], 'the run revision has no changes');
});

test('MEM-21 missing or empty evidence is refused by the schema, before anything is written', async (t) => {
  const { tool, memoryRoot } = await enhancement(t);
  const before = snapshotDir(memoryRoot);
  await assert.rejects(callTool(tool, { action: 'save', abstract: 'x' }), /Validation failed for tool "memory"/);
  await assert.rejects(callTool(tool, { action: 'save', abstract: 'x', evidence: [] }),
    /Validation failed for tool "memory"/);
  assert.deepEqual(snapshotDir(memoryRoot), before);
});

test('MEM-21 forget deletes a learned entry of this kind, with the evidence checked', async (t) => {
  const { cwd, session, tool, run } = await enhancement(t);
  const saved = await callTool(tool, { action: 'save', abstract: 'Short-lived rule', evidence: [{ session,
    entry: 'b2c3d4e5' }] });
  const bad = await callTool(tool, { action: 'forget', entry: saved.details.entry, note: 'contradicted',
    evidence: [{ feedback: 'nope.json' }] });
  assert.equal(bad.text, 'Evidence 1 isn’t from this run’s material: feedback not listed.');
  assert.ok(await K.memory.detailOf(cwd, 'project', saved.details.entry), 'still there');
  const gone = await callTool(tool, { action: 'forget', entry: 'Short-lived rule', note: 'contradicted',
    evidence: [{ session, entry: 'a1b2c3d4' }] });
  assert.equal(gone.text, 'Deleted from STRATEGY (this project): Short-lived rule');
  assert.equal(await K.memory.detailOf(cwd, 'project', saved.details.entry), null);
  const revision = (await K.memory.revision(cwd, 'project', run.id)).revision;
  assert.deepEqual(revision.changes, [], 'added then deleted in one run: not in the revision (§9.8)');
});
