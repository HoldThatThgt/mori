// 路径闸的判断顺序与批准状态（docs/specs/file-system-permissions.md §6.1、§6.7–§6.11、§6.14、§6.15；验收
// file-system.md §19.2 FS-30–FS-35）：经 ApprovalPolicy / ApprovalGate 的 extension() 驱动 tool_call 处理器。
// pi 是假的（只收下 on 注册的处理器），ctx 只有 cwd、signal 与 sessionManager；工作路径是临时目录里的项目；
// 工具调用与参数都是测试写的（synthetic）。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, parse } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  NO_FOLDER, NOBODY_HEAD, REJECTED_TEXT, SESSION_NOT_INSIDE, STOP_TEXT, fakeSession, nobodyText, quietlySync,
  tempProject,
} from './gate-helpers.mjs';

const { ApprovalPolicy } = await loadKernelModule('src/kernel/approval.ts');
/** approval.forget 命令的处理（kernel/sessions.ts） */
const { forgetApproval } = await loadKernelModule('src/kernel/sessions.ts');

const project = tempProject('mori-fs-order-');
const { root, cwd } = project;
after(() => project.remove());
/** 工作路径外的目录（按目录放行时放行它） */
const OUT = join(root, 'out');

/** @brief 拒绝一个还挂着的请求，等 pi 拿到结果。 */
async function rejectPending(session, step) {
  session.gate.answer(step.request.requestId, 'reject');
  assert.deepEqual(await step.result, { block: true, reason: REJECTED_TEXT });
}

// ---- FS-30 判断顺序 ----

/**
 * §6.7 表的每种调用；row 是它在表里的那一行：duty、read、work（edit / write 写 .work）、inside、
 * outside（可按目录放行）、mixed（外面可按目录放行、工作路径里也写，§6.1 第 3 步 2026-10-27 注）、
 * unsure（unresolved / leaves / unanalyzed）、protected
 */
const CASES = [
  { tool: 'board_read', input: { request: 1 }, row: 'duty' },
  { tool: 'memory', input: { action: 'add', text: 'x' }, row: 'duty' },
  { tool: 'ask_user_question', input: { questions: [] }, row: 'duty' },
  { tool: 'read', input: { path: '../secret.txt' }, row: 'read' },
  { tool: 'ls', input: { path: 'C:\\' }, row: 'read' },
  { tool: 'write', input: { path: 'a.txt', content: 'x' }, row: 'inside' },
  { tool: 'edit', input: { path: 'src/a.ts', edits: [] }, row: 'inside' },
  { tool: 'write', input: { path: '.work/n.md', content: 'x' }, row: 'work' },
  { tool: 'edit', input: { path: '.work/x/.git/config', edits: [] }, row: 'work' },
  { tool: 'write', input: { path: '../out/a.md', content: 'x' }, row: 'outside' },
  { tool: 'edit', input: { path: '.git/config', edits: [] }, row: 'protected' },
  { tool: 'bash', input: { command: 'npm test' }, row: 'inside' },
  { tool: 'bash', input: { command: 'echo x > .work/a.txt' }, row: 'inside' },
  { tool: 'powershell', input: { command: 'Get-ChildItem' }, row: 'inside' },
  { tool: 'bash', input: { command: 'cp a.txt ../out/b.txt' }, row: 'outside' },
  { tool: 'bash', input: { command: 'cp a.txt ../out/ && rm -rf src' }, row: 'mixed' },
  { tool: 'bash', input: { command: 'echo x > $OUT/a.log' }, row: 'unsure' },
  { tool: 'bash', input: { command: 'cd .. && npm i' }, row: 'unsure' },
  { tool: 'bash', input: { command: 'echo "abc' }, row: 'unsure' },
  { tool: 'bash', input: { command: 'rm -rf .' }, row: 'protected' },
  // 放行的目录里的受保护路径：永远不被目录覆盖（§6.9）
  { tool: 'write', input: { path: '../out/.npmrc', content: 'x' }, row: 'protected' },
  { tool: 'bash', input: { command: 'echo x > ../out/.git/config' }, row: 'protected' },
  { tool: 'mcp__srv__tool', input: { path: '../x' }, row: 'inside' },
  { tool: 'deploy_check', input: {}, row: 'inside' },
  { tool: 'edit', input: { edits: [] }, row: 'inside' },
];

/** 每一行出卡时的 scope */
const ROW_SCOPE = { inside: 'inside', outside: 'outside', unsure: 'outside', protected: 'protected' };

