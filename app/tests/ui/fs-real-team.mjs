// 文件系统规格真实模型一层（docs/specs/file-system.md §19.1“真实”一行，§19.2 FS-67、FS-93、FS-114 的提问一项与 FS-21
// 协作模式的量法）的协作模式部分，供 tests/ui/fs-real.mjs 用：上下文与工具都来自 fs-real-setup.mjs（先 import 它），
// 每个场景导出一个以上下文为参数的函数，TEAM_STEPS 是它们的步骤（{ name, ids, run, start, timeoutMs }）。
// 真正的 Mori 对两个真实模型（DeepSeek 与 GLM，同 tb-real.mjs），全部经界面操作：
//   team-limits（FS-67，FS-21）：分开的配置（chat 持有对话，planner 持有立项与结案，executor 改代码、跑命令，reviewer 在
//     第二个提供商上复核），协作开关 always、Ask each time；让团队修好失败的测试（只许改 sum.js），reviewer 只读复核；出现的
//     批准卡都点 Allow once。核对（只断言程序保证的事）：每个 task_create 写的 limits 按 file-system-permissions.md §8.2
//     归一后存进 board.json（测试独立实现一遍归一），§8.2 不收的按它的原因拒绝、不建 task；每个被收窄拒绝的调用的工具结果
//     是它那个会话的 §8.4 原文（对话为整句 RELAY_ONLY），没有批准请求，收窄不许的调用没有成功的；被拒绝的 edit、write
//     的目标文件没有因它改变（驱动时每半秒取一次项目文件的散列）；对话会话在协作模式下的写入、命令调用都得到 RELAY_ONLY。
//     模型写了什么 limits、有没有被拒绝的调用只写进 note。同一次运行量这个工作路径的内部仓库里 refs/mori 下的提交数与
//     快照阶段的总时长，放进 ctx.fs21Team（记 FS-21 那条检查的步骤用 fs21TeamDetail 把它写进 detail；它要排在本步骤之后）。
//   ask-off（FS-93、FS-114）：关闭模式下给一个要你选的情况（设置文件的格式），等主 Agent 调用 ask_user_question；核对卡上
//     的问题与推荐项（推荐项是选项之一）、免批准、提交之后工具结果的 §14 原文。第一次的消息不点名工具，重跑时点名（note）。
//   ask-split（FS-93、FS-114）：分开的配置、协作开关 always、Full access；executor 的交接 need_user 带选项与推荐项，对话
//     Agent 用提问卡问你。卡出现后窗口失焦（fs-away-helpers installFocus 的替身），MORI_AWAY_TIMEOUT_MS 很短（AWAY_MS），
//     到时按推荐项回答：核对投递里的选项行、mori.question_end、工具结果、mori.away_decision、转给立项的投递（not the user's
//     choice）。最后的回复有没有提到推荐项只写进 note。
// 模型的行为（调用提问工具、交接带选项、立项转告而不是自己回答、卡上的推荐项与交接一致、立项建了 task）是驱动的前提：没满足
// 时换一个新项目重跑（fs-real-setup withAttempts，最多 3 次，原因写进整次运行的说明），仍不满足按失败。
// 测试准备（synthetic test setup）：每次尝试一个新的临时项目（newRealProject：授权公网）与新会话，角色文件写进项目的
// .mori/agents（tb-helpers writeRoles）；窗口焦点由测试给出。只读页面和磁盘、发界面操作，不改 Mori 的源码；key 不经过这里，
// 检查与说明都经 ctx.record、ctx.note 换掉 key。

import { ATTEMPTS, briefSafe, newRealProject, shotReal, withAttempts } from './fs-real-setup.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, win32 } from 'node:path';
import {
  answeredText, askCardOf, awayAnswerText, awayRecords, blurWindow, DURATION, eventsOfType, focusWindow, forwardText,
  installFocus, NOT_USER_CHOICE, reminderEntries, resultEntries, waitEvent,
} from './fs-away-helpers.mjs';
import { changesOf, internalRepo, repoGit, runsOf } from './fs-git-helpers.mjs';
import {
  bridge, fillSession, liveInfo, openFsSession, paneSel, paneState, poll, readJsonl, RELAY_ONLY, same, sendFs,
  setPermission, sleep,
} from './fs-helpers.mjs';
import { attr } from './md-real-helpers.mjs';
import { approvalCardsOf, clickTeamSwitch, contentText, instanceFiles, readBoard, writeRoles } from './tb-helpers.mjs';
import { chatRequests } from './tb-real-helpers.mjs';

// ---------- 常量 ----------

/** team-limits 一次尝试的时限（同 tb-real.mjs 的 15 分钟） */
const LIMITS_MS = 15 * 60 * 1000;
/** ask-split 一次尝试的时限（多一个来回：交接、问你、交回、结案） */
const SPLIT_MS = 20 * 60 * 1000;
/** ask-off 等卡、等回复结束的时限 */
const OFF_MS = 5 * 60 * 1000;
/** 需求都到终态后连续空闲多久算结束（同 tb-real.mjs） */
const ENDED_CALM_MS = 3000;
/** 还有开着的需求时连续空闲多久就不再等（同 tb-real.mjs） */
const OPEN_CALM_MS = 60000;
/** 关闭模式的会话连续空闲多久算回复结束 */
const OFF_CALM_MS = 2000;
/** ask-split 的 MORI_AWAY_TIMEOUT_MS（§9.3：三档时长都换成它；原文里的时长按设置写，startReal 设的是 60s） */
export const AWAY_MS = 20000;
/** 步骤时限 = 每次尝试的时限 × ATTEMPTS + 核对与截图的余量 */
const MARGIN_MS = 5 * 60 * 1000;
/** 被拒绝的调用的结果写下之后，至少过这么久的那一次采样才算“之后” */
const AFTER_MS = 300;
/** 采样项目文件时跳过的目录名（.git 是项目自己的仓库，.mori 里是角色文件）；.work 照样采：write: false 也拒绝写它 */
const SKIP_DIRS = new Set(['.git', '.mori', 'node_modules']);
/** 一次采样最多看多少个文件 */
const SAMPLE_MAX = 400;
/** FS-21 等内部仓库的 ref 稳定：最多等多久、连续多久不变算稳定（最后一次运行的结束快照在 agent_settled 之后才排） */
const REFS_WAIT_MS = 20000;
const REFS_STEADY_MS = 2000;

/** 读取类工具：从不被收窄拒绝（§8.2） */
const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
/** 改文件的工具 */
const FILE_TOOLS = ['edit', 'write'];
/** 跑命令的工具 */
const COMMAND_TOOLS = ['bash', 'powershell'];
/**
 * 职责工具：路径闸第 1 步放行，收窄管不到（shared/team.ts TEAM_TOOLS，加 memory、ask_user_question、finish 与 subagent；
 * 收尾检查规格 §11、U52，同 pathGate.ts 的 DUTY_TOOLS）
 */
const DUTY_TOOLS = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close', 'memory', 'ask_user_question',
  'finish', 'subagent'];
/** 收窄的拒绝原文的开头（file-system-permissions.md §8.3 的表，独立抄一份；对话会话为整句 RELAY_ONLY） */
const LEADS = Object.freeze({ task: 'Not allowed for this task', ask: 'Not allowed for this question',
  create: 'Not allowed while deciding requests', close: 'Not allowed while closing a request',
  subscription: 'Not allowed in a subscription' });
/** 带选项的 ask_user、relay 投递的最后一句（file-system.md §14） */
const ASK_WITH_CHOICES = 'Ask the user with ask_user_question, using these options and this recommendation.';
/** pi 在执行前校验参数失败时工具结果的开头：这种调用到不了路径闸 */
const PI_INVALID = 'Validation failed for tool';
/** FS-21 协作模式的快照时长是怎么量的（写进 ctx.fs21Team） */
const SNAPSHOT_HOW = 'userRunSnapshotMs sums the user session\'s mori.snapshot_stage spans (its own run-start '
  + 'snapshots, queue waits included); the instances\' snapshots send no event, so their time is not in it; commits '
  + 'counts the distinct commits under refs/mori after the run';

// ---------- 项目、角色与消息（synthetic test setup） ----------

/** team-limits 的项目：npm test 失败，只改 sum.js 就能修好 */
const LIMITS_FILES = Object.freeze({
  'package.json': `${JSON.stringify({ name: 'fs-real-sum', version: '1.0.0', private: true,
    scripts: { test: 'node test.js' } }, null, 2)}\n`,
  'sum.js': 'function sum(a, b) {\n  return a - b;\n}\n\nmodule.exports = { sum };\n',
  'test.js': "const assert = require('node:assert');\nconst { sum } = require('./sum');\n\n"
    + "assert.strictEqual(sum(2, 3), 5);\nassert.strictEqual(sum(-1, 1), 0);\nconsole.log('all tests passed');\n",
});
/** ask-split 的项目：要加问候函数的 greet.js */
const SPLIT_FILES = Object.freeze({ 'greet.js': '// Greeting helpers.\n\nmodule.exports = {};\n' });
/** ask-off 的项目：一个入口文件 */
const OFF_FILES = Object.freeze({ 'app.js': "console.log('fs-real ask-off');\n" });

