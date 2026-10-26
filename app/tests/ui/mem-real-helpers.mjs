// 记忆规格真实模型一层（mem-real.mjs）的准备、读盘、请求与界面操作（docs/specs/memory.md §14.1“真实模型一层”）：
// - 数据目录：检查负责人的数据目录（两个真实提供商、key 的 ref 在 credentials.json 里；只看键名，不读、不打印、不解密密文），
//   复制与测试准备用 tb-real-helpers.mjs prepareRealData（只复制加密的文件，不写来源目录）。
// - 读盘：记忆目录（§3）的索引、detail、修订记录与 enhance.json，增强会话的文件（§9.6）。文件格式在这里独立解析一遍
//   （不从 src 导入），用来核对程序写出的文件：frontmatter 每行 `key: value`，value 是 JSON（字符串、数组、对象）或
//   不带引号的原文（kind、source）；修订的前后两块按 §3.3 的围栏读。
// - 请求：转发代理（tb-real-helpers.mjs startForwardProxy，只记请求体，不记请求头）记下的对话请求：system 全文、工具名、
//   用户消息；system 里四个分节按 pi 的写法 `<name>\n…\n</name>`（§5.2）。
// - 增强任务第一条消息（附录 B）列出的材料：会话文件、起止行、TaskBoard 目录、反馈文件名（§9.7 依据的范围）。
// - 界面：记忆页与增强一块的操作，按 §10.11 的标识（docs/v1/screens/memory-page.md、memory-enhance.md）。
// 只读页面和磁盘、发界面操作；不改 Mori 的源码。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contentText, messagesOf, readJsonl } from './tb-helpers.mjs';
import { realProvidersOf } from './tb-real-helpers.mjs';
import { readJson } from './v1-real-helpers.mjs';

/** 种类的名字（§1：界面、索引标题、修订小节都用它） */
export const KIND_LABEL = { fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };
/** 种类 → 索引文件（§3） */
const INDEX_FILE = { fact: 'MEMORY.md', taste: 'TASTE.md', strategy: 'STRATEGY.md', review: 'REVIEW.md' };
/** system prompt 里四个分节的写入顺序（§5.2） */
export const SECTION_ORDER = ['taste', 'strategy', 'review', 'fact'];
/** 种类 → 分节名（§5.2） */
export const SECTION_KEY = { taste: 'taste', strategy: 'strategy', review: 'review', fact: 'facts' };
/** 层在工具结果里的写法（§7.4） */
export const LAYER_PROSE = { user: 'user level', project: 'this project' };
/** 增强任务（§1），按 TASTE→STRATEGY→REVIEW */
export const TASKS = ['taste', 'strategy', 'review'];
/** 增强任务第一条消息的第一句（附录 B），从中读出种类 */
const ENHANCE_FIRST = /^You are running Mori's daily (TASTE|STRATEGY|REVIEW) enhancement/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 驱动里发的文字（英文：§14.1 给出的两句原话，其余是让会话有材料、少调工具的短句） */
export const PROMPTS = {
  FACT: 'The intranet model is at 10.0.0.9, note it.',
  RULE: 'From now on, start every answer with the conclusion.',
  // 2026-10-26（§0 第 5 条）：不说“记一下”的长期事实与一句纠正，看主 Agent 会不会主动记
  STATED: 'For context: our staging database is PostgreSQL 15 on db-stage.internal, and we only deploy on Thursdays.',
  CORRECT: 'No tables in your answers, please: I read them in a narrow terminal. Use short bullet lists instead.',
  HELLO: 'Say hello in one short sentence. Do not call any tools.',
  AFTER: 'Say good morning in one short sentence. Do not call any tools.',
  // 给增强任务的材料（你纠正回复的写法），每次运行前在对话会话里发一句
  CORRECTIONS: [
    'I only wanted the address, not an explanation. What is the address of the intranet model? Just the address.',
    'Too much text again. Give me the conclusion in one line and stop there. Which address was it?',
    'Shorter, please: one line, no preamble. What did I ask you to note earlier?',
  ],
};

/** 记忆页写的那条 TASTE（synthetic：测试写的条目文字，§14.1“在记忆页写一条 TASTE”） */
export const PAGE_TASTE = {
  abstract: 'When the user asks for a list, give at most five items.',
  details: 'Written on the Memory page by the mem-real walkthrough (synthetic test entry).',
};

// ---------- 数据目录 ----------

