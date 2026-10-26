// mem-app-tool.mjs 用的准备、读取与页面操作（docs/specs/memory.md §14.1；界面标识见 docs/v1/screens/memory-page.md、
// memory-chat.md）：
// - 命令行与结果文件：test-results/mem-app-<suite>(-packaged).json；--only 时 mem-partial-app-<suite>…（不计入覆盖检查，§14.3）；
// - 记忆文件（§3）：项目目录名（同 pi 的会话目录编码）、索引、detail、修订的读取；测试写好的条目（synthetic test setup，
//   按 §3.1、§3.2 的格式写，内容里写明 synthetic）；
// - 会话文件：用户消息、助手的工具调用、工具结果（读 pi 的 jsonl，不改它）；
// - 记忆页：打开、换层、换分节、选行、读页面的样子；工具卡：标题、状态、Output、View in Memory；
// - 独占地打开一个文件（Windows，不给任何共享），让后台进程读它时出错（MEM-15 读会话文件的其他错误）。
// 只读页面和磁盘（测试准备除外），不记录检查结果（检查结果由调用方记录）。

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import koffi from 'koffi';
import { appRoot, arg, createRecorder, oneLine } from './lib.mjs';
import { paneSel, poll } from './tb-helpers.mjs';

// ---------- 命令行与结果文件 ----------

/**
 * @brief 解析套件的命令行：--exe <Mori.exe>（打包版）、--only a,b（只跑这些步骤，结果写成 mem-partial-…）。
 * @param suite 套件名（mem-app-<suite>.mjs 的 <suite>）
 * @return { suite, exePath, only, file（结果文件名）, shots（截图目录） }
 */
export function memArgs(suite) {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `mem-partial-app-${suite}${packaged}.json` : `mem-app-${suite}${packaged}.json`;
  const shots = join(appRoot, `test-results/mem-app-${suite}${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite, exePath, only, file, shots };
}

/** @brief 结果收集器（同 lib.mjs createRecorder）：finish() 写结果文件并设退出码。 */
export function memRecorder(args) {
  const recorder = createRecorder(args.exePath ?? 'dev build');
  return {
    record: recorder.record,
    results: recorder.results,
    finish() {
      const ok = recorder.write(args.file);
      process.exitCode = ok ? 0 : 1;
      console.log(`[mem-app-${args.suite}] results in test-results/${args.file}`);
      return ok;
    },
  };
}

/** @brief 一行概括（检查的 detail）。 */
export const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);

// ---------- 记忆文件（§3） ----------

/** 每种的索引文件名与名字（§1、§3.1） */
export const KIND_FILE = { fact: 'MEMORY.md', taste: 'TASTE.md', strategy: 'STRATEGY.md', review: 'REVIEW.md' };
export const KIND_LABEL = { fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @brief 两位补零。 */
const pad = (value) => String(value).padStart(2, '0');

/** @brief 本地日历日期 YYYY-MM-DD。 */
export function localDay(ms = Date.now()) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** @brief YYYY-MM-DD → `Oct 22`（§3.2 的依据行与 Revisions 行）。 */
export function monthDay(day) {
  const [, , month, date] = /^(\d{4})-(\d{2})-(\d{2})/.exec(day) ?? [];
  return month ? `${MONTHS[Number(month) - 1]} ${Number(date)}` : day;
}

/** @brief 项目目录名：与 pi 的会话目录同一种编码（§3）。 */
export const projectDirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/** @brief 一层的目录：cwd 为 null 时是用户级，否则是这个工作目录的项目目录。 */
export const memBase = (userData, cwd) => (cwd === null ? join(userData, 'memory', 'user')
  : join(userData, 'memory', 'projects', projectDirName(cwd)));

/** @brief detail 文件的路径。 */
export const detailPath = (base, slug) => join(base, 'entries', `${slug}.md`);

/** @brief 文件全文；不存在时为 null。 */
export const fileText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** @brief 依据的一行（§3.2，同 shared/memory.ts evidenceLine）。 */
export function evidenceLine(item, title = item.title) {
  const quote = item.quote ? `: “${item.quote}”` : '';
  if (item.feedback !== undefined) return `${monthDay(item.at)} · Feedback${quote}`;
  return `${monthDay(item.at)} · Session “${title ?? 'Untitled session'}”${quote}`;
}

/**
 * @brief 测试准备（synthetic test setup）：项目目录与它的 project.json（§3：第一次写这个目录的一方先写它）。
 * @return 项目目录
 */
export function seedProject(userData, cwd) {
  const base = memBase(userData, cwd);
  mkdirSync(join(base, 'entries'), { recursive: true });
  writeFileSync(join(base, 'project.json'), `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`);
  return base;
}

/**
 * @brief 测试准备（synthetic test setup）：按 §3.1、§3.2 的格式写一条条目（detail 文件，并在索引末尾加一行）。
 * @param base 一层的目录
 * @param entry { kind, slug, abstract, source, day, evidence, details, history }
 */
export function seedEntry(base, entry) {
  const { kind, slug, abstract, source = 'user', day = localDay(), evidence = [], details = '', history = [] } = entry;
  mkdirSync(join(base, 'entries'), { recursive: true });
  const by = source === 'learned' ? 'Enhancement' : 'You';
  const front = ['---', `kind: ${kind}`, `abstract: ${JSON.stringify(abstract)}`, `source: ${source}`,
    `created: ${JSON.stringify(`${day} · ${by}`)}`, `modified: ${JSON.stringify(`${day} · ${by}`)}`,
    `evidence: ${JSON.stringify(evidence)}`, '---'];
  const block = (head, lines) => (lines.length ? `${head}\n${lines.join('\n')}` : head);
  const body = [block('## Evidence', evidence.map((item) => `- ${evidenceLine(item)}`)),
    block('## Details', details ? [details] : []), block('## Revisions', history.map((line) => `- ${line}`))];
  writeFileSync(detailPath(base, slug), `${front.join('\n')}\n${body.join('\n\n')}\n`);
  const index = join(base, KIND_FILE[kind]);
  if (!existsSync(index)) writeFileSync(index, `# ${KIND_LABEL[kind]}\n`);
  const text = abstract.replace(/[\\\]]/g, '\\$&');
  appendFileSync(index, `- [${text}](entries/${slug}.md)\n`);
}

