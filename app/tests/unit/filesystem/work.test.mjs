// .work 的建立与命令的临时目录（docs/specs/file-system-permissions.md §7.10、§7.11、§6.1 最后一条；验收
// file-system.md §19.2 FS-51、FS-52）：ensureWork 在临时目录里（synthetic 的项目，装了 git 时用真实 git 看
// git status）；workEnv、workVars、workTmp；shellTools 交给记下参数的 pi（synthetic，返回 synthetic 的定义）；
// resources.ts 的 toolSource 认出换过的 bash、powershell 与 mori-question。路径闸放行命令前建 .work、建不起来时拒绝。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import { REJECTED_TEXT, fakeSession, quietly, tempProject } from './gate-helpers.mjs';

const W = await loadKernelModule('src/kernel/workspace.ts');
const { ApprovalPolicy } = await loadKernelModule('src/kernel/approval.ts');
const { toolSource } = await loadKernelModule('src/kernel/resources.ts');

const project = tempProject('mori-fs-work-');
const { root } = project;
after(() => project.remove());

let folders = 0;
/** @brief 一个新的工作路径（synthetic），在 root 下。 */
function freshCwd() {
  folders += 1;
  const cwd = join(root, `p${folders}`);
  mkdirSync(cwd);
  return cwd;
}

/** @brief 工作路径里 .work 的内容：.gitignore 的文字与 .work 下的名字。 */
function workState(cwd) {
  const work = join(cwd, '.work');
  return { ignore: readFileSync(join(work, '.gitignore'), 'utf8'), names: readdirSync(work).sort(),
    tmp: statSync(join(work, 'tmp')).isDirectory() };
}

/** @brief ensureWork 失败时的结果与日志。 */
async function failing(cwd) {
  const { value, errors } = await quietly(() => W.ensureWork(cwd));
  return { value, errors };
}

/** @brief .work 建不起来时回给模型的原文（§14）。 */
function workDenial(reason) {
  return `Mori couldn’t prepare .work in the working directory (${reason}), so this call didn’t run. Tell the user.`;
}

// ---- FS-51 ensureWork ----

test('FS-51 without .work it creates .work/, a .gitignore of "*\\n" and .work/tmp', async () => {
  const cwd = freshCwd();
  assert.deepEqual(await W.ensureWork(cwd), { ok: true });
  assert.deepEqual(workState(cwd), { ignore: '*\n', names: ['.gitignore', 'tmp'], tmp: true });
});

test('FS-51 a second call changes nothing (the .gitignore is not rewritten)', async () => {
  const cwd = freshCwd();
  await W.ensureWork(cwd);
  const before = { ...workState(cwd), mtime: statSync(join(cwd, '.work', '.gitignore')).mtimeMs };
  assert.deepEqual(await W.ensureWork(cwd), { ok: true });
  assert.deepEqual({ ...workState(cwd), mtime: statSync(join(cwd, '.work', '.gitignore')).mtimeMs }, before);
});

test('FS-51 an existing .gitignore with other content is not overwritten', async () => {
  const cwd = freshCwd();
  mkdirSync(join(cwd, '.work'));
  writeFileSync(join(cwd, '.work', '.gitignore'), 'notes.md\n');
  assert.deepEqual(await W.ensureWork(cwd), { ok: true });
  assert.equal(readFileSync(join(cwd, '.work', '.gitignore'), 'utf8'), 'notes.md\n');
  assert.equal(statSync(join(cwd, '.work', 'tmp')).isDirectory(), true);
});

test('FS-51 after .work/tmp is deleted the next call puts it back', async () => {
  const cwd = freshCwd();
  await W.ensureWork(cwd);
  rmSync(join(cwd, '.work', 'tmp'), { recursive: true });
  assert.deepEqual(await W.ensureWork(cwd), { ok: true });
  assert.deepEqual(workState(cwd), { ignore: '*\n', names: ['.gitignore', 'tmp'], tmp: true });
});

