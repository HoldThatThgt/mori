// 文件系统规格（docs/specs/file-system.md §19.1、§19.2；续篇 file-system-permissions.md §9、§10）的两个 App 套件
// fs-app-away.mjs（你不在，FS-69–81）与 fs-app-question.mjs（提问卡，FS-83–90）共用的准备、操作与读取，接在
// fs-helpers.mjs 之后：
// - §14 与屏幕表 docs/v1/screens/fs-question.md 的原文（自动拒绝、提醒、提问的四种结果、转给立项、倒计时、
//   Decided while you were away、设置页 General）；
// - 窗口焦点（synthetic test setup）：在主进程里把主窗口的 isFocused 换成测试给的值，再发窗口的 blur / focus 事件，
//   或真的 minimize / restore。测试进程不在前台时 Windows 不肯把焦点交给 Mori（同 m2-app.mjs emitMainFocus 的原因），
//   所以 OS 的焦点由测试给出；主进程按 §9.1 的式子（有焦点且没最小化）重算并告诉后台进程的那一段照常运行。
//   flashFrame 同时记下调用（任务栏闪烁，FS-89）；
// - 后台进程的事件、会话文件里的条目与提醒、记录代理收到的请求；
// - 提问卡、扩展询问卡、倒计时、一轮末尾的那一块、对话流的顺序；
// - synthetic 的项目扩展：经 ctx.ui 询问的工具（FS-74、FS-77）、停止中嵌套调用提问工具的工具（FS-88）与在提问卡、
//   批准卡旁边发扩展询问的 tool_call 处理器（FS-89）。
// 只读页面和磁盘、发界面操作，不改 Mori 的源码；模型的回复全部来自合成端点。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMINDER_PREFIX, askArgs, isReminder } from '../fake-endpoint/away.mjs';
import { WORK_CARD_OPEN, sessionOf } from '../fake-endpoint/scripts.mjs';
import {
  answerCard, appLogLines, bridge, kernelEvents, oneLine, openFsSession, paneSel, poll, readJsonl, sendFs, sleep,
  waitCard,
} from './fs-helpers.mjs';
import { contentText, showTab } from './tb-helpers.mjs';

export { REMINDER_PREFIX, isReminder };

// ---------- 原文（file-system.md §14、fs-question.md） ----------

/** 设置的三档时长在原文里的写法（§9.6） */
export const DURATION = Object.freeze({ '60s': '60 seconds', '5m': '5 minutes', '10m': '10 minutes' });

/** @brief 批准卡到时回给模型的原文（§14 自动拒绝）；handoff 为真时是 task 实例、结案会话的最后一句。 */
export const awayDenial = (duration, handoff = false) => `The user was away and didn't answer within ${duration}, `
  + `so this was denied. Don't retry it. Mention it in your ${handoff ? 'handoff' : 'final summary'}.`;

/** @brief 提醒原文（§14）：第一行、每项一行、最后一句。 */
export const reminderText = (lines, handoff = false) => [REMINDER_PREFIX, ...lines,
  `Don't retry the denied calls. Mention all of these in your ${handoff ? 'handoff' : 'final summary'}.`].join('\n');

/** @brief 提问结果里的 "<问题>"="<答案>"，用 , 连接（§14）；pairs 为 [问题, 答案] 的列表。 */
export const pairsText = (pairs) => pairs.map(([question, answer]) => `"${question}"="${answer}"`).join(', ');
/** @brief 你提交时的工具结果（§14）。 */
export const answeredText = (pairs) => `User has answered your questions: ${pairsText(pairs)}. `
  + "You can now continue with the user's answers in mind.";
/** @brief 提问卡到时的工具结果（§14）。 */
export const awayAnswerText = (duration, pairs) => `The user was away and didn't answer within ${duration}, so your `
  + `recommended options were used: ${pairsText(pairs)}. Continue with them, and mention this in your final summary.`;
/** 拒绝回答（§12 ASK_DECLINED_TEXT） */
export const ASK_DECLINED = 'The user declined to answer your questions. Stop what you are doing and wait for the '
  + 'user to tell you how to proceed.';
/** 停止、会话关闭（§12 ASK_STOPPED_TEXT） */
export const ASK_STOPPED = 'Not answered: the user stopped the run.';
/** question.answer 的答复对不上问题时命令失败的原文（§10.5） */
export const ANSWERS_MISMATCH = 'Answers don’t match the questions.';
/** @brief 请求已结束时 question.answer 失败的原文（§10.5、§12）。 */
export const questionGone = (requestId) => `Question ${requestId} is no longer pending`;
/** @brief 请求已结束时 approval.answer 失败的原文（§9.5）。 */
export const approvalGone = (requestId) => `Approval request ${requestId} is no longer pending`;

