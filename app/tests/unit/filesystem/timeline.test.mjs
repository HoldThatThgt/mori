// 时间线与归属的纯函数（docs/specs/file-system.md §4.5、§4.6、§4.7、§5.3、§5.6、§5.7；验收 §19.2 FS-09，
// 以及挂在最近条目下的 FS-07、FS-08、FS-11、FS-12、FS-16、FS-17、FS-20、FS-26）：kernel/timeline.ts 不读写文件、
// 不调 git，这里直接喂数据。会话条目、快照提交与树、git 的输出都是手写的（synthetic）；§4.5 的例子逐行重放。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const T = await loadKernelModule('src/kernel/timeline.ts');
const S = await loadKernelModule('src/shared/workspace.ts');

/** 标出的 Agent（synthetic）：对话本身、§4.5 例子里的实例（Executor 做 T2） */
const MORI = Object.freeze({ role: 'Mori', task: null, self: true });
const EXEC = Object.freeze({ role: 'Executor', task: 'T2', self: false });

/** @brief 一个用户会话的条目（synthetic）：每加一条都接在当前叶子下面，叶子随之移动（同 pi 的 append*）。 */
class Log {
  constructor() {
    this.entries = [];
    this.leaf = null;
  }

  /** @brief 加一条条目。 */
  add(entry) {
    this.entries.push({ parentId: this.leaf, ...entry });
    this.leaf = entry.id;
    return entry.id;
  }

  /** @brief 你的消息（role user，没有 mori.wake 指向）。 */
  you(id) {
    return this.add({ type: 'message', id, message: { role: 'user' } });
  }

  /** @brief 助手的回复。 */
  reply(id) {
    return this.add({ type: 'message', id, message: { role: 'assistant' } });
  }

  /** @brief 程序投递的 [Mori] 消息与指向它的 mori.wake（写在它之后，平行 Agent 规格 §5.6）。 */
  deliver(id) {
    this.add({ type: 'message', id, message: { role: 'user' } });
    return this.add({ type: 'custom', id: `${id}-wake`, customType: 'mori.wake',
      data: { messageId: id, kind: 'relay' } });
  }

  /** @brief 不是消息的条目（例如 Team 的回执）：只移动叶子。 */
  custom(id, customType = 'mori.receipt', data = {}) {
    return this.add({ type: 'custom', id, customType, data });
  }

  /** @brief 扩展的 custom 消息（sendMessage(…, { triggerTurn })）。 */
  customMessage(id) {
    return this.add({ type: 'custom_message', id, customType: 'ext' });
  }

  /** @brief 这一刻的样子（UserView）。 */
  view() {
    return { leaf: this.leaf, entries: [...this.entries] };
  }
}

/** @brief 一个改动的文件（synthetic）。 */
function changed(path, status = 'M', added = 1, removed = 1) {
  return { path, status, added, removed };
}

/** @brief 用户会话自己的运行：开始时的叶子与是否由 user 消息开始；开始快照由 Sim 填上。 */
function ownRun(user, leaf, byUser = true, agent = MORI) {
  return { user, agent: { ...agent }, own: { start: null, leaf, byUser } };
}

/** @brief 实例的运行（own 为 null）。 */
function instanceRun(user, agent = EXEC) {
  return { user, agent: { ...agent }, own: null };
}

/**
 * @brief 按 snapshots.ts 的 closeShot 的顺序重放快照（synthetic 的提交 c<n>、树 t<n>）：segmentBase 不为 null 时才给 files，
 *        开始的运行先填上开始快照，再 closeSegment，时间线换成结果。
 */
class Sim {
  constructor(last = { oid: 'c0', tree: 't0' }) {
    this.timeline = { last, active: new Map(), open: new Map(), held: new Map() };
    this.count = 0;
  }

  /**
   * @param step { logs: { user: Log }, files?, start?: { key, run }, end?, tree?, failed?, nested? }
   * @return closeSegment 的结果加上这一张
   */
  shot(step) {
    this.count += 1;
    const snap = step.failed ? null : { oid: `c${this.count}`, tree: step.tree ?? `t${this.count}` };
    const base = snap ? T.segmentBase(this.timeline, snap) : null;
    if (step.start?.run.own) step.start.run.own.start = snap ? snap.oid : null;
    const views = new Map(Object.entries(step.logs).map(([user, log]) => [user, log.view()]));
    const result = T.closeSegment({
      timeline: this.timeline, snap, files: base === null ? null : (step.files ?? []), start: step.start ?? null,
      end: step.end ?? null, views, nested: step.nested ?? false, at: 1000 + this.count,
    });
    this.timeline = result.timeline;
    return { ...result, snap };
  }
}

/**
 * @brief 一条 changes 记录（对照用）：Sim 里一段总在相邻两张之间，base 是 head 的前一张，记录的时刻同 Sim 的 at。
 * @param head 这一段结束的那一张（c<n>）
 */
function changes(round, head, files, agents, overlap) {
  const n = Number(head.slice(1));
  return { v: 1, kind: 'changes', round, base: `c${n - 1}`, head, files, total: files.length, agents, overlap,
    at: 1000 + n };
}

