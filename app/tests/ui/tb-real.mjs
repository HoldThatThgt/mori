// 平行 Agent 与 TaskBoard 的真实模型一层（docs/specs/parallel-agents-taskboard.md §17.1“真实模型一层”、§17.2 的
// TB-04、TB-08、TB-34、TB-37、TB-45、TB-59、TB-60）：真正的 Mori 对负责人的两个真实模型（默认 DeepSeek 与 GLM，都是 C 级），全部经界面操作。
// 准备（synthetic test setup，见 tb-real-helpers.mjs）：复制数据目录（只复制加密的文件，不读 key，不写来源目录）；
// 分组 [DeepSeek, GLM] 为默认范围；两个提供商的地址改指本机 4690 端口上的转发代理（只记请求体，
// 用来看发给模型的工具）；角色文件 executor、reviewer（reviewer 的 models 是第二个提供商），基座持有对话、立项与结案。
// 六个驱动（§17.1），每个在自己的临时项目和会话里：
//   ask：关闭模式下让对话用 agent_message 问 reviewer 一个问题（临时提问）。
//   team：/task 让 executor 修好失败的测试（只改 sum.js）并跑 npm test、reviewer 复核；“Ask each time”，出现的后台批准卡都允许。
//   approval：“Ask each time”下 /task 让 executor 运行 node --version（task 跑命令，出后台批准卡），允许。
//   stop（TB-89，§13.13.7）：Allow all，/task 让 executor 运行一个 30 秒的命令；它运行时在右栏的 Background tasks 里点
//     Stop this task，再发一条消息让立项把它交回，等需求到终态。
//   lookback（TB-59，2026-10-26）：/task 让 executor 只读地列出文件；需求关闭、Task mode 回到 off 之后问那份清单。
//     程序保证的：关闭模式的请求有 board_read、read_session、没有登记需求和建 task 的工具，末尾的工作卡写 Task mode: off，
//     对话流里有 Task mode off；模型有没有去读、回复里有没有让你调工具只写进 note。
//   catchup（TB-60，2026-10-28）：另写 chat（对话）、planner（立项与结案）两个角色，/task on 之后两条不需要改动的
//     短消息。程序保证的：立项的投递里（立项会话与代理转发给模型的立项请求）不再以 User: 抄它已经以
//     [Mori] New user message 收到的消息，对话对第一条的回复在之后的投递里；立项会话里每条消息一个 mori.create_seen。
//     立项登没登记需求只写进 note。
// 检查只断言程序保证的事（§17.1 的列表）：回执与 board.json 的写入一一对应；每个交接的证据编号都在那个实例会话里；
// 对话会话在协作模式下的写入、命令调用全部得到 RELAY_ONLY（file-system.md §19.4 的 TB-45 一行）；后台批准卡写明角色与 task；每个实例的每次运行结束后 task 处于 §9.4 规定的状态，
// 每个 task 到了终态、waiting_user 或交给结案；进展摘要的需求与 task 标题等于 board.json 里的，task 行的当前在做什么等于
// 那个实例会话最近一次工具调用的 §13.8 标题；临时提问的实例会话里没有成功的 edit、write、命令，不进侧栏。模型怎么做（是否登记、是否关闭需求、
// 回答的内容、用了哪个模型）只写进结果的 note。前提没满足（对话没调 agent_message、没出批准卡、需求 15 分钟内没到终态）
// 时最多重跑 2 次，记在 note 里；仍不满足按失败。15 分钟只是驱动脚本的时限。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs real）：
//   MORI_APP_DIR=.tb-runs/real node tests/ui/tb-real.mjs --source <数据目录> [--exe <Mori.exe>]
//     [--only ask,team,approval,stop,lookback,catchup]
// 结果写到 test-results/tb-real(-packaged).json（--only 时 tb-partial-real…，不计入覆盖检查），截图在 test-results/tb-real/。

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  allowAll, approvalCardsOf, bridge, captureOrder, closeTbApp, contentText, customOf, instanceFiles, kernelEvents,
  liveInfo, messagesOf, modeNoticesOf, OFF_CARD_TOOLS, openProject, paneSel, paneState, phasesOf, poll, readBoard,
  readJsonl, receiptsOf, sendMessage, startTbApp, userSession, waitTeamIdle, watchTaskPhases, modelButtonSel,
  SPLIT_ROLES, writeRoles,
} from './tb-helpers.mjs';
import { CATCH_UP_TITLE } from '../fake-endpoint/scripts.mjs';
import {
  approvalProblems, ASK_FORBIDDEN, chatRequests, evidenceProblems, lateSummary, prepareRealData, progressProblems,
  PROMPTS, realProvidersOf, receiptProblems, refOf, RELAY_ONLY, routingProblems, startForwardProxy, stopForwardProxy,
  sumProject,
  TB_GROUP, unsettledTasks, WRITE_TOOLS, writeRealRoles,
} from './tb-real-helpers.mjs';

