// 只读会话（docs/specs/file-system-permissions.md §7.7 末尾“只读命令”、§8.4 第 2 条、§8.11；file-system.md §14 的
// 2026-10-28 注；验收 §19.2 FS-116–FS-119 的单元部分）：readOnlyTools 与 installedSearchTools、Team 建的各种实例的工具、
// scanVerdict 的只读判断、checkLimits 与路径闸对只读会话里命令的处理、只读会话看到的文字。Team 用平行 Agent 单元测试的
// 会话表（tests/unit/taskboard/teamHarness.mjs，synthetic TeamHost）驱动；路径闸用 gate-helpers.mjs 的假 pi。
// 角色文件、命令与工具调用都是手写的（synthetic）。规格原文从 docs/specs/ 读出逐字比较。不连模型，也不起 Electron。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  addTask, beginRun, deps, nextDelivery, roles as R, runDelivery, setup, until, workThen,
} from '../taskboard/teamHarness.mjs';
import { REJECTED_TEXT, STOP_TEXT, fakeSession, quietlySync, specText, tempProject } from './gate-helpers.mjs';

const [S, G, L, D, approval, text, tools, subagent] = await Promise.all([
  'src/kernel/commandScan.ts', 'src/kernel/pathGate.ts', 'src/kernel/limits.ts', 'src/kernel/defaultTools.ts',
  'src/kernel/approval.ts', 'src/kernel/boardText.ts', 'src/kernel/boardTools.ts', 'src/kernel/subagent.ts',
].map((path) => loadKernelModule(path)));
const { ApprovalPolicy } = approval;

const project = tempProject('mori-fs-readonly-');
const { cwd } = project;
after(() => project.remove());

// ---- 规格原文 ----

const FS = specText('file-system.md');
/** file-system.md §14 一节 */
const SECTION_14 = FS.slice(FS.indexOf('\n## 14. '), FS.indexOf('\n## 15. '));

/** @brief §14 里以 start 开头的那段反引号原文（同 narrowing.test.mjs 的 quote14）。 */
function quote14(start) {
  const at = SECTION_14.indexOf(`\`${start}`);
  assert.ok(at >= 0, `no quoted text starting with "${start}" in §14`);
  const end = SECTION_14.indexOf('`', at + 1);
  return SECTION_14.slice(at + 1, end);
}

/**
 * @brief §14 一行原文按它的 2026-10-28 注换掉一段：注里写着 `from` 改为 `to`（或整句改为 `to`）。
 * @param start 原文的开头
 */
function changed14(start, from, to) {
  const old = quote14(start);
  assert.ok(old.includes(from), `"${from}" is in the §14 text starting with "${start}"`);
  assert.ok(SECTION_14.includes(`\`${to}\``), `§14 states the new wording "${to}"`);
  return old.replace(from, to);
}

// ---- 常量 ----

/** pi 设置的默认工具（teamHarness 的 baseTools） */
const DEFAULTS = ['read', 'bash', 'edit', 'write'];
/** 只读会话碰文件的工具（DEFAULTS 去掉 edit、write）加全部 MCP 工具 */
const READ_ONLY_FILE_TOOLS = ['read', 'bash', 'mcp__*'];
/** 一般实例碰文件的工具 */
const FILE_TOOLS = [...DEFAULTS, 'mcp__*'];
/** 拒绝原文的开头（file-system-permissions.md §8.3） */
const LEADS = {
  task: 'Not allowed for this task', ask: 'Not allowed for this question',
  create: 'Not allowed while deciding requests', close: 'Not allowed while closing a request',
  subscription: 'Not allowed in a subscription',
};
/** 协作模式下对话会话的整句（§8.3） */
const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';
/** 只读会话里不是只读命令的规则文字（§8.11） */
const ONLY_READ = 'only read-only commands';
/** 分开时的角色加一个订阅 done 的 request_closed 的 memory（synthetic，同 narrowing.test.mjs） */
const WITH_MEMORY = R.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/memory.md', text: '---\nname: memory\ndescription: Keeps notes\nsubscribe:\n'
    + '  - request_closed:\n      outcome: [done]\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
  { file: '.mori/agents/reviewer.md', text: '---\nname: reviewer\ndescription: Reviews\n---\n' },
], deps);
assert.deepEqual(WITH_MEMORY.problems, []);
/** 只有基座（普通模式的 subagent 用） */
const BASE = R.parseRoleFiles([], deps);