/**
 * @brief §6.1 与 §6.7 的表：这一行在这种设置下的 mori.tool_gate。
 * @param row CASES 的 row
 * @param combo { mode, tool（工具名已按 Allow for this session 放行）, dir（目标目录已放行）, canAsk }
 */
function expectedGate(row, combo) {
  if (row === 'duty' || row === 'read' || row === 'work') return 'free';
  if (row === 'outside' && combo.dir) return 'dir';
  if (row === 'mixed' && combo.dir) return combo.mode === 'full' ? 'dir' : expectedGate('inside', combo);
  if (row !== 'inside') return combo.canAsk ? 'ask' : 'deny';
  if (combo.mode === 'full') return 'full';
  if (combo.tool) return 'session';
  return combo.canAsk ? 'ask' : 'deny';
}

/** @brief 出卡时请求的 scope：mixed 被目录覆盖（只在 Ask each time 下出卡）时按 inside。 */
function expectedScope(row, combo) {
  if (row === 'mixed') return combo.dir ? 'inside' : 'outside';
  return ROW_SCOPE[row];
}

/** @brief 在一种设置下跑一个调用，对照表检查 gate 与 pi 拿到的结果。 */
async function checkCell(item, combo) {
  const policy = new ApprovalPolicy({ mode: combo.mode, canAsk: combo.canAsk });
  if (combo.tool) policy.allowSession(item.tool);
  if (combo.dir) policy.allowDirs([OUT]);
  const session = fakeSession(policy, { cwd });
  const label = `${item.tool} ${JSON.stringify(item.input)} ${JSON.stringify(combo)}`;
  const want = expectedGate(item.row, combo);
  const step = quietlySync(() => session.run(item.tool, item.input)).value;
  assert.deepEqual(step.gates, [want], label);
  if (want === 'ask') {
    assert.equal(step.request?.scope, expectedScope(item.row, combo), label);
    if (item.row === 'protected') assert.deepEqual(step.request.allowDirs, [], `${label}: never by folder`);
    await rejectPending(session, step);
    return;
  }
  assert.equal(step.request, undefined, label);
  const result = await step.result;
  if (want === 'deny') assert.ok(result?.block && result.reason.startsWith(NOBODY_HEAD), label);
  else assert.equal(result, undefined, label);
}

for (const mode of ['ask', 'full']) {
  for (const tool of [false, true]) {
    for (const dir of [false, true]) {
      for (const canAsk of [true, false]) {
        const combo = { mode, tool, dir, canAsk };
        test(`FS-30 ${mode === 'ask' ? 'Ask each time' : 'Full access'}, tool allowed ${tool}, folder allowed ${dir}, `
          + `canAsk ${canAsk}: every call kind gets the §6.1 / §6.7 verdict`, async () => {
          for (const item of CASES) await checkCell(item, combo);
        });
      }
    }
  }
}

test('FS-30 narrowing (step 2) comes before folders, Full access, tool names and canAsk; duty and read pass',
  async () => {
  for (const canAsk of [true, false]) {
    const policy = new ApprovalPolicy({ mode: 'full', canAsk });
    policy.allowSession('bash');
    policy.allowDirs([OUT]);
    const narrowing = () => ({ owner: 'task', limits: { write: false } });
    const session = fakeSession(policy, { cwd, instance: 'S.t1.executor', narrowing });
    const denied = 'Not allowed for this task: no file changes or commands.';
    for (const [tool, input] of [['bash', { command: 'npm test' }], ['write', { path: '../out/a.md' }],
      ['write', { path: '.work/n.md' }], ['edit', { path: '.git/config' }]]) {
      const step = session.run(tool, input);
      assert.deepEqual(step.gates, ['deny'], tool);
      assert.deepEqual(await step.result, { block: true, reason: denied });
    }
    for (const [tool, input] of [['board_read', {}], ['read', { path: '../x' }]]) {
      const step = session.run(tool, input);
      assert.deepEqual([step.gates, await step.result], [['free'], undefined], tool);
    }
    assert.deepEqual(session.requests, []);
  }
});

