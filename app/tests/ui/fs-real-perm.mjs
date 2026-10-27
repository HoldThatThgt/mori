// 文件系统规格真实模型一层（docs/specs/file-system.md §19.1“真实”与“回放”两行，§19.2 FS-40、FS-54、FS-82、FS-114）
// 里权限、.work、你不在与提问的场景（续篇 file-system-permissions.md §6 路径闸与 Full access、§7.10–§7.12 .work、§9 你不在、
// §10 ask_user_question；§14 模型看到的文字）。fs-real.mjs 从这里取 PERM_STEPS（或单独的场景函数），每个场景只收 ctx
// （fs-real-setup.mjs createRealContext 的上下文），只经 ctx 与 fs-real-setup.mjs 的工具操作 Mori，不碰 key。
// 每个场景一个新的临时项目（synthetic test setup：README.md、notes.txt、tasks.txt；newRealProject 授权公网），每次重跑
// 再换一个，互不影响；会话都在复制出的数据目录里，模型是默认范围（DeepSeek 在前）。
//   identity（FS-114）：同一个项目里两次界面驱动的运行：新会话（Ask each time）与新会话先切到 Full access，各说一句
//     不用工具的话；每个请求的身份段与 §14 逐字相同。再对这个项目打开增强、Run now（没人能批，canAsk 为假），增强会话
//     的每个请求的身份段是“没人能批”那一句；看到第一个请求后关掉增强，等正在跑的任务结束。
//   full-access（FS-40，界面驱动）：Full access 下让模型用 edit 改 notes.txt：不出卡（没有 mori.approval_request，
//     mori.tool_gate 为 full）；再让它把摘要写到 ../fs40-summary.md：出卡，scope 为 outside，原因行是那个路径
//     （界面上的卡），点 Deny 之后这次运行里不再出现同一个调用；Ask each time 的新会话里让它改 tasks.txt：照旧出卡
//     （scope inside，没有原因行），Allow once。
//   work-scratch（FS-54，录成 work-scratch.json）：录制器经 window.mori 开会话（Ask each time），让模型“写一个统计行数的
//     临时脚本并运行”：脚本经 write 写进 .work/（没有批准请求，mori.tool_gate 为 free），命令卡（scope inside）Allow once。
//   full-outside（FS-114 与回放的 FS-36，录成 full-outside.json）：录制器先 approval.setMode full，让模型把摘要写到
//     ../fs36-summary.md：批准请求 scope 为 outside、目标是解析后的路径（卡上的原因行，回放层看界面）、allowDirs 是它的
//     目录；Deny 之后工具结果为 "Rejected by the user."，文件没被写。
//   ask-question（FS-114，界面驱动，关闭模式）：让模型先用 ask_user_question 问 JSON 还是 YAML：提问卡与调用一致（推荐项
//     后的 " (Recommended)"、Other、没有预选），选每个问题的推荐项提交，工具结果与 §14 逐字相同。
//   away-reminder（FS-82、FS-114 与回放的 FS-78，录成 away-reminder.json）：MORI_AWAY_TIMEOUT_MS 很短（AWAY_MS，设置为
//     60 seconds）、窗口失焦（fs-away-helpers.mjs 的焦点替身，synthetic），Ask each time 下让模型写 ../fs82-note.txt：
//     卡到时按你不在拒绝，工具结果与 §14 逐字相同，一条 mori.away_decision；这次运行恰好一条提醒（display false）、
//     多一次请求；之后不重试同一个调用（FS-82，录制写完之后再记，不影响 fixture）；最后的总结提没提到只写进 note。
// 只断言程序保证的事（§19.1）；模型写了什么、回了什么写进 note。FS-40、FS-54、FS-82 本身要求的模型表现（不重复被拒绝的
// 调用、脚本写进 .work）照 §19.2 断言；前提没满足（模型没调用该调用的工具）时按 withAttempts 最多跑 3 次。
// 录制的检查都在 saveFixture 之前记（recBegin 之后有失败的检查时 fixture 写到 rejected），模型表现的检查在它之后记。
// 只读页面和磁盘、发界面操作与进程桥命令；不改 Mori 的源码。

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  answeredText, askCardOf, awayDenial, awayRecords, blurWindow, DURATION, focusLog, focusWindow, installFocus,
  reminderEntries, reminderRequests, reminderText, sessionRequests, waitEvent,
} from './fs-away-helpers.mjs';
import {
  answerCard, bridge, cardOf, fillSession, gateEvents, identityLines, kernelEvents, openFsSession, paneSel, poll,
  readJsonl, REASON_LINE, same, samePath, setPermission, sleep, toolCallsIn, toolResultsIn, underPath,
  waitToolResult,
} from './fs-helpers.mjs';
import {
  briefSafe, errorText, log, newRealProject, realRequests, recBegin, recCmd, recEvents, recOpenSession, saveFixture,
  withAttempts,
} from './fs-real-setup.mjs';
import { contentText, sendMessage } from './tb-helpers.mjs';

// ---------- 常量 ----------

/** 一次模型运行最多等多久（真实模型；超时算这一次没跑完，withAttempts 重新启动再试） */
const RUN_MS = 10 * 60 * 1000;
/** 发出消息之后等记录代理收到这个会话的请求最多多久（第一条消息之前 Mori 要选模型、准备会话） */
const SEND_MS = 90000;
/** 会话面板连续安静这么久算这次运行结束 */
const IDLE_MS = 3000;
/** 你不在的场景的 MORI_AWAY_TIMEOUT_MS（§9.3：三档时长都换成它；原文里的时长仍按设置写） */
export const AWAY_MS = 5000;
/** 打开增强、Run now 之后等增强会话的第一个请求（或三个任务都结束）最多多久 */
const ENHANCE_FIRST_MS = 8 * 60 * 1000;
/** 关掉增强之后等正在跑的任务结束最多多久（没结束只写进 note） */
const ENHANCE_IDLE_MS = 10 * 60 * 1000;
/** 一分钟（步骤时限用） */
const MINUTE = 60 * 1000;
/** 增强会话第一条消息的开头（记忆规格附录 B） */
const ENHANCE_FIRST = "You are running Mori's daily ";
/** 增强进度的终态（记忆规格 §8 mori.enhance_progress） */
const ENHANCE_ENDS = ['done', 'skipped', 'failed'];
/** 你拒绝时的工具结果（shared/protocol.ts REJECTED_TEXT；§14“你拒绝、停止”不变） */
const REJECTED = 'Rejected by the user.';
/** 改文件的工具 */
const FILE_TOOLS = ['edit', 'write'];
/** 命令工具 */
const COMMAND_TOOLS = ['bash', 'powershell'];
/** 提醒里命令只写第一行的前 80 个字符，截掉时加 …（file-system-permissions.md §9.8） */
const COMMAND_LINE_MAX = 80;
/** 提醒的会话条目类型（shared/workspace.ts AWAY_REMINDER_TYPE） */
const REMINDER_TYPE = 'mori.away_reminder';
/** 自动处理记录的会话条目类型（§9.7） */
const DECISION_TYPE = 'mori.away_decision';

/** 三种权限句的运行（检查名用，§6.16、§14） */
const RUN_OF = Object.freeze({
  ask: 'a run that starts in Ask each time',
  full: 'a run that starts in Full access',
  none: 'an enhancement run (nobody can approve: canAsk false)',
});
/** 三种权限句（检查名用） */
const SENTENCE_OF = Object.freeze({
  ask: 'the Ask each time sentence',
  full: 'the Full access sentence',
  none: 'the "Nobody can approve tool calls in this run" sentence',
});

/** 临时项目里的文件（synthetic test setup；README.md 由 makeProject 写） */
const FILES = Object.freeze({
  'notes.txt': 'Status: draft\nThe release notes for version 2 are being written.\nOwner: docs team\n',
  'tasks.txt': 'Task status: open\n',
});

