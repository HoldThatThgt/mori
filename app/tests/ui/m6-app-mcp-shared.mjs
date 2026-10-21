// M6 整机测试（MCP 共享连接，docs/v0/m6-mcp-shared.md"怎样验收"）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对
// 合成端点（tests/fake-endpoint，synthetic）和合成 MCP 服务（tests/mcp-server/server.mjs，synthetic，MORI_MCP_EXTRA=1
// 时有 pid、cwd、roots、slow 四个工具，MORI_MCP_LOG 记下它收到的每条消息）。覆盖：
//   1. 启动：还没有会话时，用户级 mcp.json 里启用的 stdio 服务已经在后台进程下面起了一个进程，只握手一次；
//   2. 两个项目的会话共用这一个进程（pid 工具的输出、进程树、日志里只有一次 initialize），调用仍出批准卡
//      "shared · pid"；工具页这一行"Running · Used by N sessions"；
//   3. 运行目录：用户级服务在用户目录里运行；项目 .pi/mcp.json 的服务在项目文件夹里运行，同一个项目的会话共用、
//      另一个项目另起一个；
//   4. roots：共享服务回答挂着的会话的项目文件夹（去重）；
//   5. 两个会话同时调用 slow：各自出批准卡；停止 A 只取消 A 的请求（服务日志里的 notifications/cancelled），B 照常做完，
//      进度只到发起的会话；几个会话经同一个连接发的请求在服务日志里编号不重复（共享连接换了编号）；
//   6. 杀掉服务进程：工具页"Failed: Connection closed"（原文只有一行，没有"Full error"），下一次调用起新进程，
//      工具页又是"Running"；
//   7. 改了配置：旧进程在旧会话关掉之前一直在，新会话用新进程，旧会话都归档之后旧进程退出；工具页这一行只显示
//      现在的配置的进程（改了之后、还没有会话用新配置时没有进程状态，C 用了之后是 C 的新进程）；项目的服务在这个项目最后一个用它的会话归档之后退出（p1：A、A2 都归档；p2：归档唯一的 B），之后这个项目新建的
//      会话起新进程；移除一个没有会话在用的服务，它的进程马上退出；停用一个有会话在用的用户级服务，进程留到那个会话
//      归档之后才退出，停用之后新建的会话不连它（它的服务日志里没有新的 tools/list）；最后一次写 mcp.json 之后，
//      p2 新建的 G 起新的 proj，归档 G 之后它退出（这期间 mcp.json 没变：关掉它的不是写入之后的过时检查）；
//   8. 退出 Mori 之后，退出前还开着的（只有 E 在用的 p1 的 proj）和测试见过的服务进程都不在了；
//   9. 另起一次 Mori（新的 userData）：用户设置 settings.json 里 "extensions": ["-builtin:mcp"] 停用了 pi 的内置 MCP 扩展，
//      用户级 mcp.json 里有一个启用的 stdio 服务 off：窗口就绪之后约 6 秒内后台进程下面一直没有它的进程（第 1 步是对照），
//      退出之后这次 Mori 的进程和带本次标记的进程都不在了。
// 会话：A、A2（p1）和 B（p2）开到第 7 步；C（p1，A、A2 归档之后新建）用新配置；D（p1）用 spare 后归档；
// E（p1，停用 shared 之后新建）开到退出；G（p2，最后一次写 mcp.json 之后新建）用 proj 后归档。
// pi 在会话启动时就连上它启用的全部服务（不等第一次调用）。
// "还在"只认本测试的后台进程下面、命令行里带本次运行标记（RUN）的 node 进程；"退出了"按整台机器上带标记的进程看
// （不只看 PID：PID 会被别的进程重用）。只结束带标记的进程（第 6 步杀掉共享进程；Mori 关了之后还留着的，最后结束掉）；
// Mori 30 秒内没有退出时结束本测试启动的进程树。
// 布局：MORI_USER_DATA=<根>/data，agentDir=<根>/data/pi（第 9 步是 <根>/data-off）；用户目录用真的（os.homedir()），
// 只有 userData 是临时的。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-mcp-shared.mjs [--exe <Mori.exe 路径>]
// 结果写到 test-results/m6-app-mcp-shared(-packaged).json，截图和服务日志在 test-results/m6-app-mcp-shared(-packaged)/。
// 各步骤按顺序依赖前一步留下的会话和进程，所以不提供 --only。

import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRoot, arg, createRecorder, kernelPid, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, answerTrustDialog, chooseMenuItem, openRow, paneOf, rowState, samePath, settle, stubFolder, until,
  waitIdle, waitPanes, waitReady,
} from './m3-helpers.mjs';
import { paneAt, sendAt, slotSelector, splitState, waitPaneReady, waitSplit } from './m5-helpers.mjs';
import { descendantsOf, openToolsSection, processList, startFakeEndpoint } from './m6-helpers.mjs';
import { pageHelpers } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const port = 4366;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m6-shared-not-a-real-key';
const shots = join(appRoot, `test-results/m6-app-mcp-shared${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write, results } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 合成 MCP 服务（synthetic） */
const MCP_SERVER = join(appRoot, 'tests', 'mcp-server', 'server.mjs');
/** 本次运行的标记：写进服务的参数（server.mjs 不读参数），在进程列表里只认命令行里带它的进程 */
const RUN = `${process.pid}-${Date.now().toString(36)}`;
/** 各个服务配置的标记：用户级 shared、改过之后的 shared、项目的 proj、后来添加的 spare、第 9 步停用内置 MCP 时的 off */
const MARK = { shared: `synthetic-shared-${RUN}`, v2: `synthetic-shared-v2-${RUN}`, proj: `synthetic-proj-${RUN}`,
  spare: `synthetic-spare-${RUN}`, off: `synthetic-off-${RUN}` };
/** 项目服务的日志：相对路径，服务在项目文件夹里运行时就写在项目文件夹里（两个项目的 .pi/mcp.json 一字不差） */
const PROJ_LOG = 'mori-mcp-proj.log';
/** 两个会话同时调用的 slow 参数：步数不同，进度文字（Progress k/9、k/6）能分出是谁的 */
const SLOW = { A: { ms: 9000, steps: 9 }, B: { ms: 6000, steps: 6 } };
/** 等 Mori 自己退出的最长时间；超过就结束本测试启动的进程树（app.close 本身不限时） */
const CLOSE_TIMEOUT_MS = 30000;
/** 第 9 步：窗口就绪之后看多久有没有起服务进程（第 1 步没停用时，同样的启动在这之前就起好了） */
const OFF_WAIT_MS = 6000;

// ---------- 准备 ----------

/** @brief 写 JSON 文件（2 空格缩进加换行），没有文件夹时建好。 */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @brief 读 JSON 文件；不存在时为 null。 */
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

/** @brief 一个合成 MCP 服务的 mcpServers 条目（synthetic）：node server.mjs <标记>，直接调用。 */
function serverEntry(mark, env) {
  return { command: 'node', args: [MCP_SERVER, mark], env, exposure: 'direct' };
}

/** @brief 一个项目文件夹：README 和 .pi/mcp.json 里的项目服务 proj（两个项目的内容相同）。 */
function makeProject(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# Mori fixture project ${name}\n\nsynthetic\n`);
  writeJson(join(dir, '.pi', 'mcp.json'), { mcpServers: {
    proj: serverEntry(MARK.proj, { MORI_MCP_EXTRA: '1', MORI_MCP_LOG: PROJ_LOG }) } });
  return dir;
}

/** @brief 布局：数据目录（用户级 mcp.json 里一个启用的 shared）和两个已信任的项目 p1、p2。 */
function makeLayout() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-shared-'));
  const userData = join(root, 'data');
  const agentDir = join(userData, 'pi');
  const logs = { shared: join(root, 'shared.log'), v2: join(root, 'shared-v2.log') };
  writeJson(join(agentDir, 'mcp.json'), { $comment: 'synthetic: written by tests/ui/m6-app-mcp-shared.mjs',
    mcpServers: { shared: serverEntry(MARK.shared, { MORI_MCP_EXTRA: '1', MORI_MCP_LOG: logs.shared }) } });
  return { root, userData, agentDir, logs, p1: makeProject(root, 'p1'), p2: makeProject(root, 'p2') };
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错和后台进程里关于 MCP 的日志行，找到后台进程的 PID。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  for (const stream of [ctx.app.process().stdout, ctx.app.process().stderr]) {
    stream?.on('data', (chunk) => ctx.kernelLog.push(...String(chunk).split(/\r?\n/)
      .filter((line) => line.includes('[kernel]') && line.includes('MCP'))));
  }
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
  await ctx.page.waitForFunction(() => window.mori, null, { timeout: 60000 });
  ctx.kernel = kernelPid(ctx.app.process().pid);
}

