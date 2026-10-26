// M4 整机测试：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖改动与选区（docs/v0/screens/changes.md、selection.md；方案第 7 节 M4 走查 1–5 与反例）：
// 右栏改动列表（自动打开、注明命令改动不在此列、按时间顺序的 diff、写入的内容、命令改的和被拒绝的不列出）；
// 文件阅读器（工具卡路径和"Open"进入、行号、改动后自动重读、"Reload file"、"Open in default app"及失败、二进制、超过 1MB、
// 删除、读取失败、文件夹、按 pi 的规则解析路径）；选区浮层（阅读器和回复里出现，你的消息、跨回复、工具卡标题里不出现，
// Esc 先关浮层不停止、浮层开着时 Alt+1 照常；同类的上下文用量圆环：Esc 先关详情、再藏提示，之后才停止）；"Attach as context"（芯片、焦点、判重、移除、草稿与重启、只有芯片也能发、
// 模型收到引用块、mori.ref 条目、发出的引用、回到原位置：没变、挪了行、"Source changed"、"File not found"、回复里的高亮、重启后）；
// 反馈（表单、Ctrl+Enter、"Saved"、JSON 记录、不发给模型、保存失败保留文字、生成中选字反馈不被打断）；
// 回复下的操作（每轮一行、最新一轮常显、悬停与聚焦、Tab 顺序、"Copy"进剪贴板、"Attach message as context"、"Give feedback"、
// 生成中不显示）；
// 新加的界面没有小于 12px 的字；页面没有报错。
// 2026-10-26 走查（WP-13，changes.md、selection.md）：Markdown 文件默认预览（图片、链接、mermaid 图）、预览里选字引用源码行、
// Preview / View source 切换与重读、点标题里的路径复制完整路径（读取中不可用、File not found 时可用、失败时"Copy failed"）。
// 2026-10-26 走查 M18（WP-14，chat.md"步骤组"）：一轮结束后工具卡折进"{n} steps"，标题里的路径要先展开那一组才点得到
// （openFromCard 先 showStep）；引用折起的卡里的字、引用折着步骤的整轮回复、找不到文字的选区引用，点发出的引用先展开
// 那一组再高亮（stepsFold，用新会话、放在最后一步 expandRestart 之前）。
// 2026-10-26 补测（WP-13 状态表各行的用例）：大写扩展名、远程图片、代码高亮、超过 200KB、预览时自动重读仍是预览；
// 预览里的表格行、标题、跨块、不出浮层的两种，预览里的反馈与发出的引用块（previewSend，另开一个会话）；源码视图、
// 二进制、读取失败、解析不出的路径的复制，"Copy failed"清掉；右栏展开时"Feedback"不收回、批准卡与"Needs approval"
// （expandApproval）、重启后不恢复展开（expandRestart）；F8 的 Recent activity（activityLog）；右栏窄于 320px 时
// "← Changes"只剩箭头（narrowHeader）；回复下的"Copy"复制 mermaid 原文、对话流里载入不了的图片（replyMarkdown）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m4-app.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m4-app(-packaged).json，截图在 test-results/m4-app(-packaged)/。
// "Open in default app"：经 app.evaluate 换掉主进程的 shell.openPath，只记下路径（不真的打开程序）。
// 读取失败：用 Win32 CreateFileW 独占打开文件（不给任何共享），主进程读时报 EBUSY。

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import koffi from 'koffi';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, ctrlN, openRow, paneOf, ROW_TAB_ORDER, rowState, rowWhen, stoppedCount, stubFolder, until, waitIdle,
  waitReady, waitRunning, waitStatus,
} from './m3-helpers.mjs';
import {
  assistantIndexWith, changeList, clearSelection, lastReplyHasActions, composerChips, dragSelect, expandChange, jumpHighlight, messageCounts, PANE,
  popoverButtons, popoverShown, refEntries, sessionEntries, replyActionRows, savedDraftRefs, savedFeedback, selectBetween, selectLines,
  sentQuotes, textPoints, viewerState, waitViewer, FEEDBACK_NOTE_OFF, feedbackNote, previewState, viewSource,
  waitDiagram, cspBlocked, cspWatch,
} from './m4-helpers.mjs';
import { OPEN_FOLDER, pageHelpers, showStep, stepsState } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const port = 4325;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m4-not-a-real-key';
const shots = join(appRoot, `test-results/m4-app${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

const TITLE = '# Mori fixture project';
const NOTE = 'Only edits and writes are listed. Files changed by commands aren’t included.';
/** 反馈表单的底部说明：这个项目没开增强时的整段（docs/specs/memory.md §10.7、§14.4） */
const FEEDBACK_NOTE = FEEDBACK_NOTE_OFF;

// ---------- 准备 ----------

/** @brief 启动合成端点，最多等 15 秒。 */
function startFakeEndpoint() {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '15', FAKE_FIRST_DELAY_MS: '200',
      FAKE_REQUIRE_KEY: testKey },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('fake endpoint did not start within 15 s')), 15000);
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('synthetic')) return;
      clearTimeout(timer);
      done(child);
    });
  });
}

/** @brief 测试用的项目：README、src/a.ts、docs/。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m4-app-'));
  const project = join(root, 'm4proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'README.md'), `${TITLE}\n\nThis folder is used to check Mori against a model.\n\n`
    + '- It has one README file.\n- It has one source file in src/.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return { root, project };
}

const kernel32 = koffi.load('kernel32.dll');
const CreateFileW = kernel32.func(
  'void* __stdcall CreateFileW(str16, uint32_t, uint32_t, void*, uint32_t, uint32_t, void*)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)');

/** @brief 独占打开文件（不给任何共享），别人读不了；返回放开它的函数。 */
function lockFile(file) {
  const handle = CreateFileW(file, 0x80000000, 0, null, 3, 0x80, null);
  const address = handle ? koffi.address(handle) : 0n;
  if (address === 0n || address === 0xFFFFFFFFFFFFFFFFn) throw new Error(`cannot lock ${file}`);
  return () => CloseHandle(handle);
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
}

/** @brief 发一条消息；approve 为真时每出一张批准卡就按 Alt+1，'reject' 时按 Alt+3；等本轮结束。 */
async function sendAnd(ctx, text, approve = false) {
  const { page, h } = ctx;
  await h.send(text);
  await waitRunning(page).catch(() => {});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && await paneOf(page).getAttribute('data-running') === 'true') {
    if (approve && await paneOf(page).getByTestId('approval-card').count() > 0) {
      await h.textarea.press(approve === 'reject' ? 'Alt+3' : 'Alt+1');
    }
    await sleep(200);
  }
  await waitIdle(page, 30000);
}

/** @brief 当前会话里标题以 verb 开头、包含 target 的工具卡（最后一张）。 */
const toolCard = (page, verb, target) => page.locator(`${PANE} [data-testid="tool-card"]`)
  .filter({ has: page.locator('.tool-verb', { hasText: verb }) })
  .filter({ has: page.locator('.tool-target', { hasText: target }) }).last();

/** @brief 阅读器顶部的"← Changes"。 */
const backToChanges = (page) => page.getByTestId('right-panel').getByRole('button', { name: 'Changes', exact: true })
  .click();

/**
 * @brief 点工具卡标题里的路径，等阅读器读完；Markdown 文件默认是预览（changes.md"显示 Markdown 预览"），按行检查的步骤
 *        要源码，source 为真（默认）时切到"View source"。一轮结束后卡折在步骤组里（chat.md"步骤组"），先展开那一组。
 */
async function openFromCard(page, verb, target, source = true) {
  await showStep(toolCard(page, verb, target));
  await toolCard(page, verb, target).getByTestId('tool-path').click();
  await waitViewer(page);
  if (source) await viewSource(page);
  return viewerState(page);
}

// ---------- 主进程里运行的函数（经 app.evaluate） ----------

/** @brief 换掉 shell.openPath 和 shell.showItemInFolder：只记下路径，openPath 按 fail 返回错误文字。 */
function stubOpenPath({ shell }, fail) {
  globalThis.__opened = globalThis.__opened ?? [];
  globalThis.__revealed = globalThis.__revealed ?? [];
  shell.openPath = async (path) => {
    globalThis.__opened.push(path);
    return fail ?? '';
  };
  shell.showItemInFolder = (path) => { globalThis.__revealed.push(path); };
}

// ---------- 步骤 ----------

/**
 * @brief 首次启动：填连接、测试成功、打开项目文件夹；右栏默认关闭，手动打开时"No changes yet."。
 *        手动开关过的会话以你为准（不再自动打开），所以之后的步骤用 Ctrl+N 新建的会话。
 */
async function setup(ctx) {
  const { app, page, h } = ctx;
  // v1（规格 §14.4）：首次启动填英文表单，等探针都跑完再打开文件夹（page.mjs setupFirstRun）。
  await h.setupFirstRun({ baseUrl, apiKey: testKey });
  await stubFolder(app, ctx.project);
  await page.getByRole('button', { name: OPEN_FOLDER }).first().click();
  await waitReady(page);
  const closed = await page.getByTestId('right-panel').count() === 0;
  await paneOf(page).getByRole('button', { name: 'Toggle changes' }).click();
  const empty = await changeList(page);
  record('右栏：没有改动时默认关闭；手动打开显示"本会话还没有改动"', closed && empty?.empty === 'No changes yet.',
    JSON.stringify(empty));
  await paneOf(page).getByRole('button', { name: 'Toggle changes' }).click();
  ctx.file = await ctrlN(page);
}

/** @brief 走查 1：改两个文件（README 两次、新写一个），命令改的、被拒绝的不列出。 */
async function changes(ctx) {
  const { page } = ctx;
  await sendAnd(ctx, `edit README: ${TITLE}`, true);
  const auto = await changeList(page);
  record('右栏：本会话第一次有编辑结果时自动打开，列出文件并注明命令改动不在此列', auto?.note === NOTE
    && auto.files.some((file) => file.path === 'README.md'), JSON.stringify(auto));
  await sendAnd(ctx, 'write file: docs/new.md', true);
  await sendAnd(ctx, `edit README: ${TITLE} (edited)`, true);
  await sendAnd(ctx, 'run: echo cmd > cmd.txt', true);
  await sendAnd(ctx, 'edit README: # rejected title', 'reject');
  await expandChange(page, 'README.md');
  await expandChange(page, 'docs/new.md');
  const list = await changeList(page);
  const readme = list.files.find((file) => file.path === 'README.md');
  const written = list.files.find((file) => file.path === 'docs/new.md');
  record('改动列表：按文件列出（README.md、docs/new.md），按第一次改动排序', JSON.stringify(list.files.map((f) => f.path))
    === JSON.stringify(['README.md', 'docs/new.md']), JSON.stringify(list.files.map((f) => [f.path, f.count])));
  record('改动列表：同一文件按时间顺序显示每次编辑的 diff（第 1 次、第 2 次）', readme?.count === '2 changes'
    && readme.entries[0]?.label === 'Change 1 · Edit' && readme.entries[1]?.label === 'Change 2 · Edit'
    && readme.entries[0].diff.includes('(edited)') && readme.entries[1].diff.includes('(edited) (edited)')
    && !readme.entries[0].diff.includes('(edited) (edited)'), JSON.stringify(readme));
  record('改动列表：写入显示新内容', written?.entries[0]?.label === 'Change 1 · Write'
    && written.entries[0].content === 'hello from mori\n', JSON.stringify(written));
  record('改动列表：命令改的文件（cmd.txt）、被拒绝的编辑都不列出', existsSync(join(ctx.project, 'cmd.txt'))
    && !list.files.some((file) => file.path.includes('cmd.txt')) && readme?.count === '2 changes',
  JSON.stringify(list.files));
  await shot(page, '1-changes');
}

/** @brief 走查 2 前半：点工具卡里的路径打开阅读器（不展开工具卡）；"← Changes"回列表；列表的"Open"。 */
async function toolPath(ctx) {
  const { page } = ctx;
  const card = toolCard(page, 'Edit', 'README.md').first();
  const state = await openFromCard(page, 'Edit', 'README.md');
  const expanded = await card.evaluate((el) => el.open);
  record('阅读器：点工具卡里的路径在右栏打开文件（行号、只读），工具卡不展开', state?.path === 'README.md'
    && state.first[0] === `${TITLE} (edited) (edited)` && state.gutter === '"1"' && !expanded
    && await page.locator('[data-testid="file-content"] textarea, [data-testid="file-content"] [contenteditable]')
      .count() === 0, JSON.stringify({ state, expanded }));
  await backToChanges(page);
  const back = await changeList(page);
  await page.getByRole('button', { name: 'Open docs/new.md' }).click();
  await waitViewer(page);
  await viewSource(page);
  const opened = await viewerState(page);
  record('阅读器："← 改动"回到列表；列表里的"打开"打开文件', back?.files.length === 2 && opened?.path === 'docs/new.md'
    && opened.first[0] === 'hello from mori', JSON.stringify({ files: back?.files.length, opened }));
  await shot(page, '2-viewer');
}

/** @brief 阅读器打开时本会话改了这个文件就自动重读；外部改的要点"Reload file"。 */
async function reread(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Edit', 'README.md');
  await sendAnd(ctx, `edit README: ${TITLE} (edited) (edited)`, true);
  const auto = await until(async () => (await viewerState(page))?.first[0]?.endsWith('(edited) (edited) (edited)'), 5000);
  const file = join(ctx.project, 'README.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}外部加的一行\n`);
  await sleep(800);
  const before = await viewerState(page);
  await page.getByRole('button', { name: 'Reload file' }).click();
  await waitViewer(page);
  const after = await viewerState(page);
  record('阅读器：本会话改了这个文件后自动重新读取', Boolean(auto), JSON.stringify((await viewerState(page))?.first));
  record('阅读器：外部改的不自动读（不监视文件），点"重新读取"后显示新内容', before.lineCount + 1 === after.lineCount,
    `${before.lineCount} → ${after.lineCount}`);
}

