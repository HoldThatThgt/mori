// M1 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的会话，检查界面状态。
// 用法（在 app/ 下）：node tests/ui/m1-replay.mjs [--only readme,stop]
// 结果写到 test-results/m1-replay.json；截图在 test-results/m1-replay/。

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { layoutChecks } from './m1-layout.mjs';
import { pageHelpers } from './page.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness');
const shots = join(appRoot, 'test-results/m1-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
/** 重新载入后对话流里的说明（state/projects.ts RELOADED_NOTE） */
const RESTARTED_NOTE = 'Restarted · Queued messages, pending approvals, and “Allow for this session” choices '
  + 'weren’t restored';
/** 停止后对话流里的提示（Transcript.tsx） */
const STOPPED_NOTICE = 'Stopped · Changes made so far stay as they are';

/** @brief 构建回放页面。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 测试用的页面操作：共用的 pageHelpers 加上回放页面的载入。 */
function helpers(page) {
  const base = pageHelpers(page);
  return {
    ...base,
    async load(fixture, { speed = 1, maxGap = 1500 } = {}) {
      const url = `${pathToFileURL(join(outDir, 'index.html')).href}?fixture=${fixture}&speed=${speed}&maxGap=${maxGap}`;
      await page.goto(url);
      await page.getByTestId('open-folder').waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'Open folder…' }).first().click();
      await page.getByTestId('chat-pane').waitFor({ timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('[data-testid="not-ready"]'));
    },
    replayErrors: () => page.evaluate(() => window.__replay.status.errors),
  };
}

/** @brief 总结 README：等待→思考→工具→生成；思考流入时展开、之后收起；工具卡完成；上下文用量。 */
async function readmeCheck(page, h) {
  await h.load('readme');
  await h.sampleStages();
  await h.watchThinking();
  await h.send('总结一下 README.md');
  await h.idle();
  const stages = await h.stages();
  record('readme：阶段行先显示"等待模型响应"', stages[0]?.startsWith('Waiting for the model…'), stages.join(' → '));
  // 读取只用了约 4ms，采样抓不到；运行命令约 200ms。
  record('readme：阶段行出现思考中、运行命令、生成中',
    ['Thinking…', 'Run ls', 'Responding…'].every((part) => stages.some((s) => s.startsWith(part))), stages.join(' → '));
  record('readme：思考流入时展开', await h.thinkingOpened());
  const closed = await page.locator('details.thinking').evaluateAll((items) => items.length > 0 && items.every((d) => !d.open));
  record('readme：回复结束后思考收起', closed);
  const cards = await h.cards();
  record('readme：工具卡从执行中变为完成',
    cards.length === 3 && cards.every((c) => c.status === 'done' && c.text.startsWith('Done')),
    cards.map((c) => `${c.title}/${c.text}`).join('；'));
  await page.getByTestId('tool-card').nth(1).locator('summary').click();
  await page.getByTestId('tool-card').nth(1).locator('.tool-body').waitFor();
  const body = oneLine(await page.getByTestId('tool-card').nth(1).innerText(), 300);
  record('readme：展开读取卡能看到参数和输出', body.includes('Input') && body.includes('Mori fixture project'), body);
  const usage = await page.getByTestId('usage').getAttribute('title');
  record('readme：顶栏显示上下文用量', /About 2,130 \/ 1,000,000 tokens/.test(usage ?? ''), usage);
  record('readme：Markdown 渲染', await page.locator('.prose li, .prose strong, .prose p').count() > 0);
  record('readme：回放命令与录制一致', (await h.replayErrors()).length === 0, (await h.replayErrors()).join('; '));
  await page.screenshot({ path: join(shots, 'readme.png') });
}

