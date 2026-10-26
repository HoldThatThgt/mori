// M6 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的会话（tests/fixtures/m6）。
// 测试像你一样操作（设置页添加模型、标"Supports thinking"、写用户级 AGENTS.md；输入框下面一行换范围和思考强度（2026-10-21
// 起这几个按钮从顶栏移到这一行，docs/v0/composer-pickers.md）；工具页启停技能、用表单添加
// MCP 服务、"Add plugin from folder…"、按资源和整个包启停；输入框里打"/"选技能命令和提示词模板；批准卡），回放桥核对界面发出的
// 每条命令都与录制时一致；设置页、工具页、"/"补全读到的内容是录制时后台进程真的给出的。再按 docs/v0/screens/settings.md、
// models.md、tools.md、slash.md 检查界面。M1–M5 的回放检查仍由 m1–m5-replay 负责。
// 不发命令的操作（重名时界面先拦下、取消删除和移除、撤销与放弃改动、Esc 和点外面关菜单、键盘选择、"Open in default app"）
// 也在这里走一遍：回放桥会把多发的命令记为不一致，所以"没有多发"由收尾的检查保证。
// mcp 回放的是 synthetic-mcp-setup（harness/main.jsx 的 mcpSetup，synthetic）：录制在打开任何会话之前就保存了 MCP 服务，
// 而界面只在有会话时才有"MCP"一节，所以前面补一个先打开的会话，在它的工具页里添加，再"New session"建出录制里的会话。
// v1（docs/specs/model-providers.md §14.4）：m6/model-switch.json、m6/thinking.json 与它们的检查删去（v1 不再有 model.save、
// session.setModel；换范围由 v1-models 的回放覆盖）；思考强度改由 fixtures/v1/thinking.json（m6-record.mjs 用 v1 录制）
// 回放，这个录制还没有时那一项记 KNOWN；设置页分节导航的检查改到 Models 分节（放在 agents-md 里）。
// 2026-10-26（负责人走查 M4）：AGENTS.md 一节从设置页挪到 Customize 的第一节（docs/v1/screens/customize-agents-md.md），
// agents-md 从 Customize 进，分节导航的检查改成 Customize 的 AGENTS.md ↔ Skills，离开的入口改用侧栏的 Settings。
// 按钮状态的读法（composer-pickers.md"测试要改的地方"C1、C2）："不可用"读 aria-disabled（没有 data-pending），"切换中"读
// data-pending；悬停按行分开（范围按钮三行、Effort 两行），读屏的描述读 aria-describedby 指向的元素。thinking 回放里另走一次
// 换范围失败（回放桥 failNext 让这一条 session.setPick 失败，synthetic，不占回放顺序）和点开上下文用量圆环（不发命令）。
// 用法（在 app/ 下）：node tests/ui/m6-replay.mjs [--only thinking,slash]
// 结果写到 test-results/m6-replay.json；截图在 test-results/m6-replay/。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
// 回放桥当作只读查询回答、不占回放顺序的命令，与回放桥用同一份列表（平行 Agent 规格 §17.4）。
import { QUERIES } from './harness/replay.js';
import { appRoot, arg, createRecorder, oneLine } from './lib.mjs';
import { composerAt, sendAt, waitPaneIdle, waitPaneReady } from './m5-helpers.mjs';
import {
  modelRow, NOTE, openToolsSection, PICK_ERROR, placeProblems, popupBox, popupGone, POPUPS, ROW, rangeDescription,
  ringState, slashItems,
} from './m6-helpers.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-m6');
const fixtureDir = join(appRoot, 'tests/fixtures/m6');
const shots = join(appRoot, 'test-results/m6-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 焦点所在的一栏（不分屏时就是显示的那一栏） */
const FOCUSED = '.pane-slot[data-focused="true"]:not([hidden])';

/** @brief 读取一个 M6 录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
/** v1 的录制（m6-record.mjs 的思考强度场景写到这里） */
const v1Dir = join(appRoot, 'tests/fixtures/v1');
/**
 * @brief 录制里界面发出的命令（只读查询与回放桥直接应答的 models.* 写命令除外，同 harness/replay.js），
 *        下标与回放桥的 cursor 一致。
 */
const commandsOf = (fx) => fx.steps.filter((s) => s.command && !QUERIES.includes(s.command.type)
  && !s.command.type.startsWith('models.')).map((s) => s.command);
/** @brief 录制里某种命令的结果（按顺序）。 */
const resultsOf = (fx, type) => fx.steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
/** @brief 录制里的你的消息（按顺序）。 */
const promptsOf = (fx) => commandsOf(fx).filter((c) => c.type === 'session.prompt');
/** @brief 录制里某种命令的第一条。 */
const commandOf = (fx, type) => commandsOf(fx).find((c) => c.type === type);

/** @brief 录制里一个会话有正文的助手回复（message_end），按顺序：模型、正文、有没有思考内容。 */
function recordedReplies(fx, sessionId) {
  return fx.steps.filter((s) => s.envelope?.sessionId === sessionId && s.envelope.event.type === 'message_end'
    && s.envelope.event.message.role === 'assistant').map((s) => s.envelope.event.message)
    .map((m) => ({ model: m.model, text: m.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim(),
      thinking: m.content.some((c) => c.type === 'thinking' && c.thinking.trim()) }))
    .filter((m) => m.text);
}

/** @brief 构建回放页面（与 m1–m5 回放用不同的输出目录）。 */
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

/** @brief 收尾：回放桥没有不一致，录制里的命令全部用上了（total 为界面应发出的命令数）。 */
async function finish(page, name, total) {
  await untilBridge(page, 'played', total, `all ${total} commands of ${name}`);
  const status = await page.evaluate(() => window.__replay.status);
  record(`${name}：界面发出的命令与录制一致（${total} 条），没有多发或少发`,
    status.errors.length === 0 && status.cursor === total && status.commands.length === total,
    status.errors.join('; ') || `commands ${status.commands.length}`);
}

/** @brief 侧栏里名字为 name 的按钮。 */
const sideButton = (page, name) => page.getByTestId('sidebar').getByRole('button', { name, exact: true });
/** @brief 工具页里名字为 name 的按钮（第一个）。 */
const toolsButton = (page, name) => page.getByTestId('tools-page').getByRole('button', { name, exact: true }).first();

/** @brief 测试用的页面操作。 */
function helpers(page) {
  return {
    /** @brief 载入录制文件（或 synthetic 的拼法），等侧栏读完会话列表。 */
    async load(name, { speed = 4, maxGap = 600 } = {}) {
      const index = pathToFileURL(join(outDir, 'index.html')).href;
      await page.goto(`${index}?fixture=${name}&speed=${speed}&maxGap=${maxGap}`);
      await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
    },
    status: () => page.evaluate(() => window.__replay.status),
    /** @brief 界面到现在发出的命令数（含被回放桥拒绝的）。 */
    sent: () => page.evaluate(() => window.__replay.status.commands.length),
  };
}

/**
 * @brief 开始记下 css 选中的元素每次变化后的样子（文字、aria-disabled、data-pending（输入框下面一行的按钮"切换中"，C1）、
 *        是否不可用：元素本身，或它里面的编辑框），看只出现一瞬间的状态（读取中、切换中、保存中）。用 MutationObserver
 *        跟着页面变化记，不靠定时取样；watched 取回并停止。
 */
function watch(page, css) {
  return page.evaluate((sel) => {
    const seen = [];
    const take = () => {
      const el = document.querySelector(sel);
      const disabled = el && ('disabled' in el ? el.disabled : el.querySelector('textarea')?.disabled ?? null);
      const now = el ? { text: el.textContent, pending: el.getAttribute('aria-disabled') === 'true',
        switching: el.getAttribute('data-pending') === 'true', disabled } : null;
      const last = seen.at(-1);
      if (now && (last?.text !== now.text || last?.pending !== now.pending || last?.switching !== now.switching
        || last?.disabled !== now.disabled)) {
        seen.push(now);
      }
    };
    const observer = new MutationObserver(take);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    take();
    window.__watch = { seen, stop: () => observer.disconnect() };
  }, css);
}

/** @brief 取回 watch 记下的样子并停止。 */
const watched = (page) => page.evaluate(() => {
  window.__watch.stop();
  return window.__watch.seen;
});

/** @brief 点 scope 里的"Open in default app"，等回放桥记下这次调用；返回打开的路径（没有调用时为 null）。 */
async function openInEditor(page, scope) {
  const count = await page.evaluate(() => window.__replay.status.opened.length);
  await scope.getByRole('button', { name: 'Open in default app' }).first().click();
  await page.waitForFunction((n) => window.__replay.status.opened.length > n, count, { timeout: 5000 }).catch(() => {});
  return page.evaluate((n) => window.__replay.status.opened[n]?.path ?? null, count);
}

/** @brief 确认框的标题、说明和焦点所在的按钮。 */
const dialogView = (dialog) => dialog.evaluate((el) => ({ title: el.querySelector('h2')?.textContent ?? null,
  text: el.querySelector('p')?.textContent ?? null, focused: document.activeElement?.textContent ?? null }));

/** @brief 等 testId 的确认框出现，记下它的样子，点"Cancel"，等它关上。 */
async function cancelDialog(page, testId) {
  const dialog = page.getByTestId(testId);
  await dialog.waitFor({ timeout: 5000 });
  const seen = await dialogView(dialog);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return { ...seen, closed: await dialog.count() === 0 };
}

/**
 * @brief 点 button 新建会话（"Open folder…"由回放桥返回下一条 session.create 的文件夹；工具页的"New session"在跟随的项目里
 *        新建）；trust 为 true / false 时在信任询问里选"Trust workspace" / "Don’t trust"，undefined 表示不会问。等新会话就绪。
 * @return 信任询问里"Remember my choice"一开始是否勾着（没问时为 null）
 */
async function newSessionVia(page, button, trust) {
  const before = await page.locator('.pane-slot').count();
  await button.click();
  let remembered = null;
  if (trust !== undefined) {
    const dialog = page.getByTestId('trust-dialog');
    await dialog.waitFor({ timeout: 15000 });
    remembered = await dialog.getByRole('checkbox').isChecked();
    await dialog.getByRole('button', { name: trust ? 'Trust workspace' : 'Don’t trust', exact: true }).click();
  }
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, before, { timeout: 20000 });
  await waitPaneReady(page, 'focused');
  return remembered;
}

/** @brief 设置页分节列表里当前（aria-current）的一节；没有时为 null。 */
const currentSection = (page) => page.locator('[data-testid="settings-nav"] button[aria-current="page"]')
  .getAttribute('data-section', { timeout: 3000 }).catch(() => null);

/** @brief 打开设置页的某一节（models / agents）；返回打开时落在哪一节。 */
async function openSettings(page, section) {
  await sideButton(page, 'Settings').click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  const landed = await currentSection(page);
  await page.locator(`[data-testid="settings-nav"] button[data-section="${section}"]`).click();
  return landed;
}

/** @brief 进入 Customize（侧栏"Customize"；2026-10-26 起落在第一节 AGENTS.md）。 */
async function openCustomize(page) {
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
}

/** @brief Customize 分节列表里当前（aria-current）的一节；没有时为 null。 */
const toolsCurrent = (page) => page.locator('[data-testid="tools-nav"] button[aria-current="page"]')
  .getAttribute('data-section', { timeout: 3000 }).catch(() => null);

