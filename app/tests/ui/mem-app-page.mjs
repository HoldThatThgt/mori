// 提示词分层与记忆的 App 套件：记忆页（docs/specs/memory.md §14.2；状态表 docs/v1/screens/memory-page.md、memory-chat.md、
// settings-issues.md）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（关键词模式与增强脚本，tests/fake-endpoint/，
// synthetic），逐条验收这些编号在 App 层的通过条件：
//   MEM-14 记忆页：入口在 Review 原来的位置；层跟随焦点会话的项目（分屏换焦点、没有会话时不可用）、换项目后回到那个项目
//          上次看的分节；六个分节；↑↓；No entries yet.；用量与 Last change；新增、编辑、删除（确认框）、提升、放回；
//          编辑 Learned 后标 You said；表单的三句不发命令；离开确认框；详情的各块与反向链接；mori.memory_changed 的刷新
//          （列表与滚动位置保留、编辑中不重读、条目被删后详情关闭），运行结束后 Revisions 的 Running 变为结束状态；
//          跟随的会话还在打开时 Project 保留已有列表、New entry 等它，User 照常读、New entry 可用；
//   MEM-16 AGENT 与 Customize 的 AGENTS.md 一节（2026-10-26 从设置页挪来）的 token、合计与超出说明（2,000），
//          Edit in Customize，agents.get 的新字段；
//   MEM-07 预算的 App 部分：用量（含中日韩字符）、恰好 500 允许、501 拒绝且什么都没写、写用户级超出某个项目、移动与回滚
//          同样检查、删除不受限、手改超出时 Over the limit 且全部进 prompt；
//   MEM-08 修订记录的 App 部分：记忆页一次保存、删除、移动、回滚各一条，移动写进两层，kinds、counts，列表时间倒序且最多
//          200 条，详情有每处改动的前后原文与依据或说明，固定的 Revisions 行与 Note:，~~~~ 行，Running / Failed /
//          Rollback 标记与 No changes，增强运行的 Day 一行，增强写入进行中在记忆页保存按调用顺序写入；
//   MEM-09 回滚的 App 部分：新增、删除（加在末尾）、修改（原文与 source）、提升与放回（回到原层末尾、同名加后缀、
//          source 恢复、写进两层、可以再回滚），之后又被改过时整次拒绝并写出那次修订，超出预算拒绝，Rollback 修订可以
//          再回滚，运行中的不能回滚，水位不动；
//   MEM-33 后台进程退出时：入口、页面操作、View in Memory、提示的 View 不可用（同样的悬停），只有已有的全局横幅，
//          开着的删除确认框关闭（Restart 后不自己再打开），Restart 后重读，反馈说明按没开。
// 用法（在 app/ 下，out/ 已是当前构建）：node tests/ui/mem-app-page.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/mem-app-page(-packaged).json（--only 时 mem-partial-app-page…，不计入覆盖检查），截图与 App 日志在
// test-results/mem-app-page/。步骤按顺序依赖前面的状态，--only 只用于调试。
// 端口（§14.1 的 4700–4799 里分给本套件的 4720–4729）：合成端点 4720，记录代理 4721（看请求的 system）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商（跳过探针）；用户级与三个临时项目的记忆文件、
// AGENTS.md、修订记录、enhance.json 按 §3、§9.1 的格式由测试写好；增强脚本文件由测试在运行前写好；第四个临时项目
// 带一个加载要等 10 秒的项目扩展（让会话停在“正在启动…”）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { appRoot, arg } from './lib.mjs';
import { feedbackNote } from './m4-helpers.mjs';
import {
  AGENTS_LIMIT, AGENTS_OVER, CRASHED, FEEDBACK_OFF, FEEDBACK_ON, LEAVE_TEXT, LEAVE_TITLE, NO_PROJECT_HOVER, SECTIONS,
  abstractsFor, addDays, asciiText, backToApp, chooseScope, chooseSection, dayOf, deleteOpenEntry, detailState,
  detailText, enhanceJson, estimate, evidenceLine, fillForm, goMemory, hhmm, indexSlugs, layerDir, layerSnapshot,
  localDate, localIso, memoryState, monthDay, monthDayTime, moveOpenEntry, newEntry, openMemoryPage, readText,
  revisionField, revisionFiles, revisionIdAt, revisionRowId, rollbackOpenRevision, saveForm, seedEnhance, seedKind,
  seedProject, seedRevision, selectRevisionRow, selectRow, thousands, usageOf, waitDetail, waitLoaded, waitRow, watched,
  watchList,
} from './mem-page-helpers.mjs';
import {
  bridge, brief, closeTbApp, killTbKernel, openProject, paneSel, poll, readJsonl, scenarioRequests, seedTeamUserData,
  sendMessage, shot, showTab, sleep, startTbApp, startTbEndpoint, stopTbEndpoint, tbModel, tbProvider, tbRecorder,
  tempProject, tempUserData, toolCardsOf, userSession,
} from './tb-helpers.mjs';
import { eventsOf, paneCounts, waitTabBusy, waitTabIdle } from './v1-switch-helpers.mjs';

/** @brief 命令行：--exe、--only；结果文件名按 §14.3（--only 时 mem-partial-，不计入覆盖检查）。 */
function memArgs() {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const shots = join(appRoot, `test-results/mem-app-page${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite: 'mem-app-page', exePath, only, shots,
    file: only ? `mem-partial-app-page${packaged}.json` : `mem-app-page${packaged}.json` };
}

const args = memArgs();
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4720;
const PROXY = 4721;
/** 合成端点上的提供商与模型（synthetic） */
const PROVIDER = 'memp';
const MODEL = 'fake-coder-mempage';
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
/** @brief 现在的本地日期写法（修改日期、History 行用当天）。 */
const today = () => monthDay(localDate(Date.now()));

// ---------- 测试数据（synthetic test setup） ----------

/** AGENTS.md：用户级（含中日韩字符）、项目 A（超过 2,000 token，2026-10-26 提醒线由 500 改为 2000）、项目 B（1 token） */
const USER_AGENTS = '# User rules\n\nAnswer in English. 注释用中文。\n';
const P1_AGENTS = `# Project A\n\n${'Keep functions short and name them clearly. '.repeat(190)}\n项目说明。\n`;
const P2_AGENTS = 'abc';
/** 条目的 abstract */
const DEPLOY = 'The staging server is at 10.0.0.9';
const CI = 'CI runs every night at 02:00';
const CI_DETAILS = 'Nightly CI.\n\n~~~~\n\nThe line above is four tildes.';
const MOVE_A = 'Builds run on the shared runner';
const SHARED = 'Shared name entry';
/** 它的 slug（§6.2：abstract 的 ASCII 单词小写、- 连接），新建同名条目时得到同样的 slug */
const SHARED_SLUG = 'shared-name-entry';
const ANSWER = 'Give the conclusion first';
const PLAIN = 'Use plain words';
const ASK_BEFORE = 'Ask before renaming files';
const REVIEW_ENTRY = 'Check the logs before saying done';
const OTHER_WRITER = 'Added by another writer';
const RUN_ENTRY = 'Answer in two short paragraphs';
const DURING_RUN = 'Page entry saved during the run';
const P2_FACT = 'P2 deploys from the main branch';
const TOOL_FACT = 'P2 builds with make';
/** 用户级与项目的 STRATEGY（合计 254 + 203 = 457 token）、项目 B 超出的 TASTE、项目 C 的 REVIEW（499 token） */
const USER_STRATEGY = abstractsFor('User strategy', 254);
const P1_STRATEGY = abstractsFor('Project strategy', 203);
const P2_TASTE = abstractsFor('Project B taste', 600);
const P3_REVIEW = abstractsFor('Other project review', 499);

/** @brief 用户级的 Facts（含中日韩字符的一条）。 */
const userFacts = () => [
  { slug: 'user-cjk-fact', abstract: '用户喜欢简短的回答，先给结论', source: 'user', created: '2026-10-18 · You',
    modified: '2026-10-18 · You' },
  { slug: SHARED_SLUG, abstract: SHARED, source: 'learned', created: '2026-10-18 · Enhancement',
    modified: '2026-10-18 · Enhancement', details: 'Seeded at the user level.' },
];

/** @brief 项目 A 的 Facts（索引顺序）：详情的各块、链接、~~~~ 行、要提升的一条、读不出来的一条、30 条填充。 */
function p1Facts(ctx) {
  const learned = { source: 'learned', created: '2026-10-19 · Enhancement', modified: '2026-10-19 · Enhancement' };
  return [
    { slug: 'deploy-target', abstract: DEPLOY, source: 'user', created: '2026-10-20 · Mori',
      modified: '2026-10-21 · You', details: 'Deploys go through [[ci-runs-nightly]].\n\nSee also [[no-such-entry]].',
      evidence: [{ at: '2026-10-20', session: join(ctx.p1, 'gone', 'deploy-notes.jsonl'), entry: 'a1b2c3d4',
        title: 'Deploy notes', quote: 'the staging server is at 10.0.0.9, note it' },
      { at: '2026-10-21', feedback: '2026-10-21-101500.json', quote: 'Tell me where it deploys first' }],
      history: ['Oct 21 · You: Edited on the Memory page'] },
    { slug: 'ci-runs-nightly', abstract: CI, details: CI_DETAILS, ...learned },
    { slug: 'fact-move-a', abstract: MOVE_A, details: 'Seeded in project A.', ...learned },
    { slug: 'broken-entry', abstract: 'Broken entry', text: 'This file lost its frontmatter.\n' },
    ...Array.from({ length: 30 }, (_, index) => ({ slug: `fact-${String(index + 1).padStart(2, '0')}`,
      abstract: `Filler fact ${String(index + 1).padStart(2, '0')} about the layout`,
      source: index % 2 ? 'learned' : 'user', created: '2026-10-18 · You', modified: '2026-10-18 · You' })),
  ];
}

/** @brief 测试准备（synthetic）：用户级的记忆。 */
function seedUser(ctx) {
  const base = layerDir(ctx.userData, null);
  seedKind(base, 'fact', userFacts());
  seedKind(base, 'strategy', USER_STRATEGY.map((abstract, index) => ({ slug: `user-strategy-${index + 1}`, abstract,
    source: 'user', created: '2026-10-18 · You', modified: '2026-10-18 · You' })));
}

/** @brief 测试准备（synthetic）：项目 A 的记忆、改过 deploy-target 的一次修订、开着的 enhance.json。 */
function seedP1(ctx) {
  const base = seedProject(ctx.userData, ctx.p1);
  const facts = p1Facts(ctx);
  ctx.seeded = seedKind(base, 'fact', facts);
  Object.assign(ctx.seeded, seedKind(base, 'taste', [
    { slug: 'answer-first', abstract: ANSWER, source: 'learned', created: '2026-10-19 · Enhancement',
      modified: '2026-10-19 · Enhancement', details: 'Start every answer with the conclusion.' },
    { slug: 'reply-style', abstract: PLAIN, source: 'user', created: '2026-10-19 · You',
      modified: '2026-10-19 · You', details: 'Avoid jargon.' }]));
  seedKind(base, 'strategy', P1_STRATEGY.map((abstract, index) => ({ slug: `project-strategy-${index + 1}`, abstract,
    source: 'user', created: '2026-10-18 · You', modified: '2026-10-18 · You' })));
  const time = NOW - DAY;
  const before = detailText({ ...facts[0], kind: 'fact', details: 'Deploys go through CI.',
    modified: '2026-10-20 · Mori', history: [] });
  ctx.seededRevision = { id: revisionIdAt(time, 's001'), time,
    title: `You · Changed Facts: ${DEPLOY}` };
  seedRevision(base, { id: ctx.seededRevision.id, time: localIso(time), by: 'You', title: ctx.seededRevision.title,
    layers: ['project'], kinds: ['fact'], counts: { changed: 1 }, cwd: resolve(ctx.p1),
    changes: [{ head: 'Changed · Facts · deploy-target', note: 'Edited on the Memory page', before,
      after: ctx.seeded['deploy-target'] }] });
  // 增强开着：每天的时刻是两小时前，今天已经是 since，没有该跑的日子，下次到点在约 22 小时后（自动的运行不会打扰测试）
  ctx.p1Time = hhmm(NOW - 2 * 60 * 60 * 1000);
  ctx.p1Day = dayOf(NOW, ctx.p1Time);
  seedEnhance(ctx.userData, ctx.p1, enhanceJson({ enabled: true, pick: PROVIDER, thinking: 'off', time: ctx.p1Time,
    since: ctx.p1Day, doneThrough: addDays(ctx.p1Day, -1) }));
}

/** @brief 测试准备（synthetic）：项目 B 的 205 次旧修订（列表只列最新 200 条）与五次带标记的修订。 */
function seedP2Revisions(ctx, base) {
  const cwd = resolve(ctx.p2);
  for (let index = 1; index <= 205; index += 1) {
    const time = NOW - 40 * DAY + index * 60000;
    seedRevision(base, { id: revisionIdAt(time, `b${String(index).padStart(3, '0')}`), time: localIso(time),
      by: 'You', title: `Bulk revision ${index}`, layers: ['project'], kinds: ['fact'], counts: {}, cwd });
  }
  const day = localDate(NOW - 3 * DAY);
  const earlier = localDate(NOW - 4 * DAY);
  const evidence = { at: day, session: join(ctx.p2, 'gone', 'payment.jsonl'), entry: 'e1', title: 'Payment refactor',
    quote: 'Tell me the plan first' };
  const added = detailText({ kind: 'taste', abstract: 'Explain the plan before a large change', source: 'learned',
    created: `${day} · Enhancement`, modified: `${day} · Enhancement`, evidence: [evidence],
    details: 'Seeded by the synthetic run record.' });
  const reviewA = detailText({ kind: 'review', abstract: 'Run the tests', source: 'learned',
    created: `${day} · Enhancement`, modified: `${day} · Enhancement`, details: 'Version A.' });
  const reviewB = reviewA.replace('Version A.', 'Version B.');
  const marks = markerRevisions({ day, earlier, evidence, added, reviewA, reviewB });
  ctx.marks = {};
  marks.forEach((mark, index) => {
    const time = NOW - 2 * DAY + index * 60000;
    const id = revisionIdAt(time, `m00${index + 1}`);
    ctx.marks[mark.key] = { id, time, title: mark.title };
    seedRevision(base, { ...mark, id, time: localIso(time), layers: ['project'], cwd,
      rollbackOf: mark.key === 'rollback' ? ctx.marks.failed.id : null });
  });
  ctx.markDays = { day, earlier };
}

/** @brief 五次带标记的修订（synthetic）：增强运行完成、运行中、失败、回滚、没有改动。 */
function markerRevisions({ day, earlier, evidence, added, reviewA, reviewB }) {
  return [
    { key: 'done', by: 'Enhancement', title: `TASTE enhancement · ${monthDay(day)}`, kinds: ['taste'],
      counts: { added: 1 }, run: { task: 'taste', day, tokens: 38214, sessions: 2, feedback: 1 },
      changes: [{ head: 'Added · TASTE · explain-the-plan', evidence: evidenceLine(evidence), before: '',
        after: added }], notes: 'Merged two entries.\n\n**No conflicts** with entries the user wrote.' },
    { key: 'running', by: 'Enhancement', title: `STRATEGY enhancement · ${monthDay(day)}`, status: 'running',
      kinds: ['strategy'], counts: {}, run: { task: 'strategy', day, tokens: null, sessions: 1, feedback: 0 } },
    { key: 'failed', by: 'Enhancement', title: `REVIEW enhancement · ${monthDay(day)}`, status: 'failed',
      kinds: ['review'], counts: { changed: 1 }, run: { task: 'review', day, tokens: 1500, sessions: 1, feedback: 0 },
      changes: [{ head: 'Changed · REVIEW · run-the-tests', before: reviewA, after: reviewB }],
      notes: 'No model available' },
    { key: 'rollback', by: 'Rollback', title: `Rolled back: REVIEW enhancement · ${monthDay(day)}`,
      kinds: ['review'], counts: { changed: 1 },
      changes: [{ head: 'Changed · REVIEW · run-the-tests', before: reviewB, after: reviewA }] },
    { key: 'nochange', by: 'Enhancement', title: `TASTE enhancement · ${monthDay(earlier)}`, kinds: ['taste'],
      counts: {}, run: { task: 'taste', day: earlier, tokens: 950, sessions: 1, feedback: 0 },
      notes: 'Nothing new to learn.' },
  ];
}

/** @brief 测试准备（synthetic）：项目 B（TASTE 手改超出、一条事实、修订）与项目 C（只有记忆目录，REVIEW 499 token）。 */
function seedP2P3(ctx) {
  const base = seedProject(ctx.userData, ctx.p2);
  seedKind(base, 'taste', P2_TASTE.map((abstract, index) => ({ slug: `p2-taste-${index + 1}`, abstract,
    source: 'user', created: '2026-10-18 · You', modified: '2026-10-18 · You' })));
  seedKind(base, 'fact', [{ slug: 'p2-fact', abstract: P2_FACT, source: 'user', created: '2026-10-18 · You',
    modified: '2026-10-18 · You', details: 'Original details.' }]);
  seedP2Revisions(ctx, base);
  const other = seedProject(ctx.userData, ctx.p3);
  seedKind(other, 'review', P3_REVIEW.map((abstract, index) => ({ slug: `p3-review-${index + 1}`, abstract,
    source: 'user', created: '2026-10-18 · You', modified: '2026-10-18 · You' })));
}

/** @brief 测试准备（synthetic）：项目、数据目录、记忆文件、AGENTS.md、增强脚本文件、合成端点。 */
async function setup(ctx) {
  ctx.p1 = tempProject('mori-mem-page-a-');
  ctx.p2 = tempProject('mori-mem-page-b-');
  ctx.p3 = tempProject('mori-mem-page-c-');
  seedTeamUserData(ctx.userData, { providers: [tbProvider(PROVIDER, PROXY, [tbModel(MODEL)])] });
  writeFileSync(join(ctx.userData, 'pi', 'AGENTS.md'), USER_AGENTS);
  writeFileSync(join(ctx.p1, 'AGENTS.md'), P1_AGENTS);
  writeFileSync(join(ctx.p2, 'AGENTS.md'), P2_AGENTS);
  seedUser(ctx);
  seedP1(ctx);
  seedP2P3(ctx);
  ctx.scriptFile = join(mkdtempSync(join(tmpdir(), 'mori-mem-page-script-')), 'enhance-script.json');
  writeFileSync(ctx.scriptFile, '{}\n');
  ctx.ep = await startTbEndpoint(PORT, PROXY, { FAKE_ENHANCE_SCRIPT: ctx.scriptFile });
  await startTbApp(ctx);
}

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 路径相同（Windows 不分大小写）。 */
const samePath = (left, right) => String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
/** @brief 一层的目录：项目 A、B 与用户级。 */
const baseOf = (ctx, which) => layerDir(ctx.userData, which === 'user' ? null : ctx[which]);
/** @brief 某个时刻之后的 mori.memory_changed 事件。 */
const changedSince = async (ctx, since) => (await eventsOf(ctx.page, null, since))
  .filter((item) => item.type === 'mori.memory_changed');
/** @brief 新出现的修订 id。 */
const newIds = (before, after) => after.filter((id) => !before.includes(id));
/** @brief 修订标题里的 abstract（前 60 字符，§6.5）。 */
const clip = (abstract) => [...abstract].slice(0, 60).join('');

/** @brief 在某个会话里发一条消息，等这一轮开始再结束。 */
async function chat(ctx, tab, text) {
  const before = await paneCounts(ctx.page, tab);
  await sendMessage(ctx, tab, text);
  await waitTabBusy(ctx.page, tab, 15000, before);
  await waitTabIdle(ctx.page, tab, 120000);
}

/** @brief 让某个会话显示出来并得到焦点（点它的输入框；分屏时焦点换到那一栏）。 */
async function focusTab(ctx, tab) {
  await showTab(ctx, tab);
  await ctx.page.waitForFunction((css) => {
    const pane = document.querySelector(css);
    return pane && !pane.querySelector('[data-testid="not-ready"]');
  }, paneSel(tab), { timeout: 30000 });
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).click();
  await ctx.page.waitForFunction((key) => document.querySelector(`.pane-slot[data-focused="true"][data-tab="${key}"]`),
    tab, { timeout: 5000 });
}

/** @brief 侧栏里会话的菜单 → Open in split view，等分屏、这一栏得到焦点。 */
async function openSplit(ctx, tab) {
  const { page } = ctx;
  await page.locator(`.session-item[data-row="${tab}"]`).click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem').filter({ hasText: 'Open in split view' }).click();
  await page.waitForFunction(() => document.querySelector('.center')?.dataset.split === 'true', null,
    { timeout: 10000 });
  await page.waitForFunction((key) => document.querySelector(`.pane-slot[data-focused="true"][data-tab="${key}"]`),
    tab, { timeout: 10000 });
}

/** @brief 在 tab 所在的一栏 Ctrl+N 新建会话（跟着它的项目），等它就绪，返回它的标识。 */
async function newSessionIn(ctx, tab) {
  const { page } = ctx;
  await focusTab(ctx, tab);
  const before = await page.locator('.pane-slot').count();
  await page.keyboard.press('Control+n');
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length === n, before + 1,
    { timeout: 30000 });
  const key = await page.locator('.pane-slot[data-focused="true"]').getAttribute('data-tab');
  await page.waitForFunction((css) => {
    const pane = document.querySelector(css);
    return pane && !pane.querySelector('[data-testid="not-ready"]');
  }, paneSel(key), { timeout: 30000 });
  return key;
}

