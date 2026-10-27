// kernel/team.ts 与 teamFlow.ts 里会话的开始、结束与停止的边界情况（docs/specs/parallel-agents-taskboard.md §3、§5.1、
// §5.3–§5.6、§8.4、§8.5、§9.4、§11.4、§12.1、§12.11）：准备中就结束（没有运行）的回复与投递、建实例会话期间的停止、
// 重新打开之后的工具与 TaskBoard 视图、给改动标的 Agent（docs/specs/file-system.md §4.5）、合并会话判断的原文。
// 用测试写的会话表（teamHarness.mjs，synthetic）驱动 Team，不连模型，也不起 Electron。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import {
  B, SPLIT, addTask, deps, nextDelivery, nextDialog, roles, runDelivery, setup, text, until,
} from './teamHarness.mjs';

/** 合并会话的角色：没有角色文件（基座持有三项权限）。 */
const MERGED = roles.parseRoleFiles([], deps);
/** 协作模式下对话的那一组（SPLIT 的 chat：基座的读取类 + TaskBoard 的三个工具）。 */
const TEAM_SET = ['read', 'board_read', 'read_session', 'agent_message'];
/** 进入协作模式前关闭模式的那一组。 */
const OFF_SET = ['read', 'bash', 'edit', 'write'];

const SUBMIT = { name: 'request_submit', args: { title: 'Login page is blank', goal: 'Fix it' } };

/** 等 Team 处理完（setTimeout(0) 的 afterRun、写出 board.json）。 */
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用户会话里某种自定义条目的内容。 */
function customs(entry, type) {
  return entry.session.sessionManager.getEntries().filter((item) => item.type === 'custom'
    && item.customType === type).map((item) => item.data);
}

/** 用户会话的文件（synthetic）：只有 mori.team 条目，Team 打开时读最后一条（§5.1、§5.5）。 */
function teamEntries(entries) {
  return entries.map((data) => JSON.stringify({ type: 'custom', customType: 'mori.team', data })).join('\n') + '\n';
}

/** 一次程序投递到用户会话（§5.6 relay）。 */
function relay(team) {
  team.enqueueUser(team.delivery('relay', { createRole: 'planner', note: 'Tell them it works.' },
    { kind: 'message' }), 'relay');
}

/** 一个 task 实例 id 的 lane。 */
const laneOf = (team, id) => [...team.lanes.values()].find((lane) => lane.id === id);

// ---- 模式改变与准备中就结束的回复（§5.1、§5.6、§12.11） ----

test('TB-38 a mode change while the dialog prepares is applied when that reply ends without a run (Esc)',
  async () => {
    const { team, host, state } = await setup(MERGED);
    await team.setMode('on');
    team.onUserPrompt({ text: 'hello' }, undefined, undefined);
    const reply = await nextDialog(host);
    await reply.ready;
    assert.equal(host.entry('U').preparing, true);
    assert.equal((await team.setMode('off')).mode, 'off');
    assert.deepEqual(state.locks, [true], 'the lock waits for the reply to end');
    await host.abort('U', 'dialog');
    await until(() => state.locks.length === 2, 'the deferred lock');
    assert.deepEqual(state.locks, [true, false], 'off mode unlocks the model button (§12.11)');
    assert.equal(team.pendingLock, false);
  });

test('TB-51 a user-session delivery queued during a reply the Team does not track starts when it ends without a run; '
  + 'the mode change made meanwhile is applied first', async () => {
  const { team, host, state } = await setup();
  // synthetic：会话表按关闭模式开始的一次发送（v0 的 dispatch），Team 不跟踪它，它在准备中
  host.entry('U').preparing = true;
  host.entry('U').running = true;
  await team.setMode('on');
  assert.equal(state.locks, undefined, 'deferred while the dialog prepares');
  relay(team);
  await settle();
  assert.equal(host.deliveries.some((item) => item.id === 'U'), false, 'it waits while the dialog prepares');
  host.entry('U').preparing = false;
  host.entry('U').running = false;
  team.replyEnded();
  const delivery = await nextDelivery(host, 'U');
  assert.match(delivery.text, /asks you to tell the user: Tell them it works\./);
  assert.deepEqual(state.locks, [true], 'the team lock is set before the delivery starts');
  delivery.resolve();
});

