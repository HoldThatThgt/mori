// 增强调度（kernel/enhance.ts，docs/specs/memory.md §9.1–§9.4、§9.9、§12）：enhance.json 的开关与设置、每天的时刻与补跑、
// 只有一个的定时器、全应用串行的队列。时钟注入（harness 的 timerClock），一次运行（enhanceRun.ts 的 runTask）换成替身
// （synthetic）：测试决定每一次何时结束、结果是什么；被停止时按停止的原因失败（同真正的 runTask）。
// 记忆模块用真的（enhance.json 经它的写入队列写）。模型层换成替身（synthetic），只给打开增强时用的默认范围；
// 第一个候选的默认思考强度由 pi 的设置文件（测试写的 <agentDir>/settings.json，synthetic）决定。
// enhance.json 由测试按 §9.1 的形状手写（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  at, captureErrors, enhanceJson, hooks, loadBundle, monDayTime, readEnhance, scenario, settle, timerClock, until,
  writeEnhance,
} from './enhance-harness.mjs';

const MODULES = { enhance: 'src/kernel/enhance.ts', memory: 'src/kernel/memory.ts', shared: 'src/shared/memory.ts' };
const TASKS = ['taste', 'strategy', 'review'];

/** @brief 正常结束的结果（synthetic）：没有改动。 */
const done = () => ({ status: 'done', revision: 'synthetic-revision', counts: { added: 0, changed: 0, deleted: 0,
  moved: 0 }, tokens: 0, watermarks: {}, feedbackSeen: null });
/** @brief 失败的结果（synthetic）。 */
const failed = (error) => ({ status: 'failed', error, revision: null, counts: null, tokens: 0, keepRunning: false });

/**
 * @brief 一次运行的替身（synthetic）：每次调用记下参数，等测试 finish；被停止时以停止的原因失败。
 *        state.active 是同时在跑的次数，state.max 是它的最大值（§9.4：同一时刻只跑一个）。
 */
function syntheticRuns() {
  const calls = [];
  const state = { active: 0, max: 0 };
  hooks().runTask = (input) => new Promise((resolve) => {
    state.active += 1;
    state.max = Math.max(state.max, state.active);
    const call = { input, key: `${input.day} ${basename(input.cwd)} ${input.task}`, settled: false };
    call.finish = (outcome) => {
      if (call.settled) return;
      call.settled = true;
      state.active -= 1;
      resolve(outcome);
    };
    input.signal.addEventListener('abort', () => call.finish(failed(String(input.signal.reason))), { once: true });
    calls.push(call);
  });
  return { calls, state, open: () => calls.find((call) => !call.settled) };
}

/** @brief 模型层的替身（synthetic）：设置里的默认范围展开成两个候选；静态校验不在这里测，第一个候选取展开的第一个。 */
function syntheticModelLayer(normalDefault) {
  return {
    getConfig: () => ({ normalDefault }),
    projectContext: async (cwd) => ({ cwd }),
    expandPickIn: (_context, pick) => (pick === normalDefault ? ['fake/model-a', 'fake/model-b'] : null),
    staticBase: () => ({ configError: 'synthetic: the static check is not under test', projectError: null }),
  };
}

/**
 * @brief 一个场景：新的模块实例（= 一个新的后台进程）、临时 userData、注入的时钟、一次运行的替身、记下的全局事件。
 * @param t node:test 的测试上下文
 * @param start 起始时刻（ms）
 */
async function setup(t, start) {
  const s = scenario(t);
  const k = await loadBundle(MODULES, ['enhanceRun', 'sessions', 'modelLayer']);
  const events = [];
  const emit = (event) => events.push(event);
  k.memory.startMemory(s.userData, emit);
  const clock = timerClock(start);
  const runs = syntheticRuns();
  hooks().modelLayer = syntheticModelLayer('fast');
  const errors = captureErrors(t);
  s.stops.push(() => k.enhance.stopEnhance());
  const startEnhance = () => k.enhance.startEnhance({ userData: s.userData, emitGlobal: emit, clock });
  return { ...s, k, events, clock, runs, errors, startEnhance };
}

/**
 * @brief 依次结束接下来的 count 次运行：每次等下一次开始（确认同时只有一次在跑），按 outcomeOf 给结果。
 * @return 这几次的 key
 */
async function finishRuns(env, count, outcomeOf = () => done()) {
  const keys = [];
  for (let i = 0; i < count; i += 1) {
    const call = await until(() => env.runs.open(), `run ${i + 1} of ${count}`);
    assert.equal(env.runs.state.active, 1, 'one enhancement run at a time');
    keys.push(call.key);
    call.finish(outcomeOf(call));
  }
  await until(async () => !env.runs.open() && (await env.k.enhance.enhanceInfo(env.runs.calls.at(-1).input.cwd))
    .running === null, 'the last run to be recorded');
  return keys;
}