/** 发给 Mori 的消息（英文：Agent 的段与工具说明都是英文） */
const PROMPTS = Object.freeze({
  limits: 'The test in this project fails (npm test). Have executor fix it by changing only sum.js; no other file may '
    + 'change. Then have reviewer review the fix by reading sum.js and test.js: the review task must not change any '
    + 'file or run any command.',
  split: 'Add a function greet(name) to greet.js that returns a short greeting for name, and export it. The wording of '
    + 'the greeting is my decision: executor must not choose it, but hand the task off as need_user with two or three '
    + 'wording options and the one it recommends, then finish greet.js once I have answered. Do not ask me anything '
    + 'before executor does.',
  off: 'I want to add a small settings file to this project and have not decided its format yet: JSON, YAML or TOML. '
    + 'Before anything else, ask me which format to use and say which one you recommend. Do not create or change any '
    + 'file; after my answer, reply with one sentence on what you would do.',
  offNamed: 'I want to add a small settings file to this project and have not decided its format yet: JSON, YAML or '
    + 'TOML. Before anything else, ask me with the ask_user_question tool which format to use, with your '
    + 'recommendation. Do not create or change any file; after my answer, reply with one sentence on what you would '
    + 'do.',
});

/** @brief 分开的配置（同 tb-helpers SPLIT_ROLES 的座位）：chat 持有对话，planner 持有立项与结案，加上做 task 的角色。 */
const splitRoles = (extra) => [
  { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'] },
  { name: 'planner', description: 'Decides how to split each request into tasks and closes it',
    seats: ['create', 'close'] },
  ...extra,
];

/**
 * @brief team-limits 的角色：executor 改代码、跑命令；reviewer 的 models 是第二个提供商（两个真实模型都用到，同 tb-real），
 *        正文让它先跑 npm test：review task 被写成 write: false 时，这就是一次该被收窄拒绝的调用。
 */
function limitsRoles(ctx) {
  return splitRoles([
    { name: 'executor', description: 'Changes code and runs commands to finish a task',
      body: 'You are the executor. Make the smallest change that finishes the task, run the project tests, then call '
        + 'task_handoff with the numbers of the tool results that show it works.' },
    { name: 'reviewer', description: 'Reviews the change of another role and reports pass or fail',
      models: [ctx.found.second.id],
      body: 'You are the reviewer. First run npm test to see where things stand, then read the change and the test, '
        + 'and call task_handoff with pass or fail and the numbers of the tool results you checked.' },
  ]);
}

/** ask-split 的角色：executor 遇到该你拿主意的地方用 need_user 交接，带选项与推荐项 */
const ASK_ROLES = splitRoles([
  { name: 'executor', description: 'Changes code to finish a task',
    body: 'You are the executor. Make the smallest change that finishes the task. When a choice in the task belongs '
      + 'to the user, do not make it: call task_handoff with outcome need_user, the question, two to four short '
      + 'options and the option you recommend.' },
]);

// ---------- 步骤 ----------

/**
 * fs-real.mjs 的步骤：team-limits 的编号带 FS-21（它的量法与 FS-67 共用一次运行，--only FS-21 也跑它；前提不满足只记
 * FS-67）；ask-split 用很短的 MORI_AWAY_TIMEOUT_MS 启动（startReal 设 When you’re away 为 60s）。
 */
export const TEAM_STEPS = Object.freeze([
  { name: 'team-limits', ids: ['FS-67', 'FS-21'], run: (ctx) => teamLimits(ctx), start: {},
    timeoutMs: ATTEMPTS * LIMITS_MS + MARGIN_MS },
  { name: 'ask-off', ids: ['FS-93', 'FS-114'], run: (ctx) => askOff(ctx), start: {},
    timeoutMs: ATTEMPTS * OFF_MS + MARGIN_MS },
  { name: 'ask-split', ids: ['FS-93', 'FS-114'], run: (ctx) => askSplit(ctx), start: { awayMs: AWAY_MS },
    timeoutMs: ATTEMPTS * SPLIT_MS + MARGIN_MS },
]);

// ---------- 小工具 ----------

/** @brief 空白归一。 */
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
/** @brief 正则里按字面匹配的写法。 */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** @brief 整句相同（不分大小写：拒绝原文里的路径按磁盘上的写法）。 */
const looseExact = (text) => new RegExp(`^${escapeRe(text)}$`, 'i');
/** @brief 前提没满足的原因加一个分号，接在 note 前面。 */
const notesText = (notes) => (notes.length ? `${notes.join('; ')}; ` : '');
/** @brief 会话的说法：<种类>/<角色> <task>。 */
const label = (session) => `${session.kind}${session.role ? `/${session.role}` : ''}`
  + `${session.task ? ` ${session.task}` : ''}`;
/** @brief 会话条目里某个角色的消息的文字，按顺序。 */
const textsOf = (entries, role) => entries.filter((entry) => entry.type === 'message' && entry.message?.role === role)
  .map((entry) => contentText(entry.message.content));
/** @brief 会话条目里时刻 t 之后写下的某个角色的消息的文字（空的不要）。 */
const textsAfter = (entries, role, t) => entries.filter((entry) => entry.type === 'message'
  && entry.message?.role === role && Date.parse(entry.timestamp ?? '') >= t)
  .map((entry) => contentText(entry.message.content)).filter(Boolean);

/** @brief 每个（种类/角色）的请求发给了哪些提供商、状态如何（同 tb-real.mjs，写进 note）。 */
function modelsUsed(requests) {
  const out = {};
  for (const r of requests) {
    const key = `${r.info.kind}/${r.info.role}`;
    out[key] = [...new Set([...(out[key] ?? []), `${r.provider}:${r.status}`])];
  }
  return out;
}

/** @brief 这个会话这次运行的请求用到的模型（记录代理记下的请求，按工作路径筛）。 */
const usedBy = (ctx, who) => modelsUsed(chatRequests(ctx.proxy, { since: who.since, cwd: who.cwd }));

// ---------- 会话与协作的驱动 ----------

/** @brief 测试准备（synthetic）：新的临时项目（newRealProject：授权公网），roles 给出时写角色文件；返回项目文件夹。 */
async function teamProject(ctx, name, { files, repo = false, roles = [] }) {
  const made = await newRealProject(ctx, name, { files, repo });
  if (roles.length) writeRoles(made.project, roles);
  return made.project;
}

/** @brief 读 board.json；还没有、或正在写读不完整时为 null。 */
function boardOf(ctx, who) {
  try {
    return who.sessionId ? readBoard(ctx, who.sessionId) : null;
  } catch {
    // 正在写的文件下一次再读
    return null;
  }
}

/** @brief 需求都到了终态（board 里至少一个需求，且都不是 open）。 */
const requestsEnded = (board) => Boolean(board?.requests?.length) && board.requests.every((r) => r.status !== 'open');

/**
 * @brief 发 text（sendFs，不等出卡），补上会话的 id、会话文件与工作路径（侧栏行晚一点才有会话文件时多等一会儿，最多
 *        30 秒；仍没有时抛错，withAttempts 重启后重跑），记下 since（发送的时刻）与 project。
 * @return who
 */
async function sendFirst(ctx, who, project, text) {
  const { since } = await sendFs(ctx, who, text, { wait: false });
  const filled = await poll(async () => (await fillSession(ctx, who)).sessionFile, 30000, 500);
  if (!filled || !who.sessionId) throw new Error(`the session in ${who.tab} has no session file after the message`);
  return Object.assign(who, { since, project });
}

/**
 * @brief 在项目里开一个新会话，协作开关点到 always（之后每次运行都是协作模式），mode 为 full 时切到 Full access，给出
 *        files 时先采一次项目文件，再发 text（sendFirst）。
 * @return 会话（openFsSession 的结果，另有 since（发送的时刻）、project）
 */
async function openTeam(ctx, project, { text, mode = 'ask', files = null }) {
  const who = await openFsSession(ctx, project);
  await clickTeamSwitch(ctx, who.tab, 'always');
  if (mode === 'full') await setPermission(ctx, who.tab, 'full');
  if (files) sampleFiles(project, files);
  return sendFirst(ctx, who, project, text);
}

/** @brief 这个会话那一栏里新出现的批准卡（对话的或后台的）：记下（{ request, tool, agent, task, t }），点 Allow once。 */
async function allowCards(ctx, who, cards) {
  for (const card of await approvalCardsOf(ctx, who.tab).catch(() => [])) {
    if (cards.some((item) => item.request === card.request)) continue;
    cards.push({ request: card.request, tool: card.tool, agent: card.agent, task: card.task, t: Date.now() });
    await ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"][data-request="${attr(card.request)}"] `
      + '[data-testid="approval-allow"]').click({ timeout: 5000 }).catch(() => {});
  }
}

/** @brief 用户会话与整个协作此刻空闲（同 tb-real.mjs：TeamState.busy 为假，对话不在运行、准备、生成、发送）。 */
async function teamIdle(ctx, who) {
  const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
  const pane = await paneState(ctx.page, who.tab).catch(() => null);
  return Boolean(info && !info.team?.busy && !info.live?.running && !info.live?.preparing && pane && !pane.running
    && !pane.sending);
}

/** @brief Stop team（session.stopTeam）：驱动到时限还没停下时用，之后核对读到的是停下来的样子；成功为 true。 */
const stopTeam = (ctx, who) => bridge(ctx, { type: 'session.stopTeam', sessionId: who.sessionId })
  .then(() => true, () => false);

