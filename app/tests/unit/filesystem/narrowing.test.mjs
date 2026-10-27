// 收窄的 TaskBoard 一侧（docs/specs/file-system-permissions.md §8.2、§8.3、§8.5–§8.9；file-system.md §14；验收 §19.2
// FS-56（task_create 与 agent_message 里的 limits 校验与 schema）、FS-57、FS-58（对话会话经路径闸的那一段与各种实例的
// 开头）、FS-60（实例的白名单与对话的职责工具）、FS-61、FS-62、FS-63、FS-64 的单元部分）：Team.narrowingFor 与
// userNarrowing、InstanceSpec.narrowing 经 instanceSetup 到路径闸、agent_message 与 task_create 的 limits、写入锁、
// board.json 里的 limits、模型看到的文字。用平行 Agent 单元测试的会话表
// （tests/unit/taskboard/teamHarness.mjs，synthetic TeamHost，只读引用）驱动 Team；路径闸用 gate-helpers.mjs 的假 pi。
// 规格原文从 docs/specs/ 读出逐字比较；工具调用、角色文件与 board.json 都是手写的（synthetic）。不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { loadKernelModule } from '../load.mjs';
import * as scripts from '../../fake-endpoint/scripts.mjs';
import {
  B, SPLIT, addTask, beginRun, deps, finishRun, nextDelivery, roles, runDelivery, setup, until, workThen,
} from '../taskboard/teamHarness.mjs';
import { fakeSession, quietly, specText } from './gate-helpers.mjs';

// 各模块的打包结果按进程与模块分开命名（load.mjs），可以同时打包
const [approval, instances, R, text, tools, shared, selector] = await Promise.all([
  'src/kernel/approval.ts', 'src/kernel/instances.ts', 'src/kernel/boardRoute.ts', 'src/kernel/boardText.ts',
  'src/kernel/boardTools.ts', 'src/shared/team.ts', 'src/kernel/selector.ts',
].map((path) => loadKernelModule(path)));
const { ApprovalPolicy } = approval;

// ---- 规格原文 ----

const FS = specText('file-system.md');
/** file-system.md §14 一节 */
const SECTION_14 = FS.slice(FS.indexOf('\n## 14. '), FS.indexOf('\n## 15. '));

/**
 * @brief §14 原文表里以 start 开头的那段反引号原文（按英文开头找，同 identity.test.mjs 的 quote14）。
 * @param start 原文的开头
 */
function quote14(start) {
  const at = SECTION_14.indexOf(`\`${start}`);
  assert.ok(at >= 0, `no quoted text starting with "${start}" in §14`);
  const end = SECTION_14.indexOf('`', at + 1);
  assert.ok(end > at, `the quote starting with "${start}" is not closed`);
  return SECTION_14.slice(at + 1, end);
}

/** 平行 Agent 规格里的 ```text 代码块（附录 A 的各段在其中，按各段固定的第一句认） */
const PARALLEL_BLOCKS = [...specText('parallel-agents-taskboard.md').matchAll(/```text\n([\s\S]*?)\n```/g)]
  .map((match) => match[1]);

/**
 * 附录 A 各段的第一句，抄自 limits 之前（8d859a8）的合成端点 SEGMENT_SENTENCES：§14 只改别的行，这几句不变
 * （file-system-permissions.md §8.9、file-system.md §19.4）。
 */
const FIRST_SENTENCES = {
  close: 'You close request <n>.',
  task: 'You work on one task of the TaskBoard.',
  ask: 'Another agent asked you one question.',
  subscription: 'You were woken by a moment you subscribed to.',
  'merged-create': 'You talk to the user and you decide what happens with every user message in team mode.',
  create: 'You decide what happens with every user message in team mode.',
  'team-dialog': 'You are the only agent that talks to the user, and in team mode you relay; '
    + 'you do not decide or do the work.',
  'off-dialog': 'You can ask another role one question with agent_message; it answers once and cannot change files.',
};

/** @brief 附录 A 里某种会话的段（第一句为 FIRST_SENTENCES[kind] 的代码块）。 */
function appendixBlock(kind) {
  const found = PARALLEL_BLOCKS.filter((block) => block.startsWith(FIRST_SENTENCES[kind]));
  assert.equal(found.length, 1, `one appendix A block for ${kind}`);
  return found[0];
}

// ---- 常量 ----

/** pi 设置的默认工具（setup 的 baseTools） */
const DEFAULTS = ['read', 'bash', 'edit', 'write'];
/** 五种实例碰文件的部分：默认工具加全部 MCP 工具（§8.6） */
const FILE_TOOLS = [...DEFAULTS, 'mcp__*'];
/** 立项的 TaskBoard 工具（TEAM_TOOLS 的顺序） */
const CREATE_BOARD = ['board_read', 'read_session', 'agent_message', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog'];
/** 协作模式下对话会话的拒绝原文（file-system-permissions.md §8.3，整句；FS-58 的一个测试与规格逐字比较） */
const RELAY_ONLY = 'Team mode is on: the dialog agent only relays; the work is done in tasks.';
/** 程序给立项、结案、订阅与临时提问的收窄（PROGRAM_LIMITS） */
const PROGRAM = { write: false };
/** 协作模式下对话与合并会话的收窄（TEAM_DIALOG_LIMITS） */
const DIALOG = { write: false, mcp: false };
/** 协作模式下对话会话的收窄 */
const DIALOG_NARROWING = { owner: 'dialog', limits: DIALOG };
/** 拒绝原文的开头（file-system-permissions.md §8.3 的表；FS-58 的一个测试与规格逐字比较） */
const LEADS = {
  task: 'Not allowed for this task', ask: 'Not allowed for this question',
  create: 'Not allowed while deciding requests', close: 'Not allowed while closing a request',
  subscription: 'Not allowed in a subscription',
};
/** write: false 的规则文字（§8.4 第 2 条） */
const NO_WRITES = 'no file changes or commands';
/** 只有基座 mori：对话、立项、结案同一个角色（合并会话，synthetic） */
const MERGED = roles.parseRoleFiles([], deps);
/** 分开时的角色加一个订阅 done 的 request_closed 的 memory（synthetic，同 team-ask.test.mjs） */
const WITH_MEMORY = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/memory.md', text: '---\nname: memory\ndescription: Keeps notes\nsubscribe:\n'
    + '  - request_closed:\n      outcome: [done]\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
  { file: '.mori/agents/reviewer.md', text: '---\nname: reviewer\ndescription: Reviews\n---\n' },
], deps);
assert.deepEqual(WITH_MEMORY.problems, []);

// ---- 帮助函数 ----

/** @brief 对话会话一次运行的开始：before_agent_start（定下这次运行的模式、启用职责工具）与 agent_start。 */
function startUserRun(team, user) {
  user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
}

/** @brief 对话会话这次运行结束。 */
const endUserRun = (team) => team.onUserEvent({ type: 'agent_settled' });

let callNo = 0;

/**
 * @brief 调一个会话注册的 TaskBoard 工具（参数先经 prepareArguments，同 pi）。
 * @return 工具结果的 Promise
 */
function callTool(entry, name, args) {
  const tool = entry.api.tools.get(name);
  assert.ok(tool, `${name} is registered`);
  callNo += 1;
  return tool.execute(`n${callNo}`, tool.prepareArguments(args), undefined, undefined, {});
}