/** @brief 每一天每个任务的 key（顺序 TASTE、STRATEGY、REVIEW）。 */
const keysOf = (day, name, tasks = TASKS) => tasks.map((task) => `${day} ${name} ${task}`);

test('MEM-24 two projects due at once run one at a time, by day, then cwd, then TASTE→STRATEGY→REVIEW', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const a = env.project('a-shop');
  const b = env.project('b-shop');
  for (const cwd of [b, a]) {
    writeEnhance(env.k.memory, cwd, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-20' }));
  }
  await env.startEnhance();
  await until(() => env.runs.open(), 'the first run');
  const infoA = await env.k.enhance.enhanceInfo(a);
  const infoB = await env.k.enhance.enhanceInfo(b);
  assert.deepEqual([infoA.running, infoA.queued], [{ task: 'taste', day: '2026-10-21' }, 5]);
  assert.equal(env.k.shared.enhanceStatusText(infoA), 'Running TASTE enhancement… · 5 queued');
  assert.deepEqual([infoB.running, infoB.queued], [null, 6]);
  assert.equal(env.k.shared.enhanceStatusText(infoB), 'On · 6 queued · Waiting for another project’s enhancement');
  const keys = await finishRuns(env, 12);
  assert.deepEqual(keys, [...keysOf('2026-10-21', 'a-shop'), ...keysOf('2026-10-21', 'b-shop'),
    ...keysOf('2026-10-22', 'a-shop'), ...keysOf('2026-10-22', 'b-shop')]);
  assert.equal(env.runs.state.max, 1);
  await settle();
  assert.equal(env.runs.calls.length, 12, 'nothing else runs');
  const progress = env.events.filter((event) => event.type === 'mori.enhance_progress');
  for (const call of env.runs.calls) {
    const { cwd, task, day } = call.input;
    assert.deepEqual(progress.filter((event) => event.cwd === cwd && event.task === task && event.day === day)
      .map((event) => event.phase), ['queued', 'running', 'done'], call.key);
  }
  for (const cwd of [a, b]) {
    assert.deepEqual(TASKS.map((task) => readEnhance(env.k.memory, cwd).tasks[task].doneThrough),
      ['2026-10-22', '2026-10-22', '2026-10-22']);
  }
});

test('MEM-24 an item already queued or running is not queued again (Run now twice while it runs)', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const a = env.project('a-shop');
  writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-20' }));
  await env.startEnhance();
  await until(() => env.runs.open(), 'the first run');
  const queued = () => env.events.filter((event) => event.type === 'mori.enhance_progress'
    && event.phase === 'queued').length;
  assert.equal(queued(), 6);
  assert.deepEqual(await env.k.enhance.runNow(a), { error: null });
  assert.equal(queued(), 9, 'Run now adds only today’s three; the due days are already queued or running');
  assert.deepEqual(await env.k.enhance.runNow(a), { error: null });
  assert.equal(queued(), 9, 'the second Run now adds nothing');
  assert.equal((await env.k.enhance.enhanceInfo(a)).queued, 8);
  const keys = await finishRuns(env, 9);
  assert.deepEqual(keys, [...keysOf('2026-10-21', 'a-shop'), ...keysOf('2026-10-22', 'a-shop'),
    ...keysOf('2026-10-23', 'a-shop')]);
  assert.equal(new Set(keys).size, 9);
  assert.ok(env.runs.calls.slice(6).every((call) => call.input.today), 'today’s runs know D is today');
  await settle();
  assert.equal(env.runs.calls.length, 9);
  assert.deepEqual(TASKS.map((task) => readEnhance(env.k.memory, a).tasks[task].doneThrough),
    ['2026-10-22', '2026-10-22', '2026-10-22'], 'the today run does not move doneThrough');
});

test('MEM-18 at start every due day is caught up, from since on; today, off projects and no-model projects wait',
  async (t) => {
    const env = await setup(t, at('2026-10-24', '05:00'));
    const a = env.project('a-shop');
    writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-21', doneThrough: '2026-10-10' }));
    writeEnhance(env.k.memory, env.project('b-off'), enhanceJson({ enabled: false, since: '2026-10-21',
      doneThrough: '2026-10-10' }));
    writeEnhance(env.k.memory, env.project('c-nomodel'), enhanceJson({ pick: null, since: '2026-10-21',
      doneThrough: '2026-10-10' }));
    await env.startEnhance();
    const keys = await finishRuns(env, 9);
    assert.deepEqual(keys, [...keysOf('2026-10-21', 'a-shop'), ...keysOf('2026-10-22', 'a-shop'),
      ...keysOf('2026-10-23', 'a-shop')]);
    await settle();
    assert.equal(env.runs.calls.length, 9);
  });

