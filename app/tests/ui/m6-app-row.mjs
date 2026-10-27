// M6 整机测试（输入框下面一行的行为）：2026-10-21 起选择范围（v1）、Effort、权限按钮和上下文用量圆环在输入框下面一行
// （docs/v0/composer-pickers.md"新加的检查"第 3–9、11 条；状态表 docs/v0/screens/models.md、approval.md、chat.md，
// docs/v1/screens/model-menu.md、model-chat.md）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint，synthetic）：
// 圆环（还没有消息时为空、"Context window"和详情里的说明；有用量时悬停"Context ≈ …k / …k (N%)"、读屏名称
// "Usage: Context approximately … of … tokens (N%)"、读屏的描述没有"/"、没有 title；详情的打开、Esc、点外面、Tab 移走；
// 键盘焦点时显示悬停提示，Esc 先关详情、再藏提示、第三次才停止生成；开着时用量刷新详情跟着变；生成开始时不关；
// ≥ 75%、≥ 90% 的颜色，有填充时底圈是 --color-line、空圆环是 --color-faint；1,000,000 和 999,950 的窗口写成"1M"）；
// 生成中（范围、Effort 仍能 Tab 到、不开菜单、悬停的行和读屏的描述是原因）；切换中两个按钮都带 data-pending；
// 准备中（v1：被限流的提供商，"Waiting for a model"）这一行在各档的样子（单栏 300–930px，分屏 279 / 280px）、单个"Queue"、
// 原因与占位文字；
// 提供商范围"Mori endpoint · fake-coder"的截短（> 680px 完整，600px 先截模型 id，280px 最挤时 36px）；
// 菜单（很短的模型 id "o3" 在 930px 和 680px 时范围菜单右边对齐按钮或贴这一行左端，四个弹出层往上打开、在面板里；
// 800×600、草稿 220px 高时菜单不出窗口、不盖顶栏、最高不变；30 条"Allowed for this session"时权限菜单在菜单里滚动；
// 同时只开一个；Tab 移出时关、F8 不关、点菜单里的文字不关；菜单里 Enter 只选项、不发送）；
// 自动关（发送后进入准备中、生成开始时范围菜单关、圆环详情不关；排队的消息开始新的一轮时权限菜单不关；清空草稿时"Queue"的
// 下拉关；拒绝启动卡出现、消失时范围菜单不关）；新的批准卡来了（权限菜单关、焦点回到按钮、Alt+1 答了这张卡；圆环详情关、
// Alt+1 答了）；菜单开着时 Alt+1、Ctrl+N 不起作用，圆环详情开着时 Ctrl+N 照常；按钮消失时焦点回到文字框（"Stop"、"Queue"、
// ▾、"Send"）；权限按钮只有文字、两种模式的悬停和读屏的描述、"Full access"的对比度；F8 的"Current view"里"Model range"、
// "Effort"和"Pane width"；新加的浮层没有小于 12px 的字。
// 各档的边界、截短的先后、拒绝启动、后台进程退出和打开失败时这一行的样子在 m6-app-slash.mjs；Effort 菜单的内容在
// m6-app-settings.mjs；换范围失败那一行在 m6-replay.mjs（回放桥 failNext）。
// 与原设计不同（按最接近的做，见检查的说明）：生成中范围菜单打不开（批准卡只在生成中来），"开着范围菜单时来了批准卡"改用
// 权限菜单；"刚压缩完"的圆环由 m1-app.mjs 的 ringCompacted 覆盖（这里关掉了 pi 的自动压缩；m1-replay 的 compaction 录制里
// 看不到这个状态）。
// synthetic 的做法：生成开始、发送进入准备中的两条要在焦点和菜单都不动的情况下开始：生成开始经 window.mori 直接让后台进程
// session.prompt，发送是在文字框上派发 Enter 的 keydown（焦点不动，走界面同一条路）；拒绝启动卡的出现、消失经 window.mori 的
// models.setDefaults 清空、恢复所有项目默认允许的区域。测试准备：启动前在 pi 的 settings.json 里关掉自动压缩（圆环的颜色要
// 用很小的上下文窗口，自动压缩会马上压掉）；用户级 mcp.json 里写 5 个合成 MCP 服务（tests/mcp-server，MORI_MCP_EXTRA=1，
// 每个 6 个工具），用来攒 30 条"Allowed for this session"；第二个合成端点对它的 key 一直回 429（准备中等模型）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-row.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m6-app-row(-packaged).json，截图在 test-results/m6-app-row(-packaged)/。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, ctrlN, kernelOpen, openRow, PANE, paneOf, sendWait, settle, STOPPED, waitIdle, waitPanes, waitReady,
  waitRunning,
} from './m3-helpers.mjs';
import { composerAt, sendAt, slotSelector, waitSplit } from './m5-helpers.mjs';
import {
  addModelUi, at1, backToApp, buttonState, choosePick, colorStack, contrastOf, firstRunAndOpen, fitLeft, fitPane,
  layoutBrief, layoutReport, menuGone, NOTE, noteSmallIn as noteSmall, openAndPlace, openSettingsSection,
  paneProblems, paneWidth, placeProblems, popupBox, popupGone, POPUPS, providerCard, resizeWindow,
  RING_NOTE, ringState, ringTexts, ROW, seenRows, setDefaultPick, splitOpen, startFakeEndpoint, tokenColors,
  waitVerified, watchRows,
} from './m6-helpers.mjs';
import { fetchIn, pageHelpers, pickIn, PROVIDER_FORM } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const port = 4364;
const baseUrl = `http://127.0.0.1:${port}/v1`;
/** 第二个合成端点（准备中）：它的 key 的对话请求一直回 429 */
const ratePort = 4365;
// 合成端点要求的 key、被限流的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m6-row-not-a-real-key';
const RATE_KEY = 'synthetic-test-key-m6-row-limited-not-real';
const shots = join(appRoot, `test-results/m6-app-row${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 第一个提供商的 id 和它的模型（首次启动表单的默认） */
const MAIN = 'mori-endpoint';
const MODEL = 'fake-coder';
/** 第一个模型的上下文长度（首次启动表单的默认值） */
const WINDOW = 128000;
/** 范围按钮悬停的第二行和读屏的描述（"<提供商名> · <区域>"，" · "换成", "） */
const MODEL_TIP = 'Mori endpoint · Local';
const MODEL_DESCRIBED = 'Mori endpoint, Local';
/** 提供商范围的按钮文字（"<提供商名> · <当前模型 id>"，约 174px，composer-pickers.md"宽度"的表） */
const PROVIDER_TEXT = `Mori endpoint · ${MODEL}`;
/** 准备中用的提供商（第二个合成端点）：名称和生成的 id */
const RATE = { name: 'Rate endpoint', id: 'rate-endpoint' };
/** 量颜色分档时每个新会话发的同一句话（plain 让合成端点只回文字；同一句话、同一个项目，用量相同） */
const RING_PROMPT = 'plain ring color check';
/** 合成 MCP 服务（synthetic）和每个服务的 6 个工具及参数：5 × 6 = 30 条"Allowed for this session" */
const MCP_SERVER = join(appRoot, 'tests', 'mcp-server', 'server.mjs');
const MCP_SERVERS = ['s1', 's2', 's3', 's4', 's5'];
const MCP_CALLS = [['echo', { text: 'hi' }], ['add', { a: 1, b: 2 }], ['pid', {}], ['cwd', {}], ['roots', {}],
  ['slow', { ms: 10, steps: 1 }]];
/** 准备中量的会话面板宽度（各档的上沿和下沿；单栏 800 宽右栏打开时最窄约 300px） */
const PREP_WIDTHS = [930, 740, 681, 680, 601, 600, 490, 461, 460, 401, 400, 370, 341, 340, 321, 320, 300];
/** 布局检查时输入框里的草稿 */
const DRAFT = 'plain draft for the row checks';
/** 这一行里的圆环 */
const RING = `${PANE} ${ROW} [data-testid="usage"]`;
/** @brief 当前一栏这一行里 data-testid 为 testId 的元素的选择器。 */
const IN_ROW = (testId) => `${PANE} ${ROW} [data-testid="${testId}"]`;

// ---------- 准备 ----------

/** @brief 测试用的项目：README 和一个源文件。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-row-'));
  const project = join(root, 'm6row');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used by the M6 row test.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export const one = 1;\n');
  return { root, project };
}

/**
 * @brief 测试准备（synthetic）：用户级 mcp.json 写 5 个合成 MCP 服务（直接暴露工具，每个 6 个工具）；pi 的 settings.json
 *        关掉自动压缩（圆环颜色分档用很小的上下文窗口）。
 */
function writeAgentDir(agentDir) {
  mkdirSync(agentDir, { recursive: true });
  const servers = Object.fromEntries(MCP_SERVERS.map((name) => [name, { command: 'node', args: [MCP_SERVER, name],
    env: { MORI_MCP_EXTRA: '1' }, exposure: 'direct' }]));
  writeFileSync(join(agentDir, 'mcp.json'), `${JSON.stringify({ $comment: 'synthetic: written by '
    + 'tests/ui/m6-app-row.mjs', mcpServers: servers }, null, 2)}\n`);
  writeFileSync(join(agentDir, 'settings.json'), `${JSON.stringify({ compaction: { enabled: false } }, null, 2)}\n`);
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
}

// ---------- 页面上的小工具 ----------

/** @brief 当前一栏的文字框。 */
const composer = (page) => page.locator(`${PANE} .composer textarea`);
/** @brief 当前一栏你的消息条数。 */
const userCount = (page) => page.locator(`${PANE} [data-testid="user-message"]`).count();

/** @brief 焦点所在元素的简称：文字框为"textarea"，否则 data-testid、aria-label、data-pick / data-level 或文字。 */
const focusName = (page) => page.evaluate((selector) => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  if (el === document.querySelector(`${selector} .composer textarea`)) return 'textarea';
  return el.dataset.testid || el.getAttribute('aria-label') || el.dataset.pick || el.dataset.level
    || el.textContent.trim().slice(0, 40);
}, PANE);

/** @brief 从文字框按 n 次 Tab，返回每次焦点所在的元素（focusName）。 */
async function tabFromComposer(page, n) {
  await composer(page).focus();
  const path = [];
  for (let step = 0; step < n; step += 1) {
    await page.keyboard.press('Tab');
    path.push(await focusName(page));
  }
  return path;
}

/** @brief 不动焦点地把当前一栏的草稿改成 text（原生 setter 加 input 事件，同你打字；焦点留在原来的地方）。 */
const setDraft = (page, text) => page.evaluate(({ selector, value }) => {
  const textarea = document.querySelector(`${selector} .composer textarea`);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}, { selector: PANE, value: text });

/**
 * @brief synthetic：不动焦点地从界面发出 text：改草稿后在文字框上派发 Enter 的 keydown（界面的发送走同一条路，界面知道
 *        "发送中"），用来测"发送后进入准备中"时开着的浮层怎样（点"Send"或真按 Enter 都会先让浮层关掉）。
 */
async function sendWithoutFocus(page, text) {
  await setDraft(page, text);
  await page.evaluate((selector) => {
    const textarea = document.querySelector(`${selector} .composer textarea`);
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }, PANE);
}

/**
 * @brief 让后台进程直接在当前会话里 session.prompt（synthetic：焦点和浮层都不动，界面照常收到 pi 的事件），等生成开始。
 *        用来测"生成开始时"浮层怎样（点"Send"或在文字框按 Enter 都会先让浮层因为点外面、Tab 移出而关掉）。
 */
async function kernelPrompt(ctx, text) {
  const { page } = ctx;
  const { sessionId } = await kernelOpen(page, await activeFile(page));
  await page.evaluate(({ id, body }) => {
    void window.mori.request({ type: 'session.prompt', sessionId: id, text: body });
  }, { id: sessionId, body: text });
  await waitRunning(page);
}

/** @brief 点开当前一栏这一行的一个弹出层（POPUPS 的 kind），等它出现。 */
async function openPopup(page, kind) {
  await page.locator(`${PANE} ${ROW} ${POPUPS[kind].opener}`).click();
  await page.locator(POPUPS[kind].popup).waitFor({ timeout: 5000 });
}

/** @brief 这几个弹出层现在开着哪几个。 */
const openPopups = async (page) => {
  const open = [];
  for (const [kind, { popup }] of Object.entries(POPUPS)) if (await page.locator(popup).count()) open.push(kind);
  return open;
};

/** @brief 打开 设置 → Models，等它读完。 */
async function openModels(page) {
  await openSettingsSection(page, 'models');
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
}

/** @brief 在第一个提供商下添加几个模型（ID → 上下文长度），等探针跑完，回到会话。返回每个的 Tool calling。 */
async function addModels(page, models) {
  await openModels(page);
  const results = {};
  for (const [id, contextWindow] of Object.entries(models)) {
    results[id] = await addModelUi(page, MAIN, { id, contextWindow });
  }
  await backToApp(page);
  return results;
}

/** @brief 设置里的默认范围改成 pick，回到会话。 */
async function defaultTo(page, pick) {
  await openModels(page);
  await setDefaultPick(page, pick);
  await backToApp(page);
}

// ---------- 步骤：圆环（models.md"上下文用量（圆环）"） ----------

/** @brief 准备：首次启动填提供商、打开项目（会话 S1，还没有消息），窗口 1200×800（会话面板约 930px）。 */
async function setup(ctx) {
  await resizeWindow(ctx.app, 1200, 800);
  // 圆环的检查按 128,000 的窗口写；拉取后清单行是合成端点报告的 131072，在清单行里改（model-discovery.md §6.2）
  await firstRunAndOpen(ctx, { baseUrl, apiKey: testKey, project: ctx.project, contextWindow: WINDOW });
  ctx.s1 = await activeFile(ctx.page);
  ctx.colors = await tokenColors(ctx.page, ['--color-faint', '--color-line', '--color-accent', '--color-warn-text',
    '--color-danger']);
}

/** @brief 还没有消息时的圆环：空圆环（实线的 --color-faint 底圈，没有填充），"Context window"和详情里的说明。 */
function recordEmptyRing(ctx, empty) {
  record('还没有消息（新会话）：圆环在、为空（data-state="empty"、data-tokens="0"、data-percent="0"），读屏名称"Context window"，'
    + '读屏的描述"Send a message to see context usage."，没有 title（悬停是自画的提示）；不显示"0%"或"<1%"',
  empty?.state === 'empty' && empty.tokens === '0' && empty.percent === '0' && empty.name === 'Context window'
    && empty.described === RING_NOTE.empty && empty.title === null && !/%/.test(`${empty.name}${empty.described}`),
  JSON.stringify(empty));
  record('空圆环只有实线的底圈，颜色是 --color-faint（没有填充）；按钮约 26px 宽', empty?.base?.stroke
    === ctx.colors['--color-faint'].stroke && !empty.base.dashed && empty.fill === null
    && Math.abs(empty.width - 26) <= 1,
  JSON.stringify({ base: empty?.base, fill: empty?.fill, width: empty?.width, faint: ctx.colors['--color-faint'] }));
}

/**
 * @brief 还没有消息的会话 S1：圆环为空；Tab 到圆环时显示悬停提示"Context window"（aria-hidden），Esc 藏起、焦点留在圆环；
 *        Enter 打开详情（aria-expanded、aria-controls 指向它，左边"Context window"、条的位置是说明，焦点留在圆环），
 *        Esc 关上（aria-controls 不再有）。
 */
async function ringEmpty(ctx) {
  const { page } = ctx;
  const empty = await ringState(page);
  recordEmptyRing(ctx, empty);
  await page.mouse.move(0, 0);
  const path = await tabFromComposer(page, 4);
  const tipped = await ringState(page);
  await noteSmall(ctx, '圆环的悬停提示', '[data-testid="usage-tip"]');
  await page.keyboard.press('Escape');
  const hidden = await ringState(page);
  await page.keyboard.press('Enter');
  await page.getByTestId('usage-details').waitFor({ timeout: 5000 });
  const open = await ringState(page);
  await noteSmall(ctx, '圆环详情（还没有消息）', '[data-testid="usage-details"]');
  await shot(page, 'ring-empty-details');
  await page.keyboard.press('Escape');
  const closed = await ringState(page);
  record('从文字框 Tab 依次到权限 → 范围 → Effort → 圆环；键盘焦点落在圆环上时显示悬停提示"Context window"（aria-hidden），'
    + 'Esc 藏起提示、焦点留在圆环', path.join() === 'permission-button,model-button,thinking-button,usage'
    && tipped?.tip?.text === 'Context window' && tipped.tip.hidden === 'true' && hidden?.tip === null && hidden.focused,
  JSON.stringify({ path, tip: tipped?.tip, hidden: hidden?.tip, focused: hidden?.focused }));
  record('圆环上按 Enter 打开详情：aria-expanded 为 true、aria-controls 指向详情；左边"Context window"，右边空着、条的位置是'
    + '"Send a message to see context usage."（没有 4px 的条）；焦点留在圆环。Esc 关上，aria-controls 不再有',
  open?.expanded === 'true' && open.controlsDetails && open.details?.text.includes('Context window')
    && open.details.text.includes(RING_NOTE.empty) && !open.details.text.includes('%') && open.details.bars.length === 0
    && open.focused && closed?.expanded === 'false' && closed.controls === null && closed.details === null
    && closed.focused, JSON.stringify({ open, closed }));
}

/** @brief 有用量时圆环应有的样子不符合的地方（models.md"有用量"）；颜色另查。 */
function usedProblems(ring, contextWindow) {
  const tokens = Number(ring?.tokens);
  const percent = Math.round((tokens / contextWindow) * 100);
  const texts = ringTexts(tokens, contextWindow, percent);
  const problems = [];
  if (ring?.state !== 'used' || !(tokens > 0) || ring.percent !== String(percent)) {
    problems.push(`data ${ring?.state}/${ring?.tokens}/${ring?.percent}, want ${percent}%`);
  }
  if (ring?.name !== texts.name) problems.push(`name "${ring?.name}" want "${texts.name}"`);
  if (ring?.title !== null || (ring?.described ?? '').includes('/')) problems.push('title or "/" in the description');
  return { problems, texts, percent };
}

/**
 * @brief 发一条消息后的圆环（S1）：data-tokens 是 pi 给的数、data-percent 四舍五入；读屏名称"Usage: Context approximately
 *        … of 128,000 tokens (N%)"、描述里没有"/"、没有 title；悬停提示"Context ≈ …k / 128k (N%)"；底圈 --color-line、
 *        填充强调色；点开详情（左边"Context window"，右边 summary，4px 的条是强调色）；点外面关闭、Shift+Tab 移走也关闭。
 */
async function ringUsed(ctx) {
  const { page } = ctx;
  await sendWait(ctx, 'plain ring check');
  const used = await ringState(page);
  const { problems, texts, percent } = usedProblems(used, WINDOW);
  await page.locator(RING).hover();
  const hovered = await ringState(page);
  await page.locator(RING).click();
  await page.getByTestId('usage-details').waitFor({ timeout: 5000 });
  const open = await ringState(page);
  await noteSmall(ctx, '圆环详情（有用量）', '[data-testid="usage-details"]');
  await shot(page, 'ring-used-details');
  await paneOf(page).getByTestId('transcript').click({ position: { x: 10, y: 10 } });
  const outside = await popupGone(page, POPUPS.usage.popup);
  await openPopup(page, 'usage');
  await page.keyboard.press('Shift+Tab');
  const tabbed = { gone: await popupGone(page, POPUPS.usage.popup), focus: await focusName(page) };
  const { colors } = ctx;
  record(`发一条消息后圆环有用量：读屏名称"${texts.name}"（data-tokens、四舍五入的 data-percent），读屏的描述里没有"/"，`
    + `没有 title；悬停提示"${texts.tip}"`, problems.length === 0 && percent < 75 && hovered?.tip?.text === texts.tip,
  JSON.stringify({ problems, used, tip: hovered?.tip }));
  record('有用量时底圈是 --color-line、填充是强调色（< 75%），不靠颜色也看得出填到哪里', used?.base?.stroke
    === colors['--color-line'].stroke && used.fill?.stroke === colors['--color-accent'].stroke,
  JSON.stringify({ base: used?.base, fill: used?.fill, line: colors['--color-line'],
    accent: colors['--color-accent'] }));
  record(`点开详情：左边"Context window"，右边"${texts.summary}"，下面一条 4px 的条（强调色）；点外面（对话流）关闭；`
    + 'Shift+Tab 把焦点移到 Effort 按钮也关闭', open?.details?.text.includes('Context window')
    && open.details.text.includes(texts.summary) && open.details.bars.includes(colors['--color-accent'].background)
    && outside && tabbed.gone && tabbed.focus === 'thinking-button', JSON.stringify({ details: open?.details, outside,
    tabbed }));
}

/**
 * @brief 开着详情时：排队的消息送达、本轮结束后用量刷新，详情跟着变；生成开始（经 window.mori 直接 session.prompt，
 *        焦点和详情都不动）时详情不关。
 */
async function ringRefresh(ctx) {
  const { page, h } = ctx;
  const sent = await userCount(page);
  await h.send('wait 3s');
  await waitRunning(page);
  await h.send('plain queued while the details are open');
  await openPopup(page, 'usage');
  const before = await ringState(page);
  await page.waitForFunction(({ selector, n }) => document.querySelectorAll(`${selector} [data-testid="user-message"]`)
    .length >= n, { selector: PANE, n: sent + 2 }, { timeout: 30000 });
  await waitIdle(page, 60000);
  const after = await ringState(page);
  const want = usedProblems(after, WINDOW);
  record('开着圆环详情时用量刷新（排队的消息送达、本轮结束），详情跟着变：右边是新的 summary，data-tokens 变大；详情一直开着',
    Number(after?.tokens) > Number(before?.tokens) && Boolean(after?.details) && want.problems.length === 0
    && after.details.text.includes(want.texts.summary), JSON.stringify({ before: before?.details, after: after?.details,
    tokens: [before?.tokens, after?.tokens] }));
  await kernelPrompt(ctx, 'wait 2s');
  const running = await ringState(page);
  await waitIdle(page, 60000);
  record('生成开始时圆环详情不关（models.md"什么时候自动关"：圆环详情在生成开始时不关）', Boolean(running?.details)
    && running.expanded === 'true', JSON.stringify(running));
  await page.keyboard.press('Escape');
  await popupGone(page, POPUPS.usage.popup);
}

/**
 * @brief 生成中 Esc 的顺序（chat.md"Esc 的顺序"、models.md）：Tab 到圆环（提示显示）、Enter 打开详情；Esc 关详情（不停止），
 *        Esc 藏起提示（不停止，焦点留在圆环），第三次 Esc 才停止生成。
 */
async function ringEsc(ctx) {
  const { page, h } = ctx;
  await h.send('wait 8s');
  await waitRunning(page);
  await page.mouse.move(0, 0);
  await tabFromComposer(page, 4);
  const running = () => page.evaluate((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE);
  const seen = [{ ...(await ringState(page)), running: await running() }];
  await page.keyboard.press('Enter');
  await page.getByTestId('usage-details').waitFor({ timeout: 5000 });
  for (let n = 0; n < 3; n += 1) {
    seen.push({ ...(await ringState(page)), running: await running() });
    await page.keyboard.press('Escape');
    await settle(page);
  }
  await waitIdle(page, 30000);
  const stopped = await paneOf(page).getByTestId('notice').filter({ hasText: STOPPED }).count();
  const [focused, opened, afterOne, afterTwo] = seen;
  record('生成中：Tab 到圆环时显示提示，Enter 打开详情；Esc 先关详情（还在生成、提示又显示），再 Esc 藏起提示（还在生成、'
    + '焦点留在圆环），第三次 Esc 才停止生成（"Stopped"，"wait 8s" 没有等完）', Boolean(focused?.tip) && Boolean(opened?.details)
    && afterOne.details === null && Boolean(afterOne.tip) && afterOne.focused && afterOne.running
    && afterTwo.tip === null && afterTwo.focused && afterTwo.running && stopped > 0, JSON.stringify({ seen, stopped }));
}

/**
 * @brief 颜色分档（照 Claude：< 75% 强调色、75–89% 较深的警示色 --color-warn-text、≥ 90% 危险色）和"1M"的写法：
 *        先用一个新会话量出 RING_PROMPT 一轮之后的用量 T，再添加上下文长度为 T / 0.82（约 82%）、T（约 100%）、1,000,000 和
 *        999,950 的模型（synthetic）。圆环的窗口是会话打开时第一个候选的（虚拟模型），所以每个都先把设置里的默认范围改成它、
 *        再新建会话，发同一句话，看圆环。最后把默认范围改回 fake-coder。
 */
async function ringColors(ctx) {
  const { page } = ctx;
  await ctrlN(page);
  await sendWait(ctx, RING_PROMPT);
  const tokens = Number((await ringState(page))?.tokens);
  const windows = { 'fake-ring-warn': Math.round(tokens / 0.82), 'fake-ring-full': tokens, 'fake-ring-1m': 1000000,
    'fake-ring-near': 999950 };
  const saved = await addModels(page, windows);
  const seen = {};
  for (const id of Object.keys(windows)) {
    await defaultTo(page, `${MAIN}/${id}`);
    await ctrlN(page);
    await sendWait(ctx, RING_PROMPT);
    await page.locator(RING).hover();
    seen[id] = await ringState(page);
    await page.mouse.move(0, 0);
  }
  await defaultTo(page, `${MAIN}/${MODEL}`);
  recordColors(ctx, { tokens, windows, saved, seen });
}

/** @brief ringColors 看到的。 */
function recordColors(ctx, { tokens, windows, saved, seen }) {
  const { colors } = ctx;
  const warn = seen['fake-ring-warn'];
  const full = seen['fake-ring-full'];
  const percent = (ring) => Number(ring?.percent);
  record('用量 75–89% 时填充改用较深的警示色（--color-warn-text），底圈仍是 --color-line', percent(warn) >= 75
    && percent(warn) < 90 && warn.fill?.stroke === colors['--color-warn-text'].stroke
    && warn.base?.stroke === colors['--color-line'].stroke,
  JSON.stringify({ tokens, windows, saved, warn, warnText: colors['--color-warn-text'] }));
  record('用量 ≥ 90% 时填充用危险色', percent(full) >= 90 && full.fill?.stroke === colors['--color-danger'].stroke,
    JSON.stringify({ full, danger: colors['--color-danger'] }));
  for (const [id, size] of [['fake-ring-1m', '1,000,000'], ['fake-ring-near', '999,950']]) {
    const ring = seen[id];
    const texts = ringTexts(Number(ring?.tokens), windows[id], percent(ring));
    record(`上下文长度 ${size} 写成"1M"（999,950 不写成"1000k"）：悬停"Context ≈ … / 1M (N%)"，读屏名称写完整的数`
      + `"… of ${size} tokens"`, ring?.tip?.text === texts.tip && texts.tip.includes('/ 1M (')
      && ring.name === texts.name && ring.name.includes(`of ${size} tokens`), JSON.stringify({ ring, texts }));
  }
}

/** @brief 圆环详情不算挡住快捷键的浮层（同选区浮层）：开着详情时 Ctrl+N 照常新建会话。 */
async function ringNoBlock(ctx) {
  const { page } = ctx;
  const panes = await page.locator('.pane-slot').count();
  await openPopup(page, 'usage');
  await page.keyboard.press('Control+n');
  const created = await waitPanes(page, panes + 1, 15000).then(() => true, () => false);
  // 等新会话打开完：还在"Starting…"时下一步的 Ctrl+N 照规定不起作用（sessions.md"Ctrl+N 不起作用"）
  if (created) await waitReady(page);
  record('开着圆环详情时 Ctrl+N 照常新建会话（详情不挡 Alt+数字和 Ctrl+N）', created, String(created));
}

// ---------- 步骤：生成中、切换中、准备中（models.md"不可用时、按钮消失时的焦点"、model-chat.md"准备中"） ----------

/**
 * @brief 生成中（models.md"选择范围按钮""思考强度"）：范围、Effort 按钮仍能从文字框 Tab 到（aria-disabled，不是 disabled），
 *        在 Effort 上按 Enter 不开菜单；范围按钮悬停三行（按钮文字、"<提供商名> · <区域>"、原因），读屏的描述是第二行加". "
 *        加原因；Effort 悬停两行（"Effort: Unavailable"、原因），读屏的描述只有原因（没有第一行、没有" · "）；权限按钮仍可用、
 *        能打开菜单。
 */
async function busyButtons(ctx) {
  const { page, h } = ctx;
  await h.send('wait 4s');
  await waitRunning(page);
  const path = await tabFromComposer(page, 3);
  await page.keyboard.press('Enter');
  const opened = await page.getByTestId('thinking-menu').waitFor({ timeout: 500 }).then(() => true, () => false);
  const model = await buttonState(page, 'model-button');
  const thinking = await buttonState(page, 'thinking-button');
  await openPopup(page, 'permission');
  const permission = await page.getByTestId('permission-menu').count();
  await page.keyboard.press('Escape');
  await waitIdle(page, 30000);
  const rangeOk = model.unavailable && !model.disabled
    && model.lines.join('|') === `${MODEL}|${MODEL_TIP}|${NOTE.modelBusy}`
    && model.described === `${MODEL_DESCRIBED}. ${NOTE.modelBusy}` && model.tipOutside === true;
  const effortOk = thinking.unavailable && !thinking.disabled
    && thinking.lines.join('|') === `Effort: Unavailable|${NOTE.effortBusy}` && thinking.described === NOTE.effortBusy;
  record('生成中：范围、Effort 按钮仍能从文字框 Tab 到（权限 → 范围 → Effort），在 Effort 上按 Enter 不开菜单；范围按钮悬停三行'
    + `"${MODEL}" / "${MODEL_TIP}" / "${NOTE.modelBusy}"，读屏的描述"${MODEL_DESCRIBED}. ${NOTE.modelBusy}"；Effort 悬停`
    + `两行、读屏的描述"${NOTE.effortBusy}"；权限按钮仍可用、能打开菜单`, path.join()
    === 'permission-button,model-button,thinking-button' && !opened && rangeOk && effortOk && permission === 1,
  JSON.stringify({ path, opened, model, thinking, permission }));
}

/**
 * @brief 切换中（models.md"选择范围按钮"）：在范围菜单里换成提供商 mori-endpoint，session.setPick 返回之前范围按钮和 Effort
 *        都带 data-pending（两个按钮共用一个切换中的值）、aria-disabled，范围按钮显示你选的范围、悬停只有第一行、没有读屏的
 *        描述（没有 aria-describedby，带空的 aria-description，Chromium 不再把 title 当成描述），焦点留在范围按钮；返回后
 *        两个属性都没有，也不带 aria-description。最后换回模型 fake-coder。
 */
async function pendingSwitch(ctx) {
  const { page } = ctx;
  await watchRows(page);
  await choosePick(page, MAIN);
  const rows = (await seenRows(page)).filter((row) => row.model?.pending);
  const after = await buttonState(page, 'model-button');
  const focus = await focusName(page);
  const idleDescription = await Promise.all(['model-button', 'thinking-button']
    .map((id) => paneOf(page).getByTestId(id).getAttribute('aria-description')));
  await choosePick(page, `${MAIN}/${MODEL}`);
  const shown = rows.find((row) => row.thinking?.pending && row.model.aria && row.thinking.aria
    && !row.model.title.includes('\n') && row.model.reason === null && row.thinking.reason === null
    && row.model.ariaDescription === '' && row.thinking.ariaDescription === '');
  // 切换中还不知道新范围的当前模型（v1 按 current: null 算），按钮上可能只有范围名，所以只比开头
  record('切换中：范围按钮和 Effort 都带 data-pending、aria-disabled（共用一个切换中的值），范围按钮悬停只有一行（你选的范围'
    + '的文字，以"Mori endpoint"开头）、两个按钮都没有读屏的描述（没有 aria-describedby、aria-description 为空）；返回后'
    + '范围按钮显示"Mori endpoint · fake-coder"，两个按钮都不带 data-pending、aria-disabled 和 aria-description，焦点留在'
    + '范围按钮', Boolean(shown) && shown.model.title.startsWith('Mori endpoint') && after.text === PROVIDER_TEXT
    && !after.pending && !after.hasAria && focus === 'model-button' && idleDescription.every((value) => value === null),
  JSON.stringify({ rows: rows.slice(0, 3), after, focus, idleDescription }));
}

/**
 * @brief 准备中用的提供商（测试准备）：设置页 Add provider 加第二个合成端点（"Rate endpoint"，不填 key），等探针跑完，
 *        再给它 Add key（对话请求一直回 429）。回到会话。一键拉取模型（model-discovery.md §6.1、§13.4）：Base URL →
 *        Fetch models → 清单里只勾 MODEL → Name 改成 Rate endpoint（区域按 127.0.0.1 预选 Local）→ Add 1 model。
 */
async function addRateProvider(ctx) {
  const { page, h } = ctx;
  await openModels(page);
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${ratePort}/v1`);
  const fetched = await fetchIn(page, PROVIDER_FORM);
  if (fetched.state !== 'list') throw new Error(`Rate endpoint: Fetch models gave ${JSON.stringify(fetched)}`);
  await pickIn(page, PROVIDER_FORM, [MODEL]);
  await form.getByLabel('Name', { exact: true }).fill(RATE.name);
  await form.locator('[data-action="add-models"]').click();
  await form.waitFor({ state: 'detached', timeout: 20000 });
  await providerCard(page, RATE.id).waitFor({ timeout: 10000 });
  const probe = await waitVerified(page, `${RATE.id}/${MODEL}`);
  await h.addKey(RATE_KEY, RATE.id);
  await backToApp(page);
  return probe;
}

