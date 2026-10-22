// 后台进程平台部分的单元测试（docs/specs/parallel-agents-taskboard.md §3、§8.2、§11.1–§11.3、§11.5、§13.11）：
// 一个用户会话一份批准状态（approval.ts）、实例会话的扩展询问（extensionUi.ts）、session.read 去掉程序投递的消息
// （entries.ts）、实例会话的建立（instances.ts，用 pi 真的 SessionManager 写到临时目录）、删除会话时的 TaskBoard 目录
// （main/teamDir.ts）。pi 的工具调用、会话条目都是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';

const { ApprovalPolicy } = await loadKernelModule('src/kernel/approval.ts');
const { ExtensionUi } = await loadKernelModule('src/kernel/extensionUi.ts');
const { quotableEntries } = await loadKernelModule('src/kernel/entries.ts');
const instances = await loadKernelModule('src/kernel/instances.ts');
const { removeTeamDir, sessionIdOfFile, sessionIdOfName } = await loadKernelModule('src/main/teamDir.ts');
const team = await loadKernelModule('src/shared/team.ts');
const pi = await import('@earendil-works/pi-coding-agent');

/**
 * @brief 一个会话的批准扩展（synthetic 的 pi：只收下 tool_call 处理器）。
 * @param policy 共用的批准状态
 * @param instance 实例会话的 id；对话会话省略
 */
function gateOf(policy, instance) {
  const sent = [];
  const requests = [];
  const ends = [];
  const output = instance
    ? { prefix: `${instance}:`, send: (event) => sent.push(event), onRequest: (r) => requests.push(r),
      onEnd: (e) => ends.push(e) }
    : { prefix: '', send: (event) => sent.push(event) };
  const gate = policy.gate(output);
  let handler;
  gate.extension()({ on: (name, fn) => { if (name === 'tool_call') handler = fn; } });
  let n = 0;
  /** 一次工具调用；返回 pi 拿到的结果的 Promise */
  const call = (toolName, input = {}) => handler({ toolCallId: `${instance ?? 'dialog'}-c${(n += 1)}`, toolName,
    input }, { signal: undefined });
  return { gate, call, sent, requests, ends };
}

/** @brief 等微任务跑完（批准的结果交还 pi 之后）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('TB-34 dialog requests keep the v0 ids and events; instance requests go to the Team with '
  + '<instance>:approval-n', async () => {
  const policy = new ApprovalPolicy();
  const dialog = gateOf(policy);
  const executor = gateOf(policy, 'S.t1.executor');
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

test('TB-34 the TaskBoard tools and the read-only tools never need approval', async () => {
  const policy = new ApprovalPolicy();
  const executor = gateOf(policy, 'S.t1.executor');
  for (const name of [...team.TEAM_TOOLS, 'read', 'grep', 'find', 'ls']) {
    assert.equal(await executor.call(name), undefined, name);
    assert.equal(policy.gateFor(name), 'free', name);
  }
  assert.deepEqual(executor.requests, []);
});

test('TB-34 rejecting a background card returns the reason to that instance only', async () => {
  const policy = new ApprovalPolicy();
  const executor = gateOf(policy, 'S.t1.executor');
  const reviewer = gateOf(policy, 'S.t1.reviewer');
  const rejected = executor.call('bash', { command: 'rm -rf build' });
  const other = reviewer.call('bash', { command: 'npm test' });
  await settle();
  executor.gate.answer('S.t1.executor:approval-1', 'reject', 'not now');
  assert.deepEqual(await rejected, { block: true, reason: 'Rejected by the user. Reason: not now' });
  assert.deepEqual(executor.ends.map((e) => [e.requestId, e.decision, e.by]),
    [['S.t1.executor:approval-1', 'reject', 'user']]);
  assert.equal(reviewer.gate.has('S.t1.reviewer:approval-1'), true, 'the other instance still waits');
  policy.setMode('all');
  assert.equal(await other, undefined);
});

test('TB-34 Allow all resolves every pending request of the session and stops asking', async () => {
  const policy = new ApprovalPolicy();
  const dialog = gateOf(policy);
  const executor = gateOf(policy, 'S.t1.executor');
  const pending = [dialog.call('edit', { path: 'a' }), executor.call('bash', { command: 'x' })];
  await settle();
  const state = policy.setMode('all');
  assert.deepEqual(state, { mode: 'all', allowed: [] });
  assert.deepEqual(await Promise.all(pending), [undefined, undefined]);
  assert.deepEqual(executor.ends.map((e) => e.by), ['all']);
  assert.equal(dialog.sent.at(-1).type, 'mori.approval_end');
  assert.equal(dialog.sent.at(-1).by, 'all');
  assert.equal(await gateOf(policy, 'S.t2.executor').call('write', { path: 'b' }), undefined, 'new instances too');
  assert.deepEqual(dialog.gate.state(), executor.gate.state());
});

test('TB-34 Allow for this session on one card allows that tool for every agent, pending and later', async () => {
  const policy = new ApprovalPolicy();
  const dialog = gateOf(policy);
  const executor = gateOf(policy, 'S.t1.executor');
  const reviewer = gateOf(policy, 'S.t2.reviewer');
  const first = executor.call('bash', { command: 'npm test' });
  const second = reviewer.call('bash', { command: 'npm run lint' });
  const edit = reviewer.call('edit', { path: 'a.ts' });
  await settle();
  executor.gate.answer('S.t1.executor:approval-1', 'allowSession');
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.deepEqual(reviewer.ends.map((e) => [e.requestId, e.by]), [['S.t2.reviewer:approval-1', 'session']]);
  assert.equal(reviewer.gate.has('S.t2.reviewer:approval-2'), true, 'other tools still ask');
  assert.equal(await dialog.call('bash', { command: 'ls' }), undefined, 'the dialog no longer asks for bash');
  assert.deepEqual(policy.state(), { mode: 'ask', allowed: ['bash'] });
  dialog.gate.forget('bash');
  void executor.call('bash', { command: 'again' });
  await settle();
  assert.equal(executor.requests.length, 2, 'forget is shared too');
  policy.setMode('all');
  assert.equal(await edit, undefined);
});

test('TB-34 a released instance no longer shares the session state', async () => {
  const policy = new ApprovalPolicy();
  const executor = gateOf(policy, 'S.t1.executor');
  const closed = executor.call('bash', { command: 'x' });
  await settle();
  executor.gate.close();
  assert.equal((await closed).block, true);
  assert.deepEqual(executor.ends.map((e) => e.by), ['closed']);
  policy.setMode('all');
  assert.equal(executor.ends.length, 1);
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
  const spec = { kind: 'ask', owner: 'U1', trust, approval: policy, teamExtension: () => undefined,
    appendPrompt: ['body', 'segment'], tools: ['read', 'board_read'], onEvent: () => undefined,
    onApprovalRequest: (r) => got.push(r), onApprovalEnd: () => undefined };
  const setup = instances.instanceSetup(spec, { settings: true }, 'U1.ask.1.memory');
  assert.equal(setup.trust, trust);
  assert.equal(setup.approval, policy);
  assert.equal(setup.gate.prefix, 'U1.ask.1.memory:');
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
