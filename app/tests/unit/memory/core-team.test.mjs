// 记忆与 Team 的交界（docs/specs/memory.md §7.6、§9.6）：协作模式分开时对话只多三个 TaskBoard 工具、不启用 memory，
// 碰文件的工具不动、由路径闸第 2 步的收窄拒绝（docs/specs/file-system-permissions.md §8.3、§8.6）；回到关闭模式时主 Agent
// 又有 memory；增强会话发出的临时提问是 background；一次运行结束到下一步排上之间 Team 仍算忙，真正空闲时才发出 busy 为假的
// mori.team_state（增强运行看它判断结束）。用平行 Agent 的测试会话表（taskboard/teamHarness.mjs，synthetic）驱动 Team，
// 路径闸用真实的 approval.ts，不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  SPLIT, TeamModule, addTask, fakeHost, nextDelivery, profile, runDelivery, setup, until,
} from '../taskboard/teamHarness.mjs';

const { ApprovalPolicy } = await loadKernelModule('src/kernel/approval.ts');

/** pi 默认启用的工具（碰文件的那一组）：模式改变不动它们（file-system-permissions.md §8.6）。 */
const OFF_SET = ['read', 'bash', 'edit', 'write'];
/** 协作模式下对话收窄的拒绝原文（file-system-permissions.md §8.3，整句） */
const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';

/** 用户会话的文件（synthetic）：只有 mori.team 条目（只有模式，不再写 tools），Team 打开时读最后一条。 */
function teamEntries(entries) {
  return entries.map((data) => JSON.stringify({ type: 'custom', customType: 'mori.team', data })).join('\n') + '\n';
}

/** 用户会话的一次运行开始（before_agent_start）。 */
function startUserRun(user) {
  user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
}

