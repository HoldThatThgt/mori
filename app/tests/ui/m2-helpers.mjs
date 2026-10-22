// M2 测试（m2-app.mjs、m2-replay.mjs、m2-real.mjs）共用的页面读取：输入框下面一行的权限按钮和其余几项（选择范围、Effort、
// 上下文用量圆环、不能发送时的说明）、往上打开的权限菜单的位置、文字和底色的对比度、F8 报告"Current view"里新加的三项。
// 2026-10-21 起权限、选择范围（v1）、Effort 和上下文用量从顶栏移到输入框下面一行（docs/v0/composer-pickers.md、
// screens/approval.md、models.md、chat.md、f8.md）。按钮状态的读法照 composer-pickers.md"测试要改的地方"C1 / C2：
// "不可用"读 aria-disabled（且没有 data-pending），"切换中"读 data-pending，悬停说明按行比，读屏的描述读 aria-describedby。
// 只读页面，不记录检查结果（检查结果由调用方记录）。

/** 输入框下面一行（每一栏 [data-testid="composer"] 里的 .composer-bottom，models.md"界面测试用的标识"） */
export const ROW = '[data-testid="composer"] .composer-bottom';
/** 权限菜单 */
export const PERMISSION_MENU = '[data-testid="permission-menu"]';
/** 准备中、生成中范围按钮悬停的第三行（规格 §9.2，models.md"不可用时、按钮消失时的焦点"） */
export const MODEL_BUSY = 'Can’t switch models until the response finishes';
/** 准备中、生成中 Effort 悬停的第二行 */
export const EFFORT_BUSY = 'Can’t change effort until the response finishes';
/** 原来权限按钮上的盾牌图标的路径（icons.tsx 的 shield）：任何宽度都不能再出现 */
const SHIELD_PATH = 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6';
/** 从顶栏移走的四项：顶栏里不能再有它们 */
const MOVED = ['permission-button', 'model-button', 'thinking-button', 'usage'];
/** 两种权限的模式名和悬停说明的第二行（approval.md"权限菜单"、ui-strings.md"权限按钮"） */
const MODE_TEXT = { ask: ['Ask each time', 'Change the permission mode'],
  all: ['Allow all', 'Edits, writes, and commands will run without asking.'] };
/** Effort 能用时悬停的第二行（支持思考、不支持思考） */
const EFFORT_HINTS = ['Set the effort level for this session', 'This model isn’t marked “Supports thinking”'];
/** 会话面板宽于它时权限按钮带 ▾（models.md"窄栏"：≤ 460px 去掉 ▾） */
const CARET_ABOVE = 460;
/** 这一行的高度（px，chat.md"输入框下面一行"：约 33px，不能发送时也不变矮） */
export const ROW_HEIGHT = 33;
/** 菜单的下边在这一行上方 6px（models.md"菜单的位置与键盘"） */
const MENU_GAP = 6;

/** @brief 两个值的 JSON 相同（顺序也算）。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 留下不成立的检查的说明。 */
const failed = (checks) => checks.filter(([ok]) => !ok).map(([, problem]) => problem);

/** @brief 在页面里装上算颜色的小工具（window.__m2Probe.contrast / resolve），用 1×1 的 canvas 叠底色。 */
function colorProbes() {
  const probe = window.__m2Probe ?? {};
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (color) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  const opaque = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    return paint(color)[3] === 255;
  };
  const linear = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  // 文字和它实际的底色（自己和祖先的背景色由外向内叠到第一个不透明的为止）的对比度，WCAG 的算法
  probe.contrast = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      layers.unshift(color);
      if (opaque(color)) break;
    }
    ctx.clearRect(0, 0, 1, 1);
    let back = paint('#ffffff');
    for (const color of layers) back = paint(color);
    const [light, dark] = [luminance(paint(getComputedStyle(el).color)), luminance(back)].sort((a, b) => b - a);
    return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
  };
  // 一个 CSS 颜色值（例如 var(--color-warn-text)）算出来的颜色，与 getComputedStyle 的写法相同
  probe.resolve = (value) => {
    const el = document.createElement('span');
    el.style.color = value;
    document.body.append(el);
    const color = getComputedStyle(el).color;
    el.remove();
    return color;
  };
  window.__m2Probe = probe;
}