test('MEM-18 a failed day stops that task’s later days this round; the next boundary retries them in order',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const a = env.project('a-shop');
    writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-20' }));
    await env.startEnhance();
    const outcome = (call) => (call.key === '2026-10-21 a-shop strategy' ? failed('synthetic: 404 Not Found') : done());
    const first = await finishRuns(env, 5, outcome);
    assert.deepEqual(first, ['2026-10-21 a-shop taste', '2026-10-21 a-shop strategy', '2026-10-21 a-shop review',
      '2026-10-22 a-shop taste', '2026-10-22 a-shop review']);
    await settle();
    assert.equal(env.runs.calls.length, 5, 'STRATEGY Oct 22 does not run this round');
    const file = readEnhance(env.k.memory, a);
    assert.deepEqual(TASKS.map((task) => file.tasks[task].doneThrough), ['2026-10-22', '2026-10-20', '2026-10-22']);
    assert.deepEqual([file.tasks.strategy.last.status, file.tasks.strategy.last.error],
      ['failed', 'synthetic: 404 Not Found']);
    assert.deepEqual(env.clock.pending(), [at('2026-10-24', '04:00')]);
    env.clock.fire();
    const second = await finishRuns(env, 5);
    assert.deepEqual(second, ['2026-10-21 a-shop strategy', '2026-10-22 a-shop strategy',
      ...keysOf('2026-10-23', 'a-shop')]);
    assert.deepEqual(TASKS.map((task) => readEnhance(env.k.memory, a).tasks[task].doneThrough),
      ['2026-10-23', '2026-10-23', '2026-10-23']);
  });

test('MEM-18 one timer at the earliest project boundary; firing queues that project and re-arms the next one',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const a = env.project('a-shop');
    const b = env.project('b-late');
    writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22' }));
    writeEnhance(env.k.memory, b, enhanceJson({ time: '23:00', since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    await settle();
    assert.equal(env.runs.calls.length, 0, 'nothing is due at start');
    assert.deepEqual(env.clock.pending(), [at('2026-10-23', '23:00')], 'one timer, at B’s 23:00');
    env.clock.fire();
    assert.deepEqual(await finishRuns(env, 3), keysOf('2026-10-22', 'b-late'), 'only the project whose time came');
    await until(() => env.clock.pending()[0] === at('2026-10-24', '04:00'), 'the timer re-armed at 04:00');
    assert.equal(env.clock.pending().length, 1);
    env.clock.fire();
    assert.deepEqual(await finishRuns(env, 3), keysOf('2026-10-23', 'a-shop'));
    await until(() => env.clock.pending()[0] === at('2026-10-24', '23:00'), 'the timer re-armed at 23:00');
    assert.equal(env.clock.pending().length, 1);
    await settle();
    assert.equal(env.runs.calls.length, 6);
  });

test('MEM-18 turning on the first project arms the next boundary and does not fire at once', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const a = env.project('a-shop');
  await env.startEnhance();
  assert.deepEqual(env.clock.pending(), [], 'no project is on: no timer');
  const result = await env.k.enhance.setEnhance(a, { enabled: true });
  assert.equal(result.error, null);
  assert.deepEqual(env.clock.pending(), [at('2026-10-24', '04:00')]);
  await settle();
  assert.equal(env.runs.calls.length, 0);
  assert.equal(env.k.shared.enhanceStatusText(result.info), `On · Next run ${monDayTime(at('2026-10-24', '04:00'))}`);
});

test('MEM-18 a boundary missed while asleep fires as soon as the timer is re-armed, without repeating a day',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const a = env.project('a-shop');
    writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22' }));
    await env.startEnhance();
    assert.deepEqual(env.clock.pending(), [at('2026-10-24', '04:00')]);
    env.clock.set(at('2026-10-25', '09:00'));
    // 醒来之后另一个项目打开增强，重设定时器：错过的 10-24 04:00 立即到点
    assert.equal((await env.k.enhance.setEnhance(env.project('b-new'), { enabled: true })).error, null);
    assert.deepEqual(env.clock.pending(), [at('2026-10-25', '09:00')], 'due at once, not a day later');
    env.clock.fire();
    const keys = await finishRuns(env, 6);
    assert.deepEqual(keys, [...keysOf('2026-10-23', 'a-shop'), ...keysOf('2026-10-24', 'a-shop')]);
    await until(() => env.clock.pending()[0] === at('2026-10-26', '04:00'), 'the next timer');
    assert.equal(env.clock.pending().length, 1);
    await settle();
    assert.equal(env.runs.calls.length, 6, 'no day runs twice; B (on since today) has nothing due');
  });

