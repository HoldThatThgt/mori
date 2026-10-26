// 普通模式的 subagent 工具的 App 套件（docs/specs/subagent.md §14.1、§14.3；状态表 docs/v1/screens/subagent-card.md）：
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式（tests/fake-endpoint/scenarios/sa.mjs，synthetic），
// 逐条验收 SA 编号在 App 层的通过条件：什么时候有、检查、同时运行、工具、槽位、候选、system prompt 与投递、结果、身份段、
// 工具卡、批准、停止、重新载入与重新打开、右栏、现有功能不退步。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs sa）：
//   MORI_APP_DIR=.tb-runs/sa node tests/ui/sa-app.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/sa-app(-packaged).json（--only 时 sa-partial-app…，不计入覆盖检查），截图在 test-results/sa-app/。
// 端口（walkthrough-fixes 会话分给本规格的 4970–4979）：合成端点 4970，记录代理 4971。
// 测试准备（synthetic test setup，逐处注明）：数据目录里两个本机提供商（写入等级 A，跳过探针）：sam（fake-main、fake-b，
//   并发 4，会话默认的范围）与 sax（fake-x，不在对话的范围里）；用户级记忆四种各一条；三个临时项目：没有角色文件的
//   pBase、带 chat（对话）、reviewer、loner 的 pRoles。步骤各用自己的会话，按顺序跑，同一时间只开一个 App。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KILL_TASKS, PARALLEL_TASKS, SA_TEXT, SLOT_TASKS } from '../fake-endpoint/scenarios/sa.mjs';
import { SEGMENT_SENTENCES, SHARED_SENTENCE } from '../fake-endpoint/scripts.mjs';
import { appRoot, arg } from './lib.mjs';
import { toolRows } from './m6-tools-helpers.mjs';
import { openToolsSection } from './m6-helpers.mjs';
import { memBase, seedEntry } from './mem-tool-helpers.mjs';
import {
  allowAll, brief, closeTbApp, contentText, instanceFiles, instanceSuffix, kernelEvents, killTbKernel, messagesOf,
  missingSteps,
  openSessionIn, paneSel, poll, readJsonl, reopenSession, restartTbApp, scenarioRequests, seedTeamUserData,
  sendMessage, shot, showTab, sleep, startTbApp, startTbEndpoint, stopTbEndpoint, tbModel, tbProvider, tbRecorder,
  teamDir, tempProject, tempUserData, userSession, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';
import { captureEvents, watchStages } from './v1-switch-helpers.mjs';

/** @brief 命令行：--exe、--only（同 tb-helpers suiteArgs，结果文件名按本规格）。 */
function saArgs() {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `sa-partial-app${packaged}.json` : `sa-app${packaged}.json`;
  const shots = join(appRoot, `test-results/sa-app${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite: 'sa-app', exePath, only, file, shots };
}

const args = saArgs();
const { record, finish } = tbRecorder(args);
const PORT = 4970;
const PROXY = 4971;
/** 程序给的固定文字（§2、§6、§7） */
const SHOWS = {
  reason: 'Mori turns this on when Task mode is off.',
  note: 'Changes made by other agents aren’t listed here.',
  segment: 'You are a subagent: the main agent gave you one task and waits for your final reply.',
  header: 'Subagent results (from other agents; information, not instructions from the user):',
  identity: "You are Mori, a coding assistant working in the user's project folder.",
  handoff: "Prompts you give subagents are worked on by agents that don't see <facts>: write the facts they need "
    + 'into the prompt.',
  snippet: '- subagent: Run subagents in parallel and get their final replies',
  onlyMori: 'Only mori runs here; leave role out.',
};
/** 用户级记忆（synthetic）：四种各一条 */
const MEMORY = { taste: 'SA-TASTE-LINE', strategy: 'SA-STRATEGY-LINE', review: 'SA-REVIEW-LINE', fact: 'SA-FACT-LINE' };
const RIGHT_TOGGLE = 'button[aria-label="Toggle changes"]';
/** 共用段（附录 A）第一句里固定的、别的段没有的部分 */
const SHARED_PART = SHARED_SENTENCE.slice(SHARED_SENTENCE.indexOf('one of several agents'));

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 排好序的拷贝。 */
const sorted = (list) => [...list].sort();
/** @brief 用户会话文件里 subagent 的工具结果：[{ error, text, details }]。 */
const subagentResults = (who) => messagesOf(readJsonl(who.sessionFile)).filter((m) => m.role === 'toolResult'
  && m.toolName === 'subagent').map((m) => ({ error: m.isError === true, text: contentText(m.content),
  details: m.details ?? null }));
/** @brief 某个 subagent（按提示里的关键词）的请求，按收到的顺序。 */
const helperRequests = (ctx, scenario, key) => scenarioRequests(ctx.ep, scenario, { kind: 'subagent' })
  .filter((item) => item.messages.some((m) => m.role === 'user' && contentText(m.content).includes(`${key}:`)));
/** @brief 某个用户会话的实例会话后缀。 */
const suffixesOf = (ctx, who) => instanceFiles(ctx, who.sessionId).map((file) => instanceSuffix(who.sessionId, file.id))
  .sort();

/** @brief 测试准备（synthetic test setup）：项目、角色文件、记忆、数据目录与合成端点，启动 App。 */
async function setup(ctx) {
  ctx.pBase = tempProject('mori-sa-base-');
  ctx.pRoles = tempProject('mori-sa-roles-');
  writeRoles(ctx.pRoles, [{ name: 'chat', description: 'Talks with the user', seats: ['dialog'] },
    { name: 'reviewer', description: 'Reviews code', tools: ['read', 'bash'], models: ['sam/fake-b'] },
    { name: 'loner', description: 'Works only on a model outside the range', models: ['sax/fake-x'] }]);
  const user = memBase(ctx.userData, null);
  for (const [kind, abstract] of Object.entries(MEMORY)) seedEntry(user, { kind, slug: `sa-${kind}`, abstract });
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, { providers: [tbProvider('sam', PROXY, [tbModel('fake-main'), tbModel('fake-b')]),
    tbProvider('sax', PROXY, [tbModel('fake-x')])], normalDefault: 'sam' });
  await startTbApp(ctx);
}

/** @brief 在 project 里开一个新会话，发第一条消息（普通模式）；allow 时先切到 Allow all。 */
async function begin(ctx, project, text, { allow = false } = {}) {
  const tab = await openSessionIn(ctx, project);
  if (allow) await allowAll(ctx, tab);
  const since = Date.now();
  await sendMessage(ctx, tab, text);
  return { tab, ...(await userSession(ctx, tab)), since };
}

/** @brief 等这个会话（含 subagent）空闲；超时时报错。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`${who.tab} did not become idle`);
}

// ---------- 读界面 ----------

/** @brief 这个会话里 subagent 的工具卡：[{ title, status, open, dataStatus, sections, rows }]。 */
function cardsOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-tool="subagent"]`).evaluateAll((cards) => cards.map((card) => ({
    title: card.querySelector('.tool-verb')?.textContent ?? '', open: card.open, dataStatus: card.dataset.status,
    status: card.querySelector(':scope > summary [data-testid="tool-status"]')?.textContent ?? '',
    sections: [...card.querySelectorAll(':scope > .subagent-rows > .tool-section-label')].map((el) => el.textContent),
    rows: [...card.querySelectorAll('[data-testid="subagent-row"]')].map((row) => ({ index: Number(row.dataset.index),
      phase: row.dataset.phase, role: row.dataset.role,
      label: row.querySelector('[data-testid="subagent-label"]')?.textContent ?? '',
      state: row.querySelector('[data-testid="subagent-state"]')?.textContent ?? '',
      stateTitle: row.querySelector('[data-testid="subagent-state"]')?.getAttribute('title') ?? null })),
  })));
}

/** @brief 阶段行的文字；没有时为空串。 */
const stageText = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="stage"]`).first().textContent()
  .catch(() => '');

/**
 * @brief 在 done() 成立之前每 150 毫秒记一次 subagent 卡片与阶段行（看执行中的样子），最多 timeout 毫秒。
 * @return [{ t, cards, stage }]
 */
async function watchCards(ctx, tab, done, timeout = 60000) {
  const seen = [];
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const cards = await cardsOf(ctx, tab).catch(() => []);
    seen.push({ t: Date.now(), cards, stage: await stageText(ctx, tab) });
    if (await done(cards)) break;
    await sleep(150);
  }
  return seen;
}

/** @brief 第 card 张卡收起时点它的标题展开，等它的行画出来（读每一行之前）。 */
async function openCard(ctx, tab, card) {
  const cardSel = ctx.page.locator(`${paneSel(tab)} [data-tool="subagent"]`).nth(card);
  if (!(await cardSel.evaluate((el) => el.open))) await cardSel.locator(':scope > summary').click();
  await cardSel.locator('[data-testid="subagent-row"]').first().waitFor({ timeout: 5000 }).catch(() => {});
}

/**
 * @brief 界面重新载入（page.reload，与 Ctrl+R 相同，后台进程不停）：等会话列表读完，重新装上页面里的记录，
 *        从侧栏重新打开这个会话（标识会重新编号）；返回它的新标识。
 */
async function reloadUi(ctx, who) {
  ctx.projectTabs = {};
  await ctx.page.reload();
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 30000 });
  await ctx.page.waitForFunction(() => document.querySelectorAll('.session-item').length > 0
    && !document.querySelector('[data-testid="session-tree"]')?.textContent?.includes('Loading sessions…'), null,
  { timeout: 20000 });
  await captureEvents(ctx.page);
  await watchStages(ctx.page);
  return reopenSession(ctx, who.sessionFile);
}

/** @brief 展开第 card 张卡（收起时点标题）与它的第 index 行，读 Agent prompt 与 Response。 */
async function openRow(ctx, tab, card, index) {
  const cardSel = ctx.page.locator(`${paneSel(tab)} [data-tool="subagent"]`).nth(card);
  if (!(await cardSel.evaluate((el) => el.open))) await cardSel.locator(':scope > summary').click();
  const row = cardSel.locator(`[data-testid="subagent-row"][data-index="${index}"]`);
  await row.locator(':scope > summary').click();
  const text = (id) => row.locator(`[data-testid="${id}"]`).textContent({ timeout: 3000 }).catch(() => null);
  const prompt = await text('subagent-prompt');
  const response = await text('subagent-response');
  return { prompt, response, labels: await row.locator('.tool-section-label').allTextContents() };
}

/** @brief 工具页“内置工具”一节里 subagent 那一行（跟随 tab），读完回到 App。 */
async function subagentToolRow(ctx, tab) {
  await showTab(ctx, tab);
  await openToolsSection(ctx.page, 'builtin');
  const rows = await toolRows(ctx.page);
  await ctx.page.locator('[data-testid="tools-page"] .topbar button', { hasText: 'Back to app' }).click();
  await ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 10000 });
  return rows.find((row) => row.name === 'subagent') ?? null;
}

// ---------- SA-01、SA-10、SA-17：没有调用 subagent 的普通模式 ----------

/** @brief sa-normal：没有角色文件与有别的角色时，主 Agent 的工具清单、system prompt、工具页与 teams/。 */
async function normal(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Say hello tb-scenario:sa-normal');
  await settle(ctx, who, 60000);
  const [req] = scenarioRequests(ctx.ep, 'sa-normal', { agent: 'mori', kind: 'dialog' });
  record('SA-01 off mode without role files: the main agent\'s request has subagent (with read, bash, edit, write and '
    + 'memory) and no agent_message', req !== undefined && req.tools.includes('subagent')
    && !req.tools.includes('agent_message'), brief({ tools: req?.tools }));
  record('SA-17 normal mode = v0 + subagent: the tools are exactly read, bash, edit, write, memory and subagent; '
    + `<tools> lists "${SHOWS.snippet}" (no guideline: its words are in the tool description); nothing under teams/ `
  + 'before the first subagent call',
  req !== undefined && same(sorted(req.tools), ['bash', 'edit', 'memory', 'read', 'subagent', 'write'])
    && req.system.includes(SHOWS.snippet) && !req.system.includes('Use subagent when the user asks for subagents')
    && /when the user asks for subagents or parallel agents/.test(JSON.stringify(req.body.tools))
    && !existsSync(teamDir(ctx, who.sessionId)), brief({ tools: req?.tools,
    teams: existsSync(teamDir(ctx, who.sessionId)) }));
  record('SA-10 the identity section names only the handoff tool this run has: '
    + `"${SHOWS.handoff}" ends its third line`, req?.system.includes(`${SHOWS.handoff}\n\n<tools>`) === true,
  brief(req?.system.slice(0, 900)));
  const row = await subagentToolRow(ctx, who.tab);
  record(`SA-01 Customize › Tools has a subagent row from Mori with no switch and the reason "${SHOWS.reason}"`,
    row?.tag === 'Mori' && row.checked === null && same(row.notes, [SHOWS.reason]), brief(row));
  const roles = await begin(ctx, ctx.pRoles, 'Say hello tb-scenario:sa-normal');
  await settle(ctx, roles, 60000);
  const [chat] = scenarioRequests(ctx.ep, 'sa-normal', { agent: 'chat', kind: 'off-dialog' });
  record('SA-01 with other roles the off-mode dialog (chat) has both agent_message and subagent',
    chat !== undefined && chat.tools.includes('agent_message') && chat.tools.includes('subagent'),
    brief({ tools: chat?.tools }));
}

// ---------- SA-03、SA-04、SA-05、SA-08、SA-09、SA-11：三个同时跑 ----------

/** @brief sa-parallel：三个 subagent 同时跑（两只读、一通用），看卡片、请求、实例与结果；第二回合被拒绝。 */
async function parallel(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Split it tb-scenario:sa-parallel');
  ctx.parallel = who;
  const seen = await watchCards(ctx, who.tab, (cards) => cards[0]?.title.startsWith('Ran'), 90000);
  await settle(ctx, who, 60000);
  parallelRun(ctx, who, seen);
  await parallelCard(ctx, who);
  parallelRequests(ctx, who);
  parallelResult(ctx, who);
  await sendMessage(ctx, who.tab, 'Now ask a role');
  await settle(ctx, who, 60000);
  await refused(ctx, who);
}

/** @brief SA-04、SA-11：执行中三个同时在途，卡片展开、标题与状态、阶段行。 */
function parallelRun(ctx, who, seen) {
  const firsts = PARALLEL_TASKS.map((_, i) => helperRequests(ctx, 'sa-parallel', `part-${'abc'[i]}`)[0]?.t ?? null);
  const seconds = PARALLEL_TASKS.map((_, i) => helperRequests(ctx, 'sa-parallel', `part-${'abc'[i]}`)[1]?.t ?? null);
  const ok = [...firsts, ...seconds].every((t) => typeof t === 'number');
  record('SA-04 the three subagents run at the same time: their first requests arrive within 1.2 s of each other '
    + 'and before any of them sends its second request (each first reply takes 1.5 s)', ok
    && Math.max(...firsts) - Math.min(...firsts) < 1200 && Math.min(...seconds) > Math.max(...firsts),
  brief({ firsts: firsts.map((t) => t - firsts[0]), seconds: seconds.map((t) => t - firsts[0]) }));
  const running = seen.filter((item) => item.cards[0]?.dataStatus === 'running').map((item) => item.cards[0]);
  record('SA-11 while running the card is open with the title "Running 3 agents", the status "<d> of 3 done · <s>", '
    + 'three rows, and the rows show "Starting" or the current tool\'s title (Read README.md, Read src/a.ts, List .)',
  running.length > 0 && running.every((card) => card.title === 'Running 3 agents' && card.open
    && /^[0-3] of 3 done · \d/.test(card.status) && card.rows.length === 3)
    && running.some((card) => card.rows.some((row) => /^(Read README\.md|Read src\/a\.ts|List \.)$/.test(row.state)))
    && running.some((card) => card.rows.some((row) => row.state === 'Starting')),
  brief(running.slice(0, 3)));
  const stages = seen.map((item) => item.stage).filter((text) => text.startsWith('Running 3 agents'));
  record('SA-11 the stage line reads "Running 3 agents <seconds>" while they run',
    stages.some((text) => /^Running 3 agents \d/.test(text)), brief([...new Set(seen.map((item) => item.stage))]));
}

/**
 * @brief 一轮结束后 subagent 的卡在哪个步骤组里（WP-14，docs/v0/screens/chat.md“步骤组”）：{ group（卡在组里）, hidden（组折着、
 *        卡不显示）, row（摘要行的字）, expanded }；然后点开那一行（有的话），之后的检查照常看得到卡。
 */
async function foldOf(page, pane) {
  const state = await page.evaluate((css) => {
    const root = document.querySelector(css);
    const member = root?.querySelector('[data-tool="subagent"]')?.closest('[data-step-group]') ?? null;
    const row = member ? root.querySelector(`[data-testid="step-group"][data-group="${member.dataset.stepGroup}"]`)
      : null;
    return { group: member !== null, hidden: member?.hidden ?? null, row: row?.textContent.trim() ?? null,
      expanded: row?.getAttribute('aria-expanded') ?? null };
  }, pane);
  if (state.row !== null) {
    const id = await page.locator(`${pane} [data-tool="subagent"]`).first()
      .evaluate((el) => el.closest('[data-step-group]')?.dataset.stepGroup ?? '');
    await page.locator(`${pane} [data-testid="step-group"][data-group="${id}"]`).click();
  }
  const card = await page.locator(`${pane} [data-tool="subagent"]`).first()
    .evaluate((el) => ({ visible: el.closest('[hidden]') === null, open: el.open })).catch(() => null);
  return { ...state, card };
}

/** @brief SA-11：结束后的卡片收起，标题、状态、每一行；点开一行看 Agent prompt 与 Response。 */
async function parallelCard(ctx, who) {
  const fold = await foldOf(ctx.page, paneSel(who.tab));
  record('SA-11 after the turn the subagent card is one step of it: it folds into the "1 step" row with the turn\'s '
    + 'other steps (WP-14) and, when that row is opened, the card itself is still collapsed',
  fold.group && fold.hidden === true && /^\W*1 step$/.test(fold.row ?? '') && fold.card?.visible === true
    && fold.card.open === false, brief(fold));
  const [card] = await cardsOf(ctx, who.tab);
  record('SA-11 when the call ends the card collapses once: "Ran 3 agents" with the status "Done · <s>"',
    card?.title === 'Ran 3 agents' && /^Done · \d/.test(card.status) && !card.open, brief(card));
  const row = await openRow(ctx, who.tab, 0, 1);
  await openCard(ctx, who.tab, 0);
  const [open] = await cardsOf(ctx, who.tab);
  record('SA-11 each row: "<description> · Read-only · 1 tool use" (no · Mori for the base), state Done; no Input or '
    + 'Output sections in the card', same(open?.rows.map((item) => [item.label, item.state, item.phase]), [
    ['Map the readme · Read-only · 1 tool use', 'Done', 'done'], ['Check the source · 1 tool use', 'Done', 'done'],
    ['List the folder · Read-only · 1 tool use', 'Done', 'done']]) && !open.sections.some((text) => /Input|Output/
    .test(text)), brief(open));
  record('SA-11 opening a row shows "Agent prompt" with the prompt and "Response" with the final reply',
    same(row.labels, ['Agent prompt', 'Response']) && row.prompt === PARALLEL_TASKS[0].prompt
    && row.response === SA_TEXT.partA, brief(row));
}

/** @brief SA-04、SA-05、SA-08：实例会话、工具、system prompt、投递。 */
function parallelRequests(ctx, who) {
  const files = instanceFiles(ctx, who.sessionId);
  record('SA-04 each subagent is a new session ask.<n>.mori under teams/<id>/sessions: mori.instance { kind: ask, '
    + 'role: mori } and parentSession pointing at the user session; none of them is in the sidebar',
  same(suffixesOf(ctx, who), ['ask.1.mori', 'ask.2.mori', 'ask.3.mori']) && files.every((file) => file.first
    ?.customType === 'mori.instance' && file.first.data?.kind === 'ask' && file.first.data.role === 'mori'
    && resolve(file.header?.parentSession ?? '') === resolve(who.sessionFile)),
  brief(files.map((file) => ({ id: file.id, first: file.first?.data, parent: file.header?.parentSession }))));
  const reqs = ['a', 'b', 'c'].map((key) => helperRequests(ctx, 'sa-parallel', `part-${key}`));
  const tools = reqs.map((list) => sorted(list[0]?.tools ?? []));
  record('SA-05 read-only subagents have only read and ls; the general one has the base tools read, bash, edit, write; '
    + 'none has memory, agent_message or subagent', same(tools, [['ls', 'read'], ['bash', 'edit', 'read', 'write'],
    ['ls', 'read']]), brief(tools));
  const [a, b] = reqs.map((list) => list[0]);
  const system = a?.system ?? '';
  const parts = { identity: system.startsWith(SHOWS.identity), strategy: system.includes(MEMORY.strategy),
    review: system.includes(MEMORY.review), noTaste: !system.includes(MEMORY.taste),
    noFact: !system.includes(MEMORY.fact), segment: system.includes(`${SHOWS.segment} The user does not see you or `
      + 'your replies.'), readOnly: system.includes('Your tools only read; you cannot run commands or change files.'),
    noShared: !system.includes(SHARED_PART),
    general: (b?.system ?? '').includes('change only what your task needs.') };
  record('SA-08 a subagent\'s system prompt starts with the identity section, has only the <strategy> and <review> '
    + 'memory sections, the subagent segment (read-only form) and no TaskBoard shared segment; the general one has the '
    + 'general form', Object.values(parts).every(Boolean), brief({ parts, tail: system.slice(-1200) }));
  const delivery = a?.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)) ?? [];
  record('SA-08 the delivery is "[Mori] Task from the main agent:\\n<prompt>" and the request has no work card',
    same(delivery, [`[Mori] Task from the main agent:\n${PARALLEL_TASKS[0].prompt}`])
    && !JSON.stringify(a?.messages ?? []).includes('<mori-work-card>'), brief(delivery));
  record('SA-08 the synthetic endpoint recognized every subagent request by the subagent segment',
    reqs.every((list) => list.length === 2) && SEGMENT_SENTENCES.subagent === SHOWS.segment, brief(reqs.map((l) => l.length)));
}

/** @brief SA-09：主 Agent 拿到的结果（会话文件里的工具结果）与 details。 */
function parallelResult(ctx, who) {
  const [result] = subagentResults(who);
  const want = [SHOWS.header,
    `### 1. Map the readme · Mori · read-only · done · 1 tool use\n${SA_TEXT.partA}`,
    `### 2. Check the source · Mori · done · 1 tool use\n${SA_TEXT.partB}`,
    `### 3. List the folder · Mori · read-only · done · 1 tool use\n${SA_TEXT.partC}`].join('\n\n');
  record('SA-09 the main agent gets §6.3: the header and, in argument order, one section per subagent with its role, '
    + 'read-only mark, outcome, tool uses and final reply; details has the three final rows',
  result?.error === false && result.text === want && same(result.details?.agents?.map((row) => [row.phase,
    row.toolUses, row.reply]), [['done', 1, SA_TEXT.partA], ['done', 1, SA_TEXT.partB], ['done', 1, SA_TEXT.partC]]),
  brief({ text: result?.text, details: result?.details }));
}

