// 谁有 memory 工具的单元测试（docs/specs/memory.md §7.2、§7.6、MEM-11；§7.5 免批准属 MEM-10）：
// memoryAssemble.ts 的 memoryCallerFor（会话建立时定下调用方），mori-memory 只在有调用方的会话里注册工具；
// team.ts 在 dialogTools 与 toolAllowlist 的结果后面追加 memory：关闭模式（基座与写了 tools 的对话角色）、合并会话有，
// 协作模式分开时的对话没有（调用被 RELAY_ONLY 拒绝），立项实例有，结案、task、临时提问、订阅没有；增强会话的 Team 里
// task 实例（含只读 task）也有。Team 用 TaskBoard 单元测试的会话表（teamHarness.mjs，synthetic），角色文件是测试写的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DEFAULT_TOOLS, fakePi, freshUserData, loadTextKernel } from './text-helpers.mjs';
import {
  B, SPLIT, TeamModule, addTask, deps, fakeHost, nextDelivery, roles, runDelivery, workThen,
} from '../taskboard/teamHarness.mjs';

const K = await loadTextKernel();
const AGENT = { kind: 'agent' };
const RELAY_ONLY = 'Team mode is on: the dialog agent only relays; the work is done in tasks.';

test('MEM-11 memoryCallerFor: user sessions always register it; create has it; close, ask, subscription do not', () => {
  const { memoryCallerFor, instanceSeats, userRunSeats } = K.assemble;
  for (const [mode, merged] of [[null, false], ['off', false], ['always', false], ['always', true]]) {
    assert.deepEqual(memoryCallerFor(userRunSeats(mode, merged), null, null), AGENT, `user session ${mode}`);
  }
  assert.deepEqual(memoryCallerFor(instanceSeats('create'), null, 'create'), AGENT);
  for (const kind of ['close', 'task', 'ask', 'subscription']) {
    assert.equal(memoryCallerFor(instanceSeats(kind), null, kind), null, kind);
  }
  const enhance = { kind: 'enhance', task: 'review' };
  assert.deepEqual(memoryCallerFor(userRunSeats(null, false), 'review', null), enhance, 'enhancement session');
  assert.deepEqual(memoryCallerFor(instanceSeats('create'), 'review', 'create'), enhance);
  assert.deepEqual(memoryCallerFor(instanceSeats('task'), 'review', 'task'), enhance, 'a task in an enhancement Team');
  for (const kind of ['close', 'ask', 'subscription']) {
    assert.equal(memoryCallerFor(instanceSeats(kind), 'review', kind), null, `${kind} in an enhancement Team`);
  }
});

test('MEM-11 mori-memory registers memory (defaultActive, no promptSnippet) only for sessions with a caller',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    for (const kind of ['user', 'create', 'close', 'task', 'ask', 'subscription']) {
      const seats = kind === 'user' ? () => K.assemble.userRunSeats(null, false)
        : () => K.assemble.instanceSeats(kind);
      const setup = await K.ext.memorySetup({ cwd, kind, spec: { enhance: null }, seats,
        position: () => ({ session: null, entry: null, title: '' }) });
      const api = fakePi();
      K.ext.memoryExtension(setup)(api);
      const tool = api.tools.get('memory');
      assert.equal(Boolean(tool), kind === 'user' || kind === 'create', kind);
      if (tool) {
        assert.equal(tool.defaultActive, true);
        assert.equal(tool.promptSnippet, undefined, 'no promptSnippet: not in the identity section');
        assert.equal(tool.promptGuidelines, undefined);
      }
    }
  });

test('MEM-10 memory is free in the approval gate (no approval card)', () => {
  assert.equal(new K.ApprovalPolicy().gateFor('memory'), 'free');
});

/**
 * @brief synthetic：一个用户会话的 Team；用户会话的扩展 API 上注册了 memory（mori-memory 注册、pi 建会话时启用它）。
 * @param t node:test 的测试上下文
 * @param load 角色
 * @param enhance 增强会话的 Team：这次运行（synthetic）；普通会话省略
 */
async function teamWith(t, load, enhance = null) {
  const { cwd } = freshUserData(t, K);
  const host = fakeHost({ profile: null });
  const team = TeamModule.createTeam(host, { userSessionId: 'U', cwd, roles: load, teamDir: join(cwd, 'teams', 'U'),
    baseTools: DEFAULT_TOOLS, trust: {}, approval: {}, restored: false, userSessionFile: null, enhance });
  const user = host.newEntry('U', cwd, null);
  user.spec = { onEvent: (event) => team.onUserEvent(event), model: {} };
  const api = fakePi();
  user.api = api;
  team.userExtension()(api);
  api.registerTool({ name: 'memory', defaultActive: true });
  api.setActiveTools([...api.getActiveTools(), 'memory']);
  await team.attachUser({ sessionId: 'U', session: user.session, model: user.model });
  /** 一次运行开始：mori-team 设好这次的工具；返回启用的工具 */
  const begin = () => {
    api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
    team.onUserEvent({ type: 'agent_start' });
    return api.getActiveTools();
  };
  const settle = () => team.onUserEvent({ type: 'agent_settled' });
  return { team, host, user, api, begin, settle, cwd };
}