/** @brief closeSegment 结果里各会话的记录，按会话 id。 */
function byUser(result) {
  return Object.fromEntries(result.changes.map(({ user, record }) => [user, record]));
}

// ---- §4.5 的例子逐行 ----

/** @brief 例子开头：A 有过一轮，B 有过一轮；S1 A 由你的消息 M3 开始。 */
function exampleStart() {
  const A = new Log();
  A.you('a1');
  A.reply('a1r');
  const B = new Log();
  B.you('b1');
  B.reply('b1r');
  const sim = new Sim();
  const s1 = sim.shot({ logs: { A }, files: [changed('idle.txt')], start: { key: 'piA', run: ownRun('A', 'a1r') } });
  return { A, B, sim, s1 };
}

test('FS-09 §4.5 example S1–S3: idle segment unrecorded, T and B join A’s turn M3', () => {
  const { A, B, sim, s1 } = exampleStart();
  assert.deepEqual(s1.changes, [], 'S1: nobody was running, the segment is not recorded');
  assert.equal(s1.run, null);
  assert.deepEqual(s1.timeline.open.get('A'), { leaf: 'a1r', own: true });
  A.you('m3');
  const a = [changed('a.txt')];
  const s2 = sim.shot({ logs: { A }, files: a, start: { key: 'piT', run: instanceRun('A') } });
  assert.deepEqual(s2.changes, [{ user: 'A', record: changes('m3', 'c2', a, [MORI], false) }]);
  A.reply('m3r');
  const s3 = sim.shot({ logs: { A, B }, files: a, start: { key: 'piB', run: ownRun('B', 'b1r') } });
  assert.deepEqual(s3.changes, [{ user: 'A', record: changes('m3', 'c3', a, [MORI, EXEC], false) }]);
  assert.equal(s3.run, null);
  assert.deepEqual([...s3.timeline.active.keys()], ['piA', 'piT', 'piB']);
  assert.deepEqual(s3.timeline.open.get('B'), { leaf: 'b1r', own: true });
});

test('FS-09 §4.5 example S4–S6: overlap while both sessions run, run records for A and B', () => {
  const { A, B, sim } = exampleStart();
  A.you('m3');
  const a = [changed('a.txt')];
  sim.shot({ logs: { A }, files: a, start: { key: 'piT', run: instanceRun('A') } });
  sim.shot({ logs: { A, B }, files: a, start: { key: 'piB', run: ownRun('B', 'b1r') } });
  B.you('bm');
  const s4 = sim.shot({ logs: { A, B }, files: a, end: 'piA' });
  assert.deepEqual(byUser(s4), { A: changes('m3', 'c4', a, [MORI, EXEC], true),
    B: changes('bm', 'c4', a, [MORI], true) }, 'S4: A (M3) and B (its start message), overlap');
  assert.deepEqual(s4.run, { user: 'A', record: { v: 1, kind: 'run', round: 'm3', start: 'c1', end: 'c4', at: 1004 } });
  const s5 = sim.shot({ logs: { A, B }, files: a, end: 'piT' });
  assert.deepEqual(byUser(s5), { A: changes('m3', 'c5', a, [EXEC], true),
    B: changes('bm', 'c5', a, [MORI], true) }, 'S5: A (M3, Executor (T2)) and B, overlap');
  assert.equal(s5.run, null, 'an instance run writes no run record');
  const s6 = sim.shot({ logs: { A, B }, files: a, end: 'piB' });
  assert.deepEqual(s6.changes, [{ user: 'B', record: changes('bm', 'c6', a, [MORI], false) }]);
  assert.deepEqual(s6.run, { user: 'B', record: { v: 1, kind: 'run', round: 'bm', start: 'c3', end: 'c6', at: 1006 } });
  assert.equal(s6.timeline.active.size, 0);
  assert.equal(s6.timeline.open.size, 0);
  const s7 = sim.shot({ logs: { A, B }, files: a });
  assert.deepEqual(s7.changes, [], 'after everyone ended the next segment is idle and not recorded');
});

test('FS-09 unchanged tree: no segment even while running, last stays the same snapshot', () => {
  const A = new Log();
  A.you('p1');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1') } });
  A.you('m1');
  const before = sim.timeline.last;
  assert.equal(T.segmentBase(sim.timeline, { oid: before.oid, tree: before.tree }), null);
  const same = T.closeSegment({ timeline: sim.timeline, snap: before, files: [changed('a.txt')], start: null,
    end: 'piA', views: new Map([['A', A.view()]]), nested: false, at: 5 });
  assert.deepEqual(same.changes, [], 'the tree did not change, so the segment records nothing');
  assert.deepEqual(same.timeline.last, before);
  assert.deepEqual(same.run, { user: 'A', record: { v: 1, kind: 'run', round: 'm1', start: 'c1', end: 'c1', at: 5 } });
});

