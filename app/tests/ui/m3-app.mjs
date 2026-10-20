// M3 整机测试：真正的 Mori（界面 + 后台进程 + pi）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖项目与会话（docs/v0/screens/sessions.md；方案第 7 节 M3 走查 1–7 与反例）：
// 两个文件夹各两个会话按项目分组、会话名取第一条消息的前 20 个字、新会话名为"新会话"、按最后活动从新到旧；
// 走查 2 的键盘路径（Ctrl+N → Shift+Tab → Shift+F10 → Enter → 输入 → Enter）、整棵树一个 Tab 停靠点、↑ ↓ Home End、
// 右键菜单（右键、菜单键、Shift+F10；Esc、Tab 关闭，焦点回到会话行；重命名、归档、删除及不可用时的小字）；
// 改名的预填、Esc 取消、名字为空或没变、另一个会话生成中按 Esc、窗口失去焦点、点框外保存；
// 重启后的会话树、名字与完整对话、没发消息的新会话不在、没有状态点；改名没打开的会话；
// 删除（照 Claude 桌面版永久删除：确认框文字与焦点、Tab、Esc、删当前会话、文件不在任何地方也不在系统回收站、
// 焦点移到下一行、草稿一起删除、正在生成不能删、还没有消息的新会话、删除文件失败与重试、重启后不在）；
// 归档（不确认、移到"已归档 N"、本机记下、后台进程关闭会话、文件还在、焦点、重启后仍归档、展开与悬停、
// 菜单"恢复""删除"、点已归档的会话恢复并打开、从已归档列表删除、正在生成和还没有消息时不能归档）；
// 项目信任（询问框、不信任、Esc、记住、信任后扩展的工具与批准卡、trust.json、重启后再问或不再问、
// 不信任时保存的会话信任后重新打开也有扩展的工具、后台进程层面的反例）；草稿（切换、设置页、重启）；
// 状态（生成中、有新结果、等你批准、出错、后台进程退出与重新载入）；窄窗口的图标栏圆点与浮动左栏；
// Ctrl+N 不起作用的情况（菜单、信任询问、浮动左栏、按住不放）；左栏没有小于 12px 的文字；页面没有报错。
// 扩展的询问与界面重新加载在 m3-app-live.mjs（同一次运行里接着做），共用的小工具在 m3-helpers.mjs。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m3-app.mjs                         测开发构建
//   node tests/ui/m3-app.mjs --exe <Mori.exe 路径>   测打包后的程序
// 结果写到 test-results/m3-app.json（文件名带 -packaged 后缀区分），截图在 test-results/m3-app/。
// 删除文件失败：测试用 Win32 CreateFileW 拿住会话文件、不给 FILE_SHARE_DELETE（m3-helpers.mjs holdFile），
// 主进程删除时报 EBUSY；放开后再删成功。选文件夹对话框经 dialog.showOpenDialog 直接返回文件夹；
// 窄窗口经 BrowserWindow.setSize；重启是 app.close() 后用同一个数据目录再启动。
// 项目扩展（.pi/extensions/project-hello.ts）是测试写的 synthetic 扩展：加载时先写 marker 文件，再注册 project_hello。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, sleep } from './lib.mjs';
import { liveSteps, writeAskExtension } from './m3-app-live.mjs';
import {
  activeFile, allRows, answerTrustDialog, archivedState, chooseMenuItem, clickOpenFolder, ctrlN, expandArchived,
  findByName, focusInfo, hasDraft, holdFile, kernelOpen, lastReply, liveInfo, menuItems, menuText, noteSmallText,
  openMenuByKey, openMenuByMouse, openRow, PANE, paneCount, paneOf, prefillOf, recycleBinNames, renameClosed,
  renameView, rowOf, rowState, samePath, savedArchived, savedDrafts, sendWait, sessionGone, sessionNames, startDelete,
  startRename, stoppedCount, stubFolder, titleOf, topTitle, treeState, trustRecord, until, waitArchivedToggle,
  waitComposerFocus, waitIdle, waitPanes, waitReady, waitRowTitle, waitRunning, waitStatus,
} from './m3-helpers.mjs';
import { pageHelpers } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const port = 4324;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m3-not-a-real-key';
const shots = join(appRoot, `test-results/m3-app${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 每个会话的第一条消息（都超过 20 个字，含 "plain" 让合成端点只回文字） */
const MESSAGES = {
  A1: 'plain 阿尔法项目第一个会话的第一条消息，超过二十个字',
  A2: 'plain 阿尔法项目第二个会话的第一条消息，也超过二十个字',
  B1: 'plain 贝塔项目第一个会话的第一条消息，同样超过二十个字',
  B2: 'plain 贝塔项目第二个会话的第一条消息，仍然超过二十个字',
  K: 'plain 键盘新建的会话发出的第一条消息',
  R: 'plain 拿来归档的会话的第一条消息，也超过二十个字',
};
/** 改过的名字 */
const NAMES = { A1: '阿尔法一号', B1: '失焦后继续', B2: '未打开时改的名字', K: '键盘新会话' };
const PLAIN_REPLY = '这是一段只有文字的回复';
const DRAFT = '半句话草稿，还没写';
const ARCHIVE_DRAFT = '归档之前写的半句话';
const PICK_HINT = '从左侧选一个会话继续，或打开一个文件夹开始新的会话。';
const UNTRUSTED = '没有信任这个文件夹，它自带的扩展和配置没有加载';
const ASK_AGAIN = '重启 Mori 后会再问';
const TRUST_TEXT = '这个文件夹带有自己的扩展或配置，信任后它们会在你的电脑上运行。';
const DELETE_TEXT = '对话记录会被删除，无法恢复。';
const UNSAVED_TEXT = '这个会话还没有消息。';
/** 开着时 Esc 先关它们的浮层 */
const OVERLAYS = ['session-menu', 'rename-input', 'delete-dialog', 'trust-dialog', 'confirm-dialog', 'issue-dialog']
  .map((id) => `[data-testid="${id}"]`).join(', ');

// ---------- 准备：合成端点、项目文件夹、项目扩展 ----------

/** @brief 启动合成端点（第一个分块前等 300 毫秒），最多等 15 秒。 */
function startFakeEndpoint() {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '15', FAKE_FIRST_DELAY_MS: '300',
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

/** @brief 在 root 下建一个项目文件夹：README 和 src/a.ts，内容与 lib.mjs 的 prepareProject 相同。 */
function makeProject(root, name) {
  const project = join(root, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'),
    '# Mori fixture project\n\nThis folder is used to check Mori against a model.\n\n' +
    '- It has one README file.\n- It has one source file in src/.\n');
  writeFileSync(join(project, 'src', 'a.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return project;
}

/** @brief synthetic 项目扩展的源码：工厂函数先写 marker，再注册 project_hello（参数是普通 JSON Schema）。 */
function extensionSource(marker) {
  return [
    '// synthetic: written by tests/ui/m3-app.mjs; writes a marker when loaded and registers project_hello.',
    "import { writeFileSync } from 'node:fs';",
    '',
    'export default function (pi) {',
    `  writeFileSync(${JSON.stringify(marker)}, 'loaded\\n');`,
    '  pi.registerTool({',
    "    name: 'project_hello',",
    "    label: 'Project hello',",
    "    description: 'Says hello from the project extension.',",
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    '    async execute() {',
    "      return { content: [{ type: 'text', text: 'hello from project' }], details: {} };",
    '    },',
    '  });',
    '}',
    '',
  ].join('\n');
}

/** @brief 带 .pi/extensions/project-hello.ts 的项目；marker 放在项目文件夹之外（root/markers）。 */
function makeExtensionProject(root, name) {
  const project = makeProject(root, name);
  const marker = join(root, 'markers', `${name}.txt`);
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'project-hello.ts'), extensionSource(marker));
  return { project, marker };
}

/** @brief 本次测试用的全部文件夹；eta 带询问用的项目扩展（m3-app-live.mjs）。 */
function prepareFolders() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m3-app-'));
  const folders = { alpha: makeProject(root, 'alpha'), beta: makeProject(root, 'beta'), eta: makeProject(root, 'eta') };
  writeAskExtension(folders.eta);
  const trust = {};
  for (const name of ['gamma', 'delta', 'epsilon', 'zeta']) trust[name] = makeExtensionProject(root, name);
  return { root, folders, trust };
}

// ---------- 主进程里运行的函数（经 app.evaluate 序列化，只能用参数里的 electron 模块和 process） ----------

/** @brief 把主窗口改成 width×height（外框），返回改之前的位置和大小。 */
function resizeMain({ BrowserWindow }, { width, height }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  const bounds = main.getBounds();
  if (main.isMaximized()) main.unmaximize();
  main.setSize(width, height);
  return bounds;
}

/** @brief 恢复主窗口的位置和大小。 */
function restoreMain({ BrowserWindow }, bounds) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  main.setBounds(bounds);
}

/** @brief 让主窗口失去焦点，返回之后它是否还有焦点。 */
function blurMain({ BrowserWindow }) {
  const main = BrowserWindow.getAllWindows()[0];
  main.blur();
  return main.isFocused();
}

/** @brief 把焦点交回主窗口。 */
function focusMainWindow({ BrowserWindow }) {
  const main = BrowserWindow.getAllWindows()[0];
  main.show();
  main.focus();
}

// ---------- 启动与重启 ----------

/** @brief 用 ctx.userData 启动 Mori，记下页面报错。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
  ctx.runs += 1;
}

/** @brief 关掉 Mori 再用同一个数据目录启动，等会话列表读完。 */
async function relaunch(ctx) {
  await ctx.app.close();
  await startApp(ctx);
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await ctx.page.waitForFunction(() => !document.querySelector('[data-testid="session-tree"]')
    ?.textContent?.includes('正在读取会话…'), null, { timeout: 30000 });
  await sleep(300);
}

// ---------- 走查 1：两个文件夹、各两个会话 ----------

/** @brief 首次启动：填连接、测试成功、打开 alpha；新会话在侧栏和顶栏都叫"新会话"。 */
async function setup(ctx) {
  const { app, page, h } = ctx;
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  await h.fillConnection({ name: '合成端点', baseUrl, apiKey: testKey, modelId: 'fake-coder' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  await stubFolder(app, ctx.folders.alpha);
  await page.getByRole('button', { name: '打开文件夹…' }).first().click();
  await page.locator('.pane-slot').first().waitFor({ timeout: 30000 });
  await waitReady(page);
  ctx.files.A1 = await activeFile(page);
  const row = await rowState(page, ctx.files.A1);
  const top = await topTitle(page);
  record('打开文件夹：新会话出现在该项目下，名为"新会话"并成为当前会话（顶栏同名）', row?.title === '新会话'
    && row.active && samePath(row.cwd, ctx.folders.alpha) && top === '新会话', JSON.stringify({ row, top }));
}

/** @brief 在 alpha、beta 各建两个会话，各发一条消息；Ctrl+N 在当前项目新建、焦点在输入框。 */
async function buildTree(ctx) {
  const { page } = ctx;
  await sendWait(ctx, MESSAGES.A1);
  ctx.files.A2 = await ctrlN(page);
  const a2 = await rowState(page, ctx.files.A2);
  const focused = await waitComposerFocus(page);
  record('新会话（Ctrl+N）：在当前会话所在的项目里新建会话并切过去，名为"新会话"，焦点在输入框',
    a2?.active && a2.title === '新会话' && samePath(a2.cwd, ctx.folders.alpha) && focused, JSON.stringify(a2));
  await sendWait(ctx, MESSAGES.A2);
  await clickOpenFolder(ctx, ctx.folders.beta);
  await waitReady(page);
  ctx.files.B1 = await activeFile(page);
  await sendWait(ctx, MESSAGES.B1);
  ctx.files.B2 = await ctrlN(page);
  await sendWait(ctx, MESSAGES.B2);
  await checkTree(ctx);
  await noteSmallText(ctx, 'tree');
  await shot(page, '01-tree');
}

/** @brief 走查 1 的会话树：分组、项目行、会话名、悬停、排序、当前会话高亮。 */
async function checkTree(ctx) {
  const groups = await treeState(ctx.page);
  const { alpha, beta } = ctx.folders;
  const { A1, A2, B1, B2 } = ctx.files;
  record('会话树：按项目（会话的工作目录）分组，项目行显示文件夹名，悬停显示完整路径', groups.length === 2
    && samePath(groups[0].cwd, beta) && samePath(groups[1].cwd, alpha) && groups[0].name === 'beta'
    && groups[1].name === 'alpha' && samePath(groups[0].tip, beta) && samePath(groups[1].tip, alpha),
  JSON.stringify(groups.map((group) => [group.cwd, group.name, group.tip])));
  const files = groups.map((group) => group.rows.map((row) => row.file));
  record('排序：项目按其中最新的会话排（beta 在前），会话在项目内从新到旧（B2、B1；A2、A1）', files.length === 2
    && files[0].length === 2 && samePath(files[0][0], B2) && samePath(files[0][1], B1)
    && files[1].length === 2 && samePath(files[1][0], A2) && samePath(files[1][1], A1), JSON.stringify(files));
  const rows = groups.flatMap((group) => group.rows);
  const wrong = Object.entries({ A1, A2, B1, B2 }).filter(([key, file]) => {
    const row = rows.find((item) => samePath(item.file, file));
    return !row || row.title !== titleOf(MESSAGES[key]) || row.full !== MESSAGES[key] || !row.nowrap;
  });
  record('会话名：没有名字时显示第一条你的消息的前 20 个字，超出加"…"；省略号截断不换行，悬停显示完整的第一条消息',
    wrong.length === 0, JSON.stringify(rows.map((row) => [row.title, row.full, row.nowrap])));
  const active = rows.filter((row) => row.active);
  record('会话树：当前会话高亮（只有 B2 一行）', active.length === 1 && samePath(active[0].file, B2),
    JSON.stringify(active));
}

// ---------- 走查 2：键盘 ----------

/** @brief Shift+Tab 直到焦点进入会话树（最多 12 次），返回按了几次、经过的元素（文字和 data-testid）和焦点。 */
async function shiftTabIntoTree(page) {
  const path = [];
  const testids = [];
  for (let presses = 1; presses <= 12; presses += 1) {
    await page.keyboard.press('Shift+Tab');
    const focus = await focusInfo(page);
    path.push(focus.label ?? focus.testid ?? focus.text);
    testids.push(focus.testid);
    if (focus.file !== null) return { presses, path, testids, focus };
  }
  return { presses: 12, path, testids, focus: await focusInfo(page) };
}

/**
 * @brief 走查 2：Ctrl+N（焦点在输入框）→ Shift+Tab 几次（经过顶栏的四个按钮：右栏开关、权限、M6 加的思考强度和模型，
 *        左栏分隔线、左栏底部的两个按钮）回到会话树，落在新会话行；整棵树一个 Tab 停靠点。
 */
async function keyboardPath(ctx) {
  const { page } = ctx;
  ctx.files.K = await ctrlN(page);
  const k = await rowState(page, ctx.files.K);
  const composer = await waitComposerFocus(page);
  record('走查 2：Ctrl+N 在当前会话所在的项目（beta）新建会话，名为"新会话"，焦点在新会话的输入框', k?.active
    && k.title === '新会话' && samePath(k.cwd, ctx.folders.beta) && composer, JSON.stringify(k));
  const entered = await shiftTabIntoTree(page);
  // M6 顶栏加了模型和思考强度两个按钮（models.md），多两个 Tab 停靠点：6 次改为 8 次。
  record('走查 2：从新会话的输入框 Shift+Tab 几次回到会话树（不超过 8 次），落在新会话行（中间不在别的会话行停）',
    samePath(entered.focus.file, ctx.files.K) && entered.presses <= 8,
    `按了 ${entered.presses} 次：${entered.path.join(' → ')}；焦点：${JSON.stringify(entered.focus)}`);
  // sessions.md 走查 2 的路径：权限按钮之后依次是思考强度按钮和模型按钮（models.md 的两个新按钮都能用键盘到达）。
  const order = ['permission-button', 'thinking-button', 'model-button'].map((id) => entered.testids.indexOf(id));
  record('走查 2（M6）：Shift+Tab 的路径依次经过顶栏的权限、思考强度、模型按钮（sessions.md 写的路径）',
    order.every((index, i) => index >= 0 && (i === 0 || index === order[i - 1] + 1)),
    `data-testid 顺序：${entered.testids.map((id) => id ?? '—').join(' → ')}`);
  const stops = (await allRows(page)).filter((row) => row.tabIndex === 0);
  await page.keyboard.press('Tab');
  const out = await focusInfo(page);
  await page.keyboard.press('Shift+Tab');
  const back = await focusInfo(page);
  record('会话树：整棵树只占一个 Tab 停靠点（只有当前会话行 tabIndex 为 0；Tab 离开树，Shift+Tab 回来落在当前会话行）',
    stops.length === 1 && samePath(stops[0].file, ctx.files.K) && out.file === null && samePath(back.file, ctx.files.K),
    `停靠点 ${stops.length} 个；Tab 后 ${JSON.stringify(out)}；Shift+Tab 后 ${JSON.stringify(back)}`);
}

/** @brief ↑ ↓ Home End 在会话行之间移动焦点（跨项目，不打开会话）。 */
async function arrowKeys(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.files.K).focus();
  const order = (await allRows(page)).map((row) => row.file);
  const keys = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'End', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowUp'];
  const want = [1, 2, 3, order.length - 1, 0, 0, 1, 0];
  const got = [];
  for (const key of keys) {
    await page.keyboard.press(key);
    const focus = await focusInfo(page);
    got.push(order.findIndex((file) => samePath(file, focus.file)));
  }
  const active = await activeFile(page);
  const top = await topTitle(page);
  record('会话树：↑ ↓ 在会话行之间移动焦点（跨项目），Home / End 到第一行和最后一行；不打开会话',
    JSON.stringify(got) === JSON.stringify(want) && samePath(active, ctx.files.K) && top === '新会话',
    `焦点所在行 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}；当前会话 ${active}，顶栏 ${top}`);
}

/**
 * @brief 走查 2：Shift+F10 打开菜单（重命名、归档、删除；还没有消息的新会话"归档"不可用），焦点在"重命名"，
 *        ↓ ↑ 在可用的菜单项之间选择，Enter 改名，输入新名字后 Enter 保存。
 */
async function keyboardRename(ctx) {
  const { page } = ctx;
  const menu = await openMenuByKey(page, ctx.files.K);
  const items = await menuItems(menu);
  const first = await focusInfo(page);
  await page.keyboard.press('ArrowDown');
  const down = await focusInfo(page);
  await page.keyboard.press('ArrowUp');
  const up = await focusInfo(page);
  const [rename, archive, remove] = items;
  record('右键菜单：Shift+F10 打开，菜单项"重命名""归档""删除"（还没有消息的新会话"归档"不可用，旁边小字"还没有消息"）；'
    + '焦点在第一个可用的菜单项；↑ ↓ 在可用的菜单项之间选择', items.length === 3 && rename.label === '重命名'
    && !rename.disabled && archive.label === '归档' && archive.disabled && archive.hint === '还没有消息'
    && remove.label === '删除' && !remove.disabled && first.role === 'menuitem' && first.text === '重命名'
    && down.text === '删除' && up.text === '重命名', `菜单 ${menuText(items)}；焦点 ${first.text} → ${down.text} → ${up.text}`);
  await shot(page, '02-menu');
  await page.keyboard.press('Enter');
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  const view = await renameView(input);
  await page.keyboard.type(NAMES.K);
  await page.keyboard.press('Enter');
  const closed = await renameClosed(page);
  const shown = await waitRowTitle(page, ctx.files.K, NAMES.K);
  const top = await topTitle(page);
  const focus = await focusInfo(page);
  record('走查 2：Enter 打开改名框（还没有名字和消息时为空），输入后 Enter 保存：侧栏和顶栏显示新名字，焦点回到这个会话行',
    view.value === '' && view.focused && closed && shown && top === NAMES.K && samePath(focus.file, ctx.files.K),
    `改名框 ${JSON.stringify(view)}；顶栏 ${top}；焦点 ${JSON.stringify(focus)}`);
}

/** @brief Enter 打开会话、焦点进输入框；还没发消息时改的名字随第一条消息一起写进会话文件。 */
async function renameBeforeFirstMessage(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.files.K).focus();
  await page.keyboard.press('Enter');
  const composer = await waitComposerFocus(page);
  record('会话树：在会话行上按 Enter 打开这个会话，焦点进入它的输入框', composer);
  const before = existsSync(ctx.files.K);
  await sendWait(ctx, MESSAGES.K);
  const names = sessionNames(ctx.files.K);
  const row = await rowState(page, ctx.files.K);
  record('重命名：还没发消息的新会话也可以改名，名字随第一条消息一起保存（发消息前没有会话文件）',
    !before && names.at(-1) === NAMES.K && row?.title === NAMES.K && row.full === NAMES.K,
    `发送前文件存在 ${before}；会话文件里的名字 ${JSON.stringify(names)}；行 ${JSON.stringify(row)}`);
}

/** @brief 右键（贴着鼠标、不切换会话）、菜单键打开菜单；Esc、Tab 关闭，焦点回到会话行；菜单开着时 Ctrl+N 不起作用。 */
async function menuOpeners(ctx) {
  const { page } = ctx;
  const { menu, at } = await openMenuByMouse(page, ctx.files.A2);
  const box = await menu.boundingBox();
  const focus = await focusInfo(page);
  const active = await activeFile(page);
  record('右键菜单：在会话行上右键打开，贴着鼠标位置，焦点在"重命名"；右键不切换当前会话',
    Math.abs(box.x - at.x) <= 2 && Math.abs(box.y - at.y) <= 2 && focus.text === '重命名'
    && samePath(active, ctx.files.K), `菜单 ${JSON.stringify(box)}，鼠标 ${JSON.stringify(at)}，焦点 ${focus.text}`);
  const panes = await paneCount(page);
  await page.keyboard.press('Control+n');
  await sleep(800);
  record('Ctrl+N 不起作用：右键菜单开着时什么都不发生', await paneCount(page) === panes && await menu.count() === 1);
  await page.keyboard.press('Escape');
  const escClosed = await menu.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
  const escFocus = await focusInfo(page);
  record('右键菜单：Esc 关闭，焦点回到会话行', escClosed && samePath(escFocus.file, ctx.files.A2),
    JSON.stringify(escFocus));
  const keyMenu = await openMenuByKey(page, ctx.files.A2, 'ContextMenu');
  const keyBox = await keyMenu.boundingBox();
  const rowBox = await rowOf(page, ctx.files.A2).boundingBox();
  const keyFocus = await focusInfo(page);
  await page.keyboard.press('Tab');
  const tabClosed = await keyMenu.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
  const tabFocus = await focusInfo(page);
  record('右键菜单：菜单键打开（贴着会话行下方），焦点在"重命名"；Tab 关闭，焦点回到会话行', keyFocus.text === '重命名'
    && keyBox.y >= rowBox.y + rowBox.height - 2 && tabClosed && samePath(tabFocus.file, ctx.files.A2),
  `菜单 ${JSON.stringify(keyBox)}，行 ${JSON.stringify(rowBox)}，Tab 后焦点 ${JSON.stringify(tabFocus)}`);
}

// ---------- 改名 ----------

/** @brief 改名框预先填第一条消息的前 20 个字（不带"…"）并全选；Enter 保存，焦点回到会话行。 */
async function renamePrefill(ctx) {
  const { page } = ctx;
  const input = await startRename(page, ctx.files.A1);
  const view = await renameView(input);
  record('重命名：会话行变成输入框并全选；没有名字时填第一条消息的前 20 个字（不带"…"）',
    view.value === prefillOf(MESSAGES.A1) && view.start === 0 && view.end === view.value.length && view.focused,
    JSON.stringify(view));
  await page.keyboard.type(NAMES.A1);
  await page.keyboard.press('Enter');
  const closed = await renameClosed(page);
  const shown = await waitRowTitle(page, ctx.files.A1, NAMES.A1);
  const focus = await focusInfo(page);
  const names = sessionNames(ctx.files.A1);
  record('重命名：Enter 保存，侧栏显示新名字并写进会话文件（pi 的 session_info），焦点回到这个会话行',
    closed && shown && names.at(-1) === NAMES.A1 && samePath(focus.file, ctx.files.A1),
    `会话文件里的名字 ${JSON.stringify(names)}；焦点 ${JSON.stringify(focus)}`);
}

/** @brief Esc 取消，什么都不写，焦点回到会话行。 */
async function renameEsc(ctx) {
  const { page } = ctx;
  const before = sessionNames(ctx.files.B1);
  const input = await startRename(page, ctx.files.B1);
  await input.fill('不该保存的名字');
  await page.keyboard.press('Escape');
  const closed = await renameClosed(page);
  await sleep(300);
  const row = await rowState(page, ctx.files.B1);
  const focus = await focusInfo(page);
  const after = sessionNames(ctx.files.B1);
  record('重命名：Esc 取消，什么都不写，焦点回到这个会话行', closed && row?.title === titleOf(MESSAGES.B1)
    && JSON.stringify(after) === JSON.stringify(before) && samePath(focus.file, ctx.files.B1),
  `行 ${row?.title}；名字 ${JSON.stringify(after)}；焦点 ${JSON.stringify(focus)}`);
}

/** @brief 名字为空或与预先填的相同：退出编辑，什么都不写，焦点回到会话行。 */
async function renameEmpty(ctx) {
  const { page } = ctx;
  const before = sessionNames(ctx.files.B1);
  const input = await startRename(page, ctx.files.B1);
  await input.fill('');
  await page.keyboard.press('Enter');
  const emptyClosed = await renameClosed(page);
  const emptyFocus = await focusInfo(page);
  await startRename(page, ctx.files.B1);
  await page.keyboard.press('Enter');
  const sameClosed = await renameClosed(page);
  await sleep(300);
  const row = await rowState(page, ctx.files.B1);
  const after = sessionNames(ctx.files.B1);
  record('重命名：名字为空或与预先填的相同时保存，退出编辑，什么都不写，焦点回到会话行', emptyClosed && sameClosed
    && row?.title === titleOf(MESSAGES.B1) && JSON.stringify(after) === JSON.stringify(before)
    && samePath(emptyFocus.file, ctx.files.B1), `行 ${row?.title}；名字 ${JSON.stringify(after)}`);
}

/** @brief 另一个会话（当前会话 A2）生成中，在 B1 的改名框里按 Esc：只取消改名，不停止生成。 */
async function renameEscRunning(ctx) {
  const { page } = ctx;
  await openRow(page, ctx.files.A2);
  const stoppedBefore = await stoppedCount(page);
  await ctx.h.send('wait 6s');
  await waitRunning(page);
  const { menu } = await openMenuByMouse(page, ctx.files.B1);
  await menu.getByRole('menuitem', { name: /^重命名/ }).click();
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  await input.fill('生成中不该保存');
  await page.keyboard.press('Escape');
  const closed = await renameClosed(page);
  const running = await paneOf(page).getAttribute('data-running');
  const status = (await rowState(page, ctx.files.A2))?.status;
  await waitIdle(page, 30000);
  const reply = await lastReply(page);
  const stopped = await stoppedCount(page);
  const row = await rowState(page, ctx.files.B1);
  record('重命名：Esc 取消不停止生成（另一个会话在生成时，在改名框里按 Esc 只取消改名，生成照常完成）', closed
    && running === 'true' && status === 'running' && reply.includes('等了 6 秒') && stopped === stoppedBefore
    && row?.title === titleOf(MESSAGES.B1), `Esc 后生成中 ${running}，行状态 ${status}，回复 ${oneLine(reply)}，`
    + `"已停止" ${stoppedBefore} → ${stopped}`);
}

/** @brief 窗口失去焦点不结束编辑；在框外按下鼠标等于保存。 */
async function renameBlur(ctx) {
  const { app, page } = ctx;
  const input = await startRename(page, ctx.files.B1);
  await input.fill(NAMES.B1);
  const focusedAfter = await app.evaluate(blurMain);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(600);
  const still = await input.count() === 1 && await input.inputValue() === NAMES.B1;
  record('重命名：窗口失去焦点不结束编辑，回来后继续编辑（改名框和写的字都在）', still,
    `失焦后窗口有焦点：${focusedAfter}`);
  await app.evaluate(focusMainWindow);
  await paneOf(page).getByTestId('session-title').click();
  const closed = await renameClosed(page);
  const shown = await waitRowTitle(page, ctx.files.B1, NAMES.B1);
  const names = sessionNames(ctx.files.B1);
  const focus = await focusInfo(page);
  record('重命名：在框外按下鼠标等于保存，侧栏显示新名字并写进会话文件', closed && shown
    && names.at(-1) === NAMES.B1 && focus.file === null, `名字 ${JSON.stringify(names)}；焦点 ${JSON.stringify(focus)}`);
}

// ---------- 走查 6：草稿 ----------

/** @brief 在 A 写半句话，切到 B 再回 A；去设置页再"返回会话"：草稿都在。 */
async function drafts(ctx) {
  const { page, h } = ctx;
  await openRow(page, ctx.files.A1);
  await h.textarea.fill(DRAFT);
  await openRow(page, ctx.files.B1);
  const other = await h.textarea.inputValue();
  await openRow(page, ctx.files.A1);
  const back = await h.textarea.inputValue();
  record('草稿：在 A 写半句话，切到 B 再回 A，输入框里是原来的字（B 的输入框里没有它）', back === DRAFT && other !== DRAFT,
    `A：${back}；B：${other}`);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: '返回会话' }).click();
  await paneOf(page).waitFor({ timeout: 10000 });
  const settings = await h.textarea.inputValue();
  const stored = await savedDrafts(page);
  const key = Object.keys(stored).find((item) => samePath(item, ctx.files.A1));
  record('草稿：去设置页再"返回会话"，输入框里是原来的字；草稿按会话文件存在本机', settings === DRAFT
    && stored[key] === DRAFT, `输入框：${settings}；保存的：${JSON.stringify(stored)}`);
}

// ---------- 走查 3：重启 ----------

/** @brief 先建一个不发消息的新会话，再重启：会话树、名字、没保存的新会话、状态点、中栏说明。 */
async function restartTree(ctx) {
  ctx.files.U = await ctrlN(ctx.page);
  await relaunch(ctx);
  const { page } = ctx;
  const rows = await allRows(page);
  const groups = await treeState(page);
  const { A1, A2, B1, B2, K, U } = ctx.files;
  const want = [[A1, NAMES.A1], [A2, titleOf(MESSAGES.A2)], [B1, NAMES.B1], [B2, titleOf(MESSAGES.B2)], [K, NAMES.K]];
  const wrong = want.filter(([file, title]) => rows.find((row) => samePath(row.file, file))?.title !== title);
  record('重启：会话树列出两个项目和全部保存过的会话，改过的名字还在', groups.length === 2 && rows.length === 5
    && wrong.length === 0, JSON.stringify(rows.map((row) => [row.title, row.cwd])));
  record('重启：上次运行里没发消息的"新会话"不在了（pi 的做法）', !rows.some((row) => samePath(row.file, U))
    && !rows.some((row) => row.title === '新会话'), JSON.stringify(rows.map((row) => row.title)));
  record('重启：没有状态圆点（状态只给本次运行中打开过的会话）', rows.every((row) => row.status === null),
    JSON.stringify(rows.map((row) => row.status)));
  const prompt = page.getByTestId('open-folder');
  const text = await prompt.innerText({ timeout: 5000 }).catch(() => '');
  record('中栏没有会话：显示"打开一个文件夹"、"打开文件夹…"，说明"从左侧选一个会话继续，或打开一个文件夹开始新的会话。"',
    text.includes('打开一个文件夹') && text.includes('打开文件夹…') && text.includes(PICK_HINT), oneLine(text));
  await shot(page, '03-restart');
}

/** @brief 重启后打开已保存的会话：完整对话、顶栏会话名；改过名的会话顶栏显示名字；草稿恢复。 */
async function restartOpen(ctx) {
  const { page, h } = ctx;
  await openRow(page, ctx.files.A2);
  await page.waitForFunction((selector) => document.querySelectorAll(`${selector} [data-testid="assistant"]`)
    .length >= 2, PANE, { timeout: 10000 }).catch(() => {});
  const users = await paneOf(page).getByTestId('user-message').allInnerTexts();
  const replies = await paneOf(page).getByTestId('assistant').allInnerTexts();
  const top = await topTitle(page);
  record('重启后打开已保存的会话：中栏显示完整对话（你的消息和助手的回复），顶栏显示会话名',
    users.includes(MESSAGES.A2) && users.includes('wait 6s') && replies.some((text) => text.includes(PLAIN_REPLY))
    && replies.some((text) => text.includes('等了 6 秒')) && top === titleOf(MESSAGES.A2),
    `你的消息 ${JSON.stringify(users)}；回复 ${JSON.stringify(replies.map((text) => oneLine(text, 40)))}；顶栏 ${top}`);
  await openRow(page, ctx.files.K);
  const named = await topTitle(page);
  record('重启后打开改过名的会话：顶栏显示它的名字', named === NAMES.K, named);
  await openRow(page, ctx.files.A1);
  const draft = await h.textarea.inputValue();
  record('草稿：重启后打开 A，输入框里是原来的字', draft === DRAFT, draft);
  await shot(page, '04-restart-open');
}

/** @brief 改名本次没打开过的会话：写进它的会话文件，不打开它。 */
async function renameUnopened(ctx) {
  const { page } = ctx;
  const panes = await paneCount(page);
  const { menu } = await openMenuByMouse(page, ctx.files.B2);
  await menu.getByRole('menuitem', { name: /^重命名/ }).click();
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  const view = await renameView(input);
  await input.fill(NAMES.B2);
  await input.press('Enter');
  const closed = await renameClosed(page);
  const shown = await waitRowTitle(page, ctx.files.B2, NAMES.B2);
  const names = sessionNames(ctx.files.B2);
  const row = await rowState(page, ctx.files.B2);
  record('改名没打开的会话：预填第一条消息的前 20 个字；保存后侧栏显示新名字，写进它的会话文件，不打开它',
    view.value === prefillOf(MESSAGES.B2) && closed && shown && names.at(-1) === NAMES.B2
    && await paneCount(page) === panes && !row?.active && row?.status === null,
    `改名框 ${JSON.stringify(view)}；名字 ${JSON.stringify(names)}；行 ${JSON.stringify(row)}`);
}

// ---------- 走查 5：项目信任 ----------

/** @brief 打开带 .pi/extensions 的 gamma：询问框的文字、路径、"记住"不勾、焦点在"不信任"；回答前扩展没有运行。 */
async function trustAsk(ctx) {
  const { page } = ctx;
  const { project, marker } = ctx.trust.gamma;
  await clickOpenFolder(ctx, project);
  const dialog = page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await sleep(300);
  const text = await dialog.innerText();
  const path = await dialog.getByTestId('trust-path').innerText();
  const remember = dialog.getByRole('checkbox', { name: '记住' });
  const checked = await remember.isChecked();
  const focus = await focusInfo(page);
  record('信任询问：对话框"信任这个文件夹？"，说明"这个文件夹带有自己的扩展或配置，信任后它们会在你的电脑上运行。"、'
    + '完整路径、复选框"记住"（默认不勾）；按钮"信任"和"不信任"，焦点在"不信任"', text.includes('信任这个文件夹？')
    && text.includes(TRUST_TEXT) && samePath(path, project) && !checked && focus.text === '不信任'
    && await dialog.getByRole('button', { name: '信任', exact: true }).count() === 1,
  `路径 ${path}；记住 ${checked}；焦点 ${focus.text}；${oneLine(text)}`);
  const waiting = await paneOf(page).getByTestId('not-ready').innerText().catch(() => '');
  record('信任询问：中栏已切到这个会话，显示"正在启动…"；回答之前项目自带的扩展一个都不加载（扩展没有运行）',
    waiting === '正在启动…' && !existsSync(marker), `按钮位置：${waiting}；marker 存在 ${existsSync(marker)}`);
  await shot(page, '05-trust-dialog');
  await trustDialogKeys(ctx, dialog);
}

/** @brief 询问框里 Tab 只在复选框和两个按钮之间切换；询问开着时 Ctrl+N 不起作用。 */
async function trustDialogKeys(ctx, dialog) {
  const { page } = ctx;
  const seq = [];
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('Tab');
    const focus = await focusInfo(page);
    seq.push(focus.type === 'checkbox' ? 'checkbox' : focus.text);
  }
  record('信任询问：Tab 只在复选框和两个按钮之间切换', JSON.stringify(seq) === '["checkbox","信任","不信任","checkbox"]',
    JSON.stringify(seq));
  const panes = await paneCount(page);
  await page.keyboard.press('Control+n');
  await sleep(800);
  record('Ctrl+N 不起作用：信任询问开着时什么都不发生', await paneCount(page) === panes
    && await dialog.count() === 1, `会话面板 ${panes} → ${await paneCount(page)}`);
}

/** @brief 选"不信任"：横幅、扩展没有运行、工具里没有 project_hello；同一个文件夹 Ctrl+N 本次不再问。 */
async function trustDeny(ctx) {
  const { page } = ctx;
  const { marker } = ctx.trust.gamma;
  await page.getByTestId('trust-dialog').getByRole('button', { name: '不信任' }).click();
  await page.getByTestId('trust-dialog').waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
  const composer = await waitComposerFocus(page);
  const banner = await paneOf(page).getByTestId('trust-banner').innerText({ timeout: 5000 }).catch(() => '');
  record('不信任：顶栏下横幅"没有信任这个文件夹，它自带的扩展和配置没有加载"，后面说明"重启 Mori 后会再问"；'
    + '扩展没有运行；回答后焦点进这个会话的输入框', banner.startsWith(UNTRUSTED) && banner.includes(ASK_AGAIN)
    && !existsSync(marker) && composer, `横幅：${banner}；marker 存在 ${existsSync(marker)}；焦点在输入框 ${composer}`);
  ctx.files.G1 = await activeFile(page);
  const info = await liveInfo(page, ctx.files.G1);
  await sendWait(ctx, 'list tools');
  const reply = await lastReply(page);
  record('不信任：项目扩展注册的工具不出现（会话信息的 tools 里没有 project_hello，问模型能用哪些工具时也没有它）',
    info.projectTrust === 'untrusted' && !info.tools.includes('project_hello') && reply.includes('可用的工具：')
    && !reply.includes('project_hello'), `${JSON.stringify(info)}；回复：${oneLine(reply)}`);
  await shot(page, '06-untrusted');
  const before = await paneCount(page);
  await page.keyboard.press('Control+n');
  await waitPanes(page, before + 1);
  const asked = await page.getByTestId('trust-dialog').waitFor({ timeout: 2000 }).then(() => true, () => false);
  if (asked) await page.keyboard.press('Escape');
  await waitReady(page);
  const again = await paneOf(page).getByTestId('trust-banner').innerText({ timeout: 5000 }).catch(() => '');
  record('本次回答过：同一个文件夹里 Ctrl+N 新建会话不再问，直接带上这个回答打开（仍是不信任，扩展没有运行）',
    !asked && again.startsWith(UNTRUSTED) && !existsSync(marker), `弹了询问 ${asked}；横幅 ${again}`);
}

/** @brief 另一个没信任的文件夹（delta）：询问框里按 Esc 等于不信任（不记住）。 */
async function trustEsc(ctx) {
  const { page } = ctx;
  const { project, marker } = ctx.trust.delta;
  await clickOpenFolder(ctx, project);
  const banner = await answerTrustDialog(page, { answer: 'esc' });
  const composer = await waitComposerFocus(page);
  const info = await liveInfo(page, await activeFile(page));
  record('信任询问：Esc 等于不信任（不记住）：横幅"没有信任这个文件夹……"和"重启 Mori 后会再问"，扩展没有运行，'
    + '没有写进 trust.json，焦点进输入框', banner.startsWith(UNTRUSTED) && banner.includes(ASK_AGAIN)
    && info.projectTrust === 'untrusted' && !existsSync(marker) && trustRecord(ctx.userData, project) === undefined
    && composer, `横幅 ${banner}；${JSON.stringify(info)}`);
}

/** @brief zeta：勾"记住"再选"不信任"：写进 trust.json；横幅不该说"重启 Mori 后会再问"。 */
async function trustRememberDeny(ctx) {
  const { page } = ctx;
  const { project, marker } = ctx.trust.zeta;
  await clickOpenFolder(ctx, project);
  const banner = await answerTrustDialog(page, { answer: '不信任', remember: true });
  const saved = trustRecord(ctx.userData, project);
  record('信任询问：勾"记住"再选"不信任"，选择写进 pi 的 trust.json（本文件夹记为 false），扩展没有运行',
    saved === false && banner.startsWith(UNTRUSTED) && !existsSync(marker), `trust.json：${saved}；横幅 ${banner}`);
  record('不信任（这次勾了"记住"）：横幅说"你选过记住"，不说"重启 Mori 后会再问"（只有这次没勾"记住"时才这样说）',
    banner.startsWith(UNTRUSTED) && !banner.includes(ASK_AGAIN) && banner.includes('你选过记住'), banner);
}

/** @brief 反例（后台进程）：不经询问直接 session.create 一个带 .pi/extensions 的文件夹，扩展不加载。 */
async function trustCounterexample(ctx) {
  const { project, marker } = ctx.trust.epsilon;
  const result = await ctx.page.evaluate(async (cwd) => {
    const info = await window.mori.request({ type: 'session.create', cwd });
    return { projectTrust: info.projectTrust, tools: info.tools };
  }, project);
  record('反例（后台进程）：不经界面回答直接 session.create 带 .pi/extensions 的文件夹，projectTrust 为 unasked，'
    + 'tools 里没有 project_hello，扩展没有运行', result.projectTrust === 'unasked'
    && !result.tools.includes('project_hello') && !existsSync(marker), JSON.stringify(result));
}

// ---------- 走查 4：删除（照 Claude 桌面版，永久删除） ----------

/** @brief 确认框的文字、焦点、Tab；Esc 取消，什么都没变，焦点回到会话行。 */
async function deleteCancel(ctx) {
  const { page, h } = ctx;
  await openRow(page, ctx.files.A2);
  await h.textarea.fill('A2 的草稿，删除时一起删');
  const dialog = await startDelete(page, ctx.files.A2);
  const title = await dialog.locator('h2').innerText();
  const text = await dialog.innerText();
  const danger = await dialog.getByRole('button', { name: '删除', exact: true }).getAttribute('class');
  const focus = await focusInfo(page);
  const seq = [];
  for (let index = 0; index < 2; index += 1) {
    await page.keyboard.press('Tab');
    seq.push((await focusInfo(page)).text);
  }
  record('删除确认：对话框"永久删除会话\'会话名\'？"，说明"对话记录会被删除，无法恢复。"；按钮"删除"（危险色）和"取消"，'
    + '焦点在"取消"，Tab 只在两个按钮之间切换', title === `永久删除会话'${titleOf(MESSAGES.A2)}'？`
    && text.includes(DELETE_TEXT) && danger?.includes('danger') && focus.text === '取消'
    && JSON.stringify(seq) === '["删除","取消"]', `标题 ${title}；焦点 ${focus.text} → ${seq.join(' → ')}；${danger}`);
  await shot(page, '07-delete-dialog');
  await page.keyboard.press('Escape');
  const closed = await dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
  const after = await focusInfo(page);
  const row = await rowState(page, ctx.files.A2);
  record('删除确认：Esc 取消，什么都没变（会话行和文件都在），焦点回到会话行', closed && row?.active
    && existsSync(ctx.files.A2) && samePath(after.file, ctx.files.A2), `焦点 ${JSON.stringify(after)}`);
}

/**
 * @brief 删除当前会话 A2：会话行消失、文件被永久删除（原处、数据目录、测试文件夹都没有同名文件，系统回收站里也没有）、
 *        中栏回到"打开一个文件夹"、焦点到下一行、草稿删除。
 */
async function deleteConfirm(ctx) {
  const { page } = ctx;
  const file = ctx.files.A2;
  const name = basename(file);
  const rows = await allRows(page);
  const index = rows.findIndex((row) => samePath(row.file, file));
  const next = rows[index + 1]?.id ?? rows[index - 1]?.id ?? null;
  const draftBefore = hasDraft(await savedDrafts(page), file);
  const dialog = await startDelete(page, file);
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  const closed = await dialog.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  await sleep(500);
  const copies = [...findByName(ctx.userData, name), ...findByName(ctx.root, name)];
  const binned = recycleBinNames().filter((item) => item === name);
  record('删除：确认后对话框关闭、会话行消失，会话文件被永久删除（原处没有；数据目录和测试文件夹里没有同名文件；'
    + '系统回收站里也没有）', closed && !(await rowState(page, file)) && !existsSync(file) && copies.length === 0
    && binned.length === 0, `对话框关闭 ${closed}；同名文件 ${JSON.stringify(copies)}；回收站里 ${binned.length} 个`);
  const prompt = await page.getByTestId('open-folder').isVisible().catch(() => false);
  record('删除：删的是当前会话时中栏回到"打开一个文件夹"', prompt);
  const focus = await until(async () => {
    const info = await focusInfo(page);
    return info.row === next ? info : null;
  }, 2000) || await focusInfo(page);
  record('删除：焦点移到删除前排在它下面的会话行', focus.row === next, `应为 ${next}；焦点 ${JSON.stringify(focus)}`);
  const draftAfter = hasDraft(await savedDrafts(page), file);
  record('删除：草稿一起删除', draftBefore && !draftAfter, `删除前有草稿 ${draftBefore}，删除后 ${draftAfter}`);
}

/** @brief 正在生成的会话：菜单里"归档""删除"不可用，旁边小字"正在生成"；"重命名"可用。 */
async function deleteRunning(ctx) {
  const { page } = ctx;
  await openRow(page, ctx.files.B1);
  await ctx.h.send('wait 6s');
  await waitRunning(page);
  const menu = await openMenuByKey(page, ctx.files.B1);
  const items = await menuItems(menu);
  const [rename, archive, remove] = items;
  record('正在生成的会话：菜单里"归档""删除"不可用，旁边小字"正在生成"；"重命名"可用', items.length === 3
    && rename.label === '重命名' && !rename.disabled && archive.label === '归档' && archive.disabled
    && archive.hint === '正在生成' && remove.label === '删除' && remove.disabled && remove.hint === '正在生成',
  menuText(items));
  await noteSmallText(ctx, 'menu with hint');
  await shot(page, '08-delete-running');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 });
  await waitIdle(page, 30000);
}

/** @brief 还没有消息的新会话：不能归档；确认框说明"这个会话还没有消息。"；删除后行消失，没有文件要删。 */
async function deleteUnsaved(ctx) {
  const { page } = ctx;
  const file = await ctrlN(page);
  const menu = await openMenuByKey(page, file);
  const items = await menuItems(menu);
  const [rename, archive, remove] = items;
  record('还没保存的新会话：菜单里"归档"不可用，旁边小字"还没有消息"；"重命名""删除"可用', items.length === 3
    && !rename.disabled && archive.label === '归档' && archive.disabled && archive.hint === '还没有消息'
    && !remove.disabled, menuText(items));
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 });
  const dialog = await startDelete(page, file);
  const title = await dialog.locator('h2').innerText();
  const text = await dialog.innerText();
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  const closed = await dialog.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  await sleep(500);
  record('还没保存的新会话：确认框"永久删除会话\'新会话\'？"，说明改为"这个会话还没有消息。"；删除后会话行消失'
    + '（没有文件要删）', title === "永久删除会话'新会话'？" && text.includes(UNSAVED_TEXT) && !text.includes(DELETE_TEXT)
    && closed && !(await rowState(page, file)) && !existsSync(file), `标题 ${title}；${oneLine(text)}`);
}

/**
 * @brief 删除文件失败：测试拿住 B1 的会话文件不让删（EBUSY）。对话框显示"删除失败："加原文，文件还在，
 *        会话已经关闭、变回没打开的会话；放开文件后再点"删除"重试成功。
 */
async function deleteFail(ctx) {
  const { page } = ctx;
  const file = ctx.files.B1;
  await openRow(page, file);
  let release = holdFile(file);
  try {
    const dialog = await startDelete(page, file);
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    const error = dialog.locator('[role="alert"]');
    await error.waitFor({ timeout: 15000 });
    const message = await error.innerText();
    await sleep(500);
    const row = await rowState(page, file);
    const prompt = await page.getByTestId('open-folder').isVisible().catch(() => false);
    const raw = message.startsWith('删除失败：') ? message.slice('删除失败：'.length) : '';
    record('删除文件失败：对话框里"删除失败："加原文（主进程删除时的 EBUSY 原文）；文件还在；会话已经关闭，变回没打开的会话'
      + '（状态点消失；它是当前会话，中栏回到"打开一个文件夹"）', raw.startsWith('EBUSY') && raw.includes(basename(file))
      && existsSync(file) && Boolean(row) && row.status === null && samePath(row.id, file) && !row.active && prompt,
    `${message}；行 ${JSON.stringify(row)}`);
    await shot(page, '09-delete-failed');
    release();
    release = null;
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    const closed = await dialog.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
    await sleep(500);
    record('删除文件失败后放开文件再点"删除"重试：删除成功，会话行消失，文件被删除', closed
      && !(await rowState(page, file)) && !existsSync(file), `对话框关闭 ${closed}`);
  } finally {
    release?.();
  }
}

// ---------- 归档（照 Claude 桌面版，不确认、可以恢复） ----------

/**
 * @brief 在 alpha 新建会话 R、发一条消息、写草稿，再从菜单归档它（当前会话）：不确认，行移到"已归档 1"，
 *        本机记下，后台进程关闭它，文件还在，草稿保留，中栏回到"打开一个文件夹"，焦点到下一行。
 */
async function archiveActive(ctx) {
  const { page, h } = ctx;
  await openRow(page, ctx.files.A1);
  const file = await ctrlN(page);
  ctx.files.R = file;
  await sendWait(ctx, MESSAGES.R);
  await h.textarea.fill(ARCHIVE_DRAFT);
  const { sessionId } = await kernelOpen(page, file);
  const rows = await allRows(page);
  const index = rows.findIndex((row) => samePath(row.file, file));
  const next = rows[index + 1]?.id ?? rows[index - 1]?.id ?? null;
  await chooseMenuItem(page, file, '归档');
  const moved = await waitArchivedToggle(page, '已归档 1');
  const dialogs = await page.locator('[data-testid="delete-dialog"], [data-testid="confirm-dialog"]').count();
  const shelf = await archivedState(page);
  record('归档：不确认；会话行从项目下移到侧栏底部的"已归档"（"已归档 1"，默认收起）；会话文件还在', moved && dialogs === 0
    && !(await rowState(page, file)) && !shelf.expanded && existsSync(file), `${JSON.stringify(shelf)}；对话框 ${dialogs}`);
  const archived = await savedArchived(page);
  const drafts = await savedDrafts(page);
  const draft = Object.entries(drafts).find(([key]) => samePath(key, file))?.[1];
  record('归档：会话文件记进本机的已归档列表（localStorage 的 mori.archived）；草稿保留', archived.some((item) =>
    samePath(item, file)) && draft === ARCHIVE_DRAFT, `${JSON.stringify(archived)}；草稿 ${draft}`);
  const gone = await until(() => sessionGone(page, sessionId), 5000);
  record('归档：后台进程关闭了这个会话（原来的会话标识报 Unknown session）', gone, sessionId);
  const prompt = await page.getByTestId('open-folder').isVisible().catch(() => false);
  const focus = await until(async () => {
    const info = await focusInfo(page);
    return info.row === next ? info : null;
  }, 2000) || await focusInfo(page);
  record('归档：它是当前会话时中栏回到"打开一个文件夹"；焦点移到原来排在它下面的会话行', prompt && focus.row === next,
    `应为 ${next}；焦点 ${JSON.stringify(focus)}`);
}

/** @brief 第二次重启后：R 仍在"已归档"；展开、悬停；菜单"恢复""删除"，选"恢复"回到项目下（不打开）。 */
async function archiveRestore(ctx) {
  const { page } = ctx;
  const file = ctx.files.R;
  const before = await archivedState(page);
  record('归档后重启：仍在"已归档"（"已归档 1"、不在项目下，本机的已归档列表里还有它）', before.toggle === '已归档 1'
    && !(await rowState(page, file)) && (await savedArchived(page)).some((item) => samePath(item, file)),
  JSON.stringify(before));
  await expandArchived(page);
  const shown = await archivedState(page);
  const row = shown.rows[0];
  record('已归档列表：点"已归档 1"展开，列出已归档的会话，每行是会话名，悬停显示文件夹和完整名字', shown.expanded
    && shown.rows.length === 1 && samePath(row?.file, file) && row.title === titleOf(MESSAGES.R)
    && row.tip === `alpha · ${MESSAGES.R}`, JSON.stringify(shown));
  await noteSmallText(ctx, 'archived list');
  await shot(page, '10-archived');
  const panes = await paneCount(page);
  const { menu } = await openMenuByMouse(page, file);
  const items = await menuItems(menu);
  await menu.getByRole('menuitem', { name: '恢复' }).click();
  const back = await until(() => rowState(page, file), 5000);
  const after = await archivedState(page);
  const archived = await savedArchived(page);
  record('已归档的会话的菜单：恢复、删除；选"恢复"后回到它的项目下（不打开它），"已归档"消失，本机的已归档列表里没有它',
    menuText(items) === '恢复 / 删除' && Boolean(back) && samePath(back.cwd, ctx.folders.alpha) && !back.active
    && back.status === null && after.toggle === null && !archived.some((item) => samePath(item, file))
    && await paneCount(page) === panes, `菜单 ${menuText(items)}；行 ${JSON.stringify(back)}；${JSON.stringify(after)}`);
}

/** @brief 再归档没打开的 R，点"已归档"里的它：恢复并打开，显示完整对话，草稿还在。 */
async function archiveOpen(ctx) {
  const { page, h } = ctx;
  const file = ctx.files.R;
  await chooseMenuItem(page, file, '归档');
  await waitArchivedToggle(page, '已归档 1');
  await expandArchived(page);
  await rowOf(page, file).click();
  await waitReady(page);
  await page.waitForFunction((selector) => document.querySelectorAll(`${selector} [data-testid="assistant"]`)
    .length >= 1, PANE, { timeout: 10000 }).catch(() => {});
  const row = await rowState(page, file);
  const users = await paneOf(page).getByTestId('user-message').allInnerTexts();
  const reply = await lastReply(page);
  const draft = await h.textarea.inputValue();
  const shelf = await archivedState(page);
  record('点已归档的会话：恢复并打开它（回到项目下、成为当前会话，显示完整对话，草稿还在），"已归档"消失', row?.active
    && samePath(row.cwd, ctx.folders.alpha) && users.includes(MESSAGES.R) && reply.includes(PLAIN_REPLY)
    && draft === ARCHIVE_DRAFT && shelf.toggle === null, `行 ${JSON.stringify(row)}；你的消息 ${JSON.stringify(users)}；`
    + `回复 ${oneLine(reply, 60)}；草稿 ${draft}；${JSON.stringify(shelf)}`);
}

/** @brief 归档打开着的 R，再从"已归档"列表里删除它：确认后行消失、文件被删除、已归档列表里没有它。 */
async function archiveDelete(ctx) {
  const { page } = ctx;
  const file = ctx.files.R;
  await chooseMenuItem(page, file, '归档');
  await waitArchivedToggle(page, '已归档 1');
  await expandArchived(page);
  const dialog = await startDelete(page, file);
  const title = await dialog.locator('h2').innerText();
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  const closed = await dialog.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  await sleep(500);
  const shelf = await archivedState(page);
  const archived = await savedArchived(page);
  record('从"已归档"列表删除：确认框"永久删除会话\'会话名\'？"，删除后行消失（"已归档"也消失），文件被删除，'
    + '本机的已归档列表里没有它', title === `永久删除会话'${titleOf(MESSAGES.R)}'？` && closed && shelf.toggle === null
    && !(await rowState(page, file)) && !existsSync(file) && !archived.some((item) => samePath(item, file)),
  `标题 ${title}；${JSON.stringify(shelf)}；文件存在 ${existsSync(file)}`);
}

// ---------- 走查 7：状态 ----------

/** @brief 生成中切走：行显示"生成中"；本轮结束后"有新结果"；点开后消失。 */
async function statusRunning(ctx) {
  const { page } = ctx;
  const { A1, K } = ctx.files;
  await openRow(page, A1);
  await ctx.h.send('wait 4s');
  await waitRunning(page);
  await openRow(page, K);
  const running = await rowState(page, A1);
  record('状态：切走后生成中的会话行显示"生成中"（圆点加文字，跟在会话名右边）', running?.status === 'running'
    && running.statusText === '生成中' && running.statusRight, JSON.stringify(running));
  await noteSmallText(ctx, 'status running');
  const unseen = await waitStatus(page, A1, 'unseen');
  const row = await rowState(page, A1);
  record('状态：不在中栏显示的会话本轮结束时显示"有新结果"', unseen && row?.statusText === '有新结果',
    JSON.stringify(row));
  await shot(page, '11-status-unseen');
  await openRow(page, A1);
  record('状态："有新结果"在它重新显示在中栏时消失（点它）', await waitStatus(page, A1, null, 3000),
    JSON.stringify(await rowState(page, A1)));
}

/** @brief 不可见的会话等你批准：行显示"等你批准"；回去拒绝这张卡。 */
async function statusApproval(ctx) {
  const { page } = ctx;
  const { A1, K } = ctx.files;
  await openRow(page, K);
  await ctx.h.send('run: echo hi');
  await paneOf(page).getByTestId('approval-card').waitFor({ timeout: 20000 });
  await openRow(page, A1);
  const shown = await waitStatus(page, K, 'approval', 5000);
  const row = await rowState(page, K);
  record('状态：不可见的会话有挂起的批准请求时显示"等你批准"', shown && row?.statusText === '等你批准',
    JSON.stringify(row));
  await noteSmallText(ctx, 'status approval');
  await openRow(page, K);
  await ctx.h.textarea.press('Alt+3');
  await paneOf(page).getByTestId('approval-card').waitFor({ state: 'detached', timeout: 10000 });
  await waitIdle(page);
}

/** @brief 不可见的会话这一轮以错误结束：行显示"出错"；再发一条消息后消失。 */
async function statusError(ctx) {
  const { page } = ctx;
  const { A1, K } = ctx.files;
  await openRow(page, K);
  await ctx.h.send('http-400');
  await openRow(page, A1);
  const shown = await waitStatus(page, K, 'error');
  const row = await rowState(page, K);
  record('状态：不可见的会话最近一轮以错误结束时显示"出错"', shown && row?.statusText === '出错', JSON.stringify(row));
  await noteSmallText(ctx, 'status error');
  await openRow(page, K);
  await sendWait(ctx, 'plain 再发一条消息');
  record('状态："出错"在再发一条消息后消失', await waitStatus(page, K, null, 3000), JSON.stringify(await rowState(page, K)));
}

/** @brief 不可见的会话生成中时后台进程退出：行显示"出错"，"新会话"不可用；重新载入后重新打开，"出错"消失。 */
async function statusKernelExit(ctx) {
  const { app, page } = ctx;
  const { A1, K } = ctx.files;
  await openRow(page, A1);
  await ctx.h.send('wait 6s');
  await waitRunning(page);
  await openRow(page, K);
  killKernel(app);
  await paneOf(page).getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  const error = await waitStatus(page, A1, 'error', 5000);
  const button = page.getByTestId('new-session');
  const folder = page.getByTestId('sidebar').getByRole('button', { name: '打开文件夹…' });
  const tip = await button.getAttribute('title');
  record('后台进程意外退出：退出时正在生成的会话显示"出错"；"新会话""打开文件夹…"不可用，悬停说明"后台进程已退出，先重新载入"',
    error && await button.isDisabled() && await folder.isDisabled() && tip === '后台进程已退出，先重新载入',
    `${JSON.stringify(await rowState(page, A1))}；提示 ${tip}`);
  await shot(page, '12-kernel-exit');
  await paneOf(page).getByRole('button', { name: '重新载入' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="new-session"]')?.disabled, null,
    { timeout: 30000 });
  const cleared = await waitStatus(page, A1, null, 30000);
  record('重新载入：打开过的会话重新打开，"出错"在重新打开成功后消失；"新会话"重新可用', cleared,
    JSON.stringify(await rowState(page, A1)));
  await waitReady(page);
}

// ---------- 窄窗口与 Ctrl+N ----------

/** @brief 窄窗口：图标栏、"展开"按钮上的圆点、浮动左栏开着时 Ctrl+N 不起作用、点会话后浮动左栏收起。 */
async function narrowWindow(ctx) {
  const { app, page } = ctx;
  const { A1, K } = ctx.files;
  await openRow(page, A1);
  await ctx.h.send('wait 2s');
  await waitRunning(page);
  await openRow(page, K);
  await waitStatus(page, A1, 'unseen');
  ctx.bounds = await app.evaluate(resizeMain, { width: 900, height: 700 });
  await page.waitForFunction(() => innerWidth < 1024, null, { timeout: 5000 });
  await sleep(300);
  const sidebar = page.getByTestId('sidebar');
  const collapsed = (await sidebar.getAttribute('class')).includes('collapsed');
  const treeShown = await page.getByTestId('session-tree').isVisible().catch(() => false);
  const dot = await page.getByTestId('rail-status').getAttribute('class', { timeout: 3000 }).catch(() => null);
  const label = await page.locator('.rail-toggle').getAttribute('aria-label');
  record('窄窗口：左栏收起为图标栏，会话树不显示；不在中栏的会话"有新结果"时"展开"按钮上显示圆点，'
    + '读屏名称"展开侧栏（有会话有新结果）"', collapsed && !treeShown && Boolean(dot?.includes('unseen'))
    && label === '展开侧栏（有会话有新结果）', `收起 ${collapsed}，树可见 ${treeShown}，圆点 ${dot}，名称 ${label}`);
  await shot(page, '13-narrow-rail');
  await page.locator('.rail-toggle').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]')?.classList.contains('floating'),
    null, { timeout: 3000 });
  const panes = await paneCount(page);
  await page.keyboard.press('Control+n');
  await sleep(800);
  record('Ctrl+N 不起作用：窄窗口下浮动展开的左栏开着时什么都不发生', await paneCount(page) === panes);
  await rowOf(page, A1).click();
  const closed = await page.waitForFunction(() => !document.querySelector('[data-testid="sidebar"]')
    ?.classList.contains('floating'), null, { timeout: 3000 }).then(() => true, () => false);
  const active = await page.locator('.pane-slot:not([hidden]) [data-testid="session-title"]').innerText();
  record('窄窗口：浮动展开的左栏里打开或切换会话后，左栏自动收起', closed && active === NAMES.A1, `顶栏 ${active}`);
  await app.evaluate(restoreMain, ctx.bounds);
  ctx.bounds = null;
  await page.waitForFunction(() => innerWidth >= 1024, null, { timeout: 5000 });
}

/** @brief 按住 Ctrl+N 不放：重复按键不再新建，只有一个新会话。 */
async function ctrlNRepeat(ctx) {
  const { page } = ctx;
  await waitReady(page);
  const before = await paneCount(page);
  await page.keyboard.down('Control');
  await page.keyboard.down('n');
  await waitPanes(page, before + 1);
  await waitReady(page);
  await page.keyboard.down('n');
  await page.keyboard.down('n');
  await sleep(1500);
  await page.keyboard.up('n');
  await page.keyboard.up('Control');
  const after = await paneCount(page);
  record('Ctrl+N 不起作用：按住不放的重复按键只新建一个会话', after === before + 1, `会话面板 ${before} → ${after}`);
}

// ---------- 重启之后 ----------

/** @brief 第二次重启：删掉的会话和草稿不在；没打开时改的名字还在。 */
async function restartDeleted(ctx) {
  await relaunch(ctx);
  const { page } = ctx;
  const rows = await allRows(page);
  const drafts = await savedDrafts(page);
  const gone = [ctx.files.A2, ctx.files.B1];
  record('删除后重启：删掉的会话不再出现，它们的草稿也不在', gone.every((file) => !rows.some((row) =>
    samePath(row.file, file)) && !hasDraft(drafts, file)), JSON.stringify(rows.map((row) => row.title)));
  const b2 = rows.find((row) => samePath(row.file, ctx.files.B2));
  record('改名没打开的会话：重启后仍是新名字', b2?.title === NAMES.B2, JSON.stringify(b2));
}

/** @brief 重启后打开 gamma 里保存的会话：再问一次；勾"记住"选"信任"：扩展运行、工具可用、批准卡、结果。 */
async function trustAgain(ctx) {
  const { page } = ctx;
  const { project, marker } = ctx.trust.gamma;
  await rowOf(page, ctx.files.G1).click();
  const asked = await page.getByTestId('trust-dialog').waitFor({ timeout: 15000 }).then(() => true, () => false);
  record('重启后打开这个文件夹里已保存的会话：再问一次（上次没勾"记住"）', asked && !existsSync(marker),
    `marker 存在 ${existsSync(marker)}`);
  const banner = await answerTrustDialog(page, { answer: '信任', remember: true });
  const info = await liveInfo(page, ctx.files.G1);
  record('信任（勾"记住"）：项目扩展运行，选择写进 pi 的 trust.json（本文件夹记为 true），没有"没有信任"的横幅',
    existsSync(marker) && trustRecord(ctx.userData, project) === true && banner === ''
    && info.projectTrust === 'trusted', `横幅 ${banner}；${JSON.stringify(info)}`);
  // pi 打开已保存的会话时按会话记录恢复当时的工具集（agent-session.js _restoreToolsFromTranscript）；
  // Mori 照 Claude Code 在打开后补上现在注册了的扩展工具（sessions.md），所以"不信任"时保存的这个旧会话也有它。
  record('信任：重新打开"不信任"时保存的会话并选"信任"后，扩展运行，这个旧会话也有项目扩展的工具 project_hello'
    + '（打开时补上现在注册了的扩展工具）', existsSync(marker) && info.tools.includes('project_hello'),
  JSON.stringify(info.tools));
  await sendWait(ctx, 'list tools');
  const sent = await lastReply(page);
  record('信任：重新打开"不信任"时保存的会话后，发给模型的请求里也有 project_hello（合成端点列出请求里的工具）',
    sent.includes('project_hello'), oneLine(sent));
  ctx.files.G3 = await ctrlN(page);
  const fresh = await liveInfo(page, ctx.files.G3);
  await sendWait(ctx, 'list tools');
  const reply = await lastReply(page);
  record('信任：同一个文件夹里新建的会话不再问，项目扩展注册的工具可以用（会话信息的 tools 和问模型能用哪些工具时都有 '
    + 'project_hello）', fresh.projectTrust === 'trusted' && fresh.tools.includes('project_hello')
    && reply.includes('project_hello') && await page.getByTestId('trust-dialog').count() === 0,
  `${JSON.stringify(fresh)}；${oneLine(reply)}`);
  await trustedToolCard(ctx);
}

/** @brief 让模型调用 project_hello：批准卡标题为工具原名；Alt+1 允许后结果是"hello from project"。 */
async function trustedToolCard(ctx) {
  const { page } = ctx;
  await ctx.h.send('call tool: project_hello');
  const card = paneOf(page).getByTestId('approval-card');
  await card.waitFor({ timeout: 20000 });
  const tool = await card.getAttribute('data-tool');
  const title = await card.getByTestId('approval-title').innerText();
  record('信任：让模型调用项目扩展的工具时出批准卡，标题为工具原名 project_hello', tool === 'project_hello'
    && title.trim() === 'project_hello', `data-tool ${tool}；标题 ${title}`);
  await shot(page, '14-project-tool-card');
  await ctx.h.textarea.press('Alt+1');
  await card.waitFor({ state: 'detached', timeout: 10000 });
  await waitIdle(page);
  const last = paneOf(page).getByTestId('tool-card').last();
  const status = await last.getAttribute('data-status');
  await last.locator('summary').click();
  const body = await last.locator('.tool-body').innerText({ timeout: 5000 }).catch(() => '');
  record('信任：Alt+1 允许后工具执行完成，结果是"hello from project"', status === 'done'
    && body.includes('hello from project'), `状态 ${status}；${oneLine(body)}`);
}

/** @brief 记住"不信任"后重启：打开 zeta 不再问，横幅说"你选过记住"。 */
async function zetaRemembered(ctx) {
  const { page } = ctx;
  const { project, marker } = ctx.trust.zeta;
  await clickOpenFolder(ctx, project);
  const asked = await page.getByTestId('trust-dialog').waitFor({ timeout: 2000 }).then(() => true, () => false);
  if (asked) await page.keyboard.press('Escape');
  await waitReady(page);
  const banner = await paneOf(page).getByTestId('trust-banner').innerText({ timeout: 3000 }).catch(() => '');
  const how = `你选过记住；要改回，删掉 ${join(ctx.userData, 'pi')}\\trust.json 里这个文件夹的记录后重新打开`;
  record('记住"不信任"后重启：不再问；横幅"没有信任这个文件夹，它自带的扩展和配置没有加载"，说明'
    + '"你选过记住；要改回，删掉 <agentDir>\\trust.json 里这个文件夹的记录后重新打开"', !asked
    && banner.startsWith(UNTRUSTED) && banner.includes(how) && !existsSync(marker), `横幅 ${banner}`);
}

/** @brief 第三次重启：打开 gamma 的会话不再询问，扩展照常加载；改过的名字仍在。 */
async function trustRemembered(ctx) {
  const { marker } = ctx.trust.gamma;
  rmSync(marker, { force: true });
  await relaunch(ctx);
  const { page } = ctx;
  await rowOf(page, ctx.files.G3).click();
  const asked = await page.getByTestId('trust-dialog').waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (asked) await page.keyboard.press('Escape');
  await waitReady(page);
  const banner = await paneOf(page).getByTestId('trust-banner').count();
  const info = await liveInfo(page, ctx.files.G3);
  record('记住"信任"后重启：打开这个文件夹里的会话不再询问，扩展照常加载，工具可用', !asked && banner === 0
    && existsSync(marker) && info.projectTrust === 'trusted' && info.tools.includes('project_hello'),
  `询问 ${asked}；${JSON.stringify(info)}`);
  const rows = await allRows(page);
  record('改过的名字跨多次重启仍在', [[ctx.files.B2, NAMES.B2], [ctx.files.K, NAMES.K], [ctx.files.A1, NAMES.A1]]
    .every(([file, name]) => rows.find((row) => samePath(row.file, file))?.title === name),
  JSON.stringify(rows.map((row) => row.title)));
  await noteSmallText(ctx, 'final');
}

// ---------- 出错后的恢复 ----------

/** @brief 某一步出错后尽量回到空闲：恢复窗口、松开按键、关浮层、重新载入、答掉卡片、停止生成、清空输入框。 */
async function recover(ctx) {
  const { app, page } = ctx;
  if (ctx.bounds) await app.evaluate(restoreMain, ctx.bounds).catch(() => {});
  ctx.bounds = null;
  await page.keyboard.up('n').catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
  for (let tries = 0; tries < 4 && await page.locator(OVERLAYS).count() > 0; tries += 1) {
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  if (await page.getByTestId('kernel-exit').count() > 0) {
    await page.getByRole('button', { name: '重新载入' }).first().click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="new-session"]')?.disabled, null,
      { timeout: 30000 });
  }
  const pane = paneOf(page);
  if (await pane.count() === 0) return;
  if (await pane.getByTestId('approval-card').count() > 0) await ctx.h.textarea.press('Alt+3');
  for (let tries = 0; tries < 4 && await pane.getByTestId('ext-ui-card').count() > 0; tries += 1) {
    await pane.getByTestId('ext-ui-card').getByRole('button', { name: /^(否|取消)$/ }).first().click({ timeout: 3000 });
    await sleep(300);
  }
  if (await pane.getAttribute('data-running', { timeout: 2000 }) === 'true') {
    await pane.locator('.stop-button').click({ timeout: 5000 });
    await waitIdle(page, 30000);
  }
  await pane.locator('.composer textarea').fill('', { timeout: 5000 });
}

const steps = {
  setup, buildTree, keyboardPath, arrowKeys, keyboardRename, renameBeforeFirstMessage, menuOpeners, renamePrefill,
  renameEsc, renameEmpty, renameEscRunning, renameBlur, drafts, restartTree, restartOpen, renameUnopened, trustAsk,
  trustDeny, trustEsc, trustRememberDeny, trustCounterexample, deleteCancel, deleteConfirm, deleteRunning,
  deleteUnsaved, deleteFail, archiveActive, statusRunning, statusApproval, statusError, statusKernelExit, narrowWindow,
  ctrlNRepeat, restartDeleted, archiveRestore, archiveOpen, archiveDelete, trustAgain, zetaRemembered, trustRemembered,
  ...liveSteps,
};

const fake = await startFakeEndpoint();
const { root, folders, trust } = prepareFolders();
const userData = mkdtempSync(join(tmpdir(), 'mori-m3-app-data-'));
const ctx = { userData, root, folders, trust, files: {}, pageErrors: [], small: [], smallChecked: [], runs: 0,
  bounds: null, live: null, record, shot };
await startApp(ctx);
try {
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      await shot(ctx.page, `${name}-error`);
      await recover(ctx).catch((problem) => console.error(`[m3-app] recover after ${name}: ${oneLine(problem)}`));
    }
  }
} finally {
  record('左栏（和会话菜单）没有小于 12px 的文字', ctx.small.length === 0 && ctx.smallChecked.length > 0,
    `检查于 ${ctx.smallChecked.join('、')}；${ctx.small.slice(0, 5).join('; ')}`);
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app.close().catch(() => {});
  fake.kill();
}
console.log(`[m3-app] folders in ${root}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`m3-app${suffix}.json`) ? 0 : 1;
