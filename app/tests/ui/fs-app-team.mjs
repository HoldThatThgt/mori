// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-team：收窄、TaskBoard 与增强会话。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic：脚本 fs-limits 与
// fs-enhance，scenarios/fs-team.mjs；没有脚本的会话按关键词），逐条验收这些编号在 App 层的通过条件：
//   FS-57 谁受什么收窄（§8.3 表每一行）、FS-59 收窄先于批准、FS-60 工具不再开关、FS-61 角色文件的 tools、
//   FS-62 写入锁、FS-65 重新打开时的工具、FS-66 增强会话、FS-68 工具被裁过的旧会话拒绝打开；2026-10-28 加只读会话的
//   FS-116 只读会话的工具、FS-118 只读会话里的命令（file-system-permissions.md §8.11）。
// 依据：file-system-permissions.md §8（§8.2–§8.10）、§6.11、§6.15，file-system.md §17“增强会话与它的实例”一行。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-team.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-team(-packaged).json（--only 时 fs-partial-app-team…，不计入覆盖检查），截图与 app.log 在
// test-results/fs-app-team/。端口：合成端点 5004，记录代理 5005（fs-helpers FS_PORTS.team）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商（fs-helpers seedFsUserData）；临时目录 ROOT 下的项目：
//   split（分开的角色 chat / planner / executor / reviewer 加订阅 request_closed 的 watcher，合成 MCP 服务 srv）、
//   offask（分开的角色、srv）、switch（分开的角色、srv）、late（分开的角色，会话打开 8 秒后才列出工具的 MCP 服务 late）、
//   merged（没有角色文件，srv）、gate、lock、keep（没有角色文件）、twotools（.pi/settings.json 的 defaultTools 为
//   read、bash）、roles（executor 的角色文件写了 tools）、enh-idle、enh-run（AGENTS.md 带 tb-scenario:fs-enhance、srv、
//   增强开着、team 关）、enh-team（同上加分开的角色、team 开）、readonly（分开的角色，FS-116、FS-118）；带 MCP 或
//   .pi 设置的项目都已信任。App 用去掉了含 rg.exe、fd.exe、fdfind.exe 的目录的 PATH 启动（tb-helpers
//   withoutSearchPrograms），只读会话的工具不随这台机器装没装 ripgrep、fd 而变；FS-116 往 pi 的 <agentDir>\bin
//   （<userData>\pi\bin）里放一个空的 rg.exe（synthetic），这一步结束时删掉。FS-65、FS-68 的合成
//   会话文件在重新启动之前写好（fs-team-helpers writeDeclaredSession、mem-enhance-helpers seedSession）。启动后先
//   away.set { timeout: 'never' }（§19.4）；FS-59、FS-66 看“不进无人应答的计时”时临时设 10 分钟并让窗口失焦（焦点的替身，
//   fs-away-helpers installFocus），看完改回。

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { ENHANCE_MARK, ENHANCE_TEXT, ENHANCE_USER_KEY, askStep, limitsMessage, limitsTask }
  from '../fake-endpoint/scenarios/fs-team.mjs';
import { memTeamAgentsMd } from '../fake-endpoint/scenarios/mem.mjs';
import { blurWindow, focusWindow, installFocus, setAwayTimeout } from './fs-away-helpers.mjs';
import { repoGit, refsUnder, setPanel, sessionView, turnRecords, waitTurn } from './fs-git-helpers.mjs';
import {
  RELAY_ONLY, answerCard, brief, cardsSince, deniedStatus, fsArgs, fsProject, fsRecorder, fsRoot, fsUserData,
  kernelEvents, liveInfo, nobodyText, openFsSession, paneSel, poll, readJsonl, reopenFs, requestsSince, restartFsApp,
  runSuite, same, seedFsUserData, sendFs, setPermission, sleep, startFsApp, startFsEndpoint, toolCardsOf, waitCard,
  waitIdleFs, writeMcpServer,
} from './fs-helpers.mjs';
import {
  DUTY, ECHO, MCP_TOOLS, PI_DEFAULTS, READ_ONLY_DEFAULTS, RULE, boardTools, callResults, declaredTools, echoStep,
  fileText, fileTools,
  firstCall, instancesOf, narrowed, ranOk, refusedWith, resultBrief, seedEnhancement, sessionPrelude, settleOn,
  sorted, spanOf, teamFiles, toolsByKind, writeDeclaredSession,
} from './fs-team-helpers.mjs';
import { paneFacts, rowByFile, rowStatusOf } from './fs-worktree-helpers.mjs';
import { appRoot } from './lib.mjs';
import { chatItems, headlessFiles, phaseBrief, seedSession, waitSettled } from './mem-enhance-helpers.mjs';
import {
  SPLIT_ROLES, clickTeamSwitch, customOf, phasesOf, readBoard, teamSwitch, waitTeamIdle, watchTaskPhases,
  withoutSearchPrograms, writeRole, writeRoles,
} from './tb-helpers.mjs';

const args = fsArgs('team');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面（synthetic） */
const ROOT = fsRoot('mori-fs-team-');
/** 订阅需求关闭的角色（FS-57 的订阅，synthetic） */
const WATCHER = { name: 'watcher', description: 'Keeps notes when a request closes', subscribe: ['request_closed'] };
/** 脚本名（scenarios/fs-team.mjs） */
const LIMITS = 'fs-limits';
/** mori-memory 对增强会话里 write、edit 的拒绝（记忆规格 §9.6） */
const ENH_WRITES = 'Enhancement runs can only change memory, with the memory tool.';
/** FS-68 的拒绝打开原文（file-system-permissions.md §8.6） */
const OLDER = 'Failed to open session: This session was saved by an older version of Mori and can’t be opened.';
/** FS-61 卡上的一行（§8.6“角色文件里还写着 tools”） */
const TOOLS_FIELD = '.mori/agents/executor.md: unknown field "tools"';
/** 一个协作的需求最多等多久结束 */
const TEAM_MS = 180000;
/** 不该出现的请求与计时事件（FS-59、FS-66） */
const ASK_EVENTS = /^mori\.(approval_request|team_approval_request|away_timer|away_decision)$/;

// ---------- 准备 ----------

/** @brief 会话打开 8 秒后才列出工具的合成 MCP 服务 late（tests/mcp-server/server.mjs 的 MORI_MCP_LATE_TOOLS_MS）。 */
function writeLateMcp(project) {
  mkdirSync(join(project, '.pi'), { recursive: true });
  const server = { command: 'node', args: [join(appRoot, 'tests', 'mcp-server', 'server.mjs')], exposure: 'direct',
    env: { MORI_MCP_LATE_TOOLS_MS: '8000' } };
  writeFileSync(join(project, '.pi', 'mcp.json'), `${JSON.stringify({ mcpServers: { late: server } }, null, 2)}\n`);
}

/** @brief 各个项目（synthetic test setup，见文件开头）。 */
function makeProjects(ctx) {
  const names = ['split', 'offask', 'switch', 'late', 'merged', 'gate', 'lock', 'keep', 'twotools', 'roles',
    'enh-idle', 'enh-run', 'enh-team', 'readonly'];
  ctx.p = Object.fromEntries(names.map((name) => [name, fsProject(ROOT, name)]));
  writeRoles(ctx.p.split, [...SPLIT_ROLES, WATCHER]);
  for (const name of ['offask', 'switch', 'late', 'enh-team', 'readonly']) writeRoles(ctx.p[name], SPLIT_ROLES);
  writeRoles(ctx.p.roles, SPLIT_ROLES.map((role) => (role.name === 'executor' ? { ...role, tools: ['read', 'bash'] }
    : role)));
  for (const name of ['split', 'offask', 'switch', 'merged', 'enh-idle', 'enh-run', 'enh-team']) {
    writeMcpServer(ctx.p[name]);
  }
  writeLateMcp(ctx.p.late);
  for (const name of ['enh-idle', 'enh-run', 'enh-team']) {
    writeFileSync(join(ctx.p[name], 'AGENTS.md'), memTeamAgentsMd('fs-enhance'));
  }
  mkdirSync(join(ctx.p.twotools, '.pi'), { recursive: true });
  const settings = JSON.stringify({ defaultTools: ['read', 'bash'] });
  writeFileSync(join(ctx.p.twotools, '.pi', 'settings.json'), `${settings}\n`);
}

/** @brief 合成端点、项目、数据目录（synthetic test setup），启动 App 并设 away never。 */
async function setup(ctx) {
  makeProjects(ctx);
  ctx.ep = await startFsEndpoint('team');
  const trusted = ['split', 'offask', 'switch', 'late', 'merged', 'twotools', 'enh-idle', 'enh-run', 'enh-team']
    .map((name) => ctx.p[name]);
  seedFsUserData(ctx, { trusted });
  seedEnhancement(ctx.userData, ctx.p['enh-idle'], false);
  seedEnhancement(ctx.userData, ctx.p['enh-run'], false);
  seedEnhancement(ctx.userData, ctx.p['enh-team'], true);
  // enh-run 里你的会话在增强运行时还在第一轮，增强的材料要另有一段今天的会话（synthetic）
  seedSession(ctx.userData, ctx.p['enh-run'], { name: 'FS-66 material', items: chatItems(['FS-66 synthetic question',
    'FS-66 synthetic answer.'], Date.now() - 30 * 60000) });
  await startFsApp(ctx);
}

