// M4 测试（m4-app.mjs、m4-replay.mjs、m4-real.mjs）共用的页面操作：选字（程序选区或真的拖鼠标）、选区浮层、
// 引用芯片、发出的引用、文件阅读器、右栏改动列表、回到原位置的高亮、反馈表单（底部说明）与保存的反馈、会话文件里的条目。
// 2026-10-26 起（WP-13）还有阅读器的 Markdown 预览、切到源码、预览里的 mermaid 图；内容安全策略拦下的地址（cspWatch）。
// 只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './lib.mjs';

/** @brief 当前显示的会话面板 */
export const PANE = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';

// ---------- 选字 ----------

/**
 * @brief 在页面里找到 selector 匹配的第 index 个元素里的文字 text（可以跨几个文字节点，例如语法高亮的代码），
 *        先把它所在的元素滚进视野（block 为 scrollIntoView 的 block，默认滚到中间；为 false 时不滚），返回它在视口里的
 *        起止坐标（第一个字的左边、最后一个字的右边，取各自那一行的竖直中点）；找不到时为 null。
 */
export function textPoints(page, selector, text, index = 0, block = 'center') {
  return page.evaluate(({ selector: css, text: wanted, index: nth, block: align }) => {
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
    if (align) charRect(at).startContainer.parentElement?.scrollIntoView({ block: align });
    const a = charRect(at).getBoundingClientRect();
    const b = charRect(at + wanted.length - 1).getBoundingClientRect();
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
  }, { selector, text, index, block });
}

/**
 * @brief 真的拖鼠标选中 selector 里的 text；找不到时返回 false。
 * @param block 先把文字所在的元素滚到哪里（textPoints；false 时不滚）。生成中选字用 'end'：滚到中间时这一段下面可能
 *        只剩不到 BOTTOM_SLACK 的内容，对话流按"在底部"恢复跟随，量好坐标到按下鼠标之间流入一行就把字往上推一行；
 *        或者先自己滚好位置再传 false（m4-app.mjs 的 selectWhileStreaming）。
 */
export async function dragSelect(page, selector, text, index = 0, block = 'center') {
  const points = await textPoints(page, selector, text, index, block);
  if (!points) return false;
  await sleep(100);
  const again = await textPoints(page, selector, text, index, block);
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
  const file = page.locator('[data-testid="change-file"]')
    .filter({ has: page.locator('.change-path', { hasText: path }) });
  if (!await file.evaluate((el) => el.open)) await file.locator('summary .muted').click();
  await sleep(300);
}

/**
 * @brief 文件阅读器：路径、状态说明、前几行、高亮的行、"Source changed"的提示；2026-10-26 起（changes.md"显示 Markdown
 *        预览"、"复制路径"）还有：显示的是预览还是源码（mode，读不出内容时为 null）、切换按钮的读屏名（没有时 null）、
 *        路径按钮的读屏名和是否不可用、复制路径后的提示。
 */
export async function viewerState(page) {
  const viewer = page.getByTestId('file-viewer');
  if (await viewer.count() === 0) return null;
  return page.getByTestId('right-panel').evaluate((panel) => {
    const lines = [...panel.querySelectorAll('[data-testid="file-content"] [data-line]')];
    const pathButton = panel.querySelector('[data-testid="file-path"]');
    const preview = panel.querySelector('[data-testid="file-preview"]');
    return {
      path: pathButton?.textContent ?? '',
      fullPath: pathButton?.getAttribute('title') ?? '',
      pathLabel: pathButton?.getAttribute('aria-label') ?? '',
      pathDisabled: pathButton?.disabled ?? null,
      copied: panel.querySelector('[data-testid="path-copied"]')?.textContent ?? '',
      copyFailed: panel.querySelector('[data-testid="path-copy-failed"]')?.textContent ?? '',
      mode: preview ? 'preview' : panel.querySelector('[data-testid="file-content"]') ? 'source' : null,
      modeButton: panel.querySelector('[data-testid="viewer-mode"]')?.getAttribute('aria-label') ?? null,
      state: panel.querySelector('[data-testid="file-state"]')?.textContent ?? '',
      loading: panel.textContent.includes('Loading…'),
      lineCount: lines.length,
      first: lines.slice(0, 6).map((line) => line.textContent),
      gutter: lines[0] ? getComputedStyle(lines[0], '::before').content : '',
      target: lines.filter((line) => line.classList.contains('target')).map((line) => Number(line.dataset.line)),
      changed: panel.querySelector('[data-testid="quote-changed"]')?.textContent ?? '',
      externalDisabled: panel.querySelector('[aria-label="Open in default app"]')?.disabled ?? null,
      error: panel.querySelector('.panel-error')?.textContent ?? '' };
  });
}

