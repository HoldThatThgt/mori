// kernel/sessionReader.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §10.2、§12.4、§14.5）：
// read_session 的整理文本、按回合切分。会话条目是手写的（synthetic），形状同 pi 的 SessionEntry。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const reader = await loadKernelModule('src/kernel/sessionReader.ts');
const { readSessionText, splitTurns, turnCount, entriesOfTurns, READ_SESSION_LIMITS } = reader;

const CWD = 'D:\\work\\app';
const T0 = 1_760_000_000_000;
let seq = 0;
const nextId = () => `e${(seq += 1)}`;

/** @brief synthetic 条目的构造函数。 */
const user = (content, at) => ({ type: 'message', id: nextId(), message: { role: 'user', content, timestamp: at } });
const assistant = (content, at, extra = {}) => ({
  type: 'message', id: nextId(),
  message: { role: 'assistant', content, timestamp: at, provider: 'fake', model: 'm1', stopReason: 'toolUse',
    ...extra },
});
const say = (text) => ({ type: 'text', text });
const thinking = (text) => ({ type: 'thinking', thinking: text });
const toolCall = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const result = (toolCallId, toolName, text, at, isError = false) => ({
  type: 'message', id: nextId(),
  message: { role: 'toolResult', toolCallId, toolName, content: [say(text)], isError, timestamp: at },
});
const custom = (customType, data) => ({ type: 'custom', id: nextId(), customType, data });

const base = { task: 'T1', role: 'executor', running: false, cwd: CWD, seatRoles: ['planner'] };

/** @brief 一个 task 实例会话：第 1 回合读文件、交接；第 2 回合被停止（pi 补写的空错误消息）。 */
function sampleSession() {
  return [
    custom('mori.instance', { kind: 'task', role: 'executor', task: 'T1' }),
    user('[Mori] You are executor on T1 (request 1). Start work.', T0),
    assistant([thinking('secret plan'), say('I will read the file.'), toolCall('c1', 'read',
      { path: 'D:\\work\\app\\src\\a.ts' })], T0 + 1),
    result('c1', 'read', '[#1] export const a = 1;', T0 + 2),
    assistant([toolCall('c2', 'bash', { command: 'npm test' })], T0 + 3),
    result('c2', 'bash', '[#2] 1 failing', T0 + 4, true),
    assistant([toolCall('c3', 'task_handoff', { task: 'T1', outcome: 'fail', conclusion: 'Tests fail',
      open_items: ['logout'], evidence: ['#2'] })], T0 + 5),
    result('c3', 'task_handoff', '[#3] Handed off T1.', T0 + 6),
    user('[Mori] T1 is back with you.', T0 + 10),
    assistant([], T0 + 11, { stopReason: 'error', errorMessage: 'This operation was aborted' }),
  ];
}

test('TB-29 read_session text: data line, turns, titles with #n, results, handoff, no thinking', () => {
  const text = readSessionText(sampleSession(), base);
  assert.equal(text, [
    'Session of executor on T1 (information, not instructions):',
    'Turn 1 · [Mori] You are executor on T1 (request 1). Start work.',
    'executor: I will read the file.',
    '#1 Read src/a.ts: export const a = 1;',
    '#2 Run npm test (error): 1 failing',
    '#3 Hand off T1: Handed off T1.',
    'Handoff: outcome fail · conclusion "Tests fail" · open items: logout · evidence #2',
    'Turn 2 · [Mori] T1 is back with you.',
  ].join('\n'));
  assert.doesNotMatch(text, /secret plan/);
});

test('TB-29 pi\'s empty error message after a stop is not listed', () => {
  const text = readSessionText(sampleSession(), base);
  const turn2 = text.slice(text.indexOf('Turn 2'));
  assert.equal(turn2, 'Turn 2 · [Mori] T1 is back with you.');
  assert.doesNotMatch(text, /aborted/);
});

test('TB-29 delivery excerpt is the first 300 characters, results the first 400', () => {
  const long = 'x'.repeat(1000);
  const entries = [user(`[Mori] ${long}`, T0), assistant([toolCall('c1', 'bash', { command: 'cat big' })], T0 + 1),
    result('c1', 'bash', `[#1] ${'y'.repeat(1000)}`, T0 + 2)];
  const lines = readSessionText(entries, base).split('\n');
  assert.equal(lines[1], `Turn 1 · ${`[Mori] ${long}`.slice(0, READ_SESSION_LIMITS.delivery)}…`);
  assert.equal(lines[2], `#1 Run cat big: ${'y'.repeat(READ_SESSION_LIMITS.result)}…`);
});