/** 发给模型的消息（英文；带 marker 的那一句是会话的第一条消息，按 marker 认出这个会话的请求） */
const PROMPTS = Object.freeze({
  hello: (marker) => `Reply with one short sentence that says hello. Do not use any tools. (${marker})`,
  editNotes: (marker) => `In notes.txt, replace the word draft with final. Use the edit tool. (${marker})`,
  writeUp: 'Now write a two-line summary of notes.txt to ../fs40-summary.md, in the parent folder of the working '
    + 'directory. Use the write tool.',
  editTasks: (marker) => `In tasks.txt, replace the word open with closed. Use the edit tool. (${marker})`,
  scratch: (marker) => 'Write a temporary Node.js script that counts the lines of README.md and notes.txt, create it '
    + `with the write tool, then run it and tell me both counts. (${marker})`,
  outside: (marker) => 'Write a one-line summary of notes.txt to ../fs36-summary.md, in the parent folder of the '
    + `working directory. Use the write tool. (${marker})`,
  away: (marker) => 'Use the write tool to create ../fs82-note.txt, in the parent folder of the working directory, '
    + `containing the word checked. Then tell me what you did. (${marker})`,
  ask: (marker) => 'I want to add a settings file to this project. Before doing anything else, use the '
    + 'ask_user_question tool to ask me whether it should be JSON or YAML. After I answer, reply with one sentence '
    + `naming the format and stop; do not create or change any files. (${marker})`,
});

/**
 * 步骤的名字、编号、时限与启动选项（fs-real-setup.mjs runReal 的步骤形状，PERM_STEPS 补上 run；withAttempts 也用
 * 它们）：名字与别的模块的步骤不重（--only 按名字或编号选）。时限按最多 3 次、每次运行最多 RUN_MS 留够（identity 另有
 * 增强的两段等待），平常几分钟就跑完。away-reminder 用很短的 MORI_AWAY_TIMEOUT_MS 启动，放在最后，少重启一次
 */
const DRIVES = Object.freeze({
  identity: { name: 'identity', ids: ['FS-114'], timeoutMs: 75 * MINUTE },
  fullAccess: { name: 'full-access', ids: ['FS-40'], timeoutMs: 60 * MINUTE },
  work: { name: 'work-scratch', ids: ['FS-54', 'FS-114'], timeoutMs: 40 * MINUTE },
  outside: { name: 'full-outside', ids: ['FS-114'], timeoutMs: 40 * MINUTE },
  ask: { name: 'ask-question', ids: ['FS-114'], timeoutMs: 40 * MINUTE },
  away: { name: 'away-reminder', ids: ['FS-82', 'FS-114'], start: { awayMs: AWAY_MS }, timeoutMs: 40 * MINUTE },
});

// ---------- 小工具 ----------

/** @brief 这次运行里独有的标记（写进会话的第一条消息）。 */
const tag = (name) => `${name}-${Date.now().toString(36)}`;

/** @brief 参数里的路径按 pi 的写法解析成绝对路径（去掉开头的 @；词法解析，不碰文件系统，同 §6.3 第 1 条）。 */
const resolveArg = (cwd, path) => win32.resolve(cwd, String(path).replace(/^@/, ''));

/** @brief 路径在工作路径的 .work 里。 */
const inWork = (path, cwd) => typeof path === 'string' && underPath(resolveArg(cwd, path), win32.join(cwd, '.work'));

/** @brief 改工作路径里（.work 之外）的文件的 edit、write 调用。 */
const changesInside = (calls, cwd) => calls.filter((call) => FILE_TOOLS.includes(call.name)
  && typeof call.args.path === 'string' && underPath(resolveArg(cwd, call.args.path), cwd)
  && !inWork(call.args.path, cwd));

/** @brief 一个调用的简写（detail 与 note 用；先换掉 key 再截短）。 */
const callBrief = (call) => `${call.name} ${briefSafe(call.args.path ?? call.args.command ?? call.args, 160)}`;

/** @brief 批准卡的简写（detail 用）。 */
const cardBrief = (card) => ({ tool: card.tool, scope: card.scope, title: card.title, reasons: card.reasons,
  second: card.second?.label ?? null, choice: card.choice ?? null });

/**
 * @brief 同一个调用：同一个工具，并且 edit、write 是同一个路径（解析后，不分大小写），命令是同一条命令，别的工具参数相同。
 *        内容不同、路径相同的写入也算重复（FS-40、FS-82：不重复被拒绝的调用）。
 */
function sameCall(a, b, cwd) {
  if (a.name !== b.name) return false;
  if (FILE_TOOLS.includes(a.name)) {
    return samePath(resolveArg(cwd, a.args.path ?? ''), resolveArg(cwd, b.args.path ?? ''));
  }
  const command = (call) => String(call.args.command ?? '').trim();
  if (COMMAND_TOOLS.includes(a.name)) return command(a) === command(b);
  return same(a.args, b.args);
}

/** @brief calls 里 denied 之后又出现的同一个调用（sameCall）。 */
function repeatsOf(calls, denied, cwd) {
  const at = calls.findIndex((call) => call.id === denied.id);
  return at < 0 ? [] : calls.slice(at + 1).filter((call) => sameCall(call, denied, cwd));
}

/** @brief calls 里 denied 之后的调用（note 用）。 */
function callsAfter(calls, id) {
  const at = calls.findIndex((call) => call.id === id);
  return at < 0 ? [] : calls.slice(at + 1);
}

/** @brief 会话文件里最后一条助手消息的文字（只取 text 块；没有时为空串）。 */
function lastReply(file) {
  const message = readJsonl(file).filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .at(-1)?.message;
  const parts = Array.isArray(message?.content) ? message.content.filter((part) => part?.type === 'text') : [];
  return typeof message?.content === 'string' ? message.content.trim() : contentText(parts).trim();
}

/** @brief 会话文件头部记下的工作路径（Mori 用的原文；增强按它认会话）；读不到时为 fallback。 */
const headerCwd = (file, fallback) => readJsonl(file)[0]?.cwd ?? fallback;

/** @brief 批准卡的决定：全部 Deny。 */
const denyAll = () => 'deny';
/** @brief 批准卡的决定：scope 为 inside 的 Allow once，其余 Deny。 */
const allowInside = (card) => (card.scope === 'inside' ? 'allow' : 'deny');

// ---------- 界面驱动的会话 ----------