const source = arg('source') ? resolve(arg('source')) : null;
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/tb-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (ctx, name) => ctx.page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 转发代理的端口（本套件分到 4690–4699） */
const PROXY = 4690;
/** 驱动脚本的时限（§17.1） */
const DRIVE_MS = 15 * 60 * 1000;
/** 每个驱动最多跑几次（第一次加最多 2 次重跑） */
const ATTEMPTS = 3;
/** 对话会话在协作模式下的种类（附录 A：合并会话的立项段、分开时协作模式的对话段） */
const DIALOG_KINDS = ['merged-create', 'team-dialog'];
/** 关闭模式下对话会话的种类（有别的角色时是关闭模式的对话段，没有时没有段） */
const OFF_KINDS = ['off-dialog', 'dialog'];
/** 关闭模式下不该有的立项工具（§5.2，TB-59） */
const CREATE_ONLY = ['request_submit', 'request_update', 'request_cancel', 'task_create', 'task_edit',
  'reply_via_dialog'];

// ---------- 小工具 ----------

/** @brief 一行概括。 */
const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);
/** @brief 会话条目里某个工具的调用与它的结果：[{ call, result }]，按顺序。 */
function toolCalls(entries, name) {
  const messages = messagesOf(entries);
  return messages.filter((m) => m.role === 'assistant').flatMap((m) => (m.content ?? [])
    .filter((part) => part.type === 'toolCall' && part.name === name)).map((call) => ({ call,
    result: messages.find((m) => m.role === 'toolResult' && m.toolCallId === call.id) ?? null }));
}
/** @brief 一个会话文件里最后一条有文字的助手消息的文字。 */
function lastText(file) {
  const texts = messagesOf(readJsonl(file).slice(1), 'assistant').map((m) => (m.content ?? [])
    .filter((part) => part.type === 'text').map((part) => part.text).join('').trim()).filter(Boolean);
  return texts.at(-1) ?? '';
}
/** @brief 空白归一后的文字。 */
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
/** @brief 每个（种类/角色）的请求用了哪些提供商，写进 note。 */
function modelsUsed(requests) {
  const out = {};
  for (const r of requests) {
    const key = `${r.info.kind}/${r.info.role}`;
    out[key] = [...new Set([...(out[key] ?? []), `${r.provider}:${r.status}`])];
  }
  return out;
}

// ---------- 驱动 ----------

/** @brief 每次尝试一个新的临时项目（失败的测试与角色文件）。 */
async function newProject(ctx, name) {
  const project = sumProject(`mori-tb-real-${name}-`);
  writeRealRoles(project, ctx.found);
  ctx.projects.push(resolve(project, '..'));
  return project;
}

/** @brief ask：关闭模式下发让对话问 reviewer 的消息，等它和整个协作空闲。 */
async function askDrive(ctx, project) {
  const tab = await openProject(ctx, project);
  const since = Date.now();
  await sendMessage(ctx, tab, PROMPTS.ASK);
  const who = { tab, ...(await userSession(ctx, tab)), since, project };
  const idle = await waitTeamIdle(ctx, who, { timeout: DRIVE_MS, stableMs: 3000 });
  const calls = toolCalls(readJsonl(who.sessionFile).slice(1), 'agent_message');
  const unmet = !idle ? 'the drive did not finish within 15 minutes'
    : calls.some((c) => c.result && !c.result.isError) ? null : 'the dialog did not ask with agent_message';
  return { who, calls, unmet, ms: Date.now() - since };
}

/**
 * @brief team / approval：发 /task <文字>，界面上出现的后台批准卡都点“Allow once”（记下卡与对应的事件），
 *        直到需求都到终态、协作空闲（连续 3 秒）；空闲了一分钟需求还开着、或 15 分钟到了就结束。
 */
async function teamDrive(ctx, project, prompt) {
  const tab = await openProject(ctx, project);
  const since = Date.now();
  await sendMessage(ctx, tab, prompt, { team: true });
  const who = { tab, ...(await userSession(ctx, tab)), since, project };
  const cards = [];
  let calm = null;
  let ended = false;
  while (Date.now() - since < DRIVE_MS) {
    await answerCards(ctx, who, cards);
    const board = readBoard(ctx, who.sessionId);
    ended = board?.requests.length > 0 && board.requests.every((r) => r.status !== 'open');
    calm = (await idleNow(ctx, who)) ? calm ?? Date.now() : null;
    if (calm && Date.now() - calm > (ended ? 3000 : 60000)) break;
    await sleep(500);
  }
  const board = readBoard(ctx, who.sessionId);
  const unmet = !board?.requests.length ? 'no request was registered'
    : !ended ? `the request did not reach a terminal state (${board.requests.map((r) => r.status)})` : null;
  return { who, cards, unmet, ms: Date.now() - since };
}

/**
 * @brief lookback（TB-59）：先照 team 的走法跑完 /task 的需求，等模式回到 off，再在关闭模式下问那份清单，
 *        等它和整个协作空闲。
 */
async function lookbackDrive(ctx, project) {
  const take = await teamDrive(ctx, project, PROMPTS.LOOKBACK);
  if (take.unmet) return take;
  const mode = (await liveInfo(ctx, take.who.sessionFile).catch(() => null))?.team.mode ?? null;
  if (mode !== 'off') return { ...take, unmet: `task mode is ${mode} after the request ended, not off` };
  const askedAt = Date.now();
  await sendMessage(ctx, take.who.tab, PROMPTS.LOOKBACK_ASK);
  // 关闭模式下对话有自己的 bash 等工具，“每次询问”下它的命令出 v0 的批准卡：照样点“Allow once”，否则一直等批准
  const idle = await settleAnswering(ctx, take.who, take.cards);
  return { ...take, askedAt,
    unmet: idle ? null : 'the question after task mode went off did not finish in 15 minutes' };
}

