// M5 测试（m5-app.mjs、m5-replay.mjs、m5-real.mjs）共用的页面操作：分屏的两栏、焦点、分屏中线、拖会话与放下提示、
// 会话引用的芯片、预览对话框、发出的引用、回到原会话的高亮；2026-10-21 起（docs/v0/composer-pickers.md）还有：把分屏的
// 一栏设成指定宽度、顶栏里会话名的地方（docs/v0/screens/chat.md"顶栏"）、F8 报告"Current view"的字段。
// 只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。

import { sleep } from './lib.mjs';
import { installKit } from './m1-layout.mjs';

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

/** @brief 等某一栏就绪（没有"Starting…"）。 */
export function waitPaneReady(page, side, timeout = 30000) {
  return page.waitForFunction((css) => document.querySelector(`${css} [data-testid="chat-pane"]`)
    && !document.querySelector(`${css} [data-testid="not-ready"]`), slotSelector(side), { timeout });
}

/**
 * @brief 等某一栏开始生成（data-running）。发送中不算："Stop"在发送中就出现，这时这一行有字时是单个"Queue"、
 *        文字框的提示也不是生成中的，等"Stop"之后按"生成中"量会偶发量错（2026-10-24，锁屏时发送中更久）。
 */
export function waitPaneRunning(page, side, timeout = 20000) {
  return page.waitForFunction((sel) => document.querySelector(sel)?.dataset.running === 'true',
    `${slotSelector(side)} [data-testid="chat-pane"]`, { timeout });
}

/** @brief 等某一栏开始生成、再等它结束。 */
export async function waitPaneIdle(page, side, timeout = 120000) {
  const css = `${slotSelector(side)} [data-testid="chat-pane"]`;
  await waitPaneRunning(page, side).catch(() => {});
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

/**
 * @brief 预览对话框的标题"Context · <会话名>"量出来的样子；没有对话框时为 null。
 *        clientHeight / scrollHeight：看得见的高度与内容的高度（被压矮时前者小于后者）；height / lineHeight：标题的盒子与
 *        一行的高度（line-height 为 normal 时取字本身的高度，即 Range 的外框；字被裁掉时 Range 仍报完整的大小）；
 *        lines：字排成几行；overflows：字比标题的盒子宽（scrollWidth 大于 clientWidth）；overflowX：标题横向的 overflow
 *        （computed）；textOverflow：放不下时的截断方式；inside：标题没有超出对话框的右边；headingRight / dialogRight：
 *        标题和对话框的右边；dialogWidth：对话框的宽；pageWidth：页面的宽（documentElement.clientWidth）；
 *        listFull：轮次列表占满了对话框（列表自己要滚动）。
 */
export function previewHeading(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="ref-preview"]');
    const heading = dialog?.querySelector('h2');
    if (!heading) return null;
    const style = getComputedStyle(heading);
    const range = document.createRange();
    range.selectNodeContents(heading);
    const tops = [...range.getClientRects()].map((rect) => rect.top).sort((a, b) => a - b);
    const box = heading.getBoundingClientRect();
    const frame = dialog.getBoundingClientRect();
    const list = dialog.querySelector('.ref-turns');
    const round = (value) => Math.round(value * 100) / 100;
    return { text: heading.textContent, clientHeight: heading.clientHeight, scrollHeight: heading.scrollHeight,
      height: round(box.height), lineHeight: round(style.lineHeight === 'normal' ? range.getBoundingClientRect().height
        : parseFloat(style.lineHeight)),
      lines: tops.filter((top, index) => index === 0 || top - tops[index - 1] > 2).length,
      overflows: heading.scrollWidth > heading.clientWidth, overflowX: style.overflowX,
      textOverflow: style.textOverflow,
      inside: box.right <= frame.right + 0.5, headingRight: round(box.right), dialogRight: round(frame.right),
      dialogWidth: round(frame.width), pageWidth: document.documentElement.clientWidth,
      listFull: Boolean(list && list.scrollHeight > list.clientHeight + 1) };
  });
}