/** @brief 设置页顶部的"Back to app"；有会话时等它就绪。 */
async function leaveSettings(page, session = true) {
  await page.getByTestId('settings-page').getByRole('button', { name: 'Back to app' }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
  if (session) await waitPaneReady(page, 'focused');
}

/**
 * @brief 当前一栏输入框下面一行的范围按钮和思考按钮（composer-pickers.md"测试要改的地方"C1、C2）：范围按钮的文字、悬停
 *        说明（按行）、读屏的描述、是否不可用（aria-disabled 且没有 data-pending）；思考按钮的文字、强度、是否支持思考、
 *        悬停说明（按行）、读屏的描述、是否不可用；两个按钮里有没有切换中的（data-pending）；两个按钮在不在这一行里。
 */
function rowPickers(page) {
  return page.evaluate(({ css, rowCss }) => {
    const row = document.querySelector(`${css} ${rowCss}`);
    const model = row?.querySelector('[data-testid="model-button"]');
    const thinking = row?.querySelector('[data-testid="thinking-button"]');
    const lines = (el) => (el?.title ? el.title.split('\n') : []);
    const described = (el) => (el?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    const unavailable = (el) => el?.getAttribute('aria-disabled') === 'true' && el.dataset.pending !== 'true';
    return { model: model?.textContent ?? null, modelTip: lines(model), modelDescribed: described(model),
      modelUnavailable: unavailable(model), thinking: thinking?.textContent ?? null,
      level: thinking?.dataset.level ?? null, reasoning: thinking?.dataset.reasoning ?? null,
      thinkingTip: lines(thinking), thinkingDescribed: described(thinking), thinkingUnavailable: unavailable(thinking),
      pending: model?.dataset.pending === 'true' || thinking?.dataset.pending === 'true',
      inRow: Boolean(model && thinking) };
  }, { css: FOCUSED, rowCss: ROW });
}

/**
 * @brief 打开着的模型 / 思考菜单：每项的标识、文字、是否打勾、是否可用；菜单的全部文字；焦点所在的项（模型、强度或文字）。
 *        没打开时为 null。
 */
function menuState(page, testId) {
  return page.evaluate((id) => {
    const menu = document.querySelector(`[data-testid="${id}"]`);
    if (!menu) return null;
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')].map((item) => ({
      model: item.dataset.model ?? null, level: item.dataset.level ?? null, text: item.textContent,
      checked: item.getAttribute('aria-checked') === 'true', disabled: item.disabled }));
    const active = document.activeElement;
    const focused = menu.contains(active) ? active.dataset.model ?? active.dataset.level ?? active.textContent : null;
    return { items, text: menu.textContent, focused };
  }, testId);
}

/** @brief 在当前一栏输入框下面一行点开范围（model-button）或思考（thinking-button）菜单，等焦点落进菜单，返回菜单的样子。 */
async function openMenu(page, button, menu) {
  await page.locator(`${FOCUSED} [data-testid="${button}"]`).click();
  await page.getByTestId(menu).waitFor({ timeout: 5000 });
  await page.waitForFunction((id) => document.activeElement?.closest(`[data-testid="${id}"]`), menu,
    { timeout: 5000 }).catch(() => {});
  return menuState(page, menu);
}

/** @brief 菜单关上之后：菜单是否已经不在、焦点是否回到了这一行的按钮。 */
async function menuClosed(page, menu, button) {
  await page.getByTestId(menu).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return page.evaluate(({ m, b, css }) => ({ closed: !document.querySelector(`[data-testid="${m}"]`),
    focusBack: document.activeElement === document.querySelector(`${css} [data-testid="${b}"]`) }),
  { m: menu, b: button, css: FOCUSED });
}

/** @brief 等当前一栏这一行的 button 显示 want（范围按钮看文字，思考按钮看 data-level），且不在切换中、不是不可用。 */
function waitSwitched(page, button, want) {
  return page.waitForFunction(({ css, id, value }) => {
    const el = document.querySelector(`${css} [data-testid="${id}"]`);
    const shown = id === 'model-button' ? el?.textContent : el?.dataset.level;
    return shown === value && el.getAttribute('aria-disabled') !== 'true';
  }, { css: FOCUSED, id: button, value: want }, { timeout: 15000 });
}

/** @brief 当前一栏的助手回复，按顺序：正文（去掉思考块和工具卡）、思考块的个数。 */
function replies(page) {
  return page.evaluate((css) => [...document.querySelectorAll(`${css} [data-testid="assistant"]`)].map((item) => {
    const copy = item.cloneNode(true);
    copy.querySelectorAll('[data-testid="thinking"], [data-testid="tool-card"]').forEach((node) => node.remove());
    return { text: copy.textContent.trim(), thinking: item.querySelectorAll('[data-testid="thinking"]').length };
  }), FOCUSED);
}

/** @brief 在当前一栏发一条消息，等这一轮结束。 */
async function say(page, text) {
  await sendAt(page, 'focused', text);
  await waitPaneIdle(page, 'focused');
}

/** @brief 等当前一栏出批准卡，记下工具名和标题，点 button（approval-allow / approval-reject）。 */
async function answerCard(page, button) {
  const card = page.locator(`${FOCUSED} [data-testid="approval-card"]`);
  await card.waitFor({ timeout: 60000 });
  const seen = { tool: await card.getAttribute('data-tool'),
    title: await card.getByTestId('approval-title').innerText() };
  await card.getByTestId(button).click();
  return seen;
}

/** @brief 当前一栏最后一张工具卡的状态和标题。 */
function lastToolCard(page) {
  return page.locator(`${FOCUSED} [data-testid="tool-card"]`).last().evaluate((card) => ({ status: card.dataset.status,
    title: card.querySelector('.tool-verb')?.textContent ?? card.textContent.slice(0, 40) })).catch(() => null);
}

/**
 * @brief Customize 分节列表用 ↑ ↓ 切换（没有会话时 AGENTS.md、Skills、Plugins）：↓ 到"Skills"，↑ 回到"AGENTS.md"；
 *        当前分节 aria-current，焦点跟着走。
 */
async function customizeNavKeys(page) {
  const focusedSection = () => page.evaluate(() => document.activeElement?.dataset.section ?? null);
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').focus();
  await page.keyboard.press('ArrowDown');
  const down = { current: await toolsCurrent(page), focused: await focusedSection() };
  await page.keyboard.press('ArrowUp');
  const up = { current: await toolsCurrent(page), focused: await focusedSection() };
  return { down, up };
}

/** @brief 发一道要推理的题，等生成开始时记下输入框下面一行的按钮，等这一轮结束；返回生成中的样子和最后一条回复。 */
async function reason(page, text) {
  await sendAt(page, 'focused', text);
  await page.waitForFunction((css) => document.querySelector(`${css} [data-testid="chat-pane"]`)?.dataset.running
    === 'true', FOCUSED, { timeout: 20000 }).catch(() => {});
  const running = await rowPickers(page);
  await waitPaneIdle(page, 'focused');
  return { running, reply: (await replies(page)).at(-1) ?? null };
}

/** @brief 点开思考菜单点 level，记下切换中按钮的样子，等切换的命令返回。 */
async function clickThinking(page, level) {
  await openMenu(page, 'thinking-button', 'thinking-menu');
  await watch(page, `${FOCUSED} [data-testid="thinking-button"]`);
  await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await waitSwitched(page, 'thinking-button', level);
  return watched(page);
}

/**
 * @brief 走查 8 的前半（v1）：设置 → Models 编辑模型，勾"Supports thinking"，新会话的强度照录制保存（models.saveModel 由
 *        回放桥直接应答，之后读到的 models.get 是录制里保存之后的结果）。
 *        一键拉取模型（docs/specs/model-discovery.md §5.4、§13.4）：Edit 里没设过强度的模型，Default effort for new
 *        sessions 显示录下的 thinkingDefaults（为 null 时 config.get 的 defaultThinkingLevel，没有时 Medium），只在你改了
 *        时才带 thinkingLevel；models.saveModel 没有 adding。录制（旧的界面）总带 thinkingLevel：与显示的相同时不改，
 *        这时不带（新会话按 pi 的 defaultThinkingLevel 得到同一个强度），不同时选它，这时带上。
 */
async function markReasoning(page, fx) {
  const save = fx.steps.find((step) => step.command?.type === 'models.saveModel')?.command;
  const ref = `${save.providerId}/${save.model.id}`;
  const config = fx.steps.find((step) => step.result?.type === 'config.get')?.result.value;
  const models = fx.steps.find((step) => step.result?.type === 'models.get')?.result.value;
  const shown = models?.thinkingDefaults?.[ref] ?? config?.defaultThinkingLevel ?? 'medium';
  const changed = Boolean(save.thinkingLevel) && save.thinkingLevel !== shown;
  await openSettings(page, 'models');
  await modelRow(page, ref).locator('[data-action="edit"]').click();
  const form = page.getByTestId('model-form');
  await form.waitFor({ timeout: 10000 });
  const before = { readOnly: await form.getByLabel('Model ID', { exact: true }).getAttribute('readonly') !== null,
    levelField: await form.getByLabel('Default effort for new sessions').count() };
  await form.getByLabel('Supports thinking').check();
  const select = form.getByLabel('Default effort for new sessions');
  const level = { value: await select.inputValue(), options: await select.locator('option').allInnerTexts() };
  if (save.thinkingLevel && level.value !== save.thinkingLevel) await select.selectOption(save.thinkingLevel);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  const writes = (await page.evaluate(() => window.__replay.status.modelWrites))
    .filter((write) => write.type === 'models.saveModel');
  const model = writes[0]?.model ?? {};
  const sameModel = Object.keys(model).length === Object.keys(save.model).length
    && Object.keys(save.model).every((key) => JSON.stringify(model[key]) === JSON.stringify(save.model[key]));
  record('thinking：编辑模型时 Model ID 只读；勾"Supports thinking"后才出现"Default effort for new sessions"（Off 到 Max，'
    + `没设过强度时显示 ${shown}）；Save 发出 models.saveModel（录下的模型、reasoning: true，没有 adding；强度照录制：`
    + '与显示的相同时不带 thinkingLevel，不同时带上，model-discovery.md §5.4）', before.readOnly && before.levelField === 0
    && level.value === shown && level.options.join() === 'Off,Minimal,Low,Medium,High,Extra high,Max'
    && writes.length === 1 && writes[0].providerId === save.providerId && sameModel && model.reasoning === true
    && !('adding' in writes[0]) && (changed ? writes[0].thinkingLevel === save.thinkingLevel
    : !('thinkingLevel' in writes[0])), JSON.stringify({ before, level, shown, writes }));
  await leaveSettings(page, false);
}

