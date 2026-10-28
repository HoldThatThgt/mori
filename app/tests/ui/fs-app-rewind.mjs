// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-rewind：消息上的 Rewind、冲突、恢复代码与对话、
// Undo、进行中与操作记录、Rewind 后再记一次选择范围。真正的 Mori（界面 + 后台进程 + pi + 主进程 + 真实的 git）对合成端点
// （tests/fake-endpoint/server.mjs，synthetic：关键词模式、脚本 fs-git），逐条验收这些编号在 App 层的通过条件：
//   FS-15 Rewind 菜单（fs-rewind.md 的四种情况；排队、插话的消息 No code restore；运行中、只有后台实例在运行、有消息在
//   判断时不可点，悬停 Still running；没装 git（MORI_GIT_PATH）没有 Rewind；[Mori] 投递没有 Rewind；键盘）、
//   FS-16 冲突（你在磁盘上改过的文件 changed、同一文件夹另一个会话同时运行时改的 overlap；Overwrite / Skip these files /
//   Cancel；默认焦点 Cancel；第二次调用中 Restoring…；两次调用之间冲突又变了时换成新的列表）、
//   FS-17 恢复代码（改过、删掉的文件回来，新建的被删，你自己的文件不动，项目仓库的 index、HEAD、分支不变；通知）、
//   FS-18 恢复对话（对话按新分支显示，文字与引用芯片回到输入框、在草稿之前；第一条消息上恢复后对话为空；TaskBoard 不变；
//   需求还开着时两个恢复对话的选项不可选、原文正确、后台进程同样拒绝，Restore code 仍可用；后台进程在一条消息的运行中途
//   没了、重新启动之后这条消息恰是叶子：菜单按没有 code restore，恢复对话按 §5.8 导航到它的父条目）、
//   FS-19 Undo（文件回到 Rewind 之前、回到原来的分支；Rewind 之后改过的文件进冲突；发消息、再 Rewind 之后没有 Undo；只恢复
//   对话的没有 Undo；没有 Redo；界面重新载入后相同；没装 git 时没有 Undo）、
//   FS-24 进行中与操作记录（Rewinding… / Undoing… 在对话流末尾，发送按钮不可用、悬停同一句；这时 session.prompt 与第二个
//   rewind 被拒绝、原文正确；操作记录 Refresh changes、Rewind: <菜单项>、Rewind conflicts: …、Undo rewind）、
//   FS-25 Rewind 后再记一次 mori.pick（两个会话分别 Restore conversation 与 Restore code and conversation，新分支末尾、
//   mori.rewind 之前是范围 B；两个会话都还在新分支上时关闭重开，范围是 B；之后 Undo 回到原来的分支同样；只恢复代码不写）。
// 依据：file-system.md §4.5–§4.6、§5.5–§5.11、§12、§17，屏幕表 docs/v1/screens/fs-rewind.md、fs-changes.md，
// docs/v1/fs-checks.md "负责人不在时定下的选择"。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-rewind.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-rewind(-packaged).json（--only 时 fs-partial-app-rewind…，不计入覆盖检查），截图与 app.log
// 在 test-results/fs-app-rewind/。端口：合成端点 5012，记录代理 5013（fs-helpers FS_PORTS.rewind）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商 fsp（模型 fake-fs，fs-helpers seedFsUserData）；
// 临时目录 ROOT 下每段流程一个项目（restore 是 git 仓库并提交过一次，split 有分开配置的角色文件并被信任，其余是普通文件夹，
// 快照用 Mori 的内部仓库，不要求项目是 git 仓库）；快照目录另建（MORI_SNAPSHOTS_DIR）。启动后先 away.set never。
// 最后三步重新启动 App：leafCrash 结束整棵进程树再启动，picks 有序关闭再启动，noGit 用同一个数据目录另起一次 App，
// MORI_GIT_PATH 指向临时目录里不存在的 git.exe（§3.2 第 0 步）。步骤抛错时先关掉盖住窗口的对话框与菜单（guarded）。
// 全部通过时删掉临时目录（项目、数据目录、快照目录）；有失败时留着并打印路径。

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GIT_SCENARIO, gitMessage, gitOpenRequest, gitStep, keywordSteps,
} from '../fake-endpoint/scenarios/fs-git.mjs';
import {
  brief, errorLine, fsArgs, fsProject, fsRecorder, fsRoot, fsUserData, liveInfo, openFsSession, paneState, poll,
  readText, reopenFs, runSuite, same, seedFsUserData, sendFs, setPermission, shotFs, startFsEndpoint, waitIdleFs,
} from './fs-helpers.mjs';
import {
  MENU, NOTICE_TEXT, REWIND_TEXT as T, blockedText, branchOf, branchTail, choosePick, chooseRewind,
  clickDisabledRewind, clickRewindItem, clickUndo, closeRewindOverlays, composerOf, conflictsDialog, customEntries,
  dialogGone, expandNotice, fileCount, focusInfo, gitOut, killRestartRewindApp, lastRewindEntry, menuDisabled,
  menuGone, menuLines, menuOf, menuShape, missingActions, noticesOf, openChanges, openRewindMenu, pendingSeen,
  pickBeforeRewind, pickCount, pickOf, recentActivity, refreshChanges, reloadRewindUi, repoState, resolveConflict,
  restartRewindApp, rewindButtonCount, rewindButtonOf, rewindStates, sendButtonOf, sendTurn, sessionEntries, setDraft,
  startRewindApp, tabToRewind, textCount, turnRecords, waitEntry, waitGitMissing, waitRewindOutcome, waitRun,
  waitRunning, wakeIds, walkKeys,
} from './fs-rewind-helpers.mjs';
import {
  SPLIT_ROLES, boardViewOf, modelButtonSel, quoteReply, sendMessage, showTab, waitReceipt, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';

const args = fsArgs('rewind');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面（synthetic）；名字短，内部仓库的路径 = 快照目录 + 工作路径的编码 */
const ROOT = fsRoot('mori-fs-rw-');
/** 普通文件夹的项目（每段流程一个） */
const PLAIN_PROJECTS = ['menu', 'bg', 'split', 'chg', 'ov', 'conv', 'open', 'undo', 'prog', 'leaf', 'pick1', 'pick2',
  'nogit'];
/** fsProject 写下的 README.md 与 src/a.ts（恢复后要回到它们） */
const README_TEXT = '# Mori fixture project\n\nSynthetic project for the file system tests.\n';
const A_TS_TEXT = 'export const a = 1;\n';
/** 范围 B（FS-25）：提供商 fsp 下的模型 fake-fs；范围 A 是默认的提供商 fsp */
const PICK_B = 'fsp/fake-fs';

/** FS-15 菜单会话的消息（关键词模式，synthetic）；m2、m5 推迟回复，好在它们运行中插话、排队 */
const MENU_TEXT = Object.freeze({
  m1: gitStep.write('m1.txt', 'one'), m2: 'wait 12s', steer: gitStep.write('steer.txt', 'steered'),
  queue: gitStep.write('queue.txt', 'queued'), m3: gitStep.write('m3.txt', 'three'), m4: 'plain fs15 text only',
  m5: 'wait 9s', q2: 'plain fs15 queued two',
});
/** 只有后台实例在运行（脚本 fs-git：task 实例推迟 15 秒再跑命令）；认这条消息的文字 */
const BG_MESSAGE = gitMessage([['git-task', [gitStep.hold(15000, gitStep.run('echo bg > bg.txt'))]]]);
const BG_MARK = 'git-task: [wait 15000]';
/** 分开配置下的两条消息：第二条让 planner 判断 12 秒 */
const SPLIT_FIRST = `fs15 split first\n${GIT_SCENARIO}`;
const SPLIT_SECOND = `fs15 split second\n${gitMessage([['git-create', gitStep.hold(12000, gitStep.say('Judged.'))]])}`;
/** FS-16：第二轮改 c.txt、新建 e.txt；overlap 会话 A 写完 a.txt 后还跑 12 秒 */
const CHG_M2 = keywordSteps(gitStep.write('c.txt', 'two'), gitStep.write('e.txt', 'extra'), gitStep.say('M2 done'));
const OV_A = keywordSteps(gitStep.write('a.txt', 'A1'), gitStep.hold(12000, gitStep.write('a2.txt', 'A2')),
  gitStep.say('A done'));
/** FS-17：改一个已提交的文件、删一个、新建一个 */
const RESTORE_M1 = keywordSteps(gitStep.write('src/a.ts', 'changed by fs17'), gitStep.remove('README.md'),
  gitStep.write('notes/created.txt', 'created by fs17'), gitStep.say('M1 done'));
/** FS-18：只回文字的三轮（第一轮的回复用来做引用芯片）与输入框里的草稿 */
const CONV = Object.freeze({
  quote: 'Alpha reply for the fs18 quote', m2: 'plain fs18 second message', m3: 'plain fs18 third message',
  draft: 'my draft fs18',
});
const CONV_M1 = keywordSteps(gitStep.say(CONV.quote));
/** FS-19：两轮都改 u1.txt，第二轮另建 u2.txt；第三轮只回文字 */
const UNDO_M2 = keywordSteps(gitStep.write('u1.txt', 'second'), gitStep.write('u2.txt', 'two'),
  gitStep.say('M2 done'));
const UNDO_M3 = 'plain fs19 after';
/** FS-24：被恢复的一轮建 1500 个文件，Rewinding… / Undoing… 停留几秒；输入框里的草稿 */
const PROG_M1 = keywordSteps(gitStep.many('big', 1500), gitStep.write('t1.txt', 'one'), gitStep.say('M1 done'));
const PROG_DRAFT = 'fs24 draft while rewinding';
/** FS-18 叶子：第一轮写一个文件；第二轮的回复推迟 25 秒，期间结束整个 Mori（synthetic） */
const LEAF = Object.freeze({ m1: gitStep.write('leaf1.txt', 'one'), m2: 'fs18 leaf message, wait 25s' });

// ---------- 准备 ----------

/** @brief 合成端点、项目、数据目录（synthetic test setup），启动 App 并设 away never。 */
async function setup(ctx) {
  ctx.p = Object.fromEntries(PLAIN_PROJECTS.map((name) => [name, fsProject(ROOT, name)]));
  ctx.p.restore = fsProject(ROOT, 'restore', { git: true });
  writeRoles(ctx.p.split, SPLIT_ROLES);
  ctx.ep = await startFsEndpoint('rewind');
  seedFsUserData(ctx, { trusted: [ctx.p.split] });
  await startRewindApp(ctx);
}

/** @brief 在 project 里开一个新会话并切到 Full access（工作路径里的写入、命令不出卡）。 */
async function fullSession(ctx, project, opts = {}) {
  const who = await openFsSession(ctx, project, opts);
  await setPermission(ctx, who.tab, 'full');
  return who;
}

/** @brief 最后一条通知；没有时为 null。 */
const lastNotice = async (ctx, tab) => (await noticesOf(ctx, tab)).at(-1) ?? null;

/** @brief 项目里一个文件的路径。 */
const fileIn = (ctx, project, name) => join(ctx.p[project], name);

/** @brief 在这个会话的输入框里按一个键（Esc 停止运行）。 */
async function pressInComposer(ctx, tab, key) {
  await showTab(ctx, tab);
  await ctx.page.locator(`[data-testid="chat-pane"][data-tab="${tab}"] .composer textarea`).focus();
  await ctx.page.keyboard.press(key);
}

/**
 * @brief 页面里直接发命令，返回每条的结果：accepted 或失败的原文（依次发，后一条在前一条返回之后）。
 * @param commands 命令（不含 sessionId，由 who 补上）
 */
function requestsFromPage(ctx, who, commands) {
  return ctx.page.evaluate(async ({ sessionId, list }) => {
    const results = [];
    for (const command of list) {
      results.push(await window.mori.request({ ...command, sessionId }).then(() => 'accepted',
        (error) => String(error?.message ?? error)));
    }
    return results;
  }, { sessionId: who.sessionId, list: commands });
}

/**
 * @brief 页面里同时发 session.prompt 与 second（Rewind / Undo 刚开始时调用：后台进程按收到的先后处理，两条都在那次
 *        Rewind 之后到），返回两条的结果（accepted 或失败的原文）。
 */
function refuseDuring(ctx, who, second) {
  return ctx.page.evaluate(async ({ sessionId, command }) => {
    const reason = (promise) => promise.then(() => 'accepted', (error) => String(error?.message ?? error));
    return Promise.all([
      reason(window.mori.request({ type: 'session.prompt', sessionId, text: 'fs24 sent while rewinding' })),
      reason(window.mori.request({ ...command, sessionId })),
    ]);
  }, { sessionId: who.sessionId, command: second });
}

// ---------- FS-15：菜单的四种情况、运行中 ----------

/**
 * @brief 测试准备的前提：下一条消息（插话、排队）要在 run 那次推迟的运行里发出。那次运行已经结束时它会成为普通的一轮、
 *        有自己的 run 记录，菜单的检查就不成立了：这时抛错，说明是准备没做成。
 */
async function mustBeRunning(ctx, who, run, next) {
  if ((await paneState(ctx.page, who.tab))?.running === true) return;
  throw new Error(`the "${run}" run ended before the ${next} was sent (test setup timing)`);
}

/**
 * @brief M2（wait 12s）运行中：M1 上的 Rewind 不可点、悬停 Still running、点了不开菜单；这时插话（Ctrl+Enter）一条、
 *        排队（Enter）一条。返回 M2、插话、排队三条消息的条目 id。
 */
async function runningTurn(ctx, who, m1) {
  await sendFs(ctx, who, MENU_TEXT.m2, { wait: false });
  if (!(await waitRunning(ctx, who.tab))) throw new Error(`the "${MENU_TEXT.m2}" run did not start`);
  const during = await rewindButtonOf(ctx, who.tab, m1);
  const opened = during ? await clickDisabledRewind(ctx, who.tab, m1) : null;
  record('FS-15 while the conversation is running, Rewind on an earlier message is aria-disabled with the hover '
    + '"Still running" and clicking it opens no menu', during?.disabled === true
    && during.title === T.stillRunning && opened === false, brief({ during, opened }));
  await mustBeRunning(ctx, who, MENU_TEXT.m2, 'steer');
  await sendMessage(ctx, who.tab, MENU_TEXT.steer, { key: 'Control+Enter' });
  await mustBeRunning(ctx, who, MENU_TEXT.m2, 'queued message');
  await sendMessage(ctx, who.tab, MENU_TEXT.queue);
  await waitIdleFs(ctx, who.tab, 120000);
  const m2 = await waitEntry(who, MENU_TEXT.m2);
  if (!(await waitRun(who.sessionFile, m2, { changes: true }))) {
    throw new Error(`no records for the "${MENU_TEXT.m2}" run`);
  }
  return { m2, steer: await waitEntry(who, MENU_TEXT.steer), queue: await waitEntry(who, MENU_TEXT.queue) };
}

/** @brief M5（wait 9s）运行中排队一条只回文字的消息 Q2（之后没有任何改动）。返回两条的条目 id。 */
async function queuedTail(ctx, who) {
  await sendFs(ctx, who, MENU_TEXT.m5, { wait: false });
  if (!(await waitRunning(ctx, who.tab))) throw new Error(`the "${MENU_TEXT.m5}" run did not start`);
  await mustBeRunning(ctx, who, MENU_TEXT.m5, 'queued message Q2');
  await sendMessage(ctx, who.tab, MENU_TEXT.q2);
  await waitIdleFs(ctx, who.tab, 90000);
  const m5 = await waitEntry(who, MENU_TEXT.m5);
  if (!(await waitRun(who.sessionFile, m5))) throw new Error(`no run record for the "${MENU_TEXT.m5}" run`);
  return { m5, q2: await waitEntry(who, MENU_TEXT.q2) };
}

/** @brief 平时的按钮：文字 Rewind、悬停 Rewind to before this message；不悬停时看不见，悬停在消息上时看得见。 */
async function idleButton(ctx, who, entry) {
  const pane = `[data-testid="chat-pane"][data-tab="${who.tab}"]`;
  await ctx.page.locator(`${pane} .composer textarea`).focus();
  await ctx.page.locator(`${pane} .composer textarea`).hover();
  const away = await rewindButtonOf(ctx, who.tab, entry);
  const item = ctx.page.locator(`${pane} [data-item="user"]`)
    .filter({ has: ctx.page.locator(`[data-testid="rewind-button"][data-entry="${entry}"]`) });
  await item.scrollIntoViewIfNeeded();
  await item.hover();
  const hovered = await poll(async () => {
    const state = await rewindButtonOf(ctx, who.tab, entry);
    return state?.opacity === '1' ? state : null;
  }, 2000, 100);
  record('FS-15 when the session is idle the text button "Rewind" (hover "Rewind to before this message") is hidden '
    + 'until you hover the message, and shows when you do', away?.disabled === false && away.text === 'Rewind'
    && away.title === T.title && away.opacity === '0' && hovered !== null, brief({ away, hovered }));
}

/** @brief 菜单的四种情况（§5.5 的表）。 */
async function menuChecks(ctx, who, ids) {
  const menus = {};
  for (const key of ['m1', 'steer', 'queue', 'm4', 'q2']) menus[key] = await menuOf(ctx, who.tab, ids[key]);
  record('FS-15 a message with a code restore and changes after it offers Restore code and conversation, Restore '
    + 'conversation, Restore code, Never mind', same(menuShape(menus.m1), menuLines(MENU.full)), brief(menus.m1));
  for (const [key, how] of [['steer', 'steered (Ctrl+Enter while running)'], ['queue', 'queued (Enter while '
    + 'running)']]) {
    const noCode = menus[key]?.rows.find((row) => row.id === 'no-code');
    record(`FS-15 a ${how} message has no code restore: Restore conversation, a disabled, unfocusable row "No code `
      + 'restore", Never mind (changes came after it)', same(menuShape(menus[key]), menuLines(MENU.noCode))
      && noCode?.disabled === true && noCode.focusable === false, brief(menus[key]));
  }
  record('FS-15 a message with a code restore and no changes after it offers only Restore conversation and Never '
    + 'mind', same(menuShape(menus.m4), menuLines(MENU.short)), brief(menus.m4));
  record('FS-15 a message with no code restore and no changes after it (queued in the last run, nothing changed) '
    + 'offers only Restore conversation and Never mind', same(menuShape(menus.q2), menuLines(MENU.short)),
  brief(menus.q2));
  record('FS-15 menus open with the focus on their first item and have no blocked line when no request is open',
    Object.values(menus).every((menu) => menu?.focused === `rewind-${menu.rows[0]?.id}` && menu.blocked === null),
    brief(Object.values(menus).map((menu) => menu?.focused)));
}

/** @brief FS-15：一个会话里做出菜单的四种情况，运行中的按钮。 */
async function menuCases(ctx) {
  const who = await fullSession(ctx, ctx.p.menu);
  ctx.menu = who;
  const m1 = await sendTurn(ctx, who, MENU_TEXT.m1, { changes: true });
  const ids = { m1, ...(await runningTurn(ctx, who, m1)) };
  ids.m3 = await sendTurn(ctx, who, MENU_TEXT.m3, { changes: true });
  ids.m4 = await sendTurn(ctx, who, MENU_TEXT.m4);
  Object.assign(ids, await queuedTail(ctx, who));
  ctx.menuIds = ids;
  await idleButton(ctx, who, m1);
  await menuChecks(ctx, who, ids);
}

// ---------- FS-15：键盘 ----------

/** @brief 从输入框按 Shift+Tab 到 M3 的 Rewind，Enter 打开，方向键移动，Esc 关掉、焦点回到 Rewind。 */
async function keyboardMenu(ctx, who, entry) {
  const presses = await tabToRewind(ctx, who.tab, entry);
  const at = await focusInfo(ctx);
  await ctx.page.keyboard.press('Enter');
  await ctx.page.getByTestId('rewind-menu').waitFor({ timeout: 5000 });
  const first = (await focusInfo(ctx)).testid;
  const moves = await walkKeys(ctx, ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']);
  await ctx.page.keyboard.press('Escape');
  const closed = await menuGone(ctx);
  const back = await focusInfo(ctx);
  record('FS-15 keyboard: Shift+Tab from the composer reaches the Rewind of a message (it is in the Tab order and '
    + 'shows while focused), Enter opens the menu on its first item', presses > 0 && at.opacity === '1'
    && first === 'rewind-code-conversation', brief({ presses, at, first }));
  record('FS-15 keyboard: ArrowDown / ArrowUp move through the items and wrap around', same(moves,
    ['rewind-conversation', 'rewind-code', 'rewind-cancel', 'rewind-code-conversation', 'rewind-cancel']),
  brief(moves));
  record('FS-15 keyboard: Esc closes the menu and the focus returns to Rewind', closed && back.testid
    === 'rewind-button' && back.entry === entry, brief({ closed, back }));
}

/** @brief Enter 打开、↑ 到 Never mind、Enter：菜单关上，焦点回到 Rewind。 */
async function keyboardNeverMind(ctx, entry) {
  await ctx.page.keyboard.press('Enter');
  await ctx.page.getByTestId('rewind-menu').waitFor({ timeout: 5000 });
  const moved = await walkKeys(ctx, ['ArrowUp']);
  await ctx.page.keyboard.press('Enter');
  const closed = await menuGone(ctx);
  const back = await focusInfo(ctx);
  record('FS-15 keyboard: Never mind (ArrowUp to it, Enter) closes the menu and the focus returns to Rewind',
    same(moved, ['rewind-cancel']) && closed && back.testid === 'rewind-button' && back.entry === entry,
    brief({ moved, closed, back }));
}

/** @brief 有 No code restore 的菜单里方向键跳过那一行。 */
async function keyboardNoCode(ctx, who, entry) {
  const menu = await openRewindMenu(ctx, who.tab, entry);
  const moves = await walkKeys(ctx, ['ArrowDown', 'ArrowDown']);
  await ctx.page.keyboard.press('Escape');
  await menuGone(ctx);
  record('FS-15 keyboard: the arrow keys skip the "No code restore" row', menu?.focused === 'rewind-conversation'
    && same(moves, ['rewind-cancel', 'rewind-conversation']), brief({ focused: menu?.focused, moves }));
}

/** @brief FS-15：键盘（在 menuCases 的会话里）。 */
async function keyboard(ctx) {
  const who = ctx.menu;
  if (!who || !ctx.menuIds) throw new Error('the menu session from step menuCases is missing');
  await keyboardMenu(ctx, who, ctx.menuIds.m3);
  await keyboardNeverMind(ctx, ctx.menuIds.m3);
  await keyboardNoCode(ctx, who, ctx.menuIds.queue);
}

// ---------- FS-15、FS-18：协作模式（合并会话） ----------

/** @brief 只有后台实例在运行：对话不在运行、不在发送，TeamState.background 为真；这时这条消息的 Rewind。 */
async function backgroundOnly(ctx, who, entry) {
  const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
  const pane = await paneState(ctx.page, who.tab);
  if (!info?.team?.background || info.live?.running || info.live?.preparing || pane?.running || pane?.sending) {
    return null;
  }
  return { button: await rewindButtonOf(ctx, who.tab, entry), team: info.team };
}

/** @brief [Mori] 投递（mori.wake 指向的消息）不显示为你的消息、没有 Rewind。 */
async function wakeChecks(ctx, who) {
  const wakes = wakeIds(who.sessionFile);
  const buttons = await Promise.all(wakes.map((id) => rewindButtonOf(ctx, who.tab, id)));
  const pane = await paneState(ctx.page, who.tab);
  record('FS-15 program deliveries ([Mori] messages that mori.wake points at) are not shown as your messages and '
    + 'have no Rewind', wakes.length > 0 && buttons.every((button) => button === null)
    && !pane.users.some((text) => text.includes('[Mori]')), brief({ wakes, buttons, users: pane.users }));
}

/** @brief 需求关闭之后 Restore conversation：TaskBoard 不变（不回退），这条消息不在对话流里了。 */
async function boardKept(ctx, who, entry) {
  const before = await boardViewOf(ctx, who.sessionId);
  const menu = await menuOf(ctx, who.tab, entry);
  if (menu?.blocked || menu?.rows.find((row) => row.id === 'conversation')?.disabled !== false) {
    throw new Error(`Restore conversation is not available after the request closed: ${brief(menu)}`);
  }
  const result = await chooseRewind(ctx, who.tab, entry, 'conversation');
  const after = await boardViewOf(ctx, who.sessionId);
  const pane = await paneState(ctx.page, who.tab);
  record('FS-18 Restore conversation in a team session leaves the TaskBoard as it was (requests and their tasks '
    + 'unchanged) and the message is gone from the conversation', result.outcome === 'done'
    && before.requests.length > 0 && same(before, after) && !pane.users.some((text) => text.includes(BG_MARK)),
  brief({ result, before, after, users: pane.users }));
  await setDraft(ctx, who.tab, '');
}

/** @brief FS-15：只有后台实例在运行时不可点；[Mori] 投递没有 Rewind。FS-18：TaskBoard 不变。 */
async function background(ctx) {
  const who = await fullSession(ctx, ctx.p.bg);
  await sendFs(ctx, who, BG_MESSAGE, { team: true, wait: false });
  const entry = await waitEntry(who, BG_MARK);
  const seen = await poll(() => backgroundOnly(ctx, who, entry), 60000, 200);
  record('FS-15 while only a background instance runs (the conversation has ended its reply), Rewind is '
    + 'aria-disabled with the hover "Still running"', seen?.button?.disabled === true
    && seen.button.title === T.stillRunning, brief(seen));
  if (!(await waitTeamIdle(ctx, who, { timeout: 150000 }))) throw new Error('the team session did not become idle');
  const idle = await rewindButtonOf(ctx, who.tab, entry);
  record('FS-15 once the background instance has finished, the same Rewind can be clicked again',
    idle?.disabled === false && idle.title === T.title, brief(idle));
  await wakeChecks(ctx, who);
  await boardKept(ctx, who, entry);
}

/** @brief 有消息在判断：待判断的队列不空、对话不在运行；这时这条消息的 Rewind。 */
async function judgedOnly(ctx, who, entry) {
  const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
  if (!info || (info.deciding?.queue?.length ?? 0) === 0 || info.live?.running) return null;
  return { button: await rewindButtonOf(ctx, who.tab, entry), deciding: info.deciding };
}

/** @brief FS-15：分开配置下 planner 在判断你的消息、对话不在运行时，Rewind 不可点。 */
async function judging(ctx) {
  const who = await openFsSession(ctx, ctx.p.split, { trust: true });
  // 命令是 /task（2026-10-26 由 /team 改，M21）；模式在模型按钮的 data-team-mode 上（team-switch.md，开关在模型菜单里）
  await sendMessage(ctx, who.tab, '/task on');
  await ctx.page.waitForFunction((css) => document.querySelector(css)?.dataset.teamMode === 'always',
    modelButtonSel(who.tab), { timeout: 10000 });
  await sendFs(ctx, who, SPLIT_FIRST, { wait: false });
  if (!(await waitTeamIdle(ctx, who, { timeout: 90000 }))) throw new Error('the first split message did not settle');
  const m1 = await waitEntry(who, 'fs15 split first');
  const idle = await rewindButtonOf(ctx, who.tab, m1);
  await sendFs(ctx, who, SPLIT_SECOND, { wait: false });
  const seen = await poll(() => judgedOnly(ctx, who, m1), 30000, 150);
  record('FS-15 while a message is being judged (planner is deciding, the conversation is not running), Rewind is '
    + 'aria-disabled with the hover "Still running"', idle?.disabled === false && seen?.button?.disabled === true
    && seen.button.title === T.stillRunning, brief({ idle, seen }));
  if (!(await waitTeamIdle(ctx, who, { timeout: 90000 }))) throw new Error('the judged message did not settle');
}

// ---------- FS-16：你改过的文件（changed） ----------

/** @brief 冲突对话框里按 Tab ×3、Shift+Tab，记下每次焦点所在的按钮（焦点跑出对话框时记 outside）。 */
async function tabCycle(ctx) {
  const seen = [];
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab']) {
    await ctx.page.keyboard.press(key);
    const at = await focusInfo(ctx);
    seen.push(at.inDialog ? at.testid : 'outside');
  }
  return seen;
}

/** @brief 第一次打开的冲突对话框：文字、行、按钮的顺序、默认焦点、Tab 只在对话框里。 */
async function dialogLooks(ctx, outcome) {
  const dialog = await conflictsDialog(ctx);
  record('FS-16 a file you changed on disk after the session\'s last snapshot is a conflict: dialog "Restore these '
    + 'files anyway?" with the Rewind text, the row c.txt "Changed since the last snapshot" and the buttons '
    + 'Overwrite, Skip these files, Cancel', outcome.outcome === 'conflicts' && dialog?.kind === 'rewind'
    && dialog.title === T.dialogTitle && dialog.text === T.dialogRewind && dialog.more === null
    && same(dialog.rows, [{ path: 'c.txt', reason: 'changed', label: T.reasons.changed }])
    && same(dialog.buttons, [{ id: 'rewind-overwrite', text: 'Overwrite', disabled: false },
      { id: 'rewind-skip', text: 'Skip these files', disabled: false },
      { id: 'rewind-conflict-cancel', text: 'Cancel', disabled: false }]), brief({ outcome, dialog }));
  const tabs = await tabCycle(ctx);
  record('FS-16 the conflicts dialog opens with the focus on Cancel and Tab / Shift+Tab cycle only inside it',
    dialog?.focused === 'rewind-conflict-cancel' && same(tabs, ['rewind-overwrite', 'rewind-skip',
      'rewind-conflict-cancel', 'rewind-skip']), brief({ focused: dialog?.focused, tabs }));
}

/** @brief c.txt、e.txt 此刻的内容。 */
const chgFiles = (ctx) => ({ c: readText(fileIn(ctx, 'chg', 'c.txt')), e: readText(fileIn(ctx, 'chg', 'e.txt')) });

/** @brief Cancel：对话框关上，什么都不改，没有 Rewinding…、没有通知；焦点回到打开菜单的 Rewind。 */
async function dialogCancel(ctx, who, m2) {
  const before = (await noticesOf(ctx, who.tab)).length;
  const since = Date.now();
  await ctx.page.getByTestId('rewind-conflict-cancel').click();
  const gone = await dialogGone(ctx);
  const files = chgFiles(ctx);
  const after = (await noticesOf(ctx, who.tab)).length;
  const progress = (await rewindStates(ctx, who.tab, since)).filter((state) => state.progress);
  const back = await focusInfo(ctx);
  record('FS-16 Cancel closes the conflicts dialog and changes nothing: c.txt keeps your edit, e.txt stays, no '
    + '"Rewinding…" line and no notice', gone && files.c === 'mine\n' && files.e === 'extra\n' && after === before
    && progress.length === 0, brief({ gone, files, before, after, progress }));
  record('FS-16 after the conflicts dialog closes, the focus returns to the Rewind that opened the menu',
    back.testid === 'rewind-button' && back.entry === m2, brief(back));
}

/** @brief Esc 等于 Cancel：对话框关上，什么都不改。 */
async function dialogEscape(ctx, who, m2) {
  const outcome = await chooseRewind(ctx, who.tab, m2, 'code');
  await ctx.page.keyboard.press('Escape');
  const gone = await dialogGone(ctx);
  const files = chgFiles(ctx);
  record('FS-16 Esc in the conflicts dialog works like Cancel: the dialog closes and nothing changes',
    outcome.outcome === 'conflicts' && gone && files.c === 'mine\n' && files.e === 'extra\n',
    brief({ outcome, gone, files }));
}

/**
 * @brief 对话框开着时又改了 e.txt，点 Overwrite：第二次调用中三个按钮不可用、Overwrite 写 Restoring…；冲突变了，对话框
 *        换成新的列表（c.txt、e.txt），什么都没恢复。
 */
async function dialogChangedAgain(ctx, who, m2) {
  const outcome = await chooseRewind(ctx, who.tab, m2, 'code');
  writeFileSync(fileIn(ctx, 'chg', 'e.txt'), 'mine e\n');
  const second = await resolveConflict(ctx, who.tab, 'rewind-overwrite');
  const states = await rewindStates(ctx, who.tab, second.since);
  const dialog = await conflictsDialog(ctx);
  const files = chgFiles(ctx);
  record('FS-16 while the second call runs the three buttons are disabled and the clicked Overwrite reads '
    + '"Restoring…"', pendingSeen(states, 'rewind-overwrite', T.restoring), brief(states.map((s) => s.dialog)));
  record('FS-16 when the conflicts changed between the two calls the dialog stays open with the new list (c.txt, '
    + 'e.txt) and nothing is restored', outcome.outcome === 'conflicts' && second.outcome === 'conflicts'
    && same(dialog?.rows.map((row) => `${row.path}|${row.reason}`), ['c.txt|changed', 'e.txt|changed'])
    && files.c === 'mine\n' && files.e === 'mine e\n', brief({ second, dialog, files }));
}

/** @brief Overwrite：全部恢复（c.txt 回到这一轮之前的 one，这一轮新建的 e.txt 被删）；通知。 */
async function dialogOverwrite(ctx, who) {
  const done = await resolveConflict(ctx, who.tab, 'rewind-overwrite');
  const files = chgFiles(ctx);
  const notice = await lastNotice(ctx, who.tab);
  record('FS-16 Overwrite restores every file: c.txt is back to its content before the turn ("one") and e.txt, made '
    + 'in that turn, is deleted; the notice reads "Restored code to before turn 2 · Undo"', done.outcome === 'done'
    && files.c === 'one\n' && files.e === null && notice?.text === `${NOTICE_TEXT.code(2)} · Undo`,
  brief({ done, files, notice }));
}

/** @brief FS-16：你在磁盘上改过的文件进冲突；Cancel、Esc、冲突又变了、Overwrite。FS-24：操作记录。 */
async function conflictsChanged(ctx) {
  const who = await fullSession(ctx, ctx.p.chg);
  await sendTurn(ctx, who, gitStep.write('c.txt', 'one'), { changes: true });
  const m2 = await sendTurn(ctx, who, CHG_M2, { marker: 'e.txt', changes: true });
  writeFileSync(fileIn(ctx, 'chg', 'c.txt'), 'mine\n');
  await dialogLooks(ctx, await chooseRewind(ctx, who.tab, m2, 'code'));
  await dialogCancel(ctx, who, m2);
  await dialogEscape(ctx, who, m2);
  await dialogChangedAgain(ctx, who, m2);
  await dialogOverwrite(ctx, who);
  const actions = await recentActivity(ctx, who.tab, 'FS-24 synthetic report after the conflicts');
  const missing = missingActions(actions, ['Rewind: Restore code', 'Rewind conflicts: Cancel',
    'Rewind conflicts: Overwrite']);
  record('FS-24 the action log (F8 "Recent activity") has "Rewind: Restore code", "Rewind conflicts: Cancel" and '
    + '"Rewind conflicts: Overwrite"', actions !== '' && missing.length === 0,
  brief({ missing, actions: actions.split(/\r?\n/).slice(-14) }));
}

// ---------- FS-16：同一文件夹另一个会话同时运行（overlap） ----------

/**
 * @brief 会话 A 写 a.txt 后还要跑 12 秒，这期间会话 B 写 b.txt、跑完；A 跑完后 B 自己再写 b2.txt（A 不在运行）。
 * @return A 那条消息的条目 id
 */
async function overlapRuns(ctx, a, b) {
  await sendFs(ctx, a, OV_A, { wait: false });
  if (!(await poll(() => existsSync(fileIn(ctx, 'ov', 'a.txt')), 30000, 100))) throw new Error('a.txt not written');
  const mb = await sendTurn(ctx, b, gitStep.write('b.txt', 'B1'), { changes: true });
  const aRunning = (await paneState(ctx.page, a.tab))?.running === true;
  await waitIdleFs(ctx, a.tab, 90000);
  const ma = await waitEntry(a, 'a2.txt');
  if (!(await waitRun(a.sessionFile, ma, { changes: true }))) throw new Error('no records for session A');
  await sendTurn(ctx, b, gitStep.write('b2.txt', 'B2'), { changes: true });
  if (!aRunning) throw new Error(`session A had ended before session B's turn ${mb} was recorded`);
  return ma;
}

/** @brief 跳过冲突之后：b.txt 照旧，a.txt、a2.txt 被删，B 独自写的 b2.txt 不动；第二次调用中 Restoring…；通知。 */
async function overlapSkipped(ctx, a) {
  const done = await resolveConflict(ctx, a.tab, 'rewind-skip');
  const states = await rewindStates(ctx, a.tab, done.since);
  const read = (name) => readText(fileIn(ctx, 'ov', name));
  const files = { a: read('a.txt'), a2: read('a2.txt'), b: read('b.txt'), b2: read('b2.txt') };
  record('FS-16 Skip these files keeps the conflicting file (b.txt "B1") and restores the rest (a.txt and a2.txt, '
    + 'made in that turn, are deleted); b2.txt, which the other session changed alone, is untouched',
  done.outcome === 'done' && files.a === null && files.a2 === null && files.b === 'B1\n' && files.b2 === 'B2\n',
  brief({ done, files }));
  record('FS-16 while Skip these files runs the three buttons are disabled and Skip these files reads "Restoring…"',
    pendingSeen(states, 'rewind-skip', T.restoring), brief(states.map((s) => s.dialog)));
  const notice = await expandNotice(ctx, a.tab, 'rewind-skipped');
  record('FS-16 the notice reads "Restored code to before turn 1 · Undo · Skipped 1 file" and expanding it lists '
    + 'b.txt', notice?.text === `${NOTICE_TEXT.code(1)} · Undo · Skipped 1 file` && same(notice.list, ['b.txt']),
  brief(notice));
}

/** @brief FS-16：同时运行时另一个会话改的文件列为 overlap；Skip these files。FS-24：操作记录。 */
async function conflictsOverlap(ctx) {
  const a = await fullSession(ctx, ctx.p.ov);
  const b = await fullSession(ctx, ctx.p.ov);
  const ma = await overlapRuns(ctx, a, b);
  const outcome = await chooseRewind(ctx, a.tab, ma, 'code');
  const dialog = await conflictsDialog(ctx);
  record('FS-16 a file another session in the same folder changed while this session was running is listed as '
    + '"Another session was running" (overlap), and only that file', outcome.outcome === 'conflicts'
    && same(dialog?.rows, [{ path: 'b.txt', reason: 'overlap', label: T.reasons.overlap }]),
  brief({ outcome, dialog }));
  await overlapSkipped(ctx, a);
  const actions = await recentActivity(ctx, a.tab, 'FS-24 synthetic report after skipping');
  record('FS-24 the action log (F8 "Recent activity") has "Rewind conflicts: Skip these files"',
    actions.includes('Rewind conflicts: Skip these files'), brief(actions.split(/\r?\n/).slice(-10)));
}

// ---------- FS-17：恢复代码 ----------

/** @brief 恢复代码之后的文件、项目仓库与通知。 */
async function restoreChecks(ctx, who, { m1, repo, result }) {
  const read = (name) => readText(fileIn(ctx, 'restore', name));
  const notes = fileIn(ctx, 'restore', 'notes');
  const files = { a: read('src/a.ts'), readme: read('README.md'), created: read('notes/created.txt'),
    mine: read('mine.txt'), notesDir: existsSync(notes) && statSync(notes).isDirectory() ? readdirSync(notes) : null };
  record('FS-17 Restore code puts back the changed and the deleted file (src/a.ts, README.md as committed), deletes '
    + 'the file made in that turn (notes/created.txt; the emptied folder stays) and leaves your own unrecorded '
    + 'mine.txt alone', result.outcome === 'done' && files.a === A_TS_TEXT && files.readme === README_TEXT
    && files.created === null && same(files.notesDir, []) && files.mine === 'mine\n', brief({ result, files }));
  const now = repoState(ctx.p.restore);
  record('FS-17 the project repository\'s HEAD, branch and index are unchanged (staged.txt still staged) and git '
    + 'status lists only your staged and untracked files', now.head === repo.head && now.branch === repo.branch
    && now.index === repo.index && same(now.status, ['?? mine.txt', 'A  staged.txt']), brief({ repo, now }));
  const notice = await lastNotice(ctx, who.tab);
  const pane = await paneState(ctx.page, who.tab);
  const composer = await composerOf(ctx, who.tab);
  record('FS-17 the notice reads "Restored code to before turn 1 · Undo" (data-code true, data-conversation false) '
    + 'and the conversation and the composer are unchanged', notice?.text === `${NOTICE_TEXT.code(1)} · Undo`
    && notice.code && !notice.conversation && notice.undo?.disabled === false && pane.users.includes(RESTORE_M1)
    && composer.draft === '', brief({ notice, users: pane.users, composer, m1 }));
}

/** @brief FS-17：在 git 仓库里恢复代码（你暂存的文件与没记下的文件都不动）。 */
async function restoreCode(ctx) {
  const project = ctx.p.restore;
  writeFileSync(join(project, 'staged.txt'), 'staged\n');
  gitOut(project, ['add', 'staged.txt']);
  const who = await fullSession(ctx, project);
  ctx.restore = who;
  const m1 = await sendTurn(ctx, who, RESTORE_M1, { marker: 'notes/created.txt', changes: true });
  writeFileSync(join(project, 'mine.txt'), 'mine\n');
  const repo = repoState(project);
  const result = await chooseRewind(ctx, who.tab, m1, 'code');
  await restoreChecks(ctx, who, { m1, repo, result });
}

// ---------- FS-18：恢复对话 ----------

/** @brief 在 M2 上恢复对话之后：对话流、输入框（文字与芯片在草稿之前）、通知、会话文件里的分支。 */
async function conversationChecks(ctx, who, { m2, chips, result }) {
  const pane = await paneState(ctx.page, who.tab);
  const composer = await composerOf(ctx, who.tab);
  record('FS-18 Restore conversation shows the conversation of the new branch (only the first message and its '
    + 'reply are left)', result.outcome === 'done' && same(pane.users, [CONV_M1]) && pane.assistants.length === 1,
  brief({ result, users: pane.users, assistants: pane.assistants.length }));
  record('FS-18 the message\'s text goes back into the composer before the draft and its quote chip goes back as a '
    + 'chip', composer.draft === `${CONV.m2}\n\n${CONV.draft}` && chips.length === 1 && same(composer.chips, chips),
  brief({ composer, chips }));
  const notice = await lastNotice(ctx, who.tab);
  const branch = branchOf(who.sessionFile);
  const rewound = branch.at(-1);
  record('FS-18 the notice reads "Restored conversation to before turn 2" with no Undo, and in the session file the '
    + 'current branch ends with the mori.rewind (conversation true, code false) and no longer has the message',
  notice?.text === NOTICE_TEXT.conversation(2) && notice.undo === null && rewound?.customType === 'mori.rewind'
    && rewound.data?.conversation === true && rewound.data?.code === false
    && !branch.some((entry) => entry.id === m2), brief({ notice, tail: branchTail(branch) }));
}

/** @brief 第一条消息上恢复对话：对话为空（只剩通知），它的文字回到输入框。 */
async function firstMessage(ctx, who, m1) {
  await setDraft(ctx, who.tab, '');
  const result = await chooseRewind(ctx, who.tab, m1, 'conversation');
  const pane = await paneState(ctx.page, who.tab);
  const notices = await noticesOf(ctx, who.tab);
  const composer = await composerOf(ctx, who.tab);
  const branch = branchOf(who.sessionFile);
  // pi 把提示词各段与工具声明记成一条 role 为 system 的 message 条目（第一条消息的父条目），它不是对话里的消息
  const said = branch.filter((e) => e.type === 'message' && e.message?.role !== 'system');
  record('FS-18 Restore conversation on the first message leaves an empty conversation (no conversation messages; '
    + 'pi\'s system-prompt entry stays; only the notice "Restored conversation to before turn 1") and puts its text '
    + 'into the composer', result.outcome === 'done' && pane.users.length === 0 && pane.assistants.length === 0
    && same(notices.map((n) => n.text), [NOTICE_TEXT.conversation(1)]) && composer.draft === CONV_M1
    && said.length === 0, brief({ result, users: pane.users, notices, composer, tail: branchTail(branch) }));
}

/** @brief FS-18：恢复对话（引用芯片、草稿、第一条消息）。 */
async function conversation(ctx) {
  const who = await openFsSession(ctx, ctx.p.conv);
  const m1 = await sendTurn(ctx, who, CONV_M1);
  await quoteReply(ctx, who.tab, CONV.quote);
  const chips = (await composerOf(ctx, who.tab)).chips;
  const m2 = await sendTurn(ctx, who, CONV.m2);
  await sendTurn(ctx, who, CONV.m3);
  await setDraft(ctx, who.tab, CONV.draft);
  const result = await chooseRewind(ctx, who.tab, m2, 'conversation');
  await conversationChecks(ctx, who, { m2, chips, result });
  await firstMessage(ctx, who, m1);
}

// ---------- FS-18：还开着的需求 ----------

/** @brief 需求 1 还开着时两条消息的菜单与后台进程的拒绝。 */
async function blockedMenus(ctx, who, { m0, m1 }) {
  const text = blockedText(1);
  const menu0 = await menuOf(ctx, who.tab, m0);
  const menu1 = await menuOf(ctx, who.tab, m1);
  record('FS-18 with request 1 still open (registered after the message), Restore code and conversation and Restore '
    + 'conversation are disabled, Restore code stays available, and the menu ends with "Request 1 is still open. The '
    + 'conversation can’t go back to before it was registered."', same(menuDisabled(menu0), ['code-conversation:true',
    'conversation:true', 'code:false', 'cancel:false']) && menu0.blocked?.text === text
    && menu0.blocked.requests === '1' && menu0.blocked.describes === true, brief(menu0));
  record('FS-18 the message that registered the open request offers a disabled Restore conversation, Never mind and '
    + 'the same line', same(menuDisabled(menu1), ['conversation:true', 'cancel:false'])
    && menu1.blocked?.text === text, brief(menu1));
  const refusals = await requestsFromPage(ctx, who, [
    { type: 'rewind', entryId: m0, code: false, conversation: true },
    { type: 'rewind', entryId: m0, code: true, conversation: true }]);
  record('FS-18 the kernel refuses Restore conversation and Restore code and conversation with the same line while '
    + 'the request is open, and no file changes', same(refusals, [text, text])
    && readText(fileIn(ctx, 'open', 'w0.txt')) === 'zero\n', brief(refusals));
}

/** @brief FS-18：需求还开着（登记之后按了停止）时不能恢复对话，Restore code 仍可用，TaskBoard 不变。 */
async function openRequest(ctx) {
  const who = await fullSession(ctx, ctx.p.open);
  const m0 = await sendTurn(ctx, who, gitStep.write('w0.txt', 'zero'), { changes: true });
  await sendFs(ctx, who, gitOpenRequest(30000), { team: true, wait: false });
  if (!(await waitReceipt(ctx, who.tab, { kind: 'registered', request: 1 }, 45000))) {
    throw new Error('request 1 was not registered');
  }
  await pressInComposer(ctx, who.tab, 'Escape');
  if (!(await waitTeamIdle(ctx, who, { timeout: 60000 }))) throw new Error('the stopped team session is still busy');
  const m1 = await waitEntry(who, 'request_submit');
  const before = await boardViewOf(ctx, who.sessionId);
  await blockedMenus(ctx, who, { m0, m1 });
  const result = await chooseRewind(ctx, who.tab, m0, 'code');
  const after = await boardViewOf(ctx, who.sessionId);
  const notice = await lastNotice(ctx, who.tab);
  record('FS-18 Restore code still works while the request is open (w0.txt deleted, notice "Restored code to before '
    + 'turn 1 · Undo") and the TaskBoard is unchanged (request 1 still open)', result.outcome === 'done'
    && readText(fileIn(ctx, 'open', 'w0.txt')) === null && notice?.text === `${NOTICE_TEXT.code(1)} · Undo`
    && before.requests[0]?.status === 'open' && same(before, after), brief({ result, notice, before, after }));
}

// ---------- FS-19：Undo ----------

/** @brief Undo 做完之后：文件、对话流回到原来的分支、输入框不变、通知 Rewind undone、没有 Undo 也没有 Redo。 */
async function undoneChecks(ctx, who, { done, draft }) {
  const read = (name) => readText(fileIn(ctx, 'undo', name));
  const pane = await paneState(ctx.page, who.tab);
  const composer = await composerOf(ctx, who.tab);
  record('FS-19 Undo with Overwrite puts the files back as they were before the rewind (u1.txt "second", u2.txt '
    + '"two") and returns to the old branch (both messages shown again); the composer is unchanged',
  done.outcome === 'done' && read('u1.txt') === 'second\n' && read('u2.txt') === 'two\n'
    && same(pane.users, [gitStep.write('u1.txt', 'first'), UNDO_M2]) && composer.draft === draft,
  brief({ done, users: pane.users, composer }));
  const states = await rewindStates(ctx, who.tab, done.since);
  record('FS-19 while the Undo call after the conflicts runs, the clicked Overwrite reads "Undoing…" and the three '
    + 'buttons are disabled', pendingSeen(states, 'rewind-overwrite', T.undoingButton),
  brief(states.map((s) => s.dialog)));
  const notices = await noticesOf(ctx, who.tab);
  const redo = await textCount(ctx, who.tab, 'Redo');
  record('FS-19 the notice reads "Rewind undone" and nothing offers Undo or Redo after it', notices.at(-1)?.text
    === T.undone && notices.at(-1).kind === 'undo' && notices.every((notice) => notice.undo === null) && redo === 0,
  brief({ notices, redo }));
}

/** @brief Restore code and conversation，之后改 u1.txt，Undo 进冲突，Overwrite。 */
async function undoBranch(ctx, who, m2) {
  const rewound = await chooseRewind(ctx, who.tab, m2, 'code-conversation');
  const notice = await lastNotice(ctx, who.tab);
  const { draft } = await composerOf(ctx, who.tab);
  record('FS-19 after Restore code and conversation the notice offers Undo: "Restored code and conversation to '
    + 'before turn 2 · Undo"; u1.txt is "first" again and u2.txt is gone', rewound.outcome === 'done'
    && notice?.text === `${NOTICE_TEXT.both(2)} · Undo` && notice.undo?.disabled === false
    && readText(fileIn(ctx, 'undo', 'u1.txt')) === 'first\n' && readText(fileIn(ctx, 'undo', 'u2.txt')) === null
    && draft === UNDO_M2, brief({ rewound, notice, draft }));
  writeFileSync(fileIn(ctx, 'undo', 'u1.txt'), 'after rewind\n');
  const asked = await waitRewindOutcome(ctx, who.tab, await clickUndo(ctx, who.tab));
  const dialog = await conflictsDialog(ctx);
  record('FS-19 a file you changed after the rewind is a conflict for Undo: the dialog has the Undo text and the row '
    + 'u1.txt "Changed since the last snapshot", focus on Cancel', asked.outcome === 'conflicts'
    && dialog?.kind === 'undo' && dialog.title === T.dialogTitle && dialog.text === T.dialogUndo
    && same(dialog.rows, [{ path: 'u1.txt', reason: 'changed', label: T.reasons.changed }])
    && dialog.focused === 'rewind-conflict-cancel', brief({ asked, dialog }));
  await undoneChecks(ctx, who, { done: await resolveConflict(ctx, who.tab, 'rewind-overwrite'), draft });
}

/**
 * @brief 再 Rewind 一次、发一条消息之后没有 Undo（中间在还提供 Undo 时重新载入界面一次）；只恢复对话的没有 Undo。
 */
async function undoOffers(ctx, who, { m1, m2 }) {
  await setDraft(ctx, who.tab, '');
  await chooseRewind(ctx, who.tab, m2, 'code');
  const first = await lastNotice(ctx, who.tab);
  await chooseRewind(ctx, who.tab, m1, 'code');
  const two = await noticesOf(ctx, who.tab);
  record('FS-19 another rewind takes the Undo away from the earlier notice; the new notice has it',
    first?.text === `${NOTICE_TEXT.code(2)} · Undo` && two.at(-2)?.text === NOTICE_TEXT.code(2)
    && two.at(-2).undo === null && two.at(-1)?.text === `${NOTICE_TEXT.code(1)} · Undo`, brief({ first, two }));
  await undoReload(ctx, who);
  const m3 = await sendTurn(ctx, who, UNDO_M3);
  const sent = await noticesOf(ctx, who.tab);
  record('FS-19 sending a message takes the Undo away', sent.at(-1)?.text === NOTICE_TEXT.code(1)
    && sent.every((notice) => notice.undo === null), brief(sent));
  const menu = await menuOf(ctx, who.tab, m3);
  const result = await chooseRewind(ctx, who.tab, m3, 'conversation');
  const last = await lastNotice(ctx, who.tab);
  record('FS-19 a conversation-only rewind has no Undo: "Restored conversation to before turn 3"',
    same(menuShape(menu), menuLines(MENU.short)) && result.outcome === 'done'
    && last?.text === NOTICE_TEXT.conversation(3) && last.undo === null && last.code === false,
  brief({ menu: menuShape(menu), result, last }));
}

/**
 * @brief 界面重新载入、重新打开会话：通知与 Undo 按条目算出，与之前相同。在最后一条通知还提供 Undo 时调用（之前要有
 *        Undo，否则"重新算出 Undo"测不到）；重新载入之后那个 Undo 也要能点。
 */
async function undoReload(ctx, who) {
  const shape = (list) => list.map(({ kind, code, conversation, text, undo }) => ({ kind, code, conversation, text,
    undo: undo !== null, usable: undo?.disabled === false }));
  const before = shape(await noticesOf(ctx, who.tab));
  await reloadRewindUi(ctx);
  await reopenFs(ctx, who);
  const after = await poll(async () => {
    const now = shape(await noticesOf(ctx, who.tab));
    return same(now, before) ? now : null;
  }, 20000, 300);
  record('FS-19 after a UI reload (Ctrl+R) and reopening the session, the notices and their Undo are rebuilt from '
    + 'the session entries exactly as before (the last notice still offers a usable Undo, the earlier ones none)',
  after !== null && before.length >= 3 && before.at(-1)?.undo === true && before.at(-1).usable === true
    && before.slice(0, -1).every((notice) => !notice.undo),
  brief({ before, after: after ?? shape(await noticesOf(ctx, who.tab)) }));
}

/** @brief FS-19：Undo（冲突、回到原来的分支、什么时候不再提供）。FS-24：操作记录。 */
async function undo(ctx) {
  const who = await fullSession(ctx, ctx.p.undo);
  const m1 = await sendTurn(ctx, who, gitStep.write('u1.txt', 'first'), { changes: true });
  const m2 = await sendTurn(ctx, who, UNDO_M2, { marker: 'u2.txt', changes: true });
  await undoBranch(ctx, who, m2);
  const actions = await recentActivity(ctx, who.tab, 'FS-24 synthetic report after the undo');
  const missing = missingActions(actions, ['Rewind: Restore code and conversation', 'Undo rewind',
    'Rewind conflicts: Overwrite']);
  record('FS-24 the action log (F8 "Recent activity") has "Rewind: Restore code and conversation", "Undo rewind" and '
    + '"Rewind conflicts: Overwrite"', actions !== '' && missing.length === 0,
  brief({ missing, actions: actions.split(/\r?\n/).slice(-12) }));
  await undoOffers(ctx, who, { m1, m2 });
}

// ---------- FS-24：进行中 ----------

/**
 * @brief 记录器里进行中的样子：每一项都是这一句、在对话流末尾、发送按钮不可用且悬停同一句、全部 Rewind 不可点。
 * @param kind rewind 或 undo
 */
function progressOk(states, kind) {
  const text = kind === 'rewind' ? T.rewinding : T.undoing;
  const during = states.filter((state) => state.progress);
  return during.length > 0 && during.every((state) => state.progress === text && state.kind === kind
    && state.atEnd === true && state.send?.disabled === true && state.send.title === text && state.buttons > 0
    && state.enabled === 0);
}

/** @brief Restore code 进行中：Rewinding…、发送按钮、拒绝 session.prompt 与第二个 rewind；做完后的文件与草稿。 */
async function rewindInProgress(ctx, who, m1) {
  const idle = await sendButtonOf(ctx, who.tab);
  const since = await clickRewindItem(ctx, who.tab, m1, 'code');
  const refused = await refuseDuring(ctx, who, { type: 'rewind', entryId: m1, code: true, conversation: false });
  const result = await waitRewindOutcome(ctx, who.tab, since);
  const states = await rewindStates(ctx, who.tab, since);
  record('FS-24 while Rewind runs the transcript ends with "Rewinding…", the Send button is disabled with the hover '
    + '"Rewinding…" and every Rewind is aria-disabled', idle?.disabled === false && idle.title === 'Send (Enter)'
    && progressOk(states, 'rewind'), brief({ idle, states: states.slice(0, 6) }));
  record('FS-24 during a rewind session.prompt is refused with "This session is rewinding. Send your message when '
    + 'it’s done." and a second rewind with "This session is already rewinding."', same(refused,
    [T.rewindingPrompt, T.alreadyRewinding]), brief(refused));
  const composer = await composerOf(ctx, who.tab);
  record('FS-24 the rewind finishes with the 1500 made files and t1.txt deleted and the typed draft kept',
    result.outcome === 'done' && fileCount(fileIn(ctx, 'prog', 'big')) === 0
    && readText(fileIn(ctx, 'prog', 't1.txt')) === null && composer.draft === PROG_DRAFT,
  brief({ result, big: fileCount(fileIn(ctx, 'prog', 'big')), composer }));
}

/** @brief Undo 进行中：Undoing…、发送按钮、拒绝 session.prompt 与第二个 rewind.undo；做完后文件回来。 */
async function undoInProgress(ctx, who) {
  const undoId = lastRewindEntry(who.sessionFile)?.id;
  const since = await clickUndo(ctx, who.tab);
  const refused = await refuseDuring(ctx, who, { type: 'rewind.undo', undoId: undoId ?? 'missing' });
  const result = await waitRewindOutcome(ctx, who.tab, since);
  const states = await rewindStates(ctx, who.tab, since);
  record('FS-24 while Undo runs the transcript ends with "Undoing…", the Send button is disabled with the hover '
    + '"Undoing…" and every Rewind is aria-disabled', progressOk(states, 'undo'), brief(states.slice(0, 6)));
  record('FS-24 during an undo session.prompt is refused with the rewinding text and a second rewind.undo with "This '
    + 'session is already rewinding."', Boolean(undoId) && same(refused, [T.rewindingPrompt, T.alreadyRewinding]),
  brief({ undoId, refused }));
  record('FS-24 the undo finishes with the 1500 files and t1.txt back', result.outcome === 'done'
    && fileCount(fileIn(ctx, 'prog', 'big')) === 1500 && readText(fileIn(ctx, 'prog', 't1.txt')) === 'one\n',
  brief({ result, big: fileCount(fileIn(ctx, 'prog', 'big')) }));
}

/** @brief FS-24：Rewind 与 Undo 进行中；操作记录 Refresh changes、Rewind: Restore code、Undo rewind。 */
async function progress(ctx) {
  const who = await fullSession(ctx, ctx.p.prog);
  const m1 = await sendTurn(ctx, who, PROG_M1, { marker: 't1.txt', changes: true });
  await refreshChanges(ctx, who.tab);
  await setDraft(ctx, who.tab, PROG_DRAFT);
  await rewindInProgress(ctx, who, m1);
  await undoInProgress(ctx, who);
  const actions = await recentActivity(ctx, who.tab, 'FS-24 synthetic report after the progress lines');
  const missing = missingActions(actions, ['Refresh changes', 'Rewind: Restore code', 'Undo rewind']);
  record('FS-24 the action log (F8 "Recent activity") has "Refresh changes", "Rewind: Restore code" and "Undo rewind"',
    actions !== '' && missing.length === 0, brief({ missing, actions: actions.split(/\r?\n/).slice(-12) }));
}

// ---------- FS-18：这条消息恰是叶子（后台进程在它的运行中途没了） ----------

/** @brief 条目是恢复对话后写在新叶子之后的 mori.pick 或 mori.rewind。 */
const rewindTrailer = (entry) => entry.type === 'custom' && ['mori.pick', 'mori.rewind'].includes(entry.customType);

/**
 * @brief M1 写一个文件；M2 的回复推迟 25 秒：M2 写进会话文件、正在运行时结束 Mori 的整棵进程树（模拟后台进程在运行中途
 *        崩溃），再用同一个数据目录启动、重新打开会话。
 * @return { m1, m2, parent（M2 的父条目 id） }
 */
async function crashAfterLeaf(ctx, who) {
  const m1 = await sendTurn(ctx, who, LEAF.m1, { changes: true });
  await sendFs(ctx, who, LEAF.m2, { wait: false });
  if (!(await waitRunning(ctx, who.tab))) throw new Error(`the "${LEAF.m2}" run did not start`);
  const m2 = await waitEntry(who, LEAF.m2);
  const parent = sessionEntries(who.sessionFile).find((entry) => entry.id === m2)?.parentId ?? null;
  await mustBeRunning(ctx, who, LEAF.m2, 'kill');
  await killRestartRewindApp(ctx);
  await reopenFs(ctx, who);
  return { m1, m2, parent };
}

/** @brief 重新启动之后：M2 仍是会话文件的最后一条、没有 run 记录；它的 Rewind 能点，菜单只有两项。 */
async function leafMenu(ctx, who, m2) {
  const entries = sessionEntries(who.sessionFile);
  const leaf = entries.at(-1)?.id === m2;
  const run = turnRecords(who.sessionFile).some((item) => item.kind === 'run' && item.round === m2);
  const button = await poll(async () => {
    const state = await rewindButtonOf(ctx, who.tab, m2);
    return state?.disabled === false ? state : null;
  }, 30000, 200);
  const menu = button ? await menuOf(ctx, who.tab, m2) : null;
  record('FS-18 after Mori was ended in the middle of M2\'s run and started again, M2 is still the last entry of the '
    + 'session file and has no run record, and its menu is the one for no code restore and no changes after: '
    + 'Restore conversation, Never mind', leaf && !run && same(menuShape(menu), menuLines(MENU.short)),
  brief({ leaf, run, button, menu, tail: branchTail(entries) }));
  if (!leaf) throw new Error(`M2 is not the last entry after the restart: ${brief(branchTail(entries))}`);
}

/** @brief M2 恰是叶子时 Restore conversation（§5.8）：改为导航到 M2 的父条目，M2 的文字照样回到输入框。 */
async function leafRestore(ctx, who, { m1, m2, parent }) {
  const before = await paneState(ctx.page, who.tab);
  const result = await chooseRewind(ctx, who.tab, m2, 'conversation');
  const pane = await paneState(ctx.page, who.tab);
  const composer = await composerOf(ctx, who.tab);
  const notice = await lastNotice(ctx, who.tab);
  record('FS-18 Restore conversation on a message that is the current leaf (nothing written after it) works: only '
    + 'M1 and its reply are left, M2\'s text goes into the composer and the notice reads "Restored conversation to '
    + 'before turn 2"', result.outcome === 'done' && same(before.users, [LEAF.m1, LEAF.m2])
    && same(pane.users, [LEAF.m1]) && before.assistants.length > 0 && same(pane.assistants, before.assistants)
    && composer.draft === LEAF.m2 && notice?.text === NOTICE_TEXT.conversation(2) && notice.undo === null,
  brief({ result, before: before.users, users: pane.users, composer, notice }));
  const branch = branchOf(who.sessionFile);
  const rewound = branch.at(-1);
  const kept = branch.findLast((entry) => !rewindTrailer(entry));
  record('FS-18 for that leaf the kernel moves to M2\'s parent (§5.8): the branch ends with mori.pick and mori.rewind '
    + '(from M2, conversation only) right after M2\'s parent entry, keeps M1 and no longer has M2',
  rewound?.customType === 'mori.rewind' && branch.at(-2)?.customType === 'mori.pick' && rewound.data?.from === m2
    && rewound.data?.conversation === true && rewound.data?.code === false && parent !== null && kept?.id === parent
    && branch.some((e) => e.id === m1)
    && !branch.some((e) => e.id === m2), brief({ parent, kept: kept?.id, tail: branchTail(branch) }));
}

/** @brief FS-18：后台进程在 M2 的运行中途没了、重新启动之后，M2 是叶子；在它上面恢复对话。 */
async function leafCrash(ctx) {
  const who = await fullSession(ctx, ctx.p.leaf);
  const ids = await crashAfterLeaf(ctx, who);
  await leafMenu(ctx, who, ids.m2);
  await leafRestore(ctx, who, ids);
}

// ---------- FS-25：Rewind 后再记一次 mori.pick ----------

/**
 * @brief 一个会话：范围 A 下发 M1（写一个文件），之后把范围换成 B，再发 M2（写另一个文件）。
 * @return { who, m1, m2 }
 */
async function pickSession(ctx, name) {
  const who = await fullSession(ctx, ctx.p[name]);
  const m1 = await sendTurn(ctx, who, gitStep.write(`${name}-a.txt`, 'one'), { changes: true });
  await choosePick(ctx, who.tab, PICK_B);
  const m2 = await sendTurn(ctx, who, gitStep.write(`${name}-b.txt`, 'two'), { changes: true });
  const entries = sessionEntries(who.sessionFile);
  const at = (id) => entries.findIndex((entry) => entry.id === id);
  const picks = customEntries(entries, 'mori.pick').filter((entry) => entry.data?.pick === PICK_B)
    .map((entry) => at(entry.id));
  record(`FS-25 (${name}) changing the range after M1 writes mori.pick "${PICK_B}" between M1 and M2`,
    picks.some((index) => index > at(m1) && index < at(m2)), brief({ picks, m1: at(m1), m2: at(m2) }));
  return { who, m1, m2 };
}

/** @brief 当前分支末尾、mori.rewind 之前有一条值为 B 的 mori.pick。 */
function pickedB(file, kind) {
  const branch = branchOf(file);
  return { ok: branch.at(-1)?.customType === 'mori.rewind' && branch.at(-1).data?.kind === kind
    && pickBeforeRewind(branch) === PICK_B, tail: branchTail(branch) };
}

/** @brief Restore conversation 之后的分支。 */
async function pickConversation(ctx, one) {
  const result = await chooseRewind(ctx, one.who.tab, one.m1, 'conversation');
  const branch = pickedB(one.who.sessionFile, 'rewind');
  record(`FS-25 Restore conversation on M1: the new branch ends with mori.pick "${PICK_B}" (range B) right before `
    + 'mori.rewind', result.outcome === 'done' && branch.ok, brief({ result, branch }));
}

/** @brief Restore code and conversation 之后的分支（Undo 留到关闭重开之后）。 */
async function pickBoth(ctx, two) {
  const result = await chooseRewind(ctx, two.who.tab, two.m1, 'code-conversation');
  const branch = pickedB(two.who.sessionFile, 'rewind');
  record(`FS-25 Restore code and conversation on M1: the new branch ends with mori.pick "${PICK_B}" right before `
    + 'mori.rewind', result.outcome === 'done' && branch.ok, brief({ result, branch }));
}

/**
 * @brief 关掉 App 再打开、重新打开两个会话：范围都是 B。两个会话这时都在 Rewind 之后的新分支上（M1 已不在分支上，
 *        之前的 mori.pick B 写在 M1 之后，只留在丢掉的分支上），所以范围是 B 只能来自 Rewind 之后再记的那一条。
 */
async function pickReopen(ctx, sessions) {
  await restartRewindApp(ctx);
  for (const [label, session] of sessions) {
    await reopenFs(ctx, session.who);
    const branch = branchOf(session.who.sessionFile);
    const live = await poll(async () => {
      const info = await liveInfo(ctx, session.who.sessionFile).catch(() => null);
      const shown = await pickOf(ctx, session.who.tab);
      return info?.pick === PICK_B && shown === PICK_B ? { pick: info.pick, shown } : null;
    }, 20000, 300);
    record(`FS-25 after closing and reopening, the ${label} session (still on the branch after its rewind, M1 off `
      + `it) has the range "${PICK_B}" (SessionInfo.pick and the range button)`, live !== null
      && branch.at(-1)?.customType === 'mori.rewind' && !branch.some((entry) => entry.id === session.m1),
    brief({ live, shown: await pickOf(ctx, session.who.tab), tail: branchTail(branch) }));
  }
}

/** @brief 关闭重开之后：Undo 回到原来的分支，末尾同样有 mori.pick B；M2 上只恢复代码不写 mori.pick。 */
async function pickUndoAndCode(ctx, two) {
  const undone = await waitRewindOutcome(ctx, two.who.tab, await clickUndo(ctx, two.who.tab));
  const back = pickedB(two.who.sessionFile, 'undo');
  record(`FS-25 Undo of that rewind returns to the old branch, which then ends with mori.pick "${PICK_B}" right `
    + 'before the undo\'s mori.rewind', undone.outcome === 'done' && back.ok, brief({ undone, back }));
  const count = pickCount(two.who.sessionFile);
  const code = await chooseRewind(ctx, two.who.tab, two.m2, 'code');
  const after = pickCount(two.who.sessionFile);
  record('FS-25 Restore code on M2 writes no mori.pick', code.outcome === 'done' && after === count
    && branchOf(two.who.sessionFile).at(-1)?.data?.code === true, brief({ code, count, after }));
}

/** @brief FS-25：两个会话分别 Restore conversation 与 Restore code and conversation，关闭重开，再 Undo。 */
async function picks(ctx) {
  const one = await pickSession(ctx, 'pick1');
  const two = await pickSession(ctx, 'pick2');
  await pickConversation(ctx, one);
  await pickBoth(ctx, two);
  await pickReopen(ctx, [['Restore conversation', one], ['Restore code and conversation', two]]);
  await pickUndoAndCode(ctx, two);
}

// ---------- FS-15、FS-19：没装 git ----------

/** @brief 没有 menuCases 的会话时（--only），开一个会话写一轮。 */
async function anySession(ctx) {
  if (ctx.menu?.sessionFile) return ctx.menu;
  const who = await fullSession(ctx, ctx.p.nogit);
  await sendTurn(ctx, who, gitStep.write('n1.txt', 'one'), { changes: true });
  return who;
}

/** @brief 另起一次 App（MORI_GIT_PATH 指向不存在的 git.exe）：没有 Rewind，通知上没有 Undo。 */
async function noGit(ctx) {
  const who = await anySession(ctx);
  ctx.env = { MORI_GIT_PATH: join(ROOT, 'no-git', 'git.exe') };
  await restartRewindApp(ctx);
  await reopenFs(ctx, who);
  await openChanges(ctx, who.tab);
  const line = await waitGitMissing(ctx);
  const count = await rewindButtonCount(ctx, who.tab);
  const users = (await paneState(ctx.page, who.tab)).users.length;
  record('FS-15 without git (MORI_GIT_PATH points at a missing git.exe) the right panel says "Git is required to '
    + 'track changes and rewind." and no message has Rewind', line === T.gitRequired && users > 0 && count === 0,
  brief({ line, users, count }));
  if (!ctx.restore?.sessionFile) return;
  await reopenFs(ctx, ctx.restore);
  await openChanges(ctx, ctx.restore.tab);
  const missing = await waitGitMissing(ctx);
  const notice = await lastNotice(ctx, ctx.restore.tab);
  record('FS-19 without git the notice of a code rewind has no Undo (the rest of its text is unchanged)',
    missing === T.gitRequired && notice?.text === NOTICE_TEXT.code(1) && notice.undo === null, brief(notice));
}

// ---------- 主流程 ----------

/**
 * @brief 包一个步骤：它抛错时先截图，再关掉还开着的冲突对话框、Rewind 菜单与 F8 报告框（它们盖住窗口，留着会让后面
 *        互不相干的步骤也点不到侧栏和输入框），然后把错误照样抛给 runSteps（记失败）。关不掉时只记日志。
 */
function guarded(name, step) {
  return async (ctx) => {
    try {
      await step(ctx);
    } catch (error) {
      await shotFs(ctx, ctx.args, `${name}-before-cleanup`);
      await closeRewindOverlays(ctx).catch((cleanup) => {
        console.error(`[fs-app-rewind] closing the rewind overlays after ${name} failed: ${errorLine(cleanup)}`);
      });
      throw error;
    }
  };
}

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const STEP_LIST = {
  menuCases: [menuCases, ['FS-15']],
  keyboard: [keyboard, ['FS-15']],
  background: [background, ['FS-15', 'FS-18']],
  judging: [judging, ['FS-15']],
  conflictsChanged: [conflictsChanged, ['FS-16', 'FS-24']],
  conflictsOverlap: [conflictsOverlap, ['FS-16', 'FS-24']],
  restoreCode: [restoreCode, ['FS-17']],
  conversation: [conversation, ['FS-18']],
  openRequest: [openRequest, ['FS-18']],
  undo: [undo, ['FS-19', 'FS-24']],
  progress: [progress, ['FS-24']],
  // 下面三步重新启动 App（leafCrash 结束整棵进程树）：放在最后
  leafCrash: [leafCrash, ['FS-18']],
  picks: [picks, ['FS-25']],
  noGit: [noGit, ['FS-15', 'FS-19']],
};
const steps = Object.fromEntries(Object.entries(STEP_LIST).map(([name, [step, ids]]) => [name,
  [guarded(name, step), ids]]));

/**
 * @brief 收尾之后：全部通过时删掉这次的临时目录（项目、数据目录、快照目录）；有失败时留着并打印路径，便于查看。
 * @param passed finish() 的结果
 */
function cleanUp(ctx, passed) {
  const dirs = { projects: ROOT, data: ctx.userData, snapshots: ctx.snapshots };
  if (!passed) {
    console.log(`[fs-app-rewind] kept for checking: ${Object.entries(dirs).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    return;
  }
  for (const dir of Object.values(dirs)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      console.error(`[fs-app-rewind] could not remove ${dir}: ${errorLine(error)}`);
    }
  }
}

const ctx = { ...fsUserData('mori-fs-rw-data-'), exePath: args.exePath, pageErrors: [], args, record };
await runSuite(ctx, setup, steps);
cleanUp(ctx, finish());
