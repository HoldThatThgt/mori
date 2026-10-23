// 增强单元测试（enhance-*.test.mjs）共用的工具（docs/specs/memory.md §14.1）：
// - 把要测的内核模块打成一个包（同一份模块状态：增强调度、它用的记忆模块与写入队列），会话表（sessions.ts）、模型层
//   （modelLayer.ts）与需要时的一次运行（enhanceRun.ts）换成替身（synthetic）。替身的行为由测试经
//   globalThis.__moriSynthetic 给出；node --test 里起不了真正的会话表与模型层，所以看不见的会话也是替身；
// - 每次打包都是新的模块实例：同一个测试文件里再打包一次，就是“后台进程重新启动”（§9.10）；
// - 会话文件、反馈、enhance.json、project.json 由测试按规格 §3、§9.1 与 pi 会话文件的格式手写（synthetic）；
// - 增强调度的时钟（now、setTimeout、clearTimeout）用 load.mjs 的 fakeClock 加上记下的定时器（§9.3）。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeClock } from '../load.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const kernelDir = join(appRoot, 'src', 'kernel');
const outDir = join(appRoot, 'test-results', 'unit-bundles');

/** 替身的源码（synthetic）：每个导出都转给 globalThis.__moriSynthetic 里测试给的函数。 */
const STUB_SOURCES = {
  sessions: `// synthetic：kernel/sessions.ts 的替身（看不见的会话、是否在生成、AGENTS.md 的会话上下文由测试给出）
const hooks = () => globalThis.__moriSynthetic ?? {};
export function startHeadless(spec) {
  if (!hooks().startHeadless) throw new Error('synthetic: this test has no headless session');
  return hooks().startHeadless(spec);
}
export function sessionGenerating(file) { return hooks().sessionGenerating?.(file) ?? false; }
export function sessionContext(id) {
  if (!hooks().sessionContext) throw new Error('synthetic: this test has no session context');
  return hooks().sessionContext(id);
}
`,
  enhanceRun: `// synthetic：kernel/enhanceRun.ts 的替身（一次运行由测试决定何时结束、结果是什么）
export function runTask(input) { return globalThis.__moriSynthetic.runTask(input); }
`,
  modelLayer: `// synthetic：kernel/modelLayer.ts 的替身（增强打开时读的默认范围、enhance.get 的 effortPicks）
export async function getModelLayer() {
  const layer = globalThis.__moriSynthetic?.modelLayer;
  if (!layer) throw new Error('synthetic: this test has no model layer');
  return layer;
}
export function currentModelLayer() {
  return globalThis.__moriSynthetic?.modelLayer ?? null;
}
`,
};

/** 打包次数（同一进程里每个包一个文件名） */
let bundles = 0;

/** @brief esbuild 插件：内核里 `./<name>` 的引用换成替身（只换 stubs 里列出的）。 */
function stubPlugin(stubs) {
  const kernel = kernelDir.toLowerCase();
  return {
    name: 'mori-synthetic-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(sessions|enhanceRun|modelLayer)$/ }, (args) => {
        const name = args.path.slice(2);
        if (!stubs.includes(name) || resolve(args.resolveDir).toLowerCase() !== kernel) return undefined;
        return { path: name, namespace: 'mori-synthetic' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'mori-synthetic' }, (args) => ({
        contents: STUB_SOURCES[args.path], loader: 'js', resolveDir: kernelDir,
      }));
    },
  };
}

/**
 * @brief 把几个内核模块打成一个包并导入（共用一份模块状态），stubs 里的模块换成替身。
 * @param modules { 名字: 相对 app/ 的源文件 }，例如 { enhance: 'src/kernel/enhance.ts' }
 * @param stubs 换成替身的模块名：'sessions'、'enhanceRun'、'modelLayer'
 * @return { 名字: 模块的导出 }
 */
