// M1 布局检查（回放页面里运行）：分隔线拖动、方向键、双击恢复、宽度保存；800 宽不裁切；字号不小于 12px；输入法 Enter。
// 2026-10-26 走查 M23（WP-13）：右栏没有 800px 上限、右栏存得宽后窗口变窄时左栏的分隔线还在、右栏的"Expand" / "Collapse"。
// 2026-10-21 起另导出输入框下面一行（.composer-bottom；docs/v0/screens/chat.md"输入框下面一行"、models.md，
// docs/v0/composer-pickers.md"宽度估算""测试要改的地方"）的量法和检查，m1、m5 的测试共用：量这一行（各项的盒子、截短、
// 读屏名、悬停的各行、读屏的描述）、按会话面板（.chat-pane）的宽度分档查、按状态查不可用的原因、量往上打开的菜单和圆环，
// 以及把单栏的会话面板设成指定宽度。选择范围按钮是 v1 的（docs/v1/screens/model-menu.md）：悬停三行，描述元素
// data-testid="model-tip" 在按钮外面。共同的读法（composer-pickers.md"测试要改的地方"C1、C2）："不可用"读 aria-disabled，
// "切换中"读 data-pending，悬停说明按 \n 分行比。

import { join } from 'node:path';
import { oneLine, sleep } from './lib.mjs';

/** @brief 页面里所有可见文字的字号；返回小于 12px 的元素描述。 */
export function smallText(page) {
  return page.evaluate(() => {
    const small = [];
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) walk(element.shadowRoot);
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        const placeholder = element.getAttribute?.('placeholder');
        if (!hasText && !placeholder) continue;
        if (element.getClientRects().length === 0) continue;
        const size = parseFloat(getComputedStyle(element).fontSize);
        if (size < 12) small.push(`${element.tagName.toLowerCase()}.${element.className} ${size}px "${element.textContent.trim().slice(0, 20)}"`);
      }
    };
    walk(document);
    return small;
  });
}

// ---------- 页面里运行的量法（装进 window.__rowKit；每个函数单独转成源码，彼此按名字调用，不能用模块里的别的东西） ----------

/** @brief 页面里：元素看得见（有盒子、不是 visibility: hidden）。 */
function pkVisible(el) {
  return Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** @brief 页面里：元素的外框（两位小数）。 */
function pkRect(el) {
  const r = el.getBoundingClientRect();
  const round = (value) => Math.round(value * 100) / 100;
  return { left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom),
    width: round(r.width), height: round(r.height) };
}

/** @brief 页面里：读屏的描述（aria-describedby 指向的元素的文字）；没有时为 null。 */
function pkDesc(el) {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const text = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return text || null;
}

/**
 * @brief 页面里：el 不截短时的宽：在同一位置放一个 width: max-content 的藏起来的副本量（composer-pickers.md
 *        "测试要改的地方"新加的检查第 3 条：不用 scrollWidth，截短时它可能等于 clientWidth）。text 给出时副本里换成这段字。
 */
function pkFull(el, text) {
  const copy = el.cloneNode(true);
  if (text !== undefined) copy.textContent = text;
  copy.removeAttribute('id');
  Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', width: 'max-content', maxWidth: 'none',
    minWidth: '0', overflow: 'visible', textOverflow: 'clip', flex: 'none', left: '0', top: '0' });
  el.parentElement.appendChild(copy);
  const width = copy.getBoundingClientRect().width;
  copy.remove();
  return width;
}

/**
 * @brief 页面里：装字的元素：字、宽、全文的宽、是否截短（比全文窄 0.01px 以上）、截短的样式（省略号、不换行、裁掉）、
 *        开头两个字加"…"要多宽（最窄时"Ask …"和"Allo…"分得开）。
 */
function pkText(el) {
  if (!el) return null;
  const width = el.getBoundingClientRect().width;
  const full = pkFull(el);
  const style = getComputedStyle(el);
  const round = (value) => Math.round(value * 100) / 100;
  return { text: el.textContent, width: round(width), full: round(full), truncated: width < full - 0.01,
    ellipsis: style.textOverflow === 'ellipsis' && ['nowrap', 'pre'].includes(style.whiteSpace)
      && ['hidden', 'clip'].includes(style.overflowX),
    twoChars: round(pkFull(el, `${el.textContent.trim().slice(0, 2)}…`)) };
}

/** @brief 页面里：一个按钮（或说明）：盒子、内边距、看得见的图标数、读屏名、悬停、描述、看得见的字；看不见时为 null。 */
function pkButton(el) {
  if (!pkVisible(el)) return null;
  const style = getComputedStyle(el);
  return { ...pkRect(el), padL: parseFloat(style.paddingLeft), padR: parseFloat(style.paddingRight),
    svgs: [...el.querySelectorAll('svg')].filter(pkVisible).length, allSvgs: el.querySelectorAll('svg').length,
    label: el.getAttribute('aria-label'), title: el.getAttribute('title'), desc: pkDesc(el),
    disabled: el.disabled === true, ariaDisabled: el.getAttribute('aria-disabled'),
    pending: el.dataset.pending ?? null, shown: el.innerText.trim(), content: el.textContent.trim(),
    shortcuts: el.getAttribute('aria-keyshortcuts') };
}

/**
 * @brief 页面里：选择范围按钮（v1）：按钮本身，范围名（.range-scope）和当前模型 id（.range-model，带开头的" · "）
 *        两段各自的截短，data-pick / data-current，描述元素（data-testid="model-tip"，要在按钮外面、被 aria-describedby 指着）。
 */
function pkModel(el) {
  const wrap = el.closest('.model-switch') ?? el.parentElement;
  const tip = wrap.querySelector('[data-testid="model-tip"]');
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/);
  return { ...pkButton(el), scope: pkText(el.querySelector('.range-scope')),
    tail: pkText(el.querySelector('.range-model')), pick: el.dataset.pick ?? null, current: el.dataset.current ?? null,
    tip: tip?.textContent ?? null, tipOutside: Boolean(tip) && !el.contains(tip),
    tipLinked: Boolean(tip?.id) && ids.includes(tip.id) };
}

/** @brief 页面里：这一行的一个直接子项是哪一项（包了几项时用"+"连起来，例如"model+effort"）。 */
function pkKind(el) {
  const has = (css) => el.matches(css) || Boolean(el.querySelector(css));
  const kinds = [['permission', '[data-testid="permission-button"]'], ['model', '[data-testid="model-button"]'],
    ['effort', '[data-testid="thinking-button"]'], ['ring', '[data-testid="usage"]'],
    ['wait', '[data-testid="not-ready"]'], ['queue', '.split-button, .queue-button'], ['stop', '.stop-button'],
    ['send', '.send-button']];
  return kinds.filter(([, css]) => has(css)).map(([kind]) => kind).join('+') || `other:${el.className}`;
}

/** @brief 页面里：一种颜色的 RGBA（画一个像素再读回来，任何 CSS 颜色写法都能比）。 */
function pkRgb(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

/** @brief 页面里：一个颜色 token（例如 --color-line）在 host 里算出来的 RGB（"r,g,b"）。 */
function pkToken(host, name) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  host.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return pkRgb(color).slice(0, 3).join();
}

