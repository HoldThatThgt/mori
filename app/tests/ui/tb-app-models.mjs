// 平行 Agent 与 TaskBoard 的 App 套件：与模型层的接口（docs/specs/parallel-agents-taskboard.md §12、§17.2）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/models.mjs，synthetic），
// 逐条验收这些编号在 App 层的通过条件：
//   TB-38 模型选择、TB-39 task 中途换模型、TB-40 候选耗尽（§12.5 表的每一行）、TB-41 调度类别、
//   TB-47 继续会话时换了模型、TB-52 后台实例的模型提示（含交给结案时清掉）。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs models）：
//   MORI_APP_DIR=.tb-runs/models node tests/ui/tb-app-models.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-models(-packaged).json（--only 时 tb-partial-app-models…），截图在
// test-results/tb-app-models/。
// 端口（§17.1 的 4600–4699 里分给本套件的 4650–4659）：合成端点 4650，记录代理 4651（看完整的请求体），
// 4652 是另一个合成端点：每个回复前等 100 秒，只给从没探测过的 tbp/fake-probing 用（它的探针一直在跑，选择器按 probing）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好二十一个本机提供商与它们的模型档案（跳过探针；tbc/fake-c 为
// C 级，tbk2/fake-k2 的档案要求推理回放，tbp/fake-probing 没有档案），pi 的默认思考强度 low；十六个临时项目，各自的
// 角色文件见 PROJECTS。时长都是真实值（modelTimings.ts：排队超时 60 秒、候选耗尽最长等 60 秒）：要等的几种情形
// （探测中的候选、立项排队超时、task 与探针排队不超时、留出的槽位）放在 longBatch 一步里同时进行，其余步骤按顺序，
// 同一时间只开一个 App。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODELS_TEXT } from '../fake-endpoint/scenarios/models.mjs';
import {
  allowAll, brief, closeTbApp, contentText, customOf, instanceFiles, kernelEvents, liveInfo, messagesOf, missingSteps,
  openSessionIn, paneSel, paneState, phasesOf, poll, progressOf, readBoard, readJsonl, receiptsOf, scenarioLines,
  scenarioRequests, seedTeamUserData, sendMessage, setProgressOpen, shot, showTab, sleep, startTbApp, startTbEndpoint,
  stopTbEndpoint, suiteArgs, tbModel, tbProvider, tbRecorder, teamSwitch, tempProject, tempUserData, userSession,
  waitTaskPhase, waitTeamIdle, watchTaskPhases, writeRoles,
} from './tb-helpers.mjs';
import { startEndpoint, stopEndpoint } from './v1-switch-helpers.mjs';

const args = suiteArgs('models');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点、记录代理、慢的合成端点（探测中的模型） */
const PORT = 4650;
const PROXY = 4651;
const SLOW = 4652;
/** 慢的合成端点每个回复前等多久（ms）：探针每一步都在 120 秒的时限内，九步加起来远长于本套件 */
const SLOW_DELAY_MS = 100000;
/** 合成端点认的思考字段（server.mjs REASONING_FIELDS） */
const REASONING_FIELDS = ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking'];
/** 协作模式下模型按钮的悬停（§12.11） */
const LOCKED_TITLE = 'Team mode picks the model for each agent';
/** 要求交接写入等级 B 以上（§12.2） */
const NEED_B = ['protocol_write>=B'];

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 会话文件里 pi 消息的文字。 */
const textOf = (message) => contentText(message?.content);
/** @brief 用户会话文件的全部条目（第一行头部除外）。 */
const userEntries = (who) => readJsonl(who.sessionFile).slice(1);
/** @brief 会话文件里某个工具的工具结果，按顺序。 */
const toolResults = (entries, tool) => messagesOf(entries)
  .filter((m) => m.role === 'toolResult' && m.toolName === tool);
/** @brief 一组日志行里出现过的模型 id（按出现顺序去重）。 */
const modelsOf = (lines) => [...new Set(lines.map((line) => line.model))];
/** @brief 某个脚本的端点日志行（scenarioLines）。 */
const lines = (ctx, scenario, where = {}) => scenarioLines(ctx.ep, scenario, where);
/** @brief 请求体里的思考字段（JSON 文字，没有的为 null）。 */
const thinkingOf = (body) => JSON.stringify(REASONING_FIELDS.map((field) => body[field] ?? null));
/** @brief 一个请求末尾的工作卡文字（没有时为空串）。 */
const cardOf = (request) => request?.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content))
  .filter((text) => text.includes('<mori-work-card>')).at(-1) ?? '';
/** @brief 某个 task 的程序写的一棒（reason 为 no_model）；没有时为 undefined。 */
const noModelBaton = (task) => task?.handoffs.find((handoff) => handoff.reason === 'no_model');
/** @brief board.json 里的一个 task。 */
const taskOf = (board, id) => board?.tasks.find((task) => task.id === id);

/**
 * @brief 某个用户会话的一个实例会话文件：首条 mori.instance 的数据满足 kind（与 task、role）。
 * @return instanceFiles 的一项；没有时为 null
 */
function instanceOf(ctx, who, kind, { task = null, role = null } = {}) {
  return instanceFiles(ctx, who.sessionId).find((file) => {
    const data = file.first?.data ?? {};
    return data.kind === kind && (task === null || data.task === task) && (role === null || data.role === role);
  }) ?? null;
}

/** @brief 经进程桥发一条命令；失败时不抛出，返回 { value, error }。 */
function tryBridge(ctx, command) {
  return ctx.page.evaluate((cmd) => window.mori.request(cmd).then((value) => ({ value, error: null }),
    (error) => ({ value: null, error: String(error?.message ?? error) })), command);
}

/** @brief 这个会话的模型按钮：锁定、文字、悬停、有没有菜单、data-pick、data-current。 */
function modelButton(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="model-button"]`).evaluate((el) => ({
    locked: el.dataset.locked === 'true', text: el.textContent.trim(), title: el.getAttribute('title'),
    popup: el.getAttribute('aria-haspopup'), pick: el.dataset.pick ?? null, current: el.dataset.current ?? null }));
}

/** @brief 这个会话的思考按钮：data-level 与是否可用。 */
function thinkingButton(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="thinking-button"]`).evaluate((el) => ({
    level: el.dataset.level, disabled: el.disabled }));
}

/** @brief 在这个会话输入框下面一行把思考强度换成 level（Effort 菜单），等按钮的 data-level 变过去。 */
async function chooseLevel(ctx, tab, level) {
  await ctx.page.locator(`${paneSel(tab)} [data-testid="thinking-button"]`).click();
  await ctx.page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await ctx.page.waitForFunction(({ css, want }) => {
    const button = document.querySelector(css);
    return button?.dataset.level === want && button.getAttribute('aria-disabled') !== 'true';
  }, { css: `${paneSel(tab)} [data-testid="thinking-button"]`, want: level }, { timeout: 15000 });
}

/** @brief 这个会话的拒绝启动卡：{ kind, actions（data-action）, candidates: [{ ref, reason }] }；没有时为 null。 */
function blockedCard(ctx, tab) {
  return ctx.page.evaluate((css) => {
    const card = document.querySelector(css);
    if (!card) return null;
    const actions = [...card.querySelectorAll('[data-action]')].map((el) => el.dataset.action);
    return { kind: card.dataset.kind, actions,
      candidates: [...card.querySelectorAll('[data-testid="candidate"]')].map((el) => ({ ref: el.dataset.ref,
        reason: el.dataset.reason })) };
  }, `${paneSel(tab)} [data-testid="blocked-card"]`);
}

// ---------- 准备与会话 ----------

/** @brief 一个角色（writeRole 的参数）。 */
const role = (name, description, extra = {}) => ({ name, description, ...extra });
const CHAT = role('chat', 'Talks with the user and relays', { seats: ['dialog'] });
const PLANNER = role('planner', 'Plans each request and closes it', { seats: ['create', 'close'] });
const CREATOR = role('planner', 'Plans each request', { seats: ['create'] });
const EXECUTOR = role('executor', 'Reads files and changes code for a task');
const REVIEWER = role('reviewer', 'Checks the work of another role');
/** @brief 持有立项与结案、用这些模型的 planner。 */
const plannerOn = (models, extra = {}) => role('planner', 'Plans each request and closes it',
  { seats: ['create', 'close'], models, ...extra });