/** @brief 等用户会话与整个协作空闲（连续 3 秒，最多 15 分钟），其间出现的批准卡都点“Allow once”；返回是否空闲了。 */
async function settleAnswering(ctx, who, cards) {
  const since = Date.now();
  let calm = null;
  while (Date.now() - since < DRIVE_MS) {
    await answerCards(ctx, who, cards);
    calm = (await idleNow(ctx, who)) ? calm ?? Date.now() : null;
    if (calm && Date.now() - calm > 3000) return true;
    await sleep(500);
  }
  return false;
}

/** @brief 用户会话与整个协作此刻空闲（TeamState.busy 为假、对话不在运行或准备中、界面不在生成或发送）。 */
async function idleNow(ctx, who) {
  const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
  const pane = await paneState(ctx.page, who.tab);
  return Boolean(info && !info.team.busy && !info.live?.running && !info.live?.preparing && pane && !pane.running
    && !pane.sending);
}

/** @brief 这个会话那一栏里新出现的批准卡：记下卡（归属行、data-*）与它的 mori.team_approval_request，点“Allow once”。 */
async function answerCards(ctx, who, cards) {
  for (const card of await approvalCardsOf(ctx, who.tab)) {
    if (cards.some((c) => c.request === card.request)) continue;
    const events = await kernelEvents(ctx, who.sessionId, 'mori.team_approval_request', who.since);
    cards.push({ ...card, t: Date.now(), event: events.map((e) => e.data).find((e) => e.requestId === card.request)
      ?? null });
    if (cards.length === 1) await shot(ctx, `card-${who.tab}`);
    await ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"][data-request="${card.request}"] `
      + '[data-testid="approval-allow"]').click({ timeout: 5000 }).catch(() => {});
  }
}

// ---------- 检查 ----------

/**
 * @brief 会话条目里这些工具成功的结果（不是 isError 的 toolResult）：协作模式的对话、临时提问里不该有写入、命令的成功
 *        （file-system.md §19.4 的 TB-45 一行）。
 */
const succeeded = (entries, tools) => messagesOf(entries).filter((m) => m.role === 'toolResult'
  && tools.includes(m.toolName) && m.isError !== true);

/**
 * @brief 只读会话（临时提问）里成功的 edit、write（它的请求里没有这两个工具，2026-10-28，file-system-permissions.md
 *        §8.11）。它的命令不被收窄拒绝（同日负责人定照 Claude 的做法），按权限模式出卡或执行，所以不算在这里。
 */
const changingCalls = (entries) => succeeded(entries, ['edit', 'write']);

/** @brief ask 的检查（TB-04、TB-45）：临时提问不改文件、回答成为工具结果、回答完就结束、不进侧栏、候选是被问角色的。 */
async function askChecks(ctx, take, notes) {
  const { who, calls } = take;
  const asks = instanceFiles(ctx, who.sessionId).filter((i) => i.first?.data?.kind === 'ask');
  const requests = chatRequests(ctx.proxy, { since: who.since, cwd: who.project }).filter((r) => r.info.kind === 'ask');
  const usedTools = asks.flatMap((i) => messagesOf(i.entries, 'assistant')).flatMap((m) => (m.content ?? [])
    .filter((p) => p.type === 'toolCall').map((p) => p.name));
  const writes = asks.flatMap((i) => changingCalls(i.entries).map((m) => m.toolName));
  const readOnly = requests.length > 0 && requests.every((r) => !r.tools.some((t) => ASK_FORBIDDEN.includes(t)))
    && writes.length === 0;
  const note = `${notes.join('; ')}${notes.length ? '; ' : ''}model: ${brief({
    asked: calls.map((c) => c.call.arguments), used: modelsUsed(requests), tools: [...new Set(usedTools)],
    writes, ms: take.ms }, 600)}`;
  for (const id of ['TB-04', 'TB-45']) {
    record(`${id} real ask: the ask instance is read-only — its requests have no agent_message, edit or write and `
      + 'its session has no successful edit or write (its commands go through the permission mode like any session\'s: '
      + 'file-system-permissions §8.11)',
    readOnly && asks.length === calls.length,
    `${brief({ tools: requests.map((r) => r.tools), asks: asks.map((i) => i.id) }, 800)} — ${note}`);
  }
  const listed = (await bridge(ctx, { type: 'session.list' })).flatMap((group) => group.sessions ?? [group])
    .map((s) => s.sessionFile ?? s.file ?? '');
  const rows = await ctx.page.locator('.session-item').evaluateAll((els) => els.map((el) => el.dataset.file ?? ''));
  const hidden = asks.every((i) => ![...listed, ...rows].some((file) => file.toLowerCase() === i.file.toLowerCase()))
    && [...listed, ...rows].every((file) => !/[\\/]teams[\\/]/i.test(file));
  for (const id of ['TB-04', 'TB-45']) {
    record(`${id} real ask: the ask instance's session file is under teams/<id>/sessions and is neither in the `
      + 'sidebar nor in session.list', asks.length > 0 && hidden, `${brief({ asks: asks.map((i) => i.file) }, 600)}`);
  }
  askAnswer(ctx, { asks, calls, requests, note });
  const roleParams = subagentRoleParams(ctx, who);
  record('TB-04 real ask: off mode with other roles the dialog\'s requests also carry subagent, whose role parameter '
    + 'is a plain string without an enum (subagent spec §3.1), and the model still asks the role with agent_message',
  roleParams.length > 0 && roleParams.every((param) => param?.type === 'string' && param.enum === undefined)
    && calls.length > 0, `${brief({ roleParams: roleParams.slice(0, 1) }, 600)} — ${note}`);
}

