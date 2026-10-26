// 记忆规格 MEM-28、MEM-29 的 App 层（docs/specs/memory.md §10.8、§10.9、§10.10、§14.2；状态表
// docs/v1/screens/settings-issues.md）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，
// synthetic），验收 F8 的界面问题挪到设置页"UI issues"一节（2026-10-26 起 AGENTS.md 挪到 Customize，这是第二节）之后
// M7 的全部行为（原 tests/ui/m7-app.mjs 的 UI issues 部分，标识 review-* 改为 issues-*，§10.8）：
//   MEM-28 设置页两节（Models、UI issues）的顺序、进入时仍落在 Models、左栏没有 Review；读取中 / 读取失败与 Retry、空、Open folder（还没有时
//          先建好、打不开）；列表（从新到旧、只认报告时间格式的 .md、读不出来的一行、BOM、摘要最多两行、不监视文件夹、
//          重新读取时标题旁 Loading…、报告不在了关闭详情）；右栏的详情（截图读取中 / 读不出、放大与关闭、可以展开的三节、
//          Show in Explorer、与会话右栏共用宽度、窄窗口浮在上层）；↑ ↓ 与 Enter；换分节、离开设置页再回来时选中与滚动
//          位置还在；Resolve / Reopen、Hide resolved（M7 时期 mori.review 里的标记照用）、都已隐藏与 Show resolved、
//          重启后还在、报告文件不变；导出（对话框、取消、内容与顺序、截图的相对链接、导出到 ui-issues 里、失败、
//          Show in Explorer）；没有反馈的列表；F8 Recent activity 里的动作文字（§8）；后台进程退出后照常可用；
//          不发请求给模型；没有小于 12px 的字。
//   MEM-29 F8 保存后 View in Settings（没有 View in Review）打开 UI issues 并选中、滚进视野；已经在设置页时直接换节，
//          Customize › Instructions（用户级 AGENTS.md）有未保存的改动时先问；Current view 的 Page（Session、Settings、
//          Memory、Customize、First run，没有 Review）；后台进程退出后照常；首次启动页上没有 View in Settings；
//          从左栏进 Customize 时 Recent activity 记"Open Customize"（2026-10-26 补，customize-agents-md.md"位置"）。
//   MEM-16 的一条（借这里的 F8 报告读 Recent activity）：记忆页 AGENT 的 Edit in Customize 落在 Customize › Instructions，
//          动作记录是"Open Customize → Instructions"（2026-10-26）。
//   另有原 m7-app.mjs 里 composer-pickers 加的 F8 检查（docs/v0/composer-pickers.md"测试要改的地方"新检查第 9 条）：
//          会话里按的报告有"Model range""Effort""Pane width"、各项先后；设置页、记忆页、Customize 页上"Pane width: None"。
// 用法（在 app/ 下，out/ 是当前的构建）：node tests/ui/mem-app-settings.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/mem-app-settings(-packaged).json（--only 时 mem-partial-app-settings…，不计入覆盖检查），
// 截图在 test-results/mem-app-settings(-packaged)/。
// 端口（§14.1 的 4700–4799 里分给本套件的 4760–4769）：合成端点 4760。
// 测试准备（synthetic test setup）：数据目录里按 v1-switch-helpers.seedUserData 写好一个本机提供商与已验证的档案
// （不跑探针）；手写进数据目录的报告、反馈记录与 M7 时期的 mori.review 标记都是 synthetic（seedReports、seedFeedback、
// M7_MARKS），内容里也写明了。主进程的 shell.openPath、shell.showItemInFolder 和 dialog.showSaveDialog 经 app.evaluate
// 换成只记下参数的版本（不真的打开资源管理器或保存对话框）。各步骤按顺序依赖前一步留下的报告和标记：--only 只跑列出的
// 几步（setup 总是跑，测试分层第 2 条，2026-10-26 加），它们依赖的前面几步要一起列出。

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import { f8ViewProblems, offPaneViewProblems, paneFacts, viewFields } from './m2-helpers.mjs';
import { samePath, settle, until } from './m3-helpers.mjs';
import { PANE } from './m4-helpers.mjs';
import { savedLayout } from './m5-helpers.mjs';
import { resizeWindow } from './m6-helpers.mjs';
import { openProject } from './tb-helpers.mjs';
import { modelOf, providerOf, seedUserData, startEndpoint, stopEndpoint } from './v1-switch-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const only = arg('only')?.split(',').filter(Boolean) ?? null;
const shots = join(appRoot, `test-results/mem-app-settings${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 合成端点的端口（本套件的 4760–4769） */
const PORT = 4760;
/** 合成端点上的提供商与模型（synthetic test setup） */
const PROVIDER = 'memset';
const MODEL = 'fake-coder-memset';
/** 空的说明（settings-issues.md "空"） */
const EMPTY = 'No UI issues yet. Press F8 to report one.';
/** 报告的文件名（不含扩展名），同 src/shared/issueRecords.ts 的 ISSUE_NAME */
const ISSUE_NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/;
/** 第一份 F8 报告的两段（你写的内容） */
const WHAT1 = 'The list text is too tight';
const EXPECT1 = 'More space between the lines';
/**
 * synthetic 报告与反馈的文件名：日期早于真的报告（排在列表后面），年份不是今年（摘要里带年份）；
 * sameSecond 是同一秒再存的一份（-2 排在不带序号的前面）
 */
const SEED = {
  noShot: '2024-06-15-120000.md', sameSecond: '2024-06-15-120000-2.md', brokenMd: '2024-06-14-120000.md',
  onlyExpect: '2024-06-13-120000.md', premarked: '2024-06-12-120000.md', late: '2024-06-16-120000.md',
  notReport: 'ui-issues-2000-01-01.md', zip: 'synthetic-share.zip', feedback: '2024-06-15-120000.json',
};
/** synthetic 的填充报告（列表才滚得动）；第一份的"What went wrong"很长（摘要里最多两行） */
const FILLERS = Array.from({ length: 6 }, (_, index) => `2024-05-0${index + 1}-120000.md`);
const LONG_WHAT = `Synthetic long report: ${'the row should keep this text to two lines at most. '.repeat(10)}`.trim();
/** synthetic 反馈记录里的期望（不能出现在设置页里） */
const FEEDBACK_TEXT = 'Synthetic feedback that Settings must not list';
/** M7 时期本机存下的已处理标记（synthetic）：一条反馈的、一条界面问题的（§10.8"原有标记照用"） */
const M7_MARKS = { handled: [`feedback/${SEED.feedback}`, `ui-issues/${SEED.premarked}`], hideHandled: false };
/** F8 Recent activity 里设置页 UI issues 的动作文字（§8，沿用 M7） */
const ISSUE_ACTIONS = ['View record: UI issues', 'Resolve', 'Reopen', 'Hide resolved', 'Show resolved',
  'Export: UI issues', 'Open folder: UI issues', 'Show record in Explorer'];
/** 查小于 12px 的字的范围 */
const SMALL_SCOPE = ['[data-testid="issues-page"]', '[data-testid="issues-detail"]', '[data-testid="shot-viewer"]',
  '[data-testid="issue-dialog"]', '[data-testid="settings-nav"]'];
/** 设置页、记忆页、工具页（中栏的三种页面） */
const PAGES = '[data-testid="settings-page"], [data-testid="memory-page"], [data-testid="tools-page"]';

// ---------- 磁盘 ----------

/** @brief 报告文件夹 <userData>\ui-issues。 */
const issuesDir = (ctx) => join(ctx.userData, 'ui-issues');
/** @brief 两个值的 JSON 相同（顺序也算）。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 两位数字。 */
const pad = (value) => String(value).padStart(2, '0');
/** @brief "N record" / "N records"。 */
const records = (count) => `${count} ${count === 1 ? 'record' : 'records'}`;

/** @brief 按保存时刻比较文件名：去掉扩展名按数字比较（同一秒再存的 -2 比不带序号的新）。 */
function byStamp(left, right) {
  const stem = (name) => name.slice(0, name.lastIndexOf('.'));
  return stem(left).localeCompare(stem(right), 'en', { numeric: true });
}

/** @brief 文件夹里应列出的报告（报告时间格式的 .md），按保存时刻从新到旧。 */
function expectedNames(ctx) {
  const dir = issuesDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md') && ISSUE_NAME.test(name.slice(0, -3)))
    .sort(byStamp).reverse();
}

/** @brief 文件夹里每个文件的大小、修改时间和内容的 SHA-1（比较"文件不变"）。 */
function snapshot(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).sort().map((name) => {
    const path = join(dir, name);
    const digest = createHash('sha1').update(readFileSync(path)).digest('hex');
    return [name, `${statSync(path).size}|${statSync(path).mtimeMs}|${digest}`];
  }));
}

/** @brief 两份快照里不同（新加、删掉、改过）的文件名。 */
function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]);
}

/** @brief 本地时间 YYYY-MM-DD HH:mm:ss。 */
function localTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** @brief 今天（本地）YYYY-MM-DD。 */
const today = () => localTime(new Date()).slice(0, 10);
/** @brief 报告标题里的时间。 */
const reportTime = (file) => /^# UI issue · (.+)$/m.exec(readFileSync(file, 'utf8'))?.[1].trim() ?? '';
/** @brief 列表里的时间：完整时间的 MM-DD HH:mm，不是今年的前面带年份。 */
function shortOf(full) {
  const rest = full.slice(5, 16);
  return Number(full.slice(0, 4)) === new Date().getFullYear() ? rest : `${full.slice(0, 4)}-${rest}`;
}

/**
 * @brief 一份报告里的"Current view"（标签 → 值）与"Recent activity"（去掉时刻的动作文字）；读不到时都为空。
 * @param file 报告的 Markdown 文件
 */
function reportParts(file) {
  const md = file && existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  const section = (title) => {
    const start = md.indexOf(`\n## ${title}\n`);
    if (start < 0) return [];
    const rest = md.slice(start + title.length + 5);
    const end = rest.indexOf('\n## ');
    return (end < 0 ? rest : rest.slice(0, end)).split('\n').filter((line) => line.startsWith('- '));
  };
  const view = Object.fromEntries(section('Current view').map((line) => {
    const at = line.indexOf(': ');
    return [line.slice(2, at), line.slice(at + 2)];
  }));
  const actions = section('Recent activity').map((line) => line.replace(/^- \d{2}:\d{2}:\d{2} /, ''));
  return { md, view, actions, fields: viewFields(section('Current view').join('\n')) };
}

// ---------- synthetic 数据 ----------

/** @brief synthetic 报告的 Markdown（与 main/feedback.ts issueMarkdown 写的格式相同）。 */
function reportMarkdown(time, what, expect, shotText) {
  return [`# UI issue · ${time}`, '', '## What went wrong', '', what, '', '## What you expected', '', expect, '',
    '## Screenshot', '', shotText, '', '## Current view', '', '- Page: synthetic', '', '## Recent activity', '',
    '- 12:00:00 synthetic action', '', '## Versions', '', '- Mori: synthetic', ''].join('\n');
}

/**
 * @brief 写进 synthetic 报告：没有截图的（文件开头带 BOM）、同一秒再存的一份、读不出的、"What went wrong"没有填写的
 *        （带截图，复制第一份 F8 报告的 PNG）、M7 时期已标为处理的、六份填充（第一份的摘要很长），以及不是报告的
 *        .md 和 zip（不列出）。
 */
