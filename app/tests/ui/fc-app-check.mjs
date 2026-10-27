// 收尾检查的 App 套件（关闭模式与界面）：docs/specs/finish-check.md §14.2 这些编号在 App 层的通过条件，状态表见 §10.4：
//   FC-02 哪些会话有 finish（关闭模式的用户会话有、增强任务没有）、FC-03 一直启用（关闭模式基座、对话持有者是角色、
//   重新打开没有 finish 时存下的会话）、FC-04 免批准、FC-05 system prompt 不变、FC-10 检查那次请求的检查块（关闭模式）、
//   FC-11 a：确认、FC-12 b：说了要做却停了、FC-13 c：重写、FC-14 上限、FC-15 排队与插话、FC-16 停止、
//   FC-17 检查那次请求出错、FC-21 换模型不隐藏、FC-23 界面不画 finish、FC-24 Customize 页、
//   FC-25 增强会话（关闭模式的增强：没有检查请求，会话文件没有检查那一行与 finish，修订的 Notes 照旧）、
//   FC-29 换到推理必须回传的模型。
// 协作模式与 Team 的部分（FC-02、FC-03、FC-10、FC-25 的协作模式情况，FC-11 的 run.lastText，FC-18、FC-19、FC-20）在
// fc-app-team.mjs。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic）：场景由你的消息里的
// "fc-scenario:<名字>" 选（tests/fake-endpoint/finish.mjs，§14.1 的表），没有场景时关键词模式回答、检查请求默认只回一个
// finish。断言看四处：记录代理收到的真实请求（含检查请求，check / checks）与合成端点的日志行、会话文件、后台进程的
// 收尾检查日志（§7.4）、界面（对话流、阶段行、侧栏、回复操作行）。
// 用法（在 app/ 下，用 out/ 的构建，或 MORI_APP_DIR 指向的构建）：
//   node tests/ui/fc-app-check.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fc-app-check(-packaged).json（--only 时 fc-partial-app-check…，不计入覆盖检查，§14.3），
// 截图与 app.log 在 test-results/fc-app-check/。
// 端口（§14.1 分给本套件的 4950–4959）：合成端点 4950，记录代理 4951。
// 测试准备（synthetic test setup，逐处注明）：数据目录里的本机提供商（跳过探针的档案；推理必须回传的模型改写第 4 步的
// 结果）、按记忆规格 §3 的格式写好的记忆文件（用户级只有 fact、strategy；一个项目有 TASTE、REVIEW）、四个临时项目
// （有 TASTE/REVIEW 条目、没有、chat.md 持有对话、增强；2026-10-27 文件系统合并之后角色文件没有 tools），合成端点每个回复第一个分块前等 800 毫秒（阶段行与
// 侧栏的变化看得到）；FC-03 的“没有 finish 时存下的会话”由这一次运行的会话文件改写而成（关掉 Mori 之后）。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPlan } from '../fake-endpoint/finish.mjs';
import { openMenuOn, rowOf } from './m3-helpers.mjs';
import { waitPreview } from './m5-helpers.mjs';
import { openToolsSection } from './m6-helpers.mjs';
import { toolRows } from './m6-tools-helpers.mjs';
import {
  allowAll, bridge, brief, closeTbApp, contentText, kernelEvents, missingSteps, oneLine, openSessionIn, paneSel,
  paneState, poll, reopenSession, sendMessage, shot, showTab, sleep, startTbEndpoint, stopTbEndpoint, tbModel,
  tbProvider, tbRecorder, tempProject, tempUserData, userSession, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';
import { STOPPED_TEXT, stagesOf } from './v1-switch-helpers.mjs';
import { checkEntries, finishCalls, headlessSessions, replyTexts } from './fc-team-helpers.mjs';
import {
  BUILTIN_TOOLS, CHECK_LINE_HEAD, FINISH_FIRST_LINE, FINISH_INVALID, FINISH_RESULT, FINISH_TOOL, NOTE_HEAD, REDO_TEXT,
  addEntryOnPage, assistantItems, attachLatest, checkFlags, checkLineOf, checkLogs, choosePick, consecutiveUsers,
  copyLatest, expectedCheck, fcArgs, fcSeen, fileView, identityLists, isCheckLine, itemsOf, linesIn, reloadUi,
  requestsIn, rewriteWithoutFinish, rowStatus, sectionOf, seedFcUserData, seedMemory, startFcApp, userTexts,
} from './fc-helpers.mjs';

const args = fcArgs('check');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4950;
const PROXY = 4951;
/** 合成端点上的模型（synthetic）：默认范围只有 fca 的这一个模型 */
const MODEL = 'fake-fc';
/** 推理必须回传的模型（-replay，FC-29） */
const REPLAY_MODEL = 'fake-coder-replay';
/** fc-404 用的模型：单独的范围，它被记成 not_found 不影响别的会话 */
const MODEL_404 = 'fc404';
/** FC-21 的模型：每种情况一个首选（各自的提供商，连不上的冷却只落在它身上），备用共用 */
const SWITCH = { a: 'fc21-a', early: 'fc21-early', work: 'fc21-b', plain: 'fc21-plain', backup: 'fc21-backup' };
/** FC-21 的分组：首选在前、备用在后 */
const GROUPS = [['g21a', 'p21a'], ['g21e', 'p21e'], ['g21w', 'p21w'], ['g21n', 'p21n']]
  .map(([id, first]) => ({ id, members: [first, 'p21z'] }));

/** 用户级条目（synthetic）：没有 TASTE、REVIEW，没有本项目条目的项目里检查那一行没有第三行 */
const USER_MEMORY = { fact: ['FCU-FACT-1 The user works in the Asia/Shanghai time zone'],
  strategy: ['FCU-STRAT-1 Plan before changing more than three modules'] };
/** 有条目的项目（synthetic）：TASTE 两条、REVIEW 一条，另有一条 fact（不进检查块） */
const PLAIN_MEMORY = { taste: ['FCP-TASTE-1 Keep answers short', 'FCP-TASTE-2 Use simple words, no jargon'],
  review: ['FCP-REVIEW-1 Run the tests before saying done'], fact: ['FCP-FACT-1 The fixture project has one file'] };
/** 会话打开之后在记忆页加的一条 TASTE（FC-10 快照） */
const E1 = 'FC10-PAGE-TASTE Answer with the conclusion first';
/** 增强脚本（synthetic，FAKE_ENHANCE_SCRIPT）：每个任务只回一句、不改条目 */
const ENHANCE_SCRIPT = { taste: [{ say: 'No TASTE changes today.' }], strategy: [{ say: 'No STRATEGY changes today.' }],
  review: [{ say: 'No REVIEW changes today.' }] };
/** 增强会话第一条消息的第一句开头（记忆规格附录 B） */
const ENHANCE_FIRST = "You are running Mori's daily ";

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 两个列表作为集合相同。 */
const sameSet = (left, right) => same([...left].sort(), [...right].sort());
/** @brief 每一步的消息里带的标记（区分会话，合成端点不认它）。 */
const tag = (name) => `[fc-${name}]`;
/** @brief 错误的一行文字。 */
const oneLineError = (error) => String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
/** @brief 收尾检查日志里加检查的那几行（"finish check <n> (<reason>)"）。 */
const addedChecks = (logs) => logs.filter((line) => /^finish check \d+ /.test(line));
/** @brief 日志行的简写（检查的 detail）。 */
const lineBrief = (lines) => lines.map((line) => `${line.model}:${line.status}:`
  + `${line.check ? `check${line.checks}` : '-'}:${(line.calls ?? []).join('+') || '-'}`);
/** @brief 一组对话流的项的简写（检查的 detail）。 */
const itemBrief = (items) => items.map((item) => `${item.kind}${item.empty ? '(empty)' : ''}:${oneLine(item.prose
  || item.text, 60)}${item.tools.length ? ` [${item.tools.join('|')}]` : ''}${item.actions ? ' +actions' : ''}`);

/** @brief 等会话（含协作）空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the session ${who.tab} did not become idle`);
}

/** @brief 新开一个会话（这个项目已有会话时 Ctrl+N，否则 Open folder…）。 */
const open = async (ctx, project = ctx.plain) => ({ tab: await openSessionIn(ctx, project) });

/**
 * @brief 从 since 到现在这个会话的读数：请求（含检查请求）、合成端点日志行、收尾检查日志、agent_settled 事件。
 * @return { since, until, reqs, lines, logs, settled }
 */
async function runView(ctx, who, since) {
  const until = Date.now();
  return { since, until, reqs: requestsIn(ctx.ep, since, until), lines: linesIn(ctx.ep, since, until),
    logs: checkLogs(ctx, who.sessionId, since),
    settled: await kernelEvents(ctx, who.sessionId, 'agent_settled', since) };
}

/**
 * @brief 在这个会话里发一条消息，等端点收到请求、会话空闲；第一次发送后补上会话 id 与会话文件。
 * @return runView 的结果
 */
async function run(ctx, who, text, { key = 'Enter', timeout = 120000 } = {}) {
  const since = Date.now();
  await sendMessage(ctx, who.tab, text, { key });
  if (!who.sessionFile) Object.assign(who, await userSession(ctx, who.tab));
  const asked = await poll(() => ctx.ep.proxy.captures.some((item) => item.chat && item.t >= since), 30000, 100);
  if (!asked) throw new Error(`no request for "${text}"`);
  await settle(ctx, who, timeout);
  return runView(ctx, who, since);
}

/** @brief 等 since 之后出现一个检查请求（记录代理收到的）；等不到时报错。 */
async function waitCheckRequest(ctx, since) {
  const seen = await poll(() => requestsIn(ctx.ep, since).some((item) => item.check), 30000, 100);
  if (!seen) throw new Error('no finish check request arrived');
}

/** @brief 发一条消息但不等它结束：补上会话 id 与会话文件，返回发送的时刻。 */
async function start(ctx, who, text) {
  const since = Date.now();
  await sendMessage(ctx, who.tab, text);
  if (!who.sessionFile) Object.assign(who, await userSession(ctx, who.tab));
  return since;
}

// ---------- 准备 ----------

/** @brief 模型配置（synthetic test setup）：默认 fca 一个模型；pb 的 -replay；p404；FC-21 的首选与备用。 */
function providers() {
  const one = (id, model, opts) => tbProvider(id, PROXY, [tbModel(model, opts)]);
  return [one('fca', MODEL), one('pb', REPLAY_MODEL, { reasoning: true }), one('p404', MODEL_404),
    one('p21a', SWITCH.a), one('p21e', SWITCH.early), one('p21w', SWITCH.work), one('p21n', SWITCH.plain),
    one('p21z', SWITCH.backup)];
}

/** @brief 测试准备（synthetic test setup）：临时项目、数据目录、记忆文件、合成端点与记录代理的拒绝规则、App。 */
async function setup(ctx) {
  ctx.plain = tempProject('mori-fc-plain-');
  ctx.bare = tempProject('mori-fc-bare-');
  ctx.chat = tempProject('mori-fc-chat-');
  writeRoles(ctx.chat, [{ name: 'chat', description: 'Talks with the user', seats: ['dialog'] },
    { name: 'executor', description: 'Changes code and runs commands to finish a task' }]);
  ctx.enh = tempProject('mori-fc-enh-');
  seedFcUserData(ctx.userData, { providers: providers(), groups: GROUPS, normalDefault: 'fca',
    replay: [REPLAY_MODEL] });
  seedMemory(ctx.userData, USER_MEMORY, [{ cwd: ctx.plain, prefix: 'plain', entries: PLAIN_MEMORY }]);
  const script = join(args.shots, 'enhance-script.json');
  writeFileSync(script, `${JSON.stringify(ENHANCE_SCRIPT, null, 2)}\n`);
  ctx.ep = await startTbEndpoint(PORT, PROXY, { FAKE_ENHANCE_SCRIPT: script, FAKE_FIRST_DELAY_MS: '800' });
  // 按模型的拒绝规则（FC-21）：记录代理每个对话请求问一次
  ctx.rules = {};
  ctx.ep.proxy.rule = (request) => ctx.rules[request.model]?.(request) ?? null;
  await startFcApp(ctx);
}

// ---------- 步骤 prompt：关闭模式的基座（有 TASTE、REVIEW 条目的项目） ----------

/** @brief 关闭模式的基座发两条（关键词模式，检查请求默认回 finish）。FC-02、FC-03、FC-05、FC-10。 */
async function prompt(ctx) {
  const who = await open(ctx);
  ctx.s1 = who;
  const r1 = await run(ctx, who, `plain first question ${tag('s1')}`);
  const n1 = fileView(who.sessionFile).systems.length;
  const r2 = await run(ctx, who, `plain second question ${tag('s1')}`);
  const n2 = fileView(who.sessionFile).systems.length;
  promptTools(r1, r2, n1, n2);
  promptSystem(r1);
  promptBlock(ctx, who, r1, r2);
}

/** @brief FC-02、FC-03：两次运行的每个请求都有 finish，第二次运行没有工具的补丁。 */
function promptTools(r1, r2, n1, n2) {
  const all = [...r1.reqs, ...r2.reqs];
  const tools = brief(all.map((item) => `${item.check ? 'check' : 'reply'}:${item.tools.join(',')}`));
  record('FC-02 off mode, base agent: every request of the user session (each run\'s reply and its finish check) has '
    + 'the finish tool', all.length === 4 && all.every((item) => item.tools.includes(FINISH_TOOL)), tools);
  record('FC-03 off mode, base agent: the first and the second run both send finish (reply and check requests), and '
    + 'the second run writes no tool patch (one system message in the session file after each run)',
  same(checkFlags(r1.reqs), [false, true]) && same(checkFlags(r2.reqs), [false, true])
    && all.every((item) => item.tools.includes(FINISH_TOOL)) && n1 === 1 && n2 === 1, brief({ n1, n2, tools }));
}

/** @brief FC-05：请求的 tools 参数有 finish，身份段的 <tools>、<rules> 没有；检查请求的 system prompt 不变。 */
function promptSystem(r1) {
  const [reply, check] = r1.reqs;
  const lists = identityLists(reply?.system);
  const builtins = (reply?.tools ?? []).filter((name) => BUILTIN_TOOLS.includes(name));
  record('FC-05 the request\'s tools parameter has finish but the identity section does not list it: <tools> lists '
    + 'exactly the built-in tools sent (the MEM-01 comparison), <rules> do not mention finish, and the system prompt '
    + 'does not carry finish\'s description', Boolean(lists) && reply.tools.includes(FINISH_TOOL)
    && sameSet(lists.tools, builtins) && !lists.tools.includes(FINISH_TOOL)
    && lists.rules.every((rule) => !/\bfinish\b/i.test(rule)) && !reply.system.includes(FINISH_FIRST_LINE),
  brief({ listed: lists?.tools, rules: lists?.rules, builtins, tools: reply?.tools }));
  record('FC-05 the finish check request has the same system prompt as the reply request of its run',
    Boolean(check?.check) && check.system === reply.system, brief({ flags: checkFlags(r1.reqs) }));
}

/** @brief FC-10：检查那次请求的检查块、下一次请求里的原文、会话文件里的条目。 */
function promptBlock(ctx, who, r1, r2) {
  const check = r1.reqs[1];
  const want = expectedCheck(check?.system);
  ctx.s1.check = want;
  const last = check?.messages.at(-1);
  record('FC-10 off mode: the finish check request ends with one user message holding the check line, a blank line '
    + 'and the check block (<taste> and <review> as in the system prompt), and has no two user messages in a row',
  Boolean(check?.check) && same(want.kinds, ['taste', 'review']) && last?.role === 'user'
    && contentText(last.content) === want.text && !consecutiveUsers(check.messages),
  brief({ kinds: want.kinds, last: contentText(last?.content).slice(-400),
    roles: check?.messages.map((m) => m.role) }));
  const lines = (r2.reqs[0]?.messages ?? []).filter(isCheckLine).map((m) => contentText(m.content));
  record('FC-10 the next request (your next message) carries that check line as its plain text only, without the '
    + 'check block', lines.length === 1 && lines[0] === want.line, brief(lines));
  const entries = fileView(who.sessionFile).checks;
  record('FC-10 the session file stores each check line as a custom_message (mori.finish_check) with the plain text, '
    + 'display false and no details', entries.length === 2 && entries.every((entry) => entry.content === want.line
    && entry.display === false && entry.details === undefined),
  brief(entries.map((entry) => ({ display: entry.display, details: entry.details,
    head: String(entry.content).slice(0, 60) }))));
}

// ---------- 步骤 bare：没有 TASTE、REVIEW 条目 ----------

/** @brief 没有 TASTE、REVIEW 条目的项目：检查那一行没有第三行、没有检查块。FC-10。 */
async function bare(ctx) {
  const who = await open(ctx, ctx.bare);
  const r = await run(ctx, who, `plain question without entries ${tag('bare')}`);
  const check = r.reqs.find((item) => item.check);
  const line = checkLineOf([]);
  const entries = fileView(who.sessionFile).checks;
  record('FC-10 with no TASTE or REVIEW entries the check line has no third line ("Otherwise check …") and no check '
    + 'block, in the check request and in the session file', Boolean(check) && check.last === line
    && line.split('\n').length === 3 && sectionOf(check.system, 'taste') === null
    && sectionOf(check.system, 'review') === null && entries.length === 1 && entries[0].content === line,
  brief({ last: check?.last, entries: entries.length }));
}

// ---------- 步骤 snapshot：记忆页在会话打开后加的条目 ----------

/** @brief 记忆页加一条 TASTE：开着的会话的检查块不变（快照），新会话的有它。FC-10。 */
async function snapshot(ctx) {
  const who = ctx.s1;
  if (!who?.check) throw new Error('the prompt step did not run');
  await addEntryOnPage(ctx, who.tab, { scope: 'project', section: 'taste', abstract: E1 });
  const r = await run(ctx, who, `plain third question ${tag('s1')}`);
  const check = r.reqs.find((item) => item.check);
  record('FC-10 an entry added on the Memory page after the session opened is not in that session\'s check block: the '
    + 'block is the open-time snapshot, the same as in its first run', Boolean(check) && check.last === who.check.text
    && !check.last.includes(E1), brief(check?.last.slice(-400)));
  const fresh = await open(ctx);
  const f = await run(ctx, fresh, `plain question in a new session ${tag('fresh')}`);
  const latest = f.reqs.find((item) => item.check);
  record('FC-10 a session opened after the Memory page change has the new entry in its check block, written as in '
    + 'its system prompt', Boolean(latest) && latest.last.includes(`- ${E1}`)
    && latest.last === expectedCheck(latest.system).text, brief(latest?.last.slice(-400)));
}

// ---------- 步骤 roleTools：关闭模式下对话持有者是角色 ----------

/**
 * @brief chat.md 持有对话的关闭模式对话：两次运行都有 finish、没有补丁、finish 得到 Confirmed.。FC-02、FC-03。
 *        文件系统合并之后（finish-check.md §11，2026-10-27）角色没有 tools、碰文件的工具同基座，finish 由路径闸当职责工具放行。
 */
async function roleTools(ctx) {
  const who = await open(ctx, ctx.chat);
  const r1 = await run(ctx, who, `plain question for the chat role ${tag('role')}`);
  const n1 = fileView(who.sessionFile).systems.length;
  const r2 = await run(ctx, who, `plain second question for the chat role ${tag('role')}`);
  const view = fileView(who.sessionFile);
  const all = [...r1.reqs, ...r2.reqs];
  const tools = brief(all.map((item) => `${item.info.role}/${item.info.kind}:${item.tools.join(',')}`));
  record('FC-02 off mode with a dialog role: every request of the dialog holder (chat) has the finish tool',
    all.length === 4 && all.every((item) => item.info.role === 'chat' && item.tools.includes(FINISH_TOOL)), tools);
  record('FC-03 off mode, a role holds the dialog (chat.md): both runs send finish next to the default tools (read, '
    + 'bash), the second run writes no tool patch, and each finish call gets "Confirmed." (a duty tool of the path '
    + 'gate)', same(checkFlags(r1.reqs), [false, true])
    && same(checkFlags(r2.reqs), [false, true]) && all.every((item) => item.tools.includes('read')
    && item.tools.includes('bash')) && view.systems.length === n1 && view.results.length === 2
    && view.results.every((result) => !result.isError && result.text === FINISH_RESULT),
  brief({ n1, n2: view.systems.length, results: view.results, tools }));
}

// ---------- 步骤 approval：免批准 ----------

/** @brief Ask each time 下检查后调 finish：tool_gate 为 free，没有批准请求、批准卡、Needs approval。FC-04。 */
async function approval(ctx) {
  const who = await open(ctx);
  const mode = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="permission-button"]`).textContent();
  const r = await run(ctx, who, `plain question in Ask each time ${tag('ask')}`);
  const gates = (await kernelEvents(ctx, who.sessionId, 'mori.tool_gate', r.since)).map((item) => item.data)
    .filter((data) => data.toolName === FINISH_TOOL);
  const asks = await kernelEvents(ctx, who.sessionId, 'mori.approval_request', r.since);
  const cards = (await fcSeen(ctx, 'cards', who.tab, r.since)).filter((item) => item.count > 0);
  const rows = (await fcSeen(ctx, 'rows', who.tab, r.since)).map((item) => item.status);
  record('FC-04 Ask each time: the finish call after the check is announced as free (mori.tool_gate free), with no '
    + 'mori.approval_request, no approval card and no "Needs approval" in the sidebar',
  Boolean(mode?.includes('Ask each time')) && r.reqs.some((item) => item.check) && gates.length >= 1
    && gates.every((data) => data.gate === 'free') && asks.length === 0 && cards.length === 0
    && !rows.includes('approval'), brief({ mode, gates, asks: asks.length, cards, rows }));
}

// ---------- 步骤 confirm：a，确认（fc-a，会话在后台） ----------

/**
 * @brief fc-a：发出后切到另一个会话（这个会话不在前台），等它结束再切回来。FC-11 的请求数、会话文件、日志、
 *        阶段行、回复操作行、Unread，FC-23 的实时界面。
 */
async function confirm(ctx) {
  const other = await open(ctx);
  const who = await open(ctx);
  ctx.fcA = who;
  const since = Date.now();
  await sendMessage(ctx, who.tab, `fc-scenario:fc-a ${tag('a')} Please answer.`);
  await showTab(ctx, other.tab);
  Object.assign(who, await userSession(ctx, who.tab));
  await settle(ctx, who);
  const r = await runView(ctx, who, since);
  const rows = await fcSeen(ctx, 'rows', who.tab, since);
  await showTab(ctx, who.tab);
  confirmRun(who, r);
  await confirmPane(ctx, who, r);
  await confirmTiming(ctx, who, r, rows);
}

/** @brief FC-11：恰好两个请求、一个 agent_settled；会话文件多出的三样；收尾检查日志。 */
function confirmRun(who, r) {
  const view = fileView(who.sessionFile);
  const checks = r.lines.filter((line) => line.check);
  record('FC-11 fc-a: the run sends exactly two requests, the second is the finish check (log check: true, checks 1), '
    + 'and has one agent_settled', same(checkFlags(r.reqs), [false, true]) && checks.length === 1
    && checks[0].checks === 1 && r.settled.length === 1,
  brief({ flags: checkFlags(r.reqs), lines: lineBrief(r.lines), settled: r.settled.length }));
  record('FC-11 fc-a: the session file has one custom_message (mori.finish_check), one assistant message with only the '
    + 'finish call, and its result "Confirmed."', view.checks.length === 1 && view.finishOnly.length === 1
    && view.results.length === 1 && !view.results[0].isError && view.results[0].text === FINISH_RESULT,
  brief({ checks: view.checks.length, finishOnly: view.finishOnly.length, results: view.results }));
  record('FC-11 fc-a: the kernel logs "finish check 1 (first)" and then "finish check passed (confirmed)"',
    same(r.logs, ['finish check 1 (first)', 'finish check passed (confirmed)']), brief(r.logs));
}

/** @brief FC-11、FC-23：对话流与没有检查时相同，界面上没有 finish。 */
async function confirmPane(ctx, who, r) {
  const items = await itemsOf(ctx, who.tab);
  const reply = assistantItems(items)[0];
  record('FC-11 fc-a: the transcript is as without a check: your message and one reply "Done." with the reply actions, '
    + 'no tool card, and no empty [data-item] after agent_settled', same(items.map((item) => item.kind),
    ['user', 'assistant']) && reply?.prose === 'Done.' && reply.tools.length === 0 && reply.actions
    && items.every((item) => !item.empty), brief(itemBrief(items)));
  const cards = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="tool-card"]`).count();
  const text = items.map((item) => item.text).join('\n');
  record('FC-23 live: the finish call and its result are drawn nowhere (no tool card, no "Confirmed.", no "finish")',
    r.settled.length === 1 && cards === 0 && !text.includes(FINISH_RESULT) && !/\bfinish\b/i.test(text),
  brief({ cards, text: text.slice(0, 300) }));
}