/** @brief 新会话这一行"Effort: <录制的强度>"；菜单列出这个模型可选的强度、都可选，当前的打勾且焦点在它上面。 */
async function thinkingOpened(page, fx) {
  const created = resultsOf(fx, 'session.create')[0];
  const opened = await rowPickers(page);
  const menu = await openMenu(page, 'thinking-button', 'thinking-menu');
  record('thinking：新会话输入框下面一行的思考强度是会话新建时的强度（§11.1，录制的 session.create）；菜单列出当前模型可选的强度'
    + '（录制的 thinkingLevels），都可选，当前的打勾、焦点在它上面，底部说明只作用于这个会话',
  opened.level === created.thinkingLevel && opened.reasoning === 'true'
    && menu?.items.map((item) => item.level).join() === created.thinkingLevels.join()
    && menu.items.every((item) => !item.disabled)
    && menu.items.find((item) => item.checked)?.level === created.thinkingLevel
    && menu.focused === created.thinkingLevel && menu.text
    .includes('Applies to this session only. Set each model’s default for new sessions in Settings.'),
  JSON.stringify({ opened, menu, recorded: { level: created.thinkingLevel, levels: created.thinkingLevels } }));
  await page.keyboard.press('Escape');
  await menuClosed(page, 'thinking-menu', 'thinking-button');
}

/**
 * @brief 点开上下文用量圆环（models.md"上下文用量（圆环）"）：详情打开（aria-expanded、aria-controls 指向它）、Esc 关上；
 *        点开、关上都不发命令（只用已经刷新到的用量；回放桥没有多收到命令）。
 */
async function ringNoCommand(page, h) {
  const sent = await h.sent();
  await page.locator(`${FOCUSED} ${ROW} [data-testid="usage"]`).click();
  await page.locator(POPUPS.usage.popup).waitFor({ timeout: 5000 });
  const open = await ringState(page, `${FOCUSED} [data-testid="chat-pane"]`);
  await page.keyboard.press('Escape');
  const closed = await popupGone(page, POPUPS.usage.popup);
  const after = await h.sent();
  record('thinking：点开上下文用量圆环看详情（aria-expanded、aria-controls 指向详情）、Esc 关上：不发任何命令（回放桥没有'
    + '多收到命令）', sent === after && open?.expanded === 'true' && open.controlsDetails && closed,
  JSON.stringify({ sent, after, open }));
}

/** @brief 打开当前一栏的范围菜单，回放桥让下一条命令失败（failNext），选一个不是当前范围的项；等失败那一行出现。 */
async function failPick(page, before) {
  await page.locator(`${FOCUSED} ${ROW} [data-testid="model-button"]`).click();
  const menu = page.getByTestId('model-menu');
  await menu.waitFor({ timeout: 5000 });
  const picks = await menu.locator('[role="menuitemradio"]')
    .evaluateAll((items) => items.map((item) => item.dataset.pick));
  const target = picks.find((pick) => pick !== before);
  // synthetic：这一条 session.setPick 直接以这段原文失败（回放桥 failNext，不占回放顺序）
  await page.evaluate(() => { window.__replay.failNext = 'Synthetic setPick failure'; });
  await menu.locator(`[role="menuitemradio"][data-pick="${target}"]`).click();
  await page.locator(`${FOCUSED} ${PICK_ERROR.popup}`).waitFor({ timeout: 5000 });
  return target;
}

/**
 * @brief 换范围失败（models.md 表下"换范围失败那一行"、model-menu.md"切换失败"）：session.setPick 失败时
 *        "Couldn’t change the model range: <原文>"（role=alert）从这一行往上弹出（下边在这一行上方 6px）、右边对齐范围按钮
 *        或贴这一行左端、最宽 min(320px, 这一行的宽)、在面板里、不盖顶栏；按钮回到原来的范围；打开范围菜单时它消失；
 *        再失败一次，10 秒后自己消失。
 */
async function pickErrorReplay(page) {
  const button = page.locator(`${FOCUSED} ${ROW} [data-testid="model-button"]`);
  const before = await button.getAttribute('data-pick');
  const target = await failPick(page, before);
  const css = `${FOCUSED} ${PICK_ERROR.popup}`;
  const geo = await popupBox(page, { popup: css, paneCss: `${FOCUSED} [data-testid="chat-pane"]`,
    anchor: PICK_ERROR.opener });
  const shown = await page.locator(css).evaluate((el) => ({ text: el.textContent, role: el.getAttribute('role') }));
  const back = { pick: await button.getAttribute('data-pick'), pending: await button.getAttribute('data-pending') };
  await button.click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  const clearedByMenu = await popupGone(page, css, 2000);
  await page.keyboard.press('Escape');
  await failPick(page, before);
  const start = Date.now();
  const gone = await popupGone(page, css, 13000);
  const waited = Date.now() - start;
  const problems = placeProblems(geo, PICK_ERROR);
  record('thinking：换范围失败时"Couldn’t change the model range: <原文>"（role=alert）从输入框下面一行往上弹出、右边对齐范围'
    + '按钮或贴这一行左端、最宽 min(320px, 这一行)、在面板里不盖顶栏；按钮回到原来的范围；打开范围菜单时它消失；再失败一次'
    + '约 10 秒后自己消失', Boolean(target) && shown.text === 'Couldn’t change the model range: Synthetic setPick failure'
    && shown.role === 'alert' && problems.length === 0 && back.pick === before && back.pending === null && clearedByMenu
    && gone && waited > 8000, JSON.stringify({ target, shown, problems, back, clearedByMenu, gone, waited }));
}

/**
 * @brief 走查 8（v1，fixtures/v1/thinking.json）：把模型标为支持思考，新会话里这一行切到"High"：回复带思考内容；切到"Off"：
 *        不再有思考内容；生成中不能切换。录制还没有时记 KNOWN（要用负责人的数据目录跑 m6-record.mjs --only thinking）。
 */
async function thinking(page, h) {
  if (!existsSync(join(v1Dir, 'thinking.json'))) {
    record('thinking：输入框下面一行思考强度的回放（fixtures/v1/thinking.json）', false,
      'fixtures/v1/thinking.json not recorded yet: run node tests/ui/m6-record.mjs --source <data dir> --only thinking',
      true);
    return;
  }
  const fx = JSON.parse(readFileSync(join(v1Dir, 'thinking.json'), 'utf8'));
  // 放慢一些，生成中这一行的样子看得到
  await h.load('thinking', { speed: 2 });
  await markReasoning(page, fx);
  await newSessionVia(page, sideButton(page, 'Open folder…'));
  await thinkingOpened(page, fx);
  await ringNoCommand(page, h);
  await pickErrorReplay(page);
  const highSeen = await clickThinking(page, 'high');
  const high = await rowPickers(page);
  record('thinking：点"高"：命令返回前按钮已显示"思考：高"且切换中（data-pending，aria-disabled），返回后可用（两个属性都没有）',
    highSeen.some((item) => item.text === 'Effort: High' && item.switching && item.pending) && !high.pending
    && !high.thinkingUnavailable, JSON.stringify(highSeen));
  const [hard, easy] = promptsOf(fx);
  const { running, reply: withThinking } = await reason(page, hard.text);
  record('thinking：生成中输入框下面一行的范围和思考按钮都不可用（aria-disabled，没有 data-pending），范围按钮悬停第三行'
    + '"Can’t switch models until the response finishes"（第一、二行不变）、Effort 悬停第二行"Can’t change effort until the '
    + 'response finishes"；读屏的描述：范围按钮是第二行加". "加原因，Effort 只有原因', running.inRow
    && running.modelUnavailable && running.modelTip[2] === NOTE.modelBusy && running.modelTip.length === 3
    && running.modelDescribed === rangeDescription(running.modelTip) && running.thinkingUnavailable
    && running.thinkingTip[1] === NOTE.effortBusy && running.thinkingDescribed === NOTE.effortBusy,
  JSON.stringify(running));
  await clickThinking(page, 'off');
  const off = await rowPickers(page);
  const without = (await reason(page, easy.text)).reply;
  const recorded = recordedReplies(fx, resultsOf(fx, 'session.create')[0].sessionId);
  record('thinking：这一行切到"高"后的回复带思考块（录制里有思考内容）', high.thinking === 'Effort: High' && high.level === 'high'
    && withThinking?.thinking === 1 && recorded[0]?.thinking
    && withThinking.text.includes(recorded[0].text.slice(0, 6)), JSON.stringify({ high, withThinking }));
  record('thinking：反例：切到"关"后的回复没有思考块', off.thinking === 'Effort: Off' && off.level === 'off'
    && without?.thinking === 0 && recorded[1] && !recorded[1].thinking && without.text === recorded[1].text,
  JSON.stringify({ off, without }));
  await shot(page, 'thinking');
  await finish(page, 'thinking', commandsOf(fx).length);
}

/** @brief AGENTS.md 一节的样子：用户级部分的文字、生效的文件、保存状态、项目级部分的文字、编辑框的个数。 */
function agentsView(page) {
  return page.evaluate(() => ({
    user: document.querySelector('.agents-user')?.textContent ?? '',
    effective: document.querySelector('[data-testid="agents-effective"]')?.textContent ?? null,
    status: document.querySelector('.agents-status')?.textContent ?? null,
    loaded: document.querySelector('[data-testid="agents-loaded"]')?.textContent ?? null,
    editors: document.querySelectorAll('[data-testid="agents-section"] textarea').length,
  }));
}

/** @brief AGENTS.md 编辑框里的字，"Save""Discard changes"是否可用，旁边的状态。 */
function agentsEditor(page) {
  return page.evaluate(() => {
    const buttons = [...(document.querySelector('.agents-user')?.querySelectorAll('button') ?? [])];
    const usable = (name) => buttons.find((button) => button.textContent === name)?.disabled === false;
    return { value: document.querySelector('[data-testid="agents-editor"]')?.value ?? null, save: usable('Save'),
      revert: usable('Discard changes'), status: document.querySelector('.agents-status')?.textContent ?? null };
  });
}

/** @brief 等 AGENTS.md 读完（编辑框可用）。 */
const agentsReady = (page) => page.waitForFunction(() => document.querySelector('[data-testid="agents-editor"]')
  ?.disabled === false, null, { timeout: 10000 });

/**
 * @brief 有未保存的改动时点侧栏的"Settings"：先问"Discard changes to AGENTS.md?"，焦点在"Keep editing"；Esc 等于继续编辑，
 *        留在 Customize、焦点回到编辑框（2026-10-26 前这一节在设置页，入口是"Customize"）。
 */
async function leaveUnsaved(page) {
  await sideButton(page, 'Settings').click();
  const dialog = page.getByTestId('leave-dialog');
  await dialog.waitFor({ timeout: 5000 }).catch(() => {});
  const asked = await dialogView(dialog).catch(() => null);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const after = await page.evaluate(() => ({ settings: Boolean(document.querySelector('[data-testid="settings-page"]')),
    tools: Boolean(document.querySelector('[data-testid="tools-page"]')),
    editorFocused: document.activeElement?.dataset.testid === 'agents-editor' }));
  record('agents-md：有未保存的改动时点侧栏"设置"先问"放弃对 AGENTS.md 的改动？"（"你改的内容还没有保存。"），焦点在"继续编辑"；'
    + 'Esc 等于继续编辑：留在 Customize，焦点回到编辑框', asked?.title === 'Discard changes to AGENTS.md?'
    && asked.text === 'Your edits haven’t been saved. Leaving now discards them.' && asked.focused === 'Keep editing'
    && after.tools && !after.settings
    && after.editorFocused, JSON.stringify({ asked, after }));
}

