// 文件系统规格第 2 步（docs/specs/file-system.md §5.5–§5.11，状态表 docs/v1/screens/fs-rewind.md）的 App 套件
// tests/ui/fs-app-rewind.mjs 用的帮助函数：
// - Rewind 的界面文字与后台进程的拒绝原文（照抄规格与状态表，src/renderer/src/state/rewind.ts 的常量）；
// - 页面里的记录器（window.__fsRw）：每个会话面板的 Rewinding… / Undoing… 一行、发送按钮、各条消息上的 Rewind 是否
//   可点，以及冲突对话框的按钮（Restoring… / Undoing… 这样一闪而过的状态轮询抓不到）；
// - 结束 Mori 的整棵进程树再启动（模拟运行中途崩溃）；步骤出错时关掉盖住窗口的冲突对话框、菜单与 F8 报告框；
// - 会话文件：你的消息的条目 id、当前分支（从最后一条条目沿 parentId 走回去）、mori.turn_changes、mori.wake、mori.pick；
// - 消息上的 Rewind 与菜单、选一项后的结果（完成、冲突、错误）、冲突对话框、通知与 Undo、输入框、焦点与键盘；
// - 右栏的 Refresh、范围菜单、F8 报告里的操作记录（Recent activity）、测试项目的 git 状态。
// 只读页面和磁盘、发界面操作，不改 Mori 的源码；模型的回复全部来自合成端点（synthetic）。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  oneLine, paneSel, poll, readJsonl, reloadFsUi, restartFsApp, sendFs, sleep, startFsApp,
} from './fs-helpers.mjs';
import { contentText, customOf, showTab } from './tb-helpers.mjs';

// ---------- 文字（file-system.md §5.5–§5.11、§14，fs-rewind.md） ----------

/** 菜单各行的文字（data-testid 为 rewind-<键>） */
export const MENU_LABELS = Object.freeze({
  'code-conversation': 'Restore code and conversation',
  conversation: 'Restore conversation',
  code: 'Restore code',
  'no-code': 'No code restore',
  cancel: 'Never mind',
});

/** 规格与状态表里的原文 */
export const REWIND_TEXT = Object.freeze({
  /** 按钮平时的悬停与会话忙时的悬停 */
  title: 'Rewind to before this message',
  stillRunning: 'Still running',
  /** 冲突对话框 */
  dialogTitle: 'Restore these files anyway?',
  dialogRewind: 'These files changed after this session’s last snapshot, or while another session was running in '
    + 'this folder. Restoring them discards those changes.',
  dialogUndo: 'These files changed after the rewind. Undoing it discards those changes.',
  reasons: Object.freeze({ changed: 'Changed since the last snapshot', overlap: 'Another session was running' }),
  /** 第二次调用进行中点的那个按钮 */
  restoring: 'Restoring…',
  undoingButton: 'Undoing…',
  /** 对话流末尾的进行中一行 */
  rewinding: 'Rewinding…',
  undoing: 'Undoing…',
  /** 后台进程的拒绝（§5.10） */
  rewindingPrompt: 'This session is rewinding. Send your message when it’s done.',
  alreadyRewinding: 'This session is already rewinding.',
  /** 没装 git 时右栏的一行（§5.1） */
  gitRequired: 'Git is required to track changes and rewind.',
  /** Undo 完成的通知 */
  undone: 'Rewind undone',
});

/** @brief 需求还开着时菜单下面的一行（§5.5，一个需求）。 */
export const blockedText = (n) => `Request ${n} is still open. The conversation can’t go back to before it was `
  + 'registered.';

/** @brief 通知的第一段（fs-rewind.md "完成"）：n 是记录的 turn。 */
export const NOTICE_TEXT = Object.freeze({
  both: (n) => `Restored code and conversation to before turn ${n}`,
  code: (n) => `Restored code to before turn ${n}`,
  conversation: (n) => `Restored conversation to before turn ${n}`,
});

/** 菜单的几种形状（§5.5 的表），按显示的顺序 */
export const MENU = Object.freeze({
  /** 有 code restore，之后有改动 */
  full: ['code-conversation', 'conversation', 'code', 'cancel'],
  /** 没有 code restore，之后有改动 */
  noCode: ['conversation', 'no-code', 'cancel'],
  /** 之后没有改动（有没有 code restore 都一样） */
  short: ['conversation', 'cancel'],
});