/** @brief 只有 Markdown 的回复：标题、列表、表格、代码高亮；流式出现。 */
async function markdownCheck(page, h) {
  await h.load('markdown', { speed: 1 });
  await page.evaluate(() => {
    window.__newContentSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="new-content"]')) window.__newContentSeen = true;
    }).observe(document.body, { subtree: true, childList: true });
  });
  await page.evaluate(() => {
    window.__lengths = new Set();
    window.__lengthTimer = setInterval(() => {
      const text = document.querySelector('.prose')?.textContent;
      if (text) window.__lengths.add(text.length);
    }, 40);
  });
  await h.watchThinking();
  await h.send('不要调用任何工具。用 Markdown 回复：一个二级标题、一个三项列表、一个两列表格、一段 TypeScript 代码块，内容是介绍 add 函数。');
  await h.idle();
  const lengths = await page.evaluate(() => window.__lengths.size);
  record('markdown：正文是流式出现的', lengths > 3, `采样到 ${lengths} 种长度`);
  record('scroll：你在底部时一直跟随，不出现"有新内容"', !(await page.evaluate(() => window.__newContentSeen))
    && await page.getByTestId('transcript').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30));
  record('markdown：思考流入时展开，正文开始后收起', (await h.thinkingOpened())
    && await page.locator('details.thinking').evaluateAll((items) => items.every((d) => !d.open)));
  const counts = await page.evaluate(() => ({
    heading: document.querySelectorAll('.prose [data-streamdown="heading-2"]').length,
    items: document.querySelectorAll('.prose li').length,
    table: document.querySelectorAll('.prose table').length,
    tokens: document.querySelectorAll('.prose pre span[style*="--sdm-c"]').length,
  }));
  record('markdown：标题、列表、表格、代码高亮', counts.heading > 0 && counts.items >= 3 && counts.table > 0 && counts.tokens > 3,
    JSON.stringify(counts));
  await page.screenshot({ path: join(shots, 'markdown.png') });
}

/** @brief 失败的命令显示"Failed · Exit code N"，不显示"Done"。 */
async function commandFailCheck(page, h) {
  await h.load('command-fail', { speed: 2 });
  await h.send('运行命令 `ls does-not-exist-dir`，然后用一句话告诉我结果。');
  await h.idle();
  const cards = await h.cards();
  record('command-fail：失败的命令显示"失败 · 退出码"，不显示"完成"',
    cards.length === 1 && cards[0].status === 'failed' && /^Failed · Exit code \d+$/.test(cards[0].text),
    JSON.stringify(cards));
}

/** @brief 编辑：工具卡展开有 diff；右栏自动打开并列出文件。 */
async function editCheck(page, h) {
  await h.load('edit', { speed: 2 });
  await h.send('把 README.md 第一行的标题改成 `# Mori fixture project (edited)`，只改这一行。');
  await h.idle();
  const cards = await h.cards();
  const edit = cards.findIndex((card) => card.title.startsWith('Edit'));
  await page.getByTestId('tool-card').nth(edit).locator('summary').click();
  const diff = await page.getByTestId('tool-card').nth(edit).getByTestId('tool-diff').waitFor({ timeout: 5000 })
    .then(() => 1, () => 0);
  record('edit：修改卡完成，展开能看到 diff', edit >= 0 && cards[edit].status === 'done' && diff === 1, JSON.stringify(cards));
  const panel = page.getByTestId('right-panel');
  const listed = await panel.isVisible() && (await panel.innerText()).includes('README.md');
  record('edit：右栏自动打开并列出改动的文件，注明命令改动不在此列', listed
    && (await panel.innerText())
      .includes('Only edits and writes are listed. Files changed by commands aren’t included.'));
  await page.screenshot({ path: join(shots, 'edit.png') });
}

/** @brief 生成中插话、排队：先进排队区；插话在工具执行完后进入对话流，排队在本轮结束后。之后模拟后台进程退出并重新载入。 */
async function queueSteerCheck(page, h) {
  await h.load('queue-steer', { speed: 1 });
  await h.watchThinking();
  await h.send('运行命令 `sleep 8; echo done`，完成后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 20000 });
  await h.textarea.fill('插话：另外告诉我 README.md 有几行。');
  const buttons = await page.locator('.composer-bottom').innerText();
  record('queue：生成中有字时显示"停止"和"排队发送"', buttons.includes('Stop') && buttons.includes('Queue'), oneLine(buttons));
  await h.textarea.press('Control+Enter');
  await h.send('排队：最后用一句话总结你做了什么。');
  await page.waitForFunction(() => document.querySelector('[data-testid="queue"]')?.textContent?.includes('排队：最后'),
    null, { timeout: 10000 }).catch(() => {});
  const queue = await page.getByTestId('queue').innerText().catch(() => '');
  record('queue：插话和排队两条都先出现在排队区', queue.includes('插话') && queue.includes('排队：最后') && queue.includes('README.md 有几行'),
    oneLine(queue));
  await page.locator('[data-testid="user-message"]', { hasText: '插话：' }).waitFor({ timeout: 30000 });
  const atSteer = await h.cards();
  const queueAtSteer = await page.getByTestId('queue').innerText().catch(() => '');
  record('queue：插话在本轮工具执行完后进入对话流', atSteer[0]?.status === 'done' && queueAtSteer.includes('排队：最后')
    && !queueAtSteer.includes('插话'), `${JSON.stringify(atSteer)} | 排队区：${oneLine(queueAtSteer)}`);
  await h.idle();
  const users = await page.getByTestId('user-message').allInnerTexts();
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant"]')]
    .map((element) => (element.dataset.testid === 'user-message' ? 'U' : 'A')).join(''));
  record('queue：排队的消息在本轮结束后进入对话流', users.length === 3 && users[2].startsWith('排队：') && order.endsWith('UA'), order);
  record('queue：思考流入时展开，之后收起', await h.thinkingOpened()
    && await page.locator('details.thinking').evaluateAll((items) => items.every((d) => !d.open)));
  record('queue：回放命令与录制一致（插话用 steer，排队用 followUp）', (await h.replayErrors()).length === 0,
    (await h.replayErrors()).join('; '));
  await reloadCheck(page, h);
}