/** @brief "Open in default app"：记下绝对路径；失败时显示原文。 */
async function openExternal(ctx) {
  const { app, page } = ctx;
  await app.evaluate(stubOpenPath, null);
  await page.getByRole('button', { name: 'Open in default app' }).click();
  const opened = await until(() => app.evaluate(() => globalThis.__opened), 3000);
  await app.evaluate(stubOpenPath, 'Synthetic open failure');
  await page.getByRole('button', { name: 'Open in default app' }).click();
  await page.locator('.panel-error').waitFor({ timeout: 3000 }).catch(() => {});
  const state = await viewerState(page);
  record('用系统编辑器打开：交给系统的是文件的绝对路径', opened?.[0]?.toLowerCase() === join(ctx.project, 'README.md')
    .toLowerCase(), JSON.stringify(opened));
  record('用系统编辑器打开失败：显示"没能用系统编辑器打开："和原文', state?.error
    === 'Couldn’t open this file with the default app: Synthetic open failure', state?.error);
  await sendAnd(ctx, 'write file: docs/run.bat', true);
  await openFromCard(page, 'Write', 'docs/run.bat');
  await app.evaluate(stubOpenPath, null);
  const before = (await app.evaluate(() => globalThis.__opened)).length;
  await page.getByRole('button', { name: 'Open in default app' }).click();
  const notice = await page.getByTestId('open-revealed').innerText({ timeout: 3000 }).catch(() => '');
  const calls = await app.evaluate(() => ({ opened: globalThis.__opened, revealed: globalThis.__revealed }));
  record('会被运行的文件（.bat）不打开，改为在资源管理器里选中并说明原因', calls.opened.length === before
    && calls.revealed.at(-1)?.toLowerCase() === join(ctx.project, 'docs', 'run.bat').toLowerCase()
    && notice === 'Opening this kind of file would run it, so it’s selected in File Explorer instead. '
      + 'Open it in an editor.', JSON.stringify({ calls, notice }));
}

/** @brief 走查 2 后半与各种读不出的情况：删除、二进制、超过 1MB、读取失败、文件夹、路径规则。 */
async function viewerStates(ctx) {
  const { page } = ctx;
  for (const name of ['bin.dat', 'big.txt', 'locked.txt']) await sendAnd(ctx, `write file: docs/${name}`, true);
  writeFileSync(join(ctx.project, 'docs', 'bin.dat'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08]));
  writeFileSync(join(ctx.project, 'docs', 'big.txt'), 'x'.repeat(1258291));
  rmSync(join(ctx.project, 'docs', 'new.md'));
  const missing = await openFromCard(page, 'Write', 'docs/new.md');
  record('阅读器：文件删掉后再点，显示"文件已被删除或移动"和路径，不能用系统编辑器打开',
    missing?.state.startsWith('File not found') && missing.state.includes(join(ctx.project, 'docs', 'new.md'))
    && missing.externalDisabled === true && missing.lineCount === 0, JSON.stringify(missing));
  await shot(page, '2-deleted');
  const binary = await openFromCard(page, 'Write', 'docs/bin.dat');
  const big = await openFromCard(page, 'Write', 'docs/big.txt');
  record('阅读器：二进制文件"无法预览 · 这是二进制文件"', binary?.state === 'Preview unavailable · Binary file', binary?.state);
  record('阅读器：超过 1MB"无法预览 · 文件超过 1MB（实际 1.2 MB）"', big?.state
    === 'Preview unavailable · File is larger than 1 MB (1.2 MB)', big?.state);
  const release = lockFile(join(ctx.project, 'docs', 'locked.txt'));
  let locked;
  try {
    locked = await openFromCard(page, 'Write', 'docs/locked.txt');
  } finally {
    release();
  }
  record('阅读器：读不出来时"读取失败："和原文', locked?.state.startsWith('Couldn’t read this file: ') && /EBUSY|resource busy/i
    .test(locked.state), locked?.state);
  const api = await page.evaluate(async (cwd) => ({ dir: await window.mori.readFile('docs', cwd),
    at: await window.mori.readFile('@README.md', cwd), bash: await window.mori.readFile(
      `/${cwd[0].toLowerCase()}/${cwd.slice(3).replaceAll('\\', '/')}/src/a.ts`, cwd),
    unc: await window.mori.readFile('\\\\m4-no-such-host\\share\\x.txt', cwd) }), ctx.project);
  record('读文件：文件夹为 directory；按 pi 的规则解析 @路径 和 Git Bash 的 /c/... 路径', api.dir.status === 'directory'
    && api.at.status === 'ok' && api.at.text.startsWith(TITLE) && api.bash.status === 'ok'
    && api.bash.text.startsWith('export function add'), JSON.stringify({ dir: api.dir.status, at: api.at.status,
    bash: api.bash.status }));
  record('读文件：网络路径（\\\\主机\\共享）不读', api.unc.status === 'error'
    && api.unc.message.startsWith('Network paths are not opened'), JSON.stringify(api.unc));
}

/** @brief 走查 3 前半：在阅读器里选两行点"Attach as context"：芯片、焦点、选区清掉；判重、移除；真的拖鼠标也出浮层。 */
async function viewerQuote(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Edit', 'README.md');
  await selectLines(page, 1, 2);
  const shown = await popoverShown(page);
  const buttons = await popoverButtons(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const chips = await composerChips(page);
  const focused = await page.evaluate(() => document.activeElement?.matches('.composer textarea'));
  const cleared = await page.evaluate(() => window.getSelection().isCollapsed);
  record('阅读器选区：浮层"问 Mori""反馈"；点"问 Mori"后输入框出现带来源的芯片，焦点到输入框，选区清除', shown
    && JSON.stringify(buttons) === JSON.stringify(['Attach as context', 'Feedback']) && chips.length === 1
    && chips[0].label === 'README.md · lines 1–2' && chips[0].text.startsWith(TITLE) && focused && cleared
    && chips[0].title === `${TITLE} (edited) (edited) (edited)\n`, JSON.stringify({ shown, buttons, chips, focused }));
  await shot(page, '3-chip');
  await selectLines(page, 1, 2);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  await selectLines(page, 3, 3);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const two = await composerChips(page);
  await paneOf(page).getByRole('button', { name: /^Remove context: README\.md · line 3/ }).click();
  const left = await composerChips(page);
  record('芯片：同一段不重复加入；× 移除', two.length === 2 && left.length === 1 && left[0].label.includes('lines 1–2'),
    JSON.stringify({ two, left }));
  await page.evaluate(() => {
    const content = document.querySelector('[data-testid="file-content"]');
    const range = document.createRange();
    range.setStart(content, 2);
    range.setEnd(content, 3);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const between = await composerChips(page);
  record('阅读器选区的端点落在两行之间时按行算（第 3 行整行），不会跑到文件开头或结尾', between.length === 2
    && between[1].label === 'README.md · line 3'
    && between[1].title === 'This folder is used to check Mori against a model.',
  JSON.stringify(between));
  await paneOf(page).getByRole('button', { name: /^Remove context: README\.md · line 3/ }).click();
  const dragged = await dragSelect(page, '[data-testid="file-content"]', 'This folder is used');
  record('阅读器：真的用鼠标拖选也出浮层', dragged && await popoverShown(page));
  await page.keyboard.press('Escape');
  record('Esc 先关浮层并清掉选区', await page.getByTestId('selection-popover').count() === 0
    && await page.evaluate(() => window.getSelection().isCollapsed));
}

/** @brief 芯片随草稿保存：去设置页再回来还在，本机存了。 */
async function chipDraft(ctx) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Back to app' }).click();
  const chips = await composerChips(page);
  const saved = await savedDraftRefs(page);
  const key = Object.keys(saved).find((file) => file.toLowerCase() === ctx.file.toLowerCase());
  record('芯片：去设置页再回来还在，按会话文件存在本机（mori.draftRefs）', chips.length === 1 && saved[key]?.length === 1
    && saved[key][0].source.kind === 'file', JSON.stringify({ chips, saved: Object.keys(saved) }));
}

/** @brief 发送带芯片的消息：引用显示在消息上方，模型收到引用块，会话文件里有 mori.ref 条目。 */
async function sendQuote(ctx) {
  const { page } = ctx;
  await sendAnd(ctx, 'echo back 这两行是什么？');
  const quotes = await sentQuotes(page);
  const bubble = await paneOf(page).getByTestId('user-message').last().innerText();
  // 回复按 Markdown 显示（"> # 标题"会画成引用里的标题），所以从会话文件里取模型回复的原文。
  const replies = sessionEntries(ctx.file).filter((entry) => entry.message?.role === 'assistant');
  const reply = (replies.at(-1)?.message.content ?? []).map((part) => part.text ?? '').join('');
  const refs = refEntries(ctx.file);
  const saved = await savedDraftRefs(page);
  record('发送后：你的消息上方显示引用（来源和原文），气泡里只有你写的字；芯片清空', quotes.length === 1
    && quotes[0].label === 'README.md · lines 1–2' && quotes[0].text.startsWith(TITLE)
    && bubble === 'echo back 这两行是什么？'
    && (await composerChips(page)).length === 0 && Object.keys(saved).length === 0, JSON.stringify({ quotes, bubble }));
  record('发给模型的全文：引用块（"引用 README.md 第 1–2 行："和 > 原文）加你的文字', reply.includes(
    `Quoting README.md, lines 1–2:\n> ${TITLE} (edited) (edited) (edited)\n>\n\necho back 这两行是什么？`),
  oneLine(reply, 300));
  const last = refs.at(-1);
  record('会话文件：pi 记下消息后写入 mori.ref 条目，messageId 指向这条你的消息，紧接在它后面', refs.length === 1
    && last.role === 'user' && last.text.startsWith('Quoting README.md, lines 1–2:') && last.parentIsMessage
    && last.refs?.[0]?.source.kind === 'file' && last.refs[0].source.startLine === 1, JSON.stringify(last));
  await shot(page, '3-sent');
}

/** @brief 点发出的引用回到阅读器：没变时原来的行；挪了行跳到新位置；原文改了标"Source changed"。 */
async function jumpFile(ctx) {
  const { page } = ctx;
  const file = join(ctx.project, 'README.md');
  const click = async () => {
    await paneOf(page).getByTestId('sent-quote').first().click();
    await waitViewer(page);
    await sleep(300);
    return viewerState(page);
  };
  await backToChanges(page);
  const same = await click();
  record('回到原位置：右栏打开阅读器，引用的两行高亮', JSON.stringify(same?.target) === '[1,2]' && !same.changed
    && (await sentQuotes(page))[0].status === null, JSON.stringify(same));
  writeFileSync(file, `新加的第一行\n${readFileSync(file, 'utf8')}`);
  const moved = await click();
  record('文件别处改了、原文还在：跳到它现在的位置（第 2–3 行），不提示', JSON.stringify(moved?.target) === '[2,3]'
    && !moved.changed && (await sentQuotes(page))[0].status === null, JSON.stringify(moved));
  writeFileSync(file, readFileSync(file, 'utf8').replace(`${TITLE} (edited)`, '# 改过的标题'));
  const changed = await click();
  const quote = (await sentQuotes(page))[0];
  record('反例：原文已变化时芯片保留当时的原文并提示"原文已变化"；阅读器顶部给出引用时的原文，停在原来的行',
    quote.status === 'Source changed' && quote.text.startsWith(`${TITLE} (edited)`) && changed.changed.startsWith(
      'Source changed · Attached text:') && changed.changed.includes(`${TITLE} (edited)`)
    && JSON.stringify(changed.target) === '[1,2]', JSON.stringify({ quote, changed }));
  await shot(page, 'c-changed');
  await sendAnd(ctx, 'edit README: # 改过的标题 (edited) (edited)', true);
  const reread = await until(async () => (await viewerState(page))?.first[1] === '# 改过的标题 (edited) (edited) (edited)',
    5000);
  record('阅读器是从引用芯片（绝对路径）打开的，工具用相对路径改了这个文件，也自动重新读取', Boolean(reread),
    JSON.stringify((await viewerState(page))?.first));
}

/** @brief 文件删掉后点芯片：芯片标"File not found"。 */
async function jumpDeleted(ctx) {
  const { page } = ctx;
  await sendAnd(ctx, 'write file: src/b.ts', true);
  await openFromCard(page, 'Write', 'src/b.ts');
  await selectLines(page, 1, 1);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  rmSync(join(ctx.project, 'src', 'b.ts'));
  await paneOf(page).getByTestId('quote-chip').locator('.quote-chip-main').click();
  await waitViewer(page);
  await sleep(300);
  const chip = (await composerChips(page))[0];
  const state = await viewerState(page);
  record('点芯片时文件已删除：芯片标"文件已被删除或移动"，阅读器显示同样的字', chip?.status === 'File not found'
    && state?.state.startsWith('File not found'), JSON.stringify({ chip, state: state?.state }));
  await paneOf(page).getByRole('button', { name: /^Remove context: / }).click();
}

// ---------- 2026-10-26 走查 M24、M25（WP-13）：Markdown 预览、复制路径 ----------

/**
 * 预览用的 Markdown 文件（docs/guide.md）：第 3–4 行一段、第 6–7 行列表、第 9–11 行表格、第 13–15 行代码块、第 17 行图片和
 * 链接（相对路径的图片、链接、远程图片）、mermaid 图
 */
const GUIDE = ['# Guide', '', 'First paragraph line one', 'continues **on line** four.', '', '- item one',
  '- item two', '',
  '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '```ts', 'const x = 1;', '```', '',
  '![logo](./logo.png) and [other](./other.md) ![remote](https://example.com/a.png)', '', '```mermaid', 'flowchart LR',
  '  A["读取<br/>配置"] --> B["完成"]', '```', ''].join('\n');
/** GUIDE 第 3–4 行（一段）的源码 */
const PARA = 'First paragraph line one\ncontinues **on line** four.';
/** 大写扩展名的 Markdown 文件（changes.md"显示 Markdown 预览"：扩展名不分大小写） */
const UPPER = { path: 'docs/Notes.MARKDOWN', text: '# Notes\n\nUpper-case **extension**.\n' };
/** 超过 200KB 的 Markdown（changes.md"显示 Markdown 源码"：只有源码视图），4000 行 */
const BIG_MD = Array.from({ length: 4000 }, (_, index) => `- line ${index + 1} of a long list that makes `
  + 'this file larger than 200 KB').join('\n');

/** @brief 选中预览里代码块的全部代码（程序选区），再像松开鼠标一样发 mouseup。 */
function selectPreviewCode(page) {
  return page.evaluate(() => {
    const pre = document.querySelector('[data-testid="file-preview"] [data-streamdown="code-block-body"] pre');
    if (!pre) return false;
    const range = document.createRange();
    range.selectNodeContents(pre);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  });
}

/** @brief 在预览里选一段（selectBetween 或 select 函数），点"Attach as context"，返回最后一个芯片。 */
async function attachFromPreview(page, select) {
  await select();
  const shown = await popoverShown(page);
  if (shown) await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  return { shown, chip: (await composerChips(page)).at(-1) ?? null };
}

/** @brief 预览里没有小于 12px 的字（连 mermaid 图的 shadow DOM 一起看）。 */
function previewSmallText(page) {
  return page.evaluate(() => {
    const small = [];
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) walk(element.shadowRoot);
        const own = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        if (own && element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 12) {
          small.push(`${element.tagName}:${getComputedStyle(element).fontSize}`);
        }
      }
    };
    const root = document.querySelector('[data-testid="file-preview"]');
    if (root) walk(root);
    return small;
  });
}

