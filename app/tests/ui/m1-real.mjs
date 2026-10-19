// M1 真实端点走查（方案第 7 节 M1 走查 1–10 与反例），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 脚本不接触 key：只把走查数据目录里 Mori 加密保存的密文（credentials.json 与 Local State）复制到临时目录。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m1-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,…]
// 结果写到 test-results/m1-real(-packaged).json，截图在 test-results/m1-real(-packaged)/。

import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  appRoot, arg, createRecorder, killKernel, launch, oneLine, prepareProject, scratchUserData, sleep,
} from './lib.mjs';
import { smallText } from './m1-layout.mjs';
import { pageHelpers } from './page.mjs';

const source = arg('source');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/m1-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const wanted = (item) => !only || only.includes(String(item));

/** @brief 读写临时数据目录里 pi 的 JSON 配置。 */
function editJson(dir, name, fn) {
  const path = join(dir, 'pi', name);
  writeFileSync(path, JSON.stringify(fn(JSON.parse(readFileSync(path, 'utf8'))), null, 2));
}

/** @brief 首次启动用的数据目录：有加密的 key，models.json 里只有端点地址、没有模型，所以 Mori 按首次启动处理。 */
function firstRunDir() {
  const dir = scratchUserData(source);
  editJson(dir, 'models.json', (file) => {
    const provider = file.providers['mori-endpoint'];
    return { providers: { 'mori-endpoint': { baseUrl: provider.baseUrl, api: provider.api, models: [] } } };
  });
  rmSync(join(dir, 'pi', 'settings.json'), { force: true });
  return dir;
}

/** @brief 走查 1：首次启动 → 填连接（key 栏留空，沿用加密保存的 key）→ 测试成功 → 选文件夹 → 发第一条消息。 */
async function item1({ app, page, h, project, connection }) {
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  record('1 首次启动只有连接表单', await page.getByTestId('sidebar').count() === 0);
  await shot(page, '1-first-run');
  await h.fillConnection({ name: 'DeepSeek', baseUrl: connection.baseUrl, modelId: connection.model,
    contextWindow: connection.contextWindow });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByTestId('open-folder').waitFor({ timeout: 90000 });
  const result = await page.getByTestId('test-result').innerText();
  record('1 测试连接成功（显示首字耗时），进入"打开文件夹…"', /连接成功 · 首字 \d+ ms/.test(result), oneLine(result));
  await shot(page, '1-test-ok');
  await h.openFolder(app, project);
  await h.sampleStages();
  await h.watchThinking();
  await page.evaluate(() => {
    window.__lengths = new Set();
    window.__lengthTimer = setInterval(() => {
      const text = [...document.querySelectorAll('.prose')].map((e) => e.textContent).join('');
      if (text) window.__lengths.add(text.length);
    }, 50);
  });
  await h.send('先读一下 README.md，再用 Markdown 列表总结它，最后给一个小标题。');
  const sent = await page.getByTestId('user-message').first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  record('1 发出第一条消息（出现在对话流里）', sent && await page.getByTestId('user-message').count() === 1);
  return {};
}

/** @brief 走查 2：先"等待模型响应 Ns"，再流式 Markdown；有思考时"思考中"，正文开始后思考收起。 */
async function item2({ page, h }) {
  await h.idle();
  const stages = await h.stages();
  const lengths = await page.evaluate(() => window.__lengths.size);
  record('2 先看到"等待模型响应 Ns"', stages[0] === '等待模型响应', stages.join(' → '));
  record('2 Markdown 流式出现', lengths > 3 && await page.locator('.prose li, .prose [data-streamdown^="heading"]').count() > 0,
    `采样到 ${lengths} 种长度`);
  const thinking = await page.locator('details.thinking').count();
  const collapsed = await page.locator('details.thinking').evaluateAll((items) => items.every((d) => !d.open));
  const opened = await h.thinkingOpened();
  record('2 有思考内容时阶段行显示"思考中"、思考流入时展开，正文开始后折叠', thinking === 0
    || (stages.includes('思考中') && opened && collapsed), `思考块 ${thinking} 个；流入时展开=${opened}`);
  const afterTool = stages.findIndex((s, i) => i > 0 && s === '生成中' && stages[i - 1].startsWith('运行 '));
  record('2 反例：工具执行完后不直接显示"生成中"（应先等待模型响应）', afterTool < 0, stages.join(' → '));
  await shot(page, '2-markdown');
}