/** @brief 模拟后台进程退出：提示与"Restart"，草稿保留；重新载入后按会话记录重画。 */
async function reloadCheck(page, h) {
  await h.textarea.fill('这是一段还没发出的草稿');
  await page.evaluate(() => window.__replay.exit(1));
  const banner = await page.getByTestId('kernel-exit').innerText().catch(() => '');
  record('reload：显示"Mori 的后台进程意外退出 · 刚才没完成的回复已中断"和"重新载入"',
    banner.includes('Mori’s background process crashed · Unfinished responses were interrupted')
    && banner.includes('Restart'), oneLine(banner));
  record('reload：输入框显示后台进程已退出，不能发送',
    (await page.getByTestId('not-ready').innerText()) === 'Mori’s background process crashed');
  await page.screenshot({ path: join(shots, 'kernel-exit.png') });
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText(RESTARTED_NOTE).waitFor({ timeout: 10000 });
  const users = await page.getByTestId('user-message').count();
  const cards = await h.cards();
  record('reload：从会话记录恢复对话（3 条你的消息、工具卡完成且不显示耗时）', users === 3
    && cards.every((c) => c.status === 'done' && c.text === 'Done'), `${users} 条；${JSON.stringify(cards)}`);
  record('reload：草稿还在', (await h.textarea.inputValue()) === '这是一段还没发出的草稿');
}

/** @brief 一条回复里两个工具调用时插话：两个调用都执行完，插话才送达；没有"已跳过"。 */
async function twoToolsCheck(page, h) {
  await h.load('two-tools-steer', { speed: 1 });
  await h.send('请在同一条回复里同时调用两次 bash：第一次运行 `sleep 3; echo first`，第二次运行 `echo second`。两个都完成后告诉我结果。');
  await page.getByTestId('tool-card').first().waitFor({ timeout: 20000 });
  await h.send('插话：结果用英文写。', 'Control+Enter');
  await h.idle();
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="user-message"], [data-testid="tool-card"]')]
    .map((element) => (element.dataset.testid === 'tool-card' ? `T:${element.dataset.status}` : 'U')).join(' '));
  record('steer：两个工具调用都执行完后插话才送达（不跳过）', order === 'U T:done T:done U', order);
}

