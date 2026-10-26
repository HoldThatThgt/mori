// kernel/roleCommands.ts 与 roles.ts inspectRoleFiles 的单元测试（docs/specs/customize-agents.md §4、§5）：
// 每个 agent 的候选与原因（选择器第 1–3 步）、有问题的文件、保存（新建、编辑）写出的文件与读回、保存前的校验、
// 编辑时保留的字段、删除，以及 parseRoleFiles 拆出 inspectRoleFiles 之后结果不变。
// 项目是临时文件夹；模型设置、档案能力与 pi 的默认工具都是测试给出的（synthetic）。frontmatter 用 pi 的 parseFrontmatter。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';

const commands = await loadKernelModule('src/kernel/roleCommands.ts');
const roles = await loadKernelModule('src/kernel/roles.ts');

// ---- 合成的模型设置（synthetic） ----

/** 选择范围 → 展开的模型（分组、提供商、<provider>/<model>） */
const RANGES = {
  strong: ['deepseek/deepseek-chat', 'glm/glm-4.6'],
  fast: ['glm/glm-4.5'],
  deepseek: ['deepseek/deepseek-chat'],
  'deepseek/deepseek-chat': ['deepseek/deepseek-chat'],
  'glm/glm-4.6': ['glm/glm-4.6'],
  'glm/glm-4.5': ['glm/glm-4.5'],
};
/** 每个模型的档案能力 */
const CAPS = {
  'deepseek/deepseek-chat': { tier: 'A', protocolWrite: 'verified', structuredOutput: 'verified', vision: 'failed',
    effectiveWindow: 128000, probing: false },
  'glm/glm-4.6': { tier: 'C', protocolWrite: 'verified', structuredOutput: 'unverified', vision: 'unverified',
    effectiveWindow: 32768, probing: false },
  'glm/glm-4.5': { tier: null, protocolWrite: 'failed', structuredOutput: 'failed', vision: 'failed',
    effectiveWindow: 128000, probing: false },
};
const deps = { pickExists: (name) => Object.hasOwn(RANGES, name), parseFrontmatter };

/** @brief 候选来源：会话的范围 pick，展开按 RANGES，第 1–3 步的查询按 CAPS（glm-4.5 的 tool_calling 未验证）。 */
function source(pick = 'strong') {
  return {
    pick,
    expand: (picks) => [...new Set(picks.flatMap((name) => RANGES[name] ?? []))],
    base: {
      exists: (ref) => Object.hasOwn(CAPS, ref), zoneOf: () => 'local', allowedZones: ['local'],
      toolCalling: (ref) => (ref === 'glm/glm-4.5' ? 'unverified' : 'verified'), capabilities: (ref) => CAPS[ref],
      familyOf: (ref) => ref,
    },
  };
}

const RANGE_ITEMS = [{ pick: 'strong', kind: 'group', label: 'strong' }];
const DEFAULTS = ['read', 'bash', 'edit', 'write'];