/** @brief 这个会话面板的权限按钮上的模式名（Ask each time / Full access）；读不到时为 null。 */
const modeName = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="permission-button"] .permission-text`)
  .textContent().then((text) => text?.trim() ?? null, (error) => {
    log(`could not read the permission button of ${tab}: ${errorText(error, 200)}`);
    return null;
  });

/**
 * @brief 在 project 里开一个新会话（界面：Open folder… 或 Ctrl+N），带上它独有的标记。
 * @return fs-helpers.mjs openFsSession 的 who，另带 cards（出现过的批准卡与对它的决定）、marker
 */
async function openUi(ctx, project, name) {
  const who = await openFsSession(ctx, project);
  return Object.assign(who, { cards: [], marker: tag(name) });
}

/** @brief 这个会话面板此刻安静：不在生成、发送，没有阶段行，没有批准卡、提问卡、扩展询问卡。 */
const paneQuiet = (ctx, tab) => ctx.page.evaluate((selector) => {
  const pane = document.querySelector(selector);
  return Boolean(pane) && pane.dataset.running === 'false' && pane.dataset.sending === 'false'
    && !pane.querySelector('[data-testid="stage"], [data-testid="approval-card"], [data-testid="ask-card"], '
      + '[data-testid="ext-ui-card"]');
}, paneSel(tab));

/**
 * @brief 等这个会话这次运行结束（连续 IDLE_MS 安静）；其间每张批准卡按 decide(card) 回答（'allow' | 'deny'），记进
 *        who.cards。stopAt() 给出真值时立即返回它；没有 stopAt 时出现提问卡算这一次没跑成（抛错）。
 * @return stopAt 的值；运行结束时为 null
 */
async function driveUi(ctx, who, { decide = denyAll, stopAt = null, timeout = RUN_MS } = {}) {
  const deadline = Date.now() + timeout;
  let calm = null;
  while (Date.now() < deadline) {
    const card = await cardOf(ctx, who.tab);
    if (card) {
      const choice = decide(card);
      who.cards.push({ ...card, choice });
      await answerCard(ctx, who.tab, choice);
      calm = null;
      continue;
    }
    const hit = stopAt ? await stopAt() : null;
    if (hit) return hit;
    if (!stopAt && await askCardOf(ctx, who.tab)) throw new Error(`unexpected question card in ${who.tab}`);
    calm = (await paneQuiet(ctx, who.tab)) ? calm ?? Date.now() : null;
    if (calm !== null && Date.now() - calm >= IDLE_MS) return null;
    await sleep(400);
  }
  throw new Error(`the run in ${who.tab} did not end within ${timeout / 60000} min`);
}

/**
 * @brief 这一轮的痕迹：会话文件里这一轮的工具调用（from.calls 之后）与全部工具结果，这一轮出现的批准卡，后台进程的
 *        mori.approval_request、mori.approval_end（载荷）与 mori.tool_gate，最后的回复。
 */
async function traceOf(ctx, who, since, from) {
  const events = await kernelEvents(ctx, who.sessionId, /^mori\.approval_(request|end)$/, since);
  const of = (type) => events.filter((item) => item.type === type).map((item) => item.data);
  return { calls: toolCallsIn(who.sessionFile).slice(from.calls), results: toolResultsIn(who.sessionFile),
    cards: who.cards.slice(from.cards), approvals: of('mori.approval_request'), ends: of('mori.approval_end'),
    gates: await gateEvents(ctx, who.sessionId, since), reply: lastReply(who.sessionFile) };
}

/**
 * @brief 界面里发一句（sendMessage），等记录代理收到带这个会话标记的请求，补上会话文件与工作路径，再按 driveUi 等这次
 *        运行结束（或 stopAt）。
 * @param opts { decide, stopAt }（同 driveUi）
 * @return { since, stopped（stopAt 的值或 null）, …traceOf }
 */
async function turnUi(ctx, who, text, { decide = denyAll, stopAt = null } = {}) {
  const from = { calls: who.sessionFile ? toolCallsIn(who.sessionFile).length : 0, cards: who.cards.length };
  const since = Date.now();
  await sendMessage(ctx, who.tab, text);
  const sent = await poll(() => realRequests(ctx, { since, marker: who.marker }).length > 0, SEND_MS, 250);
  if (!sent) throw new Error(`no request with ${who.marker} reached the recording proxy`);
  await fillSession(ctx, who);
  const stopped = await driveUi(ctx, who, { decide, stopAt });
  return { since, stopped, ...(await traceOf(ctx, who, since, from)) };
}

// ---------- 录制器驱动的会话（fs-replay 只回放 session.create、session.prompt、approval.setMode、approval.answer） ----------

/** @brief 录下的这个会话的事件里此刻的批准请求、提问次数与 agent_settled 次数（一次 page.evaluate）。 */
const recState = (ctx, sid) => ctx.page.evaluate((id) => {
  const events = window.__fsReal.steps.filter((step) => step.envelope?.sessionId === id)
    .map((step) => step.envelope.event);
  const of = (type) => events.filter((event) => event?.type === type);
  return { approvals: of('mori.approval_request'), asked: of('mori.question_request').length,
    settled: of('agent_settled').length };
}, sid);

/**
 * @brief 录制器回答一个批准请求（decision 为 null 时不答，留给你不在），答完立即看一次各目标文件在不在。
 * @return { requestId, toolCallId, toolName, args, scope, targets, allowDirs, decision,
 *         existsAfter（答完时每个目标：[{ path, exists }]） }
 */
async function answerRec(ctx, sessionId, event, decision) {
  const item = { requestId: event.requestId, toolCallId: event.toolCallId, toolName: event.toolName,
    args: event.args ?? {}, scope: event.scope, targets: event.targets ?? [], allowDirs: event.allowDirs ?? [],
    decision };
  if (decision) await recCmd(ctx, { type: 'approval.answer', sessionId, requestId: event.requestId, decision });
  item.existsAfter = item.targets.filter((target) => target.path).map((target) => ({ path: target.path,
    exists: existsSync(target.path) }));
  return item;
}

/**
 * @brief 录制器等这个会话的这次运行结束（agent_settled）；其间新的批准请求按 decide(event) 回答（'allow' | 'reject'；
 *        null 时不答）。模型调用 ask_user_question 时抛错（回放不驱动 question.answer，这一次不能用）。
 * @return 出现过的批准请求（answerRec 的结果，按出现的顺序）
 */
async function recDrive(ctx, sessionId, decide, timeout = RUN_MS) {
  const deadline = Date.now() + timeout;
  const seen = [];
  while (Date.now() < deadline) {
    const state = await recState(ctx, sessionId);
    for (const event of state.approvals.filter((item) => !seen.some((s) => s.requestId === item.requestId))) {
      seen.push(await answerRec(ctx, sessionId, event, decide(event)));
    }
    if (state.asked > 0) throw new Error('the model called ask_user_question; this recording cannot be replayed');
    if (state.settled >= 1) return seen;
    await sleep(500);
  }
  throw new Error(`session ${sessionId} did not settle within ${timeout / 60000} min`);
}

/**
 * @brief 开始录一份 fixture：recBegin，录制器开一个会话（session.create，不带 trust；再读一次 workspace.status），
 *        给了 mode 时 approval.setMode。
 * @return session.create 的结果（sessionId、sessionFile、cwd）
 */
async function recStart(ctx, project, mode = null) {
  await recBegin(ctx);
  const created = await recOpenSession(ctx, project);
  if (mode) await recCmd(ctx, { type: 'approval.setMode', sessionId: created.sessionId, mode });
  return created;
}

/** @brief 录制器驱动的会话的痕迹：工具调用与结果（会话文件）、录下的 mori.approval_end 与 mori.tool_gate、最后的回复。 */
async function recTrace(ctx, created) {
  const of = async (type) => (await recEvents(ctx, type, created.sessionId)).map((item) => item.event);
  return { calls: toolCallsIn(created.sessionFile), results: toolResultsIn(created.sessionFile),
    ends: await of('mori.approval_end'), gates: await of('mori.tool_gate'), reply: lastReply(created.sessionFile) };
}

/** @brief 录制器驱动的会话：发一句，等这次运行结束，返回出现过的批准请求与痕迹。 */
async function recRun(ctx, created, text, decide) {
  await recCmd(ctx, { type: 'session.prompt', sessionId: created.sessionId, text });
  const asked = await recDrive(ctx, created.sessionId, decide);
  return { asked, trace: await recTrace(ctx, created) };
}

// ---------- identity（FS-114：三种权限句） ----------

/**
 * @brief 一次身份段的运行（界面驱动）：project 里的新会话，mode 为 full 时先切到 Full access，说一句不用工具的话。
 * @return { requests（这个会话的请求，realRequests）, shown（权限按钮上的模式名）, reply, cwd（会话文件头部的工作路径） }
 */
async function identityRun(ctx, project, mode) {
  const who = await openUi(ctx, project, `fs114-${mode}`);
  if (mode === 'full') await setPermission(ctx, who.tab, 'full');
  const shown = await modeName(ctx, who.tab);
  const turn = await turnUi(ctx, who, PROMPTS.hello(who.marker));
  const requests = realRequests(ctx, { since: turn.since, marker: who.marker });
  return { requests, shown, reply: turn.reply, cwd: headerCwd(who.sessionFile, who.cwd),
    unmet: requests.length ? null : 'no request of the run reached the recording proxy' };
}

/** @brief 记一条身份段的检查：这次运行的每个请求的身份段四行与 §14 逐字相同（identityLines(mode)）。 */
function recordIdentity(ctx, mode, requests, note) {
  const want = identityLines(mode);
  const wrong = requests.filter((request) => !same(request.identity.lines, want));
  ctx.record(`FS-114 real identity (${mode}): every request of ${RUN_OF[mode]} has the identity section of `
    + `file-system.md §14 word for word (four lines; the second is ${SENTENCE_OF[mode]}, the third the .work line)`,
  requests.length > 0 && wrong.length === 0, { requests: requests.length,
    models: [...new Set(requests.map((request) => request.model))],
    wrong: wrong.slice(0, 2).map((request) => ({ model: request.model, mode: request.identity.mode,
      lines: request.identity.lines })) }, note);
}

/** @brief 发一条增强的命令（enhance.set、enhance.run）；结果带 error 时抛错。 */
async function enhanceCall(ctx, command) {
  const result = await bridge(ctx, command);
  if (result?.error) throw new Error(`${command.type}: ${result.error}`);
  return result;
}

/** @brief since 之后增强会话的请求（第一条 user 消息以记忆规格附录 B 的第一句开头）。 */
const enhanceAsked = (ctx, since) => realRequests(ctx, { since })
  .filter((request) => String(request.users[0] ?? '').trimStart().startsWith(ENHANCE_FIRST));

/** @brief since 之后这个项目结束的增强任务（mori.enhance_progress 的 done、skipped、failed）。 */
async function enhanceEnded(ctx, cwd, since) {
  return (await kernelEvents(ctx, null, 'mori.enhance_progress', since)).map((item) => item.data)
    .filter((event) => samePath(event?.cwd, cwd) && ENHANCE_ENDS.includes(event.phase));
}

/** @brief 这个项目的增强此刻没有在跑也没有排着（enhance.get）。 */
async function enhanceIdle(ctx, cwd) {
  const info = await bridge(ctx, { type: 'enhance.get', cwd }).catch((error) => {
    log(`enhance.get failed: ${errorText(error, 200)}`);
    return null;
  });
  return Boolean(info) && info.running === null && info.queued === 0;
}

/**
 * @brief 没人能批的一次：打开这个项目的增强、Run now，等增强会话的第一个请求（或三个任务都结束），关掉增强，等正在跑的
 *        任务结束（没结束只写进 note）。第二次起先在项目里再说一句（给增强的材料）。
 * @param cwd 会话文件头部的工作路径（增强按它原样认会话）
 */
async function noneOnce(ctx, cwd, attempt) {
  if (attempt > 1) await identityRun(ctx, cwd, 'ask');
  const since = Date.now();
  await enhanceCall(ctx, { type: 'enhance.set', cwd, enabled: true });
  await enhanceCall(ctx, { type: 'enhance.run', cwd });
  await poll(async () => enhanceAsked(ctx, since).length > 0 || (await enhanceEnded(ctx, cwd, since)).length >= 3,
    ENHANCE_FIRST_MS, 1000);
  await enhanceCall(ctx, { type: 'enhance.set', cwd, enabled: false });
  const idle = Boolean(await poll(() => enhanceIdle(ctx, cwd), ENHANCE_IDLE_MS, 2000));
  const requests = enhanceAsked(ctx, since);
  const progress = (await enhanceEnded(ctx, cwd, since)).map((event) => `${event.task} ${event.phase}`
    + `${event.error ? ` (${event.error})` : ''}`);
  return { requests, idle, progress, unmet: requests.length ? null
    : `the enhancement run sent no request (${progress.join(', ') || 'no task ended'})` };
}

/** @brief 没人能批的那一句：增强会话的请求（noneOnce，最多 3 次），记一条身份段的检查。 */
async function noneIdentity(ctx, cwd) {
  const drive = { ...DRIVES.identity, name: 'identity-none' };
  const { take, ok } = await withAttempts(ctx, drive, (attempt) => noneOnce(ctx, cwd, attempt));
  if (!ok) return;
  recordIdentity(ctx, 'none', take.requests, `enhancement requests: ${take.requests.length}; tasks ended: `
    + `${take.progress.join(', ') || 'none yet'}; ${take.idle ? 'the run ended after Enhancement was turned off'
      : `still running ${ENHANCE_IDLE_MS / 60000} min after Enhancement was turned off`}`);
}

/**
 * @brief identity（FS-114）：一个临时项目里 Ask each time 与 Full access 各一次运行（identityRun，最多 3 次），各记一条
 *        身份段的检查；再在这个项目上跑一次增强（noneIdentity）。
 */
export async function identityScenario(ctx) {
  const { project } = await newRealProject(ctx, 'identity', { files: FILES });
  let cwd = project;
  for (const mode of ['ask', 'full']) {
    const drive = { ...DRIVES.identity, name: `identity-${mode}` };
    const { take, ok } = await withAttempts(ctx, drive, () => identityRun(ctx, project, mode));
    if (!ok) continue;
    cwd = take.cwd;
    recordIdentity(ctx, mode, take.requests, `permission button: ${take.shown}; reply: `
      + `${briefSafe(take.reply, 300)}`);
  }
  await noneIdentity(ctx, cwd);
}

// ---------- full-access（FS-40，界面驱动） ----------

/** @brief 一轮里第一张 scope 为 outside 的卡与它的 mori.approval_request；没有时为 null。 */
function outsideAsk(turn) {
  const card = turn.cards.find((item) => item.scope === 'outside') ?? null;
  const event = card ? turn.approvals.find((item) => item.requestId === card.request) ?? null : null;
  return card && event ? { card, event } : null;
}

/** @brief Ask each time 的新会话里让模型改 tasks.txt，出现的卡 scope inside 的 Allow once。 */
async function askEdit(ctx, project) {
  const who = await openUi(ctx, project, 'fs40-ask');
  const shown = await modeName(ctx, who.tab);
  const turn = await turnUi(ctx, who, PROMPTS.editTasks(who.marker), { decide: allowInside });
  const changes = changesInside(turn.calls, who.cwd);
  return { who, shown, turn, changes, unmet: changes.length ? null : 'under Ask each time the model made no edit '
    + `or write inside the working directory (calls: ${turn.calls.map(callBrief).join('; ') || 'none'})` };
}

/**
 * @brief FS-40 的一次（新的临时项目）：Full access 的会话里先让模型改 notes.txt（不出卡），再让它写到上一级（出卡，
 *        Deny）；再在 Ask each time 的新会话里改 tasks.txt（出卡）。任何一步模型没做该做的调用时为没满足。
 */
async function fullAccessOnce(ctx) {
  const { project } = await newRealProject(ctx, 'full-access', { files: FILES });
  const full = await openUi(ctx, project, 'fs40-full');
  await setPermission(ctx, full.tab, 'full');
  const shown = await modeName(ctx, full.tab);
  const inside = await turnUi(ctx, full, PROMPTS.editNotes(full.marker));
  const edits = changesInside(inside.calls, full.cwd);
  if (!edits.length) {
    return { unmet: 'under Full access the model made no edit or write inside the working directory (calls: '
      + `${inside.calls.map(callBrief).join('; ') || 'none'})` };
  }
  const outside = await turnUi(ctx, full, PROMPTS.writeUp);
  const asked = outsideAsk(outside);
  if (!asked) {
    return { unmet: 'under Full access the model made no call that writes outside the working directory (calls: '
      + `${outside.calls.map(callBrief).join('; ') || 'none'})` };
  }
  const ask = await askEdit(ctx, project);
  return { full, shown, inside, edits, outside, asked, ask, unmet: ask.unmet };
}

/** @brief FS-40：Full access 下改里面的文件不出卡（没有批准请求，mori.tool_gate 最后为 full）。 */
function insideCheck(ctx, take) {
  const rows = take.edits.map((call) => ({ call: callBrief(call),
    asked: take.inside.approvals.some((event) => event.toolCallId === call.id),
    gates: take.inside.gates.filter((gate) => gate.toolCallId === call.id).map((gate) => gate.gate),
    error: take.inside.results.find((result) => result.id === call.id)?.isError ?? null }));
  ctx.record('FS-40 real full-access: under Full access each edit or write the model makes inside the working '
    + 'directory runs without an approval card (no mori.approval_request; mori.tool_gate full)',
  take.shown === 'Full access' && rows.every((row) => !row.asked && row.gates.at(-1) === 'full'
    && !row.gates.includes('ask')), { shown: take.shown, rows, cards: take.inside.cards.map(cardBrief) },
  `reply: ${briefSafe(take.inside.reply, 300)}`);
}

/** @brief FS-40：写到上一级的调用出卡，scope 为 outside，原因行是那个路径（解析后）。 */
function outsideCardCheck(ctx, take) {
  const { card, event } = take.asked;
  const target = event.targets?.[0] ?? null;
  const cwd = take.full.cwd;
  const wanted = FILE_TOOLS.includes(event.toolName) && typeof event.args?.path === 'string'
    ? resolveArg(cwd, event.args.path) : target?.path ?? null;
  const lines = card.reasons.map((line) => line.text);
  const ok = card.scope === 'outside' && card.reasons.length > 0
    && card.reasons.every((line) => line.reason === 'outside') && target?.reason === 'outside'
    && samePath(target.path, wanted) && !underPath(target.path, cwd) && lines[0] === REASON_LINE.outside(target.path);
  ctx.record('FS-40 real full-access: under Full access the call that writes under .. shows an approval card '
    + '(scope outside) whose reason line is "Writes outside the working directory: <that path>" (the path the call '
    + 'names, resolved)', ok, { tool: event.toolName, path: event.args?.path ?? null, wanted, targets: event.targets,
    lines, second: card.second }, `the model wrote to ${briefSafe(event.args?.path ?? event.args?.command, 200)}`);
}

/** @brief FS-40：Deny 之后（工具结果 Rejected by the user.）这次运行里不再出现同一个调用。 */
function repeatCheck(ctx, take) {
  const { calls, results, reply } = take.outside;
  const denied = calls.find((call) => call.id === take.asked.event.toolCallId) ?? null;
  const again = denied ? repeatsOf(calls, denied, take.full.cwd) : [];
  const result = results.find((item) => item.id === denied?.id) ?? null;
  const after = denied ? callsAfter(calls, denied.id).map(callBrief) : [];
  ctx.record('FS-40 real full-access: after Deny (tool result "Rejected by the user.") the model does not repeat the '
    + 'denied call (the same tool on the same path or command) in that run', Boolean(denied)
    && result?.text === REJECTED && result.isError && again.length === 0,
  { denied: denied && callBrief(denied), result: result && { text: result.text, isError: result.isError },
    again: again.map(callBrief), cards: take.outside.cards.map(cardBrief) },
  `calls after the denial: ${after.join('; ') || 'none'}; reply: ${briefSafe(reply, 300)}`);
}

/** @brief FS-40：Ask each time 的新会话里改里面的文件照旧出卡（scope inside，没有原因行）。 */
function askCardCheck(ctx, take) {
  const { who, turn, shown, changes } = take.ask;
  const rows = changes.map((call) => {
    const event = turn.approvals.find((item) => item.toolCallId === call.id) ?? null;
    const card = event ? turn.cards.find((item) => item.request === event.requestId) ?? null : null;
    return { call: callBrief(call), scope: event?.scope ?? null, card: card && cardBrief(card) };
  });
  ctx.record('FS-40 real full-access: in a new session (Ask each time) each edit or write the model makes inside '
    + 'the working directory still shows an approval card (scope inside, no reason line)', shown === 'Ask each time'
    && rows.length > 0 && rows.every((row) => row.scope === 'inside' && row.card?.scope === 'inside'
    && row.card.reasons.length === 0), { shown, rows },
  `cwd ${who.cwd}; reply: ${briefSafe(turn.reply, 300)}`);
}

/** @brief full-access（FS-40）：fullAccessOnce（最多 3 次），满足前提后记四条检查。 */
export async function fullAccessScenario(ctx) {
  const { take, ok } = await withAttempts(ctx, DRIVES.fullAccess, () => fullAccessOnce(ctx));
  if (!ok) return;
  insideCheck(ctx, take);
  outsideCardCheck(ctx, take);
  repeatCheck(ctx, take);
  askCardCheck(ctx, take);
}

// ---------- work-scratch（FS-54，录成 work-scratch.json） ----------

/** @brief work-scratch 的批准卡：scope inside 的命令 Allow once，其余（写到 .work 之外、写到外面）Deny。 */
const workAnswer = (event) => (COMMAND_TOOLS.includes(event.toolName) && event.scope === 'inside' ? 'allow'
  : 'reject');

/**
 * @brief FS-54 的一次（新的临时项目，录制）：录制器开会话（Ask each time），让模型写统计行数的临时脚本并运行。
 *        没有 write 写进 .work、或改了 .work 之外的文件时为没满足。
 */
async function workOnce(ctx) {
  const { project } = await newRealProject(ctx, 'work-scratch', { files: FILES });
  const created = await recStart(ctx, project);
  const { asked, trace } = await recRun(ctx, created, PROMPTS.scratch(tag('fs54')), workAnswer);
  const work = trace.calls.filter((call) => call.name === 'write' && inWork(call.args.path, created.cwd));
  const stray = changesInside(trace.calls, created.cwd);
  const unmet = !work.length ? 'the model wrote no file into .work/ with the write tool (calls: '
    + `${trace.calls.map(callBrief).join('; ') || 'none'})` : stray.length ? 'the model also changed files '
    + `outside .work/: ${stray.map(callBrief).join('; ')}` : null;
  return { created, asked, trace, work, unmet };
}

/** @brief work-scratch 的 note：命令卡与结果、最后的回复。 */
function workNote(take) {
  const commands = take.asked.filter((item) => COMMAND_TOOLS.includes(item.toolName)).map((item) => {
    const result = take.trace.results.find((entry) => entry.id === item.toolCallId);
    return `${briefSafe(item.args.command, 120)} (${item.decision}${result?.isError ? ', error' : ''})`;
  });
  return `commands: ${commands.join('; ') || 'none'}; reply: ${briefSafe(take.trace.reply, 300)}`;
}

/** @brief FS-54：写进 .work 的 write 不出卡（没有批准请求，tool_gate 最后为 free）、结果不是错误；模型把脚本写进 .work。 */
function workChecks(ctx, take) {
  const rows = take.work.map((call) => ({ path: call.args.path,
    asked: take.asked.some((item) => item.toolCallId === call.id),
    gates: take.trace.gates.filter((gate) => gate.toolCallId === call.id).map((gate) => gate.gate),
    result: take.trace.results.find((item) => item.id === call.id) ?? null }));
  const ok = rows.every((row) => !row.asked && row.gates.at(-1) === 'free' && !row.gates.includes('ask')
    && row.result && !row.result.isError);
  const note = workNote(take);
  ctx.record('FS-54 real work-scratch: under Ask each time each write call into .work/ runs without an approval '
    + 'request (mori.tool_gate free) and its tool result is not an error', ok, rows.map((row) => ({ ...row,
    result: row.result && { isError: row.result.isError, text: briefSafe(row.result.text, 200) } })), note);
  ctx.record('FS-54 real work-scratch: asked to write a temporary line-counting script and run it, the model writes '
    + 'the script into .work/ with the write tool and changes no other file in the working directory', true,
  { scripts: take.work.map((call) => call.args.path) }, note);
}

/** @brief work-scratch.json 的说明。 */
const workMeta = (take) => ({
  description: 'Ask each time: the real model writes a temporary line-counting script into .work/ with the write '
    + 'tool (no approval card) and runs it (its command card is allowed once)',
  covers: ['FS-54'],
  what: 'the Ask each time run that writes a temporary script into .work/ and runs it',
  notes: [`Scripts written into .work/: ${(take.work ?? []).map((call) => call.args.path).join(', ') || 'none'}`,
    'Approval answers by the recorder: commands with scope inside are allowed once, everything else is rejected'],
});

/** @brief work-scratch（FS-54）：workOnce（最多 3 次），记检查，写 work-scratch.json（前提没满足时写 rejected）。 */
export async function workScratchScenario(ctx) {
  const { take, ok } = await withAttempts(ctx, DRIVES.work, () => workOnce(ctx));
  if (!take.created) return;
  if (ok) workChecks(ctx, take);
  await saveFixture(ctx, 'work-scratch', workMeta(take), ok ? [] : [`precondition not met: ${take.unmet}`]);
}

// ---------- full-outside（FS-114 与回放的 FS-36，录成 full-outside.json） ----------

/**
 * @brief full-outside 的一次（新的临时项目，录制）：录制器开会话、approval.setMode full，让模型写到上一级，全部 Deny。
 *        没有 scope 为 outside 的批准请求时为没满足。
 */
async function outsideOnce(ctx) {
  const { project } = await newRealProject(ctx, 'full-outside', { files: FILES });
  const created = await recStart(ctx, project, 'full');
  const { asked, trace } = await recRun(ctx, created, PROMPTS.outside(tag('fs36')), () => 'reject');
  const denied = asked.find((item) => item.scope === 'outside') ?? null;
  return { created, asked, trace, denied, unmet: denied ? null : 'no approval request with scope outside (requests: '
    + `${asked.map((item) => `${item.toolName} ${item.scope}`).join('; ') || 'none'})` };
}

/**
 * @brief FS-114：Full access 下写到外面的请求 scope 为 outside，每个目标理由 outside、路径是调用里的路径解析后的样子
 *        （卡上的原因行），allowDirs 是它的目录。
 */
function outsideRequestCheck(ctx, take) {
  const { denied, created } = take;
  const target = denied.targets[0] ?? null;
  const wanted = FILE_TOOLS.includes(denied.toolName) && typeof denied.args.path === 'string'
    ? resolveArg(created.cwd, denied.args.path) : target?.path ?? null;
  const gates = take.trace.gates.filter((gate) => gate.toolCallId === denied.toolCallId).map((gate) => gate.gate);
  const ok = Boolean(target) && denied.targets.every((item) => item.reason === 'outside' && item.path
    && !underPath(item.path, created.cwd)) && samePath(target.path, wanted) && denied.allowDirs.length === 1
    && samePath(denied.allowDirs[0], win32.dirname(target.path));
  ctx.record('FS-114 real full-outside: under Full access (approval.setMode full) the write outside the working '
    + 'directory still asks: its mori.approval_request has scope outside, each target is reason outside with the '
    + 'resolved path of the call (the card shows "Writes outside the working directory: <path>"), and allowDirs is '
    + 'that path\'s folder', ok, { tool: denied.toolName, path: denied.args.path ?? null, wanted,
    targets: denied.targets, allowDirs: denied.allowDirs, gates }, `reply: ${briefSafe(take.trace.reply, 300)}`);
}

/** @brief FS-114：Deny 之后按你结束、工具结果为 Rejected by the user.（错误）、要写的文件不在。 */
function outsideDenyCheck(ctx, take) {
  const { denied, trace, created } = take;
  const end = trace.ends.find((item) => item.requestId === denied.requestId) ?? null;
  const result = trace.results.find((item) => item.id === denied.toolCallId) ?? null;
  const written = denied.existsAfter.filter((item) => item.exists);
  const again = callsAfter(trace.calls, denied.toolCallId).map(callBrief);
  ctx.record('FS-114 real full-outside: after Deny the request ends by the user (mori.approval_end reject), the '
    + 'call\'s tool result is "Rejected by the user." (an error) and the file it would have written does not exist',
  end?.by === 'user' && end.decision === 'reject' && result?.text === REJECTED && result.isError
    && denied.existsAfter.length > 0 && written.length === 0,
  { end: end && { by: end.by, decision: end.decision }, result: result && { text: result.text,
    isError: result.isError }, existsAfter: denied.existsAfter, existsNow: denied.existsAfter
    .map((item) => ({ path: item.path, exists: existsSync(item.path) })) },
  `cwd ${created.cwd}; calls after the denial: ${again.join('; ') || 'none'}`);
}

/** @brief full-outside.json 的说明。 */
const outsideMeta = (take) => ({
  description: 'Full access (set through the permission menu): the real model writes outside the working directory, '
    + 'the approval card shows the reason line for the outside path and the user denies it',
  covers: ['FS-36', 'FS-114'],
  what: 'the Full access run whose write outside the working directory asks and is denied',
  notes: [`Outside requests: ${(take.asked ?? []).filter((item) => item.scope === 'outside')
    .map((item) => `${item.toolName} ${briefSafe(item.args.path ?? item.args.command, 120)}`).join('; ') || 'none'}`,
  'Approval answers by the recorder: every request is rejected without a reason'],
});

/** @brief full-outside（FS-114）：outsideOnce（最多 3 次），记两条检查，写 full-outside.json。 */
export async function fullOutsideScenario(ctx) {
  const { take, ok } = await withAttempts(ctx, DRIVES.outside, () => outsideOnce(ctx));
  if (!take.created) return;
  if (ok) {
    outsideRequestCheck(ctx, take);
    outsideDenyCheck(ctx, take);
  }
  await saveFixture(ctx, 'full-outside', outsideMeta(take), ok ? [] : [`precondition not met: ${take.unmet}`]);
}

// ---------- ask-question（FS-114，关闭模式，界面驱动） ----------

/** @brief 提问卡上第 index 个问题里 label 那一项的 input。 */
const askOption = (tab, index, label) => `${paneSel(tab)} [data-testid="ask-card"] [data-testid="ask-question"]`
  + `[data-index="${index}"] [data-testid="ask-option"][data-label=${JSON.stringify(label)}] input`;

/** @brief 问题里推荐的那一项的 label（界面按 trim 后相等认推荐项，AskCard.tsx isRecommended）。 */
const recommendedLabel = (question) => question.options.find((option) => option.label.trim()
  === question.recommended.trim())?.label ?? question.recommended;

/** @brief 提问卡与调用对不上的地方：问题与选项的顺序、推荐标记、Other、预选、Submit。 */
function askCardProblems(card, request) {
  const problems = [];
  if (card.questions.length !== request.questions.length) problems.push(`${card.questions.length} questions shown`);
  request.questions.forEach((question, index) => {
    const shown = card.questions[index];
    const labels = shown?.options.map((option) => option.label) ?? [];
    const marked = shown?.options.filter((option) => option.recommended) ?? [];
    if (!same(labels, question.options.map((option) => option.label))) problems.push(`q${index + 1} options ${labels}`);
    if (shown?.text !== question.question.replace(/\s+/g, ' ').trim()) problems.push(`q${index + 1} text`);
    if (marked.length !== 1 || marked[0].label !== recommendedLabel(question)
      || marked[0].recText !== ' (Recommended)') problems.push(`q${index + 1} recommended ${JSON.stringify(marked)}`);
    if (shown?.order.at(-1) !== 'Other') problems.push(`q${index + 1} order ${shown?.order}`);
    if (shown?.options.some((option) => option.checked) || shown?.other.checked) problems.push(`q${index + 1} picked`);
  });
  if (!card.submitDisabled) problems.push('Submit is available before any answer');
  return problems;
}

/**
 * @brief 在卡上选每个问题的推荐项、点 Submit，等这张卡的 mori.question_end 与会话文件里这次调用的工具结果。
 * @return { pairs（[问题, 选的 label]）, end, result }
 */
async function submitRecommended(ctx, who, card, request) {
  const pairs = request.questions.map((question) => [question.question, recommendedLabel(question)]);
  for (const [index, [, label]] of pairs.entries()) await ctx.page.locator(askOption(who.tab, index, label)).click();
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="ask-card"] [data-testid="ask-submit"]`).click();
  const end = await waitEvent(ctx, who.sessionId, 'mori.question_end', (item) => item.requestId === card.request,
    { timeout: 20000 });
  const result = await waitToolResult(who.sessionFile, (item) => item.id === request.toolCallId, 30000);
  return { pairs, end, result };
}

