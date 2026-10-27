// 运行与一轮的改动（docs/specs/file-system.md §4.4–§4.7、§5.6；验收 §19.2 FS-10、FS-11、FS-20 的单元部分，以及挂在
// FS-09、FS-22 下的附加检查）：真实 git、os.tmpdir() 下的短临时目录（不是 git 仓库的 synthetic 项目），手写的 pi 接口
// 依次发 before_agent_start → agent_start → tool_execution_end → agent_settled 驱动 mori-snapshots，会话是 pi 的内存
// SessionManager。上限按 §19.1 注入（单个文件 1 KB、保留 3 轮；501 个文件的段要一次加完，新文件上限与分批取 600）。
// 每个场景用自己的工作路径（自己的内部仓库与队列），场景只跑一次、几条检查共用（once），各条检查同时跑；
// git 进程的启动是这里的主要耗时（本机约 65 个/秒），所以场景尽量少跑运行、同一文件夹里接着跑。场景里挡住队列的作业
// 都在 finally 里放开，失败时不会把别的检查挂住。
// 恢复那一段（P→Q）的归属在 rewind.test.mjs 的 FS-17 里用真实 git 测，这里只测它的纯函数（timeline.test.mjs），
// 免得同样的快照拍两遍（§19.1：整组单元测试不超过 20 秒）。符号链接不列只在纯函数层测（timeline.test.mjs 的
// parseRawNumstat，模式 120000）：本机 fs.symlinkSync 报 EPERM（没有开发者模式或管理员），目录联接 git 当作目录跟进去。

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  K, MORI, RunSession, commitAll, deferred, flush, git, nestedRepo, put, refTarget, refsUnder, repoOf, snapshotFile,
  spawns, tempRoot,
} from './runs-helpers.mjs';

/** §4.7 的原文（整理过的轮） */
const PRUNED = 'Mori keeps snapshots for the last 100 turns of a session. This turn’s snapshots were removed.';
/** 后台实例标出的 Agent（synthetic：Executor 做 T1） */
const EXECUTOR = Object.freeze({ role: 'Executor', task: 'T1', self: false });

const space = tempRoot();
K.snapshots.configureSnapshots({
  limits: { maxFileBytes: 1024, maxNewFiles: 600, batch: 600, stepTimeoutMs: 60_000, keepTurns: 3 },
});
after(() => space.remove());

/** @brief 场景只跑一次：几条检查 await 同一个结果。 */
function once(scenario) {
  let result = null;
  return () => {
    result ??= scenario();
    return result;
  };
}

/** @brief 一组 changes 记录的轮与路径（对照用）。 */
function roundsAndPaths(records) {
  return records.map((record) => [record.round, record.files.map((file) => file.path)]);
}

/** @brief 等 ms 毫秒。 */
function pause(ms) {
  return new Promise((resolveLater) => setTimeout(resolveLater, ms));
}