test('FS-30 while stopping only duty and read pass; .work writes and everything else get the stop text', async () => {
  const policy = new ApprovalPolicy({ mode: 'full' });
  const session = fakeSession(policy, { cwd });
  const waiting = session.run('write', { path: '../out/p.md' });
  const stopping = session.gate.rejectForStop();
  assert.deepEqual(await waiting.result, { block: true, reason: STOP_TEXT });
  session.gate.noteToolEnd(waiting.id);
  await stopping;
  assert.deepEqual(session.ended().map((end) => [end.requestId, end.decision, end.by]),
    [[waiting.request.requestId, 'reject', 'stop']]);
  for (const [tool, input] of [['board_read', {}], ['memory', {}], ['read', { path: '../x' }], ['grep', {}]]) {
    assert.equal(await session.run(tool, input, { announce: false }).result, undefined, tool);
  }
  for (const [tool, input] of [['write', { path: '.work/n.md' }], ['edit', { path: '.work/a.md' }],
    ['write', { path: 'a.txt' }], ['bash', { command: 'npm test' }], ['write', { path: '../out/q.md' }],
    ['edit', { path: '.git/config' }], ['mcp__srv__tool', {}]]) {
    assert.deepEqual(await session.run(tool, input, { announce: false }).result, { block: true, reason: STOP_TEXT },
      tool);
  }
  assert.equal(session.asked().length, 1, 'no card while stopping');
  session.gate.endStop();
  assert.equal(await session.run('write', { path: '.work/n.md' }).result, undefined);
});

test('FS-30 a call released while .work is being prepared gets the stop text when the stop begins meanwhile',
  async () => {
  const session = fakeSession(new ApprovalPolicy({ mode: 'full' }), { cwd });
  const step = session.run('bash', { command: 'npm test' });
  assert.deepEqual(step.gates, ['full']);
  await session.gate.rejectForStop();
  assert.deepEqual(await step.result, { block: true, reason: STOP_TEXT });
  session.gate.endStop();
});

test('FS-30 a classification error is logged and asks with one unresolved target; pi never sees an exception',
  async () => {
  for (const mode of ['ask', 'full']) {
    const policy = new ApprovalPolicy({ mode });
    const session = fakeSession(policy, { cwd });
    const { value: step, errors } = quietlySync(() =>
      session.run('bash', { command: 'npm test' }, { ctxOverride: { cwd: 42 } }));
    assert.ok(errors.some((line) => line.startsWith('[kernel] path gate: ')), errors.join('\n'));
    assert.equal(step.gates.at(-1), 'ask');
    assert.equal(step.request.scope, 'outside');
    assert.deepEqual(step.request.targets, [{ reason: 'unresolved', path: null, text: 'bash' }]);
    assert.deepEqual(step.request.allowDirs, []);
    await rejectPending(session, step);
  }
});

// ---- FS-31 按工具名放行 ----

test('FS-31 Allow for this session on an inside card: this call, same-name inside cards of every agent, next calls',
  async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  const executor = fakeSession(policy, { cwd, instance: 'S.t1.executor' });
  const reviewer = fakeSession(policy, { cwd, instance: 'S.t2.reviewer' });
  const first = dialog.run('bash', { command: 'npm test' });
  const lint = executor.run('bash', { command: 'npm run lint' });
  const outside = executor.run('bash', { command: 'cp a.txt ../out/x' });
  const edit = reviewer.run('edit', { path: 'a.ts', edits: [] });
  const build = reviewer.run('bash', { command: 'npm run build' });
  assert.deepEqual([first, lint, outside, edit, build].map((step) => step.request.scope),
    ['inside', 'inside', 'outside', 'inside', 'inside']);
  const state = dialog.gate.answer(first.request.requestId, 'allowSession');
  assert.deepEqual(state, { mode: 'ask', allowed: ['bash'], allowedDirs: [] });
  assert.equal(await first.result, undefined);
  assert.equal(await lint.result, undefined);
  assert.equal(await build.result, undefined);
  assert.deepEqual(dialog.ended().map((end) => [end.requestId, end.decision, end.by]),
    [['approval-1', 'allow', 'user']]);
  // 两个实例里同名、scope inside 的挂起请求都一并放行（by session）
  for (const [session, step] of [[executor, lint], [reviewer, build]]) {
    assert.deepEqual(session.ends.map((end) => [end.requestId, end.decision, end.by]),
      [[step.request.requestId, 'allow', 'session']]);
  }
  assert.equal(lint.request.requestId, 'S.t1.executor:approval-1');
  assert.equal(executor.gate.has(outside.request.requestId), true, 'the same tool writing outside still waits');
  assert.equal(reviewer.gate.has(edit.request.requestId), true, 'other tools still wait');
  for (const session of [dialog, reviewer]) {
    const next = session.run('bash', { command: 'npm run build' });
    assert.deepEqual([next.gates, next.request, await next.result], [['session'], undefined, undefined]);
  }
  await rejectPending(executor, outside);
  await rejectPending(reviewer, edit);
});

