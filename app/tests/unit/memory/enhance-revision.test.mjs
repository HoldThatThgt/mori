// 一次增强运行的修订、失败与重试、中途退出与 token（kernel/enhanceRun.ts、enhance.ts 与记忆模块的 beginRun/endRun，
// docs/specs/memory.md §9.6、§9.8–§9.10）。增强运行、调度、记忆模块与 pi 的会话列表都用真的；会话表换成替身（synthetic）：
// 看不见的会话的 act 带着这次运行的句柄经记忆模块写入（就是 memory 工具写入时做的），然后按 script 结束、失败或一直不结束。
// “后台进程重新启动”是同一个 userData 上再打包一次（新的模块实例），上一个包不再动（同进程被结束）。
// 用户会话文件、反馈与 enhance.json 由测试按 pi 会话文件、§3 与 §9.1 的格式手写（synthetic）。时刻按本地时间写。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  at, enhanceJson, enhancer, ended, messageOf, monDayTime, readEnhance, runSetup as setup, settle, turn, until,
  usageLine, writeEnhance, writeFeedback, writeSession,
} from './enhance-harness.mjs';

/** 只跑某一个任务：另外两个的 doneThrough 在很后面 */
const only = (task) => Object.fromEntries(['taste', 'strategy', 'review'].filter((each) => each !== task)
  .map((each) => [each, { doneThrough: '2026-12-31' }]));
/** 回滚的写入方 */
const ROLLBACK = { by: 'Rollback', caller: null, run: null };

/** @brief 条目文件的原文；不存在时为 null。 */
function entryText(env, cwd, slug) {
  const path = join(env.k.memory.projectDir(cwd).dir, 'entries', `${slug}.md`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** @brief 一项会话依据（synthetic，存下的形状 §3.2）。 */
const ev = (session, entry, quote) => ({ at: '2026-10-22', session, entry, title: 'Question r1', quote });

/** @brief 这个项目某一种的 abstract（读得出来的，按索引顺序）。 */
async function abstractsOf(env, cwd, kind) {
  return (await env.k.memory.list(cwd, 'project', kind)).entries.map((entry) => entry.abstract);
}

/**
 * @brief 之前一次运行学到的两条 STRATEGY 条目与记忆页写的一条（synthetic：直接经记忆模块的 beginRun/save/endRun 写）。
 * @return 三条的写入结果：old、stale、page
 */
async function seedStrategy(env, cwd, session) {
  const memory = env.k.memory;
  const earlier = await memory.beginRun({ cwd, task: 'strategy', day: '2026-10-20', sessions: 1, feedback: 0 });
  const old = await memory.save(enhancer('strategy', earlier), { cwd, layer: 'project', kind: 'strategy',
    abstract: 'Plan before changing more than three modules', detail: 'List the steps first.',
    evidence: [ev(session, 'r1u', 'old')] });
  const stale = await memory.save(enhancer('strategy', earlier), { cwd, layer: 'project', kind: 'strategy',
    abstract: 'Rewrite modules from scratch', detail: '', evidence: [ev(session, 'r1u', 'older')] });
  await memory.endRun(earlier, { status: 'done', tokens: 0, notes: null });
  const page = await memory.save({ by: 'You', caller: null, run: null }, { cwd, layer: 'project',
    kind: 'strategy', abstract: 'Ask before deleting files', detail: '', evidence: [] });
  assert.deepEqual([old.error, stale.error, page.error], [null, null, null]);
  return { old, stale, page };
}

/**
 * @brief 这次运行里的写入（synthetic，同 memory 工具带着运行的句柄写）：新增一条、改 old 两次、先加后删一条、删 stale。
 *        每次写入的结果依次放进 results：added、改一、改二、temporary、删 temporary、删 stale。
 */
function strategyWrites(env, cwd, session, seeds, results) {
  const memory = env.k.memory;
  return (spec) => ({ reply: 'Merged two strategy entries. Conflicts: none.', act: async () => {
    const actor = enhancer('strategy', spec.run);
    const target = { cwd, layer: 'project', kind: 'strategy', id: seeds.old.id };
    results.push(await memory.save(actor, { cwd, layer: 'project', kind: 'strategy',
      abstract: 'Small fixes go straight in', detail: 'One-line config changes need no plan.',
      evidence: [ev(session, 'r1u', 'just fix it')] }));
    results.push(await memory.update(actor, { target, detail: 'List the steps, then wait for a yes.',
      evidence: [ev(session, 'r1u', 'tell me first')], note: 'narrowed' }));
    results.push(await memory.update(actor, { target, abstract: 'Plan before changing more than four modules',
      evidence: [ev(session, 'r1u', 'tell me first'), ev(session, 'r1a', 'four is fine')], note: 'widened' }));
    const temporary = await memory.save(actor, { cwd, layer: 'project', kind: 'strategy',
      abstract: 'Temporary idea', detail: '', evidence: [ev(session, 'r1u', 'maybe')] });
    results.push(temporary);
    results.push(await memory.forget(actor, { target: { ...target, id: temporary.id }, note: 'not supported',
      evidence: [ev(session, 'r1a', 'no')] }));
    results.push(await memory.forget(actor, { target: { ...target, id: seeds.stale.id },
      note: 'contradicted on Oct 22', evidence: [ev(session, 'r1u', 'stop doing that')] }));
  } });
}

/**
 * @brief 跑一次 Oct 22 的 STRATEGY 增强（只有它该跑），里面按 strategyWrites 写入。
 * @return 场景、工作目录、之前的条目、运行前 old 与 stale 的原文、每次写入的结果、这次运行的修订
 */
async function strategyRun(t) {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const cwd = env.project('shop');
  const session = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
    items: turn('r1', '2026-10-22', '10:00') });
  const seeds = await seedStrategy(env, cwd, session);
  const before = { old: entryText(env, cwd, seeds.old.id), stale: entryText(env, cwd, seeds.stale.id) };
  const results = [];
  env.script = strategyWrites(env, cwd, session, seeds, results);
  writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
    tasks: only('strategy') }));
  await env.startEnhance();
  assert.equal((await ended(env, cwd, 'strategy', '2026-10-22')).phase, 'done');
  assert.deepEqual(results.map((result) => result.error), [null, null, null, null, null, null]);
  const rows = (await env.k.memory.revisions(cwd, 'project')).revisions
    .filter((row) => row.title === 'STRATEGY enhancement · Oct 22');
  assert.equal(rows.length, 1, 'every write of the run went into one revision');
  const { revision } = await env.k.memory.revision(cwd, 'project', rows[0].id);
  return { env, cwd, seeds, before, results, revision };
}

