// M4 真实端点走查（方案第 7 节 M4 走查 1–5 与反例），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 状态表见 docs/v0/screens/changes.md 与 selection.md。脚本不接触 key：只把走查数据目录里 Mori 加密保存的密文
// （credentials.json 与 Local State）复制到临时目录，整个走查（包括重启）都用这一个复制出来的数据目录。
// 像负责人一样操作界面：发消息、Alt+1 批准编辑和写入、点工具卡里的路径、在阅读器里用鼠标拖选、浮层的"Attach as context"
// 和"Feedback"、回复下的"Attach message as context"（键盘）、点引用；"重启"是托盘菜单的"Exit"（Mori 有序退出）再用同一个数据目录启动。
// 系统的选文件夹对话框经 app.evaluate 换成直接返回测试文件夹。删文件只删测试项目里模型写的文件。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m4-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,3,4,5,c]
// 结果写到 test-results/m4-real(-packaged).json，截图在 test-results/m4-real(-packaged)/。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  allowRealProject, appRoot, arg, createRecorder, launch, oneLine, realProviders, scratchUserData, sleep,
} from './lib.mjs';
import { activeFile, openRow, paneOf, stubFolder, waitIdle, waitReady } from './m3-helpers.mjs';
import {
  changeList, composerChips, dragSelect, expandChange, FEEDBACK_NOTE_OFF, feedbackNote, jumpHighlight, messageCounts,
  PANE, popoverShown, replyActionRows, savedFeedback, selectLines, sentQuotes, sessionEntries, viewerState, waitViewer,
  viewSource,
} from './m4-helpers.mjs';
import { pageHelpers } from './page.mjs';
import { exitFromTray } from './tray-helpers.mjs';

const source = arg('source');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/m4-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const wanted = (item) => !only || only.includes(String(item));

const PROMPTS = {
  edit: '请用 edit 工具做两处修改：1. 把 README.md 第一行改成 "# Mori M4 walkthrough"；'
    + '2. 在 src/a.ts 末尾加一个函数 export function sub(a: number, b: number): number { return a - b; }。'
    + '不要运行命令，改完用一句话告诉我。',
  write: '请用 write 工具新建 docs/notes.md，内容是三行：第一行 "# Notes"，第二行空行，第三行 "Mori M4 walkthrough."。'
    + '不要运行命令，写完用一句话告诉我。',
  askFile: '这几行是做什么的？用一句话回答，不要调用任何工具。',
  long: '不要调用任何工具。请写五段文字，每段四到五句话：第一段讲春天，第二段讲夏天，第三段讲秋天，'
    + '第四段讲冬天，第五段讲四季轮回给人的启发。',
  askReply: '请把上面这段话缩短成一句。不要调用任何工具。',
  rename: '请用 edit 工具把这几行里的函数名 add 改成 plus，只改这一处，不要运行命令，改完用一句话告诉我。',
};

/** @brief 测试项目：README.md 和 src/a.ts（与 lib.mjs prepareProject 相同）。 */
function makeProject(root) {
  const project = join(root, 'm4-walk');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used to check Mori against a '
    + 'model.\n\n- It has one README file.\n- It has one source file in src/.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return project;
}

/** @brief 启动 Mori（连接已在走查数据目录里），等侧栏读完。 */
async function start(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.h = pageHelpers(ctx.page);
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 60000 });
  await sleep(1500);
}

/**
 * @brief 重启：托盘菜单"Exit"（Mori 有序退出；2026-10-26 起关掉窗口只是藏进托盘，docs/v0/screens/window.md），
 *        再用同一个数据目录启动。20 秒没退出时由测试关闭。
 */
async function restart(ctx) {
  if (!await exitFromTray(ctx.app, 20000)) await ctx.app.close().catch(() => {});
  await start(ctx);
}

/**
 * @brief 发一条消息；编辑和写入的批准卡（按钮"Allow “Edit files” for this session"或“Write files”）按 Alt+1，
 *        其余按 Alt+3；等本轮结束。
 */
