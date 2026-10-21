// kernel/evidence.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §7.3、§12.9）：证据编号、引用的写法、核对、
// 改过代码不能给自己写通过、一棒里改代码的模型族。会话条目是手写的（synthetic），形状同 pi 的 SessionEntry。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const evidence = await loadKernelModule('src/kernel/evidence.ts');
const reader = await loadKernelModule('src/kernel/sessionReader.ts');
const {
  tagResult, nextTag, parseEvidence, verifyEvidence, evidenceRejection, authorCheck, passRejection,
  outcomeEvidenceError, authorFamilies,
} = evidence;

const CWD = 'D:\\work\\app';
const titles = { cwd: CWD, seatRoles: ['planner'], task: 'T1' };
let seq = 0;
const nextId = () => `e${(seq += 1)}`;

/** @brief synthetic 条目的构造函数。 */
const user = (content) => ({ type: 'message', id: nextId(), message: { role: 'user', content } });
const assistant = (calls, model = 'm1', provider = 'fake') => ({
  type: 'message', id: nextId(),
  message: { role: 'assistant', provider, model, stopReason: 'toolUse',
    content: calls.map(([id, name, args]) => ({ type: 'toolCall', id, name, arguments: args })) },
});
const result = (toolCallId, toolName, text, isError = false) => ({
  type: 'message', id: nextId(),
  message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError },
});

/** @brief 一个 task 实例会话：#1 读文件、#2 测试失败、#3 测试通过。 */
function session() {
  return [
    user('[Mori] You are executor on T1 (request 1).'),
    assistant([['c1', 'read', { path: 'D:\\work\\app\\src\\a.ts' }]]),
    result('c1', 'read', '[#1] export const a = 1;'),
    assistant([['c2', 'bash', { command: 'npm test' }]]),
    result('c2', 'bash', '[#2] 1 failing', true),
    assistant([['c3', 'bash', { command: 'npm test' }]]),
    result('c3', 'bash', '[#3] all passing'),
  ];
}

test('TB-16 tagResult puts [#n] before the first text part and keeps the other parts', () => {
  const content = [{ type: 'image', data: 'AA', mimeType: 'image/png' }, { type: 'text', text: 'out' },
    { type: 'text', text: 'more' }];
  const before = structuredClone(content);
  assert.deepEqual(tagResult(content, 4), [content[0], { type: 'text', text: '[#4] out' }, content[2]]);
  assert.deepEqual(content, before);
  assert.deepEqual(tagResult([{ type: 'image', data: 'AA', mimeType: 'image/png' }], 2),
    [{ type: 'text', text: '[#2]' }, { type: 'image', data: 'AA', mimeType: 'image/png' }]);
  const tagged = { role: 'toolResult', content: tagResult([], 7) };
  assert.equal(reader.resultTagOf(tagged), 7);
});

test('TB-16 numbering continues from the largest number already in the session (reopened sessions)', () => {
  assert.equal(nextTag([]), 1);
  assert.equal(nextTag([user('[Mori] start')]), 1);
  assert.equal(nextTag(session()), 4);
  const gap = [...session(), assistant([['c9', 'read', { path: 'b' }]]), result('c9', 'read', '[#9] x')];
  assert.equal(nextTag(gap), 10);
});

test('TB-16 evidence is accepted written as #3, 3 or [#3]', () => {
  assert.deepEqual(parseEvidence(['#3', '3', '[#3]', 2, ' [#1] ']), { tags: ['#3', '#2', '#1'], invalid: [] });
  assert.deepEqual(parseEvidence(['#0', 'three', '#3a', '[3]', -1, null]),
    { tags: [], invalid: ['#0', 'three', '#3a', '[3]', '-1', 'null'] });
});

test('TB-16 verify: each number must be a finished tool call of this instance session; records title and ok', () => {
  const check = verifyEvidence(session(), ['#3', '#2'], titles);
  assert.deepEqual(check.ok, [
    { tag: '#3', toolCallId: 'c3', toolName: 'bash', title: 'Run npm test', ok: true },
    { tag: '#2', toolCallId: 'c2', toolName: 'bash', title: 'Run npm test', ok: false },
  ]);
  assert.deepEqual(check.bad, []);
  const other = [user('[Mori] other'), assistant([['x1', 'read', { path: 'z' }]]), result('x1', 'read', '[#8] z')];
  const unfinished = [...session(), assistant([['c4', 'bash', { command: 'sleep 9' }]])];
  const wrong = verifyEvidence(unfinished, ['#8', '#4', '#1'], titles);
  assert.deepEqual(wrong.bad, ['#8', '#4']);
  assert.deepEqual(wrong.ok.map((record) => record.tag), ['#1']);
  assert.deepEqual(verifyEvidence(other, ['#8'], titles).bad, []);
});

