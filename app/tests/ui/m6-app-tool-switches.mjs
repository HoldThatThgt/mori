// 负责人走查 M12（2026-10-26，"why so many not-enabled tools? why can't I enable them?"）的整机测试：真正的 Mori（界面 +
// 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），覆盖 docs/v0/screens/tools.md"内置工具"
// （检查记录 docs/v1/walkthrough-1026/WP-08.md）：
// pi 的 8 个内置工具各有开关（读屏名称 "Enable tool <名字>"，没写 defaultTools 时开着 read、bash、edit、write）、grep 与 find
// 下面写要的程序；别的行（Mori 的 TaskBoard 工具与 memory、MCP、插件、扩展的工具）没有开关、下面一行原因；
// 打开、关掉写用户级 settings.json 的 defaultTools（+名字 / -名字，只改这一项，别的字段和键的顺序不变，与默认相同时去掉）；
// 开着的会话不变，工具页"New session"建的会话照新的设置（工具页、发给模型的工具、调用 ls 不出批准卡）；
// settings.json 不是 JSON 时"Couldn’t save: "加原文、开关回去、文件不变；受信任项目的 .pi/settings.json 改了的工具只读。
// 合成的东西：端点、MCP 服务（tests/mcp-server）、pi 包（tests/pi-package 的副本）、扩展、角色文件和设置文件都是 synthetic。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-tool-switches.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// setup 总是跑；别的步骤开头都把 settings.json 的 defaultTools 去掉（测试准备），可以单独跑；projectOverride 打开另一个项目，
// 放在最后。结果写到 test-results/m6-app-tool-switches(-packaged).json，截图在 test-results/m6-app-tool-switches(-packaged)/；
// 全部通过时删掉临时目录。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import { lastReply, lastToolCard, paneOf, settle, waitPanes, waitReady } from './m3-helpers.mjs';
import { firstRunAndOpen, openProject, openToolsSection, startFakeEndpoint } from './m6-helpers.mjs';
import {
  BUILTIN_LEAD, expectedNotes, PI_DEFAULT_TOOLS, PI_TOOLS, TOOL_REASONS, toolNeeds, toolRows,
} from './m6-tools-helpers.mjs';
import { pageHelpers } from './page.mjs';
import { writeRole } from './tb-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const port = 4936;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值（synthetic），与任何真实服务无关。
const testKey = 'synthetic-test-key-m6-switches-not-real';
const shots = join(appRoot, `test-results/m6-app-tool-switches${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 合成 MCP 服务（synthetic，本地 stdio）和它在 mcp.json 里的名字 */
const MCP_SERVER = join(appRoot, 'tests', 'mcp-server', 'server.mjs');
const MCP_NAME = 'swtest';
/** 用户级设置里写的包（相对 agentDir：<根>/data/pi → <根>/pkg） */
const PKG_SOURCE = '..\\..\\pkg';
/** 项目扩展注册的工具（synthetic） */
const EXT_TOOL = 'switch_hello';
/** 预先写进 settings.json 的字段（synthetic）：开关只改 defaultTools，这一项要原样留着 */
const MARKER = { key: 'moriSwitchTestMarker', value: 'synthetic: written by m6-app-tool-switches; keep it' };
/** 受信任项目 override 的 .pi/settings.json 里的 defaultTools：pi 把它接在用户级后面 */
const PROJECT_TOOLS = ['+grep', '-edit'];
const ENABLED_BY_PROJECT = 'Turned on in this project’s .pi/settings.json. To change it, edit that file.';
const DISABLED_BY_PROJECT = 'Turned off in this project’s .pi/settings.json. To change it, edit that file.';

// ---------- 准备 ----------

/** @brief 写 JSON 文件（2 空格缩进加换行）。 */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @brief synthetic 项目扩展：注册一个不带参数的工具 EXT_TOOL。 */
function writeExtension(project) {
  const path = join(project, '.pi', 'extensions', 'switch-ext.ts');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    '// synthetic: written by tests/ui/m6-app-tool-switches.mjs.',
    'export default function (pi) {',
    '  pi.registerTool({',
    `    name: ${JSON.stringify(EXT_TOOL)}, label: ${JSON.stringify(EXT_TOOL)},`,
    "    description: 'Synthetic tool of a project extension.',",
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    "    async execute() { return { content: [{ type: 'text', text: 'hello' }], details: {} }; },",
    '  });',
    '}',
    '',
  ].join('\n'));
}

/**
 * @brief 布局（synthetic）：MORI_USER_DATA=<根>/data，agentDir=<根>/data/pi，里面有用户级 mcp.json（一个合成服务）和
 *        settings.json（MARKER 和 pkg 包）；项目 main（.pi 扩展、.mori/agents/executor.md）、项目 override（.pi/settings.json
 *        写了 PROJECT_TOOLS），打开时都选"Trust workspace"。
 */
function makeLayout() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-switches-'));
  const userData = join(root, 'data');
  const agentDir = join(userData, 'pi');
  const main = join(root, 'main');
  const override = join(root, 'override');
  for (const project of [main, override]) {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nsynthetic\n');
  }
  writeExtension(main);
  writeRole(main, { name: 'executor', description: 'Synthetic role that changes code and runs commands' });
  writeJson(join(override, '.pi', 'settings.json'), { defaultTools: PROJECT_TOOLS });
  cpSync(join(appRoot, 'tests', 'pi-package'), join(root, 'pkg'), { recursive: true });
  writeJson(join(agentDir, 'mcp.json'),
    { mcpServers: { [MCP_NAME]: { command: 'node', args: [MCP_SERVER], exposure: 'direct' } } });
  writeJson(join(agentDir, 'settings.json'), { [MARKER.key]: MARKER.value, packages: [PKG_SOURCE] });
  return { root, userData, agentDir, main, override };
}

// ---------- 磁盘 ----------

/** @brief 用户级 settings.json 的路径、原文和解析结果（不存在时为 null）。 */
const settingsFile = (ctx) => join(ctx.agentDir, 'settings.json');
const settingsText = (ctx) => (existsSync(settingsFile(ctx)) ? readFileSync(settingsFile(ctx), 'utf8') : null);
const settingsJson = (ctx) => JSON.parse(settingsText(ctx) ?? 'null');

/** @brief settings.json 里 defaultTools 以外的键与值（看开关没有动别的字段，键的顺序也算）。 */
function others(value) {
  const { defaultTools: _tools, ...rest } = value ?? {};
  return JSON.stringify(rest);
}

/** @brief 测试准备（synthetic）：去掉 settings.json 的 defaultTools，每个步骤从默认的设置开始。 */
function resetDefaults(ctx) {
  const value = settingsJson(ctx);
  if (!value || !('defaultTools' in value)) return;
  delete value.defaultTools;
  writeFileSync(settingsFile(ctx), JSON.stringify(value, null, 2));
}

// ---------- 页面 ----------

/** @brief 一个工具行。 */
const toolRow = (page, name) => page.locator(`[data-testid="tool-row"][data-tool="${name}"]`);

/** @brief 点"Back to app"，等会话面板出现。 */
async function backToChat(page) {
  await page.getByTestId('tools-page').getByRole('button', { name: 'Back to app' }).click();
  await page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 });
  await settle(page);
}

/** @brief 打开 Customize → Built-in tools，读每一行（m6-tools-helpers toolRows）和标题下的说明。 */
async function builtinView(page) {
  await openToolsSection(page, 'builtin');
  const lead = await page.locator('[data-testid="tools-page"] .tools-lead').innerText({ timeout: 5000 })
    .catch(() => null);
  return { lead, rows: await toolRows(page) };
}

/** @brief 反复进出 Customize（每次进入重新读取），直到 fn(rows) 为真（MCP 服务在会话打开后才连上）；最多 20 次。 */
async function rowsUntil(page, fn) {
  let view = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    view = await builtinView(page);
    if (fn(view.rows)) return view;
    await backToChat(page);
    await sleep(1000);
  }
  return view;
}

/**
 * @brief 点一个工具行的开关，等命令和之后的重新读取结束：开关变成 want 且又可用，或这一行出了写入失败的原文；
 *        返回那一行（toolRows）。
 */
async function flipTool(page, name, want) {
  await toolRow(page, name).getByRole('switch').click();
  await page.waitForFunction(({ tool, on }) => {
    const row = document.querySelector(`[data-testid="tool-row"][data-tool="${tool}"]`);
    const sw = row?.querySelector('[role="switch"]');
    if (row?.querySelector('.form-message.error')) return !sw?.disabled;
    return sw && !sw.disabled && sw.getAttribute('aria-checked') === String(on);
  }, { tool: name, on: want }, { timeout: 15000 }).catch(() => {});
  return (await toolRows(page)).find((row) => row.name === name) ?? null;
}

/** @brief 工具页顶部的"New session"：等新的一栏出现并就绪（离开工具页，到新会话）。 */
async function newFromTools(page) {
  const before = await page.locator('.pane-slot').count();
  await page.getByTestId('tools-page').locator('.tools-notice').getByRole('button', { name: 'New session' }).click();
  await waitPanes(page, before + 1);
  await waitReady(page);
  await settle(page);
}

/** @brief 发 "list tools"（合成端点回答请求里给模型的全部工具名），返回这些名字。 */
async function modelTools(ctx) {
  await ctx.h.send('list tools');
  await ctx.h.idle(60000);
  const reply = await lastReply(ctx.page);
  return /可用的工具：([^\n]*)/.exec(reply)?.[1].split(',').map((name) => name.trim()).filter(Boolean) ?? [];
}

// ---------- 步骤 ----------

/** @brief 准备：首次启动填连接，打开已信任的项目 main，发一条消息。 */
async function setup(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
  await firstRunAndOpen(ctx, { baseUrl, apiKey: testKey, project: ctx.main, trust: true });
  await ctx.h.send('plain hello');
  await ctx.h.idle(60000);
  ctx.baseline = others(settingsJson(ctx));
  record('准备：首次启动填连接，打开已信任的项目 main 并发一条消息；settings.json 里预先写的字段还在',
    settingsJson(ctx)?.[MARKER.key] === MARKER.value, settingsText(ctx) ?? 'no settings.json');
}

/** @brief 默认的样子：8 个开关、grep / find 的说明、别的行的原因；settings.json 里没有 defaultTools。 */
async function rows(ctx) {
  resetDefaults(ctx);
  const { page } = ctx;
  const view = await rowsUntil(page, (list) => list.some((row) => row.tag === `MCP · ${MCP_NAME}`));
  const pi = PI_TOOLS.map((name) => view.rows.find((row) => row.name === name));
  record('M12 内置工具：pi 的 8 个工具各一行、来源"Built-in"、各有开关"Enable tool <名字>"（可用）；没写 defaultTools 时开着的'
    + '正是 read、bash、edit、write，它们是"Enabled"，另外 4 个是"Not enabled"；标题下"… Switches apply to new sessions."',
  pi.every((row) => row && row.tag === 'Built-in' && row.label === `Enable tool ${row.name}` && row.disabled === false
    && row.checked === PI_DEFAULT_TOOLS.includes(row.name)
    && row.state === (PI_DEFAULT_TOOLS.includes(row.name) ? 'Enabled' : 'Not enabled')) && view.lead === BUILTIN_LEAD,
  JSON.stringify(view.rows.map((row) => `${row.name}|${row.tag}|${row.state}|${row.checked}`)));
  const grep = pi[PI_TOOLS.indexOf('grep')];
  const find = pi[PI_TOOLS.indexOf('find')];
  record('M12 grep 下面"Needs rg.exe in <agentDir>\\bin or on PATH. Mori doesn’t download it."，find 下面同样写 fd.exe；'
    + '别的 pi 工具下面没有说明', same(grep?.notes, [toolNeeds('grep', ctx.agentDir)])
    && grep.notes[0] === `Needs rg.exe in ${ctx.agentDir}\\bin or on PATH. Mori doesn’t download it.`
    && same(find?.notes, [toolNeeds('find', ctx.agentDir)])
    && pi.filter((row) => !['grep', 'find'].includes(row?.name)).every((row) => row?.notes.length === 0),
  JSON.stringify({ grep: grep?.notes, find: find?.notes }));
  reasonRows(ctx, view.rows);
  record('M12 没有按开关时 settings.json 里没有 defaultTools，预先写的字段还在', !('defaultTools' in (settingsJson(ctx) ?? {}))
    && others(settingsJson(ctx)) === ctx.baseline, settingsText(ctx) ?? '');
  await shot(page, 'rows');
  await backToChat(page);
}

/** @brief 别的行：Mori 的 TaskBoard 工具与 memory、MCP、插件、扩展的工具各有，没有开关、下面一行原因。 */
function reasonRows(ctx, list) {
  const pick = (fn) => list.filter(fn).map((row) => ({ name: row.name, tag: row.tag, checked: row.checked,
    notes: row.notes, ok: row.checked === null && same(row.notes, expectedNotes(row, ctx.agentDir)) }));
  const groups = {
    task: pick((row) => row.tag === 'Mori' && row.name !== 'memory'),
    memory: pick((row) => row.name === 'memory'),
    mcp: pick((row) => row.tag === `MCP · ${MCP_NAME}`),
    plugin: pick((row) => row.tag === `Plugin ${PKG_SOURCE}`),
    extension: pick((row) => row.name === EXT_TOOL),
  };
  record('M12 没有开关的行：TaskBoard 工具"Mori turns this on and off with Task mode."、memory "Mori turns this on for the '
    + 'main agent."、MCP 的工具"Turn its server on or off in MCP."、插件的工具"Turn it on or off in Plugins."、扩展的工具'
    + '"Set by this extension. To change it, edit the extension file."，每种至少一行',
  Object.values(groups).every((rowsOf) => rowsOf.length > 0 && rowsOf.every((row) => row.ok))
    && groups.task.every((row) => same(row.notes, [TOOL_REASONS.task])), JSON.stringify(groups));
}

/**
 * @brief 打开 ls：settings.json 的 defaultTools 是 ["+ls"]、别的字段不变；这个会话里 ls 仍是"Not enabled"、发给模型的工具
 *        里没有它；工具页"New session"建的会话里它是"Enabled"、发给模型的工具里有它，调用 ls 是一张"List"卡、不出批准卡。
 */
async function turnOn(ctx) {
  resetDefaults(ctx);
  const { page } = ctx;
  await builtinView(page);
  const row = await flipTool(page, 'ls', true);
  const saved = settingsJson(ctx);
  record('M12 打开 ls：开关开着、这一行仍是"Not enabled"（开着的会话不变）；settings.json 的 defaultTools 是 ["+ls"]，'
    + '别的字段和键的顺序不变', row?.checked === true && row.state === 'Not enabled' && !row.error
    && same(saved?.defaultTools, ['+ls']) && others(saved) === ctx.baseline, JSON.stringify({ row, saved }));
  await backToChat(page);
  const old = await modelTools(ctx);
  record('M12 开着的会话里发给模型的工具没有 ls', old.length > 0 && !old.includes('ls'), old.join(', '));
  await builtinView(page);
  await newFromTools(page);
  const fresh = await builtinView(page);
  const ls = fresh.rows.find((item) => item.name === 'ls');
  await backToChat(page);
  const now = await modelTools(ctx);
  record('M12 工具页"New session"建的会话里 ls 是"Enabled"、开关开着，发给模型的工具里有 ls', ls?.state === 'Enabled'
    && ls.checked === true && now.includes('ls'), JSON.stringify({ ls, now }));
  await ctx.h.send('call tool: ls');
  await ctx.h.idle(60000);
  const card = await lastToolCard(page);
  const title = await paneOf(page).getByTestId('tool-card').last().locator('.tool-verb').innerText()
    .catch(() => '');
  const asked = await paneOf(page).getByTestId('approval-card').count();
  record('M12 新会话里调用 ls：一张"List"卡、Done，内容列出 README.md，不出批准卡（只读工具，方案 5.7）',
    title === 'List' && card.status === 'done' && card.body.includes('README.md') && asked === 0,
    JSON.stringify({ title, card: { ...card, body: oneLine(card.body, 120) }, asked }));
  await shot(page, 'turn-on');
}

/** @brief 关掉 bash（["-bash"]，再打开 ls 是 ["-bash", "+ls"]）；关掉 ls、再打开 bash 时 defaultTools 去掉。 */
async function turnOff(ctx) {
  resetDefaults(ctx);
  const { page } = ctx;
  await builtinView(page);
  const steps = [['bash', false, ['-bash']], ['ls', true, ['-bash', '+ls']], ['ls', false, ['-bash']],
    ['bash', true, undefined]];
  const seen = [];
  for (const [name, want, expected] of steps) {
    const row = await flipTool(page, name, want);
    const saved = settingsJson(ctx);
    seen.push({ name, want, checked: row?.checked, error: row?.error, saved: saved?.defaultTools ?? null,
      ok: row?.checked === want && !row.error && same(saved?.defaultTools, expected)
        && others(saved) === ctx.baseline });
  }
  record('M12 关掉 bash 写 ["-bash"]，再打开 ls 写 ["-bash", "+ls"]（先 - 后 +），关掉 ls 回到 ["-bash"]，打开 bash 后'
    + '与 pi 的默认相同、defaultTools 这一项去掉；别的字段和键的顺序一直不变', seen.every((item) => item.ok),
  JSON.stringify(seen));
  await backToChat(page);
}

/** @brief settings.json 不是 JSON：按开关时这一行下面"Couldn’t save: <路径>: <原文>"，开关回到关着，文件不变。 */
async function writeFailure(ctx) {
  resetDefaults(ctx);
  const { page } = ctx;
  const good = settingsText(ctx);
  const broken = '{ "synthetic": "not json" ';
  writeFileSync(settingsFile(ctx), broken);
  try {
    await builtinView(page);
    const row = await flipTool(page, 'grep', true);
    record('M12 settings.json 不是 JSON 时打开 grep："Couldn’t save: <settings.json 的路径>: <原文>"，开关回到关着，文件不变',
      row?.error.startsWith(`Couldn’t save: ${settingsFile(ctx)}: `) && row.checked === false
      && settingsText(ctx) === broken, JSON.stringify({ row, file: settingsText(ctx) }));
    await shot(page, 'write-failure');
  } finally {
    writeFileSync(settingsFile(ctx), good);
  }
  await backToChat(page);
}

/**
 * @brief 受信任项目 override 的 .pi/settings.json 写了 ["+grep", "-edit"]：grep 开着、edit 关着，两个开关都不可用，下面一行
 *        "Turned on / off in this project’s .pi/settings.json. …"；别的照常；这个会话里 grep 是"Enabled"、edit 是"Not enabled"。
 */
async function projectOverride(ctx) {
  resetDefaults(ctx);
  const { page } = ctx;
  await openProject(ctx, ctx.override, true);
  const view = await builtinView(page);
  const by = (name) => view.rows.find((row) => row.name === name);
  const [grep, edit, read] = ['grep', 'edit', 'read'].map(by);
  record('M12 受信任项目的 .pi/settings.json 写了 ["+grep", "-edit"]：grep 开着、edit 关着，两个开关不可用，下面一行'
    + '"Turned on（off）in this project’s .pi/settings.json. To change it, edit that file."；read 照常可用；'
    + '这个会话里 grep 是"Enabled"、edit 是"Not enabled"',
  grep?.checked === true && grep.disabled === true && grep.notes.includes(ENABLED_BY_PROJECT)
    && grep.state === 'Enabled'
    && edit?.checked === false && edit.disabled === true && same(edit.notes, [DISABLED_BY_PROJECT])
    && edit.state === 'Not enabled' && read?.checked === true && read.disabled === false,
  JSON.stringify({ grep, edit, read }));
  await shot(page, 'project-override');
  await backToChat(page);
}

/** @brief JSON 相同（数组、键的顺序都算）。 */
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const steps = { setup, rows, turnOn, turnOff, writeFailure, projectOverride };

const fake = await startFakeEndpoint(port, testKey);
const layout = makeLayout();
const ctx = { ...layout, pageErrors: [] };
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && name !== 'setup' && !only.includes(name)) continue;
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      if (ctx.page) await shot(ctx.page, `${name}-error`);
      if (await ctx.page?.getByTestId('tools-page').isVisible().catch(() => false)) {
        await backToChat(ctx.page).catch(() => {});
      }
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  fake.kill();
}
await sleep(200);
const passed = write(`m6-app-tool-switches${suffix}.json`);
// Mori 已经关了：全部通过时删掉临时目录；有失败时留着，以便查看
try {
  if (passed) rmSync(layout.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  else console.log(`[m6-app-tool-switches] layout kept in ${layout.root}`);
} catch (error) {
  console.error(`[m6-app-tool-switches] cannot remove ${layout.root}: ${error.message}`);
}
process.exitCode = passed ? 0 : 1;
