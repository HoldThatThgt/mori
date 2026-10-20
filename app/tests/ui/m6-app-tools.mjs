// M6 整机测试（工具页）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖 docs/v0/screens/tools.md 与方案第 7 节 M6 走查 3–6 和反例：
// 入口（左栏"打开文件夹…"下面、收起后的图标栏、高亮）、没有会话时只有技能和插件、跟随的会话（还在打开中时等它、分屏时
// 焦点所在的一栏）、读取中 / 读取失败与重新读取、返回会话（分屏、焦点、滚动位置、草稿）、工具页开着时点左栏别的会话、
// 新建会话、不监视文件；内置工具（启用的正是发给模型的、扩展的来源和两行说明）；
// 技能（没有技能、来源标记、展开看正文和路径、用系统编辑器打开、收起、与 pi config 相同的写入——逐步对照
// tests/fixtures/m6/pi-config-toggles.json、写入失败与再试、本项目设置停用 / 启用的用户级技能只读、技能的问题列表、
// 未信任项目的技能不列出、停用后新会话的"/"和系统提示里没有它）；
// 用户级提示词模板在页面上没有开关，STEPS 里那一步经开关用的同一条后台进程命令 resource.toggle 发出；
// MCP（没有服务、表单添加、编辑与改名、以 JSON 编辑新的和已有的、HTTP 服务、几种保存失败、v0 调用方式的警示与"改为直接调用"、
// 启停、移除、新会话注册的工具名、命令写错时 pi 的原文和完整通知、没有注册工具的服务不显示"已连接"、调用出批准卡、
// 本项目的服务只读、mcp.json 读不出与用系统编辑器打开）；
// 插件（添加本地包不复制文件、添加失败、按资源启停、停用 / 启用整个包、移除、包里扩展的工具与批准卡、包里没有资源、本项目的包、
// 未信任项目的包和扩展不列出）；
// 键盘（Tab 走到开关和按钮、↑ ↓ 切分节、Esc 关表单和确认框）；没有小于 12px 的字；页面没有报错。
// "用系统编辑器打开"只在主进程的 shell.openPath 换成记录路径之后才点（不真的打开编辑器）。
// 布局与 tests/ui/m6-pi-config.mjs 相同（prepareLayout、STEPS）：MORI_USER_DATA=<根>/data，agentDir=<根>/data/pi。
// 合成的东西：端点、MCP 服务（tests/mcp-server）、pi 包（tests/pi-package 的副本）、下面写的技能和配置文件都是 synthetic。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-tools.mjs [--exe <Mori.exe 路径>]
// 结果写到 test-results/m6-app-tools(-packaged).json，截图在 test-results/m6-app-tools(-packaged)/。
// 各步骤按顺序依赖前一步留下的配置（pi config 的对照是累积的），所以不提供 --only。

import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, answerTrustDialog, chooseMenuItem, lastToolCard, paneOf, rowOf, settle, stubFolder, topTitle, until,
  waitIdle, waitPanes, waitReady,
} from './m3-helpers.mjs';
import { composerAt, paneAt, sendAt, splitState, waitPaneIdle, waitPaneReady, waitSplit } from './m5-helpers.mjs';
import { openToolsSection, slashItems, startFakeEndpoint } from './m6-helpers.mjs';
import { prepareLayout, STEPS } from './m6-pi-config.mjs';
import { pageHelpers } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const port = 4362;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m6-tools-not-a-real-key';
const shots = join(appRoot, `test-results/m6-app-tools${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** pi config 的写入（m6-pi-config.mjs 录制） */
const fixture = JSON.parse(readFileSync(join(appRoot, 'tests/fixtures/m6/pi-config-toggles.json'), 'utf8'));
/** 合成 MCP 服务（synthetic） */
const MCP_SERVER = join(appRoot, 'tests', 'mcp-server', 'server.mjs');
/** 添加本地包后设置里写的来源（相对 agentDir） */
const PKG_SOURCE = '..\\..\\pkg';
const NO_SESSION = '没有打开的会话：只列出技能和插件（用户级）';
const NOTICE = '启停和添加对新建的会话生效，已经打开的会话不变。';
const TRUST_NOTE = '没有信任这个文件夹，它自带的技能和配置不列出';
const DISABLED_BY_PROJECT = '本项目的 .pi/settings.json 把它停用了，只能在项目里改';
const ENABLED_BY_PROJECT = '本项目的 .pi/settings.json 把它启用了，只能在项目里改';
const PROJECT_MCP = '本项目的 .pi/mcp.json，只能在项目里改';
const PKG_NOTE = '内网只支持本地文件夹的包，包要自带依赖';
const PROJECT_SETTINGS = '本项目的设置，只能在项目里改';
const NO_RESOURCES = '这个文件夹里没有找到扩展、技能、提示词或主题';
/** 项目技能用途里的标记（合成端点 "agents check" 认 MORI-AGENTS-<字母数字>） */
const PROJ_MARKER = 'MORI-AGENTS-PROJSKILL';
/** 没有技能时的说明（后面接 agentDir 的路径） */
const NO_SKILLS = (agentDir) => `还没有技能。把技能文件夹（含 SKILL.md）放进 ${agentDir}\\skills 或项目的 .pi\\skills，`
  + '或添加一个插件。';
/** override 项目的扩展注册的工具（synthetic）：说明有两行，行里只显示第一行 */
const MULTI_TOOL = 'override_multi';
const MULTI_FIRST = 'First line of the synthetic override tool.';
const MULTI_DESC = `${MULTI_FIRST}\nSecond line, only shown when expanded.`;
/** 用户级 mcp.json 里一个 HTTP 服务的地址（synthetic，停用，从不连接） */
const REMOTE_URL = 'http://127.0.0.1:9/mcp';

// ---------- 准备 ----------

/** @brief 写一个技能文件夹（synthetic）；description 为 null 时不写 description（pi 报"description is required"）。 */
function writeSkill(dir, name, description) {
  mkdirSync(dir, { recursive: true });
  const meta = description === null ? `name: ${name}` : `name: ${name}\ndescription: ${description}`;
  writeFileSync(join(dir, 'SKILL.md'), `---\n${meta}\n---\n# ${name}\n\nsynthetic\n`);
}

/** @brief 写 JSON 文件（2 空格缩进加换行）。 */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @brief synthetic 项目扩展的源码：注册一个不带参数的工具 name，说明为 description（可以有好几行）。 */
function extensionSource(name, description) {
  return [
    `// synthetic: written by tests/ui/m6-app-tools.mjs; registers ${name}.`,
    'export default function (pi) {',
    '  pi.registerTool({',
    `    name: ${JSON.stringify(name)},`,
    `    label: ${JSON.stringify(name)},`,
    `    description: ${JSON.stringify(description)},`,
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    '    async execute() {',
    `      return { content: [{ type: 'text', text: ${JSON.stringify(`hello from ${name}`)} }], details: {} };`,
    '    },',
    '  });',
    '}',
    '',
  ].join('\n');
}

/** @brief 写一个 synthetic 项目扩展 <项目>/.pi/extensions/<file>，返回它的路径。 */
function writeExtension(project, file, name, description) {
  const path = join(project, '.pi', 'extensions', file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, extensionSource(name, description));
  return path;
}

/**
 * @brief 准备布局：m6-pi-config.mjs 的 prepareLayout（用户级技能和提示词、已信任项目的技能、包的副本），再加两个项目：
 *        untrusted（.pi/skills、.pi/mcp.json、.pi/extensions 和写了包的 .pi/settings.json，打开时选"不信任"）；
 *        override（已信任：.pi/settings.json 照 pi config -l 的写法停用用户级技能、一个缺 description 的技能、
 *        .pi/mcp.json 里一个项目服务和对用户级服务 x 的覆盖、一个注册两行说明的工具的扩展）。
 */
function makeLayout() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-tools-'));
  const layout = prepareLayout(root);
  writeFileSync(join(layout.project, 'README.md'), '# Mori fixture project\n\nsynthetic\n');
  // 项目技能的用途里放一个标记：合成端点的 "agents check" 规则据此回答系统提示（pi 的 <available_skills>）里有没有它。
  // 只改说明，路径不变（与 pi config 的对照只看路径）。
  writeSkill(join(layout.project, '.pi', 'skills', 'proj-skill'), 'proj-skill',
    `Synthetic project test skill (${PROJ_MARKER}).`);
  const untrusted = join(root, 'untrusted');
  writeSkill(join(untrusted, '.pi', 'skills', 'untrusted-skill'), 'untrusted-skill',
    'Synthetic skill of an untrusted project.');
  writeJson(join(untrusted, '.pi', 'mcp.json'),
    { mcpServers: { untrustedsrv: { command: 'node', args: [MCP_SERVER], exposure: 'direct' } } });
  writeJson(join(untrusted, '.pi', 'settings.json'), { packages: [PKG_SOURCE] });
  writeExtension(untrusted, 'untrusted-ext.ts', 'untrusted_hello', 'Synthetic tool of an untrusted project.');
  const override = join(root, 'override');
  const extFile = writeExtension(override, 'multi-line.ts', MULTI_TOOL, MULTI_DESC);
  const userSkill = join(layout.agentDir, 'skills', 'user-skill', 'SKILL.md');
  // pi config -l 停用继承来的用户级资源的写法：先写它的路径，再写 "-路径"（config-selector setProjectTopLevelOverride）；
  // 再加一个本项目的包（相对 .pi 文件夹，即 <根>/pkg）。
  writeJson(join(override, '.pi', 'settings.json'), { skills: [userSkill, `-${userSkill}`], packages: [PKG_SOURCE] });
  writeSkill(join(override, '.pi', 'skills', 'bad-skill'), 'bad-skill', null);
  writeJson(join(override, '.pi', 'mcp.json'), { mcpServers: {
    projsrv: { command: 'node', args: [MCP_SERVER], exposure: 'direct' }, x: { enabled: false } } });
  return { root, ...layout, untrusted, override, userSkill, extFile, userData: join(root, 'data') };
}

/**
 * @brief 工具页 MCP 一节开始前写进用户级 mcp.json 的内容（synthetic）：没写 exposure 的、命令写错的、不注册工具的、
 *        停用的，和一个停用的 HTTP 服务（只看地址和"编辑"，pi 不会去连它）。
 */
function initialMcp() {
  return {
    $comment: 'synthetic: written by tests/ui/m6-app-tools.mjs; Mori must keep it as is',
    mcpServers: {
      legacy: { command: 'node', args: [MCP_SERVER], description: 'synthetic server without exposure' },
      broken: { command: 'no-such-command-xyz', exposure: 'direct' },
      empty: { command: 'node', args: [MCP_SERVER], env: { MORI_MCP_TOOLS: 'none' }, exposure: 'direct' },
      'my-tool': { command: 'node', args: [MCP_SERVER], exposure: 'direct', enabled: false },
      remote: { url: REMOTE_URL, exposure: 'direct', enabled: false },
    },
  };
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
}

// ---------- 磁盘 ----------

/** @brief 读 JSON 文件；不存在时为 null。 */
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
/** @brief 深拷贝。 */
const clone = (value) => JSON.parse(JSON.stringify(value));
/** @brief 用户级 mcp.json 的路径。 */
const mcpPath = (ctx) => join(ctx.agentDir, 'mcp.json');

/** @brief 此刻的用户级 settings.json 和已信任项目的 .pi/settings.json。 */
function settingsNow(ctx) {
  return { user: readJson(join(ctx.agentDir, 'settings.json')),
    project: readJson(join(ctx.project, '.pi', 'settings.json')) };
}

/**
 * @brief 等两份设置变成 want（用户级的前面加上首次启动时 Mori 写的默认模型，键的顺序也要相同），记一条检查。
 *        JSON.stringify 比较：数组、条目和键的顺序都算。
 */
async function expectSettings(ctx, name, want) {
  const expected = { user: want.user === null ? null : { ...ctx.baseline, ...want.user }, project: want.project };
  const matches = () => JSON.stringify(settingsNow(ctx)) === JSON.stringify(expected);
  await until(matches, 10000, 100);
  record(name, matches(), JSON.stringify({ actual: settingsNow(ctx), expected }));
}