/** @brief 等当前一栏进入准备中、阶段行是等模型（model-chat.md：data-kind="wait-model"）；返回阶段行的文字。 */
async function waitPreparing(page) {
  await page.waitForFunction((selector) => {
    const pane = document.querySelector(selector);
    return pane?.dataset.sending === 'true' && pane.dataset.running !== 'true'
      && pane.querySelector('[data-testid="stage"][data-kind="wait-model"]');
  }, PANE, { timeout: 20000 });
  return paneOf(page).getByTestId('stage').innerText();
}

/** @brief 准备中按"Stop"：消息撤回、文字回到输入框；清空输入框。 */
async function stopPreparing(page) {
  await page.locator(`${PANE} ${ROW} .stop-button`).click();
  await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.sending === 'false', PANE,
    { timeout: 15000 });
  await composer(page).fill('');
}

/** @brief 单栏时依次调到 PREP_WIDTHS 的每个宽度（宽于 740px 时右栏关，否则开），量顶栏和这一行；返回报告。 */
async function prepSamples(ctx) {
  const reports = [];
  for (const width of PREP_WIDTHS) {
    await fitPane(ctx, width, { right: width < 740 });
    reports.push(await layoutReport(ctx.page));
  }
  await fitPane(ctx, 930, { right: false });
  return reports;
}