/** @brief 右栏的修订详情，等第一处改动的对照画出 text（对照组件异步渲染，最多 10 秒）。 */
async function revisionWithDiff(page, text) {
  return await poll(async () => {
    const rev = (await detailState(page))?.revision;
    return rev?.changes[0]?.diff.includes(text) ? rev : null;
  }, 10000, 200) ?? (await detailState(page))?.revision;
}

/** @brief 一个按钮不可用、悬停是后台进程退出的说明。 */
const crashedControl = (control) => Boolean(control) && control.disabled === true && control.hover === CRASHED;

// ---------- 入口与没有会话时（MEM-14、MEM-16、MEM-07） ----------

/** @brief 左栏的入口；没有会话时打开记忆页：Project 不可用、六个分节、用户级的用量、AGENT 只有用户级。 */
async function nav(ctx) {
  const { page } = ctx;
  await page.getByTestId('nav-memory').waitFor({ timeout: 30000 });
  const items = await page.locator('[data-testid="sidebar"] .sidebar-nav .nav-item')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  const review = await page.locator('[data-testid="sidebar"] button').filter({ hasText: /^Review$/ }).count()
    + await page.locator('[data-testid="nav-review"]').count();
  record('MEM-14 the sidebar has Memory (nav-memory) right below Customize, where Review used to be, and no Review '
    + 'entry', same(items, ['New session (Ctrl+N)', 'Open folder…', 'Customize', 'Memory']) && review === 0,
  brief({ items, review }));
  await openMemoryPage(page);
  const state = await memoryState(page);
  record('MEM-14 with no session open the page shows User; Project is unavailable with the hover “Open a session to '
    + 'see this project’s memory.” and there is no enhancement block', state.scope === 'user'
    && state.project.disabled && state.project.hover === NO_PROJECT_HOVER && !state.enhance && state.folder === null,
  brief({ user: state.user, project: state.project, enhance: state.enhance }));
  record('MEM-14 the page has the six sections Facts, TASTE, STRATEGY, REVIEW, AGENT, Revisions in this order '
    + '(memory-section-<id>), Facts pressed when the page first opens', same(state.sections.map((item) => [item.id,
    item.label]), SECTIONS) && state.section === 'facts', brief(state.sections.map((item) => [item.id, item.label,
    item.pressed])));
  const user = usageOf(userFacts().map((item) => item.abstract));
  record('MEM-07 User Facts usage counts the user level only, estimated by §6.3 (a CJK abstract counts each CJK '
    + `character as 1): "${user} / 500 tokens"`, state.usage === `${user} / 500 tokens` && !state.usageOver,
  brief(state.usage));
  await chooseSection(page, 'agent');
  const agent = await memoryState(page);
  const tokens = estimate(USER_AGENTS);
  record('MEM-16 AGENT with no session lists only the user-level AGENTS.md: its path, "<n> tokens" equal to '
    + '§6.3 of its content, Edit in Customize, and the total "<n> / 2,000 tokens"', agent.agentFiles.length === 1
    && samePath(agent.agentFiles[0].path, join(ctx.userData, 'pi', 'AGENTS.md'))
    && agent.agentFiles[0].tokens === `${tokens} tokens` && agent.agentFiles[0].buttons.some((button) => button.label
      === 'Edit in Customize') && agent.agentTotal === `${tokens} / 2,000 tokens` && !agent.agentTotalOver,
  brief({ files: agent.agentFiles, total: agent.agentTotal, tokens }));
  await chooseSection(page, 'facts');
  await backToApp(page);
}

// ---------- 层跟随焦点会话（MEM-14、MEM-07） ----------

/** @brief 打开项目 A、B 的会话（各发一条消息）；记忆页跟随焦点会话的项目，按项目记住分节。 */
async function follow(ctx) {
  const { page } = ctx;
  ctx.a1 = await openProject(ctx, ctx.p1);
  await chat(ctx, ctx.a1, 'plain hello from project A');
  await openMemoryPage(page);
  const opened = await memoryState(page);
  await chooseScope(page, 'project');
  const first = await memoryState(page);
  record('MEM-14 once a session is open the page follows its project: Project becomes available with the project '
    + 'folder name next to it (full path on hover); on Project the enhancement block is shown',
  !opened.project.disabled && opened.folder === basename(ctx.p1) && samePath(opened.folderTitle, ctx.p1)
    && first.scope === 'project' && samePath(first.folderTitle, ctx.p1) && first.enhance,
  brief({ opened: [opened.scope, opened.project, opened.folderTitle], first: [first.scope, first.enhance] }));
  await chooseSection(page, 'taste');
  await backToApp(page);
  ctx.b1 = await openProject(ctx, ctx.p2);
  ctx.b1Since = Date.now();
  await chat(ctx, ctx.b1, 'plain check the prompt of project B');
  await openMemoryPage(page);
  const second = await memoryState(page);
  record('MEM-14 when the focused session is in another project the page follows it at once: that project, the '
    + 'current section kept (TASTE, not viewed in that project yet), only that project’s entries listed',
  samePath(second.folderTitle, ctx.p2) && second.scope === 'project' && second.section === 'taste'
    && same(second.rows.map((row) => row.title), P2_TASTE), brief({ folder: second.folderTitle,
    section: second.section, rows: second.rows.length }));
  await chooseSection(page, 'review');
  await backToApp(page);
  await rememberedSections(ctx);
  await splitFollow(ctx);
}

/** @brief 换回项目 A、再换回项目 B：每个项目回到上次在那里看的分节。 */
async function rememberedSections(ctx) {
  const { page } = ctx;
  const seen = [];
  for (const [tab, folder] of [[ctx.a1, ctx.p1], [ctx.b1, ctx.p2]]) {
    await focusTab(ctx, tab);
    await openMemoryPage(page);
    const state = await memoryState(page);
    seen.push({ project: samePath(state.folderTitle, folder), scope: state.scope, section: state.section });
    await backToApp(page);
  }
  record('MEM-14 switching projects returns to the section last viewed in each project (project A → TASTE, '
    + 'project B → REVIEW)', seen.every((item) => item.project && item.scope === 'project')
    && seen[0].section === 'taste' && seen[1].section === 'review', brief(seen));
}