test('MEM-22 one run is one revision: an entry changed twice is one section, added-then-deleted is absent',
  async (t) => {
    const { env, cwd, seeds, before, results, revision } = await strategyRun(t);
    const [added, , , temporary] = results;
    assert.deepEqual([revision.status, revision.by, revision.counts], ['done', 'Enhancement',
      { added: 1, changed: 1, deleted: 1, moved: 0 }]);
    assert.equal(revision.notes, 'Merged two strategy entries. Conflicts: none.', 'Notes is the last reply');
    assert.deepEqual(revision.run, { task: 'strategy', day: '2026-10-22', tokens: 120, sessions: 1, feedback: 0 });
    assert.equal(revision.changes.length, 3, 'one section per entry');
    const bySlug = Object.fromEntries(revision.changes.map((change) => [(change.to ?? change.from).slug, change]));
    assert.deepEqual(Object.keys(bySlug).sort(), [added.id, seeds.old.id, seeds.stale.id].sort(),
      'the added-then-deleted entry is absent');
    assert.equal(temporary.id in bySlug, false);
    assert.deepEqual([bySlug[added.id].action, bySlug[added.id].before, bySlug[added.id].after],
      ['added', '', entryText(env, cwd, added.id)]);
    const changed = bySlug[seeds.old.id];
    assert.deepEqual([changed.action, changed.before, changed.after],
      ['changed', before.old, entryText(env, cwd, seeds.old.id)], 'before is the pre-run file, after the final one');
    assert.equal(changed.evidence, 'Oct 22 · Session “Question r1”: “tell me first”; '
      + 'Oct 22 · Session “Question r1”: “four is fine”', 'both writes’ evidence, in order, without repeats');
    const deleted = bySlug[seeds.stale.id];
    assert.deepEqual([deleted.action, deleted.from, deleted.to, deleted.before, deleted.after, deleted.note,
      deleted.evidence], ['deleted', { layer: 'project', slug: seeds.stale.id }, null, before.stale, '',
      'contradicted on Oct 22', 'Oct 22 · Session “Question r1”: “stop doing that”'], 'the reason is the Note');
  });

