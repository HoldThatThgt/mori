// 平行 Agent 与 TaskBoard 的 App 套件：调度（docs/specs/parallel-agents-taskboard.md §17.2）。真正的 Mori（界面 + 后台进程
// + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/sched.mjs，synthetic），逐条验收
// TB-22（同时运行上限）、TB-23（写入排队）、TB-24（只读 task）、TB-25（依赖）、TB-26（补充到达正在做的实例）、
// TB-32（撤销需求）、TB-51（投递队列）在 App 层的通过条件；另查 §3：每个实例的第一个请求到达时 board.json 已写出它是
// 持有者（TB-12/TB-23，记录代理在转发前读 board.json）。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs sched）：
//   MORI_APP_DIR=.tb-runs/sched node tests/ui/tb-app-sched.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-sched(-packaged).json（--only 时 tb-partial-app-sched…），截图在
// test-results/tb-app-sched/。端口：合成端点 4640，记录代理 4641（看完整的请求体）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好两个本机提供商与模型档案（写入等级 A、能关思考，跳过探针）：
// tbs 只有 fake-coder-tbsched（默认范围），tbu 有 fake-x-tbsched 与窗口小的 fake-y-tbsched（只给 TB-51 的
// 段开始选不到模型那一步）；四个临时项目：没有角色文件（合并会话）、分开配置（chat / planner 持有立项与结案 / executor /
// reviewer）、分开配置且 .pi/mcp.json 里有合成 MCP 服务（数据目录里预先信任它）、分开配置且 chat、planner、executor
// 各写了 models。步骤各用自己的会话。
// 文件系统规格第 3 步（docs/specs/file-system.md §19.4 的 TB-23、TB-24 两行，file-system-permissions.md §8.6、§8.7）之后：
// “只读 task”是 limits.write 为 false 的 task（board.json 的 limits），写入锁按 limits 判断；收窄的 task 的请求里有默认
// 工具，调用写入、命令在路径闸第 2 步被拒绝（narrowCalls 一步用合成端点的通用场景 fs-team，scenarios/fs.mjs，
// synthetic）；task_edit 没有 limits，写了也被丢掉。

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHED_TEXT } from '../fake-endpoint/scenarios/sched.mjs';
import { WORK_CARD_OPEN, sessionOf, stripWorkCard } from '../fake-endpoint/scripts.mjs';
import { teamMessage } from './fs-helpers.mjs';
import { appRoot } from './lib.mjs';
import {
  appLogLines, brief, closeTbApp, contentText, instanceFiles, instanceSuffix, kernelEvents, lineBrief, messagesOf,
  missingSteps, openSessionIn, paneState, phasesOf, poll, progressOf, readBoard, receiptsOf, scenarioLines,
  scenarioRequests, seedTeamUserData, sendMessage, shot, SPLIT_ROLES, startTbApp, startTbEndpoint, stopTbEndpoint,
  suiteArgs, tbModel, tbProvider, tbRecorder, tempProject, tempUserData, userSession, waitReceipt, waitTaskPhase,
  waitTeamIdle, watchTaskPhases, writeRoles,
} from './tb-helpers.mjs';

const args = suiteArgs('sched');
const { record, finish } = tbRecorder(args);

/** 本套件的端口（§17.1 的 4600–4699 里分给它的 4640–4649）：合成端点与它前面的记录代理 */
const PORT = 4640;
const PROXY = 4641;
/** 默认范围的模型（synthetic）：写入等级 A、能关思考 */
const MAIN = 'fake-coder-tbsched';
/** pi 设置的默认工具（测试的数据目录没有设 defaultTools）：每个 task 实例都有，不随 limits（file-system-permissions.md §8.6） */
const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write'];
/** 合成 MCP 服务在项目里的名字与它的一个工具（直接调用方式） */
const MCP_SERVER = 'srv';
const MCP_ECHO = `mcp__${MCP_SERVER}__echo`;
/** limits.write 为 false 的 task 越界时的拒绝原文（file-system-permissions.md §8.3、§8.4） */
const NARROWED_TASK = 'Not allowed for this task: no file changes or commands.';
/** 收窄的 task 的工作卡里 task 那一行的写法（§8.9、file-system.md §14：· Limits: <limitsText>） */
const NARROW_LIMITS = ' · Limits: no file changes or commands';
/** TB-51：大消息（约 12 万个字符，fake-y-tbsched 的窗口放不下，fake-coder-tbsched 放得下） */
const BIG_MESSAGE = `Please read all of this: ${'lorem ipsum dolor sit amet '.repeat(4500)}end.`;

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 请求里的 user 消息（去掉工作卡后不为空的，即投递）。 */
const deliveriesOf = (request) => request.messages.filter((m) => m.role === 'user')
  .map((m) => stripWorkCard(contentText(m.content))).filter((text) => text.trim() !== '');
/** @brief 请求里的工作卡（最后一条含 <mori-work-card> 的 user 消息的文字）；没有时为空字符串。 */
function cardOf(request) {
  const card = request.messages.filter((m) => m.role === 'user' && contentText(m.content).includes(WORK_CARD_OPEN))
    .at(-1);
  return card ? contentText(card.content) : '';
}
/** @brief 某个会话（agent、kind、task）的端点日志行的第一个与最后一个时刻；没有请求时都为 null。 */
function spanOf(ctx, scenario, where) {
  const lines = scenarioLines(ctx.ep, scenario, where);
  return { first: lines[0]?.t ?? null, last: lines.at(-1)?.t ?? null, count: lines.length };
}
/** @brief 会话文件里某个工具的工具结果，按顺序。 */
const toolResults = (entries, tool) => messagesOf(entries).filter((m) => m.role === 'toolResult'
  && m.toolName === tool);
/** @brief 工具结果的文字。 */
const resultText = (message) => contentText(message?.content);
/** @brief 这个用户会话的某个实例会话文件（后缀如 create、close.1、t1.executor）；没有时为 null。 */
const instanceOf = (ctx, who, suffix) => instanceFiles(ctx, who.sessionId)
  .find((file) => instanceSuffix(who.sessionId, file.id) === suffix) ?? null;