/** @brief 提问卡换成了另一张（模型答完之后又问）时返回它，否则 null（刚提交的那张还在消失时不算）。 */
async function anotherAsk(ctx, tab, request) {
  const card = await askCardOf(ctx, tab);
  return card && card.request !== request ? card : null;
}

/**
 * @brief ask-question 的一次（新的临时项目，界面驱动，关闭模式）：让模型先问 JSON 还是 YAML，等提问卡（期间 scope inside
 *        的批准卡 Allow once），读卡与 mori.question_request，选推荐项提交，等这次运行结束。没出提问卡时为没满足。
 */
async function askOnce(ctx) {
  const { project } = await newRealProject(ctx, 'ask-question', { files: FILES });
  const who = await openUi(ctx, project, 'fs114-ask');
  const turn = await turnUi(ctx, who, PROMPTS.ask(who.marker), { decide: allowInside,
    stopAt: () => askCardOf(ctx, who.tab) });
  if (!turn.stopped) {
    return { unmet: 'the model did not call ask_user_question (calls: '
      + `${turn.calls.map(callBrief).join('; ') || 'none'})` };
  }
  const card = turn.stopped;
  const request = (await kernelEvents(ctx, who.sessionId, 'mori.question_request', turn.since))
    .map((item) => item.data).find((item) => item.requestId === card.request) ?? null;
  if (!request) throw new Error(`no mori.question_request for ${card.request}`);
  const answer = await submitRecommended(ctx, who, card, request);
  const next = await driveUi(ctx, who, { decide: allowInside, stopAt: () => anotherAsk(ctx, who.tab, card.request) });
  return { who, card, request, ...answer, next, results: toolResultsIn(who.sessionFile),
    reply: lastReply(who.sessionFile) };
}

