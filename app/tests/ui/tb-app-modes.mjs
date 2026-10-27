// 平行 Agent 与 TaskBoard 的 App 套件：协作模式与用户消息（docs/specs/parallel-agents-taskboard.md §17.2）。真正的 Mori
// （界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/modes.mjs，synthetic），逐条验收
// TB-05（协作模式的进入与结束）、TB-06（立项的决定）、TB-07（用户原话照记）、TB-08（回执）、TB-11（立项看着整个对话）、
// TB-54（阶段行与 Stop team）、TB-56（待判断的消息）在 App 层的通过条件。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs modes）：
//   MORI_APP_DIR=.tb-runs/modes node tests/ui/tb-app-modes.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-modes(-packaged).json（--only 时 tb-partial-app-modes…），截图在 test-results/tb-app-modes/。
// 端口：合成端点 4610，记录代理 4611（本套件分到 4610–4619）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好三个本机提供商（tba 默认、tbb、并发为 1 的 tbq；写入等级 A、
// 能关思考，跳过探针）并信任分开配置的两个项目；三个临时项目：分开配置（chat / planner / executor / reviewer，另有
// .pi/prompts/team.md 与 tbtmpl.md 两个提示词模板、.pi/extensions/tbcmd.ts 一个扩展命令）、没有角色文件（合并会话）、
// 另一套分开配置（chat 与 executor 用 tbq，planner 用 tbb：对话在为另一条消息准备中）。
// 步骤各用自己的会话；restart 一步最后跑：重启 App，重新打开前面各步的会话，比较开关、回执与进展摘要的位置，并接着发消息。
// 收尾检查规格（docs/specs/finish-check.md §8.2）之后：协作模式下对话的工具里一直有 finish，teamShape 的工具集合加上它；
// 检查那次请求由 scenarioRequests、scenarioLines 默认跳过（§14.4），各请求的 k、j 不变。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODES_TEXT } from '../fake-endpoint/scenarios/modes.mjs';
import { SEGMENT_SENTENCES } from '../fake-endpoint/scripts.mjs';
import {
  appLogLines, brief, captureOrder, clickTeamSwitch, closeTbApp, contentText, customOf, instanceFiles,
  instanceSuffix, kernelEvents, liveInfo, messagesOf, missingSteps, newSession, openSessionIn, orderOf, paneSel,
  paneState, poll, quoteChipsOf, quoteReply, readBoard, readJsonl, receiptsOf, reopenSession, restartTbApp,
  scenarioLines, scenarioRequests, seedTeamUserData, sendMessage, shot, showTab, sleep, SPLIT_ROLES, startTbApp,
  startTbEndpoint, stopTbEndpoint, suiteArgs, tbModel, tbProvider, tbRecorder, teamSwitch, tempProject, tempUserData,
  transcriptItems, userSession, waitReceipt, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';
import { stagesOf } from './v1-switch-helpers.mjs';

const args = suiteArgs('modes');
const { record, finish } = tbRecorder(args);

/** 本套件的端口（§17.1 的 4600–4699 里分给它的 4610–4619）：合成端点与它前面的记录代理 */
const PORT = 4610;
const PROXY = 4611;
/** 合成端点上的模型（synthetic）：三个提供商各一个，写入等级 A、能关思考 */
const MODEL_A = 'fake-coder-tbmodes';
const MODEL_B = 'fake-coder-tbmodes-b';
const MODEL_Q = MODES_TEXT.modelQ;
/** 附录 A 各段固定的句子 */
const TEAM_DIALOG = SEGMENT_SENTENCES['team-dialog'];
const OFF_DIALOG = SEGMENT_SENTENCES['off-dialog'];
const SHARED_PART = "one of several agents that work together on Mori's TaskBoard.";
/** 程序给的固定文字（§5.4、§8.4、§8.5） */
const RECORD_FIRST = "Record the user's words first (request_submit or request_update).";
const USER_ONLY = 'Only a user message can register or cancel a request.';
const QUOTE_MISMATCH = "quote must be the user's exact words";
const QUOTE_REQUIRED = 'quote is required: this turn has no user message.';
const CATCH_UP = "Conversation since your last turn (the user's words are exact):";
const NEW_MESSAGE = '[Mori] New user message: ';
const CARD_OPEN = '<mori-work-card>';
/** 读取类工具、对话在协作模式下多的三个（§5.5）与一直启用的 finish（收尾检查规格 §8.2） */
const TEAM_DIALOG_TOOLS = ['read', 'grep', 'find', 'ls', 'board_read', 'read_session', 'agent_message', 'finish'];
/** 写入与命令类工具 */
const WRITE_TOOLS = ['bash', 'edit', 'write'];
/** v0 排队区的种类文字（docs/v0/screens/chat.md） */
const QUEUED = 'Queued';
const STEERED = 'Steer';
const WAITING = 'Waiting for planner';

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 会话文件里 pi 消息的文字。 */
const textOf = (message) => contentText(message?.content);
/** @brief 一个请求里的工作卡（最后一条含 <mori-work-card> 的消息的那一段）；没有时为空串。 */
function cardOf(request) {
  const found = request?.messages.findLast((m) => m.role === 'user' && contentText(m.content).includes(CARD_OPEN));
  const text = found ? contentText(found.content) : '';
  return text.slice(text.indexOf(CARD_OPEN) < 0 ? text.length : text.indexOf(CARD_OPEN));
}
/** @brief 请求里不是工作卡、不是工具结果的 user 消息（投递），按顺序。 */
const deliveriesOf = (request) => (request?.messages ?? []).filter((m) => m.role === 'user')
  .map((m) => contentText(m.content)).filter((text) => !text.trimStart().startsWith(CARD_OPEN));
/** @brief 用户会话文件的全部条目（第一行头部除外）。 */
const userEntries = (who) => readJsonl(who.sessionFile).slice(1);
/** @brief 某个实例会话（按 id 后缀，例如 create、close.1、t1.executor）的条目；没有时为 []。 */
const instanceEntries = (ctx, who, suffix) => instanceFiles(ctx, who.sessionId)
  .find((file) => instanceSuffix(who.sessionId, file.id) === suffix)?.entries ?? [];
/** @brief 会话条目里某个工具的工具结果，按顺序，每项 { error, text }。 */
const resultsOf = (entries, tool) => messagesOf(entries).filter((m) => m.role === 'toolResult' && m.toolName === tool)
  .map((m) => ({ error: m.isError === true, text: textOf(m) }));
/** @brief 会话条目里 role 为 user 的消息文字。 */
const userTexts = (entries) => messagesOf(entries, 'user').map(textOf);
/**
 * @brief 对话流条目的简写（只留你的消息、回复、回执、进展摘要），重新打开前后比较用；工具卡上实时才有的用时
 *        （“完成 · 14s”的“ · 14s”）去掉。
 */
const streamShape = (items) => items.filter((item) => ['user', 'assistant', 'receipt', 'progress'].includes(item.kind))
  .map((item) => `${item.kind}:${item.kind === 'progress' ? item.request
    : item.text.replace(/ · \d+(\.\d+)?s/g, '').slice(0, 60)}`);

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/** @brief 等某个会话面板不在生成、不在发送（对话空闲；后台可以还在运行）。 */
async function paneIdle(ctx, tab, timeout = 60000) {
  const ok = await poll(async () => {
    const pane = await paneState(ctx.page, tab);
    return pane && !pane.running && !pane.sending;
  }, timeout, 100);
  if (!ok) throw new Error(`the dialog of ${tab} did not become idle`);
}

/** @brief 等端点收到某个脚本的一个请求（where 同 scenarioLines，k、j 另外筛）；返回那一行，超时报错。 */
async function waitLine(ctx, scenario, where, timeout = 30000) {
  const { k, j, ...rest } = where;
  const pick = () => scenarioLines(ctx.ep, scenario, rest).find((line) => (k === undefined || line.k === k)
    && (j === undefined || line.j === j));
  const line = await poll(() => pick() ?? null, timeout, 50);
  if (!line) throw new Error(`no request ${JSON.stringify(where)} for ${scenario}`);
  return line;
}

/** @brief 某个脚本的请求里，某个角色、种类、k、j 的那一个（scenarioRequests）；没有时 undefined。 */
const requestAt = (ctx, scenario, where) => {
  const { k, j, ...rest } = where;
  return scenarioRequests(ctx.ep, scenario, rest).find((item) => (k === undefined || item.info.k === k)
    && (j === undefined || item.info.j === j));
};

/** @brief 在输入框里写一条 /team 命令并按 Enter，等开关变成 want。 */
async function teamCommand(ctx, tab, text, want) {
  await sendMessage(ctx, tab, text);
  await ctx.page.waitForFunction(({ css, mode }) => document.querySelector(css)?.dataset.mode === mode,
    { css: `${paneSel(tab)} [data-testid="team-switch"]`, mode: want }, { timeout: 10000 });
}

/**
 * @brief 在 project 里开一个新会话（on 时先 /team on），然后发第一条消息（team 时以 /team 发出）；
 *        返回 { tab, sessionId, sessionFile, since }，并记进 ctx.watched。
 */
async function begin(ctx, project, text, { team = false, on = false } = {}) {
  const tab = await openSessionIn(ctx, project);
  if (on) await teamCommand(ctx, tab, '/team on', 'always');
  const since = Date.now();
  await sendMessage(ctx, tab, text, { team });
  const who = { tab, ...(await userSession(ctx, tab)), since };
  ctx.watched.set(who.sessionId, who);
  return who;
}

/** @brief 输入框此刻的文字与引用芯片。 */
async function composerOf(ctx, tab) {
  const pane = await paneState(ctx.page, tab);
  return { draft: pane.draft, chips: (await quoteChipsOf(ctx, tab)).length, users: pane.users.length };
}

/** @brief 排队区的每一行：{ kind（种类文字）, text, pending（data-pending）, deciding（data-deciding） }。 */
function queueRows(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="queue"] li`).evaluateAll((els) => els.map((el) => ({
    kind: el.querySelector('.queue-kind')?.textContent ?? '', text: el.querySelector('.queue-text')?.textContent ?? '',
    pending: el.dataset.pending === 'true', deciding: el.dataset.deciding === 'true' })));
}

/** @brief 在页面里记下每个会话面板排队区的变化（window.__tbQueue[tab]：每项 { t, rows: "种类|文字|标记" 的列表 }）。 */
function watchQueues(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__tbQueue) return;
    window.__tbQueue = {};
    const scan = () => {
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const rows = [...pane.querySelectorAll('[data-testid="queue"] li')].map((el) => [
          el.querySelector('.queue-kind')?.textContent ?? '', el.querySelector('.queue-text')?.textContent ?? '',
          el.dataset.pending === 'true' ? 'pending' : el.dataset.deciding === 'true' ? 'deciding' : ''].join('|'));
        const list = window.__tbQueue[pane.dataset.tab] ?? (window.__tbQueue[pane.dataset.tab] = []);
        if (JSON.stringify(list.at(-1)?.rows ?? []) !== JSON.stringify(rows)) list.push({ t: Date.now(), rows });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  });
}

/** @brief watchQueues 记下的某个会话面板的排队区变化。 */
const queueHistory = (ctx, tab) => ctx.page.evaluate((key) => window.__tbQueue?.[key] ?? [], tab);

/** @brief 阶段行此刻的 { kind（data-kind）, text }；没有阶段行时为 null。 */
function stageNow(ctx, tab) {
  return ctx.page.evaluate((css) => {
    const stage = document.querySelector(css);
    return stage ? { kind: stage.dataset.kind ?? null, text: stage.textContent ?? '' } : null;
  }, `${paneSel(tab)} [data-testid="stage"]`);
}

/** @brief 侧栏里这个会话那一行的状态（data-status）；没有状态点时为 null。 */
const sidebarStatus = (ctx, tab) => ctx.page.locator(`.session-item[data-row="${tab}"] [data-testid="session-status"]`)
  .first().getAttribute('data-status', { timeout: 2000 }).catch(() => null);

/** @brief Stop team 按钮是否显示。 */
const stopTeamShown = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="stop-team"]`).isVisible();

