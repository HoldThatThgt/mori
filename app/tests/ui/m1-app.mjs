// M1 整机测试：真正的 Mori（界面 + 后台进程 + pi）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖首次启动、测试连接与取消、代码块的"复制代码"、停止、排队与插话、三种错误来源、后台进程退出与重新载入、
// 重启后布局还在。v1（docs/specs/model-providers.md §14.4）：首次启动是英文表单；重试改为 http-503-once 与
// "Retrying 1/3"；key 被拒改为删 key、加错的 key → 说明卡 → Open settings（焦点在 Keys）→ 加回对的 key。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m1-app.mjs                         测开发构建
//   node tests/ui/m1-app.mjs --exe <Mori.exe 路径>   测打包后的程序
// 结果写到 test-results/m1-app.json（文件名带 -packaged 后缀区分），截图在 test-results/m1-app/。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/** @brief 启动合成端点（第一个分块前等 1.2 秒，便于看到"等待模型响应"）。 */
function startFakeEndpoint() {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '25', FAKE_FIRST_DELAY_MS: '1200',
      FAKE_REQUIRE_KEY: testKey },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((done) => child.stdout.on('data', (chunk) => String(chunk).includes('synthetic') && done(child)));
}

/**
 * @brief pi 的重试间隔调短（pi 自己的 settings.json）。v1 里 pi 的自动重试对 Mori 的会话关闭（规格 §5.5），重试由
 *        模型池按 §12 的真实间隔做；这份设置留着，保证 pi 读到的是一个合法的 settings.json。
 */
function fastRetry(userData) {
  mkdirSync(join(userData, 'pi'), { recursive: true });
  writeFileSync(join(userData, 'pi', 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 200 } }, null, 2));
}

/**
 * @brief 首次启动（v1，英文表单，docs/v1/screens/first-run.md）：只有首次启动表单；字段错误是英文；测试中可以取消
 *        （"Testing…"、"Cancel" → "Test cancelled"）；401 原文；测试成功后等探针跑完，再"Open folder…"。
 *        测试取消用 fake-slow（合成端点对它第一个分块前等 8 秒），之后同一张表单改回 fake-coder 再测（整体替换，
 *        配置里仍只有一个提供商）。
 */
async function firstRun({ app, page, h, project, userData }) {
  const form = page.getByTestId('connection-form');
  await form.waitFor({ timeout: 60000 });
  record('首次启动：只有连接表单（没有侧栏和会话）', await page.getByTestId('sidebar').count() === 0);
  const small = await smallText(page);
  record('首次启动：没有小于 12px 的文字', small.length === 0, small.slice(0, 3).join('; '));
  await h.fillConnection({ name: 'x' });
  await h.fillConnection({ name: '' });
  const nameError = await form.locator('[data-testid="field-error"][data-field="name"]').innerText().catch(() => '');
  record('首次启动：没填的字段给出英文说明，Test connection 不可用', nameError === 'Name is required'
    && await form.locator('[data-action="test"]').isDisabled(), nameError);
  await cancelFormTest({ page, h });
  await h.fillConnection({ apiKey: 'wrong-key', modelId: 'fake-coder' });
  await form.locator('[data-action="test"]').click();
  const wrong = await h.formMessage('Test cancelled', { test: true });
  record('首次启动：key 错误时显示错误原文', wrong.startsWith('Failed') && wrong.includes('401'), oneLine(wrong));
  await h.fillConnection({ apiKey: testKey });
  await form.locator('[data-action="test"]').click();
  const ok = await h.formMessage(wrong, { test: true });
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  record('首次启动：测试连接成功，显示首字耗时，进入"Open folder…"', /^Connected · first token \d+ ms/.test(ok),
    oneLine(ok));
  const probe = await h.waitProbes();
  const providers = JSON.parse(readFileSync(join(userData, 'model-config.json'), 'utf8')).providers;
  record('首次启动：探针跑完、tool calling 已验证；同一张表单保存了三次，配置里仍只有一个提供商',
    probe === 'verified' && providers.length === 1 && providers[0].models.map((m) => m.id).join() === 'fake-coder',
    `probe-status=${probe}；providers=${providers.map((p) => `${p.id}:${p.models.map((m) => m.id)}`).join(' ')}`);
  await page.screenshot({ path: join(shots, '01-first-run-ok.png') });
  await h.openFolder(app, project);
  const empty = await page.locator('.empty-chat').innerText();
  record('首次启动：打开文件夹后是新会话的空状态（项目名和输入提示）',
    empty.includes('project') && empty.includes('Enter 发送 · Shift+Enter 换行'), oneLine(empty));
  // M2 起命令和编辑要先批准；这里测的是 M1 的行为，先切到全部允许。
  await h.allowAll();
}

