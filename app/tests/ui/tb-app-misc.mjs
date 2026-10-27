// 平行 Agent 与 TaskBoard 的 App 套件：工作卡、工具卡标题、右栏（docs/specs/parallel-agents-taskboard.md §17.2）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/misc.mjs，synthetic），
// 逐条验收这些编号在 App 层的通过条件：
//   TB-30 工作卡（§8.3：每次请求末尾单独一条、不写进会话文件、压缩之后仍在、换模型重发时仍在最后、超出上限时按顺序压缩且
//         用户补充一条不少；另核对各种会话卡片的固定第一行）、
//   TB-55 工具卡标题（§13.8：合并会话的对话流里的工具卡，含三种 agent_message；进展摘要 task 行的当前在做什么）、
//   TB-57 右栏与后台改动（文件系统第 2 步改写，docs/specs/file-system.md §5.3、§19.4，FS-14：task 改过文件后 This session
//         列出它们、标出 Agent，没有 “Changes made by team tasks aren’t listed here.”；没有 TaskBoard 时对话自己的改动同样
//         列出；重启后从会话文件读出相同的轮），另加 FS-12 的一项：有 [Mori] 投递时会话引用芯片的 turns a–b、预览的
//         Turn N 与 This session 的组编号指同一条消息。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs misc）：
//   MORI_APP_DIR=.tb-runs/misc node tests/ui/tb-app-misc.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-misc(-packaged).json（--only 时 tb-partial-app-misc…），截图在 test-results/tb-app-misc/。
// 端口（§17.1 的 4600–4699 里分给本套件的 4670–4679）：合成端点 4670，记录代理 4671（看完整的请求体）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好三个本机提供商（写入等级 A、能关思考，跳过探针）：
// tbm（默认范围）、tbs（换模型用的六个模型）、tbk（窗口 32000 的小模型，压缩用）；pi 的 compaction 设为
// reserveTokens 16000、keepRecentTokens 300（只有 tbk 的会话会到阈值）；六个临时项目各自的角色文件见 setup。
// 同一时间只开一个 App；restart 一步最后跑：重启 App，重新打开前面的会话，比较工具卡标题与右栏。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MISC_TEXT } from '../fake-endpoint/scenarios/misc.mjs';
import {
  allowAll, appLogLines, brief, closeTbApp, contentText, customOf, instanceFiles, missingSteps, openSessionIn, paneSel,
  paneState, phasesOf, poll, readBoard, readJsonl, reopenSession, restartTbApp, scenarioLines, scenarioRequests,
  seedTeamUserData, sendMessage, shot, showTab, SPLIT_ROLES, startTbApp, startTbEndpoint, stopTbEndpoint, suiteArgs,
  tbModel, tbProvider, tbRecorder, tempProject, tempUserData, toolCardsOf, userSession, waitReceipt, waitTeamIdle,
  watchTaskPhases, writeRoles,
} from './tb-helpers.mjs';

const args = suiteArgs('misc');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4670;
const PROXY = 4671;
/** 合成端点上的模型（synthetic）：默认范围、换模型用的六个、压缩用的小窗口模型 */
const MAIN = 'fake-coder-tbmisc';
const SWITCH_MODELS = ['fake-swa', 'fake-swb', 'fake-swc', 'fake-ta', 'fake-tb', 'fake-tc'];
const COMPACT_MODEL = 'fake-cmp';
/** 工作卡的首尾行（§8.3） */
const CARD_OPEN = '<mori-work-card>';
const CARD_CLOSE = '</mori-work-card>';
/** 工作卡的上限（§8.3、§15） */
const CARD_LIMIT = 8000;
/**
 * 一定有工作卡的会话种类（scripts.mjs 认出的种类）与关闭模式的对话：后者没有卡，TaskBoard 上有需求时只带关闭模式的卡
 * （§8.3，2026-10-26 M22）
 */
const CARD_KINDS = ['task', 'close', 'create', 'team-dialog', 'merged-create', 'subscription'];
const OFF_KINDS = ['dialog', 'off-dialog'];
/** pi 压缩请求的系统提示开头（replies.mjs SUMMARY_SYSTEM）与压缩之后第一条消息的开头 */
const SUMMARY_SYSTEM = 'You are a context summarization assistant.';
const COMPACTED = 'The conversation history before this point was compacted';
/**
 * 右栏里不再出现的一句（2026-10-26 改的写法“Changes made by other agents aren’t listed here.”，文件系统第 2 步删掉，
 * docs/specs/file-system.md §5.1；docs/v1/walkthrough-1026-checks.md 的 U57）与 This session 没有记录时的一行（§5.3）
 */
const TEAM_NOTE = 'Changes made by other agents aren’t listed here.';
const V0_NOTE = 'Only edits and writes are listed. Files changed by commands aren’t included.';
const NO_CHANGES = 'No changes yet.';
const RIGHT_TOGGLE = 'button[aria-label="Toggle changes"]';
/** T1（executor）改的文件在 This session 文件行上的 Agent（fs-changes.md "文件行上的 Agent"：<role> (<task>)） */
const T1_AGENT = 'executor (T1)';
/** 等一段改动记进用户会话（结束快照做完、mori.turn_changes 到达）的最长时间 */
const RECORD_WAIT = 15000;
/** tb-misc-changes 里你的两条消息：第一条（/task 发出）让 T1 改 README.md，需求关闭后第二条让对话自己写 notes.txt */
const CHANGES_ASK = 'Edit the README tb-scenario:tb-misc-changes';
const NOTES_ASK = 'Write the notes file';
/** §13.8 的标题：tb-misc-titles 对话流里的工具卡、T1 那一行，tb-misc-titles2 的工具卡 */
const TITLES_CARDS = ['Register a request', 'Create a task', 'Read the board', 'Read request 1', 'Read T1',
  'Read executor’s work on T1', 'Message T1', 'Ask executor', 'Message closer'];