/** @brief 用户会话里第一条文字含 text 的 user 消息的下标；没有时 -1。 */
const userAt = (entries, text) => entries.findIndex((entry) => entry.type === 'message'
  && entry.message.role === 'user' && textOf(entry.message).includes(text));

/** @brief 下标 from 之后第一条助手消息的下标；没有时 -1。 */
const assistantAfter = (entries, from) => entries.findIndex((entry, index) => index > from && entry.type === 'message'
  && entry.message.role === 'assistant');

/** @brief 会话条目里 mori.receipt 条目的下标（可按 kind 筛）。 */
const receiptIndexes = (entries, kind = null) => entries.flatMap((entry, index) => (entry.type === 'custom'
  && entry.customType === 'mori.receipt' && (kind === null || entry.data?.kind === kind) ? [index] : []));

// ---------- 准备 ----------

/** @brief 扩展命令 /tbcmd 的源码（synthetic）：用 sendUserMessage 开始一次运行，文字带场景标记与参数。 */
function commandExtension() {
  return ['// synthetic: written by tests/ui/tb-app-modes.mjs; an extension command that starts a run (§5.3).',
    'export default function (pi) {',
    "  pi.registerCommand('tbcmd', { description: 'Starts a run with sendUserMessage (synthetic).',",
    `    async handler(args) { pi.sendUserMessage(${JSON.stringify(MODES_TEXT.cmdText)} + ' ' + (args ?? '')); },`,
    '  });', '}', ''].join('\n');
}

/** @brief 分开配置的项目另有的资源（synthetic）：同名模板 team.md、模板 tbtmpl.md、扩展命令 tbcmd。 */
function writeProjectResources(project) {
  mkdirSync(join(project, '.pi', 'prompts'), { recursive: true });
  writeFileSync(join(project, '.pi', 'prompts', 'team.md'),
    `---\ndescription: "A template named team (synthetic)"\n---\n${MODES_TEXT.teamTemplate} $@\n`);
  writeFileSync(join(project, '.pi', 'prompts', 'tbtmpl.md'),
    `---\ndescription: "A test template (synthetic)"\n---\n${MODES_TEXT.tmplBody} $@\n`);
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'tbcmd.ts'), commandExtension());
}

/** @brief 测试准备（synthetic test setup）：三个临时项目、角色文件与资源，数据目录与合成端点。 */
async function setup(ctx) {
  ctx.split = tempProject('mori-tb-modes-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  writeProjectResources(ctx.split);
  ctx.merged = tempProject('mori-tb-modes-merged-');
  ctx.held = tempProject('mori-tb-modes-held-');
  writeRoles(ctx.held, [
    { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'],
      models: ['tbq'] },
    { name: 'planner', description: 'Decides how to split each request and closes it', seats: ['create', 'close'],
      models: ['tbb'] },
    { name: 'executor', description: 'Changes code and runs commands to finish a task', models: ['tbq', 'tbb'] },
  ]);
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, {
    providers: [tbProvider('tba', PROXY, [tbModel(MODEL_A)]), tbProvider('tbb', PROXY, [tbModel(MODEL_B)]),
      tbProvider('tbq', PROXY, [tbModel(MODEL_Q)], { concurrency: 1 })],
    trusted: [ctx.split, ctx.held],
  });
  await startApp(ctx);
}

/** @brief 启动 App，装上事件顺序与排队区的记录。 */
async function startApp(ctx) {
  await startTbApp(ctx);
  await captureOrder(ctx);
  await watchQueues(ctx);
}

// ---------- TB-05：/team <文字> 进入 once，条件满足的对话回合结束时回到 off；TB-07、TB-08 分开时 ----------

/** @brief 关闭模式下一条回复，引用其中一段，再 /team <文字>：once、去掉前缀、带芯片、同名模板不展开、回到 off。 */
async function once(ctx) {
  const scenario = 'tb-modes-once';
  const who = await begin(ctx, ctx.split, `Tell me something quotable tb-scenario:${scenario}`);
  ctx.flow.once = who;
  await settle(ctx, who, 60000);
  await quoteReply(ctx, who.tab, 'QUOTE-ME alpha beta');
  const sentAt = Date.now();
  await sendMessage(ctx, who.tab, `Register this please tb-scenario:${scenario}`, { team: true });
  const entered = await poll(async () => {
    const sw = await teamSwitch(ctx, who.tab);
    return sw.mode === 'once' ? sw : null;
  }, 10000, 50);
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 2 });
  await paneIdle(ctx, who.tab);
  const midway = { sw: await teamSwitch(ctx, who.tab), board: readBoard(ctx, who.sessionId) };
  await settle(ctx, who, 90000);
  const after = await teamSwitch(ctx, who.tab);
  await onceEntered(ctx, who, { entered, sentAt });
  await onceEnded(ctx, who, { midway, after });
  await splitReceipt(ctx, who, 'Register this please', 'Planner registered request 1.');
}

/** @brief TB-05：once 的开关、去掉前缀与带芯片、同名模板不展开；TB-07：需求记下这条消息全文。 */
async function onceEntered(ctx, who, obs) {
  const entries = userEntries(who);
  const sent = userTexts(entries)[1] ?? '';
  const pane = await paneState(ctx.page, who.tab);
  const create = requestAt(ctx, 'tb-modes-once', { agent: 'planner', kind: 'create', k: 1, j: 0 });
  record('TB-05 /team <text> enters once: right after sending, the switch reads "Team: Until done" '
    + '(data-mode once, aria-checked true) and the message goes to planner first',
  obs.entered?.text === 'Team: Until done' && obs.entered.checked === 'true' && create !== undefined,
  brief({ entered: obs.entered, create: create?.info.last?.slice(0, 80) }));
  record('TB-05 the message sent with /team <text> has the prefix removed and carries the quote chip: the session '
    + 'file, the bubble and planner\'s delivery have the quoted text and "Register this please", none has "/team"',
  sent.includes('QUOTE-ME alpha beta') && sent.endsWith('Register this please tb-scenario:tb-modes-once')
    && !sent.includes('/team')
    && !pane.users.some((text) => text.includes('/team')) && pane.users.some((text) => text.includes('Register this'))
    && (create?.info.last ?? '').includes(`${NEW_MESSAGE}`) && !(create?.info.last ?? '').includes('/team'),
  brief({ sent, users: pane.users, last: create?.info.last }));
  const leaked = ctx.ep.proxy.captures.filter((item) => item.t >= obs.sentAt
    && JSON.stringify(item.body ?? {}).includes(MODES_TEXT.teamTemplate));
  record('TB-05 a prompt template named team (.pi/prompts/team.md) is not expanded by /team <text>: no request after '
    + 'the send contains its text and planner\'s delivery has no "Expanded from /team"', leaked.length === 0
    && !(create?.info.last ?? '').includes('Expanded from /team'), brief({ leaked: leaked.length }));
  const words = readBoard(ctx, who.sessionId)?.requests[0]?.words ?? [];
  record('TB-07 by default the request records the full text of this message (quote block and text, as written '
    + 'to the session)', words.length === 1 && words[0].kind === 'original' && words[0].text === sent,
  brief({ words, sent }));
}

