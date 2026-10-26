// 平行 Agent 与 TaskBoard 的 App 套件：右栏的 Background tasks（docs/specs/parallel-agents-taskboard.md §13.13、§17.2；
// docs/v1/screens/team-tasks.md）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式
// （tests/fake-endpoint/scenarios/tasks.mjs，synthetic），逐条验收这些编号在 App 层的通过条件：
//   TB-80 入口、TB-81 列表、TB-82 task 的视图、TB-83 实例的会话、TB-84 只读与边界、TB-85 重新打开与重启、
//   TB-86 界面文字与键盘、TB-87 现有功能不退步、TB-89 停止一个 task。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs tasks）：
//   MORI_APP_DIR=.tb-runs/tasks node tests/ui/tb-app-tasks.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 步骤：plain、empty、entries、list、taskview、transcript、folding、keys、stop、readonly、reload、approval、menu、errors、
// restart（entries 到 reload 共用一个会话，按这个顺序；folding 要 WP-14 的步骤组、menu 要 WP-09 的模型菜单，合并之前
// 这两步失败；errors 让后台进程退出，restart 最后跑，重启 App）。
// 结果写到 test-results/tb-app-tasks(-packaged).json（--only 时 tb-partial-app-tasks…），截图在 test-results/tb-app-tasks/。
// 端口（§17.3：tb-app-tasks*.mjs 用 4950–4959）：合成端点 4950，记录代理 4951。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好一个本机提供商（写入等级 A、能关思考，跳过探针）；
// 三个临时项目：分开配置（chat / planner / executor / reviewer）两个、没有角色文件一个。同一时刻只开一个 App。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  TASKS_CONCLUSION, TASKS_MESSAGE, TASKS_OPEN_ITEM,
} from '../fake-endpoint/scenarios/tasks.mjs';
import {
  allowAll, bridge, brief, closeTbApp, instanceFiles, killTbKernel, missingSteps, openSessionIn, paneSel, paneState,
  poll, progressOf, readBoard, reopenSession, restartTbApp, scenarioLines, seedTeamUserData, sendMessage, shot,
  showTab, sleep, SPLIT_ROLES, startTbApp, startTbEndpoint, stopTbEndpoint, suiteArgs, tbModel, tbProvider, tbRecorder,
  teamDir, tempProject, tempUserData, userSession, waitApprovalCard, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';
import {
  bgCards, bgTabs, clickBack, clickCard, clickTab, issueReport, openTranscript, panelOpen, tasksButton,
  taskViewOf, transcriptOf, waitCard, waitTaskView, waitTranscript,
} from './tb-tasks-helpers.mjs';

const args = suiteArgs('tasks');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理（§17.3） */
const PORT = 4950;
const PROXY = 4951;
/** 合成端点上的模型（synthetic）：写入等级 A、能关思考 */
const MODEL = 'fake-coder-tbtasks';
/** 程序给的固定文字（§11.3 停止时挂着的卡回给模型的、§11.6 重启） */
const REJECTED_BY_STOP = 'Rejected: the user stopped the run.';
const RESTARTED = 'Stopped (Mori restarted)';

/** @brief 这个套件的脚本标记（scenarios/tasks.mjs 的 tb-tasks-<name>）。 */
const tag = (name) => `tb-scenario:tb-tasks-${name}`;
/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// ---------- 准备与会话 ----------

/** @brief 测试准备（synthetic test setup）：三个临时项目、数据目录、合成端点。 */
async function setup(ctx) {
  ctx.split = tempProject('mori-tb-tasks-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  ctx.split2 = tempProject('mori-tb-tasks-split2-');
  writeRoles(ctx.split2, SPLIT_ROLES);
  ctx.plain = tempProject('mori-tb-tasks-plain-');
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, { providers: [tbProvider('tbtasks', PROXY, [tbModel(MODEL)])] });
  await startTbApp(ctx);
}

/** @brief 在 project 里开一个新会话（可先切到全部允许），发第一条消息；返回 { tab, sessionId, sessionFile, since }。 */
async function begin(ctx, project, text, { team = true, allow = false } = {}) {
  const tab = await openSessionIn(ctx, project);
  if (allow) await allowAll(ctx, tab);
  const since = Date.now();
  await sendMessage(ctx, tab, text, { team });
  return { tab, ...(await userSession(ctx, tab)), since };
}

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/** @brief 等这个会话的对话停下（后台可以还在运行）。 */
async function dialogIdle(ctx, who, timeout = 60000) {
  const idle = await poll(async () => {
    const pane = await paneState(ctx.page, who.tab);
    return pane && !pane.running && !pane.sending;
  }, timeout, 100);
  if (!idle) throw new Error(`the dialog of ${who.tab} did not become idle`);
}

/** @brief 等 board.json 满足 pred，返回那时的 board；超时时报错。 */
async function waitBoard(ctx, who, pred, what, timeout = 60000) {
  const board = await poll(() => {
    const value = readBoard(ctx, who.sessionId);
    return value && pred(value) ? value : null;
  }, timeout, 100);
  if (!board) throw new Error(`board.json never had ${what}`);
  return board;
}

/** @brief board.json 里的一个 task。 */
const taskOf = (board, id) => board?.tasks.find((task) => task.id === id) ?? null;

/**
 * @brief flow 会话（entries 到 reload 共用）：开会话、全部允许、发第一条消息，等 T1、T2 做完、T3 在运行、T4 等写入锁。
 */
async function flowSession(ctx) {
  if (ctx.flow) return ctx.flow;
  const who = await begin(ctx, ctx.split, `Fix the login page ${tag('flow')}`, { allow: true });
  await waitBoard(ctx, who, (board) => taskOf(board, 'T2')?.status === 'done'
    && taskOf(board, 'T3')?.status === 'active', 'T1, T2 done and T3 running', 90000);
  await dialogIdle(ctx, who);
  ctx.flow = who;
  return who;
}

/** @brief 让这个会话显示出来，右栏关着。 */
async function closedPanel(ctx, who) {
  await showTab(ctx, who.tab);
  if (await panelOpen(ctx)) await ctx.page.locator('[data-testid="right-panel"] [aria-label="Close panel"]').first()
    .click();
}

/**
 * @brief 让这个会话显示出来，右栏开着、在 Background tasks 的列表：关着时点阶段行按钮，在 Changes 时点页签，在 task 的
 *        视图或会话里时点 Back 回到列表（不再点阶段行按钮，开着时点它会关上右栏）。
 */
async function openList(ctx, who) {
  await showTab(ctx, who.tab);
  if (!(await panelOpen(ctx))) await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tasks-button"]`).click();
  if ((await bgTabs(ctx)).find((item) => item.tab === 'tasks')?.selected !== 'true') await clickTab(ctx, 'tasks');
  for (let i = 0; i < 3 && !(await ctx.page.locator('[data-testid="bg-tasks"]').count()); i += 1) await clickBack(ctx);
  await ctx.page.locator('[data-testid="bg-tasks"]').waitFor({ timeout: 5000 });
}

/** @brief 等阶段行按钮的文字（mori.board 合并发送，界面晚一点才跟上 board.json）；返回那时的按钮。 */
const waitButton = (ctx, who, text, timeout = 10000) => poll(async () => {
  const button = await tasksButton(ctx, who.tab);
  return button?.text === text ? button : null;
}, timeout, 100);

// ---------- TB-80、TB-87：没有 TaskBoard 的会话与入口 ----------

/** @brief 没有角色文件、没用过协作模式的会话：右栏、阶段行与 v0 相同（TB-03）。 */
async function plain(ctx) {
  const who = await begin(ctx, ctx.plain, 'Say hello', { team: false });
  await dialogIdle(ctx, who);
  await ctx.page.locator(`${paneSel(who.tab)} button[aria-label="Toggle changes"]`).click();
  const header = await ctx.page.locator('[data-testid="right-panel"] .panel-header').first().textContent()
    .catch(() => null);
  const tabs = await bgTabs(ctx);
  const button = await tasksButton(ctx, who.tab);
  record('TB-80 a session with no request and team mode off: the right panel is as before ("This session’s changes", '
    + 'no tabs) and the stage line has no tasks button',
  header?.includes('This session’s changes') && tabs.length === 0 && button === null, brief({ header, tabs, button }));
  record('TB-87 the right panel of a session without a TaskBoard keeps the v0 header', header !== null, brief(header));
}

/** @brief 分开配置的会话打开协作模式、还没有需求：两个页签，Background tasks 下是空的提示，阶段行没有按钮。 */
async function empty(ctx) {
  const tab = await openSessionIn(ctx, ctx.split2);
  const who = { tab, ...(await userSession(ctx, tab)) };
  // 经进程桥打开协作模式（开关的位置由 WP-09 改到模型菜单，这里不点界面上的开关）
  await bridge(ctx, { type: 'session.setTeam', sessionId: who.sessionId, mode: 'on' });
  await ctx.page.locator(`${paneSel(tab)} button[aria-label="Toggle changes"]`).click();
  const tabs = await poll(async () => {
    const list = await bgTabs(ctx);
    return list.length === 2 ? list : null;
  }, 10000) ?? await bgTabs(ctx);
  await clickTab(ctx, 'tasks');
  const text = await ctx.page.locator('[data-testid="bg-tasks"]').textContent({ timeout: 5000 }).catch(() => null);
  const button = await tasksButton(ctx, tab);
  record('TB-80 team mode on with no request: the right panel has the tabs Changes and Background tasks '
    + '(role tab, aria-selected), and the stage line has no tasks button (no task yet)',
  same(tabs.map((item) => [item.tab, item.text, item.role]), [['changes', 'Changes', 'tab'],
    ['tasks', 'Background tasks', 'tab']]) && button === null, brief({ tabs, button }));
  record('TB-81 with the tabs but no task yet, Background tasks shows "Background tasks appear here"',
    text?.trim() === 'Background tasks appear here', brief(text));
  await bridge(ctx, { type: 'session.setTeam', sessionId: who.sessionId, mode: 'off' });
}

/** @brief 阶段行按钮、页签、进展摘要的链接（TB-80）；F8 记下这些操作。 */
async function entries(ctx) {
  const who = await flowSession(ctx);
  await closedPanel(ctx, who);
  const idle = await waitButton(ctx, who, '2 running tasks') ?? await tasksButton(ctx, who.tab);
  record('TB-80 the stage-line button shows while the dialog is not replying: "2 running tasks" (T3 running, T4 '
    + 'waiting), hover "Show this session’s background tasks", not pressed',
  idle?.text === '2 running tasks' && idle.title === 'Show this session’s background tasks' && idle.pressed === 'false',
  brief(idle));
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tasks-button"]`).click();
  const opened = { tabs: await bgTabs(ctx), button: await tasksButton(ctx, who.tab),
    list: await ctx.page.locator('[data-testid="bg-tasks"]').count() };
  record('TB-80 clicking it opens the right panel at Background tasks; the button is pressed',
    opened.list === 1 && opened.tabs.find((item) => item.tab === 'tasks')?.selected === 'true'
      && opened.button?.pressed === 'true', brief(opened));
  await clickTab(ctx, 'changes');
  const onChanges = await tasksButton(ctx, who.tab);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tasks-button"]`).click();
  const back = await tasksButton(ctx, who.tab);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tasks-button"]`).click();
  const closed = await panelOpen(ctx);
  record('TB-80 on the Changes tab the button is not pressed and switches to Background tasks; clicked again it '
    + 'closes the right panel',
  onChanges?.pressed === 'false' && back?.pressed === 'true' && closed === false, brief({ onChanges, back, closed }));
  await progressLinks(ctx, who);
}

/** @brief 进展摘要的两种链接（TB-80）。 */
async function progressLinks(ctx, who) {
  const rows = (await progressOf(ctx, who.tab))[0];
  const row = ctx.page.locator(`${paneSel(who.tab)} [data-testid="progress-task"][data-task="T3"]`);
  const label = await row.getAttribute('aria-label').catch(() => null);
  await row.click();
  const view = await waitTaskView(ctx, 'T3');
  record('TB-80 a task row of the progress summary is a button "Open T3 Long change in Background tasks" that opens '
    + 'the right panel at that task\'s view',
  label === 'Open T3 Long change in Background tasks' && view?.task === 'T3', brief({ label, view: view?.title }));
  const icon = ctx.page.locator(`${paneSel(who.tab)} [data-action="open-in-tasks"][data-request="1"]`);
  const iconLabel = await icon.getAttribute('aria-label').catch(() => null);
  await icon.click();
  const flashed = await poll(() => ctx.page.locator('[data-testid="bg-task"][data-request="1"].jump-flash').count(),
    3000, 50);
  const expanded = (await progressOf(ctx, who.tab))[0]?.expanded;
  record('TB-80 the title row has an icon button "Open Request 1 in Background tasks" that opens the list and '
    + 'highlights that request\'s tasks; the title row itself still expands and collapses (not changed by it)',
  iconLabel === 'Open Request 1 in Background tasks' && flashed > 0 && expanded === rows?.expanded,
  brief({ iconLabel, flashed, expanded, before: rows?.expanded }));
  const report = await issueReport(ctx, who.tab, 'Background tasks entries');
  const wanted = ['Open background tasks', 'Open T3 in Background tasks'];
  record('TB-80 F8 records "Open background tasks" and "Open T3 in Background tasks"',
    wanted.every((line) => report.actions.some((item) => item.includes(line))), brief(report.actions.slice(-8)));
}

// ---------- TB-81 列表 ----------

/** @brief Running / Finished 两节、卡片的各行、折叠、Depends on 与 View transcript（TB-81）。 */
async function list(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  const cards = await bgCards(ctx);
  const order = cards.map((card) => `${card.section}:${card.task}`);
  record('TB-81 Running holds T3, T4 by id; Finished holds T2, T1 (newest id first)',
    same(order, ['running:T3', 'running:T4', 'finished:T2', 'finished:T1']), brief(order));
  const byId = Object.fromEntries(cards.map((card) => [card.task, card]));
  record('TB-81 a card is "T1 <title>" over "Request 1 · <role> · <what it is doing> · <duration>" '
    + '(the doing text as in the progress summary)',
  byId.T1?.title === 'T1 Find the cause' && /^Request 1 · executor · Done · (<1|\d+) min$/.test(byId.T1.line)
    && /^Request 1 · executor · Waiting to change files \(T3\) · /.test(byId.T4?.line ?? '')
    && byId.T3?.line.includes('echo started'), brief(Object.values(byId).map((card) => card.line)));
  record('TB-81 hovering "Request 1" shows the request title; Finished cards are in the secondary color',
    byId.T1?.requestTitle === 'Fix the login page' && byId.T1.finished && !byId.T3?.finished, brief(byId.T1));
  record('TB-81 T2 shows "Depends on T1"; each card with a session has one "View transcript" (one role: no name)',
    byId.T2?.deps === 'Depends on T1' && same(byId.T1?.links, ['View transcript'])
      && same(byId.T2?.links, ['View transcript']), brief({ t1: byId.T1?.links, t2: byId.T2 }));
  record('TB-81 the stoppable cards (T3 running, T4 waiting for the lock) have "Stop this task"; finished ones do not',
    byId.T3?.stop && byId.T4?.stop && !byId.T1?.stop && !byId.T2?.stop, brief(cards.map((card) => card.stop)));
  const text = await ctx.page.locator('[data-testid="bg-tasks"]').textContent();
  record('TB-81 the list has no request conclusion or ruled-out approaches', !text.includes('Conclusion')
    && !text.includes('Ruled out'), brief(text.slice(0, 300)));
  await ctx.page.locator('[data-testid="bg-section"][data-section="finished"] .bg-section-head').click();
  const folded = await bgCards(ctx);
  await ctx.page.locator('[data-testid="bg-section"][data-section="finished"] .bg-section-head').click();
  record('TB-81 the Finished header folds the section (aria-expanded) and opens it again',
    folded.every((card) => card.section === 'running') && (await bgCards(ctx)).length === 4, brief(folded));
}

// ---------- TB-82 task 的视图 ----------

/** @brief T1 与 T2 的视图（TB-82）。 */
async function taskview(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  await clickCard(ctx, 'T1');
  const t1 = await waitTaskView(ctx, 'T1', (view) => view.handoffs.length >= 2);
  record('TB-82 the T1 view: "T1 Find the cause · Read-only", the card line, "Request 1 · Fix the login page", '
    + '"View transcript" and "View transcript (closing)"',
  t1?.title === 'T1 Find the cause · Read-only' && t1.request === 'Request 1 · Fix the login page'
    && same(t1.links, ['View transcript', 'View transcript (closing)']), brief(t1));
  record('TB-82 Prompt shows the description in full as Markdown (the table is a table)',
    t1?.prompt.includes('Find why the login page is blank.') && t1.promptTable, brief(t1?.prompt));
  const [first, closing] = t1?.handoffs ?? [];
  record('TB-82 the first handoff: "#1 executor · Done → planner (closing)", the conclusion in full, Open items, '
    + 'Evidence "✓ #<n> Read README.md" and its "View transcript"',
  first?.head === '#1 executor · Done → planner (closing)' && first.text.includes(TASKS_CONCLUSION)
    && first.text.includes(TASKS_OPEN_ITEM) && first.evidence.some((line) => /^✓ #\d+ Read .*README\.md$/.test(line))
    && first.transcript, brief(first));
  record('TB-82 the close session\'s baton: "#2 planner · Closed as done → Done", with a "View transcript"',
    closing?.head === '#2 planner · Closed as done → Done' && closing.transcript, brief(closing));
  const message = t1?.messages[0];
  record('TB-82 Messages lists the message left on T1, "executor · hh:mm" over the full text with its table',
    /^executor · \d\d:\d\d$/.test(message?.head ?? '') && message.table && message.text.includes('src/login.ts')
      && TASKS_MESSAGE.startsWith('Check these files'), brief(message));
  await clickBack(ctx);
  await clickCard(ctx, 'T2');
  const t2 = await waitTaskView(ctx, 'T2');
  record('TB-82 the T2 view has "Depends on" with "T1 Find the cause · Done"; clicking it opens T1, Back goes to '
    + 'the list',
    same(t2?.deps, ['T1 Find the cause · Done']), brief(t2?.deps));
  await ctx.page.locator('[data-testid="bg-task-view"] .bg-dep[data-task="T1"]').click();
  const dep = await waitTaskView(ctx, 'T1');
  await clickBack(ctx);
  const listed = await ctx.page.locator('[data-testid="bg-tasks"]').count();
  record('TB-82 a dependency opens that task\'s view; Back returns to the list', dep?.task === 'T1' && listed === 1,
    brief({ dep: dep?.task, listed }));
  await backKeepsScroll(ctx);
}

/**
 * @brief Back 回到列表时滚动位置不变。四张卡片在最小窗口里也放得下，所以给列表加一条只在测试里的高度上限，
 *        让它能滚（synthetic test setup：页面里加一段样式，列表重新挂载后仍在）。
 */
async function backKeepsScroll(ctx) {
  const style = await ctx.page.addStyleTag({ content: '[data-testid="bg-tasks"] { max-height: 160px; }' });
  await sleep(300);
  const before = await ctx.page.locator('[data-testid="bg-tasks"]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { top: el.scrollTop, scrollable: el.scrollHeight > el.clientHeight };
  });
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1');
  await clickBack(ctx);
  const after = await ctx.page.locator('[data-testid="bg-tasks"]').evaluate((el) => el.scrollTop);
  await style.evaluate((el) => el.remove());
  record('TB-82 Back returns to the list at the same scroll position',
    before.scrollable && Math.abs(after - before.top) <= 1, brief({ before, after }));
}

// ---------- TB-83 实例的会话 ----------

/** @brief T1 executor 的会话、结案会话、运行中的 T3（TB-83）。 */
async function transcript(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1');
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'executor');
  const t1 = await waitTranscript(ctx, 'task');
  record('TB-83 the T1 transcript: title "executor · T1 Find the cause", first line "Model tbtasks/<model>", the '
    + 'delivery as a user bubble, then the replies with their tool cards (read, task_handoff)',
  t1?.title === 'executor · T1 Find the cause' && t1.model === `Model tbtasks/${MODEL}`
    && t1.items[0]?.kind === 'user' && t1.items[0].text.startsWith('[Mori] You are executor on T1')
    && t1.tools.length >= 2 && t1.running === 'false', brief(t1));
  record('TB-83 the transcript has no message box, reply actions or approval card',
    !t1?.composer && !t1?.replyActions && !t1?.approval, brief(t1));
  const selected = await selectionPopover(ctx);
  record('TB-83 selecting text in the transcript shows no selection popover (it cannot be attached as context)',
    selected === 0, brief(selected));
  await clickBack(ctx);
  const back = await taskViewOf(ctx);
  record('TB-83 Back returns to the layer that opened it (the T1 view)', back?.task === 'T1', brief(back?.task));
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'close');
  const close = await waitTranscript(ctx, 'close');
  record('TB-83 "View transcript (closing)" opens the close session: "planner · Request 1 (closing)"',
    close?.title === 'planner · Request 1 (closing)' && close.items.length > 0, brief(close));
  await clickBack(ctx);
  await clickBack(ctx);
  await openTranscript(ctx, '[data-testid="bg-task"][data-task="T3"] .bg-task-links', 'executor');
  const t3 = await waitTranscript(ctx, 'task');
  record('TB-83 the running T3 transcript is marked running; its last line is what the task is doing',
    t3?.running === 'true' && t3.doing?.includes('echo started'), brief(t3));
  await clickBack(ctx);
  await handoffTranscript(ctx);
}