/** @brief 菜单的一种形状写成 "<键>:<文字>"（比较用）。 */
export const menuLines = (ids) => ids.map((id) => `${id}:${MENU_LABELS[id]}`);
/** @brief 读到的菜单写成 "<键>:<文字>"。 */
export const menuShape = (menu) => (menu?.rows ?? []).map((row) => `${row.id}:${row.label}`);
/** @brief 读到的菜单写成 "<键>:<是否不可选>"。 */
export const menuDisabled = (menu) => (menu?.rows ?? []).map((row) => `${row.id}:${row.disabled}`);

/** 会话文件写下记录之后，等界面收到同一批事件的时间（毫秒） */
const UI_SETTLE = 400;

// ---------- App 与页面里的记录器 ----------

/**
 * @brief 在页面里装 Rewind 的记录器（window.__fsRw，已装时不动）：每个会话面板的状态变了就记一项
 *        { t, tab, progress（进行中一行的文字或 null）, kind（data-kind）, atEnd（进行中一行在对话流的全部条目之后）,
 *          send（发送按钮 { disabled, title } 或 null）, buttons（Rewind 按钮数）, enabled（其中能点的个数）,
 *          dialog（冲突对话框 { kind, buttons: [{ id, text, disabled }], rows: ['<路径>|<原因>'] } 或 null） }。
 */
export function watchRewind(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__fsRw) return;
    window.__fsRw = [];
    const last = new Map();
    const text = (el) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    const dialogState = () => {
      const dialog = document.querySelector('[data-testid="rewind-conflicts"]');
      if (!dialog) return null;
      return { kind: dialog.dataset.kind ?? null,
        buttons: [...dialog.querySelectorAll('.dialog-actions button')].map((button) => ({
          id: button.dataset.testid ?? null, text: text(button), disabled: button.disabled })),
        rows: [...dialog.querySelectorAll('[data-testid="rewind-conflict"]')]
          .map((row) => `${row.dataset.path}|${row.dataset.reason}`) };
    };
    const paneOf = (pane) => {
      const progress = pane.querySelector('[data-testid="rewind-progress"]');
      const items = [...pane.querySelectorAll('[data-item]')];
      const send = pane.querySelector('.composer .send-button');
      const buttons = [...pane.querySelectorAll('[data-testid="rewind-button"]')];
      return { progress: text(progress), kind: progress?.dataset.kind ?? null,
        atEnd: progress ? items.every((el) => Boolean(el.compareDocumentPosition(progress)
          & Node.DOCUMENT_POSITION_FOLLOWING)) : null,
        send: send ? { disabled: send.disabled, title: send.getAttribute('title') } : null,
        buttons: buttons.length, enabled: buttons.filter((el) => el.getAttribute('aria-disabled') !== 'true').length };
    };
    const scan = () => {
      const dialog = dialogState();
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const state = { ...paneOf(pane), dialog };
        const key = JSON.stringify(state);
        if (last.get(pane.dataset.tab) === key) continue;
        last.set(pane.dataset.tab, key);
        window.__fsRw.push({ t: Date.now(), tab: pane.dataset.tab, ...state });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
    scan();
  });
}

/** @brief 记录器记下的这个会话面板的状态（since 之后，按先后）。 */
export const rewindStates = (ctx, tab, since = 0) => ctx.page.evaluate(({ key, from }) => (window.__fsRw ?? [])
  .filter((item) => item.tab === key && item.t >= from), { key: tab, from: since });

/** @brief 启动 Mori（fs-helpers startFsApp），再装 Rewind 的记录器。 */
export async function startRewindApp(ctx, opts = {}) {
  await startFsApp(ctx, opts);
  await watchRewind(ctx);
  return ctx.page;
}

/** @brief 用同一个数据目录重新启动 Mori（ctx.env 可换环境变量），再装记录器；之后要重新打开会话。 */
export async function restartRewindApp(ctx, opts = {}) {
  await restartFsApp(ctx, opts);
  await watchRewind(ctx);
  return ctx.page;
}

/** @brief 界面重新载入（同 Ctrl+R，后台进程不停），再装记录器；之后要重新打开会话。 */
export async function reloadRewindUi(ctx) {
  await reloadFsUi(ctx);
  await watchRewind(ctx);
}