function seedReports(ctx) {
  const dir = issuesDir(ctx);
  const put = (name, text) => writeFileSync(join(dir, name), text);
  const failed = 'Couldn’t capture a screenshot: Synthetic capture failure';
  put(SEED.noShot, `﻿${reportMarkdown('2024-06-15 12:00:00', 'Synthetic report without a screenshot',
    'Synthetic: listed as usual', failed)}`);
  put(SEED.sameSecond, reportMarkdown('2024-06-15 12:00:00', 'Synthetic report saved in the same second',
    'Synthetic: listed before its base name', failed));
  put(SEED.brokenMd, '# UI issue · 2024-06-14 12:00:00\n\nsynthetic: a report without sections\n');
  const png = SEED.onlyExpect.replace(/\.md$/, '.png');
  copyFileSync(ctx.issue1.replace(/\.md$/, '.png'), join(dir, png));
  put(SEED.onlyExpect, reportMarkdown('2024-06-13 12:00:00', '(left blank)', 'Synthetic: only what you expected',
    `![Screenshot](${png})`));
  put(SEED.premarked, reportMarkdown('2024-06-12 12:00:00', 'Synthetic report resolved in M7',
    'Synthetic: the old mark still applies', failed));
  FILLERS.forEach((name, index) => put(name, reportMarkdown(`2024-05-0${index + 1} 12:00:00`,
    index === 0 ? LONG_WHAT : `Synthetic filler report ${index + 1}`, 'Synthetic: makes the list scroll', failed)));
  put(SEED.notReport, '# synthetic: an exported file, not a report\n');
  writeFileSync(join(dir, SEED.zip), Buffer.from('PK\u0003\u0004synthetic'));
}

/** @brief 写进一条 synthetic 的 M7 时期反馈记录（设置页不列出反馈，§10.7、§10.8）。 */
function seedFeedback(ctx) {
  const dir = join(ctx.userData, 'feedback');
  mkdirSync(dir, { recursive: true });
  const stored = { createdAt: '2024-06-15T04:00:00.000Z', expected: FEEDBACK_TEXT, quote: 'synthetic quote',
    source: { kind: 'message', sessionFile: null, entryId: 'synthetic-missing-entry', time: 1, scope: 'reply' },
    session: { file: null, cwd: ctx.project, title: 'synthetic' } };
  writeFileSync(join(dir, SEED.feedback), `${JSON.stringify(record, null, 2)}\n`);
}

// ---------- 主进程里运行的函数（经 app.evaluate） ----------

/** @brief 换掉 shell.openPath 和 shell.showItemInFolder：只记下路径；openPath 按 fail 返回错误文字。 */
function stubShell({ shell }, fail) {
  globalThis.__memOpened = globalThis.__memOpened ?? [];
  globalThis.__memRevealed = globalThis.__memRevealed ?? [];
  shell.openPath = async (path) => {
    globalThis.__memOpened.push(path);
    return fail ?? '';
  };
  shell.showItemInFolder = (path) => {
    globalThis.__memRevealed.push(path);
  };
}

/** @brief 清空记下的路径。 */
function clearShell() {
  globalThis.__memOpened = [];
  globalThis.__memRevealed = [];
}

/** @brief 换掉保存对话框，返回 target（null 表示取消），记下标题和默认路径。 */
function stubSave({ dialog }, target) {
  globalThis.__memSave = [];
  dialog.showSaveDialog = async (...args) => {
    const options = args.at(-1) ?? {};
    globalThis.__memSave.push({ title: options.title, defaultPath: options.defaultPath });
    return target ? { canceled: false, filePath: target } : { canceled: true, filePath: '' };
  };
}

/** @brief 主进程记下的调用：打开的文件夹、在资源管理器里选中的文件、保存对话框。 */
const mainCalls = (app) => app.evaluate(() => ({ opened: globalThis.__memOpened ?? [],
  revealed: globalThis.__memRevealed ?? [], saves: globalThis.__memSave ?? [] }));
/** @brief 等主进程在资源管理器里选中一个文件，返回它（5 秒内没有时为 undefined）。 */
const firstRevealed = (app) => until(async () => (await mainCalls(app)).revealed[0], 5000);
/** @brief 等主进程打开一个文件夹，返回它。 */
const firstOpened = (app) => until(async () => (await mainCalls(app)).opened[0], 5000);

// ---------- App ----------

/** @brief 合成端点收到的对话请求数（不算探针）。 */
const chatRequests = (ctx) => ctx.logs.filter((line) => line.probe === false).length;

/** @brief 用 ctx.userData 启动 Mori，记下页面报错，换掉主进程的 shell，等左栏出现。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await ctx.app.evaluate(stubShell, null);
  await ctx.page.getByRole('button', { name: 'Settings', exact: true }).first().waitFor({ timeout: 60000 });
}

/** @brief 关掉 Mori（有序关闭后台进程），最多等 20 秒。 */
async function closeApp(ctx) {
  const app = ctx.app;
  ctx.app = null;
  if (app) await Promise.race([app.close().catch(() => {}), sleep(20000)]);
}

/** @brief 关掉 Mori 再用同一个数据目录启动（没有打开的会话）。 */
async function restart(ctx) {
  await closeApp(ctx);
  await startApp(ctx);
  await sleep(800);
}

/** @brief 某一步出错后尽量回到能继续的样子：关掉浮层和对话框。 */
async function recover(ctx) {
  const overlays = '[data-testid="issue-dialog"], [data-testid="shot-viewer"], [data-testid="leave-dialog"]';
  for (let tries = 0; tries < 3; tries += 1) {
    const open = await ctx.page?.locator(overlays).count().catch(() => 0);
    if (!open) return;
    await ctx.page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

// ---------- 页面 ----------

/** @brief 打开设置页（左栏"Settings"），等它出现。 */
async function openSettings(page) {
  if (!(await page.getByTestId('settings-page').count())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  }
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await settle(page);
}

/** @brief 设置页左侧的分节：data-section、文字、是否当前、位置。 */
function settingsNav(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="settings-nav"] button')].map((button) => {
    const rect = button.getBoundingClientRect();
    return { section: button.dataset.section, text: button.textContent.trim(),
      current: button.getAttribute('aria-current') === 'page', top: rect.top, bottom: rect.bottom,
      left: rect.left, right: rect.right };
  }));
}

/** @brief 设置页当前的分节；不在设置页时为 null。 */
const currentSection = async (page) => (await settingsNav(page)).find((item) => item.current)?.section ?? null;

