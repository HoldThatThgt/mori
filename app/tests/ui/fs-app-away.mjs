// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-away：你不在（file-system-permissions.md §9）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic：关键词模式与关键词链、
// 脚本 fs-team、项目扩展），逐条验收这些编号在 App 层的通过条件：
//   FS-69 焦点消息、FS-70 只在不在前台时计时、FS-71 批准卡到时拒绝、FS-72 后台实例的卡到时、FS-73 提问卡到时、
//   FS-74 扩展询问到时、FS-75 Never、FS-76 设置、FS-77 倒计时、FS-78 提醒、FS-79 提醒与 TaskBoard 投递、
//   FS-80 Decided while you were away、FS-81 停止与关闭；另有 FS-87 的“你不在”那一种结果、FS-90 的“你不在时投递带
//   not the user's choice”，它们要很短的计时，只能在这个套件里测。
// 只有这个 fs 套件设很短的 MORI_AWAY_TIMEOUT_MS（§19.1）：第一次启动 10 秒；重新启动后 26 秒（倒计时要看到“多于 20 秒”
// 与“最后 20 秒”两段）。原文里的时长仍按设置写（§9.3 最后一条）。
// 依据：file-system-permissions.md §9、§10.5–§10.7，file-system.md §12、§14，屏幕表 docs/v1/screens/fs-question.md。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-away.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-away(-packaged).json（--only 时 fs-partial-app-away…，不计入覆盖检查），截图与 app.log 在
// test-results/fs-app-away/。端口：合成端点 5006，记录代理 5007（fs-helpers FS_PORTS.away）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商（fs-helpers seedFsUserData），pi 的
// compaction.keepRecentTokens 调成 300（FS-78 的上下文超长恢复要有可压缩的部分）；临时目录 ROOT 下的项目：
// main、rules、never、stop（关键词模式与合并会话）、ext（信任；询问用的项目扩展）、team（信任；合并会话，合成 MCP 服务）、
// split（信任；SPLIT_ROLES 加一个订阅 request_closed 的 watcher，合成 MCP 服务）。窗口焦点由测试给出（fs-away-helpers
// installFocus）。
// 结案会话、立项（分开时）、临时提问、订阅的 MCP 调用出批准卡要等文件系统第 3 步（§8.6 instanceTools：这些实例才有
// MCP 工具）；只有第 1 步的构建上这四项按规格记失败，失败的 detail 写明是哪种实例没有出卡。
// 收尾检查合并之后（docs/specs/finish-check.md §11，2026-10-27）：用户会话里提醒跟在检查那一行之后、同一次请求里
// （[检查那一行，提醒，工作卡]），不另多一次请求；这次合起来的请求是检查请求（合成端点 checkPlan 的 check: true），
// 合成端点默认只回一个 finish。所以 FS-78 在用户会话里查“提醒跟在检查那一行之后”，FS-79 用起点消息里的
// fc-check-wait:3000（tests/fake-endpoint/finish.mjs）把这次请求的默认回应推迟 3 秒；要在检查之后再做一次自动处理的
// once 那条链改用 fc 场景 fc-away-once。实例会话没有检查，提醒照旧多跑一次请求、紧跟最后一条助手消息。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPlan } from '../fake-endpoint/finish.mjs';
import { FS_TEXT } from '../fake-endpoint/scenarios/fs.mjs';
import { CHECK_LINE_HEAD } from '../fake-endpoint/scripts.mjs';
import { killKernel } from './lib.mjs';
import {
  answerCard, appLogLines, bridge, brief, cardOf, closeFsApp, fsArgs, fsProject, fsRecorder, fsRoot, fsUserData,
  kernelEvents, liveInfo, oneLine, openFsSession, paneSel, poll, reloadFsUi, reopenFs, runSuite, same, seedFsUserData,
  sendFs, setPermission, sleep, startFsApp, startFsEndpoint, teamMessage, toolCardsOf, waitToolCard, waitToolResult,
  writeMcpServer,
} from './fs-helpers.mjs';
import {
  AWAY_DENIED, AWAY_LABEL, AWAY_NOTE, AWAY_OPTIONS, BLOCK_TITLE, COUNTDOWN_ACTION, DURATION, EXT_TITLES,
  NOT_USER_CHOICE, approvalGone, askCardOf, awayAnswerText, awayBlocksOf, awayDenial, awayRecords, blockNote,
  blurWindow, countdownsOf, entryOrder, eventsOfType, expectedRow, extCardOf, focusLog, focusWindow, forwardText,
  installFocus, isReminder, kindRequests, liveTimers, openExt, openWith, pressInComposer, reminderEntries, reminderOf,
  reminderRequests,
  reminderText, resultEntries, sessionRequests, setAwayTimeout, sizeWindow, timerOrder, timersOf,
  transcriptHasReminder, transcriptOrder, tryBridge, unfocusedAt, waitEvent, waitQuiet, waitUntil, writeAskExtension,
} from './fs-away-helpers.mjs';
import {
  SPLIT_ROLES, contentText, customOf, instanceFiles, instanceSuffix, sendMessage, showTab, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';

const args = fsArgs('away');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面，写到外面的目标也在这里（synthetic） */
const ROOT = fsRoot('mori-fs-away-');
/** 第一次启动的计时（MORI_AWAY_TIMEOUT_MS） */
const AWAY_MS = 10000;
/** 重新启动后的计时：倒计时要有剩下多于 20 秒的一段 */
const COUNT_MS = 26000;
/** 截止时刻与“到达 + 时长”之间允许的误差（页面记下事件的时刻晚于后台进程发出它） */
const MARGIN = 2500;
/** ASK_PRESETS 的两个问题（tests/fake-endpoint/away.mjs，§14 的例子） */
const DB_Q = 'Which database should I use?';
const PARTS_Q = 'Which parts?';
/** 设置页保存失败那一行的开头（fs-question.md “设置页”） */
const SAVE_LEAD = 'Couldn’t save: ';
/** 分开时订阅 request_closed 的角色（FS-72：订阅实例的 MCP 调用到时） */
const WATCHER = { name: 'watcher', description: 'Keeps notes when a request closes', subscribe: ['request_closed'] };
/** 合成 MCP 服务的工具（writeMcpServer） */
const ECHO = 'mcp__srv__echo';
/** 失焦时新到的卡的四种请求事件（FS-70） */
const REQUEST_TYPES = ['mori.approval_request', 'mori.team_approval_request', 'mori.question_request',
  'mori.ui_request'];
/**
 * FS-72：b 会话失焦后那条回复的步骤：先等 2 秒，再流式输出约 5000 字（合成端点每 2 字一块，每块至少等
 * FAKE_CHUNK_DELAY_MS = 5 毫秒，约 12–40 秒），回复从卡到时之前写到卡到时之后。合成端点要到第一块才发出响应头，
 * 只用 [wait] 推迟的话 message_start 晚于到时，记录就该立即写（§9.7），所以要靠长回复跨过那一刻。
 */
const STREAM_STEP = `[wait 2000] say: Still answering fs72b. ${'Still streaming fs72b. '.repeat(220).trim()}`;

// ---------- 准备 ----------

/** @brief 启动 App（不设 away never，§19.1），装上窗口焦点的替身（窗口算在前台）。 */
async function startAwayApp(ctx) {
  await startFsApp(ctx, { away: null });
  await installFocus(ctx);
}

/** @brief 合成端点、项目、数据目录（synthetic test setup），启动 App。 */
async function setup(ctx) {
  ctx.p = Object.fromEntries(['main', 'rules', 'ext', 'never', 'team', 'split', 'stop']
    .map((name) => [name, fsProject(ROOT, name)]));
  writeAskExtension(ctx.p.ext);
  for (const name of ['team', 'split']) writeMcpServer(ctx.p[name]);
  writeRoles(ctx.p.split, [...SPLIT_ROLES, WATCHER]);
  ctx.ep = await startFsEndpoint('away');
  // keepRecentTokens 300：FS-78 compact 那条链的上下文超长恢复要有可压缩的部分（pi 默认 20000，短对话压缩不了）；
  // fake-fs 的窗口 128000，阈值压缩在这个套件里碰不到，别的步骤不受影响
  seedFsUserData(ctx, { trusted: [ctx.p.ext, ctx.p.team, ctx.p.split],
    piSettings: { compaction: { keepRecentTokens: 300 } } });
  await startAwayApp(ctx);
}

/** @brief 窗口失去焦点期间做 work，最后总把焦点交回（出错时也交回，免得之后步骤的卡被自动处理）。 */
async function whileAway(ctx, work) {
  await blurWindow(ctx);
  try {
    return await work();
  } finally {
    await focusWindow(ctx);
  }
}

/** @brief 这几个会话的卡（who.request）在 since 之后各自收到的 mori.away_timer（cleared 时要 null 的那种）；最多 5 秒。 */
async function cardTimers(ctx, list, since, cleared = false) {
  return poll(async () => {
    const found = [];
    for (const who of list) {
      const timer = (await timersOf(ctx, who.sessionId, since)).find((item) => item.requestId === who.request
        && (cleared ? item.deadline === null : item.deadline !== null));
      if (!timer) return null;
      found.push(timer);
    }
    return found;
  }, 5000, 150);
}

/** @brief 一块里的一行应有的样子（fs-question.md）：kind、request 来自记录，文字与时间按 parts 与记录的 at。 */
const rowOf = (decision, parts) => ({ kind: decision?.kind ?? null, request: decision?.requestId ?? null,
  ...expectedRow(parts, decision?.at ?? 0) });

/** @brief 提问记录的几行：每个问题一行 Recommended · <header>: <label>。 */
const questionRows = (decision) => (decision?.answers ?? []).map((answer) => rowOf(decision, ['Recommended',
  `${answer.header}: ${[...answer.selected, ...(answer.other === null ? [] : [answer.other])].join(', ')}`]));

/** @brief 这个会话从 since 起的 mori.away_decision 事件里的记录。 */
const decisionsOf = async (ctx, who, since = who.since) => (await eventsOfType(ctx, who.sessionId,
  'mori.away_decision', since)).map((item) => ({ t: item.t, ...item.decision }));

// ---------- FS-76：设置页 General ----------

/** @brief 设置页 General 此刻的样子：分节、当前分节、标签、下拉的值与选中的文字、四项、说明、出错的一行。 */
function generalView(ctx) {
  return ctx.page.evaluate(() => {
    const select = document.querySelector('[data-testid="away-timeout"]');
    const section = select?.closest('.settings-section');
    return {
      nav: [...document.querySelectorAll('[data-testid="settings-nav"] button')].map((b) => b.dataset.section),
      current: document.querySelector('[data-testid="settings-nav"] [aria-current="page"]')?.dataset.section ?? null,
      label: select ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.textContent ?? null : null,
      value: select?.value ?? null, shown: select?.selectedOptions[0]?.textContent ?? null,
      options: select ? [...select.options].map((option) => option.textContent) : [],
      note: section?.querySelector('.field-hint')?.textContent ?? null,
      problem: section?.querySelector('.form-message.error')?.textContent ?? null,
    };
  });
}

/** @brief 等下拉的值是 want（away.get 读完），最多 5 秒；返回此刻的样子。 */
async function waitGeneral(ctx, want) {
  const view = await poll(async () => {
    const now = await generalView(ctx);
    return now.value === want ? now : null;
  }, 5000, 150);
  return view ?? generalView(ctx);
}

/** @brief 打开设置页的 General（data-section="general"），等下拉的值是 want。 */
async function openGeneral(ctx, want) {
  const { page } = ctx;
  if (!(await page.getByTestId('settings-page').count())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  }
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="settings-nav"] button[data-section="general"]').click();
  await page.getByTestId('away-timeout').waitFor({ timeout: 10000 });
  return waitGeneral(ctx, want);
}

