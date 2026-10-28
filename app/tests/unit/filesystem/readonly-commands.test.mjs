// 只读命令照 Claude 的做法（2026-10-28 负责人定：“follow claude's design on tool permission related issues”；
// docs/specs/file-system-permissions.md §6.1、§6.7、§7.5 的注、§7.7 末尾第 5、6 条、§8.3、§8.4、§8.11；验收
// file-system.md §19.2 FS-120、FS-121）：scanVerdict 对变量与空设备的判断，路径闸在每种会话、每种模式下放行只读命令，
// 只读会话里不是只读命令的命令照常按权限模式出卡或放行，askLimits 与 parseLimits 照留 commands: false。
// 路径闸用 gate-helpers.mjs 的假 pi；命令、调用与收窄都是手写的（synthetic）。不连模型，也不起 Electron。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import { NOBODY_HEAD, REJECTED_TEXT, STOP_TEXT, fakeSession, tempProject } from './gate-helpers.mjs';

const [S, L, approval] = await Promise.all(['src/kernel/commandScan.ts', 'src/kernel/limits.ts',
  'src/kernel/approval.ts'].map((path) => loadKernelModule(path)));
const { ApprovalPolicy } = approval;

const project = tempProject('mori-fs-readonly-commands-');
const { cwd } = project;
after(() => project.remove());

/** 拒绝原文的开头（file-system-permissions.md §8.3） */
const LEADS = {
  task: 'Not allowed for this task', ask: 'Not allowed for this question',
  create: 'Not allowed while deciding requests', close: 'Not allowed while closing a request',
  subscription: 'Not allowed in a subscription',
};
/** 协作模式下对话会话的整句（§8.3） */
const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';

// ---- FS-120 只读命令里的变量 ----

/** 给不安全的变量设值的（§7.7 末尾第 5 条），按 shell */
const SETS_UNSAFE = {
  bash: ['GIT_EXTERNAL_DIFF=x git diff', 'LESSOPEN=x less a', 'PATH=/tmp ls', 'X=1', 'x=1; echo $x',
    'export PATH=/x', 'export LESSOPEN=x; less a', 'declare -x A=1', 'local B=2', 'env FOO=1 ls',
    'printf -v x %s a', 'wait -p x'],
  powershell: ["$env:PATH = 'x'; Get-ChildItem", "$env:Path += ';x'", "${env:GIT_EXTERNAL_DIFF}='x'; git diff",
    "$env:FOO='1'"],
};
/** 设、清掉、导出、声明、读进或循环取值 PATH、IFS 的（第 6 条） */
const TOUCHES_SPECIAL = ['unset PATH', 'unset IFS', 'export PATH', 'declare -x IFS', 'local IFS', 'read IFS',
  'IFS= read -r line', 'for PATH in a; do ls; done', 'select IFS in a; do ls; done', 'env -u PATH ls', 'env -i ls',
  'echo $((PATH=1))', '(( IFS = 2 ))', 'export "$n"'];
/** 给安全的变量设值、只循环或读进普通变量的：仍是只读命令 */
const STILL_READ_ONLY = {
  bash: ['LANG=C ls', 'LC_ALL=C sort a', 'NO_COLOR=1 git status', 'NODE_ENV=test ls', 'TZ=UTC date', 'lang=C ls',
    'export LANG=C; ls', 'env LANG=C ls', 'for f in a b; do cat $f; done', 'read line', 'unset FOO',
    'env -u FOO ls', 'for ((i=0; i<3; i++)); do echo $i; done'],
  powershell: ["$env:NO_COLOR = '1'; git status", "$env:LC_ALL='C'; Get-ChildItem", '$x = 1; Get-ChildItem'],
};

/** @brief 一条命令的 scanVerdict（规格写的工作路径，纯函数）。 */
const verdict = (command, shell) => S.scanVerdict({ command, shell, cwd: 'C:\\w\\proj', vars: {} });

test('FS-120 setting a variable that is not safe makes a command not read-only (bash and PowerShell)', () => {
  for (const [shell, list] of Object.entries(SETS_UNSAFE)) {
    for (const command of list) assert.equal(verdict(command, shell).readOnly, false, `${shell}: ${command}`);
  }
  assert.deepEqual([...S.SAFE_VARIABLES], ['LANG', 'NO_COLOR', 'NODE_ENV', 'TZ']);
});