/** @brief 页面里：字的颜色和它实际的底色（半透明的底色逐层叠到不透明为止）的对比度。 */
function pkContrast(el) {
  const layers = [];
  for (let node = el; node; node = node.parentElement) {
    const bg = pkRgb(getComputedStyle(node).backgroundColor);
    if (bg[3] > 0) layers.push(bg);
    if (bg[3] >= 1) break;
  }
  let base = [255, 255, 255];
  for (const [r, g, b, a] of layers.reverse()) base = [r, g, b].map((value, i) => value * a + base[i] * (1 - a));
  const luminance = (rgb) => rgb.slice(0, 3).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [light, dark] = [luminance(pkRgb(getComputedStyle(el).color)), luminance(base)].sort((a, b) => b - a);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

/**
 * @brief 页面里：这一行里各项的样子（看不见的项为 null）。"Queue"主按钮收起时 queueHidden 为真；准备中只有一个按钮的
 *        "Queue"（.queue-button，不在 .split-button 里）时 queueSingle 为真。
 */
function pkItems(row) {
  const at = (css) => row.querySelector(css);
  const perm = at('[data-testid="permission-button"]');
  const model = at('[data-testid="model-button"]');
  const effort = at('[data-testid="thinking-button"]');
  const wait = at('[data-testid="not-ready"]');
  const queue = at('.split-button > .button:not(.split-toggle)') ?? at('.queue-button');
  const permText = perm?.querySelector('.permission-text');
  return {
    permission: pkButton(perm) && { ...pkButton(perm), text: pkText(permText), all: perm.classList.contains('all'),
      contrast: pkContrast(permText ?? perm) },
    model: pkButton(model) && pkModel(model),
    effort: pkButton(effort) && { ...pkButton(effort), text: pkText(effort.querySelector('.switch-text') ?? effort),
      level: effort.dataset.level ?? null, reasoning: effort.dataset.reasoning ?? null },
    ring: pkButton(at('[data-testid="usage"]')),
    wait: pkButton(wait) && { ...pkButton(wait), text: pkText(wait) },
    queue: pkButton(queue), queueHidden: Boolean(queue) && !pkVisible(queue),
    queueSingle: Boolean(queue) && !queue.closest('.split-button'),
    toggle: pkButton(at('.split-toggle')), stop: pkButton(at('.stop-button')), send: pkButton(at('.send-button')),
  };
}

/**
 * @brief 页面里：scope（.pane-slot 的选择器）那一栏输入框下面一行的样子；没有这一行时为 null。另记顶栏里还剩几个
 *        这一行的按钮（应为 0）、拒绝启动卡的位置、文字框的占位文字。
 */
function pkRow(scope) {
  const pane = document.querySelector(`${scope} [data-testid="chat-pane"]`);
  const row = pane?.querySelector('[data-testid="composer"] .composer-bottom');
  if (!row) return null;
  const style = getComputedStyle(row);
  const box = pkRect(row);
  const kids = [...row.children].filter(pkVisible).map((el) => ({ kind: pkKind(el), ...pkRect(el) }));
  const bar = pane.querySelector(':scope > .topbar');
  const card = pane.querySelector('[data-testid="blocked-card"]');
  const pickers = '[data-testid="model-button"], [data-testid="thinking-button"], [data-testid="permission-button"], '
    + '[data-testid="usage"]';
  return { pane: pkRect(pane).width, slot: pkRect(pane.closest('.pane-slot') ?? pane).width,
    running: pane.dataset.running === 'true', sending: pane.dataset.sending === 'true',
    row: { ...box, scroll: row.scrollWidth, client: row.clientWidth,
      start: box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
      end: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) },
    composer: pkRect(pane.querySelector('[data-testid="composer"]')), kids, items: pkItems(row),
    rings: pane.querySelectorAll('[data-testid="usage"]').length,
    inputs: row.querySelectorAll('textarea, input').length,
    inTopbar: bar ? bar.querySelectorAll(pickers).length : 0, card: pkVisible(card) ? pkRect(card) : null,
    placeholder: pane.querySelector('[data-testid="composer"] textarea')?.placeholder ?? null };
}

/**
 * @brief 页面里：scope 那一栏的圆环：data-*、读屏名、描述、悬停提示、详情、底圈和填充的颜色、颜色 token。
 *        底圈和填充是 .ring-base / .ring-fill（没有这两个类时取 svg 里的第一、第二个 circle）。
 */
function pkRing(scope) {
  const ring = document.querySelector(`${scope} [data-testid="usage"]`);
  if (!ring) return null;
  const pane = ring.closest('[data-testid="chat-pane"]') ?? document;
  const tip = pane.querySelector('[data-testid="usage-tip"]');
  const details = pane.querySelector('[data-testid="usage-details"]');
  const circles = [...ring.querySelectorAll('circle')];
  const base = ring.querySelector('.ring-base') ?? circles[0] ?? null;
  const fill = ring.querySelector('.ring-fill') ?? circles[1] ?? null;
  const style = (el) => getComputedStyle(el);
  const stroke = (el) => (el ? pkRgb(style(el).stroke).slice(0, 3).join() : null);
  const dash = fill ? style(fill).strokeDasharray : 'none';
  const names = ['--color-line', '--color-faint', '--color-accent', '--color-warn-text', '--color-danger'];
  return { state: ring.dataset.state ?? null, tokens: ring.dataset.tokens ?? null,
    percent: ring.dataset.percent ?? null, label: ring.getAttribute('aria-label'), title: ring.getAttribute('title'),
    desc: pkDesc(ring), expanded: ring.getAttribute('aria-expanded'), controls: ring.getAttribute('aria-controls'),
    detailsId: details?.id ?? null, details: pkVisible(details) ? details.textContent : null,
    tip: pkVisible(tip) ? tip.textContent : null, tipHidden: tip?.getAttribute('aria-hidden') ?? null,
    width: pkRect(ring).width, focused: document.activeElement === ring, base: stroke(base), fill: stroke(fill),
    filled: Boolean(fill) && (dash === 'none' || parseFloat(dash) > 0.01),
    dashed: Boolean(base) && !['none', ''].includes(style(base).strokeDasharray),
    colors: Object.fromEntries(names.map((name) => [name, pkToken(ring, name)])) };
}

/**
 * @brief 页面里：scope 那一栏里 css 选中的浮层（菜单、圆环详情、换范围失败那一行）和 anchor 按钮的位置，以及这一行、
 *        会话面板、顶栏、窗口；浮层看不见时为 null。scrolls：内容比浮层高、在浮层里滚动；items：范围菜单各项的名字。
 */
function pkPopover(scope, css, anchor) {
  const pane = document.querySelector(`${scope} [data-testid="chat-pane"]`);
  const pop = pane?.querySelector(css);
  if (!pkVisible(pop)) return null;
  const button = anchor ? pane.querySelector(anchor) : null;
  const active = document.activeElement;
  const items = [...pop.querySelectorAll('[role="menuitemradio"]')].filter((el) => el.querySelector('.switch-text'))
    .map((el) => ({ name: pkText(el.querySelector('.switch-text')), title: el.getAttribute('title') }));
  return { pop: pkRect(pop), row: pkRect(pane.querySelector('[data-testid="composer"] .composer-bottom')),
    pane: pkRect(pane), topbar: pkRect(pane.querySelector(':scope > .topbar') ?? pane),
    anchor: button ? pkRect(button) : null, view: { width: innerWidth, height: innerHeight },
    scrolls: pop.scrollHeight > pop.clientHeight + 1, maxHeight: parseFloat(getComputedStyle(pop).maxHeight) || null,
    focusIn: pop.contains(active), focusOnAnchor: Boolean(button) && active === button, items };
}

/**
 * @brief 页面里：盯住 scope 选中的各栏，每出现一种新的状态就量一次这一行（连同那一刻焦点所在元素的 data-testid），
 *        记在 window.__rowSeen["<side>|<状态>"]。状态是按钮位置的说明（"Starting…"等）、"preparing"（发了消息、
 *        pi 还没开始）和"pending"（换范围或换强度的请求还没返回）。用来抓一闪而过的状态。
 */
function pkWatch(scope) {
  window.__rowWatch?.disconnect();
  window.__rowSeen = {};
  const take = () => {
    for (const slot of document.querySelectorAll(scope)) {
      const pane = slot.querySelector('[data-testid="chat-pane"]');
      const note = slot.querySelector('[data-testid="not-ready"]')?.textContent ?? null;
      const preparing = pane?.dataset.sending === 'true' && pane.dataset.running !== 'true';
      const pending = Boolean(slot.querySelector('.composer-bottom [data-pending="true"]'));
      const states = [note, preparing ? 'preparing' : null, pending ? 'pending' : null].filter(Boolean);
      const css = slot.dataset.side ? `.pane-slot[data-side="${slot.dataset.side}"]` : scope;
      for (const state of states) {
        const key = `${slot.dataset.side ?? ''}|${state}`;
        if (window.__rowSeen[key]) continue;
        const focused = document.activeElement;
        window.__rowSeen[key] = { ...pkRow(css), focus: focused?.dataset?.testid ?? focused?.tagName ?? null };
      }
    }
  };
  window.__rowWatch = new MutationObserver(take);
  window.__rowWatch.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  take();
}

const PAGE_KIT = [pkVisible, pkRect, pkDesc, pkFull, pkText, pkButton, pkModel, pkKind, pkRgb, pkToken, pkContrast,
  pkItems, pkRow, pkRing, pkPopover, pkWatch];
const KIT_SOURCE = `window.__rowKit = (() => {\n${PAGE_KIT.map(String).join('\n')}\nreturn { ${
  PAGE_KIT.map((fn) => fn.name).join(', ')} };\n})();`;

/** 单栏时显示的那一栏 */
export const SINGLE = '.pane-slot:not([hidden])';
/** 回放里选择范围按钮悬停的第二行：回放桥合成的提供商名"replay"（harness/replay.js v1PickOptions） */
export const REPLAY_TIP = 'replay';

/** @brief 把量法装进页面（每次载入页面后都要重装；重复装没有关系）。 */
export const installKit = (page) => page.evaluate(KIT_SOURCE);

/** @brief 量 scope（.pane-slot 的选择器）那一栏输入框下面一行；没有时为 null。 */
export async function composerRow(page, scope = SINGLE) {
  await installKit(page);
  return page.evaluate((css) => window.__rowKit.pkRow(css), scope);
}