/** @brief 对照 fixture 的第 index 份快照（0 是"加入本地包之后"，之后每份对应 STEPS 的一步）。 */
function expectSnapshot(ctx, index, how) {
  const snapshot = fixture.snapshots[index];
  return expectSettings(ctx, `技能启停写法与 pi config 相同（对照第 ${index} 份「${snapshot.what}」，${how}）：`
    + '用户级 settings.json 和项目的 .pi/settings.json 与 pi config 逐项相同', snapshot);
}

// ---------- 页面 ----------

/** @brief 工具页的外框：分节、当前分节、跟随的会话、说明、信任说明、整页文字；不在工具页时为 null。 */
function toolsHead(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="tools-page"]');
    if (!root) return null;
    const text = (element) => element?.textContent?.trim() ?? '';
    return {
      sections: [...root.querySelectorAll('[data-testid="tools-nav"] button[data-section]')]
        .map((b) => b.dataset.section),
      current: root.querySelector('[data-testid="tools-nav"] [aria-current="page"]')?.dataset.section ?? null,
      follow: text(root.querySelector('[data-testid="tools-follow"]')),
      notice: text(root.querySelector('.tools-notice span')),
      newSession: [...root.querySelectorAll('.tools-notice button')].some((b) => b.textContent.includes('新建会话')),
      trust: text(root.querySelector('[data-testid="tools-trust"]')) || null,
      title: text(root.querySelector('.topbar .chat-title')),
      back: [...root.querySelectorAll('.topbar button')].some((b) => b.textContent.includes('返回会话')),
      text: root.innerText,
    };
  });
}

/** @brief "技能"一节的行（开关：aria-checked、是否不可用）。 */
function skillRows(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    const sw = (row) => row.querySelector('[role="switch"]');
    return [...document.querySelectorAll('[data-testid="skill-row"]')].map((row) => ({
      name: row.dataset.name, scope: row.dataset.scope, tag: text(row.querySelector('.tools-tag')),
      desc: text(row.querySelector('.tools-row-desc')), off: row.classList.contains('off'),
      checked: sw(row)?.getAttribute('aria-checked') === 'true', disabled: sw(row)?.disabled ?? null,
      notes: [...row.querySelectorAll('.tools-row-note')].map(text),
      error: text(row.querySelector('.form-message.error')),
    }));
  });
}

/** @brief "内置工具"一节的行。 */
function toolRows(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    return [...document.querySelectorAll('[data-testid="tool-row"]')].map((row) => ({
      name: row.dataset.tool, active: row.dataset.active, tag: text(row.querySelector('.tools-tag')),
      state: text(row.querySelector('.tools-state')), desc: text(row.querySelector('.tools-row-desc')) }));
  });
}

/** @brief "MCP"一节的行。 */
function mcpRows(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    const sw = (row) => row.querySelector('[role="switch"]');
    return [...document.querySelectorAll('[data-testid="mcp-row"]')].map((row) => ({
      name: row.dataset.server, tags: [...row.querySelectorAll('.tools-tag')].map(text),
      off: row.classList.contains('off'),
      checked: sw(row)?.getAttribute('aria-checked') === 'true', disabled: sw(row)?.disabled ?? null,
      command: text(row.querySelector('.tools-mono')), tools: text(row.querySelector('[data-testid="mcp-tools"]')),
      error: [...row.querySelectorAll('[data-testid="mcp-error"] > p')].map(text),
      fullNotice: Boolean(row.querySelector('[data-testid="mcp-error"] details')),
      warn: [...row.querySelectorAll('.tools-warn')].map(text).join(' | '),
      direct: Boolean(row.querySelector('[data-testid="mcp-direct"]')),
      notes: [...row.querySelectorAll('.tools-row-note:not([data-testid])')].map(text),
      buttons: [...row.querySelectorAll('.tools-row-actions button')]
        .map((b) => ({ text: text(b), disabled: b.disabled })),
    }));
  });
}

/** @brief "插件"一节的卡。 */
function packageCards(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    const sw = (row) => row.querySelector('[role="switch"]');
    return [...document.querySelectorAll('[data-testid="package-card"]')].map((card) => ({
      source: card.dataset.source, tag: text(card.querySelector('.tools-card-head .tools-tag')),
      root: text(card.querySelector(':scope > .tools-mono')),
      groups: [...card.querySelectorAll('.tools-group h3')].map(text),
      actions: [...card.querySelectorAll('.tools-card-head button')]
        .map((b) => ({ text: text(b), disabled: b.disabled })),
      resources: [...card.querySelectorAll('[data-testid="package-resource"]')].map((row) => ({
        kind: row.dataset.kind, path: row.dataset.path, name: text(row.querySelector('.tools-row-name')),
        tags: [...row.querySelectorAll('.tools-tag')].map(text),
        checked: sw(row)?.getAttribute('aria-checked') === 'true',
        disabled: sw(row)?.disabled ?? null })),
    }));
  });
}

/** @brief 工具页里一个技能行。 */
const skillRow = (page, name) => page.locator(`[data-testid="skill-row"][data-name="${name}"]`);
/** @brief 工具页里一个 MCP 服务行。 */
const mcpRow = (page, name) => page.locator(`[data-testid="mcp-row"][data-server="${name}"]`);
/** @brief 包的卡（来源按 CSS 字符串写，反斜杠要转义）。 */
const packageCard = (page) => page.locator(`[data-testid="package-card"][data-source=${JSON.stringify(PKG_SOURCE)}]`);

/** @brief 等 selector 里的开关显示 want 且可用（命令和之后的重新读取都结束）。 */
function waitSwitch(page, selector, want, timeout = 15000) {
  return page.waitForFunction(({ css, value }) => {
    const toggle = document.querySelector(css);
    return Boolean(toggle) && !toggle.disabled && toggle.getAttribute('aria-checked') === String(value);
  }, { css: `${selector} [role="switch"]`, value: want }, { timeout });
}

/** @brief 点技能行的开关，等它显示 want。 */
async function flipSkill(page, name, want) {
  await skillRow(page, name).getByRole('switch').click();
  await waitSwitch(page, `[data-testid="skill-row"][data-name="${name}"]`, want);
}

/** @brief 点"返回会话"，等会话面板出现（没有会话时等"打开一个文件夹"）。 */
async function backToChat(page) {
  await page.getByTestId('tools-page').getByRole('button', { name: '返回会话' }).click();
  await page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 });
  await settle(page);
}

/** @brief 工具页顶部的"新建会话"：等新的一栏出现并就绪，返回它在界面里的标识。 */
async function newFromTools(page) {
  const before = await page.locator('.pane-slot').count();
  await page.getByTestId('tools-page').locator('.tools-notice').getByRole('button', { name: '新建会话' }).click();
  await waitPanes(page, before + 1);
  await waitReady(page);
  await settle(page);
  return page.locator('.pane-slot:not([hidden])').first().getAttribute('data-tab');
}

/** @brief MCP 一节保存之后"已保存 · 新建的会话才会连接它"后面的"新建会话"：在跟随的项目里新建一个会话并切过去。 */
async function newFromSaved(ctx) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  const saved = page.getByTestId('tools-page').locator('.form-message.ok');
  const text = await saved.innerText({ timeout: 5000 }).catch(() => '');
  await saved.getByRole('button', { name: '新建会话' }).click();
  await waitPanes(page, before + 1);
  await waitReady(page);
  await settle(page);
  const heading = await paneOf(page).locator('.empty-chat h1').innerText({ timeout: 5000 }).catch(() => '');
  record('保存后"已保存 · 新建的会话才会连接它"后面的"新建会话"：在跟随的项目里新建一个会话并切过去',
    text.startsWith('已保存 · 新建的会话才会连接它') && heading === 'project', JSON.stringify({ text, heading }));
  return page.locator('.pane-slot:not([hidden])').first().getAttribute('data-tab');
}

/** @brief 点左栏"打开文件夹…"选 folder；trust 为 '信任' / '不信任' 时回答信任询问。 */
async function openFolder(ctx, folder, trust, remember = false) {
  await stubFolder(ctx.app, folder);
  await ctx.page.getByRole('button', { name: '打开文件夹…' }).first().click();
  if (trust) await answerTrustDialog(ctx.page, { answer: trust, remember });
  else await waitReady(ctx.page);
  await settle(ctx.page);
}

/** @brief 在输入框打 "/"，等补全列表读好，返回各项；之后 Esc 关掉、清空输入框。 */
async function slashList(ctx) {
  const { page, h } = ctx;
  await h.textarea.fill('/');
  await page.waitForFunction(() => {
    const menu = document.querySelector('[data-testid="slash-menu"]');
    return Boolean(menu) && !menu.textContent.includes('正在读取…');
  }, null, { timeout: 15000 });
  const items = (await slashItems(page)) ?? [];
  await page.keyboard.press('Escape');
  await h.textarea.fill('');
  return items;
}

/** @brief 发一条消息，等批准卡出现，按 Alt+1 允许，等这一轮结束；返回卡的工具名、标题和工具卡的结果。 */
async function callAndAllow(ctx, text) {
  const { page, h } = ctx;
  await h.send(text);
  const card = paneOf(page).getByTestId('approval-card');
  await card.waitFor({ timeout: 30000 });
  const tool = await card.getAttribute('data-tool');
  const title = (await card.getByTestId('approval-title').innerText()).trim();
  await page.keyboard.press('Alt+1');
  await card.waitFor({ state: 'detached', timeout: 10000 });
  await waitIdle(page, 60000);
  const result = await lastToolCard(page);
  return { tool, title, result };
}

/** @brief 工具页（和开着的移除确认框）里小于 12px 的文字。 */
function toolsSmallText(page) {
  const selector = '[data-testid="tools-page"] *, [data-testid="remove-dialog"] *';
  return page.evaluate((css) => [...document.querySelectorAll(css)]
    .filter((element) => element.getClientRects().length > 0
      && [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12)
    .map((element) => `${element.tagName.toLowerCase()}.${element.className} ${getComputedStyle(element).fontSize} `
      + `"${element.textContent.trim().slice(0, 20)}"`), selector);
}

/** @brief 记下此刻工具页里小于 12px 的文字（最后统一判断）。 */
async function noteSmall(ctx, where) {
  const small = await toolsSmallText(ctx.page);
  ctx.small.push(...small.map((item) => `${where}: ${item}`));
  ctx.smallChecked.push(where);
}

/** @brief 焦点所在的元素的简短描述。 */
function focusDescriptor(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName?.toLowerCase() ?? null, role: el?.getAttribute?.('role') ?? null,
      label: el?.getAttribute?.('aria-label') ?? null, text: (el?.textContent ?? '').trim().slice(0, 20),
      section: el?.dataset?.section ?? null, inTools: Boolean(el?.closest?.('[data-testid="tools-page"]')) };
  });
}

/** @brief 从当前焦点按 Tab count 次，返回每次的焦点。 */
async function tabWalk(page, count) {
  const seen = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Tab');
    seen.push(await focusDescriptor(page));
  }
  return seen;
}

/** @brief 两个值的 JSON 相同（顺序也算）。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** @brief 对象的键排好序之后的值（只比内容、不比键的顺序时用）。 */
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]));
}

/**
 * @brief 主进程的 shell.openPath 换成只记下路径（不真的打开外部编辑器）；返回替换是否生效。
 *        没生效时调用方不点"用系统编辑器打开"，免得在测试机上真的打开文件。
 */
function stubOpenPath(app) {
  return app.evaluate(({ shell }) => {
    globalThis.__moriOpened = [];
    shell.openPath = async (path) => {
      globalThis.__moriOpened.push(path);
      return '';
    };
    return String(shell.openPath).includes('__moriOpened');
  });
}

/** @brief 换掉 shell.openPath 之后，"用系统编辑器打开"交给主进程的路径。 */
const openedPaths = (app) => app.evaluate(() => globalThis.__moriOpened ?? []);

/** @brief 点"用系统编辑器打开"（在 scope 里），等主进程收到一个路径，返回它；替换没生效时不点、返回 null。 */
async function clickOpenInEditor(ctx, scope) {
  if (!(await stubOpenPath(ctx.app))) return null;
  await scope.getByRole('button', { name: '用系统编辑器打开' }).first().click();
  await until(async () => (await openedPaths(ctx.app)).length > 0, 5000, 100);
  return (await openedPaths(ctx.app))[0] ?? '';
}

