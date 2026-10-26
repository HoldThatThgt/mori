// M6 整机测试（设置页、输入框下面一行的思考强度、用户级 AGENTS.md）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint，synthetic），覆盖 docs/v1/screens/customize-agents-md.md（原 v0 settings.md 的 AGENTS.md 一节）、
// models.md 的思考强度和方案第 7 节
// M6 走查 2、8 与反例。
// v1（docs/specs/model-providers.md §14.4）：连接、模型、默认模型、换模型、删除的步骤删去（由 v1-models-*.mjs 覆盖）；
// 思考强度与 AGENTS.md 的步骤保留，改用 v1 的首次启动表单与 设置 → Models 的模型表单（docs/v1/screens/first-run.md、
// models-settings.md、model-menu.md）。
// 覆盖：首次启动的"Supports thinking"（首次启动表单没有思考强度）、model-config.json 只有 key 的 ref、credentials.json 只有密文；
// 设置页的分节（Models、UI issues，↑ ↓ 与 Tab；2026-10-26 起 AGENTS.md 在 Customize）；模型没标支持思考时思考强度不可选
// （英文说明、"Open settings"）；
// 编辑模型标"Supports thinking"和新会话默认强度（model-config.json、settings.json 的 modelThinkingLevels）、打开着的会话
// 随之可选、"High"有思考内容、"Off"没有、新会话用按模型的默认强度、去掉支持思考时会话收紧、重启后恢复会话的强度；
// 用户级 AGENTS.md（2026-10-26 负责人走查 M4 起是 Customize 的最后一节 Instructions，docs/v1/screens/customize-agents-md.md：
// 分节的顺序与名字、第一行说明、空状态、保存与 Ctrl+S、撤销改动、生效的文件、AGENTS.override.md 与 CLAUDE.md 的警示、新会话的系统提示里有、
// 之前打开的会话没有、离开时有未保存改动的确认框（含换分节、Memory、Settings）、已在 Customize 时点 Customize 与点当前分节
// 不问、拖到 Customize 上、取消选文件夹、已归档的会话、关闭窗口时不问（2026-10-26 起关窗口藏进托盘，
// docs/v0/screens/window.md：改动留着；从托盘菜单"Exit"退出时也不问））、项目级列表与用系统编辑器打开、跟随 Customize 的会话
// （归档后换成没有会话、会话还在打开中时不说没有会话、后台进程退出时不是"Loading…"、Restart 后重新读取失败）；
// 2026-10-26 按状态表各行补的（walkthrough-1026/WP-07.md"状态表各行的用例"）：读取中与读取失败时的标题和第一行、
// override 与 CLAUDE.md 后面的 token 数、没有生效文件时没有 agents-tokens、Customize 顶部的 New session 先问、
// 保存后的重新读取失败（项目一栏留着；synthetic：icacls 拒绝读 AGENTS.md.tmp）、分屏里换了跟随的会话、跟随的会话还在打开中
// （synthetic 的慢项目 m6slow：不等 tools.get、项目一栏 Loading…）、后台进程退出时（agents-over、只有全局横幅、Save 失败、
// 换节再回来读取失败、Restart 后自己重新读取）；
// settings.json 读不出；输入框下面一行的窄栏（2026-10-21 起选择范围、Effort、权限按钮从顶栏移到这一行，
// docs/v0/composer-pickers.md：按 680 / 600 / 460 / 400 / 340px 分档，范围按钮任何宽度最长 200px，菜单往上打开）；
// Effort 按钮悬停两行、读屏的描述是第二行；新页面没有小于 12px 的字；页面没有报错。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-settings.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m6-app-settings(-packaged).json，截图在 test-results/m6-app-settings(-packaged)/。
// 用系统编辑器打开：经 app.evaluate 换掉主进程的 shell.openPath，只记下路径（不真的打开程序，与 m4-app.mjs 相同）。
// 一键拉取模型（docs/specs/model-discovery.md §13.4）：首次启动先 Fetch models，"Supports thinking"看的是清单里
// fake-coder 那一行的勾选框（page.mjs）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, archivedState, chooseMenuItem, clickOpenFolder, ctrlN, expandArchived, PANE, paneOf, rowOf, settle,
  stubFolder, until, waitIdle, waitReady,
} from './m3-helpers.mjs';
import { composerAt, waitPaneReady, waitSplit } from './m5-helpers.mjs';
import {
  buttonState, colorStack, contrastOf, fitPane, LEVEL_TEXT, menuGone, menuInside, modelRow, NOTE, ROW, rowState,
  seenStates, startFakeEndpoint, watchStates,
} from './m6-helpers.mjs';
import { AGENTS_OVER, estimate, thousands } from './mem-page-helpers.mjs';
import { OPEN_FOLDER, pageHelpers } from './page.mjs';
import {
  closeWindow, exitFromTray, messageBoxes, recordBalloons, stubMessageBox, waitWindow, windowState,
} from './tray-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const port = 4361;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值（synthetic），与任何真实服务无关。
const testKey = 'synthetic-test-key-m6-settings-not-real';

