// 平行 Agent 与 TaskBoard 的 App 套件：右栏的 Background tasks（docs/specs/parallel-agents-taskboard.md §13.13、§17.2；
// docs/v1/screens/team-tasks.md）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式
// （tests/fake-endpoint/scenarios/tasks.mjs，synthetic），逐条验收这些编号在 App 层的通过条件：
//   TB-80 入口、TB-81 列表、TB-82 task 的视图、TB-83 实例的会话、TB-84 只读与边界、TB-85 重新打开与重启、
//   TB-86 界面文字与键盘、TB-87 现有功能不退步、TB-89 停止一个 task。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs tasks）：
//   MORI_APP_DIR=.tb-runs/tasks node tests/ui/tb-app-tasks.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 步骤：plain、empty、entries、list、taskview、transcript、folding、tabs、keys、stop、readonly、reload、narrow、approval、
// outcomes、noactivity、liveview、program、sessions、menu、errors、restart（entries 到 narrow 共用一个会话，按这个顺序；
// errors 让后台进程退出，检查完重启 App；restart 最后跑，也重启 App）。
// 每一步覆盖 docs/v1/screens/team-tasks.md 状态表的哪几行，见 docs/v1/team-checks.md“状态表的每一行与用例”。
// 结果写到 test-results/tb-app-tasks(-packaged).json（--only 时 tb-partial-app-tasks…），截图在 test-results/tb-app-tasks/。
// 端口（§17.3：tb-app-tasks*.mjs 用 4950–4959）：合成端点 4950，记录代理 4951。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好一个本机提供商（写入等级 A、能关思考，跳过探针）；
// 三个临时项目：分开配置（chat / planner / executor / reviewer）两个、没有角色文件一个。同一时刻只开一个 App。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TASKS_CONCLUSION, TASKS_MESSAGE, TASKS_OPEN_ITEM,
} from '../fake-endpoint/scenarios/tasks.mjs';
import {
  allowAll, bridge, brief, closeTbApp, instanceFiles, killTbKernel, missingSteps, openSessionIn, paneSel, paneState,
  poll, progressOf, readBoard, reopenSession, restartTbApp, scenarioLines, seedTeamUserData, sendMessage, shot,
  showTab, sleep, SPLIT_ROLES, startTbApp, startTbEndpoint, stopTbEndpoint, suiteArgs, tbModel, tbProvider, tbRecorder,
  teamDir, teamSwitch, tempProject, tempUserData, userSession, waitApprovalCard, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';
import {
  actionsAfter, bgCards, bgTabs, clickBack, clickCard, clickTab, issueReport, openTranscript, panelOpen, showBgStep,
  tasksButton, taskViewOf, transcriptOf, waitCard, waitTaskView, waitTranscript, watchMoments, momentsSeen,
} from './tb-tasks-helpers.mjs';
import { openMenuByMouse } from './m3-helpers.mjs';
import { slashItems } from './m6-helpers.mjs';
import { waitSplit } from './m5-helpers.mjs';

const args = suiteArgs('tasks');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理（§17.3） */
const PORT = 4950;
const PROXY = 4951;
/** 合成端点上的模型（synthetic）：写入等级 A、能关思考 */
const MODEL = 'fake-coder-tbtasks';
/** 没有写入等级的模型（synthetic，program 一步里 executor 用它：不交接就结束时程序写一棒，不强制填写） */
const PLAIN_MODEL = 'fake-coder-tbplain';
/** 慢启动扩展等待的毫秒数（noactivity：实例会话建好之前停下 task） */
const SLOW_START_MS = 8000;
/** 程序给的固定文字（§11.3 停止时挂着的卡回给模型的、§11.6 重启） */
const REJECTED_BY_STOP = 'Rejected: the user stopped the run.';
const RESTARTED = 'Stopped (Mori restarted)';

/** @brief 这个套件的脚本标记（scenarios/tasks.mjs 的 tb-tasks-<name>）。 */
const tag = (name) => `tb-scenario:tb-tasks-${name}`;
/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// ---------- 准备与会话 ----------

/**
 * @brief 写一个 synthetic 项目扩展（.pi/extensions/slow-start.ts）：marker 文件在的时候，这个项目的每个会话（用户会话与
 *        实例会话）要 SLOW_START_MS 才建好。noactivity 一步在实例会话还在建的时候停下 task（team-tasks.md“还没有条目”）。
 */
function writeSlowStart(project, marker) {
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'slow-start.ts'), [
    '// synthetic: written by tests/ui/tb-app-tasks.mjs (noactivity);',
    '// sessions of this project start slowly while the marker file exists.',
    "import { existsSync } from 'node:fs';",
    '',
    'export default async function () {',
    `  if (!existsSync(${JSON.stringify(marker)})) return;`,
    `  await new Promise((resolve) => setTimeout(resolve, ${SLOW_START_MS}));`,
    '}',
    '',
  ].join('\n'));
}