test('MEM-18 changing the time 04:00→23:00 at Oct 23 10:00 (spec example): Oct 22 runs at Oct 23 23:00', async (t) => {
  const env = await setup(t, at('2026-10-23', '10:00'));
  const a = env.project('a-shop');
  writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22' }));
  await env.startEnhance();
  assert.deepEqual(env.clock.pending(), [at('2026-10-24', '04:00')]);
  const result = await env.k.enhance.setEnhance(a, { time: '23:00' });
  assert.equal(result.error, null);
  const file = readEnhance(env.k.memory, a);
  assert.equal(file.time, '23:00');
  assert.equal(file.since, '2026-10-20');
  assert.deepEqual(TASKS.map((task) => file.tasks[task].doneThrough), ['2026-10-21', '2026-10-21', '2026-10-21'],
    'doneThrough goes back to the new today minus one');
  await settle();
  assert.equal(env.runs.calls.length, 0, 'Oct 22 (23:00) is not over at 10:00');
  assert.deepEqual(env.clock.pending(), [at('2026-10-23', '23:00')]);
  env.clock.fire();
  assert.deepEqual(await finishRuns(env, 3), keysOf('2026-10-22', 'a-shop'));
  assert.deepEqual(TASKS.map((task) => readEnhance(env.k.memory, a).tasks[task].doneThrough),
    ['2026-10-22', '2026-10-22', '2026-10-22']);
});

test('MEM-18 changing the time 23:00→04:00 queues the newly finished day at once', async (t) => {
  const env = await setup(t, at('2026-10-23', '10:00'));
  const a = env.project('a-shop');
  writeEnhance(env.k.memory, a, enhanceJson({ time: '23:00', since: '2026-10-20', doneThrough: '2026-10-21' }));
  await env.startEnhance();
  await settle();
  assert.equal(env.runs.calls.length, 0);
  assert.deepEqual(env.clock.pending(), [at('2026-10-23', '23:00')]);
  assert.equal((await env.k.enhance.setEnhance(a, { time: '04:00' })).error, null);
  assert.deepEqual(TASKS.map((task) => readEnhance(env.k.memory, a).tasks[task].doneThrough),
    ['2026-10-21', '2026-10-21', '2026-10-21']);
  assert.deepEqual(await finishRuns(env, 3), keysOf('2026-10-22', 'a-shop'));
  assert.deepEqual(env.clock.pending(), [at('2026-10-24', '04:00')]);
});

test('MEM-17 turning on stores the default range and its first candidate’s effort, 04:00, team off, since today',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '03:00'));
    writeFileSync(join(env.agentDir, 'settings.json'),
      JSON.stringify({ modelThinkingLevels: { 'fake/model-a': 'high' }, defaultThinkingLevel: 'low' }));
    const a = env.project('a-shop');
    await env.startEnhance();
    const before = await env.k.enhance.enhanceInfo(a);
    assert.deepEqual([before.enabled, before.error, before.since], [false, null, null]);
    assert.equal(env.k.shared.enhanceStatusText(before), env.k.shared.ENHANCE_OFF_TEXT);
    const result = await env.k.enhance.setEnhance(a, { enabled: true });
    assert.equal(result.error, null);
    const file = readEnhance(env.k.memory, a);
    assert.deepEqual({ enabled: file.enabled, pick: file.pick, thinking: file.thinking, team: file.team,
      time: file.time, since: file.since }, { enabled: true, pick: 'fast', thinking: 'high', team: false,
      time: '04:00', since: '2026-10-22' }, '03:00 still belongs to Oct 22');
    for (const task of TASKS) {
      assert.deepEqual(file.tasks[task], { doneThrough: '2026-10-21', watermarks: {}, feedbackSeen: null,
        running: null, last: null });
    }
    assert.equal(file.notice, null);
    assert.deepEqual(JSON.parse(readFileSync(join(env.k.memory.projectDir(a).dir, 'project.json'), 'utf8')),
      { cwd: a });
    assert.deepEqual([result.info.enabled, result.info.pick, result.info.thinking, result.info.next],
      [true, 'fast', 'high', at('2026-10-23', '04:00')]);
  });

