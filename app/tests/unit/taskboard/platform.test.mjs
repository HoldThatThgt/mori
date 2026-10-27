// 后台进程平台部分的单元测试（docs/specs/parallel-agents-taskboard.md §3、§8.2、§11.1–§11.3、§11.5、§13.11）：
// 一个用户会话一份批准状态（approval.ts，路径闸的判断按 docs/specs/file-system-permissions.md §6.1，切到 Full access
// 与按工具名放行按 §6.7、§6.8，你不在时到时拒绝按 §9.4）、实例会话的扩展询问（extensionUi.ts）、session.read 去掉程序
// 投递的消息（entries.ts）、实例会话的建立（instances.ts，用 pi 真的 SessionManager 写到临时目录）、删除会话时的
// TaskBoard 目录（main/teamDir.ts）。pi 的工具调用、会话条目都是手写的（synthetic）；工作路径是临时目录，
// 放行的命令会在里面建 .work（§7.10）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernelModule } from '../load.mjs';

const { ApprovalPolicy } = await loadKernelModule('src/kernel/approval.ts');
const { ExtensionUi } = await loadKernelModule('src/kernel/extensionUi.ts');
const { quotableEntries } = await loadKernelModule('src/kernel/entries.ts');
const instances = await loadKernelModule('src/kernel/instances.ts');
const { removeTeamDir, sessionIdOfFile, sessionIdOfName } = await loadKernelModule('src/main/teamDir.ts');
const team = await loadKernelModule('src/shared/team.ts');
const pi = await import('@earendil-works/pi-coding-agent');

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * @brief 一个会话的批准扩展（synthetic 的 pi：只收下 tool_call 处理器；ctx 带工作路径与会话 id）。
 * @param policy 共用的批准状态
 * @param cwd 工作路径（临时目录）
 * @param instance 实例会话的 id（task 实例）；对话会话省略
 * @return gate；call 走处理器（返回 pi 拿到的结果的 Promise）；decide 走预告（同处理器的判断，返回 mori.tool_gate
 *         的 gate）；这个会话发出的事件、交给 Team 的请求与结束
 */
function gateOf(policy, cwd, instance) {
  const sent = [];
  const requests = [];
  const ends = [];
  const base = { cwd, userSessionId: 'S', send: (event) => sent.push(event) };
  const output = instance
    ? { ...base, prefix: `${instance}:`, kind: 'task', onRequest: (r) => requests.push(r), onEnd: (e) => ends.push(e) }
    : { ...base, prefix: '', kind: 'user' };
  const gate = policy.gate(output);
  let handler;
  gate.extension()({ on: (name, fn) => { if (name === 'tool_call') handler = fn; } });
  const ctx = { signal: undefined, cwd, sessionManager: { getSessionId: () => instance ?? 'S' } };
  const label = instance ?? 'dialog';
  let n = 0;
  const call = (toolName, input = {}) => handler({ toolCallId: `${label}-c${(n += 1)}`, toolName, input }, ctx);
  const decide = (toolName, input = {}) => {
    gate.announce(`${label}-a${(n += 1)}`, toolName, input);
    return sent.at(-1).gate;
  };
  return { gate, call, decide, sent, requests, ends };
}