/** @brief 交接的 View transcript 打开那个角色的会话，结案写的一棒打开结案会话（TB-83）。 */
async function handoffTranscript(ctx) {
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1', (view) => view.handoffs.length >= 2);
  await ctx.page.locator('[data-testid="bg-handoff"][data-n="1"] [data-action="view-transcript"]').click();
  const first = await waitTranscript(ctx, 'task');
  await clickBack(ctx);
  await waitTaskView(ctx, 'T1', (view) => view.handoffs.length >= 2);
  const closeBaton = ctx.page.locator('[data-testid="bg-handoff"][data-n="2"] [data-action="view-transcript"]');
  const hasClose = await closeBaton.count();
  if (hasClose) await closeBaton.click();
  const second = hasClose ? await waitTranscript(ctx, 'close') : null;
  record('TB-83 a handoff\'s "View transcript" opens that role\'s session; the close session\'s baton opens the '
    + 'close session',
  first?.title === 'executor · T1 Find the cause' && hasClose === 1 && second?.kind === 'close',
  brief({ first: first?.title, hasClose, second: second?.title }));
  if (hasClose) await clickBack(ctx);
  await clickBack(ctx);
}

/** @brief 在会话里拖选一段文字，返回出现的选区浮层数。 */
async function selectionPopover(ctx) {
  const text = ctx.page.locator('[data-testid="bg-transcript"] .assistant-message, [data-testid="bg-transcript"] '
    + '.user-message').first();
  const box = await text.boundingBox();
  if (!box) return -1;
  await ctx.page.mouse.move(box.x + 4, box.y + box.height / 2);
  await ctx.page.mouse.down();
  await ctx.page.mouse.move(box.x + Math.min(box.width - 4, 160), box.y + box.height / 2, { steps: 6 });
  await ctx.page.mouse.up();
  await sleep(400);
  const count = await ctx.page.locator('[data-testid="selection-popover"]').count();
  await ctx.page.mouse.click(box.x + 2, box.y - 6).catch(() => {});
  return count;
}

