// M3 整机测试的后半段，由 m3-app.mjs 在同一次运行里接着调用（同一个 Mori、同一个合成端点，synthetic）：
// 扩展的询问（docs/v0/screens/extension-ui.md）：确认、选择、输入的询问卡（卡头、标题、说明、按钮、提示文字）、
// 不抢输入框的焦点、输入框里 Enter 不作答、按钮作答、输入框里 Enter 确定、焦点在卡上时 Esc、
// 阶段行"Waiting for your answer"、不可见的会话显示"Needs input"、通知一行"Extension: …"（warning）、
// 超时倒数与自动取消、停止时取消挂着的询问；
// 会话打开过程中的通知（打开后显示）与询问（不出卡，按取消回答）；扩展命令里的询问（不经过一轮运行）；
// 正在打开的会话的菜单（三项都不可用，小字"Opening…"）和输入框下面一行（第一次打开中只有不可用的权限按钮）；
// 询问卡来了时这一行的菜单和圆环详情关上。
// 界面重新加载（sessions.md "后台进程退出与重新载入"）：后台进程里的会话照常运行，session.list 带回 live，
// 侧栏显示 Running、Needs approval、Needs input，还没接上时随事件更新（之后才来的批准请求、本轮结束时"Unread"、
// 后台进程退出时"Error"）；还没发消息的新会话也在；点开接上（不问信任）：生成中的回复接着流入、执行中的工具卡、
// 挂着的批准卡和扩展询问照常出现并能作答；草稿和"Allowed for this session"还在；本次运行里信任询问的回答清空；
// 归档开着、还没接上的会话。
// 项目扩展（eta/.pi/extensions/project-ask.ts）是测试写的 synthetic 扩展：加载时先等 2.5 秒（看得到"Starting…"），
// 再注册 project_ask（依次确认、选择、输入，再通知）、project_wait（带 3 秒超时的确认）、project_once（只问一次）、
// 命令 /mori-ask（确认一次再通知）、/mori-late（等 2 秒再确认）、/mori-wait（带 15 秒超时的确认）；
// session_start 时确认一次并通知结果。
// 2026-10-26（docs/v0/screens/window.md"关掉窗口"，WP-20 记录"状态表各行的用例"）：关窗口前已经在等的扩展询问卡，
// 关掉窗口（藏进系统托盘）再点托盘图标回来后还在、能作答（extCloseWindow；托盘经 tray-helpers.mjs 在主进程里找到）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killKernel, oneLine, sleep } from './lib.mjs';
import { stepsState } from './page.mjs';
import {
  clickTrayIcon, closeWindow, findTray, offScreen, onScreen, recordBalloons, waitWindow,
} from './tray-helpers.mjs';
import {
  activeFile, allRows, archivedState, blockedBy, chooseMenuItem, clickOpenFolder, composerRow, ctrlN, expandArchived,
  focusInfo, kernelOpen, lastReply, lastToolCard, liveInfo, menuItems, menuText, noteSmallText, openMenuByKey,
  openMenuByMouse, openMenuOn, openRow, PANE, paneCount, paneOf, ROW_REASONS, rowOf, rowState, samePath, sessionGone,
  startDelete, stoppedCount, until, waitArchivedToggle, waitIdle, waitPanes, waitReady, waitRunning, waitStatus,
} from './m3-helpers.mjs';

/** 项目扩展加载时先等这么久，打开会话时有时间看到"Starting…"和菜单的"Opening…" */
const SLOW_LOAD_MS = 2500;
/** /mori-late 等这么久才询问：测试先打开这一行的菜单或圆环详情，询问卡再来 */
const LATE_ASK_MS = 2000;
/** 询问卡输入框里写的字 */
const ANSWER_TEXT = 'Mori 的回答';
/** 界面重新加载前写的草稿 */
const RELOAD_DRAFT = '重新加载之前写的草稿';
/** 界面重新加载时还在执行的命令要跑的秒数（少见的数，不和别的 sleep 混） */
const SLEEP_SECONDS = 29;
/** 扩展的工具 */
const ASK_TOOLS = ['project_ask', 'project_wait', 'project_once'];
/** 询问卡的卡头 */
const QUESTION_HEAD = 'An extension needs your input';
/** 有挂起的扩展询问时的阶段行 */
const WAITING_ANSWER = 'Waiting for your answer';
/** "/"列表里没有可选的项时的说明（slash.md）：没有匹配，或这个会话没有提示词模板和技能 */
const SLASH_NOTES = ['No matching prompt templates or skills',
  'This session has no prompt templates or skills. Add them in Customize.'];

/** @brief synthetic 项目扩展里三个扩展命令的源码行（/mori-ask、/mori-late、/mori-wait）。 */
function askCommandsSource() {
  return [
    "  pi.registerCommand('mori-ask', { description: 'Asks once from a command.',",
    '    async handler(_args, ctx) {',
    "      const ok = await ctx.ui.confirm('命令里问', '不经过一轮运行');",
    "      ctx.ui.notify('command confirm=' + ok, 'info');",
    '    } });',
    "  pi.registerCommand('mori-late', { description: 'Asks from a command after 2 seconds.',",
    '    async handler(_args, ctx) {',
    `      await new Promise((done) => setTimeout(done, ${LATE_ASK_MS}));`,
    "      const ok = await ctx.ui.confirm('晚到的询问', '这一行的菜单开着时来');",
    "      ctx.ui.notify('late confirm=' + ok, 'info');",
    '    } });',
    "  pi.registerCommand('mori-wait', { description: 'Asks with a timeout from a command.',",
    '    async handler(_args, ctx) {',
    "      await ctx.ui.confirm('命令里等', '15 秒后取消', { timeout: 15000 });",
    '    } });',
  ];
}

/** @brief synthetic 项目扩展的源码：工厂函数先等 SLOW_LOAD_MS，再注册三个经 ctx.ui 询问的工具。 */
function askExtensionSource() {
  return [
    '// synthetic: written by tests/ui/m3-app-live.mjs; asks through ctx.ui (docs/v0/screens/extension-ui.md).',
    "const params = { type: 'object', properties: {}, additionalProperties: false };",
    "const text = (value) => ({ content: [{ type: 'text', text: value }], details: {} });",
    '',
    'export default async function (pi) {',
    `  await new Promise((done) => setTimeout(done, ${SLOW_LOAD_MS}));`,
    "  pi.registerTool({ name: 'project_ask', label: 'Project ask', description: 'Asks three questions.',",
    '    parameters: params,',
    '    async execute(_id, _params, _signal, _onUpdate, ctx) {',
    "      const ok = await ctx.ui.confirm('继续吗？', '说明');",
    "      const pick = await ctx.ui.select('选一个', ['甲', '乙']);",
    "      const typed = await ctx.ui.input('写点什么', '提示');",
    "      ctx.ui.notify('ask done', 'warning');",
    "      return text('confirm=' + ok + '; select=' + (pick ?? '(none)') + '; input=' + (typed ?? '(none)'));",
    '    } });',
    "  pi.registerTool({ name: 'project_wait', label: 'Project wait', description: 'Asks with a timeout.',",
    '    parameters: params,',
    '    async execute(_id, _params, _signal, _onUpdate, ctx) {',
    "      const ok = await ctx.ui.confirm('超时测试', '…', { timeout: 3000 });",
    "      return text('wait=' + ok);",
    '    } });',
    "  pi.registerTool({ name: 'project_once', label: 'Project once', description: 'Asks one question.',",
    '    parameters: params,',
    '    async execute(_id, _params, _signal, _onUpdate, ctx) {',
    "      const ok = await ctx.ui.confirm('只问一次', '停止时取消');",
    "      return text('once=' + ok);",
    '    } });',
    ...askCommandsSource(),
    "  pi.on('session_start', async (_event, ctx) => {",
    "    const ok = await ctx.ui.confirm('启动时问', '打开过程中');",
    "    ctx.ui.notify('startup confirm=' + ok, 'info');",
    '  });',
    '}',
    '',
  ].join('\n');
}

