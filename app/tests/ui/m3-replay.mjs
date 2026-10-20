// M3 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的会话（tests/fixtures/m3）。
// 测试像你一样操作（打开文件夹、Ctrl+N、右键菜单和 Shift+F10、改名框、归档、删除确认框、信任询问、Alt+1、
// 扩展询问卡上的按钮和输入框），回放桥核对界面发出的每条命令（文件夹、会话文件、信任回答、名字、询问的回答）
// 都与录制时一致；再按 docs/v0/screens/sessions.md 与 extension-ui.md 的状态表检查侧栏、顶栏、横幅和对话流。
// M1/M2 的回放检查仍由 m1-replay、m2-replay 负责。
// 用法（在 app/ 下）：node tests/ui/m3-replay.mjs [--only two-projects,trust-deny]
// 结果写到 test-results/m3-replay.json；截图在 test-results/m3-replay/。

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { pageHelpers } from './page.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-m3');
const fixtureDir = join(appRoot, 'tests/fixtures/m3');
const shots = join(appRoot, 'test-results/m3-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 当前会话面板 */
const P = '.pane-slot:not([hidden]) ';
/** 没有名字时会话名取第一条消息的前几个字（与 ChatPane.tsx 的 TITLE_LENGTH 相同） */
const TITLE_LENGTH = 20;
const UNTRUSTED = '没有信任这个文件夹，它自带的扩展和配置没有加载';
const PICK_HINT = '从左侧选一个会话继续，或打开一个文件夹开始新的会话。';
const HELLO_TOOL = 'project_hello';

/** @brief 读取一个 M3 录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
/** @brief 录制里界面发出的命令（只读查询除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (fx) => fx.steps.filter((s) => s.command
  && !['session.state', 'session.list', 'trust.check'].includes(s.command.type)).map((s) => s.command);
/** @brief 录制里某种命令的成功结果。 */
const valuesOf = (fx, type) => fx.steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
/** @brief 录制里某种事件。 */
const eventsOf = (fx, type) => fx.steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);
/** @brief 显示的会话名：名字；没有时第一条消息的前 20 个字，超出加"…"（sessions.md"会话名"）。 */
function titleOf(name, first) {
  if (name) return name;
  const text = first.replace(/\s+/g, ' ').trim();
  return [...text].length > TITLE_LENGTH ? `${[...text].slice(0, TITLE_LENGTH).join('')}…` : text;
}

/** @brief 构建回放页面（与 m1/m2 回放用不同的输出目录）。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 侧栏的项目和会话行：文件夹、会话文件、标题、是否当前、状态。 */
function treeInfo(page) {
  return page.evaluate(() => [...document.querySelectorAll('.project-group')].map((group) => ({
    cwd: group.dataset.cwd,
    rows: [...group.querySelectorAll('.session-item')].map((row) => ({
      file: row.dataset.file, title: row.querySelector('.session-label')?.textContent ?? '',
      active: row.classList.contains('active'),
      status: row.querySelector('[data-testid="session-status"]')?.dataset.status ?? null })),
  })));
}

/** @brief 某个会话文件的会话行。 */
const rowOf = (page, file) => page.locator(`.session-item[data-file="${file.replace(/\\/g, '\\\\')}"]`);

