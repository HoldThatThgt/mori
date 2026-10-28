// 收窄的纯函数（docs/specs/file-system-permissions.md §8.2–§8.4、§8.9，原文见 file-system.md §14；验收 §19.2 FS-56、
// FS-58）：limits.ts 的 parseLimits、askLimits、limitsText 与 checkLimits。checkLimits 的输入是路径闸的那一次分类
// （pathGate.ts 的 classifyCall，在临时目录里的项目上算；cwd 为 call.realCwd）。参数与调用都是测试写的（synthetic）。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import { quietlySync, tempProject } from './gate-helpers.mjs';

const L = await loadKernelModule('src/kernel/limits.ts');
const G = await loadKernelModule('src/kernel/pathGate.ts');

const project = tempProject('mori-fs-limits-');
const { root, cwd } = project;
after(() => project.remove());

/** 拒绝原文的开头（§8.3） */
const LEADS = {
  task: 'Not allowed for this task',
  ask: 'Not allowed for this question',
  create: 'Not allowed while deciding requests',
  close: 'Not allowed while closing a request',
  subscription: 'Not allowed in a subscription',
};
/** 协作模式下对话会话与合并会话的整句（§8.3） */
const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';
/** 规格写的工作路径（parseLimits 是纯函数） */
const SPEC_CWD = 'C:\\w\\proj';

/** @brief parseLimits 在 SPEC_CWD 上的结果。 */
const parse = (raw) => L.parseLimits(raw, SPEC_CWD);

/** @brief 一个调用在这组收窄下的 checkLimits 结果（分类截下 realTarget 的日志）。 */
function check(owner, limits, toolName, input) {
  const call = quietlySync(() => G.classifyCall(toolName, input, cwd)).value;
  return L.checkLimits({ owner, limits }, call, call.realCwd);
}

/** @brief task 的拒绝原文。 */
const taskDenied = (rule) => `${LEADS.task}: ${rule}.`;

// ---- FS-56 limits 的解析 ----

test('FS-56 true is the same as leaving an item out; unknown keys and a missing limits give no limits', () => {
  // 空的 write_paths 由 pi 的 schema（minItems 1）在 parseLimits 之前拒绝（§8.2 第 2 条），这一层不测
  for (const raw of [undefined, null, {}, { write: true, commands: true, mcp: true },
    { read_only: true, foo: false }]) {
    assert.deepEqual(parse(raw), { limits: {} }, JSON.stringify(raw));
  }
});

// 2026-10-28 负责人定照 Claude 的做法：write: false 不再包含命令（file-system-permissions.md §8.2 第 3 步的注、§8.11），
// commands: false 照留
test('FS-56 write: false drops write_paths (already included) and keeps commands: false', () => {
  assert.deepEqual(parse({ write: false, commands: false, write_paths: ['src'] }),
    { limits: { write: false, commands: false } });
  assert.deepEqual(parse({ write: false, write_paths: ['src'] }), { limits: { write: false } });
  assert.deepEqual(parse({ write: false, mcp: false }), { limits: { write: false, mcp: false } });
  assert.deepEqual(parse({ write: false, write_paths: ['/abs', '..'] }), { limits: { write: false } },
    'dropped before they are checked');
});

test('FS-56 commands: false, mcp: false and write_paths are kept on their own', () => {
  assert.deepEqual(parse({ commands: false }), { limits: { commands: false } });
  assert.deepEqual(parse({ mcp: false }), { limits: { mcp: false } });
  assert.deepEqual(parse({ commands: false, mcp: false, write_paths: ['src'] }),
    { limits: { commands: false, mcp: false, writePaths: ['src/'] } });
});

