// kernel/boardText.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §6.4、§7.5、§8.3、§8.4、§8.5、§12.4、附录 A）：
// 程序注入的段与合成端点认会话的句子一致、工作卡的固定行与压缩、board_read 的三种读法、投递文字、立项看到的对话。
// TaskBoard 与会话条目是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernelModule } from '../load.mjs';
import * as scripts from '../../fake-endpoint/scripts.mjs';

const text = await loadKernelModule('src/kernel/boardText.ts');
const { workCard, boardReadText, deliveryText, segments, userSessionSection, createCatchUp, withCatchUp } = text;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const MIN = 60_000;
const T0 = new Date(2026, 9, 21, 9, 0, 0).getTime();
const hhmm = (at) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const holders = { dialog: 'chat', create: 'planner', close: 'planner' };
const roles = [
  { name: 'chat', description: 'Talks to the user' },
  { name: 'planner', description: 'Splits requests and closes them.' },
  { name: 'executor', description: 'Changes code and runs commands' },
  { name: 'reviewer', description: 'Verifies changes' },
];

/** @brief synthetic 需求、task、交接（§6.1 的字段）。 */
function request(no, over = {}) {
  return { no, title: 'Login page is blank', goal: 'The login page renders again', acceptance: 'npm test passes',
    words: [{ text: 'The login page is blank, fix it', at: T0, kind: 'original' }], status: 'open',
    conclusion: null, question: null, asked: false, closeRetry: false, createdAt: T0, closedAt: null, ...over };
}
function task(id, over = {}) {
  return { id, request: 1, title: 'Find and fix', description: 'Find why the page is blank and fix it',
    readOnly: false, assignee: 'executor', dependsOn: [], status: 'pending', holder: null, holderReason: null,
    question: null, asked: false, stopReason: null, handoffs: [], messages: [], createdAt: T0, closedAt: null,
    readyAt: null, ...over };
}
function handoff(n, over = {}) {
  return { n, from: 'executor', outcome: 'done', conclusion: 'Fixed.', next: null, openItems: [], evidence: [],
    session: { file: 'x.jsonl', turns: [n, n] }, routedTo: { kind: 'close' }, reason: null, suggestedNext: null,
    authorFamilies: [], at: T0 + n * MIN, ...over };
}

/** @brief 一块有依赖、失败的 task、多棒交接与消息的 TaskBoard。 */
function sampleBoard() {
  const words = [
    { text: 'The login page is blank, fix it', at: T0, kind: 'original' },
    { text: 'Keep the old logo', at: T0 + 7 * MIN, kind: 'supplement' },
    { text: 'Also check logout', at: T0 + 3 * MIN, kind: 'supplement' },
  ];
  const t1 = task('T1', { status: 'done', closedAt: T0 + 5 * MIN, handoffs: [
    handoff(1, { conclusion: 'Found and fixed the bug.', evidence: [{ tag: '#3', title: 'Run npm test', ok: true,
      toolCallId: 'c3', toolName: 'bash' }] }),
    handoff(2, { from: 'close:planner', outcome: 'close_done', conclusion: 'Fixed and verified', session: null,
      routedTo: { kind: 'end', status: 'done' } }),
  ] });
  const t2 = task('T2', { title: 'Try the cache', status: 'failed', closedAt: T0 + 4 * MIN, handoffs: [
    handoff(1, { outcome: 'dead_end', conclusion: 'Cache theory was wrong.' }),
    handoff(2, { from: 'close:planner', outcome: 'close_failed', conclusion: 'Clearing the cache does not help',
      session: null, routedTo: { kind: 'end', status: 'failed' } }),
  ] });
  const t3 = task('T3', { title: 'Fix logout', description: 'Fix the logout flow', dependsOn: ['T1'],
    status: 'active', holder: { kind: 'role', role: 'executor' }, handoffs: [
      handoff(1, { outcome: 'continue', conclusion: 'Patched', routedTo: { kind: 'role', role: 'reviewer' } }),
      handoff(2, { from: 'reviewer', outcome: 'fail', conclusion: 'Logout test fails',
        routedTo: { kind: 'role', role: 'executor' } }),
      handoff(3, { outcome: 'continue', conclusion: 'Logout fixed', routedTo: { kind: 'role', role: 'reviewer' } }),
      handoff(4, { from: 'reviewer', outcome: 'fail', conclusion: 'Still fails on Safari',
        routedTo: { kind: 'role', role: 'executor' } }),
    ], messages: [{ from: 'planner', text: 'Use the new API', at: T0 + 8 * MIN },
      { from: 'reviewer', text: 'See the Safari log', at: T0 + 9 * MIN }] });
  return { requests: [request(1, { words })], tasks: [t1, t2, t3] };
}

/** @brief 工作卡的中间各行。 */
const cardLines = (card) => card.text.split('\n').slice(1, -1);

// ---- 程序注入的段（TB-44） ----

test('TB-44 the first sentence of every segment equals the synthetic endpoint\'s SEGMENT_SENTENCES', () => {
  const first = (segment) => /^.*?\.(?=\s|$)/.exec(segment)?.[0];
  assert.deepEqual(Object.keys(text.SEGMENTS).sort(), Object.keys(scripts.SEGMENT_SENTENCES).sort());
  for (const kind of text.SEGMENT_KINDS) {
    assert.equal(first(text.SEGMENTS[kind]), scripts.SEGMENT_SENTENCES[kind], kind);
  }
  assert.equal(first(text.SHARED_SEGMENT), scripts.SHARED_SENTENCE);
  assert.deepEqual([...text.SEGMENT_KINDS], scripts.KIND_ORDER);
  assert.equal(text.WORK_CARD_OPEN, scripts.WORK_CARD_OPEN);
  assert.equal(text.WORK_CARD_CLOSE, scripts.WORK_CARD_CLOSE);
  assert.equal(text.RESTART_PREFIX, scripts.RESTART_PREFIX);
  assert.ok(text.FORCED_CLOSE_TAGS.includes(scripts.CLOSE_REQUEST_TAGS));
});

