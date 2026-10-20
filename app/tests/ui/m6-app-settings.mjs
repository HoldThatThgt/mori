// M6 整机测试（设置页、顶栏的模型与思考强度）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint，synthetic），覆盖 docs/v0/screens/settings.md、models.md 和方案第 7 节 M6 走查 1、2、8 与反例：
// 首次启动的"支持思考"（不勾时没有思考强度）、models.json 不含 key、credentials.json 只有密文；设置页的分节、连接卡、模型行、
// "默认"；添加模型（没有 key 框、不改 credentials.json、ID 重复）；设为默认（已经打开的会话不变、新会话用它）；
// 每行测试与取消；添加第二个连接；顶栏模型菜单（按连接分组、打勾、默认、管理模型…）、换模型后回复来自新模型、生成中不能切换、
// 不改默认；401 时"去设置"（打开那个连接的"编辑连接"，焦点在 API key）；编辑连接改了地址的 origin 又没填 key 时的原文；
// 删除（确认框、默认和唯一的模型不能删、删掉连接的最后一个模型时连接和 key 一起删除、正在用它的会话标"已删除"）；
// 编辑模型标"支持思考"和新会话默认强度（models.json、settings.json 的 modelThinkingLevels）、打开着的会话随之可选、
// "高"有思考内容、"关"没有、新会话用按模型的默认强度、重启后恢复会话的强度；用户级 AGENTS.md（空状态、保存与 Ctrl+S、
// 撤销改动、生效的文件、AGENTS.override.md 的警示、新会话的系统提示里有、之前打开的会话没有、离开时有未保存改动的确认框）、
// 项目级列表与用系统编辑器打开；新页面没有小于 12px 的字；页面没有报错。
// 复查补上：落在"连接与模型"、Tab 换分节、卡上"编辑连接"（N 个模型）与取消、添加连接取消、每行测试失败、"没有 key"、
// 菜单只列有 key 的模型、点外面关闭、切换中（MutationObserver 抓中间状态）、换模型后思考强度按返回值更新、
// "保存中…""正在读取…"、后台进程保存失败的原文、默认模型已经不在时新模型成为默认、settings.json 读不出、
// models.json 里有 // 注释、编辑连接写文件失败时 key 撤回（重启后验证）、生效的是 CLAUDE.md、取消选文件夹时放弃改动、
// 点已归档的会话时继续编辑不恢复、关闭窗口时不问。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-settings.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m6-app-settings(-packaged).json，截图在 test-results/m6-app-settings(-packaged)/。
// 用系统编辑器打开：经 app.evaluate 换掉主进程的 shell.openPath，只记下路径（不真的打开程序，与 m4-app.mjs 相同）。
// 合成端点只接受一个 key（FAKE_REQUIRE_KEY）；第二个连接填一个它不接受的 key，用来制造 401。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, archivedState, chooseMenuItem, clickOpenFolder, ctrlN, expandArchived, PANE, paneOf, rowOf, settle,
  stubFolder, until, waitIdle, waitReady, waitRunning,
} from './m3-helpers.mjs';
import {
  connectionCard, menuGone, menuInside, modelRow, seenStates, startFakeEndpoint, topbarState, watchStates,
} from './m6-helpers.mjs';
import { pageHelpers } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const port = 4361;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key 和一个它不接受的 key：都只是测试值（synthetic），与任何真实服务无关。
const testKey = 'synthetic-test-key-m6-settings-not-real';
const wrongKey = 'synthetic-wrong-key-m6-settings-not-real';
const shots = join(appRoot, `test-results/m6-app-settings${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/**
 * Mori 的第一个连接（provider id）。第二个连接的 id 在添加之后从列表里读出，记在 ctx.second：
 * 后台进程给新连接的 id 是 mori-endpoint-<N>（settings.md：之后的连接用毫秒时间戳，删掉的 id 不再用）。
 */
const MAIN = 'mori-endpoint';
/** 手写进 models.json、credentials.json 里没有它的 key 的 Mori 连接（synthetic） */
const KEYLESS = 'mori-endpoint-3';
/** 写进用户级 AGENTS.md 的标记：合成端点的 "agents check" 在系统提示里找它 */
const MARKER = `MORI-AGENTS-${Date.now().toString(36).toUpperCase()}`;
/** 离开有未保存改动的 AGENTS.md 时确认框的标题和说明 */
const LEAVE_TITLE = '放弃对 AGENTS.md 的改动？';
const LEAVE_TEXT = '你改的内容还没有保存。';
/** 保存连接或模型之后列表上方的一行 */
const SAVED_NOTICE = '已保存 · 已经打开的会话下一条消息起用新的设置';

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
/** @brief pi 的 models.json、settings.json（不存在时为空对象）。 */
const modelsJson = (ctx) => JSON.parse(readText(join(ctx.userData, 'pi', 'models.json')) ?? '{}');
const settingsJson = (ctx) => JSON.parse(readText(join(ctx.userData, 'pi', 'settings.json')) ?? '{}');
/** @brief pi 的 models.json、settings.json 的路径。 */
const modelsFile = (ctx) => join(ctx.userData, 'pi', 'models.json');
const settingsFile = (ctx) => join(ctx.userData, 'pi', 'settings.json');
/** @brief 写一个 JSON 文件（两个空格缩进，末尾换行；模拟手工改文件）。 */
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
/** @brief 用户级 AGENTS.md 的路径。 */
const userAgents = (ctx) => join(ctx.userData, 'pi', 'AGENTS.md');

/**
 * @brief credentials.json：原文、有哪些 provider、值是不是都是 base64、原文或解开 base64 之后有没有测试 key 的明文。
 *        只检查测试自己生成的合成 key（synthetic），不读取也不打印任何真实 key。
 */
function credentialsState(ctx) {
  const text = readText(join(ctx.userData, 'credentials.json'));
  if (text === null) return { text: null, providers: [], base64: false, plain: false };
  const keys = JSON.parse(text);
  const values = Object.values(keys).map(String);
  const hasPlain = (value) => [testKey, wrongKey].some((key) => value.includes(key));
  return { text, providers: Object.keys(keys), base64: values.every((value) => /^[A-Za-z0-9+/]+=*$/.test(value)),
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

/** @brief 在设置页里点分节按钮切到 section，等这一节读好。 */
async function openSection(page, section) {
  await page.locator(`[data-testid="settings-nav"] button[data-section="${section}"]`).click();
  if (section === 'agents') {
    await page.waitForFunction(() => document.querySelector('[data-testid="agents-editor"]')?.disabled === false, null,
      { timeout: 15000 });
  } else {
    await page.locator('[data-testid="connection-card"]').first().waitFor({ timeout: 15000 });
  }
}

/** @brief 只点左栏"设置"、不点分节，返回设置页出现时落在哪一节（currentSection）。 */
async function landSettings(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  return currentSection(page);
}

/** @brief 打开设置页（左栏"设置"），切到 section，等这一节读好。 */
async function openSettings(page, section = 'connections') {
  await landSettings(page);
  await openSection(page, section);
}

/** @brief 设置页"返回会话"，等会话面板就绪。 */
async function back(page) {
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
}

/** @brief 设置页当前的分节（aria-current）和显示的内容。 */
const currentSection = (page) => page.evaluate(() => ({
  nav: document.querySelector('[data-testid="settings-nav"] [aria-current="page"]')?.dataset.section ?? null,
  body: document.querySelector('.settings-body .settings-section')?.dataset.section ?? null }));

/** @brief "连接与模型"列表：每张连接卡和其中每个模型行（ID、默认、说明、按钮、测试结果）。 */
function listState(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="connection-card"]')].map((card) => ({
    provider: card.dataset.provider, name: card.querySelector('.connection-name')?.textContent ?? '',
    meta: card.querySelector('.connection-meta')?.textContent ?? '',
    key: card.querySelector('.connection-key')?.textContent ?? '',
    models: [...card.querySelectorAll('[data-testid="model-row"]')].map((row) => ({
      ref: row.dataset.model, id: row.querySelector('.model-id')?.textContent ?? '',
      isDefault: row.dataset.default === 'true', badge: row.querySelector('.default-badge')?.textContent ?? null,
      meta: row.querySelector('.model-meta')?.textContent ?? '',
      buttons: Object.fromEntries([...row.querySelectorAll('.model-actions button')].map((button) => [
        button.textContent.trim(), { disabled: button.disabled, title: button.title }])),
      test: row.querySelector('[data-testid="model-test"]')?.textContent ?? null })) })));
}

/** @brief 列表里的一个模型行（provider/id）；没有时为 undefined。 */
const rowIn = (list, ref) => list.flatMap((card) => card.models).find((row) => row.ref === ref);
/** @brief 列表上方的一行。 */
const noticeText = (page) => page.getByTestId('settings-notice').innerText({ timeout: 5000 }).catch(() => null);

/** @brief 设置页里一张表单（connection-form / model-form）的标题、说明、字段和状态。 */
function formState(page, testId) {
  return page.evaluate((id) => {
    const form = document.querySelector(`[data-testid="${id}"]`);
    if (!form) return null;
    const panel = form.closest('.settings-form');
    const select = form.querySelector('.thinking-level select');
    const ownText = (label) => [...label.childNodes].filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim()).join('');
    return { title: panel?.querySelector('h3')?.textContent ?? null,
      hint: panel?.querySelector(':scope > .field-hint')?.textContent ?? null,
      fields: [...form.querySelectorAll('label')].map(ownText).filter(Boolean),
      passwords: form.querySelectorAll('input[type="password"]').length,
      keyPlaceholder: form.querySelector('input[type="password"]')?.placeholder ?? null,
      idReadOnly: form.querySelector('input')?.readOnly ?? null,
      idHint: form.querySelector('.field-indent')?.textContent ?? null,
      reasoning: form.querySelector('.thinking-fields input[type="checkbox"]')?.checked ?? null,
      level: select ? { value: select.value, options: [...select.options].map((option) => option.textContent) } : null,
      message: form.querySelector('[data-testid="form-message"]')?.textContent ?? null };
  }, testId);
}

/** @brief 填添加 / 编辑模型的表单；不传的字段不动。 */
async function fillModelForm(page, { modelId, reasoning, level }) {
  const form = page.getByTestId('model-form');
  if (modelId !== undefined) await form.locator('input').first().fill(modelId);
  if (reasoning !== undefined) await form.locator('.thinking-fields input[type="checkbox"]').setChecked(reasoning);
  if (level !== undefined) await form.locator('.thinking-level select').selectOption(level);
}

/** @brief 保存模型表单：成功时回到列表，返回 null；失败时留在表单里，返回表单下方的文字。 */
async function saveModelForm(page) {
  await page.getByTestId('model-form').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="model-form"]')
    || document.querySelector('[data-testid="model-form"] [data-testid="form-message"]'), null, { timeout: 15000 });
  if (!(await page.getByTestId('model-form').count())) return null;
  return page.getByTestId('model-form').getByTestId('form-message').innerText();
}

/** @brief 在连接卡上"添加模型"，填 ID 保存；返回 saveModelForm 的结果。 */
async function addModel(page, provider, modelId) {
  await connectionCard(page, provider).getByRole('button', { name: '添加模型' }).click();
  await page.getByTestId('model-form').waitFor({ timeout: 5000 });
  await fillModelForm(page, { modelId });
  return saveModelForm(page);
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

/**
 * @brief 当前一栏顶栏的模型或思考按钮（model-button / thinking-button）：文字、悬停说明、是否不可用、切换中、
 *        data-level、data-reasoning、有没有 ▾ 图标、文字颜色（"变淡"用）。
 */
const buttonState = (page, testId) => paneOf(page).getByTestId(testId).evaluate((button) => ({
  text: button.textContent, title: button.title, disabled: button.disabled,
  pending: button.getAttribute('aria-disabled') === 'true', level: button.dataset.level ?? null,
  reasoning: button.dataset.reasoning ?? null, icon: Boolean(button.querySelector('svg')),
  color: getComputedStyle(button).color }), null, { timeout: 10000 });

/** @brief 打开当前一栏的模型菜单，读出分组、各项（打勾、默认）、说明、最后的操作和焦点所在的项。 */
async function openModelMenu(page) {
  await paneOf(page).getByTestId('model-button').click();
  const menu = page.getByTestId('model-menu');
  await menu.waitFor({ timeout: 5000 });
  return menu.evaluate((element) => ({
    groups: [...element.querySelectorAll('[role="group"]')].map((group) => ({ name: group.getAttribute('aria-label'),
      items: [...group.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ ref: item.dataset.model,
        checked: item.getAttribute('aria-checked') === 'true',
        tag: item.querySelector('.model-default')?.textContent ?? null })) })),
    note: element.querySelector('.menu-note')?.textContent ?? '',
    actions: [...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    focused: document.activeElement?.dataset?.model ?? null }));
}

/** @brief 等当前一栏的模型按钮显示 id、不再是"切换中"。 */
function waitModel(page, id) {
  return page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    return button?.textContent === want && button.getAttribute('aria-disabled') !== 'true';
  }, { selector: PANE, want: id }, { timeout: 15000 });
}

/** @brief 在当前一栏的顶栏换模型，等按钮显示它、不再是"切换中"。 */
async function switchModel(page, ref) {
  await paneOf(page).getByTestId('model-button').click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-model="${ref}"]`).click();
  await waitModel(page, ref.split('/').pop());
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

/** @brief 在当前一栏的顶栏换思考强度，等按钮的 data-level 变过去、不再是"切换中"。 */
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

