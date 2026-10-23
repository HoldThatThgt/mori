// 一次增强运行读哪些会话与反馈（kernel/enhanceRun.ts 经增强调度 enhance.ts，docs/specs/memory.md §9.5、§9.7、§9.8）：
// pi 的会话列表里工作目录完全相同、片段里有对话、跑的时候没在生成的会话；片段从水位之后到日界、按 since 截、按物理行编号；
// 反馈按 cwd、createdAt、feedbackSeen 选；没有会话时跳过。增强运行与调度、记忆模块、pi 的会话列表都用真的；
// 会话表换成替身（synthetic，node --test 里起不了真正的会话）：看不见的会话记下第一条消息，按测试给的 script 结束。
// 用户会话文件、反馈与 enhance.json 由测试按 pi 会话文件、§3 与 §9.1 的格式手写（synthetic）。时刻按本地时间写。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  at, enhanceJson, enhancer, ended, hooks, listedFeedback, listedSessions, messageOf, monDayTime, readEnhance,
  runSetup as setup, settle, turn, until, writeEnhance, writeFeedback, writeSession,
} from './enhance-harness.mjs';

/** 只看 TASTE：STRATEGY、REVIEW 的 doneThrough 在很后面，它们没有该跑的日子 */
const ONLY_TASTE = { strategy: { doneThrough: '2026-12-31' }, review: { doneThrough: '2026-12-31' } };

test('MEM-19 only sessions with this exact cwd and a user or assistant message in the slice are listed', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const cwd = env.project('shop');
  const own = writeSession(env.agentDir, { id: 'own', cwd, at: at('2026-10-22', '09:59'),
    items: turn('a1', '2026-10-22', '10:00', 'Fix the login page') });
  writeSession(env.agentDir, { id: 'sub', cwd: join(cwd, 'web'), at: at('2026-10-22', '09:00'),
    items: turn('b1', '2026-10-22', '10:00') });
  writeSession(env.agentDir, { id: 'other', cwd: env.project('blog'), at: at('2026-10-22', '09:00'),
    items: turn('c1', '2026-10-22', '10:00') });
  writeSession(env.agentDir, { id: 'case', cwd: cwd.toUpperCase(), at: at('2026-10-22', '09:00'),
    items: turn('d1', '2026-10-22', '10:00') });
  writeSession(env.agentDir, { id: 'pick', cwd, at: at('2026-10-19', '09:00'), items: [
    ...turn('e1', '2026-10-19', '10:00'), { id: 'e2', at: at('2026-10-22', '11:00'), custom: 'mori.pick' }] });
  writeSession(env.agentDir, { id: 'later', cwd, at: at('2026-10-23', '06:00'),
    items: turn('f1', '2026-10-23', '06:00') });
  writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
  await env.startEnhance();
  assert.equal((await ended(env, cwd, 'taste', '2026-10-22')).phase, 'done');
  assert.deepEqual(listedSessions(messageOf(env, 'taste', '2026-10-22')), [{ title: 'Fix the login page', file: own,
    from: 2, to: 3, start: `from ${monDayTime(at('2026-10-22', '10:00'))}`, team: null }],
  'subfolders, other projects, another case, mori.pick-only slices and later lines are not listed');
  const [row] = (await env.k.memory.revisions(cwd, 'project')).revisions;
  const { revision } = await env.k.memory.revision(cwd, 'project', row.id);
  assert.deepEqual(revision.run, { task: 'taste', day: '2026-10-22', tokens: 120, sessions: 1, feedback: 0 });
  const file = readEnhance(env.k.memory, cwd);
  assert.deepEqual(file.tasks.taste.watermarks, { [own]: 'a1a' }, 'the watermark is the slice’s last entry');
  assert.equal(file.tasks.taste.doneThrough, '2026-10-22');
});