/** @brief 对话会话的路径闸，照 sessions.ts 的 startUser：收窄每次调用时取 team.userNarrowing()。 */
function dialogGate(team, cwd, policy = new ApprovalPolicy()) {
  return fakeSession(policy, { cwd, narrowing: () => team.userNarrowing() });
}

/** @brief 实例的路径闸，照 sessions.ts 的 createEntry：用 instanceSetup 的 gate（narrowing 包着 InstanceSpec.narrowing）。 */
function instanceGate(spec, policy) {
  const setup = instances.instanceSetup(spec, null, spec.id);
  return fakeSession(policy, { cwd: spec.cwd, instance: spec.id, kind: setup.kind, narrowing: setup.gate.narrowing });
}

/** @brief 工作路径旁边、工作路径外的一个目录（按目录放行它）。 */
const outsideOf = (cwd) => join(dirname(cwd), `${basename(cwd)}-out`);

/** @brief Full access，对 bash、edit、write 与一个 MCP 工具选过 Allow for this session，并按目录放行 outside。 */
function openPolicy(outside) {
  const policy = new ApprovalPolicy({ mode: 'full' });
  for (const name of ['bash', 'edit', 'write', 'powershell', 'mcp__docs__search']) policy.allowSession(name);
  policy.allowDirs([outside]);
  return policy;
}

/** @brief 每个调用都在路径闸第 2 步被拒绝（mori.tool_gate 为 deny）、原文为 reason，没有卡。 */
async function expectRefused(session, calls, reason) {
  for (const [tool, input] of calls) {
    const step = session.run(tool, input);
    assert.deepEqual(step.gates, ['deny'], `${tool} ${JSON.stringify(input)} is denied at step 2`);
    assert.deepEqual(await step.result, { block: true, reason }, tool);
  }
  assert.deepEqual(session.asked(), [], 'a narrowed call never shows a card');
}

/** @brief 每个调用都免批准放行（读取与职责工具，§8.2）。 */
async function expectFree(session, calls) {
  for (const [tool, input] of calls) {
    const step = session.run(tool, input);
    assert.deepEqual([step.gates, await step.result], [['free'], undefined], tool);
  }
}

/** @brief 一个程序收窄为 write: false 的实例（Full access 且都放行过）：写入与命令得到它这一种的开头，读取照常。 */
async function expectProgramNarrowed(spec) {
  const session = instanceGate(spec, openPolicy(outsideOf(spec.cwd)));
  await expectRefused(session, [['bash', { command: 'npm test' }], ['write', { path: 'notes.md', content: 'x' }],
    ['edit', { path: '.work/n.md', edits: [] }]], `${LEADS[spec.kind]}: ${NO_WRITES}.`);
  await expectFree(session, [['read', { path: 'a.ts' }], ['board_read', {}]]);
}

/**
 * @brief 发一条开临时提问的 agent_message，等提问实例收到投递，再让它回答（synthetic）。
 * @param from 发起方的会话条目
 * @param id 提问实例的 pi 会话 id
 * @return 投递与提问实例的设置
 */
async function askAndAnswer(host, from, args, id) {
  const pending = callTool(from, 'agent_message', args);
  const delivery = await nextDelivery(host, id);
  const spec = host.entry(id).spec;
  await runDelivery(host, delivery, [{ text: 'Looks fine.' }]);
  assert.equal((await pending).content[0].text, 'Looks fine.');
  return { delivery, spec };
}

/** @brief 一个会话这次请求的工作卡（mori-team 的 context 处理器追加的最后一条消息）。 */
function cardOf(entry) {
  const messages = entry.session.sessionManager.buildSessionContext().messages;
  const result = entry.api.handlers.get('context')({ type: 'context', messages });
  return result?.messages.at(-1)?.content ?? '';
}

/** @brief 需求 1 的结案：交接 T1 为 close_done，再以 done 关闭需求（synthetic）。 */
const CLOSE_RUN = [
  { calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Works.', outcome: 'close_done' } }] },
  { calls: [{ name: 'request_close', args: { request: 1, outcome: 'done', conclusion: 'Done.' } }] },
];

/** @brief T1 由 executor 做完，结案关闭 T1 与需求 1；返回结案实例的设置。 */
async function closeRequestDone(team, host) {
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
  const close = await nextDelivery(host, 'U.close.1');
  const spec = host.entry('U.close.1').spec;
  await runDelivery(host, close, CLOSE_RUN);
  return spec;
}

// ---- FS-57 谁受什么收窄 ----

test('FS-57 a task instance is narrowed by its own limits only; empty limits give no narrowing', async () => {
  const cases = [[{}, null], [{ write: false }, { write: false }], [{ mcp: false }, { mcp: false }],
    [{ commands: false, writePaths: ['src/'] }, { commands: false, writePaths: ['src/'] }]];
  for (const [limits, expected] of cases) {
    const tag = JSON.stringify(limits);
    const { team, host } = await setup();
    addTask(team, { limits });
    await nextDelivery(host, 'U.t1.executor');
    const spec = host.entry('U.t1.executor').spec;
    assert.deepEqual(spec.narrowing, expected === null ? null : { owner: 'task', limits: expected }, tag);
    assert.deepEqual(team.narrowingFor(team.taskLane('T1', 'executor')), spec.narrowing, `narrowingFor ${tag}`);
  }
});

test('FS-57 every instance of a task keeps its limits: the reviewer it is handed to and a write_paths refusal',
  async () => {
    const { team, host } = await setup();
    addTask(team, { limits: { writePaths: ['src/'] } });
    const start = await nextDelivery(host, 'U.t1.executor');
    await runDelivery(host, start, [{ calls: [{ name: 'task_handoff', args: { conclusion: 'Changed it.',
      outcome: 'continue', next: 'reviewer' } }] }]);
    await nextDelivery(host, 'U.t1.reviewer');
    const spec = host.entry('U.t1.reviewer').spec;
    assert.deepEqual(spec.narrowing, { owner: 'task', limits: { writePaths: ['src/'] } });
    const session = instanceGate(spec, openPolicy(outsideOf(spec.cwd)));
    await expectRefused(session, [['edit', { path: 'docs/a.md', edits: [] }]],
      quote14('Not allowed for this task: writes are limited to src/'));
  });

test('FS-57 tasks made by the split create instance do not carry its write: false; create is narrowed itself',
  async () => {
    const { team, host } = await setup();
    await team.setMode('on');
    team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
    const judge = await nextDelivery(host, 'U.create');
    const createSpec = host.entry('U.create').spec;
    assert.deepEqual(createSpec.narrowing, { owner: 'create', limits: PROGRAM });
    await expectProgramNarrowed(createSpec);
    const make = (title, assignee, limits) => ({ name: 'task_create', args: { request: 1, title,
      description: 'Do it', assignee, ...(limits ? { limits } : {}) } });
    await runDelivery(host, judge, [
      { calls: [{ name: 'request_submit', args: { title: 'Login page is blank', goal: 'Fix it' } }] },
      { calls: [make('Find and fix', 'executor'), make('Check the API', 'reviewer', { mcp: false })] },
      { text: 'Registered it.' },
    ]);
    assert.deepEqual(B.findTask(team.board, 'T1').limits, {}, 'no limits written: {}');
    await nextDelivery(host, 'U.t1.executor');
    assert.equal(host.entry('U.t1.executor').spec.narrowing, null, 'not the write: false of create');
    assert.deepEqual(team.narrowingFor(team.taskLane('T2', 'reviewer')), { owner: 'task', limits: { mcp: false } });
  });

test('FS-57 a task made by the merged session in team mode is not narrowed by the session’s write: false, mcp: false',
  async () => {
    const { team, host, user } = await setup(MERGED);
    await team.setMode('on');
    team.write((board) => B.submitRequest(board, { title: 'Login page is blank', goal: 'Fix it', acceptance: null,
      quote: null }, { message: 'fix the login page', history: [] }, Date.now()));
    const made = await callTool(user, 'task_create', { request: 1, title: 'Find and fix', description: 'Fix it',
      assignee: 'mori' });
    assert.match(made.content[0].text, /^Created T1 for Mori\./);
    assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING, 'the merged session itself is narrowed');
    await nextDelivery(host, 'U.t1.mori');
    assert.equal(host.entry('U.t1.mori').spec.narrowing, null);
  });