/** @brief 停止：Esc 先关菜单；再按 Esc 时先撤回排队、再停止；命令卡"Stopped"，提示文字，排队消息回到输入框。 */
async function stopCheck(page, h) {
  await h.load('stop', { speed: 1 });
  await h.send('运行命令 `sleep 30; echo late`，然后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 20000 });
  await h.textarea.fill('排队：这条会被撤回');
  await page.getByRole('button', { name: 'More send options' }).click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  const menuClosed = await page.getByRole('menu').count() === 0;
  const stillRunning = await page.locator('.stop-button').count() === 1;
  record('stop：有菜单时 Esc 只关菜单，不停止', menuClosed && stillRunning);
  await h.textarea.press('Enter');
  await page.getByTestId('queue').waitFor();
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await h.idle();
  const cards = await h.cards();
  const notice = await page.getByText(STOPPED_NOTICE).count();
  const errors = await page.getByTestId('error-card').count();
  record('stop：命令卡显示"已停止"，并提示修改不会自动撤销', cards[0]?.status === 'stopped' && cards[0].text === 'Stopped' && notice === 1,
    JSON.stringify(cards));
  record('stop：不把停止当成错误显示', errors === 0);
  record('stop：排队消息回到输入框', (await h.textarea.inputValue()).includes('排队：这条会被撤回'));
  record('stop：先撤回排队（clearQueue）再停止（abort）', (await h.replayErrors()).length === 0, (await h.replayErrors()).join('; '));
  await page.screenshot({ path: join(shots, 'stop.png') });
  await page.evaluate(() => window.__replay.exit(1));
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText('Restarted', { exact: false }).first().waitFor({ timeout: 10000 });
  const reloaded = await h.cards();
  record('stop：从会话记录重新打开后，停止的命令仍显示"已停止"、提示仍在、没有错误卡',
    reloaded[0]?.status === 'stopped' && await page.getByText(STOPPED_NOTICE).count() === 1
      && await page.getByTestId('error-card').count() === 0, JSON.stringify(reloaded));
}

/**
 * @brief 没有 key 时的顶栏（chat.md 顶栏"模型"、models.md"没有可用模型"，M1 起）：模型按钮"No models available"，
 *        pi 给出的说明（录制里 session.create 的 modelNotice，"No models available. Use /login …"）显示在会话里；
 *        M6 起不显示思考按钮。模型按钮也写"No models available"，所以说明按 pi 的整句开头找。
 */
async function noModelTopBar(page) {
  const top = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="chat-pane"]');
    return { model: pane?.querySelector('[data-testid="model-button"]')?.textContent?.trim() ?? null,
      thinking: pane?.querySelectorAll('[data-testid="thinking-button"]').length ?? null,
      notice: pane?.textContent?.includes('No models available. Use /login') ?? false };
  });
  record('no-key：没有可用模型时顶栏模型按钮显示"没有可用模型"、不显示思考按钮，会话里显示 pi 给出的说明',
    top.model?.includes('No models available') && top.thinking === 0 && top.notice, JSON.stringify(top));
}

/**
 * @brief 没有 key：顶栏"No models available"；发送时就失败，原文 + "Go to settings"；点它进设置页的"Edit connection"
 *        且焦点在 API key。
 */
async function noKeyCheck(page, h) {
  await h.load('no-key');
  await noModelTopBar(page);
  await h.send('你好');
  const card = page.getByTestId('error-card');
  await card.waitFor({ timeout: 10000 });
  const text = await card.innerText();
  record('no-key：显示找不到 key 的原文和"去设置"', text.includes('No API key found') && text.includes('Go to settings'),
    oneLine(text));
  await card.getByRole('button', { name: 'Go to settings' }).click();
  await page.getByTestId('settings-page').waitFor();
  // settings.md 外框："Go to settings"打开"Edit connection"，焦点在 API key。会话没有可用模型（pi 的占位模型 unknown/unknown），
  // 回放里只有一个连接（synthetic，harness 按录制的端点拼出），应打开它。
  const focus = await h.keyFocus();
  record('no-key："去设置"打开设置页里那个连接的"编辑连接"，焦点在 API key 框',
    focus.type === 'password' && focus.inForm && /^Edit connection · /.test(focus.title ?? ''), JSON.stringify(focus));
  await page.screenshot({ path: join(shots, 'no-key-settings.png') });
  await page.getByRole('button', { name: 'Back to app' }).click();
  record('no-key：返回会话后错误卡还在', await page.getByTestId('error-card').isVisible());
}

/** @brief key 填错：模型回复 401，原文 + "Go to settings"。 */
async function wrongKeyCheck(page, h) {
  await h.load('wrong-key');
  await h.send('你好');
  const card = page.getByTestId('error-card');
  await card.waitFor({ timeout: 10000 });
  const text = await card.innerText();
  record('wrong-key：显示 401 原文和"去设置"', text.includes('401') && text.includes('Go to settings')
    && !text.includes('Put your last message back'),
    oneLine(text));
  await page.screenshot({ path: join(shots, 'wrong-key.png') });
}