test('FS-09 a segment with no file changes records nothing; a failed snapshot clears last', () => {
  const A = new Log();
  A.you('p1');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1') } });
  A.you('m1');
  assert.deepEqual(sim.shot({ logs: { A }, files: [], start: { key: 'piT', run: instanceRun('A') } }).changes, []);
  const failed = sim.shot({ logs: { A }, failed: true, end: 'piT' });
  assert.equal(failed.timeline.last, null, 'a snapshot that was not taken clears last');
  assert.deepEqual(failed.changes, []);
  const next = sim.shot({ logs: { A }, files: [changed('a.txt')], end: 'piA' });
  assert.deepEqual(next.changes, [], 'after a failed snapshot the next segment has no base');
  assert.equal(next.run.record.round, 'm1');
});

test('FS-09 a steering message only gets the segments that start after it is written', () => {
  const A = new Log();
  A.you('p1');
  A.reply('p1r');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1r') } });
  A.you('m1');
  A.reply('m1r');
  A.you('s1');
  const s2 = sim.shot({ logs: { A }, files: [changed('a.txt')], start: { key: 'piT', run: instanceRun('A') } });
  assert.equal(byUser(s2).A.round, 'm1', 'the segment started before the steer, so it stays with the start message');
  const s3 = sim.shot({ logs: { A }, files: [changed('b.txt')], end: 'piA' });
  assert.equal(byUser(s3).A.round, 's1', 'the segment that started after the steer belongs to it');
  assert.equal(s3.run.record.round, 'm1', 'the run record stays with the start message');
  const s4 = sim.shot({ logs: { A }, files: [changed('c.txt')], end: 'piT' });
  assert.equal(byUser(s4).A.round, 's1');
  assert.equal(s4.run, null, 'the steering message gets no run record');
});

test('FS-09 one run with only start and end snapshots: everything goes to the start message', () => {
  const A = new Log();
  A.you('p1');
  A.reply('p1r');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1r') } });
  A.you('m1');
  A.you('q1');
  A.you('s1');
  const end = sim.shot({ logs: { A }, files: [changed('a.txt')], end: 'piA' });
  assert.deepEqual(end.changes.map(({ record }) => record.round), ['m1'], 'queued and steering messages get nothing');
  assert.equal(end.run.record.round, 'm1');
});

test('FS-09 a run started by a [Mori] delivery belongs to your latest message and writes no run record', () => {
  const A = new Log();
  A.you('p1');
  A.reply('p1r');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1r') } });
  A.deliver('d1');
  A.reply('d1r');
  const end = sim.shot({ logs: { A }, files: [changed('a.txt')], end: 'piA' });
  assert.deepEqual(end.changes.map(({ record }) => record.round), ['p1']);
  assert.equal(end.run, null);
});

test('FS-09 a session with no message of yours yet gets no record for its segment', () => {
  const B = new Log();
  const sim = new Sim();
  sim.shot({ logs: { B }, start: { key: 'piB', run: ownRun('B', null) } });
  B.deliver('d1');
  const end = sim.shot({ logs: { B }, files: [changed('a.txt')], end: 'piB' });
  assert.deepEqual(end.changes, []);
  assert.equal(end.run, null);
});

// 协作模式分开时立项在对话写下你的消息之前就派出 task（docs/v1/fs-checks.md 第 22 条）：会话里还没有你的消息时，task 的段
// 先留着，之后写下的第一条你的消息是它的轮；它在这条消息的 run 记录之前写下。
test('FS-11 split team mode: a task’s segment before your first message is written goes to that message', () => {
  const U = new Log();
  U.custom('team', 'mori.team');
  const T1 = Object.freeze({ role: 'executor', task: 'T1', self: false });
  const sim = new Sim();
  sim.shot({ logs: { U }, start: { key: 'piT1', run: instanceRun('U', T1) } });
  const readme = [changed('README.md')];
  const s2 = sim.shot({ logs: { U }, files: readme, start: { key: 'piU', run: ownRun('U', U.leaf) } });
  assert.deepEqual(s2.changes, [], 'your message is not written yet: nothing recorded');
  assert.deepEqual([...s2.timeline.held.keys()], ['U'], 'the task’s segment is held for U');
  U.you('m1');
  U.reply('m1r');
  const s3 = sim.shot({ logs: { U }, files: [], end: 'piU' });
  assert.deepEqual(s3.changes, [{ user: 'U', record: changes('m1', 'c2', readme, [T1], false) }]);
  assert.equal(s3.run.record.round, 'm1');
  assert.equal(s3.timeline.held.size, 0, 'nothing is held once the message is written');
  const s4 = sim.shot({ logs: { U }, files: [changed('next.txt')], end: 'piT1' });
  assert.equal(byUser(s4).U.round, 'm1', 'the next segments of the task go to your latest message as before');
});