const TITLES_ROWS = ['Read the board', 'Read request 1', 'Read T1', 'Read executor’s work on T1', 'Ask reviewer',
  'Message closer', 'Message T1', 'Hand off T1'];
const TITLES2_CARDS = ['Register a request', 'Create a task', 'Add to request 1', 'Edit T1', 'Answer directly',
  'Cancel request 1'];

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 消息的文字。 */
const textOf = (message) => contentText(message?.content);
/** @brief 整条消息就是一张工作卡（user 角色，去掉首尾空白后以首行开始、以末行结束）。 */
const isCardMessage = (m) => m?.role === 'user' && textOf(m).trim().startsWith(CARD_OPEN)
  && textOf(m).trim().endsWith(CARD_CLOSE);
/** @brief 是否 pi 的压缩（摘要）请求。 */
const isSummary = (item) => item.system.includes(SUMMARY_SYSTEM);

/**
 * @brief 一个请求里的工作卡：{ count（含卡片首行的非 system 消息数；共用段在 system 里提到 <mori-work-card>，不算）,
 *        last（最后一条消息整条就是卡）, text（最后一条的卡片全文） }。
 * @param item scenarioRequests 的一项
 */
function cardOf(item) {
  const count = item.messages.filter((m) => m.role !== 'system' && m.role !== 'developer'
    && textOf(m).includes(CARD_OPEN)).length;
  const lastMessage = item.messages.at(-1);
  const last = isCardMessage(lastMessage);
  return { count, last, text: last ? textOf(lastMessage).trim() : null };
}

/** @brief 本套件全部场景的对话请求（不含压缩请求）。 */
const miscRequests = (ctx) => scenarioRequests(ctx.ep, null)
  .filter((item) => item.info.scenario?.startsWith('tb-misc-') && !isSummary(item));

// ---------- 准备与会话 ----------

/** @brief 测试准备（synthetic test setup）：六个临时项目与角色文件、数据目录、合成端点。 */
async function setup(ctx) {
  ctx.titles = tempProject('mori-tb-misc-titles-');
  writeRoles(ctx.titles, [
    { name: 'lead', description: 'Talks with the user and decides what each message needs',
      seats: ['dialog', 'create'] },
    { name: 'closer', description: 'Checks returned tasks and closes each request', seats: ['close'] },
    { name: 'executor', description: 'Does the work of a task' },
    { name: 'reviewer', description: 'Checks the work of another role' }]);
  ctx.split = tempProject('mori-tb-misc-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  ctx.plain = tempProject('mori-tb-misc-plain-');
  const lead = { name: 'lead', description: 'Talks with the user, decides and closes',
    seats: ['dialog', 'create', 'close'] };
  ctx.over = tempProject('mori-tb-misc-over-');
  writeRoles(ctx.over, [lead, { name: 'executor', description: 'Does the work of a task' },
    { name: 'reviewer', description: 'Checks the work of another role' }]);
  ctx.switch = tempProject('mori-tb-misc-switch-');
  writeRoles(ctx.switch, [{ ...lead, models: SWITCH_MODELS.slice(0, 3).map((id) => `tbs/${id}`) },
    { name: 'executor', description: 'Does the work of a task',
      models: SWITCH_MODELS.slice(3).map((id) => `tbs/${id}`) }]);
  ctx.compact = tempProject('mori-tb-misc-compact-');
  writeRoles(ctx.compact, [{ ...lead, models: [`tbk/${COMPACT_MODEL}`] }]);
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  // synthetic test setup：压缩只保留最近约 300 token；窗口 32000 的 tbk 在上下文超过 16000 token 时压缩。
  seedTeamUserData(ctx.userData, {
    providers: [tbProvider('tbm', PROXY, [tbModel(MAIN)]),
      tbProvider('tbs', PROXY, SWITCH_MODELS.map((id) => tbModel(id))),
      tbProvider('tbk', PROXY, [tbModel(COMPACT_MODEL, { contextWindow: 32000, maxTokens: 4000 })])],
    piSettings: { compaction: { reserveTokens: 16000, keepRecentTokens: 300 } },
  });
  await startApp(ctx);
}

/** @brief 启动 App，装上 task 行的记录。 */
async function startApp(ctx) {
  await startTbApp(ctx);
  await watchTaskPhases(ctx);
}

/**
 * @brief 在 project 里开一个新会话（可先切到全部允许），发第一条消息；返回 { tab, sessionId, sessionFile, since }，
 *        并记进 ctx.watched（会话文件的检查）。
 */
async function begin(ctx, project, text, { team = true, allow = false } = {}) {
  const tab = await openSessionIn(ctx, project);
  if (allow) await allowAll(ctx, tab);
  const since = Date.now();
  await sendMessage(ctx, tab, text, { team });
  const who = { tab, ...(await userSession(ctx, tab)), since };
  ctx.watched.set(who.sessionId, who);
  return who;
}

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/** @brief 等这个会话面板里对话不在运行、不在发送（后台可以还在跑）。 */
async function dialogIdle(ctx, who, timeout = 60000) {
  const idle = await poll(async () => {
    const pane = await paneState(ctx.page, who.tab);
    return pane && !pane.running && !pane.sending;
  }, timeout, 100);
  if (!idle) throw new Error(`the dialog of ${who.tab} did not become idle`);
}

/**
 * @brief 等端点收到某个会话第 k 次投递的请求；超时时报错。
 * @param options j：第几步（不给时任意一步）；timeout：最多等多久（ms）
 */
async function waitRequest(ctx, scenario, where, k, { j = null, timeout = 90000 } = {}) {
  const seen = await poll(() => scenarioLines(ctx.ep, scenario, where)
    .some((line) => line.k === k && (j === null || line.j === j)), timeout, 100);
  if (!seen) throw new Error(`no request ${scenario} ${JSON.stringify(where)} k=${k} j=${j}`);
}

/** @brief 对话流里工具卡的标题（按顺序）。 */
const cardTitles = async (ctx, who) => (await toolCardsOf(ctx, who.tab)).map((card) => card.title);

// ---------- TB-55：工具卡标题 ----------

/** @brief 合并会话（tb-misc-titles）：对话流里的工具卡与 T1 那一行的标题，模式回到 off 之后不变。 */
async function titles(ctx) {
  const who = await begin(ctx, ctx.titles, 'Check the notes tb-scenario:tb-misc-titles');
  ctx.misc.titles = who;
  if (!(await waitReceipt(ctx, who.tab, { kind: 'registered', request: 1 }))) throw new Error('no receipt');
  await dialogIdle(ctx, who);
  const during = await cardTitles(ctx, who);
  const modeDuring = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="model-button"]`)
    .getAttribute('data-team-mode');
  await settle(ctx, who);
  const after = await cardTitles(ctx, who);
  const modeAfter = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="model-button"]`)
    .getAttribute('data-team-mode');
  ctx.misc.titlesCards = after;
  record('TB-55 tool cards in the dialog of a merged session (lead holds dialog and create): request_submit '
    + '"Register a request", task_create "Create a task", board_read "Read the board" / "Read request 1" / "Read T1", '
    + 'read_session "Read executor’s work on T1", and the three agent_message forms: to a task "Message T1", '
    + 'to a role that opens an ask instance "Ask executor", into a seat session "Message closer"',
  same(during, TITLES_CARDS) && modeDuring === 'once', brief({ during, modeDuring }));
  record('TB-55 the tool card titles stay as they were when the run went that way after task mode returns to off '
    + '(the message into closer\'s close session still reads "Message closer", not "Ask closer")',
  same(after, TITLES_CARDS) && modeAfter === 'off', brief({ after, modeAfter }));
  await titleRows(ctx, who);
  await titlesNoChanges(ctx, who);
}

