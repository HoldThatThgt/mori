const SESSION_TYPE = 'application/x-mori-session';

/** @brief 从会话入口读取当前标识和标题。 */
function sessionSource(event) {
  const element = event.target.closest?.('[data-session-id]');
  if (!element) return null;
  return { id: element.dataset.sessionId, title: element.dataset.sessionTitle, element };
}

/** @brief 关闭菜单，按需恢复原入口的键盘焦点。 */
function closeMenu(state, restoreFocus = false) {
  if (!state.menu) return;
  const { element, source } = state.menu;
  element.remove();
  state.menu = null;
  if (restoreFocus && source.element.isConnected) source.element.focus();
}

/** @brief 保存经过非空校验的会话名称。 */
function saveRename(state, source, dialog, event) {
  event.preventDefault();
  const input = dialog.querySelector('input');
  const title = input.value.trim();
  if (!title) {
    console.error('Session name must not be empty.');
    dialog.querySelector('.session-rename-error').textContent = 'Enter a session name.';
    input.focus();
    return;
  }
  state.callbacks.onRename(source.id, title);
  dialog.close();
}

/** @brief 打开使用原生焦点管理的重命名对话框。 */
function openRename(state, source) {
  const dialog = document.createElement('dialog');
  dialog.className = 'session-rename-dialog';
  dialog.setAttribute('aria-labelledby', 'session-rename-heading');
  dialog.innerHTML = `<form class="session-rename-form">
    <h2 id="session-rename-heading">重命名会话</h2>
    <label for="session-rename-input">会话名称</label>
    <input id="session-rename-input" name="title" autocomplete="off" spellcheck="false">
    <p class="session-rename-error" role="alert"></p>
    <div class="session-rename-buttons"><button type="button" class="button" data-rename-cancel>取消</button>
    <button type="submit" class="button primary">保存</button></div></form>`;
  dialog.querySelector('input').value = source.title;
  dialog.querySelector('form').addEventListener('submit', event => saveRename(state, source, dialog, event));
  dialog.querySelector('[data-rename-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => event.stopPropagation());
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    state.dialog = null;
    if (source.element.isConnected) source.element.focus();
  });
  state.dialog = dialog;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('input').select();
}

/** @brief 执行菜单命令，不把菜单点击传给会话切换入口。 */
function runCommand(state, source, command) {
  const targetId = document.querySelector('.app').dataset.activeSession;
  closeMenu(state);
  if (command === 'rename') openRename(state, source);
  if (command === 'reference') state.callbacks.onReference(source.id, targetId);
  if (command === 'split') state.callbacks.onSplit(source.id, targetId, 'right');
}

/** @brief 支持菜单中的方向键、首尾跳转与退出。 */
function menuKeys(state, event) {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(state, true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...state.menu.element.querySelectorAll('button:not(:disabled)')];
  const current = buttons.indexOf(document.activeElement);
  const movement = event.key === 'ArrowUp' ? -1 : 1;
  let position = (current + movement + buttons.length) % buttons.length;
  if (event.key === 'Home') position = 0;
  if (event.key === 'End') position = buttons.length - 1;
  buttons[position].focus();
}

/** @brief 将右键菜单放入视口，兼顾键盘触发的位置。 */
function positionMenu(menu, source, event) {
  const rect = source.element.getBoundingClientRect();
  const x = event.clientX || rect.left + 12;
  const y = event.clientY || rect.bottom + 4;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
}

/** @brief 为侧栏和分屏标题提供相同的会话操作菜单。 */
function openMenu(state, event) {
  const source = sessionSource(event);
  if (!source) return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu(state);
  const menu = document.createElement('div');
  menu.className = 'session-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '会话操作');
  const commands = [['rename', '重命名'], ['reference', '引用到当前会话'], ['split', '在右侧分屏打开']];
  const activeId = document.querySelector('.app').dataset.activeSession;
  for (const [command, label] of commands) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.disabled = command !== 'rename' && source.id === activeId;
    button.addEventListener('click', () => runCommand(state, source, command));
    menu.append(button);
  }
  menu.addEventListener('click', event => event.stopPropagation());
  menu.addEventListener('keydown', event => menuKeys(state, event));
  state.menu = { element: menu, source };
  document.body.append(menu);
  positionMenu(menu, source, event);
  menu.querySelector('button').focus();
}