test('MEM-22 the run reaches enhance.json, the notice and new sessions; Roll back this revision restores it all',
  async (t) => {
    const { env, cwd, seeds, before, results, revision } = await strategyRun(t);
    const [added] = results;
    const task = readEnhance(env.k.memory, cwd).tasks.strategy;
    assert.deepEqual([task.last.status, task.last.revision, task.last.counts],
      ['done', revision.id, { added: 1, changed: 1, deleted: 1 }]);
    assert.deepEqual(readEnhance(env.k.memory, cwd).notice, { revisions: [revision.id],
      counts: { taste: 0, strategy: 3, review: 0 }, from: '2026-10-22', to: '2026-10-22' });
    const announced = env.events.filter((event) => event.type === 'mori.memory_changed'
      && event.revision === revision.id);
    assert.ok(announced.length >= 2, 'beginRun and endRun both announce the revision');
    for (const event of [announced[0], announced.at(-1)]) {
      assert.deepEqual([event.cwd, event.layers, event.kinds], [cwd, ['project'], ['strategy']]);
    }
    // 之后新建的会话用新版（会话打开时的快照，§5.2）
    assert.deepEqual((await env.k.memory.abstracts(cwd)).project.strategy, [
      'Plan before changing more than four modules', 'Ask before deleting files', 'Small fixes go straight in']);
    // Roll back this revision：整次恢复
    assert.equal((await env.k.memory.rollback(ROLLBACK, cwd, 'project', revision.id)).error, null);
    assert.equal(entryText(env, cwd, added.id), null);
    assert.equal(entryText(env, cwd, seeds.old.id), before.old, 'restored byte for byte');
    assert.equal(entryText(env, cwd, seeds.stale.id), before.stale, 'the deleted entry comes back as it was');
    assert.deepEqual(await abstractsOf(env, cwd, 'strategy'), ['Plan before changing more than three modules',
      'Ask before deleting files', 'Rewrite modules from scratch'], 'a restored entry goes to the end');
  });

test('MEM-22 a run with no change still leaves a done revision with its Notes, and no notice', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const cwd = env.project('shop');
  writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
    items: turn('n1', '2026-10-22', '10:00') });
  env.script = () => ({ reply: 'Nothing new. This belongs in AGENTS.md: the build uses pnpm.' });
  writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
    tasks: only('review') }));
  await env.startEnhance();
  assert.equal((await ended(env, cwd, 'review', '2026-10-22')).phase, 'done');
  const [row] = (await env.k.memory.revisions(cwd, 'project')).revisions;
  const { revision } = await env.k.memory.revision(cwd, 'project', row.id);
  assert.deepEqual([revision.title, revision.status, revision.counts, revision.changes],
    ['REVIEW enhancement · Oct 22', 'done', { added: 0, changed: 0, deleted: 0, moved: 0 }, []]);
  assert.equal(revision.notes, 'Nothing new. This belongs in AGENTS.md: the build uses pnpm.');
  const file = readEnhance(env.k.memory, cwd);
  assert.deepEqual(file.tasks.review.last.counts, { added: 0, changed: 0, deleted: 0 });
  assert.equal(file.notice, null, 'nothing changed: no notice');
});