/** @brief TB-55：T1 那一行（进展摘要的当前在做什么）依次显示每个工具的 §13.8 标题。 */
async function titleRows(ctx, who) {
  const rows = (await phasesOf(ctx, who.tab, who.since)).filter((item) => item.task === 'T1'
    && item.phase === 'running').map((item) => item.text);
  const want = TITLES_ROWS.map((title) => `T1 Review notes · executor · ${title}`);
  const seen = want.filter((text) => rows.includes(text));
  const order = rows.filter((text) => want.includes(text)).filter((text, i, all) => all.indexOf(text) === i);
  record('TB-55 the task row of a progress summary shows the §13.8 title of the instance\'s latest tool call: '
    + '"Read the board", "Read request 1", "Read T1", "Read executor’s work on T1", "Ask reviewer" (an ask instance), '
    + '"Message closer" (into the close session), "Message T1" (to a task) and "Hand off T1", in call order',
  same(seen, want) && same(order, want), brief({ rows: [...new Set(rows)] }));
}

/** @brief TB-57：只读 task 的协作会话（实例没改过文件）：This session 为“No changes yet.”，没有后台改动的说明。 */
async function titlesNoChanges(ctx, who) {
  await toggleRight(ctx, who);
  const panel = await rightPanel(ctx);
  record(`TB-57 a team session whose tasks changed no file: This session reads "${NO_CHANGES}", with no team note `
    + `("${TEAM_NOTE}" is gone, FS-14)`, panel !== null && panel.empty && !panel.teamNote && !panel.v0Note
    && panel.files.length === 0, brief(panel));
  await toggleRight(ctx, who);
}

/** @brief 合并会话里立项的其余工具（tb-misc-titles2）：补充、改 task、直接回答、撤销。 */
async function titles2(ctx) {
  const who = await begin(ctx, ctx.titles, 'Read README.md slowly tb-scenario:tb-misc-titles2');
  if (!(await waitReceipt(ctx, who.tab, { kind: 'registered', request: 1 }))) throw new Error('no receipt');
  await dialogIdle(ctx, who);
  await sendMessage(ctx, who.tab, 'Also read src/a.ts after it');
  await dialogIdle(ctx, who);
  await sendMessage(ctx, who.tab, 'What does src/a.ts do?');
  await dialogIdle(ctx, who);
  await sendMessage(ctx, who.tab, 'Cancel that request');
  await settle(ctx, who, 60000);
  const titlesNow = await cardTitles(ctx, who);
  const board = readBoard(ctx, who.sessionId);
  record('TB-55 tool cards in the merged session for the rest of create\'s tools: request_update "Add to request 1", '
    + 'task_edit "Edit T1", reply_via_dialog "Answer directly", request_cancel "Cancel request 1"',
  same(titlesNow, TITLES2_CARDS) && board?.requests[0]?.status === 'cancelled',
  brief({ titles: titlesNow, status: board?.requests[0]?.status }));
}

// ---------- TB-57：右栏 ----------

/** @brief 点这个会话顶栏的右栏开关。 */
async function toggleRight(ctx, who) {
  await showTab(ctx, who.tab);
  await ctx.page.locator(`${paneSel(who.tab)} ${RIGHT_TOGGLE}`).click();
}

