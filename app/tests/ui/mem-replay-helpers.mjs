// 记忆回放测试（tests/ui/mem-replay.mjs，docs/specs/memory.md §14.1 的回放层）共用的部分：规格里的文字（独立实现，
// 用录下的结果算出界面该显示的：§7.5 的工具卡标题、§10.1 的用量与计数、§10.4 的状态行、§10.6 的横幅，不从 src/ 引用）、
// 录制文件的读取（按回放桥的规则取一段的命令、按参数配对的只读查询的结果）、回放页面的构建与载入、页面里的读取
// （window.__memSnap）与记录器（window.__memWatch）、界面操作（Open folder…、New session、发消息、左栏 Memory、
// Back to app、F8 读 Recent activity）、等回放桥放完、收尾与页面错误的检查。检查结果由 mem-replay.mjs 记录（这里的
// record 是同一个收集器）。

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { appRoot, createRecorder, oneLine, sleep } from './lib.mjs';
import { PANE, rowOf, waitReady } from './m3-helpers.mjs';

export const harnessDir = join(appRoot, 'tests/ui/harness');
export const outDir = join(appRoot, 'test-results/harness-mem');
const shots = join(appRoot, 'test-results/mem-replay');
mkdirSync(shots, { recursive: true });
export const { record, write } = createRecorder('replay harness');
export const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