/** @brief 等回放桥的 status[field] 不小于 value；出现不一致时立即报错。 */
async function untilBridge(page, field, value, what) {
  await page.waitForFunction(({ f, v }) => window.__replay.status[f] >= v || window.__replay.status.errors.length > 0,
    { f: field, v: value }, { timeout: 60000 }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 等当前会话空闲：本轮结束，输入框可以发送。 */
function untilIdle(page, timeout = 60000) {
  return page.waitForFunction((p) => {
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="not-ready"]');
  }, P, { timeout });
}

/** @brief 等当前会话打开好（不再"正在启动…"）。 */
function untilReady(page) {
  return page.waitForFunction((p) => document.querySelector(`${p}[data-testid="chat-pane"]`)
    && !document.querySelector(`${p}[data-testid="not-ready"]`), P, { timeout: 30000 });
}

/** @brief 测试用的页面操作：共用的 pageHelpers 加上回放页面的载入。 */
function helpers(page) {
  return {
    ...pageHelpers(page),
    /** @brief 载入录制文件，等侧栏读完会话列表；返回录制文件内容。 */
    async load(name, { speed = 3, maxGap = 1000 } = {}) {
      const fx = readFixture(name);
      const url = `${pathToFileURL(join(outDir, 'index.html')).href}?fixture=${name}&speed=${speed}&maxGap=${maxGap}`;
      await page.goto(url);
      await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
      return fx;
    },
    /** @brief 点"打开文件夹…"（回放桥返回下一条 session.create 的文件夹）。 */
    async openFolder() {
      await page.getByTestId('sidebar').getByRole('button', { name: '打开文件夹…' }).click();
    },
    replayErrors: () => page.evaluate(() => window.__replay.status.errors),
    bridge: () => page.evaluate(() => ({ cursor: window.__replay.status.cursor, deleted: window.__replay.status.deleted,
      queries: window.__replay.status.queries.map((q) => q.type) })),
  };
}

/** @brief 收尾的共同检查：回放桥没有不一致，录制里的命令全部用上了。 */
async function finish(page, h, name, fx) {
  const total = commandsOf(fx).length;
  await untilBridge(page, 'played', total, `all ${total} commands of ${name}`);
  const errors = await h.replayErrors();
  record(`${name}：界面发出的命令与录制一致（${total} 条），没有多发或少发`, errors.length === 0
    && (await h.bridge()).cursor === total, errors.join('; '));
}

/** @brief 发一条消息并等本轮结束。 */
async function sendAndWait(page, h, text) {
  await h.send(text);
  await untilIdle(page);
}

// ---------- 两个文件夹各两个会话 ----------

/** @brief 走查 1：两个文件夹各建两个会话并各发一条消息；侧栏按项目分组、名字取前 20 个字、从新到旧。 */
async function twoProjects(page, h) {
  const fx = await h.load('two-projects');
  const prompts = commandsOf(fx).filter((c) => c.type === 'session.prompt').map((c) => c.text);
  const made = valuesOf(fx, 'session.create');
  record('two-projects：没有会话时中栏只说"选择一个项目文件夹开始对话。"', (await page.getByTestId('open-folder')
    .innerText()).includes('选择一个项目文件夹开始对话。'));
  for (const [index, text] of prompts.entries()) {
    if (index % 2 === 0) await h.openFolder();
    else await page.keyboard.press('Control+N');
    await untilReady(page);
    await sendAndWait(page, h, text);
  }
  const tree = await treeInfo(page);
  const expected = [[made[3].cwd, [3, 2]], [made[0].cwd, [1, 0]]];
  const groupsOk = tree.length === 2 && expected.every(([cwd, order], index) => tree[index]?.cwd === cwd
    && order.every((at, row) => tree[index].rows[row]?.title === titleOf(null, prompts[at])
      && tree[index].rows[row]?.file === made[at].sessionFile));
  record('two-projects：侧栏按项目（工作目录）分组；会话名取第一条消息的前 20 个字加"…"；项目和会话都从新到旧',
    groupsOk, JSON.stringify(tree));
  record('two-projects：当前会话高亮，可见时结束的会话没有状态点', tree.flatMap((g) => g.rows)
    .filter((row) => row.active).length === 1 && tree.flatMap((g) => g.rows).every((row) => row.status === null));
  const title = await page.locator(`${P}[data-testid="session-title"]`).innerText();
  record('two-projects：顶栏的会话名与会话行相同', title === titleOf(null, prompts[3]), title);
  await shot(page, 'two-projects');
  await finish(page, h, 'two-projects', fx);
}

// ---------- 改名 ----------

/** @brief 在会话行上用 Shift+F10 打开菜单，选"重命名"，写名字后按 Enter。 */
async function renameByKeys(page, file, name) {
  await rowOf(page, file).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('session-menu').waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  const prefilled = await input.inputValue();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await input.waitFor({ state: 'detached', timeout: 10000 });
  return prefilled;
}

/** @brief 打开中的会话改名：Shift+F10 → 重命名 → Enter；侧栏和顶栏显示新名字（pi 的 session_info_changed）。 */
async function renameOpen(page, h) {
  const fx = await h.load('rename');
  const [prompt, rename] = commandsOf(fx).filter((c) => c.type !== 'session.create');
  const [created] = valuesOf(fx, 'session.create');
  await h.openFolder();
  await untilReady(page);
  await sendAndWait(page, h, prompt.text);
  const prefilled = await renameByKeys(page, created.sessionFile, rename.name);
  await untilBridge(page, 'played', 3, 'session.rename');
  await sleep(300);
  const row = (await treeInfo(page))[0]?.rows[0];
  const title = await page.locator(`${P}[data-testid="session-title"]`).innerText();
  record('rename：改名框预先填好第一条消息的前 20 个字（不带"…"）', prefilled === [...prompt.text].slice(0, 20).join(''),
    prefilled);
  record('rename：保存后侧栏和顶栏显示新名字，焦点回到会话行', row?.title === rename.name && title === rename.name
    && await page.evaluate(() => document.activeElement?.classList.contains('session-item')),
  `${row?.title} / ${title}`);
  await shot(page, 'rename');
  await finish(page, h, 'rename', fx);
}

/** @brief 重启之后：会话列表里有上次的会话；没打开就改名（按会话文件），再点开：名字和对话都在。 */
async function renameUnopened(page, h) {
  const fx = await h.load('rename-unopened');
  const [start] = valuesOf(fx, 'session.list');
  const saved = start[0];
  const rename = commandsOf(fx).find((c) => c.type === 'session.rename');
  const hint = await page.getByTestId('open-folder').innerText();
  const first = (await treeInfo(page))[0]?.rows[0];
  record('rename-unopened：启动后侧栏列出上次的会话（名字取第一条消息），中栏说明"从左侧选一个会话继续……"',
    first?.file === saved.sessionFile && first.title === titleOf(saved.name, saved.firstMessage)
    && hint.includes(PICK_HINT), `${JSON.stringify(first)}；${oneLine(hint)}`);
  await rowOf(page, saved.sessionFile).click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: '重命名' }).click();
  await page.getByTestId('rename-input').fill(rename.name);
  await page.keyboard.press('Enter');
  await untilBridge(page, 'played', 1, 'session.rename');
  await page.waitForFunction(({ file, name }) => [...document.querySelectorAll('.session-item')]
    .some((row) => row.dataset.file === file && row.textContent.includes(name)), { file: saved.sessionFile,
    name: rename.name }, { timeout: 10000 });
  record('rename-unopened：没打开的会话改名后侧栏显示新名字（重新读取的列表），右键菜单没有切换当前会话',
    await page.locator('.pane-slot').count() === 0);
  await rowOf(page, saved.sessionFile).click();
  await untilReady(page);
  const text = await page.locator(`${P}[data-testid="chat-pane"]`).innerText();
  const title = await page.locator(`${P}[data-testid="session-title"]`).innerText();
  const replies = await page.locator(`${P}[data-testid="assistant"]`).count();
  record('rename-unopened：点开后顶栏是新名字，完整对话都在（你的消息和助手回复）', title === rename.name
    && text.includes(saved.firstMessage) && replies > 0, `${title}；回复 ${replies} 条；${oneLine(text, 160)}`);
  await shot(page, 'rename-unopened');
  await finish(page, h, 'rename-unopened', fx);
}