/** @brief 这个驱动开始以后发出的请求里 subagent 工具的 role 参数（每个带 subagent 的请求一个；没写 role 时为 null）。 */
function subagentRoleParams(ctx, who) {
  return ctx.proxy.captures.filter((item) => item.t >= who.since && item.method === 'POST')
    .flatMap((item) => (item.body?.tools ?? []).filter((tool) => (tool.function?.name ?? tool.name) === 'subagent'))
    .map((tool) => (tool.function?.parameters ?? tool.input_schema ?? tool.parameters)
      ?.properties?.tasks?.items?.properties?.role ?? null);
}

/** @brief TB-04：回答成为工具结果、回答完就结束（一次运行）、请求发给被问角色的模型（models ∩ 对话的范围）。 */
function askAnswer(ctx, { asks, calls, requests, note }) {
  const pairs = asks.map((inst, i) => ({ answer: squash(lastText(inst.file)),
    result: squash(contentText(calls[i]?.result?.content)), runs: messagesOf(inst.entries, 'user').length }));
  record('TB-04 real ask: each ask instance answers in one run and ends, and its last text is exactly the dialog\'s '
    + 'agent_message tool result', pairs.length > 0 && pairs.every((p) => p.runs === 1 && p.answer && p.answer
    === p.result), `${brief(pairs, 800)} — ${note}`);
  const providers = [...new Set(requests.map((r) => r.provider))];
  record(`TB-04 real ask: the ask runs on the asked role's candidates (reviewer models [${ctx.found.second.id}] ∩ the `
    + `dialog's range ${TB_GROUP}), so its requests go to ${ctx.found.second.id}`,
  providers.length === 1 && providers[0] === ctx.found.second.id, `${brief({ providers })} — ${note}`);
}

/**
 * @brief 用户会话里协作模式下（按 mori.team 条目，mode 不是 off 的那一段）这些工具的结果：[{ tool, error, text }]，按顺序。
 * @param entries 用户会话文件的条目（头部除外）
 * @param tools 工具名
 */
function teamModeResults(entries, tools) {
  let mode = 'off';
  const out = [];
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'mori.team') mode = entry.data?.mode ?? mode;
    const message = entry.type === 'message' ? entry.message : null;
    if (mode !== 'off' && message?.role === 'toolResult' && tools.includes(message.toolName)) {
      out.push({ tool: message.toolName, error: message.isError === true, text: contentText(message.content) });
    }
  }
  return out;
}

/** @brief team / approval 共同的检查（TB-08、TB-37、TB-45；TB-34 在有卡时）。 */
async function teamChecks(ctx, name, take, notes) {
  const { who, cards } = take;
  const board = readBoard(ctx, who.sessionId);
  const entries = readJsonl(who.sessionFile).slice(1);
  const instances = instanceFiles(ctx, who.sessionId);
  const requests = chatRequests(ctx.proxy, { since: who.since, cwd: who.project });
  const routing = routingProblems(board, instances);
  const note = `${notes.join('; ')}${notes.length ? '; ' : ''}model: ${brief({ ms: take.ms,
    requests: board?.requests.map((r) => [r.no, r.title, r.status, r.conclusion]),
    tasks: board?.tasks.map((t) => [t.id, t.title, t.assignee, t.status,
      t.handoffs.map((h) => `${h.from}:${h.outcome ?? h.reason}`).join(' → ')]),
    runs: routing.runs, used: modelsUsed(requests), cards: cards.length }, 2500)}`;
  await receiptChecks(ctx, { name, who, board, entries, note });
  const evidence = evidenceProblems(board);
  const count = board?.tasks.flatMap((t) => t.handoffs).flatMap((h) => h.evidence).length ?? 0;
  record(`TB-45 real ${name}: every handoff's evidence numbers ([#n]) are tool results of that handoff's instance `
    + `session (${count} checked)`, evidence.length === 0, `${brief(evidence)} — ${note}`);
  const dialog = requests.filter((r) => DIALOG_KINDS.includes(r.info.kind));
  const tried = teamModeResults(entries, WRITE_TOOLS);
  record(`TB-45 real ${name}: in team mode every write or command call of the dialog session (${tried.length} in `
    + `${dialog.length} requests) gets "${RELAY_ONLY}" and none succeeds (file-system-permissions §8.3)`,
  dialog.length > 0 && tried.every((item) => item.error && item.text === RELAY_ONLY),
  `${brief({ tried, tools: [...new Set(dialog.map((r) => r.tools.join(',')))] })} — ${note}`);
  const unsettled = unsettledTasks(board);
  record(`TB-45 real ${name}: after every run of every instance the task is where §9.4 puts it (a handoff routes by `
    + '§7.1; no handoff or an error goes to close, after the forced fill), and every task ended, waits for the user '
    + 'or is with close', routing.problems.length === 0 && unsettled.length === 0 && (board?.tasks.length ?? 0) > 0,
  `${brief({ problems: routing.problems, unsettled })} — ${note}`);
  await progressChecks(ctx, { name, who, board, instances, entries, note });
  if (cards.length) cardChecks(name, cards, { board, instances, note });
  return { cards: cards.length };
}