/** @brief FC-11：阶段行（两次请求之间等模型、从不显示 finish）、回复操作行与 Unread 都在 agent_settled 之后。 */
async function confirmTiming(ctx, who, r, rows) {
  const stages = await stagesOf(ctx.page, who.tab, r.since);
  const ends = (await kernelEvents(ctx, who.sessionId, 'message_end', r.since)).filter((e) => e.role === 'assistant');
  const [t1, t2] = [ends[0]?.t ?? Infinity, ends[1]?.t ?? -Infinity];
  const waiting = stages.filter((item) => item.t > t1 && item.t < t2 && item.v.includes('Waiting for the model'));
  record('FC-11 fc-a: between the reply and the finish call the stage line shows "Waiting for the model…", and it '
    + 'never shows finish', ends.length === 2 && waiting.length > 0 && stages.every((item) => !/finish/i.test(item.v)),
  brief({ stages: stages.map((item) => item.v), ends: ends.map((item) => item.text) }));
  const settledAt = r.settled[0]?.t ?? Infinity;
  const shown = (await fcSeen(ctx, 'actions', who.tab, r.since)).find((item) => item.count > 0);
  record('FC-11 fc-a: the reply actions appear only after agent_settled (none while the check runs)',
    Boolean(shown) && shown.t >= settledAt, brief({ shown, settledAt }));
  const unseen = rows.filter((item) => item.status === 'unseen');
  record('FC-11 fc-a: with the session in the background the sidebar marks it Unread once, at agent_settled (Running '
    + 'before, also between the reply and the check)', unseen.length === 1 && unseen[0].t >= settledAt
    && rows.filter((item) => item.t < settledAt).every((item) => item.status === 'running' || item.status === null),
  brief({ rows, settledAt }));
}

