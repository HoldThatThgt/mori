/** 当前拖动和通知回调只存在于本次页面，不写入浏览器存储。 */
const resizeState = { onChange: null, drag: null, frame: null };
const resizeFields = { sidebar: 'sidebarWidth', workspace: 'workspaceWidth', chats: 'splitRatio' };
const resizeVariables = { sidebar: '--sidebar-width', workspace: '--workspace-width', chats: '--chat-split' };

/**
 * 监听侧栏及会话分隔线，通知应用保存尺寸而不重绘拖动中的画面。
 * @param {{onChange: Function}} options 接收像素宽度或零到一会话比例的局部状态更新。
 * @returns {Function} 解除监听并结束拖动的方法。
 */
export function initResize({ onChange }) {
  resizeState.onChange = onChange;
  document.addEventListener('pointerdown', beginDrag);
  document.addEventListener('pointermove', moveDrag);
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
  document.addEventListener('lostpointercapture', finishDrag);
  document.addEventListener('keydown', resizeByKeyboard);
  document.addEventListener('dblclick', resetSize);
  window.addEventListener('resize', scheduleLayout);
  window.addEventListener('blur', finishDrag);
  const observer = new MutationObserver(scheduleLayout);
  observer.observe(document.querySelector('#app'), { childList: true });
  scheduleLayout();
  return () => {
    finishDrag();
    observer.disconnect();
    cancelAnimationFrame(resizeState.frame);
    document.removeEventListener('pointerdown', beginDrag);
    document.removeEventListener('pointermove', moveDrag);
    document.removeEventListener('pointerup', finishDrag);
    document.removeEventListener('pointercancel', finishDrag);
    document.removeEventListener('lostpointercapture', finishDrag);
    document.removeEventListener('keydown', resizeByKeyboard);
    document.removeEventListener('dblclick', resetSize);
    window.removeEventListener('resize', scheduleLayout);
    window.removeEventListener('blur', finishDrag);
  };
}

/**
 * 读取当前参与布局的宽度，浮动面板不挤占会话。
 * @param {HTMLElement} app 当前应用根元素。
 * @returns {Object} 供当前手势计算使用的几何信息。
 */
function measureLayout(app) {
  const sidebar = app.querySelector('.sidebar');
  const workspace = app.querySelector('.right-panel, .feature-detail');
  const chats = app.querySelector('.chat-group');
  return {
    app,
    width: app.getBoundingClientRect().width,
    sidebar,
    sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
    sidebarOverlay: sidebar && getComputedStyle(sidebar).position === 'absolute',
    collapsed: sidebar?.classList.contains('collapsed'),
    workspace,
    workspaceWidth: workspace?.getBoundingClientRect().width ?? 0,
    workspaceOverlay: workspace && getComputedStyle(workspace).position === 'absolute',
    chats,
    chatWidth: chats?.getBoundingClientRect().width ?? 0,
    split: chats?.classList.contains('is-split'),
    splitRatio: parseFloat(getComputedStyle(app).getPropertyValue('--chat-split')) / 100,
    centerMinimum: chats?.classList.contains('is-split') ? 560 : 300,
  };
}

/**
 * 在当前可用空间内计算一个分隔线允许的范围。
 * @param {string} kind 分隔线类型。
 * @param {Object} layout 当前几何信息。
 * @returns {Object|null} 上下限，空间不足或不可调整时返回空。
 */
function sizeLimits(kind, layout) {
  if (kind === 'chats') {
    if (!layout.split || layout.chatWidth < 560) return null;
    return { min: 280 / layout.chatWidth, max: 1 - 280 / layout.chatWidth };
  }
  if (kind === 'sidebar') {
    if (!layout.sidebar || layout.collapsed) return null;
    const workspace = layout.workspaceOverlay ? 0 : layout.workspaceWidth;
    const room = layout.sidebarOverlay ? layout.width - 16 : layout.width - workspace - layout.centerMinimum;
    const max = Math.floor(Math.min(360, room));
    return max >= 180 ? { min: 180, max } : null;
  }
  if (kind === 'workspace') {
    if (!layout.workspace) return null;
    const sidebar = layout.sidebarOverlay ? 60 : layout.sidebarWidth;
    const room = layout.width - sidebar - (layout.workspaceOverlay ? 0 : layout.centerMinimum);
    const max = Math.floor(Math.min(800, room));
    return max >= 260 ? { min: 260, max } : null;
  }
  return null;
}