/** @brief 给 project 写上询问用的项目扩展（.pi/extensions/project-ask.ts）。 */
export function writeAskExtension(project) {
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'project-ask.ts'), askExtensionSource());
}

// ---------- 询问卡 ----------

/** @brief 当前会话面板里的扩展询问卡。 */
const questionCard = (page) => paneOf(page).getByTestId('ext-ui-card');
/** @brief 两个列表是否相同。 */
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** @brief 剩 n 秒时卡上的说明（1 秒时用单数）。 */
const expiresText = (n) => (n === 1 ? 'This request expires in 1 second' : `This request expires in ${n} seconds`);
/** @brief "This request expires in N seconds"里的 N；不是这个写法（含单复数）时为 null。 */
const secondsOf = (text) => {
  const match = /^This request expires in (\d+) seconds?$/.exec(text ?? '');
  return match && text === expiresText(Number(match[1])) ? Number(match[1]) : null;
};
/** @brief 当前会话面板的阶段行文字；没有时为空串。 */
const stageOf = (page) => paneOf(page).getByTestId('stage').innerText({ timeout: 2000 }).catch(() => '');

/**
 * @brief 当前会话面板里询问卡的内容：种类、询问 id、卡头、标题、说明、超时、按钮、输入框的提示文字；
 *        没有卡时为 null（不等待）。
 */
function cardView(page) {
  return page.evaluate((selector) => {
    const el = document.querySelector(`${selector} [data-testid="ext-ui-card"]`);
    if (!el) return null;
    return { method: el.dataset.method, request: el.dataset.request,
      head: el.querySelector('.approval-head')?.textContent?.trim() ?? '',
      title: el.querySelector('.question-title')?.textContent ?? '',
      message: el.querySelector('.question-message')?.textContent ?? '',
      timeout: el.querySelector('.question-timeout')?.textContent ?? '',
      buttons: [...el.querySelectorAll('button')].map((button) => button.textContent.trim()),
      placeholder: el.querySelector('input')?.getAttribute('placeholder') ?? null };
  }, PANE);
}

/** @brief 等种类为 method 的询问卡出现（上一张结束、下一张接着出现时等它换过来），返回内容。 */
async function waitCard(page, method, timeout = 15000) {
  await page.waitForFunction(({ selector, want }) => document.querySelector(`${selector} [data-testid="ext-ui-card"]`)
    ?.dataset.method === want, { selector: PANE, want: method }, { timeout });
  return cardView(page);
}

/**
 * @brief 发出扩展命令（"/mori-ask" 之类）。M6 起输入框以 "/" 开头时出"/"补全列表，列表只列提示词模板和技能，
 *        扩展命令不在里面（"No matching prompt templates or skills"）；列表开着时 Enter 不发送，Esc 先关闭列表（slash.md 状态表与表下说明）。
 *        所以先等列表读完，记下它的样子，按一次 Enter（应不发送），再按 Esc 关掉、按 Enter 发送。
 * @return 列表读完时的项数和文字，以及列表开着时按 Enter 之后列表还在不在、输入框里的字
 */
async function sendExtCommand(ctx, text) {
  const { page, h } = ctx;
  await h.textarea.fill(text);
  const menu = paneOf(page).getByTestId('slash-menu');
  await menu.waitFor({ timeout: 10000 });
  await page.waitForFunction((selector) => !document.querySelector(`${selector} [data-testid="slash-menu"]`)
    ?.textContent?.includes('Loading…'), PANE, { timeout: 10000 });
  const view = await menu.evaluate((el) => ({ options: el.querySelectorAll('[role="option"]').length,
    text: el.textContent?.trim() ?? '' }));
  // 列表里没有可选的项时 Enter 照常发送（slash.md，照 Claude 桌面版）：扩展命令直接发出，输入框清空、列表关闭。
  await h.textarea.press('Enter');
  const sent = { closed: await menu.count() === 0, draft: await h.textarea.inputValue() };
  return { ...view, sent };
}

/** @brief 让模型调用项目扩展的 tool：批准卡出来后 Alt+1 允许一次，等确认询问卡出现，返回内容。 */
async function askTool(ctx, tool) {
  const { page } = ctx;
  await ctx.h.send(`call tool: ${tool}`);
  const approval = paneOf(page).getByTestId('approval-card');
  await approval.waitFor({ timeout: 20000 });
  await ctx.h.textarea.press('Alt+1');
  await approval.waitFor({ state: 'detached', timeout: 10000 });
  return waitCard(page, 'confirm');
}

/** @brief 点询问卡上文字为 name 的按钮。 */
const clickCard = (page, name) => questionCard(page).getByRole('button', { name, exact: true }).click();

/** @brief 把还挂着的询问卡逐个答掉（确认点"No"，其余点"Cancel"），最多 count 张；返回答掉了几张。 */
async function cancelCards(page, count = 5) {
  let done = 0;
  while (done < count && await questionCard(page).count() > 0) {
    await questionCard(page).getByRole('button', { name: /^(No|Cancel)$/ }).first().click({ timeout: 3000 });
    done += 1;
    await sleep(400);
  }
  return done;
}

// ---------- 扩展的询问 ----------

/**
 * @brief 打开 eta（带询问用的项目扩展）并选"Trust workspace"（不记住）：扩展加载要 2.5 秒，这时会话行的菜单
 *        三项都不可用，小字"Opening…"；打开后扩展的三个工具都可用。
 */
