// 实例会话没有收尾检查的单元测试（docs/specs/finish-check.md §4.2；FC-02 的单元部分）：team.ts 的 instanceSpec 给
// 立项、task、结案、临时提问实例的记忆设置都是 check: null（增强会话的 Team 也一样），交给真实的 memorySetup 与
// memoryExtension 之后，替身扩展 API 上没有 finish，也没有 agent_before_settle、context、agent_settled 处理器。
// Team 用 TaskBoard 单元测试的会话表（taskboard/teamHarness.mjs，synthetic），角色文件与运行都是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DEFAULT_TOOLS, fakePi, freshUserData, loadTextKernel } from '../memory/text-helpers.mjs';
import {
  SPLIT, TeamModule, addTask, fakeHost, nextDelivery, runDelivery, workThen,
} from '../taskboard/teamHarness.mjs';

const K = await loadTextKernel();
const CHECK_HANDLERS = ['agent_before_settle', 'context', 'agent_settled'];

/**
 * @brief synthetic：一个用户会话的 Team（分开时的角色），用户会话的扩展 API 是 fakePi。
 * @param t node:test 的测试上下文
 * @param enhance 增强会话的 Team：这次运行（synthetic）；普通会话为 null
 */
async function teamOf(t, enhance = null) {
  const { cwd } = freshUserData(t, K);
  const host = fakeHost({ profile: null });
  const team = TeamModule.createTeam(host, { userSessionId: 'U', cwd, roles: SPLIT, teamDir: join(cwd, 'teams', 'U'),
    baseTools: DEFAULT_TOOLS, searchTools: () => [], trust: {}, approval: {}, restored: false, userSessionFile: null,
    enhance });
  const user = host.newEntry('U', cwd, null);
  user.spec = { onEvent: (event) => team.onUserEvent(event), model: {} };
  const api = fakePi();
  user.api = api;
  team.userExtension()(api);
  await team.attachUser({ sessionId: 'U', session: user.session, model: user.model });
  return { team, host, api, cwd };
}

/**
 * @brief 一个实例的记忆设置经真实的 memorySetup 与 memoryExtension：check 为 null，没有 finish 与检查的处理器。
 * @param host 会话表
 * @param id 实例 id
 * @param enhance 期望的 memory.enhance
 */
async function assertNoCheck(host, id, enhance) {
  const spec = host.entry(id).spec;
  assert.deepEqual(Object.keys(spec.memory).sort(), ['check', 'enhance'], id);
  assert.equal(spec.memory.check, null, `${id}: team.ts gives check: null`);
  assert.equal(spec.memory.enhance, enhance, `${id}: enhance`);
  const setup = await K.ext.memorySetup({ cwd: spec.cwd, kind: spec.kind, spec: spec.memory,
    seats: () => K.assemble.instanceSeats(spec.kind), position: () => ({ session: null, entry: null, title: '' }),
    permission: () => 'ask' });
  assert.equal(setup.check, null, `${id}: memorySetup gives check: null`);
  const api = fakePi();
  K.ext.memoryExtension(setup)(api);
  assert.ok(!api.tools.has('finish'), `${id}: no finish`);
  for (const name of CHECK_HANDLERS) assert.ok(!api.handlers.has(name), `${id}: no ${name} handler`);
  assert.ok(api.handlers.has('before_agent_start'), `${id}: the identity section is still written`);
}

test('FC-02 instances (ask, create, task, close) get check null from team.ts and memorySetup: no finish', async (t) => {
  const { team, host, api } = await teamOf(t);
  api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
  const ask = api.tools.get('agent_message');
  const pending = ask.execute('a1', ask.prepareArguments({ to: 'reviewer', text: 'Safe? (synthetic)' }), undefined,
    undefined, {});
  const question = await nextDelivery(host, 'U.ask.1.reviewer');
  await assertNoCheck(host, 'U.ask.1.reviewer', null);
  await runDelivery(host, question, [{ text: 'Yes.' }]);
  await pending;
  team.onUserEvent({ type: 'agent_settled' });
  await team.setMode('on');
  team.onUserPrompt({ text: 'fix the login page (synthetic)' }, undefined, undefined);
  await nextDelivery(host, 'U.create');
  await assertNoCheck(host, 'U.create', null);
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await assertNoCheck(host, 'U.t1.executor', null);
  await runDelivery(host, start, workThen('done'));
  await nextDelivery(host, 'U.close.1');
  await assertNoCheck(host, 'U.close.1', null);
});

test('FC-02 instances in an enhancement Team get check null too', async (t) => {
  const enhance = { task: 'strategy', run: { id: 'r1', cwd: 'D:\\shop', task: 'strategy', day: '2026-10-27' },
    scope: { sessions: [], instanceFiles: [], feedback: [] } };
  const { team, host } = await teamOf(t, enhance);
  await team.setMode('on');
  team.onUserPrompt({ text: 'go (synthetic)' }, undefined, undefined);
  await nextDelivery(host, 'U.create');
  await assertNoCheck(host, 'U.create', enhance);
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await assertNoCheck(host, 'U.t1.executor', enhance);
  await runDelivery(host, start, workThen('done'));
  await nextDelivery(host, 'U.close.1');
  await assertNoCheck(host, 'U.close.1', enhance);
});