/** @brief 等阅读器读完（不再"Loading…"）。 */
export function waitViewer(page, timeout = 10000) {
  return page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="file-viewer"]');
    return viewer && !viewer.textContent.includes('Loading…');
  }, null, { timeout });
}

/**
 * @brief 阅读器显示的是 Markdown 预览时点"View source"切到源码，等行号出现（2026-10-26 起 .md 文件默认是预览，
 *        changes.md"显示 Markdown 预览"）；已经是源码或读不出内容时不动。按行检查的测试打开文件后先调它。
 */
export async function viewSource(page) {
  if (await page.getByTestId('file-preview').count() === 0) return;
  await page.getByTestId('right-panel').getByRole('button', { name: 'View source', exact: true }).click();
  await page.getByTestId('file-content').waitFor({ timeout: 5000 });
}

/**
 * @brief Markdown 预览里渲染出的东西：标题、列表项、表格、代码块、图（shadow DOM 里有 SVG 的、还在画的）、
 *        图片的替代文字、带源码行号的元素数；没有预览时为 null。2026-10-26 补测：替代文字的个数、看得见的图片张数、
 *        代码块里按语言着色的词数（同 m1-replay markdown 的写法）。
 */
export function previewState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="file-preview"]');
    if (!root) return null;
    const hosts = [...root.querySelectorAll('[data-testid="mermaid-diagram"]')];
    return {
      headings: [...root.querySelectorAll('[data-streamdown^="heading"]')].map((element) => element.textContent),
      items: root.querySelectorAll('li').length,
      tables: root.querySelectorAll('table').length,
      codeBlocks: [...root.querySelectorAll('[data-streamdown="code-block"]')].map((block) => block.dataset.language),
      diagrams: hosts.filter((host) => host.shadowRoot?.querySelector('svg')).length,
      drawing: hosts.filter((host) => host.getAttribute('aria-busy') === 'true').length,
      imageFallback: root.querySelector('[data-streamdown="image-fallback"]')?.textContent ?? '',
      imageFallbacks: [...root.querySelectorAll('[data-streamdown="image-fallback"]')].map((item) => item.textContent),
      imagesShown: [...root.querySelectorAll('img')].filter((image) => image.getClientRects().length > 0
        && getComputedStyle(image).display !== 'none').length,
      tokens: root.querySelectorAll('pre span[style*="--sdm-c"]').length,
      lineRows: root.querySelectorAll('[data-line]').length,
      positioned: root.querySelectorAll('[data-line-start]').length,
    };
  });
}

/** @brief 等预览里的 mermaid 图画好（shadow DOM 里有 SVG）；超时返回 false。 */
export function waitDiagram(page, scope, timeout = 20000) {
  return page.waitForFunction((css) => [...document.querySelectorAll(`${css} [data-testid="mermaid-diagram"]`)]
    .some((host) => host.shadowRoot?.querySelector('svg')), scope, { timeout }).then(() => true, () => false);
}

/**
 * @brief 从现在起记下窗口的内容安全策略拦下的地址（securitypolicyviolation 的 blockedURI，window.__cspBlocked）；
 *        已经在记时只清空，之后用 cspBlocked 取回（看远程图片没有加载）。
 */
export function cspWatch(page) {
  return page.evaluate(() => {
    window.__cspBlocked = [];
    if (window.__cspWatching) return;
    window.__cspWatching = true;
    document.addEventListener('securitypolicyviolation', (event) => window.__cspBlocked.push(event.blockedURI));
  });
}

/** @brief cspWatch 之后内容安全策略拦下的地址。 */
export const cspBlocked = (page) => page.evaluate(() => window.__cspBlocked ?? []);

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

/** 反馈表单的底部说明：这个项目没开增强（会话没有项目、读不出增强设置时同样）的整段（docs/specs/memory.md §10.7） */
export const FEEDBACK_NOTE_OFF = 'This project doesn’t have enhancement on, so feedback is only saved. '
  + 'To have Mori act on it, use “Attach as context” instead.';

/**
 * @brief 反馈表单的底部说明（data-testid="feedback-note"）：enhance.get 返回之前这一行留空（§10.7），先等它有文字，
 *        返回全文；等不到时返回空串。
 */
export async function feedbackNote(page, timeout = 10000) {
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="feedback-note"]')?.textContent),
    null, { timeout }).catch(() => {});
  return page.evaluate(() => document.querySelector('[data-testid="feedback-note"]')?.textContent ?? '');
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
    return { ...entry.data, role: message?.message?.role ?? null, text,
      parentIsMessage: entry.parentId === message?.id };
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