/** @brief 切到设置页的某一节，等它成为当前分节。 */
async function chooseSection(page, section) {
  const button = page.locator(`[data-testid="settings-nav"] button[data-section="${section}"]`);
  if (await button.getAttribute('aria-current') !== 'page') await button.click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="settings-nav"] button[data-section="${id}"]`)
    ?.getAttribute('aria-current') === 'page', section, { timeout: 5000 });
  await settle(page);
}

/** @brief 等 UI issues 读完（不再"Loading…"）。 */
async function waitLoaded(page) {
  await sleep(300);
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="issues-page"]');
    return Boolean(root) && !root.querySelector('[data-testid="issues-loading"]');
  }, null, { timeout: 15000 });
}

/** @brief 打开 设置 → UI issues，等读完。 */
async function openIssues(page) {
  await openSettings(page);
  await chooseSection(page, 'issues');
  await waitLoaded(page);
}

/** @brief 换到 Models 再回到 UI issues（重新读取），等读完。 */
async function rereadIssues(page) {
  await chooseSection(page, 'models');
  await chooseSection(page, 'issues');
  await waitLoaded(page);
}

/** @brief 点设置页、记忆页或工具页的"Back to app"，等中栏换回会话。 */
async function backToApp(page) {
  const top = page.locator(PAGES);
  if (!(await top.count())) return;
  await top.first().getByRole('button', { name: 'Back to app' }).click();
  await page.waitForFunction((css) => !document.querySelector(css), PAGES, { timeout: 10000 });
  await settle(page);
}

/** @brief 列表里文件名为 name 的一行。 */
const rowAt = (page, name) => page.locator(`[data-testid="issues-row"][data-name="${name}"]`);

/** @brief 点列表里的一行，等它按下、右栏显示详情，返回详情。 */
async function selectRow(page, name) {
  await rowAt(page, name).click();
  await page.waitForFunction((file) => document.querySelector(`[data-testid="issues-row"][data-name="${file}"]`)
    ?.getAttribute('aria-pressed') === 'true' && Boolean(document.querySelector('[data-testid="issues-detail"]')),
  name, { timeout: 5000 });
  await settle(page);
  return detailState(page);
}

/** @brief UI issues 这一节此刻的样子：标题、条数、工具行、各种状态和列表的行；不在这一节时为 null。 */
function issuesState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="issues-page"]');
    if (!root) return null;
    const find = (id) => root.querySelector(`[data-testid="${id}"]`);
    const text = (id) => find(id)?.textContent.trim() ?? null;
    const heading = root.querySelector('.issues-head h2');
    const count = heading?.querySelector('[data-testid="issues-count"]');
    const hide = find('issues-hide-handled');
    return {
      heading: heading?.childNodes[0]?.textContent.trim() ?? null, label: heading?.getAttribute('aria-label') ?? null,
      count: count && count.getClientRects().length > 0 ? count.textContent.trim() : null,
      hide: { role: hide?.getAttribute('role') ?? null, checked: hide?.getAttribute('aria-checked') ?? null },
      exportText: text('issues-export'), exportDisabled: find('issues-export')?.disabled ?? null,
      folderText: text('issues-open-folder'), notice: text('issues-notice'), loading: text('issues-loading'),
      error: text('issues-error'), empty: text('issues-empty'), allHidden: text('issues-all-hidden'),
      rows: [...root.querySelectorAll('[data-testid="issues-row"]')].map((row) => ({ name: row.dataset.name,
        handled: row.dataset.handled === 'true', pressed: row.getAttribute('aria-pressed') === 'true',
        tag: row.querySelector('[data-testid="issues-row-handled"]')?.textContent.trim() ?? null,
        tagName: row.tagName.toLowerCase(), text: row.textContent })),
    };
  });
}

/** @brief 列表里按下（选中）的那一行的文件名；没有时为 null。 */
const pressedRow = async (page) => (await issuesState(page))?.rows.find((row) => row.pressed)?.name ?? null;
/** @brief 列出的行的文件名。 */
const listedNames = async (page) => ((await issuesState(page))?.rows ?? []).map((row) => row.name);

/** @brief 右栏的详情此刻的样子；没有详情时为 null。 */
function detailState(page) {
  return page.evaluate(() => {
    const aside = document.querySelector('[data-testid="issues-detail"]');
    if (!aside) return null;
    const text = (id) => aside.querySelector(`[data-testid="${id}"]`)?.textContent.trim() ?? null;
    const more = (id) => {
      const el = aside.querySelector(`[data-testid="${id}"]`);
      const body = el && [...el.children].find((child) => child.tagName !== 'SUMMARY');
      return el && { open: el.open, summary: el.querySelector('summary')?.textContent.trim() ?? '',
        text: body?.textContent ?? '', wrap: body ? getComputedStyle(body).whiteSpace : '' };
    };
    const img = aside.querySelector('img[data-testid="detail-shot"]');
    const rect = aside.getBoundingClientRect();
    return {
      tag: aside.tagName.toLowerCase(), panel: aside.classList.contains('right-panel'),
      label: aside.getAttribute('aria-label'), divider: Boolean(aside.querySelector('[data-resize="workspace"]')),
      heading: aside.querySelector('.panel-header')?.textContent.trim() ?? '',
      close: Boolean(aside.querySelector('.panel-header button[aria-label="Close details"]')),
      time: text('detail-time'), what: text('detail-what'), expect: text('detail-expect'),
      handled: text('detail-handled'), showFile: text('detail-show-file'), broken: text('detail-broken'),
      shot: img && { loaded: img.complete && img.naturalWidth > 0, width: img.getBoundingClientRect().width,
        natural: img.naturalWidth },
      shotLoading: text('detail-shot-loading'), shotError: text('detail-shot-error'),
      view: more('detail-view'), actions: more('detail-actions'), versions: more('detail-versions'),
      text: aside.textContent, left: Math.round(rect.left), width: Math.round(rect.width),
    };
  });
}

/** @brief 焦点所在的列表行的文件名。 */
const focusedRow = (page) => settle(page).then(() => page.evaluate(() => document.activeElement
  ?.closest('[data-testid="issues-row"]')?.dataset.name ?? null));
/** @brief 焦点所在元素的读屏名称。 */
const focusedLabel = (page) => settle(page).then(() => page.evaluate(() => document.activeElement
  ?.getAttribute('aria-label') ?? null));

/** @brief 这一行是否整个在列表的可见范围里（最近的可滚动祖先）。 */
function rowInView(page, name) {
  return page.evaluate((file) => {
    const row = document.querySelector(`[data-testid="issues-row"][data-name="${file}"]`);
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    let box = { top: 0, bottom: innerHeight };
    for (let el = row.parentElement; el; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        box = el.getBoundingClientRect();
        break;
      }
    }
    return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  }, name);
}

/**
 * @brief 列表所在的滚动区域（列表最近的滚得动的祖先，设置页的 .settings-body）：name 不为空时先把这一行滚到顶上；
 *        返回滚动位置和最大值，没有滚得动的区域时为 null。
 */
function listScroll(page, name = null) {
  return page.evaluate((file) => {
    let el = document.querySelector('[data-testid="issues-list"]');
    while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) {
      el = el.parentElement;
    }
    if (!el) return null;
    const row = file && document.querySelector(`[data-testid="issues-row"][data-name="${file}"]`);
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    return { top: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight };
  }, name);
}

/**
 * @brief 两行"淡"的比较：各取含 text 的最深的元素，算它到这一行的不透明度连乘和文字颜色；第一行比第二行淡
 *        （不透明度低得多，或颜色不同）时 dim 为真。
 */
function rowDim(page, [nameA, textA], [nameB, textB]) {
  return page.evaluate(({ a, b }) => {
    const measure = ([name, wanted]) => {
      const row = document.querySelector(`[data-testid="issues-row"][data-name="${name}"]`);
      if (!row) return null;
      const target = [...row.querySelectorAll('*')].reverse().find((el) => el.textContent.includes(wanted)) ?? row;
      let opacity = 1;
      for (let el = target; el && el !== row.parentElement; el = el.parentElement) {
        opacity *= Number(getComputedStyle(el).opacity);
      }
      return { opacity, color: getComputedStyle(target).color };
    };
    const first = measure(a);
    const second = measure(b);
    return { first, second, dim: Boolean(first && second
      && (first.opacity < second.opacity - 0.05 || first.color !== second.color)) };
  }, { a: [nameA, textA], b: [nameB, textB] });
}

/** @brief 一行的摘要（.issues-row-title）占几行（按行高算）、是否截断。 */
function titleLines(page, name) {
  return page.evaluate((file) => {
    const el = document.querySelector(`[data-testid="issues-row"][data-name="${file}"] .issues-row-title`);
    if (!el) return null;
    const line = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.6;
    return { lines: Math.round(el.getBoundingClientRect().height / line),
      clamped: el.scrollHeight > el.clientHeight + 1 };
  }, name);
}

/** @brief 设置页内容区与列表的横向溢出：内容区 scrollWidth / clientWidth、右边超出列表的行。 */
function sideOverflow(page) {
  return page.evaluate(() => {
    const body = document.querySelector('.settings-body');
    const list = document.querySelector('[data-testid="issues-list"]');
    if (!body || !list) return null;
    const edge = list.getBoundingClientRect().right + 0.5;
    const wide = [...list.querySelectorAll('[data-testid="issues-row"]')]
      .filter((row) => row.getBoundingClientRect().right > edge).map((row) => row.dataset.name);
    return { body: [body.scrollWidth, body.clientWidth], wide };
  });
}

/** @brief 截图浮层此刻的样子；不在时为 null。 */
function viewerOverlay(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="shot-viewer"]');
    if (!dialog) return null;
    const img = dialog.querySelector('img');
    const rect = img?.getBoundingClientRect();
    return { role: dialog.getAttribute('role'), label: dialog.getAttribute('aria-label'),
      outsideApp: !dialog.closest('.app') && !dialog.closest('[data-testid="issues-detail"]'),
      loaded: Boolean(img && img.naturalWidth > 0), fits: Boolean(rect && rect.left >= -1 && rect.top >= -1
        && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
      close: [...dialog.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Close') };
  });
}

/** @brief 截图浮层里截图外面的一点（不在截图上、不在按钮上）；找不到时为 null。 */
function outsidePoint(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="shot-viewer"]');
    const img = dialog?.querySelector('img');
    if (!dialog || !img) return null;
    const points = [[8, 8], [innerWidth - 8, innerHeight - 8], [8, innerHeight - 8], [innerWidth - 8, 8],
      [innerWidth / 2, 6], [innerWidth / 2, innerHeight - 6]];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      const related = hit && (dialog.contains(hit) || hit.contains(dialog));
      if (related && hit !== img && !hit.closest('button')) return { x, y };
    }
    return null;
  });
}

/** @brief 一栏（会话的右栏或 UI issues 的详情）的宽度和它的分隔线的值、上限；没有时为 null。 */
function panelWidth(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const divider = el.querySelector('[data-resize="workspace"]');
    return { width: Math.round(el.getBoundingClientRect().width), now: Number(divider?.getAttribute('aria-valuenow')),
      max: Number(divider?.getAttribute('aria-valuemax')) };
  }, testId);
}

/**
 * @brief 开始记下这些选择器有没有出现过，以及出现时列表（issues-list）在不在（只出现一两帧的状态轮询抓不到）。
 * @param selectors 名字 → CSS 选择器
 */
function watchSeen(page, selectors) {
  return page.evaluate((map) => {
    window.__memSeen = Object.fromEntries(Object.keys(map).map((key) => [key, { seen: false, withList: false }]));
    window.__memObserver?.disconnect();
    const look = () => {
      for (const [key, css] of Object.entries(map)) {
        if (!document.querySelector(css)) continue;
        window.__memSeen[key].seen = true;
        if (document.querySelector('[data-testid="issues-list"]')) window.__memSeen[key].withList = true;
      }
    };
    look();
    window.__memObserver = new MutationObserver(look);
    window.__memObserver.observe(document.body, { subtree: true, childList: true });
  }, selectors);
}

/** @brief 停下 watchSeen，返回记下的结果。 */
const seenNow = (page) => page.evaluate(() => {
  window.__memObserver?.disconnect();
  return window.__memSeen ?? {};
});

/** @brief 记下此刻 UI issues 各处小于 12px 的字（最后统一判断）。 */
async function noteSmall(ctx, where) {
  const small = await ctx.page.evaluate((scopes) => scopes.flatMap((scope) => [...document.querySelectorAll(scope)])
    .flatMap((root) => [root, ...root.querySelectorAll('*')])
    .filter((el) => el.getClientRects().length > 0
      && [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} ${getComputedStyle(el).fontSize} `
      + `"${el.textContent.trim().slice(0, 20)}"`), SMALL_SCOPE);
  ctx.small.push(...small.map((item) => `${where}: ${item}`));
  ctx.smallChecked.push(where);
}

/** @brief 等工具行下面的一行以 prefix 开头（最多 5 秒），返回它此刻的文字。 */
async function noticeText(page, prefix) {
  await page.waitForFunction((start) => document.querySelector('[data-testid="issues-notice"]')?.textContent.trim()
    .startsWith(start), prefix, { timeout: 5000 }).catch(() => {});
  return page.getByTestId('issues-notice').innerText({ timeout: 1000 }).catch(() => '');
}

// ---------- F8 ----------

/**
 * @brief 按 F8 写一份报告并保存，记进 ctx.reports；返回报告框、Markdown 路径和报告框里按钮的文字。
 * @param ctx 带 page 与 reports
 */
async function saveReport(ctx, what, expect, page = ctx.page) {
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByTestId('issue-expect').fill(expect);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = dialog.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const file = /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  if (file) ctx.reports.push(file);
  const buttons = (await dialog.locator('button').allInnerTexts()).map((text) => text.trim());
  return { dialog, file, buttons };
}

/** @brief 点报告框的"Close"，等它关闭。 */
async function closeReport(dialog) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

/** @brief 点了"View in Settings"之后：等 UI issues 读完、选中 file，返回落到的样子。 */
async function landedOn(page, file) {
  const name = basename(file ?? '');
  await page.getByTestId('issues-page').waitFor({ timeout: 10000 });
  await waitLoaded(page);
  await until(async () => (await pressedRow(page)) === name, 5000);
  await sleep(300);
  return { dialog: await page.getByTestId('issue-dialog').count(), section: await currentSection(page),
    selected: await pressedRow(page), inView: await rowInView(page, name),
    detail: (await detailState(page))?.what ?? null };
}

// ---------- 导出 ----------

/**
 * @brief 换掉保存对话框（返回 target，null 为取消），点"Export as Markdown…"；返回对话框收到的标题和默认路径，
 *        以及导出文件的全文（wait 为真时等文件写好）。
 */
async function exportTo(ctx, target, wait = Boolean(target)) {
  const { app, page } = ctx;
  await app.evaluate(stubSave, target);
  await page.getByTestId('issues-export').click();
  const saves = await until(async () => {
    const calls = await mainCalls(app);
    return calls.saves.length > 0 && calls.saves;
  }, 5000);
  const md = wait ? await until(() => existsSync(target) && readFileSync(target, 'utf8'), 5000) : '';
  await sleep(300);
  return { dialog: saves ? saves[0] : null, md: md || '' };
}

/**
 * @brief 导出文件的开头：标题行和下一行（导出时间、条数）。条数的单复数不对时 total 为 NaN。
 */
function mdHead(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const line = lines.slice(1).find((item) => item.trim()) ?? '';
  const head = /^Exported \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? · (\d+ records?): (\d+) unresolved, (\d+) resolved$/;
  const match = head.exec(line);
  const count = Number.parseInt(match?.[2] ?? '', 10);
  const total = match && match[2] === records(count) ? count : Number.NaN;
  return { title: lines[0], line, total, open: Number(match?.[3]), done: Number(match?.[4]) };
}