/**
 * @brief 开始记录工具页有没有显示过"正在读取…"（MutationObserver：只出现一两帧，轮询抓不到），
 *        以及有没有出现过读取失败、"新建会话"不可用（跟随的会话还在打开中）。
 */
function watchTools(page) {
  return page.evaluate(() => {
    window.__toolsSeen = { loading: false, error: false, opening: false };
    window.__toolsObserver?.disconnect();
    window.__toolsObserver = new MutationObserver(() => {
      const root = document.querySelector('[data-testid="tools-page"]');
      if (!root) return;
      const seen = window.__toolsSeen;
      if ([...root.querySelectorAll('.tools-empty[role="status"]')].some((p) => p.textContent === '正在读取…')) {
        seen.loading = true;
      }
      if (root.querySelector('[data-testid="tools-error"]')) seen.error = true;
      const button = [...root.querySelectorAll('.tools-notice button')].find((b) => b.textContent.includes('新建会话'));
      if (button?.disabled) seen.opening = true;
    });
    window.__toolsObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  });
}

/** @brief watchTools 开始之后看到的。 */
const toolsSeen = (page) => page.evaluate(() => {
  window.__toolsObserver?.disconnect();
  return window.__toolsSeen;
});

/**
 * @brief 表单里文字为 label 的那一栏的输入框。不用 getByLabel：React 挂载 textarea 时把初值写成它的文字内容，
 *        有初值的 textarea（例如"回到表单"之后的参数）按标签全文匹配不到。
 */
const field = (form, label) => form.locator(`label:has(> span:text-is("${label}"))`).locator('input, textarea');

/** @brief 表单里逐项填写名称、命令、参数。 */
async function fillFields(page, { name, command, args }) {
  const form = page.getByTestId('mcp-form');
  await field(form, '名称').fill(name);
  await field(form, '命令').fill(command);
  await field(form, '参数').fill(args);
}

/** @brief 点表单的"保存"，等表单关上或出现"保存失败"；返回表单是否还开着、失败的文字、名称框和"已保存"的文字。 */
async function submitForm(page) {
  await page.getByTestId('mcp-form').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => {
    const form = document.querySelector('[data-testid="mcp-form"]');
    if (!form) return true;
    const busy = [...form.querySelectorAll('button')].some((button) => button.textContent.includes('正在保存'));
    return !busy && Boolean(form.querySelector('.form-message.error'));
  }, null, { timeout: 15000 });
  return page.evaluate(() => {
    const form = document.querySelector('[data-testid="mcp-form"]');
    const saved = [...document.querySelectorAll('[data-testid="tools-page"] .form-message.ok')]
      .map((item) => item.textContent.trim()).join(' ');
    return { open: Boolean(form), error: form?.querySelector('.form-message.error')?.textContent?.trim() ?? '',
      name: form?.querySelector('input')?.value ?? null, saved,
      values: [...(form?.querySelectorAll('input, textarea') ?? [])].map((input) => input.value) };
  });
}

/** @brief 出错之后回到能继续的样子：关掉浮层，离开工具页。 */
async function recover(ctx) {
  await ctx.page?.keyboard.press('Escape').catch(() => {});
  const onTools = await ctx.page?.getByTestId('tools-page').isVisible().catch(() => false);
  if (onTools) await backToChat(ctx.page).catch(() => {});
}

// ---------- 步骤 ----------

/** @brief 准备：首次启动填连接；打开已信任（勾"记住"）的项目，发一条消息（pi 在第一条回复后才写会话文件）。 */
async function setup(ctx) {
  await startApp(ctx);
  const { page, h } = ctx;
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  await h.fillConnection({ name: '合成端点', baseUrl, apiKey: testKey, modelId: 'fake-coder' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  await openFolder(ctx, ctx.project, '信任', true);
  await h.send('plain hello');
  await h.idle(60000);
  ctx.p1 = await activeFile(page);
  ctx.p1Title = await topTitle(page);
  record('准备：首次启动填连接，打开已信任（记住）的项目并发一条消息', Boolean(ctx.p1), ctx.p1 ?? '');
}

/**
 * @brief 没有技能：把用户级 skills 文件夹暂时挪开（这时没有会话、也还没有包），技能一节显示"还没有技能。…"
 *        和 agentDir 的路径；之后挪回来。
 */
async function noSkills(ctx) {
  const { page } = ctx;
  const skills = join(ctx.agentDir, 'skills');
  const away = join(ctx.root, 'skills-away');
  renameSync(skills, away);
  try {
    await openToolsSection(page, 'skills');
    const text = await page.locator('[data-testid="tools-page"] .tools-content').innerText();
    record('没有技能：技能一节"还没有技能。把技能文件夹（含 SKILL.md）放进 <agentDir>\\skills 或项目的 .pi\\skills，'
      + '或添加一个插件。"，没有技能行', text.includes(NO_SKILLS(ctx.agentDir)) && (await skillRows(page)).length === 0,
    oneLine(text, 300));
    await noteSmall(ctx, '没有技能');
    await backToChat(page);
  } finally {
    renameSync(away, skills);
  }
}

/** @brief 重启后没有打开的会话：工具页只有技能和插件；在这里添加本地包（对照 fixture 第 0 份）和两种添加失败。 */
async function noSession(ctx) {
  await ctx.app.close();
  await startApp(ctx);
  const { page } = ctx;
  await rowOf(page, ctx.p1).first().waitFor({ timeout: 60000 });
  const panes = await page.locator('.pane-slot').count();
  await noSkills(ctx);
  await openToolsSection(page, 'skills');
  const head = await toolsHead(page);
  record('没有打开的会话：分节只有"技能""插件"，顶部"返回会话"、标题"工具"、"没有打开的会话：只列出技能和插件（用户级）"，'
    + '下面一行说明和"新建会话"', panes === 0 && same(head.sections, ['skills', 'plugins']) && head.follow === NO_SESSION
    && head.title === '工具' && head.back && head.notice === NOTICE && head.newSession,
  JSON.stringify({ panes, ...head, text: undefined }));
  const skills = await skillRows(page);
  record('没有会话时技能只列用户级的：user-skill 标"用户级"，有用途和开关；项目的 proj-skill 不在',
    same(skills.map((row) => row.name), ['user-skill']) && skills[0].tag === '用户级' && skills[0].checked
    && skills[0].desc === 'Synthetic user-level test skill.', JSON.stringify(skills));
  await noteSmall(ctx, '没有会话 · 技能');
  await addPackage(ctx);
  await openToolsSection(page, 'skills');
  const withPackage = await skillRows(page);
  record('加了包之后（没有会话）技能里出现包里的 package-review，标"插件 ..\\..\\pkg"',
    withPackage.some((row) => row.name === 'package-review' && row.scope === 'package'
      && row.tag === `插件 ${PKG_SOURCE}`),
    JSON.stringify(withPackage.map((row) => [row.name, row.tag])));
  await backToChat(page);
  await followOpening(ctx);
}

/**
 * @brief 跟随的会话还在打开中时进入工具页：点左栏的会话（从磁盘打开，要一会儿），马上点"工具"。
 *        工具页跟随它、等它打开好再读取（不读错、不报错），之后列出它注册的工具。
 *        打开得太快、没赶上"打开中"时，只检查最后的样子（细节里写明有没有赶上）。
 */
async function followOpening(ctx) {
  const { page } = ctx;
  await watchTools(page);
  await rowOf(page, ctx.p1).first().click();
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="tool-row"]').length > 0, null,
    { timeout: 30000 });
  const seen = await toolsSeen(page);
  const head = await toolsHead(page);
  const tools = (await toolRows(page)).map((tool) => tool.name);
  record('会话还在打开中时点"工具"：工具页跟随它（"project · <会话名>"、四个分节），等它打开好再读取，'
    + `列出它注册的工具，没有出现读取失败（${seen.opening ? '赶上了打开中："新建会话"那时不可用' : '没赶上打开中'}）`,
  head.follow === `project · ${ctx.p1Title}` && same(head.sections, ['builtin', 'skills', 'mcp', 'plugins'])
    && tools.includes('read') && !seen.error && seen.loading, JSON.stringify({ seen, follow: head.follow, tools }));
  await backToChat(page);
  await waitReady(page);
  await settle(page);
}

/** @brief 插件 → 添加本地包…（系统对话框换成直接返回 <根>/pkg），再试两种添加失败。 */
async function addPackage(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'plugins');
  ctx.baseline = readJson(join(ctx.agentDir, 'settings.json')) ?? {};
  record('首次启动后用户级 settings.json 只有 Mori 写的默认模型（之后的对照把 pi config 的写入接在它后面）',
    Object.keys(ctx.baseline).every((key) => ['defaultProvider', 'defaultModel'].includes(key)),
    JSON.stringify(ctx.baseline));
  const empty = await page.getByTestId('tools-page').innerText();
  const filesBefore = readdirSync(ctx.agentDir).sort();
  await stubFolder(ctx.app, ctx.pkg);
  await page.getByRole('button', { name: '添加本地包…' }).click();
  await packageCard(page).waitFor({ timeout: 20000 });
  await expectSnapshot(ctx, 0, '插件 → 添加本地包…');
  const filesAfter = readdirSync(ctx.agentDir).sort();
  record('添加本地包不复制文件：agentDir 里的文件和文件夹与添加前相同（只改了 settings.json 的内容），包的文件夹原样',
    same(filesBefore, filesAfter) && existsSync(join(ctx.pkg, 'extensions', 'package-hello.ts')),
    JSON.stringify({ filesBefore, filesAfter }));
  const [card] = await packageCards(page);
  const theme = card.resources.find((item) => item.kind === 'themes');
  record('添加本地包：先是"还没有插件"和说明"内网只支持本地文件夹的包，包要自带依赖"；新的卡写来源 ..\\..\\pkg、用户级、'
    + '解析后的文件夹，按扩展、技能、提示词、主题分组，主题标"Mori 不使用"，每个资源一个开关',
  empty.includes('还没有插件') && empty.includes(PKG_NOTE) && card.source === PKG_SOURCE && card.tag === '用户级'
    && card.root.toLowerCase() === ctx.pkg.toLowerCase() && same(card.groups, ['扩展', '技能', '提示词', '主题'])
    && card.resources.length === 4 && theme?.tags.includes('Mori 不使用') && card.resources.every((item) => item.checked),
  JSON.stringify(card));
  await noteSmall(ctx, '没有会话 · 插件');
  await stubFolder(ctx.app, ctx.pkg);
  await page.getByRole('button', { name: '添加本地包…' }).click();
  const again = await addFailure(page, '');
  await expectSnapshot(ctx, 0, '再添加同一个文件夹之后');
  record('添加失败：再添加同一个文件夹，显示"没能添加："加说明，只有一张卡', again.startsWith('没能添加：')
    && (await packageCards(page)).length === 1, again);
  await stubFolder(ctx.app, join(ctx.root, 'no-such-folder'));
  await page.getByRole('button', { name: '添加本地包…' }).click();
  const missing = await addFailure(page, again);
  record('添加失败：文件夹不存在，显示"没能添加："加原文', missing.startsWith('没能添加：') && missing.includes('no-such-folder'),
    missing);
}

/** @brief 等"添加本地包…"下面的失败文字出现（与 previous 不同），返回它。 */
async function addFailure(page, previous) {
  await page.waitForFunction((old) => {
    const button = document.querySelector('.tools-add button');
    const text = document.querySelector('.tools-add .form-message.error')?.textContent ?? '';
    return Boolean(button) && !button.disabled && button.textContent.includes('添加本地包') && text && text !== old;
  }, previous, { timeout: 15000 });
  return page.locator('.tools-add .form-message.error').innerText();
}

/** @brief 左栏"工具"的位置：nav 里按钮的顺序、文字、是否在"打开文件夹…"下面。 */
function navPlace(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-testid="sidebar"] .sidebar-nav');
    const labels = [...nav.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    const open = nav.querySelector('button[aria-label="打开文件夹…"]').getBoundingClientRect();
    const tools = nav.querySelector('[data-testid="nav-tools"]');
    return { labels, text: tools.textContent.trim(), below: tools.getBoundingClientRect().top >= open.bottom - 1 };
  });
}