/** @brief 测试准备（synthetic test setup）：四个临时项目（一个带慢启动扩展、受信任）、数据目录、合成端点。 */
async function setup(ctx) {
  ctx.split = tempProject('mori-tb-tasks-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  ctx.split2 = tempProject('mori-tb-tasks-split2-');
  writeRoles(ctx.split2, SPLIT_ROLES);
  ctx.plain = tempProject('mori-tb-tasks-plain-');
  ctx.idle = tempProject('mori-tb-tasks-idle-');
  writeRoles(ctx.idle, SPLIT_ROLES);
  ctx.slowMarker = join(ctx.idle, '..', 'slow-start.on');
  writeSlowStart(ctx.idle, ctx.slowMarker);
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, { providers: [tbProvider('tbtasks', PROXY, [tbModel(MODEL)]),
    tbProvider('tbplain', PROXY, [tbModel(PLAIN_MODEL)])], profiles: { [`tbplain/${PLAIN_MODEL}`]: { tier: null } },
  trusted: [ctx.idle] });
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
  record('TB-80 a session with no request and task mode off: the right panel is as before ("This session’s changes", '
    + 'no tabs) and the stage line has no tasks button',
  header?.includes('This session’s changes') && tabs.length === 0 && button === null, brief({ header, tabs, button }));
  record('TB-87 the right panel of a session without a TaskBoard keeps the v0 header "This session’s changes" and has '
    + 'no tabs', header?.includes('This session’s changes') && tabs.length === 0, brief({ header, tabs }));
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="model-button"]`).click();
  await ctx.page.locator('[data-testid="model-menu"]').waitFor({ timeout: 5000 });
  const item = await ctx.page.locator('[data-testid="model-menu"] [data-action="see-background-tasks"]').count();
  await ctx.page.keyboard.press('Escape');
  record('TB-80 the model menu of a session with no request and task mode off has no "See background tasks"',
    item === 0, brief(item));
  await noTasksCommand(ctx, who);
}

/** @brief 没有 /tasks（§13.13.1）：“/” 的列表里没有 tasks；“/tasks …” 照普通消息发出（不进协作模式，F8 记 Send）。 */
async function noTasksCommand(ctx, who) {
  const box = ctx.page.locator(`${paneSel(who.tab)} .composer textarea`);
  await box.fill('/');
  // “/” 的列表只列提示词模板与技能（slash.md）；这个项目没有，列表写 “This session has no prompt templates or skills”
  const listed = ctx.page.locator('[data-testid="slash-menu"]');
  await listed.waitFor({ timeout: 5000 }).catch(() => {});
  await poll(async () => !(await listed.textContent().catch(() => '')).includes('Loading…'), 10000, 100);
  const all = await slashItems(ctx.page);
  const note = await listed.textContent().catch(() => null);
  await box.fill('/tasks');
  await sleep(300);
  const typed = await slashItems(ctx.page);
  await box.fill('');
  const names = (items) => (items ?? []).map((item) => item.name);
  record('TB-80 there is no /tasks command: the "/" list opens without a tasks entry, and typing "/tasks" offers none',
    Array.isArray(all) && note !== null && !names(all).includes('tasks') && !names(typed).includes('tasks'),
    brief({ all: names(all), note, typed: names(typed) }));
  await sendMessage(ctx, who.tab, '/tasks what is running');
  await dialogIdle(ctx, who);
  const mode = (await teamSwitch(ctx, who.tab)).mode;
  const tabs = await bgTabs(ctx);
  const report = await issueReport(ctx, who.tab, 'No /tasks command');
  const since = actionsAfter(report.actions, 'Send: Say hello');
  record('TB-80 "/tasks …" is sent as an ordinary message: F8 records "Send: /tasks …" (not "Send (task mode)"), '
    + 'task mode stays off and the right panel gets no tabs',
  since.some((line) => line.includes('Send: /tasks what is running'))
    && !since.some((line) => line.includes('Send (task mode)')) && mode === 'off' && tabs.length === 0,
  brief({ since, mode, tabs }));
}

/** @brief 分开配置的会话打开协作模式、还没有需求：两个页签，Background tasks 下是空的提示，阶段行没有按钮。 */
async function empty(ctx) {
  const tab = await openSessionIn(ctx, ctx.split2);
  const who = { tab, ...(await userSession(ctx, tab)) };
  // 经进程桥打开协作模式（不点模型菜单里的 Task mode 一行：这一步只看右栏）
  await bridge(ctx, { type: 'session.setTeam', sessionId: who.sessionId, mode: 'on' });
  await ctx.page.locator(`${paneSel(tab)} button[aria-label="Toggle changes"]`).click();
  const tabs = await poll(async () => {
    const list = await bgTabs(ctx);
    return list.length === 2 ? list : null;
  }, 10000) ?? await bgTabs(ctx);
  await clickTab(ctx, 'tasks');
  const text = await ctx.page.locator('[data-testid="bg-tasks"]').textContent({ timeout: 5000 }).catch(() => null);
  const button = await tasksButton(ctx, tab);
  record('TB-80 task mode on with no request: the right panel has the tabs Changes and Background tasks '
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
  const stop = await ctx.page.locator('[data-testid="bg-task-view"] .bg-task-head [data-action="stop-task"]').count();
  record('TB-80 a task row of the progress summary is a button "Open T3 Long change in Background tasks" that opens '
    + 'the right panel at that task\'s view (the running T3 has "Stop this task" next to its title)',
  label === 'Open T3 Long change in Background tasks' && view?.task === 'T3' && stop === 1,
  brief({ label, view: view?.title, stop }));
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
  const since = actionsAfter(report.actions, 'Send (task mode): Fix the login page');
  const wanted = ['Open background tasks', 'Open T3 in Background tasks'];
  record('TB-80 F8 records "Open background tasks" and "Open T3 in Background tasks"',
    wanted.every((line) => since.some((item) => item.includes(line))), brief(since));
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
  const head = ctx.page.locator('[data-testid="bg-section"][data-section="finished"] .bg-section-head');
  const open = await head.getAttribute('aria-expanded');
  await head.click();
  const folded = await bgCards(ctx);
  const closed = await head.getAttribute('aria-expanded');
  await head.click();
  const reopened = await head.getAttribute('aria-expanded');
  record('TB-81 the Finished header folds the section (aria-expanded true → false → true) and opens it again',
    open === 'true' && closed === 'false' && reopened === 'true' && folded.every((card) => card.section === 'running')
      && (await bgCards(ctx)).length === 4, brief({ open, closed, reopened, folded: folded.map((card) => card.task) }));
}

// ---------- TB-82 task 的视图 ----------

/** @brief T1 与 T2 的视图（TB-82）。 */
async function taskview(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  await watchMoments(ctx);
  await clickCard(ctx, 'T1');
  const t1 = await waitTaskView(ctx, 'T1', (view) => view.handoffs.length >= 2);
  const { loading } = await momentsSeen(ctx);
  record('TB-82 while board.readTask has not answered, the view shows Back, the title from the TaskView and '
    + '"Loading…"', loading.some((item) => item.kind === 'bg-task-view' && item.back
    && item.title.startsWith('T1 Find the cause')), brief(loading));
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
  const diagram = await poll(() => ctx.page.locator('[data-testid="bg-message"] [data-testid="mermaid-diagram"] svg')
    .count(), 15000, 200);
  record('TB-82 a mermaid block in a message is drawn as a diagram, as in the chat', diagram > 0, brief(diagram));
  await clickBack(ctx);
  await clickCard(ctx, 'T2');
  const t2 = await waitTaskView(ctx, 'T2', (view) => view.handoffs.length >= 1);
  record('TB-82 a pass reads "#1 reviewer · Pass → planner (closing)"',
    t2?.handoffs[0]?.head === '#1 reviewer · Pass → planner (closing)', brief(t2?.handoffs.map((item) => item.head)));
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
  await watchMoments(ctx);
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'executor');
  const t1 = await waitTranscript(ctx, 'task');
  const { loading } = await momentsSeen(ctx);
  record('TB-83 while board.readSession has not answered, the transcript shows Back, the title '
    + '"executor · T1 Find the cause" and "Loading…"', loading.some((item) => item.kind === 'bg-transcript'
    && item.back && item.title === 'executor · T1 Find the cause'), brief(loading));
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
  const report = await issueReport(ctx, who.tab, 'Open transcripts');
  const since = actionsAfter(report.actions, 'Open T1 in Background tasks');
  record('TB-80 F8 records "View transcript: T1 · executor" and "View transcript: Request 1 · closing"',
    since.some((line) => line.includes('View transcript: T1 · executor'))
      && since.some((line) => line.includes('View transcript: Request 1 · closing')), brief(since));
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
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1');
  await ctx.page.locator('[data-testid="right-tab"][data-tab="tasks"]').focus();
  const path = [];
  for (let i = 0; i < 6 && !path.some((stop) => stop.inView); i += 1) {
    await ctx.page.keyboard.press('Tab');
    path.push(await ctx.page.evaluate(() => {
      const el = document.activeElement;
      return { inView: Boolean(el?.closest('[data-testid="bg-task-view"]')),
        name: el?.dataset.action ?? el?.getAttribute('aria-label') ?? el?.className ?? 'none' };
    }));
  }
  record('TB-86 in a task view, Tab from the Background tasks tab passes the tab row\'s buttons and lands on Back',
    path.find((stop) => stop.inView)?.name === 'back', brief(path));
  await clickBack(ctx);
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
  // 从卡片停，一直留在列表里直到交回之后（审查 #13）：列表一直挂着；T3 的卡片从 Running 移到 Finished 再移回来时会重新
  // 挂载，停止状态在 useStopState 里、不随卡片。看的是交回之后按钮可用（从 task 的视图停在 approval 一步）
  await watchMoments(ctx);
  await ctx.page.locator('[data-testid="bg-task"][data-task="T3"] [data-action="stop-task"]').click();
  const stopped = await waitCard(ctx, 'T3', (card) => card.section === 'finished' && card.phase === 'stopped');
  const { stopping } = await momentsSeen(ctx);
  record('TB-89 "Stop this task" on a card (no confirmation): the button is disabled while stopping, then the card '
    + 'moves to Finished as "Stopped" without the button', stopping && Boolean(stopped) && stopped.stop === false,
  brief({ stopping, line: stopped?.line, stop: stopped?.stop }));
  const row = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="progress-task"][data-task="T3"]`)
    .textContent().catch(() => '');
  const stopAll = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="stop-team"]`).count();
  record('TB-89 after the stop the progress summary row of T3 reads "Stopped" and Stop agents still shows (T4 still '
    + 'waits for the lock)', row.includes('Stopped') && stopAll === 1, brief({ row, stopAll }));
  const board = readBoard(ctx, who.sessionId);
  const t3 = taskOf(board, 'T3');
  record('TB-89 "Stop this task" (no confirmation) moves T3 to Finished as "Stopped"; board.json has T3 stopped '
    + '(stopReason user, holder kept), no error handoff',
  stopped?.line.includes('Stopped') && t3?.status === 'stopped' && t3.stopReason === 'user'
    && t3.holder?.role === 'executor' && t3.handoffs.every((handoff) => handoff.reason !== 'error'),
  brief({ line: stopped?.line, t3: t3 && { status: t3.status, stopReason: t3.stopReason, holder: t3.holder } }));
  await stopEffects(ctx, who, before);
  await handBack(ctx, who, since);
}

/** @brief 停下之后（TB-89）：写入锁仍归 T3、端点不再收到 T3 的请求、F8 记下、不能停与不存在的 task 的原文。 */
async function stopEffects(ctx, who, before) {
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
}

/** @brief 你的下一条消息到立项，task_edit 交回 T3：继续原来的会话，卡片回到 Running，之后做完（TB-89）。 */
async function handBack(ctx, who, since) {
  const files = instanceFiles(ctx, who.sessionId).map((file) => file.id);
  await sendMessage(ctx, who.tab, 'Continue T3');
  const back = await waitCard(ctx, 'T3', (card) => card.section === 'running', 30000);
  // 交回后 T3 又可以停（脚本让它先等 3 秒再跑命令）：停止按钮在、可用（停止的回复不会让它一直不可用）
  const again = await waitCard(ctx, 'T3', (card) => card.section === 'running' && card.stop, 10000);
  // 停止的回复与 mori.board 谁先到在这里定不了（mori.board 要等 board.json 写出，回复通常先到）；不在后台进程里加钩子
  // 造不出回复晚到的那一种，由 taskList.test.mjs 的 TB-89（stopReplyState）守住；这里看交回之后按钮可用
  record('TB-89 after the hand-back T3\'s card has "Stop this task" again and it is enabled',
    again?.stopDisabled === false,
  brief({ line: again?.line, stop: again?.stop, disabled: again?.stopDisabled }));
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
  await otherSessionReads(ctx, who);
  await afterModeOff(ctx, who);
}

/**
 * @brief 协作模式关掉之后（TB-84）：页签、列表、阶段行按钮、task 的视图与会话照常；模型菜单里那一项照常（条件同页签）。
 */
async function afterModeOff(ctx, who) {
  await bridge(ctx, { type: 'session.setTeam', sessionId: who.sessionId, mode: 'off' });
  // 等界面跟上：模型按钮上不再是 Task mode
  await poll(async () => (await teamSwitch(ctx, who.tab)).mode === 'off', 10000, 100);
  const off = { tabs: await bgTabs(ctx), cards: await bgCards(ctx), button: await tasksButton(ctx, who.tab) };
  await clickCard(ctx, 'T1');
  const view = await waitTaskView(ctx, 'T1');
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', null);
  const read = await waitTranscript(ctx, 'task');
  await clickBack(ctx);
  await clickBack(ctx);
  record('TB-84 after task mode is turned off the tabs, the list and the views stay: the stage-line button still '
    + 'reads "4 tasks finished", a card opens its task view and its transcript opens',
  off.tabs.length === 2 && off.cards.length === 4 && off.button?.text === '4 tasks finished' && view?.task === 'T1'
    && !view.error && read?.items.length > 0, brief({ off, view: view?.title, read: read?.items.length }));
  // 模型菜单里那一项的条件同页签，协作模式关掉之后仍在
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="model-button"]`).click({ timeout: 5000 }).catch(() => {});
  const item = await menuItem(ctx);
  await ctx.page.keyboard.press('Escape');
  record('TB-84 after task mode is turned off the model menu still has "See background tasks"',
    item?.text === 'See background tasks', brief(item));
}