test('MEM-19 a session generating during D’s run is not listed and gets no watermark; D+1 lists it from its D lines',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const busy = writeSession(env.agentDir, { id: 'busy', cwd, at: at('2026-10-22', '09:00'),
      items: turn('b1', '2026-10-22', '10:00') });
    const idle = writeSession(env.agentDir, { id: 'idle', cwd, at: at('2026-10-22', '09:00'),
      items: turn('i1', '2026-10-22', '11:00') });
    let generating = true;
    hooks().sessionGenerating = (file) => generating && file === busy;
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
    await env.startEnhance();
    await ended(env, cwd, 'taste', '2026-10-22');
    assert.deepEqual(listedSessions(messageOf(env, 'taste', '2026-10-22')).map((item) => item.file), [idle]);
    assert.deepEqual(readEnhance(env.k.memory, cwd).tasks.taste.watermarks, { [idle]: 'i1a' });
    generating = false;
    env.clock.fire();
    assert.equal((await ended(env, cwd, 'taste', '2026-10-23')).phase, 'done');
    assert.deepEqual(listedSessions(messageOf(env, 'taste', '2026-10-23')), [{ title: 'Question b1', file: busy,
      from: 2, to: 3, start: `from ${monDayTime(at('2026-10-22', '10:00'))}`, team: null }],
    'its Oct 22 lines are read on Oct 23 although it has nothing new; the idle one has nothing new');
    assert.deepEqual(readEnhance(env.k.memory, cwd).tasks.taste.watermarks, { [idle]: 'i1a', [busy]: 'b1a' });
  });

test('MEM-19 the slice ends at the day boundary; the next day lists only the lines after the watermark', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const cwd = env.project('shop');
  const file = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'), items: [
    ...turn('d1', '2026-10-22', '10:00'), ...turn('d2', '2026-10-23', '02:00'),
    ...turn('d3', '2026-10-23', '09:00')] });
  writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
  await env.startEnhance();
  await ended(env, cwd, 'taste', '2026-10-22');
  const [first] = listedSessions(messageOf(env, 'taste', '2026-10-22'));
  assert.deepEqual([first.file, first.from, first.to, first.start],
    [file, 2, 5, `from ${monDayTime(at('2026-10-22', '10:00'))}`], 'Oct 23 02:00 still belongs to Oct 22');
  env.clock.fire();
  await ended(env, cwd, 'taste', '2026-10-23');
  const [next] = listedSessions(messageOf(env, 'taste', '2026-10-23'));
  assert.deepEqual([next.from, next.to, next.start], [6, 7, 'after entry d2a']);
  assert.deepEqual(readEnhance(env.k.memory, cwd).tasks.taste.watermarks, { [file]: 'd3a' });
});

test('MEM-19 a watermark that is no longer in the file restarts the slice at since', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const cwd = env.project('shop');
  const file = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-21', '09:00'),
    items: [...turn('d0', '2026-10-21', '10:00'), ...turn('d1', '2026-10-22', '10:00')] });
  writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-22', doneThrough: '2026-10-21', tasks: ONLY_TASTE,
    watermarks: { [file]: 'gone0000' } }));
  await env.startEnhance();
  await ended(env, cwd, 'taste', '2026-10-22');
  const [listed] = listedSessions(messageOf(env, 'taste', '2026-10-22'));
  assert.deepEqual([listed.from, listed.to, listed.start], [4, 5, `from ${monDayTime(at('2026-10-22', '10:00'))}`]);
});