/**
 * @brief 关掉 Mori，最多等 CLOSE_TIMEOUT_MS；超时就结束本测试启动的进程树（taskkill /T）。
 *        返回它是不是按时自己退出了；ctx.app 随后为 null。
 */
async function closeApp(ctx) {
  const app = ctx.app;
  ctx.app = null;
  if (!app) return true;
  let timer;
  const late = new Promise((done) => {
    timer = setTimeout(() => done(false), CLOSE_TIMEOUT_MS);
  });
  const closed = await Promise.race([app.close().then(() => true, () => true), late]);
  clearTimeout(timer);
  if (closed) return true;
  console.error(`[m6-app-mcp-shared] Mori did not quit within ${CLOSE_TIMEOUT_MS} ms; killing its process tree`);
  try {
    execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (error) {
    console.error(`[m6-app-mcp-shared] cannot kill the Mori process tree: ${error.message}`);
  }
  return false;
}

// ---------- 进程与服务日志 ----------

/** @brief 是不是本次运行的合成服务进程：跑 server.mjs、命令行里带本次标记的 node 进程。 */
const isOurServer = (row) => /^node(\.exe)?$/i.test(row.name) && row.command.includes('server.mjs')
  && row.command.includes(RUN);

/** @brief 本测试的后台进程下面、跑 server.mjs 且命令行里有 mark 的 node 进程；记进见过的 PID。 */
function serverProcs(ctx, mark) {
  const procs = descendantsOf(ctx.kernel).filter((row) => isOurServer(row) && row.command.includes(mark));
  for (const row of procs) ctx.seen.add(row.pid);
  return procs;
}

/** @brief pids 里还在本测试的后台进程下面运行的本次服务进程（按命令行认，不只看 PID）。 */
function alive(ctx, pids) {
  const ours = new Set(descendantsOf(ctx.kernel).filter(isOurServer).map((row) => row.pid));
  return pids.filter((pid) => ours.has(pid));
}

/**
 * @brief 等 pids 里的服务进程都退出，最多 timeoutMs；返回还在的。按整台机器上带本次标记的服务进程找（脱离了后台进程的
 *        也算还在），PID 被别的进程重用了不算还在。
 */
async function serversGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const marked = new Set(processList().filter(isOurServer).map((row) => row.pid));
    const left = pids.filter((pid) => marked.has(pid));
    if (left.length === 0 || Date.now() > deadline) return left;
    await sleep(250);
  }
}

/** @brief 服务日志里的消息（每行一条 JSON-RPC）；没有文件时为空。 */
function logMessages(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** @brief 服务日志里 initialize 的次数（每次握手一次）。 */
const initializes = (file) => logMessages(file).filter((message) => message.method === 'initialize').length;
/**
 * @brief 服务日志里 tools/list 的次数：每个连上这个服务的会话发一次（握手按缓存回答，所以新会话挂上已经开着的
 *        连接时只看得到这一条）。
 */
const toolLists = (file) => logMessages(file).filter((message) => message.method === 'tools/list').length;

/** @brief 输出是一个 PID 时返回它，否则为 null。 */
function pidOf(output) {
  const match = /^\s*(\d+)\s*$/.exec(output ?? '');
  return match ? Number(match[1]) : null;
}

/** @brief roots 工具的输出（根目录的 JSON 数组）里的文件夹，转成小写路径、排好序；解析不了时为 null。 */
function rootFolders(output) {
  try {
    const roots = JSON.parse(output.slice(output.indexOf('['), output.lastIndexOf(']') + 1));
    return roots.map((root) => resolve(fileURLToPath(root.uri)).toLowerCase()).sort();
  } catch {
    return null;
  }
}

/** @brief 文件夹转成与 rootFolders 相同的写法（小写、排好序）。 */
const folders = (...dirs) => dirs.map((dir) => resolve(dir).toLowerCase()).sort();

// ---------- 页面 ----------

/** @brief 当前一栏（或 slot 里那一栏）最后一张工具卡：状态和展开后"Output"下面的文字。 */
async function cardOutput(page, slot = '.pane-slot:not([hidden])') {
  const card = page.locator(`${slot} [data-testid="chat-pane"] [data-testid="tool-card"]`).last();
  const status = await card.getAttribute('data-status', { timeout: 5000 });
  if (!(await card.evaluate((element) => element.open))) await card.locator('summary').click();
  await card.locator('.tool-body').waitFor({ timeout: 5000 });
  const output = await card.evaluate((element) => {
    const label = [...element.querySelectorAll('.tool-section-label')].find((item) => item.textContent === 'Output');
    return label?.nextElementSibling?.textContent ?? '';
  });
  return { status, output };
}

/**
 * @brief 在当前一栏发"[label] call tool: <tool> <args>"（合成端点按它调用工具；label 让各会话的名字分得开），
 *        等批准卡、记下工具名和标题，Alt+1 允许，等这一轮结束；返回批准卡和工具卡（状态、输出）。
 */
async function callTool(ctx, label, tool, args = null) {
  const { page, h } = ctx;
  await h.send(`[${label}] call tool: ${tool}${args ? ` ${JSON.stringify(args)}` : ''}`);
  const card = paneOf(page).getByTestId('approval-card');
  await card.waitFor({ timeout: 30000 });
  const name = await card.getAttribute('data-tool');
  const title = (await card.getByTestId('approval-title').innerText()).trim();
  await page.keyboard.press('Alt+1');
  await card.waitFor({ state: 'detached', timeout: 10000 });
  await waitIdle(page, 60000);
  return { tool: name, title, ...(await cardOutput(page)) };
}

/** @brief 点"Back to app"，等工具页关上。 */
async function backToChat(page) {
  await page.getByTestId('tools-page').getByRole('button', { name: 'Back to app' }).click();
  await page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 });
  await settle(page);
}

/**
 * @brief 工具页 MCP 一节里一行（名字、来源）的进程状态：有没有这一行、有没有进程状态（mcp-process）、data-state、
 *        状态一行（p）的文字、"Full error"（details.tools-full-notice 的 summary 和 pre；没有时为 null）、
 *        进程状态里有没有"Full error"几个字、这一行的工具名（mcp-tools）、跟随的会话。
 */
function processOf(page, server, scope) {
  return page.evaluate(({ name, where }) => {
    const row = document.querySelector(`[data-testid="mcp-row"][data-server="${name}"][data-scope="${where}"]`);
    const line = row?.querySelector('[data-testid="mcp-process"]');
    const full = line?.querySelector('details.tools-full-notice');
    return { row: Boolean(row), line: Boolean(line), state: line?.dataset.state ?? null,
      text: line?.querySelector(':scope > p')?.textContent?.trim() ?? null,
      full: full ? { summary: full.querySelector('summary')?.textContent?.trim() ?? '',
        text: full.querySelector('pre')?.textContent ?? '' } : null,
      fullWord: Boolean(line?.textContent?.includes('Full error')),
      tools: row?.querySelector('[data-testid="mcp-tools"]')?.textContent?.trim() ?? null,
      follow: document.querySelector('[data-testid="tools-follow"]')?.textContent?.trim() ?? '' };
  }, { name: server, where: scope });
}

/**
 * @brief 进入工具页的 MCP 一节读这一行的进程状态，直到 want(读到的) 为真或过了 timeoutMs。工具页不自动刷新、
 *        每次进入时重新读取；开着的工具页在保存、启停之后重新读取时旧内容留到新结果到达，所以每次（包括第一次）
 *        都先返回会话再进来，读到的一定是这一刻的。返回最后一次读到的；读完留在工具页。
 */
async function readProcess(ctx, server, scope, want, timeoutMs = 15000) {
  const { page } = ctx;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.getByTestId('tools-page').isVisible().catch(() => false)) await backToChat(page);
    await openToolsSection(page, 'mcp');
    await page.locator(`[data-testid="mcp-row"][data-server="${server}"]`).first().waitFor({ timeout: 10000 })
      .catch(() => {});
    const seen = await processOf(page, server, scope);
    if (want(seen) || Date.now() > deadline) return seen;
    await sleep(500);
  }
}

/** @brief 工具页里一行的"Running · Used by N sessions"（N 为 0 时"Running · Not in use"）。 */
const runningText = (count) => (count > 0 ? `Running · Used by ${count} ${count === 1 ? 'session' : 'sessions'}`
  : 'Running · Not in use');
/** @brief 读到的进程状态是不是"Running"、在用的会话数是 count。 */
const runningWith = (count) => (seen) => seen.state === 'running' && seen.text === runningText(count);
/** @brief 读到的这一行在，但没有进程状态（共享服务表里没有现在的配置的进程）。 */
const noProcess = (seen) => seen.row && !seen.line && seen.state === null && seen.text === null;