/** @brief 标题完整显示：只有一行，看得见的高度不小于内容的高度，盒子不比一行矮（留 0.5px 的取整误差）。 */
export function headingWhole(heading) {
  return Boolean(heading) && heading.lines === 1 && heading.clientHeight >= heading.scrollHeight
    && heading.height + 0.5 >= heading.lineHeight;
}

/**
 * @brief 一行放不下的标题截断加省略号（session-refs.md"预览与调整范围"）：字确实比标题的盒子宽；标题横向裁掉超出的部分
 *        （overflow-x 为 hidden 或 clip，为 visible 时字伸到对话框外、省略号也不起作用）；text-overflow 为 ellipsis；
 *        只有一行；标题不超出对话框，标题和对话框的右边都在页面里；对话框宽 min(720px, 页面宽 − 32px)，没有被撑宽
 *        （.dialog.ref-preview 是 width: min(720px, 100%)，外层 .dialog-backdrop 左右各 16px 的 padding，border-box）。
 *        各项比较留 0.5px 的取整误差。
 */
export function headingTruncated(heading) {
  return Boolean(heading) && heading.overflows && ['hidden', 'clip'].includes(heading.overflowX)
    && heading.textOverflow === 'ellipsis' && heading.lines === 1 && heading.inside
    && heading.headingRight <= heading.pageWidth + 0.5 && heading.dialogRight <= heading.pageWidth + 0.5
    && Math.abs(heading.dialogWidth - Math.min(720, heading.pageWidth - 32)) <= 0.5;
}

/** @brief 等预览对话框读完（不再是"Loading…"）。 */
export function waitPreview(page, timeout = 15000) {
  return page.waitForFunction(() => {
    const dialog = document.querySelector('[data-testid="ref-preview"]');
    return dialog && !dialog.textContent.includes('Loading…');
  }, null, { timeout });
}

/** @brief 在预览对话框里选范围（两个下拉框）。 */
export async function pickRange(page, from, to) {
  const dialog = page.getByTestId('ref-preview');
  await dialog.getByRole('combobox', { name: 'From turn' }).selectOption(String(from));
  await dialog.getByRole('combobox', { name: 'To turn' }).selectOption(String(to));
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

/**
 * @brief 新加的界面里小于 12px 的字（分屏标题行、芯片、预览、放下提示、关闭按钮；2026-10-21 起还有输入框下面一行、
 *        圆环的悬停提示和详情、选择范围菜单和换范围失败那一行——后几个要开着才量得到）。
 */
export function smallText(page) {
  return page.evaluate(() => [...document.querySelectorAll(
    '.topbar *, .quote-chip *, .ref-problem *, [data-testid="ref-preview"] *, [data-testid="drop-hint"], '
    + '.sent-quote *, .composer-bottom *, [data-testid="usage-tip"], [data-testid="usage-tip"] *, '
    + '[data-testid="usage-details"] *, [data-testid="model-menu"] *, [data-testid="pick-error"], '
    + '[data-testid="pick-error"] *')]
    .filter((element) => element.childNodes.length && [...element.childNodes].some((node) => node.nodeType === 3
      && node.textContent.trim()))
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12)
    .map((element) => `${element.className}: ${getComputedStyle(element).fontSize}`));
}

/** @brief 某一栏会话面板（.chat-pane）的宽；这一栏不在时为 0。 */
export const paneWidth = (page, side) => page.evaluate((css) => document
  .querySelector(`${css} [data-testid="chat-pane"]`)?.getBoundingClientRect().width ?? 0, slotSelector(side));

/**
 * @brief 拖分屏中线，把 side（left / right）那一栏的会话面板设成 width 宽（右边那一栏的 .chat-pane 比 .pane-slot 窄 1px；
 *        两栏各至少 280px，所以右边一栏最窄 279px）。设不到时（中栏太窄、到了中线的范围）返回量到的宽。
 */