test('FS-57 a one-time question from the off-mode main agent is write: false; agent_message.limits only adds mcp',
  async () => {
    const { team, host, user } = await setup();
    startUserRun(team, user);
    const cases = [[undefined, PROGRAM], [{ mcp: false }, DIALOG],
      [{ write: true, commands: true, mcp: true }, PROGRAM]];
    for (const [index, [limits, expected]] of cases.entries()) {
      const id = `U.ask.${index + 1}.reviewer`;
      const args = { to: 'reviewer', text: 'Is a.ts safe?', ...(limits ? { limits } : {}) };
      const { spec } = await askAndAnswer(host, user, args, id);
      assert.deepEqual(spec.narrowing, { owner: 'ask', limits: expected }, JSON.stringify(limits));
    }
    endUserRun(team);
  });

test('FS-57 a one-time question from the team-mode dialog also gets mcp: false; nothing widens it', async () => {
  const { team, host, user } = await setup();
  await team.setMode('on');
  startUserRun(team, user);
  for (const [index, limits] of [undefined, { write: true, mcp: true }].entries()) {
    const id = `U.ask.${index + 1}.reviewer`;
    const args = { to: 'reviewer', text: 'What changed?', ...(limits ? { limits } : {}) };
    const { spec } = await askAndAnswer(host, user, args, id);
    assert.deepEqual(spec.narrowing, { owner: 'ask', limits: DIALOG }, JSON.stringify(limits));
    const session = instanceGate(spec, openPolicy(outsideOf(spec.cwd)));
    await expectRefused(session, [['mcp__docs__search', { query: 'x' }]],
      quote14('Not allowed for this question: no MCP or extension tools.'));
  }
  endUserRun(team);
});

/**
 * @brief 一个 task 实例问 reviewer 一个问题 Quick check?（task 有 limits，消息可以带 given）。
 * @return 投递与提问实例的设置
 */
async function taskAsks(limits, given) {
  const { team, host } = await setup();
  addTask(team, { limits });
  const start = await nextDelivery(host, 'U.t1.executor');
  await beginRun(host, start);
  const args = { to: 'reviewer', text: 'Quick check?', ...(given ? { limits: given } : {}) };
  return askAndAnswer(host, host.entry('U.t1.executor'), args, 'U.ask.1.reviewer');
}

test('FS-57 a question from a task inherits only mcp: false from the task or the message', async () => {
  const ask = (limits) => ({ owner: 'ask', limits });
  const narrowed = async (limits, given) => (await taskAsks(limits, given)).spec.narrowing;
  assert.deepEqual(await narrowed({ mcp: false }), ask(DIALOG));
  assert.deepEqual(await narrowed({ commands: false, writePaths: ['src/'] }), ask(PROGRAM),
    'commands and write_paths are already in write: false');
  assert.deepEqual(await narrowed({}, { mcp: false }), ask(DIALOG));
  assert.deepEqual(await narrowed({}, { write: true }), ask(PROGRAM), 'write: true does not widen it');
});

test('FS-57 agent_message.limits is not used for a message left on a task or sent into a seat session', async () => {
  const { team, host, user } = await setup();
  await team.setMode('on');
  addTask(team);
  await nextDelivery(host, 'U.t1.executor');
  startUserRun(team, user);
  const nextAsk = team.board.nextAsk;
  const left = await callTool(user, 'agent_message', { to: 'T1', text: 'Note for T1', limits: { mcp: false } });
  assert.equal(left.content[0].text, 'Left the message on T1.');
  const seat = await callTool(user, 'agent_message', { to: 'planner', text: 'Check request 1',
    limits: { mcp: false } });
  assert.equal(seat.content[0].text, 'Delivered to planner.');
  await nextDelivery(host, 'U.create');
  assert.deepEqual(host.entry('U.create').spec.narrowing, { owner: 'create', limits: PROGRAM },
    'create keeps the program narrowing only');
  assert.equal(team.board.nextAsk, nextAsk, 'no one-time question was opened');
  assert.equal(host.deliveries.some((item) => item.id.startsWith('U.ask.')), false);
  endUserRun(team);
});

test('FS-57 close and subscription instances are narrowed to write: false with their own leads', async () => {
  const { team, host } = await setup(WITH_MEMORY);
  const closeSpec = await closeRequestDone(team, host);
  assert.deepEqual(closeSpec.narrowing, { owner: 'close', limits: PROGRAM });
  await expectProgramNarrowed(closeSpec);
  await nextDelivery(host, 'U.sub.1.memory');
  const subSpec = host.entry('U.sub.1.memory').spec;
  assert.deepEqual(subSpec.narrowing, { owner: 'subscription', limits: PROGRAM });
  await expectProgramNarrowed(subSpec);
  assert.equal(`${LEADS.close}: ${NO_WRITES}.`, quote14('Not allowed while closing a request:'));
});

test('FS-57 the dialog is narrowed by the mode its run started in; without a run by the Team mode', async () => {
  const { team, user } = await setup();
  assert.equal(team.userNarrowing(), null, 'off mode, no run');
  await team.setMode('on');
  assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING, 'team mode, no run: the Team mode');
  startUserRun(team, user);
  assert.equal((await team.setMode('off')).mode, 'off');
  assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING, 'the run started in team mode stays narrowed');
  assert.deepEqual(team.narrowingFor(team.user), team.userNarrowing(), 'userNarrowing is narrowingFor(user)');
  endUserRun(team);
  assert.equal(team.userNarrowing(), null);
  startUserRun(team, user);
  await team.setMode('on');
  assert.equal(team.userNarrowing(), null, 'the run started in off mode stays unnarrowed');
  endUserRun(team);
  startUserRun(team, user);
  assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING, 'the next run is narrowed');
  endUserRun(team);
});

test('FS-57 team mode once (an open request when switching off) narrows the dialog too', async () => {
  const { team, host, user } = await setup();
  await team.setMode('on');
  addTask(team);
  await nextDelivery(host, 'U.t1.executor');
  assert.equal((await team.setMode('off')).mode, 'once');
  startUserRun(team, user);
  assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING);
  endUserRun(team);
});