async function extOpen(ctx) {
  const { page, record } = ctx;
  await clickOpenFolder(ctx, ctx.folders.eta);
  const dialog = page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  const opening = await paneOf(page).getByTestId('not-ready').innerText({ timeout: 1000 }).catch(() => '');
  const row = await composerRow(page);
  record('第一次打开中（"Starting…"）：输入框下面一行只有权限按钮（不可用：aria-disabled，悬停第二行和读屏的描述'
    + '"Starting…"），没有选择范围、Effort 和圆环（还没有过模型状态）；这一行高度不变（min-height 33px）',
  row?.notReady === ROW_REASONS.starting && blockedBy(row.permission, ROW_REASONS.starting) && !row.model
    && !row.thinking && !row.usage && Math.abs(row.height - 33) <= 1, JSON.stringify(row));
  const menu = await openMenuOn(page, page.locator('.session-item.active'));
  const items = await menuItems(menu);
  record('正在打开的会话（"正在启动…"）：菜单里重命名、归档、删除都不可用，旁边小字"正在打开"', opening === 'Starting…'
    && items.length === 3 && items.every((item) => item.disabled && item.hint === 'Opening…'),
  `按钮位置 ${opening}；菜单 ${menuText(items)}`);
  await noteSmallText(ctx, 'menu while opening');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 });
  await waitReady(page);
  ctx.files.E1 = await activeFile(page);
  const info = await liveInfo(page, ctx.files.E1);
  record('信任后项目扩展注册的询问工具都可用（project_ask、project_wait、project_once）', info.projectTrust === 'trusted'
    && ASK_TOOLS.every((name) => info.tools.includes(name)), JSON.stringify(info));
  const notices = await paneOf(page).getByTestId('ext-notify').allInnerTexts();
  const cards = await questionCard(page).count();
  record('会话打开过程中（session_start）：扩展的询问不出卡、按取消回给扩展，扩展的通知在打开后接在对话流里'
    + '（"扩展：startup confirm=false"）', sameList(notices, ['Extension: startup confirm=false']) && cards === 0,
  `通知 ${JSON.stringify(notices)}；询问卡 ${cards}`);
}

/**
 * @brief 关窗口前已经在等的扩展询问卡（window.md"关掉窗口"：等你回答的卡不停，界面状态原样）：project_once 的确认卡
 *        出来以后关掉窗口（藏进系统托盘），点托盘图标回来，卡还在（同一个询问）；点"Yes"照常作答，工具结果 once=true。
 *        等 300 毫秒让前面那张批准卡的提醒（mori:attention）先到主进程，再关窗口（窗口藏着时到的提醒会把它最小化）。
 */
async function extCloseWindow(ctx) {
  const { app, page, record } = ctx;
  const first = await askTool(ctx, 'project_once');
  await sleep(300);
  await recordBalloons(app);
  await closeWindow(app);
  const hidden = await waitWindow(app, offScreen, 5000);
  await findTray(app);
  await clickTrayIcon(app);
  const shown = await waitWindow(app, onScreen, 5000);
  // 点卡片之前界面要真的在出帧（Playwright 的点击要等元素两帧不动）：10 秒没有一帧时写明窗口与页面的状态，不在点击上
  // 干等 30 秒（2026-10-27 推送前回归：MD-15 第三遍里这里卡住，之后的扩展询问各步都失败，截图也取不到）
  const frame = await page.evaluate(() => new Promise((done) => {
    requestAnimationFrame(() => done(document.visibilityState));
    setTimeout(() => done(`no frame in 10 s (${document.visibilityState})`), 10000);
  }));
  if (frame !== 'visible') {
    const states = { hidden: hidden.state, shown: shown.state, frame };
    throw new Error(`no frames after the tray click: ${JSON.stringify(states)}`);
  }
  const back = await cardView(page);
  await clickCard(page, 'Yes');
  const gone = await questionCard(page).waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
  await waitIdle(page);
  const tool = await lastToolCard(page);
  record('关窗口前已经在等的扩展询问卡：关掉窗口、点托盘图标回来后卡还在（同一个询问"只问一次"），点"Yes"照常作答'
    + '（工具结果 once=true）', hidden.ok && shown.ok && first.title === '只问一次' && back?.request === first.request
    && gone && tool.status === 'done' && tool.body.includes('once=true'),
  `${JSON.stringify({ hidden: hidden.state, shown: shown.state, first: first.request, back: back?.request })}；`
    + `状态 ${tool.status}；${oneLine(tool.body)}`);
}

/** @brief 确认卡挂着时切到 A1：E1 的会话行显示"Needs input"；再切回来，卡还在。 */
async function hiddenQuestion(ctx) {
  const { page, record } = ctx;
  await openRow(page, ctx.files.A1);
  const shown = await waitStatus(page, ctx.files.E1, 'question', 5000);
  const row = await rowState(page, ctx.files.E1);
  record('状态：不可见的会话有挂起的扩展询问时显示"等你回答"（圆点加文字）', shown && row?.statusText === 'Needs input',
    JSON.stringify(row));
  await noteSmallText(ctx, 'status question');
  await openRow(page, ctx.files.E1);
  await questionCard(page).waitFor({ timeout: 5000 });
}

/**
 * @brief 步骤组的"进行中"（docs/v0/screens/chat.md"步骤组"，2026-10-26 走查 M18）：扩展的询问挂着时，那张"Running…"的
 *        project_ask 工具卡在进行中的组里照常显示，这一轮（最后一条你的消息之后）没有摘要行，那一组也没有。
 *        E1 前面几轮（extCloseWindow 的 project_once 等）已经结束、各自折成一行，那些行不算（earlier 只写进 detail）。
 */