test('TB-16 a rejection lists the bad numbers and the 5 most recent numbers with titles', () => {
  const entries = [user('[Mori] start')];
  for (let n = 1; n <= 7; n += 1) {
    entries.push(assistant([[`c${n}`, 'grep', { pattern: `p${n}` }]]), result(`c${n}`, 'grep', `[#${n}] hit`, n === 7));
  }
  const check = verifyEvidence(entries, ['#12'], titles);
  assert.deepEqual(check.recent.map((record) => record.tag), ['#3', '#4', '#5', '#6', '#7']);
  assert.equal(evidenceRejection(['#12', 'x'], check.recent), 'evidence: #12, x are not finished tool calls in your '
    + 'session.\nCite the numbers of your own tool results; recent ones: #3 Search p3 ✓, #4 Search p4 ✓, '
    + '#5 Search p5 ✓, #6 Search p6 ✓, #7 Search p7 ✗.');
  assert.equal(evidenceRejection(['#1'], []), 'evidence: #1 is not a finished tool call in your session.\n'
    + 'Cite the numbers of your own tool results; you have none yet.');
});

test('TB-16 done and pass need at least one ok evidence; fail may cite a failing command', () => {
  const failing = verifyEvidence(session(), ['#2'], titles).ok;
  const passing = verifyEvidence(session(), ['#3'], titles).ok;
  assert.equal(outcomeEvidenceError('done', [], null, 'T1'),
    'done needs evidence: the number of a tool result that shows it works.');
  assert.equal(outcomeEvidenceError('done', failing, null, 'T1'),
    'done needs evidence: the number of a tool result that shows it works.');
  assert.equal(outcomeEvidenceError('pass', failing, null, 'T1'),
    'pass needs evidence: the number of a tool result that shows it works.');
  assert.equal(outcomeEvidenceError('done', passing, null, 'T1'), null);
  assert.equal(outcomeEvidenceError('fail', failing, null, 'T1'), null);
  assert.equal(outcomeEvidenceError('continue', [], null, 'T1'), null);
});

test('TB-17 an instance with a successful edit or write cannot pass; commands alone do not count', () => {
  assert.equal(authorCheck(session(), titles), null);
  const failedEdit = [...session(), assistant([['c4', 'edit', { path: 'src/a.ts' }]]),
    result('c4', 'edit', '[#4] old text not found', true)];
  assert.equal(authorCheck(failedEdit, titles), null);
  const edited = [...failedEdit, assistant([['c5', 'edit', { path: 'D:\\work\\app\\src\\a.ts' }]]),
    result('c5', 'edit', '[#5] edited'), assistant([['c6', 'write', { path: 'src/b.ts' }]]),
    result('c6', 'write', '[#6] written')];
  const author = authorCheck(edited, titles);
  assert.deepEqual(author, { tag: '#5', title: 'Edit src/a.ts' });
  const passing = verifyEvidence(edited, ['#3'], titles).ok;
  assert.equal(outcomeEvidenceError('pass', passing, author, 'T1'),
    'You changed files on T1 (#5 Edit src/a.ts); another role must verify.');
  assert.equal(passRejection('T1', { tag: '#4', title: 'Edit src/a.ts' }),
    'You changed files on T1 (#4 Edit src/a.ts); another role must verify.');
  assert.equal(outcomeEvidenceError('done', passing, author, 'T1'), null);
  assert.equal(outcomeEvidenceError('pass', passing, null, 'T1'), null);
  const written = [user('[Mori] go'), assistant([['w1', 'write', { path: 'x.md' }]]), result('w1', 'write', '[#1] ok')];
  assert.deepEqual(authorCheck(written, titles), { tag: '#1', title: 'Write x.md' });
});

test('TB-38 authorFamilies: model families of successful edit/write calls in one baton', () => {
  const families = { 'fake/m1': 'alpha', 'fake/m2': 'alpha', 'other/m3': '' };
  const familyOf = (ref) => families[ref] ?? null;
  const entries = [
    user('[Mori] turn 1'),
    assistant([['a1', 'edit', { path: 'a' }]], 'm1'), result('a1', 'edit', '[#1] ok'),
    assistant([['a2', 'write', { path: 'b' }]], 'm3', 'other'), result('a2', 'write', '[#2] ok'),
    assistant([['a3', 'edit', { path: 'c' }]], 'm4', 'third'), result('a3', 'edit', '[#3] failed', true),
    assistant([['a4', 'bash', { command: 'sed -i x c' }]], 'm5', 'fourth'), result('a4', 'bash', '[#4] ok'),
    assistant([['a5', 'edit', { path: 'd' }]], 'm2'), result('a5', 'edit', '[#5] ok'),
    user('[Mori] turn 2'),
    assistant([['b1', 'write', { path: 'e' }]], 'm9', 'late'), result('b1', 'write', '[#6] ok'),
  ];
  assert.deepEqual(authorFamilies(reader.entriesOfTurns(entries, 1, 1), familyOf), ['alpha', 'other/m3']);
  assert.deepEqual(authorFamilies(reader.entriesOfTurns(entries, 2, 2), familyOf), ['late/m9']);
  assert.deepEqual(authorFamilies(session(), familyOf), []);
});
