// 四个分节、分发表与会话打开时的快照的单元测试（docs/specs/memory.md §5、MEM-02、MEM-03、MEM-04）：
// memoryAssemble.ts 的身份 → 种类，memoryText.ts 的分节文字，以及 mori-memory 的 before_agent_start 处理器（真实的
// memorySetup 与 memoryExtension，替身扩展 API）每次运行写的身份段与分节。“补丁”用 pi 的 buildSystemPromptSections
// 与 diffSystemPromptSections 算（pi 每次运行按同样的规则比较，agent-session.js:1286-1296）。
// 协作模式的几条用真实的 Team（team.ts，TaskBoard 单元测试的会话表 teamHarness.mjs，synthetic）与 mori-memory
// 注册在同一个扩展 API 上，顺序 mori-team、mori-memory（§5.3）。记忆条目、角色文件都是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_TOOLS, PAGE, agentStart, fakePi, freshUserData, loadTextKernel, ok, piPrompt, registeredPrompt,
} from './text-helpers.mjs';
import { SPLIT, TeamModule, deps, fakeHost, roles } from '../taskboard/teamHarness.mjs';

const K = await loadTextKernel();
const ALL = ['taste', 'strategy', 'review', 'fact'];

// ---- MEM-03 分发表 ----

test('MEM-03 kindsFor gives each row of the §5.1 table, and the union for a merged session', () => {
  const kinds = (...seats) => K.assemble.kindsFor(new Set(seats));
  assert.deepEqual(kinds('main'), ALL, 'main agent: all four');
  assert.deepEqual(kinds('dialog'), ['taste'], 'dialog (split): taste only');
  assert.deepEqual(kinds('dialog', 'create'), ['taste', 'strategy', 'fact'], 'merged dialog and create');
  assert.deepEqual(kinds('create'), ['taste', 'strategy', 'fact'], 'create');
  assert.deepEqual(kinds('close'), ['review'], 'close: review only');
  assert.deepEqual(kinds('sub'), ['strategy', 'review'], 'subagent: strategy and review');
});

test('MEM-03 who runs: user sessions by mode and merged, instances by kind, agents_invalid is main', () => {
  const seats = (set) => [...set].sort();
  const { userRunSeats, instanceSeats } = K.assemble;
  assert.deepEqual(seats(userRunSeats(null, false)), ['main'], 'no Team (agents_invalid): main agent');
  assert.deepEqual(seats(userRunSeats('off', false)), ['main']);
  assert.deepEqual(seats(userRunSeats('off', true)), ['main']);
  assert.deepEqual(seats(userRunSeats('always', false)), ['dialog']);
  assert.deepEqual(seats(userRunSeats('once', false)), ['dialog']);
  assert.deepEqual(seats(userRunSeats('always', true)), ['create', 'dialog']);
  assert.deepEqual(seats(userRunSeats('once', true)), ['create', 'dialog']);
  assert.deepEqual(seats(instanceSeats('create')), ['create']);
  assert.deepEqual(seats(instanceSeats('close')), ['close']);
  for (const kind of ['task', 'ask', 'subscription']) assert.deepEqual(seats(instanceSeats(kind)), ['sub'], kind);
});

/**
 * @brief synthetic：两层四种都有一条的记忆（记忆页写入），返回工作目录。
 * @param t node:test 的测试上下文
 */
async function fullMemory(t) {
  const { cwd } = freshUserData(t, K);
  for (const kind of ALL) {
    ok(await K.memory.save(PAGE, { cwd, layer: 'user', kind, abstract: `U ${kind} (synthetic)`, detail: '',
      evidence: [] }));
    ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind, abstract: `P ${kind} (synthetic)`, detail: '',
      evidence: [] }));
  }
  return cwd;
}

/**
 * @brief 一个会话的 mori-memory（真实的 memorySetup 与 memoryExtension）在替身 API 上，seats 由测试给出。
 * @return api 与跑一次运行的函数（返回这次运行之后的选项与 pi 渲染的各段）
 */
async function memorySession(cwd, kind, seats) {
  const setup = await K.ext.memorySetup({ cwd, kind, spec: { enhance: null }, seats,
    position: () => ({ session: null, entry: null, title: 'Untitled session' }), permission: () => 'ask' });
  const api = fakePi();
  K.ext.memoryExtension(setup)(api);
  const run = (sections = {}) => {
    const event = agentStart({ cwd, selectedTools: api.getActiveTools(), sections, ...registeredPrompt(cwd) });
    api.handlers.get('before_agent_start')(event);
    return { options: event.systemPromptOptions,
      rendered: piPrompt.buildSystemPromptSections(event.systemPromptOptions) };
  };
  return { api, run, setup };
}