/**
 * @brief 不经有序关闭直接结束 Mori 的整棵进程树（taskkill /T /F，同 tb-helpers killRestartTbApp；后台进程随之在运行
 *        中途没了，会话文件里不再写任何东西，同崩溃），再用同一个数据目录启动（startRewindApp）；之后要重新打开会话。
 */
export async function killRestartRewindApp(ctx) {
  const pid = ctx.app?.process()?.pid ?? null;
  ctx.app = null;
  ctx.page = null;
  ctx.projectTabs = {};
  if (pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (error) {
      console.error(`[fs-app-rewind] taskkill ${pid} failed (already gone?): ${String(error?.message ?? error)}`);
    }
  }
  await sleep(1000);
  return startRewindApp(ctx);
}

/** @brief F8 报告框里能点的 Close 或 Cancel（保存中 Cancel 不可用，保存完是 Close）。 */
const issueCloser = (dialog) => dialog.locator('button:not(:disabled)', { hasText: /^(Close|Cancel)$/ }).first();

/**
 * @brief 关掉还开着的冲突对话框（等第二次调用返回、Cancel 可用再点）、Rewind 菜单（Esc）与 F8 报告框：它们盖住窗口，
 *        步骤中途抛错时留着会让后面的步骤点不到侧栏和输入框。没有页面时不动。
 */
export async function closeRewindOverlays(ctx) {
  if (!ctx.page) return;
  const dialog = ctx.page.getByTestId('rewind-conflicts');
  const cancel = dialog.getByTestId('rewind-conflict-cancel');
  // 第二次调用还在进行时三个按钮都不可用：等它返回（对话框关上，或换成新的列表、Cancel 可用）
  await poll(async () => (await dialog.count()) === 0 || cancel.isEnabled({ timeout: 1000 }).catch(() => false),
    180000, 250);
  if (await dialog.count()) {
    await cancel.click({ timeout: 5000 });
    await dialogGone(ctx);
  }
  await closeRewindMenu(ctx);
  const issue = ctx.page.getByTestId('issue-dialog');
  if (await issue.count()) {
    await poll(async () => (await issueCloser(issue).count()) > 0, 30000, 250);
    await issueCloser(issue).click({ timeout: 5000 });
    await issue.waitFor({ state: 'detached', timeout: 5000 });
  }
}

// ---------- 会话文件 ----------

/** @brief 会话文件里的条目（去掉第一行会话头部）；文件不存在时为 []。 */
export const sessionEntries = (file) => readJsonl(file).slice(1);

/** @brief 条目列表里某种自定义条目（整条，带 id）。 */
export const customEntries = (entries, type) => entries.filter((entry) => entry.type === 'custom'
  && entry.customType === type);

/** @brief 会话文件里 role 为 user 的消息条目：[{ id, text }]，按先后。 */
export function userMessages(file) {
  return sessionEntries(file).filter((entry) => entry.type === 'message' && entry.message?.role === 'user')
    .map((entry) => ({ id: entry.id, text: contentText(entry.message.content) }));
}

/** @brief 文字含 marker 的最后一条 user 消息的条目 id；没有时为 null。 */
export const entryIdOf = (file, marker) => userMessages(file).findLast((item) => item.text.includes(marker))?.id
  ?? null;

/** @brief 等会话文件里出现文字含 marker 的 user 消息，返回它的条目 id；超时时报错。 */
export async function waitEntry(who, marker, timeout = 20000) {
  const id = await poll(() => (who.sessionFile ? entryIdOf(who.sessionFile, marker) : null), timeout, 200);
  if (!id) throw new Error(`no user message with "${oneLine(marker, 60)}" in ${who.sessionFile}`);
  return id;
}

/**
 * @brief 当前分支：从会话文件的最后一条条目沿 parentId 走到根，按先后（Rewind 恢复对话后后台进程在新的叶子之后
 *        写 mori.pick 与 mori.rewind，所以最后一条就是当前叶子）。
 */
export function branchOf(file) {
  const entries = sessionEntries(file);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  let at = entries.at(-1) ?? null;
  while (at && branch.length <= entries.length) {
    branch.unshift(at);
    at = at.parentId ? byId.get(at.parentId) ?? null : null;
  }
  return branch;
}

