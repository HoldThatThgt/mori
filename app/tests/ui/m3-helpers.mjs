// M3 整机测试（m3-app.mjs、m3-app-live.mjs）共用的小工具：路径与会话文件、等待、会话树与焦点、菜单、信任询问、
// 拿住文件不让删除、系统回收站。只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import koffi from 'koffi';
import { sleep } from './lib.mjs';

/** @brief 当前显示的会话面板（隐藏的会话面板仍然挂载，找元素都限定在这里） */
export const PANE = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';
/** @brief 会话名取第一条消息的前几个字 */
export const TITLE_LENGTH = 20;
/** @brief 停止后对话流里的提示 */
export const STOPPED = '已停止 · 已经做出的修改不会自动撤销';

// ---------- 路径与会话文件 ----------

/** @brief 两个路径是否指向同一个文件（Windows 不区分大小写）。 */
export const samePath = (a, b) => Boolean(a && b) && resolve(a).toLowerCase() === resolve(b).toLowerCase();
/** @brief 文字压成一行、去掉首尾空白后的字（按码点）。 */
const chars = (text) => [...text.replace(/\s+/g, ' ').trim()];
/** @brief 没有名字时显示的会话名：前 20 个字，超出加"…"。 */
export const titleOf = (text) => (chars(text).length > TITLE_LENGTH
  ? `${chars(text).slice(0, TITLE_LENGTH).join('')}…` : chars(text).join(''));
/** @brief 改名框预先填的名字：前 20 个字，不带"…"。 */
export const prefillOf = (text) => chars(text).slice(0, TITLE_LENGTH).join('');

/** @brief 会话文件里全部 session_info 记录的名字（按写入顺序）。 */
export function sessionNames(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((entry) => entry?.type === 'session_info').map((entry) => entry.name);
}

/** @brief pi 的 trust.json 里 folder 的记录；没有时为 undefined。 */
export function trustRecord(userData, folder) {
  const file = join(userData, 'pi', 'trust.json');
  if (!existsSync(file)) return undefined;
  const records = JSON.parse(readFileSync(file, 'utf8'));
  const real = realpathSync.native(folder);
  const key = Object.keys(records).find((item) => samePath(item, real) || samePath(item, folder));
  return key === undefined ? undefined : records[key];
}

/** @brief root 下（含子文件夹）文件名为 name 的全部文件。 */
export function findByName(root, name) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).map(String).filter((path) => basename(path) === name)
    .map((path) => join(root, path));
}