const shots = join(appRoot, `test-results/m6-app-settings${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** Mori 的提供商（provider id）：首次启动表单的名称 "Mori endpoint" 生成的 id（规格 §4.1） */
const MAIN = 'mori-endpoint';
/** 模型表单里模型 ID 和新会话思考强度两个字段的标签（docs/v0/ui-strings.md：Model ID、Default effort for new sessions） */
const ID_FIELD = 'Model ID';
const LEVEL_FIELD = 'Default effort for new sessions';

/** 写进用户级 AGENTS.md 的标记：合成端点的 "agents check" 在系统提示里找它 */
const MARKER = `MORI-AGENTS-${Date.now().toString(36).toUpperCase()}`;
/** 离开有未保存改动的 AGENTS.md 时确认框的标题和说明 */
const LEAVE_TITLE = 'Discard changes to AGENTS.md?';
const LEAVE_TEXT = 'Your edits haven’t been saved. Leaving now discards them.';
/** Instructions 一节标题下的第一行（customize-agents-md.md"位置"） */
const INTRO = 'Instructions here are saved in the AGENTS.md file that every session reads. Use this for preferences, '
  + 'conventions, or context that Mori should always know.';
/** 有会话时 Customize 的分节（data-section 与文字） */
const WITH_SESSION = 'builtin:Built-in tools,skills:Skills,mcp:MCP,plugins:Plugins,agents:Instructions';
/** 后台进程退出后 Instructions 一节项目一栏的说明 */
const CRASHED = 'Mori’s background process crashed. Restart it to continue.';
/** 后台进程退出后命令失败的原文（preload：`Mori’s background process crashed (exit code <n>)`） */
const CRASH_ERROR = /Mori’s background process crashed \(exit code -?\d+\)$/;
/** @brief 一个文件的 token 数在界面上的写法（customize-agents-md.md"token 数"：1 时 1 token，1000 起千分位）。 */
const tokenText = (content) => (estimate(content) === 1 ? '1 token' : `${thousands(estimate(content))} tokens`);
// ---------- 准备与磁盘 ----------

/** @brief 测试用的项目：README 和项目级 AGENTS.md（不含标记）。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-settings-'));
  const project = join(root, 'm6proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used to check Mori settings.\n');
  writeFileSync(join(project, 'AGENTS.md'), '# 项目说明（synthetic）\n\n这是项目级的 AGENTS.md。\n');
  writeFileSync(join(project, 'src', 'a.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return { root, project };
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
}

/** @brief 读文本文件；不存在时为 null。 */
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
/** @brief model-config.json、pi 的 settings.json（不存在时为空对象）。 */
const configJson = (ctx) => JSON.parse(readText(configFile(ctx)) ?? '{}');
const settingsJson = (ctx) => JSON.parse(readText(join(ctx.userData, 'pi', 'settings.json')) ?? '{}');

/** @brief model-config.json、pi 的 settings.json 的路径。 */
const configFile = (ctx) => join(ctx.userData, 'model-config.json');
const settingsFile = (ctx) => join(ctx.userData, 'pi', 'settings.json');

/** @brief 用户级 AGENTS.md 的路径。 */
const userAgents = (ctx) => join(ctx.userData, 'pi', 'AGENTS.md');

/**
 * @brief credentials.json：原文、有哪些 ref、值是不是都是 base64、原文或解开 base64 之后有没有测试 key 的明文。
 *        只检查测试自己生成的合成 key（synthetic），不读取也不打印任何真实 key。
 */
function credentialsState(ctx) {
  const text = readText(join(ctx.userData, 'credentials.json'));
  if (text === null) return { text: null, refs: [], base64: false, plain: false };
  const keys = JSON.parse(text);
  const values = Object.values(keys).map(String);
  const hasPlain = (value) => value.includes(testKey);
  return { text, refs: Object.keys(keys), base64: values.every((value) => /^[A-Za-z0-9+/]+=*$/.test(value)),
    plain: hasPlain(text) || values.some((value) => hasPlain(Buffer.from(value, 'base64').toString('latin1'))) };
}

/** @brief 换掉主进程的 shell.openPath：只记下路径（在主进程里运行，经 app.evaluate）。 */
function stubOpenPath({ shell }) {
  globalThis.__opened = globalThis.__opened ?? [];
  shell.openPath = async (path) => {
    globalThis.__opened.push(path);
    return '';
  };
}

/** @brief 两个路径是否相同（Windows 不区分大小写）。 */
const samePath = (a, b) => Boolean(a && b) && resolve(a).toLowerCase() === resolve(b).toLowerCase();

// ---------- 页面操作 ----------

/** @brief 等 Instructions 一节读好（编辑框可用）。 */
const agentsReady = (page) => page.waitForFunction(() => document.querySelector('[data-testid="agents-editor"]')
  ?.disabled === false, null, { timeout: 15000 });

/** @brief 从左栏进入 Customize（不在 Customize 时），等它出现；返回进入时的分节（toolsNav）。 */
async function enterCustomize(page) {
  if (!(await page.getByTestId('tools-page').count())) {
    await page.getByTestId('nav-tools').click();
    await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  }
  return toolsNav(page);
}

/**
 * @brief 打开 Customize 的 Instructions 一节（2026-10-26 起它是 Customize 的最后一节；左栏进入时落在第一节，再点这一节），
 *        等它读好。
 */
async function openAgents(page) {
  await enterCustomize(page);
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await agentsReady(page);
}

/** @brief 重新读一次 Instructions 一节：在 Customize 里先换到 Skills 再回来（回到这一节时重新读取），不在时进入 Customize。 */
async function freshAgents(page) {
  if (await page.getByTestId('tools-page').count()) {
    await page.locator('[data-testid="tools-nav"] button[data-section="skills"]').click();
  }
  await openAgents(page);
}

/** @brief Customize 的分节（data-section 与文字）和当前分节；不在 Customize 时为 null。 */
const toolsNav = (page) => page.evaluate(() => {
  const nav = document.querySelector('[data-testid="tools-nav"]');
  return nav && { sections: [...nav.querySelectorAll('button[data-section]')]
    .map((item) => `${item.dataset.section}:${item.textContent}`),
  current: nav.querySelector('[aria-current="page"]')?.dataset.section ?? null };
});

/** @brief 只点左栏"Settings"、不点分节，返回设置页出现时落在哪一节（currentSection）。 */
async function landSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  return currentSection(page);
}

/** @brief 打开设置页（左栏"Settings"），切到 Models，等这一节读好。 */
async function openSettings(page) {
  await landSettings(page);
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
}

/** @brief 设置页或 Customize 的"Back to app"，等会话面板就绪。 */
async function back(page) {
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="settings-page"], [data-testid="tools-page"]'),
    null, { timeout: 5000 });
  await waitReady(page);
}

/**
 * @brief 设置页当前的分节（aria-current）和显示的内容：UI issues 一节带 data-section；Models 分节（读取中、读完、
 *        读取失败）记为 models。
 */
const currentSection = (page) => page.evaluate(() => {
  const body = document.querySelector('.settings-body');
  const models = body?.querySelector('[data-testid="models-section"], [data-testid="models-loading"]');
  return { nav: document.querySelector('[data-testid="settings-nav"] [aria-current="page"]')?.dataset.section ?? null,
    body: body?.querySelector('.settings-section[data-section]')?.dataset.section ?? (models ? 'models' : null) };
});

/** @brief 填 设置 → Models 的模型表单（v1）；不传的字段不动。 */
async function fillModelForm(page, { reasoning, level }) {
  const form = page.getByTestId('model-form');
  if (reasoning !== undefined) await form.getByLabel('Supports thinking').setChecked(reasoning);
  if (level !== undefined) await form.getByLabel(LEVEL_FIELD).selectOption(level);
}

/** @brief 模型表单此刻的样子：标题、Model ID 是否只读、密码框个数、Supports thinking、新会话思考强度的选项。 */
function modelFormState(page) {
  return page.evaluate(({ idLabel, levelLabel }) => {
    const form = document.querySelector('[data-testid="model-form"]');
    if (!form) return null;
    const row = (label) => [...form.querySelectorAll('.mf-row')]
      .find((item) => item.querySelector('label')?.textContent === label);
    const select = row(levelLabel)?.querySelector('select');
    const box = [...form.querySelectorAll('label.check-row')].find((item) => item.textContent === 'Supports thinking');
    return { title: form.querySelector('h3')?.textContent ?? null,
      idReadOnly: row(idLabel)?.querySelector('input')?.readOnly ?? null,
      passwords: form.querySelectorAll('input[type="password"]').length,
      reasoning: box?.querySelector('input')?.checked ?? null,
      level: select ? { value: select.value, options: [...select.options].map((option) => option.textContent) }
        : null };
  }, { idLabel: ID_FIELD, levelLabel: LEVEL_FIELD });
}

/** @brief 保存模型表单：成功时表单关闭，返回 null；失败时留在表单里，返回表单里的原文。 */
async function saveModelForm(page) {
  await page.getByTestId('model-form').getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="model-form"]')
    || document.querySelector('[data-testid="model-form"] [data-testid="form-message"]'), null, { timeout: 15000 });
  if (!(await page.getByTestId('model-form').count())) return null;
  return page.getByTestId('model-form').getByTestId('form-message').innerText();
}

/** @brief 确认框（delete-dialog / leave-dialog）的标题、说明、按钮和焦点所在的按钮。 */
async function dialogState(page, testId) {
  const dialog = page.getByTestId(testId);
  await dialog.waitFor({ timeout: 5000 });
  await page.waitForFunction((id) => document.activeElement?.closest(`[data-testid="${id}"]`), testId,
    { timeout: 2000 }).catch(() => {});
  return dialog.evaluate((element) => ({ title: element.querySelector('h2')?.textContent ?? '',
    text: element.querySelector('p')?.textContent ?? '',
    buttons: [...element.querySelectorAll('button')].map((button) => button.textContent),
    focused: element.contains(document.activeElement) ? document.activeElement.textContent : null }));
}

/** @brief 打开着的菜单（焦点在当前项上）里按 downs 次 ↓ 再按 Enter；返回之后焦点是不是回到了 button。 */
async function chooseByKeys(page, menuId, buttonId, downs) {
  await page.getByTestId(menuId).waitFor({ timeout: 5000 });
  await page.waitForFunction((id) => document.activeElement?.closest(`[data-testid="${id}"]`), menuId,
    { timeout: 2000 });
  for (let n = 0; n < downs; n += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByTestId(menuId).waitFor({ state: 'detached', timeout: 5000 });
  return page.evaluate(({ selector, id }) => document.activeElement === document.querySelector(
    `${selector} [data-testid="${id}"]`), { selector: PANE, id: buttonId });
}

/** @brief 打开当前一栏的思考菜单，读出各项（可用、打勾）、说明和其他操作。 */
async function openThinkingMenu(page) {
  await paneOf(page).getByTestId('thinking-button').click();
  const menu = page.getByTestId('thinking-menu');
  await menu.waitFor({ timeout: 5000 });
  return menu.evaluate((element) => ({
    items: [...element.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ level: item.dataset.level,
      text: item.textContent, disabled: item.disabled, checked: item.getAttribute('aria-checked') === 'true' })),
    note: element.querySelector('.menu-note')?.textContent ?? '',
    actions: [...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent) }));
}

/** @brief 在当前一栏输入框下面一行换思考强度，等按钮的 data-level 变过去、不再是"切换中"。 */
async function chooseLevel(page, level) {
  await paneOf(page).getByTestId('thinking-button').click();
  await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.level === want && button.getAttribute('aria-disabled') !== 'true';
  }, { selector: PANE, want: level }, { timeout: 15000 });
}

/** @brief 当前一栏的助手回复条数、最后一条的正文和思考块个数、全部错误卡的原文。 */
function paneReplies(page) {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const replies = [...(pane?.querySelectorAll('[data-testid="assistant"]') ?? [])];
    const last = replies.at(-1);
    return { count: replies.length, text: last?.querySelector('.prose')?.textContent ?? last?.textContent ?? '',
      thinking: last?.querySelectorAll('details.thinking').length ?? 0,
      errors: [...(pane?.querySelectorAll('[data-testid="error-card"]') ?? [])].map((card) => card.textContent) };
  }, PANE);
}

/**
 * @brief 在当前一栏发一条消息，等你的消息（或错误卡）出现、本轮结束；返回新的回复（fresh 为有新的助手回复）
 *        和这次新出现的错误卡。
 */
async function sendIn(page, text, timeout = 60000) {
  const before = await paneReplies(page);
  const marks = '[data-testid="user-message"], [data-testid="error-card"]';
  const seen = await paneOf(page).locator(marks).count();
  const composer = paneOf(page).locator('.composer textarea');
  await composer.fill(text);
  await composer.press('Enter');
  await page.waitForFunction(({ selector, n, marks: query }) => document.querySelector(selector)
    ?.querySelectorAll(query).length > n, { selector: PANE, n: seen, marks }, { timeout: 20000 });
  await waitIdle(page, timeout);
  const after = await paneReplies(page);
  return { ...after, fresh: after.count > before.count, newErrors: after.errors.slice(before.errors.length) };
}

/**
 * @brief 记下此刻 selector 范围里小于 12px 的可见文字（最后统一判断）。
 * @param where 记录里写的位置
 */
async function noteSmall(ctx, where, selector) {
  const small = await ctx.page.evaluate((query) => [...document.querySelectorAll(query)]
    .flatMap((root) => [root, ...root.querySelectorAll('*')])
    .filter((element) => [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
    .filter((element) => element.getClientRects().length > 0)
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12)
    .map((element) => `${element.tagName.toLowerCase()}.${element.className}: ${getComputedStyle(element).fontSize}`),
  selector);
  ctx.small.push(...small.map((item) => `${where}: ${item}`));
  ctx.smallChecked.push(where);
}

// ---------- 步骤：首次启动与列表 ----------

/**
 * @brief 首次启动（v1）：拉取后清单里 fake-coder 一行有"Supports thinking"（服务没报告，不勾），首次启动表单没有新会话
 *        思考强度（勾上也没有，建好后在 设置 → Models 里改，first-run.md；model-discovery.md §5.4、§13.4：这项检查从拉取前的
 *        表单移到拉取后的清单）；测试连接成功、等探针跑完后打开项目。
 */
async function firstRun(ctx) {
  const { page, h } = ctx;
  const form = page.getByTestId('connection-form');
  await form.waitFor({ timeout: 60000 });
  const fetched = await h.fillConnection({ baseUrl, apiKey: testKey });
  const box = form.locator('[data-testid="discovered-row"][data-model="fake-coder"] input[data-field="reasoning"]');
  const level = () => form.getByLabel(LEVEL_FIELD).count();
  const before = { checked: await box.isChecked(), select: await level(), label: await box.getAttribute('aria-label') };
  await box.check();
  const checked = await level();
  await box.uncheck();
  record('首次启动：拉取后清单里 fake-coder 一行有"Supports thinking"（不勾）；首次启动表单没有"Default effort for new '
    + 'sessions"（勾上也没有）', fetched?.state === 'list' && before.label === 'Supports thinking for fake-coder'
    && before.checked === false && before.select === 0 && checked === 0, JSON.stringify({ fetched, before, checked }));
  await h.setupFirstRun({ baseUrl, apiKey: testKey });
  firstRunFiles(ctx);
  await stubFolder(ctx.app, ctx.project);
  await page.getByRole('button', { name: OPEN_FOLDER }).first().click();
  await waitReady(page);
  ctx.s1 = await activeFile(page);
}

/** @brief 首次启动保存后的文件：model-config.json 有 mori-endpoint 和 fake-coder，key 只有 ref；credentials.json 只有密文。 */
function firstRunFiles(ctx) {
  const text = readText(configFile(ctx)) ?? '';
  const config = configJson(ctx);
  const provider = config.providers?.find((item) => item.id === MAIN);
  record('保存后：model-config.json 写了提供商 mori-endpoint 和模型 fake-coder（reasoning: false），key 只有 ref 与标签、'
    + '没有明文；默认范围是这个模型', provider?.baseUrl === baseUrl && provider.models.length === 1
    && provider.models[0].id === 'fake-coder' && provider.models[0].reasoning === false && provider.keys.length === 1
    && !text.includes(testKey) && config.normalDefault === `${MAIN}/fake-coder`, oneLine(text, 300));
  const credentials = credentialsState(ctx);
  record('credentials.json 只有这个 key 的 ref 一项，值是 base64 密文（原文和解开 base64 后都没有 key 的明文）',
    credentials.refs.join() === (provider?.keys[0]?.ref ?? '?') && credentials.base64 && !credentials.plain,
    JSON.stringify({ refs: credentials.refs, base64: credentials.base64, plain: credentials.plain }));
}

/** @brief 设置页：分节 Models、UI issues（2026-10-26 起没有 AGENTS.md），落在 Models；提供商卡与模型行；分节可以用 ↑ ↓ 切换。 */
async function settingsList(ctx) {
  const { page } = ctx;
  const landed = await landSettings(page);
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
  const nav = await page.locator('[data-testid="settings-nav"] button').evaluateAll((items) => items.map((item) => ({
    section: item.dataset.section, text: item.textContent, current: item.getAttribute('aria-current') })));
  const backButton = await page.getByRole('button', { name: 'Back to app', exact: true }).count();
  record('设置页：左边分节"Models""UI issues"（docs/specs/memory.md §10.8；2026-10-26 起"AGENTS.md"挪到 Customize），'
    + '打开时落在 Models（aria-current）；顶部"Back to app"',
  nav.map((item) => `${item.section}:${item.text}`).join() === 'models:Models,issues:UI issues'
    && nav[0].current === 'page' && nav[1].current === null && backButton === 1
    && landed.body === 'models', JSON.stringify({ landed, nav }));
  const cards = await page.getByTestId('provider-card')
    .evaluateAll((items) => items.map((item) => item.dataset.provider));
  record('Models：一张提供商卡 mori-endpoint，下面是模型行 mori-endpoint/fake-coder', cards.join() === MAIN
    && await modelRow(page, `${MAIN}/fake-coder`).count() === 1, JSON.stringify(cards));
  await noteSmall(ctx, '设置页 Models', '.settings-page');
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').focus();
  await page.keyboard.press('ArrowDown');
  const down = await currentSection(page);
  await page.keyboard.press('ArrowUp');
  const up = await currentSection(page);
  record('分节列表可以用 ↑ ↓ 切换（↓ 到 UI issues，↑ 回到 Models），当前分节高亮', down.nav === 'issues'
    && down.body === 'issues' && up.nav === 'models' && up.body === 'models', JSON.stringify({ down, up }));
  await navByTab(page);
  await shot(page, '1-settings-list');
  await back(page);
}

/** @brief 分节列表用 Tab / Shift+Tab 在分节按钮之间移动，Enter、空格换过去。 */
async function navByTab(page) {
  const focused = () => page.evaluate(() => document.activeElement?.closest('[data-testid="settings-nav"]')
    ? document.activeElement.dataset.section : null);
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').focus();
  await page.keyboard.press('Tab');
  const tabbed = await focused();
  await page.keyboard.press('Enter');
  const entered = await currentSection(page);
  await page.keyboard.press('Shift+Tab');
  const back = await focused();
  await page.keyboard.press('Space');
  const spaced = await currentSection(page);
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
  record('分节列表可以用 Tab 移动（Tab 到 UI issues、Shift+Tab 回到 Models），Enter、空格换过去', tabbed === 'issues'
    && entered.nav === 'issues' && entered.body === 'issues' && back === 'models' && spaced.nav === 'models'
    && spaced.body === 'models', JSON.stringify({ tabbed, entered, back, spaced }));
}

// ---------- 步骤：思考强度 ----------

/** 模型没标支持思考时思考菜单里的说明（规格 §9.2） */
const UNSUPPORTED_NOTE = 'This model isn’t marked “Supports thinking”, so Mori doesn’t send thinking parameters and '
  + 'the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit '
  + 'this model in Settings → Models and check “Supports thinking”.';

/**
 * @brief 反例：模型没标支持思考时思考强度不可选，并说明原因（英文）；"Open settings"进入 设置 → Models。
 *        2026-10-21 起这时的字不再变淡（--color-muted，与能用时同色，composer-pickers.md"我自己定的"第 19 条），所以不比颜色，
 *        比 data-reasoning、按钮文字、悬停两行和读屏的描述，另查字和底色的对比度 ≥ 4.5:1。
 */
async function thinkingUnsupported(ctx) {
  const { page } = ctx;
  const plain = await buttonState(page, 'thinking-button');
  ctx.modelColor = (await buttonState(page, 'model-button')).color;
  const contrast = contrastOf(await colorStack(page, `${PANE} ${ROW} [data-testid="thinking-button"]`));
  const reply = await sendIn(page, 'thinking check');
  const menu = await openThinkingMenu(page);
  await noteSmall(ctx, '思考菜单（不支持思考）', '[data-testid="thinking-menu"]');
  record('反例：模型没标"Supports thinking"时输入框下面一行的按钮"Effort: Unavailable"（data-reasoning=false，可以点开，'
    + '不带 aria-disabled；字和底色对比度 ≥ 4.5:1）；悬停两行"Effort: Unavailable"和"This model isn’t marked “Supports '
    + 'thinking”"，读屏的描述是第二行；菜单里 Off、Minimal、Low、Medium、High 都不可用（不是藏起来），说明原因（§9.2 的英文），'
    + '有"Open settings"', plain.text === 'Effort: Unavailable' && plain.inRow && !plain.inTopbar
    && plain.reasoning === 'false' && !plain.disabled && !plain.hasAria && plain.icon && contrast >= 4.5
    && plain.lines.join('|') === `Effort: Unavailable|${NOTE.unsupported}` && plain.described === NOTE.unsupported
    && menu.items.map((item) => item.text).join() === 'Off,Minimal,Low,Medium,High'
    && menu.items.every((item) => item.disabled && !item.checked) && menu.note === UNSUPPORTED_NOTE
    && menu.actions.join() === 'Open settings', JSON.stringify({ plain, contrast, menu }));
  record('没标支持思考时不发送思考参数（"thinking check" → "没有思考参数"）', reply.fresh && reply.text === '没有思考参数'
    && reply.thinking === 0, reply.text);
  await shot(page, '4-thinking-unsupported');
  await page.getByTestId('thinking-menu').getByRole('menuitem', { name: 'Open settings' }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 5000 });
  const section = await currentSection(page);
  record('思考菜单的"Open settings"：打开 设置 → Models', section.nav === 'models' && section.body === 'models',
    JSON.stringify(section));
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
}

/**
 * @brief 编辑模型（v1 的模型表单）：标"Supports thinking"、新会话默认"High"：model-config.json 的 reasoning、
 *        settings.json 的 modelThinkingLevels。
 */
async function markReasoning(ctx) {
  const { page } = ctx;
  const ref = `${MAIN}/fake-coder`;
  await modelRow(page, ref).locator('[data-action="edit"]').click();
  await page.getByTestId('model-form').waitFor({ timeout: 5000 });
  const form = await modelFormState(page);
  await fillModelForm(page, { reasoning: true });
  const checked = await modelFormState(page);
  await noteSmall(ctx, '编辑模型表单（有思考强度）', '.settings-page');
  await fillModelForm(page, { level: 'high' });
  const message = await saveModelForm(page);
  const row = oneLine(await modelRow(page, ref).innerText().catch(() => ''));
  const model = configJson(ctx).providers?.find((item) => item.id === MAIN)?.models.find((m) => m.id === 'fake-coder');
  const levels = settingsJson(ctx).modelThinkingLevels ?? {};
  record('编辑模型：标题"Edit model · Mori endpoint"，Model ID 只读，没有 key 框；不勾"Supports thinking"时没有'
    + '"Default effort for new sessions"，勾上才出现（Off 到 Max，默认 Medium）', form?.title === 'Edit model · Mori endpoint'
    && form.idReadOnly === true && form.passwords === 0 && form.reasoning === false && form.level === null
    && checked?.level?.options.join() === 'Off,Minimal,Low,Medium,High,Extra high,Max'
    && checked.level.value === 'medium', JSON.stringify({ form, checked: checked?.level }));
  record('走查 8：标"Supports thinking"、新会话默认"High"后：模型行显示"Supports thinking"；model-config.json 里'
    + ' reasoning: true，settings.json 的 modelThinkingLevels["mori-endpoint/fake-coder"] 为 high', message === null
    && row.includes('Supports thinking') && model?.reasoning === true && levels[ref] === 'high',
  JSON.stringify({ message, row, model, levels }));
}

/**
 * @brief 打开着的会话随之可选；"High"有思考内容，"Off"没有；不改设置；新会话用按模型的默认强度。
 *        v1：会话新建时的强度是第一个候选的 modelThinkingLevels → defaultThinkingLevel → medium（规格 §11.1），
 *        S1 建的时候 fake-coder 还没有按模型的强度，所以是"Medium"（不支持思考时显示"Unavailable"），标了之后显示"Medium"。
 */
async function thinkingLevels(ctx) {
  const { page } = ctx;
  await back(page);
  await page.waitForFunction((selector) => document.querySelector(`${selector} [data-testid="thinking-button"]`)
    ?.dataset.reasoning === 'true', PANE, { timeout: 10000 }).catch(() => {});
  const open = await buttonState(page, 'thinking-button');
  const menu = await openThinkingMenu(page);
  await noteSmall(ctx, '思考菜单（支持思考）', '[data-testid="thinking-menu"]');
  await page.keyboard.press('Escape');
  const closed = await menuGone(page, 'thinking-menu');
  record('已经打开的会话（打开时模型没标支持思考）：设置里标了之后输入框下面一行的思考强度变得可选（关–高都可用，字与范围按钮'
    + '同色），悬停两行"Effort: Medium"和"Set the effort level for this session"，读屏的描述是第二行；当前"中"（会话新建时的'
    + ' medium，§11.1）打勾；底部"只作用于这个会话；新会话的默认在设置里按模型设定"；Esc 关闭菜单',
  open.reasoning === 'true' && open.text === 'Effort: Medium' && open.color === ctx.modelColor && closed
    && open.lines.join('|') === `Effort: Medium|${NOTE.effort}` && open.described === NOTE.effort && !open.hasAria
    && menu.items.map((item) => item.level).join() === 'off,minimal,low,medium,high'
    && menu.items.every((item) => !item.disabled) && menu.items.find((item) => item.checked)?.level === 'medium'
    && menu.note === 'Applies to this session only. Set each model’s default for new sessions in Settings.',
  JSON.stringify({ open, closed, menu }));
  await paneOf(page).getByTestId('thinking-button').click();
  await watchStates(page, 'thinking');
  const focusBack = await chooseByKeys(page, 'thinking-menu', 'thinking-button', 1);
  await page.waitForFunction((selector) => {
    const button = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.level === 'high' && button.getAttribute('aria-disabled') !== 'true';
  }, PANE, { timeout: 15000 }).catch(() => {});
  const switching = await seenStates(page);
  const high = await sendIn(page, 'thinking check');
  const highButton = await buttonState(page, 'thinking-button');
  record('走查 8：只用键盘（菜单里从"中"按 1 次 ↓ 到"高"、Enter）切到"高"：焦点回到按钮，按钮"思考：高"；回复带思考内容，'
    + '端点收到 high（"收到思考参数：high"）', focusBack && highButton.text === 'Effort: High' && high.fresh
    && high.text === '收到思考参数：high' && high.thinking === 1,
  JSON.stringify({ focusBack, button: highButton.text, text: high.text, thinking: high.thinking }));
  record('思考强度切换中：session.setThinking 返回之前按钮已显示"高"、不可用且带 data-pending（切换中，不是"不可用"），'
    + '返回后恢复可用（不带 aria-disabled、data-pending）', switching.includes('high|true|true')
    && switching.at(-1) === 'high|null|null', JSON.stringify(switching));
  await chooseLevel(page, 'off');
  const off = await sendIn(page, 'thinking check');
  record('走查 8 / 反例：切到"关"：下一次回复没有思考内容（"没有思考参数"）', off.fresh && off.text === '没有思考参数'
    && off.thinking === 0, JSON.stringify({ text: off.text, thinking: off.thinking }));
  await thinkingNewSession(ctx);
}

/** @brief 在输入框下面一行切换思考强度不改设置；新会话用默认范围（fake-coder）在设置里的默认强度。 */
async function thinkingNewSession(ctx) {
  const { page } = ctx;
  const settings = settingsJson(ctx);
  record('反例：在输入框下面一行切换思考强度不改设置（modelThinkingLevels 仍是 high，没有写 defaultThinkingLevel）',
    settings.modelThinkingLevels?.[`${MAIN}/fake-coder`] === 'high' && settings.defaultThinkingLevel === undefined,
    JSON.stringify({ levels: settings.modelThinkingLevels, global: settings.defaultThinkingLevel }));
  ctx.s4 = await ctrlN(page);
  const fresh = await buttonState(page, 'thinking-button');
  const freshReply = await sendIn(page, 'thinking check');
  record('新会话用默认范围的第一个候选和它在设置里的默认强度：fake-coder 的新会话是"思考：高"，回复带思考内容'
    + '（"收到思考参数：high"）', fresh.level === 'high' && fresh.text === 'Effort: High'
    && freshReply.text === '收到思考参数：high' && freshReply.thinking === 1,
  JSON.stringify({ fresh, reply: freshReply.text }));
  await shot(page, '5-thinking');
}

/** @brief 在 设置 → Models 编辑一个 mori-endpoint 下的模型：改 fields 后保存；返回 saveModelForm 的结果。 */
async function editModel(page, modelId, fields) {
  await modelRow(page, `${MAIN}/${modelId}`).locator('[data-action="edit"]').click();
  await page.getByTestId('model-form').waitFor({ timeout: 5000 });
  await fillModelForm(page, fields);
  return saveModelForm(page);
}

/** @brief 等当前一栏的思考按钮 data-reasoning 变成 want（后台进程换了模型对象之后发 mori.model_state）。 */
const waitReasoning = (page, want) => page.waitForFunction(({ selector, value }) => document.querySelector(
  `${selector} [data-testid="thinking-button"]`)?.dataset.reasoning === value, { selector: PANE, value: want },
{ timeout: 10000 }).catch(() => {});

/**
 * @brief 编辑模型去掉"Supports thinking"：用它的打开着的会话思考强度按 pi 收紧为"Off"，Effort 按钮随之变成"Unavailable"；
 *        再标回来。最后在 S1 切到"Low"（重启后检查恢复）。
 */
async function unmarkReasoning(ctx) {
  const { page } = ctx;
  const ref = `${MAIN}/fake-coder`;
  await openSettings(page);
  const message = await editModel(page, 'fake-coder', { reasoning: false });
  const model = configJson(ctx).providers?.find((item) => item.id === MAIN)?.models.find((m) => m.id === 'fake-coder');
  const levels = settingsJson(ctx).modelThinkingLevels ?? {};
  const row = oneLine(await modelRow(page, ref).innerText().catch(() => ''));
  await back(page);
  await waitReasoning(page, 'false');
  const s4 = await buttonState(page, 'thinking-button');
  record('编辑模型去掉"Supports thinking"：模型行不再显示它，model-config.json 的 reasoning 为 false，settings.json 删掉它的'
    + ' modelThinkingLevels；正在用它的会话（"思考：高"）按 pi 收紧为"关"，Effort 按钮随之变成"思考：不可选"', message === null
    && !row.includes('Supports thinking') && model?.reasoning === false && !(ref in levels)
    && s4.reasoning === 'false' && s4.level === 'off' && s4.text === 'Effort: Unavailable',
  JSON.stringify({ message, row, model, levels, s4 }));
  await openSettings(page);
  await editModel(page, 'fake-coder', { reasoning: true, level: 'high' });
  await back(page);
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  await waitReasoning(page, 'true');
  await chooseLevel(page, 'low');
}

// ---------- 步骤：AGENTS.md ----------

/**
 * @brief Customize 的 Instructions 一节此刻的样子。tokens 是生效的文件那一行的 agents-tokens（tokenCount 为这一节里
 *        agents-tokens 的个数，tokensAfter 为它紧跟在 agents-effective 后面），over 是 agents-over 的文字，alert 是
 *        这一节顶部 role=alert 的文字（都没有时为 null）。
 */
function agentsState(page) {
  return page.evaluate(() => {
    const section = document.querySelector('[data-testid="agents-section"]');
    const intro = document.querySelector('[data-testid="agents-intro"]');
    const editor = document.querySelector('[data-testid="agents-editor"]');
    const loaded = document.querySelector('[data-testid="agents-loaded"]');
    const effective = document.querySelector('[data-testid="agents-effective"]');
    const tokens = section?.querySelectorAll('[data-testid="agents-tokens"]') ?? [];
    const button = (name) => [...(section?.querySelectorAll('.agents-user .form-actions button') ?? [])]
      .find((item) => item.textContent === name);
    return { shown: Boolean(section), text: section?.innerText ?? '', heading: section?.querySelector('h2')
      ?.textContent ?? null, intro: intro?.textContent ?? null,
      introFirst: Boolean(intro) && intro === section.querySelector('h2')?.nextElementSibling,
      saveDisabled: button('Save')?.disabled ?? null, revertDisabled: button('Discard changes')?.disabled ?? null,
      path: section?.querySelector('.agents-user .agents-path')?.textContent ?? null, editor: editor?.value ?? null,
      effective: effective?.textContent ?? null, warn: effective?.classList.contains('warn') ?? null,
      tokens: tokens[0]?.textContent ?? null, tokenCount: tokens.length,
      tokensAfter: Boolean(effective) && effective.nextElementSibling === tokens[0],
      over: section?.querySelector('[data-testid="agents-over"]')?.textContent ?? null,
      alert: section?.querySelector(':scope > [role="alert"]')?.textContent ?? null,
      status: section?.querySelector('.agents-status')?.textContent ?? null,
      loadedTitle: loaded?.querySelector('h3')?.textContent ?? null,
      loadedText: loaded?.innerText ?? '',
      loadedFiles: [...(loaded?.querySelectorAll('.agents-files .agents-path') ?? [])].map((item) => item.textContent),
      loadedInputs: loaded ? loaded.querySelectorAll('textarea, input').length : null,
      focused: Boolean(editor) && document.activeElement === editor };
  });
}

/** @brief 等 AGENTS.md 编辑框旁边的一行变成 text。 */
const waitAgentsStatus = (page, text) => page.waitForFunction((want) => document.querySelector('.agents-status')
  ?.textContent === want, text, { timeout: 10000 }).catch(() => {});

/**
 * @brief 2026-10-26 补（customize-agents-md.md"标题与第一行""读取中""没有生效的文件"）：读取中（User 下 Loading…、
 *        编辑框不可用的那一刻）标题和紧跟它的第一行已经在；没有生效的文件时既没有生效文件那一行，也没有 agents-tokens。
 * @param loading watchStates('agents') 记下的快照
 * @param empty 读完之后（文件不存在、agentDir 里没有别的文件）的 agentsState
 */
function loadingAndEmpty(loading, empty) {
  record('读取中（User 下"Loading…"、编辑框不可用的那一刻）：标题"Instructions"和紧跟它的第一行已经在',
    loading.some((item) => item === `Loading…|true|Instructions|${INTRO}|`), JSON.stringify(loading));
  record('没有生效的文件（agentDir 里没有 AGENTS.md 等）：没有生效文件那一行（agents-effective），也没有 agents-tokens',
    empty.effective === null && empty.tokenCount === 0 && !empty.text.includes('In effect'),
  JSON.stringify({ effective: empty.effective, tokens: empty.tokenCount }));
}

/**
 * @brief 用户级 AGENTS.md：Customize 的分节（Instructions 在最后，左栏进入落在第一节）、标题与第一行、空状态、
 *        项目级列表与用系统编辑器打开、保存与 Ctrl+S、撤销改动、生效的文件。
 */
async function agentsUser(ctx) {
  const { page, app } = ctx;
  ctx.before = await ctrlN(page);
  await watchStates(page, 'agents');
  const nav = await enterCustomize(page);
  record('Customize 的分节（2026-10-26 负责人定）：有会话时 Built-in tools、Skills、MCP、Plugins、Instructions'
    + '（用户级 AGENTS.md 是最后一节）；左栏进入时落在第一节 Built-in tools', nav?.current === 'builtin'
    && nav.sections.join() === WITH_SESSION, JSON.stringify(nav));
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await agentsReady(page);
  const loading = await seenStates(page);
  const empty = await agentsState(page);
  record('Instructions 一节：标题"Instructions"，标题下第一行说明这就是每个会话都读的 AGENTS.md', empty.heading
    === 'Instructions' && empty.intro === INTRO && empty.introFirst, JSON.stringify({ heading: empty.heading,
    intro: empty.intro, first: empty.introFirst }));
  await noteSmall(ctx, 'Instructions 一节', '[data-testid="tools-page"]');
  record('AGENTS.md 读取中：agents.get 返回之前"正在读取…"，编辑框不可用', loading.some((item) => item.startsWith(
    'Loading…|true|')) && loading.at(-1)?.startsWith('|false|'), JSON.stringify(loading));
  loadingAndEmpty(loading, empty);
  record('AGENTS.md：路径 <agentDir>\\AGENTS.md，"还没有这个文件，保存后创建"，编辑框是空的，还没有生效的文件；'
    + '没有改动时"保存""撤销改动"不可用', samePath(empty.path, userAgents(ctx))
    && empty.text.includes('This file doesn’t exist yet. Saving creates it.') && empty.editor === ''
    && empty.effective === null && empty.saveDisabled === true && empty.revertDisabled === true,
  JSON.stringify({ path: empty.path, effective: empty.effective, save: empty.saveDisabled }));
  const projectFile = join(ctx.project, 'AGENTS.md');
  record('项目级（只列出）：标题"m6proj 加载的文件"，列出项目 AGENTS.md 的完整路径，说明"会话打开时读取；之后改了文件，新会话才会读到"；'
    + '没有编辑框', empty.loadedTitle === `Files loaded by ${basename(ctx.project)}`
    && empty.loadedFiles.some((path) => samePath(path, projectFile))
    && empty.loadedText
      .includes('Read when the session opens. If you change a file later, only new sessions pick it up.')
    && empty.loadedInputs === 0,
  JSON.stringify({ title: empty.loadedTitle, files: empty.loadedFiles }));
  await app.evaluate(stubOpenPath);
  const row = page.getByTestId('agents-loaded').locator('li').filter({ hasText: 'm6proj' }).last();
  await row.getByRole('button', { name: 'Open in default app' }).click();
  const opened = await until(() => app.evaluate(() => globalThis.__opened?.at(-1) ?? null), 3000);
  record('项目级"用系统编辑器打开"：交给主进程（shell.openPath）的是项目 AGENTS.md 的路径', samePath(opened, projectFile),
    String(opened));
  await claudeEffective(ctx);
  await agentsSave(ctx);
}

/**
 * @brief agentDir 里还没有 AGENTS.md、有 CLAUDE.md（synthetic）时：警示色"<CLAUDE.md> is in effect now. After you save,
 *        this AGENTS.md is loaded instead."，可以用系统编辑器打开它。保存 AGENTS.md 之后（agentsSave）变成
 *        "In effect: …"，再删掉 CLAUDE.md。
 */
async function claudeEffective(ctx) {
  const { page, app } = ctx;
  ctx.claude = join(ctx.userData, 'pi', 'CLAUDE.md');
  const content = '# CLAUDE.md（synthetic）\n';
  writeFileSync(ctx.claude, content);
  await freshAgents(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-effective"]'), null, { timeout: 5000 })
    .catch(() => {});
  const state = await agentsState(page);
  await page.locator('.agents-line').getByRole('button', { name: 'Open in default app' }).click().catch(() => {});
  const opened = await until(async () => {
    const path = await app.evaluate(() => globalThis.__opened?.at(-1) ?? null);
    return samePath(path, ctx.claude) ? path : null;
  }, 3000);
  const expected = `${ctx.claude} is in effect now. After you save, this AGENTS.md is loaded instead.`;
  record('还没有 AGENTS.md、agentDir 里有 CLAUDE.md 时：警示色"现在生效的是 <CLAUDE.md>；保存后改读这里的 AGENTS.md，'
    + '它不再加载"，"用系统编辑器打开"打开 CLAUDE.md', state.warn === true
    && state.effective?.toLowerCase() === expected.toLowerCase() && samePath(opened, ctx.claude),
  JSON.stringify({ effective: state.effective, opened }));
  record('现在生效的是 CLAUDE.md 时，警示那一行后面单独一个 agents-tokens：CLAUDE.md 内容的 token 数（2026-10-26 补）',
    state.tokensAfter && state.tokens === tokenText(content) && !state.effective?.includes('token'),
  JSON.stringify({ tokens: state.tokens, after: state.tokensAfter, want: tokenText(content) }));
}

/** @brief 保存（按钮和 Ctrl+S）、生效的文件与它的"Open in default app"、"Discard changes"。 */
async function agentsSave(ctx) {
  const { page, app } = ctx;
  const editor = page.getByTestId('agents-editor');
  const first = `每次回答以“收到”开头。${MARKER}\n`;
  await editor.fill(first);
  const dirty = await agentsState(page);
  const saveButton = page.locator('.agents-user').getByRole('button', { name: 'Save', exact: true });
  const enabled = await saveButton.isEnabled();
  await watchStates(page, 'agents');
  await saveButton.click();
  await waitAgentsStatus(page, 'Saved · Applies to new sessions');
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-effective"]')?.textContent
    ?.startsWith('In effect: '), null, { timeout: 5000 }).catch(() => {});
  const saving = await seenStates(page);
  const saved = await agentsState(page);
  rmSync(ctx.claude ?? join(ctx.userData, 'pi', 'CLAUDE.md'), { force: true });
  record('有未保存的改动时"保存"可用、旁边"有未保存的改动"；保存时"保存中…"，保存后"已保存 · 新建的会话才会读到"，'
    + '"保存""撤销改动"又不可用，<agentDir>\\AGENTS.md 就是写的字', dirty.status === 'Unsaved changes' && enabled
    && dirty.revertDisabled === false && saving.some((item) => item.endsWith('|Saving…'))
    && saved.status === 'Saved · Applies to new sessions' && saved.saveDisabled === true
    && saved.revertDisabled === true
    && readText(userAgents(ctx)) === first, JSON.stringify({ dirty: dirty.status, saving, saved: saved.status }));
  record('走查 2：设置页标出生效的文件："生效中：<agentDir>\\AGENTS.md"（agentDir 里还有 CLAUDE.md 时也改读 AGENTS.md）',
    saved.warn === false && saved.effective?.startsWith('In effect: ')
    && samePath(saved.effective.slice('In effect: '.length), userAgents(ctx)),
  saved.effective ?? '');
  ctx.agentsSaved = `${first}第二行：用 Ctrl+S 保存。\n`;
  await editor.fill(ctx.agentsSaved);
  await editor.press('Control+s');
  await waitAgentsStatus(page, 'Saved · Applies to new sessions');
  record('Ctrl+S 也能保存', readText(userAgents(ctx)) === ctx.agentsSaved, oneLine(readText(userAgents(ctx)) ?? ''));
  await editor.fill(`${ctx.agentsSaved}还没保存的一行`);
  await page.locator('.agents-user').getByRole('button', { name: 'Discard changes' }).click();
  const reverted = await agentsState(page);
  record('撤销改动：编辑框回到读到的内容，"有未保存的改动"消失', reverted.editor === ctx.agentsSaved
    && reverted.status !== 'Unsaved changes', JSON.stringify({ status: reverted.status }));
  await page.locator('.agents-line').getByRole('button', { name: 'Open in default app' }).click();
  const lastOpened = () => app.evaluate(() => globalThis.__opened?.at(-1) ?? null);
  const opened = await until(async () => {
    const path = await lastOpened();
    return samePath(path, userAgents(ctx)) ? path : null;
  }, 3000);
  record('生效的文件那一行"用系统编辑器打开"：交给主进程的是 <agentDir>\\AGENTS.md', samePath(opened, userAgents(ctx)),
    String(opened));
  await shot(page, '6-agents');
}

/** @brief 走查 2：新会话的系统提示里有 AGENTS.md 写的标记；保存之前打开的会话没有。 */
async function agentsPrompt(ctx) {
  const { page } = ctx;
  await back(page);
  ctx.after = await ctrlN(page);
  const fresh = await sendIn(page, 'agents check');
  await rowOf(page, ctx.before).first().click();
  await waitReady(page);
  const old = await sendIn(page, 'agents check');
  record(`走查 2：保存后新建的会话，系统提示里有 AGENTS.md 写的标记（"系统提示里有 ${MARKER}"）`, fresh.fresh
    && fresh.text === `系统提示里有 ${MARKER}`, fresh.text);
  record('反例：保存之前就打开的会话不变（"系统提示里没有标记"）', old.fresh && old.text === '系统提示里没有标记', old.text);
}

/** @brief 把焦点放在 Customize 的分节"Instructions"上按 ↑（换到上一节 Plugins）。 */
async function arrowUp(ctx) {
  await ctx.page.locator('[data-testid="tools-nav"] button[data-section="agents"]').focus();
  await ctx.page.keyboard.press('ArrowUp');
}

/** 离开 Instructions 一节的入口（2026-10-26 起这一节在 Customize：换分节、Memory、Settings 都是离开） */
const LEAVE_TRIGGERS = {
  返回会话: (ctx) => ctx.page.getByRole('button', { name: 'Back to app', exact: true }).click(),
  点侧栏的会话: (ctx) => rowOf(ctx.page, ctx.s1).first().click(),
  设置: (ctx) => ctx.page.getByRole('button', { name: 'Settings', exact: true }).click(),
  记忆: (ctx) => ctx.page.getByTestId('nav-memory').click(),
  'Ctrl+N': (ctx) => ctx.page.keyboard.press('Control+n'),
  // Customize 顶部的"New session"（同 Ctrl+N；customize-agents-md.md"离开时有未保存的改动"，2026-10-26 补）。
  'Customize 的 New session': (ctx) => ctx.page.locator('[data-testid="tools-page"] .tools-notice .button',
    { hasText: 'New session' }).click(),
  // 2026-10-26 起左栏顶部没有"New session"，换成项目行的 +（docs/v0/screens/sessions.md"项目行的 +"）。
  '项目的 +': (ctx) => ctx.page.getByTestId('project-new-session').first().click(),
  打开文件夹: (ctx) => ctx.page.getByRole('button', { name: 'Open folder…' }).first().click(),
  换到另一节: (ctx) => ctx.page.locator('[data-testid="tools-nav"] button[data-section="skills"]').click(),
  '用 ↑ 换节': arrowUp,
};

/** @brief 此刻在哪一页：设置页、Customize（哪一节）、记忆页、会话页（会话面板个数、当前会话文件）。 */
const whereNow = (page) => page.evaluate(() => ({
  settings: Boolean(document.querySelector('[data-testid="settings-page"]')),
  tools: Boolean(document.querySelector('[data-testid="tools-page"]')),
  section: document.querySelector('[data-testid="tools-nav"] [aria-current="page"]')?.dataset.section ?? null,
  memory: Boolean(document.querySelector('[data-testid="memory-page"]')),
  panes: document.querySelectorAll('.pane-slot').length,
  active: document.querySelector('.session-item.active')?.dataset.file ?? null }));

/** @brief 选"Discard"之后应当到的地方。 */
function leftAsExpected(trigger, now, before, ctx) {
  switch (trigger) {
    case '返回会话': return !now.settings && !now.tools && now.panes === before.panes;
    case '点侧栏的会话': return !now.tools && samePath(now.active, ctx.s1);
    case '设置': return now.settings && !now.tools;
    case '记忆': return now.memory && !now.tools;
    case 'Ctrl+N': case 'Customize 的 New session': case '项目的 +': case '打开文件夹':
      return !now.tools && now.panes === before.panes + 1;
    case '换到另一节': return now.tools && now.section === 'skills';
    default: return now.tools && now.section === 'plugins';
  }
}

/**
 * @brief 让 AGENTS.md 一节有未保存的改动（不在这一节时先打开）。之前选过"Discard"时，先记下重新打开后编辑框是不是
 *        保存过的内容（草稿已丢弃）。
 */
async function makeDirty(ctx) {
  const { page } = ctx;
  if (!(await agentsState(page)).shown) {
    await openAgents(page);
    ctx.reopened.push((await agentsState(page)).editor === ctx.agentsSaved);
  }
  const state = await agentsState(page);
  if (state.status !== 'Unsaved changes') await page.getByTestId('agents-editor').fill(`${ctx.agentsSaved}未保存的草稿\n`);
  await page.getByTestId('agents-editor').focus();
}

/** @brief 一种离开的入口和一种回答：确认框的文字与焦点、回答之后留下或离开。 */
async function leaveCase(ctx, trigger, answer) {
  const { page } = ctx;
  await makeDirty(ctx);
  const before = await whereNow(page);
  await LEAVE_TRIGGERS[trigger](ctx);
  const dialog = await dialogState(page, 'leave-dialog').catch(() => null);
  if (!ctx.smallChecked.includes('离开确认框')) {
    await noteSmall(ctx, '离开确认框', '[data-testid="leave-dialog"]');
    await shot(page, '7-leave-dialog');
  }
  const shape = dialog?.title === LEAVE_TITLE && dialog.text === LEAVE_TEXT
    && dialog.buttons.join() === 'Discard,Keep editing' && dialog.focused === 'Keep editing';
  if (answer === 'Escape') await page.keyboard.press('Escape');
  else await page.getByTestId('leave-dialog').getByRole('button', { name: answer, exact: true }).click();
  await page.getByTestId('leave-dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  if (answer === 'Discard') {
    const now = await until(async () => {
      const state = await whereNow(page);
      return leftAsExpected(trigger, state, before, ctx) ? state : null;
    }, 15000);
    return { trigger, answer, shape, ok: Boolean(now) && readText(userAgents(ctx)) === ctx.agentsSaved, dialog };
  }
  await page.waitForFunction(() => document.activeElement === document.querySelector('[data-testid="agents-editor"]'),
    null, { timeout: 3000 }).catch(() => {});
  const state = await agentsState(page);
  const now = await whereNow(page);
  const ok = state.shown && state.focused && state.editor === `${ctx.agentsSaved}未保存的草稿\n`
    && now.panes === before.panes && now.tools && now.section === 'agents';
  return { trigger, answer, shape, ok, dialog, focused: state.focused };
}

/** @brief 离开时有未保存的改动：每个入口都先问；"Keep editing"（和 Esc）留下、焦点回到编辑框；"Discard"照常离开。 */
async function agentsLeave(ctx) {
  const { page } = ctx;
  ctx.reopened = [];
  // "Open folder…"的系统对话框已经换成直接返回测试项目（firstRun 里），放弃改动后在测试项目里新建会话。
  const stays = [['返回会话', 'Escape'], ['点侧栏的会话', 'Keep editing'], ['设置', 'Escape'], ['记忆', 'Keep editing'],
    ['Ctrl+N', 'Keep editing'], ['Customize 的 New session', 'Escape'], ['项目的 +', 'Keep editing'],
    ['打开文件夹', 'Escape'], ['换到另一节', 'Escape'], ['用 ↑ 换节', 'Keep editing']];
  const leaves = Object.keys(LEAVE_TRIGGERS).map((trigger) => [trigger, 'Discard']);
  const results = [];
  for (const [trigger, answer] of [...stays, ...leaves]) {
    try {
      results.push(await leaveCase(ctx, trigger, answer));
    } catch (error) {
      results.push({ trigger, answer, shape: false, ok: false, error: oneLine(error, 200) });
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  const brief = (list) => JSON.stringify(list.filter((item) => !item.shape || !item.ok)
    .map(({ trigger, answer, shape, ok, dialog, error }) => ({ trigger, answer, shape, ok, dialog, error })));
  const stayed = results.filter((item) => item.answer !== 'Discard');
  const left = results.filter((item) => item.answer === 'Discard');
  record('离开时有未保存的改动（返回会话、点侧栏的会话、Settings、Memory、Ctrl+N、Customize 的 New session、项目的 +、'
    + '打开文件夹、点 Customize 的另一节、在分节列表里按 ↑）：都先弹确认框"放弃对 AGENTS.md 的改动？""你改的内容还没有保存。"，'
    + '按钮"放弃改动""继续编辑"，焦点在"继续编辑"', results.length === 20 && results.every((item) => item.shape),
  brief(results));
  const fromNew = results.filter((item) => item.trigger === 'Customize 的 New session');
  record('有未保存的改动时点 Customize 顶部的"New session"（2026-10-26 补）：先问；Esc 留在 Instructions、改动还在、'
    + '焦点回到编辑框；"Discard"后新建会话、离开 Customize', fromNew.length === 2
    && fromNew.every((item) => item.shape && item.ok),
  JSON.stringify(fromNew.map(({ answer, shape, ok, error }) => ({ answer, shape, ok, error }))));
  record('选"继续编辑"或按 Esc：留在 Customize 的 Instructions，改动还在，焦点回到编辑框，没有新建会话',
    stayed.every((item) => item.ok), brief(stayed));
  record('选"放弃改动"：照常离开（回到会话 / 切到那个会话 / 设置页 / 记忆页 / 新建会话 / 打开文件夹新建会话 / '
    + 'Customize 的 Skills / Plugins），文件不变', left.every((item) => item.ok), brief(left));
  record('放弃改动之后重新打开 AGENTS.md：编辑框是保存过的内容（草稿已丢弃）', ctx.reopened.length >= 4
    && ctx.reopened.every(Boolean), JSON.stringify(ctx.reopened));
  await sameEntry(ctx);
  await dragOntoCustomize(ctx);
  await cancelledLeave(ctx);
  await archivedLeave(ctx);
}

/**
 * @brief 有未保存的改动时，已经在 Customize 上再点左栏"Customize"、点当前分节"Instructions"：都不问、什么都不变
 *        （customize-agents-md.md"位置""离开"）。
 */
async function sameEntry(ctx) {
  const { page } = ctx;
  await makeDirty(ctx);
  await page.getByTestId('nav-tools').click();
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await settle(page);
  const dialog = await page.getByTestId('leave-dialog').count();
  const state = await agentsState(page);
  const now = await whereNow(page);
  record('有未保存的改动时再点左栏"Customize"、点当前分节"Instructions"：不弹确认框，留在这一节，改动还在',
    dialog === 0 && now.tools && now.section === 'agents' && state.editor === `${ctx.agentsSaved}未保存的草稿\n`
    && state.status === 'Unsaved changes', JSON.stringify({ dialog, now, status: state.status }));
}

/** @brief 草稿还在时（旧的做法）撤销改动，免得后面的步骤一离开就弹确认框。 */
async function dropDraft(page) {
  if ((await agentsState(page)).status === 'Unsaved changes') {
    await page.locator('.agents-user').getByRole('button', { name: 'Discard changes' }).click();
  }
}

/**
 * @brief 选了"Discard"、离开却没有发生（"Open folder…"里取消了选择；系统对话框换成直接返回取消，synthetic）：
 *        留在 AGENTS.md，编辑框回到读到的内容，没有"Unsaved changes"，没有新会话。
 */
async function cancelledLeave(ctx) {
  const { page, app } = ctx;
  await makeDirty(ctx);
  const before = await whereNow(page);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: 'Open folder…' }).first().click();
  const dialog = await dialogState(page, 'leave-dialog').catch(() => null);
  await page.getByTestId('leave-dialog').getByRole('button', { name: 'Discard', exact: true }).click().catch(() => {});
  await page.getByTestId('leave-dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForFunction((want) => document.querySelector('[data-testid="agents-editor"]')?.value === want,
    ctx.agentsSaved, { timeout: 5000 }).catch(() => {});
  await settle(page);
  const state = await agentsState(page);
  const now = await whereNow(page);
  await stubFolder(app, ctx.project);
  record('放弃改动、离开却没有发生（"打开文件夹…"里取消了选择）：留在 AGENTS.md，编辑框回到读到的内容，'
    + '没有"有未保存的改动"，没有新会话', dialog?.title === LEAVE_TITLE && now.tools && now.section === 'agents'
    && now.panes === before.panes && state.editor === ctx.agentsSaved && state.status !== 'Unsaved changes',
  JSON.stringify({ dialog: dialog?.title ?? null, now, editor: oneLine(state.editor ?? '', 80),
    status: state.status }));
  await dropDraft(page);
}

/**
 * @brief 有未保存的改动时点"Archived"里的会话（M3：点它会恢复并打开）：先问；"Keep editing"什么都不变（不恢复，
 *        留在 AGENTS.md，改动还在）；"Discard"才恢复并打开它。用 agentsPrompt 里新建的会话（ctx.after）。
 */
async function archivedLeave(ctx) {
  const { page } = ctx;
  const archived = async () => (await archivedState(page)).rows.some((row) => samePath(row.file, ctx.after));
  const row = page.locator(`[data-testid="archived-list"] .session-item[data-file=${JSON.stringify(ctx.after)}]`);
  await chooseMenuItem(page, ctx.after, 'Archive');
  await expandArchived(page);
  await row.waitFor({ timeout: 10000 });
  await makeDirty(ctx);
  const answer = async (name) => {
    await row.click();
    const dialog = await dialogState(page, 'leave-dialog').catch(() => null);
    await page.getByTestId('leave-dialog').getByRole('button', { name, exact: true }).click().catch(() => {});
    await page.getByTestId('leave-dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await settle(page);
    return dialog;
  };
  const asked = await answer('Keep editing');
  const stay = { archived: await archived(), ...(await whereNow(page)), state: await agentsState(page) };
  record('有未保存的改动时点"已归档"里的会话：先问；选"继续编辑"什么都不变（会话仍在"已归档"里、没有恢复，'
    + '留在 AGENTS.md，改动还在，焦点回到编辑框）', asked?.title === LEAVE_TITLE && stay.archived && stay.tools
    && stay.state.editor === `${ctx.agentsSaved}未保存的草稿\n` && stay.state.focused,
  JSON.stringify({ asked: asked?.title ?? null, archived: stay.archived, tools: stay.tools,
    focused: stay.state.focused }));
  if (!stay.archived || !stay.tools) return dropDraft(page);
  await answer('Discard');
  const now = await until(async () => {
    const state = await whereNow(page);
    return !state.tools && samePath(state.active, ctx.after) ? state : null;
  }, 15000);
  record('选"放弃改动"：恢复并打开这个已归档的会话，AGENTS.md 不变', Boolean(now) && !(await archived())
    && readText(userAgents(ctx)) === ctx.agentsSaved, JSON.stringify(now));
}

/**
 * @brief 用鼠标把 source 真的拖到 target 中间（浏览器原生拖放，做法同 m5-helpers 的 dragWithHint），松开前读一次：
 *        有没有会话行在拖动中（变淡）、放下提示的文字（没有时为 null）。
 */
async function dragOver(page, source, target) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  const x = to.x + to.width / 2;
  const y = to.y + to.height / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 4, { steps: 3 });
  await page.mouse.move(x, y, { steps: 8 });
  await sleep(150);
  await page.mouse.move(x + 1, y + 1);
  await sleep(150);
  const during = await page.evaluate(() => ({ dragging: Boolean(document.querySelector('.session-item.dragging')),
    hint: document.querySelector('[data-testid="drop-hint"]')?.textContent ?? null }));
  await page.mouse.up();
  await sleep(300);
  return during;
}

/**
 * @brief 有未保存的改动时把会话拖到 Customize 上：中栏不是会话时不能放下（split.md），所以不离开、也不问，改动还在
 *        （同原来的设置页，customize-agents-md.md"离开"）。
 */
async function dragOntoCustomize(ctx) {
  const { page } = ctx;
  await makeDirty(ctx);
  const before = await whereNow(page);
  const during = await dragOver(page, rowOf(page, ctx.s1).first(), page.locator('.tools-content'));
  const dialog = await page.getByTestId('leave-dialog').count();
  const state = await agentsState(page);
  const now = await whereNow(page);
  record('有未保存的改动时把会话拖到 Customize 上：拖动开始了（会话行变淡），但这里不能放下（没有放下提示），松开后不离开、'
    + '不弹确认框，改动还在', during.dragging && during.hint === null && dialog === 0 && state.shown
    && state.editor === `${ctx.agentsSaved}未保存的草稿\n` && now.tools && now.panes === before.panes,
  JSON.stringify({ during, dialog, now }));
  await page.locator('.agents-user').getByRole('button', { name: 'Discard changes' }).click();
}

/** @brief agentDir 里有 AGENTS.override.md 时警示"… takes precedence, so what you write here has no effect."；之后删掉它。 */
async function agentsOverride(ctx) {
  const { page } = ctx;
  const override = join(ctx.userData, 'pi', 'AGENTS.override.md');
  const content = '# override（synthetic）\n';
  writeFileSync(override, content);
  await freshAgents(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-effective"]')
    ?.classList.contains('warn'), null, { timeout: 5000 }).catch(() => {});
  const state = await agentsState(page);
  await shot(page, '8-agents-override');
  await page.locator('.agents-line').getByRole('button', { name: 'Open in default app' }).click().catch(() => {});
  const opened = await until(async () => {
    const path = await ctx.app.evaluate(() => globalThis.__opened?.at(-1) ?? null);
    return samePath(path, override) ? path : null;
  }, 3000);
  rmSync(override, { force: true });
  const expected = `${override} takes precedence, so what you write here has no effect.`;
  record('agentDir 里有 AGENTS.override.md 时：警示色"生效的是 <它的路径>，这里写的不会生效"；"用系统编辑器打开"打开的是它',
    state.warn === true && state.effective?.toLowerCase() === expected.toLowerCase() && samePath(opened, override),
    JSON.stringify({ effective: state.effective, opened }));
  record('被 AGENTS.override.md 盖住时，警示那一行后面单独一个 agents-tokens：override 文件内容的 token 数（2026-10-26 补）',
    state.tokensAfter && state.tokens === tokenText(content) && !state.effective?.includes('token'),
  JSON.stringify({ tokens: state.tokens, after: state.tokensAfter, want: tokenText(content) }));
  await back(page);
}

/**
 * @brief 上次离开 Customize 时在 Instructions，再从左栏进入时落在第一节 Built-in tools（不记上次的分节）；保存失败
 *        （AGENTS.md.tmp 被一个文件夹占着）和读取失败（AGENTS.md 是一个文件夹）：显示原文；保存后的重新读取失败
 *        （rereadAfterSave，2026-10-26 补）。
 */
async function agentsFailures(ctx) {
  const { page } = ctx;
  const path = userAgents(ctx);
  await openAgents(page);
  await back(page);
  const landed = await enterCustomize(page);
  record('上次离开 Customize 时在 Instructions，再从左栏进入 Customize 时落在第一节 Built-in tools',
    landed?.current === 'builtin', JSON.stringify(landed));
  await openAgents(page);
  mkdirSync(`${path}.tmp`);
  const draft = `${ctx.agentsSaved}保存会失败的一行\n`;
  await page.getByTestId('agents-editor').fill(draft);
  await page.locator('.agents-user').getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agents-status')?.textContent
    ?.startsWith('Couldn’t save: '), null, { timeout: 10000 }).catch(() => {});
  const failed = await agentsState(page);
  rmSync(`${path}.tmp`, { recursive: true, force: true });
  record('保存失败（<agentDir>\\AGENTS.md.tmp 被一个文件夹占着）："保存失败："加原文，写的字留在编辑框里，文件不变',
    failed.status?.startsWith('Couldn’t save: ')
    && failed.status.length > 'Couldn’t save: '.length && failed.editor === draft
    && readText(path) === ctx.agentsSaved, failed.status ?? '');
  await page.locator('.agents-user').getByRole('button', { name: 'Discard changes' }).click();
  await firstReadFailure(ctx);
  await rereadAfterSave(ctx);
  await back(page);
}

/**
 * @brief 读取失败（<agentDir>\AGENTS.md 是一个文件夹，换到 Skills 再回来，第一次读就失败）：原文、没有编辑框，
 *        标题和第一行仍在（2026-10-26 补）；修好之后重新打开这一节：编辑框是文件的内容。
 */
async function firstReadFailure(ctx) {
  const { page } = ctx;
  const path = userAgents(ctx);
  renameSync(path, `${path}.bak`);
  mkdirSync(path);
  await page.locator('[data-testid="tools-nav"] button[data-section="skills"]').click();
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  const alert = page.locator('[data-testid="agents-section"] [role="alert"]');
  const text = await alert.innerText({ timeout: 10000 }).catch(() => null);
  const failed = await agentsState(page);
  rmSync(path, { recursive: true, force: true });
  renameSync(`${path}.bak`, path);
  record('读取失败（<agentDir>\\AGENTS.md 是一个文件夹）：显示"读取失败："加原文，没有编辑框', text?.startsWith('Couldn’t load AGENTS.md: ')
    && text.length > 'Couldn’t load AGENTS.md: '.length && failed.editor === null, text ?? '');
  record('读取失败时标题"Instructions"和紧跟它的第一行仍在（2026-10-26 补）', Boolean(text) && failed.heading
    === 'Instructions' && failed.intro === INTRO && failed.introFirst,
  JSON.stringify({ heading: failed.heading, intro: failed.intro, first: failed.introFirst }));
  await freshAgents(page);
  const fixed = await agentsState(page);
  record('修好之后重新打开这一节：编辑框里又是文件的内容', fixed.editor === ctx.agentsSaved, fixed.status ?? '');
}

/** @brief 当前用户（icacls 用；synthetic 的拒绝读取只加在测试自己的临时文件上）。 */
const currentUser = () => execFileSync('whoami', { encoding: 'utf8' }).trim();

/**
 * @brief 保存后的重新读取失败（customize-agents-md.md"重新读取失败"，2026-10-26 补）。测试准备（synthetic）：先放一个
 *        <agentDir>\AGENTS.md.tmp，用 icacls 拒绝当前用户读它的内容（RD）；保存时 Mori 写进它再改名，保存成功，之后的
 *        agents.get 读不了 AGENTS.md。顶部"Couldn’t load AGENTS.md: "加原文；编辑框是刚保存的内容；项目一栏读到过跟随的
 *        会话的列表，留着。之后删掉它、写回原来的内容，换到另一节再回来：读取成功，原文消失。
 */
async function rereadAfterSave(ctx) {
  const { page } = ctx;
  const path = userAgents(ctx);
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-loaded"] .agents-files li'), null,
    { timeout: 15000 }).catch(() => {});
  const before = await agentsState(page);
  const content = `${ctx.agentsSaved}保存后读不了的一行\n`;
  let after = null;
  try {
    writeFileSync(`${path}.tmp`, '');
    execFileSync('icacls', [`${path}.tmp`, '/deny', `${currentUser()}:(RD)`]);
    await page.getByTestId('agents-editor').fill(content);
    await page.locator('.agents-user').getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="agents-section"] > [role="alert"]'), null,
      { timeout: 10000 }).catch(() => {});
    after = await agentsState(page);
  } finally {
    rmSync(`${path}.tmp`, { force: true });
    rmSync(path, { force: true });
    writeFileSync(path, ctx.agentsSaved);
  }
  record('重新读取失败（保存成功、之后的 agents.get 读不了 AGENTS.md）：这一节顶部"Couldn’t load AGENTS.md: "加原文，'
    + '下面仍是编辑框和刚保存的内容；项目一栏读到过跟随的会话的列表，留着（标题与文件不变）', after?.alert?.startsWith(
    'Couldn’t load AGENTS.md: ') && after.alert.length > 'Couldn’t load AGENTS.md: '.length
    && after.editor === content && after.status === 'Saved · Applies to new sessions' && before.loadedFiles.length > 0
    && after.loadedTitle === before.loadedTitle && JSON.stringify(after.loadedFiles) === JSON.stringify(
    before.loadedFiles), JSON.stringify({ alert: after?.alert, status: after?.status, title: after?.loadedTitle,
    files: after?.loadedFiles }));
  await freshAgents(page);
  const fixed = await agentsState(page);
  record('重新读取失败后换到另一节再回来（文件已修好）：读取成功，顶部的原文消失，编辑框是文件的内容', fixed.alert === null
    && fixed.editor === ctx.agentsSaved, JSON.stringify({ alert: fixed.alert, status: fixed.status }));
}

/**
 * @brief 项目没有加载 AGENTS.md 或 CLAUDE.md 时，项目级一栏说明没有（另开一个没有这些文件的文件夹）；Customize 开着时在侧栏
 *        归档它跟随的这个会话（没有剩下的一栏）：项目一栏跟着换成没有会话的说明，编辑框里没保存的字还在。之后在分屏里
 *        换跟随的会话（followAnother，2026-10-26 补）。
 */
async function agentsNoProjectFile(ctx) {
  const { page, app } = ctx;
  const other = join(ctx.root, 'm6empty');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'README.md'), '# empty project (synthetic)\n');
  await clickOpenFolder(ctx, other);
  await waitReady(page);
  // 没有消息的会话不能归档（"No messages yet"），先发一条。
  await sendIn(page, 'which model');
  const emptyFile = await activeFile(page);
  await openAgents(page);
  const state = await agentsState(page);
  record('项目没有加载 AGENTS.md 或 CLAUDE.md 时：标题"m6empty 加载的文件"，说明"这个项目没有加载 AGENTS.md 或 CLAUDE.md"',
    state.loadedTitle === 'Files loaded by m6empty'
    && state.loadedText.includes('This project doesn’t load an AGENTS.md or CLAUDE.md')
    && state.loadedFiles.length === 0, JSON.stringify({ title: state.loadedTitle, files: state.loadedFiles }));
  const draft = `${ctx.agentsSaved}跟随的会话换了之后还在的草稿\n`;
  await page.getByTestId('agents-editor').fill(draft);
  await chooseMenuItem(page, emptyFile, 'Archive');
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-loaded"] h3')?.textContent
    === 'Files loaded by the project', null, { timeout: 10000 }).catch(() => {});
  const after = await agentsState(page);
  record('Customize 开着时在侧栏归档它跟随的会话（没有剩下的一栏）：Instructions 一节跟着换成"Files loaded by the project"'
    + '和"Open a session to see which files its project loads."，编辑框里没保存的字还在、仍是"Unsaved changes"',
  after.shown && after.loadedTitle === 'Files loaded by the project'
    && after.loadedText.includes('Open a session to see which files its project loads.') && after.editor === draft
    && after.status === 'Unsaved changes', JSON.stringify({ title: after.loadedTitle, status: after.status }));
  await dropDraft(page);
  // 归档后中栏没有会话：点侧栏的 S1 离开 Customize（不只是 Back to app），后面的步骤照常有会话面板。
  await leaveToS1(ctx);
  await followAnother(ctx, other);
  await stubFolder(app, ctx.project);
}

/** @brief 点侧栏的 S1 离开 Customize，等它的会话面板就绪。 */
async function leaveToS1(ctx) {
  await rowOf(ctx.page, ctx.s1).first().click();
  await ctx.page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(ctx.page);
}

/**
 * @brief 跟随的会话换了（customize-agents-md.md"用户级"与"项目加载的文件"，2026-10-26 补）：m6empty 的新会话与 S1 分屏，
 *        焦点在 m6empty 时开 Instructions 写草稿，在侧栏归档 m6empty：跟到剩下的 S1，带它重新读取。用户级 AGENTS.md 先写长
 *        （synthetic，前后两个会话的合计都超过 2,000），最后写回原来的内容。检查见 followChecks。
 */
async function followAnother(ctx, other) {
  const { page } = ctx;
  await clickOpenFolder(ctx, other);
  await waitReady(page);
  await sendIn(page, 'which model');
  const emptyFile = await activeFile(page);
  await chooseMenuItem(page, ctx.s1, 'Open in split view');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  await composerAt(page, 'left').click();
  const long = `${ctx.agentsSaved}${'word '.repeat(1700)}\n`;
  try {
    writeFileSync(userAgents(ctx), long);
    await openAgents(page);
    await page.waitForFunction(() => document.querySelector('[data-testid="agents-loaded"] h3')?.textContent
      === 'Files loaded by m6empty' && document.querySelector('[data-testid="agents-over"]'), null, { timeout: 10000 })
      .catch(() => {});
    const before = await agentsState(page);
    const draft = `${long}换到分屏另一栏之后还在的草稿\n`;
    await page.getByTestId('agents-editor').fill(draft);
    await watchAgents(page);
    await chooseMenuItem(page, emptyFile, 'Archive');
    await page.waitForFunction(() => document.querySelector('[data-testid="agents-loaded"] .agents-files li'), null,
      { timeout: 15000 }).catch(() => {});
    await settle(page);
    followChecks(ctx, { before, seen: await agentsSeen(page), after: await agentsState(page), draft });
    await dropDraft(page);
  } finally {
    writeFileSync(userAgents(ctx), ctx.agentsSaved);
  }
  await leaveToS1(ctx);
}

/**
 * @brief followAnother 的检查：跟到 S1 后项目一栏换成"Files loaded by m6proj"并列出项目的 AGENTS.md，草稿和
 *        "Unsaved changes"还在；换了会话、新的结果还没读到时是新标题和"Loading…"，没有一刻是新标题配上一个会话的文件列表，
 *        这时也不显示 agents-over（不拿上一个会话的合计提醒；读到之后又显示）。
 * @param states before：换之前（跟随 m6empty）的 agentsState；seen：watchAgents 记下的；after：读完之后；draft：草稿
 */
function followChecks(ctx, { before, seen, after, draft }) {
  const title = `Files loaded by ${basename(ctx.project)}`;
  const texts = seen.map((item) => item.loaded ?? '');
  const between = seen.filter((item) => item.loaded?.startsWith(title) && item.loaded.includes('Loading…'));
  record('跟随的会话换了（分屏里归档 Customize 跟随的 m6empty，跟到剩下的 S1）：带新的会话重新读取，项目一栏换成'
    + `"${title}"并列出 <m6proj>\\AGENTS.md；编辑框里没保存的字和"Unsaved changes"还在`, after.loadedTitle === title
    && after.loadedFiles.some((path) => samePath(path, join(ctx.project, 'AGENTS.md'))) && after.editor === draft
    && after.status === 'Unsaved changes', JSON.stringify({ title: after.loadedTitle, files: after.loadedFiles,
    status: after.status }));
  record(`换了会话、新的结果还没读到时：项目一栏是新标题"${title}"和"Loading…"；没有一刻是新标题配上一个会话`
    + '（m6empty）的文件列表', between.length > 0
    && !texts.some((text) => text.startsWith(title) && text.includes('This project doesn’t load')),
  JSON.stringify(texts.map((text) => oneLine(text, 120))));
  record('换了会话、新的结果还没读到时不显示 agents-over（synthetic：用户级 AGENTS.md 写长，前后两个会话的合计都超过 2,000；'
    + '换之前与读到之后都显示）', before.over === AGENTS_OVER && between.length > 0
    && between.every((item) => !item.over) && after.over === AGENTS_OVER,
  JSON.stringify({ before: before.over, between: between.map((item) => item.over), after: after.over }));
}

/** synthetic 项目扩展加载时先等的毫秒数：会话在这期间是"Starting…"（同 mem-app-page.mjs 的 writeSlowExtension） */
const SLOW_OPEN_MS = 10000;

/** @brief 测试准备（synthetic）：项目 m6slow：一个项目扩展的工厂函数先等 SLOW_OPEN_MS（什么都不注册），一个项目级 AGENTS.md。 */
function makeSlowProject(ctx) {
  const project = join(ctx.root, 'm6slow');
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'slow-open.ts'), [
    '// synthetic: written by tests/ui/m6-app-settings.mjs; loading waits so the session stays "Starting…".',
    'export default async function () {',
    `  await new Promise((done) => setTimeout(done, ${SLOW_OPEN_MS}));`,
    '}', ''].join('\n'));
  writeFileSync(join(project, 'AGENTS.md'), '# 慢项目（synthetic）\n');
  return project;
}

/**
 * @brief Customize 此刻：跟随的会话（顶部）、"New session"是否不可用（跟随的会话还在打开中时不可用）、内容区里 tools.get 的
 *        "Loading…"（.tools-empty[role=status]）、编辑框是否不可用、项目一栏的标题与文字。
 */
const openingState = (page) => page.evaluate(() => {
  const loaded = document.querySelector('[data-testid="agents-loaded"]');
  return { follow: document.querySelector('[data-testid="tools-follow"]')?.textContent ?? null,
    newDisabled: document.querySelector('.tools-notice .button')?.disabled ?? null,
    toolsLoading: document.querySelector('.tools-content .tools-empty[role="status"]')?.textContent ?? null,
    editorDisabled: document.querySelector('[data-testid="agents-editor"]')?.disabled ?? null,
    loadedTitle: loaded?.querySelector('h3')?.textContent ?? null, loadedText: loaded?.textContent ?? '' };
});

/**
 * @brief 跟随的会话还在打开中（m6slow 的项目扩展先等 10 秒；2026-10-26 补，customize-agents-md.md"和 tools.get 无关"
 *        "跟随的会话还在打开中"，v0 tools.md 外框"读取中 / 读取失败"）：Built-in tools 是 tools.get 的"Loading…"；
 *        Instructions 不等它：没有那个"Loading…"，编辑框可用，项目一栏"Files loaded by m6slow"和"Loading…"；打开好后
 *        列出 <m6slow>\AGENTS.md。最后发一条消息、归档这个会话（后面重启后台进程时不再等它打开），回到 S1。
 */
async function agentsSlowOpen(ctx) {
  const { page } = ctx;
  const slow = makeSlowProject(ctx);
  await clickOpenFolder(ctx, slow);
  const dialog = page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole('checkbox', { name: 'Remember my choice' }).check();
  await dialog.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await enterCustomize(page);
  const builtin = await openingState(page);
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await agentsReady(page);
  const agents = await openingState(page);
  const opening = (state) => state.newDisabled === true && state.follow?.startsWith('m6slow · ');
  record('跟随的会话还在打开中（m6slow，synthetic 扩展先等 10 秒）：Built-in tools 一节是 tools.get 的"Loading…"；换到 '
    + 'Instructions：这一节不等 tools.get，没有它的"Loading…"，编辑框可用', opening(builtin) && opening(agents)
    && builtin.toolsLoading === 'Loading…' && agents.toolsLoading === null && agents.editorDisabled === false,
  JSON.stringify({ builtin, agents: { ...agents, loadedText: undefined } }));
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-loaded"] .agents-files li'), null,
    { timeout: SLOW_OPEN_MS * 3 }).catch(() => {});
  const opened = await agentsState(page);
  record('跟随的会话还在打开中：Instructions 的项目一栏是标题"Files loaded by m6slow"和"Loading…"（不是"Open a session…"）；'
    + '会话打开好后重新读取，列出 <m6slow>\\AGENTS.md', opening(agents) && agents.loadedTitle === 'Files loaded by m6slow'
    && agents.loadedText.includes('Loading…') && !agents.loadedText.includes('Open a session')
    && opened.loadedFiles.some((path) => samePath(path, join(slow, 'AGENTS.md'))),
  JSON.stringify({ title: agents.loadedTitle, text: agents.loadedText, files: opened.loadedFiles }));
  await back(page);
  await sendIn(page, 'which model');
  await chooseMenuItem(page, await activeFile(page), 'Archive');
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  await stubFolder(ctx.app, ctx.project);
}

/** @brief Customize 顶部的"New session"可用（跟随的会话打开好了、后台进程在）。 */
const followReady = (page) => page.waitForFunction(() => document.querySelector('.tools-notice .button')
  ?.disabled === false, null, { timeout: 60000 }).catch(() => {});

/** @brief 后台进程退出的全局横幅（Customize 开着时在 .global-banner 里）。 */
const exitBanner = (page) => page.locator('.global-banner [data-testid="kernel-exit"]');

/** @brief 结束后台进程，等全局退出横幅出现、页面稳定。 */
async function killAndWait(ctx) {
  killKernel(ctx.app);
  await exitBanner(ctx.page).waitFor({ timeout: 15000 });
  await settle(ctx.page);
}

/** @brief 等 Instructions 一节的项目一栏列出文件（跟随的会话打开好、读到了它的列表）。 */
const waitListed = (page, timeout = 30000) => page.waitForFunction(() => document.querySelector(
  '[data-testid="agents-loaded"] .agents-files li'), null, { timeout }).catch(() => {});

/** @brief 页面上看得见的退出横幅（各自是否在 .global-banner 里）和 Instructions 一节里另加的横幅个数。 */
const exitBanners = (page) => page.evaluate(() => ({
  visible: [...document.querySelectorAll('[data-testid="kernel-exit"]')].filter((el) => el.checkVisibility())
    .map((el) => Boolean(el.closest('.global-banner'))),
  inSection: document.querySelectorAll('[data-testid="agents-section"] .banner, '
    + '[data-testid="agents-section"] [data-testid="kernel-exit"]').length }));

/**
 * @brief 后台进程退出与 Restart（customize-agents-md.md"后台进程退出时"与"读取失败"；2026-10-26 补了退出时不显示
 *        agents-over、只有全局横幅、Save 失败的原文、Restart 后读取成功的一路、退出后换节再回来的读取失败）。
 *        结束三次后台进程：（1）有草稿时退出、Save、Restart 后自己重新读取（exitWithDraft、restartKeepsDraft）；
 *        （2）退出后换节再回来读取失败、Restart 后自己重新读取（exitFirstRead）；（3）有草稿时退出、把 AGENTS.md 换成
 *        文件夹再 Restart：重新读取失败（exitRereadFailure，原有的检查）。
 */
async function agentsKernelExit(ctx) {
  await openAgents(ctx.page);
  await exitWithDraft(ctx);
  await exitFirstRead(ctx);
  await exitRereadFailure(ctx);
  await back(ctx.page);
}

/**
 * @brief 第一次：用户级 AGENTS.md 写长（synthetic，合计超过 2,000，退出前有 agents-over），写草稿后结束后台进程：
 *        不重新读取，项目一栏是退出的说明（不是"Loading…"），顶部没有读取失败，草稿还在；agents-over 不显示；只有
 *        全局退出横幅。这时点 Save：失败原文是后台进程退出，写的字留着。再改一次字后 Restart（restartKeepsDraft）。
 */
async function exitWithDraft(ctx) {
  const { page } = ctx;
  const long = `${ctx.agentsSaved}${'word '.repeat(1700)}\n`;
  writeFileSync(userAgents(ctx), long);
  await freshAgents(page);
  await waitListed(page);
  const before = await agentsState(page);
  const draft = `${long}后台进程退出时没保存的一行\n`;
  await page.getByTestId('agents-editor').fill(draft);
  await killAndWait(ctx);
  const exited = { ...(await agentsState(page)),
    alerts: await page.locator('[data-testid="agents-section"] [role="alert"]').count() };
  const banners = await exitBanners(page);
  record('后台进程退出时 Customize 开在 Instructions：不重新读取，项目一栏标题不变、下面是"Mori’s background process crashed. '
    + 'Restart it to continue."（不是"Loading…"），顶部没有读取失败，草稿和"Unsaved changes"还在',
  exited.loadedTitle === `Files loaded by ${basename(ctx.project)}` && exited.loadedText.includes(CRASHED)
    && !exited.loadedText.includes('Loading…') && exited.alerts === 0 && exited.editor === draft
    && exited.status === 'Unsaved changes', JSON.stringify({ title: exited.loadedTitle,
    loaded: oneLine(exited.loadedText, 160), alerts: exited.alerts, status: exited.status }));
  record('后台进程退出时不显示 agents-over（退出前合计超过 2,000 时有，synthetic：用户级 AGENTS.md 写长）；页面上只有'
    + '全局的退出横幅（.global-banner 里的 kernel-exit），这一节里不另加', before.over === AGENTS_OVER
    && exited.over === null && JSON.stringify(banners.visible) === '[true]' && banners.inSection === 0,
  JSON.stringify({ before: before.over, after: exited.over, banners }));
  await page.locator('.agents-user').getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agents-status')?.textContent?.startsWith('Couldn’t save: '),
    null, { timeout: 5000 }).catch(() => {});
  const saved = await agentsState(page);
  record('后台进程退出时 Save 照常可点，失败时"Couldn’t save: Mori’s background process crashed (exit code <n>)"，写的字留着',
    saved.status?.startsWith('Couldn’t save: ') && CRASH_ERROR.test(saved.status) && saved.editor === draft,
    saved.status ?? '');
  await page.getByTestId('agents-editor').fill(`${draft}再改一次\n`);
  await restartKeepsDraft(ctx, `${draft}再改一次\n`);
}

/**
 * @brief 记下此后每一次 DOM 变化时 Instructions 一节的样子：项目一栏的文字、编辑框、顶部的原文、有没有 agents-over、
 *        各会话面板的等待说明。
 */
const watchAgents = (page) => page.evaluate(() => {
  window.__agentsSeen = [];
  window.__agentsWatch?.disconnect();
  const snap = () => ({ loaded: document.querySelector('[data-testid="agents-loaded"]')?.textContent ?? null,
    editor: document.querySelector('[data-testid="agents-editor"]')?.value ?? null,
    alert: document.querySelector('[data-testid="agents-section"] > [role="alert"]')?.textContent ?? null,
    over: Boolean(document.querySelector('[data-testid="agents-over"]')),
    waits: [...document.querySelectorAll('[data-testid="not-ready"]')].map((el) => el.textContent) });
  window.__agentsWatch = new MutationObserver(() => {
    const value = snap();
    if (JSON.stringify(window.__agentsSeen.at(-1)) !== JSON.stringify(value)) window.__agentsSeen.push(value);
  });
  window.__agentsWatch.observe(document.body, { subtree: true, childList: true, characterData: true });
});

/** @brief 停下 watchAgents，返回记下的样子。 */
const agentsSeen = (page) => page.evaluate(() => {
  window.__agentsWatch?.disconnect();
  return window.__agentsSeen ?? [];
});

/**
 * @brief 第一次退出后 Restart、不换节：重新载入中（会话面板"Restarting…"）读到过的不重新读取（没有读取失败），项目一栏
 *        "Loading…"，没保存的字还在；连上后自己重新读取，没有读取失败，草稿和"Unsaved changes"还在，会话打开好后（带新的
 *        会话再读）项目一栏列出 <m6proj>\AGENTS.md。最后写回原来的 AGENTS.md、撤销草稿。
 */
async function restartKeepsDraft(ctx, draft) {
  const { page } = ctx;
  await watchAgents(page);
  await exitBanner(page).getByRole('button', { name: 'Restart' }).click();
  await followReady(page);
  await waitListed(page, 60000);
  await settle(page);
  const seen = await agentsSeen(page);
  const after = await agentsState(page);
  const reloading = seen.filter((item) => item.waits.includes('Restarting…'));
  record('Restart 之后、重新载入中（会话面板"Restarting…"）：读到过的不重新读取（没有读取失败），项目一栏"Loading…"'
    + '（不再是退出的说明），没保存的字还在', reloading.length > 0 && reloading.every((item) => item.alert === null
    && item.loaded?.includes('Loading…') && !item.loaded.includes(CRASHED) && item.editor === draft),
  JSON.stringify(reloading.slice(0, 3).map((item) => ({ ...item, editor: item.editor === draft,
    loaded: oneLine(item.loaded ?? '', 80) }))));
  record('Restart 连上后不换节就自己重新读取：没有读取失败，草稿和"Unsaved changes"还在，会话打开好后（带新的会话再读）'
    + '项目一栏列出 <m6proj>\\AGENTS.md', seen.every((item) => item.alert === null) && after.alert === null
    && after.editor === draft && after.status === 'Unsaved changes'
    && after.loadedFiles.some((path) => samePath(path, join(ctx.project, 'AGENTS.md'))),
  JSON.stringify({ alerts: seen.filter((item) => item.alert).length, status: after.status, files: after.loadedFiles }));
  writeFileSync(userAgents(ctx), ctx.agentsSaved);
  await dropDraft(page);
}

/**
 * @brief 第二次：没有草稿时结束后台进程，换到 Skills 再回 Instructions：这一节重新读取，按"读取失败"显示
 *        "Couldn’t load AGENTS.md: Mori’s background process crashed (exit code <n>)"、没有编辑框，标题和第一行仍在。
 *        再点 Restart、不换节：连上后自己重新读取，编辑框回来、是文件的内容，原文消失。
 */
async function exitFirstRead(ctx) {
  const { page } = ctx;
  await freshAgents(page);
  await waitListed(page);
  await killAndWait(ctx);
  await page.locator('[data-testid="tools-nav"] button[data-section="skills"]').click();
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-section"] > [role="alert"]'), null,
    { timeout: 10000 }).catch(() => {});
  const failed = await agentsState(page);
  record('后台进程退出后换到别的节再回来：这一节重新读取失败，"Couldn’t load AGENTS.md: Mori’s background process crashed '
    + '(exit code <n>)"，没有编辑框；标题和第一行仍在', failed.alert?.startsWith('Couldn’t load AGENTS.md: ')
    && CRASH_ERROR.test(failed.alert) && failed.editor === null && failed.heading === 'Instructions'
    && failed.intro === INTRO && failed.introFirst, JSON.stringify({ alert: failed.alert, editor: failed.editor }));
  await exitBanner(page).getByRole('button', { name: 'Restart' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-editor"]')?.disabled === false, null,
    { timeout: 60000 }).catch(() => {});
  await settle(page);
  const back = await agentsState(page);
  record('这次读取失败是后台进程退出造成的：点 Restart、不换节，连上后自己重新读取，编辑框回来、是文件的内容，原文消失',
    back.alert === null && back.editor === ctx.agentsSaved, JSON.stringify({ alert: back.alert, status: back.status }));
}

/**
 * @brief 第三次（原有的检查）：有草稿时结束后台进程，把 AGENTS.md 换成一个文件夹再点"Restart"：连上后重新读取失败，
 *        顶部"Couldn’t load AGENTS.md: "加原文，草稿和编辑框还在，项目一栏不显示（不是"Loading…"）。修好后换节再回来：
 *        编辑框是文件的内容，项目的 AGENTS.md 又列出来。
 */
async function exitRereadFailure(ctx) {
  const { page } = ctx;
  const path = userAgents(ctx);
  await waitListed(page);
  const draft = `${ctx.agentsSaved}后台进程退出时没保存的一行\n`;
  await page.getByTestId('agents-editor').fill(draft);
  await killAndWait(ctx);
  renameSync(path, `${path}.bak`);
  mkdirSync(path);
  const alert = page.locator('[data-testid="agents-section"] [role="alert"]');
  let failed = null;
  try {
    await exitBanner(page).getByRole('button', { name: 'Restart' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="agents-section"] [role="alert"]')
      ?.textContent?.startsWith('Couldn’t load AGENTS.md: '), null, { timeout: 60000 }).catch(() => {});
    await followReady(page);
    await settle(page);
    failed = { ...(await agentsState(page)), alert: await alert.innerText({ timeout: 3000 }).catch(() => null) };
  } finally {
    rmSync(path, { recursive: true, force: true });
    renameSync(`${path}.bak`, path);
  }
  record('Restart 后重新读取失败（<agentDir>\\AGENTS.md 是一个文件夹）：顶部"Couldn’t load AGENTS.md: "加原文，读到过的内容、'
    + '编辑框和草稿还在；没读到这个会话的项目文件，项目一栏不显示（不是"Loading…"）', failed.alert?.startsWith(
    'Couldn’t load AGENTS.md: ') && !failed.alert.includes('crashed') && failed.editor === draft
    && failed.status === 'Unsaved changes' && failed.loadedTitle === null && !failed.text.includes('Loading…'),
  JSON.stringify({ alert: oneLine(failed.alert ?? '', 160), title: failed.loadedTitle, status: failed.status }));
  await dropDraft(page);
  await freshAgents(page);
  await waitListed(page, 15000);
  const fixed = { ...(await agentsState(page)), alerts: await alert.count() };
  record('修好之后换到另一节再回来：没有读取失败，编辑框是文件的内容，项目一栏又列出项目的 AGENTS.md', fixed.alerts === 0
    && fixed.editor === ctx.agentsSaved && fixed.loadedFiles.some((file) => samePath(file, join(ctx.project,
    'AGENTS.md'))), JSON.stringify({ alerts: fixed.alerts, files: fixed.loadedFiles }));
}

/**
 * @brief settings.json 被手工改坏（synthetic）：Models 分节上方原文（带文件路径，同 v0）；提供商卡和模型行照常显示。
 *        修好后重新打开设置页，错误消失。
 */
async function brokenSettings(ctx) {
  const { page } = ctx;
  const path = settingsFile(ctx);
  const original = readText(path);
  writeFileSync(path, '{ "defaultThinkingLevel": ');
  let broken = null;
  try {
    await landSettings(page);
    await page.getByTestId('provider-card').first().waitFor({ timeout: 10000 }).catch(() => {});
    const error = await page.locator('.models-section .settings-error').first().innerText({ timeout: 3000 })
      .catch(() => null);
    await noteSmall(ctx, '设置页 settings.json 读不出', '.settings-page');
    broken = { error, cards: await page.getByTestId('provider-card').count(),
      rows: await modelRow(page, `${MAIN}/fake-coder`).count() };
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  } finally {
    writeFileSync(path, original);
  }
  record('settings.json 读不出：Models 分节上方原文（带 settings.json 的路径）；提供商卡和模型行照常显示',
    broken.error?.includes('settings.json') && broken.cards === 1 && broken.rows === 1,
    JSON.stringify({ error: oneLine(broken.error ?? '', 200), cards: broken.cards, rows: broken.rows }));
  await landSettings(page);
  await page.getByTestId('models-section').waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.models-section .settings-error'), null, { timeout: 10000 })
    .catch(() => {});
  const fixed = { errors: await page.locator('.models-section .settings-error').count(),
    rows: await modelRow(page, `${MAIN}/fake-coder`).count() };
  record('修好 settings.json 后重新打开设置页：没有错误，模型行照常', fixed.errors === 0 && fixed.rows === 1,
    JSON.stringify(fixed));
  await back(page);
}

// ---------- 步骤：窄栏 ----------

/**
 * @brief 会话面板宽度落在 models.md"窄栏"的哪一档（2026-10-21 起输入框下面一行按 .chat-pane 的宽度分档：680 / 600 / 460 /
 *        400 / 340px；原来的 760 / 720px 两档和范围按钮 160 / 120px 的上限去掉了）。
 */
const bucketOf = (width) => (width > 680 ? '宽' : width > 600 ? '较窄' : width > 460 ? '窄' : width > 400 ? '更窄'
  : width > 340 ? '很窄' : '最窄');
/** 每一档要量的会话面板宽度和右栏开关（fitPane 改窗口宽度凑出；800 宽右栏打开时最窄约 300px） */
const NARROW_SAMPLES = [[930, false], [740, true], [640, true], [520, true], [430, true], [370, true], [300, true]];
/** 每一档该收起的（models.md"窄栏"的状态表） */
const BUCKET_TEXT = { 宽: '"Effort: <强度> ▾"', 较窄: 'Effort 只显示强度', 窄: '"Send"只有图标',
  更窄: '三个按钮去掉 ▾', 很窄: '三个按钮去掉 ▾', 最窄: '三个按钮去掉 ▾、范围按钮最窄 36px' };

/** @brief 把会话面板调到 width 宽（右栏开或关），返回这一刻这一行的样子和范围、Effort 菜单的位置。 */
async function narrowSample(ctx, width, right) {
  const { page } = ctx;
  await fitPane(ctx, width, { right });
  const state = await rowState(page);
  const inside = { model: await menuInside(page, 'model-button'), thinking: await menuInside(page, 'thinking-button') };
  return { target: width, right, bucket: bucketOf(state.pane), ...state, inside };
}

/** @brief 样本里 Effort 按钮应有的强度文字（不支持思考时"Unavailable"）。 */
const labelOf = (sample) => (sample.reasoning === 'true' ? LEVEL_TEXT[sample.level] : 'Unavailable');

/** @brief 一个样本不符合它那一档（models.md"窄栏"）的地方（读屏名称另查）；都符合时为空。 */
function narrowProblems(sample) {
  const w = sample.pane;
  const problems = [];
  if (!sample.model || !sample.thinking || !sample.usage) problems.push('范围、Effort 按钮或圆环没有显示');
  if (sample.inTopbar.length) problems.push(`顶栏里还有 ${sample.inTopbar.join()}`);
  if (sample.thinkingText !== `Effort: ${labelOf(sample)}` || sample.prefix !== (w > 680)) {
    problems.push(`Effort 按钮文字 ${sample.thinkingText}，前缀看得见 ${sample.prefix}`);
  }
  if (sample.modelWidth > 200.5 || sample.modelWidth < (w > 340 ? 40 : 36) - 0.5) {
    problems.push(`范围按钮宽度 ${sample.modelWidth}`);
  }
  // 范围是模型 fake-coder（只有 .range-model 一段）：宽于 680px 时有空余，按钮按全文算宽、不截短
  if (w > 680 && (!sample.rangeModel || sample.rangeModel.width < sample.rangeModel.full - 0.01 || sample.scope)) {
    problems.push(`范围按钮的字 ${JSON.stringify({ scope: sample.scope, model: sample.rangeModel })}`);
  }
  const arrows = w > 460 ? 1 : 0;
  if (sample.modelIcons !== arrows || sample.thinkingIcons !== arrows) problems.push('▾');
  if (sample.permissionText !== 'Ask each time' || sample.permissionIcons !== arrows) {
    problems.push(`权限按钮 "${sample.permissionText}"、${sample.permissionIcons} 个图标`);
  }
  if (!sample.inside.model?.inside || !sample.inside.thinking?.inside) {
    problems.push(`菜单位置 ${JSON.stringify(sample.inside)}`);
  }
  return problems;
}

/**
 * @brief models.md"窄栏"：单栏时改窗口宽度和右栏开关，让会话面板落在输入框下面一行的每一档（> 680、≤ 680、≤ 600、≤ 460、
 *        ≤ 400、≤ 340），每档范围、Effort 按钮和圆环都在、能点开，菜单往上打开、在面板里（models.md"菜单的位置与键盘"）；
 *        Effort 按钮 ≤ 680px 时只显示强度（textContent 仍是"Effort: <强度>"）；≤ 460px 时去掉 ▾；权限按钮只有文字；范围按钮
 *        任何宽度最长 200px。各档的边界（681 / 680px 等）和截短的先后在 m6-app-slash.mjs。最后恢复会话面板 930px、右栏关。
 */
async function narrowRow(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  const samples = [];
  for (const [width, right] of NARROW_SAMPLES) samples.push(await narrowSample(ctx, width, right));
  await shot(page, '10-narrow-row');
  await fitPane(ctx, 930, { right: false });
  for (const bucket of Object.keys(BUCKET_TEXT)) {
    const hit = samples.filter((sample) => sample.bucket === bucket);
    const bad = hit.map((sample) => ({ target: sample.target, right: sample.right, pane: sample.pane,
      problems: narrowProblems(sample) })).filter((item) => item.problems.length);
    record(`窄栏"${bucket}"：输入框下面一行的范围、Effort 按钮和圆环都在、能点开，${BUCKET_TEXT[bucket]}；权限按钮只有文字；`
      + '范围按钮最长 200px；菜单往上打开、不伸出会话面板', hit.length > 0 && bad.length === 0, JSON.stringify(bad.length
      ? bad : hit.map((sample) => ({ pane: sample.pane, text: sample.thinkingText, model: sample.modelWidth }))));
  }
  const names = samples.map((sample) => ({ pane: sample.pane, name: sample.thinkingName,
    want: `Effort: ${labelOf(sample)}` }));
  record('窄栏各档 Effort 按钮的读屏名称都是完整的"Effort: <强度>"（收起的文字在读屏名称里）',
    names.every((item) => item.name === item.want), JSON.stringify(names));
}

// ---------- 步骤：重启与收尾 ----------

/** @brief 重新打开的会话：pi 按会话记录恢复思考强度（关掉前在 S1 切到了"Low"，它的默认是"High"）。 */
async function reopen(ctx) {
  await closeWithDraft(ctx);
  await startApp(ctx);
  const { page } = ctx;
  await page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await rowOf(page, ctx.s1).first().waitFor({ timeout: 30000 });
  await noSession(ctx);
  await agentsOpening(ctx);
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  await paneOf(page).getByTestId('thinking-button').waitFor({ timeout: 15000 });
  const thinking = await buttonState(page, 'thinking-button');
  const model = await buttonState(page, 'model-button');
  record('重启后重新打开会话：按会话记录恢复思考强度（关掉 Mori 前切到"低"，不是这个模型的默认"高"），模型仍是 fake-coder',
    thinking.level === 'low' && thinking.text === 'Effort: Low' && model.text === 'fake-coder',
    JSON.stringify({ thinking, model: model.text }));
  const reply = await sendIn(page, 'which model');
  record('重启后会话照常能用（key 从 credentials.json 读入），回复来自 fake-coder', reply.fresh
    && reply.text === '模型：fake-coder', JSON.stringify({ text: reply.text,
    errors: reply.newErrors.map((text) => oneLine(text, 160)) }));
}

/**
 * @brief AGENTS.md 有未保存的改动时关闭 Mori 窗口（主进程里关窗口，同点右上角的关闭）：不问；2026-10-26 起窗口藏进托盘
 *        （docs/v0/screens/window.md），Mori 不退出，回到窗口时改动还在。再从托盘菜单"Exit"退出（没有会话在生成）：
 *        也不问，直接退出，AGENTS.md 不变（settings.md"关闭 Mori 窗口时不问"）。确认框换成按"Cancel"回答：
 *        弹了确认框 Mori 就不会退出，这时读出确认框，再用 Playwright 的 close 收尾。
 */
async function closeWithDraft(ctx) {
  const { page } = ctx;
  await openAgents(page);
  const draft = `${ctx.agentsSaved}关窗口前没保存的一行\n`;
  await page.getByTestId('agents-editor').fill(draft);
  const status = (await agentsState(page)).status;
  await recordBalloons(ctx.app);
  await closeWindow(ctx.app);
  await sleep(1000);
  const hidden = await windowState(ctx.app);
  const leaveAsked = await page.evaluate(() => Boolean(document.querySelector('[data-testid="leave-dialog"]')));
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
  const shown = await waitWindow(ctx.app, (state) => state.visible, 5000);
  const back = await agentsState(page);
  record('AGENTS.md 有未保存的改动时关闭 Mori 窗口：不问，窗口藏进托盘（Mori 不退出），回到窗口时改动还在',
    status === 'Unsaved changes' && hidden?.visible === false && !leaveAsked && shown.ok && back.editor === draft
    && back.status === 'Unsaved changes',
    JSON.stringify({ status, hidden, leaveAsked, shown: shown.state, back: back.status }));
  await stubMessageBox(ctx.app, 1);
  const exited = await exitFromTray(ctx.app);
  const boxes = exited ? [] : await messageBoxes(ctx.app).catch((error) => `cannot read: ${oneLine(error)}`);
  if (!exited) await ctx.app.close().catch(() => {});
  record('有未保存的改动时从托盘菜单"Exit"退出（没有会话在生成）：不问，直接退出；AGENTS.md 不变',
    exited && readText(userAgents(ctx)) === ctx.agentsSaved, JSON.stringify({ exited, boxes }));
}

/**
 * @brief 重启后还没有打开会话时：Customize 只有 Skills、Plugins、Instructions，落在第一节 Skills；Instructions 的项目级说明
 *        "Open a session to see…"。重启后自动打开了会话时记为失败（没有覆盖）。
 */
async function noSession(ctx) {
  const { page } = ctx;
  const panes = await page.locator('.pane-slot').count();
  if (panes > 0) {
    record('没有打开的会话时：项目级一栏"打开一个会话后，这里列出它的项目加载了哪些文件。"', false,
      `${panes} pane(s) open after restart; this state cannot be reached here`);
    return;
  }
  const nav = await enterCustomize(page);
  await openAgents(page);
  const state = await agentsState(page);
  record('没有打开的会话时（重启后还没点开会话）：Customize 的分节 Skills、Plugins、Instructions，落在 Skills；'
    + 'Instructions 的项目级一栏"打开一个会话后，这里列出它的项目加载了哪些文件。"', nav?.current === 'skills'
    && nav.sections.join() === 'skills:Skills,plugins:Plugins,agents:Instructions'
    && state.loadedText.includes('Open a session to see which files its project loads.')
    && state.loadedFiles.length === 0,
  JSON.stringify({ nav, loaded: oneLine(state.loadedText, 200) }));
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 5000 });
}

/**
 * @brief 会话还在打开中时进入 Customize（点侧栏的会话、马上点"Customize"再点"Instructions"；重启后从磁盘打开要一会儿）：
 *        Instructions 一节跟随它，
 *        不说"没有会话"，等它打开好后列出项目的 AGENTS.md。赶上打开中时项目一栏先是"Loading…"（细节里写明有没有赶上）。
 */
async function agentsOpening(ctx) {
  const { page } = ctx;
  await page.evaluate(() => {
    window.__agentsLoaded = [];
    window.__agentsObserver = new MutationObserver(() => {
      const text = document.querySelector('[data-testid="agents-loaded"]')?.textContent ?? null;
      if (text !== null && window.__agentsLoaded.at(-1) !== text) window.__agentsLoaded.push(text);
    });
    window.__agentsObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await rowOf(page, ctx.s1).first().click();
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-loaded"] .agents-files li'), null,
    { timeout: 30000 }).catch(() => {});
  const seen = await page.evaluate(() => {
    window.__agentsObserver.disconnect();
    return window.__agentsLoaded;
  });
  const state = await agentsState(page);
  const caught = seen.some((text) => text.includes('Loading…'));
  record('会话还在打开中时进入 Customize：Instructions 一节跟随它，不显示"Open a session…"，打开好后列出'
    + `"Files loaded by m6proj"和项目的 AGENTS.md（${caught ? '赶上了打开中：先是"Loading…"' : '没赶上打开中'}）`,
  state.loadedTitle === `Files loaded by ${basename(ctx.project)}`
    && state.loadedFiles.some((path) => samePath(path, join(ctx.project, 'AGENTS.md')))
    && !seen.some((text) => text.includes('Open a session')), JSON.stringify({ seen, title: state.loadedTitle }));
}

/** @brief 新加的界面（设置页、表单、确认框、输入框下面一行的范围与 Effort 菜单）没有小于 12px 的字。 */
async function fontSizes(ctx) {
  record(`新加的界面没有小于 12px 的文字（看过：${[...new Set(ctx.smallChecked)].join('、')}）`, ctx.small.length === 0,
    ctx.small.slice(0, 6).join('; '));
}

const steps = { firstRun, settingsList, thinkingUnsupported, markReasoning, thinkingLevels, unmarkReasoning, agentsUser,
  agentsPrompt, agentsLeave, agentsOverride, agentsFailures, agentsNoProjectFile, agentsSlowOpen, agentsKernelExit,
  brokenSettings, narrowRow, reopen, fontSizes };

const fake = await startFakeEndpoint(port, testKey);
const { root, project } = makeProject();
const userData = mkdtempSync(join(tmpdir(), 'mori-m6-settings-data-'));
const ctx = { userData, root, project, pageErrors: [], small: [], smallChecked: [] };
await startApp(ctx);
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && name !== 'firstRun' && !only.includes(name)) continue;
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
}
console.log(`[m6-app-settings] project in ${project}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`m6-app-settings${suffix}.json`) ? 0 : 1;
