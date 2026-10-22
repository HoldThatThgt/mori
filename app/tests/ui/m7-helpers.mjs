// m7-app.mjs、m7-replay.mjs、m7-real.mjs 共用的工作回顾页面读取与操作（docs/v0/screens/review.md 的标识）：摘要里的时间、
// 列表的行、读完、切分节、打开工作回顾、返回会话、选中一行、页面和详情此刻的样子、回到原位置的整轮高亮、列表和详情有没有
// 横向溢出；导出（换掉主进程的保存对话框、读导出文件的开头、各节和截图链接、工具行下面的结果）。
// 不记录检查结果（检查结果由调用方记录）。

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sleep } from './lib.mjs';
import { settle, until } from './m3-helpers.mjs';
import { PANE } from './m4-helpers.mjs';

/** @brief 摘要里的时间：完整时间 full 的 MM-DD HH:mm，不是今年的前面带年份。 */
export function shortOf(full) {
  const rest = full.slice(5, 16);
  return Number(full.slice(0, 4)) === new Date().getFullYear() ? rest : `${full.slice(0, 4)}-${rest}`;
}

/** @brief 列表里文件名为 name 的一行。 */
export const rowAt = (page, name) => page.locator(`[data-testid="review-row"][data-name="${name}"]`);

/** @brief 等工作回顾读完（不再"Loading…"）。 */
export async function waitLoaded(page) {
  await sleep(300);
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="review-page"]');
    return Boolean(root) && !root.querySelector('[data-testid="review-loading"]');
  }, null, { timeout: 15000 });
}

/** @brief 切到某一节，等它按下。 */
export async function chooseTab(page, kind) {
  const tab = page.getByTestId(`review-tab-${kind}`);
  if (await tab.getAttribute('aria-pressed') !== 'true') await tab.click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-pressed')
    === 'true', `review-tab-${kind}`, { timeout: 5000 });
  await settle(page);
}

/** @brief 点左栏"Review"，等读完；section 不为空时切到那一节。 */
export async function openReviewPage(page, section) {
  await page.getByTestId('nav-review').click();
  await page.getByTestId('review-page').waitFor({ timeout: 10000 });
  await waitLoaded(page);
  if (section) await chooseTab(page, section);
}

/** @brief 点"Back to app"，等工作回顾页消失。 */
export async function backToChat(page) {
  await page.getByTestId('review-page').getByRole('button', { name: 'Back to app' }).click();
  await page.getByTestId('review-page').waitFor({ state: 'detached', timeout: 10000 });
  await settle(page);
}

/** @brief 点列表里的一行，等它按下、右栏显示详情，返回详情。 */
export async function selectRow(page, name) {
  await rowAt(page, name).click();
  await page.waitForFunction((file) => document.querySelector(`[data-testid="review-row"][data-name="${file}"]`)
    ?.getAttribute('aria-pressed') === 'true' && Boolean(document.querySelector('[data-testid="review-detail"]')),
  name, { timeout: 5000 });
  await settle(page);
  return detailState(page);
}

/** @brief 工作回顾页此刻的样子：标题、分节、工具行、各种状态和列表的行；不在这一页时为 null。 */
export function reviewState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="review-page"]');
    if (!root) return null;
    const shown = (el) => Boolean(el) && el.getClientRects().length > 0;
    const find = (id) => root.querySelector(`[data-testid="${id}"]`);
    const text = (id) => find(id)?.textContent.trim() ?? null;
    const tab = (kind) => {
      const button = find(`review-tab-${kind}`);
      const count = button?.querySelector('[data-testid="review-count"]');
      return { pressed: button?.getAttribute('aria-pressed') === 'true', label: button?.getAttribute('aria-label'),
        text: button?.textContent.trim() ?? '', count: shown(count) ? count.textContent.trim() : null };
    };
    const hide = find('review-hide-handled');
    return {
      title: root.querySelector('.topbar .chat-title')?.textContent.trim() ?? '',
      back: [...root.querySelectorAll('.topbar button')].some((item) => item.textContent.includes('Back to app')),
      tabs: { feedback: tab('feedback'), issues: tab('issues') },
      hide: { role: hide?.getAttribute('role') ?? null, checked: hide?.getAttribute('aria-checked') ?? null },
      exportText: text('review-export'), exportDisabled: find('review-export')?.disabled ?? null,
      folderText: text('review-open-folder'), notice: text('review-notice'), loading: text('review-loading'),
      error: text('review-error'), empty: text('review-empty'), allHidden: text('review-all-hidden'),
      rows: [...root.querySelectorAll('[data-testid="review-row"]')].map((row) => ({ name: row.dataset.name,
        handled: row.dataset.handled === 'true', pressed: row.getAttribute('aria-pressed') === 'true',
        tag: row.querySelector('[data-testid="review-row-handled"]')?.textContent.trim() ?? null,
        tagName: row.tagName.toLowerCase(), text: row.textContent })),
    };
  });
}