/**
 * @brief 在页面里装上读元素的小工具（window.__m2Probe）：可见、读屏的描述、是否截短、这一行几个按钮的状态。
 * @param row 输入框下面一行的选择器（ROW）
 */
function elementProbes(row) {
  const probe = window.__m2Probe ?? {};
  probe.visible = (el) => Boolean(el) && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0
    && getComputedStyle(el).visibility !== 'hidden';
  probe.describe = (el) => (el?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  // 截短：装字那个元素比全文窄 0.01px 以上（全文的宽用同字体、max-content 的藏起来的副本量；不用 scrollWidth）
  probe.truncated = (el) => {
    const style = getComputedStyle(el);
    const copy = document.createElement('span');
    copy.textContent = el.textContent;
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
      'fontFeatureSettings', 'fontKerning', 'letterSpacing', 'wordSpacing', 'textTransform']) {
      copy.style[name] = style[name];
    }
    Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', width: 'max-content' });
    document.body.append(copy);
    const full = copy.getBoundingClientRect().width;
    copy.remove();
    return el.getBoundingClientRect().width < full - 0.01;
  };
  // 按钮：文字、aria-disabled、data-pending、原生 disabled、能否 Tab 到、读屏名、悬停说明的各行、读屏的描述；没有按钮时为 null
  probe.control = (el) => el && { text: el.textContent.trim(), off: el.getAttribute('aria-disabled') === 'true',
    pending: el.dataset.pending === 'true', disabled: el.disabled === true,
    tabbable: el.disabled !== true && el.tabIndex >= 0, label: el.getAttribute('aria-label'),
    lines: (el.getAttribute('title') ?? '').split('\n'), description: probe.describe(el) };
  probe.controls = (pane) => {
    const bar = pane?.querySelector(row);
    const find = (id) => bar?.querySelector(`[data-testid="${id}"]`) ?? null;
    return { permission: probe.control(find('permission-button')), model: probe.control(find('model-button')),
      effort: probe.control(find('thinking-button')), usage: Boolean(find('usage')),
      wait: bar?.querySelector('[data-testid="not-ready"]')?.textContent ?? null,
      rowHeight: bar ? Math.round(bar.getBoundingClientRect().height * 10) / 10 : 0 };
  };
  window.__m2Probe = probe;
}

/** @brief 装上 window.__m2Probe（每次读之前装一次；界面重新载入后也有）。 */
export async function ensureProbes(page) {
  await page.evaluate(colorProbes);
  await page.evaluate(elementProbes, ROW);
}

/**
 * @brief 输入框下面一行的权限、范围、Effort 按钮的状态（见 elementProbes 的 control）、有没有圆环、不能发送时的说明、
 *        这一行的高度。
 * @param pane 会话面板的选择器
 */
export async function rowControls(page, pane) {
  await ensureProbes(page);
  return page.evaluate((selector) => window.__m2Probe.controls(document.querySelector(selector)), pane);
}

/**
 * @brief 权限按钮的悬停和读屏与 mode（ask / all）、reason（不可用的原因；能用时为 null）的规定不符的地方：
 *        文字只有模式名，读屏名"Permission mode: <模式>"，悬停两行（第一行全名，第二行说明或原因），
 *        读屏的描述只有第二行（没有第一行、没有" · "），不可用时 aria-disabled 且仍能 Tab 到（approval.md"权限菜单"）。
 */