/** @brief 分屏：记忆页跟随焦点所在的一栏。 */
async function splitFollow(ctx) {
  const { page } = ctx;
  await focusTab(ctx, ctx.a1);
  await openSplit(ctx, ctx.b1);
  await openMemoryPage(page);
  const right = await memoryState(page);
  await backToApp(page);
  await focusTab(ctx, ctx.a1);
  await openMemoryPage(page);
  const left = await memoryState(page);
  await backToApp(page);
  record('MEM-14 in split view the page follows the focused pane: with project B’s pane focused it shows project B; '
    + 'after focusing project A’s pane it shows project A', samePath(right.folderTitle, ctx.p2)
    && samePath(left.folderTitle, ctx.p1) && right.scope === 'project' && left.scope === 'project',
  brief({ right: right.folderTitle, left: left.folderTitle }));
}

// ---------- 手改超出（MEM-07） ----------

/** @brief 项目 B 的 TASTE 手改超出：Over the limit、全部进 prompt、删除照样可以。 */
async function overLimit(ctx) {
  const { page } = ctx;
  const used = usageOf(P2_TASTE);
  const request = scenarioRequests(ctx.ep, null, { since: ctx.b1Since }).find((item) => item.messages
    .some((m) => m.role === 'user' && JSON.stringify(m.content).includes('plain check the prompt of project B')));
  const missing = P2_TASTE.filter((abstract) => !request?.system.includes(`- ${abstract}`));
  record(`MEM-07 a hand-edited TASTE over the limit (${used} tokens) still goes into the prompt in full: the first `
    + 'request of a new session in that project has every one of its lines "- <abstract>" in the system prompt',
  used > 500 && Boolean(request) && missing.length === 0, brief({ used, found: Boolean(request), missing }));
  await focusTab(ctx, ctx.b1);
  await goMemory(page, 'project', 'taste');
  const before = await memoryState(page);
  record('MEM-07 the page shows the over-limit usage in the warning colour with “ · Over the limit”: '
    + `"${used} / 500 tokens · User 0 + this project ${used} · Over the limit"`,
  before.usage === `${used} / 500 tokens · User 0 + this project ${used} · Over the limit` && before.usageOver,
  brief(before.usage));
  const base = baseOf(ctx, 'p2');
  const revisions = revisionFiles(base);
  await selectRow(page, 'p2-taste-1');
  await deleteOpenEntry(page);
  const gone = await waitRow(page, 'p2-taste-1', false);
  const after = await memoryState(page);
  const rest = usageOf(P2_TASTE.slice(1));
  record('MEM-07 deleting is never refused for the budget: with TASTE still over the limit afterwards the delete goes '
    + `through (row and index line gone, one Deleted revision, usage now ${rest} and still Over the limit)`,
  gone && !indexSlugs(base, 'taste').includes('p2-taste-1') && newIds(revisions, revisionFiles(base)).length === 1
    && after.usage === `${rest} / 500 tokens · User 0 + this project ${rest} · Over the limit`,
  brief({ gone, usage: after.usage }));
}

// ---------- 列表与详情（MEM-14、MEM-07、MEM-08） ----------

/** @brief 项目 A 的 Facts：用量、Last change、列表、读不出来的条目、↑↓。 */
async function listChecks(ctx) {
  const { page } = ctx;
  await focusTab(ctx, ctx.a1);
  await goMemory(page, 'project', 'facts');
  const state = await memoryState(page);
  const readable = p1Facts(ctx).filter((item) => !item.text);
  const user = usageOf(userFacts().map((item) => item.abstract));
  const project = usageOf(readable.map((item) => item.abstract));
  record('MEM-07 Project Facts usage is user + this project, each layer estimated by §6.3 and then added: '
    + `"${user + project} / 500 tokens · User ${user} + this project ${project}"`,
  state.usage === `${user + project} / 500 tokens · User ${user} + this project ${project}`, brief(state.usage));
  const day = monthDay(localDate(ctx.seededRevision.time));
  record(`MEM-14 Last change shows the latest revision of this kind in this layer: "Last change ${day} · Changed 1"`,
    state.last?.label === `Last change ${day} · Changed 1`, brief(state.last));
  const rowsOk = same(state.rows.map((row) => row.id), readable.map((item) => item.slug))
    && state.rows.every((row, index) => row.source === readable[index].source && same(row.meta,
      [readable[index].source === 'user' ? 'You said' : 'Learned', monthDay(readable[index].modified)]));
  record('MEM-14 the list has one row per entry in index (prompt) order with data-id and data-source, its abstract, '
    + 'and You said / Learned with the modified date <Mon D> on the right', rowsOk,
  brief(state.rows.slice(0, 4)));
  const broken = state.broken[0];
  record('MEM-14 an entry that can’t be read is one row (memory-broken) after the entries: “Couldn’t read the entry '
    + 'broken-entry.md” and the reason on the next line; it can’t be selected', state.broken.length === 1
    && broken.name === 'broken-entry.md' && broken.title === 'Couldn’t read the entry broken-entry.md'
    && broken.error === 'The file has no frontmatter.' && broken.tag !== 'BUTTON' && broken.buttons === 0,
  brief(state.broken));
  await lastChangeLink(ctx);
  await arrowKeys(ctx);
}

/** @brief 点 Last change：切到 Revisions 选中那一次。 */
async function lastChangeLink(ctx) {
  const { page } = ctx;
  await page.getByTestId('memory-last-change').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-section-revisions"]')
    ?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 });
  await waitLoaded(page);
  await waitDetail(page);
  const state = await memoryState(page);
  const detail = await detailState(page);
  const row = state.revisions.find((item) => item.id === ctx.seededRevision.id);
  record('MEM-14 clicking Last change switches to Revisions with that revision selected and open on the right',
    state.section === 'revisions' && row?.pressed === 'true' && detail?.revision?.title === ctx.seededRevision.title,
    brief({ section: state.section, row, title: detail?.revision?.title }));
  await chooseSection(page, 'facts');
}

/** @brief ↑ ↓ 在列表的行之间移动焦点。 */
async function arrowKeys(ctx) {
  const { page } = ctx;
  await selectRow(page, 'deploy-target');
  const focused = () => page.evaluate(() => document.activeElement?.dataset?.id ?? null);
  await page.keyboard.press('ArrowDown');
  const down = await focused();
  await page.keyboard.press('ArrowDown');
  const down2 = await focused();
  await page.keyboard.press('ArrowUp');
  const up = await focused();
  record('MEM-14 ↑ ↓ move between the rows of the list (deploy-target → ci-runs-nightly → fact-move-a → back up)',
    down === 'ci-runs-nightly' && down2 === 'fact-move-a' && up === 'ci-runs-nightly', brief({ down, down2, up }));
}

/** @brief 条目详情的各块（deploy-target）。 */
async function detailBlocks(ctx) {
  const { page } = ctx;
  await selectRow(page, 'deploy-target');
  const detail = await poll(async () => {
    const value = await detailState(page);
    return value?.links.length === 1 ? value : null;
  }, 10000, 100) ?? await detailState(page);
  record('MEM-14 the detail has the abstract as title and the line “Facts · Project · You said · Created Oct 20 by '
    + 'Mori · Modified Oct 21 by you”', detail.title === DEPLOY && detail.meta
    === 'Facts · Project · You said · Created Oct 20 by Mori · Modified Oct 21 by you', brief({ title: detail.title,
    meta: detail.meta }));
  const lines = ['Oct 20 · Session “Deploy notes”: “the staging server is at 10.0.0.9, note it”',
    'Oct 21 · Feedback: “Tell me where it deploys first”'];
  record('MEM-14 Evidence lists one line per item (“<Mon D> · Session “<title>”: “<quote>””, “<Mon D> · Feedback: '
    + '“<quote>””; a session not in the sidebar uses the stored title), each with Jump to source', same(detail.evidence
    .map((item) => item.line), lines) && detail.evidence.every((item) => /^(Jump to source|Opening…)$/
    .test(item.jump?.label ?? '')), brief(detail.evidence));
  record('MEM-14 Details is rendered Markdown: [[ci-runs-nightly]] is a link (a button) and [[no-such-entry]], which '
    + 'matches no entry, stays as plain text that can’t be clicked', detail.links.length === 1
    && same(detail.missing, ['[[no-such-entry]]']) && detail.details.startsWith('Deploys go through')
    && detail.details.includes('[[no-such-entry]]'), brief({ details: detail.details, links: detail.links,
    missing: detail.missing }));
  const revisionLine = `${ctx.seededRevision.title} · ${monthDayTime(ctx.seededRevision.time)}`;
  record('MEM-14 History lists the ## Revisions lines and then the revisions that changed the entry (title · '
    + '<Mon D> <hh:mm>); Linked from is absent when nothing links here; the actions are Edit, Delete…, Move to user '
    + 'level', same(detail.history?.lines, ['Oct 21 · You: Edited on the Memory page'])
    && same(detail.history?.revisions.map((item) => item.line), [revisionLine]) && detail.backlinks === null
    && detail.actions.edit?.label === 'Edit' && detail.actions.delete?.label === 'Delete…'
    && detail.actions.move?.label === 'Move to user level',
  brief({ history: detail.history, actions: detail.actions }));
  await linksAndBacklinks(ctx);
}

/** @brief 点 [[slug]] 打开那一条；它的 Linked from 指回来；没有依据时 No evidence recorded.。 */
async function linksAndBacklinks(ctx) {
  const { page } = ctx;
  await page.locator('[data-testid="memory-detail"] button.memory-link').first().click();
  const target = await poll(async () => {
    const value = await detailState(page);
    return value?.title === CI && value.backlinks ? value : null;
  }, 10000, 100) ?? await detailState(page);
  record('MEM-14 clicking the [[ci-runs-nightly]] link opens that entry in the detail; with no evidence it says '
    + '“No evidence recorded.”; History is absent when it has no lines and no revisions', target.title === CI
    && target.noEvidence === 'No evidence recorded.' && target.history === null, brief({ title: target.title,
    noEvidence: target.noEvidence, history: target.history }));
  record('MEM-14 backlinks: “Linked from” lists the entries whose details link here as “<KIND> · <abstract>”',
    same(target.backlinks?.map((item) => item.label), [`Facts · ${DEPLOY}`]), brief(target.backlinks));
  await page.locator('[data-testid="memory-backlinks"] button').first().click();
  const back = await poll(async () => ((await detailState(page))?.title === DEPLOY), 10000, 100);
  record('MEM-14 clicking a Linked from row opens that entry', back, '');
  await page.locator('[data-testid="memory-detail"] button[aria-label="Close details"]').click();
  await waitDetail(page, false);
}

/** @brief 列表与详情。 */
async function detail(ctx) {
  await listChecks(ctx);
  await detailBlocks(ctx);
}

// ---------- mori.memory_changed 的刷新（MEM-14） ----------

/** @brief 另一个写入方（经进程桥的 memory.save，synthetic）：列表就地重读，滚动位置与选中保留。 */
async function refreshList(ctx) {
  const { page } = ctx;
  await focusTab(ctx, ctx.a1);
  await goMemory(page, 'project', 'facts');
  await page.locator('[data-testid="memory-row"][data-id="fact-20"]').scrollIntoViewIfNeeded();
  await selectRow(page, 'fact-20');
  await page.evaluate(() => {
    const content = document.querySelector('[data-testid="memory-page"] .memory-content');
    content.scrollTop = Math.max(content.scrollTop, 120);
  });
  const before = await memoryState(page);
  await watchList(page);
  // synthetic：另一个写入方（同 memory 工具与增强写入的路径：后台进程的记忆模块），不经记忆页
  const result = await bridge(ctx, { type: 'memory.save', cwd: ctx.p1, layer: 'project', kind: 'fact',
    abstract: OTHER_WRITER, detail: 'Saved through the process bridge (synthetic other writer).' });
  const appeared = await poll(async () => (await memoryState(page)).rows.at(-1)?.title === OTHER_WRITER, 15000, 100);
  await waitLoaded(page);
  const after = await memoryState(page);
  const seen = await watched(page);
  const open = await detailState(page);
  record('MEM-14 a mori.memory_changed for this layer and kind (another writer saved through the process bridge, '
    + 'synthetic) re-reads the list in place: the new entry appears at the end, the list never empties, the scroll '
    + 'position and the selected row stay, and the detail stays open', result.error === null && appeared
    && !seen.listGone && before.scrollTop > 0 && Math.abs(after.scrollTop - before.scrollTop) <= 2
    && after.rows.find((row) => row.id === 'fact-20')?.pressed === 'true' && open?.title?.startsWith('Filler fact 20'),
  brief({ error: result.error, appeared, seen, before: before.scrollTop, after: after.scrollTop }));
  record('MEM-14 while it re-reads, the list stays and “Loading…” shows next to the title', seen.reading === true,
    brief(seen));
}