/** @brief changes.md"显示 Markdown 预览"（2026-10-26 补测）：扩展名不分大小写，docs/Notes.MARKDOWN 打开时也默认是预览。 */
async function previewUpper(ctx) {
  const { page } = ctx;
  await sendAnd(ctx, `write file: ${UPPER.path}`, true);
  writeFileSync(join(ctx.project, ...UPPER.path.split('/')), UPPER.text);
  const opened = await openFromCard(page, 'Write', UPPER.path, false);
  await page.locator('[data-testid="file-preview"] [data-streamdown^="heading"]').first().waitFor({ timeout: 5000 })
    .catch(() => {});
  const preview = await previewState(page);
  record('Markdown 预览：扩展名不分大小写（docs/Notes.MARKDOWN）打开时也默认是预览（标题渲染、没有行号），按钮"View source"',
    opened?.mode === 'preview' && opened.modeButton === 'View source' && preview?.headings[0] === 'Notes'
    && preview.lineRows === 0, JSON.stringify({ opened, preview }));
}

/**
 * @brief 预览里的图片、链接与代码高亮（changes.md"显示 Markdown 预览"）：相对路径的图片显示"Image not available"，点链接
 *        不跳转；2026-10-26 补测：远程图片被内容安全策略拦下（不加载），也只显示"Image not available"，没有看得见的图片；
 *        ts 代码块按语言着色。
 */
async function previewMedia(ctx, preview) {
  const { page } = ctx;
  const url = page.url();
  await page.getByTestId('file-preview').getByText('other', { exact: true }).click();
  await sleep(500);
  const after = await viewerState(page);
  record('Markdown 预览：图片和链接同对话流：相对路径的图片显示"Image not available"，点链接不跳转（还是这个文件的预览）',
    preview?.imageFallback === 'Image not available' && page.url() === url && after?.mode === 'preview'
    && after.path === 'docs/guide.md', JSON.stringify({ image: preview?.imageFallback, url: page.url(), after }));
  const blocked = await cspBlocked(page);
  record('Markdown 预览：远程图片不加载（内容安全策略拦下 https://example.com/a.png），和相对路径的图片一样只显示'
    + '"Image not available"，没有看得见的图片', blocked.some((uri) => uri.startsWith('https://example.com'))
    && preview?.imageFallbacks.length === 2 && preview.imageFallbacks.every((text) => text === 'Image not available')
    && preview.imagesShown === 0, JSON.stringify({ blocked, fallbacks: preview?.imageFallbacks,
    shown: preview?.imagesShown }));
  record('Markdown 预览：代码块按语言高亮（ts 代码块里有着色的词）', preview?.tokens > 0, `tokens=${preview?.tokens}`);
}

/**
 * @brief changes.md"显示 Markdown 预览"：.md 文件默认是预览（标题、列表、表格、代码块、mermaid 图，没有行号，按钮
 *        "View source"）；图片显示"Image not available"，点链接不跳转；没有小于 12px 的字。2026-10-26 补测：
 *        大写扩展名（previewUpper）、远程图片与代码高亮（previewMedia）。
 */
async function previewOpens(ctx) {
  const { page } = ctx;
  await previewUpper(ctx);
  await sendAnd(ctx, 'write file: docs/guide.md', true);
  writeFileSync(join(ctx.project, 'docs', 'guide.md'), GUIDE);
  await cspWatch(page);
  const opened = await openFromCard(page, 'Write', 'docs/guide.md', false);
  const drawn = await waitDiagram(page, '[data-testid="file-preview"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-preview"] '
    + '[data-streamdown="image-fallback"]').length >= 2
    && document.querySelector('[data-testid="file-preview"] pre span[style*="--sdm-c"]'), null, { timeout: 5000 })
    .catch(() => {});
  const preview = await previewState(page);
  record('Markdown 预览：.md 文件打开时默认是预览（标题、列表、表格、代码块和 mermaid 图都渲染，没有行号），顶部按钮'
    + '"View source"', opened?.mode === 'preview' && opened.modeButton === 'View source' && drawn
    && preview?.headings[0] === 'Guide' && preview.items === 2 && preview.tables === 1
    && preview.codeBlocks.includes('ts') && preview.diagrams === 1 && preview.lineRows === 0 && preview.positioned > 5,
  JSON.stringify({ opened, preview, drawn }));
  await previewMedia(ctx, preview);
  const small = await previewSmallText(page);
  record('Markdown 预览：没有小于 12px 的字（含 mermaid 图里的字）', small.length === 0, small.slice(0, 5).join('; '));
  await shot(page, 'p-preview');
}

/**
 * @brief selection.md"选中 Markdown 预览里的文字"（2026-10-26 补测）：表格的一行引用"line 11"整行（连同 |）、标题引用
 *        "line 1"（连同 #），从段落选到列表第二项时取较早的起始行到较晚的结束行（"lines 3–7"）。
 */
async function previewBlocks(page, scope) {
  const row = await attachFromPreview(page, () => selectBetween(page, scope, '1', '2'));
  const heading = await attachFromPreview(page, () => selectBetween(page, scope, 'Guide', 'Guide'));
  const across = await attachFromPreview(page, () => selectBetween(page, scope, 'First paragraph', 'item two'));
  record('预览里选字：表格的一行引用"line 11"整行（| 1 | 2 |），标题引用"line 1"（# Guide），从段落选到列表第二项引用'
    + '"lines 3–7"（较早的起始行到较晚的结束行）', row.chip?.label === 'docs/guide.md · line 11'
    && row.chip.title === '| 1 | 2 |' && heading.chip?.label === 'docs/guide.md · line 1'
    && heading.chip.title === '# Guide' && across.chip?.label === 'docs/guide.md · lines 3–7'
    && across.chip.title === `${PARA}\n\n- item one\n- item two`, JSON.stringify({ row, heading, across }));
}

/**
 * @brief 页面里：从预览里 ts 代码块标题上的第一段字（语言名，代码之外）选到代码的前三个字，发 mouseup；返回那段字，
 *        找不到时为 null。
 */
function selectFromCodeLabel() {
  const block = document.querySelector('[data-testid="file-preview"] '
    + '[data-streamdown="code-block"][data-language="ts"]');
  const pre = block?.querySelector('pre');
  if (!block || !pre) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let label = null;
  for (let node = walker.nextNode(); node && !label; node = walker.nextNode()) {
    if (!pre.contains(node) && node.data.trim()) label = node;
  }
  const code = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT).nextNode();
  if (!label || !code) return null;
  const range = document.createRange();
  range.setStart(label, 0);
  range.setEnd(code, Math.min(3, code.data.length));
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return label.data.trim();
}

/** @brief 页面里：从预览第 17 行的链接字"other"选到 mermaid 图的框上（range 的终点在框上），发 mouseup。 */
function selectToDiagram() {
  const root = document.querySelector('[data-testid="file-preview"]');
  const host = root?.querySelector('[data-testid="mermaid-diagram"]');
  if (!root || !host) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let start = null;
  for (let node = walker.nextNode(); node && !start; node = walker.nextNode()) {
    if (node.data === 'other') start = node;
  }
  if (!start) return false;
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(host, 0);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return true;
}

/**
 * @brief selection.md"不出浮层"（2026-10-26 补测）：预览里从代码块标题上的语言名（没有源码位置）选到代码里、选区一端
 *        落在 mermaid 图上（图画在 shadow DOM 里）时都没有浮层。
 */
async function previewNoPopover(page) {
  await clearSelection(page);
  const fromLabel = await page.evaluate(selectFromCodeLabel);
  const labelShown = await popoverShown(page, 800);
  await clearSelection(page);
  const toDiagram = await page.evaluate(selectToDiagram);
  const diagramShown = await popoverShown(page, 800);
  await clearSelection(page);
  record('预览里不出浮层：一端在代码块标题的语言名上（没有源码位置）、一端在 mermaid 图上', fromLabel === 'ts'
    && toDiagram && !labelShown && !diagramShown, JSON.stringify({ fromLabel, labelShown, toDiagram, diagramShown }));
}

/**
 * @brief selection.md"选中 Markdown 预览里的文字"：引用的是选区碰到的块的源码行（段落 3–4 行、列表项第 7 行、
 *        代码块 13–15 行连同 ``` 一起），芯片与在源码里选中这几整行相同；点芯片回到源码视图、那几行高亮，按钮"Preview"。
 *        2026-10-26 补测：表格的一行、标题、跨块（previewBlocks），不出浮层的两种（previewNoPopover）。
 */
async function previewQuote(ctx) {
  const { page } = ctx;
  const scope = '[data-testid="file-preview"]';
  const para = await attachFromPreview(page, () => selectBetween(page, scope, 'First paragraph', ' four.'));
  const item = await attachFromPreview(page, () => selectBetween(page, scope, 'item two', 'item two'));
  const code = await attachFromPreview(page, () => selectPreviewCode(page));
  record('预览里选字：浮层照常；引用的是源码行（段落"lines 3–4"连同 **，列表项"line 7"连同 -，代码块"lines 13–15"连同 ```）',
    para.shown && para.chip?.label === 'docs/guide.md · lines 3–4' && para.chip.title === PARA
    && item.chip?.label === 'docs/guide.md · line 7' && item.chip.title === '- item two'
    && code.chip?.label === 'docs/guide.md · lines 13–15' && code.chip.title === '```ts\nconst x = 1;\n```',
  JSON.stringify({ para, item, code }));
  await previewBlocks(page, scope);
  await previewNoPopover(page);
  await paneOf(page).getByTestId('quote-chip').first().locator('.quote-chip-main').click();
  await waitViewer(page);
  await sleep(300);
  const jumped = await viewerState(page);
  record('点预览里引用的芯片：阅读器用源码视图，第 3–4 行高亮，按钮"Preview"', jumped?.mode === 'source'
    && JSON.stringify(jumped.target) === '[3,4]' && jumped.modeButton === 'Preview', JSON.stringify(jumped));
  for (let left = (await composerChips(page)).length; left > 0; left -= 1) {
    await paneOf(page).getByRole('button', { name: /^Remove context: / }).first().click();
  }
  await shot(page, 'p-quote');
}

/** @brief 在预览里选第 3–4 行那一段，点"Feedback"，写字保存；返回浮层是否出现、表单里的引用和保存的那一份反馈。 */
async function previewFeedback(ctx) {
  const { page } = ctx;
  await selectBetween(page, '[data-testid="file-preview"]', 'First paragraph', ' four.');
  const shown = await popoverShown(page);
  if (shown) await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const form = page.getByTestId('feedback-form');
  await form.waitFor({ timeout: 3000 }).catch(() => {});
  const formQuote = await form.locator('.feedback-quote').innerText({ timeout: 3000 }).catch(() => '');
  await page.getByTestId('feedback-input').fill('预览里的反馈');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('feedback-saved').waitFor({ timeout: 5000 }).catch(() => {});
  await form.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return { shown, formQuote, saved: savedFeedback(ctx.userData).at(-1) ?? null };
}

/**
 * @brief selection.md"选中 Markdown 预览里的文字"（2026-10-26 补测）："反馈和发给模型的引用块与源码视图相同"：在另一个
 *        新会话里（不改主会话发出的引用）预览 docs/guide.md，选第 3–4 行那一段点"Feedback"保存：引用的是这两行源码、
 *        起止行 3、4；再"Attach as context"随消息发出：你的消息上方的引用、发给模型的引用块都是这两整行源码。最后回到主会话。
 */
async function previewSend(ctx) {
  const { page } = ctx;
  ctx.previewFile = await ctrlN(page);
  await sendAnd(ctx, 'write file: docs/guide.md', true);
  writeFileSync(join(ctx.project, 'docs', 'guide.md'), GUIDE);
  await openFromCard(page, 'Write', 'docs/guide.md', false);
  const feedbackSaved = await previewFeedback(ctx);
  const attached = await attachFromPreview(page,
    () => selectBetween(page, '[data-testid="file-preview"]', 'First paragraph', ' four.'));
  await sendAnd(ctx, 'echo back 预览里的这两行');
  const quote = (await sentQuotes(page)).at(-1);
  const replies = sessionEntries(ctx.previewFile).filter((entry) => entry.message?.role === 'assistant');
  const reply = (replies.at(-1)?.message.content ?? []).map((part) => part.text ?? '').join('');
  const { saved } = feedbackSaved;
  record('预览里选字点"Feedback"：表单里和保存的反馈引用的都是这两行源码，来源是 docs/guide.md 的第 3–4 行',
    feedbackSaved.shown && feedbackSaved.formQuote === PARA && saved?.quote === PARA && saved.source.kind === 'file'
    && saved.source.startLine === 3 && saved.source.endLine === 4 && saved.expected === '预览里的反馈',
  JSON.stringify(feedbackSaved));
  record('预览里选字后发出：你的消息上方的引用是"docs/guide.md · lines 3–4"和这两行源码，发给模型的引用块是'
    + '"Quoting docs/guide.md, lines 3–4:"加这两行源码（与在源码视图里选中相同）',
  attached.chip?.label === 'docs/guide.md · lines 3–4' && quote?.label === 'docs/guide.md · lines 3–4'
    && quote.text === PARA && reply.includes('Quoting docs/guide.md, lines 3–4:\n> First paragraph line one\n'
      + '> continues **on line** four.\n\necho back 预览里的这两行'), JSON.stringify({ quote, reply: oneLine(reply, 300) }));
  await openRow(page, ctx.file);
}