// ---------- 删除 ----------

/** @brief 删除：右键 → 删除 → 确认框（焦点在"取消"）→ 删除；先关闭会话再永久删除会话文件，侧栏不再有它。 */
async function deleteCheck(page, h) {
  const fx = await h.load('delete');
  const prompt = commandsOf(fx).find((c) => c.type === 'session.prompt');
  const [created] = valuesOf(fx, 'session.create');
  await h.openFolder();
  await untilReady(page);
  await sendAndWait(page, h, prompt.text);
  await rowOf(page, created.sessionFile).click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: '删除' }).click();
  const dialog = page.getByTestId('delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  const focus = await page.evaluate(() => document.activeElement?.textContent);
  record('delete：确认框"永久删除会话\'名字\'？"和"对话记录会被删除，无法恢复。"，焦点在"取消"',
    text.includes(`永久删除会话'${titleOf(null, prompt.text)}'？`) && text.includes('对话记录会被删除，无法恢复。')
    && focus === '取消', `${oneLine(text)}；焦点 ${focus}`);
  await shot(page, 'delete-dialog');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  await untilBridge(page, 'played', 3, 'session.close');
  await page.waitForFunction(() => document.querySelectorAll('.session-item').length === 0, null, { timeout: 10000 });
  const bridge = await h.bridge();
  record('delete：先在后台进程关闭会话（session.close），再由主进程永久删除会话文件；侧栏不再有它，'
    + '中栏回到"打开一个文件夹"', bridge.deleted.length === 1 && bridge.deleted[0] === created.sessionFile
    && await page.getByTestId('open-folder').isVisible(), JSON.stringify(bridge.deleted));
  await finish(page, h, 'delete', fx);
}