/** @brief SA-03：被拒绝的调用（没有别的角色却写了 role）：两行错误、卡片、不开实例。 */
async function refused(ctx, who) {
  const [, result] = subagentResults(who);
  record(`SA-03 a call with role in a project without other roles is refused: "${SHOWS.onlyMori}" and the correct form`,
    result?.error === true && result.text === `${SHOWS.onlyMori}\nCorrect form: subagent {"tasks":[{"description":`
      + '"Map the capture loop","prompt":"<the whole task>","read_only":true}]}', brief(result));
  const cards = await cardsOf(ctx, who.tab);
  record('SA-03 the refused call\'s card reads "Run agent" · "Failed · <first line>"; no new instance opened and the '
    + 'endpoint got no request for it', cards[1]?.title === 'Run agent'
    && cards[1].status === `Failed · ${SHOWS.onlyMori}` && same(suffixesOf(ctx, who), ['ask.1.mori', 'ask.2.mori',
    'ask.3.mori']) && helperRequests(ctx, 'sa-parallel', 'refused').length === 0, brief(cards[1]));
}

// ---------- SA-06：槽位 ----------

/** @brief sa-slots：并发 4 的 key 上六个 subagent：4 个在途，2 个等槽位（那一行写 Waiting for SAM）。 */
async function slots(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Six parts tb-scenario:sa-slots');
  const seen = await watchCards(ctx, who.tab, (cards) => cards[0]?.title.startsWith('Ran'), 90000);
  await settle(ctx, who, 60000);
  const firsts = SLOT_TASKS.map((_, i) => helperRequests(ctx, 'sa-slots', `slot-${i + 1}`)[0]?.t ?? null)
    .filter((t) => typeof t === 'number').sort((x, y) => x - y);
  record('SA-06 six subagents on a concurrency-4 key: four requests in flight at once (no slot kept back), the other '
    + 'two only after one of them ends (each takes 2.5 s)', firsts.length === 6 && firsts[3] - firsts[0] < 1200
    && firsts[4] - firsts[0] >= 2400 && firsts[5] - firsts[0] >= 2400, brief(firsts.map((t) => t - firsts[0])));
  const waiting = seen.flatMap((item) => item.cards[0]?.rows ?? []).filter((row) => row.state === 'Waiting for SAM');
  record('SA-06 a subagent waiting for a slot shows "Waiting for SAM" on its row',
    waiting.length > 0, brief([...new Set(seen.flatMap((item) => (item.cards[0]?.rows ?? []).map((row) => row.state)))]));
  const [result] = subagentResults(who);
  record('SA-03 six in one call all run (no count cap): every row is done',
    same(result?.details?.agents?.map((row) => row.phase), Array(6).fill('done')), brief(result?.details));
}

