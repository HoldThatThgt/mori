// kernel/roles.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §4、§6.3、§8.1、§9.5、§12.1）：
// 角色文件的读取与 §4.4 的每一行问题、权限与基座、next 与 assignee 的枚举、各种会话的工具白名单、候选的选择范围、订阅过滤。
// 文件系统规格之后（docs/specs/file-system-permissions.md §8.6、file-system.md §11.7、§19.4）：角色文件没有 tools 字段，
// 实例的工具白名单不随角色、种类与只读开关（instanceTools），worktree 会话从主文件夹读 .mori/agents。
// frontmatter 用 pi 导出的 parseFrontmatter 解析（与后台进程相同）；模型设置里的名字由测试给出（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';

const roles = await loadKernelModule('src/kernel/roles.ts');

/** 模型设置里有的名字（synthetic）：分组、提供商、<provider>/<model> */
const PICKS = new Set(['strong', 'weak', 'deepseek', 'deepseek/deepseek-chat', 'glm/glm-4.6']);
const deps = { pickExists: (name) => PICKS.has(name), parseFrontmatter };
/** pi 没有设默认工具时的默认工具（§4.2） */
const DEFAULTS = ['read', 'bash', 'edit', 'write'];
const ALL_SEATS = ['dialog', 'create', 'close'];
const BASE_LINE = `mori: ${roles.BASE_ROLE_DESCRIPTION}`;

/** @brief 一个角色文件：frontmatter 的若干行与正文。 */
function roleFile(name, header, body = '') {
  return { file: `.mori/agents/${name}`, text: `---\n${header}\n---\n${body}` };
}

/** @brief 只有 name 与 description 的合格 frontmatter，后面接上额外的行。 */
function header(name, ...lines) {
  return [`name: ${name}`, `description: The ${name} role`, ...lines].join('\n');
}

/** @brief 一个文件 a.md 的问题行。 */
function problemsOf(text) {
  return roles.parseRoleFiles([{ file: '.mori/agents/a.md', text }], deps).problems;
}

/** @brief 角色 a 的文件 a.md（name、description 合格）加上额外的行之后的问题行。 */
function fieldProblems(...lines) {
  return problemsOf(roleFile('a.md', header('a', ...lines)).text);
}

/** @brief 只有一个角色文件 <name>.md 时读出的结果。 */
function single(name, ...lines) {
  return roles.parseRoleFiles([roleFile(`${name}.md`, header(name, ...lines))], deps);
}

/** @brief name 格式不合格时的文字。 */
const NAME_RULE = 'name must use lowercase letters, digits and - (at most 40, not starting with -)';
/** @brief 没有 frontmatter 时的问题行。 */
const NO_HEADER = ".mori/agents/a.md: can’t read the header: no header between --- lines";

/** @brief proposal §6.2 的配置：chat（对话）、planner（立项 + 结案）、executor、reviewer；都不写 tools（§8.6）。 */
function teamOf62() {
  return roles.parseRoleFiles([
    roleFile('chat.md', header('chat', 'seats: [dialog]')),
    roleFile('executor.md', header('executor')),
    roleFile('planner.md', header('planner', 'seats: [create, close]', 'models: [strong]')),
    roleFile('reviewer.md', header('reviewer', 'differ_from: author')),
  ], deps);
}

/** @brief 写了 tools 的文件的问题行（file-system-permissions.md §8.6：未知字段，§4.4 表的工具那一行已去掉）。 */
const TOOLS_FIELD = '.mori/agents/a.md: unknown field "tools"';

// ---- TB-01 角色文件校验 ----