/** @brief 条目是不是某种自定义条目。 */
const isCustom = (entry, type) => entry?.type === 'custom' && entry.customType === type;

/**
 * @brief 分支上最后一条 mori.rewind 之前、中间没有消息条目的最近一条 mori.pick 的值（§5.8 "再记一次选择范围"）；
 *        分支上没有 mori.rewind、或往回先碰到消息条目时为 null。
 */
export function pickBeforeRewind(branch) {
  const index = branch.findLastIndex((entry) => isCustom(entry, 'mori.rewind'));
  for (let i = index - 1; i >= 0; i -= 1) {
    if (branch[i].type === 'message') return null;
    if (isCustom(branch[i], 'mori.pick')) return branch[i].data?.pick ?? null;
  }
  return null;
}

/** @brief 分支最后几条的概括（检查的 detail）：类型、自定义类型与 mori.pick 的值。 */
export const branchTail = (branch, n = 5) => branch.slice(-n).map((entry) => [entry.type, entry.customType,
  entry.message?.role, entry.data?.pick, entry.data?.kind].filter(Boolean).join(':'));

/** @brief 会话文件里全部 mori.pick 条目的个数（所有分支）。 */
export const pickCount = (file) => customEntries(sessionEntries(file), 'mori.pick').length;

/** @brief 会话文件里的 mori.turn_changes 记录（所有分支，按先后）。 */
export const turnRecords = (file) => customOf(sessionEntries(file), 'mori.turn_changes');

/** @brief 会话文件里 mori.wake 指向的消息的条目 id。 */
export const wakeIds = (file) => customOf(sessionEntries(file), 'mori.wake').map((wake) => wake.messageId);

/** @brief 会话文件里最后一条 mori.rewind 条目（整条，带 id 与 data）；没有时为 null。 */
export const lastRewindEntry = (file) => customEntries(sessionEntries(file), 'mori.rewind').at(-1) ?? null;

/**
 * @brief 等这一轮的 run 记录（§4.6：运行结束快照做完时写）写进会话文件；changes 为真时还要有这一轮的 changes 记录。
 *        记录写下之后再等一会儿，让界面收到同一批事件。
 * @return run 记录；超时为 null
 */
export async function waitRun(file, round, { changes = false, timeout = 90000 } = {}) {
  const run = await poll(() => {
    const records = turnRecords(file);
    const found = records.find((record) => record.kind === 'run' && record.round === round);
    if (!found) return null;
    return !changes || records.some((record) => record.kind === 'changes' && record.round === round) ? found : null;
  }, timeout, 250);
  if (run) await sleep(UI_SETTLE);
  return run;
}

/**
 * @brief 发一条消息，等运行结束（要求没有出卡）、它的条目 id 与这一轮的 run 记录（changes 为真时还要 changes 记录）。
 * @param who openFsSession 的结果
 * @param opts { marker（认这条消息的文字，默认全文）, changes }
 * @return 这条消息的条目 id
 */
export async function sendTurn(ctx, who, text, { marker = text, changes = false } = {}) {
  const { outcome } = await sendFs(ctx, who, text, { timeout: 120000 });
  if (outcome !== 'idle') throw new Error(`"${oneLine(text, 60)}" showed an approval card`);
  const entry = await waitEntry(who, marker);
  if (!(await waitRun(who.sessionFile, entry, { changes }))) {
    throw new Error(`no run record${changes ? ' or changes record' : ''} for "${oneLine(text, 60)}"`);
  }
  return entry;
}

/** @brief 等这个会话面板进入生成中（data-running 为 true）；进入时为 true。 */
export const waitRunning = (ctx, tab, timeout = 30000) => ctx.page.waitForFunction((css) => document
  .querySelector(css)?.dataset.running === 'true', paneSel(tab), { timeout }).then(() => true, () => false);

// ---------- 消息上的 Rewind 与菜单 ----------

/** @brief 一条消息上的 Rewind 按钮的选择器。 */
const buttonSel = (tab, entry) => `${paneSel(tab)} [data-testid="rewind-button"][data-entry="${entry}"]`;

/**
 * @brief 一条消息上的 Rewind：{ disabled（aria-disabled）, title（悬停）, text, opacity（外层 .user-actions 的
 *        不透明度：悬停或焦点在消息里时为 1） }；没有按钮时为 null。
 */