/** @brief 等微任务跑完（批准的结果交还 pi 之后）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('TB-34 dialog requests keep the v0 ids and events; instance requests go to the Team with '
  + '<instance>:approval-n', async (t) => {
  const cwd = tempDir(t);
  const policy = new ApprovalPolicy();
  const dialog = gateOf(policy, cwd);
  const executor = gateOf(policy, cwd, 'S.t1.executor');
  void dialog.call('bash', { command: 'npm test' });
  void executor.call('bash', { command: 'npm test' });
  await settle();
  assert.deepEqual(dialog.sent.map((e) => [e.type, e.requestId]), [['mori.approval_request', 'approval-1']]);
  assert.deepEqual(executor.sent, [], 'an instance never shows its own approval card');
  assert.equal(executor.requests.length, 1);
  assert.equal(executor.requests[0].requestId, 'S.t1.executor:approval-1');
  assert.equal(executor.requests[0].toolName, 'bash');
  assert.deepEqual(executor.requests[0].args, { command: 'npm test' });
  assert.notEqual(executor.requests[0].requestId, dialog.sent[0].requestId);
});

test('TB-34 the TaskBoard tools, ask_user_question and the read-only tools never need approval', async (t) => {
  const policy = new ApprovalPolicy();
  const executor = gateOf(policy, tempDir(t), 'S.t1.executor');
  for (const name of [...team.TEAM_TOOLS, 'ask_user_question', 'read', 'grep', 'find', 'ls']) {
    assert.equal(await executor.call(name), undefined, name);
    assert.equal(executor.decide(name), 'free', name);
  }
  assert.equal(executor.decide('read', { path: '../elsewhere.md' }), 'free', 'reading is free on any path');
  assert.deepEqual(executor.requests, []);
});

test('TB-34 rejecting a background card returns the reason to that instance only', async (t) => {
  const cwd = tempDir(t);
  const policy = new ApprovalPolicy();
  const executor = gateOf(policy, cwd, 'S.t1.executor');
  const reviewer = gateOf(policy, cwd, 'S.t1.reviewer');
  const rejected = executor.call('bash', { command: 'rm -rf build' });
  const other = reviewer.call('bash', { command: 'npm test' });
  await settle();
  executor.gate.answer('S.t1.executor:approval-1', 'reject', 'not now');
  assert.deepEqual(await rejected, { block: true, reason: 'Rejected by the user. Reason: not now' });
  assert.deepEqual(executor.ends.map((e) => [e.requestId, e.decision, e.by]),
    [['S.t1.executor:approval-1', 'reject', 'user']]);
  assert.equal(reviewer.gate.has('S.t1.reviewer:approval-1'), true, 'the other instance still waits');
  policy.setMode('full');
  assert.equal(await other, undefined);
});

/** @brief 这个会话发出的 approval_end 里 requestId 为 id 的那些。 */
const endsOf = (gate, id) => gate.sent.filter((e) => e.type === 'mori.approval_end' && e.requestId === id);

/** @brief 切到 Full access、再切回 Ask each time 之后，outside 与 protected 的卡都还挂着（FS-33）。 */
function assertStillWaiting(dialog, executor, when) {
  assert.equal(executor.gate.has('S.t1.executor:approval-2'), true, `the write outside still waits (${when})`);
  assert.equal(dialog.gate.has('approval-2'), true, `the protected edit still waits (${when})`);
  assert.deepEqual(endsOf(dialog, 'approval-2'), [], `the protected edit has no approval_end (${when})`);
}