/** @brief 系统回收站里全部项目的原文件名（Shell.Application 的回收站命名空间）。 */
export function recycleBinNames() {
  const script = '(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.Name }';
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const kernel32 = koffi.load('kernel32.dll');
const CreateFileW = kernel32.func(
  'void* __stdcall CreateFileW(str16, uint32_t, uint32_t, void*, uint32_t, uint32_t, void*)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)');
const GENERIC_READ = 0x80000000;
/** FILE_SHARE_READ | FILE_SHARE_WRITE，不含 FILE_SHARE_DELETE */
const SHARE_READ_WRITE = 3;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;

/**
 * @brief 打开 file 并一直拿着，只允许别人读写、不允许删除（不给 FILE_SHARE_DELETE）：pi 照样能读写它（会话列表读得到），
 *        但删不掉（EBUSY）。Electron 44（Node 24）的 fs.rm 删只读文件时会先去掉只读属性，chmod 0o444 造不出删除失败，
 *        所以用这个。返回放开它的函数。
 */
export function holdFile(file) {
  const handle = CreateFileW(file, GENERIC_READ, SHARE_READ_WRITE, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null);
  const address = handle ? koffi.address(handle) : 0n;
  if (address === 0n || address === 0xFFFFFFFFFFFFFFFFn) throw new Error(`cannot hold ${file}`);
  return () => CloseHandle(handle);
}

/** @brief 等 fn() 为真，最多 timeoutMs；返回最后一次的结果。 */
export async function until(fn, timeoutMs = 10000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let value = await fn();
  while (!value && Date.now() < deadline) {
    await sleep(stepMs);
    value = await fn();
  }
  return value;
}

// ---------- 页面上的小工具 ----------

/** @brief 当前显示的会话面板。 */
export const paneOf = (page) => page.locator(PANE);
/** @brief 会话文件为 file 的会话行（属性值按 CSS 字符串写，反斜杠要转义，JSON 的写法正好可用）。 */
export const rowOf = (page, file) => page.locator(`.session-item[data-file=${JSON.stringify(file)}]`);
/** @brief 会话面板的个数（每个本次打开的会话一个）。 */
export const paneCount = (page) => page.locator('.pane-slot').count();
/** @brief 当前会话行的会话文件。 */
export const activeFile = (page) => page.locator('.session-item.active').first()
  .getAttribute('data-file', { timeout: 5000 });
/** @brief 当前会话顶栏的会话名。 */
export const topTitle = (page) => paneOf(page).getByTestId('session-title').innerText({ timeout: 5000 });
/** @brief 当前会话面板里最后一条助手回复。 */
export const lastReply = (page) => paneOf(page).getByTestId('assistant').last().innerText({ timeout: 5000 })
  .catch(() => '');
/** @brief 当前会话面板里"已停止"提示的条数。 */
export const stoppedCount = (page) => paneOf(page).getByTestId('notice').filter({ hasText: STOPPED }).count();
/** @brief 本机保存的草稿（localStorage 的 mori.drafts）。 */
export const savedDrafts = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mori.drafts') ?? '{}'));
/** @brief 草稿里有没有某个会话文件的。 */
export const hasDraft = (drafts, file) => Object.keys(drafts).some((key) => samePath(key, file));
/** @brief 本机记下的已归档会话文件（localStorage 的 mori.archived）。 */
export const savedArchived = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mori.archived') ?? '[]'));

/** @brief 会话树：项目（工作目录、文件夹名、悬停提示）和其中的会话行（不含"已归档"里的）。 */
export function treeState(page) {
  const selector = '[data-testid="session-tree"] .project-group';
  return page.evaluate((groups) => [...document.querySelectorAll(groups)].map((group) => {
    const heading = group.querySelector('.project-heading');
    return { cwd: group.dataset.cwd, name: heading?.textContent?.trim() ?? '',
      tip: heading?.getAttribute('title') ?? '',
      rows: [...group.querySelectorAll('.session-item')].map((row) => {
        const label = row.querySelector('.session-label');
        const status = row.querySelector('[data-testid="session-status"]');
        const style = label ? getComputedStyle(label) : null;
        return { id: row.dataset.row, file: row.dataset.file, title: label?.textContent ?? '',
          full: row.getAttribute('title') ?? '', active: row.classList.contains('active'), tabIndex: row.tabIndex,
          status: status?.dataset.status ?? null, statusText: status?.textContent?.trim() ?? '',
          nowrap: style?.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis',
          statusRight: Boolean(status && label
            && status.getBoundingClientRect().left >= label.getBoundingClientRect().right - 1) };
      }) };
  }), selector);
}

/** @brief 会话树里的全部会话行（按显示顺序），每行带上所在项目的工作目录。 */
export async function allRows(page) {
  return (await treeState(page)).flatMap((group) => group.rows.map((row) => ({ ...row, cwd: group.cwd })));
}

/** @brief 会话文件为 file 的会话行；不在项目下时为 null。 */
export async function rowState(page, file) {
  return (await allRows(page)).find((row) => samePath(row.file, file)) ?? null;
}

/** @brief 侧栏底部的"已归档"：开关的文字、是否展开、列表里的行（会话文件、会话名、悬停提示）。 */
export function archivedState(page) {
  return page.evaluate(() => {
    const toggle = document.querySelector('[data-testid="archived-toggle"]');
    const rows = [...document.querySelectorAll('[data-testid="archived-list"] .session-item.archived')];
    return { toggle: toggle?.textContent?.trim() ?? null, expanded: toggle?.getAttribute('aria-expanded') === 'true',
      rows: rows.map((row) => ({ file: row.dataset.file, title: row.querySelector('.session-label')?.textContent ?? '',
        tip: row.getAttribute('title') ?? '' })) };
  });
}

/** @brief 等"已归档"开关的文字变成 text（null 表示开关不在）。 */
export function waitArchivedToggle(page, text, timeout = 10000) {
  return until(async () => (await archivedState(page)).toggle === text, timeout);
}

/** @brief "已归档"收起时点开它，等列表出现。 */
export async function expandArchived(page) {
  if (!(await archivedState(page)).expanded) await page.getByTestId('archived-toggle').click();
  await page.getByTestId('archived-list').waitFor({ timeout: 5000 });
}

/**
 * @brief 等两帧：界面在打开会话、关闭菜单或对话框后用 requestAnimationFrame 移动焦点，
 *        读焦点或接着按键之前先让它落定，免得测试的下一步按键落在旧位置、随后焦点又被移走。
 */
export function settle(page) {
  return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** @brief 焦点所在的元素。 */
export async function focusInfo(page) {
  await settle(page);
  return page.evaluate((selector) => {
    const el = document.activeElement;
    return { row: el?.dataset?.row ?? null, file: el?.dataset?.file ?? null, testid: el?.dataset?.testid ?? null,
      role: el?.getAttribute?.('role') ?? null, type: el?.getAttribute?.('type') ?? null,
      label: el?.getAttribute?.('aria-label') ?? null, text: (el?.textContent ?? '').trim().slice(0, 30),
      tag: el?.tagName?.toLowerCase() ?? null,
      composer: el === document.querySelector(`${selector} .composer textarea`) };
  }, PANE);
}

/** @brief 等当前会话面板就绪（没有"正在启动…"之类的说明）。 */
export function waitReady(page, timeout = 30000) {
  return page.waitForFunction((selector) => {
    const pane = document.querySelector(selector);
    return Boolean(pane && !pane.querySelector('[data-testid="not-ready"]'));
  }, PANE, { timeout });
}

/** @brief 等会话面板的个数变成 count。 */
export function waitPanes(page, count, timeout = 30000) {
  return page.waitForFunction((want) => document.querySelectorAll('.pane-slot').length === want, count, { timeout });
}

/** @brief 等当前会话本轮结束（已知本轮已经开始时用）。 */
export function waitIdle(page, timeout = 60000) {
  return page.waitForFunction((selector) => {
    const pane = document.querySelector(selector);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="stage"]');
  }, PANE, { timeout });
}

/** @brief 等当前会话开始生成。 */
export function waitRunning(page, timeout = 20000) {
  return page.waitForFunction((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE,
    { timeout });
}

/** @brief 等焦点在当前会话的输入框里（最多 timeout 毫秒）。 */
export function waitComposerFocus(page, timeout = 2000) {
  return page.waitForFunction((selector) => document.activeElement
    === document.querySelector(`${selector} .composer textarea`), PANE, { timeout }).then(() => true, () => false);
}

/** @brief 等会话行显示 title。 */
export function waitRowTitle(page, file, title, timeout = 10000) {
  return page.waitForFunction(({ selector, want }) => document.querySelector(selector)
    ?.querySelector('.session-label')?.textContent === want,
  { selector: `.session-item[data-file=${JSON.stringify(file)}]`, want: title }, { timeout })
    .then(() => true, () => false);
}

/** @brief 等会话行的状态变成 status（null 表示没有状态）。 */
export function waitStatus(page, file, status, timeout = 20000) {
  return page.waitForFunction(({ selector, want }) => {
    const row = document.querySelector(selector);
    return Boolean(row) && (row.querySelector('[data-testid="session-status"]')?.dataset.status ?? null) === want;
  }, { selector: `.session-item[data-file=${JSON.stringify(file)}]`, want: status }, { timeout })
    .then(() => true, () => false);
}

/** @brief 发一条消息，等本轮开始再等它结束。 */
export async function sendWait(ctx, text, timeout = 60000) {
  await ctx.h.send(text);
  await ctx.h.idle(timeout);
}

/** @brief 点会话行（打开或切换），等它就绪。 */
export async function openRow(page, file) {
  await rowOf(page, file).click();
  await waitReady(page);
  await settle(page);
}

/** @brief 让系统的选文件夹对话框直接返回 folder。 */
export function stubFolder(app, folder) {
  return app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
}

/** @brief 点左栏"打开文件夹…"选 folder，等新会话面板出现（不等就绪：可能先弹信任询问）。 */
export async function clickOpenFolder(ctx, folder) {
  const before = await paneCount(ctx.page);
  await stubFolder(ctx.app, folder);
  await ctx.page.getByRole('button', { name: '打开文件夹…' }).first().click();
  await waitPanes(ctx.page, before + 1);
}

/** @brief 按 Ctrl+N 新建会话，等它就绪，返回它的会话文件。 */
export async function ctrlN(page) {
  const before = await paneCount(page);
  await page.keyboard.press('Control+n');
  await waitPanes(page, before + 1);
  await waitReady(page);
  return activeFile(page);
}

/**
 * @brief 后台进程里打开中的会话的信息和这一刻的样子（session.open 对已打开的会话直接返回它，不会再打开一次，
 *        也不改变界面）。只对后台进程里开着的会话用。
 */
export function kernelOpen(page, file) {
  return page.evaluate(async (sessionFile) => {
    const { entries: _entries, ...info } = await window.mori.request({ type: 'session.open', sessionFile });
    return info;
  }, file);
}

/** @brief 后台进程里打开中的会话的信任状态和工具。 */
export async function liveInfo(page, file) {
  const info = await kernelOpen(page, file);
  return { projectTrust: info.projectTrust, tools: info.tools };
}

/** @brief 后台进程是否已经没有这个会话标识（session.state 报 Unknown session）。 */
export function sessionGone(page, sessionId) {
  return page.evaluate((id) => window.mori.request({ type: 'session.state', sessionId: id })
    .then(() => false, (error) => String(error.message).includes('Unknown session')), sessionId);
}

/** @brief 当前会话面板里最后一张工具卡的状态和展开后的内容。 */
export async function lastToolCard(page) {
  const card = paneOf(page).getByTestId('tool-card').last();
  const status = await card.getAttribute('data-status', { timeout: 5000 });
  if (!(await card.evaluate((element) => element.open))) await card.locator('summary').click();
  const body = await card.locator('.tool-body').innerText({ timeout: 5000 }).catch(() => '');
  return { status, body };
}

// ---------- 菜单、改名框与确认框 ----------

/** @brief 焦点放到会话行（locator）上按 key（Shift+F10 或菜单键），等右键菜单出现。 */
export async function openMenuOn(page, row, key = 'Shift+F10') {
  await settle(page);
  await row.focus();
  await page.keyboard.press(key);
  const menu = page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  return menu;
}

/** @brief 焦点放到会话文件为 file 的会话行上按 key，等右键菜单出现。 */
export const openMenuByKey = (page, file, key = 'Shift+F10') => openMenuOn(page, rowOf(page, file), key);

/** @brief 在会话行上右键（不切换会话），等右键菜单出现；返回菜单和点的位置。 */
export async function openMenuByMouse(page, file) {
  await settle(page);
  const row = rowOf(page, file);
  const box = await row.boundingBox();
  const position = { x: 40, y: Math.round(box.height / 2) };
  await row.click({ button: 'right', position });
  const menu = page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  return { menu, at: { x: box.x + position.x, y: box.y + position.y }, rowBox: box };
}

/** @brief 菜单项：文字（不含小字）、旁边的小字、是否不可用。 */
export function menuItems(menu) {
  return menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => ({
    label: item.firstChild?.nodeType === 3 ? item.firstChild.textContent : '',
    hint: item.querySelector('.menu-hint')?.textContent ?? '', disabled: item.disabled })));
}