export function rewindButtonOf(ctx, tab, entry) {
  return ctx.page.evaluate((css) => {
    const button = document.querySelector(css);
    if (!button) return null;
    return { disabled: button.getAttribute('aria-disabled') === 'true', title: button.getAttribute('title'),
      text: button.textContent.trim(), opacity: getComputedStyle(button.parentElement).opacity };
  }, buttonSel(tab, entry));
}

/** @brief 这个会话面板里 Rewind 按钮的个数。 */
export const rewindButtonCount = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="rewind-button"]`)
  .count();

/**
 * @brief 开着的 Rewind 菜单：{ rows（[{ id, label, disabled, focusable }]，按显示的顺序）, blocked（需求还开着的一行
 *        { text, requests（data-requests）, describes（菜单的 aria-describedby 指向它） } 或 null）, focused（菜单里有焦点的
 *        那一项的 data-testid，焦点不在菜单里为 null） }；菜单没开时为 null。
 */
export function rewindMenuState(ctx) {
  return ctx.page.evaluate(() => {
    const menu = document.querySelector('[data-testid="rewind-menu"]');
    if (!menu) return null;
    const rows = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => ({
      id: (el.dataset.testid ?? '').replace(/^rewind-/, ''), label: el.textContent.trim(),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      focusable: el.tagName === 'BUTTON' && !el.disabled }));
    const note = menu.querySelector('[data-testid="rewind-blocked"]');
    const active = document.activeElement;
    return { rows, focused: menu.contains(active) ? active.dataset.testid ?? null : null,
      blocked: note ? { text: note.textContent.trim(), requests: note.dataset.requests ?? null,
        describes: Boolean(note.id) && menu.getAttribute('aria-describedby') === note.id } : null };
  });
}

/** @brief 悬停在消息上再点它的 Rewind，等菜单出现；返回 rewindMenuState。 */
export async function openRewindMenu(ctx, tab, entry) {
  await showTab(ctx, tab);
  const button = ctx.page.locator(buttonSel(tab, entry));
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  await button.click();
  await ctx.page.getByTestId('rewind-menu').waitFor({ timeout: 5000 });
  return rewindMenuState(ctx);
}

/** @brief 菜单是否在 5 秒内从页面上消失。 */
export const menuGone = (ctx) => ctx.page.getByTestId('rewind-menu').waitFor({ state: 'detached', timeout: 5000 })
  .then(() => true, () => false);

/** @brief 按 Esc 关掉开着的 Rewind 菜单（等于 Never mind），等它消失。 */
export async function closeRewindMenu(ctx) {
  if (!(await ctx.page.getByTestId('rewind-menu').count())) return;
  await ctx.page.keyboard.press('Escape');
  await menuGone(ctx);
}

/** @brief 打开一条消息的菜单、读出来、按 Esc 关掉；返回 rewindMenuState。 */
export async function menuOf(ctx, tab, entry) {
  const menu = await openRewindMenu(ctx, tab, entry);
  await closeRewindMenu(ctx);
  return menu;
}

/**
 * @brief 点一个不可点（aria-disabled）的 Rewind（强制点，不等它变得可用），看半秒内有没有菜单出现。
 * @return 出现了菜单时为 true（那时按 Esc 关掉）
 */
export async function clickDisabledRewind(ctx, tab, entry) {
  await ctx.page.locator(buttonSel(tab, entry)).click({ force: true, timeout: 5000 });
  await sleep(500);
  const opened = (await ctx.page.getByTestId('rewind-menu').count()) > 0;
  if (opened) await closeRewindMenu(ctx);
  return opened;
}

// ---------- 结果、冲突对话框与通知 ----------

/** @brief 打开菜单、点 rewind-<item>；返回点之前的时刻（记录器与 waitRewindOutcome 从它起算）。 */
export async function clickRewindItem(ctx, tab, entry, item) {
  await openRewindMenu(ctx, tab, entry);
  const since = Date.now();
  await ctx.page.getByTestId('rewind-menu').getByTestId(`rewind-${item}`).click();
  return since;
}

/** @brief 此刻这个会话面板的 Rewind 情况：进行中、错误行、冲突对话框（是否在第二次调用中）。 */
function rewindNow(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const dialog = document.querySelector('[data-testid="rewind-conflicts"]');
    return { progress: Boolean(pane?.querySelector('[data-testid="rewind-progress"]')),
      error: pane?.querySelector('[data-testid="rewind-error"]')?.textContent.trim() ?? null,
      dialog: Boolean(dialog), pending: Boolean(dialog?.querySelector('.dialog-actions button:disabled')) };
  }, paneSel(tab));
}

/**
 * @brief 等 since 之后发起的那一次 rewind / rewind.undo 返回：记录器记到过进行中一行、它又消失之后，有错误行为 error
 *        （text 为原文），冲突对话框开着（不在第二次调用中）为 conflicts，否则为 done。
 * @return { since, outcome, text? }；超时时报错
 */
export async function waitRewindOutcome(ctx, tab, since, timeout = 180000) {
  const result = await poll(async () => {
    const states = await rewindStates(ctx, tab, since);
    if (!states.some((state) => state.progress)) return null;
    const now = await rewindNow(ctx, tab);
    if (now.progress) return null;
    if (now.error) return { outcome: 'error', text: now.error };
    return { outcome: now.dialog && !now.pending ? 'conflicts' : 'done' };
  }, timeout, 150);
  if (!result) throw new Error(`no rewind result in ${tab} within ${timeout} ms`);
  return { since, ...result };
}

/** @brief 选菜单里的一项并等结果（waitRewindOutcome）。 */
export async function chooseRewind(ctx, tab, entry, item) {
  const since = await clickRewindItem(ctx, tab, entry, item);
  return waitRewindOutcome(ctx, tab, since);
}

/**
 * @brief 冲突对话框：{ kind, title, text（说明）, rows（[{ path, reason, label }]）, more（and {n} more 或 null）,
 *        buttons（[{ id, text, disabled }]，按顺序）, focused（对话框里有焦点的元素的 data-testid，对话框本身为
 *        "dialog"，焦点不在对话框里为 null） }；没开时为 null。
 */
export function conflictsDialog(ctx) {
  return ctx.page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="rewind-conflicts"]');
    if (!dialog) return null;
    const text = (el) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    const active = document.activeElement;
    const focused = !dialog.contains(active) ? null : active === dialog ? 'dialog' : active.dataset.testid ?? null;
    return { kind: dialog.dataset.kind ?? null, title: text(dialog.querySelector('h2')),
      text: text(dialog.querySelector('p')), more: text(dialog.querySelector('.rewind-conflict.more')), focused,
      rows: [...dialog.querySelectorAll('[data-testid="rewind-conflict"]')].map((row) => ({ path: row.dataset.path,
        reason: row.dataset.reason, label: text(row.querySelector('.rewind-conflict-reason')) })),
      buttons: [...dialog.querySelectorAll('.dialog-actions button')].map((button) => ({
        id: button.dataset.testid ?? null, text: text(button), disabled: button.disabled })) };
  });
}

/** @brief 冲突对话框是否在 5 秒内消失。 */
export const dialogGone = (ctx) => ctx.page.getByTestId('rewind-conflicts').waitFor({ state: 'detached',
  timeout: 5000 }).then(() => true, () => false);

/** @brief 点冲突对话框的 Overwrite（rewind-overwrite）或 Skip these files（rewind-skip），等这次调用的结果。 */
export async function resolveConflict(ctx, tab, id) {
  const since = Date.now();
  await ctx.page.getByTestId('rewind-conflicts').getByTestId(id).click();
  return waitRewindOutcome(ctx, tab, since);
}

/**
 * @brief 记录器里第二次调用进行中的样子：三个按钮都不可用，id 那个按钮写 text（Restoring… / Undoing…）。
 * @param states rewindStates 的结果
 */
export const pendingSeen = (states, id, text) => states.some((state) => state.dialog
  && state.dialog.buttons.length === 3 && state.dialog.buttons.every((button) => button.disabled)
  && state.dialog.buttons.find((button) => button.id === id)?.text === text);

/**
 * @brief 这个会话面板里的通知（按对话流顺序）：{ kind, code, conversation, text（第一行，不含展开的列表）,
 *        undo（{ disabled, title } 或 null）, warning（下一行或 null）, list（展开后列出的行） }。
 */
export function noticesOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="rewind-notice"]`).evaluateAll((els) => els.map((el) => {
    const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const line = el.firstElementChild;
    const own = line ? [...line.childNodes].filter((node) => node.nodeName !== 'UL')
      .map((node) => node.textContent).join('') : '';
    const undo = el.querySelector('[data-testid="rewind-undo"]');
    return { kind: el.dataset.kind ?? null, code: el.dataset.code === 'true',
      conversation: el.dataset.conversation === 'true', text: flat(own),
      undo: undo ? { disabled: undo.getAttribute('aria-disabled') === 'true', title: undo.getAttribute('title') }
        : null,
      warning: el.querySelector('.rewind-warning') ? flat(el.querySelector('.rewind-warning').textContent) : null,
      list: [...el.querySelectorAll('.rewind-notice-list li')].map((li) => flat(li.textContent)) };
  }));
}