/** 你不在时转给立项的答案后面加的说明（§14） */
export const NOT_USER_CHOICE = " (not the user's choice: they were away, so the recommended option was used)";
/** 转给立项的投递的固定开头（§14） */
export const FORWARD_LEAD = "[Mori] New user message: Answer to the dialog agent's question (ask_user_question): ";
/** @brief 转给立项的投递全文（§14）：parts 为 "<问题>"="<答案>" 的几段，用 ; 连接。 */
export const forwardText = (parts) => `${FORWARD_LEAD}${parts.join('; ')}\nMake exactly one decision for it.`;

/** 工具卡状态行：批准卡到时（§12 DENIAL_PREFIXES）、拒绝回答（§10.6） */
export const AWAY_DENIED = 'Denied · No answer while you were away';
export const DECLINED_STATUS = 'Denied · You declined to answer';
/** 提问卡挂着时工具卡与阶段行的文字（§10.6、§9.9） */
export const WAITING_ANSWER = 'Waiting for your answer';

/** 倒计时一行里三种卡各自的动作（fs-question.md "倒计时"） */
export const COUNTDOWN_ACTION = Object.freeze({
  approval: 'Denying', ask: 'Using the recommended options', extension: 'Cancelling' });
/** 倒计时一行的写法：You’re away · <动作> in <秒数>s */
export const COUNTDOWN_PATTERN = /^You’re away · (Denying|Using the recommended options|Cancelling) in (\d+)s$/;

/** 一轮末尾那一块的标题与说明行（fs-question.md "一轮末尾"） */
export const BLOCK_TITLE = 'Decided while you were away';
export const blockNote = (duration) => (duration ? `You didn’t answer within ${duration}, so Mori decided these.`
  : 'You didn’t answer in time, so Mori decided these.');

/** 设置页 General 的一行（fs-question.md "设置页"） */
export const AWAY_LABEL = 'When you’re away';
export const AWAY_OPTIONS = ['60 seconds', '5 minutes', '10 minutes', 'Never'];
export const AWAY_NOTE = 'When a permission request or question is waiting and Mori isn’t the active window, Mori '
  + 'answers it after this long: it denies permission requests, uses the recommended option for questions, and '
  + 'cancels extension prompts. The agent is told, and the turn lists what was decided.';

/** @brief 本地时间 HH:MM（一轮末尾每行右边的时间，同 renderer/state/away.ts）。 */
export function hourMinute(ms) {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':');
}

// ---------- 窗口焦点（主进程里运行的函数经 app.evaluate 序列化，只能用参数里的 electron 模块） ----------

/**
 * @brief synthetic test setup：把主窗口的 isFocused 换成 globalThis.__fsFocus.focused（初值 true），flashFrame 换成先
 *        记下调用再照常闪烁的版本；已经装过时不动。只换主窗口，其他窗口照旧。
 */
function installFocusMain({ BrowserWindow }) {
  if (globalThis.__fsFocus) return;
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  const proto = BrowserWindow.prototype;
  const realFocused = proto.isFocused;
  const realFlash = proto.flashFrame;
  const state = { id: main.id, focused: true, flashes: [] };
  const mine = (window) => {
    try {
      return window.id === state.id;
    } catch {
      return false;
    }
  };
  Object.defineProperty(proto, 'isFocused', { configurable: true, writable: true, value() {
    return mine(this) ? globalThis.__fsFocus.focused : realFocused.call(this);
  } });
  Object.defineProperty(proto, 'flashFrame', { configurable: true, writable: true, value(flag) {
    if (mine(this)) globalThis.__fsFocus.flashes.push({ t: Date.now(), flag });
    return realFlash.call(this, flag);
  } });
  globalThis.__fsFocus = state;
}

/** @brief 设主窗口“有没有焦点”并发出 focus / blur 事件（主进程的四个事件之一，§9.1）。 */
function setFocusMain({ BrowserWindow }, focused) {
  const state = globalThis.__fsFocus;
  state.focused = focused;
  BrowserWindow.fromId(state.id)?.emit(focused ? 'focus' : 'blur');
}

/** @brief 只发 focus / blur 事件，不改“有没有焦点”（值不变时主进程不发）。 */
function emitMain({ BrowserWindow }, name) {
  BrowserWindow.fromId(globalThis.__fsFocus.id)?.emit(name);
}

/** @brief 真的最小化或还原主窗口（主进程收到 minimize / restore 事件）。 */
function sizeMain({ BrowserWindow }, action) {
  const main = BrowserWindow.fromId(globalThis.__fsFocus.id);
  if (action === 'minimize') main?.minimize();
  else main?.restore();
}

/** @brief 主窗口此刻：是否最小化、测试给的焦点、flashFrame 的调用（{ t, flag }）。 */
function stateMain({ BrowserWindow }) {
  const state = globalThis.__fsFocus;
  const main = BrowserWindow.fromId(state.id);
  return { minimized: main?.isMinimized() ?? null, focused: state.focused, flashes: state.flashes };
}

