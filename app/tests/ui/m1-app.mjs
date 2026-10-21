// M1 整机测试：真正的 Mori（界面 + 后台进程 + pi）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖首次启动、测试连接与取消、代码块的"Copy code"、停止、排队与插话、三种错误来源、后台进程退出与重新载入、
// 重启后布局还在。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m1-app.mjs                         测开发构建
//   node tests/ui/m1-app.mjs --exe <Mori.exe 路径>   测打包后的程序
// 结果写到 test-results/m1-app.json（文件名带 -packaged 后缀区分），截图在 test-results/m1-app/。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  appRoot, arg, createRecorder, killKernel, launch, mainPid, oneLine, prepareProject, processTree, sleep, sleepProcessIds,
  stillAlive, waitGone,
} from './lib.mjs';
import { smallText } from './m1-layout.mjs';
import { pageHelpers } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const port = 4321;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key';
const shots = join(appRoot, `test-results/m1-app${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
/** 重新载入后对话流里的说明（state/projects.ts RELOADED_NOTE） */
const RESTARTED_NOTE = 'Restarted · Queued messages, pending approvals, and “Allow for this session” choices '
  + 'weren’t restored';

/** @brief 启动合成端点（第一个分块前等 1.2 秒，便于看到"Waiting for the model…"）。 */
function startFakeEndpoint() {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '25', FAKE_FIRST_DELAY_MS: '1200',
      FAKE_REQUIRE_KEY: testKey },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((done) => child.stdout.on('data', (chunk) => String(chunk).includes('synthetic') && done(child)));
}

/** @brief pi 的重试间隔调短，让"自动重试最终失败"在几秒内出现（pi 自己的 settings.json）。 */
function fastRetry(userData) {
  mkdirSync(join(userData, 'pi'), { recursive: true });
  writeFileSync(join(userData, 'pi', 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 200 } }, null, 2));
}

/** @brief 首次启动：只有连接表单；校验、401 原文、测试成功后进入"Open folder…"。 */
async function firstRun({ app, page, h, project }) {
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  record('首次启动：只有连接表单（没有侧栏和会话）', await page.getByTestId('sidebar').count() === 0);
  const small = await smallText(page);
  record('首次启动：没有小于 12px 的文字', small.length === 0, small.slice(0, 3).join('; '));
  await page.getByRole('button', { name: 'Test connection' }).click();
  record('首次启动：没填的字段给出说明（"Name is required."）', (await h.formMessage()).includes('Name is required.'));
  await h.fillConnection({ name: '合成端点', baseUrl, apiKey: 'wrong-key', modelId: 'fake-coder' });
  await page.getByRole('button', { name: 'Test connection' }).click();
  const wrong = await h.formMessage('Name is required.', { test: true });
  record('首次启动：key 错误时显示错误原文', wrong.includes('Connection failed') && wrong.includes('401'),
    oneLine(wrong));
  await h.fillConnection({ apiKey: testKey });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  const ok = await page.getByTestId('test-result').innerText();
  record('首次启动：测试连接成功，显示首字耗时，进入"打开文件夹…"', /Connected · First token \d+ms/.test(ok), oneLine(ok));
  await page.screenshot({ path: join(shots, '01-first-run-ok.png') });
  await h.openFolder(app, project);
  const empty = await page.locator('.empty-chat').innerText();
  record('首次启动：打开文件夹后是新会话的空状态（项目名和输入提示）',
    empty.includes('project') && empty.includes('Enter to send · Shift+Enter for new line'), oneLine(empty));
  // M2 起命令和编辑要先批准；这里测的是 M1 的行为，先切到全部允许。
  await h.allowAll();
}

/** @brief 发第一条消息：先"Waiting for the model…"，再流式文字；读取卡完成；上下文用量随对话增长。 */
async function firstMessage({ page, h }) {
  await h.sampleStages();
  await h.send('总结 README');
  await h.idle();
  const stages = await h.stages();
  record('对话：先显示"等待模型响应"，再"生成中"', stages[0] === 'Waiting for the model…'
    && stages.includes('Responding…'), stages.join(' → '));
  const cards = await h.cards();
  record('对话：读取卡完成', cards[0]?.title.includes('README.md') && cards[0].status === 'done', JSON.stringify(cards));
  record('对话：会话名取第一条消息', (await page.getByTestId('session-title').innerText()) === '总结 README');
  const before = await h.usageTokens();
  await h.send('plain 再说一句');
  await h.idle();
  const after = await h.usageTokens();
  record('对话：顶栏上下文用量随对话增长', before !== null && after !== null && after > before, `${before} → ${after}`);
}

/** @brief 代码块上的"Copy code"：代码进系统剪贴板（Mori 只放行自己页面写剪贴板这一项权限）。 */
async function copyCode({ app, page, h }) {
  await h.send('code block 给我一段代码');
  await h.idle();
  await app.evaluate(({ clipboard }) => clipboard.writeText('剪贴板原来的内容'));
  await page.getByRole('button', { name: 'Copy code' }).last().click();
  let copied = '';
  for (let tries = 0; tries < 10 && !copied.includes('export function add'); tries += 1) {
    await sleep(200);
    copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  }
  record('代码块：点"复制代码"后代码进系统剪贴板', copied.includes('export function add(a: number, b: number): number {')
    && copied.includes('return a + b;') && !copied.includes('下面是一段代码'), oneLine(copied));
}

/**
 * @brief 设置 → 连接与模型：测试中可以取消。M6 起设置页是连接列表，测试在模型行上（settings.md"默认、测试与删除"：
 *        Testing… / Test cancelled，结果写在这一行下面）；所以先在连接卡上"Add model"加一个 fake-slow（合成端点对它第一个
 *        分块前等 8 秒），再用这一行的"Test"和"Cancel"。默认模型仍是 fake-coder（检查），之后的步骤不受影响。
 *        接着在"Add connection"的表单上测 connection.md 的"Test connection → Cancel"（cancelFormTest）。
 */
async function cancelTest({ page, h }) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor();
  const card = page.locator('[data-testid="connection-card"][data-provider="mori-endpoint"]');
  await card.getByRole('button', { name: 'Add model' }).click();
  const form = page.getByTestId('model-form');
  await form.locator('input').first().fill('fake-slow');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const row = page.locator('[data-testid="model-row"][data-model="mori-endpoint/fake-slow"]');
  await row.waitFor({ timeout: 15000 });
  await row.getByRole('button', { name: 'Test', exact: true }).click();
  await row.getByRole('button', { name: 'Testing…' }).waitFor({ timeout: 10000 });
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  const result = row.getByTestId('model-test');
  await result.waitFor({ timeout: 15000 });
  const text = await result.innerText();
  record('设置：模型行的"测试"在测试中变为"测试中…"，可以取消，结果写在这一行下面', text === 'Test cancelled', text);
  // settings.md 添加连接"默认模型"：只有保存时还没有默认模型才让新模型成为默认；这里已有默认，之后的步骤靠它仍是 fake-coder。
  const defaults = await page.locator('[data-testid="model-row"][data-default="true"]')
    .evaluateAll((rows) => rows.map((item) => item.dataset.model));
  record('设置：已有默认模型时"添加模型"不改默认：只有 fake-coder 一行标"默认"，新加的 fake-slow 不标',
    defaults.join() === 'mori-endpoint/fake-coder', defaults.join() || '没有标"默认"的行');
  await cancelFormTest({ page, h });
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/**
 * @brief connection.md（M1）的"测试中 → 取消"在连接表单上：M6 起完整的连接表单在"Add connection"里（settings.md
 *        "添加连接"，与首次启动同一张表单）。测试连接会先保存（新连接排在最后，模型 fake-slow，合成端点对它第一个分块前等
 *        8 秒），测试中按钮变为"Testing…"，旁边"Cancel"；取消后表单下方"Test cancelled"。之后点"Back to list"。
 */
async function cancelFormTest({ page, h }) {
  await page.getByRole('button', { name: 'Add connection' }).click();
  const form = page.getByTestId('connection-form');
  await form.waitFor({ timeout: 10000 });
  await h.fillConnection({ name: '慢的合成端点', baseUrl, apiKey: testKey, modelId: 'fake-slow' });
  await form.getByRole('button', { name: 'Test connection' }).click();
  const testing = await form.getByRole('button', { name: 'Testing…' }).waitFor({ timeout: 10000 })
    .then(() => true, () => false);
  if (testing) await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  const text = await h.formMessage(null, { test: true, timeout: 15000 }).catch(() => '');
  record('设置 → 添加连接：测试连接时按钮变为"测试中…"，可以取消，表单下方"已取消测试"（connection.md）',
    testing && text === 'Test cancelled', `测试中… 出现 ${testing}；${text}`);
  await form.getByRole('button', { name: 'Back to list' }).click();
  await page.getByTestId('connection-form').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 运行耗时命令时排队一条，然后按 Esc：命令卡"Stopped"，提示，排队消息回到输入框。 */
async function escStop({ page, h }) {
  await h.send('run: sleep 30');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 30000 });
  await h.send('plain 排队的消息');
  await page.getByTestId('queue').waitFor({ timeout: 10000 });
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await h.idle(30000);
  const last = (await h.cards()).at(-1);
  const notice = await page.getByText('Stopped · Changes made so far stay as they are').count();
  record('停止：命令卡显示"已停止"并提示修改不会自动撤销', last?.status === 'stopped' && notice >= 1, JSON.stringify(last));
  record('停止：排队消息回到输入框', (await h.textarea.inputValue()).includes('plain 排队的消息'));
  record('停止：没有错误卡', await page.getByTestId('error-card').count() === 0);
  await page.screenshot({ path: join(shots, '02-stopped.png') });
  await h.textarea.fill('');
}

/** @brief 生成中插话和排队：都先进排队区；插话在工具执行完后进入对话流，排队在本轮结束后。 */
async function queueSteer({ page, h }) {
  const usersBefore = await page.getByTestId('user-message').count();
  await h.send('run: sleep 4');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 30000 });
  await h.send('plain 插话', 'Control+Enter');
  await h.send('plain 排队');
  await page.waitForFunction(() => document.querySelector('[data-testid="queue"]')?.textContent?.includes('plain 排队'),
    null, { timeout: 10000 }).catch(() => {});
  const queue = await page.getByTestId('queue').innerText();
  record('排队：插话和排队两条都先出现在排队区', queue.includes('插话') && queue.includes('plain 排队'), oneLine(queue));
  await page.getByTestId('user-message').filter({ hasText: 'plain 插话' }).waitFor({ timeout: 30000 });
  const lastCard = (await h.cards()).at(-1);
  const stillQueued = (await page.getByTestId('queue').innerText().catch(() => '')).includes('plain 排队');
  record('排队：插话在本轮工具执行完后才进入对话流', lastCard?.status === 'done' && stillQueued, JSON.stringify(lastCard));
  await h.idle();
  const users = (await page.getByTestId('user-message').allInnerTexts()).slice(usersBefore);
  record('排队：排队的消息在本轮结束后进入对话流', users.join(' | ') === 'run: sleep 4 | plain 插话 | plain 排队', users.join(' | '));
}

/** @brief 三种错误来源：模型回复出错（http-400）、自动重试最终失败（http-500）、401 → "Go to settings"。 */
async function errors({ page, h }) {
  await h.send('http-400 坏请求');
  await h.idle();
  let card = page.getByTestId('error-card').last();
  let text = await card.innerText();
  record('错误：模型回复出错显示原文和"把上一条消息放回输入框"', text.includes('400')
    && text.includes('Put your last message back in the message box'), oneLine(text));
  await card.getByRole('button', { name: 'Put your last message back in the message box' }).click();
  record('错误：点它把上一条消息放回输入框', (await h.textarea.inputValue()) === 'http-400 坏请求');
  await h.sampleStages();
  await h.send('http-500 服务忙');
  await h.idle(120000);
  const stages = await h.stages();
  card = page.getByTestId('error-card').last();
  text = await card.innerText();
  record('错误：自动重试时阶段行显示"重试 1/3 · 原因"', stages.some((s) => s.startsWith('Retrying (1/3) · ')), stages.join(' → '));
  record('错误：自动重试最终失败显示原文', text.includes('500')
    && text.includes('Put your last message back in the message box'), oneLine(text));
  // M6：设置页先是连接列表，改 key 在连接卡的"Edit connection"里（settings.md"编辑连接"）。
  await h.editConnection();
  await h.fillConnection({ apiKey: 'wrong-key' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await h.formMessage();
  await page.getByRole('button', { name: 'Back to app' }).click();
  await h.send('plain 你好');
  await h.idle();
  card = page.getByTestId('error-card').last();
  text = await card.innerText();
  record('错误：key 错误时显示原文和"去设置"', text.includes('401') && text.includes('Go to settings'), oneLine(text));
  await card.getByRole('button', { name: 'Go to settings' }).click();
  // settings.md 外框："Go to settings"落在出错会话所用模型的连接（mori-endpoint，名称"合成端点"）上，
  // 打开"Edit connection"，焦点在 API key。
  const focus = await h.keyFocus();
  record('错误："去设置"打开出错会话所用连接的"编辑连接 · 合成端点"，焦点在它的 API key 框',
    focus.type === 'password' && focus.inForm && focus.title === 'Edit connection · 合成端点', JSON.stringify(focus));
  await h.fillConnection({ apiKey: testKey });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await h.formMessage();
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/** @brief 结束后台进程：退出提示和"Restart"，执行中的卡"Interrupted"，草稿还在；重新载入后从会话文件恢复。 */
async function kernelExit({ app, page, h }) {
  const before = new Set(sleepProcessIds(['33']));
  await h.send('run: sleep 33');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 30000 });
  const running = sleepProcessIds(['33']).filter((id) => !before.has(id));
  await h.textarea.fill('还没发出的草稿');
  const pid = killKernel(app);
  await page.getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  const left = await waitGone(running);
  record('退出：后台进程被强行结束时，它正在运行的命令也一起结束', running.length > 0 && left.length === 0,
    `运行中的 sleep.exe ${running.length} 个，3 秒内剩 ${left.length} 个`);
  const last = (await h.cards()).at(-1);
  record('退出：显示"Mori 的后台进程意外退出 · 刚才没完成的回复已中断"和"重新载入"',
    (await page.getByTestId('kernel-exit').innerText()).includes('Unfinished responses were interrupted'),
    `后台进程 PID ${pid}`);
  record('退出：执行中的命令卡变为"已中断"', last?.status === 'interrupted', JSON.stringify(last));
  record('退出：输入框里的草稿还在', (await h.textarea.inputValue()) === '还没发出的草稿');
  await page.screenshot({ path: join(shots, '03-kernel-exit.png') });
  const usersBefore = await page.getByTestId('user-message').count();
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText(RESTARTED_NOTE).waitFor({ timeout: 30000 });
  const usersAfter = await page.getByTestId('user-message').count();
  record('退出：重新载入后从会话文件恢复对话，草稿不受影响', usersAfter === usersBefore
    && (await h.textarea.inputValue()) === '还没发出的草稿', `${usersBefore} → ${usersAfter}`);
  await h.send('plain 重新载入之后');
  await h.idle();
  record('退出：重新载入后可以继续对话', (await page.getByTestId('assistant').last().innerText()).length > 0);
}

/** @brief 调整两条分隔线后重启 App，宽度还在。 */
async function layoutRestart({ page, h, app, project, userData }) {
  await page.locator('[data-resize="sidebar"]').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  if (await page.locator('[data-resize="workspace"]').count() === 0) {
    await page.getByRole('button', { name: 'Toggle changes' }).click();
  }
  await page.locator('[data-resize="workspace"]').focus();
  await page.keyboard.press('ArrowLeft');
  const saved = { sidebar: await page.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'),
    workspace: await page.locator('[data-resize="workspace"]').getAttribute('aria-valuenow') };
  await app.close();
  const next = await launch({ exePath, userData });
  const nextPage = await next.firstWindow();
  const helpers = pageHelpers(nextPage);
  await nextPage.getByRole('button', { name: 'Open folder…' }).first().waitFor({ timeout: 60000 });
  await helpers.openFolder(next, project);
  await nextPage.getByRole('button', { name: 'Toggle changes' }).click();
  const after = { sidebar: await nextPage.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'),
    workspace: await nextPage.locator('[data-resize="workspace"]').getAttribute('aria-valuenow') };
  record('布局：重启后两条分隔线的宽度还在', saved.sidebar === after.sidebar && saved.workspace === after.workspace,
    `${JSON.stringify(saved)} → ${JSON.stringify(after)}`);
  return { app: next, page: nextPage, h: helpers };
}

/** @brief Mori 主进程被强行结束（模拟崩溃）时，后台进程和正在运行的命令也都结束，不留下任何 Mori 的进程。 */
async function mainKilled({ project }) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-m1-app-crash-'));
  fastRetry(dir);
  const crashApp = await launch({ exePath, userData: dir });
  const crashPage = await crashApp.firstWindow();
  const helpers = pageHelpers(crashPage);
  await crashPage.getByTestId('connection-form').waitFor({ timeout: 60000 });
  await helpers.fillConnection({ name: '合成端点', baseUrl, apiKey: testKey, modelId: 'fake-coder' });
  await crashPage.getByRole('button', { name: 'Test connection' }).click();
  await crashPage.getByTestId('open-folder').waitFor({ timeout: 60000 });
  await helpers.openFolder(crashApp, project);
  await helpers.allowAll();
  const before = new Set(sleepProcessIds(['63']));
  await helpers.send('run: sleep 63');
  await crashPage.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 30000 });
  const running = sleepProcessIds(['63']).filter((id) => !before.has(id));
  const pid = mainPid(crashApp.process().pid);
  const tree = processTree(pid).filter((item) => item.pid !== pid);
  execFileSync('taskkill', ['/PID', String(pid), '/F']);
  const left = await waitGone(running, 8000);
  await sleep(2000);
  const alive = stillAlive(tree.map((item) => item.pid));
  const names = tree.filter((item) => alive.includes(item.pid)).map((item) => `${item.name}(${item.pid})`);
  record('崩溃：主进程被强行结束时，命令和后台进程都结束，不留下任何 Mori 的进程', running.length > 0 && left.length === 0
    && tree.length > 2 && alive.length === 0,
  `主进程 PID ${pid}，子孙进程 ${tree.length} 个；sleep.exe ${running.length} 个，剩 ${left.length} 个；残留：${names.join(', ') || '无'}`);
  await crashApp.close().catch(() => {});
}

const fake = await startFakeEndpoint();
const { project } = prepareProject('mori-m1-app-');
const userData = mkdtempSync(join(tmpdir(), 'mori-m1-app-data-'));
fastRetry(userData);
let app = await launch({ exePath, userData });
let page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const ctx = { app, page, h: pageHelpers(page), project, userData };
const steps = { firstRun, firstMessage, copyCode, cancelTest, escStop, queueSteer, errors, kernelExit };
try {
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      await page.screenshot({ path: join(shots, `${name}-error.png`) }).catch(() => {});
    }
  }
  Object.assign(ctx, await layoutRestart(ctx));
  app = ctx.app;
  page = ctx.page;
  await app.close().catch(() => {});
  await mainKilled(ctx).catch((error) => record('崩溃：流程', false, oneLine(error, 400)));
} catch (error) {
  record('布局重启：流程', false, oneLine(error, 400));
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await app.close().catch(() => {});
  fake.kill();
}
await sleep(200);
process.exitCode = write(`m1-app${suffix}.json`) ? 0 : 1;