/** @brief 索引里的条目行：[{ line, abstract（去掉转义）, slug }]。 */
export function readIndex(base, kind) {
  const text = fileText(join(base, KIND_FILE[kind])) ?? '';
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^- \[((?:\\.|[^\\\]])*)\]\(entries\/(.+)\.md\)$/.exec(line);
    return match ? [{ line, abstract: match[1].replace(/\\(.)/g, '$1'), slug: match[2] }] : [];
  });
}

/** @brief frontmatter 的字段：值能按 JSON 解析时取解析结果，否则取原文。 */
export function frontOf(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? '')?.[1] ?? '';
  const out = {};
  for (const line of head.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const raw = line.slice(at + 1).trim();
    try {
      out[line.slice(0, at).trim()] = JSON.parse(raw);
    } catch {
      out[line.slice(0, at).trim()] = raw;
    }
  }
  return out;
}

/** @brief 一个 detail 文件：{ text, front, history（`## Revisions` 的行）, details }；不存在时为 null。 */
export function readDetail(base, slug) {
  const text = fileText(detailPath(base, slug));
  if (text === null) return null;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const details = /## Details\n([\s\S]*?)\n*## Revisions/.exec(body)?.[1]?.trim() ?? '';
  const history = (body.split('## Revisions')[1] ?? '').split('\n').filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
  return { text, front: frontOf(text), history, details };
}

/** @brief 一层的修订 id（文件名），按名字排序（就是时间顺序，§3.3）。 */
export function revisionIds(base) {
  const dir = join(base, 'revisions');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3))
    .sort() : [];
}

/** @brief 一次修订的全文；不存在时为 null。 */
export const revisionText = (base, id) => fileText(join(base, 'revisions', `${id}.md`));

// ---------- 会话文件 ----------