/** @brief 列表里按下（选中）的那一行的文件名；没有时为 null。 */
export const pressedRow = async (page) => (await reviewState(page))?.rows.find((row) => row.pressed)?.name ?? null;

/** @brief 右栏的详情此刻的样子；没有详情时为 null。 */
export function detailState(page) {
  return page.evaluate(() => {
    const aside = document.querySelector('[data-testid="review-detail"]');
    if (!aside) return null;
    const text = (id) => aside.querySelector(`[data-testid="${id}"]`)?.textContent.trim() ?? null;
    const more = (id) => {
      const el = aside.querySelector(`[data-testid="${id}"]`);
      const body = el && [...el.children].find((child) => child.tagName !== 'SUMMARY');
      return el && { open: el.open, summary: el.querySelector('summary')?.textContent.trim() ?? '',
        text: body?.textContent ?? '', wrap: body ? getComputedStyle(body).whiteSpace : '' };
    };
    const jump = aside.querySelector('[data-testid="detail-jump"]');
    const img = aside.querySelector('img[data-testid="detail-shot"]');
    const quote = aside.querySelector('[data-testid="detail-quote"]');
    const rect = aside.getBoundingClientRect();
    return {
      tag: aside.tagName.toLowerCase(), panel: aside.classList.contains('right-panel'),
      label: aside.getAttribute('aria-label'), divider: Boolean(aside.querySelector('[data-resize="workspace"]')),
      heading: aside.querySelector('.panel-header')?.textContent.trim() ?? '',
      close: Boolean(aside.querySelector('.panel-header button[aria-label="Close details"]')),
      time: text('detail-time'), source: text('detail-source'), expected: text('detail-expected'),
      quote: text('detail-quote'), quoteScroll: quote ? getComputedStyle(quote).overflowY : null,
      quoteBox: quote && { scroll: quote.scrollHeight, client: quote.clientHeight },
      jump: jump && { text: jump.textContent.trim(), disabled: jump.disabled }, jumpStatus: text('detail-jump-status'),
      handled: text('detail-handled'), what: text('detail-what'), expect: text('detail-expect'),
      shot: img && { loaded: img.complete && img.naturalWidth > 0, width: img.getBoundingClientRect().width,
        natural: img.naturalWidth },
      shotLoading: text('detail-shot-loading'), shotError: text('detail-shot-error'),
      view: more('detail-view'), actions: more('detail-actions'), versions: more('detail-versions'),
      broken: text('detail-broken'), showFile: text('detail-show-file'), text: aside.textContent,
      left: Math.round(rect.left), width: Math.round(rect.width),
    };
  });
}

/** @brief 当前会话里高亮的那一轮（.jump-flash）在对话流的可见范围里。 */
export function flashVisible(page) {
  return page.evaluate((pane) => {
    const item = document.querySelector(`${pane} .jump-flash`);
    const box = document.querySelector(`${pane} .conversation`)?.getBoundingClientRect();
    const rect = item?.getBoundingClientRect();
    return Boolean(rect && box && rect.bottom > box.top && rect.top < box.bottom);
  }, PANE);
}

/**
 * @brief 工作回顾此刻的横向溢出：中栏页面和列表滚动区域（.review-content）的 scrollWidth / clientWidth、列表是否在
 *        滚动区域里、右边超出列表的行、长的那一行里右边超出这一行的元素、这一行是否整个在视野里、它的期望占几行和
 *        是否截断、单行截断却没有省略号的段落（原文、来源、错误），以及详情（.panel-body）的溢出；不在工作回顾时为 null。
 * @param name 要看的那一行的文件名
 */