/** @brief 详情开着时一起重读；编辑中不重读；条目被删后详情关闭。 */
async function refreshDetail(ctx) {
  const { page } = ctx;
  const save = (detailText) => bridge(ctx, { type: 'memory.save', cwd: ctx.p1, layer: 'project', kind: 'fact',
    id: 'fact-20', abstract: 'Filler fact 20 about the layout', detail: detailText });
  await save('Details changed by another writer.');
  const refreshed = await poll(async () => (await detailState(page))?.details
    === 'Details changed by another writer.', 15000, 100);
  record('MEM-14 the open detail is re-read with the list when its entry changes (memory.get again)', refreshed,
    brief((await detailState(page))?.details));
  await page.getByTestId('memory-edit').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 5000 });
  await fillForm(page, { abstract: 'Typed while another writer saves' });
  const since = Date.now();
  await save('Second change by another writer.');
  await poll(async () => (await changedSince(ctx, since)).length > 0, 10000, 100);
  await waitLoaded(page);
  await sleep(500);
  const editing = await detailState(page);
  record('MEM-14 while you edit the entry a mori.memory_changed doesn’t re-read the detail: the form and your typed '
    + 'text stay', editing?.form?.abstract === 'Typed while another writer saves', brief(editing?.form));
  await page.getByTestId('memory-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  const latest = await poll(async () => (await detailState(page))?.details === 'Second change by another writer.',
    10000, 100);
  record('MEM-14 Cancel closes the form without asking and the detail shows the latest saved text', latest,
    brief((await detailState(page))?.details));
  await bridge(ctx, { type: 'memory.delete', cwd: ctx.p1, layer: 'project', id: 'fact-20' });
  const closed = await poll(async () => (await detailState(page)) === null, 15000, 100);
  const gone = await waitRow(page, 'fact-20', false);
  const focus = await page.evaluate(() => document.activeElement?.dataset?.testid ?? document.activeElement?.tagName);
  record('MEM-14 when the open entry is deleted (another writer), the detail closes and focus goes back to the list',
    closed && gone && focus === 'memory-row', brief({ closed, gone, focus }));
}

/** @brief mori.memory_changed 的刷新。 */
async function refresh(ctx) {
  await refreshList(ctx);
  await refreshDetail(ctx);
}

// ---------- 表单、编辑、离开确认、删除（MEM-14、MEM-08） ----------

/** @brief New entry 的空表单与三句提示：不发命令（没有事件、文件不变、没有内核的错误）。 */
async function formChecks(ctx) {
  const { page } = ctx;
  await focusTab(ctx, ctx.a1);
  await goMemory(page, 'project', 'taste');
  await selectRow(page, 'answer-first');
  await page.getByTestId('memory-new').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 5000 });
  const blank = await detailState(page);
  const list = await memoryState(page);
  record('MEM-14 New entry opens the same form, empty (Abstract and Details), in the right panel; the form is '
    + 'noValidate; the list selection is cleared', blank.form?.abstract === '' && blank.form?.details === ''
    && blank.form?.noValidate === true && list.rows.every((row) => row.pressed !== 'true'), brief(blank.form));
  const base = baseOf(ctx, 'p1');
  const cases = [['   ', '', 'Abstract is required.'],
    ['a'.repeat(201), '', 'Abstract must be at most 200 characters.'],
    ['A valid abstract', 'd'.repeat(4001), 'Details must be at most 4,000 characters.']];
  const results = [];
  for (const [abstract, details, sentence] of cases) {
    const snapshot = layerSnapshot(base);
    const since = Date.now();
    await fillForm(page, { abstract, details });
    const outcome = await saveForm(page, 3000);
    await sleep(400);
    const state = await detailState(page);
    results.push({ sentence, outcome, errors: state?.form?.errors, error: state?.error,
      events: (await changedSince(ctx, since)).length, unchanged: snapshot === layerSnapshot(base) });
  }
  record('MEM-14 the form checks on Save and shows the problem under the field without sending a command: empty → '
    + '“Abstract is required.”, 201 characters → “Abstract must be at most 200 characters.”, '
    + '4,001-character Details → '
    + '“Details must be at most 4,000 characters.” (no memory_changed, files unchanged, no kernel error)',
  results.every((item) => item.outcome === 'field' && same(item.errors, [item.sentence]) && item.error === null
    && item.events === 0 && item.unchanged), brief(results));
}

/** @brief 新增保存：加在末尾、You said、选中它；一条修订。 */
async function formSave(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  const before = revisionFiles(base);
  await fillForm(page, { abstract: ASK_BEFORE, details: 'Confirm renames first.' });
  const outcome = await saveForm(page);
  const state = await memoryState(page);
  const open = await detailState(page);
  const last = state.rows.at(-1);
  ctx.askId = last?.title === ASK_BEFORE ? last.id : null;
  record('MEM-14 saving a new entry adds it at the end of the list as You said and selects it with its detail open; '
    + 'it is saved in TASTE of this project (kind from the section, layer from Project)', outcome === 'saved'
    && Boolean(ctx.askId) && last.source === 'user' && last.pressed === 'true' && open?.title === ASK_BEFORE
    && indexSlugs(base, 'taste').at(-1) === ctx.askId, brief({ outcome, last, title: open?.title }));
  const added = newIds(before, revisionFiles(base));
  const field = (key) => revisionField(base, added[0], key);
  record('MEM-08 one Memory-page save writes one revision: “You · Added TASTE: <abstract>”, by You, layers '
    + '["project"], kinds ["taste"], counts added 1, rollbackOf null', added.length === 1
    && field('title') === `You · Added TASTE: ${ASK_BEFORE}` && field('by') === 'You' && same(field('layers'),
    ['project']) && same(field('kinds'), ['taste']) && same(field('counts'), { added: 1, changed: 0, deleted: 0,
    moved: 0 }) && field('rollbackOf') === null, brief({ added, title: added[0] && field('title') }));
}

/** @brief 编辑一条 Learned：变为 You said，History 与文件的 ## Revisions 多一行固定文字，一条修订。 */
async function formEdit(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  await selectRow(page, 'answer-first');
  await page.getByTestId('memory-edit').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 5000 });
  const form = (await detailState(page)).form;
  const before = revisionFiles(base);
  await fillForm(page, { details: 'Lead with the answer, then the reasons.' });
  const outcome = await saveForm(page);
  const row = (await memoryState(page)).rows.find((item) => item.id === 'answer-first');
  const open = await detailState(page);
  const line = `${today()} · You: Edited on the Memory page`;
  record('MEM-14 Edit fills the form with the entry’s abstract and Details; after Save a Learned entry is marked You '
    + 'said (row and detail line)', form?.abstract === ANSWER && form?.details
    === 'Start every answer with the conclusion.' && outcome === 'saved' && row?.source === 'user'
    && row?.meta[0] === 'You said' && open?.meta?.includes('You said')
    && open?.meta?.endsWith(`Modified ${today()} by you`), brief({ form, row, meta: open?.meta }));
  const changed = newIds(before, revisionFiles(base));
  const file = readText(join(base, 'entries', 'answer-first.md')) ?? '';
  record('MEM-08 a Memory-page edit writes one revision “You · Changed TASTE: …” and adds the fixed line '
    + `"- ${line}" to the entry’s ## Revisions (shown in History)`, changed.length === 1
    && revisionField(base, changed[0], 'title') === `You · Changed TASTE: ${ANSWER}` && file.includes(`- ${line}`)
    && open?.history?.lines.includes(line), brief({ changed, history: open?.history }));
  ctx.answerChanged = changed[0];
}

/** @brief 离开确认框的内容与焦点。 */
async function leaveDialogInfo(page) {
  const dialog = page.getByTestId('leave-dialog');
  await dialog.waitFor({ timeout: 5000 });
  return dialog.evaluate((el) => ({ title: el.querySelector('h2')?.textContent, text: el.querySelector('p')
    ?.textContent, buttons: [...el.querySelectorAll('button')].map((button) => button.textContent),
  focus: document.activeElement?.textContent ?? null }));
}

/** @brief 有未保存的编辑时选另一行：确认框；Keep editing 保留编辑、焦点回到表单。 */
async function leaveDialog(ctx) {
  const { page } = ctx;
  await selectRow(page, 'reply-style');
  await page.getByTestId('memory-edit').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 5000 });
  await fillForm(page, { abstract: 'Use plain words, typed but not saved' });
  await page.locator('[data-testid="memory-row"][data-id="answer-first"]').click();
  const info = await leaveDialogInfo(page);
  await page.getByTestId('leave-dialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.getByTestId('leave-dialog').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(200);
  const kept = await detailState(page);
  const focus = await page.evaluate(() => document.activeElement?.dataset?.testid ?? null);
  record('MEM-14 with unsaved edits, choosing another row asks first: “Discard changes to this entry?” / “Your edits '
    + 'haven’t been saved. Leaving now discards them.”, Discard and Keep editing, focus on Keep editing; Keep editing '
    + 'keeps the form, the typed text and the entry, and focus returns to the form', info.title === LEAVE_TITLE
    && info.text === LEAVE_TEXT && same(info.buttons, ['Discard', 'Keep editing']) && info.focus === 'Keep editing'
    && kept?.form?.abstract === 'Use plain words, typed but not saved'
    && (await memoryState(page)).rows.find((row) => row.id === 'reply-style')?.pressed === 'true'
    && /^memory-(abstract|details)$/.test(focus ?? ''), brief({ info, form: kept?.form, focus }));
  await leaveOthers(ctx);
}

/** @brief 别的离开入口同样先问（分节、New entry、Back to app、侧栏的会话），Esc 等于 Keep editing；Discard 照常去做。 */
async function leaveOthers(ctx) {
  const { page } = ctx;
  const ways = [['section', page.getByTestId('memory-section-strategy')], ['new', page.getByTestId('memory-new')],
    ['back', page.locator('[data-testid="memory-page"] .topbar button', { hasText: 'Back to app' })],
    ['sidebar', page.locator(`.session-item[data-row="${ctx.b1}"]`)]];
  const results = [];
  for (const [name, locator] of ways) {
    await locator.click();
    const asked = await page.getByTestId('leave-dialog').waitFor({ timeout: 3000 }).then(() => true, () => false);
    if (asked) await page.keyboard.press('Escape');
    await page.getByTestId('leave-dialog').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
    const onPage = (await page.getByTestId('memory-page').count()) === 1;
    const state = onPage ? await detailState(page) : null;
    results.push({ name, asked, onPage, kept: state?.form?.abstract === 'Use plain words, typed but not saved' });
    if (!onPage) break;
  }
  record('MEM-14 the other ways out ask the same way before leaving the edit (a section, New entry, Back to app, a '
    + 'session in the sidebar), and Esc keeps editing', results.length === ways.length
    && results.every((item) => item.asked && item.kept && item.onPage), brief(results));
  if (!results.every((item) => item.onPage)) throw new Error(`left the Memory page without asking: ${brief(results)}`);
  const file = readText(join(baseOf(ctx, 'p1'), 'entries', 'reply-style.md'));
  await page.locator('[data-testid="memory-row"][data-id="answer-first"]').click();
  await page.getByTestId('leave-dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  const moved = await poll(async () => (await detailState(page))?.title === ANSWER, 10000, 100);
  record('MEM-14 Discard drops the edits and does what you clicked (the other row opens); the entry file is unchanged',
    moved && readText(join(baseOf(ctx, 'p1'), 'entries', 'reply-style.md')) === file, '');
}

/** @brief 删除：确认框（Esc 取消）、删除后行消失、详情关闭、焦点回到列表；一条修订；Last change。 */
async function formDelete(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  await selectRow(page, ctx.askId);
  await page.getByTestId('memory-delete').click();
  const dialog = page.getByTestId('memory-delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const info = await dialog.evaluate((el) => ({ title: el.querySelector('h2')?.textContent, text: el
    .querySelector('p')?.textContent, buttons: [...el.querySelectorAll('button')].map((button) => button.textContent),
  focus: document.activeElement?.textContent ?? null }));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  const kept = (await memoryState(page)).rows.some((row) => row.id === ctx.askId) && Boolean(await detailState(page));
  record('MEM-14 Delete… asks first: “Delete “<abstract>”?”, “You can roll it back from Revisions.”, Delete and '
    + 'Cancel with focus on Cancel; Esc cancels and keeps the entry', info.title === `Delete “${ASK_BEFORE}”?`
    && info.text === 'You can roll it back from Revisions.' && same(info.buttons, ['Delete', 'Cancel'])
    && info.focus === 'Cancel' && kept, brief(info));
  const before = revisionFiles(base);
  await deleteOpenEntry(page);
  const closed = await poll(async () => (await detailState(page)) === null, 10000, 100);
  const gone = await waitRow(page, ctx.askId, false);
  const focusOf = () => page.evaluate(() => ({ testid: document.activeElement?.dataset?.testid ?? null,
    html: document.activeElement?.outerHTML.slice(0, 100) ?? null }));
  const focus = await poll(async () => {
    const value = await focusOf();
    return value.testid === 'memory-row' ? value : null;
  }, 2000, 100) ?? await focusOf();
  record('MEM-14 Delete removes the row and closes the detail; focus goes back to the list', closed && gone
    && focus.testid === 'memory-row', brief({ closed, gone, focus }));
  const deleted = newIds(before, revisionFiles(base));
  record('MEM-08 one delete writes one revision “You · Deleted TASTE: <abstract>” with counts deleted 1',
    deleted.length === 1 && revisionField(base, deleted[0], 'title') === `You · Deleted TASTE: ${ASK_BEFORE}`
    && same(revisionField(base, deleted[0], 'counts'), { added: 0, changed: 0, deleted: 1, moved: 0 }),
  brief(deleted));
  const state = await memoryState(page);
  record(`MEM-14 Last change follows the latest revision of the kind: "Last change ${today()} · Deleted 1"`,
    state.last?.label === `Last change ${today()} · Deleted 1`, brief(state.last));
}

/** @brief 表单、编辑、离开确认、删除。 */
async function form(ctx) {
  await formChecks(ctx);
  await formSave(ctx);
  await formEdit(ctx);
  await leaveDialog(ctx);
  await formDelete(ctx);
}

// ---------- 提升与放回（MEM-14、MEM-08、MEM-09、MEM-07） ----------