/** @brief 首次启动：表单里有"支持思考"（不勾），勾上才出现思考强度；测试连接成功后打开项目。 */
async function firstRun(ctx) {
  const { page, h } = ctx;
  const form = page.getByTestId('connection-form');
  await form.waitFor({ timeout: 60000 });
  const box = form.locator('.thinking-fields input[type="checkbox"]');
  const select = form.locator('.thinking-level select');
  const before = { checked: await box.isChecked(), select: await select.count(),
    label: oneLine(await form.locator('.thinking-fields .check-row').innerText()) };
  await box.check();
  const checked = { select: await select.count(), value: await select.inputValue(),
    options: await select.locator('option').allInnerTexts() };
  await box.uncheck();
  const unchecked = await select.count();
  record('首次启动：表单里有"支持思考"（不勾）和说明"勾选后 pi 才会发送思考参数…"；不勾时没有"新会话默认的思考强度"',
    before.checked === false && before.select === 0 && before.label.startsWith('支持思考')
    && before.label.includes('勾选后 pi 才会发送思考参数') && unchecked === 0, JSON.stringify({ before, unchecked }));
  record('勾上"支持思考"才出现"新会话默认的思考强度"：关、最低、低、中、高，默认是 pi 现在会用的"中"', checked.select === 1
    && checked.options.join() === '关,最低,低,中,高' && checked.value === 'medium', JSON.stringify(checked));
  await h.fillConnection({ name: '合成端点', baseUrl, apiKey: testKey, modelId: 'fake-coder' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  firstRunFiles(ctx);
  await stubFolder(ctx.app, ctx.project);
  await page.getByRole('button', { name: '打开文件夹…' }).first().click();
  await waitReady(page);
  ctx.s1 = await activeFile(page);
}

/** @brief 首次启动保存后的文件：models.json 在 mori-endpoint 下、没有 key；credentials.json 只有密文。 */
function firstRunFiles(ctx) {
  const text = readText(join(ctx.userData, 'pi', 'models.json')) ?? '';
  const provider = modelsJson(ctx).providers?.[MAIN];
  const settings = settingsJson(ctx);
  record('保存后：models.json 在 mori-endpoint 下写了连接和模型 fake-coder（没有 reasoning），没有 apiKey、没有 key 的明文；'
    + '默认模型是它', provider?.baseUrl === baseUrl && provider.models?.length === 1
    && provider.models[0].id === 'fake-coder' && !('reasoning' in provider.models[0]) && !text.includes('apiKey')
    && !text.includes(testKey) && settings.defaultProvider === MAIN && settings.defaultModel === 'fake-coder',
  oneLine(text, 300));
  const credentials = credentialsState(ctx);
  record('credentials.json 只有 mori-endpoint 一项，值是 base64 密文（原文和解开 base64 后都没有 key 的明文）',
    credentials.providers.join() === MAIN && credentials.base64 && !credentials.plain,
    JSON.stringify({ providers: credentials.providers, base64: credentials.base64, plain: credentials.plain }));
}

/** @brief 设置页：分节、连接卡、模型行、"默认"；唯一的模型不能删除；分节可以用 ↑ ↓ 切换。 */
async function settingsList(ctx) {
  const { page } = ctx;
  const landed = await landSettings(page);
  await page.locator('[data-testid="connection-card"]').first().waitFor({ timeout: 15000 });
  const nav = await page.locator('[data-testid="settings-nav"] button').evaluateAll((items) => items.map((item) => ({
    section: item.dataset.section, text: item.textContent, current: item.getAttribute('aria-current') })));
  const backButton = await page.getByRole('button', { name: '返回会话', exact: true }).count();
  record('设置页：左边分节"连接与模型""AGENTS.md"，打开时落在"连接与模型"（aria-current）；顶部"返回会话"',
    nav.map((item) => `${item.section}:${item.text}`).join() === 'connections:连接与模型,agents:AGENTS.md'
    && nav[0].current === 'page' && nav[1].current === null && backButton === 1 && landed.body === 'connections',
  JSON.stringify({ landed, nav }));
  const list = await listState(page);
  const card = list[0];
  const row = rowIn(list, `${MAIN}/fake-coder`);
  record('连接卡：名称、服务地址、接口类型、"key 已加密保存"；模型行：ID、"默认"、上下文长度、"不支持思考"', list.length === 1
    && card.provider === MAIN && card.name === '合成端点' && card.meta === `${baseUrl} · OpenAI 兼容（Chat Completions）`
    && card.key === 'key 已加密保存' && row?.isDefault && row.badge === '默认' && row.meta === '上下文 128,000 · 不支持思考',
  JSON.stringify(list));
  record('默认的那行没有"设为默认"；唯一的模型"删除"不可用，悬停"至少要留一个模型"', row && !row.buttons['设为默认']
    && row.buttons['删除']?.disabled && row.buttons['删除'].title === '至少要留一个模型' && row.buttons['测试']
    && row.buttons['编辑'], JSON.stringify(row?.buttons));
  await noteSmall(ctx, '设置页列表', '.settings-page');
  await page.locator('[data-testid="settings-nav"] button[data-section="connections"]').focus();
  await page.keyboard.press('ArrowDown');
  const down = await currentSection(page);
  await page.keyboard.press('ArrowUp');
  const up = await currentSection(page);
  record('分节列表可以用 ↑ ↓ 切换（↓ 到 AGENTS.md，↑ 回到连接与模型），当前分节高亮', down.nav === 'agents'
    && down.body === 'agents' && up.nav === 'connections' && up.body === 'connections', JSON.stringify({ down, up }));
  await navByTab(page);
  await shot(page, '1-settings-list');
}

/** @brief 分节列表用 Tab / Shift+Tab 在分节按钮之间移动，Enter、空格换过去。 */
async function navByTab(page) {
  const focused = () => page.evaluate(() => document.activeElement?.closest('[data-testid="settings-nav"]')
    ? document.activeElement.dataset.section : null);
  await page.locator('[data-testid="settings-nav"] button[data-section="connections"]').focus();
  await page.keyboard.press('Tab');
  const tabbed = await focused();
  await page.keyboard.press('Enter');
  const entered = await currentSection(page);
  await page.keyboard.press('Shift+Tab');
  const back = await focused();
  await page.keyboard.press('Space');
  const spaced = await currentSection(page);
  await page.locator('[data-testid="connection-card"]').first().waitFor({ timeout: 15000 });
  record('分节列表可以用 Tab 移动（Tab 到 AGENTS.md、Shift+Tab 回到连接与模型），Enter、空格换过去', tabbed === 'agents'
    && entered.nav === 'agents' && entered.body === 'agents' && back === 'connections' && spaced.nav === 'connections'
    && spaced.body === 'connections', JSON.stringify({ tabbed, entered, back, spaced }));
}

// ---------- 步骤：添加模型、设为默认、测试 ----------

/** @brief 添加模型：没有 key 框，保存不改 credentials.json；ID 重复；默认模型不能删除。 */
async function addModelStep(ctx) {
  const { page } = ctx;
  const credentialsBefore = credentialsState(ctx).text;
  await connectionCard(page, MAIN).getByRole('button', { name: '添加模型' }).click();
  await page.getByTestId('model-form').waitFor({ timeout: 5000 });
  const form = await formState(page, 'model-form');
  await noteSmall(ctx, '添加模型表单', '.settings-page');
  record('添加模型：标题"添加模型 · 合成端点"，说明"用这个连接的地址和 key，不用再填 key"；没有 key 框；字段是模型 ID、'
    + '上下文长度、支持思考（不勾，没有思考强度）', form?.title === '添加模型 · 合成端点'
    && form.hint === '用这个连接的地址和 key，不用再填 key' && form.passwords === 0 && form.fields.join() === '模型 ID,上下文长度'
    && form.reasoning === false && form.level === null && form.idReadOnly === false, JSON.stringify(form));
  await fillModelForm(page, { modelId: 'fake-coder-2' });
  const message = await saveModelForm(page);
  const notice = await noticeText(page);
  const list = await listState(page);
  const models = modelsJson(ctx).providers?.[MAIN]?.models ?? [];
  const row = rowIn(list, `${MAIN}/fake-coder-2`);
  record('保存后回到列表，上方"已保存 · 已经打开的会话下一条消息起用新的设置"；新模型一行（不是默认、不支持思考）；'
    + 'models.json 里同一个连接下两个模型', message === null && notice === SAVED_NOTICE && row && !row.isDefault
    && row.meta === '上下文 128,000 · 不支持思考' && models.map((model) => model.id).join() === 'fake-coder,fake-coder-2',
  JSON.stringify({ message, notice, row, models }));
  record('反例："添加模型"保存不改 credentials.json', credentialsState(ctx).text === credentialsBefore, '');
  const duplicate = await addModel(page, MAIN, 'fake-coder');
  record('添加模型时 ID 已存在："保存失败：这个连接下已经有模型 fake-coder"，留在表单里',
    duplicate === '保存失败：这个连接下已经有模型 fake-coder', duplicate ?? '(saved)');
  await page.getByTestId('model-form').getByRole('button', { name: '取消', exact: true }).click();
  const after = await listState(page);
  const main = rowIn(after, `${MAIN}/fake-coder`);
  const other = rowIn(after, `${MAIN}/fake-coder-2`);
  record('默认模型（还有别的模型时）"删除"不可用，悬停"默认模型不能删除，先把别的模型设为默认"；不是默认的可以删、有"设为默认"',
    main?.buttons['删除']?.disabled && main.buttons['删除'].title === '默认模型不能删除，先把别的模型设为默认'
    && other?.buttons['删除']?.disabled === false && Boolean(other.buttons['设为默认']),
  JSON.stringify({ main: main?.buttons, other: other?.buttons }));
}

/** @brief 点模型行的"设为默认"，等"默认"移过去，返回列表上方的一行。 */
async function makeDefault(page, ref) {
  await modelRow(page, ref).getByRole('button', { name: '设为默认', exact: true }).click();
  await page.waitForFunction((want) => document.querySelector(`[data-testid="model-row"][data-model="${want}"]`)
    ?.dataset.default === 'true', ref, { timeout: 10000 });
  return noticeText(page);
}

/** @brief 设为默认：标记移过去、写进 settings.json；已经打开的会话不变，新会话用它。最后把默认设回 fake-coder。 */
async function setDefault(ctx) {
  const { page } = ctx;
  const notice = await makeDefault(page, `${MAIN}/fake-coder-2`);
  const list = await listState(page);
  const settings = settingsJson(ctx);
  record('设为默认："默认"移到 fake-coder-2 这一行（原来的那行不再标）；上方"已把 fake-coder-2 设为默认 · 新会话用默认模型；'
    + '已经打开的会话不变"；settings.json 的 defaultModel 随之改', rowIn(list, `${MAIN}/fake-coder-2`)?.badge === '默认'
    && !rowIn(list, `${MAIN}/fake-coder`)?.isDefault
    && notice === '已把 fake-coder-2 设为默认 · 新会话用默认模型；已经打开的会话不变'
    && settings.defaultProvider === MAIN && settings.defaultModel === 'fake-coder-2',
  JSON.stringify({ notice, settings }));
  await back(page);
  const oldButton = await buttonState(page, 'model-button');
  const old = await sendIn(page, 'which model');
  record('已经打开的会话不变：顶栏仍是 fake-coder，"which model" 的回复来自 fake-coder', oldButton.text === 'fake-coder'
    && old.fresh && old.text === '模型：fake-coder', JSON.stringify({ button: oldButton.text, reply: old.text }));
  ctx.s2 = await ctrlN(page);
  const freshButton = await buttonState(page, 'model-button');
  const fresh = await sendIn(page, 'which model');
  record('新会话用默认模型：顶栏 fake-coder-2，回复"模型：fake-coder-2"', freshButton.text === 'fake-coder-2'
    && fresh.fresh && fresh.text === '模型：fake-coder-2',
  JSON.stringify({ button: freshButton.text, reply: fresh.text }));
  await openSettings(page);
  const backNotice = await makeDefault(page, `${MAIN}/fake-coder`);
  record('再把 fake-coder 设回默认：标记移回去', backNotice === '已把 fake-coder 设为默认 · 新会话用默认模型；已经打开的会话不变'
    && settingsJson(ctx).defaultModel === 'fake-coder', backNotice ?? '');
}

/** @brief 每行"测试"：测试中可以取消（fake-slow 第一个分块前等 8 秒），结果写在这一行下面；同一时刻只测一个。 */
async function testModel(ctx) {
  const { page } = ctx;
  const added = await addModel(page, MAIN, 'fake-slow');
  const slow = modelRow(page, `${MAIN}/fake-slow`);
  await slow.getByRole('button', { name: '测试', exact: true }).click();
  await slow.getByRole('button', { name: '测试中…' }).waitFor({ timeout: 5000 });
  const during = await listState(page);
  await slow.getByRole('button', { name: '取消', exact: true }).click();
  await slow.getByTestId('model-test').waitFor({ timeout: 15000 });
  const cancelled = await slow.getByTestId('model-test').innerText();
  const slowRow = rowIn(during, `${MAIN}/fake-slow`);
  record('模型行"测试"：测试中显示"测试中…"（不可用）和"取消"，其他行的"测试"不可用；取消后这一行下面"已取消测试"',
    added === null && slowRow?.buttons['测试中…']?.disabled && Boolean(slowRow.buttons['取消'])
    && rowIn(during, `${MAIN}/fake-coder`)?.buttons['测试']?.disabled && cancelled === '已取消测试',
  JSON.stringify({ added, slow: slowRow?.buttons, cancelled }));
  const main = modelRow(page, `${MAIN}/fake-coder`);
  await main.getByRole('button', { name: '测试', exact: true }).click();
  await main.getByTestId('model-test').waitFor({ timeout: 30000 });
  const result = await main.getByTestId('model-test').innerText();
  await noteSmall(ctx, '模型行测试结果', '.settings-page');
  record('测试 fake-coder：结果"连接成功 · 首字 … ms · 共 … ms · 回复：…"写在这一行下面', /^连接成功 · 首字 \d+ ms · 共 \d+ ms/
    .test(result), result);
}

// ---------- 步骤：第二个连接、顶栏模型菜单 ----------

/**
 * @brief 添加连接（与首次启动同一张表单），填一个合成端点不接受的 key：新连接（mori-endpoint-<N>）排在最后，
 *        它的 id 记在 ctx.second；这一行"测试"失败，结果写在行下面。
 */
async function secondConnection(ctx) {
  const { page, h } = ctx;
  await cancelForms(ctx);
  await page.getByRole('button', { name: '添加连接' }).click();
  const form = page.getByTestId('connection-form');
  await form.waitFor({ timeout: 5000 });
  const state = await formState(page, 'connection-form');
  await noteSmall(ctx, '添加连接表单', '.settings-page');
  record('添加连接：与首次启动同一张表单（名称、服务地址、接口类型、API key、模型 ID、上下文长度、支持思考），'
    + 'key 框提示"保存后由 Mori 加密存放在本机"', state?.title === '添加连接'
    && state.fields.join() === '名称,服务地址,接口类型,API key,模型 ID,上下文长度' && state.reasoning === false
    && state.keyPlaceholder === '保存后由 Mori 加密存放在本机', JSON.stringify(state));
  await h.fillConnection({ name: '第二个连接', baseUrl, apiKey: wrongKey, modelId: 'fake-other' });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('[data-testid="connection-card"][aria-label="第二个连接"]').waitFor({ timeout: 15000 });
  const list = await listState(page);
  ctx.second = list[1]?.provider ?? null;
  const text = readText(modelsFile(ctx)) ?? '';
  const credentials = credentialsState(ctx);
  record('保存后回到列表，新连接（mori-endpoint-<N>）排在最后、"key 已加密保存"；models.json 里没有 apiKey；'
    + 'credentials.json 两项密文；默认模型不变', list.length === 2 && /^mori-endpoint-\d+$/.test(ctx.second ?? '')
    && list[1].name === '第二个连接' && list[1].key === 'key 已加密保存' && !text.includes('apiKey')
    && credentials.providers.join() === `${MAIN},${ctx.second}` && credentials.base64 && !credentials.plain
    && settingsJson(ctx).defaultModel === 'fake-coder', JSON.stringify({ cards: list.map((card) => card.provider),
    credentials: credentials.providers, plain: credentials.plain }));
  const other = modelRow(page, `${ctx.second}/fake-other`);
  await other.getByRole('button', { name: '测试', exact: true }).click();
  await other.getByTestId('model-test').waitFor({ timeout: 30000 });
  const failed = await other.getByTestId('model-test').innerText();
  record('模型行"测试"失败（第二个连接的 key 合成端点不接受）：这一行下面"连接失败："加原文（401）',
    /^连接失败：.*401/.test(failed), failed);
}

/**
 * @brief 连接卡上"编辑连接"：说明里的 N 是这个连接下的模型数（这时合成端点下有 3 个）；"取消"回到列表、不写文件。
 *        "添加连接"也能"取消"回到列表，不多出连接。
 */
async function cancelForms(ctx) {
  const { page } = ctx;
  const before = readText(modelsFile(ctx));
  await connectionCard(page, MAIN).getByRole('button', { name: '编辑连接' }).click();
  await page.getByTestId('connection-form').waitFor({ timeout: 5000 });
  const edit = await formState(page, 'connection-form');
  await page.getByTestId('connection-form').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('connection-form').waitFor({ state: 'detached', timeout: 5000 });
  const afterEdit = { notice: await page.getByTestId('settings-notice').count(),
    cards: await page.getByTestId('connection-card').count() };
  record('连接卡上"编辑连接"：标题"编辑连接 · 合成端点"，说明"这个连接下的 3 个模型都用这里的地址和 key"，不含模型字段；'
    + '"取消"回到列表（上方没有"已保存"），models.json 不变', edit?.title === '编辑连接 · 合成端点'
    && edit.hint === '这个连接下的 3 个模型都用这里的地址和 key' && edit.fields.join() === '名称,服务地址,接口类型,API key'
    && afterEdit.notice === 0 && afterEdit.cards === 1 && readText(modelsFile(ctx)) === before,
  JSON.stringify({ edit, afterEdit }));
  await page.getByRole('button', { name: '添加连接' }).click();
  await page.getByTestId('connection-form').waitFor({ timeout: 5000 });
  await page.getByTestId('connection-form').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('connection-form').waitFor({ state: 'detached', timeout: 5000 });
  const cards = await page.getByTestId('connection-card').count();
  record('添加连接"取消"：回到列表，没有多出连接，models.json 不变', cards === 1 && readText(modelsFile(ctx)) === before,
    String(cards));
}

/** @brief 顶栏模型菜单：按连接分组、当前的打勾、默认的标"默认"、说明、Esc 关闭、"管理模型…"打开设置页。 */
async function topbarMenu(ctx) {
  const { page } = ctx;
  await back(page);
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  const button = await buttonState(page, 'model-button');
  const menu = await openModelMenu(page);
  await noteSmall(ctx, '模型菜单和顶栏的两个按钮', '[data-testid="model-menu"], .pane-slot:not([hidden]) .model-switch, '
    + '.pane-slot:not([hidden]) .thinking-switch');
  const groups = menu.groups.map((group) => `${group.name}:${group.items.map((item) => item.ref.split('/')[1])
    .join('|')}`);
  const items = menu.groups.flatMap((group) => group.items);
  record('顶栏模型按钮显示模型 ID 和 ▾，悬停"合成端点 · fake-coder"', button.text === 'fake-coder' && button.icon
    && button.title === '合成端点 · fake-coder', JSON.stringify(button));
  record('模型菜单：按连接分组（合成端点：fake-coder、fake-coder-2、fake-slow；第二个连接：fake-other）；当前的打勾、焦点在它上面；'
    + '默认模型标"默认"；底部"只作用于这个会话；新会话用设置里的默认模型"，最后一项"管理模型…"',
  groups.join() === '合成端点:fake-coder|fake-coder-2|fake-slow,第二个连接:fake-other'
    && items.filter((item) => item.checked).map((item) => item.ref).join() === `${MAIN}/fake-coder`
    && items.filter((item) => item.tag === '默认').map((item) => item.ref).join() === `${MAIN}/fake-coder`
    && menu.focused === `${MAIN}/fake-coder` && menu.note === '只作用于这个会话；新会话用设置里的默认模型'
    && menu.actions.join() === '管理模型…', JSON.stringify(menu));
  await shot(page, '2-model-menu');
  await page.keyboard.press('Escape');
  const closed = await menuGone(page, 'model-menu');
  await openModelMenu(page);
  await paneOf(page).locator('.composer textarea').click();
  const outside = await menuGone(page, 'model-menu');
  await openModelMenu(page);
  await page.getByTestId('model-menu').getByRole('menuitem', { name: '管理模型…' }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 5000 });
  const section = await currentSection(page);
  record('Esc 关闭模型菜单；点菜单外面（输入框）也关闭；"管理模型…"打开设置页的"连接与模型"', closed && outside
    && section.nav === 'connections' && section.body === 'connections', JSON.stringify({ closed, outside, section }));
  await back(page);
}

/** @brief 走查 1：顶栏换模型后回复来自新模型；不改默认；生成中模型和思考按钮都不可用。 */
async function switchModelStep(ctx) {
  const { page } = ctx;
  const before = settingsJson(ctx);
  await paneOf(page).getByTestId('model-button').click();
  await watchStates(page, 'model');
  const focusBack = await chooseByKeys(page, 'model-menu', 'model-button', 1);
  await waitModel(page, 'fake-coder-2');
  const switching = await seenStates(page);
  const reply = await sendIn(page, 'which model');
  const after = settingsJson(ctx);
  record('走查 1：只用键盘（菜单里 ↓、Enter）在顶栏把会话换到第二个模型 fake-coder-2：菜单关闭、焦点回到按钮，按钮显示它，'
    + '下一条回复来自它（"模型：fake-coder-2"）', focusBack && reply.fresh && reply.text === '模型：fake-coder-2',
  JSON.stringify({ focusBack, reply: reply.text }));
  record('切换中：session.setModel 返回之前按钮已显示新模型、不可用（aria-disabled），返回后恢复可用',
    switching.includes('fake-coder-2|true') && switching.at(-1) === 'fake-coder-2|null', JSON.stringify(switching));
  record('反例：顶栏换模型不改设置里的默认（settings.json 的 defaultProvider / defaultModel 不变）',
    after.defaultProvider === before.defaultProvider && after.defaultModel === before.defaultModel
    && after.defaultModel === 'fake-coder', JSON.stringify({ before: before.defaultModel, after: after.defaultModel }));
  const composer = paneOf(page).locator('.composer textarea');
  await composer.fill('wait 3s');
  await composer.press('Enter');
  await waitRunning(page);
  const model = await buttonState(page, 'model-button');
  const thinking = await buttonState(page, 'thinking-button');
  await waitIdle(page);
  record('生成中：模型按钮不可用，悬停"生成中不能切换模型"；思考按钮不可用，悬停"生成中不能切换思考强度"', model.disabled
    && model.title === '生成中不能切换模型' && thinking.disabled && thinking.title === '生成中不能切换思考强度',
  JSON.stringify({ model, thinking }));
  const idle = await buttonState(page, 'model-button');
  record('本轮结束后模型按钮恢复可用', !idle.disabled, JSON.stringify(idle));
}

// ---------- 步骤：去设置、编辑连接、删除 ----------

/** @brief 换到 key 不对的连接发消息：401 错误卡带"去设置"，点它打开那个连接的"编辑连接"，焦点在 API key。 */
async function goToSettings(ctx) {
  const { page } = ctx;
  await switchModel(page, `${ctx.second}/fake-other`);
  const result = await sendIn(page, 'plain 401 check');
  const card = paneOf(page).getByTestId('error-card').last();
  const text = await card.innerText().catch(() => '');
  record('换到 key 不对的连接（第二个连接）发消息：错误卡显示 401 原文和"去设置"', result.newErrors.length > 0
    && /401/.test(text) && text.includes('去设置'), oneLine(text, 300));
  await card.getByRole('button', { name: '去设置' }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.activeElement
    ?.matches('[data-testid="connection-form"] input[type="password"]'), null, { timeout: 5000 }).catch(() => {});
  const form = await formState(page, 'connection-form');
  const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, type: document.activeElement?.type,
    inForm: Boolean(document.activeElement?.closest('[data-testid="connection-form"]')) }));
  record('点"去设置"：设置页打开出错会话所用的连接（第二个连接）的"编辑连接"，焦点在 API key 框',
    form?.title === '编辑连接 · 第二个连接' && focus.type === 'password' && focus.inForm, JSON.stringify({ form, focus }));
  await noteSmall(ctx, '编辑连接表单', '.settings-page');
  await shot(page, '3-go-to-settings');
}