test('FS-57 a program-delivered run of the split dialog is narrowed by its own start mode', async () => {
  const { team, host, user, cwd } = await setup();
  await team.setMode('on');
  await closeRequestDone(team, host);
  const report = await nextDelivery(host, 'U');
  assert.match(report.text, /^\[Mori\] Request 1 is closed \(done\)\./);
  await beginRun(host, report);
  assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING);
  const gate = dialogGate(team, cwd, new ApprovalPolicy({ mode: 'full' }));
  await expectRefused(gate, [['bash', { command: 'npm test' }]], RELAY_ONLY);
  assert.equal((await team.setMode('off')).mode, 'off', 'the request is closed, so team mode can go off');
  assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING, 'this run started in team mode');
  await finishRun(host, report, [{ text: 'Request 1 is done.' }]);
  startUserRun(team, user);
  assert.equal(team.userNarrowing(), null, 'the next run is in off mode');
  endUserRun(team);
});

test('FS-57 a program-delivered run of the merged session (create_wake) gets TEAM_DIALOG_LIMITS', async () => {
  const { team, host, cwd } = await setup(MERGED);
  await team.setMode('on');
  addTask(team, { assignee: 'mori' });
  await runDelivery(host, await nextDelivery(host, 'U.t1.mori'), [{ calls: [{ name: 'task_handoff',
    args: { conclusion: 'Keep the old API?', outcome: 'need_user' } }] }]);
  const wake = await nextDelivery(host, 'U');
  await beginRun(host, wake);
  assert.deepEqual(team.userNarrowing(), DIALOG_NARROWING);
  const gate = dialogGate(team, cwd, new ApprovalPolicy({ mode: 'full' }));
  await expectRefused(gate, [['edit', { path: 'a.ts', edits: [] }], ['mcp__docs__search', { query: 'x' }]],
    RELAY_ONLY);
  await finishRun(host, wake, [{ text: 'Should I keep the old API?' }]);
});

test('FS-57 off mode: the main agent is not narrowed, with or without other roles', async () => {
  for (const load of [SPLIT, MERGED]) {
    const { team, user } = await setup(load);
    startUserRun(team, user);
    assert.equal(team.userNarrowing(), null, `merged: ${load.merged}`);
    endUserRun(team);
  }
});

// ---- FS-58 对话会话经路径闸 ----

/** 协作模式下对话会话碰文件的调用：都得到整句 RELAY_ONLY（ls、git status 这样的只读命令也是） */
const DIALOG_REFUSED = [
  ['bash', { command: 'npm test' }], ['bash', { command: 'git status' }], ['powershell', { command: 'Get-ChildItem' }],
  ['edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }], ['write', { path: 'a.txt', content: 'x' }],
  ['write', { path: '.work/n.md', content: 'x' }], ['mcp__docs__search', { query: 'x' }],
  ['web_search', { query: 'x' }],
];
/** 读取类与职责工具：从不被收窄拒绝 */
const DIALOG_FREE = [['read', { path: 'a.ts' }], ['grep', { pattern: 'x' }], ['ls', { path: '.' }],
  ['board_read', {}], ['memory', { action: 'add', text: 'x' }], ['ask_user_question', { questions: [] }]];

test('FS-58 the team-mode dialog gets the whole RELAY_ONLY at step 2 under Ask, Full access, session and folder '
  + 'allows; no card', async () => {
  const { team, user, cwd } = await setup();
  await team.setMode('on');
  startUserRun(team, user);
  const outside = outsideOf(cwd);
  const policies = [['Ask each time', new ApprovalPolicy()], ['Full access', new ApprovalPolicy({ mode: 'full' })],
    ['allowed for this session and by folder', openPolicy(outside)]];
  for (const [name, policy] of policies) {
    const session = dialogGate(team, cwd, policy);
    const calls = [...DIALOG_REFUSED, ['write', { path: join(outside, 'a.md'), content: 'x' }]];
    await expectRefused(session, calls, RELAY_ONLY);
    await expectFree(session, DIALOG_FREE);
    assert.equal(session.sent.some((event) => event.type === 'mori.approval_request'), false, name);
  }
  endUserRun(team);
});

test('FS-58 the same calls in an off-mode run are judged by the permission mode: a card under Ask, free under Full',
  async () => {
    const { team, user, cwd } = await setup();
    startUserRun(team, user);
    const ask = dialogGate(team, cwd, new ApprovalPolicy());
    const step = ask.run('bash', { command: 'npm test' });
    assert.deepEqual(step.gates, ['ask']);
    ask.gate.answer(step.request.requestId, 'reject');
    assert.deepEqual(await step.result, { block: true, reason: 'Rejected by the user.' });
    const full = dialogGate(team, cwd, new ApprovalPolicy({ mode: 'full' }));
    const run = full.run('bash', { command: 'npm test' });
    assert.deepEqual([run.gates, await run.result], [['full'], undefined]);
    endUserRun(team);
  });

test('FS-58 the leads and the RELAY_ONLY sentence used here are the file-system-permissions.md §8.3 table', () => {
  const perms = specText('file-system-permissions.md');
  const table = perms.slice(perms.indexOf('\n### 8.3 '), perms.indexOf('\n### 8.4 '));
  assert.ok(table.length > 0, '§8.3 is found');
  for (const [kind, lead] of Object.entries(LEADS)) assert.ok(table.includes(`| \`${lead}\` |`), `${kind}: ${lead}`);
  assert.ok(table.includes(` \`${RELAY_ONLY}\` |`), 'the whole RELAY_ONLY sentence is the dialog row');
});

// ---- FS-60 工具不再开关 ----

test('FS-60 every instance kind gets the pi defaults, mcp__* and its duty tools; no kind or limits switch', () => {
  const expected = {
    task: ['board_read', 'read_session', 'agent_message', 'task_handoff'], create: CREATE_BOARD,
    close: ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_close'],
    ask: ['board_read', 'read_session'], subscription: ['board_read', 'read_session', 'agent_message'],
  };
  for (const [kind, board] of Object.entries(expected)) {
    assert.deepEqual(roles.instanceTools(kind, DEFAULTS, true), [...FILE_TOOLS, ...board], kind);
  }
  assert.deepEqual(roles.instanceTools('ask', DEFAULTS, false), FILE_TOOLS, 'off mode question: no TaskBoard tools');
  assert.deepEqual(roles.instanceTools('close', ['read', 'grep'], true).slice(0, 3), ['read', 'grep', 'mcp__*'],
    'the pi defaults as set');
});

test('FS-60 a write: false task and a one-time question are created with bash, edit and write', async () => {
  const { team, host } = await setup(WITH_MEMORY);
  addTask(team, { limits: { write: false } });
  const start = await nextDelivery(host, 'U.t1.executor');
  const task = host.entry('U.t1.executor').spec;
  assert.deepEqual(task.tools, [...FILE_TOOLS, 'board_read', 'read_session', 'agent_message', 'task_handoff']);
  assert.deepEqual(task.narrowing, { owner: 'task', limits: PROGRAM }, 'narrowed per call instead');
  await beginRun(host, start);
  const { spec } = await askAndAnswer(host, host.entry('U.t1.executor'), { to: 'reviewer', text: 'Check?' },
    'U.ask.1.reviewer');
  assert.deepEqual(spec.tools, [...FILE_TOOLS, 'board_read', 'read_session'], 'no agent_message in a question');
  assert.deepEqual(spec.narrowing, { owner: 'ask', limits: PROGRAM });
});

test('FS-60 create, close and subscription instances are created with the pi defaults and MCP as well', async () => {
  const done = await setup(WITH_MEMORY);
  const close = await closeRequestDone(done.team, done.host);
  assert.deepEqual(close.tools, [...FILE_TOOLS, 'board_read', 'read_session', 'agent_message', 'task_handoff',
    'request_close']);
  await nextDelivery(done.host, 'U.sub.1.memory');
  assert.deepEqual(done.host.entry('U.sub.1.memory').spec.tools,
    [...FILE_TOOLS, 'board_read', 'read_session', 'agent_message']);
  const { team, host } = await setup();
  await team.setMode('on');
  team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
  await nextDelivery(host, 'U.create');
  assert.deepEqual(host.entry('U.create').spec.tools, [...FILE_TOOLS, ...CREATE_BOARD, 'memory'],
    'the split create instance also has memory (memory spec §7.6)');
});

/**
 * @brief 用户会话注册了 memory 与 ask_user_question（synthetic，同 sessions.ts：两者都由扩展注册、默认启用），
 *        记下 setActiveTools 的每次调用。
 * @param active 打开时 pi 启用的工具
 */
async function dutySetup(load, active = [...DEFAULTS, 'ask_user_question', 'memory']) {
  const sets = [];
  const prepareUser = (user) => {
    user.api.registerTool({ name: 'memory' });
    user.api.registerTool({ name: 'ask_user_question' });
    user.api.setActiveTools(active);
    const setActive = user.api.setActiveTools;
    user.api.setActiveTools = (names) => {
      sets.push([...names]);
      setActive(names);
    };
  };
  return { ...(await setup(load, null, { prepareUser })), sets };
}

/** @brief 一次运行开始之后启用的工具（排序）。 */
function activeInRun(s) {
  startUserRun(s.team, s.user);
  const active = [...s.user.api.getActiveTools()].sort();
  endUserRun(s.team);
  return active;
}

const sorted = (names) => [...names].sort();

test('FS-60 applyDutyTools follows the §8.6 table and leaves the file tools and ask_user_question alone', async () => {
  const solo = await dutySetup(MERGED);
  assert.deepEqual(activeInRun(solo), sorted([...DEFAULTS, 'ask_user_question', 'memory']));
  assert.deepEqual(solo.sets, [], 'off mode without other roles: the same as pi has, so no setActiveTools');
  const split = await dutySetup(SPLIT);
  const off = sorted([...DEFAULTS, 'ask_user_question', 'agent_message', 'memory']);
  assert.deepEqual(activeInRun(split), off, 'off mode with other roles');
  await split.team.setMode('on');
  assert.deepEqual(activeInRun(split), sorted([...DEFAULTS, 'ask_user_question', 'board_read', 'read_session',
    'agent_message']), 'team mode, split: no memory');
  assert.equal((await split.team.setMode('off')).mode, 'off');
  assert.deepEqual(activeInRun(split), off, 'back in off mode: the file tools were never touched');
  const merged = await dutySetup(MERGED);
  await merged.team.setMode('on');
  assert.deepEqual(activeInRun(merged), sorted([...DEFAULTS, 'ask_user_question', ...CREATE_BOARD, 'memory']),
    'team mode, merged');
});

test('FS-60 the file tools pi enabled stay as they are, in order; only the duty tools are added after them',
  async () => {
    const s = await dutySetup(SPLIT, ['read', 'grep', 'ask_user_question']);
    await s.team.setMode('on');
    startUserRun(s.team, s.user);
    assert.deepEqual(s.user.api.getActiveTools(), ['read', 'grep', 'ask_user_question', 'board_read', 'read_session',
      'agent_message']);
    endUserRun(s.team);
  });

// ---- FS-61 角色文件的 tools ----

/** @brief 只有 name、description 与另外几行的角色文件 reviewer.md（synthetic）。 */
const reviewerFile = (...lines) => ['---', 'name: reviewer', 'description: Reviews', ...lines, '---', 'Review.', '']
  .join('\n');

test('FS-61 a role file with tools: makes the session agents_invalid with unknown field "tools"; without it Check '
  + 'again passes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mori-fs-roles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.mori', 'agents'), { recursive: true });
  const file = join(dir, '.mori', 'agents', 'reviewer.md');
  writeFileSync(file, reviewerFile('tools: [read]'));
  const bad = (await quietly(() => roles.loadRoles(dir, deps))).value;
  const line = '.mori/agents/reviewer.md: unknown field "tools"';
  assert.deepEqual(bad.problems, [line]);
  const { blocked } = selector.staticCheck({ agentProblems: bad.problems });
  assert.deepEqual([blocked.kind, blocked.problems, blocked.actions], ['agents_invalid', [line], ['check_agents']]);
  writeFileSync(file, reviewerFile());
  const good = await roles.loadRoles(dir, deps);
  assert.deepEqual(good.problems, []);
  assert.ok(good.roles.some((role) => role.name === 'reviewer'));
  assert.equal(good.roles.some((role) => 'tools' in role), false, 'roles have no tools field');
});