/** @brief Move to user level：离开本项目、到用户级末尾（You said、当天）、两层各一份修订、Note 与 History 的固定文字。 */
async function promote(ctx) {
  const { page } = ctx;
  const [projectBase, userBase] = [baseOf(ctx, 'p1'), baseOf(ctx, 'user')];
  const [projectRevs, userRevs] = [revisionFiles(projectBase), revisionFiles(userBase)];
  await focusTab(ctx, ctx.a1);
  await goMemory(page, 'project', 'facts');
  await selectRow(page, 'fact-move-a');
  const outcome = await moveOpenEntry(page);
  const gone = await waitRow(page, 'fact-move-a', false);
  const both = newIds(projectRevs, revisionFiles(projectBase));
  const sameId = both.length === 1 && same(newIds(userRevs, revisionFiles(userBase)), both);
  ctx.promoteRevision = both[0];
  await chooseScope(page, 'user');
  const user = await memoryState(page);
  const last = user.rows.at(-1);
  record('MEM-14 Move to user level: the entry leaves this project’s list and the detail closes; it is at the end of '
    + 'the user level as You said with today’s modified date', outcome === 'moved' && gone && last?.title === MOVE_A
    && last.source === 'user' && same(last.meta, ['You said', today()]), brief({ outcome, gone, last }));
  record('MEM-08 a move writes one revision into both layers’ revisions/ (same id): “You · Moved to user level: …”, '
    + 'counts moved 1', sameId
    && revisionField(projectBase, both[0], 'title') === `You · Moved to user level: ${MOVE_A}`
    && same(revisionField(projectBase, both[0], 'counts'), { added: 0, changed: 0, deleted: 0, moved: 1 })
    && readText(join(projectBase, 'revisions', `${both[0]}.md`)) === readText(join(userBase, 'revisions',
      `${both[0]}.md`)), brief(both));
  await selectRow(page, last.id);
  const open = await detailState(page);
  record('MEM-08 the moved entry’s ## Revisions gets the fixed line “<Mon D> · You: Moved to user level” (History); '
    + 'its detail says User and offers Move to this project', open?.history?.lines
    .includes(`${today()} · You: Moved to user level`) && open?.meta?.startsWith('Facts · User · You said')
    && open?.actions.move?.label === 'Move to this project', brief({ history: open?.history, meta: open?.meta }));
  await chooseSection(page, 'revisions');
  await selectRevisionRow(page, both[0]);
  const rev = await revisionWithDiff(page, 'Moved to user level');
  record('MEM-08 the move’s revision detail has one block “Moved · Facts · <abstract>” with “Note: Moved to user '
    + 'level” and the before / after comparison of the two files', rev?.changes.length === 1
    && rev.changes[0].title === `Moved · Facts · ${MOVE_A}`
    && same(rev.changes[0].notes, ['Note: Moved to user level'])
    && rev.changes[0].diff.includes('Moved to user level'), brief(rev?.changes.map((item) => [item.title, item.notes,
    item.diff.length])));
}

/** @brief Move to this project：用户级的 shared-name-entry 放回项目 A。 */
async function putBack(ctx) {
  const { page } = ctx;
  await chooseSection(page, 'facts');
  await selectRow(page, SHARED_SLUG);
  const outcome = await moveOpenEntry(page);
  const gone = await waitRow(page, SHARED_SLUG, false);
  await chooseScope(page, 'project');
  const last = (await memoryState(page)).rows.at(-1);
  record('MEM-14 Move to this project: the user-level entry leaves the user list and is at the end of this '
    + 'project’s list as You said', outcome === 'moved' && gone && last?.title === SHARED && last.source === 'user',
  brief({ outcome, gone, last }));
}

/** @brief 回滚放回（同名加后缀、source 恢复、写进两层）；回滚提升，再回滚那次回滚。 */
async function rollbackMoves(ctx) {
  const { page } = ctx;
  const [projectBase, userBase] = [baseOf(ctx, 'p1'), baseOf(ctx, 'user')];
  await chooseScope(page, 'user');
  const fresh = await newEntry(page, SHARED, 'A new user entry with the same name.');
  const reused = (await memoryState(page)).rows.at(-1)?.id;
  await chooseScope(page, 'project');
  await chooseSection(page, 'revisions');
  const title = `You · Moved to this project: ${SHARED}`;
  const before = [revisionFiles(projectBase), revisionFiles(userBase)];
  await selectRevisionRow(page, await revisionRowId(page, title));
  const outcome = await rollbackOpenRevision(page, title);
  const rb = newIds(before[0], revisionFiles(projectBase));
  const userSlugs = indexSlugs(userBase, 'fact');
  const restored = readText(join(userBase, 'entries', `${SHARED_SLUG}-2.md`)) ?? '';
  const row = (await memoryState(page)).revisions[0];
  record('MEM-09 rolling back Move to this project: the entry is back at the end of the user level, with “-2” '
    + 'because a new user entry now has its slug, and its source restored (learned); this project no longer has it',
  fresh === 'saved' && reused === SHARED_SLUG && outcome === 'done' && userSlugs.at(-1) === `${SHARED_SLUG}-2`
    && restored.includes('source: learned') && !indexSlugs(projectBase, 'fact').includes(SHARED_SLUG),
  brief({ fresh, reused, outcome, userSlugs: userSlugs.slice(-3) }));
  record('MEM-09 the rollback of a move writes one revision into both layers (“Rolled back: <title>”, by Rollback, '
    + 'marked Rollback in the list)', rb.length === 1 && same(newIds(before[1], revisionFiles(userBase)), rb)
    && revisionField(projectBase, rb[0], 'by') === 'Rollback' && row?.title === `Rolled back: ${title}`
    && row.tags.includes('Rollback'), brief({ rb, row }));
  await rollbackPromote(ctx);
}

/** @brief 回滚 Move to user level：回到项目 A 末尾、source learned；再回滚那次回滚：又到用户级。 */
async function rollbackPromote(ctx) {
  const { page } = ctx;
  const [projectBase, userBase] = [baseOf(ctx, 'p1'), baseOf(ctx, 'user')];
  const title = `You · Moved to user level: ${MOVE_A}`;
  await selectRevisionRow(page, ctx.promoteRevision);
  const outcome = await rollbackOpenRevision(page, title);
  const file = readText(join(projectBase, 'entries', 'fact-move-a.md')) ?? '';
  record('MEM-09 rolling back Move to user level: the entry is back at the end of this project with source learned; '
    + 'the user level no longer has it', outcome === 'done' && indexSlugs(projectBase, 'fact').at(-1) === 'fact-move-a'
    && file.includes('source: learned') && !indexSlugs(userBase, 'fact').includes('fact-move-a'),
  brief({ outcome, project: indexSlugs(projectBase, 'fact').slice(-2), user: indexSlugs(userBase, 'fact') }));
  const again = `Rolled back: ${title}`;
  await selectRevisionRow(page, await revisionRowId(page, again));
  const second = await rollbackOpenRevision(page, again);
  record('MEM-09 the rollback revision of a move can be rolled back again: the entry goes back to the user level',
    second === 'done' && indexSlugs(userBase, 'fact').at(-1) === 'fact-move-a'
    && !indexSlugs(projectBase, 'fact').includes('fact-move-a'),
  brief({ second, user: indexSlugs(userBase, 'fact') }));
}

/** @brief 移动同样检查预算：项目 A 的 REVIEW 提升到用户级会让项目 C 超出，拒绝并写出项目 C。 */
async function moveBudget(ctx) {
  const { page } = ctx;
  const userBase = baseOf(ctx, 'user');
  await chooseSection(page, 'review');
  const empty = await memoryState(page);
  record('MEM-14 a section with no entries says “No entries yet.”', empty.rows.length === 0
    && empty.states.includes('No entries yet.'), brief(empty.states));
  const saved = await newEntry(page, REVIEW_ENTRY);
  const id = (await memoryState(page)).rows.at(-1)?.id;
  const userBefore = layerSnapshot(userBase);
  const outcome = await moveOpenEntry(page);
  const open = await detailState(page);
  const user = usageOf([REVIEW_ENTRY]);
  const want = `Couldn’t move: Over the 500-token limit for REVIEW: user ${user} + project ${resolve(ctx.p3)} 499 = `
    + `${user + 499}. Merge or delete entries first.`;
  record('MEM-07 moving to the user level is checked like a user-level write: it would push another project (C, 499 '
    + 'REVIEW tokens) over, so it is refused with that project named; the entry stays and nothing is written',
  saved === 'saved' && outcome === 'error' && open?.error === want && (await memoryState(page)).rows.some((row) => row
    .id === id) && layerSnapshot(userBase) === userBefore, brief({ saved, outcome, error: open?.error, want }));
}

/** @brief 提升、放回与它们的回滚。 */
async function move(ctx) {
  await promote(ctx);
  await putBack(ctx);
  await rollbackMoves(ctx);
  await moveBudget(ctx);
}

// ---------- 预算（MEM-07、MEM-09） ----------

/** @brief 恰好 500 允许、501 拒绝且什么都没写。 */
async function budgetExact(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  await goMemory(page, 'project', 'strategy');
  const [user, project] = [usageOf(USER_STRATEGY), usageOf(P1_STRATEGY)];
  const start = await memoryState(page);
  const chars = P1_STRATEGY.map((item) => `- ${item}`).join('\n').length;
  ctx.exact = asciiText('Exact budget entry', 4 * (500 - user) - chars - 3);
  const fits = usageOf([...P1_STRATEGY, ctx.exact]) === 500 - user;
  const saved = await newEntry(page, ctx.exact);
  ctx.exactId = (await memoryState(page)).rows.at(-1)?.id;
  const full = await memoryState(page);
  record(`MEM-07 a write that makes the kind exactly 500 is allowed: usage "500 / 500 tokens · User ${user} + this `
    + `project ${500 - user}" (was "${user + project} / 500 tokens · User ${user} + this project ${project}")`,
  fits && start.usage === `${user + project} / 500 tokens · User ${user} + this project ${project}`
    && saved === 'saved' && full.usage === `500 / 500 tokens · User ${user} + this project ${500 - user}`
    && !full.usageOver, brief({ fits, start: start.usage, saved, full: full.usage }));
  const snapshot = layerSnapshot(base);
  const refused = await newEntry(page, 'x');
  const over = usageOf([...P1_STRATEGY, ctx.exact, 'x']);
  const want = `Couldn’t save: Over the 500-token limit for STRATEGY: user ${user} + this project ${over} = `
    + `${user + over}. Merge or delete entries first.`;
  const open = await detailState(page);
  record(`MEM-07 one more token (501) is refused: “${want}” (the sum is the two numbers added), the form keeps the `
    + 'text and nothing is written', refused === 'error' && user + over === 501 && open?.error === want
    && open?.form?.abstract === 'x' && layerSnapshot(base) === snapshot, brief({ refused, error: open?.error }));
  await page.getByTestId('memory-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await waitDetail(page, false);
}

/** @brief 写用户级超出某个项目：拒绝并写出项目 A。 */
async function budgetUser(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'user');
  await chooseScope(page, 'user');
  const snapshot = layerSnapshot(base);
  const refused = await newEntry(page, 'y');
  const user = usageOf([...USER_STRATEGY, 'y']);
  const project = usageOf([...P1_STRATEGY, ctx.exact]);
  const want = `Couldn’t save: Over the 500-token limit for STRATEGY: user ${user} + project ${resolve(ctx.p1)} `
    + `${project} = ${user + project}. Merge or delete entries first.`;
  const open = await detailState(page);
  record('MEM-07 a user-level write that would push a project over is refused with that project named (“user <u> + '
    + 'project <cwd> <p> = <sum>”) and nothing is written', refused === 'error' && open?.error === want
    && layerSnapshot(base) === snapshot, brief({ refused, error: open?.error, want }));
  await page.getByTestId('memory-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await waitDetail(page, false);
  await chooseScope(page, 'project');
}

/** @brief 回滚同样检查预算：删掉恰好 500 的那条、再加一条同样长的，回滚删除会超出 → 拒绝。 */
async function budgetRollback(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  const user = usageOf(USER_STRATEGY);
  await selectRow(page, ctx.exactId);
  await deleteOpenEntry(page);
  await waitRow(page, ctx.exactId, false);
  const second = asciiText('Second exact entry', ctx.exact.length);
  const saved = await newEntry(page, second);
  await chooseSection(page, 'revisions');
  const title = `You · Deleted STRATEGY: ${clip(ctx.exact)}`;
  await selectRevisionRow(page, await revisionRowId(page, title));
  const snapshot = layerSnapshot(base);
  const outcome = await rollbackOpenRevision(page, title);
  const project = usageOf([...P1_STRATEGY, second, ctx.exact]);
  const want = `Couldn’t roll back: Over the 500-token limit for STRATEGY: user ${user} + this project ${project} = `
    + `${user + project}. Merge or delete entries first.`;
  const error = (await detailState(page))?.revision?.error;
  record('MEM-07 a rollback is checked against the budget too: restoring the deleted entry would make STRATEGY '
    + `${user + project}, so it is refused and nothing is written`, saved === 'saved' && outcome === 'error'
    && error === want && layerSnapshot(base) === snapshot, brief({ saved, outcome, error, want }));
  record('MEM-09 a rollback that would go over the budget is refused with the §6.3 reason (“Couldn’t roll back: Over '
    + 'the 500-token limit …”)', outcome === 'error' && error === want, brief(error));
}

/** @brief 预算。 */
async function budget(ctx) {
  await focusTab(ctx, ctx.a1);
  await budgetExact(ctx);
  await budgetUser(ctx);
  await budgetRollback(ctx);
}

// ---------- 回滚（MEM-09、MEM-08） ----------

/** @brief 新增的条目后来被删：回滚新增被拒绝；回滚删除恢复它；删一条不在末尾的再回滚，加在末尾；再回滚新增删掉它。 */
async function rollbackAddDelete(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  await goMemory(page, 'project', 'revisions');
  const added = `You · Added TASTE: ${ASK_BEFORE}`;
  const deleted = `You · Deleted TASTE: ${ASK_BEFORE}`;
  const addedId = await revisionRowId(page, added);
  await selectRevisionRow(page, addedId);
  const snapshot = layerSnapshot(base);
  const conflict = await rollbackOpenRevision(page, added);
  const error = (await detailState(page))?.revision?.error;
  record('MEM-09 an entry changed later makes the whole rollback refused, naming that revision: “Couldn’t roll back: '
    + '“<abstract>” changed later (<title>). Roll back that revision first.”; nothing is written', conflict === 'error'
    && error === `Couldn’t roll back: “${ASK_BEFORE}” changed later (${deleted}). Roll back that revision first.`
    && layerSnapshot(base) === snapshot, brief({ conflict, error }));
  await selectRevisionRow(page, await revisionRowId(page, deleted));
  const undelete = await rollbackOpenRevision(page, deleted);
  const restoredAsk = indexSlugs(base, 'taste').at(-1) === ctx.askId;
  await chooseSection(page, 'taste');
  await selectRow(page, 'reply-style');
  await deleteOpenEntry(page);
  await waitRow(page, 'reply-style', false);
  await chooseSection(page, 'revisions');
  const plain = `You · Deleted TASTE: ${PLAIN}`;
  await selectRevisionRow(page, await revisionRowId(page, plain));
  const restore = await rollbackOpenRevision(page, plain);
  const order = indexSlugs(base, 'taste');
  record('MEM-09 rolling back a delete restores the entry at the end of the index (reply-style was second, comes '
    + 'back last)', undelete === 'done' && restoredAsk && restore === 'done'
    && same(order, ['answer-first', ctx.askId, 'reply-style']), brief({ undelete, restore, order }));
  await selectRevisionRow(page, addedId);
  const undo = await rollbackOpenRevision(page, added);
  record('MEM-09 rolling back an add (now that the entry is as it was added) deletes it', undo === 'done'
    && !indexSlugs(base, 'taste').includes(ctx.askId), brief({ undo, order: indexSlugs(base, 'taste') }));
}

/** @brief 回滚修改：原文与 source 恢复（逐字）。 */
async function rollbackEdit(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  const title = `You · Changed TASTE: ${ANSWER}`;
  await selectRevisionRow(page, ctx.answerChanged);
  const outcome = await rollbackOpenRevision(page, title);
  await chooseSection(page, 'taste');
  const row = (await memoryState(page)).rows.find((item) => item.id === 'answer-first');
  record('MEM-09 rolling back an edit restores the original file byte for byte, source included (the row is Learned '
    + 'again)', outcome === 'done' && readText(join(base, 'entries', 'answer-first.md')) === ctx.seeded['answer-first']
    && row?.source === 'learned' && row.meta[0] === 'Learned', brief({ outcome, row }));
}

/** @brief detail 里有单独一行 ~~~~：修订能读出、详情有前后对照与 Note；回滚后逐字相同。 */
async function rollbackTildes(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  await chooseSection(page, 'facts');
  await selectRow(page, 'ci-runs-nightly');
  await page.getByTestId('memory-edit').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 5000 });
  await fillForm(page, { details: `${CI_DETAILS}\n\nChecked again after the edit.` });
  const before = revisionFiles(base);
  const saved = await saveForm(page);
  const id = newIds(before, revisionFiles(base))[0];
  const file = readText(join(base, 'revisions', `${id}.md`)) ?? '';
  await chooseSection(page, 'revisions');
  await selectRevisionRow(page, id);
  const rev = await revisionWithDiff(page, 'Checked again after the edit.');
  record('MEM-08 a detail with a line that is only “~~~~” is fenced with five tildes and its revision reads back: '
    + 'the detail shows “Changed · Facts · <abstract>”, “Note: Edited on the Memory page” and the before / after '
    + 'comparison', saved === 'saved' && file.includes('~~~~~before\n') && rev?.changes.length === 1
    && rev.changes[0].title === `Changed · Facts · ${CI}` && same(rev.changes[0].notes, ['Note: Edited on the Memory '
      + 'page']) && rev.changes[0].diff.includes('Checked again after the edit.'), brief(rev?.changes
    .map((item) => [item.title, item.notes, item.diff.length])));
  const outcome = await rollbackOpenRevision(page, `You · Changed Facts: ${CI}`);
  record('MEM-08 rolling back that revision makes the file byte-for-byte equal to its before (the “~~~~” line '
    + 'included)', outcome === 'done' && readText(join(base, 'entries', 'ci-runs-nightly.md'))
    === ctx.seeded['ci-runs-nightly'], brief(outcome));
}

