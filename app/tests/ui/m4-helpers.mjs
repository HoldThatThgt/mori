// M4 测试（m4-app.mjs、m4-replay.mjs、m4-real.mjs）共用的页面操作：选字（程序选区或真的拖鼠标）、选区浮层、
// 引用芯片、发出的引用、文件阅读器、右栏改动列表、回到原位置的高亮、反馈表单与保存的反馈、会话文件里的条目。
// 只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './lib.mjs';

/** @brief 当前显示的会话面板 */
export const PANE = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';

// ---------- 选字 ----------

/**
 * @brief 在页面里找到 selector 匹配的第 index 个元素里的文字 text（可以跨几个文字节点，例如语法高亮的代码），
 *        先把它滚到视野中间，返回它在视口里的起止坐标（第一个字的左边、最后一个字的右边，取各自那一行的竖直中点）；
 *        找不到时为 null。
 */
export function textPoints(page, selector, text, index = 0) {
  return page.evaluate(({ selector: css, text: wanted, index: nth }) => {
    const root = document.querySelectorAll(css)[nth];
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let flat = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push([node, flat.length]);
      flat += node.data;
    }
    const at = flat.indexOf(wanted);
    if (at < 0 || !wanted) return null;
    const locate = (offset) => {
      const [node, start] = nodes.findLast(([, begin]) => begin <= offset);
      return [node, offset - start];
    };
    const charRect = (offset) => {
      const [node, inner] = locate(offset);
      const range = document.createRange();
      range.setStart(node, inner);
      range.setEnd(node, inner + 1);
      return range;
    };
    charRect(at).startContainer.parentElement?.scrollIntoView({ block: 'center' });
    const a = charRect(at).getBoundingClientRect();
    const b = charRect(at + wanted.length - 1).getBoundingClientRect();
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
  }, { selector, text, index });
}

/** @brief 真的拖鼠标选中 selector 里的 text；找不到时返回 false。 */
export async function dragSelect(page, selector, text, index = 0) {
  const points = await textPoints(page, selector, text, index);
  if (!points) return false;
  await sleep(100);
  const again = await textPoints(page, selector, text, index);
  const { x1, y1, x2, y2 } = again ?? points;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
  return true;
}

/**
 * @brief 用程序选中 selector 里从 startText 开头到 endText 结尾的文字（可以跨元素），再像松开鼠标一样发 mouseup；
 *        找不到时返回 false。
 */
export function selectBetween(page, selector, startText, endText, index = 0) {
  return page.evaluate(({ selector: css, startText: a, endText: b, index: nth }) => {
    const root = document.querySelectorAll(css)[nth];
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let start = null;
    let end = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!start && node.data.includes(a)) start = [node, node.data.indexOf(a)];
      if (start && node.data.includes(b)) end = [node, node.data.indexOf(b) + b.length];
      if (start && end) break;
    }
    if (!start || !end) return false;
    const range = document.createRange();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1]);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }, { selector, startText, endText, index });
}

/**
 * @brief 等阅读器的语法高亮画上（行里出现着色的词）。高亮是异步算的，算好后每一行的文字节点换成一个个词：
 *        先用程序选中再换，选区端点所在的文字节点被移除，终点退到行首（第 5–6 行会变成第 5–5 行）。
 *        调用方用的都是会高亮的文件（.md、.ts）。
 */
function waitHighlighted(page, timeout = 10000) {
  return page.waitForFunction(() => document.querySelector('[data-testid="file-content"] .file-line span'), null,
    { timeout });
}

/** @brief 阅读器里等语法高亮画上后，用程序选中第 from 行开头到第 to 行结尾，再发 mouseup。 */
export async function selectLines(page, from, to) {
  await waitHighlighted(page);
  return page.evaluate(({ from: a, to: b }) => {
    const content = document.querySelector('[data-testid="file-content"]');
    const first = content?.querySelector(`[data-line="${a}"]`);
    const last = content?.querySelector(`[data-line="${b}"]`);
    if (!first || !last) return false;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }, { from, to });
}

