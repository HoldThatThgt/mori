// 界面与后台进程共用的增强文字（shared/memory.ts，docs/specs/memory.md §3.2、§10.1、§10.4、§10.5、§10.6）：
// 增强状态行（§10.4 表的每一行与先后）、新会话提示、修订的计数、token 数、依据行。EnhanceInfo 由测试按 §8 的形状手写（synthetic）。
// 期望的时刻文字在这里独立算出（harness 的 monDayTime），不调用被测的代码。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import { at, monDayTime } from './enhance-harness.mjs';

const M = await loadKernelModule('src/shared/memory.ts');

const NEXT = at('2026-10-24', '04:00');
const NEXT_TEXT = ` · Next run ${monDayTime(NEXT)}`;

/** @brief 本地时区的 ISO 时刻（同 enhance.json 的 last.at：带时区）。 */
function localIso(ms) {
  const offset = -new Date(ms).getTimezoneOffset();
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offset >= 0 ? '+' : '-';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return new Date(ms + offset * 60_000).toISOString().replace('Z', zone);
}

/** @brief 一个开着、有模型、还没跑过的 EnhanceInfo（synthetic），over 覆盖其中的字段。 */
function info(over = {}) {
  return { cwd: 'D:\\shop', enabled: true, pick: 'fake/model', thinking: 'medium', team: false, time: '04:00',
    since: '2026-10-20', last: { taste: null, strategy: null, review: null }, running: null, queued: 0, next: NEXT,
    notice: null, error: null, ...over };
}

/** @brief 一个任务的 last（synthetic）：跑完的时刻 ms、状态与其余字段。 */
function last(day, ms, status, over = {}) {
  const skipped = status === 'skipped';
  return { day, at: localIso(ms), status, error: null, revision: skipped ? null : `rev-${day}-${status}`,
    tokens: 0, counts: skipped ? null : { added: 0, changed: 0, deleted: 0 }, ...over };
}

test('MEM-17 status line: unreadable settings, off, and on without a model (§10.4 rows 1–3)', () => {
  assert.equal(M.enhanceStatusText(info({ enabled: false, error: 'tasks.taste: Required' })),
    'Couldn’t read the enhancement settings: tasks.taste: Required');
  assert.equal(M.enhanceStatusText(info({ enabled: false })), 'Off · Each day, three background runs review this '
    + 'project’s sessions and improve its TASTE, STRATEGY, and REVIEW');
  assert.equal(M.enhanceStatusText(info({ pick: null, queued: 2 })), 'On · Choose a model in enhancement settings',
    'no model comes before anything queued or run');
  assert.equal(M.enhanceStatusText(info({ enabled: false, pick: null })), M.ENHANCE_OFF_TEXT);
});

test('MEM-24 status line: Running <KIND> enhancement… with what is still queued; the waiting project’s line', () => {
  assert.equal(M.enhanceStatusText(info({ running: { task: 'strategy', day: '2026-10-22' } })),
    'Running STRATEGY enhancement…');
  assert.equal(M.enhanceStatusText(info({ running: { task: 'review', day: '2026-10-22' }, queued: 4 })),
    'Running REVIEW enhancement… · 4 queued');
  const failed = { taste: last('2026-10-21', at('2026-10-22', '04:01'), 'failed', { error: 'boom' }),
    strategy: null, review: null };
  assert.equal(M.enhanceStatusText(info({ queued: 3, last: failed })),
    'On · 3 queued · Waiting for another project’s enhancement', 'queued comes before an earlier failure');
});

test('MEM-23 status line: a failed task wins over later successes; the reason is the latest failure’s', () => {
  const lasts = {
    taste: last('2026-10-23', at('2026-10-24', '04:00'), 'done', { counts: { added: 1, changed: 0, deleted: 0 } }),
    strategy: last('2026-10-21', at('2026-10-22', '04:02'), 'failed', { error: 'synthetic: 404 Not Found' }),
    review: last('2026-10-23', at('2026-10-24', '04:03'), 'done'),
  };
  assert.equal(M.enhanceStatusText(info({ last: lasts })),
    `On · Last run failed (STRATEGY): synthetic: 404 Not Found${NEXT_TEXT}`,
    'STRATEGY failed twice while TASTE and REVIEW ran on to a later day: still the failure line');
  const two = { ...lasts, taste: last('2026-10-22', at('2026-10-23', '04:30'), 'failed', { error: 'newer' }) };
  assert.equal(M.enhanceStatusText(info({ last: two })), `On · Last run failed (TASTE, STRATEGY): newer${NEXT_TEXT}`,
    'kinds in TASTE, STRATEGY, REVIEW order; the reason of the one with the latest at');
  assert.equal(M.enhanceStatusText(info({ last: two, running: { task: 'taste', day: '2026-10-23' } })),
    'Running TASTE enhancement…', 'a run in progress comes first');
});