// ---------- 步骤 confirmText、early、think：a 的另外三种 ----------

/** @brief fc-a-text：确认时写的那句话是回复的最后一段，操作行挂在它上面，Copy 带着它。FC-11。 */
async function confirmText(ctx) {
  const who = await open(ctx);
  const r = await run(ctx, who, `fc-scenario:fc-a-text ${tag('a-text')} Please answer.`);
  const replies = assistantItems(await itemsOf(ctx, who.tab));
  const copied = await copyLatest(ctx, who.tab);
  record('FC-11 fc-a-text: the sentence written with finish is shown as the last part of the reply ("Done." then "The '
    + 'reply stands."), the reply actions hang on it, Copy carries it, and the check passes as confirmed',
  same(checkFlags(r.reqs), [false, true]) && same(replies.map((item) => item.prose), ['Done.', 'The reply stands.'])
    && replies[1].actions && !replies[0].actions && copied.includes('Done.') && copied.includes('The reply stands.')
    && same(r.logs, ['finish check 1 (first)', 'finish check passed (confirmed)']),
  brief({ replies: itemBrief(replies), copied, logs: r.logs }));
}

/** @brief fc-early：检查之前调的 finish 不算确认，照样检查一次；两个 finish 都不画。FC-11、FC-23。 */
async function early(ctx) {
  const who = await open(ctx);
  const r = await run(ctx, who, `fc-scenario:fc-early ${tag('early')} Please answer.`);
  const view = fileView(who.sessionFile);
  const items = await itemsOf(ctx, who.tab);
  record('FC-11 fc-early: a finish called with the reply, before any check, is not a confirmation: the run still sends '
    + 'one finish check (logs "finish check 1 (first)"), which passes as confirmed',
  same(checkFlags(r.reqs), [false, true]) && same(r.logs, ['finish check 1 (first)', 'finish check passed (confirmed)'])
    && view.checks.length === 1 && view.results.length === 2
    && view.results.every((result) => !result.isError && result.text === FINISH_RESULT),
  brief({ flags: checkFlags(r.reqs), logs: r.logs, results: view.results }));
  record('FC-23 fc-early: neither finish call is drawn: one reply "Done." with the reply actions, no tool card, no '
    + 'empty item', same(items.map((item) => item.kind), ['user', 'assistant'])
    && assistantItems(items)[0]?.prose === 'Done.' && assistantItems(items)[0].actions
    && items.every((item) => !item.empty && item.tools.length === 0), brief(itemBrief(items)));
}

