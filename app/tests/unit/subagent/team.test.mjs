// 普通模式的 subagent 工具在 Team 里怎么跑（docs/specs/subagent.md §2、§4、§5、§6.3、§7.4、§7.6、§8.1、§9.1）的单元测试：
// 用 TaskBoard 测试的会话表替身（teamHarness.mjs：内存里的 pi SessionManager，运行由测试一步步发出 pi 事件）驱动 Team，
// 检查什么时候有这个工具、拒绝的调用不开实例、全部同时投递、实例的工具与 system prompt 附加段、调度类别、候选来源、
// 结果与进展、带归属的批准卡、停止、右栏的 teamEdited。不连模型，也不起 Electron。角色文件是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  SPLIT, TeamModule, beginRun, deps, fakeHost, finishRun, nextDelivery, roles, runDelivery, setup, until,
} from '../taskboard/teamHarness.mjs';

/** 内核模块（subagent 的工具白名单） */
const load = { subagent: await loadKernelModule('src/kernel/subagent.ts') };

/** 只有基座（没有角色文件）。 */
const BASE = roles.parseRoleFiles([], deps);
/** chat 持有对话、只写了 read；reviewer 有正文和 models（synthetic）。 */
const TOOLED = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\ntools: [read]\n---\n' },
  { file: '.mori/agents/reviewer.md',
    text: '---\nname: reviewer\ndescription: Reviews code\ntools: [read, bash]\nmodels: [fast]\n---\nMORI-ROLE-reviewer' },
], deps);

/** @brief 用户会话开始一次关闭模式（或此刻的模式）的运行：before_agent_start 与 agent_start。 */
function startUserRun(team, user) {
  user.running = true;
  user.api.handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  team.onUserEvent({ type: 'agent_start' });
}

/**
 * @brief 主 Agent 调一次 subagent（经它的 prepareArguments）。
 * @param user 用户会话
 * @param args 参数
 * @param options signal：中止信号；updates：收 onUpdate 的数组
 */
function callSubagent(user, args, { signal, updates } = {}) {
  const tool = user.api.tools.get('subagent');
  return tool.execute('sa-1', tool.prepareArguments(args), signal, updates ? (update) => updates.push(update)
    : undefined, {});
}

/** @brief 一项（synthetic）。 */
const task = (description, over = {}) => ({ description, prompt: `${description}: read src and report.`, ...over });

/** @brief 等 n 个 subagent 的投递。 */
function askDeliveries(host, n) {
  return until(() => {
    const found = host.deliveries.filter((item) => item.id.includes('.ask.'));
    return found.length >= n ? found : null;
  }, `${n} subagent deliveries`);
}

// ---- SA-01 什么时候有 ----

test('SA-01 the user session always registers subagent; off-mode runs enable it, with or without role files',
  async () => {
    for (const load of [BASE, SPLIT, TOOLED]) {
      const { team, user } = await setup(load);
      const def = user.api.tools.get('subagent');
      assert.ok(def, 'registered at load');
      assert.equal(def.defaultActive, false);
      assert.equal(def.label, 'Subagent');
      startUserRun(team, user);
      assert.ok(user.api.getActiveTools().includes('subagent'), 'enabled in the off-mode run');
      assert.equal(user.api.getActiveTools().includes('agent_message'), load !== BASE,
        'agent_message stays when other roles exist');
      const guard = user.api.handlers.get('tool_call')?.({ type: 'tool_call', toolName: 'subagent', input: {} });
      assert.equal(guard, undefined, 'not refused in off mode, even when the dialog holder wrote tools: [read]');
    }
  });