test('TB-01 a valid file reads every field, the body goes in as written', () => {
  const text = [
    '---',
    'name: planner',
    'description: Reads the request, decides how to split it and who does what; checks returned tasks',
    'seats: [create, close]',
    'models: [strong, deepseek/deepseek-chat, strong]',
    'requires: [protocol_write>=B, structured_output, vision, context>=65536, tool_calling, protocol_write]',
    'differ_from: author',
    'subscribe:',
    '  - request_closed',
    '  - request_closed: { ruled_out: true, outcome: [done, failed] }',
    '  - request_closed:',
    '---',
    'You plan the work.',
    '',
    'MORI-ROLE-planner',
    '  Keep tasks small.',
    '',
  ].join('\r\n');
  const load = roles.parseRoleFiles([{ file: '.mori/agents/planner.md', text: `﻿${text}` }], deps);
  assert.deepEqual(load.problems, []);
  assert.deepEqual(load.roles[0], {
    name: 'planner',
    description: 'Reads the request, decides how to split it and who does what; checks returned tasks',
    body: 'You plan the work.\n\nMORI-ROLE-planner\n  Keep tasks small.',
    file: '.mori/agents/planner.md',
    models: ['strong', 'deepseek/deepseek-chat'],
    requires: [
      { kind: 'tool_calling' }, { kind: 'protocol_write', min: 'B' }, { kind: 'structured_output' }, { kind: 'vision' },
      { kind: 'context', tokens: 65536 }, { kind: 'protocol_write', min: 'C' },
    ],
    seats: ['create', 'close'],
    differFromAuthor: true,
    subscribe: [
      { moment: 'request_closed', ruledOut: null, outcome: null },
      { moment: 'request_closed', ruledOut: true, outcome: ['done', 'failed'] },
      { moment: 'request_closed', ruledOut: null, outcome: null },
    ],
  });
});

test('TB-01 optional fields left out: models null; tool_calling implied; no seats or subscriptions; no tools field',
  () => {
  const load = roles.parseRoleFiles([roleFile('executor.md', header('executor'), 'Do the task.')], deps);
  assert.deepEqual(load.problems, []);
  const [executor] = load.roles;
  assert.equal('tools' in executor, false, 'a role has no tools field (file-system-permissions.md §8.6)');
  assert.equal(executor.models, null);
  assert.deepEqual(executor.requires, [{ kind: 'tool_calling' }]);
  assert.deepEqual(executor.seats, []);
  assert.deepEqual(executor.subscribe, []);
  assert.equal(executor.differFromAuthor, false);
  assert.equal(executor.body, 'Do the task.');
});

test('TB-01 §4.4 row: the header can not be read (YAML error, no frontmatter)', () => {
  const [yaml] = problemsOf('---\nname: a: b\ndescription: d\n---\n');
  assert.match(yaml, /^\.mori\/agents\/a\.md: can’t read the header: Nested mappings .*at line 1, column 7$/);
  assert.deepEqual(problemsOf('Just a body, no header.'), [NO_HEADER]);
  assert.deepEqual(problemsOf('---\nname: x\ndescription: d\n'), [NO_HEADER]);
  assert.deepEqual(problemsOf('---\n- name\n---\n'),
    ['.mori/agents/a.md: can’t read the header: it must be "field: value" lines']);
  const unreadable = roles.parseRoleFiles([{ file: '.mori/agents/b.md', readError: 'EACCES: permission denied' }],
    deps);
  assert.deepEqual(unreadable.problems, [".mori/agents/b.md: can’t read the header: EACCES: permission denied"]);
});

test('TB-01 §4.4 row: unknown field', () => {
  assert.deepEqual(problemsOf(roleFile('a.md', header('a', 'color: blue', 'temperature: 1')).text), [
    '.mori/agents/a.md: unknown field "color"', '.mori/agents/a.md: unknown field "temperature"',
  ]);
});

test('TB-01 §4.4 row: name or description missing or not valid', () => {
  const cases = [
    ['description: d', 'name is required'],
    ['name:\ndescription: d', 'name is required'],
    ['name: true\ndescription: d', 'name must be text'],
    ['name: 1.5\ndescription: d', 'name must be text'],
    ['name: Planner\ndescription: d', NAME_RULE],
    ['name: -planner\ndescription: d', NAME_RULE],
    [`name: ${'a'.repeat(41)}\ndescription: d`, NAME_RULE],
    ['name: a', 'description is required'],
    ['name: a\ndescription: [x]', 'description must be text'],
    ['name: a\ndescription: "   "', 'description must not be empty'],
    [`name: a\ndescription: ${'x'.repeat(201)}`, 'description must be at most 200 characters'],
  ];
  for (const [text, line] of cases) {
    assert.deepEqual(problemsOf(`---\n${text}\n---\n`), [`.mori/agents/a.md: ${line}`], text);
  }
  assert.deepEqual(problemsOf(`---\nname: ${'a'.repeat(40)}\ndescription: ${'说'.repeat(200)}\n---\n`), []);
});

