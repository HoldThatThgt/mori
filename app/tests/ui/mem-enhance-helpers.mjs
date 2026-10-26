// 记忆规格增强部分的 App 套件（tests/ui/mem-app-enhance-a.mjs、mem-app-enhance-b.mjs）共用的准备、读取与页面操作
// （docs/specs/memory.md §3、§9、§10.4、§10.6、§10.7、§14.1；状态表 docs/v1/screens/memory-enhance.md、memory-chat.md）：
// - 日子的算法照规格 §9.2 在测试里另写一份（本地时间，每天的时刻是日界），用来算种子数据与期望的文字；
// - 测试准备（synthetic test setup，逐处注明）：项目文件夹、pi 的会话文件（<userData>/pi/sessions/--<编码>--/）、
//   反馈文件（<userData>/feedback/）、增强设置（<userData>/memory/projects/--<编码>--/project.json 与 enhance.json）、
//   合成端点的增强脚本文件（FAKE_ENHANCE_SCRIPT，tests/fake-endpoint/enhance.mjs）；
// - 读取：enhance.json、后台进程的 enhance.get 与 memory.*（进程桥的只读命令）、mori.enhance_progress 事件、
//   记录代理收到的增强请求（第一条消息）、增强会话自己的会话文件；
// - 页面：记忆页的 Project 与增强一块（开关、状态行、Run now、Settings…）、新会话的提示、反馈表单的说明。
// 结果文件：test-results/mem-app-<名字>.json；--only 时 mem-partial-app-<名字>.json（不计入覆盖检查，§14.3）。
// 只读页面和磁盘、发界面操作；种子数据都是测试自己写的（synthetic），不改 Mori 的源码。

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { bridge, contentText, kernelEvents, paneSel, poll, readJsonl, showTab } from './tb-helpers.mjs';

export { sleep };

// ---------- 命令行与结果文件 ----------

/**
 * @brief 解析套件的命令行：--exe <Mori.exe>（打包版）、--only a,b（只跑这些步骤，结果写成 partial）。
 * @param name 结果文件名里的套件名（mem-app-<name>.json）
 */
export function memArgs(name) {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `mem-partial-app-${name}${packaged}.json` : `mem-app-${name}${packaged}.json`;
  const shots = join(appRoot, `test-results/mem-app-${name}${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { name, exePath, only, file, shots };
}

/** @brief 结果收集器：record(name, ok, detail) 记一条，finish() 写结果文件并设退出码。 */
export function memRecorder(args) {
  const recorder = createRecorder(args.exePath ?? 'dev build');
  return {
    record: recorder.record,
    results: recorder.results,
    finish() {
      const ok = recorder.write(args.file);
      process.exitCode = ok ? 0 : 1;
      console.log(`[mem-app-${args.name}] results in test-results/${args.file}`);
      return ok;
    },
  };
}

/** @brief 一行概括（检查的 detail）。 */
export const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);
/** @brief 两个值的 JSON 相同。 */
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** @brief 错误的一行文字。 */
export const errorLine = (error) => String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 500);

// ---------- 日子（规格 §9.2，测试里另写一份） ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 增强的三个任务，按 TASTE、STRATEGY、REVIEW */
export const TASKS = ['taste', 'strategy', 'review'];
/** 任务的大写名 */
export const KIND = { taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };

const pad2 = (n) => String(n).padStart(2, '0');
/** @brief 本地日历日期 `YYYY-MM-DD`。 */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** @brief 日历上前后挪 n 天。 */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** @brief 日子 D 开始的时刻：本地时间 D 的 time。 */
export function dayStart(day, time) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
}
/** @brief 时刻属于的日子：D 的 time ≤ t < D+1 的 time。 */
export function dayOf(ms, time) {
  const calendar = localDay(ms);
  return ms < dayStart(calendar, time) ? addDays(calendar, -1) : calendar;
}
/** @brief 现在之后（严格晚于）的下一个每日时刻。 */
export function nextBoundary(ms, time) {
  const calendar = localDay(ms);
  const at = dayStart(calendar, time);
  return at > ms ? at : dayStart(addDays(calendar, 1), time);
}
/** @brief 本地 `hh:mm`。 */
export function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** @brief `YYYY-MM-DD` → `Oct 22`。 */
export const monthDay = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
/** @brief 时刻 → 本地 `Oct 22 04:00`。 */
export const monthDayTime = (ms) => `${MONTHS[new Date(ms).getMonth()]} ${new Date(ms).getDate()} ${hhmm(ms)}`;
/** @brief 第一条消息第一行里的日子 `Oct 22, 2026`（附录 B）。 */
export const dayLabel = (day) => `${monthDay(day)}, ${day.slice(0, 4)}`;
/** @brief token 数的写法（§10.4）。 */
export const formatTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k tokens` : n === 1 ? '1 token'
  : `${n} tokens`);

// ---------- 路径 ----------

/** @brief pi 会话目录与记忆项目目录共用的编码（§3，同 pi session-manager.js:290-295）。 */
export const encodeCwd = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
/** @brief 这个工作目录的 pi 会话目录。 */
export const piSessionDir = (userData, cwd) => join(userData, 'pi', 'sessions', encodeCwd(cwd));
/** @brief 这个工作目录的记忆项目目录。 */
export const memProjectDir = (userData, cwd) => join(userData, 'memory', 'projects', encodeCwd(cwd));

/** @brief 测试准备（synthetic）：root 下名为 name 的项目文件夹，带 README.md 与 src/a.ts。 */
export function makeProject(root, name) {
  const project = join(root, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), `# ${name}\n\nSynthetic project for the memory enhancement tests.\n`);
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  return project;
}

