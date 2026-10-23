// 增强任务第一条消息的单元测试（docs/specs/memory.md 附录 B、§9.5 第 4 条、MEM-36）：期望的全文由规格附录 B 的原文
// （代码块、任务段、<where> 与 (none) 的规则）逐行拼出，与 memoryText.ts 的 firstMessage 逐字比较：第一句固定、
// 第二行是不许改文件的规则、任务段；列出的会话（名字、路径、起止行、起点条目或起点时间、TaskBoard 目录）；反馈的四种
// <where> 与各处的 (none)；两层三种的 abstract、本项目这一种的 detail 与依据；用量。起点用哪种写法由 enhanceDays.ts 的
// sessionSlice 定（紧接水位之后为 after entry，否则 from 时间），这里一起核对。会话、反馈、条目都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTextKernel, specBlock, specItem } from './text-helpers.mjs';

const K = await loadTextKernel();
const TEMPLATE = specBlock('## 附录 B').split('\n');
const KINDS = { taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** @brief 规格模板里以 head 开头的那一行。 */
function line(head) {
  const found = TEMPLATE.find((each) => each.startsWith(head));
  if (found === undefined) throw new Error(`no template line starting with ${head}`);
  return found;
}

/** @brief 本地 `hh:mm`、`Oct 22 09:05`（独立算出）。 */
const hhmm = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const monTime = (ms) => `${MONTHS[new Date(ms).getMonth()]} ${new Date(ms).getDate()} ${hhmm(ms)}`;
/** @brief 依据行（§3.2）：`<Mon D> · Session “<title>”: “<quote>”` / `<Mon D> · Feedback: “<quote>”`。 */
function evidenceText(item) {
  const day = `${MONTHS[Number(item.at.slice(5, 7)) - 1]} ${Number(item.at.slice(8, 10))}`;
  const quote = item.quote ? `: “${item.quote}”` : '';
  return item.feedback ? `${day} · Feedback${quote}` : `${day} · Session “${item.title}”${quote}`;
}

/** @brief 规格的会话行：`1. "<title>" · <file> · lines <a>–<b> (after entry <id> | from …)[ · team: <dir> …]`。 */
function sessionLine(no, session) {
  const start = session.afterEntry !== null ? `after entry ${session.afterEntry}` : `from ${monTime(session.fromTime)}`;
  const team = session.teamDir ? ` · team: ${session.teamDir} (board.json and sessions/)` : '';
  return line('1. "<title>"').replace('1.', `${no}.`).replace('<title>', session.title).replace('<file>', session.file)
    .replace('<a>', session.fromLine).replace('<b>', session.toLine)
    .replace('after entry <id> | from <Mon D> <hh:mm>', start)
    .replace('[ · team: <dir> (board.json and sessions/)]', team);
}

/** synthetic：四种来源的反馈与它们的 <where>（附录 B 的规则） */
function feedbackOf(cwd) {
  const base = { expected: 'Plan first', quote: 'I rewrote it all', createdAt: '2026-10-22T02:15:00.000Z' };
  const reply = (sessionFile, entryId) => ({ kind: 'message', sessionFile, entryId, time: 1, scope: 'reply' });
  const session = (file) => ({ file, cwd, title: 'Payment refactor' });
  return [
    [{ ...base, source: reply('C:\\s\\a.jsonl', 'e1'), session: session('C:\\s\\a.jsonl') },
      'in C:\\s\\a.jsonl (entry e1)'],
    [{ ...base, source: reply('C:\\s\\a.jsonl', null), session: session('C:\\s\\a.jsonl') }, 'in C:\\s\\a.jsonl'],
    [{ ...base, source: reply(null, null), session: session(null) }, 'in the unsaved session “Payment refactor”'],
    [{ ...base, source: { kind: 'file', path: 'D:\\shop\\src\\pay.ts', sha256: 'x', startLine: 3, endLine: 9 },
      session: session('C:\\s\\a.jsonl') }, 'in D:\\shop\\src\\pay.ts lines 3–9'],
    [{ ...base, source: { kind: 'file', path: 'D:\\shop\\src\\pay.ts', sha256: 'x', startLine: 7, endLine: 7 },
      session: session('C:\\s\\a.jsonl') }, 'in D:\\shop\\src\\pay.ts line 7'],
  ];
}

/** @brief 规格模板拼出的全文。 */
function expectedMessage(input, feedbackWhere) {
  const kind = KINDS[input.task];
  const [year, month, date] = input.day.split('-').map(Number);
  const day = `${MONTHS[month - 1]} ${date}, ${year}`;
  const first = TEMPLATE[0].replace('<KIND>', kind).replace('<cwd>', input.cwd).replace('<Mon D, YYYY>', day)
    .replace('<hh:mm>', hhmm(input.dayStart)).replace('<hh:mm>', hhmm(input.dayEnd));
  const orNone = (lines) => (lines.length > 0 ? lines : ['(none)']);
  const feedback = input.feedback.map(({ name, feedback: item }, i) => line('- <name>').replace('<name>', name)
    .replace('<expected>', item.expected).replace('<quote>', item.quote).replace('<where>', feedbackWhere[i]));
  const current = [];
  for (const task of ['taste', 'strategy', 'review']) {
    current.push(`${KINDS[task]}:`, ...orNone(input.userEntries[task].map((abstract) => `- ${abstract}`)));
  }
  current.push(line('This project:'));
  for (const task of ['taste', 'strategy', 'review']) {
    current.push(`${KINDS[task]}:`, ...orNone(input.projectEntries[task].map((entry) => `- [${entry.id}] `
      + `${entry.abstract} (${entry.source === 'user' ? 'you said' : 'learned'})`)));
  }
  const full = orNone(input.details.flatMap((entry) => [`### ${entry.id} (${entry.source === 'user' ? 'you said'
    : 'learned'})`, ...(entry.details ? [entry.details] : []), ...entry.evidence.map((item) =>
    `Evidence: ${evidenceText(item)}`)]));
  const how = TEMPLATE.slice(TEMPLATE.indexOf('How to work:') + 1)
    .map((each) => each.replaceAll('<KIND>', kind).replace('<used>', String(input.used)));
  return [first, TEMPLATE[1], specItem(kind), '', line('Material for this run'), '', line('Sessions to read'),
    ...input.sessions.map((session, i) => sessionLine(i + 1, session)), line('Feedback from this day:'),
    ...orNone(feedback), '', line('Current entries.'), ...current,
    line("This project's <KIND>").replace('<KIND>', kind), ...full, '', 'How to work:', ...how].join('\n');
}

/** synthetic：一次 STRATEGY 运行的材料（日子 10-22，04:00 起） */
function strategyInput(cwd = 'D:\\shop') {
  const feedback = feedbackOf(cwd);
  return { feedbackWhere: feedback.map(([, where]) => where), input: {
    task: 'strategy', cwd, day: '2026-10-22',
    dayStart: new Date(2026, 9, 22, 4, 0).getTime(), dayEnd: new Date(2026, 9, 23, 4, 0).getTime(),
    sessions: [
      { title: 'Payment refactor', file: 'C:\\Users\\me\\pi\\sessions\\--D--shop--\\s1.jsonl', fromLine: 5, toLine: 42,
        afterEntry: 'a1b2c3d4', fromTime: new Date(2026, 9, 22, 8, 0).getTime(), teamDir: null },
      { title: 'Login page', file: 'C:\\Users\\me\\pi\\sessions\\--D--shop--\\s2.jsonl', fromLine: 2, toLine: 9,
        afterEntry: null, fromTime: new Date(2026, 9, 22, 9, 5).getTime(),
        teamDir: 'C:\\Users\\me\\Mori\\teams\\s2\\' },
    ],
    feedback: feedback.map(([item], i) => ({ name: `2026-10-22-10150${i}.json`, feedback: item })),
    userEntries: { taste: ['Conclusion first'], strategy: [], review: ['Run it before saying done'] },
    projectEntries: { taste: [], review: [], strategy: [{ id: 'plan-first', abstract: 'Plan first', source: 'learned' },
      { id: 'ask-before-refactors', abstract: 'Ask before refactors', source: 'user' }] },
    details: [
      { id: 'plan-first', source: 'learned', details: 'Line one.\n\nLine two.', evidence: [
        { at: '2026-10-22', session: 'C:\\s1.jsonl', entry: 'a1', title: 'Payment refactor', quote: 'plan first' },
        { at: '2026-10-24', feedback: 'f.json' }] },
      { id: 'ask-before-refactors', source: 'user', details: 'Ask.', evidence: [] },
    ],
    used: 123,
  } };
}

test('MEM-36 the whole first message follows appendix B line by line', () => {
  const { input, feedbackWhere } = strategyInput();
  const message = K.text.firstMessage(input);
  assert.equal(message, expectedMessage(input, feedbackWhere));
  const lines = message.split('\n');
  assert.equal(lines[0], "You are running Mori's daily STRATEGY enhancement for the project D:\\shop. "
    + `Day: Oct 22, 2026 (${hhmm(input.dayStart)} to ${hhmm(input.dayEnd)}).`);
  assert.equal(lines[1], "Don't change any file. Commands and MCP tools run without approval: never use them to "
    + 'change anything; change memory only with the memory tool.', 'the second line is the no-changes rule');
  assert.match(message, /The 500-token limit \(now 123\/500\)/, 'the usage of this kind');
});

test('MEM-36 the four feedback <where> forms, after entry and from-time starts, the team folder', () => {
  const { input } = strategyInput();
  const message = K.text.firstMessage(input);
  assert.match(message, new RegExp('^- 2026-10-22-101500\\.json · hoped for: “Plan first” · about: “I rewrote it all” '
    + 'in C:\\\\s\\\\a\\.jsonl \\(entry e1\\)$', 'm'));
  assert.match(message, /^- 2026-10-22-101501\.json · .* in C:\\s\\a\.jsonl$/m, 'a reply without an entry id');
  assert.match(message, /^- 2026-10-22-101502\.json · .* in the unsaved session “Payment refactor”$/m);
  assert.match(message, /^- 2026-10-22-101503\.json · .* in D:\\shop\\src\\pay\.ts lines 3–9$/m);
  assert.match(message, /^- 2026-10-22-101504\.json · .* in D:\\shop\\src\\pay\.ts line 7$/m);
  assert.match(message, /^1\. "Payment refactor" · \S+s1\.jsonl · lines 5–42 \(after entry a1b2c3d4\)$/m);
  assert.match(message, new RegExp('^2\\. "Login page" · \\S+s2\\.jsonl · lines 2–9 \\(from Oct 22 09:05\\) · team: '
    + 'C:\\\\Users\\\\me\\\\Mori\\\\teams\\\\s2\\\\ \\(board\\.json and sessions/\\)$', 'm'));
});

test('MEM-36 (none) lines: no feedback, a layer or kind with no entries, no entries of this kind in full', () => {
  const input = { task: 'review', cwd: 'D:\\shop', day: '2026-10-22',
    dayStart: new Date(2026, 9, 22, 4, 0).getTime(), dayEnd: new Date(2026, 9, 22, 15, 37).getTime(),
    sessions: [{ title: 'S', file: 'C:\\s.jsonl', fromLine: 2, toLine: 3, afterEntry: null,
      fromTime: new Date(2026, 9, 22, 4, 10).getTime(), teamDir: null }], feedback: [],
    userEntries: { taste: [], strategy: [], review: [] }, projectEntries: { taste: [], strategy: [], review: [] },
    details: [], used: 0 };
  const message = K.text.firstMessage(input);
  assert.equal(message, expectedMessage(input, []));
  assert.match(message, /\(04:00 to 15:37\)\.\n/, 'today: the day ends now');
  assert.match(message, /^Feedback from this day:\n\(none\)\n\nCurrent entries\. User level \(read-only here\):\n/m);
  assert.match(message,
    /^TASTE:\n\(none\)\nSTRATEGY:\n\(none\)\nREVIEW:\n\(none\)\nThis project:\nTASTE:\n\(none\)\n/m);
  assert.match(message, /^This project's REVIEW entries in full:\n\(none\)\n\nHow to work:$/m);
  assert.match(message, /\(now 0\/500\)/);
});

test('MEM-36 each task has its own first sentence and task paragraph (the evidence rules)', () => {
  for (const [task, kind] of Object.entries(KINDS)) {
    const { input } = strategyInput();
    const message = K.text.firstMessage({ ...input, task });
    const lines = message.split('\n');
    assert.ok(lines[0].startsWith(`You are running Mori's daily ${kind} enhancement for the project D:\\shop.`));
    assert.ok(lines[0].startsWith(K.text.firstLine(task, 'D:\\shop')), 'the fake endpoint keys on firstLine');
    assert.equal(lines[2], specItem(kind));
    assert.equal(K.text.TASK_PARAGRAPH[task], specItem(kind));
    assert.match(message, new RegExp(`^This project's ${kind} entries in full:$`, 'm'));
    assert.match(message, new RegExp(`^- Change only this project's ${kind} entries marked learned`, 'm'));
  }
});

/** synthetic：会话文件的物理行：头、水位条目 w（10-21）、坏的一行、v（10-21）、x 与 y（10-22） */
function sessionText() {
  const entry = (id, role, at) => JSON.stringify({ type: 'message', id, parentId: null, timestamp: at,
    message: { role, content: [{ type: 'text', text: id }], timestamp: Date.parse(at) } });
  const head = { type: 'session', version: 3, id: 'h', timestamp: '2026-10-21T00:00:00.000Z', cwd: 'D:\\' };
  return [JSON.stringify(head), entry('w', 'user', new Date(2026, 9, 21, 10, 0).toISOString()), '{not json',
    entry('v', 'assistant', new Date(2026, 9, 21, 11, 0).toISOString()),
    entry('x', 'user', new Date(2026, 9, 22, 9, 5).toISOString()),
    entry('y', 'assistant', new Date(2026, 9, 22, 9, 6).toISOString()), ''].join('\n');
}

test('MEM-36 the start is `after entry <id>` right after the watermark, otherwise `from <Mon D> <hh:mm>`', () => {
  const lines = K.days.physicalLines(sessionText());
  const dayEnd = new Date(2026, 9, 23, 4, 0).getTime();
  const since = (day) => new Date(2026, 9, day, 4, 0).getTime();
  const listed = (slice) => ({ title: 'S', file: 'C:\\s.jsonl', teamDir: null, ...slice });
  const atMark = K.days.sessionSlice(lines, { watermark: 'w', sinceStart: since(20), dayEnd });
  assert.deepEqual([atMark.fromLine, atMark.toLine, atMark.afterEntry], [4, 6, 'w'], 'physical lines, after w');
  assert.equal(sessionLine(1, listed(atMark)), '1. "S" · C:\\s.jsonl · lines 4–6 (after entry w)');
  const cut = K.days.sessionSlice(lines, { watermark: 'w', sinceStart: since(22), dayEnd });
  const missing = K.days.sessionSlice(lines, { watermark: 'gone', sinceStart: since(22), dayEnd });
  for (const [slice, label] of [[cut, 'since cuts the start later'], [missing, 'the watermark is not in the file']]) {
    assert.equal(slice.afterEntry, null, label);
    assert.equal(sessionLine(1, listed(slice)), '1. "S" · C:\\s.jsonl · lines 5–6 (from Oct 22 09:05)', label);
  }
  const none = K.days.sessionSlice(lines, { watermark: null, sinceStart: since(21), dayEnd });
  assert.deepEqual([none.fromLine, none.afterEntry], [2, null], 'no watermark: from the first entry since that day');
  const message = K.text.firstMessage({ ...strategyInput().input, sessions: [listed(atMark), listed(cut)] });
  assert.match(message, /^1\. "S" · C:\\s\.jsonl · lines 4–6 \(after entry w\)$/m);
  assert.match(message, /^2\. "S" · C:\\s\.jsonl · lines 5–6 \(from Oct 22 09:05\)$/m);
});

