// 规格对齐 pi 1.3.0 之后的单元测试（docs/specs/parallel-agents-taskboard.md §3、§6.2、§7.6、§12.12、§13.10、§5.4）：
// TaskView.current 带 offset、limit 与前 200 字符的命令（进展摘要与工具卡同一标题）、task 交给另一方时清掉模型提示、
// board.json 写出之后才开始下一个实例、结案发给立项的消息没处理完时不强制关闭、合并会话里 reply_via_dialog 的结果。
// 会话表是 teamHarness.mjs 的 synthetic TeamHost；不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  B, SPLIT, TeamModule, addTask, beginRun, deps, finishRun, nextDelivery, nextDialog, roles, runDelivery, setup, until,
  workThen,
} from './teamHarness.mjs';

const shared = await loadKernelModule('src/shared/team.ts');
const holders = { dialog: 'chat', create: 'planner', close: 'planner' };

// ---- TB-37、TB-55 当前在做什么与工具卡同一标题 ----

test('TB-37 TB-55 TaskView.current keeps offset, limit and the first 200 characters of the command', () => {
  const cwd = 'D:\\work\\app';
  const context = { cwd, seatRoles: ['planner'], task: 'T1' };
  const calls = [
    ['bash', { command: 'npm test\nnpm run lint' }],
    ['bash', { command: `echo ${'a'.repeat(300)}` }],
    ['bash', { command: `${'b'.repeat(150)}\nsecond line` }],
    ['read', { path: 'D:\\work\\app\\src\\a.ts', offset: 10, limit: 20 }],
    ['read', { path: 'src/a.ts', offset: 5 }],
    ['grep', { pattern: 'TODO' }],
    ['board_read', { request: 1 }],
    ['agent_message', { to: 'planner', text: 'Done?' }],
    ['task_handoff', { conclusion: 'Fixed.' }],
  ];
  for (const [name, args] of calls) {
    const brief = TeamModule.toolBrief(name, args);
    assert.equal(shared.toolCallTitle(brief.toolName, brief.args, context), shared.toolCallTitle(name, args, context),
      `${name} ${JSON.stringify(args).slice(0, 60)}`);
  }
  assert.equal(TeamModule.toolBrief('bash', calls[0][1]).args.command, 'npm test\nnpm run lint');
  assert.equal(TeamModule.toolBrief('bash', calls[1][1]).args.command.length, 200);
  assert.deepEqual(TeamModule.toolBrief('read', calls[3][1]).args, { path: 'D:\\work\\app\\src\\a.ts', offset: 10,
    limit: 20 });
  assert.equal(shared.toolCallTitle('read', TeamModule.toolBrief('read', calls[3][1]).args, context),
    'Read src/a.ts · lines 10–29');
});

test('TB-37 a running multi-line command shows as Run <first line> … on the progress row', async () => {
  const { team, host, cwd } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await beginRun(host, start);
  host.entry('U.t1.executor').spec.onEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash',
    args: { command: 'npm test\nnpm run lint' } });
  const view = team.view();
  const row = view.requests[0].tasks[0];
  assert.equal(row.phase, 'running');
  assert.equal(shared.taskPhaseText(row, view, holders, cwd), 'Run npm test …');
  await finishRun(host, start, workThen('done'));
});

// ---- TB-52 模型提示在 task 交给另一方时清掉 ----

/** 实例换模型（synthetic mori.model_switch）。 */
function switchModel(host, id) {
  host.entry(id).spec.onModelEvent({ type: 'mori.model_switch', from: 'a/m1', to: 'b/m1', reason: 'rate_limited',
    detail: 'rate limited' });
}

/** T1 此刻在视图里的模型提示。 */
const noteOf = (team) => team.view().requests[0].tasks.find((task) => task.id === 'T1').modelNote;

