// M4 整机测试：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖改动与选区（docs/v0/screens/changes.md、selection.md；方案第 7 节 M4 走查 1–5 与反例）：
// 右栏（文件系统第 2 步，docs/specs/file-system.md §5.1、§19.4：v0 改动列表的用例删掉，由 FS-12–14 代替；这里只留
// 右栏在这个会话第一次收到 mori.turn_changes 时自动打开——第一轮是命令写的文件，v0 不因它打开——、This session 的"Open"
// 进入阅读器）；
// 文件阅读器（工具卡路径和"Open"进入、行号、新的一段记到打开的文件时自动重读——编辑和命令改的都算——、"Reload file"、
// "Open in default app"及失败、
// 二进制、超过 1MB、删除、读取失败、文件夹、按 pi 的规则解析路径）；选区浮层（阅读器和回复里出现，你的消息、跨回复、工具卡标题里不出现，
// Esc 先关浮层不停止、浮层开着时 Alt+1 照常；同类的上下文用量圆环：Esc 先关详情、再藏提示，之后才停止）；"Attach as context"（芯片、焦点、判重、移除、草稿与重启、只有芯片也能发、
// 模型收到引用块、mori.ref 条目、发出的引用、回到原位置：没变、挪了行、"Source changed"、"File not found"、回复里的高亮、重启后）；
// 反馈（表单、Ctrl+Enter、"Saved"、JSON 记录、不发给模型、保存失败保留文字、生成中选字反馈不被打断）；
// 回复下的操作（每轮一行、最新一轮常显、悬停与聚焦、Tab 顺序、"Copy"进剪贴板、"Attach message as context"、"Give feedback"、
// 生成中不显示）；
// 新加的界面没有小于 12px 的字；页面没有报错。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m4-app.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m4-app(-packaged).json，截图在 test-results/m4-app(-packaged)/。
// "Open in default app"：经 app.evaluate 换掉主进程的 shell.openPath，只记下路径（不真的打开程序）。
// 读取失败：用 Win32 CreateFileW 独占打开文件（不给任何共享），主进程读时报 EBUSY。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import koffi from 'koffi';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, ctrlN, openRow, paneOf, ROW_TAB_ORDER, rowWhen, stoppedCount, stubFolder, until, waitIdle, waitReady,
  waitRunning,
} from './m3-helpers.mjs';
import {
  assistantIndexWith, changesListing, clearSelection, lastReplyHasActions, composerChips, dragSelect, jumpHighlight,
  messageCounts, NO_CHANGES, PANE, popoverButtons, popoverShown, refEntries, sessionChanges, sessionEntries,
  sessionPaths, replyActionRows, savedDraftRefs, savedFeedback, selectBetween, selectLines, sentQuotes, textPoints,
  V0_CHANGES_NOTE, viewerState, waitSessionPath, waitViewer, FEEDBACK_NOTE_OFF, feedbackNote,
} from './m4-helpers.mjs';
import { OPEN_FOLDER, pageHelpers } from './page.mjs';

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
/** 等一段改动记进会话（结束快照做完、mori.turn_changes 到达）的最长时间 */
const RECORD_WAIT = 15000;
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