test('MEM-17 without a per-model effort the default effort is used; the dialog’s four settings are saved',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    writeFileSync(join(env.agentDir, 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'low' }));
    const a = env.project('a-shop');
    const b = env.project('b-shop');
    await env.startEnhance();
    assert.equal((await env.k.enhance.setEnhance(a, { enabled: true })).error, null);
    assert.equal(readEnhance(env.k.memory, a).thinking, 'low');
    const dialog = { pick: 'fake/other', thinking: 'xhigh', team: true, time: '05:30' };
    const saved = await env.k.enhance.setEnhance(b, dialog);
    assert.equal(saved.error, null);
    const file = readEnhance(env.k.memory, b);
    assert.deepEqual({ enabled: file.enabled, pick: file.pick, thinking: file.thinking, team: file.team,
      time: file.time }, { enabled: false, ...dialog }, 'saving the dialog does not turn enhancement on');
    assert.deepEqual([saved.info.pick, saved.info.thinking, saved.info.team, saved.info.time],
      ['fake/other', 'xhigh', true, '05:30']);
    hooks().modelLayer = { getConfig: () => { throw new Error('synthetic: the defaults are not needed'); } };
    assert.equal((await env.k.enhance.setEnhance(b, { enabled: true })).error, null);
    const on = readEnhance(env.k.memory, b);
    assert.deepEqual([on.pick, on.thinking, on.team, on.time, on.since],
      ['fake/other', 'xhigh', true, '05:30', '2026-10-22'], 'saved settings are kept; 05:00 is before 05:30');
  });

test('MEM-17 turning off and on again keeps the settings and watermarks; since is the new day; off days are skipped',
  async (t) => {
    const env = await setup(t, at('2026-10-18', '06:00'));
    const a = env.project('a-shop');
    writeEnhance(env.k.memory, a, enhanceJson({ pick: 'fake/p', thinking: 'xhigh', team: true, time: '05:30',
      since: '2026-10-15', doneThrough: '2026-10-17', watermarks: { 'C:\\s\\x.jsonl': 'w1' },
      feedbackSeen: '2026-10-17T01:00:00.000Z' }));
    hooks().modelLayer = { getConfig: () => { throw new Error('synthetic: the defaults are not needed'); } };
    await env.startEnhance();
    assert.equal((await env.k.enhance.setEnhance(a, { enabled: false })).error, null);
    assert.equal(readEnhance(env.k.memory, a).enabled, false);
    assert.deepEqual(env.clock.pending(), [], 'no project is on');
    env.clock.set(at('2026-10-22', '08:00'));
    const result = await env.k.enhance.setEnhance(a, { enabled: true });
    assert.equal(result.error, null);
    const file = readEnhance(env.k.memory, a);
    assert.deepEqual([file.enabled, file.pick, file.thinking, file.team, file.time, file.since],
      [true, 'fake/p', 'xhigh', true, '05:30', '2026-10-22']);
    for (const task of TASKS) {
      assert.equal(file.tasks[task].doneThrough, '2026-10-21', 'the off days are not caught up');
      assert.deepEqual(file.tasks[task].watermarks, { 'C:\\s\\x.jsonl': 'w1' });
      assert.equal(file.tasks[task].feedbackSeen, '2026-10-17T01:00:00.000Z');
    }
    await settle();
    assert.equal(env.runs.calls.length, 0);
    assert.deepEqual(env.clock.pending(), [at('2026-10-23', '05:30')]);
  });

test('MEM-17 turning off drops the project’s queued items and stops its run as failed: Enhancement was turned off',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const a = env.project('a-shop');
    const b = env.project('b-shop');
    writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-20' }));
    writeEnhance(env.k.memory, b, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    const first = await until(() => env.runs.open(), 'the first run');
    assert.equal(first.key, '2026-10-21 a-shop taste');
    assert.equal((await env.k.enhance.setEnhance(a, { enabled: false })).error, null);
    assert.equal(first.input.signal.reason, 'Enhancement was turned off');
    const info = await until(async () => {
      const value = await env.k.enhance.enhanceInfo(a);
      return value.last.taste && value.running === null ? value : null;
    }, 'the stopped run to be recorded');
    assert.deepEqual([info.queued, info.running, info.last.taste.status, info.last.taste.error],
      [0, null, 'failed', 'Enhancement was turned off']);
    assert.ok(env.events.some((event) => event.type === 'mori.enhance_progress' && event.cwd === a
      && event.phase === 'failed' && event.error === 'Enhancement was turned off'));
    assert.deepEqual(await finishRuns(env, 3), keysOf('2026-10-22', 'b-shop'), 'the other project goes on');
    await settle();
    assert.equal(env.runs.calls.filter((call) => call.input.cwd === a).length, 1);
  });

