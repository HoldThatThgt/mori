// M5 测试（m5-app.mjs、m5-replay.mjs、m5-real.mjs）共用的页面操作：分屏的两栏、焦点、分屏中线、拖会话与放下提示、
// 会话引用的芯片、预览对话框、发出的引用、回到原会话的高亮。只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。

import { sleep } from './lib.mjs';

/** @brief 中栏里显示的一栏：side 为 left / right / single，或 'focused' 表示焦点所在的那一栏。 */
export function slotSelector(side) {
  return side === 'focused' ? '.pane-slot[data-focused="true"]:not([hidden])' : `.pane-slot[data-side="${side}"]`;
}

/** @brief 某一栏的会话面板。 */
export const paneAt = (page, side) => page.locator(`${slotSelector(side)} [data-testid="chat-pane"]`);
/** @brief 某一栏的输入框。 */
export const composerAt = (page, side) => page.locator(`${slotSelector(side)} .composer textarea`);

/** @brief 在某一栏的输入框里写字并按 key（默认 Enter）。 */
export async function sendAt(page, side, text, key = 'Enter') {
  const input = composerAt(page, side);
  await input.click();
  await input.fill(text);
  await input.press(key);
}

/** @brief 中栏的样子：是否分屏、显示的各栏（位置、焦点、宽度、会话名）、分屏中线。 */
export function splitState(page) {
  return page.evaluate(() => {
    const center = document.querySelector('.center');
    const slots = [...document.querySelectorAll('.pane-slot:not([hidden])')].map((slot) => ({
      side: slot.dataset.side, focused: slot.dataset.focused === 'true', key: slot.dataset.tab,
      width: Math.round(slot.getBoundingClientRect().width),
      left: Math.round(slot.getBoundingClientRect().left),
      title: slot.querySelector('[data-testid="session-title"]')?.textContent ?? '',
      running: slot.querySelector('[data-testid="chat-pane"]')?.dataset.running === 'true',
    })).sort((a, b) => a.left - b.left);
    const divider = document.querySelector('[data-resize="split"]');
    return { split: center?.dataset.split === 'true', slots, focusedTitle: slots.find((s) => s.focused)?.title ?? null,
      divider: divider ? { now: Number(divider.getAttribute('aria-valuenow')),
        min: Number(divider.getAttribute('aria-valuemin')), max: Number(divider.getAttribute('aria-valuemax')),
        text: divider.getAttribute('aria-valuetext') } : null,
      centerWidth: Math.round(center?.getBoundingClientRect().width ?? 0) };
  });
}

/** @brief 等中栏变成分屏（或单栏）。 */
export function waitSplit(page, split = true, timeout = 10000) {
  return page.waitForFunction((want) => (document.querySelector('.center')?.dataset.split === 'true') === want,
    split, { timeout });
}

/** @brief 等某一栏就绪（没有"正在启动…"）。 */
export function waitPaneReady(page, side, timeout = 30000) {
  return page.waitForFunction((css) => document.querySelector(`${css} [data-testid="chat-pane"]`)
    && !document.querySelector(`${css} [data-testid="not-ready"]`), slotSelector(side), { timeout });
}

/** @brief 等某一栏开始生成、再等它结束。 */
export async function waitPaneIdle(page, side, timeout = 120000) {
  const css = `${slotSelector(side)} [data-testid="chat-pane"]`;
  await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.running === 'true', css,
    { timeout: 20000 }).catch(() => {});
  await page.waitForFunction((sel) => {
    const pane = document.querySelector(sel);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false';
  }, css, { timeout });
}

/** @brief 放下提示：种类和文字；没有时为 null。 */
export function dropHint(page) {
  return page.evaluate(() => {
    const hint = document.querySelector('[data-testid="drop-hint"]');
    return hint ? { kind: hint.dataset.kind, text: hint.textContent } : null;
  });
}

/**
 * @brief 真的用鼠标把 source 拖到 target 上（浏览器原生拖放），松开前读一次放下提示；返回提示（没有时为 null）。
 * @param position target 里的落点（相对 target 左上角）；不给时取中心
 */
export async function dragWithHint(page, source, target, position) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag source or target is not visible');
  const x = to.x + (position?.x ?? to.width / 2);
  const y = to.y + (position?.y ?? to.height / 2);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 4, { steps: 3 });
  await page.mouse.move(x, y, { steps: 8 });
  await sleep(150);
  await page.mouse.move(x + 1, y + 1);
  await sleep(150);
  const hint = await dropHint(page);
  await page.mouse.up();
  await sleep(300);
  return hint;
}

/** @brief 中栏的左半边 / 右半边里的落点（相对中栏左上角，避开输入框，取上部三分之一）。 */
export async function centerPoint(page, side) {
  const box = await page.locator('.center').boundingBox();
  return { x: side === 'left' ? box.width * 0.25 : box.width * 0.75, y: box.height * 0.3 };
}