/** 只读命令（FS-117；bash） */
const BASH_READS = ['ls', 'cat a.txt | grep x | head -5', 'cd src && ls -la', 'git status && git log --oneline -3',
  'git -C .. log', 'ls > /dev/null 2>&1', 'find . -name x', "bash -c 'ls'", 'X=1'];
/** 不是只读命令的（FS-117；bash） */
const BASH_OTHERS = ['ls > a.txt', 'ls > NUL', 'rm a', 'npm i', './x.sh', 'bash x.sh', 'source x.sh', 'f() { ls; }; f',
  'find . -delete', 'sort -o x a', 'git commit -m x', 'git branch new', 'ls | xargs rm', 'echo "abc'];
/** 只读命令（FS-117；PowerShell） */
const PS_READS = ['Get-ChildItem | Select-Object Name', 'Get-Content a.txt | Select-String x',
  '(Get-Content a.txt).Length', 'git status'];
/** 不是只读命令的（FS-117；PowerShell） */
const PS_OTHERS = ['Set-Content a b', 'npm i', "[IO.File]::WriteAllText('a','b')", '$f.Delete()',
  '(Get-Item a).Delete()', 'Write-Output (Get-Item a).Delete()'];

// ---- 帮助函数 ----

let callNo = 0;

/** @brief 调一个会话注册的工具（参数先经 prepareArguments，同 pi）。 */
function callTool(entry, name, args) {
  const tool = entry.api.tools.get(name);
  assert.ok(tool, `${name} is registered`);
  callNo += 1;
  return tool.execute(`r${callNo}`, tool.prepareArguments(args), undefined, undefined, {});
}

/** @brief 对话会话一次运行的开始（before_agent_start 与 agent_start）。 */
function startUserRun(team, user) {
  user.api.handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
}

/** @brief 一个调用在这组收窄下的 checkLimits 结果（分类截下日志）。 */
function check(owner, limits, toolName, input) {
  const call = quietlySync(() => G.classifyCall(toolName, input, cwd)).value;
  return L.checkLimits({ owner, limits }, call, call.realCwd);
}

/** @brief 一条命令的 scanVerdict。 */
const verdict = (command, shell) => S.scanVerdict({ command, shell, cwd, vars: {} });

