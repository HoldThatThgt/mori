// M1 真实端点走查（方案第 7 节 M1 走查 1–10 与反例），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 脚本不接触 key：只把走查数据目录里 Mori 加密保存的密文（credentials.json 与 Local State）复制到临时目录。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m1-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,…]
// 结果写到 test-results/m1-real(-packaged).json，截图在 test-results/m1-real(-packaged)/。
// v1（docs/specs/model-providers.md §14.1、§14.4）：提供商从 model-config.json 取；首次启动的走查用一个空的复制数据目录
// （只有密文文件）：v1 的首次启动表单不沿用已存的 key，key 栏留空时请求不带认证头，所以测试连接按真实端点的回答失败；
// 之后作为测试准备退出 App，把这个提供商的 key 指向复制来的密文（只复制密文，不读 key）、给项目授权公网，再启动、
// 在拒绝启动卡上 Verify now，接着走查。走查 6 改为"错的 key → 说明卡 → Open settings → Keys"，$变量与没有 key 的情形删去；
// 压缩的准备改为在复制出的 model-config.json 里把窗口改小。
// 2026-10-21 起（docs/v0/composer-pickers.md）：权限、选择范围、Effort 和上下文用量（圆环）在输入框下面一行：用量随回复增长
// 读圆环的 data-tokens（page.mjs usageTokens），圆环的读屏名、悬停和颜色按真实的数核对；拒绝启动卡在输入框上方时这一行的样子；
// 800 宽时这一行不换行、不溢出；压缩之后圆环的样子。

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allowRealProject, appRoot, arg, createRecorder, editModelConfig, killKernel, launch, oneLine, prepareProject,
  realProviders, scratchUserData, sleep,
} from './lib.mjs';
import {
  composerRow, hoverRing, layoutProblems, ringColorProblems, ringState, ringTextProblems, rowProblems, rowSummary,
  smallText, stateProblems,
} from './m1-layout.mjs';
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
/** 刚压缩完时圆环的描述（models.md"上下文用量（圆环）"） */
const COMPACTED_NOTE = 'Just compacted. Context usage shows after the next response.';

/** @brief 读写临时数据目录里 pi 的 JSON 配置（不存在时从空对象开始）。 */
function editJson(dir, name, fn) {
  const path = join(dir, 'pi', name);
  const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(path, JSON.stringify(fn(value), null, 2));
}

/**
 * @brief 首次启动用的数据目录（§14.4）：空的复制数据目录，只留密文文件（credentials.json 与 Local State），没有
 *        model-config.json 与 pi 的配置，所以 Mori 按首次启动处理。
 */
function firstRunDir() {
  const dir = scratchUserData(source);
  const configs = ['model-config.json', 'model-profiles.json', join('pi', 'models.json'), join('pi', 'settings.json')];
  for (const name of configs) rmSync(join(dir, name), { force: true });
  return dir;
}

/**
 * @brief 测试准备（synthetic test setup，§14.1）：App 退出后，把首次启动建的提供商的 key 指向复制来的首选密文
 *        （credentials.json 里另存一份到 <id>#1，只复制密文，不读 key），并给项目授权公网。
 */
function pointKeyToCopiedCipher(dir, connection, project) {
  const credentialsPath = join(dir, 'credentials.json');
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  let ref = null;
  editModelConfig(dir, (config) => {
    const provider = config.providers[0];
    ref = `${provider.id}#1`;
    provider.keys = [{ ref, label: 'Key 1' }];
    provider.nextKeyNumber = Math.max(provider.nextKeyNumber, 2);
  });
  credentials[ref] = credentials[connection.keys[0]];
  writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  allowRealProject(dir, project);
}

/**
 * @brief 走查 1（v1）：首次启动 → 填表（区域 Public，key 栏留空）→ 测试连接按真实端点的回答失败（没有 key 不带认证头）；
 *        测试准备（退出、key 指向复制来的密文、授权公网）→ 重新启动 → 打开文件夹 → 拒绝启动卡上 Verify now → 发第一条消息。
 */
