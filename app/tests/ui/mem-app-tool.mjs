// 提示词分层与记忆的 App 套件：对话里的 memory 工具、依据回到原位置、记忆文件与编码冲突
// （docs/specs/memory.md §14.2；状态表 docs/v1/screens/memory-chat.md、memory-page.md）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic）：关键词模式的
// "call tool: memory {…}"（用户消息里写好参数，端点照着调用 memory），分开配置的协作模式用脚本 mem-tool-split、
// 生成中的跳转用脚本 mem-tool-live（scenarios/memtool.mjs）。逐条验收这些编号在 App 层的通过条件：
//   MEM-10 对话里记：工具卡标题（§7.5）、结果原文（§7.4）、不出批准卡（free）、存下的条目与修订、依据是说这句话的那条
//          你的消息（不是前一条）并能 Jump to source 定位到它、View in Memory 打开到那一条（forget 卡打开 Revisions 选中
//          那一次，失败的卡没有按钮）、重新打开会话后卡片仍有按钮、分开时立项实例记的依据 entry 为 null、
//          同一 abstract 在两层时不给 layer 报 Pass layer.、给了只改那一条；没给 asked 的 save 与 update 记成 Mori 记的
//          （update 改 Learned、Added by Mori 的条目后标 Added by Mori，改 You said 的条目仍是 You said；2026-10-26，WP-11）；
//   MEM-15 依据回到原位置（§10.2 表的每一行：会话开着、没开着、已归档、助手回复与工具结果里的条目、会话已删除（列表里
//          没有、文件被删、重启后会话列表还在读）、条目不在当前分支（分叉之后、不存在的 id）、读会话文件出别的错、
//          TaskBoard 实例会话、反馈（回复、选区、文件三种跳法与文件已不在）、entry 为 null；跳转未完成时离开记忆页
//          （Back to app、侧栏）；会话还在生成时（依据在正生成的这一轮里、依据在前一轮而后一轮正生成）跳过去高亮依据的
//          那条你的消息（§8 session.read 的 anchor））；依据落在一条回复上、回复里的 memory 卡折在步骤组里时先展开那一组
//          （2026-10-26 走查 M18，docs/v0/screens/chat.md"步骤组"）；
//   MEM-06 的 App 部分：工具写出的索引、detail、修订与 project.json 按 §3 的格式在盘上、`]` 与 `\` 的转义读回不变；
//          编码冲突（D:\a-b 与 D:\a\b 落在同一个目录）时记忆页、memory 工具、memory.* 与 enhance.* 都拒绝并给出 §3 的原文，
//          enhance.json 不写；另一个项目的新会话 prompt 里没有这个项目的条目（只有用户级）；手改过的索引以 detail 为准、
//          下一次写这一种时重写，读不出来的条目列为一行原因，[[slug]] 显示成链接。
// 用法（在 app/ 下，先构建好 out/）：node tests/ui/mem-app-tool.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/mem-app-tool(-packaged).json（--only 时 mem-partial-app-tool…，不计入覆盖检查），截图在
// test-results/mem-app-tool/。步骤按顺序依赖前面的步骤（restart 之后的步骤用前面建的会话），--only 只用于调试。
// 端口（§14.1 的 4700–4799 里分给本套件的 4710–4719）：合成端点 4710，记录代理 4711（看请求的 system）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好一个本机提供商（跳过探针，同 v1-switch-helpers.seedUserData
// 的做法）；记忆文件按 §3 的格式写好（用户级与本项目的事实、一条 learned 的 TASTE、跳转用的用户级 REVIEW 条目）；
// 反馈记录按 StoredFeedbackSchema 写好；一个会话文件末尾加一条分叉出去的你的消息；会话目录里另放 20000 个不是会话的
// .jsonl（让重启后的会话列表读一阵子，步骤 listLoading 用完删掉）。这些内容里都写明 synthetic。

import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEM_TOOL_LIVE, MEM_TOOL_SPLIT } from '../fake-endpoint/scenarios/memtool.mjs';
import { prepareProject, sleep } from './lib.mjs';
import {
  activeFile, assistantMessages, backToApp, brief, cardOutput, cardsOf, clickCardView, detailPath, evidenceLine,
  fileText, flashedItems, frontOf, jumpButton, localDay, lockFile, memArgs, memBase, memRecorder,
  memScope, memSection, memSelect, memView, monthDay, openMemoryPage, readDetail, readIndex,
  revisionText, rowLabel, seedEntry, seedProject, sessionLines, toolResults, userMessages, waitFlash, waitMem,
} from './mem-tool-helpers.mjs';
import {
  appLogLines, bridge, closeTbApp, contentText, eventsOf, instanceFiles, newSession, openProject, paneSel, poll,
  reopenSession, scenarioRequests, seedTeamUserData, sendMessage, showTab, shot, startTbApp, startTbEndpoint,
  stopTbEndpoint, tbModel, tbProvider, userSession, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';
import { paneCounts, waitTabBusy, waitTabIdle } from './v1-switch-helpers.mjs';
import { chooseMenuItem, savedArchived } from './m3-helpers.mjs';
import { jumpHighlight, viewerState, waitViewer } from './m4-helpers.mjs';

const args = memArgs('tool');
const { record, finish } = memRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4710;
const PROXY = 4711;
/** 合成端点上的模型（synthetic） */
const MODEL = 'fake-coder-memtool';
/** 今天（本地日历日期，依据的 at、created 与 Revisions 行用它） */
const TODAY = localDay();

/** §10.2 的说明原文 */
const JUMP = {
  deleted: 'Session deleted', gone: 'This message is no longer in the session.',
  team: 'This is a background agent’s session, which can’t be opened.',
  removed: 'The feedback file was removed.', notRecorded: 'Opened the session; the exact message wasn’t recorded.',
};
/** 附录 A.4 agent 调用方的 Correct form（§7.4 第二行） */
const CORRECT_FORM = 'Correct form: memory {"action":"save","kind":"fact","abstract":"<one line>",'
  + '"quote":"<the user\'s words>"}; update needs "entry", "note" and "quote"; forget needs "entry" and "note"';
/** 合成端点 "plain" 的回复（replies.mjs） */
const PLAIN_REPLY = '这是一段只有文字的回复，用来测试流式输出。';

/**
 * 测试准备里写好的条目（synthetic）：两层同名的事实、learned 的 TASTE；refine 是另一条 learned 的 TASTE，由没给 asked 的 update
 * 改（2026-10-26 补，WP-11 的状态表各行的用例）
 */
const SEEDED = {
  both: { slug: 'deploys-go-through-the-staging-box', abstract: 'Deploys go through the staging box' },
  learned: { slug: 'answer-in-short-bullet-lists', abstract: 'Answer in short bullet lists' },
  refine: { slug: 'keep-replies-under-ten-lines', abstract: 'Keep replies under ten lines' },
};

/** 对话里的每一次 memory 调用（第一条消息之后依次发）：参数与期望的卡片标题、状态、结果第一行 */
const CALLS = [
  { key: 'intranet', args: { action: 'save', kind: 'fact', abstract: 'The intranet model is at 10.0.0.9',
    quote: 'the intranet model is at 10.0.0.9, note it', asked: true }, verb: 'Save to Facts',
  result: 'Saved to Facts (this project): The intranet model is at 10.0.0.9' },
  { key: 'metric', args: { action: 'save', kind: 'fact', layer: 'user', abstract: 'The user prefers metric units',
    quote: 'I prefer metric units, remember that about me', asked: true }, verb: 'Save to Facts',
  result: 'Saved to Facts (user level): The user prefers metric units' },
  { key: 'rule', args: { action: 'save', kind: 'taste', abstract: 'Start every answer with the conclusion',
    quote: 'from now on, start every answer with the conclusion', asked: true }, verb: 'Save to TASTE',
  result: 'Saved to TASTE (this project): Start every answer with the conclusion' },
  { key: 'learned', args: { action: 'update', entry: SEEDED.learned.abstract, detail: 'Use at most five bullets.',
    note: 'The user confirmed the style', quote: 'yes, keep the short bullet lists, note that', asked: true },
  verb: 'Update memory', result: `Updated TASTE (this project): ${SEEDED.learned.abstract}` },
  { key: 'forget', args: { action: 'forget', entry: 'start-every-answer-with-the-conclusion',
    note: 'The user withdrew the rule' }, verb: 'Delete from memory',
  result: 'Deleted from TASTE (this project): Start every answer with the conclusion' },
  { key: 'noquote', args: { action: 'save', kind: 'fact', abstract: 'A fact without the user words' },
    verb: 'Save to Facts', error: 'quote is required for save.', usage: true },
  { key: 'both', args: { action: 'update', entry: SEEDED.both.abstract, detail: 'Every deploy goes through staging.',
    note: 'Clarified by the user', quote: 'deploys always go through staging' }, verb: 'Update memory',
  error: `“${SEEDED.both.abstract}” matches entries in both layers (user: ${SEEDED.both.slug}, this project: `
    + `${SEEDED.both.slug}). Pass layer.`, usage: true },
  { key: 'bothUser', args: { action: 'update', layer: 'user', entry: SEEDED.both.abstract,
    detail: 'Every deploy goes through staging.', note: 'Clarified by the user',
    quote: 'deploys always go through staging' }, verb: 'Update memory',
  result: `Updated Facts (user level): ${SEEDED.both.abstract}` },
  { key: 'odd', args: { action: 'save', kind: 'fact', abstract: 'Use the [beta] build from D:\\builds\\beta]',
    quote: 'use the beta build' }, verb: 'Save to Facts',
  result: 'Saved to Facts (this project): Use the [beta] build from D:\\builds\\beta]' },
  // 2026-10-26（§0 第 5 条、§6.4）：没被要求时主动记的，不给 asked 或 asked 为 false：source agent，记忆页标 Added by Mori
  { key: 'stated', args: { action: 'save', kind: 'fact', abstract: 'Staging runs PostgreSQL 15',
    quote: 'our staging database runs PostgreSQL 15' }, verb: 'Save to Facts',
  result: 'Saved to Facts (this project): Staging runs PostgreSQL 15' },
  { key: 'corrected', args: { action: 'save', kind: 'taste', abstract: 'No tables in answers',
    quote: 'no tables please, I read in a narrow terminal', asked: false }, verb: 'Save to TASTE',
  result: 'Saved to TASTE (this project): No tables in answers' },
  // 2026-10-26 补（memory-chat.md“完成（主动记的）”）：没给 asked 的 update 改一条 Learned 的条目，之后为 agent（§6.4）；
  // 放在最后，按下标取的卡与调用（0–8）不变
  { key: 'refined', args: { action: 'update', entry: SEEDED.refine.abstract,
    detail: 'At most ten lines; code blocks do not count.', note: 'The user tightened the length',
    quote: 'keep replies under ten lines, code blocks do not count' }, verb: 'Update memory',
  result: `Updated TASTE (this project): ${SEEDED.refine.abstract}` },
  // 同上：没给 asked 的 update 改 Mori 自己记的那条（corrected），之后仍是 agent
  { key: 'retold', args: { action: 'update', entry: 'No tables in answers',
    detail: 'No tables; short bullet lists read better in a narrow terminal.', note: 'The user said why',
    quote: 'tables wrap badly in my narrow terminal' }, verb: 'Update memory',
  result: 'Updated TASTE (this project): No tables in answers' },
];
/** 第一条消息（会话名取它） */
const WARMUP = 'plain MEM-10 warm-up';
/** 期望的 slug（§6.2） */
const SLUG = { intranet: 'the-intranet-model-is-at-10-0-0-9', metric: 'the-user-prefers-metric-units',
  rule: 'start-every-answer-with-the-conclusion', odd: 'use-the-beta-build-from-d-builds-beta',
  stated: 'staging-runs-postgresql-15', corrected: 'no-tables-in-answers',
  split: 'the-build-server-is-build-07', owner: 'collision-owner-fact', live: 'the-release-branch-is-release-42' };

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 一次 memory 调用的用户消息（关键词模式，参数写在同一行）。 */
const callText = (callArgs) => `call tool: memory ${JSON.stringify(callArgs)}`;
/** @brief 状态行的失败说明：第一行，超过 80 字截断加"…"（ToolCard.tsx）。 */
const failedStatus = (line) => `Failed · ${[...line].length > 80 ? `${[...line].slice(0, 80).join('')}…` : line}`;
/** @brief 错误的一行文字。 */
const errorLine = (error) => String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);

