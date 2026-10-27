// 收尾检查规格的 App 套件：协作模式与 Team（docs/specs/finish-check.md §14.2 的 FC-02、FC-03、FC-10、FC-11（fc-a-text
// 的 run.lastText）、FC-18、FC-19、FC-20、FC-25 在协作模式下的 App 部分；§8、§10.4）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式
// （tests/fake-endpoint/scenarios/fc-team.mjs，与 mem.mjs 的 mem-team，synthetic）；用户会话的检查请求由合成端点默认
// 只回一个 finish，要别的回应时消息或 agent_message 的正文里写 fc-scenario（tests/fake-endpoint/finish.mjs）。
// 读的是合成端点的日志行（check、checks）、记录代理的请求体、会话文件与实例会话文件、后台进程的日志。
// 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败）：
//   split（分开配置）→ FC-02、FC-03、FC-10、FC-18、FC-20、FC-25；
//   merged（合并会话）→ FC-02、FC-03、FC-11、FC-18、FC-20、FC-25；
//   fail（合并会话里检查那次请求出错）→ FC-10、FC-19；runmode（运行中打开协作模式）→ FC-10；
//   enhance（协作模式的增强）→ FC-02、FC-25。
// 文件系统合并之后（finish-check.md §11 左列，2026-10-27）：mori.team 只记模式（没有 tools），“重新打开早于收尾检查的
// mori.team”一步（restore）去掉；协作模式下对话碰文件的工具与关闭模式相同、只多职责工具，越界的调用由路径闸按收窄拒绝
// （RELAY_ONLY），不再有 "Tool bash not found"。
// 关闭模式的部分（关闭模式的用户会话、关闭模式的增强）在 tests/ui/fc-app-check.mjs。
// 用法（在 app/ 下，out/ 是当前的构建）：
//   node tests/ui/fc-app-team.mjs [--exe <Mori.exe>] [--only split,merged,fail,runmode,enhance]
// 结果写到 test-results/fc-app-team(-packaged).json（--only 时 fc-partial-app-team…，不计入覆盖检查），
// 截图与 app.log 在 test-results/fc-app-team/。
// 端口（§14.1 分给本套件的 4960–4969）：用户会话的合成端点 4960 与记录代理 4961，增强的 4962 与 4963。
// 测试准备（synthetic test setup，逐处注明）：
// - 数据目录里两个本机提供商（各一个模型，写入等级 A，跳过探针）：fct 给用户会话（默认范围），fce 给增强；
//   五个临时项目都已信任，各自的 AGENTS.md 带自己的 tb-scenario（进每个会话的 system）；
// - split、merged、runmode 的项目在会话打开之前经进程桥写一条 TASTE 与一条 REVIEW（本项目，同记忆页的 Save）；
//   split 在会话打开之后再写一条 TASTE（快照，不进这个会话）；fail 的项目没有记忆条目；
// - enhance 的项目：一个手写的会话文件与 enhance.json（同 mem-app-team.mjs 的合并配置：team 为真，TASTE 与 REVIEW
//   的水位已到会话的最后一条，只有 STRATEGY 跑）；
// FC-18：分开时对话在检查之后调 bash 得到路径闸的 RELAY_ONLY（文件系统合并之后 bash 在对话的工具里，由收窄拒绝），
// 另查检查之后的那次请求仍是对话的那一组工具、仍以工作卡结尾。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEM_TEAM_TEXT } from '../fake-endpoint/scenarios/mem.mjs';
import { FC_TEAM_TEXT as TEXT } from '../fake-endpoint/scenarios/fc-team.mjs';
import {
  CONFIRMED, RELAY_ONLY, allRequests, checkEntries, checkLineText, checkTail, dayClock, earlierCheckLines,
  enhanceProgress, fcArgs, fcProject, fileEntries, finishCalls, hasFinish, headlessSessions, isCardMessage,
  isCheckMessage, lastMessageBefore, replyTexts, saveEntry, sectionText, seedEnhance,
  systemSection, toolPatches, toolResultsIn, userIndex, waitLine, writeSeedSession,
} from './fc-team-helpers.mjs';
import {
  SPLIT_ROLES, appLogLines, bridge, brief, clickTeamSwitch, closeTbApp, customOf, instanceFiles, missingSteps,
  oneLine, openProject, poll, seedTeamUserData, sendMessage, shot, sleep, startTbApp, startTbEndpoint,
  stopTbEndpoint, tbModel, tbProvider, tbRecorder, tempUserData, userSession, waitProgress, waitTeamIdle,
} from './tb-helpers.mjs';

const args = fcArgs();
const { record, finish } = tbRecorder(args);

// ---------- 常量 ----------

/** 本套件的端口：用户会话的合成端点与记录代理，增强的合成端点与记录代理 */
const PORT = 4960;
const PROXY = 4961;
const ENH_PORT = 4962;
const ENH_PROXY = 4963;
/** 合成端点上的模型（synthetic）：写入等级 A、能关思考，不支持思考（检查的默认回应不带思考） */
const MODEL = 'fake-coder-fcteam';
const ENH_MODEL = 'fake-coder-fcenh';
/** 各步骤的脚本 */
const SCN = { split: 'tb-fcteam-split', merged: 'tb-fcteam-merged', fail: 'tb-fcteam-fail',
  runmode: 'tb-fcteam-runmode', enhance: 'mem-team' };