/** @brief 用这些模型的 executor。 */
const executorOn = (models, extra = {}) => role('executor', 'Reads files and changes code for a task',
  { models, ...extra });
/** @brief 用这些模型的 chat（持有对话）。 */
const chatOn = (models) => role('chat', 'Talks with the user and relays', { seats: ['dialog'], models });
const K_MODELS = ['tbk1/fake-k1', 'tbk2/fake-k2'];

/** 临时项目与它们的角色文件（synthetic test setup）；plain 没有角色文件（关闭模式照 v0，协作模式为合并会话） */
const PROJECTS = {
  plain: [],
  sel: [chatOn(['tbo/fake-other']), PLANNER, executorOn(['tbc/fake-c', 'tbo/fake-other2'], { requires: NEED_B }),
    REVIEWER],
  fam: [CHAT, PLANNER, executorOn(['tbm/fake-main']),
    role('reviewer', 'Checks the work of another role', { models: ['tbm/fake-main', 'tbm/fake-b'],
      differ_from: 'author' })],
  gone: [chatOn(['tbg/fake-gone']), PLANNER, EXECUTOR],
  picky: [CHAT, PLANNER, EXECUTOR,
    role('picky', 'Needs handoff tier B or better', { models: ['tbc/fake-c', 'tbp/fake-probing'], requires: NEED_B }),
    role('pickyc', 'Needs handoff tier B but has a tier C model', { models: ['tbc/fake-c'], requires: NEED_B })],
  sw: [CHAT, PLANNER, executorOn(['tbs1/fake-sw1', 'tbs2/fake-sw2', 'tbs3/fake-sw3']),
    role('watcher', 'Watches every closed request', { models: ['tbw/fake-sub-404'], subscribe: ['request_closed'] })],
  note: [CHAT, PLANNER, executorOn(['tbn1/fake-n1', 'tbn2/fake-n2'])],
  cdead: [CHAT, plannerOn(['tbc/fake-c'], { requires: NEED_B }), EXECUTOR],
  cwake: [CHAT, plannerOn(['tbcw/fake-cw']), EXECUTOR],
  closer: [CHAT, CREATOR, role('closer', 'Closes each request', { seats: ['close'], models: ['tbcl/fake-close-404'] }),
    EXECUTOR],
  chat404: [chatOn(['tbk/fake-chat-404']), PLANNER, EXECUTOR,
    role('oracle', 'Answers one question', { models: ['tbo4/fake-ask-404'] })],
  q1task: [CHAT, PLANNER, executorOn(['tbq1/fake-q1'])],
  q1dec: [CHAT, plannerOn(['tbq1/fake-q1']), EXECUTOR],
  q2: [CHAT, plannerOn(['tbq2/fake-qa', 'tbm/fake-main']), EXECUTOR],
  q3: [CHAT, PLANNER, executorOn(['tbq3/fake-qc', 'tbm/fake-b'])],
  cont: [CHAT, CREATOR, role('closer', 'Closes each request', { seats: ['close'], models: K_MODELS }),
    executorOn(K_MODELS), role('reviewer', 'Checks the work of another role',
      { models: ['tbk1/fake-k1', 'tbm/fake-main'] })],
};

/** @brief 提供商（synthetic test setup）：除 tbp 外都经记录代理连到合成端点；tbg 在 TB-38 里被删掉（gone）。 */
function providers() {
  const p = (id, models, opts) => tbProvider(id, PROXY, models, opts);
  const m = tbModel;
  return [
    p('tbm', [m('fake-main', { family: 'fam-main' }), m('fake-b', { family: 'fam-b', reasoning: true })]),
    p('tbo', [m('fake-other', { family: 'fam-o1', reasoning: true }),
      m('fake-other2', { family: 'fam-o2', reasoning: true })]),
    p('tbc', [m('fake-c')]), tbProvider('tbp', SLOW, [m('fake-probing')]), p('tbg', [m('fake-gone')]),
    p('tbs1', [m('fake-sw1')]), p('tbs2', [m('fake-sw2')]), p('tbs3', [m('fake-sw3')]),
    p('tbn1', [m('fake-n1')]), p('tbn2', [m('fake-n2')]),
    p('tbw', [m('fake-sub-404')]), p('tbcw', [m('fake-cw')]), p('tbcl', [m('fake-close-404')]),
    p('tbk', [m('fake-chat-404')]), p('tbo4', [m('fake-ask-404')]),
    p('tbq1', [m('fake-q1'), m('fake-q1b')], { concurrency: 1 }), p('tbq2', [m('fake-qa')], { concurrency: 1 }),
    p('tbq3', [m('fake-qc'), m('fake-qd')], { concurrency: 1 }), p('tbr', [m('fake-r')], { concurrency: 4 }),
    p('tbk1', [m('fake-k1')]), p('tbk2', [m('fake-k2', { reasoning: true })]),
  ];
}

/**
 * @brief 改写档案（synthetic test setup）：去掉 fake-probing 的档案（启动时探测它，它一直在探测中）；
 *        fake-k2 的推理回放一步判为不通过（reasoning.replay 为 required，§6.2 的接手判断要重建）。
 */