async function askCardShown(ctx) {
  const { page, record } = ctx;
  const state = await stepsState(page);
  const card = paneOf(page).locator('[data-testid="tool-card"]').last();
  const group = await card.evaluate((element) => element.closest('[data-step-group]')?.dataset.stepGroup ?? '');
  const turn = await paneOf(page).getByTestId('transcript').evaluate((root, cardGroup) => {
    const users = root.querySelectorAll('[data-testid="user-message"]');
    const last = users[users.length - 1];
    const rows = [...root.querySelectorAll('[data-testid="step-group"]')];
    const after = (row) => Boolean(last && last.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
    const mine = (row) => row.dataset.group === cardGroup;
    return { turnRows: rows.filter(after).length, groupRows: rows.filter(mine).length };
  }, group);
  const look = { group, ...turn, earlier: state.rows.length - turn.turnRows,
    status: await card.getAttribute('data-status'), visible: await card.isVisible(),
    title: await card.locator('.tool-title').textContent() };
  record('步骤组：扩展的询问挂着时（project_ask 的卡 Running…）这一组在进行中，没有摘要行，那张卡看得见', Boolean(group)
    && look.turnRows === 0 && look.groupRows === 0 && look.status === 'running' && look.visible, JSON.stringify(look));
}

/** @brief project_ask：确认卡的内容、焦点、阶段行、Enter 不作答、不可见时的状态；点"Yes"、选"乙"、输入后 Enter。 */
async function extAnswer(ctx) {
  const { page, record } = ctx;
  const first = await askTool(ctx, 'project_ask');
  await sleep(300);
  const focus = await focusInfo(page);
  const stage = await stageOf(page);
  await askCardShown(ctx);
  record('询问卡（确认，data-method=confirm）：卡头"扩展的询问"、标题、说明原文、按钮"是""否"；出现时不抢输入框的焦点；'
    + '阶段行"等你回答"', first.method === 'confirm' && Boolean(first.request) && first.head === QUESTION_HEAD
    && first.title === '继续吗？' && first.message === '说明' && sameList(first.buttons, ['Yes', 'No'])
    && focus.composer && stage === WAITING_ANSWER, `${JSON.stringify(first)}；焦点 ${JSON.stringify(focus)}；阶段 ${stage}`);
  await ctx.shot(page, '15-ext-confirm');
  await ctx.h.textarea.press('Enter');
  await sleep(600);
  const still = await cardView(page);
  record('询问卡：没有默认按钮，输入框里按 Enter 不会作答（卡还在，同一个询问）', still?.request === first.request,
    JSON.stringify(still));
  await hiddenQuestion(ctx);
  await clickCard(page, 'Yes');
  const select = await waitCard(page, 'select');
  record('询问卡（选择）：点"是"作答后下一个询问接着出现；卡头、标题、每个选项一个按钮和"取消"',
    select.head === QUESTION_HEAD && select.title === '选一个' && sameList(select.buttons, ['甲', '乙', 'Cancel']),
    JSON.stringify(select));
  await clickCard(page, '乙');
  const input = await waitCard(page, 'input');
  record('询问卡（输入）：卡头、标题、显示提示文字的输入框、"确定"和"取消"', input.head === QUESTION_HEAD
    && input.title === '写点什么' && input.placeholder === '提示' && sameList(input.buttons, ['Submit', 'Cancel']),
  JSON.stringify(input));
  await ctx.shot(page, '16-ext-input');
  const box = questionCard(page).locator('input');
  await box.fill(ANSWER_TEXT);
  await box.press('Enter');
  await questionCard(page).waitFor({ state: 'detached', timeout: 5000 });
  await waitIdle(page);
  await extResult(ctx);
}

/** @brief project_ask 答完之后：通知一行、工具结果里是全部回答。 */
async function extResult(ctx) {
  const { page, record } = ctx;
  const notify = paneOf(page).getByTestId('ext-notify').last();
  const text = await notify.innerText({ timeout: 3000 }).catch(() => '');
  const classes = (await notify.getAttribute('class', { timeout: 3000 }).catch(() => '')) ?? '';
  record('通知：对话流里一行"扩展：ask done"，warning 用警示色（class 有 warning）', text === 'Extension: ask done'
    && classes.split(/\s+/).includes('warning'), `${text}；class ${classes}`);
  const tool = await lastToolCard(page);
  record('按钮作答、输入框里 Enter 确定：扩展收到全部回答（工具结果 confirm=true; select=乙; input=写的字）',
    tool.status === 'done' && tool.body.includes(`confirm=true; select=乙; input=${ANSWER_TEXT}`),
    `状态 ${tool.status}；${oneLine(tool.body)}`);
}

/** @brief 焦点在卡上时 Esc：确认等于"No"、选择和输入等于"Cancel"；不停止生成。 */
async function extEsc(ctx) {
  const { page, record } = ctx;
  const stopped = await stoppedCount(page);
  await askTool(ctx, 'project_ask');
  await questionCard(page).getByRole('button', { name: 'Yes', exact: true }).focus();
  await page.keyboard.press('Escape');
  await waitCard(page, 'select');
  await questionCard(page).getByRole('button', { name: '甲', exact: true }).focus();
  await page.keyboard.press('Escape');
  await waitCard(page, 'input');
  await questionCard(page).locator('input').focus();
  await page.keyboard.press('Escape');
  await questionCard(page).waitFor({ state: 'detached', timeout: 5000 });
  await waitIdle(page);
  const tool = await lastToolCard(page);
  const after = await stoppedCount(page);
  record('询问卡：焦点在卡上时 Esc，确认等于"否"、选择和输入等于取消（工具结果 confirm=false; select=(none); '
    + 'input=(none)），不停止生成', tool.status === 'done'
    && tool.body.includes('confirm=false; select=(none); input=(none)') && after === stopped,
  `状态 ${tool.status}；${oneLine(tool.body)}；"已停止" ${stopped} → ${after}`);
}

/** @brief project_wait：卡上"This request expires in N seconds"每秒刷新；到时卡消失，扩展收到"No"（false）。 */
async function extTimeout(ctx) {
  const { page, record } = ctx;
  const card = await askTool(ctx, 'project_wait');
  const shownAt = Date.now();
  const first = secondsOf(card.timeout);
  await sleep(1300);
  const later = secondsOf((await cardView(page))?.timeout);
  record('有超时的询问：卡上一行"N 秒后自动取消"，每秒刷新', card.title === '超时测试' && first !== null && first <= 3
    && later !== null && later < first, `${card.timeout} → ${later}`);
  await ctx.shot(page, '17-ext-timeout');
  const gone = await questionCard(page).waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false);
  const elapsed = Date.now() - shownAt;
  await waitIdle(page);
  const tool = await lastToolCard(page);
  record('有超时的询问：到时自动取消，卡消失，扩展收到"否"（工具结果 wait=false）', gone && elapsed >= 2000
    && tool.body.includes('wait=false'), `${elapsed} ms 后消失 ${gone}；${oneLine(tool.body)}`);
}

/** @brief project_once（只问一次）挂着时按"Stop"：询问按取消回给扩展，卡消失，本轮停止，后台进程里没有挂着的询问。 */
async function extStopOnce(ctx) {
  const { page, record } = ctx;
  const stopped = await stoppedCount(page);
  await askTool(ctx, 'project_once');
  await paneOf(page).locator('.stop-button').click();
  const gone = await questionCard(page).waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
  await waitIdle(page, 15000);
  const after = await stoppedCount(page);
  const { live } = await kernelOpen(page, ctx.files.E1);
  record('停止（"停止"按钮）：挂着的询问按取消回给扩展，卡消失，本轮停止（"已停止"），后台进程里没有挂着的询问', gone
    && after === stopped + 1 && live?.running === false && live?.questions?.length === 0,
  `卡消失 ${gone}；"已停止" ${stopped} → ${after}；live ${JSON.stringify(live)}`);
}

/**
 * @brief project_ask（确认之后还会接着问选择和输入，扩展没有把 signal 交给询问）的确认卡挂着时按"Stop"：
 *        卡消失、本轮停止，扩展接着问的不该再出卡把停止卡住。之后把剩下的卡答掉，让本轮结束。
 */