/** @brief 写好后点"Discard changes"：回到读到的内容，"Unsaved changes"消失，两个按钮都不可用。 */
async function revertAgents(page, content) {
  const clean = await agentsEditor(page);
  await page.getByTestId('agents-editor').fill(content);
  const dirty = await agentsEditor(page);
  await page.locator('.agents-user').getByRole('button', { name: 'Discard changes', exact: true }).click();
  const reverted = await agentsEditor(page);
  record('agents-md：没改时"保存""撤销改动"都不可用；写了字后两个都可用、旁边"有未保存的改动"；点"撤销改动"回到读到的内容'
    + '（空），提示消失、按钮又不可用', !clean.save && !clean.revert && clean.value === '' && dirty.save && dirty.revert
    && dirty.status === 'Unsaved changes' && dirty.value === content && reverted.value === ''
    && reverted.status === null && !reverted.save && !reverted.revert, JSON.stringify({ clean, dirty, reverted }));
}

/** @brief 有未保存的改动时点侧栏"Settings"，在确认框里选"Discard"：照常离开到设置页；回来时编辑框是读到的内容。 */
async function discardAgents(page, content) {
  await page.getByTestId('agents-editor').fill(content);
  await sideButton(page, 'Settings').click();
  const dialog = page.getByTestId('leave-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  const left = await page.getByTestId('settings-page').waitFor({ timeout: 10000 }).then(() => true, () => false);
  await leaveSettings(page, false);
  await openCustomize(page);
  await agentsReady(page);
  const back = await agentsEditor(page);
  record('agents-md：确认框里选"放弃改动"：照常离开到设置页；再回到 AGENTS.md 时编辑框是读到的内容（空）、没有未保存的改动',
    left && back.value === '' && back.status === null && !back.save, JSON.stringify({ left, back }));
}

/** @brief 写好后在编辑框里按 Ctrl+S 保存：经过"Saving…"，然后"Saved · Applies to new sessions"并标出生效的文件。 */
async function saveAgentsByKey(page, content) {
  await page.getByTestId('agents-editor').fill(content);
  const dirty = await agentsView(page);
  await watch(page, '.agents-status');
  await page.getByTestId('agents-editor').press('Control+s');
  await page.waitForFunction(() => document.querySelector('.agents-status')?.textContent
    === 'Saved · Applies to new sessions'
    && document.querySelector('[data-testid="agents-effective"]'), null, { timeout: 10000 }).catch(() => {});
  const statuses = (await watched(page)).map((item) => item.text);
  return { dirty, statuses, after: await agentsView(page), editor: await agentsEditor(page) };
}

/** @brief 走查 2 的前半：Customize 的 AGENTS.md 一节写"每次回答以'收到'开头"并保存；撤销、离开确认、放弃改动、Ctrl+S。 */
async function writeAgents(page, fx) {
  const save = commandOf(fx, 'agents.save');
  const [empty, saved] = resultsOf(fx, 'agents.get');
  await watch(page, '.agents-user');
  await openCustomize(page);
  await agentsReady(page);
  const loading = await watched(page);
  const landed = await toolsCurrent(page);
  record('agents-md：进入 Customize 落在"AGENTS.md"（2026-10-26 从设置页挪来），先"正在读取…"、编辑框不可用，读完后编辑框可用',
    landed === 'agents' && loading[0]?.text.includes('Loading…') && loading[0].disabled === true
    && loading.at(-1).disabled === false && !loading.at(-1).text.includes('Loading…'),
  JSON.stringify({ landed, loading }));
  const keys = await customizeNavKeys(page);
  record('agents-md：Customize 分节列表用 ↓ 换到"Skills"、↑ 回到"AGENTS.md"，当前分节高亮（aria-current）、焦点跟着走',
    keys.down.current === 'skills' && keys.down.focused === 'skills' && keys.up.current === 'agents'
    && keys.up.focused === 'agents', JSON.stringify(keys));
  await agentsReady(page);
  const before = await agentsView(page);
  record('agents-md：Customize 的 AGENTS.md：文件不存在时显示路径和"还没有这个文件，保存后创建"、说明只对之后新建的会话生效；'
    + '没有会话时项目级说明"打开一个会话后…"', before.user.includes(empty.userPath)
    && before.user.includes('This file doesn’t exist yet. Saving creates it.') && before.effective === null
    && before.user.includes('Changes apply to new sessions only; sessions already open don’t change.')
    && before.loaded?.includes('Open a session to see which files its project loads.'), JSON.stringify(before));
  await revertAgents(page, save.content);
  await page.getByTestId('agents-editor').fill(save.content);
  await leaveUnsaved(page);
  await discardAgents(page, save.content);
  const keyed = await saveAgentsByKey(page, save.content);
  record('agents-md：写好后"有未保存的改动"；在编辑框里按 Ctrl+S 保存：经过"保存中…"，然后"已保存 · 新建的会话才会读到"，'
    + '并标出"生效中：<agentDir>\\AGENTS.md"', keyed.dirty.status === 'Unsaved changes'
    && keyed.statuses.includes('Saving…') && keyed.statuses.at(-1) === 'Saved · Applies to new sessions'
    && keyed.after.effective === `In effect: ${saved.effectivePath}` && !keyed.editor.save,
  JSON.stringify({ statuses: keyed.statuses, after: keyed.after.effective }));
  const opened = await openInEditor(page, page.locator('.agents-line'));
  record('agents-md：生效的文件旁的"用系统编辑器打开"打开的是这个文件', opened === saved.effectivePath, opened);
  await shot(page, 'agents-md-saved');
}

/** @brief 走查 2：用户级 AGENTS.md 写"每次回答以'收到'开头"：新会话的第一条回复符合；设置页标出生效的文件。 */
async function agentsMd(page, h) {
  const fx = readFixture('agents-md');
  await h.load('agents-md');
  await writeAgents(page, fx);
  await newSessionVia(page, sideButton(page, 'Open folder…'));
  await say(page, promptsOf(fx)[0].text);
  const reply = (await replies(page)).at(-1);
  record('agents-md：新会话的第一条回复以"收到"开头', reply?.text.startsWith('收到') === true, reply?.text.slice(0, 60));
  await openCustomize(page);
  await page.getByTestId('agents-effective').waitFor({ timeout: 10000 });
  await page.getByTestId('agents-loaded').locator('h3', { hasText: 'Files loaded by ' }).waitFor({ timeout: 10000 });
  const view = { ...await agentsView(page), section: await toolsCurrent(page),
    value: await page.getByTestId('agents-editor').inputValue() };
  const latest = resultsOf(fx, 'agents.get').at(-1);
  const project = resultsOf(fx, 'session.create')[0].cwd.split('\\').pop();
  record('agents-md：有会话时进入 Customize（落在"AGENTS.md"）编辑框里是文件内容、仍标"生效中：<路径>"；项目级列出'
    + '"<项目名> 加载的文件"和"会话打开时读取…"，没有时"这个项目没有加载 AGENTS.md 或 CLAUDE.md"；反例：项目级没有编辑框',
  view.section === 'agents' && view.value === commandOf(fx, 'agents.save').content
    && view.effective === `In effect: ${latest.effectivePath}` && Array.isArray(latest.loaded)
    && view.loaded?.startsWith(`Files loaded by ${project}`)
    && view.loaded.includes('This project doesn’t load an AGENTS.md or CLAUDE.md')
    && view.loaded.includes('Read when the session opens. If you change a file later, only new sessions pick it up.')
    && view.editors === 1,
  JSON.stringify(view));
  await shot(page, 'agents-md');
  await toolsButton(page, 'Back to app').click();
  await page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 });
  await waitPaneReady(page, 'focused');
  await finish(page, 'agents-md', commandsOf(fx).length);
}

/** @brief 一行技能（或插件资源）的样子：来源、标签、开关、是否变淡、开关是否可用。 */
function rowState(row) {
  return row.evaluate((el) => {
    const power = el.querySelector('[role="switch"]');
    return { scope: el.dataset.scope ?? null,
      tags: [...el.querySelectorAll('.tools-tag')].map((tag) => tag.textContent),
      checked: power?.getAttribute('aria-checked') ?? null, off: el.classList.contains('off'),
      disabled: power?.disabled ?? null, text: el.textContent };
  }).catch(() => null);
}

/** @brief 点一行的开关，等命令和之后的重新读取结束（开关显示 want 且又可用）。 */
async function flipSwitch(page, rowSelector, want) {
  await page.locator(`${rowSelector} [role="switch"]`).first().click();
  await page.waitForFunction(({ css, on }) => {
    const power = document.querySelector(`${css} [role="switch"]`);
    return power && !power.disabled && power.getAttribute('aria-checked') === String(on);
  }, { css: rowSelector, on: want }, { timeout: 15000 }).catch(() => {});
}

/** @brief 工具页外框：侧栏"Customize"的高亮和位置、标题、"Back to app"、分节和当前分节。 */
function toolsFrame(page) {
  return page.evaluate(() => {
    const entry = document.querySelector('[data-testid="nav-tools"]');
    const tools = document.querySelector('[data-testid="tools-page"]');
    const buttons = [...(tools?.querySelectorAll('.topbar button') ?? [])];
    return { highlighted: entry?.classList.contains('active') ?? false,
      after: entry?.previousElementSibling?.getAttribute('aria-label') ?? null,
      title: tools?.querySelector('.topbar .chat-title')?.textContent ?? null,
      back: buttons.some((button) => button.textContent === 'Back to app'),
      sections: [...(tools?.querySelectorAll('[data-testid="tools-nav"] button') ?? [])].map((b) => b.textContent),
      current: tools?.querySelector('[data-testid="tools-nav"] button[aria-current="page"]')?.dataset.section ?? null };
  });
}

/** @brief 工具的来源文字（tools.md）：内置 / 扩展 <路径> / MCP · <服务> / 插件 <包>。 */
function sourceText(tool) {
  const labels = { builtin: 'Built-in', extension: `Extension ${tool.sourceLabel}`, mcp: `MCP · ${tool.sourceLabel}`,
    package: `Plugin ${tool.sourceLabel}` };
  return labels[tool.source] ?? tool.sourceLabel;
}

/** @brief "Built-in tools"一节：说明和每个工具一行（名字、启用、来源、状态、说明的第一行）。 */
function builtinRows(page) {
  return page.getByTestId('tools-page').evaluate((el) => ({
    lead: el.querySelector('.tools-lead')?.textContent ?? null,
    rows: [...el.querySelectorAll('[data-testid="tool-row"]')].map((row) => [row.dataset.tool, row.dataset.active,
      row.querySelector('.tools-tag')?.textContent, row.querySelector('.tools-state')?.textContent,
      row.querySelector('.tools-row-desc')?.textContent].join('|')) }));
}