/** @brief 点左栏"Open folder…"选 folder，在信任询问里选"Trust workspace"并勾"Remember my choice"，等会话就绪。 */
async function openTrusted(ctx, folder) {
  await stubFolder(ctx.app, folder);
  await ctx.page.getByRole('button', { name: 'Open folder…' }).first().click();
  await answerTrustDialog(ctx.page, { answer: 'Trust workspace', remember: true });
  await settle(ctx.page);
}

/**
 * @brief 点左栏"Open folder…"选一个第 2 步已经信任并记住的文件夹（不再问信任），等新会话就绪
 *        （还没有会话文件：第一条回复之后才有）。
 */
async function openKnown(ctx, folder) {
  const before = await ctx.page.locator('.pane-slot').count();
  await stubFolder(ctx.app, folder);
  await ctx.page.getByRole('button', { name: 'Open folder…' }).first().click();
  await waitPanes(ctx.page, before + 1);
  await waitReady(ctx.page);
  await settle(ctx.page);
}

/** @brief PID 列表按数值排好序（比较前用）。 */
const sorted = (pids) => [...pids].sort((left, right) => left - right);

/** @brief 按 Ctrl+N 在当前项目里新建会话，等它就绪（还没有会话文件：第一条回复之后才有）。 */
async function newByCtrlN(page) {
  const before = await page.locator('.pane-slot').count();
  await page.keyboard.press('Control+n');
  await waitPanes(page, before + 1);
  await waitReady(page);
  await settle(page);
}

/** @brief 工具页顶部的"New session"（在跟随的项目里新建），等新的一栏就绪。 */
async function newFromTools(page) {
  const before = await page.locator('.pane-slot').count();
  await page.getByTestId('tools-page').locator('.tools-notice').getByRole('button', { name: 'New session' }).click();
  await waitPanes(page, before + 1);
  await waitReady(page);
  await settle(page);
}

/** @brief 在侧栏归档一个会话（右键菜单"Archive"：关闭后台进程里的这个会话），等它的行从会话树里消失；10 秒内没消失时报错。 */
async function archive(ctx, file) {
  if (!file) throw new Error('no session file to archive');
  await chooseMenuItem(ctx.page, file, 'Archive');
  if (!(await until(async () => (await rowState(ctx.page, file)) === null, 10000, 200))) {
    throw new Error(`${file} is still in the session tree 10 s after archiving`);
  }
}

/**
 * @brief 表单里文字为 label 的那一栏的输入框（同 m6-app-tools.mjs：有初值的 textarea 按标签全文匹配不到，
 *        所以按 label 里的 span 找）。
 */
const field = (form, label) => form.locator(`label:has(> span:text-is("${label}"))`).locator('input, textarea');

/** @brief 在工具页 MCP 一节打开表单（opener 是"Edit"或"Add"按钮），填 values（标签 → 内容），保存，等表单关上。 */
async function saveForm(page, opener, values) {
  await opener.click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  for (const [label, value] of Object.entries(values)) await field(form, label).fill(value);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
}

// ---------- 步骤 ----------

/** @brief 1. 启动：还没有会话时，shared 已经在后台进程下面起了一个 node 进程，日志里只有一次 initialize。 */
async function startup(ctx) {
  await startApp(ctx);
  const { page } = ctx;
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  await until(() => initializes(ctx.logs.shared) > 0, 30000, 300);
  await until(() => serverProcs(ctx, MARK.shared).length > 0, 30000, 500);
  // 留一秒，万一起了第二个进程或握了第二次手，也来得及出现
  await sleep(1000);
  const procs = serverProcs(ctx, MARK.shared);
  const panes = await page.locator('.pane-slot').count();
  ctx.pids.s0 = procs[0]?.pid ?? null;
  record('1 启动：还没有会话（首次启动的连接表单，没有会话面板）时，用户级 mcp.json 里启用的 stdio 服务 shared 已经'
    + '在后台进程下面起了一个 node 进程（跑 server.mjs）', panes === 0 && procs.length === 1,
  JSON.stringify({ panes, kernel: ctx.kernel,
    procs: procs.map((row) => ({ ...row, direct: row.parent === ctx.kernel })) }));
  record('1 启动：服务日志里只有一次 initialize（共享服务自己握手一次）', initializes(ctx.logs.shared) === 1,
    `initialize × ${initializes(ctx.logs.shared)}`);
  await ctx.h.fillConnection({ name: '合成端点', baseUrl, apiKey: testKey, modelId: 'fake-coder' });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
}

/** @brief 2. 两个项目的会话调用 shared 的 pid：出批准卡"shared · pid"，拿到启动时那个进程的 PID。 */
async function sharing(ctx) {
  const { page } = ctx;
  await openTrusted(ctx, ctx.p1);
  const a = await callTool(ctx, 'A', 'mcp__shared__pid');
  ctx.files.A = await activeFile(page);
  record('2 会话 A（项目 p1）调用 mcp__shared__pid 出批准卡，标题"shared · pid"；允许后拿到的 PID 就是启动时起的那个进程',
    a.tool === 'mcp__shared__pid' && a.title === 'shared · pid' && a.status === 'done'
    && pidOf(a.output) === ctx.pids.s0 && ctx.pids.s0 !== null, JSON.stringify({ ...a, startup: ctx.pids.s0 }));
  await openTrusted(ctx, ctx.p2);
  const b = await callTool(ctx, 'B', 'mcp__shared__pid');
  ctx.files.B = await activeFile(page);
  record('2 会话 B（另一个项目 p2）调用 mcp__shared__pid 也出批准卡"shared · pid"，拿到同一个 PID',
    b.title === 'shared · pid' && b.status === 'done' && pidOf(b.output) === ctx.pids.s0, JSON.stringify(b));
  const procs = serverProcs(ctx, MARK.shared);
  record('2 两个项目的会话都用过之后：shared 仍只有这一个进程，服务日志里仍只有一次 initialize（第二个会话按握手缓存回答）',
    procs.length === 1 && procs[0].pid === ctx.pids.s0 && initializes(ctx.logs.shared) === 1,
    JSON.stringify({ procs: procs.map((row) => row.pid), initialize: initializes(ctx.logs.shared) }));
  const seen = await readProcess(ctx, 'shared', 'user', runningWith(2));
  await shot(page, '2-running-2');
  record('2 工具页 shared 一行的进程状态：data-state="running"，"运行中 · 2 个会话在用"（开着的会话 A、B）',
    runningWith(2)(seen), JSON.stringify(seen));
  await backToChat(page);
}

/** @brief 3（用户级）：会话 B 里 shared 的 cwd 是用户目录；proj 的 cwd 是 p2，记下 B 的 proj 进程。 */
async function runFolderUser(ctx) {
  const home = await callTool(ctx, 'B', 'mcp__shared__cwd');
  record('3 用户级服务在用户目录里运行：shared 的 cwd 工具返回 os.homedir()', home.status === 'done'
    && samePath(home.output.trim(), homedir()), JSON.stringify({ output: home.output, home: homedir() }));
  const cwd = await callTool(ctx, 'B', 'mcp__proj__cwd');
  const pid = await callTool(ctx, 'B', 'mcp__proj__pid');
  ctx.pids.projB = pidOf(pid.output);
  record('3 项目 p2 的 .pi/mcp.json 里的 proj 在 p2 文件夹里运行（cwd 工具），批准卡标题"proj · cwd"',
    cwd.title === 'proj · cwd' && samePath(cwd.output.trim(), ctx.p2) && ctx.pids.projB !== null,
    JSON.stringify({ cwd, pid: pid.output }));
}