/** @brief 量 scope 那一栏的圆环；没有圆环时为 null。 */
export async function ringState(page, scope = SINGLE) {
  await installKit(page);
  return page.evaluate((css) => window.__rowKit.pkRing(css), scope);
}

/** @brief 量 scope 那一栏里 css 选中的浮层（anchor 是打开它的按钮的选择器）；看不见时为 null。 */
export async function popoverBox(page, scope, css, anchor = null) {
  await installKit(page);
  return page.evaluate(({ s, c, a }) => window.__rowKit.pkPopover(s, c, a), { s: scope, c: css, a: anchor });
}

/** @brief 开始盯 scope 选中的各栏这一行的状态（见 pkWatch）。 */
export async function watchRows(page, scope = SINGLE) {
  await installKit(page);
  await page.evaluate((css) => window.__rowKit.pkWatch(css), scope);
}

/** @brief 停止盯，返回抓到的各个状态 {"<side>|<状态>": 这一行的样子}。 */
export function seenRows(page) {
  return page.evaluate(() => {
    window.__rowWatch?.disconnect();
    return window.__rowSeen ?? {};
  });
}

/** @brief 在 seenRows 的结果里找状态为 state（按钮位置的说明、"preparing"或"pending"）的那一次；没有时为 null。 */
export const seenWith = (seen, state) => Object.entries(seen).find(([key]) => key.endsWith(`|${state}`))?.[1] ?? null;

// ---------- Node 里的检查（都返回问题列表，空表示通过） ----------

/** 截短的四项的最窄（px）：[宽于 340px, ≤ 340px]（composer-pickers.md"我自己定的"第 1 条） */
const MIN_WIDTH = { wait: [48, 48], model: [40, 36], permission: [44, 40], effort: [40, 36] };
/** 选择范围按钮任何宽度的上限（px，composer-pickers.md"按推荐定的"第 1 条） */
const MODEL_MAX = 200;
/** 这一行各项从左到右的顺序（chat.md"输入框下面一行"；说明和"Queue"不同时出现） */
const ORDER = ['permission', 'model', 'effort', 'ring', 'wait', 'queue', 'stop', 'send'];
/** 不能发送时按钮位置的说明，也是这一行按钮不可用的原因（models.md"不可用时、按钮消失时的焦点"） */
export const REASONS = { crashed: 'Mori’s background process crashed', restarting: 'Restarting…',
  reopening: 'Starting…', opening: 'Starting…', failed: 'Session didn’t open' };
/** 准备中、生成中选择范围按钮和 Effort 不可用的原因（ui-strings.md"选择范围、Effort 按钮的悬停"） */
export const BUSY = { model: 'Can’t switch models until the response finishes',
  effort: 'Can’t change effort until the response finishes' };
/** 能用时悬停的第二行（approval.md"权限菜单"、models.md"思考强度"、model-menu.md"选择范围按钮"） */
export const NOTES = { ask: 'Change the permission mode', all: 'Edits, writes, and commands will run without asking.',
  effort: 'Set the effort level for this session', unsupported: 'This model isn’t marked “Supports thinking”',
  noCurrent: 'No model can run in this session' };
/** 文字框的占位文字（chat.md"输入框下面一行"） */
const PLACEHOLDERS = { idle: 'Enter to send · Shift+Enter for new line',
  preparing: 'Enter to queue · Shift+Enter for new line',
  running: 'Enter to queue · Ctrl+Enter to steer · Shift+Enter for new line' };
/** 悬停第二行"<提供商名>"的样子（不知道提供商名时只比格式：不空，2026-10-26 起不再带" · <区域>"） */
const PROVIDER_LINE = /^(?!.* · (Local|Intranet|Public|Zone not confirmed)$).+$/;

/** @brief 一项在这一栏宽度下的最窄。 */
const minOf = (row, name) => MIN_WIDTH[name][row.pane <= 340 ? 1 : 0];
/** @brief 两个数相差不超过 tolerance。 */
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance;
/** @brief 悬停说明的各行。 */
const lines = (item) => (item?.title ?? '').split('\n');
/** @brief 一项里有字被截短（选择范围按钮看两段）。 */
const cutOf = (item) => Boolean(item?.text?.truncated || item?.scope?.truncated || item?.tail?.truncated);
/** @brief 一项因为这一行放不下而截短（选择范围按钮到了 200px 的上限时截短不算）。 */
const squeezed = (name, item) => cutOf(item) && !(name === 'model' && item.width >= MODEL_MAX - 0.5);

/** @brief 各项从左到右的顺序、都是这一行的直接子项、权限在左端、最后一项贴右端（权限后面一项 margin-left: auto）。 */
function orderProblems(row) {
  const out = [];
  const kinds = row.kids.map((kid) => kid.kind);
  const order = kinds.map((kind) => ORDER.indexOf(kind));
  if (order.some((n, i) => n < 0 || (i > 0 && n <= order[i - 1]))) out.push(`items ${kinds.join(', ')}`);
  for (const name of ['permission', 'model', 'effort', 'ring']) {
    if (row.items[name] && !kinds.includes(name)) out.push(`${name} is not a direct child of the row`);
  }
  const [first, last] = [row.kids[0], row.kids.at(-1)];
  if (first?.kind !== 'permission' || !near(first.left, row.row.start, 1)) out.push('permission not at the left end');
  if (row.kids.length > 1 && !near(last.right, row.row.end, 1)) {
    out.push(`last item ends at ${last.right}, the row at ${row.row.end}`);
  }
  return out;
}

/**
 * @brief 这一行不换行、不超出输入框、高 33px（不能发送时也是）、各项是这一行的直接子项且顺序对、每栏一个圆环、这一行里
 *        没有文字框、顶栏里不再有这几项、拒绝启动卡在输入框上方（chat.md"输入框下面一行"、models.md"位置"）。
 */
export function layoutProblems(row) {
  if (!row) return ['no message-box row'];
  const out = [];
  const box = row.row;
  if (box.scroll > box.client + 1) out.push(`row overflows (${box.scroll} > ${box.client})`);
  if (!near(box.height, 33, 1)) out.push(`row height ${box.height}`);
  for (const kid of row.kids) {
    if (kid.top < box.top - 1 || kid.bottom > box.bottom + 1) out.push(`${kid.kind} not on the row's line`);
    const left = Math.max(row.composer.left, box.start);
    const right = Math.min(row.composer.right, box.end);
    if (kid.left < left - 0.5 || kid.right > right + 0.5) out.push(`${kid.kind} outside the message box`);
  }
  out.push(...orderProblems(row));
  if (row.rings > 1) out.push(`${row.rings} rings in one pane`);
  if (row.inputs > 0) out.push('a text box inside the row');
  if (row.inTopbar > 0) out.push(`${row.inTopbar} of these buttons still in the top bar`);
  if (row.card && row.card.bottom > row.composer.top + 0.5) out.push('blocked card not above the message box');
  return out;
}

/** @brief 相邻两项的间距 8px（≤ 460px 时 4px）；权限和它后面那一项之间是 margin-left: auto 推开的，至少一个间距。 */
function spacingProblems(row) {
  const want = row.pane <= 460 ? 4 : 8;
  const out = [];
  const gaps = row.kids.slice(2).map((kid, i) => kid.left - row.kids[i + 1].right);
  if (gaps.some((gap) => !near(gap, want, 0.6))) out.push(`gaps ${gaps.map((gap) => gap.toFixed(1))} ≠ ${want}px`);
  if (row.kids.length > 1 && row.kids[1].left - row.kids[0].right < want - 0.6) out.push('no gap after permission');
  return out;
}

/** @brief 有空余（权限后面那个推开的空白多于 1px）时不截短任何一项（范围按钮到了 200px 的上限除外）。 */
function slackProblems(row) {
  if (row.kids.length < 2) return [];
  const spare = row.kids[1].left - row.kids[0].right - (row.pane <= 460 ? 4 : 8);
  if (spare <= 1) return [];
  return Object.entries(row.items).filter(([name, item]) => squeezed(name, item))
    .map(([name]) => `${name} cut with ${spare.toFixed(1)}px to spare`);
}

/**
 * @brief 发送组按这一栏的宽度（models.md"窄栏"）：≤ 600px 只有图标（"Send"、"Stop"、"Queue"各 32px，≤ 340px 时
 *        "Send"、"Stop"和准备中的"Queue" 28px，▾ 24px），名字在读屏名里；悬停说明；≤ 400px 生成中有字时收起"Queue"、
 *        只留 ▾；准备中的"Queue"只有一个按钮、不收起。
 */