/**
 * @brief 右栏 Changes 视图此刻的样子（docs/v1/screens/fs-changes.md "This session"）；没有打开或打开的是阅读器时为 null：
 *        { empty（This session 显示“No changes yet.”）, teamNote（有 team-changes-note 或它的文字）, v0Note（有 v0 的
 *        “Only edits and writes are listed…”）, turns（从上到下每一轮：turn、title（Turn n · 之后的第一行）、
 *        files：path、agents）, files（各轮的路径，从上到下） }。
 */
function rightPanel(ctx) {
  return ctx.page.evaluate(({ noChanges, team, v0 }) => {
    const panel = document.querySelector('[data-testid="right-panel"] [data-testid="changes"]');
    if (!panel) return null;
    const section = panel.querySelector('[data-testid="session-changes"]');
    const turns = [...(section?.querySelectorAll('[data-testid="turn-changes"]') ?? [])].map((turn) => ({
      turn: turn.dataset.turn ? Number(turn.dataset.turn) : null,
      title: (turn.querySelector('.turn-title')?.textContent ?? '').replace(/^Turn \d+ · /, ''),
      files: [...turn.querySelectorAll('[data-testid="turn-file"]')].map((file) => ({ path: file.dataset.path,
        agents: file.querySelector('[data-testid="turn-file-agents"]')?.textContent ?? null })) }));
    const empty = section?.querySelector('[data-testid="session-changes-empty"]')?.textContent === noChanges;
    return { empty, teamNote: Boolean(panel.querySelector('[data-testid="team-changes-note"]'))
      || panel.textContent.includes(team), v0Note: panel.textContent.includes(v0), turns,
    files: turns.flatMap((turn) => turn.files.map((file) => file.path)) };
  }, { noChanges: NO_CHANGES, team: TEAM_NOTE, v0: V0_NOTE });
}

/** @brief This session 里某个路径的文件行（第一次出现的那一轮里的）；没有时为 null。 */
const fileOf = (panel, path) => panel?.turns.flatMap((turn) => turn.files).find((file) => file.path === path) ?? null;

/**
 * @brief 等这个会话的 This session 列出 path：右栏在这个会话第一次收到 mori.turn_changes 时自己打开（§5.1）；
 *        RECORD_WAIT 内没打开时点右栏开关再等一次。返回 { panel（最后读到的样子）, byItself（没点开关就列出了） }。
 */
async function panelWith(ctx, who, path) {
  await showTab(ctx, who.tab);
  const wait = (timeout) => poll(async () => {
    const panel = await rightPanel(ctx);
    return fileOf(panel, path) ? panel : null;
  }, timeout, 200);
  const shown = await wait(RECORD_WAIT);
  if (shown) return { panel: shown, byItself: true };
  if (await ctx.page.locator('[data-testid="right-panel"]').count() === 0) await toggleRight(ctx, who);
  return { panel: await wait(5000) ?? await rightPanel(ctx), byItself: false };
}

/** @brief TB-57 后半与重启后共用：两轮、新的在上，Turn 2 是对话自己写的 notes.txt，Turn 1 是 T1 改的 README.md。 */
function twoTurnsOk(panel) {
  const [top, below] = panel?.turns ?? [];
  return panel?.turns.length === 2 && top.turn === 2 && top.title === NOTES_ASK
    && same(top.files, [{ path: 'notes.txt', agents: null }]) && below.turn === 1
    && below.files.length === 1 && below.files[0].path === 'README.md'
    && Boolean(below.files[0].agents?.split(', ').includes(T1_AGENT)) && !panel.teamNote && !panel.v0Note;
}

/**
 * @brief tb-misc-changes：T1 改了 README.md 之后，This session 列出它、标出 T1 的 Agent（task 实例的段记进用户会话，
 *        docs/specs/file-system.md §4.6）；对话自己写了 notes.txt 之后多一轮。最后比较会话引用的轮号（FS-12）。
 */
async function changes(ctx) {
  const who = await begin(ctx, ctx.split, CHANGES_ASK, { allow: true });
  ctx.misc.changes = who;
  await waitRequest(ctx, 'tb-misc-changes', { agent: 'executor', kind: 'task', task: 'T1' }, 1,
    { j: 1, timeout: 60000 });
  const edited = readFileSync(join(ctx.split, 'README.md'), 'utf8').includes('Changed by T1');
  await settle(ctx, who, 90000);
  const { panel: live, byItself } = await panelWith(ctx, who, 'README.md');
  const agents = fileOf(live, 'README.md')?.agents ?? null;
  record('TB-57 a task\'s file change is recorded for the user session: the right panel opens by itself to Changes on '
    + 'the session\'s first mori.turn_changes (FS-12)', edited && byItself, brief({ edited, byItself }));
  record('TB-57 after a task changed a file (edit of README.md), This session lists README.md marked with the agent '
    + `"${T1_AGENT}" (FS-14); there is no "${TEAM_NOTE}", no "${V0_NOTE}" and no "${NO_CHANGES}"`,
  Boolean(agents?.split(', ').includes(T1_AGENT)) && !live.teamNote && !live.v0Note && !live.empty,
  brief({ live }));
  await sendMessage(ctx, who.tab, NOTES_ASK);
  await settle(ctx, who, 60000);
  const { panel: after } = await panelWith(ctx, who, 'notes.txt');
  ctx.misc.changesPanel = after;
  record('TB-57 with the task\'s change and the dialog\'s own write: This session has two turns, the newer on top — '
    + '"Turn 2 · Write the notes file" lists notes.txt with no agent (only the dialog itself), Turn 1 lists README.md '
    + `marked "${T1_AGENT}"; no team note`, twoTurnsOk(after), brief(after));
  await refTurns(ctx, who, after);
}

