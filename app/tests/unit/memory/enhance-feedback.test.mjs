// 增强任务读的反馈（kernel/feedbackRead.ts，docs/specs/memory.md §9.5 第 2 条）：按会话的工作目录（完全相同）、
// createdAt 落在日子 D 里、晚于这个任务的 feedbackSeen 选出，按 createdAt 排序；读不出来的文件跳过并记日志。
// 反馈文件由测试按 StoredFeedbackSchema 的形状手写（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import { at, captureErrors, iso, scenario, writeFeedback } from './enhance-harness.mjs';

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