test('MEM-17 with no default range the switch turns on but nothing runs; Run now says to choose a model', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  hooks().modelLayer = syntheticModelLayer(null);
  const a = env.project('a-shop');
  await env.startEnhance();
  const result = await env.k.enhance.setEnhance(a, { enabled: true });
  assert.deepEqual([result.error, result.info.enabled, result.info.pick], [null, true, null]);
  assert.equal(env.k.shared.enhanceStatusText(result.info), 'On · Choose a model in enhancement settings');
  assert.deepEqual(await env.k.enhance.runNow(a), { error: 'Choose a model in enhancement settings' });
  env.clock.fire();
  await until(() => env.clock.pending()[0] === at('2026-10-25', '04:00'), 'the next timer');
  await settle();
  assert.equal(env.runs.calls.length, 0, 'it never runs without a model');
});

test('MEM-17 an unreadable enhance.json counts as off: enhance.get has the error; set, run and notice touch nothing',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const a = env.project('a-broken');
    const b = env.project('b-badtime');
    const c = env.project('c-shop');
    const brokenText = '{ "enabled": true, ';
    const fileA = writeEnhance(env.k.memory, a, brokenText);
    const badTime = { ...enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-20' }), time: '25:00' };
    writeEnhance(env.k.memory, b, badTime);
    writeEnhance(env.k.memory, c, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    assert.deepEqual(await finishRuns(env, 3), keysOf('2026-10-22', 'c-shop'), 'only the readable project runs');
    const infoA = await env.k.enhance.enhanceInfo(a);
    assert.equal(infoA.enabled, false);
    assert.ok(infoA.error, 'enhance.get carries the reason');
    assert.equal(env.k.shared.enhanceStatusText(infoA), `Couldn’t read the enhancement settings: ${infoA.error}`);
    const infoB = await env.k.enhance.enhanceInfo(b);
    assert.match(infoB.error, /time/);
    assert.equal(infoB.enabled, false);
    const set = await env.k.enhance.setEnhance(a, { enabled: true, pick: 'fake/model', thinking: 'low' });
    assert.equal(set.error, infoA.error);
    assert.equal((await env.k.enhance.setEnhance(a, { team: true })).error, infoA.error);
    assert.deepEqual(await env.k.enhance.runNow(a), { error: infoA.error });
    assert.equal(await env.k.enhance.takeNotice(a), null);
    assert.equal(readFileSync(fileA, 'utf8'), brokenText, 'the file is not rewritten');
    assert.ok(env.errors.some((line) => line.includes('enhance.json') && line.includes(a)), 'the error is logged');
    await settle();
    assert.equal(env.runs.calls.length, 3);
  });

test('MEM-24 two projects reaching 04:00 together: one timer fires, then one run at a time in cwd order', async (t) => {
  const env = await setup(t, at('2026-10-23', '05:00'));
  const a = env.project('a-shop');
  const b = env.project('b-shop');
  writeEnhance(env.k.memory, b, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22' }));
  writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22' }));
  await env.startEnhance();
  assert.deepEqual(env.clock.pending(), [at('2026-10-24', '04:00')], 'one timer for both projects');
  env.clock.fire();
  const first = await until(() => env.runs.open(), 'the first run');
  assert.equal(env.k.shared.enhanceStatusText(await env.k.enhance.enhanceInfo(b)),
    'On · 3 queued · Waiting for another project’s enhancement');
  assert.equal(first.key, '2026-10-23 a-shop taste');
  assert.deepEqual(await finishRuns(env, 6), [...keysOf('2026-10-23', 'a-shop'), ...keysOf('2026-10-23', 'b-shop')]);
  assert.equal(env.runs.state.max, 1);
});

test('MEM-26 changes from two runs on different days add up in the notice; a new session takes and clears it',
  async (t) => {
    const env = await setup(t, at('2026-10-24', '05:00'));
    const a = env.project('a-shop');
    writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21',
      tasks: { review: { doneThrough: '2026-12-31' } } }));
    await env.startEnhance();
    const changed = (revision, counts) => ({ ...done(), revision, counts: { added: 0, changed: 0, deleted: 0,
      moved: 0, ...counts } });
    const outcomes = { '2026-10-22 a-shop taste': changed('r-taste-22', { added: 1 }),
      '2026-10-23 a-shop strategy': changed('r-strategy-23', { changed: 1, deleted: 1, moved: 1 }) };
    await finishRuns(env, 4, (call) => outcomes[call.key] ?? done());
    assert.deepEqual(readEnhance(env.k.memory, a).notice, { revisions: ['r-taste-22', 'r-strategy-23'],
      counts: { taste: 1, strategy: 2, review: 0 }, from: '2026-10-22', to: '2026-10-23' },
    'moved is not counted; days are a range; runs without changes add nothing');
    assert.deepEqual((await env.k.enhance.takeNotice(a)).revisions, ['r-taste-22', 'r-strategy-23']);
    assert.equal(readEnhance(env.k.memory, a).notice, null);
    assert.equal(await env.k.enhance.takeNotice(a), null, 'the second new session gets no notice');
  });