/** @brief ask-question 的 note：模型问了什么、推荐了什么、有没有校验出错的调用、最后的回复。 */
function askNote(take) {
  const asked = take.request.questions.map((question) => `"${question.question}" [${question.options
    .map((option) => option.label).join(' | ')}] recommended ${question.recommended}`);
  const invalid = take.results.filter((item) => item.tool === 'ask_user_question' && item.isError).length;
  const next = take.next ? `; the model asked again (left pending): ${briefSafe(take.next.questions, 200)}` : '';
  return `${briefSafe(asked.join('; '), 600)}; invalid ask_user_question calls: ${invalid}${next}; reply: `
    + `${briefSafe(take.reply, 300)}`;
}

/** @brief ask-question（FS-114）：askOnce（最多 3 次），记卡与工具结果两条检查。 */
export async function askQuestionScenario(ctx) {
  const { take, ok } = await withAttempts(ctx, DRIVES.ask, () => askOnce(ctx));
  if (!ok) return;
  const note = askNote(take);
  const problems = askCardProblems(take.card, take.request);
  ctx.record('FS-114 real ask-question (team off): the model\'s ask_user_question call shows one question card that '
    + 'matches the call: the questions and their options in order, " (Recommended)" only after the recommended '
    + 'label, an Other row last, nothing preselected and Submit unavailable', problems.length === 0,
  { problems, card: take.card }, note);
  const want = answeredText(take.pairs);
  ctx.record('FS-114 real ask-question: after picking the recommended option of each question and Submit the '
    + 'question ends by the user (mori.question_end) and the tool result is word for word "User has answered your '
    + 'questions: "<question>"="<label>". You can now continue with the user\'s answers in mind." (not an error)',
  take.end?.by === 'user' && take.result?.text === want && !take.result.isError,
  { want, result: take.result && { text: take.result.text, isError: take.result.isError },
    end: take.end && { by: take.end.by, answers: take.end.answers } }, note);
}