/** @brief 新出现的提问卡交给 onAsk（返回它的结果，'stop' 表示不再等）；没有新卡时为 null。 */
async function nextAsk(ctx, who, run, onAsk) {
  const card = await askCardOf(ctx, who.tab).catch(() => null);
  if (!card || run.asks.includes(card.request)) return null;
  run.asks.push(card.request);
  return onAsk(card);
}

/**
 * @brief 跟着协作跑到结束：每半秒点掉新出现的批准卡（allowCards）、采一次项目文件（files 给出时）、把新出现的提问卡交给
 *        onAsk；需求都到终态后连续空闲 3 秒、或还有开着的需求但连续空闲 1 分钟、或到 limit 为止。没停在空闲时
 *        Stop team。
 * @return { cards, asks（看到的提问卡的请求 id）, ended, settled（停在空闲）, stopped, ms }
 */
async function followTeam(ctx, who, { limit, files = null, onAsk }) {
  const run = { cards: [], asks: [], ended: false, settled: false, stopped: false, ms: 0 };
  let calm = null;
  while (Date.now() - who.since < limit) {
    await allowCards(ctx, who, run.cards);
    if (files) sampleFiles(who.project, files);
    if ((await nextAsk(ctx, who, run, onAsk)) === 'stop') break;
    run.ended = requestsEnded(boardOf(ctx, who));
    calm = (await teamIdle(ctx, who)) ? calm ?? Date.now() : null;
    if (calm !== null && Date.now() - calm > (run.ended ? ENDED_CALM_MS : OPEN_CALM_MS)) {
      run.settled = true;
      break;
    }
    await sleep(500);
  }
  if (!run.settled) run.stopped = await stopTeam(ctx, who);
  run.ms = Date.now() - who.since;
  return run;
}

/** @brief 这张提问卡的 mori.question_request（{ t, requestId, toolCallId, questions, askedAt }）；5 秒内没有时为 null。 */
const questionRequest = (ctx, who, requestId) => poll(async () => (await eventsOfType(ctx, who.sessionId,
  'mori.question_request', who.since)).find((item) => item.requestId === requestId) ?? null, 5000, 150);

/**
 * @brief 在看得到的提问卡上每个问题点一项（picks[i] 为第 i 个问题的 label），再点 Submit，等这张卡的 mori.question_end。
 * @return mori.question_end（{ t, requestId, toolCallId, by, answers }）；15 秒内没有时为 null
 */
async function submitPicks(ctx, who, request, picks) {
  const card = `${paneSel(who.tab)} [data-testid="ask-card"]`;
  for (const [index, label] of picks.entries()) {
    await ctx.page.locator(`${card} [data-testid="ask-question"][data-index="${index}"] `
      + `[data-testid="ask-option"][data-label="${attr(label)}"] input`).click({ timeout: 5000 });
  }
  await ctx.page.locator(`${card} [data-testid="ask-submit"]`).click({ timeout: 5000 });
  return waitEvent(ctx, who.sessionId, 'mori.question_end', (item) => item.requestId === request.requestId,
    { since: who.since, timeout: 15000 });
}

/** @brief 驱动没打算回答的提问卡：按推荐项提交，让运行接着走，写一条说明。 */
async function answerRecommended(ctx, who, card, where) {
  const request = await questionRequest(ctx, who, card.request);
  if (!request) return null;
  await submitPicks(ctx, who, request, request.questions.map((q) => q.recommended)).catch(() => null);
  ctx.note(`${where}: the agent also asked ${card.request} (${briefSafe(request.questions.map((q) => q.question),
    300)}); the test answered it with the recommended options`);
  return null;
}

/**
 * @brief 这次运行在用户会话信封上的事件（从发送起；收在 take 里，重启之后也能核对）：批准请求（对话的与后台的）、
 *        mori.tool_gate、mori.snapshot_stage、mori.away_decision，每项 { t, ...载荷 }。
 */
async function eventsOfRun(ctx, who) {
  const of = (type) => eventsOfType(ctx, who.sessionId, type, who.since).catch(() => []);
  return { approvals: [...await of('mori.approval_request'), ...await of('mori.team_approval_request')],
    gates: await of('mori.tool_gate'), stages: await of('mori.snapshot_stage'),
    decisions: await of('mori.away_decision') };
}

// ---------- 会话文件：调用与结果 ----------

/** @brief 一条助手消息里的工具调用记进 calls（按 toolCallId）。 */
function addCalls(calls, message, { t, team }) {
  const parts = Array.isArray(message.content) ? message.content : [];
  for (const part of parts.filter((item) => item?.type === 'toolCall')) {
    calls.set(part.id, { id: part.id, name: part.name, args: part.arguments ?? {}, tCall: t, tRes: null,
      isError: null, text: null, team });
  }
}

/**
 * @brief 一个会话里的工具调用与它们的结果（按顺序）：[{ id, name, args, tCall（发出调用的助手消息写下的时刻）, tRes（结果
 *        写下的时刻；没有结果时 null）, isError, text（结果的文字；没有结果时 null）, team（调用时协作模式开着：按会话里的
 *        mori.team 条目，还没有条目时按 teamDefault） }]。
 */
function callsIn(entries, teamDefault) {
  const calls = new Map();
  let mode = teamDefault ? 'always' : 'off';
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'mori.team') mode = entry.data?.mode ?? mode;
    const message = entry.type === 'message' ? entry.message : null;
    const t = Date.parse(entry.timestamp ?? '') || null;
    if (message?.role === 'assistant') addCalls(calls, message, { t, team: mode !== 'off' });
    if (message?.role === 'toolResult' && calls.has(message.toolCallId)) {
      Object.assign(calls.get(message.toolCallId), { tRes: t, isError: message.isError === true,
        text: contentText(message.content) });
    }
  }
  return [...calls.values()];
}

/**
 * @brief 用户会话与它的全部实例会话：[{ kind（user，或实例的 mori.instance 条目里的 create / close / task / ask /
 *        subscription）, role, task, file, entries, calls }]，用户会话在最前。用户会话里还没有 mori.team 条目时按协作模式
 *        算（驱动在发第一条消息之前已把开关点到 always）。
 */
function teamSessions(ctx, who) {
  const user = { kind: 'user', role: null, task: null, file: who.sessionFile, entries: readJsonl(who.sessionFile) };
  const instances = instanceFiles(ctx, who.sessionId).map((inst) => ({ kind: inst.first?.data?.kind ?? 'unknown',
    role: inst.first?.data?.role ?? null, task: inst.first?.data?.task ?? null, file: inst.file,
    entries: inst.entries }));
  return [user, ...instances].map((session) => ({ ...session, calls: callsIn(session.entries,
    session.kind === 'user') }));
}

// ---------- §8.2 的 limits 归一（独立实现，核对 board.json） ----------

/** @brief 参数名的归一（同 shared/team.ts 的 keyForm：不分大小写，不看 _ 与 -）。 */
const keyForm = (key) => key.toLowerCase().replace(/[_-]/g, '');
/** limits 的四个键：归一后的写法 → schema 里的名字 */
const LIMIT_KEYS = Object.freeze({ write: 'write', commands: 'commands', mcp: 'mcp', writepaths: 'write_paths' });

/** @brief 参数对象里名为 name 的值（原名优先，再按 keyForm 找）；没有或为 null 时 undefined。 */
function argNamed(args, name) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const key = Object.hasOwn(args, name) ? name : Object.keys(args).find((item) => keyForm(item) === keyForm(name));
  return key === undefined || args[key] === null ? undefined : args[key];
}