/** @brief board.json 里的一个 task。 */
const taskOf = (board, id) => board?.tasks.find((task) => task.id === id) ?? null;
/** @brief 程序写的一棒（from mori）。 */
const programHandoffs = (task) => (task?.handoffs ?? []).filter((handoff) => handoff.from === 'mori');

// ---------- 准备与会话 ----------

/**
 * @brief MCP 项目（synthetic test setup）：分开配置，项目 .pi/mcp.json 里一个直接调用的合成 MCP 服务；MCP 工具照常
 *        经 .pi/mcp.json 给每个实例（实例的白名单含 mcp__*，角色文件不再写 tools：file-system.md §19.4）。
 */
function mcpProject() {
  const project = tempProject('mori-tb-sched-mcp-');
  writeRoles(project, SPLIT_ROLES);
  mkdirSync(join(project, '.pi'), { recursive: true });
  const server = { command: 'node', args: [join(appRoot, 'tests', 'mcp-server', 'server.mjs')], exposure: 'direct' };
  writeFileSync(join(project, '.pi', 'mcp.json'), `${JSON.stringify({ mcpServers: { [MCP_SERVER]: server } }, null,
    2)}\n`);
  return project;
}

/**
 * @brief TB-51 段开始选不到模型的项目（synthetic test setup）：chat 的候选 [X, Y]、planner 的 [X, coder]、
 *        executor 的 [coder]（Y 窗口小）。
 */
function unavailProject() {
  const project = tempProject('mori-tb-sched-unavail-');
  const models = { chat: [`tbu/${SCHED_TEXT.modelX}`, `tbu/${SCHED_TEXT.modelY}`],
    planner: [`tbu/${SCHED_TEXT.modelX}`, `tbs/${MAIN}`], executor: [`tbs/${MAIN}`] };
  writeRoles(project, SPLIT_ROLES.map((role) => (models[role.name] ? { ...role, models: models[role.name] } : role)));
  return project;
}

/** @brief 测试准备（synthetic test setup）：四个临时项目，数据目录与合成端点。 */
async function setup(ctx) {
  ctx.merged = tempProject('mori-tb-sched-merged-');
  ctx.split = tempProject('mori-tb-sched-split-');
  writeRoles(ctx.split, SPLIT_ROLES);
  ctx.mcp = mcpProject();
  ctx.unavail = unavailProject();
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  // 并发 10：六个 task 实例同时请求时不在模型池里等槽位（§12.10 留的槽位之外仍够），只按 §9.2 的上限排队。
  const providers = [tbProvider('tbs', PROXY, [tbModel(MAIN)], { concurrency: 10 }),
    tbProvider('tbu', PROXY, [tbModel(SCHED_TEXT.modelX),
      tbModel(SCHED_TEXT.modelY, { contextWindow: 16000, maxTokens: 2000 })], { concurrency: 10 })];
  seedTeamUserData(ctx.userData, { providers, trusted: [ctx.mcp] });
  await startTbApp(ctx);
  await watchTaskPhases(ctx);
}

/** @brief 在 project 里开一个新会话，发第一条消息（默认带 /team）；返回 { tab, sessionId, sessionFile, since }。 */
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

/** @brief 等 board.json 满足 test（每 100 毫秒读一次）；超时时报错。 */
async function boardWhen(ctx, who, test, what, timeout = 60000) {
  const board = await poll(() => {
    const value = readBoard(ctx, who.sessionId);
    return value && test(value) ? value : null;
  }, timeout, 100);
  if (!board) throw new Error(`board never reached: ${what}`);
  return board;
}

/** @brief 等某个会话（agent、kind、task，可再要求投递序号 k）的端点日志行出现，返回第一行；超时时报错。 */
async function lineWhen(ctx, scenario, where, timeout = 60000) {
  const { k, ...rest } = where;
  const lines = () => scenarioLines(ctx.ep, scenario, rest).filter((line) => k === undefined || line.k === k);
  const found = await poll(() => lines().length > 0, timeout, 50);
  if (!found) throw new Error(`no request from ${JSON.stringify(where)} in ${scenario}`);
  return lines()[0];
}

/** @brief task 行离开某个 phase 的时刻（watchTaskPhases 的记录里这个 phase 之后第一次别的 phase）；没有时为 null。 */
function leftPhase(phases, task, phase) {
  const rows = phases.filter((item) => item.task === task);
  const at = rows.findIndex((item) => item.phase === phase);
  if (at < 0) return null;
  return rows.slice(at + 1).find((item) => item.phase !== phase)?.t ?? null;
}

// ---------- TB-22：同时运行上限（合并会话，脚本 tb-sched-cap） ----------

/** @brief 六个只读 task：前四个在跑时 T5、T6 显示 Queued，前面的结束后按先后开始。 */
async function cap(ctx) {
  const scenario = 'tb-sched-cap';
  const who = await begin(ctx, ctx.merged, `Read the README six times tb-scenario:${scenario}`);
  const t5 = await waitTaskPhase(ctx, who.tab, { task: 'T5', phase: 'queued' }, 30000);
  const t6 = await waitTaskPhase(ctx, who.tab, { task: 'T6', phase: 'queued' }, 5000);
  await poll(() => ['T1', 'T2', 'T3', 'T4'].every((task) => spanOf(ctx, scenario, { kind: 'task', task }).count > 0),
    20000, 50);
  const running = ['T1', 'T2', 'T3', 'T4'].map((task) => spanOf(ctx, scenario, { kind: 'task', task }).count);
  const early = ['T5', 'T6'].map((task) => spanOf(ctx, scenario, { kind: 'task', task }).count);
  const rows = (await progressOf(ctx, who.tab))[0]?.tasks.map((row) => `${row.task}:${row.phase}`) ?? [];
  record('TB-22 with four task instances running, the fifth and sixth read "Queued" and send no request: '
    + '"T5 Read 5 · Mori · Queued", "T6 Read 6 · Mori · Queued" while T1–T4 each have a request in flight',
  t5 === 'T5 Read 5 · Mori · Queued' && t6 === 'T6 Read 6 · Mori · Queued' && running.every((n) => n > 0)
    && same(early, [0, 0]), brief({ t5, t6, running, early, rows }));
  await settle(ctx, who, 90000);
  capOrder(ctx, who, scenario, await phasesOf(ctx, who.tab, who.since));
}

