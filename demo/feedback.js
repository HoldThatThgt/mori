/** 反馈保留用户期望及原始引用，分类和影响范围留给模型结合上下文判断。 */
const feedbackState = {
  toolbar: null,
  form: null,
  selection: null,
  context: null,
  returnFocus: null,
  onSubmit: null,
  onAsk: null,
};

/**
 * 转义将要放入 HTML 的文字。
 * @param {string} text 原始文字。
 * @returns {string} 适合 HTML 文字及属性位置的转义结果。
 */
export function escapeHtml(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (character) => entities[character]);
}

/**
 * 建立浮层并监听真实文字选区；返回解除监听的方法。
 * @param {{onSubmit: Function, onAsk: Function}} options 负责保存反馈和引用选区的应用回调。
 * @returns {Function} 移除浮层和事件监听的方法。
 */
export function initFeedback({ onSubmit, onAsk }) {
  const layer = document.querySelector('#feedback-layer');
  if (!layer) {
    console.error('Feedback layer is missing.');
    throw new Error('Feedback layer is missing.');
  }
  feedbackState.onSubmit = onSubmit;
  feedbackState.onAsk = onAsk;
  const style = document.createElement('style');
  style.textContent = feedbackStyles;
  const toolbar = createToolbar();
  const form = createForm();
  feedbackState.toolbar = toolbar;
  feedbackState.form = form;
  document.head.append(style);
  layer.append(toolbar, form);
  document.addEventListener('mouseup', inspectSelection);
  document.addEventListener('keyup', inspectSelection);
  document.addEventListener('keydown', handleEscape);
  document.addEventListener('pointerdown', dismissOutside);
  window.addEventListener('resize', repositionFeedback);
  document.addEventListener('scroll', repositionFeedback, true);
  return () => {
    document.removeEventListener('mouseup', inspectSelection);
    document.removeEventListener('keyup', inspectSelection);
    document.removeEventListener('keydown', handleEscape);
    document.removeEventListener('pointerdown', dismissOutside);
    window.removeEventListener('resize', repositionFeedback);
    document.removeEventListener('scroll', repositionFeedback, true);
    toolbar.remove();
    form.remove();
    style.remove();
    feedbackState.context = null;
    feedbackState.selection = null;
  };
}

/**
 * 针对一个完整产物或任务对象打开反馈表单。
 * @param {Object} context 引用文字、对象标识、版本及会话。
 * @returns {void}
 */
export function openFeedback({ quote, source, version, session }) {
  const trigger = document.activeElement;
  const anchor = trigger instanceof HTMLElement ? trigger.getBoundingClientRect() : null;
  feedbackState.returnFocus = trigger;
  openForm({
    quote, source, version,
    session,
    originalText: quote,
    rangeStart: null,
    rangeEnd: null,
    rangeClone: null,
    anchor,
  });
}

/**
 * 创建保留原生选区的统一反馈入口。
 * @returns {HTMLDivElement} 选区反馈工具栏。
 */
function createToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'feedback-selection-toolbar';
  toolbar.hidden = true;
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '选区操作');
  toolbar.innerHTML = '<button type="button" data-feedback-open>反馈</button>';
  toolbar.addEventListener('mousedown', (event) => event.preventDefault());
  toolbar.addEventListener('click', (event) => {
    if (event.target.closest('[data-feedback-open]')) openForm({ ...feedbackState.selection });
    if (event.target.closest('[data-selection-ask]')) askAboutSelection();
  });
  return toolbar;
}

/**
 * 创建由选区入口或产物按钮打开的反馈表单。
 * @returns {HTMLFormElement} 反馈表单。
 */
function createForm() {
  const form = document.createElement('form');
  form.className = 'feedback-popover';
  form.hidden = true;
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'false');
  form.setAttribute('aria-labelledby', 'feedback-title');
  form.addEventListener('submit', submitFeedback);
  form.addEventListener('input', (event) => {
    if (event.target instanceof HTMLTextAreaElement) event.target.setCustomValidity('');
  });
  form.addEventListener('click', (event) => {
    if (event.target.closest('[data-feedback-cancel]')) closeFeedback({ restoreFocus: true });
  });
  return form;
}

