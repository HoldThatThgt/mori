// M5 整机测试：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖分屏与会话引用（docs/v0/screens/split.md、session-refs.md；方案第 7 节 M5 走查 1–6 与反例）：
// 分屏（菜单与键盘、拖到中栏左右半边、拖已在中栏的会话只切焦点、侧栏点会话换掉焦点所在的一栏、Ctrl+N、两栏各自发消息和批准、
// Esc 只停焦点所在的一栏、F8 与右栏跟随焦点、分屏中线的拖动 / 方向键 / 双击 / 保存、放不下时右栏先收起和浮出、
// 最小窗口、关闭一栏不停止生成、设置页来回、归档删除时这一栏关闭）；会话引用（拖进输入框、菜单"Attach as context"与不可用的情况、
// 只用键盘、芯片与预览、改范围、内容不含思考和工具输出、模型收到引用块、mori.ref 条目、跳回原会话、改名、重启后、
// 原会话已删除、引用正在生成的会话、没有可引用的内容、超过 2 万字默认最近 5 轮、草稿里的芯片、预览的标题不被压矮、
// 很长的会话名截断加省略号）；没有小于 12px 的字；页面没有报错。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m5-app.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m5-app(-packaged).json，截图在 test-results/m5-app(-packaged)/。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import { openMenuOn, rowOf, savedArchived, stubFolder, until, waitReady, waitStatus } from './m3-helpers.mjs';
import { refEntries } from './m4-helpers.mjs';
import {
  centerPoint, chipsAt, composerAt, dragWithHint, flashedAt, headingTruncated, headingWhole, paneAt, pickRange,
  previewHeading, previewState, savedLayout, sendAt, sentSessionRefs, smallText, splitState, waitPaneIdle,
  waitPaneReady, waitPreview, waitSessionChip, waitSplit,
} from './m5-helpers.mjs';
import { OPEN_FOLDER, pageHelpers } from './page.mjs';

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
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used to check Mori against a model'
    + ' and it has one README file and one source file.\n\n' + `${TOOL_ONLY}\n`);
  writeFileSync(join(project, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
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
  // v1（规格 §14.4）：首次启动填英文表单、区域选 Local，等探针都跑完再打开文件夹（page.mjs setupFirstRun）。
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
    && withD.slots[1].key === await keyOf(page, d) && withD.slots[0].key === toA.slots[0].key, JSON.stringify(withD.slots));
  ctx.d = d;
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
  await composerAt(page, 'right').click();
  await page.keyboard.press('Escape');
  await waitPaneIdle(page, 'right');
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

/** @brief 走查 2：右栏和 F8 跟随焦点所在的一栏。 */
async function followFocus(ctx) {
  const { page } = ctx;
  const panel = () => page.getByTestId('right-panel').innerText({ timeout: 3000 }).catch(() => '');
  await paneAt(page, 'right').getByTestId('transcript').click({ position: { x: 10, y: 10 } });
  await sleep(300);
  const onRight = await panel();
  await paneAt(page, 'left').getByTestId('transcript').click({ position: { x: 10, y: 10 } });
  await sleep(300);
  const onLeft = await panel();
  record('走查 2：右栏跟随焦点所在的一栏（右栏 D 改了 README.md，左栏 C 写了 docs/c.md）', onRight.includes('README.md')
    && !onRight.includes('c.md') && onLeft.includes('docs/c.md') && !onLeft.includes('README.md'),
  JSON.stringify({ onRight: onRight.slice(0, 100), onLeft: onLeft.slice(0, 100) }));
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
  await shot(page, '2-follow');
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
    || [...document.querySelectorAll('.topbar')].some((bar) => bar.scrollWidth > bar.clientWidth + 1));
  await resizeWindow(ctx, 1280, 800);
  const back = await page.getByTestId('right-panel').getAttribute('class').catch(() => null);
  record('分屏放不下时右栏先收起（两栏各不足 280px 之前）；点右栏开关时浮在两栏上层，两栏宽度不变；窗口变宽后回到右边',
    wide === 1 && narrow.panel === 0 && narrow.state.slots.every((slot) => slot.width >= 280)
    && floating?.includes('floating') && JSON.stringify(widths) === JSON.stringify(narrow.state.slots.map((s) => s.width))
    && back === 'right-panel', JSON.stringify({ wide, narrow: narrow.state.slots.map((s) => s.width), floating, back }));
  record('最小窗口 800×600：左栏收起为图标栏，两栏各约 370px 完整显示，没有横向滚动、标题行不溢出',
    minimum.slots.every((slot) => slot.width >= 360) && !overflow, JSON.stringify({ widths: minimum.slots.map((s) =>
      s.width), overflow }));
  await shot(page, '3-wide-again');
}

/** @brief 反例：关闭分屏不停止正在生成的会话；去设置页再回来分屏还在。 */
async function closeKeeps(ctx) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to app' }).click();
  const back = await splitState(page);
  record('去设置页再回来：分屏和焦点都还在', back.split && back.slots[0].focused === false && back.slots[1].focused,
    JSON.stringify(back.slots));
  await sendAt(page, 'left', 'wait 5s');
  await sleep(300);
  await paneAt(page, 'left').getByTestId('close-pane').click();
  await waitSplit(page, false);
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

/** @brief 走查 5：点消息里的引用跳回 A、高亮第 2–3 轮；A 改名后仍有效。 */
async function jumpBack(ctx) {
  const { page } = ctx;
  const sent = await sentSessionRefs(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 15000 });
  const flashed = await flashedAt(page, 'focused');
  const title = await focusedTitle(page);
  record('走查 5：发出的消息上方是会话引用；点它在这一栏打开 A，滚到第 2 轮、高亮第 2–3 轮（两条你的消息）',
    sent[0]?.label === ctx.refLabel && title === ctx.titles.a && flashed.users.join('|')
      === 'read the README A 第二轮|think first A 第三轮', JSON.stringify({ sent, title, flashed }));
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
    && flashed.users.length === 2 && await focusedTitle(page) === ctx.titles.a, JSON.stringify({ chips, sent, flashed }));
  await shot(page, '5-restart');
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
  await until(async () => (await waitStatus(page, ctx.a, 'unseen', 100)) && (await waitStatus(page, ctx.e, 'unseen', 100)),
    30000);
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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="sent-quote"] [data-testid="quote-status"]')]
    .some((item) => item.textContent === 'Session deleted'), null, { timeout: 10000 });
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
  await until(async () => (await savedArchived(page)).some((file) => file.toLowerCase() === ctx.a.toLowerCase()), 10000);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 15000 });
  const archived = await savedArchived(page);
  record('原会话已归档时点引用：先恢复（不在已归档列表里）、再打开它并高亮引用的几轮', await focusedTitle(page) === ctx.titles.a
    && !archived.some((file) => file.toLowerCase() === ctx.a.toLowerCase()), JSON.stringify(archived));
}

/** @brief 新加的界面没有小于 12px 的字。 */
async function fontSizes(ctx) {
  const small = await smallText(ctx.page);
  record('新加的界面（分屏标题行、芯片、预览、发出的引用、放下提示）没有小于 12px 的文字', small.length === 0,
    small.slice(0, 5).join('; '));
}

const steps = { setup, menuSplit, dragAndPlace, twoPanes, followFocus, divider, crampedRight, closeKeeps,
  dragReference, jumpBack, keyboardReference, restart, runningSource, longSource, headingFit, deleteSource, fontSizes };

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