test('FS-31 with bash allowed, bash writing outside or to a protected path still asks; allowSession there fails',
  async () => {
  const policy = new ApprovalPolicy();
  policy.allowSession('bash');
  policy.allowSession('edit');
  const dialog = fakeSession(policy, { cwd });
  const outside = dialog.run('bash', { command: 'echo x > ../o.txt' });
  const leaves = dialog.run('bash', { command: 'cd .. && npm i' });
  const protectedEdit = dialog.run('edit', { path: '.git/config', edits: [] });
  for (const step of [outside, leaves, protectedEdit]) {
    assert.deepEqual(step.gates, ['ask']);
    assert.throws(() => dialog.gate.answer(step.request.requestId, 'allowSession'), { message: SESSION_NOT_INSIDE });
    assert.equal(dialog.gate.has(step.request.requestId), true, 'the card stays');
  }
  assert.deepEqual(dialog.ended(), []);
  for (const step of [outside, leaves, protectedEdit]) await rejectPending(dialog, step);
});

test('FS-31 Forget removes the tool name: the next inside call asks again, for every agent', async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  const executor = fakeSession(policy, { cwd, instance: 'S.t1.executor' });
  const first = dialog.run('bash', { command: 'npm test' });
  dialog.gate.answer(first.request.requestId, 'allowSession');
  await first.result;
  assert.deepEqual(executor.run('bash', { command: 'ls' }).gates, ['session']);
  assert.deepEqual(dialog.gate.forget({ toolName: 'bash' }), { mode: 'ask', allowed: [], allowedDirs: [] });
  const again = executor.run('bash', { command: 'npm test' });
  assert.deepEqual(again.gates, ['ask']);
  assert.equal(again.request.scope, 'inside');
  await rejectPending(executor, again);
  assert.deepEqual(policy.forget('bash'), { mode: 'ask', allowed: [], allowedDirs: [] }, 'forgetting twice is a no-op');
});

// ---- FS-32 按目录放行 ----

test('FS-32 allowDirs in the request: the folder of the file; cp x ../bk/ the folder itself; cp a ../b its parent',
  async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  const cases = [
    ['write', { path: join(OUT, 'a', 'b.log') }, [join(OUT, 'a')]],
    ['bash', { command: 'cp x ../bk/' }, [join(root, 'bk')]],
    ['bash', { command: 'cp a ../b' }, [root]],
    ['bash', { command: 'cp -t ../d a' }, [join(root, 'd')]],
    ['bash', { command: 'echo 1 > ../out/a/x.log; echo 2 > ../other/y.log' }, [join(OUT, 'a'), join(root, 'other')]],
    ['bash', { command: 'echo 1 > ../out/a/x.log; echo 2 > ../OUT/A/y.log' }, [join(OUT, 'a')]],
  ];
  for (const [tool, input, dirs] of cases) {
    const step = dialog.run(tool, input);
    assert.equal(step.request.scope, 'outside');
    assert.deepEqual(step.request.allowDirs, dirs, JSON.stringify(input));
    await rejectPending(dialog, step);
  }
  const first = dialog.run('write', { path: join(OUT, 'a', 'b.log') });
  assert.deepEqual(first.request.targets, [{ reason: 'outside', path: join(OUT, 'a', 'b.log'),
    text: join(OUT, 'a', 'b.log') }]);
  await rejectPending(dialog, first);
});

test('FS-32 choosing it allows this call and every fully covered pending request (by dir); next writes there pass',
  async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  const executor = fakeSession(policy, { cwd, instance: 'S.t1.executor' });
  const first = dialog.run('write', { path: join(OUT, 'a', 'b.log') });
  const same = executor.run('write', { path: '../out/a/c.log' });
  const partial = executor.run('bash', { command: 'echo 1 > ../out/a/x.log; echo 2 > ../other/y.log' });
  const sub = executor.run('write', { path: '../out/a/sub/c.log' });
  const state = dialog.gate.answer(first.request.requestId, 'allowDir');
  assert.deepEqual(state, { mode: 'ask', allowed: [], allowedDirs: [join(OUT, 'a')] });
  assert.equal(await first.result, undefined);
  assert.equal(await same.result, undefined);
  assert.deepEqual(dialog.ended().map((end) => [end.decision, end.by]), [['allow', 'user']]);
  assert.deepEqual(executor.ends.map((end) => [end.requestId, end.decision, end.by]),
    [[same.request.requestId, 'allow', 'dir']]);
  assert.equal(executor.gate.has(partial.request.requestId), true, 'two targets, one covered: still asks');
  assert.equal(executor.gate.has(sub.request.requestId), true, 'a subfolder is not covered');
  for (const [session, tool, input] of [[dialog, 'write', { path: '../out/a/d.log' }],
    [executor, 'bash', { command: 'cp a.txt ../out/a/' }], [dialog, 'edit', { path: '../OUT/A/e.log' }]]) {
    const step = session.run(tool, input);
    assert.deepEqual([step.gates, step.request, await step.result], [['dir'], undefined, undefined], tool);
  }
  const deeper = dialog.run('write', { path: '../out/a/sub/e.log' });
  const two = dialog.run('bash', { command: 'echo 1 > ../out/a/x.log; echo 2 > ../other/y.log' });
  assert.deepEqual([deeper.gates, two.gates], [['ask'], ['ask']]);
  for (const [session, step] of [[executor, partial], [executor, sub], [dialog, deeper], [dialog, two]]) {
    await rejectPending(session, step);
  }
});