/** @brief fc-a-think：开着思考时只多一块收起的 Thought process，操作行在回复正文那一项。FC-23。 */
async function think(ctx) {
  const who = await open(ctx);
  const r = await run(ctx, who, `fc-scenario:fc-a-think ${tag('a-think')} Please answer.`);
  const items = await itemsOf(ctx, who.tab);
  const [reply, check] = assistantItems(items);
  const collapsed = (item) => same(item?.thinking.map((block) => [block.open, block.summary]),
    [[false, 'Thought process']]);
  record('FC-23 fc-a-think: with thinking the check adds only one collapsed "Thought process" (an item with no text '
    + 'and no tool card); the reply actions stay on the reply text "Done."', same(checkFlags(r.reqs), [false, true])
    && assistantItems(items).length === 2 && reply.prose === 'Done.' && reply.actions && collapsed(reply)
    && check.prose === '' && check.tools.length === 0 && !check.actions && collapsed(check)
    && items.every((item) => !item.empty), brief({ items: itemBrief(items), reply, check }));
}

// ---------- 步骤 work、mixed：b，检查之后接着干活 ----------

/** @brief fc-b：两次检查，bash 的卡在第一段回复之后，最终回复 The tests passed.。FC-12。 */
async function work(ctx) {
  const who = await open(ctx);
  await allowAll(ctx, who.tab);
  const r = await run(ctx, who, `fc-scenario:fc-b ${tag('b')} Please run the tests.`);
  const items = await itemsOf(ctx, who.tab);
  const first = items.findIndex((item) => item.prose === "I'll run the tests.");
  const card = items.findIndex((item) => item.tools.some((title) => title.includes('echo fc-b')));
  const last = assistantItems(items).at(-1);
  const checks = r.lines.filter((line) => line.check).map((line) => line.checks);
  record('FC-12 fc-b: two finish checks (log checks 1 and 2): the first finds the work not done, bash runs, the second '
    + 'passes as confirmed', same(checkFlags(r.reqs), [false, true, false, true]) && same(checks, [1, 2])
    && same(r.logs, ['finish check 1 (first)', 'finish check 2 (work)', 'finish check passed (confirmed)']),
  brief({ flags: checkFlags(r.reqs), lines: lineBrief(r.lines), logs: r.logs }));
  record('FC-12 fc-b: the first reply stays in place, the bash card follows it as usual, and the final reply is "The '
    + 'tests passed." with the reply actions', first >= 0 && card > first && last?.prose === 'The tests passed.'
    && last.actions && items.flatMap((item) => item.tools).length === 1 && items.every((item) => !item.empty),
  brief(itemBrief(items)));
}

/** @brief fc-mixed：同一批里的 finish 不算确认，再检查一次。FC-12。 */
async function mixed(ctx) {
  const who = await open(ctx);
  await allowAll(ctx, who.tab);
  const r = await run(ctx, who, `fc-scenario:fc-mixed ${tag('mixed')} Please answer.`);
  const items = await itemsOf(ctx, who.tab);
  const tools = items.flatMap((item) => item.tools);
  const checks = r.lines.filter((line) => line.check).map((line) => line.checks);
  record('FC-12 fc-mixed: a finish in the same batch as bash is not a confirmation: a second check follows (log '
    + '"finish check 2 (work)"), only the bash card is drawn, and the final reply is "Done again."',
  same(checkFlags(r.reqs), [false, true, false, true]) && same(checks, [1, 2])
    && addedChecks(r.logs).includes('finish check 2 (work)') && tools.length === 1 && tools[0].includes('echo fc-mixed')
    && assistantItems(items).at(-1)?.prose === 'Done again.',
  brief({ flags: checkFlags(r.reqs), logs: r.logs, items: itemBrief(items) }));
}

