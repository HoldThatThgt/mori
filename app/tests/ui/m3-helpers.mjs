// M3 整机测试（m3-app.mjs、m3-app-live.mjs）共用的小工具：路径与会话文件、等待、会话树与焦点、菜单、信任询问、
// 拿住文件不让删除、系统回收站、输入框下面一行（权限、选择范围、Effort、圆环，2026-10-21 从顶栏移来）此刻的样子和它的变化。
// 只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import koffi from 'koffi';
import { sleep } from './lib.mjs';
import { OPEN_FOLDER } from './page.mjs';

/** @brief 当前显示的会话面板（隐藏的会话面板仍然挂载，找元素都限定在这里） */
export const PANE = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';
/** @brief 会话名取第一条消息的前几个字 */
export const TITLE_LENGTH = 20;
/** @brief 停止后对话流里的提示 */
export const STOPPED = 'Stopped · Changes made so far stay as they are';

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
/** @brief 当前会话面板里"Stopped · …"提示的条数。 */
export const stoppedCount = (page) => paneOf(page).getByTestId('notice').filter({ hasText: STOPPED }).count();
/** @brief 本机保存的草稿（localStorage 的 mori.drafts）。 */
export const savedDrafts = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mori.drafts') ?? '{}'));
/** @brief 草稿里有没有某个会话文件的。 */
export const hasDraft = (drafts, file) => Object.keys(drafts).some((key) => samePath(key, file));
/** @brief 本机记下的已归档会话文件（localStorage 的 mori.archived）。 */
export const savedArchived = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mori.archived') ?? '[]'));

/** @brief 会话树：项目（工作目录、文件夹名、悬停提示）和其中的会话行（不含"Archived"里的）。 */
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

/** @brief 侧栏底部的"Archived N"：开关的文字、是否展开、列表里的行（会话文件、会话名、悬停提示）。 */
export function archivedState(page) {
  return page.evaluate(() => {
    const toggle = document.querySelector('[data-testid="archived-toggle"]');
    const rows = [...document.querySelectorAll('[data-testid="archived-list"] .session-item.archived')];
    return { toggle: toggle?.textContent?.trim() ?? null, expanded: toggle?.getAttribute('aria-expanded') === 'true',
      rows: rows.map((row) => ({ file: row.dataset.file, title: row.querySelector('.session-label')?.textContent ?? '',
        tip: row.getAttribute('title') ?? '' })) };
  });
}

/** @brief 等"Archived N"开关的文字变成 text（null 表示开关不在）。 */
export function waitArchivedToggle(page, text, timeout = 10000) {
  return until(async () => (await archivedState(page)).toggle === text, timeout);
}

/** @brief "Archived N"收起时点开它，等列表出现。 */
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

/** @brief 焦点所在的元素；inRow：是否在输入框下面一行（.composer-bottom）里。 */
export async function focusInfo(page) {
  await settle(page);
  return page.evaluate((selector) => {
    const el = document.activeElement;
    return { row: el?.dataset?.row ?? null, file: el?.dataset?.file ?? null, testid: el?.dataset?.testid ?? null,
      role: el?.getAttribute?.('role') ?? null, type: el?.getAttribute?.('type') ?? null,
      label: el?.getAttribute?.('aria-label') ?? null, text: (el?.textContent ?? '').trim().slice(0, 30),
      tag: el?.tagName?.toLowerCase() ?? null,
      composer: el === document.querySelector(`${selector} .composer textarea`),
      inRow: Boolean(el?.closest?.('[data-testid="composer"] .composer-bottom')) };
  }, PANE);
}

/** @brief 等 locator 出现，最多 timeout 毫秒；返回是否出现了。 */
export const shownWithin = (locator, timeout = 3000) => locator.waitFor({ timeout }).then(() => true, () => false);

/** @brief 等当前会话面板就绪（没有"Starting…"之类的说明）。 */
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