test('TB-01 §4.4 row: name already used, reserved for the base agent, looks like a number', () => {
  const twice = roles.parseRoleFiles([roleFile('a.md', header('worker')), roleFile('b.md', header('worker'))], deps);
  assert.deepEqual(twice.problems, ['.mori/agents/b.md: name "worker" is already used by .mori/agents/a.md']);
  assert.deepEqual(problemsOf(roleFile('a.md', header('mori')).text),
    ['.mori/agents/a.md: name "mori" is reserved for the base agent']);
  for (const name of ['12', '"12"', 't3', 'r7', '007']) {
    assert.deepEqual(problemsOf(roleFile('a.md', header(name)).text),
      [`.mori/agents/a.md: name "${name.replace(/"/g, '').replace(/^0+/, '')}" looks like a task or request number`],
      name);
  }
  assert.deepEqual(problemsOf(roleFile('a.md', header('t3-review')).text), []);
});

test('TB-01 §4.4 row: unknown seat; seat also claimed by another file', () => {
  assert.deepEqual(problemsOf(roleFile('a.md', header('a', 'seats: [create, talk]')).text),
    ['.mori/agents/a.md: unknown seat "talk"']);
  assert.deepEqual(problemsOf(roleFile('a.md', header('a', 'seats: create')).text),
    ['.mori/agents/a.md: seats must be a list']);
  const claimed = roles.parseRoleFiles([
    roleFile('a.md', header('a', 'seats: [create]')),
    roleFile('b.md', header('b', 'seats: [create, close]')),
    roleFile('c.md', header('c', 'seats: [close, create]')),
  ], deps);
  assert.deepEqual(claimed.problems, [
    '.mori/agents/b.md: seat "create" is also claimed by .mori/agents/a.md',
    '.mori/agents/c.md: seat "create" is also claimed by .mori/agents/a.md',
    '.mori/agents/c.md: seat "close" is also claimed by .mori/agents/b.md',
  ]);
});

test('TB-01 the tools row is gone: any tools line is the unknown field "tools", whatever it lists', () => {
  const lines = ['tools: [read, bash, edit, write, grep, find, ls, powershell]', 'tools: [read]',
    'tools: [read, shell, Read, mcp__*, mcp__docs__se*]', 'tools: [mcp__docs__search, mcp__jira_cloud__*]',
    'tools: [read, task_handoff, board_read]', 'tools: read', 'tools: []'];
  for (const line of lines) assert.deepEqual(fieldProblems(line), [TOOLS_FIELD], line);
  assert.deepEqual(fieldProblems('tools: [read]', 'color: blue'),
    [TOOLS_FIELD, '.mori/agents/a.md: unknown field "color"'], 'listed with the other unknown fields');
  const load = single('a', 'seats: [dialog]', 'tools: [read]');
  assert.deepEqual(load.roles.map((role) => role.name), ['mori'], 'only the base agent is left (agents_invalid)');
  // PI_TOOL_NAMES 留着：它是 Customize › Built-in tools 的 8 个开关（WP-08），不再用来校验角色
  for (const name of ['roleTools', 'readClassTools', 'toolAllowlist', 'dialogTools', 'matchesToolEntries']) {
    assert.equal(roles[name], undefined, `${name} is removed (file-system-permissions.md §8.6)`);
  }
});

test('TB-01 §4.4 row: models name something not in your model settings', () => {
  assert.deepEqual(fieldProblems('models: [strong, nope, glm/glm-4.6, openai/gpt-x]'), [
    '.mori/agents/a.md: "nope" is not in your model settings (models[1])',
    '.mori/agents/a.md: "openai/gpt-x" is not in your model settings (models[3])',
  ]);
  assert.deepEqual(problemsOf(roleFile('a.md', header('a', 'models: strong')).text),
    ['.mori/agents/a.md: models must be a list']);
  assert.deepEqual(problemsOf(roleFile('a.md', header('a', 'models: []')).text),
    ['.mori/agents/a.md: models must name at least one model range']);
});

test('TB-01 §4.4 row: unknown requirement, context>=N needs a positive integer', () => {
  const bad = ['fast', 'context>=0', 'context>=-1', 'context>=1.5', 'context>=abc', 'context>= 5', 'protocol_write>=A',
    'protocol_write>=C', 'context>=99999999999999999999'];
  assert.deepEqual(problemsOf(roleFile('a.md', header('a', `requires: [${bad.map((x) => `"${x}"`).join(', ')}]`)).text),
    bad.map((req) => `.mori/agents/a.md: unknown requirement "${req}"`));
  const good = 'requires: [tool_calling, protocol_write, protocol_write>=B, structured_output, vision, context>=1]';
  assert.deepEqual(problemsOf(roleFile('a.md', header('a', good)).text), []);
});