test('FS-11 a held segment whose leaf left the branch is dropped; a delivery does not take it', () => {
  const B = new Log();
  const sim = new Sim();
  sim.shot({ logs: { B }, start: { key: 'piB', run: ownRun('B', null) } });
  B.deliver('d1');
  const s2 = sim.shot({ logs: { B }, files: [changed('a.txt')], end: 'piB' });
  assert.deepEqual(s2.changes, []);
  assert.equal(s2.timeline.held.get('B').length, 1, 'held until a message of yours is written');
  const s3 = sim.shot({ logs: { B }, start: { key: 'piB2', run: ownRun('B', B.leaf) } });
  assert.deepEqual(s3.changes, [], 'a [Mori] delivery is not your message');
  B.you('b1');
  const s4 = sim.shot({ logs: { B }, files: [], end: 'piB2' });
  assert.deepEqual(s4.changes.map(({ record }) => [record.round, record.head]), [['b1', 'c2']]);
  const C = new Log();
  C.custom('c0');
  const held = new Map([['C', [{ leaf: 'gone', record: changes('x', 'c9', [changed('a.txt')], [MORI], false) }]]]);
  const dropped = T.closeSegment({ timeline: { ...sim.timeline, held }, snap: null, files: null, start: null,
    end: null, views: new Map([['C', C.view()]]), nested: false, at: 1 });
  assert.equal(dropped.timeline.held.size, 0, 'a held segment whose leaf is not on the branch is dropped');
  assert.deepEqual(dropped.changes, []);
});

test('FS-09 messageType custom with a steer in the middle: earlier segment to your previous message, no run', () => {
  const A = new Log();
  A.you('p1');
  A.reply('p1r');
  const sim = new Sim();
  const s1 = sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1r', false) } });
  assert.deepEqual(s1.timeline.open.get('A'), { leaf: 'p1r', own: false }, 'a custom start is not the session’s own');
  A.customMessage('cm1');
  A.reply('cm1r');
  A.you('s1');
  const s2 = sim.shot({ logs: { A }, files: [changed('a.txt')], start: { key: 'piT', run: instanceRun('A') } });
  assert.equal(byUser(s2).A.round, 'p1', 'the steer is not treated as the start message');
  const s3 = sim.shot({ logs: { A }, files: [changed('b.txt')], end: 'piA' });
  assert.equal(byUser(s3).A.round, 's1');
  assert.equal(s3.run, null, 'a run started by a custom message has no run record, the steer neither');
});

test('FS-09 start message not written yet when an instance ends: the next segment still goes to it', () => {
  const A = new Log();
  A.you('p1');
  A.reply('p1r');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piT', run: instanceRun('A') } });
  sim.shot({ logs: { A }, files: [changed('t.txt')], start: { key: 'piA', run: ownRun('A', 'p1r') } });
  A.custom('rc1');
  const s3 = sim.shot({ logs: { A }, files: [changed('t.txt')], end: 'piT' });
  assert.equal(byUser(s3).A.round, 'p1', 'the start message is not there yet');
  assert.deepEqual(s3.timeline.open.get('A'), { leaf: 'p1r', own: true },
    'the leaf moved (rc1) but the next segment still starts at the run’s own leaf');
  A.you('m1');
  const s4 = sim.shot({ logs: { A }, files: [changed('a.txt')], end: 'piA' });
  assert.equal(byUser(s4).A.round, 'm1');
  assert.equal(s4.run.record.round, 'm1');
});

test('FS-10 run record: start is the run’s start snapshot; none when the start snapshot was not taken', () => {
  const A = new Log();
  A.you('p1');
  const sim = new Sim();
  const s1 = sim.shot({ logs: { A }, failed: true, start: { key: 'piA', run: ownRun('A', 'p1') } });
  assert.equal(s1.timeline.active.get('piA').own.start, null);
  A.you('m1');
  const s2 = sim.shot({ logs: { A }, files: [changed('a.txt')], end: 'piA' });
  assert.equal(s2.run, null, 'no start snapshot, no run record');
  sim.shot({ logs: { A }, start: { key: 'piA2', run: ownRun('A', A.leaf) } });
  A.you('m2');
  const s4 = sim.shot({ logs: { A }, failed: true, end: 'piA2' });
  assert.deepEqual(s4.run, { user: 'A', record: { v: 1, kind: 'run', round: 'm2', start: 'c3', end: null, at: 1004 } },
    'an end snapshot that failed still writes the run record with end null');
});

test('FS-09 withoutRun drops a run that never started; the open mark goes with the session’s last run', () => {
  const A = new Log();
  A.you('p1');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piT', run: instanceRun('A') } });
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1') } });
  const before = sim.timeline;
  const one = T.withoutRun(before, 'piA');
  assert.deepEqual([...one.active.keys()], ['piT']);
  assert.ok(one.open.has('A'), 'A still has its instance running');
  assert.deepEqual([...before.active.keys()], ['piT', 'piA'], 'the input is not changed');
  const none = T.withoutRun(one, 'piT');
  assert.equal(none.active.size, 0);
  assert.equal(none.open.has('A'), false);
  assert.equal(T.withoutRun(none, 'nope'), none, 'an unknown run leaves the timeline as it is');
  assert.equal(none.last, before.last);
});