/** @brief 记一条准备中的各档检查。 */
function recordPrepBands(name, reports, state) {
  const bad = reports.flatMap((report) => paneProblems(report, state)
    .map((problems, index) => (problems.length ? `${at1(report.panes[index].width)}px: ${problems.join(', ')}` : null))
    .filter(Boolean));
  const widths = reports.map((report) => at1(report.panes[0]?.width ?? 0));
  const missed = PREP_WIDTHS.filter((want) => want !== 300 && !widths.some((width) => Math.abs(width - want) < 1));
  record(name, bad.length === 0 && missed.length === 0, bad.length || missed.length ? `${bad.slice(0, 6).join(' | ')} `
    + `missed=${missed.join()} ${layoutBrief(reports.at(-1))}` : `widths ${widths.join(', ')}`);
}

/**
 * @brief 发出后进入准备中（v1：被限流的提供商，等模型）：开着范围菜单时从界面发出（焦点不动）→ 菜单关；准备中范围、Effort 按钮
 *        不可用（范围按钮的描述"Rate endpoint, Local. Can’t switch models until the response finishes"、Effort 的
 *        "Can’t change effort until the response finishes"），权限、圆环可用；占位文字"Enter to queue · Shift+Enter for new
 *        line"；各档这一行都放得下，按钮位置是"Stop"。停止后再发一次、输入框有字：单个"Queue"（没有 ▾），400px 时仍在、
 *        ≤ 340px 28px。
 */