async function item1(ctx) {
  const { page, h, connection } = ctx;
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  record('1 首次启动只有首次启动表单', await page.getByTestId('sidebar').count() === 0);
  await shot(page, '1-first-run');
  await h.fillConnection({ name: connection.name, baseUrl: connection.baseUrl, zone: 'public',
    modelId: connection.model,
    contextWindow: connection.contextWindow });
  const note = await page.getByTestId('zone-public-note').innerText().catch(() => '');
  await page.getByTestId('connection-form').locator('[data-action="test"]').click();
  const result = await h.formMessage(null, { test: true, timeout: 180000 });
  record('1 区域 Public 时说明"Public providers must be allowed per project…"；key 栏留空时测试连接失败（请求不带认证头，'
    + '真实端点的原文）', note.startsWith('Public providers must be allowed per project')
    && /^(Connection failed|Failed)/.test(result), `${oneLine(note)}；${oneLine(result)}`);
  await shot(page, '1-test-no-key');
  await ctx.app.close();
  pointKeyToCopiedCipher(ctx.userData, connection, ctx.project);
  await relaunch(ctx);
  await ctx.page.getByRole('button', { name: 'Open folder…' }).first().waitFor({ timeout: 60000 });
  await ctx.h.openFolder(ctx.app, ctx.project);
  await verifyNow(ctx);
  await sendFirst(ctx);
  return {};
}

/** @brief 重新启动 App（同一个数据目录）。 */
async function relaunch(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.h = pageHelpers(ctx.page);
  ctx.page.on('pageerror', (error) => pageErrors.push(error.message));
}

/**
 * @brief 拒绝启动时输入框下面一行（chat.md"输入框下面一行"拒绝启动、model-chat.md"拒绝启动卡"）：拒绝启动卡在输入框上方；
 *        选择范围按钮可用（卡上的"Change model…"打开它的菜单），没有当前模型时悬停第二行"No model can run in this session"、
 *        没有 Effort；"Send"不可用；这一行不换行、不溢出。圆环按它自己的规则，不查在不在。
 */
async function blockedRow(page) {
  const row = await composerRow(page);
  const problems = [...layoutProblems(row), ...stateProblems(row, 'blocked', { ring: false })];
  record('1 拒绝启动时：卡在输入框上方，这一行的选择范围按钮可用、没有当前模型时没有 Effort，"Send"不可用，不换行不溢出',
    problems.length === 0, `${problems.join('; ')} ${rowSummary(row)}`);
}

/** @brief 首次启动的那次探针因为没有 key 没有结果：拒绝启动卡上点 Verify now，等探针跑完、卡片解除。 */
async function verifyNow({ page }) {
  const card = page.getByTestId('blocked-card');
  if (await card.count()) {
    await blockedRow(page);
    await card.locator('[data-action="verify"]').click().catch(() => {});
    await card.waitFor({ state: 'detached', timeout: 600000 }).catch(() => {});
  }
  record('1 key 指向复制来的密文、授权公网后，Verify now 跑完探针，会话可以发送（没有拒绝启动卡）',
    await page.getByTestId('blocked-card').count() === 0);
}

/** @brief 走查 1 的后半：切到全部允许，开始采样，发第一条消息。 */
async function sendFirst({ page, h }) {
  // M2 起命令和编辑要先批准；这里走查的是 M1 的行为，先切到全部允许。
  await h.allowAll();
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
}

/** @brief 走查 2：先"Waiting for the model… Ns"，再流式 Markdown；有思考时"Thinking…"，正文开始后思考收起。 */
async function item2({ page, h }) {
  await h.idle();
  const stages = await h.stages();
  const lengths = await page.evaluate(() => window.__lengths.size);
  record('2 先看到"等待模型响应 Ns"', stages[0] === 'Waiting for the model…', stages.join(' → '));
  record('2 Markdown 流式出现', lengths > 3 && await page.locator('.prose li, .prose [data-streamdown^="heading"]').count() > 0,
    `采样到 ${lengths} 种长度`);
  const thinking = await page.locator('details.thinking').count();
  const collapsed = await page.locator('details.thinking').evaluateAll((items) => items.every((d) => !d.open));
  const opened = await h.thinkingOpened();
  record('2 有思考内容时阶段行显示"思考中"、思考流入时展开，正文开始后折叠', thinking === 0
    || (stages.includes('Thinking…') && opened && collapsed), `思考块 ${thinking} 个；流入时展开=${opened}`);
  const afterTool = stages.findIndex((s, i) => i > 0 && s === 'Responding…' && stages[i - 1].startsWith('Run '));
  record('2 反例：工具执行完后不直接显示"生成中"（应先等待模型响应）', afterTool < 0, stages.join(' → '));
  await shot(page, '2-markdown');
}