test('MEM-23 an endpoint error fails the run and moves nothing; the next round re-runs the same day', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const cwd = env.project('shop');
  const session = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
    items: [...turn('e1', '2026-10-22', '10:00'), ...turn('e2', '2026-10-23', '10:00')] });
  writeFeedback(env.userData, { name: 'fb.json', cwd, at: at('2026-10-22', '11:00') });
  let failing = true;
  // 端点出错（synthetic）：会话没有回复，Notes 是失败原因（§9.8）
  env.script = (spec) => (failing ? { fail: 'synthetic: 404 model not found', reply: null,
    act: () => env.k.memory.save(enhancer('taste', spec.run), { cwd, layer: 'project', kind: 'taste',
      abstract: 'Lead with the answer', detail: '', evidence: [ev(session, 'e1u', 'answer first')] }) } : {});
  writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
    tasks: only('taste') }));
  await env.startEnhance();
  const failedEvent = await ended(env, cwd, 'taste', '2026-10-22');
  assert.deepEqual([failedEvent.phase, failedEvent.error], ['failed', 'synthetic: 404 model not found']);
  const task = readEnhance(env.k.memory, cwd).tasks.taste;
  assert.deepEqual([task.doneThrough, task.watermarks, task.feedbackSeen, task.running],
    ['2026-10-21', {}, null, null], 'watermarks, feedbackSeen and doneThrough do not move');
  assert.deepEqual([task.last.day, task.last.status, task.last.error, task.last.counts],
    ['2026-10-22', 'failed', 'synthetic: 404 model not found', { added: 1, changed: 0, deleted: 0 }]);
  const { revision } = await env.k.memory.revision(cwd, 'project', task.last.revision);
  assert.deepEqual([revision.status, revision.notes], ['failed', 'synthetic: 404 model not found']);
  assert.deepEqual(readEnhance(env.k.memory, cwd).notice?.revisions, [revision.id], 'a written change is noticed');
  const info = await env.k.enhance.enhanceInfo(cwd);
  assert.equal(env.k.shared.enhanceStatusText(info), 'On · Last run failed (TASTE): synthetic: 404 model not found'
    + ` · Next run ${monDayTime(at('2026-10-24', '04:00'))}`);
  const firstMessage = messageOf(env, 'taste', '2026-10-22');
  failing = false;
  env.clock.fire();
  assert.equal((await ended(env, cwd, 'taste', '2026-10-22', 2)).phase, 'done', 'the same day runs again');
  assert.equal((await ended(env, cwd, 'taste', '2026-10-23')).phase, 'done');
  const again = messageOf(env, 'taste', '2026-10-22', 2);
  const material = (text) => text.slice(text.indexOf('Sessions to read'), text.indexOf('Current entries'));
  assert.equal(material(again), material(firstMessage), 'the retry reads the same lines and feedback');
  const after = readEnhance(env.k.memory, cwd).tasks.taste;
  assert.deepEqual([after.doneThrough, after.watermarks, after.feedbackSeen],
    ['2026-10-23', { [session]: 'e2a' }, new Date(at('2026-10-22', '11:00')).toISOString()]);
  // 失败那次写入的改动可以用它的修订回滚
  assert.equal((await env.k.memory.rollback(ROLLBACK, cwd, 'project', revision.id)).error, null);
  assert.deepEqual(await abstractsOf(env, cwd, 'taste'), []);
});

test('MEM-23 a task failing two rounds while the others run on to later days keeps the failure status line',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: [...turn('g1', '2026-10-22', '10:00'), ...turn('g2', '2026-10-23', '10:00')] });
    env.script = (spec) => (spec.task === 'strategy' ? { fail: 'synthetic: endpoint down' } : {});
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    await ended(env, cwd, 'review', '2026-10-22');
    env.clock.fire();
    assert.equal((await ended(env, cwd, 'strategy', '2026-10-22', 2)).phase, 'failed');
    assert.equal((await ended(env, cwd, 'review', '2026-10-23')).phase, 'done');
    await settle();
    const file = readEnhance(env.k.memory, cwd);
    assert.deepEqual(['taste', 'strategy', 'review'].map((task) => file.tasks[task].doneThrough),
      ['2026-10-23', '2026-10-21', '2026-10-23']);
    assert.equal(env.built.filter((item) => item.spec.task === 'strategy').length, 2, 'Oct 23 waits for Oct 22');
    assert.equal(env.k.shared.enhanceStatusText(await env.k.enhance.enhanceInfo(cwd)),
      `On · Last run failed (STRATEGY): synthetic: endpoint down · Next run ${monDayTime(at('2026-10-25', '04:00'))}`);
  });