async function preparing(ctx) {
  const { page } = ctx;
  const probe = await addRateProvider(ctx);
  ctx.r = await ctrlN(page);
  await choosePick(page, RATE.id);
  // 第一条消息让这个 key 进入限流：它是唯一的候选、本段已失败过，直接一张说明卡（§5.8）；之后的新一段才会等模型
  await ctx.h.send('plain first');
  await paneOf(page).getByTestId('unavailable-card').waitFor({ timeout: 30000 });
  await openPopup(page, 'model');
  await sendWithoutFocus(page, 'plain while preparing');
  const stage = await waitPreparing(page);
  const menuClosed = await menuGone(page, 'model-menu');
  const seen = { model: await buttonState(page, 'model-button'), thinking: await buttonState(page, 'thinking-button'),
    permission: await buttonState(page, 'permission-button'),
    placeholder: await composer(page).getAttribute('placeholder') };
  const empty = await prepSamples(ctx);
  await stopPreparing(page);
  await ctx.h.send('plain preparing with a draft');
  await waitPreparing(page);
  await composer(page).fill(DRAFT);
  const typed = await prepSamples(ctx);
  await stopPreparing(page);
  recordPreparing({ probe, stage, menuClosed, seen, empty, typed });
}

/** @brief preparing 看到的。 */
function recordPreparing({ probe, stage, menuClosed, seen, empty, typed }) {
  const reason = `Rate endpoint, Local. ${NOTE.modelBusy}`;
  record('准备中（发了消息、在等被限流的模型）：开着的范围菜单在发出后关闭；范围、Effort 按钮不可用（aria-disabled，仍能 Tab 到），'
    + `范围按钮悬停第三行和读屏的描述"${reason}"，Effort 的"${NOTE.effortBusy}"；权限按钮可用；占位文字`
    + '"Enter to queue · Shift+Enter for new line"', probe === 'verified' && /^Waiting for a model/.test(stage)
    && menuClosed && seen.model.unavailable && seen.model.lines[2] === NOTE.modelBusy && seen.model.described === reason
    && seen.thinking.unavailable && seen.thinking.described === NOTE.effortBusy && !seen.permission.hasAria
    && !seen.model.disabled && !seen.thinking.disabled
    && seen.placeholder === 'Enter to queue · Shift+Enter for new line', JSON.stringify({ probe, stage, menuClosed,
    seen }));
  recordPrepBands('准备中、输入框为空（单栏 300–930px，各档的上沿和下沿）：这一行不换行、不超出输入框、高 33px，按钮位置是'
    + '"Stop"（≤ 600px 只有图标，≤ 340px 28px），范围、Effort 不可用、原因在悬停和读屏的描述里', empty, 'preparing');
  recordPrepBands('准备中、输入框有字：按钮位置是"Stop"和单个"Queue"（.queue-button，没有 ▾，准备中不能插话；≤ 400px 也不收起，'
    + '≤ 340px 和"Stop"一样 28px），这一行仍放得下', typed, 'prepTyped');
}