// ---------- away-reminder（FS-82、FS-114 与回放的 FS-78，录成 away-reminder.json） ----------

/** @brief 命令的第一行，超过 COMMAND_LINE_MAX 时截短加 …（§9.8）。 */
function firstLine(command) {
  const line = String(command).split(/\r?\n/, 1)[0] ?? '';
  return line.length > COMMAND_LINE_MAX ? `${line.slice(0, COMMAND_LINE_MAX)}…` : line;
}

/**
 * @brief 提醒清单里一条自动处理记录的行（file-system-permissions.md §9.8）：批准为 - Denied <工具名>，edit、write 加
 *        : <path>，bash、powershell 加 : <命令的第一行>；提问每个问题一行 - Used your recommended option for "<问题>": <答案>。
 */
function decisionLines(decision) {
  if (decision.kind === 'question') {
    return (decision.answers ?? []).map((answer) => `- Used your recommended option for "${answer.question}": `
      + `${[...answer.selected, ...(answer.other === null ? [] : [answer.other])].join(', ')}`);
  }
  const tool = decision.toolName ?? '';
  const args = decision.args ?? {};
  if (FILE_TOOLS.includes(tool) && typeof args.path === 'string') return [`- Denied ${tool}: ${args.path}`];
  if (COMMAND_TOOLS.includes(tool) && typeof args.command === 'string') {
    return [`- Denied ${tool}: ${firstLine(args.command)}`];
  }
  return [`- Denied ${tool}`];
}