// ---------- 小工具 ----------

/** @brief 等这个会话启用的工具里有 name（MCP 服务连上之后才注册），最多 30 秒。 */
async function waitTool(ctx, who, name) {
  const ok = await poll(async () => ((await liveInfo(ctx, who.sessionFile).catch(() => null))?.tools ?? [])
    .includes(name), 30000, 300);
  if (!ok) throw new Error(`${name} is not registered in ${who.tab}`);
}

/**
 * @brief 在 project 里开一个新会话，先发一条关闭模式的消息（脚本 fs-limits，只回一句），让会话写盘、合成 MCP 服务连上；
 *        mcp 为真时等 mcp__srv__echo 注册。返回会话（openFsSession 的结果）。
 */
async function warmSession(ctx, project, { mcp = true, mode = 'full' } = {}) {
  const who = await openFsSession(ctx, project);
  await sendFs(ctx, who, limitsMessage([['fs-warm', 'warm up']]));
  if (mcp) await waitTool(ctx, who, ECHO);
  if (mode === 'full') await setPermission(ctx, who.tab, 'full');
  return who;
}

/** @brief 发一条消息（默认 /team），等整个协作空闲；超时时报错。返回发送的时刻。 */
async function teamRun(ctx, who, text, { team = true, timeout = TEAM_MS } = {}) {
  const { since } = await sendFs(ctx, who, text, { team, wait: false });
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the session ${who.tab} did not become idle`);
  return since;
}

/**
 * @brief 等这个用户会话与它的实例里每一项都有调用的结果（最多 timeout）。specs 为 { 名字: [工具名, 参数里的标记] }；
 *        返回 { 名字: 结果（firstCall，带 kind：实例的种类，用户会话为 user） }，等不到的为 null。
 */
async function resultsFor(ctx, who, specs, timeout = 30000) {
  const read = () => {
    const kinds = new Map(instancesOf(ctx, who.sessionId).map((item) => [item.file, item.meta.kind ?? null]));
    const files = teamFiles(ctx, who);
    return Object.fromEntries(Object.entries(specs).map(([name, [tool, marker]]) => {
      const found = firstCall(files, tool, marker);
      return [name, found && found.isError !== null ? { ...found,
        kind: found.file === who.sessionFile ? 'user' : kinds.get(found.file) ?? null } : null];
    }));
  };
  return settleOn(read, (now) => Object.values(now).every(Boolean), timeout);
}

/** @brief 结果表的简写（检查的 detail）。 */
const resultsBrief = (results) => Object.fromEntries(Object.entries(results)
  .map(([marker, found]) => [marker, found && { kind: found.kind, ...resultBrief(found) }]));

/** @brief 这个 task 在 board.json 里的 limits；没有时为 null。 */
const boardLimits = (ctx, who, id) => readBoard(ctx, who.sessionId)?.tasks?.find((task) => task.id === id)?.limits
  ?? null;

/** @brief 项目里的文件在不在。 */
const has = (project, name) => existsSync(join(project, name));

// ---------- FS-57、FS-60：分开的配置，协作模式 ----------

/** FS-57 的大消息（分开的配置，/team）：三个 task、立项、结案、订阅、对话各自的步骤（行的顺序见 splitLimits） */
function splitMessage() {
  return limitsMessage([
    ...limitsTask(1, ['run: echo t1 > fs57-t1.txt', askStep('reviewer', 'fs57 question from T1',
      [echoStep('fs57-askmcp-t1'), 'run: echo a > fs57-askrun-t1.txt']), `[wait 9000] ${echoStep('fs57-t1-after')}`]),
    ...limitsTask(2, [askStep('reviewer', 'fs57 question from T2', [echoStep('fs57-askmcp-t2')])],
      { write: false, mcp: false }),
    ...limitsTask(3, [askStep('reviewer', 'fs57 question from T3', [echoStep('fs57-askmcp-t3')], { mcp: false })],
      { write: false }),
    // lim-create 要在 lim-dialog 之前：立项按 "lim-create: " 第一次出现的地方读，lim-dialog 那一行里也有这几个字
    ['lim-create', ['run: echo c > fs57-create.txt']],
    ['lim-close', ['run: echo c > fs57-close.txt']],
    ['lim-sub', 'run: echo s > fs57-sub.txt'],
    ['lim-dialog', [askStep('reviewer', 'fs57 question from chat', [echoStep('fs57-askmcp-chat'),
      'run: echo d > fs57-askrun-chat.txt'], { write: true }), 'run: echo d > fs57-dialog.txt',
    echoStep('fs57-dialog-mcp'), `[wait 3000] ${askStep('T1', 'fs57 note for T1', [], { mcp: false })}`]],
  ]);
}

/**
 * @brief FS-57 进座位会话的消息（分开的配置，/team）：对话发给 planner（持有立项）一条带 limits { mcp: false } 的
 *        agent_message，内容是立项要做的一行 "lim-create: <调用 MCP>"。立项的投递里先抄着你的原话，所以你的消息里这几个字
 *        写成 JSON 的 -（端点解析参数时还原成 "-"），立项只在那条消息里读到这一行。
 */
const seatMessage = () => limitsMessage([['lim-dialog', [askStep('planner', `lim-create: ${echoStep('fs57-seat')}`,
  [], { mcp: false }).replace('lim-create: ', 'lim\\u002dcreate: ')]]]);

/** splitMessage 里各调用：名字 → [工具名, 参数里的标记] */
const SPLIT_SPECS = Object.freeze({
  t1: ['bash', 'fs57-t1.txt'], askMcpT1: [ECHO, 'fs57-askmcp-t1'], askRunT1: ['bash', 'fs57-askrun-t1'],
  askMcpT2: [ECHO, 'fs57-askmcp-t2'], askMcpT3: [ECHO, 'fs57-askmcp-t3'], askMcpChat: [ECHO, 'fs57-askmcp-chat'],
  askRunChat: ['bash', 'fs57-askrun-chat'], create: ['bash', 'fs57-create'], close: ['bash', 'fs57-close'],
  sub: ['bash', 'fs57-sub'], dialog: ['bash', 'fs57-dialog.txt'], dialogMcp: [ECHO, 'fs57-dialog-mcp'],
  t1After: [ECHO, 'fs57-t1-after'], note: ['agent_message', 'fs57 note for T1'],
});

/**
 * @brief FS-57 分开的配置（split 项目，Full access，/team）：task 只按自己的 limits，临时提问 write: false 与 mcp 的继承，
 *        立项、结案、订阅 { write: false }，对话 RELAY_ONLY，agent_message.limits 发到 task、进座位会话时不用；
 *        FS-60 各种实例请求里的工具。
 */
async function splitLimits(ctx) {
  const who = await warmSession(ctx, ctx.p.split);
  const since = await teamRun(ctx, who, splitMessage());
  const results = await resultsFor(ctx, who, SPLIT_SPECS);
  const cards = await cardsSince(ctx, since);
  ctx.split = { who, since };
  recordTaskLimits(ctx, who, results);
  recordAsks(results);
  recordSeats(results, cards);
  recordNotUsed(ctx, who, results);
  recordInstanceTools(ctx, since);
  const seatWho = await warmSession(ctx, ctx.p.split);
  await teamRun(ctx, seatWho, seatMessage());
  const { seat, sent } = await resultsFor(ctx, seatWho, { seat: [ECHO, 'fs57-seat'], sent: ['agent_message',
    'fs57-seat'] });
  record('FS-57 agent_message.limits { mcp: false } delivered into a seat session (to planner, who holds create) is '
    + 'not used: the create session\'s MCP call for that message runs', ranOk(sent) && seat?.kind === 'create'
    && ranOk(seat), brief({ sent: resultBrief(sent), seat: resultBrief(seat) }));
}

/** @brief FS-57：task 只按自己的 limits（分开时立项建的 task 不带立项的 { write: false }），board.json 存的 limits。 */
function recordTaskLimits(ctx, who, results) {
  const { t1 } = results;
  const limits = ['T1', 'T2', 'T3'].map((id) => boardLimits(ctx, who, id));
  record('FS-57 a task created by the split create session (itself narrowed to { write: false }) is only narrowed by '
    + 'its own limits: T1 without limits runs a command that writes fs57-t1.txt', t1?.kind === 'task' && ranOk(t1)
    && has(ctx.p.split, 'fs57-t1.txt'), brief({ t1: resultBrief(t1), file: has(ctx.p.split, 'fs57-t1.txt') }));
  record('FS-57 board.json stores each task\'s limits as created: T1 {}, T2 { write: false, mcp: false }, '
    + 'T3 { write: false }', same(limits, [{}, { write: false, mcp: false }, { write: false }]), brief(limits));
}

/**
 * @brief FS-57：临时提问总是 write: false；task 发起的不带它没有的 mcp: false，有 mcp: false 的 task 发起的带上它，
 *        agent_message.limits 写 mcp: false 时加上它；对话（协作模式）发起的带 mcp: false，limits 写 write: true 不能放宽。
 */
function recordAsks(results) {
  const ask = (name) => (results[name]?.kind === 'ask' ? results[name] : null);
  record('FS-57 a question asked by a task without limits is always write: false (its command that writes gets "Not '
    + 'allowed for this question: only read-only commands.") and keeps MCP (the task has no mcp: false)',
  ranOk(ask('askMcpT1')) && refusedWith(ask('askRunT1'), narrowed('ask', RULE.readOnly)),
  brief({ mcp: resultBrief(results.askMcpT1), run: resultBrief(results.askRunT1) }));
  record('FS-57 a question asked by a task with mcp: false inherits it ("Not allowed for this question: no MCP or '
    + 'extension tools."), and agent_message.limits { mcp: false } from a task without it adds it',
  refusedWith(ask('askMcpT2'), narrowed('ask', RULE.mcp)) && refusedWith(ask('askMcpT3'), narrowed('ask', RULE.mcp)),
  brief({ t2: resultBrief(results.askMcpT2), t3: resultBrief(results.askMcpT3) }));
  record('FS-57 a question the team-mode dialog asks has { write: false, mcp: false }, and agent_message.limits '
    + '{ write: true } cannot widen it: its MCP call and its command are both refused',
  refusedWith(ask('askMcpChat'), narrowed('ask', RULE.mcp))
    && refusedWith(ask('askRunChat'), narrowed('ask', RULE.readOnly)),
  brief({ mcp: resultBrief(results.askMcpChat), run: resultBrief(results.askRunChat) }));
}

/** @brief FS-57：立项、结案、订阅 { write: false } 的开头各不同；对话（分开时）{ write: false, mcp: false } 为 RELAY_ONLY。 */
function recordSeats(results, cards) {
  const seat = (name, owner) => results[name]?.kind === owner
    && refusedWith(results[name], narrowed(owner, RULE.readOnly));
  record('FS-57 the create, close and subscription sessions are narrowed to { write: false }: their commands that '
    + 'write get "Not allowed while deciding requests: only read-only commands.", "Not allowed while closing a '
    + 'request: …" and "Not allowed in a subscription: …", without an approval card', seat('create', 'create')
    && seat('close', 'close')
    && seat('sub', 'subscription') && cards.length === 0,
  brief({ create: resultBrief(results.create), close: resultBrief(results.close), sub: resultBrief(results.sub),
    cards }));
  record(`FS-57 the dialog session in team mode (split roles) is narrowed to { write: false, mcp: false }: its command `
    + `and its MCP call both get "${RELAY_ONLY}"`, results.dialog?.kind === 'user'
    && refusedWith(results.dialog, RELAY_ONLY) && refusedWith(results.dialogMcp, RELAY_ONLY),
  brief({ run: resultBrief(results.dialog), mcp: resultBrief(results.dialogMcp) }));
}

/**
 * @brief FS-57：agent_message.limits { mcp: false } 发到 task（留在 T1 上）时不用：T1 之后的 MCP 调用照常执行、board.json
 *        里 T1 的 limits 不变（进座位会话的一半在 splitLimits 最后，seatMessage）。
 */
function recordNotUsed(ctx, who, results) {
  const { note, t1After: after } = results;
  record('FS-57 agent_message.limits { mcp: false } sent to a task is not used: the message is delivered to T1, T1\'s '
    + 'MCP call after it still runs and T1\'s limits in board.json stay {}', ranOk(note) && after?.kind === 'task'
    && ranOk(after) && Boolean(after.id) && same(boardLimits(ctx, who, 'T1'), {}),
  brief({ note: resultBrief(note), after: resultBrief(after) }));
}

/**
 * @brief 一种实例应有的工具（§8.6）：碰文件的工具 + MCP 工具 + 它的职责工具（分开时的立项另有 memory）。碰文件的工具
 *        一般是 pi 的默认工具，只读会话是 READ_ONLY_DEFAULTS（App 的 PATH 上没有 rg.exe、fd.exe；2026-10-28，§8.11）。
 */
const instanceWant = (kind, files = PI_DEFAULTS, mcp = MCP_TOOLS) => sorted([...files, ...mcp, ...DUTY[kind],
  ...(kind === 'create' ? ['memory'] : [])]);

/**
 * @brief FS-116：立项、结案、临时提问、订阅、write: false 的 task（只读会话）的请求里有 read、bash，没有 edit、write：
 *        tools = read、bash + MCP 工具 + 它的职责工具；FS-60：没写 limits 的 T1 照旧是 pi 的默认工具 + MCP + 职责工具。
 */
function recordInstanceTools(ctx, since) {
  const byKind = toolsByKind(ctx.ep, LIMITS, since);
  const kinds = ['create', 'close', 'ask', 'subscription'];
  const seen = Object.fromEntries(kinds.map((kind) => [kind, byKind[kind]?.map((item) => item.tools) ?? []]));
  seen.task = (byKind.task ?? []).filter((item) => ['T2', 'T3'].includes(item.task)).map((item) => item.tools);
  const want = (kind) => instanceWant(kind, READ_ONLY_DEFAULTS);
  const bad = Object.entries(seen).filter(([kind, list]) => list.length === 0
    || list.some((tools) => !same(tools, want(kind))));
  record('FS-116 the requests of the create, close, question and subscription instances and of write: false tasks '
    + 'have read and bash but not edit or write: tools = read, bash + the MCP tools + that kind\'s duty tools',
  bad.length === 0, brief({ bad: bad.map(([kind, list]) => ({ kind, want: want(kind), got: list[0] })),
    counts: Object.fromEntries(Object.entries(seen).map(([kind, list]) => [kind, list.length])) }));
  const t1 = (byKind.task ?? []).filter((item) => item.task === 'T1').map((item) => item.tools);
  record('FS-60 a task without limits keeps pi\'s default tools (edit and write too) + the MCP tools + its duty tools',
    t1.length > 0 && t1.every((tools) => same(tools, instanceWant('task'))),
    brief({ want: instanceWant('task'), got: t1[0] ?? null }));
}

// ---------- FS-57、FS-60：关闭模式下主 Agent 发起的提问 ----------

/**
 * @brief FS-57 关闭模式（分开的角色）：主 Agent 不受限（命令写出文件），它发起的临时提问只有 { write: false }（MCP 照常、
 *        命令被拒绝）；FS-60 关闭模式的临时提问请求里的工具 = pi 的默认工具 + MCP 工具。
 */
async function offAsk(ctx) {
  const who = await warmSession(ctx, ctx.p.offask);
  const message = limitsMessage([['lim-off', [askStep('reviewer', 'fs57 question in off mode',
    [echoStep('fs57-askmcp-off'), 'run: echo o > fs57-askrun-off.txt']), 'run: echo o > fs57-off.txt']]]);
  const since = await teamRun(ctx, who, message, { team: false });
  const results = await resultsFor(ctx, who, { mcp: [ECHO, 'fs57-askmcp-off'], run: ['bash', 'fs57-askrun-off'],
    main: ['bash', 'fs57-off.txt'] });
  record('FS-57 in off mode the main agent is not narrowed (its command writes fs57-off.txt); a question it asks has '
    + 'only { write: false }: the MCP call runs and the command that writes gets "Not allowed for this question: only '
    + 'read-only commands."', results.main?.kind === 'user' && ranOk(results.main)
    && has(ctx.p.offask, 'fs57-off.txt') && results.mcp?.kind === 'ask' && ranOk(results.mcp)
    && refusedWith(results.run, narrowed('ask', RULE.readOnly)),
  brief(resultsBrief(results)));
  const asks = toolsByKind(ctx.ep, LIMITS, since).ask ?? [];
  const want = sorted([...READ_ONLY_DEFAULTS, ...MCP_TOOLS]);
  record('FS-116 a question opened in off mode has read, bash and the MCP tools in its requests (no edit or write, no '
    + 'TaskBoard tools in off mode)', asks.length > 0 && asks.every((item) => same(item.tools, want)),
  brief({ want, got: asks.map((item) => item.tools) }));
}

// ---------- FS-116、FS-118：只读会话的工具与命令（2026-10-28 负责人定，file-system-permissions.md §8.11） ----------

/** FS-118 的 T1 自己交接时的结论（证据 #1 是它的只读命令的结果；脚本的交接不带证据，有带编号的结果时 done 要证据） */
const LISTED = 'Listed the project under write: false';

/**
 * @brief FS-116、FS-118（readonly 项目，Ask each time，/team）：先往 <agentDir>\bin 放一个空的 rg.exe（synthetic），
 *        write: false 的 T1 跑只读命令（成功、没有卡）与写文件的命令（被拒绝、文件不在、没有卡），再自己交接（证据 #1）；
 *        结案跑只读命令（成功）。T1 与结案的请求里多 grep、不多 find（App 的 PATH 上没有 rg.exe、fd.exe，grep 只能
 *        来自 <agentDir>\bin），仍没有 edit、write。结束时删掉 rg.exe。
 */
async function readOnlyRun(ctx) {
  const rg = join(ctx.userData, 'pi', 'bin', 'rg.exe');
  mkdirSync(join(ctx.userData, 'pi', 'bin'), { recursive: true });
  writeFileSync(rg, '');
  try {
    const who = await warmSession(ctx, ctx.p.readonly, { mcp: false, mode: 'ask' });
    const handoff = `call tool: task_handoff ${JSON.stringify({ task: 'T1', conclusion: LISTED, outcome: 'done',
      evidence: ['#1'] })}`;
    const since = await teamRun(ctx, who, limitsMessage([...limitsTask(1, ['run: echo fs118-task && ls',
      'run: echo r > fs118-r.txt', handoff], { write: false }), ['lim-close', ['run: echo fs118-close && ls']]]));
    const results = await resultsFor(ctx, who, { list: ['bash', 'fs118-task'], write: ['bash', 'fs118-r.txt'],
      close: ['bash', 'fs118-close'] });
    const cards = await cardsSince(ctx, since);
    const asked = (await kernelEvents(ctx, null, ASK_EVENTS, since)).map((item) => item.type);
    record('FS-118 under Ask each time a write: false task runs a read-only command with no card; its command that '
      + 'writes gets "Not allowed for this task: only read-only commands." with no card and no file; the close session '
      + 'runs a read-only command too', results.list?.kind === 'task' && ranOk(results.list)
      && results.write?.kind === 'task' && refusedWith(results.write, narrowed('task', RULE.readOnly))
      && !has(ctx.p.readonly, 'fs118-r.txt') && results.close?.kind === 'close' && ranOk(results.close)
      && cards.length === 0 && asked.length === 0, brief({ results: resultsBrief(results), cards, asked }));
    const byKind = toolsByKind(ctx.ep, LIMITS, since);
    const want = sorted([...READ_ONLY_DEFAULTS, 'grep']);
    const seen = ['task', 'close'].map((kind) => (byKind[kind] ?? []).map((item) => fileTools(item.tools)));
    record('FS-116 with an rg.exe in <agentDir>\\bin (synthetic, empty; no rg.exe or fd.exe on Mori\'s PATH) the '
      + 'requests of the new read-only T1 and close instances have grep as well but not find, still without edit and '
      + 'write',
    seen.every((list) => list.length > 0 && list.every((tools) => same(tools, want))), brief({ want, seen }));
  } finally {
    rmSync(rg, { force: true });
  }
}

// ---------- FS-57：合并会话与运行开始时的模式 ----------

/** @brief 等开关变成 mode（readonly 读，不点），最多 10 秒；返回读到的开关。 */
const switchNow = (ctx, tab, mode) => settleOn(() => teamSwitch(ctx, tab), (sw) => sw?.mode === mode, 10000);

/**
 * @brief FS-57 合并会话（merged 项目，Full access）：协作模式下它自己的命令与 MCP 调用得到 RELAY_ONLY，它建的 task 不带
 *        它的收窄；运行中关掉协作模式，这次运行仍受限，下一次（关闭模式）不受限。
 */
async function mergedMode(ctx) {
  const who = await warmSession(ctx, ctx.p.merged);
  await teamRun(ctx, who, limitsMessage([...limitsTask(1, ['run: echo t > fs57-mtask.txt']),
    ['lim-create', [echoStep('fs57-merged-mcp'), 'run: echo m > fs57-merged.txt']]]));
  const first = await resultsFor(ctx, who, { task: ['bash', 'fs57-mtask'], mcp: [ECHO, 'fs57-merged-mcp'],
    run: ['bash', 'fs57-merged.txt'] });
  record(`FS-57 in team mode the merged session is narrowed to { write: false, mcp: false } ("${RELAY_ONLY}" for its `
    + 'MCP call and its command) while the task it creates is not: T1 without limits writes fs57-mtask.txt',
  first.task?.kind === 'task' && ranOk(first.task) && has(ctx.p.merged, 'fs57-mtask.txt')
    && first.mcp?.kind === 'user' && refusedWith(first.mcp, RELAY_ONLY) && refusedWith(first.run, RELAY_ONLY)
    && !has(ctx.p.merged, 'fs57-merged.txt'), brief(resultsBrief(first)));
  await switchNow(ctx, who.tab, 'off');
  await clickTeamSwitch(ctx, who.tab, 'always');
  await sendFs(ctx, who, limitsMessage([['lim-create', ['[wait 6000] run: echo m > fs57-mode.txt']]]), { wait: false });
  const off = await clickTeamSwitch(ctx, who.tab, 'off');
  if (!(await waitTeamIdle(ctx, who, { timeout: TEAM_MS }))) throw new Error('the merged session did not become idle');
  await teamRun(ctx, who, limitsMessage([['lim-off', ['run: echo n > fs57-next.txt']]]), { team: false });
  const next = await resultsFor(ctx, who, { mode: ['bash', 'fs57-mode'], next: ['bash', 'fs57-next'] });
  record(`FS-57 the dialog is narrowed by the mode at the start of its run: team mode turned off while the run is `
    + `going (the switch reads Off) still refuses that run's command with "${RELAY_ONLY}"; the next run in off mode `
    + 'is not narrowed (its command writes fs57-next.txt)', off.mode === 'off' && refusedWith(next.mode, RELAY_ONLY)
    && !has(ctx.p.merged, 'fs57-mode.txt') && ranOk(next.next) && has(ctx.p.merged, 'fs57-next.txt'),
  brief({ switch: off.mode, ...resultsBrief(next) }));
}