/**
 * @brief changes.md"显示 Markdown 源码"（2026-10-26 补测）：超过 200KB 的 Markdown 打开时是源码（有行号），没有
 *        Preview / View source；正在预览的 Markdown 被本会话的工具改了以后自动重读，仍是预览（按钮"View source"）。
 *        最后把 docs/guide.md 写回 GUIDE。
 */
async function previewLimits(ctx) {
  const { page } = ctx;
  await sendAnd(ctx, 'write file: docs/big.md', true);
  writeFileSync(join(ctx.project, 'docs', 'big.md'), BIG_MD);
  const big = await openFromCard(page, 'Write', 'docs/big.md', false);
  record('超过 200KB 的 Markdown 打开时是源码（有行号），没有 Preview / View source 按钮', big?.mode === 'source'
    && big.modeButton === null && big.gutter === '"1"' && big.lineCount === 4000,
  JSON.stringify({ mode: big?.mode, button: big?.modeButton, gutter: big?.gutter, lines: big?.lineCount }));
  await openFromCard(page, 'Write', 'docs/guide.md', false);
  await sendAnd(ctx, 'write file: docs/guide.md', true);
  const reread = await until(async () => (await page.getByTestId('file-preview').innerText().catch(() => ''))
    .includes('hello from mori'), 5000);
  const after = await viewerState(page);
  writeFileSync(join(ctx.project, 'docs', 'guide.md'), GUIDE);
  record('正在预览的 Markdown 被本会话的工具改了：自动重读后仍是预览（按钮"View source"），显示新内容', Boolean(reread)
    && after?.mode === 'preview' && after.modeButton === 'View source', JSON.stringify(after));
}

/**
 * @brief 切换与重读：Preview / View source 来回切；"Reload file"保持当前这一种；每次再打开重新按默认（预览）。
 *        2026-10-26 补测：超过 200KB、本会话改了正在预览的文件（previewLimits）。
 */
async function previewToggle(ctx) {
  const { page } = ctx;
  const panel = page.getByTestId('right-panel');
  await panel.getByRole('button', { name: 'Preview', exact: true }).click();
  const toPreview = await viewerState(page);
  await panel.getByRole('button', { name: 'Reload file' }).click();
  await waitViewer(page);
  const reloaded = await viewerState(page);
  await viewSource(page);
  await panel.getByRole('button', { name: 'Reload file' }).click();
  await waitViewer(page);
  const sourceReloaded = await viewerState(page);
  await backToChanges(page);
  await page.getByRole('button', { name: 'Open docs/guide.md' }).click();
  await waitViewer(page);
  const reopened = await viewerState(page);
  record('Preview / View source 来回切换；"Reload file"保持当前这一种；从改动列表再打开时回到预览', toPreview?.mode === 'preview'
    && reloaded?.mode === 'preview' && sourceReloaded?.mode === 'source' && sourceReloaded.lineCount === 22
    && reopened?.mode === 'preview' && reopened.modeButton === 'View source',
  JSON.stringify({ toPreview, reloaded, sourceReloaded, reopened }));
  const plain = await openFromCard(page, 'Write', 'docs/run.bat', false);
  record('不是 Markdown 的文件没有 Preview / View source 按钮，照旧显示源码', plain?.mode === 'source'
    && plain.modeButton === null, JSON.stringify(plain));
  await previewLimits(ctx);
}

/**
 * @brief 记下阅读器"Loading…"期间路径按钮的样子（每次 DOM 变化时看一次），之后用 loadingPathSeen 取回：
 *        读取中路径按钮应当不可用（changes.md"读取中"）。
 */
function watchLoadingPath(page) {
  return page.evaluate(() => {
    window.__loadingPath = [];
    window.__loadingObserver?.disconnect();
    window.__loadingObserver = new MutationObserver(() => {
      const viewer = document.querySelector('[data-testid="file-viewer"]');
      const button = document.querySelector('[data-testid="file-path"]');
      if (viewer?.textContent.includes('Loading…') && button) window.__loadingPath.push(button.disabled);
    });
    window.__loadingObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true });
  });
}

/** @brief 取回 watchLoadingPath 记下的"读取中路径按钮是否不可用"，并停止观察。 */
const loadingPathSeen = (page) => page.evaluate(() => {
  window.__loadingObserver?.disconnect();
  return window.__loadingPath;
});

/** @brief 主进程的剪贴板文字。 */
const clipboardText = (app) => app.evaluate(({ clipboard }) => clipboard.readText());

/** @brief 把主进程的剪贴板设成 text（复制前清掉上一次的结果）。 */
const setClipboard = (app, text) => app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);

/** @brief 把主进程的 clipboard.writeText 换成抛错的（synthetic 的写剪贴板失败）；restoreClipboard 换回原来的。 */
const breakClipboard = (app) => app.evaluate(({ clipboard }) => {
  globalThis.__writeText ??= clipboard.writeText;
  clipboard.writeText = () => { throw new Error('Synthetic clipboard failure'); };
});

/** @brief 换回 breakClipboard 之前的 clipboard.writeText。 */
const restoreClipboard = (app) => app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.__writeText; });

/**
 * @brief 点顶部的路径，等 testid 那一行出现（path-copied 或 path-copy-failed）；返回剪贴板的文字、阅读器的样子和
 *        "Path copied to clipboard."那一行的 role。
 */
async function clickPath(ctx, testid) {
  await ctx.page.getByTestId('file-path').click();
  await ctx.page.getByTestId(testid).waitFor({ timeout: 3000 }).catch(() => {});
  return { text: await clipboardText(ctx.app), state: await viewerState(ctx.page),
    role: await ctx.page.evaluate(() => document.querySelector('[data-testid="path-copied"]')?.getAttribute('role')
      ?? null) };
}

/** @brief 不分大小写比较两个路径。 */
const samePathText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * @brief changes.md"复制路径"：路径是按钮（读屏名、悬停），读取中不可用；点它把完整路径放进剪贴板，"Path copied to
 *        clipboard."约 2 秒后消失。2026-10-26 补测："显示"状态（源码视图）里同样能复制，提示是 role="status"。
 */
async function copyBasics(ctx) {
  const { app, page } = ctx;
  await setClipboard(app, 'm4 clipboard before');
  await watchLoadingPath(page);
  await openFromCard(page, 'Write', 'docs/guide.md', false);
  const loading = await loadingPathSeen(page);
  const full = join(ctx.project, 'docs', 'guide.md');
  const before = await viewerState(page);
  const copied = await clickPath(ctx, 'path-copied');
  await sleep(2600);
  const faded = await viewerState(page);
  record('复制路径：路径是按钮（读屏名"Copy path <完整路径>"、悬停完整路径），读取中不可用；点它把完整路径放进剪贴板，'
    + '下方"Path copied to clipboard."约 2 秒后消失', samePathText(before?.pathLabel, `copy path ${full}`)
    && samePathText(before.fullPath, full) && before.path === 'docs/guide.md'
    && loading.length > 0 && loading.every(Boolean) && samePathText(copied.text, full)
    && copied.state?.copied === 'Path copied to clipboard.' && faded?.copied === '',
  JSON.stringify({ before, loading, copied: copied.text, faded: faded?.copied }));
  await viewSource(page);
  await setClipboard(app, 'm4 clipboard reset');
  const source = await clickPath(ctx, 'path-copied');
  record('复制路径：显示源码时（View source 之后）同样能复制完整路径；提示"Path copied to clipboard."是 role="status"',
    source.state?.mode === 'source' && samePathText(source.text, full)
    && source.state.copied === 'Path copied to clipboard.' && source.role === 'status',
  JSON.stringify({ text: source.text, mode: source.state?.mode, role: source.role }));
}

/** 解析不出的路径（file:// 地址里有编码的斜杠：pi 和主进程都解析不出，不访问任何文件和网络） */
const BAD_URL = 'file:///C:/m4%2Fbad.md';

/**
 * @brief changes.md"复制路径"："File not found"时也能复制（解析出的完整路径）。2026-10-26 补测："Preview unavailable ·
 *        Binary file"时复制解析出的完整路径；读取失败而路径已解析出来时（文件被占用）复制解析出的完整路径；路径解析不出时
 *        读取失败，复制的是工具参数里的路径原文。
 */
async function copyStates(ctx) {
  const { app, page } = ctx;
  const missing = await openFromCard(page, 'Write', 'docs/new.md', false);
  const missingCopy = await clickPath(ctx, 'path-copied');
  record('复制路径："File not found"时也能复制（解析出的完整路径）', missing?.state.startsWith('File not found')
    && samePathText(missingCopy.text, join(ctx.project, 'docs', 'new.md')), JSON.stringify({ text: missingCopy.text }));
  const binary = await openFromCard(page, 'Write', 'docs/bin.dat', false);
  const binaryCopy = await clickPath(ctx, 'path-copied');
  record('复制路径："Preview unavailable · Binary file"时也能复制（解析出的完整路径）',
    binary?.state === 'Preview unavailable · Binary file' && samePathText(binaryCopy.text,
      join(ctx.project, 'docs', 'bin.dat')), JSON.stringify({ state: binary?.state, text: binaryCopy.text }));
  const release = lockFile(join(ctx.project, 'docs', 'locked.txt'));
  let locked = null;
  try {
    locked = { state: await openFromCard(page, 'Write', 'docs/locked.txt', false), copy: await clickPath(ctx,
      'path-copied') };
  } finally {
    release();
  }
  record('复制路径：读取失败、路径已解析出来时（文件被占用）复制的是解析出的完整路径', locked?.state?.state
    .startsWith('Couldn’t read this file: ') && samePathText(locked.copy.text, join(ctx.project, 'docs', 'locked.txt')),
  JSON.stringify({ state: locked?.state?.state, text: locked?.copy.text }));
  await sendAnd(ctx, `call tool: read {"path":"${BAD_URL}"}`, true);
  const bad = await openFromCard(page, 'Read', 'bad.md', false);
  await setClipboard(app, 'm4 clipboard reset');
  const badCopy = await clickPath(ctx, 'path-copied');
  record('复制路径：路径解析不出（file:// 地址里有编码的斜杠）时读取失败，复制的是工具参数里的路径原文',
    bad?.state.startsWith('Couldn’t read this file: ') && badCopy.text === BAD_URL,
  JSON.stringify({ state: bad?.state, text: badCopy.text }));
}

/**
 * @brief changes.md"复制路径失败"：写剪贴板失败时下方"Copy failed"（role="alert"）。2026-10-26 补测：再点一次成功时
 *        "Copy failed"清掉、出现"Path copied to clipboard."；再失败一次后换一个文件打开，"Copy failed"不在。
 */
async function copyFailure(ctx) {
  const { app, page } = ctx;
  await openFromCard(page, 'Write', 'docs/new.md', false);
  await breakClipboard(app);
  const failed = await clickPath(ctx, 'path-copy-failed');
  await restoreClipboard(app);
  record('复制路径失败：下方"Copy failed"（role="alert"）', failed.state?.copyFailed === 'Copy failed'
    && await page.locator('[data-testid="path-copy-failed"][role="alert"]').count() === 1,
  JSON.stringify(failed.state));
  const retried = await clickPath(ctx, 'path-copied');
  await breakClipboard(app);
  const again = await clickPath(ctx, 'path-copy-failed');
  await restoreClipboard(app);
  const switched = await openFromCard(page, 'Write', 'docs/run.bat', false);
  record('复制路径失败后再点一次（成功）："Copy failed"清掉、出现"Path copied to clipboard."；再失败后换一个文件打开，'
    + '"Copy failed"不在', retried.state?.copyFailed === '' && retried.state.copied === 'Path copied to clipboard.'
    && again.state?.copyFailed === 'Copy failed' && switched?.copyFailed === '' && switched.path === 'docs/run.bat',
  JSON.stringify({ retried: retried.state, again: again.state?.copyFailed, switched: switched?.copyFailed }));
}

/**
 * @brief changes.md"复制路径"（走查 M25，照 Claude 的"Copy path {path}"）与"复制路径失败"：copyBasics、copyStates、
 *        copyFailure。
 */
async function copyPath(ctx) {
  await copyBasics(ctx);
  await copyStates(ctx);
  await copyFailure(ctx);
  await shot(ctx.page, 'p-copy-path');
}

/** @brief 此刻右栏是否展开、中栏的显示方式、焦点是否在输入框、右栏顶部按钮的读屏名。 */
const expandState = (page) => page.evaluate(() => ({
  expanded: document.querySelector('.app')?.dataset.rightExpanded ?? null,
  center: getComputedStyle(document.querySelector('.center')).display,
  focused: document.activeElement?.matches('.pane-slot:not([hidden]) .composer textarea') ?? false,
  button: document.querySelector('[data-testid="right-panel"] .panel-expand')?.getAttribute('aria-label') ?? null,
}));

/**
 * @brief layout.md"右栏展开"（2026-10-26 补测）：右栏展开时在预览里选字点"Feedback"：右栏不收回（仍是展开的、中栏藏着），
 *        反馈表单出现；Esc 关上表单，再"Collapse"。
 */
async function expandFeedback(page) {
  await page.getByTestId('right-panel').getByRole('button', { name: 'Expand', exact: true }).click();
  await selectBetween(page, '[data-testid="file-preview"]', 'First paragraph', ' four.');
  const shown = await popoverShown(page);
  if (shown) await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const form = await page.getByTestId('feedback-form').waitFor({ timeout: 3000 }).then(() => true, () => false);
  const during = await expandState(page);
  await page.keyboard.press('Escape');
  await page.getByTestId('feedback-form').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  await page.getByTestId('right-panel').getByRole('button', { name: 'Collapse', exact: true }).click();
  record('右栏展开时在预览里选字点"Feedback"：右栏不收回（仍是展开的，中栏藏着），反馈表单出现', shown && form
    && during.expanded === 'true' && during.center === 'none' && during.button === 'Collapse',
  JSON.stringify({ shown, form, during }));
}