/** @brief 走查 3：工具卡从执行中到完成，可以展开；上下文用量随对话增长；反例：失败的命令不显示"完成"。 */
async function item3({ page, h }) {
  const before = await h.usageTokens();
  await page.evaluate(() => {
    window.__statuses = [];
    window.__statusTimer = setInterval(() => {
      const status = document.querySelector('[data-testid="tool-card"]:last-of-type')?.dataset.status;
      const all = [...document.querySelectorAll('[data-testid="tool-card"]')].map((card) => card.dataset.status);
      const last = all.at(-1);
      if (last && window.__statuses.at(-1) !== last) window.__statuses.push(last);
      return status;
    }, 50);
  });
  await h.send('运行命令 `sleep 3; echo ok`，然后运行命令 `ls does-not-exist-dir`，最后告诉我两个结果。');
  await h.idle();
  const statuses = await page.evaluate(() => window.__statuses);
  const cards = await h.cards();
  const sleepCard = cards.find((card) => card.title.includes('sleep 3'));
  const failCard = cards.find((card) => card.title.includes('does-not-exist-dir'));
  record('3 工具卡从"执行中"变为"完成"', statuses.includes('running') && sleepCard?.status === 'done', statuses.join(' → '));
  record('3 反例：失败的命令显示"失败 · 退出码"，不显示"完成"', failCard?.status === 'failed' && /^失败/.test(failCard.text),
    JSON.stringify(failCard));
  const index = cards.indexOf(sleepCard);
  await page.getByTestId('tool-card').nth(index).locator('summary').click();
  await page.getByTestId('tool-card').nth(index).locator('.tool-body').waitFor();
  const body = await page.getByTestId('tool-card').nth(index).innerText();
  record('3 展开工具卡能看到参数和输出', body.includes('参数') && body.includes('sleep 3') && body.includes('ok'), oneLine(body));
  const after = await h.usageTokens();
  record('3 上下文用量随对话增长', before !== null && after > before, `${before} → ${after}`);
  await shot(page, '3-tool-cards');
}