/** @brief 装上焦点的替身（每次启动 App 之后调用一次），并让主进程按“有焦点”告诉后台进程一次。 */
export async function installFocus(ctx) {
  await ctx.app.evaluate(installFocusMain);
  await ctx.app.evaluate(setFocusMain, true);
}

/** @brief 设测试给的焦点并记进 ctx.focusHistory（{ t, focused }，FS-70 看卡到达时窗口在不在前台）。 */
async function setFocus(ctx, focused) {
  await ctx.app.evaluate(setFocusMain, focused);
  (ctx.focusHistory ??= []).push({ t: Date.now(), focused });
}

/** @brief 窗口失去焦点（blur）。 */
export const blurWindow = (ctx) => setFocus(ctx, false);
/** @brief 窗口拿回焦点（focus）。 */
export const focusWindow = (ctx) => setFocus(ctx, true);

/** @brief 时刻 t 窗口是否按测试给的焦点不在前台：t 之前最后一次 blurWindow / focusWindow 是 blur。 */
export const unfocusedAt = (ctx, t) => (ctx.focusHistory ?? []).filter((item) => item.t <= t).at(-1)?.focused
  === false;
/** @brief 只发一个 focus / blur 事件，不改测试给的焦点。 */
export const emitWindow = (ctx, name) => ctx.app.evaluate(emitMain, name);
/** @brief 主窗口此刻的状态（stateMain）。 */
export const windowState = (ctx) => ctx.app.evaluate(stateMain);

/** @brief 真的最小化（minimize）或还原（restore）主窗口，等 isMinimized 变过来（最多 5 秒）。 */
export async function sizeWindow(ctx, action) {
  await ctx.app.evaluate(sizeMain, action);
  const want = action === 'minimize';
  const done = await poll(async () => (await windowState(ctx)).minimized === want, 5000, 100);
  if (!done) throw new Error(`the main window did not ${action}`);
}

/** @brief 后台进程日志里 [kernel] window focus: 的值（since 之后，按出现的顺序，§9.1 的日志）。 */
export function focusLog(ctx, since) {
  return appLogLines(ctx, '[kernel] window focus:', since)
    .map((line) => /window focus: (true|false)/.exec(line)?.[1] ?? line);
}

/** @brief flashFrame 的调用（since 之后）：[true / false]。 */
export async function flashesSince(ctx, since) {
  return (await windowState(ctx)).flashes.filter((item) => item.t >= since).map((item) => item.flag);
}

// ---------- 进程桥 ----------

/** @brief 经进程桥发一条命令，出错时不抛出：{ result, error }（error 为后台进程的原文）。 */
export const tryBridge = (ctx, command) => ctx.page.evaluate((cmd) => window.mori.request(cmd)
  .then((result) => ({ result, error: null }), (error) => ({ result: null, error: String(error?.message ?? error) })),
command);

/** @brief away.set；结果不对时抛错。 */
export async function setAwayTimeout(ctx, timeout) {
  const result = await bridge(ctx, { type: 'away.set', timeout });
  if (result?.timeout !== timeout || result.error) throw new Error(`away.set ${timeout}: ${JSON.stringify(result)}`);
}

// ---------- 后台进程的事件 ----------

/** @brief 某种事件的载荷（这个会话，since 之后）：[{ t, ...data }]。 */
export async function eventsOfType(ctx, sid, type, since = 0) {
  return (await kernelEvents(ctx, sid, type, since)).map((item) => ({ t: item.t, ...item.data }));
}

/** @brief mori.away_timer（这个会话，since 之后）：[{ t, requestId, deadline }]。 */
export const timersOf = (ctx, sid, since = 0) => eventsOfType(ctx, sid, 'mori.away_timer', since);

/** @brief 等这个会话 since 之后出现满足 test 的某种事件，最多 timeout；返回它或 null。 */
export async function waitEvent(ctx, sid, type, test = () => true, { since = 0, timeout = 30000 } = {}) {
  return poll(async () => (await eventsOfType(ctx, sid, type, since)).find(test) ?? null, timeout, 150);
}

/**
 * @brief 页面记下的 mori.away_timer（deadline 不为 null）各自在同一信封上有没有更早的请求事件（mori.approval_request、
 *        mori.team_approval_request、mori.question_request、mori.ui_request；FS-70：计时总在请求事件之后到达）。
 * @return { checked（看过的计时数）, missing（没有更早请求事件的 { sid, requestId }）, kinds（找到的请求事件的种类）,
 *         items（找到了请求事件的计时：{ type, requestId, requestT, timerT, deadline }） }
 */