/** synthetic：只有对话角色写了 tools 的角色配置 */
const CHAT_READ = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\ntools: [read]\n'
    + '---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
], deps);
assert.deepEqual(CHAT_READ.problems, []);

test('MEM-11 user session: off mode has memory (base holder and a chat role with tools), split team mode does not',
  async (t) => {
    const base = await teamWith(t, SPLIT);
    assert.ok(base.begin().includes('memory'), 'off mode, dialog held by the base: pi keeps memory on');
    base.settle();
    const chat = await teamWith(t, CHAT_READ);
    assert.deepEqual([...chat.begin()].sort(), ['agent_message', 'memory', 'read'],
      'off mode, chat.md writes tools: [read]: memory is added like agent_message');
    chat.settle();
    await chat.team.setMode('on');
    const split = chat.begin();
    assert.ok(!split.includes('memory'), 'split team mode: the dialog has no memory');
    const guard = chat.api.handlers.get('tool_call');
    assert.deepEqual(guard({ type: 'tool_call', toolName: 'memory', toolCallId: 'm1', input: {} }),
      { block: true, reason: RELAY_ONLY });
    chat.settle();
    await chat.team.setMode('off');
    assert.ok(chat.begin().includes('memory'), 'back in off mode it has memory again');
    assert.equal(chat.api.handlers.get('tool_call')({ type: 'tool_call', toolName: 'memory', toolCallId: 'm2',
      input: {} }), undefined, 'and the call is not refused');
    chat.settle();
  });

test('MEM-11 a merged session in team mode has memory (it is also create)', async (t) => {
  const solo = await teamWith(t, roles.parseRoleFiles([], deps));
  assert.equal(solo.team.merged, true);
  await solo.team.setMode('on');
  assert.ok(solo.begin().includes('memory'));
  assert.equal(solo.api.handlers.get('tool_call')({ type: 'tool_call', toolName: 'memory', toolCallId: 'm1',
    input: {} }), undefined);
  solo.settle();
});

test('MEM-11 instances (split): create has memory; task, close and ask do not', async (t) => {
  const { team, host, api, begin, settle } = await teamWith(t, SPLIT);
  begin();
  const ask = api.tools.get('agent_message');
  const pending = ask.execute('a1', ask.prepareArguments({ to: 'reviewer', text: 'Safe? (synthetic)' }), undefined,
    undefined, {});
  const question = await nextDelivery(host, 'U.ask.1.reviewer');
  assert.ok(!host.entry('U.ask.1.reviewer').spec.tools.includes('memory'), 'a question (off mode) has no memory');
  await runDelivery(host, question, [{ text: 'Yes.' }]);
  await pending;
  settle();
  await team.setMode('on');
  team.onUserPrompt({ text: 'fix the login page (synthetic)' }, undefined, undefined);
  await nextDelivery(host, 'U.create');
  const create = host.entry('U.create').spec;
  assert.equal(create.tools.at(-1), 'memory', 'the split create instance has memory, after the allowlist');
  assert.deepEqual(create.memory, { enhance: null, check: null }, 'no finish check in instances (finish-check §4.2)');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  assert.ok(!host.entry('U.t1.executor').spec.tools.includes('memory'), 'a task has no memory');
  await runDelivery(host, start, workThen('done'));
  await nextDelivery(host, 'U.close.1');
  assert.ok(!host.entry('U.close.1').spec.tools.includes('memory'), 'close has no memory');
});

test('MEM-11 instances in an enhancement Team: task (also read-only) and create have memory; close does not',
  async (t) => {
    const enhance = { task: 'strategy', run: { id: 'r1', cwd: 'D:\\shop', task: 'strategy', day: '2026-10-22' },
      scope: { sessions: [], instanceFiles: [], feedback: [] } };
    const { team, host } = await teamWith(t, SPLIT, enhance);
    await team.setMode('on');
    team.onUserPrompt({ text: 'go (synthetic)' }, undefined, undefined);
    await nextDelivery(host, 'U.create');
    assert.equal(host.entry('U.create').spec.tools.at(-1), 'memory');
    assert.equal(host.entry('U.create').spec.memory.enhance, enhance, 'instances inherit this run');
    const task = addTask(team);
    const start = await nextDelivery(host, 'U.t1.executor');
    assert.equal(host.entry('U.t1.executor').spec.tools.at(-1), 'memory', 'a task in an enhancement Team has memory');
    team.write((board) => B.createTask(board, { request: 1, title: 'Look only', description: 'Read it',
      assignee: 'reviewer', readOnly: true, dependsOn: [], }, Date.now()));
    const readOnly = await nextDelivery(host, 'U.t2.reviewer');
    assert.equal(host.entry('U.t2.reviewer').spec.tools.at(-1), 'memory', 'a read-only task has memory too');
    readOnly.resolve();
    await runDelivery(host, start, workThen('done'));
    await nextDelivery(host, 'U.close.1');
    assert.ok(!host.entry('U.close.1').spec.tools.includes('memory'), `close has no memory (${task})`);
  });