/** @brief 走查 4：生成中排队一条、插话一条；插话在本轮工具执行完后进入对话流，排队的在本轮结束后。 */
async function item4({ page, h }) {
  const usersBefore = await page.getByTestId('user-message').count();
  await h.send('运行命令 `sleep 8; echo done`，完成后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 60000 });
  await h.send('插话：另外告诉我 README.md 有几行。', 'Control+Enter');
  await h.send('排队：最后用一句话总结你做了什么。');
  await page.waitForFunction(() => document.querySelector('[data-testid="queue"]')?.textContent?.includes('排队：最后'),
    null, { timeout: 10000 }).catch(() => {});
  const queue = await page.getByTestId('queue').innerText();
  record('4 插话和排队两条先出现在排队区', queue.includes('插话：另外') && queue.includes('排队：最后'), oneLine(queue));
  await shot(page, '4-queue');
  await page.getByTestId('user-message').filter({ hasText: '插话：另外' }).waitFor({ timeout: 60000 });
  const sleepCard = (await h.cards()).find((card) => card.title.includes('sleep 8'));
  const stillQueued = (await page.getByTestId('queue').innerText().catch(() => '')).includes('排队：最后');
  record('4 插话在本轮工具执行完后进入对话流', sleepCard?.status === 'done' && stillQueued, JSON.stringify(sleepCard));
  await h.idle();
  const users = (await page.getByTestId('user-message').allInnerTexts()).slice(usersBefore);
  record('4 排队的那条在本轮结束后进入对话流', users.length === 3 && users[2].startsWith('排队：'), users.join(' | '));
  await shot(page, '4-delivered');
}

/** @brief 走查 5：运行耗时命令时按 Esc：命令卡"已停止"，提示，排队消息回到输入框。 */
async function item5({ page, h }) {
  await h.send('运行命令 `sleep 30; echo late`，然后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 60000 });
  await sleep(1500);
  await h.send('排队：这条会回到输入框');
  await page.getByTestId('queue').waitFor();
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await h.idle(60000);
  const card = (await h.cards()).find((item) => item.title.includes('sleep 30'));
  const notice = await page.getByText('已停止 · 已经做出的修改不会自动撤销').count();
  record('5 Esc：命令卡显示"已停止"', card?.status === 'stopped', JSON.stringify(card));
  record('5 提示"已停止 · 已经做出的修改不会自动撤销"', notice >= 1);
  record('5 排队消息回到输入框', (await h.textarea.inputValue()).includes('排队：这条会回到输入框'));
  record('5 停止不显示成错误', await page.getByTestId('error-card').count() === 0);
  await shot(page, '5-stopped');
  await h.textarea.fill('');
}

/** @brief 走查 7：结束后台进程：退出提示和"重新载入"，草稿还在；重新载入后接着用。 */
async function item7({ app, page, h }) {
  await h.send('运行命令 `sleep 20; echo late`，然后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 60000 });
  await h.textarea.fill('后台进程退出前写的草稿');
  const pid = killKernel(app);
  await page.getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  const banner = await page.getByTestId('kernel-exit').innerText();
  record('7 看到退出提示和"重新载入"', banner.includes('Mori 的后台进程意外退出 · 刚才没完成的回复已中断')
    && banner.includes('重新载入'), `PID ${pid}`);
  record('7 输入框里的草稿还在', (await h.textarea.inputValue()) === '后台进程退出前写的草稿');
  const card = (await h.cards()).find((item) => item.title.includes('sleep 20'));
  record('7 没结束的命令卡显示"已中断"', card?.status === 'interrupted', JSON.stringify(card));
  await shot(page, '7-kernel-exit');
  await page.getByRole('button', { name: '重新载入' }).click();
  await page.getByText('已重新载入 · 排队消息、批准卡和"本会话已允许"不会恢复').waitFor({ timeout: 60000 });
  record('7 重新载入后草稿仍在', (await h.textarea.inputValue()) === '后台进程退出前写的草稿');
  await h.send('重新载入之后，用一句话回答：1+1 等于几？');
  await h.idle();
  const errors = await page.getByTestId('error-card').count();
  record('7 重新载入后可以继续对话', errors === 0, `错误卡 ${errors} 张`);
  await shot(page, '7-reloaded');
}

/** @brief 走查 9：分隔线拖动、双击恢复、重启后保留；800 宽不裁切；没有小于 12px 的文字。 */
async function item9(ctx) {
  const { page } = ctx;
  const sidebar = page.locator('[data-resize="sidebar"]');
  const box = await sidebar.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 64, box.y + 300, { steps: 6 });
  await page.mouse.up();
  const dragged = Number(await sidebar.getAttribute('aria-valuenow'));
  await sidebar.dblclick();
  const reset = Number(await sidebar.getAttribute('aria-valuenow'));
  record('9 拖动左分隔线、双击恢复默认', dragged > reset && reset === 260, `${dragged} → ${reset}`);
  await page.mouse.move(box.x + 4, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x - 36, box.y + 300, { steps: 6 });
  await page.mouse.up();
  if (await page.locator('[data-resize="workspace"]').count() === 0) {
    await page.getByRole('button', { name: '右栏：本会话的改动' }).click();
  }
  const right = page.locator('[data-resize="workspace"]');
  const rightBox = await right.boundingBox();
  await page.mouse.move(rightBox.x + 4, rightBox.y + 300);
  await page.mouse.down();
  await page.mouse.move(rightBox.x - 46, rightBox.y + 300, { steps: 6 });
  await page.mouse.up();
  const saved = { sidebar: await sidebar.getAttribute('aria-valuenow'), workspace: await right.getAttribute('aria-valuenow') };
  const small = await smallText(page);
  record('9 没有小于 12px 的文字', small.length === 0, small.slice(0, 3).join('; '));
  await ctx.app.close();
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.h = pageHelpers(ctx.page);
  await ctx.page.getByRole('button', { name: '打开文件夹…' }).first().waitFor({ timeout: 60000 });
  await ctx.h.openFolder(ctx.app, ctx.project);
  await ctx.page.getByRole('button', { name: '右栏：本会话的改动' }).click();
  const after = { sidebar: await ctx.page.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'),
    workspace: await ctx.page.locator('[data-resize="workspace"]').getAttribute('aria-valuenow') };
  record('9 重启后宽度还在', saved.sidebar === after.sidebar && saved.workspace === after.workspace,
    `${JSON.stringify(saved)} → ${JSON.stringify(after)}`);
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600));
  await sleep(600);
  const report = await ctx.page.evaluate(() => ({ page: document.documentElement.scrollWidth, width: window.innerWidth,
    overflow: [...document.querySelectorAll('.topbar, .composer, .composer-bottom, .chat-pane, .right-panel, .sidebar')]
      .filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map((e) => e.className) }));
  await shot(ctx.page, '9-800-wide');
  record('9 窗口 800 宽时没有内容被裁掉', report.width === 800 && report.page <= 800 && report.overflow.length === 0,
    JSON.stringify(report));
  const narrowSmall = await smallText(ctx.page);
  record('9 800 宽时没有小于 12px 的文字', narrowSmall.length === 0, narrowSmall.slice(0, 3).join('; '));
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 800));
}