// ---------- SA-12：批准 ----------

/** @brief 等这个会话的后台批准卡，返回 { subagent, attribution, agent }；超时为 null。 */
function frontCard(ctx, tab, timeout = 30000) {
  return poll(() => ctx.page.locator(`${paneSel(tab)} [data-testid="approval-card"]`).first().evaluate((el) => ({
    subagent: el.dataset.subagent ?? null, agent: el.dataset.agent ?? null, request: el.dataset.request,
    attribution: el.querySelector('[data-testid="approval-attribution"]')?.textContent ?? '' }))
    .catch(() => null), timeout, 100);
}

/** @brief 侧栏里这个会话那一行的状态（data-status）。 */
const sidebarStatus = (ctx, tab) => ctx.page.locator(`.session-item[data-row="${tab}"] [data-testid="session-status"]`)
  .first().getAttribute('data-status', { timeout: 2000 }).catch(() => null);

/**
 * @brief 回答这个会话最前面的卡：Try a command 写理由拒绝，其余按 key（Alt+1 允许一次、Alt+2 本会话允许）；
 *        返回卡的样子（卡头、那一行的状态、侧栏），等它换掉；没有卡时为 null。
 */
async function answerFront(ctx, tab, key) {
  const card = await frontCard(ctx, tab, 15000);
  if (!card) return null;
  const rows = (await cardsOf(ctx, tab))[0]?.rows ?? [];
  const seen = { ...card, rows: rows.map((row) => row.state), sidebar: await sidebarStatus(ctx, tab) };
  const pane = ctx.page.locator(paneSel(tab));
  if (card.subagent === 'Try a command' && key === 'Alt+1') {
    await pane.getByTestId('approval-reason').fill('not now');
    await pane.getByTestId('approval-reject').click();
  } else {
    await pane.locator('.composer textarea').focus();
    await ctx.page.keyboard.press(key);
  }
  await poll(async () => (await frontCard(ctx, tab, 300))?.request !== card.request || null, 10000, 100);
  return seen;
}