/** @brief 点最后一条通知上的 Undo；返回点之前的时刻。 */
export async function clickUndo(ctx, tab) {
  await showTab(ctx, tab);
  const undo = ctx.page.locator(`${paneSel(tab)} [data-testid="rewind-notice"]`).last()
    .getByTestId('rewind-undo');
  await undo.scrollIntoViewIfNeeded();
  const since = Date.now();
  await undo.click();
  return since;
}

/** @brief 展开最后一条通知里的跳过（rewind-skipped）或失败（rewind-failed）的文件；返回展开后的通知。 */
export async function expandNotice(ctx, tab, testId) {
  await ctx.page.locator(`${paneSel(tab)} [data-testid="rewind-notice"]`).last().getByTestId(testId).click();
  return (await noticesOf(ctx, tab)).at(-1) ?? null;
}

/** @brief 这个会话面板里出现过某段文字的元素个数（例如 Redo）。 */
export const textCount = (ctx, tab, text) => ctx.page.locator(paneSel(tab)).getByText(text, { exact: true }).count();

// ---------- 输入框、焦点与键盘 ----------

/** @brief 这个会话输入框此刻的文字与引用芯片（[{ kind, label, text }]）。 */
export function composerOf(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    return { draft: pane?.querySelector('.composer textarea')?.value ?? null,
      chips: [...(pane?.querySelectorAll('[data-testid="quote-chip"]') ?? [])].map((chip) => ({
        kind: chip.dataset.kind ?? null, label: chip.querySelector('.quote-chip-label')?.textContent ?? '',
        text: chip.querySelector('.quote-chip-text')?.textContent ?? '' })) };
  }, paneSel(tab));
}