test('MEM-19 after turning enhancement off for some days and on again, the off days are not in the slice',
  async (t) => {
    const env = await setup(t, at('2026-10-22', '12:00'));
    const cwd = env.project('shop');
    const file = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-15', '09:00'), items: [
      ...turn('o1', '2026-10-15', '10:00'), ...turn('o2', '2026-10-17', '10:00'),
      ...turn('o3', '2026-10-22', '11:00')] });
    writeEnhance(env.k.memory, cwd, enhanceJson({ enabled: false, since: '2026-10-15', doneThrough: '2026-10-15',
      watermarks: { [file]: 'o1a' } }));
    await env.startEnhance();
    assert.equal((await env.k.enhance.setEnhance(cwd, { enabled: true })).error, null);
    assert.deepEqual(await env.k.enhance.runNow(cwd), { error: null });
    await ended(env, cwd, 'taste', '2026-10-22');
    const [listed] = listedSessions(messageOf(env, 'taste', '2026-10-22'));
    assert.deepEqual([listed.from, listed.to, listed.start], [6, 7, `from ${monDayTime(at('2026-10-22', '11:00'))}`],
      'Oct 17 was written while enhancement was off');
  });

test('MEM-19 lines are physical lines: with a malformed middle line the listed lines are the ones read sees',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const file = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'), items: [
      ...turn('p1', '2026-10-22', '10:00'), '{"type":"message","id":"half', '',
      ...turn('p2', '2026-10-22', '11:00')] });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE,
      watermarks: { [file]: 'p1a' } }));
    await env.startEnhance();
    await ended(env, cwd, 'taste', '2026-10-22');
    const [listed] = listedSessions(messageOf(env, 'taste', '2026-10-22'));
    assert.deepEqual([listed.from, listed.to, listed.start], [6, 7, 'after entry p1a']);
    const raw = readFileSync(file, 'utf8').split('\n');
    assert.deepEqual([JSON.parse(raw[listed.from - 1]).id, JSON.parse(raw[listed.to - 1]).id], ['p2u', 'p2a'],
      'read with offset 6 and limit 2 returns exactly these entries');
    assert.deepEqual(readEnhance(env.k.memory, cwd).tasks.taste.watermarks, { [file]: 'p2a' });
  });

test('MEM-19 a session with a TaskBoard folder is listed with it; the enhancement’s own sessions are never listed',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const teamDir = join(env.userData, 'teams', 'with-team');
    mkdirSync(join(teamDir, 'sessions'), { recursive: true });
    writeFileSync(join(teamDir, 'board.json'), '{}\n');
    writeFileSync(join(teamDir, 'sessions', 'T1-executor.jsonl'), '');
    const own = writeSession(env.agentDir, { id: 'with-team', cwd, at: at('2026-10-22', '09:00'),
      items: turn('t1', '2026-10-22', '10:00') });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
    await env.startEnhance();
    await ended(env, cwd, 'taste', '2026-10-22');
    const [listed] = listedSessions(messageOf(env, 'taste', '2026-10-22'));
    assert.equal(listed.team, teamDir);
    const [built] = env.built;
    assert.equal(built.spec.dir, join(env.k.memory.projectDir(cwd).dir, 'sessions'),
      'the enhancement session lives in the memory folder');
    assert.equal(built.closed, true, 'closed after the run');
    const instance = join(teamDir, 'sessions', 'T1-executor.jsonl');
    assert.deepEqual(built.spec.scope, { sessions: [{ file: own, title: 'Question t1' }],
      instanceFiles: [{ file: instance, title: 'Question t1 · T1-executor.jsonl' }], feedback: [] },
    'the evidence scope: the listed sessions and the instance files in their team folders (§9.7)');
    // 增强会话自己的文件（工作目录相同、Oct 23 有对话）不在 pi 的会话列表里：Oct 23 没有可读的会话
    env.clock.fire();
    assert.equal((await ended(env, cwd, 'taste', '2026-10-23')).phase, 'skipped');
    assert.equal(env.built.length, 1);
  });

