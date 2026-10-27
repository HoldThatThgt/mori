// 增强任务读的反馈（kernel/feedbackRead.ts，docs/specs/memory.md §9.5 第 2 条）：按会话的工作目录（完全相同）、
// createdAt 落在日子 D 里、晚于这个任务的 feedbackSeen 选出，按 createdAt 排序；读不出来的文件跳过并记日志。
// 反馈文件由测试按 StoredFeedbackSchema 的形状手写（synthetic）。
// 文件系统 §11.7（file-system.md §19.4、FS-102）：会话的工作目录先取 projectFolder，Mori worktree 里的会话的会话与反馈
// 归它的主文件夹；不在 worktree 里的照旧按工作目录完全相同。增强运行读哪些会话的那一条经 enhance-harness 的 runSetup
// 跑真正的增强运行（会话表是替身），会话文件同样是 synthetic 的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  at, captureErrors, ended, enhanceJson, iso, listedFeedback, listedSessions, messageOf, runSetup, scenario, turn,
  writeEnhance, writeFeedback, writeSession,
} from './enhance-harness.mjs';

const F = await loadKernelModule('src/kernel/feedbackRead.ts');

const FROM = at('2026-10-22', '04:00');
const TO = at('2026-10-23', '04:00');

test('MEM-19 feedback is chosen by exact cwd, createdAt inside D and after feedbackSeen, sorted by createdAt',
  async (t) => {
    const s = scenario(t);
    const cwd = s.project('shop');
    const errors = captureErrors(t);
    writeFeedback(s.userData, { name: 'b-late.json', cwd, at: at('2026-10-22', '18:00') });
    writeFeedback(s.userData, { name: 'a-early.json', cwd, at: at('2026-10-22', '09:00') });
    writeFeedback(s.userData, { name: 'start.json', cwd, at: FROM });
    writeFeedback(s.userData, { name: 'end.json', cwd, at: TO });
    writeFeedback(s.userData, { name: 'before.json', cwd, at: at('2026-10-22', '03:59') });
    writeFeedback(s.userData, { name: 'other.json', cwd: s.project('blog'), at: at('2026-10-22', '10:00') });
    writeFeedback(s.userData, { name: 'sub.json', cwd: join(cwd, 'web'), at: at('2026-10-22', '10:00') });
    writeFeedback(s.userData, { name: 'case.json', cwd: cwd.toUpperCase(), at: at('2026-10-22', '10:00') });
    writeFeedback(s.userData, { name: 'seen.json', cwd, at: at('2026-10-22', '08:00') });
    const dir = join(s.userData, 'feedback');
    writeFileSync(join(dir, 'broken.json'), '{ "expected": ');
    writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ quote: 'x', createdAt: iso(FROM) }));
    writeFileSync(join(dir, 'notes.txt'), 'not feedback');
    const listed = await F.dayFeedback(s.userData, cwd, FROM, TO, iso(at('2026-10-22', '08:00')));
    assert.deepEqual(listed.map((item) => item.name), ['a-early.json', 'b-late.json'],
      'D 04:00 itself, the end, other projects, subfolders, other case and feedback seen before are left out');
    assert.equal(listed[0].feedback.session.cwd, cwd);
    assert.ok(errors.some((line) => line.includes('broken.json')), 'an unreadable file is logged');
    assert.ok(errors.some((line) => line.includes('wrong-shape.json')), 'a file of the wrong shape is logged');
    const all = await F.dayFeedback(s.userData, cwd, FROM, TO, null);
    assert.deepEqual(all.map((item) => item.name), ['start.json', 'seen.json', 'a-early.json', 'b-late.json'],
      'with no feedbackSeen every feedback of the day is listed; D starts at its time (inclusive)');
  });

test('MEM-19 no feedback folder lists nothing; an invalid feedbackSeen is an error, not a silent filter', async (t) => {
  const s = scenario(t);
  const cwd = s.project('shop');
  assert.deepEqual(await F.dayFeedback(s.userData, cwd, FROM, TO, null), []);
  mkdirSync(join(s.userData, 'feedback'), { recursive: true });
  writeFeedback(s.userData, { name: 'a.json', cwd, at: at('2026-10-22', '09:00') });
  await assert.rejects(F.dayFeedback(s.userData, cwd, FROM, TO, 'yesterday'), /Invalid feedbackSeen: yesterday/);
});

// ---- 文件系统 §11.7：Mori worktree 里的会话按主文件夹算（FS-102） ----