function sendProblems(row) {
  const w = row.pane;
  const { queue, queueHidden, queueSingle, toggle, stop, send } = row.items;
  const out = [];
  const icon = w <= 600;
  const small = w <= 340 ? 28 : 32;
  for (const [name, item, size] of [['Send', send, small], ['Stop', stop, small],
    ['Queue', queue, queueSingle ? small : 32]]) {
    if (!item) continue;
    if (icon && (item.shown !== '' || item.label !== name || !near(item.width, size))) {
      out.push(`${name} at ${w}px: "${item.shown}" / ${item.label} / ${item.width}px`);
    }
    if (!icon && item.shown !== name) out.push(`${name} at ${w}px shows "${item.shown}"`);
  }
  for (const [item, title] of [[stop, 'Stop response (Esc)'], [queue, 'Queue for later (Enter)'],
    [icon ? send : null, 'Send (Enter)']]) {
    if (item && item.title !== title) out.push(`hover "${item.title}" ≠ "${title}"`);
  }
  if (toggle && toggle.label !== 'More send options') out.push(`▾ named ${toggle.label}`);
  if (toggle && icon && !near(toggle.width, 24)) out.push(`▾ ${toggle.width}px at ${w}px`);
  if (toggle && (w <= 400 ? Boolean(queue) || !queueHidden : !queue)) {
    out.push(`Queue at ${w}px shown=${Boolean(queue)}`);
  }
  if (queueSingle && (toggle || queueHidden)) {
    out.push(`preparing Queue at ${w}px: ▾ ${Boolean(toggle)}, hidden ${queueHidden}`);
  }
  return out;
}

/**
 * @brief 按这一栏的宽度分档（models.md"窄栏"）：间距 8 / 4px；选择范围按钮任何宽度最长 200px；≤ 680px 去掉"Effort: "
 *        （textContent 仍带）；≤ 460px 去掉 ▾；≤ 340px 内边距 4px；权限任何宽度都没有图标；圆环 26px；发送组见
 *        sendProblems；有空余时不截短。
 */
export function bandProblems(row) {
  if (!row) return ['no message-box row'];
  const w = row.pane;
  const { permission: perm, model, effort, ring } = row.items;
  const out = [...spacingProblems(row)];
  if (model && model.width > MODEL_MAX + 0.5) out.push(`model range ${model.width}px at ${w}px`);
  if (effort && effort.shown.startsWith('Effort:') === w <= 680) out.push(`Effort shows "${effort.shown}" at ${w}px`);
  if (effort && !effort.content.startsWith('Effort: ')) out.push(`Effort text "${effort.content}"`);
  for (const [name, item] of [['permission', perm], ['model', model], ['effort', effort]]) {
    if (item && item.svgs !== (w <= 460 ? 0 : 1)) out.push(`${name} shows ${item.svgs} icons at ${w}px`);
    if (item && w <= 340 && !(near(item.padL, 4) && near(item.padR, 4))) {
      out.push(`${name} padding ${item.padL}/${item.padR} at ${w}px`);
    }
  }
  if (perm && perm.allSvgs > 1) out.push(`permission button has ${perm.allSvgs} icons (only ▾ allowed)`);
  if (ring && !near(ring.width, 26)) out.push(`ring ${ring.width}px`);
  return out.concat(sendProblems(row), slackProblems(row));
}

/**
 * @brief 截短（models.md"窄栏"放不下）：各项不窄于最窄；截短的用省略号；先后是说明 → 选择范围（先截 .range-model，
 *        再截 .range-scope）→ 模式名 → Effort，前一项到最窄（差 1px 以内）才轮到下一项；宽于 400px 时模式名不截；
 *        模式名至少看得见开头两个字。
 */
export function truncationProblems(row) {
  if (!row) return ['no message-box row'];
  const it = row.items;
  const out = [];
  const atMin = (name) => !it[name] || it[name].width <= minOf(row, name) + 1;
  for (const name of ['wait', 'model', 'permission', 'effort']) {
    // 最窄（min-width）在这一行的直接子项上（.permission、.model-switch、.thinking-switch，chat.css、models.css），
    // 不在按钮上：字很短（"Off"、模型 id "o3"）时按钮比最窄窄、字是完整的，那一项仍占最窄。所以量这一项；
    // 按钮比最窄窄时字必须是完整的（截短的按钮要撑满这一项），同 m6-helpers.mjs effortProblems
    const item = row.kids.find((kid) => kid.kind === name)?.width ?? it[name]?.width;
    if (it[name] && item < minOf(row, name) - 0.5) out.push(`${name} ${item}px < its minimum`);
    if (it[name] && cutOf(it[name]) && it[name].width < minOf(row, name) - 0.5) {
      out.push(`${name} cut at ${it[name].width}px < its minimum`);
    }
    for (const part of [it[name]?.text, it[name]?.scope, it[name]?.tail]) {
      if (part?.truncated && !part.ellipsis) out.push(`${name} cut without an ellipsis`);
    }
  }
  if (squeezed('model', it.model) && !atMin('wait')) out.push('model range cut before the note reached its minimum');
  if (cutOf(it.permission) && !atMin('model')) out.push('mode name cut before the model range reached its minimum');
  if (cutOf(it.effort) && !(atMin('model') && atMin('permission'))) out.push('Effort cut before the other two');
  if (cutOf(it.permission) && row.pane > 400) out.push(`mode name cut at ${row.pane}px`);
  if (it.model?.scope?.truncated && it.model.tail && it.model.tail.width > 1) {
    out.push(`range name cut while the model id still has ${it.model.tail.width}px`);
  }
  const text = it.permission?.text;
  if (text && text.width < Math.min(text.full, text.twoChars) - 0.5) out.push('mode name shows fewer than 2 letters');
  return out;
}

/**
 * @brief 读屏名和悬停第一行是全文（截短时靠它们看全名，models.md"窄栏"）：权限"Permission mode: <模式>"、按钮里只有
 *        模式名一段字；Effort 读屏名等于按钮文字"Effort: <强度>"；选择范围"Model range: <按钮文字>"（" · "换成", "），按钮文字里没有描述元素；
 *        不能发送的说明悬停是全文。
 */
export function nameProblems(row) {
  if (!row) return ['no message-box row'];
  const { permission: perm, model, effort, wait } = row.items;
  const out = [];
  const full = perm && `Permission mode: ${perm.text?.text}`;
  if (perm && (perm.label !== full || lines(perm)[0] !== full)) out.push(`permission: ${perm.label} | ${perm.title}`);
  if (perm && !['Ask each time', 'Allow all'].includes(perm.text?.text)) out.push(`mode "${perm.text?.text}"`);
  if (perm && perm.content !== perm.text?.text) out.push(`permission button text "${perm.content}"`);
  if (effort && (effort.label !== effort.content || lines(effort)[0] !== effort.label)) {
    out.push(`Effort: ${effort.label} | ${effort.title} | ${effort.content}`);
  }
  const rangeName = model && `Model range: ${model.content?.replace(/ · /g, ', ')}`;
  if (model && model.label !== rangeName) out.push(`model range named ${model.label}`);
  if (model && lines(model)[0] !== model.content) out.push(`model range hover line 1 "${lines(model)[0]}"`);
  if (model && model.tip !== null && !model.tipOutside) out.push('model-tip is inside the button');
  if (wait && wait.title !== wait.text?.text) out.push(`note hover "${wait.title}" for "${wait.text?.text}"`);
  return out;
}

/**
 * @brief 权限或 Effort（悬停两行）：reason 为 null 时可用（没有 aria-disabled 属性），否则 aria-disabled="true"、
 *        不用 disabled，悬停第二行和读屏的描述都是 reason；描述里没有第一行和" · "；不在切换中。
 */
function reasonProblems(name, item, reason) {
  if (!item) return [];
  const out = [];
  if (item.ariaDisabled !== (reason === null ? null : 'true')) out.push(`${name} aria-disabled=${item.ariaDisabled}`);
  if (item.disabled) out.push(`${name} uses disabled (should be aria-disabled)`);
  if (item.pending) out.push(`${name} data-pending=${item.pending}`);
  if (lines(item).length !== 2) out.push(`${name} hover: ${JSON.stringify(item.title)}`);
  if (reason !== null && (item.desc !== reason || lines(item)[1] !== reason)) {
    out.push(`${name} reason: ${item.desc} | ${JSON.stringify(item.title)}`);
  }
  if (item.desc && (item.desc.includes(' · ') || item.desc === lines(item)[0])) {
    out.push(`${name} description ${item.desc}`);
  }
  return out;
}

/**
 * @brief 选择范围按钮（悬停三行，composer-pickers.md"v1 之后的调整"）：第二行"<提供商名>"（expected 给出时等于它，
 *        字串或正则；没有当前模型时"No model can run in this session"），不可用时第三行是 reason；读屏的描述是第二行
 *        （" · "换成", "）加不可用时的". <原因>"，由按钮外面的 model-tip 给出。
 */