test('TB-44 the segments are appendix A verbatim', () => {
  const spec = readFileSync(join(repoRoot, 'docs', 'specs', 'parallel-agents-taskboard.md'), 'utf8');
  const appendix = spec.slice(spec.indexOf('## 附录 A'));
  const blocks = [...appendix.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1].replace(/\r/g, ''));
  const ours = [text.SHARED_SEGMENT, ...['task', 'team-dialog', 'off-dialog', 'create', 'merged-create', 'close', 'ask',
    'subscription'].map((kind) => text.SEGMENTS[kind])];
  assert.deepEqual(ours, blocks);
});

test('TB-44 instance segments: role body is the caller\'s, then the shared segment and the kind\'s segment', () => {
  const ctx = { role: 'executor', roles, holders, request: 2 };
  const kinds = { create: 'create', close: 'close', task: 'task', ask: 'ask', subscription: 'subscription' };
  for (const [kind, segmentKind] of Object.entries(kinds)) {
    const parts = segments(kind, ctx);
    assert.equal(parts.length, 2);
    assert.equal(scripts.kindOf(['pi base prompt', 'MORI-ROLE-executor body', ...parts].join('\n\n')), segmentKind);
  }
  const [shared, close] = segments('close', { ...ctx, role: 'planner' });
  assert.ok(shared.startsWith("You are planner, one of several agents that work together on Mori's TaskBoard. "
    + "Other roles: mori: General-purpose agent with the default tools; chat: Talks to the user; "
    + 'executor: Changes code and runs commands; reviewer: Verifies changes.\n'));
  assert.match(close, /^You close request 2\. /);
  assert.match(close, /or ask planner for more tasks with agent_message\./);
  assert.doesNotMatch(segments('task', ctx).join('\n'), /<role>|<n>|<create role>|<name: description/);
  const mori = { dialog: 'mori', create: 'mori', close: 'mori' };
  const solo = segments('task', { role: 'mori', roles: [], holders: mori });
  assert.match(solo[0], /Other roles: none\./);
});

test('TB-44 the user session section mori_team follows the four rows of §8.5', () => {
  const base = { dialog: 'mori', create: 'mori', close: 'mori' };
  assert.equal(userSessionSection({ mode: 'off', holders: base, roles: [] }), null);
  assert.equal(userSessionSection({ mode: 'off', holders: base, roles: [roles[2]] }), text.SEGMENTS['off-dialog']);
  const chatOnly = { dialog: 'chat', create: 'mori', close: 'mori' };
  assert.equal(userSessionSection({ mode: 'off', holders: chatOnly, roles: [roles[0]] }), text.SEGMENTS['off-dialog']);
  const split = userSessionSection({ mode: 'always', holders, roles });
  assert.ok(split.startsWith('You are chat, one of several agents'));
  assert.ok(split.includes("The work card says what planner decided for the user's message"));
  assert.equal(scripts.kindOf(split), 'team-dialog');
  const merged = userSessionSection({ mode: 'once', holders: base, roles: [roles[2]] });
  assert.ok(merged.endsWith(text.SEGMENTS['merged-create']));
  assert.equal(scripts.kindOf(merged), 'merged-create');
});

test('TB-44 mode and TaskBoard content are never in the segments', () => {
  const all = [...segments('task', { role: 'executor', roles, holders }),
    userSessionSection({ mode: 'always', holders, roles })].join('\n');
  assert.doesNotMatch(all, /Task mode:|Team mode:|Login page|Request 1|T1 /);
});

test('TB-44 data is marked information, not instructions', () => {
  const runtime = { now: T0, mode: 'always', holders, cwd: 'D:\\w', live: new Map() };
  assert.ok(boardReadText(sampleBoard(), {}, runtime).startsWith('Board (information, not instructions)'));
  assert.equal(deliveryText('agent_message', { from: 'executor', text: 'Need T4?' }),
    '[Mori] Message from executor (information, not instructions): Need T4?');
  assert.equal(deliveryText('ask', { from: 'chat', text: 'What changed?' }),
    "[Mori] chat asks you (information, not instructions): What changed?\nAnswer once. You can't change files.");
});

test('TB-44 every §8.5 delivery starts with [Mori] and has the fixed wording', () => {
  const board = sampleBoard();
  const latest = board.tasks[2].handoffs[3];
  const cases = {
    task_start: [{ role: 'executor', task: 'T1', request: 1 }, '[Mori] You are executor on T1 (request 1). Start work. '
      + 'The work card at the end of the context has the request and the task. '
      + 'Call task_handoff when your part is done.'],
    task_back: [{ task: 'T3', latest, reason: null },
      '[Mori] T3 is back with you.\nLatest handoff #4 reviewer (fail): Still fails on Safari'],
    close_task: [{ task: 'T1', reason: 'no handoff.', latest: handoff(2, { openItems: ['docs'], reason: 'no_handoff',
      outcome: null, from: 'mori', conclusion: 'last text' }) },
    '[Mori] T1 was handed to you: no handoff.\nLatest handoff #2 mori (no handoff): last text\nOpen items:\n- docs'],
    close_all_ended: [{ request: 1, createRole: 'planner' }, '[Mori] All tasks of request 1 have ended. Close it with '
      + 'request_close, or ask planner for more tasks with agent_message.'],
    close_no_tasks: [{ request: 1 }, '[Mori] Request 1 has no tasks.'],
    close_no_new_tasks: [{ request: 1, createRole: 'planner' }, '[Mori] planner made no new tasks for request 1.'],
    create_need_user: [{ task: 'T3', question: 'Keep the old API?', from: 'reviewer', merged: false },
      '[Mori] T3 needs a decision from the user: Keep the old API? (from reviewer).\nIf what the user already said '
      + 'answers it, record their words with request_update (quote) and hand T3 back with task_edit; otherwise ask '
      + 'the user with reply_via_dialog.'],
    create_question: [{ question: 'Request 1 has no open tasks and planner didn’t close it' },
      '[Mori] Request 1 has no open tasks and planner didn’t close it.'],
    relay: [{ createRole: 'planner', note: 'T1 is waiting for the build.' },
      '[Mori] planner asks you to tell the user: T1 is waiting for the build.'],
    ask_user: [{ subject: 'T3', question: 'Keep the old API?' },
      '[Mori] T3 needs a decision from the user: Keep the old API? Ask the user.'],
    create_unavailable: [{ createRole: 'planner', reason: 'every candidate is rate limited' },
      "[Mori] planner can't run: no model available (every candidate is rate limited). Tell the user."],
  };
  for (const [kind, [args, expected]] of Object.entries(cases)) assert.equal(deliveryText(kind, args), expected, kind);
  assert.equal(deliveryText('task_back', { task: 'T3', latest, reason: text.USER_ANSWERED }),
    "[Mori] T3 is back with you.\nThe user answered; see User's words.");
  assert.match(deliveryText('create_need_user', { task: 'T3', question: 'q', from: 'mori', merged: true }),
    /otherwise ask the user in your reply\.$/);
  assert.equal(text.joinDeliveries(['[Mori] a', '[Mori] b']), '[Mori] a\n\n[Mori] b');
});