/** @brief §8.2 第 1 步：limits 里的键名归一、丢掉未知的键与值为 null 的键。 */
function limitsInput(raw) {
  const out = {};
  for (const name of Object.values(LIMIT_KEYS)) {
    const value = argNamed(raw, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** @brief 路径按段比较用的写法（同 pathGate.ts segmentKey：去掉流名、末尾的 . 与空格，不分大小写）。 */
const segKeys = (path) => String(path).split(/[\\/]+/).filter(Boolean)
  .map((segment) => segment.split(':')[0].replace(/[. ]+$/, '').toLowerCase());
/** @brief prefix 的段是 keys 的开头（含相等）。 */
const startsWithKeys = (keys, prefix) => prefix.length <= keys.length && prefix.every((key, i) => keys[i] === key);

/**
 * @brief §8.2 第 4 步的一项：去掉首尾空白；以盘符、\、/、~ 开头，出界，等于工作路径的不合格（原因原文同 §14）；合格的
 *        写成相对工作路径、/ 分隔、末尾 / 的形式。
 * @return { path } 或 { error }
 */
function writePathOf(raw, cwd) {
  const text = raw.trim();
  const fail = (problem) => ({ error: `limits.write_paths: "${text}" ${problem}` });
  if (/^([A-Za-z]:|[\\/~])/.test(text)) return fail('must be relative to the working directory.');
  const rel = win32.relative(cwd, win32.resolve(cwd, text));
  if (rel === '..' || rel.startsWith('..\\') || win32.isAbsolute(rel)) return fail('is outside the working directory.');
  if (rel === '') return fail('is the whole working directory; leave write_paths out.');
  return { path: `${rel.split(/[\\/]+/).join('/')}/` };
}

/** @brief 去重、去掉被另一项包含的项（有 src/ 时去掉 src/a/；相同的留先出现的写法）。 */
function keepNarrowest(paths) {
  const keys = paths.map(segKeys);
  return paths.filter((_, i) => !keys.some((other, j) => j !== i && startsWithKeys(keys[i], other)
    && (other.length < keys[i].length || j < i)));
}

/**
 * @brief §8.2 第 1、3、4 步：true 与不写相同、不存；write: false 时去掉 commands 与 write_paths；write_paths 每项按
 *        writePathOf，第一项不合格就是整次的原因；合格的去重、去掉被包含的项。
 * @param raw task_create 参数里的 limits（没写时 undefined）
 * @return { limits } 或 { error }
 */
function normalizeLimits(raw, cwd) {
  const input = limitsInput(raw);
  const limits = {};
  if (input.write === false) limits.write = false;
  if (input.commands === false && limits.write === undefined) limits.commands = false;
  if (input.mcp === false) limits.mcp = false;
  if (limits.write === false || !Array.isArray(input.write_paths)) return { limits };
  const paths = [];
  for (const item of input.write_paths.filter((value) => typeof value === 'string')) {
    const one = writePathOf(item, cwd);
    if (one.error) return { error: one.error };
    paths.push(one.path);
  }
  if (paths.length) limits.writePaths = keepNarrowest(paths);
  return { limits };
}

/** @brief 比较用的写法：三项的值、writePaths 排好序（§8.2 不定先后）、存了哪些键。 */
const limitsKey = (limits) => JSON.stringify([limits?.write ?? null, limits?.commands ?? null, limits?.mcp ?? null,
  limits?.writePaths ? [...limits.writePaths].sort() : null, Object.keys(limits ?? {}).sort()]);

/** @brief 建出的 task 在 board.json 里的 limits 等于归一的结果；§8.2 本该拒绝时也算问题。 */
function storedProblem(board, id, want) {
  const task = board?.tasks.find((item) => item.id === id);
  if (!task) return `${id} is not in board.json`;
  if (want.error) return `${id} was created although §8.2 refuses its limits: ${want.error}`;
  return limitsKey(task.limits) === limitsKey(want.limits) ? null
    : `${id} has the limits ${JSON.stringify(task.limits)}, want ${JSON.stringify(want.limits)}`;
}

/** @brief 没建出 task 的调用：被 limits 拒绝时原因的第一行等于 §8.2 的原因；§8.2 不收的 limits 不能以别的原因放过。 */
function refusedProblem(call, want) {
  const first = String(call.text).split('\n')[0];
  if (first.startsWith('limits.')) {
    if (want.error === first) return null;
    return `refused with "${first}", want ${want.error ? `"${want.error}"` : 'no limits error'}`;
  }
  if (want.error && call.isError && !first.startsWith(PI_INVALID)) {
    return `refused with "${first}", want "${want.error}"`;
  }
  return null;
}

/**
 * @brief 每个有结果的 task_create 调用（所有会话里）：建出的 task（结果 "Created T<n> for …"）在 board.json 里的 limits
 *        等于 normalizeLimits 的结果；被拒绝的按 refusedProblem；board.json 里每个 task 都找得到建它的调用。
 * @return { problems, written（每个调用：谁写的、建出的 task、模型写的 limits 原样，写进 note） }
 */
function createdProblems(sessions, board, cwd) {
  const out = { problems: [], written: [] };
  const seen = new Set();
  for (const session of sessions) {
    for (const call of session.calls.filter((item) => item.name === 'task_create' && item.text !== null)) {
      const raw = argNamed(call.args, 'limits');
      const want = normalizeLimits(raw, cwd);
      const task = /^Created (T\d+) for /.exec(call.text)?.[1] ?? null;
      out.written.push({ by: label(session), task, limits: raw ?? null });
      if (task) seen.add(task);
      const problem = task ? storedProblem(board, task, want) : refusedProblem(call, want);
      if (problem) out.problems.push(`${label(session)} task_create ${call.id}: ${problem}`);
    }
  }
  for (const task of board?.tasks ?? []) {
    if (!seen.has(task.id)) out.problems.push(`no task_create call with a result created ${task.id}`);
  }
  return out;
}

// ---------- §8.3、§8.4 的收窄（独立实现，核对工具结果） ----------

/**
 * @brief 这个会话在这次调用时受的收窄（§8.3）：{ lead（拒绝原文的开头；对话会话为 null，用整句 RELAY_ONLY）, limits }；
 *        不收窄时为 null。task 实例按 board.json 里它的 task 的 limits。
 */
function narrowingOf(session, board, call) {
  if (session.kind === 'user') return call.team ? { lead: null, limits: { write: false, mcp: false } } : null;
  if (session.kind === 'task') {
    const limits = board?.tasks.find((task) => task.id === session.task)?.limits ?? {};
    return Object.keys(limits).length ? { lead: LEADS.task, limits } : null;
  }
  return LEADS[session.kind] ? { lead: LEADS[session.kind], limits: { write: false } } : null;
}

/**
 * @brief 调用参数里的路径在工作路径里时的相对写法（/ 分隔）；不是平常的写法（~、/ 开头、file:）、在外面或就是工作路径
 *        时为 null（这些由 pi 的规则解析，测试不重做）。
 */
function insideRel(raw, cwd) {
  const text = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
  if (!text || !(/^[A-Za-z]:[\\/]/.test(text) || !/^([\\/~]|file:)/i.test(text))) return null;
  const rel = win32.relative(cwd, win32.resolve(cwd, text));
  if (rel === '' || rel === '..' || rel.startsWith('..\\') || win32.isAbsolute(rel)) return null;
  return rel.split(/[\\/]+/).join('/');
}

/**
 * @brief 有 writePaths 时 edit、write、命令应得的结论（§8.4 第 5、6 条）：命令的目标要靠 §7 的分析，只核对原文的形状；
 *        edit、write 的目标在 .work/ 或某一项里时不拒绝，否则原文写出它的相对路径。
 */
function pathExpectation(narrowing, call, cwd) {
  const head = `${narrowing.lead}: writes are limited to ${narrowing.limits.writePaths.join(', ')} and .work/`;
  const either = new RegExp(`^${escapeRe(head)}(, and Mori can’t tell where this writes|; .+ is outside them)\\.$`,
    'i');
  if (COMMAND_TOOLS.includes(call.name)) return { match: either };
  if (typeof call.args.path !== 'string' || !call.args.path.trim()) {
    return { deny: `${head}, and Mori can’t tell where this writes.` };
  }
  const rel = insideRel(call.args.path, cwd);
  if (rel === null) return { match: either };
  const keys = segKeys(rel);
  if (keys[0] === '.work' || narrowing.limits.writePaths.some((path) => startsWithKeys(keys, segKeys(path)))) {
    return { allow: true };
  }
  return { match: looseExact(`${head}; ${rel} is outside them.`) };
}

/**
 * @brief 按 §8.4 的表，这个调用在这个收窄下应得的结论：{ allow } 不该被收窄拒绝；{ deny: 原文 } 必须被拒绝且原文相同；
 *        { match: 正则 } 被拒绝时原文要符合它（拒不拒要靠测试不重做的分析，或临时提问可能还带 mcp: false）。
 *        只读会话（write: false，对话以外）的命令不被 write: false 收窄（2026-10-28 负责人定照 Claude 的做法，§8.11），
 *        改文件为 no file changes；对话会话的 write: false 照旧拒绝命令（RELAY_ONLY）。
 */
function expectedFor(narrowing, call, cwd) {
  if (!narrowing || READ_TOOLS.includes(call.name) || DUTY_TOOLS.includes(call.name)) return { allow: true };
  const say = (rule) => (narrowing.lead === null ? RELAY_ONLY : `${narrowing.lead}: ${rule}.`);
  const { limits } = narrowing;
  const file = FILE_TOOLS.includes(call.name);
  const command = COMMAND_TOOLS.includes(call.name);
  if (limits.write === false && (file || (command && narrowing.lead === null))) return { deny: say('no file changes') };
  if (limits.commands === false && command) return { deny: say('no commands') };
  if (!file && !command) {
    if (limits.mcp === false) return { deny: say('no MCP or extension tools') };
    return narrowing.lead === LEADS.ask ? { match: looseExact(say('no MCP or extension tools')) } : { allow: true };
  }
  return limits.writePaths?.length ? pathExpectation(narrowing, call, cwd) : { allow: true };
}

/** @brief 工具结果是不是收窄的拒绝原文（§8.3 的五个开头之一，或整句 RELAY_ONLY）。 */
const isNarrowing = (text) => typeof text === 'string' && (text === RELAY_ONLY
  || Object.values(LEADS).some((lead) => text.startsWith(`${lead}: `)));

/**
 * @brief 一个调用的结果与应得的结论对不对：被收窄拒绝的原文要符合；该被拒绝的不能成功（结果是错误的，可能先被别的
 *        检查拒绝，例如 pi 的参数校验、交接之后的拒绝，不算）。
 * @return 问题的一句话；没有问题时为 null
 */
function callProblem(call, expected) {
  if (isNarrowing(call.text)) {
    if (expected.allow) return `refused by narrowing although its limits allow it: "${call.text}"`;
    if (expected.deny !== undefined && call.text !== expected.deny) return `"${call.text}", want "${expected.deny}"`;
    if (expected.match && !expected.match.test(call.text)) return `"${call.text}" does not match ${expected.match}`;
    return null;
  }
  if (expected.deny === undefined || call.isError) return null;
  return `succeeded although its narrowing refuses it ("${expected.deny}")`;
}

/**
 * @brief 全部会话里有结果的调用按 callProblem 核对；被收窄拒绝的调用收进 narrowed，它们不能有批准请求（§8.2：拒绝
 *        不出卡）。
 * @param approvals 这次运行的批准请求（mori.approval_request 与 mori.team_approval_request 的载荷）
 * @return { narrowed: [{ session, call }], problems }
 */
function narrowingProblems(sessions, board, cwd, approvals) {
  const asked = new Set(approvals.map((item) => item.toolCallId));
  const out = { narrowed: [], problems: [] };
  for (const session of sessions) {
    for (const call of session.calls.filter((item) => item.text !== null)) {
      const problem = callProblem(call, expectedFor(narrowingOf(session, board, call), call, cwd));
      if (problem) out.problems.push(`${label(session)} ${call.name} ${call.id}: ${problem}`);
      if (!isNarrowing(call.text)) continue;
      out.narrowed.push({ session, call });
      if (asked.has(call.id)) {
        out.problems.push(`${label(session)} ${call.name} ${call.id}: refused by narrowing but it got an approval `
          + 'request');
      }
    }
  }
  return out;
}

/**
 * @brief 对话会话在协作模式下的写入与命令调用（pi 校验参数失败的不算：它们到不了路径闸）都得到 RELAY_ONLY、是错误、
 *        没有批准请求（同 tb-real.mjs TB-45 的核对）。
 * @return { tried（这些调用）, problems }
 */
function dialogProblems(sessions, approvals) {
  const asked = new Set(approvals.map((item) => item.toolCallId));
  const tried = sessions[0].calls.filter((call) => call.team && [...FILE_TOOLS, ...COMMAND_TOOLS].includes(call.name)
    && call.text !== null && !call.text.startsWith(PI_INVALID));
  const problems = tried.filter((call) => !call.isError || call.text !== RELAY_ONLY || asked.has(call.id))
    .map((call) => `${call.name} ${call.id}: ${call.isError ? 'error' : 'succeeded'} "${call.text.slice(0, 160)}"`
      + `${asked.has(call.id) ? ', with an approval request' : ''}`);
  return { tried, problems };
}

// ---------- 项目文件的散列历史（被拒绝的调用的目标文件不变） ----------

/** @brief 新的历史：samples（每次采样的时刻）、changes（小写的相对路径 → [{ t, hash }]，只记变化；hash 为 null 是不在）。 */
const newHistory = () => ({ samples: [], changes: new Map() });

/** @brief 项目里的文件（相对路径，/ 分隔），跳过 SKIP_DIRS，最多 SAMPLE_MAX 个。 */
function listFiles(root, dir = root, out = []) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    // 目录刚被删掉：这一次不看它
    return out;
  }
  for (const name of names) {
    if (out.length >= SAMPLE_MAX) break;
    const path = join(dir, name);
    let stat = null;
    try {
      stat = statSync(path);
    } catch {
      // 文件刚被删掉
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name.toLowerCase())) listFiles(root, path, out);
    } else {
      out.push(win32.relative(root, path).split(/[\\/]+/).join('/'));
    }
  }
  return out;
}