// ---------- FS-59：收窄先于批准 ----------

/** @brief 等这个会话出现一张批准卡（后台实例的也算），最多 60 秒；没有时报错。 */
async function cardNow(ctx, who, what) {
  const card = await waitCard(ctx, who.tab, { timeout: 60000 });
  if (!card) throw new Error(`no approval card for ${what}`);
  return card;
}

/**
 * @brief FS-59 第一段（gate 项目，Ask each time，/team）：不限的 T1 的命令卡选 Allow for this session，写到外面的卡选
 *        按目录放行。返回 { tool, dir }（两张卡）。
 */
async function grantTwice(ctx, who) {
  await sendFs(ctx, who, limitsMessage([...limitsTask(1, ['run: echo a > fs59-a.txt',
    'write file: ../fs59-out/b.txt'])]), { team: true, wait: false });
  const tool = await cardNow(ctx, who, 'the command');
  await answerCard(ctx, who.tab, 'second');
  const dir = await cardNow(ctx, who, 'the write outside');
  await answerCard(ctx, who.tab, 'second');
  if (!(await waitTeamIdle(ctx, who, { timeout: TEAM_MS }))) throw new Error('the gate session did not become idle');
  return { tool, dir };
}

/**
 * @brief FS-59：先在别的卡上对 bash 选过 Allow for this session、对 ../fs59-out 选过按目录放行，再切到 Full access；
 *        write: false 的 task 调 bash、写那个目录都被收窄拒绝、没有卡、不进计时（窗口失焦、你不在设为 10 分钟）、没有
 *        mori.away_decision；它的 board_read 与 task_handoff 照常执行。之后 write_paths 里的受保护路径仍出卡（这张卡在
 *        计时：对照），Ask each time 下 write_paths 里的 edit 照常出卡。
 */