async function extStopChain(ctx) {
  const { page, record } = ctx;
  const stopped = await stoppedCount(page);
  const first = await askTool(ctx, 'project_ask');
  await paneOf(page).locator('.stop-button').click();
  const seen = [];
  const settled = await until(async () => {
    const view = await cardView(page);
    if (view && view.request !== first.request && !seen.includes(view.method)) seen.push(view.method);
    return !view && await paneOf(page).getAttribute('data-running') === 'false';
  }, 6000, 150);
  const stage = await stageOf(page);
  const { live } = await kernelOpen(page, ctx.files.E1);
  const kernel = { running: live?.running, questions: live?.questions?.map((item) => item.method) };
  await ctx.shot(page, '18-ext-stop-chain');
  const cancelled = settled ? 0 : await cancelCards(page);
  await waitIdle(page, 20000);
  const after = await stoppedCount(page);
  record('停止：扩展一个接一个地问（project_ask）时按"停止"，挂着的询问取消、卡消失、本轮停止；扩展接着问的不再出卡',
    settled && seen.length === 0 && after === stopped + 1, `6 秒内停下 ${settled}；停止后又出现的询问 `
    + `${JSON.stringify(seen)}；那时的阶段行 ${stage}，后台进程 ${JSON.stringify(kernel)}；`
    + `测试替你答掉 ${cancelled} 张后本轮才结束；"已停止" ${stopped} → ${after}`);
}

/**
 * @brief 扩展命令 /mori-ask（pi 交给扩展处理，不开始一轮运行）里的询问：卡照常出现，阶段行"Waiting for your answer"；
 *        答完后不停在"刚发出"。
 */
async function extCommand(ctx) {
  const { page, record } = ctx;
  const slash = await sendExtCommand(ctx, '/mori-ask');
  record('扩展命令（M6 起有"/"补全）：打出 "/mori-ask" 时列表里没有它（扩展命令不在列表里，只有一行说明）；'
    + '没有可选的项，Enter 照常发出，输入框清空（slash.md）', slash.options === 0
    && SLASH_NOTES.includes(slash.text)
    && slash.sent.closed && slash.sent.draft === '', JSON.stringify(slash));
  const card = await waitCard(page, 'confirm');
  const stage = await stageOf(page);
  const running = await paneOf(page).getAttribute('data-running');
  record('扩展命令里的询问（不经过一轮运行）：询问卡照常出现（"命令里问"），阶段行"等你回答"',
    card.title === '命令里问' && stage === WAITING_ANSWER && running === 'false',
    `${JSON.stringify(card)}；阶段 ${stage}；生成中 ${running}`);
  await clickCard(page, 'Yes');
  await questionCard(page).waitFor({ state: 'detached', timeout: 5000 });
  const ended = await until(async () => await paneOf(page).getAttribute('data-sending') === 'false', 5000);
  const notices = await paneOf(page).getByTestId('ext-notify').allInnerTexts();
  const row = await rowState(page, ctx.files.E1);
  record('扩展命令结束后不停在"刚发出"（会话行没有"生成中"）；扩展收到回答（"扩展：command confirm=true"）', ended
    && notices.at(-1) === 'Extension: command confirm=true' && row?.status === null,
  `刚发出已结束 ${ended}；最后的通知 ${notices.at(-1)}；行 ${JSON.stringify(row)}`);
}

/**
 * @brief 开着 opener 打开的浮层（权限菜单或圆环详情）时扩展的询问卡来了：发 /mori-late（2 秒后才问），马上点开 opener，
 *        等卡出现；返回浮层打开过没有、卡来了之后还在不在、焦点在哪个 data-testid 上，然后点"No"答掉。
 */
async function lateCardOver(ctx, opener, popup) {
  const { page } = ctx;
  await sendExtCommand(ctx, '/mori-late');
  await paneOf(page).getByTestId(opener).click();
  const opened = await page.getByTestId(popup).waitFor({ timeout: 1500 }).then(() => true, () => false);
  const card = await waitCard(page, 'confirm');
  const gone = await page.getByTestId(popup).waitFor({ state: 'detached', timeout: 3000 })
    .then(() => true, () => false);
  const focus = await page.evaluate(() => document.activeElement?.dataset?.testid ?? document.activeElement?.tagName);
  await clickCard(page, 'No');
  await questionCard(page).waitFor({ state: 'detached', timeout: 5000 });
  return { opened, title: card?.title, gone, focus };
}

/**
 * @brief 询问卡来了时关这一行的菜单（models.md"什么时候自动关"、composer-pickers-checks.md 第 27 条；批准卡的版本在
 *        m6-app-row）：开着权限菜单时扩展的询问卡来了，菜单关上、焦点回到权限按钮；开着圆环详情时同样关上、焦点回到圆环。
 */
async function extCardClosesRow(ctx) {
  const { record } = ctx;
  const menu = await lateCardOver(ctx, 'permission-button', 'permission-menu');
  const ring = await lateCardOver(ctx, 'usage', 'usage-details');
  record('询问卡来了时这一行的浮层关上：开着权限菜单时扩展命令的询问卡（"晚到的询问"）出现，菜单关上、焦点回到权限按钮；'
    + '开着圆环详情时同样关上、焦点回到圆环', menu.opened && menu.title === '晚到的询问' && menu.gone
    && menu.focus === 'permission-button' && ring.opened && ring.gone && ring.focus === 'usage',
  JSON.stringify({ menu, ring }));
}

// ---------- 界面重新加载 ----------

/** @brief 重新加载页面（与 Ctrl+R 相同），等会话列表读完。 */
async function reloadPage(page) {
  await page.reload();
  await page.getByTestId('session-tree').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.session-item').length > 0
    && !document.querySelector('[data-testid="session-tree"]')?.textContent?.includes('Loading sessions…'), null,
  { timeout: 20000 });
}

/** @brief 等当前会话最后一张工具卡的状态变成 status。 */
function waitLastTool(page, status, timeout = 10000) {
  return page.waitForFunction(({ selector, want }) => [...document.querySelectorAll(
    `${selector} [data-testid="tool-card"]`)].at(-1)?.dataset.status === want, { selector: PANE, want: status },
  { timeout }).then(() => true, () => false);
}

/** @brief 点会话行，等它就绪，再等一会儿看有没有弹信任询问；返回弹了几个询问框。 */
async function attachRow(page, file) {
  await rowOf(page, file).click();
  await waitReady(page);
  await sleep(600);
  return page.getByTestId('trust-dialog').count();
}

/**
 * @brief 界面重新加载前布好各会话：G1 开着、空闲；K 挂着批准卡；E1 挂着扩展询问；
 *        B2 命令执行中（"Allow “Run commands” for this session"）；
 *        C（在 B2 所在的 beta 里新建）9 秒后才要批准；G3 等 6 秒的回复并写了草稿；W（eta 里新建）的扩展命令 /mori-wait
 *        挂着带 15 秒超时的询问；A1 等 8 秒的回复（接上时还没开始回复）；N（alpha 里新建）还没发消息。
 *        然后重新加载页面（与 Ctrl+R 相同）。
 */