/**
 * @brief 检查负责人的数据目录（§14.1 同平行 Agent 规格 §17.1）：有 model-config.json、credentials.json、Local State，
 *        两个真实提供商（默认 DeepSeek 与 GLM，区域已确认），每个都有 key，并且 key 的 ref 在 credentials.json 里
 *        （只看键名，不读、不打印、不解密密文）。
 * @param source --source 的值（已 resolve）；没给时为 null
 * @return { found }，或 { error }（一句说明，给命令行）
 */
export function checkSource(source) {
  if (!source) {
    return { error: 'Missing --source <Mori data dir>. Pass a Mori data dir where DeepSeek and GLM were saved with '
      + 'their keys (docs/specs/memory.md §14.1).' };
  }
  if (!existsSync(source)) return { error: `The data dir ${source} does not exist.` };
  let found;
  let refs;
  try {
    found = realProvidersOf(source);
    refs = new Set(Object.keys(readJson(join(source, 'credentials.json'))));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  for (const provider of [found.first, found.second]) {
    const keys = provider.keys ?? [];
    if (keys.length === 0) {
      return { error: `${provider.id} has no key in model-config.json; save its key in Mori first.` };
    }
    if (!keys.some((key) => refs.has(key.ref))) {
      return { error: `credentials.json in ${source} has no saved key for ${provider.id}; save its key in Mori `
        + 'first.' };
    }
  }
  return { found };
}

/** @brief 只有一个 README 的临时项目（§14.1 驱动；synthetic：测试写的文件）。 */
export function readmeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mori-mem-real-'));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'README.md'), '# Mori memory walkthrough\n\nThis folder only has this README. It is '
    + 'used to check Mori\'s memory with a real model.\n');
  return project;
}

// ---------- 小工具 ----------

/** @brief 路径比较用的写法（/ 与 \ 不分、大小写不分）。 */
export const pathKey = (path) => String(path ?? '').replace(/\\/g, '/').toLowerCase();
/** @brief 读文本文件；不存在时为 null。 */
export const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
/** @brief `YYYY-MM-DD` → `Oct 22`。 */
export function monthDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day));
  return match ? `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}` : String(day);
}
/** @brief 毫秒时刻的本地日历日期 `YYYY-MM-DD`。 */
export function localDate(ms = Date.now()) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** @brief 现在属于的日子（§9.2，时刻 time 为日界）。 */
export function dayNow(time = '04:00', ms = Date.now()) {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(ms);
  const before = date.getHours() * 60 + date.getMinutes() < hours * 60 + minutes;
  return localDate(before ? ms - 24 * 3600 * 1000 : ms);
}
/** @brief 写成一行（同记忆模块写依据行、修订说明的规则）。 */
export const flat = (text) => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
/** @brief 修订标题里的 abstract：前 60 个字符（§6.5、§12）。 */
export const clip60 = (text) => [...String(text ?? '')].slice(0, 60).join('');

// ---------- 记忆目录（§3） ----------

/** @brief 项目目录名（§3，与 pi 的会话目录同一种编码）。 */
export const projectDirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
/** @brief 两层的目录：{ user, project }。 */
export const memoryDirs = (userData, cwd) => ({ user: join(userData, 'memory', 'user'),
  project: join(userData, 'memory', 'projects', projectDirName(cwd)) });

/**
 * @brief 解析 frontmatter（§3.2、§3.3）：第一行 `---` 到下一个单独的 `---`；每行 `key: value`，value 按 JSON 解析，
 *        解析不了时取原文。
 * @return { front, body }；没有 frontmatter 时为 null
 */
export function parseFront(text) {
  const lines = String(text ?? '').split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return null;
  const front = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(': ');
    if (at < 0) continue;
    const raw = line.slice(at + 2);
    try {
      front[line.slice(0, at)] = JSON.parse(raw);
    } catch {
      front[line.slice(0, at)] = raw;
    }
  }
  return { front, body: lines.slice(end + 1).join('\n') };
}

/** 修订小节的标题（§3.3） */
const CHANGE_HEAD = /^## (Added|Changed|Deleted|Moved to user level|Moved to this project) · (.+?) · (.+)$/;

/** @brief 读一块原文（§3.3 的围栏）：从 at 起跳过空行，开头行 `<波浪号>label`，到恰好同样个数波浪号的单独一行。 */
function fencedBlock(lines, at, label) {
  let i = at;
  while (lines[i] === '') i += 1;
  const open = new RegExp(`^(~{4,})${label}$`).exec(lines[i] ?? '');
  if (!open) throw new Error(`no ${label} block at body line ${i + 1}`);
  const content = [];
  for (i += 1; i < lines.length && lines[i] !== open[1]; i += 1) content.push(lines[i]);
  if (i >= lines.length) throw new Error(`the ${label} block is not closed`);
  return { text: content.join('\n'), next: i + 1 };
}