/** @brief 某一栏输入框上方的芯片：种类、文字、是否在读取；以及引用的提示。 */
export function chipsAt(page, side) {
  return page.evaluate((css) => {
    const slot = document.querySelector(css);
    const chips = [...(slot?.querySelectorAll('[data-testid="quote-chip"]') ?? [])].map((chip) => ({
      kind: chip.dataset.kind, pending: chip.dataset.pending === 'true',
      label: chip.querySelector('.quote-chip-label')?.textContent ?? '',
      status: chip.querySelector('[data-testid="quote-status"]')?.textContent ?? null }));
    const problems = [...(slot?.querySelectorAll('[data-testid="ref-problem"]') ?? [])].map((item) => item.textContent);
    return { chips, problems };
  }, slotSelector(side));
}

/** @brief 等某一栏出现会话引用芯片（读取完成），返回它的文字。 */
export async function waitSessionChip(page, side, timeout = 15000) {
  const css = `${slotSelector(side)} [data-testid="quote-chip"][data-kind="session"]:not([data-pending])`;
  await page.locator(css).first().waitFor({ timeout });
  return page.locator(`${css} .quote-chip-label`).first().innerText();
}

/** @brief 预览对话框：标题、说明、范围、总字数、每一轮（编号、是否引用、内容）、全部文字。 */
export function previewState(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="ref-preview"]');
    if (!dialog) return null;
    const selects = [...dialog.querySelectorAll('select')].map((select) => Number(select.value));
    return { title: dialog.querySelector('h2')?.textContent ?? '',
      notes: [...dialog.querySelectorAll('.ref-note')].map((note) => note.textContent),
      from: selects[0] ?? null, to: selects[1] ?? null,
      options: dialog.querySelector('select')?.querySelectorAll('option').length ?? 0,
      total: dialog.querySelector('[data-testid="ref-total"]')?.textContent ?? null,
      turns: [...dialog.querySelectorAll('[data-testid="ref-turn"]')].map((turn) => ({
        number: Number(turn.dataset.turn), included: turn.dataset.included === 'true',
        heading: turn.querySelector('h3')?.textContent ?? '', text: turn.querySelector('pre')?.textContent ?? '' })),
      stored: dialog.querySelector('.ref-stored')?.textContent ?? null,
      text: dialog.textContent ?? '' };
  });
}

/** @brief 等预览对话框读完（不再是"正在读取…"）。 */
export function waitPreview(page, timeout = 15000) {
  return page.waitForFunction(() => {
    const dialog = document.querySelector('[data-testid="ref-preview"]');
    return dialog && !dialog.textContent.includes('正在读取…');
  }, null, { timeout });
}

/** @brief 在预览对话框里选范围（两个下拉框）。 */
export async function pickRange(page, from, to) {
  const dialog = page.getByTestId('ref-preview');
  await dialog.getByRole('combobox', { name: '从第几轮' }).selectOption(String(from));
  await dialog.getByRole('combobox', { name: '到第几轮' }).selectOption(String(to));
}

/** @brief 某一栏里发出的会话引用：文字、状态、内容的开头。 */
export function sentSessionRefs(page, side) {
  return page.evaluate((css) => [...(document.querySelector(css)?.querySelectorAll(
    '[data-testid="sent-quote"][data-kind="session"]') ?? [])].map((item) => ({
    label: item.querySelector('.quote-chip-label')?.textContent ?? '',
    status: item.querySelector('[data-testid="quote-status"]')?.textContent ?? null,
    text: item.querySelector('.sent-quote-text')?.textContent ?? '' })), slotSelector(side));
}

/** @brief 某一栏里高亮的各项（回到原位置时的 .jump-flash）：你的消息的文字（前 30 个字）和高亮的项数。 */
export function flashedAt(page, side) {
  return page.evaluate((css) => {
    const items = [...(document.querySelector(css)?.querySelectorAll('.jump-flash') ?? [])];
    const users = items.map((item) => item.querySelector('[data-testid="user-message"]')?.textContent ?? '')
      .filter(Boolean).map((text) => text.slice(0, 30));
    return { count: items.length, users };
  }, slotSelector(side));
}

/** @brief 侧栏里会话文件为 file 的会话行的类名（active、in-split、dragging）。 */
export function rowClasses(page, file) {
  return page.locator(`.session-item[data-file=${JSON.stringify(file)}]`).first().getAttribute('class');
}

/** @brief 本机保存的布局（localStorage 的 mori.layout）。 */
export const savedLayout = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mori.layout') ?? '{}'));

/** @brief 新加的界面里小于 12px 的字（分屏标题行、芯片、预览、放下提示、关闭按钮）。 */
export function smallText(page) {
  return page.evaluate(() => [...document.querySelectorAll(
    '.topbar *, .quote-chip *, .ref-problem *, [data-testid="ref-preview"] *, [data-testid="drop-hint"], .sent-quote *')]
    .filter((element) => element.childNodes.length && [...element.childNodes].some((node) => node.nodeType === 3
      && node.textContent.trim()))
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12)
    .map((element) => `${element.className}: ${getComputedStyle(element).fontSize}`));
}