export function timerOrder(ctx, since = 0) {
  return ctx.page.evaluate((from) => {
    const types = new Set(['mori.approval_request', 'mori.team_approval_request', 'mori.question_request',
      'mori.ui_request']);
    const all = (window.__mp ?? []).filter((item) => item.t >= from);
    const out = { checked: 0, missing: [], kinds: [], items: [] };
    all.forEach((item, index) => {
      if (item.type !== 'mori.away_timer' || item.data.deadline === null) return;
      out.checked += 1;
      const request = all.slice(0, index).findLast((before) => before.sid === item.sid && types.has(before.type)
        && before.data.requestId === item.data.requestId);
      if (!request) {
        out.missing.push({ sid: item.sid, requestId: item.data.requestId });
        return;
      }
      if (!out.kinds.includes(request.type)) out.kinds.push(request.type);
      out.items.push({ type: request.type, requestId: item.data.requestId, requestT: request.t, timerT: item.t,
        deadline: item.data.deadline });
    });
    return out;
  }, since);
}

// ---------- 会话文件 ----------

/** @brief 会话文件里某种自定义条目（type custom、customType 为 type）的 data。 */
export const customEntries = (file, type) => readJsonl(file).filter((entry) => entry.type === 'custom'
  && entry.customType === type).map((entry) => entry.data);

/** @brief 会话文件里的自动处理记录（mori.away_decision 条目）。 */
export const awayRecords = (file) => customEntries(file, 'mori.away_decision');

/** @brief 会话文件里的提醒（custom_message，customType mori.away_reminder）：[{ display, content }]。 */
export const reminderEntries = (file) => readJsonl(file).filter((entry) => entry.type === 'custom_message'
  && entry.customType === 'mori.away_reminder').map((entry) => ({ display: entry.display,
  content: contentText(entry.content) }));

/** @brief 会话文件里的工具结果，带 details：[{ id, tool, isError, text, details }]。 */
export const resultEntries = (file) => readJsonl(file).filter((entry) => entry.type === 'message'
  && entry.message?.role === 'toolResult').map((entry) => ({ id: entry.message.toolCallId ?? null,
  tool: entry.message.toolName ?? null, isError: entry.message.isError === true,
  text: contentText(entry.message.content), details: entry.message.details ?? null }));

/** @brief 会话文件里条目的简表（按顺序）：[{ kind（user / assistant / toolResult / custom 的 customType / 其他 type）, text }]。 */
export function entryOrder(file) {
  return readJsonl(file).map((entry) => {
    if (entry.type === 'message') {
      return { kind: entry.message?.role ?? 'message', text: contentText(entry.message?.content).slice(0, 200) };
    }
    return { kind: entry.customType ?? entry.type, text: '' };
  });
}

// ---------- 记录代理收到的请求 ----------

/**
 * @brief 某个会话的对话请求：user 消息里有 marker 的（会话里第一条消息带的独有文字；为 null 时不按它筛，只看 since），
 *        按收到的顺序：[{ t, messages, tools（工具名）, users（各条 user 消息的文字） }]。
 */
export function sessionRequests(ctx, marker, since = 0) {
  return ctx.ep.proxy.captures.filter((item) => item.chat && item.body && item.t >= since).map((item) => {
    const messages = item.body.messages ?? [];
    return { t: item.t, messages, tools: (item.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
      users: messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)) };
  }).filter((item) => marker === null || item.users.some((text) => text.includes(marker)));
}

/**
 * @brief 一个请求是不是补了提醒、多跑的那一次（§9.8）：最后一条消息是提醒；有工作卡时提醒是倒数第二条、最后一条是工作卡。
 * @return { reminder（提醒原文）, before（提醒前一条消息的角色）, workCardLast } 或 null
 */
export function reminderOf(request) {
  const { messages } = request;
  let at = messages.length - 1;
  const workCardLast = at >= 0 && messages[at].role === 'user' && contentText(messages[at].content)
    .trimStart().startsWith(WORK_CARD_OPEN);
  if (workCardLast) at -= 1;
  const text = contentText(messages[at]?.content);
  if (messages[at]?.role !== 'user' || !isReminder(text)) return null;
  return { reminder: text.trim(), before: messages[at - 1]?.role ?? null, workCardLast };
}

/**
 * @brief 脚本模式（fs-team）下某个会话种类的请求：sessionRequests 再按 scripts.mjs sessionOf 认出的角色与种类筛，
 *        每项多一个 info（{ role, kind, task, k, j, last（最后一次投递的文字） }）。
 * @param where { kind?, role?, since? }
 */
export function kindRequests(ctx, marker, where = {}) {
  return sessionRequests(ctx, marker, where.since ?? 0).map((request) => ({ ...request,
    info: sessionOf(request.messages) })).filter((request) => (where.kind === undefined
    || request.info.kind === where.kind) && (where.role === undefined || request.info.role === where.role));
}