/** @brief 把这个会话输入框的文字设成 text（不发送）。 */
export async function setDraft(ctx, tab, text) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).fill(text);
}

/** @brief 发送按钮此刻的样子：{ disabled, title }；没有发送按钮时为 null。 */
export const sendButtonOf = (ctx, tab) => ctx.page.evaluate((selector) => {
  const send = document.querySelector(`${selector} .composer .send-button`);
  return send ? { disabled: send.disabled, title: send.getAttribute('title') } : null;
}, paneSel(tab));

/**
 * @brief 此刻有焦点的元素：{ testid, entry（data-entry）, tag, inDialog（在冲突对话框里）, opacity（是 Rewind 时它外层
 *        .user-actions 的不透明度，否则 null） }。
 */
export function focusInfo(ctx) {
  return ctx.page.evaluate(() => {
    const el = document.activeElement;
    const rewind = el?.dataset?.testid === 'rewind-button';
    return { testid: el?.dataset?.testid ?? null, entry: el?.dataset?.entry ?? null, tag: el?.tagName ?? null,
      inDialog: Boolean(el?.closest?.('[data-testid="rewind-conflicts"]')),
      opacity: rewind ? getComputedStyle(el.parentElement).opacity : null };
  });
}

/**
 * @brief 从这个会话的输入框起按 Shift+Tab，直到焦点落在 entry 那条消息的 Rewind 上（按钮一直在 Tab 顺序里，§5.5）。
 * @return 按了几次；max 次之内没到时为 -1
 */
export async function tabToRewind(ctx, tab, entry, max = 80) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).focus();
  for (let i = 1; i <= max; i += 1) {
    await ctx.page.keyboard.press('Shift+Tab');
    const at = await focusInfo(ctx);
    if (at.testid === 'rewind-button' && at.entry === entry) return i;
  }
  return -1;
}