/** @brief task T1 由 executor 做完，结案关闭需求 1；返回结案实例的设置。 */
async function closeRequestDone(team, host) {
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
  const close = await nextDelivery(host, 'U.close.1');
  const spec = host.entry('U.close.1').spec;
  await runDelivery(host, close, [
    { calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Works.', outcome: 'close_done' } }] },
    { calls: [{ name: 'request_close', args: { request: 1, outcome: 'done', conclusion: 'Done.' } }] },
  ]);
  return spec;
}

// ---- FS-116 只读会话的工具 ----

test('FS-116 readOnlyTools: read always, the pi defaults without edit and write, then installed grep and find', () => {
  assert.deepEqual(R.readOnlyTools(DEFAULTS, []), ['read', 'bash']);
  assert.deepEqual(R.readOnlyTools(DEFAULTS, ['grep', 'find']), ['read', 'bash', 'grep', 'find']);
  assert.deepEqual(R.readOnlyTools(['bash', 'edit', 'write'], ['find']), ['read', 'bash', 'find'], 'read is added');
  assert.deepEqual(R.readOnlyTools(['read', 'bash', 'powershell', 'ls', 'grep', 'edit', 'write'], ['grep', 'find']),
    ['read', 'bash', 'powershell', 'ls', 'grep', 'find'], 'switched-on read tools stay, in order, once');
  assert.deepEqual(R.readOnlyTools(['edit', 'write'], []), ['read']);
});

test('FS-116 installedSearchTools: rg.exe and fd.exe in the bin folder or a PATH folder (quoted too); nothing else',
  () => {
    const bin = 'C:\\agent\\bin';
    const only = (...files) => (path) => files.includes(path);
    assert.deepEqual(D.installedSearchTools(bin, 'C:\\a;C:\\b', only()), []);
    assert.deepEqual(D.installedSearchTools(bin, '', only(join(bin, 'rg.exe'))), ['grep']);
    assert.deepEqual(D.installedSearchTools(bin, 'C:\\a; "C:\\Program Files\\fd" ;',
      only(join('C:\\Program Files\\fd', 'fd.exe'))), ['find'], 'a quoted PATH folder');
    assert.deepEqual(D.installedSearchTools(bin, 'C:\\a;C:\\b', only(join('C:\\b', 'fd.exe'), join(bin, 'rg.exe'))),
      ['grep', 'find'], 'grep first, then find');
    assert.deepEqual(D.installedSearchTools(bin, 'C:\\a', only(join('C:\\a', 'rg'), join(bin, 'fd'))), [],
      'only rg.exe and fd.exe count');
    const asked = [];
    D.installedSearchTools(bin, ';;', (path) => { asked.push(path); return false; });
    assert.deepEqual(asked, [join(bin, 'rg.exe'), join(bin, 'fd.exe')], 'empty PATH entries are skipped');
  });

test('FS-116 a write: false task and its one-time question get read and bash, not edit and write; no limits keeps them',
  async () => {
    const { team, host } = await setup(WITH_MEMORY);
    addTask(team, { limits: { write: false } });
    const start = await nextDelivery(host, 'U.t1.executor');
    const task = host.entry('U.t1.executor').spec;
    assert.deepEqual(task.tools, [...READ_ONLY_FILE_TOOLS, 'board_read', 'read_session', 'agent_message',
      'task_handoff']);
    assert.deepEqual(task.narrowing, { owner: 'task', limits: { write: false } });
    await beginRun(host, start);
    const pending = callTool(host.entry('U.t1.executor'), 'agent_message', { to: 'reviewer', text: 'Check?' });
    const ask = await nextDelivery(host, 'U.ask.1.reviewer');
    assert.deepEqual(host.entry('U.ask.1.reviewer').spec.tools,
      [...READ_ONLY_FILE_TOOLS, 'board_read', 'read_session']);
    await runDelivery(host, ask, [{ text: 'Looks fine.' }]);
    await pending;
    const open = await setup(WITH_MEMORY);
    addTask(open.team);
    await nextDelivery(open.host, 'U.t1.executor');
    assert.deepEqual(open.host.entry('U.t1.executor').spec.tools, [...FILE_TOOLS, 'board_read', 'read_session',
      'agent_message', 'task_handoff'], 'a task without limits keeps edit and write');
  });

test('FS-116 split create, close and subscription instances get read and bash, not edit and write', async () => {
  const done = await setup(WITH_MEMORY);
  const close = await closeRequestDone(done.team, done.host);
  assert.deepEqual(close.tools, [...READ_ONLY_FILE_TOOLS, 'board_read', 'read_session', 'agent_message',
    'task_handoff', 'request_close']);
  await nextDelivery(done.host, 'U.sub.1.memory');
  assert.deepEqual(done.host.entry('U.sub.1.memory').spec.tools,
    [...READ_ONLY_FILE_TOOLS, 'board_read', 'read_session', 'agent_message']);
  const { team, host } = await setup();
  await team.setMode('on');
  team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
  await nextDelivery(host, 'U.create');
  const create = host.entry('U.create').spec.tools;
  assert.deepEqual(create.slice(0, 3), READ_ONLY_FILE_TOOLS);
  assert.ok(!create.includes('edit') && !create.includes('write') && create.at(-1) === 'memory', create.join(', '));
});

test('FS-116 off-mode questions and read-only subagents get read and bash; a general subagent keeps edit and write',
  async () => {
    const { team, host, user } = await setup(WITH_MEMORY);
    startUserRun(team, user);
    const pending = callTool(user, 'agent_message', { to: 'reviewer', text: 'Is a.ts safe?' });
    const ask = await nextDelivery(host, 'U.ask.1.reviewer');
    assert.deepEqual(host.entry('U.ask.1.reviewer').spec.tools, READ_ONLY_FILE_TOOLS, 'no TaskBoard tools in off mode');
    await runDelivery(host, ask, [{ text: 'Yes.' }]);
    await pending;
    const solo = await setup(BASE);
    startUserRun(solo.team, solo.user);
    const run = callTool(solo.user, 'subagent', { tasks: [
      { description: 'Reads', prompt: 'Read src and report.', read_only: true },
      { description: 'Changes', prompt: 'Fix src and report.' }] });
    const deliveries = await until(() => {
      const found = solo.host.deliveries.filter((item) => item.id.includes('.ask.'));
      return found.length >= 2 ? found : null;
    }, 'two subagent deliveries');
    const specs = deliveries.map((item) => solo.host.entry(item.id).spec);
    assert.deepEqual(specs.map((spec) => [spec.tools, spec.narrowing]), [
      [READ_ONLY_FILE_TOOLS, { owner: 'ask', limits: { write: false } }], [FILE_TOOLS, null]]);
    for (const delivery of deliveries) await runDelivery(solo.host, delivery, [{ text: 'ok' }]);
    await run;
  });

test('FS-116 installed grep and find join read-only instances only, checked again for each new instance', async () => {
  const installed = [];
  const { team, host } = await setup(WITH_MEMORY, null, { searchTools: installed });
  addTask(team, { limits: { write: false } });
  await nextDelivery(host, 'U.t1.executor');
  assert.deepEqual(host.entry('U.t1.executor').spec.tools.slice(0, 3), READ_ONLY_FILE_TOOLS, 'nothing installed');
  installed.push('grep');
  addTask(team, { limits: { write: false } });
  await nextDelivery(host, 'U.t2.executor');
  assert.deepEqual(host.entry('U.t2.executor').spec.tools.slice(0, 4), ['read', 'bash', 'grep', 'mcp__*'],
    'rg.exe found for the next instance');
  addTask(team);
  await nextDelivery(host, 'U.t3.executor');
  assert.deepEqual(host.entry('U.t3.executor').spec.tools.slice(0, 5), FILE_TOOLS, 'a writing task: pi defaults only');
});

// ---- FS-117 只读命令的判断 ----

test('FS-117 bash: read-only commands are read-only after cd, through pipes, wrappers and nested shells', () => {
  for (const command of BASH_READS) assert.equal(verdict(command, 'bash').readOnly, true, command);
  for (const command of BASH_OTHERS) assert.equal(verdict(command, 'bash').readOnly, false, command);
});

test('FS-117 PowerShell: listed cmdlets and properties are read-only; writers, programs and method calls are not',
  () => {
  for (const command of PS_READS) assert.equal(verdict(command, 'powershell').readOnly, true, command);
  for (const command of PS_OTHERS) assert.equal(verdict(command, 'powershell').readOnly, false, command);
});

test('FS-117 result is the scanCommand result for the same input, item by item', () => {
  const all = [['bash', [...BASH_READS, ...BASH_OTHERS]], ['powershell', [...PS_READS, ...PS_OTHERS]]];
  for (const [shell, list] of all) {
    for (const command of list) {
      const input = { command, shell, cwd, vars: { TEMP: join(cwd, '.work', 'tmp') } };
      assert.deepEqual(S.scanVerdict(input).result, S.scanCommand(input), `${shell}: ${command}`);
    }
  }
  const long = verdict('x'.repeat(S.SCAN_MAX_CHARS + 1), 'bash');
  assert.deepEqual(long, { result: { ok: false, reason: 'the command is too long' }, readOnly: false });
});

// ---- FS-118 只读会话里的命令 ----

test('FS-118 checkLimits: every read-only session runs read-only commands; other commands get only read-only commands',
  () => {
    for (const [owner, lead] of Object.entries(LEADS)) {
      for (const limits of [{ write: false }, { write: false, mcp: false }]) {
        const tag = `${owner} ${JSON.stringify(limits)}`;
        for (const command of ['ls', 'git status', 'cd src && cat a.txt']) {
          assert.equal(check(owner, limits, 'bash', { command }), null, `${tag}: ${command}`);
        }
        assert.equal(check(owner, limits, 'powershell', { command: 'Get-ChildItem' }), null, tag);
        for (const [tool, input] of [['bash', { command: 'npm test' }], ['bash', { command: 'echo x > a.txt' }],
          ['bash', { command: 'echo "abc' }], ['powershell', { command: 'Remove-Item a' }], ['bash', {}],
          ['bash', { command: 42 }]]) {
          assert.equal(check(owner, limits, tool, input), `${lead}: ${ONLY_READ}.`, `${tag}: ${JSON.stringify(input)}`);
        }
        for (const [tool, input] of [['write', { path: 'a.txt' }], ['edit', { path: '.work/n.md' }]]) {
          assert.equal(check(owner, limits, tool, input), `${lead}: no file changes or commands.`, `${tag}: ${tool}`);
        }
      }
    }
  });

test('FS-118 the dialog\'s TEAM_DIALOG_LIMITS still refuse read-only commands with the whole RELAY_ONLY', () => {
  for (const command of ['ls', 'git status']) {
    assert.equal(check('dialog', L.TEAM_DIALOG_LIMITS, 'bash', { command }), RELAY_ONLY, command);
  }
  assert.equal(L.readOnlySession({ owner: 'dialog', limits: L.TEAM_DIALOG_LIMITS }), false);
  assert.equal(L.readOnlySession({ owner: 'task', limits: { commands: false } }), false);
  assert.equal(L.readOnlySession(null), false);
  assert.equal(L.readOnlySession({ owner: 'close', limits: L.PROGRAM_LIMITS }), true);
  assert.equal(L.readOnlySession({ owner: 'task', limits: { write: false, mcp: false } }), true);
});

test('FS-118 path gate: under Ask each time a read-only command of a read-only session is free with no card',
  async () => {
    const narrowing = () => ({ owner: 'task', limits: { write: false } });
    const session = fakeSession(new ApprovalPolicy(), { cwd, instance: 'S.t1.executor', narrowing });
    for (const command of ['ls', 'git status', 'cat a.txt | head -5']) {
      const step = session.run('bash', { command });
      assert.deepEqual([step.gates, await step.result], [['free'], undefined], command);
    }
    const refused = session.run('bash', { command: 'echo x > a.txt' });
    assert.deepEqual(refused.gates, ['deny']);
    assert.deepEqual(await refused.result, { block: true, reason: `${LEADS.task}: ${ONLY_READ}.` });
    assert.deepEqual(session.asked(), [], 'no card');
    const plain = fakeSession(new ApprovalPolicy(), { cwd, instance: 'S.t2.executor' });
    const step = plain.run('bash', { command: 'ls' });
    assert.deepEqual(step.gates, ['ask'], 'a session that is not narrowed still asks');
    plain.gate.answer(step.request.requestId, 'reject');
    assert.deepEqual(await step.result, { block: true, reason: REJECTED_TEXT });
  });

test('FS-118 while stopping a read-only command of a read-only session gets the stop text', async () => {
  const narrowing = () => ({ owner: 'close', limits: L.PROGRAM_LIMITS });
  const session = fakeSession(new ApprovalPolicy(), { cwd, instance: 'S.close.1', narrowing });
  const stopping = session.gate.rejectForStop();
  await stopping;
  assert.deepEqual(await session.run('bash', { command: 'ls' }, { announce: false }).result,
    { block: true, reason: STOP_TEXT });
  assert.equal(await session.run('read', { path: 'a.txt' }, { announce: false }).result, undefined,
    'read still passes');
  session.gate.endStop();
  assert.equal(await session.run('bash', { command: 'ls' }).result, undefined);
});

// ---- FS-119 只读会话看到的文字 ----

test('FS-119 limitsText, the limits descriptions and the task_create Correct form follow the §14 2026-10-28 notes',
  () => {
    assert.equal(L.limitsText({ write: false }), quote14('no file changes; only read-only commands'));
    assert.equal(L.limitsText({ write: false, mcp: false }),
      `${quote14('no file changes; only read-only commands')}; no MCP or extension tools`);
    const info = (kind) => ({ kind, role: 'planner', roles: WITH_MEMORY.roles, merged: false, team: true });
    const def = (name, kind) => tools.boardTool(name, info(kind), { run: () => assert.fail('not run') }, true);
    const limits = def('task_create', 'create').parameters.properties.limits;
    assert.equal(limits.description, changed14('What every agent on this task may not do',
      'no file changes and no commands', 'no file changes and only read-only commands'));
    assert.equal(limits.properties.write.description, quote14('false: no file changes; only read-only commands.'));
    assert.equal(tools.toolUsage('task_create', 'create'), `Correct form: ${changed14('task_create {"request":1',
      'when the task must not change files or run commands', 'when the task must not change files')}`);
    const message = def('agent_message', 'task').parameters.properties.limits;
    assert.equal(message.description, changed14('Only for a question to a role that opens',
      'it never changes files or runs commands', 'it never changes files, runs only read-only commands'));
    assert.equal(message.properties.write.description, limits.properties.write.description, 'the same item');
  });

test('FS-119 the create, close, question and subscription segments, the delivery and the read-only subagent', () => {
  const mark = changed14('Set limits {"write": false}', 'unless it must run commands or change files',
    'unless it must change files or run commands that are not read-only');
  for (const kind of ['create', 'merged-create']) assert.ok(text.SEGMENTS[kind].split('\n').includes(mark), kind);
  assert.ok(text.SEGMENTS.create.split('\n').includes(quote14('You can read files and run read-only commands but')));
  const line = quote14('You can read files and run read-only commands, but not change files.');
  assert.equal(text.SEGMENTS.close.split('\n').at(-1), line);
  assert.equal(text.SEGMENTS.subscription.split('\n')[1], line);
  assert.equal(subagent.subagentSegment(true).split('\n')[2], line);
  assert.equal(text.SEGMENTS.ask, changed14('Another agent asked you one question.',
    'You can read, but you cannot change files, run commands or message other agents.',
    'You can read files and run read-only commands, but you cannot change files or message other agents.'));
  assert.equal(text.deliveryText('ask', { from: 'chat', text: 'Is a.ts safe?' }).split('\n')[1],
    quote14('Answer once. You can read files and run read-only commands'));
});

test('FS-119 the dialog lines, the merged create line and the general subagent stay; the first sentences stay', () => {
  assert.equal(text.SEGMENTS['team-dialog'].split('\n')[1], quote14("In task mode you can't change files"));
  assert.ok(text.SEGMENTS['merged-create'].split('\n')
    .includes(quote14('Anything that needs commands or file changes must become a task: in task mode')));
  assert.equal(subagent.subagentSegment(false).split('\n')[2],
    'Other agents may be working in the same folder at the same time; change only what your task needs.');
  const first = (segment) => /^.*?\.(?=\s|$)/.exec(segment)?.[0];
  assert.equal(first(text.SEGMENTS.close), 'You close request <n>.');
  assert.equal(first(text.SEGMENTS.ask), 'Another agent asked you one question.');
  assert.equal(first(text.SEGMENTS.subscription), 'You were woken by a moment you subscribed to.');
  assert.equal(first(text.SEGMENTS.create), 'You decide what happens with every user message in task mode.');
});