test('TB-05 /team /<command> in off mode enters once before the command goes to the dialog', async () => {
  const { team, state } = await setup(SPLIT, null, { commands: ['deploy'] });
  assert.equal(team.takesPrompt('/deploy now', 'once'), false, 'the command still goes to the dialog directly');
  await team.enterOnce();
  assert.equal(team.info().team.mode, 'once');
  assert.deepEqual(state.locks, [true]);
  await team.enterOnce();
  assert.deepEqual(state.locks, [true], 'already in team mode: no change');
});

test('TB-38 an open instance of a role without models follows the range chosen in off mode', async () => {
  const { team, host, state } = await setup();
  await team.setMode('on');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  assert.deepEqual(host.entry('U.t1.executor').spec.model.source.models, ['strong']);
  state.blocked = true;
  assert.equal((await team.setMode('off')).mode, 'off', 'turned off while blocked: T1 stopped, its instance open');
  start.resolve();
  await until(() => !laneOf(team, 'U.t1.executor').busy, 'the stopped delivery to end');
  assert.equal(B.findTask(team.board, 'T1').status, 'stopped');
  state.blocked = false;
  state.pick = 'fast';
  await team.setMode('on');
  const executor = (state.sources ?? []).filter((item) => item.id === 'U.t1.executor');
  assert.equal(executor.length, 1, 'the open instance gets a new source once');
  assert.deepEqual([executor[0].locked, executor[0].source.role, executor[0].source.models],
    [false, 'executor', ['fast']]);
  await team.setMode('on');
  assert.equal((state.sources ?? []).filter((item) => item.id === 'U.t1.executor').length, 1,
    'unchanged range: no refresh');
});

test('TB-35 Stop team stops a preparing reply of a merged session; the next run is not treated as stopped',
  async () => {
    const { team, host } = await setup(MERGED);
    await team.setMode('on');
    team.onUserPrompt({ text: 'first' }, undefined, undefined);
    const first = await nextDialog(host);
    await first.ready;
    await team.stopTeam();
    assert.ok(host.aborts.some((item) => item.id === 'U' && item.reason === 'user'),
      'the preparing reply was stopped');
    await until(() => !team.user.busy, 'the reply to end');
    assert.equal(team.user.stop, null, 'the stop reason belongs to the stopped reply only (§9.4 row 0)');
    team.onUserPrompt({ text: 'fix the login page' }, undefined, undefined);
    const second = await nextDialog(host, 1);
    await second.ready;
    await runDelivery(host, second, [{ calls: [SUBMIT] }, { text: 'Registered.' }]);
    const reminder = await nextDelivery(host, 'U');
    assert.match(reminder.text, /\[Mori\] Request 1 has no tasks\. Split it with task_create now\./,
      'the judgment ended normally (§5.4)');
    reminder.resolve();
  });

test('TB-35 a stop that arrives while an instance session is being created keeps the delivery from running',
  async () => {
    let open = () => undefined;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const createGate = (spec) => (spec.id === 'U.t1.executor' ? gate : undefined);
    const { team, host } = await setup(SPLIT, null, { createGate });
    await team.setMode('on');
    addTask(team);
    await until(() => laneOf(team, 'U.t1.executor')?.busy, 'T1 to start opening its instance');
    await team.stopTeam();
    assert.equal(B.findTask(team.board, 'T1').status, 'stopped');
    open();
    await until(() => !laneOf(team, 'U.t1.executor').busy, 'the delivery to end');
    await settle();
    assert.equal(host.deliveries.some((item) => item.id === 'U.t1.executor'), false, 'nothing was sent to T1');
    assert.equal(B.findTask(team.board, 'T1').status, 'stopped', 'not restarted (§11.4)');
  });

test('TB-51 a user-session delivery whose end handling fails still frees the session', async () => {
  const { team, host, state } = await setup();
  await team.setMode('on');
  relay(team);
  const delivery = await nextDelivery(host, 'U');
  host.entry('U').running = true;
  state.lockFails = true;
  await team.setMode('off');
  assert.equal(team.pendingLock, true);
  host.entry('U').running = false;
  delivery.resolve();
  await until(() => !team.user.busy && team.user.settling === null, 'the user session to be free');
  assert.equal(team.busy(), false, 'close, archive and delete are not blocked (§11.5)');
});

// ---- 立项看着整个对话（§8.4） ----