/** @brief 某个会话输入框上方第一个读完的会话引用芯片的文字；RECORD_WAIT 内没有时为空串。 */
async function sessionChipOf(ctx, tab) {
  const css = `${paneSel(tab)} [data-testid="quote-chip"][data-kind="session"]:not([data-pending]) .quote-chip-label`;
  return ctx.page.locator(css).first().innerText({ timeout: RECORD_WAIT }).catch(() => '');
}

/**
 * @brief 引用预览（点芯片打开，docs/v0/screens/session-refs.md）里的每一轮：[{ number（data-turn）, text（这一轮的内容）
 *        }]；打不开或一直在读（Loading…）时为空数组。等读完（同 m5-helpers 的 waitPreview）再取各轮，读完按 Esc 关上。
 */
async function previewTurnsOf(ctx, tab) {
  await ctx.page.locator(`${paneSel(tab)} [data-testid="quote-chip"] .quote-chip-main`).first().click();
  const dialog = ctx.page.getByTestId('ref-preview');
  const loaded = await ctx.page.waitForFunction(() => {
    const box = document.querySelector('[data-testid="ref-preview"]');
    return box && !box.textContent.includes('Loading…');
  }, null, { timeout: RECORD_WAIT }).then(() => true, () => false);
  if (!loaded) return [];
  const turns = await dialog.locator('[data-testid="ref-turn"]').evaluateAll((items) => items.map((item) => ({
    number: Number(item.dataset.turn), text: item.querySelector('pre')?.textContent ?? '' })));
  await ctx.page.keyboard.press('Escape');
  return turns;
}

/**
 * @brief 会话文件里你的两条消息（role 为 user、没有 mori.wake 指向、文字含 first 与 second 的）之间的程序投递：
 *        mori.wake 条目指向的 role 为 user 的消息，每项 { kind（投递的种类）, text（前 60 个字符） }；两条消息有一条
 *        找不到、或顺序不对时为 null。
 */
function deliveriesBetween(file, first, second) {
  const entries = readJsonl(file).slice(1);
  const wakes = new Map(customOf(entries, 'mori.wake').map((wake) => [wake.messageId, wake.kind]));
  const users = entries.map((entry, index) => ({ entry, index, text: contentText(entry.message?.content) }))
    .filter(({ entry }) => entry.type === 'message' && entry.message?.role === 'user');
  const yours = (text) => users.find((item) => !wakes.has(item.entry.id) && item.text.includes(text))?.index ?? -1;
  const [from, to] = [yours(first), yours(second)];
  if (from < 0 || to < from) return null;
  return users.filter((item) => item.index > from && item.index < to && wakes.has(item.entry.id))
    .map((item) => ({ kind: wakes.get(item.entry.id), text: item.text.slice(0, 60) }));
}

/**
 * @brief FS-12（文件系统规格 §5.3；§19.4 要求加在协作模式的 tb-app 套件里）：先从会话文件确认这个会话的两条你的消息
 *        之间确实有 [Mori] 投递（需求关闭后的 request_closed，mori.wake 指向它；没有它时这一项测不到要测的情形，判失败）。
 *        再在同一项目的新会话里用会话行菜单 “Attach as context” 引用它：芯片的 turns a–b、预览里每一轮的 Turn N 与
 *        This session 的组编号相同，且同一个编号的预览以那一组标题的消息开头。读完移除芯片（不发出）。
 */
async function refTurns(ctx, who, panel) {
  const delivered = deliveriesBetween(who.sessionFile, CHANGES_ASK, NOTES_ASK);
  const wakeOk = Boolean(delivered?.length) && delivered.every((item) => item.text.startsWith('[Mori]'))
    && delivered.some((item) => item.kind === 'request_closed');
  const tab = await openSessionIn(ctx, ctx.split);
  await ctx.page.locator(`.session-item[data-file=${JSON.stringify(who.sessionFile)}]`).click({ button: 'right' });
  await ctx.page.getByTestId('session-menu').getByRole('menuitem', { name: 'Attach as context' }).click();
  const chip = await sessionChipOf(ctx, tab);
  const preview = await previewTurnsOf(ctx, tab);
  const range = /· turns (\d+)–(\d+) ·/.exec(chip)?.slice(1).map(Number) ?? null;
  const groups = (panel?.turns ?? []).map((turn) => turn.turn).sort((x, y) => x - y);
  const titled = (panel?.turns ?? []).every((turn) => preview.find((item) => item.number === turn.turn)?.text
    .startsWith(`User: ${turn.title}`));
  record('FS-12 in team mode with a [Mori] delivery between your two messages (the session file has a request_closed '
    + 'mori.wake pointing at a "[Mori]" user message between them), the session-reference chip of this session reads '
    + '"turns 1–2", its preview lists Turn 1 and Turn 2, and the This session groups are Turn 2 and Turn 1: the same '
    + 'numbers, and each number starts with the message of the group with that number', wakeOk && same(range, [1, 2])
    && same(preview.map((item) => item.number), [1, 2]) && same(groups, [1, 2]) && titled,
  brief({ delivered, chip, groups, preview: preview.map((item) => `${item.number}: ${item.text.slice(0, 60)}`) }));
  await ctx.page.locator(paneSel(tab)).getByRole('button', { name: /^Remove context: / }).first().click()
    .catch(() => {});
}