/** @brief 发第一条消息：先"等待模型响应"，再流式文字；读取卡完成；上下文用量随对话增长。 */
async function firstMessage({ page, h }) {
  await h.sampleStages();
  await h.send('总结 README');
  await h.idle();
  const stages = await h.stages();
  record('对话：先显示"等待模型响应"，再"生成中"', stages[0] === '等待模型响应' && stages.includes('生成中'), stages.join(' → '));
  const cards = await h.cards();
  record('对话：读取卡完成', cards[0]?.title.includes('README.md') && cards[0].status === 'done', JSON.stringify(cards));
  record('对话：会话名取第一条消息', (await page.getByTestId('session-title').innerText()) === '总结 README');
  const before = await h.usageTokens();
  await h.send('plain 再说一句');
  await h.idle();
  const after = await h.usageTokens();
  record('对话：顶栏上下文用量随对话增长', before !== null && after !== null && after > before, `${before} → ${after}`);
}

/** @brief 代码块上的"复制代码"：代码进系统剪贴板（Mori 只放行自己页面写剪贴板这一项权限）。 */
async function copyCode({ app, page, h }) {
  await h.send('code block 给我一段代码');
  await h.idle();
  await app.evaluate(({ clipboard }) => clipboard.writeText('剪贴板原来的内容'));
  await page.getByRole('button', { name: '复制代码' }).last().click();
  let copied = '';
  for (let tries = 0; tries < 10 && !copied.includes('export function add'); tries += 1) {
    await sleep(200);
    copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  }
  record('代码块：点"复制代码"后代码进系统剪贴板', copied.includes('export function add(a: number, b: number): number {')
    && copied.includes('return a + b;') && !copied.includes('下面是一段代码'), oneLine(copied));
}

/**
 * @brief 设置 → Models：模型行的"Test"测试中可以取消（models-settings.md "Models 行"：测试中"Testing…"与"Cancel"，
 *        结果写在这一行下面）；所以先在提供商卡上"Add model"加一个 fake-slow（合成端点对它第一个分块前等 8 秒），
 *        再用这一行的"Test"和"Cancel"。默认范围仍是 fake-coder（检查），之后的步骤不受影响。
 */
async function cancelTest({ page, h, userData }) {
  await h.openModels();
  await h.providerCard().locator('[data-action="add-model"]').click();
  const form = page.getByTestId('model-form');
  await form.getByLabel('Model id', { exact: true }).fill('fake-slow');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const row = page.locator('[data-testid="model-row"][data-model="mori-endpoint/fake-slow"]');
  await row.waitFor({ timeout: 15000 });
  await row.locator('[data-action="test"]').click();
  await row.getByRole('button', { name: 'Testing…' }).waitFor({ timeout: 10000 });
  await row.locator('[data-action="test-cancel"]').click();
  const result = row.getByTestId('model-test');
  await result.waitFor({ timeout: 15000 });
  const text = await result.innerText();
  record('设置：模型行的"Test"在测试中变为"Testing…"，可以取消，结果写在这一行下面', text === 'Test cancelled', text);
  const config = JSON.parse(readFileSync(join(userData, 'model-config.json'), 'utf8'));
  record('设置："Add model"不改默认范围：normalDefault 仍是 mori-endpoint/fake-coder',
    config.normalDefault === 'mori-endpoint/fake-coder', String(config.normalDefault));
  await page.getByRole('button', { name: '返回会话' }).click();
}