test('FS-32 no folder option with unresolved, leaves, protected or unanalyzed targets, or a drive or share root',
  async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  for (const [tool, input] of [['bash', { command: 'echo x > $OUT/a.log' }], ['bash', { command: 'cd .. && npm i' }],
    ['edit', { path: '.git/config' }], ['write', { path: '../.gitconfig' }], ['bash', { command: 'echo "abc' }],
    ['bash', { command: 'echo a > ../out/a.log; echo b > $X/b.log' }],
    ['write', { path: `${parse(root).root}mori-x.log` }], ['write', { path: '\\\\server\\share\\x.log' }]]) {
    const step = quietlySync(() => dialog.run(tool, input)).value;
    assert.deepEqual(step.request.allowDirs, [], JSON.stringify(input));
    assert.throws(() => dialog.gate.answer(step.request.requestId, 'allowDir'), { message: NO_FOLDER });
    assert.equal(dialog.gate.has(step.request.requestId), true, 'the card stays');
    await rejectPending(dialog, step);
  }
  assert.deepEqual(policy.state().allowedDirs, []);
});

test('FS-32 inside and .work writes in the same command keep the folder option; the request lists only outside',
  async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  const mixed = dialog.run('bash', { command: 'echo a > a.txt; echo b > ../out/b.txt; echo c > .work/c.txt' });
  assert.deepEqual(mixed.request.allowDirs, [OUT]);
  assert.deepEqual(mixed.request.targets, [{ reason: 'outside', path: join(OUT, 'b.txt'), text: '../out/b.txt' }]);
  dialog.gate.answer(mixed.request.requestId, 'allowDir');
  assert.equal(await mixed.result, undefined);
  assert.deepEqual(policy.state().allowedDirs, [OUT]);
});

test('FS-32 Ask each time: a covered call that also writes inside goes to step 4 as scope inside (2026-10-27)',
  async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  const executor = fakeSession(policy, { cwd, instance: 'S.t1.executor' });
  const before = executor.run('bash', { command: 'cp a.txt ../out/ && rm -rf src' });
  assert.deepEqual([before.request.scope, before.request.allowDirs], ['outside', [OUT]]);
  policy.allowDirs([OUT]);
  assert.equal(executor.gate.has(before.request.requestId), true, 'still writes inside: not ended by the folder');
  assert.deepEqual(dialog.run('bash', { command: 'cp a.txt ../out/' }).gates, ['dir'], 'only outside: by folder');
  const mixed = dialog.run('bash', { command: 'cp a.txt ../out/ && rm -rf src' });
  assert.deepEqual(mixed.gates, ['ask']);
  assert.deepEqual([mixed.request.scope, mixed.request.targets, mixed.request.allowDirs], ['inside', [], []]);
  assert.throws(() => dialog.gate.answer(mixed.request.requestId, 'allowDir'), { message: NO_FOLDER });
  dialog.gate.answer(mixed.request.requestId, 'allowSession');
  assert.equal(await mixed.result, undefined);
  assert.deepEqual(dialog.run('bash', { command: 'echo a > .work/a; echo b > ../out/b.txt' }).gates, ['session']);
  assert.equal(executor.gate.has(before.request.requestId), true, 'an outside card is not ended by a tool name');
  await rejectPending(executor, before);
});

test('FS-32 Full access: a covered call that also writes inside is allowed by folder', () => {
  const policy = new ApprovalPolicy({ mode: 'full' });
  const executor = fakeSession(policy, { cwd, instance: 'S.t1.executor' });
  policy.allowDirs([OUT]);
  for (const command of ['cp a.txt ../out/ && rm -rf src', 'echo a > .work/a; echo b > ../out/b.txt']) {
    assert.deepEqual(executor.run('bash', { command }).gates, ['dir'], command);
  }
});

