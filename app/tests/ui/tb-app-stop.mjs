// 平行 Agent 与 TaskBoard 的 App 套件：批准与停止（docs/specs/parallel-agents-taskboard.md §17.2）。真正的 Mori（界面 +
// 后台进程 + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/stop.mjs，synthetic），逐条验收这些编号在
// App 层的通过条件：
//   TB-34 后台批准卡、TB-35 停止、TB-36 重新载入与重启、TB-42 归档、删除与关闭。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs stop）：
//   MORI_APP_DIR=.tb-runs/stop node tests/ui/tb-app-stop.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 步骤：approve、team、esc、escjudge、escmerged、reload、del、restart（restart 最后跑，重启 App）。
// 结果写到 test-results/tb-app-stop(-packaged).json（--only 时 tb-partial-app-stop…），截图在 test-results/tb-app-stop/。
// 端口（§17.1 的 4600–4699 里分给本套件的 4660–4669）：合成端点 4660，记录代理 4661。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好一个本机提供商（写入等级 A、能关思考，跳过探针）；
// 四个临时项目：分开配置（chat / planner / executor / reviewer）两个（其中一个在重启前删掉 reviewer.md）、没有角色文件
// （合并会话）一个、分开配置加一个记下 session_shutdown 的项目扩展（信任这个项目）一个。权限都从"每次询问"开始。
// 每个步骤用自己的会话；同一时刻只开一个 App。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  allowAll, appLogLines, approvalCardsOf, brief, captureOrder, clickTeamSwitch, closeTbApp, contentText, customOf,
  instanceFiles, instanceSuffix, kernelEvents, lineBrief, liveInfo, messagesOf, missingSteps, oneLine, openSessionIn,
  paneSel, paneState, poll, progressOf, readBoard, readJsonl, receiptsOf, reopenSession, scenarioLines,
  scenarioRequests, seedTeamUserData, sendMessage, shot, showTab, sleep, SPLIT_ROLES, startTbApp, startTbEndpoint,
  stopTbEndpoint, suiteArgs, tbModel, tbProvider, tbRecorder, teamDir, tempProject, tempUserData, transcriptItems,
  userSession, waitApprovalCard, waitTaskPhase, waitTeamIdle, watchTaskPhases, writeRoles,
} from './tb-helpers.mjs';
import { withoutWorkCards } from '../fake-endpoint/scripts.mjs';
import { captureEvents, watchStages } from './v1-switch-helpers.mjs';

const args = suiteArgs('stop');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4660;
const PROXY = 4661;
/** 合成端点上的模型（synthetic）：写入等级 A、能关思考 */
const MODEL = 'fake-coder-tbstop';
/** TaskBoard 的工具名（§6.3） */
const TEAM_TOOLS = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close'];
/** 程序给的固定文字（§10.1、§11.1、§11.6、v0 的批准与生成中） */
const STOPPED_BY_USER = 'Stopped by the user.';
const REJECTED_BY_STOP = 'Rejected: the user stopped the run.';
const PERMISSION_NOTE = 'Applies to all agents in this session. New sessions start at Ask each time.';
const RESTARTED = 'Stopped (Mori restarted)';
const GENERATING = 'The session is generating; stop it first';
const BUSY_HINT = '正在生成';
const STOPPED_NOTE = '已停止 · 已经做出的修改不会自动撤销';

/** @brief 这个套件的脚本标记（scenarios/stop.mjs 的 tb-stop-<name>）。 */
const tag = (name) => `tb-scenario:tb-stop-${name}`;

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 会话文件里 pi 消息的文字。 */
const textOfMessage = (message) => contentText(message?.content);
/** @brief 会话文件里某个工具的工具结果（toolResult 消息），按顺序。 */
const toolResults = (entries, tool) => messagesOf(entries)
  .filter((m) => m.role === 'toolResult' && m.toolName === tool);
/** @brief TaskBoard 上的一个 task / 需求。 */
const taskOf = (board, id) => board?.tasks.find((task) => task.id === id) ?? null;
const requestOf = (board, no) => board?.requests.find((request) => request.no === no) ?? null;
/** @brief task 的简要（重启前后、停止前后比较）：状态、持有者、交接的棒数。 */
const taskBrief = (board) => (board?.tasks ?? []).map((task) => ({ id: task.id, status: task.status,
  holder: task.holder, batons: task.handoffs.length }));
/** @brief 某个用户会话里某个实例会话（按后缀，例如 t1.executor）的文件；没有时 null。 */
const instanceOf = (ctx, sid, suffix) => instanceFiles(ctx, sid)
  .find((file) => instanceSuffix(sid, file.id) === suffix) ?? null;

/** @brief 端点日志里第一行符合条件的（where 同 scenarioLines，另可要求 k、j）；没有时 null。 */
function findLine(ctx, scenario, where) {
  const { k, j, ...rest } = where;
  return scenarioLines(ctx.ep, scenario, rest).find((line) => (k === undefined || String(line.k) === String(k))
    && (j === undefined || line.j === j)) ?? null;
}
/** @brief 等端点日志出现符合条件的一行。 */
const waitLine = (ctx, scenario, where, timeout = 30000) => poll(() => findLine(ctx, scenario, where), timeout);
/** @brief 等 board.json 满足 pred，返回那时的 board；超时为 null。 */
const waitBoard = (ctx, sid, pred, timeout = 30000) => poll(() => {
  const board = readBoard(ctx, sid);
  return board && pred(board) ? board : null;
}, timeout);
/** @brief 一个请求里最后一次投递的文字：去掉只有工作卡的消息（scripts.mjs withoutWorkCards）后最后一条 user 消息。 */
const lastUserText = (item) => contentText(withoutWorkCards(item?.messages ?? []).filter((m) => m.role === 'user')
  .at(-1)?.content);

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/** @brief 在 project 里开一个新会话并发第一条消息；返回 { tab, sessionId, sessionFile, since }。 */
async function begin(ctx, project, text, { team = true } = {}) {
  const tab = await openSessionIn(ctx, project);
  const since = Date.now();
  await sendMessage(ctx, tab, text, { team });
  return { tab, ...(await userSession(ctx, tab)), since };
}

/** @brief 等这个会话的对话回复了 text 并停下（后台可以还在运行）。 */
const waitReply = (ctx, who, text, timeout = 30000) => poll(async () => {
  const pane = await paneState(ctx.page, who.tab);
  return pane.assistants.includes(text) && !pane.running && !pane.sending;
}, timeout);

/** @brief 焦点放进这个会话的输入框，按一个键（Esc、Alt+1…）。 */
async function pressInComposer(ctx, tab, key) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).focus();
  await ctx.page.keyboard.press(key);
}

