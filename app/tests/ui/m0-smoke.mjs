// M0 冒烟测试：用合成端点（tests/fake-endpoint）驱动真实的 Mori 界面与后台进程。
// M1 起界面换成正式界面，这里只改了找元素的方式，检查的内容与 M0 相同（"未保存时不能测试连接"改为"测试连接会先保存"）。
// v1（docs/specs/model-providers.md §14.4）：对 pi/models.json 的断言改为 model-config.json；改地址按 v1（key 被删、确认框）；
// key 的占位文字改为 Keys 行的"Saved"；校验文字为英文。
// 2026-10-26（WP-13）：多一条 mermaid 图（新依赖，打包后单独载入的代码块），对外连接的检查照旧覆盖它；测打包程序时
// 另查 app.asar 的 node_modules 里没有 mermaid 和它的依赖（mermaid 是 devDependencies，构建时打进 out/renderer）。
// 一键拉取模型（docs/specs/model-discovery.md §13.4）：首次启动先填 Base URL 和 API key、Fetch models，再在清单里勾
// fake-coder（page.mjs）；错的 key 在拉取时就是列表错误 rejected，手填模型 ID 后继续。
// 2026-10-26（负责人走查 M27，docs/v0/screens/window.md）：关掉窗口改为藏进系统托盘，原来"运行中关闭窗口：程序退出"
// 一项改为：关掉窗口不退出、命令照常运行、第一次弹气泡；再启动一次只叫出窗口；点托盘图标回到窗口；托盘菜单"Exit"
// 先问（确认框经 tray-helpers.mjs 换掉，按测试给的按钮回答），选"Quit anyway"后有序退出、不留下命令进程。
// 审查修正（同日）：托盘菜单"Show App"回到窗口；应用菜单是 File（只有"Exit"）、Edit、View、Window，File → Exit 与托盘的
// "Exit"同一个确认框。
// 集成修正（同日）：后台进程意外退出后点托盘"Exit"，Mori 10 秒内退出（原来没有窗口、没有托盘图标却一直不退出）。
// 用法：
//   node tests/ui/m0-smoke.mjs                         测开发构建（先 npm run build）
//   node tests/ui/m0-smoke.mjs --exe <Mori.exe 路径>   测打包后的程序
// 结果写到 test-results/m0-smoke.json；任何一项失败时退出码为 1。

import { spawn, execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, openSync, readFileSync, readSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { startNetWatch } from './net-watch.mjs';
import { describeProcesses, sleepProcessIds as testSleeps } from './lib.mjs';
import { pageHelpers, showStep } from './page.mjs';
import {
  APP_MENU, appMenu, balloonCalls, clickFileExit, clickTrayIcon, clickTrayItem, closeWindow, exitFromTray, findTray,
  launchSecond, messageBoxes, NOTICE_MARKER, NOTICE_TEXT, NOTICE_TITLE, QUIT_DETAIL, recordBalloons, stubMessageBox, TRAY_ITEMS,
  waitWindow, windowState,
} from './tray-helpers.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const exeIndex = process.argv.indexOf('--exe');
const exePath = exeIndex > 0 ? resolve(process.argv[exeIndex + 1]) : null;
const port = 4319;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key';
const canary = 'mori-smoke-canary';
const results = { target: exePath ?? 'dev build', checks: [] };
const oneLine = (text, max = 200) => String(text).replace(/\s+/g, ' ').slice(0, max);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 后台进程意外退出时的横幅（ChatPane.tsx KernelExitBanner） */
const CRASH_BANNER = 'Mori’s background process crashed · Unfinished responses were interrupted';

/** @brief 记录一项检查；known 表示已知的上游问题，失败时标 KNOWN，不计入退出码。 */
function record(name, ok, detail = '', known = false) {
  results.checks.push({ name, ok, detail, known });
  const label = ok ? 'PASS' : known ? 'KNOWN' : 'FAIL';
  console.log(`${label} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** @brief 启动合成端点，等它开始监听。 */
function startFakeEndpoint() {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '15', FAKE_REQUIRE_KEY: testKey },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolveStart) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('synthetic endpoint on')) resolveStart(child);
    });
  });
}

/** @brief 准备一个带 README 的临时项目和独立的数据目录。 */
function prepareDirs() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m0-'));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'README.md'), '# Smoke project\n\nThis folder exists only for the Mori M0 smoke test.\n');
  return { project, userData: join(root, 'user-data') };
}

/**
 * @brief 在首次启动的表单（v1，英文）里用给定的 key 测试连接（会先保存），返回结果文字、是否成功、拉取的结果，以及
 *        点 Test connection 之前清单里 fake-coder 一行的样子（listed：行数、勾着的、标"Entered by you"的）。
 *        一键拉取模型（model-discovery.md §13.4）：换了 key 就再 Fetch models；错的 key 在拉取时就得到列表错误
 *        （rejected），这时 fake-coder 用 Add a model ID 手填（page.mjs pickIn）。
 *        2026-10-26（first-run.md）：测试成功时表单关掉、进入主窗口，结果文字在 Open a folder 提示里（page.mjs testResult）。
 *        since 是点 Test connection 之前的时刻（等这次保存引起的探针用，page.mjs waitProbes）。
 */
async function saveAndTest(page, apiKey) {
  const h = pageHelpers(page);
  const form = page.getByTestId('connection-form');
  const fetch = await h.fillConnection({ name: 'Mori endpoint', baseUrl: `http://127.0.0.1:${port}/v1`, zone: 'local',
    apiKey, modelId: 'fake-coder' });
  const row = form.locator('[data-testid="discovered-row"][data-model="fake-coder"]');
  const listed = { rows: await row.count(), picked: await row.locator('input[name="pick"]:checked').count(),
    typed: await row.locator('[data-testid="row-tag"][data-kind="entered"]').count() };
  const previous = await form.getByTestId('form-message').innerText().catch(() => null);
  const since = Date.now();
  await form.locator('[data-action="test"]').click();
  const text = oneLine(await h.testResult(previous, 60000));
  return { ok: text.startsWith('Connected'), text, fetch, listed, since };
}