/**
 * @brief 会话文件里自动处理与提醒的样子：提醒条目之前的自动处理记录（扩展询问不进清单，§9.8）、全部记录、提醒条目
 *        （reminderEntries：{ display, content }）。
 */
function awayTimeline(file) {
  const entries = readJsonl(file);
  const at = entries.findIndex((entry) => entry.type === 'custom_message' && entry.customType === REMINDER_TYPE);
  const decisions = entries.slice(0, at < 0 ? entries.length : at).filter((entry) => entry.type === 'custom'
    && entry.customType === DECISION_TYPE).map((entry) => entry.data).filter((item) => item?.kind !== 'extension');
  return { decisions, all: awayRecords(file), reminders: reminderEntries(file) };
}

/**
 * @brief away-reminder 的一次（新的临时项目，录制）：装焦点替身，录制器开会话（Ask each time），窗口失焦，让模型写
 *        ../fs82-note.txt，不回答任何卡（你不在按 AWAY_MS 拒绝），等运行结束，窗口拿回焦点。没有 scope outside、
 *        按你不在结束的请求时为没满足。
 */
async function awayOnce(ctx) {
  const { project } = await newRealProject(ctx, 'away-reminder', { files: FILES });
  await installFocus(ctx);
  const created = await recStart(ctx, project);
  const marker = tag('fs82');
  const since = Date.now();
  await blurWindow(ctx);
  let run;
  try {
    run = await recRun(ctx, created, PROMPTS.away(marker), () => null);
  } finally {
    await focusWindow(ctx).catch((error) => log(`could not give the window its focus back: ${errorText(error, 200)}`));
  }
  const awayEnded = (item) => run.trace.ends.some((end) => end.requestId === item.requestId && end.by === 'away');
  const denied = run.asked.filter((item) => item.scope === 'outside' && awayEnded(item));
  return { created, ...run, denied, timeline: awayTimeline(created.sessionFile), focus: focusLog(ctx, since),
    requests: sessionRequests(ctx, marker, since), unmet: denied.length ? null : 'no request with scope outside '
      + `ended by away (requests: ${run.asked.map((item) => `${item.toolName} ${item.scope}`).join('; ') || 'none'})` };
}

