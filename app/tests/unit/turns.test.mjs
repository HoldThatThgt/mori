// 步骤组（2026-10-26 走查 M18，WP-14；docs/v0/screens/chat.md"步骤组"）的单元测试：界面的 state/turns.ts
// stepGroups（一轮里连续的思考块与工具卡、什么时候折起）、stepsLabel（Claude 的 "{n} steps" 加 " · k failed"）、
// itemSteps（每条回复怎么画：摘要行、收着的块）、foldedIn（跳转前要展开的组）。
// 真实录制（tests/fixtures/m1/*.json，m1-record.mjs 从真实会话录下）的事件按界面的同一条路径（state/transcript.ts
// applyEvent）归并成对话流，每一步都算一次组；重新打开用录制里 session.open 带回的会话条目（state/history.ts）。
// 标了 synthetic 的对话流是测试手写的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @brief 把要测的界面模块打成一个包再导入；打包结果按进程命名，导入后删掉（同 load.mjs）。 */
async function loadRenderer() {
  const outDir = join(appRoot, 'test-results', 'unit-bundles');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `renderer_turns.${process.pid}.mjs`);
  const contents = ["export * from './src/renderer/src/state/turns';",
    "export { applyEvent } from './src/renderer/src/state/transcript';",
    "export { emptyTranscript } from './src/renderer/src/state/model';",
    "export { transcriptFromEntries } from './src/renderer/src/state/history';"].join('\n');
  await build({ stdin: { contents, resolveDir: appRoot, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node',
    target: 'node22', packages: 'external', outfile, logLevel: 'silent' });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
}

const R = await loadRenderer();

/** @brief 读一份 m1 的录制。 */
const fixture = (name) => JSON.parse(readFileSync(join(appRoot, 'tests/fixtures/m1', `${name}.json`), 'utf8'));

/** @brief 最后一轮在运行（同 Transcript.tsx：本轮在运行或最后一条回复还在流入，且最后一轮还没被你的消息结束）。 */
function liveTurn(state) {
  const last = state.items.findLast((item) => item.kind === 'assistant');
  return (state.running || Boolean(last?.streaming)) && !R.lastTurnEnded(state.items);
}

/** @brief 这一刻的步骤组。 */
const groupsOf = (state) => R.stepGroups(state.items, state.tools, liveTurn(state));

/**
 * @brief 按录制的顺序把这个会话的事件归并成对话流，每个事件之后调一次 onStep(state, event)；返回最后的对话流和
 *        录制里 session.open 带回的会话条目（没有时为 null）。
 */
function replay(name, onStep = () => {}) {
  const fx = fixture(name);
  let state = R.emptyTranscript;
  let session = null;
  let entries = null;
  for (const step of fx.steps) {
    if (step.result?.type === 'session.create') session = step.result.value.sessionId;
    if (step.result?.type === 'session.open') entries = step.result.value.entries ?? null;
    const envelope = step.envelope;
    if (envelope?.kind !== 'event' || envelope.sessionId !== session) continue;
    state = R.applyEvent(state, envelope.event, step.t);
    onStep(state, envelope.event);
  }
  return { state, entries };
}

/** @brief 对话流里思考块（有字的）与有工具卡的调用数，按回复。 */
function countBlocks(state) {
  let thinking = 0;
  let tools = 0;
  for (const item of state.items) {
    if (item.kind !== 'assistant') continue;
    for (const block of item.blocks) {
      if (block.type === 'thinking' && block.text.trim()) thinking += 1;
      if (block.type === 'tool' && state.tools[block.id]) tools += 1;
    }
  }
  return { thinking, tools };
}

// ---- synthetic 的对话流 ----

/** @brief 一条助手回复（synthetic）。 */
const reply = (key, blocks, streaming = false) => ({ kind: 'assistant', key, blocks, streaming, entryId: null,
  time: null });
/** @brief 你的消息（synthetic）。 */
const user = (key) => ({ kind: 'user', key, text: 'hi', refs: null, entryId: null, time: null });
const think = (text = 'thinking') => ({ type: 'thinking', text, streaming: false });
const say = (text = 'answer') => ({ type: 'text', text });
const call = (id) => ({ type: 'tool', id });
/** @brief 工具调用（synthetic）：id → 状态。 */
const toolsOf = (statuses) => Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id,
  { id, name: 'bash', argsText: '', args: {}, status, output: '', patch: null, memory: null, startedAt: null,
    durationMs: null, reason: null, allowedBy: null, gate: null }]));

test('WP-14 stepsLabel: Claude’s "{count, plural, one {# step} other {# steps}}" plus " · k failed"', () => {
  assert.equal(R.stepsLabel(1, 0), '1 step');
  assert.equal(R.stepsLabel(2, 0), '2 steps');
  assert.equal(R.stepsLabel(46, 4), '46 steps · 4 failed');
  assert.equal(R.stepsLabel(1, 1), '1 step · 1 failed');
  assert.equal(R.stepsLabel(1234, 0), '1,234 steps');
});