/** @brief 编辑连接：不含模型字段；改了服务地址的 origin 又没填 key 时保存失败，显示后台进程的原文。 */
async function editEndpoint(ctx) {
  const { page, h } = ctx;
  const form = await formState(page, 'connection-form');
  record('编辑连接：名称、服务地址、接口类型、API key（不含模型字段）；说明"这个连接下的 1 个模型都用这里的地址和 key"；'
    + 'key 框"已加密保存（不显示）；改了服务地址就要重新填写"', form?.fields.join() === '名称,服务地址,接口类型,API key'
    && form.reasoning === null && form.hint === '这个连接下的 1 个模型都用这里的地址和 key'
    && form.keyPlaceholder === '已加密保存（不显示）；改了服务地址就要重新填写', JSON.stringify(form));
  const before = modelsJson(ctx).providers?.[ctx.second]?.baseUrl;
  await h.fillConnection({ baseUrl: `http://localhost:${port}/v1` });
  await page.getByTestId('connection-form').getByRole('button', { name: '保存', exact: true }).click();
  const message = await h.formMessage(null, { timeout: 15000 }).catch(() => null);
  const after = modelsJson(ctx).providers?.[ctx.second]?.baseUrl;
  record('编辑连接改了服务地址的 origin（127.0.0.1 → localhost）又没填 key："保存失败：API key is required when the service '
    + 'address changes"（后台进程的原文），models.json 不变', message
    === '保存失败：API key is required when the service address changes' && before === baseUrl && after === baseUrl,
  JSON.stringify({ message, after }));
  await fixKey(ctx, message);
}

/**
 * @brief 接着"去设置"：地址改回原来的、填对 key，"测试连接"（先保存，再测这个连接的第一个模型）；回到列表；
 *        出错的会话下一条消息起用新的 key。最后回到设置页的列表。
 * @param previous 表单下方原来的文字（等它变化）
 */
async function fixKey(ctx, previous) {
  const { page, h } = ctx;
  await h.fillConnection({ baseUrl, apiKey: testKey });
  await page.getByTestId('connection-form').getByRole('button', { name: '测试连接' }).click();
  const tested = await h.formMessage(previous, { test: true, timeout: 30000 }).catch(() => null);
  record('编辑连接填对 key 再"测试连接"：先保存，再测这个连接的第一个模型（fake-other），"连接成功…"',
    /^连接成功 · 首字 \d+ ms/.test(tested ?? ''), tested ?? '');
  await page.getByTestId('connection-form').getByRole('button', { name: '返回列表', exact: true }).click();
  const notice = await noticeText(page);
  record('编辑连接保存过、回到列表：上方"已保存 · 已经打开的会话下一条消息起用新的设置"', notice === SAVED_NOTICE, notice ?? '');
  await back(page);
  const reply = await sendIn(page, 'which model');
  record('去设置改好 key 之后，出错的那个会话（已经打开）下一条消息就成功，回复来自 fake-other', reply.fresh
    && reply.text === '模型：fake-other', JSON.stringify({ text: reply.text, errors: reply.newErrors }));
  await openSettings(page);
}