/** @brief 3（项目级）：p1 的两个会话 A、A2 共用一个 proj 进程，与 p2 的不同；各项目只握手一次。 */
async function runFolderProject(ctx) {
  const { page } = ctx;
  await openRow(page, ctx.files.A);
  const cwd = await callTool(ctx, 'A', 'mcp__proj__cwd');
  ctx.pids.projA = pidOf((await callTool(ctx, 'A', 'mcp__proj__pid')).output);
  record('3 项目 p1 的 proj 在 p1 文件夹里运行（cwd 工具）', samePath(cwd.output.trim(), ctx.p1), cwd.output);
  await newByCtrlN(page);
  const a2 = pidOf((await callTool(ctx, 'A2', 'mcp__proj__pid')).output);
  ctx.files.A2 = await activeFile(page);
  const shared = pidOf((await callTool(ctx, 'A2', 'mcp__shared__pid')).output);
  const procs = serverProcs(ctx, MARK.proj).map((row) => row.pid).sort();
  const logs = [initializes(join(ctx.p1, PROJ_LOG)), initializes(join(ctx.p2, PROJ_LOG))];
  record('3 同一个项目 p1 的两个会话（A、Ctrl+N 新建的 A2）共用一个 proj 进程；另一个项目 p2（.pi/mcp.json 一字不差）'
    + '另起一个；后台进程下面正好这两个 proj 进程，每个项目的服务日志（写在项目文件夹里）各只有一次 initialize',
  ctx.pids.projA !== null && a2 === ctx.pids.projA && ctx.pids.projB !== ctx.pids.projA
    && JSON.stringify(procs) === JSON.stringify([ctx.pids.projA, ctx.pids.projB].sort())
    && logs[0] === 1 && logs[1] === 1, JSON.stringify({ A: ctx.pids.projA, A2: a2, B: ctx.pids.projB, procs, logs }));
  record('3 第三个会话 A2 里 shared 仍是启动时那个进程', shared === ctx.pids.s0
    && serverProcs(ctx, MARK.shared).length === 1, `A2: ${shared}, startup: ${ctx.pids.s0}`);
  const user = await readProcess(ctx, 'shared', 'user', runningWith(3));
  const proj = await processOf(page, 'proj', 'project');
  await shot(page, '3-running-3');
  record('3 工具页（跟随 p1 的 A2）：shared"运行中 · 3 个会话在用"；本项目的 proj"运行中 · 2 个会话在用"（A、A2）',
    runningWith(3)(user) && runningWith(2)(proj), JSON.stringify({ user, proj }));
  await backToChat(page);
}

/** @brief 4. roots：shared 回答三个会话的项目文件夹去重后的 p1、p2；p1 的 proj 只回答 p1。 */
async function roots(ctx) {
  const shared = await callTool(ctx, 'A2', 'mcp__shared__roots');
  const proj = await callTool(ctx, 'A2', 'mcp__proj__roots');
  record('4 roots：shared（A、B、A2 三个会话挂着）的 roots 工具返回 p1、p2 两个文件夹（file URL，去重）',
    JSON.stringify(rootFolders(shared.output)) === JSON.stringify(folders(ctx.p1, ctx.p2)), shared.output);
  record('4 roots：p1 的 proj（A、A2 两个会话挂着，同一个文件夹）只返回 p1 一个',
    JSON.stringify(rootFolders(proj.output)) === JSON.stringify(folders(ctx.p1)), proj.output);
}

/**
 * @brief 开始记录左右两栏最后一张工具卡"Output"下面出现过的文字（MutationObserver：进度一条接一条地换，轮询会漏）。
 */
function watchOutputs(page) {
  return page.evaluate(() => {
    window.__outputs = { left: [], right: [] };
    window.__outputsObserver?.disconnect();
    const read = () => {
      for (const side of ['left', 'right']) {
        const cards = document.querySelectorAll(`.pane-slot[data-side="${side}"] [data-testid="tool-card"]`);
        const label = [...(cards[cards.length - 1]?.querySelectorAll('.tool-section-label') ?? [])]
          .find((item) => item.textContent === 'Output');
        const text = label?.nextElementSibling?.textContent ?? '';
        if (text && window.__outputs[side].at(-1) !== text) window.__outputs[side].push(text);
      }
    };
    window.__outputsObserver = new MutationObserver(read);
    window.__outputsObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    read();
  });
}

/** @brief 停下 watchOutputs，返回两栏出现过的输出。 */
const seenOutputs = (page) => page.evaluate(() => {
  window.__outputsObserver?.disconnect();
  return window.__outputs;
});

/** @brief 5 的前半：左右分屏放 A、B，各发一个 slow，两张批准卡都出现后依次点"Allow once"，展开两张工具卡。 */
async function startTwoSlow(ctx) {
  const { page } = ctx;
  await openRow(page, ctx.files.A);
  await chooseMenuItem(page, ctx.files.B, 'Open in split view');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  const panes = (await splitState(page)).slots.map((slot) => slot.title);
  if (!panes[0]?.startsWith('[A]') || !panes[1]?.startsWith('[B]')) throw new Error(`unexpected split: ${panes}`);
  await sendAt(page, 'left', `[A] call tool: mcp__shared__slow ${JSON.stringify(SLOW.A)}`);
  await sendAt(page, 'right', `[B] call tool: mcp__shared__slow ${JSON.stringify(SLOW.B)}`);
  const titles = [];
  for (const side of ['left', 'right']) {
    const card = paneAt(page, side).getByTestId('approval-card');
    await card.waitFor({ timeout: 30000 });
    titles.push((await card.getByTestId('approval-title').innerText()).trim());
  }
  await watchOutputs(page);
  for (const side of ['left', 'right']) {
    await paneAt(page, side).getByTestId('approval-allow').click();
    await paneAt(page, side).getByTestId('approval-card').waitFor({ state: 'detached', timeout: 10000 });
  }
  for (const side of ['left', 'right']) {
    const card = paneAt(page, side).getByTestId('tool-card').last();
    if (!(await card.evaluate((element) => element.open))) await card.locator('summary').click();
  }
  return titles;
}

/** @brief 服务日志里 slow 的 tools/call（共享连接换过的编号、参数 ms、带没带 progressToken）。 */
function slowCalls(ctx) {
  return logMessages(ctx.logs.shared).filter((message) => message.method === 'tools/call'
    && message.params?.name === 'slow').map((message) => ({ id: message.id, ms: message.params.arguments?.ms,
    token: message.params._meta?.progressToken ?? null }));
}

/** @brief 服务日志里 notifications/cancelled 取消的请求编号。 */
const cancelledIds = (ctx) => logMessages(ctx.logs.shared)
  .filter((message) => message.method === 'notifications/cancelled').map((message) => message.params?.requestId);

/**
 * @brief 服务日志按连接分段（每个 initialize 开始一段），每段里服务收到的请求编号重复的；不重复时为空数组。
 *        不算通知（没有编号）和客户端对服务请求（roots/list）的回答（没有 method）。
 */
function duplicateIds(file) {
  const segments = [];
  for (const message of logMessages(file)) {
    if (message.method === undefined || message.id === undefined || message.id === null) continue;
    if (message.method === 'initialize') segments.push([]);
    segments.at(-1)?.push(message.id);
  }
  return segments.flatMap((ids) => ids.filter((id, index) => ids.indexOf(id) !== index));
}

/** @brief 等某一栏这一轮结束（running 和 sending 都是 false）。 */
function waitSideIdle(page, side, timeout) {
  return page.waitForFunction((css) => {
    const pane = document.querySelector(css);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false';
  }, `${slotSelector(side)} [data-testid="chat-pane"]`, { timeout });
}

/** @brief 5. 两个会话同时调用 slow，停止 A：只取消 A 的请求，B 照常做完；进度只到发起的会话。 */
async function concurrency(ctx) {
  const { page } = ctx;
  const titles = await startTwoSlow(ctx);
  await until(() => slowCalls(ctx).length === 2, 15000, 200);
  await page.waitForFunction(() => window.__outputs.left.some((text) => text.startsWith('Progress')), null,
    { timeout: 8000 }).catch(() => {});
  const bRunning = await paneAt(page, 'right').getAttribute('data-running');
  await page.locator(`${slotSelector('left')} .stop-button`).click();
  await waitSideIdle(page, 'left', 30000);
  await waitSideIdle(page, 'right', 60000);
  await until(() => cancelledIds(ctx).length > 0, 5000, 200);
  const outputs = await seenOutputs(page);
  const a = await cardOutput(page, slotSelector('left'));
  const b = await cardOutput(page, slotSelector('right'));
  await shot(page, '5-concurrency');
  record('5 两个会话同时调用 shared 的 slow：两边各自出批准卡（标题"shared · slow"）', titles.length === 2
    && titles.every((title) => title === 'shared · slow'), JSON.stringify(titles));
  record('5 在 A 那一栏按停止时 B 还在运行；B 的调用照常做完：工具卡"完成"，输出"slow done 6"；A 的工具卡"已停止"',
    bRunning === 'true' && b.status === 'done' && b.output.trim() === 'slow done 6' && a.status === 'stopped',
    JSON.stringify({ bRunning, a, b }));
  cancelChecks(ctx);
  progressChecks(outputs);
}