async function beforeApproval(ctx) {
  const who = await warmSession(ctx, ctx.p.gate, { mcp: false, mode: 'ask' });
  const grants = await grantTwice(ctx, who);
  const approval = (await liveInfo(ctx, who.sessionFile))?.approval ?? null;
  await setPermission(ctx, who.tab, 'full');
  await installFocus(ctx);
  await setAwayTimeout(ctx, '10m');
  await blurWindow(ctx);
  try {
    await narrowedFirst(ctx, who, grants, approval);
    await protectedStill(ctx, who);
  } finally {
    await focusWindow(ctx);
    await setAwayTimeout(ctx, 'never');
  }
  await editStillAsks(ctx, who);
}

/** FS-59 的 task 自己交接时的结论（证据是 board_read 的结果；脚本的交接不带证据，有带编号的结果时 done 要证据） */
const READ_BOARD = 'Read the board under write: false';

/**
 * @brief FS-59：被收窄拒绝的调用（Full access，放行过之后）。这个 task 最后自己调 task_handoff（done，证据 #1：前两个
 *        调用被拒绝、没有编号，board_read 的结果是 #1）；task 的编号按 board.json 里已有的个数算。
 */
async function narrowedFirst(ctx, who, grants, approval) {
  const id = `T${(readBoard(ctx, who.sessionId)?.tasks?.length ?? 0) + 1}`;
  const handoff = `call tool: task_handoff ${JSON.stringify({ task: id, conclusion: READ_BOARD, outcome: 'done',
    evidence: ['#1'] })}`;
  // 2026-10-28：只读的 task 没有 write（file-system-permissions.md §8.11），写那个目录改用命令
  const since = await teamRun(ctx, who, limitsMessage([...limitsTask(1, ['run: echo c > fs59-c.txt',
    'run: echo d > ../fs59-out/d.txt', 'call tool: board_read {}', handoff], { write: false })]));
  const results = await resultsFor(ctx, who, { run: ['bash', 'fs59-c'], write: ['bash', 'fs59-out/d.txt'],
    board: ['board_read', ''], handoff: ['task_handoff', READ_BOARD] });
  const events = (await kernelEvents(ctx, null, ASK_EVENTS, since)).map((item) => item.type);
  const cards = await cardsSince(ctx, since);
  const denied = narrowed('task', RULE.readOnly);
  const granted = grants.tool.second?.kind === 'tool' && grants.dir.second?.kind === 'dir'
    && approval?.allowed?.includes('bash') && approval.allowedDirs?.length === 1;
  record('FS-59 after "Allow for this session" on bash and allowing ../fs59-out by folder (both granted), in Full '
    + 'access a write: false task\'s command and its command writing into that folder are both refused by narrowing '
    + '("Not allowed for this task: only read-only commands."), files unchanged, with no approval card',
  granted && results.run?.kind === 'task' && refusedWith(results.run, denied) && refusedWith(results.write, denied)
    && !has(ctx.p.gate, 'fs59-c.txt') && !existsSync(join(ROOT, 'fs59-out', 'd.txt')) && cards.length === 0,
  brief({ grants: [grants.tool.second, grants.dir.second], approval, results: resultsBrief(results), cards }));
  record('FS-59 the refused calls do not enter the away timing (window unfocused, When you\'re away 10 minutes): no '
    + 'approval request, no mori.away_timer and no mori.away_decision', events.length === 0, brief(events));
  const task = readBoard(ctx, who.sessionId)?.tasks?.find((item) => item.id === id) ?? null;
  record('FS-59 duty tools run under write: false: board_read returns the board and task_handoff hands the task off '
    + '(board.json has it done)', results.board?.file === results.run?.file && ranOk(results.board)
    && results.handoff?.file === results.run?.file && ranOk(results.handoff) && task?.status === 'done',
  brief({ board: resultBrief(results.board), handoff: resultBrief(results.handoff), status: task?.status ?? null }));
}