/**
 * @brief 走查 3：工具卡从执行中到完成，可以展开；上下文用量随对话增长（输入框下面一行的圆环，读 data-tokens）；
 *        反例：失败的命令不显示"Done"。真实的数：圆环的读屏名、悬停与 data-tokens 一致，写法照 Claude（k、四舍五入），
 *        颜色按百分比。
 */
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
  record('3 反例：失败的命令显示"失败 · 退出码"，不显示"完成"', failCard?.status === 'failed' && /^Failed/.test(failCard.text),
    JSON.stringify(failCard));
  const index = cards.indexOf(sleepCard);
  await page.getByTestId('tool-card').nth(index).locator('summary').click();
  await page.getByTestId('tool-card').nth(index).locator('.tool-body').waitFor();
  const body = await page.getByTestId('tool-card').nth(index).innerText();
  record('3 展开工具卡能看到参数和输出', body.includes('Input') && body.includes('sleep 3') && body.includes('ok'), oneLine(body));
  const after = await h.usageTokens();
  record('3 上下文用量随对话增长', before !== null && after > before, `${before} → ${after}`);
  const ring = await hoverRing(page);
  const problems = [...ringTextProblems(ring), ...ringColorProblems(ring)];
  record('3 圆环：读屏名"Usage: Context approximately … of … tokens (N%)"、悬停"Context ≈ …k / …k (N%)"与 data-tokens 一致，'
    + '底圈和填充的颜色按百分比', problems.length === 0, `${problems.join('; ')} ${ring?.tip} | ${ring?.label}`);
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

/** @brief 走查 5：运行耗时命令时按 Esc：命令卡"Stopped"，提示，排队消息回到输入框。 */
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
  const notice = await page.getByText('Stopped · Changes made so far stay as they are').count();
  record('5 Esc：命令卡显示"已停止"', card?.status === 'stopped', JSON.stringify(card));
  record('5 提示"已停止 · 已经做出的修改不会自动撤销"', notice >= 1);
  record('5 排队消息回到输入框', (await h.textarea.inputValue()).includes('排队：这条会回到输入框'));
  record('5 停止不显示成错误', await page.getByTestId('error-card').count() === 0);
  await shot(page, '5-stopped');
  await h.textarea.fill('');
}