test('MEM-03 each identity gets exactly its row of sections', async (t) => {
  const cwd = await fullMemory(t);
  const rows = [
    ['user', K.assemble.userRunSeats('off', false), ['taste', 'strategy', 'review', 'facts']],
    ['user', K.assemble.userRunSeats(null, false), ['taste', 'strategy', 'review', 'facts']],
    ['user', K.assemble.userRunSeats('always', false), ['taste']],
    ['user', K.assemble.userRunSeats('always', true), ['taste', 'strategy', 'facts']],
    ['create', K.assemble.instanceSeats('create'), ['taste', 'strategy', 'facts']],
    ['close', K.assemble.instanceSeats('close'), ['review']],
    ['task', K.assemble.instanceSeats('task'), ['strategy', 'review']],
    ['ask', K.assemble.instanceSeats('ask'), ['strategy', 'review']],
    ['subscription', K.assemble.instanceSeats('subscription'), ['strategy', 'review']],
  ];
  for (const [kind, seats, keys] of rows) {
    const { run } = await memorySession(cwd, kind, () => seats);
    const { options } = run();
    assert.deepEqual(Object.keys(options.sections), keys, `${kind} ${[...seats].join('+')}`);
  }
});

// ---- MEM-02 四个分节 ----

test('MEM-02 memorySections: user level first, then this project, `- <abstract>` lines, null when both are empty',
  () => {
    const snapshot = {
      user: { taste: ['U1'], strategy: [], review: ['UR'], fact: ['UF'] },
      project: { taste: ['P1', 'P2'], strategy: ['PS'], review: [], fact: [] },
    };
    const sections = K.text.memorySections(snapshot, ALL);
    assert.deepEqual(Object.entries(sections), [['taste', '- U1\n- P1\n- P2'], ['strategy', '- PS'],
      ['review', '- UR'], ['facts', '- UF']]);
    const empty = K.text.memorySections({ user: { taste: [], strategy: [], review: [], fact: [] },
      project: { taste: [], strategy: ['PS'], review: [], fact: [] } }, ['taste', 'strategy']);
    assert.deepEqual(empty, { taste: null, strategy: '- PS', review: null, facts: null },
      'a kind with no entries, or not taken by this identity, is null (the key is deleted)');
  });

test('MEM-02 the handler writes the sections after mori_team and cwd, deletes empty ones, leaves out broken entries',
  async (t) => {
    const { cwd, memoryRoot } = freshUserData(t, K);
    const add = async (layer, kind, abstract) => ok(await K.memory.save(PAGE, { cwd, layer, kind, abstract,
      detail: '', evidence: [] }));
    await add('user', 'taste', 'Answer with the conclusion first (synthetic)');
    await add('project', 'taste', 'Keep replies short (synthetic)');
    await add('project', 'taste', 'Use Chinese in commit notes (synthetic)');
    await add('project', 'strategy', 'Plan before changing more than three modules (synthetic)');
    await add('user', 'fact', 'The user is in UTC+8 (synthetic)');
    // synthetic：索引里有、entries 里没有的一条，和一条解析不了的 detail
    appendFileSync(join(memoryRoot, 'user', 'TASTE.md'), '- [BROKEN-MISSING (synthetic)](entries/gone.md)\n');
    appendFileSync(join(memoryRoot, 'user', 'TASTE.md'), '- [BROKEN-BAD (synthetic)](entries/bad.md)\n');
    writeFileSync(join(memoryRoot, 'user', 'entries', 'bad.md'), 'not a detail file\n');
    const { run } = await memorySession(cwd, 'user', () => K.assemble.userRunSeats('off', false));
    const event = agentStart({ cwd, sections: { mori_team: 'TEAM (synthetic)', review: 'stale (synthetic)' },
      appendSystemPrompt: 'ADDENDUM (synthetic)', contextFiles: [{ path: 'AGENTS.md', content: 'AGENTS (synthetic)' }],
      ...registeredPrompt(cwd) });
    const first = run();
    assert.deepEqual(first.options.sections, {
      taste: '- Answer with the conclusion first (synthetic)\n- Keep replies short (synthetic)\n'
        + '- Use Chinese in commit notes (synthetic)',
      strategy: '- Plan before changing more than three modules (synthetic)',
      facts: '- The user is in UTC+8 (synthetic)',
    });
    assert.doesNotMatch(JSON.stringify(first.rendered), /BROKEN/, 'unreadable entries are not in the prompt');
    const { api } = await memorySession(cwd, 'user', () => K.assemble.userRunSeats('off', false));
    api.handlers.get('before_agent_start')(event);
    const options = event.systemPromptOptions;
    assert.deepEqual(Object.keys(options.sections), ['mori_team', 'taste', 'strategy', 'facts'],
      'mori_team first, then taste, strategy, facts; the stale review key is deleted');
    const rendered = piPrompt.buildSystemPromptSections(options);
    assert.deepEqual(Object.keys(rendered), ['preamble', 'addendum', 'project_context', 'cwd', 'mori_team', 'taste',
      'strategy', 'facts']);
    assert.equal(rendered.strategy,
      '<strategy>\n- Plan before changing more than three modules (synthetic)\n</strategy>');
  });