/** @brief 5 的服务日志：两次 slow 的编号不同，notifications/cancelled 只取消 A 的那个。 */
function cancelChecks(ctx) {
  const calls = slowCalls(ctx);
  const idA = calls.find((call) => call.ms === SLOW.A.ms)?.id;
  const idB = calls.find((call) => call.ms === SLOW.B.ms)?.id;
  const cancelled = cancelledIds(ctx);
  record('5 服务日志：两次 slow 经共享连接换成了不同的编号；notifications/cancelled 只有 A 那次请求的编号，没有 B 的',
    calls.length === 2 && idA !== undefined && idB !== undefined && idA !== idB && cancelled.includes(idA)
    && !cancelled.includes(idB), JSON.stringify({ calls, cancelled }));
  // 上一条只看两次 slow：各会话自己的编号本来就可能不同。各会话的 pi 都从同样的编号数起（tools/list、pid 等），
  // 不换编号就会在服务日志里撞车，所以看整段日志：A、B、A2 用过的 shared，A、A2 用过的 p1 的 proj
  const files = { shared: ctx.logs.shared, proj: join(ctx.p1, PROJ_LOG) };
  const counts = Object.fromEntries(Object.entries(files).map(([name, file]) => [name,
    logMessages(file).filter((message) => message.method !== undefined && message.id != null).length]));
  const duplicates = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, duplicateIds(file)]));
  record('5 服务日志：几个会话经同一个连接发给服务的请求，编号一个都不重复（共享连接换成了自己的编号）；'
    + 'shared（A、B、A2）和 p1 的 proj（A、A2）都是', counts.shared >= 8 && counts.proj >= 6
    && Object.values(duplicates).every((ids) => ids.length === 0), JSON.stringify({ counts, duplicates }));
}

/** @brief 5 的进度：A 的工具卡只出现过 A 的进度（k/9），B 的只出现过 B 的（k/6）。 */
function progressChecks(outputs) {
  const progress = (side) => outputs[side].filter((text) => text.startsWith('Progress'));
  const only = (side, total) => progress(side).length > 0
    && progress(side).every((text) => new RegExp(`^Progress \\d+/${total}$`).test(text.trim()));
  record('5 进度：pi 把服务的进度显示在工具卡的输出里；A 的工具卡只出现过 A 的进度（Progress k/9），'
    + 'B 的工具卡只出现过 B 自己的（Progress k/6），没有 A 的', only('left', SLOW.A.steps) && only('right', SLOW.B.steps),
  JSON.stringify(outputs));
}

/** @brief 6. 杀掉共享的 shared 进程：工具页"Failed: Connection closed"；B 的下一次调用起新进程，工具页又是"Running"。 */
async function crash(ctx) {
  const { page } = ctx;
  await page.locator(`${slotSelector('left')} [data-testid="close-pane"]`).click();
  await waitSplit(page, false);
  const old = ctx.pids.s0;
  if (!serverProcs(ctx, MARK.shared).some((row) => row.pid === old)) throw new Error(`${old} is not our shared server`);
  execFileSync('taskkill', ['/PID', String(old), '/F'], { stdio: 'ignore' });
  const left = await serversGone([old], 10000);
  const failed = await readProcess(ctx, 'shared', 'user', (seen) => seen.state === 'failed');
  await shot(page, '6-failed');
  record('6 杀掉共享的 shared 进程（taskkill /F）后重新进入工具页：这一行 data-state="failed"，状态一行是'
    + '"失败：Connection closed"（pi 的原文；合成服务不写 stderr，原文只有一行），下面没有"完整原文"',
  left.length === 0 && failed.state === 'failed' && failed.text === 'Failed: Connection closed'
    && failed.full === null && !failed.fullWord, JSON.stringify({ left, failed }));
  await backToChat(page);
  await openRow(page, ctx.files.B);
  const b = await callTool(ctx, 'B', 'mcp__shared__pid');
  ctx.pids.s1 = pidOf(b.output);
  const procs = serverProcs(ctx, MARK.shared).map((row) => row.pid);
  record('6 之后会话 B 再调用 pid（批准卡照常）：起了一个新进程（新 PID），后台进程下面只有它一个 shared 进程',
    b.status === 'done' && ctx.pids.s1 !== null && ctx.pids.s1 !== old && JSON.stringify(procs) === `[${ctx.pids.s1}]`,
    JSON.stringify({ old, now: b.output, procs }));
  const one = await readProcess(ctx, 'shared', 'user', (seen) => seen.state === 'running');
  record('6 工具页这一行又是"运行中"；只有重新连上的 B 在用："运行中 · 1 个会话在用"（A、A2 下一次调用时才重连）',
    runningWith(1)(one), JSON.stringify(one));
  await backToChat(page);
  await reconnectOthers(ctx);
}

/** @brief 6 的后半：A、A2 再调用 pid 也连到这个新进程（不再起别的）；工具页"Running · Used by 3 sessions"。 */
async function reconnectOthers(ctx) {
  const { page } = ctx;
  const pids = {};
  for (const name of ['A', 'A2']) {
    await openRow(page, ctx.files[name]);
    pids[name] = pidOf((await callTool(ctx, name, 'mcp__shared__pid')).output);
  }
  const procs = serverProcs(ctx, MARK.shared).map((row) => row.pid);
  record('6 A、A2 再调用 pid 也拿到这个新进程；shared 仍只有一个进程，服务日志里一共两次 initialize（旧的、新的各一次）',
    pids.A === ctx.pids.s1 && pids.A2 === ctx.pids.s1 && JSON.stringify(procs) === `[${ctx.pids.s1}]`
    && initializes(ctx.logs.shared) === 2, JSON.stringify({ pids, new: ctx.pids.s1, procs,
    initialize: initializes(ctx.logs.shared) }));
  const three = await readProcess(ctx, 'shared', 'user', runningWith(3));
  record('6 三个会话都重新连上之后，工具页"运行中 · 3 个会话在用"', runningWith(3)(three), JSON.stringify(three));
}

/**
 * @brief 7 的前半：在工具页编辑 shared（参数换成 v2 标记、日志换一个文件）；三个旧会话还开着，旧进程不关；
 *        工具页这一行只显示现在的配置的进程，还没有会话用新配置，所以没有进程状态。
 */
async function editShared(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'mcp');
  const row = page.locator('[data-testid="mcp-row"][data-server="shared"][data-scope="user"]');
  await saveForm(page, row.getByRole('button', { name: 'Edit', exact: true }),
    { Arguments: `${MCP_SERVER}\n${MARK.v2}`,
      'Environment variables': `MORI_MCP_EXTRA=1\nMORI_MCP_LOG=${ctx.logs.v2}` });
  const entry = readJson(join(ctx.agentDir, 'mcp.json'))?.mcpServers?.shared;
  record('7 在工具页编辑 shared（参数加上新的标记、日志换成另一个文件）并保存：mcp.json 里 shared 的 args 和 env 是新的',
    JSON.stringify(entry?.args) === JSON.stringify([MCP_SERVER, MARK.v2]) && entry?.env?.MORI_MCP_LOG === ctx.logs.v2,
    JSON.stringify(entry));
  const seen = await readProcess(ctx, 'shared', 'user', noProcess);
  const living = alive(ctx, [ctx.pids.s1]);
  await shot(page, '7-edited');
  record('7 改了配置之后，三个旧会话还开着：旧进程还在；工具页 shared 一行在，但没有进程状态（这一行只显示现在的配置'
    + '的进程，还没有会话用新配置；旧进程不算在这一行里）', living.length === 1 && noProcess(seen),
  JSON.stringify({ alive: living, seen }));
}

/**
 * @brief 7. 改了配置：旧会话还开着时旧进程一直在；项目的服务在这个项目最后一个会话归档之后退出；之后 p1 新建的会话 C
 *        用新配置的 shared 和 p1 新起的 proj；归档 B（旧配置最后一个会话，也是 p2 唯一的会话）之后旧的 shared 和
 *        p2 的 proj 都退出。
 */
async function staleConfig(ctx) {
  await editShared(ctx);
  await backToChat(ctx.page);
  await releaseP1(ctx);
  await newInP1(ctx);
  await releaseB(ctx);
}

/**
 * @brief 7（p1 的项目服务）：归档 A 之后 p1 的 proj 还在（A2 还在用），工具页 proj"Running · Used by 1 session"；
 *        再归档 A2（p1 最后一个会话）之后它退出。旧配置的 shared 一直在（B 还在用）。
 */
async function releaseP1(ctx) {
  const { page } = ctx;
  if (!ctx.pids.projA || !ctx.pids.s1) throw new Error(`missing pids: ${JSON.stringify(ctx.pids)}`);
  await archive(ctx, ctx.files.A);
  // 关闭是异步的：留一会儿，进程要是被提早关掉也来得及看到
  await sleep(1500);
  const kept = alive(ctx, [ctx.pids.projA, ctx.pids.s1]);
  const proj = await readProcess(ctx, 'proj', 'project', runningWith(1));
  const user = await processOf(page, 'shared', 'user');
  await shot(page, '7-after-archive-A');
  await backToChat(page);
  await archive(ctx, ctx.files.A2);
  const left = await serversGone([ctx.pids.projA], 10000);
  const shared = alive(ctx, [ctx.pids.s1]);
  record('7 项目 p1 的 proj：归档 A 之后进程还在（同一个项目的 A2 还在用），工具页（跟随 A2）proj 一行'
    + '"运行中 · 1 个会话在用"；再归档 A2（p1 最后一个用它的会话）之后进程退出（10 秒内）',
  kept.includes(ctx.pids.projA) && runningWith(1)(proj) && left.length === 0,
  JSON.stringify({ projA: ctx.pids.projA, kept, proj, left }));
  record('7 归档 A、A2 之后旧配置的 shared 进程还在（B 还在用旧配置）；归档 A 之后工具页 shared 一行仍没有进程状态'
    + '（A2、B 用的是旧配置的进程，还没有会话用新配置）', kept.includes(ctx.pids.s1) && shared.length === 1
    && noProcess(user), JSON.stringify({ old: ctx.pids.s1, kept, afterA2: shared, user }));
}