/** @brief 走查 7：结束后台进程：退出提示和"Restart"，草稿还在；重新载入后接着用。 */
async function item7({ app, page, h }) {
  await h.send('运行命令 `sleep 20; echo late`，然后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 60000 });
  await h.textarea.fill('后台进程退出前写的草稿');
  const pid = killKernel(app);
  await page.getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  const banner = await page.getByTestId('kernel-exit').innerText();
  record('7 看到退出提示和"重新载入"',
    banner.includes('Mori’s background process crashed · Unfinished responses were interrupted')
    && banner.includes('Restart'), `PID ${pid}`);
  record('7 输入框里的草稿还在', (await h.textarea.inputValue()) === '后台进程退出前写的草稿');
  const card = (await h.cards()).find((item) => item.title.includes('sleep 20'));
  record('7 没结束的命令卡显示"已中断"', card?.status === 'interrupted', JSON.stringify(card));
  await shot(page, '7-kernel-exit');
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText('Restarted · Queued messages, pending approvals, and “Allow for this session” choices '
    + 'weren’t restored').waitFor({ timeout: 60000 });
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
    await page.getByRole('button', { name: 'Toggle changes' }).click();
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
  await ctx.page.getByRole('button', { name: 'Open folder…' }).first().waitFor({ timeout: 60000 });
  await ctx.h.openFolder(ctx.app, ctx.project);
  await ctx.page.getByRole('button', { name: 'Toggle changes' }).click();
  const after = { sidebar: await ctx.page.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'),
    workspace: await ctx.page.locator('[data-resize="workspace"]').getAttribute('aria-valuenow') };
  record('9 重启后宽度还在', saved.sidebar === after.sidebar && saved.workspace === after.workspace,
    `${JSON.stringify(saved)} → ${JSON.stringify(after)}`);
  await item9Narrow(ctx);
}

/**
 * @brief 走查 9 后半：800 宽不裁切（输入框下面一行、圆环、发送组也在查溢出的列表里），这一行（权限、真实的选择范围、Effort、
 *        圆环、发送）按会话面板的宽度收紧、截短的先后对；没有小于 12px 的文字。
 */
async function item9Narrow(ctx) {
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600));
  await sleep(600);
  const report = await ctx.page.evaluate(() => ({ page: document.documentElement.scrollWidth, width: window.innerWidth,
    overflow: [...document.querySelectorAll('.topbar, .composer, .composer-bottom, .chat-pane, .right-panel, '
      + '.sidebar, [data-testid="usage"], .send-button, .stop-button, .split-button, .queue-button')]
      .filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map((e) => e.className) }));
  const row = await composerRow(ctx.page);
  await shot(ctx.page, '9-800-wide');
  record('9 窗口 800 宽时没有内容被裁掉', report.width === 800 && report.page <= 800 && report.overflow.length === 0,
    JSON.stringify(report));
  const problems = rowProblems(row, 'idle');
  record('9 800 宽时输入框下面一行（权限、真实的选择范围、Effort、圆环、发送）不换行、不溢出，按会话面板的宽度收紧',
    problems.length === 0, `${rowSummary(row)} ${problems.join('; ')}`);
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

/**
 * @brief 走查 6（v1，§14.4）：错的 key → 说明卡 → Open settings → Keys。设置 → Models 里加一个错的 key（sk-invalid，故意填错，
 *        不是机密）、删掉原来的 key；发消息：401 → auth，范围里没有别的候选，对话流是一张说明卡（"API key rejected"、
 *        "Open settings"），没有错误卡；Open settings 落在这个提供商的 Keys。
 */
async function item6({ page, h }) {
  await h.openModels();
  const card = page.getByTestId('provider-card').first();
  const provider = await card.getAttribute('data-provider');
  const before = await card.getByTestId('key-row').count();
  await h.addKey('sk-invalid', provider);
  for (let left = before; left > 0; left -= 1) {
    await card.getByTestId('key-row').first().locator('[data-action="key-remove"]').click();
    await sleep(500);
  }
  await page.getByRole('button', { name: 'Back to app' }).click();
  const errors = await page.getByTestId('error-card').count();
  await h.send('你好');
  await h.idle();
  const unavailable = page.getByTestId('unavailable-card').last();
  const text = oneLine(await unavailable.innerText().catch(() => ''));
  record('6 错的 key：一张说明卡（"API key rejected"、"Open settings"），没有错误卡', text.includes('API key rejected')
    && text.includes('Open settings') && await page.getByTestId('error-card').count() === errors, text);
  await shot(page, '6-key-wrong');
  await unavailable.locator('[data-action="open-settings"]').click();
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="key-row"]'), null, { timeout: 5000 })
    .catch(() => {});
  const focus = await page.evaluate(() => document.activeElement?.closest('[data-testid="provider-card"]')
    ?.dataset.provider ?? null);
  record('6 "Open settings"打开 设置 → Models，焦点在这个提供商的 Keys', focus === provider, String(focus));
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/**
 * @brief 走查 8：上下文长度 8k（加 pi 的压缩参数）长聊：阶段行"Compacting session…"，对话流留下"Compacted session"。
 *        准备（§14.4）：在复制出的 model-config.json 里把首选第一个模型的窗口改为 8000（最大输出不超过 4000），并给项目
 *        授权公网、默认范围设为测试分组（测试准备）。
 */