// ---------- 步骤 rewrite、badArgs：c，重写 ----------

/** @brief fc-c：一次检查，两段都显示，Copy 与 Attach message as context 两段都在，不再检查。FC-13。 */
async function rewrite(ctx) {
  const who = await open(ctx);
  const r = await run(ctx, who, `fc-scenario:fc-c ${tag('c')} Please answer.`);
  const replies = assistantItems(await itemsOf(ctx, who.tab));
  const view = fileView(who.sessionFile);
  record('FC-13 fc-c: one check and no second one (logs "finish check passed (no work)"); the draft and the rewritten '
    + 'reply are both shown', same(checkFlags(r.reqs), [false, true]) && view.checks.length === 1
    && same(r.logs, ['finish check 1 (first)', 'finish check passed (no work)'])
    && same(replies.map((item) => item.prose), ['Draft answer.', 'Conclusion first: rewritten answer.']),
  brief({ flags: checkFlags(r.reqs), logs: r.logs, replies: itemBrief(replies) }));
  const copied = await copyLatest(ctx, who.tab);
  const attached = await attachLatest(ctx, who.tab);
  const both = (text) => text.includes('Draft answer.') && text.includes('Conclusion first: rewritten answer.');
  record('FC-13 fc-c: Copy and "Attach message as context" carry both parts of the reply', both(copied)
    && both(attached), brief({ copied, attached }));
}

/** @brief fc-bad-args：finish 的校验错误不显示卡，Final reply. 是最终回复，不再检查。FC-13。 */
async function badArgs(ctx) {
  const who = await open(ctx);
  const r = await run(ctx, who, `fc-scenario:fc-bad-args ${tag('bad-args')} Please answer.`);
  const items = await itemsOf(ctx, who.tab);
  const view = fileView(who.sessionFile);
  const text = items.map((item) => item.text).join('\n');
  record('FC-13 fc-bad-args: the finish call with arguments fails validation (pi\'s "Validation failed for tool '
    + '"finish"" result) and no card or error shows it; "Final reply." is the final reply and there is no second check',
  same(checkFlags(r.reqs), [false, true, false]) && same(r.logs, ['finish check 1 (first)',
    'finish check passed (no work)']) && view.results.length === 1 && view.results[0].isError
    && view.results[0].text.startsWith(FINISH_INVALID) && items.every((item) => item.tools.length === 0 && !item.error)
    && !text.includes('Validation failed') && assistantItems(items).at(-1)?.prose === 'Final reply.',
  brief({ flags: checkFlags(r.reqs), logs: r.logs, results: view.results, items: itemBrief(items) }));
}

// ---------- 步骤 cap：上限 ----------

/** @brief fc-cap：恰好 3 次检查，第 4 个边界放行，运行结束。FC-14。 */
async function cap(ctx) {
  const who = await open(ctx);
  await allowAll(ctx, who.tab);
  const r = await run(ctx, who, `fc-scenario:fc-cap ${tag('cap')} Please keep working.`, { timeout: 180000 });
  const checks = r.reqs.filter((item) => item.check).map((item) => item.checks);
  const cards = (await itemsOf(ctx, who.tab)).flatMap((item) => item.tools);
  record('FC-14 fc-cap: exactly three finish checks (checks 1, 2, 3), the fourth boundary passes (log "finish check '
    + 'passed (limit)"), and the run ends with one agent_settled', r.reqs.length === 7 && same(checks, [1, 2, 3])
    && same(r.logs, ['finish check 1 (first)', 'finish check 2 (work)', 'finish check 3 (work)',
      'finish check passed (limit)']) && r.settled.length === 1 && cards.length === 3,
  brief({ flags: checkFlags(r.reqs), logs: r.logs, settled: r.settled.length, cards }));
}

// ---------- 步骤 queue、steer：排队与插话 ----------

/**
 * @brief fc-slow 的检查等待中再发一条（Enter 排队，Ctrl+Enter 插话），等整个运行结束。
 * @return { who, text（发的那一条）, r（runView） }
 */
async function sendDuringCheck(ctx, name, key) {
  const who = await open(ctx);
  const since = await start(ctx, who, `fc-scenario:fc-slow ${tag(name)} Please answer.`);
  await waitCheckRequest(ctx, since);
  const text = `plain ${name} message sent while the check waits ${tag(name)}`;
  await sendMessage(ctx, who.tab, text, { key });
  await settle(ctx, who, 90000);
  return { who, text, r: await runView(ctx, who, since) };
}

/** @brief FC-15：检查那次请求的 finish 之后 pi 接着回答这条消息，之后的检查从 0 数，只有一个 agent_settled。 */
function duringCheck(label, { text, r }) {
  const checks = r.lines.filter((line) => line.check).map((line) => line.checks);
  const added = addedChecks(r.logs);
  record(`FC-15 ${label} during the fc-slow check: after the check's finish pi answers it in the same run (one `
    + 'agent_settled), and the next check counts from 0 again (log checks 1 and 1, "finish check 1 (first)" twice)',
  same(checkFlags(r.reqs), [false, true, false, true]) && r.reqs[2].last.includes(text)
    && userTexts(r.reqs[2].messages).at(-1)?.includes(text) && same(checks, [1, 1])
    && same(added, ['finish check 1 (first)', 'finish check 1 (first)']) && r.settled.length === 1,
  brief({ flags: checkFlags(r.reqs), lines: lineBrief(r.lines), logs: r.logs, settled: r.settled.length }));
}

/** @brief 检查等待中排队一条消息（Enter）。FC-15。 */
async function queue(ctx) {
  duringCheck('a queued message (Enter)', await sendDuringCheck(ctx, 'queue', 'Enter'));
}

/** @brief 检查等待中插话（Ctrl+Enter）。FC-15。 */
async function steer(ctx) {
  duringCheck('a steering message (Ctrl+Enter)', await sendDuringCheck(ctx, 'steer', 'Control+Enter'));
}

// ---------- 步骤 stop：检查时停止 ----------

/** @brief fc-slow 的检查等待中按停止：回复完整、Stopped、6 秒内没有请求、检查那一行留在会话里。FC-16。 */
async function stop(ctx) {
  const who = await open(ctx);
  ctx.stopWho = who;
  const since = await start(ctx, who, `fc-scenario:fc-slow ${tag('stop')} Please answer.`);
  await waitCheckRequest(ctx, since);
  await ctx.page.locator(`${paneSel(who.tab)} .stop-button`).click();
  const stopAt = Date.now();
  await settle(ctx, who, 30000);
  await sleep(Math.max(0, stopAt + 6000 - Date.now()));
  const after = ctx.ep.proxy.captures.filter((item) => item.chat && item.t >= stopAt + 300);
  const logged = linesIn(ctx.ep, stopAt + 300);
  const pane = await paneState(ctx.page, who.tab);
  const items = await itemsOf(ctx, who.tab);
  record('FC-16 stop during the fc-slow check: the reply stays complete with "Stopped · Changes made so far stay as '
    + 'they are" under it and no error card', assistantItems(items)[0]?.prose === 'Done.' && pane.stopped === 1
    && pane.errors.length === 0 && items.at(-1)?.text.includes(STOPPED_TEXT), brief(itemBrief(items)));
  record('FC-16 after the stop no request reaches the endpoint for 6 s before the next message, not even a check '
    + 'request (proxy captures and log lines, check: true included)', after.length === 0 && logged.length === 0,
  brief({ after: after.length, logged: lineBrief(logged) }));
  record('FC-16 the session file keeps the check line after the stop', fileView(who.sessionFile).checks.length === 1,
    brief(fileView(who.sessionFile).checks.length));
  await stopNext(ctx, who);
}

/** @brief FC-16：停止之后的下一条消息：旧检查那一行没有检查块、紧跟着你的新消息；这次运行照常检查一次。 */
async function stopNext(ctx, who) {
  const text = `plain after the stop ${tag('stop')}`;
  const r = await run(ctx, who, text);
  const messages = r.reqs[0]?.messages ?? [];
  const at = messages.findLastIndex(isCheckLine);
  const line = expectedCheck(r.reqs[0]?.system).line;
  record('FC-16 the next message: in its request the old check line is plain text (no check block) and is followed '
    + 'directly by your new message; this run is checked once as usual', at >= 0
    && contentText(messages[at].content) === line && messages[at + 1]?.role === 'user'
    && contentText(messages[at + 1].content).includes(text) && r.reqs.filter((item) => item.check).length === 1
    && same(addedChecks(r.logs), ['finish check 1 (first)']),
  brief({ roles: messages.map((m) => m.role), at, flags: checkFlags(r.reqs), logs: r.logs }));
}

