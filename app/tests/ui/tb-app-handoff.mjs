// 平行 Agent 与 TaskBoard 的 App 套件：交接（docs/specs/parallel-agents-taskboard.md §17.2）。真正的 Mori（界面 + 后台进程
// + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/handoff.mjs，synthetic），逐条验收
// TB-14（交接路由）、TB-15（一回合一次交接）、TB-16（证据）、TB-17（改过代码不能给自己写通过）、TB-18（强制填写）、
// TB-19（兜底交给结案）、TB-20（需要用户拿主意）、TB-31（结案与需求关闭）在 App 层的通过条件。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs handoff）：
//   MORI_APP_DIR=.tb-runs/handoff node tests/ui/tb-app-handoff.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-handoff(-packaged).json（--only 时 tb-partial-app-handoff…），截图在
// test-results/tb-app-handoff/。端口：合成端点 4630，记录代理 4631（看完整的请求体）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好两个本机提供商与它们的模型档案（跳过探针）：tbh 只有
// fake-tbh-a（写入等级 A、能关思考、开思考），tbx 是各种写入等级的模型（A 不能关思考、A 不能关思考且 B 也不过、B、C、
// 没有等级、换模型的一对、总是 404 的一个）；三个临时项目：分开配置（chat / planner 持有立项与结案 / executor / reviewer）、
// 写入等级配置（chat / planner 立项 / closer 结案用 C 级 / 每种等级一个 exec-* 角色）、没有角色文件（合并会话）。
// 步骤各用自己的会话；renum 一步最后跑：在 task 运行中重启 App，重新打开后看证据编号接着排。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HANDOFF_TEXT } from '../fake-endpoint/scenarios/handoff.mjs';
import {
  bridge, brief, captureOrder, closeTbApp, contentText, customOf, instanceFiles, instanceSuffix, kernelEvents,
  lineBrief, messagesOf, missingSteps, openSessionIn, paneState, poll, progressOf, readBoard, readJsonl, reopenSession,
  restartTbApp, scenarioLines, scenarioRequests, sendMessage, setProgressOpen, shot, sleep, SPLIT_ROLES, startTbApp,
  startTbEndpoint, stopTbEndpoint, suiteArgs, tbModel, tbProvider, tbRecorder, tempProject, tempUserData,
  transcriptItems, userSession, allowAll, seedTeamUserData, waitTaskPhase, waitTeamIdle, watchTaskPhases, writeRoles,
} from './tb-helpers.mjs';

const args = suiteArgs('handoff');
const { record, finish } = tbRecorder(args);

/** 本套件的端口（§17.1 的 4600–4699 里分给它的 4630–4639）：合成端点与它前面的记录代理 */
const PORT = 4630;
const PROXY = 4631;
/** 分开配置与默认范围用的模型（synthetic）：写入等级 A、能关思考、开思考 */
const MAIN = 'fake-tbh-a';
/** 写入等级配置的模型（synthetic）：id → tbProfile 的选项与是否开思考 */
const TIER_MODELS = {
  'fake-tbx-anod': { tier: 'A', canDisable: false, reasoning: true },
  'fake-tbx-anodc': { tier: 'A', canDisable: false, bPass: false, reasoning: true },
  'fake-tbx-b': { tier: 'B', canDisable: true },
  'fake-tbx-c': { tier: 'C', canDisable: true },
  'fake-tbx-none': { tier: null, canDisable: true },
  'fake-tbx-sw1': { tier: 'A', canDisable: true, reasoning: true },
  'fake-tbx-sw2': { tier: 'B', canDisable: true },
  'fake-tbx-gone': { tier: 'A', canDisable: true },
};
/** 写入等级配置的角色（synthetic）：对话、立项、结案（C 级）与每种等级一个做 task 的角色 */
const TIER_ROLES = [
  { name: 'chat', description: 'Talks with the user', seats: ['dialog'] },
  { name: 'planner', description: 'Splits each request into tasks', seats: ['create'] },
  { name: 'closer', description: 'Checks returned tasks and closes requests', seats: ['close'],
    models: ['tbx/fake-tbx-c'] },
  { name: 'exec-a', description: 'Works on tier A', models: [`tbh/${MAIN}`] },
  { name: 'exec-anod', description: 'Works on tier A without thinking off', models: ['tbx/fake-tbx-anod'] },
  { name: 'exec-anodc', description: 'Works on tier A, B fails', models: ['tbx/fake-tbx-anodc'] },
  { name: 'exec-b', description: 'Works on tier B', models: ['tbx/fake-tbx-b'] },
  { name: 'exec-c', description: 'Works on tier C', models: ['tbx/fake-tbx-c'] },
  { name: 'exec-none', description: 'Works on a model without a tier', models: ['tbx/fake-tbx-none'] },
  { name: 'exec-sw', description: 'Works on two models', models: ['tbx/fake-tbx-sw1', 'tbx/fake-tbx-sw2'] },
  { name: 'exec-gone', description: 'Works on a model that is gone', models: ['tbx/fake-tbx-gone'] },
];
/** 程序给的固定文字（§7.1、§7.3、§7.5、§7.6、§8.5） */
const HANDED_OFF = (task) => `You handed off ${task}; stop here.`;
const FORCED_TASK = (task) => `[Mori] Your turn ended without task_handoff. Hand off ${task} now.`;
const FORCED_CLOSE = (task) => `[Mori] ${task} was handed to you and you didn't decide. Hand it off now.`;
const RETRY = '[Mori] Your handoff could not be used: ';
const ONLY_FORM = 'Only task_handoff works in this turn; call it now.';
const NEEDS_EVIDENCE = (outcome) => `${outcome} needs evidence: the number of a tool result that shows it works.`;
const ALL_ENDED = '[Mori] All tasks of request 1 have ended. Close it with request_close';
const FORCED_REQUEST = '[Mori] All tasks of request 1 have ended and it is still open. '
  + 'Close it now with request_close.';
const NOT_CLOSED = "Request 1 has no open tasks and planner didn't close it";

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 会话文件里 pi 消息的文字。 */
const textOf = (message) => contentText(message?.content);
/** @brief 会话文件里某个工具的工具结果（toolResult 消息），按顺序；tool 为 null 时全部。 */
const toolResults = (entries, tool = null) => messagesOf(entries)
  .filter((m) => m.role === 'toolResult' && (tool === null || m.toolName === tool));
/** @brief 工具结果的简写（detail）。 */
const resultBrief = (results) => results.map((m) => `${m.toolName}${m.isError ? '✗' : '✓'}:${textOf(m).slice(0, 90)}`);
/** @brief 实例会话里的投递（user 消息）的文字。 */
const deliveriesIn = (file) => (file ? messagesOf(file.entries, 'user').map(textOf) : []);
/** @brief 一个 task 在 board.json 里的样子。 */
const taskOf = (board, id) => board?.tasks.find((item) => item.id === id);
/** @brief 交接的简写 "<from>:<outcome>><去向>"（detail）。 */
const chainOf = (task) => (task?.handoffs ?? []).map((h) => `${h.from}:${h.outcome ?? h.reason}>${h.routedTo.kind}`
  + `${h.routedTo.role ? `:${h.routedTo.role}` : ''}${h.suggestedNext ? `(s:${h.suggestedNext})` : ''}`);
/** @brief 请求体里某个工具的定义（OpenAI 形状）。 */
const toolDef = (body, name) => (body?.tools ?? []).map((tool) => tool.function ?? tool)
  .find((tool) => tool.name === name);

/** @brief 这个用户会话的一条实例会话（按后缀，例如 t1.executor、close.1、create）。 */
function instance(ctx, who, suffix) {
  return instanceFiles(ctx, who.sessionId).find((file) => instanceSuffix(who.sessionId, file.id) === suffix) ?? null;
}

/** @brief 这个用户会话全部实例会话的后缀。 */
const suffixes = (ctx, who) => instanceFiles(ctx, who.sessionId).map((file) => instanceSuffix(who.sessionId, file.id))
  .sort();

/** @brief 端点日志里某个会话的行（脚本 scenario）。 */
const linesOf = (ctx, scenario, agent, kind, task) => scenarioLines(ctx.ep, scenario,
  { agent, kind, ...(task === undefined ? {} : { task }) });

/** @brief 强制写法的请求（A 指定调用、B 结构化输出）。 */
const forcedLines = (lines) => lines.filter((line) => line.toolChoice !== null || line.format !== null);

/** @brief 记录代理收到的某个会话第 k 次投递、第 j 步的请求。 */
function requestAt(ctx, scenario, where, k, j = 0) {
  return scenarioRequests(ctx.ep, scenario, where).find((item) => item.info.k === k && item.info.j === j) ?? null;
}