/** 记忆条目（synthetic）：会话打开之前写的 TASTE、REVIEW，split 的会话打开之后才写的 TASTE */
const TASTE = 'Answer with the conclusion first';
const REVIEW = 'Check that every claim names its file';
const LATE_TASTE = 'Keep every reply under five lines';
/** 分开配置加一个订阅 request_closed 的 watcher（订阅实例） */
const SPLIT_FC_ROLES = [...SPLIT_ROLES,
  { name: 'watcher', description: 'Keeps notes when a request closes', subscribe: ['request_closed'] }];
/** §7.1、§7.2 的原文：检查那一行的三种、检查块 */
const LINE_TASTE = checkLineText(['taste']);
const LINE_BOTH = checkLineText(['taste', 'review']);
const LINE_NONE = checkLineText([]);
const TASTE_BLOCK = sectionText('taste', [TASTE]);
const BOTH_BLOCK = `${TASTE_BLOCK}\n${sectionText('review', [REVIEW])}`;
/**
 * 协作模式下分开时对话的工具，排好序：碰文件的默认工具同关闭模式，只多职责工具（file-system-permissions.md §8.6）——
 * board_read、read_session、agent_message，以及一直启用的 ask_user_question 与 finish（收尾检查规格 §11）
 */
const TEAM_DIALOG_TOOLS = ['agent_message', 'ask_user_question', 'bash', 'board_read', 'edit', 'finish', 'read',
  'read_session', 'write'];
/** 回到关闭模式后恢复的写入与命令类工具 */
const WRITE_TOOLS = ['bash', 'edit', 'write'];
/** 增强进度的终态 */
const TERMINAL = ['done', 'skipped', 'failed'];
/** fc-a-text 确认时另写的那句话（tests/fake-endpoint/finish.mjs 的 FC_SCENARIOS，独立写出，用来核对） */
const STANDS = 'The reply stands.';

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 错误的一行文字。 */
const oneLineError = (error) => String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
/** @brief 请求的简写（检查的 detail）。 */
const where = (r) => `${r.info.role}/${r.info.kind}/${r.info.task ?? '-'} k=${r.info.k} j=${r.info.j}`
  + `${r.info.check ? ' check' : ''}`;
/** @brief 请求里的工具名，排好序。 */
const sortedTools = (request) => [...request.tools].sort();
/** @brief 一段文字的结尾（detail 用）。 */
const tailOf = (text, n = 80) => (typeof text === 'string' ? oneLine(text.slice(-n), n) : text);
/** @brief 检查请求末尾的简写（detail 用）。 */
const tailBrief = (tail) => tail && { line: tailOf(tail.line, 120), card: tail.card, cards: tail.cards,
  before: tail.before };
/** @brief 一个会话（角色、种类）是不是用户会话：分开时是 chat，合并会话里是兼立项的对话或关闭模式的对话。 */
const userOf = (merged) => (role, kind) => (merged ? ['merged-create', 'dialog'].includes(kind) : role === 'chat');
/** @brief 实例会话文件里的某种实例（mori.instance 条目的 kind 与 task）。 */
const instanceOf = (run, kind, task) => run.instances.find((item) => {
  const meta = customOf(item.entries, 'mori.instance')[0] ?? {};
  return meta.kind === kind && (task === undefined || meta.task === task);
}) ?? null;

/** @brief 打开一个项目，返回 { tab, sessionId, sessionFile }。 */
async function openWho(ctx, project) {
  const tab = await openProject(ctx, project);
  return { tab, ...(await userSession(ctx, tab)) };
}