/** @brief 主文件夹 main 里名为 name 的 Mori worktree 的工作路径（§11.2 的位置），可带子文件夹。 */
const treeOf = (main, name = 'fix-login-3fa9c1', ...sub) => join(main, '.mori', 'worktrees', name, ...sub);

/** @brief 记下场景会改的 pi 环境变量（scenario 设它们、不还原），测试结束时还原。 */
function keepPiEnv(t) {
  const saved = ['PI_OFFLINE', 'PI_TELEMETRY', 'PI_CODING_AGENT_DIR'].map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('MEM-19 FS-102 feedback from a Mori worktree session goes to its main folder; a worktree of a subfolder or of '
  + 'another project does not', async (t) => {
  keepPiEnv(t);
  const s = scenario(t);
  const cwd = s.project('shop');
  writeFeedback(s.userData, { name: 'a-main.json', cwd, at: at('2026-10-22', '09:00') });
  writeFeedback(s.userData, { name: 'b-tree.json', cwd: treeOf(cwd), at: at('2026-10-22', '10:00') });
  writeFeedback(s.userData, { name: 'c-tree2.json', cwd: treeOf(cwd, 'add-search-0b12ef'),
    at: at('2026-10-22', '11:00') });
  writeFeedback(s.userData, { name: 'd-sub.json', cwd: treeOf(cwd, 'fix-login-3fa9c1', 'web'),
    at: at('2026-10-22', '12:00') });
  writeFeedback(s.userData, { name: 'e-blog.json', cwd: treeOf(s.project('blog')), at: at('2026-10-22', '13:00') });
  writeFeedback(s.userData, { name: 'f-claude.json', cwd: join(cwd, '.claude', 'worktrees', 'x'),
    at: at('2026-10-22', '14:00') });
  const names = async (folder) => (await F.dayFeedback(s.userData, folder, FROM, TO, null)).map((item) => item.name);
  assert.deepEqual(await names(cwd), ['a-main.json', 'b-tree.json', 'c-tree2.json']);
  assert.deepEqual(await names(join(cwd, 'web')), ['d-sub.json'],
    'a worktree of a subfolder belongs to the subfolder');
  assert.deepEqual(await names(s.project('blog')), ['e-blog.json'], 'another project’s worktree goes to that project');
  assert.deepEqual(await names(join(cwd, '.claude', 'worktrees', 'x')), ['f-claude.json'], 'not a Mori worktree');
});

test('MEM-19 FS-102 the run lists the sessions of the main folder and its Mori worktrees, and their feedback',
  async (t) => {
    keepPiEnv(t);
    const env = await runSetup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const own = writeSession(env.agentDir, { id: 'own', cwd, at: at('2026-10-22', '08:59'),
      items: turn('a1', '2026-10-22', '09:00', 'Plan the release') });
    const tree = writeSession(env.agentDir, { id: 'tree', cwd: treeOf(cwd), at: at('2026-10-22', '09:59'),
      items: turn('b1', '2026-10-22', '10:00', 'Fix the login page') });
    writeSession(env.agentDir, { id: 'sub', cwd: treeOf(cwd, 'fix-login-3fa9c1', 'web'), at: at('2026-10-22', '10:30'),
      items: turn('c1', '2026-10-22', '11:00') });
    writeSession(env.agentDir, { id: 'blog', cwd: treeOf(env.project('blog')), at: at('2026-10-22', '10:30'),
      items: turn('d1', '2026-10-22', '11:00') });
    writeFeedback(env.userData, { name: 'fb-tree.json', cwd: treeOf(cwd), at: at('2026-10-22', '11:00'),
      sessionFile: tree, entryId: 'b1a', expected: 'Lead with the answer', quote: 'Answer b1' });
    // 只看 TASTE：STRATEGY、REVIEW 的 doneThrough 在很后面，它们没有该跑的日子
    const onlyTaste = { strategy: { doneThrough: '2026-12-31' }, review: { doneThrough: '2026-12-31' } };
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: onlyTaste }));
    await env.startEnhance();
    assert.equal((await ended(env, cwd, 'taste', '2026-10-22')).phase, 'done');
    const message = messageOf(env, 'taste', '2026-10-22');
    assert.deepEqual(listedSessions(message).map((item) => item.file), [own, tree],
      'a worktree of a subfolder and another project’s worktree are not listed');
    assert.deepEqual(listedFeedback(message), ['- fb-tree.json · hoped for: “Lead with the answer” · about: '
      + `“Answer b1” in ${tree} (entry b1a)`]);
    assert.deepEqual(env.built.map((record) => record.spec.cwd), [cwd], 'the enhancement runs in the main folder');
  });