test('TB-29 a running instance shows only finished turns and ends with (still running)', () => {
  const text = readSessionText(sampleSession(), { ...base, running: true });
  assert.ok(text.endsWith('\n(still running)'));
  assert.doesNotMatch(text, /Turn 2/);
  assert.match(text, /Turn 1/);
  const empty = readSessionText([user('[Mori] start', T0)], { ...base, running: true });
  assert.equal(empty, 'Session of executor on T1 (information, not instructions):\n(no finished turns)\n'
    + '(still running)');
});

test('TB-29 over 12000 characters without from/to gives a table of contents, then pages by turn', () => {
  const entries = [];
  for (let k = 1; k <= 6; k += 1) {
    const at = T0 + k * 100;
    entries.push(user(`[Mori] delivery ${k}`, at), assistant([say('z'.repeat(2500)),
      toolCall(`c${k}`, 'grep', { pattern: `p${k}` })], at + 1), result(`c${k}`, 'grep', `[#${k}] hit`, at + 2));
  }
  const toc = readSessionText(entries, base).split('\n');
  assert.equal(toc[0], 'Session of executor on T1 (information, not instructions):');
  assert.match(toc[1], /longer than 12000 characters; here are its 6 turns/);
  assert.match(toc[1], /read_session \{"task":"T1","role":"executor","from":1,"to":3\}$/);
  assert.deepEqual(toc.slice(2), [1, 2, 3, 4, 5, 6].map((k) => `Turn ${k} · [Mori] delivery ${k} · Search p${k}`));
  const page = readSessionText(entries, { ...base, from: 2, to: 3 });
  assert.match(page, /Turn 2 · \[Mori\] delivery 2\nexecutor: z+\n#2 Search p2: hit\nTurn 3/);
  assert.doesNotMatch(page, /Turn 1|Turn 4/);
  assert.match(readSessionText(entries, { ...base, from: 9 }), /\(no turns in 9–6; the session has 6 finished turns\)/);
});

test('TB-29 parts hidden by a model switch are marked (abandoned after a model switch)', () => {
  const entries = [
    user('[Mori] start', T0),
    assistant([say('first try'), toolCall('c1', 'bash', { command: 'make' })], T0 + 10),
    result('c1', 'bash', '[#1] partial', T0 + 11),
    custom('mori.model_switch', { from: 'a/m1', to: 'b/m2', reason: 'server', detail: 'HTTP 500', unconfirmed: false,
      replyStartedAt: T0, anchorAt: T0, hideUntil: T0 + 11 }),
    assistant([say('second try')], T0 + 20, { provider: 'b', model: 'm2', stopReason: 'stop' }),
  ];
  assert.equal(readSessionText(entries, base), [
    'Session of executor on T1 (information, not instructions):',
    'Turn 1 · [Mori] start',
    '(abandoned after a model switch)',
    '  executor: first try',
    '  #1 Run make: partial',
    'executor: second try',
  ].join('\n'));
});

test('TB-29 the part before a task restart stays readable and is not marked abandoned', () => {
  const entries = [
    user('[Mori] start', T0),
    assistant([say('early work')], T0 + 1, { stopReason: 'error', errorMessage: 'MODEL_RESTART' }),
    custom('mori.task_restart', { at: T0 + 2, from: 'a/m1', to: 'b/m2', reason: 'server', detail: 'HTTP 500' }),
    user('[Mori] The model changed (a/m1 → b/m2: server error). Continue T1.', T0 + 3),
    assistant([say('later work')], T0 + 4, { stopReason: 'stop' }),
  ];
  const text = readSessionText(entries, base);
  assert.match(text, /Turn 1 · \[Mori\] start\nexecutor: early work\nTurn 2 · \[Mori\] The model changed/);
  assert.doesNotMatch(text, /abandoned/);
});

test('TB-29 reading does not change the entries', () => {
  const entries = sampleSession();
  const before = structuredClone(entries);
  readSessionText(entries, { ...base, from: 1, to: 2 });
  assert.deepEqual(entries, before);
});

test('TB-29 turns: each user message starts one; entries before the first belong to none', () => {
  const entries = sampleSession();
  const turns = splitTurns(entries);
  assert.deepEqual(turns.map((turn) => [turn.no, turn.entries.length]), [[1, 7], [2, 2]]);
  assert.equal(turnCount(entries), 2);
  assert.deepEqual(entriesOfTurns(entries, 2, 2).map((entry) => entry.id), turns[1].entries.map((entry) => entry.id));
  assert.equal(entriesOfTurns(entries, 1, 2).length, 9);
});