test('MEM-25 status line: all skipped on the latest day, success per kind with summed tokens, No changes, never run',
  () => {
    const skippedDay = {
      taste: last('2026-10-23', at('2026-10-24', '04:00'), 'skipped'),
      strategy: last('2026-10-23', at('2026-10-24', '04:01'), 'skipped'),
      review: last('2026-10-23', at('2026-10-24', '04:02'), 'skipped'),
    };
    assert.equal(M.enhanceStatusText(info({ last: skippedDay })),
      `On · Last run ${monDayTime(at('2026-10-24', '04:02'))} · No finished sessions to read${NEXT_TEXT}`);
    const olderDone = { ...skippedDay, strategy: last('2026-10-22', at('2026-10-23', '04:01'), 'done',
      { counts: { added: 2, changed: 0, deleted: 0 }, tokens: 9000 }) };
    assert.match(M.enhanceStatusText(info({ last: olderDone })), /No finished sessions to read/,
      'only the latest day counts');
    const success = {
      taste: last('2026-10-23', at('2026-10-24', '04:00'), 'done',
        { counts: { added: 1, changed: 1, deleted: 0 }, tokens: 12034 }),
      strategy: last('2026-10-23', at('2026-10-24', '04:02'), 'done',
        { counts: { added: 0, changed: 0, deleted: 1 }, tokens: 1100 }),
      review: last('2026-10-23', at('2026-10-24', '04:01'), 'skipped'),
    };
    assert.equal(M.enhanceStatusText(info({ last: success })), `On · Last run ${monDayTime(at('2026-10-24', '04:02'))}`
      + ` · TASTE: added 1, changed 1; STRATEGY: deleted 1 · 13k tokens${NEXT_TEXT}`);
    const unchanged = { taste: last('2026-10-23', at('2026-10-24', '04:00'), 'done', { tokens: 950 }),
      strategy: last('2026-10-23', at('2026-10-24', '04:01'), 'done', { tokens: 0 }), review: null };
    assert.equal(M.enhanceStatusText(info({ last: unchanged })),
      `On · Last run ${monDayTime(at('2026-10-24', '04:01'))} · No changes · 950 tokens${NEXT_TEXT}`);
    assert.equal(M.enhanceStatusText(info()), `On${NEXT_TEXT}`);
  });

test('MEM-26 notice text: one day or a range, only kinds that changed', () => {
  assert.equal(M.memoryNoticeText({ revisions: ['r1'], counts: { taste: 1, strategy: 2, review: 0 },
    from: '2026-10-22', to: '2026-10-22' }),
  'Enhancement updated this project’s memory from the Oct 22 sessions: TASTE 1, STRATEGY 2.');
  assert.equal(M.memoryNoticeText({ revisions: ['r1', 'r2'], counts: { taste: 0, strategy: 0, review: 3 },
    from: '2026-10-22', to: '2026-10-23' }),
  'Enhancement updated this project’s memory from the Oct 22–Oct 23 sessions: REVIEW 3.');
});

test('MEM-08 counts text: Added 1, changed 2; zero counts are left out; all zero is No changes', () => {
  assert.equal(M.countsText({ added: 1, changed: 2, deleted: 0, moved: 0 }), 'Added 1, changed 2');
  assert.equal(M.countsText({ added: 0, changed: 0, deleted: 3, moved: 0 }), 'Deleted 3');
  assert.equal(M.countsText({ added: 0, changed: 0, deleted: 0, moved: 1 }), 'Moved 1');
  assert.equal(M.countsText({ added: 0, changed: 0, deleted: 0, moved: 0 }), 'No changes');
  assert.equal(M.countsText({ added: 0, changed: 0, deleted: 0 }), 'No changes', 'last.counts has no moved');
});

test('MEM-08 token text: <n> tokens (1 token) under 1000, rounded <n>k tokens from 1000', () => {
  const cases = [[0, '0 tokens'], [1, '1 token'], [2, '2 tokens'], [999, '999 tokens'], [1000, '1k tokens'],
    [1499, '1k tokens'], [1500, '2k tokens'], [38214, '38k tokens']];
  for (const [n, text] of cases) assert.equal(M.formatTokens(n), text, `${n}`);
});

test('MEM-06 evidence line: session and feedback, with and without a quote; a current title wins', () => {
  const session = { at: '2026-10-22', session: 'D:\\pi\\s.jsonl', entry: 'a1b2c3d4', title: 'Payment refactor',
    quote: 'Plan it first' };
  assert.equal(M.evidenceLine(session), 'Oct 22 · Session “Payment refactor”: “Plan it first”');
  assert.equal(M.evidenceLine({ ...session, quote: undefined }), 'Oct 22 · Session “Payment refactor”');
  assert.equal(M.evidenceLine(session, 'Renamed'), 'Oct 22 · Session “Renamed”: “Plan it first”');
  assert.equal(M.evidenceLine({ at: '2026-10-22', session: 'x', entry: null }), 'Oct 22 · Session “Untitled session”');
  assert.equal(M.evidenceLine({ at: '2026-10-24', feedback: '2026-10-24-101500.json',
    quote: 'Tell me how you plan to change it first' }),
  'Oct 24 · Feedback: “Tell me how you plan to change it first”');
  assert.equal(M.evidenceLine({ at: '2026-10-24', feedback: 'f.json' }), 'Oct 24 · Feedback');
});