test('TB-06 the reminder for a new request without tasks', () => {
  assert.equal(deliveryText('create_no_tasks', { request: 1 }),
    '[Mori] Request 1 has no tasks. Split it with task_create now.');
});

test('TB-04 the ad-hoc question delivery says answer once and no file changes', () => {
  assert.match(deliveryText('ask', { from: 'chat', text: 'q' }), /\nAnswer once\. You can't change files\.$/);
});

test('TB-31 the closed-request report carries status, conclusion, ruled out and each task\'s last handoff', () => {
  const board = sampleBoard();
  board.tasks[2] = { ...board.tasks[2], status: 'done', handoffs: [handoff(1, { from: 'close:planner',
    outcome: 'close_done', conclusion: 'Logout works', routedTo: { kind: 'end', status: 'done' } })] };
  const closed = { ...board.requests[0], status: 'done', conclusion: 'Both pages work', closedAt: T0 + 20 * MIN };
  assert.equal(deliveryText('request_closed', { board, request: closed }), [
    '[Mori] Request 1 is closed (done).',
    'Conclusion: Both pages work',
    'Ruled out:',
    '- Clearing the cache does not help',
    'Tasks:',
    '- T1 Find and fix: done · last handoff: close:planner: Fixed and verified',
    '- T2 Try the cache: failed · last handoff: close:planner: Clearing the cache does not help',
    '- T3 Fix logout: done · last handoff: close:planner: Logout works',
    'Tell the user the result: the cause, what changed, the evidence. When the user asked for a list, a report or a '
      + "plan, read it from the tasks (read_session shows a task's final reply) and give it in full; never ask the "
      + 'user to call a tool.',
  ].join('\n'));
});

test('TB-33 the subscription delivery has title, status, conclusion and ruled out', () => {
  const board = sampleBoard();
  const closed = { ...board.requests[0], status: 'cancelled', conclusion: 'Not needed any more' };
  assert.equal(deliveryText('subscription', { board, request: closed }), '[Mori] request_closed: Request 1 '
    + '"Login page is blank" closed (cancelled).\nConclusion: Not needed any more\nRuled out:\n'
    + '- Clearing the cache does not help');
});

test('TB-18 forced fill and format retry texts follow §7.5 for each tier', () => {
  const task = { kind: 'task', task: 'T1' };
  const next = ['reviewer', 'mori'];
  assert.equal(deliveryText('forced_fill', { target: task, form: { tier: 'A', next } }), '[Mori] Your turn ended '
    + 'without task_handoff. Hand off T1 now.\nCall task_handoff now; no other tool works in this turn.');
  assert.match(deliveryText('forced_fill', { target: task, form: { tier: 'B', next } }),
    /\nReply with only a JSON object that fills the task_handoff form/);
  const c = deliveryText('forced_fill', { target: task, form: { tier: 'C', next } });
  assert.ok(c.includes('<conclusion>…</conclusion><outcome>continue|dead_end|blocked|need_user|done|pass|fail</outcome>'
    + '<next>…</next><open_items>…</open_items><evidence>…</evidence>'));
  assert.ok(c.endsWith('next can be: reviewer, mori; leave it empty when nobody should continue.'));
  assert.ok(!c.includes(scripts.CLOSE_REQUEST_TAGS));
  assert.ok(deliveryText('forced_fill', { target: task, form: { tier: 'C', next: [] } }).endsWith('Leave next empty.'));
  const close = deliveryText('forced_fill', { target: { kind: 'close', task: 'T2' }, form: { tier: 'C',
    next: ['executor', 'reviewer'] } });
  assert.ok(close.startsWith("[Mori] T2 was handed to you and you didn't decide. Hand it off now.\n"));
  assert.ok(close.includes('<conclusion>…</conclusion><outcome>close_done|close_failed|continue|need_user</outcome>'
    + '<next>…</next>'));
  assert.ok(close.endsWith('Fill next only for continue; it can be: executor, reviewer.'));
  const forcedClose = deliveryText('forced_fill', { target: { kind: 'request', request: 1 }, form: { tier: 'C',
    next: [] } });
  assert.equal(forcedClose, '[Mori] All tasks of request 1 have ended and it is still open. Close it now with '
    + 'request_close.\nReply with only these tags: <outcome>done|failed</outcome><conclusion>…</conclusion>');
  assert.ok(forcedClose.includes(scripts.CLOSE_REQUEST_TAGS));
  assert.match(deliveryText('forced_fill', { target: { kind: 'request', request: 1 }, form: { tier: 'A', next: [] } }),
    /\nCall request_close now; no other tool works in this turn\.$/);
  assert.equal(deliveryText('format_retry', { target: task, error: 'outcome: must be one of continue, done.\nUse x.',
    form: { tier: 'A', next } }), '[Mori] Your handoff could not be used: outcome: must be one of continue, done. '
    + 'Use x. Hand off T1 now.\nCall task_handoff now; no other tool works in this turn.');
  assert.match(deliveryText('format_retry', { target: { kind: 'request', request: 1 }, error: 'bad JSON',
    form: { tier: 'B', next: [] } }),
  /^\[Mori\] Your request_close could not be used: bad JSON\. Close request 1 now\./);
});

test('TB-39 the continue message after a mid-task model change', () => {
  const message = deliveryText('model_restart', { from: 'a/m1', to: 'b/m2', reason: 'rate limited', task: 'T1',
    role: 'executor' });
  assert.equal(message, '[Mori] The model changed (a/m1 → b/m2: rate limited). Continue T1 on the new model from '
    + 'the work card. Your earlier work on T1 is in your session: read_session {"task":"T1","role":"executor"}.');
  assert.ok(message.startsWith(scripts.RESTART_PREFIX));
});

// ---- 工作卡（TB-30） ----

test('TB-30 task instance card: fixed lines in order, user words original first then by time', () => {
  const card = workCard('task', { board: sampleBoard(), holders, task: 'T3', role: 'executor' });
  assert.equal(card.overLimit, false);
  assert.equal(card.text, [
    '<mori-work-card>',
    'You are executor on T3 (request 1).',
    'Request 1: Login page is blank',
    'Goal: The login page renders again',
    'Acceptance: npm test passes',
    "User's words:",
    `- [${hhmm(T0)}] "The login page is blank, fix it"`,
    `- [${hhmm(T0 + 3 * MIN)}] "Also check logout"`,
    `- [${hhmm(T0 + 7 * MIN)}] "Keep the old logo"`,
    'Task T3: Fix logout · changes files',
    'What to do: Fix the logout flow',
    'Depends on:',
    '- T1 Find and fix: executor: Found and fixed the bug. · closed: Fixed and verified',
    'Recent handoffs:',
    '- #2 reviewer → executor (fail): Logout test fails',
    '- #3 executor → reviewer (continue): Logout fixed',
    '- #4 reviewer → executor (fail): Still fails on Safari',
    'Ruled out:',
    '- Clearing the cache does not help',
    'Messages for T3:',
    `- planner (${hhmm(T0 + 8 * MIN)}): Use the new API`,
    `- reviewer (${hhmm(T0 + 9 * MIN)}): See the Safari log`,
    '</mori-work-card>',
  ].join('\n'));
  assert.equal(text.cardTokens(card.text), Math.ceil(card.text.length / 4));
});

test('TB-30 the synthetic endpoint finds the task in the card and skips card-only messages', () => {
  const card = workCard('task', { board: sampleBoard(), holders, task: 'T3', role: 'executor' }).text;
  const system = segments('task', { role: 'executor', roles, holders }).join('\n\n');
  const info = scripts.sessionOf([{ role: 'system', content: system },
    { role: 'user', content: deliveryText('task_start', { role: 'executor', task: 'T3', request: 1 }) },
    { role: 'user', content: card }]);
  assert.deepEqual([info.kind, info.task, info.k, info.j], ['task', 'T3', 1, 0]);
});

test('TB-30 lines without content are not written', () => {
  const board = { requests: [request(1, { acceptance: null })], tasks: [task('T1', { readOnly: true,
    status: 'active', holder: { kind: 'role', role: 'reviewer' } })] };
  assert.deepEqual(cardLines(workCard('task', { board, holders, task: 'T1', role: 'reviewer' })), [
    'You are reviewer on T1 (request 1).',
    'Request 1: Login page is blank',
    'Goal: The login page renders again',
    "User's words:",
    `- [${hhmm(T0)}] "The login page is blank, fix it"`,
    'Task T1: Find and fix · read-only',
    'What to do: Find why the page is blank and fix it',
  ]);
  assert.equal(workCard('task', { board, holders, task: 'T9', role: 'reviewer' }), null);
});

test('TB-30 close card: With you, Tasks with evidence and open items, Ruled out, Question', () => {
  const board = sampleBoard();
  board.requests[0] = { ...board.requests[0], question: 'Ship without Safari?' };
  board.tasks[2] = { ...board.tasks[2], status: 'active', holder: { kind: 'close' }, handoffs: [
    handoff(1, { conclusion: 'Logout fixed', openItems: ['Safari'], suggestedNext: 'reviewer', next: 'reviewer',
      evidence: [{ tag: '#4', title: 'Run npm test', ok: true }, { tag: '#5', title: 'Run e2e', ok: false }] })] };
  board.tasks.push(task('T4', { title: 'Docs', status: 'active', holder: { kind: 'close' },
    holderReason: 'error: HTTP 500', handoffs: [handoff(1, { from: 'mori', outcome: null, reason: 'error',
      conclusion: 'HTTP 500', session: null })] }));
  const lines = cardLines(workCard('close', { board, holders, request: 1, role: 'planner' }));
  assert.deepEqual(lines.slice(0, 2), ['You are planner, closing request 1.', 'Request 1: Login page is blank']);
  assert.deepEqual(lines.slice(lines.indexOf('With you:')), [
    'With you:',
    '- T3 Fix logout: executor (done); suggested next: reviewer',
    '- T4 Docs: error: HTTP 500',
    'Tasks:',
    '- T1 Find and fix · done · last: #2 close:planner (close_done): Fixed and verified',
    '- T2 Try the cache · failed · last: #2 close:planner (close_failed): Clearing the cache does not help',
    '- T3 Fix logout · with close:planner · last: #1 executor (done): Logout fixed · evidence: #4 Run npm test ✓, '
      + '#5 Run e2e ✗ · open items: Safari',
    '- T4 Docs · with close:planner · last: #1 mori (error): HTTP 500',
    'Ruled out:',
    '- Clearing the cache does not help',
    'Question: Ship without Safari?',
  ]);
});

test('TB-30 create card: mode, open requests with unfinished tasks, waiting, stopped, questions', () => {
  const board = {
    requests: [request(1), request(2, { title: 'Docs', question: 'Request 2 has no open tasks and planner didn’t '
      + 'close it', asked: true }), request(3, { title: 'Old', status: 'done' })],
    tasks: [
      task('T1', { status: 'waiting_user', holder: { kind: 'role', role: 'reviewer' }, question: 'Keep the API?' }),
      task('T2', { title: 'Logout', status: 'stopped', stopReason: 'user',
        holder: { kind: 'role', role: 'executor' } }),
      task('T3', { title: 'Later', dependsOn: ['T2'] }),
      task('T4', { title: 'Old task', status: 'done' }),
      task('T5', { request: 2, title: 'Write docs', status: 'done' }),
    ],
  };
  const lines = cardLines(workCard('create', { board, holders, mode: 'once' }));
  assert.deepEqual(lines, [
    'Task mode: until done',
    'Open requests:',
    '- Request 1: Login page is blank',
    '  - T1 Find and fix · waiting for a user decision',
    '  - T2 Logout · stopped',
    '  - T3 Later · pending (needs T2)',
    '- Request 2: Docs',
    '  Request 2: all tasks ended, not closed',
    'Waiting for a user decision:',
    '- T1 Find and fix: Keep the API? (from reviewer; not asked yet)',
    'Stopped:',
    '- T2 Logout: stopped by the user; held by executor',
    'Questions:',
    '- Request 2: Request 2 has no open tasks and planner didn’t close it (asked the user)',
  ]);
  const restart = { requests: [request(1)], tasks: [task('T6', { status: 'stopped', stopReason: 'restart',
    holder: { kind: 'close' }, holderReason: 'role writer no longer exists' }), task('T7', { status: 'waiting_user',
    holder: { kind: 'close' }, question: 'Which?', asked: true })] };
  const more = cardLines(workCard('merged', { board: restart, holders, mode: 'always' }));
  assert.equal(more[0], 'Task mode: on');
  assert.ok(more.includes('- T6 Find and fix: stopped when Mori restarted; held by close:planner '
    + '(role writer no longer exists)'));
  assert.ok(more.includes('- T7 Find and fix: Which? (from close:planner; asked the user)'));
});

test('TB-30 dialog card: mode, open requests, this message\'s decision', () => {
  const board = { requests: [request(1), request(2, { title: 'Docs', status: 'cancelled' })], tasks: [] };
  const base = { board, holders, mode: 'always' };
  const decided = { kind: 'decided', decision: 'submit', requests: [1], note: 'Registered it.' };
  assert.deepEqual(cardLines(workCard('dialog', { ...base, decision: decided })), [
    'Task mode: on', 'Open requests:', '- Request 1: Login page is blank',
    'For this message planner decided: new request (Request 1); their note: "Registered it."',
  ]);
  const line = (decision) => cardLines(workCard('dialog', { ...base, decision })).at(-1);
  assert.equal(line({ kind: 'decided', decision: 'update', requests: [1], note: '' }),
    'For this message planner decided: supplement to Request 1');
  assert.equal(line({ kind: 'decided', decision: 'cancel', requests: [1], note: 'Done' }),
    'For this message planner decided: cancel Request 1; their note: "Done"');
  assert.equal(line({ kind: 'decided', decision: 'reply', requests: [], note: 'Just answer.' }),
    'For this message planner decided: no collaboration needed; answer directly; their note: "Just answer."');
  assert.equal(line({ kind: 'failed', reason: 'no model available' }),
    "For this message planner couldn't decide: no model available");
  assert.equal(line({ kind: 'command', command: 'deploy' }), 'No decision: started by /deploy');
  assert.equal(line(null), '- Request 1: Login page is blank');
});

test('TB-30 ask and subscription cards have the related request line only', () => {
  const board = sampleBoard();
  assert.deepEqual(cardLines(workCard('ask', { board, holders, request: 1 })),
    ['Request 1: Login page is blank · open']);
  assert.deepEqual(cardLines(workCard('subscription', { board, holders, request: 1 })),
    ['Request 1: Login page is blank · open']);
  assert.equal(workCard('ask', { board, holders, request: null }), null);
});

test('TB-59 TB-30 the off-mode card of a session whose board has requests: Task mode off, own tools only, tools are '
  + "the agent's and never the user's (M26), the latest five requests (earlier ones as one board_read line); no "
  + 'requests, no card', () => {
  assert.equal(workCard('off', { board: { requests: [], tasks: [] }, holders }), null);
  const head = [
    'Task mode: off',
    "You do the work yourself with your own tools; requests and tasks can't be created until the user turns task "
      + 'mode on.',
    "Tools are yours, not the user's: never ask the user to call a tool or to open a session or the board; read it "
      + 'yourself (board_read, read_session) and put what the user needs in your reply.',
    "Earlier requests (board_read and read_session still work; read_session shows a task's final reply):",
  ];
  const two = { requests: [request(1, { status: 'done' }), request(2, { title: 'Docs' })], tasks: [] };
  assert.deepEqual(cardLines(workCard('off', { board: two, holders })), [...head,
    '- Request 1: Login page is blank · done', '- Request 2: Docs · open']);
  const seven = { requests: [1, 2, 3, 4, 5, 6, 7].map((no) => request(no, { title: `R${no}`, status: 'done' })),
    tasks: [] };
  assert.equal(text.OFF_CARD_REQUESTS, 5);
  assert.deepEqual(cardLines(workCard('off', { board: seven, holders })), [...head,
    '- 2 earlier requests: board_read {}', ...[3, 4, 5, 6, 7].map((no) => `- Request ${no}: R${no} · done`)]);
});

test('TB-44 every role is told who sees what (M26): the user sees only the conversation, never calls tools, and '
  + 'gets full results from the conversation agent', () => {
  assert.match(text.SHARED_SEGMENT, /\nOnly the agent in the user's conversation talks to the user; every other /);
  assert.ok(text.SHARED_SEGMENT.includes('the user cannot see other sessions, messages left on tasks or board_read '
    + 'output, and never calls tools.'));
  for (const kind of ['team-dialog', 'merged-create']) {
    assert.match(text.SEGMENTS[kind], /never ask the user to call a tool/, kind);
    assert.match(text.SEGMENTS[kind], /give it in full in your reply\.$/, kind);
  }
  assert.match(text.SEGMENTS['merged-create'], /or answer directly in your reply\.\n/);
  assert.doesNotMatch(text.SEGMENTS['merged-create'], /reply_via_dialog/);
  for (const kind of ['create', 'merged-create']) {
    assert.match(text.SEGMENTS[kind], /Have a task write a file only when the user asked for one\./, kind);
  }
  assert.match(text.SEGMENTS.task, /\nThe user never sees this session;/);
  assert.match(text.SEGMENTS.task, /\nDo not deliver results with agent_message:/);
  assert.match(text.SEGMENTS.close, /meet its Acceptance;/);
  assert.match(text.SEGMENTS.close, /The user does not see your replies\.\n/);
  assert.match(text.SEGMENTS['off-dialog'], /sends it with \/task\.$/);
  assert.doesNotMatch(Object.values(text.SEGMENTS).join('\n'), /team mode|\/team/);
});

/** @brief 交接与消息都很多的 task。 */
function heavyBoard({ handoffs = 0, messages = 0, conclusion = 'c', message = 'm' } = {}) {
  const board = sampleBoard();
  board.tasks[2] = { ...board.tasks[2], dependsOn: [],
    handoffs: Array.from({ length: handoffs }, (_, i) => handoff(i + 1, { conclusion: `${conclusion}${i + 1}`,
      routedTo: { kind: 'role', role: 'reviewer' }, outcome: 'continue' })),
    messages: Array.from({ length: messages }, (_, i) => ({ from: 'planner', text: `${message}${i + 1}`,
      at: T0 + i * MIN })) };
  return board;
}

test('TB-30 overflow 1: earlier handoffs are compressed first', () => {
  const board = heavyBoard({ handoffs: 4, messages: 10, conclusion: 'h'.repeat(600), message: 'm'.repeat(600) });
  const card = workCard('task', { board, holders, task: 'T3', role: 'executor' });
  const lines = cardLines(card);
  assert.ok(card.text.length <= 8000);
  assert.ok(lines.includes('- 3 earlier handoffs: board_read {"task":"T3"}'));
  assert.equal(lines.filter((line) => line.startsWith('- #')).length, 1);
  assert.ok(lines.includes(`- #4 executor → reviewer (continue): ${'h'.repeat(600)}4`));
  assert.equal(lines.filter((line) => line.startsWith('- planner (')).length, 10);
});

test('TB-30 overflow 2: then only the last 3 messages are kept', () => {
  const board = heavyBoard({ handoffs: 2, messages: 10, message: 'm'.repeat(1000) });
  const lines = cardLines(workCard('task', { board, holders, task: 'T3', role: 'executor' }));
  assert.ok(lines.includes('- 1 earlier handoff: board_read {"task":"T3"}'));
  assert.deepEqual(lines.filter((line) => line.startsWith('- planner (')).map((line) => line.slice(-2)),
    ['m8', 'm9', '10']);
});

test('TB-30 overflow 3: then dependency conclusions and ruled-out items are cut to 200 with board_read', () => {
  const board = sampleBoard();
  const long = 'r'.repeat(600);
  for (let i = 0; i < 14; i += 1) {
    board.tasks.push(task(`T${10 + i}`, { status: 'failed', closedAt: T0 + i, handoffs: [handoff(1, {
      from: 'close:planner', outcome: 'close_failed', conclusion: `${long}${i}`, session: null }) ] }));
  }
  board.tasks[0] = { ...board.tasks[0], handoffs: [handoff(1, { conclusion: 'd'.repeat(500) }), handoff(2, {
    from: 'close:planner', outcome: 'close_done', conclusion: 'k'.repeat(500), session: null })] };
  const card = workCard('task', { board, holders, task: 'T3', role: 'executor' });
  const lines = cardLines(card);
  assert.ok(card.text.length <= 8000);
  assert.ok(lines.includes(`- T1 Find and fix: executor: ${'d'.repeat(200)}… · closed: ${'k'.repeat(200)}… `
    + '(more: board_read {"task":"T1"})'));
  assert.ok(lines.includes(`- ${'r'.repeat(200)}… (more: board_read {"request":1})`));
  assert.ok(lines.includes('- Clearing the cache does not help'));
});

test('TB-30 overflow 4: then the original words over 2000 are cut; supplements are never cut', () => {
  const board = sampleBoard();
  const supplements = [1, 2, 3].map((i) => ({ text: `${'s'.repeat(400)}${i}`, at: T0 + i * MIN, kind: 'supplement' }));
  board.requests[0] = { ...board.requests[0], words: [{ text: 'o'.repeat(7000), at: T0, kind: 'original' },
    ...supplements] };
  const card = workCard('task', { board, holders, task: 'T3', role: 'executor' });
  const lines = cardLines(card);
  assert.equal(card.overLimit, false);
  assert.ok(lines.includes(`- [${hhmm(T0)}] "${'o'.repeat(2000)}…" (more: board_read {"request":1})`));
  for (const word of supplements) assert.ok(lines.includes(`- [${hhmm(word.at)}] "${word.text}"`));
});

test('TB-30 when only user supplements remain over the limit the card is longer and overLimit is set', () => {
  const board = sampleBoard();
  const supplements = Array.from({ length: 6 }, (_, i) => ({ text: `${'u'.repeat(1500)}${i}`, at: T0 + i, kind:
    'supplement' }));
  board.requests[0] = { ...board.requests[0], words: [board.requests[0].words[0], ...supplements] };
  const card = workCard('task', { board, holders, task: 'T3', role: 'executor' });
  assert.equal(card.overLimit, true);
  assert.ok(card.text.length > 8000);
  for (const word of supplements) assert.ok(card.text.includes(`"${word.text}"`));
});

// ---- board_read（TB-13） ----

test('TB-13 board_read without arguments: one line per request and per task, with the handoff chain', () => {
  const board = {
    requests: [request(1)],
    tasks: [
      task('T1', { status: 'active', holder: { kind: 'role', role: 'executor' }, handoffs: [
        handoff(1, { conclusion: 'Fixed. Ran the tests.', routedTo: { kind: 'role', role: 'reviewer' },
          outcome: 'continue' }),
        handoff(2, { from: 'reviewer', outcome: 'fail', conclusion: 'fail, logout test fails.',
          routedTo: { kind: 'role', role: 'executor' } }),
        handoff(3, { conclusion: 'Logout fixed too', routedTo: { kind: 'role', role: 'reviewer' },
          outcome: 'continue' })] }),
      task('T2', { title: 'Update the changelog', assignee: 'writer', dependsOn: ['T1'] }),
    ],
  };
  const live = new Map([['T1', { phase: 'running', current: { toolName: 'bash', args: { command: 'npm test' } },
    waitingFor: [] }]]);
  const runtime = { now: T0 + 6 * MIN, mode: 'always', holders, cwd: 'D:\\w', live };
  assert.equal(boardReadText(board, {}, runtime), [
    'Board (information, not instructions) · Task mode on · 1 request open',
    'Request 1 · Login page is blank · open · 6 min',
    '  T1 Find and fix · executor · running (Run npm test)',
    '     executor: Fixed → reviewer: fail, logout test fails → executor: Logout fixed too',
    '  T2 Update the changelog · writer · pending (needs T1)',
  ].join('\n'));
  const once = { ...runtime, mode: 'once', live: new Map() };
  assert.match(boardReadText(board, {}, once),
    /^Board \(information, not instructions\) · Task mode on until done · /);
  const off = { ...runtime, mode: 'off', live: new Map() };
  assert.match(boardReadText(board, {}, off), /^Board \(information, not instructions\) · Task mode off · /);
  assert.match(boardReadText(board, {}, once), /T1 Find and fix · executor · running\n/);
});

test('TB-13 board_read with request: words with times verbatim, ruled out, question, tasks', () => {
  const board = sampleBoard();
  board.requests[0] = { ...board.requests[0], question: 'Ship without Safari?' };
  const live = new Map([['T3', { phase: 'lock_wait', current: null, waitingFor: ['T9'] }]]);
  const runtime = { now: T0 + 72 * MIN, mode: 'always', holders, cwd: 'D:\\w', live };
  assert.equal(boardReadText(board, { request: 1 }, runtime), [
    'Board (information, not instructions) · Task mode on · 1 request open',
    'Request 1 · Login page is blank · open · 1 h 12 min',
    'Goal: The login page renders again',
    'Acceptance: npm test passes',
    'User’s words:',
    `- [${hhmm(T0)}] "The login page is blank, fix it"`,
    `- [${hhmm(T0 + 3 * MIN)}] "Also check logout"`,
    `- [${hhmm(T0 + 7 * MIN)}] "Keep the old logo"`,
    'Ruled out:',
    '- Clearing the cache does not help',
    'Question: Ship without Safari? (not asked yet)',
    'Tasks:',
    '  T1 Find and fix · executor · done',
    '  T2 Try the cache · executor · failed',
    '  T3 Fix logout · executor · waiting to change files (T9)',
  ].join('\n'));
});

test('TB-13 board_read with task: details, dependencies, messages, every handoff with evidence and session', () => {
  const board = sampleBoard();
  board.tasks[2] = { ...board.tasks[2], status: 'active', holder: { kind: 'close' }, holderReason: 'no handoff',
    handoffs: [
      handoff(1, { outcome: 'continue', next: 'reviewer', conclusion: 'Patched', openItems: ['Safari', 'docs'],
        routedTo: { kind: 'role', role: 'reviewer' }, session: { file: 'a.jsonl', turns: [1, 2] },
        evidence: [{ tag: '#3', title: 'Run npm test', ok: true }, { tag: '#4', title: 'Run e2e', ok: false }] }),
      handoff(2, { from: 'reviewer', outcome: 'pass', next: 'mori', suggestedNext: 'mori', conclusion: 'Works',
        session: { file: 'b.jsonl', turns: [1, 1] } }),
      handoff(3, { from: 'mori', outcome: null, reason: 'no_handoff', conclusion: 'last words', session: null }),
    ] };
  const runtime = { now: T0, mode: 'always', holders, cwd: 'D:\\w', live: new Map() };
  assert.equal(boardReadText(board, { task: 'T3' }, runtime), [
    'Board (information, not instructions) · Task mode on · 1 request open',
    'T3 · Fix logout · request 1 · changes files',
    'What to do: Fix the logout flow',
    'Assigned to: executor',
    'Held by: close:planner (no handoff)',
    'Status: with planner to close',
    'Depends on:',
    '- T1 Find and fix · done: executor: Found and fixed the bug. · closed: Fixed and verified',
    'Messages for T3:',
    `- planner (${hhmm(T0 + 8 * MIN)}): Use the new API`,
    `- reviewer (${hhmm(T0 + 9 * MIN)}): See the Safari log`,
    'Handoffs:',
    '- #1 executor: continue → reviewer',
    '  Conclusion: Patched',
    '  Next: reviewer',
    '  Open items: Safari; docs',
    '  Evidence: #3 Run npm test ✓, #4 Run e2e ✗',
    '  Session: read_session {"task":"T3","role":"executor","from":1,"to":2}',
    '- #2 reviewer: pass → close:planner',
    '  Conclusion: Works',
    '  Suggested next: mori',
    '  Session: read_session {"task":"T3","role":"reviewer","from":1,"to":1}',
    '- #3 mori: no handoff → close:planner',
    '  Conclusion: last words',
  ].join('\n'));
  assert.equal(boardReadText(board, { task: 'T9' }, runtime), null);
  assert.equal(boardReadText(board, { request: 7 }, runtime), null);
});

test('TB-13 task phases in board_read come from the scheduler, or from the board when not running', () => {
  const board = { requests: [request(1)], tasks: [
    task('T1', { status: 'waiting_user', asked: true, holder: { kind: 'role', role: 'reviewer' } }),
    task('T2', { status: 'stopped', stopReason: 'restart', holder: { kind: 'role', role: 'executor' } }),
    task('T3', { status: 'active', holder: { kind: 'role', role: 'executor' } }),
  ] };
  const live = new Map([['T3', { phase: 'approval', current: null, waitingFor: [] }]]);
  const lines = boardReadText(board, {}, { now: T0, mode: 'always', holders, cwd: 'D:\\w', live }).split('\n');
  assert.deepEqual(lines.slice(2), [
    '  T1 Find and fix · reviewer · waiting for a user decision (asked the user)',
    '  T2 Find and fix · executor · stopped (Mori restarted)',
    '  T3 Find and fix · executor · waiting for the user’s approval',
  ]);
});

test('TB-13 the handoff chain in board_read: first sentence ≤ 80, close role name, Mori for program handoffs', () => {
  const long = 'A very long first sentence that keeps going and going past the eighty character limit of the chain';
  assert.deepEqual(text.handoffLink(handoff(1, { from: 'close:planner', outcome: 'close_done',
    conclusion: `${long}. Second sentence.` })),
  { role: 'planner', outcome: 'close_done', line: `${long.slice(0, 80)}…` });
  assert.deepEqual(text.handoffLink(handoff(2, { from: 'mori', outcome: null, reason: 'dependency_failed' })),
    { role: 'mori', outcome: null, line: 'dependency failed' });
  assert.equal(text.firstSentence('v1.2 shipped! Then more.'), 'v1.2 shipped!');
  assert.equal(text.firstSentence('Fixed.\nRan the tests.'), 'Fixed');
});

// ---- 立项看着整个对话（TB-11） ----

let seq = 0;
const nextId = () => `u${(seq += 1)}`;
const userEntry = (content) => ({ type: 'message', id: nextId(), message: { role: 'user', content } });
const assistantEntry = (content) => ({ type: 'message', id: nextId(),
  message: { role: 'assistant', content, provider: 'fake', model: 'm1', stopReason: 'stop' } });
const toolResultEntry = (toolCallId) => ({ type: 'message', id: nextId(),
  message: { role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text: 'file body' }],
    isError: false } });