test('TB-34 Full access resolves the pending requests inside the working directory of every agent and stops '
  + 'asking there; writes outside and protected edits still ask (FS-33)', async (t) => {
  const cwd = tempDir(t);
  const policy = new ApprovalPolicy();
  const dialog = gateOf(policy, cwd);
  const executor = gateOf(policy, cwd, 'S.t1.executor');
  const pending = [dialog.call('edit', { path: 'a' }), executor.call('bash', { command: 'x' })];
  const outside = executor.call('write', { path: '../out.txt', content: 'x' });
  const prot = dialog.call('edit', { path: '.git/config', edits: [{ oldText: 'a', newText: 'b' }] });
  await settle();
  const protRequest = dialog.sent.find((e) => e.type === 'mori.approval_request' && e.requestId === 'approval-2');
  assert.equal(protRequest?.scope, 'protected', 'the edit of .git/config is a protected card');
  const state = policy.setMode('full');
  assert.deepEqual(state, { mode: 'full', allowed: [], allowedDirs: [] });
  assert.deepEqual(await Promise.all(pending), [undefined, undefined]);
  assert.deepEqual(executor.ends.map((e) => [e.requestId, e.by]), [['S.t1.executor:approval-1', 'full']]);
  assert.equal(dialog.sent.at(-1).type, 'mori.approval_end');
  assert.equal(dialog.sent.at(-1).by, 'full');
  assert.deepEqual(endsOf(dialog, 'approval-1').map((e) => e.by), ['full']);
  assertStillWaiting(dialog, executor, 'Full access');
  assert.deepEqual(policy.setMode('ask'), { mode: 'ask', allowed: [], allowedDirs: [] });
  assertStillWaiting(dialog, executor, 'back to Ask each time ends nothing');
  policy.setMode('full');
  const fresh = gateOf(policy, cwd, 'S.t2.executor');
  assert.equal(fresh.decide('write', { path: 'b' }), 'full', 'a new instance decides full inside');
  assert.equal(await fresh.call('write', { path: 'b' }), undefined, 'new instances too');
  void fresh.call('write', { path: '../b' });
  await settle();
  assert.deepEqual(fresh.requests.map((r) => [r.requestId, r.scope]), [['S.t2.executor:approval-1', 'outside']],
    'a new instance still asks for a write outside');
  assert.deepEqual(dialog.gate.state(), executor.gate.state());
  executor.gate.close();
  fresh.gate.close();
  dialog.gate.close();
  assert.equal((await outside).block, true);
  assert.equal((await prot).block, true);
});

test('TB-34 Allow for this session on one card allows that tool for every agent, pending and new calls', async (t) => {
  const cwd = tempDir(t);
  const policy = new ApprovalPolicy();
  const dialog = gateOf(policy, cwd);
  const executor = gateOf(policy, cwd, 'S.t1.executor');
  const reviewer = gateOf(policy, cwd, 'S.t2.reviewer');
  const first = executor.call('bash', { command: 'npm test' });
  const second = reviewer.call('bash', { command: 'npm run lint' });
  const edit = reviewer.call('edit', { path: 'a.ts' });
  await settle();
  executor.gate.answer('S.t1.executor:approval-1', 'allowSession');
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.deepEqual(reviewer.ends.map((e) => [e.requestId, e.by]), [['S.t2.reviewer:approval-1', 'session']]);
  assert.equal(reviewer.gate.has('S.t2.reviewer:approval-2'), true, 'other tools still ask');
  assert.equal(dialog.decide('bash', { command: 'ls' }), 'session', 'the dialog decides session for bash');
  assert.equal(await dialog.call('bash', { command: 'ls' }), undefined, 'the dialog no longer asks for bash');
  void dialog.call('bash', { command: 'echo hi > ../out.txt' });
  await settle();
  assert.deepEqual([dialog.sent.at(-1).type, dialog.sent.at(-1).scope], ['mori.approval_request', 'outside'],
    'a bash that writes outside the working directory still asks');
  assert.deepEqual(policy.state(), { mode: 'ask', allowed: ['bash'], allowedDirs: [] });
  dialog.gate.forget({ toolName: 'bash' });
  assert.equal(executor.decide('bash', { command: 'again' }), 'ask', 'after forget bash decides ask again');
  const again = executor.call('bash', { command: 'again' });
  await settle();
  assert.equal(executor.requests.length, 2, 'forget is shared too');
  policy.setMode('full');
  assert.deepEqual(await Promise.all([edit, again]), [undefined, undefined]);
  dialog.gate.close();
});

test('TB-34 a released instance no longer shares the session state', async (t) => {
  const policy = new ApprovalPolicy();
  const executor = gateOf(policy, tempDir(t), 'S.t1.executor');
  const closed = executor.call('bash', { command: 'x' });
  await settle();
  executor.gate.close();
  assert.equal((await closed).block, true);
  assert.deepEqual(executor.ends.map((e) => e.by), ['closed']);
  policy.setMode('full');
  assert.equal(executor.ends.length, 1);
});