/** @brief 移除落点提示和拖拽源的视觉状态。 */
function clearDrag(state) {
  state.preview?.remove();
  state.preview = null;
  state.drag?.element.classList.remove('session-drag-source');
  state.drag = null;
}

/** @brief 由真实浏览器拖拽事件创建仅属于本页的会话载荷。 */
function startDrag(state, event) {
  const source = sessionSource(event);
  if (!source || source.element.draggable !== true) return;
  closeMenu(state);
  clearDrag(state);
  event.dataTransfer.setData(SESSION_TYPE, source.id);
  event.dataTransfer.effectAllowed = 'copy';
  source.element.classList.add('session-drag-source');
  state.drag = source;
}

/** @brief 优先识别输入框引用落点，再识别聊天区域左右分屏落点。 */
function dropTarget(event, sourceId) {
  const composer = event.target.closest?.('.composer[data-chat-session]');
  const pane = event.target.closest?.('.chat-pane[data-chat-session]');
  const element = composer || pane;
  if (!element || element.dataset.chatSession === sourceId) return null;
  const rect = element.getBoundingClientRect();
  const side = event.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
  return { element, targetId: element.dataset.chatSession, kind: composer ? 'reference' : 'split', side, rect };
}

/** @brief 用柔和覆盖层呈现引用或左右分屏的落点。 */
function showDropPreview(state, target) {
  if (!state.preview) {
    state.preview = document.createElement('div');
    state.preview.className = 'session-drop-preview';
    state.preview.setAttribute('aria-hidden', 'true');
    document.body.append(state.preview);
  }
  const split = target.kind === 'split';
  const width = split ? target.rect.width / 2 : target.rect.width;
  const offset = split && target.side === 'right' ? width : 0;
  Object.assign(state.preview.style, {
    left: `${target.rect.left + offset + 5}px`,
    top: `${target.rect.top + 5}px`,
    width: `${width - 10}px`,
    height: `${target.rect.height - 10}px`,
  });
  state.preview.classList.toggle('reference', !split);
  state.preview.textContent = split ? `松开以在${target.side === 'left' ? '左' : '右'}侧分屏打开` : '松开以引用此会话';
}

/** @brief 仅接受本页会话拖拽，阻止有效落点的浏览器默认行为。 */
function dragOver(state, event) {
  if (!state.drag || !event.dataTransfer.types.includes(SESSION_TYPE)) return;
  const target = dropTarget(event, state.drag.id);
  if (!target) { state.preview?.remove(); state.preview = null; return; }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  showDropPreview(state, target);
}

/** @brief 派发引用或分屏动作，输入框落点不会进入分屏分支。 */
function dropSession(state, event) {
  if (!state.drag) return;
  const sourceId = state.drag.id;
  const valid = event.dataTransfer.getData(SESSION_TYPE) === sourceId;
  const target = dropTarget(event, sourceId);
  clearDrag(state);
  if (!valid || !target) return;
  event.preventDefault();
  event.stopPropagation();
  if (target.kind === 'reference') state.callbacks.onReference(sourceId, target.targetId);
  else state.callbacks.onSplit(sourceId, target.targetId, target.side);
}

/** @brief 清理被取消的拖拽，以及退出页面边界的落点提示。 */
function leaveDrag(state, event) {
  if (event.relatedTarget !== null) return;
  state.preview?.remove();
  state.preview = null;
}

/** @brief 安装原生会话拖拽与菜单操作，返回卸载函数。 */
export function initSessionActions(callbacks) {
  const state = { callbacks, drag: null, preview: null, menu: null, dialog: null };
  const controller = new AbortController();
  const options = { signal: controller.signal };
  document.addEventListener('contextmenu', event => openMenu(state, event), options);
  document.addEventListener('dragstart', event => startDrag(state, event), options);
  document.addEventListener('dragover', event => dragOver(state, event), options);
  document.addEventListener('drop', event => dropSession(state, event), options);
  document.addEventListener('dragend', () => clearDrag(state), options);
  document.addEventListener('dragleave', event => leaveDrag(state, event), options);
  document.addEventListener('pointerdown', event => {
    if (state.menu && !state.menu.element.contains(event.target)) closeMenu(state);
  }, options);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { clearDrag(state); closeMenu(state, true); }
  }, options);
  return () => {
    controller.abort();
    clearDrag(state);
    closeMenu(state);
    state.dialog?.close();
  };
}