/** @brief 编辑两次：回滚第一次被拒绝并写出第二次；回滚第二次（Rollback 标记），再回滚那次回滚。 */
async function rollbackTwice(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  const title = `You · Changed Facts: ${DEPLOY}`;
  const ids = [];
  await chooseSection(page, 'facts');
  for (const text of ['Deploy details v2.', 'Deploy details v3.']) {
    await selectRow(page, 'deploy-target');
    await page.getByTestId('memory-edit').click();
    await page.getByTestId('memory-form').waitFor({ timeout: 5000 });
    await fillForm(page, { details: text });
    const before = revisionFiles(base);
    await saveForm(page);
    ids.push(newIds(before, revisionFiles(base))[0]);
  }
  await chooseSection(page, 'revisions');
  await selectRevisionRow(page, ids[0]);
  const refused = await rollbackOpenRevision(page, title);
  const error = (await detailState(page))?.revision?.error;
  record('MEM-09 rolling back the first of two edits is refused and names the later one: “Couldn’t roll back: '
    + '“<abstract>” changed later (You · Changed Facts: <abstract>). Roll back that revision first.”',
  refused === 'error' && error === `Couldn’t roll back: “${DEPLOY}” changed later (${title}). Roll back that `
    + 'revision first.', brief(error));
  await selectRevisionRow(page, ids[1]);
  const first = await rollbackOpenRevision(page, title);
  const top = (await memoryState(page)).revisions[0];
  const v2 = (readText(join(base, 'entries', 'deploy-target.md')) ?? '').includes('Deploy details v2.');
  await selectRevisionRow(page, top.id);
  const second = await rollbackOpenRevision(page, `Rolled back: ${title}`);
  const v3 = (readText(join(base, 'entries', 'deploy-target.md')) ?? '').includes('Deploy details v3.');
  record('MEM-09 a rollback writes one Rollback revision (marked Rollback, by Rollback, rollbackOf the rolled-back '
    + 'one) that can itself be rolled back', first === 'done' && v2 && top.title === `Rolled back: ${title}`
    && top.tags.includes('Rollback') && revisionField(base, top.id, 'rollbackOf') === ids[1]
    && revisionField(base, top.id, 'by') === 'Rollback' && second === 'done' && v3, brief({ first, top, second }));
  record('MEM-08 one rollback writes one revision (the list gains exactly one “Rolled back: …” row each time)',
    first === 'done' && second === 'done' && (await memoryState(page)).revisions[0]?.title
      === `Rolled back: Rolled back: ${title}`, '');
}

/** @brief 回滚。 */
async function rollback(ctx) {
  await focusTab(ctx, ctx.a1);
  await rollbackAddDelete(ctx);
  await rollbackEdit(ctx);
  await rollbackTildes(ctx);
  await rollbackTwice(ctx);
}

// ---------- Revisions 的列表与标记（MEM-08、MEM-09） ----------

/** @brief 项目 B 的 Revisions：最多 200 条、时间倒序；Running、Failed、Rollback 与 No changes；增强运行的 Day 一行。 */
async function markers(ctx) {
  const { page } = ctx;
  await focusTab(ctx, ctx.b1);
  await goMemory(page, 'project', 'revisions');
  const state = await memoryState(page);
  const ids = state.revisions.map((row) => row.id);
  record('MEM-08 the Revisions list shows the newest 200 revisions (210+ in the folder), newest first',
    ids.length === 200 && same(ids, [...ids].sort().reverse()), brief({ count: ids.length, first: ids[0],
      last: ids.at(-1) }));
  const rowOf = (key) => state.revisions.find((row) => row.id === ctx.marks[key].id);
  const time = (key) => monthDayTime(ctx.marks[key].time);
  const want = { done: [time('done'), 'Added 1'], running: [time('running'), 'No changes', 'Running'],
    failed: [time('failed'), 'Changed 1', 'Failed'], rollback: [time('rollback'), 'Changed 1', 'Rollback'],
    nochange: [time('nochange'), 'No changes'] };
  const got = Object.fromEntries(Object.keys(want).map((key) => [key, rowOf(key)?.meta]));
  record('MEM-08 each row has the title, <Mon D> <hh:mm>, the counts (“Added 1”, “Changed 1”, “No changes”) and the '
    + 'marks Running, Failed and Rollback', Object.keys(want).every((key) => same(got[key], want[key])
    && rowOf(key)?.title === ctx.marks[key].title), brief(got));
  await markerDetails(ctx);
}

/** @brief 带标记的修订的详情：增强运行的 Day 一行、依据、Notes；运行中与没有改动的不能回滚。 */
async function markerDetails(ctx) {
  const { page } = ctx;
  const read = async (key) => {
    await selectRevisionRow(page, ctx.marks[key].id);
    return (await detailState(page))?.revision;
  };
  const done = await read('done');
  const { day, earlier } = ctx.markDays;
  record('MEM-08 an enhancement run’s detail has the time and who (“<Mon D> <hh:mm> · Enhancement”), “Day <Mon D> · '
    + '2 sessions · 1 feedback · 38k tokens”, each change as “Added · TASTE · <abstract>” with its Evidence line, and '
    + 'Notes rendered as Markdown', same(done?.metas, [`${monthDayTime(ctx.marks.done.time)} · Enhancement`,
    `Day ${monthDay(day)} · 2 sessions · 1 feedback · 38k tokens`]) && done?.changes[0]?.title
    === 'Added · TASTE · Explain the plan before a large change' && done.changes[0].notes[0]?.startsWith('Evidence: ')
    && done.notes?.includes('No conflicts with entries the user wrote.') && done.rollback?.disabled === false,
  brief({ metas: done?.metas, changes: done?.changes.map((item) => [item.title, item.notes]), notes: done?.notes }));
  const running = await read('running');
  record('MEM-09 a revision whose run is still going (Running) can’t be rolled back (button unavailable); its Day '
    + 'line has no token count yet (“1 session · 0 feedback”)', running?.rollback?.disabled === true
    && running.metas[1] === `Day ${monthDay(day)} · 1 session · 0 feedback`, brief(running));
  const none = await read('nochange');
  record('MEM-08 a revision with no changes can’t be rolled back; its Day line ends with “950 tokens”',
    none?.rollback?.disabled === true && none.metas[1] === `Day ${monthDay(earlier)} · 1 session · 0 feedback · 950 `
      + 'tokens', brief(none?.metas));
  await page.locator(`[data-testid="revision-row"][data-id="${ctx.marks.done.id}"]`).focus();
  await page.keyboard.press('ArrowDown');
  const next = await page.evaluate(() => document.activeElement?.dataset?.id ?? null);
  const state = await memoryState(page);
  const at = state.revisions.findIndex((row) => row.id === ctx.marks.done.id);
  record('MEM-14 ↑ ↓ also move between the rows of the Revisions list', next === state.revisions[at + 1]?.id,
    brief({ next }));
}

// ---------- AGENT 与 Customize 的 AGENTS.md 一节（MEM-16） ----------

/** @brief 记忆页 AGENT 的一行 token 数字（1000 起带千分位的逗号）。 */
const tokensIn = (text) => Number(/^([\d,]+) tokens?$/.exec(text ?? '')?.[1]?.replaceAll(',', '') ?? NaN);

/** @brief 记忆页 AGENT：项目 B（1 token）、项目 A（超出）、User 层。 */
async function agentSection(ctx) {
  const { page } = ctx;
  const results = {};
  for (const [name, tab, folder, content] of [['b', ctx.b1, ctx.p2, P2_AGENTS], ['a', ctx.a1, ctx.p1, P1_AGENTS]]) {
    await focusTab(ctx, tab);
    await goMemory(page, 'project', 'agent');
    const state = await memoryState(page);
    const own = state.agentFiles.find((file) => samePath(file.path, join(resolve(folder), 'AGENTS.md')));
    const sum = state.agentFiles.reduce((total, file) => total + tokensIn(file.tokens), 0);
    results[name] = { files: state.agentFiles, total: state.agentTotal, over: state.agentTotalOver, own, sum,
      want: estimate(content) };
  }
  const { a, b } = results;
  record('MEM-16 AGENT lists the user-level file first and then the files the project loads, each with its own '
    + '“<n> tokens” (“1 token” for 1) equal to §6.3 of its content; project files have Open in default app',
  samePath(a.files[0]?.path, join(ctx.userData, 'pi', 'AGENTS.md'))
    && a.own?.tokens === `${thousands(a.want)} tokens` && a.want >= 1000
    && b.own?.tokens === '1 token' && b.want === 1
    && a.own.buttons.some((item) => item.label === 'Open in default app'),
  brief({ a: a.files, b: b.files }));
  const totalText = (sum) => `${thousands(sum)} / 2,000 tokens${sum > AGENTS_LIMIT ? ` · ${AGENTS_OVER}` : ''}`;
  record('MEM-16 the total “<total> / 2,000 tokens” (thousands with a comma) equals the sum of the rows; over 2,000 '
    + 'it is in the warning colour with “Over 2,000 tokens. Mori doesn’t shorten AGENTS.md; edit the files to keep '
    + 'prompts short.”, otherwise without it',
  a.total === totalText(a.sum) && a.over && a.sum > AGENTS_LIMIT
    && b.total === totalText(b.sum) && b.over === b.sum > AGENTS_LIMIT,
  brief({ a: [a.total, a.sum], b: [b.total, b.sum] }));
  await chooseScope(page, 'user');
  const user = await memoryState(page);
  record('MEM-16 on User, AGENT lists only the user-level file and the total is its tokens',
    user.agentFiles.length === 1 && user.agentTotal === `${estimate(USER_AGENTS)} / 2,000 tokens`,
  brief(user.agentFiles));
  await page.locator('[data-testid="memory-agent-file"] button', { hasText: 'Edit in Customize' }).click();
  const opened = await page.locator('[data-testid="tools-page"] [data-testid="agents-section"]')
    .waitFor({ timeout: 10000 }).then(() => true, () => false);
  const current = await page.locator('[data-testid="tools-nav"] [aria-current="page"]').getAttribute('data-section')
    .catch(() => null);
  record('MEM-16 Edit in Customize opens Customize on its AGENTS.md section (2026-10-26: was Edit in Settings)',
    opened && current === 'agents', brief({ opened, current }));
}