async function sendWait(ctx, text) {
  const { page, h } = ctx;
  await h.send(text);
  await page.waitForFunction((p) => document.querySelector(p)?.dataset.running === 'true', PANE, { timeout: 30000 })
    .catch(() => {});
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline && await paneOf(page).getAttribute('data-running') === 'true') {
    const card = paneOf(page).getByTestId('approval-card');
    if (await card.count() > 0) {
      const text = await card.innerText().catch(() => '');
      await h.textarea.press(/“(Edit|Write) files”/.test(text) ? 'Alt+1' : 'Alt+3');
      await sleep(500);
    }
    await sleep(200);
  }
  await waitIdle(page, 60000);
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

/** @brief 当前会话里你的消息的条数（会话文件里）。 */
const userEntries = (file) => sessionEntries(file).filter((entry) => entry.message?.role === 'user').length;

// ---------- 走查 ----------

/** @brief 走查 1：让它改两个文件：右栏列出两个文件，点开按时间显示每次编辑的 diff，顶部注明命令改动不在此列。 */
async function item1(ctx) {
  const { page } = ctx;
  await stubFolder(ctx.app, ctx.project);
  await page.getByRole('button', { name: 'Open folder…' }).first().click();
  await waitReady(page);
  ctx.file = await activeFile(page);
  await sendWait(ctx, PROMPTS.edit);
  for (const path of ['README.md', 'src/a.ts']) await expandChange(page, path).catch(() => {});
  const list = await changeList(page);
  const files = list?.files.map((file) => file.path) ?? [];
  const ok = files.includes('README.md') && files.includes('src/a.ts') && list.files.every((file) => file.entries
    .every((entry, index) => entry.label === `Change ${index + 1} · Edit` && entry.diff.length > 0));
  record('走查 1：右栏列出改过的两个文件，展开按时间顺序显示每次编辑的 diff', ok,
    JSON.stringify(list?.files.map((f) => [f.path, f.count, f.entries.map((e) => e.label)])));
  record('走查 1：顶部注明"只含编辑和写入，命令改动的文件不在此列。"', list?.note
    === 'Only edits and writes are listed. Files changed by commands aren’t included.');
  await shot(page, '1-changes');
}

/** @brief 走查 2：点工具卡里的文件路径打开阅读器；删掉这个文件再点，显示"File not found"。 */
async function item2(ctx) {
  const { page } = ctx;
  const readme = await openFromCard(page, 'Edit', 'README.md');
  const disk = readFileSync(join(ctx.project, 'README.md'), 'utf8').split(/\r?\n/)[0];
  record('走查 2：点工具卡里的路径打开只读阅读器（行号、当前内容），工具卡不展开', readme?.path === 'README.md'
    && readme.first[0] === disk && readme.gutter === '"1"' && !(await toolCard(page, 'Edit', 'README.md')
      .evaluate((el) => el.open)), JSON.stringify(readme));
  await sendWait(ctx, PROMPTS.write);
  const written = await openFromCard(page, 'Write', 'notes.md');
  const file = join(ctx.project, 'docs', 'notes.md');
  record('走查 2：写入的文件也能点开（显示写入的内容）', existsSync(file) && written?.first[0] === '# Notes',
    JSON.stringify(written?.first));
  rmSync(file);
  const gone = await openFromCard(page, 'Write', 'notes.md');
  record('走查 2：删掉这个文件再点，显示"文件已被删除或移动"', gone?.state.startsWith('File not found')
    && gone.lineCount === 0, JSON.stringify(gone));
  await shot(page, '2-deleted');
}