/** @brief 发一条消息，等这一轮开始再等它结束（关闭模式的会话）。 */
async function turn(ctx, tab, text, timeout = 60000) {
  const before = await paneCounts(ctx.page, tab);
  await sendMessage(ctx, tab, text);
  await waitTabBusy(ctx.page, tab, 15000, before);
  await waitTabIdle(ctx.page, tab, timeout);
}

/** @brief 在 ctx.p1 里新开一个会话，发一条 plain 消息；返回 { tab, sessionId, sessionFile }。 */
async function plainSession(ctx, text) {
  await showTab(ctx, ctx.s1.tab);
  const tab = await newSession(ctx);
  await turn(ctx, tab, text);
  return { tab, ...(await userSession(ctx, tab)) };
}

/** @brief 高亮的对话流条目（去掉条目里面带同一个 data-item-key 的元素，按条目算）。 */
const turnsOf = (flashed) => flashed.filter((item) => item.item !== null);

/** @brief 记忆页之外的会话面板数（检查跳转没有新开会话）。 */
const paneTotal = (ctx) => ctx.page.locator('.pane-slot').count();

/** @brief 某个会话面板此刻是否在生成（data-running）。 */
const tabRunning = (ctx, tab) => ctx.page.locator(paneSel(tab)).first().getAttribute('data-running', { timeout: 5000 })
  .then((value) => value === 'true', () => false);

// ---------- 准备 ----------

/** @brief 测试准备（synthetic test setup）：项目、数据目录、记忆文件、合成端点，然后启动 App。 */
async function setup(ctx) {
  ctx.p1 = realpathSync.native(prepareProject('mori-memtool-p1-').project);
  ctx.p2 = realpathSync.native(prepareProject('mori-memtool-p2-').project);
  // synthetic test setup：分开配置（chat 持有对话、planner 持有立项与结案），正文带脚本名
  writeRoles(ctx.p2, [
    { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'],
      body: 'You are chat. tb-scenario:mem-tool-split' },
    { name: 'planner', description: 'Decides how to split each request and closes it', seats: ['create', 'close'],
      body: 'You are planner. tb-scenario:mem-tool-split' },
    { name: 'executor', description: 'Changes code and runs commands to finish a task',
      body: 'You are executor. tb-scenario:mem-tool-split' }]);
  ctx.colRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'mori-memtool-col-')));
  ctx.colA = join(ctx.colRoot, 'a-b');
  ctx.colB = join(ctx.colRoot, 'a', 'b');
  for (const dir of [ctx.colA, ctx.colB]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Synthetic collision project\n');
  }
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, { providers: [tbProvider('memtool', PROXY, [tbModel(MODEL)])] });
  seedMemory(ctx);
  await startTbApp(ctx);
}

/** @brief 测试准备（synthetic test setup）：用户级与 p1 的两条同名事实、p1 一条 learned 的 TASTE（带一项反馈依据）。 */
function seedMemory(ctx) {
  const user = memBase(ctx.userData, null);
  const project = seedProject(ctx.userData, ctx.p1);
  const both = { kind: 'fact', ...SEEDED.both, details: 'Synthetic entry written by mem-app-tool.' };
  seedEntry(user, both);
  seedEntry(project, both);
  seedEntry(project, { kind: 'taste', ...SEEDED.learned, source: 'learned', details: 'Synthetic learned entry.',
    evidence: [{ at: TODAY, feedback: 'synthetic-seed.json', quote: 'synthetic: shorter please' }],
    history: [`${monthDay(TODAY)} · Enhancement: synthetic seed`] });
  seedEntry(project, { kind: 'taste', ...SEEDED.refine, source: 'learned',
    details: 'Synthetic learned entry to refine.', history: [`${monthDay(TODAY)} · Enhancement: synthetic seed`] });
}

// ---------- MEM-10：对话里的 memory 工具 ----------

/**
 * @brief 在 p1 里开会话 S1：第一条 plain 消息，然后依次发 CALLS（每条一次 memory 调用）；两层同名事实在第 7、8 次调用
 *        前后各记一份文件内容。之后检查卡片、结果、文件。
 */
async function chat(ctx) {
  const tab = await openProject(ctx, ctx.p1);
  ctx.s1 = { tab };
  ctx.chatSince = Date.now();
  await turn(ctx, tab, WARMUP);
  Object.assign(ctx.s1, await userSession(ctx, tab));
  const user = memBase(ctx.userData, null);
  const project = memBase(ctx.userData, ctx.p1);
  const both = () => ({ user: fileText(detailPath(user, SEEDED.both.slug)),
    project: fileText(detailPath(project, SEEDED.both.slug)) });
  ctx.both = {};
  for (const call of CALLS) {
    if (call.key === 'both') ctx.both.before = both();
    await turn(ctx, tab, callText(call.args));
    if (call.key === 'both') ctx.both.afterRefused = both();
    if (call.key === 'bothUser') ctx.both.afterUser = both();
  }
  ctx.s1.lines = sessionLines(ctx.s1.sessionFile);
  ctx.s1.results = toolResults(ctx.s1.lines, 'memory');
  await shot(ctx, args, 'chat');
  await cardChecks(ctx);
  await gateChecks(ctx);
  evidenceFileChecks(ctx);
  ruleFileChecks(ctx);
  updateFileChecks(ctx);
  formatChecks(ctx);
  sourceFileChecks(ctx);
}

/**
 * @brief MEM-10（2026-10-26，§6.4）：asked 为真时 source user；没给 asked（stated）或 asked 为 false（corrected）时
 *        source agent，依据照样是原话与说这句话的那条你的消息。
 */
function sourceFileChecks(ctx) {
  const project = memBase(ctx.userData, ctx.p1);
  const stated = readDetail(project, SLUG.stated);
  const corrected = readDetail(project, SLUG.corrected);
  const intranet = readDetail(project, SLUG.intranet);
  const said = userIdWith(ctx, CALLS.find((call) => call.key === 'stated').args.abstract);
  record('MEM-10 a save without asked (a fact) or with asked false (a TASTE rule) is added by Mori: source agent, '
    + 'created today · Mori, in its index, and its evidence is still the user’s words and that message; the asked '
    + 'save is source user', stated?.front.source === 'agent' && corrected?.front.source === 'agent'
    && intranet?.front.source === 'user' && stated.front.created === `${TODAY} · Mori`
    && readIndex(project, 'fact').some((item) => item.slug === SLUG.stated)
    && readIndex(project, 'taste').some((item) => item.slug === SLUG.corrected)
    && stated.front.evidence?.[0]?.entry === said && stated.front.evidence[0].quote === 'our staging database runs '
      + 'PostgreSQL 15', brief({ stated: stated?.front, corrected: corrected?.front.source, said }));
  const refined = readDetail(project, SEEDED.refine.slug);
  const retold = readDetail(project, SLUG.corrected);
  const changed = (entry, key) => entry?.front.source === 'agent'
    && entry.details === CALLS.find((item) => item.key === key).args.detail
    && entry.front.modified === `${TODAY} · Mori`
    && entry.front.evidence?.at(-1)?.quote === CALLS.find((item) => item.key === key).args.quote;
  record('MEM-10 an update without asked changes a Learned entry into one added by Mori, and an entry added by Mori '
    + 'stays added by Mori (2026-10-26, §6.4): source agent, Details replaced, modified today · Mori, the user’s '
    + 'words appended as evidence', changed(refined, 'refined') && changed(retold, 'retold'),
  brief({ refined: refined?.front, retold: retold?.front }));
}

/** @brief MEM-10：每次调用一张卡，标题（§7.5）、状态、View in Memory 只在完成的卡上；结果原文（§7.4）。 */
async function cardChecks(ctx) {
  const { tab } = ctx.s1;
  const cards = await cardsOf(ctx.page, tab);
  const bad = [];
  for (const [index, call] of CALLS.entries()) {
    const card = cards[index] ?? {};
    const target = call.args.action === 'save' ? call.args.abstract : call.args.entry;
    const status = call.error ? 'failed' : 'done';
    if (card.verb !== call.verb || card.target !== target) bad.push(`${call.key}: title ${card.verb} · ${card.target}`);
    if (card.status !== status) bad.push(`${call.key}: status ${card.status}`);
    if (call.error && card.statusText !== failedStatus(call.error)) bad.push(`${call.key}: ${card.statusText}`);
    if (Boolean(card.view) === Boolean(call.error)) bad.push(`${call.key}: view button ${card.view}`);
  }
  record('MEM-10 every memory call in the chat has one tool card: Save to Facts / Save to TASTE · <abstract>, Update '
    + 'memory · <entry>, Delete from memory · <entry> (§7.5); finished cards are Done with View in Memory after the '
    + 'status; failed cards are “Failed · <first line of the reason>” and have no View in Memory',
  cards.length === CALLS.length && bad.length === 0, brief({ count: cards.length, bad, cards: cards.slice(0, 3) }));
  const outputs = [];
  for (const [index, call] of CALLS.entries()) {
    const want = call.error ? (call.usage ? `${call.error}\n${CORRECT_FORM}` : call.error) : call.result;
    const output = await cardOutput(ctx.page, tab, index);
    if (output.trim() !== want) outputs.push({ key: call.key, output, want });
  }
  record('MEM-10 the expanded cards show the §7.4 result line (Saved to Facts (this project): …, Saved to Facts (user '
    + 'level): …, Updated …, Deleted from …); rule errors show the reason and the appendix A.4 Correct form line',
  outputs.length === 0, brief(outputs));
}