/** @brief 导出文件的各节（"## <序号>. "开头）：标题行、报告的文件名（"- Report file: "或"- Record file: "）、全文。 */
function mdSections(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const starts = lines.flatMap((line, index) => (/^## \d+\. /.test(line) ? [index] : []));
  return starts.map((start, index) => {
    const body = lines.slice(start, starts[index + 1] ?? lines.length);
    const file = body.map((line) => /^- (?:Record file|Report file): (.+)$/.exec(line)?.[1]).find(Boolean);
    return { heading: body[0], name: file ? basename(file.trim()) : null, text: body.join('\n') };
  });
}

/** @brief 一节里截图的链接（"![Screenshot](<路径>)"）；没有时为 null。 */
const shotLink = (text) => /!\[Screenshot\]\(<?([^<>)]+)>?\)/.exec(text)?.[1] ?? null;

// ---------- 步骤：准备与入口 ----------

/** @brief 准备：合成端点、数据目录（synthetic test setup）、启动 Mori、打开项目（不发消息）。 */
async function setup(ctx) {
  ctx.endpoint = await startEndpoint(PORT, {}, ctx.logs);
  mkdirSync(join(ctx.userData, 'pi'), { recursive: true });
  // 测试准备（synthetic test setup）：一个本机提供商（合成端点上的一个模型）、已验证的档案（不跑探针），默认范围是它。
  const provider = providerOf(PROVIDER, 'Memory settings endpoint', PORT, [modelOf(MODEL)]);
  seedUserData(ctx.userData, { version: 1, providers: [provider], groups: [], normalDefault: PROVIDER }, {});
  await startApp(ctx);
  ctx.tab = await openProject(ctx, ctx.project, { trust: true });
  record('MEM-28 setup: Mori starts with the seeded model settings and opens a session (no model request)',
    Boolean(ctx.tab) && chatRequests(ctx) === 0, `tab=${ctx.tab} chat=${chatRequests(ctx)}`);
}

/** @brief 设置页两节的顺序与位置（2026-10-26 起 AGENTS.md 在 Customize）；进入设置页落在 Models；左栏没有 Review。 */
async function entryDefault(ctx) {
  const { page } = ctx;
  const side = await page.evaluate(() => ({ review: document.querySelectorAll('[data-testid="nav-review"]').length,
    memory: document.querySelectorAll('[data-testid="nav-memory"]').length,
    labels: [...document.querySelectorAll('[data-testid="sidebar"] .sidebar-nav button')]
      .map((button) => button.getAttribute('aria-label') ?? button.textContent.trim()) }));
  await openSettings(page);
  const nav = await settingsNav(page);
  const after = (a, b) => Boolean(a && b) && (a.top >= b.bottom - 1 || a.left >= b.right - 1);
  record('MEM-28 Settings has two sections in order Models, UI issues (data-section="issues", after Models); '
    + 'AGENTS.md is no longer here (it moved to Customize on 2026-10-26)',
  same(nav.map((item) => item.section), ['models', 'issues'])
    && same(nav.map((item) => item.text), ['Models', 'UI issues'])
    && after(nav[1], nav[0]), JSON.stringify(nav));
  record('MEM-28 entering Settings still lands on Models, not UI issues; the sidebar has Memory and no Review entry',
    nav[0]?.current === true && !nav[1]?.current && side.review === 0 && side.memory === 1
    && !side.labels.includes('Review'), JSON.stringify({ side, current: nav.find((item) => item.current) }));
  await shot(page, '1-settings-models');
}

/**
 * @brief 读取失败与空：ui-issues 的位置是个文件时读取失败（先"Loading…"，再原文和"Retry"），删掉它再"Retry"变成空
 *        （文件夹不存在不算错）；空的一节：标题、工具行、说明、没有右栏；没有反馈的列表。
 */
async function readFailure(ctx) {
  const { page } = ctx;
  rmSync(issuesDir(ctx), { recursive: true, force: true });
  writeFileSync(issuesDir(ctx), 'synthetic: a file where the ui-issues folder should be\n');
  await watchSeen(page, { loading: '[data-testid="issues-page"] [data-testid="issues-loading"]' });
  await chooseSection(page, 'issues');
  const error = page.getByTestId('issues-error');
  await error.waitFor({ timeout: 10000 }).catch(() => {});
  const failed = await error.innerText().catch(() => '');
  const retry = await error.getByRole('button', { name: 'Retry' }).count();
  const seen = await seenNow(page);
  await shot(page, '1-read-failure');
  record('MEM-28 read failure (the main process cannot read ui-issues): "Loading…" first, then the original error '
    + 'and Retry', Boolean(seen.loading?.seen) && /ENOTDIR|not a directory/i.test(failed) && retry === 1,
  JSON.stringify({ seen, failed }));
  rmSync(issuesDir(ctx));
  await error.getByRole('button', { name: 'Retry' }).click();
  const empty = await page.getByTestId('issues-empty').waitFor({ timeout: 10000 }).then(() => true, () => false);
  const state = await issuesState(page);
  record('MEM-28 Retry: a missing ui-issues folder is not an error but an empty list', empty && !state.error,
    JSON.stringify({ empty, error: state.error }));
  await emptyState(ctx, state);
}

/** @brief 空的 UI issues：标题没有数字、工具行、说明、没有右栏；没有反馈的列表。 */
async function emptyState(ctx, state) {
  const { page } = ctx;
  const panels = { detail: await page.getByTestId('issues-detail').count(),
    session: await page.getByTestId('right-panel').count() };
  record('MEM-28 empty UI issues: heading "UI issues" with no count (aria-label "UI issues, 0 unresolved"), '
    + 'Hide resolved switch off, Export as Markdown… disabled, Open folder, "No UI issues yet. Press F8 to report '
    + 'one.", no right panel', state.heading === 'UI issues' && state.label === 'UI issues, 0 unresolved'
    && state.count === null && state.hide.role === 'switch' && state.hide.checked === 'false'
    && state.exportText === 'Export as Markdown…' && state.exportDisabled === true && state.folderText === 'Open folder'
    && state.empty === EMPTY && state.rows.length === 0 && panels.detail === 0 && panels.session === 0,
  JSON.stringify({ ...state, rows: state.rows.length, panels }));
  const feedback = await page.evaluate(() => ({ review: document.querySelectorAll('[data-testid^="review-"]').length,
    text: /Feedback/.test(document.querySelector('[data-testid="settings-page"]')?.textContent ?? '') }));
  record('MEM-28 no feedback list in Settings: no Feedback section or tab and no review-* test ids',
    feedback.review === 0 && !feedback.text, JSON.stringify(feedback));
  await noteSmall(ctx, 'empty UI issues');
}

/** @brief "Open folder"：还没有文件夹时先建好再打开；打不开时工具行下面显示原文，再试成功时原文消失。 */
async function folderEmpty(ctx) {
  const { app, page } = ctx;
  const before = existsSync(issuesDir(ctx));
  await app.evaluate(clearShell);
  await page.getByTestId('issues-open-folder').click();
  const opened = await firstOpened(app);
  record('MEM-28 Open folder: Explorer opens <userData>\\ui-issues\\, created first when it does not exist yet',
    !before && samePath(opened, issuesDir(ctx)) && existsSync(issuesDir(ctx)), JSON.stringify({ before, opened }));
  await app.evaluate(stubShell, 'Synthetic open failure');
  await page.getByTestId('issues-open-folder').click();
  const notice = await noticeText(page, 'Couldn’t open the folder: ');
  record('MEM-28 Open folder fails: "Couldn’t open the folder: <original error>" below the toolbar',
    notice === 'Couldn’t open the folder: Synthetic open failure', notice);
  await app.evaluate(stubShell, null);
  await page.getByTestId('issues-open-folder').click();
  const cleared = await page.getByTestId('issues-notice').waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  record('MEM-28 Open folder works again: the error line goes away', cleared);
}

/**
 * @brief 会话里按 F8 写一份报告（带截图）：保存后有"View in Settings"、没有"View in Review"；点它打开 设置 → UI issues
 *        并选中这一份；报告的 Current view 写"Page: Session"。
 */
async function f8Report(ctx) {
  const { page } = ctx;
  await backToApp(page);
  const facts = await paneFacts(page, PANE);
  const { dialog, file, buttons } = await saveReport(ctx, WHAT1, EXPECT1);
  ctx.issue1 = file;
  const at = buttons.indexOf('Show in Explorer');
  await noteSmall(ctx, 'F8 saved');
  record('MEM-29 F8 saved: "View in Settings" (issue-open-settings) next to Show in Explorer, no "View in Review"',
    Boolean(file) && at >= 0 && buttons[at + 1] === 'View in Settings' && !buttons.includes('View in Review')
    && await dialog.getByTestId('issue-open-settings').count() === 1, JSON.stringify(buttons));
  await dialog.getByTestId('issue-open-settings').click();
  const view = await landedOn(page, file);
  await page.waitForFunction(() => document.querySelector('[data-testid="detail-shot"]')?.naturalWidth > 0, null,
    { timeout: 10000 }).catch(() => {});
  const detail = await detailState(page);
  await shot(page, '2-view-in-settings');
  record('MEM-29 View in Settings closes the dialog and opens Settings → UI issues with this report selected '
    + '(in view; its text and screenshot in the right panel)', view.dialog === 0 && view.section === 'issues'
    && view.selected === basename(file ?? '') && view.inView && detail?.what === WHAT1 && detail.expect === EXPECT1
    && Boolean(detail.shot?.loaded), JSON.stringify({ ...view, expect: detail?.expect, shot: detail?.shot }));
  const parts = reportParts(file);
  record('MEM-29 F8 in a session writes "Page: Session" in Current view', parts.view.Page === 'Session',
    JSON.stringify(parts.view));
  const problems = f8ViewProblems(parts.fields, facts);
  record('F8 in a session (from m7-app, composer-pickers new check 9): Current view keeps "Model" and "Permission '
    + 'mode" and adds "Model range" (the range button), "Effort" (the Effort button in the message-box row) and "Pane '
    + 'width" (the focused .chat-pane), in the order of f8.md', problems.length === 0,
  JSON.stringify({ problems, facts, fields: parts.fields }));
}

// ---------- 步骤：synthetic 报告与列表 ----------

/**
 * @brief 写进 synthetic 报告、反馈记录和 M7 时期的标记后重启：从新到旧列出，只认报告时间格式的 .md，读不出来的一行带
 *        原文，带 BOM 的照样读出；M7 的已处理标记照用；反馈不列出。
 */
async function seeded(ctx) {
  seedReports(ctx);
  seedFeedback(ctx);
  // synthetic：M7 时期本机存下的已处理标记，重启后由界面读出（§10.8"原有标记照用"）
  await ctx.page.evaluate((value) => localStorage.setItem('mori.review', value), JSON.stringify(M7_MARKS));
  await restart(ctx);
  const { page } = ctx;
  await openIssues(page);
  const state = await issuesState(page);
  const want = expectedNames(ctx);
  const names = state.rows.map((row) => row.name);
  record(`MEM-28 list: ${want.length} reports newest first by file name (a same-second -2 before its base name); `
    + `only report-named .md files (${SEED.notReport}, the zip and PNGs are not listed)`, same(names, want)
    && names.indexOf(SEED.sameSecond) + 1 === names.indexOf(SEED.noShot) && !names.includes(SEED.notReport)
    && names.every((name) => ISSUE_NAME.test(name.replace(/\.md$/, ''))), JSON.stringify(names));
  const text = (name) => state.rows.find((row) => row.name === name)?.text ?? '';
  record('MEM-28 an unreadable report is one row "Couldn’t read the record <file>" with the original error; '
    + 'a report saved with a BOM is read as usual', text(SEED.brokenMd).includes(`Couldn’t read the record ${
      SEED.brokenMd}`) && text(SEED.brokenMd).includes('The report has no')
    && text(SEED.noShot).includes('Synthetic report without a screenshot') && !text(SEED.noShot).includes('Couldn’t'),
  oneLine(`${text(SEED.brokenMd)} | ${text(SEED.noShot)}`));
  const pre = state.rows.find((row) => row.name === SEED.premarked);
  const open = want.length - 1;
  record('MEM-28 resolved marks saved in mori.review by M7 still apply: the ui-issues/ mark shows its row Resolved '
    + 'and the heading counts the others ("UI issues, N unresolved"); the old feedback/ mark counts nothing',
  Boolean(pre?.handled) && pre.tag === 'Resolved' && state.count === String(open)
    && state.label === `UI issues, ${open} unresolved`, JSON.stringify({ pre: pre && { ...pre, text: undefined },
    count: state.count, label: state.label }));
  record('MEM-28 each report is a row button; a feedback record in <userData>\\feedback is not listed anywhere in '
    + 'Settings (no feedback list)', state.rows.every((row) => row.tagName === 'button')
    && !names.includes(SEED.feedback) && !state.rows.some((row) => row.text.includes(FEEDBACK_TEXT))
    && !(await page.getByTestId('settings-page').innerText()).includes(FEEDBACK_TEXT), JSON.stringify(names));
  await noteSmall(ctx, 'UI issues list');
  await shot(page, '3-seeded');
}

/** @brief 一行摘要："What went wrong"（没有填写时用"What you expected"，最多两行）、时间、没有截图时"No screenshot"。 */
async function issueRows(ctx) {
  const { page } = ctx;
  const rows = Object.fromEntries((await issuesState(page)).rows.map((row) => [row.name, row.text]));
  const first = rows[basename(ctx.issue1)] ?? '';
  const time = shortOf(reportTime(ctx.issue1));
  record('MEM-28 a report row: "What went wrong" and the time (MM-DD HH:mm this year); no "No screenshot" when it '
    + 'has one', first.includes(WHAT1) && first.includes(time) && !first.includes('No screenshot'), oneLine(first));
  const noShot = rows[SEED.noShot] ?? '';
  record('MEM-28 a report without a screenshot is tagged "No screenshot"; a report from another year shows the year',
    noShot.includes('Synthetic report without a screenshot') && noShot.includes('No screenshot')
    && noShot.includes('2024-06-15 12:00'), oneLine(noShot));
  const only = rows[SEED.onlyExpect] ?? '';
  record('MEM-28 when "What went wrong" was left blank the row shows "What you expected"',
    only.includes('Synthetic: only what you expected') && !only.includes('(left blank)'), oneLine(only));
  const clamp = await titleLines(page, FILLERS[0]);
  const overflow = await sideOverflow(page);
  record('MEM-28 "What went wrong" takes at most two lines in a row (a long one is clamped); no horizontal scroll',
    Boolean(clamp) && clamp.lines >= 1 && clamp.lines <= 2 && clamp.clamped && Boolean(overflow)
    && overflow.body[0] <= overflow.body[1] && overflow.wide.length === 0, JSON.stringify({ clamp, overflow }));
}

/**
 * @brief 不监视文件夹：这一节开着时写进来的报告要回到这一节才看到，重新读取时上一次的列表留着、标题旁"Loading…"；
 *        报告被删后重新读取，列表里没有它、详情关闭。
 */
async function noWatch(ctx) {
  const { page } = ctx;
  const file = join(issuesDir(ctx), SEED.late);
  writeFileSync(file, reportMarkdown('2024-06-16 12:00:00', 'Synthetic: written by another program',
    'Synthetic: listed on the next read', 'Couldn’t capture a screenshot: Synthetic capture failure'));
  await sleep(1500);
  const listed = async () => (await listedNames(page)).includes(SEED.late);
  const before = await listed();
  await chooseSection(page, 'models');
  await watchSeen(page, { heading: '.issues-head [data-testid="issues-loading"]' });
  await chooseSection(page, 'issues');
  const after = await until(listed, 5000);
  await waitLoaded(page);
  const seen = await seenNow(page);
  record('MEM-28 the folder is not watched: a report written while the section is open is listed only when you come '
    + 'back to UI issues', !before && Boolean(after), JSON.stringify({ before, after }));
  record('MEM-28 re-reading keeps the previous list and shows "Loading…" beside the heading until it is done',
    Boolean(seen.heading?.seen && seen.heading.withList) && await page.getByTestId('issues-loading').count() === 0,
    JSON.stringify(seen));
  await selectRow(page, SEED.late);
  rmSync(file);
  await rereadIssues(page);
  const gone = await until(async () => !(await listed()), 5000);
  const detail = await page.getByTestId('issues-detail').count();
  record('MEM-28 a report deleted on disk: after a re-read its row is gone and its detail closes',
    Boolean(gone) && detail === 0, JSON.stringify({ gone, detail }));
}

// ---------- 步骤：详情 ----------

/** @brief 依次展开"Current view""Recent activity""Versions"，返回每节展开前是否打开和展开后的样子。 */
async function expandMore(page) {
  const keys = { 'detail-view': 'view', 'detail-actions': 'actions', 'detail-versions': 'versions' };
  const result = [];
  for (const [id, key] of Object.entries(keys)) {
    const before = (await detailState(page))?.[key]?.open ?? null;
    await page.getByTestId(id).locator('summary').click();
    await settle(page);
    result.push({ id, before, after: (await detailState(page))?.[key] ?? null });
  }
  return result;
}

/** @brief 报告的详情：右栏、标题和 ×、时间、两段全文、截图读取中再显示、可以展开的三节、Show in Explorer。 */
async function issueDetail(ctx) {
  const { app, page } = ctx;
  await watchSeen(page, { shot: '[data-testid="detail-shot-loading"]' });
  const detail = await selectRow(page, basename(ctx.issue1));
  await page.waitForFunction(() => document.querySelector('[data-testid="detail-shot"]')?.naturalWidth > 0, null,
    { timeout: 10000 }).catch(() => {});
  const seen = await seenNow(page);
  const loaded = await detailState(page);
  const frame = await page.evaluate(() => ({ center: Math.round(document.querySelector('[data-testid="settings-page"]')
    .getBoundingClientRect().right), session: document.querySelectorAll('[data-testid="right-panel"]').length }));
  record('MEM-28 selecting a report opens its detail in the right panel (aside.right-panel "UI issue details" with '
    + 'a divider); the settings page gives way; no session right panel', detail.tag === 'aside' && detail.panel
    && detail.label === 'UI issue details' && detail.divider && frame.center <= detail.left + 1 && frame.session === 0,
  JSON.stringify({ ...frame, left: detail.left, label: detail.label }));
  record('MEM-28 report detail: heading "UI issues" and Close details; the full time; What went wrong and What you '
    + 'expected in full; "Loading screenshot…" then the screenshot scaled to the panel', detail.heading === 'UI issues'
    && detail.close && (detail.time ?? '').startsWith(reportTime(ctx.issue1).slice(0, 16)) && detail.what === WHAT1
    && detail.expect === EXPECT1 && Boolean(seen.shot?.seen) && Boolean(loaded?.shot?.loaded)
    && loaded.shot.width <= loaded.width && loaded.shot.width < loaded.shot.natural,
  JSON.stringify({ seen, time: detail.time, shot: loaded?.shot, width: loaded?.width }));
  await moreAndExplorer(ctx);
  await app.evaluate(clearShell);
}

/** @brief 可以展开的三节（默认收起，展开后是原文、保留换行）；"Show in Explorer"在资源管理器里选中这份报告。 */
async function moreAndExplorer(ctx) {
  const { app, page } = ctx;
  const more = await expandMore(page);
  const [view, actions, versions] = more.map((item) => item.after);
  record('MEM-28 Current view, Recent activity and Versions are collapsed and expand to the report text (line breaks '
    + 'kept)', more.every((item) => item.before === false && item.after?.open && item.after.wrap === 'pre-wrap')
    && view.summary === 'Current view' && view.text.includes('Page: Session')
    && actions.summary === 'Recent activity' && actions.text.includes('Report a UI issue')
    && versions.summary === 'Versions' && versions.text.includes('Electron'), JSON.stringify(more));
  await noteSmall(ctx, 'report detail (expanded)');
  await shot(page, '4-issue-detail');
  await app.evaluate(clearShell);
  await page.getByTestId('detail-show-file').click();
  const revealed = await firstRevealed(app);
  record('MEM-28 Show in Explorer selects the report file in Explorer', samePath(revealed, ctx.issue1),
    String(revealed));
}

/** @brief 放大截图：浮层显示截图、缩到窗口内、有"Close"；Esc、点外面、"Close"都关闭，焦点回到截图。 */
async function shotViewer(ctx) {
  const { page } = ctx;
  const zoom = page.getByTestId('issues-detail').getByRole('button', { name: 'View full screenshot' });
  const viewer = page.getByTestId('shot-viewer');
  const gone = () => viewer.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
  await zoom.click();
  await viewer.waitFor({ timeout: 5000 });
  const opened = await viewerOverlay(page);
  await noteSmall(ctx, 'screenshot viewer');
  await shot(page, '4-shot-viewer');
  await page.keyboard.press('Escape');
  const esc = { closed: await gone(), focus: await focusedLabel(page),
    detail: await page.getByTestId('issues-detail').count() };
  record('MEM-28 enlarged screenshot: an overlay (role=dialog "Screenshot", outside the app) shows it fitted to the '
    + 'window with Close; Esc closes it (the detail stays) and focus returns to the screenshot',
  opened?.role === 'dialog' && opened.label === 'Screenshot' && opened.outsideApp && opened.loaded && opened.fits
    && opened.close && esc.closed && esc.focus === 'View full screenshot' && esc.detail === 1,
  JSON.stringify({ opened, esc }));
  await zoom.focus();
  await page.keyboard.press('Enter');
  await viewer.waitFor({ timeout: 5000 });
  const point = await outsidePoint(page);
  if (point) await page.mouse.click(point.x, point.y);
  const outside = { point, closed: await gone(), focus: await focusedLabel(page) };
  await zoom.click();
  await viewer.waitFor({ timeout: 5000 });
  await viewer.getByRole('button', { name: 'Close' }).click();
  const button = { closed: await gone(), focus: await focusedLabel(page) };
  record('MEM-28 Enter on the screenshot also enlarges it; a click outside or Close closes it and focus returns to '
    + 'the screenshot', Boolean(point) && outside.closed && outside.focus === 'View full screenshot' && button.closed
    && button.focus === 'View full screenshot', JSON.stringify({ outside, button }));
}

/** @brief 读不出来的报告的详情；没有截图的报告；列表读完后 PNG 被删了（截图读不出来）。 */
async function brokenDetail(ctx) {
  const { app, page } = ctx;
  const md = await selectRow(page, SEED.brokenMd);
  await app.evaluate(clearShell);
  await page.getByTestId('issues-detail').getByRole('button', { name: 'Show in Explorer' }).click();
  const revealed = await firstRevealed(app);
  record('MEM-28 an unreadable report: the detail shows the file name and the original error, Show in Explorer '
    + '(selects it in Explorer) and Resolve', (md.broken ?? '').includes(SEED.brokenMd)
    && md.broken.includes('The report has no') && md.handled === 'Resolve'
    && samePath(revealed, join(issuesDir(ctx), SEED.brokenMd)), JSON.stringify({ broken: md.broken, revealed }));
  const noShot = await selectRow(page, SEED.noShot);
  record('MEM-28 a report without a screenshot: "Couldn’t capture a screenshot: <original>" and no image',
    noShot.text.includes('Couldn’t capture a screenshot: Synthetic capture failure') && !noShot.shot,
    noShot.shotError ?? '');
  rmSync(join(issuesDir(ctx), SEED.onlyExpect.replace(/\.md$/, '.png')));
  await selectRow(page, SEED.onlyExpect);
  const failed = await page.getByTestId('detail-shot-error').innerText({ timeout: 5000 }).catch(() => '');
  record('MEM-28 a screenshot deleted after the list was read: "Couldn’t load the screenshot: <original error>"',
    failed.startsWith('Couldn’t load the screenshot: ') && failed.length > 'Couldn’t load the screenshot: '.length,
    failed);
  await rereadIssues(page);
  const row = (await issuesState(page)).rows.find((item) => item.name === SEED.onlyExpect)?.text ?? '';
  await selectRow(page, SEED.onlyExpect);
  const reread = await page.getByTestId('detail-shot-error').innerText({ timeout: 5000 }).catch(() => '');
  record('MEM-28 a screenshot deleted before the list was read: the row is not tagged "No screenshot" and the '
    + 'detail says "Couldn’t load the screenshot: …"', Boolean(row) && !row.includes('No screenshot')
    && reread.startsWith('Couldn’t load the screenshot: '), oneLine(`${row} | ${reread}`));
}

/** @brief ↓ ↓ ↑ 在行之间移动焦点，Enter 打开详情。 */
async function keyboardRows(ctx) {
  const { page } = ctx;
  const names = await listedNames(page);
  await rowAt(page, names[0]).focus();
  const seen = [];
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(key);
    seen.push(await focusedRow(page));
  }
  await page.keyboard.press('Enter');
  await settle(page);
  const selected = await pressedRow(page);
  const detail = await page.getByTestId('issues-detail').count();
  record('MEM-28 keyboard: ↑ ↓ move focus between rows and Enter opens the detail', same(seen, [names[1], names[2],
    names[1]]) && selected === names[1] && detail === 1, JSON.stringify({ seen, selected, names: names.slice(0, 3) }));
}