test('FS-51 when the working directory does not exist nothing is created (no recursive mkdir)', async () => {
  const cwd = join(root, 'missing', 'worktree');
  assert.deepEqual(await W.ensureWork(cwd), { ok: true });
  assert.equal(existsSync(join(root, 'missing')), false);
});

test('FS-51 .work as a file and .work/tmp as a file give the §7.10 reasons and a log line', async () => {
  const fileWork = freshCwd();
  writeFileSync(join(fileWork, '.work'), 'x');
  const first = await failing(fileWork);
  assert.deepEqual(first.value, { ok: false, reason: '.work is a file, not a folder' });
  assert.deepEqual(first.errors, [`[kernel] couldn't prepare .work in ${fileWork}: .work is a file, not a folder`]);
  const fileTmp = freshCwd();
  mkdirSync(join(fileTmp, '.work'));
  writeFileSync(join(fileTmp, '.work', 'tmp'), 'x');
  const second = await failing(fileTmp);
  assert.deepEqual(second.value, { ok: false, reason: '.work/tmp is a file, not a folder' });
  assert.deepEqual(second.errors,
    [`[kernel] couldn't prepare .work in ${fileTmp}: .work/tmp is a file, not a folder`]);
});

test('FS-51 other errors give Node\'s error text; a junction to a folder counts as a folder', async () => {
  const dangling = freshCwd();
  mkdirSync(join(dangling, '.work'));
  mkdirSync(join(root, 'gone'));
  symlinkSync(join(root, 'gone'), join(dangling, '.work', 'tmp'), 'junction');
  rmdirSync(join(root, 'gone'));
  const { value } = await failing(dangling);
  assert.equal(value.ok, false);
  assert.match(value.reason, /^ENOENT: no such file or directory, stat '.*\\\.work\\tmp'$/);
  const linked = freshCwd();
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(linked, '.work'), 'junction');
  assert.deepEqual(await W.ensureWork(linked), { ok: true });
  assert.deepEqual(readdirSync(join(root, 'elsewhere')).sort(), ['.gitignore', 'tmp']);
});

test('FS-51 in a git repository, git status --porcelain -uall is empty after ensureWork', async () => {
  const cwd = freshCwd();
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const init = git('init', '-q');
  assert.equal(init.status, 0, `git init: ${init.error ?? init.stderr}`);
  assert.equal(git('status', '--porcelain', '-uall').stdout, '');
  assert.deepEqual(await W.ensureWork(cwd), { ok: true });
  writeFileSync(join(cwd, '.work', 'tmp', 'scratch.txt'), 'x');
  writeFileSync(join(cwd, '.work', 'n.md'), 'x');
  const status = git('status', '--porcelain', '-uall');
  assert.equal(status.status, 0);
  assert.equal(status.stdout, '');
});

test('FS-51 the path gate creates .work only for released commands and .work writes', async () => {
  const cwd = freshCwd();
  const policy = new ApprovalPolicy();
  const session = fakeSession(policy, { cwd });
  assert.equal(await session.run('read', { path: 'a.txt' }).result, undefined);
  const rejected = session.run('bash', { command: 'npm test' });
  session.gate.answer(rejected.request.requestId, 'reject');
  assert.deepEqual(await rejected.result, { block: true, reason: REJECTED_TEXT });
  assert.equal(existsSync(join(cwd, '.work')), false, 'reads and rejected calls leave no .work');
  const allowed = session.run('bash', { command: 'npm test' });
  session.gate.answer(allowed.request.requestId, 'allow');
  assert.equal(await allowed.result, undefined);
  assert.deepEqual(workState(cwd), { ignore: '*\n', names: ['.gitignore', 'tmp'], tmp: true });
  const other = freshCwd();
  const writer = fakeSession(new ApprovalPolicy(), { cwd: other });
  assert.equal(await writer.run('write', { path: '.work/n.md', content: 'x' }).result, undefined);
  assert.equal(readFileSync(join(other, '.work', '.gitignore'), 'utf8'), '*\n', '.gitignore before the write');
});