/** @brief 发 "list tools"（合成端点回答请求里给模型的全部工具名），返回这些名字。 */
async function modelTools(ctx) {
  await ctx.h.send('list tools');
  await ctx.h.idle(60000);
  const reply = await paneOf(ctx.page).getByTestId('assistant').last().innerText({ timeout: 5000 }).catch(() => '');
  return /可用的工具：([^\n]*)/.exec(reply)?.[1].split(',').map((name) => name.trim()).filter(Boolean) ?? [];
}

/** @brief 入口与外框：位置、高亮、跟随的会话、分节、读取中、内置工具、返回会话（草稿还在）、收起为图标栏时的入口。 */
async function entry(ctx) {
  const { page, h } = ctx;
  const title = await topTitle(page);
  ctx.modelTools = await modelTools(ctx);
  const draft = '草稿：去工具页再回来之后还在';
  await h.textarea.fill(draft);
  await watchTools(page);
  await openToolsSection(page, 'builtin');
  const seen = await toolsSeen(page);
  const head = await toolsHead(page);
  const place = await navPlace(page);
  const lit = await page.getByTestId('nav-tools').evaluate((element) => element.classList.contains('active'));
  record('有会话时：左栏"打开文件夹…"下面的"工具"高亮；分节"内置工具""技能""MCP""插件"；顶部"返回会话"、标题"工具"、'
    + '"project · <会话名>"、说明一行和"新建会话"', lit && place.text === '工具' && place.below
    && place.labels.indexOf('工具') === place.labels.indexOf('打开文件夹…') + 1
    && same(head.sections, ['builtin', 'skills', 'mcp', 'plugins']) && head.current === 'builtin' && head.back
    && head.title === '工具' && head.follow === `project · ${title}` && head.notice === NOTICE && head.newSession
    && !head.trust, JSON.stringify({ title, place, ...head, text: undefined }));
  record('进入工具页先显示"正在读取…"，tools.get 读完换成内容（没有读取失败）', seen.loading && !seen.error
    && !head.text.includes('正在读取…'), JSON.stringify(seen));
  await builtinRows(ctx);
  await backToChat(page);
  const back = { file: await activeFile(page), draft: await h.textarea.inputValue(),
    lit: await page.getByTestId('nav-tools').evaluate((element) => element.classList.contains('active')) };
  record('返回会话：回到原来的会话，草稿还在，"工具"不再高亮', back.file === ctx.p1 && back.draft === draft && !back.lit,
    JSON.stringify(back));
  await h.textarea.fill('');
  await railEntry(ctx);
}

/** @brief "内置工具"一节：read、bash、edit、write 的行，说明一行，展开看完整说明。 */
async function builtinRows(ctx) {
  const { page } = ctx;
  const tools = await toolRows(page);
  const core = ['read', 'bash', 'edit', 'write'].map((name) => tools.find((tool) => tool.name === name));
  const lead = await page.locator('[data-testid="tools-page"] .tools-lead').innerText();
  record('内置工具：read、bash、edit、write 各一行，来源"内置"、状态"启用"（data-active）、说明的第一行；'
    + '标题下"当前会话注册的全部工具。启用的才会给模型。"', core.every((tool) => tool && tool.active === 'true'
    && tool.tag === '内置' && tool.state === '启用' && tool.desc) && lead === '当前会话注册的全部工具。启用的才会给模型。',
  JSON.stringify(tools));
  const inactive = tools.filter((tool) => tool.active === 'false');
  record(`注册了但没有给模型的工具标"未启用"（这个会话里有 ${inactive.length} 个），启用的标"启用"`,
    tools.every((tool) => tool.state === (tool.active === 'true' ? '启用' : '未启用')),
    JSON.stringify(inactive.map((tool) => tool.name)));
  const active = tools.filter((tool) => tool.active === 'true').map((tool) => tool.name).sort();
  record('"启用"的正是这个会话发给模型的工具（合成端点 "list tools" 读到的请求里的工具名），"未启用"的都没有发',
    ctx.modelTools.length > 0 && same(active, [...ctx.modelTools].sort())
    && inactive.every((tool) => !ctx.modelTools.includes(tool.name)),
  JSON.stringify({ active, model: ctx.modelTools }));
  // 挑一个说明有好几行的工具（行里只显示第一行），展开后应看到全部
  const name = await page.evaluate(() => [...document.querySelectorAll('[data-testid="tool-row"]')]
    .find((row) => row.querySelector('.tools-body')?.textContent?.includes('\n'))?.dataset.tool ?? 'read');
  const row = page.locator(`[data-testid="tool-row"][data-tool="${name}"]`);
  await row.locator('summary').click();
  const full = await row.locator('.tools-body').innerText({ timeout: 5000 }).catch(() => '');
  const first = tools.find((tool) => tool.name === name)?.desc ?? '';
  const open = await row.locator('details').evaluate((element) => element.open);
  const many = full.includes('\n');
  record(`点一个工具展开看完整说明（${name}：${many ? '行里只有第一行，展开后是全部' : '这个会话的工具说明都只有一行，展开后是同一段全文'}）`,
    open && full.startsWith(first) && (many ? full.length > first.length : full.trim() === first), oneLine(full, 160));
  await noteSmall(ctx, '内置工具');
}

/** @brief 收起为图标栏：入口是图标按钮"工具"，点它打开工具页并高亮；再展开左栏。 */
async function railEntry(ctx) {
  const { page } = ctx;
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]')?.classList.contains('collapsed'),
    null, { timeout: 5000 });
  const rail = await page.getByTestId('nav-tools').evaluate((element) => ({ shown: element.getClientRects().length > 0,
    name: element.getAttribute('aria-label'), icon: Boolean(element.querySelector('svg')),
    labelHidden: getComputedStyle(element.querySelector('.nav-label')).display === 'none' }));
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  const lit = await page.getByTestId('nav-tools').evaluate((element) => element.classList.contains('active'));
  await shot(page, '1-rail');
  record('收起为图标栏时"工具"是图标按钮（名称"工具"），点它打开工具页并高亮', rail.shown && rail.name === '工具'
    && rail.labelHidden && rail.icon && lit, JSON.stringify({ ...rail, lit }));
  await backToChat(page);
  await page.getByRole('button', { name: /^展开侧栏/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="sidebar"]')?.classList.contains('collapsed'),
    null, { timeout: 5000 });
}

/** @brief 技能：来源标记、展开、再按 STEPS 逐步启停并对照 pi config 的写入；第 5 步后新建会话看"/"补全。 */
async function skills(ctx) {
  const { page } = ctx;
  const before = await agentsCheck(ctx);
  record(`对照：项目技能启用时创建的会话，发给模型的系统提示里有它（用途里的 ${PROJ_MARKER}）`, before.includes(PROJ_MARKER),
    before);
  await openToolsSection(page, 'skills');
  const rows = await skillRows(page);
  const by = (name) => rows.find((row) => row.name === name);
  record('技能的来源：user-skill 标"用户级"、proj-skill 标"本项目"、包里的 package-review 标"插件 ..\\..\\pkg"；'
    + '每行有用途和开关（都启用）', by('user-skill')?.scope === 'user' && by('user-skill').tag === '用户级'
    && by('proj-skill')?.scope === 'project' && by('proj-skill').tag === '本项目'
    && by('package-review')?.scope === 'package' && by('package-review').tag === `插件 ${PKG_SOURCE}`
    && rows.every((row) => row.desc && row.checked && !row.disabled), JSON.stringify(rows));
  const row = skillRow(page, 'user-skill');
  await row.locator('button.tools-row-main').click();
  const detail = { path: await row.locator('.tools-path .tools-mono').innerText({ timeout: 5000 }),
    body: await row.locator('.tools-body').innerText(), editor: await row.locator('.tools-path').innerText(),
    expanded: await row.locator('button.tools-row-main').getAttribute('aria-expanded') };
  record('点技能展开：SKILL.md 的正文（去掉 frontmatter）和文件路径，旁边"用系统编辑器打开"', detail.path === ctx.userSkill
    && detail.body.startsWith('# user-skill') && detail.body.includes('synthetic')
    && !detail.body.includes('description:')
    && detail.editor.includes('用系统编辑器打开') && detail.expanded === 'true', JSON.stringify(detail));
  await noteSmall(ctx, '技能 · 展开');
  const opened = await clickOpenInEditor(ctx, row.locator('.tools-path'));
  const openError = await row.locator('.tools-path .form-message.error').count();
  record('点"用系统编辑器打开"：把这个 SKILL.md 的路径交给系统打开（主进程 shell.openPath，测试里换成只记下路径），'
    + '没有"没能打开"', opened !== null && resolve(opened).toLowerCase() === ctx.userSkill.toLowerCase()
    && openError === 0, String(opened));
  await row.locator('button.tools-row-main').click();
  await row.locator('.tools-detail').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const folded = { detail: await row.locator('.tools-detail').count(),
    expanded: await row.locator('button.tools-row-main').getAttribute('aria-expanded') };
  record('再点一次收起：正文和路径不再显示', folded.detail === 0 && folded.expanded === 'false', JSON.stringify(folded));
  for (const [index, step] of STEPS.entries()) {
    await doStep(ctx, step, index + 1);
    if (index === 4) await slashAfterDisable(ctx);
  }
  await noteSmall(ctx, '技能');
}

/** @brief 按 STEPS 的一步启停（技能用工具页的开关），然后对照 fixture 的第 index 份快照。 */
async function doStep(ctx, step, index) {
  const { page } = ctx;
  const target = join(ctx.root, step.path);
  const want = step.what.startsWith('重新启用');
  if (step.kind === 'prompts') {
    // 工具页没有用户级提示词模板的开关（状态表只列技能、包里的资源）：发开关用的同一条后台进程命令
    await page.evaluate((command) => window.mori.request(command),
      { type: 'resource.toggle', kind: 'prompts', path: target, enabled: want });
    return expectSnapshot(ctx, index, '页面上没有这一项的开关，经后台进程命令 resource.toggle');
  }
  await openToolsSection(page, 'skills');
  const name = basename(dirname(target));
  await flipSkill(page, name, want);
  const row = (await skillRows(page)).find((item) => item.name === name);
  record(`${step.what}（${name}）：开关${want ? '打开、行不再变淡' : '关上、行变淡'}，没有"没能保存"`,
    Boolean(row) && row.checked === want && row.off === !want && !row.error, JSON.stringify(row));
  return expectSnapshot(ctx, index, `工具页"技能"里 ${name} 的开关`);
}

/** @brief 停用项目技能之后：工具页"新建会话"，新会话的"/"补全里没有停用的技能和提示词模板。 */
async function slashAfterDisable(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'skills');
  ctx.p2 = await newFromTools(page);
  const heading = await paneOf(page).locator('.empty-chat h1').innerText({ timeout: 5000 }).catch(() => '');
  record('工具页的"新建会话"：在跟随的项目里新建一个会话并切过去', Boolean(ctx.p2) && heading === 'project', heading);
  const names = (await slashList(ctx)).map((item) => item.name);
  record('反例：停用之后新建的会话，"/"补全里没有停用的 proj-skill、package-review 和 user-prompt，'
    + '仍有 user-skill 和包里的 package-summary', names.includes('skill:user-skill') && names.includes('package-summary')
    && !['skill:proj-skill', 'skill:package-review', 'user-prompt'].some((name) => names.includes(name)),
  names.join(', '));
  const reply = await agentsCheck(ctx);
  record('反例：停用之后新建的会话，发给模型的系统提示（pi 的 <available_skills>）里没有 proj-skill',
    reply.includes('系统提示里没有标记'), reply);
}

/**
 * @brief 分屏：右边放 p1（长回复，滚到中间，写一段草稿），焦点在右边时工具页跟随 p1，返回会话后分屏、焦点、滚动位置
 *        和草稿都在；焦点换到左边（p2）再进，跟随 p2。最后关掉左边一栏，回到单栏（之后的步骤按单栏写）。
 */