test('FS-32 switching to Full access ends the cards held back only for writing inside by folder (by dir)',
  async () => {
  const policy = new ApprovalPolicy();
  const executor = fakeSession(policy, { cwd, instance: 'S.t1.executor' });
  const early = executor.run('bash', { command: 'cp a.txt ../out/ && rm -rf src' });
  policy.allowDirs([OUT]);
  const late = executor.run('bash', { command: 'cp b.txt ../out/ && rm -rf lib' });
  const held = executor.run('bash', { command: 'echo x > ../out/k.txt; echo y > ../other/k.txt' });
  assert.deepEqual([early, late, held].map((step) => step.request.scope), ['outside', 'inside', 'outside']);
  assert.deepEqual(executor.ends, [], 'Ask each time: all three still wait');
  policy.setMode('full');
  assert.equal(await early.result, undefined);
  assert.equal(await late.result, undefined);
  const byOf = Object.fromEntries(executor.ends.map((end) => [end.requestId, [end.decision, end.by]]));
  assert.deepEqual(byOf[early.request.requestId], ['allow', 'dir']);
  assert.deepEqual(byOf[late.request.requestId], ['allow', 'dir']);
  assert.equal(executor.gate.has(held.request.requestId), true, 'a target not covered still waits');
  await rejectPending(executor, held);
});

test('FS-32 folders work in Full access too, and survive switching modes', async () => {
  const policy = new ApprovalPolicy({ mode: 'full' });
  const dialog = fakeSession(policy, { cwd });
  assert.deepEqual(dialog.run('write', { path: 'inside.txt' }).gates, ['full']);
  const first = dialog.run('write', { path: '../out/f.log' });
  assert.deepEqual(first.gates, ['ask']);
  dialog.gate.answer(first.request.requestId, 'allowDir');
  assert.equal(await first.result, undefined);
  assert.deepEqual(dialog.run('bash', { command: 'echo x > ../out/g.log' }).gates, ['dir']);
  policy.setMode('ask');
  assert.deepEqual(dialog.run('write', { path: '../out/h.log' }).gates, ['dir']);
});

test('FS-32 Forget a folder (any case or separator): pending cards unchanged, next writes ask again', async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  policy.allowDirs([join(OUT, 'a'), join(root, 'b')]);
  assert.deepEqual(dialog.run('write', { path: '../out/a/x.log' }).gates, ['dir']);
  const waiting = dialog.run('write', { path: '../c/w.log' });
  const unchanged = dialog.gate.forget({ dir: join(root, 'not-listed') });
  assert.deepEqual(unchanged.allowedDirs, [join(OUT, 'a'), join(root, 'b')], 'a folder not in the list: nothing');
  const state = dialog.gate.forget({ dir: join(OUT, 'a').toUpperCase().replaceAll('\\', '/') });
  assert.deepEqual(state, { mode: 'ask', allowed: [], allowedDirs: [join(root, 'b')] });
  assert.equal(dialog.gate.has(waiting.request.requestId), true);
  const again = dialog.run('write', { path: '../out/a/x.log' });
  assert.deepEqual(again.gates, ['ask']);
  await rejectPending(dialog, again);
  await rejectPending(dialog, waiting);
});

test('FS-32 approval.forget with both or neither of toolName and dir fails: Give either toolName or dir.', () => {
  // 只检查参数（§12 approval.forget 一行）；单元测试打不开会话，用一个没开的会话 id，参数错时仍应报这一句
  const wrong = 'Give either toolName or dir.';
  for (const target of [{ toolName: 'bash', dir: OUT }, {}, { toolName: undefined, dir: undefined }]) {
    assert.throws(() => forgetApproval('S-not-open', target), { message: wrong }, JSON.stringify(target));
  }
});

// ---- FS-33 切到 Full access ----