/** @brief Customize 的 AGENTS.md 一节（跟随焦点会话 tab；进入 Customize 就落在这一节）的 token 元素。 */
async function customizeAgents(ctx, tab) {
  const { page } = ctx;
  await focusTab(ctx, tab);
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').getByTestId('agents-section').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="agents-tokens"]').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="agents-loaded"] .agents-path').first().waitFor({ timeout: 10000 });
  return page.evaluate(() => {
    const text = (el) => el?.textContent ?? null;
    return { effective: text(document.querySelector('[data-testid="agents-effective"]')),
      tokens: text(document.querySelector('[data-testid="agents-tokens"]')),
      paths: [...document.querySelectorAll('[data-testid="agents-loaded"] .agents-path')].map(text),
      counts: [...document.querySelectorAll('[data-testid="agents-loaded"] .agents-tokens')].map(text),
      over: text(document.querySelector('[data-testid="agents-over"]')) };
  });
}

/** @brief Customize 的 AGENTS.md 一节的 token 与超出说明；agents.get 的新字段。 */
async function customizeChecks(ctx) {
  const a = await customizeAgents(ctx, ctx.a1);
  const b = await customizeAgents(ctx, ctx.b1);
  const userPath = join(ctx.userData, 'pi', 'AGENTS.md');
  const own = (state, folder) => state.counts[state.paths.findIndex((path) => samePath(path,
    join(resolve(folder), 'AGENTS.md')))];
  record('MEM-16 Customize › AGENTS.md shows the same token counts in their own elements: agents-tokens after the '
    + 'effective file (whose text stays “In effect: <path>”), .agents-tokens on each loaded file',
  samePath(a.effective, `In effect: ${userPath}`) && a.tokens === `${estimate(USER_AGENTS)} tokens`
    && own(a, ctx.p1) === `${thousands(estimate(P1_AGENTS))} tokens` && own(b, ctx.p2) === '1 token'
    && a.paths.every((path) => !/token/.test(path)), brief({ a, b }));
  const sum = (state) => tokensIn(state.tokens) + state.counts.reduce((total, item) => total + tokensIn(item), 0);
  record('MEM-16 Customize › AGENTS.md shows agents-over with the same text when the total is over 2,000 (project A) '
    + 'and not otherwise (project B)', a.over === AGENTS_OVER
    && (sum(b) > AGENTS_LIMIT ? b.over === AGENTS_OVER : b.over === null),
  brief({ a: a.over, b: b.over, sumB: sum(b) }));
  const session = await userSession(ctx, ctx.a1);
  const info = await bridge(ctx, { type: 'agents.get', sessionId: session.sessionId });
  const loadedOk = Array.isArray(info.loaded) && info.loaded.every((item) => typeof item.path === 'string'
    && Number.isInteger(item.tokens));
  record('MEM-16 agents.get returns loaded as { path, tokens }[], userTokens and total = userTokens + the loaded '
    + 'tokens', loadedOk && info.userTokens === estimate(USER_AGENTS) && info.total === info.userTokens
    + info.loaded.reduce((total, item) => total + item.tokens, 0), brief({ loaded: info.loaded,
    userTokens: info.userTokens, total: info.total }));
}

/** @brief AGENT 与 Customize 的 AGENTS.md 一节。 */
async function agents(ctx) {
  await agentSection(ctx);
  await customizeChecks(ctx);
}

// ---------- 增强运行中（MEM-14、MEM-08、MEM-09） ----------

/** @brief 测试准备（synthetic）：增强脚本：TASTE 先用 memory 存一条（依据是项目 A 的会话），再等 15 秒回复。 */
function writeRunScript(ctx, session) {
  const entry = readJsonl(session).find((item) => item.type === 'message' && item.message?.role === 'user')?.id;
  writeFileSync(ctx.scriptFile, `${JSON.stringify({
    taste: [{ call: 'memory', args: { action: 'save', abstract: RUN_ENTRY, detail: 'Learned in the synthetic run.',
      evidence: [{ session, entry, quote: 'plain hello from project A' }] } },
    { say: 'TASTE run summary: added one entry.', wait: 15000 }],
    strategy: [{ say: 'No STRATEGY changes.' }], review: [{ say: 'No REVIEW changes.' }],
  }, null, 2)}\n`);
  return entry;
}

/** @brief Run now 之后：Revisions 里出现 Running 的那一行（mori.memory_changed 刷新），选中它看详情。 */
async function runStarts(ctx) {
  const { page } = ctx;
  const title = `TASTE enhancement · ${monthDay(ctx.p1Day)}`;
  await page.getByTestId('enhance-run').click();
  const row = await poll(async () => (await memoryState(page)).revisions.find((item) => item.title === title
    && item.tags.includes('Running')), 30000, 100);
  ctx.runId = row?.id ?? null;
  if (!row) throw new Error(`no running row "${title}"`);
  await selectRevisionRow(page, row.id);
  const rev = (await detailState(page))?.revision;
  record('MEM-14 while an enhancement run is going, Revisions shows its row marked Running without leaving the page '
    + '(re-read on mori.memory_changed)', Boolean(row), brief(row));
  record('MEM-09 the revision of a run that is still going can’t be rolled back (button unavailable)',
    rev?.rollback?.disabled === true && !rev.metas.some((line) => /tokens?$/.test(line)), brief(rev));
}

/** @brief 运行中在记忆页保存一条 TASTE：成功，按调用顺序写在运行写入的那条之后。 */
async function saveDuringRun(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  await chooseSection(page, 'taste');
  await poll(async () => (await memoryState(page)).rows.some((row) => row.title === RUN_ENTRY), 20000, 100);
  const before = revisionFiles(base);
  const saved = await newEntry(page, DURING_RUN);
  const running = revisionField(base, ctx.runId, 'status');
  const pageRevision = newIds(before, revisionFiles(base))[0];
  const titles = indexSlugs(base, 'taste').map((slug) => /abstract: "(.*)"/.exec(readText(join(base, 'entries',
    `${slug}.md`)) ?? '')?.[1]);
  record('MEM-08 a Memory-page save while an enhancement run is writing goes through, in call order: the run’s entry '
    + 'first, then the page’s, each in its own revision (the run’s still running)', saved === 'saved'
    && running === 'running' && same(titles.slice(-2), [RUN_ENTRY, DURING_RUN]) && pageRevision > ctx.runId
    && revisionField(base, pageRevision, 'title') === `You · Added TASTE: ${DURING_RUN}`,
  brief({ saved, running, titles: titles.slice(-3), pageRevision, run: ctx.runId }));
}

/** @brief 运行结束：Revisions 里那一行不再标 Running（mori.memory_changed 刷新），详情有 token 与 Notes。 */
async function runEnds(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  await chooseSection(page, 'revisions');
  await selectRevisionRow(page, ctx.runId);
  const marks = [];
  const ended = await poll(async () => {
    const row = (await memoryState(page)).revisions.find((item) => item.id === ctx.runId);
    marks.push(row?.tags.join(',') ?? 'gone');
    return row && !row.tags.includes('Running') ? row : null;
  }, 90000, 250);
  await waitDetail(page);
  const rev = await poll(async () => {
    const value = (await detailState(page))?.revision;
    return value?.metas.some((line) => /tokens?$/.test(line)) ? value : null;
  }, 10000, 200);
  record('MEM-14 when the run ends, its Revisions row is no longer marked Running (re-read on mori.memory_changed, '
    + 'selection kept) and the open detail is re-read (token count and Notes)', Boolean(ended)
    && revisionField(base, ctx.runId, 'status') === 'done' && ended.pressed === 'true'
    && rev?.notes === 'TASTE run summary: added one entry.', brief({ ended, marks: [...new Set(marks)],
    metas: rev?.metas, notes: rev?.notes }));
  record('MEM-08 the run’s revision holds only the run’s change (Added 1); the page save has its own',
    same(revisionField(base, ctx.runId, 'counts'), { added: 1, changed: 0, deleted: 0, moved: 0 }), '');
}

/** @brief 回滚增强运行的修订：条目恢复，enhance.json 的水位、doneThrough、feedbackSeen 不动。 */
async function runRollback(ctx) {
  const { page } = ctx;
  const base = baseOf(ctx, 'p1');
  const idle = await poll(async () => {
    const info = await bridge(ctx, { type: 'enhance.get', cwd: ctx.p1 });
    return info.running === null && info.queued === 0;
  }, 90000, 500);
  const read = () => JSON.parse(readText(join(base, 'enhance.json')) ?? '{}').tasks;
  const before = read();
  const title = `TASTE enhancement · ${monthDay(ctx.p1Day)}`;
  await selectRevisionRow(page, ctx.runId);
  const outcome = await rollbackOpenRevision(page, title);
  const after = read();
  const slugs = indexSlugs(base, 'taste');
  const keep = (tasks) => Object.fromEntries(Object.entries(tasks ?? {}).map(([task, state]) => [task,
    { doneThrough: state.doneThrough, watermarks: state.watermarks, feedbackSeen: state.feedbackSeen }]));
  record('MEM-09 rolling back an enhancement run restores its entries and leaves the watermarks alone (enhance.json '
    + 'watermarks, doneThrough and feedbackSeen unchanged)', idle && outcome === 'done'
    && Object.keys(before?.taste?.watermarks ?? {}).length > 0 && same(keep(after), keep(before))
    && slugs.every((slug) => !(readText(join(base, 'entries', `${slug}.md`)) ?? '').includes(RUN_ENTRY)),
  brief({ idle, outcome, watermarks: before?.taste?.watermarks }));
}

/** @brief 增强运行中与结束后。 */
async function run(ctx) {
  const { page } = ctx;
  await focusTab(ctx, ctx.a1);
  const session = (await userSession(ctx, ctx.a1)).sessionFile;
  const entry = writeRunScript(ctx, session);
  if (!entry) throw new Error(`no user message in ${session}`);
  await goMemory(page, 'project', 'revisions');
  await runStarts(ctx);
  await saveDuringRun(ctx);
  await runEnds(ctx);
  await runRollback(ctx);
}

// ---------- 后台进程退出（MEM-33） ----------

/** @brief 测试准备（synthetic）：项目 B 的增强开着、有一条待显示的提示（新建会话时取走）。 */
function seedP2Notice(ctx) {
  const time = hhmm(Date.now() - 2 * 60 * 60 * 1000);
  const day = dayOf(Date.now(), time);
  const runDay = ctx.markDays.day;
  seedEnhance(ctx.userData, ctx.p2, enhanceJson({ enabled: true, pick: PROVIDER, thinking: 'off', time, since: day,
    doneThrough: addDays(day, -1), notice: { revisions: [ctx.marks.done.id], counts: { taste: 1, strategy: 0,
      review: 0 }, from: runDay, to: runDay } }));
}