/** @brief pi 会话文件的全部条目（读不出的行略过）。 */
export function sessionLines(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** @brief 消息内容的文字。 */
export const messageText = (message) => (typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map((part) => part.text ?? '').join(''));

/** @brief 你的消息：[{ id, text }]，按文件顺序。 */
export const userMessages = (lines) => lines.filter((entry) => entry.type === 'message'
  && entry.message?.role === 'user').map((entry) => ({ id: entry.id, text: messageText(entry.message) }));

/** @brief 助手消息：[{ id, text, calls: [{ id, name }] }]。 */
export const assistantMessages = (lines) => lines.filter((entry) => entry.type === 'message'
  && entry.message?.role === 'assistant').map((entry) => ({ id: entry.id, text: messageText(entry.message),
  calls: (entry.message.content ?? []).filter((part) => part.type === 'toolCall')
    .map((part) => ({ id: part.id, name: part.name })) }));

/** @brief 某个工具的结果：[{ id（条目 id）, toolCallId, details, isError, text }]，按文件顺序。 */
export const toolResults = (lines, name) => lines.filter((entry) => entry.type === 'message'
  && entry.message?.role === 'toolResult' && entry.message.toolName === name).map((entry) => ({ id: entry.id,
  toolCallId: entry.message.toolCallId, details: entry.message.details ?? null,
  isError: entry.message.isError === true, text: messageText(entry.message) }));

// ---------- 工具卡 ----------

/**
 * @brief 某个会话面板里的工具卡：[{ verb, target, status（data-status）, statusText, view（有没有 View in Memory）,
 *        viewDisabled, viewTitle, open（卡片是否展开） }]，按对话流顺序。
 */
export function cardsOf(page, tab) {
  return page.locator(`${paneSel(tab)} [data-testid="tool-card"]`).evaluateAll((cards) => cards.map((card) => {
    const title = card.querySelector('.tool-title')?.textContent ?? '';
    const verb = card.querySelector('.tool-verb')?.textContent ?? '';
    const view = card.querySelector('[data-testid="tool-memory-view"]');
    return { verb, target: title.slice(verb.length).trim(), status: card.dataset.status,
      statusText: card.querySelector('[data-testid="tool-status"]')?.textContent ?? '', view: Boolean(view),
      viewText: view?.textContent ?? null, viewDisabled: view?.disabled ?? null, viewTitle: view?.title ?? null,
      open: card.open };
  }));
}

/** @brief 展开第 index 张工具卡读 Output（最后一个 .tool-pre 的全文），再收起。 */
export async function cardOutput(page, tab, index) {
  const card = page.locator(`${paneSel(tab)} [data-testid="tool-card"]`).nth(index);
  await card.evaluate((el) => { el.open = true; });
  await card.locator('.tool-body').waitFor({ timeout: 5000 }).catch(() => {});
  const output = await card.evaluate((el) => {
    const labels = [...el.querySelectorAll('.tool-section-label')];
    const label = labels.find((item) => item.textContent === 'Output');
    return label?.nextElementSibling?.textContent ?? '';
  });
  await card.evaluate((el) => { el.open = false; });
  return output;
}

/** @brief 点第 index 张工具卡的 View in Memory。 */
export const clickCardView = (page, tab, index) => page.locator(`${paneSel(tab)} [data-testid="tool-card"]`)
  .nth(index).locator('[data-testid="tool-memory-view"]').click();

// ---------- 记忆页 ----------

/** @brief 记忆页此刻的样子（docs/v1/screens/memory-page.md 的标识）；不在记忆页时 page 为 false。 */
export function memView(page) {
  return page.evaluate(() => {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const pressed = (prefix) => [...document.querySelectorAll(`[data-testid^="${prefix}"]`)]
      .find((el) => el.getAttribute('aria-pressed') === 'true')?.dataset.testid.slice(prefix.length) ?? null;
    const detail = document.querySelector('[data-testid="memory-detail"]');
    const evidence = detail ? [...detail.querySelectorAll('.memory-evidence-item')].map((li) => {
      const jump = li.querySelector('[data-testid="memory-jump"]');
      return { line: text(li.querySelector('.memory-evidence-line')), jump: text(jump), disabled: jump?.disabled,
        hover: jump?.title || null, status: text(li.querySelector('[data-testid="memory-jump-status"]')) };
    }) : [];
    const rows = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)].map((el) => ({ id: el.dataset.id,
      source: el.dataset.source ?? null, title: text(el.querySelector('.memory-row-title')),
      tag: text(el.querySelector('.memory-tag')), pressed: el.getAttribute('aria-pressed') === 'true' }));
    return {
      page: Boolean(document.querySelector('[data-testid="memory-page"]')), scope: pressed('memory-scope-'),
      section: pressed('memory-section-'), rows: rows('memory-row'), revisions: rows('revision-row'),
      broken: [...document.querySelectorAll('[data-testid="memory-broken"]')].map((el) => ({ name: el.dataset.name,
        title: text(el.querySelector('.memory-row-title')), error: text(el.querySelector('.memory-row-error')) })),
      links: [...(detail?.querySelectorAll('.memory-details .memory-link') ?? [])].map(text),
      loadError: text(document.querySelector('[data-testid="memory-page"] .memory-load-error')),
      empty: text(document.querySelector('[data-testid="memory-page"] .memory-state')),
      detail: Boolean(detail), entryTitle: text(detail?.querySelector('.memory-entry .memory-detail-title')),
      entryMeta: text(detail?.querySelector('.memory-entry .memory-detail-meta')),
      revisionTitle: text(detail?.querySelector('[data-testid="revision-detail"] .memory-detail-title')),
      evidence, enhanceStatus: text(document.querySelector('[data-testid="enhance-status"]')),
      enhanceError: text(document.querySelector('[data-testid="enhance-error"]')),
      switchChecked: document.querySelector('[data-testid="enhance-switch"]')?.getAttribute('aria-checked') ?? null,
    };
  });
}