/** @brief TB-22：T5 在 T1 结束后、T6 在 T2 结束后开始，T5 先于 T6；任何时刻最多 4 个；界面上按这个顺序离开 Queued。 */
function capOrder(ctx, who, scenario, phases) {
  const span = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`T${n}`, spanOf(ctx, scenario,
    { kind: 'task', task: `T${n}` })]));
  const starts = Object.values(span).map((item) => item.first).filter((t) => t !== null);
  const peak = Math.max(...starts.map((t) => Object.values(span).filter((item) => item.first !== null
    && item.first <= t && t <= item.last).length));
  const left5 = leftPhase(phases, 'T5', 'queued');
  const left6 = leftPhase(phases, 'T6', 'queued');
  const board = readBoard(ctx, who.sessionId);
  record('TB-22 the queued instances start in order as earlier ones end: T5\'s first request comes after T1\'s run '
    + 'ended and before T6\'s, T6\'s after T2\'s run ended (T6 stays Queued while T5 runs); at most 4 task instances '
    + 'have requests in flight at any moment; on screen T5 leaves Queued before T6; all six end done',
  span.T5.first > span.T1.last && span.T5.first < span.T6.first
    && span.T6.first > span.T2.last && peak === 4 && left5 !== null && left6 !== null && left5 < left6
    && left6 > span.T5.first && board?.tasks.length === 6 && board.tasks.every((task) => task.status === 'done'),
  brief({ span, peak, left5, left6, statuses: board?.tasks.map((task) => `${task.id}:${task.status}`) }));
}

// ---------- TB-23：写入排队（分开配置，脚本 tb-sched-lock） ----------

/** @brief 写 task T1（executor → reviewer → 结案）持有锁，T2 等锁；只读 T3 同时跑；T1 结束后 T2 才开始。 */
async function lock(ctx) {
  const scenario = 'tb-sched-lock';
  const taps = tapFirstRequests(ctx, scenario);
  const who = await begin(ctx, ctx.split, `Change the README twice tb-scenario:${scenario}`);
  const waiting = await waitTaskPhase(ctx, who.tab, { task: 'T2', phase: 'lock_wait' }, 30000);
  const atStart = readBoard(ctx, who.sessionId);
  await lineWhen(ctx, scenario, { agent: 'reviewer', kind: 'task', task: 'T1' }, 30000);
  // 评审的第一个请求到达代理那一刻的 board.json（§3：写出之后才唤醒；评审的第一个回复要等 4 秒）。
  const review = { board: taps.get('reviewer|task|T1')?.get(who.sessionId) ?? null, row: await rowOf(ctx, who, 'T2'),
    running: spanOf(ctx, scenario, { agent: 'reviewer', kind: 'task', task: 'T1' }).count === 1 };
  await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'with_close' }, 30000);
  const close = { board: readBoard(ctx, who.sessionId), row: await rowOf(ctx, who, 'T2') };
  await settle(ctx, who, 90000);
  ctx.ep.proxy.rule = null;
  const board = readBoard(ctx, who.sessionId);
  const phases = await phasesOf(ctx, who.tab, who.since);
  const lockText = 'T2 Second edit · executor · Waiting to change files (T1)';
  record('TB-23 the second write task waits for the lock: T2 reads "Waiting to change files (T1)" and board.json has '
    + 'lock T1 while T1\'s executor works',
  waiting === lockText && atStart?.lock === 'T1', brief({ waiting, lock: atStart?.lock }));
  record('TB-23 the lock is not released while the write task is with review (or with close): while reviewer works '
    + 'on T1 and while T1 is with planner, board.json keeps lock T1 and T2 still reads Waiting to change files (T1)',
  review.running && review.board?.lock === 'T1' && taskOf(review.board, 'T1')?.holder?.role === 'reviewer'
    && review.row === lockText
    && close.board?.lock === 'T1' && taskOf(close.board, 'T1')?.holder?.kind === 'close' && close.row === lockText,
  brief({ review: [review.board?.lock, taskOf(review.board, 'T1')?.holder, review.row],
    close: [close.board?.lock, taskOf(close.board, 'T1')?.holder, close.row] }));
  lockOrder(ctx, scenario, board, phases);
  firstHolders(who, taps);
}

/**
 * @brief 在记录代理上挂钩子：脚本 scenario 里每个实例的第一个请求（k=1、j=0）到达代理、转发给端点之前，读下此刻
 *        teams/ 下每个用户会话的 board.json。
 * @return Map<"<agent>|<kind>|<task>", Map<用户会话 id, board.json 的内容（没有时为 null）>>
 */
function tapFirstRequests(ctx, scenario) {
  const taps = new Map();
  ctx.ep.proxy.rule = ({ body }) => {
    const info = sessionOf(body?.messages ?? []);
    const key = `${info.role}|${info.kind}|${info.task ?? '-'}`;
    if (info.scenario === scenario && info.k === 1 && info.j === 0 && !taps.has(key)) taps.set(key, boardsNow(ctx));
    return {};
  };
  return taps;
}

/** @brief 此刻 <userData>/teams/ 下每个用户会话的 board.json；读不了时记下错误（检查随之失败）。 */
function boardsNow(ctx) {
  try {
    return new Map(readdirSync(join(ctx.userData, 'teams')).map((id) => [id, readBoard(ctx, id)]));
  } catch (error) {
    console.error(`[tb-app-sched] cannot read board.json: ${error instanceof Error ? error.message : error}`);
    return new Map();
  }
}

/** @brief board.json 把会话键 "<agent>|<kind>|<task>" 的实例记为持有者：task 实例持有它的 task，结案持有某个 task。 */
function namesHolder(board, key) {
  const [role, kind, id] = key.split('|');
  const active = (board?.tasks ?? []).filter((task) => task.status === 'active');
  if (kind === 'close') return active.some((task) => task.holder?.kind === 'close');
  const holder = active.find((task) => task.id === id)?.holder;
  return kind === 'task' && holder?.kind === 'role' && holder.role === role;
}