/** @brief FS-59：write_paths 里的受保护路径（.pi/）仍出卡，这张卡在计时（对照）；拒绝它。 */
async function protectedStill(ctx, who) {
  const since = Date.now();
  await sendFs(ctx, who, limitsMessage([...limitsTask(1, ['write file: .pi/fs59.txt'], { write_paths: ['.pi/'] })]),
    { team: true, wait: false });
  const card = await cardNow(ctx, who, 'the protected write');
  const timer = await poll(async () => (await kernelEvents(ctx, null, 'mori.away_timer', since))
    .find((item) => item.data?.requestId === card.request && item.data?.deadline) ?? null, 10000, 200);
  await answerCard(ctx, who.tab, 'deny');
  if (!(await waitTeamIdle(ctx, who, { timeout: TEAM_MS }))) throw new Error('the gate session did not become idle');
  record('FS-59 in Full access a write to a protected path inside write_paths (.pi/) still shows an approval card '
    + '(scope protected), and that card is timed while the window is unfocused (control for the check above)',
  card.scope === 'protected' && card.tool === 'write' && Boolean(timer) && !has(ctx.p.gate, '.pi/fs59.txt'),
  brief({ card: { scope: card.scope, tool: card.tool }, timer: timer?.data ?? null }));
}

/** @brief FS-59：Ask each time 下 write_paths 里的 edit 照常出卡，Allow once 后执行。 */
async function editStillAsks(ctx, who) {
  await setPermission(ctx, who.tab, 'ask');
  await sendFs(ctx, who, limitsMessage([...limitsTask(1, ['edit file: src/a.ts :: export const a = 1; => export '
    + 'const a = 59;'], { write_paths: ['src/'] })]), { team: true, wait: false });
  const card = await cardNow(ctx, who, 'the edit');
  await answerCard(ctx, who.tab, 'allow');
  if (!(await waitTeamIdle(ctx, who, { timeout: TEAM_MS }))) throw new Error('the gate session did not become idle');
  const text = readFileSync(join(ctx.p.gate, 'src', 'a.ts'), 'utf8');
  record('FS-59 in Ask each time an edit inside write_paths (src/) still shows its approval card (scope inside) and '
    + 'runs after Allow once', card.tool === 'edit' && card.scope === 'inside' && text === 'export const a = 59;\n',
  brief({ card: { tool: card.tool, scope: card.scope }, text }));
}

// ---------- FS-60：协作模式下对话的工具、来回切换、晚连上的 MCP ----------

/** FS-60 的消息里认请求用的一行 */
const MARK60 = 'fs60-mark';
/** @brief FS-60 一条消息：标记一行，再加别的行。 */
const message60 = (label, rows = []) => limitsMessage([[MARK60, label], ...rows]);

/**
 * @brief 从 since 起、消息里有 fs60-mark 的对话请求（关闭模式与协作模式；协作模式下请求最后另有程序给的 user 消息，
 *        所以看全部 user 消息）：[{ kind, t, tools }]。
 */
function dialogRequests(ctx, since) {
  const byKind = toolsByKind(ctx.ep, LIMITS, since);
  return ['off-dialog', 'team-dialog'].flatMap((kind) => (byKind[kind] ?? [])
    .filter((item) => item.users.includes(`${MARK60}: `)).map((item) => ({ kind, t: item.t, tools: item.tools })))
    .sort((a, b) => a.t - b.t);
}

/** @brief FS-60：对话请求的工具是否符合：碰文件的都相同，协作模式只多三个职责工具，关闭模式只有 agent_message。 */
function dialogToolsOk(requests) {
  const files = sorted([...PI_DEFAULTS, ...MCP_TOOLS]);
  return requests.length > 0 && requests.every((item) => same(fileTools(item.tools), files)
    && same(boardTools(item.tools), item.kind === 'team-dialog' ? sorted(DUTY.dialog) : ['agent_message']));
}

/** @brief 对话请求的简写（检查的 detail）。 */
const requestsBrief = (requests) => requests.map((item) => `${item.kind}: ${item.tools.join(',')}`);

/** @brief 这个会话里 RELAY_ONLY 的三张工具卡（bash、edit、MCP）。 */
async function relayCards(ctx, who) {
  const cards = await toolCardsOf(ctx, who.tab);
  const pick = (test) => cards.findLast((card) => test(card.title)) ?? null;
  return [pick((title) => title.includes('fs60-bash')), pick((title) => title.includes('README.md')),
    pick((title) => title.toLowerCase().includes('echo'))];
}

/** @brief 三张卡都是 Denied · <RELAY_ONLY>（悬停全文）、没有标签。 */
const relayShown = (cards) => cards.every((card) => card?.status === 'rejected'
  && card.statusText === deniedStatus(RELAY_ONLY) && card.statusTitle === `Denied · ${RELAY_ONLY}`
  && card.badge === null);

/**
 * @brief FS-60（switch 项目，分开的角色，Ask each time）：关闭模式 → /team（对话调用 bash、edit、MCP 得到 RELAY_ONLY、
 *        文件不变、没有卡、工具卡 Denied）→ 关闭模式 → 开关 On → 开关 Off；每次对话请求碰文件的工具相同，协作模式只多
 *        职责工具；mori.team 条目没有 tools。重新启动后的一半在 reopen 一步。
 */
async function switching(ctx) {
  const who = await warmSession(ctx, ctx.p.switch, { mode: 'ask' });
  const readme = readFileSync(join(ctx.p.switch, 'README.md'), 'utf8');
  const since = Date.now();
  await teamRun(ctx, who, message60('off one'), { team: false });
  await teamRun(ctx, who, message60('team one', [['lim-dialog', ['run: echo x > fs60-bash.txt',
    'edit file: README.md :: Mori fixture project => fs60 edited', echoStep('fs60-mcp')]]]));
  const results = await resultsFor(ctx, who, { bash: ['bash', 'fs60-bash'], edit: ['edit', 'fs60 edited'],
    mcp: [ECHO, 'fs60-mcp'] });
  const cards = await cardsSince(ctx, since);
  const shown = await relayCards(ctx, who);
  await teamRun(ctx, who, message60('off two'), { team: false });
  await clickTeamSwitch(ctx, who.tab, 'always');
  await teamRun(ctx, who, message60('team two'), { team: false });
  await clickTeamSwitch(ctx, who.tab, 'off');
  await teamRun(ctx, who, message60('off three'), { team: false });
  const requests = dialogRequests(ctx, since);
  ctx.fs60 = { who, files: sorted([...PI_DEFAULTS, ...MCP_TOOLS]) };
  record(`FS-60 in team mode the dialog calling bash, edit and an MCP tool gets "${RELAY_ONLY}" for each; the file is `
    + 'unchanged, nothing is written and no approval card appears (Ask each time)', ['bash', 'edit', 'mcp']
    .every((name) => results[name]?.kind === 'user' && refusedWith(results[name], RELAY_ONLY))
    && !has(ctx.p.switch, 'fs60-bash.txt')
    && readFileSync(join(ctx.p.switch, 'README.md'), 'utf8') === readme && cards.length === 0,
  brief({ results: resultsBrief(results), cards }));
  record('FS-60 live, those three tool cards read "Denied · Team mode is on: …" (the whole text on hover) with no '
    + 'label', relayShown(shown), brief(shown));
  record('FS-60 switching off → team (/team) → off → On → Off, every dialog request has the same file tools (pi\'s '
    + 'defaults and the MCP tools); team mode only adds board_read, read_session and agent_message, off mode has '
    + 'agent_message (there are other roles)', requests.filter((item) => item.kind === 'team-dialog').length >= 2
    && requests.filter((item) => item.kind === 'off-dialog').length >= 3 && dialogToolsOk(requests),
  brief(requestsBrief(requests)));
  const teams = customOf(readJsonl(who.sessionFile), 'mori.team');
  record('FS-60 the mori.team entries written while switching have no tools field', teams.length >= 2
    && teams.every((data) => !('tools' in (data ?? {}))), brief(teams));
}