/**
 * @brief v1 的模型配置：model-config.json、credentials.json；pi 的 models.json 不再读写（规格 §4.4 第 1 步，
 *        提供商在内存里注册，只带占位 key），存在时（例如 v0 留下的）也一起查。
 */
function readConfigFiles(userData) {
  const text = (name) => (existsSync(join(userData, name)) ? readFileSync(join(userData, name), 'utf8') : '');
  return { config: text('model-config.json'), credentials: text('credentials.json'), pi: text('pi/models.json') };
}

/**
 * @brief 首次启动表单（v1）：没填时不能测试并给出英文说明；错误的 key 显示错误原文；正确的 key 能连上；key 加密保存
 *        （model-config.json 只有 ref，pi 里只有占位 key）；改地址的 origin 时确认框说明 key 会被删，确认后 key 被删
 *        （规格 §4.1、§14.4），之后改回地址、加回 key。
 *        一键拉取模型（model-discovery.md §13.4）：Name 必填的检查在拉取之后（Name 拉取后才出现，勾上 fake-coder，
 *        Test connection 不可用只因为 Name 空着）；错的 key 在 Fetch models 时就得到列表错误 rejected，手填 fake-coder 继续。
 */
async function connect(app, page, userData, project) {
  const h = pageHelpers(page);
  const form = page.getByTestId('connection-form');
  await form.waitFor({ timeout: 60000 });
  await h.fillConnection({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: testKey, modelId: 'fake-coder', name: 'x' });
  await h.fillConnection({ name: '' });
  const nameError = await form.locator('[data-testid="field-error"][data-field="name"]').innerText().catch(() => '');
  const disabled = await form.locator('[data-action="test"]').isDisabled();
  const picked = await form.locator('[data-testid="discovered-row"] input[name="pick"]:checked').count();
  record('没填连接时不能测试连接，字段旁给出英文说明', disabled && /^Name is required\.?$/.test(nameError) && picked === 1,
    `Test connection 不可用=${disabled}；勾选 ${picked} 行；${nameError}`);
  const wrong = await saveAndTest(page, 'wrong-key');
  record('错误的 key 显示错误原文：Fetch models 时列表错误为 rejected，手填模型后测试连接给出 401 原文',
    !wrong.ok && /^(Connection failed|Failed)/.test(wrong.text) && wrong.text.includes('401')
      && wrong.fetch?.state === 'list-error' && wrong.fetch.kind === 'rejected',
    `${JSON.stringify(wrong.fetch)}；${wrong.text.slice(0, 160)}`);
  const literal = await saveAndTest(page, testKey);
  // model-discovery.md §13.4：换回对的 key 后 Fetch models 拿到列表，fake-coder 是在清单里勾的（不是手填的）
  const { listed } = literal;
  const handedOver = await form.count() === 0 && await page.getByTestId('sidebar').count() === 1;
  record('测试连接（换回对的 key 后 Fetch models 拿到列表，在清单里勾 fake-coder）；成功后首次启动表单关掉，进入主窗口，'
    + '"Connected · …"在 Open a folder 提示里',
  literal.ok && literal.fetch?.state === 'list' && listed.rows === 1 && listed.picked === 1 && listed.typed === 0
    && handedOver, `${JSON.stringify(literal.fetch)}；${JSON.stringify(listed)}；主窗口 ${handedOver}；`
    + `${literal.text.slice(0, 160)}`);
  const files = readConfigFiles(userData);
  const provider = JSON.parse(files.config).providers?.[0] ?? {};
  const ref = provider.keys?.[0]?.ref;
  record('key 加密保存：model-config.json 只有 key 的 ref，没有 pi/models.json 的明文，credentials.json 只有密文',
    !files.config.includes(testKey) && !files.pi.includes(testKey) && !files.credentials.includes(testKey)
      && provider.keys?.length === 1 && Boolean(ref) && Boolean(JSON.parse(files.credentials)[ref]),
    `keys=${JSON.stringify(provider.keys)}；含明文：config=${files.config.includes(testKey)}`
      + ` pi=${files.pi.includes(testKey)} credentials=${files.credentials.includes(testKey)}`);
  // 错的 key 那次保存已存下 error 档案；这次保存会重新探测，等完成时刻不早于点 Test connection 的新档案
  const probe = await h.waitProbes(literal.since);
  record('首次启动：测试成功后等这次保存引起的探针跑完（经进程桥读 models.get 的档案），tool calling 已验证',
    probe === 'verified', `probe=${probe}`);
  await h.openFolder(app, project);
  // M2 起命令要先批准；冒烟测的是批准之外的行为，先切到全部允许。
  await h.allowAll();
  await addressChange(page, userData);
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/**
 * @brief v1 的改地址（规格 §4.1、§9.1）：Edit 提供商把地址改到另一个 origin，Save 时确认框说明这个提供商的 key 会被删，
 *        确认后 model-config.json 的地址改了、keys 为空；再改回原地址（没有 key，不再确认）、Add key 加回 key，
 *        等档案回到已验证（之后的对话要用它）。
 */
async function addressChange(page, userData) {
  const h = pageHelpers(page);
  await h.openModels();
  const card = h.providerCard();
  await card.locator('[data-action="edit-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(`http://localhost:${port}/v1`);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.locator('[data-testid="confirm-dialog"][data-kind="address-change"]');
  const text = oneLine(await dialog.innerText({ timeout: 10000 }).catch(() => ''));
  await dialog.getByRole('button', { name: 'Save and remove keys' }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const changed = JSON.parse(readFileSync(join(userData, 'model-config.json'), 'utf8')).providers[0];
  record('改了服务地址的 origin：确认框说明 key 会被删，确认后地址改了、key 被删',
    /Changing the base URL removes this provider’s saved key\./.test(text)
      && changed.baseUrl === `http://localhost:${port}/v1` && changed.keys.length === 0
      && await card.getByTestId('no-keys').count() === 1,
    `确认框：${text}；model-config.json：${changed.baseUrl}，keys=${changed.keys.length}`);
  await card.locator('[data-action="edit-provider"]').click();
  await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  await h.addKey(testKey);
  await verifiedAgain(page);
}

/** @brief 等 mori-endpoint/fake-coder 的档案回到已验证（探针出错时点 Verify 再等）。 */
async function verifiedAgain(page) {
  const row = page.locator('[data-testid="model-row"][data-model="mori-endpoint/fake-coder"]');
  const state = () => row.locator('[data-testid="profile"] [data-field="tool_calling"]').getAttribute('data-value');
  const settle = () => page.waitForFunction(() => {
    const value = document.querySelector('[data-testid="model-row"][data-model="mori-endpoint/fake-coder"] '
      + '[data-field="tool_calling"]')?.dataset.value;
    return value === 'verified' || value === 'failed' || value === 'unverified';
  }, null, { timeout: 120000 });
  await settle();
  if (await state() !== 'verified') {
    await row.locator('[data-action="verify"]').click();
    await sleep(500);
    await settle();
  }
  record('改回地址、加回 key 后档案为已验证', await state() === 'verified', `tool_calling=${await state()}`);
}

/** @brief 模型运行的命令读不到 key：key 只在 pi 的内存里，不在环境变量里。 */
async function commandEnvCheck(page) {
  // 对照：Mori 的进程环境里放了一个无害的标记变量，命令能读到它（1），但读不到 key（0）。
  const card = await sendAndWait(page, `run: env | grep -c ${testKey}; env | grep -c ${canary}; true`);
  record('命令的环境里没有 key（对照变量可见）', /Done/.test(card) && /Output\s*0\s+1\s*$/.test(card),
    card.slice(0, 200));
}

/**
 * @brief 通过界面发一条消息，等本轮结束，返回最后一张工具卡展开后的文字（没有时为空串）。一轮结束后卡折在步骤组里
 *        （chat.md"步骤组"），先展开那一组。
 */
async function sendAndWait(page, text) {
  const h = pageHelpers(page);
  const before = await page.getByTestId('tool-card').count();
  await h.send(text);
  await h.idle(60000);
  const card = page.getByTestId('tool-card').last();
  if ((await page.getByTestId('tool-card').count()) === before) return '';
  await showStep(card);
  await card.locator('summary').click();
  await card.locator('.tool-body').waitFor();
  return oneLine(await card.innerText(), 400);
}

/** @brief 在已打开的会话里检查读取、代码高亮、编辑 diff 与 shell。 */
async function chatChecks(app, page, project) {
  const readCard = await sendAndWait(page, '总结 README');
  const transcript = await page.getByTestId('transcript').innerText();
  record('流式文字', transcript.includes('我先读一下 README.md') && transcript.includes('工具已返回'));
  record('读取工具卡完成', /Read.*Done.*Smoke project/.test(readCard), readCard.slice(0, 200));

  await sendAndWait(page, 'code block');
  const tokens = await page.locator('.prose pre span[style*="--sdm-c"]').count();
  record('代码块由 shiki 高亮（离线）', tokens > 3, `带颜色的 token ${tokens} 个`);

  // 2026-10-26 走查 M16：mermaid 第一次遇到图时才载入（单独的代码块，打包程序里从 app.asar 读），不联网（下面 netCheck）。
  await sendAndWait(page, 'mermaid diagram');
  const drawn = await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="mermaid-diagram"]')]
    .some((host) => host.shadowRoot?.querySelector('svg')), null, { timeout: 20000 }).then(() => true, () => false);
  record('mermaid 图画出来了（单独载入的代码块，离线）', drawn);

  const editCard = await sendAndWait(page, 'edit README');
  const diffText = oneLine(await page.getByTestId('tool-diff').last().evaluate((element) => {
    const pre = element.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
    const colored = pre?.querySelectorAll('span[style*="--diffs-token"]').length ?? 0;
    return `${pre?.textContent ?? ''} [带颜色的 token ${colored} 个]`;
  }).catch(() => ''), 200);
  const edited = readFileSync(join(project, 'README.md'), 'utf8').includes('(edited)');
  record('编辑工具显示 diff', /Edit.*Done/.test(editCard) && edited && diffText.includes('edited'),
    `文件已修改=${edited}；diff：${diffText}`);

  const shellCard = await sendAndWait(page, 'run: echo "bash=$BASH_VERSION"; uname -s; command -v bash');
  record('pi 使用 Git Bash', /Done/.test(shellCard) && /bash=\d/.test(shellCard) && /MINGW|MSYS/.test(shellCard),
    shellCard.slice(0, 300));
}

/** 这个脚本里的命令用的秒数：37 是 #9129 检查，127 是关窗检查 */
const SLEEPS = ['37', '127'];

/** @brief 这个脚本启动的 sleep.exe 的 PID。 */
function sleepProcessIds() {
  return testSleeps(SLEEPS);
}

/** @brief pi #9129：命令超时后是否留下进程。 */
async function timeoutCheck(page) {
  const before = new Set(sleepProcessIds());
  const card = await sendAndWait(page, 'run: sleep 37 | cat timeout=2');
  await sleep(3000);
  const orphans = sleepProcessIds().filter((pid) => !before.has(pid));
  record('命令超时后没有遗留 sleep 进程（pi #9129）', orphans.length === 0,
    `超时 3 秒后仍在运行的新 sleep.exe：${orphans.length} 个；卡片：${card.slice(0, 160)}`, true);
}

/** @brief 在同一个后台进程里同时跑两个 pi 会话。 */
async function concurrencyCheck(page, project) {
  const outcome = await page.evaluate(async (cwd) => {
    const events = [];
    const off = window.mori.onEvent((e) => events.push({ s: e.sessionId, t: e.event.type }));
    const a = await window.mori.request({ type: 'session.create', cwd });
    const b = await window.mori.request({ type: 'session.create', cwd });
    await Promise.all([a, b].map((s) => window.mori.request({ type: 'session.prompt', sessionId: s.sessionId,
      text: '总结 README' })));
    const settled = (s) => events.some((e) => e.s === s.sessionId && e.t === 'agent_settled');
    const deadline = Date.now() + 60000;
    while (!(settled(a) && settled(b)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    off();
    const order = events.filter((e) => e.t === 'message_update').map((e) => (e.s === a.sessionId ? 'A' : 'B'));
    const switches = order.filter((c, i) => i > 0 && c !== order[i - 1]).length;
    const tools = (s) => events.filter((e) => e.s === s.sessionId && e.t === 'tool_execution_end').length;
    return { both: settled(a) && settled(b), switches, toolsA: tools(a), toolsB: tools(b) };
  }, project);
  record('同一后台进程并发两个会话', outcome.both && outcome.switches > 2 && outcome.toolsA > 0 && outcome.toolsB > 0,
    `两边都结束=${outcome.both}，增量交替次数=${outcome.switches}，工具调用 A=${outcome.toolsA} B=${outcome.toolsB}`);
}

/** @brief 窗口回到桌面上（显示着、没有最小化）。 */
const onScreen = (state) => state.visible && !state.minimized;
/** @brief 窗口藏进托盘（不显示、也不是最小化）。 */
const offScreen = (state) => !state.visible && !state.minimized;

/**
 * @brief 等确认框弹出（记下的个数到 count，最多 5 秒），再等 500 毫秒看 Mori 有没有开始退出；返回记下的确认框。
 *        不固定等 2 秒，快速集要在 2 分钟内跑完（AGENTS.md"测试分层"）。
 */
async function waitBoxes(app, count) {
  const deadline = Date.now() + 5000;
  let boxes = await messageBoxes(app);
  while (boxes.length < count && Date.now() < deadline) {
    await sleep(100);
    boxes = await messageBoxes(app);
  }
  await sleep(500);
  return boxes;
}

/**
 * @brief 命令运行中关掉窗口（2026-10-26 改，docs/v0/screens/window.md）：窗口藏进托盘，程序不退出，命令照常运行；
 *        第一次关窗口弹气泡"Mori runs in the system tray"、写下标记文件。返回这次的 sleep 127 进程。
 */
async function closeToTray(app, page, userData) {
  const before = new Set(sleepProcessIds());
  await pageHelpers(page).send('run: sleep 127');
  await page.getByTestId('tool-card').last().getByText('Running…').waitFor({ timeout: 20000 });
  await sleep(1000);
  const started = sleepProcessIds().filter((pid) => !before.has(pid));
  await recordBalloons(app);
  let exited = false;
  app.process().once('exit', () => { exited = true; });
  await closeWindow(app);
  await sleep(1500);
  const state = await windowState(app);
  const running = sleepProcessIds();
  const alive = started.filter((pid) => running.includes(pid));
  record('运行中关掉窗口：窗口藏进托盘，程序不退出，命令照常运行', !exited && state && !state.visible && !state.minimized
    && started.length > 0 && alive.length === started.length,
    `退出=${exited}；窗口=${JSON.stringify(state)}；这次的 sleep.exe ${started.length} 个，还在运行 ${alive.length} 个`);
  const balloons = await balloonCalls(app);
  const marker = existsSync(join(userData, NOTICE_MARKER));
  const first = balloons[0];
  record('第一次关掉窗口：托盘气泡"Mori runs in the system tray"和说明（info 图标），写下标记文件',
    balloons.length === 1 && first.title === NOTICE_TITLE && first.content === NOTICE_TEXT && first.iconType === 'info'
    && marker, `气泡 ${JSON.stringify(balloons)}；标记文件=${marker}`);
  return started;
}

/**
 * @brief 窗口藏着时：再启动一次 Mori，第二个进程马上退出（退出码 0），已在运行的 Mori 把窗口叫出来；再关窗口不再弹气泡；
 *        点托盘图标回到窗口。
 */
async function reopenFromTray(app, userData) {
  const code = await launchSecond({ exePath, userData });
  const shown = await waitWindow(app, onScreen, 5000);
  record('再启动一次 Mori：第二个进程马上退出（退出码 0），已在运行的 Mori 把窗口叫出来', code === 0 && shown.ok,
    `第二个进程的退出码=${code}；窗口=${JSON.stringify(shown.state)}`);
  await closeWindow(app);
  const hidden = (await waitWindow(app, offScreen, 5000)).state;
  const balloons = await balloonCalls(app);
  const tray = await findTray(app);
  await clickTrayIcon(app);
  const back = await waitWindow(app, onScreen, 5000);
  record('再关窗口不再弹气泡；左键点托盘图标回到窗口', !hidden?.visible && balloons.length === 1 && tray.tray && back.ok,
    `关后窗口=${JSON.stringify(hidden)}；气泡 ${balloons.length} 次；托盘=${JSON.stringify(tray)}；`
    + `点后窗口=${JSON.stringify(back.state)}`);
}

/** @brief 托盘菜单"Show App"：关掉窗口后点它，藏起的窗口回到桌面上。 */
async function showFromMenu(app) {
  await closeWindow(app);
  const hidden = await waitWindow(app, offScreen, 5000);
  await clickTrayItem(app, 'Show App');
  const back = await waitWindow(app, onScreen, 5000);
  record('托盘菜单"Show App"：藏起的窗口回到桌面上', hidden.ok && back.ok,
    `关后窗口=${JSON.stringify(hidden.state)}；点后窗口=${JSON.stringify(back.state)}`);
}

/**
 * @brief 应用菜单是 File、Edit、View、Window，File 里只有"Exit"；命令运行中点 File → Exit 同托盘的"Exit"先问（同样的
 *        确认框），选"Cancel"不退出。在 exitCancelled 之后调用（确认框已换成按"Cancel"回答，第一个是托盘"Exit"的）。
 */
async function fileExitCancelled(app) {
  const menu = await appMenu(app);
  record('应用菜单：File（只有"Exit"）、Edit、View、Window', JSON.stringify(menu) === JSON.stringify(APP_MENU),
    JSON.stringify(menu));
  await clickFileExit(app);
  const boxes = await waitBoxes(app, 2);
  record('命令运行中点 File → Exit：同托盘"Exit"的确认框；选"Cancel"不退出',
    boxes.length === 2 && JSON.stringify(boxes[1].options) === JSON.stringify(boxes[0].options)
    && app.process().exitCode === null, oneLine(JSON.stringify(boxes.slice(1)), 400));
}

/**
 * @brief 托盘菜单只有"Show App"、分隔线、"Exit"；命令运行中点"Exit"先问（"Mori is still working"），选"Cancel"什么都不变。
 * @param started 这次的 sleep 127 进程
 */
async function exitCancelled(app, started) {
  const tray = await findTray(app);
  record('托盘菜单："Show App"、分隔线、"Exit"', JSON.stringify(tray.items) === JSON.stringify(TRAY_ITEMS),
    JSON.stringify(tray));
  await stubMessageBox(app, 1);
  await clickTrayItem(app, 'Exit');
  const boxes = await waitBoxes(app, 1);
  const box = boxes[0]?.options;
  const count = QUIT_DETAIL.exec(box?.detail ?? '');
  record('命令运行中点托盘"Exit"：确认框"Mori is still working"，说明会话数，按钮"Quit anyway""Cancel"，'
    + '默认与 Esc 都是"Cancel"',
    boxes.length === 1 && box.type === 'warning' && box.message === 'Mori is still working' && Number(count?.[1]) >= 1
    && JSON.stringify(box.buttons) === '["Quit anyway","Cancel"]' && box.defaultId === 1 && box.cancelId === 1,
    oneLine(JSON.stringify(boxes), 400));
  const running = sleepProcessIds();
  const alive = started.filter((pid) => running.includes(pid));
  const state = await windowState(app);
  record('确认框选"Cancel"：Mori 不退出，命令照常运行', app.process().exitCode === null && Boolean(state)
    && alive.length === started.length, `这次的 sleep.exe ${started.length} 个，还在运行 ${alive.length} 个`);
}

/**
 * @brief 确认框选"Quit anyway"：程序 10 秒内退出、不弹错误框，并且不留下任何命令进程——包括这次的 sleep 127，
 *        以及前面 #9129 检查里 pi 留下的孤儿进程（M1 起后台进程放在作业对象里；有序关闭从关窗口挪到了真正退出）。
 * @param baseline 启动 Mori 之前就已存在的 sleep.exe
 */
async function exitAnyway(app, baseline) {
  const fromRun = sleepProcessIds().filter((pid) => !baseline.has(pid));
  const diagBefore = describeProcesses(fromRun);
  await stubMessageBox(app, 0);
  const exited = new Promise((r) => app.process().once('exit', () => r(true)));
  await clickTrayItem(app, 'Exit').catch(() => {});
  const ok = await Promise.race([exited, sleep(10000).then(() => false)]);
  await sleep(1000);
  const left = sleepProcessIds().filter((pid) => !baseline.has(pid));
  if (left.length) {
    const lines = (list) => list.map((line) => `\n  ${line}`).join('');
    console.log(`DIAG before exit:${lines(diagBefore)}\nDIAG left:${lines(describeProcesses(left))}`);
  }
  record('确认框选"Quit anyway"：程序 10 秒内退出且不留下任何命令进程（含 #9129 留下的）', ok && left.length === 0,
    `10 秒内退出=${ok}；本次运行启动的 sleep.exe 共 ${fromRun.length} 个，退出后剩 ${left.length} 个`);
  return ok;
}

/** @brief 找到后台进程（utilityProcess）的 PID。Playwright 在 Windows 上经 cmd.exe 启动程序，所以要在整棵进程树里找。 */
function kernelPid(rootPid) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }';
  const rows = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).filter(Boolean).map((line) => line.split('|'));
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of rows) {
      if (tree.has(Number(parent)) && !tree.has(Number(pid))) { tree.add(Number(pid)); grew = true; }
    }
  }
  const kernel = rows.find(([pid, , command]) => tree.has(Number(pid)) && command?.includes('node.mojom.NodeService'));
  if (!kernel) throw new Error('kernel process not found');
  return Number(kernel[0]);
}