/** @brief 文件内容的散列；读不出（正在写、被占用）时为 undefined，这一次不记。 */
function hashOf(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    // 正在写或被占用：这一次不记
    return undefined;
  }
}

/** @brief 记下一个文件在 t 时的散列（和上一次相同时不记）。 */
function remember(files, key, t, hash) {
  const list = files.changes.get(key) ?? [];
  if (list.length === 0 || list.at(-1).hash !== hash) list.push({ t, hash });
  files.changes.set(key, list);
}

/** @brief 采一次项目文件：每个文件的散列，之前见过、这次不在的记为 null。 */
function sampleFiles(project, files) {
  const t = Date.now();
  const now = new Map(listFiles(project).map((rel) => [rel.toLowerCase(), hashOf(join(project, rel))]));
  for (const [key, hash] of now) {
    if (hash !== undefined) remember(files, key, t, hash);
  }
  for (const key of files.changes.keys()) {
    if (!now.has(key)) remember(files, key, t, null);
  }
  files.samples.push(t);
}

/** @brief 采样里这个文件在时刻 t 的散列（那之前没见过时为 null：不在）。 */
const stateAt = (files, key, t) => (files.changes.get(key) ?? []).findLast((item) => item.t <= t)?.hash ?? null;

/**
 * @brief 一个被拒绝的 edit、write 的目标：调用之前最后一次采样与结果之后第一次采样相同为不变（null）；变了时，这期间
 *        有别的会话的写入或命令成功执行就算说不准（unsure，写进 note），没有就是问题。
 * @param all 全部会话的调用（{ session, call }）
 * @return null 或 { kind: 'problems' | 'unsure', text }
 */
function targetVerdict(files, key, call, all) {
  const from = files.samples.findLast((t) => t <= call.tCall) ?? files.samples[0] ?? 0;
  const to = files.samples.find((t) => t >= (call.tRes ?? Infinity) + AFTER_MS) ?? null;
  if (to === null) return { kind: 'unsure', text: 'no sample after the refused call' };
  if (stateAt(files, key, from) === stateAt(files, key, to)) return null;
  const busy = all.filter(({ call: other }) => other !== call && other.text !== null && !other.isError
    && [...FILE_TOOLS, ...COMMAND_TOOLS].includes(other.name) && other.tCall <= to && (other.tRes ?? to) >= from);
  if (busy.length === 0) {
    return { kind: 'problems', text: 'the file changed across the refused call while no other write or command ran' };
  }
  return { kind: 'unsure', text: `the file changed while ${busy.map(({ session, call: other }) => `${label(session)} `
    + `${other.name}`).join(', ')} also ran` };
}

/**
 * @brief 被收窄拒绝的 edit、write 的目标文件没有因它改变（targetVerdict）。目标不在工作路径里、写法不平常、在不采样的
 *        目录里时不核对（skipped，写进 note）。
 * @return { checked, problems, unsure, skipped }
 */
function targetChecks(narrowed, sessions, files, cwd) {
  const all = sessions.flatMap((session) => session.calls.map((call) => ({ session, call })));
  const out = { checked: 0, problems: [], unsure: [], skipped: [] };
  for (const { session, call } of narrowed.filter((item) => FILE_TOOLS.includes(item.call.name))) {
    const rel = insideRel(call.args.path, cwd);
    const where = `${label(session)} ${call.name} ${rel ?? String(call.args.path)}`;
    if (rel === null || segKeys(rel).some((key) => SKIP_DIRS.has(key))) {
      out.skipped.push(`${where}: not sampled`);
      continue;
    }
    out.checked += 1;
    const verdict = targetVerdict(files, rel.toLowerCase(), call, all);
    if (verdict) out[verdict.kind].push(`${where}: ${verdict.text}`);
  }
  return out;
}

// ---------- FS-21：协作模式下的快照 ----------

/** @brief 内部仓库里 refs/mori 下的 ref 数与不同的提交数；仓库不在或读不出时为 null 并写原因。 */
function refCommits(ctx, cwd) {
  if (!existsSync(internalRepo(ctx, cwd))) return { refs: null, commits: null, error: 'no internal repository' };
  const out = repoGit(ctx, cwd, ['for-each-ref', '--format=%(objectname)', 'refs/mori']);
  if (out.code !== 0) return { refs: null, commits: null, error: out.stderr.trim().slice(0, 300) };
  const oids = out.stdout.split(/\r?\n/).filter(Boolean);
  return { refs: oids.length, commits: new Set(oids).size, error: null };
}

/** @brief 等 refs/mori 下的 ref 连续 REFS_STEADY_MS 不变（最多 REFS_WAIT_MS），返回那时的 refCommits。 */
async function settledCommits(ctx, cwd) {
  const start = Date.now();
  let last = refCommits(ctx, cwd);
  let steady = Date.now();
  while (Date.now() - start < REFS_WAIT_MS && Date.now() - steady < REFS_STEADY_MS) {
    await sleep(500);
    const now = refCommits(ctx, cwd);
    if (now.refs !== last.refs || now.commits !== last.commits) steady = Date.now();
    last = now;
  }
  return last;
}

/** @brief 内部仓库的大小（KiB，git count-objects -v 的 size 加 size-pack）；读不出时为 null。 */
function repoSize(ctx, cwd) {
  if (!existsSync(internalRepo(ctx, cwd))) return null;
  const out = repoGit(ctx, cwd, ['count-objects', '-v']);
  if (out.code !== 0) return null;
  const kib = (name) => Number(new RegExp(`^${name}: (\\d+)$`, 'm').exec(out.stdout)?.[1] ?? 0);
  return kib('size') + kib('size-pack');
}

/** @brief mori.snapshot_stage 的区间（active 为真到下一个为假）：{ count, ms（总时长）, longest }。 */
function stageSpans(stages) {
  let open = null;
  const spans = [];
  for (const item of [...stages].sort((a, b) => a.t - b.t)) {
    if (item.active && open === null) open = item.t;
    if (!item.active && open !== null) {
      spans.push(item.t - open);
      open = null;
    }
  }
  return { count: spans.length, ms: spans.reduce((sum, ms) => sum + ms, 0), longest: Math.max(0, ...spans) };
}