/** @brief 后台进程发给这个用户会话的 mori.wake（种类与文字）。 */
async function wakesOf(ctx, who) {
  return (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since)).map((item) => item.data)
    .filter((data) => data.text !== undefined);
}

// ---------- 准备与会话 ----------

/** @brief 测试准备（synthetic test setup）：三个临时项目、角色文件，数据目录与合成端点。 */
async function setup(ctx) {
  ctx.split = tempProject('mori-tb-handoff-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  ctx.tiers = tempProject('mori-tb-handoff-tiers-');
  writeRoles(ctx.tiers, TIER_ROLES);
  ctx.merged = tempProject('mori-tb-handoff-merged-');
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  const tierModels = Object.entries(TIER_MODELS).map(([id, opts]) => tbModel(id, { reasoning: opts.reasoning }));
  const profiles = { [`tbh/${MAIN}`]: { tier: 'A', canDisable: true } };
  for (const [id, opts] of Object.entries(TIER_MODELS)) profiles[`tbx/${id}`] = opts;
  seedTeamUserData(ctx.userData, { providers: [
    tbProvider('tbh', PROXY, [tbModel(MAIN, { reasoning: true })], { concurrency: 8 }),
    tbProvider('tbx', PROXY, tierModels, { concurrency: 8 }),
  ], normalDefault: 'tbh', profiles });
  await startApp(ctx);
}

/** @brief 启动 App，装上事件顺序与 task 行的记录。 */
async function startApp(ctx) {
  await startTbApp(ctx);
  await captureOrder(ctx);
  await watchTaskPhases(ctx);
}

/**
 * @brief 在 project 里开一个新会话（可先切到全部允许），用 /team 发第一条消息；返回 { tab, sessionId, sessionFile, since }。
 */
async function begin(ctx, project, text, { allow = false } = {}) {
  const tab = await openSessionIn(ctx, project);
  if (allow) await allowAll(ctx, tab);
  const since = Date.now();
  await sendMessage(ctx, tab, text, { team: true });
  return { tab, ...(await userSession(ctx, tab)), since };
}

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/** @brief 等 board.json 满足 test（最多 timeout），返回那一刻的 board；超时报错。 */
async function boardWhen(ctx, who, test, timeout = 60000) {
  let board = null;
  const ok = await poll(() => {
    board = readBoard(ctx, who.sessionId);
    return board !== null && test(board);
  }, timeout, 100);
  if (!ok) throw new Error(`board of ${who.tab} never reached the expected state: ${brief(board?.tasks, 400)}`);
  return board;
}

// ---------- TB-14：交接路由 ----------

/** @brief task 实例的路由（脚本 tb-handoff-route）：§7.1 表的前四行，按顺序。 */
async function route(ctx) {
  const who = await begin(ctx, ctx.split, 'Route five tasks tb-scenario:tb-handoff-route');
  await boardWhen(ctx, who, (board) => taskOf(board, 'T5')?.asked === true
    && ['T1', 'T2', 'T3', 'T4'].every((id) => taskOf(board, id)?.status === 'done'), 90000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const close = deliveriesIn(instance(ctx, who, 'close.1'));
  const toClose = ['T1', 'T2', 'T3'].map((id, i) => {
    const first = taskOf(board, id)?.handoffs[0];
    const outcome = ['done', 'pass', 'blocked'][i];
    return first?.outcome === outcome && first.next === 'reviewer' && first.routedTo.kind === 'close'
      && first.suggestedNext === 'reviewer' && taskOf(board, id).handoffs[1]?.from === 'close:planner'
      && close.some((text) => text.startsWith(`[Mori] ${id} was handed to you: executor handed it off (${outcome})`));
  });
  record('TB-14 row 2: done, pass and blocked with next written still go to close and next is kept as suggestedNext '
    + '(T1 done, T2 pass, T3 blocked, each with next reviewer: routedTo close, suggestedNext reviewer, the close '
    + 'session gets "[Mori] Tn was handed to you: executor handed it off (<outcome>)"); reviewer never works on them',
  toClose.every(Boolean) && !suffixes(ctx, who).some((s) => /^t[123]\.reviewer$/.test(s)),
  brief({ toClose, T1: chainOf(taskOf(board, 'T1')), T2: chainOf(taskOf(board, 'T2')),
    T3: chainOf(taskOf(board, 'T3')), files: suffixes(ctx, who), close: close.map((t) => t.slice(0, 70)) }));
  routeChain(ctx, who, board, close);
  routeNeedUser(ctx, who, board);
}

/** @brief TB-14 第 3、4 行：continue、dead_end、fail 写了 next 交给 next；没写 next 交给结案。 */
function routeChain(ctx, who, board, close) {
  const t4 = taskOf(board, 'T4');
  const h = t4?.handoffs ?? [];
  const executor = deliveriesIn(instance(ctx, who, 't4.executor'));
  const reviewer = deliveriesIn(instance(ctx, who, 't4.reviewer'));
  const roleRoute = (item, from, outcome, to) => item?.from === from && item.outcome === outcome
    && item.routedTo.kind === 'role' && item.routedTo.role === to && item.suggestedNext === null;
  record('TB-14 row 3: next written with continue, dead_end or fail hands the task to that role (T4: executor '
    + 'continue → reviewer, reviewer dead_end → executor, executor fail → reviewer; the executor and reviewer '
    + 'sessions on T4 each get "You are <role> on T4" then "T4 is back with you")',
  roleRoute(h[0], 'executor', 'continue', 'reviewer') && roleRoute(h[1], 'reviewer', 'dead_end', 'executor')
    && roleRoute(h[2], 'executor', 'fail', 'reviewer') && executor.length === 2 && reviewer.length === 2
    && executor[0].startsWith('[Mori] You are executor on T4') && executor[1].startsWith('[Mori] T4 is back with you.')
    && reviewer[0].startsWith('[Mori] You are reviewer on T4') && reviewer[1].startsWith('[Mori] T4 is back with you.'),
  brief({ chain: chainOf(t4), executor: executor.map((t) => t.slice(0, 40)),
    reviewer: reviewer.map((t) => t.slice(0, 40)) }));
  record('TB-14 row 4: a handoff without next (reviewer continue on T4) goes to close; close then ends T4',
    h[3]?.from === 'reviewer' && h[3].outcome === 'continue' && h[3].next === null && h[3].routedTo.kind === 'close'
    && h[4]?.from === 'close:planner' && t4.status === 'done'
    && close.some((text) => text.startsWith('[Mori] T4 was handed to you: reviewer handed it off (continue)')),
    brief({ chain: chainOf(t4) }));
}

/** @brief TB-14 第 1 行：need_user 排在最前（写了 next 也交给立项，next 记为建议）。 */
function routeNeedUser(ctx, who, board) {
  const t5 = taskOf(board, 'T5');
  const h = t5?.handoffs[0];
  const create = deliveriesIn(instance(ctx, who, 'create'));
  const woke = create.some((text) => text.includes('[Mori] T5 needs a decision from the user: '
    + `${HANDOFF_TEXT.routeQuestion} (from executor).`));
  record('TB-14 row 1 comes first: need_user with next written goes to create — T5 waiting_user, question = the '
    + 'conclusion, holder stays executor (the asker), routedTo create with next kept only as suggestedNext, and the '
    + 'create session is woken with "[Mori] T5 needs a decision from the user: … (from executor)."',
  t5?.status === 'waiting_user' && t5.question === HANDOFF_TEXT.routeQuestion && t5.holder?.kind === 'role'
    && t5.holder.role === 'executor' && h?.outcome === 'need_user' && h.routedTo.kind === 'create'
    && h.suggestedNext === 'reviewer' && woke, brief({ t5: t5 && { status: t5.status, question: t5.question,
    holder: t5.holder }, chain: chainOf(t5), create: create.map((t) => t.slice(-160)) }));
}

/** @brief 结案会话的四种结果（脚本 tb-handoff-closeres）。 */
async function closeResults(ctx) {
  const who = await begin(ctx, ctx.split, 'Four close results tb-scenario:tb-handoff-closeres');
  await boardWhen(ctx, who, (board) => taskOf(board, 'T1')?.status === 'done' && taskOf(board, 'T4')?.asked === true,
    90000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const results = toolResults(instance(ctx, who, 'close.1')?.entries ?? [], 'task_handoff');
  const t1 = taskOf(board, 'T1');
  record('TB-14 close continue without next is refused ("continue needs next (the role to reassign to).") and '
    + 'nothing is recorded; continue + next reviewer reassigns T1 to reviewer (assignee becomes reviewer, the '
    + 'reviewer session on T1 starts)', results[0]?.isError === true
    && textOf(results[0]).startsWith('continue needs next (the role to reassign to).') && results[1]?.isError === false
    && t1?.handoffs[1]?.from === 'close:planner' && t1.handoffs[1].outcome === 'continue'
    && t1.handoffs[1].routedTo.role === 'reviewer' && t1.assignee === 'reviewer' && t1.handoffs[2]?.from === 'reviewer'
    && deliveriesIn(instance(ctx, who, 't1.reviewer'))[0]?.startsWith('[Mori] You are reviewer on T1'),
  brief({ results: resultBrief(results.slice(0, 2)), chain: chainOf(t1), assignee: t1?.assignee }));
  const t4 = taskOf(board, 'T4');
  const create = deliveriesIn(instance(ctx, who, 'create'));
  record('TB-14 the four results of the close session: close_done ends T2 done, close_failed ends T3 failed, '
    + 'continue + next reassigns T1, need_user sends T4 to create (waiting_user, holder close, question = conclusion, '
    + 'create woken "… (from close:planner)."); T1 back from reviewer is closed done',
  taskOf(board, 'T2')?.status === 'done' && taskOf(board, 'T3')?.status === 'failed' && t1?.status === 'done'
    && t4?.status === 'waiting_user' && t4.holder?.kind === 'close' && t4.question === HANDOFF_TEXT.closeQuestion
    && t4.handoffs.at(-1)?.routedTo.kind === 'create'
    && create.some((text) => text.includes(`T4 needs a decision from the user: ${HANDOFF_TEXT.closeQuestion} `
      + '(from close:planner).')),
  brief({ T2: chainOf(taskOf(board, 'T2')), T3: chainOf(taskOf(board, 'T3')), T4: chainOf(t4),
    create: create.map((t) => t.slice(-140)) }));
  closeSchema(ctx);
}

/** @brief TB-14：结案会话的 task_handoff schema 里没有证据（task 实例的有）。 */
function closeSchema(ctx) {
  const closeReq = scenarioRequests(ctx.ep, 'tb-handoff-closeres', { agent: 'planner', kind: 'close' })[0];
  const taskReq = scenarioRequests(ctx.ep, 'tb-handoff-closeres', { agent: 'executor', kind: 'task' })[0];
  const closeProps = Object.keys(toolDef(closeReq?.body, 'task_handoff')?.parameters?.properties ?? {});
  const taskProps = Object.keys(toolDef(taskReq?.body, 'task_handoff')?.parameters?.properties ?? {});
  record('TB-14 the close session\'s task_handoff schema has no evidence (its properties are task, conclusion, '
    + 'outcome, next), while a task instance\'s has evidence',
  closeProps.length > 0 && !closeProps.includes('evidence') && closeProps.includes('task')
    && closeProps.includes('outcome') && taskProps.includes('evidence'), brief({ closeProps, taskProps }));
}

// ---------- TB-15：一回合一次交接 ----------

/** @brief task 实例交接之后的调用被拒绝；结案一次运行里关闭 T1、T2 并关闭需求（脚本 tb-handoff-once）。 */
async function once(ctx) {
  const who = await begin(ctx, ctx.split, 'One handoff per turn tb-scenario:tb-handoff-once');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 90000);
  await settle(ctx, who, 60000);
  const scn = 'tb-handoff-once';
  const t1Lines = linesOf(ctx, scn, 'executor', 'task', 'T1');
  const t1 = toolResults(instance(ctx, who, 't1.executor')?.entries ?? []);
  record('TB-15 a call after task_handoff in the same batch ([task_handoff, read]) is refused with "You handed off T1; '
    + 'stop here." and ends the run: the endpoint gets no request after that batch',
  same(t1Lines.map((line) => line.calls), [['read'], ['task_handoff', 'read']]) && t1.length === 3
    && t1[1].toolName === 'task_handoff' && !t1[1].isError && t1[2].toolName === 'read' && t1[2].isError
    && textOf(t1[2]).includes(HANDED_OFF('T1')), brief({ lines: lineBrief(t1Lines), results: resultBrief(t1) }));
  const t2Lines = linesOf(ctx, scn, 'executor', 'task', 'T2');
  const t2 = toolResults(instance(ctx, who, 't2.executor')?.entries ?? []);
  record('TB-15 when the handoff is not the last call of its batch ([read, task_handoff]) the endpoint gets exactly '
    + 'one more request, every call in it ([read, read]) is refused with "You handed off T2; stop here." and the run '
    + 'ends (no third request)', same(t2Lines.map((line) => line.calls), [['read', 'task_handoff'], ['read', 'read']])
    && t2.length === 4 && !t2[0].isError && !t2[1].isError && t2.slice(2).every((m) => m.isError
      && textOf(m).includes(HANDED_OFF('T2'))), brief({ lines: lineBrief(t2Lines), results: resultBrief(t2) }));
  onceClose(ctx, who);
}

/** @brief TB-15：结案会话一次运行里关闭 T1、T2 并关闭需求。 */
function onceClose(ctx, who) {
  const lines = linesOf(ctx, 'tb-handoff-once', 'planner', 'close');
  const results = toolResults(instance(ctx, who, 'close.1')?.entries ?? []);
  const board = readBoard(ctx, who.sessionId);
  record('TB-15 the close session closes T1 and T2 and then the request in one run: all its requests are delivery 1 '
    + '(task_handoff T1, task_handoff T2, request_close, reply), the three calls succeed, both tasks are done and '
    + 'request 1 is done; T2\'s own delivery to close is dropped as stale',
  lines.length === 4 && lines.every((line) => line.k === 1) && same(lines.map((line) => line.calls),
    [['task_handoff'], ['task_handoff'], ['request_close'], []]) && results.length === 3
    && results.every((m) => !m.isError) && taskOf(board, 'T1')?.status === 'done'
    && taskOf(board, 'T2')?.status === 'done' && board.requests[0].status === 'done',
  brief({ lines: lineBrief(lines), results: resultBrief(results) }));
}

/** @brief TB-19：运行中才交给结案的 task 不算没处理（脚本 tb-handoff-midrun）。 */
async function midRun(ctx) {
  const who = await begin(ctx, ctx.split, 'Two reads tb-scenario:tb-handoff-midrun');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 90000);
  await settle(ctx, who, 60000);
  const lines = linesOf(ctx, 'tb-handoff-midrun', 'planner', 'close');
  const close = deliveriesIn(instance(ctx, who, 'close.1'));
  const board = readBoard(ctx, who.sessionId);
  const t2At = taskOf(board, 'T2')?.handoffs[0]?.at ?? 0;
  const run1 = lines.filter((line) => line.k === 1);
  record('TB-19 a task handed to close while its run is going is not "undecided": T2 reaches close during close\'s '
    + 'first run (which decides only T1), no forced fill is delivered for T2, and the next run gets T2\'s normal '
    + 'delivery "[Mori] T2 was handed to you: …" and closes it',
  run1.length === 2 && t2At > run1[0].t && t2At < run1[1].t && close.length === 2
    && close[1].startsWith('[Mori] T2 was handed to you: executor handed it off (done)')
    && !close.some((text) => text.startsWith(FORCED_CLOSE('T2'))) && forcedLines(lines).length === 0
    && taskOf(board, 'T2')?.handoffs[1]?.from === 'close:planner',
  brief({ lines: lineBrief(lines), t2At: t2At - who.since, run1: run1.map((l) => l.t - who.since),
    close: close.map((t) => t.slice(0, 60)) }));
}

// ---------- TB-16、TB-17：证据 ----------

/** @brief 证据的编号、核对与改过代码的规则（脚本 tb-handoff-evidence，全部允许）。 */
async function evidence(ctx) {
  const who = await begin(ctx, ctx.split, 'Check the evidence rules tb-scenario:tb-handoff-evidence',
    { allow: true });
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 120000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const t1 = toolResults(instance(ctx, who, 't1.executor')?.entries ?? []);
  const tagged = t1.every((m, i) => textOf(m).startsWith(`[#${i + 1}] `));
  record('TB-16 every tool result of a task instance is numbered in the instance session file: the 11 results of '
    + 'T1 (reads, a failed command, the refused and the accepted task_handoff) start with [#1] … [#11] in order',
  t1.length === 11 && tagged && t1[2].toolName === 'bash' && t1[2].isError === true,
  brief(resultBrief(t1).map((text) => text.slice(0, 40))));
  const recent = 'recent ones: #2 Read src/a.ts ✓, #3 Run exit 3 ✗, #4 Read README.md ✓, #5 Read src/a.ts ✓, '
    + '#6 Read README.md ✓.';
  record('TB-16 a number that is not in the session is refused and the error lists the last 5 numbers with titles '
    + 'and ✓/✗ ("evidence: #99 is not a finished tool call in your session." / "… recent ones: #2 Read src/a.ts ✓, '
    + '#3 Run exit 3 ✗, …")', t1[6]?.isError === true
    && textOf(t1[6]).includes('evidence: #99 is not a finished tool call in your session.')
    && textOf(t1[6]).includes(recent), brief(textOf(t1[6])));
  const t2 = toolResults(instance(ctx, who, 't2.executor')?.entries ?? []);
  record('TB-16 a number of another session is refused: T2 cites #5, which exists only in T1\'s session; the error '
    + 'lists T2\'s own recent numbers (#1 Read README.md ✓, #2 Read src/a.ts ✓)',
  textOf(t1[4]).startsWith('[#5] ') && t2[2]?.isError === true
    && textOf(t2[2]).includes('evidence: #5 is not a finished tool call in your session.')
    && textOf(t2[2]).includes('recent ones: #1 Read README.md ✓, #2 Read src/a.ts ✓'), brief(resultBrief(t2)));
  record('TB-16 done and pass without an ok evidence are refused: done with no evidence, done citing only the failed '
    + 'command #3 and pass citing #3 get "<outcome> needs evidence: the number of a tool result that shows it works."',
  [[7, 'done'], [8, 'done'], [9, 'pass']].every(([i, outcome]) => t1[i]?.isError === true
    && textOf(t1[i]).includes(NEEDS_EVIDENCE(outcome))), brief(resultBrief(t1.slice(7, 10))));
  evidenceRecords(board, t1, t2);
  authorRule(ctx, who, board);
}

/** @brief TB-16：fail 引用失败的命令被接受；证据记下标题与 ok；#3、3、[#3] 三种写法都认。 */
function evidenceRecords(board, t1, t2) {
  const ev = (id) => (taskOf(board, id)?.handoffs[0]?.evidence ?? []).map((e) => ({ tag: e.tag, tool: e.toolName,
    title: e.title, ok: e.ok }));
  record('TB-16 fail citing the failed command is accepted, and each evidence keeps its title and ok: T1 fail with '
    + '["#3", "[#1]"] records #3 bash "Run exit 3" ✗ and #1 read "Read README.md" ✓; T2 done with ["1"] records #1 ✓',
  t1[10]?.isError === false && taskOf(board, 'T1')?.handoffs[0]?.outcome === 'fail' && same(ev('T1'), [
    { tag: '#3', tool: 'bash', title: 'Run exit 3', ok: false }, { tag: '#1', tool: 'read', title: 'Read README.md',
      ok: true }]) && t2[3]?.isError === false
    && same(ev('T2'), [{ tag: '#1', tool: 'read', title: 'Read README.md', ok: true }]),
  brief({ T1: ev('T1'), T2: ev('T2') }));
}

/** @brief TB-17：有过成功 edit、write 的实例写 pass 被拒绝；只跑过命令的可以。 */
function authorRule(ctx, who, board) {
  const results = (suffix) => toolResults(instance(ctx, who, suffix)?.entries ?? []);
  const t3 = results('t3.executor');
  const t4 = results('t4.executor');
  const t5 = results('t5.executor');
  record('TB-17 an instance with a successful edit cannot hand off pass: "You changed files on T3 (#1 Edit src/a.ts); '
    + 'another role must verify."; done is accepted after it', t3[0]?.toolName === 'edit' && !t3[0].isError
    && t3[1]?.isError === true
    && textOf(t3[1]).includes('You changed files on T3 (#1 Edit src/a.ts); another role must verify.')
    && t3[2]?.isError === false && taskOf(board, 'T3')?.handoffs[0]?.outcome === 'done', brief(resultBrief(t3)));
  record('TB-17 the same for a successful write: pass is refused with "You changed files on T4 (#1 <Write title>); '
    + 'another role must verify."', t4[0]?.toolName === 'write' && !t4[0].isError && t4[1]?.isError === true
    && /You changed files on T4 \(#1 [^)]*notes\.txt\); another role must verify\./.test(textOf(t4[1]))
    && taskOf(board, 'T4')?.handoffs[0]?.outcome === 'done', brief(resultBrief(t4)));
  const h5 = taskOf(board, 'T5')?.handoffs[0];
  record('TB-17 an instance that only ran a command can hand off pass (T5: bash "echo checked", pass with it as ok '
    + 'evidence)', t5[0]?.toolName === 'bash' && !t5[0].isError && t5[1]?.isError === false && h5?.outcome === 'pass'
    && h5.evidence[0]?.title === 'Run echo checked' && h5.evidence[0].ok === true, brief({ results: resultBrief(t5),
    h5: h5 && { outcome: h5.outcome, evidence: h5.evidence } }));
}

// ---------- TB-20：需要用户拿主意 ----------

/** @brief executor need_user → 立项 → 对话问你 → 你的回答 → 交回 executor（脚本 tb-handoff-need）。 */
async function needUser(ctx) {
  const who = await begin(ctx, ctx.split, 'Summarize a section tb-scenario:tb-handoff-need');
  const asked = await boardWhen(ctx, who, (board) => taskOf(board, 'T1')?.asked === true, 60000);
  await settle(ctx, who, 60000);
  const pane = await paneState(ctx.page, who.tab);
  await sendMessage(ctx, who.tab, HANDOFF_TEXT.needAnswer);
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 60000);
  await settle(ctx, who, 60000);
  const wakes = await wakesOf(ctx, who);
  const create = deliveriesIn(instance(ctx, who, 'create'));
  const relay = wakes.find((wake) => wake.kind === 'relay');
  const t1 = taskOf(asked, 'T1');
  record('TB-20 need_user wakes create, and the dialog asks you through a hidden delivery: T1 waiting_user (holder '
    + 'executor); create gets "[Mori] T1 needs a decision from the user: … (from executor)."; its reply_via_dialog '
    + 'becomes a relay mori.wake "[Mori] planner asks you to tell the user: …"; chat\'s question is shown, no bubble '
    + 'shows [Mori]', t1?.status === 'waiting_user' && t1.holder?.role === 'executor'
    && create.some((text) => text.includes(`T1 needs a decision from the user: ${HANDOFF_TEXT.needQuestion} `
      + '(from executor).')) && relay?.text.startsWith('[Mori] planner asks you to tell the user: Ask the user:')
    && pane.assistants.at(-1) === `Question for you: ${HANDOFF_TEXT.needQuestion}`
    && !pane.users.some((text) => text.includes('[Mori]')),
  brief({ t1: t1 && [t1.status, t1.holder], wakes: wakes.map((w) => `${w.kind}:${w.text.slice(0, 60)}`),
    last: pane.assistants.at(-1) }));
  needUserAnswer(ctx, who);
}

/** @brief TB-20：你的回答经立项记为补充并交回，提问的实例的会话继续、工作卡里有补充。 */
function needUserAnswer(ctx, who) {
  const board = readBoard(ctx, who.sessionId);
  const file = instance(ctx, who, 't1.executor');
  const deliveries = deliveriesIn(file);
  const second = requestAt(ctx, 'tb-handoff-need', { agent: 'executor', kind: 'task', task: 'T1' }, 2);
  const card = contentText(second?.messages.at(-1)?.content);
  const words = board?.requests[0]?.words.map((word) => `${word.kind}:${word.text}`) ?? [];
  const lines = linesOf(ctx, 'tb-handoff-need', 'planner', 'create').filter((line) => line.k === 3);
  record('TB-20 your answer goes through create: planner records it with request_update (a supplement) and hands T1 '
    + 'back with task_edit; the asking executor\'s own session continues (one t1.executor file: "You are executor on '
    + 'T1", then "T1 is back with you. The user answered; see User\'s words.") and its next request\'s work card '
    + 'lists the supplement under User\'s words; T1 then finishes',
  same(lines.map((line) => line.calls), [['request_update'], ['task_edit'], []])
    && words.at(-1) === `supplement:${HANDOFF_TEXT.needAnswer}` && deliveries.length === 2
    && deliveries[1].startsWith("[Mori] T1 is back with you.\nThe user answered; see User's words.")
    && card.includes('<mori-work-card>') && card.includes("User's words:")
    && card.includes(`"${HANDOFF_TEXT.needAnswer}"`) && taskOf(board, 'T1')?.status === 'done',
  brief({ calls: lines.map((line) => line.calls), words, deliveries: deliveries.map((t) => t.slice(0, 70)),
    card: card.slice(card.indexOf("User's words:"), card.indexOf("User's words:") + 200) }));
}

/** @brief reviewer 提问，立项什么都不做，程序请对话问你；回答后交回 reviewer（脚本 tb-handoff-review）。 */
async function reviewerAsks(ctx) {
  const who = await begin(ctx, ctx.split, 'Review a change tb-scenario:tb-handoff-review');
  const asked = await boardWhen(ctx, who, (board) => taskOf(board, 'T1')?.asked === true, 60000);
  const row = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'asked' }, 20000);
  await settle(ctx, who, 60000);
  const [block] = await progressOf(ctx, who.tab);
  const pane = await paneState(ctx.page, who.tab);
  const wakes = await wakesOf(ctx, who);
  const ask = wakes.find((wake) => wake.kind === 'ask_user');
  record('TB-20 when the create turn does nothing, Mori asks the dialog to ask you: a hidden ask_user mori.wake '
    + '"[Mori] T1 needs a decision from the user: … Ask the user.", T1 marked asked, the task row and the summary '
    + 'read "Needs your decision"', ask?.text === `[Mori] T1 needs a decision from the user: `
    + `${HANDOFF_TEXT.reviewQuestion} Ask the user.` && taskOf(asked, 'T1')?.asked === true
    && row === 'T1 Change and review · reviewer · Needs your decision' && block?.state === 'needs_decision'
    && block.title.includes(' · Needs your decision · ') && !pane.users.some((text) => text.includes('[Mori]')),
  brief({ ask: ask?.text, row, block: block && [block.state, block.title], users: pane.users }));
  await sendMessage(ctx, who.tab, HANDOFF_TEXT.reviewAnswer);
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 60000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const t1 = taskOf(board, 'T1');
  const reviewer = deliveriesIn(instance(ctx, who, 't1.reviewer'));
  record('TB-20 a reviewer\'s question goes back to reviewer: while waiting the holder is reviewer; after your answer '
    + 'T1 returns to the reviewer session (two deliveries, the second "T1 is back with you."), which hands off pass; '
    + 'the executor session on T1 is not resumed', taskOf(asked, 'T1')?.holder?.role === 'reviewer'
    && same(chainOf(t1), ['executor:continue>role:reviewer', 'reviewer:need_user>create', 'reviewer:pass>close',
      'close:planner:close_done>end']) && reviewer.length === 2 && reviewer[1].startsWith('[Mori] T1 is back with you.')
    && deliveriesIn(instance(ctx, who, 't1.executor')).length === 1,
  brief({ chain: chainOf(t1), reviewer: reviewer.map((t) => t.slice(0, 60)) }));
}