async function reloadSetup(ctx) {
  const { page, h } = ctx;
  const { A1, B2, E1, G1, G3, K } = ctx.files;
  ctx.live = {};
  await openRow(page, G1);
  ctx.live.G1 = (await kernelOpen(page, G1)).sessionId;
  await openRow(page, K);
  await h.send('run: echo reattach');
  await paneOf(page).getByTestId('approval-card').waitFor({ timeout: 20000 });
  await openRow(page, E1);
  await askTool(ctx, 'project_ask');
  await openRow(page, B2);
  await h.send(`run: sleep ${SLEEP_SECONDS} && echo slept`);
  const card = paneOf(page).getByTestId('approval-card');
  await card.waitFor({ timeout: 20000 });
  await h.textarea.press('Alt+2');
  await card.waitFor({ state: 'detached', timeout: 10000 });
  if (!(await waitLastTool(page, 'running'))) throw new Error('the sleep command did not start');
  ctx.files.C = await ctrlN(page);
  await h.send('wait 9s then run: echo late');
  await waitRunning(page);
  await openRow(page, G3);
  await h.send('wait 6s');
  await waitRunning(page);
  await h.textarea.fill(RELOAD_DRAFT);
  await openRow(page, E1);
  ctx.files.W = await ctrlN(page);
  await sendExtCommand(ctx, '/mori-wait');
  await waitCard(page, 'confirm');
  await openRow(page, A1);
  await h.send('wait 8s');
  await waitRunning(page);
  ctx.live.A1 = (await kernelOpen(page, A1)).sessionId;
  ctx.files.N = await ctrlN(page);
  await reloadPage(page);
}

/** @brief live 的状态：等你批准、等你回答、生成中、空闲；没有 live 时为 null。 */
const liveFlag = (live) => (!live ? null : live.approval ? 'approval' : live.question ? 'question'
  : live.running ? 'running' : 'idle');

/**
 * @brief 重新加载后：session.list 的 live、侧栏状态（G3 快要结束，不看它的行）、中栏没有会话、会话标识还在、
 *        生成中的会话不能归档删除。
 */
async function reloadSidebar(ctx) {
  const { page, record } = ctx;
  const { A1, G1, K, E1 } = ctx.files;
  const want = { A1: 'running', G3: 'running', B2: 'running', K: 'approval', E1: 'question', W: 'question',
    G1: 'idle' };
  const list = await page.evaluate(() => window.mori.request({ type: 'session.list' }));
  const live = Object.fromEntries(Object.keys(want).map((key) => [key,
    liveFlag(list.find((item) => samePath(item.sessionFile, ctx.files[key]))?.live)]));
  record('界面重新加载不停止会话：session.list 带回后台进程里还开着的会话的 live（A1、G3、B2 生成中，K 等你批准，'
    + 'E1、W 等你回答，G1 开着、空闲）', sameList(live, want), JSON.stringify(live));
  const rows = await allRows(page);
  const row = (file) => rows.find((item) => samePath(item.file, file));
  const keys = ['A1', 'B2', 'K', 'E1', 'G1'];
  const shown = Object.fromEntries(keys.map((key) => [key, row(ctx.files[key])?.status ?? null]));
  const panes = await paneCount(page);
  record('界面重新加载：侧栏为后台进程里开着的会话显示状态（A1、B2 生成中，K 等你批准，E1 等你回答，空闲的 G1 没有），'
    + '中栏还没有会话', sameList(shown, { A1: 'running', B2: 'running', K: 'approval', E1: 'question', G1: null })
    && row(A1)?.statusText === 'Running' && row(K)?.statusText === 'Needs approval'
    && row(E1)?.statusText === 'Needs input'
    && panes === 0, `${JSON.stringify(shown)}；会话面板 ${panes}`);
  record('界面重新加载不停止会话：原来的会话标识在后台进程里还在', !(await sessionGone(page, ctx.live.A1)), ctx.live.A1);
  await ctx.shot(page, '20-reload-sidebar');
  const menu = await openMenuByKey(page, A1);
  const items = await menuItems(menu);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 });
  record('界面重新加载后还在后台进程里生成的会话：菜单里"归档""删除"不可用，旁边小字"正在生成"', items.length === 3
    && items[1].disabled && items[1].hint === 'Still running' && items[2].disabled && items[2].hint === 'Still running',
  menuText(items));
}

/** @brief 接上 A1（等回复中）：不问信任，阶段行"Waiting for the model…"；回复接着流入并结束，没有被停止。 */
async function reloadReply(ctx) {
  const { page, record } = ctx;
  const trust = await attachRow(page, ctx.files.A1);
  const running = await paneOf(page).getAttribute('data-running');
  const stage = await stageOf(page);
  const stopped = await stoppedCount(page);
  record('接上后台进程里的会话（生成中、模型还没开始回复）：不问信任，阶段行"等待模型响应"', trust === 0
    && running === 'true' && stage.startsWith('Waiting for the model…'), `询问框 ${trust}；生成中 ${running}；阶段 ${stage}`);
  await ctx.shot(page, '21-reload-attached');
  await waitIdle(page, 30000);
  const reply = await lastReply(page);
  const users = await paneOf(page).getByTestId('user-message').allInnerTexts();
  const sent = users.filter((text) => text === 'wait 8s').length;
  const after = await stoppedCount(page);
  record('界面重新加载没有停止生成：接上后回复照常流入并结束（"等了 8 秒"），没有"已停止"，你的消息只有一条',
    reply.includes('等了 8 秒') && after === stopped && sent === 1,
    `回复 ${oneLine(reply, 60)}；"已停止" ${stopped} → ${after}；"wait 8s" ${sent} 条`);
}

/** @brief 接上 B2（命令执行中）：不问信任，正在执行的工具卡是"Running…"；"Allowed for this session"还在。 */
async function reloadCommand(ctx) {
  const { page, record } = ctx;
  const trust = await attachRow(page, ctx.files.B2);
  const tool = await waitLastTool(page, 'running', 3000);
  const label = await paneOf(page).getByTestId('tool-card').last().getByTestId('tool-status').innerText()
    .catch(() => '');
  const stage = await stageOf(page);
  const { approval } = await kernelOpen(page, ctx.files.B2);
  record('接上后台进程里的会话（命令执行中）：不问信任，正在执行的工具卡是"执行中"；"本会话已允许"还在（bash）',
    trust === 0 && tool && approval?.allowed?.includes('bash'), `询问框 ${trust}；工具卡 ${tool} ${label}；`
    + `阶段 ${stage}；${JSON.stringify(approval)}`);
}

/**
 * @brief C 在界面重新加载后、还没接上时才要批准：会话行随事件显示"Needs approval"；接上后批准卡照常出现，
 *        允许后命令执行完成。
 */
async function reloadLate(ctx) {
  const { page, record } = ctx;
  const { C } = ctx.files;
  const shown = await waitStatus(page, C, 'approval', 20000);
  const row = await rowState(page, C);
  record('界面重新加载后还没接上的会话之后才要批准：会话行随事件显示"等你批准"', shown
    && row?.statusText === 'Needs approval', JSON.stringify(row));
  const trust = await attachRow(page, C);
  const card = paneOf(page).getByTestId('approval-card');
  const ok = await card.waitFor({ timeout: 5000 }).then(() => true, () => false);
  await ctx.h.textarea.press('Alt+1');
  await card.waitFor({ state: 'detached', timeout: 10000 });
  await waitIdle(page, 30000);
  const result = await lastToolCard(page);
  record('接上之后才来的批准请求：不问信任，批准卡照常出现，允许后命令执行完成（结果里有 late）', trust === 0 && ok
    && result.status === 'done' && result.body.includes('late'), `询问框 ${trust}；卡 ${ok}；状态 ${result.status}；`
    + oneLine(result.body));
}