/** @brief 新的临时项目，.mori/agents 里写好 files（文件名 → 全文）。 */
function project(files = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mori-ag-unit-'));
  const dir = join(cwd, '.mori', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { cwd, dir, setup: { cwd, deps, source: source(), ranges: RANGE_ITEMS, baseTools: DEFAULTS } };
}

/** @brief 一个手写的角色文件（只有 name、description，再加 lines）。 */
const roleText = (name, ...lines) => ['---', `name: ${name}`, `description: The ${name} agent`, ...lines, '---',
  `You are ${name}.`, ''].join('\n');

/** @brief 表单的内容（synthetic）。 */
const draft = (extra = {}) => ({ name: 'reviewer', description: 'Reviews the change', seats: [], tools: null,
  models: null, body: 'Review the diff.', ...extra });

const listing = (dir) => readdirSync(dir).sort();
const agentOf = (info, name) => info.agents.find((agent) => agent.name === name);
const cleanup = (cwd) => rmSync(cwd, { recursive: true, force: true });

// ---- AG-02 候选与原因 ----

test('AG-02 an agent’s models expand in order without repeats; each candidate is ready or has the selector’s reason',
  () => {
    const tool = [{ kind: 'tool_calling' }];
    assert.deepEqual(commands.roleCandidates(source(), ['fast', 'strong', 'deepseek'], tool), [
      { ref: 'glm/glm-4.5', reason: 'tool calling not verified yet' },
      { ref: 'deepseek/deepseek-chat', reason: null },
      { ref: 'glm/glm-4.6', reason: null },
    ]);
  });

test('AG-02 requirements are checked like the selector: handoff tier, effective window, structured output', () => {
  const candidates = (requires) => commands.roleCandidates(source(), ['strong'],
    [{ kind: 'tool_calling' }, ...requires]);
  assert.deepEqual(candidates([{ kind: 'protocol_write', min: 'B' }]), [
    { ref: 'deepseek/deepseek-chat', reason: null }, { ref: 'glm/glm-4.6', reason: 'handoff tier C is below B' }]);
  assert.deepEqual(candidates([{ kind: 'context', tokens: 65536 }]), [
    { ref: 'deepseek/deepseek-chat', reason: null }, { ref: 'glm/glm-4.6', reason: 'effective window 32768 < 65536' }]);
  assert.deepEqual(candidates([{ kind: 'structured_output' }]), [
    { ref: 'deepseek/deepseek-chat', reason: null }, { ref: 'glm/glm-4.6', reason: 'structured_output not verified' }]);
});

test('AG-02 without models the agent uses the session’s range; with no range there are no candidates', () => {
  const tool = [{ kind: 'tool_calling' }];
  assert.deepEqual(commands.roleCandidates(source('fast'), null, tool).map((item) => item.ref), ['glm/glm-4.5']);
  assert.deepEqual(commands.roleCandidates(source(null), null, tool), []);
  assert.deepEqual(commands.roleCandidates(source(null), ['deepseek'], tool),
    [{ ref: 'deepseek/deepseek-chat', reason: null }]);
});

test('AG-02 roles.get: Mori first with the session’s range and unclaimed jobs, then files by name with candidates',
  async () => {
    const { cwd, setup } = project({
      'b-planner.md': roleText('planner', 'seats: [create, close]', 'models: [deepseek]'),
      'a-checker.md': roleText('checker', 'requires: [protocol_write>=B]', 'tools: [read, grep]'),
    });
    try {
      const { info, error } = await commands.rolesInfoIn(setup);
      assert.equal(error, null);
      assert.deepEqual(info.agents.map((agent) => agent.name), ['mori', 'checker', 'planner']);
      const mori = info.agents[0];
      assert.deepEqual([mori.file, mori.path, mori.seats, mori.tools, mori.models],
        [null, null, ['dialog'], null, null]);
      assert.equal(mori.description, 'General-purpose agent with the default tools');
      assert.deepEqual(mori.candidates, [{ ref: 'deepseek/deepseek-chat', reason: null },
        { ref: 'glm/glm-4.6', reason: null }]);
      const checker = agentOf(info, 'checker');
      assert.deepEqual(checker.needs, ['protocol_write>=B']);
      assert.deepEqual(checker.candidates.map((item) => item.reason), [null, 'handoff tier C is below B']);
      assert.deepEqual(checker.tools, ['read', 'grep']);
      assert.equal(checker.file, '.mori/agents/a-checker.md');
      assert.equal(checker.path, join(cwd, '.mori', 'agents', 'a-checker.md'));
      assert.deepEqual(agentOf(info, 'planner').candidates, [{ ref: 'deepseek/deepseek-chat', reason: null }]);
      assert.deepEqual(info.holders, { dialog: 'mori', create: 'planner', close: 'planner' });
      assert.deepEqual([info.pick, info.cwd, info.dir], ['strong', cwd, join(cwd, '.mori', 'agents')]);
      assert.deepEqual(info.baseTools, DEFAULTS);
      assert.deepEqual(info.piTools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell']);
      assert.deepEqual(info.ranges, RANGE_ITEMS);
      assert.deepEqual(info.problems, []);
    } finally {
      cleanup(cwd);
    }
  });

// ---- AG-03 有问题的文件 ----

test('AG-03 problem files list the same lines as the start check; good files still show; problem files hold no jobs',
  async () => {
    const files = {
      'a.md': roleText('alpha', 'colour: blue'),
      'b.md': roleText('beta', 'seats: [close]'),
      'c.md': '---\nname: [oops\n---\n',
      'd.md': roleText('gamma', 'seats: [close]'),
    };
    const { cwd, setup } = project(files);
    try {
      const { info } = await commands.rolesInfoIn(setup);
      const texts = Object.entries(files).map(([name, text]) => ({ file: `.mori/agents/${name}`, text }));
      const expected = roles.parseRoleFiles(texts, deps).problems;
      assert.ok(expected.length >= 3);
      assert.deepEqual(info.problems, expected);
      assert.deepEqual(agentOf(info, 'alpha').problems, ['unknown field "colour"']);
      assert.deepEqual(agentOf(info, 'gamma').problems, ['seat "close" is also claimed by .mori/agents/b.md']);
      const broken = info.agents.find((agent) => agent.file === '.mori/agents/c.md');
      assert.equal(broken.name, 'c');
      assert.equal(broken.problems.length, 1);
      assert.match(broken.problems[0], /^can’t read the header: /);
      assert.deepEqual(agentOf(info, 'beta').problems, []);
      assert.deepEqual(info.holders, { dialog: 'mori', create: 'mori', close: 'beta' });
      assert.deepEqual(info.agents[0].seats, ['dialog', 'create']);
      assert.deepEqual(agentOf(info, 'alpha').candidates, []);
    } finally {
      cleanup(cwd);
    }
  });

test('AG-03 a folder that can’t be read gives the error text instead of a list', async () => {
  const { cwd, setup } = project();
  try {
    const result = await commands.rolesInfoIn({ ...setup, cwd: `${cwd}\0bad` });
    assert.equal(result.info, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  } finally {
    cleanup(cwd);
  }
});

// ---- AG-04 新建 ----

test('AG-04 New agent writes .mori/agents/<name>.md that loadRoles reads back with the form’s fields', async () => {
  const { cwd, dir, setup } = project();
  try {
    const form = draft({ seats: ['close'], tools: ['read', 'grep', 'mcp__*'], models: ['fast', 'strong'],
      description: 'Reviews: "everything" # carefully', body: '\nReview the diff.\n' });
    const result = await commands.saveRoleIn(setup, null, form);
    assert.equal(result.error, null);
    assert.equal(result.file, '.mori/agents/reviewer.md');
    assert.deepEqual(listing(dir), ['reviewer.md']);
    const load = await roles.loadRoles(cwd, deps);
    assert.deepEqual(load.problems, []);
    const role = load.roles.find((item) => item.name === 'reviewer');
    assert.deepEqual([role.description, role.seats, role.tools, role.models, role.body, role.file],
      ['Reviews: "everything" # carefully', ['close'], ['read', 'grep', 'mcp__*'], ['fast', 'strong'],
        'Review the diff.', '.mori/agents/reviewer.md']);
    assert.ok(agentOf(result.info, 'reviewer'));
    assert.equal(result.info.holders.close, 'reviewer');
    assert.ok(!readFileSync(join(dir, 'reviewer.md'), 'utf8').includes('\r'));
  } finally {
    cleanup(cwd);
  }
});

test('AG-04 an agent without jobs, tools or models writes only name, description and the prompt', async () => {
  const { cwd, dir, setup } = project();
  try {
    const result = await commands.saveRoleIn(setup, null, draft({ name: 'executor', description: 'Does tasks',
      body: '' }));
    assert.equal(result.error, null);
    assert.equal(readFileSync(join(dir, 'executor.md'), 'utf8'),
      '---\nname: executor\ndescription: "Does tasks"\n---\n');
  } finally {
    cleanup(cwd);
  }
});

// ---- AG-05 保存的校验 ----

test('AG-05 bad names, the reserved name and number-like names are refused before any file is named', async () => {
  const { cwd, dir, setup } = project();
  try {
    const cases = [
      ['Reviewer', 'name must use lowercase letters, digits and - (at most 40, not starting with -)'],
      ['-x', 'name must use lowercase letters, digits and - (at most 40, not starting with -)'],
      ['mori', 'name "mori" is reserved for the base agent'],
      ['12', 'name "12" looks like a task or request number'],
      ['t7', 'name "t7" looks like a task or request number'],
    ];
    for (const [name, error] of cases) {
      const result = await commands.saveRoleIn(setup, null, draft({ name }));
      assert.deepEqual([result.info, result.file, result.error], [null, null, error], name);
    }
    assert.deepEqual(listing(dir), []);
  } finally {
    cleanup(cwd);
  }
});

test('AG-05 a name used by another file, an existing <name>.md and a claimed job are refused; nothing is written',
  async () => {
    const { cwd, dir, setup } = project({
      'rev.md': roleText('reviewer'),
      'planner.md': roleText('planner', 'seats: [close]'),
      'helper.md': roleText('someone-else'),
    });
    try {
      const before = listing(dir);
      const used = await commands.saveRoleIn(setup, null, draft());
      assert.equal(used.error, 'name "reviewer" is already used by .mori/agents/rev.md');
      const taken = await commands.saveRoleIn(setup, null, draft({ name: 'helper' }));
      assert.equal(taken.error, 'A file named .mori/agents/helper.md already exists.');
      const seat = await commands.saveRoleIn(setup, null, draft({ name: 'closer', seats: ['close'] }));
      assert.equal(seat.error, 'seat "close" is also claimed by .mori/agents/planner.md');
      assert.deepEqual(listing(dir), before);
    } finally {
      cleanup(cwd);
    }
  });

test('AG-05 description rules come from the same check; every problem is one line', async () => {
  const { cwd, dir, setup } = project();
  try {
    const empty = await commands.saveRoleIn(setup, null, draft({ description: '   ' }));
    assert.equal(empty.error, 'description must not be empty');
    const long = await commands.saveRoleIn(setup, null, draft({ description: 'x'.repeat(201) }));
    assert.equal(long.error, 'description must be at most 200 characters');
    const two = await commands.saveRoleIn(setup, null, draft({ description: '', tools: ['read', 'task_handoff'] }));
    assert.deepEqual(two.error.split('\n'),
      ['description must not be empty', '"task_handoff" is added by Mori; remove it']);
    const ok = await commands.saveRoleIn(setup, null, draft({ description: 'x'.repeat(200) }));
    assert.equal(ok.error, null);
    assert.deepEqual(listing(dir), ['reviewer.md']);
  } finally {
    cleanup(cwd);
  }
});

test('AG-05 another file’s own problems don’t block saving; paths outside .mori/agents are refused', async () => {
  const { cwd, dir, setup } = project({ 'broken.md': roleText('broken', 'colour: blue') });
  try {
    const saved = await commands.saveRoleIn(setup, null, draft());
    assert.equal(saved.error, null);
    assert.deepEqual(saved.info.problems, ['.mori/agents/broken.md: unknown field "colour"']);
    writeFileSync(join(cwd, 'outside.md'), roleText('outside'));
    for (const file of ['../outside.md', '.mori/agents/../../outside.md', join(cwd, 'outside.md'),
      '.mori/agents/sub/x.md']) {
      const result = await commands.saveRoleIn(setup, file, draft({ name: 'outside' }));
      assert.equal(result.error, 'This agent file no longer exists.', file);
      const removed = await commands.deleteRoleIn(setup, file);
      assert.equal(removed.error, 'This agent file no longer exists.', file);
    }
    assert.equal(readFileSync(join(cwd, 'outside.md'), 'utf8'), roleText('outside'));
    assert.deepEqual(listing(dir), ['broken.md', 'reviewer.md']);
  } finally {
    cleanup(cwd);
  }
});

// ---- AG-06 编辑 ----

test('AG-06 Edit keeps the file name and requires, differ_from, subscribe as they were', async () => {
  const original = ['---', '# written by hand', 'name: rev', 'description: Old text', 'requires: [protocol_write>=B]',
    'seats: [close]', 'differ_from: author', 'subscribe:', '  - request_closed: { ruled_out: true }', '---',
    'Old prompt.', ''].join('\n');
  const { cwd, dir, setup } = project({ 'rev.md': original });
  try {
    const before = await commands.rolesInfoIn(setup);
    const view = agentOf(before.info, 'rev');
    assert.equal(view.headerComments, true);
    assert.deepEqual([view.differFromAuthor, view.needs], [true, ['protocol_write>=B']]);
    assert.deepEqual(view.subscribe, [{ moment: 'request_closed', ruledOut: true, outcome: null }]);
    const result = await commands.saveRoleIn(setup, '.mori/agents/rev.md', draft({ name: 'reviewer',
      description: 'New text', seats: ['create'], tools: ['read'], body: 'New prompt.' }));
    assert.equal(result.error, null);
    assert.equal(result.file, '.mori/agents/rev.md');
    assert.deepEqual(listing(dir), ['rev.md']);
    const parsed = parseFrontmatter(readFileSync(join(dir, 'rev.md'), 'utf8'));
    assert.deepEqual(parsed.frontmatter, { name: 'reviewer', description: 'New text', tools: ['read'],
      requires: ['protocol_write>=B'], seats: ['create'], differ_from: 'author',
      subscribe: [{ request_closed: { ruled_out: true } }] });
    assert.equal(parsed.body, 'New prompt.');
    assert.equal(agentOf(result.info, 'reviewer').headerComments, false);
  } finally {
    cleanup(cwd);
  }
});

test('AG-06 editing a file that was deleted elsewhere says so and writes nothing', async () => {
  const { cwd, dir, setup } = project({ 'rev.md': roleText('rev') });
  try {
    rmSync(join(dir, 'rev.md'));
    const result = await commands.saveRoleIn(setup, '.mori/agents/rev.md', draft({ name: 'rev' }));
    assert.deepEqual([result.info, result.file, result.error], [null, null, 'This agent file no longer exists.']);
    assert.deepEqual(listing(dir), []);
  } finally {
    cleanup(cwd);
  }
});

test('AG-06 an edit that would clash with another file is refused, wherever the files sort', async () => {
  const { cwd, dir, setup } = project({ 'a.md': roleText('alpha'), 'z.md': roleText('zeta', 'seats: [close]') });
  try {
    const text = readFileSync(join(dir, 'a.md'), 'utf8');
    const result = await commands.saveRoleIn(setup, '.mori/agents/a.md', draft({ name: 'alpha', seats: ['close'] }));
    assert.equal(result.error, 'seat "close" is also claimed by .mori/agents/z.md');
    const renamed = await commands.saveRoleIn(setup, '.mori/agents/a.md', draft({ name: 'zeta' }));
    assert.equal(renamed.error, 'name "zeta" is already used by .mori/agents/z.md');
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), text);
  } finally {
    cleanup(cwd);
  }
});

// ---- AG-07 删除 ----

test('AG-07 delete removes the file and returns the new list; a file already gone also counts as deleted', async () => {
  const { cwd, dir, setup } = project({ 'rev.md': roleText('rev'), 'other.md': roleText('other') });
  try {
    const result = await commands.deleteRoleIn(setup, '.mori/agents/rev.md');
    assert.equal(result.error, null);
    assert.deepEqual(listing(dir), ['other.md']);
    assert.deepEqual(result.info.agents.map((agent) => agent.name), ['mori', 'other']);
    const again = await commands.deleteRoleIn(setup, '.mori/agents/rev.md');
    assert.equal(again.error, null);
    assert.ok(existsSync(join(dir, 'other.md')));
  } finally {
    cleanup(cwd);
  }
});

// ---- AG-11 parseRoleFiles 不变 ----

test('AG-11 parseRoleFiles gives the same result as before inspectRoleFiles was split out', () => {
  const sets = [
    [['chat.md', roleText('chat', 'seats: [dialog]')], ['planner.md', roleText('planner', 'seats: [create, close]')],
      ['executor.md', roleText('executor')]],
    [['a.md', roleText('same')], ['b.md', roleText('same', 'seats: [close]')],
      ['c.md', roleText('c', 'seats: [close]')]],
    [['a.md', '---\n---\n'], ['b.md', roleText('mori')], ['c.md', roleText('c', 'models: [nowhere]')]],
  ].map((set) => set.map(([name, text]) => ({ file: `.mori/agents/${name}`, text })));
  for (const files of sets) {
    const load = roles.parseRoleFiles(files, deps);
    const inspection = roles.inspectRoleFiles(files, deps);
    const lines = inspection.reports.flatMap((report) => report.problems.map((line) => `${report.file}: ${line}`));
    assert.deepEqual(load.problems, lines);
    if (lines.length > 0) {
      assert.deepEqual(load.roles.map((role) => role.name), ['mori']);
      assert.deepEqual(load.holders, { dialog: 'mori', create: 'mori', close: 'mori' });
    } else {
      assert.deepEqual(load.roles.slice(0, -1), inspection.reports.map((report) => report.role));
      assert.deepEqual(load.holders, inspection.holders);
    }
  }
  const first = roles.parseRoleFiles(sets[0], deps);
  assert.deepEqual(first.holders, { dialog: 'chat', create: 'planner', close: 'planner' });
  assert.equal(first.merged, false);
  assert.deepEqual(first.roles.map((role) => role.name), ['chat', 'planner', 'executor', 'mori']);
});