function modelProblems(model, reason, expected) {
  if (!model) return [];
  const out = [];
  const tip = lines(model);
  if (model.ariaDisabled !== (reason === null ? null : 'true')) out.push(`model aria-disabled=${model.ariaDisabled}`);
  if (model.disabled) out.push('model range button uses disabled (should be aria-disabled)');
  if (model.pending) out.push(`model data-pending=${model.pending}`);
  const lineOk = expected instanceof RegExp ? expected.test(tip[1] ?? '') : expected ? tip[1] === expected
    : PROVIDER_LINE.test(tip[1] ?? '');
  if (model.current ? !lineOk : tip[1] !== NOTES.noCurrent) out.push(`model hover line 2 "${tip[1]}"`);
  if (tip.length !== (reason === null ? 2 : 3) || (reason !== null && tip[2] !== reason)) {
    out.push(`model hover ${JSON.stringify(model.title)}`);
  }
  const desc = `${tip[1] ?? ''}${reason ? `. ${reason}` : ''}`;
  if (model.desc !== desc) out.push(`model description "${model.desc}" ≠ "${desc}"`);
  if (!model.tipLinked || model.tip !== desc) out.push(`model-tip "${model.tip}" linked=${model.tipLinked}`);
  return out;
}

/** @brief 能用时悬停的第二行和读屏的描述（approval.md"权限菜单"、models.md"思考强度"）。 */
function hoverProblems(row, permReason, effortReason) {
  const { permission: perm, effort } = row.items;
  const out = [];
  const permNote = perm?.all ? NOTES.all : NOTES.ask;
  if (perm && permReason === null && (perm.desc !== permNote || lines(perm)[1] !== permNote)) {
    out.push(`permission hover: ${JSON.stringify(perm.title)} | ${perm.desc}`);
  }
  const effortNote = effort?.reasoning === 'false' ? NOTES.unsupported : NOTES.effort;
  if (effort && effortReason === null && (effort.desc !== effortNote || lines(effort)[1] !== effortNote)) {
    out.push(`Effort hover: ${JSON.stringify(effort.title)} | ${effort.desc}`);
  }
  return out;
}

/**
 * @brief 按状态查有哪几项、哪几项不可用和原因（chat.md"输入框下面一行"、"后台进程退出"，models.md、model-menu.md）。
 *        state：idle、preparing（准备中）、running（生成中）、blocked（拒绝启动）、crashed、restarting、
 *        reopening（Restart 之后重新打开中）、opening（第一次打开中）、failed（打开失败）。
 * @param options.ring 为假时不查圆环在不在（pi 返回空时没有圆环）
 * @param options.modelTip 选择范围按钮悬停的第二行（字串或正则）；不给时只比格式（不空、不带" · <区域>"）
 */
export function stateProblems(row, state, { ring = true, modelTip = null } = {}) {
  if (!row) return ['no message-box row'];
  const { permission: perm, model, effort, wait, stop, send } = row.items;
  const out = [];
  const reason = REASONS[state] ?? null;
  const busy = state === 'running' || state === 'preparing';
  if ((wait?.text?.text ?? null) !== reason) out.push(`note "${wait?.text?.text ?? ''}" in state ${state}`);
  const pickers = !['opening', 'failed'].includes(state);
  if (!perm) out.push('no permission button');
  if (Boolean(model) !== pickers) out.push(`model range button shown=${Boolean(model)} in state ${state}`);
  if (Boolean(effort) !== (pickers && Boolean(model?.current))) {
    out.push(`Effort shown=${Boolean(effort)} with current model ${model?.current ?? 'none'}`);
  }
  if (ring && Boolean(row.items.ring) !== pickers) out.push(`ring shown=${Boolean(row.items.ring)} in state ${state}`);
  if (busy && (!stop || send)) out.push(`state ${state}: Stop ${Boolean(stop)}, Send ${Boolean(send)}`);
  if (PLACEHOLDERS[state] && row.placeholder !== PLACEHOLDERS[state]) out.push(`placeholder "${row.placeholder}"`);
  if (state === 'blocked' && (!send?.disabled || !row.card)) {
    out.push(`blocked: Send disabled=${send?.disabled}, card ${Boolean(row.card)}`);
  }
  out.push(...reasonProblems('permission', perm, reason));
  out.push(...reasonProblems('effort', effort, busy ? BUSY.effort : reason));
  out.push(...modelProblems(model, busy ? BUSY.model : reason, modelTip));
  out.push(...hoverProblems(row, reason, busy ? BUSY.effort : reason));
  if (perm?.all && perm.contrast < 4.5) out.push(`“Allow all” text contrast ${perm.contrast}:1`);
  return out;
}

/**
 * @brief 切换中（models.md"选择范围按钮"切换中）：范围按钮和 Effort 都 aria-disabled、都带 data-pending="true"
 *        （共用一个切换中的值）；范围按钮悬停只有第一行（你选的范围的文字）、没有描述；焦点留在范围按钮上。
 * @param shown 你选的范围按钮上应显示的文字
 */
export function pendingProblems(row, shown) {
  if (!row) return ['no message-box row'];
  const { model, effort } = row.items;
  const out = [];
  for (const [name, item] of [['model', model], ['effort', effort]]) {
    if (item && (item.ariaDisabled !== 'true' || item.pending !== 'true' || item.disabled)) {
      out.push(`${name}: aria-disabled=${item.ariaDisabled} data-pending=${item.pending} disabled=${item.disabled}`);
    }
  }
  if (!model || model.content !== shown || model.title !== shown || model.desc !== null) {
    out.push(`model range while switching: "${model?.content}" | ${JSON.stringify(model?.title)} | ${model?.desc}`);
  }
  if (row.focus && row.focus !== 'model-button') out.push(`focus on ${row.focus}`);
  return out;
}

/** @brief 这一行的全部检查：版面、分档、截短、读屏名和悬停、状态。 */
export function rowProblems(row, state, options) {
  return [...layoutProblems(row), ...bandProblems(row), ...truncationProblems(row), ...nameProblems(row),
    ...stateProblems(row, state, options)];
}

/** @brief 这一行的简要说明（记录用）：面板宽、各项、截短的项。 */
export function rowSummary(row) {
  if (!row) return 'no row';
  const cut = Object.entries(row.items).filter(([, item]) => cutOf(item)).map(([name, item]) =>
    `${name} ${item.width}px`);
  const kids = row.kids.map((kid) => `${kid.kind} ${kid.width}`).join(', ');
  return `${row.pane}px [${kids}] cut: ${cut.join(', ') || '-'}`;
}

/** @brief 左右对齐：start 左对齐这一行；end 右对齐这一行；anchor 右边对齐按钮，伸出这一行左端时左边贴这一行左端。 */
function alignProblems({ pop, row, anchor }, align) {
  if (align === 'start' && !near(pop.left, row.left, 1)) return [`left ${pop.left} ≠ row ${row.left}`];
  if (align === 'end' && !near(pop.right, row.right, 1)) return [`right ${pop.right} ≠ row ${row.right}`];
  if (align !== 'anchor') return [];
  const left = Math.max(row.left, (anchor?.right ?? NaN) - pop.width);
  return near(pop.left, left, 1) ? []
    : [`left ${pop.left} ≠ max(row ${row.left}, button ${anchor?.right} − ${pop.width})`];
}

/**
 * @brief 往上打开的浮层（models.md"菜单的位置与键盘"）：下边在这一行上方 6px、不盖顶栏、整个在会话面板和窗口里、
 *        不伸出这一行；最高 min(440px, 这一行上边到顶栏下边 − 12px)；左右按 align；width 给出时宽 min(width, 这一行的宽)，
 *        maxWidth 给出时不宽于 min(maxWidth, 这一行的宽)。范围菜单各项：名字截短时有省略号和悬停全名。
 */
export function popoverProblems(box, { align, width = null, maxWidth = null } = {}) {
  if (!box) return ['not open'];
  const { pop, row, pane, topbar, view } = box;
  const out = [];
  if (!near(row.top - pop.bottom, 6, 1)) out.push(`bottom ${pop.bottom} is not 6px above the row (${row.top})`);
  if (pop.top < topbar.bottom - 0.5) out.push(`top ${pop.top} covers the top bar (${topbar.bottom})`);
  if (pop.left < pane.left - 0.5 || pop.right > pane.right + 0.5 || pop.top < pane.top - 0.5) {
    out.push('outside the pane');
  }
  if (pop.left < -0.5 || pop.right > view.width + 0.5 || pop.top < -0.5 || pop.bottom > view.height + 0.5) {
    out.push('outside the window');
  }
  if (pop.left < row.left - 0.5 || pop.right > row.right + 0.5) out.push('sticks out of the row');
  const tallest = Math.min(440, row.top - topbar.bottom - 12);
  if (pop.height > tallest + 0.5) out.push(`${pop.height}px tall (> ${tallest})`);
  if (width !== null && !near(pop.width, Math.min(width, row.width), 1)) out.push(`${pop.width}px wide`);
  if (maxWidth !== null && pop.width > Math.min(maxWidth, row.width) + 0.5) out.push(`${pop.width}px wide`);
  for (const item of box.items ?? []) {
    if (item.name?.truncated && (!item.name.ellipsis || !item.title)) out.push(`item "${item.name.text}" cut badly`);
  }
  return out.concat(alignProblems(box, align));
}