async function splitFollow(ctx) {
  const { page } = ctx;
  await backToChat(page);
  await chooseMenuItem(page, ctx.p1, '在右侧分屏打开');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  await sendAt(page, 'right', 'long reply');
  await waitPaneIdle(page, 'right');
  const scroller = paneAt(page, 'right').locator('.conversation');
  const scroll = await scroller.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  const draft = '分屏右边的草稿';
  await composerAt(page, 'right').fill(draft);
  const before = await splitState(page);
  await openToolsSection(page, 'builtin');
  const right = (await toolsHead(page)).follow;
  await backToChat(page);
  const after = await splitState(page);
  const restored = { top: await scroller.evaluate((el) => el.scrollTop),
    draft: await composerAt(page, 'right').inputValue() };
  record('分屏、焦点在右边：工具页跟随右边的会话（"project · <它的名字>"）；返回会话后分屏和焦点照旧、'
    + `右边的滚动位置（${scroll.top}/${scroll.max}）和草稿都在`, right === `project · ${before.focusedTitle}`
    && before.slots[1]?.focused && after.split && same(after.slots.map((s) => [s.key, s.focused]),
    before.slots.map((s) => [s.key, s.focused])) && scroll.max > 100 && Math.abs(restored.top - scroll.top) <= 2
    && restored.draft === draft,
  JSON.stringify({ right, before: before.slots, after: after.slots, scroll, restored }));
  await composerAt(page, 'right').fill('');
  await composerAt(page, 'left').click();
  await openToolsSection(page, 'builtin');
  const left = (await toolsHead(page)).follow;
  await backToChat(page);
  const again = await splitState(page);
  record('焦点换到左边一栏再进工具页：跟随左边的会话；返回后仍是分屏、焦点在左边', left === `project · ${again.slots[0]?.title}`
    && again.split && again.slots[0]?.focused && !again.slots[1]?.focused,
  JSON.stringify({ left, slots: again.slots }));
  await paneAt(page, 'left').getByTestId('close-pane').click();
  await waitSplit(page, false);
  await settle(page);
}

/** @brief 发 "agents check"（合成端点回答系统提示里有没有 MORI-AGENTS 标记），等这一轮结束，返回回复的文字。 */
async function agentsCheck(ctx) {
  await ctx.h.send('agents check');
  await ctx.h.idle(60000);
  return paneOf(ctx.page).getByTestId('assistant').last().innerText({ timeout: 5000 }).catch(() => '');
}

/** @brief 插件：按资源启停、停用 / 启用整个包、新会话里包的工具和批准卡、移除。 */
async function plugins(ctx) {
  const { page } = ctx;
  const base = fixture.snapshots.at(-1);
  await openToolsSection(page, 'plugins');
  const [card] = await packageCards(page);
  const review = card?.resources.find((item) => item.kind === 'skills');
  record('插件卡上包里的技能 package-review 是停用的（与技能一节同一个设置），其余三项启用', Boolean(review) && !review.checked
    && card.resources.filter((item) => item !== review).every((item) => item.checked)
    && card.actions[0]?.text === '停用整个包',
  JSON.stringify(card));
  const ext = '[data-testid="package-resource"][data-kind="extensions"]';
  await packageCard(page).locator(ext).getByRole('switch').click();
  await waitSwitch(page, ext, false);
  const off = clone(base.user);
  off.packages[0].extensions = ['-extensions\\package-hello.ts'];
  await expectSettings(ctx, '插件里按资源停用扩展：packages 里这个包加上 extensions ["-extensions\\package-hello.ts"]'
    + '（pi config 的 togglePackageResource 写法）', { user: off, project: base.project });
  await packageCard(page).locator(ext).getByRole('switch').click();
  await waitSwitch(page, ext, true);
  const on = clone(base.user);
  on.packages[0].extensions = ['+extensions\\package-hello.ts'];
  await expectSettings(ctx, '再启用扩展：同一项改成 "+extensions\\package-hello.ts"', { user: on, project: base.project });
  await wholePackage(ctx, base);
  await packageTool(ctx);
  await removePackage(ctx, base);
  await emptyPackage(ctx);
}

/**
 * @brief 包里没有资源：添加一个 package.json 的 pi 字段为空的文件夹，卡里说明找不到资源、只有"移除"；移除后 packages 回到 []。
 *        （pi 1.3.0 把既没有 pi 字段、也没有 extensions / skills / prompts / themes 文件夹的本地文件夹整个当作一个扩展
 *        ——package-manager.js resolveLocalExtensionSource——所以这里用空的 pi 字段。）
 */
async function emptyPackage(ctx) {
  const { page } = ctx;
  const folder = join(ctx.root, 'emptypkg');
  writeJson(join(folder, 'package.json'), { name: 'mori-empty-package', private: true,
    description: 'synthetic: a pi package without resources', pi: {} });
  await openToolsSection(page, 'plugins');
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: '添加本地包…' }).click();
  const card = page.locator('[data-testid="package-card"]').filter({ hasText: 'emptypkg' });
  await card.waitFor({ timeout: 15000 });
  const [entry] = await packageCards(page);
  const text = await card.innerText();
  record('包里没有资源：卡里"这个文件夹里没有找到扩展、技能、提示词或主题（…）"，没有资源开关，只有"移除"',
    text.includes(NO_RESOURCES) && entry.resources.length === 0
    && same(entry.actions.map((item) => item.text), ['移除']),
    JSON.stringify(entry));
  await card.getByRole('button', { name: '移除' }).click();
  await page.getByTestId('remove-dialog').getByRole('button', { name: '移除' }).click();
  await card.waitFor({ state: 'detached', timeout: 15000 });
  record('移除这个空包之后用户级设置的 packages 又是 []', same(settingsNow(ctx).user?.packages, []),
    JSON.stringify(settingsNow(ctx).user));
}

/** @brief 停用整个包（四类都写 []）、启用整个包（写回字符串来源）。 */
async function wholePackage(ctx, base) {
  const { page } = ctx;
  await packageCard(page).getByRole('button', { name: '停用整个包' }).click();
  await packageCard(page).getByRole('button', { name: '启用整个包' }).waitFor({ timeout: 15000 });
  const none = clone(base.user);
  none.packages[0] = { source: PKG_SOURCE, extensions: [], skills: [], prompts: [], themes: [] };
  await expectSettings(ctx, '停用整个包：这个包的扩展、技能、提示词、主题都写成 []', { user: none, project: base.project });
  const [offCard] = await packageCards(page);
  record('停用整个包之后四个资源的开关全部关上，按钮变成"启用整个包"', offCard.resources.length === 4
    && offCard.resources.every((item) => !item.checked) && offCard.actions[0]?.text === '启用整个包',
  JSON.stringify(offCard));
  await shot(page, '2-package-off');
  await packageCard(page).getByRole('button', { name: '启用整个包' }).click();
  await packageCard(page).getByRole('button', { name: '停用整个包' }).waitFor({ timeout: 15000 });
  const all = clone(base.user);
  all.packages[0] = PKG_SOURCE;
  await expectSettings(ctx, '启用整个包：去掉过滤，packages 里写回字符串 "..\\..\\pkg"', { user: all, project: base.project });
  const [onCard] = await packageCards(page);
  record('启用整个包之后四个资源的开关全部打开，按钮变回"停用整个包"', onCard.resources.length === 4
    && onCard.resources.every((item) => item.checked) && onCard.actions[0]?.text === '停用整个包', JSON.stringify(onCard));
  await noteSmall(ctx, '插件');
}

/** @brief 启用整个包之后新建会话：内置工具里有 package_hello；调用它出批准卡。 */
async function packageTool(ctx) {
  const { page } = ctx;
  ctx.p3 = await newFromTools(page);
  await openToolsSection(page, 'builtin');
  const tools = await toolRows(page);
  const hello = tools.find((tool) => tool.name === 'package_hello');
  record('新建的会话：内置工具里有包里扩展注册的 package_hello，来源"插件 ..\\..\\pkg"、启用',
    hello?.tag === `插件 ${PKG_SOURCE}` && hello.active === 'true',
    JSON.stringify(hello ?? tools.map((tool) => tool.name)));
  await backToChat(page);
  const call = await callAndAllow(ctx, 'call tool: package_hello');
  record('反例：调用插件里扩展注册的工具出批准卡；Alt+1 允许后结果 "hello from package"', call.tool === 'package_hello'
    && call.result.body.includes('hello from package'), JSON.stringify(call));
}

/** @brief 移除插件：确认框（Esc 关掉不改），确认后卡消失、packages 里没有它、文件夹还在。 */
async function removePackage(ctx, base) {
  const { page } = ctx;
  await openToolsSection(page, 'plugins');
  const before = JSON.stringify(settingsNow(ctx));
  await packageCard(page).getByRole('button', { name: '移除' }).click();
  const dialog = page.getByTestId('remove-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  await noteSmall(ctx, '插件 · 移除确认框');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  record('移除插件先确认："移除插件 ..\\..\\pkg？只从设置里去掉它，文件夹不删。…"；Esc 关掉确认框、设置不变',
    text.includes(`移除插件 ${PKG_SOURCE}？`) && text.includes('文件夹不删') && JSON.stringify(settingsNow(ctx)) === before
    && (await packageCard(page).count()) === 1, text);
  await packageCard(page).getByRole('button', { name: '移除' }).click();
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: '移除' }).click();
  await packageCard(page).waitFor({ state: 'detached', timeout: 15000 });
  const removed = clone(base.user);
  removed.packages = [];
  await expectSettings(ctx, '确认移除：卡消失，用户级设置的 packages 变成 []（pi removeSourceFromSettings）',
    { user: removed, project: base.project });
  record('移除插件不删文件夹', existsSync(join(ctx.pkg, 'package.json')), ctx.pkg);
}

/**
 * @brief MCP 列表：写进用户级 mcp.json 的五个服务（这个会话在写之前创建，所以都还没有注册工具）。
 *        工具页只在进入时和改动之后读取、不监视文件：开着工具页写文件，页面不变；离开再进入才读到。
 */
async function mcpList(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'mcp');
  const empty = await page.getByTestId('tools-page').innerText();
  const add = page.getByTestId('tools-page').getByRole('button', { name: '添加', exact: true });
  record('还没有 mcp.json 时：MCP 一节"还没有 MCP 服务"和"添加"', empty.includes('还没有 MCP 服务')
    && (await add.isEnabled()) && (await mcpRows(page)).length === 0, oneLine(empty, 200));
  ctx.mcpOriginal = initialMcp();
  writeJson(mcpPath(ctx), ctx.mcpOriginal);
  // 检查"不发生"只能等一段时间：1.5 秒内页面仍是原样（不监视文件、不轮询）。
  await sleep(1500);
  const still = { empty: (await toolsHead(page)).text.includes('还没有 MCP 服务'), rows: (await mcpRows(page)).length };
  await backToChat(page);
  await openToolsSection(page, 'mcp');
  const rows = await mcpRows(page);
  record('不监视文件：工具页开着时写 mcp.json，1.5 秒后页面仍是"还没有 MCP 服务"；离开再进入才列出五个服务',
    still.empty && still.rows === 0 && rows.length === 5, JSON.stringify({ still, after: rows.length }));
  await mcpListRows(ctx, rows);
  await remoteEdit(ctx);
}

/** @brief 列表里的各个服务：来源、调用方式、命令行或地址、开关、v0 的警示、还没有注册工具。 */
async function mcpListRows(ctx, rows) {
  const { page } = ctx;
  const by = (name) => rows.find((row) => row.name === name);
  record('MCP 列出用户级 mcp.json 的服务：名字、"用户级"、调用方式、命令行（command 加 args）或地址（url）、开关；'
    + '停用的 my-tool、remote 行变淡', same(rows.map((row) => row.name), ['legacy', 'broken', 'empty', 'my-tool', 'remote'])
    && rows.every((row) => row.tags[0] === '用户级') && by('legacy').command === `node ${MCP_SERVER}`
    && by('broken').command === 'no-such-command-xyz' && by('broken').tags[1] === '直接调用'
    && by('remote').command === REMOTE_URL && by('remote').off && !by('remote').checked
    && by('my-tool').off && !by('my-tool').checked && by('legacy').checked && !by('legacy').off, JSON.stringify(rows));
  record('没写 exposure 的服务：标 codemode，警示色"v0 只支持直接调用（现在是 codemode）：模型调用不到它的工具"和"改为直接调用"；'
    + '写了 direct 的服务没有这条警示', by('legacy').tags[1] === 'codemode' && by('legacy').direct
    && by('legacy').warn.includes('v0 只支持直接调用（现在是 codemode）：模型调用不到它的工具')
    && rows.filter((row) => row.name !== 'legacy').every((row) => !row.direct && !row.warn), by('legacy').warn);
  record('写 mcp.json 之前创建的会话：每个服务都是"当前会话里它没有注册工具"（改动只对新建的会话生效），没有"已连接"',
    rows.every((row) => row.tools === '当前会话里它没有注册工具') && !(await toolsHead(page)).text.includes('已连接'),
    JSON.stringify(rows.map((row) => row.tools)));
}