/** @brief 在分节列表里按 ↑ 从"Skills"换到"Built-in tools"；与录制的 tools.get 对照每个工具一行；展开第一行看完整说明。 */
async function builtinSection(page, recorded) {
  await page.locator('[data-testid="tools-nav"] button[data-section="skills"]').focus();
  await page.keyboard.press('ArrowUp');
  const { current } = await toolsFrame(page);
  const view = await builtinRows(page);
  const tools = recorded.tools.filter((tool) => !tool.hidden);
  const expected = tools.map((tool) => [tool.name, String(tool.active), sourceText(tool),
    tool.active ? 'Enabled' : 'Not enabled', tool.description.split(/\r?\n/)[0]].join('|'));
  const row = page.locator(`[data-testid="tool-row"][data-tool="${tools[0].name}"]`);
  await row.locator('summary').click();
  const body = await row.locator('.tools-body').evaluate((el) => el.textContent).catch(() => null);
  record('project-skill：分节列表里按 ↑ 从"技能"换到"内置工具"：说明"当前会话注册的全部工具。启用的才会给模型。"；每个工具'
    + '一行（名字、来源"内置"、"启用"或"未启用"、说明的第一行），与录制的 tools.get 一致；展开看完整说明',
  current === 'builtin' && view.lead === 'All tools in this session. Only enabled tools are available to the model.'
    && view.rows.join('\n') === expected.join('\n') && view.rows.some((text) => text.includes('|Not enabled|'))
    && body === tools[0].description, JSON.stringify({ current, lead: view.lead, rows: view.rows.length,
    differ: view.rows.find((text, index) => text !== expected[index]) ?? null }));
}

/** @brief 点技能展开、"Open in default app"、再点收起；返回展开时的路径和正文、打开的路径、是否收起。 */
async function expandSkill(page, css) {
  await page.locator(`${css} .tools-row-main`).click();
  const detail = await page.locator(`${css} .tools-detail`).evaluate((el) => ({
    path: el.querySelector('.tools-path .tools-mono')?.textContent,
    body: el.querySelector('.tools-body')?.textContent })).catch(() => null);
  const opened = await openInEditor(page, page.locator(`${css} .tools-detail`));
  await page.locator(`${css} .tools-row-main`).click();
  const collapsed = await page.locator(`${css} .tools-detail`).count() === 0;
  return { ...detail, opened, collapsed };
}

/** @brief 走查 3 的工具页部分：项目技能标"Project"；关掉开关后变淡；顶部说明对新建的会话生效。 */
async function disableProjectSkill(page, fx) {
  const toggle = commandOf(fx, 'resource.toggle');
  const css = '[data-testid="skill-row"][data-name="m6-proj-skill"]';
  await watch(page, '[data-testid="tools-page"] .tools-inner');
  await openToolsSection(page, 'skills');
  const loading = (await watched(page)).map((item) => item.text);
  const frame = await toolsFrame(page);
  record('project-skill：侧栏"工具"在"打开文件夹…"下面，工具页打开时高亮、落在"AGENTS.md"、先"正在读取…"；顶部"返回会话"、'
    + '标题"工具"；有会话时分节是 AGENTS.md、内置工具、技能、MCP、插件', frame.highlighted && frame.after === 'Open folder…'
    && frame.title === 'Customize' && frame.back
    && frame.sections.join() === 'AGENTS.md,Built-in tools,Skills,MCP,Plugins' && frame.current === 'skills'
    && loading[0]?.startsWith('AGENTS.md') && loading[0].includes('Loading…') && !loading.at(-1).includes('Loading…'),
  JSON.stringify({ frame, loading }));
  const before = await rowState(page.locator(css));
  const head = await page.getByTestId('tools-page').locator('.topbar, .tools-notice').allInnerTexts();
  const detail = await expandSkill(page, css);
  record('project-skill：点技能展开：SKILL.md 的路径和去掉 frontmatter 的正文；"用系统编辑器打开"打开这个文件；再点收起',
    detail.path === toggle.path && detail.body === '# m6-proj-skill\n\nReply with M6-PROJECT-SKILL-OK.'
    && detail.opened === toggle.path && detail.collapsed, JSON.stringify(detail));
  await flipSwitch(page, css, false);
  const after = await rowState(page.locator(css));
  record('project-skill：信任的项目里 .pi/skills 的技能出现在工具页"技能"里，标"本项目"、开关打开；顶部跟随"<项目名> · <会话名>"，'
    + '说明"启停和添加对新建的会话生效，已经打开的会话不变。"', before?.scope === 'project' && before.tags.includes('Project')
    && before.checked === 'true' && !before.off && head.join('|').includes('m6-project-skill · ')
    && head.join('|').includes('Changes apply to new sessions. Sessions already open aren’t affected.')
    && !head.join('|').includes('This workspace isn’t trusted'), JSON.stringify({ before, head }));
  record('project-skill：关掉开关（resource.toggle 写项目的设置，与录制一致）后这一行变淡、开关关上',
    toggle.enabled === false && after?.checked === 'false' && after.off, JSON.stringify(after));
  await shot(page, 'project-skill-disabled');
  await builtinSection(page, resultsOf(fx, 'tools.get').at(-1));
}

/** @brief 新会话里打"/"：列表里没有停用的技能（录制里这个会话没有任何模板和技能）；Esc 关掉。 */
async function slashWithout(page) {
  await composerAt(page, 'focused').click();
  await page.keyboard.type('/');
  await page.getByTestId('slash-menu').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="slash-menu"]')?.textContent
    .includes('Loading…'), null, { timeout: 10000 }).catch(() => {});
  const text = await page.getByTestId('slash-menu').innerText();
  await page.keyboard.press('Escape');
  const closed = await page.getByTestId('slash-menu').count() === 0;
  return { text, closed, items: await slashItems(page) };
}

/** @brief 走查 3：项目技能出现并标"Project"；停用后新会话问"你能用哪些技能"时没有它，"/"补全里也没有。 */
async function projectSkill(page, h) {
  const fx = readFixture('project-skill');
  await h.load('project-skill');
  const [question] = promptsOf(fx);
  const remembered = await newSessionVia(page, sideButton(page, 'Open folder…'), true);
  await say(page, question.text);
  const first = (await replies(page)).at(-1);
  record('project-skill：带 .pi 的文件夹先问信任（"记住"默认不勾），选"信任"；模型能说出项目技能 m6-proj-skill',
    remembered === false && first?.text.includes('m6-proj-skill') === true, JSON.stringify({ remembered, first }));
  await disableProjectSkill(page, fx);
  // 本次运行里回答过这个文件夹，不再问（M3 起），沿用"Trust workspace"；录制里第二次 session.create 带的也是这个回答。
  await newSessionVia(page, toolsButton(page, 'New session'));
  const asked = await page.getByTestId('trust-dialog').count();
  const slash = await slashWithout(page);
  record('project-skill：工具页"新建会话"在同一项目里新建（本次运行里答过信任，不再问）；它的"/"补全里没有停用的 m6-proj-skill'
    + '（"这个会话没有提示词模板或技能（在工具页添加）"），Esc 关闭', asked === 0
    && slash.text === 'This session has no prompt templates or skills. Add them in Customize.' && slash.closed,
  JSON.stringify({ asked, slash }));
  await say(page, question.text);
  const second = (await replies(page)).at(-1);
  record('project-skill：停用后新会话问"你能用哪些技能"时回答里没有 m6-proj-skill', Boolean(second?.text)
    && !second.text.includes('m6-proj-skill'), second?.text.slice(0, 80));
  await shot(page, 'project-skill');
  await finish(page, 'project-skill', commandsOf(fx).length);
}

/** @brief 填 MCP 表单的逐项写法：命令、参数每行一个、环境变量每行 名字=值。 */
async function fillMcpFields(form, entry) {
  await form.getByLabel('Command', { exact: true }).fill(entry.command);
  await form.getByLabel('Arguments', { exact: true }).fill((entry.args ?? []).join('\n'));
  const env = Object.entries(entry.env ?? {}).map(([key, value]) => `${key}=${value}`);
  await form.getByLabel('Environment variables', { exact: true }).fill(env.join('\n'));
}

/**
 * @brief MCP 表单里标题为 name 的输入框。不用 getByLabel：React 把 textarea 一开始的值写成它的文字，有值时 label 的文字
 *        就成了"ArgumentsC:\…"，按名字精确匹配找不到。
 */
const mcpInput = (form, name) => form.locator('label')
  .filter({ has: form.page().getByText(name, { exact: true }) }).locator('input, textarea');

/** @brief MCP 表单逐项写法的内容：写法、名称、命令、参数、环境变量。 */
async function mcpFields(form) {
  return { mode: await form.getAttribute('data-mode'), name: await mcpInput(form, 'Name').inputValue(),
    command: await mcpInput(form, 'Command').inputValue(), args: await mcpInput(form, 'Arguments').inputValue(),
    env: await mcpInput(form, 'Environment variables').inputValue() };
}

/** @brief 点"Save"，看表单里"Couldn’t save: "那一行（界面先检查出的问题）；表单是否还开着、多发了几条命令。 */
async function saveProblem(page, h, form) {
  const sent = await h.sent();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const text = await form.locator('.form-message.error').innerText({ timeout: 5000 }).catch(() => null);
  return { text, open: await form.count() === 1, sent: await h.sent() - sent };
}

/**
 * @brief "Edit as JSON"：先写不能解析的 JSON 保存（看原文、表单保留你写的），再写条目，"Back to form"看逐项的内容，
 *        再换回 JSON 看条目。
 */
async function fillMcpJson(page, h, form, entry) {
  const json = page.getByTestId('mcp-json');
  await form.getByRole('button', { name: 'Edit as JSON', exact: true }).click();
  const seen = { mode: await form.getAttribute('data-mode'), json: await json.inputValue() };
  await json.fill('{');
  seen.bad = { ...await saveProblem(page, h, form), kept: await json.inputValue() };
  await json.fill(JSON.stringify(entry, null, 2));
  await form.getByRole('button', { name: 'Back to form', exact: true }).click();
  seen.fields = await mcpFields(form);
  await form.getByRole('button', { name: 'Edit as JSON', exact: true }).click();
  seen.back = JSON.parse(await json.inputValue());
  return seen;
}

/**
 * @brief 在工具页"MCP"一节点"Add"，照录制的条目填表单并保存；first 为真时先不填名称点保存，json 为真时用"Edit as JSON"。
 * @return 表单的说明、没填名称时的提示、以 JSON 编辑时的各一步
 */
async function addMcpServer(page, h, save, { first, json }) {
  await toolsButton(page, 'Add').click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  const seen = { hint: await form.locator('.field-hint').innerText() };
  if (first) seen.unnamed = await saveProblem(page, h, form);
  await form.getByLabel('Name', { exact: true }).fill(save.name);
  if (json) Object.assign(seen, await fillMcpJson(page, h, form, save.entry));
  else await fillMcpFields(form, save.entry);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 10000 });
  return seen;
}

/** @brief 没有打开的会话时的工具页：顶部说明只列出 AGENTS.md、技能和插件，分节里没有"Built-in tools""MCP"。 */
async function toolsWithoutSession(page) {
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  const view = { follow: await page.getByTestId('tools-follow').innerText(),
    sections: await page.locator('[data-testid="tools-nav"] button[data-section]').evaluateAll((items) => items
      .map((item) => item.dataset.section)) };
  record('mcp：没有打开的会话时工具页说明"没有打开的会话：只列出 AGENTS.md、技能和插件（用户级）"，分节只有 AGENTS.md、技能、插件'
    + '（没有内置工具和 MCP）', view.follow === 'No open session. Only AGENTS.md and user-level skills and plugins are listed.'
    && view.sections.join() === 'agents,skills,plugins',
    JSON.stringify(view));
  await toolsButton(page, 'Back to app').click();
}

/**
 * @brief 工具页"MCP"一节每个服务的样子：名字、命令行、工具名、错误行、标签、开关、按钮、完整通知（错误行下面的；
 *        进程状态失败时下面的"Full error"也是 .tools-full-notice，不算在里面）、有没有进程状态那一行、整行文字。
 */