/** @brief MEM-10：memory 不出批准卡（权限模式是默认的 Ask each time），mori.tool_gate 为 free（§7.5）。 */
async function gateChecks(ctx) {
  const gates = (await eventsOf(ctx.page, null, ctx.chatSince))
    .filter((item) => item.type === 'mori.tool_gate' && item.data?.toolName === 'memory');
  const cards = await ctx.page.locator(`${paneSel(ctx.s1.tab)} [data-testid="approval-card"]`).count();
  const permission = await ctx.page.locator(`${paneSel(ctx.s1.tab)} [data-testid="permission-button"]`)
    .textContent().catch(() => '');
  record('MEM-10 memory calls never show an approval card in Ask each time mode: every call’s mori.tool_gate is '
    + '“free” and the session has no approval card', gates.length === CALLS.length
    && gates.every((item) => item.data.gate === 'free') && cards === 0,
  brief({ gates: gates.map((item) => item.data.gate), cards, permission }));
}

/** @brief 这次调用的工具结果（会话文件里按顺序，与 CALLS 一一对应）。 */
const resultOf = (ctx, key) => ctx.s1.results[CALLS.findIndex((call) => call.key === key)] ?? null;

/** @brief S1 里含 text 的你的消息的条目 id。 */
const userIdWith = (ctx, text) => userMessages(ctx.s1.lines).find((item) => item.text.includes(text))?.id ?? null;

/**
 * @brief MEM-10：记事实（默认本项目、layer user 写用户级），source user；依据是原话与说这句话的那条你的消息
 *        （不是前一条，§7.3），会话文件是 S1。
 */
function evidenceFileChecks(ctx) {
  const project = memBase(ctx.userData, ctx.p1);
  const user = memBase(ctx.userData, null);
  const fact = readDetail(project, SLUG.intranet);
  const metric = readDetail(user, SLUG.metric);
  const said = userIdWith(ctx, CALLS[0].args.abstract);
  const warmup = userIdWith(ctx, WARMUP);
  const evidence = fact?.front.evidence?.[0] ?? {};
  const inIndex = (base, slug) => readIndex(base, 'fact').some((item) => item.slug === slug);
  record('MEM-10 memory save of a fact goes to this project by default and with layer user to the user level: '
    + 'project MEMORY.md lists the intranet fact, the user MEMORY.md lists the metric fact (and not the other way), '
    + 'both with source user', fact?.front.source === 'user' && metric?.front.source === 'user'
    && inIndex(project, SLUG.intranet) && inIndex(user, SLUG.metric) && !inIndex(user, SLUG.intranet)
    && !inIndex(project, SLUG.metric), brief({ fact: fact?.front, metric: metric?.front }));
  record('MEM-10 the evidence records the user’s words and the user message that said them: session is the S1 file, '
    + 'entry is the id of the message with the call (not the warm-up before it), quote is the given quote, at is '
    + 'today', evidence.session === ctx.s1.sessionFile && evidence.entry === said && said !== warmup
    && evidence.quote === CALLS[0].args.quote && evidence.at === TODAY && typeof evidence.title === 'string',
  brief({ evidence, said, warmup }));
  ctx.s1.saidId = said;
  ctx.s1.warmupId = warmup;
}

/** @brief MEM-10：你明说的规则记进本项目的 TASTE（source user），之后 forget 删掉它（索引与文件都没了，修订有 Note）。 */
function ruleFileChecks(ctx) {
  const project = memBase(ctx.userData, ctx.p1);
  const saved = revisionText(project, resultOf(ctx, 'rule')?.details?.revision ?? '-');
  const front = frontOf(saved);
  record('MEM-10 a rule the user states is saved to this project’s TASTE with source user: its revision is '
    + '“Mori · Added TASTE: …” with layers [project], kinds [taste] and the after file has source: user',
  front.title === `Mori · Added TASTE: ${CALLS[2].args.abstract}` && same(front.layers, ['project'])
    && same(front.kinds, ['taste']) && /~~~~after\n---\nkind: taste\n[^]*\nsource: user\n/.test(saved ?? ''),
  brief({ front, saved: saved?.slice(0, 300) }));
  const removed = revisionText(project, resultOf(ctx, 'forget')?.details?.revision ?? '-');
  const gone = !existsSync(detailPath(project, SLUG.rule))
    && !readIndex(project, 'taste').some((item) => item.slug === SLUG.rule);
  record('MEM-10 memory forget deletes the entry: the detail file and the TASTE.md line are gone; the revision is '
    + '“Mori · Deleted TASTE: …” with a “## Deleted · TASTE · <slug>” section and the note on its Note: line',
  gone && frontOf(removed).title === `Mori · Deleted TASTE: ${CALLS[2].args.abstract}`
    && (removed ?? '').includes(`## Deleted · TASTE · ${SLUG.rule}\nNote: ${CALLS[4].args.note}\n`),
  brief({ gone, removed: removed?.slice(0, 400) }));
}

/**
 * @brief MEM-10：update 改一条 learned 条目（之后为 user，Revisions 追加一行，依据追加）；同一 abstract 在两层时不给 layer
 *        什么都不改，给了 layer 只改那一条。
 */
function updateFileChecks(ctx) {
  const project = memBase(ctx.userData, ctx.p1);
  const learned = readDetail(project, SEEDED.learned.slug);
  const line = `${monthDay(TODAY)} · Mori: ${CALLS[3].args.note}`;
  record('MEM-10 memory update changes a learned entry: it becomes source user, Details is replaced, the Revisions '
    + 'line “<Mon D> · Mori: <note>” is appended after the old one, the evidence is appended (2 items), modified '
    + 'is today · Mori and the index line keeps its place', learned?.front.source === 'user'
    && learned.details === CALLS[3].args.detail && same(learned.history, [`${monthDay(TODAY)} · Enhancement: `
      + 'synthetic seed', line]) && learned.front.evidence?.length === 2
    && learned.front.modified === `${TODAY} · Mori` && readIndex(project, 'taste')[0]?.slug === SEEDED.learned.slug,
  brief({ front: learned?.front, history: learned?.history, details: learned?.details }));
  const { before, afterRefused, afterUser } = ctx.both;
  const refused = resultOf(ctx, 'both');
  record('MEM-10 the same fact in both layers: update without layer is refused with “… matches entries in both '
    + 'layers (user: <id>, this project: <id>). Pass layer.” and changes neither file; with layer user it changes '
    + 'only the user-level entry', refused?.isError && refused.text.startsWith(CALLS[6].error)
    && same(before, afterRefused) && afterUser?.project === before?.project && afterUser?.user !== before?.user
    && (afterUser?.user ?? '').includes(CALLS[7].args.detail),
  brief({ refused: refused?.text, changed: { user: afterUser?.user !== before?.user,
    project: afterUser?.project !== before?.project } }));
}

/**
 * @brief MEM-06（App）：工具写出的文件按 §3：project.json、索引行、detail 全文（frontmatter 与三节）、修订全文
 *        （frontmatter、Added 一节、Evidence 行、before/after 围栏）；`]` 与 `\` 在索引里转义。
 */
function formatChecks(ctx) {
  const project = memBase(ctx.userData, ctx.p1);
  const fact = readDetail(project, SLUG.intranet);
  const evidence = fact?.front.evidence?.[0] ?? {};
  const line = evidenceLine(evidence);
  const detail = ['---', 'kind: fact', `abstract: ${JSON.stringify(CALLS[0].args.abstract)}`, 'source: user',
    `created: ${JSON.stringify(`${TODAY} · Mori`)}`, `modified: ${JSON.stringify(`${TODAY} · Mori`)}`,
    `evidence: ${JSON.stringify([evidence])}`, '---', '## Evidence', `- ${line}`, '', '## Details', '',
    '## Revisions', ''].join('\n');
  const id = resultOf(ctx, 'intranet')?.details?.revision ?? '';
  const text = revisionText(project, id) ?? '';
  const front = frontOf(text);
  const revision = ['---', `id: ${JSON.stringify(id)}`, `time: ${JSON.stringify(front.time)}`, 'by: "Mori"',
    `title: ${JSON.stringify(`Mori · Added Facts: ${CALLS[0].args.abstract}`)}`, 'status: "done"',
    'layers: ["project"]', 'kinds: ["fact"]', 'counts: {"added":1,"changed":0,"deleted":0,"moved":0}',
    `cwd: ${JSON.stringify(ctx.p1)}`, 'run: null', 'rollbackOf: null', '---',
    `## Added · Facts · ${SLUG.intranet}`, `Evidence: ${line}`, '', '~~~~before', '~~~~', '~~~~after',
    fact?.text ?? '', '~~~~', ''].join('\n');
  const owner = JSON.parse(fileText(join(project, 'project.json')) ?? 'null');
  record('MEM-06 the files the memory tool writes follow §3: project.json holds the cwd; MEMORY.md is “# Facts” plus '
    + 'one “- [<abstract>](entries/<slug>.md)” line per entry; the detail file is the §3.2 frontmatter (JSON strings, '
    + 'one-line evidence array) and the Evidence / Details / Revisions sections; the revision file '
    + '<id>.md is the §3.3 frontmatter, “## Added · Facts · <slug>”, the Evidence: line and the ~~~~before / '
    + '~~~~after blocks holding the whole detail file', fact?.text === detail && text === revision
    && /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id) && owner?.cwd === ctx.p1
    && (fileText(join(project, 'MEMORY.md')) ?? '').startsWith('# Facts\n- ['),
  brief({ detailOk: fact?.text === detail, revisionOk: text === revision, id, owner,
    detail: fact?.text?.slice(0, 500), revision: text.slice(0, 600) }));
  const odd = readIndex(project, 'fact').find((item) => item.slug === SLUG.odd);
  record('MEM-06 “]” and “\\” in an abstract are written as “\\]” and “\\\\” in the index line and read back '
    + 'unchanged (the detail frontmatter keeps the original text)',
  odd?.line === `- [Use the [beta\\] build from D:\\\\builds\\\\beta\\]](entries/${SLUG.odd}.md)`
    && odd.abstract === CALLS[8].args.abstract && readDetail(project, SLUG.odd)?.front.abstract === odd.abstract,
  brief(odd));
}

// ---------- MEM-10：View in Memory ----------

/** View in Memory 的落点：CALLS 的键 → 期望的层、分节与选中的条目（rule 那条之后被删掉，详情不打开） */
const VIEW_CASES = {
  intranet: { scope: 'project', section: 'facts', entry: SLUG.intranet, title: CALLS[0].args.abstract },
  metric: { scope: 'user', section: 'facts', entry: SLUG.metric, title: CALLS[1].args.abstract },
  learned: { scope: 'project', section: 'taste', entry: SEEDED.learned.slug, title: SEEDED.learned.abstract },
  bothUser: { scope: 'user', section: 'facts', entry: SEEDED.both.slug, title: SEEDED.both.abstract },
  odd: { scope: 'project', section: 'facts', entry: SLUG.odd, title: CALLS[8].args.abstract },
};

