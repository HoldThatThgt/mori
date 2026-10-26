// 记忆与 Team 的交界（docs/specs/memory.md §7.6、§9.6）：回到关闭模式时主 Agent 又有 memory（记下的工具早于记忆功能时
// 也是）；增强会话发出的临时提问是 background；一次运行结束到下一步排上之间 Team 仍算忙，真正空闲时才发出 busy 为假的
// mori.team_state（增强运行看它判断结束）。用平行 Agent 的测试会话表（taskboard/teamHarness.mjs，synthetic）驱动 Team，
// 不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPLIT, TeamModule, addTask, fakeHost, nextDelivery, profile, runDelivery, setup, until,
} from '../taskboard/teamHarness.mjs';

/** 协作模式下对话的那一组（SPLIT 的 chat：基座的读取类 + TaskBoard 的三个工具）。 */
const TEAM_SET = ['read', 'board_read', 'read_session', 'agent_message'];
/** 进入协作模式前关闭模式的那一组（记忆功能之前存下的，没有 memory）。 */
const OFF_SET = ['read', 'bash', 'edit', 'write'];

/** 用户会话的文件（synthetic）：只有 mori.team 条目，Team 打开时读最后一条。 */
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

test('MEM-11 back in off mode the main agent has memory again, also when the recorded tools predate it',
  async (t) => {
    const prepareUser = (user, cwd) => {
      // synthetic：记忆功能之前存下的会话（mori.team 的 tools 没有 memory），pi 恢复了协作模式运行的那一组
      writeFileSync(join(cwd, 'user.jsonl'), teamEntries([{ mode: 'always', tools: OFF_SET }]));
      user.api.registerTool({ name: 'memory' });
      user.api.setActiveTools(TEAM_SET);
    };
    const { team, user, cwd } = await setup(SPLIT, null, { userFile: 'user.jsonl', prepareUser });
    cleanUp(t, team, cwd);
    startUserRun(user);
    assert.deepEqual(user.api.getActiveTools(), TEAM_SET, 'the split dialog has no memory');
    await team.setMode('off');
    startUserRun(user);
    // 普通模式另有 subagent（docs/specs/subagent.md §2）
    assert.deepEqual(user.api.getActiveTools().sort(), [...OFF_SET, 'agent_message', 'memory', 'subagent'].sort());
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