/** @brief HTTP 服务的"编辑"：表单没有地址一栏，直接以 JSON 编辑，内容是 mcp.json 里它的条目；Esc 关上，焦点回到"编辑"。 */
async function remoteEdit(ctx) {
  const { page } = ctx;
  await mcpRow(page, 'remote').getByRole('button', { name: '编辑', exact: true }).click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  const shown = { mode: await form.getAttribute('data-mode'), name: await field(form, '名称').inputValue(),
    entry: JSON.parse(await page.getByTestId('mcp-json').inputValue()) };
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'detached', timeout: 5000 });
  await settle(page);
  const focus = await focusDescriptor(page);
  const inRemote = await page.evaluate(() => Boolean(document.activeElement
    ?.closest('[data-testid="mcp-row"][data-server="remote"]')));
  record('HTTP 服务（url）的"编辑"直接以 JSON 编辑：名称和 mcp.json 里它的条目；Esc 关上，焦点回到它的"编辑"',
    shown.mode === 'json' && shown.name === 'remote'
    && same(canon(shown.entry), canon(ctx.mcpOriginal.mcpServers.remote))
    && focus.text === '编辑' && inRemote, JSON.stringify({ shown, focus }));
}

/** @brief 添加表单：打开、Esc 关闭、几种保存失败、以 JSON 编辑、回到表单、保存 x。 */
async function mcpForm(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'mcp');
  const addButton = page.getByTestId('tools-page').getByRole('button', { name: '添加', exact: true });
  await addButton.click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  await settle(page);
  const opened = { mode: await form.getAttribute('data-mode'), focus: await focusDescriptor(page),
    text: await form.innerText(), onName: await form.evaluate((element) => document.activeElement
      === element.querySelector('label:first-child input')
      && element.querySelector('label:first-child > span')?.textContent === '名称') };
  await noteSmall(ctx, 'MCP · 表单');
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'detached', timeout: 5000 });
  await settle(page);
  const back = await focusDescriptor(page);
  record('点"添加"出表单：名称、命令、参数、环境变量，说明"Mori 添加的服务都用直接调用方式（exposure: direct）"；焦点在名称',
    opened.mode === 'fields' && ['名称', '命令', '参数', '环境变量'].every((label) => opened.text.includes(label))
    && opened.text.includes('Mori 添加的服务都用直接调用方式（exposure: direct）') && opened.onName,
    JSON.stringify(opened));
  record('Esc 关掉表单（等于取消），焦点回到"添加"', back.text === '添加' && back.tag === 'button', JSON.stringify(back));
  await addButton.click();
  await form.waitFor({ timeout: 5000 });
  await mcpFailures(ctx);
  await field(form, '名称').fill('x');
  const saved = await submitForm(page);
  const after = readJson(mcpPath(ctx));
  const expected = clone(ctx.mcpOriginal);
  expected.mcpServers.x = { command: 'node', args: [MCP_SERVER], exposure: 'direct' };
  record('保存：表单关上，"已保存 · 新建的会话才会连接它"和"新建会话"', !saved.open
    && saved.saved.includes('已保存 · 新建的会话才会连接它') && saved.saved.includes('新建会话'), JSON.stringify(saved));
  record('保存后 mcp.json 的 mcpServers 多了 x：command "node"、args 是合成 MCP 服务的路径、exposure "direct"；'
    + '$comment 和其他服务原样保留（顺序也不变）', same(after, expected), JSON.stringify(after));
  const x = (await mcpRows(page)).find((row) => row.name === 'x');
  record('列表里出现 x：用户级、直接调用、命令行"node <路径>"', x?.tags.join() === '用户级,直接调用'
    && x.command === `node ${MCP_SERVER}` && x.checked, JSON.stringify(x));
}

/** @brief 表单开着时的几种保存失败；每次 mcp.json 都不变。最后把 JSON 改好、回到表单（命令和参数回来）。 */
async function mcpFailures(ctx) {
  const { page } = ctx;
  const form = page.getByTestId('mcp-form');
  const original = readFileSync(mcpPath(ctx), 'utf8');
  const kept = () => readFileSync(mcpPath(ctx), 'utf8') === original;
  await fillFields(page, { name: 'bad name!', command: 'node', args: MCP_SERVER });
  const bad = await submitForm(page);
  record('名字不合规（有空格和 !）："保存失败："加原文，表单保留你写的（名称、命令、参数），mcp.json 不变', bad.open
    && same(bad.values.slice(0, 3), ['bad name!', 'node', MCP_SERVER])
    && bad.error.startsWith('保存失败：') && bad.error.includes('Invalid server name') && kept(), JSON.stringify(bad));
  await field(form, '名称').fill('my_tool');
  const clash = await submitForm(page);
  record('与已有的 my-tool 重名（- 和 _ 算同一个，同 pi）：保存失败，mcp.json 不变', clash.open
    && clash.error.includes('conflicts with "my-tool"') && kept(), clash.error);
  await field(form, '名称').fill('nocmd');
  await field(form, '命令').fill('');
  const noCommand = await submitForm(page);
  record('没有命令也没有地址："保存失败："加说明（needs either "command" … or "url"），mcp.json 不变', noCommand.open
    && noCommand.error.startsWith('保存失败：') && noCommand.error.includes('needs either "command"') && kept(),
  noCommand.error);
  await field(form, '命令').fill('node');
  await field(form, '环境变量').fill('BADLINE');
  const badEnv = await submitForm(page);
  record('环境变量有一行不是 名字=值："保存失败：环境变量"BADLINE"要写成 名字=值"，mcp.json 不变', badEnv.open
    && badEnv.error === '保存失败：环境变量"BADLINE"要写成 名字=值' && kept(), badEnv.error);
  await field(form, '环境变量').fill('');
  await form.getByRole('button', { name: '以 JSON 编辑' }).click();
  const json = page.getByTestId('mcp-json');
  await json.waitFor({ timeout: 5000 });
  const shown = JSON.parse(await json.inputValue());
  record('"以 JSON 编辑"：名称和这个服务条目的 JSON（表单里写的 command、args，写成直接调用）',
    (await form.getAttribute('data-mode')) === 'json'
    && same(shown, { command: 'node', args: [MCP_SERVER], exposure: 'direct' }),
    JSON.stringify(shown));
  await field(form, '名称').fill('jsonsrv');
  await json.fill(JSON.stringify({ command: 'node', args: [MCP_SERVER], exposure: 'codemode' }, null, 2));
  const codemode = await submitForm(page);
  record('JSON 里 exposure 写 codemode：保存失败 "v0 only supports direct exposure"，mcp.json 不变', codemode.open
    && codemode.error.includes('v0 only supports direct exposure') && kept(), codemode.error);
  await json.fill('{"command": "node",');
  const broken = await submitForm(page);
  record('JSON 不能解析："保存失败："加解析的原文，写的 JSON 留着，mcp.json 不变', broken.open
    && broken.error.startsWith('保存失败：') && broken.error.length > '保存失败：'.length
    && (await json.inputValue()) === '{"command": "node",' && kept(), broken.error);
  await json.fill(JSON.stringify({ command: 'node', args: [MCP_SERVER] }, null, 2));
  await form.getByRole('button', { name: '回到表单' }).click();
  const fields = { mode: await form.getAttribute('data-mode'),
    command: await field(form, '命令').inputValue(),
    args: await field(form, '参数').inputValue() };
  record('"回到表单"：JSON 里的命令和参数回到输入框', fields.mode === 'fields' && fields.command === 'node'
    && fields.args === MCP_SERVER, JSON.stringify(fields));
}

/**
 * @brief 编辑（填好的表单）、改为直接调用（只改 exposure）、键盘启停 x（enabled: false / 删掉）、改名、移除改名后的
 *        my-tool2（确认框，Esc 不改）、以 JSON 编辑已有的服务。最后一步是保存，下一步用"已保存"后面的"新建会话"。
 */
async function mcpEdits(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'mcp');
  await editPrefill(ctx);
  const before = readJson(mcpPath(ctx));
  await mcpRow(page, 'legacy').getByTestId('mcp-direct').click();
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-testid="mcp-row"][data-server="legacy"]');
    return Boolean(row) && !row.querySelector('[data-testid="mcp-direct"]');
  }, null, { timeout: 15000 });
  const direct = clone(before);
  direct.mcpServers.legacy.exposure = 'direct';
  record('"改为直接调用"：只给 legacy 加上 exposure "direct"，它的其他字段和别的服务原样；警示消失',
    same(readJson(mcpPath(ctx)), direct), JSON.stringify(readJson(mcpPath(ctx)).mcpServers.legacy));
  const xRow = '[data-testid="mcp-row"][data-server="x"]';
  await mcpRow(page, 'x').getByRole('switch').focus();
  await page.keyboard.press('Space');
  await waitSwitch(page, xRow, false);
  const offRow = (await mcpRows(page)).find((row) => row.name === 'x');
  const off = readJson(mcpPath(ctx)).mcpServers.x;
  record('键盘（焦点在开关上按空格）停用 x：mcp.json 里 x 写 enabled: false，其他字段不变，行变淡', same(off,
    { command: 'node', args: [MCP_SERVER], exposure: 'direct', enabled: false }) && offRow.off, JSON.stringify(off));
  await mcpRow(page, 'x').getByRole('switch').focus();
  await page.keyboard.press('Space');
  await waitSwitch(page, xRow, true);
  const on = readJson(mcpPath(ctx)).mcpServers.x;
  record('再启用 x：删掉 enabled 字段（pi 的默认）', same(on, { command: 'node', args: [MCP_SERVER], exposure: 'direct' }),
    JSON.stringify(on));
  await renameServer(ctx);
  await removeServer(ctx, 'my-tool2');
  await noteSmall(ctx, 'MCP');
  await jsonEditExisting(ctx);
}

/** @brief 用户级服务 empty 的"以 JSON 编辑"：名称和 mcp.json 里它的条目；改了保存，mcp.json 只有它变了。 */
async function jsonEditExisting(ctx) {
  const { page } = ctx;
  const before = readJson(mcpPath(ctx));
  await mcpRow(page, 'empty').getByRole('button', { name: '以 JSON 编辑', exact: true }).click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  const json = page.getByTestId('mcp-json');
  const shown = { mode: await form.getAttribute('data-mode'), name: await field(form, '名称').inputValue(),
    entry: JSON.parse(await json.inputValue()) };
  record('用户级服务的"以 JSON 编辑"：名称和 mcp.json 里它的条目（command、args、env、exposure）',
    shown.mode === 'json' && shown.name === 'empty' && same(canon(shown.entry), canon(before.mcpServers.empty)),
    JSON.stringify(shown));
  const edited = { ...before.mcpServers.empty, description: 'synthetic: edited as JSON' };
  await json.fill(JSON.stringify(edited, null, 2));
  const saved = await submitForm(page);
  const expected = clone(before);
  expected.mcpServers.empty = edited;
  record('改了 JSON 保存：mcp.json 里只有 empty 换成写的条目，$comment、其他服务和顺序都不变', !saved.open
    && same(readJson(mcpPath(ctx)), expected), JSON.stringify(readJson(mcpPath(ctx))));
}

/** @brief 用"编辑"把 my-tool 改名为 my-tool2：条目留在原来的位置、内容不变，列表里换成新名字。 */
async function renameServer(ctx) {
  const { page } = ctx;
  const before = readJson(mcpPath(ctx));
  await mcpRow(page, 'my-tool').getByRole('button', { name: '编辑', exact: true }).click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  await field(form, '名称').fill('my-tool2');
  const saved = await submitForm(page);
  const expected = { ...before, mcpServers: Object.fromEntries(Object.entries(before.mcpServers)
    .map(([key, value]) => (key === 'my-tool' ? ['my-tool2', value] : [key, value]))) };
  const names = (await mcpRows(page)).map((row) => row.name);
  record('"编辑"里改名（my-tool → my-tool2）：mcp.json 里这一项换了名字、留在原来的位置、内容不变（仍停用），'
    + '列表里是新名字', !saved.open && same(readJson(mcpPath(ctx)), expected) && names.includes('my-tool2')
    && !names.includes('my-tool'), JSON.stringify({ file: readJson(mcpPath(ctx)).mcpServers, names }));
}