/**
 * 把目标值限制在当前空间允许的范围内。
 * @param {number} value 目标值。
 * @param {{min: number, max: number}} limits 当前限制。
 * @returns {number} 限制后的值。
 */
function clampSize(value, limits) {
  return Math.max(limits.min, Math.min(value, limits.max));
}

/**
 * 获取当前事件对应的应用和分隔线。
 * @param {Event} event 用户事件。
 * @returns {Object|null} 分隔线与应用根元素。
 */
function eventHandle(event) {
  const handle = event.target.closest('[data-resize]');
  const app = handle?.closest('.app');
  return app ? { handle, app, kind: handle.dataset.resize } : null;
}

/**
 * 捕获按下的指针，后续拖动只更新 CSS 变量。
 * @param {PointerEvent} event 指针按下事件。
 * @returns {void}
 */
function beginDrag(event) {
  if (event.button !== 0 || !event.isPrimary) return;
  const target = eventHandle(event);
  if (!target) return;
  const layout = measureLayout(target.app);
  if (!sizeLimits(target.kind, layout)) return;
  event.preventDefault();
  finishDrag();
  resizeState.drag = { ...target, pointerId: event.pointerId, startX: event.clientX,
    startValue: layout[resizeFields[target.kind]], chatWidth: layout.chatWidth };
  target.app.classList.add('is-resizing');
  target.handle.setAttribute('data-resizing', '');
  target.handle.focus({ preventScroll: true });
  window.getSelection()?.removeAllRanges();
  try {
    target.handle.setPointerCapture(event.pointerId);
  } catch (error) {
    console.error('Failed to capture resize pointer.', error);
    finishDrag();
  }
}

/**
 * 根据实际边界方向调整宽度或左右会话比例。
 * @param {PointerEvent} event 指针移动事件。
 * @returns {void}
 */
function moveDrag(event) {
  const drag = resizeState.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.app.isConnected) { finishDrag(); return; }
  const limits = sizeLimits(drag.kind, measureLayout(drag.app));
  if (!limits) { finishDrag(); return; }
  event.preventDefault();
  const delta = event.clientX - drag.startX;
  const change = drag.kind === 'chats' ? delta / drag.chatWidth : delta * (drag.kind === 'workspace' ? -1 : 1);
  applySize(drag.kind, clampSize(drag.startValue + change, limits), drag.app);
}

/**
 * 松开、取消、失去捕获或窗口焦点时都清理拖动状态。
 * @param {Event} event 可选的结束事件。
 * @returns {void}
 */
function finishDrag(event) {
  const drag = resizeState.drag;
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
  resizeState.drag = null;
  drag.app.classList.remove('is-resizing');
  drag.handle.removeAttribute('data-resizing');
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}

/**
 * 键盘左右箭头每次将可见分隔线移动二十像素。
 * @param {KeyboardEvent} event 分隔线键盘事件。
 * @returns {void}
 */
function resizeByKeyboard(event) {
  if (event.key === 'Escape' && resizeState.drag) { finishDrag(); return; }
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const target = eventHandle(event);
  if (!target) return;
  const layout = measureLayout(target.app);
  const limits = sizeLimits(target.kind, layout);
  if (!limits) return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const pixels = direction * 20;
  const delta = target.kind === 'chats' ? pixels / layout.chatWidth
    : pixels * (target.kind === 'workspace' ? -1 : 1);
  applySize(target.kind, clampSize(layout[resizeFields[target.kind]] + delta, limits), target.app);
}

