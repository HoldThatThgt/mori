// 平行 Agent 与 TaskBoard 的真实模型一层（docs/specs/parallel-agents-taskboard.md §17.1“真实模型一层”、§17.2 的
// TB-04、TB-08、TB-34、TB-37、TB-45）：真正的 Mori 对负责人的两个真实模型（默认 DeepSeek 与 GLM，都是 C 级），全部经界面操作。
// 准备（synthetic test setup，见 tb-real-helpers.mjs）：复制数据目录（只复制加密的文件，不读 key，不写来源目录）；
// 分组 [DeepSeek, GLM] 为默认范围；两个提供商的地址改指本机 4690 端口上的转发代理（只记请求体，
// 用来看发给模型的工具）；角色文件 executor、reviewer（reviewer 的 models 是第二个提供商），基座持有对话、立项与结案。
// 三个驱动（§17.1），每个在自己的临时项目和会话里：
//   ask：关闭模式下让对话用 agent_message 问 reviewer 一个问题（临时提问）。
//   team：/team 让 executor 修好失败的测试（只改 sum.js）并跑 npm test、reviewer 复核；“Ask each time”，出现的后台批准卡都允许。
//   approval：“Ask each time”下 /team 让 executor 运行 node --version（task 跑命令，出后台批准卡），允许。
// 检查只断言程序保证的事（§17.1 的列表）：回执与 board.json 的写入一一对应；每个交接的证据编号都在那个实例会话里；
// 对话会话的请求里没有写入类工具；后台批准卡写明角色与 task；每个实例的每次运行结束后 task 处于 §9.4 规定的状态，
// 每个 task 到了终态、waiting_user 或交给结案；进展摘要的需求与 task 标题等于 board.json 里的，task 行的当前在做什么等于
// 那个实例会话最近一次工具调用的 §13.8 标题；临时提问的实例会话只读、不进侧栏。模型怎么做（是否登记、是否关闭需求、
// 回答的内容、用了哪个模型）只写进结果的 note。前提没满足（对话没调 agent_message、没出批准卡、需求 15 分钟内没到终态）
// 时最多重跑 2 次，记在 note 里；仍不满足按失败。15 分钟只是驱动脚本的时限。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs real）：
//   MORI_APP_DIR=.tb-runs/real node tests/ui/tb-real.mjs --source <数据目录> [--exe <Mori.exe>] [--only ask,team,approval]
// 结果写到 test-results/tb-real(-packaged).json（--only 时 tb-partial-real…，不计入覆盖检查），截图在 test-results/tb-real/。

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  approvalCardsOf, bridge, captureOrder, closeTbApp, contentText, customOf, instanceFiles, kernelEvents, liveInfo,
  messagesOf, openProject, paneSel, paneState, phasesOf, readBoard, readJsonl, receiptsOf, sendMessage, startTbApp,
  userSession, waitTeamIdle, watchTaskPhases,
} from './tb-helpers.mjs';
import {
  approvalProblems, ASK_FORBIDDEN, chatRequests, evidenceProblems, prepareRealData, progressProblems, PROMPTS,
  realProvidersOf, receiptProblems, refOf, routingProblems, startForwardProxy, stopForwardProxy, sumProject, TB_GROUP,
  unsettledTasks, WRITE_TOOLS, writeRealRoles,
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
 * @brief team / approval：发 /team <文字>，界面上出现的后台批准卡都点“Allow once”（记下卡与对应的事件），
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

/** @brief ask 的检查（TB-04、TB-45）：临时提问只读、回答成为工具结果、回答完就结束、不进侧栏、候选是被问角色的。 */
async function askChecks(ctx, take, notes) {
  const { who, calls } = take;
  const asks = instanceFiles(ctx, who.sessionId).filter((i) => i.first?.data?.kind === 'ask');
  const requests = chatRequests(ctx.proxy, { since: who.since, cwd: who.project }).filter((r) => r.info.kind === 'ask');
  const usedTools = asks.flatMap((i) => messagesOf(i.entries, 'assistant')).flatMap((m) => (m.content ?? [])
    .filter((p) => p.type === 'toolCall').map((p) => p.name));
  const readOnly = requests.length > 0 && requests.every((r) => !r.tools.some((t) => ASK_FORBIDDEN.includes(t)))
    && !usedTools.some((t) => ASK_FORBIDDEN.includes(t));
  const note = `${notes.join('; ')}${notes.length ? '; ' : ''}model: ${brief({
    asked: calls.map((c) => c.call.arguments), used: modelsUsed(requests), tools: [...new Set(usedTools)],
    ms: take.ms }, 600)}`;
  for (const id of ['TB-04', 'TB-45']) {
    record(`${id} real ask: the ask instance is read-only — every request it sends has no bash, edit, write or `
      + 'agent_message (only read tools), and its session never calls them', readOnly && asks.length === calls.length,
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
  const writes = dialog.filter((r) => r.tools.some((t) => WRITE_TOOLS.includes(t)));
  record(`TB-45 real ${name}: the dialog session's requests in team mode (${dialog.length}) carry no write or command `
    + 'tool (no bash, powershell, edit, write)', dialog.length > 0 && writes.length === 0,
  `${brief({ tools: [...new Set(dialog.map((r) => r.tools.join(',')))], writes: writes.length })} — ${note}`);
  const unsettled = unsettledTasks(board);
  record(`TB-45 real ${name}: after every run of every instance the task is where §9.4 puts it (a handoff routes by `
    + '§7.1; no handoff or an error goes to close, after the forced fill), and every task ended, waits for the user '
    + 'or is with close', routing.problems.length === 0 && unsettled.length === 0 && (board?.tasks.length ?? 0) > 0,
  `${brief({ problems: routing.problems, unsettled })} — ${note}`);
  await progressChecks(ctx, { name, who, board, instances, note });
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

/** @brief TB-37：进展摘要的标题与 task 行等于 board.json 的标题；running 行等于那个实例最近一次工具调用的标题。 */
async function progressChecks(ctx, { name, who, board, instances, note }) {
  const info = await liveInfo(ctx, who.sessionFile);
  const seen = await phasesOf(ctx, who.tab, who.since);
  const { problems, checked } = progressProblems(board, seen, { instances, cwd: who.project,
    seatRoles: [info.team.holders.create, info.team.holders.close] });
  const titles = seen.filter((item) => item.request !== undefined).length;
  record(`TB-37 real ${name}: the progress summary's request and task titles equal the titles in board.json, and each `
    + `running task row shows the §13.8 title of that instance session's latest tool call (${checked} running rows `
    + 'checked)', problems.length === 0 && titles > 0 && checked > 0,
  `${brief({ problems: problems.slice(0, 6), rows: [...new Set(seen.map((s) => s.text))].slice(0, 30) }, 2500)}`
    + ` — ${note}`);
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

// ---------- 执行 ----------

/** 驱动：名字、做一次、核对、前提没满足时记失败的编号 */
const DRIVES = [
  { name: 'ask', ids: ['TB-04', 'TB-45'], drive: askDrive, check: askChecks },
  { name: 'team', ids: ['TB-08', 'TB-37', 'TB-45'], drive: (ctx, p) => teamDrive(ctx, p, PROMPTS.TEAM),
    check: (ctx, take, notes) => teamChecks(ctx, 'team', take, notes) },
  { name: 'approval', ids: ['TB-34', 'TB-45'], drive: (ctx, p) => teamDrive(ctx, p, PROMPTS.APPROVAL),
    check: (ctx, take, notes) => teamChecks(ctx, 'approval', take, notes),
    unmet: (take) => take.cards.length === 0 ? 'no background approval card appeared' : null },
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
    record('TB-45 real: the page has no errors and the proxy forwarded every request', ctx.pageErrors.length === 0
      && (ctx.proxy?.errors.length ?? 0) === 0, brief({ page: ctx.pageErrors.slice(0, 3),
      proxy: ctx.proxy?.errors.slice(0, 3) }));
    await closeTbApp(ctx);
    stopForwardProxy(ctx.proxy);
    rmSync(join(ctx.userData, 'credentials.json'), { force: true });
    console.log(`[tb-real] data in ${ctx.userData} (credentials.json removed); projects in ${ctx.projects.join(', ')}`);
  }
}
await sleep(200);
process.exitCode = write(only ? `tb-partial-real${suffix}.json` : `tb-real${suffix}.json`) ? 0 : 1;