/**
 * @brief 别的会话读不到这个会话的 TaskBoard（TB-84）：用另一个会话（没有 TaskBoard）的 id 发两个只读命令，得到 §13.13.4 的
 *        原文、没有内容。
 */
async function otherSessionReads(ctx, who) {
  const other = await openSessionIn(ctx, ctx.plain);
  const otherId = (await userSession(ctx, other)).sessionId;
  const task = await bridge(ctx, { type: 'board.readTask', sessionId: otherId, task: 'T1' });
  const session = await bridge(ctx, { type: 'board.readSession', sessionId: otherId,
    of: { kind: 'close', request: 1 } });
  record('TB-84 another session\'s id cannot read this TaskBoard: board.readTask T1 and board.readSession of Request 1 '
    + 'report "T1 does not exist." and "Request 1 does not exist." and give nothing',
  task?.error === 'T1 does not exist.' && task.task === null && session?.error === 'Request 1 does not exist.'
    && session.entries.length === 0, brief({ task, session: session && { error: session.error,
    entries: session.entries.length } }));
  await showTab(ctx, who.tab);
}

// ---------- TB-85 重新打开、重新载入 ----------

/** @brief 关上再从侧栏打开、界面重新载入（Ctrl+R）之后，列表、task 的视图与会话与之前相同（TB-85）。 */
async function reload(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  // 单独跑这一步时 task 还在变（T4 刚开始等写入锁）：等一秒内两次读到的列表相同再记下
  const cardKeys = (cards) => cards.map((card) => [card.task, card.section, card.phase]);
  const before = await poll(async () => {
    const first = await bgCards(ctx);
    await sleep(1000);
    return same(cardKeys(first), cardKeys(await bgCards(ctx))) ? first : null;
  }, 20000) ?? await bgCards(ctx);
  await ctx.page.reload();
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  const tab = await reopenSession(ctx, who.sessionFile);
  ctx.flow = { ...who, tab };
  await ctx.page.locator(`${paneSel(tab)} button[aria-label="Toggle changes"]`).click({ timeout: 15000 });
  const tabs = await poll(async () => {
    const list = await bgTabs(ctx);
    return list.length === 2 ? list : null;
  }, 15000);
  record('TB-85 after reopening, the right panel opens at Changes (which tab was chosen is not kept across reopening)',
    tabs?.find((item) => item.tab === 'changes')?.selected === 'true', brief(tabs));
  await openList(ctx, ctx.flow);
  const after = await bgCards(ctx);
  record('TB-85 after Ctrl+R and reopening the session, the list is the same',
    Boolean(tabs) && same(cardKeys(after), cardKeys(before)),
  brief({ before: cardKeys(before), after: cardKeys(after) }));
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
  // 从 task 的视图停：视图的第二行随 mori.board 实时变为 Stopped，停止按钮停止中不可用、停下后没有
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1');
  await watchMoments(ctx);
  await ctx.page.locator('[data-testid="bg-task-view"] .bg-task-head [data-action="stop-task"]').click();
  const view = await waitTaskView(ctx, 'T1', (item) => item.line.includes(' · Stopped · '));
  const { stopping } = await momentsSeen(ctx);
  const left = await ctx.page.locator('[data-testid="bg-task-view"] [data-action="stop-task"]').count();
  record('TB-89 "Stop this task" in the task view (no confirmation): the button is disabled while stopping, then the '
    + 'view\'s second line turns to "Stopped" live and the button goes away',
  stopping && Boolean(view) && left === 0, brief({ stopping, line: view?.line, left }));
  await clickBack(ctx);
  const gone = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"]`).waitFor({ state: 'detached',
    timeout: 15000 }).then(() => true, () => false);
  const stopped = await waitCard(ctx, 'T1', (item) => item.phase === 'stopped');
  const file = instanceFiles(ctx, who.sessionId).find((item) => item.id.endsWith('.t1.executor'));
  const result = await poll(() => file && readFileSync(file.file, 'utf8').includes(REJECTED_BY_STOP), 15000);
  record('TB-89 stopping a task that waits for approval: its card is rejected and goes away, the tool result is '
    + `"${REJECTED_BY_STOP}", the task is Stopped`,
  Boolean(card) && gone && Boolean(stopped) && Boolean(result), brief({ card: Boolean(card), gone, stopped, result }));
}