/**
 * @brief 换分节、离开设置页再回来时选中的报告和滚动位置还在（选中的一行滚出视野后也不被拉回去，窗口调矮列表才滚得动）；
 *        在别的分节没有右栏；再进入设置页仍落在 Models。
 */
async function sectionMemory(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await resizeWindow(app, 1100, 600);
  try {
    const names = await listedNames(page);
    const pick = names[0];
    await selectRow(page, pick);
    await listScroll(page, names.at(-1));
    await sleep(400);
    const before = await listScroll(page);
    const outOfView = !(await rowInView(page, pick));
    await chooseSection(page, 'models');
    const other = { detail: await page.getByTestId('issues-detail').count(),
      session: await page.getByTestId('right-panel').count() };
    await chooseSection(page, 'issues');
    await waitLoaded(page);
    const switched = { scroll: await listScroll(page), selected: await pressedRow(page) };
    await backToApp(page);
    await openSettings(page);
    const landing = await currentSection(page);
    await chooseSection(page, 'issues');
    await waitLoaded(page);
    const revisit = { scroll: await listScroll(page), selected: await pressedRow(page) };
    const near = (now) => Boolean(now && before) && Math.abs(now.top - before.top) <= 2;
    record('MEM-28 in another settings section there is no right panel (no report detail)', other.detail === 0
      && other.session === 0, JSON.stringify(other));
    record('MEM-28 back on UI issues (from another section, and after leaving Settings) the selected report and the '
      + 'scroll position are kept, even with the selected row scrolled out of view; entering Settings again lands on '
      + 'Models', before?.top > 0 && outOfView && near(switched.scroll) && switched.selected === pick
      && landing === 'models' && near(revisit.scroll) && revisit.selected === pick,
    JSON.stringify({ pick, before, outOfView, switched, landing, revisit }));
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
}

/** @brief 列表记住的滚动位置在最下面时，"View in Settings"把刚记下的一行（最上面）滚到看得见的地方。 */
async function revealSaved(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await resizeWindow(app, 1100, 600);
  try {
    await openIssues(page);
    await listScroll(page, (await listedNames(page)).at(-1));
    await sleep(400);
    const before = await listScroll(page);
    await backToApp(page);
    const { dialog, file } = await saveReport(ctx, 'Synthetic: shown after View in Settings', 'Scrolled into view');
    await dialog.getByTestId('issue-open-settings').click();
    const view = await landedOn(page, file);
    const top = (await listedNames(page))[0];
    record('MEM-29 with the list scrolled to the bottom, View in Settings scrolls the new report (top of the list) '
      + 'into view and selects it', before?.top > 0 && top === basename(file ?? '') && view.inView
      && view.selected === top, JSON.stringify({ before, top, view }));
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
}

/**
 * @brief 从左栏进 Customize 之后保存的报告：Recent activity 里最后一条以"Open Customize"开头的就是"Open Customize"
 *        （customize-agents-md.md"从侧栏进入 Customize"，2026-10-26 补；从记忆页进来时是"Open Customize → Instructions"，
 *        见 pageValues）。
 * @param file 在 Customize 里按 F8 保存的报告
 */
function sidebarOpenAction(file) {
  const { actions } = reportParts(file);
  const opened = actions.filter((text) => text.startsWith('Open Customize')).at(-1) ?? null;
  record('MEM-29 F8 Recent activity records "Open Customize" when Customize is opened from the sidebar (not '
    + '"Open Customize → Instructions", which is only for Edit in Customize on the Memory page)',
  opened === 'Open Customize', JSON.stringify({ opened, actions: actions.slice(-4) }));
}

/**
 * @brief 已经在设置页时"View in Settings"直接换到 UI issues 并选中；Customize 的 Instructions（用户级 AGENTS.md，
 *        2026-10-26 从设置页挪来）有未保存的改动时先出离开确认框："Keep editing"留在 Customize 的 Instructions、
 *        改动还在，"Discard"之后打开 UI issues 并选中。
 */
async function viewFromSettings(ctx) {
  const { page } = ctx;
  await openSettings(page);
  await chooseSection(page, 'models');
  const first = await saveReport(ctx, 'Synthetic: reported from Settings → Models', 'Switch to UI issues');
  await first.dialog.getByTestId('issue-open-settings').click();
  const switched = await landedOn(page, first.file);
  record('MEM-29 View in Settings from another settings section switches to UI issues and selects the new report',
    switched.dialog === 0 && switched.section === 'issues' && switched.selected === basename(first.file ?? ''),
    JSON.stringify(switched));
  await page.getByTestId('nav-tools').click();
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await page.getByTestId('tools-page').getByTestId('agents-section').waitFor({ timeout: 10000 });
  const editor = page.getByTestId('agents-editor');
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-editor"]')?.disabled === false, null,
    { timeout: 15000 });
  const draft = `${await editor.inputValue()}\nSynthetic unsaved line`;
  await editor.fill(draft);
  const second = await saveReport(ctx, 'Synthetic: reported with unsaved AGENTS.md', 'Ask before leaving');
  sidebarOpenAction(second.file);
  await second.dialog.getByTestId('issue-open-settings').click();
  const leave = page.getByTestId('leave-dialog');
  const asked = await leave.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const texts = asked ? (await leave.locator('button').allInnerTexts()).map((text) => text.trim()) : [];
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await leave.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const kept = { customize: await page.getByTestId('tools-page').count(), value: await editor.inputValue(),
    section: await page.locator('[data-testid="tools-nav"] [aria-current="page"]').getAttribute('data-section')
      .catch(() => null), dialog: await page.getByTestId('issue-dialog').count() };
  record('MEM-29 View in Settings with unsaved edits in Customize › Instructions asks first (leave-dialog: Discard / '
    + 'Keep editing); Keep editing stays on Customize › Instructions with the edits', asked && texts.includes('Discard')
    && texts.includes('Keep editing') && kept.customize === 1 && kept.section === 'agents' && kept.value === draft
    && kept.dialog === 0,
  JSON.stringify({ asked, texts, kept: { ...kept, value: kept.value === draft } }));
  const third = await saveReport(ctx, 'Synthetic: reported again with unsaved AGENTS.md', 'Discard and go');
  await third.dialog.getByTestId('issue-open-settings').click();
  await leave.waitFor({ timeout: 5000 });
  await leave.getByRole('button', { name: 'Discard' }).click();
  const landed = await landedOn(page, third.file);
  record('MEM-29 … Discard then opens UI issues with the new report selected', landed.dialog === 0
    && landed.section === 'issues' && landed.selected === basename(third.file ?? ''), JSON.stringify(landed));
}

// ---------- 步骤：已处理与"Hide resolved" ----------

/** @brief Resolve：变淡、标"Resolved"、标题上的数字少一、按钮变"Reopen"、本机存了（M7 的标记还在）。 */
async function handled(ctx) {
  const { page } = ctx;
  ctx.snap = snapshot(issuesDir(ctx));
  const name = basename(ctx.issue1);
  const open = Number((await issuesState(page)).count);
  await selectRow(page, name);
  await page.getByTestId('detail-handled').click();
  await until(async () => (await issuesState(page)).rows.find((row) => row.name === name)?.handled, 3000);
  const state = await issuesState(page);
  const row = state.rows.find((item) => item.name === name);
  const dim = await rowDim(page, [name, WHAT1], [SEED.onlyExpect, 'Synthetic: only what you expected']);
  const detail = await detailState(page);
  record('MEM-28 Resolve: the row is dimmed and tagged "Resolved", the heading count drops by one (aria-label too), '
    + 'the button becomes Reopen', Boolean(row?.handled) && row.tag === 'Resolved' && dim.dim
    && state.count === String(open - 1) && state.label === `UI issues, ${open - 1} unresolved`
    && detail.handled === 'Reopen', JSON.stringify({ row: row && { ...row, text: undefined }, dim, count: state.count,
    button: detail.handled }));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mori.review') ?? 'null'));
  record('MEM-28 resolved marks are kept in localStorage mori.review as ui-issues/<file>, with the M7 mark still '
    + 'there; Hide resolved is off by default', Array.isArray(stored?.handled)
    && stored.handled.includes(`ui-issues/${name}`) && stored.handled.includes(`ui-issues/${SEED.premarked}`)
    && stored.hideHandled === false, JSON.stringify(stored));
  await noteSmall(ctx, 'resolved row');
  await shot(page, '5-resolved');
}

/** @brief 打开"Hide resolved"：已处理的不列出、数字不变、详情还在；马上"Reopen"又列出；再 Resolve 详情不消失。 */
async function hideHandled(ctx) {
  const { page } = ctx;
  const name = basename(ctx.issue1);
  const before = await issuesState(page);
  const unresolved = before.rows.filter((row) => !row.handled).length;
  await page.getByTestId('issues-hide-handled').click();
  const hidden = await issuesState(page);
  const kept = await detailState(page);
  record('MEM-28 Hide resolved on: resolved reports are not listed, the heading count stays the unresolved count, '
    + 'the open detail stays (button Reopen)', hidden.hide.checked === 'true' && !hidden.rows.some((row) => row.handled)
    && hidden.rows.length === unresolved && hidden.count === before.count && kept?.what === WHAT1
    && kept.handled === 'Reopen', JSON.stringify({ hide: hidden.hide, rows: hidden.rows.length, unresolved,
    count: hidden.count, kept: kept?.handled }));
  await page.getByTestId('detail-handled').click();
  const back = await issuesState(page);
  const row = back.rows.find((item) => item.name === name);
  record('MEM-28 Reopen with Hide resolved on: the row is listed again, not tagged, and counted again', Boolean(row)
    && !row.handled && !row.tag && back.count === String(Number(before.count) + 1),
  JSON.stringify({ row: row && { ...row, text: undefined }, count: back.count }));
  await page.getByTestId('detail-handled').click();
  const again = await issuesState(page);
  const still = await detailState(page);
  record('MEM-28 Resolve with Hide resolved on: the row disappears at once but its detail stays (button Reopen)',
    !again.rows.some((item) => item.name === name) && still?.handled === 'Reopen',
    JSON.stringify({ rows: again.rows.length, still: still?.handled }));
  await page.getByTestId('issues-detail').getByRole('button', { name: 'Close details' }).click();
  await settle(page);
  const focus = await page.evaluate(() => Boolean(document.activeElement?.matches(
    '[data-testid="settings-nav"] [data-section="issues"]')));
  record('MEM-28 closing that detail (its row is not listed) puts focus on the UI issues section button', focus,
    String(focus));
}

/** @brief 全部 Resolve：都已隐藏的说明、导出不可用、没有数字；"Show resolved"全部列出；之后留两份未处理、开关打开。 */
async function allHidden(ctx) {
  const { page } = ctx;
  for (const name of await listedNames(page)) {
    await selectRow(page, name);
    await page.getByTestId('detail-handled').click();
    await until(async () => !(await listedNames(page)).includes(name), 3000);
  }
  const state = await issuesState(page);
  const total = expectedNames(ctx).length;
  const link = await page.getByTestId('issues-page').getByRole('button', { name: 'Show resolved' }).count();
  record('MEM-28 all resolved and hidden: "No unresolved records · N resolved records hidden" with Show resolved, '
    + 'export disabled, no count on the heading', state.allHidden === `No unresolved records · ${total} resolved ${
    total === 1 ? 'record' : 'records'} hidden` && state.rows.length === 0 && state.exportDisabled === true
    && state.count === null && state.label === 'UI issues, 0 unresolved' && link === 1,
  JSON.stringify({ ...state, rows: state.rows.length, link }));
  await shot(page, '5-all-hidden');
  await page.getByTestId('issues-page').getByRole('button', { name: 'Show resolved' }).click();
  const shown = await issuesState(page);
  record('MEM-28 Show resolved turns Hide resolved off: every report is listed and tagged Resolved',
    shown.hide.checked === 'false' && shown.rows.length === total
    && shown.rows.every((row) => row.handled && row.tag === 'Resolved'), JSON.stringify(shown.rows.map((row) =>
    [row.name, row.handled])));
  ctx.open = [basename(ctx.issue1), SEED.onlyExpect];
  for (const name of ctx.open) {
    await selectRow(page, name);
    await page.getByTestId('detail-handled').click();
  }
  await page.getByTestId('issues-hide-handled').click();
}

/** @brief 重启后标记和开关都还在；打开、标记、重启都没有改报告文件。 */
async function handledRestart(ctx) {
  await restart(ctx);
  const { page } = ctx;
  await openIssues(page);
  const state = await issuesState(page);
  record('MEM-28 after a restart the resolved marks and Hide resolved are still there (mori.review)',
    state.hide.checked === 'true' && same(state.rows.map((row) => row.name), ctx.open)
    && state.count === String(ctx.open.length), JSON.stringify({ hide: state.hide, rows: state.rows.map((row) =>
    row.name), count: state.count }));
  const changed = changedFiles(ctx.snap, snapshot(issuesDir(ctx)));
  record('MEM-28 opening, resolving and restarting change no report file (size, time and content the same)',
    changed.length === 0, changed.join(', '));
}

// ---------- 步骤：导出与打开文件夹 ----------

/** @brief 取消保存对话框：什么都不变；对话框的标题和默认文件名（在"文档"里）。 */
async function exportCancel(ctx) {
  const { app, page } = ctx;
  const { dialog } = await exportTo(ctx, null);
  const documents = await app.evaluate(({ app: main }) => main.getPath('documents'));
  const notice = await page.getByTestId('issues-notice').count();
  record('MEM-28 Export as Markdown…: the save dialog is titled "Export as Markdown" with ui-issues-<today>.md in '
    + 'Documents', dialog?.title === 'Export as Markdown' && basename(dialog.defaultPath ?? '')
    === `ui-issues-${today()}.md` && samePath(dirname(dialog.defaultPath), documents),
  JSON.stringify({ dialog, documents }));
  record('MEM-28 cancelling the save dialog changes nothing (no file, no notice)', notice === 0
    && readdirSync(ctx.exportDir).length === 0, JSON.stringify({ notice, files: readdirSync(ctx.exportDir) }));
}

/**
 * @brief 开关开着时只导出列出的、顺序与列表相同；"Exported N records to <路径>"和 Show in Explorer；
 *        关掉开关后全部导出（checkExportAll）。
 */
async function exportListed(ctx) {
  const { app, page } = ctx;
  const listed = await listedNames(page);
  const target = join(ctx.exportDir, 'issues-listed.md');
  const { md } = await exportTo(ctx, target);
  const head = mdHead(md);
  const sections = mdSections(md);
  record('MEM-28 export with Hide resolved on: only the listed reports, in list order and numbered; "# UI issues" and '
    + '"Exported … · N records: N unresolved, 0 resolved"', head.title === '# UI issues' && head.total === listed.length
    && head.open === listed.length && head.done === 0 && same(sections.map((item) => item.name), listed)
    && sections.every((item, index) => item.heading.startsWith(`## ${index + 1}. `)),
  JSON.stringify({ head, names: sections.map((item) => item.name) }));
  const notice = await noticeText(page, 'Exported ');
  await app.evaluate(clearShell);
  await page.getByTestId('issues-notice').getByRole('button', { name: 'Show in Explorer' }).click();
  const revealed = await firstRevealed(app);
  record('MEM-28 exported: "Exported N records to <path>" below the toolbar; its Show in Explorer selects the file',
    notice.startsWith(`Exported ${records(listed.length)} to ${target}`) && samePath(revealed, target),
    JSON.stringify({ notice, revealed }));
  await noteSmall(ctx, 'exported');
  await page.getByTestId('issues-hide-handled').click();
  const all = await listedNames(page);
  const { md: full } = await exportTo(ctx, join(ctx.exportDir, 'issues-all.md'));
  checkExportAll(ctx, full, all);
}

/** @brief 全部导出：每份注明 Resolved / Unresolved、各节降一级、截图的相对链接、读不出来的一节、不复制截图。 */
function checkExportAll(ctx, md, listed) {
  const head = mdHead(md);
  const sections = mdSections(md);
  const byName = Object.fromEntries(sections.map((item) => [item.name, item]));
  const first = basename(ctx.issue1);
  record('MEM-28 export with Hide resolved off: every report in list order, each marked Resolved or Unresolved '
    + '("N records: a unresolved, b resolved")', head.total === listed.length && head.open === ctx.open.length
    && head.done === listed.length - ctx.open.length && same(sections.map((item) => item.name), listed)
    && Boolean(byName[first]?.heading.endsWith(' · Unresolved'))
    && Boolean(byName[SEED.noShot]?.heading.endsWith(' · Resolved')), JSON.stringify(head));
  const text = byName[first]?.text ?? '';
  const titles = ['What went wrong', 'What you expected', 'Screenshot', 'Current view', 'Recent activity', 'Versions'];
  record('MEM-28 an exported report: "## n. <time> · <state>", "- Report file: <full path>", then its sections one '
    + 'level down (### What went wrong … ### Versions)', text.split('\n')[0] === `## ${listed.indexOf(first) + 1}. ${
    reportTime(ctx.issue1)} · Unresolved` && text.includes(`- Report file: ${ctx.issue1}`)
    && titles.every((title) => text.includes(`\n### ${title}\n`))
    && !new RegExp(`^## (${titles.join('|')})$`, 'm').test(md), oneLine(text, 300));
  const link = shotLink(text);
  const target = (href) => href && resolve(ctx.exportDir, ...href.split('/').map(decodeURIComponent));
  const deleted = shotLink(byName[SEED.onlyExpect]?.text ?? '');
  record('MEM-28 screenshot links are relative from the export folder to the original PNG (/ separated, each part '
    + 'URL-encoded), also for a deleted PNG; a report without one says "Couldn’t capture a screenshot: …"',
  Boolean(link) && !isAbsolute(link) && !link.includes('\\') && samePath(target(link), ctx.issue1.replace(/\.md$/,
    '.png')) && samePath(target(deleted), join(issuesDir(ctx), SEED.onlyExpect.replace(/\.md$/, '.png')))
    && Boolean(byName[SEED.noShot]?.text.includes('Couldn’t capture a screenshot: Synthetic capture failure')),
  `${link} | ${deleted}`);
  const broken = byName[SEED.brokenMd];
  record('MEM-28 an unreadable report in the export: "## n. <file> · <state>", its Record file and "Couldn’t read '
    + 'this record: <error>"', Boolean(broken?.heading.includes(SEED.brokenMd))
    && broken.text.includes('Couldn’t read this record: '), oneLine(broken?.text ?? '', 300));
  record('MEM-28 export never copies screenshots (only the exported .md files in the export folder)',
    readdirSync(ctx.exportDir).every((name) => name.endsWith('.md')), JSON.stringify(readdirSync(ctx.exportDir)));
}

/** @brief 导出到 ui-issues 文件夹里：截图链接就是文件名；只多这一个 .md，重新读取后它不在列表里。 */
async function exportIntoIssues(ctx) {
  const { page } = ctx;
  const target = join(issuesDir(ctx), `ui-issues-${today()}.md`);
  const fresh = !existsSync(target);
  const before = snapshot(issuesDir(ctx));
  const { md } = await exportTo(ctx, target);
  const first = mdSections(md).find((item) => item.name === basename(ctx.issue1))?.text ?? '';
  const added = changedFiles(before, snapshot(issuesDir(ctx)));
  await rereadIssues(page);
  const names = await listedNames(page);
  ctx.exported = basename(target);
  record('MEM-28 export into the ui-issues folder: screenshot links are plain file names; only that .md is added '
    + '(no screenshot copied) and it is not listed after a re-read', fresh && shotLink(first)
    === basename(ctx.issue1).replace(/\.md$/, '.png') && same(added, [ctx.exported]) && !names.includes(ctx.exported),
  JSON.stringify({ fresh, link: shotLink(first), added }));
}

/** @brief 导出失败（主进程写文件报错）："Couldn’t export: "和原文。 */
async function exportFailure(ctx) {
  await exportTo(ctx, join(ctx.root, 'synthetic-missing-folder', 'x.md'), false);
  const notice = await noticeText(ctx.page, 'Couldn’t export: ');
  record('MEM-28 export fails: "Couldn’t export: <original error>" below the toolbar', notice.startsWith(
    'Couldn’t export: ') && /ENOENT/.test(notice), notice);
}

/** @brief 有报告时"Open folder"：打开 <userData>\ui-issues\。 */
async function openFolders(ctx) {
  const { app, page } = ctx;
  await app.evaluate(clearShell);
  await page.getByTestId('issues-open-folder').click();
  const opened = await firstOpened(app);
  record('MEM-28 Open folder with reports: Explorer opens <userData>\\ui-issues\\', samePath(opened, issuesDir(ctx)),
    String(opened));
}

/** @brief 反例：UI issues 里的操作都没有发请求给模型；报告文件没变，文件夹里只多了选的那一个导出文件。 */
async function untouched(ctx) {
  await sleep(300);
  const changed = changedFiles(ctx.snap, snapshot(issuesDir(ctx)));
  record('MEM-28 nothing on Settings → UI issues sends a model request (the synthetic endpoint got no chat request)',
    chatRequests(ctx) === 0, `chat requests ${chatRequests(ctx)}`);
  record('MEM-28 exporting changes no report; ui-issues only gains the one exported .md you chose',
    same(changed, [ctx.exported]), changed.join(', '));
}

// ---------- 步骤：右栏宽度、窄窗口 ----------

/** @brief 详情与会话的右栏共用宽度；键盘调整分隔线后保存，会话的右栏也跟着。 */
async function detailWidth(ctx) {
  const { page } = ctx;
  await backToApp(page);
  if (!(await page.locator('.pane-slot').count())) ctx.tab = await openProject(ctx, ctx.project, { trust: true });
  if (!(await page.getByTestId('right-panel').count())) {
    await page.locator('.pane-slot:not([hidden])').getByRole('button', { name: 'Toggle changes' }).click();
  }
  await page.getByTestId('right-panel').waitFor({ timeout: 5000 });
  const panel = await panelWidth(page, 'right-panel');
  await openIssues(page);
  await selectRow(page, basename(ctx.issue1));
  const detail = await panelWidth(page, 'issues-detail');
  record('MEM-28 the detail shares its width with the session right panel', Boolean(panel && detail)
    && Math.abs(panel.width - detail.width) <= 2 && panel.now === detail.now, JSON.stringify({ panel, detail }));
  await page.locator('[data-testid="issues-detail"] [data-resize="workspace"]').focus();
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  const wider = await panelWidth(page, 'issues-detail');
  const saved = (await savedLayout(page)).workspace;
  await backToApp(page);
  const after = await panelWidth(page, 'right-panel');
  record('MEM-28 resizing the detail with the keyboard saves the width (mori.layout) and the session right panel '
    + 'uses it', wider?.now === Math.min((detail?.now ?? 0) + 20, detail?.max ?? 0) && saved === wider.now
    && Math.abs((after?.width ?? 0) - wider.width) <= 2, JSON.stringify({ wider, saved, after }));
}

/** @brief 窗口窄于 800px 时详情浮在中栏上层（同会话的右栏）。 */
async function narrowDetail(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await openIssues(page);
  if (!(await page.getByTestId('issues-detail').count())) await selectRow(page, basename(ctx.issue1));
  try {
    await resizeWindow(app, 780, 700);
    const box = await page.evaluate(() => {
      const aside = document.querySelector('[data-testid="issues-detail"]');
      const center = document.querySelector('[data-testid="settings-page"]')?.getBoundingClientRect();
      const rect = aside?.getBoundingClientRect();
      return rect && center ? { left: Math.round(rect.left), centerRight: Math.round(center.right), width: innerWidth,
        position: getComputedStyle(aside).position } : null;
    });
    await shot(page, '6-narrow');
    record('MEM-28 in a window narrower than 800px the detail floats over the settings page (like the session right '
      + 'panel)', Boolean(box) && box.width < 800 && box.left < box.centerRight - 20 && box.position === 'absolute',
    JSON.stringify(box));
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
}

// ---------- 步骤：F8 的 Page 与动作记录 ----------

/**
 * @brief 在 UI issues 上做一遍各种操作再按 F8（右栏开着详情）：Current view 是"Page: Settings"、右栏打开和它的宽度，
 *        Recent activity 有 UI issues 的动作文字；保存后新报告马上在最上面；报告框的 View in Settings 选中它；
 *        "What you expected"里写的"## What you expected"一行加了转义，两节照样分清。
 */
async function f8OnSettings(ctx) {
  const { page } = ctx;
  await openIssues(page);
  await issueActions(ctx);
  const expect = 'The new report is at the top\n## What you expected\nSecond paragraph';
  const { dialog, file } = await saveReport(ctx, 'Synthetic: F8 on Settings → UI issues', expect);
  const name = basename(file ?? '');
  const top = await until(async () => (await listedNames(page))[0] === name, 5000);
  const parts = reportParts(file);
  record('MEM-29 F8 on Settings → UI issues writes "Page: Settings", with a report open "Right panel: Open" and its '
    + 'width; after saving, the new report is at the top without reopening the section', parts.view.Page === 'Settings'
    && parts.view['Right panel'] === 'Open' && /^\d+px/.test(parts.view['Right panel width'] ?? '') && Boolean(top),
  JSON.stringify({ view: parts.view, top }));
  const offPane = offPaneViewProblems(parts.fields);
  record('F8 on Settings → UI issues (from the F8-on-Review check of m7-app): Current view says "Pane width: None" '
    + '(not on the session page), right after Window size and before Sidebar width', offPane.length === 0,
  JSON.stringify({ offPane, fields: parts.fields }));
  const missing = ISSUE_ACTIONS.filter((text) => !parts.actions.includes(text));
  record('MEM-28 F8 Recent activity records the UI issues actions in M7 wording: View record: UI issues, Resolve, '
    + 'Reopen, Hide resolved, Show resolved, Export: UI issues, Open folder: UI issues, Show record in Explorer',
  missing.length === 0, JSON.stringify({ missing, actions: parts.actions }));
  await dialog.getByTestId('issue-open-settings').click();
  const landed = await landedOn(page, file);
  record('MEM-29 View in Settings while already on UI issues closes the dialog and selects the new report',
    landed.dialog === 0 && landed.selected === name, JSON.stringify(landed));
  const detail = await detailState(page);
  record('MEM-28 a "## What you expected" line you typed is escaped with "\\" in the report and UI issues still splits '
    + 'the two fields', /\n\\## What you expected\n/.test(parts.md) && detail?.what === 'Synthetic: F8 on Settings → '
    + 'UI issues' && (detail?.expect ?? '').startsWith('The new report is at the top')
    && detail.expect.includes('\\## What you expected') && detail.expect.includes('Second paragraph'),
  JSON.stringify({ what: detail?.what, expect: detail?.expect }));
}

/**
 * @brief 在 UI issues 上把记进 Recent activity 的操作各做一遍，最后留下与之前相同的状态：选中一行、Resolve、Reopen、
 *        Hide resolved、Show resolved、导出（取消）、Open folder、Show in Explorer。
 */
async function issueActions(ctx) {
  const { app, page } = ctx;
  const hide = page.getByTestId('issues-hide-handled');
  if (await hide.getAttribute('aria-checked') === 'true') await hide.click();
  await selectRow(page, SEED.onlyExpect);
  await page.getByTestId('detail-handled').click();
  await page.getByTestId('detail-handled').click();
  await hide.click();
  await hide.click();
  await exportTo(ctx, null);
  await page.getByTestId('issues-open-folder').click();
  await selectRow(page, basename(ctx.issue1));
  await app.evaluate(clearShell);
  await page.getByTestId('detail-show-file').click();
  await firstRevealed(app);
}

/**
 * @brief F8 的 Current view 的 Page：记忆页"Memory"、工具页"Customize"；Recent activity 记下了"View in Settings"；
 *        这次运行里保存的报告都没有"Page: Review"。从记忆页 AGENT 的"Edit in Customize"进 Customize（2026-10-26，
 *        customize-agents-md.md）：落在最后一节 Instructions，Recent activity 记"Open Customize → Instructions"。
 */
async function pageValues(ctx) {
  const { page } = ctx;
  await page.getByTestId('nav-memory').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  await sleep(500);
  const memory = await saveReport(ctx, 'Synthetic: F8 on the Memory page', 'Page: Memory');
  await closeReport(memory.dialog);
  await page.getByTestId('memory-section-agent').click();
  await page.getByTestId('memory-page').getByRole('button', { name: 'Edit in Customize', exact: true }).first().click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  await sleep(500);
  const landed = await page.evaluate(() => document.querySelector('[data-testid="tools-nav"] [aria-current="page"]')
    ?.dataset.section ?? null);
  const tools = await saveReport(ctx, 'Synthetic: F8 on the Customize page', 'Page: Customize');
  await closeReport(tools.dialog);
  const pages = ctx.reports.map((file) => reportParts(file).view.Page ?? null);
  const memoryParts = reportParts(memory.file);
  const toolsParts = reportParts(tools.file);
  record('MEM-29 F8 Current view Page: "Memory" on the Memory page and "Customize" on the Customize page; '
    + 'with "Session" and "Settings" seen above, no report of this run says "Review"',
  memoryParts.view.Page === 'Memory' && toolsParts.view.Page === 'Customize' && pages.includes('Session')
    && pages.includes('Settings') && !pages.includes('Review') && !pages.includes(null), JSON.stringify(pages));
  record('MEM-29 F8 Recent activity records "View in Settings" after you used it', memoryParts.actions.includes(
    'View in Settings'), JSON.stringify(memoryParts.actions));
  const lastOpen = toolsParts.actions.filter((text) => text.startsWith('Open Customize')).at(-1) ?? null;
  record('MEM-16 Memory → AGENT → Edit in Customize lands on Customize › Instructions (its last section), and F8 '
    + 'Recent activity records "Open Customize → Instructions" for it (not "Open Customize")', landed === 'agents'
    && lastOpen === 'Open Customize → Instructions', JSON.stringify({ landed, lastOpen,
    actions: toolsParts.actions.slice(-4) }));
  const offPane = [...offPaneViewProblems(memoryParts.fields), ...offPaneViewProblems(reportParts(tools.file).fields)];
  record('F8 on the Memory page and on the Customize page: Current view says "Pane width: None", right after Window '
    + 'size and before Sidebar width', offPane.length === 0, JSON.stringify(offPane));
}

// ---------- 步骤：后台进程退出、字号、首次启动 ----------

/**
 * @brief 后台进程退出后：全局退出横幅，设置页 UI issues 照常可用（主进程读）：列表、详情与截图、Resolve / Reopen、
 *        导出、Open folder、Show in Explorer；F8 的 View in Settings 照常打开并选中。
 */
async function kernelExit(ctx) {
  const { app, page } = ctx;
  await openIssues(page);
  killKernel(app);
  const banner = await page.locator('.global-banner [data-testid="kernel-exit"]').waitFor({ timeout: 15000 })
    .then(() => true, () => false);
  await rereadIssues(page);
  const state = await issuesState(page);
  await selectRow(page, basename(ctx.issue1));
  const shotOk = await page.waitForFunction(() => document.querySelector('[data-testid="detail-shot"]')
    ?.naturalWidth > 0, null, { timeout: 10000 }).then(() => true, () => false);
  await shot(page, '7-kernel-exit');
  record('MEM-28 after the background process exits: the global exit banner is shown and Settings → UI issues still '
    + 'lists every report (read by the main process) and opens one with its screenshot', banner
    && same(state.rows.map((row) => row.name), expectedNames(ctx)) && !state.error && shotOk,
  JSON.stringify({ banner, rows: state.rows.length, error: state.error, shotOk }));
  await exitActions(ctx);
  await backToApp(page);
  const { dialog, file } = await saveReport(ctx, 'Synthetic: reported after the background process exited',
    'View in Settings still works');
  await dialog.getByTestId('issue-open-settings').click();
  const landed = await landedOn(page, file);
  record('MEM-29 after the background process exits, F8 → View in Settings still opens UI issues with the new report '
    + 'selected', landed.dialog === 0 && landed.section === 'issues' && landed.selected === basename(file ?? ''),
  JSON.stringify(landed));
}

/** @brief 后台进程退出后：Resolve / Reopen、导出、Open folder、Show in Explorer 照常。 */
async function exitActions(ctx) {
  const { app, page } = ctx;
  const name = basename(ctx.issue1);
  const handledNow = async () => (await issuesState(page)).rows.find((row) => row.name === name)?.handled;
  await page.getByTestId('detail-handled').click();
  const marked = await until(handledNow, 3000);
  await page.getByTestId('detail-handled').click();
  const reopened = await until(async () => (await handledNow()) === false, 3000);
  const { md } = await exportTo(ctx, join(ctx.exportDir, 'after-exit.md'));
  await app.evaluate(clearShell);
  await page.getByTestId('issues-open-folder').click();
  const opened = await firstOpened(app);
  await page.getByTestId('detail-show-file').click();
  const revealed = await firstRevealed(app);
  record('MEM-28 after the background process exits you can still Resolve and Reopen, export, Open folder and Show '
    + 'in Explorer', Boolean(marked) && Boolean(reopened) && md.startsWith('# UI issues')
    && samePath(opened, issuesDir(ctx)) && samePath(revealed, ctx.issue1),
  JSON.stringify({ marked, reopened, md: md.length, opened, revealed }));
}

/** @brief 设置页的 UI issues 没有小于 12px 的字。 */
async function fontSizes(ctx) {
  record(`MEM-28 no text smaller than 12px in UI issues (${ctx.smallChecked.join(', ')})`, ctx.small.length === 0
    && ctx.smallChecked.length > 0, ctx.small.slice(0, 6).join('; '));
}

/** @brief 首次启动页上按 F8 保存：报告框里没有"View in Settings"（还没有设置页），Current view 写"Page: First run"。 */
async function firstRunNoLink(ctx) {
  await closeApp(ctx);
  const userData = mkdtempSync(join(tmpdir(), 'mori-mem-settings-first-'));
  ctx.firstApp = await launch({ exePath, userData });
  const page = await ctx.firstApp.firstWindow();
  page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  const { dialog, file, buttons } = await saveReport(ctx, 'Synthetic: reported on the first-run page',
    'No View in Settings here', page);
  const parts = reportParts(file);
  record('MEM-29 on the first-run page the saved report has no View in Settings (no Settings page yet) and '
    + 'Current view says "Page: First run"', Boolean(file) && buttons.includes('Show in Explorer')
    && !buttons.includes('View in Settings') && await dialog.getByTestId('issue-open-settings').count() === 0
    && parts.view.Page === 'First run', JSON.stringify({ buttons, page: parts.view.Page }));
  await Promise.race([ctx.firstApp.close().catch(() => {}), sleep(20000)]);
  ctx.firstApp = null;
}

// ---------- 主流程 ----------

const steps = {
  setup, entryDefault, readFailure, folderEmpty, f8Report, seeded, issueRows, noWatch, issueDetail, shotViewer,
  brokenDetail, keyboardRows, sectionMemory, revealSaved, viewFromSettings, handled, hideHandled, allHidden,
  handledRestart, exportCancel, exportListed, exportIntoIssues, exportFailure, openFolders, untouched, detailWidth,
  narrowDetail, f8OnSettings, pageValues, kernelExit, fontSizes, firstRunNoLink,
};
/** 流程出错时记在哪个编号下（其余为 MEM-28） */
const STEP_ID = { f8Report: 'MEM-29', revealSaved: 'MEM-29', viewFromSettings: 'MEM-29', pageValues: 'MEM-29',
  firstRunNoLink: 'MEM-29' };

const { root, project } = prepareProject('mori-mem-settings-');
const userData = mkdtempSync(join(tmpdir(), 'mori-mem-settings-data-'));
const exportDir = join(root, 'export');
mkdirSync(exportDir, { recursive: true });
const ctx = { root, project, userData, exportDir, logs: [], pageErrors: [], small: [], smallChecked: [], reports: [] };
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && name !== 'setup' && !only.includes(name)) continue;
    console.log(`[mem-app-settings] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${STEP_ID[name] ?? 'MEM-28'} ${name}: flow`, false, oneLine(error?.stack ?? error, 400));
      await shot(ctx.page, `${name}-error`);
      await recover(ctx);
    }
  }
} finally {
  record('MEM-28 the page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await closeApp(ctx);
  await ctx.firstApp?.close().catch(() => {});
  if (ctx.endpoint) await stopEndpoint(ctx.endpoint);
}
console.log(`[mem-app-settings] project in ${project}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`${only ? 'mem-partial-app-settings' : 'mem-app-settings'}${suffix}.json`) ? 0 : 1;