/** @brief 默认配置（合并会话）下 need_user 只问你一次（脚本 tb-handoff-mergedneed）。 */
async function mergedNeed(ctx) {
  const who = await begin(ctx, ctx.merged, 'Read the README tb-scenario:tb-handoff-mergedneed');
  const board = await boardWhen(ctx, who, (item) => taskOf(item, 'T1')?.asked === true, 60000);
  await settle(ctx, who, 60000);
  await sleep(1500);
  const wakes = await wakesOf(ctx, who);
  const pane = await paneState(ctx.page, who.tab);
  const asks = pane.assistants.filter((text) => text === HANDOFF_TEXT.mergedAsk);
  const lines = linesOf(ctx, 'tb-handoff-mergedneed', 'mori', 'merged-create');
  record('TB-20 default config (merged session): need_user asks you exactly once — one hidden create_wake '
    + '"[Mori] T1 needs a decision from the user: …", no ask_user delivery, one reply that asks, T1 asked; the user '
    + 'session gets no further delivery', same(wakes.map((wake) => wake.kind), ['create_wake'])
    && wakes[0].text.startsWith('[Mori] T1 needs a decision from the user: Which part of the README matters?')
    && asks.length === 1 && taskOf(board, 'T1')?.asked === true && Math.max(...lines.map((line) => line.k)) === 2
    && !pane.users.some((text) => text.includes('[Mori]')),
  brief({ wakes: wakes.map((w) => `${w.kind}:${w.text.slice(0, 60)}`), asks: asks.length, lines: lineBrief(lines) }));
}