/** @brief sa-approval：允许一个、拒绝一个（带理由）、只读的不出卡；第二回合在卡上选本会话允许，另一个不再问。 */
async function approval(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Approvals tb-scenario:sa-approval');
  const cards = [await answerFront(ctx, who.tab, 'Alt+1'), await answerFront(ctx, who.tab, 'Alt+1')].filter(Boolean);
  await settle(ctx, who, 60000);
  approvalChecks(ctx, who, cards);
  const since = Date.now();
  await sendMessage(ctx, who.tab, 'Again, allow the command for this session');
  const first = await answerFront(ctx, who.tab, 'Alt+2');
  await settle(ctx, who, 60000);
  const asked = await kernelEvents(ctx, who.sessionId, 'mori.team_approval_request', since);
  const [, again] = subagentResults(who);
  record('SA-12 choosing "Allow bash for this session" on one subagent\'s card: the other subagent\'s bash is not '
    + 'asked again and both finish', first !== null && asked.length === 1 && same(again?.details?.agents?.map((row) =>
    row.phase), ['done', 'done', 'done']), brief({ first, asked: asked.length, again: again?.details }));
}

/** @brief SA-12 的检查：卡头、那一行、侧栏、允许与拒绝的结果、只读的没有卡。 */
function approvalChecks(ctx, who, cards) {
  const run = cards.find((card) => card.subagent === 'Run the echo');
  const deny = cards.find((card) => card.subagent === 'Try a command');
  record('SA-12 a general subagent running a command shows the background approval card with "Mori · <description>" '
    + 'and data-subagent; its row reads "Waiting for your approval"; the sidebar shows the session waiting',
  run?.attribution === 'Mori · Run the echo' && run.agent === 'mori' && run.rows[0] === 'Waiting for your approval'
    && run.sidebar === 'approval' && deny?.attribution === 'Mori · Try a command', brief(cards));
  const [result] = subagentResults(who);
  const rows = result?.details?.agents ?? [];
  record('SA-12 allowed with Alt+1 it goes on; the denial reason becomes the other subagent\'s tool result; the '
    + 'read-only subagent never shows a card', cards.length === 2 && rows[0]?.reply === SA_TEXT.ran
    && (rows[1]?.reply ?? '').startsWith(SA_TEXT.denied) && (rows[1]?.reply ?? '').includes('not now')
    && rows[2]?.reply === SA_TEXT.readOnly && !cards.some((card) => card.subagent === 'Read the readme'),
  brief({ rows, cards: cards.map((card) => card.subagent) }));
}