test('FS-09 closeSegment does not change its input', () => {
  const A = new Log();
  A.you('p1');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1') } });
  const timeline = sim.timeline;
  const snapshot = JSON.stringify([timeline.last, [...timeline.active], [...timeline.open]]);
  T.closeSegment({ timeline, snap: { oid: 'x', tree: 'tx' }, files: [changed('a.txt')], start: null, end: 'piA',
    views: new Map([['A', A.view()]]), nested: false, at: 1 });
  assert.equal(JSON.stringify([timeline.last, [...timeline.active], [...timeline.open]]), snapshot);
});

// 恢复那一段（P→Q）去掉恢复集合 R 是 snapshots.ts 的 segmentFiles 做的（closeSegment 只收到去掉之后的文件）：
// 恢复的会话不得到这一段、别的会话保留 R 之外的改动，用真实 git 的检查见 rewind.test.mjs 的 FS-17。
test('FS-09 closeSegment records exactly the files it is given; an empty list records nothing', () => {
  const A = new Log();
  A.you('a1');
  const B = new Log();
  B.you('b0');
  const sim = new Sim();
  sim.shot({ logs: { B }, start: { key: 'piB', run: ownRun('B', 'b0') } });
  B.you('bm');
  const given = sim.shot({ logs: { A, B }, files: [changed('b.txt')] });
  assert.deepEqual(given.changes, [{ user: 'B', record: changes('bm', 'c2', [changed('b.txt')], [MORI], false) }],
    'only the session with a run gets the segment, with exactly the given files');
  const empty = sim.shot({ logs: { A, B }, files: [] });
  assert.deepEqual(empty.changes, [], 'a segment with no files records nothing');
  assert.equal(empty.timeline.active.size, 1, 'the run is still active');
});

// 嵌套的工作路径算不算同时在跑由 snapshots.ts 判断（nestedOverlap、nestedSeen），这里只看 closeSegment 用它给的 nested；
// <R> 与 <R>/app 两个会话的真实 git 检查见 runs.test.mjs 的 FS-11。
test('FS-09 closeSegment sets overlap when the caller reports a nested run; the own instance does not', () => {
  const A = new Log();
  A.you('p1');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1') } });
  A.you('m1');
  const alone = sim.shot({ logs: { A }, files: [changed('a.txt')], start: { key: 'piT', run: instanceRun('A') } });
  assert.equal(byUser(alone).A.overlap, false, 'the session’s own instance is not another session');
  const nested = sim.shot({ logs: { A }, files: [changed('app/x.txt')], end: 'piT', nested: true });
  assert.equal(byUser(nested).A.overlap, true);
});

test('FS-09 segmentShares lists each session once and each distinct agent once, in run order', () => {
  const active = new Map([
    ['piA', instanceRun('A', MORI)], ['piT1', instanceRun('A', EXEC)], ['piT2', instanceRun('A', EXEC)],
    ['piB', instanceRun('B', MORI)], ['piT3', instanceRun('A', { role: 'Executor', task: 'T3', self: false })],
  ]);
  const shares = T.segmentShares(active);
  assert.deepEqual([...shares.keys()], ['A', 'B']);
  assert.deepEqual(shares.get('A'), [MORI, EXEC, { role: 'Executor', task: 'T3', self: false }]);
  assert.deepEqual(shares.get('B'), [MORI]);
});

test('FS-11 a segment with 501 files lists 500 (in the given order) and total 501', () => {
  const A = new Log();
  A.you('p1');
  const sim = new Sim();
  sim.shot({ logs: { A }, start: { key: 'piA', run: ownRun('A', 'p1') } });
  A.you('m1');
  const files = Array.from({ length: 501 }, (_, i) => changed(`f/${String(i).padStart(3, '0')}.txt`, 'A', 1, 0));
  const record = byUser(sim.shot({ logs: { A }, files, end: 'piA' })).A;
  assert.equal(S.CHANGES_FILE_LIMIT, 500);
  assert.equal(record.files.length, 500);
  assert.equal(record.total, 501);
  assert.deepEqual(record.files, files.slice(0, 500));
});

// ---- 你的消息、Turn 编号与分支（§4.5、§5.3） ----

/** @brief 带投递、无效 mori.wake 与分叉的一组条目（synthetic）。 */
function mixedLog() {
  const log = new Log();
  log.you('u1');
  log.reply('r1');
  log.deliver('d1');
  log.custom('bad1', 'mori.wake', { messageId: '' });
  log.custom('bad2', 'mori.wake', { messageId: 'u1', kind: 'nope' });
  log.customMessage('cm');
  log.you('u2');
  log.reply('r2');
  log.you('u3');
  return log;
}

test('FS-12 wakeTargets, isYourMessage and turnNumbers skip [Mori] deliveries and malformed wakes', () => {
  const log = mixedLog();
  const wakes = T.wakeTargets(log.entries);
  assert.deepEqual([...wakes], ['d1'], 'malformed mori.wake entries are skipped');
  const byId = T.indexEntries(log.entries);
  assert.equal(T.isYourMessage(byId.get('u1'), wakes), true);
  assert.equal(T.isYourMessage(byId.get('d1'), wakes), false, 'a delivery is not your message');
  assert.equal(T.isYourMessage(byId.get('r1'), wakes), false);
  assert.equal(T.isYourMessage(byId.get('cm'), wakes), false, 'a custom message is not your message');
  assert.equal(T.isUserMessage(byId.get('d1')), true);
  assert.deepEqual([...T.turnNumbers(log.entries)], [['u1', 1], ['u2', 2], ['u3', 3]]);
});