/** @brief 记忆页是否停在 want（层、分节、选中的条目且右栏是它）。 */
const landedOn = (view, want) => view.page && view.scope === want.scope && view.section === want.section
  && view.rows.some((row) => row.id === want.entry && row.pressed) && view.entryTitle === want.title;

/**
 * @brief 点 S1 里第 index 张卡的 View in Memory，等记忆页满足 test；返回 { view, openAfter（回到会话后卡片是否展开） }。
 */
async function viewFromCard(ctx, index, test) {
  await showTab(ctx, ctx.s1.tab);
  await clickCardView(ctx.page, ctx.s1.tab, index);
  const view = await waitMem(ctx.page, test);
  await backToApp(ctx.page);
  const cards = await cardsOf(ctx.page, ctx.s1.tab);
  return { view, openAfter: cards[index]?.open ?? null };
}

/** @brief MEM-10：完成的卡的 View in Memory 打开到那一层那一种、选中那一条；forget 卡打开 Revisions 选中那一次。 */
async function view(ctx) {
  const bad = [];
  for (const [key, want] of Object.entries(VIEW_CASES)) {
    const index = CALLS.findIndex((call) => call.key === key);
    const got = await viewFromCard(ctx, index, (now) => landedOn(now, want));
    if (!landedOn(got.view, want) || got.openAfter !== false) bad.push({ key, want, got: { ...got.view, rows: [] } });
  }
  record('MEM-10 View in Memory on a finished save or update card opens the Memory page at that layer and kind with '
    + 'the entry selected and its detail open (project fact, user fact, project TASTE after update, user fact after '
    + 'the layer update, fact with brackets), and clicking it does not expand the card', bad.length === 0, brief(bad));
  const revision = resultOf(ctx, 'forget')?.details?.revision;
  const forget = await viewFromCard(ctx, 4, (now) => now.section === 'revisions'
    && now.revisions.some((row) => row.id === revision && row.pressed) && now.revisionTitle !== null);
  record('MEM-10 View in Memory on the forget card opens Project → Revisions with that revision selected and its '
    + 'detail (“Mori · Deleted TASTE: …”) open', forget.view.scope === 'project' && forget.view.section === 'revisions'
    && forget.view.revisions.some((row) => row.id === revision && row.pressed)
    && forget.view.revisionTitle === `Mori · Deleted TASTE: ${CALLS[2].args.abstract}` && forget.openAfter === false,
  brief({ revision, view: { ...forget.view, revisions: forget.view.revisions.slice(0, 3), rows: [] } }));
  const rule = await viewFromCard(ctx, 2, (now) => now.section === 'taste' && now.rows.length > 0 && !now.detail);
  record('MEM-10 View in Memory on the save card of an entry deleted later opens Project → TASTE with the list as '
    + 'usual and no detail (memory.get returns null)', rule.view.scope === 'project' && rule.view.section === 'taste'
    && !rule.view.detail && !rule.view.rows.some((row) => row.id === SLUG.rule), brief(rule.view));
  const odd = VIEW_CASES.odd;
  const row = (await viewFromCard(ctx, 8, (now) => landedOn(now, odd))).view.rows.find((item) => item.id === odd.entry);
  record('MEM-06 the entry whose abstract has “[”, “]” and “\\” shows its original abstract on the Memory page',
    row?.title === odd.title, brief(row));
  const cards = await cardsOf(ctx.page, ctx.s1.tab);
  record('MEM-10 failed memory cards (missing quote, both layers matched) have no View in Memory',
    cards[5]?.status === 'failed' && cards[6]?.status === 'failed' && !cards[5].view && !cards[6].view,
  brief(cards.slice(5, 7)));
  await sourceView(ctx);
}

/**
 * @brief MEM-10、MEM-14（2026-10-26）：View in Memory 打开主动记的那条：行标 Added by Mori（data-source agent），
 *        详情的来历一行写 Added by Mori；你要它记的那条标 You said。
 */
async function sourceView(ctx) {
  const stated = { scope: 'project', section: 'facts', entry: SLUG.stated, title: 'Staging runs PostgreSQL 15' };
  const index = CALLS.findIndex((call) => call.key === 'stated');
  const got = (await viewFromCard(ctx, index, (now) => landedOn(now, stated))).view;
  const row = got.rows.find((item) => item.id === SLUG.stated);
  const asked = got.rows.find((item) => item.id === SLUG.intranet);
  record('MEM-10 View in Memory on the card of a fact saved on its own opens it in Facts; its row is marked '
    + '“Added by Mori” (data-source agent) and the detail line reads “Facts · Project · Added by Mori · Created … by '
    + 'Mori · …”, while the asked fact’s row says “You said”', landedOn(got, stated) && row?.source === 'agent'
    && row.tag === 'Added by Mori' && (got.entryMeta ?? '').startsWith('Facts · Project · Added by Mori · Created ')
    && asked?.source === 'user' && asked.tag === 'You said', brief({ row, asked, meta: got.entryMeta }));
  await updateSourceView(ctx);
}

/**
 * @brief memory-chat.md“完成（主动记的）”（2026-10-26 补，§6.4）：View in Memory 打开没给 asked 的 update 改过的 Learned 条目
 *        与 Mori 记的条目，行标 Added by Mori、详情一行写 Added by Mori；没给 asked 的 update 改的 You said 条目（bothUser）
 *        仍是 You said。
 */
async function updateSourceView(ctx) {
  const at = (key) => CALLS.findIndex((call) => call.key === key);
  const open = async (key, want) => {
    const view = (await viewFromCard(ctx, at(key), (now) => landedOn(now, want))).view;
    const row = view.rows.find((item) => item.id === want.entry);
    return { landed: landedOn(view, want), source: row?.source, tag: row?.tag, meta: view.entryMeta ?? '' };
  };
  const tasteOf = (entry, title) => ({ scope: 'project', section: 'taste', entry, title });
  const refined = await open('refined', tasteOf(SEEDED.refine.slug, SEEDED.refine.abstract));
  const retold = await open('retold', tasteOf(SLUG.corrected, 'No tables in answers'));
  const said = await open('bothUser', VIEW_CASES.bothUser);
  const byMori = (got) => got.landed && got.source === 'agent' && got.tag === 'Added by Mori'
    && got.meta.startsWith('TASTE · Project · Added by Mori · ');
  record('MEM-10 View in Memory on the card of an update without asked opens the Learned entry it changed, now '
    + 'marked “Added by Mori” (data-source agent) with the detail line “TASTE · Project · Added by Mori · …”; an '
    + 'entry added by Mori and updated without asked stays “Added by Mori”; the You said entry updated without '
    + 'asked (user level) is still marked “You said”', byMori(refined) && byMori(retold) && said.landed
    && said.source === 'user' && said.tag === 'You said', brief({ refined, retold, said }));
}

// ---------- MEM-10、MEM-15：依据定位到说这句话的那条消息 ----------

/**
 * @brief 从 S1 的 intranet 卡进记忆页：依据行是 `<Mon D> · Session “<侧栏的会话名>”: “<原话>”`；Jump to source 回到 S1，
 *        高亮的是带这次调用的那条你的消息（不是前一条）。
 */
async function evidence(ctx) {
  await showTab(ctx, ctx.s1.tab);
  await clickCardView(ctx.page, ctx.s1.tab, 0);
  const view = await waitMem(ctx.page, (now) => landedOn(now, VIEW_CASES.intranet) && now.evidence.length > 0);
  const label = await rowLabel(ctx.page, ctx.s1.sessionFile);
  const line = `${monthDay(TODAY)} · Session “${label}”: “${CALLS[0].args.quote}”`;
  await jumpButton(ctx.page).click();
  await ctx.page.getByTestId('memory-page').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  const flashed = await waitFlash(ctx.page);
  const active = await activeFile(ctx.page);
  await shot(ctx, args, 'evidence-jump');
  const turns = turnsOf(flashed);
  const ok = view.evidence[0]?.line === line && active === ctx.s1.sessionFile && turns.length === 1
    && turns[0].item === 'user' && turns[0].text.includes(CALLS[0].args.abstract) && !turns[0].text.includes(WARMUP);
  record('MEM-10 the Memory page shows the evidence “<Mon D> · Session “<session name>”: “<quote>”” and Jump to '
    + 'source goes back to S1 and highlights the user message that made the call (not the message before it)', ok,
  brief({ line: view.evidence[0]?.line, want: line, active, flashed }));
  record('MEM-15 §10.2 row 1 (session open in the sidebar): Jump to source shows the session and highlights the turn '
    + 'with the evidence entry (the user message)', ok, brief({ active, flashed }));
}

// ---------- MEM-10、MEM-15：会话还在生成时跳到依据 ----------

/** @brief 会话文件里最后回答（MEM_TOOL_LIVE.reply）的条数。 */
const liveReplies = (file) => assistantMessages(sessionLines(file))
  .filter((item) => item.text.includes(MEM_TOOL_LIVE.reply)).length;

/**
 * @brief 在 L 所在项目的记忆页 Project → Facts 选中 L 记的事实，点 Jump to source；返回 runJump 的结果，另加高亮出现时
 *        L 是否还在生成（running）与那时会话文件里最后回答的条数（replies）。
 */
async function jumpLive(ctx) {
  const { tab, sessionFile } = ctx.live;
  await showTab(ctx, tab);
  await openMemoryPage(ctx.page);
  await memScope(ctx.page, 'project');
  await memSection(ctx.page, 'facts');
  await memSelect(ctx.page, SLUG.live);
  await waitMem(ctx.page, (now) => now.evidence.length > 0);
  const jump = await clickJump(ctx);
  const running = await tabRunning(ctx, tab);
  return { ...jump, running, replies: liveReplies(sessionFile), active: await activeFile(ctx.page) };
}

/** @brief 生成中的跳转是否落在 L 的第一条你的消息上：离开记忆页、L 在焦点、只高亮那一条、那时还在生成。 */
const liveLanded = (ctx, jump, replies) => jump.left && jump.active === ctx.live.sessionFile && jump.running
  && jump.replies === replies && turnsOf(jump.flashed).length === 1 && turnsOf(jump.flashed)[0].item === 'user'
  && turnsOf(jump.flashed)[0].text.includes(MEM_TOOL_LIVE.message)
  && !turnsOf(jump.flashed)[0].text.includes(MEM_TOOL_LIVE.second);

/**
 * @brief MEM-10、MEM-15：p1 新开会话 L，第一条消息（脚本 mem-tool-live）里主 Agent 先 memory save，再等 25 秒才回答。
 *        这一轮还在生成时：依据是 L 的文件与这条你的消息，Jump to source 跳回 L 并高亮它（§8 session.read 的 anchor 在
 *        完整的当前分支上算，不受生成中的影响）。这一轮结束后发第二条（同样等 25 秒），第二轮生成时再跳一次，仍高亮第一条。
 */