function mcpRows(page) {
  return page.locator('[data-testid="mcp-row"]').evaluateAll((rows) => rows.map((row) => {
    const power = row.querySelector('[role="switch"]');
    return { name: row.dataset.server, line: row.querySelector('.tools-mono')?.textContent ?? null,
      tools: row.querySelector('[data-testid="mcp-tools"]')?.textContent ?? null,
      errors: [...row.querySelectorAll('[data-testid="mcp-error"] > p')].map((line) => line.textContent),
      tags: [...row.querySelectorAll('.tools-tag')].map((tag) => tag.textContent),
      power: `${power?.getAttribute('aria-checked')}:${power?.disabled ? 'locked' : 'usable'}`,
      actions: [...row.querySelectorAll('.tools-row-actions button')].map((b) => `${b.textContent}:${!b.disabled}`),
      full: row.querySelector('[data-testid="mcp-error"] .tools-full-notice summary')?.textContent ?? null,
      process: Boolean(row.querySelector('[data-testid="mcp-process"]')), text: row.textContent };
  }));
}

/** @brief 走查 4、5 的工具页部分：在（补上的）会话里用表单添加三个服务，再从"Saved"那一行"New session"。 */
async function addMcpServers(page, h, fx) {
  await newSessionVia(page, sideButton(page, 'Open folder…'));
  await openToolsSection(page, 'mcp');
  const empty = await page.getByTestId('tools-page').locator('.tools-empty').innerText().catch(() => '');
  const saves = commandsOf(fx).filter((c) => c.type === 'mcp.save');
  const seen = [];
  // 前两个用表单逐项填写，最后一个（带环境变量）用"Edit as JSON"
  for (const [index, save] of saves.entries()) {
    seen.push(await addMcpServer(page, h, save, { first: index === 0, json: index === saves.length - 1 }));
  }
  const saved = page.getByTestId('tools-page').locator('.form-message.ok');
  const notice = await saved.innerText().catch(() => '');
  record('mcp：工具页"MCP"一节没有服务时"还没有 MCP 服务"；表单说明"Mori 添加的服务都用直接调用方式（exposure: direct）"；'
    + '保存后"已保存 · 新建的会话才会连接它"和"新建会话"', empty === 'No MCP servers yet' && seen.length === 3
    && seen.every((item) => item.hint === 'Servers you add here always use direct calls (exposure: direct)')
    && notice === 'Saved · Only new sessions will connect to itNew session', JSON.stringify({ empty, notice }));
  record('mcp：没填名称就保存：表单里"保存失败：名称不能为空"，表单保留、不发命令', seen[0].unnamed?.text
    === 'Couldn’t save: Name is required.' && seen[0].unnamed.open && seen[0].unnamed.sent === 0,
  JSON.stringify(seen[0].unnamed));
  const last = seen[2];
  const entry = saves[2].entry;
  record('mcp："以 JSON 编辑"换成条目的 JSON；写了不能解析的 JSON 保存时"保存失败："加原文，表单保留你写的、不发命令；'
    + '"回到表单"逐项列出命令、参数、环境变量，再换回 JSON 是同一个条目', last.mode === 'json'
    && JSON.parse(last.json).exposure === 'direct' && last.bad.text?.startsWith('Couldn’t save: ')
    && last.bad.text.length > 'Couldn’t save: '.length && last.bad.open && last.bad.kept === '{' && last.bad.sent === 0
    && last.fields.mode === 'fields' && last.fields.name === saves[2].name && last.fields.command === entry.command
    && last.fields.args === entry.args.join('\n') && last.fields.env === 'MORI_MCP_TOOLS=none'
    && last.back.command === entry.command && last.back.args.join() === entry.args.join()
    && last.back.env?.MORI_MCP_TOOLS === 'none' && last.back.exposure === 'direct', JSON.stringify(last));
  await newSessionVia(page, saved.getByRole('button', { name: 'New session' }));
}

/** @brief 新会话的工具页"MCP"：mori-test 的工具名、mori-empty 没有工具、mori-broken 的错误原文，没有"Connected"。 */
async function checkMcpServers(page, h, fx) {
  await openToolsSection(page, 'mcp');
  await page.locator('[data-testid="mcp-row"][data-server="mori-broken"] [data-testid="mcp-error"]')
    .waitFor({ timeout: 10000 }).catch(() => {});
  const rows = await mcpRows(page);
  const row = (name) => rows.find((item) => item.name === name);
  const page_ = await page.getByTestId('tools-page').innerText();
  const servers = resultsOf(fx, 'tools.get').at(-1).mcp.servers;
  record('mcp：每个服务一行：名字、"用户级""直接调用"、命令行（命令加参数）、开关打开可用、"编辑""以 JSON 编辑""移除"可用；'
    + '顺序与 mcp.json 相同', rows.map((item) => item.name).join() === servers.map((item) => item.name).join()
    && servers.every((server) => row(server.name)?.line === [server.command, ...server.args].join(' ')
      && row(server.name).tags.join() === 'User,Direct' && row(server.name).power === 'true:usable'
      && row(server.name).actions.join() === 'Edit:true,Edit as JSON:true,Remove…:true'),
  JSON.stringify(rows.map(({ text: _t, ...rest }) => rest)));
  record('mcp：新会话的工具页列出 mori-test 注册的工具名"当前会话里注册的工具：mcp__mori_test__echo、mcp__mori_test__add"',
    row('mori-test')?.tools === 'Tools in this session: mcp__mori_test__echo, mcp__mori_test__add',
    JSON.stringify(row('mori-test')));
  record('mcp：录制里的 tools.get 没有 shared 字段（录制早于共享服务表，界面按没有共享连接处理）：'
    + '每一行都没有进程状态那一行（mcp-process），不凭工具列表推断连接状态', servers.length === rows.length
    && servers.every((server) => !Object.hasOwn(server, 'shared')) && rows.every((item) => !item.process),
  JSON.stringify(rows.map((item) => [item.name, item.process])));
  await fullNotice(page, row('mori-broken'), fx);
  record('mcp：反例：没有注册任何工具的 mori-empty 显示"当前会话里它没有注册工具"，整页不出现"已连接"',
    row('mori-empty')?.tools === 'This server has no tools in this session' && !page_.includes('Connected'),
    JSON.stringify({ empty: row('mori-empty'), connected: page_.includes('Connected') }));
  await shot(page, 'mcp-tools');
  await mcpFormsCancel(page, h, servers.find((server) => server.name === 'mori-empty'));
  await mcpToolsElsewhere(page);
}

/** @brief mori-broken 下面是 pi 通知里的原文那一行；"Full notice"展开后是整条通知。 */
async function fullNotice(page, broken, fx) {
  const notify = fx.steps.find((step) => step.envelope?.event.type === 'mori.notify').envelope.event.message;
  const details = page.locator('[data-testid="mcp-row"][data-server="mori-broken"] [data-testid="mcp-error"]'
    + ' .tools-full-notice');
  await details.locator('summary').click().catch(() => {});
  const full = await details.evaluate((el) => ({ open: el.open, text: el.querySelector('pre')?.textContent }))
    .catch(() => null);
  record('mcp：命令写错的 mori-broken 下面是 pi 通知里的原文"mori-broken: failed: MCP connection closed"；'
    + '"完整通知"展开后是整条通知', broken?.errors.join('|') === 'mori-broken: failed: MCP connection closed'
    && broken.full === 'Full notice' && full?.open === true && full.text === notify, JSON.stringify({ broken, full }));
}

/** @brief 用户级服务的"Edit"：表单填好原来的内容，Esc 等于取消；"Remove…"先确认，取消后还在；都不发命令。 */
async function mcpFormsCancel(page, h, server) {
  const sent = await h.sent();
  const css = `[data-testid="mcp-row"][data-server="${server.name}"]`;
  await page.locator(css).getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  const edit = { ...await mcpFields(form), locked: await page.locator(`${css} [role="switch"]`).isDisabled() };
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  edit.closed = await form.count() === 0;
  await page.locator(css).getByRole('button', { name: 'Remove…', exact: true }).click();
  const remove = await cancelDialog(page, 'remove-dialog');
  const kept = await page.locator(css).count();
  const unsent = await h.sent() - sent;
  record(`mcp：点 ${server.name} 的"编辑"：表单填好名称、命令、参数、环境变量（编辑时这一行的开关不可用），Esc 等于取消；`
    + `"移除"先问"移除 MCP 服务 ${server.name}？"、"已经打开的会话不受影响。"，取消后还在；都不发命令`,
  edit.mode === 'fields' && edit.name === server.name && edit.command === server.command
    && edit.args === server.args.join('\n') && edit.env === 'MORI_MCP_TOOLS=none' && edit.locked && edit.closed
    && remove.title === `Remove MCP server “${server.name}”?`
    && remove.text === 'Sessions already open aren’t affected.'
    && remove.focused === 'Cancel' && remove.closed && kept === 1 && unsent === 0,
  JSON.stringify({ edit, remove, kept, unsent }));
}

/** @brief 工具页"Built-in tools"里列出 MCP 工具；"Skills""Plugins"在录制里为空时的说明。 */
async function mcpToolsElsewhere(page) {
  await openToolsSection(page, 'builtin');
  const tools = await page.locator('[data-testid="tool-row"][data-tool^="mcp__"]').evaluateAll((items) => items
    .map((item) => `${item.dataset.tool}|${item.querySelector('.tools-tag')?.textContent}|${item.dataset.active}`));
  record('mcp：工具页"内置工具"里列出 MCP 工具，来源"MCP · mori-test"、启用', tools.join()
    === 'mcp__mori_test__echo|MCP · mori-test|true,mcp__mori_test__add|MCP · mori-test|true', JSON.stringify(tools));
  await openToolsSection(page, 'skills');
  const skills = await page.getByTestId('tools-page').locator('.tools-empty').innerText().catch(() => '');
  await openToolsSection(page, 'plugins');
  const plugins = await page.getByTestId('tools-page').locator('.tools-empty').innerText().catch(() => '');
  const noSkills = new RegExp(/^No skills yet\. Put a skill folder \(with a SKILL\.md\) in .+/.source
    + /\\skills or in the project’s \.pi\\skills, or add a plugin\.$/.source);
  record('mcp：录制里没有技能和插件：技能一节"还没有技能。把技能文件夹（含 SKILL.md）放进 …\\skills 或项目的 .pi\\skills，'
    + '或添加一个插件。"，插件一节"还没有插件"', noSkills.test(skills) && plugins === 'No plugins yet',
  JSON.stringify({ skills, plugins }));
  await toolsButton(page, 'Back to app').click();
}