// ---------- TB-19、TB-18：没交接、格式错误、依赖失败、结案没处理 ----------

/** @brief 程序写的一棒（from mori）。 */
const programBaton = (task, reason) => task?.handoffs.find((h) => h.from === 'mori' && h.reason === reason) ?? null;

/** @brief 没交接（含 next 写错被拒绝后没改正）→ 强制填写两次格式错误 → 交给结案（脚本 tb-handoff-nohandoff）。 */
async function noHandoff(ctx) {
  const who = await begin(ctx, ctx.split, 'A task that does not hand off tb-scenario:tb-handoff-nohandoff');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 90000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const file = instance(ctx, who, 't1.executor');
  const results = toolResults(file?.entries ?? [], 'task_handoff');
  const baton = programBaton(taskOf(board, 'T1'), 'no_handoff');
  record('TB-19 row "no handoff": a run that ends without a handoff — here its task_handoff named next "nobody", '
    + 'was refused by the parameter check and the model did not fix it — is force-filled, and when that fails Mori '
    + 'writes the baton itself: from mori, outcome null, reason no_handoff, routed to close, conclusion = the last '
    + 'text of the run', results[0]?.isError === true && textOf(results[0]).includes('next')
    && baton?.outcome === null && baton.routedTo.kind === 'close' && baton.conclusion === HANDOFF_TEXT.lastText
    && taskOf(board, 'T1')?.handoffs.length === 2 && taskOf(board, 'T1').handoffs[1].from === 'close:planner',
  brief({ first: resultBrief(results.slice(0, 1)), chain: chainOf(taskOf(board, 'T1')), baton }));
  const lines = linesOf(ctx, 'tb-handoff-nohandoff', 'executor', 'task', 'T1');
  const forced = forcedLines(lines);
  const deliveries = deliveriesIn(file);
  record('TB-18 a format error is delivered once more and then goes to close: the endpoint log has exactly two '
    + 'forced-write requests for T1 (delivery 2 and its retry 3, each the first request of its run, tool_choice '
    + 'task_handoff), the deliveries read "[Mori] Your turn ended without task_handoff. Hand off T1 now." then '
    + '"[Mori] Your handoff could not be used: …", and there is no fourth delivery',
  forced.length === 2 && same(forced.map((line) => [line.k, line.j, line.toolChoice]), [[2, 0, 'task_handoff'],
    [3, 0, 'task_handoff']]) && deliveries.length === 3 && deliveries[1].startsWith(FORCED_TASK('T1'))
    && deliveries[2].startsWith(RETRY) && deliveries[2].includes('Hand off T1 now.'),
  brief({ lines: lineBrief(lines), deliveries: deliveries.map((t) => t.slice(0, 80)) }));
}