export function permissionTipProblems(control, mode, reason) {
  if (!control) return ['no permission button in the message box row'];
  const [name, hint] = MODE_TEXT[mode];
  const second = reason ?? hint;
  return failed([
    [control.text === name, `text "${control.text}"`],
    [control.label === `Permission mode: ${name}`, `name "${control.label}"`],
    [same(control.lines, [`Permission mode: ${name}`, second]), `title ${JSON.stringify(control.lines)}`],
    [control.description === second && !control.description.includes(' · '),
      `description "${control.description}" (want "${second}")`],
    [reason ? control.off && control.tabbable : !control.off,
      `aria-disabled ${control.off}, tabbable ${control.tabbable} (reason ${reason})`],
  ]);
}

/**
 * @brief 选择范围按钮的悬停和读屏与 reason（不可用的原因；能用时为 null）的规定不符的地方（composer-pickers.md
 *        "v1 之后的调整"的悬停表）：悬停第一行是按钮文字，读屏名"Model range: <按钮文字>"；第二行"<提供商名> · <区域>"或
 *        "No model can run in this session"；不可用时第三行是原因；读屏的描述是第二行（" · "换成", "）加". <原因>"；
 *        不可用时 aria-disabled、没有 data-pending、仍能 Tab 到。
 */
export function rangeTipProblems(control, reason) {
  if (!control) return ['no model range button in the message box row'];
  const { lines } = control;
  const zone = (lines[1] ?? '').replace(/ · /g, ', ');
  const want = reason ? `${zone}. ${reason}` : zone;
  return failed([
    [lines[0] === control.text && control.label === `Model range: ${control.text}`,
      `title line 1 "${lines[0]}", text "${control.text}", name "${control.label}"`],
    [Boolean(lines[1]), `title line 2 "${lines[1] ?? ''}"`],
    [reason ? lines.length === 3 && lines[2] === reason : lines.length === 2, `title ${JSON.stringify(lines)}`],
    [control.description === want, `description "${control.description}" (want "${want}")`],
    [reason ? control.off && !control.pending && control.tabbable : !control.off,
      `aria-disabled ${control.off}, data-pending ${control.pending}, tabbable ${control.tabbable}`],
  ]);
}

/**
 * @brief Effort 按钮的悬停和读屏与 reason（不可用的原因；能用时为 null）的规定不符的地方（models.md"思考强度"）：
 *        文字和读屏名都是"Effort: <强度>"，悬停两行（第一行同读屏名，第二行说明或原因），读屏的描述只有第二行
 *        （没有第一行、没有" · "）；不可用时 aria-disabled、没有 data-pending、仍能 Tab 到。
 */
export function effortTipProblems(control, reason) {
  if (!control) return ['no Effort button in the message box row'];
  const { lines } = control;
  return failed([
    [/^Effort: \S/.test(control.label ?? '') && control.text === control.label && lines[0] === control.label,
      `text "${control.text}", name "${control.label}", title line 1 "${lines[0]}"`],
    [lines.length === 2 && (reason ? lines[1] === reason : EFFORT_HINTS.includes(lines[1])),
      `title ${JSON.stringify(lines)}`],
    [control.description === lines[1] && !control.description.includes(' · '),
      `description "${control.description}"`],
    [reason ? control.off && !control.pending && control.tabbable : !control.off,
      `aria-disabled ${control.off}, data-pending ${control.pending}, tabbable ${control.tabbable}`],
  ]);
}

/**
 * @brief 权限按钮此刻的样子：在不在这一行的左端、顶栏里还有没有移走的几项、文字、图标、悬停和读屏、颜色和对比度。
 *        没有这个按钮时为 null。
 * @param pane 会话面板的选择器
 */