test('FS-12 pathTo and startMessage follow the branch from the root to the leaf', () => {
  const log = mixedLog();
  const fork = { type: 'message', id: 'f1', parentId: 'r1', message: { role: 'user' } };
  const entries = [...log.entries, fork];
  const index = T.indexEntries(entries);
  assert.deepEqual(T.pathTo(index, 'f1').map((entry) => entry.id), ['u1', 'r1', 'f1']);
  assert.deepEqual(T.pathTo(index, null), []);
  assert.deepEqual(T.pathTo(index, 'missing'), []);
  const branch = T.pathTo(index, 'u3');
  assert.deepEqual([...T.turnNumbers(branch)], [['u1', 1], ['u2', 2], ['u3', 3]], 'f1 is on another branch');
  assert.equal(T.startMessage(branch, null).id, 'u1');
  assert.equal(T.startMessage(branch, 'r1').id, 'd1', 'the first role user message, delivered or not');
  assert.equal(T.startMessage(branch, 'u3'), undefined, 'nothing written after the leaf yet');
  assert.equal(T.startMessage(branch, 'f1'), undefined, 'a leaf off this branch');
  const loop = T.indexEntries([{ type: 'message', id: 'x', parentId: 'y' },
    { type: 'message', id: 'y', parentId: 'x' }]);
  assert.deepEqual(T.pathTo(loop, 'x').map((entry) => entry.id), ['y', 'x'], 'a parent cycle stops');
});

// ---- mori.turn_changes 的读取与保留（§4.6、§4.7、§5.6） ----

/** @brief 一条 mori.turn_changes 条目（synthetic）。 */
function turnEntry(id, record) {
  return { type: 'custom', id, parentId: null, customType: 'mori.turn_changes', data: record };
}

/** @brief run 记录。 */
function runRecord(round, start, end) {
  return { v: 1, kind: 'run', round, start, end, at: 1 };
}

/** @brief changes 记录。 */
function changesRecord(round, head, files = [changed('a.txt')], extra = {}) {
  return { v: 1, kind: 'changes', round, base: `${head}-base`, head, files, total: files.length, agents: [MORI],
    overlap: false, at: 1, ...extra };
}

/** @brief 一条 mori.rewind 条目（synthetic）。 */
function rewindEntry(id, post) {
  const record = { v: 1, kind: 'rewind', target: 'u1', turn: 1, code: true, conversation: false, from: null,
    safety: 'p', post, restored: [], deleted: [], skipped: [], failed: [],
    counts: { restored: 0, deleted: 0, skipped: 0, failed: 0 }, at: 1 };
  return { type: 'custom', id, parentId: null, customType: 'mori.rewind', data: record };
}

test('FS-16 turnEntries keeps valid mori.turn_changes in order and reports invalid ones', () => {
  const invalid = [];
  const entries = [turnEntry('e1', runRecord('u1', 's1', 's2')), turnEntry('e2', { v: 2, kind: 'run' }),
    { type: 'custom', id: 'e3', parentId: null, customType: 'mori.receipt', data: {} },
    turnEntry('e4', changesRecord('u1', 's3')),
    { type: 'message', id: 'e5', parentId: null, message: { role: 'user' } }];
  const found = T.turnEntries(entries, (id) => invalid.push(id));
  assert.deepEqual(found.map((item) => item.id), ['e1', 'e4']);
  assert.deepEqual(found[1].record, changesRecord('u1', 's3'));
  assert.deepEqual(invalid, ['e2']);
  assert.deepEqual(T.turnEntries([turnEntry('e2', {})]), [], 'onInvalid is optional');
});

test('FS-16 lastSnapshotOf takes the last non-null run.end, changes.head or rewind post in file order', () => {
  assert.equal(T.lastSnapshotOf([]), null);
  const entries = [turnEntry('e1', runRecord('u1', 's1', 's2')), turnEntry('e2', changesRecord('u2', 's3'))];
  assert.equal(T.lastSnapshotOf(entries), 's3');
  entries.push(turnEntry('e3', runRecord('u2', 's4', null)));
  assert.equal(T.lastSnapshotOf(entries), 's3', 'a run whose end snapshot failed does not count');
  entries.push(rewindEntry('e4', 'q1'));
  assert.equal(T.lastSnapshotOf(entries), 'q1');
  entries.push(rewindEntry('e5', null), turnEntry('e6', { kind: 'changes' }));
  assert.equal(T.lastSnapshotOf(entries), 'q1', 'a rewind without post and invalid entries do not count');
});