test('MEM-23 a run left running when Mori closed is failed at the next start, kept in the notice, re-run and undoable',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const session = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('c1', '2026-10-22', '10:00') });
    env.script = (spec) => ({ hang: true, act: () => env.k.memory.save(enhancer('taste', spec.run), { cwd,
      layer: 'project', kind: 'taste', abstract: 'Ask before large refactors', detail: '',
      evidence: [ev(session, 'c1u', 'ask me')] }) });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: only('taste') }));
    await env.startEnhance();
    const stale = await until(() => readEnhance(env.k.memory, cwd).tasks.taste.running, 'the running revision');
    await until(async () => (await env.k.memory.revision(cwd, 'project', stale)).revision?.counts.added === 1,
      'the write inside the run');
    // 后台进程被结束（不收尾）；同一个 userData 上新的后台进程启动
    env.crashed = true;
    let release;
    const restarted = await setup(t, at('2026-10-23', '05:10'), env);
    restarted.script = () => ({ release: new Promise((done) => { release = done; }) });
    await restarted.startEnhance();
    const { revision } = await restarted.k.memory.revision(cwd, 'project', stale);
    assert.deepEqual([revision.status, revision.notes, revision.counts.added], ['failed', 'Mori closed during the run',
      1]);
    await until(() => restarted.built.length === 1, 'the day to run again');
    const task = readEnhance(restarted.k.memory, cwd).tasks.taste;
    assert.deepEqual({ ...task.last, at: undefined }, { day: '2026-10-22', at: undefined, status: 'failed',
      error: 'Mori closed during the run', revision: stale, tokens: 0, counts: { added: 1, changed: 0, deleted: 0 } });
    assert.notEqual(task.running, stale, 'running now names the new run’s revision');
    assert.equal(task.doneThrough, '2026-10-21');
    assert.deepEqual(readEnhance(restarted.k.memory, cwd).notice, { revisions: [stale],
      counts: { taste: 1, strategy: 0, review: 0 }, from: '2026-10-22', to: '2026-10-22' });
    release();
    assert.equal((await ended(restarted, cwd, 'taste', '2026-10-22')).phase, 'done');
    assert.equal(readEnhance(restarted.k.memory, cwd).tasks.taste.doneThrough, '2026-10-22');
    assert.equal(env.built[0].closed, false, 'the first process never closed its session');
    assert.equal((await restarted.k.memory.rollback(ROLLBACK, cwd, 'project', stale)).error, null);
    assert.deepEqual(await abstractsOf(restarted, cwd, 'taste'), [], 'the written change rolls back');
  });

test('MEM-23 tokens add the enhancement session and every instance file of its team folder, done or failed',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('k1', '2026-10-22', '10:00') });
    const ms = at('2026-10-23', '05:01');
    const instances = [
      { name: 'T1-executor.jsonl', lines: [usageLine('i1', ms, { input: 7, output: 3 }),
        usageLine('i2', ms, { input: 1, output: 1 }, 'toolResult'), '{broken'] },
      { name: 'T2-reviewer.jsonl', lines: [usageLine('i3', ms, { input: 50, output: 5 })] },
      { name: 'notes.txt', lines: [usageLine('i4', ms, { input: 900, output: 900 })] },
    ];
    env.script = (spec) => ({ usage: { input: 100, output: 20 }, instances,
      ...(spec.task === 'strategy' ? { fail: 'synthetic: 500 Internal Server Error' } : {}) });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: { review: { doneThrough: '2026-12-31' } } }));
    await env.startEnhance();
    assert.equal((await ended(env, cwd, 'taste', '2026-10-22')).phase, 'done');
    assert.equal((await ended(env, cwd, 'strategy', '2026-10-22')).phase, 'failed');
    const expected = 120 + 10 + 2 + 55;
    const file = readEnhance(env.k.memory, cwd);
    for (const task of ['taste', 'strategy']) {
      assert.equal(file.tasks[task].last.tokens, expected, `${task}: last.tokens`);
      const { revision } = await env.k.memory.revision(cwd, 'project', file.tasks[task].last.revision);
      assert.equal(revision.run.tokens, expected, `${task}: run.tokens`);
    }
    assert.ok(env.built.every((item) => existsSync(join(item.teamDir, 'sessions', 'T1-executor.jsonl'))));
  });

