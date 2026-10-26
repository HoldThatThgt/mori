// v1 模型层测试（v1-models-app-session.mjs、v1-models-replay.mjs）共用的页面读取：输入框下面一行（2026-10-21 起选择范围、
// Effort、权限按钮和上下文用量圆环都在这里，docs/v0/composer-pickers.md、docs/v0/screens/models.md）里各项此刻的样子、
// 截短与否、弹出层（范围菜单、换范围失败那一行）的位置，以及按会话面板宽度改窗口。只读页面（fitPane 改窗口大小），
// 不记录检查结果（检查结果由调用方记录）。标识见 models.md"界面测试用的标识"、docs/v1/screens/model-menu.md。
// 读按钮状态的共同规则（composer-pickers.md"测试要改的地方"C1、C2）："不可用"读 aria-disabled 为 true 且没有
// data-pending，"切换中"读 data-pending；悬停说明按 "\n" 分行比较；读屏的描述读 aria-describedby 指向的元素。

import { PANE, settle } from './m3-helpers.mjs';

/** 一栏的输入框下面一行 */
export const ROW = '[data-testid="composer"] .composer-bottom';

/** 悬停说明与读屏描述里的说明和原因（models.md"不可用时、按钮消失时的焦点"、ui-strings.md） */
export const NOTE = {
  modelBusy: 'Can’t switch models until the response finishes',
  effortBusy: 'Can’t change effort until the response finishes',
  effort: 'Set the effort level for this session',
  unsupported: 'This model isn’t marked “Supports thinking”',
  noModel: 'No model can run in this session',
  crashed: 'Mori’s background process crashed',
  restarting: 'Restarting…',
  starting: 'Starting…',
};

/** 截短的几项最窄多宽：[宽于 340px 时, ≤ 340px 时]（models.md"窄栏"的"放不下"） */
export const LEAST = { permission: [44, 40], model: [40, 36], thinking: [40, 36], wait: [48, 48] };

/** @brief 这一项在宽度 w 的一栏里最窄多宽。 */
export const least = (kind, w) => LEAST[kind][w <= 340 ? 1 : 0];

/**
 * @brief 范围按钮读屏的描述（composer-pickers.md"悬停和读屏的描述"）：悬停第二行，不可用时加". <原因>"。
 * @param line2 悬停第二行（"<提供商名>"或"No model can run in this session"；2026-10-26 起不带区域）
 */
export const rangeDescription = (line2, reason = null) => `${line2}${reason ? `. ${reason}` : ''}`;

/**
 * @brief 范围按钮的读屏名（models.md"选择范围按钮"）："Model range: <按钮文字>"，按钮文字里的" · "换成", "（读屏名里不用
 *        " · "，ui-strings.md）。
 */
export const rangeName = (text) => `Model range: ${text.replace(/ · /g, ', ')}`;

/** @brief 保留一位小数（记录里用）。 */
export const at1 = (value) => Math.round(value * 10) / 10;

/** @brief 是否截短：装字的元素比全文窄 0.01px 以上（不用 scrollWidth，截短时它可能与 clientWidth 相等）。 */
export const isCut = (fact) => Boolean(fact) && fact.width < fact.full - 0.01;

/**
 * @brief paneCss 那一栏的选择范围按钮（顶层字段）、Effort（thinking）和权限按钮（permission）此刻的样子：按钮文字
 *        （textContent）、读屏名称、悬停说明按行（tip）、读屏的描述（described）、aria-disabled 的原值、不可用（unavailable，
 *        C1）、切换中（pending）、是否真的 disabled、在不在这一行里、在不在顶栏里、宽度、看得见的 ▾ 个数。范围按钮另有
 *        data-pick、data-current，以及描述元素是不是这一栏 .model-switch 里、按钮外面的 model-tip（tipOutside）；
 *        Effort 另有 data-level、data-reasoning。没有范围按钮时为 null。
 */