/** @brief 走查 10：拼音输入法组字时按 Enter 选词，不会发送（用 Chromium 的输入法接口模拟组字）。 */
async function item10({ page, h }) {
  const before = await page.getByTestId('user-message').count();
  const cdp = await page.context().newCDPSession(page);
  await h.textarea.focus();
  await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
  await page.keyboard.press('Enter');
  await cdp.send('Input.insertText', { text: '你好' });
  await sleep(1500);
  const after = await page.getByTestId('user-message').count();
  record('10 输入法组字时按 Enter 不会发送', after === before && (await h.textarea.inputValue()).includes('你好'),
    `消息 ${before} → ${after}；输入框：${await h.textarea.inputValue()}`);
  await h.textarea.fill('');
}

/** @brief 走查 6：key 填错 → 原文和"去设置"；key 写成没设置的 $变量 → 同样（$ 写法已不再特殊）；没有 key → 找不到 key 的原文和"去设置"。 */
async function item6({ page, h }, wrongKey) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await h.fillConnection({ apiKey: wrongKey });
  await page.getByRole('button', { name: '保存' }).click();
  await h.formMessage();
  await page.getByRole('button', { name: '返回会话' }).click();
  await h.send('你好');
  await h.idle();
  const card = page.getByTestId('error-card').last();
  const text = await card.innerText();
  record(`6 key 为"${wrongKey}"：看到错误原文和"去设置"`, text.includes('去设置') && /401|api key/i.test(text), oneLine(text));
  await shot(page, `6-key-${wrongKey.startsWith('$') ? 'dollar' : 'wrong'}`);
  await card.getByRole('button', { name: '去设置' }).click();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('type'));
  record('6 "去设置"打开连接表单，焦点在 API key', focused === 'password');
  await page.getByRole('button', { name: '返回会话' }).click();
}