// ---------- 规格里的文字（独立实现，用录下的结果算出界面该显示的） ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const KIND = { fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };
export const TASKS = ['taste', 'strategy', 'review'];
const pad = (n) => String(n).padStart(2, '0');
/** @brief `YYYY-MM-DD` → `Oct 22`。 */
export const monthDay = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : day;
};
/** @brief 毫秒时刻 → 本地 `Oct 22 04:00`。 */
export const monthDayTime = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** @brief 毫秒时刻 → 本地日历日期。 */
export const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** @brief §10.4 的 token 写法。 */
export const formatTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k tokens`
  : n === 1 ? '1 token' : `${n} tokens`);
/** @brief §10.1、§10.5 的改动数：`Added 1, changed 2`，计数为 0 的不写，都为 0 时 `No changes`。 */
export function countsText(counts) {
  const parts = ['added', 'changed', 'deleted', 'moved'].filter((key) => counts[key])
    .map((key) => `${key} ${counts[key]}`);
  if (parts.length === 0) return 'No changes';
  const text = parts.join(', ');
  return text[0].toUpperCase() + text.slice(1);
}
/** 关着时的状态行（§10.4，临时） */
export const OFF_TEXT = 'Off · Each day, three background runs review this project’s sessions and improve its TASTE, '
  + 'STRATEGY, and REVIEW';

/** @brief §10.4 的状态行里“上次”的那一段（失败、全部跳过、成功、还没跑过）。 */
function lastPart(info, next) {
  const failed = TASKS.filter((task) => info.last[task]?.status === 'failed');
  if (failed.length > 0) {
    const latest = failed.reduce((a, b) => (Date.parse(info.last[b].at) > Date.parse(info.last[a].at) ? b : a));
    return `On · Last run failed (${failed.map((task) => KIND[task]).join(', ')}): ${info.last[latest].error}${next}`;
  }
  const lasts = TASKS.filter((task) => info.last[task]);
  if (lasts.length === 0) return `On${next}`;
  const day = lasts.map((task) => info.last[task].day).sort().at(-1);
  const ofDay = lasts.filter((task) => info.last[task].day === day);
  const at = Math.max(...ofDay.map((task) => Date.parse(info.last[task].at)));
  const head = `On · Last run ${monthDayTime(at)}`;
  if (ofDay.every((task) => info.last[task].status === 'skipped')) {
    return `${head} · No finished sessions to read${next}`;
  }
  const changed = ofDay.filter((task) => info.last[task].status === 'done' && info.last[task].counts
    && countsText(info.last[task].counts) !== 'No changes')
    .map((task) => `${KIND[task]}: ${countsText(info.last[task].counts).toLowerCase()}`);
  const tokens = ofDay.reduce((sum, task) => sum + info.last[task].tokens, 0);
  return `${head} · ${changed.length ? changed.join('; ') : 'No changes'} · ${formatTokens(tokens)}${next}`;
}

/** @brief §10.4 的状态行（按表的顺序取第一个符合的）。 */
export function statusText(info) {
  if (info.error !== null) return `Couldn’t read the enhancement settings: ${info.error}`;
  if (!info.enabled) return OFF_TEXT;
  if (info.pick === null) return 'On · Choose a model in enhancement settings';
  if (info.running) {
    return `Running ${KIND[info.running.task]} enhancement…${info.queued > 0 ? ` · ${info.queued} queued` : ''}`;
  }
  if (info.queued > 0) return `On · ${info.queued} queued · Waiting for another project’s enhancement`;
  return lastPart(info, info.next === null ? '' : ` · Next run ${monthDayTime(info.next)}`);
}

/** @brief §10.6 的横幅。 */
export function noticeText(notice) {
  const days = notice.from === notice.to ? monthDay(notice.from) : `${monthDay(notice.from)}–${monthDay(notice.to)}`;
  const kinds = TASKS.filter((task) => notice.counts[task] > 0).map((task) => `${KIND[task]} ${notice.counts[task]}`);
  return `Enhancement updated this project’s memory from the ${days} sessions: ${kinds.join(', ')}.`;
}

/** @brief §7.5 的工具卡标题（动词 · 目标）。 */
export function toolTitle(args) {
  if (args.action === 'update') return { verb: 'Update memory', target: args.entry };
  if (args.action === 'forget') return { verb: 'Delete from memory', target: args.entry };
  return { verb: `Save to ${KIND[args.kind] ?? 'memory'}`, target: args.abstract };
}

/** @brief 用量一行（§10.1）。 */
export const usageText = (usage, project) => `${usage.used} / ${usage.limit} tokens`
  + `${project ? ` · User ${usage.user} + this project ${usage.project}` : ''}`
  + `${usage.used > usage.limit ? ' · Over the limit' : ''}`;
/** @brief Last change 一项（§10.1）。 */
export const lastChangeText = (row) => `Last change ${monthDay(localDate(Date.parse(row.time)))} · `
  + countsText(row.counts);
/** @brief 详情的来历一行（§10.1）。 */
export function metaText(entry) {
  const who = (stamp) => ({ You: 'you', Mori: 'Mori', Enhancement: 'enhancement' })[stamp.split(' · ')[1]]
    ?? stamp.split(' · ')[1];
  return `${KIND[entry.kind]} · ${entry.layer === 'user' ? 'User' : 'Project'} · `
    + `${entry.source === 'user' ? 'You said' : 'Learned'} · Created ${monthDay(entry.created)} by `
    + `${who(entry.created)}`
    + ` · Modified ${monthDay(entry.modified)} by ${who(entry.modified)}`;
}

// ---------- 录制 ----------

/** @brief 回放桥当作只读查询回答的命令：从 harness/replay.js 的 QUERIES 读，保证与回放桥一致。 */
function harnessQueries() {
  const text = readFileSync(join(harnessDir, 'replay.js'), 'utf8');
  const match = /const QUERIES = \[([^\]]*)\]/.exec(text);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}
export const QUERIES = harnessQueries();

/** @brief 录制文件的路径。 */
export const fixturePath = (name) => join(appRoot, 'tests/fixtures/mem', `${name}.json`);
/** @brief 读一个录制文件。 */
export const readFixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));
/** 本机的时区（没有 timeZone 的录制按它回放） */
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** 页面 → 设时区用的 CDP 会话 */
const zones = new WeakMap();
/**
 * @brief 按录制时的时区回放：内核按录制那台机器的时区算增强的下次运行等时刻，界面再按本地时区显示，换了时区回放，
 *        状态行里的时刻就与录下的每日时间对不上。录制的 timeZone（mem-record.mjs 记下的 IANA 名）同时用于页面
 *        （CDP 的 Emulation.setTimezoneOverride）与本进程算期望文字的 Date（process.env.TZ）；没有 timeZone 的录制按本机时区。
 */
export async function useZone(page, fx) {
  const zone = fx.timeZone ?? HOST_ZONE;
  process.env.TZ = zone;
  // 覆盖随 CDP 会话存在，会话一直留着（每个页面一个）
  if (!zones.has(page)) zones.set(page, await page.context().newCDPSession(page));
  const cdp = zones.get(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: zone });
  return zone;
}
/** @brief 录制里重启前（before）或重启后（after）的步骤；part 为空时是全部（同 harness/replay.js 的 partOf）。 */
export function partOf(fx, part) {
  if (!part) return fx.steps;
  const at = fx.steps.findIndex((s) => s.restart);
  return part === 'before' ? fx.steps.slice(0, at) : fx.steps.slice(at + 1);
}
/** @brief 界面发出、占回放顺序的命令（只读查询与回放桥直接应答的 models.* 写命令除外）。 */
export const isUiCommand = (command) => !QUERIES.includes(command.type) && !command.type.startsWith('models.');
/** @brief 一段里界面发出的命令，下标与回放桥的 cursor 一致。 */
export const commandsOf = (steps) => steps.filter((s) => s.command && isUiCommand(s.command)).map((s) => s.command);
/** @brief 第 i 条命令的回放段在 steps 里的结束位置（下一条命令的位置）。 */
export function segmentEnd(steps, i) {
  const marks = steps.flatMap((s, index) => (s.command && isUiCommand(s.command) ? [index] : []));
  return marks[i + 1] ?? steps.length;
}
/** @brief 一段里的某种事件（可按会话筛），按顺序。 */
export const eventsOf = (steps, type, sessionId) => steps.filter((s) => s.envelope?.event.type === type
  && (sessionId === undefined || s.envelope.sessionId === sessionId)).map((s) => s.envelope.event);
/** @brief 一段里某种命令的结果（按顺序）。 */
export const resultsOf = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);

/**
 * @brief 录在第 end 步之前、参数与 key 相同的某种只读查询的最后一个结果（回放桥在这一段放完后给界面的就是它）；
 *        没有时为 undefined。key 里写 null 的字段要求命令没有它或为 null。
 */
export function recorded(steps, end, type, key) {
  let found;
  steps.slice(0, end).forEach((step, index) => {
    if (step.result?.type !== type || step.result.error) return;
    const asked = steps.slice(0, index).findLast((s) => s.command?.type === type)?.command;
    if (asked && Object.entries(key).every(([field, value]) => (asked[field] ?? null) === value)) {
      found = step.result.value;
    }
  });
  return found;
}

// ---------- 页面 ----------

/** @brief 构建回放页面（到 test-results/harness-mem，不碰 out/）。 */
export async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 载入录制文件（或它的一段），等侧栏读完会话列表，装上页面里的读取与记录器；返回这一段的步骤。 */
export async function load(page, fx, { part = null, speed = 4, maxGap = 600 } = {}) {
  const index = pathToFileURL(join(outDir, 'index.html')).href;
  await page.goto(`${index}?fixture=${fx.name}${part ? `&part=${part}` : ''}&speed=${speed}&maxGap=${maxGap}`);
  await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
  await page.evaluate(installSnapshot);
  await page.evaluate(installWatch);
  return partOf(fx, part);
}

/**
 * @brief 页面里的读取：window.__memSnap() 是记忆页此刻的样子（不在记忆页时为 null）；window.__memEnhance(块) 是
 *        增强一块的样子（状态行、开关、Run now、开关失败的一行）。
 */
function installSnapshot() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const all = (css, root = document) => [...root.querySelectorAll(css)];
  const pressed = (el) => el.getAttribute('aria-pressed') === 'true';
  const rows = (css) => all(css).map((el) => ({ id: el.dataset.id, source: el.dataset.source, pressed: pressed(el),
    title: text(el.querySelector('.memory-row-title')), meta: text(el.querySelector('.memory-row-meta')),
    tags: all('.memory-tag', el).map(text) }));
  const detailOf = (root) => (root ? { title: text(root.querySelector('.memory-detail-title')),
    meta: all('.memory-detail-meta', root).map(text), evidence: all('.memory-evidence-line', root).map(text),
    jumps: all('[data-testid="memory-jump"]', root).map(text), noEvidence: Boolean(all('.memory-muted', root)
      .find((el) => text(el) === 'No evidence recorded.')),
    details: text(root.querySelector('.memory-details')), links: all('.memory-link', root).map(text),
    backlinks: all('[data-testid="memory-backlinks"] li', root).map(text),
    history: all('.memory-history-lines li', root).map(text),
    historyRevisions: all('[data-testid="memory-history"] .memory-links li', root).map(text),
    actions: all('.memory-actions button', root).map(text), changes: all('.memory-change-title', root).map(text),
    notes: all('.memory-change-note', root).map(text), error: text(root.querySelector('[data-testid="memory-error"]')),
    form: Boolean(root.querySelector('[data-testid="memory-form"]')),
    revision: Boolean(root.querySelector('[data-testid="revision-detail"]')) } : null);
  window.__memEnhance = (root) => (root ? { status: text(root.querySelector('[data-testid="enhance-status"]')),
    checked: root.querySelector('[data-testid="enhance-switch"]')?.getAttribute('aria-checked'),
    switchDisabled: root.querySelector('[data-testid="enhance-switch"]')?.disabled,
    runDisabled: root.querySelector('[data-testid="enhance-run"]')?.disabled,
    error: text(root.querySelector('[data-testid="enhance-error"]')) } : null);
  window.__memSnap = () => {
    const pageEl = document.querySelector('[data-testid="memory-page"]');
    if (!pageEl) return null;
    return { scope: all('[data-testid^="memory-scope-"]').find(pressed)?.dataset.testid ?? null,
      section: all('[data-testid^="memory-section-"]').find(pressed)?.dataset.testid ?? null,
      sections: all('[data-testid^="memory-section-"]').map(text), folder: text(pageEl.querySelector('.memory-folder')),
      header: text(pageEl.querySelector('.topbar')), usage: text(pageEl.querySelector('[data-testid="memory-usage"]')),
      last: text(pageEl.querySelector('[data-testid="memory-last-change"]')),
      rows: rows('[data-testid="memory-row"]'), revisions: rows('[data-testid="revision-row"]'),
      state: text(pageEl.querySelector('.memory-content .memory-state')),
      detail: detailOf(document.querySelector('[data-testid="memory-detail"]')),
      enhance: window.__memEnhance(pageEl.querySelector('[data-testid="memory-enhance"]')) };
  };
}

/**
 * @brief 页面里的记录器（window.__memWatch，在 installSnapshot 之后装）：MutationObserver 记下增强一块（状态行、开关、
 *        Run now）的每次变化、反馈表单说明的每次变化、Revisions 行上出现过的标记、批准卡与放行标签最多几个。
 */
function installWatch() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const all = (css) => [...document.querySelectorAll(css)];
  const seen = { statuses: [], notes: [], tags: [], approvals: 0, badges: 0 };
  const last = new Map();
  const push = (list, key, item) => {
    const value = JSON.stringify(item);
    if (last.get(key) === value) return;
    last.set(key, value);
    list.push(item);
  };
  const scan = () => {
    const block = window.__memEnhance(document.querySelector('[data-testid="memory-enhance"]'));
    if (block) push(seen.statuses, 'status', block);
    const note = document.querySelector('[data-testid="feedback-note"]');
    if (note) push(seen.notes, 'note', text(note));
    for (const tag of all('[data-testid="revision-row"] .memory-tag').map(text)) {
      if (!seen.tags.includes(tag)) seen.tags.push(tag);
    }
    seen.approvals = Math.max(seen.approvals, all('[data-testid="approval-card"]').length);
    seen.badges = Math.max(seen.badges, all('[data-testid="tool-badge"]').length);
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
    characterData: true });
  scan();
  window.__memWatch = seen;
}

/** @brief 记忆页此刻的样子；不在记忆页时为 null。 */
export const snap = (page) => page.evaluate(() => window.__memSnap());
/** @brief 记录器记下的内容。 */
export const watched = (page) => page.evaluate(() => window.__memWatch);
/** @brief 回放桥的状态。 */
export const replayStatus = (page) => page.evaluate(() => window.__replay.status);

/** @brief 等记忆页的样子满足 pred；等不到时返回最后一次的样子（检查会因此失败）。 */
export async function until(page, pred, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value = await snap(page);
  while (!(value && pred(value)) && Date.now() < deadline) {
    await sleep(100);
    value = await snap(page);
  }
  return value;
}

/** @brief 等回放桥放完 total 段；出现不一致时立即报错。 */
export async function untilPlayed(page, total, what, timeout = 120000) {
  await page.waitForFunction((v) => window.__replay.status.played >= v || window.__replay.status.errors.length > 0,
    total, { timeout }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 收尾：回放桥没有不一致，这一段录制里的命令全部用上了。 */
export async function finish(page, id, label, steps) {
  const total = commandsOf(steps).length;
  await untilPlayed(page, total, `all ${total} commands of ${label}`).catch(() => {});
  const status = await replayStatus(page);
  record(`${id} replay ${label}: the commands the UI sent match the recording (${total}), none extra or missing`,
    status.errors.length === 0 && status.cursor === total && status.commands.length === total,
    status.errors.join('; ') || `commands ${status.commands.map((c) => c.type).join(', ')}`);
}

/** @brief 当前一栏空闲（不在生成、不在发送）。 */
export const waitIdle = (page) => page.waitForFunction((pane) => {
  const el = document.querySelector(pane);
  return el && el.dataset.running === 'false' && el.dataset.sending === 'false';
}, PANE, { timeout: 30000 });

/** @brief 点侧栏"Open folder…"（回放桥返回下一条 session.create 的文件夹），等新会话就绪。 */
export async function openFolder(page) {
  const before = await page.locator('.pane-slot').count();
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, before, { timeout: 20000 });
  await waitReady(page);
}

/** @brief 点左栏"New session"（在当前会话的项目里新建），等新会话就绪。 */
export async function newSession(page) {
  const before = await page.locator('.pane-slot').count();
  await page.getByTestId('new-session').click();
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, before, { timeout: 20000 });
  await waitReady(page);
}

/** @brief 在当前一栏的输入框里写字按 Enter。 */
export async function typeAndSend(page, text) {
  const box = page.locator(`${PANE} .composer textarea`);
  await box.fill(text);
  await box.press('Enter');
}

/** @brief 等第 i 条命令之前的段放完、对话空闲，发这条消息，等它这一段放完、对话空闲。 */
export async function sendRecorded(page, commands, i) {
  await untilPlayed(page, i, `the segment before command ${i}`);
  await waitIdle(page);
  await typeAndSend(page, commands[i].text);
  await untilPlayed(page, i + 1, `the reply to command ${i}`);
  await waitIdle(page);
}

/** @brief 左栏 Memory。 */
export async function openMemory(page) {
  await page.getByTestId('nav-memory').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 10000 });
}

/** @brief 记忆页顶栏的 Back to app。 */
export async function backToApp(page) {
  await page.getByTestId('memory-page').getByRole('button', { name: 'Back to app' }).click();
  await page.locator(PANE).waitFor({ timeout: 10000 });
}

/** @brief 点记忆页的一个控件（data-testid），可带 data-id。 */
export const click = (page, testId, id) => page.locator(id === undefined ? `[data-testid="${testId}"]`
  : `[data-testid="${testId}"][data-id="${id}"]`).first().click();

// ---------- F8 的 Recent activity（§8 的动作记录） ----------

/** Recent activity 保留的条数（docs/v0/defaults.md：30 条）；读到这么多时更早的可能已经挤掉 */
export const ACTIVITY_LINES = 30;
/** §8 动作记录里记忆的界面操作与不带工作目录的写命令的文字 */
const MEMORY_ACTIONS = ['Open Memory', 'Memory: User', 'Memory: Project', 'Memory: Facts', 'Memory: TASTE',
  'Memory: STRATEGY', 'Memory: REVIEW', 'Memory: AGENT', 'Memory: Revisions', 'View in Memory',
  'Dismiss memory notice', 'Jump to source from Memory', 'Save memory entry', 'Edit memory entry',
  'Delete memory entry', 'Move to user level', 'Move to this project', 'Roll back revision'];
/** §8 动作记录里增强命令的文字开头（后面是工作目录） */
const ENHANCE_ACTIONS = ['Turn on enhancement ', 'Turn off enhancement ', 'Save enhancement settings ',
  'Run enhancement now '];

/**
 * @brief Recent activity 里记忆与增强的那些行（§8），按先后。
 * @param sends 为真时发送的消息（"Send: …"）也留下，记作 Send（看 View in Memory 在哪条消息之后）
 */
export function memoryLines(texts, sends = false) {
  return texts.flatMap((text) => {
    if (sends && text.startsWith('Send: ')) return ['Send'];
    return MEMORY_ACTIONS.includes(text) || ENHANCE_ACTIONS.some((head) => text.startsWith(head)) ? [text] : [];
  });
}

/**
 * 这些段落里 Recent activity 还会有的行的开头（docs/v0/ui-strings.md 的操作记录）：新建、打开、切换会话，记忆页的
 * Back to app，发送消息，F8 本身
 */
const SESSION_ACTIONS = ['New session', 'Open session', 'Switch session', 'Back to app', 'Send: ',
  'Report a UI issue'];

/** @brief Recent activity 里既不是记忆与增强（§8）也不是 SESSION_ACTIONS 的行；只读查询被记下时会出现在这里。 */
export const strayLines = (texts) => texts.filter((text) => memoryLines([text]).length === 0
  && !SESSION_ACTIONS.some((head) => text.startsWith(head)));

/**
 * @brief 像你一样按 F8 报告一次界面问题，读这份报告的 Recent activity（去掉时刻的动作文字，从早到晚），然后 Close。
 *        报告框本身不显示最近的操作，只有保存的报告里有（main/feedback.ts 写出的 Recent activity 一节就是它）；回放桥的
 *        saveIssue 只把报告记在 status.issues（不写文件、不经过后台进程、不占回放顺序），这一段之后的回放不受影响。
 * @param what 写进 What went wrong 的一句（synthetic）
 */
export async function recentActivity(page, what) {
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-what').waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(`Synthetic: ${what}`);
  const count = await page.evaluate(() => window.__replay.status.issues.length);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByTestId('issue-saved').waitFor({ timeout: 15000 });
  const report = await page.evaluate((n) => window.__replay.status.issues[n] ?? null, count);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  return (report?.actions ?? []).map((action) => action.text);
}

/** @brief 跑一组检查；出错时记一条失败；之后记这一组的页面错误（allowed 里的模式除外）。 */
export async function guarded(page, errors, { id, label, allowed = [] }, run) {
  const before = errors.length;
  try {
    await run();
  } catch (error) {
    record(`${id} replay ${label}: flow`, false, oneLine(error?.stack ?? error, 800));
    await shot(page, `${label}-error`);
  }
  const mine = errors.slice(before).filter((text) => !allowed.some((pattern) => pattern.test(text)));
  record(`${id} replay ${label}: the page has no errors${allowed.length ? ' (besides the expected ones)' : ''}`,
    mine.length === 0, mine.slice(0, 5).join(' | '));
}

