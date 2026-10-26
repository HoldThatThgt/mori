// M5 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的会话（tests/fixtures/m5）。
// 测试像你一样操作（拖会话行到中栏左半边分屏、拖进输入框引用、右键菜单、两栏里各自发消息和 Alt+1、点另一栏切焦点、
// Esc、F8、预览对话框里改范围、改名、点发出的引用、删除），回放桥核对界面发出的每条命令都与录制时一致——带会话引用的
// 消息连全文和 refs 一起比较；读原会话（session.read）的结果是录制时后台进程真的读到的。
// 再按 docs/v0/screens/split.md 与 session-refs.md 检查界面。M1–M4 的回放检查仍由 m1–m4-replay 负责。
// 2026-10-21 起（docs/v0/composer-pickers.md）：两栏都在等批准、一直在生成时把左栏收到 280–461px 各档、右边一栏收到 279px，
// 量两栏的输入框下面一行、往上打开的菜单、同时只开一个浮层和两栏各一个圆环（narrowSplit）；F8 报告的"Model range"
// "Effort""Pane width"（左右两栏各按一次）。
// 用法（在 app/ 下）：node tests/ui/m5-replay.mjs [--only split-approvals,ref-turns]
// 结果写到 test-results/m5-replay.json；截图在 test-results/m5-replay/。

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  composerRow, openRingDetails, popoverChecks, REPLAY_TIP, ringState, rowProblems, rowSummary,
} from './m1-layout.mjs';
import {
  centerPoint, chipsAt, closeRightPanel, composerAt, dragWithHint, flashedAt, headingWhole, paneAt, paneView,
  pickRange, previewHeading, previewState, sendAt, sentSessionRefs, setSplitWidth, slotSelector, splitState,
  viewProblems, waitPaneIdle, waitPaneReady, waitPreview, waitSessionChip, waitSplit,
} from './m5-helpers.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-m5');
const fixtureDir = join(appRoot, 'tests/fixtures/m5');
const shots = join(appRoot, 'test-results/m5-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 预览和发给模型的内容里不该出现的界面文字 */
const UI_WORDS = ['Copy', 'Attach message as context', 'Give feedback', 'Thought process', 'Thinking…', 'Running…',
  'Waiting for your approval', 'Stopped', 'open preview'];
/** 两栏都在生成时把左栏依次收到的宽（composer-pickers.md"测试要改的地方"新加的检查第 2 条里分屏才有的窄栏和各档的边） */
const NARROW_LEFT = [280, 340, 341, 400, 401, 460, 461];
/** 量"生成中有字"时输入框里的字（不发出） */
const NARROW_DRAFT = '窄栏里还没发出的字';
/** 选择范围按钮悬停的第二行（回放桥合成的提供商名） */
const OPTS = { modelTip: REPLAY_TIP };

/** @brief 读取一个 M5 录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
/** @brief 录制里界面发出的命令（只读查询除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (fx) => fx.steps.filter((s) => s.command
  && !['session.state', 'session.list', 'trust.check', 'session.read'].includes(s.command.type)).map((s) => s.command);
/** @brief 录制里某种命令的结果（按顺序）。 */
const resultsOf = (fx, type) => fx.steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
/** @brief 录制里的你的消息（按顺序）。 */
const promptsOf = (fx) => commandsOf(fx).filter((c) => c.type === 'session.prompt');

/** @brief 构建回放页面（与 m1–m4 回放用不同的输出目录）。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 等回放桥的 status[field] 不小于 value；出现不一致时立即报错。 */
async function untilBridge(page, field, value, what) {
  await page.waitForFunction(({ f, v }) => window.__replay.status[f] >= v || window.__replay.status.errors.length > 0,
    { f: field, v: value }, { timeout: 120000 }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 会话文件为 file 的会话行。 */
const rowOf = (page, file) => page.locator(`.session-item[data-file=${JSON.stringify(file)}]`).first();

/** @brief 测试用的页面操作。 */
function helpers(page) {
  return {
    /** @brief 载入录制文件，等侧栏读完会话列表。 */
    async load(name, { speed = 4, maxGap = 600 } = {}) {
      const fx = readFixture(name);
      await page.goto(`${pathToFileURL(join(outDir, 'index.html')).href}`
        + `?fixture=${name}&speed=${speed}&maxGap=${maxGap}`);
      await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
      return fx;
    },
    /** @brief 点"Open folder…"（回放桥返回下一条 session.create 的文件夹），等会话就绪。 */
    async openFolder() {
      await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
      await waitPaneReady(page, 'focused');
    },
    /** @brief Ctrl+N 新建会话，等就绪。 */
    async ctrlN() {
      const before = await page.locator('.pane-slot').count();
      await page.keyboard.press('Control+N');
      await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, before, { timeout: 20000 });
      await waitPaneReady(page, 'focused');
    },
    /** @brief 会话行的界面标识（打开过的会话行的 data-row）。 */
    keyOf: (file) => rowOf(page, file).getAttribute('data-row'),
    /** @brief 把会话行拖到中栏的某一半，返回放下提示。 */
    async dragToSide(file, side) {
      return dragWithHint(page, rowOf(page, file), page.locator('.center'), await centerPoint(page, side));
    },
    /** @brief 在会话行上打开右键菜单，选 item。 */
    async rowMenu(file, item) {
      await rowOf(page, file).click({ button: 'right' });
      await page.getByTestId('session-menu').getByRole('menuitem', { name: item }).click();
    },
    status: () => page.evaluate(() => window.__replay.status),
  };
}

/** @brief 收尾：回放桥没有不一致，录制里的命令全部用上了。 */
async function finish(page, name, fx) {
  const total = commandsOf(fx).length;
  await untilBridge(page, 'played', total, `all ${total} commands of ${name}`);
  const status = await page.evaluate(() => window.__replay.status);
  record(`${name}：界面发出的命令与录制一致（${total} 条，带会话引用的消息连全文和 refs），没有多发或少发`,
    status.errors.length === 0 && status.cursor === total, status.errors.join('; '));
}

/** @brief 某一栏里最后一张标题以 verb 开头、对象含 target 的工具卡的状态。 */
function cardStatus(page, side, verb, target) {
  return paneAt(page, side).locator('[data-testid="tool-card"]')
    .filter({ has: page.locator('.tool-verb', { hasText: verb }) })
    .filter({ has: page.locator('.tool-target', { hasText: target }) }).last()
    .getAttribute('data-status', { timeout: 5000 }).catch(() => null);
}

/** @brief 打开 A、B 两个会话，把 A 拖到中栏左半边分屏；返回放下提示和 A、B 的会话文件。 */
async function openSplit(page, h, fx) {
  const [a, b] = resultsOf(fx, 'session.create');
  await h.openFolder();
  await h.ctrlN();
  const hint = await h.dragToSide(a.sessionFile, 'left');
  await waitSplit(page);
  return { a, b, hint };
}

/** @brief 按录制里 approval.answer 的顺序：在那张卡所在的一栏里点一下输入框，按 Alt+1。 */
async function answerInOrder(page, fx, sides) {
  const answers = commandsOf(fx).filter((c) => c.type === 'approval.answer');
  const seen = [];
  for (const answer of answers) {
    const side = sides[answer.sessionId];
    await paneAt(page, side).getByTestId('approval-card').waitFor({ timeout: 60000 });
    const other = side === 'left' ? 'right' : 'left';
    seen.push({ side, otherCard: await paneAt(page, other).getByTestId('approval-card').count() });
    await composerAt(page, side).click();
    await composerAt(page, side).press('Alt+1');
    await sleep(400);
    seen.at(-1).otherAfter = await paneAt(page, other).getByTestId('approval-card').count();
  }
  return seen;
}

/** @brief 走查 1：拖到左侧分屏；两边各自发消息、各自批准；右栏和 F8 跟随焦点。 */
async function splitApprovals(page, h) {
  const fx = await h.load('split-approvals');
  const { a, b, hint } = await openSplit(page, h, fx);
  const state = await splitState(page);
  const keyA = await h.keyOf(a.sessionFile);
  record('split-approvals：把会话拖到中栏左半边，放下前提示"松开以在左侧分屏打开"；松开后左右分屏、拖进来的一栏有焦点',
    hint?.kind === 'split' && hint.text === 'Drop to open in split view on the left' && state.split
    && state.slots.length === 2
    && state.slots[0].key === keyA && state.slots[0].focused, JSON.stringify({ hint, state }));
  const [left, right] = promptsOf(fx);
  await sendAt(page, 'left', left.text);
  await sendAt(page, 'right', right.text);
  await narrowSplit(page);
  const order = await answerInOrder(page, fx, { [a.sessionId]: 'left', [b.sessionId]: 'right' });
  await waitPaneIdle(page, 'left');
  await waitPaneIdle(page, 'right');
  const cards = { left: await cardStatus(page, 'left', 'Edit', 'README.md'),
    right: await cardStatus(page, 'right', 'Write', 'notes.md') };
  record('split-approvals：两边各自出批准卡；在一栏按 Alt+1 只批准这一栏的卡，另一栏的卡还在',
    order.every((item) => item.otherAfter === item.otherCard) && cards.left === 'done' && cards.right === 'done',
    JSON.stringify({ order, cards }));
  await shot(page, 'split-approvals');
  await rightPanelFollows(page);
  await f8Follows(page, h);
  await finish(page, 'split-approvals', fx);
}

/** @brief 量两栏输入框下面一行（输入框里有字和没字各一次），按"生成中"查；返回问题列表。 */
async function bothRows(page, label) {
  const bad = [];
  for (const draft of ['', NARROW_DRAFT]) {
    for (const side of ['left', 'right']) {
      await composerAt(page, side).fill(draft);
      const row = await composerRow(page, slotSelector(side));
      const problems = rowProblems(row, 'running', OPTS);
      const where = `${label} ${side}${draft ? '+字' : ''}`;
      if (problems.length) bad.push(`${where}: ${problems.join('; ')} (${rowSummary(row)})`);
    }
  }
  return bad;
}

/**
 * @brief 两栏都在生成、回放桥停在等界面的 approval.answer 时（录制里先来右栏的卡，答了它左栏才继续、才来左栏的卡；
 *        所以等到有一张批准卡、两栏都在生成，这时回放不往下走，不会再来新的卡关菜单）：
 *        左栏收到 280–461px 各档、右边一栏收到 279px（.pane-slot 280px），两栏输入框下面一行都不换行、不超出输入框，
 *        截短的先后和最窄对；280px 有字时权限菜单、▾ 菜单、圆环详情往上打开、在这一栏里；同时只开一个（oneAtATime）。
 *        量完清掉输入框、两栏各一半，不发命令（回放桥核对）。
 */
async function narrowSplit(page) {
  await page.locator(`${slotSelector('left')} [data-testid="approval-card"], ${slotSelector('right')} `
    + '[data-testid="approval-card"]').first().waitFor({ timeout: 60000 });
  await page.waitForFunction((slots) => slots.every((css) => document.querySelector(`${css} [data-testid="chat-pane"]`)
    ?.dataset.running === 'true'), [slotSelector('left'), slotSelector('right')], { timeout: 60000 });
  await closeRightPanel(page);
  const bad = [];
  for (const width of NARROW_LEFT) {
    const got = await setSplitWidth(page, 'left', width);
    bad.push(...(Math.abs(got - width) > 0.5 ? [`left ${got}px ≠ ${width}px`] : await bothRows(page, `${width}px`)));
  }
  const right = await setSplitWidth(page, 'right', 279);
  bad.push(...(Math.abs(right - 279) > 0.5 ? [`right ${right}px`] : await bothRows(page, 'right 279px')));
  record('分屏：两栏都在生成时，左栏 280–461px 各档、右边一栏 279px，两栏的输入框下面一行（空 / 有字）不换行、不超出输入框，'
    + '每档该有的都在，截短的先后和最窄对，Effort 不可用、范围按钮可用，两者悬停写明原因', bad.length === 0, bad.slice(0, 4).join(' | '));
  await setSplitWidth(page, 'left', 280);
  await composerAt(page, 'left').fill(NARROW_DRAFT);
  const menus = await popoverChecks(page, slotSelector('left'), ['permission', 'queue', 'ring']);
  record('分屏 280px 生成中有字：权限菜单、▾ 菜单、圆环详情往上打开，在这一栏会话面板和窗口里、不盖顶栏、不比这一行宽',
    menus.length === 0, menus.join('; '));
  await oneAtATime(page);
  for (const side of ['left', 'right']) await composerAt(page, side).fill('');
  await page.locator('[data-resize="split"]').dblclick();
}

/**
 * @brief 开着权限菜单时点圆环：权限菜单关上、圆环详情开着（这一行的浮层同时只开一个，models.md"菜单的位置与键盘"）；
 *        两栏各一个圆环、另一栏的详情没开。
 */
async function oneAtATime(page) {
  const left = slotSelector('left');
  await page.locator(`${left} [data-testid="permission-button"]`).click();
  await page.getByTestId('permission-menu').waitFor({ timeout: 3000 }).catch(() => {});
  const ring = await openRingDetails(page, left);
  const menus = await page.getByTestId('permission-menu').count();
  if (ring?.details) await page.keyboard.press('Escape');
  const rings = await page.evaluate(() => [...document.querySelectorAll('.pane-slot:not([hidden])')]
    .map((slot) => slot.querySelectorAll('[data-testid="usage"]').length));
  const right = await ringState(page, slotSelector('right'));
  record('分屏：开着权限菜单时点圆环，权限菜单关上、只开着圆环详情；两栏各有一个圆环', menus === 0 && Boolean(ring?.details)
    && rings.join() === '1,1' && right?.details === null, JSON.stringify({ menus, details: ring?.details, rings }));
}

/** @brief 右栏跟随焦点所在的一栏：左栏改了 README.md，右栏写了 notes.md。 */
async function rightPanelFollows(page) {
  const files = async () => page.getByTestId('right-panel').locator('.change-path, [data-testid="change-file"]')
    .allInnerTexts().catch(() => []);
  const panelText = async () => page.getByTestId('right-panel').innerText({ timeout: 3000 }).catch(() => '');
  await paneAt(page, 'left').getByTestId('transcript').click({ position: { x: 20, y: 20 } });
  await sleep(300);
  const onLeft = await panelText();
  await paneAt(page, 'right').getByTestId('transcript').click({ position: { x: 20, y: 20 } });
  await sleep(300);
  const onRight = await panelText();
  const state = await splitState(page);
  record('右栏跟随焦点所在的一栏：点左栏显示 README.md 的改动，点右栏显示 notes.md 的改动',
    onLeft.includes('README.md') && !onLeft.includes('notes.md') && onRight.includes('notes.md')
    && !onRight.includes('README.md') && state.slots[1].focused, JSON.stringify({ onLeft: onLeft.slice(0, 120),
      onRight: onRight.slice(0, 120), files: await files() }));
}

/** @brief F8 跟随焦点：报告里的"Current session"是焦点所在的那一栏，另记一行"Split view"。 */
async function f8Follows(page, h) {
  await composerAt(page, 'left').click();
  const leftTitle = await paneAt(page, 'left').getByTestId('session-title').innerText();
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('issue-what').fill('分屏时 F8 的报告');
  await page.getByTestId('issue-dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('issue-saved').waitFor({ timeout: 5000 });
  const issue = (await h.status()).issues.at(-1);
  await page.keyboard.press('Escape');
  const field = (label) => issue?.view.find((item) => item.label === label)?.value;
  record('F8 跟随焦点：报告里的"当前会话"是焦点所在的左栏，另有一行"分屏"写明两栏和焦点在左栏',
    field('Current session') === leftTitle && field('Split view')?.includes('(focus in the left pane)'),
    JSON.stringify(issue?.view));
  await viewFields(page, issue?.view, 'left');
  await composerAt(page, 'right').click();
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('issue-what').fill('分屏时右栏的 F8');
  await page.getByTestId('issue-dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('issue-saved').waitFor({ timeout: 5000 });
  const rightIssue = (await h.status()).issues.at(-1);
  await page.keyboard.press('Escape');
  await viewFields(page, rightIssue?.view, 'right');
}

/**
 * @brief F8 报告"Current view"的"Model range""Effort""Pane width"（f8.md"保存的内容"、composer-pickers.md"我自己定的"
 *        第 16 条）：都是焦点所在那一栏的；Pane width 是那一栏 .chat-pane 的宽，右边那一栏比 .pane-slot 窄 1px；
 *        三项的位置；"Model""Permission mode"照旧。view 是回放桥收到的报告字段（[{ label, value }]）。
 */
async function viewFields(page, view, side) {
  const items = view ?? [];
  const field = (label) => items.find((item) => item.label === label)?.value ?? null;
  const problems = viewProblems(field, items.map((item) => item.label), await paneView(page, side), side);
  record(`F8：在${side === 'left' ? '左' : '右'}栏按，"Current view"的"Model range""Model""Effort"是这一栏的，`
    + `"Pane width"是这一栏 .chat-pane 的宽${side === 'right' ? '（比 .pane-slot 窄 1px）' : ''}，`
    + '三项在"Model"前后和"Window size"后面', problems.length === 0, `${problems.join('; ')} ${JSON.stringify(items)}`);
}

/** @brief 走查 2：左栏的长命令在右栏生成时按 Esc，只停止左栏；右栏照常写完。 */
async function splitEsc(page, h) {
  const fx = await h.load('split-esc', { speed: 2, maxGap: 600 });
  const { a } = await openSplit(page, h, fx);
  const [sleepPrompt, longer] = promptsOf(fx);
  await sendAt(page, 'left', sleepPrompt.text);
  await answerInOrder(page, fx, { [a.sessionId]: 'left' });
  await sendAt(page, 'right', longer.text);
  await page.waitForFunction(() => document.querySelector('.pane-slot[data-side="right"] [data-testid="assistant"]')
    ?.textContent.length > 40, null, { timeout: 60000 });
  await composerAt(page, 'left').click();
  await page.keyboard.press('Escape');
  await waitPaneIdle(page, 'left');
  const rightRunning = (await splitState(page)).slots[1].running;
  await waitPaneIdle(page, 'right');
  const notices = async (side) => paneAt(page, side).getByTestId('notice').allInnerTexts();
  const leftNotices = await notices('left');
  const rightNotices = await notices('right');
  record('split-esc：焦点在左栏按 Esc 只停止左栏（"已停止"），右栏这时还在生成、之后照常写完，没有"已停止"',
    leftNotices.some((text) => text.startsWith('Stopped')) && rightRunning
    && !rightNotices.some((text) => text.startsWith('Stopped')), JSON.stringify({ leftNotices, rightNotices,
      rightRunning }));
  await shot(page, 'split-esc');
  await finish(page, 'split-esc', fx);
}

/** @brief 预览里没有界面文字；每一轮的标题是"Turn N · ~Y characters"。 */
function previewClean(preview) {
  const words = UI_WORDS.filter((word) => preview.turns.some((turn) => turn.text.includes(word)));
  return { ok: words.length === 0
    && preview.turns.every((turn) => turn.heading.startsWith(`Turn ${turn.number} · ~`)), words };
}

/** @brief 走查 4 与反例：拖 C 进输入框，预览按轮、改成第 3–5 轮发出；回放桥核对全文和 refs。 */
async function referenceTurns(page, h, fx, c) {
  await h.openFolder();
  const hint = await dragWithHint(page, rowOf(page, c.sessionFile),
    page.locator('.pane-slot[data-focused="true"] [data-drop="composer"]'));
  const chip = await waitSessionChip(page, 'focused');
  record('ref-turns：把会话 C 拖进输入框，放下前提示"松开以引用到这个会话"；芯片"引用 · 会话名 · 第 1–6 轮 · 约 X 字"',
    hint?.kind === 'reference' && hint.text === 'Drop to attach as context'
    && /^Context · .+ · turns 1–6 · ~[\d,]+ characters$/.test(chip),
    JSON.stringify({ hint, chip }));
  await page.locator('.pane-slot[data-focused="true"] [data-testid="quote-chip"] .quote-chip-main').click();
  await waitPreview(page);
  const before = await previewState(page);
  const heading = await previewHeading(page);
  await shot(page, 'ref-turns-preview');
  record('ref-turns：轮次列表占满预览对话框时（默认窗口大小），标题"Context · <会话名>"完整显示，只有一行、没有被压矮',
    Boolean(heading?.listFull) && headingWhole(heading), JSON.stringify(heading));
  const clean = previewClean(before);
  record('ref-turns：预览按"第 N 轮"列出 6 轮和总字数；工具调用只有一行标题、没有工具输出；没有按钮、"思考"等界面文字',
    before.turns.length === 6 && before.options === 6 && clean.ok
    && /\n\[Tool\] (Read|Run) [^\n]+\n/.test(before.turns[1].text)
    && !before.turns[1].text.includes('This folder is used') && /^~[\d,]+ characters$/.test(before.total ?? ''),
    JSON.stringify({ clean, turn2: before.turns[1]?.text.slice(0, 200), total: before.total }));
  await pickRange(page, 3, 5);
  const picked = await previewState(page);
  await page.getByTestId('ref-preview').getByRole('button', { name: 'Done' }).click();
  const after = await waitSessionChip(page, 'focused');
  record('ref-turns：改成第 3–5 轮：范围外的轮次标"不引用"、总字数变小；确定后芯片变成"第 3–5 轮"',
    picked.turns.filter((turn) => turn.included).map((turn) => turn.number).join() === '3,4,5'
    && picked.total !== before.total && after.includes('· turns 3–5 ·'),
  JSON.stringify({ total: picked.total, after }));
  const sent = promptsOf(fx)[0];
  await sendAt(page, 'focused', sent.text.split('\n\n').at(-1));
  await waitPaneIdle(page, 'focused');
}

/** @brief 走查 5：改名后发出的引用显示新名字、仍能跳回；点它打开 C、第 3–5 轮高亮。 */
async function jumpAfterRename(page, h, c, newName) {
  await h.rowMenu(c.sessionFile, 'Rename');
  await page.getByTestId('rename-input').fill(newName);
  await page.getByTestId('rename-input').press('Enter');
  await page.waitForFunction((name) => [...document.querySelectorAll('[data-testid="sent-quote"] .quote-chip-label')]
    .some((label) => label.textContent.includes(name)), newName, { timeout: 10000 });
  const sent = await sentSessionRefs(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 20000 });
  const flashed = await flashedAt(page, 'focused');
  const title = await paneAt(page, 'focused').getByTestId('session-title').innerText();
  record('ref-turns：发出的消息上方显示会话引用；C 改名后引用显示新名字，点它打开 C 并高亮第 3–5 轮（3 条你的消息）',
    sent[0]?.label.startsWith(`Context · ${newName} · turns 3–5 · ~`) && title === newName && flashed.users.length === 3
    && flashed.users[0].startsWith('我们来讨论'), JSON.stringify({ sent: sent[0]?.label, title, flashed }));
}

/** @brief 走查 5 后半：删除 C 后引用显示"Session deleted"，原文仍可查看。 */
async function deletedSource(page, h, a, c) {
  await h.rowMenu(c.sessionFile, 'Delete…');
  await page.getByTestId('delete-dialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByTestId('delete-dialog').waitFor({ state: 'detached', timeout: 10000 });
  await rowOf(page, a.sessionFile).click();
  await page.waitForFunction(() => [
    ...document.querySelectorAll('.pane-slot[data-focused="true"] [data-testid="sent-quote"]'
      + ' [data-testid="quote-status"]'),
  ].some((item) => item.textContent === 'Session deleted'), null,
  { timeout: 10000 });
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.getByTestId('ref-preview').waitFor({ timeout: 5000 });
  const preview = await previewState(page);
  record('ref-turns：删除 C 后引用标"原会话已删除"；点它看到引用时的原文（第 3–5 轮），不能改范围',
    preview.notes.includes('Session deleted · Showing the attached text') && preview.stored?.startsWith('Turn 3')
    && preview.from === null, JSON.stringify({ notes: preview.notes, stored: preview.stored?.slice(0, 80) }));
  await shot(page, 'ref-turns-deleted');
  await page.keyboard.press('Escape');
}

/** @brief ref-turns：引用、改范围、发出；改名后跳回；删除后原文仍可查看。 */
async function refTurns(page, h) {
  const fx = await h.load('ref-turns');
  const c = resultsOf(fx, 'session.list')[0][0];
  const [a] = resultsOf(fx, 'session.create');
  await referenceTurns(page, h, fx, c);
  await shot(page, 'ref-turns-sent');
  const rename = commandsOf(fx).find((cmd) => cmd.type === 'session.rename');
  await jumpAfterRename(page, h, c, rename.name);
  await shot(page, 'ref-turns-jump');
  await deletedSource(page, h, a, c);
  await finish(page, 'ref-turns', fx);
}

/** @brief 重启后：打开 A，消息里的会话引用还在，点它打开 C 并高亮第 1–2 轮。 */
async function refReopen(page, h) {
  const fx = await h.load('ref-reopen');
  const [a, c] = resultsOf(fx, 'session.open');
  await rowOf(page, a.sessionFile).click();
  await waitPaneReady(page, 'focused');
  const sent = await sentSessionRefs(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 20000 });
  const flashed = await flashedAt(page, 'focused');
  const title = await paneAt(page, 'focused').getByTestId('session-title').innerText();
  record('ref-reopen：重启后打开 A，消息上方的会话引用还在（来自会话记录的 mori.ref）；点它打开 C、高亮第 1–2 轮',
    sent[0]?.label.includes('· turns 1–2 · ~') && flashed.users.length === 2 && c.sessionFile && title.length > 0,
    JSON.stringify({ sent, flashed, title }));
  await shot(page, 'ref-reopen');
  await finish(page, 'ref-reopen', fx);
}

/** @brief 反例：引用正在生成的会话只取已完成的轮次；菜单"Attach as context"与拖动相同。 */
async function refRunning(page, h) {
  const fx = await h.load('ref-running', { speed: 2, maxGap: 600 });
  const [c] = resultsOf(fx, 'session.create');
  const [first, second, longer, ask] = promptsOf(fx);
  await h.openFolder();
  for (const prompt of [first, second]) {
    await sendAt(page, 'focused', prompt.text);
    await waitPaneIdle(page, 'focused');
  }
  await h.ctrlN();
  await rowOf(page, c.sessionFile).click();
  await sendAt(page, 'focused', longer.text);
  await page.waitForFunction(() => document
    .querySelector('.pane-slot[data-focused="true"] [data-testid="assistant"]:last-of-type')
    ?.textContent.length > 20, null, { timeout: 60000 }).catch(() => {});
  const rows = page.locator('[data-testid="session-tree"] .session-item');
  const aFile = await rows.evaluateAll((items, file) => items.map((item) => item.dataset.file).find((f) => f !== file),
    c.sessionFile);
  await rowOf(page, aFile).click();
  await h.rowMenu(c.sessionFile, 'Attach as context');
  const chip = await waitSessionChip(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="quote-chip"] .quote-chip-main').click();
  await waitPreview(page);
  const preview = await previewState(page);
  await page.keyboard.press('Escape');
  record('ref-running：引用正在生成的会话（菜单"引用到当前会话"）只取已完成的 2 轮；预览说明"这个会话还在生成"',
    chip.includes('· turns 1–2 ·') && preview.turns.length === 2 && preview.options === 2
    && preview.notes.includes('This session is still running. Only the 2 finished turns are listed.'),
    JSON.stringify({ chip, notes: preview.notes }));
  await sendAt(page, 'focused', ask.text.split('\n\n').at(-1));
  await waitPaneIdle(page, 'focused');
  await shot(page, 'ref-running');
  await finish(page, 'ref-running', fx);
}

/** @brief 超过 2 万字时默认只引用最近 5 轮。 */
async function refLong(page, h) {
  const fx = await h.load('ref-long', { speed: 8, maxGap: 300 });
  const [c] = resultsOf(fx, 'session.create');
  const prompts = promptsOf(fx);
  await h.openFolder();
  for (const prompt of prompts.slice(0, 6)) {
    await sendAt(page, 'focused', prompt.text);
    await waitPaneIdle(page, 'focused');
  }
  await h.ctrlN();
  await dragWithHint(page, rowOf(page, c.sessionFile),
    page.locator('.pane-slot[data-focused="true"] [data-drop="composer"]'));
  const chip = await waitSessionChip(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-testid="quote-chip"] .quote-chip-main').click();
  await waitPreview(page);
  const preview = await previewState(page);
  await page.keyboard.press('Escape');
  const total = Number(chip.match(/~([\d,]+) characters/)?.[1].replace(/,/g, '') ?? 0);
  record('ref-long：全部超过 2 万字时默认只引用最近 5 轮（第 2–6 轮），第 1 轮标"不引用"',
    chip.includes('· turns 2–6 ·') && total > 20000 && preview.turns[0]?.included === false
    && preview.turns.slice(1).every((turn) => turn.included),
  JSON.stringify({ chip, first: preview.turns[0]?.heading }));
  await sendAt(page, 'focused', prompts[6].text.split('\n\n').at(-1));
  await waitPaneIdle(page, 'focused');
  await finish(page, 'ref-long', fx);
}

const checks = { 'split-approvals': splitApprovals, 'split-esc': splitEsc, 'ref-turns': refTurns,
  'ref-reopen': refReopen, 'ref-running': refRunning, 'ref-long': refLong };

await buildHarness();
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], env: { ...process.env,
  MORI_HARNESS_INDEX: join(outDir, 'index.html'),
  MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-m5-harness-')) } });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const h = helpers(page);
try {
  for (const [name, check] of Object.entries(checks)) {
    if (only && !only.includes(name)) continue;
    try {
      await check(page, h);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 500));
      await shot(page, `${name}-error`);
    }
  }
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await app.close();
}
process.exitCode = write('m5-replay.json') ? 0 : 1;