/** @brief TB-12、TB-23（§3、§6.2）：每个实例的第一个请求到达时，board.json 已经写出它是持有者。 */
function firstHolders(who, taps) {
  const keys = ['executor|task|T1', 'executor|task|T3', 'reviewer|task|T1', 'executor|task|T2', 'planner|close|-'];
  const seen = keys.map((key) => {
    const board = taps.get(key)?.get(who.sessionId) ?? null;
    return { key, tapped: taps.has(key), holds: namesHolder(board, key),
      holders: board?.tasks.map((task) => `${task.id}:${task.status}:${JSON.stringify(task.holder)}`) ?? null };
  });
  record('TB-12/TB-23 board.json is written before an instance is started: when the first request of each instance '
    + '(T1 executor, T3 executor, T1 reviewer, T2 executor, planner\'s close) arrives, board.json already names it as '
    + 'the holder (no wait for board.json to catch up)',
  seen.every((item) => item.tapped && item.holds), brief(seen));
}

/** @brief 某个 task 行此刻的文字；没有时为 null。 */
async function rowOf(ctx, who, task) {
  const [block] = await progressOf(ctx, who.tab);
  return block?.tasks.find((row) => row.task === task)?.text ?? null;
}

/**
 * @brief TB-23：两个写 task 不同时运行，T1 结束后释放锁、T2 才开始；limits.write 为 false 的 T3 与 T1 并行、从不等锁
 *        （写 task 的判断用 board.json 的 limits：writesFiles = limits.write !== false，file-system-permissions.md §8.7）。
 */
function lockOrder(ctx, scenario, board, phases) {
  const t1Exec = spanOf(ctx, scenario, { agent: 'executor', kind: 'task', task: 'T1' });
  const t1Review = spanOf(ctx, scenario, { agent: 'reviewer', kind: 'task', task: 'T1' });
  const t2 = spanOf(ctx, scenario, { agent: 'executor', kind: 'task', task: 'T2' });
  const t3 = spanOf(ctx, scenario, { agent: 'executor', kind: 'task', task: 'T3' });
  const t1 = taskOf(board, 'T1');
  const limits = ['T1', 'T2', 'T3'].map((id) => taskOf(board, id)?.limits ?? null);
  record('TB-23 the two write tasks (limits without write: false in board.json) never run at the same time and the '
    + 'lock is released when T1 ends: T2\'s first request comes after T1 closed (done) and after every T1 request; '
    + 'at the end both are done and the lock is free',
  t1?.status === 'done' && t2.first !== null && t2.first > t1.closedAt && t2.first > t1Review.last
    && t2.first > t1Exec.last && taskOf(board, 'T2')?.status === 'done' && board.lock === null
    && limits.slice(0, 2).every((item) => item !== null && item.write !== false),
  brief({ t1Exec, t1Review, t2, closedAt: t1?.closedAt, lock: board?.lock, limits }));
  record('TB-23 a task with limits.write false (T3, board.json limits { write: false }) runs beside the write task: '
    + 'T3\'s requests overlap the requests of T1\'s executor, its row never reads Waiting to change files and it '
    + 'never holds the lock',
  t3.first !== null && t3.first < t1Exec.last && t3.last > t1Exec.first
    && !phases.some((item) => item.task === 'T3' && item.phase === 'lock_wait')
    && taskOf(board, 'T3')?.status === 'done' && same(limits[2], { write: false }),
  brief({ t1Exec, t3, t3Phases: phases.filter((item) => item.task === 'T3').map((item) => item.phase),
    limits: limits[2] }));
}

// ---------- TB-24：收窄的 task（MCP 项目，脚本 tb-sched-readonly） ----------

/** @brief 请求里有全部默认工具与 MCP 服务的工具（file-system-permissions.md §8.6：实例的白名单 = 默认工具 + mcp__* + …）。 */
const hasDefaultsAndMcp = (request) => DEFAULT_TOOLS.every((name) => request.tools.includes(name))
  && request.tools.includes(MCP_ECHO);

/**
 * @brief 收窄的 task（limits.write 为 false 的 T2，file-system.md §19.4 的 TB-24 一行）：它的请求里有默认工具与 MCP，
 *        与同一角色的写 task T1 的工具相同；task_edit 写了 read_only / limits 也改不了它的 limits。
 */
async function narrowTools(ctx) {
  const scenario = 'tb-sched-readonly';
  const who = await begin(ctx, ctx.mcp, `Look around and write notes tb-scenario:${scenario}`);
  await lineWhen(ctx, scenario, { agent: 'executor', kind: 'task', task: 'T2' }, 30000);
  await sendMessage(ctx, who.tab, 'You may change files while looking around');
  await settle(ctx, who, 90000);
  const t1 = scenarioRequests(ctx.ep, scenario, { agent: 'executor', kind: 'task', task: 'T1' });
  const t2 = scenarioRequests(ctx.ep, scenario, { agent: 'executor', kind: 'task', task: 'T2' });
  const sorted = (request) => [...(request?.tools ?? [])].sort();
  record('TB-24 every request of the narrowed task\'s instance (T2, limits.write false) has the default tools read, '
    + `bash, edit, write and the MCP tool ${MCP_ECHO} besides its TaskBoard tools — the same tools as the write task `
    + 'T1 of the same role (file-system-permissions §8.6: the narrowing is checked per call in the path gate)',
  t2.length >= 3 && t2.every(hasDefaultsAndMcp) && t1.length >= 1 && hasDefaultsAndMcp(t1[0])
    && t2.every((request) => same(sorted(request), sorted(t1[0]))),
  brief({ t2: t2.map((request) => request.tools), t1: t1[0]?.tools }));
  narrowEdit(ctx, who, scenario, t2);
}

/**
 * @brief TB-24：limits 不能改（task_edit 的 schema 没有 limits，也没有 read_only；写了也被丢掉）：board.json 里 T2 的
 *        limits 仍是 { write: false }，之后的请求的工作卡写 · Limits: no file changes or commands 与新的说明。
 */
