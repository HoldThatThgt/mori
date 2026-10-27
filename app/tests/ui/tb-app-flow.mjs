// 平行 Agent 与 TaskBoard 的 App 套件：主流程（docs/specs/parallel-agents-taskboard.md §17.2）。真正的 Mori（界面 + 后台进程
// + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/flow.mjs，synthetic），逐条验收 TB-10（合并会话）、
// TB-12（TaskBoard 持久化）、TB-21（每个 task 一组实例）、TB-37（进展摘要）在 App 层的通过条件；另有几条主路径的检查
// （名字以 "main path" 开头，不计入覆盖检查）：关闭模式没有角色文件时照 v0 回复、关闭模式下的临时提问、后台批准卡。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs flow）：
//   MORI_APP_DIR=.tb-runs/flow node tests/ui/tb-app-flow.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-flow(-packaged).json（--only 时 tb-partial-app-flow…），截图在 test-results/tb-app-flow/。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好一个本机提供商（写入等级 A、能关思考，跳过探针）、
// 信任带 .pi/SYSTEM.md 的项目；三个临时项目：没有角色文件（合并会话）、分开配置（chat / planner / executor / reviewer）、
// 带 .pi/SYSTEM.md；合成端点 4680，记录代理 4681（看完整的请求体）。
// 步骤各用自己的会话；restart 一步最后跑：重启 App，重新打开前面各步的会话，比较回执、进展摘要与 TaskBoard。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_TEXT } from '../fake-endpoint/scenarios/flow.mjs';
import { SEGMENT_SENTENCES } from '../fake-endpoint/scripts.mjs';
import {
  allowAll, appLogLines, boardViewOf, brief, captureOrder, closeTbApp, contentText, customOf, instanceFiles,
  instanceSuffix, kernelEvents, lineBrief, messagesOf, missingSteps, openSessionIn, orderOf, paneSel, paneState,
  phasesOf, poll, progressOf, readBoard, readJsonl, receiptsOf, reopenSession, restartTbApp, scenarioLines,
  scenarioRequests, seedTeamUserData, sendMessage, setProgressOpen, shot, showTab, sleep, SPLIT_ROLES, startTbApp,
  startTbEndpoint, stopTbEndpoint, suiteArgs, tbModel, tbProvider, tbRecorder, teamDir, teamDirFiles, teamSwitch,
  tempProject, tempUserData, toolCardsOf, transcriptItems, userSession, waitApprovalCard, waitReceipt, waitTaskPhase,
  waitTeamIdle, watchTaskPhases, writeRoles,
} from './tb-helpers.mjs';

const args = suiteArgs('flow');
const { record, finish } = tbRecorder(args);

/** 本套件的端口（§17.1 的 4600–4699 里分给它的 4680–4689）：合成端点与它前面的记录代理 */
const PORT = 4680;
const PROXY = 4681;
/** 合成端点上的模型（synthetic）：写入等级 A、能关思考 */
const MODEL = 'fake-coder-tbflow';
/** 合成端点 "plain" 的回复（replies.mjs） */
const PLAIN = '这是一段只有文字的回复，用来测试流式输出。';
/** 合并会话的立项段与共用段的固定句子（附录 A） */
const MERGED_SENTENCE = SEGMENT_SENTENCES['merged-create'];
const SHARED_PART = "one of several agents that work together on Mori's TaskBoard.";
/** 程序给的固定文字（§5.4、§6.2、§8.5） */
const TALK_DIRECTLY = 'You talk to the user directly; say it in your reply.';
const RECORD_FIRST = "Record the user's words first (request_submit or request_update).";
const MERGED_REPLY = 'Noted: no collaboration needed. Answer the user in your reply.';
const NEED_DECISION = '[Mori] T1 needs a decision from the user';
/**
 * 身份段的第一部分（docs/specs/memory.md 附录 A.1；Ask each time 时的全文，第三行是 .work 那一句，file-system.md §14）：
 * system prompt 总是以它开头，SYSTEM.md 不用（§4.3）
 */