test('FS-20 roundsToDrop lists the earliest distinct rounds beyond keep (all branches, file order)', () => {
  const entries = [turnEntry('e1', changesRecord('r1', 'h1')), turnEntry('e2', runRecord('r1', 's1', 's2')),
    turnEntry('e3', changesRecord('r2', 'h2')), rewindEntry('e4', 'q'), turnEntry('e5', runRecord('r3', 's3', 's4')),
    turnEntry('e6', { bad: true }), turnEntry('e7', changesRecord('r4', 'h4')),
    turnEntry('e8', changesRecord('r2', 'h5'))];
  assert.deepEqual(T.roundsToDrop(entries, 3), ['r1']);
  assert.deepEqual(T.roundsToDrop(entries, 2), ['r1', 'r2']);
  assert.deepEqual(T.roundsToDrop(entries, 4), []);
  assert.deepEqual(T.roundsToDrop(entries, 100), []);
});

// ---- Rewind 的文件集合与冲突（§5.6、§5.7） ----

test('FS-16 roundsFrom gives M and your messages after it on the branch; null when M is not your message', () => {
  const branch = mixedLog().entries;
  assert.deepEqual([...T.roundsFrom(branch, 'u2')], ['u2', 'u3']);
  assert.deepEqual([...T.roundsFrom(branch, 'u1')], ['u1', 'u2', 'u3'], 'the delivery d1 is not a round');
  assert.equal(T.roundsFrom(branch, 'd1'), null);
  assert.equal(T.roundsFrom(branch, 'r1'), null);
  assert.equal(T.roundsFrom(branch, 'missing'), null);
});

test('FS-16 fileSet unions the changes of these rounds and returns records listed incompletely', () => {
  const short = changesRecord('u2', 'h2', [changed('c.txt')], { total: 3 });
  const records = [
    { id: 'e0', record: changesRecord('u0', 'h0', [changed('z.txt')]) },
    { id: 'e1', record: changesRecord('u1', 'h1', [changed('a.txt'), changed('b.txt')]) },
    { id: 'e2', record: runRecord('u1', 's1', 's2') }, { id: 'e3', record: short },
    { id: 'e4', record: changesRecord('u1', 'h4', [changed('a.txt')], { overlap: true }) },
  ];
  const rounds = new Set(['u1', 'u2']);
  const set = T.fileSet(records, rounds);
  assert.deepEqual([...set.files].sort(), ['a.txt', 'b.txt', 'c.txt'], 'z.txt is from an earlier round');
  assert.deepEqual(set.incomplete, [short]);
  assert.deepEqual([...T.overlapFiles(records, rounds)], ['a.txt']);
  assert.deepEqual([...T.overlapFiles(records, new Set(['u2']))], []);
});

test('FS-16 conflictsOf: changed beats overlap, only files of F, sorted by path', () => {
  const conflicts = T.conflictsOf(['d.txt', 'c.txt', 'b.txt', 'a.txt'], new Set(['b.txt', 'x.txt']),
    new Set(['b.txt', 'c.txt']));
  assert.deepEqual(conflicts, [{ path: 'b.txt', reason: 'changed' }, { path: 'c.txt', reason: 'overlap' }]);
  assert.deepEqual(T.conflictsOf([], new Set(['a']), new Set(['a'])), []);
});

test('FS-16 conflictToken: first 16 hex digits of SHA-1, independent of order, changes with the set', () => {
  const a = [{ path: 'b.txt', reason: 'changed' }, { path: 'a.txt', reason: 'overlap' }];
  const token = T.conflictToken(a);
  assert.match(token, /^[0-9a-f]{16}$/);
  assert.equal(T.conflictToken([...a].reverse()), token);
  assert.notEqual(T.conflictToken([{ path: 'b.txt', reason: 'overlap' }, a[1]]), token, 'a reason changed');
  assert.notEqual(T.conflictToken([...a, { path: 'c.txt', reason: 'changed' }]), token, 'a conflict was added');
  assert.notEqual(T.conflictToken([{ path: 'b.txt', reason: 'changed' }]), token, 'a conflict was removed');
  assert.equal(T.conflictToken([{ path: 'b.txt', reason: 'changed' }, { path: 'a.txt', reason: 'overlap' }]), token,
    'the same set gives the same token');
});

test('FS-17 splitRestore: files in the base are restored, newer ones removed (exact names)', () => {
  const split = T.splitRestore(['README.md', 'Readme.md', 'src/a.ts', 'new.txt'],
    new Set(['README.md', 'src/a.ts', 'other.txt']));
  assert.deepEqual(split, { restore: ['README.md', 'src/a.ts'], remove: ['Readme.md', 'new.txt'] });
  assert.deepEqual(T.splitRestore([], new Set(['a'])), { restore: [], remove: [] });
});

// ---- git 输出的解析（§4.3、§4.4、§4.5） ----

/** @brief NUL 分隔的 git 输出（synthetic）。 */
function nul(...items) {
  return Buffer.from(items.map((item) => `${item}\0`).join(''), 'utf8');
}

/** @brief --raw 的一条（synthetic 的对象 id）。 */
function raw(src, dst, status, path) {
  return [`:${src} ${dst} ${'1'.repeat(40)} ${'2'.repeat(40)} ${status}`, path];
}