/**
 * @brief 7：p1 的会话都归档之后，在 p1 新建会话 C（"Open folder…"）：shared 用新配置起新进程（旧进程还在，B 在用）；
 *        C 调用 proj 拿到 p1 新起的进程（与归档前的不同）。
 */
async function newInP1(ctx) {
  const { page } = ctx;
  await openKnown(ctx, ctx.p1);
  const c = await callTool(ctx, 'C', 'mcp__shared__pid');
  ctx.files.C = await activeFile(page);
  ctx.pids.s2 = pidOf(c.output);
  const v2 = serverProcs(ctx, MARK.v2).map((row) => row.pid);
  record('7 改了之后新建的会话 C（p1，"打开文件夹…"）调用 pid：用新配置起的新进程（命令行带新标记，日志在新文件里、'
    + '只握手一次），旧进程还在（B 在用）', ctx.pids.s2 !== null && ctx.pids.s2 !== ctx.pids.s1
    && JSON.stringify(v2) === `[${ctx.pids.s2}]` && initializes(ctx.logs.v2) === 1
    && alive(ctx, [ctx.pids.s1]).length === 1,
  JSON.stringify({ old: ctx.pids.s1, now: c.output, v2, initialize: initializes(ctx.logs.v2) }));
  const seen = await readProcess(ctx, 'shared', 'user', runningWith(1));
  await shot(page, '7-new-config-C');
  record('7 C 用了新配置之后，工具页（跟随 C）shared 一行是 C 的新进程的状态"运行中 · 1 个会话在用"'
    + '（旧配置的进程还有 B 在用，不算在这一行里）', runningWith(1)(seen), JSON.stringify(seen));
  await backToChat(page);
  const proj = await callTool(ctx, 'C', 'mcp__proj__pid');
  ctx.pids.projC = pidOf(proj.output);
  const procs = sorted(serverProcs(ctx, MARK.proj).map((row) => row.pid));
  const logs = initializes(join(ctx.p1, PROJ_LOG));
  record('7 p1 的会话都归档之后新建的 C 调用 proj 的 pid：起了一个新进程（与归档前 p1 的那个不同），p1 的服务日志里'
    + '一共两次 initialize（旧的、新的各一次）；后台进程下面的 proj 进程是它和 p2 的那个',
  proj.status === 'done' && ctx.pids.projC !== null && ctx.pids.projC !== ctx.pids.projA
    && JSON.stringify(procs) === JSON.stringify(sorted([ctx.pids.projB, ctx.pids.projC])) && logs === 2,
  JSON.stringify({ old: ctx.pids.projA, now: proj.output, procs, initialize: logs }));
}

/**
 * @brief 7：归档 B（最后一个用旧配置的会话，也是 p2 唯一的会话）：旧的 shared 和 p2 的 proj 都退出；
 *        工具页（跟随 C）shared、proj 都是"Running · Used by 1 session"。
 */
async function releaseB(ctx) {
  const { page } = ctx;
  if (!ctx.pids.projB) throw new Error(`missing pids: ${JSON.stringify(ctx.pids)}`);
  await archive(ctx, ctx.files.B);
  const left = await serversGone([ctx.pids.s1, ctx.pids.projB], 10000);
  record('7 归档 B（最后一个用旧配置的会话）之后旧配置的 shared 进程退出（10 秒内）', !left.includes(ctx.pids.s1),
    JSON.stringify({ old: ctx.pids.s1, left }));
  record('7 B 是项目 p2 唯一的会话：归档 B 之后 p2 的 proj 进程退出（10 秒内）', !left.includes(ctx.pids.projB),
    JSON.stringify({ projB: ctx.pids.projB, left }));
  const shared = await readProcess(ctx, 'shared', 'user', runningWith(1));
  const proj = await processOf(page, 'proj', 'project');
  record('7 之后工具页（跟随 C）：shared 一行是新进程的状态"运行中 · 1 个会话在用"（C），p1 的 proj 也是'
    + '"运行中 · 1 个会话在用"', runningWith(1)(shared) && runningWith(1)(proj), JSON.stringify({ shared, proj }));
  await backToChat(page);
}

/** @brief 7 的最后：添加 spare，新会话 D 用它；归档 D 后进程照旧开着；在工具页移除它，进程马上退出。 */
async function removeUnused(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'mcp');
  await saveForm(page, page.getByTestId('tools-page').getByRole('button', { name: 'Add', exact: true }),
    { Name: 'spare', Command: 'node', Arguments: `${MCP_SERVER}\n${MARK.spare}`,
      'Environment variables': 'MORI_MCP_EXTRA=1' });
  await newFromTools(page);
  const d = await callTool(ctx, 'D', 'mcp__spare__pid');
  ctx.files.D = await activeFile(page);
  ctx.pids.spare = pidOf(d.output);
  const procs = serverProcs(ctx, MARK.spare).map((row) => row.pid);
  await archive(ctx, ctx.files.D);
  await sleep(1500);
  const kept = alive(ctx, [ctx.pids.spare]);
  await openRow(page, ctx.files.C);
  const seen = await readProcess(ctx, 'spare', 'user', runningWith(0));
  // 工具页读到"Not in use"时后台进程确实已经放开了 D 的连接：这之后进程还在，才算归档之后照旧开着
  const later = alive(ctx, [ctx.pids.spare]);
  record('7 新添加的 spare：新会话 D 调用它起了一个进程；归档 D（没有会话在用了）之后进程照旧开着（配置还在）',
    ctx.pids.spare !== null && JSON.stringify(procs) === `[${ctx.pids.spare}]` && kept.length === 1
    && later.length === 1, JSON.stringify({ spare: d.output, procs, kept, afterToolsPage: later }));
  record('7 工具页（跟随 C）spare 一行："运行中 · 没有会话在用"', runningWith(0)(seen), JSON.stringify(seen));
  const row = page.locator('[data-testid="mcp-row"][data-server="spare"][data-scope="user"]');
  await row.getByRole('button', { name: 'Remove…', exact: true }).click();
  await page.getByTestId('remove-dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await row.waitFor({ state: 'detached', timeout: 15000 });
  const left = await serversGone([ctx.pids.spare], 5000);
  record('7 在工具页移除没有会话在用的 spare：它的进程马上退出（5 秒内）', left.length === 0,
    JSON.stringify({ spare: ctx.pids.spare, left }));
  await backToChat(page);
}

/** @brief 工具页里用户级 shared 一行的开关。 */
const sharedSwitch = (page) => page.locator('[data-testid="mcp-row"][data-server="shared"][data-scope="user"]')
  .getByRole('switch', { name: 'Enable MCP server shared' });

/**
 * @brief 7（停用）：C 还在用 shared 时在工具页关掉它的开关：mcp.json 写 enabled: false，进程还在，工具页仍是
 *        "Running · Used by 1 session"。读完留在工具页。
 */
async function disableShared(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'mcp');
  await sharedSwitch(page).click();
  const written = await until(() => readJson(join(ctx.agentDir, 'mcp.json'))?.mcpServers?.shared?.enabled === false,
    10000, 200);
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-testid="mcp-row"][data-server="shared"][data-scope="user"]');
    const toggle = row?.querySelector('[role="switch"]');
    return toggle?.getAttribute('aria-checked') === 'false' && !toggle.disabled;
  }, null, { timeout: 10000 }).catch(() => {});
  const checked = await sharedSwitch(page).getAttribute('aria-checked');
  await sleep(1500);
  const living = alive(ctx, [ctx.pids.s2]);
  const seen = await readProcess(ctx, 'shared', 'user', runningWith(1));
  await shot(page, '7-disabled-in-use');
  record('7 C 还在用 shared 时在工具页关掉它的开关：mcp.json 里 shared 写了 enabled: false，开关关上；进程还在，'
    + '工具页这一行仍是"运行中 · 1 个会话在用"', Boolean(written) && checked === 'false' && living.length === 1
    && runningWith(1)(seen), JSON.stringify({ written, checked, s2: ctx.pids.s2, alive: living, seen }));
}