/** @brief TB-05：请求还开着时仍是 once；需求关闭、汇报的那个对话回合结束时回到 off（不早于它）。 */
async function onceEnded(ctx, who, obs) {
  const order = await orderOf(ctx, who.sessionId, who.since);
  const wakeAt = order.findIndex((item) => item.type === 'mori.wake');
  const settledAt = order.findIndex((item, index) => index > wakeAt && item.type === 'agent_settled');
  const modes = order.flatMap((item, index) => (item.type === 'mori.team_state' ? [[index, item.data.mode]] : []));
  const onceAt = modes.find(([, mode]) => mode === 'once')?.[0] ?? -1;
  const firstOff = modes.find(([index, mode]) => mode === 'off' && index > onceAt);
  const onceSeen = onceAt >= 0;
  record('TB-05 once returns to off when the dialog turn in which the conditions hold ends: still "Team: Until '
    + 'done" after the reply to the /team message (request 1 open), and the first mori.team_state with mode off '
    + 'comes after the agent_settled of the reporting turn (request closed); the switch then reads "Team: Off"',
  obs.midway.sw.mode === 'once' && obs.midway.board?.requests[0]?.status === 'open' && onceSeen && wakeAt >= 0
    && settledAt > wakeAt && firstOff !== undefined && firstOff[0] > settledAt && obs.after.mode === 'off'
    && obs.after.text === 'Team: Off',
  brief({ midway: obs.midway.sw.mode, status: obs.midway.board?.requests[0]?.status, wakeAt, settledAt,
    firstOff, after: obs.after.text }));
}

/** @brief TB-08 分开时：回执紧跟你的消息、在对话的回复之前（对话流、会话文件、事件的顺序）。 */
async function splitReceipt(ctx, who, userText, replyText) {
  const items = await transcriptItems(ctx, who.tab);
  const user = items.findIndex((item) => item.kind === 'user' && item.text.includes(userText));
  const entries = userEntries(who);
  const userIndex = userAt(entries, userText);
  const receipt = receiptIndexes(entries).find((index) => index > userIndex) ?? -1;
  const reply = assistantAfter(entries, userIndex);
  const events = await kernelEvents(ctx, who.sessionId, null, who.since);
  const userEnd = events.findIndex((item) => item.type === 'message_end' && item.role === 'user'
    && item.text.includes(userText));
  const receiptEvent = events.findIndex((item, index) => index > userEnd && item.type === 'mori.receipt');
  const replyStart = events.findIndex((item, index) => index > userEnd && item.type === 'message_start'
    && item.role === 'assistant');
  record('TB-08 split session: the receipt follows the user message and comes before the dialog\'s reply — on screen '
    + '(message, receipt, reply), in the session file (user message, mori.receipt, assistant message) and in the '
    + 'events (user message_end, mori.receipt, assistant message_start)',
  user >= 0 && items[user + 1]?.kind === 'receipt' && items[user + 1].text.startsWith('Request 1 registered · ')
    && items[user + 2]?.kind === 'assistant' && items[user + 2].text.startsWith(replyText)
    && userIndex >= 0 && receipt > userIndex && reply > receipt && userEnd >= 0 && receiptEvent > userEnd
    && replyStart > receiptEvent,
  brief({ items: streamShape(items), userIndex, receipt, reply, userEnd, receiptEvent, replyStart }));
}

// ---------- TB-05：开关、/team on、/team off、只有 /team；F8 ----------

/** @brief 开关与 /team 命令（脚本 tb-modes-switch）：三种文字、不发消息、清空输入框、只有 /team 不发送。 */
async function switching(ctx) {
  const who = await begin(ctx, ctx.split, 'Quote source tb-scenario:tb-modes-switch');
  ctx.flow.switching = who;
  await settle(ctx, who, 60000);
  const requests = () => ctx.ep.proxy.captures.filter((item) => item.chat).length;
  const initial = await teamSwitch(ctx, who.tab);
  const clickedOn = await clickTeamSwitch(ctx, who.tab, 'always');
  const clickedOff = await clickTeamSwitch(ctx, who.tab, 'off');
  const before = { ...(await composerOf(ctx, who.tab)), requests: requests() };
  await teamCommand(ctx, who.tab, '/team on', 'always');
  const afterOn = { ...(await composerOf(ctx, who.tab)), sw: await teamSwitch(ctx, who.tab) };
  await teamCommand(ctx, who.tab, '  /TEAM Off  ', 'off');
  const afterOff = { ...(await composerOf(ctx, who.tab)), sw: await teamSwitch(ctx, who.tab) };
  await quoteReply(ctx, who.tab, 'CHIP-SOURCE one two');
  await sendMessage(ctx, who.tab, '/team');
  await sleep(1500);
  const bare = { ...(await composerOf(ctx, who.tab)), sw: await teamSwitch(ctx, who.tab), requests: requests() };
  await teamCommand(ctx, who.tab, '/team on', 'always');
  const chipOn = await composerOf(ctx, who.tab);
  await sleep(500);
  const quiet = { requests: requests(), users: (await paneState(ctx.page, who.tab)).users.length };
  const obs = { initial, clickedOn, clickedOff, before, afterOn, afterOff, bare, chipOn, quiet };
  switchChecks(ctx, who, obs);
}

/** @brief switching 的检查。 */
function switchChecks(ctx, who, obs) {
  const { initial, clickedOn, clickedOff, before, afterOn, afterOff, bare, chipOn, quiet } = obs;
  record('TB-05 the switch enters always: "Team: Off" → click → "Team: On" (aria-checked true) → click (nothing '
    + 'open) → "Team: Off"', initial.mode === 'off' && initial.text === 'Team: Off' && clickedOn.mode === 'always'
    && clickedOn.text === 'Team: On' && clickedOn.checked === 'true' && clickedOff.mode === 'off'
    && clickedOff.checked === 'false', brief({ initial, clickedOn, clickedOff }));
  record('TB-05 /team on enters always without sending: the input is cleared, no new bubble, no model request',
    afterOn.sw.mode === 'always' && afterOn.sw.text === 'Team: On' && afterOn.draft === ''
    && afterOn.users === before.users, brief({ afterOn, before }));
  record('TB-05 /team off (any case, with spaces around) sends nothing and clears the input: Team: Off, same bubbles',
    afterOff.sw.mode === 'off' && afterOff.draft === '' && afterOff.users === before.users,
  brief({ afterOff }));
  record('TB-05 only /team sends nothing and leaves the input as it was (the text "/team" and the quote chip stay; '
    + 'no model request, the mode stays off)', bare.draft === '/team' && bare.chips === 1
    && bare.users === before.users && bare.requests === before.requests && bare.sw.mode === 'off',
  brief({ bare, before }));
  record('TB-05 /team on with a quote chip in the input still works: always, the text is cleared (the chip is kept, '
    + 'team-switch.md), and none of the commands reached the model', chipOn.draft === ''
    && quiet.requests === before.requests && quiet.users === before.users,
  brief({ chipOn, quiet, before: before.requests }));
  const modes = customOf(userEntries(who), 'mori.team');
  record('TB-05 every mode change is written as a mori.team entry: always, off, always, off, always (entering from '
    + 'off records the tools in use)',
  same(modes.map((item) => item.mode), ['always', 'off', 'always', 'off', 'always'])
    && Array.isArray(modes[0]?.tools) && modes[0].tools.includes('bash'), brief(modes));
}

/** @brief Markdown 里"## 标题"下的内容。 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim());
}

/** @brief TB-05：F8 报告的“Recent activity”记 Team on、Team off 与 Send (team)。 */
async function issueReport(ctx) {
  const tab = ctx.flow.switching?.tab;
  if (!tab) throw new Error('switching did not run');
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).press('F8');
  const dialog = ctx.page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill('Team mode check');
  await dialog.getByTestId('issue-expect').fill('Team actions are listed');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = ctx.page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const path = /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  const md = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  await ctx.page.keyboard.press('Escape');
  const actions = section(md, 'Recent activity');
  const team = actions.filter((line) => /Team (on|off)|Send \(team\)/.test(line));
  record('TB-05 F8 records the mode changes as "Team on" / "Team off" (the switch and /team on, /team off) and the '
    + '/team <text> send as "Send (team): …" without the prefix', team.filter((line) => line.endsWith('Team on'))
    .length >= 3 && team.filter((line) => line.endsWith('Team off')).length >= 2
    && team.some((line) => line.includes('Send (team): ') && !line.includes('/team')),
  brief({ path, team }));
}

// ---------- TB-05：回到 off 的条件三项各缺一项 ----------

/** @brief 只缺“没有未关闭的需求”（脚本 tb-modes-open）：task 还在做、待判断为空、立项空闲时关掉 → once，之后回到 off。 */
async function unmetOpen(ctx) {
  const scenario = 'tb-modes-open';
  const who = await begin(ctx, ctx.split, `Open request test tb-scenario:${scenario}`, { on: true });
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 1 });
  await paneIdle(ctx, who.tab);
  const info = await liveInfo(ctx, who.sessionFile);
  const sw = await clickTeamSwitch(ctx, who.tab);
  const board = readBoard(ctx, who.sessionId);
  await settle(ctx, who, 90000);
  const after = await teamSwitch(ctx, who.tab);
  record('TB-05 return to off is missing only "no open request" (T1 still running, nothing deciding, planner idle): '
    + 'turning the switch off gives once ("Team: Until done"); it returns to off when request 1 is done',
  board?.requests[0]?.status === 'open' && info.deciding.queue.length === 0 && info.deciding.since === null
    && sw.mode === 'once' && sw.text === 'Team: Until done' && after.mode === 'off',
  brief({ status: board?.requests[0]?.status, deciding: info.deciding, sw, after: after.mode }));
}