/** @brief 压缩：阶段行"Compacting session…"，对话流留下"Compacted session"；你不在底部时"Jump to latest"。 */
async function compactionCheck(page, h) {
  await h.load('compaction', { speed: 4, maxGap: 300 });
  await h.sampleStages();
  const asks = ['读一下 README.md 和 src/a.ts，然后详细介绍这个项目。', '再详细解释 add 函数，并给出三个使用例子。',
    '把上面的内容整理成一份 Markdown 文档的大纲。', '最后用三句话总结我们聊了什么。'];
  await h.send(asks[0]);
  await h.idle();
  await h.send(asks[1]);
  await sleep(200);
  await page.getByTestId('transcript').evaluate((element) => { element.scrollTop = 0; });
  const sawNew = await page.getByTestId('new-content').waitFor({ timeout: 20000 }).then(() => true, () => false);
  record('scroll：不在底部时显示"有新内容 ↓"，不自动滚动', sawNew
    && await page.getByTestId('transcript').evaluate((element) => element.scrollTop < 50));
  if (sawNew) await page.getByTestId('new-content').click();
  const atBottom = await page.getByTestId('transcript').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30);
  record('scroll：点"有新内容 ↓"回到底部并继续跟随', atBottom);
  await h.idle();
  for (const text of asks.slice(2)) {
    await h.send(text);
    await h.idle();
  }
  const stages = await h.stages();
  record('compaction：阶段行显示"正在压缩较早的对话"', stages.includes('Compacting session…'), stages.slice(0, 12).join(' → '));
  const notices = await page.getByText('Compacted session', { exact: true }).count();
  record('compaction：对话流留下"已压缩较早的对话"', notices >= 1, `${notices} 处`);
  const failed = page.getByTestId('error-card').filter({ hasText: 'Summarization failed' }).first();
  const failText = await failed.innerText().catch(() => '');
  record('compaction：压缩失败显示原文和"把上一条消息放回输入框"',
    failText.includes('Put your last message back in the message box'), oneLine(failText));
  await failed.getByRole('button', { name: 'Put your last message back in the message box' }).click();
  record('compaction：点它把上一条消息放回输入框', (await h.textarea.inputValue()).length > 0, await h.textarea.inputValue());
  await page.screenshot({ path: join(shots, 'compaction.png') });
}

/** @brief 长会话：先显示最近 50 条，滚到顶部载入更早的，当前看到的内容不跳动（synthetic 拼出的会话记录）。 */
async function longHistoryCheck(page, h) {
  await h.load('synthetic-long-history');
  await page.evaluate(() => window.__replay.exit(1));
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText('Restarted', { exact: false }).first().waitFor({ timeout: 10000 });
  const count = () => page.locator('[data-testid="user-message"], [data-testid="assistant"]').count();
  const first = await count();
  const hint = await page.getByText('Scroll up to load earlier messages').count();
  const anchor = page.getByTestId('user-message').first();
  const label = await anchor.innerText();
  // 先停在离顶部 60px 处量一次位置（还不会触发载入），再滚到顶部触发载入。
  await page.getByTestId('transcript').evaluate((element) => { element.scrollTop = 60; });
  await sleep(300);
  const before = await anchor.boundingBox();
  await page.getByTestId('transcript').evaluate((element) => { element.scrollTop = 0; });
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant"]').length > n,
    first, { timeout: 5000 }).catch(() => {});
  const second = await count();
  await sleep(1500);
  const top = await page.getByTestId('user-message').filter({ hasText: label }).first().boundingBox();
  record('history：先显示最近 50 条，滚到顶部再载入 50 条', first === 50 && hint === 1 && second === 100, `${first} → ${second}`);
  // 滚到顶部时它下移 60px；载入后应停在那里（容差 30px）。
  record('history：载入更早的消息时看到的内容不跳动', top !== null && Math.abs(top.y - (before.y + 60)) < 30,
    `载入前 y=${before?.y}，载入后 y=${top?.y}`);
}

const checks = { readme: readmeCheck, markdown: markdownCheck, 'command-fail': commandFailCheck, edit: editCheck,
  'queue-steer': queueSteerCheck, 'two-tools-steer': twoToolsCheck, stop: stopCheck, 'no-key': noKeyCheck,
  'wrong-key': wrongKeyCheck, compaction: compactionCheck, history: longHistoryCheck, layout: layoutChecks };

await buildHarness();
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
  env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
    MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-')) } });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
const h = helpers(page);
for (const [name, check] of Object.entries(checks)) {
  if (only && !only.includes(name)) continue;
  try {
    await check(page, h, { app, record, shots, helpers: h });
  } catch (error) {
    record(`${name}：流程`, false, oneLine(error, 400));
    await page.screenshot({ path: join(shots, `${name}-error.png`) }).catch(() => {});
  }
}
record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
await app.close();
process.exitCode = write('m1-replay.json') ? 0 : 1;