/** @brief 依次按 keys 里的键，每按一次记下焦点所在元素的 data-testid。 */
export async function walkKeys(ctx, keys) {
  const seen = [];
  for (const key of keys) {
    await ctx.page.keyboard.press(key);
    seen.push((await focusInfo(ctx)).testid);
  }
  return seen;
}

// ---------- 右栏、范围菜单、F8 与测试项目 ----------

/** @brief 打开这个会话的右栏（顶栏的 Toggle changes，aria-pressed 不为 true 时点），等 Changes 视图出现。 */
export async function openChanges(ctx, tab) {
  await showTab(ctx, tab);
  const toggle = ctx.page.locator(`${paneSel(tab)} .right-toggle`);
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await ctx.page.getByTestId('changes').waitFor({ timeout: 10000 });
}

/** @brief 点右栏的 Refresh（记进操作记录 Refresh changes），等刷新结束（data-busy 消失）。 */
export async function refreshChanges(ctx, tab) {
  await openChanges(ctx, tab);
  await ctx.page.getByTestId('changes-refresh').click();
  await ctx.page.waitForFunction(() => !document.querySelector('[data-testid="changes-refresh"][data-busy]'), null,
    { timeout: 20000 });
}

/** @brief 等右栏出现没装 git 的一行（data-state missing），返回它的文字；超时为 null。 */
export async function waitGitMissing(ctx, timeout = 30000) {
  const css = '[data-testid="git-required"][data-state="missing"]';
  const ok = await ctx.page.locator(css).first().waitFor({ timeout }).then(() => true, () => false);
  return ok ? (await ctx.page.locator(css).first().textContent())?.trim() ?? null : null;
}

/**
 * @brief 在这个会话输入框下面一行的范围菜单里选 pick（data-pick），等范围按钮显示它、不再是切换中（同
 *        v1-models-app-session choosePick）。
 */
export async function choosePick(ctx, tab, pick) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="model-button"]`).click();
  await ctx.page.locator(`${paneSel(tab)} [data-testid="model-menu"] [role="menuitemradio"][data-pick="${pick}"]`)
    .click();
  await ctx.page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    return button?.dataset.pick === want && !button.getAttribute('aria-disabled');
  }, { selector: paneSel(tab), want: pick }, { timeout: 15000 });
}

/** @brief 这个会话范围按钮的 data-pick；没有按钮时为 null。 */
export const pickOf = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="model-button"]`)
  .getAttribute('data-pick').catch(() => null);

/** @brief Markdown 里 "## <title>" 那一节的正文（同 fs-app-gate）。 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/**
 * @brief 按 F8、写一句、Save、关上报告框，返回那份报告里的操作记录（"Recent activity" 一节，同 fs-app-gate 读法；
 *        操作记录只留最近 30 条，所以每段流程做完就读）。找不到报告时为空串。
 * @param what 写进报告的一句（带时刻，按它在 <数据目录>\ui-issues 里找这一份）
 */
export async function recentActivity(ctx, tab, what) {
  const marker = `${what} ${Date.now()}`;
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).focus();
  await ctx.page.keyboard.press('F8');
  const dialog = ctx.page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(marker);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByTestId('issue-saved').waitFor({ timeout: 15000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  const dir = join(ctx.userData, 'ui-issues');
  if (!existsSync(dir)) return '';
  const md = readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(dir, name),
    'utf8')).find((text) => text.includes(marker)) ?? '';
  return section(md, 'Recent activity');
}

/** @brief 操作记录里缺的那些行（want 里不在 actions 中的）。 */
export const missingActions = (actions, want) => want.filter((line) => !actions.includes(line));

/** @brief 在测试项目里跑 git，返回标准输出。 */
export const gitOut = (project, args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });

/**
 * @brief 测试项目的 git 状态：{ head（HEAD 的提交）, branch（symbolic-ref）, index（ls-files -s，你的 index）,
 *        status（status --porcelain 的各行，排好序） }。
 */
export function repoState(project) {
  return { head: gitOut(project, ['rev-parse', 'HEAD']).trim(), branch: gitOut(project, ['symbolic-ref', 'HEAD'])
    .trim(), index: gitOut(project, ['ls-files', '-s']),
  status: gitOut(project, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean).sort() };
}

/** @brief 目录里的文件数（不存在时为 null）。 */
export const fileCount = (dir) => (existsSync(dir) ? readdirSync(dir).length : null);