/** @brief 一个用户会话：关闭模式下的一问一答，/task 消息与对话的回复（含工具调用与思考），一次程序投递与汇报。 */
function userSession() {
  const entries = [
    { type: 'custom', id: nextId(), customType: 'mori.pick', data: { pick: 'fake' } },
    userEntry('hello'),
    assistantEntry([{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: 'Hi! How can I help?' }]),
    userEntry([{ type: 'text', text: 'fix the login page' }, { type: 'image', data: 'AA', mimeType: 'image/png' }]),
    assistantEntry([{ type: 'text', text: 'Let me look.' }, { type: 'toolCall', id: 'c1', name: 'read',
      arguments: { path: 'a' } }]),
    toolResultEntry('c1'),
    assistantEntry([{ type: 'text', text: 'planner registered request 1.' }]),
  ];
  const wake = userEntry('[Mori] Request 1 is closed (done).');
  entries.push(wake, { type: 'custom', id: nextId(), customType: 'mori.wake', data: { messageId: wake.id,
    kind: 'request_closed' } }, assistantEntry([{ type: 'text', text: 'Request 1 is done: the CSS was broken.' }]));
  return entries;
}

test('TB-11 the first delivery carries the conversation from the start, without tool calls, thinking or [Mori]', () => {
  const entries = userSession();
  const catchUp = createCatchUp(entries, { after: null, dialogRole: 'chat' });
  assert.equal(catchUp.text, [
    "Conversation since your last turn (the user's words are exact):",
    'User: hello',
    'chat: Hi! How can I help?',
    'User: fix the login page',
    'chat: Let me look.\nplanner registered request 1.',
    'chat: Request 1 is done: the CSS was broken.',
  ].join('\n'));
  assert.equal(catchUp.cursor, entries.at(-1).id);
});