/** @brief 走查 6（没有 key）：数据目录里没有加密的 key，发送时就失败。 */
async function item6NoKey(project) {
  const dir = scratchUserData(source, { withKey: false });
  const app = await launch({ exePath, userData: dir });
  try {
    const page = await app.firstWindow();
    const h = pageHelpers(page);
    await page.getByRole('button', { name: '打开文件夹…' }).first().waitFor({ timeout: 60000 });
    await h.openFolder(app, project);
    await h.send('你好');
    const card = page.getByTestId('error-card');
    await card.waitFor({ timeout: 30000 });
    const text = await card.innerText();
    record('6 没有 key：看到找不到 key 的原文和"去设置"', text.includes('No API key found') && text.includes('去设置'), oneLine(text));
    await shot(page, '6-no-key');
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @brief 走查 8：上下文长度 8k（加 pi 的压缩参数）长聊：阶段行"正在压缩较早的对话"，对话流留下"已压缩较早的对话"。 */
async function item8(project) {
  const dir = scratchUserData(source);
  editJson(dir, 'models.json', (file) => { file.providers['mori-endpoint'].models[0].contextWindow = 8000; return file; });
  editJson(dir, 'settings.json', (file) => ({ ...file, compaction: { reserveTokens: 6000, keepRecentTokens: 300 } }));
  const app = await launch({ exePath, userData: dir });
  try {
    const page = await app.firstWindow();
    const h = pageHelpers(page);
    await page.getByRole('button', { name: '打开文件夹…' }).first().waitFor({ timeout: 60000 });
    await h.openFolder(app, project);
    await h.sampleStages();
    for (const text of ['读一下 README.md 和 src/a.ts，然后详细介绍这个项目。', '再详细解释 add 函数，并给出三个使用例子。']) {
      await h.send(text);
      await h.idle(240000);
    }
    const stages = await h.stages();
    const notices = await page.getByText('已压缩较早的对话', { exact: true }).count();
    record('8 一直在底部时不出现"有新内容"', await page.getByTestId('new-content').count() === 0);
    record('8 阶段行显示"正在压缩较早的对话"', stages.includes('正在压缩较早的对话'), stages.join(' → '));
    record('8 对话流留下"已压缩较早的对话"', notices >= 1, `${notices} 处`);
    await shot(page, '8-compaction');
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @brief 走查连接的非机密信息。 */
function connectionInfo() {
  const provider = JSON.parse(readFileSync(join(source, 'pi', 'models.json'), 'utf8')).providers['mori-endpoint'];
  return { baseUrl: provider.baseUrl, model: provider.models[0].id, contextWindow: provider.models[0].contextWindow };
}

/** @brief 依次执行一项走查；出错时记录并截图，继续下一项。 */
async function step(ctx, name, fn) {
  try {
    return await fn();
  } catch (error) {
    record(`${name}：流程`, false, oneLine(error, 400));
    await shot(ctx.page, `${name}-error`);
    return undefined;
  }
}

const { project, root } = prepareProject('mori-m1-real-');
const userData = firstRunDir();
const ctx = { project, userData, connection: connectionInfo() };
ctx.app = await launch({ exePath, userData });
ctx.page = await ctx.app.firstWindow();
ctx.h = pageHelpers(ctx.page);
const pageErrors = [];
ctx.page.on('pageerror', (error) => pageErrors.push(error.message));
try {
  const first = await step(ctx, '走查 1', () => item1(ctx));
  if (first) await step(ctx, '走查 2', () => item2(ctx));
  if (wanted(3)) await step(ctx, '走查 3', () => item3(ctx));
  if (wanted(4)) await step(ctx, '走查 4', () => item4(ctx));
  if (wanted(5)) await step(ctx, '走查 5', () => item5(ctx));
  if (wanted(7)) await step(ctx, '走查 7', () => item7(ctx));
  if (wanted(10)) await step(ctx, '走查 10', () => item10(ctx));
  if (wanted(9)) await step(ctx, '走查 9', () => item9(ctx));
  if (wanted(6)) {
    await step(ctx, '走查 6 key 填错', () => item6(ctx, 'sk-mori-walkthrough-wrong-key'));
    await step(ctx, '走查 6 $变量', () => item6(ctx, '$MORI_UNSET_KEY'));
  }
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await ctx.app.close().catch(() => {});
}
if (wanted(6)) await item6NoKey(project).catch((error) => record('走查 6 没有 key：流程', false, oneLine(error, 300)));
if (wanted(8)) await item8(project).catch((error) => record('走查 8：流程', false, oneLine(error, 300)));
rmSync(userData, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
process.exitCode = write(`m1-real${suffix}.json`) ? 0 : 1;