/**
 * @brief N（重新加载前新建、还没发消息）：侧栏里还在（"New session"），菜单里"Archive"不可用；点开接上后台进程里
 *        原来那个，不问信任、不多出会话。
 */
async function reloadUnsaved(ctx) {
  const { page, record } = ctx;
  const { N } = ctx.files;
  const row = await rowState(page, N);
  const menu = await openMenuByKey(page, N);
  const items = await menuItems(menu);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 });
  record('界面重新加载：本次新建、还没发消息的会话（后台进程里还开着）也在侧栏（"新会话"），菜单里"归档"不可用，'
    + '小字"还没有消息"', row?.title === 'New session' && items[1]?.disabled && items[1]?.hint === 'No messages yet',
  `行 ${JSON.stringify(row)}；菜单 ${menuText(items)}`);
  const before = (await allRows(page)).length;
  const trust = await attachRow(page, N);
  const active = await activeFile(page);
  const after = (await allRows(page)).length;
  record('点开还没发消息的会话：接上后台进程里原来那个（当前会话还是这个会话文件），不问信任，不多出会话',
    trust === 0 && samePath(active, N) && after === before, `询问框 ${trust}；当前 ${active}；行数 ${before} → ${after}`);
}

/**
 * @brief W 的扩展命令在没接上时结束（询问超时，pi 没有开始一轮运行，只有 prompt 结束）：会话行的"Needs input"
 *        消失，不停在"Running"，可以删除（命令不写消息，它还是没有消息的会话，"Archive"不可用）。
 */
async function reloadCommandEnd(ctx) {
  const { page, record } = ctx;
  const { W } = ctx.files;
  const ended = await waitStatus(page, W, null, 25000);
  const row = await rowState(page, W);
  const menu = await openMenuByKey(page, W);
  const items = await menuItems(menu);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 });
  record('界面重新加载后还没接上的会话里扩展命令结束（没有开始运行）：会话行的"等你回答"消失、不停在"生成中"，'
    + '可以删除（还没有消息，"归档"不可用）', ended && row?.status === null && items[1]?.hint === 'No messages yet'
    && !items[2]?.disabled,
  `行 ${JSON.stringify(row)}；菜单 ${menuText(items)}`);
}

/** @brief 已归档列表里会话行的状态（没有状态的为 null）。 */
const archivedStatuses = (page) => page.evaluate(() => [...document.querySelectorAll(
  '[data-testid="archived-list"] .session-item')].map((row) => row.querySelector('[data-testid="session-status"]')
  ?.dataset.status ?? null));

/**
 * @brief G3 的回复在没接上时结束：侧栏的"Running"换成"Unread"，可以归档删除；归档、恢复后"Unread"不跟着走；
 *        点开后草稿和回复都在。
 */
async function reloadStale(ctx) {
  const { page, record } = ctx;
  const { G3 } = ctx.files;
  const ended = await until(async () => (await kernelOpen(page, G3)).live?.running === false, 10000);
  await sleep(500);
  const row = await rowState(page, G3);
  const menu = await openMenuByKey(page, G3);
  const items = await menuItems(menu);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 });
  record('界面重新加载后，后台进程里还没接上的会话本轮结束时，侧栏的"生成中"换成"有新结果"，可以归档和删除',
    ended && row?.status === 'unseen' && row.statusText === 'Unread' && items.length === 3 && !items[1].disabled
    && !items[2].disabled, `后台进程里本轮已结束 ${ended}；行状态 ${row?.status} ${row?.statusText}；`
    + `菜单 ${menuText(items)}`);
  await chooseMenuItem(page, G3, 'Archive');
  await waitArchivedToggle(page, 'Archived 1');
  await expandArchived(page);
  const shelved = await archivedStatuses(page);
  const { menu: shelf } = await openMenuByMouse(page, G3);
  await shelf.getByRole('menuitem', { name: 'Unarchive' }).click();
  const back = await until(() => rowState(page, G3), 5000);
  record('归档还没点开、"有新结果"的会话：已归档列表里它没有状态；恢复后回到项目下也没有（会话已关闭，状态不跟着走）',
    sameList(shelved, [null]) && back?.status === null, `已归档 ${JSON.stringify(shelved)}；恢复后 ${JSON.stringify(back)}`);
  await openRow(page, G3);
  const draft = await ctx.h.textarea.inputValue();
  const reply = await lastReply(page);
  const after = await rowState(page, G3);
  record('界面重新加载：草稿还在（存在本机）；没接上时结束的回复在会话里（"等了 6 秒"）；点开后"有新结果"消失',
    draft === RELOAD_DRAFT && reply.includes('等了 6 秒') && after?.status === null,
    `草稿 ${draft}；回复 ${oneLine(reply, 60)}；行 ${JSON.stringify(after)}`);
}

/** @brief 接上 K（挂着批准卡）：不问信任，批准卡照常出现；Alt+1 后命令执行完成。 */
async function reloadApproval(ctx) {
  const { page, record } = ctx;
  const trust = await attachRow(page, ctx.files.K);
  const card = paneOf(page).getByTestId('approval-card');
  const shown = await card.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const tool = await card.getAttribute('data-tool', { timeout: 2000 }).catch(() => null);
  const stage = await stageOf(page);
  record('接上挂着批准卡的会话：不问信任，批准卡照常出现（bash），阶段行"等你批准"', trust === 0 && shown
    && tool === 'bash' && stage === 'Waiting for your approval', `询问框 ${trust}；卡 ${shown} ${tool}；阶段 ${stage}`);
  await ctx.h.textarea.press('Alt+1');
  await card.waitFor({ state: 'detached', timeout: 10000 });
  await waitIdle(page, 30000);
  const result = await lastToolCard(page);
  record('接上后按 Alt+1 允许：命令执行完成，结果里有 reattach', result.status === 'done'
    && result.body.includes('reattach'), `状态 ${result.status}；${oneLine(result.body)}`);
}

/**
 * @brief 接上 E1（挂着扩展询问；eta 本次信任过但没记住，界面重新加载后回答已清空，所以不问信任只能是因为接上）：
 *        询问卡照常出现并能作答；之后在同一个文件夹新建会话会再问。
 */