/** @brief 只缺“待判断队列为空”（脚本 tb-modes-queue）：planner 在跑程序唤醒的回合，你的消息在等，没有需求。 */
async function unmetQueue(ctx) {
  const scenario = 'tb-modes-queue';
  const who = await begin(ctx, ctx.split, `Queue test tb-scenario:${scenario}`, { on: true });
  await waitLine(ctx, scenario, { agent: 'planner', kind: 'create', k: 2 });
  await paneIdle(ctx, who.tab);
  await sendMessage(ctx, who.tab, 'Second message in the queue test');
  const info = await poll(async () => {
    const live = await liveInfo(ctx, who.sessionFile);
    return live.deciding.queue.length === 1 && live.deciding.since === null ? live : null;
  }, 5000, 50);
  const sw = await clickTeamSwitch(ctx, who.tab);
  const board = readBoard(ctx, who.sessionId);
  await settle(ctx, who, 60000);
  const after = await teamSwitch(ctx, who.tab);
  record('TB-05 return to off is missing only "the deciding queue is empty" (your message waits while planner runs '
    + 'a program-woken turn: since null, no request): turning off gives once; it returns to off after that message',
  info !== null && (board?.requests.length ?? 0) === 0 && sw.mode === 'once' && after.mode === 'off',
  brief({ deciding: info?.deciding, requests: board?.requests.length ?? 0, sw: sw.mode, after: after.mode }));
}

/** @brief 只缺“立项没有在判断的消息”（合并会话，脚本 tb-modes-judging）：判断在这次运行里，关掉 → once。 */
async function unmetJudging(ctx) {
  const scenario = 'tb-modes-judging';
  const who = await begin(ctx, ctx.merged, `Judging test tb-scenario:${scenario}`, { on: true });
  ctx.flow.judging = who;
  await waitLine(ctx, scenario, { agent: 'mori', kind: 'merged-create', k: 1 });
  const info = await liveInfo(ctx, who.sessionFile);
  const sw = await clickTeamSwitch(ctx, who.tab);
  await settle(ctx, who, 60000);
  const after = await teamSwitch(ctx, who.tab);
  const board = readBoard(ctx, who.sessionId);
  record('TB-05 return to off is missing only "create is not judging a message" (merged session: the judgment runs '
    + 'in this reply; nothing deciding, no request): turning off during the reply gives once; it returns to off '
    + 'when that turn ends', info.deciding.queue.length === 0 && (board?.requests.length ?? 0) === 0
    && sw.mode === 'once' && after.mode === 'off', brief({ deciding: info.deciding, sw: sw.mode, after: after.mode }));
  const stages = await stagesOf(ctx.page, who.tab, who.since);
  record('TB-54 merged session: the stage line never shows "<create role> is deciding…" (the judgment is the '
    + 'dialog\'s own reply)', stages.length > 0 && !stages.some((item) => item.v.startsWith('deciding|')
    || item.v.includes('is deciding')), brief(stages.map((item) => item.v)));
}

// ---------- TB-05：运行中改模式 ----------

/** @brief 一个请求的工具、工作卡与段（检查的 detail）。 */
const shapeOf = (request) => ({ kind: request?.info.kind, tools: request?.tools, card: cardOf(request) !== '',
  team: request?.system.includes(TEAM_DIALOG), off: request?.system.includes(OFF_DIALOG) });

/** @brief 关闭模式下对话的请求：有写入与命令类工具与 agent_message、没有 TaskBoard 读取工具、没有工作卡、关闭模式的段。 */
const offShape = (request) => request !== undefined && request.info.kind === 'off-dialog'
  && WRITE_TOOLS.every((name) => request.tools.includes(name)) && request.tools.includes('agent_message')
  && !request.tools.includes('board_read') && cardOf(request) === '' && request.system.includes(OFF_DIALOG)
  && !request.system.includes(TEAM_DIALOG) && !request.system.includes(SHARED_PART);

/** @brief 协作模式下对话的请求：只有读取类、三个 TaskBoard 工具与 finish，有工作卡、协作模式的对话段与共用段。 */
const teamShape = (request) => request !== undefined && request.info.kind === 'team-dialog'
  && request.tools.every((name) => TEAM_DIALOG_TOOLS.includes(name)) && request.tools.includes('board_read')
  && cardOf(request).startsWith(CARD_OPEN) && request.system.includes(TEAM_DIALOG)
  && request.system.includes(SHARED_PART);

/** @brief 关闭模式的运行中打开协作模式（脚本 tb-modes-runon）：这次运行不变，下一条按协作模式。 */
async function runOn(ctx) {
  const scenario = 'tb-modes-runon';
  const who = await begin(ctx, ctx.split, `Run mode test tb-scenario:${scenario}`);
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'off-dialog', k: 1, j: 0 });
  const clickAt = Date.now();
  const sw = await clickTeamSwitch(ctx, who.tab, 'always');
  await settle(ctx, who, 60000);
  await sendMessage(ctx, who.tab, 'Now in team mode');
  await settle(ctx, who, 60000);
  const first = requestAt(ctx, scenario, { agent: 'chat', k: 1, j: 0 });
  const second = requestAt(ctx, scenario, { agent: 'chat', k: 1, j: 1 });
  const next = requestAt(ctx, scenario, { agent: 'chat', k: 2, j: 0 });
  record('TB-05 turning team mode on during an off-mode run does not change that run: its second request (after the '
    + 'switch read "Team: On") still has bash, edit, write and agent_message, no work card and the off-mode section; '
    + 'the next message runs with the team-mode tools, the work card and the team-dialog section',
  sw.mode === 'always' && offShape(first) && offShape(second) && second.t > clickAt && teamShape(next),
  brief({ first: shapeOf(first), second: shapeOf(second), late: (second?.t ?? 0) - clickAt, next: shapeOf(next) }));
}

/** @brief 协作模式的运行中关掉（脚本 tb-modes-runoff）：这次运行不变，下一条按关闭模式。 */
async function runOff(ctx) {
  const scenario = 'tb-modes-runoff';
  const who = await begin(ctx, ctx.split, `Run off test tb-scenario:${scenario}`, { on: true });
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 1, j: 0 });
  const clickAt = Date.now();
  const sw = await clickTeamSwitch(ctx, who.tab, 'off');
  await settle(ctx, who, 60000);
  await sendMessage(ctx, who.tab, 'Now back in off mode');
  await settle(ctx, who, 60000);
  const second = requestAt(ctx, scenario, { agent: 'chat', k: 1, j: 1 });
  const next = requestAt(ctx, scenario, { agent: 'chat', k: 2, j: 0 });
  record('TB-05 turning team mode off during a team-mode run does not change that run: its second request (after '
    + 'the switch read "Team: Off") still has only the reading and TaskBoard tools (and finish), the work card and '
    + 'the team-dialog section; the next message runs with bash, edit, write again and no card',
  sw.mode === 'off' && teamShape(second) && second.t > clickAt && offShape(next),
  brief({ second: shapeOf(second), late: (second?.t ?? 0) - clickAt, next: shapeOf(next) }));
}

// ---------- TB-06、TB-07、TB-08：立项的决定 ----------

/** @brief 一次判断一种决定、先记原话、两条消息各自一次判断、没做决定按直接回答（脚本 tb-modes-decide）。 */
async function decide(ctx) {
  const scenario = 'tb-modes-decide';
  const who = await begin(ctx, ctx.split, `Register two requests tb-scenario:${scenario}`, { on: true });
  ctx.flow.decide = who;
  const judging = await waitLine(ctx, scenario, { agent: 'planner', kind: 'create', k: 1, j: 0 });
  await sendMessage(ctx, who.tab, 'Just a question about the plan');
  await sendMessage(ctx, who.tab, 'Add a constraint: keep it short');
  const sentAt = Date.now();
  await settle(ctx, who, 120000);
  const create = instanceEntries(ctx, who, 'create');
  await decideRules(ctx, who, create);
  await decideJudgments(ctx, who, { judging, sentAt });
  await decideCards(ctx, who);
}

/** @brief TB-06：另一类决定被拒绝、同一类可以多次；task_create 要先记原话。 */
async function decideRules(ctx, who, create) {
  const submit = resultsOf(create, 'request_submit');
  const cancel = resultsOf(create, 'request_cancel');
  const reply = resultsOf(create, 'reply_via_dialog');
  const tasks = resultsOf(create, 'task_create');
  const update = resultsOf(create, 'request_update');
  record('TB-06 one decision per judgment: after request_submit, request_cancel and reply_via_dialog are refused with '
    + '"This message already has a decision: new request (request_submit)" while a second request_submit is '
    + 'accepted; in another judgment after request_update, reply_via_dialog is refused as "supplement"',
  submit.length === 2 && submit.every((item) => !item.error) && cancel.length === 1 && cancel[0].error
    && cancel[0].text.includes('This message already has a decision: new request (request_submit)')
    && reply.length === 2 && reply.every((item) => item.error)
    && reply[0].text.includes('This message already has a decision: new request (request_submit)')
    && reply[1].text.includes('This message already has a decision: supplement (request_update)')
    && update.length === 1 && !update[0].error, brief({ submit, cancel, reply, update }));
  record('TB-06 task_create before request_submit or request_update in this judgment is refused with "Record the '
    + 'user\'s words first…"; after request_submit it works', tasks.length === 3 && tasks[0].error
    && tasks[0].text.includes(RECORD_FIRST) && !tasks[1].error && !tasks[2].error, brief(tasks));
  const board = readBoard(ctx, who.sessionId);
  const words = board?.requests[0]?.words ?? [];
  record('TB-07 by default the words are the full user message: request 1 has the first message as original and '
    + 'the third ("Add a constraint: keep it short") as supplement, exactly as typed',
  words.length === 2 && words[0].text === 'Register two requests tb-scenario:tb-modes-decide'
    && words[1].kind === 'supplement' && words[1].text === 'Add a constraint: keep it short', brief(words));
}