// ---------- TB-86 界面文字与键盘 ----------

/** @brief 页签的角色与选中、节头、卡片、Back、View transcript 能用 Tab 到达，Enter、空格打开（TB-86）。 */
async function keys(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  const tabs = await bgTabs(ctx);
  record('TB-86 the tabs are role="tab" with aria-selected inside a tablist; the texts are Claude\'s "Changes" and '
    + '"Background tasks"',
  same(tabs.map((item) => [item.text, item.role, item.list]), [['Changes', 'tab', 'tablist'],
    ['Background tasks', 'tab', 'tablist']]) && tabs.some((item) => item.selected === 'true'), brief(tabs));
  await ctx.page.locator('[data-testid="right-tab"][data-tab="tasks"]').focus();
  const seen = [];
  for (let i = 0; i < 14; i += 1) {
    await ctx.page.keyboard.press('Tab');
    seen.push(await ctx.page.evaluate(() => {
      const el = document.activeElement;
      if (el?.closest('[data-testid="bg-tasks"]') === null) return 'outside';
      return el.classList.contains('bg-section-head') ? 'header' : el.classList.contains('bg-task-open') ? 'card'
        : el.dataset.action ?? el.className;
    }));
  }
  record('TB-86 Tab reaches the Finished header, the cards and "View transcript" in the list',
    ['header', 'card', 'view-transcript'].every((kind) => seen.includes(kind)), brief(seen));
  await ctx.page.locator('[data-testid="bg-task"][data-task="T1"] .bg-task-open').focus();
  await ctx.page.keyboard.press('Enter');
  const entered = await waitTaskView(ctx, 'T1');
  await ctx.page.locator('[data-testid="bg-task-view"] [data-action="back"]').focus();
  await ctx.page.keyboard.press(' ');
  const spaced = await ctx.page.locator('[data-testid="bg-tasks"]').waitFor({ timeout: 5000 }).then(() => true,
    () => false);
  record('TB-86 Enter on a card opens its view; Space on Back returns to the list', entered?.task === 'T1' && spaced,
    brief({ entered: entered?.task, spaced }));
  const button = await tasksButton(ctx, who.tab);
  record('TB-86 the stage-line button\'s hover is Claude\'s "Show this session’s background tasks"',
    button?.title === 'Show this session’s background tasks', brief(button));
}