async function live(ctx) {
  await showTab(ctx, ctx.s1.tab);
  const tab = await newSession(ctx);
  ctx.live = { tab };
  let before = await paneCounts(ctx.page, tab);
  await sendMessage(ctx, tab, MEM_TOOL_LIVE.message);
  await waitTabBusy(ctx.page, tab, 15000, before);
  const card = await poll(async () => {
    const first = (await cardsOf(ctx.page, tab))[0];
    return first?.status === 'done' ? first : null;
  }, 30000, 100);
  Object.assign(ctx.live, await userSession(ctx, tab));
  const said = userMessages(sessionLines(ctx.live.sessionFile))
    .find((item) => item.text === MEM_TOOL_LIVE.message)?.id ?? null;
  const evidenceItem = readDetail(memBase(ctx.userData, ctx.p1), SLUG.live)?.front.evidence?.[0] ?? {};
  const first = await jumpLive(ctx);
  await shot(ctx, args, 'live-jump-first-turn');
  record('MEM-10 a memory save in a turn that is still generating (the session’s first turn): the evidence is the '
    + 'session file and the id of that turn’s user message (the one that said it), with the given quote',
  Boolean(card) && said !== null && evidenceItem.session === ctx.live.sessionFile && evidenceItem.entry === said
    && evidenceItem.quote === MEM_TOOL_LIVE.quote, brief({ card, said, evidence: evidenceItem }));
  record('MEM-15 §10.2 row 1 while the session is still generating the turn that saved the evidence: Jump to source '
    + 'goes back to the session and highlights that turn’s user message (session.read’s anchor is found on the full '
    + 'current branch), and the reply is still being generated', liveLanded(ctx, first, 0), brief(first));
  await waitTabIdle(ctx.page, tab, 60000);
  before = await paneCounts(ctx.page, tab);
  await sendMessage(ctx, tab, MEM_TOOL_LIVE.second);
  await waitTabBusy(ctx.page, tab, 15000, before);
  const second = await jumpLive(ctx);
  await shot(ctx, args, 'live-jump-second-turn');
  record('MEM-15 §10.2 row 1 while the session is generating a later turn (the evidence’s turn is finished): Jump to '
    + 'source highlights the evidence’s user message, not the message being answered now', liveLanded(ctx, second, 1),
  brief(second));
  await waitTabIdle(ctx.page, tab, 60000);
}

// ---------- MEM-10、MEM-15：分开时的立项实例 ----------

/**
 * @brief p2（分开配置）：关闭模式先聊一句，再 /task 一条消息；立项实例用 memory save 记一条事实（脚本 mem-tool-split）。
 *        依据的 session 是用户会话的文件、entry 为 null；用户会话里没有这张卡；Jump to source 打开会话、不定位。
 */
async function split(ctx) {
  const tab = await openProject(ctx, ctx.p2);
  await turn(ctx, tab, MEM_TOOL_SPLIT.warmup);
  const who = { tab, ...(await userSession(ctx, tab)) };
  ctx.s2 = who;
  await sendMessage(ctx, tab, MEM_TOOL_SPLIT.message, { team: true });
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the team of S2 did not become idle');
  const base = memBase(ctx.userData, ctx.p2);
  const fact = readDetail(base, SLUG.split);
  const evidenceItem = fact?.front.evidence?.[0] ?? {};
  const instances = instanceFiles(ctx, who.sessionId);
  const create = instances.find((item) => toolResults(item.entries, 'memory').length > 0);
  ctx.s2.instance = create ?? instances[0] ?? null;
  const cards = await cardsOf(ctx.page, tab);
  record('MEM-10 in team mode with split roles the create instance saves with memory: the fact is in the project, '
    + 'source user, its evidence is the user session file with entry null (the message is not in the user session '
    + 'yet) and the quote; the user session shows no memory tool card', fact?.front.source === 'user'
    && evidenceItem.session === who.sessionFile && 'entry' in evidenceItem && evidenceItem.entry === null
    && evidenceItem.quote === MEM_TOOL_SPLIT.quote && Boolean(create)
    && !cards.some((card) => card.verb.startsWith('Save to')),
  brief({ evidence: evidenceItem, create: create?.file, cards: cards.map((card) => card.verb) }));
  await splitJump(ctx);
}

/** @brief MEM-15 第四行：entry 为 null 的依据打开会话、不定位，回到记忆页时状态行写 §10.2 的那一句。 */
async function splitJump(ctx) {
  const who = ctx.s2;
  await showTab(ctx, who.tab);
  await openMemoryPage(ctx.page);
  await memScope(ctx.page, 'project');
  await memSection(ctx.page, 'facts');
  await memSelect(ctx.page, SLUG.split);
  await jumpButton(ctx.page).click();
  await ctx.page.getByTestId('memory-page').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const after = { active: await activeFile(ctx.page), flashed: await flashedItems(ctx.page) };
  await openMemoryPage(ctx.page);
  const view = await waitMem(ctx.page, (now) => now.evidence.length > 0 && now.evidence[0].status !== null);
  record('MEM-15 §10.2 row 4 (entry null, saved by the split create instance): Jump to source opens the session '
    + 'without positioning (no highlight) and the Memory page’s status line says “Opened the session; the exact '
    + 'message wasn’t recorded.”', after.active === who.sessionFile && after.flashed.length === 0
    && view.evidence[0]?.status === JUMP.notRecorded, brief({ after, evidence: view.evidence }));
  await backToApp(ctx.page);
}

// ---------- MEM-06：编码冲突 ----------

/** 冲突的两个项目里 memory 工具记的事实 */
const OWNER_CALL = { action: 'save', kind: 'fact', abstract: 'Collision owner fact',
  quote: 'remember the collision owner fact', asked: true };
const OTHER_CALL = { action: 'save', kind: 'fact', abstract: 'Collision other fact',
  quote: 'remember the collision other fact', asked: true };

/**
 * @brief a-b 先记一条事实（认领项目目录），a\b 落在同一个目录（§3 编码有损）：memory 工具、memory.*、enhance.*、记忆页都拒绝，
 *        enhance.json 不写；之后两个项目各开一个新会话，a\b 的 prompt 里没有 a-b 的条目（只有用户级）。
 */
async function collision(ctx) {
  const base = memBase(ctx.userData, ctx.colA);
  const tabA = await openProject(ctx, ctx.colA);
  await turn(ctx, tabA, callText(OWNER_CALL));
  const owner = JSON.parse(fileText(join(base, 'project.json')) ?? 'null');
  const reason = `This project’s memory folder belongs to ${ctx.colA}.`;
  const tabB = await openProject(ctx, ctx.colB);
  ctx.col = { tabA, tabB, reason, base };
  await turn(ctx, tabB, callText(OTHER_CALL));
  const card = (await cardsOf(ctx.page, tabB))[0] ?? {};
  const output = await cardOutput(ctx.page, tabB, 0);
  record('MEM-06 the two working folders a-b and a\\b encode to the same memory folder: a-b writes first and '
    + 'project.json records its cwd; a memory call in a\\b fails with “This project’s memory folder belongs to '
    + '<a-b>.” (no Correct form line) and writes nothing', memBase(ctx.userData, ctx.colB) === base
    && owner?.cwd === ctx.colA && card.status === 'failed' && card.statusText === failedStatus(reason)
    && !card.view && output.trim() === reason && !existsSync(detailPath(base, 'collision-other-fact'))
    && readIndex(base, 'fact').map((item) => item.slug).join() === SLUG.owner,
  brief({ owner, card, output, index: readIndex(base, 'fact') }));
  await collisionBridge(ctx);
  await collisionPage(ctx);
  await collisionPrompts(ctx);
}

/** @brief MEM-06：a\b 的 memory.* 与 enhance.* 都返回 §3 的原文，不读不写（enhance.json 不出现）。 */
async function collisionBridge(ctx) {
  const { reason, base } = ctx.col;
  const cwd = ctx.colB;
  const results = {
    list: await bridge(ctx, { type: 'memory.list', cwd, layer: 'project', kind: 'fact' }),
    get: await bridge(ctx, { type: 'memory.get', cwd, layer: 'project', id: SLUG.owner }),
    save: await bridge(ctx, { type: 'memory.save', cwd, layer: 'project', kind: 'fact', abstract: 'Synthetic page',
      detail: '' }),
    revisions: await bridge(ctx, { type: 'memory.revisions', cwd, layer: 'project' }),
    enhanceGet: await bridge(ctx, { type: 'enhance.get', cwd }),
    enhanceSet: await bridge(ctx, { type: 'enhance.set', cwd, enabled: true }),
    enhanceRun: await bridge(ctx, { type: 'enhance.run', cwd }),
  };
  const errors = Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value?.error ?? null]));
  record('MEM-06 for the colliding folder a\\b memory.list, memory.get, memory.save, memory.revisions, enhance.get, '
    + 'enhance.set and enhance.run all return error “This project’s memory folder belongs to <a-b>.”; enhance.json '
    + 'is not written and the folder still lists only a-b’s fact',
  Object.values(errors).every((error) => error === reason)
    && !existsSync(join(base, 'enhance.json')) && readIndex(base, 'fact').length === 1
    && results.list.entries?.length === 0, brief({ errors, list: results.list }));
}

/** @brief MEM-06：焦点在 a\b 的会话时记忆页 Project 显示读取失败、增强一块显示读不出设置，开关失败并说明原因。 */
async function collisionPage(ctx) {
  const { reason, tabB } = ctx.col;
  await showTab(ctx, tabB);
  await openMemoryPage(ctx.page);
  await memScope(ctx.page, 'project');
  await memSection(ctx.page, 'facts');
  const view = await waitMem(ctx.page, (now) => now.loadError !== null && now.enhanceStatus);
  await ctx.page.getByTestId('enhance-switch').click().catch(() => {});
  const after = await waitMem(ctx.page, (now) => now.enhanceError !== null, 10000);
  await shot(ctx, args, 'collision-page');
  record('MEM-06 the Memory page for a\\b: Project → Facts shows “Couldn’t load memory: <reason>”, the '
    + 'enhancement status line “Couldn’t read the enhancement settings: <reason>”, and turning enhancement on '
    + 'shows “Couldn’t change enhancement: <reason>” with the switch back off',
  view.loadError === `Couldn’t load memory: ${reason}`
    && view.enhanceStatus === `Couldn’t read the enhancement settings: ${reason}`
    && after.enhanceError === `Couldn’t change enhancement: ${reason}` && after.switchChecked === 'false'
    && !existsSync(join(ctx.col.base, 'enhance.json')),
  brief({ loadError: view.loadError, status: view.enhanceStatus, error: after.enhanceError,
    checked: after.switchChecked }));
  await backToApp(ctx.page);
}

