// M2 整机测试：真正的 Mori（界面 + 后台进程 + pi）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖批准卡（修改、命令、写入、一条回复两条命令与"Queued"、项目外的路径、不可见的控制字符）、Alt+1/2/3 与理由
// （小键盘数字和浮层开着时不算）、长理由的截短、Esc 的几种含义（先关浮层）、"Allowed for this session"与权限菜单、
// 全部允许与确认、新会话重新询问（不继承"Allowed for this session"和"Allow all"）、出卡时对话停在底部、最小窗口的布局、
// 重新载入后认出"Denied"、任务栏闪烁、F8 报告界面问题（报告里没有 key、保存中按 Esc 不关闭）。
// 2026-10-21 起权限按钮在输入框下面一行的左端（docs/v0/composer-pickers.md）：权限菜单往上打开、左对齐这一行、不出界、
// 列表很长时在菜单里滚动，这一行同时只开一个浮层，新卡来时关闭这一行开着的浮层，Tab 移出时关闭，第一次打开中、
// 后台进程退出、重新载入、Restart 之后重新打开中这一行的样子、不可用的原因和焦点（开着的"Allow all"确认框按取消关上），
// 最小窗口里这一行完整可见，
// F8 报告"Current view"的"Model range""Effort"和"Pane width"。
// 状态表见 docs/v0/screens/approval.md、models.md、chat.md、tool-cards.md 与 f8.md；首次启动与打开文件夹沿用 M1 的流程，
// 不再逐项检查。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m2-app.mjs                         测开发构建
//   node tests/ui/m2-app.mjs --exe <Mori.exe 路径>   测打包后的程序
//   node tests/ui/m2-app.mjs --only 步骤1,步骤2       只跑这几步（setup 总是跑；测试分层第 2 条）
// 结果写到 test-results/m2-app.json（文件名带 -packaged 后缀区分），截图在 test-results/m2-app/。
// 主进程里的 flashFrame 和 shell.showItemInFolder 经 app.evaluate 换成记录调用的版本（后者不会真的打开资源管理器）；
// 保存报告的 IPC 处理（mori:save-issue）临时包一层延迟，用来测"Saving…"；最小窗口经 BrowserWindow.setSize 设置。
// 2026-10-26（docs/v0/screens/window.md）：窗口藏在托盘里时出现批准卡，窗口以最小化的样子回到任务栏再闪烁；托盘经
// tray-helpers.mjs 在主进程里找到。窗口藏着或最小化时页面不跑 requestAnimationFrame，这段时间只在主进程里查状态。
// 审查修正（同日）：窗口藏着时后台进程意外退出，Mori 不退出、托盘图标还在，回到窗口后看到横幅和"Restart"。
// 状态表各行的用例（同日，WP-20 记录"状态表各行的用例"）：关窗口前已经在等的批准卡回来后还在、Alt+1 照常批准
// （closeKeepsCard）；两个会话都在生成时托盘"Exit"的确认框说明是复数（quitTwoSessions）。
// U10 的两个异常分支（同日，docs/v0/defaults.md）：写不进标记文件时每次关窗口都弹气泡（noticeUnwritable）；确认框弹不出来时
// "Exit"什么都不做（exitNoDialog）。主进程的错误日志从它的标准错误读。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import {
  allowedOverflow, effortTipProblems, f8ViewProblems, modeProblems, paneFacts, PERMISSION_MENU, permissionMenuProblems,
  permissionState, permissionTipProblems, rangeTipProblems, ROW, ROW_HEIGHT, rowLog, rowMenuState, viewFields, watchRow,
} from './m2-helpers.mjs';
import { OPEN_FOLDER, pageHelpers } from './page.mjs';
import {
  ASK_ERROR, balloonCalls, clickTrayIcon, clickTrayItem, closeWindow, collectMainLog, failMarkerWrites,
  failMessageBoxOnce, findTray, isNotice, MARKER_ERROR, markerAttempts, messageBoxes, NOTICE_MARKER, NOTICE_TITLE,
  offScreen, onScreen, quitDetail, recordBalloons, restoreMarkerWrites, restoreMessageBox, stubMessageBox, waitLogCount,
  waitMessageBoxes, waitWindow, windowState,
} from './tray-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const only = arg('only')?.split(',');
const port = 4322;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关；F8 报告里不能出现它。
const testKey = 'synthetic-test-key-m2';
const shots = join(appRoot, `test-results/m2-app${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');

/** 当前显示的会话面板（隐藏的会话面板仍然挂载，找元素都限定在这里） */
const PANE = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';
/** 让合成端点调用 edit 改 README 标题；原文是标题的前缀，改过几次后仍能唯一匹配 */
const EDIT_README = 'edit README: # Mori fixture project';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ISSUE_HEADINGS = ['# UI issue · ', '## What went wrong', '## What you expected', '## Screenshot',
  '## Current view', '## Recent activity', '## Versions'];
/** "Queue"旁边 ▾（"More send options"）的下拉 */
const QUEUE_MENU = '.split-button [role="menu"]';
/** recover 要关掉的浮层：报告框、确认框、这一行的三个菜单、圆环详情、"Queue"的下拉 */
const OVERLAYS = ['[data-testid="issue-dialog"]', '[data-testid="confirm-dialog"]', PERMISSION_MENU,
  '[data-testid="model-menu"]', '[data-testid="thinking-menu"]', '[data-testid="usage-details"]', QUEUE_MENU]
  .join(', ');
/** 12 行草稿：输入框长到最高 220px */
const TALL_DRAFT = Array.from({ length: 12 }, (_, index) => `草稿第 ${index + 1} 行`).join('\n');
/** 后台进程退出时按钮位置的说明，也是这一行按钮不可用的原因（models.md"不可用时、按钮消失时的焦点"） */
const CRASHED = 'Mori’s background process crashed';
/** 第一次打开中、Restart 之后重新打开中的原因 */
const STARTING = 'Starting…';
/** 重新载入中的原因 */
const RESTARTING = 'Restarting…';
/** 权限菜单很长时测试在列表里加的行数（composer-pickers.md"新加的检查"第 4 条） */
const MANY_ALLOWED = 30;
/** 60 个字的拒绝理由：工具卡状态行只显示前 40 个字 */
const LONG_REASON = '这一行标题和发布说明保持一致，'.repeat(4);
/** 项目外的提示 */
const OUTSIDE_TEXT = 'This file is outside the working directory';
/** 不可见控制字符的提示 */
const HIDDEN_TEXT = 'Contains hidden characters, shown as ⟨U+XXXX⟩';
/** 停止后对话流里的提示 */
const STOPPED_TEXT = 'Stopped · Changes made so far stay as they are';

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

// ---------- 页面上的小工具 ----------

/** @brief 当前显示的会话面板。 */
const paneOf = (page) => page.locator(PANE);
/** @brief 当前会话面板输入框下面一行的权限按钮。 */
const permissionButton = (page) => paneOf(page).locator(`${ROW} [data-testid="permission-button"]`);
/** @brief 当前会话面板输入框下面一行的选择范围按钮。 */
const modelButton = (page) => paneOf(page).locator(`${ROW} [data-testid="model-button"]`);
/** @brief 当前会话面板输入框下面一行的 Effort 按钮。 */
const effortButton = (page) => paneOf(page).locator(`${ROW} [data-testid="thinking-button"]`);
/** @brief 当前会话面板输入框下面一行的上下文用量圆环。 */
const usageButton = (page) => paneOf(page).locator(`${ROW} [data-testid="usage"]`);
/** @brief 当前会话面板"Queue"旁边的 ▾（"More send options"）。 */
const moreSendOptions = (page) => paneOf(page).getByRole('button', { name: 'More send options' });
/** @brief 这一行的高度约 33px（差 1px 以内）。 */
const rowHeightOk = (height) => Math.abs(height - ROW_HEIGHT) <= 1;

/** @brief 当前会话面板里的工具卡：标题、状态、状态文字、自动放行的标签。 */
function toolCards(page) {
  return paneOf(page).getByTestId('tool-card').evaluateAll((cards) => cards.map((card) => ({
    title: card.querySelector('.tool-title')?.textContent ?? '', status: card.dataset.status,
    text: card.querySelector('[data-testid="tool-status"]')?.textContent ?? '',
    badge: card.querySelector('[data-testid="tool-badge"]')?.textContent ?? '' })));
}

/** @brief 当前会话面板是否空闲、有没有批准卡。 */
function paneState(page) {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    return { card: Boolean(pane?.querySelector('[data-testid="approval-card"]')),
      idle: pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
        && !pane.querySelector('[data-testid="stage"]') };
  }, PANE);
}

/** @brief 等本轮结束（已知本轮已经开始时用）。 */
function waitIdle(page, timeout = 60000) {
  return page.waitForFunction((selector) => {
    const pane = document.querySelector(selector);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="stage"]');
  }, PANE, { timeout });
}

/** @brief 等本轮开始再等它结束；中途出现批准卡就允许它（用在"不该出卡"的检查里，免得一直等下去）。 */
async function idleAllowingCards(page, h, timeout = 60000) {
  await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE,
    { timeout: 20000 }).catch(() => {});
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await paneState(page);
    if (state.idle && !state.card) return;
    if (state.card) {
      await h.textarea.press('Alt+1');
      await waitCardGone(page, 5000).catch(() => {});
    }
    await sleep(200);
  }
  throw new Error(`run did not finish within ${timeout} ms`);
}

/** @brief 等出现一张新的批准卡（请求 id 与 previous 不同），返回它的请求 id。 */
async function waitCard(page, previous = null, timeout = 30000) {
  const handle = await page.waitForFunction(({ selector, old }) => {
    const card = document.querySelector(`${selector} [data-testid="approval-card"]`);
    return card && card.dataset.request !== old ? String(card.dataset.request) : null;
  }, { selector: PANE, old: previous }, { timeout });
  return handle.jsonValue();
}

/** @brief 等批准卡消失。 */
function waitCardGone(page, timeout = 15000) {
  return page.waitForFunction((selector) => !document.querySelector(`${selector} [data-testid="approval-card"]`),
    PANE, { timeout });
}

/** @brief 当前批准卡的内容；没有卡时为 null。 */
function cardInfo(page) {
  return page.evaluate((selector) => {
    const card = document.querySelector(`${selector} [data-testid="approval-card"]`);
    if (!card) return null;
    const text = (testId) => card.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
    const edits = [...card.querySelectorAll('[data-testid="approval-edit"]')].map((edit) => ({
      old: edit.querySelector('.approval-old')?.textContent ?? '',
      new: edit.querySelector('.approval-new')?.textContent ?? '' }));
    const title = card.querySelector('[data-testid="approval-title"]');
    return { tool: card.dataset.tool, request: card.dataset.request, text: card.textContent ?? '', edits,
      content: text('approval-content'), command: text('approval-command'), more: text('approval-more'),
      allowSession: text('approval-allow-session'), path: text('approval-path'), outside: text('approval-outside'),
      hidden: text('approval-hidden'), titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : null };
  }, PANE);
}

/** @brief 点卡上的"Deny"，等本轮结束。 */
async function rejectByButton(page) {
  await paneOf(page).getByTestId('approval-reject').click();
  await waitCardGone(page);
  await waitIdle(page);
}

/** @brief 用 MutationObserver 记下批准卡是否出现过（可能只出现一瞬间，轮询抓不到）。 */
function watchCards(page) {
  return page.evaluate(() => {
    window.__m2CardSeen = false;
    window.__m2CardObserver?.disconnect();
    window.__m2CardObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="approval-card"]')) window.__m2CardSeen = true;
    });
    window.__m2CardObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}

/** @brief watchCards 之后是否出现过批准卡。 */
const cardSeen = (page) => page.evaluate(() => window.__m2CardSeen);

/** @brief 界面每次变化时记下阶段行文字（去掉秒数）和有没有批准卡，变化才记。 */
function watchStages(page) {
  return page.evaluate((selector) => {
    window.__m2Stages = [];
    window.__m2StageObserver?.disconnect();
    const note = () => {
      const pane = document.querySelector(selector);
      const stage = pane?.querySelector('[data-testid="stage"]')?.textContent?.replace(/\s\d+(\.\d+)?s$/, '') ?? '';
      const card = Boolean(pane?.querySelector('[data-testid="approval-card"]'));
      const last = window.__m2Stages.at(-1);
      if (!last || last.stage !== stage || last.card !== card) window.__m2Stages.push({ stage, card });
    };
    window.__m2StageObserver = new MutationObserver(note);
    window.__m2StageObserver.observe(document.body,
      { subtree: true, childList: true, characterData: true, attributes: true });
    note();
  }, PANE);
}

/** @brief watchStages 记下的序列。 */
const stageLog = (page) => page.evaluate(() => window.__m2Stages ?? []);

/** @brief 等焦点在当前会话的输入框里（最多 timeout 毫秒）。 */
function waitComposerFocus(page, timeout = 2000) {
  return page.waitForFunction((selector) => document.activeElement
    === document.querySelector(`${selector} .composer textarea`), PANE, { timeout }).then(() => true, () => false);
}

/** @brief 当前会话面板里"Stopped · …"提示的条数。 */
const stoppedCount = (page) => paneOf(page).getByTestId('notice').filter({ hasText: STOPPED_TEXT }).count();

/** @brief 最后一张工具卡之后是否有一条新的助手回复，以及那条回复的文字。 */
function replyAfterLastCard(page) {
  return paneOf(page).evaluate((pane) => {
    const card = [...pane.querySelectorAll('[data-testid="tool-card"]')].at(-1);
    const reply = [...pane.querySelectorAll('[data-testid="assistant"]')].at(-1);
    const after = Boolean(card && reply && !reply.contains(card)
      && (card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING));
    return { after, text: reply?.textContent ?? '' };
  });
}

/** @brief 在 folder 里开一个新会话（系统的选文件夹对话框直接返回 folder），等新会话面板就绪。 */
async function openNewSession(app, page, folder) {
  const before = await page.locator('.pane-slot').count();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await page.getByRole('button', { name: OPEN_FOLDER }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll('.pane-slot').length > count, before,
    { timeout: 30000 });
  await page.waitForFunction((selector) => {
    const pane = document.querySelector(selector);
    return Boolean(pane && !pane.querySelector('[data-testid="not-ready"]') && pane.querySelector('.empty-chat'));
  }, PANE, { timeout: 30000 });
}

/**
 * @brief 开着权限菜单时结束后台进程，等提示出现后点"Restart"，点完把焦点放到权限按钮上（它不可用但还在），
 *        等会话重新打开；返回这期间这一行的每个样子（m2-helpers.mjs watchRow）和最后焦点是否还在权限按钮上。
 */
async function restartWatched(app, page) {
  await openPermissionMenu(page);
  await watchRow(page, PANE);
  killKernel(app);
  await paneOf(page).getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  await paneOf(page).getByRole('button', { name: 'Restart', exact: true }).click();
  await permissionButton(page).focus();
  await paneOf(page).getByTestId('notice').filter({ hasText: 'Restarted · ' }).last().waitFor({ timeout: 30000 });
  await page.waitForFunction((selector) => !document.querySelector(`${selector} [data-testid="not-ready"]`), PANE,
    { timeout: 30000 });
  const log = await rowLog(page);
  const focused = await permissionButton(page).evaluate((el) => el === document.activeElement);
  return { log, focused };
}

/**
 * @brief 这一行在不能发送时（reason 是按钮位置的说明）与规定不符的地方：权限、范围、Effort 三个按钮都在、不可用
 *        （aria-disabled，仍能 Tab 到），原因在权限、Effort 悬停的第二行和范围按钮的第三行、读屏的描述里；圆环保留；
 *        这一行仍高 33px（chat.md"后台进程退出"、models.md"不可用时、按钮消失时的焦点"）。
 */
function rowOffProblems(entry, reason) {
  if (!entry) return [`no state with "${reason}" was seen`];
  const mode = entry.permission?.text === 'Allow all' ? 'all' : 'ask';
  return [...permissionTipProblems(entry.permission, mode, reason), ...rangeTipProblems(entry.model, reason),
    ...effortTipProblems(entry.effort, reason), ...(entry.usage ? [] : ['the usage ring is gone']),
    ...(rowHeightOk(entry.rowHeight) ? [] : [`row height ${entry.rowHeight}px`])];
}

/**
 * @brief 后台进程退出、重新载入中、Restart 之后重新打开中这一行的样子（chat.md"后台进程退出"、models.md"不可用时、
 *        按钮消失时的焦点"、approval.md"权限菜单"）。每一段取最后一个样子（菜单在下一次提交才关）。
 */
function checkRestartRow({ log, focused }) {
  const crashAt = log.findIndex((entry) => entry.wait === CRASHED);
  const after = crashAt < 0 ? [] : log.slice(crashAt);
  const phase = (wait) => after.filter((entry) => entry.wait === wait);
  const crashed = phase(CRASHED).at(-1);
  const crash = [...rowOffProblems(crashed, CRASHED), ...(log[0]?.menu && !crashed?.menu ? [] : ['menu not closed'])];
  record(`后台进程退出：开着的权限菜单关闭；权限、范围、Effort 按钮不可用（aria-disabled，仍能 Tab 到），原因"${CRASHED}"在`
    + '权限和 Effort 悬停的第二行、范围按钮的第三行和读屏的描述里；圆环保留；这一行仍高 33px', crash.length === 0,
  oneLine(crash.join('; '), 600));
  const restarting = rowOffProblems(phase(RESTARTING).at(-1), RESTARTING);
  record(`重新载入中：权限、范围、Effort 按钮仍在、不可用，原因"${RESTARTING}"；圆环保留`, restarting.length === 0,
    oneLine(restarting.join('; '), 600));
  const opening = phase(STARTING);
  const from = opening.findIndex((entry) => entry.focus === 'permission-button');
  const reopen = [...rowOffProblems(opening.at(-1), STARTING),
    ...(from >= 0 && opening.slice(from).every((entry) => entry.focus === 'permission-button') && focused ? []
      : [`focus ${JSON.stringify(opening.map((entry) => entry.focus))}, at the end ${focused}`])];
  record(`Restart 之后重新打开中：范围按钮、Effort 和圆环仍在（不像第一次打开那样藏起），三个按钮不可用，原因"${STARTING}"；`
    + '焦点留在权限按钮上', reopen.length === 0, oneLine(reopen.join('; '), 600));
  const last = log.at(-1);
  const ready = [...permissionTipProblems(last?.permission, 'ask', null), ...rangeTipProblems(last?.model, null),
    ...effortTipProblems(last?.effort, null)];
  record('重新打开后三个按钮又可用（没有 aria-disabled），权限按钮悬停第二行和读屏的描述是"Change the permission mode"',
    ready.length === 0, oneLine(ready.join('; '), 600));
}

// ---------- 权限菜单 ----------

/** @brief 打开输入框下面一行的权限菜单（已打开时不动），返回菜单。 */
async function openPermissionMenu(page) {
  const menu = page.getByTestId('permission-menu');
  if (await menu.count() === 0) await permissionButton(page).click();
  await menu.waitFor({ timeout: 5000 });
  return menu;
}

/** @brief 菜单还开着就按 Esc 关掉。 */
async function closeMenu(page) {
  const menu = page.getByTestId('permission-menu');
  if (await menu.count() > 0) await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: 5000 });
}

/** @brief 等输入框下面一行的权限按钮显示 text。 */
function waitPermission(page, text) {
  return page.waitForFunction(({ selector, want }) => document.querySelector(selector)?.textContent?.includes(want),
    { selector: `${PANE} ${ROW} [data-testid="permission-button"]`, want: text }, { timeout: 10000 });
}

/** @brief 切到全部允许：选菜单项，在确认框里点"Allow all"。 */
async function switchToAll(page) {
  const menu = await openPermissionMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Allow all' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Allow all', exact: true }).click();
  await waitPermission(page, 'Allow all');
}

/** @brief 切回每次询问；返回切换时是否弹了确认框（不应该弹）。 */
async function switchToAsk(page) {
  const menu = await openPermissionMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Ask each time' }).click();
  const confirmed = await page.getByTestId('confirm-dialog').waitFor({ timeout: 1000 }).then(() => true, () => false);
  // 不该弹确认框；万一弹了，点它的第一个按钮继续，检查里会记为失败
  if (confirmed) {
    await page.getByTestId('confirm-dialog').getByRole('button').first().click({ timeout: 2000 }).catch(() => {});
  }
  await waitPermission(page, 'Ask each time');
  await closeMenu(page);
  return confirmed;
}

/** @brief "Allowed for this session:"列表里某一项的"Forget"按钮。 */
async function clearButton(page, label) {
  const allowed = page.getByTestId('permission-allowed');
  const rows = allowed.locator('*').filter({ hasText: label })
    .filter({ has: page.getByRole('button', { name: 'Forget' }) });
  return (await rows.count()) > 0 ? rows.last().getByRole('button', { name: 'Forget' }).first()
    : allowed.getByRole('button', { name: 'Forget' }).first();
}

// ---------- 主进程里运行的函数（经 app.evaluate 序列化，只能用参数里的 electron 模块） ----------

/** @brief 记录主窗口 flashFrame 的调用，再开一个小窗口把焦点抢走。 */
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
  globalThis.__m2Flash = state;
}

/** @brief 主窗口现在有没有焦点。 */
function mainFocused({ BrowserWindow }) {
  return BrowserWindow.fromId(globalThis.__m2Flash.mainId)?.isFocused() ?? false;
}

/** @brief 记下的主窗口 flashFrame 调用（true / false 序列）。 */
function flashCalls() {
  const { calls, mainId } = globalThis.__m2Flash;
  return calls.filter((call) => call.id === mainId).map((call) => call.flag);
}

/** @brief 关掉小窗口，把焦点交回主窗口。 */
function focusMain({ BrowserWindow }) {
  const state = globalThis.__m2Flash;
  BrowserWindow.fromId(state.helperId)?.destroy();
  const main = BrowserWindow.fromId(state.mainId);
  main?.show();
  main?.focus();
}

/** @brief 系统不肯把焦点交给 Mori 时（测试进程不在前台），直接发出主窗口的 focus 事件。 */
function emitMainFocus({ BrowserWindow }) {
  BrowserWindow.fromId(globalThis.__m2Flash.mainId)?.emit('focus');
}

/** @brief 让主窗口回到桌面上（最小化的先还原，藏起的先显示），后面的步骤照常操作页面。 */
function showMain({ BrowserWindow }) {
  const main = BrowserWindow.fromId(globalThis.__m2Flash?.mainId ?? -1) ?? BrowserWindow.getAllWindows()[0];
  if (main?.isMinimized()) main.restore();
  if (main && !main.isVisible()) main.show();
  main?.focus();
}

/** @brief 恢复 flashFrame，关掉小窗口，停止闪烁。 */
function restoreFlash({ BrowserWindow }) {
  const state = globalThis.__m2Flash;
  if (!state) return;
  BrowserWindow.fromId(state.helperId)?.destroy();
  if (state.descriptor) Object.defineProperty(BrowserWindow.prototype, 'flashFrame', state.descriptor);
  else delete BrowserWindow.prototype.flashFrame;
  BrowserWindow.fromId(state.mainId)?.flashFrame(false);
  delete globalThis.__m2Flash;
}

/** @brief 把 shell.showItemInFolder 换成只记路径的版本；换不了时返回 false。 */
function stubShowItem({ shell }) {
  globalThis.__m2Shown = [];
  const stub = (path) => { globalThis.__m2Shown.push(path); };
  try {
    shell.showItemInFolder = stub;
  } catch {
    // 只读属性时下面改用 defineProperty
  }
  if (shell.showItemInFolder !== stub) {
    try {
      Object.defineProperty(shell, 'showItemInFolder', { value: stub, configurable: true, writable: true });
    } catch {
      return false;
    }
  }
  return shell.showItemInFolder === stub;
}

/** @brief 把主窗口改成 width×height（content 为真时是内容区大小），返回改之前的位置和大小。 */
function resizeMain({ BrowserWindow }, { width, height, content }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  const bounds = main.getBounds();
  if (main.isMaximized()) main.unmaximize();
  if (content) main.setContentSize(width, height);
  else main.setSize(width, height);
  return bounds;
}

/** @brief 恢复主窗口的位置和大小。 */
function restoreMain({ BrowserWindow }, bounds) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  main.setBounds(bounds);
}

/**
 * @brief 把主进程保存报告的处理（ipcMain.handle('mori:save-issue')）包一层，先等 ms 毫秒再保存；
 *        Electron 没有公开取回处理函数的接口，这里用 ipcMain 内部的 _invokeHandlers。换不了时返回 false。
 */
function delayIssueSave({ ipcMain }, ms) {
  const handlers = ipcMain._invokeHandlers;
  const original = handlers?.get('mori:save-issue');
  if (!original) return false;
  globalThis.__m2SaveIssue = original;
  handlers.set('mori:save-issue', async (event, ...args) => {
    await new Promise((done) => setTimeout(done, ms));
    return original(event, ...args);
  });
  return true;
}

/** @brief 恢复原来的保存报告处理。 */
function restoreIssueSave({ ipcMain }) {
  if (globalThis.__m2SaveIssue) ipcMain._invokeHandlers.set('mori:save-issue', globalThis.__m2SaveIssue);
  delete globalThis.__m2SaveIssue;
}

/** @brief 每 100 毫秒在主进程里求一次 fn，直到为真或超时。 */
async function pollMain(app, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await app.evaluate(fn)) return true;
    await sleep(100);
  }
  return false;
}

// ---------- 检查步骤 ----------

/**
 * @brief 首次启动：填表（v1，区域 Local）、测试成功（进入主窗口）、等探针跑完（经进程桥读档案）、打开文件夹
 *        （M1 已测过，这里只走流程）。
 */
async function setup({ app, page, h, project }) {
  const run = await h.firstRun({ baseUrl, apiKey: testKey });
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  await openNewSession(app, page, project);
  // model-discovery.md §13.4：首次启动先 Fetch models（拿到列表），在清单里勾 fake-coder（不是手填的）
  record('准备：首次启动（Fetch models 拿到列表、勾 fake-coder）、测试连接、等探针跑完、打开文件夹',
    run.ok && run.probe === 'verified' && run.fetch?.state === 'list' && run.typed.length === 0,
    `${oneLine(run.text)}；probe=${run.probe}；fetch=${JSON.stringify(run.fetch)}；typed=${run.typed}`);
}

/** @brief 读取文件不出批准卡，工具卡没有标签。 */
async function readNoCard({ page, h }) {
  await watchCards(page);
  await h.send('总结 README');
  await idleAllowingCards(page, h);
  const last = (await toolCards(page)).at(-1);
  record('读取：不出批准卡，直接执行并完成，没有标签', !(await cardSeen(page)) && last?.status === 'done' && !last.badge,
    JSON.stringify(last));
}

/** @brief 改文件：卡上有原文和新文，工具卡"Waiting for your approval"，不抢焦点；在输入框打字、按 Enter 不会批准。 */
async function editCard(ctx) {
  const { page, h } = ctx;
  await watchStages(page);
  await h.send(EDIT_README);
  ctx.request = await waitCard(page);
  await sleep(300);
  const card = await cardInfo(page);
  const edit = card?.edits[0];
  record('修改：批准卡标题"修改 README.md"，显示每处替换的原文和新文', card?.tool === 'edit'
    && /Edit\s*README\.md/.test(card.text) && card.edits.length === 1 && edit.old.includes('# Mori fixture project')
    && edit.new.includes('# Mori fixture project (edited)'), oneLine(JSON.stringify(card), 300));
  record('修改：卡上单独一行"路径"显示目标 README.md；项目里的路径没有"在项目文件夹之外"和不可见字符的提示',
    Boolean(card?.path.includes('README.md')) && card.text.includes('Path') && !card.outside && !card.hidden,
    `路径：${card?.path ?? '无卡'}；${card?.outside ?? ''}${card?.hidden ?? ''}`);
  const tool = (await toolCards(page)).at(-1);
  record('修改：对话流里的工具卡显示"等你批准"', tool?.status === 'awaiting' && tool.text.includes('Waiting for your approval'),
    JSON.stringify(tool));
  record('修改：批准卡出现时不抢焦点，焦点留在输入框', await waitComposerFocus(page, 500));
  await page.screenshot({ path: join(shots, '01-edit-card.png') });
  await page.keyboard.type('plain 打字不会批准');
  await page.keyboard.press('Enter');
  const queue = paneOf(page).getByTestId('queue');
  await queue.filter({ hasText: 'plain 打字不会批准' }).waitFor({ timeout: 10000 });
  const still = await cardInfo(page);
  const after = (await toolCards(page)).at(-1);
  record('修改：继续在输入框打字并按 Enter 不会批准（这条消息进排队区，卡还在）',
    still?.request === ctx.request && after?.status === 'awaiting', `卡 ${still?.request ?? '无'}，工具卡 ${after?.status}`);
  // 撤回这条排队消息，后面的检查不受它影响
  await queue.getByRole('button', { name: 'Withdraw' }).click();
  await queue.waitFor({ state: 'detached', timeout: 10000 });
  await h.textarea.fill('');
}

/** @brief Alt+1 允许：工具卡执行并完成，展开能看到 diff；等批准时阶段行一直是"Waiting for your approval"。 */
async function editApprove({ page, h, project }) {
  await h.textarea.press('Alt+1');
  await waitCardGone(page);
  await waitIdle(page);
  const card = paneOf(page).getByTestId('tool-card').last();
  const status = await card.getAttribute('data-status');
  await card.locator('summary').click();
  const diff = await card.getByTestId('tool-diff').waitFor({ timeout: 10000 }).then(() => true, () => false);
  const readme = readFileSync(join(project, 'README.md'), 'utf8');
  record('修改：Alt+1 允许后工具卡执行并完成，展开能看到实际 diff，文件已改',
    status === 'done' && diff && readme.includes('# Mori fixture project (edited)'), `状态 ${status}，diff ${diff}`);
  await page.screenshot({ path: join(shots, '02-edit-done.png') });
  await card.locator('summary').click();
  const log = await stageLog(page);
  const withCard = log.filter((entry) => entry.card);
  record('修改：卡挂着时阶段行一直是"等你批准"，不显示"生成中""执行中"或"运行"',
    withCard.length > 0 && withCard.every((entry) => entry.stage === 'Waiting for your approval'),
    log.map((entry) => `${entry.stage || '（无）'}${entry.card ? '[卡]' : ''}`).join(' → '));
}

/** @brief 在理由框里写理由按 Enter：工具卡"Denied · 理由"，模型的下一条回复在它之后；焦点回到输入框。 */
async function rejectReason({ page, h, project }) {
  const before = readFileSync(join(project, 'README.md'), 'utf8');
  await h.send(EDIT_README);
  await waitCard(page);
  const reason = paneOf(page).getByTestId('approval-reason');
  const label = await reason.getAttribute('aria-label');
  const placeholder = await reason.getAttribute('placeholder');
  await reason.fill('标题不用改');
  await reason.press('Enter');
  await waitCardGone(page);
  const focusBack = await waitComposerFocus(page);
  await waitIdle(page);
  const last = (await toolCards(page)).at(-1);
  const order = await replyAfterLastCard(page);
  const unchanged = readFileSync(join(project, 'README.md'), 'utf8') === before;
  record('拒绝：在理由框里按 Enter，工具卡显示"已拒绝 · 标题不用改"，文件没有改', last?.status === 'rejected'
    && last.text.includes('Denied · 标题不用改') && unchanged && label === 'Reason for denying'
    && placeholder === 'Tell the model why (optional)', `${JSON.stringify(last)}，理由框 ${label} / ${placeholder}`);
  record('拒绝：模型收到理由，它的下一条回复出现在这张工具卡之后',
    order.after && order.text.includes('收到拒绝：Rejected by the user. Reason: 标题不用改'), oneLine(order.text));
  record('拒绝：焦点在卡上时，卡片处理完后焦点回到输入框', focusBack);
  await page.screenshot({ path: join(shots, '03-rejected.png') });
}

/** @brief 最后一张工具卡的状态行与悬停提示；标题里的"Edit"是否完整可见、状态行是否超出卡片。 */
function lastToolLayout(page) {
  return paneOf(page).getByTestId('tool-card').last().evaluate((card) => {
    const status = card.querySelector('[data-testid="tool-status"]');
    const box = (selector) => card.querySelector(selector)?.getBoundingClientRect() ?? { right: 0, width: 0 };
    const title = box('.tool-title');
    const verb = box('.tool-verb');
    return { status: card.dataset.status, text: status?.textContent ?? '', tip: status?.getAttribute('title') ?? '',
      titleWidth: Math.round(title.width), verbShown: verb.width > 0 && title.right >= verb.right - 0.5,
      statusInside: box('[data-testid="tool-status"]').right <= card.getBoundingClientRect().right + 1 };
  });
}

/** @brief 60 个字的理由：状态行截到 40 个字加"…"，完整理由在悬停提示和展开后的输出里；标题不被挤掉。 */
async function longReason({ page, h }) {
  await h.send(EDIT_README);
  await waitCard(page);
  const reason = paneOf(page).getByTestId('approval-reason');
  await reason.fill(LONG_REASON);
  await reason.press('Enter');
  await waitCardGone(page);
  await waitIdle(page);
  const view = await lastToolLayout(page);
  const prefix = 'Denied · ';
  const shown = view.text.startsWith(prefix) ? view.text.slice(prefix.length) : '';
  const cut = shown.slice(0, -1);
  record('长理由：60 个字的理由在状态行截到 40 个字加"…"，悬停提示里是完整理由', view.status === 'rejected'
    && shown.endsWith('…') && [39, 40].includes(cut.length) && LONG_REASON.startsWith(cut)
    && view.tip.includes(LONG_REASON), JSON.stringify(view));
  record('长理由：工具卡标题没有被挤掉（"修改"完整可见），状态行不超出卡片',
    view.titleWidth > 0 && view.verbShown && view.statusInside, JSON.stringify(view));
  await page.screenshot({ path: join(shots, '03-long-reason.png') });
  const card = paneOf(page).getByTestId('tool-card').last();
  await card.locator('summary').click();
  const body = await card.locator('.tool-body').innerText({ timeout: 5000 }).catch(() => '');
  await card.locator('summary').click();
  record('长理由：展开工具卡能看到完整理由', body.includes(LONG_REASON), oneLine(body, 300));
}

/**
 * @brief 命令卡 Alt+2"Allow “Run commands” for this session"：之后的命令不出卡，
 *        标"Allowed for this session"。
 */
async function allowSession({ page, h }) {
  await h.send('run: echo m2-first');
  await waitCard(page);
  const card = await cardInfo(page);
  record('命令：批准卡标题"运行命令"，显示完整命令行；"本会话不再询问\'运行命令\'"和说明小字',
    card?.tool === 'bash' && card.text.includes('Run a command') && card.command.includes('echo m2-first')
    && card.allowSession.includes('Allow “Run commands” for this session')
    && card.text.includes('You won’t be asked again for any command in this session.') && !card.hidden,
  oneLine(JSON.stringify(card), 300));
  await h.textarea.press('Alt+2');
  await waitCardGone(page);
  await waitIdle(page);
  const first = (await toolCards(page)).at(-1);
  await watchCards(page);
  await h.send('run: echo m2-second');
  await idleAllowingCards(page, h);
  const second = (await toolCards(page)).at(-1);
  record('命令：Alt+2 后这条命令执行（亲手允许的卡不标），之后的命令不出卡，标"本会话已允许"',
    first?.status === 'done' && !first.badge && !(await cardSeen(page)) && second?.status === 'done'
    && second.badge === 'Allowed for this session', `${JSON.stringify(first)} ${JSON.stringify(second)}`);
}

/**
 * @brief 权限菜单开着时：权限按钮在输入框下面一行的左端（第一项）、只有文字、悬停两行，顶栏上没有移走的几项；
 *        菜单往上打开、左边对齐这一行、整个在这一栏和窗口里、不盖顶栏，最高按这一行到顶栏的距离算
 *        （models.md"菜单的位置与键盘"、approval.md"权限菜单"）。
 */
async function permissionPlacement(page) {
  const button = await permissionState(page, PANE);
  const look = modeProblems(button, 'ask');
  record('权限按钮在输入框下面一行的左端（这一行的第一项），顶栏上没有权限、范围、Effort 和上下文用量；按钮只有文字'
    + '"Ask each time"和 ▾（没有盾牌），悬停两行，读屏的描述只有第二行', Boolean(button?.first)
    && button.inTopbar.length === 0 && look.length === 0,
  [`first ${button?.first ?? null}`, `in top bar ${JSON.stringify(button?.inTopbar ?? null)}`, ...look].join('; '));
  const problems = permissionMenuProblems(await rowMenuState(page, PANE, PERMISSION_MENU));
  record('权限菜单：从输入框下面一行往上打开（下边在这一行上方 6px），左边对齐这一行的左端，整个在这一栏和窗口里、'
    + '不盖顶栏，最高 min(440px, 这一行上边到顶栏下边 − 12px)', problems.length === 0, problems.join('; '));
}

/** @brief 权限菜单：两个选项、"Allowed for this session:"里的"Run commands"和说明；Forget 后命令又出卡；Esc 关闭菜单。 */
async function permissionMenu({ page, h }) {
  const haspopup = await permissionButton(page).getAttribute('aria-haspopup');
  const menu = await openPermissionMenu(page);
  const text = await menu.innerText();
  const items = await menu.getByRole('menuitemradio').evaluateAll((list) => list.map((item) =>
    `${item.textContent?.trim()}:${item.getAttribute('aria-checked')}`));
  const allowed = await page.getByTestId('permission-allowed').innerText();
  record('权限菜单：两个选项（"每次询问"打勾）、"本会话已允许：运行命令"和"作用于这个会话的全部 Agent"的说明', haspopup === 'menu'
    && await menu.getAttribute('role') === 'menu' && items.length === 2
    && items.some((item) => item.includes('Ask each time') && item.endsWith(':true'))
    && text.includes('Allowed for this session:') && allowed.includes('Run commands')
    // 平行 Agent 规格 §11.1：说明改为作用于这个用户会话的全部 Agent。
    && text.includes('Applies to all agents in this session. New sessions start at Ask each time.'),
  `${items.join(' | ')} / ${oneLine(text)}`);
  await page.screenshot({ path: join(shots, '04-permission-menu.png') });
  await permissionPlacement(page);
  await (await clearButton(page, 'Run commands')).click();
  const cleared = await page.waitForFunction(() => !document.querySelector('[data-testid="permission-allowed"]')
    ?.textContent?.includes('Run commands'), null, { timeout: 5000 }).then(() => true, () => false);
  await page.keyboard.press('Escape');
  const closed = await page.getByTestId('permission-menu').waitFor({ state: 'hidden', timeout: 5000 })
    .then(() => true, () => false);
  record('权限菜单：点"清除"后列表里没有"运行命令"；Esc 关闭菜单', cleared && closed);
  await h.send('run: echo m2-third');
  const asked = await waitCard(page).then(() => true, () => false);
  record('权限菜单：清除"运行命令"后命令又出批准卡', asked);
  // 再选一次"Allow “Run commands” for this session"，下一步确认新会话不继承它
  if (asked) {
    await h.textarea.press('Alt+2');
    await waitCardGone(page);
  }
  await waitIdle(page);
}

/** 这一行的几个浮层，按点开的顺序：打开它的按钮、浮层（models.md"同时只开一个"） */
const ROW_OVERLAYS = [
  { name: '权限菜单', button: permissionButton, overlay: (page) => page.getByTestId('permission-menu') },
  { name: '范围菜单', button: modelButton, overlay: (page) => page.getByTestId('model-menu') },
  { name: 'Effort 菜单', button: effortButton, overlay: (page) => page.getByTestId('thinking-menu') },
  { name: '圆环详情', button: usageButton, overlay: (page) => paneOf(page).getByTestId('usage-details') },
];

/**
 * @brief 这一行同时只开一个浮层（models.md"同时只开一个"）：空闲时依次点权限、范围、Effort 按钮和圆环，每点一个，
 *        它的浮层打开、前一个关闭；最后 Esc 关上圆环详情，焦点留在圆环上。
 */
async function oneOverlay({ page }) {
  const steps = [];
  for (const [index, item] of ROW_OVERLAYS.entries()) {
    await item.button(page).click();
    const opened = await item.overlay(page).waitFor({ timeout: 3000 }).then(() => true, () => false);
    const previous = ROW_OVERLAYS[index - 1];
    const gone = !previous || await previous.overlay(page).count() === 0;
    steps.push({ name: item.name, opened, previousClosed: gone });
  }
  await page.keyboard.press('Escape');
  const closed = await paneOf(page).getByTestId('usage-details').waitFor({ state: 'detached', timeout: 3000 })
    .then(() => true, () => false);
  const focus = await usageButton(page).evaluate((el) => el === document.activeElement);
  record('这一行同时只开一个：依次点权限、范围、Effort 按钮和圆环，每点一个它的浮层打开、前一个关闭；Esc 关上圆环详情，'
    + '焦点留在圆环上', steps.every((step) => step.opened && step.previousClosed) && closed && focus,
  JSON.stringify({ steps, closed, focus }));
}

/**
 * @brief 第一次打开中这一行的样子（chat.md"后台正在启动"、models.md"选择范围按钮"第一次打开中）：只有权限按钮，
 *        不可用（aria-disabled，仍能 Tab 到；悬停第二行和读屏的描述"Starting…"），没有范围按钮、Effort 和圆环；高 33px。
 */
function checkFirstOpen(log) {
  const opening = log.filter((entry) => entry.wait === STARTING);
  const problems = opening.flatMap((entry) => [...permissionTipProblems(entry.permission, 'ask', STARTING),
    ...(entry.model || entry.effort || entry.usage ? [`shown: range ${Boolean(entry.model)}, Effort `
      + `${Boolean(entry.effort)}, ring ${entry.usage}`] : []),
    ...(rowHeightOk(entry.rowHeight) ? [] : [`row height ${entry.rowHeight}px`])]);
  record(`第一次打开中：输入框下面一行只有权限按钮（不可用，aria-disabled，仍能 Tab 到；悬停第二行和读屏的描述"${STARTING}"），`
    + '没有范围按钮、Effort 和圆环；这一行高 33px', opening.length > 0 && problems.length === 0,
  `${opening.length} 个样子；${oneLine([...new Set(problems)].join('; '), 500)}`);
}

/**
 * @brief 新会话不继承上一个会话的"Allowed for this session"：命令又出卡；Alt+3 拒绝，工具卡"Denied"。
 *        打开新会话期间记下这一行的样子（checkFirstOpen）。
 */
async function newSessionAsks({ app, page, h, project }) {
  await watchRow(page, PANE);
  await openNewSession(app, page, project);
  checkFirstOpen(await rowLog(page));
  const button = await permissionButton(page).innerText();
  await h.send('run: echo m2-new-session');
  const asked = await waitCard(page).then(() => true, () => false);
  record('新会话：权限是"每次询问"，命令重新出卡（不继承上一个会话的"本会话已允许"）',
    asked && button.includes('Ask each time'), oneLine(button));
  await h.textarea.press('Alt+3');
  await waitCardGone(page);
  await waitIdle(page);
  const last = (await toolCards(page)).at(-1);
  record('拒绝：Alt+3 拒绝（理由框为空），工具卡显示"已拒绝"', last?.status === 'rejected' && last.text.trim() === 'Denied',
    JSON.stringify(last));
}

/** @brief 切到全部允许先弹确认（焦点在"Cancel"，Esc 等于取消）；之后改文件不出卡，标"Allow all"；切回后又出卡。 */
async function allowAll({ page, h }) {
  const menu = await openPermissionMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Allow all' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  const focus = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  record('全部允许：先弹确认"切换到全部允许？编辑、写入和命令都不再询问。"，焦点在"取消"',
    await dialog.getAttribute('role') === 'alertdialog' && text.includes('Switch to “Allow all”?')
    && text.includes('Edits, writes, and commands will run without asking.') && focus === 'Cancel',
  `焦点：${focus} / ${oneLine(text)}`);
  await page.screenshot({ path: join(shots, '05-confirm-all.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  const still = await permissionButton(page).innerText();
  record('全部允许：确认框里按 Esc 等于取消，权限仍是"每次询问"', still.includes('Ask each time'), oneLine(still));
  await closeMenu(page);
  await switchToAll(page);
  await closeMenu(page);
  await watchCards(page);
  await h.send(EDIT_README);
  await idleAllowingCards(page, h);
  const last = (await toolCards(page)).at(-1);
  record('全部允许：改文件不出卡，工具卡标"全部允许"', !(await cardSeen(page)) && last?.status === 'done'
    && last.badge === 'Allow all', JSON.stringify(last));
  const confirmed = await switchToAsk(page);
  record('全部允许：切回"每次询问"不需要确认', !confirmed);
  await h.send(EDIT_README);
  const asked = await waitCard(page).then(() => true, () => false);
  record('全部允许：切回"每次询问"后改文件又出卡', asked);
}

/** @brief 卡挂着时切到全部允许：卡按允许处理，工具卡标"Allow all"；然后开新会话，确认新会话不继承"Allow all"。 */
async function pendingToAll(ctx) {
  const { page, h } = ctx;
  if (!(await cardInfo(page))) {
    await h.send(EDIT_README);
    await waitCard(page);
  }
  await switchToAll(page);
  const gone = await waitCardGone(page).then(() => true, () => false);
  await closeMenu(page);
  await waitIdle(page);
  const last = (await toolCards(page)).at(-1);
  record('全部允许：切换时挂着的卡按允许处理，卡片消失，工具卡标"全部允许"', gone && last?.status === 'done'
    && last.badge === 'Allow all', JSON.stringify(last));
  await newSessionNotAll(ctx);
}

/**
 * @brief 当前会话是"Allow all"时开新会话：新会话从"Ask each time"开始，命令出卡（不继承"Allow all"）。
 *        之后的步骤都在这个新会话里做，原来的会话留在"Allow all"。
 */
async function newSessionNotAll({ app, page, h, project }) {
  const before = await permissionButton(page).innerText();
  await openNewSession(app, page, project);
  const button = await permissionButton(page).innerText();
  await h.send('run: echo m2-not-inherited');
  const asked = await waitCard(page).then(() => true, () => false);
  record('新会话：别的会话是"全部允许"时，新会话的权限是"每次询问"，命令出卡（不继承"全部允许"）',
    before.includes('Allow all') && button.includes('Ask each time') && asked,
    `原来的会话：${oneLine(before)}；新会话：${oneLine(button)}`);
  // 允许这张卡（没出卡时直接等本轮结束）
  await idleAllowingCards(page, h);
}

/**
 * @brief 卡挂着时在输入框按 Esc：按拒绝处理并停止，命令没有执行；重新载入后从会话记录认出"Denied · You pressed Stop"。
 *        重新载入时开着权限菜单，查这期间输入框下面一行的样子（checkRestartRow）。
 */
async function escStop({ app, page, h, project }) {
  await h.send('run: echo blocked > m2-stop.txt');
  await waitCard(page);
  await h.textarea.press('Escape');
  await waitCardGone(page);
  await waitIdle(page, 30000);
  const last = (await toolCards(page)).at(-1);
  const notice = await paneOf(page).getByTestId('notice').filter({ hasText: STOPPED_TEXT }).count();
  const errors = await paneOf(page).getByTestId('error-card').count();
  record('停止：卡挂着时在输入框按 Esc，工具卡"已拒绝 · 你按了停止"，提示"已停止"，没有错误卡，命令没有执行',
    last?.status === 'rejected' && last.text.includes('Denied · You pressed Stop') && notice >= 1 && errors === 0
    && !existsSync(join(project, 'm2-stop.txt')), `${JSON.stringify(last)}，已停止 ${notice} 条，错误卡 ${errors} 张`);
  await page.screenshot({ path: join(shots, '06-stop-rejected.png') });
  checkRestartRow(await restartWatched(app, page));
  const card = (await toolCards(page)).find((item) => item.title.includes('m2-stop.txt'));
  record('重新载入：从会话记录认出这张卡"已拒绝 · 你按了停止"（没有标签）', card?.status === 'rejected'
    && card.text.includes('Denied · You pressed Stop') && !card.badge, JSON.stringify(card));
}

/** @brief 焦点在卡片的理由框里按 Esc：按拒绝处理（带理由），生成继续、模型回复，焦点回到输入框。 */
async function escInCard({ page, h }) {
  const stoppedBefore = await stoppedCount(page);
  await h.send('run: echo m2-esc-card');
  await waitCard(page);
  await paneOf(page).getByTestId('approval-reason').fill('换个命令');
  await page.keyboard.press('Escape');
  await waitCardGone(page);
  const focusBack = await waitComposerFocus(page);
  await waitIdle(page);
  const last = (await toolCards(page)).at(-1);
  const order = await replyAfterLastCard(page);
  const stoppedAfter = await stoppedCount(page);
  record('Esc（焦点在卡片上）：按拒绝处理，工具卡"已拒绝 · 换个命令"，生成继续、模型回复，没有"已停止"',
    last?.status === 'rejected' && last.text.includes('Denied · 换个命令') && order.after
    && order.text.includes('收到拒绝：Rejected by the user. Reason: 换个命令') && stoppedAfter === stoppedBefore,
    `${JSON.stringify(last)} ${oneLine(order.text)}，已停止 ${stoppedBefore} → ${stoppedAfter}`);
  record('Esc（焦点在卡片上）：卡片消失后焦点回到输入框', focusBack);
}

/**
 * @brief "Queue"的下拉开着时焦点移到理由框：下拉关闭（models.md"Tab 移出时关闭"）。焦点离开下拉时没有落到别的元素上
 *        （像切到别的程序）下拉不关；之后焦点在理由框里、下拉开着时按 Esc：先关下拉，卡还在；再按 Esc 才拒绝这张卡。
 */
async function escMenuFirst({ page, h }) {
  await h.send('run: echo m2-esc-menu');
  const request = await waitCard(page);
  await h.textarea.fill('排队用的草稿');
  const dropdown = paneOf(page).locator(QUEUE_MENU);
  const reason = paneOf(page).getByTestId('approval-reason');
  await moreSendOptions(page).click();
  await dropdown.waitFor({ timeout: 5000 });
  const inMenu = await dropdown.evaluate((el) => el.contains(document.activeElement));
  await reason.focus();
  const tabOut = await dropdown.waitFor({ state: 'detached', timeout: 2000 }).then(() => true, () => false);
  record('Tab 移出："排队发送"的下拉打开时焦点在菜单里；焦点移到理由框（外面一个能停焦点的元素）时下拉关闭',
    inMenu && tabOut, JSON.stringify({ inMenu, tabOut }));
  if (await dropdown.count() === 0) await moreSendOptions(page).click();
  await dropdown.waitFor({ timeout: 5000 });
  // 焦点移到外面能停焦点的元素上就关下拉：先让焦点离开下拉、不落到别的元素上（focusout 的 relatedTarget 为 null，
  // 同切到别的程序，下拉不关），再用 fill 把焦点放进理由框（不产生点击，也没有从下拉移出的 focusout）
  await page.evaluate(() => document.activeElement?.blur());
  const blurKept = await dropdown.count() === 1;
  await reason.fill('先关下拉');
  const openBefore = blurKept && await dropdown.count() === 1;
  await page.keyboard.press('Escape');
  const closed = await dropdown.waitFor({ state: 'detached', timeout: 2000 }).then(() => true, () => false);
  await sleep(300);
  const still = await cardInfo(page);
  record('Esc（焦点在理由框里、"排队发送"下拉开着；焦点离开下拉时没有落到别的元素上，下拉不关）：先关闭下拉，卡还在',
    openBefore && closed && still?.request === request,
    `失焦后还开着 ${blurKept}，下拉开着 ${openBefore}，已关闭 ${closed}，卡 ${still?.request ?? '无'}`);
  await page.keyboard.press('Escape');
  const gone = await waitCardGone(page, 5000).then(() => true, () => false);
  await h.textarea.fill('');
  await waitIdle(page);
  const last = (await toolCards(page)).at(-1);
  record('Esc（焦点在理由框里、没有浮层）：再按 Esc 拒绝这张卡，工具卡"已拒绝 · 先关下拉"', gone
    && last?.status === 'rejected' && last.text.includes('Denied · 先关下拉'), JSON.stringify(last));
}

/** @brief 最后两张工具卡"状态:状态文字"，第一张在执行时才返回（最多等 10 秒，等不到时为 null）。 */
async function whileFirstRuns(page) {
  const handle = await page.waitForFunction((selector) => {
    const cards = [...document.querySelectorAll(`${selector} [data-testid="tool-card"]`)].slice(-2);
    if (cards[0]?.dataset.status !== 'running') return null;
    const text = (card) => card.querySelector('[data-testid="tool-status"]')?.textContent;
    return cards.map((card) => `${card.dataset.status}:${text(card)}`);
  }, PANE, { timeout: 10000 }).catch(() => null);
  return handle ? handle.jsonValue() : null;
}

/** @brief 一条回复两条命令：逐张出卡，第二张在第一条执行完后才出现；之前第二个调用显示"Queued"。 */
async function twoCommands({ page, h }) {
  await h.send('two commands: sleep 2 && echo m2-one ;; echo m2-two');
  const first = await waitCard(page);
  await sleep(1500);
  const one = await cardInfo(page);
  const before = (await toolCards(page)).slice(-2);
  record('两条命令：先只出第一张卡；第二个调用还没开始，工具卡显示"等待执行"', one?.command.includes('echo m2-one')
    && !one.more && before[0]?.title.includes('m2-one') && before[0].status === 'awaiting'
    && before[1]?.title.includes('m2-two') && before[1].status === 'queued' && before[1].text.trim() === 'Queued',
  `${oneLine(one?.command ?? '无卡')} ${JSON.stringify(before)}`);
  await h.textarea.press('Alt+1');
  const during = await whileFirstRuns(page);
  record('两条命令：第一条执行时第二个调用仍显示"等待执行"', during?.[1] === 'queued:Queued', JSON.stringify(during));
  await waitCard(page, first);
  const two = await cardInfo(page);
  const middle = (await toolCards(page)).slice(-2);
  record('两条命令：第一条执行完后才出第二张卡', two?.command.includes('echo m2-two') && middle[0]?.status === 'done'
    && middle[1]?.status === 'awaiting', JSON.stringify(middle));
  await h.textarea.press('Alt+1');
  await waitCardGone(page);
  await waitIdle(page);
  const after = (await toolCards(page)).slice(-2);
  record('两条命令：两张都允许后两条都完成', after.length === 2 && after.every((card) => card.status === 'done'),
    JSON.stringify(after));
}

/**
 * 新的批准卡来时要关闭的这一行的浮层（approval.md"选项"、models.md"新的批准卡或询问卡来了"）：打开它的按钮、浮层、
 * 要不要先在输入框里打字（"Queue ▾"只在生成中有字时出现）。批准卡只在生成中来，范围、Effort 菜单在生成开始时已经关闭、
 * 按钮不可用（models.md"什么时候自动关"），所以生成中能开着的是这三个。
 */
const CARD_OVERLAYS = [
  { name: '权限菜单', tag: 'm2-card-menu', button: permissionButton,
    overlay: (page) => page.getByTestId('permission-menu') },
  { name: '"排队发送"的下拉', tag: 'm2-card-queue', draft: '排队用的草稿', button: moreSendOptions,
    overlay: (page) => paneOf(page).locator(QUEUE_MENU) },
  { name: '上下文用量的详情', tag: 'm2-card-usage', button: usageButton,
    overlay: (page) => paneOf(page).getByTestId('usage-details') },
];

/**
 * @brief 一条回复两条命令：允许第一张卡、第一条命令执行时打开 item 的浮层，等第二张卡出现；返回浮层是否打开过、
 *        第二张卡来时是否关闭、焦点是否回到打开它的按钮、在那里按 Alt+1 是否答了这张卡。
 */
async function overlayOnNewCard(page, h, item) {
  await h.send(`two commands: sleep 2 && echo ${item.tag}-one ;; echo ${item.tag}-two`);
  const first = await waitCard(page);
  await h.textarea.press('Alt+1');
  await paneOf(page).locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 10000 });
  if (item.draft) await h.textarea.fill(item.draft);
  await item.button(page).click();
  const opened = await item.overlay(page).waitFor({ timeout: 3000 }).then(() => true, () => false);
  await waitCard(page, first);
  const closed = await item.overlay(page).waitFor({ state: 'detached', timeout: 2000 }).then(() => true, () => false);
  const focus = await item.button(page).evaluate((el) => el === document.activeElement).catch(() => false);
  await page.keyboard.press('Alt+1');
  const answered = await waitCardGone(page, 5000).then(() => true, () => false);
  // 没答上时从输入框再答一次，让这一轮结束（检查里已记下没答上）
  if (!answered) await h.textarea.press('Alt+1');
  if (item.draft) await h.textarea.fill('');
  await waitIdle(page);
  return { opened, closed, focus, answered };
}

/** @brief 开着权限菜单、"Queue"的下拉或圆环详情时来了新的批准卡：都关闭，焦点回到打开它的按钮，Alt+1 答了这张卡。 */
async function cardClosesOverlays({ page, h }) {
  for (const item of CARD_OVERLAYS) {
    const result = await overlayOnNewCard(page, h, item);
    record(`新卡来了：开着${item.name}时来了批准卡 → ${item.name}关闭，焦点回到打开它的按钮，在那里按 Alt+1 答了这张卡`,
      Object.values(result).every(Boolean), JSON.stringify(result));
  }
}

/** @brief 开着权限菜单时排队的消息开始新的一轮：权限菜单不关（models.md"什么时候自动关"：生成开始时权限菜单不关）。 */
async function queuedTurnKeepsMenu({ page, h }) {
  await h.send('run: sleep 3');
  await waitCard(page);
  await h.textarea.press('Alt+1');
  await paneOf(page).locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 10000 });
  const users = await paneOf(page).getByTestId('user-message').count();
  await h.send('plain 排队的消息开始新的一轮');
  await paneOf(page).getByTestId('queue').waitFor({ timeout: 5000 });
  const menu = await openPermissionMenu(page);
  const delivered = await page.waitForFunction(({ selector, count }) => document
    .querySelectorAll(`${selector} [data-testid="user-message"]`).length > count, { selector: PANE, count: users },
  { timeout: 30000 }).then(() => true, () => false);
  const open = await menu.count() === 1;
  const running = await paneOf(page).getAttribute('data-running');
  record('权限菜单：开着时排队的消息开始新的一轮，菜单不关（生成开始时权限菜单不关）', delivered && open,
    `排队的消息送达 ${delivered}，菜单开着 ${open}，data-running ${running}`);
  await closeMenu(page);
  await waitIdle(page);
}

/** @brief 卡还在、最后一张工具卡还是"Waiting for your approval"。 */
async function stillPending(page, request) {
  const card = await cardInfo(page);
  const tool = (await toolCards(page)).at(-1);
  return { ok: card?.request === request && tool?.status === 'awaiting',
    detail: `卡 ${card?.request ?? '无'}，${tool?.status}` };
}

/** @brief 快捷键只认数字行的 Alt+1/2/3：Alt+小键盘 1 不批准；权限菜单开着时 Alt+1 不批准；关掉菜单后照常允许。 */
async function keyGuards({ page, h }) {
  await h.send('run: echo m2-keys');
  const request = await waitCard(page);
  await h.textarea.press('Alt+Numpad1');
  await sleep(800);
  const numpad = await stillPending(page, request);
  record('快捷键：Alt+小键盘 1 不批准（只认数字行的 Alt+1）', numpad.ok, numpad.detail);
  await h.textarea.fill('');
  await openPermissionMenu(page);
  await page.keyboard.press('Alt+1');
  await sleep(800);
  const menu = await stillPending(page, request);
  record('快捷键：权限菜单开着时 Alt+1 不批准', menu.ok, menu.detail);
  const panes = await page.locator('.pane-slot').count();
  await page.keyboard.press('Control+KeyN');
  await sleep(800);
  const after = { panes: await page.locator('.pane-slot').count(),
    menu: await page.getByTestId('permission-menu').count() };
  record('快捷键：权限菜单开着时 Ctrl+N 不新建会话（菜单算挡住快捷键的浮层）', after.panes === panes && after.menu === 1,
    `会话面板 ${panes} → ${after.panes}，菜单 ${after.menu} 个`);
  await closeMenu(page);
  await h.textarea.press('Alt+1');
  const answered = await waitCardGone(page, 5000).then(() => true, () => false);
  await waitIdle(page);
  const last = (await toolCards(page)).at(-1);
  record('快捷键：关掉菜单后在输入框里按 Alt+1 照常允许', answered && last?.status === 'done'
    && last.title.includes('m2-keys'), JSON.stringify(last));
}

/** @brief 卡挂着时打开上下文用量的详情（焦点在圆环上）再按 Alt+1：照常允许（详情不算挡快捷键的浮层，approval.md"选项"）。 */
async function usageNotBlocking({ page, h }) {
  await h.send('run: echo m2-usage-keys');
  await waitCard(page);
  await usageButton(page).click();
  const details = paneOf(page).getByTestId('usage-details');
  const opened = await details.waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.keyboard.press('Alt+1');
  const answered = await waitCardGone(page, 5000).then(() => true, () => false);
  if (!answered) await h.textarea.press('Alt+1');
  await waitIdle(page);
  const last = (await toolCards(page)).at(-1);
  record('快捷键：上下文用量的详情开着时（焦点在圆环上）Alt+1 照常允许，详情不算挡快捷键的浮层', opened && answered
    && last?.status === 'done' && last.title.includes('m2-usage-keys'), `详情打开 ${opened}，${JSON.stringify(last)}`);
  // 空闲时才按 Esc 关详情（生成中没有浮层时 Esc 是停止）
  if (await details.count() > 0) {
    await usageButton(page).focus();
    await page.keyboard.press('Escape');
  }
}

/** @brief 发一条命令、Alt+1 允许，等它开始执行（之后本轮还要约 2 秒才结束）。 */
async function runningCommand(page, h, tag) {
  await h.send(`run: sleep 2 && echo ${tag}`);
  await waitCard(page);
  await h.textarea.press('Alt+1');
  await paneOf(page).locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 10000 });
}

/**
 * @brief 焦点所在的按钮消失时焦点移到这一栏的文字框（models.md"不可用时、按钮消失时的焦点"）："Queue"的下拉开着、
 *        焦点在下拉里时本轮结束（"Queue ▾"消失，下拉跟着关）；焦点在"Stop"上时本轮结束；焦点在"Send"上按 Enter 发出
 *        （"Send"换成"Stop"）。
 */
async function buttonGoneFocus({ page, h }) {
  const dropdown = paneOf(page).locator(QUEUE_MENU);
  await runningCommand(page, h, 'm2-gone-queue');
  await h.textarea.fill('排队用的草稿');
  await moreSendOptions(page).click();
  const opened = await dropdown.waitFor({ timeout: 3000 }).then(() => true, () => false);
  await waitIdle(page);
  const queue = { opened, closed: await dropdown.count() === 0, focus: await waitComposerFocus(page) };
  await h.textarea.fill('');
  await runningCommand(page, h, 'm2-gone-stop');
  await paneOf(page).locator('.stop-button').focus();
  await waitIdle(page);
  const stop = await waitComposerFocus(page);
  await h.textarea.fill('plain 焦点在 Send 上按 Enter');
  await paneOf(page).locator('.send-button').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE,
    { timeout: 20000 }).catch(() => {});
  const send = await waitComposerFocus(page);
  await waitIdle(page);
  record('按钮消失时焦点到文字框："Queue"的下拉开着时本轮结束 → 下拉关闭、焦点在文字框；"Stop"上本轮结束 → 文字框；'
    + '"Send"上按 Enter 发出 → 文字框', queue.opened && queue.closed && queue.focus && stop && send,
  JSON.stringify({ queue, stop, send }));
}

/** @brief 写入：卡片标题"Write notes.md"，显示将写入的内容，选项按"Write files"；允许后文件写入。 */
async function writeCard({ page, h, project }) {
  await h.send('write file: notes.md');
  await waitCard(page);
  const card = await cardInfo(page);
  record('写入：批准卡标题"写入 notes.md"，显示将写入的完整内容，选项和说明按"写入文件"', card?.tool === 'write'
    && /Write\s*notes\.md/.test(card.text) && card.content.includes('hello from mori')
    && card.allowSession.includes('Allow “Write files” for this session')
    && card.text.includes('You won’t be asked again for “Write files” in this session.'),
  oneLine(JSON.stringify(card), 300));
  record('写入：卡上单独一行"路径"显示 notes.md，项目里的路径没有"在项目文件夹之外"的提示',
    Boolean(card?.path.includes('notes.md')) && !card.outside, `路径：${card?.path ?? '无卡'}；${card?.outside ?? ''}`);
  await page.screenshot({ path: join(shots, '07-write-card.png') });
  await h.textarea.press('Alt+1');
  await waitCardGone(page);
  await waitIdle(page);
  const file = join(project, 'notes.md');
  const written = existsSync(file) ? readFileSync(file, 'utf8') : null;
  record('写入：允许后文件写入', written === 'hello from mori\n', JSON.stringify(written));
}

/** @brief 写入项目外的路径：卡上显示完整路径（标题换行不截断）并提示在项目文件夹之外；拒绝后没有写入。 */
async function writeOutside({ page, h, project }) {
  const outside = join(tmpdir(), `mori-m2-outside-${'x'.repeat(100)}`, 'notes.md');
  const slash = (text) => text.replace(/\\/g, '/');
  await h.send(`write file: ${outside}`);
  await waitCard(page);
  const card = await cardInfo(page);
  record(`写入项目外：卡上单独一行显示完整的绝对路径，标题换行不截断，提示"${OUTSIDE_TEXT}"`, card?.tool === 'write'
    && slash(card.path).includes(slash(outside)) && card.titleClipped === false && card.outside.includes(OUTSIDE_TEXT),
  oneLine(JSON.stringify(card), 400));
  await page.screenshot({ path: join(shots, '07-write-outside.png') });
  await rejectByButton(page);
  const up = 'docs/../../m2-up.md';
  await h.send(`write file: ${up}`);
  await waitCard(page);
  const dots = await cardInfo(page);
  record(`写入项目外：路径里有".."时也提示"${OUTSIDE_TEXT}"`, dots?.tool === 'write' && dots.path.includes('m2-up.md')
    && dots.outside.includes(OUTSIDE_TEXT), oneLine(JSON.stringify(dots), 300));
  await rejectByButton(page);
  record('写入项目外：两张卡都拒绝后没有写入任何文件',
    !existsSync(dirname(outside)) && !existsSync(join(project, '..', 'm2-up.md')));
}

/** @brief 命令里有不可见的控制字符（U+202E）：卡上标成可见的记号并提示；拒绝这张卡。 */
async function hiddenChars({ page, h }) {
  await h.send('run: echo m2-hidden ‮abc‬');
  await waitCard(page);
  const card = await cardInfo(page);
  record(`不可见字符：命令里的 U+202E 在卡上标成可见的记号，并提示"${HIDDEN_TEXT}"`, card?.tool === 'bash'
    && !/[‪-‮]/.test(card.text) && /U\+202E/i.test(card.command) && card.hidden.includes(HIDDEN_TEXT),
  oneLine(JSON.stringify(card), 300));
  await page.screenshot({ path: join(shots, '07-hidden-chars.png') });
  await rejectByButton(page);
}

/** @brief 当前会话的对话区还能往下滚多少像素。 */
const spareHeight = (page) => paneOf(page).getByTestId('transcript')
  .evaluate((el) => el.scrollHeight - el.clientHeight);

/** @brief 停在对话底部时出现批准卡：对话仍停在底部，"Waiting for your approval"的那张工具卡完整可见。 */
async function followCard({ page, h }) {
  for (let tries = 0; tries < 8 && await spareHeight(page) < 600; tries += 1) {
    await h.send('plain 让对话长到可以滚动');
    await idleAllowingCards(page, h);
  }
  const scroller = paneOf(page).getByTestId('transcript');
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sleep(300);
  await h.send('run: echo m2-follow');
  await waitCard(page);
  await sleep(800);
  const view = await scroller.evaluate((el) => {
    const card = [...el.querySelectorAll('[data-testid="tool-card"]')].at(-1);
    const box = el.getBoundingClientRect();
    const rect = card?.getBoundingClientRect();
    return { title: card?.querySelector('.tool-title')?.textContent ?? '', status: card?.dataset.status,
      inView: Boolean(rect) && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      spare: el.scrollHeight - el.clientHeight };
  });
  record('跟随：停在对话底部时出现批准卡，"等你批准"的工具卡仍完整显示在对话区里', view.title.includes('m2-follow')
    && view.status === 'awaiting' && view.spare > 200 && view.inView, JSON.stringify(view));
  await h.textarea.press('Alt+1');
  await waitCardGone(page);
  await waitIdle(page);
}

/**
 * @brief 停止按钮、卡上的"Allow once""Deny"，以及输入框下面一行的权限、范围、Effort 按钮和上下文用量圆环是否完整显示
 *        在窗口里（不超出窗口，中心点没有被别的元素盖住）；这一行是否不换行（各项都在这一行的上下边之内）、不溢出
 *        输入框，这一行的高度。
 */
function composerVisible(page) {
  return page.evaluate(({ selector, row }) => {
    const pane = document.querySelector(selector);
    const bar = pane?.querySelector(row);
    const shown = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight
        && r.right <= innerWidth && Boolean(hit && el.contains(hit));
    };
    const item = (id) => shown(bar?.querySelector(`[data-testid="${id}"]`));
    const box = bar?.getBoundingClientRect();
    const composer = pane?.querySelector('[data-testid="composer"]')?.getBoundingClientRect();
    const children = bar ? [...bar.children].filter((child) => child.getClientRects().length > 0) : [];
    const inLine = Boolean(box) && children.every((child) => child.getBoundingClientRect().top >= box.top - 1
      && child.getBoundingClientRect().bottom <= box.bottom + 1);
    const inside = Boolean(box && composer) && children.every((child) => child.getBoundingClientRect().right
      <= composer.right + 0.5 && child.getBoundingClientRect().left >= composer.left - 0.5);
    return { size: `${innerWidth}x${innerHeight}`, pane: Math.round(pane?.getBoundingClientRect().width ?? 0),
      stop: shown(pane?.querySelector('.stop-button')),
      allow: shown(pane?.querySelector('[data-testid="approval-allow"]')),
      reject: shown(pane?.querySelector('[data-testid="approval-reject"]')),
      input: pane?.querySelector('.composer textarea')?.offsetHeight ?? 0,
      permission: item('permission-button'), model: item('model-button'), effort: item('thinking-button'),
      usage: item('usage'), row: { height: Math.round((box?.height ?? 0) * 10) / 10,
        fits: inLine && inside && bar.scrollWidth <= bar.clientWidth + 1 } };
  }, { selector: PANE, row: ROW });
}

/** @brief composerVisible 的结果里输入框下面一行的四项都完整显示、没被盖住，这一行不换行、不溢出、高 33px。 */
const rowShown = (view) => view.permission && view.model && view.effort && view.usage && view.row.fits
  && rowHeightOk(view.row.height);

/** @brief 等页面量到新的窗口大小（exact 为真时是 800×600 的内容区，否则比 800×600 小），再等两帧让布局稳定。 */
async function settleSize(page, exact) {
  await page.waitForFunction((content) => (content ? Math.abs(innerWidth - 800) <= 2 && Math.abs(innerHeight - 600) <= 2
    : innerWidth < 800 && innerHeight < 600), exact, { timeout: 5000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await sleep(200);
}

/** 要检查的两种窗口大小：内容区 800×600，以及窗口能缩到的最小（外框 800×600） */
const SMALL_WINDOWS = [{ width: 800, height: 600, content: true, name: '内容区 800×600' },
  { width: 800, height: 600, content: false, name: '最小窗口（外框 800×600）' }];

/**
 * @brief 小窗口：修改卡挂着、输入框里有 12 行草稿时，停止按钮、卡上的按钮和输入框下面一行的几项都完整显示在窗口里；
 *        这一行不换行、不溢出，会话面板宽于 400px 时权限的模式名不截短（models.md"窄栏"）。
 */
async function minWindow({ app, page, h }) {
  await h.send(EDIT_README);
  await waitCard(page);
  await h.textarea.fill(TALL_DRAFT);
  // 窄窗口里右栏浮在中栏上层、会盖住按钮（M1 的设计），先收起，检查完再打开
  const right = paneOf(page).getByRole('button', { name: 'Toggle changes' });
  const rightOpen = await right.getAttribute('aria-pressed') === 'true';
  if (rightOpen) await right.click();
  let bounds = null;
  try {
    for (const size of SMALL_WINDOWS) {
      const before = await app.evaluate(resizeMain, size);
      bounds ??= before;
      await settleSize(page, size.content);
      const view = await composerVisible(page);
      record(`${size.name}：修改卡挂着、输入框里有 12 行草稿时，停止按钮和卡上的"允许一次""拒绝"都完整显示在窗口里`,
        view.stop && view.allow && view.reject, JSON.stringify(view));
      const permission = await permissionState(page, PANE);
      record(`${size.name}：同时输入框下面一行的权限、范围、Effort 按钮和上下文用量圆环也都完整显示、没被盖住，这一行不换行、`
        + '不溢出、高 33px；会话面板宽于 400px，权限的模式名不截短', rowShown(view) && view.pane > 400
        && permission?.truncated === false, JSON.stringify({ ...view, truncated: permission?.truncated ?? null }));
      await page.screenshot({ path: join(shots, `07-small-window-${size.content ? 'content' : 'outer'}.png`) });
    }
  } finally {
    if (bounds) await app.evaluate(restoreMain, bounds);
    if (rightOpen) await right.click();
  }
  await h.textarea.fill('');
  await h.textarea.press('Alt+3');
  await waitCardGone(page);
  await waitIdle(page);
}

/**
 * @brief 这一行的样子、权限按钮、草稿高度；再打开权限菜单记下它的位置（rowMenuState），rows 不为 0 时再在列表里加
 *        rows 行量一次（allowedOverflow，synthetic），之后 Esc 关上。
 */
async function smallWindowMenu(page, h, rows = 0) {
  const view = await composerVisible(page);
  const permission = await permissionState(page, PANE);
  const draft = await h.textarea.evaluate((el) => el.offsetHeight);
  await openPermissionMenu(page);
  const menu = await rowMenuState(page, PANE, PERMISSION_MENU);
  const crowded = rows ? await allowedOverflow(page, PANE, rows) : null;
  await closeMenu(page);
  return { view, permission, draft, menu, crowded };
}

/** @brief 记下 minWindowMenu 的检查：tall 是 220px 草稿时、short 是 1 行草稿时的 smallWindowMenu 结果。 */
function recordSmallMenu(tall, short) {
  const least = tall.view.pane <= 340 ? 40 : 44;
  const look = modeProblems(tall.permission, 'ask');
  record('内容区 800×600、右栏打开（会话面板最窄）、修改卡挂着、草稿 220px 高：停止按钮和输入框下面一行的权限、范围、'
    + 'Effort 按钮、圆环都完整显示，这一行不换行、不溢出、高 33px；权限按钮只有文字（≤ 460px 没有 ▾）、不窄于最窄',
  tall.view.stop && rowShown(tall.view) && (tall.permission?.width ?? 0) >= least - 0.5 && tall.draft >= 200
    && look.length === 0, oneLine(`${JSON.stringify({ ...tall.view, permissionWidth: tall.permission?.width,
    draft: tall.draft })} ${look.join('; ')}`, 600));
  const problems = permissionMenuProblems(tall.menu);
  record('内容区 800×600、右栏打开、草稿 220px 高：权限菜单往上打开、左边对齐这一行，不出窗口和这一栏、不盖顶栏',
    problems.length === 0, problems.join('; '));
  const pick = (state) => state.menu && { maxHeight: state.menu.maxHeight, rowTop: state.menu.row.top,
    draft: state.draft };
  record('内容区 800×600、右栏打开：草稿 1 行和 220px 高时权限菜单的最高相同（这一行贴在面板底部，位置不变）',
    Boolean(tall.menu && short.menu) && tall.menu.maxHeight === short.menu.maxHeight
    && tall.menu.row.top === short.menu.row.top && short.draft < tall.draft,
  JSON.stringify({ tall: pick(tall), short: pick(short) }));
  const crowded = permissionMenuProblems(tall.crowded);
  record(`内容区 800×600、右栏打开、草稿 220px 高：有 ${MANY_ALLOWED} 条"Allowed for this session"时（synthetic：测试在页面里`
    + '给列表加的行）权限菜单不超过最高、在菜单里滚动，仍往上打开、不出窗口、不盖顶栏',
  Boolean(tall.crowded?.scrolls) && tall.crowded.items >= MANY_ALLOWED && crowded.length === 0,
  `滚动 ${tall.crowded?.scrolls ?? null}，${tall.crowded?.items ?? 0} 行；${crowded.join('; ')}`);
}

/**
 * @brief 内容区 800×600、右栏打开（会话面板最窄）、修改卡挂着（生成中，权限菜单仍能打开）：草稿 220px 高和 1 行时
 *        各打开一次权限菜单（models.md"菜单的位置与键盘"、composer-pickers.md"测试要改的地方"新加的第 4 条）。
 */
async function minWindowMenu({ app, page, h }) {
  await h.send(EDIT_README);
  await waitCard(page);
  const right = paneOf(page).getByRole('button', { name: 'Toggle changes' });
  const rightOpen = await right.getAttribute('aria-pressed') === 'true';
  let bounds = null;
  try {
    bounds = await app.evaluate(resizeMain, SMALL_WINDOWS[0]);
    await settleSize(page, true);
    if (!rightOpen) await right.click();
    await sleep(300);
    await h.textarea.fill(TALL_DRAFT);
    const tall = await smallWindowMenu(page, h, MANY_ALLOWED);
    await page.screenshot({ path: join(shots, '07-small-window-menu.png') });
    await h.textarea.fill('一行草稿');
    recordSmallMenu(tall, await smallWindowMenu(page, h));
  } finally {
    if (!rightOpen) await right.click();
    if (bounds) await app.evaluate(restoreMain, bounds);
  }
  await h.textarea.fill('');
  await h.textarea.press('Alt+3');
  await waitCardGone(page);
  await waitIdle(page);
}

/** @brief 窗口不在前台时出现批准卡：任务栏闪烁；窗口拿回焦点后停止闪烁。 */
async function taskbarFlash({ app, page, h }) {
  await app.evaluate(installFlashRecorder);
  try {
    await sleep(500);
    const focusedBefore = await app.evaluate(mainFocused);
    await h.send('run: echo m2-flash');
    await waitCard(page);
    const flashed = await pollMain(app, () => globalThis.__m2Flash.calls
      .some((call) => call.id === globalThis.__m2Flash.mainId && call.flag === true), 5000);
    record('任务栏：窗口不在前台时出现批准卡，任务栏闪烁（flashFrame(true)）', flashed,
      `出卡前主窗口有焦点：${focusedBefore}；调用：${JSON.stringify(await app.evaluate(flashCalls))}`);
    await app.evaluate(focusMain);
    const stoppedFlash = () => {
      const { calls, mainId } = globalThis.__m2Flash;
      const mine = calls.filter((call) => call.id === mainId);
      const firstTrue = mine.findIndex((call) => call.flag === true);
      return firstTrue >= 0 && mine.slice(firstTrue).some((call) => call.flag === false);
    };
    let stopped = await pollMain(app, stoppedFlash, 5000);
    let how = '系统把焦点交回了 Mori';
    if (!stopped && !(await app.evaluate(mainFocused))) {
      await app.evaluate(emitMainFocus);
      stopped = await pollMain(app, stoppedFlash, 2000);
      how = '系统没有把焦点交给 Mori（测试进程不在前台），测试直接发出主窗口的 focus 事件';
    }
    record('任务栏：窗口获得焦点后停止闪烁（flashFrame(false)）', stopped,
      `${how}；调用：${JSON.stringify(await app.evaluate(flashCalls))}`);
    await h.textarea.press('Alt+1');
    await waitCardGone(page);
    await waitIdle(page);
  } finally {
    await app.evaluate(restoreFlash).catch((error) => console.error(`[m2-app] restore flashFrame failed: ${error}`));
  }
}

/**
 * @brief 窗口藏在托盘里时出现批准卡（2026-10-26，window.md、approval.md"任务栏闪烁"）：窗口以最小化的样子回到任务栏、
 *        不弹到前面，任务栏按钮闪烁；点托盘图标回到窗口后停止闪烁。合成端点 3 秒后才给出命令，这期间关掉窗口。
 */
async function hiddenFlash({ app, page, h }) {
  await app.evaluate(installFlashRecorder);
  // 第一次关窗口的气泡只记下、不真的弹出系统通知（m0-smoke 检查它的内容）
  await recordBalloons(app);
  try {
    await h.send('wait 3s then run: echo m2-hidden');
    await closeWindow(app);
    const hidden = await windowState(app);
    // Windows 上最小化的窗口 isVisible() 也是 false，所以只看 isMinimized()（藏起的窗口不是最小化）
    const back = await waitWindow(app, (state) => state.minimized, 10000);
    const flashed = await pollMain(app, () => globalThis.__m2Flash.calls
      .some((call) => call.id === globalThis.__m2Flash.mainId && call.flag === true), 5000);
    record('窗口藏在托盘里时出现批准卡：窗口以最小化的样子回到任务栏（不弹到前面），任务栏按钮闪烁',
      hidden?.visible === false && !hidden.minimized && back.ok && !back.state.focused && flashed,
      JSON.stringify({ hidden, back: back.state, calls: await app.evaluate(flashCalls) }));
    await findTray(app);
    await clickTrayIcon(app);
    const shown = await waitWindow(app, (state) => state.visible && !state.minimized, 5000);
    const stoppedFlash = () => globalThis.__m2Flash.calls
      .filter((call) => call.id === globalThis.__m2Flash.mainId).at(-1)?.flag === false;
    let stopped = await pollMain(app, stoppedFlash, 5000);
    let how = '系统把焦点交回了 Mori';
    if (!stopped && !(await app.evaluate(mainFocused))) {
      await app.evaluate(emitMainFocus);
      stopped = await pollMain(app, stoppedFlash, 2000);
      how = '系统没有把焦点交给 Mori（测试进程不在前台），测试直接发出主窗口的 focus 事件';
    }
    record('点托盘图标回到窗口：最小化的窗口还原，停止闪烁', shown.ok && stopped,
      `${how}；窗口=${JSON.stringify(shown.state)}；调用：${JSON.stringify(await app.evaluate(flashCalls))}`);
    await waitCard(page);
    await h.textarea.press('Alt+3');
    await waitCardGone(page);
    await waitIdle(page);
  } finally {
    await app.evaluate(showMain).catch((error) => console.error(`[m2-app] show the window failed: ${error}`));
    await app.evaluate(restoreFlash).catch((error) => console.error(`[m2-app] restore flashFrame failed: ${error}`));
  }
}

/**
 * @brief 窗口藏在托盘里时后台进程意外退出（window.md 同名一行）：Mori 不退出、托盘图标还在；点托盘图标回到窗口后
 *        看到"后台进程退出"的横幅和"Restart"。窗口藏着时只在主进程里查状态；最后 Restart，后面的步骤照常。
 */
async function hiddenKernelExit({ app, page }) {
  let exited = false;
  const onExit = () => { exited = true; };
  app.process().once('exit', onExit);
  try {
    await closeWindow(app);
    const hidden = await waitWindow(app, (state) => !state.visible && !state.minimized, 5000);
    killKernel(app);
    await sleep(2000);
    const tray = await findTray(app);
    await clickTrayIcon(app);
    const shown = await waitWindow(app, (state) => state.visible && !state.minimized, 5000);
    const pane = paneOf(page);
    const banner = await pane.getByTestId('kernel-exit').waitFor({ timeout: 10000 }).then(() => true, () => false);
    const restart = banner && await pane.getByRole('button', { name: 'Restart', exact: true }).isVisible();
    record('窗口藏在托盘里时后台进程意外退出：Mori 不退出、托盘图标还在；点托盘图标回到窗口后看到"后台进程退出"的横幅和'
      + '"Restart"', hidden.ok && !exited && tray.tray && shown.ok && banner && restart,
    JSON.stringify({ hidden: hidden.state, exited, tray, shown: shown.state, banner, restart }));
  } finally {
    app.process().off('exit', onExit);
    await app.evaluate(showMain).catch((error) => console.error(`[m2-app] show the window failed: ${error}`));
  }
  await restartIfExited(page);
}

/**
 * @brief 关窗口前已经在等的批准卡（window.md"关掉窗口"：等你批准的卡不停，界面状态原样）：卡出来以后关掉窗口，点托盘
 *        图标回来，卡还在（同一个请求），Alt+1 照常批准、命令跑完。出卡时窗口开着，提醒只让任务栏闪烁（不最小化）；
 *        等 300 毫秒让这次提醒先到主进程，再关窗口。
 */
async function closeKeepsCard({ app, page, h }) {
  await recordBalloons(app);
  try {
    await h.send('run: echo m2-close-card');
    const request = await waitCard(page);
    await sleep(300);
    await closeWindow(app);
    const hidden = await waitWindow(app, offScreen, 5000);
    await findTray(app);
    await clickTrayIcon(app);
    const shown = await waitWindow(app, onScreen, 5000);
    const card = await cardInfo(page);
    await h.textarea.press('Alt+1');
    await waitCardGone(page);
    await waitIdle(page);
    const last = (await toolCards(page)).at(-1);
    record('关窗口前已经在等的批准卡：关掉窗口、点托盘图标回来后卡还在（同一个请求），Alt+1 照常批准，命令跑完',
      hidden.ok && shown.ok && card?.request === request && card.command.includes('m2-close-card')
      && last?.status === 'done' && last.title.includes('m2-close-card'), JSON.stringify({ hidden: hidden.state,
        shown: shown.state, request, card: card && { request: card.request, command: card.command }, last }));
  } finally {
    await app.evaluate(showMain).catch((error) => console.error(`[m2-app] show the window failed: ${error}`));
  }
}

/**
 * @brief 写不进标记文件时（U10，docs/v0/defaults.md"写不进第一次关窗口的标记文件"）：主进程写 tray-notice-shown 的
 *        writeFileSync 换成抛出 EPERM 的版本（synthetic，别的文件照常写）；这次运行的第一次、第二次关窗口都弹同样的气泡，
 *        每次记一条错误日志，标记文件没有写下。要在这次运行第一次关窗口之前跑（steps 里排在 hiddenFlash 前面）。
 */
async function noticeUnwritable({ app, userData, log }) {
  const marker = join(userData, NOTICE_MARKER);
  const fresh = !existsSync(marker);
  await recordBalloons(app);
  const before = (await balloonCalls(app)).length;
  const from = log.length;
  await failMarkerWrites(app);
  try {
    for (const [index, which] of ['第一次', '第二次'].entries()) {
      await closeWindow(app);
      const hidden = await waitWindow(app, offScreen, 5000);
      const balloons = (await balloonCalls(app)).slice(before);
      const errors = await waitLogCount(log, from, MARKER_ERROR, index + 1);
      const attempts = await markerAttempts(app);
      record(`写不进标记文件时${which}关窗口（这次运行里）：窗口藏进托盘，照样弹气泡"${NOTICE_TITLE}"，记一条错误日志`
        + '"cannot write …"，标记文件没有写下', (fresh || index > 0) && hidden.ok && balloons.length === index + 1
        && balloons.every(isNotice) && attempts === index + 1 && errors === index + 1 && !existsSync(marker),
      JSON.stringify({ fresh, hidden: hidden.state, balloons, attempts, errors }));
      await findTray(app);
      await clickTrayIcon(app);
      await waitWindow(app, onScreen, 5000);
    }
  } finally {
    await restoreMarkerWrites(app).catch((error) => console.error(`[m2-app] restore writeFileSync failed: ${error}`));
    await app.evaluate(showMain).catch((error) => console.error(`[m2-app] show the window failed: ${error}`));
  }
}

/**
 * @brief 确认框弹不出来时（U10，docs/v0/defaults.md"退出前的确认框弹不出来"）：有会话在生成时点托盘"Exit"，这一次
 *        dialog.showMessageBox 返回失败（synthetic）：Mori 记错误日志，什么都不做——不退出，窗口和托盘图标都在，回复照常生成。
 */
async function exitNoDialog({ app, page, h, log }) {
  let exited = false;
  const onExit = () => { exited = true; };
  app.process().once('exit', onExit);
  try {
    await h.send('wait 8s');
    await waitRunning(page);
    // 界面数变了才经 mori:busy-sessions 告诉主进程，等它到
    await sleep(500);
    const from = log.length;
    await failMessageBoxOnce(app);
    await findTray(app);
    await clickTrayItem(app, 'Exit');
    const errors = await waitLogCount(log, from, ASK_ERROR, 1);
    await sleep(1500);
    const alive = !exited && app.process().exitCode === null;
    const rejected = alive ? await restoreMessageBox(app) : null;
    const tray = alive ? await findTray(app) : null;
    const window = alive ? await windowState(app) : null;
    const running = alive ? await paneOf(page).getAttribute('data-running') : null;
    record('有会话在生成时点托盘"Exit"、确认框弹不出来：记一条错误日志"cannot ask before quitting"，什么都不做——Mori 不退出，'
      + '窗口和托盘图标都在，回复照常生成', alive && rejected === 1 && errors === 1 && Boolean(tray?.tray)
      && Boolean(tray.items?.includes('Exit')) && Boolean(window && onScreen(window)) && running === 'true',
    JSON.stringify({ alive, rejected, errors, tray, window, running }));
  } finally {
    app.process().off('exit', onExit);
    await restoreMessageBox(app).catch((error) => console.error(`[m2-app] restore showMessageBox failed: ${error}`));
  }
  await waitIdle(page, 30000);
}

/** @brief 等当前会话面板开始生成（data-running）。 */
function waitRunning(page) {
  return page.waitForFunction((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE,
    { timeout: 20000 });
}

/**
 * @brief 两个会话都在生成时点托盘"Exit"（window.md"退出，有会话正在生成"：N 大于 1 时"… in N sessions. …"）：当前会话
 *        发"wait 15s"、再开一个新会话发"wait 6s"，两个都在生成时点"Exit"（确认框按"Cancel"回答）：说明是
 *        "Mori is working in 2 sessions. Quitting now will interrupt that work."，Mori 不退出；之后等新会话这一轮结束。
 */
async function quitTwoSessions({ app, page, h, project }) {
  await h.send('wait 15s');
  await waitRunning(page);
  await openNewSession(app, page, project);
  await h.send('wait 6s');
  await waitRunning(page);
  // 界面数变了才经 mori:busy-sessions 告诉主进程，等它到
  await sleep(500);
  const running = await page.locator('[data-testid="chat-pane"][data-running="true"]').count();
  await stubMessageBox(app, 1);
  const before = (await messageBoxes(app)).length;
  await findTray(app);
  await clickTrayItem(app, 'Exit');
  const boxes = await waitMessageBoxes(app, before + 1);
  await sleep(500);
  const box = boxes[before]?.options;
  record(`两个会话都在生成时点托盘"Exit"：确认框的说明是复数"${quitDetail(2)}"；选"Cancel"Mori 不退出`,
    running === 2 && boxes.length === before + 1 && box?.detail === quitDetail(2) && app.process().exitCode === null,
    `生成中的会话面板 ${running} 个；${oneLine(JSON.stringify(boxes.slice(before)), 400)}`);
  await waitIdle(page, 30000);
}

// ---------- F8 ----------

/** @brief Markdown 里"## 标题"下的内容（到下一个"## "为止）。 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** @brief 两个路径是否指向同一个文件（Windows 不区分大小写）。 */
const samePath = (a, b) => Boolean(a && b) && resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** @brief 等"Saved to <路径>"，返回 Markdown 文件路径。 */
async function savedIssuePath(page) {
  const saved = page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  return /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
}

/** @brief 按 F8（焦点在输入框里），等报告框和截图缩略图出现。 */
async function openIssueDialog(page, h) {
  await h.textarea.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  return dialog;
}

/**
 * @brief 检查保存的 Markdown：位置、文件名、各节、你写的文字、当前界面（含"Model range""Effort"和"Pane width"）、
 *        最近的操作、版本、没有 key。facts 是按 F8 之前记下的那一栏宽度、范围、Effort 和权限（m2-helpers.mjs paneFacts）。
 */
function checkIssueText({ issue, userData }, { what, expect, facts }) {
  const md = issue && existsSync(issue) ? readFileSync(issue, 'utf8') : '';
  const lines = md.split(/\r?\n/);
  const missing = ISSUE_HEADINGS.filter((heading) => !lines.some((line) => line.startsWith(heading)));
  const inDir = Boolean(issue) && samePath(dirname(issue), join(userData, 'ui-issues'));
  const named = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.md$/.test(basename(issue ?? ''));
  record('F8：保存后显示"已保存到 <路径>"，Markdown 在 <userData>/ui-issues 里、以时间命名，各节齐全，有你写的两段',
    md.length > 0 && inDir && named && missing.length === 0 && section(md, 'What went wrong').includes(what)
    && section(md, 'What you expected').includes(expect), `${issue ?? '没有路径'}；缺少：${missing.join('、') || '无'}`);
  const view = section(md, 'Current view');
  const actions = section(md, 'Recent activity');
  const version = section(md, 'Versions');
  record('F8：附上当前界面（"- 名称：值"）、带时间的最近操作（含批准卡的选择）和版本',
    /^- [^:\n]+: \S/m.test(view) && /^- \d{2}:\d{2}:\d{2} \S/m.test(actions)
    && actions.includes('Permission request: ')
    && ['Mori', 'Electron', 'Chromium', 'Node', 'Windows'].every((name) => version.includes(name)),
    oneLine(`${view} | ${actions.split(/\r?\n/).slice(-3).join(' ')} | ${version}`, 400));
  const problems = f8ViewProblems(viewFields(view), facts);
  record('F8："当前界面"里"Model""Permission mode"照旧，多了"Model range"（同范围按钮的 data-pick）、"Effort"（同输入框'
    + '下面一行的 Effort 按钮）和"Pane width"（焦点所在那一栏的宽度），顺序同 f8.md', md.length > 0 && problems.length === 0,
  problems.join('; '));
  // v1：保存 key 的是 设置 → Models 的 Add key（models.addKey），"Recent activity"只记"Add key <providerId>"（规格 §9.4）。
  const saves = actions.split(/\r?\n/).filter((line) => line.includes('Add key'));
  record('F8：报告里没有 API key（"Recent activity"里有刚才加 key 的"Add key"）', md.length > 0 && saves.length > 0
    && !md.includes(testKey), saves.join(' | ') || '"Recent activity"里没有"Add key"');
  return md;
}

/** @brief 检查截图：Markdown 用相对路径引用同名 .png，文件存在且以 PNG 文件头开始。 */
function checkIssueShot(issue, md) {
  const shot = /!\[Screenshot\]\(([^)]+)\)/.exec(section(md, 'Screenshot'))?.[1] ?? '';
  const png = issue && shot ? join(dirname(issue), shot) : '';
  const head = png && existsSync(png) ? readFileSync(png).subarray(0, 8) : Buffer.alloc(0);
  record('F8：截图存为同名 .png（PNG 文件头），Markdown 用相对路径引用它',
    Boolean(issue) && shot === basename(issue).replace(/\.md$/, '.png') && head.equals(PNG_SIGNATURE),
    shot || '没有引用截图');
}

/** @brief 报告框保存后的链接：View in Settings 的文字（没有时为 null）、名为 View in Review 的按钮个数（记忆规格 §10.9）。 */
async function savedLinks(dialog) {
  const settings = dialog.getByTestId('issue-open-settings');
  return { settings: await settings.count() === 1 ? (await settings.innerText()).trim() : null,
    review: await dialog.getByRole('button', { name: 'View in Review' }).count() };
}

/** @brief "Show in Explorer"：主进程的 shell.showItemInFolder 收到这个 Markdown 文件（已替换，不会打开资源管理器）。 */
async function showInFolder({ app, page, issue }) {
  const dialog = page.getByTestId('issue-dialog');
  const name = 'F8："打开所在文件夹"在资源管理器里选中这个文件（shell.showItemInFolder）';
  if (!(await app.evaluate(stubShowItem))) {
    record(name, false, '无法替换 shell.showItemInFolder，没有点按钮（避免真的打开资源管理器）');
  } else {
    await dialog.getByRole('button', { name: 'Show in Explorer' }).click();
    await pollMain(app, () => globalThis.__m2Shown.length > 0, 5000);
    const shown = await app.evaluate(() => globalThis.__m2Shown);
    record(name, shown.some((path) => samePath(path, issue)), shown.join(' | ') || '没有调用');
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * @brief F8 之前在 设置 → Models 用合成端点的 key 再加一个 key（v1：Add key，models.addKey，规格 §14.4）：报告只带
 *        最近 30 条操作，setup 里那次保存早就不在里面了，这样"报告里没有 key"才真的检查到了加 key 这一条。
 */
async function saveKeyAgain({ page, h }) {
  await h.openModels();
  const rows = await h.addKey(testKey);
  await page.getByRole('button', { name: 'Back to app' }).click();
  await paneOf(page).waitFor({ timeout: 10000 });
  record('准备 F8：在 设置 → Models 用 Add key 再加一个 key', rows === 2, `key 行 ${rows} 个`);
}

/** @brief F8：截图、两个输入框和说明；再按 F8 焦点回到第一个输入框；保存后文件齐全；"Show in Explorer"。 */
async function f8Save(ctx) {
  const { page, h } = ctx;
  const facts = await paneFacts(page, PANE);
  const dialog = await openIssueDialog(page, h);
  const shot = await dialog.getByTestId('issue-shot').evaluate((img) => img.naturalWidth > 0);
  const text = await dialog.innerText();
  const fields = await dialog.getByRole('textbox', { name: 'What went wrong' }).count()
    + await dialog.getByRole('textbox', { name: 'What you expected' }).count();
  record('F8：报告框有截图缩略图、"哪里不对""你期望什么"两个输入框和说明', shot && fields === 2
    && await dialog.getAttribute('aria-label') === 'Report a UI issue'
    && text.includes('Includes a screenshot, the current view, and your recent activity. Saved on this computer and '
      + 'never sent to the model.'), oneLine(text));
  await page.screenshot({ path: join(shots, '08-issue-dialog.png') });
  await dialog.getByTestId('issue-expect').focus();
  await page.keyboard.press('F8');
  const refocused = await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid')
    === 'issue-what', null, { timeout: 5000 }).then(() => true, () => false);
  record('F8：报告框开着时再按 F8 不重复打开，焦点回到第一个输入框',
    refocused && await page.getByTestId('issue-dialog').count() === 1);
  const input = { what: '批准卡的按钮太挤', expect: '按钮之间留点空' };
  await dialog.getByTestId('issue-what').fill(input.what);
  await dialog.getByTestId('issue-expect').fill(input.expect);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  ctx.issue = await savedIssuePath(page);
  const links = await savedLinks(dialog);
  record('F8：保存后有"View in Settings"（data-testid="issue-open-settings"，记忆规格 §10.9），没有"View in Review"',
    links.settings === 'View in Settings' && links.review === 0, JSON.stringify(links));
  const md = checkIssueText(ctx, { ...input, facts });
  checkIssueShot(ctx.issue, md);
  await page.screenshot({ path: join(shots, '09-issue-saved.png') });
  await showInFolder(ctx);
}

/** @brief 保存中点"Cancel"不起作用：按钮不可用、不显示，或者点了报告框还在。 */
async function cancelIgnored(page, dialog) {
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true }).first();
  if (await cancel.count() === 0 || await cancel.isDisabled({ timeout: 2000 })) return true;
  await cancel.click({ timeout: 2000 });
  await sleep(200);
  return await page.getByTestId('issue-dialog').count() === 1;
}

/** @brief 保存中（主进程的保存延迟 2.5 秒）按 Esc、点"Cancel"：报告框不关闭，保存结束后显示"Saved to <路径>"。 */
async function f8EscWhileSaving({ app, page, h }) {
  const dialog = await openIssueDialog(page, h);
  await dialog.getByTestId('issue-what').fill('保存中按 Esc');
  const delayed = await app.evaluate(delayIssueSave, 2500);
  try {
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const saving = await dialog.getByRole('button', { name: 'Saving…' }).waitFor({ timeout: 2000 })
      .then(() => true, () => false);
    await page.keyboard.press('Escape');
    await sleep(300);
    const afterEsc = await page.getByTestId('issue-dialog').count() === 1;
    const cancelOff = afterEsc && await cancelIgnored(page, dialog);
    const file = afterEsc && cancelOff ? await savedIssuePath(page).catch(() => null) : null;
    record('F8：保存中按 Esc、点"取消"都不关闭报告框，保存结束后显示"已保存到 <路径>"',
      delayed && saving && afterEsc && cancelOff && Boolean(file),
      `延迟保存 ${delayed}，显示保存中 ${saving}，Esc 后还在 ${afterEsc}，取消不起作用 ${cancelOff}，${file ?? '没有路径'}`);
  } finally {
    await app.evaluate(restoreIssueSave).catch((error) => console.error(`[m2-app] restore save-issue: ${error}`));
  }
  if (await dialog.count() > 0) {
    await dialog.getByTestId('issue-saved').waitFor({ timeout: 15000 }).catch(() => {});
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  }
}

/** @brief 命令运行中按 F8 再按 Esc：只关闭报告框，焦点回到输入框，命令照常完成。 */
async function f8EscKeepsRunning({ page, h }) {
  const stoppedBefore = await stoppedCount(page);
  await h.send('run: sleep 6');
  await waitCard(page);
  await h.textarea.press('Alt+1');
  await paneOf(page).locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 15000 });
  await h.textarea.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await page.keyboard.press('Escape');
  const closed = await dialog.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false);
  const focusBack = await waitComposerFocus(page);
  const during = (await toolCards(page)).at(-1);
  await waitIdle(page, 60000);
  const last = (await toolCards(page)).at(-1);
  record('F8：报告框里按 Esc 只关闭报告框，不停止正在运行的命令（命令卡"完成"）', closed && during?.status === 'running'
    && last?.status === 'done' && last.text.startsWith('Done') && (await stoppedCount(page)) === stoppedBefore,
  `${JSON.stringify(during)} → ${JSON.stringify(last)}`);
  record('F8：关闭报告框后焦点回到打开前的位置（输入框）', focusBack);
}

/**
 * @brief 后台进程退出时开着的上下文用量详情不关、圆环保留最后的用量，Esc 关上后还能再打开（models.md"什么时候自动关"、
 *        "上下文用量（圆环）"后台进程退出一行）。
 */
async function usageAfterKernelKilled(app, page) {
  const tokens = await usageButton(page).getAttribute('data-tokens');
  await usageButton(page).click();
  const details = paneOf(page).getByTestId('usage-details');
  const opened = await details.waitFor({ timeout: 3000 }).then(() => true, () => false);
  killKernel(app);
  await paneOf(page).getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  await sleep(300);
  const kept = await details.count() === 1;
  const after = await usageButton(page).getAttribute('data-tokens').catch(() => null);
  await usageButton(page).focus();
  await page.keyboard.press('Escape');
  const closed = await details.waitFor({ state: 'detached', timeout: 2000 }).then(() => true, () => false);
  await usageButton(page).click();
  const again = await details.waitFor({ timeout: 3000 }).then(() => true, () => false);
  record('后台进程退出：开着的上下文用量详情不关，圆环保留最后的用量（data-tokens 不变）；Esc 关上后还能再打开', opened
    && kept && tokens !== null && after === tokens && closed && again,
  `详情打开 ${opened}，退出后还开着 ${kept}，data-tokens ${tokens} → ${after}，Esc 关上 ${closed}，再打开 ${again}`);
}

/** @brief 后台进程退出后 F8 仍能截图并保存；没填"What you expected"时写"(left blank)"。 */
async function f8AfterKernelKilled({ app, page, h }) {
  await usageAfterKernelKilled(app, page);
  const dialog = await openIssueDialog(page, h);
  await dialog.getByTestId('issue-what').fill('后台进程退出后的提示');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const file = await savedIssuePath(page);
  const md = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  const shot = /!\[Screenshot\]\(([^)]+)\)/.exec(section(md, 'Screenshot'))?.[1];
  const png = Boolean(file && shot) && existsSync(join(dirname(file), shot));
  record('F8：后台进程退出后也能截图并保存报告；没填的"你期望什么"写"（没有填写）"', md.includes('后台进程退出后的提示')
    && section(md, 'What you expected') === '(left blank)' && png, file ?? '没有保存');
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

/** @brief 左栏底部"Report a UI issue (F8)"打开同一个报告框；两个框都空时"Save"不可用；"Cancel"关闭。 */
async function f8SidebarButton({ page }) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Report a UI issue (F8)' }).click();
  const dialog = page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  const disabled = await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  const closed = await dialog.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false);
  record('F8：左栏底部"报告界面问题（F8）"打开同一个报告框；两个框都空时"保存"不可用，"取消"关闭', disabled && closed);
}

/** @brief 后台进程退出时点"Restart"，等会话重新打开好（没有退出时不动）。 */
async function restartIfExited(page) {
  const pane = paneOf(page);
  if (await pane.getByTestId('kernel-exit').count() === 0) return;
  await pane.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.waitForFunction((selector) => !document.querySelector(`${selector} [data-testid="kernel-exit"]`)
    && !document.querySelector(`${selector} [data-testid="not-ready"]`), PANE, { timeout: 30000 });
}

/**
 * @brief "Switch to “Allow all”?"开着时后台进程退出（approval.md"权限菜单"，composer-pickers-checks.md 第 60 条）：
 *        确认框按取消关上、焦点回到权限按钮；Restart、会话重新打开后仍是"Ask each time"（确认框关上了，"Allow all"
 *        点不到，不会把 approval.setMode 发给退出或正在重启的后台进程）。
 */
async function confirmOnKernelExit({ app, page }) {
  await restartIfExited(page);
  const menu = await openPermissionMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Allow all' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  const shown = await dialog.waitFor({ timeout: 5000 }).then(() => true, () => false);
  killKernel(app);
  await paneOf(page).getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  const closed = await dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
  const focus = await permissionButton(page).evaluate((el) => el === document.activeElement);
  await restartIfExited(page);
  const mode = await permissionButton(page).innerText();
  record('后台进程退出时开着的"Switch to “Allow all”?"按取消关上、焦点回到权限按钮；Restart 之后仍是"Ask each time"',
    shown && closed && focus && mode.includes('Ask each time'), JSON.stringify({ shown, closed, focus, mode }));
}

/** @brief 某一步出错后尽量回到空闲：关掉浮层；后台进程退出时重新载入；还在运行就停止；清空输入框。 */
async function recover({ page }) {
  for (let tries = 0; tries < 3 && await page.locator(OVERLAYS).count() > 0; tries += 1) {
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  const pane = paneOf(page);
  if (await pane.count() === 0) return;
  if (await pane.getByTestId('kernel-exit').count() > 0) {
    await pane.getByRole('button', { name: 'Restart', exact: true }).click();
    await page.waitForFunction((selector) => !document.querySelector(`${selector} [data-testid="not-ready"]`), PANE,
      { timeout: 30000 });
  }
  if (await pane.getAttribute('data-running', { timeout: 2000 }) === 'true') {
    await pane.locator('.stop-button').click({ timeout: 5000 });
    await waitIdle(page, 30000);
  }
  await pane.locator('.composer textarea').fill('', { timeout: 5000 });
  // 停在"Allow all"的会话里，后面的步骤就看不到卡了
  if ((await permissionButton(page).innerText({ timeout: 2000 })).includes('Allow all')) {
    await switchToAsk(page);
  }
}

const steps = {
  setup, readNoCard, editCard, editApprove, rejectReason, longReason, allowSession, permissionMenu, oneOverlay,
  newSessionAsks, allowAll, pendingToAll, escStop, escInCard, escMenuFirst, twoCommands, cardClosesOverlays,
  queuedTurnKeepsMenu, keyGuards, usageNotBlocking, buttonGoneFocus, writeCard, writeOutside, hiddenChars, followCard,
  minWindow, minWindowMenu, taskbarFlash, noticeUnwritable, hiddenFlash, hiddenKernelExit, closeKeepsCard, saveKeyAgain,
  f8Save, f8EscWhileSaving, f8EscKeepsRunning, f8AfterKernelKilled, f8SidebarButton, confirmOnKernelExit,
  quitTwoSessions, exitNoDialog,
};

const fake = await startFakeEndpoint();
const { project } = prepareProject('mori-m2-app-');
const userData = mkdtempSync(join(tmpdir(), 'mori-m2-app-data-'));
const app = await launch({ exePath, userData });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const log = collectMainLog(app);
const ctx = { app, page, h: pageHelpers(page), project, userData, log, issue: null, request: null };
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && name !== 'setup' && !only.includes(name)) continue;
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      await page.screenshot({ path: join(shots, `${name}-error.png`) }).catch(() => {});
      await recover(ctx).catch((problem) => console.error(`[m2-app] recover after ${name}: ${oneLine(problem)}`));
    }
  }
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await app.close().catch(() => {});
  fake.kill();
}
await sleep(200);
process.exitCode = write(`m2-app${suffix}.json`) ? 0 : 1;