test('FS-11 parseRawNumstat: A/M/D, line counts, binary null, T as M, gitlinks and symlinks dropped', () => {
  const stdout = nul(
    ...raw('100644', '100644', 'M', 'a.txt'), ...raw('100644', '000000', 'D', 'b.txt'),
    ...raw('000000', '100644', 'A', 'c d.txt'), ...raw('100644', '100644', 'M', 'bin.dat'),
    ...raw('160000', '160000', 'M', 'sub'), ...raw('000000', '160000', 'A', 'sub2'),
    ...raw('000000', '120000', 'A', 'link'), ...raw('100644', '120000', 'T', 'was-file'),
    ...raw('100644', '100755', 'T', 'mode.sh'), ...raw('100644', '100644', 'M', 'no-count.txt'),
    '1\t1\ta.txt', '0\t2\tb.txt', '3\t0\tc d.txt', '-\t-\tbin.dat', '1\t1\tsub', '1\t0\tlink', '0\t0\tmode.sh',
  );
  assert.deepEqual(T.parseRawNumstat(stdout), [
    { path: 'a.txt', status: 'M', added: 1, removed: 1 },
    { path: 'b.txt', status: 'D', added: 0, removed: 2 },
    { path: 'bin.dat', status: 'M', added: null, removed: null },
    { path: 'c d.txt', status: 'A', added: 3, removed: 0 },
    { path: 'mode.sh', status: 'M', added: 0, removed: 0 },
    { path: 'no-count.txt', status: 'M', added: null, removed: null },
  ]);
  assert.deepEqual(T.parseRawNumstat(Buffer.alloc(0)), []);
});

test('FS-11 parseRawNumstat only reads up to the last complete NUL', () => {
  const full = nul(...raw('000000', '100644', 'A', 'a.txt'), '2\t0\ta.txt');
  const cut = Buffer.concat([full, Buffer.from(':100644 100644 x y M\0b.t', 'utf8')]);
  assert.deepEqual(T.parseRawNumstat(cut), [{ path: 'a.txt', status: 'A', added: 2, removed: 0 }]);
});

test('FS-26 parseGitlinks lists mode 160000 entries of ls-tree -r -z in tree order', () => {
  const stdout = nul(`160000 commit ${'a'.repeat(40)}\tsub`, `100644 blob ${'b'.repeat(40)}\ta.txt`,
    `160000 commit ${'c'.repeat(40)}\tdeep/nested repo`, `120000 blob ${'d'.repeat(40)}\tlink`, 'garbage');
  assert.deepEqual(T.parseGitlinks(stdout), ['sub', 'deep/nested repo']);
  assert.deepEqual(T.parseGitlinks(Buffer.alloc(0)), []);
});

test('FS-08 nulList keeps complete items only and drops empty ones', () => {
  assert.deepEqual(T.nulList(Buffer.from('a\0b c\0\0d', 'utf8')), ['a', 'b c'], 'the cut-off d is dropped');
  assert.deepEqual(T.nulList(Buffer.from('a', 'utf8')), []);
  assert.deepEqual(T.nulList(Buffer.alloc(0)), []);
  assert.deepEqual(T.nulList(nul('x/', 'y')), ['x/', 'y']);
});

test('FS-08 argBatches splits paths so each batch stays within the character limit', () => {
  assert.deepEqual(T.argBatches(['aaa', 'bb', 'c'], 7), [['aaa', 'bb'], ['c']]);
  assert.deepEqual(T.argBatches(['aaa', 'bb', 'c'], 100), [['aaa', 'bb', 'c']]);
  assert.deepEqual(T.argBatches(['much-too-long', 'b'], 4), [['much-too-long'], ['b']], 'a long path is alone');
  assert.deepEqual(T.argBatches([], 10), []);
});

test('FS-07 excludeLine anchors each ignored path and escapes it literally', () => {
  const cases = [
    ['node_modules/', '/node_modules/'], ['./', '/*'], ['a[1].log', '/a\\[1].log'], ['#notes', '/#notes'],
    ['!keep', '/!keep'], ['back\\slash', '/back\\\\slash'], ['star*', '/star\\*'], ['q?.txt', '/q\\?.txt'],
    ['trail  ', '/trail\\ \\ '], ['dir with space/', '/dir with space/'], ['src/a]b/', '/src/a]b/'],
  ];
  for (const [path, line] of cases) assert.equal(T.excludeLine(path), line, path);
});

test('FS-07 excludeText: always /.work/ and /.mori/worktrees/, then the repo’s ignored paths or the defaults', () => {
  assert.equal(T.excludeText(null),
    '/.work/\n/.mori/worktrees/\nnode_modules/\n.venv/\ndist/\nbuild/\ntarget/\n');
  assert.equal(T.excludeText(['build/', '', 'a b.log']), '/.work/\n/.mori/worktrees/\n/build/\n/a b.log\n');
  assert.equal(T.excludeText([]), '/.work/\n/.mori/worktrees/\n');
  assert.equal(T.excludeText(['./']), '/.work/\n/.mori/worktrees/\n/*\n');
});