/** 测试结束后关闭 Team（等 board.json 写完）并删掉临时目录。 */
function cleanUp(t, team, cwd) {
  t.after(async () => {
    await team.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
}

/**
 * 增强会话的 Team（synthetic：同 teamHarness 的 setup，TeamArgs 带 enhance，§9.6）。
 * @param enhance 为假时是普通会话
 */
async function teamFor(enhance) {
  const host = fakeHost({ profile: profile(null) });
  const cwd = mkdtempSync(join(tmpdir(), 'mori-mem-team-'));
  // synthetic：beginRun 的句柄与依据范围，只经 Team 交给实例
  const spec = { task: 'strategy', run: { id: '20261022-040000-abcd', cwd, task: 'strategy', day: '2026-10-21' },
    scope: { sessions: [], instanceFiles: [], feedback: [] } };
  const team = TeamModule.createTeam(host, { userSessionId: 'U', cwd, roles: SPLIT,
    teamDir: join(cwd, 'teams', 'U'), baseTools: OFF_SET, trust: {}, approval: {}, restored: false,
    userSessionFile: null, enhance: enhance ? spec : null });
  const user = host.newEntry('U', cwd, null);
  user.spec = { onEvent: (event) => team.onUserEvent(event), model: {} };
  team.userExtension()(user.api);
  await team.attachUser({ sessionId: 'U', session: user.session, model: user.model });
  return { team, host, user, cwd };
}

/**
 * @brief 用户会话的路径闸（真实的 ApprovalPolicy，同 sessions.ts startUser 的 gate：narrowing 每次调用时取
 *        team.userNarrowing()）；返回对一个调用的处理结果（synthetic 的 pi 与 ctx）。没人能批（canAsk: false）：
 *        收窄失效时调用直接拒绝，断言给出可读的差异，不去出卡。
 * @param team 协作
 * @param cwd 工作路径
 */
function dialogGate(team, cwd) {
  const gate = new ApprovalPolicy({ canAsk: false }).gate({ prefix: '', send: () => undefined, cwd, kind: 'user',
    userSessionId: 'U', narrowing: () => team.userNarrowing() });
  let handler;
  gate.extension()({ on: (name, fn) => { if (name === 'tool_call') handler = fn; } });
  return (toolName, input) => handler({ type: 'tool_call', toolCallId: `c-${toolName}`, toolName, input },
    { cwd, signal: undefined });
}

test('MEM-11 split team mode adds board_read, read_session, agent_message without memory and keeps the file tools; '
  + 'the dialog’s bash is RELAY_ONLY; off mode has memory again', async (t) => {
  const prepareUser = (user, cwd) => {
    // synthetic：协作模式下存下的会话（mori.team 只有模式）；pi 建会话时启用默认工具与 defaultActive 的 memory
    writeFileSync(join(cwd, 'user.jsonl'), teamEntries([{ mode: 'always' }]));
    user.api.registerTool({ name: 'memory' });
    user.api.setActiveTools([...OFF_SET, 'memory']);
  };
  const { team, user, cwd } = await setup(SPLIT, null, { userFile: 'user.jsonl', prepareUser });
  cleanUp(t, team, cwd);
  assert.equal(team.mode, 'always', 'the saved mode is restored');
  startUserRun(user);
  team.onUserEvent({ type: 'agent_start' });
  assert.deepEqual(user.api.getActiveTools().sort(), [...OFF_SET, 'board_read', 'read_session', 'agent_message'].sort(),
    'the split dialog: the file tools stay, memory is not enabled');
  const call = dialogGate(team, cwd);
  assert.deepEqual(await call('bash', { command: 'npm test' }), { block: true, reason: RELAY_ONLY },
    'the dialog only relays: the path gate refuses its bash');
  team.onUserEvent({ type: 'agent_settled' });
  await team.setMode('off');
  startUserRun(user);
  // 普通模式另有 subagent（docs/specs/subagent.md §2，职责工具，docs/v1/walkthrough-1026-checks.md 的 U52）
  assert.deepEqual(user.api.getActiveTools().sort(), [...OFF_SET, 'agent_message', 'memory', 'subagent'].sort());
  assert.equal(team.userNarrowing(), null, 'off mode: the main agent is not narrowed');
});

test('MEM-32 a question the enhancement session asks runs as background; a normal session’s stays conversation',
  async (t) => {
    for (const [enhance, schedClass] of [[true, 'background'], [false, 'conversation']]) {
      const { team, host, user, cwd } = await teamFor(enhance);
      cleanUp(t, team, cwd);
      const ask = user.api.tools.get('agent_message');
      user.running = true;
      startUserRun(user);
      team.onUserEvent({ type: 'agent_start' });
      const pending = ask.execute('c1', ask.prepareArguments({ to: 'reviewer', text: 'Is a.ts safe?' }), undefined,
        undefined, {});
      const delivery = await nextDelivery(host, 'U.ask.1.reviewer');
      assert.equal(host.entry('U.ask.1.reviewer').spec.model.schedClass, schedClass, `enhance: ${enhance}`);
      await runDelivery(host, delivery, [{ text: 'Yes, it is safe.' }]);
      await pending;
      user.running = false;
    }
  });

test('MEM-31 the Team stays busy from the end of a run until its next step is queued, then reports the end',
  async (t) => {
    const { team, host, cwd } = await setup(SPLIT, null);
    cleanUp(t, team, cwd);
    await team.setMode('on');
    addTask(team);
    const t1 = await nextDelivery(host, 'U.t1.executor');
    // 增强运行的看法（enhanceRun.ts RunWatcher）：每收到 mori.team_state 就看 Team 是否空闲
    const states = [];
    const emit = host.emitUser;
    host.emitUser = (id, event) => {
      emit(id, event);
      if (event.type === 'mori.team_state') states.push(event.busy);
    };
    // T1 没交接就结束：程序把它交给结案（§7.4 no_handoff），board.json 写出之后才唤醒结案
    await runDelivery(host, t1, [{ text: 'I only looked around.' }]);
    const close = await nextDelivery(host, 'U.close.1');
    assert.equal(states.includes(false), false, `no idle state before close starts: ${JSON.stringify(states)}`);
    await runDelivery(host, close, [
      { calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Works.', outcome: 'close_done' } }] },
      { calls: [{ name: 'request_close', args: { request: 1, outcome: 'done', conclusion: 'Done.' } }] },
    ]);
    await runDelivery(host, await nextDelivery(host, 'U'), [{ text: 'Request 1 is done.' }]);
    await until(() => !team.busy(), 'the Team to be idle');
    await until(() => states.at(-1) === false, 'the last mori.team_state to say idle');
    assert.equal(states.indexOf(false), states.length - 1, `idle only at the end: ${JSON.stringify(states)}`);
  });