/** @brief 设置页的 Back to app。 */
async function closeSettings(ctx) {
  await ctx.page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await ctx.page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief General 一节符合 fs-question.md：排在 UI issues 之后并是当前分节；一行 When you’re away、四项、选中 shown、说明。 */
function generalOk(view, shown) {
  const at = view.nav.indexOf('general');
  return at > 0 && view.nav[at - 1] === 'issues' && view.current === 'general' && view.label === AWAY_LABEL
    && view.shown === shown && same(view.options, AWAY_OPTIONS) && view.note === AWAY_NOTE;
}

/** @brief 读 <userData>/away.json；不存在或读不出时为 null。 */
function readAwayFile(ctx) {
  try {
    return JSON.parse(readFileSync(join(ctx.userData, 'away.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** @brief FS-76：新的数据目录上默认 5 minutes（away.get 与设置页）。 */
async function settingsDefault(ctx) {
  const got = await bridge(ctx, { type: 'away.get' });
  const view = await openGeneral(ctx, '5m');
  await closeSettings(ctx);
  record('FS-76 the default is 5 minutes: on a new data folder away.get returns { timeout: "5m", error: null } and '
    + `Settings > General (right after UI issues) shows "${AWAY_LABEL}" with 5 minutes selected, the four choices `
    + '60 seconds, 5 minutes, 10 minutes, Never and the note of fs-question.md', same(got, { timeout: '5m',
    error: null }) && generalOk(view, '5 minutes') && view.problem === null, brief({ got, view }));
}

/** @brief FS-76：在设置页选 10 minutes：写进 away.json，away.get 与下拉都是它（重启后的检查在 reopen 步骤）。 */
async function settingsSave(ctx) {
  await openGeneral(ctx, '5m');
  await ctx.page.getByTestId('away-timeout').selectOption({ label: '10 minutes' });
  const view = await waitGeneral(ctx, '10m');
  const saved = await poll(() => (readAwayFile(ctx)?.timeout === '10m' ? readAwayFile(ctx) : null), 5000, 150);
  const got = await bridge(ctx, { type: 'away.get' });
  await closeSettings(ctx);
  record('FS-76 choosing 10 minutes in Settings > General saves it: away.json is { "timeout": "10m" }, away.get '
    + 'returns it and the drop-down shows 10 minutes', same(saved, { timeout: '10m' }) && same(got, { timeout: '10m',
    error: null }) && view.shown === '10 minutes' && view.problem === null, brief({ saved, got, view }));
}

/** @brief 设置页出错的一行“Couldn’t save: <原文>”里的原文；不是这种写法时为 null。 */
const saveError = (view) => (view?.problem?.startsWith(SAVE_LEAD) ? view.problem.slice(SAVE_LEAD.length) : null);

/**
 * @brief FS-76：away.json 写不出（away.json.tmp 是文件夹，synthetic）时值不变、error 有原文：设置页的一行与 away.set 的
 *        error 是同一个原文，是文件系统自己的报错（带着写不出的 away.json.tmp 的路径）。§9.6 对写不出只要求原文与值，
 *        不要求记日志，也不规定 Mori 自己的措辞，所以不比日志行与固定的文字；能写之后照常。
 */
async function saveFails(ctx) {
  const blocker = join(ctx.userData, 'away.json.tmp');
  mkdirSync(blocker, { recursive: true });
  try {
    await openGeneral(ctx, '10m');
    await ctx.page.getByTestId('away-timeout').selectOption({ label: '60 seconds' });
    const view = await poll(async () => {
      const now = await generalView(ctx);
      return now.problem ? now : null;
    }, 10000, 200);
    const direct = await tryBridge(ctx, { type: 'away.set', timeout: '60s' });
    const got = await bridge(ctx, { type: 'away.get' });
    const shown = saveError(view);
    record('FS-76 when away.json can’t be written the value stays and the error has the original text: the drop-down '
      + 'goes back to 10 minutes with the line "Couldn’t save: <error>", away.set returns { timeout: "10m", error: '
      + '<the same error, the file system\'s own message naming away.json.tmp> } and away.get still returns 10m',
    view?.value === '10m' && Boolean(shown) && shown.includes('away.json')
      && direct.result?.timeout === '10m' && direct.result.error === shown
      && same(got, { timeout: '10m', error: null }), brief({ view, direct, got }));
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
  await ctx.page.getByTestId('away-timeout').selectOption({ label: '5 minutes' });
  // 下拉先显示新的值、保存中保留上一次的出错行，away.set 回来才清掉（fs-question.md 设置页只规定结果）：等保存做完
  const view = await poll(async () => {
    const now = await generalView(ctx);
    return now.value === '5m' && now.problem === null && readAwayFile(ctx)?.timeout === '5m' ? now : null;
  }, 5000, 150) ?? await generalView(ctx);
  await closeSettings(ctx);
  record('FS-76 once the file can be written again, choosing 5 minutes saves it and the error line goes away',
    view.value === '5m' && view.problem === null && same(readAwayFile(ctx), { timeout: '5m' }), brief(view));
}

/** @brief FS-76：重新启动时 away.json 写坏了（synthetic）：away.get 为默认与原文，记错误日志，设置页显示原文。 */
async function brokenFile(ctx) {
  await closeFsApp(ctx);
  ctx.projectTabs = {};
  writeFileSync(join(ctx.userData, 'away.json'), '{ "timeout": broken');
  const since = Date.now();
  await startAwayApp(ctx);
  const got = await poll(async () => {
    const value = await bridge(ctx, { type: 'away.get' });
    return value?.error ? value : null;
  }, 5000, 200) ?? await bridge(ctx, { type: 'away.get' });
  const logged = appLogLines(ctx, '[kernel] ', since).filter((line) => Boolean(got?.error) && line.includes(got.error));
  const view = await openGeneral(ctx, '5m');
  await closeSettings(ctx);
  record('FS-76 a broken away.json: away.get returns 5m with the original error text, the error is logged (a '
    + '"[kernel] " line carrying that text), and Settings > General shows 5 minutes with "Couldn’t read the setting: '
    + '<error>"', got?.timeout === '5m' && typeof got.error === 'string' && got.error.trim() !== ''
    && logged.length > 0 && view.shown === '5 minutes' && view.problem === `Couldn’t read the setting: ${got.error}`,
  brief({ got, logged, view }));
}

// ---------- FS-69：焦点消息 ----------

/** @brief 窗口的一种操作：blur、focus（测试给的焦点）或真的 minimize、restore。 */
async function windowAction(ctx, action) {
  if (action === 'blur') return blurWindow(ctx);
  if (action === 'focus') return focusWindow(ctx);
  return sizeWindow(ctx, action);
}

/** @brief 等 since 之后的 [kernel] window focus: 行有 count 行，再等一会儿看有没有多出来的；返回全部值。 */
async function settledFocusLog(ctx, since, count) {
  await poll(() => focusLog(ctx, since).length >= count, 15000, 200);
  await sleep(1500);
  return focusLog(ctx, since);
}

/** @brief blur、minimize 发 false，focus、restore（且没最小化）发 true，值不变时不发：日志行数等于变化次数。 */
async function focusChanges(ctx) {
  await sleep(1500);
  const since = Date.now();
  const actions = ['blur', 'blur', 'focus', 'focus', 'minimize', 'focus', 'restore', 'blur', 'minimize', 'restore',
    'focus'];
  for (const action of actions) {
    await windowAction(ctx, action);
    await sleep(500);
  }
  const want = ['false', 'true', 'false', 'true', 'false', 'true'];
  const got = await settledFocusLog(ctx, since, want.length);
  record('FS-69 blur and minimize send focused: false, focus and restore (when not minimized) send true, and an '
    + 'unchanged value is not sent: for blur, blur, focus, focus, minimize, focus while minimized, restore, blur, '
    + 'minimize, restore while unfocused, focus the background process logs "[kernel] window focus:" exactly '
    + 'false, true, false, true, false, true', same(got, want), brief({ actions, got }));
}

/** @brief 结束后台进程（lib.mjs killKernel），点这个会话面板上的 Restart，等提示消失。 */
async function restartKernel(ctx, who) {
  await showTab(ctx, who.tab);
  killKernel(ctx.app);
  const exit = ctx.page.locator(`${paneSel(who.tab)} [data-testid="kernel-exit"]`);
  await exit.waitFor({ timeout: 15000 });
  await exit.getByRole('button', { name: 'Restart' }).click();
  await ctx.page.locator('[data-testid="kernel-exit"]').first().waitFor({ state: 'detached', timeout: 30000 });
}

/** @brief 窗口不在前台时界面重新载入、Restart 后台进程：各补发一次当前值（false）。 */
async function focusReconnect(ctx, who) {
  await blurWindow(ctx);
  await sleep(1500);
  let since = Date.now();
  await reloadFsUi(ctx);
  const reload = await settledFocusLog(ctx, since, 1);
  await reopenFs(ctx, who);
  since = Date.now();
  await restartKernel(ctx, who);
  const restart = await settledFocusLog(ctx, since, 1);
  since = Date.now();
  await focusWindow(ctx);
  const back = await settledFocusLog(ctx, since, 1);
  record('FS-69 after the page reloads the main process sends the current value once, although it did not change '
    + '(one "[kernel] window focus: false" while the window is unfocused)', same(reload, ['false']), brief(reload));
  record('FS-69 after Restart of the background process the new process gets the current value once (one '
    + '"[kernel] window focus: false"), and focusing again sends true', same(restart, ['false'])
    && same(back, ['true']), brief({ restart, back }));
}

/** @brief FS-69 的整个流程（一个发过消息的会话，后台进程重启要它的面板）。 */
async function focusMessages(ctx) {
  const who = await openWithPlain(ctx, ctx.p.main, 'plain fs69 session');
  await focusChanges(ctx);
  await focusReconnect(ctx, who);
}

/** @brief 在 project 里开一个新会话，发一条只回文字的消息，等它结束。 */
async function openWithPlain(ctx, project, text) {
  const who = await openFsSession(ctx, project);
  const { outcome } = await sendFs(ctx, who, text);
  if (outcome !== 'idle') throw new Error(`"${text}" did not end as a plain reply`);
  return who;
}

// ---------- FS-70、FS-71、FS-73、FS-78、FS-80、FS-87：计时与到时 ----------

/** @brief 窗口在前台时，挂着的批准卡与提问卡超过时长仍在，没有 mori.away_timer。 */
async function foreground(ctx, t) {
  await sleep(AWAY_MS + 2500);
  const a = await cardOf(ctx, t.a.tab);
  const b = await askCardOf(ctx, t.b.tab);
  const timers = [...await timersOf(ctx, t.a.sessionId, t.a.since), ...await timersOf(ctx, t.b.sessionId, t.b.since)];
  record('FS-70 while the window is in front an approval card and a question card wait longer than the timeout and '
    + 'stay, and no mori.away_timer is sent', a?.request === t.a.request && b?.request === t.b.request
    && timers.length === 0, brief({ a: a?.request, b: b?.request, timers }));
}

/** @brief 失焦：两张卡同一个截止时刻；切回：都收到 null；再失焦：从头计。 */
async function blurCycle(ctx, t) {
  const list = [t.a, t.b];
  const first = Date.now();
  await blurWindow(ctx);
  const timers = await cardTimers(ctx, list, first);
  await sleep(3000);
  const back = Date.now();
  await focusWindow(ctx);
  const cleared = await cardTimers(ctx, list, back, true);
  const still = [await cardOf(ctx, t.a.tab), await askCardOf(ctx, t.b.tab)].map((card) => card?.request ?? null);
  await sleep(1500);
  const again = Date.now();
  await blurWindow(ctx);
  const timers2 = await cardTimers(ctx, list, again);
  const deadline = timers?.[0].deadline;
  record('FS-70 when the window loses focus every waiting card gets mori.away_timer with the same deadline = the '
    + 'blur time + the timeout', Boolean(timers) && timers.every((item) => item.deadline === deadline)
    && Math.abs(deadline - (first + AWAY_MS)) <= MARGIN, brief({ first, timers }));
  record('FS-70 switching back to Mori sends deadline: null for every timing card, and the cards keep waiting',
    Boolean(cleared) && same(still, [t.a.request, t.b.request]), brief({ cleared, still }));
  const deadline2 = timers2?.[0].deadline;
  record('FS-70 losing focus again starts from the beginning: a new common deadline = the second blur time + the '
    + 'timeout, after the first one', Boolean(timers2) && timers2.every((item) => item.deadline === deadline2)
    && deadline2 > deadline && Math.abs(deadline2 - (again + AWAY_MS)) <= MARGIN, brief({ again, timers2 }));
}

/**
 * @brief 按到达顺序的事件里的一张卡（请求 id 为 requestId）：type 那种请求事件之后有没有它的 mori.away_timer（有截止
 *        时刻），截止时刻是不是请求到达 + 时长。
 * @param events kernelEvents 的结果（含请求事件与 mori.away_timer，按页面记下的顺序）
 * @return { request（请求事件的时刻）, timer（计时事件的时刻）, deadline, ok }
 */
function timerAfter(events, type, requestId) {
  const at = events.findIndex((item) => item.type === type && item.data.requestId === requestId);
  const timerAt = events.findIndex((item) => item.type === 'mori.away_timer' && item.data.requestId === requestId
    && item.data.deadline !== null);
  const request = events[at] ?? null;
  const timer = events[timerAt] ?? null;
  return { request: request?.t ?? null, timer: timer?.t ?? null, deadline: timer?.data.deadline ?? null,
    ok: at >= 0 && timerAt > at && Math.abs(timer.data.deadline - (request.t + AWAY_MS)) <= MARGIN };
}

/** @brief 这个会话从 since 起的四种请求事件与 mori.away_timer（按到达顺序）。 */
const requestAndTimers = (ctx, who, since = who.since) => kernelEvents(ctx, who.sessionId,
  /^mori\.(approval_request|team_approval_request|question_request|ui_request|away_timer)$/, since);

/** @brief 失焦时新到的卡（who.request，请求事件为 type）：等它的计时（最多 5 秒），再按 timerAfter 看。 */
async function lateTimerOf(ctx, who, type) {
  await waitEvent(ctx, who.sessionId, 'mori.away_timer', (item) => item.requestId === who.request
    && item.deadline !== null, { since: who.since, timeout: 5000 });
  return { requestId: who.request, ...timerAfter(await requestAndTimers(ctx, who), type, who.request) };
}

/** @brief FS-70 一种卡失焦时新到的那一条检查。 */
function recordLate(what, type, got) {
  record(`FS-70 ${what} that arrives while the window is unfocused gets mori.away_timer at once, after its ${type}, `
    + 'with deadline = its arrival + the timeout', got.ok, brief(got));
}

/** @brief 失焦时新到的批准卡与提问卡（main 项目）：各自的计时紧随请求事件，截止时刻 = 到达时刻 + 时长。 */
async function lateArrivals(ctx) {
  const c = await openWith(ctx, ctx.p.main, 'run: echo fs70-late');
  recordLate('an approval card', 'mori.approval_request', await lateTimerOf(ctx, c, 'mori.approval_request'));
  const d = await openWith(ctx, ctx.p.main, 'ask user: db\nmarker fs70-late-ask', { kind: 'ask',
    marker: 'fs70-late-ask' });
  recordLate('a question card', 'mori.question_request', await lateTimerOf(ctx, d, 'mori.question_request'));
  return { c, d };
}

/** @brief FS-71：用户会话自己的批准卡到时。 */
async function approvalExpired(ctx, a) {
  const ends = (await eventsOfType(ctx, a.sessionId, 'mori.approval_end', a.since))
    .filter((item) => item.requestId === a.request);
  const result = resultEntries(a.sessionFile).find((item) => item.tool === 'write');
  const card = await waitToolCard(ctx, a.tab, 'fs71-big.md', (item) => item.status === 'rejected', 10000);
  record('FS-71 an approval card that expires ends with mori.approval_end { by: "away" }, the tool result is "The user '
    + 'was away and didn’t answer within 5 minutes, so this was denied. Don’t retry it. Mention it in your final '
    + `summary." (the setting, not the test's short timer) and the tool card reads "${AWAY_DENIED}"`,
  ends.length === 1 && ends[0].by === 'away' && ends[0].decision === 'reject'
    && result?.text === awayDenial(DURATION['5m']) && result.isError && card?.statusText === AWAY_DENIED,
  brief({ ends, result, card }));
  const events = await decisionsOf(ctx, a);
  const entries = awayRecords(a.sessionFile);
  const { t: _t, ...decision } = events[0] ?? {};
  record('FS-71 one mori.away_decision event and one session entry with the same record: kind approval, agent null, '
    + 'toolName write, result denied, timeout 5m', events.length === 1 && entries.length === 1
    && same(entries[0], decision) && decision.kind === 'approval' && decision.agent === null
    && decision.requestId === a.request && decision.toolName === 'write' && decision.result === 'denied'
    && decision.timeout === '5m', brief({ events, entries }));
  const kept = decision.args ?? {};
  const strings = Object.values(kept).filter((value) => typeof value === 'string');
  record('FS-71 the record of a write whose content is over 300 characters has no content or edits in args and every '
    + 'other string is at most 300 characters', !('content' in kept) && !('edits' in kept)
    && kept.path === 'fs71-big.md' && strings.every((value) => [...value].length <= 300), brief(kept));
}

/** @brief FS-73、FS-87：提问卡到时按推荐项回答。 */
async function askExpired(ctx, b) {
  const want = [{ question: DB_Q, header: 'Database', selected: ['PostgreSQL'], other: null, auto: true },
    { question: PARTS_Q, header: 'Scope', selected: ['API'], other: null, auto: true }];
  const ends = (await eventsOfType(ctx, b.sessionId, 'mori.question_end', b.since))
    .filter((item) => item.requestId === b.request);
  const result = resultEntries(b.sessionFile).find((item) => item.tool === 'ask_user_question');
  const text = awayAnswerText(DURATION['5m'], [[DB_Q, 'PostgreSQL'], [PARTS_Q, 'API']]);
  record('FS-73 a question card that expires answers every question with its recommended option (the multi-select '
    + 'one too, only that one): mori.question_end { by: "away" } with those answers and the §14 away result',
  ends.length === 1 && ends[0].by === 'away' && same(ends[0].answers, want) && result?.text === text,
  brief({ ends, result }));
  record('FS-87 the away result is word for word §14 ("The user was away and didn’t answer within 5 minutes, so your '
    + 'recommended options were used: …"), is not isError, and details is { answers, by: "away" }',
  result?.text === text && !result.isError && same(result.details?.answers, want) && result.details?.by === 'away',
  brief(result));
  const card = await waitToolCard(ctx, b.tab, 'Ask · Database, Scope', (item) => item.status === 'done', 10000);
  record('FS-87 the tool card of a question answered while away reads Done (live)',
    card?.statusText?.startsWith('Done') === true, brief(card));
  const events = await decisionsOf(ctx, b);
  const entries = awayRecords(b.sessionFile);
  const { t: _t, ...decision } = events[0] ?? {};
  record('FS-73 the record (event and session entry) has kind question, toolName ask_user_question, the recommended '
    + 'answers and result recommended', events.length === 1 && entries.length === 1 && same(entries[0], decision)
    && decision.kind === 'question' && decision.toolName === 'ask_user_question' && same(decision.answers, want)
    && decision.result === 'recommended' && decision.agent === null, brief({ events, entries }));
}

/**
 * @brief 用户会话里带提醒的那次请求（收尾检查规格 §11、§6.4）：提醒前一条是检查那一行（user 消息，以 CHECK_LINE_HEAD
 *        开头），再前一条是最后一条助手消息；合成端点把这次请求认作检查请求（checkPlan 的 check）。提醒不在末尾
 *        （reminderOf：最后一条，或有工作卡时倒数第二条）的不算：提醒补过之后留在上下文里，之后的请求只是带着它，
 *        不是带提醒的那一次（§9.8 只补一次）。不是时为 null。
 * @return { t, reminder, check, afterCheck（提醒紧跟检查那一行）, checkAfter（检查那一行前一条消息的角色） }
 */
function ridingOf(request) {
  if (!reminderOf(request)) return null;
  const { messages } = request;
  const at = messages.findLastIndex((m) => m.role === 'user' && isReminder(contentText(m.content)));
  if (at < 0) return null;
  const line = messages[at - 1];
  return { t: request.t, reminder: contentText(messages[at].content).trim(), check: checkPlan({ messages }).check,
    afterCheck: line?.role === 'user' && contentText(line.content).trimStart().startsWith(CHECK_LINE_HEAD),
    checkAfter: messages[at - 2]?.role ?? null };
}

/** @brief 这些请求里带提醒的那几次（ridingOf 不为 null 的）。 */
const ridingRequests = (requests) => requests.map(ridingOf).filter(Boolean);

/** @brief 会话文件里 finish 的结果条数（合成端点对检查请求的默认回应是一个 finish，结果是 Confirmed.）。 */
const finishResults = (file) => resultEntries(file).filter((item) => item.tool === 'finish');

/** @brief FS-78：一个会话这次运行的提醒（条目、带提醒的那次请求、对话流里看不到）。 */
async function reminderCase(ctx, who, lines) {
  const want = reminderText(lines);
  const entries = reminderEntries(who.sessionFile);
  const requests = sessionRequests(ctx, who.marker, who.since);
  const extra = ridingRequests(requests);
  const finished = finishResults(who.sessionFile);
  return { tab: who.tab, entries, requests: requests.length, extra, finished: finished.length,
    shown: await transcriptHasReminder(ctx, who.tab),
    entryOk: entries.length === 1 && entries[0].display === false && entries[0].content === want,
    requestOk: extra.length === 1 && extra[0].reminder === want && extra[0].check && extra[0].afterCheck
      && extra[0].checkAfter === 'assistant' && requests.length === 3 && finished.length === 1
      && finished[0].text === 'Confirmed.' };
}

/** @brief FS-78：批准卡、提问卡、失焦时新到的卡这三次运行的提醒。 */
async function reminders(ctx, t) {
  const cases = [[t.a, ['- Denied write: fs71-big.md']], [t.b, [`- Used your recommended option for "${DB_Q}": `
    + 'PostgreSQL', `- Used your recommended option for "${PARTS_Q}": API`]], [t.c, ['- Denied bash: echo fs70-late']]];
  const rows = [];
  for (const [who, lines] of cases) rows.push(await reminderCase(ctx, who, lines));
  record('FS-78 a run with an automatic denial or recommended answer gets exactly one mori.away_reminder '
    + 'custom_message (display: false) with the §14 text (each item on its line, "… in your final summary.")',
  rows.every((row) => row.entryOk), brief(rows.map((row) => ({ tab: row.tab, entries: row.entries }))));
  record('FS-78 in a user session the reminder rides on the finish check\'s request (three in all, no extra request; '
    + 'finish-check §11): it comes right after the check line, which follows the last assistant message; the request '
    + 'is a check request and the endpoint\'s default reply is one finish ("Confirmed.")',
  rows.every((row) => row.requestOk), brief(rows.map((row) => ({ tab: row.tab, requests: row.requests,
    extra: row.extra, finished: row.finished }))));
  record('FS-78 the reminder is not shown in the transcript (live)', rows.every((row) => !row.shown),
    brief(rows.map((row) => row.shown)));
}

/** @brief 那一块在这一轮最后：在这一轮最后一条回复（与回复操作行）之后，下一条你的消息之前。 */
function lastOfTurn(order) {
  const at = order.findIndex((item) => item.kind === 'away');
  if (at < 1 || order.filter((item) => item.kind === 'away').length !== 1) return false;
  const next = order.findIndex((item, index) => index > at && item.kind === 'user');
  const before = order[at - 1].kind;
  return (before === 'assistant' || before === 'actions') && (next < 0 ? at === order.length - 1 : next === at + 1);
}

/** @brief FS-80：三个会话各一块，行与 fs-question.md 一致；没有记录的轮没有。 */
async function blocks(ctx, t) {
  await sendFs(ctx, t.a, 'plain fs80-quiet turn');
  await waitQuiet(ctx, t.a.tab);
  const views = {};
  for (const [key, who] of Object.entries({ a: t.a, b: t.b, c: t.c })) {
    views[key] = { blocks: await awayBlocksOf(ctx, who.tab), order: await transcriptOrder(ctx, who.tab),
      records: awayRecords(who.sessionFile) };
  }
  const want = { a: [rowOf(views.a.records[0], ['Denied', 'Write fs71-big.md'])], b: questionRows(views.b.records[0]),
    c: [rowOf(views.c.records[0], ['Denied', 'Run echo fs70-late'])] };
  const okBlock = (key) => views[key].blocks.length === 1 && views[key].blocks[0].title === BLOCK_TITLE
    && views[key].blocks[0].label === BLOCK_TITLE && views[key].blocks[0].note === blockNote(DURATION['5m'])
    && same(views[key].blocks[0].rows, want[key]);
  record('FS-80 a turn with records ends with "Decided while you were away", the note "You didn’t answer within 5 '
    + 'minutes, so Mori decided these." and one row per record as in fs-question.md ("Denied · <tool card title>", one '
    + '"Recommended · <header>: <label>" per question; time HH:MM; screen-reader name with commas)',
  ['a', 'b', 'c'].every(okBlock), brief({ views: Object.fromEntries(Object.entries(views).map(([key, view]) =>
    [key, view.blocks])), want }));
  record('FS-80 the block is the last thing of its turn (after its last reply and reply actions), and the next turn '
    + 'of the same session, without records, has no block', ['a', 'b', 'c'].every((key) => lastOfTurn(views[key].order))
    && views.a.order.filter((item) => item.kind === 'user').length === 2,
  brief(Object.fromEntries(Object.entries(views).map(([key, view]) => [key, view.order.map((item) => item.kind)]))));
  ctx.views = { ...ctx.views, a: views.a.blocks, b: views.b.blocks, c: views.c.blocks };
}

/** @brief 计时与到时的整个流程（main 项目的关键词会话：a 批准卡、b 提问卡，失焦时新到的 c 批准卡、d 提问卡）。 */
async function timing(ctx) {
  const t = {
    a: await openWith(ctx, ctx.p.main, 'write file: fs71-big.md size=400'),
    b: await openWith(ctx, ctx.p.main, 'ask user: db-parts\nmarker fs73-ask', { kind: 'ask', marker: 'fs73-ask' }),
  };
  await foreground(ctx, t);
  try {
    await blurCycle(ctx, t);
    Object.assign(t, await lateArrivals(ctx));
    for (const who of [t.a, t.b, t.c, t.d]) await waitQuiet(ctx, who.tab, AWAY_MS * 3);
  } finally {
    await focusWindow(ctx);
  }
  ctx.t = t;
  await approvalExpired(ctx, t.a);
  await askExpired(ctx, t.b);
  await reminders(ctx, t);
  await blocks(ctx, t);
}

// ---------- FS-78、FS-80：提醒的规则（rules 项目的五条关键词链，同一次失焦） ----------

/** compact 那条链第 2 步的长回复（约 1600 字，四百多个 token）：压缩时它之前的部分可以摘要（keepRecentTokens 300） */
const LONG_SAY = 'Long reply before the follow-up fs78f. '.repeat(42).trim();
/** compact 那条链排队的消息：overflow-once 让带它的第一次请求以上下文超长失败（合成端点），pi 压缩后再 continue */
const FOLLOW_UP = 'plain fs78f follow-up overflow-once';

/**
 * 五条链：第二次自动处理（第 2 步推迟 4 秒回答，留出改设置的时间，FS-80 时长不同的一轮）、重试、按停止、出错结束、
 * 自动处理之后同一次运行里再有 agent_start（compact：排队的消息遇到上下文超长，pi 压缩后 continue）。
 * once 的第二次自动处理在带提醒的那次请求（也是收尾检查的请求）的回复里，所以用 fc 场景 fc-away-once 回答这次运行的每个
 * 请求（tests/fake-endpoint/finish.mjs：写 ../fs78-b1.md，推迟 4 秒的一句；检查后写 ../fs78-b2.md 与一句；再检查时确认）
 */
const CHAINS = Object.freeze({
  once: 'fc-scenario:fc-away-once Write two notes outside fs78b.',
  retry: 'steps: write file: ../fs78-c.md ;; [fail-once 503] say: After the retry fs78c.',
  stop: 'steps: write file: ../fs78-d.md ;; [wait 8000] say: Reply fs78d.',
  error: 'steps: write file: ../fs78-e.md ;; [fail-once 400] say: Never sent fs78e.',
  compact: `steps: write file: ../fs78-f.md ;; say: ${LONG_SAY}`,
});

/** @brief 在挂着卡的会话里排队一条消息（输入框里 Enter，pi 的 followUp），等后台进程的排队区有它（最多 5 秒）。 */
async function queueFollowUp(ctx, who, text) {
  await sendMessage(ctx, who.tab, text);
  const queued = await poll(async () => ((await liveInfo(ctx, who.sessionFile))?.live?.followUp ?? [])
    .some((item) => item.includes(text)), 5000, 150);
  if (!queued) throw new Error(`"${text}" was not queued in ${who.tab}`);
}

/**
 * @brief FS-80：once 那条链第一次自动处理之后、第二张卡开始计时之前把设置改成 60 seconds，第二张卡开始计时之后
 *        改回 5 minutes（计时器开始时取设置，§9.6“下一次开始计时起生效”）：这一轮两条记录的时长不同。
 * @return { setAt（改成 60 秒之后的时刻）, timer（第二张卡的 mori.away_timer） }
 */
async function mixTimeouts(ctx, who) {
  const first = await poll(async () => (await decisionsOf(ctx, who)).length >= 1, AWAY_MS + 10000, 150);
  if (!first) throw new Error('the first fs78b card was not decided');
  try {
    await setAwayTimeout(ctx, '60s');
    const setAt = Date.now();
    const timer = await waitEvent(ctx, who.sessionId, 'mori.away_timer', (item) => item.requestId !== who.request
      && item.deadline !== null, { since: who.since, timeout: 20000 });
    return { setAt, timer };
  } finally {
    await setAwayTimeout(ctx, '5m');
  }
}

/** @brief 失焦期间同时做两件事：按停止那条链的 Esc，once 那条链两张卡之间改设置；有一件抛错时抛出它。 */
async function stopAndMix(ctx, r) {
  const [stop, mix] = await Promise.allSettled([stopAfterExpiry(ctx, r.stop), mixTimeouts(ctx, r.once)]);
  const failed = [stop, mix].find((item) => item.status === 'rejected');
  if (failed) throw failed.reason;
  r.once.mix = mix.value;
}

/** @brief 按停止的那条：等它的卡到时、下一个请求到了（合成端点推迟 8 秒回答）再按 Esc。 */
async function stopAfterExpiry(ctx, who) {
  const end = await waitEvent(ctx, who.sessionId, 'mori.approval_end', (item) => item.requestId === who.request,
    { since: who.since, timeout: AWAY_MS + 10000 });
  if (!end) throw new Error('the fs78d card did not end');
  const asked = await poll(() => sessionRequests(ctx, who.marker, who.since).length >= 2, 10000, 150);
  if (!asked) throw new Error('the request after the fs78d tool result did not come');
  await sleep(500);
  await pressInComposer(ctx, who.tab, 'Escape');
}

/** @brief 一条链的提醒情况。 */
function ruleState(ctx, who) {
  const requests = sessionRequests(ctx, who.marker, who.since);
  return { entries: reminderEntries(who.sessionFile), records: awayRecords(who.sessionFile).length,
    requests: requests.length, extra: reminderRequests(requests) };
}

/** @brief FS-78 四条规则的检查。 */
async function ruleChecks(ctx, r) {
  const once = ruleState(ctx, r.once);
  const want = reminderText(['- Denied write: ../fs78-b1.md']);
  const riding = ridingRequests(sessionRequests(ctx, r.once.marker, r.once.since));
  record('FS-78 a second automatic decision in the same run (in the reply to the request with the reminder, which is '
    + 'also the first finish check) gets no second reminder: two records, one mori.away_reminder that lists only the '
    + 'first, one request with a reminder (five requests: the message, after the first denial, the first check with '
    + 'the reminder, after the second denial, the second check without one)',
  once.records === 2 && once.entries.length === 1 && once.entries[0].content === want && once.extra.length === 1
    && riding.length === 1 && riding[0].check && riding[0].afterCheck && once.requests === 5, brief({ once, riding }));
  const retry = ruleState(ctx, r.retry);
  const retried = (await eventsOfType(ctx, r.retry.sessionId, 'mori.model_retry', r.retry.since))
    .filter((item) => item.status === 503);
  // Mori 关掉了 pi 的 auto_retry（modelSession.ts 的 retry.enabled: false），这条链的重试是模型层的原地重试，不发
  // agent_start；自动处理之后同一次运行里再有 agent_start 的情形由 compact 那条链（compactCheck）查。
  record('FS-78 after an automatic decision a request that is retried (synthetic 503, the model layer retries in '
    + 'place: mori.model_retry) still gets the reminder: one mori.away_reminder and one extra request',
  retried.length >= 1 && retry.entries.length === 1 && retry.entries[0].content === reminderText(['- Denied write: '
    + '../fs78-c.md']) && retry.extra.length === 1, brief({ covers: 'the in-place model retry (pi auto_retry is '
    + 'off); a new agent_start in the same run: the compact chain', retry, retried }));
  const stop = ruleState(ctx, r.stop);
  record('FS-78 a run stopped (Esc) after an automatic decision gets no reminder: no mori.away_reminder, no extra '
    + 'request', stop.records === 1 && stop.entries.length === 0 && stop.extra.length === 0, brief(stop));
  const error = ruleState(ctx, r.error);
  const ended = (await kernelEvents(ctx, r.error.sessionId, 'message_end', r.error.since))
    .filter((item) => item.role === 'assistant').map((item) => item.stopReason);
  record('FS-78 a run that ends with an error (synthetic 400) after an automatic decision gets no reminder',
    error.records === 1 && error.entries.length === 0 && error.extra.length === 0 && ended.includes('error'),
    brief({ error, ended }));
}

/**
 * @brief compact 那条链这次运行的样子（按页面记下的顺序）：自动处理（mori.away_decision）之后、agent_settled 之前
 *        有没有上下文超长的压缩（compaction_end，reason overflow，没有 errorMessage）、它之后有没有 agent_start，
 *        这一段一共几个 agent_start（压缩后的 continue 与收尾检查的 continue 各一个；用户会话里提醒跟在检查那一行
 *        之后、同一次请求，收尾检查规格 §11，所以没有另一个补提醒的 continue）。
 */
async function compactShape(ctx, who) {
  const events = await kernelEvents(ctx, who.sessionId,
    /^(agent_start|agent_settled|compaction_end|mori\.away_decision)$/, who.since);
  const decided = events.findIndex((item) => item.type === 'mori.away_decision');
  const settled = events.findIndex((item, index) => index > decided && item.type === 'agent_settled');
  const run = decided < 0 ? [] : events.slice(decided + 1, settled < 0 ? events.length : settled);
  const compacted = run.findIndex((item) => item.type === 'compaction_end' && item.data?.reason === 'overflow'
    && !item.data.errorMessage);
  return { decided: decided >= 0, settled: settled > decided, compacted: compacted >= 0,
    restarted: compacted >= 0 && run.slice(compacted + 1).some((item) => item.type === 'agent_start'),
    starts: run.filter((item) => item.type === 'agent_start').length, kinds: run.map((item) => item.type) };
}

/**
 * @brief FS-78：自动处理之后同一次运行里又有 agent_start（排队的消息遇到上下文超长，pi 压缩后 continue）时提醒照样补
 *        （§9.8：清单到 agent_settled 才清）。先记一条前提（压缩与之后的 agent_start 确实发生在自动处理与结束之间）。
 *        压缩之后最早的消息被摘要掉，请求按提醒原文认，不按会话的第一条消息。
 */
async function compactCheck(ctx, who) {
  const shape = await compactShape(ctx, who);
  const want = reminderText(['- Denied write: ../fs78-f.md']);
  const entries = reminderEntries(who.sessionFile);
  const extra = ridingRequests(sessionRequests(ctx, null, who.since)).filter((item) => item.reminder === want);
  record('FS-78 (precondition) after the automatic decision the same run starts again before it settles: the queued '
    + 'message hits a synthetic context overflow, pi compacts (compaction_end, reason overflow) and continues with a '
    + 'new agent_start', shape.decided && shape.settled && shape.restarted, brief(shape));
  record('FS-78 when a new agent_start follows the automatic decision in the same run (pi\'s overflow compaction and '
    + 'continue, standing in for auto_retry, which Mori turns off), the reminder is still added: one '
    + 'mori.away_reminder (display: false) listing the denial, in one request right after the finish check\'s line '
    + '(which follows the last assistant message)', shape.restarted && shape.starts >= 2 && entries.length === 1
    && entries[0].display === false && entries[0].content === want && extra.length === 1 && extra[0].check
    && extra[0].afterCheck && extra[0].checkAfter === 'assistant',
  brief({ shape, entries, extra, records: awayRecords(who.sessionFile).length }));
}

/** @brief FS-80：once 那一轮两条记录的时长不同（5m 与 60s）：一块两行，说明行是 “in time” 那一句。 */
async function mixedBlock(ctx, who) {
  await showTab(ctx, who.tab);
  const records = awayRecords(who.sessionFile);
  const blocks = await awayBlocksOf(ctx, who.tab);
  const want = [rowOf(records[0], ['Denied', 'Write ../fs78-b1.md']), rowOf(records[1], ['Denied',
    'Write ../fs78-b2.md'])];
  const timeouts = records.map((item) => item.timeout);
  record('FS-80 when the records of a turn have different timeouts (5m, then 60s after the setting changed between '
    + `the two cards) the block's note is "${blockNote(null)}" and it has both rows in order`,
  same(timeouts, ['5m', '60s']) && blocks.length === 1 && blocks[0].title === BLOCK_TITLE
    && blocks[0].note === blockNote(null) && same(blocks[0].rows, want),
  brief({ timeouts, blocks, want, setAt: who.mix?.setAt ?? null, secondTimer: who.mix?.timer ?? null }));
}

/** @brief FS-78、FS-80 的规则：五条链各开一个会话（compact 那条再排队一条消息），同一次失焦。 */
async function reminderRules(ctx) {
  const r = {};
  for (const [key, text] of Object.entries(CHAINS)) r[key] = await openWith(ctx, ctx.p.rules, text);
  await queueFollowUp(ctx, r.compact, FOLLOW_UP);
  await whileAway(ctx, async () => {
    await stopAndMix(ctx, r);
    const both = await poll(async () => (await decisionsOf(ctx, r.once)).length >= 2, AWAY_MS * 3, 300);
    if (!both) throw new Error('the second fs78b card was not decided');
    for (const who of Object.values(r)) await waitQuiet(ctx, who.tab, AWAY_MS * 3);
  });
  await ruleChecks(ctx, r);
  await compactCheck(ctx, r.compact);
  await mixedBlock(ctx, r.once);
}

// ---------- FS-74：扩展询问 ----------

/** @brief FS-74、FS-78、FS-80：扩展的确认、选择、输入你不在时被取消。 */
async function extension(ctx) {
  const who = await openExt(ctx, ctx.p.ext, 'call tool: fs_ext_ask');
  await whileAway(ctx, async () => {
    const done = await waitToolResult(who.sessionFile, (item) => item.tool === 'fs_ext_ask', AWAY_MS * 3 + 20000);
    if (!done) throw new Error('fs_ext_ask did not return');
    await waitQuiet(ctx, who.tab, AWAY_MS * 2);
  });
  const asked = await eventsOfType(ctx, who.sessionId, 'mori.ui_request', who.since);
  const ended = await eventsOfType(ctx, who.sessionId, 'mori.ui_end', who.since);
  const result = resultEntries(who.sessionFile).find((item) => item.tool === 'fs_ext_ask');
  record('FS-74 an extension confirm, select and input that wait while you are away are cancelled one after another: '
    + 'the tool gets confirm=false and empty select and input, each ends with mori.ui_end',
  same(asked.map((item) => item.method), ['confirm', 'select', 'input']) && same(ended.map((item) => item.requestId),
    asked.map((item) => item.requestId)) && result?.text === 'confirm=false; select=(none); input=(none)',
  brief({ asked: asked.map((item) => [item.requestId, item.method]), ended, result }));
  const events = await decisionsOf(ctx, who);
  const entries = awayRecords(who.sessionFile);
  const titles = [EXT_TITLES.confirm, EXT_TITLES.select, EXT_TITLES.input];
  record('FS-74 each cancelled prompt has a record (event and session entry): kind extension, its title, result '
    + 'cancelled, no tool fields', events.length === 3 && entries.length === 3
    && same(entries.map((item) => item.title), titles) && entries.every((item) => item.kind === 'extension'
      && item.result === 'cancelled' && item.agent === null && item.toolCallId === null && item.toolName === null
      && item.args === null && item.answers === null),
  brief({ events: events.length, entries }));
  const extra = reminderRequests(sessionRequests(ctx, who.marker, who.since));
  record('FS-78 a run whose only automatic decisions are extension prompts gets no reminder',
    reminderEntries(who.sessionFile).length === 0 && extra.length === 0, brief(extra));
  const rows = (await awayBlocksOf(ctx, who.tab)).flatMap((block) => block.rows);
  record('FS-80 extension rows read "Cancelled · Extension: <title>", in the order they were decided',
    same(rows, entries.map((item) => rowOf(item, ['Cancelled', `Extension: ${item.title}`]))), brief(rows));
  await extensionLate(ctx, who, asked);
}

/**
 * @brief FS-70：确认在前台时就到了（失焦时才计时），选择与输入在失焦时一个接一个新到：各自的计时紧随 mori.ui_request，
 *        截止时刻 = 到达时刻 + 时长。
 */
async function extensionLate(ctx, who, asked) {
  const events = await requestAndTimers(ctx, who);
  const late = asked.slice(1).map((item) => ({ requestId: item.requestId, method: item.method,
    ...timerAfter(events, 'mori.ui_request', item.requestId) }));
  record('FS-70 the extension select and input that arrive while the window is unfocused each get mori.away_timer at '
    + 'once, after their mori.ui_request, with deadline = their arrival + the timeout',
  late.length === 2 && late.every((item) => item.ok), brief(late));
}

// ---------- FS-75：Never ----------

/** @brief FS-75：Never 时失焦再久也不发 mori.away_timer、不自动处理。 */
async function never(ctx) {
  await setAwayTimeout(ctx, 'never');
  let who = null;
  try {
    who = await openWith(ctx, ctx.p.never, 'write file: fs75-never.md');
    const since = Date.now();
    const view = await whileAway(ctx, async () => {
      await sleep(AWAY_MS + 3000);
      return { card: await cardOf(ctx, who.tab), timers: await timersOf(ctx, who.sessionId, since),
        ends: await eventsOfType(ctx, who.sessionId, 'mori.approval_end', since) };
    });
    record('FS-75 with the setting Never, an unfocused window longer than the timeout sends no mori.away_timer and the '
      + 'card is not decided', view.card?.request === who.request && view.timers.length === 0 && view.ends.length === 0,
    brief(view));
  } finally {
    await setAwayTimeout(ctx, '5m');
  }
  await answerCard(ctx, who.tab, 'deny');
  await waitQuiet(ctx, who.tab);
}

// ---------- FS-72、FS-78、FS-79、FS-80：后台实例（team 项目，合并会话） ----------

/** @brief 合并会话里发一条 /team 消息，等后台实例的卡（data-agent）。 */
async function bgCard(ctx, project, lines, marker) {
  const who = await openWith(ctx, project, teamMessage(lines), { team: true, marker, timeout: 90000 });
  if (!who.card.agent) throw new Error(`the first card for ${marker} is not a background card`);
  return who;
}

/** @brief 这个用户会话的某个实例会话文件（instanceFiles）：id 后缀以 prefix 开头的第一个。 */
const instanceOf = (ctx, who, prefix) => instanceFiles(ctx, who.sessionId)
  .find((item) => instanceSuffix(who.sessionId, item.id).startsWith(prefix)) ?? null;

/** @brief 等这个会话的后台卡（who.request）结束，最多 timeout；返回 mori.team_approval_end 或 null。 */
const bgEnd = (ctx, who, timeout = AWAY_MS + 15000) => waitEvent(ctx, who.sessionId, 'mori.team_approval_end',
  (item) => item.requestId === who.request, { since: who.since, timeout });

/**
 * @brief FS-70：失焦时新到的后台卡（team 项目再开一个合并会话，task 实例写到外面）：计时紧随
 *        mori.team_approval_request，截止时刻 = 到达时刻 + 时长。
 */
async function lateBgCard(ctx) {
  const who = await bgCard(ctx, ctx.p.team, [['fs-call', 'write file: ../fs70-late-bg.md']], 'fs70-late-bg.md');
  recordLate('a background card', 'mori.team_approval_request',
    await lateTimerOf(ctx, who, 'mori.team_approval_request'));
  return who;
}

/**
 * @brief 失焦期间：b 会话写一条跨过它的卡到时的长回复（STREAM_STEP）；再开一个会话等失焦时新到的后台卡；等各个会话的
 *        卡都处理完、c 的程序投递来了。结案会话的卡（第 3 步起才有）记在 team.a.closeCard。
 */
async function teamAway(ctx, team) {
  await whileAway(ctx, async () => {
    team.b.streamSince = Date.now();
    await sendFs(ctx, team.b, teamMessage([['fs-create', STREAM_STEP]]), { team: true, wait: false });
    team.late = await lateBgCard(ctx);
    await bgEnd(ctx, team.a);
    // b 的记录要等那条长回复写完才写（§9.7），回复最长约 40 秒
    await poll(async () => (await decisionsOf(ctx, team.b)).length >= 1, 60000, 300);
    await poll(() => kindRequests(ctx, team.c.marker, { kind: 'merged-create', since: team.c.since })
      .some((item) => item.info.k >= 2), 40000, 300);
    await bgEnd(ctx, team.late);
    // 结案会话的卡（文件系统第 3 步起它才有 MCP 工具）：出现了就等它到时
    team.a.closeCard = await waitEvent(ctx, team.a.sessionId, 'mori.team_approval_request',
      (item) => item.requestId !== team.a.request, { since: team.a.since, timeout: 20000 });
    if (team.a.closeCard) await bgEnd(ctx, { ...team.a, request: team.a.closeCard.requestId });
  });
  for (const who of Object.values(team)) {
    if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error(`team session ${who.tab} is not idle`);
  }
}

/**
 * a 会话的 task 在写入被自动拒绝之后自己交接：blocked 不要证据（TaskBoard §7.3：done、pass 至少要一个 ok 的证据，
 * 被拒绝的写入不算），照样交给结案（§7.1），FS-72 结案会话的卡照常出现；脚本自己的 TASK_DONE 交接不带证据，会被拒绝
 */
const A_HANDOFF = 'call tool: task_handoff {"task":"T1","conclusion":"The write was denied while the user was away",'
  + '"outcome":"blocked"}';
/** a 会话的 task 交接成功时结果里的那一句（teamTools.ts executeTaskHandoff；前面有证据编号 [#n]） */
const A_HANDED = 'Handed off T1 (blocked)';

/** @brief FS-72、FS-78：task 实例的卡到时（a 会话：之后交接）。 */
async function taskExpired(ctx, a) {
  const ends = (await eventsOfType(ctx, a.sessionId, 'mori.team_approval_end', a.since))
    .filter((item) => item.requestId === a.request);
  const task = instanceOf(ctx, a, 't1.');
  const result = task ? resultEntries(task.file).find((item) => item.tool === 'write') : null;
  record('FS-72 a background card of a task instance (a task without limits) that waits while you are away ends with '
    + 'mori.team_approval_end { by: "away" } and the instance gets "… Mention it in your handoff." with the setting '
    + '(10 minutes)', ends.length === 1 && ends[0].by === 'away' && result?.text === awayDenial(DURATION['10m'], true)
    && result.isError, brief({ ends, result }));
  const decision = (await decisionsOf(ctx, a)).find((item) => item.requestId === a.request);
  const entry = awayRecords(a.sessionFile).find((item) => item.requestId === a.request);
  const { t: _t, ...sent } = decision ?? {};
  record('FS-72 its record is written in the user session file and sent on the user session envelope, not in the '
    + 'instance file: agent { instance, role mori, task T1, taskTitle }, toolName write, timeout 10m',
  Boolean(decision) && same(entry, sent) && sent.agent?.role === 'mori' && sent.agent.task === 'T1'
    && sent.agent.taskTitle === FS_TEXT.taskTitle && sent.agent.instance === task?.id && sent.toolName === 'write'
    && sent.args?.path === '../fs72-a.md' && sent.timeout === '10m' && awayRecords(task?.file ?? '').length === 0,
  brief({ decision, entry, task: task?.id }));
  const requests = kindRequests(ctx, a.marker, { kind: 'task', since: a.since });
  const handed = task ? resultEntries(task.file).find((item) => item.tool === 'task_handoff'
    && item.text.includes(A_HANDED)) ?? null : null;
  record('FS-78 a task instance that hands off after the automatic decision (its own task_handoff, outcome blocked, '
    + 'is accepted) gets no reminder', Boolean(handed) && reminderEntries(task.file).length === 0
    && reminderRequests(requests).length === 0, brief({ task: task?.id, handed: handed?.text ?? null,
    requests: requests.length }));
}

/**
 * @brief FS-72：结案会话的 MCP 调用到时（文件系统第 3 步起结案会话才有 MCP 工具）；没有出卡时 detail 写明原因，
 *        检查照样记失败。
 */
async function closeExpired(ctx, a) {
  const name = 'FS-72 the close session\'s card (an MCP call) that waits while you are away gets "… Mention it in '
    + 'your handoff." too; its record has role mori and no task';
  const close = instanceOf(ctx, a, 'close');
  const result = close ? resultEntries(close.file).find((item) => item.tool === ECHO) : null;
  if (!a.closeCard) {
    record(name, false, `no background card from the close session (close instances get MCP tools from step 3, `
      + `§8.6); its ${ECHO} result: ${oneLine(result?.text ?? '(none)', 200)}`);
    return;
  }
  const end = (await eventsOfType(ctx, a.sessionId, 'mori.team_approval_end', a.since))
    .find((item) => item.requestId === a.closeCard.requestId);
  const entry = awayRecords(a.sessionFile).find((item) => item.requestId === a.closeCard.requestId);
  record(name, end?.by === 'away' && result?.text === awayDenial(DURATION['10m'], true) && result.isError
    && entry?.agent?.role === 'mori' && entry.agent.task === null && entry.timeout === '10m',
  brief({ close: close?.id, end, result, entry }));
}

/** @brief FS-78：b 会话的 task 实例（在交接之前结束这次运行）的提醒与工作卡。 */
function workCard(ctx, b) {
  const task = instanceOf(ctx, b, 't1.');
  const want = reminderText(['- Denied write: ../fs72-b.md'], true);
  const entries = task ? reminderEntries(task.file) : [];
  const extra = reminderRequests(kindRequests(ctx, b.marker, { kind: 'task', since: b.since }));
  record('FS-78 a task instance whose run ends before handing off gets one reminder ending "… in your handoff."; in '
    + 'the extra request the reminder follows the last assistant message and the work card comes after it',
  entries.length === 1 && entries[0].display === false && entries[0].content === want && extra.length === 1
    && extra[0].reminder === want && extra[0].before === 'assistant' && extra[0].workCardLast,
  brief({ task: task?.id, entries, extra }));
}

/**
 * @brief FS-72：b 的后台卡在用户会话正在写那条长回复时到时：记录写在这条助手消息之后，事件在它结束之后。先记一条
 *        前提（回复的 message_start 早于到时、message_end 晚于到时），时机没对上时看得出不是 Mori 的错。
 */
async function streamOrder(ctx, b) {
  const expired = (await eventsOfType(ctx, b.sessionId, 'mori.team_approval_end', b.since))
    .find((item) => item.requestId === b.request) ?? null;
  const end = (await kernelEvents(ctx, b.sessionId, 'message_end', b.streamSince))
    .find((item) => item.role === 'assistant' && item.text.includes('Still answering fs72b.')) ?? null;
  // message_start 时助手消息还没有字：取 message_end 之前最后一个助手的 message_start
  const start = end ? (await kernelEvents(ctx, b.sessionId, 'message_start', b.streamSince))
    .filter((item) => item.role === 'assistant' && item.t <= end.t).at(-1) ?? null : null;
  const streamed = Boolean(start && expired && end) && start.t < expired.t && expired.t < end.t;
  const times = { start: start?.t ?? null, expired: expired?.t ?? null, end: end?.t ?? null };
  record('FS-72 (precondition) the user session\'s long reply streams across the expiry of the background card: its '
    + 'assistant message_start comes before mori.team_approval_end and its message_end after', streamed,
  brief(times));
  const order = entryOrder(b.sessionFile);
  const reply = order.findIndex((item) => item.kind === 'assistant' && item.text.includes('Still answering fs72b.'));
  const written = order.findIndex((item) => item.kind === 'mori.away_decision');
  const sent = (await decisionsOf(ctx, b)).find((item) => item.requestId === b.request);
  record('FS-72 when the background card expires while the user session is writing a reply, the record is written '
    + 'after that assistant message (session file order) and its event comes after the message ends', streamed
    && reply >= 0 && written > reply && Boolean(sent) && sent.t >= end.t,
  brief({ precondition: streamed, ...times, reply, written, sent: sent?.t ?? null }));
}

/** @brief FS-79：c 会话（对话 Agent 兼立项自己的提问卡到时、补了提醒）之后的程序投递。 */
function delivery(ctx, c) {
  const requests = kindRequests(ctx, c.marker, { kind: 'merged-create', since: c.since });
  const reminder = requests.find((item) => ridingRequests([item]).length === 1);
  const deliveries = requests.filter((item) => item.info.k >= 2 && item.info.j === 0);
  const overlap = reminder ? requests.filter((item) => item.t > reminder.t && item.t < reminder.t + 3000) : [];
  record('FS-79 when the dialog agent\'s run gets a reminder, the program delivery that waits for agent_settled '
    + '(the request_closed report) starts only after the request with the reminder (the finish check, whose default '
    + 'reply fc-check-wait delays by 3 s): it is sent, and no other request of the session overlaps it',
  Boolean(reminder) && ridingOf(reminder)?.check === true && deliveries.length >= 1
    && deliveries[0].t >= reminder.t + 2800 && overlap.length === 0,
  brief({ requests: requests.map((item) => ({ t: item.t, k: item.info.k, j: item.info.j })),
    reminder: reminder?.t }));
}

/** @brief FS-80：后台实例的行带归属 <role> · T1，说明行按记录的 10 minutes。 */
async function instanceRows(ctx, a) {
  const blocks = await awayBlocksOf(ctx, a.tab);
  const entry = awayRecords(a.sessionFile).find((item) => item.requestId === a.request);
  const want = rowOf(entry, ['Mori · T1', 'Denied', 'Write ../fs72-a.md']);
  const rows = blocks.flatMap((block) => block.rows);
  record('FS-80 a background instance row starts with its owner: "Mori · T1 · Denied · Write ../fs72-a.md" with its '
    + 'time, and the note says "within 10 minutes"', rows.some((row) => same(row, want))
    && blocks.some((block) => block.note === blockNote(DURATION['10m'])), brief({ blocks, want }));
  ctx.views = { ...ctx.views, ta: blocks };
}

/**
 * @brief 后台实例的整个流程：a（交接、结案的卡）、b（交接前结束、正在输出时的记录）、c（程序投递），失焦时再开的
 *        late（FS-70）。
 */
async function teamCards(ctx) {
  await setAwayTimeout(ctx, '10m');
  try {
    const team = {
      a: await bgCard(ctx, ctx.p.team, [['fs-call', 'write file: ../fs72-a.md'], ['fs-after', A_HANDOFF],
        ['fs-close', 'call tool: mcp__srv__echo {"text":"fs72-close"}']], 'fs72-a.md'),
      b: await bgCard(ctx, ctx.p.team, [['fs-call', 'write file: ../fs72-b.md'], ['fs-after', 'say: Pausing fs72b.']],
        'fs72-b.md'),
      c: await openWith(ctx, ctx.p.team, teamMessage([['fs-call', 'say: Task step fs79.'],
        ['fs-create', 'ask user: db'], ['fc-check-wait', '3000']]),
      { kind: 'ask', team: true, marker: 'Task step fs79.', timeout: 90000 }),
    };
    await teamAway(ctx, team);
    ctx.team = team;
    await taskExpired(ctx, team.a);
    await closeExpired(ctx, team.a);
    workCard(ctx, team.b);
    await streamOrder(ctx, team.b);
    delivery(ctx, team.c);
    await instanceRows(ctx, team.a);
  } finally {
    await setAwayTimeout(ctx, '5m');
  }
}

// ---------- FS-90、FS-72：协作模式分开时（split 项目） ----------

/** 临时提问的问题文字（agent_message 发给 planner；问题里的 fs-ask 行让 ask 实例调用 MCP 工具） */
const ASK_QUESTION = JSON.stringify({ to: 'planner', text: `Why fs72? fs-ask: call tool: ${ECHO} {"text":"fs72-ask"} `
  + 'tb-scenario:fs-team' });

/**
 * FS-72：分开时三种拿“写进最后的总结”那一句的实例各自调用 MCP 工具（文件系统第 3 步起它们才有 MCP 工具）。
 * kind：实例种类；role：它的角色；team：消息经 /team 发（协作模式）；text：你的消息；what：检查名里的说法。
 * - ask：关闭模式下对话 Agent 用 agent_message 问 planner，开出临时提问（关闭模式的发起方没有 mcp: false，§8.3）；
 * - create：协作模式下 planner 的立项判断你的消息时做 fs-create 那一步；
 * - subscription：协作模式下一条带 fs-call 的消息走完 task 与结案，结案关闭需求时结论带 fs-sub 那一行，订阅
 *   request_closed 的 watcher 收到投递后做它。
 */
const INSTANCE_CALLS = Object.freeze({
  ask: { role: 'planner', team: false, what: 'a temporary question (ask instance)',
    text: teamMessage([['fs-off', `call tool: agent_message ${ASK_QUESTION}`]]) },
  create: { role: 'planner', team: true, what: 'the create agent (planner, split)',
    text: teamMessage([['fs-create', `call tool: ${ECHO} {"text":"fs72-create"}`], ['fs-note', 'fs72-create']]) },
  subscription: { role: 'watcher', team: true, what: 'a subscription (watcher, request_closed)',
    text: teamMessage([['fs-call', 'say: Task fs72s.'], ['fs-sub', `call tool: ${ECHO} {"text":"fs72-sub"}`],
      ['fs-note', 'fs72-sub']]) },
});

/** @brief 这个用户会话里某个种类、角色的实例会话文件（按实例会话第一条 mori.instance 条目认）；没有时为 null。 */
const instanceOfKind = (ctx, who, kind, role) => instanceFiles(ctx, who.sessionId).find((item) => {
  const mark = customOf(item.entries, 'mori.instance')[0];
  return mark?.kind === kind && mark.role === role;
}) ?? null;

/** @brief INSTANCE_CALLS 的每一种在 split 项目里开一个会话发出消息（窗口在前台），返回 { 种类: 会话 }。 */
async function startInstanceCalls(ctx) {
  const out = {};
  for (const [kind, call] of Object.entries(INSTANCE_CALLS)) {
    const who = await openFsSession(ctx, ctx.p.split);
    const { since } = await sendFs(ctx, who, call.text, { team: call.team, wait: false });
    out[kind] = Object.assign(who, { since, kind, role: call.role, request: null, instance: null, missing: null });
  }
  return out;
}

/**
 * @brief 这个会话的实例出了 MCP 调用的后台卡（填上 request、instance）或这次调用已经有了结果、没有出卡（第 3 步之前
 *        实例没有这个工具，填上 missing）时为真。
 */
async function instanceSettled(ctx, who) {
  if (who.request || who.missing) return true;
  const card = (await eventsOfType(ctx, who.sessionId, 'mori.team_approval_request', who.since))
    .find((item) => item.role === who.role && item.toolName === ECHO);
  if (card) {
    Object.assign(who, { request: card.requestId, instance: card.instance });
    return true;
  }
  const file = instanceOfKind(ctx, who, who.kind, who.role)?.file;
  const done = file ? resultEntries(file).find((item) => item.tool === ECHO) : null;
  if (done) {
    who.missing = `no background card: the ${who.kind} instance's ${ECHO} call returned "${oneLine(done.text, 160)}" `
      + '(instances get MCP tools from step 3, §8.6)';
  }
  return Boolean(done);
}

/** @brief 一起等 list 里各个实例的卡或结果，最多 timeout；到时还没有的记 missing。 */
async function waitInstanceCards(ctx, list, timeout) {
  await poll(async () => {
    let all = true;
    for (const who of list) all = (await instanceSettled(ctx, who)) && all;
    return all;
  }, timeout, 300);
  for (const who of list.filter((item) => !item.request && !item.missing)) {
    who.missing = `no background card from the ${who.kind} instance within ${timeout} ms (instances get MCP tools `
      + 'from step 3, §8.6)';
  }
}

/** @brief FS-72：一种实例的 MCP 调用到时，拿到“写进最后的总结”那一句，记录带它的角色、没有 task。 */
function instanceExpired(ctx, who, ends) {
  const { what, role } = INSTANCE_CALLS[who.kind];
  const name = `FS-72 ${what} whose MCP call waits while you are away ends with mori.team_approval_end { by: "away" } `
    + `and gets "… Mention it in your final summary."; its record has role ${role} and no task`;
  if (who.missing) {
    record(name, false, who.missing);
    return;
  }
  const end = ends.find((item) => item.requestId === who.request) ?? null;
  const file = instanceFiles(ctx, who.sessionId).find((item) => item.id === who.instance)?.file;
  const result = file ? resultEntries(file).find((item) => item.tool === ECHO) : null;
  const entry = awayRecords(who.sessionFile).find((item) => item.requestId === who.request);
  record(name, end?.by === 'away' && result?.text === awayDenial(DURATION['5m']) && result.isError
    && entry?.agent?.role === role && entry.agent.task === null && entry.agent.instance === who.instance,
  brief({ end, result, entry }));
}

/**
 * @brief FS-90、FS-72：分开时你不在，提问卡按推荐项回答后转给立项的投递带 “not the user's choice”；同一次失焦里临时提问、
 *        立项、订阅三种实例的 MCP 调用到时。
 */
async function splitAway(ctx) {
  const s1 = await openWith(ctx, ctx.p.split, teamMessage([['fs-dialog', 'ask user: db'], ['fs-note', 'fs90-away']]),
    { kind: 'ask', team: true, marker: 'fs90-away', timeout: 90000 });
  const calls = Object.values(await startInstanceCalls(ctx));
  await waitInstanceCards(ctx, calls, 90000);
  const want = forwardText([`"${DB_Q}"="PostgreSQL"${NOT_USER_CHOICE}`]);
  const forward = await whileAway(ctx, async () => {
    await waitEvent(ctx, s1.sessionId, 'mori.question_end', (item) => item.requestId === s1.request,
      { since: s1.since, timeout: AWAY_MS + 10000 });
    for (const who of calls.filter((item) => item.request)) await bgEnd(ctx, who);
    return poll(() => kindRequests(ctx, 'fs90-away', { kind: 'create', role: 'planner', since: s1.since })
      .find((item) => item.info.last?.startsWith('[Mori] New user message: Answer')) ?? null, 30000, 300);
  });
  record('FS-90 when the question card is answered with the recommended option while you are away, the delivery to '
    + `the create agent (planner) is "${want.replace('\n', ' / ')}"`, forward?.info.last === want,
  brief({ got: forward?.info.last ?? null }));
  for (const who of calls) {
    instanceExpired(ctx, who, await eventsOfType(ctx, who.sessionId, 'mori.team_approval_end', who.since));
  }
  for (const who of [s1, ...calls]) await waitTeamIdle(ctx, who, { timeout: 120000 });
}

// ---------- FS-81：停止与关闭（stop 项目） ----------

/**
 * @brief 合并会话再发一条 /team 消息，让对话 Agent（兼立项）自己问你（提问卡，排在后台批准卡后面）；返回
 *        { since, request }。协作模式下合并会话的写入、命令被收窄拒绝、不出卡（§8.3），它自己的卡只能是提问卡。
 */
async function ownAsk(ctx, who) {
  const { since } = await sendFs(ctx, who, teamMessage([['fs-create', 'ask user: db']]), { team: true, wait: false });
  const asked = await poll(async () => ((await liveInfo(ctx, who.sessionFile))?.live?.asks ?? [])[0] ?? null,
    60000, 200);
  if (!asked) throw new Error(`the merged session ${who.tab} did not ask`);
  return { since, request: asked.requestId };
}

/** @brief 这张卡（requestId）在 LiveSnapshot.awayTimers 里的那一项；没有时为 null。 */
const timerFor = (list, requestId) => list.find((item) => item.requestId === requestId) ?? null;

/**
 * @brief 等这几张卡的结束事件（ends：[事件类型, 请求 id, since]，各最多 10 秒），紧接着读这个会话的
 *        LiveSnapshot.awayTimers（liveTimers）：{ ended（各自的 by）, left, leftAt（读完的时刻） }。
 */
async function timersAfterEnd(ctx, who, ends) {
  const ended = [];
  for (const [type, requestId, since] of ends) {
    ended.push(await waitEvent(ctx, who.sessionId, type, (item) => item.requestId === requestId,
      { since, timeout: 10000 }));
  }
  const left = await liveTimers(ctx, who.sessionFile);
  return { ended: ended.map((item) => item?.by ?? null), left, leftAt: Date.now() };
}

/**
 * @brief FS-81：失焦时这几张卡（requests）都收到了计时（seen.timers），结束之后、截止时刻之前读到的 awayTimers 里
 *        没有它们。到时之后才看“没有记录”的话，泄漏的计时器到时也只是找不到挂着的请求，看不出来，所以在截止前读。
 * @param what 检查名里的结束方式
 * @param seen { timers（cardTimers 的结果）, left, leftAt }
 */
function recordCleared(what, seen, requests) {
  const deadline = seen.timers?.[0].deadline ?? null;
  record(`FS-81 right after ${what}, before the deadline, the background process no longer times the ended card(s): `
    + 'LiveSnapshot.awayTimers has no entry for them, although each had a running timer since the blur',
  Boolean(seen.timers) && deadline !== null && seen.leftAt < deadline
    && requests.every((requestId) => !timerFor(seen.left, requestId)), brief({ requests, deadline, ...seen }));
}

/** @brief Esc 那一种的检查：自己的卡结束（by stop）、计时清掉；后台卡还按失焦时的截止时刻计时，之后按你不在结束。 */
async function escChecks(ctx, who, own, seen) {
  recordCleared('Esc (the dialog\'s own question card)', seen, [own.request]);
  const deadline = seen.timers?.[0].deadline ?? null;
  record('FS-81 after Esc the background card keeps its timer: right after the stop LiveSnapshot.awayTimers still '
    + 'has it with the deadline it got at the blur', Boolean(seen.timers)
    && timerFor(seen.left, who.request)?.deadline === deadline, brief({ deadline, left: seen.left }));
  const ownEnd = (await eventsOfType(ctx, who.sessionId, 'mori.question_end', own.since))
    .filter((item) => item.requestId === own.request);
  const bgEnds = (await eventsOfType(ctx, who.sessionId, 'mori.team_approval_end', who.since))
    .filter((item) => item.requestId === who.request);
  const records = awayRecords(who.sessionFile).map((item) => item.requestId);
  record('FS-81 Esc stops the dialog: its own card (the question card of the merged session) ends (by stop) and never '
    + 'gets a record, while the background card keeps counting and ends by away',
  ownEnd.length === 1 && ownEnd[0].by === 'stop' && bgEnds.length === 1 && bgEnds[0].by === 'away'
    && same(records, [who.request]), brief({ ownEnd, bgEnds, records }));
}

/** @brief Esc：对话自己的卡（提问卡）结束、计时清掉；后台卡继续计时到时。 */
async function escCase(ctx) {
  const who = await bgCard(ctx, ctx.p.stop, [['fs-call', 'write file: ../fs81-bg.md']], 'fs81-bg.md');
  const own = await ownAsk(ctx, who);
  const blurAt = Date.now();
  const seen = await whileAway(ctx, async () => {
    const timers = await cardTimers(ctx, [who, { sessionId: who.sessionId, request: own.request }], blurAt);
    await sleep(2000);
    await pressInComposer(ctx, who.tab, 'Escape');
    const left = await timersAfterEnd(ctx, who, [['mori.question_end', own.request, own.since]]);
    await waitEvent(ctx, who.sessionId, 'mori.team_approval_end', (item) => item.requestId === who.request,
      { since: who.since, timeout: AWAY_MS + 10000 });
    await sleep(2000);
    return { timers, ...left };
  });
  await escChecks(ctx, who, own, seen);
  await waitTeamIdle(ctx, who, { timeout: 120000 });
}

/** @brief Stop team：对话自己的卡（合并会话的提问卡）与后台卡全部结束、计时都清掉。 */
async function stopTeamCase(ctx) {
  const who = await bgCard(ctx, ctx.p.stop, [['fs-call', 'write file: ../fs81-team.md']], 'fs81-team.md');
  const own = await ownAsk(ctx, who);
  const blurAt = Date.now();
  const seen = await whileAway(ctx, async () => {
    const timers = await cardTimers(ctx, [who, { sessionId: who.sessionId, request: own.request }], blurAt);
    await sleep(2000);
    await showTab(ctx, who.tab);
    await ctx.page.locator(`${paneSel(who.tab)} [data-testid="stop-team"]`).click({ timeout: 10000 });
    const left = await timersAfterEnd(ctx, who, [['mori.team_approval_end', who.request, who.since],
      ['mori.question_end', own.request, own.since]]);
    await sleep(AWAY_MS + 2000);
    return { timers, ...left };
  });
  recordCleared('Stop team (the dialog\'s own question card and the background card)', seen,
    [who.request, own.request]);
  const ownEnd = (await eventsOfType(ctx, who.sessionId, 'mori.question_end', own.since))
    .filter((item) => item.requestId === own.request);
  const ends = (await eventsOfType(ctx, who.sessionId, 'mori.team_approval_end', who.since))
    .filter((item) => item.requestId === who.request);
  const records = awayRecords(who.sessionFile);
  record('FS-81 Stop team ends every card of the session, the dialog\'s own card (the question card of the merged '
    + 'session, by stop) and the background card (by stop): no record and no end by away after the deadline',
  ownEnd.length === 1 && ownEnd[0].by === 'stop' && ends.length === 1 && ends[0].by === 'stop'
    && records.length === 0, brief({ ownEnd, ends, records }));
  await waitTeamIdle(ctx, who, { timeout: 120000 });
}

/**
 * @brief Allow for this session：在挂着的后台卡上选它，这张卡由你的回答结束（by user）、按允许，计时清掉。一个用户会话
 *        同一时刻只有一个 task 实例在跑（fs-team 脚本），App 里造不出两张同名的挂着的卡；“其他同名的卡按 session 结束、
 *        计时清掉”由单元测试 “FS-81 Allow for this session, Full access and allowing a folder end cards as allowed and
 *        clear their timers”（tests/unit/filesystem/away.test.mjs）查。
 */
async function allowSessionCase(ctx) {
  const who = await bgCard(ctx, ctx.p.stop, [['fs-call', 'run: echo fs81-allow']], 'fs81-allow');
  const blurAt = Date.now();
  const seen = await whileAway(ctx, async () => {
    const timers = await cardTimers(ctx, [who], blurAt);
    await sleep(1500);
    const card = await answerCard(ctx, who.tab, 'second');
    if (card.request !== who.request || card.second?.kind !== 'tool') {
      throw new Error(`no "Allow for this session" on the background card: ${JSON.stringify(card)}`);
    }
    const left = await timersAfterEnd(ctx, who, [['mori.team_approval_end', who.request, who.since]]);
    await sleep(AWAY_MS + 2000);
    return { timers, ...left };
  });
  recordCleared('"Allow for this session" on the background card', seen, [who.request]);
  const ends = (await eventsOfType(ctx, who.sessionId, 'mori.team_approval_end', who.since))
    .filter((item) => item.requestId === who.request);
  const records = awayRecords(who.sessionFile);
  record('FS-81 choosing "Allow for this session" on a waiting background card ends it as allowed (by user): no '
    + 'record and no end by away after the deadline', ends.length === 1 && ends[0].decision === 'allow'
    && ends[0].by === 'user' && records.length === 0, brief({ others: 'other pending cards of the same tool: unit '
    + 'test "FS-81 Allow for this session, Full access and allowing a folder end cards as allowed and clear their '
    + 'timers"', ends, records }));
  await waitTeamIdle(ctx, who, { timeout: 120000 });
}

/** @brief 切到 Full access：工作路径里的卡按 full 结束，计时清掉。 */
async function fullCase(ctx) {
  const who = await openWith(ctx, ctx.p.stop, 'run: echo fs81-full');
  const blurAt = Date.now();
  const seen = await whileAway(ctx, async () => {
    const timers = await cardTimers(ctx, [who], blurAt);
    await sleep(1500);
    await setPermission(ctx, who.tab, 'full');
    const left = await timersAfterEnd(ctx, who, [['mori.approval_end', who.request, who.since]]);
    await sleep(AWAY_MS + 2000);
    return { timers, ...left };
  });
  recordCleared('switching to Full access (a card inside the working directory)', seen, [who.request]);
  const ends = (await eventsOfType(ctx, who.sessionId, 'mori.approval_end', who.since))
    .filter((item) => item.requestId === who.request);
  record('FS-81 switching to Full access ends the waiting card inside the working directory (by full): no record '
    + 'after the deadline', ends.length === 1 && ends[0].by === 'full' && awayRecords(who.sessionFile).length === 0,
  brief(ends));
  await waitQuiet(ctx, who.tab);
  await setPermission(ctx, who.tab, 'ask');
}

/** @brief 与到时同时到达的回答：只生效一个，另一个是 no longer pending。 */
async function raceCase(ctx) {
  const who = await openWith(ctx, ctx.p.stop, 'write file: fs81-race.md');
  const answer = await whileAway(ctx, async () => {
    const timer = await waitEvent(ctx, who.sessionId, 'mori.away_timer', (item) => item.requestId === who.request
      && item.deadline !== null, { since: who.since, timeout: 5000 });
    if (!timer) throw new Error('no timer for the race card');
    await waitUntil(timer.deadline - 5);
    const sent = await tryBridge(ctx, { type: 'approval.answer', sessionId: who.sessionId, requestId: who.request,
      decision: 'allow' });
    await sleep(2500);
    return sent;
  });
  const ends = (await eventsOfType(ctx, who.sessionId, 'mori.approval_end', who.since))
    .filter((item) => item.requestId === who.request);
  const records = awayRecords(who.sessionFile);
  const userWon = ends[0]?.by === 'user' && answer.error === null && records.length === 0;
  const awayWon = ends[0]?.by === 'away' && answer.error === approvalGone(who.request) && records.length === 1;
  record('FS-81 an answer that arrives together with the timeout: only one takes effect (one mori.approval_end, one '
    + 'record at most) and the other gets "Approval request <id> is no longer pending"', ends.length === 1
    && (userWon || awayWon), brief({ ends, answer, records: records.length }));
  await waitQuiet(ctx, who.tab);
}

/** @brief FS-81 的各种结束方式（关闭会话在 reopen 步骤：退出 App 时卡还挂着）。 */
async function stopClose(ctx) {
  await escCase(ctx);
  await stopTeamCase(ctx);
  await allowSessionCase(ctx);
  await fullCase(ctx);
  await raceCase(ctx);
}

// ---------- FS-70：计时总在请求事件之后 ----------

/**
 * @brief FS-70：这次启动里（FS-69 重新载入页面之后）每个 mori.away_timer（有截止时刻的）都在它那张卡的请求事件之后
 *        到达；四种请求各至少有一张是窗口不在前台时新到的（在前台时到的卡要到失焦才计时，排在请求之后不说明什么）。
 */
async function timerAfterRequest(ctx) {
  const order = await timerOrder(ctx, 0);
  const late = Object.fromEntries(REQUEST_TYPES.map((type) => [type, order.items
    .filter((item) => item.type === type && unfocusedAt(ctx, item.requestT)).length]));
  record('FS-70 every mori.away_timer with a deadline came after the request event of its card on the same envelope, '
    + 'and for each of the four kinds (mori.approval_request, mori.team_approval_request, mori.question_request, '
    + 'mori.ui_request) at least one such card arrived while the window was unfocused',
  order.checked > 0 && order.missing.length === 0 && REQUEST_TYPES.every((type) => late[type] > 0),
  brief({ checked: order.checked, missing: order.missing, kinds: order.kinds, late }));
}

// ---------- 重新启动之后：FS-71、FS-76、FS-78、FS-80、FS-81、FS-87 ----------

/** @brief 重新打开会话后：工具卡、那一块、提醒都和实时一样。 */
async function reopenChecks(ctx) {
  const t = ctx.t;
  const views = {};
  for (const [key, who] of Object.entries({ a: t.a, b: t.b, c: t.c, ta: ctx.team?.a })) {
    if (!who) continue;
    await reopenFs(ctx, who);
    views[key] = { blocks: await awayBlocksOf(ctx, who.tab), cards: await toolCardsOf(ctx, who.tab),
      reminder: await transcriptHasReminder(ctx, who.tab) };
  }
  const denied = views.a?.cards.find((card) => card.title.includes('fs71-big.md'));
  record(`FS-71 after reopening the session the expired call's tool card still reads "${AWAY_DENIED}"`,
    denied?.statusText === AWAY_DENIED, brief(denied));
  const asked = views.b?.cards.find((card) => card.title === 'Ask · Database, Scope');
  record('FS-87 after reopening the session the tool card of the question answered while away still reads Done',
    asked?.status === 'done' && asked.statusText.startsWith('Done'), brief(asked));
  record('FS-80 after reopening the sessions (App restarted) the "Decided while you were away" blocks are the same as '
    + 'live', Object.entries(views).every(([key, view]) => same(view.blocks, ctx.views?.[key])),
  brief(Object.fromEntries(Object.entries(views).map(([key, view]) => [key, view.blocks]))));
  record('FS-78 after reopening the sessions the reminders are still not shown in the transcript',
    Object.values(views).every((view) => !view.reminder), brief(Object.keys(views)));
}

/**
 * @brief 退出 App 时窗口不在前台、卡还挂着（FS-81 关闭会话），用 26 秒的计时重新启动，再做重新打开后的检查。
 *        挂着卡的会话不空闲，归档、删除（session.close）都被拒绝，App 里能在卡挂着时关闭会话的只有退出；退出在截止之前，
 *        后台进程随之结束，看不到计时器本身，这里只验没有自动处理的记录。“关闭会话清掉全部计时”由单元测试
 *        “FS-81 closing the session clears every timer”（tests/unit/filesystem/away.test.mjs）查。
 */
async function reopen(ctx) {
  const close = await openWith(ctx, ctx.p.stop, 'write file: fs81-close.md');
  await blurWindow(ctx);
  await sleep(1500);
  await closeFsApp(ctx);
  ctx.projectTabs = {};
  ctx.env = { MORI_AWAY_TIMEOUT_MS: String(COUNT_MS) };
  await startAwayApp(ctx);
  record('FS-81 quitting Mori while the window is unfocused and a card waits (closing its session) leaves no away '
    + 'record for that card', awayRecords(close.sessionFile).length === 0, brief({ records: awayRecords(
    close.sessionFile), timers: 'cleared on close: unit test "FS-81 closing the session clears every timer" (the App '
    + 'quits before the deadline, so the timer itself is not observable here)' }));
  // 后台进程收到 start 才读 away.json，读完之前 away.get 是默认值（file-system-permissions.md §9.6）：等它读完
  const got = await poll(async () => {
    const value = await bridge(ctx, { type: 'away.get' });
    return value?.timeout === '10m' ? value : null;
  }, 5000, 200) ?? await bridge(ctx, { type: 'away.get' });
  const view = await openGeneral(ctx, '10m');
  await closeSettings(ctx);
  record('FS-76 the setting survives a restart: away.get returns 10m and Settings > General shows 10 minutes',
    same(got, { timeout: '10m', error: null }) && view.shown === '10 minutes', brief({ got, view }));
  if (ctx.t) await reopenChecks(ctx);
}

// ---------- FS-77：倒计时（26 秒的计时） ----------

/** @brief 三种卡此刻的倒计时一行：{ approval, ask, extension }（逐个显示那个会话再读）。 */
async function allCountdowns(ctx, w) {
  const out = {};
  for (const kind of Object.keys(w)) {
    await showTab(ctx, w[kind].tab);
    out[kind] = (await countdownsOf(ctx, w[kind].tab))[kind];
  }
  return out;
}

/** @brief 一行倒计时是 kind 那种卡的写法、截止时刻是 deadline；返回剩下的秒数，不对时为 null。 */
function countdownSeconds(line, kind, deadline) {
  const match = /^You’re away · (.+) in (\d+)s$/.exec(line?.text ?? '');
  const ok = match && match[1] === COUNTDOWN_ACTION[kind] && line.deadline === deadline && Number(match[2]) <= 20;
  return ok ? Number(match[2]) : null;
}

/** @brief 第一次失焦：多于 20 秒时没有倒计时；最后 20 秒每种卡各自一行、每秒刷新；切回时消失。 */
async function countFirst(ctx, w) {
  const list = Object.values(w);
  const blurAt = Date.now();
  await blurWindow(ctx);
  const timers = await cardTimers(ctx, list, blurAt);
  const deadline = timers?.[0].deadline ?? blurAt + COUNT_MS;
  await sleep(1500);
  const early = await allCountdowns(ctx, w);
  await waitUntil(deadline - 18500);
  const late = await allCountdowns(ctx, w);
  await sleep(1300);
  const second = await allCountdowns(ctx, w);
  record('FS-77 while more than 20 seconds are left no card shows a countdown line',
    Object.values(early).every((line) => line === null), brief(early));
  const seconds = Object.fromEntries(Object.keys(w)
    .map((kind) => [kind, countdownSeconds(late[kind], kind, deadline)]));
  record('FS-77 in the last 20 seconds each kind of card shows its own line with the deadline of mori.away_timer: '
    + '"You’re away · Denying in Ns" (approval), "You’re away · Using the recommended options in Ns" (question), '
    + '"You’re away · Cancelling in Ns" (extension prompt)', Boolean(timers) && Object.values(seconds)
    .every((value) => value !== null), brief({ late, deadline }));
  const next = countdownSeconds(second.approval, 'approval', deadline);
  record('FS-77 the countdown refreshes every second (the approval card\'s number goes down between two reads 1.3 s '
    + 'apart)', seconds.approval !== null && next !== null && next < seconds.approval, brief({ late, second }));
  const back = Date.now();
  await focusWindow(ctx);
  const gone = await poll(async () => (Object.values(await allCountdowns(ctx, w)).every((line) => line === null)),
    3000, 150);
  const cleared = await cardTimers(ctx, list, back, true);
  record('FS-77 switching back to Mori removes the countdown lines (mori.away_timer deadline: null)',
    Boolean(gone) && Boolean(cleared), brief({ cleared }));
  return deadline;
}

/** @brief 再失焦：从头计；最后 20 秒里界面重新载入（Ctrl+R），倒计时从 LiveSnapshot.awayTimers 接着显示。 */
async function countReload(ctx, w, first) {
  const list = Object.values(w);
  await sleep(1500);
  const blurAt = Date.now();
  await blurWindow(ctx);
  const timers = await cardTimers(ctx, list, blurAt);
  const deadline = timers?.[0].deadline ?? blurAt + COUNT_MS;
  record('FS-70 losing focus again restarts the timer (26 s run): a new deadline = the blur time + the timeout, after '
    + 'the first one', Boolean(timers) && deadline > first && Math.abs(deadline - (blurAt + COUNT_MS)) <= MARGIN,
  brief({ first, timers }));
  await waitUntil(deadline - 17000);
  await reloadFsUi(ctx);
  for (const who of list) await reopenFs(ctx, who);
  const after = await allCountdowns(ctx, w);
  const live = [];
  for (const who of list) live.push(...((await liveInfo(ctx, who.sessionFile))?.live?.awayTimers ?? []));
  record('FS-77 after the window reloads (Ctrl+R) the countdown lines come back from LiveSnapshot.awayTimers with the '
    + 'same deadline', Object.keys(w).every((kind) => countdownSeconds(after[kind], kind, deadline) !== null)
    && list.every((who) => live.some((item) => item.requestId === who.request && item.deadline === deadline)),
  brief({ after, live }));
  await waitUntil(deadline + 3000);
}

/** @brief FS-77、FS-70：三种卡（ext 项目）的倒计时。 */
async function countdown(ctx) {
  const w = {
    approval: await openWith(ctx, ctx.p.ext, 'write file: fs77-count.md'),
    ask: await openWith(ctx, ctx.p.ext, 'ask user: db\nmarker fs77-ask', { kind: 'ask', marker: 'fs77-ask' }),
    extension: await openExt(ctx, ctx.p.ext, 'call tool: fs_ext_confirm'),
  };
  try {
    const first = await countFirst(ctx, w);
    await countReload(ctx, w, first);
  } finally {
    await focusWindow(ctx);
  }
  for (const who of Object.values(w)) await waitQuiet(ctx, who.tab, 60000);
  const cards = [await cardOf(ctx, w.approval.tab), await askCardOf(ctx, w.ask.tab), await extCardOf(ctx,
    w.extension.tab)];
  record('FS-77 at the deadline the three cards are decided and go away', cards.every((card) => card === null),
    brief(cards));
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  settingsDefault: [settingsDefault, ['FS-76']],
  focus: [focusMessages, ['FS-69']],
  timing: [timing, ['FS-70', 'FS-71', 'FS-73', 'FS-78', 'FS-80', 'FS-87']],
  rules: [reminderRules, ['FS-78', 'FS-80']],
  extension: [extension, ['FS-74', 'FS-78', 'FS-80', 'FS-70']],
  never: [never, ['FS-75']],
  team: [teamCards, ['FS-72', 'FS-78', 'FS-79', 'FS-80', 'FS-70']],
  split: [splitAway, ['FS-90', 'FS-72']],
  stop: [stopClose, ['FS-81']],
  timerOrder: [timerAfterRequest, ['FS-70']],
  settingsSave: [settingsSave, ['FS-76']],
  // 重新启动 App（计时换成 26 秒）：放在这之后的步骤都在第二次启动里
  reopen: [reopen, ['FS-71', 'FS-76', 'FS-78', 'FS-80', 'FS-81', 'FS-87']],
  countdown: [countdown, ['FS-77', 'FS-70']],
  saveFails: [saveFails, ['FS-76']],
  // 再重新启动一次（写坏的 away.json）：放在最后
  brokenFile: [brokenFile, ['FS-76']],
};

const ctx = { ...fsUserData('mori-fs-away-data-'), exePath: args.exePath, pageErrors: [], args, record,
  env: { MORI_AWAY_TIMEOUT_MS: String(AWAY_MS) }, views: {} };
await runSuite(ctx, setup, steps);
console.log(`[fs-app-away] data in ${ctx.userData}, projects in ${ROOT}`);
finish();