/**
 * 在选择操作结束后读取浏览器选区，浮层操作不触发重读。
 * @param {Event} event 鼠标或键盘事件。
 * @returns {void}
 */
function inspectSelection(event) {
  if (event.key === 'Escape' || isInFeedback(event.target) || !feedbackState.form.hidden) return;
  queueMicrotask(() => {
    if (!feedbackState.form.hidden) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
      feedbackState.toolbar.hidden = true;
      return;
    }
    const context = readSelection(selection.getRangeAt(0));
    if (!context) {
      feedbackState.toolbar.hidden = true;
      return;
    }
    feedbackState.selection = context;
    feedbackState.toolbar.innerHTML = '<button type="button" data-selection-ask>问 Mori</button>'
      + '<button type="button" data-feedback-open>反馈</button>';
    feedbackState.returnFocus = document.activeElement;
    feedbackState.toolbar.hidden = false;
    positionOverlay(feedbackState.toolbar, context.anchor, true);
  });
}

/**
 * 将同一消息或文件内的文字范围转成可追溯的引用记录。
 * @param {Range} range 浏览器真实选区。
 * @returns {Object|null} 带内容版本、原文和位置的引用，跨对象选区返回空。
 */
function readSelection(range) {
  const start = findSource(range.startContainer);
  const end = findSource(range.endContainer);
  if (!start || !end) return null;
  const conversation = start.closest('.conversation');
  const message = start === end ? start : conversation;
  if (!message || !message.contains(end)) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const before = range.cloneRange();
  before.selectNodeContents(message);
  before.setEnd(range.startContainer, range.startOffset);
  const rangeStart = before.toString().length;
  return {
    quote,
    source: message.dataset.fileId ? `file-${message.dataset.fileId}` : message.dataset.messageId || message.id,
    version: message.dataset.version ?? conversation.dataset.version,
    session: message.dataset.fileId ? message.dataset.session : conversation.dataset.session,
    fileId: message.dataset.fileId,
    filePath: message.dataset.filePath,
    startLine: before.toString().split('\n').length,
    endLine: message.textContent.slice(0, rangeStart + quote.length - 1).split('\n').length,
    originalText: message.textContent,
    rangeStart,
    rangeEnd: rangeStart + quote.length,
    rangeClone: range.cloneRange(),
    anchor: range.getBoundingClientRect(),
  };
}

/**
 * 找到选区端点所属的消息或文件正文。
 * @param {Node} node 选区端点。
 * @returns {Element|null} 带消息标识或文件标识的正文元素。
 */
function findSource(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return element?.closest('[data-message-id], .file-content[data-file-id], .conversation');
}

/** @brief 将文件或消息选区放进对话，不直接发起请求。 */
function askAboutSelection() {
  const { anchor, rangeClone, ...reference } = feedbackState.selection;
  closeFeedback({ restoreFocus: false, clearSelection: true });
  feedbackState.onAsk(reference);
}

/**
 * 使用已保存的引用打开表单，输入焦点不会丢失原文范围。
 * @param {Object} context 完整引用。
 * @returns {void}
 */
function openForm(context) {
  feedbackState.context = context;
  feedbackState.toolbar.hidden = true;
  feedbackState.form.innerHTML = formMarkup(context);
  feedbackState.form.hidden = false;
  positionOverlay(feedbackState.form, context.anchor, false);
  feedbackState.form.querySelector('textarea').focus({ preventScroll: true });
}

/**
 * 生成包含转义引用文字的表单内容。
 * @param {Object} context 当前反馈引用。
 * @returns {string} 表单 HTML。
 */
function formMarkup(context) {
  const source = escapeHtml(context.source);
  const version = escapeHtml(context.version);
  const quote = escapeHtml(context.quote);
  return `
    <header class="feedback-popover-heading">
      <h3 id="feedback-title">反馈</h3>
      <button type="button" class="icon-button" data-feedback-cancel aria-label="关闭反馈">×</button>
    </header>
    <blockquote class="feedback-quote">${quote}</blockquote>
    <p class="feedback-source" title="${source} · 内容版本 ${version}">已关联原文或产物</p>
    <label class="feedback-field-label" for="feedback-expected">希望得到什么结果？</label>
    <textarea id="feedback-expected" name="expected" required rows="3"
      placeholder="直接说你的期望，例如：先告诉我改好了什么，再解释原因。"></textarea>
    <p class="feedback-note">Mori 会结合上下文理解，判断需要调整什么。</p>
    <p class="feedback-error" role="alert" hidden></p>
    <footer class="feedback-actions">
      <button type="button" class="button" data-feedback-cancel>取消</button>
      <button type="submit" class="button primary">提交反馈</button>
    </footer>`;
}