// ---------- 项目信任 ----------

/** @brief 打开文件夹，等信任询问出现，检查内容与焦点；返回询问框。 */
async function trustDialog(page, h, name, cwd) {
  await h.openFolder();
  const dialog = page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 15000 });
  const text = await dialog.innerText();
  const focus = await page.evaluate(() => document.activeElement?.textContent);
  const box = await dialog.getByRole('checkbox').isChecked();
  record(`${name}：先弹信任询问："信任这个文件夹？"、方案原文、完整路径、"记住"没勾，焦点在"不信任"`,
    text.includes('信任这个文件夹？') && text.includes('这个文件夹带有自己的扩展或配置，信任后它们会在你的电脑上运行。')
    && await dialog.getByTestId('trust-path').innerText() === cwd && !box && focus === '不信任', oneLine(text));
  record(`${name}：回答之前会话还没打开（按钮位置"正在启动…"），后台进程只收到了 trust.check`,
    await page.locator(`${P}[data-testid="not-ready"]`).innerText() === '正在启动…' && (await h.bridge()).cursor === 0);
  return dialog;
}

/** @brief 不信任：横幅说没有加载、重启后会再问；问模型能用哪些工具，回答里没有 project_hello。 */
async function trustDeny(page, h) {
  const fx = await h.load('trust-deny');
  const [created] = valuesOf(fx, 'session.create');
  const prompt = commandsOf(fx).find((c) => c.type === 'session.prompt');
  const dialog = await trustDialog(page, h, 'trust-deny', created.cwd);
  await shot(page, 'trust-dialog');
  await dialog.getByRole('button', { name: '不信任' }).click();
  await untilReady(page);
  const banner = await page.locator(`${P}[data-testid="trust-banner"]`).innerText();
  record('trust-deny：横幅"没有信任这个文件夹，它自带的扩展和配置没有加载"，说明"重启 Mori 后会再问"；焦点回到输入框',
    banner.startsWith(UNTRUSTED) && banner.includes('重启 Mori 后会再问')
    && await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), banner);
  await sendAndWait(page, h, prompt.text);
  const reply = await page.locator(`${P}[data-testid="chat-pane"]`).innerText();
  record('trust-deny：项目扩展注册的工具不出现（会话信息和模型的回答里都没有 project_hello）',
    !created.tools.includes(HELLO_TOOL) && !reply.toLowerCase().includes(HELLO_TOOL), oneLine(reply, 300));
  await shot(page, 'trust-deny');
  await finish(page, h, 'trust-deny', fx);
}

/** @brief 让模型调用 project_hello：批准卡标题为工具原名，Alt+1 允许，工具卡完成。 */
async function helloCard(page, h, name, fx) {
  const prompt = commandsOf(fx).find((c) => c.type === 'session.prompt');
  const [request] = eventsOf(fx, 'mori.approval_request');
  await h.send(prompt.text);
  const card = page.locator(`${P}[data-testid="approval-card"][data-request="${request.requestId}"]`);
  await card.waitFor({ timeout: 30000 });
  record(`${name}：调用项目扩展的工具时出批准卡，标题为工具原名 project_hello`, await card.getAttribute('data-tool')
    === HELLO_TOOL && (await card.innerText()).includes(HELLO_TOOL));
  await h.textarea.focus();
  await page.keyboard.press('Alt+1');
  await untilIdle(page);
  const tool = page.locator(`${P}[data-testid="tool-card"]`).filter({ hasText: HELLO_TOOL }).first();
  record(`${name}：Alt+1 允许后工具卡完成`, await tool.getAttribute('data-status') === 'done');
}

/** @brief 信任并记住：没有横幅；project_hello 可以用。 */
async function trustAllow(page, h) {
  const fx = await h.load('trust-allow');
  const [created] = valuesOf(fx, 'session.create');
  const dialog = await trustDialog(page, h, 'trust-allow', created.cwd);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '信任', exact: true }).click();
  await untilReady(page);
  record('trust-allow：信任后没有"没有信任"的横幅，会话信息里有 project_hello',
    await page.locator(`${P}[data-testid="trust-banner"]`).count() === 0 && created.tools.includes(HELLO_TOOL));
  await helloCard(page, h, 'trust-allow', fx);
  await shot(page, 'trust-allow');
  await finish(page, h, 'trust-allow', fx);
}