/**
 * @brief layout.md"右栏展开"（2026-10-26 WP-13 审查后加）：右栏展开时在预览里选字、点"Attach as context"：右栏收回、
 *        中栏回来，芯片在输入框里，焦点在输入框末尾（芯片和输入框原来在藏起的中栏里，看不见）。最后去掉这个芯片。
 *        2026-10-26 补测："Feedback"不收回（expandFeedback）。
 */
async function expandAttach(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Write', 'docs/guide.md', false);
  await page.getByTestId('right-panel').getByRole('button', { name: 'Expand', exact: true }).click();
  const expanded = await expandState(page);
  const attached = await attachFromPreview(page,
    () => selectBetween(page, '[data-testid="file-preview"]', 'First paragraph', ' four.'));
  await sleep(300);
  const after = await expandState(page);
  record('右栏展开时在预览里"Attach as context"：右栏收回、中栏回来，芯片在输入框里，焦点在输入框',
    expanded.expanded === 'true' && expanded.center === 'none' && attached.shown
    && attached.chip?.label === 'docs/guide.md · lines 3–4' && after.expanded === null && after.center !== 'none'
    && after.focused && after.button === 'Expand', JSON.stringify({ expanded, attached, after }));
  await shot(page, 'p-expand-attach');
  await paneOf(page).getByRole('button', { name: /^Remove context: / }).first().click();
  await expandFeedback(page);
}

/** @brief 主进程里：记下主窗口 flashFrame 的调用，再开一个小窗口把焦点抢走（同 m2-app.mjs 的 installFlashRecorder）。 */
function installFlashRecorder({ BrowserWindow }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  const proto = BrowserWindow.prototype;
  const original = proto.flashFrame;
  const state = { calls: [], descriptor: Object.getOwnPropertyDescriptor(proto, 'flashFrame'), mainId: main.id };
  Object.defineProperty(proto, 'flashFrame', { configurable: true, writable: true, value(flag) {
    state.calls.push({ id: this.id, flag });
    return original.call(this, flag);
  } });
  const helper = new BrowserWindow({ width: 320, height: 200, x: 40, y: 40, title: 'focus helper' });
  helper.focus();
  state.helperId = helper.id;
  globalThis.__m4Flash = state;
}

/** @brief 主进程里：主窗口 flashFrame 的调用（true / false 序列）。 */
function flashCalls() {
  const { calls, mainId } = globalThis.__m4Flash;
  return calls.filter((call) => call.id === mainId).map((call) => call.flag);
}

/** @brief 主进程里：恢复 flashFrame，关掉小窗口，停止闪烁，把焦点交回主窗口。 */
function restoreFlash({ BrowserWindow }) {
  const state = globalThis.__m4Flash;
  if (!state) return;
  BrowserWindow.fromId(state.helperId)?.destroy();
  if (state.descriptor) Object.defineProperty(BrowserWindow.prototype, 'flashFrame', state.descriptor);
  else delete BrowserWindow.prototype.flashFrame;
  const main = BrowserWindow.fromId(state.mainId);
  main?.flashFrame(false);
  main?.focus();
  delete globalThis.__m4Flash;
}

/**
 * @brief layout.md"右栏展开"（2026-10-26 补测）：右栏展开时这个会话出批准卡：卡在藏起的中栏里看不见、顶栏的"Toggle
 *        changes"够不着，侧栏的会话行仍显示"Needs approval"；窗口不在前台时任务栏照常闪烁（同 m2-app.mjs 的做法：记下
 *        flashFrame 的调用，另开一个小窗口把焦点抢走）。收回后拒绝这张卡（Alt+3）。
 */
async function expandApproval(ctx) {
  const { app, page } = ctx;
  await openFromCard(page, 'Write', 'docs/guide.md', false);
  await ctx.h.send('wait 3s then run: echo expanded');
  await page.getByTestId('right-panel').getByRole('button', { name: 'Expand', exact: true }).click();
  let flashes = [];
  try {
    await app.evaluate(installFlashRecorder);
    await waitStatus(page, ctx.file, 'approval', 20000);
    flashes = await until(async () => {
      const calls = await app.evaluate(flashCalls);
      return calls.includes(true) ? calls : null;
    }, 5000) ?? await app.evaluate(flashCalls);
  } finally {
    await app.evaluate(restoreFlash).catch((error) => console.error(`[m4-app] restore flashFrame failed: ${error}`));
  }
  const row = await rowState(page, ctx.file);
  const during = { ...await expandState(page), card: await paneOf(page).getByTestId('approval-card').isVisible(),
    toggle: await paneOf(page).getByRole('button', { name: 'Toggle changes' }).isVisible() };
  await page.getByTestId('right-panel').getByRole('button', { name: 'Collapse', exact: true }).click();
  await paneOf(page).getByTestId('approval-card').waitFor({ timeout: 5000 }).catch(() => {});
  await ctx.h.textarea.press('Alt+3');
  await paneOf(page).getByTestId('approval-card').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await waitIdle(page, 30000);
  record('右栏展开时这个会话出批准卡：卡在藏起的中栏里看不见、"Toggle changes"够不着，侧栏的会话行仍显示"Needs approval"，'
    + '窗口不在前台时任务栏照常闪烁（flashFrame(true)）', row?.statusText === 'Needs approval'
    && during.expanded === 'true' && during.center === 'none' && !during.card && !during.toggle
    && flashes.includes(true),
  JSON.stringify({ status: row?.statusText, during, flashes }));
}

/** @brief 按 F8、写上 what、保存，返回写着 what 的那一份报告（同 m5-app.mjs 的 saveIssue）。 */
async function saveIssue(ctx, what) {
  const { page } = ctx;
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('issue-what').fill(what);
  await page.getByTestId('issue-dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('issue-saved').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  const dir = join(ctx.userData, 'ui-issues');
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(dir, name), 'utf8'))
    .find((text) => text.includes(what)) ?? '';
}

/** @brief 报告"## Recent activity"一节里每一行的操作（去掉开头的时间）。 */
function activityOf(report) {
  const lines = report.split(/\r?\n/);
  const rest = lines.slice(lines.indexOf('## Recent activity') + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return rest.slice(0, end < 0 ? undefined : end).filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- \S+ /, ''));
}

/**
 * @brief f8.md"Recent activity"（2026-10-26 补）：阅读器顶部的操作各记一条：打开 docs/guide.md（Open file）后
 *        "View source"、"Preview"、点路径（Copy path）、"Expand"、"Collapse"（Expand right panel、Collapse right panel）；
 *        展开时在预览里"Attach as context"收回右栏也记"Collapse right panel"（在"Attach as context (file)"之后）。
 *        最后去掉这个芯片。
 */
async function activityLog(ctx) {
  const { page } = ctx;
  const panel = page.getByTestId('right-panel');
  await openFromCard(page, 'Write', 'docs/guide.md', false);
  await panel.getByRole('button', { name: 'View source', exact: true }).click();
  await panel.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByTestId('file-path').click();
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  await panel.getByRole('button', { name: 'Collapse', exact: true }).click();
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  await attachFromPreview(page, () => selectBetween(page, '[data-testid="file-preview"]', 'First paragraph', ' four.'));
  await sleep(300);
  const actions = activityOf(await saveIssue(ctx, 'WP-13 reader actions'));
  await paneOf(page).getByRole('button', { name: /^Remove context: / }).first().click();
  const from = actions.lastIndexOf('Open file');
  const wanted = ['Open file', 'View source', 'Preview', 'Copy path', 'Expand right panel', 'Collapse right panel',
    'Expand right panel', 'Attach as context (file)', 'Collapse right panel'];
  record('F8 报告的"Recent activity"：阅读器顶部的操作各记一条（View source、Preview、Copy path、Expand right panel、'
    + 'Collapse right panel），展开时"Attach as context"收回右栏也记"Collapse right panel"，按先后', from >= 0
    && JSON.stringify(actions.slice(from, from + wanted.length)) === JSON.stringify(wanted),
  JSON.stringify(actions.slice(-12)));
}

/** @brief 阅读器顶部"← Changes"此刻的样子：右栏宽、读屏名、字是否显示、有没有箭头。 */
const backLink = (page) => page.getByTestId('right-panel').evaluate((panel) => {
  const link = panel.querySelector('.back-link');
  const text = link?.querySelector('.back-text');
  return { width: Math.round(panel.getBoundingClientRect().width), label: link?.getAttribute('aria-label') ?? null,
    text: text ? getComputedStyle(text).display : null, arrow: Boolean(link?.querySelector('svg')) };
});

/**
 * @brief layout.md"右栏窄于 320px"（2026-10-26 补）：用键盘把右栏的分隔线往右调（每次窄 20px）到 300px 以下，阅读器顶部的
 *        "← Changes"只剩箭头、读屏名仍是"Changes"；宽时字也在。最后双击分隔线恢复默认宽度。
 */
async function narrowHeader(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Write', 'docs/guide.md', false);
  const wide = await backLink(page);
  await page.locator('[data-resize="workspace"]').focus();
  for (let presses = 0; presses < 30 && (await backLink(page)).width > 300; presses += 1) {
    await page.keyboard.press('ArrowRight');
  }
  const narrow = await backLink(page);
  await page.locator('[data-resize="workspace"]').dblclick();
  record('右栏窄于 320px 时阅读器顶部的"← Changes"只剩箭头，读屏名仍是"Changes"；宽于 320px 时字也在', wide.width >= 320
    && wide.text !== 'none' && narrow.width < 320 && narrow.text === 'none' && narrow.label === 'Changes'
    && narrow.arrow, JSON.stringify({ wide, narrow }));
}

/** "mermaid diagram" 回复里那张图的 Markdown 原文（tests/fake-endpoint/replies.mjs） */
const MERMAID_SOURCE = '```mermaid\nflowchart LR\n  A["开始"] --> B["结束"]\n```';

/** @brief 当前会话最后一条回复里的图片：替代文字各行（字、字号、字形）和看得见的图片张数。 */
const replyImages = (page) => paneOf(page).getByTestId('assistant').last().evaluate((reply) => ({
  fallbacks: [...reply.querySelectorAll('[data-streamdown="image-fallback"]')].map((item) => ({
    text: item.textContent, size: getComputedStyle(item).fontSize, style: getComputedStyle(item).fontStyle })),
  shown: [...reply.querySelectorAll('img')].filter((image) => image.getClientRects().length > 0
    && getComputedStyle(image).display !== 'none').length }));

/**
 * @brief chat.md"图"与"正文里的图片"（2026-10-26 补测）：回复里画成图的 mermaid，回复下的"Copy"复制的仍是 Markdown 原文；
 *        回复里载入不了的两张图片（相对路径、远程）不显示坏图，原处一行 12px 斜体"Image not available"，远程的被
 *        内容安全策略拦下。
 */
async function replyMarkdown(ctx) {
  const { app, page } = ctx;
  await sendAnd(ctx, 'mermaid diagram 回复下的复制');
  const drawn = await waitDiagram(page, PANE);
  await setClipboard(app, 'm4 before reply copy');
  const actions = paneOf(page).getByTestId('reply-actions').last();
  await actions.getByRole('button', { name: 'Copy' }).click();
  await actions.getByRole('button', { name: 'Copied' }).waitFor({ timeout: 3000 }).catch(() => {});
  const copied = await clipboardText(app);
  record('mermaid 图：回复下的"Copy"复制的仍是 Markdown 原文（含 ```mermaid 那一段），不是图', drawn
    && copied.includes(MERMAID_SOURCE), oneLine(copied, 200));
  await cspWatch(page);
  await sendAnd(ctx, 'image reply 两张图');
  await page.waitForFunction((css) => [...document.querySelectorAll(`${css} [data-testid="assistant"]`)].at(-1)
    ?.querySelectorAll('[data-streamdown="image-fallback"]').length >= 2, PANE, { timeout: 5000 }).catch(() => {});
  const images = await replyImages(page);
  const blocked = await cspBlocked(page);
  record('对话流里的图片：载入不了的两张（相对路径、远程）都不显示（没有坏图图标），原处一行 12px 斜体'
    + '"Image not available"；远程图片被内容安全策略拦下、不加载', images.fallbacks.length === 2
    && images.fallbacks.every((item) => item.text === 'Image not available' && item.size === '12px'
      && item.style === 'italic') && images.shown === 0 && blocked.some((uri) => uri.startsWith('https://example.com')),
  JSON.stringify({ images, blocked }));
}