/**
 * @brief 解析修订文件（§3.3）。
 * @return { front, changes: [{ action（Added…）, kind（种类名）, slug, evidence, note, before, after }], notes（没有时 null） }
 * @throws Error 没有 frontmatter 或块不完整
 */
export function parseRevision(text) {
  const parsed = parseFront(text);
  if (!parsed) throw new Error('the revision has no frontmatter');
  const lines = parsed.body.split('\n');
  const changes = [];
  let notes = null;
  for (let i = 0; i < lines.length;) {
    if (lines[i] === '## Notes') {
      notes = lines.slice(i + 1).join('\n').replace(/\n$/, '');
      break;
    }
    const head = CHANGE_HEAD.exec(lines[i]);
    i += 1;
    if (!head) continue;
    const change = { action: head[1], kind: head[2], slug: head[3], evidence: null, note: null };
    for (; i < lines.length && !/^~{4,}before$/.test(lines[i]); i += 1) {
      if (lines[i].startsWith('Evidence: ')) change.evidence = lines[i].slice('Evidence: '.length);
      else if (lines[i].startsWith('Note: ')) change.note = lines[i].slice('Note: '.length);
    }
    const before = fencedBlock(lines, i, 'before');
    const after = fencedBlock(lines, before.next, 'after');
    changes.push({ ...change, before: before.text, after: after.text });
    i = after.next;
  }
  return { front: parsed.front, changes, notes };
}