/** @brief 清掉选区。 */
export const clearSelection = (page) => page.evaluate(() => window.getSelection()?.removeAllRanges());

/** @brief 选区浮层是否出现（可见，且在视口里）。 */
export async function popoverShown(page, timeout = 2000) {
  const popover = page.getByTestId('selection-popover');
  return popover.waitFor({ state: 'visible', timeout }).then(() => popover.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).visibility === 'visible' && r.top >= 0 && r.bottom <= innerHeight;
  }), () => false);
}

/** @brief 选区浮层的按钮文字。 */
export const popoverButtons = (page) => page.getByTestId('selection-popover').locator('button').allInnerTexts()
  .catch(() => []);

// ---------- 芯片与发出的引用 ----------

/** @brief 当前会话输入框上方的芯片：来源、摘要、检查结果。 */
export function composerChips(page) {
  return page.locator(`${PANE} [data-testid="quote-chip"]`).evaluateAll((chips) => chips.map((chip) => ({
    label: chip.querySelector('.quote-chip-label')?.textContent ?? '',
    text: chip.querySelector('.quote-chip-text')?.textContent ?? '',
    status: chip.querySelector('[data-testid="quote-status"]')?.textContent ?? null,
    title: chip.querySelector('.quote-chip-main')?.getAttribute('title') ?? '' })));
}

/** @brief 当前会话里发出的引用：来源、原文、检查结果。 */
export function sentQuotes(page) {
  return page.locator(`${PANE} [data-testid="sent-quote"]`).evaluateAll((quotes) => quotes.map((quote) => ({
    label: quote.querySelector('.quote-chip-label')?.textContent ?? '',
    text: quote.querySelector('.sent-quote-text')?.textContent ?? '',
    status: quote.querySelector('[data-testid="quote-status"]')?.textContent ?? null })));
}

/** @brief 本机保存的引用芯片草稿（localStorage 的 mori.draftRefs）。 */
export const savedDraftRefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mori.draftRefs') ?? '{}'));

// ---------- 右栏 ----------

/** @brief 改动列表：每个文件的路径、次数，以及展开后每次改动的标签和有没有 diff。 */
export async function changeList(page) {
  const panel = page.getByTestId('right-panel');
  if (await panel.count() === 0) return null;
  return panel.evaluate((el) => {
    // diff 由 @pierre/diffs 画在 shadow DOM 里，textContent 读不到，要连 shadowRoot 一起走。
    const deep = (root) => {
      let text = '';
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) text += node.data;
        if (node.shadowRoot) walk(node.shadowRoot);
        for (const child of node.childNodes) walk(child);
      };
      if (root) walk(root);
      return text;
    };
    return {
    note: el.querySelector('.panel-note')?.textContent ?? '',
    empty: el.querySelector('[data-testid="changes"] > .muted')?.textContent ?? '',
    files: [...el.querySelectorAll('[data-testid="change-file"]')].map((file) => ({
      path: file.querySelector('.change-path')?.textContent ?? '',
      count: file.querySelector('summary .muted')?.textContent ?? '',
      open: file.open,
      entries: [...file.querySelectorAll('[data-testid="change-entry"]')].map((entry) => ({
        label: entry.querySelector('.tool-section-label')?.textContent ?? '',
        diff: deep(entry.querySelector('.change-diff')),
        content: entry.querySelector('.tool-pre')?.textContent ?? '' })) })) };
  });
}

/** @brief 展开改动列表里路径为 path 的文件（已展开就不动）。 */
export async function expandChange(page, path) {
  const file = page.locator('[data-testid="change-file"]').filter({ has: page.locator('.change-path', { hasText: path }) });
  if (!await file.evaluate((el) => el.open)) await file.locator('summary .muted').click();
  await sleep(300);
}