test('TB-11 a create delivery that never ran does not move mori.create_cursor; the next one carries that '
  + 'conversation again', async () => {
  const prepareUser = (user) => {
    user.session.sessionManager.appendMessage(text('user', 'An earlier question'));
    user.session.sessionManager.appendMessage(text('assistant', 'An earlier answer.'));
  };
  const { team, host } = await setup(SPLIT, null, { prepareUser });
  await team.setMode('on');
  team.onUserPrompt({ text: 'first' }, undefined, undefined);
  const reply = await nextDialog(host);
  const judge = await nextDelivery(host, 'U.create');
  assert.match(judge.text, /An earlier question/);
  judge.resolve();
  await reply.ready;
  assert.deepEqual(customs(host.entry('U.create'), 'mori.create_cursor'), [], 'not written for a delivery that '
    + 'never ran');
  host.entry('U').preparing = false;
  host.entry('U').running = false;
  reply.resolve();
  await until(() => !team.user.busy, 'the reply to end');
  team.onUserPrompt({ text: 'second' }, undefined, undefined);
  const again = await nextDelivery(host, 'U.create', host.deliveries.indexOf(judge) + 1);
  assert.match(again.text, /An earlier question/, 'the conversation is not lost');
  await runDelivery(host, again, [{ text: 'Nothing to register.' }]);
  assert.equal(customs(host.entry('U.create'), 'mori.create_cursor').length, 1, 'written when the delivery ran');
});

// ---- 投递文字（§8.5） ----

test('TB-21 a task whose first delivery never ran gets the start text when it comes back to that role', async () => {
  const { team, host } = await setup();
  await team.setMode('on');
  addTask(team);
  const start = await nextDelivery(host, 'U.t1.executor');
  start.resolve();
  const close = await nextDelivery(host, 'U.close.1');
  await runDelivery(host, close, [{ calls: [{ name: 'task_handoff', args: { task: 'T1', conclusion: 'Try again.',
    outcome: 'continue', next: 'executor' } }] }]);
  const again = await nextDelivery(host, 'U.t1.executor', host.deliveries.indexOf(start) + 1);
  assert.match(again.text, /^\[Mori\] You are executor on T1 \(request 1\)\. Start work\./);
});

// ---- board.json 先写出（§3） ----

test('TB-12 mori.board is sent only after board.json holds that state', async () => {
  const { team, host, cwd } = await setup();
  await settle(300);
  const file = join(cwd, 'teams', 'U', 'board.json');
  const onDisk = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).requests.length : 0);
  const seen = [];
  const emit = host.emitUser;
  host.emitUser = (id, event) => {
    if (event.type === 'mori.board') seen.push({ sent: event.requests.length, disk: onDisk() });
    emit(id, event);
  };
  team.write((board) => B.submitRequest(board, { title: 'Written first', goal: 'g', acceptance: null, quote: null },
    { message: 'm', history: [] }, Date.now()));
  team.emitBoard();
  await until(() => seen.some((item) => item.sent === 1), 'the board event');
  assert.ok(seen.every((item) => item.sent <= item.disk), JSON.stringify(seen));
});

// ---- 重新打开（§5.5）与改动标的 Agent（file-system.md §4.5） ----