/** @brief 读一个修订文件：不存在时 null，读不出时 { error }。 */
export function readRevision(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return parseRevision(text);
  } catch (error) {
    return { error: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** @brief 一层 revisions/ 下的修订：[{ id, file }]，按名字（时间）排序。 */
export function revisionFiles(dir) {
  const revisions = join(dir, 'revisions');
  if (!existsSync(revisions)) return [];
  return readdirSync(revisions).filter((name) => name.endsWith('.md')).sort()
    .map((name) => ({ id: name.slice(0, -3), file: join(revisions, name) }));
}

/** @brief 一层一种的索引行（§3.1）：[{ text（链接文字，已去转义）, slug }]，按索引顺序。 */
export function readIndex(dir, kind) {
  return (readText(join(dir, INDEX_FILE[kind])) ?? '').split('\n')
    .map((line) => /^- \[((?:\\.|[^\\\]])*)\]\(entries\/(.+)\.md\)\s*$/.exec(line)).filter(Boolean)
    .map((match) => ({ text: match[1].replace(/\\(.)/g, '$1'), slug: match[2] }));
}

/** @brief 一层一种读得出来的条目（按索引顺序，abstract 以 detail 为准，§3.1）：[{ slug, abstract, file, text, front }]。 */
export function layerEntries(dir, kind) {
  return readIndex(dir, kind).flatMap((item) => {
    const file = join(dir, 'entries', `${item.slug}.md`);
    const text = readText(file);
    const front = text === null ? null : parseFront(text)?.front;
    const ok = front && typeof front.abstract === 'string' && front.abstract.trim() !== '' && front.kind === kind;
    return ok ? [{ slug: item.slug, abstract: front.abstract, file, text, front }] : [];
  });
}

/** @brief 一层 entries/ 下全部 detail 文件的原文：{ slug: 原文 }（增强运行前的快照）。 */
export function entryFiles(dir) {
  const entries = join(dir, 'entries');
  if (!existsSync(entries)) return {};
  return Object.fromEntries(readdirSync(entries).filter((name) => name.endsWith('.md'))
    .map((name) => [name.slice(0, -3), readFileSync(join(entries, name), 'utf8')]));
}

/**
 * @brief 主 Agent（关闭模式）这时打开的新会话该拿到的四个分节（§5.1、§5.2）：每种一段，用户级在前、本项目在后，
 *        每行 `- <abstract>`；两层都没有条目时为 null。
 * @return { taste, strategy, review, facts }
 */
export function expectedSections(dirs) {
  const out = {};
  for (const kind of SECTION_ORDER) {
    const lines = [...layerEntries(dirs.user, kind), ...layerEntries(dirs.project, kind)]
      .map((entry) => `- ${entry.abstract}`);
    out[SECTION_KEY[kind]] = lines.length > 0 ? lines.join('\n') : null;
  }
  return out;
}

/** @brief system 全文里 `<cwd>` 之后的四个分节的内容（pi 的写法 `<name>\n…\n</name>`）；没有的为 null。 */
export function sectionsOf(system) {
  const from = Math.max(0, system.indexOf('<cwd>\n'));
  const out = {};
  for (const key of Object.values(SECTION_KEY)) {
    const open = system.indexOf(`<${key}>\n`, from);
    const close = open < 0 ? -1 : system.indexOf(`\n</${key}>`, open);
    out[key] = close < 0 ? null : system.slice(open + key.length + 3, close);
  }
  return out;
}

// ---------- 会话文件 ----------

/** @brief 会话文件第 n 个物理行（从 1 起，§9.5）的条目 id；不是 JSON 或没有 id 时为 null。 */
export function lineId(file, n) {
  const line = (readText(file) ?? '').split('\n')[n - 1];
  try {
    return JSON.parse(line ?? '').id ?? null;
  } catch {
    return null;
  }
}

/** @brief 会话文件里全部条目的 id。 */
export const entryIds = (file) => new Set(readJsonl(file).map((entry) => entry.id).filter(Boolean));

/**
 * @brief 会话条目里某几个工具的每次调用：[{ call（toolCall 部分）, args, result（toolResult 消息，没有时 null）,
 *        entry（发出调用的助手消息条目） }]，按顺序。
 */
export function toolCallsOf(entries, names) {
  const results = new Map(entries.filter((e) => e.type === 'message' && e.message?.role === 'toolResult')
    .map((e) => [e.message.toolCallId, e.message]));
  return entries.filter((e) => e.type === 'message' && e.message?.role === 'assistant').flatMap((entry) =>
    (entry.message.content ?? []).filter((part) => part.type === 'toolCall' && names.includes(part.name))
      .map((call) => ({ call, args: call.arguments ?? {}, result: results.get(call.id) ?? null, entry })));
}

/** memory 工具参数的键（§7.1）与依据每一项的键 */
const MEMORY_KEYS = ['action', 'kind', 'layer', 'entry', 'abstract', 'detail', 'note', 'quote', 'evidence'];
const EVIDENCE_KEYS = ['session', 'entry', 'feedback', 'quote'];

/**
 * @brief 按键名归一取一个参数（§7.1：与 TaskBoard 工具同样的归一，平行 Agent 规格 §6.2）：键名不分大小写、不看 _ 与 -，
 *        <name>_id、<name>Id 也算 <name>。这里独立实现一遍：会话文件里记的是模型给的原始参数。
 */
export function argNamed(args, name) {
  if (!args || typeof args !== 'object') return undefined;
  if (Object.hasOwn(args, name)) return args[name];
  const form = (key) => key.toLowerCase().replace(/[_-]/g, '');
  const key = Object.keys(args).find((item) => form(item) === name || form(item) === `${name}id`);
  return key === undefined ? undefined : args[key];
}

/** @brief memory 工具的原始参数归一成 schema 的键（依据的每一项也归一）。 */
function memoryArgs(raw) {
  const out = Object.fromEntries(MEMORY_KEYS.map((key) => [key, argNamed(raw, key)]).filter(([, v]) => v != null));
  if (Array.isArray(out.evidence)) {
    out.evidence = out.evidence.map((item) => Object.fromEntries(EVIDENCE_KEYS
      .map((key) => [key, argNamed(item, key)]).filter(([, v]) => v != null)));
  }
  return out;
}

/** @brief memory 工具的每次调用（args 已按键名归一）。 */
export const memoryCalls = (entries) => toolCallsOf(entries, ['memory'])
  .map((item) => ({ ...item, args: memoryArgs(item.args) }));
/** @brief 调用成功（有结果且不是错误）。 */
export const succeeded = (item) => item.result !== null && item.result.isError !== true;

/** @brief 从一个条目沿 parentId 往上，最近的用户消息条目的 id（这次运行是哪条消息引起的）；没有时 null。 */
export function userEntryBefore(entries, entry) {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  for (let at = byId.get(entry.parentId); at; at = byId.get(at.parentId)) {
    if (at.type === 'message' && at.message?.role === 'user') return at.id;
  }
  return null;
}

/** @brief 某个条目（用户消息）的文字。 */
export function entryText(entries, id) {
  const entry = entries.find((e) => e.id === id);
  return entry?.type === 'message' ? contentText(entry.message?.content) : '';
}

/** @brief 会话条目里最后一条助手消息的正文（文字部分以换行连接，去掉首尾空白）。 */
export function lastAssistantText(entries) {
  const last = messagesOf(entries, 'assistant').at(-1);
  return (last?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
}

/** 第一条消息里列出会话的一行（附录 B） */
const SESSION_LINE = new RegExp('^(\\d+)\\. "(.*)" · (.+?) · lines (\\d+)–(\\d+) \\(([^)]*)\\)'
  + '(?: · team: (.+) \\(board\\.json and sessions/\\))?$');

/**
 * @brief 增强任务第一条消息列出的材料（附录 B、§9.7）。
 * @return { sessions: [{ title, file, from, to, start, team }], feedback: [文件名] }
 */
export function parseMaterial(text) {
  const sessions = [];
  const feedback = [];
  let part = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('Sessions to read for this day.')) part = 'sessions';
    else if (line === 'Feedback from this day:') part = 'feedback';
    else if (line.startsWith('Current entries.')) part = null;
    else if (part === 'sessions' && SESSION_LINE.test(line)) {
      const m = SESSION_LINE.exec(line);
      sessions.push({ title: m[2], file: m[3], from: Number(m[4]), to: Number(m[5]), start: m[6], team: m[7] ?? null });
    } else if (part === 'feedback' && line.startsWith('- ')) feedback.push(line.slice(2).split(' · ')[0]);
  }
  return { sessions, feedback };
}