// ---------- TB-89 停止一个 task ----------

/** @brief 停下 T3、写入锁仍归它、交回后继续原来的会话（TB-89）。 */
async function stop(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  const since = Date.now();
  const before = scenarioLines(ctx.ep, 'tb-tasks-flow', { agent: 'executor', kind: 'task', task: 'T3' }).length;
  await ctx.page.locator('[data-testid="bg-task"][data-task="T3"] [data-action="stop-task"]').click();
  const stopped = await waitCard(ctx, 'T3', (card) => card.section === 'finished' && card.phase === 'stopped');
  const board = readBoard(ctx, who.sessionId);
  const t3 = taskOf(board, 'T3');
  record('TB-89 "Stop this task" (no confirmation) moves T3 to Finished as "Stopped"; board.json has T3 stopped '
    + '(stopReason user, holder kept), no error handoff',
  stopped?.line.includes('Stopped') && t3?.status === 'stopped' && t3.stopReason === 'user'
    && t3.holder?.role === 'executor' && t3.handoffs.every((handoff) => handoff.reason !== 'error'),
  brief({ line: stopped?.line, t3: t3 && { status: t3.status, stopReason: t3.stopReason, holder: t3.holder } }));
  const t4 = await waitCard(ctx, 'T4', (card) => card.line.includes('Waiting to change files (T3, stopped)'));
  record('TB-89 the write lock stays with the stopped T3: T4 shows "Waiting to change files (T3, stopped)"',
    Boolean(t4), brief(t4?.line));
  await sleep(3000);
  const after = scenarioLines(ctx.ep, 'tb-tasks-flow', { agent: 'executor', kind: 'task', task: 'T3' }).length;
  const report = await issueReport(ctx, who.tab, 'Stop one task');
  record('TB-89 after the stop the endpoint gets no request from T3; F8 records "Stop task T3"; the mode is unchanged',
    after === before && report.actions.some((line) => line.includes('Stop task T3')),
  brief({ before, after, actions: report.actions.slice(-4) }));
  const refused = await bridge(ctx, { type: 'session.stopTask', sessionId: who.sessionId, task: 'T1' });
  const missing = await bridge(ctx, { type: 'session.stopTask', sessionId: who.sessionId, task: 'T9' });
  record('TB-89 a task that cannot be stopped gives "T1 isn\'t running."; a missing one "T9 does not exist."',
    refused?.error === "T1 isn't running." && missing?.error === 'T9 does not exist.', brief({ refused, missing }));
  await handBack(ctx, who, since);
}