/** @brief 点工具卡标题里的路径，等阅读器读完。 */
async function openFromCard(page, verb, target) {
  await toolCard(page, verb, target).getByTestId('tool-path').click();
  await waitViewer(page);
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
 * @brief 首次启动：填连接、测试成功、打开项目文件夹；右栏默认关闭，手动打开时 This session 为"No changes yet."。
 *        手动开关过的会话以你为准（不再自动打开），所以之后的步骤用 Ctrl+N 新建的会话。
 */
async function setup(ctx) {
  const { app, page, h } = ctx;
  // v1（规格 §14.4）：首次启动填英文表单、区域选 Local，等探针都跑完再打开文件夹（page.mjs setupFirstRun）。
  await h.setupFirstRun({ baseUrl, apiKey: testKey });
  await stubFolder(app, ctx.project);
  await page.getByRole('button', { name: OPEN_FOLDER }).first().click();
  await waitReady(page);
  const closed = await page.getByTestId('right-panel').count() === 0;
  await paneOf(page).getByRole('button', { name: 'Toggle changes' }).click();
  const empty = await sessionChanges(page);
  record('Right panel: closed by default while there are no changes; opened by hand, This session reads '
    + `"${NO_CHANGES}"`, closed && empty?.empty === NO_CHANGES && empty.turns.length === 0, JSON.stringify(empty));
  await paneOf(page).getByRole('button', { name: 'Toggle changes' }).click();
  ctx.file = await ctrlN(page);
}

/**
 * @brief 走查 1 的操作：命令写一个、README 改两次、新写一个、被拒绝的编辑（之后的步骤用到这些文件，对话也保持原来的
 *        长短）。v0 改动列表的检查删掉了（docs/specs/file-system.md §19.4，由 FS-12–14 代替）；留下自动打开：
 *        这个会话第一次收到 mori.turn_changes（changes）时右栏自动打开到 Changes（§5.1）。第一轮只有命令写的 cmd.txt：
 *        v0 只因编辑、写入的结果打开右栏、也不列命令改的文件，所以这一步分得出新旧两种依据。
 */
async function changes(ctx) {
  const { page } = ctx;
  const before = await page.getByTestId('right-panel').count();
  await sendAnd(ctx, 'run: echo cmd > cmd.txt', true);
  const auto = await waitSessionPath(page, 'cmd.txt', RECORD_WAIT);
  const recorded = changesListing(ctx.file, 'cmd.txt');
  record('Right panel: on the first mori.turn_changes (changes) of the session it opens by itself to Changes although '
    + `only a command changed a file: This session lists cmd.txt, with no "${V0_CHANGES_NOTE}"`, before === 0
    && existsSync(join(ctx.project, 'cmd.txt')) && Boolean(auto) && recorded >= 1
    && !auto.text.includes(V0_CHANGES_NOTE), JSON.stringify({ before, recorded, auto }));
  await sendAnd(ctx, `edit README: ${TITLE}`, true);
  const edited = await waitSessionPath(page, 'README.md', RECORD_WAIT);
  const [top, below] = edited?.turns ?? [];
  const has = (turn, path) => Boolean(turn?.files.some((file) => file.path === path));
  record('Right panel: the next turn\'s edit is a new group on top (Turn 2 lists README.md, not cmd.txt), the '
    + 'command\'s turn below it (Turn 1 lists cmd.txt)', top?.turn === 2 && has(top, 'README.md')
    && !has(top, 'cmd.txt') && below?.turn === 1 && has(below, 'cmd.txt'), JSON.stringify(edited?.turns));
  await sendAnd(ctx, 'write file: docs/new.md', true);
  await sendAnd(ctx, `edit README: ${TITLE} (edited)`, true);
  await sendAnd(ctx, 'edit README: # rejected title', 'reject');
  await shot(page, '1-changes');
}

/** @brief 走查 2 前半：点工具卡里的路径打开阅读器（不展开工具卡）；"← Changes"回到 Changes；This session 的"Open"。 */
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
  const back = await waitSessionPath(page, 'docs/new.md', RECORD_WAIT);
  await page.getByRole('button', { name: 'Open docs/new.md' }).click();
  await waitViewer(page);
  const opened = await viewerState(page);
  record('Viewer: "← Changes" goes back to Changes (This session lists docs/new.md); its "Open" opens the file',
    Boolean(back) && opened?.path === 'docs/new.md' && opened.first[0] === 'hello from mori',
  JSON.stringify({ paths: sessionPaths(back), opened }));
  await shot(page, '2-viewer');
}

/**
 * @brief 新的一段记到打开的文件时自动重读（docs/specs/file-system.md §5.1：依据是当前分支上列出这个文件的 changes
 *        记录条数）：编辑改的、命令改的（commandReread）都重读；外部改的要点"Reload file"。
 */