test('FS-51 when .work can\'t be prepared a released call is denied with the §14 text, even in Full access',
  async () => {
  const cwd = freshCwd();
  writeFileSync(join(cwd, '.work'), 'x');
  const session = fakeSession(new ApprovalPolicy({ mode: 'full' }), { cwd });
  for (const [tool, input] of [['bash', { command: 'npm test' }], ['powershell', { command: 'Get-ChildItem' }],
    ['write', { path: '.work/n.md', content: 'x' }]]) {
    const { value: result, errors } = await quietly(() => session.run(tool, input).result);
    assert.deepEqual(result, { block: true, reason: workDenial('.work is a file, not a folder') }, tool);
    assert.deepEqual(errors, [`[kernel] couldn't prepare .work in ${cwd}: .work is a file, not a folder`]);
  }
  assert.equal(await session.run('write', { path: 'a.txt' }).result, undefined, 'other writes need no .work');
  const asking = fakeSession(new ApprovalPolicy(), { cwd });
  const step = asking.run('bash', { command: 'npm test' });
  const { value: result } = await quietly(() => {
    asking.gate.answer(step.request.requestId, 'allow');
    return step.result;
  });
  assert.deepEqual(result, { block: true, reason: workDenial('.work is a file, not a folder') }, 'after the card too');
});

test('FS-51 a call stopped by narrowing creates no .work', async () => {
  const cwd = freshCwd();
  const narrowing = () => ({ owner: 'task', limits: { write: false } });
  const session = fakeSession(new ApprovalPolicy({ mode: 'full' }), { cwd, instance: 'S.t1.executor', narrowing });
  // 2026-10-28：只读会话里不是只读命令的命令的规则文字为 only read-only commands（file-system-permissions.md §8.11）
  for (const [tool, input, rule] of [['bash', { command: 'npm test' }, 'only read-only commands'],
    ['write', { path: '.work/n.md' }, 'no file changes or commands']]) {
    assert.deepEqual(await session.run(tool, input).result,
      { block: true, reason: `Not allowed for this task: ${rule}.` }, tool);
  }
  assert.equal(existsSync(join(cwd, '.work')), false);
});

// ---- FS-52 spawnHook 与工具替换 ----

test('FS-52 workTmp is <cwd>\\.work\\tmp and workVars gives it to TEMP, TMP and TMPDIR', () => {
  assert.equal(W.workTmp('C:\\w\\proj'), 'C:\\w\\proj\\.work\\tmp');
  assert.deepEqual(W.workVars('C:\\w\\proj'),
    { TEMP: 'C:\\w\\proj\\.work\\tmp', TMP: 'C:\\w\\proj\\.work\\tmp', TMPDIR: 'C:\\w\\proj\\.work\\tmp' });
});

test('FS-52 workEnv drops every spelling of TEMP, TMP, TMPDIR and CDPATH, sets the three, leaves the rest', () => {
  const env = { Temp: 'C:\\T', TMP: 'C:\\T2', tmpdir: '/x', TmpDir: '/y', temp: 'z', CDPATH: 'a', cdpath: 'b',
    CdPath: 'c', PATH: 'C:\\bin', Path: 'C:\\bin2', HOME: 'C:\\Users\\u', PI_FLAG: '1', TEMPLATE: 'keep' };
  const copy = { ...env };
  const context = { command: 'npm test', cwd: 'C:\\w\\proj', env };
  const result = W.workEnv(context);
  assert.equal(result.command, 'npm test');
  assert.equal(result.cwd, 'C:\\w\\proj');
  assert.deepEqual(env, copy, 'the env passed in is not changed');
  assert.notEqual(result.env, env);
  const tmp = 'C:\\w\\proj\\.work\\tmp';
  assert.deepEqual(result.env, { PATH: 'C:\\bin', Path: 'C:\\bin2', HOME: 'C:\\Users\\u', PI_FLAG: '1',
    TEMPLATE: 'keep', TEMP: tmp, TMP: tmp, TMPDIR: tmp });
  assert.deepEqual(Object.keys(result.env).filter((name) => name.toUpperCase() === 'CDPATH'), []);
  assert.deepEqual(W.workVars(context.cwd), { TEMP: tmp, TMP: tmp, TMPDIR: tmp }, 'workVars has the same values');
});