export async function setSplitWidth(page, side, width) {
  for (let tries = 0; tries < 6; tries += 1) {
    const now = await paneWidth(page, side);
    if (Math.abs(now - width) <= 0.5) return now;
    const handle = await page.locator('[data-resize="split"]').boundingBox();
    if (!handle) return now;
    const dx = side === 'left' ? width - now : now - width;
    const x = handle.x + handle.width / 2;
    const y = handle.y + Math.min(200, handle.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 5 });
    await page.mouse.up();
    await sleep(150);
  }
  return paneWidth(page, side);
}

/**
 * @brief 某一栏顶栏里会话名的地方（chat.md"顶栏"）：会话面板的宽、会话名（字、宽、是否截短）、项目名的宽（不显示时 0）、
 *        › 是否显示、两个图标按钮的宽、顶栏的左右内边距、顶栏和面包屑里剩下没用的宽、顶栏是否溢出。
 */
export async function titleRoom(page, side) {
  await installKit(page);
  return page.evaluate((css) => {
    const kit = window.__rowKit;
    const pane = document.querySelector(`${css} [data-testid="chat-pane"]`);
    const bar = pane?.querySelector(':scope > .topbar');
    if (!bar) return null;
    const crumb = bar.querySelector('.breadcrumb');
    const project = bar.querySelector('.chat-project');
    const chevron = crumb?.querySelector(':scope > svg');
    // 一个盒子里没被直接子项和间距占掉的宽
    const free = (box) => {
      const style = getComputedStyle(box);
      const kids = [...box.children].filter(kit.pkVisible);
      const used = kids.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
      const gaps = (parseFloat(style.columnGap) || 0) * Math.max(0, kids.length - 1);
      return box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - used - gaps;
    };
    const buttons = [...bar.querySelectorAll('.icon-button')].filter(kit.pkVisible).map((el) => kit.pkRect(el).width);
    const padding = getComputedStyle(bar);
    return { pane: kit.pkRect(pane).width, title: kit.pkText(bar.querySelector('[data-testid="session-title"]')),
      project: kit.pkVisible(project) ? kit.pkRect(project).width : 0, chevron: kit.pkVisible(chevron), buttons,
      padding: [parseFloat(padding.paddingLeft), parseFloat(padding.paddingRight)], slack: free(bar) + free(crumb),
      overflows: bar.scrollWidth > bar.clientWidth + 1 };
  }, slotSelector(side));
}

/**
 * @brief 顶栏里会话名的地方的问题（chat.md"顶栏"，composer-pickers.md"测试要改的地方"新加的检查第 1 条）：会话名要么完整，
 *        要么占满剩下的地方（差 2px 以内）、这时项目名已收到 40px；项目名最长 160px；≤ 400px 时两个图标按钮 28px；
 *        ≤ 320px 不显示项目名和 ›，宽于 320px 时都显示；截短的会话名有省略号；顶栏不溢出；minimum 是会话名至少要有的宽。
 */
export function titleProblems(room, minimum = 0) {
  if (!room?.title) return ['no session title'];
  const out = [];
  const tiny = room.pane <= 320;
  if (room.title.truncated && room.slack > 2) out.push(`title cut with ${room.slack.toFixed(1)}px left`);
  if (room.title.truncated && !tiny && room.project > 40.5) out.push(`title cut, project still ${room.project}px`);
  if (room.project > 160.5) out.push(`project ${room.project}px`);
  if (tiny === (room.project > 0) || tiny === room.chevron) {
    out.push(`project shown=${room.project > 0} at ${room.pane}`);
  }
  if (room.pane <= 400 && room.buttons.some((width) => Math.abs(width - 28) > 0.5)) {
    out.push(`buttons ${room.buttons}`);
  }
  if (room.title.truncated && !room.title.ellipsis) out.push('title cut without an ellipsis');
  if (room.title.width < minimum - 0.5) out.push(`title ${room.title.width}px < ${minimum}px`);
  if (room.overflows) out.push('top bar overflows');
  return out;
}