/** @brief 依赖失败交给结案；结案的 A 级强制填写恰好一次强制请求（脚本 tb-handoff-depfail）。 */
async function depFail(ctx) {
  const who = await begin(ctx, ctx.split, 'Try then build tb-scenario:tb-handoff-depfail');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'failed', 90000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const t2 = taskOf(board, 'T2');
  const baton = programBaton(t2, 'dependency_failed');
  const close = deliveriesIn(instance(ctx, who, 'close.1'));
  record('TB-19 row "dependency failed": when T1 ends failed, T2 (depends on T1) is not handed to its assignee but '
    + 'to close with a program baton (from mori, reason dependency_failed); no executor session ever starts on T2',
  taskOf(board, 'T1')?.status === 'failed' && baton?.routedTo.kind === 'close' && baton.outcome === null
    && t2?.handoffs[0]?.reason === 'dependency_failed' && !suffixes(ctx, who).includes('t2.executor')
    && close.some((text) => text.startsWith('[Mori] T2 was handed to you:')) && t2.status === 'failed',
  brief({ T1: chainOf(taskOf(board, 'T1')), T2: chainOf(t2), files: suffixes(ctx, who) }));
  const lines = linesOf(ctx, 'tb-handoff-depfail', 'planner', 'close');
  const forced = forcedLines(lines);
  record('TB-18 close\'s A-tier forced fill makes exactly one forced request: close\'s first run did not decide T1, '
    + 'delivery 2 is "[Mori] T1 was handed to you and you didn\'t decide. Hand it off now." with tool_choice '
    + 'task_handoff and strict only on it; that single request decides T1 (close_failed) and ends the run',
  forced.length === 1 && forced[0].k === 2 && forced[0].toolChoice === 'task_handoff'
    && same(forced[0].strictTools, ['task_handoff']) && lines.filter((line) => line.k === 2).length === 1
    && close[1]?.startsWith(FORCED_CLOSE('T1'))
    && taskOf(board, 'T1')?.handoffs.at(-1)?.conclusion === 'Approach one does not work',
  brief({ lines: lineBrief(lines), forced: forced.map((l) => [l.k, l.toolChoice, l.strictTools]) }));
}