/** @brief 没有 TaskBoard 的会话（没有角色文件、没用过协作模式）：对话自己的改动同样列在 This session。 */
async function plainChanges(ctx) {
  const who = await begin(ctx, ctx.plain, 'Write a file tb-scenario:tb-misc-plainwrite', { team: false, allow: true });
  await settle(ctx, who, 60000);
  const { panel: written, byItself } = await panelWith(ctx, who, 'plain.txt');
  const fresh = { tab: await openSessionIn(ctx, ctx.plain) };
  await toggleRight(ctx, fresh);
  const empty = await rightPanel(ctx);
  record('TB-57 without a TaskBoard: the dialog\'s write opens the right panel by itself on the first '
    + 'mori.turn_changes and This session lists plain.txt with no agent, with no team note and no v0 line; a fresh '
    + `session's panel reads "${NO_CHANGES}"`, byItself && same(written?.files, ['plain.txt'])
    && fileOf(written, 'plain.txt').agents === null && !written.teamNote && !written.v0Note && empty !== null
    && empty.empty && !empty.teamNote && empty.files.length === 0 && readBoard(ctx, who.sessionId) === null,
  brief({ written, empty }));
}

// ---------- TB-30：超出上限时的压缩 ----------

/**
 * @brief 一张 T3 的工作卡用了 §8.3 的哪几步压缩：handoffs（较早的交接压成一行）、messages（只留最近 3 条）、
 *        items（依赖的结论与已排除的方案截到 200 字符）、original（最初的原话截到 2000 字符），以及补充与消息。
 */
function compression(card) {
  const lines = card.split('\n');
  const notes = lines.filter((line) => /^- lead \(\d\d:\d\d\): NOTE\d\d /.test(line))
    .map((line) => /NOTE(\d\d)/.exec(line)[1]);
  const dep = lines.find((line) => line.startsWith('- T1 Prepare: ')) ?? '';
  const ruledAt = lines.indexOf('Ruled out:');
  const ruled = ruledAt >= 0 ? lines[ruledAt + 1] ?? '' : '';
  const original = lines.find((line) => line.includes('ORIGINAL ')) ?? '';
  return {
    length: card.length,
    handoffs: /^- \d+ earlier handoffs?: board_read \{"task":"T3"\}$/m.test(card),
    messages: notes.length > 0 && notes.length < 10,
    items: dep !== '' && !dep.includes('DEPWORK-END') && !dep.includes('DEPCLOSE-END') && dep.includes('board_read')
      && ruled.startsWith('- RULED ') && !ruled.includes('RULED-END') && ruled.includes('board_read'),
    original: original !== '' && !original.includes('ORIGINAL-END') && original.includes('board_read {"request":1}'),
    notes, full: { dep: dep.includes('DEPWORK-END') && dep.includes('DEPCLOSE-END'), ruled: ruled.includes('RULED-END'),
      original: original.includes('ORIGINAL-END') },
    supplements: MISC_TEXT.over.supplements.map((text) => card.includes(`"${text}"`)),
  };
}

/** @brief 一张卡的压缩做到了第几步（0–4）；做的步骤不是按顺序的前几步时为 -1。 */
function levelOf(c) {
  const steps = [c.handoffs, c.messages, c.items, c.original];
  const level = steps.lastIndexOf(true) + 1;
  // 第 2 步只在有消息时可见：没有消息时（level 只看交接与后两步）不要求它
  return steps.slice(0, level).every((done, i) => done || (i === 1 && c.notes.length === 0)) ? level : -1;
}

/** @brief tb-misc-overflow：T3 在 executor 与 reviewer 之间来回，你在每轮之间加补充或请 lead 留消息。 */
async function overflow(ctx) {
  const over = MISC_TEXT.over;
  const who = await begin(ctx, ctx.over, over.original);
  const scenario = 'tb-misc-overflow';
  const reviewer = { agent: 'reviewer', kind: 'task', task: 'T3' };
  const pushes = [[2, over.supplements[0]], [3, 'Leave ten notes for T3'], [4, over.supplements[1]],
    [5, over.supplements[2]]];
  for (const [k, text] of pushes) {
    await waitRequest(ctx, scenario, reviewer, k);
    await sendMessage(ctx, who.tab, text);
    await dialogIdle(ctx, who);
  }
  await waitRequest(ctx, scenario, { agent: 'executor', kind: 'task', task: 'T3' }, 6, { j: 0 });
  await sendMessage(ctx, who.tab, over.supplements[3]);
  await settle(ctx, who, 180000);
  await overflowChecks(ctx, who, scenario);
}

/** @brief TB-30：T3 的 executor 每轮第一次请求（以及最后一轮的第二次）的工作卡按顺序压缩，补充一条不少。 */
async function overflowChecks(ctx, who, scenario) {
  const requests = scenarioRequests(ctx.ep, scenario, { agent: 'executor', kind: 'task', task: 'T3' });
  const pick = (k, j) => requests.find((item) => item.info.k === k && item.info.j === j);
  const cards = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [6, 1]].map(([k, j]) => {
    const card = pick(k, j) ? cardOf(pick(k, j)) : null;
    return card?.text ? compression(card.text) : null;
  });
  const levels = cards.map((c) => (c ? levelOf(c) : null));
  const sups = [0, 0, 1, 1, 2, 3, 4];
  const supplementsOk = cards.every((c, i) => c && c.supplements.every((has, n) => has === n < sups[i]));
  const lengths = cards.map((c) => c?.length ?? null);
  record('TB-30 over the 8000-character limit the work card is compressed in the order of §8.3, each card only as far '
    + 'as it needs: no compression while it fits (T3 rounds 1–2), then earlier handoffs folded into "N earlier '
    + 'handoffs: board_read {"task":"T3"}" (round 3), then messages cut to the latest 3 (round 4), then the dependency '
    + 'conclusions and the ruled-out approach cut to 200 characters with board_read (round 5), then the original words '
    + 'cut to 2000 with board_read {"request":1} (round 6); every card up to there is ≤ 8000 characters',
  same(levels, [0, 0, 1, 2, 3, 4, 4]) && lengths.slice(0, 6).every((n) => n !== null && n <= CARD_LIMIT)
    && same(cards[3]?.notes, ['08', '09', '10']) && cards[2]?.full.dep && cards[3]?.full.ruled
    && cards[4]?.full.original, brief({ levels, lengths, notes: cards.map((c) => c?.notes.length) }));
  const overLog = appLogLines(ctx, /the work card is over its limit/, who.since);
  const board = readBoard(ctx, who.sessionId);
  const words = board?.requests[0]?.words.filter((w) => w.kind === 'supplement').map((w) => w.text) ?? [];
  record('TB-30 user additions are never cut or left out: every card has each supplement recorded so far in full; when '
    + 'only the supplements still overflow, the card goes over the limit with all four of them and Mori logs it',
  supplementsOk && same(words, MISC_TEXT.over.supplements) && lengths[6] > CARD_LIMIT && levels[6] === 4
    && overLog.length >= 1, brief({ supplements: cards.map((c) => c?.supplements), words: words.length,
    last: lengths[6], overLog: overLog.slice(0, 2) }));
}

