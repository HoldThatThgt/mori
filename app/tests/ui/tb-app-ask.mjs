// 平行 Agent 与 TaskBoard 的 App 套件：Agent 消息、读会话与订阅（docs/specs/parallel-agents-taskboard.md §17.2）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/ask.mjs，synthetic），
// 逐条验收这些编号在 App 层的通过条件：
//   TB-04 临时提问、TB-27 留给 task 的消息、TB-28 发给座位会话的消息、TB-29 read_session、TB-33 订阅。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs ask）：
//   MORI_APP_DIR=.tb-runs/ask node tests/ui/tb-app-ask.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-ask(-packaged).json（--only 时 tb-partial-app-ask…），截图在 test-results/tb-app-ask/。
// 端口（§17.1 的 4600–4699 里分给本套件的 4620–4629）：合成端点 4620，记录代理 4621（看完整的请求体）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好六个本机提供商（写入等级 A、能关思考，跳过探针）：
//   tbm（fake-main、fake-b，会话默认的范围）、tbx（fake-x，不在对话的范围里）、tbr（fake-think-replay，带思考）、
//   tbs、tbt（fake-sw1、fake-sw2，换模型用）、tbq（fake-q，并发 2：task 与 background 只有一个槽位）；
//   七个临时项目，各自的角色文件见 setup()。步骤各用自己的会话，按顺序跑，同一时间只开一个 App。

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_TEXT } from '../fake-endpoint/scenarios/ask.mjs';
import { SEGMENT_SENTENCES, SHARED_SENTENCE } from '../fake-endpoint/scripts.mjs';
import {
  appLogLines, brief, closeTbApp, contentText, customOf, instanceFiles, instanceSuffix, lineBrief,
  messagesOf, missingSteps, openSessionIn, paneState, poll, readBoard, readJsonl, scenarioLines, scenarioRequests,
  seedTeamUserData, sendMessage, shot, SPLIT_ROLES, startTbApp, startTbEndpoint, stopTbEndpoint, suiteArgs, tbModel,
  tbProvider, tbRecorder, tempProject, tempUserData, userSession, waitTaskPhase, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';

const args = suiteArgs('ask');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4620;
const PROXY = 4621;
/** 合成端点 -replay 模型开着思考时每个回复带的思考（server.mjs REPLAY_THINKING） */
const THINKING = 'Synthetic reasoning before answering.';
/** 程序给的固定文字（§10.1、§10.2） */
const SHOWS = {
  noTasksOff: 'There are no tasks when task mode is off.',
  turnCap: 'Message limit reached: at most 5 questions per turn.',
  ownSession: "You can't send a message to your own session.",
  whichRequest: 'Say which request (request: N).',
  stillRunning: '(still running)',
  abandoned: '(abandoned after a model switch)',
  toc: 'This session is longer than 12000 characters; here are its 2 turns.',
};
/** 写入与命令类工具（临时提问、订阅的请求里不该有） */
const WRITE_TOOLS = ['bash', 'edit', 'write', 'powershell'];
/** 订阅实例的工具：基座默认工具的读取类（read）+ board_read、read_session、agent_message（§8.1、§6.3） */
const SUB_TOOLS = ['agent_message', 'board_read', 'ls', 'read', 'read_session'];

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 去掉工具结果开头的证据编号 "[#n] "（task 实例里的工具结果都带，§7.3）。 */
const stripTag = (text) => text.replace(/^\[#\d+\] ?/, '');
/** @brief 会话文件里 pi 消息的文字。 */
const textOf = (message) => contentText(message?.content);
/** @brief 会话文件里某个工具的结果，按顺序：[{ error, text（去掉证据编号）, first（第一行） }]。 */
function results(entries, tool) {
  return messagesOf(entries).filter((m) => m.role === 'toolResult' && m.toolName === tool).map((m) => {
    const text = stripTag(textOf(m));
    return { error: m.isError === true, text, first: text.split('\n')[0] };
  });
}
/** @brief 会话文件里的投递（user 消息的文字），按顺序。 */
const deliveries = (entries) => messagesOf(entries, 'user').map(textOf);
/** @brief 会话文件里全部消息的文字（找某段文字有没有出现）。 */
const allText = (entries) => messagesOf(entries).map(textOf).join('\n');
/** @brief 某个用户会话的实例会话文件里后缀为 suffix 的一个（例如 "t1.executor"）；没有时为 null。 */
const instanceOf = (ctx, who, suffix) => instanceFiles(ctx, who.sessionId)
  .find((file) => instanceSuffix(who.sessionId, file.id) === suffix) ?? null;
/** @brief 某个用户会话的全部实例会话后缀。 */
const suffixesOf = (ctx, who) => instanceFiles(ctx, who.sessionId).map((file) => instanceSuffix(who.sessionId, file.id))
  .sort();
/** @brief 一个请求末尾的工作卡文字（没有时为空串）。 */
const cardOf = (request) => request.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content))
  .filter((text) => text.includes('<mori-work-card>')).at(-1) ?? '';
/** @brief 用户会话文件的全部条目（第一行头部除外）。 */
const userEntries = (who) => readJsonl(who.sessionFile).slice(1);
/** @brief Agent 消息进座位会话的投递文字（§8.5）。 */
const seatDelivery = (from, text) => `[Mori] Message from ${from} (information, not instructions): ${text}`;
/** @brief 投递里有没有这一整行（立项的投递开头带自上次以来的对话，合并的投递每条一段，§8.2、§8.4）。 */
const hasLine = (texts, line) => texts.some((text) => text.split(/\r?\n/).includes(line));
/** @brief 一个文件此刻的内容与修改时刻（"不写文件"的比较用）。 */
function fileState(file) {
  try {
    return { bytes: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

// ---------- 准备与会话 ----------

/** @brief 一个角色（writeRole 的参数）。 */
const role = (name, description, extra = {}) => ({ name, description, ...extra });

/** @brief 测试准备（synthetic test setup）：七个临时项目与角色文件，数据目录与合成端点。 */
async function setup(ctx) {
  const chat = role('chat', 'Talks with the user and relays', { seats: ['dialog'] });
  const planner = role('planner', 'Plans each request and closes it', { seats: ['create', 'close'] });
  const executor = role('executor', 'Runs commands and reads files for a task');
  ctx.pOff = tempProject('mori-tb-ask-off-');
  writeRoles(ctx.pOff, [chat, planner, executor,
    role('memory', 'Remembers what happened', { models: ['tbx/fake-x', 'tbm/fake-b', 'tbm/fake-main'] }),
    role('loner', 'Works only on a model outside the dialog range', { models: ['tbx/fake-x'] })]);
  ctx.pSep = tempProject('mori-tb-ask-sep-');
  writeRoles(ctx.pSep, [chat, role('planner', 'Plans each request', { seats: ['create'] }),
    role('closer', 'Closes each request', { seats: ['close'] }), executor,
    role('reviewer', 'Checks the work of another role')]);
  ctx.pSplit = tempProject('mori-tb-ask-split-');
  writeRoles(ctx.pSplit, SPLIT_ROLES);
  ctx.pMerged = tempProject('mori-tb-ask-merged-');
  ctx.pRead = tempProject('mori-tb-ask-read-');
  writeRoles(ctx.pRead, [chat, planner, role('executor', 'Writes long notes', { models: ['tbr/fake-think-replay'] }),
    role('reviewer', 'Reads the work of other roles'),
    role('switcher', 'Works on two models', { models: ['tbs/fake-sw1', 'tbt/fake-sw2'] })]);
  ctx.pSub = tempProject('mori-tb-ask-sub-');
  writeRoles(ctx.pSub, [chat, planner, executor,
    role('memory', 'Keeps notes about ruled-out approaches', { subscribe: [{ request_closed: { ruled_out: true } }] }),
    role('auditor', 'Looks at plain failures and cancellations',
      { subscribe: [{ request_closed: { ruled_out: false, outcome: ['failed', 'cancelled'] } }] }),
    role('picky', 'Only failures with ruled-out approaches',
      { subscribe: [{ request_closed: { ruled_out: true, outcome: ['failed'] } }] })]);
  ctx.pCls = tempProject('mori-tb-ask-cls-');
  writeRoles(ctx.pCls, [chat, planner, executor, role('worker', 'Works on the narrow provider',
    { models: ['tbq/fake-q'] }), role('watcher', 'Watches every request', { models: ['tbq/fake-q'],
    subscribe: ['request_closed'] })]);
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, { providers: [
    tbProvider('tbm', PROXY, [tbModel('fake-main'), tbModel('fake-b')]),
    tbProvider('tbx', PROXY, [tbModel('fake-x')]),
    tbProvider('tbr', PROXY, [tbModel('fake-think-replay', { reasoning: true })]),
    tbProvider('tbs', PROXY, [tbModel('fake-sw1')]),
    tbProvider('tbt', PROXY, [tbModel('fake-sw2')]),
    tbProvider('tbq', PROXY, [tbModel('fake-q')], { concurrency: 2 }),
  ], normalDefault: 'tbm' });
  await startTbApp(ctx);
}

/** @brief 在 project 里开一个新会话，发第一条消息（默认带 /task）；返回 { tab, sessionId, sessionFile, since }。 */
async function begin(ctx, project, text, { team = true } = {}) {
  const tab = await openSessionIn(ctx, project);
  const since = Date.now();
  await sendMessage(ctx, tab, text, { team });
  return { tab, ...(await userSession(ctx, tab)), since };
}

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/** @brief 等端点收到某个会话（agent、kind、task）的第 n 个请求（从 1 起），返回那一行；超时为 null。 */
function waitLine(ctx, scenario, where, n = 1, timeout = 60000) {
  return poll(() => scenarioLines(ctx.ep, scenario, where)[n - 1] ?? null, timeout, 50);
}

// ---------- TB-04：关闭模式下的临时提问 ----------

/** @brief 关闭模式（tb-ask-off）：问 memory、planner、loner、T1；第 2 回合连发 6 条，第 3 回合再发 1 条。 */
async function offAsk(ctx) {
  const who = await begin(ctx, ctx.pOff, 'Ask around tb-scenario:tb-ask-off', { team: false });
  await settle(ctx, who, 90000);
  await sendMessage(ctx, who.tab, 'Ask executor six times');
  await settle(ctx, who, 90000);
  await sendMessage(ctx, who.tab, 'Ask executor once more');
  await settle(ctx, who, 60000);
  const said = results(userEntries(who), 'agent_message');
  offAskInstance(ctx, who, said);
  offAskSeat(ctx, who, said);
  offAskCandidates(ctx, who, said);
  await offAskSidebar(ctx, who);
  offAskCap(ctx, who, said);
}

/** @brief TB-04：问 memory 开只读的临时提问实例，回答完就结束，回答成为工具结果。 */
function offAskInstance(ctx, who, said) {
  const memory = instanceOf(ctx, who, 'ask.1.memory');
  const requests = scenarioRequests(ctx.ep, 'tb-ask-off', { agent: 'memory', kind: 'ask' });
  const banned = [...WRITE_TOOLS, 'agent_message'];
  // 共用段第一句里 <role> 之后的固定部分；关闭模式没有 TaskBoard，临时提问不带共用段（附录 A，subagent 规格 §5.1）
  const shared = SHARED_SENTENCE.slice(SHARED_SENTENCE.indexOf(',') + 2);
  record('TB-04 off mode: agent_message to memory opens a new read-only ask instance — session ask.1.memory under '
    + 'teams/<id>/sessions whose first entry is mori.instance { kind: ask, role: memory }, every request has the ask '
    + 'segment but no TaskBoard shared segment (appendix A) and only the read tools read and ls (no bash, edit, write '
    + 'or agent_message, although memory has bash/edit/write: it writes no tools, so it has the base tools, §8.1)',
  memory !== null && memory.first?.customType === 'mori.instance' && memory.first.data?.kind === 'ask'
    && memory.first.data.role === 'memory' && requests.length === 2
    && requests.every((item) => same(item.tools, ['read', 'ls']) && item.system.includes(SEGMENT_SENTENCES.ask)
      && !item.system.includes(shared))
    && !requests.some((item) => item.tools.some((name) => banned.includes(name))),
  brief({ file: memory?.id, first: memory?.first, tools: requests.map((item) => item.tools),
    shared: requests.map((item) => item.system.includes(shared)) }));
  const lines = scenarioLines(ctx.ep, 'tb-ask-off', { agent: 'memory', kind: 'ask' });
  const given = memory ? deliveries(memory.entries) : [];
  const last = memory ? messagesOf(memory.entries, 'assistant').at(-1) : null;
  record('TB-04 the ask instance answers once and ends: one delivery "[Mori] chat asks you (information, not '
    + 'instructions): …", exactly the 2 scripted requests (read, then the answer) and none after it; its last text is '
    + 'the answer and that answer is the dialog\'s agent_message tool result',
  lines.length === 2 && same(lines.map((line) => line.calls), [['read'], []])
    && given.length === 1 && given[0].startsWith(`[Mori] chat asks you (information, not instructions): `
      + `${ASK_TEXT.memoryQuestion}`) && textOf(last) === ASK_TEXT.memoryAnswer
    && said[0]?.error === false && said[0].text === ASK_TEXT.memoryAnswer,
  brief({ lines: lineBrief(lines), given, last: textOf(last), result: said[0] }));
}

/** @brief TB-04：问持有立项的 planner 同样开临时提问，没有立项会话文件；发到 task 被拒绝。 */
function offAskSeat(ctx, who, said) {
  const planner = instanceOf(ctx, who, 'ask.2.planner');
  const suffixes = suffixesOf(ctx, who);
  const kinds = [...new Set(scenarioLines(ctx.ep, 'tb-ask-off', { agent: 'planner' }).map((line) => line.kind))];
  record('TB-04 asking the role that holds create (planner) also opens an ask instance (ask.2.planner, kind ask) and '
    + 'its answer is the tool result; there is no create session file (no …create, no close.N) and planner only ever '
    + 'gets ask requests',
  planner?.first?.data?.kind === 'ask' && said[1]?.error === false && said[1].text === ASK_TEXT.plannerAnswer
    && !suffixes.some((suffix) => suffix === 'create' || suffix.startsWith('close.')) && same(kinds, ['ask']),
  brief({ suffixes, kinds, result: said[1] }));
  record('TB-04 off mode: agent_message to a task is refused with "There are no tasks when task mode is off."',
    said[3]?.error === true && said[3].first === SHOWS.noTasksOff, brief(said[3]));
}

/** @brief TB-04：候选是交集、顺序按被问角色；没有交集时报错列出原因。 */
function offAskCandidates(ctx, who, said) {
  const memory = scenarioLines(ctx.ep, 'tb-ask-off', { agent: 'memory', kind: 'ask' }).map((line) => line.model);
  const dialog = scenarioLines(ctx.ep, 'tb-ask-off', { agent: 'chat' }).map((line) => line.model);
  const anyX = ctx.ep.logs.some((line) => line.model === 'fake-x');
  record('TB-04 the ask instance\'s candidates are the intersection in the asked role\'s order: memory lists '
    + 'tbx/fake-x, tbm/fake-b, tbm/fake-main and the dialog\'s range is tbm (fake-main, fake-b); memory\'s requests '
    + 'go to fake-b (its first model inside the range) while the dialog\'s go to fake-main, and fake-x never gets a '
    + 'request', memory.length === 2 && memory.every((model) => model === 'fake-b') && dialog.length > 0
    && dialog.every((model) => model === 'fake-main') && !anyX, brief({ memory, dialog, anyX }));
  const loner = said[2];
  const lines = scenarioLines(ctx.ep, 'tb-ask-off', { agent: 'loner' });
  record('TB-04 no intersection: asking loner (models: [tbx/fake-x]) fails — the tool result is an error "No model in '
    + 'your range fits loner: …" that names the candidate tbx/fake-x with the reason it was excluded; loner never '
    + 'gets a request', loner?.error === true && loner.first.startsWith('No model in your range fits loner: ')
    && loner.text.includes('tbx/fake-x') && lines.length === 0, brief({ loner, lines: lines.length }));
}

/** @brief TB-04：实例会话不在侧栏（也不在会话列表里）。 */
async function offAskSidebar(ctx, who) {
  const rows = await ctx.page.locator('.session-item').evaluateAll((els) => els.map((el) => el.dataset.file ?? ''));
  const files = instanceFiles(ctx, who.sessionId).map((file) => file.file);
  const listed = await ctx.page.evaluate(() => window.mori.request({ type: 'session.list' })).catch(() => null);
  const listText = JSON.stringify(listed ?? '');
  record('TB-04 ask instance sessions are not in the sidebar: no sidebar row and no session.list entry points at any '
    + 'file under teams/<id>/sessions (the user session itself is listed)', files.length >= 8
    && rows.includes(who.sessionFile) && !rows.some((file) => file.includes(`teams`) || file.includes('.ask.'))
    && !files.some((file) => listText.includes(JSON.stringify(file).slice(1, -1))),
  brief({ rows: rows.length, files: files.length, listed: listText.slice(0, 200) }));
}

/** @brief TB-04：关闭模式下对话每回合超过 5 条报错，下一回合又可以发。 */
function offAskCap(ctx, who, said) {
  const turn2 = said.slice(4, 10);
  const turn3 = said.slice(10);
  const asks = suffixesOf(ctx, who).filter((suffix) => /^ask\.\d+\.executor$/.test(suffix));
  record('TB-04 at most 5 questions per dialog turn in off mode: in the second turn the first five agent_message '
    + 'calls are answered and the sixth is refused with "Message limit reached: at most 5 questions per turn."; the '
    + 'next turn can ask again (6 executor ask instances in all)',
  turn2.length === 6 && turn2.slice(0, 5).every((item) => !item.error && item.text === ASK_TEXT.executorAnswer)
    && turn2[5].error && turn2[5].first === SHOWS.turnCap && turn3.length === 1 && !turn3[0].error
    && asks.length === 6, brief({ turn2, turn3, asks }));
}

// ---------- TB-28：发给座位会话的消息（座位分开） ----------

/** @brief tb-ask-seats：进立项、进结案（按发送方的需求与按 request）、等回复、互相等待、发给自己、对话不被唤醒。 */
async function seats(ctx) {
  const who = await begin(ctx, ctx.pSep, 'Send notes to the seats tb-scenario:tb-ask-seats');
  await settle(ctx, who, 120000);
  const files = { create: instanceOf(ctx, who, 'create'), close: instanceOf(ctx, who, 'close.1'),
    exec: instanceOf(ctx, who, 't1.executor') };
  const create = files.create ? deliveries(files.create.entries) : [];
  const close = files.close ? deliveries(files.close.entries) : [];
  const exec = files.exec ? results(files.exec.entries, 'agent_message') : [];
  record('TB-28 team mode: a message to the create holder (planner) goes into the create session; to the close holder '
    + '(closer) it goes into that request\'s close session — by the sender\'s request when executor writes no request, '
    + 'and by request: 1 when planner sends it',
  hasLine(create, seatDelivery('executor', ASK_TEXT.execToPlanner))
    && hasLine(close, seatDelivery('planner', ASK_TEXT.plannerToCloser))
    && hasLine(close, seatDelivery('executor', ASK_TEXT.execToCloser)) && exec[0]?.text === 'Delivered to planner.'
    && exec[1]?.text === 'Delivered to closer.', brief({ create, close, exec }));
  record('TB-28 wait: true gets the reply — executor\'s waiting agent_message returns "planner replied: '
    + '<planner\'s last text of the run that handled it>"; without wait the result is "Delivered to <role>."',
  exec[2]?.error === false && exec[2].text === `planner replied: ${ASK_TEXT.plannerReply}`
    && hasLine(create, seatDelivery('executor', ASK_TEXT.execQuestion)), brief(exec[2]));
  seatsRefusals(ctx, who, files);
  seatsDialog(ctx, who, exec);
}

/** @brief TB-28：互相等待被拒绝，不能发给自己。 */
function seatsRefusals(ctx, who, files) {
  const planner = files.create ? results(files.create.entries, 'agent_message') : [];
  const closer = files.close ? results(files.close.entries, 'agent_message') : [];
  record('TB-28 waiting on each other is refused: while closer waits for planner\'s reply, planner\'s agent_message to '
    + 'closer (request 1) is refused with "closer is waiting for you; reply instead of asking." and closer then gets '
    + '"planner replied: …"', planner[3]?.error === true
    && planner[3].first === 'closer is waiting for you; reply instead of asking.' && closer[0]?.error === false
    && closer[0].text === `planner replied: ${ASK_TEXT.plannerAnswersCloser}`, brief({ planner: planner[3], closer }));
  const self = planner[0];
  record('TB-28 a session cannot message itself: planner (create only) sending to planner from its create session is '
    + 'refused with "You can\'t send a message to your own session."; to closer without request it is refused with '
    + '"Say which request (request: N)."', self?.error === true && self.first === SHOWS.ownSession
    && planner[1]?.error === true && planner[1].first === SHOWS.whichRequest
    && planner[2]?.text === 'Delivered to closer.', brief(planner.slice(0, 3)));
}

/** @brief TB-28：对话会话不被 agent_message 唤醒：发给只持有对话的 chat 开临时提问。 */
function seatsDialog(ctx, who, exec) {
  const ask = instanceFiles(ctx, who.sessionId).find((file) => /\.ask\.\d+\.chat$/.test(file.id));
  const dialogLines = scenarioLines(ctx.ep, 'tb-ask-seats', { agent: 'chat', kind: 'team-dialog' });
  const userText = allText(userEntries(who));
  const dialogRequests = scenarioRequests(ctx.ep, 'tb-ask-seats', { agent: 'chat', kind: 'team-dialog' });
  record('TB-28 the dialog session is not woken by agent_message: executor\'s message to chat (who holds only dialog) '
    + 'opens an ask instance ask.N.chat whose answer is the tool result; the user session never gets that text, and '
    + 'chat\'s dialog session only runs for your message and the request_closed report',
  ask?.first?.data?.kind === 'ask' && deliveries(ask.entries)[0]?.startsWith(`[Mori] executor asks you (information, `
    + `not instructions): ${ASK_TEXT.execToChat}`) && exec[3]?.text === ASK_TEXT.chatAnswer
    && !userText.includes(ASK_TEXT.execToChat) && same([...new Set(dialogLines.map((line) => line.k))], [1, 2])
    && !dialogRequests.some((item) => JSON.stringify(item.messages).includes(ASK_TEXT.execToChat)),
  brief({ ask: ask?.id, k: dialogLines.map((line) => line.k), result: exec[3] }));
}

/** @brief TB-28 条数上限（tb-ask-caps）：不在需求里的 chat → planner 与需求 1 里的 executor → planner 各 11 条。 */
async function caps(ctx) {
  const who = await begin(ctx, ctx.pSep, 'Send many notes tb-scenario:tb-ask-caps');
  await settle(ctx, who, 120000);
  const chat = results(userEntries(who), 'agent_message');
  const exec = results(instanceOf(ctx, who, 't1.executor')?.entries ?? [], 'agent_message');
  const create = deliveries(instanceOf(ctx, who, 'create')?.entries ?? []);
  const delivered = (text) => hasLine(create, seatDelivery(text.split(' ')[0].toLowerCase(), text));
  record('TB-28 same request, same pair: executor (on T1 of request 1) sends 11 messages to planner — 10 are '
    + 'delivered, the 11th is refused with "Message limit reached: executor has sent 10 messages to planner in '
    + 'request 1." and never reaches the create session', exec.length === 11
    && exec.slice(0, 10).every((item) => item.text === 'Delivered to planner.') && exec[10].error
    && exec[10].first === 'Message limit reached: executor has sent 10 messages to planner in request 1.'
    && delivered('Executor note 10') && !delivered('Executor note 11'), brief({ last: exec.at(-1), n: exec.length }));
  record('TB-28 not in a request, same pair: chat (the dialog) sends 11 messages to planner — 10 are delivered, the '
    + '11th is refused with "Message limit reached: chat has sent 10 messages to planner in this session." and never '
    + 'reaches the create session', chat.length === 11
    && chat.slice(0, 10).every((item) => item.text === 'Delivered to planner.') && chat[10].error
    && chat[10].first === 'Message limit reached: chat has sent 10 messages to planner in this session.'
    && delivered('Chat note 10') && !delivered('Chat note 11'), brief({ last: chat.at(-1), n: chat.length }));
}

/** @brief TB-28：planner 持有立项与结案（tb-ask-dual）。 */
async function dual(ctx) {
  const who = await begin(ctx, ctx.pSplit, 'Both seats tb-scenario:tb-ask-dual');
  await settle(ctx, who, 90000);
  const create = instanceOf(ctx, who, 'create');
  const close = instanceOf(ctx, who, 'close.1');
  const fromCreate = results(create?.entries ?? [], 'agent_message');
  const fromClose = results(close?.entries ?? [], 'agent_message');
  record('TB-28 planner holds create and close: its create session writing request: 1 to planner goes into the close '
    + 'session of request 1, and its close session writing to planner goes into the create session',
  hasLine(deliveries(close?.entries ?? []), seatDelivery('planner', ASK_TEXT.createToClose))
    && hasLine(deliveries(create?.entries ?? []), seatDelivery('planner', ASK_TEXT.closeToCreate))
    && fromCreate[0]?.text === 'Delivered to planner.' && fromClose[0]?.text === 'Delivered to planner.',
  brief({ create: deliveries(create?.entries ?? []), close: deliveries(close?.entries ?? []), fromCreate,
    fromClose }));
}

/** @brief TB-28：基座持有全部（合并会话，tb-ask-base）。 */
async function base(ctx) {
  const who = await begin(ctx, ctx.pMerged, 'Both seats of the base tb-scenario:tb-ask-base');
  await settle(ctx, who, 90000);
  const close = instanceOf(ctx, who, 'close.1');
  const entries = userEntries(who);
  const message = entries.find((entry) => entry.type === 'message' && entry.message.role === 'user'
    && textOf(entry.message) === seatDelivery('mori', ASK_TEXT.baseCloseToCreate));
  const wakes = customOf(entries, 'mori.wake');
  const pointed = wakes.find((wake) => wake.messageId === message?.id);
  const fromUser = results(entries, 'agent_message');
  const fromClose = results(close?.entries ?? [], 'agent_message');
  record('TB-28 the base agent holds every seat (no role files, merged session): the user session (create) writing '
    + 'request: 1 to mori goes into the close session of request 1; the close session writing to mori goes into the '
    + 'user session as a hidden create_wake delivery; there is no separate create session file',
  hasLine(deliveries(close?.entries ?? []), seatDelivery('mori', ASK_TEXT.baseCreateToClose))
    && message !== undefined && pointed?.kind === 'create_wake' && fromUser[0]?.text === 'Delivered to Mori.'
    && fromClose[0]?.text === 'Delivered to Mori.' && !suffixesOf(ctx, who).includes('create'),
  brief({ close: deliveries(close?.entries ?? []), wake: pointed, fromUser, fromClose, files: suffixesOf(ctx, who) }));
}

// ---------- TB-27：留给 task 的消息 ----------

/** @brief tb-ask-notes：reviewer 在 T2 上给正在做的 T1、还在等的 T3 留言；T3 给已完成的 T2 留言被拒绝。 */
async function notes(ctx) {
  const who = await begin(ctx, ctx.pSplit, 'Leave notes on tasks tb-scenario:tb-ask-notes');
  await settle(ctx, who, 120000);
  const board = readBoard(ctx, who.sessionId);
  const task = (id) => board?.tasks.find((item) => item.id === id);
  const noteAt = task('T1')?.messages[0]?.at ?? Infinity;
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = (text) => new RegExp(`\\n- reviewer \\(\\d{2}:\\d{2}\\): ${escape(text)}`);
  const cards = (agent, id) => scenarioRequests(ctx.ep, 'tb-ask-notes', { agent, kind: 'task', task: id })
    .map((item) => ({ t: item.t, card: cardOf(item) }));
  const execT1 = cards('executor', 'T1');
  const before = execT1.filter((item) => item.t < noteAt);
  const after = execT1.filter((item) => item.t > noteAt);
  const reviewT1 = cards('reviewer', 'T1');
  const execT3 = cards('executor', 'T3');
  const left = results(instanceOf(ctx, who, 't2.reviewer')?.entries ?? [], 'agent_message');
  record('TB-27 a message to a task shows in the work card of the instance doing it now and of the next one: '
    + 'reviewer (on T2) leaves a note on T1 while executor works on it — executor\'s requests before the note have no '
    + 'such line, the one after has "Messages for T1:" with "- reviewer (hh:mm): <text>", and reviewer\'s requests '
    + 'on T1 (the next instance) have it too; the note on the pending T3 is in T3\'s first card',
  left[0]?.text === 'Left the message on T1.' && left[1]?.text === 'Left the message on T3.'
    && before.length >= 1 && before.every((item) => !item.card.includes(ASK_TEXT.noteT1)) && after.length >= 1
    && after.every((item) => item.card.includes('Messages for T1:') && line(ASK_TEXT.noteT1).test(item.card))
    && reviewT1.length >= 1 && reviewT1.every((item) => line(ASK_TEXT.noteT1).test(item.card))
    && execT3.length >= 1 && execT3[0].card.includes('Messages for T3:') && line(ASK_TEXT.noteT3).test(execT3[0].card),
  brief({ left, before: before.length, after: after.map((item) => item.card.slice(-300)), reviewT1: reviewT1.length,
    execT3: execT3[0]?.card.slice(-300) }, 3000));
  notesNobody(ctx, who, board, noteAt);
  const late = results(instanceOf(ctx, who, 't3.executor')?.entries ?? [], 'agent_message');
  record('TB-27 a message to an ended task is refused: executor on T3 writing to the done T2 gets "T2 is closed." and '
    + 'T2 has no messages', late[0]?.error === true && late[0].first === 'T2 is closed.'
    && task('T2')?.status === 'done' && task('T2').messages.length === 0, brief({ late, t2: task('T2')?.messages }));
}

/** @brief TB-27：留言不唤醒任何人：没有会话因此多一次投递，T3 在 T1 完成之前没有请求。 */
function notesNobody(ctx, who, board, noteAt) {
  const t1 = board?.tasks.find((item) => item.id === 'T1');
  const t3Lines = scenarioLines(ctx.ep, 'tb-ask-notes', { agent: 'executor', kind: 'task', task: 'T3' });
  const counts = Object.fromEntries(instanceFiles(ctx, who.sessionId)
    .map((file) => [instanceSuffix(who.sessionId, file.id), deliveries(file.entries).length]));
  const mentions = instanceFiles(ctx, who.sessionId).filter((file) => deliveries(file.entries)
    .some((text) => text.includes(ASK_TEXT.noteT1) || text.includes(ASK_TEXT.noteT3)));
  const wakes = customOf(userEntries(who), 'mori.wake').map((wake) => wake.kind);
  const soon = scenarioLines(ctx.ep, 'tb-ask-notes').filter((line) => line.t > noteAt && line.t < noteAt + 1000
    && !(line.agent === 'reviewer' && line.task === 'T2'));
  record('TB-27 leaving a message wakes nobody: in the second after the note only reviewer\'s own run on T2 sends '
    + 'requests; no session gets a delivery that carries the note (t1.executor and t3.executor have one delivery '
    + 'each, the create session one); T3 sends nothing until T1 is closed; the user session only gets the '
    + 'request_closed wake',
  t1?.closedAt > 0 && t3Lines.length > 0 && t3Lines[0].t > t1.closedAt && counts['t1.executor'] === 1
    && counts['t3.executor'] === 1 && counts.create === 1 && mentions.length === 0 && soon.length === 0
    && same(wakes, ['request_closed']), brief({ counts, mentions: mentions.map((f) => f.id), soon: lineBrief(soon),
    wakes, t3: t3Lines[0]?.t, closed: t1?.closedAt }));
}

// ---------- TB-29：read_session ----------

/** @brief 先跑另一个用户会话（tb-ask-other），再跑 tb-ask-read，读的同时比较被读的会话文件。 */
async function read(ctx) {
  const other = await begin(ctx, ctx.pRead, 'Other work tb-scenario:tb-ask-other');
  await settle(ctx, other, 120000);
  const who = await begin(ctx, ctx.pRead, 'Read the sessions tb-scenario:tb-ask-read');
  const snaps = await readSnapshots(ctx, who);
  await settle(ctx, who, 180000);
  const files = { exec: instanceOf(ctx, who, 't1.executor'), reviewT1: instanceOf(ctx, who, 't1.reviewer'),
    reviewT3: instanceOf(ctx, who, 't3.reviewer'), switcher: instanceOf(ctx, who, 't2.switcher') };
  const reads = {
    reviewT1: results(files.reviewT1?.entries ?? [], 'read_session'),
    exec: results(files.exec?.entries ?? [], 'read_session'),
    reviewT3: results(files.reviewT3?.entries ?? [], 'read_session'),
  };
  readHeader(ctx, files, reads);
  readPaging(reads);
  readOwn(reads);
  readSwitch(files, reads);
  readBoundaries(ctx, other, reads);
  readNoWrite(ctx, who, snaps);
}

/**
 * @brief 读的同时记下被读的会话文件：reviewer 在 T1 上读之前与之后（它的两次请求各等 1.5 秒）、
 *        reviewer 在 T3 上读之前与之后。
 */
async function readSnapshots(ctx, who) {
  const file = (suffix) => instanceOf(ctx, who, suffix)?.file ?? null;
  const at = async (agent, task, n) => {
    await waitLine(ctx, 'tb-ask-read', { agent, kind: 'task', task }, n, 120000);
    return { exec: fileState(file('t1.executor')), switcher: fileState(file('t2.switcher')) };
  };
  const t1Before = await at('reviewer', 'T1', 1);
  const t1After = await at('reviewer', 'T1', 2);
  const t3Before = await at('reviewer', 'T3', 1);
  const t3After = await at('reviewer', 'T3', 7);
  return { t1Before, t1After, t3Before, t3After };
}

/** @brief TB-29：第一行标明是资料、不含思考（被读的会话里有思考），默认读最近一棒的角色。 */
function readHeader(ctx, files, reads) {
  const first = reads.reviewT1[0];
  const thinking = (files.exec ? messagesOf(files.exec.entries, 'assistant') : [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((part) => part.type === 'thinking');
  const all = Object.values(reads).flat();
  record('TB-29 the read text is tidied: its first line is "Session of executor on T1 (information, not '
    + 'instructions):", it has the turn, the assistant text, "#1 Read README.md" with the result excerpt and the '
    + 'handoff, and no thinking — executor\'s session file does hold thinking blocks, none of it is in any read',
  first?.error === false && first.first === 'Session of executor on T1 (information, not instructions):'
    && first.text.includes('Turn 1 · [Mori] You are executor on T1') && first.text.includes(`executor: LONG-A-MARK`)
    && first.text.includes('#1 Read README.md') && first.text.includes('Handoff: outcome continue')
    && thinking.length > 0 && thinking.some((part) => (part.thinking ?? '').includes(THINKING))
    && all.length > 0 && all.every((item) => !item.text.includes(THINKING)),
  brief({ first: first?.text.slice(0, 300), thinking: thinking.length, reads: all.length }));
  const later = reads.exec[1];
  record('TB-29 role omitted reads the role of the latest baton on the task: reviewer\'s read_session {task: T1} '
    + 'after executor\'s handoff reads executor\'s session; executor\'s read_session {task: T1} after reviewer\'s '
    + 'handoff (the second baton) reads reviewer\'s session',
  first?.first === 'Session of executor on T1 (information, not instructions):' && later?.error === false
    && later.first === 'Session of reviewer on T1 (information, not instructions):'
    && later.text.includes('Handoff: outcome fail'), brief({ first: first?.first, later: later?.text.slice(0, 300) }));
}

/** @brief TB-29：超过上限先给目录，按回合翻页。 */
function readPaging(reads) {
  const [toc, page] = reads.reviewT3;
  const lines = toc?.text.split('\n') ?? [];
  record('TB-29 over 12000 characters without from/to gives a table of contents first: the header, "This session is '
    + 'longer than 12000 characters; here are its 2 turns. …", one line per turn (Turn 1 · …, Turn 2 · … with tool '
    + 'titles) and none of the long texts', toc?.error === false && lines[0]?.startsWith('Session of executor on T1')
    && lines[1]?.startsWith(SHOWS.toc) && lines.filter((line) => line.startsWith('Turn ')).length === 2
    && !toc.text.includes('LONG-A-MARK') && !toc.text.includes('LONG-B-MARK') && toc.text.length < 12000,
  brief({ lines: lines.map((line) => line.slice(0, 120)) }));
  const pageLines = page?.text.split('\n') ?? [];
  record('TB-29 paging by turn: read_session {from: 2, to: 2} gives only turn 2 — its delivery line, its long text '
    + 'and its calls (the self-read\'s result excerpt is indented under its call) — and no line of turn 1',
  page?.error === false && same(pageLines.filter((line) => line.startsWith('Turn ')).map((line) => line.slice(0, 7)),
    ['Turn 2 ']) && pageLines.some((line) => line.startsWith('executor: LONG-B-MARK'))
    && !pageLines.some((line) => line.startsWith('executor: LONG-A-MARK'))
    && pageLines.some((line) => line.startsWith('#3 ')),
  brief({ lines: pageLines.map((line) => line.slice(0, 80)), length: page?.text.length }));
}

/** @brief TB-29：能读自己的；正在运行时只给已完成的回合并注明 (still running)。 */
function readOwn(reads) {
  const own = reads.exec[0];
  const lines = own?.text.split('\n') ?? [];
  record('TB-29 an instance can read its own session, and a running one is marked: executor reads its own session on '
    + 'T1 during its second run — it gets turn 1 (finished) and not turn 2, and the text ends with "(still running)"',
  own?.error === false && lines[0] === 'Session of executor on T1 (information, not instructions):'
    && own.text.includes('Turn 1 · ') && own.text.includes('LONG-A-MARK') && !own.text.includes('Turn 2 · ')
    && !own.text.includes('LONG-B-MARK') && lines.at(-1) === SHOWS.stillRunning,
  brief({ head: lines.slice(0, 2), tail: lines.at(-1), length: own?.text.length }));
}

/** @brief TB-29：换模型隐藏的部分注明 (abandoned after a model switch)。 */
function readSwitch(files, reads) {
  const text = reads.reviewT3[2]?.text ?? '';
  const entries = files.switcher?.entries ?? [];
  const switched = customOf(entries, 'mori.model_switch');
  const restart = customOf(entries, 'mori.task_restart');
  const lines = text.split('\n');
  const mark = lines.indexOf(SHOWS.abandoned);
  record('TB-29 the part a model switch hid is marked: switcher\'s turn 1 on fake-sw1 was abandoned when it switched '
    + 'to fake-sw2 (mori.model_switch + mori.task_restart in its session); reading it shows "(abandoned after a model '
    + 'switch)" before the indented "#1 Read README.md" line of turn 1, then turn 2 "[Mori] The model changed …"',
  switched.length === 1 && switched[0].to?.endsWith('fake-sw2') && restart.length === 1 && mark > 0
    && lines[mark + 1]?.startsWith('  #1 Read README.md') && lines.some((line) => line.startsWith('Turn 2 · [Mori] The '
      + 'model changed')), brief({ lines: lines.map((line) => line.slice(0, 100)), switched, restart }, 2500));
}

/** @brief TB-29：读不到对话、立项、结案和别的用户会话。 */
function readBoundaries(ctx, other, reads) {
  const [, , , chat, planner, t4] = reads.reviewT3;
  const otherBoard = readBoard(ctx, other.sessionId);
  const otherT1 = instanceOf(ctx, other, 't1.executor');
  const all = Object.values(reads).flat();
  record('TB-29 read_session cannot reach the dialog, create or close sessions, or another user session: role chat '
    + '(dialog) → "chat has no session on T1.", role planner (holds create and close) → "planner has no session on '
    + 'T1.", T4 (exists only on the other session\'s board) → "T4 does not exist."; no read contains the other '
    + 'session\'s text', chat?.error === true && chat.first === 'chat has no session on T1.'
    && planner?.error === true && planner.first === 'planner has no session on T1.' && t4?.error === true
    && t4.first === 'T4 does not exist.' && otherBoard?.tasks.some((task) => task.id === 'T4')
    && allText(otherT1?.entries ?? []).includes(ASK_TEXT.otherMark)
    && all.every((item) => !item.text.includes(ASK_TEXT.otherMark)), brief({ chat, planner, t4 }));
}

/** @brief TB-29：读会话不写文件（被读的会话文件在读之前与之后完全相同，开着的与已关闭的都是）。 */
function readNoWrite(ctx, who, snaps) {
  const { t1Before, t1After, t3Before, t3After } = snaps;
  const unchanged = (a, b) => a !== null && b !== null && a.bytes === b.bytes && a.mtime === b.mtime;
  const logged = appLogLines(ctx, /read_session .* failed/);
  record('TB-29 read_session writes no file: executor\'s session file is byte for byte the same (and not touched) '
    + 'before and after reviewer reads it while it is open on T1, and both executor\'s and switcher\'s files are '
    + 'unchanged across reviewer\'s six reads on T3 after those instances were closed',
  unchanged(t1Before.exec, t1After.exec) && unchanged(t3Before.exec, t3After.exec)
    && unchanged(t3Before.switcher, t3After.switcher) && logged.length === 0,
  brief({ t1: [t1Before.exec?.mtime, t1After.exec?.mtime], t3: [t3Before.exec?.mtime, t3After.exec?.mtime],
    sw: [t3Before.switcher?.mtime, t3After.switcher?.mtime], logged }));
  void who;
}

// ---------- TB-33：订阅 ----------

/** @brief 三个会话：需求以 done 关闭且有已排除的方案、以 failed 关闭、被撤销；订阅者 memory、auditor、picky。 */
async function subs(ctx) {
  const ro = await begin(ctx, ctx.pSub, 'Try two approaches tb-scenario:tb-ask-subs-ro');
  await settle(ctx, ro, 120000);
  const failed = await begin(ctx, ctx.pSub, 'Meet the goal tb-scenario:tb-ask-subs-fail');
  await settle(ctx, failed, 120000);
  const cancel = await begin(ctx, ctx.pSub, 'Start a long job tb-scenario:tb-ask-subs-cancel');
  await waitTaskPhase(ctx, cancel.tab, { task: 'T1', phase: 'running' }, 30000)
    ?? await waitTaskPhase(ctx, cancel.tab, { task: 'T1', phase: 'starting' }, 5000);
  await poll(async () => !(await paneState(ctx.page, cancel.tab)).running, 30000);
  await sendMessage(ctx, cancel.tab, 'Cancel it, it is not needed');
  await settle(ctx, cancel, 90000);
  const sessions = { ro, failed, cancel };
  subsFilters(ctx, sessions);
  subsReadOnly(ctx, sessions);
  subsMessages(ctx, ro);
}

/** @brief 一个会话的订阅实例后缀（sub.N.<role>）。 */
const subSuffixes = (ctx, who) => suffixesOf(ctx, who).filter((suffix) => suffix.startsWith('sub.'));
/** @brief 某个脚本里订阅会话的角色（按端点的请求）。 */
const subAgents = (ctx, scenario) => [...new Set(scenarioLines(ctx.ep, scenario, { kind: 'subscription' })
  .map((line) => line.agent))].sort();

/** @brief TB-33：ruled_out、outcome 过滤命中才唤醒，没命中不唤醒。 */
function subsFilters(ctx, { ro, failed, cancel }) {
  const status = (who) => {
    const board = readBoard(ctx, who.sessionId);
    return `${board?.requests[0]?.status}:${board?.tasks.some((task) => task.status === 'failed') ? 'ruled' : 'none'}`;
  };
  const seen = { ro: subSuffixes(ctx, ro), failed: subSuffixes(ctx, failed), cancel: subSuffixes(ctx, cancel),
    agents: ['tb-ask-subs-ro', 'tb-ask-subs-fail', 'tb-ask-subs-cancel'].map((name) => subAgents(ctx, name)),
    status: [status(ro), status(failed), status(cancel)] };
  const memoryFirst = deliveries(instanceOf(ctx, ro, 'sub.1.memory')?.entries ?? [])[0] ?? '';
  record('TB-33 a subscription wakes only when its filters match: request 1 done with a ruled-out approach wakes '
    + 'memory {ruled_out: true} (sub.1.memory, delivery "[Mori] request_closed: Request 1 \"…\" closed (done)." with '
    + 'the ruled-out approach); a plain failure and a cancellation wake auditor {ruled_out: false, outcome: [failed, '
    + 'cancelled]} once each', same(seen.status, ['done:ruled', 'failed:none', 'cancelled:none'])
    && same(seen.ro, ['sub.1.memory']) && same(seen.failed, ['sub.1.auditor']) && same(seen.cancel, ['sub.1.auditor'])
    && same(seen.agents, [['memory'], ['auditor'], ['auditor']])
    && memoryFirst.startsWith('[Mori] request_closed: Request 1 "Ruled out tb-scenario:tb-ask-subs-ro" closed (done).')
    && memoryFirst.includes(ASK_TEXT.ruledOut), brief({ seen, memoryFirst: memoryFirst.slice(0, 300) }));
  const picky = ctx.ep.logs.some((line) => line.agent === 'picky');
  record('TB-33 no match, no wake: memory is not woken by the failure or the cancellation (no ruled-out approach), '
    + 'auditor not by the done request (ruled_out true, outcome done), and picky {ruled_out: true, outcome: [failed]} '
    + 'never (the filters are joined with "and": the done request has a ruled-out approach, the failed one has none)',
  !seen.failed.some((s) => s.endsWith('memory')) && !seen.cancel.some((s) => s.endsWith('memory'))
    && !seen.ro.some((s) => s.endsWith('auditor')) && !picky
    && ![ro, failed, cancel].some((who) => subSuffixes(ctx, who).some((s) => s.endsWith('picky'))),
  brief({ seen, picky }));
}

/** @brief TB-33：订阅实例只读：工具只有读取类与 board_read、read_session、agent_message；调 bash 得到 not found。 */
function subsReadOnly(ctx, { ro, failed, cancel }) {
  const requests = ['tb-ask-subs-ro', 'tb-ask-subs-fail', 'tb-ask-subs-cancel']
    .flatMap((scenario) => scenarioRequests(ctx.ep, scenario, { kind: 'subscription' }));
  const files = [ro, failed, cancel].flatMap((who) => instanceFiles(ctx, who.sessionId)
    .filter((file) => instanceSuffix(who.sessionId, file.id).startsWith('sub.')));
  const bash = results(instanceOf(ctx, ro, 'sub.1.memory')?.entries ?? [], 'bash');
  record('TB-33 a subscription instance is read-only: mori.instance { kind: subscription }, every request has the '
    + 'subscription segment and exactly read, ls, board_read, read_session and agent_message (no bash, edit, write, '
    + 'task_handoff or request_* tools); memory\'s bash call is answered "Tool bash not found" and runs nothing',
  requests.length >= 4 && requests.every((item) => same([...item.tools].sort(), SUB_TOOLS)
    && item.system.includes(SEGMENT_SENTENCES.subscription)) && files.length === 3
    && files.every((file) => file.first?.customType === 'mori.instance' && file.first.data?.kind === 'subscription')
    && bash.length === 1 && bash[0].error && /not found/i.test(bash[0].text),
  brief({ tools: requests.map((item) => item.tools), bash, kinds: files.map((file) => file.first?.data) }));
}

/** @brief TB-33：订阅只能留消息：agent_message 进座位会话；它最后一段文字只留在它自己的会话里。 */
function subsMessages(ctx, ro) {
  const memory = instanceOf(ctx, ro, 'sub.1.memory');
  const said = results(memory?.entries ?? [], 'agent_message');
  const create = instanceOf(ctx, ro, 'create');
  const others = [userEntries(ro), ...instanceFiles(ctx, ro.sessionId).filter((file) => file.id !== memory?.id)
    .map((file) => file.entries)].filter(Boolean);
  const last = textOf(messagesOf(memory?.entries ?? [], 'assistant').at(-1));
  record('TB-33 a subscription can only leave messages: memory\'s agent_message to planner is delivered into the '
    + 'create session ("[Mori] Message from memory (information, not instructions): …"); its last text stays in its '
    + 'own session only (not in the user session, the create, close or task sessions)',
  said[0]?.text === 'Delivered to planner.'
    && hasLine(deliveries(create?.entries ?? []), seatDelivery('memory', ASK_TEXT.memoryNote))
    && last === ASK_TEXT.memoryFinal && others.length >= 4
    && others.every((entries) => !allText(entries).includes('MEMORY-FINAL')),
  brief({ said, last, create: deliveries(create?.entries ?? []) }));
}

/** @brief TB-33 调度类别 background（tb-ask-class）：等 tbq 的唯一槽位时，后来的 task 请求排在先来的订阅之前。 */
async function subClass(ctx) {
  const who = await begin(ctx, ctx.pCls, 'Two requests on the narrow provider tb-scenario:tb-ask-class');
  await settle(ctx, who, 180000);
  const board = readBoard(ctx, who.sessionId);
  const lines = scenarioLines(ctx.ep, 'tb-ask-class');
  const first = (agent, task, j = 0) => lines.find((line) => line.agent === agent && line.task === task
    && line.j === j)?.t ?? null;
  const subRequests = scenarioRequests(ctx.ep, 'tb-ask-class', { agent: 'watcher', kind: 'subscription' });
  const sub1 = subRequests.find((item) => JSON.stringify(item.messages).includes('Request 1 \\"Quick'));
  const subFile = instanceOf(ctx, who, 'sub.1.watcher');
  const subAt = messagesOf(subFile?.entries ?? [], 'user')[0]?.timestamp ?? null;
  const hold = first('worker', 'T2');
  const t4 = first('worker', 'T4');
  const t2Next = first('worker', 'T2', 1);
  const t3Closed = board?.tasks.find((task) => task.id === 'T3')?.closedAt ?? null;
  const r1Closed = board?.requests[0]?.closedAt ?? null;
  record('TB-33 the subscription instance runs in the background class: on tbq (concurrency 2, one slot for task and '
    + 'background) the watcher subscription of request 1 was delivered while T2 held the slot, before T4 (a task) '
    + 'was even ready; when T2\'s long request ended, T4\'s request and T2\'s next one went first and the '
    + 'subscription\'s request came after both (task ranks above background, §12.10)',
  [hold, t4, t2Next, t3Closed, r1Closed, subAt].every((value) => typeof value === 'number') && sub1 !== undefined
    && r1Closed < t3Closed && subAt < t3Closed && t4 >= hold + 8500 && sub1.t > t4 && sub1.t > t2Next
    && sub1.t >= hold + 8500, brief({ hold: 0, r1Closed: r1Closed - hold, subAt: subAt - hold,
    t3Closed: t3Closed - hold, t4: t4 - hold, t2Next: t2Next - hold, sub: sub1 ? sub1.t - hold : null }));
}

// ---------- 主流程 ----------

const steps = { offAsk, seats, caps, dual, base, notes, read, subs, subClass };

const ctx = { userData: tempUserData('mori-tb-ask-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-ask] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: ask`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  const missing = missingSteps(ctx.ep);
  record('ask: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-ask] data in ${ctx.userData}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