// ---------- enhance.json（§9.1，synthetic test setup） ----------

/** @brief 一个任务的状态；extra 覆盖其中的字段。 */
export const taskState = (doneThrough, extra = {}) => ({ doneThrough, watermarks: {}, feedbackSeen: null,
  running: null, last: null, ...extra });

/**
 * @brief enhance.json 的内容（synthetic）。
 * @param o { enabled(默认 true), pick(默认 'me'), thinking(默认 'medium'), team, time(默认 04:00), since, doneThrough
 *          （三个任务共用）, tasks（每个任务另外覆盖的字段）, notice }
 */
export function enhanceSeed(o = {}) {
  const tasks = Object.fromEntries(TASKS.map((task) => [task, taskState(o.doneThrough ?? null, o.tasks?.[task])]));
  return { enabled: o.enabled ?? true, pick: o.pick === undefined ? 'me' : o.pick, thinking: o.thinking ?? 'medium',
    team: o.team ?? false, time: o.time ?? '04:00', since: o.since ?? null, tasks, notice: o.notice ?? null };
}

/** @brief 测试准备（synthetic）：写 project.json（还没有时）与 enhance.json（对象或原文）。 */
export function writeEnhance(userData, cwd, file) {
  const dir = memProjectDir(userData, cwd);
  mkdirSync(dir, { recursive: true });
  const owner = join(dir, 'project.json');
  if (!existsSync(owner)) writeFileSync(owner, `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`);
  writeFileSync(join(dir, 'enhance.json'), typeof file === 'string' ? file : `${JSON.stringify(file, null, 2)}\n`);
}