test('FS-120 setting, unsetting, exporting, reading or looping over PATH or IFS makes a command not read-only', () => {
  for (const command of TOUCHES_SPECIAL) assert.equal(verdict(command, 'bash').readOnly, false, command);
  assert.deepEqual([...S.SPECIAL_VARIABLES], ['PATH', 'IFS']);
});

test('FS-120 safe variables (LANG, LC_*, NO_COLOR, NODE_ENV, TZ) and plain loop variables keep it read-only', () => {
  for (const [shell, list] of Object.entries(STILL_READ_ONLY)) {
    for (const command of list) assert.equal(verdict(command, shell).readOnly, true, `${shell}: ${command}`);
  }
});

test('FS-120 PowerShell > NUL is not a write and stays read-only; Git Bash > NUL writes a file named NUL', () => {
  for (const command of ['Get-ChildItem > NUL', 'Get-ChildItem > nul', 'Get-ChildItem 2> NUL']) {
    assert.deepEqual(verdict(command, 'powershell'), { result: { ok: true, writes: [], leaves: [] }, readOnly: true },
      command);
  }
  const bash = verdict('ls > NUL', 'bash');
  assert.equal(bash.readOnly, false);
  assert.deepEqual(bash.result.ok && bash.result.writes.map((write) => [write.form, write.path]),
    [['>', 'C:\\w\\proj\\NUL']]);
});

test('FS-120 the variable rules change only readOnly: result is the scanCommand result item by item', () => {
  const all = [...SETS_UNSAFE.bash, ...TOUCHES_SPECIAL, ...STILL_READ_ONLY.bash].map((command) => ['bash', command])
    .concat([...SETS_UNSAFE.powershell, ...STILL_READ_ONLY.powershell].map((command) => ['powershell', command]));
  for (const [shell, command] of all) {
    const input = { command, shell, cwd, vars: { TEMP: join(cwd, '.work', 'tmp') } };
    assert.deepEqual(S.scanVerdict(input).result, S.scanCommand(input), `${shell}: ${command}`);
  }
});

// ---- FS-121 只读命令不问 ----

/** 只读命令 */
const READ_ONLY = [['bash', 'ls'], ['bash', 'git status'], ['bash', 'cat a.txt | wc -l'],
  ['powershell', 'Get-ChildItem']];
/** 不是只读命令的命令（第二条是 U71i 的写法，2026-10-28 起要批准） */
const OTHERS = [['bash', 'npm test'], ['bash', 'GIT_EXTERNAL_DIFF=x git diff']];

/** 没有收窄的会话的几种设置与不是只读命令的命令在它们下面的 gate */
const SETTINGS = [
  { name: 'Ask each time', policy: () => new ApprovalPolicy(), other: 'ask' },
  { name: 'Full access', policy: () => new ApprovalPolicy({ mode: 'full' }), other: 'full' },
  { name: 'after Allow for this session', other: 'session', policy: () => {
    const policy = new ApprovalPolicy();
    policy.allowSession('bash');
    return policy;
  } },
  { name: 'canAsk false', policy: () => new ApprovalPolicy({ canAsk: false }), other: 'deny' },
];

test('FS-121 a read-only command is free in every mode, after Allow for this session and when nobody can approve',
  async () => {
    for (const setting of SETTINGS) {
      for (const instance of [undefined, 'S.t1.executor']) {
        rmSync(join(cwd, '.work'), { recursive: true, force: true });
        const session = fakeSession(setting.policy(), { cwd, instance });
        for (const [tool, command] of READ_ONLY) {
          const step = session.run(tool, { command });
          const tag = `${setting.name} ${instance ?? 'user'}: ${command}`;
          assert.deepEqual([step.gates, step.request, await step.result], [['free'], undefined, undefined], tag);
        }
        assert.deepEqual([session.asked(), session.ended()], [[], []], setting.name);
        assert.equal(existsSync(join(cwd, '.work', 'tmp')), true, `${setting.name}: .work is prepared first`);
      }
    }
  });