/** @brief 等记忆页的样子满足 test（最多 timeout）；返回最后一次读到的样子。 */
export async function waitMem(page, test, timeout = 15000) {
  let last = null;
  await poll(async () => {
    last = await memView(page);
    return test(last);
  }, timeout, 100);
  return last;
}

/** @brief 点左栏 Memory，等记忆页出现。 */
export async function openMemoryPage(page) {
  await page.getByTestId('nav-memory').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 15000 });
}

/** @brief 记忆页顶栏的 Back to app，等记忆页消失。 */
export async function backToApp(page) {
  await page.getByTestId('memory-page').getByRole('button', { name: 'Back to app' }).click();
  await page.getByTestId('memory-page').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 换层（User / Project），等它按下。 */
export async function memScope(page, layer) {
  const button = page.getByTestId(`memory-scope-${layer}`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await waitMem(page, (view) => view.scope === layer, 10000);
}

/** @brief 换分节（facts、taste、…、revisions），等它按下并读完（列表、空、读取失败之一）。 */
export async function memSection(page, id) {
  const button = page.getByTestId(`memory-section-${id}`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.waitForFunction((want) => {
    const on = document.querySelector(`[data-testid="memory-section-${want}"]`)?.getAttribute('aria-pressed');
    const root = document.querySelector('[data-testid="memory-page"] .memory-inner');
    const loading = root?.querySelector('.memory-state[role="status"]');
    return on === 'true' && root && !loading;
  }, id, { timeout: 15000 });
}

/** @brief 选中一行条目，等右栏的标题出现。 */
export async function memSelect(page, id) {
  await page.locator(`[data-testid="memory-row"][data-id="${id}"]`).click();
  await waitMem(page, (view) => view.rows.some((row) => row.id === id && row.pressed) && view.entryTitle !== null);
}

/** @brief 记忆页里第 index 项依据的 Jump to source。 */
export const jumpButton = (page, index = 0) => page.locator('[data-testid="memory-detail"] [data-testid="memory-jump"]')
  .nth(index);

/** @brief 会话面板里被高亮的对话流条目（.jump-flash）：[{ item（data-item）, text（前 200 字） }]。 */
export function flashedItems(page) {
  return page.evaluate(() => [...document.querySelectorAll('.pane-slot:not([hidden]) .jump-flash')]
    .map((el) => ({ item: el.dataset.item ?? null, text: el.textContent.replace(/\s+/g, ' ').slice(0, 200) })));
}

/** @brief 等出现高亮（最多 timeout）；返回 flashedItems 的结果（没有时为空数组）。 */
export async function waitFlash(page, timeout = 10000) {
  let items = [];
  await poll(async () => {
    items = await flashedItems(page);
    return items.length > 0;
  }, timeout, 50);
  return items;
}

/** @brief 侧栏里高亮的会话行的会话文件；没有时为 null。 */
export const activeFile = (page) => page.evaluate(() => document.querySelector('.session-item.active')
  ?.getAttribute('data-file') ?? null);

/** @brief 侧栏里某个会话行显示的名字。 */
export const rowLabel = (page, file) => page.locator(`.session-item[data-file=${JSON.stringify(file)}] .session-label`)
  .first().textContent({ timeout: 5000 }).catch(() => null);

// ---------- 独占地打开文件 ----------

const kernel32 = koffi.load('kernel32.dll');
const CreateFileW = kernel32.func(
  'void* __stdcall CreateFileW(str16, uint32_t, uint32_t, void*, uint32_t, uint32_t, void*)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)');

/**
 * @brief 独占地打开 file（共享方式为 0）：别的进程打开它都失败（EBUSY），后台进程读这个会话文件时出错。返回放开它的函数。
 */
export function lockFile(file) {
  const handle = CreateFileW(file, 0x80000000, 0, null, 3, 0x80, null);
  const address = handle ? koffi.address(handle) : 0n;
  if (address === 0n || address === 0xFFFFFFFFFFFFFFFFn) throw new Error(`cannot lock ${file}`);
  return () => CloseHandle(handle);
}