// ---------- team-tasks.md：交接的结果与去向、程序写的一棒、重新读（outcomes） ----------

/** @brief 等 board.json 里这个 task 的棒数到 n。 */
const batons = (ctx, who, id, n, timeout = 60000) => waitBoard(ctx, who,
  (board) => (taskOf(board, id)?.handoffs.length ?? 0) >= n, `${id} with ${n} batons`, timeout);

/**
 * @brief 运行结束的会话不再重新读、运行中的随 TaskView 重新读（team-tasks.md“实例的会话”的“运行结束”“实例在运行”）：
 *        T1 交给 reviewer、reviewer 等 8 秒时打开 executor 的会话；executor 再做一棒之后它仍是打开时的样子。
 *        reviewer 第二次等 8 秒时打开它的会话：运行中，它交接之后重新读，是结束的样子。
 */
async function rereads(ctx, who) {
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1');
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'executor');
  const ended = await waitTranscript(ctx, 'task');
  await batons(ctx, who, 'T1', 3);
  await sleep(1500);
  const stale = await transcriptOf(ctx);
  record('TB-83 a transcript opened after its run ended stays as it was while that role runs again (no re-read)',
    ended?.running === 'false' && stale?.tools.length === ended.tools.length
      && stale.items.length === ended.items.length, brief({ ended: ended?.tools, stale: stale?.tools }));
  await clickBack(ctx);
  await waitTaskView(ctx, 'T1');
  // 会话视图加一条只在测试里的高度上限，让内容超出、能滚（synthetic test setup），看重新读之后是否仍在底部
  const style = await ctx.page.addStyleTag({ content: '[data-testid="bg-transcript"] { max-height: 220px; }' });
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'reviewer');
  const live = await waitTranscript(ctx, 'task');
  const after = await poll(async () => {
    const view = await transcriptOf(ctx);
    return view?.running === 'false' ? view : null;
  }, 30000, 200);
  await sleep(300);
  const scroll = await ctx.page.locator('[data-testid="bg-transcript"]').evaluate((el) => ({
    overflows: el.scrollHeight > el.clientHeight, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
  await style.evaluate((el) => el.remove());
  record('TB-83 a transcript opened while its instance runs is read again when the task changes: running, then '
    + 'ended with the new handoff', live?.running === 'true' && after?.tools.length > live.tools.length,
  brief({ live: live?.tools, after: after?.tools }));
  record('TB-83 a running transcript you are at the bottom of stays at the bottom when it is read again',
    Boolean(after) && scroll.overflows && scroll.gap <= 24, brief(scroll));
  await clickBack(ctx);
  await clickBack(ctx);
}

/** @brief 四个 task 的视图里交接的头一行与 T4 的建议（team-tasks.md“task 的视图”的表）。 */
async function outcomeViews(ctx) {
  const views = {};
  for (const id of ['T1', 'T2', 'T3', 'T4']) {
    await clickCard(ctx, id);
    views[id] = await waitTaskView(ctx, id);
    await clickBack(ctx);
  }
  const heads = (id) => views[id]?.handoffs.map((item) => item.head) ?? [];
  record('TB-82 the handoff heads use the §15 words: Continue → reviewer, Fail → executor, Dead end → reviewer, '
    + 'Blocked → planner (closing), Closed as failed → Failed', same(heads('T1'), ['#1 executor · Continue → reviewer',
    '#2 reviewer · Fail → executor', '#3 executor · Dead end → reviewer', '#4 reviewer · Blocked → planner (closing)',
    '#5 planner · Closed as failed → Failed']), brief(heads('T1')));
  record('TB-82 need_user reads "Needs your decision → planner (planning)"',
    same(heads('T2'), ['#1 executor · Needs your decision → planner (planning)']), brief(heads('T2')));
  record('TB-82 a baton the program writes reads "#1 Mori · dependency failed → planner (closing)" and has no '
    + '"View transcript" (no session position)', heads('T3')[0] === '#1 Mori · dependency failed → planner (closing)'
    && views.T3.handoffs[0].transcript === false && heads('T3')[1] === '#2 planner · Closed as failed → Failed',
  brief(views.T3?.handoffs));
  record('TB-82 a written next that does not take effect shows as "Suggested next: reviewer"',
    heads('T4')[0] === '#1 executor · Done → planner (closing)'
      && views.T4.handoffs[0].text.includes('Suggested next: reviewer'), brief(views.T4?.handoffs));
}

/** @brief 交接的各种结果与去向、程序写的一棒、建议的下一棒、两个角色的 View transcript、重新读（scenarios 的 outcomes）。 */
async function outcomes(ctx) {
  const project = tempProject('mori-tb-tasks-outcomes-');
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Try every outcome ${tag('outcomes')}`, { allow: true });
  await batons(ctx, who, 'T1', 1);
  await openList(ctx, who);
  await rereads(ctx, who);
  await settle(ctx, who, 120000);
  const card = await waitCard(ctx, 'T1');
  const label = await ctx.page.locator('[data-testid="bg-task"][data-task="T1"] [data-action="view-transcript"]'
    + '[data-role="reviewer"]').getAttribute('aria-label').catch(() => null);
  record('TB-81 a task two roles worked on has "View transcript (executor)" and "View transcript (reviewer)" '
    + '(screen reader name "View transcript for reviewer on T1")', same(card?.links, ['View transcript (executor)',
    'View transcript (reviewer)']) && label === 'View transcript for reviewer on T1', brief({ card, label }));
  await outcomeViews(ctx);
}

// ---------- team-tasks.md“实例的会话”的“还没有条目”（noactivity） ----------

/**
 * @brief 实例会话还在建的时候停下 task（慢启动扩展，synthetic）：投递不发出，会话开着、里面没有消息，View transcript 打开后
 *        是 No activity yet。
 */
async function noactivity(ctx) {
  const tab = await openSessionIn(ctx, ctx.idle, { trust: true });
  writeFileSync(ctx.slowMarker, 'on\n');
  try {
    await sendMessage(ctx, tab, `Start slowly ${tag('idle')}`, { team: true });
    const who = { tab, ...(await userSession(ctx, tab)) };
    await openList(ctx, who);
    const starting = await waitCard(ctx, 'T1', (card) => card.phase === 'starting' && card.links.length === 0,
      SLOW_START_MS * 3);
    await ctx.page.locator('[data-testid="bg-task"][data-task="T1"] [data-action="stop-task"]').click();
    const card = await waitCard(ctx, 'T1', (item) => item.phase === 'stopped' && item.links.length === 1,
      SLOW_START_MS * 2);
    await openTranscript(ctx, '[data-testid="bg-task"][data-task="T1"] .bg-task-links', null);
    const view = await waitTranscript(ctx, 'task');
    record('TB-83 a task stopped while its instance session was still being created has an open session with no '
      + 'message: its transcript shows "No activity yet"', Boolean(starting) && Boolean(card) && view?.empty
      && view.items.length === 0, brief({ starting: starting?.line, card: card?.line, view }));
    await clickBack(ctx);
  } finally {
    rmSync(ctx.slowMarker, { force: true });
  }
}

// ---------- team-tasks.md“入口”的“窄窗口、分屏放不下”（narrow） ----------

/** @brief 窗口 800 宽、分屏放不下右栏时：阶段行按钮与进展摘要的链接都把 Background tasks 浮在上层打开。 */
async function narrow(ctx) {
  const who = await flowSession(ctx);
  await closedPanel(ctx, who);
  const other = await openSessionIn(ctx, ctx.plain);
  const otherFile = (await userSession(ctx, other)).sessionFile;
  await showTab(ctx, who.tab);
  const { menu: rowMenu } = await openMenuByMouse(ctx.page, otherFile);
  await rowMenu.getByRole('menuitem', { name: 'Open in split view' }).click();
  await waitSplit(ctx.page);
  const size = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  try {
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 700));
    await sleep(500);
    // 浮在上层：分屏放不下时是 .floating，内容区窄于 800px 时是 layout.css 的媒体查询，两种都是 position: absolute。
    // 阶段行按钮回到 Background tasks 上次在的那一层（列表、task 的视图或会话，都是 .bg-body）
    const floating = () => ctx.page.locator('[data-testid="right-panel"]').evaluate((el) => getComputedStyle(el)
      .position === 'absolute' && Boolean(el.querySelector('.bg-body'))).catch(() => false);
    await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tasks-button"]`).click();
    const byButton = await poll(floating, 5000, 100);
    await ctx.page.locator('[data-testid="right-panel"] [aria-label="Close panel"]').first().click();
    await ctx.page.locator(`${paneSel(who.tab)} [data-action="open-in-tasks"][data-request="1"]`).click();
    const byLink = await poll(floating, 5000, 100);
    record('TB-80 when the split cannot fit the right panel, the stage-line button and a progress-summary link open '
      + 'Background tasks floating over the panes', byButton === true && byLink === true, brief({ byButton, byLink }));
  } finally {
    await ctx.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size);
    await ctx.page.locator(`${paneSel(other)} [data-testid="close-pane"]`).click().catch(() => {});
    await waitSplit(ctx.page, false).catch(() => {});
  }
}