/** @brief 点模型行的"删除"，读确认框。 */
async function openDelete(page, ref) {
  await modelRow(page, ref).getByRole('button', { name: '删除', exact: true }).click();
  return dialogState(page, 'delete-dialog');
}

/** @brief 在确认框里点"删除"，等确认框关闭。 */
async function confirmDelete(page) {
  await page.getByTestId('delete-dialog').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByTestId('delete-dialog').waitFor({ state: 'detached', timeout: 15000 });
}

/** @brief 删除：确认框、删掉一个模型、删掉连接的最后一个模型（连接和 key 一起删除）。 */
async function deleteModels(ctx) {
  const { page } = ctx;
  const credentialsBefore = credentialsState(ctx).text;
  const first = await openDelete(page, `${MAIN}/fake-slow`);
  await noteSmall(ctx, '删除确认框', '[data-testid="delete-dialog"]');
  await confirmDelete(page);
  const notice = await noticeText(page);
  const list = await listState(page);
  record('删除确认框"删除模型 fake-slow？""从连接 合成端点 里删除这个模型。"，按钮"删除""取消"，焦点在"取消"；删除后这一行消失，'
    + 'models.json 里没有它，credentials.json 不变', first.title === '删除模型 fake-slow？'
    && first.text === '从连接 合成端点 里删除这个模型。' && first.buttons.join() === '删除,取消' && first.focused === '取消'
    && !rowIn(list, `${MAIN}/fake-slow`) && notice === '已删除模型 fake-slow'
    && !(modelsJson(ctx).providers?.[MAIN]?.models ?? []).some((model) => model.id === 'fake-slow')
    && credentialsState(ctx).text === credentialsBefore, JSON.stringify({ first, notice }));
  await openDelete(page, `${MAIN}/fake-coder-2`);
  await confirmDelete(page);
  const last = await openDelete(page, `${ctx.second}/fake-other`);
  await page.keyboard.press('Escape');
  await page.getByTestId('delete-dialog').waitFor({ state: 'detached', timeout: 5000 });
  const kept = Boolean(rowIn(await listState(page), `${ctx.second}/fake-other`));
  await openDelete(page, `${ctx.second}/fake-other`);
  await confirmDelete(page);
  const gone = await listState(page);
  const credentials = credentialsState(ctx);
  record('删除连接的最后一个模型：确认框说明"连接 第二个连接 也会删除，它的 key 一起删除。"（Esc 等于取消）；删除后整张卡消失，'
    + 'models.json 里没有这个连接，credentials.json 里它的 key 也删了', last.title === '删除模型 fake-other？'
    && last.text === '连接 第二个连接 也会删除，它的 key 一起删除。' && kept
    && gone.map((card) => card.provider).join() === MAIN && !(ctx.second in (modelsJson(ctx).providers ?? {}))
    && credentials.providers.join() === MAIN && await noticeText(page) === '已删除模型 fake-other 和连接 第二个连接',
  JSON.stringify({ last, kept, cards: gone.map((card) => card.provider), credentials: credentials.providers }));
  await deletedInUse(ctx);
}

/**
 * @brief 正在用已删除模型的会话：顶栏标"（已删除）"。连接还在时（S2 用的 fake-coder-2）下一条消息仍用打开时的设置；
 *        连接也删了时（S1 用的 fake-other）下一条消息失败，错误卡是 pi 的原文。之后 S1 换回 fake-coder。
 */
async function deletedInUse(ctx) {
  const { page } = ctx;
  await back(page);
  const button = await buttonState(page, 'model-button');
  const result = await sendIn(page, 'plain after delete');
  record('正在用已删除连接的会话：顶栏显示"fake-other（已删除）"；连接也删了，下一条消息失败，错误卡显示 pi 的原文'
    + '（说的是找不到这个连接的 key）', button.text === 'fake-other（已删除）' && !result.fresh
    && result.newErrors.some((text) => text.includes(ctx.second) && /api key/i.test(text)),
  JSON.stringify({ button: button.text, errors: result.newErrors.map((text) => oneLine(text, 200)) }));
  record('模型已删除时悬停说明也标"（已删除）"（"<连接名> · fake-other（已删除）"）',
    button.title.endsWith(' · fake-other（已删除）'), button.title);
  await deletedGoToSettings(ctx);
  await rowOf(page, ctx.s2).first().click();
  await waitReady(page);
  const kept = await buttonState(page, 'model-button');
  const reply = await sendIn(page, 'which model');
  record('删掉一个模型而连接还在：正在用它的会话（S2）顶栏显示"fake-coder-2（已删除）"，下一条消息仍用打开时的设置',
    kept.text === 'fake-coder-2（已删除）' && reply.fresh && reply.text === '模型：fake-coder-2',
    JSON.stringify({ button: kept.text, reply: reply.text, errors: reply.newErrors }));
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  await switchModel(page, `${MAIN}/fake-coder`);
}

/**
 * @brief 连接已删除时错误卡的"去设置"（原文里有"API key"）：出错会话所用的连接已经不在，设置页落在"连接与模型"的列表，
 *        不打开编辑表单（state/settings.ts connectionFor 找不到时显示列表）。状态表没有单写这种情况，这里记下实际做法。
 */
async function deletedGoToSettings(ctx) {
  const { page } = ctx;
  const card = paneOf(page).getByTestId('error-card').last();
  const link = await card.getByRole('button', { name: '去设置' }).count();
  if (link) {
    await card.getByRole('button', { name: '去设置' }).click();
    await page.getByTestId('settings-page').waitFor({ timeout: 5000 });
    await page.getByTestId('connection-card').first().waitFor({ timeout: 10000 }).catch(() => {});
  }
  const state = { link, section: await currentSection(page), forms: await page.getByTestId('connection-form').count(),
    cards: await page.getByTestId('connection-card').count() };
  record('连接已删除时错误卡也带"去设置"；点它：设置页落在"连接与模型"的列表（这个连接已经不在，不打开编辑表单）',
    link === 1 && state.section.body === 'connections' && state.forms === 0 && state.cards === 1,
    JSON.stringify(state));
  if (link) await back(page);
}

// ---------- 步骤：思考强度 ----------

/** @brief 反例：模型没标支持思考时思考强度不可选，并说明原因；"打开设置"进入设置页。 */
async function thinkingUnsupported(ctx) {
  const { page } = ctx;
  const plain = await buttonState(page, 'thinking-button');
  ctx.modelColor = (await buttonState(page, 'model-button')).color;
  const reply = await sendIn(page, 'thinking check');
  const menu = await openThinkingMenu(page);
  await noteSmall(ctx, '思考菜单（不支持思考）', '[data-testid="thinking-menu"]');
  record('反例：模型没标"支持思考"时按钮"思考：不可选"（data-reasoning=false，样式变淡但可以点开）；菜单里关、最低、低、中、高都不可用'
    + '（不是藏起来），说明原因，有"打开设置"', plain.text === '思考：不可选' && plain.reasoning === 'false'
    && !plain.disabled && plain.icon && plain.color !== ctx.modelColor
    && menu.items.map((item) => item.text).join() === '关,最低,低,中,高'
    && menu.items.every((item) => item.disabled && !item.checked) && menu.note.startsWith("这个模型没有标'支持思考'")
    && menu.note.includes("勾选'支持思考'后可以选") && menu.actions.join() === '打开设置',
  JSON.stringify({ plain, modelColor: ctx.modelColor, menu }));
  record('没标支持思考时 pi 不发送思考参数（"thinking check" → "没有思考参数"）', reply.fresh && reply.text === '没有思考参数'
    && reply.thinking === 0, reply.text);
  await shot(page, '4-thinking-unsupported');
  await page.getByTestId('thinking-menu').getByRole('menuitem', { name: '打开设置' }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 5000 });
  const section = await currentSection(page);
  record('思考菜单的"打开设置"：打开设置页的"连接与模型"', section.nav === 'connections' && section.body === 'connections',
    JSON.stringify(section));
  await page.locator('[data-testid="connection-card"]').first().waitFor({ timeout: 15000 });
}

/** @brief 编辑模型：标"支持思考"、新会话默认"高"：models.json 的 reasoning、settings.json 的 modelThinkingLevels。 */
async function markReasoning(ctx) {
  const { page } = ctx;
  await modelRow(page, `${MAIN}/fake-coder`).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByTestId('model-form').waitFor({ timeout: 5000 });
  const form = await formState(page, 'model-form');
  await fillModelForm(page, { reasoning: true });
  const checked = await formState(page, 'model-form');
  await noteSmall(ctx, '编辑模型表单（有思考强度）', '.settings-page');
  await fillModelForm(page, { level: 'high' });
  await watchStates(page, 'modelForm');
  const message = await saveModelForm(page);
  const saving = await seenStates(page);
  const row = rowIn(await listState(page), `${MAIN}/fake-coder`);
  const model = (modelsJson(ctx).providers?.[MAIN]?.models ?? []).find((item) => item.id === 'fake-coder');
  const levels = settingsJson(ctx).modelThinkingLevels ?? {};
  record('编辑模型：标题"编辑模型 · 合成端点"，模型 ID 只读（"要换模型 ID，删掉这个模型再添加"），没有 key 框；'
    + '不勾"支持思考"时没有思考强度，勾上才出现', form?.title === '编辑模型 · 合成端点' && form.idReadOnly === true
    && form.idHint === '要换模型 ID，删掉这个模型再添加' && form.passwords === 0 && form.level === null
    && checked?.level?.options.join() === '关,最低,低,中,高', JSON.stringify({ form, checked: checked?.level }));
  record('保存模型时"保存"变成"保存中…"、不可用，保存好后回到列表', saving.includes('保存中…|true') && message === null,
    JSON.stringify(saving));
  record('走查 8：标"支持思考"、新会话默认"高"后：这一行"支持思考 · 新会话默认 高"；models.json 里 reasoning: true，'
    + 'settings.json 的 modelThinkingLevels["mori-endpoint/fake-coder"] 为 high', message === null
    && row?.meta === '上下文 128,000 · 支持思考 · 新会话默认 高' && model?.reasoning === true
    && levels[`${MAIN}/fake-coder`] === 'high', JSON.stringify({ message, meta: row?.meta, model, levels }));
}

/** @brief 打开着的会话随之可选；"高"有思考内容，"关"没有；不改设置；新会话用按模型的默认强度。 */
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
  record('已经打开的会话（打开时模型没标支持思考）：设置里标了之后顶栏的思考强度变得可选（关–高都可用，按钮不再变淡），'
    + '当前"关"打勾；底部"只作用于这个会话；新会话的默认在设置里按模型设定"；Esc 关闭菜单', open.reasoning === 'true'
    && open.text === '思考：关' && open.color === ctx.modelColor && closed
    && menu.items.map((item) => item.level).join() === 'off,minimal,low,medium,high'
    && menu.items.every((item) => !item.disabled) && menu.items.find((item) => item.checked)?.level === 'off'
    && menu.note === '只作用于这个会话；新会话的默认在设置里按模型设定', JSON.stringify({ open, closed, menu }));
  await paneOf(page).getByTestId('thinking-button').click();
  await watchStates(page, 'thinking');
  const focusBack = await chooseByKeys(page, 'thinking-menu', 'thinking-button', 4);
  await page.waitForFunction((selector) => {
    const button = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.level === 'high' && button.getAttribute('aria-disabled') !== 'true';
  }, PANE, { timeout: 15000 }).catch(() => {});
  const switching = await seenStates(page);
  const high = await sendIn(page, 'thinking check');
  const highButton = await buttonState(page, 'thinking-button');
  record('走查 8：只用键盘（菜单里从"关"按 4 次 ↓ 到"高"、Enter）切到"高"：焦点回到按钮，按钮"思考：高"；回复带思考内容，'
    + '端点收到 high（"收到思考参数：high"）', focusBack && highButton.text === '思考：高' && high.fresh
    && high.text === '收到思考参数：high' && high.thinking === 1,
  JSON.stringify({ focusBack, button: highButton.text, text: high.text, thinking: high.thinking }));
  record('思考强度切换中：session.setThinking 返回之前按钮已显示"高"、不可用，返回后恢复可用',
    switching.includes('high|true') && switching.at(-1) === 'high|null', JSON.stringify(switching));
  await chooseLevel(page, 'off');
  const off = await sendIn(page, 'thinking check');
  record('走查 8 / 反例：切到"关"：下一次回复没有思考内容（"没有思考参数"）', off.fresh && off.text === '没有思考参数'
    && off.thinking === 0, JSON.stringify({ text: off.text, thinking: off.thinking }));
  await thinkingNewSession(ctx);
}

/**
 * @brief 顶栏切换思考强度不改设置；换模型后思考强度按返回值更新（S2 从不支持思考的 fake-coder-2 换到 fake-coder，
 *        pi 按 modelThinkingLevels 定为"高"）；新会话用默认模型和它在设置里的默认强度。
 */