/** @brief 用户级服务的"编辑"：表单填好它现在的命令、参数、环境变量，这一行的开关和按钮不可用；"取消"关上、文件不变。 */
async function editPrefill(ctx) {
  const { page } = ctx;
  const before = readFileSync(mcpPath(ctx), 'utf8');
  await mcpRow(page, 'empty').getByRole('button', { name: '编辑', exact: true }).click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  const shown = { name: await field(form, '名称').inputValue(), command: await field(form, '命令').inputValue(),
    args: await field(form, '参数').inputValue(), env: await field(form, '环境变量').inputValue() };
  const row = (await mcpRows(page)).find((item) => item.name === 'empty');
  record('点用户级服务的"编辑"：表单里是它的名称、命令、参数和环境变量（每行 名字=值）；编辑时这一行的开关和按钮不可用',
    same(shown, { name: 'empty', command: 'node', args: MCP_SERVER, env: 'MORI_MCP_TOOLS=none' }) && row.disabled
    && row.buttons.every((button) => button.disabled), JSON.stringify({ shown, row }));
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 5000 });
  await settle(page);
  const focus = await focusDescriptor(page);
  record('"取消"关上表单、mcp.json 不变，焦点回到这一行的"编辑"', readFileSync(mcpPath(ctx), 'utf8') === before
    && focus.text === '编辑', JSON.stringify(focus));
}

/** @brief 移除服务 name：确认框的文字，Esc 关掉不改；确认后行消失、mcp.json 只少了它。 */
async function removeServer(ctx, name) {
  const { page } = ctx;
  const before = readJson(mcpPath(ctx));
  await mcpRow(page, name).getByRole('button', { name: '移除' }).click();
  const dialog = page.getByTestId('remove-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  await noteSmall(ctx, 'MCP · 移除确认框');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  record(`移除 MCP 服务先确认："移除 MCP 服务 ${name}？已经打开的会话不受影响。"；Esc 关掉，mcp.json 不变`,
    text.includes(`移除 MCP 服务 ${name}？`) && text.includes('已经打开的会话不受影响。')
    && same(readJson(mcpPath(ctx)), before) && (await mcpRow(page, name).count()) === 1, text);
  await mcpRow(page, name).getByRole('button', { name: '移除' }).click();
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: '移除' }).click();
  await mcpRow(page, name).waitFor({ state: 'detached', timeout: 15000 });
  const expected = clone(before);
  delete expected.mcpServers[name];
  record(`确认移除：行消失，mcp.json 只少了 ${name}`, same(readJson(mcpPath(ctx)), expected),
    JSON.stringify(readJson(mcpPath(ctx))));
}

/**
 * @brief 新建的会话：等 pi 的 MCP 通知（全部启用的服务连上或失败之后发一次，m6-checks.md）出现在对话流里，
 *        再看工具名、错误原文、没有工具的服务；内置工具里的来源；调用 x 的工具出批准卡。
 */
async function mcpSession(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'mcp');
  ctx.p4 = await newFromSaved(ctx);
  await page.waitForFunction(() => [...document
    .querySelectorAll('.pane-slot:not([hidden]) [data-testid="ext-notify"]')]
    .some((item) => item.textContent.includes('broken: failed')), null, { timeout: 45000 });
  await openToolsSection(page, 'mcp');
  const rows = await mcpRows(page);
  const by = (name) => rows.find((row) => row.name === name) ?? {};
  const text = (await toolsHead(page)).text;
  await shot(page, '3-mcp-session');
  record('走查 4：新建的会话里 x 下面"当前会话里注册的工具：mcp__x__echo、mcp__x__add"',
    by('x').tools === '当前会话里注册的工具：mcp__x__echo、mcp__x__add', by('x').tools);
  record('改为直接调用的 legacy 在新会话里也注册了工具，不再有 v0 警示', by('legacy').tools?.includes('mcp__legacy__echo')
    && !by('legacy').direct, JSON.stringify(by('legacy')));
  const notice = await fullNotice(page, 'broken');
  record('走查 5：命令写错的 broken，行下面警示色显示 pi 通知里的原文"broken: failed: …"；点"完整通知"展开整条通知'
    + '（"MCP servers need attention:" 和这一行）',
  (by('broken').error ?? []).some((line) => line.startsWith('broken: failed:'))
    && notice.open && notice.text.startsWith('MCP servers need attention:')
    && by('broken').error.every((line) => notice.text.includes(line)),
  JSON.stringify({ error: by('broken').error, notice }));
  record('通知里没有提到的服务（x、legacy、empty）行下面没有错误', ['x', 'legacy', 'empty']
    .every((name) => (by(name).error ?? []).length === 0), JSON.stringify(rows.map((row) => [row.name, row.error])));
  record('反例：不注册工具的 empty 显示"当前会话里它没有注册工具"，页面上没有"已连接"',
    by('empty').tools === '当前会话里它没有注册工具' && !text.includes('已连接'), by('empty').tools);
  await openToolsSection(page, 'builtin');
  const tools = await toolRows(page);
  const echo = tools.find((tool) => tool.name === 'mcp__x__echo');
  record('内置工具里 MCP 服务注册的工具来源写"MCP · x"、启用；页面上没有"已连接"', echo?.tag === 'MCP · x'
    && echo.active === 'true' && !(await toolsHead(page)).text.includes('已连接'), JSON.stringify(echo ?? null));
  await backToChat(page);
  const call = await callAndAllow(ctx, 'call tool: mcp__x__echo {"text":"hi"}');
  record('走查 4：调用 MCP 服务的工具出批准卡，标题"x · echo"；Alt+1 允许后结果 "mori-mcp echo: hi"',
    call.tool === 'mcp__x__echo' && call.title === 'x · echo' && call.result.body.includes('mori-mcp echo: hi'),
    JSON.stringify(call));
}

/** @brief 点开服务行下面的"完整通知"，返回是否展开和整条通知的原文。 */
async function fullNotice(page, name) {
  const details = mcpRow(page, name).locator('[data-testid="mcp-error"] details');
  if ((await details.count()) === 0) return { open: false, text: '' };
  await details.locator('summary').click();
  return { open: await details.evaluate((element) => element.open),
    text: await details.locator('pre').first().innerText({ timeout: 5000 }) };
}

/** @brief mcp.json 不能解析：显示原文和"用系统编辑器打开"，"添加"不可用；之后恢复文件。 */
async function mcpBroken(ctx) {
  const { page } = ctx;
  const good = readFileSync(mcpPath(ctx), 'utf8');
  writeFileSync(mcpPath(ctx), '{ "mcpServers": ');
  try {
    await openToolsSection(page, 'mcp');
    const errors = await page.getByTestId('mcp-config-errors').innerText({ timeout: 10000 }).catch(() => '');
    const add = page.getByTestId('tools-page').getByRole('button', { name: '添加', exact: true });
    record('mcp.json 不能解析：警示色显示原文（Cannot parse …mcp.json）和"用系统编辑器打开"，"添加"不可用',
      errors.includes('Cannot parse') && errors.includes('mcp.json') && errors.includes('用系统编辑器打开')
      && (await add.isDisabled()), errors);
    const opened = await clickOpenInEditor(ctx, page.getByTestId('mcp-config-errors'));
    record('点它的"用系统编辑器打开"：把用户级 mcp.json 的路径交给系统打开（测试里只记下路径）',
      opened !== null && resolve(opened).toLowerCase() === mcpPath(ctx).toLowerCase(), String(opened));
    await noteSmall(ctx, 'MCP · 读不出配置');
    await backToChat(page);
  } finally {
    writeFileSync(mcpPath(ctx), good);
  }
}

/**
 * @brief 已信任的 override 项目：项目扩展注册的工具（来源、两行说明）、项目设置停用的用户级技能只读、技能的问题、
 *        本项目的 MCP 服务和覆盖只读、本项目的包只读；最后在工具页开着时点左栏别的会话。
 *        先发一条消息，让这个会话有会话文件（之后在左栏点回它）。
 */
async function overrideProject(ctx) {
  const { page, h } = ctx;
  await openFolder(ctx, ctx.override, '信任');
  await h.send('plain hello');
  await h.idle(60000);
  ctx.overrideFile = await activeFile(page);
  await extensionTool(ctx);
  await openToolsSection(page, 'skills');
  const rows = await skillRows(page);
  const user = rows.find((row) => row.name === 'user-skill');
  record('本项目的 .pi/settings.json 停用了用户级技能：仍标"用户级"，开关关上且不可用，说明"本项目的 .pi/settings.json 把它停用了，'
    + '只能在项目里改"', user?.scope === 'user' && user.tag === '用户级' && !user.checked && user.disabled
    && user.notes.includes(DISABLED_BY_PROJECT), JSON.stringify(user ?? rows));
  const diagnostics = await page.getByTestId('skill-diagnostics').innerText({ timeout: 5000 }).catch(() => '');
  record('技能有问题（bad-skill 缺 description）：列表下方警示色列出 pi 的原文', diagnostics.includes('bad-skill')
    && diagnostics.includes('description is required'), diagnostics);
  await openToolsSection(page, 'mcp');
  const servers = await mcpRows(page);
  const project = servers.find((row) => row.name === 'projsrv');
  const x = servers.find((row) => row.name === 'x');
  record('本项目 .pi/mcp.json 的服务：标"本项目"，开关和编辑、移除都不可用，说明"本项目的 .pi/mcp.json，只能在项目里改"',
    project?.tags[0] === '本项目' && project.disabled && project.buttons.every((button) => button.disabled)
    && project.notes.includes(PROJECT_MCP), JSON.stringify(project ?? servers));
  record('项目覆盖了用户级服务 x 的 enabled：开关关上且不可用，说明"本项目改了它的 enabled"', Boolean(x) && !x.checked
    && x.disabled && x.notes.includes('本项目改了它的 enabled'), JSON.stringify(x ?? null));
  await shot(page, '4-override');
  await noteSmall(ctx, '本项目的设置 · MCP');
  await openToolsSection(page, 'plugins');
  const cards = await packageCards(page);
  const card = cards.find((item) => item.tag === '本项目');
  const cardText = await page.locator('[data-testid="package-card"]').filter({ hasText: PROJECT_SETTINGS }).first()
    .innerText({ timeout: 5000 }).catch(() => '');
  record('本项目设置里的包：卡标"本项目"，"停用整个包""移除"和每个资源的开关都不可用，说明"本项目的设置，只能在项目里改"',
    card?.source === PKG_SOURCE && card.resources.length === 4 && card.actions.every((item) => item.disabled)
    && card.resources.every((item) => item.disabled) && cardText.includes(PROJECT_SETTINGS), JSON.stringify(cards));
  await noteSmall(ctx, '本项目的设置 · 插件');
  await sidebarLeaves(ctx);
}

/** @brief 内置工具里项目扩展注册的 override_multi：来源"扩展 <扩展文件>"，行里只有说明的第一行，点开是两行全文。 */
async function extensionTool(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'builtin');
  const tool = (await toolRows(page)).find((item) => item.name === MULTI_TOOL);
  const row = page.locator(`[data-testid="tool-row"][data-tool="${MULTI_TOOL}"]`);
  const hidden = !(await row.locator('.tools-body').isVisible().catch(() => false));
  record('内置工具里项目扩展注册的工具：来源"扩展 <扩展文件的路径>"，行里只有说明的第一行',
    tool?.tag.toLowerCase() === `扩展 ${ctx.extFile}`.toLowerCase() && tool.desc === MULTI_FIRST && hidden,
    JSON.stringify(tool ?? null));
  await row.locator('summary').click();
  const full = await row.locator('.tools-body').innerText({ timeout: 5000 }).catch(() => '');
  record('点开这个工具：完整说明（两行）都显示出来', full.trim() === MULTI_DESC, full);
}

/** @brief 工具页开着时点左栏别的会话（p1）：回到会话页并显示它（同设置页），"工具"不再高亮。 */
async function sidebarLeaves(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.p1).first().click();
  const left = await page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 })
    .then(() => true, () => false);
  await waitReady(page);
  await settle(page);
  const state = { left, file: await activeFile(page),
    lit: await page.getByTestId('nav-tools').evaluate((element) => element.classList.contains('active')) };
  record('工具页开着时点左栏的另一个会话：回到会话页并显示那个会话，"工具"不再高亮', left && state.file === ctx.p1
    && !state.lit, JSON.stringify(state));
}