test('TB-01 §4.4 row: differ_from can only be author', () => {
  for (const value of ['reviewer', '[author]', 'true']) {
    assert.deepEqual(problemsOf(roleFile('a.md', header('a', `differ_from: ${value}`)).text),
      ['.mori/agents/a.md: differ_from can only be "author"'], value);
  }
});

test('TB-01 §4.4 row: subscribe moments and filters outside the vocabulary', () => {
  const cases = [
    ['subscribe: [task_done]', ['unknown moment "task_done"']],
    ['subscribe: [{}]', ['unknown moment "{}"']],
    ['subscribe: [{ request_closed: { since: 1 } }]', ['unknown filter "since"']],
    ['subscribe: [{ request_closed: { outcome: [done, open] } }]', ['unknown filter "outcome: open"']],
    ['subscribe: [{ request_closed: { outcome: done } }]', ['unknown filter "outcome: done"']],
    ['subscribe: [{ request_closed: { ruled_out: yes } }]', ['unknown filter "ruled_out: yes"']],
    ['subscribe: [{ request_closed: true }]', ['unknown filter "true"']],
    ['subscribe: [{ request_closed: {}, task_failed: {} }]', ['unknown moment "task_failed"']],
    ['subscribe: request_closed', ['subscribe must be a list']],
  ];
  for (const [line, expected] of cases) {
    assert.deepEqual(problemsOf(roleFile('a.md', header('a', line)).text),
      expected.map((text) => `.mori/agents/a.md: ${text}`), line);
  }
});

test('TB-01 every problem is listed file by file; any problem leaves only the base agent', () => {
  const load = roles.parseRoleFiles([
    roleFile('a.md', header('Bad', 'seats: [dialog]', 'color: red')),
    roleFile('b.md', header('fine', 'seats: [create]')),
    roleFile('c.md', header('other', 'differ_from: x')),
  ], deps);
  assert.deepEqual(load.problems, [
    `.mori/agents/a.md: ${NAME_RULE}`,
    '.mori/agents/a.md: unknown field "color"',
    '.mori/agents/c.md: differ_from can only be "author"',
  ]);
  assert.deepEqual(load.roles.map((role) => role.name), ['mori']);
  assert.deepEqual(load.roles[0].seats, ALL_SEATS);
  assert.deepEqual(load.holders, { dialog: 'mori', create: 'mori', close: 'mori' });
  assert.equal(load.merged, true);
});

test('TB-01 a file with other problems still owns its name and seats', () => {
  const load = roles.parseRoleFiles([
    roleFile('a.md', header('worker', 'seats: [close]', 'tools: [shell]')),
    roleFile('b.md', header('worker', 'seats: [close]')),
  ], deps);
  assert.deepEqual(load.problems, [
    TOOLS_FIELD,
    '.mori/agents/b.md: name "worker" is already used by .mori/agents/a.md',
    '.mori/agents/b.md: seat "close" is also claimed by .mori/agents/a.md',
  ]);
});

test('TB-01 loadRoles reads only .mori/agents/*.md (not subfolders), in file-name order', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'mori-roles-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dir = join(cwd, '.mori', 'agents');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  mkdirSync(join(dir, 'folder.md'));
  writeFileSync(join(dir, 'reviewer.md'), roleFile('reviewer.md', header('reviewer'), 'Review it.').text);
  writeFileSync(join(dir, 'executor.md'), roleFile('executor.md', header('executor', 'seats: [close]')).text);
  writeFileSync(join(dir, 'notes.txt'), 'not a role');
  writeFileSync(join(dir, 'nested', 'deep.md'), 'not read at all');
  const load = await roles.loadRoles(cwd, deps);
  assert.deepEqual(load.problems, []);
  assert.deepEqual(load.roles.map((role) => [role.name, role.file]),
    [['executor', '.mori/agents/executor.md'], ['reviewer', '.mori/agents/reviewer.md'], ['mori', null]]);
  assert.equal(load.roles[1].body, 'Review it.');
  assert.deepEqual(load.holders, { dialog: 'mori', create: 'mori', close: 'executor' });
  writeFileSync(join(dir, 'broken.md'), '---\nname: broken\n---\n');
  const broken = await roles.loadRoles(cwd, deps);
  assert.deepEqual(broken.problems, ['.mori/agents/broken.md: description is required']);
});