function narrowEdit(ctx, who, scenario, t2) {
  const create = scenarioRequests(ctx.ep, scenario, { agent: 'planner', kind: 'create' });
  const editSchema = create[0]?.body.tools?.find((tool) => tool.function?.name === 'task_edit')?.function.parameters;
  const params = Object.keys(editSchema?.properties ?? {});
  const entries = instanceOf(ctx, who, 'create')?.entries ?? [];
  const edit = toolResults(entries, 'task_edit')[0];
  const task = taskOf(readBoard(ctx, who.sessionId), 'T2');
  const after = t2.filter((request) => cardOf(request).includes(SCHED_TEXT.roEdited));
  record('TB-24 limits cannot change: task_edit has no limits (and no read_only) parameter; a task_edit with a new '
    + 'description changes only the description — T2\'s limits in board.json stay { write: false } and its next '
    + `request's work card reads "Task T2: Look around${NARROW_LIMITS}" with the new text, still with the default `
    + 'tools',
  editSchema !== undefined && !params.includes('limits') && !params.includes('read_only') && edit !== undefined
    && edit.isError !== true && same(task?.limits, { write: false }) && task.description === SCHED_TEXT.roEdited
    && after.length >= 1 && after.every((request) => cardOf(request).includes(`Task T2: Look around${NARROW_LIMITS}`)
      && hasDefaultsAndMcp(request)),
  brief({ params, edit: [edit?.isError, resultText(edit)], limits: task?.limits ?? null, after: after.length }));
}

/** narrowCalls 里收窄的 task 想写出的文件（都不该出现） */
const NARROW_FILES = ['made-by-narrow.txt', 'made-by-narrow-bash.txt'];
/** 收窄的 task 实例要做的 write 与 bash（关键词 calls:，replies.mjs fsActionReply；synthetic） */
const NARROW_CALLS = [{ name: 'write', args: { path: NARROW_FILES[0], content: 'changed\n' } },
  { name: 'bash', args: { command: `echo changed > ${NARROW_FILES[1]}` } }];
/** 合并会话判断消息时一次做的两个调用：登记需求 1、建 limits.write 为 false 的 T1（说明是 fs-after 行） */
const NARROW_CREATE = [
  { name: 'request_submit', args: { title: 'Narrowed task tb-scenario:fs-team', goal: 'A narrowed task tried it' } },
  { name: 'task_create', args: { request: 1, title: 'Try to change files', assignee: 'mori',
    description: `fs-after: calls: ${JSON.stringify(NARROW_CALLS)}`, limits: { write: false } } },
];
/**
 * narrowCalls 的 /team 消息（通用场景 fs-team，scenarios/fs.mjs，synthetic）：合并会话按 fs-create 行登记、建 task
 * （消息里没有 fs-call 行，fs-team 的立项不另建 task），task 实例按说明里的 fs-after 行调用 write、bash。说明里 fs-after
 * 的 "-" 在消息里写成 JSON 的 -：你的原话（工作卡的 User's words，排在 What to do 之前）里就没有 "fs-after: "，
 * task 实例只认到说明里那一行（scripts.mjs lineValue 按行找第一处）。
 */
const NARROW_MESSAGE = `Create a narrowed task\n${teamMessage([
  ['fs-create', `calls: ${JSON.stringify(NARROW_CREATE).replaceAll('fs-after', 'fs\\u002dafter')}`]])}`;

/**
 * @brief TB-24（file-system.md §19.4 的 TB-24 一行）：limits.write 为 false 的 task 调用写入、命令都得到 NARROWED_TASK
 *        （路径闸第 2 步，file-system-permissions.md §8.3；权限为 Ask each time 也不出卡），文件不变。
 */