// ---------- team-tasks.md“入口”的页签那一行（tabs） ----------

/** @brief 页签那一行：Changes 下与原来相同（没有自己的标题行）；切页签时展开不变；文件阅读器属于 Changes。 */
async function tabs(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  const expanded = () => ctx.page.locator('.app[data-right-expanded]').count();
  await ctx.page.locator('[data-testid="right-panel"] .panel-tabs .panel-expand').click();
  const before = await expanded();
  await clickTab(ctx, 'changes');
  const changes = { expanded: await expanded(),
    list: await ctx.page.locator('[data-testid="right-panel"] [data-testid="changes"]').count(),
    header: (await ctx.page.locator('[data-testid="right-panel"]').textContent()).includes('This session’s changes') };
  record('TB-80 with the tabs, Changes shows the changes list without its own "This session’s changes" row, and '
    + 'switching tabs keeps Expand', before === 1 && changes.expanded === 1 && changes.list === 1 && !changes.header,
  brief({ before, changes }));
  await ctx.page.locator('[data-testid="right-panel"] .panel-tabs .panel-expand').click();
  await clickTab(ctx, 'tasks');
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1');
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'executor');
  await waitTranscript(ctx, 'task');
  // 运行结束的会话里工具卡折在 "{n} steps" 里：先展开那一组
  const path = ctx.page.locator('[data-testid="bg-transcript"] [data-testid="tool-path"]').first();
  await showBgStep(path);
  await path.click();
  await ctx.page.locator('[data-testid="file-viewer"]').waitFor({ timeout: 10000 });
  const viewer = await ctx.page.locator('[data-testid="right-panel"]').evaluate((panel) => ({
    tab: panel.querySelector('[data-testid="right-tab"][aria-selected="true"]')?.dataset.tab,
    fileRow: panel.querySelectorAll('.file-header .panel-expand, .file-header [aria-label="Close panel"]').length,
    back: Boolean(panel.querySelector('.file-header .back-link')),
    tabRow: panel.querySelectorAll('.panel-tabs .panel-expand, .panel-tabs [aria-label="Close panel"]').length }));
  record('TB-80 the file viewer belongs to Changes: a path in a transcript opens it under the Changes tab; its own row '
    + 'has "← Changes" and no Expand / Collapse or Close panel (those stay on the tab row)', viewer.tab === 'changes'
    && viewer.fileRow === 0 && viewer.back && viewer.tabRow === 2, brief(viewer));
  await clickTab(ctx, 'tasks');
  const layer = await ctx.page.locator('[data-testid="bg-transcript"]').count();
  record('TB-80 back on Background tasks the panel is where you left it (the transcript)', layer === 1, brief(layer));
  await ctx.page.locator('[data-testid="right-panel"] .panel-tabs [aria-label="Close panel"]').click();
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tasks-button"]`).click();
  const reopened = await poll(() => ctx.page.locator('[data-testid="bg-transcript"]').count(), 5000, 100);
  record('TB-80 after Close panel the stage-line button reopens Background tasks at the layer you left (the '
    + 'transcript)', reopened === 1, brief(reopened));
  await clickBack(ctx);
  await clickBack(ctx);
}