/** @brief 选区浮层不出现的地方：你的消息、跨两条回复、工具卡标题。 */
async function noPopover(ctx) {
  const { page } = ctx;
  const cases = [];
  await clearSelection(page);
  cases.push(['你的消息', await selectBetween(page, `${PANE} [data-testid="user-message"]`, 'edit', 'README')]);
  cases.push(['你的消息', await popoverShown(page, 800)]);
  await clearSelection(page);
  const replies = await paneOf(page).getByTestId('assistant').count();
  await page.evaluate((count) => {
    const all = document.querySelectorAll('.pane-slot:not([hidden]) [data-testid="assistant"]');
    const range = document.createRange();
    range.setStart(all[0], 0);
    range.setEnd(all[Math.min(1, count - 1)], 1);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, replies);
  cases.push(['跨两条回复', await popoverShown(page, 800)]);
  await clearSelection(page);
  // 卡折在步骤组里时选不到它的字（chat.md"步骤组"）：先展开，量的才是卡标题本身
  await showStep(paneOf(page).getByTestId('tool-card').first());
  await selectBetween(page, `${PANE} [data-testid="tool-card"] summary`, 'Edit', 'README');
  cases.push(['工具卡标题', await popoverShown(page, 800)]);
  await clearSelection(page);
  record('选区浮层不出现：你的消息、跨两条回复、工具卡标题', cases[0][1] && !cases[1][1] && !cases[2][1] && !cases[3][1],
    JSON.stringify(cases));
}

/** @brief 回复里选字点"Attach as context"：芯片"Response"；发出后点它滚回去高亮引用的文字，约 4 秒后消失。 */
async function transcriptQuote(ctx) {
  const { page } = ctx;
  await sendAnd(ctx, 'plain 先回一段话');
  const dragged = await dragSelect(page, `${PANE} [data-testid="assistant"]`, '只有文字的回复',
    await paneOf(page).getByTestId('assistant').count() - 1);
  const shown = await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const chips = await composerChips(page);
  record('回复里选字点"问 Mori"：芯片"助手回复"，原文是选中的字', dragged && shown && chips.length === 1
    && chips[0].label === 'Response' && chips[0].title === '只有文字的回复', JSON.stringify(chips));
  await sendAnd(ctx, 'plain 解释一下');
  await paneOf(page).locator('.conversation').evaluate((el) => { el.scrollTop = 0; });
  await paneOf(page).getByTestId('sent-quote').last().click();
  await sleep(300);
  const lit = await jumpHighlight(page);
  const visible = await page.evaluate(() => {
    const range = [...(CSS.highlights.get('mori-jump') ?? [])][0];
    const rect = range?.getBoundingClientRect();
    const box = document.querySelector('.pane-slot:not([hidden]) .conversation')?.getBoundingClientRect();
    return Boolean(rect && box && rect.top >= box.top && rect.bottom <= box.bottom);
  });
  await sleep(4300);
  const gone = await jumpHighlight(page);
  record('点回复里的引用：滚回那条回复并高亮引用的文字，约 4 秒后消失', lit.text === '只有文字的回复' && visible
    && gone.text === '', JSON.stringify({ lit, visible, gone }));
}

/**
 * @brief 走查 5 与回复下的操作：每轮一行、最新一轮常显、悬停与聚焦、Tab 顺序、"Copy"、"Attach message as context"、
 *        "Give feedback"。
 */
async function replyActions(ctx) {
  const { app, page } = ctx;
  const rows = await replyActionRows(page);
  const counts = await messageCounts(page);
  const turnsWithText = rows.length;
  record('回复下的操作：每轮一行（多次工具调用的一轮也只在最后），按钮是复制、引用到输入框、反馈这条回复',
    turnsWithText > 0 && turnsWithText <= counts.user && rows.every((row) => JSON.stringify(row.buttons)
      === JSON.stringify(['Copy', 'Attach message as context', 'Give feedback'])),
  JSON.stringify({ rows: rows.length, counts }));
  record('回复下的操作：最新一轮一直显示，较早的默认不显示', rows.at(-1)?.latest && rows.at(-1).opacity === '1'
    && rows.slice(0, -1).every((row) => !row.latest && row.opacity === '0'), JSON.stringify(rows.map((r) => r.opacity)));
  const first = paneOf(page).getByTestId('reply-actions').first();
  await first.getByRole('button', { name: 'Copy' }).focus();
  const focusShown = await first.evaluate((el) => getComputedStyle(el).opacity);
  await page.keyboard.press('Tab');
  const second = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('Tab');
  const third = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  record('回复下的操作：键盘聚焦时显示，Tab 依次到复制、引用到输入框、反馈这条回复', focusShown === '1'
    && second === 'Attach message as context' && third === 'Give feedback',
  JSON.stringify({ focusShown, second, third }));
  const last = paneOf(page).getByTestId('reply-actions').last();
  await last.getByRole('button', { name: 'Copy' }).click();
  await last.getByRole('button', { name: 'Copied' }).waitFor({ timeout: 3000 }).catch(() => {});
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  const label = await last.locator('.reply-action').first().innerText();
  const lastReply = await paneOf(page).getByTestId('assistant').last().innerText();
  record('复制：这一轮的正文进系统剪贴板，按钮短暂显示"已复制"', copied.trim() === lastReply.trim() && label === 'Copied',
    JSON.stringify({ copied: oneLine(copied), label }));
  await last.getByRole('button', { name: 'Attach message as context' }).focus();
  await page.keyboard.press('Enter');
  const chips = await composerChips(page);
  const focused = await page.evaluate(() => document.activeElement?.matches('.composer textarea'));
  record('走查 5：不用鼠标，用回复下的"引用到输入框"完成引用（芯片"助手回复"，焦点到输入框）', chips.length === 1
    && chips[0].label === 'Response' && chips[0].title.trim() === lastReply.trim() && focused, JSON.stringify(chips));
  await paneOf(page).getByRole('button', { name: /^Remove context: / }).click();
  await shot(page, '5-actions');
}

/** @brief 反馈：表单内容、Ctrl+Enter、"Saved"、JSON 记录、不发给模型；保存失败保留文字。 */
async function feedback(ctx) {
  const { page } = ctx;
  const before = await messageCounts(page);
  const index = await paneOf(page).getByTestId('assistant').count() - 1;
  await dragSelect(page, `${PANE} [data-testid="assistant"]`, '只有文字的回复', index);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const form = page.getByTestId('feedback-form');
  await form.waitFor({ timeout: 3000 });
  // 说明在 enhance.get 返回之前留空（§10.7）：先等它有文字再比对全文
  const note = await feedbackNote(page);
  const view = await form.evaluate((el) => ({ quote: el.querySelector('.feedback-quote')?.textContent,
    label: el.querySelector('.feedback-label')?.childNodes[0]?.textContent,
    focused: document.activeElement === el.querySelector('textarea'),
    disabled: [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.disabled,
    highlight: CSS.highlights.has('mori-quote') }));
  record('反馈表单：引用的原文、"希望得到什么结果？"、焦点在输入框、没写字时"记录"不可用、底部说明（没开增强时的整段）、'
    + '选区保持高亮', view.quote === '只有文字的回复' && view.label === 'What result were you hoping for?'
    && note === FEEDBACK_NOTE && view.focused && view.disabled && view.highlight, JSON.stringify({ ...view, note }));
  const dir = join(ctx.userData, 'feedback');
  if (existsSync(dir)) renameSync(dir, `${dir}-away`);
  writeFileSync(dir, 'not a folder');
  await page.getByTestId('feedback-input').fill('希望先给结论');
  await page.getByTestId('feedback-input').press('Control+Enter');
  const error = await page.getByTestId('feedback-error').innerText({ timeout: 5000 }).catch(() => '');
  const kept = await page.getByTestId('feedback-input').inputValue().catch(() => '');
  record('保存失败：保留已输入的文字并显示"没有记录："和原文', error.startsWith('Couldn’t save your feedback: ')
    && kept === '希望先给结论',
    JSON.stringify({ error, kept }));
  rmSync(dir);
  if (existsSync(`${dir}-away`)) renameSync(`${dir}-away`, dir);
  await form.getByRole('button', { name: 'Save' }).click();
  const saved = await page.getByTestId('feedback-saved').innerText({ timeout: 5000 }).catch(() => '');
  const records = savedFeedback(ctx.userData);
  const latest = records.at(-1);
  const after = await messageCounts(page);
  record('走查 4：提交后提示"已记录"（Saved，没有链接，记忆规格 §10.7），当前会话没有新消息', saved === 'Saved'
    && JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ saved, before, after }));
  record('反馈记录（JSON）：期望、原文、锚点（会话文件、条目 id、消息时间）、会话', latest?.expected === '希望先给结论'
    && latest.quote === '只有文字的回复' && latest.source.kind === 'message' && typeof latest.source.entryId === 'string'
    && typeof latest.source.time === 'number' && latest.session.file?.toLowerCase() === ctx.file.toLowerCase()
    && Boolean(latest.createdAt), JSON.stringify(latest));
  await form.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  record('已记录约 3 秒后表单关闭', await form.count() === 0);
}

/** @brief 回复下的"Give feedback"：表单里是这一轮的正文；Esc 关闭。 */
async function feedbackReply(ctx) {
  const { page } = ctx;
  await paneOf(page).getByTestId('reply-actions').last().getByRole('button', { name: 'Give feedback' }).click();
  const quote = await page.getByTestId('feedback-form').locator('.feedback-quote').innerText({ timeout: 3000 });
  const reply = await paneOf(page).getByTestId('assistant').last().innerText();
  await page.getByTestId('feedback-input').fill('写了一半');
  await paneOf(page).getByTestId('reply-actions').first().getByRole('button', { name: 'Give feedback' }).click();
  const kept = await page.getByTestId('feedback-input').inputValue();
  const focused = await page.evaluate(() => document.activeElement?.dataset.testid === 'feedback-input');
  const formQuote = await page.getByTestId('feedback-form').locator('.feedback-quote').innerText();
  await dragSelect(page, `${PANE} [data-testid="assistant"]`, '只有文字的回复',
    await assistantIndexWith(page, '只有文字的回复'));
  const noPopover = !await popoverShown(page, 800);
  await clearSelection(page);
  await page.getByTestId('feedback-input').focus();
  await page.keyboard.press('Escape');
  record('反馈这条回复：表单里是这一轮的正文；Esc 关闭', quote.trim() === reply.trim()
    && await page.getByTestId('feedback-form').count() === 0, oneLine(quote));
  record('已有一张在写的反馈表单时，再点"反馈这条回复"不换掉它（字还在、焦点回到输入框），也不出选区浮层',
    kept === '写了一半' && focused && formQuote === quote && noPopover, JSON.stringify({ kept, focused, noPopover }));
}

/**
 * @brief 等内容再长一截、跟随把对话流滚到底（最多 1.5 秒）。
 * @return 等到了为 true；内容不再变长或没有在跟随时为 false。
 */
async function followedOnce(page) {
  const height = await paneOf(page).locator('.conversation').evaluate((el) => el.scrollHeight);
  return page.waitForFunction(({ pane, before }) => {
    const el = document.querySelector(`${pane} .conversation`);
    return el.scrollHeight > before && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
  }, { pane: PANE, before: height }, { timeout: 1500 }).then(() => true, () => false);
}

/**
 * @brief 生成中的拖选：像你一样先把那句话滚到眼前，等跟随自己滚到底（直到那句话下面至少还有 90px），
 *        再往上滚到它在视野中间（至少 60px），然后拖选，拖选时不再滚动。等的这一次让跟随记下最新的“自动滚到底的位置”，
 *        往上滚就比它更靠上、算离开底部，之后流入的字不再滚动对话流（Transcript.tsx 的 useFollow）。
 *        不这样做时（原有的时序竞争）：滚到眼前的位置离底部不到 24px，跟随恢复；或者记下的位置还是按住鼠标之前的，
 *        往上滚不算离开底部。两种情况下按下鼠标之前流入的字都会把对话流滚到底，鼠标落到别的行。
 * @param box 对话流在视口里的位置。
 * @param index 正在流式输出的那条回复是第几条助手消息。
 * @param wanted 要选中的字（取第一处）。
 */
async function selectWhileStreaming(page, box, index, wanted) {
  const target = `${PANE} [data-testid="assistant"]`;
  const middle = box.y + box.height / 2;
  await textPoints(page, target, wanted, index);
  let seen = null;
  for (let tries = 0; tries < 20; tries += 1) {
    const followed = await followedOnce(page);
    seen = await textPoints(page, target, wanted, index, false);
    if (!followed || !seen || seen.y1 + 90 < box.y + box.height) break;
  }
  await page.mouse.move(box.x + box.width / 2, middle);
  await page.mouse.wheel(0, Math.min(-60, Math.round((seen?.y1 ?? middle) - middle)));
  await sleep(300);
  await dragSelect(page, target, wanted, index, false);
}

/** @brief 走查 4：流式输出时选中一句话点"Feedback"：选区不被打断，写字不被打断，提交后"Saved"，没有新消息。 */
async function streamingFeedback(ctx) {
  const { page, h } = ctx;
  await h.send('long reply 写四段');
  await page.waitForFunction(() => [...document.querySelectorAll('.pane-slot:not([hidden]) [data-testid="assistant"]')]
    .at(-1)?.textContent?.includes('第二段'), null, { timeout: 20000 });
  const index = await paneOf(page).getByTestId('assistant').count() - 1;
  const scroller = paneOf(page).locator('.conversation');
  const gap = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  // 等内容超出对话流的高度（前面步骤的对话已经够长），这时在底部、正在跟随。
  await page.waitForFunction((p) => {
    const el = document.querySelector(`${p} .conversation`);
    return el.scrollHeight > el.clientHeight + 100;
  }, PANE, { timeout: 8000 }).catch(() => {});
  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width - 12, box.y + 20);
  await page.mouse.down();
  const atDown = await gap();
  await sleep(1200);
  const whileHeld = await gap();
  const hasNew = await paneOf(page).getByTestId('new-content').count();
  await page.mouse.up();
  record('生成中在对话流里按住鼠标：暂停自动跟随（下面的字不被滚走），显示"有新内容"', atDown <= 24 && whileHeld > atDown
    && hasNew === 1, JSON.stringify({ atDown, whileHeld, hasNew }));
  await selectWhileStreaming(page, box, index, '河边的柳树发了新芽');
  const shown = await popoverShown(page);
  const running = await paneOf(page).getAttribute('data-running');
  await sleep(600);
  const kept = await page.evaluate(() => window.getSelection().toString());
  const actions = await lastReplyHasActions(page) ? 1 : 0;
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  await page.getByTestId('feedback-input').pressSequentially('希望每段更短', { delay: 60 });
  const typed = await page.getByTestId('feedback-input').inputValue();
  const highlight = await page.evaluate(() => [...(CSS.highlights.get('mori-quote') ?? [])].map(String).join(''));
  record('走查 4：生成中选中一句话，浮层出现，新流入的文字不清掉选区；这一轮还没结束时不显示回复下的操作',
    shown && running === 'true' && kept.includes('河边的柳树发了新芽') && actions === 0, JSON.stringify({ shown, running,
      kept: oneLine(kept), actions }));
  record('生成中写反馈：输入不被打断，选区保持高亮', typed === '希望每段更短' && highlight.includes('河边的柳树发了新芽'),
    JSON.stringify({ typed, highlight }));
  const before = await messageCounts(page);
  await page.getByTestId('feedback-form').getByRole('button', { name: 'Save' }).click();
  const saved = await page.getByTestId('feedback-saved').innerText({ timeout: 5000 }).catch(() => '');
  await waitIdle(page, 60000);
  const after = await messageCounts(page);
  const latest = savedFeedback(ctx.userData).at(-1);
  record('生成中提交反馈："已记录"，会话没有多出消息；记录里有消息时间（这时还没有条目 id）', saved.startsWith('Saved')
    && before.user === after.user && latest?.quote.includes('河边的柳树发了新芽') && typeof latest.source.time === 'number',
  JSON.stringify({ saved, before, after, source: latest?.source }));
  record('本轮结束后显示回复下的操作', (await replyActionRows(page)).at(-1)?.latest === true);
}