/** @brief TB-08 / TB-45：回执与 board.json 的写入一一对应（会话文件的 mori.receipt 条目与界面上的回执行）。 */
async function receiptChecks(ctx, { name, who, board, entries, note }) {
  const written = customOf(entries, 'mori.receipt');
  const shown = await receiptsOf(ctx, who.tab);
  const problems = receiptProblems(board, written);
  const same = JSON.stringify(shown.map((r) => [r.kind, r.request])) === JSON.stringify(written.map((r) => [r.kind,
    r.request]));
  for (const id of ['TB-08', 'TB-45']) {
    record(`${id} real ${name}: receipts match board.json writes one to one (a registered receipt with the title for `
      + 'each request, an added one per supplement, a cancelled one per cancelled request, none without a write), '
      + 'and the transcript shows the same receipt lines', problems.length === 0 && same && written.length > 0,
    `${brief({ problems, written: written.map((r) => `${r.kind}:${r.request}`), shown: shown.map((r) => r.text) })}`
      + ` — ${note}`);
  }
}

/**
 * @brief TB-37：进展摘要的标题与 task 行等于 board.json 的标题；running 行等于那个实例最近一次工具调用的标题。
 *        一行 running 都没看到、而摘要第一次出现时每个 task 的实例都已经停了（lateSummary）时记 KNOWN：模型的做法
 *        （对话在登记需求的那一段里一直调用工具，摘要要等那一段结束才显示），detail 写明时刻与那一段调用的工具；
 *        标题不对、没有摘要、或摘要出现时还有实例在跑却没看到 running 行时照样记失败。
 */
async function progressChecks(ctx, { name, who, board, instances, entries, note }) {
  const info = await liveInfo(ctx, who.sessionFile);
  const seen = await phasesOf(ctx, who.tab, who.since);
  const { problems, checked } = progressProblems(board, seen, { instances, cwd: who.project,
    seatRoles: [info.team.holders.create, info.team.holders.close] });
  const titles = seen.filter((item) => item.request !== undefined).length;
  const ok = problems.length === 0 && titles > 0 && checked > 0;
  const late = ok || problems.length > 0 || titles === 0 ? null
    : lateSummary({ board, seen, instances, entries, since: who.since });
  const why = late ? `model behaviour: no running row could show, every task's instance had stopped before the `
    + `summary appeared ${brief(late, 600)}; ` : '';
  record(`TB-37 real ${name}: the progress summary's request and task titles equal the titles in board.json, and each `
    + `running task row shows the §13.8 title of that instance session's latest tool call (${checked} running rows `
    + 'checked)', ok,
  `${why}${brief({ problems: problems.slice(0, 6), rows: [...new Set(seen.map((s) => s.text))].slice(0, 30) }, 2500)}`
    + ` — ${note}`, late !== null);
}

/** @brief TB-34 / TB-45：后台批准卡写明角色与 task。 */
function cardChecks(name, cards, { board, instances, note }) {
  const problems = cards.flatMap((card) => approvalProblems(card, card.event, { board, instances }));
  for (const id of ['TB-34', 'TB-45']) {
    record(`${id} real ${name}: each background approval card (${cards.length}) is in the user session's pane and `
      + 'names the role and the task ("<role> · T<n> · <task title>", data-agent, data-task), its request id is '
      + '<instance id>:approval-<n> of that task\'s instance', problems.length === 0,
    `${brief({ problems, cards: cards.map((c) => [c.attribution, c.tool, c.request]) })} — ${note}`);
  }
}

// ---------- TB-89 停止一个 task ----------

/** @brief 这个用户会话里正在跑 bash 的 task（board.get 的视图）；没有时为 null。 */
async function runningCommand(ctx, who) {
  const view = await bridge(ctx, { type: 'board.get', sessionId: who.sessionId });
  return view.requests.flatMap((r) => r.tasks).find((t) => t.phase === 'running' && t.current?.toolName === 'bash')
    ?? null;
}

/** @brief 等需求都到终态、协作空闲（连续 3 秒）；15 分钟到了就结束。返回需求是否都到了终态。 */
async function untilEnded(ctx, who) {
  let calm = null;
  while (Date.now() - who.since < DRIVE_MS) {
    const board = readBoard(ctx, who.sessionId);
    const ended = board?.requests.length > 0 && board.requests.every((r) => r.status !== 'open');
    calm = (await idleNow(ctx, who)) ? calm ?? Date.now() : null;
    if (calm && Date.now() - calm > (ended ? 3000 : 60000)) return ended;
    await sleep(500);
  }
  return false;
}

/**
 * @brief stop（TB-89）：Allow all，/task 让 executor 运行 30 秒的命令；它运行时在 Background tasks 里点 Stop this task，
 *        停下后等 5 秒，再发一条消息让立项交回，等需求到终态。
 */
