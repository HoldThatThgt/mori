// 增强任务的日子、片段与 token（kernel/enhanceDays.ts，docs/specs/memory.md §9.1–§9.3、§9.5、§9.6、§12）：纯函数，
// 时刻都由参数给出。会话文件的行由测试按 pi 会话文件的格式手写（synthetic）。时刻按本地时间写（§9.2）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import { at, captureErrors, sessionLines } from './enhance-harness.mjs';

const D = await loadKernelModule('src/kernel/enhanceDays.ts');

/** 三个任务同一个 doneThrough。 */
const allDone = (day) => ({ taste: day, strategy: day, review: day });

/** 会话的物理行（synthetic）：头之后的条目原样写。 */
function lines(items, cwd = 'D:\\shop') {
  return D.physicalLines(sessionLines({ id: 's1', at: at('2026-10-20', '09:00'), cwd }, items).join('\n'));
}

/** 消息条目的简写：id、日子、时刻、角色。 */
const msg = (id, day, time, role = 'user') => ({ id, at: at(day, time), role, text: `${role} ${id}` });

test('MEM-18 day boundary: with 04:00, 03:59 belongs to the previous day and 04:00 to the same day', () => {
  assert.equal(D.dayOf(at('2026-10-23', '03:59'), '04:00'), '2026-10-22');
  assert.equal(D.dayOf(at('2026-10-23', '04:00'), '04:00'), '2026-10-23');
  assert.equal(D.dayOf(at('2026-10-23', '03:00'), '04:00'), '2026-10-22', 'the spec example (§9.2)');
  assert.equal(D.dayOf(at('2026-10-23', '22:59'), '23:00'), '2026-10-22');
  assert.equal(D.dayOf(at('2026-10-23', '23:00'), '23:00'), '2026-10-23');
  assert.equal(D.dayOf(at('2026-11-01', '00:30'), '04:00'), '2026-10-31', 'across a month');
  assert.equal(D.dayStart('2026-10-22', '04:00'), at('2026-10-22', '04:00'));
  assert.equal(D.dayStart(D.addDays('2026-10-22', 1), '04:00'), at('2026-10-23', '04:00'), 'D ends when D+1 starts');
  assert.equal(D.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(D.addDays('2026-11-01', -1), '2026-10-31');
});

test('MEM-18 due days: every day after doneThrough and before today, from since on, oldest first', () => {
  assert.deepEqual(D.dueDays('2026-10-19', '2026-10-15', '2026-10-23'),
    ['2026-10-20', '2026-10-21', '2026-10-22'], 'missed days are caught up; today is not due');
  assert.deepEqual(D.dueDays('2026-10-10', '2026-10-21', '2026-10-23'), ['2026-10-21', '2026-10-22'],
    'nothing before since runs');
  assert.deepEqual(D.dueDays(null, '2026-10-21', '2026-10-23'), ['2026-10-21', '2026-10-22']);
  assert.deepEqual(D.dueDays('2026-10-22', '2026-10-20', '2026-10-23'), []);
  assert.deepEqual(D.dueDays('2026-10-23', '2026-10-20', '2026-10-23'), [], 'a today run never pulls doneThrough on');
});

test('MEM-18 the next boundary is strictly after now', () => {
  assert.equal(D.nextBoundary(at('2026-10-23', '03:59'), '04:00'), at('2026-10-23', '04:00'));
  assert.equal(D.nextBoundary(at('2026-10-23', '04:00'), '04:00'), at('2026-10-24', '04:00'));
  assert.equal(D.nextBoundary(at('2026-10-23', '10:00'), '23:00'), at('2026-10-23', '23:00'));
});

test('MEM-18 changing the time 04:00→23:00 at Oct 23 10:00 (spec example): Oct 22 becomes due at Oct 23 23:00',
  () => {
    const now = at('2026-10-23', '10:00');
    const result = D.retime({ since: '2026-10-20', doneThrough: allDone('2026-10-22'), newTime: '23:00', now });
    assert.deepEqual(result, { since: '2026-10-20', doneThrough: allDone('2026-10-21') },
      'doneThrough goes back to the new today (Oct 22) minus one');
    assert.deepEqual(D.dueDays('2026-10-21', result.since, D.dayOf(now, '23:00')), [], 'nothing is due at 10:00');
    const night = at('2026-10-23', '23:00');
    assert.deepEqual(D.dueDays('2026-10-21', result.since, D.dayOf(night, '23:00')), ['2026-10-22']);
    // 10-22（23:00）从 10-22 23:00 到 10-23 23:00；已读到 10-23 04:00 之前的水位，片段只有之后新增的部分
    const session = lines([msg('a1', '2026-10-22', '10:00'), msg('a2', '2026-10-22', '10:01', 'assistant'),
      msg('a3', '2026-10-23', '02:00'), msg('a4', '2026-10-23', '02:01', 'assistant'),
      msg('a5', '2026-10-23', '09:00'), msg('a6', '2026-10-23', '09:01', 'assistant'),
      msg('a7', '2026-10-23', '23:30')]);
    const window = { sinceStart: D.dayStart(result.since, '23:00'), dayEnd: D.dayStart('2026-10-23', '23:00') };
    const slice = D.sessionSlice(session, { watermark: 'a4', ...window });
    assert.equal(slice.fromLine, 6);
    assert.equal(slice.toLine, 7, 'the 23:30 line belongs to Oct 23 under 23:00');
    assert.equal(slice.afterEntry, 'a4');
    // 10-23 白天新建的会话（没有水位）也列出，从它的第一个条目开始
    const fresh = D.sessionSlice(lines([msg('b1', '2026-10-23', '15:00'), msg('b2', '2026-10-23', '15:01',
      'assistant')]), { watermark: null, ...window });
    assert.deepEqual({ from: fresh.fromLine, to: fresh.toLine, after: fresh.afterEntry }, { from: 2, to: 3,
      after: null });
  });

test('MEM-18 changing the time 23:00→04:00: the newly finished day is due at once and starts after the watermark',
  () => {
    const now = at('2026-10-23', '10:00');
    const result = D.retime({ since: '2026-10-20', doneThrough: allDone('2026-10-21'), newTime: '04:00', now });
    assert.deepEqual(result, { since: '2026-10-20', doneThrough: allDone('2026-10-21') }, 'nothing moves back');
    assert.deepEqual(D.dueDays('2026-10-21', '2026-10-20', D.dayOf(now, '04:00')), ['2026-10-22']);
    const session = lines([msg('a1', '2026-10-22', '10:00'), msg('a2', '2026-10-22', '22:00', 'assistant'),
      msg('a3', '2026-10-23', '01:00'), msg('a4', '2026-10-23', '03:00', 'assistant'),
      msg('a5', '2026-10-23', '09:00')]);
    const slice = D.sessionSlice(session, { watermark: 'a2', sinceStart: D.dayStart('2026-10-20', '04:00'),
      dayEnd: D.dayStart('2026-10-23', '04:00') });
    assert.deepEqual([slice.fromLine, slice.toLine, slice.afterEntry], [4, 5, 'a2'],
      'lines read under 23:00 are not listed again');
  });

test('MEM-18 changing the time keeps since at most the new today', () => {
  const result = D.retime({ since: '2026-10-23', doneThrough: allDone('2026-10-22'), newTime: '23:00',
    now: at('2026-10-23', '10:00') });
  assert.deepEqual(result, { since: '2026-10-22', doneThrough: allDone('2026-10-21') });
});

test('MEM-19 the slice runs from after the watermark to the day boundary; the next day has only the new lines', () => {
  const session = lines([msg('u1', '2026-10-22', '10:00'), msg('a1', '2026-10-22', '10:01', 'assistant'),
    msg('u2', '2026-10-23', '02:00'), msg('a2', '2026-10-23', '02:01', 'assistant'),
    msg('u3', '2026-10-23', '09:00'), msg('a3', '2026-10-23', '09:01', 'assistant')]);
  const sinceStart = D.dayStart('2026-10-22', '04:00');
  const first = D.sessionSlice(session, { watermark: null, sinceStart, dayEnd: D.dayStart('2026-10-23', '04:00') });
  assert.deepEqual(first, { fromLine: 2, toLine: 5, afterEntry: null, fromTime: at('2026-10-22', '10:00'),
    lastEntry: 'a2', hasChat: true });
  const next = D.sessionSlice(session, { watermark: first.lastEntry, sinceStart,
    dayEnd: D.dayStart('2026-10-24', '04:00') });
  assert.deepEqual([next.fromLine, next.toLine, next.afterEntry, next.lastEntry], [6, 7, 'a2', 'a3']);
  assert.equal(D.sessionSlice(session, { watermark: 'a3', sinceStart, dayEnd: D.dayStart('2026-10-24', '04:00') }),
    null, 'nothing after the watermark: not listed');
});

test('MEM-19 a watermark that is not in the file starts the slice at since (from <time>)', () => {
  const session = lines([msg('u1', '2026-10-20', '10:00'), msg('u2', '2026-10-22', '10:00'),
    msg('a2', '2026-10-22', '10:01', 'assistant')]);
  const slice = D.sessionSlice(session, { watermark: 'gone0000', sinceStart: D.dayStart('2026-10-22', '04:00'),
    dayEnd: D.dayStart('2026-10-23', '04:00') });
  assert.deepEqual([slice.fromLine, slice.toLine, slice.afterEntry], [3, 4, null]);
});

test('MEM-19 turned off for some days and on again: the slice is cut at since, not at the old watermark', () => {
  const session = lines([msg('u1', '2026-10-15', '10:00'), msg('a1', '2026-10-15', '10:01', 'assistant'),
    msg('u2', '2026-10-17', '10:00'), msg('a2', '2026-10-17', '10:01', 'assistant'),
    msg('u3', '2026-10-22', '11:00'), msg('a3', '2026-10-22', '11:01', 'assistant')]);
  const slice = D.sessionSlice(session, { watermark: 'a1', sinceStart: D.dayStart('2026-10-22', '04:00'),
    dayEnd: D.dayStart('2026-10-23', '04:00') });
  assert.deepEqual([slice.fromLine, slice.toLine, slice.afterEntry, slice.fromTime],
    [6, 7, null, at('2026-10-22', '11:00')], 'Oct 17 (enhancement off) is not in the slice');
});

test('MEM-19 a session not listed on D (no watermark) is read from its D content on D+1, even with no new line', () => {
  const session = lines([msg('u1', '2026-10-22', '10:00'), msg('a1', '2026-10-22', '10:05', 'assistant')]);
  const slice = D.sessionSlice(session, { watermark: null, sinceStart: D.dayStart('2026-10-20', '04:00'),
    dayEnd: D.dayStart('2026-10-24', '04:00') });
  assert.deepEqual([slice.fromLine, slice.toLine, slice.afterEntry], [2, 3, null]);
});

test('MEM-19 only user or assistant messages make a session listed (mori.pick alone does not)', () => {
  const session = lines([msg('u1', '2026-10-20', '10:00'), { id: 'p1', at: at('2026-10-22', '10:00'),
    custom: 'mori.pick' }]);
  const window = { sinceStart: D.dayStart('2026-10-22', '04:00'), dayEnd: D.dayStart('2026-10-23', '04:00') };
  assert.equal(D.sessionSlice(session, { watermark: null, ...window }), null);
  const assistantOnly = lines([msg('a1', '2026-10-22', '10:00', 'assistant')]);
  assert.equal(D.sessionSlice(assistantOnly, { watermark: null, ...window }).toLine, 2);
});

test('MEM-19 line numbers are physical lines: a malformed middle line and a blank line still count', (t) => {
  const errors = captureErrors(t);
  const text = sessionLines({ id: 's1', at: at('2026-10-22', '09:00'), cwd: 'D:\\shop' }, [
    msg('e1', '2026-10-22', '10:00'), msg('e2', '2026-10-22', '10:01', 'assistant'), '{"type":"message","id":',
    '', msg('e3', '2026-10-22', '11:00'), msg('e4', '2026-10-22', '11:01', 'assistant')]).join('\n');
  const physical = D.physicalLines(text, 'synthetic.jsonl');
  assert.deepEqual(physical.map((line) => [line.line, line.entry?.id ?? null]),
    [[1, 's1'], [2, 'e1'], [3, 'e2'], [4, null], [5, null], [6, 'e3'], [7, 'e4']]);
  assert.equal(errors.length, 1, 'the bad line is logged once; the blank line is not');
  assert.match(errors[0], /line 4 in synthetic\.jsonl/);
  const slice = D.sessionSlice(physical, { watermark: 'e2', sinceStart: D.dayStart('2026-10-22', '04:00'),
    dayEnd: D.dayStart('2026-10-23', '04:00') });
  assert.deepEqual([slice.fromLine, slice.toLine], [6, 7]);
  // read 工具的 offset 从 1 起按物理行：起止行就是这两个条目
  const raw = text.split('\n');
  assert.equal(JSON.parse(raw[slice.fromLine - 1]).id, 'e3');
  assert.equal(JSON.parse(raw[slice.toLine - 1]).id, 'e4');
});

test('MEM-19 the listed name is the pi session name, else the first user message (60 characters), else Untitled',
  () => {
    const long = 'x'.repeat(70);
    const session = lines([{ id: 'u1', at: at('2026-10-22', '10:00'), role: 'user', text: `  ${long}\n more` }]);
    assert.equal(D.sessionTitle(session, 'Payment refactor'), 'Payment refactor');
    assert.equal(D.sessionTitle(session, null), 'x'.repeat(60));
    assert.equal(D.sessionTitle(lines([msg('a1', '2026-10-22', '10:00', 'assistant')]), null), 'Untitled session');
  });

test('MEM-23 tokens add input + output the way pi getSessionStats does; the header and bad lines count 0', (t) => {
  captureErrors(t);
  const usage = (input, output) => ({ input, output, cacheRead: 99, cacheWrite: 99, totalTokens: 999 });
  const rows = [
    { type: 'session', id: 'h', usage: usage(1000, 1000) },
    { type: 'message', id: 'u', message: { role: 'user', content: 'hi', usage: usage(500, 500) } },
    { type: 'message', id: 'a', message: { role: 'assistant', content: [], usage: usage(100, 20) } },
    { type: 'message', id: 't', message: { role: 'toolResult', content: [], usage: usage(3, 4) } },
    { type: 'usage', id: 'g', usage: usage(7, 8) },
    { type: 'compaction', id: 'c', usage: usage(30, 2) },
    { type: 'compaction', id: 'c2', summary: 'no usage' },
    { type: 'branch_summary', id: 'b', usage: usage(5, 1) },
    { type: 'custom', id: 'x', usage: usage(400, 400) },
  ];
  const text = [...rows.map((row) => JSON.stringify(row)), '{broken', ''].join('\n');
  assert.equal(D.sessionTokens(D.physicalLines(text)), 120 + 7 + 15 + 32 + 6);
});