/** @brief promise 在 ms 毫秒内兑现，否则以 message 失败（不让一个错误把队列与整个文件挂住）。 */
function within(promise, ms, message) {
  let timer = null;
  const limit = new Promise((_, rejectLate) => {
    timer = setTimeout(() => rejectLate(new Error(message)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** @brief 事件里的 mori.snapshot_stage 的 active 值，按先后。 */
function stages(session) {
  return session.events.filter((event) => event.type === 'mori.snapshot_stage').map((event) => event.active);
}

/** @brief 一个会话的记录种类，按先后。 */
function kindsOf(session) {
  return session.records().map((record) => record.kind);
}

// ---- 场景 ----

/** @brief 第一轮：开始快照之后、写文件之前看 run/ 下的 ref；运行中插一条话。 */
async function firstRunWithRunRef(a, cwd) {
  await a.begin('user');
  const runRefs = await refsUnder(cwd, `refs/mori/s/${a.id}/run/`);
  const m1 = a.say('change a.txt');
  put(cwd, 'a.txt', 'new\n');
  const steer = a.say('also keep it short');
  await a.tool('read');
  await a.end();
  await flush(cwd);
  return { runRefs, m1, steer };
}

/**
 * @brief 同一文件夹里另一个会话：你的消息（没有运行）、一条 [Mori] 投递之后，一次扩展开始的运行（messageType custom，
 *        snapshots.ts 据此不按你的消息开始算）。[Mori] 投递开始的运行（messageType 也是 user）算不算你的消息由
 *        timeline.ts 判断（投递有 mori.wake 指向），纯函数的检查见 timeline.test.mjs，这里不再用真实 git 拍一遍。
 */
async function extensionRun(cwd) {
  const d = new RunSession(cwd);
  const mine = d.say('mine');
  d.reply('ok');
  d.deliver('Request 1 is closed.');
  await d.begin('custom');
  d.customMessage('extension says go');
  put(cwd, 'c.txt', '3\n');
  d.reply('ok');
  await d.end();
  await flush(cwd);
  d.close();
  return { d, mine };
}

/** @brief 你的消息开始的一次运行（运行中插了一条话）；之后同一文件夹里扩展开始的一次运行（extensionRun）。 */
const runsScenario = once(async () => {
  const cwd = space.folder('w-run');
  put(cwd, 'a.txt', 'old\n');
  const a = new RunSession(cwd);
  const first = await firstRunWithRunRef(a, cwd);
  a.close();
  return { cwd, a, ...first, extension: await extensionRun(cwd) };
});

/**
 * @brief A 第一次运行的开始快照在 git add 时被停止；C 的开始快照拍完了、pi 却没有开始运行（prompt() 结束，promptEnded）；
 *        之后同一文件夹里 B 运行一次（A、C 的运行若还留在 active 里，B 的那一段会记给它们、B 的记录会是 overlap）。
 */
const stopScenario = once(async () => {
  const cwd = space.folder('w-stop');
  put(cwd, 'a.txt', 'a\n');
  const a = new RunSession(cwd);
  const stop = await stopDuringAdd(a, cwd);
  const afterStop = await refsUnder(cwd, 'refs/mori/');
  const c = new RunSession(cwd);
  await c.startSnapshot('user');
  const runRefs = await refsUnder(cwd, `refs/mori/s/${c.id}/run/`);
  K.snapshots.promptEnded(c.id);
  await flush(cwd);
  const notStarted = { runRefs, after: await refsUnder(cwd, `refs/mori/s/${c.id}/`) };
  const b = new RunSession(cwd);
  const mb = await b.run('other work', () => put(cwd, 'b.txt', 'b\n'));
  for (const session of [a, b, c]) session.close();
  return { cwd, a, b, c, stop, afterStop, notStarted, mb };
});

/**
 * @brief bash 命令改的、删的、新建的文件，二进制文件与嵌套仓库，再加 497 个新文件：这一段正好 501 个文件
 *        （嵌套仓库不算）。
 */
const bashScenario = once(async () => {
  const cwd = space.folder('w-bash');
  put(cwd, 'a.txt', 'old\n');
  put(cwd, 'b.txt', 'one\ntwo\n');
  put(cwd, 'bin.dat', Buffer.from([0, 1, 2, 3, 0, 5]));
  await nestedRepo(join(cwd, 'sub'));
  const a = new RunSession(cwd);
  const round = await a.run('edit with bash', () => bashStyleChanges(cwd));
  a.close();
  return { a, round };
});

/**
 * @brief 后台实例单独运行（用户会话空闲，有过一条你的消息）：实例的扩展由 sessionWorkspace.snapshotFactory 建（同
 *        sessions.ts：kind task、owner 为用户会话）；它的结束快照排在一个作业后面，看用户会话的 settleEntry 等不等它。
 */
const instanceScenario = once(async () => {
  const cwd = space.folder('w-team');
  const a = new RunSession(cwd);
  const m1 = a.say('plan the work');
  a.reply('registered T1');
  const t = new RunSession(cwd, { owner: a, factory: (session) => taskFactory(a, session) });
  await t.begin('user');
  t.say('[Mori] work card for T1');
  put(cwd, 't.txt', 'task\n');
  const gate = deferred();
  const held = K.snapshots.inQueue(cwd, () => gate.promise);
  try {
    await t.end();
    const owner = { kind: 'user', session: { sessionId: a.id } };
    return { a, t, m1, settle: await settleBehindGate(a, owner, gate) };
  } finally {
    gate.resolve();
    await held;
    await flush(cwd);
    a.close();
  }
});

/**
 * @brief sessionWorkspace.ts 建的用户会话运行一次，它的结束快照排在一个作业后面；之后关掉它（releaseEntry），
 *        再排一个作业（trailing），看 settleEntry 等到哪里。
 */
const settleScenario = once(async () => {
  const cwd = space.folder('w-settle');
  const { a, entry } = settleSession(cwd);
  await a.begin('user');
  a.say('work');
  put(cwd, 'a.txt', 'a\n');
  const gate = deferred();
  const trailing = deferred();
  const queued = [K.snapshots.inQueue(cwd, () => gate.promise)];
  try {
    await a.end();
    queued.push(K.snapshots.inQueue(cwd, () => trailing.promise));
    K.sessionWorkspace.releaseEntry(entry);
    const settle = await settleBehindGate(a, entry, gate);
    return { a, entry, ...settle, events: a.events.some((event) => event.type === 'mori.turn_changes') };
  } finally {
    gate.resolve();
    trailing.resolve();
    await Promise.all(queued);
  }
});

/** @brief 同一文件夹里两个用户会话同时开始、同时运行；两张结束快照排在一个作业后面时看 drainSnapshots。 */
const pairScenario = once(async () => {
  const cwd = space.folder('w-pair');
  const a = new RunSession(cwd);
  const b = new RunSession(cwd);
  await Promise.all([a.begin('user'), b.begin('user')]);
  const ma = a.say('A works');
  const mb = b.say('B works');
  put(cwd, 'a.txt', 'a\n');
  put(cwd, 'b.txt', 'b\n');
  const gate = deferred();
  const held = K.snapshots.inQueue(cwd, () => gate.promise);
  try {
    await a.end();
    await b.end();
    return { cwd, a, b, ma, mb, drain: await drainBehindGate([a, b], gate) };
  } finally {
    gate.resolve();
    await held;
    a.close();
    b.close();
  }
});

/**
 * @brief <R> 与 <R>/app 各开一个会话、同时运行（各有自己的内部仓库与队列）；A 先结束、它的结束快照做完之后 C 才结束，
 *        这时 <R> 上已没有运行，C 那一段的 overlap 只能来自这一段里有过的运行（snapshots.ts 的 nestedSeen）。
 */
const nestedScenario = once(async () => {
  const outer = space.folder('w-nest');
  const inner = space.folder('app', outer);
  const a = new RunSession(outer);
  const c = new RunSession(inner);
  await Promise.all([a.begin('user'), c.begin('user')]);
  const ma = a.say('outer work');
  const mc = c.say('inner work');
  put(outer, 'a.txt', 'a\n');
  put(inner, 'c.txt', 'c\n');
  await a.end();
  await flush(outer);
  await c.end();
  await flush(inner);
  a.close();
  c.close();
  return { a, c, ma, mc };
});

// ---- 检查（按场景分组登记，同一个 describe 里同时跑） ----

/** @brief FS-20 保留与整理（四次运行一个接一个，是最长的一条，先登记）。 */
function keepTests() {
  test('FS-20 keep 3 turns: after the 4th the oldest round’s refs go, its record stays, diff and rewind say so',
    async () => {
      const cwd = space.folder('w-keep');
      const a = new RunSession(cwd);
      const rounds = [];
      for (let i = 1; i <= 4; i += 1) rounds.push(await a.run(`turn ${i}`, () => put(cwd, 'f.txt', `v${i}\n`)));
      a.close();
      const user = { sessionId: a.id, cwd, sessionManager: a.sm, emit: () => undefined, headless: false };
      const [refs, pruned, kept, rewound] = await Promise.all([
        refsUnder(cwd, `refs/mori/s/${a.id}/`),
        K.snapshots.snapshotDiff(user, rounds[0], 'f.txt'), K.snapshots.snapshotDiff(user, rounds[3], 'f.txt'),
        K.rewind.rewind(rewindSession(a), { entryId: rounds[0], code: true, conversation: false })
          .then(() => null, (error) => error),
      ]);
      const perRound = rounds.map((round) => refs.filter((ref) => ref.startsWith(`refs/mori/s/${a.id}/${round}/`)));
      assert.deepEqual(perRound.map((names) => names.length), [0, 2, 2, 2], 'the oldest round’s refs go, 3 stay');
      assert.equal(refs.length, 6, 'no run/ or other refs are left in the session');
      assert.deepEqual(a.records().filter((record) => record.round === rounds[0]).map((record) => record.kind),
        ['changes', 'run'], 'the records of the oldest round stay in the session');
      assert.equal(K.snapshots.PRUNED_TEXT, PRUNED);
      assert.deepEqual(pruned, { patch: null, binary: false, truncated: false, error: PRUNED });
      assert.equal(kept.error, null);
      assert.match(kept.patch, /^-v3$/m);
      assert.match(kept.patch, /^\+v4$/m);
      assert.equal(rewound?.message, PRUNED, 'a rewind to the oldest turn fails with the same text');
      assert.equal(readFileSync(join(cwd, 'f.txt'), 'utf8'), 'v4\n', 'nothing was restored');
    });
}

/** @brief FS-10 运行记录与 FS-11 条目、事件（w-run）。 */
function runRecordTests() {
  test('FS-10 your message’s run writes one run record: round, pre-run start, run/ ref swapped for round refs',
    async () => {
      const { cwd, a, runRefs, m1, steer } = await runsScenario();
      const run = a.records('run')[0];
      assert.equal(run.round, m1);
      assert.notEqual(run.round, steer);
      assert.equal(await snapshotFile(cwd, run.start, 'a.txt'), 'old\n', 'start is the content before the run wrote');
      assert.equal(await snapshotFile(cwd, run.end, 'a.txt'), 'new\n');
      assert.deepEqual(runRefs, [`refs/mori/s/${a.id}/run/${run.start}`], 'the start snapshot is kept under run/');
      assert.deepEqual(await refsUnder(cwd, `refs/mori/s/${a.id}/run/`), [], 'gone once the run record exists');
      assert.deepEqual((await refsUnder(cwd, `refs/mori/s/${a.id}/${m1}/`)).sort(),
        [run.start, run.end].map((oid) => `refs/mori/s/${a.id}/${m1}/${oid}`).sort());
      assert.deepEqual(roundsAndPaths(a.records('changes')), [[m1, ['a.txt']]], 'the whole run goes to m1');
      assert.equal(a.records('run').length, 1, 'the steering message gets no run record');
      assert.deepEqual(stages(a), [true, false]);
    });

  test('FS-11 the mori.turn_changes entries and the events carry the same records', async () => {
    const { a } = await runsScenario();
    const entries = a.turnEntries();
    const events = a.events.filter((event) => event.type === 'mori.turn_changes');
    assert.deepEqual(entries.map((entry) => entry.data.kind), ['changes', 'run']);
    assert.deepEqual(events, entries.map((entry) => ({ type: 'mori.turn_changes', entryId: entry.id,
      record: entry.data })));
    for (const entry of entries) {
      assert.equal(entry.type, 'custom');
      assert.equal(K.shared.TurnChangesSchema.safeParse(entry.data).success, true);
    }
  });

  test('FS-10 an extension-started run writes no run record; its changes go to your latest message', async () => {
    const { d, mine } = (await runsScenario()).extension;
    assert.deepEqual(d.records('run'), []);
    assert.deepEqual(roundsAndPaths(d.records('changes')), [[mine, ['c.txt']]], 'not to the [Mori] delivery');
    assert.deepEqual(stages(d), [true, false], 'the stage line still shows the start snapshot');
  });
}

/** @brief FS-10 运行开始的快照被停止，FS-09 开始了却没有运行（w-stop）。 */
function stopTests() {
  test('FS-10 stop during the start snapshot: git ended, no run record, nothing active; next run clears the lock',
    async () => {
      const { cwd, a, b, stop, afterStop, mb } = await stopScenario();
      assert.ok(stop.exit, 'the stand-in for the start snapshot’s git add was started');
      assert.equal(stop.stood, true, 'the start snapshot’s git add was running when the run was stopped');
      assert.notEqual(stop.exit.code, 0, 'that git process was ended, not left to finish');
      assert.equal(typeof stop.returnedIn, 'number', 'the run was stopped while its start snapshot was running');
      assert.ok(stop.returnedIn < 2000, `before_agent_start returned at once after the stop (${stop.returnedIn} ms)`);
      assert.equal(stop.lockLeft, true, 'the ended git add left index.lock behind');
      assert.deepEqual(afterStop, [], 'no start or end snapshot: no refs/mori/last, no run/ or round ref');
      assert.deepEqual(stages(a), [true, false]);
      assert.deepEqual(a.records(), [], 'the stopped run has no run record and gets no segment');
      assert.deepEqual(roundsAndPaths(b.records('changes')), [[mb, ['b.txt']]]);
      assert.equal(b.records('changes')[0].overlap, false, 'the stopped run is not in active');
      assert.deepEqual(b.records('run').map((record) => record.round), [mb], 'the next run is snapshotted as usual');
      assert.equal(K.snapshots.snapshotState(cwd).error, null);
      assert.equal(existsSync(join(repoOf(cwd), 'index.lock')), false, 'no index.lock is left behind');
    });

  test('FS-09 a run that never started after before_agent_start (promptEnded) leaves active; its run/ ref goes',
    async () => {
      const { b, c, notStarted, mb } = await stopScenario();
      assert.equal(notStarted.runRefs.length, 1, 'its start snapshot was kept under run/ while it was registered');
      assert.deepEqual(notStarted.after, [], 'promptEnded removed the run and its run/ ref');
      assert.deepEqual(c.records(), [], 'no end snapshot, no records');
      assert.deepEqual(roundsAndPaths(b.records('changes')), [[mb, ['b.txt']]]);
      assert.equal(b.records('changes')[0].overlap, false, 'the run that never started is not in active');
    });
}

/** @brief FS-11 一轮的改动记录：bash 命令的改动、501 个文件（w-bash）。 */
function changesTests() {
  test('FS-11 bash-style changes: A/M/D, line counts, binary null; nested repositories not listed', async () => {
    const { a, round } = await bashScenario();
    const [record] = a.records('changes');
    assert.equal(record.round, round);
    assert.deepEqual(record.files.slice(0, 4), [
      { path: 'a.txt', status: 'M', added: 1, removed: 1 },
      { path: 'b.txt', status: 'D', added: 0, removed: 2 },
      { path: 'bin.dat', status: 'M', added: null, removed: null },
      { path: 'c.txt', status: 'A', added: 3, removed: 0 },
    ], 'echo x > a.txt, rm b.txt, a binary edit and a new file');
    assert.deepEqual(record.files.filter((file) => file.path.startsWith('sub')), [],
      'sub and sub2 (nested repositories) and the files inside them are not listed');
    assert.deepEqual(record.agents, [MORI]);
    assert.equal(record.overlap, false);
  });

  test('FS-11 a 501-file segment lists 500 files sorted by path and total 501', async () => {
    const { a } = await bashScenario();
    const [record] = a.records('changes');
    assert.equal(record.files.length, K.shared.CHANGES_FILE_LIMIT);
    assert.equal(record.total, 501);
    const paths = record.files.map((file) => file.path);
    assert.deepEqual(paths, [...paths].sort(), 'sorted by path');
    assert.deepEqual([paths[4], paths[499]], ['f/000.txt', 'f/495.txt'], 'only the last file by path is missing');
    assert.equal(paths.includes('f/496.txt'), false, 'the last path (f/496.txt) is left out');
    assert.ok(record.files.slice(4).every((file) => file.status === 'A' && file.added === 1 && file.removed === 0));
  });
}

/** @brief FS-11 实例的运行（w-team）。 */
function instanceTests() {
  test('FS-11 an instance run is recorded into its user session with its agent; no stage line, no run record',
    async () => {
      const { a, t, m1 } = await instanceScenario();
      const [record] = a.records('changes');
      assert.equal(record.round, m1, 'recorded into the user session, in your latest turn');
      assert.deepEqual(record.agents, [EXECUTOR], 'shown as Executor (T1)');
      assert.deepEqual(record.files.map((file) => file.path), ['t.txt']);
      assert.equal(record.overlap, false, 'the session’s own instance is not another session');
      assert.deepEqual(a.records('run'), []);
      assert.equal(t.turnEntries().length, 0, 'nothing is written into the instance session');
      assert.deepEqual(stages(a), [], 'the instance run does not touch the stage line');
    });

  test('FS-11 settleEntry on the user session waits for its instance’s end snapshot (snapshotFactory)', async () => {
    const { settle } = await instanceScenario();
    assert.deepEqual(settle.early, { settled: false, records: 0 }, 'the instance’s end snapshot is still queued');
    assert.deepEqual(settle.kinds, ['changes'], 'its record is in the user session when settleEntry returns');
  });
}

/** @brief FS-11 两个会话同时运行（w-pair；<R> 与 <R>/app），FS-09 队列与没变的树，FS-22 有序退出。 */
function sessionsTests() {
  test('FS-11 two user sessions running at once in one folder: both records overlap', async () => {
    const { a, b, ma, mb } = await pairScenario();
    for (const [session, round] of [[a, ma], [b, mb]]) {
      assert.deepEqual(roundsAndPaths(session.records('changes')), [[round, ['a.txt', 'b.txt']]]);
      assert.equal(session.records('changes')[0].overlap, true);
      assert.equal(session.records('run')[0].round, round);
    }
  });

  test('FS-11 sessions in <R> and <R>/app running at once: both records overlap', async () => {
    const { a, c, ma, mc } = await nestedScenario();
    assert.deepEqual(roundsAndPaths(a.records('changes')), [[ma, ['a.txt', 'app/c.txt']]]);
    assert.deepEqual(roundsAndPaths(c.records('changes')), [[mc, ['c.txt']]]);
    assert.equal(a.records('changes')[0].overlap, true, 'the session in <R>/app was running');
    assert.equal(c.records('changes')[0].overlap, true,
      'the session in <R> ran during this segment, although it had ended before this end snapshot');
    assert.deepEqual([a, c].map((session) => session.records('run')[0]?.round), [ma, mc]);
  });

  test('FS-09 jobs in one folder never overlap: two sessions starting at once are snapshotted one after another',
    async () => {
      const { cwd } = await pairScenario();
      const repo = repoOf(cwd).toLowerCase();
      assert.equal(spawns.peak.get(repo), 1, 'one git process at a time in the internal repository');
      const steps = spawns.log.filter((item) => item.repo === repo && ['ls-files', 'write-tree'].includes(item.sub));
      assert.equal(steps.length, 8, 'four snapshots: two starts, two ends');
      assert.deepEqual(steps.map((item) => item.sub), Array(4).fill(['ls-files', 'write-tree']).flat(),
        'each snapshot job finishes its steps before the next one starts');
    });

  pairStateTests();
}

/** @brief w-pair 的另外两条：没变的树、drainSnapshots。 */
function pairStateTests() {
  test('FS-09 unchanged tree: the snapshot reuses the previous commit and its segment records nothing', async () => {
    const { cwd, a, b } = await pairScenario();
    const [runA] = a.records('run');
    const [runB] = b.records('run');
    assert.notEqual(runA.end, runA.start);
    assert.equal(runB.start, runA.start, 'the second start snapshot saw the same tree: no new commit');
    assert.equal(runB.end, runA.end, 'the second end snapshot saw the same tree: no new commit');
    assert.equal(await refTarget(cwd, 'refs/mori/last'), runA.end);
    assert.equal((await git(cwd, [`--git-dir=${repoOf(cwd)}`, 'rev-list', '--all', '--count'])).trim(), '2');
    assert.equal(b.records('changes').length, 1, 'the segment between the two end snapshots records nothing');
  });

  test('FS-22 drainSnapshots waits for queued end snapshots; their records are written when it returns', async () => {
    const { drain } = await pairScenario();
    assert.deepEqual(drain.early, { drained: false, kinds: [[], []] }, 'both end snapshots are still queued');
    assert.deepEqual(drain.atDrain, [['changes', 'run'], ['changes', 'run']],
      'A’s and B’s records were written at the moment drainSnapshots returned');
  });
}

/** @brief FS-11 关闭会话时的等待（w-settle）。 */
function settleTests() {
  test('FS-11 settleEntry waits for this session’s own end snapshot, not for jobs queued after it', async () => {
    const { a, entry, early, kinds, files, events } = await settleScenario();
    assert.deepEqual(early, { settled: false, records: 0 }, 'the end snapshot is still queued');
    assert.deepEqual(kinds, ['changes', 'run'], 'the records are written when settleEntry returns');
    assert.deepEqual(files, ['a.txt']);
    assert.equal(events, false, 'after release the records are written without events');
    await K.sessionWorkspace.settleEntry(entry);
    await K.sessionWorkspace.settleEntry({ ...entry, kind: 'task', session: { sessionId: 'instance-1' } });
    assert.equal(a.records().length, 2);
  });
}

describe('FS-10 FS-11 FS-20 snapshots of runs with real git', { concurrency: true }, () => {
  keepTests();
  runRecordTests();
  stopTests();
  changesTests();
  instanceTests();
  sessionsTests();
  settleTests();
});

// ---- 场景的步骤 ----

/**
 * @brief 结束快照排在 gate 后面时调 settleEntry：记下 gate 兑现之前的样子，放开 gate，等 settleEntry 返回（排在结束快照
 *        之后的别的作业还挡着时它也要返回：15 秒内不返回算失败），记下那一刻的记录。
 * @param a 用户会话
 * @param entry 它在 sessionWorkspace 里的样子（settleEntry 只看 kind 与会话 id）
 * @param gate 挡在结束快照前面的作业
 * @return { early: { settled, records }, kinds, files }
 */
async function settleBehindGate(a, entry, gate) {
  let settled = false;
  const settling = K.sessionWorkspace.settleEntry(entry).then(() => {
    settled = true;
  });
  await pause(50);
  const early = { settled, records: a.records().length };
  gate.resolve();
  await within(settling, 15_000, 'settleEntry kept waiting for a job queued after the session’s own end snapshot');
  return { early, kinds: kindsOf(a),
    files: a.records('changes').flatMap((record) => record.files.map((file) => file.path)) };
}

/**
 * @brief 结束快照排在 gate 后面时调 drainSnapshots（没有别的等待者）：记下 gate 兑现之前的样子，放开 gate，记下
 *        drainSnapshots 返回那一刻各会话的记录种类。drainSnapshots 等这个进程里所有的队列，可能要等别的场景做完。
 * @param sessions 结束快照在排队的会话
 * @param gate 挡在它们前面的作业
 * @return { early: { drained, kinds }, atDrain }
 */
async function drainBehindGate(sessions, gate) {
  let atDrain = null;
  const draining = K.snapshots.drainSnapshots().then(() => {
    atDrain = sessions.map(kindsOf);
  });
  await pause(50);
  const early = { drained: atDrain !== null, kinds: sessions.map(kindsOf) };
  gate.resolve();
  await within(draining, 60_000, 'drainSnapshots did not return after the queues emptied');
  return { early, atDrain };
}

/**
 * 开始快照里 git add 的替身（synthetic，经注入的 spawn）：同被打断的 git add 一样在内部仓库里拿着 index.lock，
 * 打印一行后一直等（60 秒），只有被结束才会提前退出。真实的 add 太快，停止时它常常已经退出，看不出进程是否被结束
 */
const HOLD_LOCK = "require('fs').writeFileSync(process.argv[1], ''); process.stdout.write('locked\\n');"
  + ' setTimeout(() => undefined, 60000);';

/**
 * @brief 一次运行：开始快照的 git add（替身）拿到锁就停止（stopStartSnapshot），before_agent_start 随即返回；
 *        pi 照样发 agent_start 与 agent_settled，消息也写下了。
 * @return { stood }：替身起来过；exit：它的退出码与信号；returnedIn：停止之后 before_agent_start 多久返回（没停止过为
 *         null）；lockLeft：之后锁还在
 */
async function stopDuringAdd(a, cwd) {
  const flag = `--git-dir=${repoOf(cwd)}`;
  const lock = join(repoOf(cwd), 'index.lock');
  let exited = null;
  let stoppedAt = null;
  spawns.replace = (command, args, options) => {
    if (exited || args[0] !== flag || !args.includes('add')) return null;
    const stand = spawn(process.execPath, ['-e', HOLD_LOCK, lock], options);
    exited = new Promise((resolveExit) => stand.once('exit', (code, signal) => resolveExit({ code, signal })));
    stand.stdout.once('data', () => {
      stoppedAt = Date.now();
      K.snapshots.stopStartSnapshot(a.id);
    });
    return stand;
  };
  try {
    await a.startSnapshot('user');
  } finally {
    spawns.replace = null;
  }
  const returnedIn = stoppedAt === null ? null : Date.now() - stoppedAt;
  const exit = exited ? await within(exited, 10_000, 'the git process of the start snapshot was not ended') : null;
  const lockLeft = existsSync(lock);
  await a.emit('agent_start', { type: 'agent_start' });
  a.say('first');
  await a.end();
  await flush(cwd);
  return { stood: exited !== null, exit, returnedIn, lockLeft };
}

/**
 * @brief bash 命令的效果（synthetic）：echo x > a.txt、rm b.txt、新建、改二进制、嵌套仓库提交与新建，再新建 497 个文件
 *        （内容都相同：内部仓库只写一个 blob，501 个散对象在 Windows 上要几秒，记录照样按文件算）。
 */
async function bashStyleChanges(cwd) {
  put(cwd, 'a.txt', 'x\n');
  rmSync(join(cwd, 'b.txt'));
  put(cwd, 'c.txt', '1\n2\n3\n');
  put(cwd, 'bin.dat', Buffer.from([0, 9, 9, 9, 0, 5, 6]));
  put(cwd, 'sub/inner.txt', 'changed inside the nested repository\n');
  await commitAll(join(cwd, 'sub'), 'second');
  await nestedRepo(join(cwd, 'sub2'));
  for (let i = 496; i >= 0; i -= 1) put(cwd, `f/${String(i).padStart(3, '0')}.txt`, 'same line\n');
}

/** @brief rewind.ts 要的会话接口（synthetic：不忙、没有开着的需求、导航不会被调用）。 */
function rewindSession(a) {
  return {
    sessionId: a.id, cwd: a.cwd, sessionManager: a.sm, navigateTree: async () => ({ cancelled: false }),
    busy: () => false, openRequests: () => [], recordPick: () => undefined, refsOf: () => null,
    emit: (event) => a.events.push(event),
  };
}

/**
 * @brief 实例的扩展工厂，同 sessions.ts 给 task 实例的设置（synthetic：Executor 做 T1）：kind task、owner 为用户会话 id、
 *        不是增强任务。
 * @param owner 所属的用户会话（RunSession）
 * @param session 实例自己（RunSession）
 */
function taskFactory(owner, session) {
  const setup = { kind: 'task', owner: owner.id, memory: { enhance: null }, runAgent: () => EXECUTOR };
  return K.sessionWorkspace.snapshotFactory(setup, session.id);
}

/**
 * @brief 用 sessionWorkspace.ts 的工厂与登记建一个用户会话（同 sessions.ts：snapshotFactory 在 mori-snapshots 之后排记号，
 *        registerEntry 登记进快照模块）。
 */
function settleSession(cwd) {
  const setup = { kind: 'user', owner: null, memory: { enhance: null },
    runAgent: () => K.sessionWorkspace.baseAgent() };
  const a = new RunSession(cwd, { register: false,
    factory: (session) => K.sessionWorkspace.snapshotFactory(setup, session.id) });
  const entry = {
    kind: 'user', headless: false, cwd, session: { sessionId: a.id, sessionManager: a.sm }, team: null,
    model: { recordPick: () => undefined }, running: false, preparing: null,
    emit: (envelope) => a.events.push(envelope.event),
  };
  K.sessionWorkspace.registerEntry(entry);
  return { a, entry };
}