/** @brief 你的下一条消息到立项，task_edit 交回 T3：继续原来的会话，卡片回到 Running，之后做完（TB-89）。 */
async function handBack(ctx, who, since) {
  const files = instanceFiles(ctx, who.sessionId).map((file) => file.id);
  await sendMessage(ctx, who.tab, 'Continue T3');
  const back = await waitCard(ctx, 'T3', (card) => card.section === 'running', 30000);
  const resumed = await poll(() => scenarioLines(ctx.ep, 'tb-tasks-flow', { agent: 'executor', kind: 'task',
    task: 'T3' }).find((line) => String(line.k) === '2'), 60000);
  const now = instanceFiles(ctx, who.sessionId).map((file) => file.id);
  record('TB-89 handed back by your next message (task_edit), T3 returns to Running and continues the same instance '
    + 'session (no new file)',
  Boolean(back) && Boolean(resumed) && now.filter((id) => id.endsWith('.t3.executor')).length === 1
    && files.some((id) => id.endsWith('.t3.executor')), brief({ back: back?.line, resumed: Boolean(resumed), now }));
  await settle(ctx, who, 120000);
  const done = await tasksButton(ctx, who.tab);
  record('TB-81 with every task ended the stage-line button reads "4 tasks finished"',
    done?.text === '4 tasks finished',
    brief({ done, since }));
}