/**
 * @brief FS-60（late 项目）：MCP 服务在会话打开之后才列出工具（8 秒），协作模式下对话的第一次请求还没有它，之后的请求
 *        有它；对话调用它同样得到 RELAY_ONLY。第一次请求的回复晚 10 秒到（board_read），工具注册之后的下一次请求才调用它
 *        （pi 只认那次请求里有的工具）。
 */
async function lateMcp(ctx) {
  const who = await openFsSession(ctx, ctx.p.late);
  const call = 'call tool: mcp__late__echo {"text":"fs60-late"}';
  const since = await teamRun(ctx, who, limitsMessage([['lim-dialog', ['[wait 10000] call tool: board_read {}',
    call]]]));
  const result = (await resultsFor(ctx, who, { late: ['mcp__late__echo', 'fs60-late'] })).late;
  const dialog = (toolsByKind(ctx.ep, LIMITS, since)['team-dialog'] ?? []).map((item) => item.tools);
  const withTool = dialog.findIndex((tools) => tools.includes('mcp__late__echo'));
  record(`FS-60 an MCP server that lists its tools only after the session opened: the dialog's first team-mode `
    + `request lacks mcp__late__echo, a subsequent one has it, and the dialog calling it gets "${RELAY_ONLY}"`,
  dialog.length >= 2 && withTool > 0 && result?.kind === 'user' && refusedWith(result, RELAY_ONLY),
  brief({ requests: dialog, result: resultBrief(result) }));
}

// ---------- FS-61：角色文件的 tools ----------

/** @brief 这个会话面板的拒绝启动卡：{ kind, title, problems }；没有时为 null。 */
const blockedCard = (ctx, tab) => ctx.page.locator(paneSel(tab)).evaluate((pane) => {
  const card = pane.querySelector('[data-testid="blocked-card"]');
  return card ? { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? '',
    problems: [...card.querySelectorAll('[data-testid="agent-problem"]')].map((el) => el.textContent) } : null;
});

/**
 * @brief FS-61（roles 项目）：executor 的角色文件写了 tools，会话按 agents_invalid 拒绝启动，卡上一行 unknown field
 *        "tools"；删掉这一行后 Check again 通过，能发消息。
 */