/**
 * @brief FS-21 协作模式的量法（与 FS-67 共用一次运行，§19.2）：这个工作路径的内部仓库里 refs/mori 下的 ref 数与不同的
 *        提交数、内部仓库的大小，用户会话的快照阶段（mori.snapshot_stage）的次数与总时长，会话文件里一轮的改动与运行记录
 *        的条数，协作跑了多久。
 */
async function teamSnapshotFigures(ctx, take) {
  const { who, events, run } = take;
  const commits = await settledCommits(ctx, who.cwd);
  const stages = stageSpans(events?.stages ?? []);
  return { measured: commits.refs !== null, step: 'team-limits', cwd: who.cwd,
    internalRepo: internalRepo(ctx, who.cwd), refs: commits.refs, commits: commits.commits, error: commits.error,
    sizeKiB: repoSize(ctx, who.cwd), userRunSnapshots: stages.count, userRunSnapshotMs: stages.ms,
    longestSnapshotMs: stages.longest, turnChanges: changesOf(who.sessionFile).length,
    runRecords: runsOf(who.sessionFile).length, teamMs: run?.ms ?? null, how: SNAPSHOT_HOW };
}

/**
 * @brief 记 FS-21 那条检查的步骤取协作模式的数字：team-limits 写下的 ctx.fs21Team；它还没跑（排在后面、--only 没选它）
 *        或没拿到会话时，说明原因。
 * @return 放进 FS-21 检查 detail 的对象
 */
export function fs21TeamDetail(ctx) {
  return ctx.fs21Team ?? { measured: false, why: 'the team-limits step (FS-67) did not run before this check' };
}

// ---------- team-limits（FS-67、FS-21） ----------

/**
 * @brief 一次尝试：新项目（git 仓库，npm test 失败）、分开的角色，协作开关 always、Ask each time，发 PROMPTS.limits，
 *        跟着协作跑完（批准卡 Allow once；意外的提问卡按推荐项回答），驱动时每半秒采一次项目文件。
 * @return { who, files, run, events, unmet（立项一个 task 都没建时的原因） }
 */
async function limitsOnce(ctx) {
  const project = await teamProject(ctx, 'team-limits', { files: LIMITS_FILES, repo: true, roles: limitsRoles(ctx) });
  const files = newHistory();
  const who = await openTeam(ctx, project, { text: PROMPTS.limits, files });
  const run = await followTeam(ctx, who, { limit: LIMITS_MS, files,
    onAsk: (card) => answerRecommended(ctx, who, card, 'team-limits') });
  await sleep(1000);
  sampleFiles(project, files);
  const events = await eventsOfRun(ctx, who);
  const tasks = boardOf(ctx, who)?.tasks?.length ?? 0;
  return { who, files, run, events, unmet: tasks ? null : 'the create agent created no task' };
}

/** @brief team-limits 的 note：前提没满足的原因，加上模型写的 limits、被拒绝的调用、需求与 task、用到的模型。 */
function limitsNote(ctx, { take, board, created, narrowing, targets, notes }) {
  const { who, run } = take;
  return `${notesText(notes)}model: ${briefSafe({
    limits: created.written, refused: narrowing.narrowed.map(({ session, call }) => `${label(session)} ${call.name}: `
      + `${call.text}`), unsure: targets.unsure, notSampled: targets.skipped,
    requests: board?.requests.map((r) => [r.no, r.status]),
    tasks: board?.tasks.map((t) => [t.id, t.assignee, t.status, t.limits]), cards: run.cards.length,
    asks: run.asks.length, settled: run.settled, stopped: run.stopped, ms: run.ms, used: usedBy(ctx, who),
  }, 3000)}`;
}

/** @brief FS-67 的四条检查（名字以编号开头；模型写了什么、拒绝了什么都在 note 里）。 */
function recordLimits(ctx, { created, narrowing, targets, dialog, note }) {
  ctx.record('FS-67 real team-limits: the limits of every task_create call are stored in board.json as §8.2 '
    + 'normalizes them (true and missing items dropped, write: false drops commands and write_paths, write_paths '
    + 'relative, / separated, ending in /, deduplicated, contained items dropped); limits §8.2 refuses give its '
    + `reason and create no task (${created.written.length} calls)`, created.problems.length === 0,
  briefSafe(created.problems), note);
  ctx.record('FS-67 real team-limits: every call refused by narrowing has the §8.4 text of its session ("<lead>: '
    + '<rule>.", RELAY_ONLY for the dialog) and no approval request, and no call its narrowing forbids succeeded '
    + `(${narrowing.narrowed.length} refused)`, narrowing.problems.length === 0, briefSafe(narrowing.problems), note);
  ctx.record('FS-67 real team-limits: the target file of every refused edit or write is unchanged by it (project '
    + `files hashed every half second while the team ran; ${targets.checked} checked)`, targets.problems.length === 0,
  briefSafe({ problems: targets.problems, unsure: targets.unsure }), note);
  ctx.record('FS-67 real team-limits: in team mode every write or command call of the dialog session gets '
    + `"${RELAY_ONLY}" and none succeeds or gets an approval request (${dialog.tried.length} calls)`,
  dialog.problems.length === 0, briefSafe(dialog.problems), note);
}

/**
 * @brief 核对 team-limits 的最后一次尝试（读会话文件、board.json 与收下的事件）。
 */
function limitsChecks(ctx, take, notes) {
  const { who, files, events } = take;
  const board = boardOf(ctx, who);
  const sessions = teamSessions(ctx, who);
  const created = createdProblems(sessions, board, who.cwd);
  const narrowing = narrowingProblems(sessions, board, who.cwd, events.approvals);
  const targets = targetChecks(narrowing.narrowed, sessions, files, who.cwd);
  const dialog = dialogProblems(sessions, events.approvals);
  const note = limitsNote(ctx, { take, board, created, narrowing, targets, notes });
  recordLimits(ctx, { created, narrowing, targets, dialog, note });
}

/**
 * @brief 场景 team-limits（FS-67，与 FS-21 协作模式的量法共用这次运行）：驱动（limitsOnce，前提没满足时重跑，最多
 *        ATTEMPTS 次），核对最后一次（limitsChecks），量内部仓库与快照阶段放进 ctx.fs21Team 并写一条整次运行的说明。
 */
export async function teamLimits(ctx) {
  const drive = { name: 'team-limits', ids: ['FS-67'], start: {} };
  const { take, notes } = await withAttempts(ctx, drive, () => limitsOnce(ctx));
  if (!take.who?.sessionFile) {
    ctx.fs21Team = { measured: false, step: 'team-limits', why: 'the team-limits drive did not get a session' };
    return;
  }
  await shotReal(ctx, 'team-limits-end');
  limitsChecks(ctx, take, notes);
  ctx.fs21Team = await teamSnapshotFigures(ctx, take);
  ctx.note(`FS-21 team mode (step team-limits, the run of FS-67): ${briefSafe(ctx.fs21Team, 1500)}`);
}

// ---------- 提问卡（FS-93、FS-114） ----------

/** @brief 每个问题选第一个不是推荐项的选项（只有推荐项时选它）：工具结果里看得出是卡上提交的选择。 */
const otherPick = (question) => question.options.find((option) => option.label !== question.recommended)?.label
  ?? question.recommended;

/** @brief 每个问题的推荐项都是它的选项之一（§10.2；不合格的调用报错、不出卡）。 */
const validRecommended = (request) => Boolean(request?.questions?.length) && request.questions
  .every((q) => q.options.some((option) => option.label === q.recommended));

/** @brief 卡上一个问题与调用的那一项对不对（fs-question.md “卡出现”：header、问题、选项、Recommended、没有预选、Other）。 */
function questionProblems(shown, asked, index) {
  if (!shown) return [`question ${index + 1} is not on the card`];
  const out = [];
  if (squash(shown.header) !== squash(asked.header)) out.push(`header "${shown.header}"`);
  if (squash(shown.text) !== squash(asked.question)) out.push(`question "${shown.text}"`);
  if (!same(shown.options.map((o) => o.label), asked.options.map((o) => o.label))) {
    out.push(`labels ${JSON.stringify(shown.options.map((o) => o.label))}`);
  }
  const marked = shown.options.filter((o) => o.recommended || o.recText).map((o) => o.label);
  const rec = shown.options.find((o) => o.label === asked.recommended);
  if (!same(marked, [asked.recommended]) || rec?.recText !== ' (Recommended)') {
    out.push(`recommended marks ${JSON.stringify(marked)}`);
  }
  if (shown.options.some((o) => o.checked) || shown.other?.checked) out.push('something is preselected');
  if (shown.order.at(-1) !== 'Other') out.push('Other is not last');
  return out.map((text) => `question ${index + 1}: ${text}`);
}

/** @brief 卡（askCardOf）与它的 mori.question_request 对得上：同一个请求、问题按顺序、每个问题 questionProblems。 */
function cardProblems(card, request) {
  if (!card || !request) return ['no question card or no mori.question_request for it'];
  const problems = card.request === request.requestId ? [] : [`card ${card.request} is not ${request.requestId}`];
  if (card.questions.length !== request.questions.length) problems.push(`${card.questions.length} questions shown`);
  request.questions.forEach((question, i) => problems.push(...questionProblems(card.questions[i], question, i)));
  return problems;
}