// ---------- TB-84 只读与边界 ----------

/** @brief 一个目录下各文件的修改时间与长度。 */
function fileStamps(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const entry of readdirSync(dir, { recursive: true })) {
    const path = join(dir, String(entry));
    if (statSync(path).isFile()) out[String(entry)] = `${statSync(path).mtimeMs}:${statSync(path).size}`;
  }
  return out;
}

/** @brief 打开 task 的视图与会话之后 board.json、会话文件不变，端点没有新的请求（TB-84）。 */
async function readonly(ctx) {
  const who = await flowSession(ctx);
  await settle(ctx, who, 120000);
  await showTab(ctx, who.tab);
  const dir = teamDir(ctx, who.sessionId);
  const before = { files: fileStamps(dir), requests: ctx.ep.logs.length, board: readFileSync(join(dir, 'board.json'),
    'utf8') };
  await openList(ctx, who);
  for (const task of ['T1', 'T2', 'T3', 'T4']) {
    await clickCard(ctx, task);
    await waitTaskView(ctx, task);
    await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', null);
    await waitTranscript(ctx, 'task');
    await clickBack(ctx);
    await clickBack(ctx);
  }
  await sleep(1500);
  const after = { files: fileStamps(dir), requests: ctx.ep.logs.length, board: readFileSync(join(dir, 'board.json'),
    'utf8') };
  record('TB-84 after opening every task view and transcript, board.json and the session files keep their content '
    + 'and mtime, and the endpoint gets no new request',
  same(before.files, after.files) && before.board === after.board && before.requests === after.requests,
  brief({ before: before.requests, after: after.requests, files: Object.keys(after.files).length }));
  const bad = await bridge(ctx, { type: 'board.readSession', sessionId: who.sessionId,
    of: { kind: 'task', task: 'T1', role: 'reviewer' } });
  const none = await bridge(ctx, { type: 'board.readSession', sessionId: who.sessionId,
    of: { kind: 'close', request: 9 } });
  record('TB-84 board.readSession reports "reviewer has no session on T1." and "Request 9 does not exist."',
    bad?.error === 'reviewer has no session on T1.' && none?.error === 'Request 9 does not exist.',
    brief({ bad: bad?.error, none: none?.error }));
  await bridge(ctx, { type: 'session.setTeam', sessionId: who.sessionId, mode: 'off' });
  const off = { tabs: await bgTabs(ctx), cards: await bgCards(ctx) };
  record('TB-84 after team mode is turned off the tabs, the list and the views stay', off.tabs.length === 2
    && off.cards.length === 4, brief(off));
}

// ---------- TB-85 重新打开、重新载入 ----------

/** @brief 关上再从侧栏打开、界面重新载入（Ctrl+R）之后，列表、task 的视图与会话与之前相同（TB-85）。 */
async function reload(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  const before = await bgCards(ctx);
  await ctx.page.reload();
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  const tab = await reopenSession(ctx, who.sessionFile);
  ctx.flow = { ...who, tab };
  await ctx.page.locator(`${paneSel(tab)} [data-testid="tasks-button"]`).click({ timeout: 15000 });
  const tabs = await poll(async () => {
    const list = await bgTabs(ctx);
    return list.length === 2 ? list : null;
  }, 15000);
  await openList(ctx, ctx.flow);
  const after = await bgCards(ctx);
  record('TB-85 after Ctrl+R and reopening the session, the list is the same',
    Boolean(tabs) && same(after.map((card) => [card.task, card.section, card.phase]),
      before.map((card) => [card.task, card.section, card.phase])), brief({ before: before.length, after }));
  await clickCard(ctx, 'T1');
  const view = await waitTaskView(ctx, 'T1');
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'executor');
  const read = await waitTranscript(ctx, 'task');
  record('TB-85 the task view and the transcript open the same after reloading', view?.messages.length === 1
    && view.handoffs.length >= 2 && read?.title === 'executor · T1 Find the cause' && read.items.length > 0,
  brief({ view, read: read?.title }));
}