/** @brief F8 报告（Markdown）里"- <字段>: <值>"一行的值；没有这一行时为 null。 */
export function reportField(report, label) {
  const line = report.split(/\r?\n/).find((item) => item.startsWith(`- ${label}: `));
  return line ? line.slice(label.length + 4) : null;
}

/** @brief F8 报告（Markdown）"Current view"里各行的字段名，按出现的先后。 */
export function reportLabels(report) {
  return report.split(/\r?\n/).map((line) => /^- ([^:]+): /.exec(line)?.[1]).filter(Boolean);
}

/**
 * @brief 某一栏输入框下面一行里 F8 报告要写的三项（docs/v0/screens/f8.md"保存的内容"）：Effort（按钮读屏名去掉
 *        "Effort: "；没有按钮时"None"）、Model range（范围按钮的 data-pick；没有时"None"）、Model（data-current；没有时
 *        "None"），以及这一栏 .chat-pane 和 .pane-slot 的宽。
 */
export function paneView(page, side) {
  return page.evaluate((css) => {
    const slot = document.querySelector(css);
    const model = slot?.querySelector('.composer-bottom [data-testid="model-button"]');
    const effort = slot?.querySelector('.composer-bottom [data-testid="thinking-button"]');
    return { effort: effort?.getAttribute('aria-label')?.replace(/^Effort: /, '') ?? 'None',
      range: model?.dataset.pick ?? 'None', model: model?.dataset.current ?? 'None',
      pane: slot?.querySelector('[data-testid="chat-pane"]')?.getBoundingClientRect().width ?? 0,
      slot: slot?.getBoundingClientRect().width ?? 0 };
  }, slotSelector(side));
}

/**
 * @brief F8 报告的"Current view"（字段名 → 值）与焦点所在那一栏比（f8.md"保存的内容"、composer-pickers.md"我自己定的"
 *        第 16 条）：Model range、Model、Effort 是这一栏的；Pane width 是这一栏 .chat-pane 的宽（整数 px，右边一栏比
 *        .pane-slot 窄 1px）；"Model range"在"Model"前、"Effort"紧跟"Model"，"Pane width"紧跟"Window size"；
 *        "Model""Permission mode"照旧。返回问题列表。
 * @param side 焦点所在的一栏（left / right / single）
 */
export function viewProblems(field, labels, view, side) {
  const out = [];
  const width = /^(\d+)px$/.exec(field('Pane width') ?? '');
  if (!width || Math.abs(Number(width[1]) - view.pane) > 0.51) {
    out.push(`Pane width ${field('Pane width')} ≠ ${view.pane}`);
  }
  if (side === 'right' && Math.abs(view.slot - view.pane - 1) > 0.51) {
    out.push(`right pane ${view.pane} / slot ${view.slot}`);
  }
  for (const [label, want] of [['Model range', view.range], ['Model', view.model], ['Effort', view.effort]]) {
    if (field(label) !== want) out.push(`${label} ${field(label)} ≠ ${want}`);
  }
  if (field('Permission mode') === null) out.push('no Permission mode');
  const at = (label) => labels.indexOf(label);
  if (!(at('Model range') >= 0 && at('Model range') + 1 === at('Model') && at('Model') + 1 === at('Effort'))) {
    out.push(`order ${labels.join(', ')}`);
  }
  if (at('Window size') < 0 || at('Window size') + 1 !== at('Pane width')) {
    out.push('Pane width not after Window size');
  }
  return out;
}

/** @brief 关上贴在右边的右栏（开着时）。 */
export async function closeRightPanel(page) {
  if (await page.getByTestId('right-panel').count() === 0) return;
  await page.getByTestId('right-panel').getByRole('button', { name: 'Close panel' }).first().click();
  await sleep(300);
}