test('TB-01 loadRoles without a .mori/agents folder: only the base agent, no problems', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'mori-roles-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const load = await roles.loadRoles(cwd, deps);
  assert.deepEqual(load.problems, []);
  assert.deepEqual(load.roles.map((role) => role.name), ['mori']);
  writeFileSync(join(cwd, '.mori'), 'a file, not a folder');
  assert.deepEqual((await roles.loadRoles(cwd, deps)).roles.map((role) => role.name), ['mori']);
});

// ---- TB-02 权限与基座 ----

test('TB-02 proposal §6.2 setup: holders are chat, planner, planner; not a merged session', () => {
  const load = teamOf62();
  assert.deepEqual(load.problems, []);
  assert.deepEqual(load.holders, { dialog: 'chat', create: 'planner', close: 'planner' });
  assert.equal(load.merged, false);
  assert.deepEqual(load.roles.map((role) => role.name), ['chat', 'executor', 'planner', 'reviewer', 'mori']);
  assert.deepEqual(load.roles.at(-1).seats, []);
});

test('TB-02 no role files: the base agent holds all three seats, merged session', () => {
  const load = roles.parseRoleFiles([], deps);
  assert.deepEqual(load.problems, []);
  assert.deepEqual(load.holders, { dialog: 'mori', create: 'mori', close: 'mori' });
  assert.equal(load.merged, true);
  assert.deepEqual(load.roles, [{
    name: 'mori', description: roles.BASE_ROLE_DESCRIPTION, body: '', file: null, models: null,
    requires: [{ kind: 'tool_calling' }], seats: ALL_SEATS, differFromAuthor: false, subscribe: [],
  }]);
});

test('TB-02 only executor.md: the base agent holds dialog, create and close', () => {
  const load = roles.parseRoleFiles([roleFile('executor.md', header('executor'))], deps);
  assert.deepEqual(load.holders, { dialog: 'mori', create: 'mori', close: 'mori' });
  assert.equal(load.merged, true);
  assert.deepEqual(load.roles.map((role) => [role.name, role.seats]), [['executor', []], ['mori', ALL_SEATS]]);
});

test('TB-02 two files claiming the same seat are rejected; one role may hold several seats', () => {
  const load = roles.parseRoleFiles([
    roleFile('a.md', header('a', 'seats: [dialog, close]')), roleFile('b.md', header('b', 'seats: [dialog]')),
  ], deps);
  assert.deepEqual(load.problems, ['.mori/agents/b.md: seat "dialog" is also claimed by .mori/agents/a.md']);
  assert.deepEqual(load.holders, { dialog: 'mori', create: 'mori', close: 'mori' });
  const both = roles.parseRoleFiles([roleFile('lead.md', header('lead', 'seats: [create, dialog]'))], deps);
  assert.deepEqual(both.holders, { dialog: 'lead', create: 'lead', close: 'mori' });
  assert.equal(both.merged, true);
  assert.deepEqual(both.roles.map((role) => role.seats), [['dialog', 'create'], ['close']]);
});

// ---- TB-50 next 与 assignee 的枚举 ----

test('TB-50 next drops the session itself, keeps mori, writes <name>: <description> with seat notes', () => {
  const { roles: list } = teamOf62();
  const next = roles.nextEnum(list, 'executor');
  assert.deepEqual(next.values, ['chat', 'planner', 'reviewer', 'mori']);
  assert.equal(next.description, [
    'chat (dialog): The chat role', 'planner (create, close): The planner role', 'reviewer: The reviewer role',
    BASE_LINE,
  ].join('\n'));
  assert.deepEqual(roles.nextEnum(list, 'planner').values, ['chat', 'executor', 'reviewer', 'mori']);
  assert.deepEqual(roles.nextEnum(list, 'mori').values, ['chat', 'executor', 'planner', 'reviewer']);
});

test('TB-50 assignee lists every role including mori', () => {
  const assignee = roles.assigneeEnum(teamOf62().roles);
  assert.deepEqual(assignee.values, ['chat', 'executor', 'planner', 'reviewer', 'mori']);
  assert.equal(assignee.description.split('\n')[1], 'executor: The executor role');
});