/** @brief away-reminder 的 note：请求次数、提醒之后的调用、最后的回复。 */
function awayNote(take) {
  return `requests: ${take.requests.length}; focus log: ${take.focus.join(',') || 'none'}; calls: `
    + `${take.trace.calls.map(callBrief).join('; ') || 'none'}; reply: ${briefSafe(take.trace.reply, 300)}`;
}

/** @brief FS-82、FS-114：按你不在结束的写到外面的卡，工具结果与 §14 逐字相同（错误），一条自动处理记录。 */
function awayDenialCheck(ctx, take) {
  const duration = DURATION[ctx.awayTimeout];
  const want = awayDenial(duration);
  const rows = take.denied.map((item) => {
    const end = take.trace.ends.find((entry) => entry.requestId === item.requestId) ?? null;
    const result = take.trace.results.find((entry) => entry.id === item.toolCallId) ?? null;
    const records = take.timeline.all.filter((entry) => entry.toolCallId === item.toolCallId);
    return { tool: item.toolName, path: item.args.path ?? null, end: end && { by: end.by, decision: end.decision },
      result: result && { text: result.text, isError: result.isError }, records: records.map((entry) => ({
        kind: entry.kind, result: entry.result, timeout: entry.timeout })) };
  });
  const ok = Boolean(duration) && rows.every((row) => row.end?.by === 'away' && row.end.decision === 'reject'
    && row.result?.text === want
    && row.result.isError && row.records.length === 1 && row.records[0].kind === 'approval'
    && row.records[0].result === 'denied' && row.records[0].timeout === ctx.awayTimeout);
  for (const id of DRIVES.away.ids) {
    ctx.record(`${id} real away-reminder: in Ask each time with the window unfocused (MORI_AWAY_TIMEOUT_MS=`
      + `${AWAY_MS}, When you're away: ${duration}) the card for the write outside the working directory ends by `
      + `away (mori.approval_end reject) and its tool result is word for word "${want}" (an error), with one `
      + 'mori.away_decision record (kind approval, result denied)', ok, { rows, focus: take.focus }, awayNote(take));
  }
}

/** @brief FS-114：这次运行恰好一条提醒（display false，§14 原文列出它之前的自动处理），恰好多一次以它结尾的请求。 */
function reminderCheck(ctx, take) {
  const { decisions, reminders } = take.timeline;
  const want = reminderText(decisions.flatMap(decisionLines));
  const extra = reminderRequests(take.requests);
  const at = take.requests.findIndex((request) => extra.some((item) => item.t === request.t));
  ctx.record('FS-114 real away-reminder: the run gets one reminder: one mori.away_reminder custom_message (display '
    + 'false) whose text is the file-system.md §14 reminder listing each automatic decision of the run before it, '
    + 'and exactly one extra request ends with it right after the last assistant message', decisions.length > 0
    && reminders.length === 1 && reminders[0].display === false && reminders[0].content === want
    && extra.length === 1 && extra[0].before === 'assistant' && extra[0].reminder === want,
  { want, reminders, extra: extra.map((item) => ({ before: item.before, same: item.reminder === want })),
    requests: take.requests.length },
  `requests after the reminder request: ${at < 0 ? 'none' : take.requests.length - at - 1}`);
}

/** @brief FS-82（录制写完之后记，模型的表现）：自动拒绝之后不重复被拒绝的调用；最后的总结提没提到只写进 note。 */
function awayRepeatCheck(ctx, take) {
  const { calls, reply } = take.trace;
  const cwd = take.created.cwd;
  const again = take.denied.flatMap((item) => {
    const call = calls.find((entry) => entry.id === item.toolCallId);
    return call ? repeatsOf(calls, call, cwd) : [];
  });
  const mentions = /denied|away|did ?n[o']t answer|not answer|could ?n[o']t|was ?n[o']t|fs82-note/i.test(reply);
  ctx.record('FS-82 real away-reminder: after the automatic denial the model does not repeat the denied call (the '
    + 'same tool on the same path or command)', again.length === 0, { denied: take.denied.map((item) => `${item
    .toolName} ${briefSafe(item.args.path ?? item.args.command, 160)}`), again: again.map(callBrief) },
  `the final summary ${mentions ? 'mentions' : 'does not clearly mention'} the denied write: `
    + `${briefSafe(reply, 400)}`);
}

/** @brief away-reminder.json 的说明。 */
const awayMeta = (take) => ({
  description: 'Ask each time with the window unfocused and a short away timeout: the real model\'s write outside '
    + 'the working directory is denied because the user is away, and the run gets one hidden reminder '
    + '(custom_message, display false) and one extra request',
  covers: ['FS-78', 'FS-114'],
  what: 'the Ask each time run whose write outside is denied while the user is away, with its reminder',
  notes: [`Window focus (synthetic test setup): the main window reports unfocused through the focus stand-in of `
    + `tests/ui/fs-away-helpers.mjs; MORI_AWAY_TIMEOUT_MS=${AWAY_MS}`,
  `Denied by away: ${(take.denied ?? []).map((item) => `${item.toolName} ${briefSafe(item.args.path
    ?? item.args.command, 120)}`).join('; ') || 'none'}`, 'The recorder answers no approval card'],
});

/**
 * @brief away-reminder（FS-82、FS-114）：awayOnce（最多 3 次；用 AWAY_MS 启动），记两条程序保证的检查，写
 *        away-reminder.json，之后记 FS-82 模型表现的检查。
 */
export async function awayReminderScenario(ctx) {
  const { take, ok } = await withAttempts(ctx, DRIVES.away, () => awayOnce(ctx));
  if (!take.created) return;
  if (ok) {
    awayDenialCheck(ctx, take);
    reminderCheck(ctx, take);
  }
  await saveFixture(ctx, 'away-reminder', awayMeta(take), ok ? [] : [`precondition not met: ${take.unmet}`]);
  if (ok) awayRepeatCheck(ctx, take);
}

// ---------- 步骤 ----------

/**
 * 这个模块的步骤（fs-real.mjs 把它们并进 createRealContext 的 steps）：{ name, ids, run, start?, timeoutMs? }。
 * away-reminder 的 start 带 awayMs（MORI_AWAY_TIMEOUT_MS），放在最后：ensureReal 只在它前后各重启一次 Mori
 */
export const PERM_STEPS = Object.freeze([
  { ...DRIVES.identity, run: identityScenario },
  { ...DRIVES.fullAccess, run: fullAccessScenario },
  { ...DRIVES.work, run: workScratchScenario },
  { ...DRIVES.outside, run: fullOutsideScenario },
  { ...DRIVES.ask, run: askQuestionScenario },
  { ...DRIVES.away, run: awayReminderScenario },
]);