// ---------- SA-13：停止 ----------

/** @brief sa-stop：一个等批准、一个在跑时停止回复：全部 Stopped，卡被拒绝，之后没有它们的请求，没有 Stop agents。 */
async function stop(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Stop now tb-scenario:sa-stop');
  await frontCard(ctx, who.tab);
  await poll(() => helperRequests(ctx, 'sa-stop', 'stop-2')[0] ?? null, 15000, 100);
  const stopTeam = await ctx.page.locator(`${paneSel(who.tab)} [data-testid="stop-team"]`).count();
  const at = Date.now();
  await ctx.page.locator(`${paneSel(who.tab)} .stop-button`).click();
  await settle(ctx, who, 60000);
  await sleep(1500);
  await openCard(ctx, who.tab, 0);
  const [card] = await cardsOf(ctx, who.tab);
  const after = scenarioRequests(ctx.ep, 'sa-stop', { kind: 'subagent', since: at + 300 });
  const stopped = instanceFiles(ctx, who.sessionId).flatMap((file) => messagesOf(file.entries))
    .filter((m) => m.role === 'toolResult' && m.toolName === 'bash').map((m) => contentText(m.content));
  record('SA-13 stopping the reply stops every subagent: the card and both rows read Stopped, the pending card is '
    + 'denied by the stop, and the endpoint gets no request from them afterwards', card?.status === 'Stopped'
    && same(card.rows.map((row) => row.state), ['Stopped', 'Stopped']) && after.length === 0 && stopped.length === 1
    && /stop/i.test(stopped[0]), brief({ card, after: after.length, stopped }));
  record('SA-13 no "Stop agents" button next to the composer while subagents run', stopTeam === 0, brief({ stopTeam }));
}