/** @brief 等 side 那一栏进入准备中（发出了、pi 还没开始，阶段行在等模型），返回阶段行的字。 */
async function waitPrepAt(page, side) {
  const pane = `${slotSelector(side)} [data-testid="chat-pane"]`;
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    return element?.dataset.sending === 'true' && element.dataset.running !== 'true'
      && element.querySelector('[data-testid="stage"][data-kind="wait-model"]');
  }, pane, { timeout: 20000 });
  return page.locator(`${pane} [data-testid="stage"]`).innerText();
}

/** @brief 分屏时把中线拖到最右（右边一栏 .pane-slot 280px、.chat-pane 279px）和左栏 280px，各量一次两栏。 */
async function prepSplitSamples(page) {
  const samples = [];
  for (const target of [Infinity, 280]) {
    await fitLeft(page, target);
    samples.push({ target, report: await layoutReport(page) });
  }
  return samples;
}

/**
 * @brief 接着 preparing：分屏时准备中的一栏在最窄的宽度（composer-pickers.md"新加的检查"第 2 条的 279 / 280px；"宽度估算"
 *        里准备中有字是 ≤ 400px 最挤的）。单栏回到会话 S1，在分屏右边打开被限流的会话 R、在 R 里发一条进入准备中；中线拖到
 *        最右（R 279px）和左栏 280px（S1 280px、R 更宽）各量一次，输入框为空和有字（单个"Queue"）各一遍。最后停下 R、关掉分屏。
 */
async function prepSplit(ctx) {
  const { page } = ctx;
  const rate = await activeFile(page);
  await openRow(page, ctx.s1);
  await splitOpen(page, rate);
  await sendAt(page, 'right', 'plain preparing in a split');
  const stage = await waitPrepAt(page, 'right');
  const empty = await prepSplitSamples(page);
  await composerAt(page, 'right').fill(DRAFT);
  const typed = await prepSplitSamples(page);
  await shot(page, 'preparing-split-279');
  await page.locator(`${slotSelector('right')} ${ROW} .stop-button`).click();
  await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.sending === 'false',
    `${slotSelector('right')} [data-testid="chat-pane"]`, { timeout: 15000 });
  await composerAt(page, 'right').fill('');
  await page.locator(`${slotSelector('right')} [data-testid="close-pane"]`).click();
  await waitSplit(page, false);
  recordPrepSplit(stage, empty, typed);
}

/** @brief prepSplit 看到的：两栏（左 S1 空闲、右 R 准备中）都符合，而且真的量到了 279px 的 R 和 280px 的 S1。 */
function recordPrepSplit(stage, empty, typed) {
  const problems = (samples, state) => samples.flatMap(({ report }) => paneProblems(report, ['idle', state])
    .map((list, index) => (list.length ? `${at1(report.panes[index].width)}px ${state}: ${list.join(', ')}` : null))
    .filter(Boolean));
  const reached = (samples) => samples.length === 2 && Math.abs(samples[0].report.panes[1]?.width - 279) < 1
    && Math.abs(samples[1].report.panes[0]?.width - 280) < 1;
  const bad = [...problems(empty, 'preparing'), ...problems(typed, 'prepTyped')];
  record('准备中（分屏，右边一栏在等被限流的模型）：右栏 279px（中线拖到最右）和左栏 280px 时，输入框为空和有字（单个"Queue"）'
    + '两栏的顶栏和这一行都符合（不换行、不超出输入框、高 33px，三个按钮不窄于最窄，截短的先后照旧；左栏空闲）',
  /^Waiting for a model/.test(stage) && reached(empty) && reached(typed) && bad.length === 0,
  `${bad.slice(0, 6).join(' | ')} ${typed[0] ? layoutBrief(typed[0].report) : ''}`);
}

// ---------- 步骤：提供商范围的截短（composer-pickers.md"新加的检查"第 3 条） ----------

/**
 * @brief 最左一栏（单栏时就是它）范围按钮两段（.range-scope、.range-model）的宽度和全文的宽、按钮的宽，以及这一栏顶栏和
 *        这一行按"生成中有字"不符合的地方（分屏时右边一栏按空闲查）。
 */
async function rangeParts(page) {
  const report = await layoutReport(page);
  const [pane] = report.panes;
  const states = report.panes.map((item, index) => (index === 0 ? 'typed' : 'idle'));
  return { width: pane.width, button: pane.controls.model?.width ?? 0, scope: pane.texts.scope,
    model: pane.texts.model, problems: paneProblems(report, states).flat() };
}

/**
 * @brief 提供商范围（"Mori endpoint · fake-coder"，约 174px）、生成中有字（最挤，"Effort: Unavailable"）：会话面板 930px 时
 *        两段都完整；600px 时 .range-model 截短、.range-scope 完整；分屏左栏 280px 时范围按钮 36px（最窄）、只剩范围名的开头
 *        （.range-model 收完、.range-scope 截短）。最后停下、关掉分屏、换回模型范围。
 */