/** @brief 点左栏"Open folder…"选 folder，等新会话面板出现（不等就绪：可能先弹信任询问）。 */
export async function clickOpenFolder(ctx, folder) {
  const before = await paneCount(ctx.page);
  await stubFolder(ctx.app, folder);
  await ctx.page.getByRole('button', { name: OPEN_FOLDER }).first().click();
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

/** M5 加进会话菜单的两项（由 M5 的测试检查）；M3 的检查只看 M3 的 Rename、Archive、Delete…（Unarchive） */
export const M5_MENU_ITEMS = ['Attach as context', 'Open in split view'];

/** @brief 菜单项：文字（不含小字）、旁边的小字、是否不可用。不含 M5 加的两项（见 M5_MENU_ITEMS）。 */
export async function menuItems(menu) {
  const items = await menu.getByRole('menuitem').evaluateAll((elements) => elements.map((item) => ({
    label: item.firstChild?.nodeType === 3 ? item.firstChild.textContent : '',
    hint: item.querySelector('.menu-hint')?.textContent ?? '', disabled: item.disabled })));
  return items.filter((item) => !M5_MENU_ITEMS.includes(item.label));
}

/** @brief 菜单项列成一行文字（失败时的说明用）。 */
export const menuText = (items) => items.map((item) => `${item.label}${item.disabled ? `(${item.hint})` : ''}`)
  .join(' / ');

/** @brief 键盘打开会话行的菜单，↓ 移到文字为 label 的菜单项再按 Enter；走不到时抛错。 */
export async function chooseMenuItem(page, file, label) {
  await openMenuByKey(page, file);
  // M5 起菜单里多了两项（M5_MENU_ITEMS），最多要走 6 步。
  for (let step = 0; step < 6; step += 1) {
    const focus = await focusInfo(page);
    if (focus.role === 'menuitem' && focus.text === label) {
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`menu item ${label} cannot be reached by keyboard`);
}

/** @brief 键盘打开菜单后 Enter（焦点在"Rename"），等改名框出现。 */
export async function startRename(page, file) {
  await chooseMenuItem(page, file, 'Rename');
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  return input;
}

/** @brief 键盘打开菜单，↓ 到"Delete…"再 Enter，等删除确认框出现。 */
export async function startDelete(page, file) {
  await chooseMenuItem(page, file, 'Delete…');
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

/** @brief 等询问框，按 answer 回答（'esc' 或按钮名，remember 为真时先勾"Remember my choice"），等会话就绪，返回横幅文字。 */
export async function answerTrustDialog(page, { answer, remember = false }) {
  const dialog = page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 15000 });
  if (remember) await dialog.getByRole('checkbox', { name: 'Remember my choice' }).check();
  if (answer === 'esc') await page.keyboard.press('Escape');
  else await dialog.getByRole('button', { name: answer, exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
  return paneOf(page).getByTestId('trust-banner').innerText({ timeout: 3000 }).catch(() => '');
}

// ---------- 输入框下面一行（docs/v0/screens/models.md"界面测试用的标识"；2026-10-21 从顶栏移来） ----------

/** 这一行会用 aria-disabled 表示不可用的三个按钮 → 它们的菜单（开着时挡住 Alt+数字和 Ctrl+N） */
export const ROW_MENUS = { 'permission-button': 'permission-menu', 'model-button': 'model-menu',
  'thinking-button': 'thinking-menu' };
/** 从文字框按 Tab 依次停在这一行的这几项上（输入为空时"Send"不可用、跳过；models.md"位置"） */
export const ROW_TAB_ORDER = ['permission-button', 'model-button', 'thinking-button', 'usage'];
/** 不能发送时按钮位置的说明，也是这一行按钮不可用的原因（models.md"不可用时、按钮消失时的焦点"） */
export const ROW_REASONS = { crashed: 'Mori’s background process crashed', restarting: 'Restarting…',
  starting: 'Starting…', failed: 'Session didn’t open' };
/** 准备中、生成中选择范围按钮不可用的原因（悬停第三行） */
export const MODEL_BUSY = 'Can’t switch models until the response finishes';
/** 准备中、生成中 Effort 按钮不可用的原因（悬停第二行） */
export const EFFORT_BUSY = 'Can’t change effort until the response finishes';

/**
 * @brief 在页面里装上读这一行的函数 window.__moriRow（界面重新加载后要再装）。读 selector 那一栏
 *        [data-testid="composer"] 里的 .composer-bottom：按钮位置的说明；三个按钮的读屏名、文字、aria-disabled 的原值、
 *        "不可用"（aria-disabled 为 true 且没有 data-pending，composer-pickers.md C1）、"切换中"（data-pending）、原生 disabled、
 *        悬停说明（title 按行拆开，C2）、读屏的描述（aria-describedby 指向的元素的文字）、图标个数、data-pick / data-current /
 *        data-reasoning；圆环的 data-state / data-tokens / data-percent、读屏名、描述、aria-expanded、aria-controls；
 *        圆环详情是否显示、悬停提示显示时的文字；页面上开着的这一行的菜单；焦点在哪里；这一行的高度。
 */
function installRowReader(page) {
  return page.evaluate(() => {
    if (window.__moriRow) return;
    const describe = (el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ');
    const shown = (el) => Boolean(el) && el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0';
    const button = (row, id) => {
      const el = row.querySelector(`[data-testid="${id}"]`);
      return el && { label: el.getAttribute('aria-label'), text: el.textContent.trim(),
        ariaDisabled: el.getAttribute('aria-disabled'), pending: el.dataset.pending === 'true',
        unavailable: el.getAttribute('aria-disabled') === 'true' && el.dataset.pending !== 'true',
        native: el.disabled, tip: (el.getAttribute('title') ?? '').split('\n'), described: describe(el),
        expanded: el.getAttribute('aria-expanded'), icons: el.querySelectorAll('svg').length,
        pick: el.dataset.pick ?? null, current: el.dataset.current ?? null, reasoning: el.dataset.reasoning ?? null };
    };
    const focusName = (pane) => {
      const el = document.activeElement;
      if (el && el === pane.querySelector('.composer textarea')) return 'textarea';
      const menu = el?.closest?.('[role="menu"]');
      return el?.dataset?.testid ?? (menu ? `menu:${menu.dataset.testid ?? ''}` : el?.tagName?.toLowerCase() ?? null);
    };
    window.__moriRow = (selector) => {
      const pane = document.querySelector(selector);
      const row = pane?.querySelector('[data-testid="composer"] .composer-bottom');
      if (!row) return null;
      const ring = row.querySelector('[data-testid="usage"]');
      const tip = pane.querySelector('[data-testid="usage-tip"]');
      return { notReady: pane.querySelector('[data-testid="not-ready"]')?.textContent ?? null,
        permission: button(row, 'permission-button'), model: button(row, 'model-button'),
        thinking: button(row, 'thinking-button'),
        usage: ring && { state: ring.dataset.state ?? null, tokens: ring.dataset.tokens ?? null,
          percent: ring.dataset.percent ?? null, label: ring.getAttribute('aria-label'), described: describe(ring),
          expanded: ring.getAttribute('aria-expanded'), controls: ring.getAttribute('aria-controls') },
        details: shown(pane.querySelector('[data-testid="usage-details"]')),
        tip: shown(tip) ? tip.textContent.trim() : null,
        menus: ['permission-menu', 'model-menu', 'thinking-menu']
          .filter((id) => document.querySelector(`[data-testid="${id}"]`)),
        focus: focusName(pane), height: row.getBoundingClientRect().height };
    };
  });
}

/** @brief selector 那一栏（默认当前显示的会话面板）输入框下面一行此刻的样子（见 installRowReader）；没有这一行时为 null。 */
export async function composerRow(page, selector = PANE) {
  await installRowReader(page);
  return page.evaluate((target) => window.__moriRow(target), selector);
}

/**
 * @brief 开始记下 selector 那一栏输入框下面一行的每一次变化（页面里的 DOM 变了或焦点移进某个元素时读一次，
 *        和上一次不同才记），用来抓"Restarting…""Starting…"这类一闪而过的状态。rowLog 停止并取回。
 */
export async function watchRow(page, selector = PANE) {
  await installRowReader(page);
  await page.evaluate((target) => {
    window.__moriRowStop?.();
    const log = [];
    const note = () => {
      const snap = JSON.stringify(window.__moriRow(target));
      if (log.at(-1) !== snap) log.push(snap);
    };
    const observer = new MutationObserver(note);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    document.addEventListener('focusin', note);
    window.__moriRowLog = log;
    window.__moriRowStop = () => {
      note();
      observer.disconnect();
      document.removeEventListener('focusin', note);
    };
    note();
  }, selector);
}

/** @brief 停止 watchRow 的记录（停之前再读一次），返回记下的样子（按时间顺序；这一行不在时那一项为 null）。 */
export async function rowLog(page) {
  await settle(page);
  return page.evaluate(() => {
    window.__moriRowStop?.();
    window.__moriRowStop = null;
    return (window.__moriRowLog ?? []).map((snap) => JSON.parse(snap));
  });
}

/** @brief 等这一行满足 test（参数是 composerRow 的结果），最多 timeout 毫秒；返回满足时的样子，没等到时返回最后一次的。 */
export async function rowWhen(page, test, timeout = 3000) {
  return await until(async () => {
    const row = await composerRow(page);
    return row && test(row) ? row : null;
  }, timeout, 100) || composerRow(page);
}

/**
 * @brief 按钮能用（models.md"不可用时、按钮消失时的焦点"）：在；没有 aria-disabled 属性（能用时不写"false"）、
 *        没有 data-pending，也不是原生 disabled。
 */
export const usable = (item) => Boolean(item) && item.ariaDisabled === null && !item.pending && !item.native;

/**
 * @brief 权限或 Effort 按钮不可用、原因是 reason：aria-disabled（不是原生 disabled，仍能 Tab 到）、没有 data-pending；
 *        悬停两行，第一行是全名（与读屏名相同），第二行是 reason；读屏的描述只有 reason（没有第一行、没有" · "）。
 */
export const blockedBy = (item, reason) => Boolean(item) && item.unavailable && !item.native
  && item.tip.length === 2 && item.tip[0] === item.label && item.tip[1] === reason && item.described === reason;

/**
 * @brief 选择范围按钮不可用、原因是 reason：aria-disabled、没有 data-pending；悬停三行（按钮文字、where、reason），
 *        读屏的描述是"<where>. <reason>"（composer-pickers.md"悬停和读屏的描述"；2026-10-26 起 where 只有提供商名）。
 */
export const rangeBlockedBy = (item, where, reason) => Boolean(item) && item.unavailable && !item.native
  && item.tip.length === 3 && item.tip[0] === item.text && item.tip[1] === where && item.tip[2] === reason
  && item.described === `${where}. ${reason}`;

/**
 * @brief 照 Claude 缩短一个数（models.md"上下文用量（圆环）"）：1,000 起写成 k、1,000,000 起写成 M（一位小数，去掉".0"），
 *        不到 1,000 照写；999,950 到 999,999 按 k 会进成"1000k"，写成"1M"。
 */
export function shortCount(count) {
  const trim = (text) => text.replace(/\.0$/, '');
  if (count < 1000) return String(count);
  if (count < 999950) return `${trim((count / 1000).toFixed(1))}k`;
  return `${trim((count / 1e6).toFixed(1))}M`;
}

/**
 * @brief 有用量时圆环（composerRow 的 usage）的读屏名、data-tokens、data-percent 和悬停提示对得上：读屏名
 *        "Usage: Context approximately 15,360 of 128,000 tokens (12%)"（写完整的数、" / "换成" of "），数与 data-tokens、
 *        百分比与 data-percent 相同（四舍五入），读屏的描述里没有"/"；给了 tip 时它是"Context ≈ 15.4k / 128k (12%)"。
 */
export function usageOk(usage, tip = undefined) {
  const match = /^Usage: Context approximately ([\d,]+) of ([\d,]+) tokens \((\d+)%\)$/.exec(usage?.label ?? '');
  if (!match || usage.state !== 'used') return false;
  const [used, total, percent] = match.slice(1).map((text) => Number(text.replace(/,/g, '')));
  const full = (count) => count.toLocaleString('en-US');
  return match[1] === full(used) && match[2] === full(total) && String(used) === usage.tokens
    && String(percent) === usage.percent && Math.abs(Math.round((used / total) * 100) - percent) <= 1
    && !usage.described.includes('/')
    && (tip === undefined || tip === `Context ≈ ${shortCount(used)} / ${shortCount(total)} (${percent}%)`);
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