/** @brief 这些请求里补了提醒、多跑的那几次（reminderOf 不为 null 的），每项带 t。 */
export const reminderRequests = (requests) => requests.map((request) => ({ t: request.t, ...reminderOf(request) }))
  .filter((item) => item.reminder);

// ---------- 卡片 ----------

/**
 * @brief 这个会话面板里看得到的提问卡：{ request, headers（卡头）, more, countdown（倒计时一行或 null）, submitDisabled,
 *        questions: [{ index, multi, header, text, options: [{ label, first（label 那一行的字）, recommended,
 *        recText, desc, type, checked }], other: { type, checked, text }, input（{ value, placeholder } 或 null） }] }；
 *        没有时为 null。
 */
export function askCardOf(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const card = document.querySelector(`${selector} [data-testid="ask-card"]`);
    if (!card) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const option = (row) => ({ label: row.dataset.label ?? null,
      first: row.querySelector('.ask-option-text')?.firstChild?.textContent ?? null,
      recommended: row.dataset.recommended === 'true',
      recText: row.querySelector('[data-testid="ask-recommended"]')?.textContent ?? null,
      desc: text(row.querySelector('small')), type: row.querySelector('input')?.type ?? null,
      checked: row.querySelector('input')?.checked ?? null });
    const question = (el) => {
      const other = el.querySelector('[data-testid="ask-other"]');
      const input = el.querySelector('[data-testid="ask-other-input"]');
      return { index: Number(el.dataset.index), multi: el.dataset.multi === 'true',
        header: text(el.querySelector(':scope > .ask-header')), text: text(el.querySelector('.ask-text')),
        options: [...el.querySelectorAll('[data-testid="ask-option"]')].map(option),
        other: { type: other?.querySelector('input')?.type ?? null, checked: other?.querySelector('input')?.checked
          ?? null, text: text(other?.querySelector('.ask-option-text')) },
        input: input ? { value: input.value, placeholder: input.getAttribute('placeholder') } : null };
    };
    return { request: card.dataset.request ?? null,
      headers: [...card.querySelectorAll('.approval-head .ask-header')].map(text),
      more: text(card.querySelector('[data-testid="approval-more"]')),
      countdown: text(card.querySelector('[data-testid="away-countdown"]')),
      submitDisabled: card.querySelector('[data-testid="ask-submit"]')?.getAttribute('aria-disabled') === 'true',
      questions: [...card.querySelectorAll('[data-testid="ask-question"]')].map(question) };
  }, paneSel(tab));
}

/** @brief 等这个会话面板出现提问卡（可要求不是 notRequest 那张），最多 timeout；返回 askCardOf 的结果或 null。 */
export async function waitAskCard(ctx, tab, { timeout = 30000, notRequest = null } = {}) {
  return poll(async () => {
    const card = await askCardOf(ctx, tab);
    return card && card.request !== notRequest ? card : null;
  }, timeout, 150);
}

/** @brief 这个会话面板里看得到的扩展询问卡：{ request, method, title, more, countdown, timeout }；没有时为 null。 */
export function extCardOf(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const card = document.querySelector(`${selector} [data-testid="ext-ui-card"]`);
    if (!card) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    return { request: card.dataset.request ?? null, method: card.dataset.method ?? null,
      title: text(card.querySelector('.question-title')),
      more: text(card.querySelector('[data-testid="approval-more"]')),
      countdown: text(card.querySelector('[data-testid="away-countdown"]')),
      timeout: text(card.querySelector('.question-timeout')) };
  }, paneSel(tab));
}

/** @brief 等这个会话面板出现扩展询问卡（可要求不是 notRequest 那张），最多 timeout；返回 extCardOf 的结果或 null。 */
export async function waitExtCard(ctx, tab, { timeout = 30000, notRequest = null } = {}) {
  return poll(async () => {
    const card = await extCardOf(ctx, tab);
    return card && card.request !== notRequest ? card : null;
  }, timeout, 150);
}