test('TB-52 the model note is cleared when the task is handed off to another role', async () => {
  const { team, host } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await beginRun(host, start);
  switchModel(host, 'U.t1.executor');
  assert.match(noteOf(team), /^Switched model: a\/m1 → b\/m1 · /);
  await finishRun(host, start, [{ calls: [{ name: 'edit', args: { path: 'src/a.ts' }, result: 'edited' }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Changed it.', outcome: 'continue', next: 'reviewer' } }] }]);
  assert.equal(B.findTask(team.board, 'T1').holder.role, 'reviewer');
  assert.equal(noteOf(team), null, 'the reviewer does not show the executor note');
});

test('TB-52 the model note is cleared by the fallback to close and by a hand-back', async () => {
  const { team, host } = await setup();
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  await beginRun(host, start);
  switchModel(host, 'U.t1.executor');
  await finishRun(host, start, [{ text: 'I looked around.' }]);
  await until(() => B.findTask(team.board, 'T1').holder?.kind === 'close', 'the fallback to close');
  assert.equal(noteOf(team), null, 'fallback to close');

  const second = await setup();
  addTask(second.team);
  const run = await nextDelivery(second.host, 'U.t1.executor');
  await beginRun(second.host, run);
  switchModel(second.host, 'U.t1.executor');
  await second.team.stopTeam();
  await finishRun(second.host, run, [{ text: 'Interrupted.' }]);
  assert.match(noteOf(second.team), /^Switched model/, 'a stop is not a hand-over');
  second.team.write((board) => B.editTask(board, { task: 'T1', title: null, description: null, assignee: null,
    dependsOn: null }, Date.now()));
  assert.equal(B.findTask(second.team.board, 'T1').status, 'active');
  assert.equal(noteOf(second.team), null, 'hand-back');
});

// ---- TB-12、TB-23 board.json 先写出，再开始下一个实例 ----

test('TB-12 TB-23 the next instance starts only after board.json names it as the holder', async () => {
  const { team, host, cwd } = await setup();
  const file = join(cwd, 'teams', 'U', 'board.json');
  const seen = [];
  const deliver = host.deliver.bind(host);
  host.deliver = (id, text, choice) => {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    seen.push([id, saved.tasks.find((task) => task.id === 'T1')?.holder ?? null]);
    return deliver(id, text, choice);
  };
  addTask(team);
  await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), [
    { calls: [{ name: 'edit', args: { path: 'src/a.ts' }, result: 'edited' }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Changed it.', outcome: 'continue', next: 'reviewer' } }] },
  ]);
  await nextDelivery(host, 'U.t1.reviewer');
  assert.deepEqual(seen, [['U.t1.executor', { kind: 'role', role: 'executor' }],
    ['U.t1.reviewer', { kind: 'role', role: 'reviewer' }]]);
});

// ---- TB-31 结案请立项建 task、立项还没处理时不强制关闭 ----

/** 强制关闭的投递（§7.5 第 1 步，需求）。 */
const FORCED_CLOSE = /^\[Mori\] All tasks of request 1 have ended and it is still open\. Close it now/;

test('TB-31 the forced close waits while create has not processed close\'s message; the retry turn forces it',
  async () => {
    const { team, host } = await setup(SPLIT, 'C');
    addTask(team);
    await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
    const close = await nextDelivery(host, 'U.close.1');
    await runDelivery(host, close, [
      { calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Works.', outcome: 'close_done' } }] },
      { calls: [{ name: 'agent_message', args: { to: 'planner', request: 1, text: 'Add a test task?' } }] },
    ]);
    const ended = await nextDelivery(host, 'U.close.1', host.deliveries.indexOf(close) + 1);
    assert.match(ended.text, /^\[Mori\] All tasks of request 1 have ended\./);
    const create = await nextDelivery(host, 'U.create');
    assert.match(create.text, /Add a test task\?/);
    await runDelivery(host, ended, [{ text: 'Waiting for planner.' }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closeDeliveries = () => host.deliveries.filter((item) => item.id === 'U.close.1');
    assert.equal(closeDeliveries().some((item) => FORCED_CLOSE.test(item.text)), false,
      'no forced close while create has the message');
    await runDelivery(host, create, [{ text: 'No more tasks are needed.' }]);
    const retry = await until(() => closeDeliveries().find((item) => /made no new tasks/.test(item.text)),
      'the retry wake of close');
    assert.match(retry.text, /^\[Mori\] planner made no new tasks for request 1\./);
    await runDelivery(host, retry, [{ calls: [{ name: 'agent_message', args: { to: 'planner', request: 1,
      text: 'Still nothing?' } }] }]);
    const forced = await until(() => closeDeliveries().find((item) => FORCED_CLOSE.test(item.text)),
      'the forced close');
    assert.ok(forced, 'the retry turn ends with the forced close even with a new message to create');
  });

// ---- TB-10 合并会话里 reply_via_dialog 的结果 ----

test('TB-10 merged session: reply_via_dialog tells the model to answer in its own reply', async () => {
  const { team, host } = await setup(roles.parseRoleFiles([], deps));
  await team.setMode('on');
  team.onUserPrompt({ text: 'What does this repo do?' }, undefined, undefined);
  const reply = await nextDialog(host);
  await reply.ready;
  const results = await runDelivery(host, reply, [{ calls: [{ name: 'reply_via_dialog', args: {} }] },
    { text: 'It is a desktop app.' }]);
  assert.ok(!results[0].isError);
  assert.equal(results[0].content[0].text, 'Noted: no collaboration needed. Answer the user in your reply.');
});

test('TB-10 split session: reply_via_dialog keeps the dialog-agent text', async () => {
  const { team, host } = await setup();
  await team.setMode('on');
  team.onUserPrompt({ text: 'What does this repo do?' }, undefined, undefined);
  const judge = await nextDelivery(host, 'U.create');
  const results = await runDelivery(host, judge, [{ calls: [{ name: 'reply_via_dialog', args: {} }] }]);
  assert.equal(results[0].content[0].text, 'The dialog agent answers the user directly.');
});