async function roleTools(ctx) {
  const who = await openFsSession(ctx, ctx.p.roles);
  const card = await settleOn(() => blockedCard(ctx, who.tab), (now) => now !== null, 15000);
  record(`FS-61 a role file with "tools:" makes the session refuse to start with agents_invalid; the card "Fix the `
    + `agent files" has the line "${TOOLS_FIELD}"`, card?.kind === 'agents_invalid'
    && card.title === 'Fix the agent files' && same(card.problems, [TOOLS_FIELD]), brief(card));
  writeRole(ctx.p.roles, SPLIT_ROLES.find((role) => role.name === 'executor'));
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="blocked-card"] button[data-action="check-agents"]`).click();
  const after = await settleOn(() => blockedCard(ctx, who.tab), (now) => now === null, 15000);
  const sent = after === null ? await sendFs(ctx, who, 'Look at the fs61 notes').then(() => true, () => false) : false;
  record('FS-61 after deleting the tools line, Check again lets the session start: the card goes away and a message '
    + 'is sent', after === null && sent, brief({ after, sent }));
}

// ---------- FS-62：写入锁 ----------

/** @brief 这次（since 之后）task 行出现过的 Waiting to change files 文字：{ T<n>: [文字] }。 */
async function lockWaits(ctx, who, since) {
  const out = {};
  for (const item of await phasesOf(ctx, who.tab, since)) {
    if (item.task && item.phase === 'lock_wait') (out[item.task] ??= []).push(item.text);
  }
  return out;
}

/** @brief 端点日志里这次（since 之后）几个 task 的请求时段。 */
const taskSpans = (ctx, ids, since) => Object.fromEntries(ids.map((id) => [id, spanOf(ctx.ep, LIMITS,
  { kind: 'task', task: id, since })]));

/** @brief 几个时段两两不重叠。 */
const apart = (spans) => spans.every((a, i) => spans.every((b, j) => i === j || a.first === null || b.first === null
  || a.last < b.first || b.last < a.first));

/**
 * @brief FS-62（lock 项目，合并会话，Full access）：没写 limits、只写 commands: false、只写 mcp: false、只写 write_paths
 *        的 task 都取锁：后三个显示 Waiting to change files (T1)，四个依次运行；write: false 的 task 不取锁、与写 task
 *        同时运行。
 */
async function writeLock(ctx) {
  const who = await warmSession(ctx, ctx.p.lock, { mcp: false });
  await watchTaskPhases(ctx);
  const since = await teamRun(ctx, who, limitsMessage([...limitsTask(1, ['[wait 5000] run: echo 1 > fs62-1.txt']),
    ...limitsTask(2, ['write file: fs62-2.txt'], { commands: false }),
    ...limitsTask(3, ['write file: fs62-3.txt'], { mcp: false }),
    ...limitsTask(4, ['write file: src/fs62-4.txt'], { write_paths: ['src/'] })]));
  const waits = await lockWaits(ctx, who, since);
  const spans = taskSpans(ctx, ['T1', 'T2', 'T3', 'T4'], since);
  const limits = ['T1', 'T2', 'T3', 'T4'].map((id) => boardLimits(ctx, who, id));
  record('FS-62 tasks without limits, with only commands: false, only mcp: false or only write_paths all take the '
    + 'write lock: T2, T3 and T4 each read "Waiting to change files (T1)" while T1 runs, and the four never run at '
    + 'the same time', ['T2', 'T3', 'T4'].every((id) => (waits[id] ?? []).some((text) => text.endsWith(
    'Waiting to change files (T1)'))) && apart(Object.values(spans)) && Object.values(spans).every((s) => s.count > 0)
    && same(limits, [{}, { commands: false }, { mcp: false }, { writePaths: ['src/'] }]),
  brief({ waits, spans, limits }));
  const other = await warmSession(ctx, ctx.p.lock, { mcp: false });
  const second = await teamRun(ctx, other, limitsMessage([...limitsTask(1, ['[wait 6000] run: echo 5 > fs62-5.txt']),
    ...limitsTask(2, ['[wait 1500] call tool: board_read {}'], { write: false })]));
  const pair = taskSpans(ctx, ['T1', 'T2'], second);
  const waited = (await lockWaits(ctx, other, second)).T2 ?? [];
  record('FS-62 a write: false task does not take the lock: it runs at the same time as the write task (their '
    + 'requests overlap) and never reads Waiting to change files', pair.T2.count > 0 && pair.T1.count > 0
    && pair.T2.first < pair.T1.last && pair.T1.first < pair.T2.last && waited.length === 0
    && same(boardLimits(ctx, other, 'T2'), { write: false }), brief({ pair, waited }));
}

// ---------- FS-66：增强会话 ----------

/** @brief 一个项目的增强会话里七个调用（ENHANCE_TEXT）的标记、期望（file-system-permissions.md §8.10）。 */
function enhanceExpect(project) {
  const real = realpathSync(project);
  const outside = win32.resolve(real, '..', 'fs66-outside.txt');
  const prot = win32.join(real, '.pi', 'fs66.txt');
  return [
    ['write', ENHANCE_TEXT.note, (r) => refusedWith(r, ENH_WRITES)],
    ['edit', ENHANCE_TEXT.editTo, (r) => refusedWith(r, ENH_WRITES)],
    ['write', ENHANCE_TEXT.draft, (r) => refusedWith(r, ENH_WRITES)],
    ['bash', ENHANCE_TEXT.inside, (r) => ranOk(r)],
    ['bash', ENHANCE_TEXT.outside.slice(3), (r) => refusedWith(r,
      nobodyText(`writes outside the working directory: ${outside}`))],
    ['bash', ENHANCE_TEXT.protectedFile, (r) => refusedWith(r, nobodyText(`writes to a protected path: ${prot}`))],
    [ECHO, '"fs66"', (r) => ranOk(r)],
  ];
}

/** @brief 一个会话文件里七个调用是否都符合：{ ok, view }；文件里没有这些调用时 ok 为假。 */
function enhanceCallsOk(file, project) {
  const view = enhanceExpect(project).map(([tool, marker, test]) => {
    const result = callResults(file, marker).find((item) => item.tool === tool) ?? null;
    return { tool, marker, ok: test(result), result: resultBrief(result) };
  });
  return { ok: view.every((item) => item.ok), view };
}

/** @brief 这个工作路径内部仓库此刻的 ref 与提交数（没有仓库时为 { refs: [], commits: null }）。 */
function repoState(ctx, cwd) {
  const count = repoGit(ctx, cwd, ['rev-list', '--all', '--count']);
  return { refs: refsUnder(ctx, cwd, 'refs/'), commits: count.code === 0 ? count.stdout.trim() : null };
}

/**
 * @brief 增强的一次现在运行（enhance.run），窗口失焦、你不在设为 10 分钟；等三个任务都到终态。返回 { since, events
 *        （进度）, asked（这段时间的请求与计时事件）, cards }。
 */
async function runEnhancement(ctx, cwd) {
  await installFocus(ctx);
  await setAwayTimeout(ctx, '10m');
  await blurWindow(ctx);
  const since = Date.now();
  try {
    const run = await ctx.page.evaluate((dir) => window.mori.request({ type: 'enhance.run', cwd: dir }), cwd);
    if (run?.error) throw new Error(`enhance.run: ${run.error}`);
    const events = await waitSettled(ctx, cwd, since, 3, 300000);
    await sleep(2000);
    const asked = (await kernelEvents(ctx, null, ASK_EVENTS, since)).map((item) => item.type);
    return { since, events, asked, cards: await cardsSince(ctx, since) };
  } finally {
    await focusWindow(ctx);
    await setAwayTimeout(ctx, 'never');
  }
}

/** @brief 你自己的会话：发 fs66-user 一行（关键词步骤），等空闲与这一轮的记录。 */
async function ownTurn(ctx, project, steps) {
  const who = await openFsSession(ctx, project);
  await sendFs(ctx, who, `${ENHANCE_USER_KEY}: ${steps}`);
  await waitIdleFs(ctx, who.tab);
  if (!(await waitTurn(who.sessionFile, ENHANCE_USER_KEY))) throw new Error(`no run record in ${who.tab}`);
  return who;
}

/** @brief 这次的增强会话请求的身份段都是没人能批那一句（§6.16）：返回 { count, bad }。 */
function enhanceIdentity(ctx, since) {
  const requests = requestsSince(ctx, since).filter((item) => item.lastUser.startsWith(ENHANCE_MARK));
  return { count: requests.length, bad: requests.filter((item) => item.identity.mode !== 'none').length };
}

/**
 * @brief FS-66 关闭模式的增强、你的会话空闲（enh-idle）：增强会话的七个调用（mori-memory 拒绝 write、edit，工作路径里的
 *        命令与 MCP 执行，写到外面、受保护路径的命令直接拒绝），没有卡、没有计时；内部仓库没有新提交、新 ref，你的
 *        This session 里没有它们的记录。
 */
async function enhanceIdle(ctx) {
  const cwd = ctx.p['enh-idle'];
  const who = await ownTurn(ctx, cwd, 'say: Ready.');
  const before = { repo: repoState(ctx, cwd), records: turnRecords(who.sessionFile).length };
  const run = await runEnhancement(ctx, cwd);
  const sessions = headlessFiles(ctx.userData, cwd).map((item) => enhanceCallsOk(item.file, cwd));
  const identity = enhanceIdentity(ctx, run.since);
  record('FS-66 an enhancement session runs with { mode: full, canAsk: false }: write, edit and a write into .work '
    + 'are refused by mori-memory, the command inside the working directory and the MCP tool run without asking, the '
    + 'commands writing outside or to .pi are denied at once ("Denied by Mori: nobody can approve …"), and its '
    + 'requests have the nobody-can-approve sentence', sessions.length > 0 && sessions.every((item) => item.ok)
    && identity.count > 0 && identity.bad === 0 && enhanceFiles(cwd), brief({ phases: phaseBrief(run.events),
    identity, view: sessions[0]?.view }));
  record('FS-66 nothing in the enhancement run asks: no approval card, no approval request, no mori.away_timer and no '
    + 'mori.away_decision (window unfocused, When you\'re away 10 minutes)', run.cards.length === 0
    && run.asked.length === 0, brief({ cards: run.cards, asked: run.asked }));
  await recordQuiet(ctx, who, before, 'with your session idle');
}

/** @brief 增强写出的文件：fs66-inside.txt 有，写到外面、.pi、被拒绝的 write 都没有。 */
const enhanceFiles = (cwd) => has(cwd, ENHANCE_TEXT.inside) && !existsSync(join(cwd, '..', 'fs66-outside.txt'))
  && !has(cwd, ENHANCE_TEXT.protectedFile) && !has(cwd, ENHANCE_TEXT.note) && !has(cwd, ENHANCE_TEXT.draft);

/** @brief FS-66：你的会话空闲时内部仓库没有新提交、新 ref，This session 里没有增强的改动。 */
async function recordQuiet(ctx, who, before, label) {
  const cwd = who.cwd;
  const after = { repo: repoState(ctx, cwd), records: turnRecords(who.sessionFile).length };
  await setPanel(ctx, who.tab, true);
  const view = await sessionView(ctx);
  const listed = (view?.turns ?? []).flatMap((turn) => turn.files.map((file) => file.path));
  record(`FS-66 ${label}, the internal repository of the working directory has no new commit and no new ref after the `
    + 'enhancement run, and This session lists none of its changes',
  same(after.repo, before.repo) && after.records === before.records && Boolean(view) && !listed.includes(
    ENHANCE_TEXT.inside), brief({ before, after, listed }));
}

/**
 * @brief FS-66 你的会话也在运行时（enh-run）：增强在你的运行期间写的 fs66-inside.txt 记进你那一段（§17“增强会话与它的
 *        实例”一行），不标 overlap。
 */
async function enhanceRunning(ctx) {
  const cwd = ctx.p['enh-run'];
  const who = await openFsSession(ctx, cwd);
  await sendFs(ctx, who, `${ENHANCE_USER_KEY}: [wait 15000] say: Still working.`, { wait: false });
  const run = await runEnhancement(ctx, cwd);
  await waitIdleFs(ctx, who.tab, 60000);
  const turn = await waitTurn(who.sessionFile, ENHANCE_USER_KEY, [ENHANCE_TEXT.inside]);
  const records = turn?.changes.map((item) => item.record) ?? [];
  const file = records.flatMap((record) => record.files).find((entry) => entry.path === ENHANCE_TEXT.inside) ?? null;
  record('FS-66 when your session runs while the enhancement changes a file, that change (fs66-inside.txt) is recorded '
    + 'in your run\'s segment and not marked overlap', Boolean(file) && records.every((item) => item.overlap !== true)
    && run.events.length > 0, brief({ phases: phaseBrief(run.events), records }));
}

/**
 * @brief FS-66 协作模式的增强（enh-team，分开的角色）：增强会话的实例同样（task 实例的七个调用），立项、结案按 §8.3
 *        收窄；没有卡、没有计时；你的会话空闲时内部仓库与 This session 同上。
 */
async function enhanceTeam(ctx) {
  const cwd = ctx.p['enh-team'];
  const who = await ownTurn(ctx, cwd, 'say: Ready.');
  const before = { repo: repoState(ctx, cwd), records: turnRecords(who.sessionFile).length };
  const run = await runEnhancement(ctx, cwd);
  const instances = headlessFiles(ctx.userData, cwd).flatMap((item) => instancesOf(ctx, item.id));
  const tasks = instances.filter((item) => item.meta.kind === 'task').map((item) => enhanceCallsOk(item.file, cwd));
  const seat = (kind, marker) => instances.filter((item) => item.meta.kind === kind)
    .map((item) => callResults(item.file, marker)[0] ?? null);
  const creates = seat('create', ENHANCE_TEXT.create);
  const closes = seat('close', ENHANCE_TEXT.close);
  record('FS-66 with team on, the enhancement\'s task instances behave the same (mori-memory refuses write and edit, '
    + 'commands inside and MCP run, commands outside or to .pi are denied at once) and the create and close sessions '
    + 'are narrowed to { write: false } as in §8.3', tasks.length > 0 && tasks.every((item) => item.ok)
    && creates.length > 0 && creates.every((r) => refusedWith(r, narrowed('create', RULE.readOnly)))
    && closes.length > 0 && closes.every((r) => refusedWith(r, narrowed('close', RULE.readOnly)))
    && enhanceFiles(cwd),
  brief({ phases: phaseBrief(run.events), task: tasks[0]?.view, creates: creates.map(resultBrief),
    closes: closes.map(resultBrief) }));
  record('FS-66 with team on nothing asks either: no approval card, no approval request, no mori.away_timer, no '
    + 'mori.away_decision', run.cards.length === 0 && run.asked.length === 0, brief({ cards: run.cards,
    asked: run.asked }));
  await recordQuiet(ctx, who, before, 'with team on and your session idle');
}

// ---------- FS-60、FS-65、FS-68：重新启动之后 ----------

/** @brief 从侧栏点开一个会话文件，等它就绪或出现横幅；返回 { tab, facts（paneFacts） }。 */
async function openRow(ctx, file) {
  const row = rowByFile(ctx, file);
  await row.waitFor({ timeout: 30000 });
  await row.click();
  await ctx.page.waitForFunction((f) => {
    const active = document.querySelector('.session-item.active');
    const pane = document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
    const ready = pane?.querySelector('.composer textarea') && !pane.querySelector('[data-testid="not-ready"]');
    return active?.getAttribute('data-file') === f && Boolean(pane?.querySelector('.banner.danger') || ready);
  }, file, { timeout: 60000 });
  const tab = await row.getAttribute('data-row');
  await sleep(500);
  return { tab, facts: await paneFacts(ctx, tab) };
}

/**
 * @brief FS-65 的准备（keep 项目）：关闭模式与协作模式各存一个会话；记下它们第一次请求的工具与会话文件的全文。
 *        FS-68、FS-65 的合成会话文件也在这里写（重新启动之后侧栏才列出它们）。
 */
async function prepareReopen(ctx) {
  const off = await openFsSession(ctx, ctx.p.keep);
  const offSince = (await sendFs(ctx, off, 'Look at the fs65 off notes')).since;
  await waitIdleFs(ctx, off.tab);
  const team = await openFsSession(ctx, ctx.p.keep);
  const teamSince = await teamRun(ctx, team, limitsMessage([['fs65-mark', 'team one']]));
  const tools = { off: requestsSince(ctx, offSince, 'fs65 off notes')[0]?.tools ?? [],
    team: (toolsByKind(ctx.ep, LIMITS, teamSince)['merged-create'] ?? [])[0]?.tools ?? [] };
  const prelude = sessionPrelude(off.sessionFile);
  const teamTools = sessionPrelude(team.sessionFile).tools;
  // 抄关闭模式会话的前几行（mori.pick、模型、system 消息），工具对象另取协作模式会话声明的 TaskBoard 工具
  const both = { head: prelude.head, tools: new Map([...prelude.tools, ...teamTools]) };
  const synth = {
    trimmed: writeDeclaredSession(ctx.userData, ctx.p.keep, both, { names: ['read', 'board_read', 'read_session',
      'agent_message'], label: 'FS-68 trimmed tools' }),
    defaults: writeDeclaredSession(ctx.userData, ctx.p.keep, both, { names: [...PI_DEFAULTS],
      label: 'FS-68 default tools only' }),
    two: writeDeclaredSession(ctx.userData, ctx.p.twotools, both, { names: ['read', 'bash'],
      label: 'FS-68 read and bash' }),
    bare: seedSession(ctx.userData, ctx.p.keep, { name: 'FS-65 no system message', items: chatItems([
      'FS-65 synthetic question', 'FS-65 synthetic answer.'], Date.now() - 90000) }),
  };
  return { off, team, tools, synth, declared: { off: declaredTools(off.sessionFile),
    team: declaredTools(team.sessionFile) } };
}

/**
 * @brief FS-65：重新打开存下的两个会话不被拒绝、不被补工具（打开后文件不变）；再发一条（同样的模式），请求里碰文件的
 *        工具与保存前相同，协作模式下合并会话的职责工具照 §8.6 的表；没有 system 消息的会话照常打开。
 */
async function reopenSaved(ctx, prep) {
  await reopenFs(ctx, prep.off);
  await reopenFs(ctx, prep.team);
  const declared = { off: declaredTools(prep.off.sessionFile), team: declaredTools(prep.team.sessionFile) };
  const unchanged = same(declared, prep.declared) && PI_DEFAULTS.every((name) => declared.off.includes(name)
    && declared.team.includes(name));
  const banners = [(await paneFacts(ctx, prep.off.tab)).banner, (await paneFacts(ctx, prep.team.tab)).banner];
  const offSince = (await sendFs(ctx, prep.off, 'Look at the fs65 off again notes')).since;
  await waitIdleFs(ctx, prep.off.tab);
  const teamSince = await teamRun(ctx, prep.team, limitsMessage([['fs65-mark', 'team two']]));
  const offNow = requestsSince(ctx, offSince, 'fs65 off again')[0]?.tools ?? [];
  const teamNow = (toolsByKind(ctx.ep, LIMITS, teamSince)['merged-create'] ?? [])[0]?.tools ?? [];
  record('FS-65 sessions saved by this version (one in off mode, one in team mode) reopen without being refused and '
    + 'without tools added (the tools their files declare are unchanged by opening), and the next request has the '
    + 'same file tools as before saving', unchanged && banners.every((text) => text === null) && offNow.length > 0
    && same(fileTools(offNow), fileTools(prep.tools.off)) && same(fileTools(teamNow), fileTools(prep.tools.team))
    && same(fileTools(offNow), sorted(PI_DEFAULTS)), brief({ unchanged, banners, before: prep.tools,
    after: { off: offNow, team: teamNow } }));
  record('FS-65 after reopening, the team-mode merged session\'s duty tools follow the §8.6 table (board_read, '
    + 'read_session, agent_message, the six create tools and memory); the off-mode one has memory and no TaskBoard '
    + 'tool',
  same(boardTools(teamNow), sorted(DUTY.merged)) && teamNow.includes('memory') && boardTools(offNow).length === 0
    && offNow.includes('memory'), brief({ off: offNow, team: teamNow }));
  const bare = await openRow(ctx, prep.synth.bare.file);
  record('FS-65 a session whose file has no system message yet (no request was ever sent; synthetic session file) '
    + 'opens as usual', bare.facts.banner === null, brief(bare.facts));
}

/**
 * @brief FS-68：声明的工具只有 read、board_read、read_session、agent_message 的会话（synthetic）打开失败（横幅原文、会话行
 *        Error、文件没被改写）；声明全部默认工具而没有扩展工具的照常打开；defaultTools 为 read、bash 的项目里只声明
 *        这两个的照常打开。
 */
async function reopenTrimmed(ctx, prep) {
  const { trimmed, defaults, two } = prep.synth;
  const refused = await openRow(ctx, trimmed.file);
  const status = await rowStatusOf(ctx, trimmed.file);
  record(`FS-68 a session whose declared tools are only read, board_read, read_session and agent_message (synthetic `
    + `file) fails to open with "${OLDER}", its row shows Error, no tool is added and the file is not rewritten`,
  refused.facts.banner === OLDER && status === 'error' && fileText(trimmed.file) === trimmed.text,
  brief({ banner: refused.facts.banner, status, unchanged: fileText(trimmed.file) === trimmed.text }));
  const full = await openRow(ctx, defaults.file);
  record('FS-68 a session declaring all default tools but not memory or the TaskBoard tools opens as usual (only the '
    + 'default tools are compared)', full.facts.banner === null && fileText(defaults.file) === defaults.text,
  brief(full.facts));
  const pair = await openRow(ctx, two.file);
  record('FS-68 with defaultTools ["read","bash"] in pi\'s settings, a session declaring only read and bash opens as '
    + 'usual', pair.facts.banner === null, brief(pair.facts));
}

/** @brief FS-60 重新启动之后：RELAY_ONLY 的工具卡从会话记录载入照样 Denied；再切换模式，对话请求的工具同前。 */
async function reopenSwitch(ctx) {
  const name = 'FS-60 after a restart the RELAY_ONLY tool cards loaded from the session file still read "Denied · Team '
    + 'mode is on: …" with no label, and requests after reopening keep the same file tools in both modes';
  if (!ctx.fs60) {
    record(name, false, 'the switch step did not create its session');
    return;
  }
  const { who } = ctx.fs60;
  await reopenFs(ctx, who);
  const shown = await settleOn(() => relayCards(ctx, who), (cards) => relayShown(cards), 15000);
  const since = Date.now();
  await teamRun(ctx, who, message60('team three'));
  await teamRun(ctx, who, message60('off four'), { team: false });
  const requests = dialogRequests(ctx, since);
  record(name, relayShown(shown) && requests.some((item) => item.kind === 'team-dialog')
    && requests.some((item) => item.kind === 'off-dialog') && dialogToolsOk(requests),
  brief({ shown, requests: requestsBrief(requests) }));
}

/** @brief 重新启动 App 之后的三部分（FS-65、FS-68 的准备在重新启动之前）。放在最后。 */
async function reopen(ctx) {
  const prep = await prepareReopen(ctx);
  await restartFsApp(ctx);
  await reopenSaved(ctx, prep);
  await reopenTrimmed(ctx, prep);
  await reopenSwitch(ctx);
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  splitLimits: [splitLimits, ['FS-57', 'FS-60', 'FS-116']],
  offAsk: [offAsk, ['FS-57', 'FS-116']],
  readOnlyRun: [readOnlyRun, ['FS-116', 'FS-118']],
  mergedMode: [mergedMode, ['FS-57']],
  beforeApproval: [beforeApproval, ['FS-59']],
  switching: [switching, ['FS-60']],
  lateMcp: [lateMcp, ['FS-60']],
  roleTools: [roleTools, ['FS-61']],
  writeLock: [writeLock, ['FS-62']],
  enhanceIdle: [enhanceIdle, ['FS-66']],
  enhanceRunning: [enhanceRunning, ['FS-66']],
  enhanceTeam: [enhanceTeam, ['FS-66']],
  // 重新启动 App：放在最后
  reopen: [reopen, ['FS-60', 'FS-65', 'FS-68']],
};

const ctx = { ...fsUserData('mori-fs-team-data-'), exePath: args.exePath, pageErrors: [], args, record,
  env: withoutSearchPrograms() };
await runSuite(ctx, setup, steps);
console.log(`[fs-app-team] data in ${ctx.userData}, projects in ${ROOT}`);
finish();