// ---------- TB-82 打开着的 task 视图重新读（liveview） ----------

/**
 * @brief 第一棒之前打开 T1 的视图，一直不关：每一棒到了视图就重新读（team-tasks.md“task 在运行”），第三棒是
 *        “#3 executor · Dead end → reviewer”。最多每秒一次读的节奏在 taskList.test.mjs 的 TB-82（rereadWait）。
 */
async function liveview(ctx) {
  const project = tempProject('mori-tb-tasks-live-');
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Watch the view ${tag('live')}`);
  await waitBoard(ctx, who, (board) => board.tasks.length === 1, 'T1');
  await openList(ctx, who);
  await clickCard(ctx, 'T1');
  const first = await waitTaskView(ctx, 'T1');
  const third = await waitTaskView(ctx, 'T1', (view) => view.handoffs.length >= 3, 60000);
  const heads = third?.handoffs.map((item) => item.head) ?? [];
  // 和视图第一次读到的比（第一棒前等 5 秒、第二棒前再等 5 秒，第一次读到时最多一两棒）
  record('TB-82 an open task view is read again when the task changes, without reopening it: it first showed fewer '
    + 'than three batons, then "#3 executor · Dead end → reviewer"',
  (first?.handoffs.length ?? 3) < 3 && heads[2] === '#3 executor · Dead end → reviewer',
  brief({ first: first?.handoffs.length, heads }));
  await clickBack(ctx);
  await settle(ctx, who, 120000);
}

// ---------- TB-83 程序写的一棒的会话（program） ----------

/**
 * @brief executor 的模型没有写入等级（synthetic），读一个文件后不交接就结束：程序写 “#1 Mori · no handoff”，它的
 *        View transcript 打开 executor 在 T1 上的会话（不是 Mori 的）。
 */
async function program(ctx) {
  const project = tempProject('mori-tb-tasks-program-');
  writeRoles(project, SPLIT_ROLES.map((role) => (role.name === 'executor'
    ? { ...role, models: [`tbplain/${PLAIN_MODEL}`] } : role)));
  const who = await begin(ctx, project, `End without a handoff ${tag('program')}`);
  await waitBoard(ctx, who, (board) => (taskOf(board, 'T1')?.handoffs.length ?? 0) >= 2,
    'T1 with the program baton and the close baton', 90000);
  await openList(ctx, who);
  await clickCard(ctx, 'T1');
  const view = await waitTaskView(ctx, 'T1', (item) => item.handoffs.length >= 2);
  const link = ctx.page.locator('[data-testid="bg-handoff"][data-n="1"] [data-action="view-transcript"]');
  const role = await link.getAttribute('data-role', { timeout: 5000 }).catch(() => null);
  if (role) await link.click();
  const read = role ? await waitTranscript(ctx, 'task') : null;
  record('TB-83 a baton the program writes after the instance ran ("#1 Mori · no handoff → planner (closing)") opens '
    + 'that instance\'s session (data-role "executor"), not Mori\'s',
  view?.handoffs[0]?.head === '#1 Mori · no handoff → planner (closing)' && role === 'executor'
    && read?.title === 'executor · T1 Read and stop' && !read.error && read.items.length > 0,
  brief({ head: view?.handoffs[0]?.head, role, read: read && { title: read.title, error: read.error } }));
  if (read) await clickBack(ctx);
  await clickBack(ctx);
  await settle(ctx, who, 120000);
}

// ---------- 两个会话：页签按会话记住、切换、分屏（sessions） ----------

/** @brief 一个会话跑完 pair 场景（a：Alpha task，b：Beta task），两个会话都有 T1。 */
async function pairSession(ctx, which) {
  const project = tempProject(`mori-tb-tasks-pair-${which}-`);
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Pair ${which} ${tag(`pair-${which}`)}`);
  await waitBoard(ctx, who, (board) => taskOf(board, 'T1')?.status === 'done', `pair ${which} T1 done`, 90000);
  await dialogIdle(ctx, who);
  return who;
}