/** @brief TB-06：立项判断第一条时又来的两条消息各自一次判断（各一次投递、一次运行，按顺序）；TB-08 没写入没有回执。 */
async function decideJudgments(ctx, who, obs) {
  const scenario = 'tb-modes-decide';
  const second = requestAt(ctx, scenario, { agent: 'planner', kind: 'create', k: 2, j: 0 });
  const third = requestAt(ctx, scenario, { agent: 'planner', kind: 'create', k: 3, j: 0 });
  const firstEnd = scenarioLines(ctx.ep, scenario, { agent: 'planner', kind: 'create' })
    .filter((line) => line.k === 1).at(-1);
  const count = (text) => (text ?? '').split(NEW_MESSAGE).length - 1;
  record('TB-06 split session: two messages sent while planner judges the first each get their own judgment — '
    + 'planner\'s 2nd delivery has only "Just a question…", its 3rd only "Add a constraint…", one "New user message" '
    + 'each, in that order and both after the first judgment ended',
  obs.sentAt < firstEnd.t && second !== undefined && third !== undefined && count(second.info.last) === 1
    && second.info.last.includes(`${NEW_MESSAGE}Just a question about the plan`) && count(third.info.last) === 1
    && third.info.last.includes(`${NEW_MESSAGE}Add a constraint: keep it short`) && second.t > firstEnd.t
    && third.t > second.t, brief({ second: second?.info.last, third: third?.info.last }));
  const items = await transcriptItems(ctx, who.tab);
  const question = items.findIndex((item) => item.kind === 'user' && item.text.includes('Just a question'));
  const receipts = (await receiptsOf(ctx, who.tab)).map((item) => `${item.kind}:${item.text}`);
  record('TB-08 no receipt when planner writes nothing: the message answered directly has no receipt after it; the '
    + 'receipts are exactly the three writes (two registered, one added)', question >= 0
    && items[question + 1]?.kind !== 'receipt' && same(receipts, ['registered:Request 1 registered · First request',
      'registered:Request 2 registered · Second request',
      'added:Added to request 1: “Add a constraint: keep it short”']),
  brief({ items: streamShape(items), receipts }));
}

/** @brief TB-06：对话的工作卡带立项的决定（没做决定按直接回答）。 */
async function decideCards(ctx) {
  const scenario = 'tb-modes-decide';
  const line = (text) => cardOf(scenarioRequests(ctx.ep, scenario, { agent: 'chat', kind: 'team-dialog' })
    .find((item) => item.info.j === 0 && item.info.last === text)).split(/\r?\n/)
    .find((row) => row.startsWith('For this message')) ?? null;
  const cards = [`Register two requests tb-scenario:${scenario}`, 'Just a question about the plan',
    'Add a constraint: keep it short'].map(line);
  record('TB-06 a judgment with no decision counts as answering directly: the dialog card for "Just a question…" '
    + 'reads "planner decided: no collaboration needed; answer directly" with planner\'s note; the others name the '
    + 'new requests and the supplement', same(cards, [
    'For this message planner decided: new request (Request 1, Request 2); their note: "Two requests registered."',
    'For this message planner decided: no collaboration needed; answer directly; their note: "No work needed."',
    'For this message planner decided: supplement to Request 1; their note: "Added the constraint."']), brief(cards));
}

/** @brief 立项出错、没有 task 的提醒与结案、程序唤醒回合的规则、quote、程序唤醒回合的回执（脚本 tb-modes-error）。 */
async function error(ctx) {
  const who = await begin(ctx, ctx.split, MODES_TEXT.longMessage, { team: true });
  ctx.flow.error = who;
  await settle(ctx, who, 120000);
  const create = instanceEntries(ctx, who, 'create');
  const close = instanceEntries(ctx, who, 'close.1');
  await errorDecision(ctx, who, create, close);
  await errorProgramTurn(ctx, who, create);
  await errorReceipts(ctx, who);
}

/** @brief TB-06：出错时已做的写入有效、对话卡片 couldn't decide；没有 task 时提醒一次，仍没有时唤醒结案。 */
async function errorDecision(ctx, who, create, close) {
  const card = cardOf(requestAt(ctx, 'tb-modes-error', { agent: 'chat', kind: 'team-dialog', k: 1, j: 0 }));
  const decision = card.split(/\r?\n/).find((text) => text.startsWith('For this message')) ?? '';
  const board = readBoard(ctx, who.sessionId);
  const receipts = await receiptsOf(ctx, who.tab);
  record('TB-06 when the judging turn fails (HTTP 400 after request_submit) the write stands — request 1 is on the '
    + 'board and its receipt is shown — and the dialog card reads "planner couldn\'t decide: <the error>"',
  decision.startsWith("For this message planner couldn't decide: ") && decision.includes('400')
    && board?.requests[0]?.title === 'Release notes' && receipts[0]?.text === 'Request 1 registered · Release notes',
  brief({ decision, title: board?.requests[0]?.title, receipts: receipts.map((item) => item.text) }));
  const reminders = userTexts(create).filter((text) => text.includes('[Mori] Request 1 has no tasks.'));
  const closeFirst = userTexts(close)[0] ?? '';
  record('TB-06 a new request with no task when the judgment ends gets exactly one reminder in planner\'s session '
    + '("[Mori] Request 1 has no tasks. Split it with task_create now."); still none after that turn wakes the '
    + 'close session with "[Mori] Request 1 has no tasks."', reminders.length === 1
    && reminders[0].includes('[Mori] Request 1 has no tasks. Split it with task_create now.')
    && closeFirst.startsWith('[Mori] Request 1 has no tasks.') && board?.requests[0]?.status === 'failed',
  brief({ reminders, closeFirst: closeFirst.slice(0, 80), status: board?.requests[0]?.status }));
}

/** @brief TB-06、TB-07：程序唤醒的回合不能登记、撤销；quote 必须给出且必须是你说过的原文（空白按一个空格比较）。 */
async function errorProgramTurn(ctx, who, create) {
  const submit = resultsOf(create, 'request_submit');
  const cancel = resultsOf(create, 'request_cancel');
  const update = resultsOf(create, 'request_update');
  record('TB-06 in a program-woken create turn (the no-task reminder) request_submit and request_cancel are refused '
    + 'with "Only a user message can register or cancel a request."', submit.length === 2 && !submit[0].error
    && submit[1].error && submit[1].text.includes(USER_ONLY) && cancel.length === 1 && cancel[0].error
    && cancel[0].text.includes(USER_ONLY), brief({ submit, cancel }));
  record('TB-07 in a program-woken turn request_update without quote is refused ("quote is required…")',
    update[0]?.error === true && update[0].text.includes(QUOTE_REQUIRED), brief(update[0]));
  const words = readBoard(ctx, who.sessionId)?.requests[0]?.words ?? [];
  const original = MODES_TEXT.longMessage.slice(MODES_TEXT.longMessage.indexOf('Plan the'));
  record('TB-07 quote must be the user\'s exact words: words the user never said are refused ("quote must be the '
    + 'user\'s exact words"); a fragment of your message written with single spaces is accepted and recorded with '
    + 'your own spacing', update[1]?.error === true && update[1].text.includes(QUOTE_MISMATCH)
    && update[2]?.error === false && words[1]?.text === original, brief({ update, words }));
}

/** @brief TB-08：程序唤醒回合的回执在写入时的末尾；补充的回执截到 120 个字符。 */
async function errorReceipts(ctx, who) {
  const items = await transcriptItems(ctx, who.tab);
  const added = items.findIndex((item) => item.kind === 'receipt' && item.text.startsWith('Added to request 1'));
  const progress = items.findIndex((item) => item.kind === 'progress');
  const reply = items.findIndex((item) => item.kind === 'assistant');
  const order = await orderOf(ctx, who.sessionId, who.since);
  const settledAt = order.findIndex((item) => item.type === 'agent_settled');
  const receiptAt = order.findIndex((item) => item.type === 'mori.receipt' && item.data.kind === 'added');
  const wakeAt = order.findIndex((item) => item.type === 'mori.wake');
  record('TB-08 a program-woken create turn writes its receipt at the end of the conversation at write time: '
    + 'after the dialog\'s reply and the progress summary (the dialog was idle: the receipt event comes after the '
    + 'reply\'s agent_settled and before the request_closed report)', added > progress && progress > reply
    && reply >= 0 && settledAt >= 0 && receiptAt > settledAt && wakeAt > receiptAt,
  brief({ items: streamShape(items), settledAt, receiptAt, wakeAt }));
  const receipt = (await receiptsOf(ctx, who.tab)).find((item) => item.kind === 'added');
  const words = MODES_TEXT.longMessage.slice(MODES_TEXT.longMessage.indexOf('Plan the'));
  const shown = `Added to request 1: “${[...words].slice(0, 120).join('')}…”`;
  record('TB-08 the "added" receipt quotes the words cut to 120 characters with "…" (§13.2), "Request 1 '
    + 'registered · <title>" for the registration', receipt?.text === shown
    && (await receiptsOf(ctx, who.tab))[0]?.text === 'Request 1 registered · Release notes',
  brief({ text: receipt?.text, want: shown }));
}

// ---------- TB-11：立项看着整个对话 ----------

/** 两条超过一半上限的关闭模式消息（synthetic） */
const BIG_A = `BIG-A-START ${'a'.repeat(7000)}`;
const BIG_B = `BIG-B-START ${'b'.repeat(7000)}`;

/** @brief 立项第 k 次投递的文字（最后一次投递，去掉工作卡）。 */
const createDelivery = (ctx, k) => requestAt(ctx, 'tb-modes-catch', { agent: 'planner', kind: 'create', k, j: 0 })
  ?.info.last ?? '';