/** @brief 走查 4、5 和反例：表单添加 stdio MCP 服务，看到工具名；调用它的工具出批准卡；命令写错时看到 pi 的原文。 */
async function mcp(page, h) {
  const fx = readFixture('mcp');
  await h.load('synthetic-mcp-setup');
  await toolsWithoutSession(page);
  await addMcpServers(page, h, fx);
  // pi 的通知在会话打开后（录制里约 0.3 秒后）才到
  await page.locator(`${FOCUSED} [data-testid="ext-notify"]`).first().waitFor({ timeout: 10000 }).catch(() => {});
  const notify = await page.locator(`${FOCUSED} [data-testid="ext-notify"]`).allInnerTexts();
  record('mcp：新会话的对话流里显示 pi 的 MCP 通知原文（"扩展：MCP servers need attention: … mori-broken: failed: …"）',
    notify.some((text) => text.startsWith('Extension: MCP servers need attention:')
      && text.includes('mori-broken: failed')),
    JSON.stringify(notify));
  const draft = '先写一半，看完工具页再发';
  await composerAt(page, 'focused').fill(draft);
  await checkMcpServers(page, h, fx);
  const kept = await composerAt(page, 'focused').inputValue();
  record('mcp：工具页的"返回会话"回到原来的会话，输入框里没发出的草稿还在', kept === draft, kept);
  await sendAt(page, 'focused', promptsOf(fx)[0].text);
  const card = await answerCard(page, 'approval-allow');
  await waitPaneIdle(page, 'focused');
  const tool = await lastToolCard(page);
  const reply = (await replies(page)).at(-1);
  record('mcp：调用 mcp__mori_test__echo 出批准卡，标题"mori_test · echo"；允许后工具卡完成，回复说出返回的 hello-mori',
    card.tool === 'mcp__mori_test__echo' && card.title === 'mori_test · echo' && tool?.status === 'done'
    && reply?.text.includes('hello-mori') === true, JSON.stringify({ card, tool, reply: reply?.text.slice(0, 80) }));
  await shot(page, 'mcp');
  await finish(page, 'mcp', commandsOf(fx).length + 1);
}

/** @brief 一张插件卡的样子：来源、用户级 / 本项目、文件夹、分组、资源（种类、名字、开关、变淡、标签）、整包按钮的文字。 */
function packageState(card) {
  return card.evaluate((el) => ({ source: el.dataset.source,
    scope: el.querySelector('.tools-card-head .tools-tag')?.textContent ?? null,
    root: el.querySelector(':scope > .tools-mono')?.textContent ?? null,
    groups: [...el.querySelectorAll('.tools-group h3')].map((head) => head.textContent),
    whole: el.querySelector('.tools-card-head .tools-row-actions button')?.textContent ?? null,
    resources: [...el.querySelectorAll('[data-testid="package-resource"]')].map((row) => ({ kind: row.dataset.kind,
      name: row.querySelector('.tools-row-name')?.textContent,
      on: row.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true',
      off: row.classList.contains('off'),
      tags: [...row.querySelectorAll('.tools-tag')].map((tag) => tag.textContent).join() })) }));
}

/** @brief 点整包按钮（"Disable all" / "Enable all"），等它换成另一个（命令和重新读取都结束）。 */
async function wholePackage(page, card, label, next) {
  await card.getByRole('button', { name: label, exact: true }).click();
  await card.getByRole('button', { name: next, exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="package-card"] [role="switch"]')]
    .every((power) => !power.disabled), null, { timeout: 15000 }).catch(() => {});
  return packageState(card);
}

/** @brief 走查 6 的前半："Plugins"一节没有包时的样子；点"Add plugin from folder…"（系统对话框选文件夹），出现包卡。 */
async function addPackage(page, fx) {
  const add = commandOf(fx, 'package.add');
  await openToolsSection(page, 'plugins');
  const empty = { text: await page.getByTestId('tools-page').locator('.tools-empty').innerText().catch(() => ''),
    note: await page.locator('.tools-add .tools-row-note').innerText().catch(() => '') };
  await toolsButton(page, 'Add plugin from folder…').click();
  const card = page.getByTestId('package-card').first();
  await card.waitFor({ timeout: 10000 });
  const listed = await packageState(card);
  const recorded = resultsOf(fx, 'tools.get').find((info) => info.packages.length > 0).packages[0];
  record('plugin：没有包时"还没有插件"；"添加本地包…"旁说明"内网只支持本地文件夹的包，包要自带依赖"',
    empty.text === 'No plugins yet'
    && empty.note === 'Plugins must be local folders that include their dependencies. Nothing is downloaded.',
  JSON.stringify(empty));
  record('plugin：工具页"插件"里点"添加本地包…"（系统对话框选文件夹）：出现包卡，来源和解析后的文件夹、"用户级"；资源按扩展、技能、'
    + '提示词、主题分组，名字与录制的一致，每个一个开关，主题标"Mori 不使用"', listed.source === recorded.source
    && listed.root === add.path && listed.scope === 'User'
    && listed.groups.join() === 'Extensions,Skills,Prompt templates,Themes'
    && listed.resources.map((item) => `${item.kind}:${item.name}`).join()
      === recorded.resources.map((item) => `${item.kind}:${item.name}`).join()
    && listed.resources.every((item) => item.on && !item.off)
    && listed.resources.map((item) => item.tags).join('|') === '|||Not used by Mori', JSON.stringify(listed));
  return card;
}

/** @brief 插件里的技能也列在"Skills"一节：来源"Plugin <包>"，开关跟着包里的那一个。 */
async function packageSkillRow(page, name) {
  await openToolsSection(page, 'skills');
  const row = await rowState(page.locator(`[data-testid="skill-row"][data-name="${name}"]`));
  await openToolsSection(page, 'plugins');
  return row;
}

/** @brief 包卡的"Remove…"：先问"Remove plugin “<来源>”?"、文件夹不删；取消后卡还在、不发命令。 */
async function cancelPackageRemove(page, h, card, source) {
  const sent = await h.sent();
  await card.getByRole('button', { name: 'Remove…', exact: true }).click();
  const remove = await cancelDialog(page, 'remove-dialog');
  const kept = await page.getByTestId('package-card').count();
  record(`plugin：包卡的"移除"先问"移除插件 ${source}？"、"只从设置里去掉它，文件夹不删。已经打开的会话不受影响。"，焦点在"取消"；`
    + '取消后卡还在、不发命令', remove.title === `Remove plugin “${source}”?`
    && remove.text === 'This only removes it from your settings. The folder isn’t deleted. Sessions already open '
      + 'aren’t affected.' && remove.focused === 'Cancel' && remove.closed
    && kept === 1 && await h.sent() - sent === 0, JSON.stringify({ remove, kept }));
}

/** @brief 走查 6 的工具页部分：添加本地包，列出资源；停用包里的技能；停用整个包、再启用整个包。 */
async function managePackage(page, h, fx) {
  const toggle = commandOf(fx, 'resource.toggle');
  const card = await addPackage(page, fx);
  await flipSwitch(page, `[data-testid="package-resource"][data-path=${JSON.stringify(toggle.path)}]`, false);
  const one = await packageState(card);
  const skill = await packageSkillRow(page, 'package-review');
  const off = await wholePackage(page, card, 'Disable all', 'Enable all');
  const on = await wholePackage(page, card, 'Enable all', 'Disable all');
  const states = (state) => state.resources.map((item) => `${item.kind}:${item.on}${item.off ? '(淡)' : ''}`).join();
  record('plugin：按资源启停：关掉包里的技能只关这一个、那一行变淡；"停用整个包"后全部关上、按钮变"启用整个包"；再点全部打开',
    states(one) === 'extensions:true,skills:false(淡),prompts:true,themes:true'
    && off.resources.every((item) => !item.on && item.off) && off.whole === 'Enable all'
    && on.resources.every((item) => item.on && !item.off) && on.whole === 'Disable all',
    JSON.stringify({ one: states(one), off: states(off), on: states(on) }));
  record('plugin：包里的技能也列在"技能"一节，来源"插件 <包>"；在包卡里关掉后这里也是关上、变淡',
    skill?.scope === 'package' && skill.tags.join() === `Plugin ${one.source}` && skill.checked === 'false'
    && skill.off,
    JSON.stringify(skill));
  await cancelPackageRemove(page, h, card, on.source);
  await shot(page, 'plugin-card');
}

/**
 * @brief 工具页开着时点侧栏里另一个已经打开的会话：回到会话页、显示它（不发命令）；再点回刚建的会话。
 * @param files 两个会话的会话文件（先建的、后建的）
 */
async function sidebarLeavesTools(page, h, [first, second]) {
  const sent = await h.sent();
  const row = (file) => page.locator(`[data-testid="sidebar"] [role="treeitem"][data-file=${JSON.stringify(file)}]`);
  const selected = (file) => row(file).getAttribute('aria-selected');
  await row(first).click();
  await page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  const away = { tools: await page.getByTestId('tools-page').count(), selected: await selected(first),
    pane: await page.locator(`${FOCUSED} [data-testid="chat-pane"]`).count() };
  await row(second).click();
  await waitPaneReady(page, 'focused');
  return { ...away, back: await selected(second), sent: await h.sent() - sent };
}

/** @brief 走查 6 和反例：添加本地文件夹的 pi 包，按资源启停；新会话里包的扩展注册的工具出批准卡。 */
async function plugin(page, h) {
  const fx = readFixture('plugin');
  await h.load('plugin');
  await newSessionVia(page, sideButton(page, 'Open folder…'));
  await managePackage(page, h, fx);
  await newSessionVia(page, toolsButton(page, 'New session'));
  await openToolsSection(page, 'builtin');
  const tool = await page.locator('[data-testid="tool-row"][data-tool="package_hello"]').evaluate((row) => ({
    active: row.dataset.active, tags: row.querySelector('.tools-tag')?.textContent })).catch(() => null);
  record('plugin：新会话的工具页"内置工具"里有包的扩展注册的 package_hello，来源"插件 <包>"、启用',
    tool?.active === 'true' && tool.tags === `Plugin ${commandOf(fx, 'package.setAll').source}`, JSON.stringify(tool));
  const away = await sidebarLeavesTools(page, h, resultsOf(fx, 'session.create').map((info) => info.sessionFile));
  record('plugin：工具页开着时点侧栏里另一个会话：回到会话页、那个会话高亮，不发命令；再点回刚建的会话',
    away.tools === 0 && away.selected === 'true' && away.pane === 1 && away.back === 'true' && away.sent === 0,
    JSON.stringify(away));
  await sendAt(page, 'focused', promptsOf(fx)[0].text);
  const card = await answerCard(page, 'approval-allow');
  await waitPaneIdle(page, 'focused');
  const done = await lastToolCard(page);
  const reply = (await replies(page)).at(-1);
  record('plugin：反例：调用插件扩展注册的 package_hello 出批准卡；允许后工具卡完成，回复说出"hello from package"',
    card.tool === 'package_hello' && done?.status === 'done' && reply?.text.includes('hello from package') === true,
    JSON.stringify({ card, done, reply: reply?.text.slice(0, 80) }));
  await shot(page, 'plugin');
  await finish(page, 'plugin', commandsOf(fx).length);
}

/** @brief 在输入框里打 text，等"/"补全列表读完；返回列表的项和文字。 */
async function typeSlash(page, text) {
  await page.keyboard.type(text);
  await page.getByTestId('slash-menu').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="slash-menu"]')?.textContent
    .includes('Loading…'), null, { timeout: 10000 }).catch(() => {});
  return { items: await slashItems(page), text: await page.getByTestId('slash-menu').innerText() };
}

/** @brief 清空当前一栏的草稿（像人一样全选后删除）。 */
async function clearDraft(page) {
  await composerAt(page, 'focused').press('Control+a');
  await page.keyboard.press('Backspace');
}

