// M0 冒烟测试：用合成端点（tests/fake-endpoint）驱动真实的 Mori 界面与后台进程。
// M1 起界面换成正式界面，这里只改了找元素的方式，检查的内容与 M0 相同（"未保存时不能测试连接"改为"测试连接会先保存"）。
// 用法：
//   node tests/ui/m0-smoke.mjs                         测开发构建（先 npm run build）
//   node tests/ui/m0-smoke.mjs --exe <Mori.exe 路径>   测打包后的程序
// 结果写到 test-results/m0-smoke.json；任何一项失败时退出码为 1。

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { startNetWatch } from './net-watch.mjs';
import { describeProcesses, sleepProcessIds as testSleeps } from './lib.mjs';
import { pageHelpers } from './page.mjs';

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

/** @brief 在首次启动的表单里用给定的 key 测试连接（会先保存），返回结果文字与是否成功。 */
async function saveAndTest(page, apiKey) {
  const h = pageHelpers(page);
  await h.fillConnection({ name: '合成端点', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, modelId: 'fake-coder' });
  const previous = await page.getByTestId('form-message').innerText().catch(() => null);
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.waitForFunction((old) => document.querySelector('[data-testid="test-result"]')
    || (document.querySelector('[data-testid="form-message"]')?.textContent?.startsWith('连接失败')
      && document.querySelector('[data-testid="form-message"]')?.textContent !== old), previous, { timeout: 40000 });
  const success = page.getByTestId('test-result');
  if (await success.count()) return { ok: true, text: oneLine(await success.innerText()) };
  return { ok: false, text: oneLine(await page.getByTestId('form-message').innerText()) };
}

/** @brief 连接表单：错误的 key 显示错误原文；正确的 key 能连上；key 加密保存；改服务地址必须重填 key。 */
async function connect(app, page, userData, project) {
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '测试连接' }).click();
  const empty = await page.getByTestId('form-message').innerText();
  record('没填连接时不发请求，给出说明（M1：测试连接会先保存）', empty.includes('请填写'), empty);
  const wrong = await saveAndTest(page, 'wrong-key');
  record('错误的 key 显示错误原文', !wrong.ok && wrong.text.includes('401'), wrong.text.slice(0, 160));
  const literal = await saveAndTest(page, testKey);
  record('测试连接', literal.ok, literal.text.slice(0, 160));
  const models = readFileSync(join(userData, 'pi', 'models.json'), 'utf8');
  const credentials = readFileSync(join(userData, 'credentials.json'), 'utf8');
  const provider = JSON.parse(models).providers?.['mori-endpoint'] ?? {};
  record('key 加密保存：models.json 没有 key，credentials.json 只有密文',
    !('apiKey' in provider) && !models.includes(testKey) && !credentials.includes(testKey) &&
      Boolean(JSON.parse(credentials)['mori-endpoint']),
    `models.json 有 apiKey 字段=${'apiKey' in provider}；credentials.json 含明文=${credentials.includes(testKey)}`);
  await pageHelpers(page).openFolder(app, project);
  await page.getByRole('button', { name: '设置' }).click();
  await pageHelpers(page).fillConnection({ baseUrl: `http://localhost:${port}/v1`, apiKey: '' });
  await page.getByRole('button', { name: '保存' }).click();
  const refused = await page.getByText('API key is required').waitFor({ timeout: 10000 }).then(() => true, () => false);
  record('改了服务地址而没有重填 key 时拒绝保存', refused);
  await pageHelpers(page).fillConnection({ baseUrl: `http://127.0.0.1:${port}/v1` });
  await page.getByRole('button', { name: '返回会话' }).click();
}

/** @brief 模型运行的命令读不到 key：key 只在 pi 的内存里，不在环境变量里。 */
async function commandEnvCheck(page) {
  // 对照：Mori 的进程环境里放了一个无害的标记变量，命令能读到它（1），但读不到 key（0）。
  const card = await sendAndWait(page, `run: env | grep -c ${testKey}; env | grep -c ${canary}; true`);
  record('命令的环境里没有 key（对照变量可见）', /完成/.test(card) && /输出\s*0\s+1\s*$/.test(card),
    card.slice(0, 200));
}

/** @brief 通过界面发一条消息，等本轮结束，返回最后一张工具卡展开后的文字（没有时为空串）。 */
async function sendAndWait(page, text) {
  const h = pageHelpers(page);
  const before = await page.getByTestId('tool-card').count();
  await h.send(text);
  await h.idle(60000);
  const card = page.getByTestId('tool-card').last();
  if ((await page.getByTestId('tool-card').count()) === before) return '';
  await card.locator('summary').click();
  await card.locator('.tool-body').waitFor();
  return oneLine(await card.innerText(), 400);
}