test('FS-61 any way of writing tools is the same unknown field', () => {
  for (const value of ['tools: read', 'tools: []', 'tools: [read, bash, "mcp__docs__*"]', 'tools:']) {
    const load = roles.parseRoleFiles([{ file: '.mori/agents/reviewer.md', text: reviewerFile(value) }], deps);
    assert.deepEqual(load.problems, ['.mori/agents/reviewer.md: unknown field "tools"'], value);
  }
});

// ---- FS-62 写入锁 ----

/** 只有 write: false 不是写 task（§8.7） */
const WRITE_SHAPES = [{}, { commands: false }, { mcp: false }, { writePaths: ['src/'] },
  { commands: false, mcp: false, writePaths: ['src/', 'docs/'] }];

/** @brief 有需求 1 与几个 task（按 limits 的列表）的 TaskBoard（synthetic）。 */
function boardWith(limitsList) {
  let board = B.submitRequest(B.newBoard(), { title: 'Login page is blank', goal: 'Fix it', acceptance: null,
    quote: null }, { message: 'fix the login page', history: [] }, 1000).board;
  for (const [index, limits] of limitsList.entries()) {
    const result = B.createTask(board, { request: 1, title: `Task ${index + 1}`, description: 'Do it',
      assignee: 'executor', limits, dependsOn: [] }, 2000 + index);
    assert.equal(result.error, null);
    board = result.board;
  }
  return board;
}

test('FS-62 writesFiles: every limits shape except write: false is a write task', () => {
  for (const limits of WRITE_SHAPES) assert.equal(B.writesFiles({ limits }), true, JSON.stringify(limits));
  assert.equal(B.writesFiles({ limits: { write: false } }), false);
});

test('FS-62 scheduleStarts: each write shape takes the lock and makes the next write task wait; write: false never',
  () => {
    for (const limits of WRITE_SHAPES) {
      const result = R.scheduleStarts(boardWith([limits, {}]), []);
      const tag = JSON.stringify(limits);
      assert.deepEqual([result.starts.map((item) => item.task), result.board.lock], [['T1'], 'T1'], tag);
      assert.deepEqual(result.waiting, [{ task: 'T2', phase: 'lock_wait', lockHolder: 'T1' }], tag);
    }
    const mixed = R.scheduleStarts(boardWith([{}, { write: false }, { mcp: false }, { write: false }]), []);
    assert.deepEqual(mixed.starts.map((item) => item.task), ['T1', 'T2', 'T4'], 'write: false runs beside T1');
    assert.deepEqual(mixed.waiting, [{ task: 'T3', phase: 'lock_wait', lockHolder: 'T1' }]);
    assert.equal(R.scheduleStarts(boardWith([{ write: false }]), []).board.lock, null);
  });