test('FS-56 write_paths are normalized: \\ to /, a trailing /, duplicates and contained items removed', () => {
  const cases = [
    [['src\\a'], ['src/a/']], [['src/'], ['src/']], [[' docs '], ['docs/']], [['src', 'src/'], ['src/']],
    [['src/a', 'src'], ['src/']], [['src', 'src/a'], ['src/']], [['a/./b', 'a\\b\\'], ['a/b/']],
    [['src/../docs'], ['docs/']], [['README.md'], ['README.md/']], [['srcx', 'src'], ['srcx/', 'src/']],
    [['docs', 'src'], ['docs/', 'src/']], [['..notes'], ['..notes/']],
  ];
  for (const [given, expected] of cases) {
    assert.deepEqual(parse({ write_paths: given }), { limits: { writePaths: expected } }, JSON.stringify(given));
  }
  const mixed = parse({ write_paths: ['src', 'src/a', 'docs/x/', 'docs'] }).limits.writePaths;
  assert.deepEqual([...mixed].sort(), ['docs/', 'src/']);
});

test('FS-56 absolute, ~, outside and whole-directory write_paths give the §8.2 texts', () => {
  const relative = (p) => `limits.write_paths: "${p}" must be relative to the working directory.`;
  const outside = (p) => `limits.write_paths: "${p}" is outside the working directory.`;
  const whole = (p) => `limits.write_paths: "${p}" is the whole working directory; leave write_paths out.`;
  const cases = [
    ['C:\\x', relative('C:\\x')], ['d:/x', relative('d:/x')], ['D:rel', relative('D:rel')], ['\\x', relative('\\x')],
    ['/x', relative('/x')], [' /x ', relative('/x')], ['~/x', relative('~/x')], ['~', relative('~')],
    ['\\\\server\\share', relative('\\\\server\\share')],
    ['../x', outside('../x')], ['..', outside('..')], ['src/../..', outside('src/../..')],
    ['.', whole('.')], ['src/..', whole('src/..')], ['./', whole('./')],
  ];
  for (const [item, error] of cases) {
    assert.deepEqual(parse({ write_paths: ['src', item] }), { error }, item);
  }
  assert.deepEqual(parse({ write_paths: ['src', '../x', '/y'] }), { error: outside('../x') }, 'the first bad item');
});

test('FS-56 NO_LIMITS, PROGRAM_LIMITS and TEAM_DIALOG_LIMITS', () => {
  assert.deepEqual(L.NO_LIMITS, {});
  assert.deepEqual(L.PROGRAM_LIMITS, { write: false });
  assert.deepEqual(L.TEAM_DIALOG_LIMITS, { write: false, mcp: false });
});

// 2026-10-28：commands: false 同 mcp: false 一样继承（file-system-permissions.md §8.3 的注）
test('FS-56 askLimits: always write: false; commands: false and mcp: false from the asker or the message; nothing can '
  + 'widen it', () => {
  assert.deepEqual(L.askLimits(L.NO_LIMITS, {}), { write: false });
  assert.deepEqual(L.askLimits({ mcp: false }, {}), { write: false, mcp: false });
  assert.deepEqual(L.askLimits({}, { mcp: false }), { write: false, mcp: false });
  assert.deepEqual(L.askLimits(L.TEAM_DIALOG_LIMITS, {}), { write: false, mcp: false });
  assert.deepEqual(L.askLimits({ writePaths: ['src/'], commands: false }, {}), { write: false, commands: false });
  assert.deepEqual(L.askLimits({}, { commands: false, mcp: false }), { write: false, commands: false, mcp: false });
  assert.deepEqual(L.askLimits(L.NO_LIMITS, parse({ write: true, mcp: true }).limits), { write: false });
});

test('FS-56 limitsText: §14 parts in order write, commands, write_paths, mcp joined with "; "; none gives null', () => {
  const cases = [
    [{}, null],
    // 2026-10-28 负责人定照 Claude 的做法（file-system-permissions.md §8.11，file-system.md §14 的 2026-10-28 又注）
    [{ write: false }, 'no file changes'],
    [{ write: false, commands: false }, 'no file changes; no commands'],
    [{ commands: false }, 'no commands'],
    [{ writePaths: ['src/', 'docs/'] }, 'writes limited to src/, docs/ and .work/'],
    [{ mcp: false }, 'no MCP or extension tools'],
    [{ write: false, mcp: false }, 'no file changes; no MCP or extension tools'],
    [{ mcp: false, writePaths: ['src/'], commands: false },
      'no commands; writes limited to src/ and .work/; no MCP or extension tools'],
  ];
  for (const [limits, text] of cases) assert.equal(L.limitsText(limits), text, JSON.stringify(limits));
});