/** @brief 读 enhance.json；没有或读不出时为 null。 */
export function readEnhance(userData, cwd) {
  try {
    return JSON.parse(readFileSync(join(memProjectDir(userData, cwd), 'enhance.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ---------- pi 的会话文件（synthetic test setup） ----------

/** @brief 8 位十六进制的条目 id（同 pi 的写法）。 */
const entryId = () => randomBytes(4).toString('hex');
/** @brief 合成的用量（assistant 消息带它，pi getSessionStats 的写法）。 */
const USAGE = { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** @brief 一个条目的一行（kind: user / assistant / custom / bad）。 */
function entryLine(item, id, parentId) {
  if (item.kind === 'bad') return 'this line is not JSON { synthetic';
  const timestamp = new Date(item.at).toISOString();
  if (item.kind === 'custom') {
    return JSON.stringify({ type: 'custom', customType: 'mori.synthetic', data: { note: item.text }, id, parentId,
      timestamp });
  }
  const message = item.kind === 'user'
    ? { role: 'user', content: [{ type: 'text', text: item.text }], timestamp: item.at }
    : { role: 'assistant', content: [{ type: 'text', text: item.text }], api: 'openai-completions', provider: 'me',
      model: 'fake-me', usage: USAGE, stopReason: 'stop', timestamp: item.at };
  return JSON.stringify({ type: 'message', id, parentId, timestamp, message });
}

/**
 * @brief 测试准备（synthetic）：写一个 pi 1.3.0 格式的会话文件（第一行会话头，之后每行一个条目），放在 cwd 的 pi 会话目录
 *        （headerCwd 给出另一个写法时放在它的目录，头里写它）。
 * @param userData 数据目录
 * @param cwd 项目的工作目录
 * @param opts { items: [{ kind: 'user'|'assistant'|'custom'|'bad', text, at }], name（写一条 session_info）, headerCwd }
 * @return { file, id, cwd, info（会话名那一条 { id, line: 2, at }，没有 name 时为 null）,
 *         entries: [{ id, line（物理行号，第 1 行是头）, kind, at, text }] }
 */
export function seedSession(userData, cwd, opts) {
  const headerCwd = opts.headerCwd ?? cwd;
  const dir = piSessionDir(userData, headerCwd);
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const created = opts.items[0].at - 1000;
  const file = join(dir, `${new Date(created).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const lines = [JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(created).toISOString(),
    cwd: headerCwd })];
  const seed = { file, id, cwd: headerCwd, info: null, entries: [], last: null };
  if (opts.name) {
    const infoId = entryId();
    lines.push(JSON.stringify({ type: 'session_info', id: infoId, parentId: null,
      timestamp: new Date(created).toISOString(), name: opts.name }));
    seed.last = infoId;
    seed.info = { id: infoId, line: 2, at: created };
  }
  writeFileSync(file, `${lines.join('\n')}\n`);
  appendSession(seed, opts.items);
  return seed;
}

/**
 * @brief 测试准备（synthetic）：在 seedSession 写的会话文件末尾接着写条目（例如“第二天接着聊”）。
 * @return 新写的条目（同 seedSession 的 entries）
 */
export function appendSession(seed, items) {
  const before = readFileSync(seed.file, 'utf8').split('\n').length - 1;
  const added = [];
  const lines = items.map((item, index) => {
    const id = item.kind === 'bad' ? null : entryId();
    const line = entryLine(item, id, seed.last);
    if (id) seed.last = id;
    added.push({ id, line: before + index + 1, kind: item.kind, at: item.at, text: item.text });
    return line;
  });
  appendFileSync(seed.file, `${lines.join('\n')}\n`);
  seed.entries.push(...added);
  return added;
}

/** @brief 一段对话（user、assistant 交替），从 at 起每条隔 stepMs。 */
export function chatItems(texts, at, stepMs = 60000) {
  return texts.map((text, index) => ({ kind: index % 2 === 0 ? 'user' : 'assistant', text, at: at + index * stepMs }));
}

/** @brief 测试准备（synthetic）：TaskBoard 目录 <userData>/teams/<会话 id>/，带 board.json 与一个实例会话文件。 */
export function seedTeamDir(userData, seed, at) {
  const dir = join(userData, 'teams', seed.id);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'board.json'), `${JSON.stringify({ synthetic: true, requests: [], tasks: [] })}\n`);
  const instanceId = `${seed.id}.t1.executor`;
  const id = entryId();
  const file = join(dir, 'sessions', `${new Date(at).toISOString().replace(/[:.]/g, '-')}_${instanceId}.jsonl`);
  writeFileSync(file, `${[JSON.stringify({ type: 'session', version: 3, id: instanceId,
    timestamp: new Date(at).toISOString(), cwd: seed.cwd }), entryLine({ kind: 'user', text: 'Synthetic task card',
    at }, id, null)].join('\n')}\n`);
  return { dir, file, entry: id };
}

// ---------- 反馈（synthetic test setup） ----------

/**
 * @brief 测试准备（synthetic）：<userData>/feedback/<name>，形状同 shared/feedback.ts 的 StoredFeedbackSchema。
 * @param f { name, createdAt（ms）, cwd, sessionFile（null 为没保存的会话）, title, source, expected, quote }
 */
export function seedFeedback(userData, f) {
  const dir = join(userData, 'feedback');
  mkdirSync(dir, { recursive: true });
  const stored = { expected: f.expected, quote: f.quote, source: f.source,
    session: { file: f.sessionFile ?? null, cwd: f.cwd, title: f.title ?? 'Synthetic session' },
    createdAt: new Date(f.createdAt).toISOString() };
  writeFileSync(join(dir, f.name), `${JSON.stringify(stored, null, 2)}\n`);
  return { name: f.name, ...stored };
}

/** @brief 保存的反馈文件名（<userData>/feedback/*.json），按名字排。 */
export function feedbackNames(userData) {
  const dir = join(userData, 'feedback');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

// ---------- 增强脚本（tests/fake-endpoint/enhance.mjs，synthetic） ----------

/** @brief 写增强脚本文件（合成端点每次请求重读）。 */
export const writeScript = (file, script) => writeFileSync(file, `${JSON.stringify(script, null, 2)}\n`);
/** @brief 脚本步骤：memory 工具调用。 */
export const mem = (args) => ({ call: 'memory', args });
/** @brief 脚本步骤：一句回复（可等 wait 毫秒）。 */
export const say = (text, wait = 0) => (wait ? { say: text, wait } : { say: text });
/** @brief 会话依据（§7.1 enhance 调用方）。 */
export const ev = (session, entry, quote) => ({ session, entry, ...(quote ? { quote } : {}) });
/** @brief 三个任务都只说一句（没有改动）的脚本，键可带 "@<文字>"。 */
export function quietScript(suffix = '') {
  return Object.fromEntries(TASKS.map((task) => [`${task}${suffix}`, [say(`No ${task} change.`)]]));
}

// ---------- 后台进程（进程桥的只读命令） ----------

/** @brief enhance.get。 */
export const enhanceGet = (ctx, cwd) => bridge(ctx, { type: 'enhance.get', cwd });

/**
 * @brief 按测试写好的模型设置（synthetic）另算 enhance.get 的 effortPicks（规格 §8、§9.1、§10.4）：每个分组、提供商、
 *        `<provider>/<model>` 展开后的第一个候选是否标了 Supports thinking，键按分组 → 提供商 → 模型的顺序。
 *        只适用于每个候选都过第 1–3 步静态校验的设置（tbProfile 已验证），这时第一个候选
 *        就是展开后的第一个；没有项目配置（.mori/models.json）缩小分组。
 * @param providers tbProvider 的列表
 * @param groups 分组 [{ id, members }]
 */
export function seededEffortPicks(providers, groups = []) {
  const expand = (member) => (member.includes('/') ? [member]
    : (providers.find((item) => item.id === member)?.models ?? []).map((model) => `${member}/${model.id}`));
  const thinks = (ref) => {
    const [providerId, modelId] = ref.split('/');
    const provider = providers.find((item) => item.id === providerId);
    return provider?.models.find((model) => model.id === modelId)?.reasoning === true;
  };
  const picks = {};
  for (const group of groups) picks[group.id] = thinks(group.members.flatMap(expand)[0]);
  for (const provider of providers) picks[provider.id] = thinks(expand(provider.id)[0]);
  for (const provider of providers) {
    for (const model of provider.models) picks[`${provider.id}/${model.id}`] = model.reasoning === true;
  }
  return picks;
}

/** @brief 本项目一层的修订列表（时间倒序）。 */
export async function revisionRows(ctx, cwd) {
  return (await bridge(ctx, { type: 'memory.revisions', cwd, layer: 'project' })).revisions ?? [];
}
/** @brief 一次修订的全文。 */
export async function revisionDetail(ctx, cwd, id) {
  return (await bridge(ctx, { type: 'memory.revisions', cwd, layer: 'project', id })).revision ?? null;
}
/** @brief 本项目一种的列表。 */
export const memoryList = (ctx, cwd, kind) => bridge(ctx, { type: 'memory.list', cwd, layer: 'project', kind });
/** @brief 本项目一条的详情。 */
export const memoryGet = (ctx, cwd, id) => bridge(ctx, { type: 'memory.get', cwd, layer: 'project', id });

/** @brief 增强运行的修订（run 不为 null 的），可按任务与日子筛；时间倒序。 */
export async function runRevisions(ctx, cwd, { task = null, day = null } = {}) {
  const rows = (await revisionRows(ctx, cwd)).filter((row) => row.by === 'Enhancement');
  const details = [];
  for (const row of rows) {
    const detail = await revisionDetail(ctx, cwd, row.id);
    if (!detail?.run || (task && detail.run.task !== task) || (day && detail.run.day !== day)) continue;
    details.push(detail);
  }
  return details;
}

// ---------- 进度事件（mori.enhance_progress，界面里 captureEvents 记下的） ----------

/** @brief 记下的增强进度事件 { t, cwd, task, day, phase, error?, revision? }，可按项目与起始时刻筛。 */
export async function enhanceProgress(ctx, { cwd = null, since = 0 } = {}) {
  const all = await kernelEvents(ctx, null, 'mori.enhance_progress', since);
  return all.map((item) => ({ t: item.t, ...item.data })).filter((event) => cwd === null || event.cwd === cwd);
}

/** @brief 结束的进度（done、skipped、failed）。 */
const TERMINAL = new Set(['done', 'skipped', 'failed']);

/**
 * @brief 等这个项目从 since 起有 count 个任务结束（done、skipped、failed），最多 timeout；返回这段时间的全部进度。
 */
export async function waitSettled(ctx, cwd, since, count, timeout = 120000) {
  await poll(async () => (await enhanceProgress(ctx, { cwd, since })).filter((e) => TERMINAL.has(e.phase)).length
    >= count, timeout, 300);
  return enhanceProgress(ctx, { cwd, since });
}

/** @brief 进度的简写 "<phase> <task> <day>"（检查的 detail）。 */
export const phaseBrief = (events) => events.map((e) => `${e.phase} ${e.task} ${e.day}${e.error ? ` (${e.error})`
  : ''}`);

// ---------- 记录代理收到的增强请求 ----------

/** 附录 B 第一句的开头 */
const FIRST_TEXT = "You are running Mori's daily ";
/** 第一行：种类、项目、日子 */
const FIRST_LINE = new RegExp("^You are running Mori's daily (TASTE|STRATEGY|REVIEW) enhancement for the project "
  + '(.+?)\\. Day: (.+?) \\(');

/**
 * @brief 记录代理收到的增强会话请求（第一条 user 消息以附录 B 的第一句开头），按收到的顺序；可按项目、种类筛。
 * @return [{ t, body, first（第一条消息全文）, kind, cwd, day（Oct 22, 2026）, model, effort, tools, messages }]
 */
export function enhanceRequests(ep, { since = 0, cwd = null, kind = null } = {}) {
  const out = [];
  for (const item of ep.proxy.captures) {
    if (!item.chat || !item.body || item.t < since) continue;
    const messages = item.body.messages ?? [];
    const firstUser = messages.find((m) => m.role === 'user');
    const first = contentText(firstUser?.content);
    if (!first.startsWith(FIRST_TEXT)) continue;
    const head = FIRST_LINE.exec(first);
    const info = { kind: head?.[1].toLowerCase() ?? null, cwd: head?.[2] ?? null, day: head?.[3] ?? null };
    if ((cwd && info.cwd !== cwd) || (kind && info.kind !== kind)) continue;
    out.push({ t: item.t, body: item.body, first, ...info, model: item.body.model,
      effort: item.body.reasoning_effort ?? null, tools: (item.body.tools ?? []).map((t) => t.function?.name ?? t.name),
      messages });
  }
  return out;
}

/** @brief 增强请求按运行分组（第一条消息相同的是同一次运行），按第一次请求的先后。 */
export function runsOf(requests) {
  const runs = new Map();
  for (const request of requests) {
    const run = runs.get(request.first) ?? { first: request.first, kind: request.kind, cwd: request.cwd,
      day: request.day, requests: [] };
    run.requests.push(request);
    runs.set(request.first, run);
  }
  return [...runs.values()].map((run) => ({ ...run, start: run.requests[0].t, end: run.requests.at(-1).t }));
}

/**
 * @brief 第一条消息里列出的会话（附录 B）：[{ no, title, file, from, to, start（"after entry <id>" 或 "from <…>"）,
 *        team（TaskBoard 目录或 null） }]。
 */
export function listedSessions(first) {
  const pattern = new RegExp('^(\\d+)\\. "(.*)" · (.+?\\.jsonl) · lines (\\d+)–(\\d+) '
    + '\\((after entry [^)]+|from [^)]+)\\)(?: · team: (.+) \\(board\\.json and sessions/\\))?$');
  return first.split('\n').flatMap((line) => {
    const m = pattern.exec(line);
    return m ? [{ no: Number(m[1]), title: m[2], file: m[3], from: Number(m[4]), to: Number(m[5]), start: m[6],
      team: m[7] ?? null }] : [];
  });
}

/** @brief 第一条消息里 "Feedback from this day:" 下面的行（到空行为止）。 */
export function feedbackSection(first) {
  const lines = first.split('\n');
  const at = lines.indexOf('Feedback from this day:');
  if (at < 0) return null;
  const rest = lines.slice(at + 1);
  const end = rest.indexOf('');
  return end < 0 ? rest : rest.slice(0, end);
}

// ---------- 增强会话自己的会话文件（§9.6） ----------

/** @brief 这个项目的增强会话文件（memory/projects/<key>/sessions/*.jsonl），按文件名排：{ file, id, entries }。 */
export function headlessFiles(userData, cwd) {
  const dir = join(memProjectDir(userData, cwd), 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().map((name) => {
    const entries = readJsonl(join(dir, name));
    return { file: join(dir, name), id: entries[0]?.id ?? null, entries };
  });
}

/** @brief 会话条目里的工具结果：[{ tool, isError, text }]，按顺序。 */
export function toolResultsOf(entries) {
  return entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'toolResult')
    .map((entry) => ({ tool: entry.message.toolName, isError: entry.message.isError === true,
      text: contentText(entry.message.content) }));
}

/** @brief 会话文件按 pi getSessionStats 的算法累加 input + output（§9.6 的 token 数，测试里另写一份）。 */
export function fileTokens(entries) {
  const count = (usage) => (Number(usage?.input) || 0) + (Number(usage?.output) || 0);
  return entries.filter((entry) => entry.type !== 'session').reduce((sum, entry) => {
    if (entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary') {
      return sum + count(entry.usage);
    }
    const role = entry.type === 'message' ? entry.message?.role : null;
    return role === 'assistant' || role === 'toolResult' ? sum + count(entry.message.usage) : sum;
  }, 0);
}

// ---------- 状态行（§10.4 的表，测试里另写一份） ----------

/** @brief 计数的写法：`added 1, changed 1`（为 0 的不写）；都为 0 时为空串。 */
function countsPart(counts) {
  return ['added', 'changed', 'deleted'].filter((key) => counts?.[key]).map((key) => `${key} ${counts[key]}`)
    .join(', ');
}

/** @brief 按 §10.4 的表从 enhance.get 的结果写出期望的状态行。 */
export function expectedStatus(info) {
  if (info.error !== null) return `Couldn’t read the enhancement settings: ${info.error}`;
  if (!info.enabled) {
    return 'Off · Each day, three background runs review this project’s sessions and improve its TASTE, STRATEGY, '
      + 'and REVIEW';
  }
  if (info.pick === null) return 'On · Choose a model in enhancement settings';
  const next = info.next === null ? '' : ` · Next run ${monthDayTime(info.next)}`;
  if (info.running) {
    return `Running ${KIND[info.running.task]} enhancement…${info.queued ? ` · ${info.queued} queued` : ''}`;
  }
  if (info.queued > 0) return `On · ${info.queued} queued · Waiting for another project’s enhancement`;
  const lasts = TASKS.filter((task) => info.last[task]);
  const failed = lasts.filter((task) => info.last[task].status === 'failed');
  if (failed.length) {
    const latest = [...failed].sort((a, b) => Date.parse(info.last[b].at) - Date.parse(info.last[a].at))[0];
    return `On · Last run failed (${failed.map((task) => KIND[task]).join(', ')}): ${info.last[latest].error}${next}`;
  }
  if (!lasts.length) return `On${next}`;
  const day = lasts.map((task) => info.last[task].day).sort().at(-1);
  const ofDay = lasts.filter((task) => info.last[task].day === day);
  const at = Math.max(...ofDay.map((task) => Date.parse(info.last[task].at)));
  if (ofDay.every((task) => info.last[task].status === 'skipped')) {
    return `On · Last run ${monthDayTime(at)} · No finished sessions to read${next}`;
  }
  const changes = ofDay.filter((task) => info.last[task].status === 'done' && countsPart(info.last[task].counts))
    .map((task) => `${KIND[task]}: ${countsPart(info.last[task].counts)}`);
  const tokens = ofDay.reduce((sum, task) => sum + info.last[task].tokens, 0);
  return `On · Last run ${monthDayTime(at)} · ${changes.join('; ') || 'No changes'} · ${formatTokens(tokens)}${next}`;
}

// ---------- 页面 ----------

/** @brief 记忆页开着时点 Back to app 回到对话。 */
export async function backToApp(ctx) {
  const page = ctx.page.getByTestId('memory-page');
  if (!(await page.count())) return;
  await page.getByRole('button', { name: 'Back to app' }).click();
  await page.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 显示 tab 这个会话，打开记忆页、切到 Project，等增强一块读到状态（状态行不为空）。 */
export async function openMemoryProject(ctx, tab) {
  await backToApp(ctx);
  await showTab(ctx, tab);
  await ctx.page.getByTestId('nav-memory').click();
  await ctx.page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  const project = ctx.page.getByTestId('memory-scope-project');
  if ((await project.getAttribute('aria-pressed')) !== 'true') await project.click();
  await ctx.page.getByTestId('memory-enhance').waitFor({ timeout: 10000 });
  await waitStatus(ctx, (text) => text !== '', 15000);
}

/** @brief 状态行此刻的文字；没有增强一块时为 null。 */
export const statusText = (ctx) => ctx.page.getByTestId('enhance-status').textContent({ timeout: 2000 })
  .catch(() => null);

/**
 * @brief 等状态行符合 want（字符串全等、正则或函数），最多 timeout；返回最后读到的文字（等不到也返回）。
 */
export async function waitStatus(ctx, want, timeout = 30000) {
  const test = typeof want === 'string' ? (text) => text === want
    : want instanceof RegExp ? (text) => want.test(text) : want;
  let last = null;
  await poll(async () => {
    last = await statusText(ctx);
    return last !== null && test(last);
  }, timeout, 200);
  return last;
}

/** @brief 开关此刻的样子：{ checked（aria-checked）, disabled, title }。 */
export function switchState(ctx) {
  return ctx.page.getByTestId('enhance-switch').evaluate((el) => ({ checked: el.getAttribute('aria-checked'),
    disabled: el.disabled, title: el.getAttribute('title') }));
}

/** @brief 点开关，等它可用且 aria-checked 为 want（等不到时照常返回）。 */
export async function clickSwitch(ctx, want) {
  await ctx.page.getByTestId('enhance-switch').click();
  await ctx.page.waitForFunction((value) => {
    const el = document.querySelector('[data-testid="enhance-switch"]');
    return el && !el.disabled && el.getAttribute('aria-checked') === value;
  }, String(want), { timeout: 15000 }).catch(() => {});
  return switchState(ctx);
}

/** @brief Run now 是否可用。 */
export const runEnabled = (ctx) => ctx.page.getByTestId('enhance-run').isEnabled({ timeout: 2000 })
  .catch(() => false);

/** @brief 某个会话面板里新会话的提示：文字与 View 是否可用；没有时为 null。 */
export function noticeOf(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const banner = document.querySelector(`${selector} [data-testid="memory-notice"]`);
    if (!banner) return null;
    const view = banner.querySelector('[data-testid="memory-notice-view"]');
    return { text: banner.querySelector('span')?.textContent ?? '', view: Boolean(view && !view.disabled),
      dismiss: Boolean(banner.querySelector('[data-action="dismiss"]')) };
  }, paneSel(tab));
}

/** @brief 记忆页 Revisions 里选中的那一行与右栏修订的标题。 */
export function revisionView(ctx) {
  return ctx.page.evaluate(() => {
    const selected = document.querySelector('[data-testid="revision-row"][aria-pressed="true"]');
    const detail = document.querySelector('[data-testid="revision-detail"]');
    return { section: document.querySelector('[data-testid="memory-section-revisions"]')
      ?.getAttribute('aria-pressed'), scope: document.querySelector('[data-testid="memory-scope-project"]')
      ?.getAttribute('aria-pressed'), selected: selected?.dataset.id ?? null,
    tags: selected ? [...selected.querySelectorAll('.memory-tag')].map((el) => el.textContent) : [],
    title: detail?.querySelector('.memory-detail-title')?.textContent ?? null,
    meta: detail ? [...detail.querySelectorAll('.memory-detail-meta')].map((el) => el.textContent) : [] };
  });
}

/**
 * @brief 在页面里装一个记录器：反馈表单底部说明（feedback-note）每次变成的文字（含空串）依次记进 window.__memNotes
 *        （先清空），看说明是否先显示过另一种说法（§10.7）。
 */
export function watchFeedbackNote(ctx) {
  return ctx.page.evaluate(() => {
    window.__memNotes = [];
    window.__memNoteObserver?.disconnect();
    let last;
    const scan = () => {
      const el = document.querySelector('[data-testid="feedback-note"]');
      if (!el) return;
      const text = el.textContent ?? '';
      if (text !== last) window.__memNotes.push(text);
      last = text;
    };
    window.__memNoteObserver = new MutationObserver(scan);
    window.__memNoteObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

/** @brief watchFeedbackNote 记下的文字。 */
export const feedbackNotes = (ctx) => ctx.page.evaluate(() => window.__memNotes ?? []);

/** 反馈表单的两种说明（§10.7） */
export const NOTE_ON = 'Saved as evidence for this project’s daily enhancement. To have Mori act on it now, use '
  + '“Attach as context” instead.';
export const NOTE_OFF = 'This project doesn’t have enhancement on, so feedback is only saved. To have Mori act on it, '
  + 'use “Attach as context” instead.';

/** @brief 等到 cond() 为真，最多 timeout（毫秒）；返回是否等到。 */
export const waitFor = async (cond, timeout = 30000, step = 300) => Boolean(await poll(cond, timeout, step));