/** @brief 提问调用免批准（§10.1）：它的 mori.tool_gate 都是 free，没有批准请求。 */
function askGateProblems(events, request) {
  const gates = events.gates.filter((item) => item.toolCallId === request.toolCallId).map((item) => item.gate);
  const asked = events.approvals.filter((item) => item.toolCallId === request.toolCallId);
  const problems = gates.length && gates.every((gate) => gate === 'free') ? []
    : [`mori.tool_gate ${JSON.stringify(gates)}`];
  return asked.length ? [...problems, `${asked.length} approval request(s) for the call`] : problems;
}

/** @brief answers 是每个问题恰好选了 picks 里那一项（other 为 null，auto 为给的值），问题与 header 原样。 */
function answersAre(answers, request, picks, auto) {
  return Array.isArray(answers) && answers.length === request.questions.length
    && request.questions.every((q, i) => answers[i]?.question === q.question && answers[i]?.header === q.header
      && same(answers[i]?.selected, [picks[i]]) && answers[i]?.other === null && answers[i]?.auto === auto);
}

// ---------- ask-off（FS-93、FS-114，关闭模式） ----------

/** @brief 这个会话面板此刻安静：不在生成、发送，没有阶段行，没有批准卡、提问卡、扩展询问卡。 */
const quietNow = (ctx, who) => ctx.page.evaluate((selector) => {
  const pane = document.querySelector(selector);
  return Boolean(pane) && pane.dataset.running === 'false' && pane.dataset.sending === 'false'
    && !pane.querySelector('[data-testid="stage"], [data-testid="approval-card"], [data-testid="ask-card"], '
      + '[data-testid="ext-ui-card"]');
}, paneSel(who.tab)).catch(() => false);

/**
 * @brief 关闭模式的会话：每 300 毫秒点掉新出现的批准卡（Allow once：临时项目，synthetic），新出现的提问卡交给 onAsk
 *        （返回真值时连同卡一起返回）；面板连续 OFF_CALM_MS 安静时返回 null；超过 OFF_MS 抛错。
 * @param watch { cards（记下的批准卡）, seen（看过的提问卡的请求 id）, onAsk }
 */
async function watchOff(ctx, who, { cards, seen, onAsk }) {
  const deadline = Date.now() + OFF_MS;
  let calm = null;
  while (Date.now() < deadline) {
    await allowCards(ctx, who, cards);
    const card = await askCardOf(ctx, who.tab).catch(() => null);
    if (card && !seen.has(card.request)) {
      seen.add(card.request);
      if (await onAsk(card)) return card;
    }
    calm = (await quietNow(ctx, who)) ? calm ?? Date.now() : null;
    if (calm !== null && Date.now() - calm >= OFF_CALM_MS) return null;
    await sleep(300);
  }
  throw new Error(`session ${who.tab} did not finish its reply within ${OFF_MS / 60000} min`);
}

/**
 * @brief 一次尝试：新项目、关闭模式的新会话，发 PROMPTS.off（重跑时 offNamed，点名工具），等提问卡；每个问题选一个不是
 *        推荐项的选项提交，再等回复结束（之后的提问卡按推荐项回答）。
 * @return { who, named, cards, card, request, picks, end, events, unmet（没出提问卡时的原因） }
 */
async function askOffOnce(ctx, attempt) {
  const project = await teamProject(ctx, 'ask-off', { files: OFF_FILES });
  const named = attempt > 1;
  const who = await sendFirst(ctx, await openFsSession(ctx, project), project,
    named ? PROMPTS.offNamed : PROMPTS.off);
  const watch = { cards: [], seen: new Set(), onAsk: async () => true };
  const card = await watchOff(ctx, who, watch);
  if (!card) return { who, named, cards: watch.cards, unmet: 'the main agent did not call ask_user_question' };
  const request = await questionRequest(ctx, who, card.request);
  await shotReal(ctx, 'ask-off-card');
  const picks = request ? request.questions.map(otherPick) : [];
  const end = request ? await submitPicks(ctx, who, request, picks) : null;
  await watchOff(ctx, who, { ...watch, onAsk: (more) => answerRecommended(ctx, who, more, 'ask-off') });
  return { who, named, cards: watch.cards, card, request, picks, end, events: await eventsOfRun(ctx, who),
    unmet: null };
}

/** @brief ask-off 的 note：前提没满足的原因，加上消息是否点名工具、模型的问题、报错的提问调用、最后的回复、用到的模型。 */
function offNote(ctx, take, notes) {
  const { who } = take;
  const entries = readJsonl(who.sessionFile);
  const invalid = callsIn(entries, false).filter((call) => call.name === 'ask_user_question' && call.isError)
    .map((call) => call.text);
  return `${notesText(notes)}model: ${briefSafe({ toolNamed: take.named, questions: take.request?.questions ?? null,
    picks: take.picks, invalidAsks: invalid, approvalCards: take.cards.length,
    reply: textsOf(entries, 'assistant').filter(Boolean).at(-1) ?? null, used: usedBy(ctx, who) }, 2500)}`;
}

/** @brief 核对 ask-off：推荐项合法（FS-93）；卡与免批准、提交后的结束事件与工具结果原文（FS-114）。 */
function askOffChecks(ctx, take, notes) {
  const { who, request, card, picks, end, events } = take;
  const note = offNote(ctx, take, notes);
  ctx.record('FS-93 real ask-off: in off mode, asked to choose the format of a settings file, the main agent called '
    + 'ask_user_question and the recommended option of every question is one of its option labels',
  validRecommended(request), briefSafe(request?.questions ?? null, 1200), note);
  const shown = [...cardProblems(card, request), ...(request ? askGateProblems(events, request) : [])];
  ctx.record('FS-114 real ask-off: the question card shows the call\'s questions in order (header, question, option '
    + 'labels, " (Recommended)" after the recommended label only, nothing preselected, Other last) and the call '
    + 'needs no approval (mori.tool_gate free, no approval request)', shown.length === 0, briefSafe(shown), note);
  const result = resultEntries(who.sessionFile).find((item) => item.id === request?.toolCallId) ?? null;
  const want = request ? answeredText(request.questions.map((q, i) => [q.question, picks[i]])) : null;
  const answered = Boolean(request) && end?.by === 'user' && answersAre(end.answers, request, picks, false)
    && result !== null && !result.isError && result.text === want;
  ctx.record('FS-114 real ask-off: after Submit with one option per question, mori.question_end is by user with '
    + 'those answers and the tool result is the §14 text "User has answered your questions: …" (not an error)',
  answered, briefSafe({ by: end?.by ?? null, answers: end?.answers ?? null, result, want }), note);
}

/**
 * @brief 场景 ask-off（FS-93 关闭模式的一半，FS-114 的关闭模式提问）：驱动（askOffOnce，前提没满足时重跑，最多
 *        ATTEMPTS 次），满足时核对最后一次（askOffChecks）。
 */
export async function askOff(ctx) {
  const drive = { name: 'ask-off', ids: ['FS-93', 'FS-114'], start: {} };
  const { take, notes, ok } = await withAttempts(ctx, drive, (attempt) => askOffOnce(ctx, attempt));
  if (ok) askOffChecks(ctx, take, notes);
}

// ---------- ask-split（FS-93、FS-114，协作模式分开时） ----------

/** @brief board.json 里最近一次带选项与推荐项的 need_user 交接（{ task, ...交接 }）；没有时为 null。 */
function optionsHandoff(board) {
  const all = (board?.tasks ?? []).flatMap((task) => task.handoffs.filter((h) => h.outcome === 'need_user'
    && Array.isArray(h.options) && h.options.length >= 2 && h.recommended).map((h) => ({ task: task.id, ...h })));
  return all.sort((a, b) => a.at - b.at).at(-1) ?? null;
}

/** @brief 卡上推荐项等于交接的推荐项的那个问题（去掉首尾空白比较）；没有时为 null。 */
const matchingQuestion = (request, handoff) => (handoff ? request?.questions
  .find((q) => q.recommended.trim() === handoff.recommended.trim()) ?? null : null);

/** @brief 写进检查的交接：task、谁交的、问题、选项、推荐项。 */
const handoffBrief = (h) => (h ? { task: h.task, from: h.from, question: h.conclusion, options: h.options,
  recommended: h.recommended } : null);

/**
 * @brief 对话 Agent 的提问卡：第一张是要等的那张：记下卡、它的请求与这时的交接，截图；卡上的推荐项与交接的不一致时
 *        'stop'（前提没满足）；一致时窗口失焦，等到时按推荐项回答（mori.question_end），再拿回焦点。之后的提问卡按推荐项
 *        提交（写进说明）。
 */
async function awayAsk(ctx, who, card, ask) {
  if (ask.card) {
    ask.extra.push(card.request);
    return answerRecommended(ctx, who, card, 'ask-split');
  }
  Object.assign(ask, { card, request: await questionRequest(ctx, who, card.request),
    handoff: optionsHandoff(boardOf(ctx, who)), at: Date.now() });
  await shotReal(ctx, 'ask-split-card');
  if (!matchingQuestion(ask.request, ask.handoff)) return 'stop';
  await blurWindow(ctx);
  ask.end = await waitEvent(ctx, who.sessionId, 'mori.question_end', (item) => item.requestId === card.request,
    { since: who.since, timeout: AWAY_MS + 60000 });
  await focusWindow(ctx);
  return ask.end ? null : 'stop';
}