// ---------- 步骤 fail、failFirst、unavailable：检查那次请求出错 ----------

/** @brief fc-fail：错误卡显示原文、没有放回链接，侧栏 Error，回复完整。FC-17。 */
async function fail(ctx) {
  const who = await open(ctx);
  ctx.failWho = who;
  const r = await run(ctx, who, `fc-scenario:fc-fail ${tag('fail')} Please answer.`);
  const items = await itemsOf(ctx, who.tab);
  const errors = items.filter((item) => item.error);
  const status = await rowStatus(ctx, who.tab);
  record('FC-17 fc-fail: the check request fails (HTTP 400); the reply stays complete, the error card shows the text '
    + 'without "Put your last message back in the message box", and the sidebar shows Error',
  same(checkFlags(r.reqs), [false, true]) && assistantItems(items)[0]?.prose === 'Done.' && errors.length === 1
    && errors[0].error.text.includes('Synthetic HTTP 400') && !errors[0].error.putBack && status === 'error',
  brief({ items: itemBrief(items), errors: errors.map((item) => item.error), status }));
}

/** @brief fc-fail-first：第一个请求就出错时错误卡仍有放回链接（也不检查）。FC-17。 */
async function failFirst(ctx) {
  const who = await open(ctx);
  const r = await run(ctx, who, `fc-scenario:fc-fail-first ${tag('fail-first')} Please answer.`);
  const errors = (await itemsOf(ctx, who.tab)).filter((item) => item.error);
  record('FC-17 fc-fail-first: when the first request of the run fails the error card still has "Put your last '
    + 'message back in the message box", and no finish check is sent', r.reqs.length >= 1
    && r.reqs.every((item) => !item.check) && errors.length === 1 && errors[0].error.putBack
    && addedChecks(r.logs).length === 0,
  brief({ flags: checkFlags(r.reqs), errors: errors.map((item) => item.error) }));
}

/** @brief fc-404（范围里只有这一个模型）：只有 No model available 卡、没有错误卡。FC-17。 */
async function unavailable(ctx) {
  const who = await open(ctx);
  await choosePick(ctx, who.tab, `p404/${MODEL_404}`);
  const r = await run(ctx, who, `fc-scenario:fc-404 ${tag('404')} Please answer.`);
  const pane = await paneState(ctx.page, who.tab);
  const items = await itemsOf(ctx, who.tab);
  record('FC-17 fc-404 with one model in the scope: the check request gets 404, the reply stays complete and only the '
    + '"No model available" card shows, with no error card', r.lines.some((line) => line.check && line.status === 404)
    && assistantItems(items)[0]?.prose === 'Done.' && pane.unavailable.length === 1 && pane.errors.length === 0,
  brief({ lines: lineBrief(r.lines), unavailable: pane.unavailable.map((card) => card.text), errors: pane.errors }));
}

// ---------- 步骤 switch*：换模型（FC-21） ----------

/** @brief 记录代理的规则：拒绝检查那次请求（连接被拒）。 */
const refuseCheck = () => ({ body }) => (checkPlan(body).check ? { refuse: true } : null);

/** @brief 记录代理的规则：拒绝这个模型的第 n 个不是检查的请求（自己数，与代理的 index 怎么数无关）。 */
function refuseNth(n) {
  let seen = 0;
  return ({ body }) => {
    if (checkPlan(body).check) return null;
    seen += 1;
    return seen === n ? { refuse: true } : null;
  };
}

/**
 * @brief 换模型的一种情况：新会话选好分组（首选 + 备用），装上首选模型的拒绝规则，发一条消息，读这次运行。
 * @param c { group, model（首选模型 id）, text, rule, allow（先切到 Allow all） }
 * @return { r, refused（被拒的请求）, backup（备用模型收到的请求）, events（mori.model_switch）, pane }
 */
async function switchRun(ctx, c) {
  const who = await open(ctx);
  await choosePick(ctx, who.tab, c.group);
  if (c.allow) await allowAll(ctx, who.tab);
  ctx.rules[c.model] = c.rule;
  const r = await run(ctx, who, c.text);
  const refused = ctx.ep.proxy.captures.filter((item) => item.chat && item.refused && item.t >= r.since);
  const backup = r.reqs.filter((item) => item.body.model === SWITCH.backup);
  const events = (await kernelEvents(ctx, who.sessionId, 'mori.model_switch', r.since)).map((item) => item.data);
  return { r, refused, backup, events, pane: await paneState(ctx.page, who.tab) };
}

/** @brief FC-21：跟在没有工具调用的回复之后的检查那次请求换模型：不隐藏、没有重做说明。 */
function afterReplyChecks(label, out) {
  const first = out.backup[0];
  const texts = (first?.messages ?? []).map((m) => contentText(m.content));
  record(`FC-21 ${label}: the new model's request has the reply and the check line with its check block, and no `
    + 'redo note', out.refused.length === 1 && checkPlan(out.refused[0].body).check && Boolean(first?.check)
    && texts.includes('Done.') && first.last.startsWith(CHECK_LINE_HEAD) && first.last.includes('\n\n<taste>\n')
    && texts.every((text) => !text.includes(NOTE_HEAD)),
  brief({ refused: out.refused.length, roles: first?.messages.map((m) => m.role), last: first?.last.slice(-200) }));
  record(`FC-21 ${label}: mori.model_switch has hidden false and the transcript shows no hidden-work notice`,
    out.events.length === 1 && out.events[0].hidden === false && out.pane.switches.length === 1
    && !out.pane.switches[0].hidden && !out.pane.switches[0].text.includes(REDO_TEXT),
  brief({ events: out.events, switches: out.pane.switches }));
}

/** @brief FC-21：工具结果之后的请求换模型：照旧隐藏（hidden 为真，提示新模型重做）。 */
function hiddenSwitch(label, out) {
  record(`FC-21 ${label}: the switch still hides the work (mori.model_switch hidden true, the notice says the new `
    + 'model redoes the response)', out.refused.length === 1 && out.events.length === 1 && out.events[0].hidden === true
    && out.pane.switches[0]?.hidden === true && out.pane.switches[0].text.includes(REDO_TEXT),
  brief({ refused: out.refused.length, events: out.events, switches: out.pane.switches }));
}

/** @brief 记录代理拒绝 fc-a 的检查那次请求，换到备用模型。FC-21。 */
async function switchReply(ctx) {
  afterReplyChecks('a refused finish check after a text reply (fc-a)', await switchRun(ctx, { group: 'g21a',
    model: SWITCH.a, text: `fc-scenario:fc-a ${tag('21a')} Please answer.`, rule: refuseCheck() }));
}

/** @brief fc-early 的检查那次请求被拒，换到备用模型。FC-21。 */
async function switchEarly(ctx) {
  afterReplyChecks('a refused finish check after a reply with its own finish (fc-early)', await switchRun(ctx,
    { group: 'g21e', model: SWITCH.early, text: `fc-scenario:fc-early ${tag('21e')} Please answer.`,
      rule: refuseCheck() }));
}

/** @brief fc-b 检查之后干了活，之后的请求被拒：新模型的请求里没有检查那一行，重做说明在 anchor 上。FC-21。 */
async function switchWork(ctx) {
  const anchor = `fc-scenario:fc-b ${tag('21w')} Please run the tests.`;
  const out = await switchRun(ctx, { group: 'g21w', model: SWITCH.work, text: anchor, rule: refuseNth(2),
    allow: true });
  const first = out.backup[0];
  const users = userTexts(first?.messages ?? []);
  const notes = (first?.messages ?? []).filter((m) => contentText(m.content).includes(NOTE_HEAD));
  record('FC-21 a switch after fc-b\'s work (the request after bash is refused): the new model\'s request has no check '
    + 'line and one redo note, on the anchor (your message)', Boolean(first)
    && !first.messages.some(isCheckLine) && notes.length === 1 && users[0]?.includes(anchor)
    && users[0].includes(NOTE_HEAD), brief({ roles: first?.messages.map((m) => m.role), users }));
  hiddenSwitch('a switch after fc-b\'s work', out);
}