/**
 * @brief approval.ts 与 away.ts 打进同一个包（同一份 away 的状态）：到时要用 setFocus 与注入的时钟驱动。
 *        入口写在 test-results/ 下（不进仓库），相对它引用 src/（同 memory 的 text-helpers.mjs）。
 */
async function loadApprovalWithAway() {
  const rel = `test-results/unit-entries/tb-approval-away-${process.pid}.ts`;
  const file = join(appRoot, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export * from '../../src/kernel/approval';\n"
    + "export { setFocus, startAway } from '../../src/kernel/away';\n");
  try {
    return await loadKernelModule(rel);
  } finally {
    rmSync(file, { force: true });
  }
}

/** @brief 跑 fn 时收下 console.log（焦点与到时的 [kernel] 日志），返回收下的行。 */
function quietLog(fn) {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    fn();
  } finally {
    console.log = log;
  }
  return lines;
}

/** @brief 批准卡到时回给模型的原文（file-system.md §14，默认 5 分钟）：最后一句按会话种类。 */
const awayText = (end) => "The user was away and didn't answer within 5 minutes, so this was denied. "
  + `Don't retry it. Mention it in your ${end}.`;

test('TB-34 FS-71 cards that time out while the user is away end by: away; the user session records its own, '
  + 'a background card goes to the Team only', async (t) => {
  const A = await loadApprovalWithAway();
  const cwd = tempDir(t);
  const timers = [];
  const clock = { now: () => 5000, setTimeout: (fire) => timers.push(fire), clearTimeout: () => undefined };
  const records = [];
  await A.startAway({ userData: tempDir(t), emit: () => undefined, record: (id, d) => records.push([id, d]), clock });
  const policy = new A.ApprovalPolicy();
  const dialog = gateOf(policy, cwd);
  const executor = gateOf(policy, cwd, 'S.t1.executor');
  const written = dialog.call('write', { path: 'notes.md', content: 'c'.repeat(400) });
  const long = dialog.call('bash', { command: `echo ${'a'.repeat(400)}` });
  const background = executor.call('bash', { command: 'npm test' });
  await settle();
  quietLog(() => A.setFocus(false));
  assert.equal(timers.length, 3, 'every pending card starts its timer when the window loses focus');
  const lines = quietLog(() => timers.forEach((fire) => fire()));
  assert.equal(lines.filter((line) => line.startsWith('[kernel] away: ')).length, 3);
  assert.deepEqual(await written, { block: true, reason: awayText('final summary') });
  assert.equal((await long).reason, awayText('final summary'));
  assert.deepEqual(await background, { block: true, reason: awayText('handoff') });
  assert.deepEqual(dialog.sent.filter((e) => e.type === 'mori.approval_end').map((e) => [e.requestId, e.by]),
    [['approval-1', 'away'], ['approval-2', 'away']]);
  assert.deepEqual(executor.ends, [{ requestId: 'S.t1.executor:approval-1', decision: 'reject', by: 'away',
    reason: awayText('handoff') }]);
  assert.deepEqual(records.map(([id]) => id), ['S', 'S'], 'only the user session\'s own cards are recorded here');
  assert.deepEqual(records[0][1], { requestId: 'approval-1', kind: 'approval', at: 5000, timeout: '5m', agent: null,
    toolCallId: 'dialog-c1', toolName: 'write', args: { path: 'notes.md' }, title: null, answers: null,
    result: 'denied' });
  assert.equal(records[1][1].args.command.length, 300, 'strings in the record are cut to 300 characters');
  quietLog(() => A.setFocus(true));
});