/** @brief 在 tab 所在的项目新开一个会话发 text，返回这次请求的 system（记录代理收到的）。 */
async function newSessionSystem(ctx, tab, text) {
  await showTab(ctx, tab);
  const fresh = await newSession(ctx);
  const since = Date.now();
  await turn(ctx, fresh, text);
  const request = scenarioRequests(ctx.ep, null, { since })
    .find((item) => item.messages.some((m) => m.role === 'user' && contentText(m.content).includes(text)));
  return request?.system ?? null;
}

/** @brief MEM-06：新会话的 prompt：a-b 的有它自己的事实，a\b 的只有用户级（没有 a-b 的条目），后台进程记错误日志。 */
async function collisionPrompts(ctx) {
  const systemA = await newSessionSystem(ctx, ctx.col.tabA, 'plain collision prompt A');
  const systemB = await newSessionSystem(ctx, ctx.col.tabB, 'plain collision prompt B');
  const userFact = `- ${SEEDED.both.abstract}`;
  const ownerFact = `- ${OWNER_CALL.abstract}`;
  const logged = appLogLines(ctx, `Sessions in ${ctx.colB} get user-level memory only`);
  record('MEM-06 a new session in a-b has a-b’s fact in its system prompt; a new session in the colliding a\\b gets '
    + 'only the user-level entries (no a-b entry) and the background process logs the collision',
  Boolean(systemA?.includes(ownerFact)) && Boolean(systemA?.includes(userFact)) && Boolean(systemB?.includes(userFact))
    && !systemB?.includes(ownerFact) && logged.length > 0,
  brief({ a: systemA?.includes(ownerFact), b: systemB?.includes(ownerFact), bUser: systemB?.includes(userFact),
    logged: logged.slice(0, 1) }));
}

// ---------- MEM-15 的准备：几个会话 ----------

/** 依据跳转用的会话（都在 p1，第一条消息是 plain，会话名取它） */
const JUMP_SESSIONS = {
  branch: ['plain MEM-15 branch one', 'plain MEM-15 branch two'], deleted: ['plain MEM-15 deleted session'],
  locked: ['plain MEM-15 locked session'], archived: ['plain MEM-15 archived session'],
  feedback: ['plain MEM-15 feedback session'], closed: ['plain MEM-15 closed session'],
};

/** @brief 在 p1 里建 JUMP_SESSIONS 的会话（之后 restart 一步读它们的文件、写依据）。 */
async function sessions(ctx) {
  ctx.jump = {};
  for (const [key, texts] of Object.entries(JUMP_SESSIONS)) {
    const session = await plainSession(ctx, texts[0]);
    for (const text of texts.slice(1)) await turn(ctx, session.tab, text);
    ctx.jump[key] = session;
  }
  record('MEM-15 setup: the sessions used by the jump checks were saved', Object.values(ctx.jump)
    .every((item) => item.sessionFile && existsSync(item.sessionFile)), brief(Object.keys(ctx.jump)));
}

// ---------- 重启：写依据与反馈（synthetic test setup） ----------

/** @brief 一个会话文件里第 n 条你的消息、第 n 条助手消息的条目 id。 */
function idsOf(file) {
  const lines = sessionLines(file);
  return { lines, users: userMessages(lines).map((item) => item.id),
    assistants: assistantMessages(lines).map((item) => item.id) };
}

/**
 * @brief 测试准备（synthetic test setup）：在 branch 会话末尾加一条你的消息，父条目是第一条助手回复——当前分支从那里
 *        分叉出去，第二条你的消息不在当前分支上了（§10.2 “条目不在当前分支”）。
 */
function forkBranch(ctx) {
  const { lines, users, assistants } = idsOf(ctx.jump.branch.sessionFile);
  const template = lines.find((entry) => entry.id === users[0]);
  const now = new Date();
  const id = createHash('sha1').update(String(now.getTime())).digest('hex').slice(0, 8);
  const fork = { ...template, id, parentId: assistants[0], timestamp: now.toISOString(),
    message: { ...template.message, content: [{ type: 'text', text: 'plain synthetic fork message' }],
      timestamp: now.getTime() } };
  appendFileSync(ctx.jump.branch.sessionFile, `${JSON.stringify(fork)}\n`);
  ctx.jump.branch.on = users[0];
  ctx.jump.branch.off = users[1];
}

/** @brief 测试准备（synthetic test setup）：三份反馈记录（回复、回复里的选区、文件里的选区），按 StoredFeedbackSchema。 */
function seedFeedback(ctx) {
  const dir = join(ctx.userData, 'feedback');
  mkdirSync(dir, { recursive: true });
  const target = ctx.jump.feedback;
  const reply = idsOf(target.sessionFile).assistants[0];
  const readme = readFileSync(join(ctx.p1, 'README.md'), 'utf8');
  const session = { file: target.sessionFile, cwd: ctx.p1, title: JUMP_SESSIONS.feedback[0] };
  const message = (scope) => ({ kind: 'message', sessionFile: target.sessionFile, entryId: reply, time: null, scope });
  const records = {
    reply: { quote: PLAIN_REPLY, source: message('reply') },
    selection: { quote: '只有文字的回复', source: message('selection') },
    file: { quote: readme.split('\n').slice(0, 2).join('\n'), source: { kind: 'file', path: join(ctx.p1, 'README.md'),
      sha256: createHash('sha256').update(readme).digest('hex'), startLine: 1, endLine: 2 } },
  };
  ctx.feedback = {};
  for (const [index, [key, item]] of Object.entries(records).entries()) {
    const name = `${TODAY}-09000${index}.json`;
    writeFileSync(join(dir, name), `${JSON.stringify({ expected: `synthetic: ${key} feedback for mem-app-tool`,
      ...item, session, createdAt: new Date().toISOString() }, null, 2)}\n`);
    ctx.feedback[key] = name;
  }
  ctx.feedback.removed = `${TODAY}-090009.json`;
}

/**
 * @brief 测试准备（synthetic test setup）：用户级 REVIEW 里每种跳转一条条目（只有一项依据），记忆页 User → REVIEW 里点。
 *        键 → 条目 slug 为 j-<键>。
 */
function jumpEntries(ctx) {
  const s1 = idsOf(ctx.s1.sessionFile);
  const intranetCall = ctx.s1.results[0];
  const withCall = assistantMessages(s1.lines).find((item) => item.calls.some((c) => c.id === intranetCall.toolCallId));
  const instance = ctx.s2?.instance;
  const first = (key) => idsOf(ctx.jump[key].sessionFile).users[0];
  const at = (key, entry) => ({ at: TODAY, session: ctx.jump[key].sessionFile, entry,
    title: JUMP_SESSIONS[key][0], quote: `synthetic: ${key}` });
  const s1At = (entry) => ({ at: TODAY, session: ctx.s1.sessionFile, entry, title: WARMUP, quote: 'synthetic: s1' });
  const fb = (key) => ({ at: TODAY, feedback: ctx.feedback[key], quote: `synthetic: ${key} feedback` });
  const never = join(ctx.userData, 'pi', 'sessions', 'synthetic-gone', '2020-01-01T00-00-00-000Z_synthetic.jsonl');
  return {
    never: { at: TODAY, session: never, entry: 'abcd1234', title: 'Synthetic gone session', quote: 'synthetic' },
    team: { at: TODAY, session: instance?.file ?? 'missing', entry: instance?.entries?.[0]?.id ?? null,
      title: 'Synthetic team task', quote: 'synthetic: team' },
    closed: at('closed', first('closed')), null: at('feedback', null), assistant: s1At(withCall?.id ?? null),
    toolresult: s1At(intranetCall?.id ?? null), archived: at('archived', first('archived')),
    offbranch: at('branch', ctx.jump.branch.off), missing: at('branch', 'deadbeef'),
    deleted: at('deleted', first('deleted')), locked: at('locked', first('locked')),
    fbreply: fb('reply'), fbselection: fb('selection'), fbfile: fb('file'), fbremoved: fb('removed'),
    cancel: at('branch', ctx.jump.branch.on),
  };
}

/** @brief 关掉 App，写好分叉、反馈与跳转用的条目，再用同一个数据目录启动。 */
async function restart(ctx) {
  await closeTbApp(ctx);
  forkBranch(ctx);
  seedFeedback(ctx);
  ctx.j = jumpEntries(ctx);
  const user = memBase(ctx.userData, null);
  for (const [key, item] of Object.entries(ctx.j)) {
    seedEntry(user, { kind: 'review', slug: `j-${key}`, abstract: `Synthetic jump check ${key}`, evidence: [item],
      details: 'Synthetic entry for the MEM-15 jump checks.' });
  }
  seedFormats(ctx);
  await startTbApp(ctx);
  await ctx.page.locator(`.session-item[data-file=${JSON.stringify(ctx.s1.sessionFile)}]`)
    .waitFor({ timeout: 30000 });
  ctx.panesAfterRestart = await paneTotal(ctx);
  record('MEM-15 setup: after the restart the sessions are listed and none is open', ctx.panesAfterRestart === 0,
    brief({ panes: ctx.panesAfterRestart }));
}

// ---------- MEM-10：重新打开的会话 ----------

/** @brief MEM-10：重启后从侧栏重新打开 S1，完成的卡仍有 View in Memory（不显示耗时），失败的没有；按钮照常打开。 */
async function reopen(ctx) {
  const tab = await reopenSession(ctx, ctx.s1.sessionFile);
  ctx.s1.tab = tab;
  const cards = await cardsOf(ctx.page, tab);
  const bad = CALLS.flatMap((call, index) => {
    const card = cards[index] ?? {};
    const ok = call.error ? card.status === 'failed' && !card.view
      : card.status === 'done' && card.view && card.statusText === 'Done';
    return ok ? [] : [{ key: call.key, card }];
  });
  record('MEM-10 after a restart the reopened session still shows View in Memory on every finished memory card '
    + '(status “Done” without a duration, read from the session file’s details) and none on the failed cards',
  cards.length === CALLS.length && bad.length === 0, brief({ count: cards.length, bad }));
  const revision = resultOf(ctx, 'forget')?.details?.revision;
  const forget = await viewFromCard(ctx, 4, (now) => now.section === 'revisions'
    && now.revisions.some((row) => row.id === revision && row.pressed) && now.revisionTitle !== null);
  const fact = await viewFromCard(ctx, 0, (now) => landedOn(now, VIEW_CASES.intranet));
  record('MEM-10 in the reopened session View in Memory still opens the forget card’s revision in Revisions and '
    + 'the saved fact in Project → Facts', forget.view.revisions.some((row) => row.id === revision && row.pressed)
    && forget.view.revisionTitle !== null && landedOn(fact.view, VIEW_CASES.intranet),
  brief({ forget: forget.view.revisionTitle, fact: fact.view.entryTitle }));
}

// ---------- MEM-15：依据回到原位置 ----------

/** @brief 进记忆页 User → REVIEW，选中 j-<key>，返回 { panes, view }（点之前）。 */
async function selectJump(ctx, key) {
  if (!(await ctx.page.getByTestId('memory-page').count())) await openMemoryPage(ctx.page);
  await memScope(ctx.page, 'user');
  await memSection(ctx.page, 'review');
  await memSelect(ctx.page, `j-${key}`);
  return { panes: await paneTotal(ctx), view: await memView(ctx.page) };
}