const IDENTITY_TEXT = [
  "You are Mori, a coding assistant working in the user's project folder. You read files, run commands, edit code "
    + "and write files to get the user's work done.",
  "Tool calls other than reading and searching may wait for the user's approval. A denied call returns the user's "
    + "reason as its result: follow it and don't repeat the call.",
  'Put scripts, drafts, and temporary files you need along the way in .work/ in the working directory. Git ignores '
    + "it, and edit and write calls there never wait for the user's approval. Commands run with TEMP, TMP, and TMPDIR "
    + 'set to .work/tmp; use them instead of /tmp.',
  'The sections after the project information hold what Mori has learned with this user: <taste> how to talk with '
    + 'the user, <strategy> how to size and plan work, <review> what to check before saying work is done, <facts> '
    + 'what is true about the user and this project. Follow them unless the user says otherwise. Tasks you create and '
    + "questions you send with agent_message are worked on by agents that don't see <facts>: write the facts they "
    + 'need into the task description or the question.',
].join('\n');
/** TaskBoard 的工具名（§6.3） */
const TEAM_TOOLS = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close'];
/** 终态的 task */
const ENDED = ['done', 'failed', 'cancelled'];

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief §13.3 的时长写法（独立实现，用来核对界面）。 */
function durationOf(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return '<1 min';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
/** @brief 工具卡规则下命令的标题（只取第一行，超过 80 个字符截断加 …；没截断而有多行时加 " …"）。 */
function commandTitle(command) {
  const lines = command.trim().split(/\r?\n/);
  const first = lines[0];
  if (first.length > 80) return `${first.slice(0, 80)}…`;
  return lines.length > 1 ? `${first} …` : first;
}
/** @brief 工具卡规则下 read 的行范围后缀（" · lines a–b"）。 */
const rangeTitle = ({ offset, limit }) => ` · lines ${offset}–${offset + limit - 1}`;
/** @brief §13.3 的需求状态（独立实现：按表的顺序取第一个），用来核对界面的 data-state。 */
function expectedState(board, request) {
  if (request.status !== 'open') return request.status;
  const tasks = board.tasks.filter((task) => task.request === request.no);
  const waiting = tasks.filter((task) => task.status === 'waiting_user');
  if (waiting.some((task) => task.asked) || (request.question !== null && request.asked)) return 'needs_decision';
  if (waiting.length > 0 || request.question !== null) return 'waiting_create';
  if (tasks.some((task) => task.status === 'stopped') && !tasks.some((task) => task.status === 'active')) {
    return 'stopped';
  }
  return tasks.every((task) => ENDED.includes(task.status)) ? 'with_close' : 'running';
}
/** @brief 会话文件里 pi 消息的文字。 */
const textOfMessage = (message) => contentText(message?.content);
/** @brief 会话文件里某个工具的工具结果（toolResult 消息），按顺序。 */
const toolResults = (entries, tool) => messagesOf(entries)
  .filter((m) => m.role === 'toolResult' && m.toolName === tool);

// ---------- 准备与会话 ----------

/** @brief 测试准备（synthetic test setup）：三个临时项目、角色文件、.pi/SYSTEM.md，数据目录与合成端点。 */
async function setup(ctx) {
  ctx.merged = tempProject('mori-tb-flow-merged-');
  ctx.split = tempProject('mori-tb-flow-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  ctx.sys = tempProject('mori-tb-flow-sys-');
  mkdirSync(join(ctx.sys, '.pi'), { recursive: true });
  writeFileSync(join(ctx.sys, '.pi', 'SYSTEM.md'), 'You are a custom system prompt. MORI-SYSTEM-MD\n');
  ctx.ep = await startTbEndpoint(PORT, PROXY, { TB_FLOW_SPLIT: ctx.split });
  seedTeamUserData(ctx.userData, { providers: [tbProvider('tbf', PROXY, [tbModel(MODEL)])], trusted: [ctx.sys] });
  await startApp(ctx);
}

/** @brief 启动 App，装上事件顺序与 task 行的记录。 */
async function startApp(ctx) {
  await startTbApp(ctx);
  await captureOrder(ctx);
  await watchTaskPhases(ctx);
}

/**
 * @brief 在 project 里开一个新会话，可先切到 Full access，然后发第一条消息；返回 { tab, sessionId, sessionFile, since }，
 *        并把它记进 ctx.watched（board.json 的读取检查）。
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

/** @brief 用户会话文件的全部条目（第一行头部除外）。 */
const userEntries = (who) => readJsonl(who.sessionFile).slice(1);

/** @brief 这个会话面板此刻的回执与进展摘要（展开后读，再折叠），重启前后比较用。 */
async function snapshotStream(ctx, who) {
  await showTab(ctx, who.tab);
  const blocks = await progressOf(ctx, who.tab);
  for (const block of blocks) await setProgressOpen(ctx, who.tab, block.request, true);
  const expanded = await progressOf(ctx, who.tab);
  for (const block of blocks) await setProgressOpen(ctx, who.tab, block.request, false);
  const strip = (items) => items.map(({ expanded: _open, ...rest }) => rest);
  return { receipts: await receiptsOf(ctx, who.tab), collapsed: strip(blocks), expanded: strip(expanded) };
}

// ---------- 主路径 (a)：关闭模式、没有角色文件 ----------

/** @brief 关闭模式下没有角色文件的会话照 v0 回复：没有回执、进展摘要、TaskBoard 工具和 mori_team 段，不建 teams/<id>。 */
async function offPlain(ctx) {
  const who = await begin(ctx, ctx.merged, 'plain hello from off mode', { team: false });
  await settle(ctx, who, 60000);
  const pane = await paneState(ctx.page, who.tab);
  const request = scenarioRequests(ctx.ep, null, { since: who.since }).filter((item) => item.info.scenario === null)
    .at(-1);
  const sw = await teamSwitch(ctx, who.tab);
  const stream = await snapshotStream(ctx, who);
  record('main path (a) off mode without role files: a normal message gets the plain reply as in v0; the request has '
    + 'no TaskBoard tool and no team section; no receipt or progress summary; the switch stays Team: Off; '
    + 'no teams/<id> folder',
  pane.assistants.at(-1) === PLAIN && pane.errors.length === 0 && request !== undefined
    && !request.tools.some((name) => TEAM_TOOLS.includes(name)) && !request.system.includes(SHARED_PART)
    && stream.receipts.length === 0 && stream.collapsed.length === 0 && sw.mode === 'off'
    && teamDirFiles(ctx, who.sessionId).length === 0,
  brief({ reply: pane.assistants.at(-1), tools: request?.tools, sw, stream, files: teamDirFiles(ctx, who.sessionId) }));
}

// ---------- TB-10：合并会话 ----------

/** @brief 合并会话的整个流程（脚本 tb-flow-merged）：登记、need_user、你的回答、结案请立项再建 task、汇报、关闭模式。 */
async function merged(ctx) {
  const who = await begin(ctx, ctx.merged, 'Summarize the README tb-scenario:tb-flow-merged');
  ctx.flow.merged = who;
  if (!(await waitReceipt(ctx, who.tab, { kind: 'registered', request: 1 }))) throw new Error('no receipt');
  const waiting = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'waiting_user' }, 30000);
  const waitingState = (await progressOf(ctx, who.tab))[0];
  const asked = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'asked' }, 30000);
  const askedState = (await progressOf(ctx, who.tab))[0];
  const boardAsked = readBoard(ctx, who.sessionId);
  await settle(ctx, who, 60000);
  await sendMessage(ctx, who.tab, 'Summarize the intro section');
  await settle(ctx, who, 90000);
  const modeAfter = await teamSwitch(ctx, who.tab);
  const offSince = Date.now();
  await sendMessage(ctx, who.tab, 'One more question in off mode');
  await settle(ctx, who, 60000);
  const obs = { waiting, waitingState, asked, askedState, boardAsked, modeAfter, offSince };
  await mergedOneSession(ctx, who);
  await mergedReceiptTiming(ctx, who);
  await mergedWake(ctx, who, obs);
  await mergedSegments(ctx, who, obs);
  await mergedProgramDelivery(ctx, who);
  await mergedProgress(ctx, who, obs);
}

/** @brief TB-10：只有一条会话、一次回合、没有立项会话文件。 */
async function mergedOneSession(ctx, who) {
  const lines = scenarioLines(ctx.ep, 'tb-flow-merged');
  const first = lines.filter((line) => line.agent === 'mori' && line.kind === 'merged-create' && line.k === 1);
  const events = await kernelEvents(ctx, who.sessionId, null, who.since);
  const settled = events.findIndex((item) => item.type === 'agent_settled');
  const starts = events.slice(0, settled).filter((item) => item.type === 'agent_start').length;
  const reply = events.slice(0, settled).some((item) => item.type === 'message_end' && item.role === 'assistant'
    && item.text === 'Registered request 1.');
  const kinds = [...new Set(lines.map((line) => line.kind))];
  const suffixes = instanceFiles(ctx, who.sessionId).map((file) => instanceSuffix(who.sessionId, file.id)).sort();
  record('TB-10 merged session: the /team message is decided and answered in one run of the user session itself — '
    + 'exactly the 3 scripted requests (request_submit, task_create, reply), one agent_start before the first '
    + 'agent_settled with the reply in it; no create or team-dialog session ever sends a request; no create '
    + 'session file (only t1.mori, t2.mori, close.1)',
  same(first.map((line) => line.calls), [['request_submit'], ['task_create'], []]) && settled > 0 && starts === 1
    && reply && !kinds.some((kind) => ['create', 'team-dialog', 'off-dialog'].includes(kind))
    && same(suffixes, ['close.1', 't1.mori', 't2.mori']),
  brief({ first: lineBrief(first), starts, reply, kinds, suffixes }));
}

/** @brief TB-10：回执在工具执行时写（事件顺序、会话文件里的位置、界面上在那张工具卡下面）。 */
async function mergedReceiptTiming(ctx, who) {
  const order = (await orderOf(ctx, who.sessionId, who.since)).map((item) => (item.type === 'mori.receipt'
    ? `receipt:${item.data.kind}`
    : item.tool ? `${item.type.replace('tool_execution_', '')}:${item.tool}` : item.type));
  const at = (name) => order.indexOf(name);
  const live = at('start:request_submit') >= 0 && at('start:request_submit') < at('receipt:registered')
    && at('receipt:registered') < at('end:request_submit');
  const entries = userEntries(who);
  const callAt = entries.findIndex((entry) => entry.type === 'message' && entry.message.role === 'assistant'
    && (entry.message.content ?? []).some((part) => part.type === 'toolCall' && part.name === 'request_submit'));
  const receiptAt = entries.findIndex((entry) => entry.type === 'custom' && entry.customType === 'mori.receipt');
  const resultAt = entries.findIndex((entry) => entry.type === 'message' && entry.message.role === 'toolResult'
    && entry.message.toolName === 'request_submit');
  const items = await transcriptItems(ctx, who.tab);
  const inside = items.flatMap((item) => item.inside).map((part) => `${part.kind}:${part.text}`);
  const at2 = (prefix) => inside.findIndex((text) => text.startsWith(prefix));
  record('TB-10 merged session: the receipt is written while request_submit runs — mori.receipt arrives between its '
    + 'tool_execution_start and tool_execution_end; in the session file it sits after the assistant message that '
    + 'calls request_submit and before its tool result; on screen it is under the "Register a request" card and '
    + 'before the "Create a task" card that follows',
  live && callAt >= 0 && callAt < receiptAt && receiptAt < resultAt && at2('tool:Register a request') >= 0
    && at2('tool:Register a request') < at2('receipt:Request 1 registered · Summarize the README')
    && at2('receipt:') < at2('tool:Create a task'),
  brief({ order: order.slice(0, 12), callAt, receiptAt, resultAt, inside }));
}