/**
 * @brief 7（停用之后）：从工具页新建的会话 E（p1）不连 shared。新会话挂上开着的连接时不起进程、不再握手（按缓存
 *        回答），只多一条 tools/list，所以看 shared 的新日志里 tools/list 的次数：等 p1 的 proj 收到 E 的 tools/list
 *        （E 已经连好它启用的服务）之后，shared 没有多出来；工具页仍只有 C 在用，E 里它没有注册工具。
 */
async function newAfterDisable(ctx) {
  const { page } = ctx;
  const projLog = join(ctx.p1, PROJ_LOG);
  const before = { shared: toolLists(ctx.logs.v2), proj: toolLists(projLog) };
  await newFromTools(page);
  const connected = await until(() => toolLists(projLog) > before.proj, 15000, 200);
  // pi 在会话启动时一起连它启用的服务：proj 连好之后再留一会儿，shared 要是也连了，它的 tools/list 也来得及到
  await sleep(1500);
  const lists = toolLists(ctx.logs.v2) - before.shared;
  const procs = serverProcs(ctx, MARK.v2).map((row) => row.pid);
  const after = await readProcess(ctx, 'shared', 'user', runningWith(1));
  record('7 停用之后从工具页新建的会话 E（p1）不连 shared：E 连好了 p1 的 proj（它的日志里多了 E 的 tools/list），'
    + 'shared 的新日志里没有多出 tools/list，仍只有原来那个进程、一次 initialize；工具页（跟随 E）shared 一行仍是'
    + '"运行中 · 1 个会话在用"（只有 C），"当前会话里它没有注册工具"', Boolean(connected) && lists === 0
    && JSON.stringify(procs) === `[${ctx.pids.s2}]` && initializes(ctx.logs.v2) === 1 && runningWith(1)(after)
    && after.tools === 'This server has no tools in this session' && after.follow.startsWith('p1 · ')
    && !after.follow.includes('[C]'),
  JSON.stringify({ projToolLists: toolLists(projLog) - before.proj, sharedToolLists: lists, procs,
    initialize: initializes(ctx.logs.v2), after }));
  await backToChat(page);
}

/**
 * @brief 7（停用之后）：归档 C（停用前在用 shared 的会话）之后 shared 的进程退出，之后也不再起（E 开着）；工具页
 *        shared 一行没有进程状态；E 调用 proj 仍是 C 起的那个 p1 的 proj（E 还在用，进程还在）。
 */
async function archiveDisabled(ctx) {
  const { page } = ctx;
  await archive(ctx, ctx.files.C);
  const left = await serversGone([ctx.pids.s2], 10000);
  // 留一会儿，万一又起了 shared 的进程也来得及出现
  await sleep(1500);
  const again = [...serverProcs(ctx, MARK.v2), ...serverProcs(ctx, MARK.shared)].map((row) => row.pid);
  record('7 归档 C（停用前在用 shared 的会话）之后 shared 的进程退出（10 秒内）；之后也没有再起 shared 的进程'
    + '（停用之后新建的 E 开着），新日志里仍只有一次 initialize', left.length === 0 && again.length === 0
    && initializes(ctx.logs.v2) === 1, JSON.stringify({ s2: ctx.pids.s2, left, again,
    initialize: initializes(ctx.logs.v2) }));
  const seen = await readProcess(ctx, 'shared', 'user', (state) => state.row && state.state === null);
  record('7 之后工具页（跟随 E）shared 一行还在（停用、开关关上），没有进程状态（共享服务表里没有它了）',
    seen.row && seen.state === null && seen.text === null, JSON.stringify(seen));
  await backToChat(page);
  const e = await callTool(ctx, 'E', 'mcp__proj__pid');
  ctx.pids.projE = pidOf(e.output);
  record('7 E 调用 proj 的 pid：仍是 C 起的那个 p1 的 proj（C 归档了，E 还在用，进程还在）',
    e.status === 'done' && ctx.pids.projE === ctx.pids.projC && alive(ctx, [ctx.pids.projC]).length === 1,
    JSON.stringify({ projC: ctx.pids.projC, now: e.output }));
}

/** @brief 7：停用有会话在用的 shared，新会话不连它，归档那个会话之后进程退出。 */
async function disableInUse(ctx) {
  await disableShared(ctx);
  await newAfterDisable(ctx);
  await archiveDisabled(ctx);
}

/** @brief 用户级 mcp.json 此刻的修改时间和内容（看两次之间 Mori 有没有写过它）。 */
function configStamp(ctx) {
  const file = join(ctx.agentDir, 'mcp.json');
  return `${statSync(file).mtimeMs}|${readFileSync(file, 'utf8')}`;
}

/**
 * @brief 7 的最后（项目的服务，最后一次写 mcp.json 之后）：在 p2 新建会话 G（"Open folder…"，信任已记住），调用 proj
 *        起 p2 新的进程；归档 G（p2 唯一的会话）之后它退出。前面看到的项目服务退出都在改过 mcp.json 之后，分不出是
 *        "项目最后一个会话关闭"还是"写入之后的过时检查"关掉的；这里从新建 G 到它退出 mcp.json 没变（修改时间、内容），
 *        只能是前者。E 在用的 p1 的 proj 不受影响。
 */
async function projectWithoutWrites(ctx) {
  const { page } = ctx;
  const stamp = configStamp(ctx);
  await openKnown(ctx, ctx.p2);
  const g = await callTool(ctx, 'G', 'mcp__proj__pid');
  ctx.files.G = await activeFile(page);
  ctx.pids.projG = pidOf(g.output);
  const procs = sorted(serverProcs(ctx, MARK.proj).map((row) => row.pid));
  const logs = initializes(join(ctx.p2, PROJ_LOG));
  record('7 最后一次写 mcp.json 之后在 p2 新建的会话 G 调用 proj 的 pid：p2 新起了一个进程（与归档 B 之前的不同），'
    + 'p2 的服务日志里一共两次 initialize；后台进程下面的 proj 进程是它和 E 在用的 p1 的那个',
  g.status === 'done' && ctx.pids.projG !== null && ctx.pids.projG !== ctx.pids.projB && logs === 2
    && JSON.stringify(procs) === JSON.stringify(sorted([ctx.pids.projC, ctx.pids.projG])),
  JSON.stringify({ projB: ctx.pids.projB, now: g.output, procs, initialize: logs }));
  await archive(ctx, ctx.files.G);
  const left = await serversGone([ctx.pids.projG], 10000);
  const unchanged = configStamp(ctx) === stamp;
  const projC = alive(ctx, [ctx.pids.projC]);
  record('7 归档 G（p2 唯一用它的会话）之后 p2 的 proj 进程退出（10 秒内）；从新建 G 到这时用户级 mcp.json 没有被写过'
    + '（修改时间、内容都没变），关掉它的是"项目最后一个会话关闭"；E 在用的 p1 的 proj 还在',
  ctx.pids.projG !== null && left.length === 0 && unchanged && projC.length === 1,
  JSON.stringify({ projG: ctx.pids.projG, left, unchanged, projC }));
}

/**
 * @brief 8. 退出 Mori：退出前还开着的服务进程正好是 E 在用的 p1 的 proj（shared 停用了、spare 移除了、别的会话都
 *        归档了），Mori 按时自己退出，之后它不在了，测试见过的也都不在了，也没有命令行里带本次标记的进程。
 */
async function quit(ctx) {
  // 先按各个标记再读一次后台进程下面的服务进程，没想到的进程也记进见过的
  for (const mark of Object.values(MARK)) serverProcs(ctx, mark);
  const pids = [...ctx.seen];
  const open = sorted(alive(ctx, pids));
  const closed = await closeApp(ctx);
  const left = await serversGone(pids, 15000);
  const marked = processList().filter((row) => row.command.includes(RUN));
  record(`8 退出 Mori（app.close，${CLOSE_TIMEOUT_MS / 1000} 秒内自己退出）：退出前还开着的服务进程`
    + `（${open.join('、')}）正好是 E 在用的 p1 的 proj，之后不在了；测试见过的（${pids.join('、')}）也都不在了，`
    + '也没有命令行里带本次标记的进程', closed && pids.length >= 8 && ctx.pids.projC != null
    && JSON.stringify(open) === `[${ctx.pids.projC}]` && left.length === 0 && marked.length === 0,
  JSON.stringify({ closed, open, expected: [ctx.pids.projC], pids, left,
    marked: marked.map((row) => `${row.pid} ${row.name}`) }));
}

/**
 * @brief 9 的布局：同一个临时根目录下另一个数据目录 data-off。pi 的用户设置 settings.json 里 "extensions": ["-builtin:mcp"]
 *        （停用 pi 的内置 MCP 扩展），用户级 mcp.json 里一个启用的 stdio 服务 off（命令行带 off 标记，日志写进 off.log）。
 */