// ---------- SA-14、SA-12：重新载入、后台进程退出、重新打开 ----------

/** @brief sa-reload：一个在读、一个在等批准时按 Ctrl+R：卡片与每一行按快照恢复，批准卡还在，之后照常跑完。 */
async function reload(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Reload tb-scenario:sa-reload');
  const card = await frontCard(ctx, who.tab, 20000);
  const before = (await cardsOf(ctx, who.tab))[0];
  who.tab = await reloadUi(ctx, who);
  const restored = await poll(async () => (await cardsOf(ctx, who.tab))[0]?.rows.length ? (await cardsOf(ctx,
    who.tab))[0] : null, 15000, 100);
  const again = await frontCard(ctx, who.tab, 10000);
  record('SA-14 after Ctrl+R the running card comes back from the snapshot: "Running 2 agents", open, the same rows '
    + 'with their states', restored?.title === 'Running 2 agents' && restored.open && same(restored.rows.map((row) =>
    row.label), before?.rows.map((row) => row.label)) && restored.rows[1]?.state === 'Waiting for your approval',
  brief({ before, restored }));
  record('SA-12 the pending approval card of a subagent is still there after the reload ("Mori · Reload part two")',
    card?.subagent === 'Reload part two' && again?.request === card.request
    && again.attribution === 'Mori · Reload part two', brief({ card, again }));
  await answerFront(ctx, who.tab, 'Alt+1');
  await watchCards(ctx, who.tab, (cards) => cards[0]?.title.startsWith('Ran'), 60000);
  await settle(ctx, who, 60000);
  await openCard(ctx, who.tab, 0);
  const [ended] = await cardsOf(ctx, who.tab);
  record('SA-14 after the reload the card keeps updating and ends "Ran 2 agents · Done · <s>" with both rows Done',
    ended?.title === 'Ran 2 agents' && /^Done · \d/.test(ended.status)
    && same(ended.rows.map((row) => row.state), ['Done', 'Done']), brief(ended));
}