test('WP-14 readme (recorded): one group of thinking + tools stays open while the tools run, folds once the '
  + 'answer starts, and counts thinking blocks plus tool calls', () => {
  const seen = { liveOpen: 0, foldedWhileRunning: false, rowBeforeText: false };
  const { state } = replay('readme', (now) => {
    const groups = groupsOf(now);
    const running = Object.values(now.tools).some((tool) => ['preparing', 'queued', 'running'].includes(tool.status));
    if (running && liveTurn(now)) {
      seen.liveOpen += 1;
      if (groups.some((group) => group.folded)) seen.rowBeforeText = true;
    }
    if (now.running && groups.length === 1 && groups[0].folded) seen.foldedWhileRunning = true;
  });
  const groups = groupsOf(state);
  const counts = countBlocks(state);
  assert.ok(seen.liveOpen > 0, 'the replay has moments with a tool still running');
  assert.equal(seen.rowBeforeText, false, 'no group folds while one of its tools still runs');
  assert.equal(seen.foldedWhileRunning, true, 'the group folds as soon as the answer text follows it');
  assert.equal(groups.length, 1);
  assert.equal(counts.tools, 3);
  assert.equal(groups[0].steps, counts.thinking + counts.tools);
  assert.equal(groups[0].failed, 0);
  assert.equal(groups[0].folded, true);
  const last = state.items.findLast((item) => item.kind === 'assistant');
  assert.ok(!groups[0].members.some((member) => member.key === last.key
    && last.blocks[member.index].type === 'text'), 'the answer text is never a member');
  const rows = [...R.itemSteps(groups, {}).values()].flatMap((view) => Object.values(view.rows));
  assert.deepEqual(rows.map((row) => row.label), [R.stepsLabel(counts.thinking + 3, 0)]);
});

test('WP-14 command-fail (recorded): the failed command shows in the row as " · 1 failed"', () => {
  const { state } = replay('command-fail');
  const groups = groupsOf(state);
  const counts = countBlocks(state);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].failed, 1);
  assert.equal(groups[0].folded, true);
  const [view] = [...R.itemSteps(groups, {}).values()];
  const [row] = Object.values(view.rows);
  assert.equal(row.label, `${R.stepsLabel(counts.thinking + counts.tools, 1)}`);
  assert.match(row.label, / · 1 failed$/);
});

test('WP-14 stop (recorded): Stop ends the turn, so the group folds although no text follows; reopened from '
  + 'the session file it is folded too', () => {
  let liveRunning = false;
  const { state, entries } = replay('stop', (now) => {
    if (now.running && Object.values(now.tools).some((tool) => tool.status === 'running')) {
      liveRunning ||= groupsOf(now).length === 1 && !groupsOf(now)[0].folded;
    }
  });
  assert.ok(liveRunning, 'while the command runs the group is open');
  const groups = groupsOf(state);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].folded, true);
  assert.ok(state.items.some((item) => item.kind === 'stopped'), 'the Stopped notice is not a member');
  assert.ok(entries, 'the recording reopens the session');
  const reopened = R.transcriptFromEntries(entries);
  const again = groupsOf(reopened);
  assert.ok(again.length >= 1 && again.every((group) => group.folded), JSON.stringify(again));
});

test('WP-14 two-tools-steer (recorded): the steer message ends the first turn, so its group folds while pi '
  + 'still runs', () => {
  let folded = false;
  replay('two-tools-steer', (now) => {
    const steered = now.items.filter((item) => item.kind === 'user').length === 2;
    if (steered && now.running) folded ||= groupsOf(now).some((group) => group.folded && group.members.length >= 2);
  });
  assert.ok(folded);
});

test('WP-14 synthetic: a run of thinking blocks only is not a group; empty blocks and calls without a card are '
  + 'skipped', () => {
  const items = [user('u1'), reply('a1', [think(), say()]), reply('a2', [think('  '), say(''), call('x'), think()])];
  assert.deepEqual(R.stepGroups(items, toolsOf({}), false), []);
  const withCard = [user('u1'), reply('a1', [think(), say(''), call('t1'), call('x')]), reply('a2', [say()])];
  const [group] = R.stepGroups(withCard, toolsOf({ t1: 'done' }), false);
  assert.deepEqual(group.members, [{ key: 'a1', index: 0 }, { key: 'a1', index: 2 }]);
  assert.equal(group.steps, 2);
  assert.equal(group.id, 'a1:2');
});