/** @brief 没有信任的项目：顶部的说明；它 .pi/skills 里的技能、.pi/mcp.json 里的服务都不列出。 */
async function untrustedProject(ctx) {
  const { page } = ctx;
  await openFolder(ctx, ctx.untrusted, '不信任');
  await openToolsSection(page, 'skills');
  const head = await toolsHead(page);
  const rows = await skillRows(page);
  record('反例：没有信任的项目，顶部"没有信任这个文件夹，它自带的技能和配置不列出"，它 .pi/skills 里的 untrusted-skill 不列出',
    head.trust === TRUST_NOTE && !rows.some((row) => row.name === 'untrusted-skill')
    && rows.some((row) => row.name === 'user-skill'),
  JSON.stringify({ trust: head.trust, rows: rows.map((row) => row.name) }));
  await openToolsSection(page, 'mcp');
  const servers = await mcpRows(page);
  record('没有信任的项目的 .pi/mcp.json 里的服务也不列出', !servers.some((row) => row.name === 'untrustedsrv')
    && servers.some((row) => row.name === 'x'), JSON.stringify(servers.map((row) => row.name)));
  await shot(page, '5-untrusted');
  await openToolsSection(page, 'plugins');
  const cards = await packageCards(page);
  const pluginText = await page.locator('[data-testid="tools-page"] .tools-content').innerText();
  record('没有信任的项目的 .pi/settings.json 里写的包也不列出（用户级的包已经移除："还没有插件"）', cards.length === 0
    && pluginText.includes('还没有插件'), JSON.stringify(cards));
  await openToolsSection(page, 'builtin');
  const tools = (await toolRows(page)).map((tool) => tool.name);
  record('没有信任的项目的 .pi/extensions 没有加载：内置工具里没有它注册的 untrusted_hello', tools.includes('read')
    && !tools.includes('untrusted_hello'), tools.join(', '));
}

/** @brief 键盘：分节列表的 ↑ ↓；从"返回会话"按 Tab 走到分节、开关和按钮。 */
async function keyboard(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'skills');
  await page.locator('[data-testid="tools-nav"] button[data-section="skills"]').focus();
  await page.keyboard.press('ArrowDown');
  const down = { current: (await toolsHead(page)).current, focus: (await focusDescriptor(page)).section };
  await page.keyboard.press('ArrowUp');
  const up = { current: (await toolsHead(page)).current, focus: (await focusDescriptor(page)).section };
  record('分节列表里 ↓ ↑ 切换分节，焦点跟着走', down.current === 'mcp' && down.focus === 'mcp' && up.current === 'skills'
    && up.focus === 'skills', JSON.stringify({ down, up }));
  await page.getByTestId('tools-page').getByRole('button', { name: '返回会话' }).focus();
  const walk = await tabWalk(page, 12);
  record('技能一节：从"返回会话"按 Tab 走到"新建会话"、分节按钮、技能行和它的开关', walk.some((f) => f.text.includes('新建会话'))
    && walk.some((f) => f.section === 'mcp') && walk.some((f) => f.role === 'switch' && f.inTools)
    && walk.some((f) => f.text.includes('user-skill')), JSON.stringify(walk));
  await openToolsSection(page, 'mcp');
  await page.locator('[data-testid="tools-nav"] button[data-section="mcp"]').focus();
  const mcpWalk = await tabWalk(page, 40);
  record('MCP 一节：Tab 走到服务的开关、"编辑""以 JSON 编辑""移除"和"添加"', mcpWalk.some((f) => f.role === 'switch')
    && ['编辑', '以 JSON 编辑', '移除', '添加'].every((text) => mcpWalk.some((f) => f.text === text)), JSON.stringify(mcpWalk));
  await openToolsSection(page, 'plugins');
  await page.locator('[data-testid="tools-nav"] button[data-section="plugins"]').focus();
  const pluginWalk = await tabWalk(page, 4);
  record('插件一节：Tab 走到"添加本地包…"', pluginWalk.some((f) => f.text === '添加本地包…'), JSON.stringify(pluginWalk));
  await noteSmall(ctx, '插件（没有包）');
  await backToChat(page);
}

/**
 * @brief 写入失败：把用户级 settings.json 设成只读（pi 写设置时 writeFileSync 报 EPERM，记进 drainErrors），
 *        关 user-skill 的开关：这一行下面"没能保存："加原文，开关回到原来的样子；之后恢复文件属性。
 */
async function writeFailure(ctx) {
  const { page } = ctx;
  const file = join(ctx.agentDir, 'settings.json');
  const before = readFileSync(file, 'utf8');
  await openToolsSection(page, 'skills');
  chmodSync(file, 0o444);
  try {
    await skillRow(page, 'user-skill').getByRole('switch').click();
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-testid="skill-row"][data-name="user-skill"]');
      const toggle = row?.querySelector('[role="switch"]');
      return Boolean(toggle) && !toggle.disabled && Boolean(row.querySelector('.form-message.error'));
    }, null, { timeout: 15000 });
    const row = (await skillRows(page)).find((item) => item.name === 'user-skill');
    record('写入失败（用户级 settings.json 只读）：这一行下面"没能保存："加 pi 报告的原文，开关回到原来的样子（启用），文件不变',
      row.error.startsWith('没能保存：') && row.error.length > '没能保存：'.length && row.checked && !row.off
      && readFileSync(file, 'utf8') === before, JSON.stringify(row));
    await shot(page, '6-write-failure');
    await noteSmall(ctx, '技能 · 没能保存');
  } finally {
    chmodSync(file, 0o666);
  }
  await retryToggle(ctx);
  await enabledByProject(ctx);
}

/** @brief "再试"：文件恢复可写之后再点开关，这次停用成功，"没能保存"消失，设置里写进停用的条目。 */
async function retryToggle(ctx) {
  const { page } = ctx;
  await flipSkill(page, 'user-skill', false);
  const row = (await skillRows(page)).find((item) => item.name === 'user-skill');
  const user = readJson(join(ctx.agentDir, 'settings.json'));
  record('再试（文件恢复可写之后再点开关）：开关关上、行变淡，"没能保存"消失，用户级设置的 skills 写成 '
    + '["-skills\\user-skill\\SKILL.md"]', !row.checked && row.off && !row.error
    && same(user?.skills, ['-skills\\user-skill\\SKILL.md']), JSON.stringify({ row, skills: user?.skills }));
  await backToChat(page);
}

/**
 * @brief 本项目的设置启用了用户级停用的技能：用户级设置此刻停用 user-skill（上一步），把 override 项目的
 *        .pi/settings.json 改成 pi config -l 启用它的写法（"+路径"），在左栏点回 override 的会话：开关打开但不可用，
 *        说明"本项目的 .pi/settings.json 把它启用了，只能在项目里改"。
 */
async function enabledByProject(ctx) {
  const { page } = ctx;
  writeJson(join(ctx.override, '.pi', 'settings.json'),
    { skills: [ctx.userSkill, `+${ctx.userSkill}`], packages: [PKG_SOURCE] });
  await rowOf(page, ctx.overrideFile).first().click();
  await waitReady(page);
  await openToolsSection(page, 'skills');
  const head = await toolsHead(page);
  const user = (await skillRows(page)).find((row) => row.name === 'user-skill');
  record('本项目的 .pi/settings.json 启用了用户级停用的技能：仍标"用户级"，开关打开但不可用，'
    + '说明"本项目的 .pi/settings.json 把它启用了，只能在项目里改"', head.follow.startsWith('override · ')
    && user?.scope === 'user' && user.checked && user.disabled && user.notes.includes(ENABLED_BY_PROJECT),
  JSON.stringify({ follow: head.follow, user }));
  await backToChat(page);
}

/**
 * @brief 读取失败：用户级 settings.json 的 packages 里写坏一项（{}，pi 的 resolve 抛 TypeError），进入工具页显示原文和
 *        "重新读取"；把文件改回去之后点"重新读取"，原文消失、列出内容。
 */
async function readFailure(ctx) {
  const { page } = ctx;
  const file = join(ctx.agentDir, 'settings.json');
  const good = readFileSync(file, 'utf8');
  const broken = JSON.parse(good);
  broken.packages = [...(broken.packages ?? []), {}];
  writeFileSync(file, `${JSON.stringify(broken, null, 2)}\n`);
  try {
    await page.getByTestId('nav-tools').click();
    await page.getByTestId('tools-error').waitFor({ timeout: 15000 });
    const text = await page.getByTestId('tools-error').innerText();
    const sections = await page.locator('[data-testid="tools-page"] .tools-content h2').count();
    record('读取失败（用户级 settings.json 的 packages 里有一项写坏了）：显示 pi 报的原文和"重新读取"，没有各节的内容',
      text.includes('startsWith') && text.includes('重新读取') && sections === 0, text);
    await shot(page, '7-read-failure');
    await noteSmall(ctx, '读取失败');
  } finally {
    writeFileSync(file, good);
  }
  await page.getByTestId('tools-error').getByRole('button', { name: '重新读取' }).click();
  const back = await page.getByTestId('tools-error').waitFor({ state: 'detached', timeout: 15000 })
    .then(() => true, () => false);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="tool-row"]').length > 0, null,
    { timeout: 15000 }).catch(() => {});
  const tools = (await toolRows(page)).length;
  record('把文件改回去之后点"重新读取"：原文消失，列出内容（内置工具）', back && tools > 0, `tool rows: ${tools}`);
  await backToChat(page);
}

/**
 * @brief 反例：会话打开时文件夹里没有要信任的内容（不问信任），之后才出现 .pi/skills 和 .pi/mcp.json（synthetic）：
 *        这些配置没有人信任过（"没有回答"），工具页不列出它们，顶部说明没有信任这个文件夹。
 */
async function lateConfig(ctx) {
  const { page } = ctx;
  const plain = join(ctx.root, 'plain');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'README.md'), '# plain\n\nsynthetic\n');
  await openFolder(ctx, plain);
  writeSkill(join(plain, '.pi', 'skills', 'late-skill'), 'late-skill', 'Synthetic skill that appeared later.');
  writeJson(join(plain, '.pi', 'mcp.json'),
    { mcpServers: { latesrv: { command: 'node', args: [MCP_SERVER], exposure: 'direct' } } });
  await openToolsSection(page, 'skills');
  const head = await toolsHead(page);
  const skills = (await skillRows(page)).map((row) => `${row.name}:${row.scope}`);
  await openToolsSection(page, 'mcp');
  const servers = (await mcpRows(page)).map((row) => row.name);
  await shot(page, '8-late-config');
  record('反例：会话打开时文件夹里没有要信任的内容，之后才出现 .pi/skills、.pi/mcp.json（没有人信任过）：'
    + '顶部"没有信任这个文件夹，它自带的技能和配置不列出"，late-skill 和 latesrv 都不列出', head.follow.startsWith('plain · ')
    && head.trust === TRUST_NOTE && !skills.some((item) => item.startsWith('late-skill:'))
    && !servers.includes('latesrv'), JSON.stringify({ follow: head.follow, trust: head.trust, skills, servers }));
  await backToChat(page);
}

/** @brief 工具页各处没有小于 12px 的字。 */
async function fontSizes(ctx) {
  record(`工具页（${ctx.smallChecked.join('、')}）没有小于 12px 的文字`, ctx.small.length === 0 && ctx.smallChecked.length > 0,
    ctx.small.slice(0, 6).join('; '));
}

const steps = { setup, noSession, entry, skills, splitFollow, plugins, mcpList, mcpForm, mcpEdits, mcpSession,
  mcpBroken, overrideProject, untrustedProject, keyboard, readFailure, writeFailure, lateConfig, fontSizes };

const fake = await startFakeEndpoint(port, testKey);
const layout = makeLayout();
const ctx = { ...layout, pageErrors: [], small: [], smallChecked: [], baseline: {} };
try {
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      if (ctx.page) await shot(ctx.page, `${name}-error`);
      await recover(ctx);
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  fake.kill();
}
console.log(`[m6-app-tools] layout in ${layout.root}`);
await sleep(200);
process.exitCode = write(`m6-app-tools${suffix}.json`) ? 0 : 1;