async function stopDrive(ctx, project) {
  const tab = await openProject(ctx, project);
  await allowAll(ctx, tab);
  const since = Date.now();
  await sendMessage(ctx, tab, PROMPTS.STOP, { team: true });
  const who = { tab, ...(await userSession(ctx, tab)), since, project };
  const task = await poll(() => runningCommand(ctx, who), 5 * 60 * 1000, 300);
  if (!task) return { who, unmet: 'no task ran a command within 5 minutes' };
  await ctx.page.locator(`${paneSel(tab)} [data-testid="tasks-button"]`).click();
  await ctx.page.locator(`[data-testid="bg-task"][data-task="${task.id}"] [data-action="stop-task"]`).click();
  const stoppedAt = Date.now();
  const stopped = await poll(() => {
    const board = readBoard(ctx, who.sessionId);
    return board?.tasks.find((t) => t.id === task.id)?.status === 'stopped' ? board : null;
  }, 30000, 200);
  await sleep(5000);
  const quiet = chatRequests(ctx.proxy, { since: stoppedAt + 1000, cwd: project })
    .filter((r) => r.info.kind === 'task' && r.info.task === task.id).length;
  await shot(ctx, `stop-${tab}`);
  await sendMessage(ctx, tab, PROMPTS.HAND_BACK);
  const ended = await untilEnded(ctx, who);
  const files = instanceFiles(ctx, who.sessionId).filter((i) => i.id.includes(`.${task.id.toLowerCase()}.`));
  const back = files.some((i) => messagesOf(i.entries, 'user').some((m) => contentText(m.content)
    .startsWith(`[Mori] ${task.id} is back with you.`)));
  const unmet = !stopped ? `${task.id} did not become stopped` : !back ? `the planner did not hand ${task.id} back`
    : !ended ? 'the request did not reach a terminal state' : null;
  return { who, task: task.id, stopped, quiet, files, unmet, ms: Date.now() - since };
}

/** @brief stop 的检查（TB-89）：只断言程序保证的事。 */
async function stopChecks(ctx, take, notes) {
  const { who, task, stopped, quiet, files } = take;
  const at = stopped?.tasks.find((t) => t.id === task);
  const board = readBoard(ctx, who.sessionId);
  const note = `${notes.join('; ')}${notes.length ? '; ' : ''}model: ${brief({ ms: take.ms,
    tasks: board?.tasks.map((t) => [t.id, t.status, t.handoffs.map((h) => `${h.from}:${h.outcome ?? h.reason}`)
      .join(' → ')]), requests: board?.requests.map((r) => [r.no, r.status]) }, 2000)}`;
  record(`TB-89 real stop: Stop this task on the running ${task} makes it stopped (stopReason user, holder kept) with `
    + 'no program handoff, and its instance sends no request until it is handed back',
  at?.stopReason === 'user' && at.holder?.kind === 'role' && at.handoffs.every((h) => h.reason === null || h.reason
    !== 'error') && quiet === 0, `${brief({ at: at && { status: at.status, stopReason: at.stopReason,
    holder: at.holder }, quiet })} — ${note}`);
  record(`TB-89 real stop: handed back, ${task} continues in the same instance session (one session file for it, `
    + `the delivery "[Mori] ${task} is back with you.")`, files?.length === 1,
  `${brief(files?.map((i) => i.id))} — ${note}`);
  const unsettled = unsettledTasks(board);
  record('TB-89 real stop: afterwards every task ended, waits for the user or is with close', unsettled.length === 0
    && (board?.tasks.length ?? 0) > 0, `${brief(unsettled)} — ${note}`);
}

/**
 * @brief TB-59：关闭模式下问清单的请求都有两个只读工具、没有立项工具，末尾的工作卡写 Task mode: off，对话流里有
 *        Task mode off。模型读没读、回复里有没有让你调工具只写进 note。
 */
async function lookbackChecks(ctx, take, notes) {
  const { who } = take;
  const requests = chatRequests(ctx.proxy, { since: take.askedAt, cwd: who.project })
    .filter((r) => OFF_KINDS.includes(r.info.kind));
  const bad = requests.filter((r) => !['board_read', 'read_session'].every((name) => r.tools.includes(name))
    || r.tools.some((name) => CREATE_ONLY.includes(name)) || !r.card.startsWith('<mori-work-card>\nTask mode: off\n')
    || !r.card.includes(`\n${OFF_CARD_TOOLS}`));
  const notices = await modeNoticesOf(ctx, who.tab);
  const entries = readJsonl(who.sessionFile).slice(1);
  const after = entries.filter((entry) => Date.parse(entry.timestamp ?? '') >= take.askedAt);
  const called = messagesOf(after, 'assistant').flatMap((m) => (m.content ?? []).filter((p) => p.type === 'toolCall')
    .map((p) => p.name));
  const replies = messagesOf(after, 'assistant').map((m) => contentText(m.content)).join('\n');
  const note = `${notes.join('; ')}${notes.length ? '; ' : ''}model: ${brief({ called,
    toolSyntaxInReply: /\b(read_session|board_read)\s*\{/.test(replies), reply: replies.slice(0, 400),
    used: modelsUsed(requests) }, 1200)}`;
  record('TB-59 real lookback: after the request ended and task mode went back to off, every request of the dialog '
    + 'for the follow-up question has board_read and read_session and no create tool, and ends with the work card '
    + '"Task mode: off" (with the line that tools are the agent\'s, never the user\'s); the transcript shows "Task '
    + 'mode off"', requests.length > 0 && bad.length === 0
    && notices.some((item) => item.mode === 'off' && item.text === 'Task mode off'),
  `${brief({ requests: requests.length, bad: bad.map((r) => [r.tools, r.card.slice(0, 80)]), notices }, 1200)}`
    + ` — ${note}`);
}