test('TB-09 reopened in off mode after a team-mode run, the dialog gets back its tools from before team mode',
  async () => {
    const prepareUser = (user, cwd) => {
      writeFileSync(join(cwd, 'user.jsonl'), teamEntries([{ mode: 'always', tools: OFF_SET }, { mode: 'off' }]));
      // synthetic：pi 从会话记录恢复了最后一次协作模式运行的那一组
      user.api.setActiveTools(TEAM_SET);
    };
    const { user } = await setup(SPLIT, null, { userFile: 'user.jsonl', prepareUser });
    user.api.handlers.get('before_agent_start')({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
    assert.deepEqual(user.api.getActiveTools().sort(), [...OFF_SET, 'agent_message'].sort());
  });

test('TB-09 reopened in team mode, turning off and on again records the tools from before team mode', async () => {
  const prepareUser = (user, cwd) => {
    writeFileSync(join(cwd, 'user.jsonl'), teamEntries([{ mode: 'always', tools: OFF_SET }]));
    user.api.setActiveTools(TEAM_SET);
  };
  const { team, user } = await setup(SPLIT, null, { userFile: 'user.jsonl', prepareUser });
  assert.equal(team.info().team.mode, 'always');
  await team.setMode('off');
  await team.setMode('on');
  assert.deepEqual(customs(user, 'mori.team').at(-1), { mode: 'always', tools: OFF_SET });
});

// TB-57 改过（2026-10-26，平行 Agent 规格 TB-57、file-system.md FS-14、§19.4）：§13.12 的“team 的改动不在这里”说明作废，
// 右栏 This session 按快照列出 task 改过的文件并标出 Agent（file-system.md §4.5、§5.3）。单元层还成立的是：
// TaskBoard 视图只有 requests、没有改动标记；实例的运行与对话自己的运行各自报出给改动标的 Agent。

/** 重新打开前写好的 TaskBoard 与 task 实例会话（synthetic）：T1 被你停止，实例会话里有一次成功的 edit。 */
async function stoppedAfterEdit(_user, cwd) {
  let board = B.newBoard();
  board = B.submitRequest(board, { title: 'Edit', goal: 'g', acceptance: null, quote: null },
    { message: 'm', history: [] }, 1).board;
  board = B.createTask(board, { request: 1, title: 'Change it', description: 'd', assignee: 'executor',
    readOnly: false, dependsOn: [] }, 2).board;
  board.tasks[0] = { ...board.tasks[0], status: 'stopped', stopReason: 'user' };
  await B.saveBoard(join(cwd, 'teams', 'U'), board);
  const dir = join(cwd, 'teams', 'U', 'sessions');
  mkdirSync(dir, { recursive: true });
  const result = { type: 'message', id: 'r1', parentId: null, timestamp: '2026-10-21T00:00:00.000Z',
    message: { role: 'toolResult', toolCallId: 'c1', toolName: 'edit', content: [], isError: false, timestamp: 1 } };
  writeFileSync(join(dir, '2026-10-21T00-00-00-000Z_U.t1.executor.jsonl'), `${JSON.stringify(result)}\n`);
}

test('TB-57 after reopening, a stopped task that edited files is on the board view and the view has no edited flag',
  async () => {
    const { team } = await setup(SPLIT, null, { restored: true, prepareUser: stoppedAfterEdit });
    const view = team.view();
    assert.deepEqual(Object.keys(view), ['requests'], 'BoardView is { requests } only (teamEdited is gone)');
    assert.deepEqual(view.requests.map((request) => request.tasks.map((task) => [task.id, task.status])),
      [[['T1', 'stopped']]]);
    assert.equal('teamEdited' in team, false, 'Team keeps no team-edited state');
    const { emptyBoard } = await loadKernelModule('src/shared/team.ts');
    assert.deepEqual(emptyBoard(), { requests: [] }, 'the board view of a session that never used team mode');
  });

test('TB-57 a task instance labels its changes with its role and task; the dialog with the role holding it',
  async () => {
    const { team, host } = await setup();
    addTask(team);
    await nextDelivery(host, 'U.t1.executor');
    assert.deepEqual(host.entry('U.t1.executor').spec.runAgent(), { role: 'executor', task: 'T1', self: false });
    assert.deepEqual(team.holderAgent(), { role: 'chat', task: null, self: true }, 'split: chat holds the dialog');
    const merged = (await setup(MERGED)).team;
    assert.deepEqual(merged.holderAgent(), { role: 'mori', task: null, self: true }, 'merged: the base role mori');
  });

// ---- 合并会话判断的原文（§5.3、§5.4） ----

test('TB-07 merged session: a prompt template is judged as what you typed; the request records it', async () => {
  const templates = [{ name: 'fix', description: '', content: 'Fix $1 please', sourceInfo: {}, filePath: 'f' }];
  const { team, host } = await setup(MERGED, null, { templates });
  await team.setMode('on');
  team.onUserPrompt({ text: '/fix login' }, undefined, undefined);
  const reply = await nextDialog(host);
  await reply.ready;
  // synthetic：pi 照 v0 在用户会话里展开提示词模板
  await runDelivery(host, { ...reply, text: 'Fix login please' }, [{ calls: [SUBMIT] }, { text: 'Registered.' }]);
  assert.equal(B.findRequest(team.board, 1).words[0].text, '/fix login');
});

test('TB-56 merged session: a message an extension command sends with sendUserMessage gets no decision', async () => {
  const { team, host } = await setup(MERGED, null, { commands: ['deploy'] });
  await team.setMode('on');
  assert.equal(team.takesPrompt('/deploy now', undefined), false);
  const run = { id: 'U', text: 'Generated by the deploy command', resolve: () => undefined };
  const results = await runDelivery(host, run, [{ calls: [SUBMIT] }]);
  assert.equal(results[0].isError, true, 'no user message to register a request for');
  assert.equal(team.board.requests.length, 0, 'the extension text is not recorded as the user\'s words');
});