/** @brief 重启之后：记住了信任的文件夹，点开里面的会话不再问，project_hello 可以用。 */
async function trustRemembered(page, h) {
  const fx = await h.load('trust-remembered');
  const [saved] = valuesOf(fx, 'session.list')[0];
  await rowOf(page, saved.sessionFile).click();
  await untilReady(page);
  record('trust-remembered：点开记住了信任的文件夹里的会话，不弹询问，没有横幅，对话还在',
    await page.getByTestId('trust-dialog').count() === 0 && await page.locator(`${P}[data-testid="trust-banner"]`)
      .count() === 0 && (await page.locator(`${P}[data-testid="chat-pane"]`).innerText()).includes(saved.firstMessage));
  await helloCard(page, h, 'trust-remembered', fx);
  await finish(page, h, 'trust-remembered', fx);
}

// ---------- 后台生成与"有新结果" ----------

/** @brief 走查 7：A 生成中按 Ctrl+N 切到新会话 B：A 显示"生成中"；B 先结束，A 不可见时结束后显示"有新结果"，点开消失。 */
async function background(page, h) {
  const fx = await h.load('background');
  const prompts = commandsOf(fx).filter((c) => c.type === 'session.prompt');
  const [a] = valuesOf(fx, 'session.create');
  await h.openFolder();
  await untilReady(page);
  await h.send(prompts[0].text);
  await untilBridge(page, 'played', 2, 'A prompt');
  await page.keyboard.press('Control+N');
  await untilReady(page);
  const running = await page.evaluate((file) => document.querySelector(`.session-item[data-file="${CSS.escape(file)}"]`)
    ?.querySelector('[data-testid="session-status"]')?.textContent, a.sessionFile);
  record('background：生成中的会话切走后，侧栏显示"生成中"', running === '生成中', String(running));
  await h.send(prompts[1].text);
  await page.waitForFunction((file) => document.querySelector(`.session-item[data-file="${CSS.escape(file)}"]`)
    ?.querySelector('[data-status="unseen"]'), a.sessionFile, { timeout: 120000 });
  record('background：不可见的会话结束后显示"有新结果"', true);
  await shot(page, 'background-unseen');
  await rowOf(page, a.sessionFile).click();
  await sleep(300);
  const after = await page.evaluate((file) => document.querySelector(`.session-item[data-file="${CSS.escape(file)}"]`)
    ?.querySelector('[data-testid="session-status"]')?.textContent ?? null, a.sessionFile);
  record('background：点开后"有新结果"消失', after === null, String(after));
  await finish(page, h, 'background', fx);
}

// ---------- 归档 ----------

/**
 * @brief 在会话行上右键，返回菜单项：文字、是否不可用、旁边的小字。菜单保持打开。
 *        M5 加的"引用到当前会话""在右侧分屏打开"由 M5 的测试检查，这里不含它们。
 */
async function menuItems(page, file) {
  await rowOf(page, file).click({ button: 'right' });
  const menu = page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  const items = await menu.getByRole('menuitem').evaluateAll((elements) => elements.map((item) => ({
    label: item.firstChild?.textContent ?? '', disabled: item.disabled,
    hint: item.querySelector('.menu-hint')?.textContent ?? null })));
  return items.filter((item) => !['引用到当前会话', '在右侧分屏打开'].includes(item.label));
}

/** @brief 菜单项的简短写法，例如"重命名 / 归档(还没有消息) / 删除"。 */
const menuText = (items) => items.map((item) => `${item.label}${item.disabled ? `(${item.hint})` : ''}`).join(' / ');

/** @brief 本机记下的已归档会话文件。 */
const archivedFiles = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mori.archived') ?? '[]'));

/** @brief 某个会话行的状态文字；没有时为 null。 */
const statusTextOf = (page, file) => page.evaluate((target) => [...document.querySelectorAll('.session-item')]
  .find((row) => row.dataset.file === target)?.querySelector('[data-testid="session-status"]')?.textContent ?? null,
file);

/** @brief 归档前：还没有消息时"归档"不可用；发过消息后三项都能用，选"归档"不确认。 */
async function archiveMenu(page, h, fx) {
  const prompt = commandsOf(fx).find((c) => c.type === 'session.prompt');
  const [created] = valuesOf(fx, 'session.create');
  await h.openFolder();
  await untilReady(page);
  const early = await menuItems(page, created.sessionFile);
  await page.keyboard.press('Escape');
  record('archive：还没有消息的新会话，菜单"重命名、归档、删除"，"归档"不可用、旁边小字"还没有消息"',
    menuText(early) === '重命名 / 归档(还没有消息) / 删除', menuText(early));
  await sendAndWait(page, h, prompt.text);
  const items = await menuItems(page, created.sessionFile);
  record('archive：发过消息、已经结束的会话，菜单三项都能用', menuText(items) === '重命名 / 归档 / 删除', menuText(items));
  await page.getByTestId('session-menu').getByRole('menuitem', { name: '归档' }).click();
  await untilBridge(page, 'played', 3, 'session.close');
  await page.getByTestId('archived-toggle').waitFor({ timeout: 10000 });
  return { created, prompt };
}