test('SA-01 Task mode runs neither enable nor allow subagent; instances and enhance sessions do not have it',
  async () => {
    const { team, user, host } = await setup(SPLIT);
    await team.setMode('on');
    startUserRun(team, user);
    assert.ok(!user.api.getActiveTools().includes('subagent'));
    const guard = user.api.handlers.get('tool_call')({ type: 'tool_call', toolName: 'subagent', input: {} });
    assert.equal(guard.block, true, 'refused by the tool_call guard if it is enabled during the run');
    const solo = await setup(BASE);
    startUserRun(solo.team, solo.user);
    const pending = callSubagent(solo.user, { tasks: [task('Map the loop', { read_only: true })] });
    const [delivery] = await askDeliveries(solo.host, 1);
    const entry = solo.host.entry(delivery.id);
    assert.ok(!entry.api.tools.has('subagent') && !entry.spec.tools.includes('subagent'), 'a subagent has none');
    await runDelivery(solo.host, delivery, [{ text: 'Done.' }]);
    await pending;
    const enhanceHost = fakeHost({ profile: null });
    const enhance = TeamModule.createTeam(enhanceHost, { userSessionId: 'E', cwd: solo.cwd, roles: BASE,
      teamDir: join(solo.cwd, 'teams', 'E'), baseTools: ['read', 'bash', 'edit', 'write'], trust: {}, approval: {},
      restored: false, userSessionFile: null, enhance: { task: 'strategy', run: {}, scope: {} } });
    const entryE = enhanceHost.newEntry('E', solo.cwd, null);
    enhance.userExtension()(entryE.api);
    assert.ok(!entryE.api.tools.has('subagent'), 'the daily enhancement session has no subagent');
    void host;
  });

test('SA-01 the merged session in Task mode (the base holds dialog, create and close) neither enables nor allows '
  + 'subagent; create, close, task and ask instances never have it', async () => {
  const { team, user } = await setup(BASE);
  await team.setMode('on');
  startUserRun(team, user);
  assert.ok(user.api.tools.has('subagent'), 'still registered (off-mode runs enable it again)');
  assert.ok(!user.api.getActiveTools().includes('subagent'), `active: ${user.api.getActiveTools().join(', ')}`);
  const guard = user.api.handlers.get('tool_call')({ type: 'tool_call', toolName: 'subagent', input: {} });
  assert.equal(guard?.block, true, 'refused by the tool_call guard if it is enabled during the run');
  const base = roles.findRole(BASE.roles, 'mori');
  for (const [kind, readOnly] of [['create', false], ['close', false], ['task', false], ['task', true], ['ask', true]]) {
    const tools = roles.toolAllowlist(base, kind, readOnly, ['read', 'bash', 'edit', 'write'], true);
    assert.ok(!tools.includes('subagent'), `${kind}${readOnly ? ' (read-only)' : ''}: ${tools.join(', ')}`);
  }
});

// ---- SA-03 检查；SA-04 同时运行；SA-06 调度类别 ----

test('SA-03 a refused call opens no instance and writes nothing under teams/; six and then three more all start',
  async () => {
    const { team, user, host, cwd } = await setup(BASE);
    startUserRun(team, user);
    const refused = await callSubagent(user, { tasks: [] });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, 'tasks needs at least one entry.\nCorrect form: subagent '
      + '{"tasks":[{"description":"Map the capture loop","prompt":"<the whole task>","read_only":true}]}');
    assert.equal(refused.details, undefined, 'no details: the card shows the refusal');
    const role = await callSubagent(user, { tasks: [task('Map', { role: 'reviewer' })] });
    assert.match(role.content[0].text, /^Only mori runs here; leave role out\.\n/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(host.deliveries.length, 0);
    assert.ok(![...host.entries.keys()].some((id) => id.includes('.ask.')));
    assert.equal(existsSync(join(cwd, 'teams', 'U', 'board.json')), false);
    const six = callSubagent(user, { tasks: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => task(`Part ${name}`)) });
    const three = callSubagent(user, { tasks: ['g', 'h', 'i'].map((name) => task(`Part ${name}`)) });
    const deliveries = await askDeliveries(host, 9);
    assert.deepEqual(deliveries.map((item) => item.id).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      Array.from({ length: 9 }, (_, i) => `U.ask.${i + 1}.mori`), 'nine instances, numbered from nextAsk');
    for (const delivery of deliveries) await runDelivery(host, delivery, [{ text: `Reply ${delivery.id}` }]);
    assert.equal((await six).isError, undefined);
    assert.equal((await three).content[0].text.split('\n### ').length, 4);
  });