/** @brief 平常换模型（工具结果之后，关键词模式读 README）：仍隐藏。FC-21。 */
async function switchPlain(ctx) {
  hiddenSwitch('an ordinary switch after a tool result', await switchRun(ctx, { group: 'g21n', model: SWITCH.plain,
    text: `Read the README for me ${tag('21n')}`, rule: refuseNth(2) }));
}

// ---------- 步骤 replay：换到推理必须回传的模型 ----------

/** @brief 只聊过天、检查过一次的会话换到 pb/fake-coder-replay：有重建说明，没有 400，有回复。FC-29。 */
async function replay(ctx) {
  const who = await open(ctx);
  const before = await run(ctx, who, `plain chat before the switch ${tag('replay')}`);
  await choosePick(ctx, who.tab, `pb/${REPLAY_MODEL}`);
  const r = await run(ctx, who, `plain after switching to the replay model ${tag('replay')}`);
  const pane = await paneState(ctx.page, who.tab);
  const replies = assistantItems(await itemsOf(ctx, who.tab)).filter((item) => item.prose);
  record('FC-29 a chat-only session checked once, switched to pb/fake-coder-replay (reasoning.replay required): the '
    + 'finish call counts as a foreign tool call, so a rebuild notice shows; no HTTP 400 and a reply',
  same(checkFlags(before.reqs), [false, true]) && pane.rebuilds.some((text) => text.startsWith(
    `Rebuilt the conversation for pb/${REPLAY_MODEL}`)) && r.lines.some((line) => line.model === REPLAY_MODEL)
    && r.lines.every((line) => line.status !== 400) && replies.length === 2 && pane.errors.length === 0,
  brief({ rebuilds: pane.rebuilds, lines: lineBrief(r.lines), replies: itemBrief(replies), errors: pane.errors }));
}

// ---------- 步骤 refs：会话引用 ----------

/** @brief 预览对话框里每一轮的内容。 */
const previewTurns = (ctx) => ctx.page.locator('[data-testid="ref-preview"] [data-testid="ref-turn"] pre')
  .allTextContents();

/** @brief 引用检查过的会话（prompt 的会话）：预览与发给模型的引用都没有 finish、检查那一行。FC-23。 */
async function refs(ctx) {
  const source = ctx.s1;
  if (!source?.sessionFile) throw new Error('the prompt step did not run');
  const who = await open(ctx);
  const menu = await openMenuOn(ctx.page, rowOf(ctx.page, source.sessionFile).first());
  await menu.getByRole('menuitem', { name: /^Attach as context/ }).click();
  const chip = ctx.page.locator(`${paneSel(who.tab)} [data-testid="quote-chip"][data-kind="session"]`
    + ':not([data-pending])').first();
  await chip.waitFor({ timeout: 15000 });
  await chip.locator('.quote-chip-main').click();
  await waitPreview(ctx.page);
  const turns = await previewTurns(ctx);
  await ctx.page.getByTestId('ref-preview').getByRole('button', { name: 'Done' }).click();
  const r = await run(ctx, who, `plain quoting a session ${tag('refs')}`);
  const sent = r.reqs[0]?.last ?? '';
  const clean = (text) => !/\bfinish\b/i.test(text) && !text.includes(CHECK_LINE_HEAD) && !text.includes(FINISH_RESULT);
  record('FC-23 session reference: the preview of a checked session has no finish [Tool] line, no check line and no '
    + '"Confirmed."', turns.length >= 2 && turns.join('\n').includes('User: plain first question')
    && turns.every(clean), brief(turns));
  record('FC-23 session reference: the quote sent to the model has no finish line and no check line',
    sent.includes('User: plain first question') && clean(sent), brief(sent.slice(0, 800)));
}

// ---------- 步骤 toolsPage：Customize 页 ----------