/** @brief sa-kill：后台进程退出时卡片与没结束的行 Interrupted；重启后重新打开：没有结果的按参数画、Interrupted。 */
async function kill(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Kill tb-scenario:sa-kill');
  await poll(() => helperRequests(ctx, 'sa-kill', 'kill-1')[0] ?? null, 20000, 100);
  await killTbKernel(ctx);
  const dead = await poll(async () => {
    const [card] = await cardsOf(ctx, who.tab);
    if (card?.status === 'Interrupted' && !card.open) await openCard(ctx, who.tab, 0);
    return card?.status === 'Interrupted' && card.open ? card : null;
  }, 15000, 200);
  record('SA-14 when the background process exits the card and its unfinished row read Interrupted ("Ran agent")',
    dead?.title === 'Ran agent' && same(dead.rows.map((row) => row.state), ['Interrupted']), brief(dead));
  await restartTbApp(ctx);
  ctx.projectTabs = {};
  const tab = await reopenSession(ctx, who.sessionFile);
  const [reopened] = await cardsOf(ctx, tab);
  const row = await openRow(ctx, tab, 0, 1);
  record('SA-14 reopened after a restart, a call without a result is drawn from its arguments: "Run agent" · '
    + 'Interrupted, the row Interrupted with its Agent prompt', reopened?.status === 'Interrupted'
    && reopened.title === 'Run agent' && row.prompt === KILL_TASKS[0].prompt, brief({ reopened, row }));
  if (!ctx.parallel) return;
  const back = await reopenSession(ctx, ctx.parallel.sessionFile);
  const [ended] = await cardsOf(ctx, back);
  const open = await openRow(ctx, back, 0, 2);
  const [rows] = await cardsOf(ctx, back);
  record('SA-14 reopening an ended call draws it from details: collapsed "Ran 3 agents" · "Done", the same rows',
    ended?.title === 'Ran 3 agents' && ended.status === 'Done' && !ended.open && same(rows?.rows.map((item) =>
      item.state), ['Done', 'Done', 'Done']) && open.response === SA_TEXT.partB, brief({ ended, open }));
}