/** 这一行的浮层：打开它的按钮、浮层、左右对齐、宽（models.md"菜单的位置与键盘"）；details 为真时不抢焦点 */
const POPOVERS = {
  permission: { button: '[data-testid="permission-button"]', pop: '[data-testid="permission-menu"]', align: 'start' },
  model: { button: '[data-testid="model-button"]', pop: '[data-testid="model-menu"]', align: 'anchor', width: 300 },
  effort: { button: '[data-testid="thinking-button"]', pop: '[data-testid="thinking-menu"]', align: 'anchor' },
  queue: { button: '.split-toggle', pop: '.split-button [role="menu"]', align: 'anchor' },
  ring: { button: '[data-testid="usage"]', pop: '[data-testid="usage-details"]', align: 'end', width: 260,
    details: true },
};

/** @brief 焦点在 scope 那一栏的 css 元素上。 */
const focusOn = (page, scope, css) => page.evaluate((sel) => document.activeElement === document.querySelector(sel),
  `${scope} ${css}`);

/**
 * @brief 在 scope 那一栏里依次点开 names 列出的浮层（permission、model、effort、queue、ring），量位置和焦点（菜单打开时
 *        焦点在菜单里，圆环详情不抢焦点），按 Esc 关上、焦点回到按钮；返回问题列表（"<名字>: <问题>"）。
 */
export async function popoverChecks(page, scope, names) {
  const out = [];
  for (const name of names) {
    const spec = POPOVERS[name];
    await page.locator(`${scope} ${spec.button}`).click();
    await page.locator(`${scope} ${spec.pop}`).waitFor({ timeout: 3000 }).catch(() => {});
    const box = await popoverBox(page, scope, spec.pop, spec.button);
    out.push(...popoverProblems(box, spec).map((problem) => `${name}: ${problem}`));
    // 没打开时不按 Esc：没有浮层时 Esc 会停止生成
    if (!box) continue;
    if (!(spec.details ? box.focusOnAnchor : box.focusIn)) out.push(`${name}: focus ${spec.details ? 'left the ring'
      : 'not in the menu'} on open`);
    await page.keyboard.press('Escape');
    await page.locator(`${scope} ${spec.pop}`).waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
    if (!await focusOn(page, scope, spec.button)) out.push(`${name}: focus not back on the button after Esc`);
  }
  return out;
}

/** @brief 照 models.md"上下文用量（圆环）"的写法缩短一个数（测试自己算，用来核对界面）：k、M 一位小数去掉".0"。 */
export function shortCount(count) {
  const trim = (text) => text.replace(/\.0$/, '');
  if (count < 1000) return String(count);
  if (count < 999_950) return `${trim((count / 1000).toFixed(1))}k`;
  return `${trim((count / 1_000_000).toFixed(1))}M`;
}

/**
 * @brief 有用量的圆环（models.md"上下文用量（圆环）"）：读屏名"Usage: Context approximately <数> of <数> tokens (N%)"
 *        与 data-tokens / data-percent 一致、百分比四舍五入；悬停"Context ≈ <k> / <k> (N%)"、详情里是同一个 summary；
 *        不用 title；读屏的描述里没有"/"。悬停提示或详情没开时不查它们。
 */
export function ringTextProblems(ring) {
  if (!ring) return ['no ring'];
  if (ring.state !== 'used') return [`state ${ring.state}`];
  const match = /^Usage: Context approximately ([\d,]+) of ([\d,]+) tokens \((\d+)%\)$/.exec(ring.label ?? '');
  if (!match) return [`name "${ring.label}"`];
  const [tokens, window, percent] = match.slice(1).map((n) => Number(n.replace(/,/g, '')));
  const out = [];
  if (String(tokens) !== ring.tokens || String(percent) !== ring.percent) {
    out.push(`data-tokens ${ring.tokens} / data-percent ${ring.percent} vs name`);
  }
  if (Math.abs(percent - (tokens / window) * 100) > 0.51) out.push(`${percent}% for ${tokens} / ${window}`);
  const summary = `≈ ${shortCount(tokens)} / ${shortCount(window)} (${percent}%)`;
  if (ring.tip !== null && ring.tip !== `Context ${summary}`) out.push(`tip "${ring.tip}" ≠ "Context ${summary}"`);
  if (ring.details !== null && !(ring.details.includes('Context window') && ring.details.includes(summary))) {
    out.push(`details "${ring.details}"`);
  }
  if (ring.title) out.push(`has a title "${ring.title}"`);
  if (ring.desc?.includes('/')) out.push(`description "${ring.desc}"`);
  return out;
}

/** @brief 两个"r,g,b"颜色每个通道相差不超过 2。 */
export function sameColor(a, b) {
  if (!a || !b) return false;
  const [x, y] = [a, b].map((color) => color.split(',').map(Number));
  return x.every((value, i) => Math.abs(value - y[i]) <= 2);
}

/**
 * @brief 圆环的颜色（models.md、defaults.md"上下文用量圆环的样子"）：有填充时底圈 --color-line，填充 < 75% 强调色、
 *        75–89% --color-warn-text、≥ 90% 危险色，底圈实线；空圆环（还没有消息、刚压缩完）底圈 --color-faint、
 *        没有填充，刚压缩完时底圈是虚线。
 */
export function ringColorProblems(ring) {
  if (!ring) return ['no ring'];
  const colors = ring.colors;
  if (ring.state !== 'used') {
    return [!sameColor(ring.base, colors['--color-faint']) && `base ${ring.base} ≠ --color-faint`,
      ring.filled && `filled ${ring.fill}`, ring.dashed !== (ring.state === 'compacted') && `dashed=${ring.dashed}`]
      .filter(Boolean);
  }
  const percent = Number(ring.percent);
  const tone = percent >= 90 ? '--color-danger' : percent >= 75 ? '--color-warn-text' : '--color-accent';
  return [!sameColor(ring.base, colors['--color-line']) && `base ${ring.base} ≠ --color-line`,
    !sameColor(ring.fill, colors[tone]) && `fill ${ring.fill} ≠ ${tone} (${percent}%)`, ring.dashed && 'dashed']
    .filter(Boolean);
}

/** @brief 鼠标移到 scope 那一栏的圆环上，等悬停提示出现再量圆环（量完把鼠标移开）。 */
export async function hoverRing(page, scope = SINGLE) {
  await page.locator(`${scope} [data-testid="usage"]`).hover();
  await page.locator(`${scope} [data-testid="usage-tip"]`).waitFor({ timeout: 3000 }).catch(() => {});
  const ring = await ringState(page, scope);
  await page.mouse.move(1, 1);
  return ring;
}

/** @brief 点开 scope 那一栏的圆环详情再量圆环（不关上）。 */
export async function openRingDetails(page, scope = SINGLE) {
  await page.locator(`${scope} [data-testid="usage"]`).click();
  await page.locator(`${scope} [data-testid="usage-details"]`).waitFor({ timeout: 3000 }).catch(() => {});
  return ringState(page, scope);
}

/** @brief 焦点所在元素的名字：data-testid，没有时读屏名，再没有时看得见的字或标签名。 */
export const focusName = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el?.dataset?.testid ?? el?.getAttribute('aria-label') ?? (el?.innerText?.trim() || el?.tagName || null);
});

/**
 * @brief 焦点放到 from（选择器），按 Tab 直到 until(名字) 为真或按满 max 次，返回依次停到的元素的名字（focusName）。
 */
export async function tabPath(page, from, until, max = 10) {
  await page.locator(from).focus();
  const path = [];
  for (let presses = 0; presses < max; presses += 1) {
    await page.keyboard.press('Tab');
    const name = await focusName(page);
    path.push(name);
    if (until(name)) break;
  }
  return path;
}

/**
 * @brief 不挪焦点地把 scope 那一栏文字框的内容改成 text（照 React 认的写法：原生的 value setter 加 input 事件），
 *        用来看"清空草稿时焦点所在的按钮消失"（models.md"不可用时、按钮消失时的焦点"）。
 */