/** @brief Esc 与快捷键：浮层开着时 Esc 只关浮层（不停止生成）；浮层不挡 Alt+1。 */
async function keysWithPopover(ctx) {
  const { page, h } = ctx;
  await h.send('long reply 再写一遍');
  await page.waitForFunction(() => [...document.querySelectorAll('.pane-slot:not([hidden]) [data-testid="assistant"]')]
    .at(-1)?.textContent?.includes('第一段'), null, { timeout: 20000 });
  const index = await paneOf(page).getByTestId('assistant').count() - 1;
  const box = await paneOf(page).locator('.conversation').boundingBox();
  await selectWhileStreaming(page, box, index, '春天来了');
  const opened = await popoverShown(page);
  await page.keyboard.press('Escape');
  await sleep(300);
  const stillRunning = await paneOf(page).getAttribute('data-running');
  const closed = opened && await page.getByTestId('selection-popover').count() === 0;
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await waitIdle(page, 30000);
  record('浮层开着时 Esc 只关浮层，不停止生成；再按 Esc 才停止', closed && stillRunning === 'true', JSON.stringify({ closed,
    stillRunning }));
  await h.send(`edit README: ${TITLE} (edited) (edited) (edited)`);
  await paneOf(page).getByTestId('approval-card').waitFor({ timeout: 20000 });
  await dragSelect(page, `${PANE} [data-testid="assistant"]`, '只有文字的回复',
    await assistantIndexWith(page, '只有文字的回复'));
  const shown = await popoverShown(page);
  await page.keyboard.press('Alt+1');
  const answered = await paneOf(page).getByTestId('approval-card').waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  await waitIdle(page, 30000);
  record('选区浮层开着时 Alt+1 照常批准（浮层不挡快捷键）', shown && answered, JSON.stringify({ shown, answered }));
  await clearSelection(page);
}

/**
 * @brief 上下文用量圆环的 Esc（与选区浮层同一类：只是看数的浮层；docs/v0/screens/models.md"上下文用量（圆环）"、
 *        chat.md"Esc 的顺序"，2026-10-21 起圆环在输入框下面一行）：生成中从文字框 Tab 到圆环（依次经过权限、选择范围、
 *        Effort），悬停提示显示；Enter 打开详情；Esc 先关详情（焦点留在圆环，不停止生成），再按 Esc 藏起提示（仍不停止），
 *        提示藏起后再按 Esc 才停止生成（"Stopped · …"多一行）。
 */
async function ringEsc(ctx) {
  const { page, h } = ctx;
  await page.mouse.move(0, 0);
  const stopped = await stoppedCount(page);
  await h.send('wait 8s');
  await waitRunning(page);
  await h.textarea.focus();
  const stops = [];
  for (let presses = 0; presses < 6 && stops.at(-1) !== 'usage'; presses += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => document.activeElement?.dataset?.testid ?? document.activeElement?.tagName));
  }
  const tipped = await rowWhen(page, (row) => row.tip !== null, 2000);
  await page.keyboard.press('Enter');
  const opened = await rowWhen(page, (row) => row.details, 2000);
  await page.keyboard.press('Escape');
  const first = await rowWhen(page, (row) => !row.details, 2000);
  const running = [await paneOf(page).getAttribute('data-running')];
  await page.keyboard.press('Escape');
  const second = await rowWhen(page, (row) => row.tip === null, 2000);
  await sleep(300);
  running.push(await paneOf(page).getAttribute('data-running'));
  await page.keyboard.press('Escape');
  await waitIdle(page, 30000);
  const after = await stoppedCount(page);
  record('圆环：生成中从文字框 Tab 到圆环（依次经过权限、选择范围、Effort）时悬停提示显示；Enter 打开详情；Esc 先关详情'
    + '（焦点留在圆环，提示还在，不停止生成），再按 Esc 藏起提示（仍不停止），之后再按 Esc 才停止生成',
  JSON.stringify(stops) === JSON.stringify(ROW_TAB_ORDER) && tipped?.focus === 'usage' && tipped.tip !== null
    && Boolean(opened?.details) && opened.usage?.expanded === 'true' && first?.details === false
    && first.focus === 'usage' && first.tip !== null && second?.tip === null && second.focus === 'usage'
    && running.every((value) => value === 'true') && after === stopped + 1,
  JSON.stringify({ stops, tip: tipped?.tip, opened: opened?.details, first: first && { focus: first.focus,
    tip: first.tip }, second: second && { focus: second.focus, tip: second.tip }, running, stopped, after }));
}

/** @brief 重启后：发出的引用仍能点回（文件、回复），输入框里的芯片还在。 */
async function restart(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Edit', 'README.md');
  await selectLines(page, 2, 2);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  await ctx.app.close();
  await startApp(ctx);
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await sleep(1500);
  await openRow(ctx.page, ctx.file);
  const p = ctx.page;
  const quotes = await sentQuotes(p);
  const chips = await composerChips(p);
  record('重启后：发出的引用还在（来自会话文件的 mori.ref），输入框里的芯片还在', quotes.length === 2
    && quotes[0].label === 'README.md · lines 1–2' && quotes[1].label === 'Response' && chips.length === 1
    && chips[0].label === 'README.md · line 2', JSON.stringify({ quotes, chips }));
  await paneOf(p).getByTestId('sent-quote').first().click();
  await waitViewer(p);
  await sleep(300);
  const state = await viewerState(p);
  record('走查 3：重启后点发出的文件引用仍能回到原位置（打开阅读器，原文已变化时照样提示）', state?.path === 'README.md'
    && state.changed.startsWith('Source changed'), JSON.stringify(state));
  await paneOf(p).locator('.conversation').evaluate((el) => { el.scrollTop = 0; });
  await paneOf(p).getByTestId('sent-quote').last().click();
  await sleep(300);
  const lit = await jumpHighlight(p);
  record('重启后点回复里的引用：滚回去并高亮引用的文字', lit.text === '只有文字的回复', JSON.stringify(lit));
  await shot(p, '3-restart');
}

/** @brief 新加的界面没有小于 12px 的字：右栏（列表和阅读器）、芯片、发出的引用、回复下的操作、浮层、反馈表单。 */
async function smallText(ctx) {
  const { page } = ctx;
  await selectLines(page, 1, 1);
  await popoverShown(page);
  const selectors = ['[data-testid="right-panel"]', '[data-testid="quote-chips"]', '.sent-quotes',
    '[data-testid="reply-actions"]', '[data-testid="selection-popover"]'];
  const small = await page.evaluate((list) => list.flatMap((selector) => [...document.querySelectorAll(selector)])
    .flatMap((root) => [root, ...root.querySelectorAll('*')]).filter((el) => el.textContent?.trim()
      && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => `${el.className}:${getComputedStyle(el).fontSize}`),
  selectors);
  record('新加的界面没有小于 12px 的文字', small.length === 0, small.slice(0, 5).join('; '));
  await clearSelection(page);
}

/** @brief 原位置不在已载入的 50 条里：26 轮的会话重启后只载入最近 50 条，点指向第一轮的芯片先载入到它，再滚过去高亮。 */
async function longHistory(ctx) {
  const { page } = ctx;
  ctx.longFile = await ctrlN(page);
  for (let round = 1; round <= 26; round += 1) await sendAnd(ctx, `plain 第 ${round} 轮`);
  await paneOf(page).getByTestId('reply-actions').first().getByRole('button', { name: 'Attach message as context' })
    .click();
  await ctx.app.close();
  await startApp(ctx);
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await sleep(1500);
  await openRow(ctx.page, ctx.longFile);
  const p = ctx.page;
  const before = await messageCounts(p);
  const hint = await paneOf(p).getByText('Scroll up to load earlier messages').count();
  await paneOf(p).getByTestId('quote-chip').locator('.quote-chip-main').click();
  await sleep(400);
  const after = await messageCounts(p);
  const target = await p.locator(PANE).evaluate((pane) => {
    const first = pane.querySelector('[data-item="assistant"]');
    const box = pane.querySelector('.conversation').getBoundingClientRect();
    const rect = first?.getBoundingClientRect();
    return { flashed: first?.classList.contains('jump-flash'), visible: Boolean(rect && rect.top < box.bottom
      && rect.bottom > box.top), firstUser: pane.querySelector('[data-testid="user-message"]')?.textContent };
  });
  record('原位置不在已载入范围：重启后先显示最近 50 条，点芯片自动载入到第一轮并滚过去高亮', before.user + before.assistant === 50
    && hint === 1 && after.user === 26 && target.flashed && target.visible && target.firstUser === 'plain 第 1 轮',
  JSON.stringify({ before, hint, after, target }));
}

/** @brief 当前会话里唯一的步骤组摘要行的样子（stepsState 的第一行）和标题含 target 的写入卡是否看得见。 */
async function stepRow(page, target) {
  const state = await stepsState(page);
  const card = toolCard(page, 'Write', target);
  return { rows: state.rows.length, ...state.rows[0], card: await card.isVisible(),
    path: await card.getByTestId('tool-path').isVisible() };
}

/**
 * @brief 步骤组（chat.md"步骤组"，2026-10-26 走查 M18）：新会话里写一个文件，一轮结束后写入卡折进一行"1 step"，卡和标题里
 *        的路径都不显示；点那一行展开，点路径照常在右栏打开文件。展开卡、在 Input 里选字点"Attach as context"，
 *        再折起那一组后发出；点发出的引用：先展开那一组，再滚过去高亮那段文字（selection.md"回到原位置"）。
 */
async function stepsFold(ctx) {
  const { page } = ctx;
  ctx.stepsFile = await ctrlN(page);
  await sendAnd(ctx, 'write file: docs/steps.txt', true);
  const folded = await stepRow(page, 'docs/steps.txt');
  record('步骤组：一轮结束后写入卡折进一行"1 step"（按钮，aria-expanded="false"），卡和标题里的路径不显示',
    folded.rows === 1 && folded.text === '1 step' && folded.expanded === 'false' && folded.tag === 'BUTTON'
    && !folded.card && !folded.path, JSON.stringify(folded));
  await rowNotQuotable(page);
  const row = paneOf(page).getByTestId('step-group');
  await row.click();
  const card = toolCard(page, 'Write', 'docs/steps.txt');
  await card.getByTestId('tool-path').click();
  await waitViewer(page);
  const viewer = await viewerState(page);
  record('步骤组：点那一行展开后卡照常显示，点标题里的路径在右栏打开文件', await row.getAttribute('aria-expanded') === 'true'
    && viewer?.path === 'docs/steps.txt' && viewer.first[0] === 'hello from mori', JSON.stringify(viewer));
  await card.getByTestId('tool-status').click();
  await card.locator('.tool-body').waitFor({ timeout: 5000 });
  // 新会话里只有这一张卡：第一个 .tool-pre 是它的 Input（参数的 JSON，content 里有 hello from mori）
  const picked = await selectBetween(page, `${PANE} [data-testid="tool-card"] .tool-pre`, 'hello', 'mori', 0);
  const shown = await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  const chips = await composerChips(page);
  await row.click();
  const refolded = await stepRow(page, 'docs/steps.txt');
  record('步骤组：在展开的卡的 Input 里选字可以引用（芯片"Response"），再点那一行折回', picked && shown
    && chips.length === 1 && chips[0].label === 'Response' && chips[0].title === 'hello from mori'
    && refolded.expanded === 'false' && !refolded.card, JSON.stringify({ chips, refolded }));
  await sendAnd(ctx, 'plain 解释一下');
  await paneOf(page).locator('.conversation').evaluate((el) => { el.scrollTop = 0; });
  await paneOf(page).getByTestId('sent-quote').last().click();
  await sleep(300);
  const lit = await jumpHighlight(page);
  const after = await stepRow(page, 'docs/steps.txt');
  const visible = await page.evaluate(() => {
    const range = [...(CSS.highlights.get('mori-jump') ?? [])][0];
    const rect = range?.getBoundingClientRect();
    const box = document.querySelector('.pane-slot:not([hidden]) .conversation')?.getBoundingClientRect();
    return Boolean(rect && box && rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom);
  });
  record('步骤组：点发出的引用（文字在折起的组里）：先展开那一组（aria-expanded="true"、卡显示），再滚过去高亮那段文字',
    after.expanded === 'true' && after.card && lit.text === 'hello from mori' && visible,
    JSON.stringify({ after, lit, visible }));
  await shot(page, 'steps-fold');
  await turnQuoteFold(ctx);
}

/**
 * @brief 步骤组与整条回复的引用（chat.md"步骤组"、selection.md"整条回复"）：stepsFold 之后把写文件那一组折回，
 *        引用那一轮（"Attach message as context"）发出；点发出的引用：先展开那一轮里折起的组，再高亮整轮，
 *        高亮的部分里有那张写入卡、看得见。
 */
async function turnQuoteFold(ctx) {
  const { page } = ctx;
  const row = paneOf(page).getByTestId('step-group').first();
  if (await row.getAttribute('aria-expanded') === 'true') await row.click();
  const before = await stepRow(page, 'docs/steps.txt');
  await paneOf(page).getByTestId('reply-actions').first().getByRole('button', { name: 'Attach message as context' })
    .click();
  await sendAnd(ctx, 'plain 整轮');
  await paneOf(page).locator('.conversation').evaluate((el) => { el.scrollTop = 0; });
  await paneOf(page).getByTestId('sent-quote').last().click();
  await sleep(300);
  const after = await stepRow(page, 'docs/steps.txt');
  const lit = await paneOf(page).evaluate((pane) => {
    const items = [...pane.querySelectorAll('.jump-flash')];
    // 每一项的外层和里面的 .assistant-message 都带 data-item-key，都会高亮，卡要去重
    const cards = [...new Set(items.flatMap((item) => [...item.querySelectorAll('[data-testid="tool-card"]')]))];
    return { items: items.length, cards: cards.length, shown: cards.filter((card) => card.checkVisibility()).length };
  });
  record('步骤组：点发出的整条回复引用（那一轮的步骤折着）：先展开那一轮里折起的组（aria-expanded="true"、卡显示），'
    + '再高亮整轮，高亮的部分里那张写入卡看得见', before.expanded === 'false' && !before.card
    && after.expanded === 'true' && after.card && lit.items >= 2 && lit.cards === 1 && lit.shown === 1,
  JSON.stringify({ before, after, lit }));
  await shot(page, 'steps-fold-turn');
  await unfoundQuoteFold(ctx);
}