test('MEM-06 a project folder claimed by another cwd: enhance.get, set, run and the notice refuse and write nothing',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const owner = env.project('a-b');
    const other = join(env.root, 'work', 'a', 'b');
    assert.equal(env.k.memory.projectDir(owner).dir, env.k.memory.projectDir(other).dir, 'the same encoded folder');
    const notice = { revisions: ['r1'], counts: { taste: 1, strategy: 0, review: 0 }, from: '2026-10-22',
      to: '2026-10-22' };
    const file = writeEnhance(env.k.memory, owner, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22',
      notice }));
    const text = readFileSync(file, 'utf8');
    await env.startEnhance();
    const reason = `This project’s memory folder belongs to ${owner}.`;
    const info = await env.k.enhance.enhanceInfo(other);
    assert.deepEqual([info.error, info.enabled, info.notice], [reason, false, null]);
    assert.equal((await env.k.enhance.setEnhance(other, { enabled: true, pick: 'fake/m', thinking: 'low' })).error,
      reason);
    assert.deepEqual(await env.k.enhance.runNow(other), { error: reason });
    assert.equal(await env.k.enhance.takeNotice(other), null);
    assert.equal(readFileSync(file, 'utf8'), text, 'the owner’s enhance.json and notice are untouched');
    assert.deepEqual((await env.k.enhance.enhanceInfo(owner)).notice, notice);
  });

test('MEM-25 a Run now still running when its day ends: that day is queued again and runs in full right after it',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '03:55'));
    const a = env.project('a-shop');
    writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21' }));
    await env.startEnhance();
    await settle();
    assert.equal(env.runs.calls.length, 0, 'Oct 22 is not over at 03:55');
    assert.deepEqual(await env.k.enhance.runNow(a), { error: null });
    const first = await until(() => env.runs.open(), 'the today run');
    assert.deepEqual([first.key, first.input.today], ['2026-10-22 a-shop taste', true]);
    // 04:00 到点：Oct 22 结束了，但 TASTE Oct 22 与正在跑的这一次是同一项，到点时没有排上
    env.clock.fire();
    await until(() => env.clock.pending()[0] === at('2026-10-24', '04:00'), 'the boundary to be handled');
    first.finish(done());
    assert.deepEqual(await finishRuns(env, 3), keysOf('2026-10-22', 'a-shop'),
      'TASTE Oct 22 runs again at once; STRATEGY and REVIEW Oct 22 run once');
    assert.deepEqual(env.runs.calls.slice(1).map((call) => call.input.today), [false, false, false],
      'all three read the whole day; the today run’s watermarks leave only what is new');
    await settle();
    assert.equal(env.runs.calls.length, 4, 'nothing else runs');
    assert.deepEqual(TASKS.map((task) => readEnhance(env.k.memory, a).tasks[task].doneThrough),
      ['2026-10-22', '2026-10-22', '2026-10-22']);
  });

/**
 * @brief 带完整模型配置的模型层替身（synthetic）：提供商 fake（think 标了 Supports thinking、plain 没标）与 other
 *        （deep 标了）；分组 fast（plain、think）、slow（plain）、empty（没有成员）。静态校验只放过 fake/think
 *        （其余 tool calling 未验证）；在 narrowedIn 这个项目里，项目配置把 fast 缩小成 fake/plain。
 *        档案（2026-10-24，model-providers.md §7.7，enhance.get 的 noOffPicks）：fake/think 的思考关不掉
 *        （reasoning.off_refused 为真），other/deep 能关，fake/plain 没有档案。
 * @param narrowedIn 项目配置缩小了 fast 的项目
 */