/** @brief 在看得到的扩展询问卡上点一个按钮（Yes、No、Cancel…），等这张卡换掉。 */
export async function answerExtCard(ctx, tab, button) {
  const card = await extCardOf(ctx, tab);
  if (!card) throw new Error(`no extension card in ${tab} to answer (${button})`);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="ext-ui-card"]`).getByRole('button', { name: button,
    exact: true }).click();
  await ctx.page.waitForFunction(({ selector, id }) => document.querySelector(`${selector} [data-testid=`
    + '"ext-ui-card"]')?.dataset.request !== id, { selector: paneSel(tab), id: card.request }, { timeout: 10000 });
}

/**
 * @brief 这个会话面板里三种卡上的倒计时一行：{ approval, ask, extension }，每项 { text, deadline（data-deadline 的数）}
 *        或 null（卡不在或没有这一行）。
 */
export function countdownsOf(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const read = (css) => {
      const line = document.querySelector(`${selector} ${css} [data-testid="away-countdown"]`);
      return line ? { text: line.textContent.trim(), deadline: Number(line.dataset.deadline) } : null;
    };
    return { approval: read('[data-testid="approval-card"]'), ask: read('[data-testid="ask-card"]'),
      extension: read('[data-testid="ext-ui-card"]') };
  }, paneSel(tab));
}

/** @brief 在页面里记下出现过的提问卡（window.__fsAsks：{ t, request, tab }）；卡出现又马上消失也记得到。 */
export function watchAskCards(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__fsAsks) return;
    window.__fsAsks = [];
    const seen = new WeakSet();
    const scan = () => {
      for (const el of document.querySelectorAll('[data-testid="ask-card"]')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__fsAsks.push({ t: Date.now(), request: el.dataset.request ?? null,
          tab: el.closest('[data-testid="chat-pane"]')?.dataset.tab ?? null });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
    scan();
  });
}

/** @brief watchAskCards 记下的提问卡（since 之后，可按会话标识筛）。 */
export const askCardsSince = (ctx, since, tab = null) => ctx.page.evaluate(({ from, key }) => (window.__fsAsks ?? [])
  .filter((item) => item.t >= from && (key === null || item.tab === key)), { from: since, key: tab });

/** @brief 侧栏里这个会话那一行的状态：{ status（data-status）, text } 或 null。 */
export function rowStatusOf(ctx, tab) {
  return ctx.page.evaluate((key) => {
    const status = document.querySelector(`.session-item[data-row="${key}"] [data-testid="session-status"]`);
    return status ? { status: status.dataset.status ?? null, text: status.textContent.trim() } : null;
  }, tab);
}

/**
 * @brief 侧栏里会话文件为 file 的那一行的状态：{ status, text, opened（这一行有没有打开的会话面板） } 或 null。
 *        界面重新载入后还没点开的会话按 LiveStatus 显示（fs-question.md “侧栏会话行”）。
 */
export function fileRowStatus(ctx, file) {
  return ctx.page.evaluate((path) => {
    const row = [...document.querySelectorAll('.session-item')].find((el) => el.getAttribute('data-file') === path);
    const status = row?.querySelector('[data-testid="session-status"]');
    if (!status) return null;
    const pane = document.querySelector(`[data-testid="chat-pane"][data-tab="${CSS.escape(row.dataset.row ?? '')}"]`);
    return { status: status.dataset.status ?? null, text: status.textContent.trim(), opened: Boolean(pane) };
  }, file);
}

/** @brief 这个会话面板的阶段行文字（去掉末尾的秒数）；没有时为 null。 */
export const stageTextOf = (ctx, tab) => ctx.page.evaluate((selector) => document.querySelector(`${selector} `
  + '[data-testid="stage"]')?.textContent?.replace(/( · )?\d+(\.\d+)?s$/, '').trim() ?? null, paneSel(tab));

/** @brief 让这个会话显示出来，焦点放进输入框，按一个键。 */
export async function pressInComposer(ctx, tab, key) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).focus();
  await ctx.page.keyboard.press(key);
}

// ---------- 对话流 ----------

/**
 * @brief 这个会话面板里一轮末尾的那几块：[{ label（读屏名）, title, note, rows: [{ kind, request, text, time,
 *        label }] }]，按对话流的顺序。
 */
export function awayBlocksOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="away-block"]`).evaluateAll((blocks) => blocks.map((block) => ({
    label: block.getAttribute('aria-label'), title: block.querySelector('.away-block-title')?.textContent ?? null,
    note: block.querySelector('.away-block-note')?.textContent ?? null,
    rows: [...block.querySelectorAll('[data-testid="away-row"]')].map((row) => ({ kind: row.dataset.kind ?? null,
      request: row.dataset.request ?? null, text: row.querySelector('.away-row-text')?.textContent ?? null,
      time: row.querySelector('.away-row-time')?.textContent ?? null, label: row.getAttribute('aria-label') })),
  })));
}

/**
 * @brief 对话流里按文档顺序的你的消息、回复、回复操作行与那一块：[{ kind（user / assistant / actions / away）, text }]；
 *        检查那一块在这一轮最后用。
 */
export function transcriptOrder(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const kinds = { 'user-message': 'user', assistant: 'assistant', 'reply-actions': 'actions', 'away-block': 'away' };
    const css = Object.keys(kinds).map((id) => `[data-testid="${id}"]`).join(', ');
    return [...document.querySelectorAll(`${selector} ${css}`)].map((el) => ({ kind: kinds[el.dataset.testid],
      text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) }));
  }, paneSel(tab));
}

/** @brief 一块里的一行应有的样子（fs-question.md "一轮末尾"）：parts 用 " · " 连接，读屏名把 " · " 换成逗号。 */
export function expectedRow(parts, at) {
  const text = parts.filter(Boolean).join(' · ');
  const time = hourMinute(at);
  return { text, time, label: `${text}, ${time}`.replaceAll(' · ', ', ') };
}