/** @brief 结案没处理：强制填写两次格式错误 → 交给立项（脚本 tb-handoff-undecided）。 */
async function undecided(ctx) {
  const who = await begin(ctx, ctx.split, 'A read for close tb-scenario:tb-handoff-undecided');
  await boardWhen(ctx, who, (board) => taskOf(board, 'T1')?.asked === true, 90000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const t1 = taskOf(board, 'T1');
  const baton = programBaton(t1, 'close_undecided');
  const forced = forcedLines(linesOf(ctx, 'tb-handoff-undecided', 'planner', 'close'));
  const create = deliveriesIn(instance(ctx, who, 'create'));
  const wakes = await wakesOf(ctx, who);
  record('TB-19 row "close did not decide": close\'s run ends without deciding T1 → forced fill (two forced requests: '
    + 'the fill and its retry, both malformed) → T1 goes to create as need_user with the question "planner didn\'t '
    + 'decide on T1" (holder close, program baton reason close_undecided); create is woken and, doing nothing, '
    + 'Mori asks the dialog to ask you', forced.length === 2 && same(forced.map((line) => line.k), [2, 3])
    && t1?.status === 'waiting_user' && t1.holder?.kind === 'close' && t1.question === "planner didn't decide on T1"
    && baton?.routedTo.kind === 'create' && create.some((text) => text.includes("[Mori] T1 needs a decision from the "
    + "user: planner didn't decide on T1 (from close:planner)."))
    && wakes.some((wake) => wake.kind === 'ask_user'),
  brief({ forced: lineBrief(forced), t1: t1 && [t1.status, t1.holder, t1.question], chain: chainOf(t1),
    wakes: wakes.map((w) => w.kind) }));
}

/** @brief 出错与候选耗尽（脚本 tb-handoff-errors，写入等级配置）。 */
async function errors(ctx) {
  const who = await begin(ctx, ctx.tiers, 'Two failing tasks tb-scenario:tb-handoff-errors');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 90000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const error = programBaton(taskOf(board, 'T1'), 'error');
  const noModel = programBaton(taskOf(board, 'T2'), 'no_model');
  const one = (suffix) => deliveriesIn(instance(ctx, who, suffix)).length;
  record('TB-19 row "error": a run that ends in an error (HTTP 400, not retried on another model) is handed to close '
    + 'by a program baton whose conclusion is the error text; there is no forced fill (one delivery)',
  error?.routedTo.kind === 'close' && error.outcome === null && error.conclusion.includes('Synthetic HTTP 400')
    && one('t1.exec-a') === 1 && taskOf(board, 'T1')?.status === 'done',
  brief({ error, deliveries: one('t1.exec-a') }));
  record('TB-19 row "no model": when the only candidate is excluded (404) the task is handed to close by a program '
    + 'baton (reason no_model) whose conclusion names each excluded candidate and why; no forced fill',
  noModel?.routedTo.kind === 'close' && noModel.conclusion.includes('tbx/fake-tbx-gone') && one('t2.exec-gone') <= 1
    && taskOf(board, 'T2')?.status === 'done', brief({ noModel, deliveries: one('t2.exec-gone') }));
}

// ---------- TB-18：各写入等级的强制填写 ----------

/** @brief 一个 task 实例的端点日志行与第 k 次投递的请求（脚本 tb-handoff-tiers）。 */
function tierView(ctx, role, task) {
  const where = { agent: role, kind: 'task', task };
  const lines = scenarioLines(ctx.ep, 'tb-handoff-tiers', where);
  return { lines, at: (k, j = 0) => requestAt(ctx, 'tb-handoff-tiers', where, k, j),
    k: (k) => lines.filter((line) => line.k === k) };
}

/** @brief 严格版本的 schema（§7.5）：全部字段 required、可选字段的类型含 null、additionalProperties 为假。 */
function strictSchema(schema, optional) {
  const props = schema?.properties ?? {};
  const types = (name) => [props[name]?.type].flat();
  return schema?.additionalProperties === false && same([...(schema.required ?? [])].sort(), Object.keys(props).sort())
    && optional.every((name) => types(name).includes('null')) && !types('conclusion').includes('null');
}

/** @brief 各写入等级（脚本 tb-handoff-tiers，写入等级配置）。 */
async function tiers(ctx) {
  const who = await begin(ctx, ctx.tiers, 'Force every tier tb-scenario:tb-handoff-tiers');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 150000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  tierA(ctx, board);
  tierFallbacks(ctx, board);
  tierBC(ctx, who, board);
  tierNoneSwitch(ctx, board);
  tierEvidence(ctx, board);
}

/** @brief TB-18 A 级：tool_choice、只给 task_handoff 的 strict 与严格 schema、关闭思考；填出来的交接交给结案。 */
function tierA(ctx, board) {
  const view = tierView(ctx, 'exec-a', 'T1');
  const forced = view.at(2);
  const def = toolDef(forced?.body, 'task_handoff');
  const others = (forced?.body.tools ?? []).map((tool) => tool.function ?? tool).filter((tool) => tool.name
    !== 'task_handoff');
  const line = view.k(2)[0];
  record('TB-18 tier A (can turn thinking off): the forced request has tool_choice task_handoff, strict only on '
    + 'task_handoff with the strict schema (every field required, optional ones nullable, no extra properties) and '
    + 'no thinking parameter, while the normal requests of that instance have thinking on',
  forced?.body.tool_choice?.function?.name === 'task_handoff' && def?.strict === true
    && strictSchema(def.parameters, ['task', 'next', 'open_items', 'evidence']) && others.length > 0
    && others.every((tool) => tool.strict !== true) && same(line?.strictTools, ['task_handoff'])
    && line.reasoning === false && view.k(1).every((item) => item.reasoning === true),
  brief({ choice: forced?.body.tool_choice, strict: line?.strictTools, reasoning: view.lines.map((l) => [l.k, l.j,
    l.reasoning]), schema: def?.parameters && { required: def.parameters.required,
    additional: def.parameters.additionalProperties } }));
  const h = taskOf(board, 'T1')?.handoffs[0];
  record('TB-18 the filled handoff goes to close and its next is kept as a suggestion (T1 forced: continue + next '
    + 'exec-b → routedTo close, suggestedNext exec-b)', h?.from === 'exec-a' && h.outcome === 'continue'
    && h.next === 'exec-b' && h.routedTo.kind === 'close' && h.suggestedNext === 'exec-b', brief(chainOf(taskOf(board,
    'T1'))));
}

/** @brief TB-18 A 但不能关思考：按 B（B 的检查通过）或 C；强制运行里其他调用被拒绝并结束。 */
function tierFallbacks(ctx, board) {
  const anod = tierView(ctx, 'exec-anod', 'T2');
  const anodc = tierView(ctx, 'exec-anodc', 'T3');
  const b = anod.k(2)[0];
  const c = anodc.k(2)[0];
  record('TB-18 tier A that cannot turn thinking off falls back: with the B check passed the forced request is B '
    + '(response_format json_schema, no tool_choice, thinking left on); with B failed too it is C (no tool_choice, '
    + 'no response_format, no strict)', b?.format === 'json_schema' && b.toolChoice === null && b.reasoning === true
    && c?.format === null && c.toolChoice === null && c.strictTools.length === 0,
  brief({ anod: lineBrief(anod.lines), anodc: lineBrief(anodc.lines) }));
  const file = anod.at(3);
  const refused = file?.messages.filter((m) => m.role === 'tool').map((m) => contentText(m.content)) ?? [];
  const h = taskOf(board, 'T2')?.handoffs[0];
  record('TB-18 in a forced run any other call is refused and ends the run: T2\'s forced run calls read, which is '
    + 'refused with "Only task_handoff works in this turn; call it now." and no further request follows in that run; '
    + 'the retry delivery then gets a JSON handoff that is used', anod.k(2).length === 1
    && same(anod.k(2)[0].calls, ['read']) && refused.some((text) => text.includes(ONLY_FORM))
    && contentText(file?.messages.filter((m) => m.role === 'user').at(-2)?.content).startsWith(RETRY)
    && h?.outcome === 'done' && h.evidence[0]?.ok === true,
  brief({ lines: lineBrief(anod.lines), refused, h: h && [h.outcome, h.evidence] }));
}

/** @brief TB-18 B 带 json_schema，C 请求不改、按标签解析。 */
function tierBC(ctx, who, board) {
  const bView = tierView(ctx, 'exec-b', 'T4');
  const bReq = bView.at(2);
  const format = bReq?.body.response_format;
  const h4 = taskOf(board, 'T4')?.handoffs[0];
  record('TB-18 tier B: the forced request carries response_format json_schema with the strict handoff schema and '
    + 'keeps the tools; the JSON reply is parsed and executed as task_handoff (evidence checked)',
  format?.type === 'json_schema' && strictSchema(format.json_schema?.schema, ['task', 'next', 'open_items',
    'evidence']) && bReq.body.tool_choice === undefined && bReq.tools.includes('task_handoff')
    && h4?.from === 'exec-b' && h4.outcome === 'done' && h4.evidence[0]?.tag === '#1' && h4.routedTo.kind === 'close',
  brief({ format: format?.type, choice: bReq?.body.tool_choice, h4 }));
  const cView = tierView(ctx, 'exec-c', 'T5');
  const [normal, forced] = [cView.at(1), cView.at(2)];
  const unchanged = forced && normal && same(forced.tools, normal.tools) && forced.body.tool_choice === undefined
    && forced.body.response_format === undefined && cView.k(2)[0]?.strictTools.length === 0;
  const h5 = taskOf(board, 'T5')?.handoffs[0];
  const h3 = taskOf(board, 'T3')?.handoffs[0];
  const delivery = contentText(forced?.messages.filter((m) => m.role === 'user').at(-2)?.content);
  record('TB-18 tier C: the forced request is unchanged (same tools as a normal request, no tool_choice, no '
    + 'response_format, no strict) and the delivery spells out the tags; the tag reply is parsed: T5 done with '
    + 'evidence #1, T3 (A→C) continue with next exec-a kept as a suggestion and its open item',
  unchanged && delivery.includes('<conclusion>') && h5?.outcome === 'done' && h5.evidence[0]?.tag === '#1'
    && h5.conclusion === 'Filled by the forced turn' && h3?.outcome === 'continue' && h3.suggestedNext === 'exec-a'
    && same(h3.openItems, ['One more check']) && h3.routedTo.kind === 'close',
  brief({ unchanged, delivery: delivery.slice(0, 200), h5, h3: h3 && [h3.outcome, h3.suggestedNext, h3.openItems] }));
}

/** @brief TB-18 没有等级时直接交结案；第一个请求失败换模型后按新模型的等级。 */
function tierNoneSwitch(ctx, board) {
  const none = tierView(ctx, 'exec-none', 'T6');
  const baton = programBaton(taskOf(board, 'T6'), 'no_handoff');
  record('TB-18 a model without a tier is not force-filled: T6 gets no second delivery and Mori hands it to close '
    + 'directly (reason no_handoff, conclusion = its last text)', none.lines.length > 0
    && none.lines.every((line) => line.k === 1) && baton?.routedTo.kind === 'close'
    && baton.conclusion === 'No tier, no handoff.', brief({ lines: lineBrief(none.lines), baton }));
  const sw = tierView(ctx, 'exec-sw', 'T7');
  const k2 = sw.k(2);
  const h = taskOf(board, 'T7')?.handoffs[0];
  record('TB-18 when the first forced request fails and the model is switched, the shape follows the new model: '
    + 'T7\'s forced request goes to fake-tbx-sw1 (A: tool_choice task_handoff) and gets 404, the same request on '
    + 'fake-tbx-sw2 is B (json_schema, no tool_choice), and its JSON handoff is used',
  k2.length === 2 && k2[0].model === 'fake-tbx-sw1' && k2[0].toolChoice === 'task_handoff' && k2[0].status === 404
    && k2[1].model === 'fake-tbx-sw2' && k2[1].format === 'json_schema' && k2[1].toolChoice === null
    && h?.from === 'exec-sw' && h.outcome === 'done',
  brief({ k2: k2.map((l) => [l.model, l.status, l.toolChoice, l.format]), h: h && [h.from, h.outcome] }));
}

/** @brief TB-18 A 级强制填写被证据规则拒绝后同一运行里没有第二次强制请求。 */
function tierEvidence(ctx, board) {
  const view = tierView(ctx, 'exec-a', 'T8');
  const retry = view.at(3);
  const delivery = contentText(retry?.messages.filter((m) => m.role === 'user').at(-2)?.content);
  const h = taskOf(board, 'T8')?.handoffs[0];
  record('TB-18 an A-tier forced handoff refused by the evidence rule ends that run with no second request (T8 '
    + 'delivery 2 has exactly one request); the retry delivery 3 says "Your handoff could not be used: done needs '
    + 'evidence…", is forced again, and its handoff with evidence is used',
  view.k(2).length === 1 && view.k(2)[0].toolChoice === 'task_handoff' && same(view.k(2)[0].calls, ['task_handoff'])
    && delivery.startsWith(`${RETRY}done needs evidence`) && view.k(3)[0]?.toolChoice === 'task_handoff'
    && h?.outcome === 'done' && h.evidence[0]?.ok === true,
  brief({ lines: lineBrief(view.lines), delivery: delivery.slice(0, 120), h: h && [h.outcome, h.evidence] }));
}

/** @brief TB-18 结案与强制关闭的 C 级标签（脚本 tb-handoff-closec）。 */
async function closeTags(ctx) {
  const who = await begin(ctx, ctx.tiers, 'Close with tags tb-scenario:tb-handoff-closec');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 90000);
  await settle(ctx, who, 60000);
  const board = readBoard(ctx, who.sessionId);
  const where = { agent: 'closer', kind: 'close' };
  const lines = scenarioLines(ctx.ep, 'tb-handoff-closec', where);
  const fill = requestAt(ctx, 'tb-handoff-closec', where, 2);
  const close = requestAt(ctx, 'tb-handoff-closec', where, 4);
  const lastUser = (req) => contentText(req?.messages.filter((m) => m.role === 'user').at(-2)?.content);
  const h = taskOf(board, 'T1')?.handoffs.at(-1);
  record('TB-18 close\'s C-tier forced fill and forced close parse the §7.5 tags: the forced fill (delivery 2) and the '
    + 'forced close (delivery 4) are unchanged requests whose deliveries list the tags; the close tags give T1 '
    + 'close_done "Decided by tags", the request_close tags close request 1 done "Closed by tags"',
  forcedLines(lines).length === 0 && lastUser(fill).startsWith(FORCED_CLOSE('T1'))
    && lastUser(fill).includes('<outcome>close_done|close_failed|continue|need_user</outcome>')
    && lastUser(close).startsWith(FORCED_REQUEST) && lastUser(close).includes('<outcome>done|failed</outcome>')
    && h?.from === 'close:closer' && h.outcome === 'close_done' && h.conclusion === 'Decided by tags'
    && board.requests[0].status === 'done' && board.requests[0].conclusion === 'Closed by tags',
  brief({ lines: lineBrief(lines), h, request: board?.requests[0] && [board.requests[0].status,
    board.requests[0].conclusion] }));
}