async function item8(project, connection) {
  const dir = scratchUserData(source);
  allowRealProject(dir, project);
  editModelConfig(dir, (config) => {
    const model = config.providers.find((item) => item.id === connection.provider).models[0];
    model.contextWindow = 8000;
    model.maxTokens = Math.min(model.maxTokens, 4000);
  });
  editJson(dir, 'settings.json', (file) => ({ ...file, compaction: { reserveTokens: 6000, keepRecentTokens: 300 } }));
  const app = await launch({ exePath, userData: dir });
  try {
    const page = await app.firstWindow();
    const h = pageHelpers(page);
    await page.getByRole('button', { name: 'Open folder…' }).first().waitFor({ timeout: 60000 });
    await h.openFolder(app, project);
    await h.allowAll();
    await h.sampleStages();
    for (const text of ['读一下 README.md 和 src/a.ts，然后详细介绍这个项目。', '再详细解释 add 函数，并给出三个使用例子。']) {
      await h.send(text);
      await h.idle(240000);
    }
    const stages = await h.stages();
    const notices = await page.getByText('Compacted session', { exact: true }).count();
    await compactedRing(page);
    record('8 一直在底部时不出现"有新内容"', await page.getByTestId('new-content').count() === 0);
    record('8 阶段行显示"正在压缩较早的对话"', stages.includes('Compacting session…'), stages.join(' → '));
    record('8 对话流留下"已压缩较早的对话"', notices >= 1, `${notices} 处`);
    await shot(page, '8-compaction');
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @brief 走查 8 的圆环（models.md"上下文用量（圆环）"）：对话流最后一项是"Compacted session"（压缩之后还没有新的回复）时，
 *        圆环为空、底圈虚线、没有 data-tokens，读屏名"Context window"、描述是"Just compacted. …"；
 *        最后一项是回复时圆环有用量，数与读屏名一致。
 */
async function compactedRing(page) {
  const last = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="transcript"] :is([data-testid="user-message"], '
      + '[data-testid="assistant"], [data-testid="notice"])')];
    return items.at(-1)?.textContent?.trim() ?? '';
  });
  const ring = await ringState(page);
  const compacted = last === 'Compacted session';
  const ok = compacted ? ring?.state === 'compacted' && ring.tokens === null && ring.label === 'Context window'
    && ring.desc === COMPACTED_NOTE && ringColorProblems(ring).length === 0
    : ringTextProblems(ring).length === 0;
  record(`8 圆环与压缩一致：对话流最后一项${compacted ? '是"Compacted session"，圆环为空、底圈虚线、读屏名"Context window"'
    : '是回复，圆环显示用量'}`, ok, `${oneLine(last, 60)} | ${JSON.stringify(ring)}`);
}

/** @brief 走查数据目录里首选提供商（DeepSeek）的非机密信息（v1：model-config.json，lib.mjs realProviders）。 */
function connectionInfo() {
  return realProviders(source)[0];
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
const pageErrors = [];
await relaunch(ctx);
try {
  const first = await step(ctx, '走查 1', () => item1(ctx));
  if (first) await step(ctx, '走查 2', () => item2(ctx));
  if (wanted(3)) await step(ctx, '走查 3', () => item3(ctx));
  if (wanted(4)) await step(ctx, '走查 4', () => item4(ctx));
  if (wanted(5)) await step(ctx, '走查 5', () => item5(ctx));
  if (wanted(7)) await step(ctx, '走查 7', () => item7(ctx));
  if (wanted(10)) await step(ctx, '走查 10', () => item10(ctx));
  if (wanted(9)) await step(ctx, '走查 9', () => item9(ctx));
  if (wanted(6)) await step(ctx, '走查 6 key 填错', () => item6(ctx));
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await ctx.app.close().catch(() => {});
}
if (wanted(8)) {
  await item8(project, ctx.connection).catch((error) => record('走查 8：流程', false, oneLine(error, 300)));
}
rmSync(userData, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
process.exitCode = write(`m1-real${suffix}.json`) ? 0 : 1;