test('MEM-23 without a reply in team-off mode the run fails; a setup failure still leaves a Failed revision',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('m1', '2026-10-22', '10:00') });
    env.script = (spec) => (spec.task === 'taste' ? { reply: null }
      : { startError: 'synthetic: Project folder not found' });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: { review: { doneThrough: '2026-12-31' } } }));
    await env.startEnhance();
    const noReply = await ended(env, cwd, 'taste', '2026-10-22');
    assert.equal(noReply.phase, 'failed');
    assert.ok(noReply.error, 'a reason is given');
    const setupFailed = await ended(env, cwd, 'strategy', '2026-10-22');
    assert.deepEqual([setupFailed.phase, setupFailed.error], ['failed', 'synthetic: Project folder not found']);
    const file = readEnhance(env.k.memory, cwd);
    const { revision } = await env.k.memory.revision(cwd, 'project', file.tasks.strategy.last.revision);
    assert.deepEqual([revision.status, revision.notes, revision.counts],
      ['failed', 'synthetic: Project folder not found', { added: 0, changed: 0, deleted: 0, moved: 0 }]);
    assert.deepEqual([file.tasks.taste.running, file.tasks.strategy.running], [null, null]);
  });

test('MEM-23 a refused start, an unavailable model and an errored last reply fail the run with their reasons',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('q1', '2026-10-22', '10:00') });
    // 拒绝启动的说明（ModelBlocked 的形状，synthetic）
    const blocked = { kind: 'agents_invalid', detail: '', candidates: [], actions: ['check_agents'], verifyRefs: [],
      problems: ['.mori/agents/chat.md: name is required'] };
    env.script = (spec) => ({
      taste: { blocked },
      strategy: { event: { type: 'mori.model_unavailable' }, reply: null },
      review: { lastAssistant: { stopReason: 'error', errorMessage: 'synthetic: 429 Too Many Requests' },
        reply: null },
    })[spec.task];
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    const reasons = {};
    for (const task of ['taste', 'strategy', 'review']) {
      const event = await ended(env, cwd, task, '2026-10-22');
      assert.equal(event.phase, 'failed', task);
      reasons[task] = event.error;
    }
    assert.deepEqual(reasons, { taste: 'agents_invalid: .mori/agents/chat.md: name is required',
      strategy: 'No model available', review: 'synthetic: 429 Too Many Requests' });
    assert.equal(env.built[0].message, null, 'a refused session gets no first message');
    assert.ok(env.built.every((item) => item.closed), 'every session is closed');
    const file = readEnhance(env.k.memory, cwd);
    for (const task of ['taste', 'strategy', 'review']) {
      assert.deepEqual([file.tasks[task].doneThrough, file.tasks[task].watermarks], ['2026-10-21', {}], task);
      const { revision } = await env.k.memory.revision(cwd, 'project', file.tasks[task].last.revision);
      assert.deepEqual([revision.status, revision.notes], ['failed', reasons[task]], task);
    }
  });

test('MEM-23 closing Mori stops the run in progress as failed (Mori closed during the run); nothing else starts',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const other = env.project('zz-other');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('w1', '2026-10-22', '10:00') });
    // 还没回复就被停下（synthetic）：Notes 是失败原因（§9.8）
    env.script = () => ({ hang: true, reply: null });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: only('taste') }));
    writeEnhance(env.k.memory, other, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    const id = await until(() => readEnhance(env.k.memory, cwd).tasks.taste.running, 'the running revision');
    const running = (await env.k.memory.revision(cwd, 'project', id)).revision;
    assert.deepEqual([running.status, running.run.tokens], ['running', null], 'beginRun wrote a running revision');
    assert.ok((await env.k.enhance.enhanceInfo(other)).queued > 0);
    await env.k.enhance.stopEnhance();
    const { revision } = await env.k.memory.revision(cwd, 'project', id);
    assert.deepEqual([revision.status, revision.notes], ['failed', 'Mori closed during the run']);
    const task = readEnhance(env.k.memory, cwd).tasks.taste;
    assert.deepEqual([task.running, task.last.status, task.last.error, task.doneThrough],
      [null, 'failed', 'Mori closed during the run', '2026-10-21']);
    assert.deepEqual([env.built[0].stopped, env.built[0].closed], [true, true]);
    assert.deepEqual(env.clock.pending(), [], 'no timer is left');
    await settle();
    assert.equal(env.built.length, 1, 'the other project’s queued runs do not start');
  });