/** @brief 走查 3：在阅读器里选一段点"Attach as context"：带来源的芯片；发送后点芯片回到原位置；重启后仍能点回。 */
async function item3(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Edit', 'src/a.ts');
  const dragged = await dragSelect(page, '[data-testid="file-content"]', 'return a + b');
  const shown = await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const chips = await composerChips(page);
  record('走查 3：在阅读器里用鼠标选一段，浮层"问 Mori"，输入框出现带来源的芯片', dragged && shown && chips.length === 1
    && /^src\/a\.ts · line \d+$/.test(chips[0].label) && chips[0].title === 'return a + b', JSON.stringify(chips));
  await shot(page, '3-chip');
  await sendWait(ctx, PROMPTS.askFile);
  const quotes = await sentQuotes(page);
  const reply = await paneOf(page).getByTestId('assistant').last().innerText();
  record('走查 3：发送后消息上方显示引用，模型照常回答', quotes.length === 1 && quotes[0].text === 'return a + b'
    && reply.trim().length > 0, JSON.stringify({ quotes, reply: oneLine(reply, 120) }));
  await paneOf(page).getByTestId('sent-quote').first().click();
  await waitViewer(page);
  await sleep(300);
  const back = await viewerState(page);
  record('走查 3：发送后点芯片回到原位置（阅读器打开 src/a.ts，那一行高亮）', back?.path === 'src/a.ts'
    && back.target.length === 1 && !back.changed, JSON.stringify(back));
  await restart(ctx);
  await openRow(ctx.page, ctx.file);
  await paneOf(ctx.page).getByTestId('sent-quote').first().click();
  await waitViewer(ctx.page);
  await sleep(300);
  const after = await viewerState(ctx.page);
  record('走查 3：重启后仍能点回原位置', after?.path === 'src/a.ts' && JSON.stringify(after.target)
    === JSON.stringify(back?.target) && !after.changed, JSON.stringify(after));
  await shot(ctx.page, '3-restart');
}