export function pickers(page, paneCss = PANE) {
  return page.evaluate(({ selector, rowCss }) => {
    const pane = document.querySelector(selector);
    const row = pane?.querySelector(rowCss) ?? null;
    const ids = (el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const info = (el) => el && { text: el.textContent.trim(), name: el.getAttribute('aria-label'),
      tip: el.title ? el.title.split('\n') : [],
      described: ids(el).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim(),
      ariaDisabled: el.getAttribute('aria-disabled'), pending: el.dataset.pending === 'true',
      unavailable: el.getAttribute('aria-disabled') === 'true' && el.dataset.pending !== 'true',
      disabled: el.disabled, inRow: Boolean(row?.contains(el)), inTopbar: Boolean(el.closest('.topbar')),
      width: el.getBoundingClientRect().width, arrows: [...el.querySelectorAll('svg')].filter(shown).length };
    const range = pane?.querySelector('[data-testid="model-button"]');
    if (!range) return null;
    const tip = pane.querySelector('[data-testid="model-tip"]');
    const thinking = pane.querySelector('[data-testid="thinking-button"]');
    return { ...info(range), pick: range.dataset.pick ?? null, current: range.dataset.current ?? null,
      tipOutside: Boolean(tip) && !range.contains(tip) && Boolean(range.closest('.model-switch')?.contains(tip))
        && ids(range).includes(tip.id),
      thinking: thinking && { ...info(thinking), level: thinking.dataset.level ?? null,
        reasoning: thinking.dataset.reasoning ?? null },
      permission: info(pane.querySelector('[data-testid="permission-button"]')) };
  }, { selector: paneCss, rowCss: ROW });
}

/**
 * @brief paneCss 那一栏输入框下面一行的框架（models.md"位置""窄栏"）：会话面板、这一行、输入框的位置，是否横向溢出，
 *        看得见、占位置的直接子项从左到右的种类（permission / model / thinking / usage / wait / queue（"Queue ▾"）/
 *        queue-one（准备中只有一个按钮的"Queue"）/ stop / send；藏起来的描述元素和绝对定位的弹出层不算），
 *        几个不收的按钮的宽度（sizes），顶栏里还有没有这几个按钮（inTopbar，不该有），以及装字的元素是否截短（texts：
 *        此刻的宽、全文的宽（同样式下 width: max-content 的藏起来的副本，量完就删）、是不是 text-overflow: ellipsis）。
 *        这一栏没有这一行时为 null。
 */
export function rowFacts(page, paneCss = PANE) {
  return page.evaluate(({ selector, rowCss }) => {
    const pane = document.querySelector(selector);
    const row = pane?.querySelector(rowCss);
    if (!row) return null;
    const kinds = [['permission', '[data-testid="permission-button"]'], ['model', '[data-testid="model-button"]'],
      ['thinking', '[data-testid="thinking-button"]'], ['usage', '[data-testid="usage"]'],
      ['wait', '[data-testid="not-ready"]'], ['queue', '.split-button'], ['queue-one', '.queue-button'],
      ['stop', '.stop-button'], ['send', '.send-button']];
    const kindOf = (el) => kinds.find(([, css]) => el.matches(css) || el.querySelector(css))?.[0]
      ?? (el.className || el.tagName);
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const laid = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      && !['absolute', 'fixed'].includes(getComputedStyle(el).position) && el.getBoundingClientRect().width > 1;
    const measure = (el) => {
      const copy = el.cloneNode(true);
      copy.removeAttribute('id');
      Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', width: 'max-content', maxWidth: 'none',
        minWidth: '0', flex: 'none', margin: '0' });
      el.parentElement.append(copy);
      const width = copy.getBoundingClientRect().width;
      copy.remove();
      return width;
    };
    const q = (css) => row.querySelector(css);
    const fact = (el) => (el && el.getClientRects().length > 0 ? { width: el.getBoundingClientRect().width,
      full: measure(el), ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' } : null);
    const size = (el) => (el && laid(el) ? el.getBoundingClientRect().width : null);
    const bar = pane.querySelector('.topbar');
    return { pane: rect(pane), row: rect(row), composer: rect(pane.querySelector('[data-testid="composer"]')),
      overflow: row.scrollWidth > row.clientWidth + 1,
      items: [...row.children].filter(laid).map((el) => ({ kind: kindOf(el), ...rect(el) })),
      sizes: { usage: size(q('[data-testid="usage"]')), stop: size(q('.stop-button')), send: size(q('.send-button')),
        toggle: size(q('.split-toggle')), queueOne: size(q('.queue-button')),
        queueMain: size(q('.split-button > .button:not(.split-toggle)')) },
      inTopbar: ['model-button', 'thinking-button', 'permission-button', 'usage']
        .filter((id) => bar?.querySelector(`[data-testid="${id}"]`)),
      texts: { permission: fact(q('[data-testid="permission-button"] .permission-text')),
        scope: fact(q('[data-testid="model-button"] .range-scope')),
        model: fact(q('[data-testid="model-button"] .range-model')),
        effort: fact(q('[data-testid="thinking-button"] .switch-text')), wait: fact(q('[data-testid="not-ready"]')) } };
  }, { selector: paneCss, rowCss: ROW });
}

/** @brief 这一行从左到右的种类，逗号连起来（rowFacts 的 items）。 */
export const kindsOf = (facts) => (facts?.items ?? []).map((item) => item.kind).join();

/**
 * @brief 这一行的框架不符合 models.md"位置""窄栏"的地方（空数组为符合）：高 33px（不能发送时也是）、不横向溢出、
 *        各项都在这一行里且不换行、这一行在输入框里、顶栏里没有这几个按钮。
 */
export function frameProblems(facts) {
  if (!facts) return ['no message-box row'];
  const { row, composer, items } = facts;
  const problems = [];
  if (Math.abs(row.height - 33) > 1) problems.push(`row ${at1(row.height)}px high`);
  if (facts.overflow || items.some((item) => item.left < row.left - 0.5 || item.right > row.right + 0.5)) {
    problems.push('items outside the row');
  }
  if (items.some((item) => item.top < row.top - 0.5 || item.bottom > row.bottom + 0.5)) problems.push('wrapped');
  if (row.left < composer.left - 0.5 || row.right > composer.right + 0.5) problems.push('row outside the message box');
  if (facts.inTopbar.length) problems.push(`top bar still has ${facts.inTopbar.join()}`);
  return problems;
}

/**
 * @brief paneCss 那一栏里 popupCss 那个弹出层（范围菜单、换范围失败那一行）和它的参照物的位置：弹出层、会话面板、这一栏的
 *        输入框下面一行、顶栏、打开它的按钮（同一个外层里 aria-expanded 为真的按钮，没有时是外层的第一个按钮）各一组
 *        left/right/top/bottom/width/height，窗口大小；inRow 为弹出层在这一栏这一行的 DOM 里。弹出层不在时为 null。
 */
export function popupBox(page, popupCss, paneCss = PANE) {
  return page.evaluate(({ css, selector, rowCss }) => {
    const pane = document.querySelector(selector);
    const box = pane?.querySelector(css);
    if (!box) return null;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const row = pane.querySelector(rowCss);
    const wrapper = box.closest('.model-switch, .thinking-switch, .permission, .split-button');
    const opener = wrapper?.querySelector('[aria-expanded="true"]') ?? wrapper?.querySelector('button') ?? null;
    return { inRow: Boolean(row?.contains(box)), box: rect(box), pane: rect(pane), row: rect(row),
      topbar: rect(pane.querySelector('.topbar')), opener: rect(opener),
      window: { width: innerWidth, height: innerHeight } };
  }, { css: popupCss, selector: paneCss, rowCss: ROW });
}

/**
 * @brief 弹出层的位置不符合 models.md"菜单的位置与键盘"的地方（空数组为符合）：在这一栏这一行的 DOM 里；往上打开（下边在
 *        这一行上方 6px）；上下左右都在这一栏里、不盖到顶栏、在窗口里；最高 min(440, 这一行上边到顶栏下边 − 12)；
 *        不伸出这一行；右边对齐打开它的按钮，放不下时左边贴这一行左端；width 给了时宽度是它（差 1px 以内），
 *        maxWidth 给了时不宽于它。
 */
export function placeProblems(geo, { width = null, maxWidth = null } = {}) {
  if (!geo?.row || !geo.pane) return [`not inside a message-box row: ${JSON.stringify(geo)}`];
  const { box, row, pane, opener, window: view } = geo;
  const ceiling = geo.topbar?.bottom ?? pane.top;
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  const problems = geo.inRow ? [] : ['not in this pane\'s message-box row'];
  if (!near(box.bottom, row.top - 6)) problems.push(`bottom ${at1(box.bottom)} not 6px above the row ${at1(row.top)}`);
  if (box.left < pane.left - 1 || box.right > pane.right + 1 || box.bottom > pane.bottom + 1) {
    problems.push('off the pane');
  }
  if (box.top < ceiling - 0.5) problems.push(`top ${at1(box.top)} over the top bar (${at1(ceiling)})`);
  if (box.top < -0.5 || box.left < -0.5 || box.right > view.width + 0.5 || box.bottom > view.height + 0.5) {
    problems.push('off the window');
  }
  const limit = Math.min(440, row.top - ceiling - 12);
  if (box.height > limit + 1) problems.push(`height ${at1(box.height)} above ${at1(limit)}`);
  if (box.left < row.left - 1 || box.right > row.right + 1) problems.push('wider than the row');
  const shifted = near(box.left, row.left) && (opener?.right ?? Infinity) - box.width < row.left + 1.5;
  if (!(near(box.right, opener?.right ?? NaN) || shifted)) problems.push('not right-aligned with its button');
  if (width !== null && Math.abs(box.width - width) > 1) problems.push(`width ${at1(box.width)} not ${at1(width)}`);
  if (maxWidth !== null && box.width > maxWidth + 1) problems.push(`width ${at1(box.width)} above ${at1(maxWidth)}`);
  return problems;
}

/**
 * @brief 开着的范围菜单在 paneCss 那一栏里的位置问题（placeProblems：宽 min(300px, 这一行的宽)）。
 * @return problems（placeProblems 的结果）与 geo（popupBox 的结果）；菜单不在时为 null
 */
export async function rangeMenuPlace(page, paneCss = PANE) {
  await settle(page);
  const geo = await popupBox(page, '[data-testid="model-menu"]', paneCss);
  if (!geo) return null;
  return { problems: placeProblems(geo, { width: Math.min(300, geo.row?.width ?? 300) }), geo };
}

/** @brief 记录里放的简短位置：弹出层与这一行、打开它的按钮的边。 */
export const placeBrief = (geo) => (geo ? JSON.stringify({
  box: [at1(geo.box.left), at1(geo.box.top), at1(geo.box.right), at1(geo.box.bottom)],
  row: [at1(geo.row?.left), at1(geo.row?.top), at1(geo.row?.right)], opener: at1(geo.opener?.right),
  topbar: at1(geo.topbar?.bottom), inRow: geo.inRow }) : 'none');

/**
 * @brief paneCss 那一栏开着的范围菜单里每一项：范围、名字（.switch-text）此刻的宽和全文的宽、是不是 text-overflow:
 *        ellipsis，悬停说明（title）。菜单不在时为 null。
 */
export function menuItemFacts(page, paneCss = PANE) {
  return page.evaluate((selector) => {
    const menu = document.querySelector(`${selector} [data-testid="model-menu"]`);
    if (!menu) return null;
    const measure = (el) => {
      const copy = el.cloneNode(true);
      Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', width: 'max-content', maxWidth: 'none',
        minWidth: '0', flex: 'none', margin: '0' });
      el.parentElement.append(copy);
      const width = copy.getBoundingClientRect().width;
      copy.remove();
      return width;
    };
    const fact = (el) => (el ? { text: el.textContent, width: el.getBoundingClientRect().width, full: measure(el),
      ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' } : null);
    return [...menu.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ pick: item.dataset.pick,
      title: item.getAttribute('title'), label: fact(item.querySelector('.switch-text')) }));
  }, paneCss);
}