/** @brief 当前一栏输入框的文字和光标位置。 */
const draftOf = (page) => composerAt(page, 'focused').evaluate((input) => ({ value: input.value,
  caret: input.selectionStart, end: input.selectionStart === input.value.length }));

/** @brief 列表开着时：↑ ↓ 移动（首尾循环）；打出不匹配的字时"No matching prompt templates or skills"；删掉后列表回来。 */
async function slashKeys(page) {
  const selected = async () => (await slashItems(page))?.find((item) => item.selected)?.name ?? null;
  await page.keyboard.press('ArrowUp');
  const up = await selected();
  await page.keyboard.press('ArrowDown');
  const down = await selected();
  await page.keyboard.type('zzz');
  const none = await page.getByTestId('slash-menu').innerText().catch(() => null);
  for (let count = 0; count < 3; count += 1) await page.keyboard.press('Backspace');
  const back = (await slashItems(page))?.length ?? 0;
  record('slash：↑ 从第一项循环到最后一项、↓ 回到第一项；打出不匹配的字时"没有匹配的提示词模板或技能"，删掉后列表回来',
    up === 'skill:m6-hello' && down === 'm6-summary' && none === 'No matching prompt templates or skills' && back === 2,
    JSON.stringify({ up, down, none, back }));
}

/** @brief 筛选不分大小写、名字里包含筛选词的也列出；鼠标移过一项时它高亮。 */
async function slashFilterAndHover(page) {
  const names = async () => (await slashItems(page))?.map((item) => item.name).join() ?? null;
  await page.keyboard.type('M6');
  const upper = await names();
  for (let count = 0; count < 2; count += 1) await page.keyboard.press('Backspace');
  await page.keyboard.type('HELLO');
  const inside = await names();
  for (let count = 0; count < 5; count += 1) await page.keyboard.press('Backspace');
  await page.getByTestId('slash-menu').locator('[role="option"]').nth(1).hover();
  const hovered = (await slashItems(page))?.find((item) => item.selected)?.name ?? null;
  record('slash：筛选不分大小写（"/M6"两项都在），名字里包含筛选词的也列出（"/HELLO"只剩 /skill:m6-hello）；鼠标移过一项时它高亮',
    upper === 'm6-summary,skill:m6-hello' && inside === 'skill:m6-hello' && hovered === 'skill:m6-hello',
    JSON.stringify({ upper, inside, hovered }));
}

/**
 * @brief synthetic：浏览器不能在测试里真的打开输入法，这里在输入框上派发组字开始、组字中的 Enter（isComposing）、组字结束
 *        三个事件；列表照常显示，Enter 不插入也不发送。
 */
async function imeEnter(page, h) {
  const before = { draft: (await draftOf(page)).value, sent: await h.sent() };
  await composerAt(page, 'focused').evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true,
      cancelable: true }));
  });
  const during = { menu: await page.getByTestId('slash-menu').count(), draft: (await draftOf(page)).value,
    sent: await h.sent() - before.sent };
  await composerAt(page, 'focused').evaluate((input) => input.dispatchEvent(new CompositionEvent('compositionend',
    { bubbles: true, data: '' })));
  record('slash：输入法组字中（synthetic 事件）按 Enter 只是选词：列表照常显示，不插入、不发送',
    during.menu === 1 && during.draft === before.draft && during.sent === 0, JSON.stringify({ before, during }));
}

/** @brief 走查 7 的技能命令：打"/"看列表，筛到技能，Enter 插入（不发送），再 Enter 发出；气泡"Skill · m6-hello"。 */
async function slashSkill(page, h) {
  await composerAt(page, 'focused').click();
  await page.keyboard.type('看 /');
  const plain = await page.getByTestId('slash-menu').count();
  await clearDraft(page);
  await watch(page, '[data-testid="slash-menu"]');
  const all = await typeSlash(page, '/');
  const loading = (await watched(page)).map((item) => item.text);
  record('slash：草稿不以"/"开头时没有列表；打"/"先"正在读取…"，再列出提示词模板 /m6-summary（带 <file> 和说明）和技能命令'
    + ' /skill:m6-hello，分两组，第一项高亮', plain === 0 && loading[0] === 'Loading…'
    && all.items?.map((item) => `${item.kind}:${item.name}`).join() === 'prompt:m6-summary,skill:skill:m6-hello'
    && all.items[0].selected && all.text.includes('Prompt templates') && all.text.includes('Skills')
    && all.text.includes('<file>')
    && all.text.includes('用一句话总结一个文件'), JSON.stringify({ plain, loading, all }));
  await slashKeys(page);
  await slashFilterAndHover(page);
  const filtered = await typeSlash(page, 'skill');
  await imeEnter(page, h);
  const sent = await h.sent();
  await page.keyboard.press('Enter');
  const inserted = { ...await draftOf(page), menu: await page.getByTestId('slash-menu').count(),
    sent: await h.sent() - sent };
  record('slash：打"/skill"只剩 /skill:m6-hello；Enter 插入"/skill:m6-hello "、光标在末尾、列表关闭、不发送',
    filtered.items?.map((item) => item.name).join() === 'skill:m6-hello' && inserted.value === '/skill:m6-hello '
    && inserted.end && inserted.menu === 0 && inserted.sent === 0,
  JSON.stringify({ filtered: filtered.items, inserted }));
  await page.keyboard.press('Enter');
  await waitPaneIdle(page, 'focused');
  await skillBubble(page);
}

/** @brief 技能命令发出后：气泡"Skill · m6-hello"，正文收起、"Expand"后看到路径和正文；会话名；回复。 */
async function skillBubble(page) {
  const bubble = page.locator(`${FOCUSED} [data-testid="skill-invocation"]`).first();
  const folded = await bubble.locator('.skill-body').count().catch(() => null);
  await bubble.getByRole('button', { name: 'Expand' }).click().catch(() => {});
  const skill = await bubble.evaluate((el) => ({ name: el.dataset.skill,
    label: el.querySelector('.skill-label')?.textContent, body: el.querySelector('.skill-body')?.textContent ?? null }))
    .catch(() => null);
  const title = await page.locator(`${FOCUSED} [data-testid="session-title"]`).innerText();
  const reply = (await replies(page)).at(-1);
  record('slash：发出后你的消息显示成一行"技能 · m6-hello"，技能正文收起、"展开"后看到 SKILL.md 路径和正文；'
    + '会话名"/skill:m6-hello"；回复 M6-SKILL-OK', skill?.name === 'm6-hello' && skill.label === 'Skill · m6-hello'
    && folded === 0 && /skills\\m6-hello\\SKILL\.md/.test(skill.body ?? '') && skill.body.includes('M6-SKILL-OK')
    && title === '/skill:m6-hello' && reply?.text === 'M6-SKILL-OK', JSON.stringify({ folded, skill, title, reply }));
}

/** @brief 生成中（等批准时）打"/"出列表，Esc 只关列表：仍在生成、批准卡还在、没有发出停止；然后清空草稿。 */
async function slashEscWhileRunning(page, h) {
  await page.locator(`${FOCUSED} [data-testid="approval-card"]`).waitFor({ timeout: 60000 });
  const sent = await h.sent();
  await composerAt(page, 'focused').click();
  await page.keyboard.type('/');
  const opened = await page.getByTestId('slash-menu').waitFor({ timeout: 5000 }).then(() => true, () => false);
  await page.keyboard.press('Escape');
  await page.getByTestId('slash-menu').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const after = await page.evaluate((css) => ({ menu: Boolean(document.querySelector('[data-testid="slash-menu"]')),
    running: document.querySelector(`${css} [data-testid="chat-pane"]`)?.dataset.running === 'true',
    card: Boolean(document.querySelector(`${css} [data-testid="approval-card"]`)) }), FOCUSED);
  const unsent = await h.sent() - sent;
  await clearDraft(page);
  record('slash：生成中（等批准时）打"/"也出列表；Esc 先关列表：仍在生成、批准卡还在、没有发出停止',
    opened && !after.menu && after.running && after.card && unsent === 0, JSON.stringify({ opened, after, unsent }));
}

/** @brief Tab 插入高亮的第一项（不发送）；看完清空草稿。 */
async function slashTab(page, h) {
  await composerAt(page, 'focused').click();
  const typed = await typeSlash(page, '/m6');
  const sent = await h.sent();
  await page.keyboard.press('Tab');
  const draft = { ...await draftOf(page), menu: await page.getByTestId('slash-menu').count(),
    sent: await h.sent() - sent };
  await clearDraft(page);
  record('slash：打"/m6"时 /m6-summary 排第一并高亮；Tab 插入"/m6-summary "、光标在末尾、列表关闭、不发送',
    typed.items?.[0]?.name === 'm6-summary' && typed.items[0].selected && draft.value === '/m6-summary ' && draft.end
    && draft.menu === 0 && draft.sent === 0, JSON.stringify({ typed: typed.items, draft }));
}

/** @brief 走查 7 的提示词模板：打"/m6"，用鼠标点 /m6-summary 插入，接着写参数发出；气泡是展开后的模板。 */
async function slashTemplate(page, h) {
  await slashTab(page, h);
  await typeSlash(page, '/m6');
  await page.getByTestId('slash-menu').locator('[role="option"][data-name="m6-summary"]').click();
  const clicked = { ...await draftOf(page), menu: await page.getByTestId('slash-menu').count() };
  await page.keyboard.type('README.md');
  const after = await page.getByTestId('slash-menu').count();
  await page.keyboard.press('Enter');
  await slashEscWhileRunning(page, h);
  const card = await answerCard(page, 'approval-reject');
  await waitPaneIdle(page, 'focused');
  const users = await page.locator(`${FOCUSED} [data-testid="user-message"]`).allInnerTexts();
  record('slash：用鼠标点 /m6-summary 插入"/m6-summary "（焦点留在输入框、光标在末尾）；接着写参数时列表不再出现；'
    + '发出后气泡是 pi 展开后的模板', clicked.value === '/m6-summary ' && clicked.end && clicked.menu === 0
    && after === 0 && users.at(-1) === '请读取 README.md，然后用一句话总结它的内容。', JSON.stringify({ clicked, users }));
  record('slash：模板引出的命令出批准卡，拒绝（与录制一致）', card.tool === 'bash', JSON.stringify(card));
}

/** @brief 走查 7：输入"/"：列出提示词模板和技能命令，选中后插入；发出的技能命令和模板。 */
async function slash(page, h) {
  const fx = readFixture('slash');
  await h.load('slash');
  await newSessionVia(page, sideButton(page, 'Open folder…'));
  await slashSkill(page, h);
  await slashTemplate(page, h);
  await shot(page, 'slash');
  await finish(page, 'slash', commandsOf(fx).length);
}

const checks = { thinking, 'agents-md': agentsMd, 'project-skill': projectSkill, mcp, plugin, slash };

await buildHarness();
/** 回放窗口的临时数据目录：关掉窗口之后删掉 */
const harnessData = mkdtempSync(join(tmpdir(), 'mori-m6-harness-'));
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], env: { ...process.env,
  MORI_HARNESS_INDEX: join(outDir, 'index.html'), MORI_HARNESS_DATA: harnessData } });
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
process.exitCode = write('m6-replay.json') ? 0 : 1;
try {
  rmSync(harnessData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
  console.error(`[m6-replay] cannot remove ${harnessData}: ${error.message}`);
}