/** @brief 这个会话面板的对话流里有没有提醒原文（§9.8：它不显示）。 */
export const transcriptHasReminder = (ctx, tab) => ctx.page.evaluate(({ selector, head }) => (document
  .querySelector(`${selector} [data-testid="transcript"]`)?.textContent ?? '').includes(head),
{ selector: paneSel(tab), head: REMINDER_PREFIX.slice(0, 40) });

// ---------- synthetic 的项目扩展 ----------

/** 扩展询问的标题（FS-74 的三种，FS-77 的确认，FS-88 嵌套调用前的确认） */
export const EXT_TITLES = Object.freeze({ confirm: 'FS-74 confirm', select: 'FS-74 select', input: 'FS-74 input',
  count: 'FS-77 confirm', nested: 'FS-88 confirm' });
/** FS-89 的扩展询问标题：批准卡旁边、提问卡之前、提问卡之后 */
export const ORDER_TITLES = Object.freeze({ approval: 'FS-89 prompt with an approval',
  before: 'FS-89 prompt before the questions', after: 'FS-89 prompt after the questions' });

/** @brief 扩展的工具：fs_ext_ask（确认、选择、输入依次问）、fs_ext_confirm（只确认一次）、fs_ext_nested（FS-88）。 */
function extToolsSource() {
  const q = JSON.stringify;
  return [
    "  pi.registerTool({ name: 'fs_ext_ask', label: 'FS ext ask', description: 'Asks three questions.',",
    '    parameters: params,',
    '    async execute(_id, _params, _signal, _onUpdate, ctx) {',
    `      const ok = await ctx.ui.confirm(${q(EXT_TITLES.confirm)}, 'Synthetic confirm');`,
    `      const pick = await ctx.ui.select(${q(EXT_TITLES.select)}, ['Red', 'Blue']);`,
    `      const typed = await ctx.ui.input(${q(EXT_TITLES.input)}, 'Synthetic input');`,
    "      return text('confirm=' + ok + '; select=' + (pick ?? '(none)') + '; input=' + (typed ?? '(none)'));",
    '    } });',
    "  pi.registerTool({ name: 'fs_ext_confirm', label: 'FS ext confirm', description: 'Asks once.',",
    '    parameters: params,',
    '    async execute(_id, _params, _signal, _onUpdate, ctx) {',
    `      const ok = await ctx.ui.confirm(${q(EXT_TITLES.count)}, 'Synthetic confirm');`,
    "      return text('confirm=' + ok);",
    '    } });',
    ...nestedToolSource(),
  ];
}

/**
 * @brief FS-88 的 fs_ext_nested：先确认一次；确认结束后（停止时它被取消，这时还在停止中）经 ctx.executeTool 调用
 *        ask_user_question（自己的 signal，不随运行中止），把嵌套调用的结果写进自己的结果：nested={ isError, text, details }。
 *        pi 的顺序执行在运行中止后不再执行同一条回复里后面的调用，所以停止中新到的提问调用只能这样在 App 里造出来。
 */
function nestedToolSource() {
  const q = JSON.stringify;
  return [
    "  pi.registerTool({ name: 'fs_ext_nested', label: 'FS ext nested', description: 'Asks, then asks the user.',",
    '    parameters: params,',
    '    async execute(_id, _params, _signal, _onUpdate, ctx) {',
    `      const ok = await ctx.ui.confirm(${q(EXT_TITLES.nested)}, 'Synthetic confirm');`,
    `      const out = await ctx.executeTool('ask_user_question', ${q(askArgs('db'))},`,
    '        { signal: new AbortController().signal });',
    "      const said = (out.result?.content ?? []).map((part) => part.text ?? '').join('');",
    '      const isError = out.isError === true || out.result?.isError === true;',
    "      return text('confirm=' + ok + '; nested=' + JSON.stringify({ isError, text: said,",
    '        details: out.result?.details ?? null }));',
    '    } });',
  ];
}

/**
 * @brief FS-89 的 tool_call 处理器：bash 命令含 fs89-approval 时在批准卡之前发一个扩展询问；ask_user_question 有四个
 *        问题时在提问卡之前发一个，第一个问题的 header 是 Scope 时 1.5 秒后（提问卡已出现）再发一个。都不等回答。
 */