// ---------- TB-30：换模型重发与压缩 ----------

/** @brief tb-misc-switch：lead 与 T1 的请求在换模型后重发，卡片仍是最后一条且只有一张。 */
async function switchModels(ctx) {
  const who = await begin(ctx, ctx.switch, 'Switch models tb-scenario:tb-misc-switch');
  await settle(ctx, who, 120000);
  const all = scenarioRequests(ctx.ep, 'tb-misc-switch');
  const lead = all.filter((item) => item.info.role === 'lead' && item.info.kind === 'merged-create'
    && item.info.k === 1);
  const task = all.filter((item) => item.info.role === 'executor' && item.info.kind === 'task');
  const view = (items) => items.map((item) => ({ model: item.body.model, k: item.info.k, j: item.info.j,
    card: cardOf(item) }));
  const leadView = view(lead);
  const taskView = view(task);
  const ok = (items) => items.every((item) => item.card.count === 1 && item.card.last);
  const models = (items) => items.map((item) => `${item.model}:${item.k}/${item.j}`);
  record('TB-30 when a request is re-sent after a model switch the work card is still the last message and the only '
    + 'one: lead (merged session) fake-swa fails → same request in place on fake-swb, fake-swb fails mid-reply → the '
    + 'reply is redone on fake-swc from processed context',
  ok(leadView) && same(models(leadView), ['fake-swa:1/0', 'fake-swb:1/0', 'fake-swb:1/1', 'fake-swc:1/0',
    'fake-swc:1/1', 'fake-swc:1/2', 'fake-swc:1/3']) && same(leadView[1].card.text, leadView[0].card.text),
  brief({ lead: models(leadView), cards: leadView.map((item) => [item.card.count, item.card.last]) }));
  record('TB-30 a task instance: fake-ta fails on the first request → re-sent in place on fake-tb with the card last; '
    + 'fake-tb fails after a tool call → the task restarts on fake-tc and that request also ends with the card',
  ok(taskView) && same(models(taskView), ['fake-ta:1/0', 'fake-tb:1/0', 'fake-tb:1/1', 'fake-tc:restart-1/0',
    'fake-tc:restart-1/1']), brief({ task: models(taskView),
    cards: taskView.map((item) => [item.card.count, item.card.last]) }));
}

/** @brief tb-misc-compact：协作模式一直开着的合并会话里发长消息直到 pi 压缩，之后的请求末尾仍有卡片。 */
async function compact(ctx) {
  const tab = await openSessionIn(ctx, ctx.compact);
  await sendMessage(ctx, tab, '/task on');
  const who = { tab, since: Date.now() };
  let summary = null;
  for (let n = 1; n <= 6 && !summary; n += 1) {
    await sendMessage(ctx, tab, MISC_TEXT.compactMessage(n));
    Object.assign(who, await userSession(ctx, tab));
    await settle(ctx, who, 60000);
    summary = ctx.ep.proxy.captures.find((item) => item.chat && item.t >= who.since
      && contentText(item.body?.messages?.[0]?.content).startsWith(SUMMARY_SYSTEM)) ?? null;
  }
  ctx.watched.set(who.sessionId, who);
  if (!summary) throw new Error('pi never compacted the session');
  await sendMessage(ctx, tab, `${MISC_TEXT.compactMessage(9).slice(0, 200)} after the compaction`);
  await settle(ctx, who, 60000);
  const after = scenarioRequests(ctx.ep, 'tb-misc-compact', { since: summary.t })
    .filter((item) => !isSummary(item));
  const first = after[0];
  const card = first ? cardOf(first) : null;
  const summaryCards = JSON.stringify(summary.body.messages).includes(CARD_OPEN);
  const entries = readJsonl(who.sessionFile);
  record('TB-30 the work card survives compaction: the compaction request has no card in it (the card never is in the '
    + 'session), the next requests of the merged session start from the compaction summary and still end with the '
    + 'card as their own last message (also for your next message); the session file has the compaction entry',
  !summaryCards && first !== undefined && first.messages.some((m) => textOf(m).startsWith(COMPACTED))
    && card.count === 1 && card.last && card.text.split('\n')[1] === 'Task mode: on' && after.length >= 2
    && after.every((item) => cardOf(item).count === 1 && cardOf(item).last)
    && entries.some((entry) => entry.type === 'compaction'),
  brief({ summaryCards, after: after.map((item) => [item.info.k, item.info.j, cardOf(item).last]),
    first: first?.messages.map((m) => `${m.role}:${textOf(m).slice(0, 40)}`) }));
}