/**
 * 提交已关联原文的反馈，应用保存失败时保留表单供重试。
 * @param {SubmitEvent} event 表单提交事件。
 * @returns {Promise<void>} 保存和关闭操作。
 */
async function submitFeedback(event) {
  event.preventDefault();
  const form = feedbackState.form;
  const fields = new FormData(form);
  const expected = String(fields.get('expected')).trim();
  const textarea = form.querySelector('textarea');
  textarea.setCustomValidity(expected ? '' : 'Please describe the expected change.');
  if (!form.reportValidity()) return;
  const context = feedbackState.context;
  const { quote, source, version, session, rangeStart, rangeEnd, originalText } = context;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await feedbackState.onSubmit({
      quote, source, version, session, expected, rangeStart, rangeEnd, originalText,
      fileId: context.fileId, filePath: context.filePath, startLine: context.startLine, endLine: context.endLine,
      createdAt: new Date().toISOString(),
    });
    if (feedbackState.context === context) closeFeedback({ restoreFocus: true, clearSelection: true });
  } catch (error) {
    console.error('Failed to record feedback.', error);
    if (feedbackState.context === context) {
      const message = form.querySelector('.feedback-error');
      message.textContent = 'Unable to record feedback. Please try again.';
      message.hidden = false;
      textarea.focus({ preventScroll: true });
    }
  } finally {
    button.disabled = false;
  }
}

/**
 * 在可见视口内将浮层放在引用附近。
 * @param {HTMLElement} overlay 浮层元素。
 * @param {DOMRect|null} anchor 引用或触发按钮的位置。
 * @param {boolean} preferAbove 工具栏优先放在选区上方。
 * @returns {void}
 */
function positionOverlay(overlay, anchor, preferAbove) {
  const margin = 16;
  const gap = 9;
  const width = overlay.offsetWidth;
  const height = overlay.offsetHeight;
  const usableAnchor = anchor && anchor.width + anchor.height > 0;
  let left = usableAnchor ? anchor.left : (window.innerWidth - width) / 2;
  let top = usableAnchor ? anchor.bottom + gap : (window.innerHeight - height) / 2;
  if (usableAnchor && preferAbove && anchor.top > height + margin + gap) top = anchor.top - height - gap;
  if (usableAnchor && top + height > window.innerHeight - margin) top = anchor.top - height - gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  overlay.style.left = `${Math.round(left)}px`;
  overlay.style.top = `${Math.round(top)}px`;
}

/**
 * 滚动或调整窗口时让浮层继续跟随原文位置。
 * @param {Event} event 视口或滚动事件。
 * @returns {void}
 */
function repositionFeedback(event) {
  if (isInFeedback(event.target)) return;
  const formOpen = !feedbackState.form.hidden;
  const context = formOpen ? feedbackState.context : feedbackState.selection;
  if (!context) return;
  if (context.rangeClone) context.anchor = context.rangeClone.getBoundingClientRect();
  const overlay = formOpen ? feedbackState.form : feedbackState.toolbar;
  positionOverlay(overlay, context.anchor, !formOpen);
}

/**
 * 判断事件是否发生在反馈浮层内部。
 * @param {EventTarget|null} target 事件目标。
 * @returns {boolean} 是否属于工具栏或表单。
 */
function isInFeedback(target) {
  return target instanceof Node &&
    (feedbackState.toolbar.contains(target) || feedbackState.form.contains(target));
}

/**
 * 点击浮层外部时关闭，不抢走当前点击目标的焦点。
 * @param {PointerEvent} event 点击起始事件。
 * @returns {void}
 */
function dismissOutside(event) {
  if (!isInFeedback(event.target)) closeFeedback({ restoreFocus: false });
}

/**
 * Escape 取消反馈并清除选区，避免下一次键盘事件再次打开。
 * @param {KeyboardEvent} event 键盘事件。
 * @returns {void}
 */