// ---------- TB-31：结案与需求关闭 ----------

/** @brief 每 150 毫秒看一次这个会话面板：你的消息、输入框、排队区里出现 [Mori] 的文字都记下来。 */
function watchMoriText(ctx, who) {
  const seen = [];
  let samples = 0;
  const timer = setInterval(() => {
    paneState(ctx.page, who.tab).then((pane) => {
      if (!pane) return;
      samples += 1;
      for (const text of [...pane.users, pane.draft ?? '', ...pane.queue]) if (text.includes('[Mori]')) seen.push(text);
    }).catch(() => {});
  }, 150);
  return { stop: () => clearInterval(timer), seen, samples: () => samples };
}

/** @brief request_close 被拒绝、已排除的方案、需求关闭后对话汇报（脚本 tb-handoff-close）。 */
async function closeReport(ctx) {
  const who = await begin(ctx, ctx.split, 'Two approaches tb-scenario:tb-handoff-close');
  const watch = watchMoriText(ctx, who);
  try {
    await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 90000);
    await settle(ctx, who, 60000);
  } finally {
    watch.stop();
  }
  const board = readBoard(ctx, who.sessionId);
  const results = toolResults(instance(ctx, who, 'close.1')?.entries ?? [], 'request_close');
  record('TB-31 request_close while a task has not ended is refused and lists it ("Request 1 has tasks that have not '
    + 'ended: T2 …"); after T2 ends it closes the request', results[0]?.isError === true
    && textOf(results[0]).includes('Request 1 has tasks that have not ended: T2') && results[1]?.isError === false
    && board?.requests[0].status === 'done', brief(resultBrief(results)));
  await setProgressOpen(ctx, who.tab, 1, true);
  const [block] = await progressOf(ctx, who.tab);
  await setProgressOpen(ctx, who.tab, 1, false);
  const wakes = await wakesOf(ctx, who);
  const report = wakes.find((wake) => wake.kind === 'request_closed');
  record('TB-31 the ruled-out approaches come from the conclusions of failed closings: T1 closed failed with "'
    + `${HANDOFF_TEXT.ruledOut}" is the request's ruled-out approach in the summary and in the report delivery`,
  taskOf(board, 'T1')?.status === 'failed' && same(block?.ruledOut, [HANDOFF_TEXT.ruledOut])
    && report?.text.includes(`Ruled out:\n- ${HANDOFF_TEXT.ruledOut}`),
  brief({ ruledOut: block?.ruledOut, report: report?.text }));
  await closeReportStream(ctx, who, watch, wakes);
}