async function thinkingNewSession(ctx) {
  const { page } = ctx;
  const settings = settingsJson(ctx);
  record('反例：顶栏切换思考强度不改设置（modelThinkingLevels 仍是 high，没有写 defaultThinkingLevel）',
    settings.modelThinkingLevels?.[`${MAIN}/fake-coder`] === 'high' && settings.defaultThinkingLevel === undefined,
    JSON.stringify({ levels: settings.modelThinkingLevels, global: settings.defaultThinkingLevel }));
  await rowOf(page, ctx.s2).first().click();
  await waitReady(page);
  const plain = await buttonState(page, 'thinking-button');
  await switchModel(page, `${MAIN}/fake-coder`);
  const switched = await buttonState(page, 'thinking-button');
  record('顶栏换模型后思考强度按返回值更新：S2 从 fake-coder-2（不支持思考，"思考：不可选"）换到 fake-coder，'
    + 'pi 按 modelThinkingLevels 定为"高"，按钮"思考：高"', plain.reasoning === 'false' && switched.reasoning === 'true'
    && switched.level === 'high' && switched.text === '思考：高', JSON.stringify({ plain, switched }));
  ctx.s4 = await ctrlN(page);
  const fresh = await buttonState(page, 'thinking-button');
  const freshReply = await sendIn(page, 'thinking check');
  record('新会话用默认模型和它在设置里的默认强度：fake-coder 的新会话是"思考：高"，回复带思考内容（"收到思考参数：high"）',
    fresh.level === 'high' && fresh.text === '思考：高' && freshReply.text === '收到思考参数：high'
    && freshReply.thinking === 1, JSON.stringify({ fresh, reply: freshReply.text }));
  await shot(page, '5-thinking');
}

/** @brief 在设置页编辑一个 mori-endpoint 下的模型：改 fields 后保存；返回 saveModelForm 的结果。 */
async function editModel(page, modelId, fields) {
  await modelRow(page, `${MAIN}/${modelId}`).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByTestId('model-form').waitFor({ timeout: 5000 });
  await fillModelForm(page, fields);
  return saveModelForm(page);
}

/** @brief 等当前一栏的思考按钮 data-reasoning 变成 want（后台进程换了模型对象之后发 mori.model_state）。 */
const waitReasoning = (page, want) => page.waitForFunction(({ selector, value }) => document.querySelector(
  `${selector} [data-testid="thinking-button"]`)?.dataset.reasoning === value, { selector: PANE, value: want },
{ timeout: 10000 }).catch(() => {});

/**
 * @brief 编辑模型去掉"支持思考"：用它的打开着的会话思考强度按 pi 收紧为"关"，顶栏随之变成"不可选"；再标回来。
 *        最后在 S1 切到"低"（重启后检查恢复）。
 */
async function unmarkReasoning(ctx) {
  const { page } = ctx;
  await openSettings(page);
  const message = await editModel(page, 'fake-coder', { reasoning: false });
  const model = (modelsJson(ctx).providers?.[MAIN]?.models ?? []).find((item) => item.id === 'fake-coder');
  const levels = settingsJson(ctx).modelThinkingLevels ?? {};
  const row = rowIn(await listState(page), `${MAIN}/fake-coder`);
  await back(page);
  await waitReasoning(page, 'false');
  const s4 = await buttonState(page, 'thinking-button');
  record('编辑模型去掉"支持思考"：这一行"不支持思考"，models.json 删掉 reasoning，settings.json 删掉它的 modelThinkingLevels；'
    + '正在用它的会话（"思考：高"）按 pi 收紧为"关"，顶栏随之变成"思考：不可选"', message === null
    && row?.meta === '上下文 128,000 · 不支持思考' && model && !('reasoning' in model) && !(`${MAIN}/fake-coder` in levels)
    && s4.reasoning === 'false' && s4.level === 'off' && s4.text === '思考：不可选',
  JSON.stringify({ message, meta: row?.meta, model, levels, s4 }));
  await openSettings(page);
  await editModel(page, 'fake-coder', { reasoning: true, level: 'high' });
  await back(page);
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  await waitReasoning(page, 'true');
  await chooseLevel(page, 'low');
}

/**
 * @brief models.json 里有不是 Mori 写的 provider（手写，synthetic）：设置页不列出、保存别的模型时原样保留；
 *        pi 重读之后顶栏模型菜单照样列出它（分组名用 provider id）。
 */
async function otherProvider(ctx) {
  const { page } = ctx;
  const file = modelsJson(ctx);
  const hand = { baseUrl, api: 'openai-completions', apiKey: 'synthetic-hand-written-key-not-real',
    models: [{ id: 'hand-model' }] };
  file.providers = { ...file.providers, 'hand-written': hand };
  writeFileSync(join(ctx.userData, 'pi', 'models.json'), `${JSON.stringify(file, null, 2)}
`);
  await openSettings(page);
  // 原样保存一次 fake-coder：后台进程写 models.json 后 pi 重读（读到手写的 provider）。
  const message = await editModel(page, 'fake-coder', {});
  const list = await listState(page);
  const kept = modelsJson(ctx).providers?.['hand-written'];
  await back(page);
  const menu = await openModelMenu(page);
  await page.keyboard.press('Escape');
  const groups = menu.groups.map((group) => `${group.name}:${group.items.map((item) => item.ref).join('|')}`);
  record('models.json 里有不是 Mori 写的 provider（手写的 hand-written）：设置页不列出它，保存别的模型时它原样保留；'
    + '顶栏模型菜单照样列出它（分组名用 provider id）', message === null
    && list.map((card) => card.provider).join() === MAIN && JSON.stringify(kept) === JSON.stringify(hand)
    && groups.join() === `合成端点:${MAIN}/fake-coder,hand-written:hand-written/hand-model`, JSON.stringify({ groups,
    cards: list.map((card) => card.provider), kept: Boolean(kept) }));
}

/**
 * @brief models.json 里一个 Mori 的连接没有 key（手写的 mori-endpoint-3，credentials.json 里没有它，synthetic）：
 *        连接卡"没有 key"；pi 重读之后顶栏模型菜单不列出它的模型（只列 pi 能用的、有 key 的）。最后在设置页删掉它。
 */
async function keylessConnection(ctx) {
  const { page } = ctx;
  const file = modelsJson(ctx);
  file.providers = { ...file.providers, [KEYLESS]: { name: '没有 key 的连接', baseUrl, api: 'openai-completions',
    models: [{ id: 'fake-keyless', name: 'fake-keyless', contextWindow: 128000 }] } };
  writeJson(modelsFile(ctx), file);
  await openSettings(page);
  // 设置页先用手上的配置画列表，重新读取的结果随后才到：等手写的连接出现。
  await connectionCard(page, KEYLESS).waitFor({ timeout: 10000 }).catch(() => {});
  const card = (await listState(page)).find((item) => item.provider === KEYLESS);
  await noteSmall(ctx, '没有 key 的连接卡', '.settings-page');
  // 原样保存一次 fake-coder：后台进程写 models.json 后 pi 重读（读到手写的连接）。
  const message = await editModel(page, 'fake-coder', {});
  await back(page);
  const menu = await openModelMenu(page);
  await page.keyboard.press('Escape');
  const refs = menu.groups.flatMap((group) => group.items.map((item) => item.ref));
  record('Mori 的连接没有 key（手写的 mori-endpoint-3）：连接卡"没有 key"；顶栏模型菜单不列出它的模型（pi 只列有 key 的）',
    card?.key === '没有 key' && card.name === '没有 key 的连接' && message === null && refs.includes(`${MAIN}/fake-coder`)
    && !refs.includes(`${KEYLESS}/fake-keyless`), JSON.stringify({ card, refs }));
  await openSettings(page);
  const dialog = await openDelete(page, `${KEYLESS}/fake-keyless`);
  await confirmDelete(page);
  const notice = await noticeText(page);
  const cards = (await listState(page)).map((item) => item.provider);
  record('删掉没有 key 的连接的唯一模型：确认框说明连接一起删除，删除后整张卡消失，models.json 里没有它，credentials.json 不变',
    dialog.text === '连接 没有 key 的连接 也会删除，它的 key 一起删除。' && cards.join() === MAIN
    && notice === '已删除模型 fake-keyless 和连接 没有 key 的连接' && !(KEYLESS in (modelsJson(ctx).providers ?? {}))
    && credentialsState(ctx).providers.join() === MAIN, JSON.stringify({ dialog, notice, cards }));
  await back(page);
}

/**
 * @brief 后台进程写 models.json 失败（<agentDir>\models.json.tmp 被一个文件夹占着）："保存失败："加原文，文件不变。
 *        编辑模型：留在表单里。编辑连接填了新 key（合成端点不接受的）：刚填的 key 应当撤回，重启后在 reopen 里验证。
 */