/** @brief 发一条消息，等用户会话与整个协作空闲；超时时报错（步骤失败）。 */
async function talk(ctx, who, text, timeout = 90000) {
  await sendMessage(ctx, who.tab, text);
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/**
 * @brief 一个步骤的材料：会话文件的条目、记录代理收到的请求（含检查请求）、端点日志行（这个脚本与它用到的 fc 场景）、
 *        实例会话文件。
 * @param fcNames 这一步用到的 fc 场景名（那些请求的日志行 scenario 记 fc 场景名）
 */
function gather(ctx, who, scenario, since, fcNames = []) {
  const names = [scenario, ...fcNames];
  return { who, since, scenario, entries: fileEntries(who.sessionFile),
    requests: allRequests(ctx.ep, scenario, since),
    logs: ctx.ep.logs.filter((line) => !line.probe && line.t >= since && names.includes(line.scenario)),
    instances: instanceFiles(ctx, who.sessionId) };
}

/** @brief 用户会话的请求与实例的请求：{ user, inst }。 */
function splitRequests(run, merged) {
  const isUser = userOf(merged);
  return { user: run.requests.filter((r) => isUser(r.info.role, r.info.kind)),
    inst: run.requests.filter((r) => !isUser(r.info.role, r.info.kind)) };
}

// ---------- 准备 ----------

/**
 * @brief 测试准备（synthetic test setup）：五个临时项目、增强要的会话文件与 enhance.json、两个合成端点与记录代理、
 *        数据目录（两个提供商、信任五个项目），启动 App，写会话打开之前的记忆条目。
 */
async function setup(ctx) {
  ctx.clock = dayClock(Date.now());
  ctx.projects = {
    split: fcProject('mori-fc-team-split-', SCN.split, SPLIT_FC_ROLES),
    merged: fcProject('mori-fc-team-merged-', SCN.merged),
    fail: fcProject('mori-fc-team-fail-', SCN.fail),
    runmode: fcProject('mori-fc-team-runmode-', SCN.runmode),
    enhance: fcProject('mori-fc-team-enhance-', SCN.enhance),
  };
  ctx.seed = writeSeedSession(ctx.userData, ctx.projects.enhance, ctx.clock.now);
  seedEnhance(ctx.userData, ctx.projects.enhance, { provider: 'fce', seed: ctx.seed, clock: ctx.clock });
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  ctx.enhEp = await startTbEndpoint(ENH_PORT, ENH_PROXY, { MEM_TEAM_SESSION: ctx.seed.file,
    MEM_TEAM_ENTRY: ctx.seed.userEntry });
  seedTeamUserData(ctx.userData, { providers: [tbProvider('fct', PROXY, [tbModel(MODEL)]),
    tbProvider('fce', ENH_PROXY, [tbModel(ENH_MODEL)])], normalDefault: 'fct',
  trusted: Object.values(ctx.projects) });
  await startTbApp(ctx);
  await ctx.page.getByRole('button', { name: 'Open folder…', exact: true }).first().waitFor({ timeout: 60000 });
  for (const key of ['split', 'merged', 'runmode']) {
    await saveEntry(ctx, ctx.projects[key], 'taste', TASTE);
    await saveEntry(ctx, ctx.projects[key], 'review', REVIEW);
  }
}

// ---------- 步骤 split：分开配置 ----------

/** @brief 分开配置的会话里用户消息与投递的条目下标：a（第一条）、report（汇报）、b（fc-b）、c、d（关闭模式两条）。 */
function splitIndexes(entries) {
  const a = userIndex(entries, (text) => text.includes(TEXT.splitFirst));
  const report = userIndex(entries, (text) => text.trimStart().startsWith('[Mori]'), a);
  const b = userIndex(entries, (text) => text.includes(TEXT.splitFcB), report);
  const c = userIndex(entries, (text) => text.includes(TEXT.offOne), b);
  const d = userIndex(entries, (text) => text.includes(TEXT.offTwo), c);
  return { a, report, b, c, d };
}

/**
 * @brief 分开配置（脚本 tb-fcteam-split）：开关切到 always，会话打开之后写一条 TASTE；协作模式下问一次（立项、task、
 *        临时提问、结案、订阅、程序投递的汇报都跑一遍），再问一次（fc-b）；回到关闭模式问两次。
 */
async function split(ctx) {
  const project = ctx.projects.split;
  const who = await openWho(ctx, project);
  const on = await clickTeamSwitch(ctx, who.tab, 'always');
  await saveEntry(ctx, project, 'taste', LATE_TASTE);
  const since = Date.now();
  await talk(ctx, who, TEXT.splitFirst, 180000);
  await talk(ctx, who, TEXT.splitFcB);
  const off = await clickTeamSwitch(ctx, who.tab, 'off');
  await talk(ctx, who, TEXT.offOne);
  await talk(ctx, who, TEXT.offTwo);
  await sleep(500);
  const run = gather(ctx, who, SCN.split, since, ['fc-b']);
  run.modes = [on.mode, off.mode];
  run.at = splitIndexes(run.entries);
  splitTools(run);
  splitAlways(run);
  splitBlocks(run);
  splitFile(run);
  splitWork(run);
  splitDelivered(run);
  instancesClean(run, false, 'split (create, close, task, ask, subscription)', 5);
}

/** @brief FC-02：分开时用户会话的每个请求有 finish，五种实例的都没有。 */
function splitTools(run) {
  const { user, inst } = splitRequests(run, false);
  const kinds = [...new Set(inst.map((r) => r.info.kind))].sort();
  record('FC-02 split team mode (chat holds dialog): every request of the user session — your messages and the '
    + 'program-delivered report in team mode, their check requests, and the off-mode runs after it — has finish in '
    + 'tools; no request of the create, close, task, ask or subscription instance has it',
  user.length >= 10 && user.filter((r) => r.info.check).length >= 6 && user.every(hasFinish)
    && same(kinds, ['ask', 'close', 'create', 'subscription', 'task']) && inst.every((r) => !hasFinish(r)),
  brief({ user: user.length, missing: user.filter((r) => !hasFinish(r)).map(where), kinds,
    withFinish: inst.filter(hasFinish).map(where) }));
}

/** @brief FC-03：分开时对话、回到关闭模式，第一次与第二次运行都有 finish、第二次没有工具补丁；finish 得到 Confirmed.。 */
function splitAlways(run) {
  const { entries, at } = run;
  const { user } = splitRequests(run, false);
  const runOf = (kind, k) => user.filter((r) => r.info.kind === kind && r.info.k === k);
  const team = [...runOf('team-dialog', 1), ...runOf('team-dialog', 2)];
  const off = [...runOf('off-dialog', 4), ...runOf('off-dialog', 5)];
  const teamPatches = toolPatches(entries, at.a, lastMessageBefore(entries, at.c) + 1);
  const offPatches = toolPatches(entries, at.c);
  const ordered = at.a >= 0 && at.report > at.a && at.b > at.report && at.c > at.b && at.d > at.c;
  record('FC-03 split team mode: the dialog\'s first and second team-mode runs (your message, then the '
    + 'program-delivered report) have finish in every request, and no tool patch is written after the first run\'s '
    + 'message while team mode stays on', run.modes[0] === 'always' && ordered && runOf('team-dialog', 1).length >= 2
    && runOf('team-dialog', 2).length >= 2 && team.every(hasFinish) && teamPatches.length === 0,
  brief({ at, team: team.map((r) => `${where(r)} ${hasFinish(r)}`), teamPatches }));
  record('FC-03 back from team mode to off (split): the first and second off-mode runs have finish in every request '
    + '(next to bash, edit and write again), and the second off-mode run writes no tool patch',
  run.modes[1] === 'off' && ordered && runOf('off-dialog', 4).length >= 2 && runOf('off-dialog', 5).length >= 2
    && off.every((r) => hasFinish(r) && WRITE_TOOLS.every((tool) => r.tools.includes(tool)))
    && offPatches.length === 0, brief({ off: off.map((r) => `${where(r)} ${sortedTools(r).join(',')}`), offPatches }));
  const results = ordered ? toolResultsIn(entries.slice(0, at.c), 'finish') : [];
  record('FC-03 split team mode: every finish the dialog called got "Confirmed." — not RELAY_ONLY, not "Tool finish '
    + 'not found"', results.length >= 3 && results.every((item) => !item.isError && item.text === CONFIRMED),
  brief(results));
}

/** @brief FC-10、FC-20：分开时对话的检查请求（检查块只有 <taste>、同一条 user 消息、工作卡在最后），之后的请求只剩原文。 */
function splitBlocks(run) {
  const { user } = splitRequests(run, false);
  const checks = user.filter((r) => r.info.check && r.info.kind === 'team-dialog');
  const tails = checks.map((r) => ({ ...checkTail(r), section: systemSection(r, 'taste') }));
  const want = `${LINE_TASTE}\n\n${TASTE_BLOCK}`;
  record('FC-10 split team mode: in every check request of the dialog the check line carries the check block in the '
    + 'same user message right after the reply ("<line>\\n\\n<taste>…</taste>", equal to the <taste> section of '
    + 'that request\'s system prompt), and the work card is still the last message', checks.length >= 4
    && tails.every((t) => t.line === want && t.section === TASTE_BLOCK && t.before === 'assistant' && t.card
      && t.cards === 1), brief(tails.map(tailBrief)));
  record('FC-20 split team mode: the dialog agent\'s check block has only <taste> (no <review>) and its check line '
    + 'is the TASTE one ("against <taste> below")', checks.length >= 4 && tails.every((t) => t.line !== null
    && t.line.startsWith(`${LINE_TASTE}\n\n<taste>\n`) && !t.line.includes('<review>')), brief(tails.map(tailBrief)));
  record('FC-10 split: a TASTE entry added on the Memory page after the session opened is not in its check block '
    + '(the open-time snapshot)', checks.length >= 4 && tails.every((t) => t.line !== null
    && !t.line.includes(LATE_TASTE)), brief(tails.map((t) => t.line?.includes(LATE_TASTE))));
  const following = user.find((r) => r.info.kind === 'team-dialog' && r.info.k === 3 && r.info.j === 0
    && !r.info.check);
  const earlier = following ? earlierCheckLines(following) : [];
  record('FC-10 split: the next request (your next message) carries the earlier check lines as written, without the '
    + 'check block', earlier.length === 2 && earlier.every((text) => text === LINE_TASTE),
  brief(earlier.map((text) => tailOf(text))));
  const offChecks = user.filter((r) => r.info.check && r.info.kind === 'off-dialog').map(checkTail);
  record('FC-10 split back in off mode: the next runs follow the new mode — the user session is the main agent again, '
    + 'its check line is the TASTE-and-REVIEW one with both sections, and there is no work card', offChecks.length >= 2
    && offChecks.every((t) => t.line === `${LINE_BOTH}\n\n${BOTH_BLOCK}` && t.cards === 0 && t.before === 'assistant'),
  brief(offChecks.map(tailBrief)));
}

/** @brief FC-10：会话文件里的检查那一行是原文（custom_message，display 为假，没有 details）。 */
function splitFile(run) {
  const found = checkEntries(run.entries);
  const want = [LINE_TASTE, LINE_TASTE, LINE_TASTE, LINE_TASTE, LINE_BOTH, LINE_BOTH];
  record('FC-10 split: the session file keeps every check line as written (custom_message mori.finish_check, display '
    + 'false, no details, no check block): the TASTE line for the four checks in team mode, then the '
    + 'TASTE-and-REVIEW line of each off-mode run', same(found.map((entry) => entry.content), want)
    && found.every((entry) => entry.display === false && entry.details === undefined),
  brief(found.map((entry) => ({ display: entry.display, details: entry.details ?? null,
    content: tailOf(entry.content, 70) }))));
}

/**
 * @brief FC-18（fc-b）：检查之后对话的 bash 仍被路径闸拒绝（RELAY_ONLY）、没有执行，之后的请求仍是对话的那一组工具与工作卡；
 *        接着写出 "The tests passed."，再检查一次（日志 checks 为 1、2）。
 */
function splitWork(run) {
  const { at } = run;
  const { user } = splitRequests(run, false);
  const ordered = at.b >= 0 && at.c > at.b;
  const bash = ordered ? toolResultsIn(run.entries.slice(at.b, at.c), 'bash') : [];
  const replies = ordered ? replyTexts(run.entries, at.b, at.c) : [];
  const checks = run.logs.filter((line) => line.scenario === 'fc-b' && line.check).map((line) => line.checks);
  const after = user.filter((r) => r.info.k === 3 && r.info.j > 0 && !r.info.check);
  const refused = bash.length === 1 && bash[0].isError && bash[0].text === RELAY_ONLY;
  record('FC-18 split team mode, fc-b (said it would run the tests, then stopped): after the finish check the '
    + 'dialog\'s bash is still refused by the path gate (RELAY_ONLY, its narrowing) and does not run; the request '
    + 'after it still has the dialog\'s team-mode tools and ends with the work card; the run goes on to "The tests '
    + 'passed." with a second check (log checks 1, 2)',
  refused && same(checks, [1, 2]) && same(replies, ["I'll run the tests.", 'The tests passed.'])
    && after.length === 1 && same(sortedTools(after[0]), TEAM_DIALOG_TOOLS) && isCardMessage(after[0].messages.at(-1)),
  brief({ bash, checks, replies, after: after.map((r) => `${where(r)} ${sortedTools(r).join(',')}`) }));
}

/** @brief FC-20：程序投递开始的运行同样检查；对话的 finish 成功；实例的请求都不是检查请求。 */
function splitDelivered(run) {
  const report = run.logs.filter((line) => line.check && line.agent === 'chat' && line.kind === 'team-dialog'
    && line.k === 2);
  record('FC-20 split: the run the program started in the user session (the report after request 1 closed, k=2) is '
    + 'checked too — one check: true log line of chat / team-dialog', report.length === 1 && report[0].status === 200,
  brief(report.map((line) => ({ k: line.k, checks: line.checks, status: line.status, calls: line.calls }))));
  const finishes = toolResultsIn(run.entries, 'finish');
  record('FC-20 split: the dialog\'s finish succeeds — every finish result in the user session file is "Confirmed." '
    + '(three checks in team mode, two in off mode)', finishes.length === 5
    && finishes.every((item) => !item.isError && item.text === CONFIRMED), brief(finishes));
  noInstanceChecks(run, false, 'split: no create, close, task, ask or subscription request');
}

/** @brief FC-20：实例的请求都不是检查请求（没有 check: true 的日志行，消息里没有检查那一行）。 */
function noInstanceChecks(run, merged, label) {
  const isUser = userOf(merged);
  const lines = run.logs.filter((line) => !isUser(line.agent, line.kind));
  const { inst } = splitRequests(run, merged);
  const carrying = inst.filter((r) => r.messages.some(isCheckMessage));
  record(`FC-20 ${label} is a check request (no check: true log line, no check line in their messages)`,
    lines.length > 0 && lines.every((line) => !line.check) && inst.length > 0 && carrying.length === 0,
    brief({ lines: lines.length, checks: lines.filter((line) => line.check).map((line) => `${line.agent}/${line.kind}`),
      carrying: carrying.map(where) }));
}

/** @brief FC-25：协作模式的实例：请求里没有 finish、没有检查请求，实例会话文件里没有检查那一行与 finish 调用。 */
function instancesClean(run, merged, label, files) {
  const isUser = userOf(merged);
  const { inst } = splitRequests(run, merged);
  const lines = run.logs.filter((line) => !isUser(line.agent, line.kind));
  const view = run.instances.map((item) => ({ id: item.id.slice(-24), checks: checkEntries(item.entries).length,
    finish: finishCalls(item.entries) }));
  record(`FC-25 team-mode instances, ${label}: no request has finish, there is no check: true log line, and no `
    + 'instance session file has a mori.finish_check entry or a finish call', view.length >= files
    && view.every((item) => item.checks === 0 && item.finish === 0) && inst.length > 0
    && inst.every((r) => !hasFinish(r)) && lines.every((line) => !line.check),
  brief({ files: view, withFinish: inst.filter(hasFinish).map(where) }));
}

// ---------- 步骤 merged：合并会话 ----------

/**
 * @brief 合并会话（脚本 tb-fcteam-merged）：开关切到 always 问一次：登记需求 1、T1 → T1 等合并会话回答两个问题
 *        （程序投递；第二个带 fc-a-text）→ 结案关闭 → 汇报。
 */
async function merged(ctx) {
  const who = await openWho(ctx, ctx.projects.merged);
  await clickTeamSwitch(ctx, who.tab, 'always');
  const since = Date.now();
  await talk(ctx, who, TEXT.mergedFirst, 180000);
  const shown = await waitProgress(ctx, who.tab, { request: 1 }, 10000);
  await sleep(500);
  const run = gather(ctx, who, SCN.merged, since, ['fc-a-text']);
  run.shown = shown;
  run.a = userIndex(run.entries, (text) => text.includes(TEXT.mergedFirst));
  mergedTools(run);
  mergedRun(run);
  mergedBlocks(run);
  instancesClean(run, true, 'merged session (task, close)', 2);
}

/** @brief FC-02、FC-03：合并会话的每个请求有 finish、task 与结案的都没有；前两次运行之后没有工具补丁。 */
function mergedTools(run) {
  const { user, inst } = splitRequests(run, true);
  const kinds = [...new Set(inst.map((r) => r.info.kind))].sort();
  record('FC-02 merged session in team mode (no role files): every request of the user session — your message, the '
    + 'two program deliveries T1 waits on, the report, and their check requests — has finish in tools; no request of '
    + 'the task or close instance has it', user.length >= 8 && user.every(hasFinish) && same(kinds, ['close', 'task'])
    && inst.every((r) => !hasFinish(r)), brief({ user: user.map(where), kinds,
    withFinish: inst.filter(hasFinish).map(where) }));
  const runOf = (k) => user.filter((r) => r.info.kind === 'merged-create' && r.info.k === k);
  const patches = run.a >= 0 ? toolPatches(run.entries, run.a) : ['no user message'];
  record('FC-03 merged session in team mode: the first and second team-mode runs (your message, then the program '
    + 'delivery T1 waits on) have finish in every request, and no tool patch is written after the first run\'s message',
  runOf(1).length >= 2 && runOf(2).length >= 2 && [...runOf(1), ...runOf(2)].every(hasFinish) && patches.length === 0,
  brief({ runs: [...runOf(1), ...runOf(2)].map(where), patches }));
}

/**
 * @brief FC-18：合并会话的判断在检查之后照常结束（mori.progress 写在这次运行的检查那一行之后、下一次运行之前，进展摘要
 *        显示出来）；T1 等的第一个 agent_message 拿到最终回复，不是 It ended without a reply.。
 *        FC-11（fc-a-text）：第二个 agent_message 开始的运行在检查时另写一句并调 finish，run.lastText 是那句话，T1 拿到它。
 */
function mergedRun(run) {
  const { entries, a } = run;
  const checkAt = entries.findIndex((entry, index) => index > a && entry.type === 'custom_message'
    && entry.customType === 'mori.finish_check');
  const progressAt = entries.findIndex((entry) => entry.type === 'custom' && entry.customType === 'mori.progress'
    && entry.data?.request === 1);
  const next = userIndex(entries, (text) => text.trimStart().startsWith('[Mori]'), a);
  record('FC-18 merged session: the judgment of your message still ends with the run — mori.progress for request 1 '
    + 'is written after that run\'s check line and before the next run, and the progress summary is shown',
  a >= 0 && checkAt > a && progressAt > checkAt && next > progressAt && run.shown,
  brief({ a, checkAt, progressAt, next, shown: run.shown }));
  const t1 = instanceOf(run, 'task', 'T1');
  const results = toolResultsIn(t1?.entries ?? [], 'agent_message');
  const want = `Mori replied: ${TEXT.mergedAnswer}`;
  record(`FC-18 merged session: the first agent_message T1 waits on gets the final reply of the user session's run `
    + `("${want}"), not "It ended without a reply."`, results.length === 2 && !results[0].isError
    && results[0].text === want, brief({ instance: t1?.id ?? null, results }));
  const stands = `Mori replied: ${STANDS}`;
  record(`FC-11 fc-a-text: run.lastText is the sentence written with finish — the second agent_message T1 waits on `
    + `gets "${stands}"`, results.length === 2 && !results[1].isError && results[1].text === stands,
  brief({ instance: t1?.id ?? null, results }));
}

/** @brief FC-20：合并会话的检查块只有 <taste>、检查那一行是 TASTE 那种、工作卡在最后；task 与结案没有检查请求。 */
function mergedBlocks(run) {
  const { user } = splitRequests(run, true);
  const checks = user.filter((r) => r.info.check);
  const tails = checks.map((r) => ({ ...checkTail(r), section: systemSection(r, 'taste') }));
  record('FC-20 merged session (dialog and create): the check block has only <taste> (create has no REVIEW) and the '
    + 'check line is the TASTE one, in the same user message as the block; the work card is still the last message',
  checks.length >= 3 && tails.every((t) => t.line === `${LINE_TASTE}\n\n${TASTE_BLOCK}` && t.section === TASTE_BLOCK
    && t.card && t.cards === 1), brief(tails.map(tailBrief)));
  noInstanceChecks(run, true, 'merged session: no task or close request');
}

// ---------- 步骤 fail：检查那次请求出错 ----------

/**
 * @brief 合并会话（脚本 tb-fcteam-fail，项目没有记忆条目）：登记需求 1、T1 → T1 等合并会话回答两个问题：fc-fail
 *        （检查那次请求出错）、fc-work-fail（检查之后干了活再出错）→ 结案关闭 → 汇报。
 */
async function fail(ctx) {
  const who = await openWho(ctx, ctx.projects.fail);
  await clickTeamSwitch(ctx, who.tab, 'always');
  const since = Date.now();
  await talk(ctx, who, TEXT.failFirst, 180000);
  await sleep(500);
  const run = gather(ctx, who, SCN.fail, since, ['fc-fail', 'fc-work-fail']);
  run.kernel = appLogLines(ctx, `${who.sessionId}: the finish check request failed (`, since);
  failWaiters(run);
  failRequests(run);
  const first = run.requests.find((r) => r.info.kind === 'merged-create' && r.info.k === 1 && r.info.check);
  const tail = first ? checkTail(first) : null;
  record('FC-10 a project with no TASTE or REVIEW entries: the check line is the one without the third line and '
    + 'there is no check block (merged session in team mode; the work card is still the last message)',
  tail?.line === LINE_NONE && tail.card && systemSection(first, 'taste') === null
    && systemSection(first, 'review') === null, brief(tailBrief(tail)));
}

/** @brief FC-19：fc-fail 时 T1 拿到回复的最后一段文字，fc-work-fail 时仍按出错；后台进程的错误日志只记一次。 */
function failWaiters(run) {
  const t1 = instanceOf(run, 'task', 'T1');
  const results = toolResultsIn(t1?.entries ?? [], 'agent_message');
  record('FC-19 merged session in team mode: when the check request of the run the program started for T1\'s '
    + 'agent_message fails (fc-fail), the run counts as completed — T1 gets the reply\'s last text ("Mori replied: '
    + 'Done."), not a failure', results.length === 2 && !results[0].isError
    && results[0].text === 'Mori replied: Done.', brief({ instance: t1?.id ?? null, results }));
  record('FC-19 merged session: when the run did work after the check and then failed (fc-work-fail), T1\'s '
    + 'agent_message still fails (an error result, not "Mori replied: …")', results.length === 2
    && results[1].isError && !results[1].text.startsWith('Mori replied:'), brief(results));
  record('FC-19 the kernel logs "<session id>: the finish check request failed (<error>); the run counts as '
    + 'completed" once — for the fc-fail run only', run.kernel.length === 1
    && run.kernel[0].includes('; the run counts as completed'), brief(run.kernel));
}

/** @brief FC-19：端点看到的：fc-fail 的检查请求 400；fc-work-fail 的检查请求调了 bash，之后的那次请求 400。 */
function failRequests(run) {
  const shape = (line) => [line.check, line.status, line.calls ?? []];
  const fcFail = run.logs.filter((line) => line.scenario === 'fc-fail').map(shape);
  const workFail = run.logs.filter((line) => line.scenario === 'fc-work-fail').map(shape);
  const failed = (rest, check) => rest.length > 0 && rest.every((item) => item[0] === check && item[1] === 400);
  record('FC-19 the endpoint saw it as scripted: fc-fail answered "Done." and its check request failed with HTTP 400; '
    + 'fc-work-fail answered, called bash on its check request, and the request after the bash result (not a check '
    + 'request) failed with HTTP 400', same(fcFail[0], [false, 200, []]) && failed(fcFail.slice(1), true)
    && same(workFail[0], [false, 200, []]) && same(workFail[1], [true, 200, ['bash']])
    && failed(workFail.slice(2), false), brief({ fcFail, workFail }));
}

// ---------- 步骤 runmode：运行中打开协作模式 ----------

/**
 * @brief 合并配置（脚本 tb-fcteam-runmode）：关闭模式下发一条，回复晚 5 秒到，这期间打开协作模式；之后协作模式下再发
 *        一条。这次运行的检查用开始时的身份（主 Agent：TASTE 与 REVIEW），下一次运行跟着变（合并会话：只有 TASTE）。
 */
async function runmode(ctx) {
  const who = await openWho(ctx, ctx.projects.runmode);
  const since = Date.now();
  await sendMessage(ctx, who.tab, TEXT.runmodeFirst);
  await waitLine(ctx.ep, SCN.runmode, { agent: 'mori', kind: 'dialog', k: 1, j: 0, check: false });
  const clickAt = Date.now();
  const sw = await clickTeamSwitch(ctx, who.tab, 'always');
  if (!(await waitTeamIdle(ctx, who, { timeout: 60000 }))) throw new Error('the off-mode run did not end');
  await talk(ctx, who, TEXT.runmodeSecond);
  const requests = allRequests(ctx.ep, SCN.runmode, since);
  const first = requests.find((r) => r.info.kind === 'dialog' && r.info.k === 1 && r.info.check);
  const next = requests.find((r) => r.info.kind === 'merged-create' && r.info.k === 2 && r.info.check);
  const [t1, t2] = [first && checkTail(first), next && checkTail(next)];
  record('FC-10 turning team mode on during an off-mode run does not change that run\'s check: its check request '
    + '(sent after the Task mode row was turned on) carries the TASTE-and-REVIEW line with both sections and no work '
    + 'card; the next run (the merged session in team mode) follows the new mode — the TASTE line with only <taste>, '
    + 'and the work card is its last message', sw.mode === 'always' && first !== undefined && first.t > clickAt
    && t1.line === `${LINE_BOTH}\n\n${BOTH_BLOCK}` && t1.cards === 0 && t2?.line === `${LINE_TASTE}\n\n${TASTE_BLOCK}`
    && t2.card && t2.cards === 1, brief({ mode: sw.mode, late: first ? first.t - clickAt : null,
    first: tailBrief(t1), next: tailBrief(t2) }));
}

// ---------- 步骤 enhance：协作模式的增强 ----------

/** @brief 经进程桥发 enhance.run（同记忆页的 Run now），等三个任务的进度都到终态，再等 3 秒；返回进度与开始时刻。 */
async function runEnhance(ctx, cwd) {
  const since = Date.now();
  const sent = await bridge(ctx, { type: 'enhance.run', cwd });
  if (sent?.error) throw new Error(`enhance.run: ${sent.error}`);
  const progress = await poll(async () => {
    const list = await enhanceProgress(ctx, cwd, since);
    const ended = ['taste', 'strategy', 'review']
      .every((task) => list.some((item) => item.task === task && TERMINAL.includes(item.phase)));
    return ended ? list : null;
  }, 300000, 500);
  if (!progress) throw new Error(`the enhancement run did not end: ${brief(await enhanceProgress(ctx, cwd, since))}`);
  await sleep(3000);
  return { since, progress };
}

/**
 * @brief 协作模式的增强（mem-team 的合并配置，增强设置 team 为真）：请求里没有 finish、没有检查请求，增强会话与实例的
 *        会话文件里没有检查那一行与 finish 调用，修订的 Notes 照旧是增强会话的最后一条回复。
 */
async function enhance(ctx) {
  const cwd = ctx.projects.enhance;
  const { since, progress } = await runEnhance(ctx, cwd);
  const done = progress.find((item) => item.task === 'strategy' && TERMINAL.includes(item.phase)) ?? null;
  const enh = headlessSessions(ctx.userData, cwd).at(-1) ?? null;
  const instances = enh?.id ? instanceFiles(ctx, enh.id) : [];
  const requests = allRequests(ctx.enhEp, SCN.enhance, since);
  const logs = ctx.enhEp.logs.filter((line) => !line.probe && line.t >= since);
  const kinds = [...new Set(requests.map((r) => r.info.kind))].sort();
  record('FC-02 team-mode enhancement (team on, merged session): no request of the enhancement session or of its task '
    + 'and close instances has finish in tools', requests.length > 0 && same(kinds, ['close', 'merged-create', 'task'])
    && requests.every((r) => !hasFinish(r)), brief({ kinds, withFinish: requests.filter(hasFinish).map(where) }));
  const files = [enh, ...instances].filter(Boolean).map((item) => ({ id: item.id, checks: checkEntries(item.entries)
    .length, finish: finishCalls(item.entries) }));
  record('FC-25 team-mode enhancement: there is no check request — no check: true log line — and neither the '
    + 'enhancement session file nor its instance files have a mori.finish_check entry or a finish call',
  logs.length > 0 && logs.every((line) => !line.check) && files.length >= 3
    && files.every((item) => item.checks === 0 && item.finish === 0), brief({ logs: logs.length, files }));
  const info = await bridge(ctx, { type: 'enhance.get', cwd });
  const id = info?.last?.strategy?.revision ?? null;
  const revision = id === null ? null : (await bridge(ctx, { type: 'memory.revisions', cwd, layer: 'project',
    id }))?.revision ?? null;
  const reply = enh ? replyTexts(enh.entries).at(-1) ?? null : null;
  record('FC-25 team-mode enhancement: the run ends as before — the revision is done and its Notes are still the '
    + 'enhancement session\'s last reply', done?.phase === 'done' && revision?.status === 'done'
    && reply === MEM_TEAM_TEXT.report && revision.notes === reply,
  brief({ done, revision: revision && { status: revision.status, notes: revision.notes }, reply }));
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  split: [split, ['FC-02', 'FC-03', 'FC-10', 'FC-18', 'FC-20', 'FC-25']],
  merged: [merged, ['FC-02', 'FC-03', 'FC-11', 'FC-18', 'FC-20', 'FC-25']],
  fail: [fail, ['FC-10', 'FC-19']],
  runmode: [runmode, ['FC-10']],
  enhance: [enhance, ['FC-02', 'FC-25']],
};

/** @brief 套件结束时的检查：两个端点都没有收到脚本以外的请求。 */
function finalChecks(ctx) {
  for (const [name, ep] of [['user sessions', ctx.ep], ['enhancement', ctx.enhEp]]) {
    if (!ep) continue;
    const missing = missingSteps(ep);
    record(`fc-app-team (${name}): the synthetic endpoint got no request that the scripts did not expect`,
      missing.length === 0, brief(missing.map((item) => item.line).slice(0, 5)));
  }
}

const ctx = { userData: tempUserData('mori-fc-team-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, [step, ids]] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[fc-app-team] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      for (const id of ids) record(`${id} step ${name} ran to the end`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  finalChecks(ctx);
} catch (error) {
  record('setup', false, oneLineError(error));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
  await stopTbEndpoint(ctx.enhEp);
}
console.log(`[fc-app-team] data in ${ctx.userData}; projects ${Object.entries(ctx.projects ?? {})
  .map(([name, path]) => `${name}=${path}`).join(', ')}`);
finish();