// ---------- TB-60 立项不重复（§8.4） ----------

/** 两条短消息（PROMPTS） */
const CATCHUP_TEXTS = [PROMPTS.CATCHUP_FIRST, PROMPTS.CATCHUP_SECOND];

/**
 * @brief catchup（TB-60）：分开的配置（tb-helpers SPLIT_ROLES 里认领权限的两个：chat 持有对话，planner 持有立项与结案；
 *        executor、reviewer 照 writeRealRoles），/task on 之后先后发两条不需要改动的短消息，每条都等它和整个协作空闲
 *        （其间出现的批准卡点“Allow once”）。前提：有立项会话，两条消息都写进了对话，对话对第一条有文字回复
 *        （没有时换一个项目重跑，“带上对话的回复”那一半不在没有回复时算通过）。
 */
async function catchupDrive(ctx, project) {
  writeRoles(project, SPLIT_ROLES.filter((role) => role.seats));
  const tab = await openProject(ctx, project);
  const since = Date.now();
  await sendMessage(ctx, tab, '/task on');
  await ctx.page.waitForFunction((css) => document.querySelector(css)?.dataset.teamMode === 'always',
    modelButtonSel(tab), { timeout: 10000 });
  const who = { tab, since, project };
  const cards = [];
  for (const text of CATCHUP_TEXTS) {
    await sendMessage(ctx, tab, text);
    Object.assign(who, await userSession(ctx, tab));
    if (!(await settleAnswering(ctx, who, cards))) return { who, unmet: 'a message did not finish in 15 minutes' };
  }
  const entries = readJsonl(who.sessionFile).slice(1);
  const typed = messagesOf(entries, 'user').map((m) => contentText(m.content));
  const create = instanceFiles(ctx, who.sessionId).find((i) => i.first?.data?.kind === 'create') ?? null;
  const unmet = !create ? 'planner has no create session'
    : CATCHUP_TEXTS.some((text) => !typed.includes(text)) ? 'the dialog did not write both messages'
      : firstReplyOf(entries) === null ? 'the dialog wrote no reply text to the first message' : null;
  return { who, create, cards, unmet, ms: Date.now() - since };
}

/**
 * @brief 对话对第一条消息的回复：用户会话里它之后第一段有文字的助手消息；没有时为 null（catchup 的前提没满足）。
 * @param entries 用户会话的条目（去掉会话头）
 */
function firstReplyOf(entries) {
  const firstAt = entries.findIndex((e) => e.type === 'message' && contentText(e.message.content) === CATCHUP_TEXTS[0]);
  if (firstAt < 0) return null;
  return messagesOf(entries.slice(firstAt + 1), 'assistant').map((m) => (m.content ?? [])
    .filter((p) => p.type === 'text').map((p) => p.text).join('').trim()).find(Boolean) ?? null;
}

/**
 * @brief catchup 的检查（TB-60）：只断言程序保证的事：立项的投递里不再以 User: 抄它收到过的两条消息（立项会话里的，
 *        以及代理转发给模型的立项请求里的），对话对第一条的回复出现在之后的投递里；立项会话里每条消息一个
 *        mori.create_seen。立项登没登记需求（重复的）只写进 note。
 */
function catchupChecks(ctx, take, notes) {
  const { who, create } = take;
  if (!create) return;
  const entries = readJsonl(who.sessionFile).slice(1);
  const deliveries = messagesOf(create.entries, 'user').map((m) => contentText(m.content));
  const at = deliveries.findIndex((text) => text.includes(`[Mori] New user message: ${CATCHUP_TEXTS[0]}`));
  const quoted = CATCHUP_TEXTS.filter((text) => deliveries.some((item) => item.includes(`User: ${text}`)));
  const reply = firstReplyOf(entries);
  const replied = reply !== null && deliveries.slice(at + 1).some((text) => text.startsWith(CATCH_UP_TITLE)
    && text.includes(reply.split('\n')[0]));
  const sent = chatRequests(ctx.proxy, { since: who.since, cwd: who.project })
    .filter((r) => r.info.role === 'planner' && r.info.kind === 'create');
  const proxied = CATCHUP_TEXTS.filter((text) => sent.some((r) => r.users.some((u) => u.includes(`User: ${text}`))));
  const carried = sent.filter((r) => r.users.some((u) => u.includes(`[Mori] New user message: ${CATCHUP_TEXTS[1]}`)));
  const board = readBoard(ctx, who.sessionId);
  const note = `${notes.join('; ')}${notes.length ? '; ' : ''}model: ${brief({ ms: take.ms,
    requests: board?.requests.map((r) => [r.no, r.title, r.status]), tasks: board?.tasks.map((t) => [t.id,
      t.status]), deliveries: deliveries.length, cards: take.cards.length }, 1500)}`;
  record('TB-60 real catchup: no delivery to planner quotes either message it already received as "[Mori] New user '
    + 'message" ("User: <message>" is absent from its session and from its requests the proxy forwarded), and one of '
    + 'the next deliveries carries the dialog\'s reply to the first one', at >= 0 && quoted.length === 0 && replied
    && carried.length > 0 && proxied.length === 0, `${brief({ quoted, proxied, requests: sent.length,
    carried: carried.length, reply, next: deliveries.slice(at + 1).map((text) => text.slice(0, 300)) }, 1500)}`
    + ` — ${note}`);
  const said = customOf(create.entries, 'mori.create_seen').map((item) => entries.find((e) => e.id === item.entryId))
    .map((e) => (e?.type === 'message' && e.message.role === 'user' ? contentText(e.message.content) : null));
  record('TB-60 real catchup: planner\'s session has one mori.create_seen per message, in order, each pointing at that '
    + 'message\'s user-session entry; the user session has none', JSON.stringify(said) === JSON.stringify(CATCHUP_TEXTS)
    && customOf(entries, 'mori.create_seen').length === 0, `${brief(said, 600)} — ${note}`);
}