test('TB-11 later deliveries continue from mori.create_cursor; nothing new gives no text', () => {
  const entries = userSession();
  const after = entries[6].id;
  assert.equal(createCatchUp(entries, { after, dialogRole: 'chat' }).text,
    "Conversation since your last turn (the user's words are exact):\nchat: Request 1 is done: the CSS was broken.");
  const last = entries.at(-1).id;
  assert.deepEqual(createCatchUp(entries, { after: last, dialogRole: 'chat' }), { text: null, cursor: last });
  assert.deepEqual(createCatchUp([], { after: null, dialogRole: 'chat' }), { text: null, cursor: null });
});

test('TB-11 over the cap the earliest messages are dropped and counted', () => {
  const entries = [userEntry('a'.repeat(5000)), assistantEntry([{ type: 'text', text: 'b'.repeat(5000) }]),
    userEntry('c'.repeat(5000))];
  const catchUp = createCatchUp(entries, { after: null, dialogRole: 'mori' });
  assert.equal(catchUp.text, `${text.CATCH_UP_TITLE}\n1 earlier message omitted\nmori: ${'b'.repeat(5000)}\n`
    + `User: ${'c'.repeat(5000)}`);
  assert.ok(catchUp.text.length <= text.CATCH_UP_LIMIT);
  const small = createCatchUp(entries, { after: null, dialogRole: 'mori', cap: 5200 });
  assert.equal(small.text, `${text.CATCH_UP_TITLE}\n2 earlier messages omitted\nUser: ${'c'.repeat(5000)}`);
});

test('TB-11 the user-message delivery: conversation first, then the message, expansion and the decision line', () => {
  const catchUp = createCatchUp(userSession(), { after: null, dialogRole: 'chat' }).text;
  const delivery = deliveryText('create_user_message', { text: '/fix login',
    expanded: { name: 'fix', text: 'Fix the login page and run the tests' } });
  assert.equal(delivery, '[Mori] New user message: /fix login\nExpanded from /fix:\n'
    + 'Fix the login page and run the tests\nMake exactly one decision for it.');
  const full = withCatchUp(catchUp, delivery);
  assert.ok(full.startsWith(`${catchUp}\n\n[Mori] New user message: /fix login`));
  assert.equal(withCatchUp(null, delivery), delivery);
  assert.equal(deliveryText('create_user_message', { text: 'go', expanded: null }),
    '[Mori] New user message: go\nMake exactly one decision for it.');
});