/** @brief Customize → Built-in tools：finish · Mori · Enabled · 说明的第一行；memory 一行不变。FC-24。 */
async function toolsPage(ctx) {
  const who = ctx.s1;
  if (!who?.sessionFile) throw new Error('the prompt step did not run');
  await showTab(ctx, who.tab);
  await openToolsSection(ctx.page, 'builtin');
  const rows = await toolRows(ctx.page);
  await ctx.page.locator('[data-testid="tools-page"] .topbar button', { hasText: 'Back to app' }).click();
  await ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(who.tab)}`).waitFor({ timeout: 10000 });
  const row = rows.find((item) => item.name === FINISH_TOOL);
  const memory = rows.find((item) => item.name === 'memory');
  record(`FC-24 Customize → Built-in tools has the row finish · Mori · Enabled · "${FINISH_FIRST_LINE}"`,
    row?.tag === 'Mori' && row.state === 'Enabled' && row.active === 'true' && row.desc === FINISH_FIRST_LINE,
    brief(rows.map((item) => `${item.name}|${item.tag}|${item.state}|${item.desc}`)));
  record('FC-24 the memory row is unchanged: memory · Mori · Enabled with its own description',
    memory?.tag === 'Mori' && memory.state === 'Enabled' && memory.active === 'true' && memory.desc.length > 0
    && memory.desc !== FINISH_FIRST_LINE, brief(memory));
}

// ---------- 步骤 attach：界面重新载入后接上正在检查的会话 ----------

/** @brief fc-slow 的检查等待中重新载入界面、接上这个会话：结束后只有一项回复，没有 finish。FC-23。 */
async function attach(ctx) {
  const who = await open(ctx);
  const since = await start(ctx, who, `fc-scenario:fc-slow ${tag('attach')} Please answer.`);
  await waitCheckRequest(ctx, since);
  await reloadUi(ctx);
  who.tab = await reopenSession(ctx, who.sessionFile);
  const during = await itemsOf(ctx, who.tab);
  await settle(ctx, who, 60000);
  const items = await itemsOf(ctx, who.tab);
  const r = await runView(ctx, who, since);
  record('FC-23 the window reloaded while the check runs, then attached to the live session: the reply shows, and '
    + 'after the finish call the transcript has one reply "Done." with the reply actions, no tool card and no empty '
    + 'item', same(checkFlags(r.reqs), [false, true]) && assistantItems(during)[0]?.prose === 'Done.'
    && same(items.map((item) => item.kind), ['user', 'assistant']) && assistantItems(items)[0]?.prose === 'Done.'
    && assistantItems(items)[0].actions && items.every((item) => !item.empty && item.tools.length === 0),
  brief({ during: itemBrief(during), items: itemBrief(items) }));
}

// ---------- 步骤 enhance：增强任务的看不见的会话 ----------

/** 增强的三个任务 */
const ENHANCE_TASKS = ['taste', 'strategy', 'review'];

/** @brief 一次增强运行（现在运行）的三个任务都有了结果。 */
const enhanceDone = (info) => info && !info.running && info.queued === 0
  && ENHANCE_TASKS.every((task) => info.last?.[task]);

/** @brief 增强会话文件是哪个任务的：第一条 user 消息以附录 B 的第一句 "…daily <KIND> " 开头；认不出时为 null。 */
function enhanceTaskOf(entries) {
  const first = entries.find((entry) => entry.type === 'message' && entry.message?.role === 'user');
  const text = contentText(first?.message.content);
  return ENHANCE_TASKS.find((task) => text.startsWith(`${ENHANCE_FIRST}${task.toUpperCase()} `)) ?? null;
}

/**
 * @brief FC-25（关闭模式的增强）：since 起没有 check: true 的日志行；增强会话（看不见的会话，每个任务一个）的文件里
 *        没有 mori.finish_check 条目与 finish 调用；有修订的每个任务，修订完成，Notes 照旧是那个任务的增强会话的
 *        最后一条回复（增强脚本 ENHANCE_SCRIPT 的那一句）。
 * @param info enhance.get 的结果（三个任务都有了结果）
 */
async function enhanceClean(ctx, since, info) {
  const lines = linesIn(ctx.ep, since);
  const files = headlessSessions(ctx.userData, ctx.enh).map((item) => ({ task: enhanceTaskOf(item.entries),
    checks: checkEntries(item.entries).length, finish: finishCalls(item.entries),
    reply: replyTexts(item.entries).at(-1) ?? null }));
  record('FC-25 off-mode enhancement: there is no check request — no check: true log line — and no enhancement '
    + 'session file has a mori.finish_check entry or a finish call', lines.length > 0
    && lines.every((line) => !line.check) && files.length > 0
    && files.every((item) => item.checks === 0 && item.finish === 0), brief({ lines: lineBrief(lines), files }));
  const notes = [];
  for (const task of ENHANCE_TASKS) {
    const id = info?.last?.[task]?.revision ?? null;
    if (id === null) continue;
    const revision = (await bridge(ctx, { type: 'memory.revisions', cwd: ctx.enh, layer: 'project', id }))
      ?.revision ?? null;
    notes.push({ task, status: revision?.status ?? null, notes: revision?.notes ?? null,
      reply: files.find((item) => item.task === task)?.reply ?? null, want: ENHANCE_SCRIPT[task].at(-1).say });
  }
  record('FC-25 off-mode enhancement: each run ends as before — every task\'s revision is done and its Notes are still '
    + 'the last reply of that task\'s enhancement session', notes.length > 0 && notes.every((item) => item.status
    === 'done' && item.reply === item.want && item.notes === item.reply), brief(notes));
}

/**
 * @brief 打开增强、现在运行：增强会话的请求里没有 finish、没有检查请求；同一项目的用户会话有（FC-02）。增强会话的
 *        文件没有检查那一行与 finish 调用，修订的 Notes 照旧（FC-25，enhanceClean）。
 */
async function enhance(ctx) {
  const who = await open(ctx, ctx.enh);
  const own = await run(ctx, who, `plain hello before the enhancement ${tag('enh')}`);
  const since = Date.now();
  const set = await bridge(ctx, { type: 'enhance.set', cwd: ctx.enh, enabled: true });
  const started = await bridge(ctx, { type: 'enhance.run', cwd: ctx.enh });
  const info = await poll(async () => {
    const now = await bridge(ctx, { type: 'enhance.get', cwd: ctx.enh });
    return enhanceDone(now) ? now : null;
  }, 180000, 500);
  const reqs = requestsIn(ctx.ep, since).filter((item) => item.messages.some((m) => m.role === 'user'
    && contentText(m.content).startsWith(ENHANCE_FIRST)));
  record('FC-02 off mode: the enhancement runs (TASTE, STRATEGY, REVIEW, run now) send no finish tool and no finish '
    + 'check request, while the user session of the same project has finish', !set?.error && !started?.error
    && Boolean(info) && reqs.length >= 3 && reqs.every((item) => !item.tools.includes(FINISH_TOOL) && !item.check)
    && own.reqs.length === 2 && own.reqs.every((item) => item.tools.includes(FINISH_TOOL)),
  brief({ set: set?.error, run: started?.error, last: info?.last,
    reqs: reqs.map((item) => `${item.check}:${item.tools.join(',')}`) }));
  await enhanceClean(ctx, since, info);
}

// ---------- 步骤 reopen：重启后打开会话、没有 finish 时存下的会话 ----------

/**
 * @brief 重新打开的对话流里没有工具卡，空的项只有一种：检查那次请求没有任何内容就结束（HTTP 400 出错、或在等待中
 *        停止），pi 照样存下内容为空的助手消息，载入时它是一项空的助手项（不是只有 finish 的消息），紧接着就是错误卡
 *        或 Stopped 那一行（history.ts addAssistant）。
 * @param items itemsOf 的结果
 * @param next 空的助手项之后紧挨着的那一项的 kind（'error' 或 'stopped'）
 */
const cleanUntil = (items, next) => Boolean(items) && items.every((item, index) => item.tools.length === 0
  && (!item.empty || (item.kind === 'assistant' && items[index + 1]?.kind === next)));

/** @brief FC-23：重启后打开 fc-a、fc-fail 与停止过的会话：不画 finish，Stopped 与错误卡照旧。 */
async function reopenedViews(ctx) {
  const views = {};
  for (const [name, who] of [['fcA', ctx.fcA], ['fail', ctx.failWho], ['stop', ctx.stopWho]]) {
    if (who?.sessionFile) views[name] = await itemsOf(ctx, await reopenSession(ctx, who.sessionFile));
  }
  const clean = (items) => Boolean(items) && items.every((item) => !item.empty && item.tools.length === 0);
  const a = views.fcA;
  record('FC-23 opening a session (fc-a) after a restart: no check line, no finish call or result; one reply "Done." '
    + 'with the reply actions and no empty item', clean(a) && same(a.map((item) => item.kind), ['user', 'assistant'])
    && assistantItems(a)[0].prose === 'Done.' && assistantItems(a)[0].actions, brief(a && itemBrief(a)));
  const failed = views.fail?.filter((item) => item.error) ?? [];
  record('FC-23 opening a session whose check request failed: the reply "Done." and the error card (no put-back '
    + 'link), no tool card; the only empty item allowed is the failed check request\'s saved empty message right '
    + 'before the error card', cleanUntil(views.fail, 'error') && assistantItems(views.fail)[0]?.prose === 'Done.'
    && failed.length === 1 && !failed[0].error.putBack, brief(views.fail && itemBrief(views.fail)));
  const stopped = views.stop?.filter((item) => item.text.includes(STOPPED_TEXT)) ?? [];
  record('FC-23 opening a session stopped during its check: the reply "Done." and "Stopped · …" as before, no tool '
    + 'card and no error card; the only empty item allowed is the stopped check request\'s saved empty message right '
    + 'before "Stopped · …"', cleanUntil(views.stop, 'stopped') && assistantItems(views.stop)[0]?.prose === 'Done.'
    && stopped.length === 1 && views.stop.every((item) => !item.error), brief(views.stop && itemBrief(views.stop)));
}

/**
 * @brief 一次运行之后关掉 Mori，把会话文件改成收尾检查之前存下的样子（synthetic test setup），重启后打开它发两条：
 *        refreshTools 把 finish 加回来。另外检查重启后打开的几个会话（reopenedViews）。FC-03、FC-23。
 */
async function reopen(ctx) {
  const old = await open(ctx);
  await run(ctx, old, `plain question saved before finish existed ${tag('old')}`);
  await closeTbApp(ctx);
  const cut = rewriteWithoutFinish(old.sessionFile);
  const declared = fileView(old.sessionFile).systems.flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name));
  ctx.projectTabs = {};
  await startFcApp(ctx);
  await reopenedViews(ctx);
  old.tab = await reopenSession(ctx, old.sessionFile);
  const n0 = fileView(old.sessionFile).systems.length;
  const r1 = await run(ctx, old, `plain first question after reopening ${tag('old')}`);
  const v1 = fileView(old.sessionFile);
  const r2 = await run(ctx, old, `plain second question after reopening ${tag('old')}`);
  const n2 = fileView(old.sessionFile).systems.length;
  const all = [...r1.reqs, ...r2.reqs];
  const patch = v1.systems.slice(n0).flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name));
  record('FC-03 reopening a session saved without finish (its system message declares no finish): refreshTools '
    + 'enables it, so the first and the second run both send finish; the first run\'s tool patch adds finish and the '
    + 'second run writes no patch', cut.cut > 0 && !declared.includes(FINISH_TOOL) && all.length === 4
    && all.every((item) => item.tools.includes(FINISH_TOOL)) && patch.includes(FINISH_TOOL)
    && n2 === v1.systems.length, brief({ cut, declared, n0, n1: v1.systems.length, n2, patch,
    flags: checkFlags(all) }));
}

// ---------- 主流程 ----------

/**
 * 按顺序跑的步骤：snapshot、refs、toolsPage 用 prompt 的会话；reopen 用 confirm、fail、stop 的会话；attach 重新载入
 * 界面（之前的会话面板标识作废），所以用这些面板的步骤都在它之前
 */
const steps = { prompt, bare, snapshot, roleTools, approval, confirm, confirmText, early, think, work, mixed, rewrite,
  badArgs, cap, queue, steer, stop, fail, failFirst, unavailable, switchReply, switchEarly, switchWork, switchPlain,
  replay, refs, toolsPage, attach, enhance, reopen };

const ctx = { userData: tempUserData('mori-fc-check-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[${args.suite}] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: ${args.suite}`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  const missing = missingSteps(ctx.ep);
  record(`${args.suite}: the synthetic endpoint got no request that the scenarios did not expect`, missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} catch (error) {
  record(`setup: ${args.suite}`, false, oneLineError(error));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[${args.suite}] data in ${ctx.userData}`);
finish();
