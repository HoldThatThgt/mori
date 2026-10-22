// M7 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的会话（tests/fixtures/m7）。
// 录制里有一次重启（{ restart: true }），每个录制分两段回放（?part=before|after，页面重新载入就是重启）：
// 重启前一段测试像你一样在界面里写下记录（发消息；回复下的"Give feedback"；回复里拖选一句点"Feedback"；阅读器里选第
// 5–6 行点"Feedback"；按 F8 保存报告并点"View in Review"），核对界面交给主进程保存的反馈与录制时逐字相同；重启后一段打开工作回顾，
// 读到的记录和截图是录制时主进程真的读到的，按 docs/v0/screens/review.md 检查一行摘要、详情和截图；回到原位置（整条回复、
// 回复里的一句、文件里的两行）时回放桥核对界面发出的命令与录制一致，再检查高亮和阅读器；review-changed 里指向会话里
// 不存在的回复的那份反馈（synthetic，见 m7-record.mjs 的 seed）点"Jump to source"后留在工作回顾、说明
// "This response is no longer in the session."，
// 不发 session.open。再次打开工作回顾时回放桥重复录下的最后一份记录；导出、打开文件夹、在资源管理器里选中没有录过，
// 回放桥只记下调用（导出的结果是 synthetic 的路径），这里只核对界面交出去的记录名。M1–M6 的回放检查仍由 m1–m6-replay 负责。
// 用法（在 app/ 下）：node tests/ui/m7-replay.mjs [--only reply-before,reply-after,changed-before,changed-after]
// 结果写到 test-results/m7-replay.json；截图在 test-results/m7-replay/。

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { activeFile, samePath, settle, titleOf, until, waitReady } from './m3-helpers.mjs';
import {
  assistantIndexWith, dragSelect, jumpHighlight, PANE, popoverShown, selectLines, viewerState, waitViewer,
} from './m4-helpers.mjs';
import {
  chooseTab, detailState, flashVisible, openReviewPage, pressedRow, records, reviewState, selectRow, shortOf,
  waitLoaded,
} from './m7-helpers.mjs';
import { pageHelpers } from './page.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-m7');
const fixtureDir = join(appRoot, 'tests/fixtures/m7');
const shots = join(appRoot, 'test-results/m7-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 回放桥当作只读查询回答、不占回放顺序的命令（与 harness/replay.js 的 QUERIES 相同） */
const QUERIES = ['session.state', 'session.list', 'trust.check', 'session.read', 'config.get', 'tools.get',
  'agents.get', 'session.commands', 'models.get', 'session.pickOptions'];
/** 回复不在了时详情里的说明（review.md "回到原位置"） */
const CHANGED = 'This response is no longer in the session.';
/** synthetic：回放桥给导出返回的第一个路径（harness/replay.js 的 reviewStubs） */
const EXPORT_FILE = 'C:\\replay\\export\\replay-1.md';

// ---------- 录制 ----------

/** @brief 读取一个 M7 录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));

/** @brief 录制里重启前（before）或重启后（after）的步骤（与 harness/replay.js 的 partOf 相同）。 */
function partOf(fx, part) {
  const at = fx.steps.findIndex((s) => s.restart);
  if (at < 0) throw new Error(`${fx.name} has no restart step`);
  return part === 'before' ? fx.steps.slice(0, at) : fx.steps.slice(at + 1);
}

/** @brief 一段里界面发出的命令（只读查询除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (steps) => steps.filter((s) => s.command && !QUERIES.includes(s.command.type)
  // 回放桥直接应答的 models.* 写命令也不占回放顺序（harness/replay.js）
  && !s.command.type.startsWith('models.')).map((s) => s.command);
/** @brief 一段里你发的第一条消息。 */
const promptOf = (steps) => commandsOf(steps).find((c) => c.type === 'session.prompt').text;
/** @brief 一段里交给主进程保存的反馈（record 和 result），按顺序。 */
const savesOf = (steps) => steps.filter((s) => s.feedback?.result).map((s) => s.feedback);
/** @brief 一段里主进程第一次读到的两类记录。 */
const reviewOf = (steps) => steps.find((s) => s.review?.result)?.review.result ?? null;
/** @brief 一段里某种命令的第一个成功结果。 */
const resultOf = (steps, type) => steps.find((s) => s.result?.type === type && !s.result.error)?.result.value;
/** @brief 录制里某个截图文件名的读取结果（data URL）。 */
const shotOf = (fx, name) => fx.steps.find((s) => s.shot?.name === name)?.shot.result ?? null;
/** @brief data URL 里 PNG 的宽度（IHDR 里的宽）。 */
const pngWidth = (url) => Buffer.from(url.split(',')[1], 'base64').readUInt32BE(16);
/** @brief 两个值的 JSON 相同（顺序也算）。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** @brief 按键名排序后的 JSON（界面和录制器拼对象时键的先后可能不同；同 harness/replay.js）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------- 一行摘要应有的样子（review.md "一行摘要"） ----------

/** @brief 原文的第一行：第一个非空行去掉首尾空白，超过 200 个字截断加"…"（同界面的 excerpt）。 */
function firstLine(text) {
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? '';
  return [...line].length > 200 ? `${[...line].slice(0, 200).join('')}…` : line;
}

/** @brief 反馈的范围："Selection in response" / "Whole response" / "<相对工作目录的路径> · lines a–b"。 */
function scopeOf({ source, session }) {
  if (source.kind === 'message') return source.scope === 'selection' ? 'Selection in response' : 'Whole response';
  const lines = source.startLine === source.endLine ? `line ${source.startLine}`
    : `lines ${source.startLine}–${source.endLine}`;
  return `${win32.relative(session.cwd, source.path).replace(/\\/g, '/')} · ${lines}`;
}

/** @brief 一份反馈的一行摘要；name 是侧栏里这个会话现在的名字。 */
function feedbackRow(item, name) {
  const scope = scopeOf(item.feedback);
  return { name: item.name, title: item.feedback.expected, quote: firstLine(item.feedback.quote),
    source: item.feedback.source.kind === 'message' ? `${name} · ${scope}` : scope, time: shortOf(item.time),
    tags: [] };
}

/** @brief 一份有截图的界面问题报告的一行摘要（不标"No screenshot"）。 */
const issueRow = (item) => ({ name: item.name, title: item.what, quote: null, source: null, time: shortOf(item.time),
  tags: [] });

// ---------- 页面 ----------

/** @brief 当前分节列表里每一行的几段文字：期望（或"What went wrong"）、原文的第一行、来源、时间、标签。 */
function rowParts(page) {
  return page.locator('[data-testid="review-row"]').evaluateAll((rows) => rows.map((row) => {
    const text = (css) => row.querySelector(css)?.textContent.trim() ?? null;
    return { name: row.dataset.name, title: text('.review-row-title'), quote: text('.review-row-quote'),
      source: text('.review-row-source'), time: text('.review-row-time'),
      tags: [...row.querySelectorAll('.review-tag')].map((tag) => tag.textContent.trim()) };
  }));
}

/** @brief 详情里截图的地址和原尺寸宽度；还没读完时为 null。 */
function detailShot(page) {
  return page.evaluate(() => {
    const img = document.querySelector('[data-testid="review-detail"] img[data-testid="detail-shot"]');
    return img?.complete && img.naturalWidth > 0 ? { src: img.src, natural: img.naturalWidth } : null;
  });
}

/** @brief 等中栏换回会话（工作回顾页消失、会话就绪）。 */
async function waitChat(page) {
  await page.getByTestId('review-page').waitFor({ state: 'detached', timeout: 20000 });
  await waitReady(page);
  await settle(page);
}

/** @brief 构建回放页面（与 m1–m6 回放用不同的输出目录）。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 等回放桥的 status[field] 不小于 value；出现不一致时立即报错。 */
async function untilBridge(page, field, value, what) {
  await page.waitForFunction(({ f, v }) => window.__replay.status[f] >= v || window.__replay.status.errors.length > 0,
    { f: field, v: value }, { timeout: 90000 }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 收尾：回放桥没有不一致，这一段录下的命令全部用上了（total 为界面应发出的命令数），没有多发。 */
async function finish(page, name, total) {
  await untilBridge(page, 'played', total, `all ${total} commands of ${name}`);
  const status = await page.evaluate(() => window.__replay.status);
  record(`${name}：界面发出的命令与录制一致（${total} 条），没有多发或少发`,
    status.errors.length === 0 && status.cursor === total && status.commands.length === total,
    status.errors.join('; ') || `commands ${status.commands.map((c) => c.type).join(', ')}`);
}

/** @brief 测试用的页面操作。 */
function helpers(page) {
  return {
    ...pageHelpers(page),
    /** @brief 载入录制文件的一段（重启前或重启后），等侧栏读完会话列表；返回录制和这一段的步骤。 */
    async load(name, part, { speed = 4, maxGap = 600 } = {}) {
      const fx = readFixture(name);
      const index = pathToFileURL(join(outDir, 'index.html')).href;
      await page.goto(`${index}?fixture=${name}&part=${part}&speed=${speed}&maxGap=${maxGap}`);
      await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
      return { fx, steps: partOf(fx, part) };
    },
    /** @brief 点"Open folder…"（回放桥返回下一条 session.create 的文件夹），等会话就绪。 */
    async openFolder() {
      await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
      await waitReady(page);
    },
    status: () => page.evaluate(() => window.__replay.status),
  };
}

// ---------- 重启前：在界面里写下记录 ----------

/** @brief 反馈表单出现后写 expected 点"Save"，等"Saved"，按 Esc 关掉表单；返回"Saved"那一行的文字。 */
async function submitFeedback(page, expected) {
  const form = page.getByTestId('feedback-form');
  await form.waitFor({ timeout: 5000 });
  await page.getByTestId('feedback-input').fill(expected);
  await form.getByRole('button', { name: 'Save' }).click();
  const saved = await page.getByTestId('feedback-saved').innerText({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'detached', timeout: 6000 });
  return saved.trim();
}

/** @brief 最后一轮回复下的"Give feedback"，写 expected 记录；返回"Saved"那一行的文字。 */
async function feedbackReply(page, expected) {
  await page.locator(`${PANE} [data-testid="reply-actions"]`).last().getByRole('button', { name: 'Give feedback' })
    .click();
  return submitFeedback(page, expected);
}

/** @brief 在回复里拖选录制时选的那一句，点浮层的"Feedback"并记录；返回浮层是否出现。 */
async function feedbackSelection(page, recorded) {
  const index = await assistantIndexWith(page, recorded.quote);
  await dragSelect(page, `${PANE} [data-testid="assistant"]`, recorded.quote, index);
  const shown = await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  await submitFeedback(page, recorded.expected);
  return shown;
}

/** @brief 点"Read"工具卡里的路径打开阅读器，选录制时的那几行，点浮层的"Feedback"并记录；返回浮层是否出现。 */
async function feedbackLines(page, recorded) {
  const card = page.locator(`${PANE} [data-testid="tool-card"]`)
    .filter({ has: page.locator('.tool-verb', { hasText: 'Read' }) }).last();
  await card.getByTestId('tool-path').click();
  await waitViewer(page);
  await selectLines(page, recorded.source.startLine, recorded.source.endLine);
  const shown = await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  await submitFeedback(page, recorded.expected);
  return shown;
}

/** @brief 按 F8，填录制时的"What went wrong""What you expected"后保存；检查交给主进程的报告和"Saved to"的路径。 */
async function saveReport(page, h, issue) {
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(issue.what);
  await dialog.getByTestId('issue-expect').fill(issue.expect);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = (await page.getByTestId('issue-saved').innerText({ timeout: 15000 })).trim();
  const reports = (await h.status()).issues;
  record('review-reply 重启前：F8 交给主进程的报告里"哪里不对""你期望什么"是录制时填的；"已保存到"后面是录制时主进程'
    + '保存的路径', reports.length === 1 && reports[0].what === issue.what && reports[0].expect === issue.expect
    && saved === `Saved to ${issue.result.file}`, JSON.stringify({ saved, reports: reports.length }));
}

/**
 * @brief F8 报告框里点"View in Review"：关闭报告框，打开"UI issues"并选中录制里的这一份；列表和详情是录制时主进程
 *        读到的记录，截图按报告里的文件名读（录制时读到的 PNG）。
 */
async function viewReport(page, h, fx, steps) {
  const { issue } = steps.find((s) => s.issue);
  const name = win32.basename(issue.result.file);
  const review = reviewOf(steps);
  const recorded = review.issues.find((item) => item.name === name);
  await page.getByTestId('issue-dialog').getByTestId('issue-open-review').click();
  await page.getByTestId('review-page').waitFor({ timeout: 10000 });
  await waitLoaded(page);
  await until(async () => (await pressedRow(page)) === name, 5000);
  const picture = await until(() => detailShot(page), 10000);
  const state = await reviewState(page);
  const detail = await detailState(page);
  const status = await h.status();
  await shot(page, 'reply-before-review');
  record('review-reply 重启前：点"在工作回顾中查看"关闭报告框，打开"界面问题"并选中录制里的这一份；详情里是录制时'
    + '读到的两段和截图', (await page.getByTestId('issue-dialog').count()) === 0 && state.tabs.issues.pressed
    && same(state.rows.map((row) => row.name), review.issues.map((item) => item.name)) && Boolean(recorded)
    && detail?.what === recorded.what && detail.expect === recorded.expect && picture?.src === shotOf(fx, recorded.shot)
    && status.reviewLists === 1 && same(status.reviewShots, [recorded.shot]),
  JSON.stringify({ rows: state.rows.map((row) => row.name), what: detail?.what, natural: picture?.natural,
    lists: status.reviewLists, shots: status.reviewShots }));
}

/** @brief review-reply 重启前：读 README 的一轮；三份反馈与录制时逐字相同；F8 报告与"View in Review"。 */
async function replyBefore(page, h) {
  const { fx, steps } = await h.load('review-reply', 'before');
  const saves = savesOf(steps);
  await h.openFolder();
  await h.send(promptOf(steps));
  await h.idle(90000);
  const saved = await feedbackReply(page, saves[0].record.expected);
  const picked = await feedbackSelection(page, saves[1].record);
  const lines = await feedbackLines(page, saves[2].record);
  const sent = (await h.status()).feedback;
  const view = (index) => JSON.stringify({ sent: sent[index], recorded: saves[index].record });
  record('review-reply 重启前："反馈这条回复"后"已记录 · 在工作回顾中查看"；交给主进程的反馈（整轮回复的原文、锚点的'
    + '条目 id 和消息时间、会话文件、工作目录、会话名）与录制时逐字相同', saved === 'Saved · View in Review'
    && canonical(sent[0]) === canonical(saves[0].record), view(0));
  record('review-reply 重启前：在回复里拖选录制时的那一句，浮层出现；"反馈"交给主进程的原文和锚点（那条助手回复）'
    + '与录制时相同', picked && canonical(sent[1]) === canonical(saves[1].record), view(1));
  record('review-reply 重启前：点工具卡里的 README.md 打开阅读器（录制时读到的内容），选第 5–6 行出浮层；"反馈"交给'
    + '主进程的原文、路径、内容哈希、行范围与录制时相同', lines && sent.length === 3
    && canonical(sent[2]) === canonical(saves[2].record), view(2));
  await shot(page, 'reply-before-feedback');
  await saveReport(page, h, steps.find((s) => s.issue).issue);
  await viewReport(page, h, fx, steps);
  await finish(page, 'review-reply 重启前', commandsOf(steps).length);
}

/** @brief review-changed 重启前：问 Markdown 的一轮；"Give feedback"交给主进程的反馈与录制时逐字相同。 */
async function changedBefore(page, h) {
  const { steps } = await h.load('review-changed', 'before');
  const [save] = savesOf(steps);
  await h.openFolder();
  await h.send(promptOf(steps));
  await h.idle(90000);
  await feedbackReply(page, save.record.expected);
  const sent = (await h.status()).feedback;
  record('review-changed 重启前："反馈这条回复"交给主进程的反馈（带 Markdown 记号的整轮原文、锚点、会话）与录制时'
    + '逐字相同', sent.length === 1 && canonical(sent[0]) === canonical(save.record),
  JSON.stringify({ sent, recorded: save.record }));
  await finish(page, 'review-changed 重启前', commandsOf(steps).length);
}

// ---------- 重启后：工作回顾 ----------

/** @brief "Feedback"一节：分节上未处理的条数；一行摘要按录制时读到的顺序（从新到旧）。 */
async function feedbackList(page, review, name) {
  const state = await reviewState(page);
  const rows = await rowParts(page);
  const counts = { feedback: review.feedback.length, issues: review.issues.length };
  const titles = review.feedback.map((item) => item.feedback.session.title);
  await shot(page, 'reply-after-feedback');
  record('review-reply 重启后：打开工作回顾（录制时主进程读到的记录），默认是"对内容的反馈"；分节上是未处理的条数'
    + `（"对内容的反馈，${counts.feedback} 条未处理"、"界面问题，${counts.issues} 条未处理"）`, state.tabs.feedback.pressed
    && state.tabs.feedback.label === `Feedback, ${counts.feedback} unresolved`
    && state.tabs.feedback.count === String(counts.feedback) && state.tabs.issues.count === String(counts.issues)
    && state.tabs.issues.label === `UI issues, ${counts.issues} unresolved`, JSON.stringify(state.tabs));
  record('一行摘要：按录制时读到的顺序（从新到旧），每行是期望、原文的第一行、来源（侧栏里的会话名 · 范围，或文件的'
    + '相对路径和行）、时间（MM-DD HH:mm）；会话名与反馈时记下的相同', same(rows, review.feedback.map((item) =>
    feedbackRow(item, name))) && titles.every((title) => title === name), JSON.stringify(rows));
}

/**
 * @brief "UI issues"一节：一行摘要；详情里的时间、两段原文、截图（录制时主进程读到的 PNG，只读一次）、可以展开的三节；
 *        "Show in Explorer"（没有录过：回放桥只记下调用）。
 */
async function issueDetail(page, h, steps) {
  const [item] = reviewOf(steps).issues;
  const { shot: recorded } = steps.find((s) => s.shot);
  await chooseTab(page, 'issues');
  const rows = await rowParts(page);
  const detail = await selectRow(page, item.name);
  const picture = await until(() => detailShot(page), 10000);
  const more = [detail.view, detail.actions, detail.versions].map((section) => section?.text ?? null);
  await shot(page, 'reply-after-issue');
  record('界面问题的一行摘要："哪里不对"、时间；有截图，不标"没有截图"', same(rows, [issueRow(item)]),
    JSON.stringify(rows));
  record('界面问题的详情：标题"界面问题"、完整时间、"哪里不对""你期望什么"全文；截图是录制时主进程读到的那张 PNG'
    + '（按报告里的截图文件名只读一次，原尺寸）；"当前界面""最近的操作""版本"是报告里的原文', detail.heading === 'UI issues'
    && detail.time === item.time && detail.what === item.what && detail.expect === item.expect
    && recorded.name === item.shot && picture?.src === recorded.result && picture.natural === pngWidth(recorded.result)
    && same((await h.status()).reviewShots, [item.shot]) && same(more, [item.view, item.actions, item.versions]),
  JSON.stringify({ heading: detail.heading, time: detail.time, natural: picture?.natural, more }));
  await page.getByTestId('detail-show-file').click();
  const shown = await until(async () => (await h.status()).recordShown, 5000);
  record('界面问题的详情里"打开所在文件夹"：把这一份（分节和文件名）交给主进程在资源管理器里选中',
    same(shown, [{ kind: 'issues', name: item.name }]), JSON.stringify(shown));
  await chooseTab(page, 'feedback');
}

/** @brief 回到原位置（整条回复，重启后会话没开着）：详情；读会话文件确认那条回复还在，像侧栏一样打开，高亮整轮。 */
async function jumpReply(page, h, item, name) {
  const { feedback } = item;
  const detail = await selectRow(page, item.name);
  record('整条回复的详情：完整时间；来源（会话名、"整条回复"、工作目录）；"你希望得到的结果""引用的原文"全文；'
    + '"回到原位置"可用', detail.time === item.time && [name, 'Whole response', feedback.session.cwd].every((text) =>
    detail.source?.includes(text)) && detail.expected === feedback.expected && detail.quote === feedback.quote
    && detail.jump?.text === 'Jump to source' && !detail.jump.disabled, JSON.stringify({ source: detail.source,
    jump: detail.jump }));
  await page.getByTestId('detail-jump').click();
  await waitChat(page);
  const flashed = await until(async () => (await jumpHighlight(page)).flashed > 0, 10000, 100);
  const view = { file: await activeFile(page), visible: await flashVisible(page) };
  const status = await h.status();
  const reads = status.queries.filter((query) => query.type === 'session.read');
  await shot(page, 'reply-after-jump-reply');
  record('回到原位置（整条回复，重启后会话没开着）：先读会话文件（录制的 session.read）确认那条回复还在，再像侧栏一样'
    + '打开（录制的 trust.check、session.open）；中栏换回这个会话，滚到那条回复并高亮整轮', Boolean(flashed)
    && view.visible && samePath(view.file, feedback.source.sessionFile) && reads.length === 1
    && reads[0].sessionFile === feedback.source.sessionFile && status.cursor === 1 && status.errors.length === 0,
  JSON.stringify({ ...view, reads: reads.length, cursor: status.cursor, errors: status.errors }));
}

/**
 * @brief 在侧栏点"Review"回来，选中的还是上一条；回到原位置（回复里的一句，会话已开着）：看对话流确认（不读会话文件、
 *        不发命令），中栏换回会话，高亮引用的那句话。
 */
async function jumpSelection(page, h, item, previous) {
  const before = await h.status();
  await openReviewPage(page);
  const kept = await pressedRow(page);
  await selectRow(page, item.name);
  await page.getByTestId('detail-jump').click();
  await waitChat(page);
  const lit = await until(async () => {
    const now = await jumpHighlight(page);
    return now.text ? now : null;
  }, 10000, 100);
  const after = await h.status();
  const reads = (status) => status.queries.filter((query) => query.type === 'session.read').length;
  await shot(page, 'reply-after-jump-selection');
  record('在侧栏点"工作回顾"回来，选中的还是上一条（整条回复）', kept === previous, String(kept));
  record('回到原位置（回复里的一句，会话已开着）：看对话流确认（不再读会话文件，不发命令）；中栏换回会话，高亮引用的'
    + '那句话', lit?.text === item.feedback.quote && samePath(await activeFile(page), item.feedback.source.sessionFile)
    && reads(after) === reads(before) && after.commands.length === before.commands.length,
  JSON.stringify({ lit, reads: reads(after), commands: after.commands.length }));
}

/** @brief 回到原位置（文件里的两行）：反馈时所在的会话，右栏阅读器打开文件（录制时读到的内容），高亮原来的行。 */
async function jumpFile(page, h, steps, item) {
  const { source } = item.feedback;
  const content = steps.find((s) => s.file).file.result;
  await openReviewPage(page);
  await selectRow(page, item.name);
  const before = await h.status();
  await page.getByTestId('detail-jump').click();
  await waitChat(page);
  await waitViewer(page).catch(() => {});
  await sleep(300);
  const viewer = await viewerState(page);
  const after = await h.status();
  const target = Array.from({ length: source.endLine - source.startLine + 1 }, (_, index) => source.startLine + index);
  await shot(page, 'reply-after-jump-file');
  record(`回到原位置（文件里的 ${scopeOf(item.feedback)}）：中栏是反馈时所在的会话，右栏阅读器打开它（读到的是录制时`
    + '主进程读到的内容），原来的行高亮，没有"原文已变化"；没有发命令', viewer?.path === 'README.md'
    && same(viewer.target, target) && !viewer.changed && viewer.first[0] === content.text.split('\n')[0]
    && after.reads.length === before.reads.length + 1 && samePath(after.reads.at(-1).path, source.path)
    && after.commands.length === before.commands.length, JSON.stringify(viewer));
}

/**
 * @brief 导出（没有录过，保存结果是 synthetic 的路径）：一条标为已处理后导出这一节，界面交给主进程的记录名按列表顺序、
 *        已处理的写在 handled 里；"Exported N records to <路径>"和它的"Show in Explorer"；工具行的"Open folder"。
 */
async function exportListed(page, h, review, name) {
  const names = review.feedback.map((item) => item.name);
  await openReviewPage(page);
  await selectRow(page, name);
  await page.getByTestId('detail-handled').click();
  await page.getByTestId('review-export').click();
  const notice = page.getByTestId('review-notice');
  const text = await notice.innerText({ timeout: 5000 }).catch(() => '');
  await notice.getByRole('button', { name: 'Show in Explorer' }).click();
  await page.getByTestId('review-open-folder').click();
  const status = await until(async () => {
    const now = await h.status();
    return now.folders.length > 0 ? now : null;
  }, 5000);
  await shot(page, 'reply-after-export');
  record('导出为 Markdown…（没有录过：回放桥只记下调用）：界面把这一节列出的记录名按列表顺序交给主进程，标了已处理的'
    + `那条写在 handled 里；工具行下面"已导出 ${names.length} 条到 <路径>"，"打开所在文件夹"选中它；"打开文件夹"打开`
    + '这一节的文件夹', canonical(status?.exports) === canonical([{ kind: 'feedback', names, handled: [name] }])
    && text.startsWith(`Exported ${records(names.length)} to ${EXPORT_FILE}`) && same(status.exportShown, [EXPORT_FILE])
    && same(status.folders, ['feedback']), JSON.stringify({ text, exports: status?.exports,
    shown: status?.exportShown, folders: status?.folders }));
}

/** @brief review-reply 重启后：两节列出录制时读到的记录；界面问题的详情和截图；三种回到原位置；导出。 */
async function replyAfter(page, h) {
  const { steps } = await h.load('review-reply', 'after');
  const review = reviewOf(steps);
  const name = titleOf(resultOf(steps, 'session.list')[0].firstMessage);
  const pick = (test) => review.feedback.find((item) => test(item.feedback.source));
  const reply = pick((source) => source.scope === 'reply');
  const selection = pick((source) => source.scope === 'selection');
  const file = pick((source) => source.kind === 'file');
  await openReviewPage(page);
  await feedbackList(page, review, name);
  await issueDetail(page, h, steps);
  await jumpReply(page, h, reply, name);
  await jumpSelection(page, h, selection, reply.name);
  await jumpFile(page, h, steps, file);
  await exportListed(page, h, review, file.name);
  await finish(page, 'review-reply 重启后', commandsOf(steps).length);
}

/**
 * @brief review-changed 重启后：列出两份反馈（synthetic 那份的会话名用侧栏现在的名字、带年份）；synthetic 那份回到原位置：
 *        读会话文件找不到那条回复，留在工作回顾、标"This response is no longer in the session."，不发 session.open。
 */
async function changedAfter(page, h) {
  const { fx, steps } = await h.load('review-changed', 'after');
  const review = reviewOf(steps);
  const item = review.feedback.find((entry) => entry.name === fx.steps.find((s) => s.seed).seed.name);
  const name = titleOf(resultOf(steps, 'session.list')[0].firstMessage);
  await openReviewPage(page);
  const rows = await rowParts(page);
  const seeded = rows.find((row) => row.name === item.name);
  record('review-changed 重启后：列出录制时读到的两份反馈（真的回复反馈在前，synthetic 记录在后）；synthetic 那份的'
    + '会话名用侧栏现在的名字（不是记录里的名字），不是今年的时间带年份', same(rows, review.feedback.map((entry) =>
    feedbackRow(entry, name))) && seeded?.source === `${name} · Whole response`
    && /^\d{4}-\d{2}-\d{2} /.test(seeded.time) && item.feedback.session.title !== name, JSON.stringify(rows));
  await selectRow(page, item.name);
  await page.getByTestId('detail-jump').click();
  await page.getByTestId('detail-jump-status').waitFor({ timeout: 10000 }).catch(() => {});
  await sleep(500);
  const detail = await detailState(page);
  const status = await h.status();
  const reads = status.queries.filter((query) => query.type === 'session.read');
  const view = { page: await page.getByTestId('review-page').count(), panes: await page.locator('.pane-slot').count() };
  await shot(page, 'changed-after');
  record('回复不在了（synthetic 记录，会话没开着）：读会话文件（录制的 session.read，当前分支上没有那条回复）后留在'
    + `工作回顾，详情里"${CHANGED}"，引用的原文仍在；不打开会话，不发 session.open`, detail?.jumpStatus === CHANGED
    && detail.quote === item.feedback.quote && view.page === 1 && view.panes === 0 && reads.length === 1
    && reads[0].sessionFile === item.feedback.source.sessionFile && status.commands.length === 0,
  JSON.stringify({ status: detail?.jumpStatus, view, reads: reads.length, commands: status.commands }));
  await finish(page, 'review-changed 重启后', commandsOf(steps).length);
}

const checks = { 'reply-before': replyBefore, 'reply-after': replyAfter, 'changed-before': changedBefore,
  'changed-after': changedAfter };

await buildHarness();
/** 回放窗口的临时数据目录：关掉窗口之后删掉 */
const harnessData = mkdtempSync(join(tmpdir(), 'mori-m7-harness-'));
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], env: { ...process.env,
  MORI_HARNESS_INDEX: join(outDir, 'index.html'), MORI_HARNESS_DATA: harnessData } });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const h = helpers(page);
try {
  for (const [name, check] of Object.entries(checks)) {
    if (only && !only.includes(name)) continue;
    try {
      await check(page, h);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 500));
      await shot(page, `${name}-error`);
    }
  }
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await app.close();
}
process.exitCode = write('m7-replay.json') ? 0 : 1;
try {
  rmSync(harnessData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
  console.error(`[m7-replay] cannot remove ${harnessData}: ${error.message}`);
}