function orderSource() {
  const q = JSON.stringify;
  return [
    "  pi.on('tool_call', async (event, ctx) => {",
    '    const input = event.input ?? {};',
    "    if (event.toolName === 'bash' && String(input.command ?? '').includes('fs89-approval')) {",
    `      void ctx.ui.confirm(${q(ORDER_TITLES.approval)}, 'Synthetic prompt');`,
    '    }',
    "    if (event.toolName !== 'ask_user_question') return;",
    '    const questions = Array.isArray(input.questions) ? input.questions : [];',
    `    if (questions.length === 4) void ctx.ui.confirm(${q(ORDER_TITLES.before)}, 'Synthetic prompt');`,
    "    if (questions[0]?.header === 'Scope') {",
    `      setTimeout(() => void ctx.ui.confirm(${q(ORDER_TITLES.after)}, 'Synthetic prompt'), 1500);`,
    '    }',
    '  });',
  ];
}

/**
 * @brief 测试准备（synthetic）：写项目扩展 .pi/extensions/fs-away-ask.ts（项目要被信任才加载）：三个经 ctx.ui 询问的
 *        工具；order 为真时另加 FS-89 的 tool_call 处理器。
 */
export function writeAskExtension(project, { order = false } = {}) {
  const source = [
    '// synthetic: written by tests/ui/fs-away-helpers.mjs (FS-74, FS-77, FS-88, FS-89); asks through ctx.ui.',
    "const params = { type: 'object', properties: {}, additionalProperties: false };",
    "const text = (value) => ({ content: [{ type: 'text', text: value }], details: {} });",
    '',
    'export default function (pi) {',
    ...extToolsSource(),
    ...(order ? orderSource() : []),
    '}',
    '',
  ].join('\n');
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'fs-away-ask.ts'), source);
}

// ---------- 开会话、等卡 ----------

/** @brief 等这个会话面板出现某种卡（approval：批准卡，对话的或后台的；ask：提问卡；extension：扩展询问卡）。 */
function waitKind(ctx, tab, kind, timeout) {
  if (kind === 'ask') return waitAskCard(ctx, tab, { timeout });
  if (kind === 'extension') return waitExtCard(ctx, tab, { timeout });
  return waitCard(ctx, tab, { timeout });
}

/**
 * @brief 在 project 里开一个新会话，发 text（team 时经 /team），等 kind 那种卡出现。
 * @param opts { kind（默认 approval）, marker（这个会话的请求里认得出它的文字，默认 text）, team, timeout }
 * @return 会话（openFsSession 的结果），另带 since（发送的时刻）、marker、request（卡的请求 id）、card
 */
export async function openWith(ctx, project, text, opts = {}) {
  const { kind = 'approval', marker = text, team = false, timeout = 60000 } = opts;
  const who = await openFsSession(ctx, project);
  const { since } = await sendFs(ctx, who, text, { team, wait: false });
  const card = await waitKind(ctx, who.tab, kind, timeout);
  if (!card) throw new Error(`no ${kind} card for "${oneLine(text, 80)}"`);
  return Object.assign(who, { since, marker, request: card.request, card });
}

/**
 * @brief 在 project 里开一个新会话，调用扩展注册的工具（Ask each time 下先出批准卡，§6.10）：Allow once，再等它的
 *        扩展询问卡。
 * @return 同 openWith，request 与 card 换成扩展询问卡的；approval 为批准卡的请求 id；allowedAt 为点 Allow once 的时刻
 */
export async function openExt(ctx, project, text) {
  const who = await openWith(ctx, project, text);
  const approval = who.request;
  const allowedAt = Date.now();
  await answerCard(ctx, who.tab, 'allow');
  const card = await waitExtCard(ctx, who.tab);
  if (!card) throw new Error(`no extension card for "${oneLine(text, 80)}"`);
  return Object.assign(who, { request: card.request, card, approval, allowedAt });
}

// ---------- 等待 ----------

/**
 * @brief 等这个会话面板安静下来：不在生成、发送，没有阶段行，没有批准卡、提问卡、扩展询问卡，连续 stableMs。
 *        同 fs-helpers waitCardOrIdle，但卡还挂着时接着等（你不在时卡会被处理掉）。超时时报错。
 */
export async function waitQuiet(ctx, tab, timeout = 60000, stableMs = 1200) {
  const deadline = Date.now() + timeout;
  let since = null;
  while (Date.now() < deadline) {
    const quiet = await ctx.page.evaluate((selector) => {
      const pane = document.querySelector(selector);
      return Boolean(pane) && pane.dataset.running === 'false' && pane.dataset.sending === 'false'
        && !pane.querySelector('[data-testid="stage"], [data-testid="approval-card"], [data-testid="ask-card"], '
          + '[data-testid="ext-ui-card"]');
    }, paneSel(tab));
    if (!quiet) since = null;
    else if (since === null) since = Date.now();
    else if (Date.now() - since >= stableMs) return;
    await sleep(150);
  }
  throw new Error(`session ${tab} did not become quiet within ${timeout} ms`);
}

/** @brief 等到 Date.now() 到 at（ms）为止；已过时立即返回。 */
export async function waitUntil(at) {
  const left = at - Date.now();
  if (left > 0) await sleep(left);
}