async function reread(ctx) {
  const { page } = ctx;
  await openFromCard(page, 'Edit', 'README.md');
  const listed = changesListing(ctx.file, 'README.md');
  await sendAnd(ctx, `edit README: ${TITLE} (edited) (edited)`, true);
  const auto = await until(async () => (await viewerState(page))?.first[0]?.endsWith('(edited) (edited) (edited)'),
    RECORD_WAIT);
  const segment = await until(() => changesListing(ctx.file, 'README.md') > listed, RECORD_WAIT);
  record('Viewer: a new segment recorded for the open file (a mori.turn_changes whose changes list README.md) reloads '
    + 'it', Boolean(auto) && Boolean(segment), JSON.stringify({ listed, now: changesListing(ctx.file, 'README.md'),
    first: (await viewerState(page))?.first }));
  await commandReread(ctx);
  const file = join(ctx.project, 'README.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}外部加的一行\n`);
  await sleep(800);
  const before = await viewerState(page);
  await page.getByRole('button', { name: 'Reload file' }).click();
  await waitViewer(page);
  const after = await viewerState(page);
  record('阅读器：外部改的不自动读（不监视文件），点"重新读取"后显示新内容', before.lineCount + 1 === after.lineCount,
    `${before.lineCount} → ${after.lineCount}`);
}

/**
 * @brief 命令改了打开的文件：结束快照记下新的一段（changes 列出 README.md）后阅读器同样重读（§5.1"不论是 edit、write、
 *        命令还是后台 Agent 改的"；v0 只因编辑、写入的结果重读，这一步分得出新旧两种依据）。只在文件末尾加一行，
 *        前几行不变（之后的引用步骤按第 1–3 行）。
 */
async function commandReread(ctx) {
  const { page } = ctx;
  const lines = (await viewerState(page))?.lineCount ?? 0;
  const listed = changesListing(ctx.file, 'README.md');
  await sendAnd(ctx, 'run: echo more >> README.md', true);
  const reloaded = await until(async () => (await viewerState(page))?.lineCount === lines + 1, RECORD_WAIT);
  const segment = await until(() => changesListing(ctx.file, 'README.md') > listed, RECORD_WAIT);
  record('Viewer: a command that changed the open file reloads it too once its segment is recorded (README.md shows '
    + 'one more line; v0 reloaded only for edit and write results)', lines > 0 && Boolean(reloaded) && Boolean(segment),
  JSON.stringify({ lines, now: (await viewerState(page))?.lineCount, listed,
    after: changesListing(ctx.file, 'README.md') }));
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
    RECORD_WAIT);
  record('Viewer opened from a reference chip (absolute path): a new segment recorded for this file (the record has '
    + 'the relative path) reloads it too', Boolean(reread), JSON.stringify((await viewerState(page))?.first));
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

/** @brief selector 选出的元素里第一个文字同时含 a、b 的下标；没有时为 -1（selectBetween 随之选不到、返回 false）。 */
const indexWith = (page, selector, a, b) => page.locator(selector).evaluateAll((items, [x, y]) => items
  .findIndex((item) => item.textContent.includes(x) && item.textContent.includes(y)), [a, b]);

/**
 * @brief 选区浮层不出现的地方：你的消息、跨两条回复、工具卡标题。这个会话的第一条消息是命令（changes），所以按文字找
 *        编辑 README 的那条消息和它的工具卡。
 */
async function noPopover(ctx) {
  const { page } = ctx;
  const cases = [];
  const message = `${PANE} [data-testid="user-message"]`;
  const card = `${PANE} [data-testid="tool-card"] summary`;
  await clearSelection(page);
  cases.push(['你的消息', await selectBetween(page, message, 'edit', 'README',
    await indexWith(page, message, 'edit', 'README'))]);
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
  await selectBetween(page, card, 'Edit', 'README', await indexWith(page, card, 'Edit', 'README'));
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

const steps = {
  setup, changes, toolPath, reread, openExternal, viewerStates, viewerQuote, chipDraft, sendQuote, jumpFile,
  jumpDeleted, noPopover, transcriptQuote, replyActions, feedback, feedbackReply, streamingFeedback, keysWithPopover,
  ringEsc, restart, smallText, longHistory,
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