function handleEscape(event) {
  if (event.key !== 'Escape' || (feedbackState.toolbar.hidden && feedbackState.form.hidden)) return;
  event.preventDefault();
  closeFeedback({ restoreFocus: true, clearSelection: true });
}

/**
 * 关闭浮层并按操作来源恢复焦点。
 * @param {Object} options 是否恢复焦点及清除原生选区。
 * @returns {void}
 */
function closeFeedback({ restoreFocus, clearSelection = false }) {
  const returnFocus = feedbackState.returnFocus;
  feedbackState.toolbar.hidden = true;
  feedbackState.form.hidden = true;
  feedbackState.context = null;
  feedbackState.selection = null;
  if (clearSelection) window.getSelection()?.removeAllRanges();
  if (restoreFocus && returnFocus instanceof HTMLElement && returnFocus.isConnected) {
    returnFocus.focus({ preventScroll: true });
  }
}

/** 模块专属浮层样式沿用页面按钮和字体，不改变主界面布局。 */
const feedbackStyles = `
.feedback-selection-toolbar, .feedback-popover {
  position: fixed; z-index: 220; color: #1a2029; background: #fff; box-sizing: border-box;
  border: 1px solid #e2e6eb; box-shadow: 0 8px 30px #0f172a18, 0 1px 5px #0f172a0a;
  font: inherit; pointer-events: auto;
}
.feedback-selection-toolbar[hidden], .feedback-popover[hidden] { display: none; }
.feedback-selection-toolbar {
  display: flex; align-items: center; gap: 2px; padding: 5px; border-radius: 11px;
  max-width: calc(100vw - 32px); white-space: nowrap;
}
.feedback-selection-toolbar button {
  border: 0; background: transparent; font: inherit; font-size: 12px; color: #5e6672;
  border-radius: 7px; padding: 7px 9px; cursor: pointer;
}
.feedback-selection-toolbar button:hover { color: #356ccf; background: #edf3fe; }
.feedback-selection-toolbar button:focus-visible {
  outline: 2px solid #7199eb; outline-offset: 1px;
}
.feedback-popover { width: 374px; max-width: calc(100vw - 32px); padding: 20px; border-radius: 16px;
  max-height: calc(100dvh - 32px); overflow: auto; }
.feedback-popover-heading {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px;
}
.feedback-popover h3 { font-size: 16px; line-height: 1.5; font-weight: 600; margin: 0; }
.feedback-popover-heading .icon-button { font-size: 22px; align-self: flex-start; width: 28px; height: 28px; }
.feedback-quote {
  border-left: 2px solid #a9bfeb; background: #f6f8fc; border-radius: 0 7px 7px 0;
  margin: 0; padding: 10px 12px; color: #626b79; font-size: 12px; line-height: 1.7;
  max-height: 82px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
}
.feedback-source { display: flex; gap: 10px; justify-content: space-between; margin: 7px 0 18px;
  color: #959daa; font-size: 10px; overflow-wrap: anywhere; }
.feedback-source span { flex-shrink: 0; }
.feedback-field-label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 8px; }
.feedback-popover textarea {
  box-sizing: border-box; width: 100%; min-height: 90px; max-height: 180px; padding: 10px 12px;
  border: 1px solid #dfe4eb; border-radius: 9px; font: inherit; font-size: 12px;
  line-height: 1.7; color: #303846; resize: vertical; background: #fff;
}
.feedback-popover textarea::placeholder { color: #a0a7b2; }
.feedback-popover textarea:focus { outline: none; border-color: #8caeeb; box-shadow: 0 0 0 3px #4176e611; }
.feedback-note { font-size: 11px; color: #929aa6; line-height: 1.7; margin: 9px 0 0; }
.feedback-error { color: #ba332d; font-size: 11px; line-height: 1.5; margin: 10px 0 0; }
.feedback-error[hidden] { display: none; }
.feedback-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 17px; }
.feedback-actions .button { min-height: 31px; font-size: 12px; padding: 6px 13px; }
@media (max-width: 450px) {
  .feedback-popover { padding: 16px; }
  .feedback-selection-toolbar { gap: 0; }
  .feedback-selection-toolbar button { padding: 7px 8px; }
}
`;