/** @brief 关闭模式的对话（含工具调用与思考）、两次 /team，再两条很长的关闭模式消息与第三次 /team（脚本 tb-modes-catch）。 */
async function catchUp(ctx) {
  const scenario = 'tb-modes-catch';
  const who = await begin(ctx, ctx.split, `First off message tb-scenario:${scenario}`);
  ctx.flow.catchUp = who;
  await settle(ctx, who, 60000);
  for (const [text, team] of [['Second off message', false], ['First team message', true],
    ['Second team message', true], [BIG_A, false], [BIG_B, false], ['Third team message', true]]) {
    await sendMessage(ctx, who.tab, text, { team });
    await settle(ctx, who, 60000);
  }
  const assistant = messagesOf(userEntries(who), 'assistant')[0];
  const parts = (assistant?.content ?? []).map((part) => part.type);
  const first = createDelivery(ctx, 1);
  record('TB-11 the first delivery to planner carries the conversation from the start of the session, including '
    + 'the off-mode messages and replies, under "Conversation since your last turn…", without the tool call and '
    + 'the thinking of the first reply', parts.includes('thinking') && parts.includes('toolCall')
    && first.startsWith(CATCH_UP) && first.includes('User: First off message tb-scenario:tb-modes-catch')
    && first.includes('chat: OFF-REPLY-ONE') && first.includes('User: Second off message')
    && first.includes('chat: OFF-REPLY-TWO') && !first.includes(MODES_TEXT.thinking) && !first.includes('README')
    && first.includes(`${NEW_MESSAGE}First team message`), brief({ parts, first }));
  const second = createDelivery(ctx, 2);
  record('TB-11 the next delivery carries only what came since the last one: the first team message and its reply, '
    + 'not the off-mode conversation again', second.startsWith(CATCH_UP) && second.includes('User: First team message')
    && second.includes('chat: TEAM-REPLY-THREE') && !second.includes('OFF-REPLY') && !second.includes('off message'),
  brief(second));
  catchUpLimit(ctx);
}

/** @brief TB-11：超过 12000 字符时去掉最早的并注明 N earlier messages omitted。 */
function catchUpLimit(ctx) {
  const third = createDelivery(ctx, 3);
  const catchUp = third.slice(0, Math.max(0, third.indexOf(`\n\n${NEW_MESSAGE}`)));
  const omitted = /\n(\d+) earlier messages? omitted\n/.exec(catchUp)?.[1];
  record('TB-11 over the 12000-character cap the earliest messages are dropped and noted: "3 earlier messages '
    + 'omitted", the second team message, its reply and the first long message are gone, the rest is kept and the '
    + 'catch-up is at most 12000 characters', omitted === '3' && catchUp.length <= 12000
    && !catchUp.includes('Second team message') && !catchUp.includes('TEAM-REPLY-FOUR')
    && !catchUp.includes('BIG-A-START') && catchUp.includes('chat: BIG-REPLY-A') && catchUp.includes('BIG-B-START')
    && catchUp.includes('chat: BIG-REPLY-B'), brief({ omitted, length: catchUp.length, head: catchUp.slice(0, 200) }));
}

/** @brief TB-11：重新打开后从 mori.create_cursor 继续（restart 一步里调用）。 */
async function catchUpAfterRestart(ctx) {
  const who = ctx.flow.catchUp;
  if (!who) return;
  who.tab = await reopenSession(ctx, who.sessionFile);
  await sendMessage(ctx, who.tab, 'Fourth team message', { team: true });
  await settle(ctx, who, 60000);
  const fourth = createDelivery(ctx, 4);
  const cursors = customOf(instanceEntries(ctx, who, 'create'), 'mori.create_cursor');
  const ids = new Set(userEntries(who).map((entry) => entry.id));
  record('TB-11 after restarting Mori and reopening, the next delivery continues from mori.create_cursor: it carries '
    + 'only the third team message and its reply (not the long messages before the cursor); planner\'s session has '
    + 'one mori.create_cursor per delivery, each pointing at a user-session entry', fourth.startsWith(CATCH_UP)
    && fourth.includes('User: Third team message') && fourth.includes('chat: TEAM-REPLY-SEVEN')
    && !fourth.includes('BIG-B-START') && !fourth.includes('BIG-REPLY-B') && cursors.length === 4
    && cursors.every((item) => ids.has(item.entryId)), brief({ fourth, cursors }));
}

// ---------- TB-54：阶段行、Stop team、侧栏 ----------

/** @brief 分开时 planner is deciding… · Ns；对话在回复时是对话自己的阶段；后台在运行时 Stop team 与侧栏（tb-modes-stage）。 */
async function stage(ctx) {
  const scenario = 'tb-modes-stage';
  const who = await begin(ctx, ctx.split, `Stage test tb-scenario:${scenario}`, { on: true });
  const early = await poll(() => stageNow(ctx, who.tab).then((s) => (s?.kind === 'deciding' ? s : null)), 5000, 50);
  await sleep(3200);
  const later = await stageNow(ctx, who.tab);
  const secs = (s) => Number(/ · (\d+)s$/.exec(s?.text ?? '')?.[1] ?? NaN);
  record('TB-54 split session, planner judging while the dialog is not running: the stage line reads "planner is '
    + 'deciding… · Ns" (data-kind deciding) and the seconds count up', /^planner is deciding… · \d+s$/.test(early?.text
    ?? '') && later?.kind === 'deciding' && secs(later) >= secs(early) + 2, brief({ early, later }));
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 1 });
  await sendMessage(ctx, who.tab, 'Second stage message');
  await waitLine(ctx, scenario, { agent: 'planner', kind: 'create', k: 2 });
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    samples.push(await stageNow(ctx, who.tab));
    await sleep(250);
  }
  record('TB-54 while the dialog is replying the stage line shows the dialog\'s own stage, not "is deciding", even '
    + 'though planner is judging the next message', samples.every((s) => s !== null && s.kind !== 'deciding'
    && !s.text.includes('is deciding')), brief(samples));
  await settle(ctx, who, 60000);
  await stageBackground(ctx, who);
}

/** @brief TB-54：只有后台在运行时 Stop team 显示、侧栏为生成中（显示着与不显示的会话）。 */
async function stageBackground(ctx, who) {
  await sendMessage(ctx, who.tab, 'Background work please tb-scenario:tb-modes-stage');
  await waitLine(ctx, 'tb-modes-stage', { agent: 'executor', kind: 'task' });
  await paneIdle(ctx, who.tab);
  const shown = { stop: await stopTeamShown(ctx, who.tab), status: await sidebarStatus(ctx, who.tab),
    team: (await liveInfo(ctx, who.sessionFile)).team, pane: await paneState(ctx.page, who.tab) };
  const other = await newSession(ctx);
  await sleep(500);
  const hidden = { status: await sidebarStatus(ctx, who.tab), visible: await ctx.page
    .locator(`.pane-slot:not([hidden]) ${paneSel(who.tab)}`).count() };
  await showTab(ctx, who.tab);
  await settle(ctx, who, 60000);
  const done = { stop: await stopTeamShown(ctx, who.tab), status: await sidebarStatus(ctx, who.tab) };
  record('TB-54 while only background agents run (the dialog idle, T1 running): Stop team is shown next to the '
    + 'composer and disappears when they are done', shown.stop && !shown.pane.running && !shown.pane.sending
    && shown.team.background === true && !done.stop, brief({ shown: { stop: shown.stop, bg: shown.team.background },
    done }));
  record('TB-54 the sidebar shows the session as generating while only background agents run, both while it is the '
    + 'shown session and after another session is opened in its place; not generating once they are done',
  shown.status === 'running' && hidden.visible === 0 && hidden.status === 'running' && done.status !== 'running',
  brief({ shown: shown.status, hidden, done: done.status, other }));
}

// ---------- TB-56：待判断的消息 ----------

/** @brief 对话回复中发三条（Enter、Ctrl+Enter、Enter）：按顺序判断，排队与插话，最后一条判断完时对话已空闲（tb-modes-q3）。 */
async function queueThree(ctx) {
  const scenario = 'tb-modes-q3';
  const who = await begin(ctx, ctx.split, `Queue three tb-scenario:${scenario}`, { on: true });
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 1 });
  await sendMessage(ctx, who.tab, 'Message A');
  await sendMessage(ctx, who.tab, 'Message B', { key: 'Control+Enter' });
  await sendMessage(ctx, who.tab, 'Message C');
  await settle(ctx, who, 90000);
  const history = await queueHistory(ctx, who.tab);
  const early = history.find((item) => same(item.rows, ['A', 'B', 'C']
    .map((name) => `${WAITING}|Message ${name}|deciding`)));
  const creates = ['A', 'B', 'C'].map((name, i) => requestAt(ctx, scenario, { agent: 'planner', kind: 'create',
    k: i + 2, j: 0 }));
  record('TB-56 three messages sent while the dialog replies are judged in order: the queue area lists them as '
    + '"Waiting for planner" in send order, and planner\'s deliveries 2, 3, 4 are A, B, C one after the other',
  early !== undefined && creates.every((item, i) => item?.info.last.includes(`${NEW_MESSAGE}Message ${'ABC'[i]}`))
    && creates[0].t < creates[1].t && creates[1].t < creates[2].t,
  brief({ early, creates: creates.map((c) => c?.t) }));
  const judged = history.find((item) => item.rows.includes(`${STEERED}|Message B|`)
    && item.rows.includes(`${QUEUED}|Message A|`) && item.rows.includes(`${WAITING}|Message C|deciding`));
  const afterB = requestAt(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 2, j: 0 });
  const afterA = requestAt(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 3, j: 0 });
  record('TB-56 once judged, the Enter message is queued and the Ctrl+Enter one steers: the queue area shows B as '
    + 'Steer and A as Queued while C still waits; pi takes B (steer) before A (follow-up) in the same run',
  judged !== undefined && afterB?.info.last === 'Message B' && afterA?.info.last === 'Message A'
    && deliveriesOf(afterA).indexOf('Message B') < deliveriesOf(afterA).indexOf('Message A'),
  brief({ judged, history: history.map((item) => item.rows), b: afterB?.info.last, a: afterA?.info.last }));
  await queueIdleStart(ctx, who);
}