export function sideOverflow(page, name) {
  return page.evaluate((file) => {
    const root = document.querySelector('[data-testid="review-page"]');
    const content = root?.querySelector('.review-content');
    const list = root?.querySelector('[data-testid="review-list"]');
    const row = list?.querySelector(`[data-testid="review-row"][data-name="${file}"]`);
    if (!content || !row) return null;
    const right = (el) => el.getBoundingClientRect().right;
    const past = (els, edge) => els.filter((el) => right(el) > edge + 0.5);
    const box = content.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const title = row.querySelector('.review-row-title');
    const line = parseFloat(getComputedStyle(title).lineHeight);
    const single = [...list.querySelectorAll('.review-row-quote, .review-row-source, .review-row-error')];
    const body = document.querySelector('[data-testid="review-detail"] .panel-body');
    const rows = [...list.querySelectorAll('[data-testid="review-row"]')];
    return {
      width: innerWidth, page: [root.scrollWidth, root.clientWidth],
      content: [content.scrollWidth, content.clientWidth],
      listInside: right(list) <= box.left + content.clientLeft + content.clientWidth + 0.5,
      wideRows: past(rows, right(list)).map((el) => el.dataset.name),
      wideParts: past([...row.querySelectorAll('*')], rect.right).map((el) => el.className),
      visible: rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 && rect.width > 0,
      title: { lines: Math.round(title.getBoundingClientRect().height / line),
        clamped: title.scrollHeight > title.clientHeight + 1 },
      cut: single.filter((el) => el.scrollWidth > el.clientWidth).length,
      plain: single.filter((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis')
        .length,
      detail: body && [body.scrollWidth, body.clientWidth],
      detailParts: body ? past([...body.querySelectorAll('*')], right(body)).length : null,
    };
  }, name);
}

// ---------- 导出 ----------

/** @brief 主进程里运行（经 app.evaluate）：换掉保存对话框，返回 target（null 表示取消），记下标题和默认路径。 */
function stubSave({ dialog }, target) {
  globalThis.__m7Save = [];
  dialog.showSaveDialog = async (...args) => {
    const options = args.at(-1) ?? {};
    globalThis.__m7Save.push({ title: options.title, defaultPath: options.defaultPath });
    return target ? { canceled: false, filePath: target } : { canceled: true, filePath: '' };
  };
}

/** @brief 主进程记下的调用：打开的文件夹、在资源管理器里选中的文件、保存对话框。 */
export const mainCalls = (app) => app.evaluate(() => ({ opened: globalThis.__m7Opened ?? [],
  revealed: globalThis.__m7Revealed ?? [], saves: globalThis.__m7Save ?? [] }));

/** @brief "N record" / "N records"（导出的条数、隐藏的条数里的写法）。 */
export const records = (count) => `${count} ${count === 1 ? 'record' : 'records'}`;

/**
 * @brief 导出文件的开头：标题行和下一行（导出时间、条数）。条数的单复数不对（"1 records"、"3 record"）时
 *        total 为 NaN，和任何期望的条数都不相等。
 */
export function mdHead(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const line = lines.slice(1).find((item) => item.trim()) ?? '';
  const head = /^Exported \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? · (\d+ records?): (\d+) unresolved, (\d+) resolved$/;
  const match = head.exec(line);
  const count = Number.parseInt(match?.[2] ?? '', 10);
  const total = match && match[2] === records(count) ? count : Number.NaN;
  return { title: lines[0], line, total, open: Number(match?.[3]), done: Number(match?.[4]) };
}

/** @brief 导出文件的各节（"## <序号>. "开头）：标题行、记录的文件名（"- Record file: "或"- Report file: "那一行）、全文。 */
export function mdSections(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const starts = lines.flatMap((line, index) => (/^## \d+\. /.test(line) ? [index] : []));
  return starts.map((start, index) => {
    const body = lines.slice(start, starts[index + 1] ?? lines.length);
    const file = body.map((line) => /^- (?:Record file|Report file): (.+)$/.exec(line)?.[1]).find(Boolean);
    return { heading: body[0], name: file ? basename(file.trim()) : null, text: body.join('\n') };
  });
}

/** @brief 等工具行下面的一行以 prefix 开头（最多 5 秒；上一次的结果还在时要等它换掉），返回它此刻的文字。 */
export async function noticeText(page, prefix) {
  await page.waitForFunction((start) => document.querySelector('[data-testid="review-notice"]')?.textContent.trim()
    .startsWith(start), prefix, { timeout: 5000 }).catch(() => {});
  return page.getByTestId('review-notice').innerText({ timeout: 1000 }).catch(() => '');
}

/** @brief 一节里截图的链接（"![Screenshot](<路径>)"）；没有时为 null。 */
export const shotLink = (text) => /!\[Screenshot\]\(<?([^<>)]+)>?\)/.exec(text)?.[1] ?? null;

/**
 * @brief 换掉保存对话框（返回 target，null 为取消），点"Export as Markdown…"；返回对话框收到的标题和默认路径，
 *        以及导出文件的全文（wait 为真时等文件写好）。
 * @param ctx 带 app（Electron 应用）和 page（窗口）
 */
export async function exportTo(ctx, target, wait = Boolean(target)) {
  const { app, page } = ctx;
  await app.evaluate(stubSave, target);
  await page.getByTestId('review-export').click();
  const saves = await until(async () => {
    const calls = await mainCalls(app);
    return calls.saves.length > 0 && calls.saves;
  }, 5000);
  const md = wait ? await until(() => existsSync(target) && readFileSync(target, 'utf8'), 5000) : '';
  await sleep(300);
  return { dialog: saves ? saves[0] : null, md: md || '' };
}