test('TB-43 extension questions in an instance answer with pi no-UI defaults, log, and never reach the screen',
  async () => {
  const emitted = [];
  const ui = new ExtensionUi((envelope) => emitted.push(envelope), true);
  ui.attach('S.ask.1.memory');
  const context = ui.context();
  assert.deepEqual(ui.ready(), []);
  const errors = [];
  const original = console.error;
  const log = console.log;
  console.error = (line) => errors.push(String(line));
  console.log = () => undefined;
  try {
    assert.equal(await context.confirm('Proceed?', 'really'), false);
    assert.equal(await context.select('Pick', ['a', 'b']), undefined);
    assert.equal(await context.input('Name'), undefined);
    context.notify('hello', 'info');
    ui.beginStop();
    ui.endStop();
    assert.equal(await context.confirm('Again?', 'x'), false);
  } finally {
    console.error = original;
    console.log = log;
  }
  assert.deepEqual(emitted, []);
  assert.deepEqual(ui.requests(), []);
  assert.equal(errors.filter((line) => line.includes('answered as cancelled (instance)')).length, 4);
});

test('TB-43 a dialog session still asks on screen after it opens (v0)', () => {
  const emitted = [];
  const ui = new ExtensionUi((envelope) => emitted.push(envelope));
  ui.attach('S');
  ui.ready();
  void ui.context().confirm('Proceed?', 'really');
  assert.equal(emitted[0].event.type, 'mori.ui_request');
  ui.close();
});

/** @brief synthetic 的会话条目。 */
let seq = 0;
const message = (role, text) => ({ type: 'message', id: `m${(seq += 1)}`, parentId: null, timestamp: '',
  message: { role, content: [{ type: 'text', text }], timestamp: 0 } });
const custom = (customType, data) => ({ type: 'custom', id: `c${(seq += 1)}`, parentId: null, timestamp: '',
  customType, data });

test('TB-31 session.read leaves out the [Mori] messages a mori.wake entry points to', () => {
  const mine = message('user', 'fix the login test');
  const reply = message('assistant', 'On it.');
  const wake = message('user', '[Mori] Request 1 is closed (done). Conclusion: fixed.');
  const report = message('assistant', 'Request 1 is done: the token was not refreshed.');
  const ref = custom('mori.ref', { messageId: mine.id, refs: [] });
  const entries = [mine, ref, reply, custom('mori.receipt', { kind: 'registered' }), wake,
    custom(team.TEAM_ENTRY_TYPES.wake, { messageId: wake.id, kind: 'request_closed' }), report];
  assert.deepEqual(quotableEntries(entries).map((item) => item.id), [mine.id, ref.id, reply.id, report.id]);
});