/**
 * @brief 记忆目录下的增强会话（§9.6：memory/projects/<key>/sessions/*.jsonl），会话头部的时刻不早于 since 的，
 *        每项 { file, id, t（头部的时刻）, task（第一条消息里的种类）, first（第一条消息的文字）, entries }。
 */
export function enhanceSessions(projectDir, since = 0) {
  const dir = join(projectDir, 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().map((name) => {
    const file = join(dir, name);
    const all = readJsonl(file);
    const first = contentText(messagesOf(all.slice(1), 'user')[0]?.content);
    const task = ENHANCE_FIRST.exec(first)?.[1]?.toLowerCase() ?? null;
    return { file, id: all[0]?.id ?? null, t: Date.parse(all[0]?.timestamp ?? ''), task, first, entries: all.slice(1) };
  }).filter((session) => session.t >= since);
}

// ---------- 代理记下的请求 ----------

/**
 * @brief 代理记下的对话请求（有 messages 的 POST），从 since 起、system 里有 cwd 的（给了 cwd 时），按收到的顺序，每项
 *        { t, provider, model, status, system（system/developer 消息与 Anthropic 的 system 字段的全文）, tools（工具名）,
 *          firstUser, lastUser }。
 */
export function chatBodies(proxy, { since = 0, cwd = null } = {}) {
  const out = [];
  for (const item of proxy?.captures ?? []) {
    const body = item.body;
    if (item.t < since || item.method !== 'POST' || !Array.isArray(body?.messages)) continue;
    const system = [body.system === undefined ? '' : contentText(body.system), ...body.messages
      .filter((m) => m.role === 'system' || m.role === 'developer').map((m) => contentText(m.content))]
      .filter(Boolean).join('\n');
    if (cwd && !pathKey(system).includes(pathKey(cwd))) continue;
    const users = body.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content));
    out.push({ t: item.t, provider: item.provider, model: body.model, status: item.status, system,
      tools: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name), firstUser: users[0] ?? '',
      lastUser: users.at(-1) ?? '' });
  }
  return out;
}

// ---------- 界面：记忆页与增强一块 ----------

/** @brief 等某个标识的元素出现并且可用。 */
export function waitEnabled(page, testid, timeout = 30000) {
  return page.waitForFunction((css) => {
    const el = document.querySelector(css);
    return Boolean(el) && !el.disabled;
  }, `[data-testid="${testid}"]`, { timeout });
}

/** @brief 点一个分段按钮（层或分节），等它 aria-pressed 为真；已经按下时不点。 */
async function press(page, testid) {
  const css = `[data-testid="${testid}"]`;
  await waitEnabled(page, testid);
  if ((await page.locator(css).getAttribute('aria-pressed')) !== 'true') await page.locator(css).click();
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'true', css,
    { timeout: 10000 });
}