test('FS-33 switching to Full access ends only the inside card (by full); outside and protected cards stay',
  async () => {
  const policy = new ApprovalPolicy();
  const dialog = fakeSession(policy, { cwd });
  const writer = fakeSession(policy, { cwd, instance: 'S.t1.executor' });
  const editor = fakeSession(policy, { cwd, instance: 'S.t2.reviewer' });
  const command = dialog.run('bash', { command: 'npm test' });
  const outside = writer.run('write', { path: '../out/w.md', content: 'x' });
  const guarded = editor.run('edit', { path: '.git/config', edits: [] });
  assert.deepEqual([command, outside, guarded].map((step) => step.request.scope), ['inside', 'outside', 'protected']);
  assert.deepEqual(policy.setMode('full'), { mode: 'full', allowed: [], allowedDirs: [] });
  assert.equal(await command.result, undefined);
  assert.deepEqual(dialog.ended().map((end) => [end.requestId, end.decision, end.by]),
    [['approval-1', 'allow', 'full']]);
  assert.deepEqual([writer.ends, editor.ends], [[], []]);
  assert.equal(writer.gate.has(outside.request.requestId), true);
  assert.equal(editor.gate.has(guarded.request.requestId), true);
  const fresh = fakeSession(policy, { cwd, instance: 'S.t3.executor' });
  assert.deepEqual(fresh.run('write', { path: 'b.txt' }).gates, ['full'], 'a new instance starts in Full access');
  assert.deepEqual(policy.setMode('ask'), { mode: 'ask', allowed: [], allowedDirs: [] });
  assert.deepEqual([dialog.ended().length, writer.ends, editor.ends], [1, [], []], 'back to ask ends nothing');
  await rejectPending(writer, outside);
  await rejectPending(editor, guarded);
});

// ---- FS-34 没人能批 ----

test('FS-34 canAsk false: outside and protected writes are denied at once with §6.15 text; no request, no onRequest',
  async () => {
  const policy = new ApprovalPolicy({ mode: 'full', canAsk: false });
  const dialog = fakeSession(policy, { cwd });
  const instance = fakeSession(policy, { cwd, instance: 'E.t1.executor' });
  const cases = [
    ['write', { path: '../out/x.md' }, `writes outside the working directory: ${join(OUT, 'x.md')}`],
    ['edit', { path: '.git/config' }, `writes to a protected path: ${join(cwd, '.git', 'config')}`],
    ['bash', { command: 'echo x > ../o.txt' }, `writes outside the working directory: ${join(root, 'o.txt')}`],
  ];
  for (const session of [dialog, instance]) {
    for (const [tool, input, why] of cases) {
      const step = session.run(tool, input);
      assert.deepEqual(step.gates, ['deny']);
      assert.deepEqual(await step.result, { block: true, reason: nobodyText(why) });
    }
    for (const [tool, input] of [['bash', { command: 'npm test' }], ['mcp__srv__tool', {}], ['write', { path: 'a' }]]) {
      const step = session.run(tool, input);
      assert.deepEqual([step.gates, await step.result], [['full'], undefined], tool);
    }
  }
  assert.equal(dialog.sent.filter((event) => event.type === 'mori.approval_request').length, 0);
  assert.deepEqual([instance.requests, instance.ends], [[], []]);
  assert.equal(policy.canAsk(), false);
});

test('FS-34 the <why> of each reason, several reasons joined with "; ", at most 5 each with "and <n> more"',
  async () => {
  const policy = new ApprovalPolicy({ mode: 'full', canAsk: false });
  const session = fakeSession(policy, { cwd });
  const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const cases = [
    ['echo x > $OUT/a.log', "writes to a path Mori can't resolve: $OUT/a.log"],
    ['cd .. && npm i', `runs outside the working directory: ${root}`],
    ['cd $X && npm i', 'runs outside the working directory: $X'],
    ['echo "abc', "can't be analyzed: unclosed quote"],
    ['echo a > ../o1.txt; echo b > $OUT/x',
      `writes outside the working directory: ${join(root, 'o1.txt')}; writes to a path Mori can't resolve: $OUT/x`],
    [`touch ${letters.map((x) => `../${x}`).join(' ')}`, `writes outside the working directory: `
      + `${letters.slice(0, 5).map((x) => join(root, x)).join(', ')} and 2 more`],
    ['rm -rf .', `writes to a protected path: ${cwd}`],
  ];
  for (const [command, why] of cases) {
    const step = quietlySync(() => session.run('bash', { command })).value;
    assert.deepEqual(await step.result, { block: true, reason: nobodyText(why) }, command);
  }
});

test('FS-34 canAsk false in Ask each time: an inside call that would ask is denied with needs the user\'s approval',
  async () => {
  const policy = new ApprovalPolicy({ mode: 'ask', canAsk: false });
  const session = fakeSession(policy, { cwd });
  for (const [tool, input] of [['bash', { command: 'npm test' }], ['write', { path: 'a.txt' }], ['mcp__s__t', {}]]) {
    const step = session.run(tool, input);
    assert.deepEqual(await step.result, { block: true, reason: nobodyText("needs the user's approval") }, tool);
  }
  assert.equal(await session.run('write', { path: '.work/n.md' }).result, undefined, '.work still needs no one');
});