// ---------- TB-83、TB-89：挂着批准卡的 task ----------

/** @brief 挂着批准卡的 T1：会话里没有结果的调用为 Running…；停下后批准卡按拒绝处理、消失（TB-83、TB-89）。 */
async function approval(ctx) {
  const project = tempProject('mori-tb-tasks-approval-');
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Run a command ${tag('approval')}`);
  const card = await waitApprovalCard(ctx, who.tab, { agent: 'executor' }, 60000);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tasks-button"]`).click();
  await openTranscript(ctx, '[data-testid="bg-task"][data-task="T1"] .bg-task-links', null);
  const live = await waitTranscript(ctx, 'task');
  record('TB-83 while T1 waits for approval its transcript shows the call as "Running…" (not Interrupted) and the '
    + 'last line "Waiting for your approval"',
  live?.running === 'true' && live.tools.some((tool) => tool.status === 'running')
    && live.doing === 'Waiting for your approval', brief(live));
  await clickBack(ctx);
  await ctx.page.locator('[data-testid="bg-task"][data-task="T1"] [data-action="stop-task"]').click();
  const gone = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"]`).waitFor({ state: 'detached',
    timeout: 15000 }).then(() => true, () => false);
  const stopped = await waitCard(ctx, 'T1', (item) => item.phase === 'stopped');
  const file = instanceFiles(ctx, who.sessionId).find((item) => item.id.endsWith('.t1.executor'));
  const result = await poll(() => file && readFileSync(file.file, 'utf8').includes(REJECTED_BY_STOP), 15000);
  record('TB-89 stopping a task that waits for approval: its card is rejected and goes away, the tool result is '
    + `"${REJECTED_BY_STOP}", the task is Stopped`,
  Boolean(card) && gone && Boolean(stopped) && Boolean(result), brief({ card: Boolean(card), gone, stopped, result }));
}

// ---------- TB-80 模型菜单（WP-09 之后） ----------

/** @brief 模型菜单里 See background tasks 那一项：{ text, role, last（是 Task mode 那一段的最后一项） }；没有时为 null。 */
function menuItem(ctx) {
  return ctx.page.locator('[data-testid="model-menu"] [data-action="see-background-tasks"]').evaluate((el) => {
    const group = el.closest('.task-mode-group');
    const items = group ? [...group.querySelectorAll('[role^="menuitem"]')] : [];
    return { text: el.textContent.trim(), role: el.getAttribute('role'), last: items.at(-1) === el };
  }, null, { timeout: 5000 }).catch(() => null);
}

/**
 * @brief 模型菜单 Task mode 那一段的最后一项 See background tasks（WP-09 把协作模式移进模型菜单之后）：回复进行中也能用，
 *        点它关上菜单、打开右栏到 Background tasks（TB-80）。
 */
async function menu(ctx) {
  const project = tempProject('mori-tb-tasks-menu-');
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Look at the menu ${tag('menu')}`);
  await waitBoard(ctx, who, (board) => board.tasks.length === 1, 'T1');
  const replying = await poll(async () => (await paneState(ctx.page, who.tab))?.running === true, 10000, 100);
  // WP-09 之前协作模式下模型按钮是锁定的、点不开：这一项记为失败（下面的 record），不在这里抛出
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="model-button"]`).click({ timeout: 5000 }).catch(() => {});
  const item = await menuItem(ctx);
  if (item) await ctx.page.locator('[data-testid="model-menu"] [data-action="see-background-tasks"]').click();
  const menuGone = await ctx.page.locator('[data-testid="model-menu"]').count() === 0;
  const tabs = await bgTabs(ctx);
  const still = (await paneState(ctx.page, who.tab))?.running === true;
  record('TB-80 the model menu\'s Task mode part ends with "See background tasks" (a menu item), usable while a reply '
    + 'is running; it closes the menu and opens the right panel at Background tasks',
  item?.text === 'See background tasks' && item.role === 'menuitem' && item.last && Boolean(replying) && still
    && menuGone && tabs.find((tab) => tab.tab === 'tasks')?.selected === 'true',
  brief({ item, replying, still, menuGone, tabs }));
  const report = await issueReport(ctx, who.tab, 'See background tasks');
  record('TB-80 F8 records "Open background tasks" for the model menu item',
    report.actions.some((line) => line.includes('Open background tasks')), brief(report.actions.slice(-4)));
}

// ---------- TB-83 实例会话里的步骤组（WP-14 之后） ----------

/** @brief 会话视图里的步骤组：[{ text, expanded }] 与看得见的工具卡数。 */
function stepGroups(ctx) {
  return ctx.page.locator('[data-testid="bg-transcript"]').evaluate((root) => ({
    groups: [...root.querySelectorAll('[data-testid="step-group"]')].map((el) => ({ text: el.textContent.trim(),
      expanded: el.getAttribute('aria-expanded') })),
    visibleTools: [...root.querySelectorAll('[data-testid="tool-card"]')].filter((el) => el.checkVisibility()).length,
  }), null, { timeout: 5000 }).catch(() => null);
}

/**
 * @brief 实例会话里一轮结束后的步骤折叠同对话流（§13.13.4，WP-14 合入后；docs/v0/screens/chat.md“步骤组”）：做完的 T1 会话里
 *        思考与工具卡折成一行 “▸ <n> steps”，点开看到工具卡；运行中的 T3 正在做的那一组全部显示。
 */