async function providerRange(ctx) {
  const { page } = ctx;
  ctx.p = await ctrlN(page);
  await choosePick(page, MAIN);
  await ctx.h.send('wait 90s');
  await waitRunning(page);
  await composer(page).fill(DRAFT);
  const cut = (fact) => Boolean(fact) && fact.width < fact.full - 0.01;
  await fitPane(ctx, 930, { right: false });
  const wide = await rangeParts(page);
  // 右栏关着时窗口最窄 800px（< 1024px，左栏收成图标栏），会话面板到不了 600px；右栏打开时窗口仍宽于 1024px、左栏展开
  await fitPane(ctx, 600, { right: true });
  const mid = await rangeParts(page);
  await fitPane(ctx, 930, { right: false });
  await splitOpen(page, ctx.s1);
  await fitLeft(page, 280);
  const narrow = await rangeParts(page);
  await shot(page, 'provider-range-280');
  await page.locator('.pane-slot[data-side="left"] .composer-bottom .stop-button').click();
  await page.locator('.pane-slot[data-side="right"] [data-testid="close-pane"]').click();
  await waitSplit(page, false);
  await waitIdle(page, 30000);
  await composer(page).fill('');
  await choosePick(page, `${MAIN}/${MODEL}`);
  // 先确认真的量到了这三个宽度（fitPane、fitLeft 到不了时会停在别的宽度，量到的就不是要查的那一档）
  const reached = Math.abs(wide.width - 930) < 1 && Math.abs(mid.width - 600) < 1 && narrow.width < 281;
  record(`提供商范围"${PROVIDER_TEXT}"、生成中有字：930px 时范围名和模型 id 都完整；600px 时先截模型 id（.range-model），范围名`
    + '完整；280px 最挤时范围按钮 36px、模型 id 收完、只剩截短的范围名；三处这一行都符合这一档', reached && !cut(wide.scope)
    && !cut(wide.model) && cut(mid.model) && !cut(mid.scope) && Math.abs(narrow.button - 36) <= 1
    && (narrow.model?.width ?? 0) <= 0.5 && cut(narrow.scope)
    && [wide, mid, narrow].every((sample) => sample.problems.length === 0),
  JSON.stringify({ wide, mid, narrow }));
}

// ---------- 步骤：菜单的位置（models.md"菜单的位置与键盘"） ----------

/** @brief 当前一栏依次打开范围、Effort、权限菜单和圆环详情，量位置；返回 { kind: problems }。 */
async function placeFour(page) {
  const result = {};
  for (const kind of ['model', 'thinking', 'permission', 'usage']) {
    result[kind] = (await openAndPlace(page, POPUPS[kind]))?.problems ?? ['could not open'];
  }
  return result;
}

/**
 * @brief 很短的模型 id（"o3"，synthetic）、空闲：会话面板 930px（右栏关）和 680px（右栏开）时各开一次范围菜单——范围按钮被
 *        margin-left: auto 推到右边，菜单（300px）右边对齐按钮，放不下时左边贴这一行左端，任何宽度都不伸出这一行；Effort
 *        菜单同样；权限菜单贴这一行左端；圆环详情贴右端（260px）；都往上打开、在面板和窗口里、不盖到顶栏。
 */
async function menuPlacement(ctx) {
  const { page } = ctx;
  const saved = await addModels(page, { o3: undefined });
  await ctrlN(page);
  await choosePick(page, `${MAIN}/o3`);
  const seen = {};
  for (const [width, right] of [[930, false], [680, true]]) {
    const pane = await fitPane(ctx, width, { right });
    seen[width] = { pane, problems: await placeFour(page) };
  }
  await shot(page, 'menus-680');
  await fitPane(ctx, 930, { right: false });
  for (const width of [930, 680]) {
    record(`很短的模型 id "o3"、空闲、会话面板 ${width}px：范围菜单 300px 宽、和 Effort 菜单右边对齐自己的按钮或（放不下时）`
      + '贴这一行左端、不伸出这一行；权限菜单贴左端；圆环详情贴右端；都往上打开（下边在这一行上方 6px）、在面板和窗口里、'
      + '不盖到顶栏', saved.o3 === 'verified' && Math.abs(seen[width].pane - width) < 1
      && Object.values(seen[width].problems).every((problems) => problems.length === 0), JSON.stringify(seen[width]));
  }
}

/**
 * @brief 800×600、右栏打开（会话面板约 300px）：草稿 1 行和 220px 高（20 行）时各开一次范围菜单：不出窗口、不盖顶栏，最高
 *        （max-height）和下边都一样（这一行贴在面板底部，草稿变高时它不动）。之后清空草稿、回到 1200×800。
 */
async function tallDraft(ctx) {
  const { page, app } = ctx;
  await resizeWindow(app, 800, 600);
  await fitPane(ctx, 300, { right: true, height: 600 });
  await composer(page).fill('plain one line');
  const one = await openAndPlace(page, POPUPS.model);
  await composer(page).fill(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));
  await settle(page);
  const height = await composer(page).evaluate((el) => el.getBoundingClientRect().height);
  const tall = await openAndPlace(page, POPUPS.model);
  await shot(page, 'menu-tall-draft');
  await composer(page).fill('');
  await resizeWindow(app, 1200, 800);
  await fitPane(ctx, 930, { right: false });
  record('800×600、右栏打开、草稿 1 行和 220px 高：范围菜单往上打开、不出窗口、不盖顶栏；两次的最高（max-height）和下边相同',
    Math.abs(height - 220) <= 2 && one?.problems.length === 0 && tall?.problems.length === 0
    && one.geo.maxHeight === tall.geo.maxHeight && Math.abs(one.geo.box.bottom - tall.geo.box.bottom) <= 1,
  JSON.stringify({ height, one, tall }));
}

/** @brief 让模型调用 tool（args），在批准卡上按 Alt+2（"Allow … for this session"），等这一轮结束。 */
async function allowForSession(ctx, tool, args) {
  const { page, h } = ctx;
  await h.send(`call tool: ${tool} ${JSON.stringify(args)}`);
  const card = paneOf(page).getByTestId('approval-card');
  await card.waitFor({ timeout: 30000 });
  await page.keyboard.press('Alt+2');
  await card.waitFor({ state: 'detached', timeout: 10000 });
  await waitIdle(page, 60000);
}

/**
 * @brief 30 条"Allowed for this session"（5 个合成 MCP 服务各 6 个工具，每个在批准卡上 Alt+2）：800×600、右栏打开时
 *        打开权限菜单，列表有 30 条，菜单最高到 min(440, 这一行上边到顶栏下边 − 12) 为止、在菜单里滚动，贴这一行左端、
 *        往上打开、在面板和窗口里、不盖到顶栏（原来没有高度上限）。
 */
async function allowedScroll(ctx) {
  const { page, app } = ctx;
  await ctrlN(page);
  for (const server of MCP_SERVERS) {
    for (const [tool, args] of MCP_CALLS) await allowForSession(ctx, `mcp__${server}__${tool}`, args);
  }
  await resizeWindow(app, 800, 600);
  await fitPane(ctx, 300, { right: true, height: 600 });
  await openPopup(page, 'permission');
  const count = await page.getByTestId('permission-menu').locator('[data-testid="permission-allowed"] li').count();
  const geo = await popupBox(page, { popup: POPUPS.permission.popup, anchor: POPUPS.permission.opener });
  await shot(page, 'permission-30');
  await noteSmall(ctx, '权限菜单（30 条）', POPUPS.permission.popup);
  await page.keyboard.press('Escape');
  await popupGone(page, POPUPS.permission.popup);
  await resizeWindow(app, 1200, 800);
  await fitPane(ctx, 930, { right: false });
  const problems = placeProblems(geo, POPUPS.permission);
  record('有 30 条"Allowed for this session"时权限菜单在菜单里滚动（高度不超过这一行上边到顶栏下边 − 12px），贴这一行左端、'
    + '往上打开、在面板和窗口里、不盖到顶栏', count === 30 && geo?.scrolls && problems.length === 0,
  JSON.stringify({ count, geo, problems }));
}

// ---------- 步骤：键盘、自动关、新的卡片（models.md"菜单的位置与键盘""不可用时、按钮消失时的焦点"） ----------

/**
 * @brief 菜单里的键：从文字框 Tab 两次到范围按钮、Enter 打开（焦点在打勾的那一项），Esc 关上、焦点回到按钮；文字框里有字时
 *        在菜单里按 Enter 只选项（菜单关、焦点回按钮），不发送也不排队、草稿还在。
 */
async function menuEnter(ctx) {
  const { page } = ctx;
  await composer(page).fill('plain stays in the box');
  const sent = await userCount(page);
  const path = await tabFromComposer(page, 2);
  await page.keyboard.press('Enter');
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  const current = await page.evaluate(() => document.activeElement?.getAttribute('aria-checked'));
  await page.keyboard.press('Escape');
  const escaped = { gone: await menuGone(page, 'model-menu'), focus: await focusName(page) };
  await page.keyboard.press('Enter');
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  const chosen = { gone: await menuGone(page, 'model-menu'), focus: await focusName(page) };
  await sleep(500);
  const after = { sent: await userCount(page), draft: await composer(page).inputValue(),
    running: await page.evaluate((selector) => document.querySelector(selector)?.dataset.running, PANE) };
  record('键盘：从文字框 Tab 两次到范围按钮，Enter 打开菜单、焦点在打勾的那一项；Esc 关上、焦点回到范围按钮',
    path.at(-1) === 'model-button' && current === 'true' && escaped.gone && escaped.focus === 'model-button',
  JSON.stringify({ path, current, escaped }));
  record('菜单开着、文字框里有字时在菜单里按 Enter 只选菜单项（菜单关、焦点回到按钮），不发送也不排队，草稿还在',
    chosen.gone && chosen.focus === 'model-button' && after.sent === sent && after.draft === 'plain stays in the box'
    && after.running === 'false', JSON.stringify({ chosen, after, sent }));
  await composer(page).fill('');
}