test('MEM-19 this project’s feedback of day D after feedbackSeen is listed once; feedbackSeen keeps it from repeating',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '06:00'));
    const cwd = env.project('shop');
    const file = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'), items: [
      ...turn('f1', '2026-10-22', '10:00'), ...turn('f2', '2026-10-23', '05:10'),
      ...turn('f3', '2026-10-23', '20:00')] });
    writeFeedback(env.userData, { name: 'fb-day.json', cwd, at: at('2026-10-22', '11:00'), sessionFile: file,
      entryId: 'f1a', expected: 'Lead with the answer', quote: 'Answer f1' });
    writeFeedback(env.userData, { name: 'fb-other.json', cwd: env.project('blog'), at: at('2026-10-22', '11:00') });
    writeFeedback(env.userData, { name: 'fb-before.json', cwd, at: at('2026-10-22', '03:00') });
    writeFeedback(env.userData, { name: 'fb-next.json', cwd, at: at('2026-10-23', '05:30'), sessionFile: file,
      entryId: 'f2a', expected: 'Shorter', quote: 'Answer f2' });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
    await env.startEnhance();
    await ended(env, cwd, 'taste', '2026-10-22');
    assert.deepEqual(listedFeedback(messageOf(env, 'taste', '2026-10-22')),
      [`- fb-day.json · hoped for: “Lead with the answer” · about: “Answer f1” in ${file} (entry f1a)`]);
    const day = readEnhance(env.k.memory, cwd).tasks.taste;
    assert.equal(day.feedbackSeen, new Date(at('2026-10-22', '11:00')).toISOString());
    assert.equal(day.last.revision !== null, true);
    const { revision } = await env.k.memory.revision(cwd, 'project', day.last.revision);
    assert.equal(revision.run.feedback, 1);
    // 今天到现在（Run now）读到 Oct 23 05:30 的反馈；Oct 23 结束后的那一次不再交给它
    assert.deepEqual(await env.k.enhance.runNow(cwd), { error: null });
    await ended(env, cwd, 'taste', '2026-10-23');
    assert.deepEqual(listedFeedback(messageOf(env, 'taste', '2026-10-23')).map((line) => line.split(' · ')[0]),
      ['- fb-next.json']);
    env.clock.set(at('2026-10-24', '04:00'));
    env.clock.fire();
    await ended(env, cwd, 'taste', '2026-10-23', 2);
    assert.deepEqual(listedFeedback(messageOf(env, 'taste', '2026-10-23', 2)), ['(none)']);
    assert.deepEqual(listedSessions(messageOf(env, 'taste', '2026-10-23', 2)).map((item) => item.start),
      ['after entry f2a'], 'the today run moved the watermark; the full day reads only what came after');
  });

test('MEM-19 nothing to read: skipped, no revision and no session; doneThrough advances unless D is today',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
    await env.startEnhance();
    await ended(env, cwd, 'taste', '2026-10-22');
    assert.deepEqual(env.events.filter((event) => event.type === 'mori.enhance_progress' && event.task === 'taste')
      .map((event) => event.phase), ['queued', 'running', 'skipped']);
    const file = readEnhance(env.k.memory, cwd).tasks.taste;
    assert.equal(file.doneThrough, '2026-10-22');
    assert.deepEqual({ ...file.last, at: undefined }, { day: '2026-10-22', at: undefined, status: 'skipped',
      error: null, revision: null, tokens: 0, counts: null });
    assert.deepEqual((await env.k.memory.revisions(cwd, 'project')).revisions, []);
    assert.equal(env.built.length, 0);
    assert.equal(env.events.some((event) => event.type === 'mori.memory_changed'), false);
    assert.deepEqual(await env.k.enhance.runNow(cwd), { error: null });
    await ended(env, cwd, 'taste', '2026-10-23');
    assert.equal(readEnhance(env.k.memory, cwd).tasks.taste.doneThrough, '2026-10-22', 'a today run that skips');
    assert.equal(readEnhance(env.k.memory, cwd).tasks.taste.last.day, '2026-10-23');
  });