// ---- FS-58 检查与拒绝原文 ----

/** 读取类工具（目标在工作路径外也一样） */
const READS = [['read', { path: '../x' }], ['grep', { pattern: 'a', path: 'C:\\' }], ['find', { pattern: '*' }],
  ['ls', { path: '..' }]];

test('FS-58 reading tools are never denied, whatever the limits', () => {
  for (const limits of [{ write: false }, { commands: false }, { mcp: false }, { writePaths: ['src/'] },
    { write: false, mcp: false }]) {
    for (const [tool, input] of READS) {
      assert.equal(check('task', limits, tool, input), null, `${tool} ${JSON.stringify(limits)}`);
    }
  }
});

// 2026-10-28 负责人定照 Claude 的做法（file-system-permissions.md §8.4、§8.11）：只读会话（owner 不是 dialog）的命令都不被
// write: false 拒绝，改文件为 no file changes；只有 ls、git status 的命令在对话会话的 TEAM_DIALOG_LIMITS 下照旧拒绝（见下面的
// RELAY_ONLY）
test('FS-58 write: false denies edit and write (.work too) with no file changes; not commands, ls, read, MCP', () => {
  const denied = taskDenied('no file changes');
  for (const [tool, input] of [['edit', { path: 'src/a.ts', edits: [] }], ['write', { path: 'a.txt' }],
    ['write', { path: '.work/n.md' }], ['edit', { edits: [] }], ['write', { content: 'x' }]]) {
    assert.equal(check('task', { write: false }, tool, input), denied, `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input] of [...READS, ['mcp__srv__tool', {}], ['deploy_check', {}], ['bash', { command: 'ls' }],
    ['bash', { command: 'git status' }], ['powershell', { command: 'Get-ChildItem' }],
    ['bash', { command: 'npm test' }], ['bash', { command: 'echo x > .work/a' }],
    ['powershell', { command: 'Set-Content a.txt x' }], ['bash', {}]]) {
    assert.equal(check('task', { write: false }, tool, input), null, tool);
  }
});

test('FS-58 commands: false denies only commands', () => {
  for (const tool of ['bash', 'powershell']) {
    assert.equal(check('task', { commands: false }, tool, { command: 'ls' }), taskDenied('no commands'), tool);
  }
  for (const [tool, input] of [['edit', { path: 'a.ts' }], ['write', { path: '../x.md' }], ['mcp__srv__tool', {}],
    ['read', { path: 'a' }]]) {
    assert.equal(check('task', { commands: false }, tool, input), null, tool);
  }
});

test('FS-58 mcp: false denies MCP and extension tools (other), not edit or write without a path', () => {
  for (const tool of ['mcp__srv__tool', 'deploy_check']) {
    assert.equal(check('task', { mcp: false }, tool, {}), taskDenied('no MCP or extension tools'), tool);
  }
  for (const [tool, input] of [['edit', { edits: [] }], ['write', {}], ['bash', { command: 'x' }],
    ['edit', { path: 'a' }], ['read', {}]]) {
    assert.equal(check('task', { mcp: false }, tool, input), null, tool);
  }
});

test('FS-58 write_paths: writes outside the list are denied; .work/ and the list pass (any case, trailing dot)', () => {
  const limits = { writePaths: ['src/'] };
  const outsideOf = (target) => taskDenied(`writes are limited to src/ and .work/; ${target} is outside them`);
  assert.equal(check('task', limits, 'edit', { path: 'docs/a.md' }), outsideOf('docs/a.md'));
  assert.equal(check('task', limits, 'bash', { command: 'echo x > docs/b.md' }), outsideOf('docs/b.md'));
  assert.equal(check('task', limits, 'write', { path: '../x.md' }), outsideOf(join(root, 'x.md')));
  assert.equal(check('task', limits, 'bash', { command: 'echo 1 > src/a; echo 2 > docs/b; echo 3 > lib/c' }),
    outsideOf('docs/b'), 'the first target out of bounds');
  for (const [tool, input] of [['write', { path: 'src/a.ts' }], ['edit', { path: 'SRC/a.ts' }],
    ['write', { path: 'src./b.ts' }], ['write', { path: '.work/n.md' }], ['bash', { command: 'echo x > src/a.txt' }],
    ['bash', { command: 'echo x > .work/tmp/a' }], ['bash', { command: 'npm test' }],
    ['bash', { command: 'cd src && npm i' }], ['edit', { path: 'src/.git/config' }]]) {
    assert.equal(check('task', limits, tool, input), null, `${tool} ${JSON.stringify(input)}`);
  }
});

test('FS-58 write_paths: a target Mori can\'t resolve, a leave or an unanalyzed command is denied', () => {
  const limits = { writePaths: ['src/', 'docs/'] };
  const unsure = taskDenied("writes are limited to src/, docs/ and .work/, and Mori can’t tell where this writes");
  for (const [tool, input] of [['bash', { command: 'echo x > $OUT/a' }], ['bash', { command: 'cd .. && npm i' }],
    ['bash', { command: 'echo "abc' }], ['edit', { edits: [] }], ['write', { content: 'x' }]]) {
    assert.equal(check('task', limits, tool, input), unsure, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(check('task', limits, 'write', { path: 'lib/a.ts' }),
    taskDenied('writes are limited to src/, docs/ and .work/; lib/a.ts is outside them'));
});

test('FS-58 a write_paths item may be a file: it and everything under it are inside', () => {
  const limits = { writePaths: ['README.md/'] };
  assert.equal(check('task', limits, 'write', { path: 'README.md' }), null);
  assert.equal(check('task', limits, 'write', { path: 'readme.md' }), null);
  assert.equal(check('task', limits, 'write', { path: 'docs/a' }),
    taskDenied('writes are limited to README.md/ and .work/; docs/a is outside them'));
});

test('FS-58 every lead of §8.3, and the whole RELAY_ONLY sentence for the dialog', () => {
  for (const [owner, lead] of Object.entries(LEADS)) {
    assert.equal(check(owner, L.PROGRAM_LIMITS, 'write', { path: 'a.txt' }), `${lead}: no file changes.`);
  }
  for (const [tool, input] of [['write', { path: 'a.txt' }], ['bash', { command: 'ls' }], ['mcp__srv__tool', {}],
    ['bash', { command: 'git status' }]]) {
    assert.equal(check('dialog', L.TEAM_DIALOG_LIMITS, tool, input), RELAY_ONLY, tool);
  }
  assert.equal(check('dialog', L.TEAM_DIALOG_LIMITS, 'read', { path: 'a' }), null);
});

test('FS-58 the rule order: write before mcp, commands before write_paths; §14 examples word for word', () => {
  assert.equal(check('task', { commands: false, writePaths: ['src/'] }, 'bash', { command: 'echo x > docs/a' }),
    taskDenied('no commands'));
  assert.equal(check('task', { write: false, mcp: false }, 'write', { path: 'a.txt' }), taskDenied('no file changes'));
  assert.equal(check('task', { write: false, commands: false }, 'bash', { command: 'ls' }), taskDenied('no commands'));
  assert.equal(check('task', { write: false, mcp: false }, 'bash', {}), null, 'a bash call is not an MCP tool');
  assert.equal(check('ask', L.askLimits({ mcp: false }, {}), 'mcp__srv__tool', {}),
    'Not allowed for this question: no MCP or extension tools.');
  assert.equal(check('close', L.PROGRAM_LIMITS, 'edit', { path: 'a.ts' }),
    'Not allowed while closing a request: no file changes.');
  assert.equal(check('task', { writePaths: ['src/'] }, 'edit', { path: 'docs/a.md' }),
    'Not allowed for this task: writes are limited to src/ and .work/; docs/a.md is outside them.');
  for (const [tool, input] of [['bash', { command: 'rm -rf ..' }], ['write', { path: '../x' }], ['mcp__s__t', {}]]) {
    assert.equal(check('task', L.NO_LIMITS, tool, input), null, 'no limits deny nothing');
  }
});