async function writeFailures(ctx) {
  const { page, h } = ctx;
  const temp = `${modelsFile(ctx)}.tmp`;
  const before = readText(modelsFile(ctx));
  await openSettings(page);
  await modelRow(page, `${MAIN}/fake-coder`).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByTestId('model-form').locator('input[type="number"]').fill('64000');
  mkdirSync(temp);
  let model = null;
  let endpoint = null;
  try {
    model = await saveModelForm(page);
    await page.getByTestId('model-form').getByRole('button', { name: '取消', exact: true }).click();
    await connectionCard(page, MAIN).getByRole('button', { name: '编辑连接' }).click();
    await page.getByTestId('connection-form').waitFor({ timeout: 5000 });
    await h.fillConnection({ apiKey: wrongKey });
    await page.getByTestId('connection-form').getByRole('button', { name: '保存', exact: true }).click();
    endpoint = await h.formMessage(null, { timeout: 15000 }).catch(() => null);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const same = readText(modelsFile(ctx)) === before;
  record('后台进程写 models.json 失败时，编辑模型："保存失败："加原文（models.json.tmp 的错误），留在表单里，models.json 不变',
    /^保存失败：.*models\.json\.tmp/.test(model ?? '') && same, model ?? '(saved)');
  record('编辑连接填了新 key、写 models.json 失败："保存失败："加原文，models.json 不变', same
    && /^保存失败：.*models\.json\.tmp/.test(endpoint ?? ''), endpoint ?? '');
  ctx.keyRollback = Boolean(endpoint);
  await page.getByTestId('connection-form').getByRole('button', { name: '取消', exact: true }).click();
  await back(page);
}

/**
 * @brief pi 读 models.json 报告的错误（modelsError；手写一个缺 baseUrl 的 provider，synthetic）：保存模型后表单里
 *        "已保存，但配置有错误："加 pi 的原文，留在表单里；"返回列表"后列表上方是原文和"修好文件后重新打开设置页。"，
 *        列表照常显示。手工修好文件、重新打开设置页后错误应当消失。最后原样保存一次（pi 重读），错误消失。
 */
async function piModelsError(ctx) {
  const { page } = ctx;
  const original = readText(modelsFile(ctx));
  const file = JSON.parse(original);
  file.providers['hand-broken'] = { api: 'openai-completions', apiKey: 'synthetic-broken-key-not-real',
    models: [{ id: 'broken-model' }] };
  writeJson(modelsFile(ctx), file);
  await openSettings(page);
  const saved = await editModel(page, 'fake-coder', {});
  await page.getByTestId('model-form').getByRole('button', { name: '返回列表', exact: true }).click().catch(() => {});
  await connectionCard(page, MAIN).waitFor({ timeout: 10000 });
  const listed = { error: await page.locator('.settings-error').innerText({ timeout: 3000 }).catch(() => null),
    cards: await page.getByTestId('connection-card').count(), notice: await noticeText(page) };
  await noteSmall(ctx, '设置页 pi 报告的配置错误', '.settings-page');
  const said = /^已保存，但配置有错误：.*hand-broken.*baseUrl/.test(saved ?? '');
  record('pi 读 models.json 报告错误（手写的 provider 缺 baseUrl）：保存模型后表单里"已保存，但配置有错误："加 pi 的原文，'
    + '留在表单里；"返回列表"后列表上方原文和"修好文件后重新打开设置页。"，列表照常显示', said
    && /hand-broken.*baseUrl[\s\S]*修好文件后重新打开设置页/.test(listed.error ?? '') && listed.cards === 1
    && listed.notice === SAVED_NOTICE, JSON.stringify({ saved, listed }));
  writeFileSync(modelsFile(ctx), original);
  await back(page);
  await landSettings(page);
  await connectionCard(page, MAIN).waitFor({ timeout: 10000 });
  const cleared = await page.locator('.settings-error').waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  const stale = cleared ? null : await page.locator('.settings-error').innerText().catch(() => null);
  record('手工修好 models.json 后重新打开设置页：pi 报告的错误消失（"修好文件后重新打开设置页"）', cleared,
    oneLine(stale ?? '', 200));
  const resaved = await editModel(page, 'fake-coder', {});
  const after = await page.locator('.settings-error').count();
  record('原样保存一次模型（pi 重读 models.json）之后：没有"配置有错误"，列表上方没有错误', resaved === null && after === 0,
    JSON.stringify({ resaved, after }));
  await back(page);
}

// ---------- 步骤：AGENTS.md ----------

/** @brief AGENTS.md 一节此刻的样子。 */
function agentsState(page) {
  return page.evaluate(() => {
    const section = document.querySelector('.settings-section[data-section="agents"]');
    const editor = document.querySelector('[data-testid="agents-editor"]');
    const loaded = document.querySelector('[data-testid="agents-loaded"]');
    const effective = document.querySelector('[data-testid="agents-effective"]');
    const button = (name) => [...(section?.querySelectorAll('.agents-user .form-actions button') ?? [])]
      .find((item) => item.textContent === name);
    return { shown: Boolean(section), text: section?.innerText ?? '',
      saveDisabled: button('保存')?.disabled ?? null, revertDisabled: button('撤销改动')?.disabled ?? null,
      path: section?.querySelector('.agents-user .agents-path')?.textContent ?? null, editor: editor?.value ?? null,
      effective: effective?.textContent ?? null, warn: effective?.classList.contains('warn') ?? null,
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

/** @brief 用户级 AGENTS.md：空状态、项目级列表与用系统编辑器打开、保存与 Ctrl+S、撤销改动、生效的文件。 */
async function agentsUser(ctx) {
  const { page, app } = ctx;
  ctx.before = await ctrlN(page);
  await landSettings(page);
  await watchStates(page, 'agents');
  await openSection(page, 'agents');
  const loading = await seenStates(page);
  const empty = await agentsState(page);
  await noteSmall(ctx, 'AGENTS.md 一节', '.settings-page');
  record('AGENTS.md 读取中：agents.get 返回之前"正在读取…"，编辑框不可用', loading.some((item) => item.startsWith(
    '正在读取…|true|')) && loading.at(-1)?.startsWith('|false|'), JSON.stringify(loading));
  record('AGENTS.md：路径 <agentDir>\\AGENTS.md，"还没有这个文件，保存后创建"，编辑框是空的，还没有生效的文件；'
    + '没有改动时"保存""撤销改动"不可用', samePath(empty.path, userAgents(ctx))
    && empty.text.includes('还没有这个文件，保存后创建') && empty.editor === '' && empty.effective === null
    && empty.saveDisabled === true && empty.revertDisabled === true,
  JSON.stringify({ path: empty.path, effective: empty.effective, save: empty.saveDisabled }));
  const projectFile = join(ctx.project, 'AGENTS.md');
  record('项目级（只列出）：标题"m6proj 加载的文件"，列出项目 AGENTS.md 的完整路径，说明"会话打开时读取；之后改了文件，新会话才会读到"；'
    + '没有编辑框', empty.loadedTitle === `${basename(ctx.project)} 加载的文件`
    && empty.loadedFiles.some((path) => samePath(path, projectFile))
    && empty.loadedText.includes('会话打开时读取；之后改了文件，新会话才会读到') && empty.loadedInputs === 0,
  JSON.stringify({ title: empty.loadedTitle, files: empty.loadedFiles }));
  await app.evaluate(stubOpenPath);
  const row = page.getByTestId('agents-loaded').locator('li').filter({ hasText: 'm6proj' }).last();
  await row.getByRole('button', { name: '用系统编辑器打开' }).click();
  const opened = await until(() => app.evaluate(() => globalThis.__opened?.at(-1) ?? null), 3000);
  record('项目级"用系统编辑器打开"：交给主进程（shell.openPath）的是项目 AGENTS.md 的路径', samePath(opened, projectFile),
    String(opened));
  await claudeEffective(ctx);
  await agentsSave(ctx);
}

/**
 * @brief agentDir 里还没有 AGENTS.md、有 CLAUDE.md（synthetic）时：警示色"现在生效的是 <CLAUDE.md>；保存后改读这里的
 *        AGENTS.md，它不再加载"，可以用系统编辑器打开它。保存 AGENTS.md 之后（agentsSave）变成"生效中"，再删掉 CLAUDE.md。
 */
async function claudeEffective(ctx) {
  const { page, app } = ctx;
  ctx.claude = join(ctx.userData, 'pi', 'CLAUDE.md');
  writeFileSync(ctx.claude, '# CLAUDE.md（synthetic）\n');
  await openSection(page, 'connections');
  await openSection(page, 'agents');
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-effective"]'), null, { timeout: 5000 })
    .catch(() => {});
  const state = await agentsState(page);
  await page.locator('.agents-line').getByRole('button', { name: '用系统编辑器打开' }).click().catch(() => {});
  const opened = await until(async () => {
    const path = await app.evaluate(() => globalThis.__opened?.at(-1) ?? null);
    return samePath(path, ctx.claude) ? path : null;
  }, 3000);
  const expected = `现在生效的是 ${ctx.claude}；保存后改读这里的 AGENTS.md，它不再加载`;
  record('还没有 AGENTS.md、agentDir 里有 CLAUDE.md 时：警示色"现在生效的是 <CLAUDE.md>；保存后改读这里的 AGENTS.md，'
    + '它不再加载"，"用系统编辑器打开"打开 CLAUDE.md', state.warn === true
    && state.effective?.toLowerCase() === expected.toLowerCase() && samePath(opened, ctx.claude),
  JSON.stringify({ effective: state.effective, opened }));
}

/** @brief 保存（按钮和 Ctrl+S）、生效的文件与它的"用系统编辑器打开"、撤销改动。 */
async function agentsSave(ctx) {
  const { page, app } = ctx;
  const editor = page.getByTestId('agents-editor');
  const first = `每次回答以“收到”开头。${MARKER}\n`;
  await editor.fill(first);
  const dirty = await agentsState(page);
  const saveButton = page.locator('.agents-user').getByRole('button', { name: '保存', exact: true });
  const enabled = await saveButton.isEnabled();
  await watchStates(page, 'agents');
  await saveButton.click();
  await waitAgentsStatus(page, '已保存 · 新建的会话才会读到');
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-effective"]')?.textContent
    ?.startsWith('生效中：'), null, { timeout: 5000 }).catch(() => {});
  const saving = await seenStates(page);
  const saved = await agentsState(page);
  rmSync(ctx.claude ?? join(ctx.userData, 'pi', 'CLAUDE.md'), { force: true });
  record('有未保存的改动时"保存"可用、旁边"有未保存的改动"；保存时"保存中…"，保存后"已保存 · 新建的会话才会读到"，'
    + '"保存""撤销改动"又不可用，<agentDir>\\AGENTS.md 就是写的字', dirty.status === '有未保存的改动' && enabled
    && dirty.revertDisabled === false && saving.some((item) => item.endsWith('|保存中…'))
    && saved.status === '已保存 · 新建的会话才会读到' && saved.saveDisabled === true && saved.revertDisabled === true
    && readText(userAgents(ctx)) === first, JSON.stringify({ dirty: dirty.status, saving, saved: saved.status }));
  record('走查 2：设置页标出生效的文件："生效中：<agentDir>\\AGENTS.md"（agentDir 里还有 CLAUDE.md 时也改读 AGENTS.md）',
    saved.warn === false && saved.effective?.startsWith('生效中：') && samePath(saved.effective.slice(4), userAgents(ctx)),
  saved.effective ?? '');
  ctx.agentsSaved = `${first}第二行：用 Ctrl+S 保存。\n`;
  await editor.fill(ctx.agentsSaved);
  await editor.press('Control+s');
  await waitAgentsStatus(page, '已保存 · 新建的会话才会读到');
  record('Ctrl+S 也能保存', readText(userAgents(ctx)) === ctx.agentsSaved, oneLine(readText(userAgents(ctx)) ?? ''));
  await editor.fill(`${ctx.agentsSaved}还没保存的一行`);
  await page.locator('.agents-user').getByRole('button', { name: '撤销改动' }).click();
  const reverted = await agentsState(page);
  record('撤销改动：编辑框回到读到的内容，"有未保存的改动"消失', reverted.editor === ctx.agentsSaved
    && reverted.status !== '有未保存的改动', JSON.stringify({ status: reverted.status }));
  await page.locator('.agents-line').getByRole('button', { name: '用系统编辑器打开' }).click();
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

/** 离开 AGENTS.md 一节的入口 */
const LEAVE_TRIGGERS = {
  返回会话: (ctx) => ctx.page.getByRole('button', { name: '返回会话', exact: true }).click(),
  点侧栏的会话: (ctx) => rowOf(ctx.page, ctx.s1).first().click(),
  工具: (ctx) => ctx.page.getByTestId('nav-tools').click(),
  'Ctrl+N': (ctx) => ctx.page.keyboard.press('Control+n'),
  新会话: (ctx) => ctx.page.getByTestId('new-session').click(),
  打开文件夹: (ctx) => ctx.page.getByRole('button', { name: '打开文件夹…' }).first().click(),
  换到另一节: (ctx) => ctx.page.locator('[data-testid="settings-nav"] button[data-section="connections"]').click(),
};

/** @brief 此刻在哪一页：设置页（哪一节）、工具页、会话页（会话面板个数、当前会话文件）。 */
const whereNow = (page) => page.evaluate(() => ({
  settings: Boolean(document.querySelector('[data-testid="settings-page"]')),
  section: document.querySelector('.settings-body .settings-section')?.dataset.section ?? null,
  tools: Boolean(document.querySelector('[data-testid="tools-page"]')),
  panes: document.querySelectorAll('.pane-slot').length,
  active: document.querySelector('.session-item.active')?.dataset.file ?? null }));

/** @brief 选"放弃改动"之后应当到的地方。 */
function leftAsExpected(trigger, now, before, ctx) {
  switch (trigger) {
    case '返回会话': return !now.settings && !now.tools && now.panes === before.panes;
    case '点侧栏的会话': return !now.settings && samePath(now.active, ctx.s1);
    case '工具': return now.tools;
    case 'Ctrl+N': case '新会话': case '打开文件夹': return !now.settings && now.panes === before.panes + 1;
    default: return now.settings && now.section === 'connections';
  }
}

/**
 * @brief 让 AGENTS.md 一节有未保存的改动（不在这一节时先打开）。之前选过"放弃改动"时，先记下重新打开后编辑框是不是
 *        保存过的内容（草稿已丢弃）。
 */
async function makeDirty(ctx) {
  const { page } = ctx;
  if (!(await agentsState(page)).shown) {
    await openSettings(page, 'agents');
    ctx.reopened.push((await agentsState(page)).editor === ctx.agentsSaved);
  }
  const state = await agentsState(page);
  if (state.status !== '有未保存的改动') await page.getByTestId('agents-editor').fill(`${ctx.agentsSaved}未保存的草稿\n`);
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
  const shape = dialog?.title === LEAVE_TITLE && dialog.text === LEAVE_TEXT && dialog.buttons.join() === '放弃改动,继续编辑'
    && dialog.focused === '继续编辑';
  if (answer === 'Escape') await page.keyboard.press('Escape');
  else await page.getByTestId('leave-dialog').getByRole('button', { name: answer, exact: true }).click();
  await page.getByTestId('leave-dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  if (answer === '放弃改动') {
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
    && now.panes === before.panes && now.settings;
  return { trigger, answer, shape, ok, dialog, focused: state.focused };
}

/** @brief 离开时有未保存的改动：每个入口都先问；"继续编辑"（和 Esc）留下、焦点回到编辑框；"放弃改动"照常离开。 */
async function agentsLeave(ctx) {
  const { page } = ctx;
  ctx.reopened = [];
  // "打开文件夹…"的系统对话框已经换成直接返回测试项目（firstRun 里），放弃改动后在测试项目里新建会话。
  const stays = [['返回会话', 'Escape'], ['点侧栏的会话', '继续编辑'], ['工具', 'Escape'], ['Ctrl+N', '继续编辑'],
    ['新会话', '继续编辑'], ['打开文件夹', 'Escape'], ['换到另一节', 'Escape']];
  const leaves = Object.keys(LEAVE_TRIGGERS).map((trigger) => [trigger, '放弃改动']);
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
  const stayed = results.filter((item) => item.answer !== '放弃改动');
  const left = results.filter((item) => item.answer === '放弃改动');
  record('离开时有未保存的改动（返回会话、点侧栏的会话、工具、Ctrl+N、新会话、打开文件夹、换到另一节）：都先弹确认框'
    + '"放弃对 AGENTS.md 的改动？""你改的内容还没有保存。"，按钮"放弃改动""继续编辑"，焦点在"继续编辑"', results.length === 14
    && results.every((item) => item.shape), brief(results));
  record('选"继续编辑"或按 Esc：留在 AGENTS.md，改动还在，焦点回到编辑框，没有新建会话', stayed.every((item) => item.ok),
    brief(stayed));
  record('选"放弃改动"：照常离开（回到会话 / 切到那个会话 / 工具页 / 新建会话 / 打开文件夹新建会话 / 另一节），文件不变',
    left.every((item) => item.ok), brief(left));
  record('放弃改动之后重新打开 AGENTS.md：编辑框是保存过的内容（草稿已丢弃）', ctx.reopened.length >= 4
    && ctx.reopened.every(Boolean), JSON.stringify(ctx.reopened));
  await dragOntoSettings(ctx);
  await cancelledLeave(ctx);
  await archivedLeave(ctx);
}

/** @brief 草稿还在时（旧的做法）撤销改动，免得后面的步骤一离开就弹确认框。 */
async function dropDraft(page) {
  if ((await agentsState(page)).status === '有未保存的改动') {
    await page.locator('.agents-user').getByRole('button', { name: '撤销改动' }).click();
  }
}

/**
 * @brief 选了"放弃改动"、离开却没有发生（"打开文件夹…"里取消了选择；系统对话框换成直接返回取消，synthetic）：
 *        留在 AGENTS.md，编辑框回到读到的内容，没有"有未保存的改动"，没有新会话。
 */
async function cancelledLeave(ctx) {
  const { page, app } = ctx;
  await makeDirty(ctx);
  const before = await whereNow(page);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: '打开文件夹…' }).first().click();
  const dialog = await dialogState(page, 'leave-dialog').catch(() => null);
  await page.getByTestId('leave-dialog').getByRole('button', { name: '放弃改动', exact: true }).click().catch(() => {});
  await page.getByTestId('leave-dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForFunction((want) => document.querySelector('[data-testid="agents-editor"]')?.value === want,
    ctx.agentsSaved, { timeout: 5000 }).catch(() => {});
  await settle(page);
  const state = await agentsState(page);
  const now = await whereNow(page);
  await stubFolder(app, ctx.project);
  record('放弃改动、离开却没有发生（"打开文件夹…"里取消了选择）：留在 AGENTS.md，编辑框回到读到的内容，'
    + '没有"有未保存的改动"，没有新会话', dialog?.title === LEAVE_TITLE && now.settings && now.section === 'agents'
    && now.panes === before.panes && state.editor === ctx.agentsSaved && state.status !== '有未保存的改动',
  JSON.stringify({ dialog: dialog?.title ?? null, now, editor: oneLine(state.editor ?? '', 80),
    status: state.status }));
  await dropDraft(page);
}

/**
 * @brief 有未保存的改动时点"已归档"里的会话（M3：点它会恢复并打开）：先问；"继续编辑"什么都不变（不恢复，留在
 *        AGENTS.md，改动还在）；"放弃改动"才恢复并打开它。用 agentsPrompt 里新建的会话（ctx.after）。
 */
async function archivedLeave(ctx) {
  const { page } = ctx;
  const archived = async () => (await archivedState(page)).rows.some((row) => samePath(row.file, ctx.after));
  const row = page.locator(`[data-testid="archived-list"] .session-item[data-file=${JSON.stringify(ctx.after)}]`);
  await chooseMenuItem(page, ctx.after, '归档');
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
  const asked = await answer('继续编辑');
  const stay = { archived: await archived(), ...(await whereNow(page)), state: await agentsState(page) };
  record('有未保存的改动时点"已归档"里的会话：先问；选"继续编辑"什么都不变（会话仍在"已归档"里、没有恢复，'
    + '留在 AGENTS.md，改动还在，焦点回到编辑框）', asked?.title === LEAVE_TITLE && stay.archived && stay.settings
    && stay.state.editor === `${ctx.agentsSaved}未保存的草稿\n` && stay.state.focused,
  JSON.stringify({ asked: asked?.title ?? null, archived: stay.archived, settings: stay.settings,
    focused: stay.state.focused }));
  if (!stay.archived || !stay.settings) return dropDraft(page);
  await answer('放弃改动');
  const now = await until(async () => {
    const state = await whereNow(page);
    return !state.settings && samePath(state.active, ctx.after) ? state : null;
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
 * @brief 有未保存的改动时把会话拖到设置页上：设置页里不能放下（split.md），所以不离开、也不问，改动还在。
 *        settings.md 把"把会话拖到中栏"列为离开的入口之一，设置页显示时中栏就是设置页，这个入口不存在。
 */
async function dragOntoSettings(ctx) {
  const { page } = ctx;
  await makeDirty(ctx);
  const before = await whereNow(page);
  const during = await dragOver(page, rowOf(page, ctx.s1).first(), page.locator('.settings-body'));
  const dialog = await page.getByTestId('leave-dialog').count();
  const state = await agentsState(page);
  const now = await whereNow(page);
  record('有未保存的改动时把会话拖到设置页上：拖动开始了（会话行变淡），但设置页里不能放下（没有放下提示），松开后不离开、'
    + '不弹确认框，改动还在', during.dragging && during.hint === null && dialog === 0 && state.shown
    && state.editor === `${ctx.agentsSaved}未保存的草稿\n` && now.settings && now.panes === before.panes,
  JSON.stringify({ during, dialog, now }));
  await page.locator('.agents-user').getByRole('button', { name: '撤销改动' }).click();
}

/** @brief agentDir 里有 AGENTS.override.md 时警示"这里写的不会生效"；之后删掉它。 */
async function agentsOverride(ctx) {
  const { page } = ctx;
  const override = join(ctx.userData, 'pi', 'AGENTS.override.md');
  writeFileSync(override, '# override（synthetic）\n');
  if (!(await page.getByTestId('settings-page').count())) await openSettings(page);
  await page.locator('[data-testid="settings-nav"] button[data-section="connections"]').click();
  await openSettings(page, 'agents');
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-effective"]')
    ?.classList.contains('warn'), null, { timeout: 5000 }).catch(() => {});
  const state = await agentsState(page);
  await shot(page, '8-agents-override');
  await page.locator('.agents-line').getByRole('button', { name: '用系统编辑器打开' }).click().catch(() => {});
  const opened = await until(async () => {
    const path = await ctx.app.evaluate(() => globalThis.__opened?.at(-1) ?? null);
    return samePath(path, override) ? path : null;
  }, 3000);
  rmSync(override, { force: true });
  const expected = `生效的是 ${override}，这里写的不会生效`;
  record('agentDir 里有 AGENTS.override.md 时：警示色"生效的是 <它的路径>，这里写的不会生效"；"用系统编辑器打开"打开的是它',
    state.warn === true && state.effective?.toLowerCase() === expected.toLowerCase() && samePath(opened, override),
    JSON.stringify({ effective: state.effective, opened }));
  await back(page);
}

/** @brief 保存失败（AGENTS.md.tmp 被一个文件夹占着）和读取失败（AGENTS.md 是一个文件夹）：显示原文。 */
async function agentsFailures(ctx) {
  const { page } = ctx;
  const path = userAgents(ctx);
  // 上一步从 AGENTS.md 一节"返回会话"：再打开设置页时仍落在"连接与模型"。
  const landed = await landSettings(page);
  record('打开设置页时落在"连接与模型"（上次离开设置页时在 AGENTS.md 一节）', landed.nav === 'connections'
    && landed.body === 'connections', JSON.stringify(landed));
  await openSection(page, 'agents');
  mkdirSync(`${path}.tmp`);
  const draft = `${ctx.agentsSaved}保存会失败的一行\n`;
  await page.getByTestId('agents-editor').fill(draft);
  await page.locator('.agents-user').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agents-status')?.textContent?.startsWith('保存失败：'), null,
    { timeout: 10000 }).catch(() => {});
  const failed = await agentsState(page);
  rmSync(`${path}.tmp`, { recursive: true, force: true });
  record('保存失败（<agentDir>\\AGENTS.md.tmp 被一个文件夹占着）："保存失败："加原文，写的字留在编辑框里，文件不变',
    failed.status?.startsWith('保存失败：') && failed.status.length > 5 && failed.editor === draft
    && readText(path) === ctx.agentsSaved, failed.status ?? '');
  await page.locator('.agents-user').getByRole('button', { name: '撤销改动' }).click();
  renameSync(path, `${path}.bak`);
  mkdirSync(path);
  await page.locator('[data-testid="settings-nav"] button[data-section="connections"]').click();
  await page.locator('[data-testid="settings-nav"] button[data-section="agents"]').click();
  const alert = page.locator('.settings-section[data-section="agents"] [role="alert"]');
  const text = await alert.innerText({ timeout: 10000 }).catch(() => null);
  const editors = await page.getByTestId('agents-editor').count();
  rmSync(path, { recursive: true, force: true });
  renameSync(`${path}.bak`, path);
  record('读取失败（<agentDir>\\AGENTS.md 是一个文件夹）：显示"读取失败："加原文，没有编辑框', text?.startsWith('读取失败：')
    && text.length > 5 && editors === 0, text ?? '');
  await page.locator('[data-testid="settings-nav"] button[data-section="connections"]').click();
  await openSettings(page, 'agents');
  const fixed = await agentsState(page);
  record('修好之后重新打开这一节：编辑框里又是文件的内容', fixed.editor === ctx.agentsSaved, fixed.status ?? '');
  await back(page);
}

/** @brief 项目没有加载 AGENTS.md 或 CLAUDE.md 时，项目级一栏说明没有（另开一个没有这些文件的文件夹）。 */
async function agentsNoProjectFile(ctx) {
  const { page, app } = ctx;
  const other = join(ctx.root, 'm6empty');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'README.md'), '# empty project (synthetic)\n');
  await clickOpenFolder(ctx, other);
  await waitReady(page);
  await openSettings(page, 'agents');
  const state = await agentsState(page);
  record('项目没有加载 AGENTS.md 或 CLAUDE.md 时：标题"m6empty 加载的文件"，说明"这个项目没有加载 AGENTS.md 或 CLAUDE.md"',
    state.loadedTitle === 'm6empty 加载的文件' && state.loadedText.includes('这个项目没有加载 AGENTS.md 或 CLAUDE.md')
    && state.loadedFiles.length === 0, JSON.stringify({ title: state.loadedTitle, files: state.loadedFiles }));
  await back(page);
  await stubFolder(app, ctx.project);
}

/**
 * @brief models.json 被手工改空（"还没有模型"、可以添加连接）或写坏（读取失败的原文、"修好文件后重新打开设置页"）；
 *        改回原样后重新打开设置页，列表回来。
 */
async function brokenModels(ctx) {
  const { page } = ctx;
  const path = join(ctx.userData, 'pi', 'models.json');
  const original = readText(path);
  const settingsButton = page.getByRole('button', { name: '设置', exact: true });
  const leave = () => page.getByRole('button', { name: '返回会话', exact: true }).click();
  writeFileSync(path, '{\n  "providers": {}\n}\n');
  await settingsButton.click();
  await page.locator('.settings-empty').waitFor({ timeout: 10000 }).catch(() => {});
  const empty = { text: await page.locator('.settings-section').innerText(),
    cards: await page.getByTestId('connection-card').count(),
    add: await page.getByRole('button', { name: '添加连接' }).count() };
  await noteSmall(ctx, '设置页还没有模型', '.settings-page');
  await leave();
  writeFileSync(path, '{ "providers": ');
  await settingsButton.click();
  const error = await page.locator('.settings-error').innerText({ timeout: 10000 }).catch(() => null);
  const cardsWhenBroken = await page.getByTestId('connection-card').count();
  await noteSmall(ctx, '设置页读取失败', '.settings-page');
  await shot(page, '9-models-broken');
  await leave();
  writeFileSync(path, original);
  await settingsButton.click();
  await connectionCard(page, MAIN).waitFor({ timeout: 10000 }).catch(() => {});
  const fixed = await page.getByTestId('connection-card').count();
  record('models.json 被手工改空：设置页"还没有模型"，可以"添加连接"', empty.text.includes('还没有模型') && empty.cards === 0
    && empty.add === 1, oneLine(empty.text, 200));
  record('models.json 写坏了：设置页显示读取失败的原文和"修好文件后重新打开设置页"，不显示列表；改回原样后重新打开设置页，列表回来',
    /^Cannot parse .*models\.json/.test(error ?? '') && error.includes('修好文件后重新打开设置页') && cardsWhenBroken === 0
    && fixed === 1, oneLine(error ?? '', 300));
  await back(page);
}

/**
 * @brief settings.json 被手工改坏（synthetic）：列表上方原文（带文件路径）和"修好文件后重新打开设置页。"；列表照常显示，
 *        没有"默认"标记，思考强度是 pi 的默认值（中）。修好后重新打开设置页，错误消失、"默认"回来。
 */
async function brokenSettings(ctx) {
  const { page } = ctx;
  const path = settingsFile(ctx);
  const original = readText(path);
  writeFileSync(path, '{ "defaultProvider": ');
  let broken = null;
  try {
    await landSettings(page);
    await page.getByTestId('connection-card').first().waitFor({ timeout: 10000 }).catch(() => {});
    const error = await page.locator('.settings-error').innerText({ timeout: 3000 }).catch(() => null);
    await noteSmall(ctx, '设置页 settings.json 读不出', '.settings-page');
    broken = { error, row: rowIn(await listState(page), `${MAIN}/fake-coder`),
      defaults: await page.locator('[data-testid="model-row"][data-default="true"]').count() };
    await page.getByRole('button', { name: '返回会话', exact: true }).click();
  } finally {
    writeFileSync(path, original);
  }
  record('settings.json 读不出：列表上方原文（带 settings.json 的路径）和"修好文件后重新打开设置页。"；列表照常显示，'
    + '没有"默认"标记，思考强度是 pi 的默认值', broken.error?.includes('settings.json')
    && broken.error.includes('修好文件后重新打开设置页') && broken.row?.meta === '上下文 128,000 · 支持思考 · 新会话默认 中'
    && broken.defaults === 0, JSON.stringify({ error: oneLine(broken.error ?? '', 200), meta: broken.row?.meta,
    defaults: broken.defaults }));
  await landSettings(page);
  // 设置页先用手上的配置画列表，重新读取的结果随后才到：等"默认"回来。
  await page.locator(`[data-testid="model-row"][data-model="${MAIN}/fake-coder"][data-default="true"]`)
    .waitFor({ timeout: 10000 }).catch(() => {});
  const fixed = { errors: await page.locator('.settings-error').count(), row: rowIn(await listState(page),
    `${MAIN}/fake-coder`) };
  record('修好 settings.json 后重新打开设置页：没有错误，"默认"回到 fake-coder，思考强度回到"高"', fixed.errors === 0
    && fixed.row?.isDefault && fixed.row.meta === '上下文 128,000 · 支持思考 · 新会话默认 高', JSON.stringify(fixed));
  await back(page);
}

/**
 * @brief models.json 里有手工加的 // 注释（pi 允许，synthetic）：列表照常显示；保存模型时"保存失败："、删除模型时
 *        "删除失败："加原文（<路径> contains // comments that saving would remove; …），文件不改。最后去掉注释。
 */
async function commentedModels(ctx) {
  const { page } = ctx;
  const original = readText(modelsFile(ctx));
  const file = JSON.parse(original);
  file.providers[MAIN].models.push({ id: 'fake-extra', name: 'fake-extra', contextWindow: 128000 });
  const commented = `// 手工加的注释（synthetic）\n${JSON.stringify(file, null, 2)}\n`;
  writeFileSync(modelsFile(ctx), commented);
  const result = { save: null, remove: null };
  try {
    await landSettings(page);
    // 设置页先用手上的配置画列表，重新读取的结果随后才到：等文件里新加的 fake-extra（或读取失败的原文）出现。
    await page.waitForFunction((ref) => document.querySelector(`[data-testid="model-row"][data-model="${ref}"]`)
      || document.querySelector('.settings-error'), `${MAIN}/fake-extra`, { timeout: 10000 }).catch(() => {});
    result.cards = (await listState(page)).map((card) => `${card.provider}:`
      + card.models.map((row) => row.id).join('|'));
    result.errors = await page.locator('.settings-error').count();
    if (result.cards.length && !result.errors) await commentedWrites(page, result);
    result.unchanged = readText(modelsFile(ctx)) === commented;
  } finally {
    writeFileSync(modelsFile(ctx), original);
    await leaveSettings(page);
  }
  const pattern = /contains \/\/ comments that saving would remove/;
  record('models.json 里有 // 注释：列表照常显示（pi 读得了，Mori 也读得了），没有读取失败', result.errors === 0
    && result.cards?.join() === `${MAIN}:fake-coder|fake-extra`, JSON.stringify(result.cards ?? null));
  record('有 // 注释时保存模型："保存失败："加原文（会丢掉注释）；删除模型："删除失败："加原文；models.json 不改',
    /^保存失败：/.test(result.save ?? '') && pattern.test(result.save) && /^删除失败：/.test(result.remove ?? '')
    && pattern.test(result.remove) && result.unchanged === true, JSON.stringify(result));
}

/** @brief 在设置页时关掉可能开着的表单和确认框，"返回会话"（步骤中途失败时也回到会话页，免得影响下一步）。 */
async function leaveSettings(page) {
  await page.keyboard.press('Escape').catch(() => {});
  if (await page.getByTestId('settings-page').count()) await back(page).catch(() => {});
}

/** @brief commentedModels 里的两次写入：保存 fake-coder、删除 fake-extra；结果写进 result。 */
async function commentedWrites(page, result) {
  result.save = await editModel(page, 'fake-coder', {});
  if (await page.getByTestId('model-form').count()) {
    await page.getByTestId('model-form').getByRole('button', { name: '取消', exact: true }).click();
  }
  await openDelete(page, `${MAIN}/fake-extra`);
  await page.getByTestId('delete-dialog').getByRole('button', { name: '删除', exact: true }).click();
  const alert = page.getByTestId('delete-dialog').locator('[role="alert"]');
  result.remove = await alert.innerText({ timeout: 10000 }).catch(() => null);
  if (await page.getByTestId('delete-dialog').count()) {
    await page.getByTestId('delete-dialog').getByRole('button', { name: '取消', exact: true }).click();
  }
}

/**
 * @brief 默认模型已经不在（models.json 被手工改掉了 fake-coder，synthetic）：在这个连接上添加模型 fake-fresh，
 *        它成为默认。之后把 models.json 改回原样，原样保存一次 fake-coder：默认又不在了（fake-fresh 没了），fake-coder 成为默认。
 */
async function defaultGone(ctx) {
  const { page } = ctx;
  const original = readText(modelsFile(ctx));
  const file = JSON.parse(original);
  file.providers[MAIN].models = [{ id: 'fake-renamed', name: 'fake-renamed', contextWindow: 128000 }];
  writeJson(modelsFile(ctx), file);
  try {
    await landSettings(page);
    // 设置页先用手上的配置画列表，重新读取的结果随后才到：等文件里的 fake-renamed 出现。
    await modelRow(page, `${MAIN}/fake-renamed`).waitFor({ timeout: 10000 });
    const gone = await page.locator('[data-testid="model-row"][data-default="true"]').count();
    const added = await addModel(page, MAIN, 'fake-fresh');
    const fresh = rowIn(await listState(page), `${MAIN}/fake-fresh`);
    const settings = settingsJson(ctx);
    record('保存时默认模型已经不在（models.json 里被手工去掉，列表里没有标"默认"的行）：新添加的模型 fake-fresh 成为默认',
      gone === 0 && added === null && fresh?.isDefault && settings.defaultProvider === MAIN
      && settings.defaultModel === 'fake-fresh',
    JSON.stringify({ gone, added, fresh, default: settings.defaultModel }));
  } finally {
    writeFileSync(modelsFile(ctx), original);
    await leaveSettings(page);
  }
  await landSettings(page);
  await modelRow(page, `${MAIN}/fake-coder`).waitFor({ timeout: 10000 });
  await page.waitForFunction((ref) => !document.querySelector(`[data-testid="model-row"][data-model="${ref}"]`),
    `${MAIN}/fake-fresh`, { timeout: 10000 }).catch(() => {});
  const saved = await editModel(page, 'fake-coder', {});
  const row = rowIn(await listState(page), `${MAIN}/fake-coder`);
  record('改回原样后编辑保存 fake-coder：默认模型 fake-fresh 已经不在，fake-coder 成为默认（settings.json 恢复）',
    saved === null && row?.isDefault && settingsJson(ctx).defaultModel === 'fake-coder',
    JSON.stringify({ saved, row }));
  await back(page);
}

// ---------- 步骤：窄栏 ----------

/** 思考强度的界面文字（models.md） */
const LEVEL_TEXT = { off: '关', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
/** @brief 会话面板宽度落在 models.md"窄栏"的哪一档。 */
const bucketOf = (width) => (width > 720 ? '宽' : width > 600 ? '较窄' : width > 400 ? '窄' : '很窄');

/** @brief 把窗口内容区设成 width 宽、右栏开或关，等界面量好新宽度；返回这一刻的样子和两个菜单是否在面板里。 */
async function narrowSample(ctx, width, right) {
  const { page, app } = ctx;
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 800), width);
  await page.waitForFunction((w) => window.innerWidth === w, width, { timeout: 5000 }).catch(() => {});
  const toggle = paneOf(page).getByRole('button', { name: '右栏：本会话的改动' });
  if ((await toggle.getAttribute('aria-pressed')) !== String(right)) await toggle.click();
  await settle(page);
  await settle(page);
  const state = await topbarState(page);
  const inside = { model: await menuInside(page, 'model-button', 'model-menu'),
    thinking: await menuInside(page, 'thinking-button', 'thinking-menu') };
  return { window: width, right, bucket: bucketOf(state.pane), ...state, inside };
}

/** @brief 样本里思考按钮应有的强度文字（不支持思考时"不可选"）。 */
const labelOf = (sample) => (sample.reasoning === 'true' ? LEVEL_TEXT[sample.level] : '不可选');

/** @brief 一个样本不符合它那一档（models.md"窄栏"）的地方（读屏名称另查）；都符合时为空。 */
function narrowProblems(sample) {
  const label = labelOf(sample);
  const problems = [];
  if (!sample.model || !sample.thinking) problems.push('按钮没有显示');
  const wide = sample.bucket === '宽' || sample.bucket === '较窄';
  if (sample.thinkingText !== (wide ? `思考：${label}` : label)) problems.push(`思考按钮文字 ${sample.thinkingText}`);
  if (sample.modelWidth > (sample.bucket === '宽' ? 160 : 120) || sample.modelWidth < 40) problems.push('模型按钮宽度');
  if (sample.bucket === '很窄' ? sample.modelIcon || sample.thinkingIcon : !sample.modelIcon || !sample.thinkingIcon) {
    problems.push('▾');
  }
  if (!wide && !(sample.inside.model && sample.inside.thinking)) problems.push('菜单伸出面板');
  return problems;
}

/**
 * @brief models.md"窄栏"：窗口宽度和右栏开关组合出会话面板的几档宽度（宽 > 720、较窄 ≤ 720、窄 ≤ 600、很窄 ≤ 400），
 *        每档两个按钮都在、能点开；思考按钮窄时只显示强度，很窄时去掉 ▾；窄时两个菜单不伸出面板。最后恢复窗口。
 */
async function narrowTopbar(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  const samples = [];
  for (const [width, right] of [[1200, false], [900, false], [800, false], [1400, true], [1200, true], [800, true]]) {
    samples.push(await narrowSample(ctx, width, right));
  }
  await shot(page, '10-narrow-topbar');
  await narrowSample(ctx, 1200, false);
  for (const bucket of ['宽', '较窄', '窄', '很窄']) {
    const hit = samples.filter((sample) => sample.bucket === bucket);
    const bad = hit.map((sample) => ({ window: sample.window, right: sample.right, pane: sample.pane,
      problems: narrowProblems(sample) })).filter((item) => item.problems.length);
    record(`窄栏"${bucket}"：模型和思考按钮都在、能点开，思考按钮${bucket === '宽' || bucket === '较窄' ? '"思考：<强度>"'
      : '只显示强度'}${bucket === '很窄' ? '、去掉 ▾' : ''}${bucket === '窄' || bucket === '很窄' ? '，菜单不伸出会话面板' : ''}`,
    hit.length > 0 && bad.length === 0, JSON.stringify(bad.length ? bad : hit.map((sample) => ({ window: sample.window,
      right: sample.right, pane: sample.pane, text: sample.thinkingText, model: sample.modelWidth }))));
  }
  const names = samples.map((sample) => ({ pane: sample.pane, name: sample.thinkingName,
    want: `思考：${labelOf(sample)}` }));
  record('窄栏各档思考按钮的读屏名称都是完整的"思考：<强度>"（收起的文字在读屏名称里）',
    names.every((item) => item.name === item.want), JSON.stringify(names));
}

// ---------- 步骤：重启与收尾 ----------

/** @brief 重新打开的会话：pi 按会话记录恢复思考强度（关掉前在 S1 切到了"低"，它的默认是"高"）。 */
async function reopen(ctx) {
  await closeWithDraft(ctx);
  await startApp(ctx);
  const { page } = ctx;
  await page.getByTestId('session-tree').waitFor({ timeout: 60000 });
  await rowOf(page, ctx.s1).first().waitFor({ timeout: 30000 });
  await noSession(ctx);
  await rowOf(page, ctx.s1).first().click();
  await waitReady(page);
  await paneOf(page).getByTestId('thinking-button').waitFor({ timeout: 15000 });
  const thinking = await buttonState(page, 'thinking-button');
  const model = await buttonState(page, 'model-button');
  record('重启后重新打开会话：按会话记录恢复思考强度（关掉 Mori 前切到"低"，不是这个模型的默认"高"），模型仍是 fake-coder',
    thinking.level === 'low' && thinking.text === '思考：低' && model.text === 'fake-coder',
    JSON.stringify({ thinking, model: model.text }));
  const reply = await sendIn(page, 'which model');
  record('编辑连接写 models.json 失败时刚填的 key 已撤回（credentials.json 恢复成原来的 key）：重启后从 credentials.json '
    + '读入 key，会话照常能用，回复来自 fake-coder', ctx.keyRollback === true && reply.fresh
    && reply.text === '模型：fake-coder', JSON.stringify({ text: reply.text,
    errors: reply.newErrors.map((text) => oneLine(text, 160)) }));
}

/**
 * @brief AGENTS.md 有未保存的改动时关闭 Mori 窗口（主进程里关窗口，同点右上角的关闭）：不问，直接关闭（Mori 退出），
 *        AGENTS.md 不变（settings.md"关闭 Mori 窗口时不问"）。
 */
async function closeWithDraft(ctx) {
  const { page } = ctx;
  await openSettings(page, 'agents');
  await page.getByTestId('agents-editor').fill(`${ctx.agentsSaved}关窗口前没保存的一行\n`);
  const status = (await agentsState(page)).status;
  const closed = ctx.app.waitForEvent('close', { timeout: 30000 }).then(() => true, () => false);
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  const ok = await closed;
  if (!ok) await ctx.app.close().catch(() => {});
  record('AGENTS.md 有未保存的改动时关闭 Mori 窗口：不问，直接关闭；AGENTS.md 不变', status === '有未保存的改动' && ok
    && readText(userAgents(ctx)) === ctx.agentsSaved, JSON.stringify({ status, closed: ok }));
}

/** @brief 重启后还没有打开会话时：AGENTS.md 一节的项目级说明"打开一个会话后…"。重启后自动打开了会话时记为失败（没有覆盖）。 */
async function noSession(ctx) {
  const { page } = ctx;
  const panes = await page.locator('.pane-slot').count();
  if (panes > 0) {
    record('没有打开的会话时：项目级一栏"打开一个会话后，这里列出它的项目加载了哪些文件。"', false,
      `${panes} pane(s) open after restart; this state cannot be reached here`);
    return;
  }
  await openSettings(page, 'agents');
  const state = await agentsState(page);
  record('没有打开的会话时（重启后还没点开会话）：项目级一栏"打开一个会话后，这里列出它的项目加载了哪些文件。"',
    state.loadedText.includes('打开一个会话后，这里列出它的项目加载了哪些文件。') && state.loadedFiles.length === 0,
    oneLine(state.loadedText, 200));
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 5000 });
}

/** @brief 新加的界面（设置页、表单、确认框、顶栏的模型与思考菜单）没有小于 12px 的字。 */
async function fontSizes(ctx) {
  record(`新加的界面没有小于 12px 的文字（看过：${[...new Set(ctx.smallChecked)].join('、')}）`, ctx.small.length === 0,
    ctx.small.slice(0, 6).join('; '));
}

const steps = { firstRun, settingsList, addModel: addModelStep, setDefault, testModel, secondConnection, topbarMenu,
  switchModel: switchModelStep, goToSettings, editEndpoint, deleteModels, otherProvider, keylessConnection,
  writeFailures, piModelsError, thinkingUnsupported, markReasoning, thinkingLevels, unmarkReasoning, agentsUser,
  agentsPrompt, agentsLeave, agentsOverride, agentsFailures, agentsNoProjectFile, brokenModels, brokenSettings,
  commentedModels, defaultGone, narrowTopbar, reopen, fontSizes };

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