/** @brief 归档：右键 → 归档，不确认；会话行移到底部"已归档 1"，展开后在已归档列表里；右键"恢复"回到项目下。 */
async function archiveCheck(page, h) {
  const fx = await h.load('archive');
  const { created, prompt } = await archiveMenu(page, h, fx);
  const toggle = page.getByTestId('archived-toggle');
  const dialogs = await page.locator('[data-testid="delete-dialog"], [role="dialog"]').count();
  const focus = await page.evaluate(() => document.activeElement?.dataset.testid ?? document.activeElement?.tagName);
  record('archive：不弹确认框，先在后台进程关闭会话（session.close）；会话行离开项目，侧栏底部"已归档 1"（默认收起），'
    + '中栏回到"打开一个文件夹"，焦点落在"新会话"（没有别的会话行）', dialogs === 0 && (await treeInfo(page)).length === 0
    && await toggle.innerText() === '已归档 1' && await toggle.getAttribute('aria-expanded') === 'false'
    && await page.getByTestId('archived-list').count() === 0 && await page.getByTestId('open-folder').isVisible()
    && focus === 'new-session', `对话框 ${dialogs}；${await toggle.innerText()}；焦点 ${focus}`);
  record('archive：已归档列表记在本机（localStorage 的 mori.archived）',
    JSON.stringify(await archivedFiles(page)) === JSON.stringify([created.sessionFile]));
  await shot(page, 'archive');
  await toggle.click();
  const row = page.locator(`[data-testid="archived-list"] .session-item.archived[data-file="${
    created.sessionFile.replace(/\\/g, '\\\\')}"]`);
  const hover = await row.getAttribute('title', { timeout: 5000 }).catch(() => null);
  const folder = created.cwd.split(/[\\/]/).pop();
  record('archive：展开后列出它，行是会话名，悬停显示文件夹和完整名字', await row.count() === 1
    && await row.locator('.session-label').innerText() === titleOf(null, prompt.text)
    && Boolean(hover?.includes(folder) && hover.includes(prompt.text)), String(hover));
  const items = await menuItems(page, created.sessionFile);
  record('archive：已归档的会话右键菜单是"恢复、删除"', menuText(items) === '恢复 / 删除', menuText(items));
  await page.getByTestId('session-menu').getByRole('menuitem', { name: '恢复' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="archived-toggle"]'), null, { timeout: 5000 });
  const tree = await treeInfo(page);
  record('archive：选"恢复"后回到它的项目下，"已归档"消失，本机列表清掉；没有发命令（不打开它）',
    tree.length === 1 && tree[0].cwd === created.cwd && tree[0].rows[0]?.file === created.sessionFile
    && (await archivedFiles(page)).length === 0 && (await h.bridge()).cursor === 3, JSON.stringify(tree));
  await finish(page, h, 'archive', fx);
}

// ---------- 界面重新加载后接上还在生成的会话 ----------

/** @brief 当前会话里助手正文（不含思考）去掉空白和 Markdown 记号后的文字。 */
const proseText = (page) => page.evaluate((p) => [...document.querySelectorAll(`${p}[data-testid="assistant"] .prose`)]
  .map((node) => node.innerText).join('').replace(/[\s*#`_>]/g, ''), P);
/** @brief 录制里的回复原文去掉空白和 Markdown 记号。 */
const plain = (text) => String(text ?? '').replace(/[\s*#`_>]/g, '');
/** @brief 消息内容里的正文段（不含思考和工具调用）连在一起。 */
const textParts = (content) => (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');

/** @brief 本轮结束前每 150ms 采样一次正文长度，返回全部样本（最多 60 秒）。 */
async function sampleProse(page) {
  const lengths = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    lengths.push((await proseText(page)).length);
    const running = await page.locator(`${P}[data-testid="chat-pane"]`).getAttribute('data-running');
    if (running === 'false') break;
    await sleep(150);
  }
  return lengths;
}

/** @brief 接上：启动列表里的会话显示"生成中"，菜单不能归档、删除；点开不问信任，回复接着流入直到结束。 */
async function reattachCheck(page, h) {
  const fx = await h.load('reattach', { speed: 1 });
  const [listed] = valuesOf(fx, 'session.list')[0];
  const opened = valuesOf(fx, 'session.open')[0];
  const reply = eventsOf(fx, 'message_end').findLast((e) => e.message.role === 'assistant');
  const finalText = plain(textParts(reply?.message.content));
  const before = plain(textParts(opened.live.streaming?.content));
  const status = await statusTextOf(page, listed.sessionFile);
  record('reattach：界面重新加载后侧栏列出还在后台进程里生成的会话，状态"生成中"（列表带回的 live）',
    (await treeInfo(page))[0]?.rows[0]?.file === listed.sessionFile && status === '生成中', String(status));
  const items = await menuItems(page, listed.sessionFile);
  await page.keyboard.press('Escape');
  record('reattach：它的右键菜单里"归档""删除"不可用，旁边小字"正在生成"',
    menuText(items) === '重命名 / 归档(正在生成) / 删除(正在生成)', menuText(items));
  await rowOf(page, listed.sessionFile).click();
  await untilReady(page);
  const lengths = await sampleProse(page);
  const pane = await page.locator(`${P}[data-testid="chat-pane"]`).innerText();
  record('reattach：点开不弹信任询问、界面没发 trust.check；对话流显示你的消息和打开时已经生成的部分',
    await page.getByTestId('trust-dialog').count() === 0 && !(await h.bridge()).queries.includes('trust.check')
    && pane.includes(listed.firstMessage) && before.length > 0 && lengths[0] >= before.length,
  `打开时 ${before.length} 字，界面第一次采样 ${lengths[0]} 字；查询 ${(await h.bridge()).queries.join(',')}`);
  await untilIdle(page, 60000);
  const shown = await proseText(page);
  const replies = await page.locator(`${P}[data-testid="assistant"]`).count();
  record('reattach：回复接着流入（正文逐步变长）直到结束，只有一条助手回复，结尾与录制的回复相同',
    new Set(lengths).size >= 3 && replies === 1 && shown.startsWith(before) && shown.endsWith(finalText.slice(-30)),
  `采样 ${lengths.length} 次、${new Set(lengths).size} 种长度；回复 ${replies} 条；显示 ${shown.length} 字，`
    + `录制 ${finalText.length} 字`);
  const after = await statusTextOf(page, listed.sessionFile);
  record('reattach：结束后会话行的"生成中"消失，阶段行消失', after === null
    && await page.locator(`${P}[data-testid="stage"]`).count() === 0, String(after));
  await shot(page, 'reattach');
  await finish(page, h, 'reattach', fx);
}

// ---------- 扩展的询问 ----------

/** @brief 当前的询问卡：询问 id、种类、卡上的文字、按钮、输入框的提示文字。 */
function questionInfo(page) {
  return page.locator(`${P}[data-testid="ext-ui-card"]`).evaluate((card) => ({
    request: card.dataset.request, method: card.dataset.method, head: card.querySelector('.approval-head')?.innerText,
    title: card.querySelector('.question-title')?.textContent ?? null,
    message: card.querySelector('.question-message')?.textContent ?? null,
    buttons: [...card.querySelectorAll('button')].map((button) => button.textContent),
    placeholder: card.querySelector('input')?.placeholder ?? null }));
}

/** @brief 询问卡应有的样子（extension-ui.md"询问卡"）。 */
function expectedCard(ask) {
  const buttons = { confirm: ['是', '否'], select: [...(ask.options ?? []), '取消'], input: ['确定', '取消'] };
  return { request: ask.requestId, method: ask.method, head: '扩展的询问', title: ask.title,
    message: ask.message ?? null, buttons: buttons[ask.method], placeholder: ask.placeholder ?? null };
}

/** @brief 按录制的回答在询问卡上作答：确认点"是/否"，选择点那一项，输入在框里写字后按 Enter，取消点"取消"。 */
async function answerCard(page, ask, value) {
  const card = page.locator(`${P}[data-testid="ext-ui-card"][data-request="${ask.requestId}"]`);
  if (value === null) return card.getByRole('button', { name: '取消' }).click();
  if (ask.method === 'confirm') return card.getByRole('button', { name: value ? '是' : '否', exact: true }).click();
  if (ask.method === 'select') return card.getByRole('button', { name: value, exact: true }).click();
  await card.locator('input').fill(value);
  return card.locator('input').press('Enter');
}

/** @brief 信任并记住带项目扩展的文件夹，让模型调用 project_ask，Alt+1 允许。 */
async function extUiStart(page, h, fx) {
  const [created] = valuesOf(fx, 'session.create');
  const dialog = await trustDialog(page, h, 'ext-ui', created.cwd);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '信任', exact: true }).click();
  await untilReady(page);
  const [request] = eventsOf(fx, 'mori.approval_request');
  await h.send(commandsOf(fx).find((c) => c.type === 'session.prompt').text);
  await page.locator(`${P}[data-testid="approval-card"][data-request="${request.requestId}"]`)
    .waitFor({ timeout: 30000 });
  await h.textarea.focus();
  await page.keyboard.press('Alt+1');
  return created;
}

/** @brief 扩展的询问：确认、选择、输入三张卡依次出现，照录制作答；通知一行"扩展：……"；工具卡完成。 */
async function extUiCheck(page, h) {
  const fx = await h.load('ext-ui');
  const asks = eventsOf(fx, 'mori.ui_request');
  const answers = commandsOf(fx).filter((c) => c.type === 'ui.answer');
  const created = await extUiStart(page, h, fx);
  for (const [index, ask] of asks.entries()) {
    const card = page.locator(`${P}[data-testid="ext-ui-card"][data-request="${ask.requestId}"]`);
    await card.waitFor({ timeout: 30000 });
    const info = await questionInfo(page);
    const stage = await page.locator(`${P}[data-testid="stage"]`).innerText().catch(() => '');
    const focus = await page.evaluate(() => document.activeElement?.tagName);
    record(`ext-ui：第 ${index + 1} 个询问（${ask.method}）的卡：卡头"扩展的询问"、标题、${{ confirm: '说明和"是""否"',
      select: '每个选项一个按钮和"取消"', input: '带提示文字的输入框和"确定""取消"' }[ask.method]}`,
    JSON.stringify(info) === JSON.stringify(expectedCard(ask)), JSON.stringify(info));
    record(`ext-ui：第 ${index + 1} 个询问挂着时阶段行"等你回答"，会话行状态"等你回答"，焦点没有被抢走`,
      stage.startsWith('等你回答') && await statusTextOf(page, created.sessionFile) === '等你回答'
      && focus === 'TEXTAREA', `${stage}；焦点 ${focus}`);
    if (index === 0) await shot(page, 'ext-ui-confirm');
    await answerCard(page, ask, answers[index].value);
    await untilBridge(page, 'played', 4 + index, `ui.answer #${index + 1}`);
  }
  await untilIdle(page);
  const notify = page.locator(`${P}[data-testid="ext-notify"]`);
  const tool = page.locator(`${P}[data-testid="tool-card"]`).filter({ hasText: 'project_ask' }).first();
  record('ext-ui：扩展的通知在对话流里一行"扩展：project_ask 完成"（info，不用警示色或危险色）',
    await notify.count() === 1 && await notify.innerText() === '扩展：project_ask 完成'
    && await notify.getAttribute('class') === 'notice ext-notify info', await notify.innerText().catch(() => ''));
  record('ext-ui：答完后询问卡消失，工具卡完成，会话行没有状态', await page.locator('[data-testid="ext-ui-card"]').count() === 0
    && await tool.getAttribute('data-status') === 'done' && await statusTextOf(page, created.sessionFile) === null);
  await shot(page, 'ext-ui');
  await finish(page, h, 'ext-ui', fx);
}

const checks = { 'two-projects': twoProjects, rename: renameOpen, 'rename-unopened': renameUnopened,
  delete: deleteCheck, 'trust-deny': trustDeny, 'trust-allow': trustAllow, 'trust-remembered': trustRemembered,
  background, archive: archiveCheck, reattach: reattachCheck, 'ext-ui': extUiCheck };

await buildHarness();
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
  env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
    MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-')) } });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});
const h = helpers(page);
for (const [name, check] of Object.entries(checks)) {
  if (only && !only.includes(name)) continue;
  try {
    await check(page, h);
  } catch (error) {
    record(`${name}：流程`, false, oneLine(error, 400));
    await shot(page, `${name}-error`);
  }
}
record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
await app.close();
process.exitCode = write('m3-replay.json') ? 0 : 1;