export async function permissionState(page, pane) {
  await ensureProbes(page);
  return page.evaluate(({ selector, row, moved, shield }) => {
    const probe = window.__m2Probe;
    const root = document.querySelector(selector);
    const bar = root?.querySelector(row);
    const button = bar?.querySelector('[data-testid="permission-button"]');
    if (!button) return null;
    const text = button.querySelector('.permission-text');
    const svgs = [...button.querySelectorAll('svg')].filter(probe.visible);
    const style = getComputedStyle(button);
    const round = (value) => Math.round(value * 10) / 10;
    // 在左端：外层 .permission 是这一行的直接子项，这一行别的看得见的项都在它右边
    const wrapper = button.closest('.permission');
    const left = wrapper?.getBoundingClientRect().left ?? Infinity;
    const first = wrapper?.parentElement === bar && [...bar.children].filter((child) => child !== wrapper
      && probe.visible(child) && child.getBoundingClientRect().width > 1)
      .every((child) => child.getBoundingClientRect().left >= left);
    return { ...probe.control(button), modeText: text?.textContent ?? null,
      popup: button.getAttribute('aria-haspopup'), first,
      inTopbar: moved.filter((id) => root.querySelector(`.topbar [data-testid="${id}"]`)), svgs: svgs.length,
      shield: [...button.querySelectorAll('path')].some((path) => path.getAttribute('d') === shield),
      caretAfterText: Boolean(text) && svgs.every((svg) => svg.getBoundingClientRect().left
        >= text.getBoundingClientRect().right - 1),
      textWidth: round(text?.getBoundingClientRect().width ?? 0), width: round(button.getBoundingClientRect().width),
      truncated: Boolean(text) && probe.truncated(text), contrast: text ? probe.contrast(text) : 0,
      warnText: Boolean(text) && getComputedStyle(text).color === probe.resolve('var(--color-warn-text)'),
      look: `${style.color}|${style.backgroundColor}|${style.borderColor}`,
      pane: round(root.getBoundingClientRect().width) };
  }, { selector: pane, row: ROW, moved: MOVED, shield: SHIELD_PATH });
}

/**
 * @brief 权限按钮（能用时）与 mode（ask / all）的规定不符的地方：只有模式名和 ▾（会话面板 ≤ 460px 没有 ▾，任何宽度都
 *        没有盾牌）、模式名看得见、悬停和读屏（permissionTipProblems）；"Allow all"的字用 --color-warn-text、
 *        对比度 ≥ 4.5:1（approval.md"权限菜单"、composer-pickers.md"我自己定的"第 19 条）。
 */
export function modeProblems(state, mode) {
  if (!state) return ['no permission button in the message box row'];
  const [name] = MODE_TEXT[mode];
  const caret = state.pane > CARET_ABOVE ? 1 : 0;
  return [
    ...failed([
      [state.modeText === name && state.textWidth > 0, `.permission-text "${state.modeText}", ${state.textWidth}px`],
      [!state.shield && state.svgs === caret && state.caretAfterText, `icons: ${state.svgs} visible svg (want `
        + `${caret} at a ${state.pane}px pane), shield ${state.shield}, caret after text ${state.caretAfterText}`],
      [mode !== 'all' || (state.warnText && state.contrast >= 4.5),
        `text color is --color-warn-text: ${state.warnText}, contrast ${state.contrast}:1`],
    ]),
    ...permissionTipProblems(state, mode, null),
  ];
}

/**
 * @brief 打开着的菜单和这一行、会话面板、顶栏的位置，菜单的最高（px），以及菜单或它里面有没有一层在滚动。
 *        没有菜单或这一行时为 null。
 * @param pane 会话面板的选择器；menu 菜单的选择器
 */
export function rowMenuState(page, pane, menu) {
  return page.evaluate(({ selector, row, menuSelector }) => {
    const root = document.querySelector(selector);
    const el = document.querySelector(menuSelector);
    const bar = root?.querySelector(row);
    if (!root || !el || !bar) return null;
    const round = (value) => Math.round(value * 10) / 10;
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: round(rect.left), right: round(rect.right), top: round(rect.top), bottom: round(rect.bottom),
        width: round(rect.width), height: round(rect.height) };
    };
    const scrolls = [el, ...el.querySelectorAll('*')].some((node) => node.scrollHeight > node.clientHeight + 1
      && /auto|scroll/.test(getComputedStyle(node).overflowY));
    return { menu: box(el), row: box(bar), pane: box(root), bar: box(root.querySelector('.topbar')).bottom,
      window: [innerWidth, innerHeight], maxHeight: parseFloat(getComputedStyle(el).maxHeight), scrolls,
      items: el.querySelectorAll('[data-testid="permission-allowed"] li').length };
  }, { selector: pane, row: ROW, menuSelector: menu });
}