/** @brief 打开记忆页（左栏 Memory），切到 Project 与某个分节（facts、taste、…、revisions）。 */
export async function openMemoryPlace(page, section) {
  if (!(await page.getByTestId('memory-page').isVisible().catch(() => false))) {
    await page.getByTestId('nav-memory').click();
    await page.getByTestId('memory-page').waitFor({ timeout: 15000 });
  }
  await press(page, 'memory-scope-project');
  await press(page, `memory-section-${section}`);
}

/** @brief 在记忆页时点顶栏的 Back to app，等记忆页关掉。 */
export async function backToApp(page) {
  const memory = page.getByTestId('memory-page');
  if (!(await memory.isVisible().catch(() => false))) return;
  await memory.getByRole('button', { name: 'Back to app' }).click();
  await memory.waitFor({ state: 'detached', timeout: 10000 });
}

/**
 * @brief 记忆页 Project → TASTE → New entry，填 Abstract 与 Details，Save，等表单关闭、列表里出现这一条。
 * @throws Error 保存失败（带详情顶部 memory-error 的原文）
 */
export async function addPageEntry(page, entry) {
  await openMemoryPlace(page, 'taste');
  await waitEnabled(page, 'memory-new');
  await page.getByTestId('memory-new').click();
  const form = page.getByTestId('memory-form');
  await form.waitFor({ timeout: 10000 });
  await form.getByTestId('memory-abstract').fill(entry.abstract);
  await form.getByTestId('memory-details').fill(entry.details);
  await form.getByTestId('memory-save').click();
  const closed = await form.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  if (!closed) {
    const error = await page.getByTestId('memory-error').textContent({ timeout: 1000 }).catch(() => null);
    throw new Error(`the Memory page did not save the entry: ${error ?? 'the form stayed open'}`);
  }
  await page.locator('[data-testid="memory-row"]').filter({ hasText: entry.abstract }).first()
    .waitFor({ timeout: 15000 });
}

/**
 * @brief 记忆页 Project 的增强一块：打开开关（已开时不点），Settings… 里 Model range 选 pick，Save，等对话框关闭。
 * @param pick 选择范围（提供商 id、分组 id 或 <provider>/<model>）
 */
export async function turnOnEnhancement(page, pick) {
  await openMemoryPlace(page, 'facts');
  await waitEnabled(page, 'enhance-switch');
  const toggle = page.getByTestId('enhance-switch');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="enhance-switch"]')
    ?.getAttribute('aria-checked') === 'true', null, { timeout: 15000 });
  await waitEnabled(page, 'enhance-settings');
  await page.getByTestId('enhance-settings').click();
  const dialog = page.getByTestId('enhance-dialog');
  await dialog.waitFor({ timeout: 10000 });
  await waitEnabled(page, 'enhance-model');
  await dialog.getByTestId('enhance-model').selectOption(pick);
  await waitEnabled(page, 'enhance-save');
  await dialog.getByTestId('enhance-save').click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
}

/** @brief 记忆页 Project 的 Run now（等它可用再点）。 */
export async function clickRunNow(page) {
  await openMemoryPlace(page, 'facts');
  await waitEnabled(page, 'enhance-run', 60000);
  await page.getByTestId('enhance-run').click();
}

/**
 * @brief 记忆页 Project → Revisions，选中修订 id，等右栏是它（标题），点 Roll back this revision，
 *        等列表里出现 `Rolled back: <title>`。
 */
export async function rollbackInUi(page, id, title) {
  await openMemoryPlace(page, 'revisions');
  const row = page.locator(`[data-testid="revision-row"][data-id="${id}"]`);
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await page.locator('[data-testid="revision-detail"]', { hasText: title }).waitFor({ timeout: 15000 });
  await waitEnabled(page, 'revision-rollback');
  await page.getByTestId('revision-detail').getByTestId('revision-rollback').click();
  await page.locator('[data-testid="revision-row"]').filter({ hasText: `Rolled back: ${title}` }).first()
    .waitFor({ timeout: 30000 });
}

/** @brief 某个会话面板里的 memory 工具卡（§7.5 的标题）：[{ verb, status, view（有 View in Memory） }]。 */
export function memoryCards(page, tab) {
  return page.locator(`[data-testid="chat-pane"][data-tab="${tab}"] [data-testid="tool-card"]`)
    .evaluateAll((cards) => cards.map((card) => ({ verb: card.querySelector('.tool-verb')?.textContent ?? '',
      status: card.dataset.status, view: Boolean(card.querySelector('[data-testid="tool-memory-view"]')) }))
      .filter((card) => /^(Save to |Update memory|Delete from memory)/.test(card.verb)));
}