/** @brief ask-split 的前提（模型的行为）没满足的原因；满足时为 null。 */
function splitUnmet(ask, board) {
  if (!ask.card) {
    return optionsHandoff(board) ? 'a need_user handoff carries options, but the dialog agent did not ask with a '
      + 'question card' : 'no need_user handoff with options and no question card';
  }
  if (!ask.request) return null;
  if (!ask.handoff) {
    const plain = (board?.tasks ?? []).some((task) => task.handoffs.some((h) => h.outcome === 'need_user'));
    return plain ? 'the need_user handoff carries no options and recommendation'
      : 'the dialog agent asked before any need_user handoff';
  }
  if (matchingQuestion(ask.request, ask.handoff)) return null;
  return `the card's recommended options ${JSON.stringify(ask.request.questions.map((q) => q.recommended))} are not `
    + `the handoff's "${ask.handoff.recommended}"`;
}

/**
 * @brief 一次尝试：新项目（greet.js）与角色，装上窗口焦点的替身（有焦点），协作开关 always、Full access，发
 *        PROMPTS.split，跟着协作跑完；第一张提问卡交给 awayAsk。
 * @return { who, run, ask, events, unmet }
 */
async function askSplitOnce(ctx) {
  await installFocus(ctx);
  const project = await teamProject(ctx, 'ask-split', { files: SPLIT_FILES, roles: ASK_ROLES });
  const who = await openTeam(ctx, project, { text: PROMPTS.split, mode: 'full' });
  const ask = { card: null, request: null, handoff: null, end: null, extra: [] };
  const run = await followTeam(ctx, who, { limit: SPLIT_MS, onAsk: (card) => awayAsk(ctx, who, card, ask) });
  await focusWindow(ctx).catch(() => {});
  const events = await eventsOfRun(ctx, who);
  return { who, run, ask, events, unmet: splitUnmet(ask, boardOf(ctx, who)) };
}

/**
 * @brief 交接的选项行到了哪里（§10.8、§14）：立项的 create_need_user 投递里有 "Options from <角色>: …. Recommended: …."
 *        一行；对话的 ask_user 投递含 "Options from …" 那一句，或 relay 投递里有 "For T<n>: options from …" 一行。
 * @return { create（立项收到了）, dialog（'ask_user' | 'relay' | null）, lines }
 */
function choicesTold(sessions, handoff) {
  const choices = `${handoff.options.join('; ')}. Recommended: ${handoff.recommended}.`;
  const lines = { create: `Options from ${handoff.from}: ${choices}`,
    askUser: `Options from ${handoff.from}: ${choices} ${ASK_WITH_CHOICES}`,
    relay: `For ${handoff.task}: options from ${handoff.from}: ${choices} ${ASK_WITH_CHOICES}` };
  const create = sessions.some((s) => s.kind === 'create' && textsOf(s.entries, 'user')
    .some((text) => text.split('\n').includes(lines.create)));
  const told = textsOf(sessions[0].entries, 'user');
  let dialog = null;
  if (told.some((text) => text.includes(lines.askUser))) dialog = 'ask_user';
  else if (told.some((text) => text.split('\n').includes(lines.relay))) dialog = 'relay';
  return { create, dialog, lines };
}

/** @brief 这次提问的自动处理记录：事件与会话条目各恰好一条，提问、按推荐项、当时的时长、答案是推荐项（§9.7）。 */
function decisionProblems(events, file, request, timeout) {
  const live = events.decisions.map((item) => item.decision).filter((d) => d?.requestId === request.requestId);
  const saved = awayRecords(file).filter((d) => d?.requestId === request.requestId);
  const problems = [];
  if (live.length !== 1) problems.push(`${live.length} mori.away_decision events`);
  if (saved.length !== 1) problems.push(`${saved.length} mori.away_decision entries`);
  const picks = request.questions.map((q) => q.recommended);
  for (const d of [...live, ...saved]) {
    const fields = d.kind === 'question' && d.result === 'recommended' && d.toolName === 'ask_user_question'
      && d.toolCallId === request.toolCallId && d.agent === null && d.timeout === timeout;
    if (!fields || !answersAre(d.answers, request, picks, true)) problems.push(`record ${JSON.stringify(d)}`);
  }
  return problems;
}

/** @brief ask-split 的 note：前提没满足的原因，加上交接、模型的问题、最后的回复有没有提到推荐项、需求与 task、模型。 */
function splitNote(ctx, take, { sessions, told, notes }) {
  const { who, ask, run } = take;
  const board = boardOf(ctx, who);
  const after = ask.end ? textsAfter(sessions[0].entries, 'assistant', ask.end.t) : [];
  const mentions = after.some((text) => /recommend|away|didn.t answer|did not answer/i.test(text));
  return `${notesText(notes)}model: ${briefSafe({ handoff: handoffBrief(ask.handoff), dialogToldBy: told.dialog,
    questions: ask.request?.questions ?? null, finalReplyMentionsTheRecommendation: mentions,
    finalReply: after.at(-1) ?? null, reminders: reminderEntries(who.sessionFile).length, extraAsks: ask.extra,
    requests: board?.requests.map((r) => [r.no, r.status]), tasks: board?.tasks.map((t) => [t.id, t.assignee,
      t.status]), settled: run.settled, stopped: run.stopped, ms: run.ms, used: usedBy(ctx, who) }, 3000)}`;
}

/** @brief FS-93 你不在时的那一半与 FS-114 的工具结果：按推荐项结束、转给立项带说明；工具结果原文与自动处理记录。 */
function awayChecks(ctx, take, { sessions, note }) {
  const { who, ask, events } = take;
  const { request, end } = ask;
  const picks = request.questions.map((q) => q.recommended);
  const forward = forwardText(request.questions.map((q) => `"${q.question}"="${q.recommended}"${NOT_USER_CHOICE}`));
  const forwarded = sessions.some((s) => s.kind === 'create' && textsOf(s.entries, 'user')
    .some((text) => text.includes(forward)));
  ctx.record('FS-93 real ask-split: while the window is away the question ends by away with each question\'s '
    + 'recommended option (auto), and the answer goes to the create agent as a user message marked "(not the '
    + 'user\'s choice: they were away, so the recommended option was used)"', end?.by === 'away'
    && answersAre(end.answers, request, picks, true) && forwarded,
  briefSafe({ by: end?.by ?? null, answers: end?.answers ?? null, forwarded, forward }), note);
  const result = resultEntries(who.sessionFile).find((item) => item.id === request.toolCallId) ?? null;
  const duration = DURATION[ctx.awayTimeout];
  const want = awayAnswerText(duration, request.questions.map((q) => [q.question, q.recommended]));
  const decision = decisionProblems(events, who.sessionFile, request, ctx.awayTimeout);
  ctx.record(`FS-114 real ask-split: the tool result is the §14 away text ("The user was away and didn’t answer within `
    + `${duration}, so your recommended options were used: …", not an error), and one mori.away_decision event and `
    + 'one session entry record it (question, recommended, the auto answers)', result !== null && !result.isError
    && result.text === want && decision.length === 0, briefSafe({ result, want, decision }), note);
}

/** @brief 核对 ask-split：选项行到了立项与对话（FS-93）；卡与免批准（FS-114）；你不在时的结果（awayChecks）。 */
function askSplitChecks(ctx, take, notes) {
  const { who, ask, events } = take;
  const sessions = teamSessions(ctx, who);
  if (!ask.request) {
    for (const id of ['FS-93', 'FS-114']) {
      ctx.record(`${id} real ask-split: the dialog agent's question card has its mori.question_request`, false,
        briefSafe({ card: ask.card }));
    }
    return;
  }
  const told = choicesTold(sessions, ask.handoff);
  const note = splitNote(ctx, take, { sessions, told, notes });
  ctx.record('FS-93 real ask-split: the options and recommendation of the need_user handoff reach the create agent '
    + '("Options from <role>: …. Recommended: ….") and the dialog agent (ask_user or relay: "… '
    + `${ASK_WITH_CHOICES}"), and the dialog agent asked with a question card whose recommended option is the `
    + 'handoff\'s', told.create && told.dialog !== null && matchingQuestion(ask.request, ask.handoff) !== null,
  briefSafe({ handoff: handoffBrief(ask.handoff), told }), note);
  const shown = [...cardProblems(ask.card, ask.request), ...askGateProblems(events, ask.request)];
  ctx.record('FS-114 real ask-split: in split team mode the dialog agent\'s question card is in the user session\'s '
    + 'pane and shows the call\'s questions in order (" (Recommended)" after each recommended label only, nothing '
    + 'preselected, Other last), and the call needs no approval (mori.tool_gate free, no approval request)',
  shown.length === 0, briefSafe(shown), note);
  awayChecks(ctx, take, { sessions, note });
}

/**
 * @brief 场景 ask-split（FS-93 协作模式分开时的一半，FS-114 的分开时提问）：用很短的 MORI_AWAY_TIMEOUT_MS 启动（步骤的
 *        start），驱动（askSplitOnce，前提没满足时重跑，最多 ATTEMPTS 次），满足时核对最后一次（askSplitChecks）。
 */
export async function askSplit(ctx) {
  const drive = { name: 'ask-split', ids: ['FS-93', 'FS-114'], start: { awayMs: AWAY_MS } };
  const { take, notes, ok } = await withAttempts(ctx, drive, () => askSplitOnce(ctx));
  if (ok) askSplitChecks(ctx, take, notes);
}