/**
 * @brief 权限菜单的位置与规定不符的地方（models.md"菜单的位置与键盘"、approval.md）：往上打开（下边在这一行上方 6px），
 *        左边对齐这一行的左端，整个在会话面板和窗口里、不盖顶栏，最高 min(440px, 这一行上边到顶栏下边 − 12px)。
 */
export function permissionMenuProblems(state) {
  if (!state) return ['menu or message box row not found'];
  const { menu, row, pane, bar, window: [width, height] } = state;
  const limit = Math.min(440, row.top - bar - 12);
  return failed([
    [Math.abs(row.top - MENU_GAP - menu.bottom) <= 1.5,
      `not opening upward 6px above the row: menu bottom ${menu.bottom}, row top ${row.top}`],
    [Math.abs(menu.left - row.left) <= 1, `menu left ${menu.left}, row left ${row.left}`],
    [menu.top >= bar - 0.5, `covers the top bar: menu top ${menu.top}, top bar bottom ${bar}`],
    [menu.left >= pane.left - 0.5 && menu.right <= pane.right + 0.5 && menu.top >= pane.top - 0.5
      && menu.bottom <= pane.bottom + 0.5, `outside the pane ${JSON.stringify(pane)}`],
    [menu.left >= -0.5 && menu.top >= -0.5 && menu.right <= width + 0.5 && menu.bottom <= height + 0.5,
      `outside the window ${width}×${height}`],
    [Math.abs(state.maxHeight - limit) <= 1 && menu.height <= limit + 1,
      `max-height ${state.maxHeight}px (want ${limit}px), height ${menu.height}px`],
  ]);
}

/**
 * @brief 权限菜单开着时（synthetic）在"Allowed for this session:"列表末尾加 count 行（与真的行同样的结构：名字和
 *        "Forget"，标 data-synthetic），量菜单的位置和滚动（rowMenuState），再把这些行删掉。合成端点只有几个工具，
 *        真的会话凑不出 30 个工具名；这只用来看列表很长时菜单的最高和滚动（models.md"高度"）。
 */
export async function allowedOverflow(page, pane, count) {
  await page.evaluate((n) => {
    const list = document.querySelector('[data-testid="permission-allowed"]');
    for (let index = 1; index <= n; index += 1) {
      const item = document.createElement('li');
      item.dataset.synthetic = 'true';
      const name = document.createElement('span');
      name.textContent = `Tool ${index}`;
      const forget = document.createElement('button');
      forget.className = 'text-link';
      forget.textContent = 'Forget';
      item.append(name, forget);
      list?.append(item);
    }
  }, count);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const state = await rowMenuState(page, pane, PERMISSION_MENU);
  await page.evaluate(() => document.querySelectorAll('[data-synthetic="true"]').forEach((el) => el.remove()));
  return state;
}

/**
 * @brief 用 MutationObserver 记下输入框下面一行每次变化后的样子（window.__m2Row）：权限、范围、Effort 按钮
 *        （elementProbes 的 control）、有没有圆环、按钮位置的说明、这一行的高度、权限菜单和圆环详情开没开、
 *        焦点所在元素的 data-testid。变化才记。
 * @param pane 会话面板的选择器
 */
export async function watchRow(page, pane) {
  await ensureProbes(page);
  await page.evaluate((selector) => {
    window.__m2Row = [];
    let last = '';
    const note = () => {
      const root = document.querySelector(selector);
      const entry = { ...window.__m2Probe.controls(root),
        menu: Boolean(document.querySelector('[data-testid="permission-menu"]')),
        details: Boolean(root?.querySelector('[data-testid="usage-details"]')),
        focus: document.activeElement?.dataset?.testid ?? null };
      const key = JSON.stringify(entry);
      if (key !== last) {
        last = key;
        window.__m2Row.push(entry);
      }
    };
    window.__m2RowObserver?.disconnect();
    window.__m2RowObserver = new MutationObserver(note);
    window.__m2RowObserver.observe(document.body,
      { subtree: true, childList: true, characterData: true, attributes: true });
    note();
  }, pane);
}