/** @brief 打开最后一条回复的反馈表单，读底部说明，再关掉。 */
async function feedbackNoteOf(ctx, tab) {
  const { page } = ctx;
  await page.locator(paneSel(tab)).getByRole('button', { name: 'Give feedback' }).last().click();
  await page.getByTestId('feedback-form').waitFor({ timeout: 5000 });
  const note = await feedbackNote(page);
  await page.getByTestId('feedback-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('feedback-form').waitFor({ state: 'detached', timeout: 5000 });
  return note;
}

/** @brief 等后台进程重新连上（点 Restart 之后）：退出横幅不在、左栏 Memory 可用。 */
async function waitRestarted(page) {
  await page.waitForFunction(() => {
    const visible = [...document.querySelectorAll('[data-testid="kernel-exit"]')].some((el) => el.checkVisibility());
    return !visible && document.querySelector('[data-testid="nav-memory"]')?.disabled === false;
  }, null, { timeout: 60000 });
}

/** @brief 对话里：新会话的提示、memory 工具卡、反馈说明；结束后台进程后它们不可用或按没开写。 */
async function killInChat(ctx) {
  const { page } = ctx;
  seedP2Notice(ctx);
  ctx.b2 = await newSessionIn(ctx, ctx.b1);
  const notice = page.locator(`${paneSel(ctx.b2)} [data-testid="memory-notice"]`);
  await notice.waitFor({ timeout: 10000 });
  await chat(ctx, ctx.b2, `call tool: memory {"action":"save","kind":"fact","abstract":"${TOOL_FACT}","detail":`
    + '"Run make at the root.","quote":"P2 builds with make, note it"}');
  const card = (await toolCardsOf(ctx, ctx.b2)).find((item) => item.verb === 'Save to Facts');
  const control = (css) => page.locator(`${paneSel(ctx.b2)} ${css}`).first().evaluate((el) => ({
    disabled: el.disabled, hover: el.getAttribute('title') ?? '' })).catch(() => null);
  const live = { card, view: await control('[data-testid="tool-memory-view"]'),
    noticeView: await control('[data-testid="memory-notice-view"]'), note: await feedbackNoteOf(ctx, ctx.b2) };
  killTbKernel(ctx);
  await page.locator(`${paneSel(ctx.b2)} [data-testid="kernel-exit"]`).waitFor({ timeout: 20000 });
  const dead = { nav: await page.getByTestId('nav-memory').evaluate((el) => ({ disabled: el.disabled,
    hover: el.getAttribute('title') })), view: await control('[data-testid="tool-memory-view"]'),
  noticeView: await control('[data-testid="memory-notice-view"]'), dismiss: await control('[data-action="dismiss"]'),
  note: await feedbackNoteOf(ctx, ctx.b2) };
  record('MEM-33 before the background process exits the controls work (Save to Facts card done with View in Memory, '
    + 'the new-session notice’s View, the feedback note for a project with enhancement on)', card?.status === 'done'
    && live.view?.disabled === false && live.noticeView?.disabled === false && live.note === FEEDBACK_ON, brief(live));
  record('MEM-33 after the background process exits: Memory in the sidebar is unavailable with the hover “Mori’s '
    + 'background process crashed. Restart it to continue.”', crashedControl(dead.nav), brief(dead.nav));
  record('MEM-33 the memory tool card’s View in Memory and the notice’s View are unavailable with the same hover',
    crashedControl(dead.view) && crashedControl(dead.noticeView), brief(dead));
  record('MEM-33 the feedback form’s note says enhancement is off while the background process is down', dead.note
    === FEEDBACK_OFF, brief(dead.note));
  await page.locator(`${paneSel(ctx.b2)} [data-testid="kernel-exit"] button`, { hasText: 'Restart' }).click();
  await waitRestarted(page);
}

/** @brief 记忆页上所有操作都不可用（同样的悬停），页面保留最后读到的内容，只有已有的全局横幅。 */
async function deadPageChecks(ctx, before) {
  const { page } = ctx;
  const state = await memoryState(page);
  const open = await detailState(page);
  const controls = [['user', state.user], ['project', state.project], ...state.sections.map((item) => [item.id, item]),
    ...state.rows.map((row) => [`row ${row.id}`, row]), ['new', state.newEntry], ['last', state.last],
    ...state.enhanceControls.map((item) => [item.id, item]), ...Object.entries(open?.actions ?? {}),
    ...(open?.evidence ?? []).map((item, index) => [`jump ${index}`, item.jump]),
    ...(open?.history?.revisions ?? []).map((item, index) => [`history ${index}`, item])];
  const bad = controls.filter(([, control]) => !crashedControl(control)).map(([name, control]) => [name, control]);
  record('MEM-33 on the Memory page every operation becomes unavailable with the hover “Mori’s background process '
    + 'crashed. Restart it to continue.” (layer, sections, rows, New entry, Last change, enhancement block, Edit, '
    + 'Delete…, Move, Jump to source, History links)', controls.length > 15 && bad.length === 0,
  brief({ count: controls.length, bad }));
  const banners = await page.evaluate(() => [...document.querySelectorAll('[data-testid="kernel-exit"]')]
    .filter((el) => el.checkVisibility()).map((el) => ({ global: Boolean(el.closest('.global-banner')),
      text: el.textContent })));
  record('MEM-33 the page keeps what it last read, and the only banner is the existing global one (“Mori’s background '
    + 'process crashed · Unfinished responses were interrupted” with Restart); the Memory page adds none',
  same(state.rows.map((row) => row.id), before.rows) && open?.title === before.title && banners.length === 1
    && banners[0].global && banners[0].text.startsWith('Mori’s background process crashed · Unfinished responses were '
      + 'interrupted') && state.banners === 0, brief({ banners, inPage: state.banners }));
  const nav = await page.getByTestId('nav-memory').evaluate((el) => ({ disabled: el.disabled,
    hover: el.getAttribute('title') }));
  record('MEM-33 Memory in the sidebar is unavailable while on the page too', crashedControl(nav), brief(nav));
}

/** @brief 测试准备（synthetic hand edit，后台进程不在时改文件）：改开着的那条的 Details，加一条 hand-added。 */
function editWhileDown(ctx, slug) {
  const base = baseOf(ctx, 'p2');
  const file = join(base, 'entries', `${slug}.md`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Run make at the root.',
    'Changed on disk while Mori was down.'));
  writeFileSync(join(base, 'entries', 'hand-added.md'), detailText({ kind: 'fact', abstract: 'Hand-added while down',
    source: 'user', created: '2026-10-18 · You', modified: '2026-10-18 · You', details: 'Synthetic hand edit.' }));
  writeFileSync(join(base, 'MEMORY.md'), `${readFileSync(join(base, 'MEMORY.md'), 'utf8')}- [Hand-added while down]`
    + '(entries/hand-added.md)\n');
}

/** @brief 删除确认框是否开着（memory-delete-dialog 在页面里）。 */
const deleteConfirmOpen = async (page) => (await page.getByTestId('memory-delete-dialog').count()) > 0;

/** @brief 后台进程退出时开着的删除确认框：自己关闭（没在删除中），Delete… 不可用、悬停是退出的说明。 */
async function confirmClosedOnExit(ctx, opened) {
  const { page } = ctx;
  const closed = await page.getByTestId('memory-delete-dialog').waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  const remove = (await detailState(page))?.actions.delete;
  record('MEM-33 a delete confirm that is open when the background process exits closes by itself (no delete was in '
    + 'progress); Delete… is then unavailable with the hover “Mori’s background process crashed. Restart it to '
    + 'continue.”', opened && closed && crashedControl(remove), brief({ opened, closed, remove }));
}

/** @brief 在记忆页上结束后台进程：操作不可用、只有全局横幅；Restart 后重读当前层、分节与开着的详情。 */
async function killOnPage(ctx) {
  const { page } = ctx;
  await focusTab(ctx, ctx.b2);
  await goMemory(page, 'project', 'facts');
  const slug = (await memoryState(page)).rows.find((row) => row.title === TOOL_FACT)?.id;
  await selectRow(page, slug);
  const ready = await poll(async () => (await detailState(page))?.evidence[0]?.jump?.disabled === false, 10000, 100);
  const before = { rows: (await memoryState(page)).rows.map((row) => row.id),
    title: (await detailState(page))?.title };
  await page.getByTestId('memory-delete').click();
  const opened = await page.getByTestId('memory-delete-dialog').waitFor({ timeout: 5000 })
    .then(() => true, () => false);
  killTbKernel(ctx);
  await page.locator('.global-banner [data-testid="kernel-exit"]').waitFor({ timeout: 20000 });
  await confirmClosedOnExit(ctx, opened);
  await sleep(300);
  record('MEM-33 before the exit, Jump to source of the tool’s entry was available (so the exit is what disables it)',
    ready, '');
  await deadPageChecks(ctx, before);
  editWhileDown(ctx, slug);
  await page.locator('.global-banner [data-testid="kernel-exit"] button', { hasText: 'Restart' }).click();
  await waitRestarted(page);
  const reread = await poll(async () => {
    const state = await memoryState(page);
    const open = await detailState(page);
    return state.rows.some((row) => row.id === 'hand-added')
      && open?.details === 'Changed on disk while Mori was down.'
      ? { section: state.section, scope: state.scope, folder: state.folderTitle } : null;
  }, 60000, 250);
  record('MEM-33 after Restart the page re-reads the current layer, section and open detail (after the followed '
    + 'session reopens): the list has the entry added on disk meanwhile and the detail shows the changed Details',
  Boolean(reread) && reread.scope === 'project' && reread.section === 'facts' && samePath(reread.folder, ctx.p2),
  brief(reread ?? await memoryState(page)));
  const enabled = await page.getByTestId('memory-new').evaluate((el) => !el.disabled);
  record('MEM-33 after Restart the page operations work again', enabled, '');
  const kept = existsSync(join(baseOf(ctx, 'p2'), 'entries', `${slug}.md`));
  record('MEM-33 after Restart the delete confirm doesn’t open again by itself and the entry was not deleted',
    !(await deleteConfirmOpen(page)) && kept && Boolean(reread), brief({ open: await deleteConfirmOpen(page), kept }));
}

// ---------- 跟随的会话还在打开（MEM-14） ----------

/** synthetic 项目扩展加载时先等的毫秒数：会话在这期间是“正在启动…”（同 m3-app-live 的做法） */
const SLOW_OPEN_MS = 10000;

/** @brief 测试准备（synthetic）：项目 D 的项目扩展，工厂函数先等 SLOW_OPEN_MS，什么都不注册。 */
function writeSlowExtension(project) {
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'slow-open.ts'), [
    '// synthetic: written by tests/ui/mem-app-page.mjs; loading waits so the session stays "Starting…" for a while.',
    'export default async function () {',
    `  await new Promise((done) => setTimeout(done, ${SLOW_OPEN_MS}));`,
    '}', ''].join('\n'));
}

/** @brief 会话面板输入框旁的说明（还在打开时 `Starting…`）；没有说明时为 null。 */
const paneWait = (page, tab) => page.locator(`${paneSel(tab)} [data-testid="not-ready"]`).first()
  .textContent({ timeout: 500 }).catch(() => null);

/**
 * @brief 打开项目 D（信任并记住），返回新会话的标识，等它打开好。分屏时新会话的一栏先出现、信任询问后到，
 *        openProject 会在询问出现之前返回（它取的是左边那一栏），所以询问在这里回答、新会话按新出现的一栏找。
 */
async function openSlowProject(ctx) {
  const { page } = ctx;
  const slots = () => page.locator('.pane-slot').evaluateAll((els) => els.map((el) => el.dataset.tab));
  const known = await slots();
  await openProject(ctx, ctx.p4, { trust: true });
  const dialog = page.getByTestId('trust-dialog');
  if (await dialog.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await dialog.getByRole('checkbox', { name: 'Remember my choice' }).check();
    await dialog.getByRole('button', { name: 'Trust workspace', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
  }
  const tab = (await slots()).find((key) => !known.includes(key));
  if (!tab) throw new Error('no new session pane for project D');
  await poll(async () => (await paneWait(page, tab)) === null, 60000, 250);
  return tab;
}

/** @brief 记忆页此刻的列表与 New entry（检查用的几项）。 */
async function listHead(page) {
  const state = await memoryState(page);
  return { scope: state.scope, folder: state.folderTitle, rows: state.rows.map((row) => row.id), states: state.states,
    reading: state.reading, newEntry: state.newEntry && { disabled: state.newEntry.disabled } };
}

/** @brief User 层的 New entry 在跟随的会话还在打开时点得开：表单出现，再 Cancel（没改动，不问）。 */
async function newEntryOpens(page) {
  await page.getByTestId('memory-new').click();
  const opened = await page.getByTestId('memory-form').waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (opened) await page.getByTestId('memory-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await waitDetail(page, false, 5000).catch(() => {});
  return opened;
}

/**
 * @brief 跟随的会话还在打开（Restart 之后重新打开，项目扩展加载要等）：Project 已有列表时保留、New entry 等它；
 *        User 不等，照常读、New entry 可用；打开好之后 Project 的 New entry 也可用。
 */
async function stillOpening(ctx) {
  const { page } = ctx;
  ctx.p4 = tempProject('mori-mem-page-d-');
  writeSlowExtension(ctx.p4);
  if (await page.getByTestId('memory-page').count()) await backToApp(page);
  ctx.d1 = await openSlowProject(ctx);
  await goMemory(page, 'project', 'facts');
  const live = await listHead(page);
  killTbKernel(ctx);
  await page.locator('.global-banner [data-testid="kernel-exit"]').waitFor({ timeout: 20000 });
  await page.locator('.global-banner [data-testid="kernel-exit"] button', { hasText: 'Restart' }).click();
  await waitRestarted(page);
  await waitLoaded(page);
  const project = { wait: await paneWait(page, ctx.d1), ...await listHead(page) };
  await chooseScope(page, 'user');
  const user = { wait: await paneWait(page, ctx.d1), ...await listHead(page) };
  const opens = await newEntryOpens(page);
  const after = await paneWait(page, ctx.d1);
  const users = userFacts().map((item) => item.slug).filter((slug) => user.rows.includes(slug));
  record('MEM-14 while the followed session is still opening (“Starting…” after Restart), Project keeps the list it '
    + 'had (“No entries yet.”) and New entry waits for the session (unavailable)', live.newEntry?.disabled === false
    && samePath(live.folder, ctx.p4) && samePath(project.folder, ctx.p4)
    && project.wait === 'Starting…' && project.scope === 'project' && same(project.rows, [])
    && project.states.includes('No entries yet.') && project.newEntry?.disabled === true, brief({ live, project }));
  record('MEM-14 while the followed session is still opening, User doesn’t wait: its list is read and New entry is '
    + 'available (the form opens)', user.wait === 'Starting…' && after === 'Starting…' && user.scope === 'user'
    && !user.reading && users.length > 0 && user.newEntry?.disabled === false && opens,
  brief({ user: { ...user, rows: user.rows.length }, users, opens, after }));
  await poll(async () => (await paneWait(page, ctx.d1)) === null, 60000, 250);
  await chooseScope(page, 'project');
  const ready = await listHead(page);
  record('MEM-14 once the followed session has opened, Project’s New entry is available again', ready.scope
    === 'project' && ready.newEntry?.disabled === false && await paneWait(page, ctx.d1) === null, brief(ready));
}

/** @brief 后台进程退出。 */
async function crash(ctx) {
  await killInChat(ctx);
  await killOnPage(ctx);
}

// ---------- 主流程 ----------

/** 步骤与它们主要验收的编号（步骤出错时按这个编号记一条失败） */
const steps = {
  nav: ['MEM-14', nav], follow: ['MEM-14', follow], overLimit: ['MEM-07', overLimit], detail: ['MEM-14', detail],
  refresh: ['MEM-14', refresh], form: ['MEM-14', form], move: ['MEM-09', move], budget: ['MEM-07', budget],
  rollback: ['MEM-09', rollback], markers: ['MEM-08', markers], agents: ['MEM-16', agents], run: ['MEM-14', run],
  crash: ['MEM-33', crash], opening: ['MEM-14', stillOpening],
};

const ctx = { userData: tempUserData('mori-mem-page-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, [id, step]] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[mem-app-page] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${id} step ${name} ran to the end`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
      if (ctx.page && await ctx.page.getByTestId('memory-page').count()) await backToApp(ctx.page).catch(() => {});
    }
  }
} finally {
  record('mem-app-page: the page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[mem-app-page] data in ${ctx.userData}`);
finish();

/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