/**
 * @brief 后台进程意外退出：界面提示、请求立即失败；刷新页面后提示仍在。之后点托盘"Exit"：没有会话在生成（数是 0），
 *        不问，Mori 10 秒内退出（docs/v0/screens/window.md"窗口藏着时后台进程意外退出"的 Exit）。
 */
async function crashCheck(env) {
  const app = await electron.launch(exePath ? { executablePath: exePath, env } : { args: [appRoot], cwd: appRoot, env });
  let exited = false;
  try {
    const page = await app.firstWindow();
    // v1：设置 → Models 的提供商卡上"Test connection"用第一个可用的 key 测第一个模型；Keys 行显示"Saved"，不回填明文。
    const h = pageHelpers(page);
    await h.openModels();
    const card = h.providerCard();
    await card.locator('[data-action="test-provider"]').click();
    const result = card.getByTestId('test-result');
    await result.waitFor({ timeout: 60000 });
    const test = await result.innerText();
    const saved = await card.getByTestId('key-row').allInnerTexts();
    record('重启后不用重填 key 也能连接', test.startsWith('Connected') && saved.length === 1 && saved[0].includes('Saved'),
      `${oneLine(test, 120)}；Keys 行：${oneLine(saved.join(' | '), 120)}`);
    const pid = kernelPid(app.process().pid);
    execFileSync('taskkill', ['/PID', String(pid), '/F']);
    await page.getByText(CRASH_BANNER).waitFor({ timeout: 10000 });
    const request = () => page.evaluate(() => Promise.race([
      window.mori.request({ type: 'config.get' }).then(() => 'resolved', (error) => `rejected: ${error.message}`),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ]));
    const before = await request();
    await page.reload();
    const banner = await page.getByText(CRASH_BANNER).waitFor({ timeout: 10000 }).then(() => true, () => false);
    const after = await request();
    record('后台进程意外退出：提示出现、请求立即失败、刷新后仍提示',
      before.startsWith('rejected') && after.startsWith('rejected') && banner,
      `后台进程 PID ${pid}；退出后请求=${before}；刷新后提示=${banner}，请求=${after}`);
    await stubMessageBox(app, 1);
    exited = await exitFromTray(app, 10000);
    const boxes = exited ? [] : await messageBoxes(app).catch((error) => `cannot read: ${oneLine(error)}`);
    record('后台进程意外退出后点托盘"Exit"：不问，Mori 10 秒内退出', exited, JSON.stringify({ exited, boxes }));
  } finally {
    // 没退出时强行结束：Playwright 的 close 也走 app.quit()，退不出时会一直等下去
    if (!exited) app.process().kill();
  }
}