/** @brief TB-56：判断结束时对话已空闲，开始新的回复。 */
async function queueIdleStart(ctx, who) {
  const events = await kernelEvents(ctx, who.sessionId, /^agent_(start|settled)$/, who.since);
  const lineC = scenarioLines(ctx.ep, 'tb-modes-q3', { agent: 'planner', kind: 'create' })
    .find((line) => line.k === 4);
  const replyC = requestAt(ctx, 'tb-modes-q3', { agent: 'chat', kind: 'team-dialog', k: 4, j: 0 });
  const firstSettled = events.find((item) => item.type === 'agent_settled');
  const restart = events.find((item) => item.type === 'agent_start' && item.t > (firstSettled?.t ?? Infinity));
  const items = await transcriptItems(ctx, who.tab);
  const bubble = items.findIndex((item) => item.kind === 'user' && item.text === 'Message C');
  record('TB-56 when a judgment ends with the dialog already idle a new reply starts: the first run settled while '
    + 'planner still judged C (9 s), then a new run starts with C (bubble, then the reply)', firstSettled !== undefined
    && lineC !== undefined && firstSettled.t < lineC.t + 9000 && restart !== undefined
    && replyC?.info.last === 'Message C'
    && bubble >= 0 && items[bubble + 1]?.kind === 'assistant',
  brief({ settled: firstSettled && firstSettled.t - who.since, judging: lineC && lineC.t - who.since,
    restart: restart && restart.t - who.since, items: streamShape(items).slice(-4) }));
}

/** 撤回一步里登记了需求、又被撤回的那条消息（带场景标记：task 与结案的工作卡里有它） */
const WITHDRAWN = 'Register the withdrawn request tb-scenario:tb-modes-wd';

/** @brief 撤回：交给 pi 排队的与还没开始判断的回到输入框，正在判断的留下；撤回的那条的回执写在末尾（tb-modes-wd）。 */
async function withdrawStep(ctx) {
  const scenario = 'tb-modes-wd';
  const who = await begin(ctx, ctx.split, `Withdraw test tb-scenario:${scenario}`, { on: true });
  ctx.flow.withdraw = who;
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 1 });
  await sendMessage(ctx, who.tab, WITHDRAWN);
  const handed = await poll(async () => (await queueRows(ctx, who.tab)).find((row) => row.kind === QUEUED
    && row.text === WITHDRAWN) ?? null, 15000, 50);
  await sendMessage(ctx, who.tab, 'Message B');
  await sendMessage(ctx, who.tab, 'Message C');
  const judging = await poll(async () => {
    const info = await liveInfo(ctx, who.sessionFile);
    return info.deciding.since !== null && same(info.deciding.queue.map((m) => m.text), ['Message B', 'Message C'])
      ? info.deciding : null;
  }, 10000, 50);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="queue"] button`, { hasText: 'Withdraw' }).click();
  const draft = await poll(async () => (await paneState(ctx.page, who.tab)).draft || null, 5000, 50);
  await sleep(300);
  const rows = await queueRows(ctx, who.tab);
  const items = await transcriptItems(ctx, who.tab);
  await withdrawChecks(ctx, who, { handed, judging, draft, rows, items });
  await waitLine(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 2 }, 40000);
  await paneIdle(ctx, who.tab);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="stop-team"]`).click({ timeout: 10000 });
  await settle(ctx, who, 60000);
}

/** @brief withdrawStep 的检查。 */
async function withdrawChecks(ctx, who, obs) {
  const { handed, judging, draft, rows, items } = obs;
  record('TB-56 withdraw brings back the messages planner has not started judging (and the judged one waiting in '
    + 'pi\'s queue) in send order, while the one being judged stays: the input gets A and C, the queue area keeps '
    + 'only "Waiting for planner · Message B"', handed !== null && judging !== null
    && draft === `${WITHDRAWN}\n\nMessage C`
    && same(rows.map((row) => [row.kind, row.text]), [[WAITING, 'Message B']]), brief({ draft, rows, judging }));
  const tail = items.slice(-2).map((item) => `${item.kind}:${item.kind === 'progress' ? item.request : item.text}`);
  const entries = userEntries(who);
  record('TB-08 a message judged during the reply and then withdrawn: its receipt and its mori.progress are written '
    + 'at the end of the conversation when it leaves (the last two items are the receipt and the progress summary), '
    + 'the message itself never reaches the session', same(tail, ['receipt:Request 1 registered · Withdrawn request',
    'progress:1']) && userAt(entries, WITHDRAWN) < 0
    && receiptIndexes(entries, 'registered').length === 1 && customOf(entries, 'mori.progress').length === 1,
  brief({ tail, users: userTexts(entries) }));
}

/** @brief 对话在为另一条消息准备中时判断完的消息排在它之后（tb-modes-held：chat 在等并发为 1 的 tbq）。 */
async function heldStep(ctx) {
  const scenario = 'tb-modes-held';
  const who = await begin(ctx, ctx.held, `Held test tb-scenario:${scenario}`, { on: true });
  await waitLine(ctx, scenario, { agent: 'executor', kind: 'task' });
  const preparing = await poll(async () => {
    const pane = await paneState(ctx.page, who.tab);
    const create = scenarioLines(ctx.ep, scenario, { agent: 'planner', kind: 'create' });
    return pane.sending && !pane.running && create.some((line) => line.j === 2) ? pane : null;
  }, 15000, 50);
  await sleep(500);
  await sendMessage(ctx, who.tab, 'Held message Q');
  const held = await poll(async () => (await queueRows(ctx, who.tab)).find((row) => row.text === 'Held message Q'
    && row.pending) ?? null, 15000, 50);
  const heldPane = await paneState(ctx.page, who.tab);
  await settle(ctx, who, 90000);
  const judgedQ = requestAt(ctx, scenario, { agent: 'planner', kind: 'create', k: 2, j: 0 });
  const replyP = requestAt(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 1, j: 0 });
  const replyQ = requestAt(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 2, j: 0 });
  const events = await kernelEvents(ctx, who.sessionId, null, who.since);
  const qStart = events.findIndex((item) => item.type === 'message_start' && item.role === 'user'
    && item.text === 'Held message Q');
  const settledBefore = events.slice(0, qStart).filter((item) => item.type === 'agent_settled').length;
  record('TB-56 a message judged while the dialog is preparing for another one goes after it: Q is judged while the '
    + 'dialog still waits for a model for the first message, shows as a staged Queued row (data-pending), and pi '
    + 'takes it as a follow-up of that reply in the same run', preparing !== null && held?.kind === QUEUED
    && heldPane.sending && !heldPane.running && judgedQ !== undefined && replyP !== undefined
    && judgedQ.t < replyP.t && replyQ?.info.last === 'Held message Q'
    && deliveriesOf(replyQ).indexOf('Held message Q') > 0 && qStart >= 0 && settledBefore === 0,
  brief({ held, preparing: preparing && [preparing.sending, preparing.running], heldPane: [heldPane.sending,
    heldPane.running, heldPane.stage], judgedQ: judgedQ?.t, replyP: replyP?.t, q: replyQ?.info.last, settledBefore,
    queue: (await queueHistory(ctx, who.tab)).map((item) => item.rows) }));
}

/** @brief 扩展命令不经立项，它用 sendUserMessage 开始的运行的工作卡写 No decision（tb-modes-cmd）。 */
async function command(ctx) {
  const scenario = 'tb-modes-cmd';
  const tab = await openSessionIn(ctx, ctx.split);
  await teamCommand(ctx, tab, '/team on', 'always');
  const since = Date.now();
  await sendMessage(ctx, tab, '/tbcmd go');
  const who = { tab, ...(await userSession(ctx, tab)), since };
  ctx.watched.set(who.sessionId, who);
  await settle(ctx, who, 60000);
  const deciding = await kernelEvents(ctx, who.sessionId, 'mori.team_deciding', since);
  const create = scenarioLines(ctx.ep, scenario, { agent: 'planner' });
  const reply = requestAt(ctx, scenario, { agent: 'chat', kind: 'team-dialog', k: 1, j: 0 });
  const card = cardOf(reply);
  record('TB-56 a "/" extension command does not go to planner: no deciding event lists it, planner gets no '
    + 'delivery, and the command runs in the dialog session', deciding.every((item) => !item.data.queue
    .some((m) => m.text.includes('/tbcmd'))) && create.length === 0 && reply !== undefined
    && reply.info.last === `${MODES_TEXT.cmdText} go`, brief({ deciding: deciding.length, create: create.length,
    last: reply?.info.last }));
  record('TB-56 the run an extension command starts with sendUserMessage has "No decision: started by /tbcmd" on '
    + 'the work card and still the team-mode tools', card.includes('No decision: started by /tbcmd')
    && teamShape(reply), brief({ card, tools: reply?.tools }));
}

/**
 * @brief 对话为你的消息准备中（planner 在判断它）时发的扩展命令：照 v0 暂存在准备中，排队区显示为暂存的 Queued 一行；
 *        Esc 之后它随那条消息按发送顺序回到输入框（tb-modes-cmdheld）。
 */
async function commandHeld(ctx) {
  const scenario = 'tb-modes-cmdheld';
  const first = `Held command tb-scenario:${scenario}`;
  const who = await begin(ctx, ctx.split, first, { on: true });
  await waitLine(ctx, scenario, { agent: 'planner', kind: 'create', k: 1 });
  await sendMessage(ctx, who.tab, '/tbcmd held');
  const held = await poll(async () => (await queueRows(ctx, who.tab)).find((row) => row.text === '/tbcmd held')
    ?? null, 10000, 50);
  const pane = await paneState(ctx.page, who.tab);
  await ctx.page.locator(`${paneSel(who.tab)} .composer textarea`).press('Escape');
  await settle(ctx, who, 30000);
  const after = await paneState(ctx.page, who.tab);
  const ran = scenarioLines(ctx.ep, scenario, { agent: 'chat' });
  record('TB-56 an extension command sent while the dialog prepares for your message (planner judging it) is held '
    + 'like in v0 and shows in the queue area as a staged Queued row (data-pending); after Esc it comes back after '
    + 'that message, in sending order, and never ran', held?.kind === QUEUED && held.pending && !held.deciding
    && pane.sending && !pane.running && after.draft === `${first}\n\n/tbcmd held` && ran.length === 0,
  brief({ held, sending: [pane.sending, pane.running], draft: after.draft, ran: ran.length,
    queue: (await queueHistory(ctx, who.tab)).map((item) => item.rows) }));
  await teamCommand(ctx, who.tab, '/team off', 'off');
}