test('MEM-02 two runs in a row write the same sections, so pi records no patch', async (t) => {
  const cwd = await fullMemory(t);
  const { run } = await memorySession(cwd, 'user', () => K.assemble.userRunSeats('off', false));
  const first = run().rendered;
  const second = run().rendered;
  assert.equal(piPrompt.diffSystemPromptSections(first, second), undefined);
  assert.deepEqual(Object.keys(first).slice(-4), ['taste', 'strategy', 'review', 'facts']);
});

// ---- MEM-04 会话打开时定下 ----

test('MEM-04 an entry added after the session opened is not in its prompt; a new or reopened session has it',
  async (t) => {
    const cwd = await fullMemory(t);
    const seats = () => K.assemble.userRunSeats('off', false);
    const open = await memorySession(cwd, 'user', seats);
    ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'LATER (synthetic)', detail: '',
      evidence: [] }));
    assert.doesNotMatch(open.run().options.sections.taste, /LATER/, 'the open session keeps its snapshot');
    const reopened = await memorySession(cwd, 'user', seats);
    assert.match(reopened.run().options.sections.taste, /- LATER \(synthetic\)$/, 'a new session reads it');
    assert.match(open.run().options.sections.taste, /- P taste \(synthetic\)$/);
  });

test('MEM-04 a mode change gives exactly one section patch, still from the snapshot taken at open', async (t) => {
  const cwd = await fullMemory(t);
  let mode = 'off';
  const { run } = await memorySession(cwd, 'user', () => K.assemble.userRunSeats(mode, false));
  const off = run().rendered;
  ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'LATER (synthetic)', detail: '',
    evidence: [] }));
  mode = 'always';
  const team = run().rendered;
  const patch = piPrompt.diffSystemPromptSections(off, team);
  assert.deepEqual(patch, { strategy: null, review: null, facts: null }, 'one patch: three sections removed');
  assert.equal(team.taste, off.taste, 'taste is still the snapshot (no LATER)');
  assert.equal(piPrompt.diffSystemPromptSections(team, run().rendered), undefined, 'the next run: no patch');
  mode = 'off';
  const back = run().rendered;
  assert.deepEqual(piPrompt.diffSystemPromptSections(team, back), { strategy: off.strategy, review: off.review,
    facts: off.facts });
});

// ---- 与 Team 一起（§4.2、§5.3、§7.6） ----

/** synthetic：一个已保存的用户会话文件：头与一条 mori.team（进入协作模式时写的，带关闭模式的工具） */
function savedSession(cwd, mode) {
  const file = join(cwd, '..', 'sessions', 'saved-team.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const at = '2026-10-22T01:00:00.000Z';
  const lines = [{ type: 'session', version: 3, id: 'saved', timestamp: at, cwd },
    { type: 'custom', customType: 'mori.team', id: 't1', parentId: null, timestamp: at,
      data: { mode, tools: [...DEFAULT_TOOLS, 'memory'] } }];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

/**
 * @brief synthetic：用户会话的 Team 与 mori-memory 在同一个扩展 API 上（mori-team 在前），pi 建会话时启用 memory。
 * @param t node:test 的测试上下文
 * @param load 角色
 * @param savedMode 重新打开一个已保存的会话：会话文件里最后一条 mori.team 的模式（synthetic）；新会话省略
 */
async function teamSession(t, load, savedMode = null) {
  const { cwd } = freshUserData(t, K);
  ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'strategy', abstract: 'S (synthetic)', detail: '',
    evidence: [] }));
  const host = fakeHost({ profile: null });
  const userSessionFile = savedMode === null ? null : savedSession(cwd, savedMode);
  const team = TeamModule.createTeam(host, { userSessionId: 'U', cwd, roles: load, teamDir: join(cwd, 'teams', 'U'),
    baseTools: DEFAULT_TOOLS, trust: {}, approval: {}, restored: savedMode !== null, userSessionFile,
    enhance: null });
  const user = host.newEntry('U', cwd, null);
  user.spec = { onEvent: (event) => team.onUserEvent(event), model: {} };
  const api = fakePi();
  user.api = api;
  team.userExtension()(api);
  const setup = await K.ext.memorySetup({ cwd, kind: 'user', spec: { enhance: null },
    seats: () => K.assemble.userRunSeats(team.mode, team.merged),
    position: () => ({ session: null, entry: null, title: 'Untitled session' }), permission: () => 'ask' });
  K.ext.memoryExtension(setup)(api);
  api.setActiveTools([...api.getActiveTools(), 'memory']);
  await team.attachUser({ sessionId: 'U', session: user.session, model: user.model });
  /** 一次运行：pi 先拷选项（selectedTools 是此刻启用的），再按顺序调处理器；返回选项、各段、请求的 tools */
  const run = () => {
    const prompt = registeredPrompt(cwd, [...api.tools.values()]);
    const event = agentStart({ cwd, selectedTools: api.getActiveTools(), ...prompt });
    api.handlers.get('before_agent_start')(event);
    team.onUserEvent({ type: 'agent_start' });
    team.onUserEvent({ type: 'agent_settled' });
    const options = event.systemPromptOptions;
    return { options, rendered: piPrompt.buildSystemPromptSections(options), requestTools: api.getActiveTools(),
      snippets: prompt.toolSnippets };
  };
  return { team, api, run, cwd };
}