/**
 * @brief 焦点所在元素的种类：这一栏的文字框为 textarea；有 data-testid 的用它（permission-button、model-button 等）；
 *        发送组的按钮为 send / stop / more（▾）/ queue-one；菜单项为 item:<data-pick 或 data-level>；其余为读屏名称或标签名。
 */
export function focusKind(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    if (el.matches('.composer textarea')) return 'textarea';
    if (el.dataset.testid) return el.dataset.testid;
    const kinds = [['.send-button', 'send'], ['.stop-button', 'stop'], ['.split-toggle', 'more'],
      ['.queue-button', 'queue-one']];
    const kind = kinds.find(([css]) => el.matches(css))?.[1];
    if (kind) return kind;
    if (/^menuitem/.test(el.getAttribute('role') ?? '')) return `item:${el.dataset.pick ?? el.dataset.level ?? ''}`;
    return el.getAttribute('aria-label') || el.tagName.toLowerCase();
  });
}

/**
 * @brief 用 MutationObserver 记下此后每次界面变化时 paneCss 那一栏的范围按钮、Effort 和圆环的样子（与上一个相同时不记），
 *        抓只持续一瞬间的状态（切换中、"Restarting…"、"Starting…"）。每个快照：r / e / u 为范围按钮、Effort、圆环在不在；
 *        rp / ep 切换中（data-pending）；ra / ea 有 aria-disabled="true"；rt / et 悬停说明按行；rd / ed 读屏的描述。
 *        seenPickers 取回并停止。
 */