/**
 * @brief 点 j-<key> 的 Jump to source，等它有结果：离开了记忆页（left），或留在记忆页、按钮不再是 Opening…
 * @param opts { flash：离开后等对话流里的高亮（.jump-flash，默认要等；选区的高亮是 CSS highlight，不等） }
 * @return { left, view（留在记忆页时）, active, panes, flashed }
 */
async function runJump(ctx, key, { flash = true } = {}) {
  const before = await selectJump(ctx, key);
  const jump = await clickJump(ctx, flash);
  return { before: { panes: before.panes }, ...jump, active: await activeFile(ctx.page), panes: await paneTotal(ctx) };
}

/**
 * @brief 点记忆页右栏第一个 Jump to source，等它有结果：离开了记忆页（left），或留在记忆页、按钮不再是 Opening…
 *        且有状态行；离开后 flash 为真时等对话流里的高亮。
 * @return { left, view（留在记忆页时的 { evidence }）, flashed }
 */
async function clickJump(ctx, flash = true) {
  await jumpButton(ctx.page).click();
  let view = null;
  const left = await poll(async () => {
    view = await memView(ctx.page);
    if (!view.page) return 'left';
    const item = view.evidence[0];
    return item && item.jump !== 'Opening…' && item.status ? 'stayed' : null;
  }, 15000, 100) === 'left';
  const flashed = left && flash ? await waitFlash(ctx.page, 5000) : [];
  return { left, view: left ? null : { evidence: view.evidence }, flashed };
}

/** @brief 回到记忆页（左栏 Memory），读 j-<key> 那一项依据的状态行。 */
async function jumpStatus(ctx, key) {
  const { view } = await selectJump(ctx, key);
  return view.evidence[0] ?? null;
}

/** @brief §10.2 第一行能跳过去的几种：没开着的会话、开着而不在焦点的会话、助手回复与工具结果里的条目、已归档的会话。 */
async function jumpsOpen(ctx) {
  const closed = await runJump(ctx, 'closed');
  record('MEM-15 §10.2 row 1, session not open: Jump to source opens it (one more pane), shows it and highlights the '
    + 'user message of the evidence entry', closed.left && closed.active === ctx.jump.closed.sessionFile
    && closed.panes === closed.before.panes + 1 && turnsOf(closed.flashed).length === 1
    && turnsOf(closed.flashed)[0].item === 'user' && turnsOf(closed.flashed)[0].text.includes(JUMP_SESSIONS.closed[0]),
  brief(closed));
  const assistant = await runJump(ctx, 'assistant');
  // 高亮的元素：对话流的那一项（data-item）与它里面带同一个 data-item-key 的元素，按项算只有一项
  const items = (result) => turnsOf(result.flashed);
  const isCallTurn = (result) => result.left && result.active === ctx.s1.sessionFile && items(result).length === 1
    && items(result)[0].item === 'assistant' && items(result)[0].text.includes(CALLS[0].args.abstract);
  record('MEM-15 §10.2 row 1, entry is an assistant message with a tool call in an open session that is not '
    + 'focused: Jump to source shows that session and highlights that reply (with the memory card in it)',
  isCallTurn(assistant), brief(assistant));
  const result = await runJump(ctx, 'toolresult');
  record('MEM-15 §10.2 row 1, entry is a tool result: Jump to source highlights the reply that holds the tool call',
    isCallTurn(result), brief(result));
  await archiveThenJump(ctx);
}

/** @brief 已归档的会话：在侧栏归档它，再 Jump to source：先恢复（不在已归档里）再打开并高亮。 */
async function archiveThenJump(ctx) {
  const file = ctx.jump.archived.sessionFile;
  const archivedNow = async () => (await savedArchived(ctx.page))
    .some((item) => String(item).toLowerCase() === file.toLowerCase());
  if (await ctx.page.getByTestId('memory-page').count()) await backToApp(ctx.page);
  await chooseMenuItem(ctx.page, file, 'Archive');
  const archived = await poll(archivedNow, 5000);
  const jump = await runJump(ctx, 'archived');
  const after = await archivedNow();
  record('MEM-15 §10.2 row 1, archived session: Jump to source restores it first (no longer archived), opens it and '
    + 'highlights the user message', Boolean(archived) && !after && jump.left && jump.active === file
    && turnsOf(jump.flashed).length === 1 && turnsOf(jump.flashed)[0].item === 'user',
  brief({ archived, after, jump }));
}

/** @brief §10.2 第一行跳不过去的几种：会话已删除（列表里没有、文件被删）、条目不在当前分支、读会话文件出别的错。 */
async function jumpsBlocked(ctx) {
  const never = (await selectJump(ctx, 'never')).view.evidence[0] ?? {};
  record('MEM-15 §10.2 row 1, session deleted (not in the loaded session list): before any click the status says '
    + '“Session deleted” and Jump to source is disabled', never.status === JUMP.deleted && never.disabled === true,
  brief(never));
  for (const key of ['offbranch', 'missing']) {
    const jump = await runJump(ctx, key);
    const what = key === 'offbranch' ? 'a message on a branch the session forked away from'
      : 'an id the file does not have';
    record(`MEM-15 §10.2 row 1, entry not on the current branch (${what}): Jump to source stays on the Memory page, `
      + 'opens nothing and says “This message is no longer in the session.”', !jump.left
      && jump.view.evidence[0]?.status === JUMP.gone && jump.panes === jump.before.panes, brief(jump));
  }
  rmSync(ctx.jump.deleted.sessionFile);
  const deleted = await runJump(ctx, 'deleted');
  record('MEM-15 §10.2 row 1, session file deleted while it is still in the list: Jump to source finds out when '
    + 'reading it, says “Session deleted”, disables the button and opens nothing', !deleted.left
    && deleted.view.evidence[0]?.status === JUMP.deleted && deleted.view.evidence[0]?.disabled === true
    && deleted.panes === deleted.before.panes, brief(deleted));
  const release = lockFile(ctx.jump.locked.sessionFile);
  let locked;
  try {
    locked = await runJump(ctx, 'locked');
  } finally {
    release();
  }
  const status = locked.view?.evidence[0]?.status ?? '';
  record('MEM-15 §10.2 row 1, reading the session file fails for another reason (the file is locked): Jump to source '
    + 'stays on the Memory page and shows the error text', !locked.left && status !== '' && status !== JUMP.deleted
    && status !== JUMP.gone && locked.panes === locked.before.panes, brief(locked));
}

/** @brief §10.2 第二、三、四行：TaskBoard 实例会话、反馈（三种跳法与文件已不在）、entry 为 null。 */
async function jumpsOther(ctx) {
  const team = (await selectJump(ctx, 'team')).view.evidence[0] ?? {};
  record('MEM-15 §10.2 row 2: evidence in a TaskBoard instance session (<userData>\\teams\\<id>\\sessions\\…) says '
    + '“This is a background agent’s session, which can’t be opened.” and Jump to source is disabled',
  team.status === JUMP.team && team.disabled === true && ctx.j.team.session.includes('\\teams\\'), brief(team));
  await jumpNull(ctx);
  const reply = await runJump(ctx, 'fbreply');
  record('MEM-15 §10.2 row 3, feedback on a whole reply: Jump to source opens the feedback’s session and highlights '
    + 'the reply', reply.left && reply.active === ctx.jump.feedback.sessionFile && reply.flashed.length > 0
    && reply.flashed.some((item) => item.text.includes(PLAIN_REPLY)), brief(reply));
  await jumpSelection(ctx);
  const file = await runJump(ctx, 'fbfile');
  await waitViewer(ctx.page).catch(() => {});
  const viewer = await viewerState(ctx.page);
  record('MEM-15 §10.2 row 3, feedback on lines of a file: Jump to source opens the session and the file viewer at '
    + 'README.md with lines 1–2 marked', file.left && file.active === ctx.jump.feedback.sessionFile
    && viewer?.path === 'README.md' && same(viewer?.target, [1, 2]), brief({ file, viewer }));
  const removed = await runJump(ctx, 'fbremoved');
  record('MEM-15 §10.2 row 3, the feedback file is gone: Jump to source stays and says “The feedback file was '
    + 'removed.”', !removed.left && removed.view.evidence[0]?.status === JUMP.removed, brief(removed));
}

/** @brief §10.2 第四行：entry 为 null（会话没开着）：打开会话、不定位，回到记忆页时状态行写那一句。 */
async function jumpNull(ctx) {
  const none = await runJump(ctx, 'null');
  await sleep(1000);
  const flashed = await flashedItems(ctx.page);
  const status = await jumpStatus(ctx, 'null');
  record('MEM-15 §10.2 row 4, entry null and the session not open: Jump to source opens the session (one more pane) '
    + 'without positioning (no highlight) and the Memory page’s status line says “Opened the session; the exact '
    + 'message wasn’t recorded.”', none.left && none.active === ctx.jump.feedback.sessionFile
    && none.panes === none.before.panes + 1 && flashed.length === 0 && status?.status === JUMP.notRecorded,
  brief({ none, flashed, status }));
}

/** @brief 反馈在回复里的选区：Jump to source 高亮引用的那段文字。 */
async function jumpSelection(ctx) {
  const jump = await runJump(ctx, 'fbselection', { flash: false });
  const lit = await poll(async () => {
    const now = await jumpHighlight(ctx.page);
    return now.text ? now : null;
  }, 10000, 50);
  record('MEM-15 §10.2 row 3, feedback on a selection in a reply: Jump to source opens the session and highlights '
    + 'the quoted text', jump.left && jump.active === ctx.jump.feedback.sessionFile && lit?.text === '只有文字的回复',
  brief({ jump, lit }));
}

/**
 * @brief MEM-15（2026-10-26 走查 M18，docs/v0/screens/chat.md"步骤组"）：依据落在一条回复上、回复里的 memory 卡折在步骤组里
 *        时，Jump to source 先展开那一组再滚动、高亮，卡看得见。先在 S1 里把那一组折回（之前的 View in Memory 展开过它）。
 */
async function jumpFolded(ctx) {
  const { page } = ctx;
  await showTab(ctx, ctx.s1.tab);
  const pane = paneSel(ctx.s1.tab);
  const card = page.locator(`${pane} [data-testid="tool-card"]`).first();
  const group = await card.evaluate((element) => element.closest('[data-step-group]')?.dataset.stepGroup ?? '');
  const row = page.locator(`${pane} [data-testid="step-group"][data-group="${group}"]`);
  if (await row.getAttribute('aria-expanded') === 'true') await row.click();
  const before = { group, expanded: await row.getAttribute('aria-expanded'), card: await card.isVisible() };
  const jump = await runJump(ctx, 'assistant');
  const after = { expanded: await row.getAttribute('aria-expanded'), card: await card.isVisible() };
  record('MEM-15 §10.2 row 1, the reply that holds the memory call has its steps folded into "1 step" (chat.md step '
    + 'groups): Jump to source first expands that group, then scrolls and highlights the reply, so the memory card '
    + 'shows', before.expanded === 'false' && !before.card && jump.left && after.expanded === 'true' && after.card
    && turnsOf(jump.flashed).length === 1, brief({ before, after, flashed: jump.flashed }));
}