/**
 * @brief 首次启动表单的"测试连接 → 取消"（first-run.md "测试中"）：模型 fake-slow（合成端点对它第一个分块前等 8 秒），
 *        测试中按钮变为"Testing…"，旁边"Cancel"；取消后表单下方"Test cancelled"。
 */
async function cancelFormTest({ page, h }) {
  const form = page.getByTestId('connection-form');
  await h.fillConnection({ name: 'Mori endpoint', baseUrl, zone: 'local', apiKey: testKey, modelId: 'fake-slow' });
  await form.locator('[data-action="test"]').click();
  const testing = await form.getByRole('button', { name: 'Testing…' }).waitFor({ timeout: 15000 })
    .then(() => true, () => false);
  if (testing) await form.locator('[data-action="test-cancel"]').click();
  const text = await h.formMessage(null, { test: true, timeout: 15000 }).catch(() => '');
  record('首次启动：测试连接时按钮变为"Testing…"，可以取消，表单下方"Test cancelled"',
    testing && text === 'Test cancelled', `Testing… 出现 ${testing}；${text}`);
}

/** @brief 运行耗时命令时排队一条，然后按 Esc：命令卡"已停止"，提示，排队消息回到输入框。 */
async function escStop({ page, h }) {
  await h.send('run: sleep 30');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 30000 });
  await h.send('plain 排队的消息');
  await page.getByTestId('queue').waitFor({ timeout: 10000 });
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await h.idle(30000);
  const last = (await h.cards()).at(-1);
  const notice = await page.getByText('已停止 · 已经做出的修改不会自动撤销').count();
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

/**
 * @brief 错误来源（v1，§14.4）：模型回复出错（http-400，v0 的错误卡）；原地重试（http-503-once：阶段行"Retrying 1/3"，
 *        不换模型，之后正常回复）；key 被拒：删 key、加一个错的 key → 一张说明卡（"No model available"，候选行
 *        "API key rejected"，"Open settings"，没有错误卡）→ Open settings 落在提供商卡、焦点在 Keys → 加回对的 key。
 */
async function errors({ page, h }) {
  await h.send('http-400 坏请求');
  await h.idle();
  const card = page.getByTestId('error-card').last();
  const text = await card.innerText();
  record('错误：模型回复出错显示原文和"把上一条消息放回输入框"', text.includes('400') && text.includes('把上一条消息放回输入框'),
    oneLine(text));
  await card.getByRole('button', { name: '把上一条消息放回输入框' }).click();
  record('错误：点它把上一条消息放回输入框', (await h.textarea.inputValue()) === 'http-400 坏请求');
  await h.textarea.fill('');
  const cardsBefore = await page.getByTestId('error-card').count();
  await h.sampleStages();
  await h.send('http-503-once 服务忙');
  await h.idle(120000);
  const stages = await h.stages();
  record('错误：原地重试时阶段行显示"Retrying 1/3"，之后正常回复，没有错误卡、没有换模型',
    stages.some((stage) => stage.startsWith('Retrying 1/3'))
      && await page.getByTestId('error-card').count() === cardsBefore
      && await page.locator('[data-testid="notice"][data-kind="model-switch"]').count() === 0,
    stages.join(' → '));
  await wrongKey({ page, h });
}

/** @brief 提供商卡上 key 的行数等于 count。 */
function keyRows(page, count) {
  return page.waitForFunction((want) => document.querySelectorAll(
    '[data-testid="provider-card"][data-provider="mori-endpoint"] [data-testid="key-row"]').length === want,
  count, { timeout: 15000 });
}