/** @brief 选中的页签（changes / tasks）；没有页签时为 null。 */
const selectedTab = async (ctx) => (await bgTabs(ctx)).find((item) => item.selected === 'true')?.tab ?? null;

/**
 * @brief 在页面里记下 task 视图里出现过的内容属于哪个会话（Alpha / Beta），返回 { switchTo（在同一次 evaluate 里放一个
 *        "switch" 再点侧栏那一行，之后视图一变就记一次，内容没换也记）, seen（取记录） }。切到另一个会话的那一刻起，
 *        视图里不该出现上一个会话读到的说明与交接。
 */
async function watchViews(ctx) {
  await ctx.page.evaluate(() => {
    window.__bgViews = [];
    const note = () => {
      const text = document.querySelector('[data-testid="bg-task-view"]')?.textContent ?? '';
      const who = text.includes('Alpha description') ? 'alpha' : text.includes('Beta description') ? 'beta' : 'none';
      if (window.__bgViews.at(-1) !== who) window.__bgViews.push(who);
    };
    note();
    window.__bgViewsObserver?.disconnect();
    window.__bgViewsObserver = new MutationObserver(note);
    window.__bgViewsObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return {
    switchTo: (tab) => ctx.page.evaluate((row) => {
      window.__bgViews.push('switch');
      document.querySelector(`.session-item[data-row="${row}"]`).click();
    }, tab),
    seen: () => ctx.page.evaluate(() => {
      window.__bgViewsObserver?.disconnect();
      return window.__bgViews;
    }),
  };
}

/**
 * @brief 两个都有 T1 的会话：页签按会话记住（TB-80）；两边都停在 T1 的视图时切换，马上看到的是那个会话自己的 T1
 *        （TB-82）；分屏时点没有焦点那一栏的阶段行按钮，右栏打开到那一栏的 Background tasks（TB-80，审查 #15）。
 */
async function sessions(ctx) {
  const a = await pairSession(ctx, 'a');
  const b = await pairSession(ctx, 'b');
  await openList(ctx, a);
  await clickTab(ctx, 'changes');
  await openList(ctx, b);
  await showTab(ctx, a.tab);
  const onA = await poll(() => selectedTab(ctx), 5000, 100);
  await showTab(ctx, b.tab);
  const onB = await poll(() => selectedTab(ctx), 5000, 100);
  record('TB-80 the tab is kept per session: switching between two sessions, each shows the tab it was left on',
    onA === 'changes' && onB === 'tasks', brief({ onA, onB }));
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1', (view) => view.prompt.includes('Beta description'));
  await showTab(ctx, a.tab);
  await clickTab(ctx, 'tasks');
  await clickCard(ctx, 'T1');
  await waitTaskView(ctx, 'T1', (view) => view.prompt.includes('Alpha description'));
  const watch = await watchViews(ctx);
  await watch.switchTo(b.tab);
  await showTab(ctx, b.tab);
  const own = await waitTaskView(ctx, 'T1', (view) => view.prompt.includes('Beta description'));
  await sleep(1500);
  const views = await watch.seen();
  const afterSwitch = views.slice(views.indexOf('switch') + 1);
  record('TB-82 two sessions both at their T1 view: switching to the other shows its own T1 at once, never the '
    + 'previous session\'s prompt or handoffs', Boolean(own) && views.includes('switch') && afterSwitch.length > 0
    && !afterSwitch.includes('alpha'), brief(views));
  await splitButton(ctx, a, b);
}

/**
 * @brief 分屏：a 有焦点、右栏开着（Changes），b 的右栏关着；点 b 的阶段行按钮：这一下点成，右栏打开到 b 的
 *        Background tasks（b 的 T1）。按下就切焦点的话右栏先换成 b 的（关着）、两栏变宽，按钮被挤走（审查 #15）。
 */
async function splitButton(ctx, a, b) {
  await clickBack(ctx);
  await closedPanel(ctx, b);
  await showTab(ctx, a.tab);
  await openList(ctx, a);
  await clickTab(ctx, 'changes');
  const { menu: rowMenu } = await openMenuByMouse(ctx.page, b.sessionFile);
  await rowMenu.getByRole('menuitem', { name: 'Open in split view' }).click();
  await waitSplit(ctx.page);
  try {
    await ctx.page.locator(`${paneSel(a.tab)} .composer textarea`).click();
    await sleep(300);
    await ctx.page.locator(`${paneSel(b.tab)} [data-testid="tasks-button"]`).click();
    const cards = await poll(async () => {
      const list = await bgCards(ctx);
      return list.length ? list : null;
    }, 5000, 100);
    const tab = await selectedTab(ctx);
    record('TB-80 in split view, clicking the stage-line button of the pane without focus works: the right panel '
      + 'opens at that pane\'s Background tasks', tab === 'tasks' && cards?.[0]?.title === 'T1 Beta task',
    brief({ tab, cards: cards?.map((card) => card.title) }));
  } finally {
    await ctx.page.locator(`${paneSel(b.tab)} [data-testid="close-pane"]`).click().catch(() => {});
    await waitSplit(ctx.page, false).catch(() => {});
  }
}

// ---------- TB-80 模型菜单 ----------

/**
 * @brief 模型菜单里 See background tasks 那一项：{ text, role, placed（在 Task mode 那一段里紧跟 Task mode 一行、
 *        下面是 Manage agents） }；没有时为 null。
 */
function menuItem(ctx) {
  return ctx.page.locator('[data-testid="model-menu"] [data-action="see-background-tasks"]').evaluate((el) => {
    const group = el.closest('.task-mode-group');
    const items = group ? [...group.querySelectorAll('[role^="menuitem"]')] : [];
    const at = items.indexOf(el);
    return { text: el.textContent.trim(), role: el.getAttribute('role'),
      placed: at > 0 && items[at - 1].dataset.testid === 'team-switch'
        && items[at + 1]?.dataset.action === 'manage-agents' };
  }, null, { timeout: 5000 }).catch(() => null);
}

/**
 * @brief 模型菜单 Task mode 那一段里 Task mode 一行之后的 See background tasks（WP-09 起协作模式在模型菜单里；下面是
 *        customize-agents 的 Manage agents）：回复进行中也能用，
 *        点它关上菜单、打开右栏到 Background tasks（TB-80）。
 */
async function menu(ctx) {
  const project = tempProject('mori-tb-tasks-menu-');
  writeRoles(project, SPLIT_ROLES);
  const who = await begin(ctx, project, `Look at the menu ${tag('menu')}`);
  await waitBoard(ctx, who, (board) => board.tasks.length === 1, 'T1');
  const replying = await poll(async () => (await paneState(ctx.page, who.tab))?.running === true, 10000, 100);
  const during = await waitButton(ctx, who, '1 running task') ?? await tasksButton(ctx, who.tab);
  record('TB-80 the stage-line button shows while the dialog is replying ("1 running task")',
    Boolean(replying) && during?.text === '1 running task', brief({ replying, during }));
  // 点不开或没有这一项时记为失败（下面的 record），不在这里抛出
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="model-button"]`).click({ timeout: 5000 }).catch(() => {});
  const item = await menuItem(ctx);
  if (item) await ctx.page.locator('[data-testid="model-menu"] [data-action="see-background-tasks"]').click();
  const menuGone = await ctx.page.locator('[data-testid="model-menu"]').count() === 0;
  const tabs = await bgTabs(ctx);
  const still = (await paneState(ctx.page, who.tab))?.running === true;
  record('TB-80 the model menu\'s Task mode part has "See background tasks" right after the Task mode row (a menu '
    + 'item, above Manage agents), usable while a reply is running; it closes the menu and opens the right panel at '
    + 'Background tasks',
  item?.text === 'See background tasks' && item.role === 'menuitem' && item.placed && Boolean(replying) && still
    && menuGone && tabs.find((tab) => tab.tab === 'tasks')?.selected === 'true',
  brief({ item, replying, still, menuGone, tabs }));
  const report = await issueReport(ctx, who.tab, 'See background tasks');
  const since = actionsAfter(report.actions, 'Send (task mode): Look at the menu');
  record('TB-80 F8 records "Open background tasks" for the model menu item',
    since.some((line) => line.includes('Open background tasks')), brief(since));
}

// ---------- TB-83 实例会话里的步骤组 ----------

/** @brief 会话视图里的步骤组：[{ text, expanded }] 与看得见的工具卡数。 */
function stepGroups(ctx) {
  return ctx.page.locator('[data-testid="bg-transcript"]').evaluate((root) => ({
    groups: [...root.querySelectorAll('[data-testid="step-group"]')].map((el) => ({ text: el.textContent.trim(),
      expanded: el.getAttribute('aria-expanded') })),
    visibleTools: [...root.querySelectorAll('[data-testid="tool-card"]')].filter((el) => el.checkVisibility()).length,
  }), null, { timeout: 5000 }).catch(() => null);
}

/**
 * @brief 实例会话里一轮结束后的步骤折叠同对话流（§13.13.4；docs/v0/screens/chat.md“步骤组”）：做完的 T1 会话里
 *        思考与工具卡折成一行 “<n> steps”（前面的 ▸ / ▾ 是样式画的，不在文字里），点开看到工具卡；运行中的 T3 正在做的
 *        那一组全部显示。
 */
async function folding(ctx) {
  const who = await flowSession(ctx);
  await openList(ctx, who);
  await openTranscript(ctx, '[data-testid="bg-task"][data-task="T1"] .bg-task-links', null);
  await waitTranscript(ctx, 'task');
  const folded = await stepGroups(ctx);
  const label = /^[\d,]+ steps?( · [\d,]+ failed)?$/;
  record('TB-83 a finished instance session folds its steps as the chat does: one line "<n> steps" '
    + '(aria-expanded false) and no tool card showing',
  folded?.groups.length > 0 && folded.groups.every((group) => group.expanded === 'false' && label.test(group.text))
    && folded.visibleTools === 0, brief(folded));
  if (folded?.groups.length) {
    await ctx.page.locator('[data-testid="bg-transcript"] [data-testid="step-group"]').first().click();
  }
  const opened = await stepGroups(ctx);
  record('TB-83 clicking the line expands the group (aria-expanded true, same "<n> steps") and its tool cards show',
    opened?.groups[0]?.expanded === 'true' && opened.groups[0].text === folded?.groups[0]?.text
    && opened.visibleTools > 0, brief(opened));
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
 * @brief 后台进程退出之后的三种失败（之后的请求都失败；检查完重启 App）：停止的那一行 Couldn’t stop T1: …、
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
  // 时长每秒更新：T1 一直在等（没有新的 mori.board），卡片上的时长自己从 <1 min 走到 1 min
  const first = await waitCard(ctx, 'T1');
  const ticked = await waitCard(ctx, 'T1', (card) => card.line.endsWith(' · 1 min'), 75000);
  record('TB-81 the duration on a running card updates by itself (no board change): "<1 min", then "1 min"',
    first?.line.endsWith(' · <1 min') && ticked?.phase === first.phase, brief({ first: first?.line,
      ticked: ticked?.line }));
  await killTbKernel(ctx);
  try {
    await afterCrash(ctx);
  } finally {
    // 后台进程已经退出：重启 App，后面的步骤（restart）照常打开项目；之前的会话面板都失效了
    ctx.flow = null;
    await restartTbApp(ctx);
  }
}

/** @brief 后台进程退出之后：停止、task 的视图与会话各自显示错误（errors 的后半）。 */
async function afterCrash(ctx) {
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
  await deleteSession(ctx, who);
}

/** @brief 删除这个会话（菜单 → Delete… → 确认）：Background tasks 随会话没有了，teams/<id> 一并删除（TB-85）。 */
async function deleteSession(ctx, who) {
  const row = ctx.page.locator(`.session-item[data-file=${JSON.stringify(who.sessionFile)}]`).first();
  await row.click({ button: 'right', position: { x: 40, y: 10 } });
  await ctx.page.getByTestId('session-menu').getByRole('menuitem', { name: 'Delete…' }).click();
  await ctx.page.getByTestId('delete-dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await row.waitFor({ state: 'detached', timeout: 20000 });
  await ctx.page.getByTestId('delete-dialog').waitFor({ state: 'detached', timeout: 20000 });
  const panel = await ctx.page.locator('[data-testid="bg-tasks"], [data-testid="bg-transcript"]').count();
  const dir = existsSync(teamDir(ctx, who.sessionId));
  record('TB-85 deleting the session takes its Background tasks with it: the panel is gone and teams/<id> is deleted',
    panel === 0 && !dir, brief({ panel, dir }));
}

// ---------- 主流程 ----------

const steps = { plain, empty, entries, list, taskview, transcript, folding, tabs, keys, stop, readonly, reload,
  narrow, approval, outcomes, noactivity, liveview, program, sessions, menu, errors, restart };

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