test('MEM-23 when the run’s revision can’t be finished, running stays in enhance.json and the next start closes it',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('v1', '2026-10-22', '10:00') });
    // 写修订失败（synthetic）：原子写的临时文件名被一个文件夹占着，endRun 写不成
    let blocker = null;
    env.script = (spec) => ({ act: () => {
      blocker = join(env.k.memory.projectDir(cwd).dir, 'revisions', `${spec.run.id}.md.tmp`);
      mkdirSync(blocker, { recursive: true });
    } });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: only('taste') }));
    await env.startEnhance();
    const event = await ended(env, cwd, 'taste', '2026-10-22');
    assert.equal(event.phase, 'failed');
    const task = readEnhance(env.k.memory, cwd).tasks.taste;
    assert.ok(task.running, 'running is kept for the next start');
    assert.deepEqual([task.last.status, task.last.revision, task.doneThrough], ['failed', task.running, '2026-10-21']);
    assert.equal((await env.k.memory.revision(cwd, 'project', task.running)).revision.status, 'running');
    rmSync(blocker, { recursive: true, force: true });
    const restarted = await setup(t, at('2026-10-23', '05:10'), env);
    await restarted.startEnhance();
    const { revision } = await restarted.k.memory.revision(cwd, 'project', task.running);
    assert.deepEqual([revision.status, revision.notes], ['failed', 'Mori closed during the run']);
    assert.equal((await ended(restarted, cwd, 'taste', '2026-10-22')).phase, 'done', 'and the day runs again');
    assert.equal(readEnhance(restarted.k.memory, cwd).tasks.taste.running, null);
  });

test('MEM-22 Notes is the session’s last reply even when the run fails; with no reply or no session it is the reason',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('h1', '2026-10-22', '10:00') });
    const reply = 'Nothing changed. Conflict: TASTE wants short replies, REVIEW wants detail. AGENTS.md: use pnpm.';
    // 回复之后端点出错、没有回复就出错、最后一条回复没有正文就中断（synthetic）
    env.script = (spec) => ({
      taste: { reply, fail: 'synthetic: 500 Internal Server Error' },
      strategy: { reply: null, fail: 'synthetic: 404 model not found' },
      review: { reply: '', lastAssistant: { stopReason: 'aborted', errorMessage: 'synthetic: request aborted' } },
    })[spec.task];
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    const expected = {
      taste: { error: 'synthetic: 500 Internal Server Error', notes: reply },
      strategy: { error: 'synthetic: 404 model not found', notes: 'synthetic: 404 model not found' },
      review: { error: 'synthetic: request aborted', notes: 'synthetic: request aborted' },
    };
    for (const task of ['taste', 'strategy', 'review']) {
      const event = await ended(env, cwd, task, '2026-10-22');
      assert.deepEqual([event.phase, event.error], ['failed', expected[task].error], task);
      const last = readEnhance(env.k.memory, cwd).tasks[task].last;
      assert.equal(last.error, expected[task].error, `${task}: the reason stays in last.error`);
      const { revision } = await env.k.memory.revision(cwd, 'project', last.revision);
      assert.deepEqual([revision.status, revision.notes], ['failed', expected[task].notes], task);
    }
  });