test('TB-50 only the base agent: no next; assignee is mori with all three seats', () => {
  const { roles: list } = roles.parseRoleFiles([], deps);
  assert.equal(roles.nextEnum(list, 'mori'), null);
  assert.deepEqual(roles.assigneeEnum(list), { values: ['mori'], description: `mori (dialog, create, close): ${
    roles.BASE_ROLE_DESCRIPTION}` });
  const alone = single('executor').roles;
  assert.deepEqual(roles.nextEnum(alone, 'executor'),
    { values: ['mori'], description: `mori (dialog, create, close): ${roles.BASE_ROLE_DESCRIPTION}` });
  assert.deepEqual(roles.nextEnum(alone, 'mori'), { values: ['executor'], description: 'executor: The executor role' });
});

// ---- §8.1 各种会话的工具（file-system-permissions.md §8.6：instanceTools 与用户会话的职责工具） ----

const TASK_BOARD = ['board_read', 'read_session', 'agent_message', 'task_handoff'];
const CREATE_BOARD = ['board_read', 'read_session', 'agent_message', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog'];
const CLOSE_BOARD = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_close'];
/** 碰文件的部分：pi 设置的默认工具加 mcp__*，五种实例都一样（§8.6） */
const FILE_TOOLS = [...DEFAULTS, 'mcp__*'];

test('TB-24 every instance kind has the default tools and mcp__*, then its TaskBoard tools; no role or read-only '
  + 'switch', () => {
  const expected = { task: TASK_BOARD, create: CREATE_BOARD, close: CLOSE_BOARD, ask: ['board_read', 'read_session'],
    subscription: ['board_read', 'read_session', 'agent_message'] };
  for (const [kind, board] of Object.entries(expected)) {
    assert.deepEqual(roles.instanceTools(kind, DEFAULTS, true), [...FILE_TOOLS, ...board], kind);
  }
  assert.equal(roles.instanceTools.length, 3, 'kind, pi defaults and team mode only: a write: false task is narrowed '
    + 'per call, not by its tools');
  assert.deepEqual(roles.instanceTools('task', ['read', 'bash', 'ls', 'find', 'read'], true),
    ['read', 'bash', 'ls', 'find', 'mcp__*', ...TASK_BOARD], 'the pi defaults as set, once each, in order');
});

test('TB-09 create and close instances keep the default tools and MCP; they add only their TaskBoard tools', () => {
  assert.deepEqual(roles.instanceTools('create', DEFAULTS, true), [...FILE_TOOLS, ...CREATE_BOARD]);
  assert.deepEqual(roles.instanceTools('close', DEFAULTS, true), [...FILE_TOOLS, ...CLOSE_BOARD]);
});

test('TB-09 the user session registers board_read, read_session, agent_message; merged, the create tools (§8.6)',
  () => {
  assert.deepEqual(roles.userTeamTools(false), ['board_read', 'read_session', 'agent_message']);
  assert.deepEqual(roles.userTeamTools(true), CREATE_BOARD);
  for (const merged of [false, true]) {
    const names = roles.userTeamTools(merged);
    assert.ok(names.includes('agent_message'), `agent_message (merged: ${merged})`);
    assert.equal(names.some((name) => FILE_TOOLS.includes(name)), false, 'duty tools only, no file tools');
  }
});

test('TB-03 team mode off: other roles exist only with role files (then the dialog gets agent_message)', () => {
  assert.equal(roles.hasOtherRoles(roles.parseRoleFiles([], deps).roles), false);
  const executor = roles.parseRoleFiles([roleFile('executor.md', header('executor'))], deps);
  assert.equal(roles.hasOtherRoles(executor.roles), true);
  const chatOnly = roles.parseRoleFiles([roleFile('chat.md', header('chat', 'seats: [dialog]'))], deps);
  assert.equal(roles.hasOtherRoles(chatOnly.roles), true);
});

test('TB-04 a one-time question instance has the default tools and MCP, no agent_message; off mode no TaskBoard '
  + 'tools', () => {
  assert.deepEqual(roles.instanceTools('ask', DEFAULTS, false), FILE_TOOLS);
  assert.deepEqual(roles.instanceTools('ask', DEFAULTS, true), [...FILE_TOOLS, 'board_read', 'read_session']);
});

test('TB-33 a subscription instance has the default tools and MCP and can leave messages', () => {
  assert.deepEqual(roles.instanceTools('subscription', DEFAULTS, true),
    [...FILE_TOOLS, 'board_read', 'read_session', 'agent_message']);
});

/** @brief 在 dir/.mori/agents 下写一个只有 name、description 的角色文件 <name>.md。 */
function writeRole(dir, name, ...lines) {
  mkdirSync(join(dir, '.mori', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.mori', 'agents', `${name}.md`), roleFile(`${name}.md`, header(name, ...lines)).text);
}

test('TB-01 loadRoles in a worktree session reads .mori/agents of the main folder (file-system.md §11.7)',
  async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mori-roles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeRole(root, 'executor', 'seats: [close]');
  writeRole(join(root, 'app'), 'reviewer');
  const worktree = join(root, '.mori', 'worktrees', 'fix-login-a1b2c3');
  // worktree 里另有一份不同的角色文件（synthetic）：不读它；主文件夹里有、worktree 里没有的照样生效
  writeRole(worktree, 'stray');
  writeRole(join(worktree, 'app'), 'stray');
  const names = (load) => load.roles.map((role) => role.name);
  const top = await roles.loadRoles(worktree, deps);
  assert.deepEqual([top.problems, names(top), top.holders.close], [[], ['executor', 'mori'], 'executor']);
  const sub = await roles.loadRoles(join(worktree, 'app'), deps);
  assert.deepEqual([sub.problems, names(sub)], [[], ['reviewer', 'mori']], 'a subfolder session: <root>/app');
  assert.deepEqual(names(await roles.loadRoles(root, deps)), ['executor', 'mori'], 'not in a worktree: as before');
});

// ---- §12.1 候选、§9.5 订阅 ----

test('TB-38 role candidates: the role models in order, otherwise the session range', () => {
  const { roles: list } = teamOf62();
  assert.deepEqual(roles.roleCandidates(roles.findRole(list, 'planner'), 'deepseek'), ['strong']);
  assert.deepEqual(roles.roleCandidates(roles.findRole(list, 'executor'), 'deepseek'), ['deepseek']);
  assert.deepEqual(roles.roleCandidates(roles.findRole(list, 'mori'), 'glm/glm-4.6'), ['glm/glm-4.6']);
  assert.deepEqual(roles.roleCandidates(roles.findRole(list, 'mori'), null), []);
  assert.deepEqual(roles.findRole(list, 'planner').requires, [{ kind: 'tool_calling' }]);
  assert.equal(roles.findRole(list, 'reviewer').differFromAuthor, true);
  assert.equal(roles.findRole(list, 'nobody'), null);
});

test('TB-33 subscription filters: ruled_out and outcome must both hold; any entry may match', () => {
  const load = roles.parseRoleFiles([
    roleFile('memory.md', header('memory', 'subscribe: [{ request_closed: { ruled_out: true } }]')),
    roleFile('audit.md', header('audit', 'subscribe: [{ request_closed: { outcome: [failed, cancelled] } }]')),
    roleFile('both.md', header('both', 'subscribe: [{ request_closed: { ruled_out: false, outcome: [done] } }]')),
    roleFile('any.md', header('any', 'subscribe: [request_closed]')),
    roleFile('either.md', header('either',
      'subscribe: [{ request_closed: { outcome: [done] } }, { request_closed: { ruled_out: true } }]')),
    roleFile('none.md', header('none')),
  ], deps);
  assert.deepEqual(load.problems, []);
  const matches = (name, status, ruledOut) => roles.subscriptionMatches(roles.findRole(load.roles, name),
    { status, ruledOut });
  assert.equal(matches('memory', 'done', ['Approach A fails']), true);
  assert.equal(matches('memory', 'done', []), false);
  assert.equal(matches('memory', 'open', ['Approach A fails']), false);
  assert.equal(matches('audit', 'done', []), false);
  assert.equal(matches('audit', 'failed', []), true);
  assert.equal(matches('audit', 'cancelled', ['x']), true);
  assert.equal(matches('both', 'done', []), true);
  assert.equal(matches('both', 'done', ['x']), false);
  assert.equal(matches('both', 'failed', []), false);
  for (const status of ['done', 'failed', 'cancelled']) assert.equal(matches('any', status, []), true);
  assert.equal(matches('any', 'open', []), false);
  assert.equal(matches('either', 'failed', ['x']), true);
  assert.equal(matches('either', 'failed', []), false);
  assert.equal(matches('none', 'done', ['x']), false);
});