/** @brief TB-10：程序唤醒立项的投递进用户会话且不显示；reply_via_dialog 被拒绝；need_user 只投递一次、只问一次。 */
async function mergedWake(ctx, who, obs) {
  const wakes = (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since)).map((item) => item.data);
  const need = wakes.filter((wake) => wake.text.startsWith(NEED_DECISION));
  const entries = userEntries(who);
  const wakeEntries = customOf(entries, 'mori.wake');
  const moriMessages = entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user'
    && textOfMessage(entry.message).startsWith('[Mori]'));
  const pointed = moriMessages.every((entry) => wakeEntries.some((wake) => wake.messageId === entry.id));
  const pane = await paneState(ctx.page, who.tab);
  const shown = [...pane.users, pane.draft ?? '', ...pane.queue].filter((text) => text.includes('[Mori]'));
  const needLines = scenarioLines(ctx.ep, 'tb-flow-merged', { agent: 'mori', kind: 'merged-create' })
    .filter((line) => line.k === 2);
  record('TB-10 merged session: a program wake of create goes into the user session and is not shown — mori.wake '
    + 'create_wake "[Mori] T1 needs a decision…", answered by the user session (mori/merged-create k=2), the session '
    + 'file points a mori.wake entry at every [Mori] message, and no bubble, queue item or input text shows [Mori]',
  need.length === 1 && need[0].kind === 'create_wake' && needLines.length === 2 && moriMessages.length === 3
    && pointed && shown.length === 0, brief({ wakes: wakes.map((w) => `${w.kind}:${w.text.slice(0, 50)}`),
    needLines: lineBrief(needLines), moriMessages: moriMessages.length, wakeEntries, shown }));
  const reply = toolResults(entries, 'reply_via_dialog');
  record('TB-10 merged session: reply_via_dialog in the program-woken turn is refused with "You talk to the user '
    + 'directly; say it in your reply."', reply.length === 1 && reply[0].isError === true
    && textOfMessage(reply[0]).includes(TALK_DIRECTLY), brief(reply.map((m) => [m.isError, textOfMessage(m)])));
  const askReplies = messagesOf(entries, 'assistant').filter((m) => textOfMessage(m).includes('needs your decision'));
  record('TB-10 default config: need_user gives exactly one hidden delivery and asks you once — one create_wake for '
    + 'T1, no ask_user delivery, one reply that asks; T1 is marked asked (Needs your decision) right after that turn',
  need.length === 1 && !wakes.some((wake) => wake.kind === 'ask_user') && askReplies.length === 1
    && obs.boardAsked?.tasks.find((task) => task.id === 'T1')?.asked === true && obs.asked !== null,
  brief({ wakes: wakes.map((w) => w.kind), askReplies: askReplies.length, asked: obs.asked }));
}

/** @brief TB-10：立项段在协作模式下在 system prompt 里，关闭模式下没有。 */
async function mergedSegments(ctx, who, obs) {
  const requests = scenarioRequests(ctx.ep, 'tb-flow-merged', { agent: 'mori' })
    .filter((item) => item.info.kind === 'merged-create' || item.info.kind === 'dialog');
  const team = requests.filter((item) => item.t < obs.offSince);
  const off = requests.filter((item) => item.t >= obs.offSince);
  record('TB-10 merged session: the merged create segment (with the shared segment) is in the system prompt of every '
    + 'team-mode request of the user session, and in off mode (after the request closed and Team: Until done ended) '
    + 'neither is there',
  team.length >= 6 && team.every((item) => item.system.includes(MERGED_SENTENCE) && item.system.includes(SHARED_PART))
    && obs.modeAfter.mode === 'off' && off.length === 1 && !off[0].system.includes(MERGED_SENTENCE)
    && !off[0].system.includes(SHARED_PART),
  brief({ team: team.length, off: off.length, mode: obs.modeAfter.mode, offKind: off[0]?.info.kind }));
}

/** @brief TB-10：程序投递到用户会话不开始用户消息的判断（结案请它建 task 时 task_create 不要求先记原话）。 */
async function mergedProgramDelivery(ctx, who) {
  const board = readBoard(ctx, who.sessionId);
  const entries = userEntries(who);
  const creates = toolResults(entries, 'task_create');
  const wakes = (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since)).map((item) => item.data);
  const asked = wakes.find((wake) => wake.text.startsWith('[Mori] Message from mori'));
  const receipts = await receiptsOf(ctx, who.tab);
  const words = board?.requests[0]?.words.map((word) => `${word.kind}:${word.text}`) ?? [];
  const edit = toolResults(entries, 'task_edit').at(-1);
  const t1 = board?.tasks.find((task) => task.id === 'T1');
  record('TB-12 an ended task cannot change: while request 1 is still open, task_edit on the done T1 is refused with '
    + '"T1 is closed." and T1 keeps its title and status in board.json', edit?.isError === true
    && textOfMessage(edit).startsWith('T1 is closed.') && t1?.title === 'Read README' && t1.status === 'done',
  brief({ edit: edit && textOfMessage(edit), t1: t1 && [t1.title, t1.status] }));
  record('TB-10 merged session: a program delivery to the user session does not start a user-message judgment — when '
    + 'close asks mori for one more task (create_wake), task_create is accepted without request_update (T2 created), '
    + 'no receipt is written for it and the request keeps only your two messages as its words',
  asked?.kind === 'create_wake' && creates.length === 2 && creates.every((m) => m.isError === false)
    && board?.tasks.find((task) => task.id === 'T2')?.title === 'List src' && receipts.length === 2
    && same(words, ['original:Summarize the README tb-scenario:tb-flow-merged',
      'supplement:Summarize the intro section']),
  brief({ asked: asked?.kind, creates: creates.map((m) => m.isError), receipts, words }));
}

/** @brief TB-37（合并会话）：位置在登记它的那一段的回复下面；Waiting for Mori → Needs your decision，结束后 Done。 */
async function mergedProgress(ctx, who, obs) {
  const items = await transcriptItems(ctx, who.tab);
  const progress = items.findIndex((item) => item.kind === 'progress' && item.request === 1);
  const reply = items.findIndex((item) => item.kind === 'assistant' && item.text.startsWith('Registered request 1.'));
  const user = items.findIndex((item) => item.kind === 'user'
    && item.text.startsWith('Summarize the README tb-scenario:tb-flow-merged'));
  record('TB-37 merged session: the progress summary hangs right under the reply of the segment that registered it '
    + '(your message, the tool cards and the reply "Registered request 1.", then the summary) and the reply actions '
    + 'of that turn are below the summary', user >= 0 && user < reply && progress === reply + 1
    && !items[reply].actions && items[progress].actions,
  brief(items.map((item) => `${item.kind}${item.actions ? '*' : ''}:${item.text.slice(0, 30)}`)));
  const done = (await progressOf(ctx, who.tab))[0];
  record('TB-37 request state and task phase while a task waits for a decision: "Waiting for Mori" with T1 '
    + '"Waiting for Mori" before you are asked, "Needs your decision" after; Done when it closes',
  obs.waitingState?.state === 'waiting_create' && obs.waitingState.title.includes(' · Waiting for Mori · ')
    && obs.waiting === 'T1 Read README · Mori · Waiting for Mori' && obs.askedState?.state === 'needs_decision'
    && obs.askedState.title.includes(' · Needs your decision · ') && obs.asked === 'T1 Read README · Mori · Needs your '
    + 'decision' && done?.state === 'done' && done.title.includes(' · Done · '),
  brief({ waiting: obs.waiting, waitingTitle: obs.waitingState?.title, asked: obs.asked, done: done?.title }));
}

