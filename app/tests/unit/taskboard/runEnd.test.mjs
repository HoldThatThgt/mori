// 运行结束与撤销的边角（kernel/teamRuns.ts、teamTools.ts，docs/specs/parallel-agents-taskboard.md §5.4、§7.4、§7.6、
// §9.4、§10.1、§12.5、§13.3）：合并会话被停止的回复照样写进展摘要；撤销需求时排队的等回复消息结束；结案会话没能开始、
// 选不到模型时不留下没人管的 task 或需求；§5.4 兜底表第 3 行的再唤醒只免一次检查。用测试写的会话表（teamHarness.mjs，
// synthetic）驱动 Team。不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B, addTask, assistantTurn, beginRun, deps, finishRun, nextDelivery, nextDialog, roles, runDelivery, setup, until,
  workThen,
} from './teamHarness.mjs';

/** 等 Team 处理完异步的唤醒与调度。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** 用户会话里某种自定义条目的内容。 */
function customs(user, type) {
  return user.session.sessionManager.getEntries().filter((entry) => entry.type === 'custom'
    && entry.customType === type).map((entry) => entry.data);
}

/** 结案以 close_done 关闭一个 task。 */
const closeDone = (task) => ({ name: 'task_handoff', args: { task, conclusion: 'Works.', outcome: 'close_done' } });

/** 结案请立项再建 task（不等回复）。 */
const askCreate = { name: 'agent_message', args: { to: 'planner', text: 'Request 1 may need one more task.' } };

/** 某个会话在 after 之后的下一次投递。 */
const nextAfter = (host, id, after) => nextDelivery(host, id, host.deliveries.indexOf(after) + 1);

test('TB-37 TB-10 merged session: a reply stopped after request_submit still writes mori.progress; no reminder',
  async () => {
    const { team, host, user } = await setup(roles.parseRoleFiles([], deps));
    await team.setMode('on');
    team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
    const reply = await nextDialog(host);
    await reply.ready;
    await beginRun(host, reply);
    await assistantTurn(host.entry('U'), { calls: [{ name: 'request_submit', args: { title: 'Login page is blank',
      goal: 'Fix it' } }] });
    // 你按了 Esc：会话表记下停止原因 dialog（§9.4、§11.4）
    const status = host.status;
    host.status = (id) => (id === 'U' ? { ...status(id), stop: 'dialog' } : status(id));
    await finishRun(host, reply, []);
    await until(() => customs(user, 'mori.progress').length, 'the progress entry');
    assert.deepEqual(customs(user, 'mori.progress'), [{ request: 1 }]);
    assert.ok(host.events.some((event) => event.type === 'mori.progress' && event.request === 1));
    await settle();
    assert.equal(host.deliveries.some((item) => item.text.includes('has no tasks')), false,
      'the stopped run delivers no "Request 1 has no tasks" (§9.4 row 0)');
  });

/** chat 持有对话，planner 持有立项，closer 持有结案，executor（synthetic）。 */
const SEPARATE_CLOSE = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n---\n' },
  { file: '.mori/agents/closer.md', text: '---\nname: closer\ndescription: Closes\nseats: [close]\n---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\n' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create]\n---\n' },
], deps);
assert.deepEqual(SEPARATE_CLOSE.problems, []);

test('TB-32 TB-28 request_cancel drops the queued deliveries of its close session; a waiting agent_message ends',
  async () => {
    const { team, host } = await setup(SEPARATE_CLOSE);
    await team.setMode('on');
    addTask(team);
    await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
    await nextDelivery(host, 'U.close.1');
    team.write((board) => B.submitRequest(board, { title: 'Docs', goal: 'Read the docs', acceptance: null,
      quote: null }, { message: 'read the docs', history: [] }, Date.now()));
    team.write((board) => B.createTask(board, { request: 2, title: 'Read', description: 'Read them',
      assignee: 'executor', readOnly: true, dependsOn: [] }, Date.now()));
    await beginRun(host, await nextDelivery(host, 'U.t2.executor'));
    const message = host.entry('U.t2.executor').api.tools.get('agent_message');
    const pending = message.execute('m1', message.prepareArguments({ to: 'closer', request: 1,
      text: 'Is T1 fine?', wait: true }), undefined, undefined, {});
    await settle();
    assert.equal(team.waits.size, 1, 'T2 waits on the close session of request 1, which is busy');
    team.onUserPrompt({ text: 'cancel the login fix' }, undefined, undefined);
    await runDelivery(host, await nextDelivery(host, 'U.create'), [{ calls: [{ name: 'request_cancel',
      args: { request: 1, reason: 'Not needed' } }] }]);
    const reply = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(null), 1000))]);
    assert.ok(reply, 'the waiting agent_message ends');
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, 'Request 1 was cancelled.');
    assert.equal(team.waits.size, 0);
    assert.equal(B.findRequest(team.board, 1).status, 'cancelled');
  });