test('MEM-17 turning enhancement off stops the run in progress: it fails with the reason and its change stays',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    const file = writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('k1', '2026-10-22', '10:00') });
    env.script = (spec) => ({ hang: true, act: () => env.k.memory.save(enhancer('taste', spec.run), { cwd,
      layer: 'project', kind: 'taste', abstract: 'Lead with the conclusion', detail: '',
      evidence: [{ at: '2026-10-22', session: file, entry: 'k1u', title: 'Question k1' }] }) });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
    await env.startEnhance();
    const id = await until(() => readEnhance(env.k.memory, cwd).tasks.taste.running, 'the running revision');
    await until(async () => (await env.k.memory.list(cwd, 'project', 'taste')).entries.length === 1, 'the write');
    assert.equal((await env.k.enhance.setEnhance(cwd, { enabled: false })).error, null);
    assert.equal((await ended(env, cwd, 'taste', '2026-10-22')).phase, 'failed');
    const [built] = env.built;
    assert.deepEqual([built.stopped, built.closed], [true, true]);
    const { revision } = await env.k.memory.revision(cwd, 'project', id);
    // 替身会话停下之前已经回复了 Done.：Notes 留着这条回复，原因在 last.error 与进度事件里（§9.8）
    assert.deepEqual([revision.status, revision.notes, revision.counts.added], ['failed', 'Done.', 1]);
    const task = readEnhance(env.k.memory, cwd).tasks.taste;
    assert.deepEqual([task.running, task.last.status, task.last.error, task.doneThrough, task.watermarks],
      [null, 'failed', 'Enhancement was turned off', '2026-10-21', {}]);
    assert.equal((await env.k.memory.list(cwd, 'project', 'taste')).entries.length, 1, 'the change stays');
    assert.deepEqual(readEnhance(env.k.memory, cwd).notice?.revisions, [id], 'a change was written: it is noticed');
    await settle();
    assert.equal(env.built.length, 1);
  });

test('MEM-31 the run ends on the first end event that finds the session and its Team idle, such as mori.team_state',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const cwd = env.project('shop');
    writeSession(env.agentDir, { id: 's1', cwd, at: at('2026-10-22', '09:00'),
      items: turn('w1', '2026-10-22', '10:00') });
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', team: true,
      tasks: ONLY_TASTE }));
    // 看不见的会话的替身（synthetic）：空闲与否、送来哪些事件都由测试决定；idle() 同真正的会话，是对话与 Team 都空闲
    const session = { idle: true, sent: false, closed: false, spec: null };
    hooks().startHeadless = async (spec) => {
      session.spec = spec;
      return { sessionId: 'synthetic-team', sessionFile: null, teamDir: join(env.userData, 'teams', 'synthetic-team'),
        blocked: () => null, idle: () => session.idle, started: () => session.sent,
        send: () => Object.assign(session, { sent: true, idle: false }),
        lastAssistant: () => ({ stopReason: 'stop', errorMessage: null }), hasAssistantAfterFirst: () => true,
        stop: async () => { session.idle = true; }, close: async () => { session.closed = true; } };
    };
    const send = (event) => session.spec.onEvent({ sessionId: 'synthetic-team', event });
    const teamState = (busy) => ({ type: 'mori.team_state', mode: 'on', holders: [], roles: [], busy,
      background: busy });
    const over = () => env.events.some((event) => event.type === 'mori.enhance_progress'
      && ['done', 'failed'].includes(event.phase));
    await env.startEnhance();
    await until(() => session.sent, 'the first message');
    // 对话这一轮结束了，Team 还有交付没做完（交付之间的空当 Team 也算忙）
    send({ type: 'agent_settled' });
    send(teamState(true));
    await settle();
    assert.equal(over(), false, 'the Team is busy: the run goes on');
    session.idle = true;
    send({ type: 'mori.board' });
    await settle();
    assert.equal(over(), false, 'only the end events re-check the end condition');
    send(teamState(false));
    assert.equal((await ended(env, cwd, 'taste', '2026-10-22')).phase, 'done', 'mori.team_state finds it idle');
    assert.equal(session.closed, true);
  });