export function setDraftKeepingFocus(page, scope, text) {
  return page.evaluate(({ css, value }) => {
    const input = document.querySelector(`${css} .composer textarea`);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { css: scope, value: text });
}

// ---------- 把单栏的会话面板设成指定宽度 ----------

/** @brief 单栏时会话面板（.chat-pane）的宽。 */
const singleWidth = (page) => page.evaluate((css) => document.querySelector(`${css} [data-testid="chat-pane"]`)
  ?.getBoundingClientRect().width ?? 0, SINGLE);

/** @brief 改窗口内容区的宽，高不变。 */
async function contentWidth(app, page, width) {
  const height = await page.evaluate(() => innerHeight);
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
    { w: Math.round(width), h: height });
  await sleep(400);
}

/** @brief 单栏时打开或关上贴在右边的右栏（用这一栏顶栏的"Toggle changes"）。 */
async function dockRight(page, open) {
  const docked = await page.locator('[data-resize="workspace"]').count() > 0;
  if (docked === open) return;
  await page.locator(`${SINGLE} [data-testid="chat-pane"]`).getByRole('button', { name: 'Toggle changes' }).click();
  await sleep(250);
}

/**
 * @brief 把单栏的会话面板设成 width 宽（composer-pickers.md"宽度估算"的各档）：≥ 760px 时右栏的宽恢复默认（双击分隔线，
 *        免得拖过的宽度留给后面的检查）再关上、改窗口的宽；更窄时窗口 1600（≥ 560px）或 1200 宽、右栏打开，
 *        拖右栏的分隔线（左栏保持展开）。返回量到的宽。
 */
export async function setPaneWidth(page, app, width) {
  const wide = width >= 760;
  if (wide && await page.locator('[data-resize="workspace"]').count() > 0) {
    await page.locator('[data-resize="workspace"]').dblclick();
  }
  await dockRight(page, !wide);
  if (!wide) await contentWidth(app, page, width >= 560 ? 1600 : 1200);
  for (let tries = 0; tries < 6; tries += 1) {
    const now = await singleWidth(page);
    if (near(now, width)) return now;
    if (wide) await contentWidth(app, page, (await page.evaluate(() => innerWidth)) + width - now);
    else await drag(page, 'workspace', width - now);
    await sleep(150);
  }
  return singleWidth(page);
}

// ---------- M1 布局检查 ----------

/** @brief 一条分隔线的当前值。 */
function separatorValue(page, kind) {
  return page.locator(`[data-resize="${kind}"]`).getAttribute('aria-valuenow').then(Number);
}

/** @brief 拖动分隔线 dx 像素。 */
export async function drag(page, kind, dx) {
  const box = await page.locator(`[data-resize="${kind}"]`).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 5; step += 1) await page.mouse.move(x + (dx * step) / 5, y);
  await page.mouse.up();
}

/** @brief 左右分隔线：方向键 20px、拖动、双击恢复默认、刷新后保留。 */
async function dividerChecks(page, h, record) {
  const sidebar = page.locator('[data-resize="sidebar"]');
  const start = await separatorValue(page, 'sidebar');
  await sidebar.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const keyed = await separatorValue(page, 'sidebar');
  await drag(page, 'sidebar', -50);
  const dragged = await separatorValue(page, 'sidebar');
  await sidebar.dblclick();
  const reset = await separatorValue(page, 'sidebar');
  record('divider：左分隔线 → 每次 20px、拖动、双击恢复 260', keyed === start + 40 && dragged === keyed - 50 && reset === 260,
    `${start} → ${keyed} → ${dragged} → ${reset}`);
  await page.getByRole('button', { name: 'Toggle changes' }).click();
  const right = page.locator('[data-resize="workspace"]');
  const rightStart = await separatorValue(page, 'workspace');
  await right.focus();
  await page.keyboard.press('ArrowLeft');
  const rightKeyed = await separatorValue(page, 'workspace');
  await drag(page, 'workspace', -30);
  const rightDragged = await separatorValue(page, 'workspace');
  record('divider：右分隔线 ← 变宽 20px、向左拖变宽', rightKeyed === rightStart + 20 && rightDragged === rightKeyed + 30,
    `${rightStart} → ${rightKeyed} → ${rightDragged}`);
  await sidebar.focus();
  await page.keyboard.press('ArrowLeft');
  const saved = { sidebar: await separatorValue(page, 'sidebar'), workspace: rightDragged };
  await h.load('readme');
  await page.getByRole('button', { name: 'Toggle changes' }).click();
  const after = { sidebar: await separatorValue(page, 'sidebar'), workspace: await separatorValue(page, 'workspace') };
  record('divider：刷新页面后宽度还在', after.sidebar === saved.sidebar && after.workspace === saved.workspace,
    `${JSON.stringify(saved)} → ${JSON.stringify(after)}`);
  await page.locator('[data-resize="workspace"]').dblclick();
  record('divider：右分隔线双击恢复 450', await separatorValue(page, 'workspace') === 450);
}

/** @brief 此刻的三栏：窗口宽、左栏宽、中栏宽和显示方式、右栏宽、两条分隔线的值和上限、"Expand"按钮、草稿。 */
function columnFacts(page) {
  return page.evaluate(() => {
    const box = (css) => Math.round(document.querySelector(css)?.getBoundingClientRect().width ?? 0);
    const divider = (kind) => {
      const element = document.querySelector(`[data-resize="${kind}"]`);
      return element ? { now: Number(element.getAttribute('aria-valuenow')),
        max: Number(element.getAttribute('aria-valuemax')) } : null;
    };
    const center = document.querySelector('.center');
    return { width: innerWidth, page: document.documentElement.scrollWidth, sidebar: box('[data-testid="sidebar"]'),
      center: box('.center'), centerDisplay: center ? getComputedStyle(center).display : null,
      panel: box('[data-testid="right-panel"]'), workspace: divider('workspace'), sidebarDivider: divider('sidebar'),
      expanded: document.querySelector('.app')?.dataset.rightExpanded ?? null,
      button: document.querySelector('[data-testid="right-panel"] .panel-expand')?.getAttribute('aria-label') ?? null,
      draft: document.querySelector('.pane-slot:not([hidden]) .composer textarea')?.value ?? null };
  });
}

/**
 * @brief 2026-10-26 走查 M23（layout.md"分隔线"）：1600 宽时右栏没有 800px 上限，向左拖到中栏只剩 300px 为止；右栏存得
 *        这么宽之后窗口变窄到 1200：左栏的分隔线还在（按右栏实际能用的宽度给左栏留地方），右栏让出地方，中栏 300px，
 *        没有横向溢出。最后双击右栏分隔线恢复 450。
 */
async function panelWidthChecks(page, app, record) {
  await contentWidth(app, page, 1600);
  await drag(page, 'workspace', -900);
  const wide = await columnFacts(page);
  record('divider：右栏没有 800px 上限，向左拖到中栏只剩 300px 为止', wide.workspace?.now > 800
    && wide.workspace.now === wide.workspace.max && wide.center === 300
    && wide.workspace.now === wide.width - wide.sidebar - 300, JSON.stringify(wide));
  await contentWidth(app, page, 1200);
  const narrow = await columnFacts(page);
  record('divider：右栏存得很宽后窗口变窄到 1200：左栏的分隔线还在，右栏让出地方，中栏 300px，没有横向溢出',
    narrow.sidebarDivider !== null && narrow.center >= 300 && narrow.page <= narrow.width
    && narrow.workspace?.now === narrow.width - narrow.sidebar - 300, JSON.stringify(narrow));
  await page.locator('[data-resize="workspace"]').dblclick();
}

/**
 * @brief layout.md"右栏展开"：右栏顶部"Expand"：中栏藏起（会话面板保持挂载，草稿还在）、右栏占满左栏右边、右栏的分隔线
 *        不显示、按钮变"Collapse"；"Collapse"回到原来的宽度；再展开后"Close panel"关上右栏并取消展开，再打开时不是展开的。
 */
async function expandChecks(page, h, record) {
  await dockRight(page, true);
  await h.textarea.fill('展开前的草稿');
  const panel = page.getByTestId('right-panel');
  const before = await columnFacts(page);
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  const expanded = await columnFacts(page);
  await panel.getByRole('button', { name: 'Collapse', exact: true }).click();
  const collapsed = await columnFacts(page);
  record('expand：点"Expand"中栏藏起、右栏占满左栏右边、分隔线不显示、按钮变"Collapse"；"Collapse"回到原来的宽度，草稿还在',
    before.button === 'Expand' && expanded.expanded === 'true' && expanded.centerDisplay === 'none'
    && Math.abs(expanded.panel - (expanded.width - expanded.sidebar)) <= 1 && expanded.workspace === null
    && expanded.button === 'Collapse' && collapsed.expanded === null && collapsed.panel === before.panel
    && collapsed.workspace !== null && collapsed.draft === '展开前的草稿', JSON.stringify({ before, expanded, collapsed }));
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  await panel.getByRole('button', { name: 'Close panel' }).click();
  const closed = await columnFacts(page);
  await page.getByRole('button', { name: 'Toggle changes' }).click();
  const reopened = await columnFacts(page);
  record('expand：展开时点"Close panel"关上右栏、中栏回来；再打开右栏时不是展开的', closed.panel === 0
    && closed.expanded === null && closed.centerDisplay !== 'none' && reopened.panel === before.panel
    && reopened.expanded === null && reopened.button === 'Expand', JSON.stringify({ closed, reopened }));
  await h.textarea.fill('');
}