/**
 * 双击恢复当前视口的默认宽度或均分比例。
 * @param {MouseEvent} event 分隔线双击事件。
 * @returns {void}
 */
function resetSize(event) {
  const target = eventHandle(event);
  if (!target) return;
  const layout = measureLayout(target.app);
  const limits = sizeLimits(target.kind, layout);
  if (!limits) return;
  event.preventDefault();
  const narrow = window.innerWidth <= 1150;
  const defaults = { sidebar: narrow ? 220 : 260, workspace: narrow ? 400 : 450, chats: 0.5 };
  applySize(target.kind, clampSize(defaults[target.kind], limits), target.app);
}

/**
 * 写入尺寸并通知应用保存局部状态；不替换 DOM。
 * @param {string} kind 分隔线类型。
 * @param {number} value 已限制的宽度或比例。
 * @param {HTMLElement} app 当前应用根元素。
 * @returns {void}
 */
function applySize(kind, value, app) {
  const size = kind === 'chats' ? value : Math.round(value);
  const cssValue = kind === 'chats' ? `${size * 100}%` : `${size}px`;
  app.style.setProperty(resizeVariables[kind], cssValue);
  const patch = { [resizeFields[kind]]: size };
  const layout = measureLayout(app);
  const limits = sizeLimits('chats', layout);
  if (kind !== 'chats' && limits) {
    const ratio = clampSize(layout.splitRatio, limits);
    if (ratio !== layout.splitRatio) {
      app.style.setProperty('--chat-split', `${ratio * 100}%`);
      patch.splitRatio = ratio;
    }
  }
  updateSeparators(measureLayout(app));
  resizeState.onChange(patch);
}

/**
 * 用实际可用范围更新分隔线的无障碍数值。
 * @param {Object} layout 当前几何信息。
 * @returns {void}
 */
function updateSeparators(layout) {
  layout.app.querySelectorAll('[data-resize]').forEach(handle => {
    const kind = handle.dataset.resize;
    const limits = sizeLimits(kind, layout);
    handle.setAttribute('aria-disabled', String(!limits || limits.max === limits.min));
    if (!limits) return;
    const scale = kind === 'chats' ? 100 : 1;
    const value = Math.round(layout[resizeFields[kind]] * scale);
    handle.setAttribute('aria-valuemin', String(Math.round(limits.min * scale)));
    handle.setAttribute('aria-valuemax', String(Math.round(limits.max * scale)));
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', kind === 'chats' ? `左侧会话 ${value}%` : `${value} 像素`);
  });
}

/**
 * 合并窗口变化与应用重绘后的布局校验。
 * @returns {void}
 */
function scheduleLayout() {
  cancelAnimationFrame(resizeState.frame);
  resizeState.frame = requestAnimationFrame(normalizeLayout);
}

/**
 * 优先为中间会话保留空间，再校验各分隔线范围。
 * @returns {void}
 */
function normalizeLayout() {
  const app = document.querySelector('.app');
  if (!app) return;
  if (resizeState.drag && resizeState.drag.app !== app) finishDrag();
  let layout = measureLayout(app);
  if (layout.workspace && !layout.workspaceOverlay && !layout.sidebarOverlay && !layout.collapsed) {
    const maximum = Math.min(360, Math.floor(layout.width - layout.centerMinimum - 260));
    if (maximum >= 180 && layout.sidebarWidth > maximum) applySize('sidebar', maximum, app);
  }
  for (const kind of ['sidebar', 'workspace', 'chats']) {
    layout = measureLayout(app);
    const limits = sizeLimits(kind, layout);
    if (!limits) continue;
    const current = layout[resizeFields[kind]];
    const value = clampSize(current, limits);
    if (Math.abs(current - value) > 0.0001) applySize(kind, value, app);
  }
  updateSeparators(measureLayout(app));
}