/** @brief TB-10：同一次运行里的插话各算一次判断（脚本 tb-flow-steer）。 */
async function steer(ctx) {
  const who = await begin(ctx, ctx.merged, 'Plan a read tb-scenario:tb-flow-steer');
  ctx.flow.steer = who;
  if (!(await waitReceipt(ctx, who.tab, { kind: 'registered', request: 1 }))) throw new Error('no receipt');
  await sendMessage(ctx, who.tab, 'Also read src/a.ts please', { key: 'Control+Enter' });
  await settle(ctx, who, 90000);
  const lines = scenarioLines(ctx.ep, 'tb-flow-steer', { agent: 'mori', kind: 'merged-create' });
  const events = await kernelEvents(ctx, who.sessionId, null, who.since);
  const settled = events.findIndex((item) => item.type === 'agent_settled');
  const inRun = events.slice(0, settled).some((item) => item.type === 'message_start' && item.role === 'user'
    && item.text === 'Also read src/a.ts please');
  const entries = userEntries(who);
  const creates = toolResults(entries, 'task_create');
  const update = toolResults(entries, 'request_update');
  const receipts = (await receiptsOf(ctx, who.tab)).map((item) => `${item.kind}:${item.text}`);
  const board = readBoard(ctx, who.sessionId);
  record('TB-10 merged session: a steer sent during the same run is its own judgment — it reaches the model in the '
    + 'same run (k=2 of the same context); in that judgment task_create first is refused with "Record the user\'s '
    + 'words first…", request_update (another kind of decision) is accepted with your steer as the quote, then '
    + 'task_create works; receipts: registered and added',
  inRun && lines.some((line) => line.k === 2) && creates.length === 3 && creates[1].isError === true
    && textOfMessage(creates[1]).includes(RECORD_FIRST) && creates[0].isError === false
    && creates[2].isError === false && update.length === 1 && update[0].isError === false
    && same(receipts, ['registered:Request 1 registered · Plan a read',
      'added:Added to request 1: “Also read src/a.ts please”'])
    && same(board?.requests[0]?.words.map((word) => word.kind), ['original', 'supplement']),
  brief({ inRun, lines: lineBrief(lines), creates: creates.map((m) => [m.isError, textOfMessage(m).slice(0, 60)]),
    receipts }));
}

/**
 * @brief TB-10：项目有 .pi/SYSTEM.md 时协作模式的请求里仍有立项段；判断你的消息时 reply_via_dialog 的结果请它
 *        在自己的回复里回答（脚本 tb-flow-sysmd）。
 */
async function sysmd(ctx) {
  const who = await begin(ctx, ctx.sys, 'Say hello tb-scenario:tb-flow-sysmd');
  await settle(ctx, who, 60000);
  const offSince = Date.now();
  await sendMessage(ctx, who.tab, 'An off-mode question');
  await settle(ctx, who, 60000);
  const requests = scenarioRequests(ctx.ep, 'tb-flow-sysmd');
  const team = requests.filter((item) => item.t < offSince);
  const off = requests.filter((item) => item.t >= offSince);
  // 记忆规格 §4.3、§14.4：身份段总是 Mori 的，项目的 SYSTEM.md 不进 system prompt
  const identity = (item) => item.system.startsWith(IDENTITY_TEXT) && !item.system.includes('MORI-SYSTEM-MD');
  record('TB-10 with .pi/SYSTEM.md in the (trusted) project: neither the team-mode nor the off-mode request has the '
    + 'SYSTEM.md text and both start with Mori\'s identity (memory spec §4.3, Appendix A.1); the team-mode request '
    + 'still has the merged create segment, the off-mode request after it has none',
  team.length === 2 && team.every((item) => identity(item) && item.system.includes(MERGED_SENTENCE))
    && off.length === 1 && identity(off[0]) && !off[0].system.includes(MERGED_SENTENCE),
  brief({ team: team.map((item) => [item.info.kind, item.system.slice(0, 80)]),
    off: off.map((item) => [item.info.kind, item.system.slice(0, 80)]) }));
  const reply = toolResults(userEntries(who), 'reply_via_dialog');
  const pane = await paneState(ctx.page, who.tab);
  record(`TB-10 merged session: reply_via_dialog while judging your message is accepted with "${MERGED_REPLY}" `
    + '(no other dialog agent answers for it) and its reply in the same run is the answer you see',
  reply.length === 1 && reply[0].isError === false && textOfMessage(reply[0]) === MERGED_REPLY
    && pane.assistants.includes('No collaboration needed; answering directly.'),
  brief({ reply: reply.map((m) => [m.isError, textOfMessage(m)]), assistants: pane.assistants }));
}

// ---------- TB-12：编号与终态（合并会话，脚本 tb-flow-renumber） ----------

/** @brief 需求 1 撤销、需求 2 失败：编号不复用、终态不能改，Cancelled 与 Failed 的进展摘要。 */
async function renumber(ctx) {
  const who = await begin(ctx, ctx.merged, 'Do two things tb-scenario:tb-flow-renumber');
  ctx.flow.renumber = who;
  const pending = await waitTaskPhase(ctx, who.tab, { task: 'T2', phase: 'pending' }, 30000);
  await poll(async () => !(await paneState(ctx.page, who.tab)).running, 20000);
  await sendMessage(ctx, who.tab, 'Cancel that, I changed my mind');
  if (!(await waitReceipt(ctx, who.tab, { kind: 'cancelled', request: 1 }))) throw new Error('no cancel receipt');
  await settle(ctx, who, 60000);
  await sendMessage(ctx, who.tab, 'Read src instead tb-scenario:tb-flow-renumber', { team: true });
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const receipts = (await receiptsOf(ctx, who.tab)).map((item) => item.text);
  record('TB-12 numbers are never reused: after request 1 (T1, T2) is cancelled, the next request is 2 and its task '
    + 'is T3; nextRequest 3 and nextTask 4 in board.json',
  same(board?.requests.map((r) => `${r.no}:${r.status}`), ['1:cancelled', '2:failed'])
    && same(board.tasks.map((t) => `${t.id}:${t.request}:${t.status}`), ['T1:1:cancelled', 'T2:1:cancelled',
      'T3:2:failed']) && board.nextRequest === 3 && board.nextTask === 4
    && same(receipts, ['Request 1 registered · Two things', 'Request 1 cancelled', 'Request 2 registered · Read src']),
  brief({ requests: board?.requests.map((r) => r.status), tasks: board?.tasks.map((t) => t.id), receipts }));
  const edit = toolResults(userEntries(who), 'task_edit');
  record('TB-12 an ended task of a closed request cannot change: task_edit on the cancelled T1 is refused with '
    + '"Request 1 is closed." and T1 keeps its title and status in board.json', edit.length === 1
    && edit[0].isError === true && textOfMessage(edit[0]).startsWith('Request 1 is closed.')
    && board?.tasks[0].title === 'First thing' && board.tasks[0].status === 'cancelled',
  brief(edit.map((m) => textOfMessage(m))));
  await renumberProgress(ctx, who, board, pending);
}

/** @brief TB-37：Cancelled、Failed、已排除的方案、结论与 pending 的文字。 */
async function renumberProgress(ctx, who, board, pending) {
  const collapsed = await progressOf(ctx, who.tab);
  for (const no of [1, 2]) await setProgressOpen(ctx, who.tab, no, true);
  const open = await progressOf(ctx, who.tab);
  const [r1, r2] = open;
  const dur = (no) => durationOf(board.requests[no - 1].closedAt - board.requests[no - 1].createdAt);
  record('TB-37 a cancelled request shows "Cancelled", a failed one "Failed", both with the duration up to closedAt '
    + 'and no task rows when collapsed; expanded: Cancelled rows, the failed task\'s chain, the ruled-out approach '
    + 'and the conclusion; a pending task read "Waiting for T1"',
  collapsed.length === 2 && collapsed.every((block) => block.tasks.length === 0)
    && collapsed[0].title === `Request 1 · Two things · Cancelled · ${dur(1)}` && collapsed[0].state === 'cancelled'
    && collapsed[1].title === `Request 2 · Read src · Failed · ${dur(2)}` && collapsed[1].state === 'failed'
    && same(r1?.tasks.map((t) => t.text), ['T1 First thing · Cancelled', 'T2 Second thing · Cancelled'])
    && r2?.chains.T3 === 'Mori: src has only a.ts → Mori: Reading src did not help'
    && same(r2.ruledOut, ['Reading src did not help']) && r2.conclusion === 'Conclusion: Nothing useful in src'
    && pending === 'T2 Second thing · Waiting for T1',
  brief({ collapsed: collapsed.map((b) => b.title), r1: r1?.tasks, r2: r2 && { chains: r2.chains, ruled: r2.ruledOut,
    conclusion: r2.conclusion }, pending }));
  for (const no of [1, 2]) await setProgressOpen(ctx, who.tab, no, false);
}