// ---- FS-35 预告与更正 ----

test('FS-35 announce gives the same gate as the handler for common calls (read, .work, inside, outside, command, MCP)',
  async () => {
  const calls = [['read', { path: 'a.txt' }], ['write', { path: '.work/n.md' }], ['write', { path: 'a.txt' }],
    ['write', { path: '../out/a.md' }], ['bash', { command: 'npm test' }], ['mcp__srv__tool', {}]];
  const expected = { ask: ['free', 'free', 'ask', 'ask', 'ask', 'ask'], full: ['free', 'free', 'full', 'ask', 'full',
    'full'] };
  for (const mode of ['ask', 'full']) {
    const session = fakeSession(new ApprovalPolicy({ mode }), { cwd });
    for (const [index, [tool, input]] of calls.entries()) {
      const step = session.run(tool, input);
      assert.deepEqual(step.gates, [expected[mode][index]], `${mode} ${tool}`);
      if (step.request) await rejectPending(session, step);
      else assert.equal(await step.result, undefined);
    }
  }
});

/** @brief 先预告，再改设置，再交给处理器：返回这个调用的 gate 序列、请求与结果。 */
function announceThenCall(session, change, tool, input) {
  const id = `late-${tool}-${session.sent.length}`;
  session.gate.announce(id, tool, input);
  change();
  const result = session.handlers.tool_call({ toolCallId: id, toolName: tool, input }, session.ctx);
  const events = session.sent.filter((event) => event.toolCallId === id);
  return { id, result, events: events.map((event) => [event.type, event.gate]),
    request: session.asked().find((item) => item.toolCallId === id) };
}

test('FS-35 when the handler differs from the announcement (modes switched in between) one correction is sent',
  async () => {
  const policy = new ApprovalPolicy();
  const session = fakeSession(policy, { cwd });
  const toFull = announceThenCall(session, () => policy.setMode('full'), 'bash', { command: 'npm test' });
  assert.deepEqual(toFull.events, [['mori.tool_gate', 'ask'], ['mori.tool_gate', 'full']]);
  assert.equal(await toFull.result, undefined);
  const toAsk = announceThenCall(session, () => policy.setMode('ask'), 'write', { path: 'a.txt' });
  assert.deepEqual(toAsk.events, [['mori.tool_gate', 'full'], ['mori.tool_gate', 'ask'],
    ['mori.approval_request', undefined]]);
  await rejectPending(session, toAsk);
  const toDir = announceThenCall(session, () => policy.allowDirs([OUT]), 'write', { path: '../out/z.md' });
  assert.deepEqual(toDir.events, [['mori.tool_gate', 'ask'], ['mori.tool_gate', 'dir']]);
  assert.equal(await toDir.result, undefined);
  const same = announceThenCall(session, () => policy.setMode('ask'), 'read', { path: 'a.txt' });
  assert.deepEqual(same.events, [['mori.tool_gate', 'free']], 'no correction when they agree');
});

// ---- FS-41 目标上限：ApprovalGate 发出的请求 ----

/** @brief n 个 touch 的操作数：prefix + f1 … fn。 */
function touchNames(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}f${i + 1}`).join(' ');
}

test('FS-41 the request for 101 targets: scope outside, allowDirs empty, the 101st target unresolved', async () => {
  for (const mode of ['ask', 'full']) {
    const dialog = fakeSession(new ApprovalPolicy({ mode }), { cwd });
    const inside = dialog.run('bash', { command: `touch ${touchNames('', 101)}` });
    assert.deepEqual(inside.gates, ['ask'], mode);
    assert.equal(inside.request.scope, 'outside');
    assert.deepEqual(inside.request.allowDirs, []);
    assert.deepEqual(inside.request.targets, [{ reason: 'unresolved', path: null, text: 'f101' }]);
    await rejectPending(dialog, inside);
    const outside = dialog.run('bash', { command: `touch ${touchNames('../o/', 101)}` });
    assert.equal(outside.request.scope, 'outside');
    assert.deepEqual(outside.request.allowDirs, [], 'no Allow writes to <folder> with an unresolved target');
    assert.equal(outside.request.targets.length, 101);
    assert.deepEqual(outside.request.targets.slice(0, 2), [
      { reason: 'outside', path: join(root, 'o', 'f1'), text: '../o/f1' },
      { reason: 'outside', path: join(root, 'o', 'f2'), text: '../o/f2' }]);
    assert.deepEqual(outside.request.targets[100], { reason: 'unresolved', path: null, text: '../o/f101' });
    await rejectPending(dialog, outside);
  }
});