/** @brief 停止 watchRow，返回记下的样子。 */
export function rowLog(page) {
  return page.evaluate(() => {
    window.__m2RowObserver?.disconnect();
    return window.__m2Row ?? [];
  });
}

/**
 * @brief 按 F8 之前记下的事实：焦点所在那一栏 .chat-pane 的宽度（px，不取整）、这一栏 Effort 按钮的强度（读屏名
 *        "Effort: <强度>"里的强度；没有 Effort 按钮时为 null）、范围按钮的 data-pick 和 data-current（没有时 null）、
 *        权限按钮的模式名。
 * @param pane 会话面板的选择器
 */
export function paneFacts(page, pane) {
  return page.evaluate(({ selector, row }) => {
    const root = document.querySelector(selector);
    const bar = root?.querySelector(row);
    const effort = bar?.querySelector('[data-testid="thinking-button"]')?.getAttribute('aria-label') ?? null;
    const model = bar?.querySelector('[data-testid="model-button"]');
    return { width: root?.getBoundingClientRect().width ?? 0, effort: effort?.replace(/^Effort: /, '') ?? null,
      pick: model?.dataset.pick ?? null, current: model?.dataset.current ?? null,
      mode: bar?.querySelector('[data-testid="permission-button"]')?.textContent?.trim() ?? null };
  }, { selector: pane, row: ROW });
}

/** @brief Markdown 报告"Current view"一节的各行（"- <字段>: <值>"）拆成 { label, value }，保持顺序。 */
export function viewFields(text) {
  return text.split(/\r?\n/).map((line) => /^- ([^:]+): (.*)$/.exec(line.trim())).filter(Boolean)
    .map(([, label, value]) => ({ label, value }));
}

/**
 * @brief F8 报告"Current view"与规定不符的地方（f8.md"保存的内容"、ui-strings.md"F8 报告"、composer-pickers.md
 *        "我自己定的"第 16 条）："Model""Permission mode"照旧（与输入框下面一行一致），多了"Model range"（tab.pick，
 *        同范围按钮的 data-pick）、"Effort"（同 Effort 按钮；没有当前模型时 None）和"Pane width"（焦点所在那一栏
 *        .chat-pane 的宽度，"<N>px"，差 1px 以内）；顺序是 … Session file、Model range、Model、Effort、Running …
 *        Window size、Pane width、Sidebar width …
 * @param fields [{ label, value }]（viewFields 的结果，或回放桥收到的 report.view）；facts 是 paneFacts 的结果
 */
export function f8ViewProblems(fields, facts) {
  const value = (label) => fields.find((field) => field.label === label)?.value;
  const labels = fields.map((field) => field.label);
  const next = (a, b) => labels.includes(a) && labels.indexOf(b) === labels.indexOf(a) + 1;
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value('Pane width') ?? '')?.[1];
  return failed([
    [px !== undefined && Math.abs(Number(px) - facts.width) <= 1,
      `Pane width "${value('Pane width')}", pane ${facts.width}px`],
    [value('Effort') === (facts.effort ?? 'None'), `Effort "${value('Effort')}", button ${facts.effort}`],
    [value('Model range') === (facts.pick ?? 'None'), `Model range "${value('Model range')}", data-pick ${facts.pick}`],
    [value('Model') === (facts.current ?? 'None'), `Model "${value('Model')}", data-current ${facts.current}`],
    [value('Permission mode') === facts.mode, `Permission mode "${value('Permission mode')}", button ${facts.mode}`],
    [next('Session file', 'Model range') && next('Model range', 'Model') && next('Model', 'Effort')
      && next('Effort', 'Running') && next('Window size', 'Pane width') && next('Pane width', 'Sidebar width'),
    `order ${labels.join(', ')}`],
  ]);
}
