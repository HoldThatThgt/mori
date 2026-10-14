import { icon } from './icons.js';
import { escapeHtml } from './feedback.js';
import { renderConversation, progressLabel, referenceMarkup } from './conversation.js';
import { canAdvanceTask } from './task-state.js';
import { getModelPool } from './pool.js';

/** @brief 输出可拖动并支持键盘操作的布局分隔线。 */
export function resizeHandle(target, label) {
  return `<div class="resize-handle" data-resize="${target}" role="separator" tabindex="0"
    aria-label="${label}" aria-orientation="vertical" title="拖动调整宽度，双击恢复默认"></div>`;
}

/** @brief 渲染独立会话窗口，消息、输入和引用都按会话保存。 */
export function renderChatPane(state, session) {
  const view = { ...state, session };
  const title = escapeHtml(state.titles[session]);
  return `<section class="chat chat-pane ${session === state.session ? 'is-active' : ''}"
    data-chat-session="${session}" aria-label="${title}">
    <header class="chat-pane-header"><button class="chat-pane-title" draggable="true"
      data-session-id="${session}" data-session-title="${title}" title="右键改名，拖动引用或分屏">
      ${icon('feedback')}<span>${title}</span></button>
      ${state.panes.length > 1 ? `<button class="icon-button" data-action="close-chat-pane"
        data-session="${session}" aria-label="关闭此分屏">${icon('close')}</button>` : ''}</header>
    <div id="conversation-${session}" class="conversation" data-session="${session}"
      data-version="${state.revision}">${renderConversation(view)}</div>${composer(view)}</section>`;
}

/** @brief 在每个会话窗口内保留独立的输入区。 */
function composer(state) {
  const running = getModelPool(state).requests.some(item => item.session === state.session && item.state === 'active');
  const placeholder = state.references[state.session]
    ? '针对选中内容提问，或描述你希望怎样修改…' : '继续提问，或拖入会话作为参考…';
  return `<div class="composer-area"><div class="task-strip">
    ${running ? '<span class="spinner"></span>' : icon(state.session === 'coding' &&
      state.phase === 'completed' ? 'check' : 'clock')}
    <span class="task-status">${progressLabel(state)}</span>
    <button data-action="show-task">任务与文件 ${icon('chevron')}</button></div>
    <form class="composer" data-chat-session="${state.session}">
      ${composerReference(state)}${sessionReferences(state)}
      <textarea id="message-input-${state.session}" class="message-input" aria-label="给 Mori 的消息"
        placeholder="${placeholder}" rows="2">${escapeHtml(state.drafts[state.session])}</textarea>
      <div class="composer-bottom"><button type="button" class="icon-button" data-action="show-files"
        title="查看项目文件" aria-label="查看项目文件">${icon('plus')}</button>
        <button type="button" class="composer-option permission" data-action="show-task">
          ${icon('shield')} ${state.sessionProjects[state.session] === 'research' ? '只读检索' : '工作区内修改'}
          ${icon('down')}</button>
        <span class="composer-spacer"></span>
        <button type="button" class="composer-option" data-action="toggle-pool">快速模型 ${icon('down')}</button>
        <button type="submit" class="icon-button send-button" aria-label="发送消息">${icon('arrow')}</button></div>
    </form><div class="composer-caption">交互演示 · 未连接模型
      <span> · </span><button data-action="${state.session === 'coding' ? 'advance' : 'start-coding'}"
        ${state.session === 'coding' && !canAdvanceTask(state) ? 'disabled' : ''}>
        ${state.session === 'coding' ? advanceLabel(state) : '演示编码任务'}</button>
      <span> · </span><button data-action="show-runtime">运行记录</button>
      <span> · </span><button data-action="reset">重置演示</button></div></div>`;
}

/** @brief 展示选中原文及其来源，不要求用户重新复制内容。 */
function composerReference(state) {
  const reference = state.references[state.session];
  if (!reference) return '';
  return `<div class="composer-reference"><div class="reference-heading">
    <span>引用选中内容</span><button type="button" class="icon-button" data-action="remove-reference"
    aria-label="移除选区引用">${icon('close')}</button></div>${referenceMarkup(reference, state.titles)}</div>`;
}

/** @brief 展示拖入输入框的会话引用，允许在发送前移除。 */
function sessionReferences(state) {
  const references = state.sessionReferences[state.session];
  return references.length ? `<div class="session-references">${references.map(reference => `
    <div class="session-reference"><button type="button" data-action="session-${reference.id}"
      title="打开引用的会话">${icon('feedback')}<span>${escapeHtml(state.titles[reference.id])}</span></button>
      <button type="button" class="icon-button" data-action="remove-session-reference"
        data-session="${reference.id}" aria-label="移除会话引用">${icon('close')}</button></div>`).join('')}</div>` : '';
}

/** @brief 返回当前编码演示阶段的推进标签。 */
function advanceLabel(state) {
  if (state.phase === 'completed') return '重新演示';
  if (state.phase === 'review') return '演示验收完成';
  return '演示独立验收';
}