/** @brief 文件阅读器：路径、状态说明、前几行、高亮的行、"原文已变化"的提示。 */
export async function viewerState(page) {
  const viewer = page.getByTestId('file-viewer');
  if (await viewer.count() === 0) return null;
  return page.getByTestId('right-panel').evaluate((panel) => {
    const lines = [...panel.querySelectorAll('[data-testid="file-content"] [data-line]')];
    return {
      path: panel.querySelector('[data-testid="file-path"]')?.textContent ?? '',
      fullPath: panel.querySelector('[data-testid="file-path"]')?.getAttribute('title') ?? '',
      state: panel.querySelector('[data-testid="file-state"]')?.textContent ?? '',
      loading: panel.textContent.includes('正在读取…'),
      lineCount: lines.length,
      first: lines.slice(0, 6).map((line) => line.textContent),
      gutter: lines[0] ? getComputedStyle(lines[0], '::before').content : '',
      target: lines.filter((line) => line.classList.contains('target')).map((line) => Number(line.dataset.line)),
      changed: panel.querySelector('[data-testid="quote-changed"]')?.textContent ?? '',
      externalDisabled: panel.querySelector('[aria-label="用系统编辑器打开"]')?.disabled ?? null,
      error: panel.querySelector('.panel-error')?.textContent ?? '' };
  });
}

/** @brief 等阅读器读完（不再"正在读取…"）。 */
export function waitViewer(page, timeout = 10000) {
  return page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="file-viewer"]');
    return viewer && !viewer.textContent.includes('正在读取…');
  }, null, { timeout });
}

// ---------- 高亮、反馈 ----------

/** @brief 回到原位置的文字高亮：有没有、高亮的文字；整轮回复的高亮：几个元素。 */
export function jumpHighlight(page) {
  return page.evaluate(() => {
    const highlight = CSS.highlights.get('mori-jump');
    const ranges = highlight ? [...highlight] : [];
    return { text: ranges.map((range) => range.toString()).join(''),
      flashed: document.querySelectorAll('.jump-flash').length };
  });
}

/** @brief 保存的反馈（<userData>/feedback/*.json），按文件名排序。 */
export function savedFeedback(userData) {
  const dir = join(userData, 'feedback');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    .map((name) => ({ name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

/** @brief 会话文件里的全部条目（读不出的行略过）。 */
export function sessionEntries(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** @brief 会话文件里的 mori.ref 条目，以及它指向的你的消息的全文。 */
export function refEntries(file) {
  const entries = sessionEntries(file);
  return entries.filter((entry) => entry.type === 'custom' && entry.customType === 'mori.ref').map((entry) => {
    const message = entries.find((item) => item.id === entry.data?.messageId);
    const content = message?.message?.content;
    const text = typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
    return { ...entry.data, role: message?.message?.role ?? null, text, parentIsMessage: entry.parentId === message?.id };
  });
}

/** @brief 当前会话里你的消息和助手回复的条数。 */
export function messageCounts(page) {
  return page.locator(PANE).evaluate((pane) => ({
    user: pane.querySelectorAll('[data-item="user"]').length,
    assistant: pane.querySelectorAll('[data-item="assistant"]').length }));
}

/** @brief 当前会话里最后一条含 text 的助手回复的序号；没有时为 -1。 */
export function assistantIndexWith(page, text) {
  return page.locator(`${PANE} [data-testid="assistant"]`).evaluateAll((all, wanted) => all
    .findLastIndex((el) => el.textContent.includes(wanted)), text);
}

/** @brief 当前会话最后一条助手回复下有没有操作行。 */
export function lastReplyHasActions(page) {
  return page.locator(PANE).evaluate((pane) => {
    const items = [...pane.querySelectorAll('[data-item="assistant"]')];
    return Boolean(items.at(-1)?.querySelector('[data-testid="reply-actions"]'));
  });
}

/** @brief 回复下的操作行：每行所在的项、是不是最新一轮、是否看得见（opacity）。 */
export function replyActionRows(page) {
  return page.locator(`${PANE} [data-testid="reply-actions"]`).evaluateAll((rows) => rows.map((row) => ({
    key: row.closest('[data-item-key]')?.dataset.itemKey ?? '',
    latest: row.classList.contains('latest'),
    opacity: getComputedStyle(row).opacity,
    buttons: [...row.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')) })));
}