// ---------- TB-37：Queued 与 Stopped（合并会话，脚本 tb-flow-queue） ----------

/** @brief 五个只读 task：第五个超过同时运行的上限显示 Queued；Stop team 后都为 Stopped，需求为 Stopped。 */
async function queueStop(ctx) {
  const who = await begin(ctx, ctx.merged, 'Read the README five times tb-scenario:tb-flow-queue');
  const queued = await waitTaskPhase(ctx, who.tab, { task: 'T5', phase: 'queued' }, 30000);
  const running = await waitTaskPhase(ctx, who.tab, { task: 'T4', phase: 'starting' }, 10000);
  const stop = ctx.page.locator(`${paneSel(who.tab)} [data-testid="stop-team"]`);
  await stop.click({ timeout: 10000 });
  const t1 = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'stopped' }, 20000);
  const t5 = await waitTaskPhase(ctx, who.tab, { task: 'T5', phase: 'stopped' }, 20000);
  const [block] = await progressOf(ctx, who.tab);
  await settle(ctx, who, 30000);
  await sendMessage(ctx, who.tab, 'Cancel it');
  await settle(ctx, who, 60000);
  const [after] = await progressOf(ctx, who.tab);
  record('TB-37 phase texts Queued and Stopped: with four tasks running the fifth reads "Queued"; after Stop team '
    + 'the tasks read "Stopped" and the request "Stopped"; cancelling it afterwards reads "Cancelled"',
  queued === 'T5 Read 5 · Mori · Queued' && running === 'T4 Read 4 · Mori · Starting'
    && t1 === 'T1 Read 1 · Mori · Stopped' && t5 === 'T5 Read 5 · Mori · Stopped' && block?.state === 'stopped'
    && block.title.includes(' · Stopped · ') && after?.state === 'cancelled',
  brief({ queued, running, t1, t5, block: block?.title, after: after?.title }));
}

/**
 * @brief 写入锁的持有者被停止时等锁的 task 读 "Waiting to change files (T1, stopped)"（脚本 tb-flow-lockstop）：
 *        Stop team 停下持有锁的 T1 与只读的 T2；交回 T2，它完成后依赖它的写 task T3 等 T1 的锁。
 */