/** @brief 点这个会话的 Stop team。 */
const clickStopTeam = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="stop-team"]`)
  .click({ timeout: 10000 });

/** @brief 经进程桥发一条命令，出错时不抛出：{ result, error }。 */
const tryBridge = (ctx, command) => ctx.page.evaluate((cmd) => window.mori.request(cmd)
  .then((result) => ({ result, error: result?.error ?? null }),
    (error) => ({ result: null, error: String(error?.message ?? error) })), command);

// ---------- 批准卡、侧栏、菜单与 F8 ----------

/** @brief 批准卡的选择器（data-request 为 requestId）。 */
const cardSel = (tab, id) => `${paneSel(tab)} [data-testid="approval-card"][data-request="${id}"]`;

/** @brief 等 requestId 为 id 的批准卡显示出来，返回 approvalCardsOf 里的它；超时为 null。 */
async function waitCardId(ctx, tab, id, timeout = 30000) {
  const shown = await ctx.page.locator(cardSel(tab, id)).waitFor({ timeout }).then(() => true, () => false);
  return shown ? (await approvalCardsOf(ctx, tab)).find((card) => card.request === id) ?? null : null;
}

/** @brief 等这张卡消失；消失时为 true。 */
const cardGone = (ctx, tab, id, timeout = 10000) => ctx.page.locator(cardSel(tab, id))
  .waitFor({ state: 'detached', timeout }).then(() => true, () => false);

/** @brief 某个用户会话的后台批准卡事件：{ requests, ends }（data），可从 since 起。 */
async function teamApprovalEvents(ctx, sid, since = 0) {
  const requests = (await kernelEvents(ctx, sid, 'mori.team_approval_request', since)).map((item) => item.data);
  const ends = (await kernelEvents(ctx, sid, 'mori.team_approval_end', since)).map((item) => item.data);
  return { requests, ends };
}

/** @brief 侧栏里会话文件为 file 的那一行的状态（data-status；没有状态时 null，没有这一行时 'no row'）。 */
const rowStatus = (ctx, file) => ctx.page.locator(`.session-item[data-file=${JSON.stringify(file)}]`).first()
  .evaluate((el) => el.querySelector('[data-testid="session-status"]')?.dataset.status ?? null, null,
    { timeout: 5000 }).catch(() => 'no row');

/** @brief 在侧栏那一行上右键，读菜单项（文字、小字、是否不可用），按 Esc 关掉。 */
async function rowMenuItems(ctx, file) {
  const row = ctx.page.locator(`.session-item[data-file=${JSON.stringify(file)}]`).first();
  await row.click({ button: 'right', position: { x: 40, y: 10 } });
  const menu = ctx.page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  const items = await menu.getByRole('menuitem').evaluateAll((els) => els.map((el) => ({
    label: el.firstChild?.nodeType === 3 ? el.firstChild.textContent : '',
    hint: el.querySelector('.menu-hint')?.textContent ?? '', disabled: el.disabled })));
  await ctx.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return items;
}

/** @brief 菜单里"归档""删除"都不可用、小字为"正在生成"。 */
const removalBlocked = (items) => ['归档', '删除'].every((label) => {
  const item = items.find((entry) => entry.label === label);
  return item?.disabled === true && item.hint === BUSY_HINT;
});

/** @brief Markdown 里"## 标题"下的非空行（到下一个"## "为止）。 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim()).filter(Boolean);
}

/** @brief 在这个会话里按 F8、写两句、保存，读保存的 Markdown："当前界面"与"最近的操作"的各行。 */
async function issueReport(ctx, tab, what) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).press('F8');
  const dialog = ctx.page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByTestId('issue-expect').fill('The team state is in the report');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const saved = ctx.page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const path = /已保存到\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  const md = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  await ctx.page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return { path, view: section(md, '当前界面'), actions: section(md, '最近的操作') };
}

/** @brief 打开权限菜单，读底部说明与"本会话已允许"，按 Esc 关掉。 */
async function permissionMenu(ctx, tab) {
  await showTab(ctx, tab);
  await ctx.page.locator(paneSel(tab)).getByTestId('permission-button').click();
  const menu = ctx.page.getByTestId('permission-menu');
  await menu.waitFor({ timeout: 5000 });
  const out = await menu.evaluate((el) => ({ note: el.querySelector('.menu-note')?.textContent ?? '',
    allowed: el.querySelector('[data-testid="permission-allowed"]')?.textContent ?? '' }));
  await ctx.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return out;
}

/** @brief 排队区里待判断的项（data-deciding）的文字。 */
const decidingItems = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="queue"] [data-deciding="true"]`)
  .evaluateAll((els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));

/** @brief 记下页面里到此为止的批准请求事件（重新载入、重启会清掉页面里的记录），TB-34 的整套检查用。 */
async function collectApprovals(ctx) {
  if (!ctx.page) return;
  const events = await kernelEvents(ctx, null, /^mori\.(team_)?approval_request$/).catch(() => []);
  for (const item of events) ctx.approvalSeen.set(`${item.sid}|${item.data.requestId}`, item.data.toolName);
}

// ---------- 准备与 App ----------

/**
 * @brief 写一个 synthetic 项目扩展（.pi/extensions/close-probe.ts）：每个会话（用户会话与实例会话）释放时
 *        （session_shutdown）把 pi 会话 id 与时刻追加到 log（JSON 行），TB-42 用它看实例会话是否随用户会话关闭。
 */
function writeCloseProbe(project, log) {
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'close-probe.ts'), [
    '// synthetic: written by tests/ui/tb-app-stop.mjs (TB-42); logs every session_shutdown.',
    "import { appendFileSync } from 'node:fs';",
    '',
    'export default function (pi) {',
    "  pi.on('session_shutdown', (_event, ctx) => {",
    `    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id: ctx.sessionManager.getSessionId(),`,
    "      t: Date.now() }) + '\\n');",
    '  });',
    '}',
    '',
  ].join('\n'));
}

/** @brief 测试准备（synthetic test setup）：四个临时项目、角色文件、项目扩展，数据目录与合成端点。 */
async function setup(ctx) {
  ctx.split = tempProject('mori-tb-stop-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  ctx.review = tempProject('mori-tb-stop-review-');
  writeRoles(ctx.review, SPLIT_ROLES);
  ctx.merged = tempProject('mori-tb-stop-merged-');
  ctx.del = tempProject('mori-tb-stop-del-');
  writeRoles(ctx.del, SPLIT_ROLES);
  ctx.probeLog = join(dirname(ctx.del), 'close-probe.log');
  writeCloseProbe(ctx.del, ctx.probeLog);
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, { providers: [tbProvider('tbs', PROXY, [tbModel(MODEL)])], trusted: [ctx.del] });
  await startApp(ctx);
}

/** @brief 启动 App，装上事件顺序与 task 行的记录；之前记下的各项目的会话面板作废（标识会重新编号）。 */
async function startApp(ctx) {
  ctx.projectTabs = {};
  await startTbApp(ctx);
  await captureOrder(ctx);
  await watchTaskPhases(ctx);
}

/** @brief 界面重新载入（page.reload，与 Ctrl+R 相同，后台进程不停）：等会话列表读完，重新装上页面里的记录。 */
async function reloadUi(ctx) {
  ctx.projectTabs = {};
  await ctx.page.reload();
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 30000 });
  await ctx.page.waitForFunction(() => document.querySelectorAll('.session-item').length > 0
    && !document.querySelector('[data-testid="session-tree"]')?.textContent?.includes('正在读取会话…'), null,
  { timeout: 20000 });
  await captureEvents(ctx.page);
  await watchStages(ctx.page);
  await captureOrder(ctx);
  await watchTaskPhases(ctx);
}

/** @brief 读实例会话文件的工具结果文字（按顺序）。 */
function resultTexts(ctx, sid, suffix, tool) {
  const file = instanceOf(ctx, sid, suffix);
  if (!file) return [];
  return toolResults(file.entries, tool).map((m) => ({ text: textOfMessage(m), error: m.isError === true }));
}

// ---------- TB-34：后台批准卡（脚本 tb-stop-approve） ----------

/**
 * @brief 关闭模式下对话自己的命令先出一张卡（approval-1），然后 /team：T1 executor 的卡（归属、编号、侧栏、F8、
 *        对话一轮结束不清掉）、Alt+1、拒绝带理由、Alt+2（本会话不再询问）、T2 reviewer 的写入卡切到全部允许。
 */