/** @brief 菜单项列成一行文字（失败时的说明用）。 */
export const menuText = (items) => items.map((item) => `${item.label}${item.disabled ? `(${item.hint})` : ''}`)
  .join(' / ');

/** @brief 键盘打开会话行的菜单，↓ 移到文字为 label 的菜单项再按 Enter；走不到时抛错。 */
export async function chooseMenuItem(page, file, label) {
  await openMenuByKey(page, file);
  for (let step = 0; step < 4; step += 1) {
    const focus = await focusInfo(page);
    if (focus.role === 'menuitem' && focus.text === label) {
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`menu item ${label} cannot be reached by keyboard`);
}

/** @brief 键盘打开菜单后 Enter（焦点在"重命名"），等改名框出现。 */
export async function startRename(page, file) {
  await chooseMenuItem(page, file, '重命名');
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  return input;
}

/** @brief 键盘打开菜单，↓ 到"删除"再 Enter，等删除确认框出现。 */
export async function startDelete(page, file) {
  await chooseMenuItem(page, file, '删除');
  const dialog = page.getByTestId('delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  return dialog;
}

/** @brief 改名框的值、选区和焦点。 */
export const renameView = (input) => input.evaluate((el) => ({ value: el.value, start: el.selectionStart,
  end: el.selectionEnd, focused: document.activeElement === el }));
/** @brief 等改名框消失。 */
export const renameClosed = (page) => page.getByTestId('rename-input').waitFor({ state: 'detached', timeout: 5000 })
  .then(() => true, () => false);

/** @brief 等询问框，按 answer 回答（'esc' 或按钮名，remember 为真时先勾"记住"），等会话就绪，返回横幅文字。 */
export async function answerTrustDialog(page, { answer, remember = false }) {
  const dialog = page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 15000 });
  if (remember) await dialog.getByRole('checkbox', { name: '记住' }).check();
  if (answer === 'esc') await page.keyboard.press('Escape');
  else await dialog.getByRole('button', { name: answer, exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
  return paneOf(page).getByTestId('trust-banner').innerText({ timeout: 3000 }).catch(() => '');
}

// ---------- 左栏的字号 ----------

/** @brief 左栏（和开着的会话菜单）里小于 12px 的文字；做法与 m1-layout.mjs 的 smallText 相同，只看左栏。 */
function sidebarSmallText(page) {
  return page.evaluate(() => {
    const small = [];
    for (const root of document.querySelectorAll('[data-testid="sidebar"], [data-testid="session-menu"]')) {
      for (const element of [root, ...root.querySelectorAll('*')]) {
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        if (!hasText || element.getClientRects().length === 0) continue;
        const size = parseFloat(getComputedStyle(element).fontSize);
        if (size >= 12) continue;
        const text = element.textContent.trim().slice(0, 20);
        small.push(`${element.tagName.toLowerCase()}.${element.className} ${size}px "${text}"`);
      }
    }
    return small;
  });
}

/** @brief 记下此刻左栏里小于 12px 的文字（最后统一判断）。 */
export async function noteSmallText(ctx, where) {
  const small = await sidebarSmallText(ctx.page);
  ctx.small.push(...small.map((item) => `${where}: ${item}`));
  ctx.smallChecked.push(where);
}