test('FS-62 in the Team the second write task shows "Waiting to change files (T1)"; write: false runs at once',
  async () => {
    const { team, host, cwd } = await setup();
    addTask(team);
    addTask(team, { limits: { writePaths: ['src/'] }, title: 'Second' });
    addTask(team, { limits: { write: false }, assignee: 'reviewer', title: 'Review' });
    await nextDelivery(host, 'U.t1.executor');
    await nextDelivery(host, 'U.t3.reviewer');
    const view = await until(() => {
      const current = team.view();
      return current.requests[0].tasks.find((task) => task.id === 'T2')?.phase === 'lock_wait' && current;
    }, 'T2 waiting for the lock');
    const row = view.requests[0].tasks.find((task) => task.id === 'T2');
    assert.deepEqual(row.waitingFor, ['T1']);
    assert.equal(shared.taskPhaseText(row, view, team.holders, cwd), 'Waiting to change files (T1)');
    assert.equal(team.board.lock, 'T1');
    assert.equal(host.deliveries.some((item) => item.id.startsWith('U.t2.')), false, 'T2 has not started');
  });

// ---- FS-63 board.json ----

/** @brief 一个临时目录（测试结束时删掉）。 */
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @brief board 的 JSON，每个 task 经 change 改过（synthetic 的旧文件或不合格的文件）。 */
function boardText(board, change) {
  const data = structuredClone(board);
  for (const task of data.tasks) change(task);
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** @brief 当前版本以前存下的 task：有 readOnly，没有 limits（synthetic）。 */
function oldTask(task) {
  task.readOnly = task.limits.write === false;
  delete task.limits;
}

test('FS-63 limits are written and read back unchanged; a task without limits is written as limits: {}',
  async (t) => {
    const dir = tempDir(t, 'mori-fs-board-');
    const shapes = [{}, { write: false }, ...WRITE_SHAPES.slice(1)];
    const input = structuredClone(shapes);
    const board = boardWith(input);
    input[1].mcp = false;
    assert.deepEqual(board.tasks.map((task) => task.limits), shapes, 'createTask keeps its own copy');
    await B.saveBoard(dir, board);
    const raw = readFileSync(join(dir, 'board.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw).tasks.map((task) => task.limits), shapes);
    assert.match(raw, /"limits": \{\},/, 'no limits: {}');
    assert.equal(/readOnly|read_only/.test(raw), false);
    assert.deepEqual((await B.loadBoard(dir)).tasks.map((task) => task.limits), shapes);
  });

/**
 * @brief loadBoard 读 dir 里的这份 board.json 失败：原文为 <path> is not a valid TaskBoard: …，含 tasks.<n>.limits；
 *        文件没被改写。
 */
async function expectInvalid(dir, contents, tasks = [0]) {
  const path = join(dir, 'board.json');
  writeFileSync(path, contents);
  await assert.rejects(() => quietly(() => B.loadBoard(dir)), (error) => {
    assert.ok(error.message.startsWith(`${path} is not a valid TaskBoard: `), error.message);
    for (const n of tasks) assert.match(error.message, new RegExp(`tasks\\.${n}\\.limits`));
    return true;
  });
  assert.equal(readFileSync(path, 'utf8'), contents, 'the file is not rewritten');
}

test('FS-63 a board.json with readOnly and no limits is not a valid TaskBoard; the Team cannot attach', async (t) => {
  const dir = tempDir(t, 'mori-fs-board-');
  const old = boardText(boardWith([{}, { write: false }]), oldTask);
  await expectInvalid(dir, old, [0, 1]);
  let teamDir = null;
  const prepareUser = (_user, cwd) => {
    teamDir = join(cwd, 'teams', 'U');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'board.json'), old);
  };
  await assert.rejects(() => quietly(() => setup(SPLIT, null, { prepareUser })), (error) => {
    assert.ok(error.message.startsWith(`${join(teamDir, 'board.json')} is not a valid TaskBoard: `), error.message);
    return true;
  });
  assert.equal(readFileSync(join(teamDir, 'board.json'), 'utf8'), old, 'no conversion is written');
});

test('FS-63 limits is required and strict: no conversion from readOnly and no default', async (t) => {
  const dir = tempDir(t, 'mori-fs-board-');
  const board = boardWith([{}]);
  const bad = [
    (task) => { delete task.limits; },
    (task) => { task.limits = null; },
    (task) => { task.limits = { readOnly: true }; },
    (task) => { task.limits = { write: true }; },
    (task) => { task.limits = { commands: true }; },
    (task) => { task.limits = { write_paths: ['src/'] }; },
    (task) => { task.limits = { writePaths: [] }; },
    (task) => { task.limits = { writePaths: Array.from({ length: 11 }, (_, i) => `d${i}/`) }; },
  ];
  for (const change of bad) await expectInvalid(dir, boardText(board, change));
  const good = [{ write: false }, { commands: false, mcp: false, writePaths: ['src/', 'docs/'] }];
  for (const limits of good) {
    writeFileSync(join(dir, 'board.json'), boardText(board, (task) => { task.limits = limits; }));
    assert.deepEqual((await B.loadBoard(dir)).tasks[0].limits, limits);
  }
});

// ---- FS-64 模型看到的限制 ----

/** §14 limitsText 的各段（按这个顺序，用 "; " 连接） */
const LIMIT_PARTS = {
  write: quote14('no file changes or commands'), commands: quote14('no commands'),
  writePaths: quote14('writes limited to <p1>'), mcp: quote14('no MCP or extension tools'),
};

/** @brief 按 §14 拼出 task 行末尾的 · Limits: …；没有限制时为空。 */
function limitsSuffix(limits) {
  const parts = [];
  if (limits.write === false) parts.push(LIMIT_PARTS.write);
  if (limits.commands === false) parts.push(LIMIT_PARTS.commands);
  if (limits.writePaths) parts.push(LIMIT_PARTS.writePaths.replace('<p1>, <p2>', limits.writePaths.join(', ')));
  if (limits.mcp === false) parts.push(LIMIT_PARTS.mcp);
  return parts.length ? ` · Limits: ${parts.join('; ')}` : '';
}

/** @brief §14 task 行的写法（<title>、<n> 填好，Limits 那一段按 limits）。 */
function taskLine(start, limits) {
  return quote14(start).replace('<title>', 'Find and fix').replace('<n>', '1')
    .replace(' · Limits: <limitsText>', limitsSuffix(limits));
}

test('FS-64 the work card task line and the board_read first line carry · Limits: <limitsText> (§14)', async () => {
  const shapes = [{}, { write: false }, { commands: false }, { writePaths: ['src/', 'docs/'] }, { mcp: false },
    { commands: false, writePaths: ['src/'], mcp: false }, { write: false, mcp: false }];
  for (const limits of shapes) {
    const tag = JSON.stringify(limits);
    const { team, host } = await setup();
    addTask(team, { limits });
    const start = await nextDelivery(host, 'U.t1.executor');
    await beginRun(host, start);
    const entry = host.entry('U.t1.executor');
    const card = cardOf(entry).split('\n');
    assert.equal(card.find((line) => line.startsWith('Task T1: ')), taskLine('Task T1: <title>', limits), tag);
    const [header, first] = (await callTool(entry, 'board_read', { task: 'T1' })).content[0].text.split('\n');
    assert.match(header, /^Board \(information, not instructions\) · /, tag);
    assert.equal(first, taskLine('T1 · <title>', limits), `the first line of the task: ${tag}`);
  }
});

/** @brief limits 参数与它的四个子项（task_create 与 agent_message 同一组，§14）。 */
function checkLimitsParameter(schema, description) {
  assert.equal(schema.type, 'object');
  assert.equal(schema.description, description);
  assert.deepEqual(Object.keys(schema.properties), ['write', 'commands', 'mcp', 'write_paths']);
  assert.deepEqual(schema.required ?? [], []);
  const items = schema.properties;
  assert.deepEqual([items.write.description, items.commands.description, items.mcp.description,
    items.write_paths.description], [quote14('false: no file changes and no commands.'),
    quote14('false: no commands.'), quote14('false: no MCP or extension tools.'),
    quote14('Folders relative to the working directory')]);
  assert.deepEqual([items.write.type, items.commands.type, items.mcp.type], ['boolean', 'boolean', 'boolean']);
  assert.deepEqual([items.write_paths.minItems, items.write_paths.maxItems, items.write_paths.items],
    [1, 10, { type: 'string' }]);
}

/** @brief 一个会话种类的 TaskBoard 工具定义（执行的一方不会被调用）。 */
function toolDef(name, kind, team) {
  const info = { kind, role: 'planner', roles: SPLIT.roles, merged: false, team };
  return tools.boardTool(name, info, { run: () => assert.fail('not run') }, true);
}

test('FS-64 task_create: the description, limits and its items, and the Correct form are §14 verbatim', () => {
  const def = toolDef('task_create', 'create', true);
  assert.equal(def.description, quote14('Create a task of a request'));
  assert.deepEqual(Object.keys(def.parameters.properties),
    ['request', 'title', 'description', 'assignee', 'limits', 'depends_on']);
  checkLimitsParameter(def.parameters.properties.limits, quote14('What every agent on this task may not do'));
  assert.equal(tools.toolUsage('task_create', 'create'), `Correct form: ${quote14('task_create {"request":1')}`);
});

/**
 * @brief 按 pi 的顺序校验一次调用的参数：prepareArguments，再 pi 的 validateToolArguments（不合 schema 时抛错）。
 * @return 校验过的参数
 */
function piValidate(def, args) {
  return validateToolArguments({ name: def.name, parameters: def.parameters },
    { type: 'toolCall', id: 'v1', name: def.name, arguments: def.prepareArguments(args) });
}

/** @brief n 个不同的 write_paths 项。 */
const folders = (n) => Array.from({ length: n }, (_, i) => `d${i}/`);

test('FS-56 task_create has no read_only and limits is optional; task_edit has no limits', () => {
  const def = toolDef('task_create', 'create', true);
  assert.deepEqual(def.parameters.required, ['request', 'title', 'description', 'assignee'], 'limits is optional');
  const edit = toolDef('task_edit', 'create', true);
  assert.equal('limits' in edit.parameters.properties, false, 'task_edit has no limits');
  assert.equal(JSON.stringify([def, edit]).includes('read_only'), false);
  const args = { request: 1, title: 'Find and fix', description: 'Fix it', assignee: 'executor' };
  assert.deepEqual(piValidate(def, args), args, 'pi accepts a task_create without limits');
});

test('FS-56 pi rejects an empty write_paths and 11 items in task_create and agent_message; 10 items pass', () => {
  const calls = [[toolDef('task_create', 'create', true), { request: 1, title: 'Find and fix', description: 'Fix it',
    assignee: 'executor' }], [toolDef('agent_message', 'dialog', true), { to: 'reviewer', text: 'Is a.ts safe?' }]];
  for (const [def, base] of calls) {
    for (const count of [0, 11]) {
      assert.throws(() => piValidate(def, { ...base, limits: { write_paths: folders(count) } }),
        new RegExp(`^Error: Validation failed for tool "${def.name}":`), `${def.name} with ${count} items`);
    }
    const ten = piValidate(def, { ...base, limits: { write_paths: folders(10) } });
    assert.deepEqual(ten.limits.write_paths, folders(10), `${def.name} with 10 items`);
  }
});

/** agent_message 原来的两段说明（抄自 8d859a8 的 boardTools.ts，§8.9：逐字不变） */
const ASK_DESCRIPTION = 'Ask another role one question. It answers once in a read-only session and cannot change '
  + 'files; its answer is the result of this call.';
const TEAM_MESSAGE_DESCRIPTION = 'Send a message to a role, or leave it on a task (to: T1; whoever works on the task '
  + 'sees it next, nobody is woken). A message to a role goes to the session that holds its seat (create or close), '
  + 'or opens a one-time read-only question that is answered once. wait: true waits for the reply.';
/** 关闭模式的对话段（抄自 8d859a8 的 boardText.ts，§8.9：逐字不变） */
const OFF_DIALOG = 'You can ask another role one question with agent_message; it answers once and cannot change '
  + 'files.\nIf a request needs several kinds of work, you may suggest that the user sends it with /team.';
/** agent_message 的 Correct form（抄自 8d859a8 的 boardTools.ts USAGES；§8.9 只加 limits 参数，TB-49 照旧） */
const MESSAGE_USAGE = 'Correct form: agent_message {"to":"<role>","text":"<message>"} or '
  + '{"to":"T1","text":"<note for the task>"}';

test('FS-64 agent_message gets only the limits parameter; its two descriptions and the off-mode dialog segment stay',
  () => {
    const dialog = toolDef('agent_message', 'dialog', true);
    assert.equal(dialog.description, `${ASK_DESCRIPTION} In team mode: send a message to a role, or leave it on a task `
      + TEAM_MESSAGE_DESCRIPTION.slice('Send a message to a role, or leave it on a task '.length));
    const limitsText = quote14('Only for a question to a role that opens');
    for (const kind of ['task', 'close', 'subscription', 'create']) {
      const def = toolDef('agent_message', kind, true);
      assert.equal(def.description, TEAM_MESSAGE_DESCRIPTION, kind);
      checkLimitsParameter(def.parameters.properties.limits, limitsText);
      assert.equal(tools.toolUsage('agent_message', kind), MESSAGE_USAGE, kind);
    }
    assert.deepEqual(Object.keys(dialog.parameters.properties), ['to', 'text', 'wait', 'request', 'limits']);
    assert.deepEqual(dialog.parameters.required, ['to', 'text']);
    checkLimitsParameter(dialog.parameters.properties.limits, limitsText);
    assert.equal(tools.toolUsage('agent_message', 'dialog'), MESSAGE_USAGE);
    assert.equal(text.SEGMENTS['off-dialog'], OFF_DIALOG);
  });

test('FS-64 the changed segments carry the §14 lines in the code and in appendix A; the first sentences stay', () => {
  const lines = {
    create: [quote14('Set limits {"write": false}'), quote14('You can read files but not change them or run '
      + 'commands: anything')],
    'merged-create': [quote14('Set limits {"write": false}'), quote14('Anything that needs commands or file changes '
      + 'must become a task: in team mode')],
    'team-dialog': [quote14("In team mode you can't change files")],
    close: [quote14('You can read files but not change them or run commands.')],
    subscription: [quote14('You cannot change files or run commands.')],
  };
  for (const [kind, wanted] of Object.entries(lines)) {
    for (const line of wanted) {
      assert.ok(text.SEGMENTS[kind].split('\n').includes(line), `${kind} has: ${line}`);
      assert.ok(appendixBlock(kind).split('\n').includes(line), `appendix A ${kind} has: ${line}`);
    }
  }
  assert.equal(text.SEGMENTS['team-dialog'].split('\n')[1], lines['team-dialog'][0], 'the second line');
  assert.equal(text.SEGMENTS.close.split('\n').at(-1), lines.close[0], 'the last line');
  assert.equal(text.SEGMENTS.subscription.split('\n')[1], lines.subscription[0], 'the second line');
  assert.equal(text.SEGMENTS.ask, quote14('Another agent asked you one question.'));
  const first = (segment) => /^.*?\.(?=\s|$)/.exec(segment)?.[0];
  for (const [kind, sentence] of Object.entries(FIRST_SENTENCES)) {
    assert.equal(first(text.SEGMENTS[kind]), sentence, kind);
  }
  assert.deepEqual(scripts.SEGMENT_SENTENCES, FIRST_SENTENCES, 'SEGMENT_SENTENCES still tell every session apart');
});

/** limits 之前（8d859a8 的 boardText.ts）的立项一行，§8.9 换成了 MARK_LINE */
const OLD_MARK_LINE = 'Mark a task read_only unless it must run commands or change files.';

test('FS-64 every segment is its appendix A block word for word; no read_only line is left', () => {
  assert.deepEqual(Object.keys(text.SEGMENTS).sort(), Object.keys(FIRST_SENTENCES).sort(), 'every kind is checked');
  for (const kind of Object.keys(FIRST_SENTENCES)) {
    const block = appendixBlock(kind);
    assert.equal(text.SEGMENTS[kind], block, kind);
    assert.doesNotMatch(block, /read_only|read-only/, `appendix A ${kind}`);
  }
  const all = Object.values(text.SEGMENTS).join('\n');
  assert.doesNotMatch(all, /read_only|read-only/);
  assert.equal(all.includes(OLD_MARK_LINE), false, 'the old create line is gone');
  for (const kind of ['create', 'merged-create']) {
    assert.ok(text.SEGMENTS[kind].split('\n').includes(quote14('Set limits {"write": false}')), `${kind} MARK_LINE`);
  }
});

/** @brief §14 临时提问的投递（<role> 为发起方的角色，<text> 为问题）。 */
function askDelivery(role, question) {
  const head = quote14('[Mori] <role> asks you').replace('<role>', role).replace('<text>', question);
  return `${head}\n${quote14('Answer once.')}`;
}

test('FS-64 the one-time question delivery is §14 verbatim from the off-mode dialog, the team-mode dialog and a task',
  async () => {
    for (const mode of ['off', 'on']) {
      const { team, host, user } = await setup();
      if (mode === 'on') await team.setMode('on');
      startUserRun(team, user);
      const { delivery } = await askAndAnswer(host, user, { to: 'reviewer', text: 'Is a.ts safe?' },
        'U.ask.1.reviewer');
      assert.equal(delivery.text, askDelivery('chat', 'Is a.ts safe?'), `${mode} mode`);
      endUserRun(team);
    }
    const { delivery } = await taskAsks({ commands: false }, { mcp: false });
    assert.equal(delivery.text, askDelivery('executor', 'Quick check?'), 'from a task, whatever the limits');
  });

/** @brief §14 limits 校验的原因（<p> 填好）。 */
function limitsReason(start, path) {
  return quote14(`limits.write_paths: "<p>" ${start}`).replace('<p>', path);
}

/** 不合格的 write_paths 与它的原因（§8.2 第 4 步） */
const BAD_PATHS = [['C:\\out', 'must be relative'], ['/src', 'must be relative'], ['~/notes', 'must be relative'],
  ['../out', 'is outside'], ['src/..', 'is the whole'], ['.', 'is the whole']];

test('FS-56 a bad write_paths in task_create gives the two-line result; the TaskBoard is unchanged',
  async () => {
    const { team, user } = await setup(MERGED);
    await team.setMode('on');
    team.write((board) => B.submitRequest(board, { title: 'Login page is blank', goal: 'Fix it', acceptance: null,
      quote: null }, { message: 'fix the login page', history: [] }, Date.now()));
    const correct = `Correct form: ${quote14('task_create {"request":1')}`;
    for (const [path, start] of BAD_PATHS) {
      const result = await callTool(user, 'task_create', { request: 1, title: 'Find and fix', description: 'Fix it',
        assignee: 'mori', limits: { write: true, writePaths: [path] } });
      assert.equal(result.isError, true, path);
      assert.equal(result.content[0].text, `${limitsReason(start, path)}\n${correct}`);
    }
    assert.deepEqual(team.board.tasks, [], 'no task was created');
  });

test('FS-56 agent_message with bad limits is refused before routing in off mode: no instance, not counted',
  async () => {
    const { team, host, user } = await setup();
    startUserRun(team, user);
    const nextAsk = team.board.nextAsk;
    const targets = ['reviewer', 'T1', 'nobody', 'reviewer', 'reviewer', 'reviewer', 'reviewer'];
    for (const to of targets) {
      const result = await callTool(user, 'agent_message', { to, text: 'Is a.ts safe?',
        limits: { write_paths: ['../out'] } });
      assert.equal(result.isError, true, to);
      assert.equal(result.content[0].text, `${limitsReason('is outside', '../out')}\n${MESSAGE_USAGE}`, to);
    }
    assert.equal(team.user.sentThisTurn, 0, 'not counted toward the per-turn limit');
    assert.equal(team.board.nextAsk, nextAsk);
    assert.equal(host.deliveries.some((item) => item.id.startsWith('U.ask.')), false, 'no instance was opened');
    await askAndAnswer(host, user, { to: 'reviewer', text: 'Is a.ts safe?' }, `U.ask.${nextAsk}.reviewer`);
    endUserRun(team);
  });

test('FS-56 agent_message with bad limits in team mode is refused and not counted toward the pair limit', async () => {
  const { team, host, user } = await setup();
  await team.setMode('on');
  startUserRun(team, user);
  for (let i = 0; i <= R.MESSAGE_PAIR_CAP; i += 1) {
    const result = await callTool(user, 'agent_message', { to: 'reviewer', text: 'What changed?',
      limits: { writePaths: ['.'] } });
    assert.equal(result.isError, true, `message ${i + 1}`);
    assert.equal(result.content[0].text, `${limitsReason('is the whole', '.')}\n${MESSAGE_USAGE}`);
  }
  assert.equal(team.sent.size, 0, 'no message was counted');
  await askAndAnswer(host, user, { to: 'reviewer', text: 'What changed?' }, 'U.ask.1.reviewer');
  endUserRun(team);
});
