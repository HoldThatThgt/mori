// M5 整机测试：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖分屏与会话引用（docs/v0/screens/split.md、session-refs.md；方案第 7 节 M5 走查 1–6 与反例）：
// 分屏（菜单与键盘、拖到中栏左右半边、拖已在中栏的会话只切焦点、侧栏点会话换掉焦点所在的一栏、Ctrl+N、两栏各自发消息和批准、
// Esc 只停焦点所在的一栏、F8 与右栏跟随焦点、点另一栏的右栏开关、"Close pane"不落空
// （toggleOther、closeKeeps；2026-10-26 协作开关移进模型菜单，teamOther 去掉）、分屏中线的拖动 / 方向键 / 双击 / 保存、放不下时右栏先收起和浮出、
// 最小窗口、关闭一栏不停止生成、设置页来回、归档删除时这一栏关闭）；会话引用（拖进输入框、菜单"Attach as context"与不可用的情况、
// 只用键盘、芯片与预览、改范围、内容不含思考和工具输出、模型收到引用块、mori.ref 条目、跳回原会话、改名、重启后、
// 原会话已删除、引用正在生成的会话、没有可引用的内容、超过 2 万字默认最近 5 轮、草稿里的芯片、预览的标题不被压矮、
// 很长的会话名截断加省略号）；没有小于 12px 的字；页面没有报错。
// 2026-10-21 起（docs/v0/composer-pickers.md）：分屏时顶栏里会话名的地方（titleRoomCheck）；分屏各栏的输入框下面一行在
// 窄栏里的样子、截短、往上打开的菜单、"Queue for later"（splitRows）；Effort 是支持思考的强度时 280px 的一栏（effortWidths，
// 另起一次 Mori，首次启动时勾上 Supports thinking）；F8 报告的"Model range""Effort""Pane width"（左右两栏各按一次）；
// 最小窗口时两栏的输入框下面一行。
// 2026-10-26 走查 M23（WP-13）：分屏时右栏的"Expand" / "Collapse"、F8 的"Open · Expanded"、展开时换到右栏关着的会话
// 不会是空白（splitExpand）。
// 2026-10-26 走查 M18（WP-14，chat.md"步骤组"）：点会话引用跳回 A 时，第 2–3 轮里折起的步骤组先展开（jumpBack）。
// 2026-10-26（docs/v0/screens/window.md"关掉窗口"，WP-20 记录"状态表各行的用例"）：分屏、两栏的草稿在关掉窗口
// （藏进系统托盘）再点托盘图标回来之后原样（trayKeepsLayout；托盘经 tray-helpers.mjs 在主进程里找到）。
// 2026-10-26 补测（WP-13 状态表各行的用例）：单栏时展开、点侧栏另一个会话（singleExpand）；分屏放得下时右栏的上限、
// 放不下时浮在上层（splitRightMax）；展开时 F8 的"Pane width: None"和"Expand right panel"、展开后"Close panel"
// （splitExpand）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m5-app.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m5-app(-packaged).json，截图在 test-results/m5-app(-packaged)/。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import {
  openMenuOn, rowOf, samePath, savedArchived, stubFolder, until, waitReady, waitStatus,
} from './m3-helpers.mjs';
import {
  composerRow, focusName, openRingDetails, popoverChecks, rowProblems, rowSummary, setPaneWidth, tabPath,
} from './m1-layout.mjs';
import { refEntries } from './m4-helpers.mjs';
import {
  centerPoint, chipsAt, closeRightPanel, composerAt, dragWithHint, flashedAt, headingTruncated, headingWhole, paneAt,
  paneView, pickRange, previewHeading, previewState, reportField, reportLabels, savedLayout, sendAt, sentSessionRefs,
  setSplitWidth, slotSelector, smallText, splitState, titleProblems, titleRoom, viewProblems, waitPaneIdle,
  waitPaneReady, waitPaneRunning, waitPreview, waitSessionChip, waitSplit,
} from './m5-helpers.mjs';
import { OPEN_FOLDER, pageHelpers } from './page.mjs';
import {
  clickTrayIcon, closeWindow, findTray, offScreen, onScreen, recordBalloons, waitWindow,
} from './tray-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const port = 4335;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m5-not-a-real-key';
const shots = join(appRoot, `test-results/m5-app${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
/** README 里只出现在工具输出里的一行（合成端点的工具结果摘要只取前 80 个字，到不了这里） */
const TOOL_ONLY = 'TOOL-OUTPUT-ONLY-MARKER';
const MENU_ORDER = 'Rename,Attach as context,Open in split view,Archive,Delete…';
/** 分屏各栏量输入框下面一行时的宽度（composer-pickers.md"测试要改的地方"新加的检查第 2 条里分屏才有的窄栏和各档的边） */
const SPLIT_WIDTHS = [280, 300, 340, 341, 370, 400, 401, 460, 461, 490];
/** 量"有字"时输入框里的字（"Queue for later"发出的也是它） */
const SPLIT_DRAFT = 'plain 窄栏里排队的字';
/** 从文字框按 Tab 先后停到的这一行的四项（models.md"位置"） */
const ROW_PATH = 'permission-button,model-button,thinking-button,usage';
/** 选择范围按钮悬停的第二行：首次启动建的提供商名（2026-10-26 起不带区域） */
const APP_OPTS = { modelTip: 'Mori endpoint' };
/** 关掉窗口之前两栏输入框里写的草稿（trayKeepsLayout） */
const TRAY_DRAFTS = { left: 'plain 左栏关窗口之前的草稿', right: 'plain 右栏关窗口之前的草稿' };
/** 很长的会话名（中英文都有），预览的标题一行放不下 */
const LONG_NAME = 'A very long session name that keeps going so the preview heading cannot fit it on a single line'
  + ' · 很长的会话名，用来看预览的标题放不下时截断加省略号、不折行';

// ---------- 准备 ----------

/** @brief 启动合成端点，最多等 15 秒。 */
function startFakeEndpoint() {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '10', FAKE_FIRST_DELAY_MS: '100',
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

/** @brief 测试用的项目：README（最后一行只会出现在工具输出里）、src/a.ts。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m5-app-'));
  const project = join(root, 'm5proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used to check Mori against a '
    + 'model and it has one README file and one source file.\n\n' + `${TOOL_ONLY}\n`);
  writeFileSync(join(project, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n'
    + '  return a + b;\n}\n');
  return { root, project };
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
}

/** @brief 窗口（含边框和菜单栏）现在的大小 [宽, 高]。 */
const windowSize = (ctx) => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());

/**
 * @brief 按 windowSize 量出的大小设窗口。回到启动时的大小要用它：这个窗口有菜单栏，用 setContentSize 设回
 *        getContentSize 的值时，页面会比启动时高出菜单栏的高度。
 */
async function setWindowSize(ctx, [width, height]) {
  await ctx.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.w, size.h),
    { w: width, h: height });
  await sleep(500);
}

/** @brief 页面的大小"宽×高"。 */
const viewSize = (page) => page.evaluate(() => `${innerWidth}×${innerHeight}`);

/** @brief 改窗口大小（主进程里改，界面随之响应）。 */
async function resizeWindow(ctx, width, height) {
  await ctx.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
    { w: width, h: height });
  await sleep(500);
}

/** @brief 在某一栏发一条消息，等这一轮结束。 */
async function sendIn(page, side, text) {
  await sendAt(page, side, text);
  await waitPaneIdle(page, side);
}

/** @brief 会话文件为 file 的会话在界面里的标识。 */
const keyOf = (page, file) => rowOf(page, file).first().getAttribute('data-row');

/**
 * @brief 焦点放在会话行上按 Shift+F10 打开菜单，返回各项的文字和不能用的原因。
 *        用 m3-helpers 的 openMenuOn：先等两帧再放焦点。点会话行后界面在下一帧把焦点放进输入框（split.ts focusComposer），
 *        紧接着放到另一行的焦点会被它移走，Shift+F10 就落在输入框里（打包程序上 keyboardReference 稳定出现过）。
 */
async function menuOf(page, file) {
  const menu = await openMenuOn(page, rowOf(page, file).first());
  return menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => ({
    label: item.childNodes[0]?.textContent ?? '', blocked: item.querySelector('.menu-hint')?.textContent ?? null,
    disabled: item.disabled })));
}

/** @brief 打开着的菜单里用 ↓ 走到 label 那一项，按 Enter（先等焦点进了菜单）。 */
async function chooseByKeys(page, label) {
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="session-menu"]'), null,
    { timeout: 5000 });
  const labels = await page.getByTestId('session-menu').getByRole('menuitem').evaluateAll((items) => items
    .filter((item) => !item.disabled).map((item) => item.childNodes[0]?.textContent ?? ''));
  for (let index = 0; index < labels.indexOf(label); index += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

/** @brief 新建会话（Ctrl+N），等它就绪，返回它的会话文件。 */
async function newSession(page) {
  const before = await page.locator('.pane-slot').count();
  await page.keyboard.press('Control+n');
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, before, { timeout: 20000 });
  await waitPaneReady(page, 'focused');
  return page.locator('.session-item.active').first().getAttribute('data-file');
}

/** @brief 焦点所在的一栏的会话名。 */
const focusedTitle = async (page) => (await splitState(page)).focusedTitle;

// ---------- 步骤 ----------

/**
 * @brief 准备：首次启动填连接、打开项目（会话 A：四轮，第 2 轮读 README，第 3 轮有思考）；Ctrl+N 建 B（一轮）；
 *        Ctrl+N 建 C（还没有消息）。
 */
async function setup(ctx) {
  const { app, page, h } = ctx;
  ctx.defaultSize = await windowSize(ctx);
  // v1（规格 §14.4）：首次启动填英文表单，等探针都跑完再打开文件夹（page.mjs setupFirstRun）。
  await h.setupFirstRun({ baseUrl, apiKey: testKey });
  await stubFolder(app, ctx.project);
  await page.getByRole('button', { name: OPEN_FOLDER }).first().click();
  await waitReady(page);
  for (const text of ['plain A 第一轮', 'read the README A 第二轮', 'think first A 第三轮', 'plain A 第四轮']) {
    await sendIn(page, 'focused', text);
  }
  ctx.a = await page.locator('.session-item.active').first().getAttribute('data-file');
  ctx.b = await newSession(page);
  await sendIn(page, 'focused', 'plain B 第一轮');
  ctx.c = await newSession(page);
  ctx.titles = { a: 'plain A 第一轮', b: 'plain B 第一轮' };
  record('准备：会话 A（四轮）、B（一轮）、C（还没有消息）', Boolean(ctx.a && ctx.b && ctx.c), JSON.stringify(
    { a: ctx.a, b: ctx.b, c: ctx.c }));
}

/** @brief 两栏的位置、会话、会话名和焦点（比较关掉窗口前后用）。 */
const paneLayout = (state) => state.slots.map((slot) => ({ side: slot.side, key: slot.key, title: slot.title,
  focused: slot.focused }));

/** @brief 两栏输入框里的字。 */
const draftsOf = async (page) => ({ left: await composerAt(page, 'left').inputValue(),
  right: await composerAt(page, 'right').inputValue() });

/**
 * @brief 关掉窗口时界面状态原样（docs/v0/screens/window.md"关掉窗口"：草稿、分屏原样留着）：在右侧分屏打开 A（C 在左），
 *        两栏各写一段草稿，关掉窗口（藏进系统托盘）、点托盘图标回来：仍是分屏，两栏的会话、焦点和草稿都和关掉前一样。
 *        最后清掉草稿、关上右栏，回到 setup 之后的样子（单栏的 C），后面的步骤照常。
 */
async function trayKeepsLayout(ctx) {
  const { app, page } = ctx;
  await menuOf(page, ctx.a);
  await chooseByKeys(page, 'Open in split view');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  await composerAt(page, 'left').fill(TRAY_DRAFTS.left);
  await composerAt(page, 'right').fill(TRAY_DRAFTS.right);
  const before = await splitState(page);
  // 第一次关窗口的气泡只记下、不真的弹出系统通知（m0-smoke 检查它的内容）
  await recordBalloons(app);
  await closeWindow(app);
  const hidden = await waitWindow(app, offScreen, 5000);
  await findTray(app);
  await clickTrayIcon(app);
  const shown = await waitWindow(app, onScreen, 5000);
  const after = await splitState(page);
  const drafts = await draftsOf(page);
  record('关掉窗口（藏进系统托盘）再点托盘图标回来：仍是分屏，两栏的会话、焦点和输入框里的草稿都和关掉前一样',
    hidden.ok && shown.ok && before.split && after.split
    && JSON.stringify(paneLayout(after)) === JSON.stringify(paneLayout(before))
    && JSON.stringify(drafts) === JSON.stringify(TRAY_DRAFTS),
  JSON.stringify({ hidden: hidden.state, shown: shown.state, before: paneLayout(before), after: paneLayout(after),
    drafts }));
  await composerAt(page, 'left').fill('');
  await composerAt(page, 'right').fill('');
  await paneAt(page, 'right').getByTestId('close-pane').click();
  await waitSplit(page, false);
}

/** @brief 走查 6：菜单（只用键盘）"Open in split view"；菜单项与不能用的情况。 */
async function menuSplit(ctx) {
  const { page } = ctx;
  const onCurrent = await menuOf(page, ctx.c);
  // 菜单关闭后下一帧焦点回到会话行；menuOf 先等它落定再打开下一个菜单。
  await page.keyboard.press('Escape');
  const onA = await menuOf(page, ctx.a);
  await chooseByKeys(page, 'Open in split view');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  const state = await splitState(page);
  await page.waitForFunction(() => document.activeElement?.closest('.pane-slot')?.dataset.side === 'right', null,
    { timeout: 2000 }).catch(() => {});
  const focusIn = await page.evaluate(() => document.activeElement?.closest('.pane-slot')?.dataset.side
    ?? `${document.activeElement?.tagName}.${document.activeElement?.className}`);
  const blocked = (items, label) => items.find((item) => item.label === label)?.blocked ?? null;
  record('菜单：重命名、引用到当前会话、在右侧分屏打开、归档、删除；单栏里显示的会话"在右侧分屏打开"不可用（已经打开），'
    + '没有消息的当前会话"引用到当前会话"不可用', onA.map((item) => item.label).join() === MENU_ORDER
    && blocked(onCurrent, 'Open in split view') === 'Already open'
    && blocked(onCurrent, 'Attach as context') === 'This is the current session'
    && blocked(onA, 'Attach as context') === null, JSON.stringify({ onCurrent, onA }));
  record('走查 6：只用键盘（Shift+F10、↓、Enter）在右侧分屏打开 A：左右分屏，A 在右栏、有焦点，焦点在它的输入框',
    state.split && state.slots[1].title === ctx.titles.a && state.slots[1].focused && focusIn === 'right'
    && state.slots.every((slot) => slot.width >= 280), JSON.stringify({ state, focusIn }));
  const classes = { a: await rowOf(page, ctx.a).first().getAttribute('class'),
    c: await rowOf(page, ctx.c).first().getAttribute('class') };
  record('侧栏：焦点所在的会话行高亮，另一栏的会话行浅色标出', classes.a.includes('active')
    && classes.c.includes('in-split'), JSON.stringify(classes));
  await shot(page, '6-menu-split');
}

/**
 * @brief 拖已在中栏的会话只切焦点；拖到左半边换掉左栏；侧栏点会话换掉焦点所在的一栏；Ctrl+N 也在焦点所在的一栏。
 *        结束时分屏是 [C, D]（D 是 Ctrl+N 新建的），之后两栏的步骤在 C、D 里做，A 保持四轮。
 */
async function dragAndPlace(ctx) {
  const { page } = ctx;
  const sameHint = await dragWithHint(page, rowOf(page, ctx.c).first(), page.locator('.center'),
    await centerPoint(page, 'right'));
  const afterSame = await splitState(page);
  const leftHint = await dragWithHint(page, rowOf(page, ctx.b).first(), page.locator('.center'),
    await centerPoint(page, 'left'));
  const afterLeft = await splitState(page);
  record('拖已在中栏的会话（C）：提示"已经打开 · 松开切换到这一栏"，松开只把焦点切到 C，不出现第三栏',
    sameHint?.kind === 'focus' && sameHint.text === 'Already open · Drop to switch to this pane'
    && afterSame.slots.length === 2 && afterSame.slots[0].focused,
  JSON.stringify({ sameHint, afterSame: afterSame.slots }));
  record('走查 1：把会话 B 拖到中栏左半边：提示"松开以在左侧分屏打开"；松开后 B 换掉左栏、得到焦点，C 照常开在后台',
    leftHint?.text === 'Drop to open in split view on the left' && afterLeft.slots[0].title === ctx.titles.b
    && afterLeft.slots[0].focused && afterLeft.slots[1].title === ctx.titles.a
    && await page.locator(`.pane-slot[data-tab="${await keyOf(page, ctx.c)}"]`).count() === 1,
  JSON.stringify(afterLeft.slots));
  await rowOf(page, ctx.c).first().click();
  const clicked = await splitState(page);
  await rowOf(page, ctx.a).first().click();
  const toA = await splitState(page);
  record('分屏时在侧栏点不在中栏的会话（C）：它换掉焦点所在的左栏；点已在右栏的 A 只把焦点切过去',
    clicked.slots[0].title === 'New session' && clicked.slots[0].focused && toA.slots[1].focused
    && toA.slots[0].key === clicked.slots[0].key, JSON.stringify({ clicked: clicked.slots, toA: toA.slots }));
  const d = await newSession(page);
  const withD = await splitState(page);
  record('分屏时 Ctrl+N：新会话出现在焦点所在的那一栏（右栏），左栏不变', withD.slots[1].focused
    && withD.slots[1].key === await keyOf(page, d) && withD.slots[0].key === toA.slots[0].key,
  JSON.stringify(withD.slots));
  await plusInSplit(ctx, d);
  ctx.d = d;
}

/**
 * @brief 分屏时点项目行的 +（split.md"两栏里的操作"、sessions.md"项目行的 +"）：焦点在右栏（D）时点 m5proj 行上的 +，
 *        新会话出现在焦点所在的那一栏（右栏）、得到焦点（焦点在它的输入框），左栏不变；侧栏里新会话在这个项目下，名为
 *        "New session"。之后在侧栏点 D，右栏换回 D（后面的步骤在 [C, D] 里做）。
 */
async function plusInSplit(ctx, d) {
  const { page } = ctx;
  const before = await splitState(page);
  const count = await page.locator('.pane-slot').count();
  await page.getByTestId('project-new-session').first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, count, { timeout: 20000 });
  await waitPaneReady(page, 'focused');
  await page.waitForFunction(() => document.activeElement?.closest('.pane-slot')?.dataset.side === 'right', null,
    { timeout: 2000 }).catch(() => {});
  const after = await splitState(page);
  const row = await page.locator('.session-item.active').first().evaluate((el) => ({ key: el.dataset.row,
    title: el.querySelector('.session-label')?.textContent ?? '', cwd: el.closest('.project-group')?.dataset.cwd }));
  const focus = await page.evaluate(() => ({ side: document.activeElement?.closest('.pane-slot')?.dataset.side ?? null,
    composer: document.activeElement?.tagName === 'TEXTAREA' }));
  record('分屏时点项目行的 +：新会话出现在焦点所在的那一栏（右栏）并得到焦点（焦点在它的输入框），左栏不变；侧栏里'
    + '新会话在这个项目下，名为"New session"', before.slots[1]?.focused && after.split && after.slots[1]?.focused
    && after.slots[1].key === row.key && after.slots[1].key !== before.slots[1].key
    && after.slots[0].key === before.slots[0].key && focus.side === 'right' && focus.composer
    && samePath(row.cwd, ctx.project) && row.title === 'New session',
  JSON.stringify({ before: before.slots, after: after.slots, row, focus }));
  await rowOf(page, d).first().click();
  await page.waitForFunction((key) => document.querySelector(`.pane-slot[data-side="right"][data-tab="${key}"]`),
    await keyOf(page, d), { timeout: 10000 });
  await waitPaneReady(page, 'right');
}

/** @brief 走查 1 后半与走查 2：两边各自发消息、各自批准；Esc 只停止焦点所在的一栏。 */
async function twoPanes(ctx) {
  const { page } = ctx;
  await sendAt(page, 'right', 'edit README: # Mori fixture project');
  ctx.titles.d = 'edit README: # Mori …';
  await sendAt(page, 'left', 'write file: docs/c.md');
  await paneAt(page, 'right').getByTestId('approval-card').waitFor({ timeout: 20000 });
  await paneAt(page, 'left').getByTestId('approval-card').waitFor({ timeout: 20000 });
  await composerAt(page, 'left').press('Alt+1');
  await sleep(600);
  const rightStill = await paneAt(page, 'right').getByTestId('approval-card').count();
  await composerAt(page, 'right').click();
  await composerAt(page, 'right').press('Alt+1');
  await waitPaneIdle(page, 'left');
  await waitPaneIdle(page, 'right');
  record('走查 1：两边各自出批准卡；在左栏按 Alt+1 只批准左栏的卡，右栏的卡还在；之后各自完成', rightStill === 1
    && existsSync(join(ctx.project, 'docs', 'c.md')) && readFileSync(join(ctx.project, 'README.md'), 'utf8')
      .startsWith('# Mori fixture project (edited)'), `right card after left Alt+1: ${rightStill}`);
  await sendAt(page, 'left', 'wait 6s');
  await sendAt(page, 'right', 'wait 4s');
  // 两栏都开始生成之后再按 Esc：发出之后先拍运行开始的快照（docs/specs/file-system.md §4.5），这时按 Esc 也能停下，
  // 但右栏可能来不及显示生成中，waitPaneIdle 先等它生成中（最多 20 秒）时左栏已经生成完了
  await waitPaneRunning(page, 'left');
  await waitPaneRunning(page, 'right');
  await composerAt(page, 'right').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction((css) => {
    const pane = document.querySelector(css);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false';
  }, `${slotSelector('right')} [data-testid="chat-pane"]`, { timeout: 30000 });
  const leftRunning = (await splitState(page)).slots[0].running;
  await waitPaneIdle(page, 'left');
  const notices = async (side) => paneAt(page, side).getByTestId('notice').allInnerTexts();
  const left = await notices('left');
  const right = await notices('right');
  const leftReply = await paneAt(page, 'left').getByTestId('assistant').last().innerText();
  record('走查 2：焦点在右栏按 Esc 只停止右栏（"已停止"），左栏照常生成完（"等了 6 秒"）', right.some((t) => t.startsWith(
    'Stopped')) && !left.some((t) => t.startsWith('Stopped')) && leftRunning && leftReply.includes('等了 6 秒'),
  JSON.stringify({ left, right, leftRunning, leftReply }));
}

/**
 * @brief 右栏 This session 此刻的各轮（docs/v1/screens/fs-changes.md "This session"）：[{ title（组标题 Turn n · 之后）,
 *        overlap（有 turn-overlap 说明）, files（路径） }]；右栏没开或打开的是阅读器时为 null。
 */
const sessionTurnsOf = (page) => page.evaluate(() => {
  const section = document.querySelector('[data-testid="right-panel"] [data-testid="session-changes"]');
  if (!section) return null;
  return [...section.querySelectorAll('[data-testid="turn-changes"]')].map((turn) => ({
    title: (turn.querySelector('.turn-title')?.textContent ?? '').replace(/^Turn \d+ · /, ''),
    overlap: Boolean(turn.querySelector('[data-testid="turn-overlap"]')),
    files: [...turn.querySelectorAll('[data-testid="turn-file"]')].map((file) => file.dataset.path) }));
});

/**
 * @brief This session 是不是这一栏的会话的：每一轮的标题都是这个会话发的消息，own 那一轮列出 ownFile；另一栏的会话
 *        改的文件只在带重叠说明的轮里（两栏开在同一文件夹、同时运行时那一段两边都记，file-system.md §4.5 第 3 步、§5.3）。
 */
function showsPane(turns, { messages, own, ownFile, otherFile }) {
  return Boolean(turns?.length) && turns.every((turn) => messages.includes(turn.title))
    && turns.some((turn) => turn.title === own && turn.files.includes(ownFile))
    && turns.every((turn) => !turn.files.includes(otherFile) || turn.overlap);
}

/** @brief 走查 2：右栏和 F8 跟随焦点所在的一栏。 */
async function followFocus(ctx) {
  const { page } = ctx;
  await paneAt(page, 'right').getByTestId('transcript').click({ position: { x: 10, y: 10 } });
  await sleep(300);
  const onRight = await sessionTurnsOf(page);
  await paneAt(page, 'left').getByTestId('transcript').click({ position: { x: 10, y: 10 } });
  await sleep(300);
  const onLeft = await sessionTurnsOf(page);
  const d = { messages: ['edit README: # Mori fixture project', 'wait 4s'], own: 'edit README: # Mori fixture project',
    ownFile: 'README.md', otherFile: 'docs/c.md' };
  const c = { messages: ['write file: docs/c.md', 'wait 6s'], own: 'write file: docs/c.md', ownFile: 'docs/c.md',
    otherFile: 'README.md' };
  record('走查 2：右栏跟随焦点所在的一栏（右栏 D 改了 README.md，左栏 C 写了 docs/c.md）：This session 的各轮是焦点所在'
    + '那一栏的消息；两栏同一文件夹同时运行时，另一栏改的文件只出现在带重叠说明的那一轮里',
  showsPane(onRight, d) && showsPane(onLeft, c), JSON.stringify({ onRight, onLeft }));
  await composerAt(page, 'left').click();
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('issue-what').fill('M5 分屏 F8');
  await page.getByTestId('issue-dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('issue-saved').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  const dir = join(ctx.userData, 'ui-issues');
  const report = readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(dir, name),
    'utf8')).at(-1) ?? '';
  const left = (await splitState(page)).slots[0].title;
  record('走查 2：F8 跟随焦点：报告的"当前会话"是焦点所在的左栏，"分屏"一行写明两栏、焦点在左栏',
    report.includes(`Current session: ${left}`)
    && /Split view: Left: .+ · Right: .+ \(focus in the left pane\)/.test(report),
    oneLine(report.split('\n').filter((line) => /Current session|Split view/.test(line)).join(' | ')));
  await viewFields(page, report, 'left');
  await shot(page, '2-follow');
  await composerAt(page, 'right').click();
  await viewFields(page, await saveIssue(ctx, 'M5 分屏 F8 右栏'), 'right');
}

/** @brief side 那一栏标题行上的右栏开关。 */
const rightToggle = (page, side) => paneAt(page, side).locator('.topbar')
  .getByRole('button', { name: 'Toggle changes' });

/** @brief 点 side 那一栏的输入框（焦点切过去），再让它自己的右栏开关是 open（不同时点一下）。 */
async function setOwnRight(page, side, open) {
  await composerAt(page, side).click();
  const toggle = rightToggle(page, side);
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
}

/** @brief 此刻 side 那一栏的右栏开关：这一栏是否焦点所在、开关是否按下、焦点是否在开关上，右栏在不在、写了什么，两栏的宽。 */
async function toggleFacts(page, side) {
  const facts = await page.evaluate((css) => {
    const slot = document.querySelector(css);
    const button = slot?.querySelector('.topbar .right-toggle');
    return { focused: slot?.dataset.focused === 'true', pressed: button?.getAttribute('aria-pressed') ?? null,
      onToggle: Boolean(button) && document.activeElement === button,
      panel: Boolean(document.querySelector('[data-testid="right-panel"]')) };
  }, slotSelector(side));
  const text = await page.getByTestId('right-panel').innerText({ timeout: 1000 }).catch(() => '');
  return { ...facts, readme: text.includes('README.md'), widths: (await splitState(page)).slots.map((s) => s.width) };
}

/**
 * @brief 点另一栏的右栏开关（split.md"右栏开关"：点它焦点先切到这一栏，再开关右栏；用鼠标主键按下时到点完才切焦点）：
 *        左栏有焦点、右栏开着（左栏 C 的改动），右边那一栏 D 自己的开关关着；用鼠标点一下右边那一栏的"Toggle changes"，
 *        这一下不落空：焦点切到右边那一栏、它的开关按下、右栏仍开着并列出 D 的改动（README.md）、焦点在这个开关上、两栏宽度
 *        不变。接着在开关上按 Enter：关上；再按 Enter：打开。最后右键按左栏的开关：按下时焦点就切到左栏（右键不等）。
 */
async function toggleOther(ctx) {
  const { page } = ctx;
  const setOwn = (side, open) => setOwnRight(page, side, open);
  await setOwn('right', false);
  await setOwn('left', true);
  await page.getByTestId('right-panel').waitFor({ timeout: 5000 });
  await sleep(300);
  const before = await toggleFacts(page, 'right');
  await rightToggle(page, 'right').click();
  await sleep(300);
  const clicked = await toggleFacts(page, 'right');
  await page.keyboard.press('Enter');
  await sleep(300);
  const keyOff = await toggleFacts(page, 'right');
  await page.keyboard.press('Enter');
  await sleep(300);
  const keyOn = await toggleFacts(page, 'right');
  record('分屏：左栏有焦点、右栏开着时用鼠标点右边那一栏的"Toggle changes"一下：焦点切到右边那一栏、开关按下、右栏开着'
    + '并列出这一栏的改动、焦点在开关上，两栏宽度不变（这一下没有点空）', !before.focused && before.pressed === 'false'
    && before.panel && clicked.focused && clicked.pressed === 'true' && clicked.panel && clicked.readme
    && clicked.onToggle && JSON.stringify(clicked.widths) === JSON.stringify(before.widths),
  JSON.stringify({ before, clicked }));
  record('分屏：焦点在右栏开关上按 Enter 关上右栏、再按 Enter 打开（键盘照旧）', keyOff.pressed === 'false'
    && !keyOff.panel && keyOn.pressed === 'true' && keyOn.panel && keyOn.focused, JSON.stringify({ keyOff, keyOn }));
  await rightToggle(page, 'left').click({ button: 'right' });
  await sleep(300);
  const rightClick = await toggleFacts(page, 'left');
  record('分屏：右键按另一栏的右栏开关时按下就切焦点（split.md"焦点所在的一栏"含右键），开关不变', rightClick.focused
    && rightClick.pressed === 'true', JSON.stringify(rightClick));
  await composerAt(page, 'right').click();
}

/** @brief 按 F8、写上 what、保存，返回写着 what 的那一份报告（同一秒里存两份时文件名不按先后排，所以按内容找）。 */
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

/**
 * @brief F8 报告"Current view"的"Model range""Effort""Pane width"（f8.md"保存的内容"、composer-pickers.md"我自己定的"
 *        第 16 条）：都是焦点所在那一栏的；Pane width 是那一栏 .chat-pane 的宽（右边那一栏比 .pane-slot 窄 1px）；
 *        三项的位置；"Model""Permission mode"照旧。
 */
async function viewFields(page, report, side) {
  const view = await paneView(page, side);
  const problems = viewProblems((label) => reportField(report, label), reportLabels(report), view, side);
  record(`F8：在${side === 'left' ? '左' : '右'}栏按，"Current view"的"Model range""Model""Effort"是这一栏的，`
    + `"Pane width"是这一栏 .chat-pane 的宽${side === 'right' ? '（比 .pane-slot 窄 1px）' : ''}，`
    + '三项在"Model"前后和"Window size"后面', problems.length === 0, `${problems.join('; ')} ${JSON.stringify(view)}`);
}

/**
 * @brief 走查 3：分屏中线：拖动、方向键、双击恢复各一半；比例存在本机；两栏各至少 280px。窗口拉到 1600 宽
 *        （1200 宽时右栏贴在右边，两栏正好各 280px，中线没有可调的范围，见 m5-checks.md）。
 */
async function divider(ctx) {
  const { page } = ctx;
  const narrowSplit = await splitState(page);
  await resizeWindow(ctx, 1600, 900);
  const handle = page.locator('[data-resize="split"]');
  const start = await splitState(page);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  const dragged = await splitState(page);
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  const keyed = await splitState(page);
  const saved = (await savedLayout(page)).split;
  const now = await handle.boundingBox();
  await page.mouse.move(now.x + now.width / 2, now.y + 200);
  await page.mouse.down();
  await page.mouse.move(0, now.y + 200, { steps: 6 });
  await page.mouse.up();
  const clamped = await splitState(page);
  await handle.dblclick();
  const reset = await splitState(page);
  record('走查 3：拖动分屏中线，左栏变窄约 120px；→ 每次 20px；比例存在本机', Math.abs(start.divider.now - 120
    - dragged.divider.now) <= 2 && keyed.divider.now === dragged.divider.now + 20
    && Math.abs(saved - keyed.divider.now / keyed.centerWidth) < 0.01, JSON.stringify({ start: start.divider,
      dragged: dragged.divider, keyed: keyed.divider, saved }));
  record('分屏中线：1200 宽、右栏打开时两栏各 280px，中线不出现（没有可调的范围）', narrowSplit.divider === null
    && narrowSplit.slots.every((slot) => slot.width >= 279), JSON.stringify(narrowSplit.slots.map((s) => s.width)));
  record('分屏中线：两栏各至少 280px（拖到最左时停在 280）；双击恢复各一半', clamped.slots[0].width >= 279
    && clamped.divider.now === 280 && Math.abs(reset.slots[0].width - reset.slots[1].width) <= 2,
  JSON.stringify({ clamped: clamped.slots.map((s) => s.width), reset: reset.slots.map((s) => s.width) }));
}

/** @brief 放不下两栏各 280px 加最窄的右栏时，右栏先收起；点开关浮在上层；最小窗口时两栏完整、没有横向滚动。 */
async function crampedRight(ctx) {
  const { page } = ctx;
  await composerAt(page, 'right').click();
  const wide = await page.getByTestId('right-panel').count();
  await resizeWindow(ctx, 1050, 800);
  const narrow = { panel: await page.getByTestId('right-panel').count(), state: await splitState(page) };
  await paneAt(page, 'right').getByRole('button', { name: 'Toggle changes' }).click();
  const floating = await page.getByTestId('right-panel').getAttribute('class').catch(() => '');
  const widths = (await splitState(page)).slots.map((slot) => slot.width);
  await page.getByTestId('right-panel').getByRole('button', { name: 'Close panel' }).first().click();
  await resizeWindow(ctx, 800, 600);
  const minimum = await splitState(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth
    || [...document.querySelectorAll('.topbar, .composer-bottom')]
      .some((bar) => bar.scrollWidth > bar.clientWidth + 1));
  const rows = [];
  for (const side of ['left', 'right']) {
    const row = await composerRow(page, slotSelector(side));
    rows.push(...rowProblems(row, 'idle', APP_OPTS).map((problem) => `${side} ${row?.pane}px: ${problem}`));
  }
  await resizeWindow(ctx, 1280, 800);
  const back = await page.getByTestId('right-panel').getAttribute('class').catch(() => null);
  record('分屏放不下时右栏先收起（两栏各不足 280px 之前）；点右栏开关时浮在两栏上层，两栏宽度不变；窗口变宽后回到右边',
    wide === 1 && narrow.panel === 0 && narrow.state.slots.every((slot) => slot.width >= 280)
    && floating?.includes('floating')
    && JSON.stringify(widths) === JSON.stringify(narrow.state.slots.map((s) => s.width))
    && back === 'right-panel',
  JSON.stringify({ wide, narrow: narrow.state.slots.map((s) => s.width), floating, back }));
  record('最小窗口 800×600：左栏收起为图标栏，两栏各约 370px 完整显示，没有横向滚动、标题行和输入框下面一行都不溢出',
    minimum.slots.every((slot) => slot.width >= 360) && !overflow, JSON.stringify({ widths: minimum.slots.map((s) =>
      s.width), overflow }));
  record('最小窗口 800×600：两栏的输入框下面一行（权限、选择范围、Effort、圆环、发送）按约 370px 一栏收紧，不换行、'
    + '截短的先后对、读屏名和悬停对', rows.length === 0, rows.join('; '));
  await shot(page, '3-wide-again');
}

/** @brief 此刻右栏是否展开（.app 的 data-right-expanded）、中栏的显示方式、右栏和左栏的宽、窗口宽、焦点在哪一栏。 */
function expandFacts(page) {
  return page.evaluate(() => {
    const box = (css) => Math.round(document.querySelector(css)?.getBoundingClientRect().width ?? 0);
    const center = document.querySelector('.center');
    return { expanded: document.querySelector('.app')?.dataset.rightExpanded ?? null,
      center: center ? getComputedStyle(center).display : null, panel: box('[data-testid="right-panel"]'),
      sidebar: box('[data-testid="sidebar"]'), width: innerWidth,
      focused: document.querySelector('.pane-slot[data-focused="true"]')?.dataset.side ?? null,
      button: document.querySelector('[data-testid="right-panel"] .panel-expand')?.getAttribute('aria-label') ?? null };
  });
}

/**
 * @brief split.md"右栏展开"（2026-10-26 走查 M23）：分屏、右边那一栏的右栏开着、左边那一栏的关着，点"Expand"：两栏一起藏起、
 *        右栏占满左栏右边；F8 的"Right panel"是"Open · Expanded"；点侧栏里左边那一栏的会话行：焦点切过去，它的右栏关着，
 *        两栏照常显示（不会是空白）；再点右边那一栏的会话行：又是展开的；"Collapse"回到两栏。
 */
async function splitExpand(ctx) {
  const { page } = ctx;
  await setOwnRight(page, 'left', false);
  await setOwnRight(page, 'right', true);
  await page.getByTestId('right-panel').waitFor({ timeout: 5000 });
  const keys = (await splitState(page)).slots.map((slot) => slot.key);
  await page.getByTestId('right-panel').getByRole('button', { name: 'Expand', exact: true }).click();
  const expanded = await expandFacts(page);
  const report = await saveIssue(ctx, 'M23 分屏时展开右栏');
  await page.locator(`.session-item[data-row="${keys[0]}"]`).first().click();
  await sleep(400);
  const onLeft = { ...await expandFacts(page), slots: (await splitState(page)).slots.map((slot) => slot.width) };
  await page.locator(`.session-item[data-row="${keys[1]}"]`).first().click();
  await sleep(400);
  const onRight = await expandFacts(page);
  await page.getByTestId('right-panel').getByRole('button', { name: 'Collapse', exact: true }).click();
  const collapsed = { ...await expandFacts(page), slots: (await splitState(page)).slots.map((slot) => slot.width) };
  record('分屏时"Expand"：两栏一起藏起，右栏占满左栏右边；F8 写"Right panel: Open · Expanded"',
    expanded.expanded === 'true' && expanded.center === 'none' && Math.abs(expanded.panel - (expanded.width
      - expanded.sidebar)) <= 1 && expanded.button === 'Collapse' && report.includes('- Right panel: Open · Expanded'),
  JSON.stringify({ expanded, field: report.split('\n').find((line) => line.startsWith('- Right panel:')) }));
  record('展开时点侧栏里另一栏（右栏关着）的会话：焦点切过去，两栏照常显示、没有右栏；再点回来又是展开的；"Collapse"回到两栏',
    onLeft.focused === 'left' && onLeft.expanded === null && onLeft.center !== 'none' && onLeft.panel === 0
    && onLeft.slots.every((width) => width >= 280) && onRight.focused === 'right' && onRight.expanded === 'true'
    && collapsed.expanded === null && collapsed.slots.length === 2 && collapsed.slots.every((width) => width >= 280),
  JSON.stringify({ onLeft, onRight, collapsed }));
  record('分屏时展开右栏：F8 的"Pane width"是 None（会话面板藏着），"Recent activity"里有"Expand right panel"',
    report.includes('- Pane width: None') && /^- \S+ Expand right panel$/m.test(report),
  JSON.stringify(report.split('\n').filter((line) => /^- (Pane width:|\S+ (Expand|Collapse) right panel)/.test(line))));
  await shot(page, '3-expand');
  await splitClose(page);
}

/**
 * @brief split.md"右栏展开"（2026-10-26 补测）：分屏时再"Expand"后点"Close panel"：两栏回来（各不少于 280px）、没有右栏、
 *        不再展开。
 */
async function splitClose(page) {
  await page.getByTestId('right-panel').getByRole('button', { name: 'Expand', exact: true }).click();
  const expanded = await expandFacts(page);
  await page.getByTestId('right-panel').getByRole('button', { name: 'Close panel' }).click();
  await sleep(300);
  const closed = { ...await expandFacts(page), slots: (await splitState(page)).slots.map((slot) => slot.width) };
  record('分屏时展开右栏后点"Close panel"：两栏回来（各不少于 280px），没有右栏，不再展开', expanded.expanded === 'true'
    && closed.expanded === null && closed.center !== 'none' && closed.panel === 0 && closed.slots.length === 2
    && closed.slots.every((width) => width >= 280), JSON.stringify({ expanded, closed }));
}

/** @brief 此刻右栏：窗口宽、左栏宽、右栏宽、分隔线的值和上限、"Expand"看不看得见、类名，以及中栏各栏的宽。 */
function rightFacts(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="right-panel"]');
    const divider = document.querySelector('[data-resize="workspace"]');
    const expand = panel?.querySelector('.panel-expand');
    return { width: innerWidth, panel: Math.round(panel?.getBoundingClientRect().width ?? 0),
      sidebar: Math.round(document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().width ?? 0),
      now: divider ? Number(divider.getAttribute('aria-valuenow')) : null,
      max: divider ? Number(divider.getAttribute('aria-valuemax')) : null, className: panel?.className ?? null,
      expand: expand ? getComputedStyle(expand).display !== 'none' && expand.getClientRects().length > 0 : null,
      slots: [...document.querySelectorAll('.pane-slot:not([hidden])')]
        .map((slot) => Math.round(slot.getBoundingClientRect().width)) };
  });
}

/** @brief 把右栏的分隔线拖到窗口左边缘（超过上限的部分按上限收紧）。 */
async function dragRightDividerLeft(page) {
  const box = await page.locator('[data-resize="workspace"]').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(4, y, { steps: 6 });
  await page.mouse.up();
  await sleep(200);
}

/** @brief splitRightMax 的后半：窗口 1050 宽放不下时点右栏开关，右栏浮在上层；拖到底；恢复默认宽度后关上。 */
async function floatingRight(ctx) {
  const { page } = ctx;
  await resizeWindow(ctx, 1050, 800);
  await paneAt(page, 'right').getByRole('button', { name: 'Toggle changes' }).click();
  await page.getByTestId('right-panel').waitFor({ timeout: 5000 });
  const floating = await rightFacts(page);
  await dragRightDividerLeft(page);
  const widest = await rightFacts(page);
  await page.locator('[data-resize="workspace"]').dblclick();
  await page.getByTestId('right-panel').getByRole('button', { name: 'Close panel' }).first().click();
  return { floating, widest };
}

/**
 * 窗口 1600 宽时左栏调成 220px（窄窗口时的默认宽度）：上限 1600 − 220 − 560 = 820 才大于 800，看得出没有另外的
 * 800px 上限（1600 宽时左栏的默认宽度是 260px，上限 780，小于 800，看不出来）
 */
const SPLIT_SIDEBAR = 220;

/**
 * @brief 焦点放到左栏的分隔线上，用 ← →（每次 20px，layout.md"分隔线"）把左栏调到 width，等分隔线的值变成 width。
 * @return 调之前左栏的宽度
 */
async function sidebarTo(page, width) {
  const divider = page.locator('[data-resize="sidebar"]');
  const before = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();
  const key = width < before ? 'ArrowLeft' : 'ArrowRight';
  for (let left = Math.abs(before - width); left > 0; left -= 20) await page.keyboard.press(key);
  await page.waitForFunction((want) => Number(document.querySelector('[data-resize="sidebar"]')
    ?.getAttribute('aria-valuenow')) === want, width, { timeout: 3000 });
  return before;
}

/**
 * @brief split.md"放得下"、layout.md"分隔线"右栏左边、split.md"浮在上层"（2026-10-26 补测）：分屏、窗口 1600 宽、左栏
 *        220px（SPLIT_SIDEBAR）、右栏贴在右边时把右栏的分隔线拖到底：上限是"窗口 − 左栏 − 560"（大于 800，没有另外的
 *        800px 上限），右栏就这么宽，两栏各 280px；量完把左栏调回原来的宽度。窗口 1050 宽放不下时点右栏开关：浮在上层、顶部没有"Expand"，拖到底时宽"窗口 − 60px"；窗口回到
 *        原来的大小、右栏贴在右边时"Expand"恢复。最后恢复右栏默认宽度、窗口大小和右边那一栏的右栏开关。
 */
async function splitRightMax(ctx) {
  const { page } = ctx;
  const size = await windowSize(ctx);
  const pressed = await rightToggle(page, 'right').getAttribute('aria-pressed');
  await resizeWindow(ctx, 1600, 900);
  const sidebar = await sidebarTo(page, SPLIT_SIDEBAR);
  await setOwnRight(page, 'right', true);
  await page.getByTestId('right-panel').waitFor({ timeout: 5000 });
  await dragRightDividerLeft(page);
  const docked = await rightFacts(page);
  await page.locator('[data-resize="workspace"]').dblclick();
  await sidebarTo(page, sidebar);
  const { floating, widest } = await floatingRight(ctx);
  await setWindowSize(ctx, size);
  const back = await rightFacts(page);
  await setOwnRight(page, 'right', pressed === 'true');
  record('分屏放得下（1600 宽）时右栏没有另外的 800px 上限：分隔线拖到底时上限是"窗口 − 左栏 − 560"（大于 800），'
    + '右栏就这么宽，两栏各 280px', docked.max === docked.width - docked.sidebar - 560 && docked.max > 800
    && docked.now === docked.max && Math.abs(docked.panel - docked.max) <= 1 && docked.slots.length === 2
    && docked.slots.every((width) => Math.abs(width - 280) <= 1), JSON.stringify(docked));
  record('分屏放不下（1050 宽）时点右栏开关：右栏浮在上层、顶部没有"Expand"，拖到底时宽"窗口 − 60px"；回到贴在右边时'
    + '"Expand"恢复', floating.className?.includes('floating') && floating.expand === false
    && widest.max === widest.width - 60 && Math.abs(widest.panel - (widest.width - 60)) <= 1 && back.expand === true,
  JSON.stringify({ floating, widest, back }));
}

/**
 * @brief layout.md"右栏展开"（2026-10-26 补测，单栏）：A 的右栏展开时点侧栏的 B（右栏关着）：中栏照常显示 B，没有右栏、
 *        没有展开；再点回 A 又是展开的。最后收回、关上 A 的右栏（A 没有改动，关着与原来一样），回到 C（menuSplit 要 C）。
 */
async function singleExpand(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.a).first().click();
  await waitPaneReady(page, 'single');
  await paneAt(page, 'single').getByRole('button', { name: 'Toggle changes' }).click();
  await page.getByTestId('right-panel').getByRole('button', { name: 'Expand', exact: true }).click();
  const onA = await expandFacts(page);
  await rowOf(page, ctx.b).first().click();
  await sleep(400);
  const onB = { ...await expandFacts(page), title: (await splitState(page)).slots[0]?.title ?? null };
  await rowOf(page, ctx.a).first().click();
  await sleep(400);
  const backOnA = await expandFacts(page);
  await page.getByTestId('right-panel').getByRole('button', { name: 'Collapse', exact: true }).click();
  await paneAt(page, 'single').getByRole('button', { name: 'Toggle changes' }).click();
  await rowOf(page, ctx.c).first().click();
  await waitPaneReady(page, 'single');
  record('单栏时 A 的右栏展开、点侧栏的 B（右栏关着）：中栏照常显示 B，没有右栏、没有展开；再点回 A 又是展开的',
    onA.expanded === 'true' && onA.center === 'none' && onB.expanded === null && onB.center !== 'none'
    && onB.panel === 0 && onB.title === ctx.titles.b && backOnA.expanded === 'true' && backOnA.center === 'none',
  JSON.stringify({ onA, onB, backOnA }));
}

/**
 * @brief 把 side 那一栏依次设成 widths 里的宽，每个宽度下输入框空着、有字各量一次 side 那一栏（按 state 查）和另一栏
 *        （按 other 查，宽度是剩下的），返回问题列表。
 */
async function splitSweep(page, side, { widths, state, other }) {
  const bad = [];
  const otherSide = side === 'left' ? 'right' : 'left';
  for (const width of widths) {
    const got = await setSplitWidth(page, side, width);
    for (const draft of ['', SPLIT_DRAFT]) {
      await composerAt(page, side).fill(draft);
      const row = await composerRow(page, slotSelector(side));
      const problems = Math.abs(got - width) > 0.5 ? [`pane ${got}px`] : rowProblems(row, state, APP_OPTS);
      const label = `${side} ${width}${draft ? '+字' : ''}`;
      if (problems.length) bad.push(`${label}: ${problems.join('; ')} (${rowSummary(row)})`);
    }
    const rest = await composerRow(page, slotSelector(otherSide));
    const problems = rowProblems(rest, other, APP_OPTS);
    if (problems.length) bad.push(`${otherSide} ${rest?.pane}: ${problems.join('; ')} (${rowSummary(rest)})`);
  }
  return bad;
}

/** @brief 在 side 那一栏的权限菜单里选 mode（选"Full access"时确认），等按钮显示它。 */
async function chooseMode(page, side, mode) {
  await page.locator(`${slotSelector(side)} [data-testid="permission-button"]`).click();
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: mode }).click();
  if (mode === 'Full access') {
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Full access', exact: true }).click();
  }
  await page.waitForFunction(({ css, text }) => document.querySelector(`${css} [data-testid="permission-button"]`)
    ?.textContent?.includes(text), { css: slotSelector(side), text: mode }, { timeout: 10000 });
}

/**
 * @brief 280px 的一栏、生成中有字（composer-pickers.md"测试要改的地方"新加的检查第 6 条）：Tab 依次到权限、选择范围、Effort、
 *        圆环、▾（"Queue"收起）；Enter 打开 ▾ 的菜单，焦点在"Queue for later"，↓ 到"Steer"，Esc 回到 ▾；再选
 *        "Queue for later"真的排队（这一栏的排队区多一条"Queued"）。
 */
async function queueForLater(page, side) {
  await composerAt(page, side).fill(SPLIT_DRAFT);
  const textarea = `${slotSelector(side)} .composer textarea`;
  const path = await tabPath(page, textarea, (name) => name === 'More send options', 8);
  await page.keyboard.press('Enter');
  const name = () => page.evaluate(() => document.activeElement?.closest('[role="menuitem"]')?.childNodes[0]
    ?.textContent ?? null);
  await page.locator(`${slotSelector(side)} .split-button [role="menu"]`).waitFor({ timeout: 3000 }).catch(() => {});
  const first = await name();
  await page.keyboard.press('ArrowDown');
  const second = await name();
  await page.keyboard.press('Escape');
  const back = await focusName(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const queued = await paneAt(page, side).getByTestId('queue').filter({ hasText: SPLIT_DRAFT })
    .waitFor({ timeout: 10000 }).then(() => true, () => false);
  const queueText = await paneAt(page, side).getByTestId('queue').innerText().catch(() => '');
  record('分屏 280px、生成中有字："Queue"收起；Tab 依次到权限、选择范围、Effort、圆环、▾；Enter 打开菜单焦点在'
    + '"Queue for later"，↓ 到"Steer"，Esc 回到 ▾；选"Queue for later"真的排队（排队区多一条"Queued"）',
  path.join() === `${ROW_PATH},More send options` && first === 'Queue for later' && second === 'Steer'
    && back === 'More send options' && queued && queueText.includes('Queued'),
  JSON.stringify({ path, first, second, back, queue: oneLine(queueText, 80) }));
}

/** @brief 两栏都停止生成（焦点在各自的输入框里按 Esc），等本轮结束。 */
async function stopBoth(page) {
  for (const side of ['left', 'right']) {
    if (!(await splitState(page)).slots.find((slot) => slot.side === side)?.running) continue;
    await composerAt(page, side).click();
    await page.keyboard.press('Escape');
    await waitPaneIdle(page, side, 30000);
  }
}

/**
 * @brief 分屏各栏的输入框下面一行（composer-pickers.md"测试要改的地方"新加的检查第 2、3、4、6 条；models.md"窄栏"、
 *        "菜单的位置与键盘"；split.md）：左栏（C）生成中，280–490px 各档、空 / 有字都量，右栏（D，空闲）同时量剩下的宽；
 *        280px 生成中有字时权限菜单、▾ 菜单、圆环详情往上打开、在这一栏里；▾ 菜单的排队一项；"Full access"在 280px 最挤时
 *        看得见的字仍分得出、对比度够；接着 splitRight。结束时两栏各一半、焦点在右栏（closeKeeps 接着用）。
 */
async function splitRows(ctx) {
  const { page } = ctx;
  await sendAt(page, 'left', 'wait 90s');
  await waitPaneRunning(page, 'left');
  // 右栏跟随焦点所在的一栏、按各自的会话开关：焦点到了这一栏之后再关，这个会话的右栏才是关着的
  await closeRightPanel(page);
  const sweep = await splitSweep(page, 'left', { widths: SPLIT_WIDTHS, state: 'running', other: 'idle' });
  record('分屏：生成中的一栏在 280–490px 各档（空 / 有字）、另一栏空闲：输入框下面一行不换行、不超出输入框，每档该有的都在，'
    + '截短的先后和最窄对，读屏名和悬停第一行是全文，不可用的原因对', sweep.length === 0, sweep.slice(0, 4).join(' | '));
  await setSplitWidth(page, 'left', 280);
  await composerAt(page, 'left').fill(SPLIT_DRAFT);
  const menus = await popoverChecks(page, slotSelector('left'), ['permission', 'queue', 'ring']);
  record('分屏 280px 生成中有字：权限菜单、▾ 菜单、圆环详情往上打开，在这一栏会话面板和窗口里、不盖顶栏、不比这一行宽',
    menus.length === 0, menus.join('; '));
  await queueForLater(page, 'left');
  await chooseMode(page, 'left', 'Full access');
  await composerAt(page, 'left').fill(SPLIT_DRAFT);
  const full = await composerRow(page, slotSelector('left'));
  const fullProblems = rowProblems(full, 'running', APP_OPTS);
  record('分屏 280px 生成中有字、"Full access"：没有图标，截短后看得见开头的字（不只剩颜色）、字和底色的对比度 ≥ 4.5:1，'
    + '三个按钮不窄于最窄', full?.items.permission?.full && fullProblems.length === 0,
  `${rowSummary(full)} ${fullProblems.join('; ')}`);
  await chooseMode(page, 'left', 'Ask each time');
  await splitRight(ctx);
}

/**
 * @brief splitRows 的后半：右栏 279px（.pane-slot 280px）生成中有字；两栏各一个圆环；两栏停下后空闲时左栏 280px、
 *        右栏 279px 打开范围菜单（收到这一行的宽，项名截短时有省略号）、Effort 菜单、权限菜单和圆环详情。
 */
async function splitRight(ctx) {
  const { page } = ctx;
  await sendAt(page, 'right', 'wait 60s');
  await waitPaneRunning(page, 'right');
  await closeRightPanel(page);
  const right = await splitSweep(page, 'right', { widths: [279], state: 'running', other: 'running' });
  const rings = await page.evaluate(() => [...document.querySelectorAll('.pane-slot:not([hidden])')]
    .map((slot) => slot.querySelectorAll('[data-testid="usage"]').length));
  record('分屏：右边一栏 279px（.pane-slot 280px）生成中有字时输入框下面一行放得下；两栏各有一个圆环', right.length === 0
    && rings.join() === '1,1', `${right.join(' | ')} 圆环 ${rings}`);
  await stopBoth(page);
  for (const side of ['left', 'right']) await composerAt(page, side).fill('');
  const idle = [];
  for (const [side, width] of [['left', 280], ['right', 279]]) {
    await setSplitWidth(page, side, width);
    idle.push(...(await popoverChecks(page, slotSelector(side), ['model', 'effort', 'permission', 'ring']))
      .map((problem) => `${side} ${width}px ${problem}`));
  }
  record('分屏 280px / 279px 空闲：范围菜单收到这一行的宽（项名截短有省略号）、Effort 菜单往上打开、右边对齐'
    + '自己的按钮或左边贴这一行左端，权限菜单左对齐，圆环详情右对齐，都在这一栏里', idle.length === 0, idle.join('; '));
  await page.locator('[data-resize="split"]').dblclick();
  await composerAt(page, 'right').click();
}

/**
 * @brief 反例：关闭分屏不停止正在生成的会话；去设置页再回来分屏还在。关的时候用鼠标点另一栏的"Close pane"：左栏自己的右栏
 *        开着、焦点所在的右边那一栏的关着（按下就切焦点的话右栏打开、两栏变窄，按钮被挤走），一下就关上。
 */
async function closeKeeps(ctx) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to app' }).click();
  const back = await splitState(page);
  record('去设置页再回来：分屏和焦点都还在', back.split && back.slots[0].focused === false && back.slots[1].focused,
    JSON.stringify(back.slots));
  await sendAt(page, 'left', 'wait 5s');
  await setOwnRight(page, 'left', true);
  await setOwnRight(page, 'right', false);
  await sleep(300);
  const before = { slots: (await splitState(page)).slots.map((s) => ({ focused: s.focused, width: s.width })),
    leftOwn: await rightToggle(page, 'left').getAttribute('aria-pressed'),
    panel: await page.getByTestId('right-panel').count() };
  await paneAt(page, 'left').getByTestId('close-pane').click();
  const closed = await waitSplit(page, false).then(() => true, () => false);
  record('分屏：焦点在右边那一栏、右栏关着，左栏自己的右栏开着时，用鼠标点左栏的"Close pane"一下就关上（split.md'
    + '"右栏开关"：顶栏右边一组的按钮到点完才切焦点）', closed && before.slots[1].focused && before.leftOwn === 'true'
    && before.panel === 0, JSON.stringify({ before, closed }));
  const single = await splitState(page);
  const running = await waitStatus(page, ctx.c, 'running', 3000);
  const unseen = await waitStatus(page, ctx.c, 'unseen', 20000);
  await rowOf(page, ctx.c).first().click();
  await waitPaneReady(page, 'focused');
  const reply = await paneAt(page, 'focused').getByTestId('assistant').last().innerText();
  record('反例：关闭分屏中正在生成的一栏：回到单栏，另一栏（D）得到焦点；那个会话照常生成完（侧栏"生成中"→"有新结果"）',
    single.slots.length === 1 && single.slots[0].title === ctx.titles.d && running && unseen
    && reply.includes('等了 5 秒'), JSON.stringify({ single: single.slots, running, unseen, reply }));
}

/** @brief 走查 4：把 A 拖进 B 的输入框：芯片；预览按轮、不含思考和工具输出；改成第 2–3 轮；模型收到引用块。 */
async function dragReference(ctx) {
  const { page } = ctx;
  const empty = await newSession(page);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  const noHint = await dragWithHint(page, rowOf(page, empty).first(), page.locator('.pane-slot[data-focused="true"]'
    + ' [data-drop="composer"]'));
  const still = await splitState(page);
  const noChip = await chipsAt(page, 'focused');
  record('反例：拖到输入框上不会分屏——还没有消息的会话拖到输入框上没有提示、不能放下（不引用、也不分屏）',
    noHint === null && !still.split && still.slots[0].title === ctx.titles.b && noChip.chips.length === 0
    && noChip.problems.length === 0, JSON.stringify({ noHint, still: still.slots, noChip }));
  const hint = await dragWithHint(page, rowOf(page, ctx.a).first(), page.locator('.pane-slot[data-focused="true"]'
    + ' [data-drop="composer"]'));
  const chip = await waitSessionChip(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-kind="session"] .quote-chip-main').click();
  await waitPreview(page);
  const preview = await previewState(page);
  // "Done"（工具卡的状态）也是预览对话框自己的按钮，只在各轮的内容里查。
  const words = ['Copy', 'Thought process', 'Thinking', 'THINKING-ONLY-MARKER', TOOL_ONLY, 'Running…'];
  const turnText = preview.turns.map((turn) => turn.text).join('\n');
  record('走查 4：把 A 拖进输入框：提示"松开以引用到这个会话"；芯片"引用 · A · 第 1–4 轮 · 约 X 字"',
    hint?.kind === 'reference' && /^Context · plain A 第一轮 · turns 1–4 · ~[\d,]+ characters$/.test(chip),
    JSON.stringify({ hint, chip }));
  record('预览：按"第 N 轮"列出 4 轮和字数；工具调用一行"[工具] 读取 README.md"、没有工具输出；没有思考内容和界面文字',
    preview.turns.length === 4 && preview.turns[1].text.includes('[Tool] Read README.md')
    && preview.turns[2].text.includes('Assistant: 想好了，这是正文。') && !words.some((word) => preview.text.includes(word))
    && !turnText.includes('Done'),
    JSON.stringify(preview.turns.map((turn) => turn.text.slice(0, 120))));
  await pickRange(page, 2, 3);
  await page.getByTestId('ref-preview').getByRole('button', { name: 'Done' }).click();
  ctx.refLabel = await waitSessionChip(page, 'focused');
  await sendIn(page, 'focused', 'echo back');
  const echo = await paneAt(page, 'focused').getByTestId('assistant').last().innerText();
  const entries = refEntries(ctx.b);
  const source = entries.at(-1)?.refs?.[0]?.source;
  record('走查 4：改成第 2–3 轮后发出：模型收到"引用会话…第 2–3 轮"的引用块；会话文件里写了 mori.ref 条目（来源是 A 的会话文件）',
    ctx.refLabel.includes('· turns 2–3 ·') && echo.includes('Quoting session “plain A 第一轮”, turns 2–3:')
    && echo.includes('User: read the README A 第二轮') && echo.includes('[Tool] Read README.md')
    && !echo.includes('THINKING-ONLY-MARKER') && source?.kind === 'session' && source.fromTurn === 2
    && source.sessionFile.toLowerCase() === ctx.a.toLowerCase(), JSON.stringify({ label: ctx.refLabel, source,
      echo: echo.slice(0, 120) }));
  await shot(page, '4-reference');
}

/**
 * @brief 焦点所在的一栏里高亮的几项中步骤组的摘要行（aria-expanded）和工具卡（几张、几张看得见）。每一项的外层和里面的
 *        .assistant-message 都带 data-item-key、都高亮，按元素去重。
 */
function flashedSteps(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash')];
    const all = (selector) => [...new Set(items.flatMap((item) => [...item.querySelectorAll(selector)]))];
    const cards = all('[data-testid="tool-card"]');
    return { rows: all('[data-testid="step-group"]').map((row) => row.getAttribute('aria-expanded')),
      cards: cards.length, shown: cards.filter((card) => card.checkVisibility()).length };
  });
}

/** @brief 走查 5：点消息里的引用跳回 A、高亮第 2–3 轮（第 2 轮折起的步骤先展开）；A 改名后仍有效。 */
async function jumpBack(ctx) {
  const { page } = ctx;
  // 跳之前先看一眼 A：第 2 轮读 README 的步骤折着（aria-expanded="false"），再回到 B
  await rowOf(page, ctx.a).first().click();
  await waitPaneReady(page, 'focused');
  const before = await paneAt(page, 'focused').evaluate((pane) => [...pane
    .querySelectorAll('[data-testid="step-group"]')].map((row) => row.getAttribute('aria-expanded')));
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  const sent = await sentSessionRefs(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 15000 });
  const flashed = await flashedAt(page, 'focused');
  const title = await focusedTitle(page);
  record('走查 5：发出的消息上方是会话引用；点它在这一栏打开 A，滚到第 2 轮、高亮第 2–3 轮（两条你的消息）',
    sent[0]?.label === ctx.refLabel && title === ctx.titles.a && flashed.users.join('|')
      === 'read the README A 第二轮|think first A 第三轮', JSON.stringify({ sent, title, flashed }));
  const steps = await flashedSteps(page);
  record('会话引用与步骤组（2026-10-26 走查 M18，chat.md"步骤组"）：第 2 轮读 README 的步骤在 A 里折成一行（点之前看过 A：'
    + 'aria-expanded="false"），跳过来时先展开它（aria-expanded="true"），高亮的部分里那张读取卡看得见',
  before.length > 0 && before.every((row) => row === 'false') && steps.rows.length > 0
    && steps.rows.every((row) => row === 'true') && steps.cards > 0 && steps.shown === steps.cards,
  JSON.stringify({ before, steps }));
  await paneAt(page, 'focused').getByTestId('session-title').click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByTestId('rename-input').fill('A 改过的名字');
  await page.getByTestId('rename-input').press('Enter');
  await rowOf(page, ctx.b).first().click();
  await sleep(500);
  const renamed = await sentSessionRefs(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 15000 });
  record('走查 5：在标题行右键改名 A 后，引用显示新名字，点它仍跳回 A', renamed[0]?.label.startsWith(
    'Context · A 改过的名字 · turns 2–3') && await focusedTitle(page) === 'A 改过的名字', JSON.stringify(renamed));
  ctx.titles.a = 'A 改过的名字';
}

/** @brief 走查 6：只用键盘：菜单"Attach as context"、Shift+Tab 到芯片、Enter 打开预览、方向键改范围、"Done"。 */
async function keyboardReference(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  await menuOf(page, ctx.a);
  await chooseByKeys(page, 'Attach as context');
  await waitSessionChip(page, 'focused');
  const inComposer = await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await waitPreview(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.getByTestId('ref-preview').waitFor({ state: 'detached', timeout: 5000 });
  const chips = await chipsAt(page, 'focused');
  record('走查 6：只用键盘：菜单"引用到当前会话"（焦点到输入框）→ Shift+Tab 到芯片 → Enter 预览 → ↓ 把开始改成第 2 轮 → '
    + 'Tab 到"确定" → Enter：芯片变成第 2–4 轮', inComposer && chips.chips[0]?.label.includes('· turns 2–4 ·'),
  JSON.stringify({ inComposer, chips }));
}

/** @brief 输入框里的芯片随草稿保存；重启后发出的引用仍能跳回。 */
async function restart(ctx) {
  await ctx.app.close();
  await startApp(ctx);
  const { page } = ctx;
  await page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await sleep(1500);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  const chips = await chipsAt(page, 'focused');
  const sent = await sentSessionRefs(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 30000 });
  const flashed = await flashedAt(page, 'focused');
  record('重启后：输入框里的会话引用芯片还在（随草稿保存）；发出的引用还在，点它打开 A 并高亮第 2–3 轮',
    chips.chips[0]?.label.includes('· turns 2–4 ·') && sent[0]?.label.startsWith(`Context · ${ctx.titles.a}`)
    && flashed.users.length === 2 && await focusedTitle(page) === ctx.titles.a,
  JSON.stringify({ chips, sent, flashed }));
  await shot(page, '5-restart');
}

/**
 * @brief 等 side 那一栏这次运行过了运行开始的快照（docs/specs/file-system.md §4.5：快照做完之前 pi 还没写下这条消息，
 *        会话行菜单的"Attach as context"是"No messages yet"）：阶段行出现、且不是 Taking a snapshot…（data-kind snapshot）。
 */
function waitPastSnapshot(page, side, timeout = 20000) {
  return page.waitForFunction((css) => {
    const stage = document.querySelector(`${css} [data-testid="stage"]`);
    return Boolean(stage) && stage.dataset.kind !== 'snapshot';
  }, slotSelector(side), { timeout });
}

/**
 * @brief 反例：引用正在生成的会话只取已完成的轮次；只有一轮还在生成时没有可引用的内容。
 *        A 的第 5 轮（等 8 秒）后面排队了第 6 轮（等 6 秒）：第 6 轮送达后第 5 轮就算完成，虽然这次运行还没结束。
 */
async function runningSource(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.a).first().click();
  await sendAt(page, 'focused', 'wait 8s');
  const started = Date.now();
  await sendAt(page, 'focused', 'wait 6s');
  ctx.e = await newSession(page);
  await sendAt(page, 'focused', 'wait 8s');
  await waitPastSnapshot(page, 'focused');
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="quote-chip"] .icon-button').first().click();
  await menuOf(page, ctx.a);
  await chooseByKeys(page, 'Attach as context');
  const chip = await waitSessionChip(page, 'focused');
  await menuOf(page, ctx.e);
  await chooseByKeys(page, 'Attach as context');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="ref-problem"]').waitFor({ timeout: 10000 });
  const { problems } = await chipsAt(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-kind="session"] .quote-chip-main').click();
  await waitPreview(page);
  const preview = await previewState(page);
  await page.keyboard.press('Escape');
  record('反例：引用正在生成的会话（A 的第 5 轮在生成）只取已完成的 4 轮；预览说明"这个会话还在生成，只列出已完成的 4 轮"',
    chip.includes('· turns 1–4 ·') && preview.turns.length === 4
    && preview.notes.includes('This session is still running. Only the 4 finished turns are listed.'),
    JSON.stringify({ chip, notes: preview.notes }));
  record('只有一轮且还在生成的会话：没有加芯片，提示"…还没有完成的一轮，没有可引用的内容"', problems.length === 1
    && problems[0].endsWith('has no finished turns yet, so there’s nothing to attach.'), JSON.stringify(problems));
  await page.locator('.pane-slot[data-focused="true"] [data-testid="ref-problem"] .icon-button').click();
  await queuedTurn(ctx, started);
  await until(async () => (await waitStatus(page, ctx.a, 'unseen', 100))
    && (await waitStatus(page, ctx.e, 'unseen', 100)), 30000);
}

/** @brief A 排队的第 6 轮送达后（第 5 轮已经写完、这次运行还没结束）再引用 A：取到第 1–5 轮。 */
async function queuedTurn(ctx, started) {
  const { page } = ctx;
  await sleep(Math.max(0, started + 10500 - Date.now()));
  await page.locator('.pane-slot[data-focused="true"] [data-kind="session"] .icon-button').first().click();
  const stillRunning = await waitStatus(page, ctx.a, 'running', 100);
  await menuOf(page, ctx.a);
  await chooseByKeys(page, 'Attach as context');
  const chip = await waitSessionChip(page, 'focused');
  record('反例：生成中排队的下一条已经送达时，前一轮算已完成：A 还在生成（第 6 轮），引用取到第 1–5 轮', stillRunning
    && chip.includes('· turns 1–5 ·'), JSON.stringify({ stillRunning, chip }));
}

/** @brief 超过 2 万字时默认只引用最近 5 轮。 */
async function longSource(ctx) {
  const { page } = ctx;
  ctx.long = await newSession(page);
  const filler = '这是一条很长的你的消息，用来让会话的内容超过两万字。'.repeat(170);
  for (let n = 1; n <= 6; n += 1) await sendIn(page, 'focused', `plain 第 ${n} 条 ${filler}`);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="quote-chip"] .icon-button').first().click();
  await dragWithHint(page, rowOf(page, ctx.long).first(), page.locator('.pane-slot[data-focused="true"]'
    + ' [data-drop="composer"]'));
  const chip = await waitSessionChip(page, 'focused');
  const chars = Number(chip.match(/~([\d,]+) characters/)?.[1].replace(/,/g, '') ?? 0);
  record('全部超过 2 万字时默认只引用最近 5 轮（第 2–6 轮）', chip.includes('· turns 2–6 ·') && chars > 20000,
    chip);
  await page.locator('.pane-slot[data-focused="true"] [data-testid="quote-chip"] .icon-button').first().click();
}

/** @brief 在侧栏的会话行上右键"Rename"改成 name，等这一行显示新名字。 */
async function renameRow(page, file, name) {
  await rowOf(page, file).first().click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByTestId('rename-input').fill(name);
  await page.getByTestId('rename-input').press('Enter');
  await until(async () => (await rowOf(page, file).first().textContent()).includes(name), 10000);
}

/** @brief 点焦点所在的一栏里的会话引用芯片，等预览读完，返回量出的标题。 */
async function openHeading(page) {
  await page.locator('.pane-slot[data-focused="true"] [data-kind="session"] .quote-chip-main').click();
  await waitPreview(page);
  return previewHeading(page);
}

/**
 * @brief 预览的标题"Context · <会话名>"完整显示（session-refs.md"预览与调整范围"）：超过 2 万字的会话（longSource 建的）
 *        轮次列表占满对话框，默认窗口大小和内容区 800×600 下标题都是完整的一行、没有被压矮；改成很长的名字后一行放不下，
 *        截断加省略号、不折行，不撑宽对话框。用菜单把它引用进 B，结束时去掉芯片、窗口回到原来的大小。
 *        要用 longSource 建的会话（ctx.long），用 --only 时要同时选 longSource 和 headingFit。
 */
async function headingFit(ctx) {
  const { page } = ctx;
  const before = await windowSize(ctx);
  await setWindowSize(ctx, ctx.defaultSize);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  await menuOf(page, ctx.long);
  await chooseByKeys(page, 'Attach as context');
  await waitSessionChip(page, 'focused');
  const normal = { ...await openHeading(page), view: await viewSize(page) };
  await shot(page, '4-heading-default');
  await resizeWindow(ctx, 800, 600);
  const small = { ...await previewHeading(page), view: await viewSize(page) };
  await shot(page, '4-heading-800x600');
  await page.keyboard.press('Escape');
  record('预览的标题：默认窗口大小、轮次列表占满对话框时标题完整显示，只有一行、没有被压矮',
    Boolean(normal.listFull) && headingWhole(normal), JSON.stringify(normal));
  record('预览的标题：内容区 800×600、轮次列表占满对话框时标题仍完整显示，只有一行', Boolean(small.listFull)
    && headingWhole(small), JSON.stringify(small));
  await setWindowSize(ctx, ctx.defaultSize);
  await renameRow(page, ctx.long, LONG_NAME);
  const long = await openHeading(page);
  await shot(page, '4-heading-long-name');
  await page.keyboard.press('Escape');
  record('预览的标题：会话名很长时只有一行，横向裁掉放不下的部分、截断加省略号、不折行，不超出对话框和窗口，'
    + '对话框没有被撑宽，完整显示',
    long?.text === `Context · ${LONG_NAME}` && headingTruncated(long) && headingWhole(long), JSON.stringify(long));
  await page.locator('.pane-slot[data-focused="true"] [data-testid="quote-chip"] .icon-button').first().click();
  await setWindowSize(ctx, before);
}

/**
 * @brief 顶栏里会话名的地方（chat.md"顶栏"；composer-pickers.md"测试要改的地方"新加的检查第 1 条）：很长的会话名（headingFit
 *        改过名的 ctx.long）在右栏；1280 宽窗口分屏各一半（约 500px）、460 / 401 / 400 / 321 / 320 / 280px、右边一栏最窄
 *        279px（.pane-slot 280px）、800×600 分屏（约 370px），以及 800 宽窗口右栏打开时的单栏（300px）：会话名要么完整、
 *        要么占满剩下的地方（项目名先收到 40px）；460px 时至少 253px、280px 和 279px 时至少 168px（2026-10-26 前顶栏还有
 *        协作开关，≤ 600px 时只有状态点，算出的是 258、173、172px，留 5、5、4px；去掉开关后会话名更宽，这几个下限照旧）；
 *        ≤ 400px 时两个图标按钮 28px、内边距比宽时小；≤ 320px 不显示项目名和 ›。
 *        要用 longSource、headingFit 建和改名的会话，用 --only 时要一起选。
 */
async function titleRoomCheck(ctx) {
  const { page } = ctx;
  const before = await windowSize(ctx);
  await resizeWindow(ctx, 1280, 800);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  await menuOf(page, ctx.long);
  await chooseByKeys(page, 'Open in split view');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  await closeRightPanel(page);
  const rooms = [];
  const measure = async (minimum = 0) => {
    const room = await titleRoom(page, 'right');
    rooms.push({ pane: room?.pane, problems: titleProblems(room, minimum), padding: room?.padding,
      title: room?.title?.width });
  };
  await page.locator('[data-resize="split"]').dblclick();
  await measure();
  for (const [width, minimum] of [[460, 253], [401, 0], [400, 0], [321, 0], [320, 0], [280, 168], [279, 168]]) {
    await setSplitWidth(page, 'right', width);
    await measure(minimum);
  }
  await resizeWindow(ctx, 800, 600);
  await page.locator('[data-resize="split"]').dblclick();
  await measure();
  await titleSingle(ctx, rooms);
  await setWindowSize(ctx, before);
}

/** @brief titleRoomCheck 的后半：关上 B 那一栏，800 宽窗口、右栏打开时的单栏 300px；记录全部结果。 */
async function titleSingle(ctx, rooms) {
  const { page, app } = ctx;
  await paneAt(page, 'left').getByTestId('close-pane').click();
  await waitSplit(page, false);
  await resizeWindow(ctx, 1200, 800);
  await setPaneWidth(page, app, 300);
  const room = await titleRoom(page, 'single');
  rooms.push({ pane: room?.pane, problems: titleProblems(room), padding: room?.padding, title: room?.title?.width });
  await setPaneWidth(page, app, 930);
  const bad = rooms.filter((item) => item.problems.length);
  const wide = rooms.find((item) => item.pane > 400 && item.pane < 410);
  const narrow = rooms.find((item) => item.pane <= 400 && item.pane > 390);
  record('顶栏：分屏和窄的单栏里很长的会话名要么完整、要么占满剩下的地方（项目名先收到 40px），460px 时至少 253px、'
    + '280px 和 279px 时至少 168px；≤ 400px 时两个图标按钮 28px、内边距变小；≤ 320px 不显示项目名和 ›',
  bad.length === 0 && Boolean(wide && narrow)
    && narrow.padding[0] + narrow.padding[1] < wide.padding[0] + wide.padding[1],
  JSON.stringify(rooms.map((item) => [item.pane, item.padding?.join('/'), item.title, item.problems.join('; ')])));
}

/** @brief 走查 5 与删除：删除 A 时它所在的一栏关闭；指向它的引用显示"Session deleted"，原文仍可查看。 */
async function deleteSource(ctx) {
  const { page } = ctx;
  await archivedSource(ctx);
  await rowOf(page, ctx.b).first().click();
  await menuOf(page, ctx.a);
  await chooseByKeys(page, 'Open in split view');
  await waitSplit(page);
  await paneAt(page, 'right').getByTestId('session-title').click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByTestId('delete-dialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByTestId('delete-dialog').waitFor({ state: 'detached', timeout: 10000 });
  await waitSplit(page, false);
  const single = await splitState(page);
  await page.waitForFunction(() => [
    ...document.querySelectorAll('[data-testid="sent-quote"] [data-testid="quote-status"]'),
  ].some((item) => item.textContent === 'Session deleted'), null, { timeout: 10000 });
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.getByTestId('ref-preview').waitFor({ timeout: 5000 });
  const preview = await previewState(page);
  record('在标题行的菜单删除分屏中的会话 A：确认框照常走完，这一栏关闭，B 占满中栏', single.slots.length === 1 && single.slots[0].title === ctx.titles.b,
    JSON.stringify(single.slots));
  record('走查 5：A 删除后引用标"原会话已删除"；点它看到引用时的原文（第 2–3 轮），不能改范围',
    preview.notes.includes('Session deleted · Showing the attached text') && preview.stored?.startsWith('Turn 2')
    && preview.from === null, JSON.stringify({ notes: preview.notes, stored: preview.stored?.slice(0, 60) }));
  await shot(page, '5-deleted');
  await page.keyboard.press('Escape');
}

/** @brief 原会话已归档时点引用：与在侧栏点它相同，先恢复再打开（不再留在已归档列表里）。 */
async function archivedSource(ctx) {
  const { page } = ctx;
  await menuOf(page, ctx.a);
  await chooseByKeys(page, 'Archive');
  await until(async () => (await savedArchived(page))
    .some((file) => file.toLowerCase() === ctx.a.toLowerCase()), 10000);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 15000 });
  const archived = await savedArchived(page);
  record('原会话已归档时点引用：先恢复（不在已归档列表里）、再打开它并高亮引用的几轮', await focusedTitle(page) === ctx.titles.a
    && !archived.some((file) => file.toLowerCase() === ctx.a.toLowerCase()), JSON.stringify(archived));
}

/** @brief 新加的界面没有小于 12px 的字（圆环的悬停提示、圆环详情和范围菜单开着时各量一次）。 */
async function fontSizes(ctx) {
  const { page } = ctx;
  const focused = slotSelector('focused');
  const small = await smallText(page);
  await page.locator(`${focused} [data-testid="usage"]`).hover();
  await page.locator(`${focused} [data-testid="usage-tip"]`).waitFor({ timeout: 3000 }).catch(() => {});
  small.push(...await smallText(page));
  await openRingDetails(page, focused);
  small.push(...await smallText(page));
  await page.keyboard.press('Escape');
  await page.locator(`${focused} [data-testid="model-button"]`).click();
  await page.getByTestId('model-menu').waitFor({ timeout: 3000 }).catch(() => {});
  small.push(...await smallText(page));
  await page.keyboard.press('Escape');
  record('新加的界面（分屏标题行、芯片、预览、发出的引用、放下提示、输入框下面一行、圆环的悬停提示和详情、范围菜单）'
    + '没有小于 12px 的文字', small.length === 0, small.slice(0, 5).join('; '));
}

/**
 * @brief 另起一次 Mori（新的数据目录）：首次启动时给 fake-coder 勾上"Supports thinking"（新会话的强度是 Medium，
 *        model-menu.md"思考强度"新会话），建两个会话分屏，左栏 280px，Effort 分别是"Medium"和"Minimal"时生成中有字的这一行
 *        （composer-pickers.md"测试要改的地方"新加的检查第 3 条；"Extra high"在 v1 里选不到，见 effortAt280）。
 */
async function effortWidths(ctx) {
  const run = { userData: mkdtempSync(join(tmpdir(), 'mori-m5-app-effort-')), pageErrors: ctx.pageErrors };
  await startApp(run);
  try {
    await run.h.setupFirstRun({ baseUrl, apiKey: testKey, reasoning: true });
    await stubFolder(run.app, ctx.project);
    await run.page.getByRole('button', { name: OPEN_FOLDER }).first().click();
    await waitReady(run.page);
    await sendIn(run.page, 'focused', 'plain E 第一轮');
    const first = await run.page.locator('.session-item.active').first().getAttribute('data-file');
    await newSession(run.page);
    await menuOf(run.page, first);
    await chooseByKeys(run.page, 'Open in split view');
    await waitSplit(run.page);
    await waitPaneReady(run.page, 'right');
    await composerAt(run.page, 'left').click();
    await closeRightPanel(run.page);
    await effortAt280(run.page);
  } finally {
    await run.app.close().catch(() => {});
  }
}

/**
 * @brief 左栏 280px：Effort 依次是"Medium"（新会话的强度）和"Minimal"（在菜单里选），各发一条"wait 20s"，生成中有字时量
 *        这一行，再按 Esc 停下。v1 里配置的模型没有"Extra high"（pi 只在模型有 xhigh 映射时才列出，后台进程按当前模型收紧强度，
 *        modelSession.ts），这里用选得到的强度；最宽的"Unavailable"在 splitRows 里量过。
 */
async function effortAt280(page) {
  const bad = [];
  const seen = [];
  for (const level of ['medium', 'minimal']) {
    await setSplitWidth(page, 'left', 280);
    await page.locator(`${slotSelector('left')} [data-testid="thinking-button"]`).click();
    await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
    await page.waitForFunction(({ css, want }) => {
      const button = document.querySelector(`${css} [data-testid="thinking-button"]`);
      return button?.dataset.level === want && !button.dataset.pending;
    }, { css: slotSelector('left'), want: level }, { timeout: 10000 });
    await sendAt(page, 'left', 'wait 20s');
    await waitPaneRunning(page, 'left');
    await composerAt(page, 'left').fill(SPLIT_DRAFT);
    const row = await composerRow(page, slotSelector('left'));
    seen.push(row?.items.effort?.label);
    bad.push(...rowProblems(row, 'running', APP_OPTS).map((problem) => `${level}: ${problem}`));
    await page.keyboard.press('Escape');
    await waitPaneIdle(page, 'left', 30000);
    await composerAt(page, 'left').fill('');
  }
  record('分屏 280px 生成中有字、Effort 是"Medium"和"Minimal"：这一行放得下，截短的先后对（Effort 最后截），'
    + '读屏名和悬停第一行是全文', seen.join() === 'Effort: Medium,Effort: Minimal' && bad.length === 0,
  `${seen.join(' / ')} ${bad.join('; ')}`);
}

const steps = { setup, trayKeepsLayout, singleExpand, menuSplit, dragAndPlace, twoPanes, followFocus, toggleOther,
  divider, crampedRight, splitRightMax, splitExpand, splitRows, closeKeeps, dragReference, jumpBack, keyboardReference,
  restart, runningSource, longSource, headingFit, titleRoomCheck, deleteSource, fontSizes, effortWidths };

const fake = await startFakeEndpoint();
const { root, project } = makeProject();
const userData = mkdtempSync(join(tmpdir(), 'mori-m5-app-data-'));
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
console.log(`[m5-app] project in ${project}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`m5-app${suffix}.json`) ? 0 : 1;