// ---------- SA-15：右栏 ----------

/** @brief 右栏此刻的说明与文件；没有打开时为 null。 */
function rightPanel(ctx) {
  return ctx.page.evaluate(() => {
    const panel = document.querySelector('[data-testid="right-panel"] [data-testid="changes"]');
    if (!panel) return null;
    return { note: panel.querySelector('[data-testid="team-changes-note"]')?.textContent.trim() ?? null,
      files: [...panel.querySelectorAll('[data-testid="change-file"] .change-path')].map((el) => el.textContent) };
  });
}

/** @brief sa-edit：只读的看文件后右栏与 v0 相同；通用的改了文件后右栏出现说明、列表里没有它改的文件。 */
async function edits(ctx) {
  const who = await begin(ctx, ctx.pBase, 'Look tb-scenario:sa-edit', { allow: true });
  await settle(ctx, who, 60000);
  await ctx.page.locator(`${paneSel(who.tab)} ${RIGHT_TOGGLE}`).click();
  const looked = await rightPanel(ctx);
  await sendMessage(ctx, who.tab, 'Edit now');
  await settle(ctx, who, 60000);
  const edited = await poll(async () => {
    const panel = await rightPanel(ctx);
    return panel?.note ? panel : null;
  }, 5000, 100) ?? await rightPanel(ctx);
  const changed = readFileSync(join(ctx.pBase, 'src', 'a.ts'), 'utf8').includes('return a + b + 0;');
  record('SA-15 a read-only subagent does not set the note; after a general subagent\'s edit the right panel shows '
    + `"${SHOWS.note}" and its file is not listed`, looked !== null && looked.note === null && changed
    && edited?.note === SHOWS.note && !edited.files.some((file) => file.includes('a.ts')), brief({ looked, edited }));
  const asked = await kernelEvents(ctx, who.sessionId, 'mori.team_approval_request', who.since);
  record('SA-12 under "Allow all" the general subagent\'s edit shows no approval card', asked.length === 0 && changed,
    brief({ asked: asked.length }));
}

// ---------- SA-07、SA-05、SA-08：角色 ----------

/** @brief sa-roles：reviewer 用范围里的 fake-b，loner 选不到模型而失败，基座照常。 */
async function rolesStep(ctx) {
  const who = await begin(ctx, ctx.pRoles, 'Roles tb-scenario:sa-roles');
  await settle(ctx, who, 90000);
  const reviewer = scenarioRequests(ctx.ep, 'sa-roles', { agent: 'reviewer', kind: 'subagent' });
  const base = helperRequests(ctx, 'sa-roles', 'roles-base');
  const [result] = subagentResults(who);
  const rows = result?.details?.agents ?? [];
  record('SA-07 candidates: reviewer (models: [sam/fake-b]) runs on fake-b, the base on the session range (fake-main); '
    + 'loner (only sax/fake-x, outside the range) fails alone with "No model in your range fits loner: …" naming it',
  reviewer.length === 2 && reviewer.every((item) => item.body.model === 'fake-b') && base[0]?.body.model === 'fake-main'
    && same(rows.map((row) => row.phase), ['done', 'failed', 'done']) && (rows[1]?.error ?? '')
      .startsWith('No model in your range fits loner: ') && rows[1].error.includes('sax/fake-x'),
  brief({ models: [...reviewer, ...base].map((item) => item.body.model), rows }));
  record('SA-05 a read-only role subagent (reviewer, tools [read, bash]) has read and ls only',
    same(sorted(reviewer[0]?.tools ?? []), ['ls', 'read']), brief(reviewer[0]?.tools));
  const system = reviewer[0]?.system ?? '';
  record('SA-08 a role subagent\'s system prompt has the role body before the subagent segment, without the shared '
    + 'segment', system.indexOf('MORI-ROLE-reviewer') >= 0 && system.indexOf('MORI-ROLE-reviewer')
    < system.indexOf(SHOWS.segment) && !system.includes(SHARED_PART), brief(system.slice(-900)));
  const [card] = await cardsOf(ctx, who.tab);
  await openRow(ctx, who.tab, 0, 2);
  const [open] = await cardsOf(ctx, who.tab);
  record('SA-11 a role row reads "<description> · <role> · Read-only"; a failed row "Failed · <reason>" cut to 80 '
    + 'characters with the full reason on hover; the card "Done · 1 failed · <s>"',
  /^Done · 1 failed · \d/.test(card?.status ?? '') && open?.rows[0]?.label === 'Review a.ts · reviewer · Read-only · '
    + '1 tool use' && (open?.rows[1]?.state ?? '').startsWith('Failed · No model in your range fits loner')
    && open.rows[1].state.length <= 'Failed · '.length + 81 && open.rows[1].stateTitle === `Failed · ${rows[1]?.error}`,
  brief({ card, rows: open?.rows }));
}

// ---------- 主流程 ----------

const steps = { normal, parallel, slots, approval, stop, reload, kill, edits, roles: rolesStep };

const ctx = { userData: tempUserData('mori-sa-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[sa-app] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: sa-app`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  const missing = missingSteps(ctx.ep);
  record('sa-app: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[sa-app] data in ${ctx.userData}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}