function makeOffLayout(root) {
  const userData = join(root, 'data-off');
  const agentDir = join(userData, 'pi');
  const log = join(root, 'off.log');
  writeJson(join(agentDir, 'settings.json'), { extensions: ['-builtin:mcp'] });
  writeJson(join(agentDir, 'mcp.json'), { $comment: 'synthetic: written by tests/ui/m6-app-mcp-shared.mjs',
    mcpServers: { off: serverEntry(MARK.off, { MORI_MCP_LOG: log }) } });
  return { userData, agentDir, log };
}

/** @brief 是不是 off 的服务进程（本次运行的合成服务、命令行带 off 标记）。 */
const isOffServer = (row) => isOurServer(row) && row.command.includes(MARK.off);

/**
 * @brief 9：从现在起看 OFF_WAIT_MS（每次读进程列表之后歇 500 毫秒）：这次的后台进程下面、整台机器上出现过的 off 服务进程。
 *        返回看了几次和出现过的进程（PID → 在不在这次的后台进程下面）。
 */
async function watchOff(off) {
  const found = {};
  const deadline = Date.now() + OFF_WAIT_MS;
  let polls = 0;
  while (Date.now() < deadline) {
    const rows = processList();
    const under = new Set(descendantsOf(off.kernel, rows).map((row) => row.pid));
    for (const row of rows.filter(isOffServer)) found[row.pid] = under.has(row.pid) ? 'kernel' : 'elsewhere';
    polls += 1;
    await sleep(500);
  }
  return { polls, found };
}

/**
 * @brief 9 的退出：记下这次 Mori 的进程树（根进程和它的子孙：PID 加命令行，PID 被重用了不算），关掉 Mori，
 *        最多等 10 秒，返回是否按时自己退出、还在的进程树里的进程和整台机器上带本次标记的进程；还在的结束掉。
 */
async function quitOff(off) {
  const rootPid = off.app.process().pid;
  const rows = processList();
  const tree = [...rows.filter((row) => row.pid === rootPid), ...descendantsOf(rootPid, rows)];
  const closed = await closeApp(off);
  let left = [];
  let marked = [];
  for (const deadline = Date.now() + 10000; ;) {
    const now = processList();
    left = now.filter((row) => tree.some((item) => item.pid === row.pid && item.command === row.command));
    marked = now.filter((row) => row.command.includes(RUN));
    if ((left.length === 0 && marked.length === 0) || Date.now() > deadline) break;
    await sleep(500);
  }
  for (const row of [...left, ...marked.filter(isOurServer)]) {
    console.error(`[m6-app-mcp-shared] killing leftover process ${row.pid} ${row.name}`);
    try {
      execFileSync('taskkill', ['/PID', String(row.pid), '/F'], { stdio: 'ignore' });
    } catch (error) {
      console.error(`[m6-app-mcp-shared] cannot kill ${row.pid}: ${error.message}`);
    }
  }
  const brief = (list) => list.map((row) => `${row.pid} ${row.name}`);
  return { closed, tree: tree.length, left: brief(left), marked: brief(marked) };
}

/**
 * @brief 9. 另起一次 Mori（新的 userData，第 8 步已经退出了前一次）：用户设置停用了 pi 的内置 MCP 扩展时，启动不起
 *        用户级 mcp.json 里启用的 stdio 服务。窗口就绪（首次启动的连接表单）之后看约 6 秒：这次的后台进程下面、整台
 *        机器上都没有出现过 off 的进程，它的日志没有写过；后台进程日志说明了不起的原因。第 1 步是对照：没停用时同样的
 *        启动在连接表单出来时已经起了服务。之后退出，这次 Mori 的进程和带本次标记的进程都不在了。
 */
async function builtinOff(ctx) {
  const off = { ...makeOffLayout(ctx.root), pageErrors: ctx.pageErrors, kernelLog: [], app: null };
  try {
    await startApp(off);
    await off.page.getByTestId('connection-form').waitFor({ timeout: 60000 });
    const seen = await watchOff(off);
    await shot(off.page, '9-builtin-off');
    record('9 用户设置里 "extensions": ["-builtin:mcp"]（停用 pi 的内置 MCP 扩展）时另起一次 Mori：窗口就绪（连接表单）'
      + `之后看 ${OFF_WAIT_MS / 1000} 秒，后台进程下面（整台机器上也是）一直没有用户级 mcp.json 里启用的 stdio 服务 off`
      + '的进程，它的日志没有写过', seen.polls >= 3 && Object.keys(seen.found).length === 0 && !existsSync(off.log),
    JSON.stringify({ kernel: off.kernel, ...seen, log: existsSync(off.log) }));
    const reason = off.kernelLog.find((line) => line.includes('builtin:mcp is disabled'));
    record('9 后台进程日志说明了启动时不起 MCP 服务的原因（builtin:mcp is disabled in the user settings）',
      Boolean(reason), reason ?? JSON.stringify(off.kernelLog.slice(0, 5)));
    const done = await quitOff(off);
    record(`9 退出这次的 Mori（${CLOSE_TIMEOUT_MS / 1000} 秒内自己退出）：之后它的进程树（${done.tree} 个进程）都不在了，`
      + '也没有命令行里带本次标记的进程', done.closed && done.tree > 0 && done.left.length === 0
      && done.marked.length === 0, JSON.stringify(done));
  } finally {
    results.kernelLogOff = off.kernelLog;
    // 出错时还没退出：关掉这次的 Mori，结束它要是起了的 off 服务进程（命令行带本次标记，是本测试配置的）
    if (off.app) {
      await closeApp(off);
      for (const row of processList().filter(isOffServer)) {
        console.error(`[m6-app-mcp-shared] killing leftover synthetic MCP server ${row.pid}`);
        try {
          execFileSync('taskkill', ['/PID', String(row.pid), '/F'], { stdio: 'ignore' });
        } catch (error) {
          console.error(`[m6-app-mcp-shared] cannot kill ${row.pid}: ${error.message}`);
        }
      }
    }
  }
}

/**
 * @brief Mori 关了之后还在的合成服务进程（产品没关掉时）：命令行里带本次标记、跑 server.mjs，而且是本测试在后台进程
 *        下面见过的或父进程是本测试的后台进程。结束它们，免得留在机器上、临时文件夹删不掉。
 */
function killLeftovers(ctx) {
  if (!ctx.kernel) return;
  const ours = processList().filter((row) => isOurServer(row) && (ctx.seen.has(row.pid) || row.parent === ctx.kernel));
  for (const row of ours) {
    console.error(`[m6-app-mcp-shared] killing leftover synthetic MCP server ${row.pid}`);
    try {
      execFileSync('taskkill', ['/PID', String(row.pid), '/F'], { stdio: 'ignore' });
    } catch (error) {
      console.error(`[m6-app-mcp-shared] cannot kill ${row.pid}: ${error.message}`);
    }
  }
}

/** @brief 出错之后回到能继续的样子：关掉浮层，离开工具页，退出分屏。 */
async function recover(ctx) {
  const { page } = ctx;
  if (!page || !ctx.app) return;
  await page.keyboard.press('Escape').catch(() => {});
  if (await page.getByTestId('tools-page').isVisible().catch(() => false)) await backToChat(page).catch(() => {});
  const close = page.locator(`${slotSelector('left')} [data-testid="close-pane"]`);
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
}

/** @brief 把服务日志复制到结果文件夹（临时文件夹随后删掉）。 */
function keepLogs(ctx) {
  const files = { 'shared.log': ctx.logs.shared, 'shared-v2.log': ctx.logs.v2, 'proj-p1.log': join(ctx.p1, PROJ_LOG),
    'proj-p2.log': join(ctx.p2, PROJ_LOG) };
  for (const [name, file] of Object.entries(files)) if (existsSync(file)) copyFileSync(file, join(shots, name));
}

const steps = { startup, sharing, runFolderUser, runFolderProject, roots, concurrency, crash, staleConfig,
  removeUnused, disableInUse, projectWithoutWrites, quit, builtinOff };

const fake = await startFakeEndpoint(port, testKey);
const layout = makeLayout();
const ctx = { ...layout, pageErrors: [], kernelLog: [], seen: new Set(), pids: {}, files: {} };
try {
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      if (ctx.page && ctx.app) await shot(ctx.page, `${name}-error`);
      await recover(ctx);
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await closeApp(ctx);
  fake.kill();
}
results.kernelLog = ctx.kernelLog;
results.pids = ctx.pids;
keepLogs(ctx);
await sleep(500);
killLeftovers(ctx);
try {
  rmSync(layout.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
  console.error(`[m6-app-mcp-shared] cannot remove ${layout.root}: ${error.message}`);
}
process.exitCode = write(`m6-app-mcp-shared${suffix}.json`) ? 0 : 1;