test('WP-14 synthetic: while the turn runs a group folds only when text follows and its calls have ended', () => {
  const tools = toolsOf({ t1: 'done', t2: 'running' });
  // 模型在同一条回复里先调用、后写字（调用还在执行）：不折起，等调用结束。
  const items = [user('u1'), reply('a1', [think(), call('t1')]), reply('a2', [call('t2'), say('then')], true)];
  const groups = R.stepGroups(items, tools, true);
  assert.deepEqual(groups.map((g) => [g.id, g.steps, g.folded]), [['a2:0', 3, false]],
    'consecutive steps across replies are one group; a running call keeps it open although text follows');
  const done = R.stepGroups(items, toolsOf({ t1: 'done', t2: 'done' }), true);
  assert.deepEqual(done.map((g) => g.folded), [true]);
  const noText = [user('u1'), reply('a1', [think(), call('t1')]), reply('a2', [call('t2')], true)];
  assert.deepEqual(R.stepGroups(noText, toolsOf({ t1: 'done', t2: 'awaiting' }), true).map((g) => g.folded), [false]);
  assert.deepEqual(R.stepGroups(noText, toolsOf({ t1: 'done', t2: 'stopped' }), false).map((g) => g.folded), [true]);
});

test('WP-14 synthetic: any item that is not an assistant reply ends a group; your message ends the turn', () => {
  const tools = toolsOf({ t1: 'done', t2: 'done', t3: 'failed' });
  const items = [user('u1'), reply('a1', [call('t1')]), { kind: 'model-switch', key: 'n1' },
    reply('a2', [call('t2')], true)];
  const live = R.stepGroups(items, tools, true);
  assert.deepEqual(live.map((g) => [g.id, g.folded]), [['a1:0', false], ['a2:0', false]]);
  const next = [...items.slice(0, 3), reply('a2', [call('t2')]), user('u2'), reply('a3', [call('t3')], true)];
  const groups = R.stepGroups(next, tools, true);
  assert.deepEqual(groups.map((g) => [g.id, g.folded, g.failed]), [['a1:0', true, 0], ['a2:0', true, 0],
    ['a3:0', false, 1]]);
  const wake = [user('u1'), reply('a1', [call('t1')]), { kind: 'wake', key: 'w1', wakeKind: 'progress',
    entryId: null, time: null }, reply('a2', [call('t2')], true)];
  assert.deepEqual(R.stepGroups(wake, tools, true).map((g) => g.folded), [true, false]);
  const receipt = [user('u1'), reply('a1', [call('t1')]), { kind: 'receipt', key: 'r1', receipt: {} },
    reply('a2', [say()], true)];
  assert.deepEqual(R.stepGroups(receipt, tools, true).map((g) => g.folded), [true], 'text after it in the same turn folds it');
});

test('WP-14 synthetic itemSteps: the row sits before the first shown member, members are hidden until you open '
  + 'the group, and a live group has no row', () => {
  const tools = toolsOf({ t1: 'done', t2: 'failed', t3: 'running' });
  const items = [user('u1'), reply('a1', [say('first'), think(), call('t1')]), reply('a2', [call('t2')]),
    reply('a3', [say('then'), call('t3')], true)];
  const groups = R.stepGroups(items, tools, true);
  const views = R.itemSteps(groups, {});
  assert.deepEqual(views.get('a1'), { group: { 1: 'a2:0', 2: 'a2:0' }, hidden: [1, 2],
    rows: { 1: { id: 'a2:0', label: '3 steps · 1 failed', open: false } } });
  assert.deepEqual(views.get('a2'), { group: { 0: 'a2:0' }, hidden: [0], rows: {} });
  assert.deepEqual(views.get('a3'), { group: { 1: 'a3:1' }, hidden: [], rows: {} }, 'live group: no row');
  assert.deepEqual(R.foldedIn(views.get('a2')), ['a2:0']);
  const opened = R.itemSteps(groups, { 'a2:0': true });
  assert.deepEqual(opened.get('a1').hidden, []);
  assert.equal(opened.get('a1').rows[1].open, true);
  assert.deepEqual(R.foldedIn(opened.get('a2')), []);
  assert.equal(views.has('u1'), false);
});

test('WP-14 synthetic: a group cut by "Scroll up to load earlier messages" keeps its id, its row moves to the '
  + 'first shown member and counts only the loaded steps', () => {
  const tools = toolsOf({ t1: 'done', t2: 'done', t3: 'done' });
  const items = [user('u1'), reply('a1', [think(), call('t1')]), reply('a2', [call('t2')]), reply('a3', [call('t3')]),
    reply('a4', [say()])];
  const [whole] = R.stepGroups(items, tools, false);
  const [cut] = R.stepGroups(items.slice(2), tools, false);
  assert.equal(whole.id, 'a3:0');
  assert.equal(cut.id, whole.id);
  assert.equal(whole.steps, 4);
  assert.equal(cut.steps, 2);
  const views = R.itemSteps([cut], { 'a3:0': true });
  assert.deepEqual(Object.keys(views.get('a2').rows), ['0']);
  assert.equal(views.get('a2').rows[0].open, true, 'your choice is kept by id');
});