export async function loadBundle(modules, stubs) {
  mkdirSync(outDir, { recursive: true });
  bundles += 1;
  const outfile = join(outDir, `enhance-bundle.${process.pid}.${bundles}.mjs`);
  const contents = Object.entries(modules)
    .map(([name, path]) => `export * as ${name} from ${JSON.stringify(`./${path}`)};`).join('\n');
  await build({
    stdin: { contents, resolveDir: appRoot, sourcefile: 'enhance-entry.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', outfile,
    logLevel: 'silent', plugins: [stubPlugin(stubs)],
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
}

/** @brief 替身的行为（测试改它的字段）。每个场景开始时清空。 */
export function hooks() {
  globalThis.__moriSynthetic ??= {};
  return globalThis.__moriSynthetic;
}

// ---- 场景：临时 userData、pi 的 agentDir、项目文件夹 ----

/**
 * @brief 一个场景的临时目录：`<root>/userData`（Mori 的数据目录）、`<root>/userData/pi`（pi 的 agentDir，同安装版的布局）、
 *        项目文件夹 `<root>/work/<名字>`。设好 pi 的环境变量（离线、agentDir），清空替身的行为；测试结束后先运行 stops
 *        里的收尾（停下增强调度：之后不再往目录里写），再删掉目录。
 * @param t node:test 的测试上下文
 */
export function scenario(t) {
  const root = mkdtempSync(join(tmpdir(), 'mori-enh-'));
  const userData = join(root, 'userData');
  const agentDir = join(userData, 'pi');
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_OFFLINE = '1';
  process.env.PI_TELEMETRY = '0';
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__moriSynthetic = {};
  const stops = [];
  t.after(async () => {
    for (const stop of stops) {
      try {
        await stop();
      } catch (error) {
        console.error(`synthetic cleanup failed: ${error.message}`);
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const project = (name) => {
    const cwd = join(root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  };
  return { root, userData, agentDir, project, stops };
}

// ---- 时间 ----

/** @brief 本地时间的时刻（ms）：day 为 'YYYY-MM-DD'，time 为 'HH:MM'。 */
export function at(day, time = '00:00') {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/** @brief ISO 字符串（UTC，同 pi 与反馈文件的写法）。 */
export const iso = (ms) => new Date(ms).toISOString();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** @brief 本地 `Oct 23 04:00`（规格 §10.4 的 `<Mon D> <hh:mm>`，独立算出）。 */
export function monDayTime(ms) {
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * @brief 增强调度的时钟（§9.3）：load.mjs 的 fakeClock 加上 setTimeout、clearTimeout，记下还在的定时器；
 *        fire() 把时钟拨到最早的定时器并运行它（模拟到点）。
 * @param start 起始时刻（ms）
 */
export function timerClock(start) {
  const base = fakeClock(start);
  const timers = new Map();
  let next = 0;
  return {
    now: base.now,
    set: base.set,
    setTimeout(callback, ms) {
      next += 1;
      timers.set(next, { callback, at: base.now() + ms });
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    /** 还在的定时器的到点时刻，从早到晚 */
    pending: () => [...timers.values()].map((timer) => timer.at).sort((a, b) => a - b),
    /** 到点：时钟拨到最早的定时器（不往回拨），运行它 */
    fire() {
      const [handle, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (!timer) throw new Error('no timer is set');
      timers.delete(handle);
      if (timer.at > base.now()) base.set(timer.at);
      timer.callback();
    },
  };
}

/**
 * @brief 等条件成立（增强调度的队列与写入是异步的）；超时失败。整套单元测试并行跑时第一次载入 pi 与打包可能要十几秒，
 *        所以超时放宽到一分钟（只在出错时才等满）。
 * @param predicate 条件
 * @param what 失败时说明在等什么
 * @param timeout 最多等多少毫秒
 */
export async function until(predicate, what, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

/** @brief 让排着的异步工作跑一会儿（用来确认某件事没有发生）。 */
export const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));

/**
 * @brief 这个测试里内核记的错误日志（console.error）收进一个数组、不打印；测试结束（含场景收尾）后换回原来的。
 * @param t node:test 的测试上下文
 * @return 收到的每一行
 */
export function captureErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  t.after(() => {
    console.error = original;
  });
  return lines;
}

// ---- 文件（synthetic） ----

/** @brief pi 的会话目录名（session-manager.js:290-295 的编码；listAll 扫全部子目录，名字只是照 pi 写）。 */
export function piSessionDir(agentDir, cwd) {
  const key = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(agentDir, 'sessions', key);
}

/**
 * @brief 一条 pi 消息条目（synthetic）：user 或 assistant；assistant 带 usage。
 * @param item { id, at（ms）, role, text, usage? }
 * @param parentId 上一条的 id
 */
function messageEntry(item, parentId) {
  const message = item.role === 'assistant'
    ? { role: 'assistant', content: [{ type: 'text', text: item.text }], api: 'openai-completions',
      provider: 'fake', model: 'fake-model', stopReason: 'stop', timestamp: item.at,
      usage: { input: item.usage?.input ?? 10, output: item.usage?.output ?? 5, cacheRead: 0, cacheWrite: 0,
        totalTokens: (item.usage?.input ?? 10) + (item.usage?.output ?? 5),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    : { role: 'user', content: [{ type: 'text', text: item.text }], timestamp: item.at };
  return { type: 'message', id: item.id, parentId, timestamp: iso(item.at), message };
}

/**
 * @brief 把会话条目写成 pi 会话文件的行（synthetic）：第 1 行是头；items 的每项是一行：
 *        { id, at, role, text } 为消息；{ id, at, custom } 为 Mori 的自定义条目（例如 mori.pick）；字符串原样写（坏的行、空行）。
 * @return 每一行的原文
 */
export function sessionLines(header, items) {
  const lines = [JSON.stringify({ type: 'session', version: 3, id: header.id, timestamp: iso(header.at),
    cwd: header.cwd })];
  let parent = null;
  for (const item of items) {
    if (typeof item === 'string') {
      lines.push(item);
      continue;
    }
    const entry = item.custom
      ? { type: 'custom', customType: item.custom, data: { pick: 'fake/model' }, id: item.id, parentId: parent,
        timestamp: iso(item.at) }
      : messageEntry(item, parent);
    lines.push(JSON.stringify(entry));
    parent = item.id;
  }
  return lines;
}

/**
 * @brief 写一个用户会话文件到 `<agentDir>/sessions/--<cwd>--/`（synthetic），pi 的 listAll 能列出它。
 * @param agentDir pi 的 agentDir
 * @param session { id, cwd, at（建会话的时刻）, items }
 * @return 文件的绝对路径
 */
export function writeSession(agentDir, session) {
  const dir = piSessionDir(agentDir, session.cwd);
  mkdirSync(dir, { recursive: true });
  const stamp = iso(session.at).replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}_${session.id}.jsonl`);
  const lines = sessionLines({ id: session.id, at: session.at, cwd: session.cwd }, session.items);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * @brief 写一份反馈 `<userData>/feedback/<name>`（synthetic，StoredFeedbackSchema 的形状）。
 * @param userData Mori 的数据目录
 * @param item { name, cwd, at（ms）, expected?, quote?, sessionFile?, entryId? }
 */
export function writeFeedback(userData, item) {
  const dir = join(userData, 'feedback');
  mkdirSync(dir, { recursive: true });
  const sessionFile = item.sessionFile === undefined ? null : item.sessionFile;
  const feedback = {
    expected: item.expected ?? 'Say it shorter',
    quote: item.quote ?? 'A long reply',
    source: { kind: 'message', sessionFile, entryId: item.entryId ?? null, time: null, scope: 'reply' },
    session: { file: sessionFile, cwd: item.cwd, title: item.title ?? 'Synthetic session' },
    createdAt: iso(item.at),
  };
  writeFileSync(join(dir, item.name), `${JSON.stringify(feedback, null, 2)}\n`);
}

/**
 * @brief enhance.json 的内容（synthetic，§9.1 的形状）：三个任务同样的 doneThrough、watermarks、feedbackSeen。
 * @param options 设置与任务状态；tasks 可以按任务覆盖
 */
export function enhanceJson(options) {
  const task = (name) => ({ doneThrough: options.doneThrough ?? null, watermarks: options.watermarks ?? {},
    feedbackSeen: options.feedbackSeen ?? null, running: null, last: null, ...(options.tasks?.[name] ?? {}) });
  return { enabled: options.enabled ?? true, pick: options.pick === undefined ? 'fake/model' : options.pick,
    thinking: options.thinking ?? 'medium', team: options.team ?? false, time: options.time ?? '04:00',
    since: options.since ?? null, tasks: { taste: task('taste'), strategy: task('strategy'), review: task('review') },
    notice: options.notice ?? null };
}

/**
 * @brief 写一个项目的 project.json 与 enhance.json（synthetic）：项目目录按记忆模块的 projectDir 定。
 * @param memory 包里的记忆模块（已 startMemory）
 * @param cwd 项目的工作目录
 * @param content enhance.json 的内容（对象原样写成 JSON；字符串原样写）
 * @return enhance.json 的路径
 */
export function writeEnhance(memory, cwd, content) {
  const { dir } = memory.projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`);
  const file = join(dir, 'enhance.json');
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return file;
}

/** @brief 读一个项目的 enhance.json。 */
export function readEnhance(memory, cwd) {
  return JSON.parse(readFileSync(join(memory.projectDir(cwd).dir, 'enhance.json'), 'utf8'));
}

// ---- 看不见的会话的替身（synthetic，§9.6） ----

/**
 * @brief 一行实例会话或增强会话的助手消息（synthetic，带 usage）。
 * @param id 条目 id
 * @param ms 时刻
 * @param usage { input, output }
 * @param role assistant 或 toolResult
 */
export function usageLine(id, ms, usage, role = 'assistant') {
  const message = { role, content: [{ type: 'text', text: `${role} ${id}` }], timestamp: ms,
    usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0 } };
  return JSON.stringify({ type: 'message', id, parentId: null, timestamp: iso(ms), message });
}

/**
 * @brief 看不见的会话的替身（synthetic）：hooks().startHeadless 每次建一个。发出第一条消息后按 script 做：
 *        act(spec, record) 写记忆（测试经包里的记忆模块、带 spec.run 写）；写增强会话文件（头、第一条消息、回复带 usage）；
 *        写 TaskBoard 目录 sessions/ 下的实例会话文件；然后会话空闲并发 agent_settled，或 fail 时发 mori.prompt_error，
 *        hang 时一直不结束（只有停止能让它结束），有 release（Promise）时等它兑现再结束。
 * @param options { userData, now }：Mori 的数据目录与时钟
 * @param scriptFor (spec) => script：{ act?, reply?（null 为没有回复）, usage?, fail?, hang?, release?, instances?,
 *        startError?, blocked?, event?（结束时发的事件，代替 agent_settled）, lastAssistant?（最后一条助手消息的
 *        stopReason 与 errorMessage） }
 * @return 建过的会话的记录：{ spec, message, stopped, closed, sessionFile, teamDir }，按建立的先后
 */
export function headlessSessions(options, scriptFor) {
  const built = [];
  hooks().startHeadless = async (spec) => {
    const script = scriptFor(spec) ?? {};
    if (script.startError) throw new Error(script.startError);
    const id = `synthetic-enh-${built.length + 1}`;
    const record = { id, spec, message: null, stopped: false, closed: false, actError: null, started: false,
      idle: true, sessionFile: join(spec.dir, `${id}.jsonl`), teamDir: join(options.userData, 'teams', id) };
    built.push(record);
    return syntheticHandle(record, script, () => play(record, script, options.now()));
  };
  return built;
}

/** @brief 发出第一条消息之后的替身会话（synthetic）：写记忆、写会话文件，然后按 script 结束。 */
async function play(record, script, now) {
  try {
    await script.act?.(record.spec, record);
  } catch (error) {
    record.actError = error;
  }
  writeEnhanceSession(record, script, now);
  for (const instance of script.instances ?? []) {
    mkdirSync(join(record.teamDir, 'sessions'), { recursive: true });
    writeFileSync(join(record.teamDir, 'sessions', instance.name), `${instance.lines.join('\n')}\n`);
  }
  if (script.hang) return;
  await script.release;
  record.idle = true;
  const event = script.event
    ?? (script.fail ? { type: 'mori.prompt_error', message: script.fail } : { type: 'agent_settled' });
  record.spec.onEvent({ sessionId: record.id, event });
}

/** @brief 交给增强运行的替身会话（synthetic，HeadlessSession 的形状）。 */
function syntheticHandle(record, script, start) {
  return {
    sessionId: record.id, sessionFile: record.sessionFile, teamDir: record.teamDir,
    blocked: () => script.blocked ?? null,
    send(text) {
      record.message = text;
      record.started = true;
      record.idle = false;
      setImmediate(() => void start());
    },
    idle: () => record.idle,
    started: () => record.started,
    lastAssistant: () => script.lastAssistant
      ?? (script.reply === null ? null : { stopReason: 'stop', errorMessage: null }),
    hasAssistantAfterFirst: () => script.reply !== null,
    stop: async () => {
      record.stopped = true;
      record.idle = true;
    },
    close: async () => {
      record.closed = true;
    },
  };
}

/** @brief 增强会话自己的文件（synthetic）：头、第一条消息、回复（带 usage），放在 spec.dir（记忆目录下）。 */
function writeEnhanceSession(record, script, now) {
  mkdirSync(dirname(record.sessionFile), { recursive: true });
  const items = [{ id: 'first001', at: now, role: 'user', text: record.message }];
  if (script.reply !== null) {
    items.push({ id: 'reply001', at: now, role: 'assistant', text: script.reply ?? 'Done.',
      usage: script.usage ?? { input: 100, output: 20 } });
  }
  const lines = sessionLines({ id: basename(record.sessionFile, '.jsonl'), at: now, cwd: record.spec.cwd }, items);
  writeFileSync(record.sessionFile, `${lines.join('\n')}\n`);
}

/**
 * @brief 第一条消息里列出的会话（附录 B 的 `<n>. "<title>" · <file> · lines <a>–<b> (<start>)[ · team: <dir> …]`）。
 * @return 每个会话：{ title, file, from, to, start, team }
 */
export function listedSessions(message) {
  const team = /(?: · team: (.+) \(board\.json and sessions\/\))?$/.source;
  const pattern = new RegExp(`${/^\d+\. "(.*)" · (.+) · lines (\d+)–(\d+) \((.+?)\)/.source}${team}`);
  return message.split('\n').flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [{ title: match[1], file: match[2], from: Number(match[3]), to: Number(match[4]),
      start: match[5], team: match[6] ?? null }] : [];
  });
}

/** @brief 第一条消息里 `Feedback from this day:` 下面的各行（到空行为止）。 */
export function listedFeedback(message) {
  const lines = message.split('\n');
  const start = lines.indexOf('Feedback from this day:');
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end);
}

// ---- 跑真正的增强运行的场景（enhance-run、enhance-revision、enhance-retime 共用） ----

/** 一起打包的模块：增强调度（连同真正的 enhanceRun.ts）、记忆模块、共用的文字 */
const RUN_MODULES = {
  enhance: 'src/kernel/enhance.ts', memory: 'src/kernel/memory.ts', shared: 'src/shared/memory.ts',
};

/**
 * @brief 一个跑真正增强运行的场景：新的模块实例（= 一个新的后台进程）、临时 userData、注入的时钟、看不见的会话的替身
 *        （script 由 env.script 给出，测试可以随时换）、记下的全局事件。会话表与模型层是替身（synthetic），
 *        enhance.json 里已有设置，所以模型层不会被问到。
 * @param t node:test 的测试上下文
 * @param start 起始时刻（ms）
 * @param reuse 沿用上一个场景的目录（模拟同一台机器上后台进程重新启动，§9.10）；省略时新建
 */
export async function runSetup(t, start, reuse) {
  const s = reuse ?? scenario(t);
  const k = await loadBundle(RUN_MODULES, ['sessions', 'modelLayer']);
  const events = [];
  const emit = (event) => events.push(event);
  k.memory.startMemory(s.userData, emit);
  const clock = timerClock(start);
  hooks().modelLayer = { getConfig: () => { throw new Error('synthetic: enhance.json already has the settings'); } };
  const errors = reuse ? reuse.errors : captureErrors(t);
  const env = { ...s, k, events, clock, errors, script: () => ({}) };
  env.built = headlessSessions({ userData: s.userData, now: clock.now }, (spec) => env.script(spec));
  env.startEnhance = () => k.enhance.startEnhance({ userData: s.userData, emitGlobal: emit, clock });
  // 被“结束”的后台进程（env.crashed）不收尾：同真正被结束的进程（§9.10）
  s.stops.push(() => (env.crashed ? undefined : k.enhance.stopEnhance()));
  return env;
}

/** @brief 等某个任务某一天的第 nth 次运行结束（done、skipped、failed 的进度事件），返回那条事件。 */
export function ended(env, cwd, task, day, nth = 1) {
  return until(() => env.events.filter((event) => event.type === 'mori.enhance_progress' && event.cwd === cwd
    && event.task === task && event.day === day && ['done', 'skipped', 'failed'].includes(event.phase))[nth - 1],
  `the ${task} run of ${day} (#${nth}) to end`);
}

/** @brief 某个任务某一天第 nth 次建的看不见的会话的第一条消息。 */
export function messageOf(env, task, day, nth = 1) {
  const record = env.built.filter((item) => item.spec.task === task && item.spec.run.day === day)[nth - 1];
  if (!record) throw new Error(`no ${task} session was built for ${day} (#${nth})`);
  return record.message;
}

/** @brief 一轮对话（synthetic）：用户消息与一分钟后的助手回复，id 为 `<p>u`、`<p>a`。 */
export function turn(p, day, time, text = `Question ${p}`) {
  return [
    { id: `${p}u`, at: at(day, time), role: 'user', text },
    { id: `${p}a`, at: at(day, time) + 60_000, role: 'assistant', text: `Answer ${p}` },
  ];
}

/** @brief 增强任务的写入方（带着这次运行的句柄，§6.1）。 */
export function enhancer(task, run) {
  return { by: 'Enhancement', caller: { kind: 'enhance', task }, run };
}