test('TB-19 a close delivery that never starts still handles the task handed to close: close_undecided → create',
  async () => {
    const { team, host } = await setup();
    addTask(team);
    await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
    (await nextDelivery(host, 'U.close.1')).resolve();
    const task = await until(() => B.findTask(team.board, 'T1')?.status === 'waiting_user'
      && B.findTask(team.board, 'T1'), 'T1 handed to create');
    assert.deepEqual([task.handoffs.at(-1).reason, task.question], ['close_undecided', "planner didn't decide on T1"]);
    assert.match((await nextDelivery(host, 'U.create')).text, /planner didn't decide on T1/);
  });

test('TB-40 TB-31 close with no model, woken because every task ended: the request question goes to create',
  async () => {
    const { team, host } = await setup();
    addTask(team);
    await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
    const close = await nextDelivery(host, 'U.close.1');
    await runDelivery(host, close, [{ calls: [closeDone('T1')] }]);
    const ended = await nextAfter(host, 'U.close.1', close);
    host.entry('U.close.1').spec.model.onUnavailable({ firstRequest: true,
      candidates: [{ ref: 'fake/model', detail: 'rate limited' }] });
    ended.resolve();
    const create = await nextDelivery(host, 'U.create');
    assert.match(create.text, /planner can’t run: no model available/);
    assert.equal(B.findRequest(team.board, 1).question, 'planner can’t run: no model available');
    assert.equal(B.findRequest(team.board, 1).status, 'open');
  });

test('TB-40 close with no model before its run starts: the task handed to it goes to create as need_user (§12.5)',
  async () => {
    const { team, host } = await setup();
    addTask(team);
    await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
    const close = await nextDelivery(host, 'U.close.1');
    host.entry('U.close.1').spec.model.onUnavailable({ firstRequest: true,
      candidates: [{ ref: 'fake/model', detail: 'rate limited' }] });
    close.resolve();
    const task = await until(() => B.findTask(team.board, 'T1')?.status === 'waiting_user'
      && B.findTask(team.board, 'T1'), 'T1 handed to create');
    // 界面上显示的问题用排版撇号（docs/v0/ui-strings.md 第 12 条）
    assert.deepEqual([task.handoffs.at(-1).from, task.handoffs.at(-1).reason, task.question],
      ['mori', 'no_model', 'planner can’t run: no model available']);
    assert.match((await nextDelivery(host, 'U.create')).text, /T1 needs a decision from the user/);
  });

test('TB-31 the "no new tasks" re-wake waives the check on messages to create once; a later ask is waited for',
  async () => {
    const { team, host } = await setup();
    addTask(team);
    await runDelivery(host, await nextDelivery(host, 'U.t1.executor'), workThen('done'));
    let close = await nextDelivery(host, 'U.close.1');
    await runDelivery(host, close, [{ calls: [closeDone('T1')] }]);
    close = await nextAfter(host, 'U.close.1', close);
    await runDelivery(host, close, [{ calls: [askCreate] }, { text: 'Asked planner.' }]);
    let create = await nextDelivery(host, 'U.create');
    await runDelivery(host, create, [{ text: 'No more tasks are needed.' }]);
    close = await nextAfter(host, 'U.close.1', close);
    assert.match(close.text, /\[Mori\] planner made no new tasks for request 1\./);
    assert.equal(B.findRequest(team.board, 1).closeRetry, true);
    await runDelivery(host, close, [{ text: 'Nothing to add.' }]);
    create = await nextAfter(host, 'U.create', create);
    assert.match(create.text, /Request 1 has no open tasks and planner didn't close it/);
    assert.equal(B.findRequest(team.board, 1).closeRetry, false, 'the waiver is used by that one turn');
    await runDelivery(host, create, [{ calls: [{ name: 'task_create', args: { request: 1, title: 'More',
      description: 'One more part', assignee: 'executor', read_only: false } }] }, { text: 'Created T2.' }]);
    await runDelivery(host, await nextDelivery(host, 'U.t2.executor'), workThen('done'));
    close = await nextAfter(host, 'U.close.1', close);
    await runDelivery(host, close, [{ calls: [closeDone('T2')] }]);
    close = await nextAfter(host, 'U.close.1', close);
    assert.match(close.text, /^\[Mori\] All tasks of request 1 have ended\./);
    await runDelivery(host, close, [{ calls: [askCreate] }, { text: 'Asked planner again.' }]);
    await settle();
    const request = B.findRequest(team.board, 1);
    assert.deepEqual([request.status, request.question], ['open', null],
      'no forced close while create still handles the message (§7.6)');
    assert.equal(host.deliveries.indexOf(close), host.deliveries.findLastIndex((item) => item.id === 'U.close.1'));
  });