function patchProfiles(userData) {
  const file = join(userData, 'model-profiles.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.profiles = data.profiles.filter((profile) => profile.modelId !== 'fake-probing');
  for (const profile of data.profiles) {
    if (profile.modelId === 'fake-k2') profile.auto.steps.replay = { outcome: 'fail', detail: null };
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** @brief 测试准备（synthetic test setup）：临时项目与角色文件、两个合成端点、数据目录，启动 App。 */
async function setup(ctx) {
  ctx.p = {};
  for (const [name, roles] of Object.entries(PROJECTS)) {
    ctx.p[name] = tempProject(`mori-tb-models-${name}-`);
    if (roles.length) writeRoles(ctx.p[name], roles);
  }
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  ctx.slowLogs = [];
  ctx.slow = await startEndpoint(SLOW, { FAKE_FIRST_DELAY_MS: String(SLOW_DELAY_MS) }, ctx.slowLogs);
  seedTeamUserData(ctx.userData, { providers: providers(), normalDefault: 'tbm',
    groups: [{ id: 'g-ask', members: ['tbm/fake-main', 'tbo4/fake-ask-404'] }],
    profiles: { 'tbc/fake-c': { tier: 'C' } }, piSettings: { defaultThinkingLevel: 'low' } });
  patchProfiles(ctx.userData);
  await startTbApp(ctx);
  await watchTaskPhases(ctx);
}

/**
 * @brief 在 project 里开一个新会话；可先换范围（session.setPick，与菜单发的命令相同）、切到全部允许。
 * @return { tab, sessionId, sessionFile }
 */
async function openIn(ctx, project, { pick = null, allow = false } = {}) {
  const tab = await openSessionIn(ctx, project);
  const who = { tab, ...(await userSession(ctx, tab)) };
  if (pick) {
    const result = await tryBridge(ctx, { type: 'session.setPick', sessionId: who.sessionId, pick });
    if (result.error) throw new Error(`session.setPick ${pick}: ${result.error}`);
    await ctx.page.waitForFunction(({ css, want }) => document.querySelector(css)?.dataset.pick === want,
      { css: `${paneSel(tab)} [data-testid="model-button"]`, want: pick }, { timeout: 10000 });
  }
  if (allow) await allowAll(ctx, tab);
  return who;
}

/** @brief 开一个新会话并发第一条消息（默认带 /team）；who.since 是发送前的时刻。 */
async function begin(ctx, project, text, opts = {}) {
  const who = await openIn(ctx, project, opts);
  who.since = Date.now();
  await sendMessage(ctx, who.tab, text, { team: opts.team ?? true });
  return who;
}

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/**
 * @brief 等这个会话的对话回复完：回复里有 text，后台进程里对话不在运行或准备中（界面的生成中在后台有 Agent 时也亮着，
 *        所以看 session.open 的 live）。
 */
function waitReply(ctx, who, text, timeout = 30000) {
  return poll(async () => {
    const pane = await paneState(ctx.page, who.tab);
    if (!pane?.assistants.includes(text)) return false;
    const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
    return info !== null && !info.live?.running && !info.live?.preparing;
  }, timeout);
}

/** @brief 等后台进程里对话不在运行或准备中（后台的 Agent 不算）。 */
function dialogIdle(ctx, who, timeout = 30000) {
  return poll(async () => {
    const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
    return info !== null && !info.live?.running && !info.live?.preparing;
  }, timeout);
}

// ---------- longBatch：要等 60 秒以上的情形同时进行 ----------

/**
 * @brief 关闭模式下的一个会话在 pick 上发一条脚本 scenario 的消息，占住那个提供商的槽位；等端点收到它。
 * @return 会话（line 为端点收到它的日志行）
 */
async function holdSlot(ctx, pick, scenario) {
  const who = await openIn(ctx, ctx.p.plain, { pick });
  who.since = Date.now();
  await sendMessage(ctx, who.tab, `Hold the slot tb-scenario:${scenario}`);
  who.line = await poll(() => lines(ctx, scenario)[0], 15000, 100);
  if (!who.line) throw new Error(`${scenario} never reached the fake endpoint`);
  return who;
}

/** @brief tb-models-reserve 里每个 task 实例的第一个请求的日志行。 */
const reserveFirsts = (ctx) => lines(ctx, 'tb-models-reserve', { kind: 'task' }).filter((l) => l.k === 1 && l.j === 0);

/** @brief 留出的槽位（开始）：四个只读 task，等前三个的请求都发出，你插一句，记下对话的请求什么时候到端点。 */
async function reserveStart(ctx, r) {
  r.res = await begin(ctx, ctx.p.plain, 'Four reads tb-scenario:tb-models-reserve', { pick: 'tbr/fake-r' });
  const three = await poll(() => reserveFirsts(ctx).filter((line) => line.task !== 'T4').length >= 3, 30000, 100);
  if (!three) throw new Error('three task requests never reached the fake endpoint');
  await dialogIdle(ctx, r.res);
  r.askAt = Date.now();
  await sendMessage(ctx, r.res.tab, 'How is it going?');
  r.askLine = await poll(() => lines(ctx, 'tb-models-reserve', { kind: 'merged-create' }).find((l) => l.k === 2),
    70000, 100);
}

/** @brief 留出的槽位（结束）：等第四个 task 的请求发出（前面的一个结束后），然后撤销需求。 */
async function reserveEnd(ctx, r) {
  r.t4Line = await poll(() => reserveFirsts(ctx).find((line) => line.task === 'T4'), 150000, 200);
  await dialogIdle(ctx, r.res);
  await sendMessage(ctx, r.res.tab, 'Cancel it');
}

/**
 * @brief 调度类别的顺序（tbq1，并发 1）：占住槽位 20 秒，其间依次排进 background（探针）、task、decision、
 *        conversation 的请求；各会话先开好，发送之间只隔一两秒。
 */
async function orderRun(ctx, r) {
  const o = {};
  o.h1 = await openIn(ctx, ctx.p.plain, { pick: 'tbq1/fake-q1' });
  o.conv = await openIn(ctx, ctx.p.plain, { pick: 'tbq1/fake-q1' });
  o.task = await openIn(ctx, ctx.p.q1task);
  o.dec = await openIn(ctx, ctx.p.q1dec);
  o.h1.since = Date.now();
  await sendMessage(ctx, o.h1.tab, 'Hold the slot tb-scenario:tb-models-hold-order');
  o.h1.line = await poll(() => lines(ctx, 'tb-models-hold-order')[0], 15000, 100);
  o.verify = await tryBridge(ctx, { type: 'models.verify', refs: ['tbq1/fake-q1b'], tests: 'auto' });
  await sleep(700);
  o.task.since = Date.now();
  await sendMessage(ctx, o.task.tab, 'Queue a task tb-scenario:tb-models-order-task', { team: true });
  o.taskStarted = await waitTaskPhase(ctx, o.task.tab, { task: 'T1', phase: 'starting' }, 15000);
  await sleep(700);
  o.dec.since = Date.now();
  await sendMessage(ctx, o.dec.tab, 'Decide later tb-scenario:tb-models-order-dec', { team: true });
  await sleep(1500);
  o.conv.since = Date.now();
  await sendMessage(ctx, o.conv.tab, 'Quick question tb-scenario:tb-models-order-conv');
  o.queuedBy = Date.now();
  for (const key of ['h1', 'conv', 'dec', 'task']) await settle(ctx, o[key], 90000);
  r.order = o;
}

/** @brief 要等的情形同时开始，按顺序收尾，再逐个检查。 */
async function longBatch(ctx) {
  const r = {};
  r.picky = await begin(ctx, ctx.p.picky, 'Pick strict models tb-scenario:tb-models-picky');
  r.h2 = await holdSlot(ctx, 'tbq2/fake-qa', 'tb-models-hold-dec');
  r.q2 = await begin(ctx, ctx.p.q2, 'Plan after a wait tb-scenario:tb-models-dectime');
  r.h3 = await holdSlot(ctx, 'tbq3/fake-qc', 'tb-models-hold-task');
  r.verifyQd = Date.now();
  r.verifyQdResult = await tryBridge(ctx, { type: 'models.verify', refs: ['tbq3/fake-qd'], tests: 'auto' });
  await sleep(500);
  r.q3 = await begin(ctx, ctx.p.q3, 'Queue a patient task tb-scenario:tb-models-tasknotime');
  await reserveStart(ctx, r);
  await orderRun(ctx, r);
  await reserveEnd(ctx, r);
  for (const key of ['picky', 'q2', 'h2', 'h3', 'q3', 'res']) await settle(ctx, r[key], 240000);
  await checkPicky(ctx, r.picky);
  checkOrder(ctx, r.order);
  checkDecision(ctx, r);
  await checkTaskWait(ctx, r);
  await checkReserve(ctx, r);
}

// ---------- TB-38、TB-40：requires_unmet 与 probing，task 实例交给结案 ----------

/** @brief picky（C 级与探测中的候选）等满 60 秒后交给结案；pickyc（只有 C 级）马上交给结案。 */
async function checkPicky(ctx, who) {
  const board = readBoard(ctx, who.sessionId);
  const [t1, t2] = [taskOf(board, 'T1'), taskOf(board, 'T2')];
  const [b1, b2] = [noModelBaton(t1), noModelBaton(t2)];
  const tierC = 'No model available: tbc/fake-c — handoff tier C is below B';
  const both = `${tierC}; tbp/fake-probing — verifying…`;
  const rows = (await phasesOf(ctx, who.tab, who.since)).filter((item) => item.task === 'T1');
  const waiting = rows.find((item) => item.text.endsWith(' · Waiting for a model · verifying…'));
  record('TB-38 role requires: pickyc (requires protocol_write>=B, only the tier-C fake-c) is excluded with '
    + 'requires_unmet "handoff tier C is below B" and handed on at once (it does not recover, no wait); picky (also '
    + 'the never-probed tbp/fake-probing) waits for the probing model ("Waiting for a model · verifying…" at the end '
    + 'of its progress row) and after the 60 s wait is excluded with probing "verifying…"',
  b2?.conclusion === tierC && b2.at - t2.createdAt < 10000 && b1?.conclusion === both
    && b1.at - t1.createdAt >= 55000 && b1.at - t1.createdAt <= 90000 && waiting !== undefined,
  brief({ b1: b1 && [b1.conclusion, b1.at - t1.createdAt], b2: b2 && [b2.conclusion, b2.at - t2.createdAt],
    waiting: waiting?.text, rows: rows.map((item) => item.text).slice(0, 6) }));
  await showTab(ctx, who.tab);
  await setProgressOpen(ctx, who.tab, 1, true);
  const [block] = await progressOf(ctx, who.tab);
  const close = lines(ctx, 'tb-models-picky', { agent: 'planner', kind: 'close' });
  const chats = ctx.ep.logs.filter((line) => !line.probe && ['fake-c', 'fake-probing'].includes(line.model));
  record('TB-40 a task instance whose candidates are exhausted is handed to close (§7.4 no_model): both tasks get a '
    + 'program baton (from mori, reason no_model, routed to close), the close session is woken for each and closes '
    + 'them; the chains read "Mori: no model → planner: …"; no chat request ever reached an excluded model',
  [b1, b2].every((b) => b?.from === 'mori' && b.routedTo.kind === 'close') && close.length >= 2
    && ['T1', 'T2'].every((id) => block?.chains[id]?.startsWith('Mori: no model → planner: '))
    && board?.requests[0]?.status === 'failed' && chats.length === 0 && ctx.slowLogs.every((line) => line.probe),
  brief({ close: close.length, chains: block?.chains, status: board?.requests[0]?.status, chats: chats.length }));
  await setProgressOpen(ctx, who.tab, 1, false);
}

// ---------- TB-41：调度类别 ----------

/** @brief 日志行的调度类别（按脚本与会话种类认）。 */
function classOf(line) {
  if (line.probe) return 'background';
  if (line.scenario === 'tb-models-order-conv') return 'conversation';
  if (line.scenario === 'tb-models-order-dec' && line.kind === 'create') return 'decision';
  if (line.scenario === 'tb-models-order-task' && line.kind === 'task') return 'task';
  return `other:${line.scenario}/${line.agent}/${line.kind}`;
}

/** @brief 槽位空出来后端点按 conversation、decision、task、background 收到。 */
function checkOrder(ctx, o) {
  const hold = o.h1.line;
  const released = hold.t + MODELS_TEXT.holdOrderMs;
  const after = ctx.ep.logs.filter((line) => ['fake-q1', 'fake-q1b'].includes(line.model) && line.t > hold.t);
  const order = after.slice(0, 4).map(classOf);
  record('TB-41 strict priority conversation > decision > task > background: while a conversation holds tbq1 '
    + '(concurrency 1) for 20 s, a probe (background), a task instance, a split create session (decision) and a '
    + 'conversation queue in that order; when the slot frees the endpoint receives them as conversation, decision, '
    + 'task, background',
  same(order, ['conversation', 'decision', 'task', 'background']) && after[0].t >= released - 1000
    && o.queuedBy < released - 2000 && o.taskStarted !== null && o.verify.error === null,
  brief({ order: after.slice(0, 6).map((line) => `${classOf(line)}@${line.t - hold.t}`), queuedBy: o.queuedBy - hold.t,
    verify: o.verify.error }));
}

/** @brief decision 排队超过 60 秒换模型（tbq2 被占住 80 秒）。 */
function checkDecision(ctx, r) {
  const plan = lines(ctx, 'tb-models-dectime', { agent: 'planner', kind: 'create' });
  const file = instanceOf(ctx, r.q2, 'create');
  const switches = customOf(file?.entries ?? [], 'mori.model_switch');
  const wait = plan[0] ? plan[0].t - r.q2.since : null;
  record('TB-41 decision requests time out in the queue and switch model: the split create session\'s request on '
    + 'tbq2 (held 80 s by a conversation) switches after 60 s to tbm/fake-main with queue_timeout ("waited 60 s for '
    + 'a free slot", mori.model_switch in the create session file); no planner request ever reaches fake-qa',
  plan.length >= 1 && modelsOf(plan).length === 1 && plan[0].model === 'fake-main' && wait >= 59000 && wait <= 78000
    && switches.length === 1 && switches[0].from === 'tbq2/fake-qa' && switches[0].to === 'tbm/fake-main'
    && switches[0].reason === 'queue_timeout' && /^waited 6\d s for a free slot$/.test(switches[0].detail),
  brief({ wait, models: modelsOf(plan), switches }));
}

/** @brief fake-qd 的档案此刻的探测时刻（model-profiles.json）；没有时为 0。 */
function probedAt(ctx, modelId) {
  const file = join(ctx.userData, 'model-profiles.json');
  if (!existsSync(file)) return 0;
  const profile = JSON.parse(readFileSync(file, 'utf8')).profiles.find((item) => item.modelId === modelId);
  return profile?.probedAt ?? 0;
}

/** @brief task 与 background 不超时（tbq3 被占住 100 秒）：task 的请求和探针一直排队，不换模型。 */
async function checkTaskWait(ctx, r) {
  const t1 = taskOf(readBoard(ctx, r.q3.sessionId), 'T1');
  const exec = lines(ctx, 'tb-models-tasknotime', { agent: 'executor', kind: 'task' });
  const file = instanceOf(ctx, r.q3, 'task', { task: 'T1', role: 'executor' });
  const switches = customOf(file?.entries ?? [], 'mori.model_switch');
  const released = r.h3.line.t + MODELS_TEXT.holdTaskMs;
  const queued = exec[0] && t1 ? exec[0].t - t1.createdAt : null;
  record('TB-41 task requests do not time out in the queue: T1\'s executor request waits for tbq3 (held 100 s) for '
    + 'more than 60 s and is then sent to its first model fake-qc (no model switch, not to tbm/fake-b); the task '
    + 'finishes', exec.length >= 1 && modelsOf(exec).length === 1 && exec[0].model === 'fake-qc' && queued >= 60000
    && exec[0].t >= released - 1000 && switches.length === 0 && t1?.status === 'done',
  brief({ queued, sentAfterRelease: exec[0] && exec[0].t - released, models: modelsOf(exec), switches,
    status: t1?.status }));
  await poll(() => probedAt(ctx, 'fake-qd') > r.verifyQd, 60000, 500);
  const probes = ctx.ep.logs.filter((line) => line.probe && line.model === 'fake-qd');
  const done = probedAt(ctx, 'fake-qd');
  record('TB-41 background requests do not time out in the queue: the probe of tbq3/fake-qd (models.verify, started '
    + 'before the task) waits for the slot more than 60 s, is sent after the task\'s request (task before '
    + 'background), runs all its steps and saves the profile', r.verifyQdResult.error === null && probes.length >= 3
    && probes[0].t - r.verifyQd >= 60000 && exec[0] !== undefined && probes[0].t > exec[0].t && done > r.verifyQd,
  brief({ probes: probes.length, firstAfter: probes[0] && probes[0].t - r.verifyQd, afterTask: probes[0] && exec[0]
    && probes[0].t - exec[0].t, saved: done > r.verifyQd, error: r.verifyQdResult.error }));
}

/** @brief 留出的槽位：四个 task 实例在并发 4 的 tbr 上，对话的请求马上发出、不排队超时。 */
async function checkReserve(ctx, r) {
  const firsts = reserveFirsts(ctx);
  const early = firsts.filter((line) => line.task !== 'T4');
  const ask = r.askLine;
  const flying = ask ? early.filter((line) => line.t < ask.t && ask.t < line.t + MODELS_TEXT.reserveMs) : [];
  const start = Math.min(...early.map((line) => line.t));
  const switches = await kernelEvents(ctx, r.res.sessionId, 'mori.model_switch', r.res.since);
  const pane = await paneState(ctx.page, r.res.tab);
  record('TB-41 reserved slot: four task instances on tbr (concurrency 4) — only three task requests are in flight '
    + 'and the fourth waits; your message meanwhile reaches the endpoint within 5 s on fake-r (no queue_timeout, no '
    + 'model switch) and is answered; the fourth task request is sent only after a task request ends (~70 s)',
  early.length === 3 && flying.length === 3 && ask && ask.t - r.askAt < 5000 && ask.model === 'fake-r'
    && r.t4Line && r.t4Line.t > ask.t && r.t4Line.t >= start + MODELS_TEXT.reserveMs - 1500 && switches.length === 0
    && pane.assistants.includes('Three tasks are running and one waits for a slot.'),
  brief({ flying: flying.length, askAfter: ask && ask.t - r.askAt, askModel: ask?.model,
    t4After: r.t4Line && r.t4Line.t - start, switches: switches.length, replies: pane.assistants.slice(-3) }));
}

// ---------- TB-38：选择、锁定的模型按钮、思考强度（tb-models-sel） ----------

/** @brief 协作模式下的模型按钮：样子，点击与 Enter 都不打开菜单。 */
async function lockedView(ctx, who) {
  const button = await modelButton(ctx, who.tab);
  const locator = ctx.page.locator(`${paneSel(who.tab)} [data-testid="model-button"]`);
  // aria-disabled 的按钮 Playwright 会一直等它可用；照样点一下（force 只跳过等待，仍是真实的鼠标点击）。
  await locator.click({ force: true, timeout: 5000 });
  await sleep(300);
  const afterClick = await ctx.page.getByTestId('model-menu').count();
  await locator.focus();
  await ctx.page.keyboard.press('Enter');
  await sleep(300);
  const afterEnter = await ctx.page.getByTestId('model-menu').count();
  await ctx.page.keyboard.press('Escape');
  return { button, afterClick, afterEnter, mode: (await teamSwitch(ctx, who.tab)).mode,
    thinking: await thinkingButton(ctx, who.tab) };
}

/** @brief 选范围 tbm/fake-b、思考强度 high，/team 之后在 T1 运行时看锁定的按钮与 setPick，结束后回到 off 再发一条。 */
async function sel(ctx) {
  const who = await openIn(ctx, ctx.p.sel, { pick: 'tbm/fake-b' });
  await chooseLevel(ctx, who.tab, 'high');
  who.since = Date.now();
  await sendMessage(ctx, who.tab, 'Pick models tb-scenario:tb-models-sel', { team: true });
  if (!(await waitReply(ctx, who, 'Chat team reply 1.'))) throw new Error('chat never replied');
  const lock = await lockedView(ctx, who);
  lock.refused = await tryBridge(ctx, { type: 'session.setPick', sessionId: who.sessionId, pick: 'tbm/fake-main' });
  lock.options = await tryBridge(ctx, { type: 'session.pickOptions', sessionId: who.sessionId });
  lock.t1 = taskOf(readBoard(ctx, who.sessionId), 'T1')?.status;
  await settle(ctx, who, 60000);
  const unlocked = { button: await modelButton(ctx, who.tab), mode: (await teamSwitch(ctx, who.tab)).mode };
  who.offAt = Date.now();
  await sendMessage(ctx, who.tab, 'Answer on my range');
  await settle(ctx, who, 30000);
  selLocked(ctx, who, lock);
  selModels(ctx, who, lock);
  selOff(ctx, who, unlocked);
  selThinking(ctx, who, lock);
}

/** @brief TB-38：协作模式下输入框下面一行的模型按钮只显示模型、setPick 被拒绝、pickOptions 为空。 */
function selLocked(ctx, who, lock) {
  record('TB-38 team mode: the model button in the message-box row only shows the model in use (data-locked, text '
    + '"fake-other" = chat\'s model, no menu marker, hover "Team mode picks the model for each agent"); clicking it or '
    + 'pressing Enter opens no menu', lock.mode === 'once' && lock.button.locked && lock.button.text === 'fake-other'
    && lock.button.title === LOCKED_TITLE && lock.button.popup === null && lock.afterClick === 0
    && lock.afterEnter === 0 && lock.t1 === 'active', brief(lock));
  record('TB-38 team mode: session.setPick is refused with "Team mode picks the model for each agent" and '
    + 'session.pickOptions returns no options', lock.refused.error?.includes(LOCKED_TITLE) === true
    && lock.options.error === null && lock.options.value?.error === null && lock.options.value?.options.length === 0,
  brief({ refused: lock.refused, options: lock.options }));
}

/** @brief TB-38：角色按自己的 models、requires 选（端点日志里每个会话用的模型）。 */
function selModels(ctx, who, lock) {
  const team = (where) => lines(ctx, 'tb-models-sel', where).filter((line) => line.t < who.offAt);
  const create = team({ agent: 'planner' });
  const chat = team({ agent: 'chat', kind: 'team-dialog' });
  const exec = team({ agent: 'executor', kind: 'task' });
  record('TB-38 every role picks by its own models and requires: chat (models [tbo/fake-other]) answers on '
    + 'fake-other, planner (no models) uses the session range you picked (tbm/fake-b, not the default tbm), executor '
    + '(models [tbc/fake-c, tbo/fake-other2], requires protocol_write>=B) skips the tier-C fake-c and runs on '
    + 'fake-other2', same(modelsOf(chat), ['fake-other']) && same(modelsOf(create), ['fake-b'])
    && same(modelsOf(exec), ['fake-other2']) && create.some((line) => line.kind === 'close') && lock !== null,
  brief({ chat: modelsOf(chat), planner: modelsOf(create), executor: modelsOf(exec) }));
}

/** @brief TB-38：回到 off 后范围不变（协作模式不写 mori.pick），对话照你选的范围。 */
function selOff(ctx, who, unlocked) {
  const entries = userEntries(who);
  const picks = customOf(entries, 'mori.pick').map((data) => data.pick);
  const firstUser = entries.findIndex((entry) => entry.type === 'message' && entry.message.role === 'user');
  const lastPick = entries.findLastIndex((entry) => entry.type === 'custom' && entry.customType === 'mori.pick');
  const off = lines(ctx, 'tb-models-sel', { agent: 'chat', since: who.offAt });
  record('TB-38 back in off mode the range is unchanged: when the request closes Team: Until done returns to off, '
    + 'the model button is a range menu again on tbm/fake-b, no mori.pick was written in team mode (all before the '
    + 'first message, last one tbm/fake-b), and the next off-mode reply is on fake-b',
  unlocked.mode === 'off' && !unlocked.button.locked && unlocked.button.popup === 'menu'
    && unlocked.button.pick === 'tbm/fake-b' && picks.at(-1) === 'tbm/fake-b' && lastPick < firstUser
    && off.length === 1 && off[0].kind === 'off-dialog' && off[0].model === 'fake-b',
  brief({ unlocked, picks, lastPick, firstUser, off: off.map((line) => [line.kind, line.model]) }));
}

/** @brief TB-38：思考强度只作用于对话会话（对话 high，实例照默认 low）。 */
function selThinking(ctx, who, lock) {
  const requests = scenarioRequests(ctx.ep, 'tb-models-sel');
  const dialog = requests.filter((item) => item.info.role === 'chat').map((item) => thinkingOf(item.body));
  const others = requests.filter((item) => item.info.role !== 'chat').map((item) => thinkingOf(item.body));
  record('TB-38 the thinking level only applies to the dialog session: with "high" chosen on the dialog, every chat '
    + 'request (team and off mode) carries high, while planner and executor requests (reasoning models too) carry '
    + 'the default low; the thinking button stays usable in team mode',
  dialog.length >= 3 && dialog.every((value) => value.includes('"high"')) && others.length >= 3
    && others.every((value) => !value.includes('high') && value.includes('low')) && lock.thinking.level === 'high'
    && !lock.thinking.disabled, brief({ dialog: [...new Set(dialog)], others: [...new Set(others)],
    thinking: lock.thinking }));
}

// ---------- TB-38：differ_from: author（tb-models-fam） ----------

/** @brief T1 executor 写了文件，reviewer 避开 fam-main 用 fake-b；T2 只读过，reviewer 用首选 fake-main。 */
async function fam(ctx) {
  const who = await begin(ctx, ctx.p.fam, 'Write and review tb-scenario:tb-models-fam', { allow: true });
  await settle(ctx, who, 90000);
  const board = readBoard(ctx, who.sessionId);
  const [t1, t2] = [taskOf(board, 'T1'), taskOf(board, 'T2')];
  const review = (task) => modelsOf(lines(ctx, 'tb-models-fam', { agent: 'reviewer', kind: 'task', task }));
  const exec = modelsOf(lines(ctx, 'tb-models-fam', { agent: 'executor', kind: 'task' }));
  record('TB-38 differ_from: author excludes the model family that changed code: executor wrote notes.txt on T1 '
    + '(fake-main, family fam-main; the baton\'s authorFamilies is [fam-main]) and reviewer (models [fake-main, '
    + 'fake-b]) reviews T1 on fake-b; on T2 executor only read (authorFamilies []) and reviewer uses its first model '
    + 'fake-main', same(exec, ['fake-main']) && same(review('T1'), ['fake-b']) && same(review('T2'), ['fake-main'])
    && same(t1?.handoffs[0]?.authorFamilies, ['fam-main']) && same(t2?.handoffs[0]?.authorFamilies, [])
    && existsSync(join(ctx.p.fam, 'notes.txt')) && board?.requests[0]?.status === 'done',
  brief({ exec, t1: review('T1'), t2: review('T2'), families: [t1?.handoffs[0]?.authorFamilies,
    t2?.handoffs[0]?.authorFamilies], status: board?.requests[0]?.status }));
}

// ---------- TB-38：协作模式下被拒绝启动，Turn off team mode（tb-models-gone） ----------

/**
 * @brief chat 唯一的模型所在的提供商在设置里被删掉（models.deleteProvider，同 设置 → Models 的 Delete…；2026-10-26 起
 *        没有网络区域，原来是收回项目的公网授权）：拒绝启动卡（pick_missing）上没有 Change model、有 Turn off team mode；
 *        点后回到 off、T1 stopped。
 */
async function gone(ctx) {
  const who = await begin(ctx, ctx.p.gone, 'Start long work tb-scenario:tb-models-gone');
  const started = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'starting' }, 30000);
  if (!(await waitReply(ctx, who, 'Chat team reply 1.'))) throw new Error('chat never replied');
  const before = await modelButton(ctx, who.tab);
  const removed = await tryBridge(ctx, { type: 'models.deleteProvider', id: 'tbg', dryRun: false });
  const card = await poll(() => blockedCard(ctx, who.tab), 10000);
  const modeBefore = (await teamSwitch(ctx, who.tab)).mode;
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="blocked-card"] [data-action="turn-off-team"]`).click();
  const off = await poll(async () => (await teamSwitch(ctx, who.tab)).mode === 'off', 10000);
  const stopped = await waitTaskPhase(ctx, who.tab, { task: 'T1', phase: 'stopped' }, 15000);
  await settle(ctx, who, 30000);
  const board = readBoard(ctx, who.sessionId);
  const after = { card: await blockedCard(ctx, who.tab), button: await modelButton(ctx, who.tab),
    progress: (await progressOf(ctx, who.tab))[0] };
  record('TB-38 in team mode the blocked card of the dialog session has no "Change model…": with the provider of '
    + 'chat\'s only model deleted in Settings, the card (pick_missing) offers "Turn off team mode" and Open settings '
    + 'instead', removed.error === null && removed.value?.error === null && card?.kind === 'pick_missing'
    && same(card.actions, ['turn-off-team', 'open-settings']) && modeBefore === 'once' && before.locked
    && before.text === 'fake-gone', brief({ card, modeBefore, before, removed }));
  const t1 = taskOf(board, 'T1');
  const exec = lines(ctx, 'tb-models-gone', { agent: 'executor' });
  record('TB-38 Turn off team mode on the blocked card goes straight to off although request 1 is still open, and '
    + 'the task of the open request becomes stopped ("Stopped", request state Stopped, no new task request); the '
    + 'model button unlocks and the card goes away (off mode uses your range)',
  started !== null && off && stopped !== null && t1?.status === 'stopped' && t1.stopReason === 'user'
    && board.requests[0].status === 'open' && after.progress?.state === 'stopped' && after.card === null
    && !after.button.locked && exec.length === 1,
  brief({ off, stopped, t1: t1 && [t1.status, t1.stopReason], request: board?.requests[0]?.status,
    progress: after.progress?.state, card: after.card, button: after.button, exec: exec.length }));
}

// ---------- TB-39、TB-52、TB-40 订阅：task 中途换模型（tb-models-sw） ----------

/** @brief executor 在 fake-sw1 上第一个请求 429（原地换 fake-sw2），读完后 429（结束本轮、在 fake-sw3 上重来）。 */
async function sw(ctx) {
  const who = await begin(ctx, ctx.p.sw, 'Switch models tb-scenario:tb-models-sw');
  await settle(ctx, who, 90000);
  await poll(() => instanceOf(ctx, who, 'subscription')?.entries.some((entry) => entry.type === 'message'
    && entry.message.role === 'assistant'), 20000);
  const file = instanceOf(ctx, who, 'task', { task: 'T1', role: 'executor' });
  const requests = scenarioRequests(ctx.ep, 'tb-models-sw', { agent: 'executor', kind: 'task' });
  const on = (model) => requests.filter((item) => item.body.model === model);
  const run = { file, entries: file?.entries ?? [], r1: on('fake-sw1'), r2: on('fake-sw2'), r3: on('fake-sw3') };
  swRestart(ctx, who, run);
  swFresh(ctx, who, run);
  swInPlace(ctx, who, run);
  await swNote(ctx, who, run);
  await swSubscription(ctx, who);
}

/** @brief 换模型重来的投递（§12.4 的固定文字）。 */
const RESTART_TEXT = '[Mori] The model changed (tbs2/fake-sw2 → tbs3/fake-sw3: rate limited). Continue T1 on the new '
  + 'model from the work card. Your earlier work on T1 is in your session: '
  + 'read_session {"task":"T1","role":"executor"}.';

/** @brief TB-39：有过程时结束本轮，写 mori.model_switch 与 mori.task_restart，继续的消息提示读自己的会话。 */
function swRestart(ctx, who, run) {
  const { entries } = run;
  const switches = customOf(entries, 'mori.model_switch');
  const restarts = customOf(entries, 'mori.task_restart');
  const ended = messagesOf(entries, 'assistant').filter((m) => m.stopReason === 'error'
    && m.errorMessage === 'MODEL_RESTART');
  const at = (pred) => entries.findIndex(pred);
  const restartAt = at((entry) => entry.type === 'custom' && entry.customType === 'mori.task_restart');
  const endAt = at((entry) => entry.type === 'message' && entry.message.errorMessage === 'MODEL_RESTART');
  const deliveries = messagesOf(entries, 'user').map(textOf);
  record('TB-39 with work done in the run, switching model ends the run: the instance file gets mori.model_switch '
    + '(tbs2/fake-sw2 → tbs3/fake-sw3, rate_limited) and mori.task_restart (same from/to/reason), the run ends with '
    + 'an error assistant message "MODEL_RESTART", and the next delivery in the same session is the restart message',
  switches.length === 2 && switches[1].from === 'tbs2/fake-sw2' && switches[1].to === 'tbs3/fake-sw3'
    && switches[1].reason === 'rate_limited' && restarts.length === 1 && restarts[0].from === 'tbs2/fake-sw2'
    && restarts[0].to === 'tbs3/fake-sw3' && restarts[0].reason === 'rate_limited' && ended.length === 1
    && endAt >= 0 && restartAt >= 0 && deliveries.at(-1) === RESTART_TEXT,
  brief({ switches: switches.map((s) => [s.from, s.to, s.reason]), restarts: restarts.map((s) => [s.from, s.to,
    s.reason]), ended: ended.length, restartAt, endAt, last: deliveries.at(-1) }));
  record('TB-39 the continue message tells the instance to read its own session: "[Mori] The model changed '
    + '(tbs2/fake-sw2 → tbs3/fake-sw3: rate limited). Continue T1 on the new model from the work card. Your earlier '
    + 'work on T1 is in your session: read_session {"task":"T1","role":"executor"}."',
  run.r3[0]?.info.last === RESTART_TEXT && deliveries.includes(RESTART_TEXT),
  brief({ last: run.r3[0]?.info.last }));
}

/** @brief TB-39：新模型上的请求里没有之前的消息；继续的那一段从新模型开始，不是首选。 */
function swFresh(ctx, who, run) {
  const first = run.r3[0];
  const body = first ? first.messages.filter((m) => m.role !== 'system' && m.role !== 'developer') : [];
  const users = body.filter((m) => m.role === 'user').map((m) => contentText(m.content));
  record('TB-39 the request on the new model has none of the earlier messages: fake-sw3\'s first request holds only '
    + 'the restart message and the work card (no assistant message, no tool result, not the first delivery '
    + '"You are executor on T1")', first !== undefined && body.every((m) => m.role === 'user') && users.length === 2
    && users.filter((text) => !text.includes('<mori-work-card>')).length === 1
    && !users.some((text) => text.startsWith('[Mori] You are executor on T1')),
  brief({ roles: body.map((m) => m.role), users: users.map((text) => text.slice(0, 80)) }));
  const recovered = first && run.r1[0] ? first.t - run.r1[0].t : null;
  const sw1After = run.r1.filter((item) => run.r1[0] && item.t > run.r1[0].t);
  record('TB-39 the continued segment starts on the new model, not on the first choice: every restart-1 request goes '
    + 'to fake-sw3 although fake-sw1 (first candidate, 429 with Retry-After 3 s) had recovered when the segment '
    + 'started; fake-sw1 never gets another request', run.r3.length >= 2
    && run.r3.every((item) => item.info.k === 'restart-1') && recovered > MODELS_TEXT.sw1RetryAfter * 1000 + 500
    && sw1After.length === 0, brief({ r3: run.r3.map((item) => item.info.k), recovered, sw1After: sw1After.length }));
}

/** @brief TB-39：第一个请求就失败时原地换（同一个请求、同一次运行、没有 mori.task_restart）。 */
function swInPlace(ctx, who, run) {
  const [a, b] = [run.r1[0], run.r2[0]];
  const switches = customOf(run.entries, 'mori.model_switch');
  const firstAssistant = run.entries.findIndex((entry) => entry.type === 'message'
    && entry.message.role === 'assistant');
  const firstSwitch = run.entries.findIndex((entry) => entry.type === 'custom'
    && entry.customType === 'mori.model_switch');
  const restartAt = run.entries.findIndex((entry) => entry.type === 'custom'
    && entry.customType === 'mori.task_restart');
  record('TB-39 when the first request fails the switch happens in place: fake-sw1\'s first request (429) is sent '
    + 'again unchanged to fake-sw2 in the same run (same messages, k=1 j=0), with one mori.model_switch '
    + '(tbs1/fake-sw1 → tbs2/fake-sw2) and no mori.task_restart before the run\'s first assistant message',
  a !== undefined && b !== undefined && run.r1.length === 1 && same(a.messages, b.messages) && b.info.k === 1
    && b.info.j === 0 && switches[0]?.from === 'tbs1/fake-sw1' && switches[0].to === 'tbs2/fake-sw2'
    && firstSwitch >= 0 && firstSwitch < firstAssistant && restartAt > firstAssistant,
  brief({ sameMessages: a && b && same(a.messages, b.messages), k: b?.info.k, j: b?.info.j, firstSwitch,
    firstAssistant, restartAt }));
}

/** @brief TB-52：进展摘要这一行末尾的 Switched model 提示，下一次运行开始时清掉。 */
async function swNote(ctx, who, run) {
  const rows = (await phasesOf(ctx, who.tab, who.since)).filter((item) => item.task === 'T1');
  const note = ' · Switched model: tbs1/fake-sw1 → tbs2/fake-sw2 · rate limited';
  const shown = rows.filter((item) => item.text.endsWith(note));
  const restartAt = run.r3[0]?.t ?? Infinity;
  const late = rows.filter((item) => item.t > restartAt + 300 && ['starting', 'running'].includes(item.phase));
  record('TB-52 after the instance switches model its progress row ends with " · Switched model: tbs1/fake-sw1 → '
    + 'tbs2/fake-sw2 · rate limited" (e.g. "T1 Read across models · executor · Read README.md · Switched model: …"), '
    + 'and the note is gone once the next run starts (the restart run\'s rows on fake-sw3 have no note)',
  shown.length >= 1 && shown.every((item) => item.text.startsWith('T1 Read across models · executor · '))
    && late.length >= 1 && late.every((item) => !item.text.includes('Switched model')),
  brief({ shown: shown.map((item) => item.text), late: late.map((item) => item.text),
    rows: rows.map((item) => `${item.phase}|${item.text}`).slice(0, 12) }));
}

/** @brief TB-40：订阅候选耗尽，记在它自己的会话里，不另外处理。 */
async function swSubscription(ctx, who) {
  const sub = instanceOf(ctx, who, 'subscription', { role: 'watcher' });
  const errors = messagesOf(sub?.entries ?? [], 'assistant').filter((m) => m.stopReason === 'error');
  // 订阅的投递只带需求标题，不带 tb-scenario：按它的模型认出它的请求。
  const subLines = ctx.ep.logs.filter((line) => !line.probe && line.model === 'fake-sub-404' && line.t >= who.since);
  const last = subLines.at(-1);
  const others = last ? lines(ctx, 'tb-models-sw', { since: last.t + 1 }).filter((line) => line.agent !== 'watcher'
    && line.agent !== 'chat') : [];
  const board = readBoard(ctx, who.sessionId);
  const wakes = (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since)).map((item) => item.data.kind);
  record('TB-40 a subscription whose candidates are exhausted is only recorded in its own session: watcher\'s only '
    + 'model answers 404 and its session file ends with an error "No model available: tbw/fake-sub-404 — model not '
    + 'found on the server"; nothing else happens (no other request after it, no extra wake, the board keeps the '
    + 'closed request as it was)',
  subLines.length === 1 && subLines[0].status === 404 && errors.length === 1
    && errors[0].errorMessage?.includes('No model available') === true
    && errors[0].errorMessage.includes('tbw/fake-sub-404 — model not found on the server') && others.length === 0
    && same(wakes, ['request_closed']) && board?.requests[0]?.status === 'done' && board.tasks.length === 1
    && board.tasks[0].handoffs.length === 2,
  brief({ lines: subLines.map((line) => line.status), error: errors[0]?.errorMessage, others: others.length, wakes,
    handoffs: board?.tasks[0]?.handoffs.length }));
}

// ---------- TB-52：task 交给结案时清掉模型提示（tb-models-note） ----------

/**
 * @brief executor 的第一个请求在 fake-n1 上 429，原地换到 fake-n2（这一行带提示），读完交给结案；executor 之后
 *        没有新的运行，所以交到结案的这一行没有提示只能是交接时清掉的（§12.12）。
 */
async function note(ctx) {
  const who = await begin(ctx, ctx.p.note, 'Hand it over tb-scenario:tb-models-note');
  await settle(ctx, who, 90000);
  const rows = (await phasesOf(ctx, who.tab, who.since)).filter((item) => item.task === 'T1');
  const text = ' · Switched model: tbn1/fake-n1 → tbn2/fake-n2 · rate limited';
  const shown = rows.filter((item) => item.text.endsWith(text));
  const closeAt = rows.findIndex((item) => item.phase === 'with_close');
  const after = closeAt >= 0 ? rows.slice(closeAt) : [];
  const file = instanceOf(ctx, who, 'task', { task: 'T1', role: 'executor' });
  const switches = customOf(file?.entries ?? [], 'mori.model_switch').map((s) => [s.from, s.to, s.reason]);
  const execK = scenarioRequests(ctx.ep, 'tb-models-note', { agent: 'executor', kind: 'task' })
    .map((item) => item.info.k);
  const t1 = taskOf(readBoard(ctx, who.sessionId), 'T1');
  record('TB-52 the note is cleared when the task is handed to close: executor switched model in place (tbn1/fake-n1 '
    + '→ tbn2/fake-n2, rate limited) and its row ended with " · Switched model: tbn1/fake-n1 → tbn2/fake-n2 · rate '
    + 'limited"; once T1 is handed to close (no new executor run) the "With …" row and every later row have no note',
  shown.length >= 1 && shown.every((item) => item.text.startsWith('T1 Read then hand over · executor · '))
    && same(switches, [['tbn1/fake-n1', 'tbn2/fake-n2', 'rate_limited']]) && execK.every((k) => k === 1)
    && after.some((item) => item.phase === 'with_close' && item.text.startsWith('T1 Read then hand over · With '))
    && after.every((item) => !item.text.includes('Switched model'))
    && t1?.status === 'done' && t1.handoffs.length === 2,
  brief({ shown: shown.map((item) => item.text), after: after.map((item) => `${item.phase}|${item.text}`),
    switches, execK, t1: t1 && [t1.status, t1.handoffs.length] }));
}

// ---------- TB-40：§12.5 表的其余各行 ----------

/** @brief 立项判断你的消息时选不到模型：按不需要协作，对话的工作卡写 couldn't decide: no model available。 */
async function cdead(ctx) {
  const who = await begin(ctx, ctx.p.cdead, 'Hello there tb-scenario:tb-models-cdead');
  await settle(ctx, who, 60000);
  const requests = scenarioRequests(ctx.ep, 'tb-models-cdead', { agent: 'chat', kind: 'team-dialog' });
  const card = cardOf(requests[0]);
  const pane = await paneState(ctx.page, who.tab);
  const board = readBoard(ctx, who.sessionId);
  record('TB-40 create (judging your message) with no model: planner (only the tier-C fake-c, requires B) cannot '
    + 'run, the message is treated as needing no collaboration — chat answers it and its work card says "For this '
    + 'message planner couldn\'t decide: no model available"; planner sends no request, no receipt, no request on the '
    + 'board', requests.length === 1 && card.includes("planner couldn't decide: no model available")
    && lines(ctx, 'tb-models-cdead', { agent: 'planner' }).length === 0 && (await receiptsOf(ctx, who.tab)).length === 0
    && (board === null || board.requests.length === 0) && pane.assistants.includes('Chat team reply 1.'),
  brief({ card: card.slice(0, 600), replies: pane.assistants, board: board?.requests.length ?? null }));
}

/** @brief 程序唤醒的立项选不到模型：唤醒对话转告你。 */
async function cwake(ctx) {
  const who = await begin(ctx, ctx.p.cwake, 'Ask me later tb-scenario:tb-models-cwake');
  await settle(ctx, who, 60000);
  const wakes = (await kernelEvents(ctx, who.sessionId, 'mori.wake', who.since)).map((item) => item.data);
  const want = "[Mori] planner can't run: no model available (No model available: tbcw/fake-cw — model not found on "
    + 'the server). Tell the user.';
  const woken = lines(ctx, 'tb-models-cwake', { agent: 'planner', kind: 'create' }).filter((line) => line.k === 2);
  const pane = await paneState(ctx.page, who.tab);
  record('TB-40 program-woken create with no model: T1 need_user wakes planner, its only model answers 404; the '
    + 'dialog is woken with a hidden delivery "[Mori] planner can\'t run: no model available (No model available: '
    + 'tbcw/fake-cw — model not found on the server). Tell the user." and tells you',
  woken.length >= 1 && woken.every((line) => line.status === 404) && wakes.some((wake) => wake.kind === 'ask_user'
    && wake.text === want) && pane.assistants.at(-1) === 'Chat team reply 2.'
    && !pane.users.some((text) => text.includes('[Mori]')),
  brief({ wakes: wakes.map((wake) => [wake.kind, wake.text]), woken: woken.map((line) => line.status),
    last: pane.assistants.at(-1) }));
}

/** @brief 结案选不到模型：交给它的 task 交给立项（need_user，问题为 closer can't run: no model available）。 */
async function closer(ctx) {
  const who = await begin(ctx, ctx.p.closer, 'Close it tb-scenario:tb-models-closer');
  await settle(ctx, who, 60000);
  const t1 = taskOf(readBoard(ctx, who.sessionId), 'T1');
  const baton = t1?.handoffs.at(-1);
  const closeLines = lines(ctx, 'tb-models-closer', { agent: 'closer', kind: 'close' });
  const woken = scenarioRequests(ctx.ep, 'tb-models-closer', { agent: 'planner', kind: 'create' })
    .filter((item) => item.info.k === 2);
  record('TB-40 close with no model: closer\'s only model answers 404; T1 that was handed to it goes to planner as '
    + 'need_user with the question "closer can\'t run: no model available" (program baton from mori, reason '
    + 'no_model, T1 waiting_user) and planner is woken with "[Mori] T1 needs a decision from the user"',
  closeLines.length >= 1 && closeLines.every((line) => line.status === 404) && t1?.status === 'waiting_user'
    && t1.question === "closer can't run: no model available" && baton?.from === 'mori' && baton.reason === 'no_model'
    && baton.routedTo.kind === 'create' && woken.length >= 1
    && woken[0].info.last.includes('[Mori] T1 needs a decision from the user'),
  brief({ close: closeLines.map((line) => line.status), t1: t1 && [t1.status, t1.question], baton: baton && [baton.from,
    baton.reason, baton.routedTo], woken: woken[0]?.info.last.slice(0, 120) }));
}

/** @brief 对话候选耗尽：统一模型提供商规格 §9.3 的说明卡（不变），没有 v0 的错误卡。 */
async function chat404(ctx) {
  const who = await begin(ctx, ctx.p.chat404, 'Talk to me tb-scenario:tb-models-chat404');
  await poll(async () => (await paneState(ctx.page, who.tab)).unavailable.length > 0, 30000);
  await settle(ctx, who, 30000);
  const pane = await paneState(ctx.page, who.tab);
  const [card] = pane.unavailable;
  record('TB-40 dialog with no model: chat\'s only model (team mode) answers 404 and the model layer\'s "No model '
    + 'available" card is shown as before — one card listing "tbk/fake-chat-404 — model not found on the server", '
    + 'no v0 error card', pane.unavailable.length === 1 && card.text.startsWith('No model available')
    && same(card.candidates.map((c) => [c.ref, c.reason]), [['tbk/fake-chat-404', 'not_found']])
    && card.candidates[0].text.includes('model not found on the server') && pane.errors.length === 0,
  brief({ unavailable: pane.unavailable, errors: pane.errors }));
}

/** @brief 临时提问候选耗尽：发送方的工具结果报错，列出原因。 */
async function askNoModel(ctx) {
  const who = await begin(ctx, ctx.p.chat404, 'Ask the oracle tb-scenario:tb-models-ask', { team: false,
    pick: 'g-ask' });
  await settle(ctx, who, 60000);
  const results = toolResults(userEntries(who), 'agent_message');
  const oracle = lines(ctx, 'tb-models-ask', { agent: 'oracle', kind: 'ask' });
  const want = 'No model in your range fits oracle: tbo4/fake-ask-404 — model not found on the server';
  record('TB-40 ask with no model left: the off-mode question to oracle (its only model is in the dialog range and '
    + 'answers 404) fails and the sender\'s agent_message result is the error "No model in your range fits oracle: '
    + 'tbo4/fake-ask-404 — model not found on the server"', results.length === 1 && results[0].isError === true
    && textOf(results[0]) === want && oracle.length >= 1 && oracle.every((line) => line.status === 404),
  brief({ results: results.map((m) => [m.isError, textOf(m)]), oracle: oracle.map((line) => line.status) }));
}

// ---------- TB-47：继续会话时首选被排除（tb-models-cont） ----------

/** @brief 一个请求里没有工具调用与工具结果。 */
const toolFree = (request) => request !== undefined && !request.messages.some((m) => m.role === 'tool'
  || (m.tool_calls?.length ?? 0) > 0);
/** @brief 一个请求里有 pi 的压缩摘要。 */
const hasSummary = (request) => request?.messages.some((m) => m.role === 'user'
  && contentText(m.content).includes('compacted')) ?? false;

/** @brief executor 交回、closer 再次被唤醒时 fake-k1 已 not_found：段开始在 fake-k2 上，按 §6.2、§6.3 重建。 */
async function cont(ctx) {
  const who = await begin(ctx, ctx.p.cont, 'Read twice tb-scenario:tb-models-cont');
  await settle(ctx, who, 120000);
  const reviewer404 = lines(ctx, 'tb-models-cont', { agent: 'reviewer' }).find((line) => line.status === 404);
  for (const [agent, kind, label] of [['executor', 'task', 'the task session handed back to the same role'],
    ['closer', 'close', 'the close session woken again']]) {
    const requests = scenarioRequests(ctx.ep, 'tb-models-cont', { agent, kind });
    const firstRun = requests.filter((item) => item.info.k === 1).map((item) => item.body.model);
    const again = requests.filter((item) => item.info.k === 2);
    const file = instanceOf(ctx, who, kind, kind === 'task' ? { task: 'T1', role: 'executor' } : {});
    const rebuilds = customOf(file?.entries ?? [], 'mori.rebuild');
    record(`TB-47 ${label} continues with its first choice excluded: ${agent} ran on fake-k1 first; after fake-k1 `
      + 'is not found (reviewer\'s 404) the next segment starts on fake-k2 (profile needs reasoning replay), is '
      + 'rebuilt at segment start (mori.rebuild for tbk2/fake-k2) and fake-k2\'s context has none of fake-k1\'s tool '
      + 'calls or tool results (or carries the compaction summary)', firstRun.length >= 1
      && firstRun.every((model) => model === 'fake-k1') && again.length >= 1
      && again.every((item) => item.body.model === 'fake-k2') && reviewer404 !== undefined
      && reviewer404.t < again[0].t && rebuilds.length >= 1 && rebuilds[0].model === 'tbk2/fake-k2'
      && (toolFree(again[0]) || hasSummary(again[0])),
    brief({ firstRun, again: again.map((item) => item.body.model), rebuilds, toolFree: toolFree(again[0]),
      summary: hasSummary(again[0]), roles: again[0]?.messages.map((m) => m.role) }));
  }
  const board = readBoard(ctx, who.sessionId);
  if (board?.requests[0]?.status !== 'done') record('tb-models-cont: request 1 was closed', false, brief(board));
}

// ---------- 整个套件的检查 ----------

/** @brief 端点没有收到脚本没写到的请求。 */
function finalChecks(ctx) {
  const missing = missingSteps(ctx.ep);
  record('models: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
}

// ---------- 主流程 ----------

const steps = { longBatch, sel, fam, gone, sw, note, cdead, cwake, closer, chat404, askNoModel, cont };

const ctx = { userData: tempUserData('mori-tb-models-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-models] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: flow`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  finalChecks(ctx);
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
  if (ctx.slow) await stopEndpoint(ctx.slow);
}
console.log(`[tb-app-models] data in ${ctx.userData}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