async function narrowCalls(ctx) {
  const who = await begin(ctx, ctx.merged, NARROW_MESSAGE);
  await settle(ctx, who, 90000);
  const task = taskOf(readBoard(ctx, who.sessionId), 'T1');
  const entries = instanceOf(ctx, who, 't1.mori')?.entries ?? [];
  const tried = ['write', 'bash'].flatMap((tool) => toolResults(entries, tool).map((m) => ({ tool,
    error: m.isError === true, text: resultText(m).replace(/^\[#\d+\] ?/, '') })));
  const asks = await kernelEvents(ctx, who.sessionId, 'mori.team_approval_request', who.since);
  const written = NARROW_FILES.filter((file) => existsSync(join(ctx.merged, file)));
  record(`TB-24 a task with limits.write false calling write and bash gets "${NARROWED_TASK}" for both, writes no `
    + 'file, and no approval is asked (permission is Ask each time)', same(task?.limits, { write: false })
    && same(tried.map((item) => item.tool), ['write', 'bash'])
    && tried.every((item) => item.error && item.text === NARROWED_TASK) && written.length === 0 && asks.length === 0,
  brief({ limits: task?.limits ?? null, status: task?.status, tried, written, asks: asks.length }));
}

// ---------- TB-25：依赖（分开配置，脚本 tb-sched-deps） ----------

/** @brief T2 等 T1；T4 的依赖 T3 失败；建 T7 时依赖已失败；自指、成环、跨需求被拒绝。 */
async function deps(ctx) {
  const scenario = 'tb-sched-deps';
  const who = await begin(ctx, ctx.split, `Fix it in order tb-scenario:${scenario}`);
  const pending = await waitTaskPhase(ctx, who.tab, { task: 'T2', phase: 'pending' }, 30000);
  const pendingBoard = readBoard(ctx, who.sessionId);
  const failed = await boardWhen(ctx, who, (board) => taskOf(board, 'T3')?.status === 'failed'
    && taskOf(board, 'T5')?.status === 'active', 'T3 failed while T5 runs', 60000);
  await sendMessage(ctx, who.tab, 'Also follow up on plan A');
  await settle(ctx, who, 90000);
  const board = readBoard(ctx, who.sessionId);
  const reviewer = scenarioRequests(ctx.ep, scenario, { agent: 'reviewer', kind: 'task', task: 'T2' });
  const t1 = taskOf(board, 'T1');
  const depLine = `- T1 Find the cause: executor: ${SCHED_TEXT.depWork} · closed: ${SCHED_TEXT.depClosed}`;
  record('TB-25 a task whose dependency is not done is not handed over: T2 reads "Waiting for T1" and is pending '
    + 'with no holder while T1 runs, and reviewer gets no request on T2 before T1 closed',
  pending?.startsWith('T2 Check the fix · ') && pending.endsWith(' · Waiting for T1')
    && taskOf(pendingBoard, 'T2')?.status === 'pending'
    && taskOf(pendingBoard, 'T2')?.holder === null && reviewer.length > 0 && reviewer[0].t > t1.closedAt,
  brief({ pending, t2: taskOf(pendingBoard, 'T2')?.status, first: reviewer[0]?.t, closedAt: t1?.closedAt }));
  record('TB-25 when its dependency is done the task goes to its assignee (reviewer) and the work card carries the '
    + `dependency's last conclusion and closing conclusion: "${depLine}"`,
  reviewer.length > 0 && cardOf(reviewer[0]).includes(`Depends on:\n${depLine}`)
    && taskOf(board, 'T2')?.status === 'done', brief({ card: cardOf(reviewer[0]).slice(0, 900) }));
  depsFailed(ctx, who, scenario, board, failed);
  depsRefused(ctx, who, board);
}

/** @brief TB-25：依赖失败交结案（T4）；建 task 时依赖已失败直接交结案（T7）；两者都没有实例。 */
function depsFailed(ctx, who, scenario, board, failedBoard) {
  const handedOver = (task) => {
    const handoff = programHandoffs(task)[0];
    return handoff?.reason === 'dependency_failed' && handoff.outcome === null && handoff.routedTo?.kind === 'close';
  };
  // 结案每次运行都试着交接全部 task，运行中才交来的 T4、T7 常在同一次运行里就被它关闭（那次投递随后过期）：
  // 看交接链里程序交给结案的一棒之后紧跟着结案会话的一棒。
  const closedByClose = (task) => task?.handoffs[1]?.from === 'close:planner'
    && task.handoffs[1].outcome === 'close_failed' && task.status === 'failed';
  const t4 = taskOf(board, 'T4');
  const t7 = taskOf(board, 'T7');
  const t4Then = taskOf(failedBoard, 'T4');
  record('TB-25 a failed dependency hands the waiting task to close: T3 closed as failed, T4 (depends on T3) went to '
    + "planner's close with a program handoff (reason dependency_failed), reviewer never got a request on T4, and "
    + "the next handoff on T4 is planner's close deciding it",
  taskOf(board, 'T3')?.status === 'failed' && handedOver(t4) && (t4Then?.holder?.kind === 'close'
    || t4Then?.status === 'failed') && spanOf(ctx, scenario, { agent: 'reviewer', task: 'T4' }).count === 0
    && closedByClose(t4),
  brief({ t4: t4?.handoffs, then: [t4Then?.status, t4Then?.holder] }));
  record('TB-25 a task created when its dependency has already failed goes straight to close: T7 (depends on the '
    + 'failed T3) got its dependency_failed program handoff at once, executor never got a request on T7, and the '
    + "next handoff on T7 is planner's close deciding it",
  t7 !== null && t7.dependsOn.includes('T3') && handedOver(t7) && programHandoffs(t7)[0].at - t7.createdAt < 1000
    && spanOf(ctx, scenario, { agent: 'executor', task: 'T7' }).count === 0 && closedByClose(t7),
  brief({ t7: t7 && { dependsOn: t7.dependsOn, createdAt: t7.createdAt, handoffs: t7.handoffs } }));
}

/** @brief TB-25：自指、成环（task_edit）与跨需求（task_create）的 depends_on 被拒绝，TaskBoard 不变。 */
function depsRefused(ctx, who, board) {
  const entries = instanceOf(ctx, who, 'create')?.entries ?? [];
  const edits = toolResults(entries, 'task_edit');
  const creates = toolResults(entries, 'task_create');
  const refused = (message) => message?.isError === true && resultText(message).startsWith('depends_on: ');
  const r2 = board.tasks.filter((task) => task.request === 2).map((task) => task.title);
  record('TB-25 depends_on pointing at the task itself, making a cycle (T2 → T5 → T2) or crossing requests is refused '
    + 'with "depends_on: <reason>"; the TaskBoard keeps T5 → T2 and T2 → T1, and request 2 has only its own task',
  edits.length === 2 && refused(edits[0]) && refused(edits[1]) && creates.length === 8 && refused(creates[5])
    && creates.filter((message) => message.isError).length === 1 && same(taskOf(board, 'T5')?.dependsOn, ['T2'])
    && same(taskOf(board, 'T2')?.dependsOn, ['T1']) && same(r2, ['Quick look']),
  brief({ edits: edits.map(resultText), cross: resultText(creates[5]), r2 }));
}

// ---------- TB-26：补充到达正在做的实例（分开配置，脚本 tb-sched-update） ----------

/** @brief T1 的第一个请求在等时你补充一句：T1 的下一次请求的工作卡里有这条原话，没有插话消息。 */
async function update(ctx) {
  const scenario = 'tb-sched-update';
  const who = await begin(ctx, ctx.split, `Look at it slowly tb-scenario:${scenario}`);
  const first = await lineWhen(ctx, scenario, { agent: 'executor', kind: 'task', task: 'T1' }, 30000);
  await sendMessage(ctx, who.tab, SCHED_TEXT.update);
  const added = await waitReceipt(ctx, who.tab, { kind: 'added', request: 1 }, 20000);
  const receipt = (await kernelEvents(ctx, who.sessionId, 'mori.receipt', who.since))
    .find((item) => item.data.kind === 'added');
  await settle(ctx, who, 60000);
  const requests = scenarioRequests(ctx.ep, scenario, { agent: 'executor', kind: 'task', task: 'T1' });
  const next = requests.find((request) => request.t > (receipt?.t ?? Infinity));
  const quoted = `"${SCHED_TEXT.update}"`;
  const words = next ? cardOf(next).split("User's words:")[1] ?? '' : '';
  record('TB-26 request_update while T1\'s instance is running: the receipt is written while its first request is '
    + 'still waiting, its next request\'s work card lists the words under User\'s words, and no message other than '
    + 'the work card carries them (still one delivery, no steer)',
  added && first.t < receipt?.t && next !== undefined && words.includes(quoted)
    && !cardOf(requests[0]).includes(SCHED_TEXT.update) && deliveriesOf(next).length === 1
    && !deliveriesOf(next).some((text) => text.includes(SCHED_TEXT.update))
    && next.messages.filter((m) => m.role === 'user').length === requests[0].messages
      .filter((m) => m.role === 'user').length,
  brief({ receiptAt: receipt?.t, first: first.t, next: next?.t, deliveries: next && deliveriesOf(next).length,
    card: next && cardOf(next).slice(0, 600) }));
}

// ---------- TB-32：撤销需求（分开配置，脚本 tb-sched-cancel） ----------

/** @brief 写 task T1 在跑、T2 等锁时你撤销需求。 */
async function cancel(ctx) {
  const scenario = 'tb-sched-cancel';
  const who = await begin(ctx, ctx.split, `Edit it slowly tb-scenario:${scenario}`);
  await lineWhen(ctx, scenario, { agent: 'executor', kind: 'task', task: 'T1' }, 30000);
  const waiting = await waitTaskPhase(ctx, who.tab, { task: 'T2', phase: 'lock_wait' }, 10000);
  const before = readBoard(ctx, who.sessionId);
  const cancelAt = Date.now();
  await sendMessage(ctx, who.tab, 'Cancel that, I no longer need it');
  const shown = await waitReceipt(ctx, who.tab, { kind: 'cancelled', request: 1 }, 20000);
  await settle(ctx, who, 20000);
  const idleAt = Date.now();
  const board = readBoard(ctx, who.sessionId);
  const receipts = await receiptsOf(ctx, who.tab);
  const t1Lines = scenarioLines(ctx.ep, scenario, { agent: 'executor', kind: 'task', task: 'T1' });
  const t1File = instanceOf(ctx, who, 't1.executor');
  const lastAssistant = messagesOf(t1File?.entries ?? [], 'assistant').at(-1);
  record('TB-32 cancelling the request stops the running instance: T1\'s instance (first request still waiting 30 s) '
    + 'is stopped — the whole team is idle within seconds, T1 sends no further request, and its session ends with '
    + 'the aborted assistant message',
  waiting !== null && before?.lock === 'T1' && idleAt - cancelAt < 15000 && t1Lines.length === 1
    && ['aborted', 'error'].includes(lastAssistant?.stopReason),
  brief({ waiting, idleMs: idleAt - cancelAt, t1Lines: lineBrief(t1Lines), stop: lastAssistant?.stopReason }));
  const tasks = ['T1', 'T2'].map((id) => taskOf(board, id));
  record('TB-32 after the cancel both tasks are cancelled with no program-written handoff, the write lock is released '
    + 'and the request is cancelled; the receipt reads "Request 1 cancelled" and the summary reads Cancelled',
  shown && tasks.every((task) => task?.status === 'cancelled' && task.handoffs.length === 0) && board.lock === null
    && board.requests[0].status === 'cancelled' && receipts.some((item) => item.kind === 'cancelled'
      && item.text === 'Request 1 cancelled') && (await progressOf(ctx, who.tab))[0]?.state === 'cancelled',
  brief({ tasks: tasks.map((task) => [task?.status, task?.handoffs]), lock: board?.lock, receipts }));
  const wakes = (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since)).map((item) => item.data.kind);
  record('TB-32 cancelling does not wake close: planner\'s close session gets no request, has no session file, and '
    + 'no request_closed delivery goes to the dialog',
  spanOf(ctx, scenario, { kind: 'close' }).count === 0 && instanceOf(ctx, who, 'close.1') === null
    && !wakes.includes('request_closed'), brief({ wakes, files: instanceFiles(ctx, who.sessionId)
    .map((file) => instanceSuffix(who.sessionId, file.id)) }));
}

// ---------- TB-51：投递队列 ----------

/** @brief 合并与过期（脚本 tb-sched-merge）：结案运行中先后交来 T2、T3，下一次运行的投递是一条、两段按到达顺序。 */
async function merge(ctx) {
  const scenario = 'tb-sched-merge';
  const who = await begin(ctx, ctx.split, `Read it three times tb-scenario:${scenario}`);
  await settle(ctx, who, 90000);
  const board = readBoard(ctx, who.sessionId);
  const close = scenarioRequests(ctx.ep, scenario, { agent: 'planner', kind: 'close' });
  const lines = scenarioLines(ctx.ep, scenario, { agent: 'planner', kind: 'close' });
  const firstRunEnd = lines.filter((line) => line.k === 1).at(-1)?.t ?? 0;
  const second = close.find((request) => request.info.k === 2);
  const text = second ? deliveriesOf(second).at(-1) : '';
  const a = text.indexOf('[Mori] T2 was handed to you');
  const b = text.indexOf('[Mori] T3 was handed to you');
  const at = (id) => taskOf(board, id)?.handoffs[0]?.at ?? Infinity;
  record('TB-51 two program deliveries that arrive while close runs are merged into one run: T2 and T3 were handed '
    + 'to close (in that order) during its first run; its second run has one new message with a paragraph each, '
    + 'T2 first, separated by a blank line',
  at('T2') < at('T3') && at('T3') < firstRunEnd && second !== undefined && deliveriesOf(second).length === 2
    && a === 0 && b > a && text.slice(0, b).endsWith('\n\n') && !text.slice(a, b).includes('T3 was'),
  brief({ handed: [at('T2'), at('T3')], firstRunEnd, text: text.slice(0, 600), k: lineBrief(lines) }));
  const dropped = appLogLines(ctx, `${who.sessionId}.close.1: dropped a stale delivery (close_all_ended)`);
  record('TB-51 a stale delivery is not sent: the "all tasks ended" delivery queued while close closed the last tasks '
    + 'is dropped (logged) because close closed the request in that run — close gets no third run',
  dropped.length === 1 && !lines.some((line) => line.k === 3) && board.requests[0].status === 'done',
  brief({ dropped, k: [...new Set(lines.map((line) => line.k))] }));
}

/** @brief 用户消息排在前面（脚本 tb-sched-userfirst）：立项程序唤醒的回合里先到 T2 的程序投递、后到你的消息。 */
async function userFirst(ctx) {
  const scenario = 'tb-sched-userfirst';
  const who = await begin(ctx, ctx.split, `Ask me two things tb-scenario:${scenario}`);
  await lineWhen(ctx, scenario, { agent: 'planner', kind: 'create', k: 2 }, 30000);
  const t2Asked = await boardWhen(ctx, who, (board) => taskOf(board, 'T2')?.status === 'waiting_user',
    'T2 waiting_user', 30000);
  const busy = !scenarioLines(ctx.ep, scenario, { agent: 'planner', kind: 'create' }).some((line) => line.k >= 3);
  const sentAt = Date.now();
  await sendMessage(ctx, who.tab, SCHED_TEXT.userFirst);
  await settle(ctx, who, 90000);
  const create = scenarioRequests(ctx.ep, scenario, { agent: 'planner', kind: 'create' });
  const at = (k) => create.find((request) => request.info.k === k);
  const last = (request) => (request ? deliveriesOf(request).at(-1) : '');
  const third = last(at(3));
  const fourth = last(at(4));
  const runEnd = scenarioLines(ctx.ep, scenario, { agent: 'planner', kind: 'create' })
    .filter((line) => line.k === 2).at(-1)?.t ?? 0;
  record('TB-51 a user message delivery is not merged with program deliveries and goes first: while create\'s '
    + 'program-woken run was going, the T2 need_user delivery arrived and then your message; create\'s next run has '
    + 'only your message, the run after it only T2\'s question',
  busy && taskOf(t2Asked, 'T2').handoffs[0].at < sentAt && sentAt < at(3)?.t && runEnd < at(3)?.t
    && third.includes(`[Mori] New user message: ${SCHED_TEXT.userFirst}`) && !third.includes('T2 needs a decision')
    && fourth.includes('[Mori] T2 needs a decision from the user') && !fourth.includes('[Mori] New user message')
    && at(4).t > at(3).t,
  brief({ busy, sentAt, third: third.slice(-300), fourth: fourth.slice(0, 200) }));
}

/**
 * @brief 段开始时选不到模型（脚本 tb-sched-unavail）：大消息在立项判断时，需求 1 关闭、request_closed 排进用户会话的队列；
 *        对话为大消息选不到模型、消息撤回之后，request_closed 照常发出。
 */
async function unavail(ctx) {
  const scenario = 'tb-sched-unavail';
  const who = await begin(ctx, ctx.unavail, `Take a quick look tb-scenario:${scenario}`);
  const replied = await poll(async () => (await paneState(ctx.page, who.tab))?.assistants.includes('Noted.'), 30000);
  if (!replied) throw new Error('chat did not reply to the first message');
  await sendMessage(ctx, who.tab, BIG_MESSAGE);
  const card = await poll(async () => ((await paneState(ctx.page, who.tab))?.unavailable.length ?? 0) > 0, 60000);
  await settle(ctx, who, 60000);
  const pane = await paneState(ctx.page, who.tab);
  const board = readBoard(ctx, who.sessionId);
  const unavailable = (await kernelEvents(ctx, who.sessionId, 'mori.model_unavailable', who.since)).at(0);
  const wakes = (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since))
    .filter((item) => item.data.kind === 'request_closed');
  const chat = scenarioRequests(ctx.ep, scenario, { agent: 'chat' })
    .filter((request) => deliveriesOf(request).at(-1)?.startsWith('[Mori] Request 1 is closed'));
  // 页面收到事件的先后（同一条通道，顺序与后台进程发出的相同）：先是选不到模型，再是 request_closed 的投递。
  const order = (await kernelEvents(ctx, who.sessionId, /^mori\.(model_unavailable|wake)$/, who.since))
    .map((item) => (item.type === 'mori.wake' ? (item.data.kind === 'request_closed' ? 'wake' : 'other') : 'none'));
  const reasons = pane.unavailable[0]?.candidates.map((item) => `${item.ref}:${item.reason}`) ?? [];
  record('TB-51 a request_closed delivery queued behind a message that finds no model at its segment start is still '
    + 'sent: request 1 closed while create decided the big message; the dialog found no model for it (X not_found, Y '
    + 'no_handover; one No model available card, the message back in the input box); then the request_closed '
    + 'delivery started on Y and chat replied',
  card && unavailable?.data.firstRequest === true && unavailable.data.text === BIG_MESSAGE
    && board.requests[0].closedAt < unavailable.t && wakes.length === 1 && order.indexOf('none') >= 0
    && order.indexOf('wake') > order.indexOf('none') && chat.length === 1 && chat[0].t > board.requests[0].closedAt
    && chat[0].body.model === SCHED_TEXT.modelY
    && pane.draft === BIG_MESSAGE && pane.unavailable.length === 1
    && same(reasons, [`tbu/${SCHED_TEXT.modelX}:not_found`, `tbu/${SCHED_TEXT.modelY}:no_handover`])
    && pane.assistants.at(-1) === 'Noted.' && pane.assistants.length === 2,
  brief({ closedAt: board?.requests[0].closedAt, unavailableAt: unavailable?.t, first: unavailable?.data.firstRequest,
    order, chat: chat.map((request) => [request.t, request.body.model]), reasons,
    draft: pane.draft?.length, assistants: pane.assistants }));
}

// ---------- 主流程 ----------

const steps = { cap, lock, narrowTools, narrowCalls, deps, update, cancel, merge, userFirst, unavail };

const ctx = { userData: tempUserData('mori-tb-sched-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-sched] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: sched`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  const missing = missingSteps(ctx.ep);
  record('sched: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-sched] data in ${ctx.userData}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