test('MEM-23 a revision this process left running is failed before its task runs again, and its run is released',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('l1', '2026-10-22', '10:00') });
    // 第一次运行写修订失败（synthetic）：原子写的临时文件名被一个文件夹占着，endRun 写不成
    let blocker = null;
    env.script = (spec) => (blocker !== null ? {} : { act: () => {
      blocker = join(env.k.memory.projectDir(cwd).dir, 'revisions', `${spec.run.id}.md.tmp`);
      mkdirSync(blocker, { recursive: true });
    } });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: only('taste') }));
    await env.startEnhance();
    assert.equal((await ended(env, cwd, 'taste', '2026-10-22')).phase, 'failed');
    const left = readEnhance(env.k.memory, cwd).tasks.taste.running;
    assert.ok(left, 'running is kept: endRun could not write');
    const handle = env.built[0].spec.run;
    rmSync(blocker, { recursive: true, force: true });
    // 同一个后台进程里这个任务再跑（Oct 24 04:00 到点：Oct 22 重跑、Oct 23）
    env.clock.fire();
    assert.equal((await ended(env, cwd, 'taste', '2026-10-22', 2)).phase, 'done', 'the day runs again');
    assert.equal((await ended(env, cwd, 'taste', '2026-10-23')).phase, 'skipped');
    const { revision } = await env.k.memory.revision(cwd, 'project', left);
    assert.deepEqual([revision.status, revision.notes], ['failed', 'Mori closed during the run'],
      'closed the way §9.10 closes it, instead of being overwritten in running');
    const rows = (await env.k.memory.revisions(cwd, 'project')).revisions;
    assert.deepEqual(rows.filter((row) => row.status === 'running'), [], 'no revision stays Running');
    assert.equal(readEnhance(env.k.memory, cwd).tasks.taste.running, null);
    await assert.rejects(env.k.memory.endRun(handle, { status: 'done', tokens: 0, notes: null }), /already ended/,
      'the leftover run’s state is released');
  });

test('MEM-23 when enhance.json can’t record the running revision, no session is built and the revision fails',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('j1', '2026-10-22', '10:00') });
    const file = writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: only('taste') }));
    const before = readFileSync(file, 'utf8');
    // enhance.json 写不成（synthetic）：原子写的临时文件名被一个文件夹占着；修订照样写得成
    mkdirSync(`${file}.tmp`, { recursive: true });
    await env.startEnhance();
    const event = await ended(env, cwd, 'taste', '2026-10-22');
    assert.equal(event.phase, 'failed');
    assert.ok(event.error && event.revision, 'the reason and the revision are reported');
    assert.equal(env.built.length, 0, 'no session is built for a run nobody could find after a crash');
    const { revision } = await env.k.memory.revision(cwd, 'project', event.revision);
    assert.deepEqual([revision.status, revision.notes], ['failed', event.error]);
    assert.equal(readFileSync(file, 'utf8'), before, 'enhance.json is unchanged: running was never recorded');
    assert.ok(env.errors.some((line) => line.includes(`recording the running revision ${event.revision}`)));
  });

test('MEM-23 a Run now sent while the next start closes the leftover run waits for it: closed once, no live run hit',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const session = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('m1', '2026-10-22', '10:00') });
    env.script = (spec) => ({ hang: true, act: () => env.k.memory.save(enhancer('taste', spec.run), { cwd,
      layer: 'project', kind: 'taste', abstract: 'Keep replies short', detail: '',
      evidence: [ev(session, 'm1u', 'short please')] }) });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: only('taste') }));
    await env.startEnhance();
    const stale = await until(() => readEnhance(env.k.memory, cwd).tasks.taste.running, 'the running revision');
    await until(async () => (await env.k.memory.revision(cwd, 'project', stale)).revision?.counts.added === 1,
      'the write inside the run');
    // 后台进程被结束（不收尾）；新的后台进程启动的同时你点了 Run now
    env.crashed = true;
    const restarted = await setup(t, at('2026-10-23', '05:10'), env);
    const [, run] = await Promise.all([restarted.startEnhance(), restarted.k.enhance.runNow(cwd)]);
    assert.equal(run.error, null);
    for (const day of ['2026-10-22', '2026-10-23']) await ended(restarted, cwd, 'taste', day);
    for (const task of ['strategy', 'review']) await ended(restarted, cwd, task, '2026-10-23');
    const { revision } = await restarted.k.memory.revision(cwd, 'project', stale);
    assert.deepEqual([revision.status, revision.notes], ['failed', 'Mori closed during the run']);
    assert.deepEqual(readEnhance(restarted.k.memory, cwd).notice?.revisions, [stale], 'the leftover is noticed once');
    const rows = (await restarted.k.memory.revisions(cwd, 'project')).revisions;
    assert.deepEqual(rows.filter((row) => row.status === 'running'), [], 'no revision stays Running');
    assert.deepEqual(rows.filter((row) => row.id !== stale && row.status === 'failed'), [],
      'only the leftover is failed: the new runs were not taken for it');
  });