test('SA-04 all subagents are delivered before any of them ends; results come back in argument order', async () => {
  const { team, user, host } = await setup(BASE);
  startUserRun(team, user);
  const pending = callSubagent(user, { tasks: [task('First'), task('Second'), task('Third')] });
  const deliveries = await askDeliveries(host, 3);
  assert.equal(host.deliveries.length, 3, 'three at once, none waits for another');
  for (const delivery of deliveries) {
    const spec = host.entry(delivery.id).spec;
    assert.deepEqual(spec.instance, { kind: 'ask', role: 'mori' });
    assert.equal(spec.kind, 'ask');
    assert.equal(spec.model.schedClass, 'subagent', 'SA-06: the subagent scheduling class');
  }
  for (const delivery of [...deliveries].reverse()) {
    await runDelivery(host, delivery, [{ text: `Answer from ${delivery.id}` }]);
  }
  const result = await pending;
  assert.match(result.content[0].text, /### 1\. First · Mori · done\nAnswer from U\.ask\.1\.mori\n\n### 2\. Second/);
  assert.deepEqual(result.details.agents.map((row) => row.phase), ['done', 'done', 'done']);
  await until(() => ![...host.entries.keys()].some((id) => id.includes('.ask.')), 'the instances to close');
  assert.equal(team.teamState().background, false, 'subagents never count as background (no Stop agents)');
});

// ---- SA-05 工具；SA-08 system prompt 与投递 ----

test('SA-05 SA-08 read-only and general subagents: their tools, the role body and segment, the delivery, no card',
  async () => {
    const { team, user, host } = await setup(TOOLED);
    startUserRun(team, user);
    const pending = callSubagent(user, { tasks: [task('Read only', { read_only: true }), task('General'),
      task('Reviewer general', { role: 'reviewer' }), task('Reviewer reads', { role: 'reviewer', read_only: true })] });
    const deliveries = await askDeliveries(host, 4);
    const specs = deliveries.map((item) => host.entry(item.id).spec);
    assert.deepEqual(specs.map((spec) => spec.tools), [['read', 'ls'], ['read', 'bash', 'edit', 'write', 'mcp__*'],
      ['read', 'bash'], ['read', 'ls']]);
    const S = load.subagent;
    assert.deepEqual(specs[0].appendPrompt, [S.subagentSegment(true)], 'the base has no body; no shared segment');
    assert.deepEqual(specs[1].appendPrompt, [S.subagentSegment(false)]);
    assert.deepEqual(specs[2].appendPrompt, ['MORI-ROLE-reviewer', S.subagentSegment(false)]);
    assert.deepEqual(specs[3].appendPrompt, ['MORI-ROLE-reviewer', S.subagentSegment(true)]);
    assert.equal(deliveries[0].text, '[Mori] Task from the main agent:\nRead only: read src and report.');
    for (const delivery of deliveries) {
      const context = host.entry(delivery.id).api.handlers.get('context');
      assert.equal(context?.({ messages: [] }), undefined, 'no work card at the end of the request');
    }
    for (const delivery of deliveries) await runDelivery(host, delivery, [{ text: 'ok' }]);
    await pending;
  });

// ---- SA-07 候选与角色 ----

test('SA-07 candidates: the session range for the base, the role models within the dialog range; an empty '
  + 'intersection fails only that subagent', async () => {
  const { team, user, host, state } = await setup(TOOLED);
  startUserRun(team, user);
  const pending = callSubagent(user, { tasks: [task('Base'), task('Reviewer', { role: 'reviewer' })] });
  const [base, reviewer] = await askDeliveries(host, 2);
  const baseSource = host.entry(base.id).spec.model.source;
  const reviewerSource = host.entry(reviewer.id).spec.model.source;
  assert.deepEqual(baseSource.models, ['strong'], "the base uses the session's range");
  assert.deepEqual(reviewerSource.models, ['fast'], "the role's models, in its order");
  assert.equal(typeof reviewerSource.within, 'function', 'kept within the dialog candidates');
  state.outside = ['fast/m1'];
  host.entry(reviewer.id).spec.model.onUnavailable({ firstRequest: true, candidates: [] });
  reviewer.resolve();
  await runDelivery(host, base, [{ text: 'Base is fine.' }]);
  const result = await pending;
  assert.equal(result.isError, undefined, 'one failure does not fail the call');
  assert.deepEqual(result.details.agents.map((row) => row.phase), ['done', 'failed']);
  assert.equal(result.details.agents[1].error,
    'No model in your range fits reviewer: fast/m1 — not in the range you chose for the dialog');
});

// ---- SA-09 结果与进展 ----

test('SA-09 progress goes through onUpdate as "<d> of <n> done" with details; all failed makes the result an error',
  async () => {
    const { team, user, host } = await setup(BASE);
    startUserRun(team, user);
    const updates = [];
    const pending = callSubagent(user, { tasks: [task('One'), task('Two')] }, { updates });
    const [one, two] = await askDeliveries(host, 2);
    assert.equal(updates[0].content[0].text, '0 of 2 done');
    assert.deepEqual(updates[0].details.agents.map((row) => row.phase), ['starting', 'starting']);
    await beginRun(host, one);
    await finishRun(host, one, [{ calls: [{ name: 'read', args: { path: 'src/a.ts' } }] }, { text: 'Read it.' }]);
    await until(() => updates.at(-1).details.agents[0].phase === 'done', 'the first to end');
    assert.equal(updates.at(-1).content[0].text, '1 of 2 done');
    assert.equal(updates.at(-1).details.agents[0].toolUses, 1);
    await runDelivery(host, two, [{ text: '' }]);
    const result = await pending;
    assert.match(result.content[0].text, /### 1\. One · Mori · done · 1 tool use\nRead it\./);
    assert.match(result.content[0].text, /### 2\. Two · Mori · done\n\(no reply\)$/);
    startUserRun(team, user);
    const failing = callSubagent(user, { tasks: [task('Three')] });
    const three = (await askDeliveries(host, 3))[2];
    host.entry(three.id).spec.model.onUnavailable({ firstRequest: true, candidates: [{ ref: 'a/m', detail: 'no key' }] });
    three.resolve();
    const failed = await failing;
    assert.equal(failed.isError, true, 'every subagent failed');
    assert.match(failed.content[0].text, /^Subagent results .*\n\n### 1\. Three · Mori · failed\nNo model in your range/);
  });

test('SA-06 a row\'s note follows the model layer: Waiting for <provider> while queued (cleared when the slot is '
  + 'taken), Switched model, Waiting for a model; a started tool call clears it', () => {
  const S = load.subagent;
  const row = { description: 'd', role: 'mori', readOnly: false, prompt: 'p', phase: 'starting', toolUses: 0,
    current: null, note: null, reply: null, error: null };
  let changes = 0;
  const slot = { row, changed: () => { changes += 1; } };
  S.noteSubagentModel(slot, { type: 'mori.model_queue', active: true, provider: 'p', providerName: 'DeepSeek' });
  assert.equal(row.note, 'Waiting for DeepSeek');
  S.noteSubagentModel(slot, { type: 'mori.model_queue', active: false, provider: 'p', providerName: 'DeepSeek' });
  assert.equal(row.note, null, 'the slot was taken');
  S.noteSubagentModel(slot, { type: 'mori.model_switch', from: 'a/m', to: 'b/m', reason: 'rate_limited', detail: '' });
  assert.match(row.note, /^Switched model: a\/m → b\/m · /);
  S.noteSubagentTool(slot, { toolName: 'read', args: { path: 'a.ts' } });
  assert.equal(row.note, null, 'a tool call clears the note');
  assert.equal(row.phase, 'running');
  assert.equal(row.toolUses, 1);
  assert.equal(changes, 4);
});

// ---- SA-12 批准 ----

test('SA-12 a general subagent asking for approval: the card carries its description; its row waits', async () => {
  const { team, user, host } = await setup(BASE);
  startUserRun(team, user);
  const updates = [];
  const pending = callSubagent(user, { tasks: [task('Fix the retry loop')] }, { updates });
  const [delivery] = await askDeliveries(host, 1);
  const spec = host.entry(delivery.id).spec;
  await beginRun(host, delivery);
  spec.onEvent({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'npm test' } });
  spec.onApprovalRequest({ requestId: `${delivery.id}:approval-1`, instance: delivery.id, toolCallId: 'b1',
    toolName: 'bash', args: { command: 'npm test' } });
  const card = host.events.find((event) => event.type === 'mori.team_approval_request');
  assert.equal(card.subagent, 'Fix the retry loop');
  assert.equal(card.role, 'mori');
  assert.equal(card.task, null);
  assert.equal(team.live().teamApproval, true, 'the sidebar shows waiting for your approval');
  await until(() => updates.at(-1).details.agents[0].phase === 'approval', 'the row to wait');
  spec.onApprovalEnd({ requestId: `${delivery.id}:approval-1`, decision: 'allow', by: 'user', reason: null });
  await until(() => updates.at(-1).details.agents[0].phase === 'running', 'the row to run again');
  await finishRun(host, delivery, [{ text: 'Fixed.' }]);
  await pending;
});

// ---- SA-13 停止 ----

test('SA-13 stopping the reply stops every subagent (reason dialog); their rows and results are stopped', async () => {
  const { team, user, host } = await setup(BASE);
  startUserRun(team, user);
  const controller = new AbortController();
  const pending = callSubagent(user, { tasks: [task('Long one'), task('Long two')] }, { signal: controller.signal });
  const [one, two] = await askDeliveries(host, 2);
  await beginRun(host, one);
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.deepEqual(result.details.agents.map((row) => [row.phase, row.error]),
    [['stopped', 'Stopped by the user.'], ['stopped', 'Stopped by the user.']]);
  assert.match(result.content[0].text, /### 1\. Long one · Mori · stopped\nStopped by the user\./);
  await until(() => host.aborts.length >= 2, 'both to be stopped');
  assert.deepEqual(host.aborts.map((item) => [item.id, item.reason]), [[one.id, 'dialog'], [two.id, 'dialog']]);
  assert.equal(team.teamState().background, false);
  await finishRun(host, one, []);
  two.resolve();
});

// ---- SA-15 右栏 ----

test('SA-15 a successful edit by a general subagent sets teamEdited; a read-only one never does', async () => {
  const { team, user, host } = await setup(BASE);
  startUserRun(team, user);
  const pending = callSubagent(user, { tasks: [task('Look', { read_only: true })] });
  const [look] = await askDeliveries(host, 1);
  await runDelivery(host, look, [{ calls: [{ name: 'read', args: { path: 'a.ts' } }] }, { text: 'Seen.' }]);
  await pending;
  assert.equal(team.teamEdited, false);
  startUserRun(team, user);
  const editing = callSubagent(user, { tasks: [task('Change')] });
  const change = (await askDeliveries(host, 2))[1];
  await runDelivery(host, change, [{ calls: [{ name: 'edit', args: { path: 'a.ts' } }] }, { text: 'Changed.' }]);
  await editing;
  assert.equal(team.teamEdited, true);
  await until(() => team.view().teamEdited === true, 'the board view');
});

// ---------- WP-10 合并之后才通过的两条（walkthrough-fixes 会话 2026-10-26：测试先写，照常运行） ----------

test('SA-05 read-only subagents get their tools through the same function as Task mode\'s read-only instances: '
  + 'the read class of the base tools plus ls', () => {
  const base = roles.findRole(BASE.roles, 'mori');
  const reviewer = roles.findRole(TOOLED.roles, 'reviewer');
  const S = load.subagent;
  for (const role of [base, reviewer]) {
    const own = roles.toolAllowlist(role, 'task', true, ['read', 'bash', 'edit', 'write'], true)
      .filter((name) => !['board_read', 'read_session', 'agent_message', 'task_handoff'].includes(name));
    assert.deepEqual(S.subagentTools(role, true, ['read', 'bash', 'edit', 'write']), own,
      `${role.name}: the subagent's read-only tools equal the read-only task instance's own tools`);
    assert.ok(own.includes('ls'), `${role.name}: a read-only instance always has ls (WP-10)`);
  }
});

test('TB-04 off mode: the ask instance opened by agent_message has the role body and the ask segment but no '
  + 'TaskBoard shared segment (there is no TaskBoard in off mode; subagent spec §5.1, TaskBoard spec appendix A)',
async () => {
  const { team, user, host } = await setup(SPLIT);
  startUserRun(team, user);
  const ask = user.api.tools.get('agent_message');
  const pending = ask.execute('c1', ask.prepareArguments({ to: 'executor', text: 'Is a.ts safe?' }), undefined,
    undefined, {});
  const delivery = await nextDelivery(host, 'U.ask.1.executor');
  const prompt = host.entry('U.ask.1.executor').spec.appendPrompt;
  assert.equal(prompt[0], 'MORI-ROLE-executor', 'the role body first');
  assert.ok(prompt.some((part) => part.startsWith('Another agent asked you one question.')), 'the ask segment');
  assert.ok(!prompt.some((part) => part.includes("one of several agents that work together on Mori's TaskBoard")),
    `no shared segment: ${JSON.stringify(prompt)}`);
  await runDelivery(host, delivery, [{ text: 'Yes.' }]);
  await pending;
});