/** @brief key 被拒（§14.4 m1-app）：删 key、加错的 key → 说明卡 → Open settings（焦点在 Keys）→ 加回对的 key。 */
async function wrongKey({ page, h }) {
  await h.openModels();
  await h.addKey('wrong-key');
  const card = h.providerCard();
  await card.getByTestId('key-row').first().locator('[data-action="key-remove"]').click();
  await keyRows(page, 1);
  await page.getByRole('button', { name: '返回会话' }).click();
  const errorsBefore = await page.getByTestId('error-card').count();
  await h.send('plain 你好');
  await h.idle();
  const unavailable = page.getByTestId('unavailable-card').last();
  const text = oneLine(await unavailable.innerText().catch(() => ''));
  const reason = await unavailable.locator('[data-testid="candidate"]').first().getAttribute('data-reason')
    .catch(() => null);
  record('错误：key 被拒时一张说明卡（"API key rejected"、"Open settings"），没有错误卡',
    text.includes('API key rejected') && text.includes('Open settings') && reason === 'auth'
      && await page.getByTestId('error-card').count() === errorsBefore, `${text}；data-reason=${reason}`);
  await page.screenshot({ path: join(shots, '02b-wrong-key.png') });
  await unavailable.locator('[data-action="open-settings"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="key-row"]'), null,
    { timeout: 5000 }).catch(() => {});
  const focus = await page.evaluate(() => ({ key: Boolean(document.activeElement?.closest('[data-testid="key-row"]')),
    provider: document.activeElement?.closest('[data-testid="provider-card"]')?.dataset.provider ?? null,
    text: document.activeElement?.textContent ?? null }));
  record('错误：说明卡的"Open settings"打开 设置 → Models，焦点在出错提供商的 Keys（第一行）',
    focus.key && focus.provider === 'mori-endpoint', JSON.stringify(focus));
  await h.addKey(testKey);
  await card.getByTestId('key-row').first().locator('[data-action="key-remove"]').click();
  await keyRows(page, 1);
  await page.getByRole('button', { name: '返回会话' }).click();
  await h.send('plain 换回对的 key');
  await h.idle();
  const last = await page.getByTestId('assistant').last().innerText();
  record('错误：加回对的 key 后可以继续对话，没有新的说明卡', last.length > 0
    && await page.getByTestId('unavailable-card').count() === 1, oneLine(last));
}

/** @brief 结束后台进程：退出提示和"重新载入"，执行中的卡"已中断"，草稿还在；重新载入后从会话文件恢复。 */
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
    (await page.getByTestId('kernel-exit').innerText()).includes('刚才没完成的回复已中断'), `后台进程 PID ${pid}`);
  record('退出：执行中的命令卡变为"已中断"', last?.status === 'interrupted', JSON.stringify(last));
  record('退出：输入框里的草稿还在', (await h.textarea.inputValue()) === '还没发出的草稿');
  await page.screenshot({ path: join(shots, '03-kernel-exit.png') });
  const usersBefore = await page.getByTestId('user-message').count();
  await page.getByRole('button', { name: '重新载入' }).click();
  await page.getByText('已重新载入 · 排队消息、批准卡和"本会话已允许"不会恢复').waitFor({ timeout: 30000 });
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
    await page.getByRole('button', { name: '右栏：本会话的改动' }).click();
  }
  await page.locator('[data-resize="workspace"]').focus();
  await page.keyboard.press('ArrowLeft');
  const saved = { sidebar: await page.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'),
    workspace: await page.locator('[data-resize="workspace"]').getAttribute('aria-valuenow') };
  await app.close();
  const next = await launch({ exePath, userData });
  const nextPage = await next.firstWindow();
  const helpers = pageHelpers(nextPage);
  await nextPage.getByRole('button', { name: '打开文件夹…' }).first().waitFor({ timeout: 60000 });
  await helpers.openFolder(next, project);
  await nextPage.getByRole('button', { name: '右栏：本会话的改动' }).click();
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
  const run = await helpers.firstRun({ baseUrl, apiKey: testKey });
  if (!run.ok || run.probe !== 'verified') throw new Error(`first run: ${run.text}; probes ${run.probe}`);
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