/** @brief <tools> 列出的工具名与请求的 tools 参数一致（有说明的那些，按启用的顺序）；没有 bash 时没有 shell 规则。 */
function assertToolsMatch(result, label) {
  const listed = [...result.options.customPrompt.matchAll(/^- (\w+): /gm)].map((match) => match[1])
    .filter((name) => result.snippets[name]);
  assert.deepEqual(listed, result.requestTools.filter((name) => result.snippets[name]), `${label}: <tools>`);
  if (!result.requestTools.includes('bash')) {
    assert.doesNotMatch(result.options.customPrompt, /for file operations/, `${label}: no shell rule without bash`);
  } else {
    assert.match(result.options.customPrompt, /^- Use bash for file operations like ls, rg, find$/m, label);
  }
}

test('MEM-02 MEM-04 team mode on and off: <tools> follows the tools mori-team set, one patch per switch', async (t) => {
  const { team, run } = await teamSession(t, SPLIT);
  const off = run();
  assertToolsMatch(off, 'off');
  assert.ok(off.requestTools.includes('bash'));
  assert.equal(piPrompt.diffSystemPromptSections(off.rendered, run().rendered), undefined, 'off twice: no patch');
  await team.setMode('on');
  const on = run();
  assertToolsMatch(on, 'team mode (split)');
  assert.ok(!on.requestTools.includes('bash'), 'the split dialog only relays');
  assert.deepEqual(Object.keys(on.options.sections), ['mori_team'], 'the split dialog: taste only, and none exists');
  const patch = piPrompt.diffSystemPromptSections(off.rendered, on.rendered);
  assert.ok(patch.preamble, 'the identity section changes with the tools');
  assert.equal(patch.strategy, null, 'the split dialog has no strategy');
  assert.equal(piPrompt.diffSystemPromptSections(on.rendered, run().rendered), undefined, 'team mode twice: no patch');
  await team.setMode('off');
  const back = run();
  assertToolsMatch(back, 'off again');
  assert.equal(back.options.sections.strategy, '- S (synthetic)', 'still the snapshot');
  assert.equal(piPrompt.diffSystemPromptSections(back.rendered, run().rendered), undefined);
});

test('MEM-02 off mode with chat.md tools: [read]: <tools> matches the request tools and <rules> has no shell rule',
  async (t) => {
    const load = roles.parseRoleFiles([
      { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n'
        + 'tools: [read]\n---\n' },
      { file: '.mori/agents/planner.md',
        text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
    ], deps);
    assert.deepEqual(load.problems, []);
    const { run } = await teamSession(t, load);
    const first = run();
    assertToolsMatch(first, 'chat tools: [read]');
    assert.deepEqual([...first.requestTools].sort(), ['agent_message', 'memory', 'read']);
    assert.equal(piPrompt.diffSystemPromptSections(first.rendered, run().rendered), undefined, 'no patch next run');
  });

test('MEM-02 a merged session in team mode: <tools> matches, sections taste, strategy, facts', async (t) => {
  const { team, run } = await teamSession(t, roles.parseRoleFiles([], deps));
  await team.setMode('on');
  const merged = run();
  assertToolsMatch(merged, 'merged');
  assert.ok(merged.requestTools.includes('memory'));
  assert.deepEqual(Object.keys(merged.options.sections).filter((key) => key !== 'mori_team'), ['strategy']);
});

test('MEM-02 a reopened team-mode session: the first run lists the tools mori-team set, the second has no patch',
  async (t) => {
    const { team, run } = await teamSession(t, SPLIT, 'always');
    assert.equal(team.mode, 'always', 'the saved mode is restored');
    const first = run();
    assertToolsMatch(first, 'reopened in team mode');
    assert.ok(!first.requestTools.includes('memory') && !first.requestTools.includes('bash'), 'the split dialog');
    assert.deepEqual(Object.keys(first.options.sections), ['mori_team'], 'split dialog: taste only, none exists');
    assert.equal(piPrompt.diffSystemPromptSections(first.rendered, run().rendered), undefined);
  });