async function lockStop(ctx) {
  const who = await begin(ctx, ctx.merged, 'Change two files tb-scenario:tb-flow-lockstop');
  await waitTaskPhase(ctx, who.tab, { task: 'T2', phase: 'starting' }, 30000);
  await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'starting' }, 10000);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="stop-team"]`).click({ timeout: 10000 });
  const stopped = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'stopped' }, 20000);
  await settle(ctx, who, 30000);
  await sendMessage(ctx, who.tab, 'Continue T2 only');
  const waiting = await waitTaskPhase(ctx, who.tab, { task: 'T3', phase: 'lock_wait' }, 60000);
  const board = readBoard(ctx, who.sessionId);
  await poll(async () => !(await paneState(ctx.page, who.tab)).running, 20000);
  await sendMessage(ctx, who.tab, 'Cancel it');
  await settle(ctx, who, 60000);
  record('TB-37 a write task waiting for the lock of a stopped task reads "Waiting to change files (T1, stopped)" '
    + '(T1 holds the lock while stopped after Stop team; T3 was handed over when its dependency T2 finished)',
  stopped === 'T1 Hold the lock · Mori · Stopped' && waiting === 'T3 Second write · Mori · Waiting to change files '
    + '(T1, stopped)' && board?.lock === 'T1' && board.tasks[0].status === 'stopped',
  brief({ stopped, waiting, lock: board?.lock, tasks: board?.tasks.map((t) => `${t.id}:${t.status}`) }));
}

// ---------- TB-21、TB-37：分开配置的整条链（脚本 tb-flow-chain） ----------

/** @brief chat / planner / executor / reviewer：T1 executor → reviewer → executor，T2 同时由 executor 做，T3、T4。 */
async function chain(ctx) {
  const who = await begin(ctx, ctx.split, 'Fix the README tb-scenario:tb-flow-chain', { allow: true });
  ctx.flow.chain = who;
  const replying = await poll(() => scenarioLines(ctx.ep, 'tb-flow-chain', { agent: 'chat', kind: 'team-dialog' })
    .length > 0, 30000, 50);
  if (!replying) throw new Error('chat never replied');
  await sendMessage(ctx, who.tab, 'How is it going?');
  const withClose = await poll(async () => (await progressOf(ctx, who.tab))[0]?.state === 'with_close'
    ? (await progressOf(ctx, who.tab))[0] : null, 90000, 100);
  await settle(ctx, who, 120000);
  const board = readBoard(ctx, who.sessionId);
  ctx.flow.chainBoard = board;
  await chainSessions(ctx, who, board);
  await chainParallel(ctx, who);
  await chainPosition(ctx, who);
  await chainPhases(ctx, who, board);
  await chainClosed(ctx, who, board, withClose);
  await chainMainPath(ctx, who, board);
}

/** @brief 主路径 (c)：分开配置的整条路走完——回执、建 task、executor → reviewer → 结案、需求关闭、对话被不显示地唤醒去汇报。 */
async function chainMainPath(ctx, who, board) {
  const wakes = (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since)).map((item) => item.data);
  const entries = userEntries(who);
  const wakeEntries = customOf(entries, 'mori.wake');
  const pane = await paneState(ctx.page, who.tab);
  const [block] = await progressOf(ctx, who.tab);
  record('main path (c) split roles (chat, planner, executor, reviewer): the /team message is registered (receipt), '
    + 'planner creates the tasks, T1 goes executor → reviewer → executor → planner (close), the request closes and '
    + 'chat is woken by a hidden request_closed delivery to report; the summary reaches Done',
  (await receiptsOf(ctx, who.tab)).length === 1 && board?.requests[0]?.status === 'done' && board.tasks.length === 4
    && wakes.length === 1 && wakes[0].kind === 'request_closed' && wakeEntries.length === 1
    && wakeEntries[0].kind === 'request_closed' && !pane.users.some((text) => text.includes('[Mori]'))
    && pane.assistants.at(-1) === 'Request 1 is done: README fixed.' && block?.state === 'done',
  brief({ wakes: wakes.map((w) => w.kind), wakeEntries, last: pane.assistants.at(-1), state: block?.state }));
}

/** @brief TB-21：executor → reviewer → executor 继续同一条会话；新 task 新开会话。 */
async function chainSessions(ctx, who, board) {
  const files = instanceFiles(ctx, who.sessionId);
  const bySuffix = (suffix) => files.filter((file) => instanceSuffix(who.sessionId, file.id) === suffix);
  const t1 = bySuffix('t1.executor');
  const deliveries = t1[0] ? messagesOf(t1[0].entries, 'user').map(textOfMessage) : [];
  const second = scenarioRequests(ctx.ep, 'tb-flow-chain', { agent: 'executor', kind: 'task', task: 'T1' })
    .find((item) => item.info.k === 2);
  const carried = second ? second.messages.map((m) => contentText(m.content)).join('\n') : '';
  const t1Handoffs = board?.tasks[0]?.handoffs.map((h) => `${h.from}:${h.outcome}`) ?? [];
  record('TB-21 executor → reviewer → executor continues the same session: one t1.executor session file holds both '
    + 'deliveries ("You are executor on T1" then "T1 is back with you"); the second run\'s request still carries the '
    + 'first run\'s tool results [#1]–[#3] (bash, read, the handoff), and its read is numbered on from there (#4)',
  t1.length === 1 && deliveries.length === 2 && deliveries[0].startsWith('[Mori] You are executor on T1 (request 1).')
    && deliveries[1].startsWith('[Mori] T1 is back with you.')
    && ['[#1] ', '[#2] ', '[#3] '].every((tag) => carried.includes(tag))
    && same(t1Handoffs, ['executor:continue', 'reviewer:fail', 'executor:done', 'close:planner:close_done'])
    && board.tasks[0].handoffs[2].evidence[0]?.tag === '#4',
  brief({ files: files.map((f) => instanceSuffix(who.sessionId, f.id)),
    deliveries: deliveries.map((d) => d.slice(0, 50)),
    t1Handoffs, evidence: board?.tasks[0]?.handoffs[2]?.evidence }));
  const t2 = bySuffix('t2.executor');
  const firstT2 = scenarioRequests(ctx.ep, 'tb-flow-chain', { agent: 'executor', kind: 'task', task: 'T2' })[0];
  const t2Users = firstT2?.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)) ?? [];
  record('TB-21 a new task opens a new session: T2 and T4 have their own executor session files; T2\'s first request '
    + 'has a single delivery "You are executor on T2" plus its work card and nothing from T1',
  t2.length === 1 && t2[0].file !== t1[0]?.file && bySuffix('t4.executor').length === 1
    && t2Users.filter((text) => !text.includes('<mori-work-card>')).length === 1
    && t2Users[0].startsWith('[Mori] You are executor on T2 (request 1).') && !t2Users.join('\n').includes('[#'),
  brief({ t2: t2.map((f) => f.id), users: t2Users.map((text) => text.slice(0, 60)) }));
}

/** @brief TB-21：同一角色同时在两个 task 上各有一个实例（端点日志的时间交错）。 */
async function chainParallel(ctx, who) {
  const t1 = scenarioLines(ctx.ep, 'tb-flow-chain', { agent: 'executor', kind: 'task', task: 'T1' })
    .filter((line) => line.k === 1);
  const t2 = scenarioLines(ctx.ep, 'tb-flow-chain', { agent: 'executor', kind: 'task', task: 'T2' });
  const overlap = t1.length > 0 && t2.length > 0 && t2[0].t < t1.at(-1).t && t1[0].t < t2.at(-1).t;
  const ids = instanceFiles(ctx, who.sessionId).map((file) => instanceSuffix(who.sessionId, file.id));
  record('TB-21 the same role works on two tasks at once with one instance each: executor\'s requests on T1 and on '
    + 'T2 interleave in time (T2 starts before T1\'s first run ends) and come from two instance sessions',
  overlap && ids.includes('t1.executor') && ids.includes('t2.executor'),
  brief({ t1: t1.map((line) => line.t - who.since), t2: t2.map((line) => line.t - who.since), ids }));
}

/** @brief TB-37：进展摘要挂在登记它的回复下面、回复操作之上，即使对话回复时你又排了一条消息。 */
async function chainPosition(ctx, who) {
  const items = await transcriptItems(ctx, who.tab);
  const find = (kind, test) => items.findIndex((item) => item.kind === kind && test(item));
  const user1 = find('user', (item) => item.text.startsWith('Fix the README tb-scenario:tb-flow-chain'));
  const receipt = find('receipt', (item) => item.request === 1);
  const reply1 = find('assistant', (item) => item.text.startsWith('Planner registered request 1.'));
  const progress = find('progress', (item) => item.request === 1);
  const user2 = find('user', (item) => item.text.startsWith('How is it going?'));
  const reply2 = find('assistant', (item) => item.text.startsWith('It is under way.'));
  record('TB-37 the progress summary hangs under the reply of the turn that registered it and above that turn\'s '
    + 'reply actions, even though another message was queued while the dialog was replying (order: message, receipt, '
    + 'reply, progress with the reply actions, the queued message, its reply)',
  user1 >= 0 && user1 < receipt && receipt < reply1 && reply1 < progress && progress < user2 && user2 < reply2
    && !items[reply1].actions && items[progress].actions,
  brief(items.map((item) => `${item.kind}${item.actions ? '*' : ''}:${item.text.slice(0, 30)}`)));
}

/** @brief TB-37：标题行与 task 行、当前在做什么（与工具卡同一规则）、各种 phase 的文字、实时更新。 */
async function chainPhases(ctx, who, board) {
  const records = (await phasesOf(ctx, who.tab, who.since));
  const rows = records.filter((item) => item.task);
  const titles = Object.fromEntries((board?.tasks ?? []).map((task) => [task.id, task.title]));
  const rowFormat = rows.every((item) => item.text.startsWith(`${item.task} ${titles[item.task]} · `));
  const heads = records.filter((item) => item.request === 1);
  const headFormat = heads.every((item) => /^Request 1 · Fix the README · .+ · (<1 min|\d+ min)$/.test(item.text));
  const seen = (task, phase, text) => rows.some((item) => item.task === task && item.phase === phase
    && item.text === text);
  const run = `T1 Fix README · executor · Run ${commandTitle(FLOW_TEXT.longCommand)}`;
  const read = 'T1 Fix README · executor · Read README.md';
  const multi = `T4 Update notes · executor · Run ${commandTitle(FLOW_TEXT.multiCommand)}`;
  const range = `T4 Update notes · executor · Read README.md${rangeTitle(FLOW_TEXT.readRange)}`;
  ctx.flow.chainRows = { run, read, multi, range, seen: [seen('T1', 'running', run), seen('T1', 'running', read)],
    seenMore: [seen('T4', 'running', multi), seen('T4', 'running', range)] };
  record('TB-37 title line "Request 1 · <title> · <state> · <duration>" and task rows "T<n> <title> · …" use the '
    + 'board titles at every update; the running row shows the latest tool call with the tool-card title rule: '
    + '"Run <first line cut to 80>…" while the bash call runs, then "Read README.md" for the absolute path',
  rows.length > 0 && rowFormat && heads.length > 0 && headFormat && seen('T1', 'running', run)
    && seen('T1', 'running', read), brief({ rows: rows.map((r) => `${r.phase}|${r.text}`).slice(0, 40) }, 3000));
  record('TB-37 the running row keeps the rest of the tool-card title rule: a two-line command whose first line fits '
    + 'reads "Run <first line> …" and a read with offset/limit reads "Read README.md · lines 3–4" (T4)',
  ctx.flow.chainRows.seenMore.every(Boolean), brief({ multi, range, t4: rows.filter((r) => r.task === 'T4')
    .map((r) => `${r.phase}|${r.text}`) }, 2000));
  const states = [...new Set(heads.map((item) => item.state))];
  record('TB-37 phase texts seen live: Starting, a running tool title, pending "Waiting for T1", lock_wait "Waiting to '
    + 'change files (T1)", with_close "With planner", and the request state going Running → With planner → Done',
  seen('T2', 'starting', 'T2 Count lines · executor · Starting')
    && seen('T3', 'pending', 'T3 Summarize · Waiting for T1')
    && seen('T4', 'lock_wait', 'T4 Update notes · executor · Waiting to change files (T1)')
    && seen('T2', 'with_close', 'T2 Count lines · With planner') && same(states, ['running', 'with_close', 'done']),
  brief({ states, phases: [...new Set(rows.map((r) => `${r.task}:${r.phase}`))] }));
}

/** @brief TB-37：需求关闭后 Done、时长停在 closedAt、没有 Running 的行、有结论；展开的交接链（含程序写的一棒）。 */
async function chainClosed(ctx, who, board, withClose) {
  await setProgressOpen(ctx, who.tab, 1, false);
  const [collapsed] = await progressOf(ctx, who.tab);
  await setProgressOpen(ctx, who.tab, 1, true);
  const [open] = await progressOf(ctx, who.tab);
  await setProgressOpen(ctx, who.tab, 1, false);
  const request = board?.requests[0];
  const title = `Request 1 · Fix the README · Done · ${durationOf(request.closedAt - request.createdAt)}`;
  ctx.flow.chainTitle = { title, createdAt: request.createdAt };
  record('TB-37 when the request closes: "Done", the duration stops at closedAt, no task rows and no "Running" '
    + 'when collapsed; expanded shows every task Done/Failed and the conclusion; it was "With planner" while all '
    + 'tasks had ended and the request was still open',
  collapsed?.state === 'done' && collapsed.title === title && collapsed.tasks.length === 0
    && !collapsed.title.includes('Running') && open.conclusion === 'Conclusion: README fixed'
    && same(open.tasks.map((t) => t.text), ['T1 Fix README · Done', 'T2 Count lines · Done', 'T3 Summarize · Done',
      'T4 Update notes · Failed']) && withClose?.title.includes(' · With planner · '),
  brief({ collapsed, open: open?.tasks, conclusion: open?.conclusion, withClose: withClose?.title }));
  record('TB-37 expanded handoff chains use the first sentence of each conclusion and show the program-written baton: '
    + 'T1 "executor: Fixed the title → reviewer: Logout test fails → executor: Logout fixed too → planner: Fixed and '
    + 'verified", T4 "Mori: no handoff → planner: …"; the failed T4 is the ruled-out approach',
  open?.chains.T1 === 'executor: Fixed the title → reviewer: Logout test fails → executor: Logout fixed too → '
    + 'planner: Fixed and verified' && open.chains.T4 === 'Mori: no handoff → planner: Notes approach did not work'
    && open.chains.T2 === 'executor: a.ts has 3 lines → planner: Counted' && same(open.ruledOut,
    ['Notes approach did not work']), brief({ chains: open?.chains, ruledOut: open?.ruledOut }));
}

/**
 * @brief TB-37、TB-55：进展摘要与工具卡同一标题规则——关闭模式下对话自己跑同样的两条命令、读同一个绝对路径
 *        （整个文件、带行范围），与 chain 一步里 T1、T4 的行比较（tb-flow-titles）。
 */
async function titles(ctx) {
  const who = await begin(ctx, ctx.split, 'Run and read tb-scenario:tb-flow-titles', { team: false, allow: true });
  await settle(ctx, who, 60000);
  const cards = await toolCardsOf(ctx, who.tab);
  const [run, multi] = cards.filter((card) => card.verb === 'Run');
  const [read, range] = cards.filter((card) => card.verb === 'Read');
  const rows = ctx.flow.chainRows;
  record('TB-37 the progress row uses the same title rule as tool cards: for the same long two-line command and the '
    + 'same absolute path, the tool cards read "Run <cut command>" and "Read README.md", and the progress rows of '
    + 'the chain step read "Run <same>" and "Read README.md"',
  run?.target === commandTitle(FLOW_TEXT.longCommand) && read?.target === 'README.md'
    && (rows === undefined || (rows.run.endsWith(`Run ${run.target}`) && rows.read.endsWith(`Read ${read.target}`)
      && rows.seen.every(Boolean))),
  brief({ cards, rows }));
  const alike = multi?.target === commandTitle(FLOW_TEXT.multiCommand)
    && range?.target === `README.md${rangeTitle(FLOW_TEXT.readRange)}` && rows !== undefined
    && rows.multi.endsWith(` · Run ${multi.target}`) && rows.range.endsWith(` · Read ${range.target}`)
    && rows.seenMore.every(Boolean);
  const detail = brief({ multi, range, rows: rows && { multi: rows.multi, range: rows.range, seen: rows.seenMore } });
  record('TB-37 a two-line command whose first line fits and a read with offset/limit: the progress rows of the chain '
    + 'step (T4) read the same titles as the tool cards — "Run echo tb-flow-multi …" and "Read README.md · lines '
    + '3–4"', alike, detail);
  record('TB-55 the tool card title of a multi-line command ("Run <first line> …") and of a read with offset/limit '
    + '("Read <path> · lines a–b") is the same text as the progress row of a task instance making the same call',
  alike, detail);
}

// ---------- 主路径 (d)、(e) ----------

/** @brief 主路径 (d)：关闭模式下对话 agent_message 给 executor，开只读的临时提问实例，回答成为工具结果。 */
async function ask(ctx) {
  const who = await begin(ctx, ctx.split, 'Ask executor about the README tb-scenario:tb-flow-ask', { team: false });
  await settle(ctx, who, 60000);
  const pane = await paneState(ctx.page, who.tab);
  const asks = scenarioRequests(ctx.ep, 'tb-flow-ask', { agent: 'executor', kind: 'ask' });
  const files = instanceFiles(ctx, who.sessionId);
  const rows = await ctx.page.locator('.session-item').evaluateAll((els) => els.map((el) => el.dataset.file));
  record('main path (d) off mode with other roles: agent_message to executor opens a read-only ask instance (its '
    + 'requests have only read), its answer becomes the tool result in the dialog\'s reply, the ask session file '
    + 'is under teams/<id>/sessions and not in the sidebar',
  pane.assistants.at(-1) === 'Executor answered: README.md describes the fixture project.' && asks.length === 2
    && asks.every((item) => same(item.tools, ['read'])) && files.length === 1
    && instanceSuffix(who.sessionId, files[0].id) === 'ask.1.executor' && files[0].first?.data?.kind === 'ask'
    && !rows.some((file) => file && file.includes('.ask.')),
  brief({ reply: pane.assistants.at(-1), tools: asks.map((item) => item.tools), files: files.map((f) => f.id) }));
}

/** @brief 主路径 (e) 与 TB-37 approval：task 实例的 bash 在"每次询问"下出后台批准卡，允许后执行。 */
async function approve(ctx) {
  const who = await begin(ctx, ctx.split, 'Run echo tb-scenario:tb-flow-approve');
  const card = await waitApprovalCard(ctx, who.tab, { agent: 'executor' }, 30000);
  const row = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'approval' }, 10000);
  if (card) await ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"] [data-testid="approval-allow"]`)
    .click();
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const evidence = board?.tasks[0]?.handoffs[0]?.evidence[0];
  record('main path (e) a task instance\'s bash under "Ask each time" shows a background approval card in the user '
    + 'session ("executor · T1 · Echo hello", data-agent executor, data-task T1); approving lets it run and the task '
    + 'is done with the command as evidence', card?.attribution === 'executor · T1 · Echo hello' && card.task === 'T1'
    && card.tool === 'bash' && board?.tasks[0]?.status === 'done' && evidence?.title === 'Run echo hello-from-T1'
    && evidence.ok === true, brief({ card, evidence }));
  record('TB-37 a task waiting for your approval reads "Waiting for your approval"',
    row === 'T1 Echo hello · executor · Waiting for your approval', brief({ row }));
}