export function watchPickers(page, paneCss = PANE) {
  return page.evaluate(({ selector }) => {
    const describe = (el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const part = (el) => (el ? { p: el.dataset.pending === 'true', a: el.getAttribute('aria-disabled') === 'true',
      t: el.title ? el.title.split('\n') : [], d: describe(el) } : null);
    const take = () => {
      const pane = document.querySelector(selector);
      const range = part(pane?.querySelector('[data-testid="model-button"]'));
      const effort = part(pane?.querySelector('[data-testid="thinking-button"]'));
      const now = { r: Boolean(range), rp: range?.p ?? false, ra: range?.a ?? false, rt: range?.t ?? [],
        rd: range?.d ?? '', e: Boolean(effort), ep: effort?.p ?? false, ea: effort?.a ?? false, et: effort?.t ?? [],
        ed: effort?.d ?? '',
        u: Boolean(pane?.querySelector('[data-testid="usage"]')) };
      const text = JSON.stringify(now);
      if (window.__pickerSeen.at(-1)?.text !== text) window.__pickerSeen.push({ text, now });
    };
    window.__pickerSeen = [];
    window.__pickerObserver?.disconnect();
    window.__pickerObserver = new MutationObserver(take);
    window.__pickerObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
    take();
  }, { selector: paneCss });
}

/** @brief 停下 watchPickers，返回记下的快照（按时间顺序）。 */
export const seenPickers = (page) => page.evaluate(() => {
  window.__pickerObserver?.disconnect();
  return (window.__pickerSeen ?? []).map((item) => item.now);
});

/** @brief paneCss 那一栏 .chat-pane 的宽度（不取整）。 */
export const paneWidth = (page, paneCss = PANE) => page.evaluate((selector) => document.querySelector(selector)
  ?.getBoundingClientRect().width ?? 0, paneCss);

/**
 * @brief paneCss 那一栏顶栏的右栏开关切到 open（按下状态不同时才点；分屏时点它也把焦点换到这一栏），等右栏出现或消失。
 */
export async function setRightPanel(page, open, paneCss = PANE) {
  const toggle = page.locator(`${paneCss} .topbar`).getByRole('button', { name: 'Toggle changes', exact: true });
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
  await page.waitForFunction((want) => {
    const panel = document.querySelector('[data-testid="right-panel"]');
    return (Boolean(panel) && panel.getBoundingClientRect().width > 0) === want;
  }, open, { timeout: 5000 }).catch(() => {});
  await settle(page);
}

/**
 * @brief 单栏：按需要开右栏（target 窄于 740px 时开：窗口最窄 800px，右栏关时会话面板至少约 740px），再按量到的差改窗口
 *        宽度，让会话面板（.chat-pane）正好 target 宽（最多试 6 次；窗口最窄 800px，到不了时停在最接近的）。
 * @return 最后量到的宽度
 */
export async function fitPane(app, page, target, height = 800) {
  await setRightPanel(page, target < 740);
  for (let tries = 0; tries < 6; tries += 1) {
    const now = await paneWidth(page);
    const current = await page.evaluate(() => innerWidth);
    const next = Math.max(800, Math.round(current + target - now));
    if (Math.abs(now - target) < 0.5 || next === current) break;
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
      { w: next, h: height });
    await page.waitForFunction((w) => innerWidth === w, next, { timeout: 5000 }).catch(() => {});
    await settle(page);
    await settle(page);
  }
  return paneWidth(page);
}

/** @brief 回到测试默认的样子：1200×800 的窗口、右栏关。 */
export async function resetWindow(app, page) {
  await setRightPanel(page, false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 800));
  await page.waitForFunction(() => innerWidth === 1200, null, { timeout: 5000 }).catch(() => {});
  await settle(page);
}