async function folding(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  await openTranscript(ctx, '[data-testid="bg-task"][data-task="T1"] .bg-task-links', null);
  await waitTranscript(ctx, 'task');
  const folded = await stepGroups(ctx);
  record('TB-83 a finished instance session folds its steps as the chat does: one line "▸ <n> steps" '
    + '(aria-expanded false) and no tool card showing',
  folded?.groups.length > 0 && folded.groups.every((group) => group.expanded === 'false'
    && /^▸ \d+ steps?( · \d+ failed)?$/.test(group.text)) && folded.visibleTools === 0, brief(folded));
  if (folded?.groups.length) {
    await ctx.page.locator('[data-testid="bg-transcript"] [data-testid="step-group"]').first().click();
  }
  const opened = await stepGroups(ctx);
  record('TB-83 clicking the line expands the group ("▾ <n> steps", aria-expanded true) and its tool cards show',
    opened?.groups[0]?.expanded === 'true' && opened.groups[0].text.startsWith('▾ ') && opened.visibleTools > 0,
    brief(opened));
  await clickBack(ctx);
  await openTranscript(ctx, '[data-testid="bg-task"][data-task="T3"] .bg-task-links', null);
  await waitTranscript(ctx, 'task');
  const running = await stepGroups(ctx);
  record('TB-83 the running T3 session shows its current group in full (no folded line for it)',
    running?.groups.every((group) => group.expanded !== 'false') && running.visibleTools > 0, brief(running));
  await clickBack(ctx);
}

// ---------- TB-82、TB-83、TB-89：读不到、停不了 ----------

/**
 * @brief 后台进程退出之后的三种失败（之后的请求都失败；restart 一步重启 App）：停止的那一行 Couldn’t stop T1: …、
 *        task 视图的 Couldn’t load T1: … 与 Retry、会话的 Failed to read session transcript 与原文和 Retry。
 */
async function errors(ctx) {
  const project = tempProject('mori-tb-tasks-errors-');
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Read slowly ${tag('restart')}`);
  await poll(() => scenarioLines(ctx.ep, 'tb-tasks-restart', { agent: 'executor', kind: 'task', task: 'T1' })
    .some((line) => line.j === 2), 60000);
  await dialogIdle(ctx, who);
  await openList(ctx, who);
  await killTbKernel(ctx);
  await sleep(1000);
  await ctx.page.locator('[data-testid="bg-task"][data-task="T1"] [data-action="stop-task"]').click();
  const stop = await waitCard(ctx, 'T1', (card) => card.error !== null, 10000);
  record('TB-89 a stop that fails shows "Couldn’t stop T1: <the error>" under the card',
    stop?.error?.startsWith('Couldn’t stop T1: ') && stop.error.length > 'Couldn’t stop T1: '.length, brief(stop));
  await clickCard(ctx, 'T1');
  const view = await poll(async () => {
    const value = await taskViewOf(ctx);
    return value?.error ? value : null;
  }, 10000);
  const retry = await ctx.page.locator('[data-testid="bg-task-view"] [data-action="retry"]').count();
  record('TB-82 a task view that cannot be read shows "Couldn’t load T1: <the error>" and Retry',
    view?.error?.startsWith('Couldn’t load T1: ') && retry === 1, brief({ error: view?.error, retry }));
  await clickBack(ctx);
  await openTranscript(ctx, '[data-testid="bg-task"][data-task="T1"] .bg-task-links', null);
  const read = await poll(async () => {
    const value = await transcriptOf(ctx);
    return value?.error ? value : null;
  }, 10000);
  const again = await ctx.page.locator('[data-testid="bg-transcript"] [data-action="retry"]').count();
  record('TB-83 a transcript that cannot be read shows "Failed to read session transcript", the error and Retry',
    read?.error?.startsWith('Failed to read session transcript') && read.error.length > 40 && again === 1,
    brief({ error: read?.error, again }));
}

// ---------- TB-85 重启 ----------

/** @brief App 重启之后非终态的 task 显示 Stopped (Mori restarted)，在 Finished，会话从文件读出（TB-85）。 */
async function restart(ctx) {
  const project = tempProject('mori-tb-tasks-restart-');
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Read slowly ${tag('restart')}`);
  await poll(() => scenarioLines(ctx.ep, 'tb-tasks-restart', { agent: 'executor', kind: 'task', task: 'T1' })
    .some((line) => line.j === 2), 60000);
  await sleep(1000);
  await restartTbApp(ctx);
  const tab = await reopenSession(ctx, who.sessionFile);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="tasks-button"]`).click({ timeout: 15000 });
  const card = await waitCard(ctx, 'T1', (item) => item.section === 'finished', 15000);
  await openTranscript(ctx, '[data-testid="bg-task"][data-task="T1"] .bg-task-links', null);
  const read = await waitTranscript(ctx, 'task');
  record(`TB-85 after an App restart the running T1 is in Finished as "${RESTARTED}" and its transcript is read `
    + 'from the file',
  card?.line.includes(RESTARTED) && read?.items.some((item) => item.kind === 'assistant'), brief({ card, read }));
}

// ---------- 主流程 ----------

const steps = { plain, empty, entries, list, taskview, transcript, folding, keys, stop, readonly, reload, approval,
  menu, errors, restart };

const ctx = { userData: tempUserData('mori-tb-tasks-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-tasks] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: tasks`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  const missing = missingSteps(ctx.ep);
  record('tasks: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-tasks] data in ${ctx.userData}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