/** @brief /team /<扩展命令> 在关闭模式下：先进入 once，命令照 v0 交给对话，它开始的运行按协作模式（tb-modes-cmd）。 */
async function commandOnce(ctx) {
  const tab = await openSessionIn(ctx, ctx.split);
  const since = Date.now();
  await sendMessage(ctx, tab, '/tbcmd once', { team: true });
  const who = { tab, ...(await userSession(ctx, tab)), since };
  await settle(ctx, who, 60000);
  const reply = requestAt(ctx, 'tb-modes-cmd', { agent: 'chat', kind: 'team-dialog', k: 1, j: 0, since });
  const modes = customOf(userEntries(who), 'mori.team').map((item) => item.mode);
  const create = scenarioLines(ctx.ep, 'tb-modes-cmd', { agent: 'planner', since });
  record('TB-05 /team /<extension command> in off mode enters once before the command runs: the run it starts with '
    + 'sendUserMessage uses the team-mode segment and tools with "No decision: started by /tbcmd", planner gets no '
    + 'delivery, and once ends with that turn (mori.team once, then off)', teamShape(reply)
    && reply.info.last === `${MODES_TEXT.cmdText} once` && cardOf(reply).includes('No decision: started by /tbcmd')
    && create.length === 0 && same(modes, ['once', 'off']) && (await teamSwitch(ctx, tab)).mode === 'off',
  brief({ kind: reply?.info.kind, tools: reply?.tools, last: reply?.info.last, modes, create: create.length }));
}

/** @brief 提示词模板：立项的投递附上展开后的文字，需求记原文，回执仍紧跟这条消息（tb-modes-tmpl）。 */
async function template(ctx) {
  const scenario = 'tb-modes-tmpl';
  const text = `/tbtmpl fix-it tb-scenario:${scenario}`;
  const who = await begin(ctx, ctx.split, text, { on: true });
  ctx.flow.template = who;
  await settle(ctx, who, 90000);
  const delivery = requestAt(ctx, scenario, { agent: 'planner', kind: 'create', k: 1, j: 0 })?.info.last ?? '';
  const words = readBoard(ctx, who.sessionId)?.requests[0]?.words ?? [];
  const entries = userEntries(who);
  const expanded = `${MODES_TEXT.tmplBody} fix-it tb-scenario:${scenario}`;
  const userIndex = userAt(entries, expanded);
  const receipt = receiptIndexes(entries).find((index) => index > userIndex) ?? -1;
  const items = await transcriptItems(ctx, who.tab);
  const bubble = items.findIndex((item) => item.kind === 'user');
  record('TB-56 a prompt template is judged first: planner\'s delivery has "New user message: /tbtmpl fix-it…" and '
    + '"Expanded from /tbtmpl:" with the expanded text; the request records what you typed; the dialog session '
    + 'gets the expanded text (v0) and the receipt still follows that message',
  delivery.includes(`${NEW_MESSAGE}${text}`) && delivery.includes(`Expanded from /tbtmpl:\n${expanded}`)
    && words[0]?.text === text && userIndex >= 0 && receipt > userIndex
    && receipt < assistantAfter(entries, userIndex) && items[bubble + 1]?.kind === 'receipt',
  brief({ delivery, words, userIndex, receipt, items: streamShape(items) }));
}

// ---------- TB-08：合并会话的回执 ----------

/** @brief 合并会话里三种写入的回执（tb-modes-mrec）：文字、截断，在那次工具调用之后、工具结果之前。 */
async function mergedReceipts(ctx) {
  const scenario = 'tb-modes-mrec';
  const who = await begin(ctx, ctx.merged, `Merged receipts tb-scenario:${scenario}`, { on: true });
  ctx.flow.merged = who;
  for (const [text, kind] of [[null, 'registered'], [MODES_TEXT.mergedLong, 'added'],
    ['Cancel it please', 'cancelled']]) {
    if (text) await sendMessage(ctx, who.tab, text);
    if (!(await waitReceipt(ctx, who.tab, { kind, request: 1 }))) throw new Error(`no ${kind} receipt`);
    await paneIdle(ctx, who.tab);
  }
  await settle(ctx, who, 60000);
  const receipts = await receiptsOf(ctx, who.tab);
  const cut = `${[...MODES_TEXT.mergedLong].slice(0, 120).join('')}…`;
  record('TB-08 each of the three writes has its receipt with the §13.2 text: "Request 1 registered · Merged '
    + 'request", "Added to request 1: “<words cut to 120 characters>…”", "Request 1 '
    + 'cancelled"', same(receipts.map((item) => [item.kind, item.request, item.text]), [
    ['registered', 1, 'Request 1 registered · Merged request'], ['added', 1, `Added to request 1: “${cut}”`],
    ['cancelled', 1, 'Request 1 cancelled']]),
  brief(receipts));
  const entries = userEntries(who);
  const placed = ['request_submit', 'request_update', 'request_cancel'].map((tool, i) => {
    const call = entries.findIndex((entry) => entry.type === 'message' && entry.message.role === 'assistant'
      && (entry.message.content ?? []).some((part) => part.type === 'toolCall' && part.name === tool));
    const result = entries.findIndex((entry) => entry.type === 'message' && entry.message.role === 'toolResult'
      && entry.message.toolName === tool);
    const receipt = receiptIndexes(entries, ['registered', 'added', 'cancelled'][i])[0] ?? -1;
    return { tool, ok: call >= 0 && call < receipt && receipt < result };
  });
  const inside = (await transcriptItems(ctx, who.tab)).flatMap((item) => item.inside)
    .map((part) => `${part.kind}:${part.text.slice(0, 22)}`);
  const after = (title, receipt) => inside.indexOf(`tool:${title}`) >= 0
    && inside[inside.indexOf(`tool:${title}`) + 1]?.startsWith(`receipt:${receipt}`);
  record('TB-08 merged session: each receipt is written after the tool call that made it and before its tool result '
    + '(session file), and is drawn right under that tool card on screen', placed.every((item) => item.ok)
    && after('Register a request', 'Request 1 registered') && after('Add to request 1', 'Added to request 1')
    && after('Cancel request 1', 'Request 1 cancelled'), brief({ placed, inside }));
}

// ---------- 重新打开 ----------

/** @brief 重启 App，重新打开各步的会话：开关沿用最后的模式（TB-05），回执与进展摘要的顺序与实时相同（TB-08），TB-11。 */
async function restart(ctx) {
  const named = ['once', 'switching', 'decide', 'error', 'withdraw', 'template', 'merged']
    .filter((name) => ctx.flow[name]);
  const before = new Map();
  for (const name of named) {
    const who = ctx.flow[name];
    await showTab(ctx, who.tab);
    before.set(name, { shape: streamShape(await transcriptItems(ctx, who.tab)), mode: (await teamSwitch(ctx, who.tab))
      .mode });
  }
  await restartTbApp(ctx);
  await captureOrder(ctx);
  await watchQueues(ctx);
  const diffs = [];
  const modes = {};
  for (const name of named) {
    const who = ctx.flow[name];
    who.tab = await reopenSession(ctx, who.sessionFile);
    const prior = before.get(name);
    await poll(async () => streamShape(await transcriptItems(ctx, who.tab)).length >= prior.shape.length, 15000);
    const shape = streamShape(await transcriptItems(ctx, who.tab));
    const sw = await teamSwitch(ctx, who.tab);
    modes[name] = [prior.mode, sw.mode, sw.text];
    if (!same(shape, prior.shape)) diffs.push({ name, before: prior.shape, after: shape });
  }
  record('TB-05 the mode is kept across reopening: after restarting Mori each session\'s switch reads what it read '
    + 'before (Team: On for the session left in always, Team: Off for the once session that ended)',
  Object.values(modes).every(([prior, now]) => prior === now) && modes.switching?.[1] === 'always'
    && modes.switching[2] === 'Team: On' && modes.once?.[1] === 'off', brief(modes));
  record('TB-08 live and reopened order are the same: after restarting Mori and reopening, the user messages, '
    + 'replies, receipts and progress summaries of every session come in the same order as live',
  named.length >= 5 && diffs.length === 0, brief({ named, diffs }, 3000));
  await catchUpAfterRestart(ctx);
}

// ---------- 主流程 ----------

/** @brief 套件结束时：端点没有多出来的请求，App 没有写失败的 board.json。 */
function finalChecks(ctx) {
  const missing = missingSteps(ctx.ep);
  record('modes: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
  const writeErrors = appLogLines(ctx, /cannot write .*board\.json|the TaskBoard was not written/);
  record('modes: Mori logged no failed TaskBoard write', writeErrors.length === 0, brief(writeErrors));
}

const steps = { once, switching, issueReport, unmetOpen, unmetQueue, unmetJudging, runOn, runOff, decide, error,
  catchUp, stage, queueThree, withdrawStep, heldStep, command, commandHeld, commandOnce,
  template, mergedReceipts, restart };

const ctx = { userData: tempUserData('mori-tb-modes-data-'), exePath: args.exePath, watched: new Map(), flow: {},
  pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-modes] step ${name}`);
    try {
      await step(ctx);
    } catch (failure) {
      record(`${name}: modes`, false, oneLineError(failure));
      await shot(ctx, args, `${name}-error`);
    }
  }
  finalChecks(ctx);
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-modes] data in ${ctx.userData}; projects ${ctx.split}, ${ctx.merged}, ${ctx.held}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(failure) {
  return String(failure?.stack ?? failure).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}