// ---------- 执行 ----------

/** 驱动：名字、做一次、核对、前提没满足时记失败的编号 */
const DRIVES = [
  { name: 'ask', ids: ['TB-04', 'TB-45'], drive: askDrive, check: askChecks },
  { name: 'team', ids: ['TB-08', 'TB-37', 'TB-45'], drive: (ctx, p) => teamDrive(ctx, p, PROMPTS.TEAM),
    check: (ctx, take, notes) => teamChecks(ctx, 'team', take, notes) },
  { name: 'approval', ids: ['TB-34', 'TB-45'], drive: (ctx, p) => teamDrive(ctx, p, PROMPTS.APPROVAL),
    check: (ctx, take, notes) => teamChecks(ctx, 'approval', take, notes),
    unmet: (take) => take.cards.length === 0 ? 'no background approval card appeared' : null },
  { name: 'stop', ids: ['TB-89'], drive: stopDrive, check: stopChecks },
  { name: 'lookback', ids: ['TB-59'], drive: lookbackDrive, check: lookbackChecks },
  { name: 'catchup', ids: ['TB-60'], drive: catchupDrive, check: catchupChecks },
];

/** @brief 跑一个驱动：前提没满足时换一个新项目重跑，最多 ATTEMPTS 次；然后核对最后一次。 */
async function runDrive(ctx, drive) {
  const notes = [];
  let take = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      take = await drive.drive(ctx, await newProject(ctx, drive.name));
      take.unmet ??= drive.unmet?.(take) ?? null;
    } catch (error) {
      take = { ...take, unmet: `flow: ${oneLine(error, 300)}` };
    }
    await shot(ctx, `${drive.name}-${attempt}`);
    if (!take.unmet) break;
    notes.push(`attempt ${attempt}: ${take.unmet}`);
  }
  if (notes.length) console.log(`[tb-real] ${drive.name}: ${notes.join('; ')}`);
  if (take.unmet) {
    for (const id of drive.ids) {
      record(`${id} real ${drive.name}: the drive's precondition holds within ${ATTEMPTS} attempts`, false,
        notes.join('; '));
    }
  }
  if (take.who) await drive.check(ctx, take, notes);
}

const ctx = { exePath, pageErrors: [], appLog: [], projects: [] };
try {
  if (!source) throw new Error('Missing --source <Mori data dir with the two real providers>');
  ctx.found = realProvidersOf(source);
  const { first, second } = ctx.found;
  record(`TB-45 real setup: two real providers ${refOf(first)} and ${refOf(second)}`, first.id !== second.id,
    `${first.name}, ${second.name}`);
} catch (error) {
  record('TB-45 real setup: the data dir has two real providers (model spec §14.1)', false, oneLine(error, 600));
}
if (ctx.found) {
  const data = prepareRealData(source, ctx.found, PROXY);
  ctx.userData = data.userData;
  try {
    ctx.proxy = await startForwardProxy(PROXY, data.routes);
    await startTbApp(ctx);
    await ctx.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
    await captureOrder(ctx);
    await watchTaskPhases(ctx);
    for (const drive of DRIVES.filter((d) => !only || only.includes(d.name))) await runDrive(ctx, drive);
  } catch (error) {
    record('TB-45 real: flow', false, oneLine(error, 600));
    await shot(ctx, 'flow-error');
  } finally {
    // Mori 先关掉连接（模型规格 §5.7 发出后超时等）随之中止的转发不算转发失败，记在 detail 的 aborted 里
    record('TB-45 real: the page has no errors and the proxy forwarded every request', ctx.pageErrors.length === 0
      && (ctx.proxy?.errors.length ?? 0) === 0, brief({ page: ctx.pageErrors.slice(0, 3),
      proxy: ctx.proxy?.errors.slice(0, 3), aborted: ctx.proxy?.aborted.slice(0, 3) }));
    await closeTbApp(ctx);
    stopForwardProxy(ctx.proxy);
    rmSync(join(ctx.userData, 'credentials.json'), { force: true });
    console.log(`[tb-real] data in ${ctx.userData} (credentials.json removed); projects in ${ctx.projects.join(', ')}`);
  }
}
await sleep(200);
process.exitCode = write(only ? `tb-partial-real${suffix}.json` : `tb-real${suffix}.json`) ? 0 : 1;