// ---------- 重启：TB-55、TB-57 重新打开 ----------

/** @brief 重启 App，重新打开 tb-misc-titles 与 tb-misc-changes 的会话。 */
async function restart(ctx) {
  await restartTbApp(ctx);
  await watchTaskPhases(ctx);
  const titled = ctx.misc.titles;
  if (titled) {
    titled.tab = await reopenSession(ctx, titled.sessionFile);
    const reopened = await poll(async () => {
      const list = await cardTitles(ctx, titled);
      return list.length === TITLES_CARDS.length ? list : null;
    }, 15000) ?? await cardTitles(ctx, titled);
    record('TB-55 after restarting Mori and reopening the merged session, the tool cards have the same §13.8 titles '
      + '(the message into the close session still reads "Message closer")', same(reopened, TITLES_CARDS),
    brief(reopened));
  }
  const changed = ctx.misc.changes;
  if (changed) {
    changed.tab = await reopenSession(ctx, changed.sessionFile);
    const { panel } = await panelWith(ctx, changed, 'notes.txt');
    record('TB-57 after restarting Mori and reopening the session, This session reads the same turns from the session '
      + `file: Turn 2 lists notes.txt, Turn 1 lists README.md marked "${T1_AGENT}"; no team note`, twoTurnsOk(panel)
      && same(panel.turns, ctx.misc.changesPanel?.turns), brief(panel));
  }
}

// ---------- 整个套件的检查（TB-30） ----------

/** @brief 各种会话的卡片第一行（§8.3 的固定行）。 */
const FIRST_LINES = {
  task: /^You are [a-z0-9-]+ on T\d+ \(request \d+\)\.$/,
  close: /^You are [a-z0-9-]+, closing request \d+\.$/,
  create: /^Task mode: (on|until done)$/,
  'team-dialog': /^Task mode: (on|until done)$/,
  'merged-create': /^Task mode: (on|until done)$/,
  ask: /^Request \d+: .+ · [a-z_]+$/,
  dialog: /^Task mode: off$/,
  'off-dialog': /^Task mode: off$/,
};

/** @brief TB-30：本套件每个请求的卡片位置、各种会话的第一行。 */
function cardPlacementChecks(ctx) {
  const requests = miscRequests(ctx);
  const bad = [];
  const kinds = new Map();
  for (const item of requests) {
    const card = cardOf(item);
    const kind = item.info.kind;
    const key = `${item.info.scenario}|${item.info.role}|${kind}|${item.info.task ?? '-'}`;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const want = CARD_KINDS.includes(kind) || (kind === 'ask' && item.info.role === 'reviewer');
    const none = OFF_KINDS.includes(kind) || (kind === 'ask' && item.info.role === 'executor');
    if (want && !(card.count === 1 && card.last)) bad.push(`${key}: cards ${card.count}, last ${card.last}`);
    const offCard = OFF_KINDS.includes(kind) && card.count === 1 && card.last;
    if (none && card.count !== 0 && !offCard) bad.push(`${key}: ${card.count} cards where none belongs`);
    if (!want && !none) bad.push(`${key}: unexpected kind`);
    const first = card.text?.split('\n')[1];
    if (card.text && FIRST_LINES[kind] && !FIRST_LINES[kind].test(first)) bad.push(`${key}: first line "${first}"`);
  }
  const covered = [...CARD_KINDS.filter((kind) => kind !== 'subscription'), 'ask', 'dialog', 'off-dialog']
    .every((kind) => kinds.has(kind));
  record('TB-30 every request of every TaskBoard session in this suite (task, close, split create, team-mode dialog, '
    + 'merged session, team-mode ask with a request) ends with the work card as its own user message and has no '
    + 'other card; its first line is the fixed line of §8.3 for that kind; off-mode dialogs have no card, or only '
    + 'the off-mode card ("Task mode: off") as their last message once the board has a request; an ask with no '
    + 'request has no card', requests.length > 50 && covered && bad.length === 0,
  brief({ requests: requests.length, kinds: Object.fromEntries(kinds), bad: bad.slice(0, 8) }));
}

/** @brief TB-30：工作卡从不写进会话文件（用户会话与全部实例会话）。 */
function cardFileChecks(ctx) {
  const files = [];
  for (const [id, who] of ctx.watched) {
    if (who.sessionFile) files.push(who.sessionFile);
    files.push(...instanceFiles(ctx, id).map((item) => item.file));
  }
  // 共用段（附录 A）在 system prompt 里提到 "<mori-work-card> block"，会话文件里有它不算：认的是卡片的末行与条目类型
  const bad = files.filter((file) => {
    const text = readFileSync(file, 'utf8');
    return text.includes(CARD_CLOSE) || text.includes(`${CARD_OPEN}\\n`) || text.includes('mori.work_card');
  });
  record('TB-30 the work card is never written to a session file: no user session file and no instance session file '
    + '(task, close, ask) of this suite contains a mori.work_card entry or a <mori-work-card> … </mori-work-card> '
    + 'block',
  files.length >= 15 && bad.length === 0, brief({ files: files.length, bad }));
}

// ---------- 主流程 ----------

const steps = { titles, titles2, changes, plainChanges, overflow, switchModels, compact, restart };

const ctx = { userData: tempUserData('mori-tb-misc-data-'), exePath: args.exePath, watched: new Map(), misc: {},
  pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-misc] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: misc`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  if (!args.only) {
    cardPlacementChecks(ctx);
    cardFileChecks(ctx);
  }
  const missing = missingSteps(ctx.ep);
  record('misc: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-misc] data in ${ctx.userData}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