/** @brief §10.2 的每一行。 */
async function jumps(ctx) {
  await jumpsOpen(ctx);
  await jumpFolded(ctx);
  await jumpsBlocked(ctx);
  await jumpsOther(ctx);
}

// ---------- MEM-15：跳转未完成时离开 ----------

/**
 * @brief 在同一个任务里点 Jump to source 再马上离开记忆页（leave 在页面里同步执行），等后台的检查回来；
 *        返回离开后的 { active, panes, flashed, open（目标会话有没有打开） }。
 */
async function leaveMidJump(ctx, key, leave) {
  const before = await selectJump(ctx, key);
  await ctx.page.evaluate((how) => {
    document.querySelector('[data-testid="memory-detail"] [data-testid="memory-jump"]').click();
    if (how.kind === 'back') {
      [...document.querySelectorAll('[data-testid="memory-page"] button')]
        .find((button) => button.textContent.includes('Back to app')).click();
    } else document.querySelector(`.session-item[data-file=${JSON.stringify(how.file)}]`).click();
  }, leave);
  await sleep(2500);
  return { before: before.panes, page: await ctx.page.getByTestId('memory-page').count(),
    active: await activeFile(ctx.page), panes: await paneTotal(ctx), flashed: await flashedItems(ctx.page) };
}

/** @brief MEM-15：跳转未完成时离开记忆页（Back to app、点侧栏的另一个会话）：不切到那个会话、不新开、回来时没有状态。 */
async function cancel(ctx) {
  await backToAppIfOpen(ctx);
  await showTab(ctx, ctx.s1.tab);
  const back = await leaveMidJump(ctx, 'cancel', { kind: 'back' });
  const statusBack = await jumpStatus(ctx, 'cancel');
  record('MEM-15 leaving the Memory page with Back to app while Jump to source is still checking cancels the jump: '
    + 'the app stays on the session it was on (S1), the target session is not opened, nothing is highlighted, and '
    + 'back on the Memory page the evidence has no status', back.page === 0 && back.active === ctx.s1.sessionFile
    && back.panes === back.before && back.flashed.length === 0 && statusBack?.status === null
    && statusBack?.jump === 'Jump to source', brief({ back, statusBack }));
  const side = ctx.jump.closed.sessionFile;
  const viaSidebar = await leaveMidJump(ctx, 'cancel', { kind: 'sidebar', file: side });
  const statusSide = await jumpStatus(ctx, 'cancel');
  record('MEM-15 leaving the Memory page through the sidebar (another session) while Jump to source is checking '
    + 'cancels the jump: the clicked session is shown, not the evidence’s, nothing is highlighted and no status '
    + 'is left', viaSidebar.page === 0 && viaSidebar.active === side && viaSidebar.panes === viaSidebar.before
    && viaSidebar.flashed.length === 0 && statusSide?.status === null, brief({ viaSidebar, statusSide }));
  const control = await runJump(ctx, 'cancel');
  record('MEM-15 control for the two checks above: the same evidence, left alone, opens its session and highlights '
    + 'the message (so the cancelled jumps did start)', control.left
    && control.active === ctx.jump.branch.sessionFile && turnsOf(control.flashed).length === 1, brief(control));
  await backToAppIfOpen(ctx);
}

// ---------- MEM-06：手改的文件、读不出来的条目、[[slug]] ----------

/** 用户级 STRATEGY 里格式检查用的条目（synthetic） */
const FORMAT = { target: 'Synthetic link target strategy', link: 'Synthetic strategy with a link',
  detail: 'Abstract from the detail file', index: 'Hand-edited index text' };

/**
 * @brief 测试准备（synthetic test setup）：用户级 STRATEGY 里一条被链接的条目、一条正文里有 [[strat-target]] 的条目、
 *        一条索引里的文字被手改过（与 detail 不同）的条目，再加两行读不出来的：文件不存在、文件没有 frontmatter。
 */
function seedFormats(ctx) {
  const user = memBase(ctx.userData, null);
  seedEntry(user, { kind: 'strategy', slug: 'strat-target', abstract: FORMAT.target, details: 'Synthetic target.' });
  seedEntry(user, { kind: 'strategy', slug: 'strat-link', abstract: FORMAT.link,
    details: 'Synthetic: see [[strat-target]] before planning.' });
  seedEntry(user, { kind: 'strategy', slug: 'strat-mismatch', abstract: FORMAT.detail, details: 'Synthetic.' });
  const index = join(user, 'STRATEGY.md');
  const text = readFileSync(index, 'utf8').replace(`- [${FORMAT.detail}](`, `- [${FORMAT.index}](`);
  writeFileSync(index, `${text}- [Synthetic missing entry](entries/strat-missing.md)\n`
    + '- [Synthetic entry without frontmatter](entries/strat-nofront.md)\n');
  writeFileSync(detailPath(user, 'strat-nofront'), 'Synthetic text without frontmatter\n');
}

/**
 * @brief MEM-06：记忆页读手改过的文件：索引与 detail 不同时显示 detail 的 abstract，下一次写这一种时按 detail 重写索引；
 *        读不出来的条目列为一行原因、不能选中；[[slug]] 显示成链接，点了打开那一条。
 */
async function formats(ctx) {
  await openMemoryPage(ctx.page);
  await memScope(ctx.page, 'user');
  await memSection(ctx.page, 'strategy');
  const list = await memView(ctx.page);
  record('MEM-06 a hand-edited index whose text differs from the detail shows the detail’s abstract; unreadable '
    + 'entries (file missing, no frontmatter) are listed as “Couldn’t read the entry <file>” with the reason and '
    + 'cannot be selected', same(list.rows.map((row) => row.title), [FORMAT.target, FORMAT.link, FORMAT.detail])
    && same(list.broken.map((row) => row.title), ['Couldn’t read the entry strat-missing.md',
      'Couldn’t read the entry strat-nofront.md'])
    && list.broken[0]?.error === 'The entry file doesn’t exist.'
    && list.broken[1]?.error === 'The file has no frontmatter.', brief({ rows: list.rows, broken: list.broken }));
  await memSelect(ctx.page, 'strat-link');
  const linked = await waitMem(ctx.page, (now) => now.links.length > 0);
  await ctx.page.locator('[data-testid="memory-detail"] .memory-details .memory-link').first().click();
  const opened = await waitMem(ctx.page, (now) => now.entryTitle === FORMAT.target);
  record('MEM-06 [[slug]] in Details is shown as a link with the linked entry’s abstract and opens that entry',
    same(linked.links, [FORMAT.target]) && opened.entryTitle === FORMAT.target
    && opened.rows.some((row) => row.id === 'strat-target' && row.pressed), brief({ links: linked.links,
      opened: opened.entryTitle }));
  const user = memBase(ctx.userData, null);
  const write = await bridge(ctx, { type: 'memory.save', cwd: null, layer: 'user', kind: 'strategy',
    abstract: 'Synthetic page write', detail: '' });
  const index = readIndex(user, 'strategy');
  record('MEM-06 the next write to that kind rewrites the hand-edited index line from the detail’s abstract and keeps '
    + 'the unreadable lines', write.error === null
    && index.some((item) => item.slug === 'strat-mismatch' && item.abstract === FORMAT.detail)
    && !index.some((item) => item.abstract === FORMAT.index)
    && ['strat-missing', 'strat-nofront'].every((slug) => index.some((item) => item.slug === slug)),
  brief({ write, index }));
  await backToApp(ctx.page);
}

/** @brief 在记忆页时点 Back to app。 */
async function backToAppIfOpen(ctx) {
  if (await ctx.page.getByTestId('memory-page').count()) await backToApp(ctx.page);
}

// ---------- MEM-15：会话列表还没读好 ----------

/** 垫底文件的个数：pi 的 listAll 要逐个打开它们，这台机器上约 10 秒（量过），足够在列表读好之前点 Jump to source */
const PADDING = 20000;
/** §10.2 第一行（同 M7）：会话列表还没读好、原会话也没打开时的说明 */
const LIST_LOADING = 'Sessions are still loading. Try again in a moment.';

/**
 * @brief 测试准备（synthetic test setup）：会话目录里另建一个文件夹，放 PADDING 个第一行不是会话头的 .jsonl（pi 只读第一行
 *        就跳过它们，不进会话列表），让重启后的会话列表要读一阵子。
 */
function seedPadding(ctx) {
  const dir = join(ctx.userData, 'pi', 'sessions', '--synthetic-padding--');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PADDING; i += 1) writeFileSync(join(dir, `pad-${i}.jsonl`), '{"type":"synthetic-padding"}\n');
  return dir;
}

/**
 * @brief MEM-15：重启后会话列表还在读、原会话也没打开时 Jump to source 留在记忆页，说
 *        “Sessions are still loading. Try again in a moment.”；列表读好之后再点，说明清掉、跳过去。
 */
async function listLoading(ctx) {
  await closeTbApp(ctx);
  const padding = seedPadding(ctx);
  try {
    await startTbApp(ctx);
    await openMemoryPage(ctx.page);
    await poll(async () => !(await ctx.page.getByTestId('memory-scope-user').isDisabled()), 30000, 100);
    const early = await runJump(ctx, 'closed');
    const listed = await ctx.page.locator('.session-item').count();
    await ctx.page.locator(`.session-item[data-file=${JSON.stringify(ctx.jump.closed.sessionFile)}]`)
      .waitFor({ timeout: 120000 });
    const again = await runJump(ctx, 'closed');
    record('MEM-15 §10.2 row 1, session list still loading after a restart and the session not open: Jump to source '
      + 'stays on the Memory page and says “Sessions are still loading. Try again in a moment.”; once the list is '
      + 'loaded, clicking again clears it and opens the session', !early.left && listed === 0
      && early.view.evidence[0]?.status === LIST_LOADING && again.left
      && again.active === ctx.jump.closed.sessionFile, brief({ early, listed, again }));
  } finally {
    rmSync(padding, { recursive: true, force: true });
  }
}

// ---------- 主流程 ----------

const steps = { chat, view, evidence, live, split, collision, sessions, restart, reopen, jumps, cancel, formats,
  listLoading };

const ctx = { userData: mkdtempSync(join(tmpdir(), 'mori-memtool-data-')), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[mem-app-tool] step ${name}`);
    try {
      await backToAppIfOpen(ctx).catch(() => {});
      await step(ctx);
    } catch (error) {
      record(`${name}: mem-app-tool step`, false, errorLine(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[mem-app-tool] data in ${ctx.userData}`);
finish();