/** 只在渲染进程里用、构建时由 Vite 打进 out/renderer 的 mermaid 和它的依赖（devDependencies），不该出现在 app.asar 里 */
const BUNDLED_ONLY = ['mermaid', '@mermaid-js/parser', 'cytoscape', 'katex'];

/** @brief app.asar 的文件头（asar 格式：前 8 字节是头的长度，之后的 pickle 里第 4–8 字节是 JSON 的长度，再接 JSON）。 */
function asarHeader(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    return JSON.parse(json.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/**
 * @brief 打包程序（--exe）的 app.asar：node_modules 下的顶层包里没有 mermaid 和它的依赖（2026-10-26 WP-13 审查：
 *        electron-builder 会把每个生产依赖的 node_modules 打进 app.asar，mermaid 因此放在 devDependencies）；
 *        结果里写 app.asar 的大小。
 */
function asarCheck(exe) {
  const name = 'app.asar 的 node_modules 里没有 mermaid 和它的依赖（构建时已打进 out/renderer）';
  try {
    const file = join(dirname(exe), 'resources', 'app.asar');
    const modules = asarHeader(file).files.node_modules?.files ?? {};
    const names = Object.entries(modules).flatMap(([top, entry]) => (top.startsWith('@')
      ? Object.keys(entry.files ?? {}).map((child) => `${top}/${child}`) : [top]));
    const found = BUNDLED_ONLY.filter((item) => names.includes(item));
    record(name, names.length > 0 && found.length === 0,
      `app.asar ${statSync(file).size} 字节；node_modules 顶层包 ${names.length} 个；多出的：${found.join(', ') || '无'}`);
  } catch (error) {
    record(name, false, oneLine(error, 300));
  }
}

/** @brief 网络采样的结论：有采样、看到了到合成端点的回环连接、没有对外连接。 */
function netCheck(seen) {
  const reachedFake = [...seen.loop].some((value) => value.endsWith(`:${port}`));
  record('对外连接只有配置的端点（近似检查，每 0.3 秒采样）',
    seen.samples >= 20 && reachedFake && seen.ext.size === 0 && seen.errors.length === 0,
    `采样 ${seen.samples} 次；到合成端点的连接=${reachedFake}；对外连接：${[...seen.ext].join(', ') || '无'}` +
    (seen.errors.length ? `；采样错误：${oneLine(seen.errors[0], 120)}` : ''));
}

if (exePath) asarCheck(exePath);
const baseline = new Set(sleepProcessIds());
const fake = await startFakeEndpoint();
const { project, userData } = prepareDirs();
const env = { ...process.env, MORI_USER_DATA: userData, MORI_SMOKE_CANARY: canary };
const app = await electron.launch(exePath ? { executablePath: exePath, env } : { args: [appRoot], cwd: appRoot, env });
const net = startNetWatch(app.process().pid);
const log = [];
app.process().stdout?.on('data', (chunk) => log.push(String(chunk)));
app.process().stderr?.on('data', (chunk) => log.push(String(chunk)));
let closed = false;
try {
  const page = await app.firstWindow();
  while (net.seen.samples === 0) await sleep(200);
  await connect(app, page, userData, project);
  await chatChecks(app, page, project);
  await commandEnvCheck(page);
  await timeoutCheck(page);
  await concurrencyCheck(page, project);
  netCheck(net.seen);
  const started = await closeToTray(app, page, userData);
  await reopenFromTray(app, userData);
  await showFromMenu(app);
  await exitCancelled(app, started);
  await fileExitCancelled(app);
  closed = await exitAnyway(app, baseline);
} catch (error) {
  record('冒烟流程', false, oneLine(error, 300));
} finally {
  net.stop();
  results.log = log.join('').slice(-4000);
  if (!closed) await app.close().catch(() => {});
}
try {
  await crashCheck(env);
} catch (error) {
  record('后台进程意外退出', false, oneLine(error, 300));
} finally {
  fake.kill();
}
mkdirSync(join(appRoot, 'test-results'), { recursive: true });
writeFileSync(join(appRoot, 'test-results/m0-smoke.json'), `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.checks.every((c) => c.ok || c.known) ? 0 : 1;