/**
 * @brief Tab 移出时关闭（models.md"Tab 移出时关闭"）：范围菜单里一直按 Tab，焦点离开菜单（到 Effort 按钮）时菜单关；
 *        打开范围菜单、按 F8、在报告框里按 Esc：菜单仍开着、焦点回到原来那一项；点范围菜单底部的说明不关；打开权限菜单、
 *        点"Allowed for this session:"不关。
 */
async function menuTabOut(ctx) {
  const { page } = ctx;
  await openPopup(page, 'model');
  const steps = [];
  for (let n = 0; n < 12; n += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="model-menu"]')));
    steps.push(await focusName(page));
    if (!inside) break;
  }
  const tabbed = { gone: await menuGone(page, 'model-menu'), focus: steps.at(-1) };
  await openPopup(page, 'model');
  const item = await focusName(page);
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  const during = await page.getByTestId('model-menu').count();
  await page.keyboard.press('Escape');
  await page.getByTestId('issue-dialog').waitFor({ state: 'detached', timeout: 5000 });
  const f8 = { during, after: await page.getByTestId('model-menu').count(), focus: await focusName(page), item };
  await page.getByTestId('model-menu-note').click();
  const note = await page.getByTestId('model-menu').count();
  await page.keyboard.press('Escape');
  await openPopup(page, 'permission');
  await page.getByTestId('permission-menu').getByText('Allowed for this session:').click();
  const caption = await page.getByTestId('permission-menu').count();
  await page.keyboard.press('Escape');
  record('Tab 移出时关闭：范围菜单里按 Tab 到菜单外面的按钮（Effort）时菜单关', tabbed.gone
    && tabbed.focus === 'thinking-button', JSON.stringify({ steps, tabbed }));
  record('打开范围菜单、按 F8：报告框打开时菜单仍开着；Esc 关上报告框后菜单还在、焦点回到原来那一项', f8.during === 1
    && f8.after === 1 && f8.focus === f8.item, JSON.stringify(f8));
  record('点范围菜单底部的说明不关；打开权限菜单、点"Allowed for this session:"不关', note === 1 && caption === 1,
    JSON.stringify({ note, caption }));
}

/** @brief 同时只开一个：开着范围菜单时点 Effort → 只剩 Effort 菜单；点圆环 → 只剩详情；点权限 → 只剩权限菜单。 */
async function menuExclusive(ctx) {
  const { page } = ctx;
  await openPopup(page, 'model');
  const seen = {};
  for (const kind of ['thinking', 'usage', 'permission']) {
    await openPopup(page, kind);
    await settle(page);
    seen[kind] = await openPopups(page);
  }
  await page.keyboard.press('Escape');
  record('这一行的菜单和圆环详情同时只开一个：开着范围菜单时点 Effort 按钮，范围菜单关、Effort 菜单开；再点圆环、再点权限按钮'
    + '同样', seen.thinking.join() === 'thinking' && seen.usage.join() === 'usage'
    && seen.permission.join() === 'permission', JSON.stringify(seen));
}

/**
 * @brief 菜单开着时 Alt+1、Ctrl+N 不起作用（models.md"算作菜单开着"）：有挂起的批准卡（"run: echo one"）时打开权限菜单，
 *        Alt+1 不答这张卡、Ctrl+N 不新建会话；Esc 关菜单、焦点回到权限按钮，之后 Alt+1 答了这张卡。
 */
async function menuBlocks(ctx) {
  const { page, h } = ctx;
  await h.send('run: echo one');
  const card = paneOf(page).getByTestId('approval-card');
  await card.waitFor({ timeout: 30000 });
  await openPopup(page, 'permission');
  const panes = await page.locator('.pane-slot').count();
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('Control+n');
  await sleep(800);
  const blocked = { card: await card.count(), panes: await page.locator('.pane-slot').count(),
    menu: await page.getByTestId('permission-menu').count() };
  await page.keyboard.press('Escape');
  const escaped = { gone: await popupGone(page, POPUPS.permission.popup), focus: await focusName(page) };
  await page.keyboard.press('Alt+1');
  const answered = await card.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false);
  await waitIdle(page, 60000);
  record('权限菜单开着、有挂起的批准卡时 Alt+1 不答卡、Ctrl+N 不新建会话；Esc 关菜单、焦点回到权限按钮，之后 Alt+1 答了这张卡',
    blocked.card === 1 && blocked.panes === panes && blocked.menu === 1 && escaped.gone
    && escaped.focus === 'permission-button' && answered, JSON.stringify({ blocked, panes, escaped, answered }));
}

/**
 * @brief 新的批准卡来了（models.md"新的批准卡或询问卡来了"）："wait 2s then run: …"开始后打开权限菜单（生成中只有它能开），
 *        卡来了菜单关、焦点回到权限按钮，Alt+1 答了这张卡；再来一次，开着圆环详情，卡来了详情关、焦点留在圆环，Alt+1 答了。
 *        设计要求"开着范围菜单时"，但生成中范围菜单打不开（批准卡只在生成中来），改用权限菜单（与原设计不同，见文件头）。
 */
async function cardArrival(ctx) {
  const { page, h } = ctx;
  const seen = {};
  for (const [kind, focus, command] of [['permission', 'permission-button', 'echo two'], ['usage', 'usage',
    'echo three']]) {
    await h.send(`wait 2s then run: ${command}`);
    await waitRunning(page);
    await openPopup(page, kind);
    const card = paneOf(page).getByTestId('approval-card');
    await card.waitFor({ timeout: 30000 });
    const gone = await popupGone(page, POPUPS[kind].popup);
    const now = await focusName(page);
    await page.keyboard.press('Alt+1');
    const answered = await card.waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false);
    await waitIdle(page, 60000);
    seen[kind] = { gone, focus: now, answered, ok: gone && now === focus && answered };
  }
  record('开着权限菜单时来了批准卡：菜单关、焦点回到权限按钮，Alt+1 答了这张卡', seen.permission.ok,
    JSON.stringify(seen.permission));
  record('开着圆环详情时来了批准卡：详情关（焦点留在圆环），Alt+1 答了这张卡', seen.usage.ok, JSON.stringify(seen.usage));
}

/**
 * @brief synthetic：经进程桥把所有项目默认允许的区域改成 zones（models.setDefaults，默认范围不变）；清空时本地的提供商被
 *        排除，会话被拒绝启动（no_candidate），恢复时卡消失。返回原来的默认值。
 */
async function setAllowedZones(page, zones) {
  return page.evaluate(async (next) => {
    const { config } = await window.mori.request({ type: 'models.get' });
    await window.mori.request({ type: 'models.setDefaults', normalDefault: config.normalDefault,
      allowedZones: next ?? config.allowedZones });
    return { normalDefault: config.normalDefault, allowedZones: config.allowedZones };
  }, zones);
}

/**
 * @brief 拒绝启动卡出现、消失不关范围菜单（models.md"什么时候自动关"、"新的批准卡或询问卡来了"一行）：开着范围菜单时让会话
 *        被拒绝启动（setAllowedZones([])），卡出现后菜单还开着；恢复区域、卡消失后菜单仍开着。
 */
async function blockedKeepsMenu(ctx) {
  const { page } = ctx;
  await openPopup(page, 'model');
  const before = await setAllowedZones(page, []);
  const card = paneOf(page).getByTestId('blocked-card');
  const appeared = await card.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const withCard = await page.getByTestId('model-menu').count();
  await setAllowedZones(page, before.allowedZones);
  const vanished = await card.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  const afterCard = await page.getByTestId('model-menu').count();
  await page.keyboard.press('Escape');
  record('拒绝启动卡出现、消失都不关开着的范围菜单（卡没有要答的，菜单可能就是它打开的）', appeared && withCard === 1
    && vanished && afterCard === 1, JSON.stringify({ before, appeared, withCard, vanished, afterCard }));
}

/**
 * @brief 什么时候自动关（models.md 的表）：开着范围菜单时生成开始（经 window.mori 直接 session.prompt，焦点不动）→ 关；
 *        开着权限菜单时排队的消息开始新的一轮 → 不关；开着"Queue"的下拉时清空草稿 → 关，焦点回到文字框；拒绝启动卡出现、
 *        消失 → 范围菜单不关（blockedKeepsMenu）。发出后进入准备中 → 范围菜单关，在 preparing 里查。
 */