// ---------- 重启：TB-12、TB-37 重新打开（最后一步） ----------

/** @brief T1 在运行中时退出 App；重新打开各步的会话，比较回执、进展摘要与 TaskBoard，T1 为 Stopped (Mori restarted)。 */
async function restart(ctx) {
  const who = await begin(ctx, ctx.split, 'Start a long job tb-scenario:tb-flow-restart');
  ctx.flow.restart = who;
  const running = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'starting' }, 30000);
  const before = new Map();
  for (const [id, item] of ctx.watched) {
    const board = readBoard(ctx, id);
    if (!board) continue;
    before.set(id, { stream: await snapshotStream(ctx, item), file: readFileSync(join(teamDir(ctx, id), 'board.json'),
      'utf8'), view: await boardViewOf(ctx, id) });
  }
  await restartTbApp(ctx);
  await restartCompare(ctx, before, who);
  await restartStopped(ctx, who, running);
  await frozenDuration(ctx);
}

/** @brief TB-12、TB-37：重启后重新打开，已结束的会话的 TaskBoard、回执、进展摘要与重启前一致。 */
async function restartCompare(ctx, before, live) {
  const diffs = [];
  let compared = 0;
  for (const [id, prior] of before) {
    if (id === live.sessionId) continue;
    const item = ctx.watched.get(id);
    item.tab = await reopenSession(ctx, item.sessionFile);
    await poll(async () => (await progressOf(ctx, item.tab)).length === prior.stream.collapsed.length, 15000);
    const stream = await snapshotStream(ctx, item);
    const file = readFileSync(join(teamDir(ctx, id), 'board.json'), 'utf8');
    const view = await boardViewOf(ctx, id);
    compared += 1;
    if (!same(stream, prior.stream)) diffs.push({ id, before: prior.stream, after: stream });
    if (file !== prior.file) diffs.push({ id, board: 'board.json changed' });
    if (!same(view, prior.view)) diffs.push({ id, view: 'board.get changed' });
  }
  record('TB-12 after restarting Mori and reopening each session, the TaskBoard (board.json byte for byte and '
    + 'board.get), the receipts and the progress summaries are all there and unchanged',
  compared >= 1 && diffs.length === 0, brief({ compared, diffs }, 3000));
  record('TB-37 after reopening, the progress summaries have the same content (title, state, task rows, chains, '
    + 'ruled-out approaches, conclusion) as before the restart', compared >= 1
    && !diffs.some((item) => item.after), brief({ compared, diffs: diffs.filter((item) => item.after) }, 3000));
}