/**
 * @brief 800×600：左栏收起为图标栏，没有横向溢出，顶栏与输入框完整；输入框下面一行（权限、选择范围、Effort、圆环、
 *        发送）不换行、不溢出，按这时会话面板的宽度收紧（layout.md"最小窗口"）。
 */
async function narrowChecks(page, app, record, shots) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600));
  await sleep(500);
  const report = await page.evaluate(() => {
    const overflow = (selector) => [...document.querySelectorAll(selector)]
      .filter((element) => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.className);
    const outside = [...document.querySelectorAll('.app *')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.right > window.innerWidth + 1 && !element.closest('.conversation, .panel-body');
    }).map((element) => element.className || element.tagName);
    return { width: window.innerWidth, page: document.documentElement.scrollWidth,
      sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width,
      center: document.querySelector('.center')?.getBoundingClientRect().width,
      overflow: overflow('.topbar, .breadcrumb, .topbar-actions, .composer, .composer-bottom, .chat-pane, '
        + '.right-panel, [data-testid="usage"], .send-button, .stop-button, .split-button, .queue-button'),
      outside: outside.slice(0, 5) };
  });
  const row = await composerRow(page);
  await page.screenshot({ path: join(shots, 'narrow-800.png') });
  record('narrow：800 宽时左栏收起为 60px 图标栏', report.width === 800 && report.sidebar === 60, JSON.stringify(report));
  record('narrow：800 宽时没有内容被裁掉（无横向溢出，中栏至少 300px）', report.page <= 800 && report.overflow.length === 0
    && report.outside.length === 0 && report.center >= 300, JSON.stringify(report));
  const problems = rowProblems(row, 'idle', { modelTip: REPLAY_TIP });
  record('narrow：800 宽时输入框下面一行（权限、选择范围、Effort、圆环、发送）不换行、不溢出，按会话面板的宽度收紧',
    problems.length === 0, `${rowSummary(row)} ${problems.join('; ')}`);
  const small = await smallText(page);
  record('fonts：800 宽时没有小于 12px 的文字', small.length === 0, small.slice(0, 5).join('; '));
  await menuHeights(page, record);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 800));
  await sleep(300);
}

/** @brief 打开 name 那个菜单量一次（最高、位置），按 Esc 关上；返回 { box, problems }。 */
async function openAndMeasure(page, name) {
  const spec = POPOVERS[name];
  await page.locator(`${SINGLE} ${spec.button}`).click();
  await page.locator(`${SINGLE} ${spec.pop}`).waitFor({ timeout: 3000 }).catch(() => {});
  const box = await popoverBox(page, SINGLE, spec.pop, spec.button);
  if (box) await page.keyboard.press('Escape');
  return { box, problems: popoverProblems(box, spec).map((problem) => `${name}: ${problem}`) };
}

/**
 * @brief 800×600、右栏打开（会话面板约 300px）：草稿 1 行和草稿 220px 高时（文字框最高 220px）各打开一次权限、选择范围、
 *        Effort 菜单：都往上打开、不出窗口、不盖顶栏，两次的最高（max-height）和这一行的位置相同（models.md"菜单的位置
 *        与键盘"高度：这一行贴在面板底部，草稿变高时升高的是 .composer 的上边）。
 */
async function menuHeights(page, record) {
  await dockRight(page, true);
  const input = page.locator(`${SINGLE} .composer textarea`);
  const runs = [];
  for (const draft of ['一行草稿', Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行草稿`).join('\n')]) {
    await input.fill(draft);
    const inputHeight = await input.evaluate((element) => element.getBoundingClientRect().height);
    for (const name of ['permission', 'model', 'effort']) {
      runs.push({ name, inputHeight, ...await openAndMeasure(page, name) });
    }
  }
  await input.fill('');
  const problems = runs.flatMap((run) => run.problems);
  const differ = ['permission', 'model', 'effort'].filter((name) => {
    const [short, tall] = runs.filter((run) => run.name === name).map((run) => run.box);
    return !short || !tall || short.maxHeight !== tall.maxHeight || !near(short.row.top, tall.row.top);
  });
  // 文字框最高 220px（Composer.tsx MAX_INPUT_HEIGHT，按内容框还是边框算由样式决定，所以只比"长到了最高"）
  const tall = runs.at(-1)?.inputHeight ?? 0;
  record('narrow：800×600、右栏打开，草稿 1 行和 220px 高时权限、选择范围、Effort 菜单都往上打开、不出窗口、不盖顶栏，'
    + '两次的最高和这一行的位置相同', problems.length === 0 && differ.length === 0 && tall >= 215,
  `文字框 ${tall}px；${problems.join('; ')} 不同：${differ.join(', ')}`);
}

/** @brief 输入法组字时按 Enter 只选词，不发送；组字结束后 Enter 发送。 */
async function imeCheck(page, h, record) {
  await h.load('readme');
  const cdp = await page.context().newCDPSession(page);
  await h.textarea.focus();
  await cdp.send('Input.imeSetComposition', { text: 'zongjie', selectionStart: 7, selectionEnd: 7 });
  await page.keyboard.press('Enter');
  await sleep(300);
  const sentDuring = await page.evaluate(() => window.__replay.status.commands.filter((c) => c.type === 'session.prompt').length);
  await cdp.send('Input.insertText', { text: '总结' });
  const value = await h.textarea.inputValue();
  record('ime：拼音组字时按 Enter 不会发送', sentDuring === 0, `组字中按 Enter 后发出的消息 ${sentDuring} 条；输入框：${oneLine(value)}`);
  await h.textarea.fill('总结一下 README.md');
  await h.textarea.press('Enter');
  await page.getByTestId('user-message').first().waitFor({ timeout: 10000 });
  record('ime：不在组字时 Enter 发送', true);
  await h.idle();
}

/**
 * @brief 输入框下面一行的浮层打开时的字号：圆环的悬停提示和详情（models.md"上下文用量（圆环）"）、选择范围菜单、
 *        Effort 菜单（打开时才量得到）。
 */
async function rowFonts(page) {
  const ring = page.locator(`${SINGLE} [data-testid="usage"]`);
  await ring.hover();
  await page.getByTestId('usage-tip').waitFor({ timeout: 3000 }).catch(() => {});
  const small = await smallText(page);
  await page.mouse.move(1, 1);
  for (const [button, pop] of [[ring, 'usage-details'], [page.locator(`${SINGLE} [data-testid="model-button"]`),
    'model-menu'], [page.locator(`${SINGLE} [data-testid="thinking-button"]`), 'thinking-menu']]) {
    await button.click();
    await page.getByTestId(pop).waitFor({ timeout: 3000 }).catch(() => {});
    small.push(...await smallText(page));
    await page.keyboard.press('Escape');
  }
  return small;
}

/** @brief 布局检查入口。 */
export async function layoutChecks(page, h, { app, record, shots }) {
  await h.load('readme', { speed: 4 });
  await h.send('总结一下 README.md');
  await h.idle();
  await page.getByTestId('tool-card').first().locator('summary').click();
  await page.getByRole('button', { name: 'Toggle changes' }).click();
  let small = await smallText(page);
  const rowSmall = await rowFonts(page);
  // v1（docs/specs/model-providers.md §14.4）：设置页是 Models 分节，先量提供商卡（models.get 读完之后），再量 Edit 打开的
  // 提供商表单；回放里 models.get 由回放桥按录制的模型合成（harness/replay.js）。
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('provider-card').first().waitFor({ timeout: 10000 });
  small = small.concat(await smallText(page));
  await page.getByTestId('provider-card').first().locator('[data-action="edit-provider"]').click();
  await page.getByTestId('provider-form').waitFor({ timeout: 10000 });
  small = small.concat(await smallText(page));
  await page.getByTestId('provider-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Back to app' }).click();
  record('fonts：会话、工具卡展开、右栏、设置页（Models 的提供商卡和提供商表单）没有小于 12px 的文字', small.length === 0,
    small.slice(0, 5).join('; '));
  record('fonts：输入框下面一行、圆环的悬停提示和详情、选择范围和 Effort 菜单没有小于 12px 的文字', rowSmall.length === 0,
    rowSmall.slice(0, 5).join('; '));
  await page.getByRole('button', { name: 'Toggle changes' }).click();
  await dividerChecks(page, h, record);
  await panelWidthChecks(page, app, record);
  await expandChecks(page, h, record);
  await narrowChecks(page, app, record, shots);
  await imeCheck(page, h, record);
}