async function autoClose(ctx) {
  const { page, h } = ctx;
  await openPopup(page, 'model');
  await kernelPrompt(ctx, 'wait 2s');
  const model = await menuGone(page, 'model-menu');
  await waitIdle(page, 60000);
  const sent = await userCount(page);
  await h.send('wait 3s');
  await waitRunning(page);
  await h.send('plain queued turn');
  await openPopup(page, 'permission');
  await page.waitForFunction(({ selector, n }) => document.querySelectorAll(`${selector} [data-testid="user-message"]`)
    .length >= n, { selector: PANE, n: sent + 2 }, { timeout: 30000 });
  const permission = await page.getByTestId('permission-menu').count();
  await page.keyboard.press('Escape');
  await waitIdle(page, 60000);
  await h.send('wait 4s');
  await waitRunning(page);
  await composer(page).fill('plain draft');
  await openPopup(page, 'queue');
  await setDraft(page, '');
  const gone = await popupGone(page, POPUPS.queue.popup);
  // 焦点在下一帧才放回文字框（focusComposer 用 requestAnimationFrame）
  await settle(page);
  const queue = { gone, focus: await focusName(page) };
  await waitIdle(page, 60000);
  record('开着范围菜单时生成开始：菜单关（按钮不可用）', model, String(model));
  record('开着权限菜单时排队的消息开始新的一轮：菜单不关（权限生成中仍可用）', permission === 1, String(permission));
  record('开着"Queue"的下拉时清空草稿："Queue ▾"消失、下拉跟着关，焦点回到文字框', queue.gone && queue.focus === 'textarea',
    JSON.stringify(queue));
  await blockedKeepsMenu(ctx);
}

/** @brief 焦点在 css 那个按钮上时等 until 发生，返回之后焦点在哪（focusName）。 */
async function focusAfter(page, css, until) {
  await page.locator(css).first().focus();
  await until();
  await settle(page);
  return focusName(page);
}

/**
 * @brief 焦点所在的按钮消失时焦点回到这一栏的文字框（models.md"不可用时、按钮消失时的焦点"），逐个查："Stop"上、本轮结束；
 *        ▾ 上、本轮结束；"Queue"上、清空草稿；"Send"上按 Enter 发出（开始生成时"Send"消失）。范围按钮、Effort 在打开失败时
 *        消失的那一条在 m6-app-slash.mjs（failRestart）。
 */
async function focusFallback(ctx) {
  const { page, h } = ctx;
  const seen = {};
  await h.send('wait 2s');
  await waitRunning(page);
  seen.stop = await focusAfter(page, `${PANE} ${ROW} .stop-button`, () => waitIdle(page, 30000));
  await h.send('wait 2s');
  await waitRunning(page);
  await composer(page).fill('plain draft for the toggle');
  seen.toggle = await focusAfter(page, `${PANE} ${ROW} .split-toggle`, () => waitIdle(page, 30000));
  await h.send('wait 3s');
  await waitRunning(page);
  await composer(page).fill('plain draft for the queue');
  const queue = `${PANE} ${ROW} .split-button > .button:not(.split-toggle)`;
  seen.queue = await focusAfter(page, queue, () => setDraft(page, ''));
  await waitIdle(page, 30000);
  await composer(page).fill('plain send by keyboard');
  seen.send = await focusAfter(page, `${PANE} ${ROW} .send-button`, async () => {
    await page.keyboard.press('Enter');
    await waitRunning(page);
  });
  await waitIdle(page, 30000);
  record('按钮消失时焦点回到文字框（不落到 body）："Stop"上本轮结束、▾ 上本轮结束、"Queue"上清空草稿、"Send"上按 Enter 发出',
    Object.values(seen).every((focus) => focus === 'textarea'), JSON.stringify(seen));
}

/**
 * @brief 权限按钮（approval.md"权限菜单"）：在这一行左端、只有文字（宽栏里只有 ▾ 一个图标，没有盾牌），悬停两行"Permission
 *        mode: Ask each time"和"Change the permission mode"、读屏的描述是第二行；切到"Full access"后第二行和描述是
 *        "Edits, writes, and commands inside the working directory run without asking."（file-system.md §17），字和底色
 *        对比度 ≥ 4.5:1；最后切回"Ask each time"。
 */
async function permissionText(ctx) {
  const { page, h } = ctx;
  const ask = await buttonState(page, 'permission-button');
  await h.allowAll();
  const full = await buttonState(page, 'permission-button');
  const contrast = contrastOf(await colorStack(page, `${IN_ROW('permission-button')} .permission-text`));
  await openPopup(page, 'permission');
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: 'Ask each time' }).click();
  await page.waitForFunction((css) => document.querySelector(css)?.textContent?.trim() === 'Ask each time',
    IN_ROW('permission-button'), { timeout: 10000 });
  const text = (state, mode, note) => state.inRow && !state.inTopbar && state.text === mode && state.icons === 1
    && state.name === `Permission mode: ${mode}` && state.lines.join('|') === `Permission mode: ${mode}|${note}`
    && state.described === note && !state.hasAria;
  record('权限按钮在这一行左端、只有文字"Ask each time"和 ▾（没有盾牌图标）；悬停两行"Permission mode: Ask each time"和'
    + '"Change the permission mode"，读屏的描述是第二行；能用时不带 aria-disabled', text(ask, 'Ask each time', NOTE.ask),
  JSON.stringify(ask));
  record('切到"Full access"后按钮只有文字"Full access"（警示色）和 ▾；悬停第二行和读屏的描述是"Edits, writes, and commands '
    + 'inside the working directory run without asking."；字和底色对比度 ≥ 4.5:1',
  text(full, 'Full access', NOTE.full) && contrast >= 4.5, JSON.stringify({ full, contrast }));
}

/** @brief 最新的一份 F8 报告（<userData>/ui-issues 里最后一个 .md）的文字；没有时为空串。 */
function latestIssue(ctx) {
  const dir = join(ctx.userData, 'ui-issues');
  if (!existsSync(dir)) return '';
  const name = readdirSync(dir).filter((file) => file.endsWith('.md')).sort().at(-1);
  return name ? readFileSync(join(dir, name), 'utf8') : '';
}

/**
 * @brief F8（composer-pickers.md"我自己定的"第 16 条、f8.md"保存的内容"）：报告的"Current view"有"Model range: <tab.pick>"、
 *        "Effort: <按钮上的强度>"和"Pane width: <会话面板的宽度>px"，"Model""Permission mode"照旧，顺序是 Model range、
 *        Model、Effort 在前，Pane width 在 Window size 后面。
 */
async function f8View(ctx) {
  const { page } = ctx;
  await composer(page).click();
  const width = Math.round(await paneWidth(page));
  const effort = (await buttonState(page, 'thinking-button')).text.replace(/^Effort: /, '');
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('issue-what').fill('composer-pickers：Current view（synthetic）');
  await page.getByTestId('issue-dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('issue-saved').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  const fields = /^- (Model range|Model|Effort|Running|Permission mode|Window size|Pane width|Sidebar width):/;
  const lines = latestIssue(ctx).split(/\r?\n/).filter((line) => fields.test(line));
  const order = lines.map((line) => line.slice(2, line.indexOf(':'))).join();
  record(`F8：报告的"Current view"多了"Model range: ${MAIN}/${MODEL}"、"Effort: ${effort}"和"Pane width: ${width}px"，`
    + '"Model"和"Permission mode"照旧；Model range、Model、Effort 依次在 Running 前面，Pane width 在 Window size 和 Sidebar '
    + 'width 之间', lines.includes(`- Model range: ${MAIN}/${MODEL}`) && lines.includes(`- Model: ${MAIN}/${MODEL}`)
    && lines.includes(`- Effort: ${effort}`) && lines.includes(`- Pane width: ${width}px`)
    && lines.includes('- Permission mode: Ask each time')
    && order === 'Model range,Model,Effort,Running,Permission mode,Window size,Pane width,Sidebar width',
  lines.join(' | '));
}

/** @brief 新加的浮层（圆环的悬停提示和详情、30 条的权限菜单）没有小于 12px 的字。 */
async function fontSizes(ctx) {
  record(`圆环的悬停提示、详情和权限菜单没有小于 12px 的文字（看过：${[...new Set(ctx.smallChecked)].join('、')}）`,
    ctx.small.length === 0 && ctx.smallChecked.length > 0, ctx.small.slice(0, 6).join('; '));
}

const steps = { setup, ringEmpty, ringUsed, ringRefresh, ringEsc, busyButtons, pendingSwitch, permissionText, menuEnter,
  menuTabOut, menuExclusive, menuBlocks, cardArrival, autoClose, focusFallback, f8View, ringNoBlock, providerRange,
  preparing, prepSplit, ringColors, menuPlacement, tallDraft, allowedScroll, fontSizes };

const fake = await startFakeEndpoint(port, testKey);
const rate = await startFakeEndpoint(ratePort, '', { FAKE_LIMITED_KEYS: RATE_KEY, FAKE_LIMIT_MS: '3600000' });
const { root, project } = makeProject();
const userData = mkdtempSync(join(tmpdir(), 'mori-m6-row-data-'));
writeAgentDir(join(userData, 'pi'));
const ctx = { userData, root, project, pageErrors: [], small: [], smallChecked: [] };
await startApp(ctx);
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && name !== 'setup' && !only.includes(name)) continue;
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      await shot(ctx.page, `${name}-error`);
      await ctx.page.keyboard.press('Escape').catch(() => {});
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app.close().catch(() => {});
  fake.kill();
  rate.kill();
}
console.log(`[m6-app-row] project in ${project}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`m6-app-row${suffix}.json`) ? 0 : 1;
