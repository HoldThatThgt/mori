// M4 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的会话（tests/fixtures/m4）。
// 测试像你一样操作（打开文件夹、发消息、Alt+1、点工具卡里的路径、在阅读器里选行、浮层的"Attach as context"和"Feedback"、
// 回复下的"Attach message as context"、点发出的引用），回放桥核对界面发出的每条命令都与录制时一致——带引用的消息连全文和 refs
// 一起比较；文件阅读器读到的内容是录制时主进程真的读到的。再按 docs/v0/screens/changes.md 与 selection.md 检查界面。
// M1–M3 的回放检查仍由 m1-replay、m2-replay、m3-replay 负责。
// 用法（在 app/ 下）：node tests/ui/m4-replay.mjs [--only edit-two,quote-file]
// 结果写到 test-results/m4-replay.json；截图在 test-results/m4-replay/。

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  changeList, composerChips, dragSelect, expandChange, FEEDBACK_NOTE_OFF, feedbackNote, jumpHighlight,
  lastReplyHasActions, PANE, popoverShown, replyActionRows, selectLines, sentQuotes, viewerState, viewSource,
  waitViewer,
} from './m4-helpers.mjs';
import { pageHelpers } from './page.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-m4');
const fixtureDir = join(appRoot, 'tests/fixtures/m4');
const shots = join(appRoot, 'test-results/m4-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** @brief 读取一个 M4 录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
/** @brief 录制里界面发出的命令（只读查询除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (fx) => fx.steps.filter((s) => s.command
  && !['session.state', 'session.list', 'trust.check'].includes(s.command.type)).map((s) => s.command);
/** @brief 录制里的你的消息（按顺序），带引用的那条去掉引用块，只留你写的字。 */
function promptsOf(fx) {
  return commandsOf(fx).filter((c) => c.type === 'session.prompt').map((c) => ({ text: c.text, refs: c.refs ?? null,
    own: c.refs ? c.text.split('\n\n').at(-1) : c.text }));
}
/** @brief 录制里的读文件结果（按顺序）。 */
const readsOf = (fx) => fx.steps.filter((s) => s.file).map((s) => s.file);

/** @brief 构建回放页面（与 m1–m3 回放用不同的输出目录）。 */
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

/** @brief 等当前会话空闲：本轮结束。 */
function untilIdle(page, timeout = 90000) {
  return page.waitForFunction((p) => {
    const pane = document.querySelector(p);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false';
  }, PANE, { timeout });
}

/** @brief 测试用的页面操作。 */
function helpers(page) {
  return {
    ...pageHelpers(page),
    /** @brief 载入录制文件，等侧栏读完会话列表。 */
    async load(name, { speed = 4, maxGap = 600, keepDrafts = false } = {}) {
      const fx = readFixture(name);
      const url = `${pathToFileURL(join(outDir, 'index.html')).href}?fixture=${name}&speed=${speed}&maxGap=${maxGap}`
        + (keepDrafts ? '&keepDrafts=1' : '');
      await page.goto(url);
      await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
      return fx;
    },
    /** @brief 点"Open folder…"（回放桥返回下一条 session.create 的文件夹），等会话就绪。 */
    async openFolder() {
      await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
      await page.waitForFunction((p) => document.querySelector(p)
        && !document.querySelector(`${p} [data-testid="not-ready"]`), PANE, { timeout: 30000 });
    },
    /** @brief 发一条消息；每出一张批准卡按 Alt+1；等本轮结束。 */
    async sendApproving(text) {
      await this.send(text);
      await page.waitForFunction((p) => document.querySelector(p)?.dataset.running === 'true', PANE,
        { timeout: 20000 }).catch(() => {});
      while (await page.locator(PANE).getAttribute('data-running') === 'true') {
        if (await page.locator(`${PANE} [data-testid="approval-card"]`).count() > 0) await this.textarea.press('Alt+1');
        await sleep(150);
      }
      await untilIdle(page);
    },
    status: () => page.evaluate(() => window.__replay.status),
  };
}

/** @brief 收尾：回放桥没有不一致，录制里的命令全部用上了。 */
async function finish(page, name, fx) {
  const total = commandsOf(fx).length;
  await untilBridge(page, 'played', total, `all ${total} commands of ${name}`);
  const status = await page.evaluate(() => window.__replay.status);
  record(`${name}：界面发出的命令与录制一致（${total} 条，带引用的消息连全文和 refs），没有多发或少发`,
    status.errors.length === 0 && status.cursor === total, status.errors.join('; '));
}

/** @brief 当前会话里标题以 verb 开头、对象含 target 的工具卡（最后一张）。 */
const toolCard = (page, verb, target) => page.locator(`${PANE} [data-testid="tool-card"]`)
  .filter({ has: page.locator('.tool-verb', { hasText: verb }) })
  .filter({ has: page.locator('.tool-target', { hasText: target }) }).last();

/** @brief 点工具卡标题里的路径，等阅读器读完；Markdown 文件默认是预览（2026-10-26），切到"View source"再按行看。 */
async function openFromCard(page, verb, target) {
  await toolCard(page, verb, target).getByTestId('tool-path').click();
  await waitViewer(page);
  await viewSource(page);
  return viewerState(page);
}

// ---------- 场景 ----------

/** @brief 走查 1：改两个文件：右栏列出两个文件，展开有 diff，顶部注明命令改动不在此列；点路径打开阅读器。 */
async function editTwo(page, h) {
  const fx = await h.load('edit-two');
  await h.openFolder();
  await h.sendApproving(promptsOf(fx)[0].text);
  for (const path of ['README.md', 'src/a.ts']) await expandChange(page, path);
  const list = await changeList(page);
  const files = list?.files.map((file) => file.path) ?? [];
  record('edit-two：右栏自动打开，列出改过的两个文件，顶部注明"只含编辑和写入，命令改动的文件不在此列。"',
    list?.note === 'Only edits and writes are listed. Files changed by commands aren’t included.'
    && files.includes('README.md') && files.includes('src/a.ts'),
    JSON.stringify(files));
  record('edit-two：展开后每次编辑显示 diff（第 1 次 · 修改）', list.files.every((file) => file.entries.length >= 1
    && file.entries[0].label === 'Change 1 · Edit' && file.entries.every((entry) => entry.diff.length > 0)),
  JSON.stringify(list.files.map((f) => [f.path, f.entries.map((e) => [e.label, e.diff.length])])));
  const card = toolCard(page, 'Edit', 'README.md');
  const viewer = await openFromCard(page, 'Edit', 'README.md');
  const recorded = readsOf(fx).find((read) => read.path === 'README.md')?.result;
  record('edit-two：点工具卡里的路径打开阅读器（录制时读到的内容），工具卡不展开', viewer?.path === 'README.md'
    && viewer.first[0] === recorded?.text.split('\n')[0] && !(await card.evaluate((el) => el.open)), JSON.stringify(viewer));
  const rows = await replyActionRows(page);
  record('edit-two：一轮里有多次工具调用，回复下的操作只有一行（在这一轮最后），一直显示', rows.length === 1
    && rows[0].latest && await lastReplyHasActions(page), JSON.stringify(rows));
  await shot(page, 'edit-two');
  await finish(page, 'edit-two', fx);
}

/** @brief 走查 2 后半：写入的文件打开阅读器；文件删掉后再点，显示"File not found"。 */
async function writeDelete(page, h) {
  const fx = await h.load('write-delete');
  await h.openFolder();
  await h.sendApproving(promptsOf(fx)[0].text);
  const first = await openFromCard(page, 'Write', 'notes.md');
  const second = await openFromCard(page, 'Write', 'notes.md');
  record('write-delete：点写入卡的路径打开阅读器，显示写入的内容', first?.first[0] === '# Notes'
    && first.first.join('\n').includes('Mori M4 walkthrough.'), JSON.stringify(first?.first));
  record('write-delete：文件删掉后再点，显示"文件已被删除或移动"', second?.state.startsWith('File not found')
    && second.lineCount === 0 && second.externalDisabled === true, JSON.stringify(second));
  await shot(page, 'write-delete');
  await finish(page, 'write-delete', fx);
}

/** @brief 在阅读器里选第 1–3 行，点"Attach as context"，写字发出；返回芯片。 */
async function quoteLines(page, h, own) {
  await selectLines(page, 1, 3);
  const shown = await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const chips = await composerChips(page);
  await h.textarea.fill(own);
  return { shown, chips };
}

/**
 * @brief 走查 3 前半：阅读器里选一段点"Attach as context"：带来源的芯片；发出的全文和 refs 与录制一致；
 *        消息上方显示引用。
 */
async function quoteFile(page, h) {
  const fx = await h.load('quote-file');
  const prompts = promptsOf(fx);
  await h.openFolder();
  await h.sendApproving(prompts[0].text);
  await openFromCard(page, 'Read', 'a.ts');
  const { shown, chips } = await quoteLines(page, h, prompts[1].own);
  record('quote-file：阅读器里选三行出浮层，"问 Mori"后输入框出现芯片"src/a.ts · 第 1–3 行"', shown && chips.length === 1
    && chips[0].label === 'src/a.ts · lines 1–3' && chips[0].title === prompts[1].refs[0].quote, JSON.stringify(chips));
  // synthetic：这一次发送直接失败（回放桥 failNext），放回输入框时芯片也回来；再发一次与录制一致。
  await page.evaluate(() => { window.__replay.failNext = 'Synthetic send failure'; });
  await h.textarea.press('Enter');
  await page.locator(`${PANE} [data-testid="error-card"]`)
    .getByRole('button', { name: 'Put your last message back in the message box' }).click({ timeout: 5000 });
  const restored = { text: await h.textarea.inputValue(), chips: await composerChips(page) };
  record('quote-file：发送时就失败，"把上一条消息放回输入框"放回你写的字和引用芯片（不是含引用块的全文）',
    restored.text === prompts[1].own && restored.chips.length === 1
    && restored.chips[0].label === 'src/a.ts · lines 1–3',
    JSON.stringify(restored));
  await h.textarea.press('Enter');
  await untilIdle(page);
  const quotes = await sentQuotes(page);
  const bubble = await page.locator(`${PANE} [data-testid="user-message"]`).last().innerText();
  record('quote-file：发出后你的消息上方显示引用（来源和原文），气泡里只有你写的字', quotes.length === 1
    && quotes[0].label === 'src/a.ts · lines 1–3' && quotes[0].text === prompts[1].refs[0].quote
    && bubble === prompts[1].own,
  JSON.stringify({ quotes, bubble }));
  await shot(page, 'quote-file');
  await finish(page, 'quote-file', fx);
}

/** @brief 走查 3 后半：重启后打开会话，引用来自会话记录里的 mori.ref；点它回到原位置（阅读器里那三行高亮）。 */
async function quoteFileReopen(page, h) {
  const fx = await h.load('quote-file-reopen');
  const opened = fx.steps.find((s) => s.result?.type === 'session.open').result.value;
  await page.locator('.session-item').first().click();
  await page.waitForFunction((p) => document.querySelector(p)
    && !document.querySelector(`${p} [data-testid="not-ready"]`), PANE, { timeout: 30000 });
  const quotes = await sentQuotes(page);
  await page.locator(`${PANE} [data-testid="sent-quote"]`).first().click();
  await waitViewer(page);
  await sleep(300);
  const viewer = await viewerState(page);
  const ref = opened.entries.find((e) => e.type === 'custom' && e.customType === 'mori.ref').data.refs[0];
  record('quote-file-reopen：重启后打开的会话里引用还在（会话记录的 mori.ref 条目）', quotes.length === 1
    && quotes[0].label === 'src/a.ts · lines 1–3' && quotes[0].text === ref.quote, JSON.stringify(quotes));
  record('quote-file-reopen：点引用回到原位置：右栏阅读器打开 src/a.ts，第 1–3 行高亮', viewer?.path === 'src/a.ts'
    && JSON.stringify(viewer.target) === '[1,2,3]' && !viewer.changed && quotes[0].status === null, JSON.stringify(viewer));
  await shot(page, 'quote-file-reopen');
  await finish(page, 'quote-file-reopen', fx);
}

/** @brief 反例：引用之后模型改了那几行；点引用：芯片保留当时的原文并提示"Source changed"，阅读器给出原文。 */
async function quoteChanged(page, h) {
  const fx = await h.load('quote-changed');
  const prompts = promptsOf(fx);
  await h.openFolder();
  await h.sendApproving(prompts[0].text);
  await openFromCard(page, 'Read', 'a.ts');
  await quoteLines(page, h, prompts[1].own);
  await h.textarea.press('Enter');
  await page.waitForFunction((p) => document.querySelector(p)?.dataset.running === 'true', PANE, { timeout: 20000 });
  while (await page.locator(PANE).getAttribute('data-running') === 'true') {
    if (await page.locator(`${PANE} [data-testid="approval-card"]`).count() > 0) await h.textarea.press('Alt+1');
    await sleep(150);
  }
  await untilIdle(page);
  await page.locator(`${PANE} [data-testid="sent-quote"]`).first().click();
  await waitViewer(page);
  await sleep(300);
  const quote = (await sentQuotes(page))[0];
  const viewer = await viewerState(page);
  record('反例 quote-changed：原文已变化时芯片保留当时的原文并提示"原文已变化"', quote?.status === 'Source changed'
    && quote.text === prompts[1].refs[0].quote, JSON.stringify(quote));
  record('quote-changed：阅读器顶部"原文已变化 · 引用时的原文："和原文，停在原来的行', viewer?.changed.startsWith(
    'Source changed · Attached text:') && viewer.changed.includes('export function add')
    && JSON.stringify(viewer.target) === '[1,2,3]' && viewer.first.join('\n').includes('plus'), JSON.stringify(viewer));
  await shot(page, 'quote-changed');
  await finish(page, 'quote-changed', fx);
}

/**
 * @brief 走查 5：不用鼠标，用回复下的"Attach message as context"引用整轮回复；发出的全文和 refs 与录制一致；
 *        点引用高亮整轮。
 */
async function quoteReply(page, h) {
  const fx = await h.load('quote-reply');
  const prompts = promptsOf(fx);
  await h.openFolder();
  await h.sendApproving(prompts[0].text);
  await page.locator(`${PANE} [data-testid="reply-actions"]`).last()
    .getByRole('button', { name: 'Attach message as context' }).focus();
  await page.keyboard.press('Enter');
  const chips = await composerChips(page);
  const focused = await page.evaluate(() => document.activeElement?.matches('.composer textarea'));
  record('quote-reply：Tab 到"引用到输入框"按 Enter：芯片"助手回复"（整轮正文），焦点到输入框', chips.length === 1
    && chips[0].label === 'Response' && chips[0].title === prompts[1].refs[0].quote && focused, JSON.stringify(chips));
  await page.keyboard.type(prompts[1].own);
  await page.keyboard.press('Enter');
  await untilIdle(page);
  await page.locator(`${PANE} .conversation`).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.locator(`${PANE} [data-testid="sent-quote"]`).first().click();
  await sleep(200);
  const lit = await jumpHighlight(page);
  record('quote-reply：点发出的整轮引用，滚回那一轮并高亮整轮回复', lit.flashed > 0, JSON.stringify(lit));
  await shot(page, 'quote-reply');
  await finish(page, 'quote-reply', fx);
}

/** @brief 走查 4：流式输出时选中一句话点"Feedback"：选区不被打断；提交后"Saved"，没有发出任何命令。保存失败保留文字。 */
async function streamFeedback(page, h) {
  const fx = await h.load('stream-feedback', { speed: 1, maxGap: 300 });
  await h.openFolder();
  await h.send(promptsOf(fx)[0].text);
  // 回复是"**春**"一行、一段正文……：等第一段正文写完（之后又有段落开始流入），选它开头的 12 个字；之后的字还在流入。
  await page.waitForFunction((p) => document.querySelectorAll(`${p} [data-testid="assistant"] p`).length >= 3, PANE,
    { timeout: 30000 });
  const sentence = await page.locator(`${PANE} [data-testid="assistant"] p`).nth(1).evaluate((el) => el.textContent
    .slice(0, 12));
  await dragSelect(page, `${PANE} [data-testid="assistant"] p`, sentence, 1);
  const shown = await popoverShown(page);
  await sleep(800);
  const kept = await page.evaluate(() => window.getSelection().toString());
  const running = await page.locator(PANE).getAttribute('data-running');
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const note = await feedbackNote(page);
  await page.evaluate(() => { window.__replay.feedback.error = 'Synthetic save failure'; });
  await page.getByTestId('feedback-input').pressSequentially('希望短一点', { delay: 50 });
  await page.getByTestId('feedback-form').getByRole('button', { name: 'Save' }).click();
  const error = await page.getByTestId('feedback-error').innerText({ timeout: 3000 }).catch(() => '');
  const typed = await page.getByTestId('feedback-input').inputValue();
  await page.evaluate(() => { window.__replay.feedback.error = null; });
  await page.getByTestId('feedback-form').getByRole('button', { name: 'Save' }).click();
  const saved = await page.getByTestId('feedback-saved').innerText({ timeout: 3000 }).catch(() => '');
  const status = await h.status();
  record('stream-feedback：生成中选中一句话，浮层出现，新流入的文字不清掉选区', shown && running === 'true'
    && kept === sentence && [...sentence].length === 12, JSON.stringify({ shown, running, kept }));
  record('stream-feedback：保存失败保留已输入的文字并显示原文；再记录后"已记录"（Saved，没有链接，记忆规格 §10.7）',
    error === 'Couldn’t save your feedback: Synthetic save failure' && typed === '希望短一点'
    && saved === 'Saved',
    JSON.stringify({ error, typed, saved }));
  const asked = status.queries.filter((query) => query.type === 'enhance.get');
  record('stream-feedback：底部说明是没开增强时的整段（记忆规格 §10.7：表单打开时问一次 enhance.get，录制里没有它，'
    + '回放桥合成关着的增强，synthetic）', note === FEEDBACK_NOTE_OFF && asked.length >= 1
    && asked.every((query) => typeof query.cwd === 'string'), JSON.stringify({ note, asked }));
  record('stream-feedback：反馈只交给主进程保存（原文、期望、回复的消息时间），没有发给后台进程任何命令',
    status.feedback.length === 1 && status.feedback[0].quote === sentence && status.feedback[0].expected === '希望短一点'
    && typeof status.feedback[0].source.time === 'number' && status.commands.length === 2, JSON.stringify({
      feedback: status.feedback, commands: status.commands.map((c) => c.type) }));
  await untilIdle(page);
  await shot(page, 'stream-feedback');
  await finish(page, 'stream-feedback', fx);
}

const checks = { 'edit-two': editTwo, 'write-delete': writeDelete, 'quote-file': quoteFile,
  'quote-file-reopen': quoteFileReopen, 'quote-changed': quoteChanged, 'quote-reply': quoteReply,
  'stream-feedback': streamFeedback };

await buildHarness();
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], env: { ...process.env,
  MORI_HARNESS_INDEX: join(outDir, 'index.html'), MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-m4-harness-')) } });
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
process.exitCode = write('m4-replay.json') ? 0 : 1;