/** @brief TB-37：重启时在运行的 task 为 Stopped (Mori restarted)，需求为 Stopped。 */
async function restartStopped(ctx, who, running) {
  who.tab = await reopenSession(ctx, who.sessionFile);
  const row = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'stopped_restart' }, 20000);
  const [block] = await progressOf(ctx, who.tab);
  const board = readBoard(ctx, who.sessionId);
  record('TB-37 a task that was running when Mori exited reads "Stopped (Mori restarted)" after reopening and the '
    + 'request reads "Stopped"; board.json has it stopped with stopReason restart',
  running === 'T1 Long read · executor · Starting' && row === 'T1 Long read · executor · Stopped (Mori restarted)'
    && block?.state === 'stopped' && block.title.includes(' · Stopped · ') && board?.tasks[0].status === 'stopped'
    && board.tasks[0].stopReason === 'restart', brief({ running, row, block: block?.title, task: board?.tasks[0] }));
}

/** @brief TB-37：关闭的需求的时长停在 closedAt（等到登记之后过了 1 分钟以上再看，界面仍写 closedAt 那一刻的时长）。 */
async function frozenDuration(ctx) {
  const chained = ctx.flow.chain;
  if (!chained || !ctx.flow.chainTitle) return;
  const wait = ctx.flow.chainTitle.createdAt + 65000 - Date.now();
  if (wait > 0) await sleep(wait);
  chained.tab = await reopenSession(ctx, chained.sessionFile);
  const [block] = await progressOf(ctx, chained.tab);
  record('TB-37 the duration of a closed request stays at closedAt: more than a minute after it was registered the '
    + 'title still reads the closing duration', block?.title === ctx.flow.chainTitle.title
    && Date.now() - ctx.flow.chainTitle.createdAt > 60000, brief({ title: block?.title, want: ctx.flow.chainTitle }));
}

// ---------- 整个套件的检查 ----------

/** @brief board.json 的读取检查（原子写出，§3）：后台每 20 毫秒读一次每个会话的 board.json。 */
function startBoardReader(ctx) {
  ctx.boardReads = 0;
  ctx.boardBad = [];
  ctx.boardTimer = setInterval(() => {
    for (const id of ctx.watched.keys()) {
      let text;
      try {
        text = readFileSync(join(teamDir(ctx, id), 'board.json'), 'utf8');
      } catch {
        continue;
      }
      ctx.boardReads += 1;
      try {
        const board = JSON.parse(text);
        if (board.version !== 1 || !Array.isArray(board.tasks)) ctx.boardBad.push(`${id}: not a board`);
      } catch (error) {
        ctx.boardBad.push(`${id}: ${error.message} (${text.length} bytes)`);
      }
    }
  }, 20);
}

/** @brief §13.3 的状态顺序：每隔一会儿读 board.json、界面、再读 board.json，两次相同时比较 data-state。 */
function startStateSampler(ctx) {
  ctx.stateSamples = 0;
  ctx.stateBad = [];
  const loop = async () => {
    while (!ctx.stopSampling) {
      for (const [id, who] of ctx.watched) {
        if (ctx.stopSampling || !ctx.page) break;
        const first = readBoard(ctx, id);
        await sleep(400);
        let blocks = [];
        try {
          blocks = await progressOf(ctx, who.tab);
        } catch {
          continue;
        }
        await sleep(400);
        const second = readBoard(ctx, id);
        if (!first || !same(first, second)) continue;
        for (const block of blocks) {
          const request = first.requests.find((item) => item.no === block.request);
          if (!request) continue;
          ctx.stateSamples += 1;
          const want = expectedState(first, request);
          if (block.state !== want) ctx.stateBad.push(`${who.tab} R${block.request}: ${block.state} ≠ ${want}`);
        }
      }
      await sleep(200);
    }
  };
  ctx.sampling = loop().catch((error) => ctx.stateBad.push(`sampler: ${error.message}`));
}

/** @brief 套件结束时的检查：board.json 从没读到半截、没有留下临时文件；§13.3 的状态；端点没有多出来的请求。 */
async function finalChecks(ctx) {
  const leftovers = [...ctx.watched.keys()].flatMap((id) => teamDirFiles(ctx, id).filter((name) => name !== 'board.json'
    && name !== 'sessions').map((name) => `${id}/${name}`));
  const writeErrors = appLogLines(ctx, /cannot write .*board\.json|the TaskBoard was not written/);
  // 本套件每 20 毫秒读一次 board.json，Windows 上会挡住改名；Mori 重试成功的次数只记在 detail 里。
  const retries = appLogLines(ctx, /renaming .*board\.json\.tmp failed/).length;
  record('TB-12 board.json is written atomically: every one of the reads taken every 20 ms during the runs parsed as '
    + 'a whole board, no board.json.tmp is left behind and Mori logged no failed write',
  ctx.boardReads > 100 && ctx.boardBad.length === 0 && leftovers.length === 0 && writeErrors.length === 0,
  brief({ reads: ctx.boardReads, bad: ctx.boardBad.slice(0, 5), leftovers, writeErrors, retries }));
  record('TB-37 the request state on screen follows the order of §13.3 (computed from board.json) at every stable '
    + 'sample', ctx.stateSamples >= 10 && ctx.stateBad.length === 0,
  brief({ samples: ctx.stateSamples, bad: ctx.stateBad.slice(0, 8) }));
  const missing = missingSteps(ctx.ep);
  record('flow: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
}

// ---------- 主流程 ----------

const steps = { offPlain, merged, steer, sysmd, renumber, queueStop, lockStop, chain, titles, ask, approve, restart };

const ctx = { userData: tempUserData('mori-tb-flow-data-'), exePath: args.exePath, watched: new Map(), flow: {},
  pageErrors: [] };
try {
  await setup(ctx);
  startBoardReader(ctx);
  startStateSampler(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-flow] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: flow`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  ctx.stopSampling = true;
  await ctx.sampling;
  await finalChecks(ctx);
} finally {
  ctx.stopSampling = true;
  clearInterval(ctx.boardTimer);
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-flow] data in ${ctx.userData}; projects ${ctx.merged}, ${ctx.split}, ${ctx.sys}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