/** @brief 在已打开的会话里检查读取、代码高亮、编辑 diff 与 shell。 */
async function chatChecks(app, page, project) {
  const readCard = await sendAndWait(page, '总结 README');
  const transcript = await page.getByTestId('transcript').innerText();
  record('流式文字', transcript.includes('我先读一下 README.md') && transcript.includes('工具已返回'));
  record('读取工具卡完成', /读取.*完成.*Smoke project/.test(readCard), readCard.slice(0, 200));

  await sendAndWait(page, 'code block');
  const tokens = await page.locator('.prose pre span[style*="--sdm-c"]').count();
  record('代码块由 shiki 高亮（离线）', tokens > 3, `带颜色的 token ${tokens} 个`);

  const editCard = await sendAndWait(page, 'edit README');
  const diffText = oneLine(await page.getByTestId('tool-diff').last().evaluate((element) => {
    const pre = element.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
    const colored = pre?.querySelectorAll('span[style*="--diffs-token"]').length ?? 0;
    return `${pre?.textContent ?? ''} [带颜色的 token ${colored} 个]`;
  }).catch(() => ''), 200);
  const edited = readFileSync(join(project, 'README.md'), 'utf8').includes('(edited)');
  record('编辑工具显示 diff', /修改.*完成/.test(editCard) && edited && diffText.includes('edited'),
    `文件已修改=${edited}；diff：${diffText}`);

  const shellCard = await sendAndWait(page, 'run: echo "bash=$BASH_VERSION"; uname -s; command -v bash');
  record('pi 使用 Git Bash', /完成/.test(shellCard) && /bash=\d/.test(shellCard) && /MINGW|MSYS/.test(shellCard),
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

/**
 * @brief 命令运行中关闭窗口：程序应自行退出、不弹错误框，并且不留下任何命令进程——
 *        包括这次的 sleep 127，以及前面 #9129 检查里 pi 留下的孤儿进程（M1 起后台进程放在作业对象里）。
 * @param baseline 启动 Mori 之前就已存在的 sleep.exe
 */
async function closeWhileRunning(app, page, baseline) {
  const before = new Set(sleepProcessIds());
  await pageHelpers(page).send('run: sleep 127');
  await page.getByTestId('tool-card').last().getByText('执行中').waitFor({ timeout: 20000 });
  await sleep(1000);
  const started = sleepProcessIds().filter((pid) => !before.has(pid));
  const fromRun = sleepProcessIds().filter((pid) => !baseline.has(pid));
  const diagBefore = describeProcesses(fromRun);
  const exited = new Promise((r) => app.process().once('exit', () => r(true)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const ok = await Promise.race([exited, sleep(10000).then(() => false)]);
  await sleep(1000);
  const left = sleepProcessIds().filter((pid) => !baseline.has(pid));
  if (left.length) console.log(`DIAG before close:\n  ${diagBefore.join('\n  ')}\nDIAG left:\n  ${describeProcesses(left).join('\n  ')}`);
  record('运行中关闭窗口：程序退出且不留下任何命令进程（含 #9129 留下的）', ok && started.length > 0 && left.length === 0,
    `10 秒内退出=${ok}；这次的 sleep.exe ${started.length} 个，本次运行启动的共 ${fromRun.length} 个，退出后剩 ${left.length} 个`);
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

/** @brief 后台进程意外退出：界面提示、请求立即失败；刷新页面后提示仍在。 */
async function crashCheck(env) {
  const app = await electron.launch(exePath ? { executablePath: exePath, env } : { args: [appRoot], cwd: appRoot, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '测试连接' }).click();
    const test = await pageHelpers(page).formMessage(null, { test: true, timeout: 40000 });
    const placeholder = await page.getByTestId('connection-form').locator('input[type=password]').getAttribute('placeholder');
    record('重启后不用重填 key 也能连接', test.startsWith('连接成功') && /已加密保存/.test(placeholder ?? ''),
      `${oneLine(test, 120)}；key 输入框提示：${placeholder}`);
    const pid = kernelPid(app.process().pid);
    execFileSync('taskkill', ['/PID', String(pid), '/F']);
    await page.getByText('后台进程意外退出').waitFor({ timeout: 10000 });
    const request = () => page.evaluate(() => Promise.race([
      window.mori.request({ type: 'config.get' }).then(() => 'resolved', (error) => `rejected: ${error.message}`),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ]));
    const before = await request();
    await page.reload();
    const banner = await page.getByText('后台进程意外退出').waitFor({ timeout: 10000 }).then(() => true, () => false);
    const after = await request();
    record('后台进程意外退出：提示出现、请求立即失败、刷新后仍提示',
      before.startsWith('rejected') && after.startsWith('rejected') && banner,
      `后台进程 PID ${pid}；退出后请求=${before}；刷新后提示=${banner}，请求=${after}`);
  } finally {
    await app.close().catch(() => {});
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
  closed = await closeWhileRunning(app, page, baseline);
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