/**
 * @brief 步骤组与找不到文字的选区引用（selection.md"回复里的选区"、chat.md"步骤组"）：stepsFold 引用的是写入卡 Input 里的字，
 *        把卡收起（参数不再画在页面里）、组折回后点那条引用，找不到文字，改为高亮那一条回复：先展开这条回复里折起的组，
 *        高亮的回复里卡看得见，没有文字高亮。
 */
async function unfoundQuoteFold(ctx) {
  const { page } = ctx;
  const row = paneOf(page).getByTestId('step-group').first();
  if (await row.getAttribute('aria-expanded') === 'false') await row.click();
  const card = toolCard(page, 'Write', 'docs/steps.txt');
  if (await card.evaluate((element) => element.open)) await card.getByTestId('tool-status').click();
  await row.click();
  const before = { ...(await stepRow(page, 'docs/steps.txt')), body: await card.locator('.tool-body').count() };
  await paneOf(page).locator('.conversation').evaluate((el) => { el.scrollTop = 0; });
  await paneOf(page).getByTestId('sent-quote').first().click();
  await sleep(300);
  const after = await stepRow(page, 'docs/steps.txt');
  const lit = await jumpHighlight(page);
  const flashed = await paneOf(page).evaluate((pane) => [...pane.querySelectorAll('.jump-flash')]
    .some((item) => [...item.querySelectorAll('[data-testid="tool-card"]')].some((el) => el.checkVisibility())));
  record('步骤组：点发出的选区引用、文字不在页面里（卡收起了）时改为高亮那一条回复：先展开这条回复里折起的组'
    + '（aria-expanded="true"、卡显示），高亮的回复里卡看得见，没有文字高亮', before.expanded === 'false' && !before.card
    && before.body === 0 && after.expanded === 'true' && after.card && lit.text === '' && lit.flashed > 0 && flashed,
  JSON.stringify({ before, after, lit, flashed }));
}

/** @brief 当前会话的右栏没开时点顶栏的"Toggle changes"打开它，等右栏出现。 */
async function openRight(page) {
  if (await page.getByTestId('right-panel').count() === 0) {
    await paneOf(page).getByRole('button', { name: 'Toggle changes' }).click();
  }
  await page.getByTestId('right-panel').waitFor({ timeout: 5000 });
}

/**
 * @brief layout.md"重启之后的右栏"（2026-10-26 补）：展开只记在这次运行的内存里：展开当前会话的右栏后重启 Mori，
 *        再打开这个会话的右栏时不是展开的（中栏照常显示，按钮"Expand"）。
 */
async function expandRestart(ctx) {
  const file = await activeFile(ctx.page);
  await openRight(ctx.page);
  await ctx.page.getByTestId('right-panel').getByRole('button', { name: 'Expand', exact: true }).click();
  const before = await expandState(ctx.page);
  await ctx.app.close();
  await startApp(ctx);
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await sleep(1500);
  await openRow(ctx.page, file);
  await openRight(ctx.page);
  const after = await expandState(ctx.page);
  record('右栏展开只记在这次运行的内存里：展开后重启，再打开这个会话的右栏时不是展开的（中栏照常显示，按钮"Expand"）',
    before.expanded === 'true' && after.expanded === null && after.center !== 'none' && after.button === 'Expand',
    JSON.stringify({ file, before, after }));
}

/**
 * @brief 在页面里选一段：从摘要行所在那条回复的第一段正文开头，到摘要行的字上（toRow）或这段正文的末尾；再派发 mouseup
 *        （选区浮层在鼠标松开时读选区）。返回找没找到那一行和正文。
 */
const selectNearRow = (page, toRow) => page.evaluate(({ css, toRow: onRow }) => {
  const row = document.querySelector(`${css} [data-testid="step-group"]`);
  const prose = row?.closest('[data-item]')?.querySelector('.prose');
  const walker = prose ? document.createTreeWalker(prose, NodeFilter.SHOW_TEXT) : null;
  let text = walker?.nextNode();
  while (text && text.textContent.trim().length < 2) text = walker.nextNode();
  if (!row?.firstChild || !text) return false;
  const [end, offset] = onRow ? [row.firstChild, 1] : [text, text.textContent.length];
  getSelection().setBaseAndExtent(text, 0, end, offset);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return true;
}, { css: PANE, toRow });

/**
 * @brief 摘要行选字时不算引用来源（chat.md"步骤组"的"折起"，同工具卡标题、"Thought process"标了 data-no-quote）：
 *        选区一端落在"1 step"上时松开不出选区浮层；对照：两端都在同一条回复的正文里时照常出浮层。
 */
async function rowNotQuotable(page) {
  const found = await selectNearRow(page, true);
  const onRow = await popoverShown(page, 1000);
  await clearSelection(page);
  await selectNearRow(page, false);
  const inText = await popoverShown(page, 2000);
  await clearSelection(page);
  record('步骤组：摘要行选字时不算引用来源：选区从正文拉到"1 step"上，松开后没有选区浮层；两端都在同一条回复的正文里时'
    + '照常出浮层（对照）', found && !onRow && inText, JSON.stringify({ found, onRow, inText }));
}

/** @brief 当前会话里第一个步骤组摘要行的 aria-expanded（没有时 null）。 */
const firstRow = (page) => paneOf(page).getByTestId('step-group').first()
  .getAttribute('aria-expanded', { timeout: 5000 }).catch(() => null);

/**
 * @brief 展开的组留在展开状态、按组记在会话面板里（chat.md"步骤组"表下，defaults.md"步骤组的展开保存多久"）：
 *        unfoundQuoteFold 的跳转展开了写文件那一组，高亮结束（约 4 秒）之后它仍展开；Ctrl+N 换到新会话、再从侧栏换回来，
 *        仍展开（面板开着时保留）；界面重新载入（Ctrl+R）后打开这个会话回到折起；再点开它、重启 Mori 后打开，也回到折起。
 */
async function stepsKept(ctx) {
  const { page } = ctx;
  await sleep(4500);
  const flashEnded = { expanded: await firstRow(page), flashing: await paneOf(page).locator('.jump-flash').count() };
  await ctrlN(page);
  await openRow(page, ctx.stepsFile);
  const switched = await firstRow(page);
  await page.reload();
  await page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await sleep(1500);
  await openRow(page, ctx.stepsFile);
  const reloaded = await firstRow(page);
  await paneOf(page).getByTestId('step-group').first().click();
  const reopenedBefore = await firstRow(page);
  await ctx.app.close();
  await startApp(ctx);
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await sleep(1500);
  await openRow(ctx.page, ctx.stepsFile);
  const restarted = await firstRow(ctx.page);
  record('步骤组：跳转展开的组在高亮结束（约 4 秒）之后仍展开；换到别的会话再换回来仍展开（面板开着时保留）',
    flashEnded.expanded === 'true' && flashEnded.flashing === 0 && switched === 'true',
  JSON.stringify({ flashEnded, switched }));
  record('步骤组：界面重新载入（Ctrl+R）后打开这个会话，展开过的组回到折起；再点开它、重启 Mori 之后打开，也回到折起',
    reloaded === 'false' && reopenedBefore === 'true' && restarted === 'false',
    JSON.stringify({ reloaded, reopenedBefore, restarted }));
}

/** 先调用、后写字的回复（合成端点 "call then write: <命令>"，synthetic）：bash 调用在前，后面一段比一栏高的正文 */
const CALL_FIRST = 'call then write: echo m4-call-first';

/**
 * @brief 等批准卡出来（先调用、后写字的回复：卡要等这条回复写完才出，这时正文已在组后面），读步骤组与最后一张卡的样子。
 * @return { rows（摘要行数）, cards（看得见、收着的卡数）, prose（看得见的正文段数）, status, visible（最后一张卡看得见） }
 */
async function callFirstLive(page) {
  await paneOf(page).getByTestId('approval-card').waitFor({ timeout: 30000 });
  const state = await stepsState(page);
  const card = paneOf(page).locator('[data-testid="tool-card"]').last();
  return { rows: state.rows.length, cards: state.cards, prose: state.prose,
    status: await card.getAttribute('data-status'), visible: await card.isVisible() };
}

/**
 * @brief 把对话流滚到最后一张工具卡下面 40px（卡在视野上方、离底部远），在视野上沿往下 80px 处的那一段正文上做记号，
 *        返回它的位置、离底部多远、卡是否在视野上方。
 */
const markProbe = (page) => paneOf(page).getByTestId('transcript').evaluate((el) => {
  const card = [...el.querySelectorAll('[data-testid="tool-card"]')].at(-1);
  const box = el.getBoundingClientRect();
  el.scrollTop += card.getBoundingClientRect().bottom - box.top + 40;
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 80);
  const target = hit?.closest('p, li') ?? hit;
  target?.setAttribute('data-anchor-probe', '');
  return { y: target?.getBoundingClientRect().top ?? null, gap: el.scrollHeight - el.scrollTop - el.clientHeight,
    cardAbove: card.getBoundingClientRect().bottom <= box.top, text: target?.textContent.slice(0, 16) ?? null };
});

/**
 * @brief 步骤组的"进行中"与滚动（chat.md"步骤组"）：同一条回复先调用、后写字，等你批准时组后面已有正文，但调用没结束：
 *        没有摘要行，"Waiting for your approval"的卡看得见。再把对话流滚到卡下面（你不在底部，卡在视野上方），Alt+1 允许：
 *        命令结束后组折起，视野里那段正文的位置不变（Chromium 的滚动锚定）。之后 followFold 查你在底部时的样子。
 */
async function callFirst(ctx) {
  const { page, h } = ctx;
  await ctrlN(page);
  await h.send(`${CALL_FIRST} one`);
  const live = await callFirstLive(page);
  record('步骤组：同一条回复先调用、后写字，等你批准时组后面已有正文、但调用没结束：不折起（没有摘要行），'
    + '"Waiting for your approval"的卡看得见', live.rows === 0 && live.status === 'awaiting' && live.visible
    && live.cards.hidden === 0 && live.prose > 0, JSON.stringify(live));
  const probe = await markProbe(page);
  await sleep(300);
  await h.textarea.press('Alt+1');
  await paneOf(page).getByTestId('step-group').waitFor({ timeout: 20000 }).catch(() => {});
  await waitIdle(page, 30000);
  const after = { y: await page.evaluate(() => document.querySelector('[data-anchor-probe]')?.getBoundingClientRect()
    .top ?? null), rows: (await stepsState(page)).rows };
  record('步骤组：你不在底部、上面的组折起时看到的内容不跳：卡在视野上方时允许、命令结束后组折成一行，视野里那段正文的位置不变'
    + '（差不超过 2px）', probe.cardAbove && probe.gap > 24 && probe.y !== null && after.rows.length === 1
    && after.rows[0].expanded === 'false' && Math.abs(after.y - probe.y) <= 2, JSON.stringify({ probe, after }));
  await followFold(ctx);
}

/**
 * @brief 你在底部时折起后照常跟到底部（chat.md"步骤组"的"滚动"）：回到底部再发一次先调用、后写字的回复，停在底部允许，
 *        命令结束、组折起、后面的回复写完之后仍在底部（离底部不超过 24px），其间没有出现"Jump to latest"。
 */
async function followFold(ctx) {
  const { page, h } = ctx;
  await paneOf(page).getByTestId('transcript').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sleep(300);
  await h.send(`${CALL_FIRST} two`);
  await paneOf(page).getByTestId('approval-card').waitFor({ timeout: 30000 });
  await page.evaluate(() => {
    window.__jumpSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('.pane-slot:not([hidden]) [data-testid="new-content"]')) window.__jumpSeen = true;
    }).observe(document.body, { subtree: true, childList: true });
  });
  await h.textarea.press('Alt+1');
  await waitIdle(page, 30000);
  await sleep(500);
  const end = await paneOf(page).getByTestId('transcript').evaluate((el) => ({
    gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), scrollable: el.scrollHeight > el.clientHeight,
    rows: el.querySelectorAll('[data-testid="step-group"][aria-expanded="false"]').length }));
  const jumped = await page.evaluate(() => window.__jumpSeen);
  record('步骤组：你在底部时允许、命令结束后组折起，之后照常跟到底部（离底部不超过 24px），没有出现"Jump to latest"',
    end.scrollable && end.rows === 2 && end.gap <= 24 && !jumped, JSON.stringify({ end, jumped }));
}

const steps = {
  setup, changes, toolPath, reread, openExternal, viewerStates, viewerQuote, chipDraft, sendQuote, jumpFile,
  jumpDeleted, previewOpens, previewQuote, previewSend, previewToggle, copyPath, expandAttach, expandApproval,
  activityLog, narrowHeader, replyMarkdown, noPopover, transcriptQuote, replyActions, feedback, feedbackReply,
  streamingFeedback, keysWithPopover, ringEsc, restart, smallText, longHistory, stepsFold, stepsKept, expandRestart,
  callFirst,
};

const fake = await startFakeEndpoint();
const { root, project } = makeProject();
const userData = mkdtempSync(join(tmpdir(), 'mori-m4-app-data-'));
const ctx = { userData, root, project, pageErrors: [] };
await startApp(ctx);
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && name !== 'setup' && !only.includes(name)) continue;
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      await shot(ctx.page, `${name}-error`);
      await ctx.page.keyboard.press('Escape').catch(() => {});
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app.close().catch(() => {});
  fake.kill();
}
console.log(`[m4-app] project in ${project}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`m4-app${suffix}.json`) ? 0 : 1;