test('FS-121 a command that is not read-only keeps its gate: ask, full, session, or deny when nobody can approve',
  async () => {
    for (const setting of SETTINGS) {
      const session = fakeSession(setting.policy(), { cwd });
      for (const [tool, command] of OTHERS) {
        const step = session.run(tool, { command });
        const tag = `${setting.name}: ${command}`;
        assert.deepEqual(step.gates, [setting.other], tag);
        if (setting.other === 'ask') {
          assert.equal(step.request.scope, 'inside', tag);
          session.gate.answer(step.request.requestId, 'reject');
          assert.deepEqual(await step.result, { block: true, reason: REJECTED_TEXT }, tag);
        } else if (setting.other === 'deny') {
          assert.ok((await step.result).reason.startsWith(NOBODY_HEAD), tag);
        } else assert.equal(await step.result, undefined, tag);
      }
    }
  });

test('FS-121 in a read-only session a command that is not read-only asks (onRequest), runs on Full access',
  async () => {
  for (const owner of Object.keys(LEADS)) {
    const policy = new ApprovalPolicy();
    const narrowing = () => ({ owner, limits: { write: false } });
    const session = fakeSession(policy, { cwd, instance: `S.${owner}.1`, kind: owner, narrowing });
    const asked = session.run('bash', { command: 'npm test' });
    assert.deepEqual(asked.gates, ['ask'], owner);
    assert.deepEqual([session.requests.length, asked.request.scope], [1, 'inside'], `${owner}: the Team gets it`);
    const outside = session.run('bash', { command: 'echo x > ../o.txt' });
    assert.deepEqual([outside.gates, outside.request.scope], [['ask'], 'outside'], owner);
    policy.setMode('full');
    assert.equal(await asked.result, undefined, `${owner}: switching to Full access allows it`);
    assert.deepEqual(session.ended().map((end) => [end.decision, end.by]), [['allow', 'full']], owner);
    session.gate.answer(outside.request.requestId, 'reject');
    assert.deepEqual(await outside.result, { block: true, reason: REJECTED_TEXT }, owner);
    const full = session.run('bash', { command: 'npm run build' });
    assert.deepEqual([full.gates, await full.result], [['full'], undefined], `${owner}: Full access runs it`);
  }
});

test('FS-121 narrowing still refuses: commands: false refuses read-only commands too, the dialog gets RELAY_ONLY, '
  + 'edit and write in a read-only session get no file changes', async () => {
  const policy = new ApprovalPolicy({ mode: 'full' });
  for (const [owner, lead] of Object.entries(LEADS)) {
    const narrowing = () => ({ owner, limits: { write: false, commands: false } });
    const session = fakeSession(policy, { cwd, instance: `S.${owner}.2`, kind: owner, narrowing });
    for (const [tool, input, reason] of [['bash', { command: 'ls' }, `${lead}: no commands.`],
      ['powershell', { command: 'Get-ChildItem' }, `${lead}: no commands.`],
      ['edit', { path: 'a.txt', edits: [] }, `${lead}: no file changes.`],
      ['write', { path: '.work/n.md', content: 'x' }, `${lead}: no file changes.`]]) {
      const step = session.run(tool, input);
      assert.deepEqual([step.gates, await step.result], [['deny'], { block: true, reason }], `${owner} ${tool}`);
    }
  }
  const dialog = fakeSession(policy, { cwd, narrowing: () => ({ owner: 'dialog', limits: L.TEAM_DIALOG_LIMITS }) });
  for (const command of ['ls', 'git status']) {
    const step = dialog.run('bash', { command });
    assert.deepEqual([step.gates, await step.result], [['deny'], { block: true, reason: RELAY_ONLY }], command);
  }
});

test('FS-121 while stopping a read-only command gets the stop text', async () => {
  const session = fakeSession(new ApprovalPolicy({ mode: 'full' }), { cwd });
  await session.gate.rejectForStop();
  assert.deepEqual(await session.run('bash', { command: 'ls' }, { announce: false }).result,
    { block: true, reason: STOP_TEXT });
  session.gate.endStop();
  assert.equal(await session.run('bash', { command: 'ls' }).result, undefined);
});

test('FS-121 askLimits inherits commands: false; parseLimits keeps it beside write: false', () => {
  assert.deepEqual(L.askLimits({ commands: false }, {}), { write: false, commands: false });
  assert.deepEqual(L.askLimits({}, { commands: false }), { write: false, commands: false });
  assert.deepEqual(L.askLimits({ write: false, mcp: false }, {}), { write: false, mcp: false });
  assert.deepEqual(L.parseLimits({ write: false, commands: false, write_paths: ['src'] }, 'C:\\w\\proj'),
    { limits: { write: false, commands: false } });
  assert.equal(L.limitsText({ write: false, commands: false }), 'no file changes; no commands');
});