async function approve(ctx) {
  const who = await begin(ctx, ctx.split, `Run a command first ${tag('approve')}`, { team: false });
  ctx.flow.approve = who;
  const dialogCard = await waitApprovalCard(ctx, who.tab, {}, 30000);
  if (!dialogCard) throw new Error('the dialog showed no approval card');
  await ctx.page.locator(`${cardSel(who.tab, dialogCard.request)} [data-testid="approval-allow"]`).click();
  await settle(ctx, who, 60000);
  await sendMessage(ctx, who.tab, `Run commands ${tag('approve')}`, { team: true });
  const ids = [1, 2, 3].map((n) => `${who.sessionId}.t1.executor:approval-${n}`);
  const cardA = await waitCardId(ctx, who.tab, ids[0], 40000);
  if (!cardA) throw new Error('T1 showed no approval card');
  await approveFirstCard(ctx, who, dialogCard, cardA);
  await approveDialogTurn(ctx, who, cardA);
  await approveOnce(ctx, who, ids);
  await approveReject(ctx, who, ids);
  await approveSession(ctx, who, ids);
  await approveAll(ctx, who);
}

/** @brief TB-34：卡的位置、归属、编号、侧栏状态与 F8 的数目。 */
async function approveFirstCard(ctx, who, dialogCard, cardA) {
  const { requests } = await teamApprovalEvents(ctx, who.sessionId);
  const event = requests.find((item) => item.requestId === cardA.request);
  const inPane = await ctx.page.locator(`${paneSel(who.tab)} .composer`).evaluate((composer, id) => {
    const card = document.querySelector(`[data-testid="approval-card"][data-request="${id}"]`);
    return Boolean(card) && composer.closest('[data-testid="chat-pane"]').contains(card)
      && Boolean(card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, cardA.request);
  record('TB-34 a background instance that needs approval shows its card in the user session\'s column above the '
    + 'input box: header line "executor · T1 · Run commands" (data-agent executor, data-task T1), the v0 command card '
    + '(bash); the event names role executor, task T1 and the task title',
  inPane && cardA.attribution === 'executor · T1 · Run commands' && cardA.agent === 'executor'
    && cardA.task === 'T1' && cardA.tool === 'bash' && event?.role === 'executor' && event.task === 'T1'
    && event.taskTitle === 'Run commands', brief({ inPane, cardA, event }));
  record('TB-34 background request ids are "<instance id>:approval-<n>" and do not collide with the dialog\'s own: '
    + 'the dialog\'s card in this session was approval-1 and T1\'s first card is <session id>.t1.executor:approval-1',
  dialogCard.request === 'approval-1' && dialogCard.agent === null
    && cardA.request === `${who.sessionId}.t1.executor:approval-1`, brief({ dialog: dialogCard.request,
    background: cardA.request }));
  const status = await rowStatus(ctx, who.sessionFile);
  record('TB-34 the sidebar row of the session shows the waiting-for-approval status (data-status approval) while '
    + 'only a background card is pending', status === 'approval', brief({ status }));
  const report = await issueReport(ctx, who.tab, 'Background approval count');
  record('TB-34 F8 counts the background card in 等你批准 ("- 等你批准：1")',
    report.view.includes('- 等你批准：1'), brief({ path: report.path, view: report.view }));
}

/** @brief TB-34：对话这一轮在卡出现之后结束，卡还在。 */
async function approveDialogTurn(ctx, who, cardA) {
  const { requests } = await teamApprovalEvents(ctx, who.sessionId);
  const at = (await kernelEvents(ctx, who.sessionId, 'mori.team_approval_request'))
    .find((item) => item.data.requestId === cardA.request)?.t ?? Date.now();
  const settled = await poll(async () => (await kernelEvents(ctx, who.sessionId, 'agent_settled', at)).length > 0,
    20000);
  await sleep(500);
  const pane = await paneState(ctx.page, who.tab);
  const still = await ctx.page.locator(cardSel(who.tab, cardA.request)).count();
  record('TB-34 the end of a dialog turn does not clear a background card: the dialog\'s reply "Planner registered '
    + 'it." ended (agent_settled) after the card arrived and the card is still shown',
  settled && pane.assistants.includes('Planner registered it.') && still === 1 && requests.length === 1,
  brief({ settled, still, assistants: pane.assistants }));
}

/** @brief TB-34：Alt+1 允许一次。 */
async function approveOnce(ctx, who, ids) {
  await pressInComposer(ctx, who.tab, 'Alt+1');
  const gone = await cardGone(ctx, who.tab, ids[0]);
  const next = await waitCardId(ctx, who.tab, ids[1], 20000);
  const end = (await teamApprovalEvents(ctx, who.sessionId)).ends.find((item) => item.requestId === ids[0]);
  const results = resultTexts(ctx, who.sessionId, 't1.executor', 'bash');
  record('TB-34 Alt+1 (focus in the input box) allows the background card once: the card goes away (ended allow by '
    + 'user), T1\'s "echo one" runs and its next command asks again with the next id',
  gone && end?.decision === 'allow' && end.by === 'user' && results[0]?.error === false
    && results[0].text.includes('one') && next !== null, brief({ end, results, next: next?.request }));
}

/** @brief TB-34：拒绝带理由，理由回到那个实例。 */
async function approveReject(ctx, who, ids) {
  const reason = 'Use a dry run';
  await ctx.page.locator(`${cardSel(who.tab, ids[1])} [data-testid="approval-reason"]`).fill(reason);
  await ctx.page.keyboard.press('Alt+3');
  const gone = await cardGone(ctx, who.tab, ids[1]);
  const next = await waitCardId(ctx, who.tab, ids[2], 20000);
  const want = `Rejected by the user. Reason: ${reason}`;
  const results = resultTexts(ctx, who.sessionId, 't1.executor', 'bash');
  const carried = scenarioRequests(ctx.ep, 'tb-stop-approve', { agent: 'executor', task: 'T1' })
    .some((item) => item.messages.some((m) => m.role === 'tool' && contentText(m.content) === want));
  const others = [who.sessionFile, ...instanceFiles(ctx, who.sessionId)
    .filter((file) => !file.id.endsWith('.t1.executor')).map((file) => file.file)]
    .filter((file) => readFileSync(file, 'utf8').includes(reason));
  record('TB-34 a rejection reason goes back to that instance: T1\'s bash result is "Rejected by the user. Reason: '
    + 'Use a dry run" (an error), T1\'s next request carries it, no other session file has it',
  gone && next !== null && results[1]?.text === want && results[1].error && carried && others.length === 0,
  brief({ second: results[1], carried, others }));
}

/** @brief TB-34：Alt+2（本会话不再询问）之后这个实例与别的实例的同名工具都不再问。 */
async function approveSession(ctx, who, ids) {
  await pressInComposer(ctx, who.tab, 'Alt+2');
  const gone = await cardGone(ctx, who.tab, ids[2]);
  const cardE = await waitApprovalCard(ctx, who.tab, { agent: 'reviewer' }, 60000);
  ctx.flow.cardE = cardE;
  const menu = await permissionMenu(ctx, who.tab);
  const { requests, ends } = await teamApprovalEvents(ctx, who.sessionId);
  const endC = ends.find((item) => item.requestId === ids[2]);
  const t1 = resultTexts(ctx, who.sessionId, 't1.executor', 'bash');
  const t2 = resultTexts(ctx, who.sessionId, 't2.reviewer', 'bash');
  const bashCards = requests.filter((item) => item.toolName === 'bash').map((item) => item.requestId);
  record('TB-34 "Allow for this session" on a background card: the card ends allowed (by user), and later calls of '
    + 'the same tool no longer ask — T1\'s parallel "echo four", then "echo five", and another instance\'s (reviewer '
    + 'on T2) "echo six" all run without a card; only three bash cards were ever shown',
  gone && endC?.decision === 'allow' && ['three', 'four', 'five'].every((word) => t1.some((item) => !item.error
    && item.text.includes(word))) && t2.length === 1 && !t2[0].error && t2[0].text.includes('six')
    && same(bashCards, ids) && cardE?.tool === 'write', brief({ endC, t1, t2, bashCards, cardE }));
  record(`TB-34 the permission menu note reads "${PERMISSION_NOTE}"`, menu.note === PERMISSION_NOTE,
    brief(menu));
}

/** @brief TB-34：切到全部允许，挂着的卡按允许结束，之后（含新开的实例）不再出卡。 */
async function approveAll(ctx, who) {
  const cardE = ctx.flow.cardE;
  if (!cardE) throw new Error('the reviewer showed no write card');
  const at = Date.now();
  await allowAll(ctx, who.tab);
  const gone = await cardGone(ctx, who.tab, cardE.request);
  await settle(ctx, who, 90000);
  const { requests, ends } = await teamApprovalEvents(ctx, who.sessionId);
  const endE = ends.find((item) => item.requestId === cardE.request);
  const later = (await kernelEvents(ctx, who.sessionId, /approval_request$/, at)).map((item) => item.data.requestId);
  const t2 = resultTexts(ctx, who.sessionId, 't2.reviewer', 'write');
  const t3 = resultTexts(ctx, who.sessionId, 't3.executor', 'write');
  const board = readBoard(ctx, who.sessionId);
  record('TB-34 after switching to Allow all no instance shows a card: the pending reviewer write card ends allowed '
    + '(by all), the reviewer\'s next write and the new T3 instance\'s write run without a card, every task ends done',
  gone && endE?.decision === 'allow' && endE.by === 'all' && later.length === 0 && t2.length === 2
    && t2.every((item) => !item.error) && t3.length === 1 && !t3[0].error
    && board?.tasks.every((task) => task.status === 'done') && requestOf(board, 1)?.status === 'done',
  brief({ endE, later, t2, t3, tasks: taskBrief(board), cards: requests.length }));
}

// ---------- TB-35：Stop team（脚本 tb-stop-team） ----------

/**
 * @brief 布好停止前的样子（T1 批准卡、T2 交给结案在处理、T3 等 planner 的回复、T4 排在结案队列、第二条消息待判断），
 *        按 Stop team，检查停止的结果；之后交回 T3、撤销需求。
 */
async function teamStop(ctx) {
  const who = await begin(ctx, ctx.split, `Do several things ${tag('team')}`);
  ctx.flow.team = who;
  const sid = who.sessionId;
  const cardId = `${sid}.t1.executor:approval-1`;
  if (!(await waitCardId(ctx, who.tab, cardId, 40000))) throw new Error('T1 showed no card');
  const ready = await poll(() => findLine(ctx, 'tb-stop-team', { agent: 'planner', kind: 'close', k: 1 })
    && findLine(ctx, 'tb-stop-team', { agent: 'planner', kind: 'create', k: 2 }), 40000);
  const queued = await waitBoard(ctx, sid, (board) => taskOf(board, 'T2')?.holder?.kind === 'close'
    && taskOf(board, 'T4')?.holder?.kind === 'close', 40000);
  if (!ready || !queued || !(await waitReply(ctx, who, 'Planner registered it.'))) {
    throw new Error('the state before Stop team was not reached');
  }
  const msg2 = 'Also update the docs';
  await sendMessage(ctx, who.tab, msg2);
  const deciding = await poll(async () => (await liveInfo(ctx, who.sessionFile)).deciding.queue
    .some((item) => item.text === msg2), 10000);
  const before = readBoard(ctx, sid);
  const stopAt = Date.now();
  await clickStopTeam(ctx, who.tab);
  await settle(ctx, who, 30000);
  const obs = { before, stopAt, deciding, cardId, msg2, after: readBoard(ctx, sid),
    pane: await paneState(ctx.page, who.tab), info: await liveInfo(ctx, who.sessionFile) };
  await sleep(8000);
  obs.later = readBoard(ctx, sid);
  obs.lines = scenarioLines(ctx.ep, 'tb-stop-team', { since: stopAt + 300 });
  await teamStopChecks(ctx, who, obs);
  await teamStopIssue(ctx, who);
  await teamHandBack(ctx, who, obs);
}

/** @brief TB-35：Stop team 之后全部停下、批准按拒绝、消息回到输入框、等回复的以 Stopped by the user. 结束、task 停下。 */
async function teamStopChecks(ctx, who, obs) {
  const sid = who.sessionId;
  record('TB-35 Stop team stops every agent: right after it the session is not busy and nothing runs in the background '
    + '(TeamState busy and background false), the dialog is not sending (its pending bubble is gone), and no agent '
    + 'sends another request', !obs.info.team.busy && !obs.info.team.background && !obs.pane.running
    && !obs.pane.sending && !obs.pane.users.includes(obs.msg2) && obs.lines.length === 0,
  brief({ team: obs.info.team, pane: { running: obs.pane.running, sending: obs.pane.sending, users: obs.pane.users },
    lines: lineBrief(obs.lines) }));
  const end = (await teamApprovalEvents(ctx, sid)).ends.find((item) => item.requestId === obs.cardId);
  const bash = resultTexts(ctx, sid, 't1.executor', 'bash');
  const shown = await ctx.page.locator(cardSel(who.tab, obs.cardId)).count();
  record('TB-35 Stop team rejects the pending approvals: T1\'s card ends reject by stop and disappears, T1\'s bash '
    + `result is "${REJECTED_BY_STOP}"`, end?.decision === 'reject' && end.by === 'stop' && shown === 0
    && bash[0]?.text === REJECTED_BY_STOP, brief({ end, bash, shown }));
  record('TB-35 Stop team puts the deciding message back into the input box and empties the queue area',
    obs.deciding && obs.pane.draft === obs.msg2 && obs.pane.queue.length === 0 && obs.info.deciding.queue.length === 0,
    brief({ deciding: obs.deciding, draft: obs.pane.draft, queue: obs.pane.queue }));
  const asked = resultTexts(ctx, sid, 't3.reviewer', 'agent_message');
  // task 实例的每个工具结果开头都有证据编号 "[#n] "（§7.3），去掉它再比较。
  record(`TB-35 an agent_message waiting for a reply ends with "${STOPPED_BY_USER}" (T3 reviewer waiting for planner; `
    + 'an error result, after the evidence tag of §7.3)', asked.length === 1
    && asked[0].text.replace(/^\[#\d+\] /, '') === STOPPED_BY_USER && asked[0].error, brief({ asked }));
  const tasks = ['T1', 'T2', 'T3', 'T4'].map((id) => ({ id, before: taskOf(obs.before, id),
    after: taskOf(obs.after, id) }));
  record('TB-35 Stop team makes the running tasks and the tasks with close (T2 being processed, T4 queued) stopped '
    + 'with stopReason user and their holders kept (executor, close, reviewer, close)',
  tasks.every((item) => item.after?.status === 'stopped' && item.after.stopReason === 'user'
    && same(item.after.holder, item.before?.holder)) && same(tasks.map((item) => item.after?.holder?.kind),
    ['role', 'close', 'role', 'close']), brief(tasks.map((item) => ({ id: item.id, status: item.after?.status,
    stop: item.after?.stopReason, holder: item.after?.holder }))));
  const errors = obs.after.tasks.flatMap((task) => task.handoffs.filter((h) => h.reason === 'error')
    .map((h) => `${task.id}#${h.n}`));
  record('TB-35 Stop team writes no handoff with reason error (no run ended by the stop is treated as a failure)',
    errors.length === 0, brief({ errors, batons: taskBrief(obs.after) }));
  await teamStopQuiet(ctx, who, obs);
}

/** @brief TB-35：停止之后端点没有新的请求、不自动重新开始；结案与程序唤醒的立项没有后续动作，投递队列清空。 */
async function teamStopQuiet(ctx, who, obs) {
  record('TB-35 after Stop team the endpoint gets no new request (8 s) and nothing restarts by itself: the TaskBoard '
    + 'stays as the stop left it and the tasks stay stopped', obs.lines.length === 0 && same(obs.after, obs.later),
  brief({ lines: lineBrief(obs.lines), tasks: taskBrief(obs.later) }));
  const dropped = appLogLines(ctx, `${who.sessionId}.close.1: Stop team dropped a delivery`, obs.stopAt);
  const closeLater = obs.lines.filter((line) => line.agent === 'planner');
  record('TB-35 Stop team during a close run (T2) and a program-woken create run (agent_message from the reviewer): no '
    + 'forced fill, forced close or fallback delivery follows (no planner request after the stop), and the queued '
    + 'delivery of T4 to the close session is dropped (logged)', closeLater.length === 0 && dropped.length >= 1,
  brief({ dropped, closeLater: lineBrief(closeLater) }));
}

/** @brief TB-35：F8 的"最近的操作"记 Stop team。 */
async function teamStopIssue(ctx, who) {
  const report = await issueReport(ctx, who.tab, 'Stop team check');
  const lines = report.actions.filter((line) => line.endsWith(' Stop team'));
  record('TB-35 F8 records the click as "Stop team" in the recent actions', lines.length === 1,
    brief({ path: report.path, lines, tail: report.actions.slice(-4) }));
}

/** @brief TB-35：之后立项 task_edit 交回被停止的 T3，回到 reviewer 原来的会话；最后撤销需求。 */
async function teamHandBack(ctx, who, obs) {
  const sid = who.sessionId;
  const since = Date.now();
  await sendMessage(ctx, who.tab, 'Continue T3');
  await settle(ctx, who, 90000);
  const files = instanceFiles(ctx, sid).filter((file) => /\.t3\./.test(file.id)).map((file) => instanceSuffix(sid,
    file.id));
  const reviewer = instanceOf(ctx, sid, 't3.reviewer');
  const deliveries = reviewer ? messagesOf(reviewer.entries, 'user').length : 0;
  const line = findLine(ctx, 'tb-stop-team', { agent: 'reviewer', kind: 'task', task: 'T3', k: 2, since });
  const board = readBoard(ctx, sid);
  record('TB-35 after Stop team a task_edit hand-back continues the original session: T3 (stopped while the reviewer '
    + 'held it) goes back to the reviewer in the same t3.reviewer session (second delivery, k=2) and ends done',
  same(files, ['t3.reviewer']) && deliveries === 2 && line !== null && taskOf(board, 'T3')?.status === 'done'
    && taskOf(obs.after, 'T3')?.holder?.role === 'reviewer', brief({ files, deliveries, line: line && lineBrief([line]),
    t3: taskOf(board, 'T3')?.status }));
  await sendMessage(ctx, who.tab, 'Cancel it');
  await settle(ctx, who, 60000);
}

// ---------- TB-35：Esc（脚本 tb-stop-esc、tb-stop-escjudge、tb-stop-escmerged） ----------

/** @brief Esc 停止对话的回复：后台照常，排着的 request_closed 汇报在停止后开始。 */
async function escBackground(ctx) {
  const who = await begin(ctx, ctx.split, `Two jobs ${tag('esc')}`);
  const sid = who.sessionId;
  if (!(await waitReply(ctx, who, 'Planner registered two requests.'))) throw new Error('no first reply');
  await sendMessage(ctx, who.tab, 'Tell me a long story');
  if (!(await waitLine(ctx, 'tb-stop-esc', { agent: 'chat', kind: 'team-dialog', k: 2 }, 20000))) {
    throw new Error('the long reply did not start');
  }
  const closed = await waitBoard(ctx, sid, (board) => requestOf(board, 1)?.status === 'done', 30000);
  const replying = (await paneState(ctx.page, who.tab)).running;
  if (!closed || !replying) throw new Error(`request 1 closed ${Boolean(closed)}, replying ${replying}`);
  const t2Before = taskOf(closed, 'T2')?.status;
  const escAt = Date.now();
  await pressInComposer(ctx, who.tab, 'Escape');
  const report = await waitLine(ctx, 'tb-stop-esc', { agent: 'chat', kind: 'team-dialog', k: 3, since: escAt }, 20000);
  await settle(ctx, who, 90000);
  const pane = await paneState(ctx.page, who.tab);
  const board = readBoard(ctx, sid);
  const t2Late = findLine(ctx, 'tb-stop-esc', { agent: 'executor', kind: 'task', task: 'T2', j: 1, since: escAt });
  record('TB-35 Esc stops only the dialog\'s reply and the background goes on: the reply shows the v0 stopped line and '
    + 'its text never appears; T2 (running at Esc) sent its next request after Esc and ended done, request 2 closed '
    + 'and was reported (team-dialog k=4)', pane.stopped >= 1 && !pane.assistants.includes('A long story.')
    && t2Before === 'active' && t2Late !== null && taskOf(board, 'T2')?.status === 'done'
    && requestOf(board, 2)?.status === 'done' && pane.assistants.includes('Request 2 is done.'),
  brief({ stopped: pane.stopped, assistants: pane.assistants, t2Before, t2Late: Boolean(t2Late) }));
  const request = scenarioRequests(ctx.ep, 'tb-stop-esc', { agent: 'chat', kind: 'team-dialog', since: escAt })[0];
  const wakes = (await kernelEvents(ctx, sid, 'mori.wake', escAt)).map((item) => item.data.kind);
  record('TB-35 a request_closed report queued while the reply ran starts after Esc as usual: team-dialog k=3 came '
    + 'after the stop with the [Mori] report of request 1, mori.wake request_closed, and its reply is shown',
  report !== null && lastUserText(request).includes('[Mori]') && lastUserText(request).includes('Request 1')
    && wakes[0] === 'request_closed' && pane.assistants.includes('Request 1 is done.'),
  brief({ report: report && lineBrief([report]), last: oneLine(lastUserText(request), 200), wakes }));
}

/** @brief 对话回复中立项在判断第二条消息时按 Esc：两者都停，第二条回到输入框，没有新的回复。 */
async function escJudge(ctx) {
  const tab = await openSessionIn(ctx, ctx.split);
  await clickTeamSwitch(ctx, tab, 'always');
  const since = Date.now();
  await sendMessage(ctx, tab, `Start a long reply ${tag('escjudge')}`);
  const who = { tab, ...(await userSession(ctx, tab)), since };
  if (!(await waitLine(ctx, 'tb-stop-escjudge', { agent: 'chat', kind: 'team-dialog', k: 1 }, 30000))) {
    throw new Error('the reply did not start');
  }
  const msg2 = 'A second message';
  await sendMessage(ctx, tab, msg2);
  if (!(await waitLine(ctx, 'tb-stop-escjudge', { agent: 'planner', kind: 'create', k: 2 }, 20000))) {
    throw new Error('the create role did not start judging the second message');
  }
  const escAt = Date.now();
  await pressInComposer(ctx, tab, 'Escape');
  await settle(ctx, who, 30000);
  await sleep(6000);
  const pane = await paneState(ctx.page, tab);
  const info = await liveInfo(ctx, who.sessionFile);
  const after = scenarioLines(ctx.ep, 'tb-stop-escjudge', { since: escAt + 300 });
  record('TB-35 Esc while the create role judges a second message during the reply stops the reply and that '
    + 'judgment: the second message is back in the input box, nothing is deciding, and no new reply or judgment starts '
    + '(no request in 6 s)', pane.stopped >= 1 && pane.draft === msg2 && info.deciding.queue.length === 0
    && after.length === 0 && !pane.assistants.includes('A long reply.') && !info.team.busy,
  brief({ stopped: pane.stopped, draft: pane.draft, deciding: info.deciding, after: lineBrief(after) }));
  await clickTeamSwitch(ctx, tab, 'off');
}

/** @brief 合并会话里 Esc：排着的 need_user 投递（create_wake）在停止后照常开始。 */
async function escMerged(ctx) {
  const who = await begin(ctx, ctx.merged, `Summarize a part ${tag('escmerged')}`);
  const sid = who.sessionId;
  if (!(await waitReply(ctx, who, 'Registered request 1.'))) throw new Error('no first reply');
  await sendMessage(ctx, who.tab, 'Tell me something long');
  if (!(await waitLine(ctx, 'tb-stop-escmerged', { agent: 'mori', kind: 'merged-create', k: 2 }, 20000))) {
    throw new Error('the long reply did not start');
  }
  const waiting = await waitBoard(ctx, sid, (board) => taskOf(board, 'T1')?.status === 'waiting_user', 30000);
  const replying = (await paneState(ctx.page, who.tab)).running;
  if (!waiting || !replying) throw new Error(`T1 waiting ${Boolean(waiting)}, replying ${replying}`);
  const escAt = Date.now();
  await pressInComposer(ctx, who.tab, 'Escape');
  const line = await waitLine(ctx, 'tb-stop-escmerged', { agent: 'mori', kind: 'merged-create', k: 3, since: escAt },
    20000);
  await settle(ctx, who, 60000);
  const request = scenarioRequests(ctx.ep, 'tb-stop-escmerged', { agent: 'mori', since: escAt })[0];
  const wakes = (await kernelEvents(ctx, sid, 'mori.wake', escAt)).map((item) => item.data.kind);
  const pane = await paneState(ctx.page, who.tab);
  record('TB-35 merged session: a need_user delivery queued while the reply ran starts after Esc as usual — the reply '
    + 'shows the stopped line, then merged-create k=3 carries "[Mori] T1 needs a decision…" (mori.wake create_wake) '
    + 'and its reply asks you', pane.stopped >= 1 && line !== null && wakes[0] === 'create_wake'
    && lastUserText(request).includes('[Mori] T1 needs a decision')
    && pane.assistants.includes('T1 needs your decision: which part?'),
  brief({ line: line && lineBrief([line]), wakes, last: oneLine(lastUserText(request), 200) }));
}

// ---------- TB-36：界面重新载入（脚本 tb-stop-reload）；TB-34 没在中栏显示的会话的侧栏状态 ----------

/** @brief T1 的卡挂着、第二条消息待判断时重新载入界面；侧栏、接上与后台照常。 */
async function reloadStep(ctx) {
  const who = await begin(ctx, ctx.split, `Reload job ${tag('reload')}`);
  const sid = who.sessionId;
  const ids = [1, 2].map((n) => `${sid}.t1.executor:approval-${n}`);
  if (!(await waitCardId(ctx, who.tab, ids[0], 40000))) throw new Error('T1 showed no card');
  if (!(await waitReply(ctx, who, 'Planner registered it.'))) throw new Error('no first reply');
  const msg2 = 'A question for after the reload';
  await sendMessage(ctx, who.tab, msg2);
  if (!(await waitLine(ctx, 'tb-stop-reload', { agent: 'planner', kind: 'create', k: 2 }, 20000))) {
    throw new Error('the create role did not start judging');
  }
  await collectApprovals(ctx);
  const reloadAt = Date.now();
  await reloadUi(ctx);
  await reloadSidebar(ctx, who, ids);
  who.tab = await reopenSession(ctx, who.sessionFile);
  const card = await waitCardId(ctx, who.tab, ids[1], 10000);
  const row = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'approval' }, 10000);
  const blocks = await progressOf(ctx, who.tab);
  const queue = await decidingItems(ctx, who.tab);
  record('TB-36 after a UI reload (Ctrl+R) the session reconnects: the TaskBoard (progress summary of request 1, T1 '
    + '"Waiting for your approval"), the deciding message in the queue area ("Waiting for planner" with its text) and '
    + 'the pending background card with its header line "executor · T1 · Reload job"',
  card?.attribution === 'executor · T1 · Reload job' && row === 'T1 Reload job · executor · Waiting for your approval'
    && blocks.some((block) => block.request === 1) && queue.length === 1 && queue[0].includes('Waiting for planner')
    && queue[0].includes(msg2), brief({ card, row, blocks: blocks.map((b) => b.title), queue }));
  await pressInComposer(ctx, who.tab, 'Alt+1');
  await settle(ctx, who, 90000);
  await reloadBackground(ctx, who, reloadAt, msg2);
}

/** @brief TB-34：重新载入后没点开的会话，侧栏按后台进程的状态显示等你批准；一张卡结束、下一张到来都跟着变。 */
async function reloadSidebar(ctx, who, ids) {
  const untabbed = await rowStatus(ctx, who.sessionFile);
  // synthetic：这个会话没在中栏显示，界面上没有这张卡可点；经进程桥回答（与卡上的"允许一次"是同一条命令）。
  const answered = await tryBridge(ctx, { type: 'approval.answer', sessionId: who.sessionId, requestId: ids[0],
    decision: 'allow' });
  const cleared = await poll(async () => {
    const status = await rowStatus(ctx, who.sessionFile);
    return status !== 'approval' ? status : null;
  }, 10000);
  const again = await poll(async () => (await rowStatus(ctx, who.sessionFile)) === 'approval', 20000);
  record('TB-34 the sidebar shows waiting-for-approval for a session that is not open in a tab (after a UI reload): '
    + 'approval while T1\'s card is pending, not approval (still generating) once that card ended, approval again when '
    + 'T1\'s next card arrives', untabbed === 'approval' && answered.error === null && cleared === 'running' && again,
  brief({ untabbed, answered: answered.error, cleared, again }));
}

/** @brief TB-36：重新载入时在运行的判断与 task 照常做完。 */
async function reloadBackground(ctx, who, reloadAt, msg2) {
  const sid = who.sessionId;
  const judged = scenarioLines(ctx.ep, 'tb-stop-reload', { agent: 'planner', kind: 'create' })
    .filter((line) => String(line.k) === '2');
  const reply = findLine(ctx, 'tb-stop-reload', { agent: 'chat', kind: 'team-dialog', k: 2, since: reloadAt });
  const request = scenarioRequests(ctx.ep, 'tb-stop-reload', { agent: 'chat', kind: 'team-dialog',
    since: reloadAt })[0];
  const pane = await paneState(ctx.page, who.tab);
  const board = readBoard(ctx, sid);
  record('TB-36 after a UI reload the background keeps running: the judgment that was running finished without '
    + 'starting again (one planner request for it, sent before the reload), the dialog then answered the deciding '
    + 'message ("Answered after the reload."), T1 ran its command and request 1 closed and was reported',
  judged.length === 1 && judged[0].t < reloadAt && reply !== null && lastUserText(request).includes(msg2)
    && pane.assistants.includes('Answered after the reload.') && taskOf(board, 'T1')?.status === 'done'
    && requestOf(board, 1)?.status === 'done' && pane.assistants.includes('Request 1 is done.'),
  brief({ judged: lineBrief(judged), reply: Boolean(reply), assistants: pane.assistants, tasks: taskBrief(board) }));
}

// ---------- TB-42：归档、删除与关闭（脚本 tb-stop-del） ----------

/** @brief 只有后台在运行、有待判断的消息时不能归档删除（后台进程同样拒绝）；Stop team 之后删除，实例一起关闭。 */
async function deleteStep(ctx) {
  const who = await begin(ctx, ctx.del, `Background job ${tag('del')}`);
  const sid = who.sessionId;
  if (!(await waitLine(ctx, 'tb-stop-del', { agent: 'executor', kind: 'task', task: 'T1' }, 40000))
    || !(await waitReply(ctx, who, 'Planner registered it.'))) throw new Error('the background did not start');
  const background = await liveInfo(ctx, who.sessionFile);
  const menu1 = await rowMenuItems(ctx, who.sessionFile);
  const close1 = await tryBridge(ctx, { type: 'session.close', sessionId: sid });
  const msg2 = 'One more thing';
  await sendMessage(ctx, who.tab, msg2);
  if (!(await waitLine(ctx, 'tb-stop-del', { agent: 'planner', kind: 'create', k: 2 }, 20000))) {
    throw new Error('the create role did not start judging');
  }
  const deciding = (await liveInfo(ctx, who.sessionFile)).deciding;
  const menu2 = await rowMenuItems(ctx, who.sessionFile);
  const close2 = await tryBridge(ctx, { type: 'session.close', sessionId: sid });
  record('TB-42 while only the background runs (dialog idle, T1 running) the session cannot be archived or deleted '
    + '(both menu items disabled, "正在生成"), and the kernel\'s session.close refuses it',
  background.team.background && !background.live?.running && removalBlocked(menu1)
    && close1.error?.includes(GENERATING), brief({ team: background.team, menu1, close1: close1.error }));
  record('TB-42 while a message is deciding the session cannot be archived or deleted, and session.close refuses it',
    deciding.queue.some((item) => item.text === msg2) && removalBlocked(menu2) && close2.error?.includes(GENERATING),
    brief({ deciding, menu2, close2: close2.error }));
  await clickStopTeam(ctx, who.tab);
  await settle(ctx, who, 30000);
  await deleteAndCheck(ctx, who);
}

/** @brief TB-42：删除（菜单 → 确认）：会话文件与 teams/<id> 都删掉，实例会话随用户会话一起关闭。 */
async function deleteAndCheck(ctx, who) {
  const sid = who.sessionId;
  const open = ['t1.executor', 'create'].map((suffix) => `${sid}.${suffix}`);
  const files = instanceFiles(ctx, sid).map((file) => file.id);
  const menu = await rowMenuItems(ctx, who.sessionFile);
  const deleteAt = Date.now();
  const row = ctx.page.locator(`.session-item[data-file=${JSON.stringify(who.sessionFile)}]`).first();
  await row.click({ button: 'right', position: { x: 40, y: 10 } });
  await ctx.page.getByTestId('session-menu').getByRole('menuitem', { name: '删除' }).click();
  await ctx.page.getByTestId('delete-dialog').getByRole('button', { name: '删除', exact: true }).click();
  await row.waitFor({ state: 'detached', timeout: 20000 });
  const probe = existsSync(ctx.probeLog) ? readJsonl(ctx.probeLog) : [];
  const shut = probe.filter((item) => item.t >= deleteAt).map((item) => item.id);
  const enabled = ['归档', '删除'].every((label) => menu.find((item) => item.label === label)?.disabled === false);
  record('TB-42 closing a session closes its instance sessions: deleting it after Stop team released the open T1 '
    + 'executor and create instances (session_shutdown) together with the user session',
  enabled && open.every((id) => files.includes(id) && shut.includes(id)) && shut.includes(sid),
  brief({ enabled, files, shut }));
  record('TB-42 deleting the session also deletes <userData>/teams/<id> (board.json and the instance sessions)',
    !existsSync(who.sessionFile) && !existsSync(teamDir(ctx, sid)) && files.length >= 2,
    brief({ file: existsSync(who.sessionFile), team: existsSync(teamDir(ctx, sid)) }));
}

// ---------- TB-36：重启（脚本 tb-stop-r1 … r4，最后一步） ----------

/** @brief 布好四个会话（R1–R4），删掉 review 项目的 reviewer.md，有序退出 App 再用同一个数据目录启动。 */
async function restartStep(ctx) {
  const r = await restartSetup(ctx);
  const before = Object.fromEntries(Object.entries(r).map(([key, who]) => [key, readBoard(ctx, who.sessionId)]));
  const prior = { receipts: await receiptsOf(ctx, r.r1.tab), progress: await progressOf(ctx, r.r1.tab),
    r4Progress: customOf(readJsonl(r.r4.sessionFile), 'mori.progress').length };
  rmSync(join(ctx.review, '.mori', 'agents', 'reviewer.md'));
  await collectApprovals(ctx);
  const closeAt = Date.now();
  await closeTbApp(ctx);
  const exited = Object.fromEntries(Object.entries(r).map(([key, who]) => [key, readBoard(ctx, who.sessionId)]));
  const during = ['r1', 'r2', 'r3', 'r4'].flatMap((key) => scenarioLines(ctx.ep, `tb-stop-${key}`, { since: closeAt }));
  await startApp(ctx);
  const changed = Object.keys(r).filter((key) => !same(taskBrief(before[key]), taskBrief(exited[key])));
  record('TB-36 an orderly exit leaves the TaskBoards as they were for the restart: no task was handed on, stopped or '
    + 'given a baton by the exit (status, holder and batons in board.json unchanged in all four sessions), and no '
    + 'agent sent a request while Mori was closing', changed.length === 0 && during.length === 0,
  brief({ changed: changed.map((key) => ({ key, before: taskBrief(before[key]), after: taskBrief(exited[key]) })),
    during: lineBrief(during) }));
  await restartR1(ctx, r.r1, before.r1, prior);
  await restartR2(ctx, r.r2, before.r2);
  await restartR3(ctx, r.r3, before.r3);
  await restartR4(ctx, r.r4, prior);
}

/** @brief 四个会话各到退出前要的样子。 */
async function restartSetup(ctx) {
  const r = {};
  r.r1 = await begin(ctx, ctx.split, `Restart job ${tag('r1')}`);
  const card = await waitCardId(ctx, r.r1.tab, `${r.r1.sessionId}.t1.executor:approval-1`, 40000);
  const close1 = await waitLine(ctx, 'tb-stop-r1', { agent: 'planner', kind: 'close', k: 1 }, 30000);
  if (!card || !close1 || !(await waitReply(ctx, r.r1, 'Planner registered it.'))) throw new Error('R1 not ready');
  r.r2 = await begin(ctx, ctx.split, `Ended job ${tag('r2')}`);
  const close2 = await waitLine(ctx, 'tb-stop-r2', { agent: 'planner', kind: 'close', k: 1, j: 1 }, 40000);
  if (!close2 || !(await waitReply(ctx, r.r2, 'Planner registered it.'))) throw new Error('R2 not ready');
  r.r3 = await begin(ctx, ctx.review, `Review job ${tag('r3')}`);
  const review = await waitLine(ctx, 'tb-stop-r3', { agent: 'reviewer', kind: 'task', task: 'T1' }, 40000);
  if (!review || !(await waitReply(ctx, r.r3, 'Planner registered it.'))) throw new Error('R3 not ready');
  r.r4 = await begin(ctx, ctx.merged, `Registered then exit ${tag('r4')}`);
  const waiting = await waitLine(ctx, 'tb-stop-r4', { agent: 'mori', kind: 'merged-create', k: 1, j: 1 }, 30000);
  if (!waiting) throw new Error('R4 not ready');
  await showTab(ctx, r.r1.tab);
  await sleep(1000);
  return r;
}

/** @brief TB-36 R1：非终态的 task 为 Stopped (Mori restarted)、批准作废、回执与进展摘要都在；交回交给结案的 T2 唤醒结案。 */
async function restartR1(ctx, who, before, prior) {
  const sid = who.sessionId;
  who.tab = await reopenSession(ctx, who.sessionFile);
  const t1 = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'stopped_restart' }, 20000);
  const t2 = await waitTaskPhase(ctx, who.tab, { task: 'T2', phase: 'stopped_restart' }, 5000);
  const cards = await approvalCardsOf(ctx, who.tab);
  const info = await liveInfo(ctx, who.sessionFile);
  const receipts = await receiptsOf(ctx, who.tab);
  const blocks = await progressOf(ctx, who.tab);
  const board = readBoard(ctx, sid);
  const stopped = ['T1', 'T2'].map((id) => taskOf(board, id));
  record(`TB-36 after a restart the non-terminal tasks are stopped (stopReason restart, holders kept: T1 executor, T2 `
    + `with close) and read "${RESTARTED}"; the approval pending at the exit is void (no card, no teamApprovals); the `
    + 'receipt and the progress summary are there as before', Boolean(t1?.includes(RESTARTED))
    && Boolean(t2?.includes(RESTARTED)) && stopped.every((task, i) => task?.status === 'stopped'
      && task.stopReason === 'restart' && same(task.holder, taskOf(before, `T${i + 1}`)?.holder))
    && cards.length === 0 && info.teamApprovals.length === 0 && same(receipts, prior.receipts)
    && blocks.length === prior.progress.length && blocks[0]?.request === 1,
  brief({ t1, t2, stopped: taskBrief(board), cards, approvals: info.teamApprovals, receipts, blocks: blocks.map((b) =>
    b.title) }));
  const since = Date.now();
  await sendMessage(ctx, who.tab, 'Continue T2');
  await settle(ctx, who, 60000);
  const close = findLine(ctx, 'tb-stop-r1', { agent: 'planner', kind: 'close', k: 2, since });
  const request = scenarioRequests(ctx.ep, 'tb-stop-r1', { agent: 'planner', kind: 'close', since })[0];
  const closes = instanceFiles(ctx, sid).filter((file) => instanceSuffix(sid, file.id).startsWith('close.'));
  record('TB-36 after a restart, handing back a task held by close (T2) wakes the close session: close.1 continues '
    + '(k=2, its delivery names T2) and closes T2 as done',
  close !== null && lastUserText(request).includes('T2') && closes.length === 1
    && taskOf(readBoard(ctx, sid), 'T2')?.status === 'done', brief({ close: close && lineBrief([close]),
    closes: closes.map((file) => file.id), last: oneLine(lastUserText(request), 200) }));
}

/** @brief TB-36 R2：全部结束而没关闭的需求在下一条消息时唤醒结案。 */
async function restartR2(ctx, who, before) {
  const sid = who.sessionId;
  who.tab = await reopenSession(ctx, who.sessionFile);
  const since = Date.now();
  await sendMessage(ctx, who.tab, 'Any news?');
  await settle(ctx, who, 60000);
  const close = findLine(ctx, 'tb-stop-r2', { agent: 'planner', kind: 'close', k: 2, since });
  const board = readBoard(ctx, sid);
  const pane = await paneState(ctx.page, who.tab);
  record('TB-36 a request whose tasks all ended but that was still open at the exit wakes its close session at your '
    + 'next message after the restart: close.1 runs again (k=2) and closes request 1, which is reported',
  taskOf(before, 'T1')?.status === 'done' && requestOf(before, 1)?.status === 'open' && close !== null
    && requestOf(board, 1)?.status === 'done' && pane.assistants.includes('Request 1 is done.'),
  brief({ before: requestOf(before, 1)?.status, close: close && lineBrief([close]), after: requestOf(board, 1)?.status,
    assistants: pane.assistants }));
}

/** @brief TB-36 R3：重启前删掉 reviewer.md，holder 为 reviewer 的 T1 交回时交给结案。 */
async function restartR3(ctx, who, before) {
  const sid = who.sessionId;
  who.tab = await reopenSession(ctx, who.sessionFile);
  const reopened = taskOf(readBoard(ctx, sid), 'T1');
  const since = Date.now();
  await sendMessage(ctx, who.tab, 'Continue T1');
  await settle(ctx, who, 60000);
  const close = findLine(ctx, 'tb-stop-r3', { agent: 'planner', kind: 'close', k: 1, since });
  const request = scenarioRequests(ctx.ep, 'tb-stop-r3', { agent: 'planner', kind: 'close', since })[0];
  const reviewer = scenarioLines(ctx.ep, 'tb-stop-r3', { agent: 'reviewer', since });
  const board = readBoard(ctx, sid);
  record('TB-36 with reviewer.md deleted before the restart, the task the reviewer held is stopped with holder close '
    + '("role reviewer no longer exists") and handing it back sends it to the close session (no reviewer request); '
    + 'close closes T1 and the request', taskOf(before, 'T1')?.holder?.role === 'reviewer'
    && reopened?.status === 'stopped' && reopened.stopReason === 'restart' && reopened.holder?.kind === 'close'
    && reopened.holderReason === 'role reviewer no longer exists' && close !== null
    && lastUserText(request).includes('T1') && reviewer.length === 0 && taskOf(board, 'T1')?.status === 'done',
  brief({ reopened: reopened && { status: reopened.status, holder: reopened.holder, reason: reopened.holderReason },
    close: close && lineBrief([close]), reviewer: lineBrief(reviewer) }));
}

/** @brief TB-36 R4：登记之后 App 退出的需求，重新打开时在对话流末尾补写进展摘要。 */
async function restartR4(ctx, who, prior) {
  who.tab = await reopenSession(ctx, who.sessionFile);
  await poll(async () => (await progressOf(ctx, who.tab)).length > 0, 10000);
  const entries = readJsonl(who.sessionFile).slice(1);
  const receiptAt = entries.findIndex((entry) => entry.type === 'custom' && entry.customType === 'mori.receipt');
  const progressAt = entries.findIndex((entry) => entry.type === 'custom' && entry.customType === 'mori.progress');
  const items = await transcriptItems(ctx, who.tab);
  const last = items.at(-1);
  record('TB-36 a request registered right before the App exited (no mori.progress yet) gets its progress summary '
    + 'written on reopening: the session file has a mori.progress for request 1 after the receipt and the last item of '
    + 'the conversation is that summary', prior.r4Progress === 0 && receiptAt >= 0 && progressAt > receiptAt
    && entries[progressAt].data?.request === 1 && last?.kind === 'progress' && last.request === 1,
  brief({ prior: prior.r4Progress, receiptAt, progressAt, last }));
}

// ---------- 整个套件的检查 ----------

/** @brief TB-34：TaskBoard 工具从不出卡（整个套件，权限都是"每次询问"时调用的）；端点没有多出来的请求。 */
async function finalChecks(ctx) {
  await collectApprovals(ctx);
  const tools = [...ctx.approvalSeen.values()];
  const teamCalls = ctx.ep.logs.filter((line) => !line.probe && line.scenario?.startsWith('tb-stop-'))
    .flatMap((line) => line.calls ?? []).filter((name) => TEAM_TOOLS.includes(name));
  record('TB-34 TaskBoard tools never show an approval card: across the suite (Ask each time) every approval request '
    + 'was for a v0 tool that needs approval, none for the TaskBoard tools that were called',
  tools.length >= 8 && !tools.some((name) => TEAM_TOOLS.includes(name) || name === 'read')
    && new Set(teamCalls).size >= 8, brief({ approvals: [...new Set(tools)], teamCalls: [...new Set(teamCalls)],
    count: teamCalls.length }));
  const missing = missingSteps(ctx.ep);
  record('stop: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
}

// ---------- 主流程 ----------

const steps = { approve, team: teamStop, esc: escBackground, escjudge: escJudge, escmerged: escMerged,
  reload: reloadStep, del: deleteStep, restart: restartStep };

const ctx = { userData: tempUserData('mori-tb-stop-data-'), exePath: args.exePath, flow: {}, pageErrors: [],
  approvalSeen: new Map() };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-stop] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: flow`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
    await collectApprovals(ctx);
  }
  await finalChecks(ctx);
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-stop] data in ${ctx.userData}; projects ${ctx.split}, ${ctx.review}, ${ctx.merged}, ${ctx.del}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