test('FS-52 workEnv follows the cwd given at spawn time and adds no CDPATH when there was none', () => {
  const result = W.workEnv({ command: 'ls', cwd: 'D:\\other', env: { PATH: 'p' } });
  assert.deepEqual(result.env, { PATH: 'p', TEMP: 'D:\\other\\.work\\tmp', TMP: 'D:\\other\\.work\\tmp',
    TMPDIR: 'D:\\other\\.work\\tmp' });
});

/** @brief synthetic 的工具定义：照 pi 的形状给出名字、说明与执行函数。 */
function syntheticDefinition(name) {
  return { name, label: name, description: `Run ${name} (synthetic)`, parameters: { type: 'object' },
    execute: async () => ({ content: [] }) };
}

test('FS-52 shellTools replaces bash and powershell: defaultActive false, spawnHook workEnv, bash keeps the settings',
  () => {
  const calls = [];
  const made = {};
  const recording = {
    createBashToolDefinition: (at, options) => {
      calls.push(['bash', at, options]);
      made.bash = syntheticDefinition('bash');
      return made.bash;
    },
    createPowerShellToolDefinition: (at, options) => {
      calls.push(['powershell', at, options]);
      made.powershell = syntheticDefinition('powershell');
      return made.powershell;
    },
  };
  const settings = { getShellCommandPrefix: () => 'set -e', getShellPath: () => 'C:\\Git\\bin\\bash.exe' };
  const cwd = 'C:\\w\\proj';
  const defs = W.shellTools(recording, cwd, settings);
  assert.deepEqual(defs.map((def) => [def.name, def.defaultActive]), [['bash', false], ['powershell', false]]);
  assert.deepEqual(calls.map(([name, at, options]) => [name, at, Object.keys(options).sort()]),
    [['bash', cwd, ['commandPrefix', 'shellPath', 'spawnHook']], ['powershell', cwd, ['spawnHook']]]);
  assert.equal(calls[0][2].commandPrefix, 'set -e');
  assert.equal(calls[0][2].shellPath, 'C:\\Git\\bin\\bash.exe');
  assert.equal(calls[0][2].spawnHook, W.workEnv);
  assert.equal(calls[1][2].spawnHook, W.workEnv);
  for (const [index, name] of ['bash', 'powershell'].entries()) {
    assert.deepEqual(defs[index], { ...made[name], defaultActive: false }, `${name}: the same definition otherwise`);
    assert.equal(made[name].defaultActive, undefined, 'pi\'s definition object is not changed');
  }
});

test('FS-52 toolSource: the replaced tools (source sdk) are Built-in; mori-question is Mori', () => {
  const synthetic = (name, path, source) => ({ name, sourceInfo: { path, source, scope: 'temporary',
    origin: 'top-level' } });
  assert.deepEqual(toolSource(synthetic('bash', '<sdk:bash>', 'sdk')), { source: 'builtin', sourceLabel: '' });
  assert.deepEqual(toolSource(synthetic('powershell', '<sdk:powershell>', 'sdk')),
    { source: 'builtin', sourceLabel: '' });
  assert.deepEqual(toolSource(synthetic('read', 'builtin:read', 'builtin')), { source: 'builtin', sourceLabel: '' });
  assert.deepEqual(toolSource(synthetic('ask_user_question', '<inline:mori-question>', 'inline')),
    { source: 'other', sourceLabel: 'Mori' });
});