function thinkingModelLayer(narrowedIn) {
  const config = {
    normalDefault: 'fast',
    groups: [{ id: 'fast', members: ['fake/plain', 'fake/think'] }, { id: 'slow', members: ['fake/plain'] },
      { id: 'empty', members: [] }],
    providers: [
      { id: 'fake', name: 'Fake', models: [{ id: 'think', reasoning: true }, { id: 'plain', reasoning: false }] },
      { id: 'other', name: 'Other', models: [{ id: 'deep', reasoning: true }] },
    ],
  };
  const refsOf = (member) => (member.includes('/') ? [member]
    : config.providers.find((provider) => provider.id === member)?.models.map((model) => `${member}/${model.id}`));
  return {
    getConfig: () => config,
    projectContext: async (cwd) => ({ narrowed: cwd === narrowedIn }),
    expandPickIn: (context, pick) => {
      if (context.narrowed && pick === 'fast') return ['fake/plain'];
      const group = config.groups.find((item) => item.id === pick);
      return group ? group.members.flatMap(refsOf) : refsOf(pick) ?? null;
    },
    staticBase: () => ({ configError: null, projectError: null,
      exists: () => true, capabilities: () => ({}), familyOf: () => '',
      toolCalling: (ref) => (ref === 'fake/think' ? 'verified' : 'unverified') }),
    profileOf: (ref) => {
      if (ref === 'fake/plain') return null;
      const offRefused = ref === 'fake/think';
      return { status: 'ready', reasoning: { field: 'reasoning_content', can_disable: !offRefused,
        replay: 'not_required', off_refused: offRefused } };
    },
  };
}

/** @brief promise 在 ms 毫秒内兑现，否则失败（说明在等什么）。 */
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test('MEM-17 effortPicks: per model range, whether its first candidate after the static check supports thinking',
  async (t) => {
    const env = await setup(t, at('2026-10-23', '05:00'));
    const a = env.project('a-shop');
    const b = env.project('b-narrow');
    hooks().modelLayer = thinkingModelLayer(b);
    await env.startEnhance();
    // 写入队列被占着时 enhance.get 照样回答（effortPicks 不在写入队列里算）
    let release;
    const held = env.k.memory.enqueue(() => new Promise((done) => { release = done; }));
    const info = await within(env.k.enhance.enhanceInfo(a), 5000, 'enhance.get while the write queue is held');
    release();
    await held;
    assert.deepEqual(info.effortPicks, { fast: true, slow: false, fake: true, other: true, 'fake/think': true,
      'fake/plain': false, 'other/deep': true },
    'fast skips plain in the static check; slow, other and fake/plain fall back to the first expanded candidate; '
      + 'empty has no candidate and is left out');
    // 2026-10-24（model-providers.md §7.7）：noOffPicks 按同一个第一个候选的档案；other 的 deep 能关，plain 没有档案
    assert.deepEqual(info.noOffPicks, ['fast', 'fake', 'fake/think'],
      'fast and fake start with think, whose thinking cannot be turned off');
    const narrowed = await env.k.enhance.enhanceInfo(b);
    assert.equal(narrowed.effortPicks.fast, false, 'in the project’s own context');
    assert.deepEqual(narrowed.noOffPicks, ['fake', 'fake/think'], 'fast starts with plain in the narrowed project');
    const set = await env.k.enhance.setEnhance(a, { team: true });
    assert.deepEqual([set.info.effortPicks, set.info.noOffPicks], [info.effortPicks, info.noOffPicks]);
    // 模型层还在启动（synthetic：还没有模型层）：enhance.get 不等它，没有 effortPicks，也没有 noOffPicks
    hooks().modelLayer = null;
    const starting = await within(env.k.enhance.enhanceInfo(a), 5000, 'enhance.get while the model layer starts');
    assert.deepEqual([starting.effortPicks, starting.noOffPicks, starting.error], [{}, [], null]);
  });

test('MEM-25 when a run’s final progress arrives, enhance.get no longer reports that run as running', async (t) => {
  const env = await setup(t, at('2026-10-23', '10:00'));
  const a = env.project('a-shop');
  writeEnhance(env.k.memory, a, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-22' }));
  // 界面收到结束的进度就读 enhance.get（§10.4）：同样在收到事件的那一刻读
  const reads = [];
  const emit = (event) => {
    env.events.push(event);
    if (event.type === 'mori.enhance_progress' && ['done', 'skipped', 'failed'].includes(event.phase)) {
      reads.push(env.k.enhance.enhanceInfo(event.cwd).then((info) => ({ event, info })));
    }
  };
  await env.k.enhance.startEnhance({ userData: env.userData, emitGlobal: emit, clock: env.clock });
  assert.deepEqual(await env.k.enhance.runNow(a), { error: null });
  await finishRuns(env, 3);
  const seen = await Promise.all(reads);
  assert.equal(seen.length, 3, 'three final progress events');
  for (const { event, info } of seen) {
    assert.ok(!(info.running?.task === event.task && info.running?.day === event.day),
      `${event.task} is not reported as running after its ${event.phase} event`);
  }
  assert.equal(seen.at(-1).info.running, null, 'nothing runs after the last one');
});