test('TB-31 a malformed mori.wake entry is skipped with a log and hides nothing', () => {
  const mine = message('user', 'hello');
  const original = console.error;
  const errors = [];
  console.error = (line) => errors.push(String(line));
  try {
    const kept = quotableEntries([mine, custom(team.TEAM_ENTRY_TYPES.wake, { messageId: '' })]);
    assert.deepEqual(kept.map((item) => item.id), [mine.id]);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

/** @brief 一个临时目录，测试结束时删掉。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-tb-platform-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('TB-43 an instance session file sits in teams/<id>/sessions with parentSession and mori.instance first', (t) => {
  const root = tempDir(t);
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  instances.setUserData(join(root, 'userData'));
  const teamDir = instances.teamDirOf('U1');
  assert.equal(teamDir, join(root, 'userData', 'teams', 'U1'));
  const parent = join(root, 'agent', 'sessions', 'x', 'u1.jsonl');
  const spec = { id: 'U1.t1.executor', dir: join(teamDir, 'sessions'), parentSession: parent, cwd,
    instance: { kind: 'task', role: 'executor', task: 'T1' } };
  const manager = instances.newInstanceManager(pi, spec);
  manager.appendModelChange('fake', 'm1');
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '[Mori] You are executor on T1.' }],
    timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: Date.now(),
    api: 'openai-completions', provider: 'fake', model: 'm1', stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const files = readdirSync(spec.dir);
  assert.equal(files.length, 1);
  assert.equal(manager.getSessionFile(), join(spec.dir, files[0]));
  const [header, first] = readFileSync(join(spec.dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(header.id, 'U1.t1.executor');
  assert.equal(header.parentSession, parent);
  assert.equal(first.type, 'custom');
  assert.equal(first.customType, 'mori.instance');
  assert.deepEqual(first.data, { kind: 'task', role: 'executor', task: 'T1' });
  assert.equal(team.InstanceEntrySchema.safeParse(first.data).success, true);
});

test('TB-43 an instance inherits trust and approval, and its approvals reach the Team with its id', () => {
  const policy = new ApprovalPolicy();
  const got = [];
  const trust = { trusted: true, projectTrust: 'trusted', remembered: true, saveError: null };
  const spec = { kind: 'ask', owner: 'U1', cwd: 'D:\\shop', trust, approval: policy, teamExtension: () => undefined,
    appendPrompt: ['body', 'segment'], tools: ['read', 'board_read'], onEvent: () => undefined,
    onApprovalRequest: (r) => got.push(r), onApprovalEnd: () => undefined, handedOff: () => true };
  const setup = instances.instanceSetup(spec, { settings: true }, 'U1.ask.1.memory');
  assert.equal(setup.trust, trust);
  assert.equal(setup.approval, policy);
  assert.equal(setup.gate.prefix, 'U1.ask.1.memory:');
  assert.deepEqual([setup.gate.cwd, setup.gate.kind, setup.gate.userSessionId, setup.gate.handedOff()],
    ['D:\\shop', 'ask', 'U1', true], 'the card sits in the owner\'s user session (file-system-permissions.md §9.2)');
  assert.deepEqual(setup.tools, ['read', 'board_read']);
  assert.deepEqual(setup.appendPrompt, ['body', 'segment']);
  setup.gate.onRequest({ requestId: 'U1.ask.1.memory:approval-1', toolCallId: 'c1', toolName: 'bash', args: {} });
  assert.equal(got[0].instance, 'U1.ask.1.memory');
});

test('TB-42 deleting a session also removes teams/<id> named by the first line of its file', async (t) => {
  const root = tempDir(t);
  const file = join(root, 'session.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: 'abc-123', cwd: root })}\n{"type":"x"}\n`);
  assert.equal(await sessionIdOfFile(file), 'abc-123');
  const boardDir = join(root, 'teams', 'abc-123', 'sessions');
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(join(root, 'teams', 'abc-123', 'board.json'), '{}');
  writeFileSync(join(boardDir, 'i.jsonl'), '{}');
  mkdirSync(join(root, 'teams', 'other'));
  assert.equal(await removeTeamDir(root, 'abc-123'), null);
  assert.equal(existsSync(join(root, 'teams', 'abc-123')), false);
  assert.equal(existsSync(join(root, 'teams', 'other')), true, 'other sessions keep theirs');
  assert.equal(await removeTeamDir(root, 'never-had-one'), null, 'no folder is fine');
});

test('TB-42 a file without a pi session header gives no id, so nothing else is deleted', async (t) => {
  const root = tempDir(t);
  const original = console.error;
  console.error = () => undefined;
  try {
    const bad = join(root, 'bad.jsonl');
    writeFileSync(bad, 'not json\n');
    assert.equal(await sessionIdOfFile(bad), null);
    const dots = join(root, 'dots.jsonl');
    writeFileSync(dots, `${JSON.stringify({ type: 'session', id: '..' })}\n`);
    assert.equal(await sessionIdOfFile(dots), null);
    assert.equal(await sessionIdOfFile(join(root, 'missing.jsonl')), null);
  } finally {
    console.error = original;
  }
});

test('TB-42 a never-saved session gives its id by pi file name <time>_<id>.jsonl', () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    const name = join('agent', 'sessions', 'x', '2026-10-21T01-02-03-004Z_0199a1b2-c3d4.jsonl');
    assert.equal(sessionIdOfName(name), '0199a1b2-c3d4');
    assert.equal(sessionIdOfName(join('x', 'no-underscore.jsonl')), null);
    assert.equal(sessionIdOfName(join('x', 'time_...jsonl')), null, 'an id like .. is refused');
  } finally {
    console.error = original;
  }
});