async function reloadQuestion(ctx) {
  const { page, record } = ctx;
  const trust = await attachRow(page, ctx.files.E1);
  const shown = await questionCard(page).waitFor({ timeout: 5000 }).then(() => true, () => false);
  const view = shown ? await cardView(page) : null;
  const stage = await stageOf(page);
  const notices = await paneOf(page).getByTestId('ext-notify').allInnerTexts();
  record('接上挂着扩展询问的会话：不问信任，询问卡照常出现（确认"继续吗？"），阶段行"等你回答"；打开时的通知不再接到'
    + '对话流末尾', trust === 0 && view?.method === 'confirm' && view.title === '继续吗？' && stage === WAITING_ANSWER
    && notices.length === 0, `询问框 ${trust}；${JSON.stringify(view)}；阶段 ${stage}；通知 ${JSON.stringify(notices)}`);
  await clickCard(page, 'Yes');
  await waitCard(page, 'select');
  await clickCard(page, '甲');
  await waitCard(page, 'input');
  const box = questionCard(page).locator('input');
  await box.fill('接上了');
  await box.press('Enter');
  await questionCard(page).waitFor({ state: 'detached', timeout: 5000 });
  await waitIdle(page);
  const result = await lastToolCard(page);
  record('接上后照常作答：扩展收到回答（工具结果 confirm=true; select=甲; input=接上了）', result.status === 'done'
    && result.body.includes('confirm=true; select=甲; input=接上了'), `状态 ${result.status}；${oneLine(result.body)}`);
  const before = await paneCount(page);
  await page.keyboard.press('Control+n');
  await waitPanes(page, before + 1);
  const asked = await page.getByTestId('trust-dialog').waitFor({ timeout: 10000 }).then(() => true, () => false);
  if (asked) await page.keyboard.press('Escape');
  await waitReady(page);
  record('界面重新加载后本次运行里信任询问的回答清空：在同一个文件夹（eta）新建会话会再问', asked);
}

/** @brief 回到 B2：接上时正在执行的命令照常执行完成。 */
async function reloadTool(ctx) {
  const { page, record } = ctx;
  await openRow(page, ctx.files.B2);
  await waitIdle(page, 30000);
  const result = await lastToolCard(page);
  record('接上时正在执行的命令照常执行完成（结果里有 slept）', result.status === 'done' && result.body.includes('slept'),
    `状态 ${result.status}；${oneLine(result.body)}`);
}

/** @brief 归档界面重新加载前开着、还没接上的空闲会话 G1：后台进程关闭它，行移到"Archived 1"；再恢复回来。 */
async function reloadArchive(ctx) {
  const { page, record } = ctx;
  const { G1 } = ctx.files;
  const row = await rowState(page, G1);
  await chooseMenuItem(page, G1, 'Archive');
  const moved = await waitArchivedToggle(page, 'Archived 1');
  const gone = await until(() => sessionGone(page, ctx.live.G1), 5000);
  record('界面重新加载后归档后台进程里开着、还没接上的空闲会话：按会话列表带回的会话标识在后台进程里关闭它'
    + '（原来的标识报 Unknown session），行移到"已归档"', row?.status === null && moved && gone
    && !(await rowState(page, G1)), `行 ${JSON.stringify(row)}；${JSON.stringify(await archivedState(page))}；关闭 ${gone}`);
  await expandArchived(page);
  const { menu } = await openMenuByMouse(page, G1);
  await menu.getByRole('menuitem', { name: 'Unarchive' }).click();
  await until(() => rowState(page, G1), 5000);
}

/** @brief 同时对一个还没打开的会话文件（G1）发两次 session.open：后台进程只打开一次，两次得到同一个会话；然后关闭它。 */
async function kernelDoubleOpen(ctx) {
  const { page, record } = ctx;
  const ids = await page.evaluate(async (sessionFile) => {
    const open = () => window.mori.request({ type: 'session.open', sessionFile });
    const results = await Promise.all([open(), open()]);
    await window.mori.request({ type: 'session.close', sessionId: results[0].sessionId });
    return results.map((item) => item.sessionId);
  }, ctx.files.G1);
  record('同一个会话文件同时打开两次：后台进程只打开一次，两次得到同一个会话（同一个会话文件不会有两个写入者）',
    ids.length === 2 && ids[0] === ids[1], JSON.stringify(ids));
}

/**
 * @brief 删除排在最下面的会话行，这时"Archived 1"收起、里面有会话（G1）：焦点移到屏幕上它上面的那一行，
 *        不落到收起的已归档会话上。
 */
async function focusAfterRemoval(ctx) {
  const { page, record } = ctx;
  await chooseMenuItem(page, ctx.files.G1, 'Archive');
  await waitArchivedToggle(page, 'Archived 1');
  if ((await archivedState(page)).expanded) await page.getByTestId('archived-toggle').click();
  const rows = await allRows(page);
  const last = rows.at(-1);
  const want = rows.at(-2)?.id ?? null;
  const dialog = await startDelete(page, last.file);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  const focus = await until(async () => {
    const info = await focusInfo(page);
    return info.row === want ? info : null;
  }, 2000) || await focusInfo(page);
  record('删除排在最下面的会话行（"已归档"收起、里面有会话）：焦点移到屏幕上它上面的那一行', focus.row === want,
    `应为 ${want}；焦点 ${JSON.stringify(focus)}；已归档 ${JSON.stringify(await archivedState(page))}`);
  await expandArchived(page);
  const { menu } = await openMenuByMouse(page, ctx.files.G1);
  await menu.getByRole('menuitem', { name: 'Unarchive' }).click();
  await until(() => rowState(page, ctx.files.G1), 5000);
}

/**
 * @brief A1 生成中时重新加载页面，还没接上时后台进程意外退出：会话行从"Running"变为"Error"；点开、"Restart"后
 *        重新打开成功，"Error"消失。
 */
async function reloadKernelExit(ctx) {
  const { page, record } = ctx;
  const { A1 } = ctx.files;
  await openRow(page, A1);
  await ctx.h.send('wait 8s');
  await waitRunning(page);
  await reloadPage(page);
  const running = await waitStatus(page, A1, 'running', 10000);
  killKernel(ctx.app);
  const error = await waitStatus(page, A1, 'error', 10000);
  record('界面重新加载后还没接上的会话在生成时后台进程意外退出：会话行从"生成中"变为"出错"', running && error,
    JSON.stringify(await rowState(page, A1)));
  await rowOf(page, A1).click();
  await paneOf(page).getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  await paneOf(page).getByRole('button', { name: 'Restart' }).click();
  const cleared = await waitStatus(page, A1, null, 30000);
  await waitReady(page);
  record('点开、重新载入后这个会话重新打开成功，"出错"消失', cleared, JSON.stringify(await rowState(page, A1)));
}

/** 由 m3-app.mjs 依次调用的步骤（顺序即执行顺序） */
export const liveSteps = {
  extOpen, extCloseWindow, extAnswer, extEsc, extTimeout, extStopOnce, extStopChain, extCommand, extCardClosesRow,
  reloadSetup, reloadSidebar, reloadReply, reloadLate, reloadUnsaved, reloadCommand, reloadCommandEnd, reloadStale,
  reloadApproval, reloadQuestion, reloadTool, reloadArchive, kernelDoubleOpen, focusAfterRemoval, reloadKernelExit,
};