/** @brief 走查 4：流式输出时选中一句话点"Feedback"：选区不被打断；提交后提示"Saved"，当前会话没有新消息。 */
async function item4(ctx) {
  const { page, h } = ctx;
  const replies = await paneOf(page).getByTestId('assistant').count();
  await h.send(PROMPTS.long);
  // 等新回复的第一段写完（后面的段落已经开始流入），选第二个段落开头的 10 个字。
  await page.waitForFunction(({ p, n }) => {
    const all = document.querySelectorAll(`${p} [data-testid="assistant"]`);
    return all.length > n && all[all.length - 1].querySelectorAll('p').length >= 3;
  }, { p: PANE, n: replies }, { timeout: 120000 });
  const index = await paneOf(page).getByTestId('assistant').count() - 1;
  const sentence = await paneOf(page).getByTestId('assistant').nth(index).locator('p').nth(1)
    .evaluate((el) => el.textContent.trim().slice(0, 10));
  // 像你一样先往上滚一点看前面的字（离开底部，不再自动跟随），再拖选。
  const box = await paneOf(page).locator('.conversation').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await sleep(300);
  await dragSelect(page, `${PANE} [data-testid="assistant"]`, sentence, index, 'end');
  const shown = await popoverShown(page);
  const running = await paneOf(page).getAttribute('data-running');
  await sleep(800);
  const kept = await page.evaluate(() => window.getSelection().toString());
  const beforeUi = await messageCounts(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const note = await feedbackNote(page);
  await page.getByTestId('feedback-input').pressSequentially('希望每段再短一些', { delay: 40 });
  await page.getByTestId('feedback-form').getByRole('button', { name: 'Save' }).click();
  const saved = await page.getByTestId('feedback-saved').innerText({ timeout: 10000 }).catch(() => '');
  await shot(page, '4-feedback');
  await waitIdle(page, 180000);
  const afterUi = await messageCounts(page);
  const latest = savedFeedback(ctx.userData).at(-1);
  record('走查 4：流式输出时选中一句话，浮层出现，新流入的文字不清掉选区', shown && running === 'true'
    && kept.includes(sentence), JSON.stringify({ shown, running, kept: oneLine(kept, 60) }));
  record('走查 4：反馈表单的底部说明是这个项目没开增强时的整段（记忆规格 §10.7）', note === FEEDBACK_NOTE_OFF, note);
  record('走查 4：提交后提示"已记录"（Saved，没有链接，记忆规格 §10.7），记录保存在本机', saved === 'Saved'
    && latest?.quote.includes(sentence) && latest.expected === '希望每段再短一些', JSON.stringify({ saved, latest }));
  record('走查 4：当前会话没有新消息（界面和会话文件里你的消息都没有多）', beforeUi.user === afterUi.user
    && userEntries(ctx.file) === afterUi.user, JSON.stringify({ beforeUi, afterUi, file: userEntries(ctx.file) }));
}

/** @brief 走查 5：不用鼠标选字，用回复下的"Attach message as context"完成同样的引用。 */
async function item5(ctx) {
  const { page } = ctx;
  const rows = await replyActionRows(page);
  await paneOf(page).getByTestId('reply-actions').last().getByRole('button', { name: 'Copy' }).focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('Enter');
  const chips = await composerChips(page);
  const inComposer = await page.evaluate(() => document.activeElement?.matches('.composer textarea'));
  record('走查 5：Tab 到回复下的"引用到输入框"按 Enter：芯片"助手回复"，焦点到输入框', rows.at(-1)?.latest
    && focused === 'Attach message as context' && chips.length === 1 && chips[0].label === 'Response' && inComposer,
  JSON.stringify({ focused, chips: chips.map((c) => c.label) }));
  await page.keyboard.type(PROMPTS.askReply);
  await page.keyboard.press('Enter');
  await waitIdle(page, 120000);
  const quotes = await sentQuotes(page);
  const reply = await paneOf(page).getByTestId('assistant').last().innerText();
  await paneOf(page).getByTestId('sent-quote').last().click();
  await sleep(300);
  const lit = await jumpHighlight(page);
  record('走查 5：发出后消息上方显示"助手回复"的引用，模型照常回答；点它滚回那一轮并高亮', quotes.at(-1)?.label === 'Response'
    && reply.trim().length > 0 && lit.flashed > 0, JSON.stringify({ quote: quotes.at(-1)?.label, lit }));
  await shot(page, '5-reply-quote');
}

/** @brief 反例：原文已变化时，芯片保留当时的原文并提示"Source changed"。 */
async function counterExample(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Edit', 'src/a.ts');
  await selectLines(page, 1, 3);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const quote = (await composerChips(page))[0]?.title ?? '';
  await sendWait(ctx, PROMPTS.rename);
  const disk = readFileSync(join(ctx.project, 'src', 'a.ts'), 'utf8');
  await paneOf(page).getByTestId('sent-quote').last().click();
  await waitViewer(page);
  await sleep(300);
  const chip = (await sentQuotes(page)).at(-1);
  const viewer = await viewerState(page);
  record('反例：模型改了引用的那几行后点引用：芯片保留当时的原文并提示"原文已变化"，阅读器给出原文', disk.includes('plus')
    && chip?.status === 'Source changed' && chip.text === quote
    && viewer?.changed.startsWith('Source changed · Attached text:')
    && viewer.changed.includes('function add'), JSON.stringify({ chip, changed: viewer?.changed, disk: oneLine(disk) }));
  await shot(page, 'c-changed');
}

/**
 * @brief 走查数据目录里要有 Mori（v1）保存的提供商（只读 model-config.json 的非机密部分，lib.mjs realProviders，
 *        规格 §14.4）；没有时在复制密文之前就失败。
 */
function requireConnection(dir) {
  realProviders(dir);
}

requireConnection(source);
const root = mkdtempSync(join(tmpdir(), 'mori-m4-real-'));
const ctx = { project: makeProject(root), pageErrors: [] };
ctx.userData = scratchUserData(source);
// 测试准备（synthetic test setup，§14.1）：给临时项目授权公网，默认范围设为 [DeepSeek, GLM] 的分组
allowRealProject(ctx.userData, ctx.project);
try {
  await start(ctx);
  const items = { 1: item1, 2: item2, 3: item3, 4: item4, 5: item5, c: counterExample };
  for (const [item, fn] of Object.entries(items)) {
    if (!wanted(item) && item !== '1') continue;
    try {
      await fn(ctx);
    } catch (error) {
      record(`${item === 'c' ? '反例' : `走查 ${item}`}：流程`, false, oneLine(error, 400));
      await shot(ctx.page, `${item}-error`);
      await ctx.page.keyboard.press('Escape').catch(() => {});
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  rmSync(ctx.userData, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = write(`m4-real${suffix}.json`) ? 0 : 1;