/** @brief TB-31：汇报的投递不显示、汇报有自己的回复操作、[Mori] 从不出现在输入框或排队区；session.read 不含投递。 */
async function closeReportStream(ctx, who, watch, wakes) {
  const items = await transcriptItems(ctx, who.tab);
  const reportAt = items.findIndex((item) => item.kind === 'assistant'
    && item.text.startsWith('Request 1 is done: approach two works.'));
  const before = items.slice(0, Math.max(reportAt, 0));
  const entries = readJsonl(who.sessionFile).slice(1);
  const wakeEntries = customOf(entries, 'mori.wake');
  record('TB-31 after the request closes the dialog is woken to report: one hidden request_closed delivery (mori.wake '
    + 'and a mori.wake entry pointing at it, no bubble), the report is its own turn with its own reply actions (the '
    + 'turn before it keeps its actions, under its progress summary), and [Mori] text never appears in your '
    + 'messages, the input box or the queue',
  same(wakes.map((wake) => wake.kind), ['request_closed']) && wakeEntries.length === 1
    && wakeEntries[0].kind === 'request_closed' && reportAt === items.length - 1 && items[reportAt].actions
    && before.some((item) => item.actions) && before.filter((item) => item.kind === 'user').length === 1
    && watch.samples() > 20 && watch.seen.length === 0
    && !items.some((item) => item.text.includes('[Mori]')),
  brief({ items: items.map((item) => `${item.kind}${item.actions ? '*' : ''}:${item.text.slice(0, 30)}`),
    samples: watch.samples(), seen: watch.seen.slice(0, 3) }));
  const content = await bridge(ctx, { type: 'session.read', sessionFile: who.sessionFile });
  const text = JSON.stringify(content?.entries ?? []);
  record('TB-31 session.read of the user session (its content as a reference) has no [Mori] delivery but keeps your '
    + 'message and the report', (content?.entries?.length ?? 0) > 0 && !text.includes('[Mori]')
    && text.includes('tb-scenario:tb-handoff-close') && text.includes('Request 1 is done: approach two works.'),
  brief({ entries: content?.entries?.length, text: text.slice(0, 300) }));
}

/** @brief 结案不关闭 → 强制关闭 → 需求级问题 → 立项不处理 → 对话问你（脚本 tb-handoff-forceclose）。 */
async function forceClose(ctx) {
  const who = await begin(ctx, ctx.split, 'Close it for me tb-scenario:tb-handoff-forceclose');
  const board = await boardWhen(ctx, who, (item) => item.requests[0]?.asked === true, 90000);
  await settle(ctx, who, 60000);
  const lines = linesOf(ctx, 'tb-handoff-forceclose', 'planner', 'close');
  const close = deliveriesIn(instance(ctx, who, 'close.1'));
  const create = deliveriesIn(instance(ctx, who, 'create'));
  record('TB-31 when close does not close the request it is closed by force; still not closed, create gets the '
    + 'request-level question: close delivery 2 "All tasks of request 1 have ended…", forced close 3 (tool_choice '
    + 'request_close) and its retry 4, then the request\'s question "Request 1 has no open tasks and planner didn\'t '
    + 'close it" and create gets "[Mori] Request 1 has no open tasks and planner didn\'t close it."',
  close[1]?.startsWith(ALL_ENDED) && close[2]?.startsWith(FORCED_REQUEST)
    && close[3]?.startsWith('[Mori] Your request_close could not be used: ') && close.length === 4
    && same(forcedLines(lines).map((line) => [line.k, line.toolChoice]), [[3, 'request_close'], [4, 'request_close']])
    && board.requests[0].status === 'open' && board.requests[0].question === NOT_CLOSED
    && create.some((text) => text.includes(`[Mori] ${NOT_CLOSED}.`)),
  brief({ close: close.map((t) => t.slice(0, 70)), lines: lineBrief(lines), question: board.requests[0].question }));
  const wakes = await wakesOf(ctx, who);
  const [block] = await progressOf(ctx, who.tab);
  const ask = wakes.find((wake) => wake.kind === 'ask_user');
  record('TB-31 when create does not handle the request-level question, Mori asks the dialog to ask you (hidden '
    + 'ask_user "[Mori] Request 1 needs a decision from the user: … Ask the user."), the request is marked asked and '
    + 'the summary reads "Needs your decision"', ask?.text === `[Mori] Request 1 needs a decision from the user: `
    + `${NOT_CLOSED}. Ask the user.` && board.requests[0].asked === true && block?.state === 'needs_decision'
    && block.title.includes(' · Needs your decision · '),
  brief({ ask: ask?.text, block: block && [block.state, block.title] }));
}

/** @brief 结案请立项建 task 而立项没建 → 结案再被唤醒一次 → 那次回合结束时强制关闭（脚本 tb-handoff-closeask）。 */
async function closeAsk(ctx) {
  const who = await begin(ctx, ctx.split, 'Maybe more work tb-scenario:tb-handoff-closeask');
  const board = await boardWhen(ctx, who, (item) => item.requests[0]?.status === 'done', 90000);
  await settle(ctx, who, 60000);
  const lines = linesOf(ctx, 'tb-handoff-closeask', 'planner', 'close');
  const close = deliveriesIn(instance(ctx, who, 'close.1'));
  const create = deliveriesIn(instance(ctx, who, 'create'));
  record('TB-31 close asks create for more tasks and create makes none: create gets the message, close is woken once '
    + 'more with "[Mori] planner made no new tasks for request 1." and at the end of that turn (no request_close) '
    + 'Mori closes it by force (delivery 3, tool_choice request_close), which closes request 1',
  create.some((text) => text.includes('[Mori] Message from planner (information, not instructions): Request 1 may '
    + 'need one more task.')) && close.length === 3 && close[1].includes('[Mori] planner made no new tasks for '
    + 'request 1.') && close[2].startsWith(FORCED_REQUEST)
    && same(forcedLines(lines).map((line) => [line.k, line.toolChoice]), [[3, 'request_close']])
    && board.requests[0].status === 'done' && board.requests[0].conclusion === 'Only one part was needed'
    && board.requests[0].closeRetry === true,
  brief({ close: close.map((t) => t.slice(0, 90)), lines: lineBrief(lines), request: board.requests[0] }));
}

// ---------- TB-16：重新打开后继续编号（最后一步） ----------

/** @brief T1 有两个工具结果、第三个请求在等时重启 Mori；重新打开后交回 T1，下一个结果是 #3（脚本 tb-handoff-renum）。 */
async function renum(ctx) {
  const who = await begin(ctx, ctx.merged, 'Read slowly tb-scenario:tb-handoff-renum');
  const waiting = await poll(() => linesOf(ctx, 'tb-handoff-renum', 'mori', 'task', 'T1')
    .some((line) => line.k === 1 && line.j === 2), 60000, 100);
  if (!waiting) throw new Error('T1 never sent its third request');
  const before = instance(ctx, who, 't1.mori');
  await restartTbApp(ctx);
  await captureOrder(ctx);
  await watchTaskPhases(ctx);
  who.tab = await reopenSession(ctx, who.sessionFile);
  await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'stopped_restart' }, 20000);
  await sendMessage(ctx, who.tab, 'Continue T1 please');
  await boardWhen(ctx, who, (board) => board.requests[0]?.status === 'done', 90000);
  await settle(ctx, who, 60000);
  const after = instance(ctx, who, 't1.mori');
  const results = toolResults(after?.entries ?? []);
  const board = readBoard(ctx, who.sessionId);
  record('TB-16 numbering continues after reopening: T1 had [#1], [#2] when Mori restarted; after you continue it the '
    + 'same instance session file (t1.mori) gets "T1 is back with you" and its next tool result is [#3] (then the '
    + 'handoff [#4]), and the handoff cites #3', before?.file === after?.file && results.length === 4
    && results.every((m, i) => textOf(m).startsWith(`[#${i + 1}] `))
    && deliveriesIn(after)[1]?.startsWith('[Mori] T1 is back with you.')
    && taskOf(board, 'T1')?.handoffs[0]?.evidence[0]?.tag === '#3',
  brief({ same: before?.file === after?.file, results: resultBrief(results).map((t) => t.slice(0, 30)),
    evidence: taskOf(board, 'T1')?.handoffs[0]?.evidence }));
}

// ---------- 主流程 ----------

const steps = { route, closeResults, once, midRun, evidence, needUser, reviewerAsks, mergedNeed, noHandoff, depFail,
  undecided, errors, tiers, closeTags, closeReport, forceClose, closeAsk, renum };

const ctx = { userData: tempUserData('mori-tb-handoff-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-handoff] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: flow`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  const missing = missingSteps(ctx.ep);
  record('handoff: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-handoff] data in ${ctx.userData}; projects ${ctx.split}, ${ctx.tiers}, ${ctx.merged}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
