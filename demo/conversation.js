import { icon } from './icons.js';
import { escapeHtml } from './feedback.js';
import { codingTask, researchTask } from './task-state.js';

/** @brief 创建展示工具执行证据的可展开行。 */
function traceRow(title, time, detail) {
  return `<details><summary>${icon('check').replace('<svg', '<svg class="trace-check"')}
    ${title}<span class="trace-time">${time}</span>${icon('chevron')}</summary><p>${detail}</p></details>`;
}

/** @brief 渲染编码会话中的执行记录。 */
function codingTrace() {
  return `<div class="trace">
    ${traceRow('已整理目标与完成条件', '目标整理 · 3s',
      '只修改工具派发前的版本检查；旧参数不能进入同名的新工具。')}
    ${traceRow('找到相关记忆与源码依据', '记忆查询 · 2s',
      '已采用：优先使用已有实现，不增加兼容层。来源：项目约束 · 记忆版本 4。')}
    ${traceRow('读取工具注册与派发路径', '执行 · 12s',
      '已读取 tools/registry.ts、tools/dispatch.ts 和 agent-loop/request.ts。工具定义版本 12。')}
  </div>`;
}

/** @brief 渲染编码会话的核心演示内容。 */
function codingConversation(state) {
  return `<div class="day-line">今天 · 09:41</div>
    <div class="user-message">给工具热更新补上版本检查。旧请求的参数不能传给更新后的工具，
      尽量复用现有实现。</div>
    <div class="assistant-heading"><span class="mori-symbol">ⅿ</span>Mori
      <span class="role-label">对话 · 快速模型</span></div>
    <div class="prose" data-message-id="coding-plan" data-version="1">
      <p>我会先核对现有工具调用路径，再补上派发前的版本检查。<br>
      <strong>工具发生变化时，旧调用会停止，并按新定义重新准备。</strong></p>
    </div>
    <div class="context-chips">
      <button class="context-chip" data-action="show-task">${icon('shield')} 已采用项目约束</button>
      <button class="context-chip" data-action="show-task">${icon('memory')} 相关记忆 · 2 条</button>
      <button class="context-chip" data-action="show-files">${icon('folder')} mori</button>
    </div>
    ${codingTrace()}
    <div class="guard-note">
      <div class="guard-title">${icon('shield')} 监督发现了一处需要纠正的操作</div>
      <p>原计划只在发送请求前检查版本，排队期间仍可能过期。<br>
        这次写入尚未执行；已调整为工具派发前再次检查。</p>
      <button class="text-link" data-action="show-task">查看依据与调整 ${icon('chevron')}</button>
    </div>
    <div class="prose result-prose" data-message-id="coding-result"
      data-version="${state.phase === 'completed' ? 2 : 1}">
      <p>已补上检查，修改范围保持在工具派发入口。相关测试已通过，
        ${state.phase === 'completed' ? '<strong>独立验收已完成。</strong>' : '接下来由独立验收核对完成条件。'}</p>
    </div>
    ${artifactCard()}
    <div class="message-actions">
      <button class="icon-button" data-action="copy" data-session="coding" data-copy-source="coding-result"
        title="复制回复" aria-label="复制回复">${icon('copy')}</button>
      <button class="icon-button" data-action="feedback-message" title="反馈这段回复"
        aria-label="反馈这段回复">${icon('feedback')}</button>
      <span>选中文字，可以直接纠正</span>
    </div>`;
}

/** @brief 渲染可以直接阅读文件正文的产物卡片。 */
function artifactCard() {
  return `<div class="artifact-row"><button class="artifact-card" data-action="open-file" data-file-id="dispatch">
    <span class="file-symbol">TS</span><span><strong>dispatch.ts</strong>
    <small>packages / tools · 工具派发前检查</small></span>
    <span class="artifact-open">打开文件</span>${icon('chevron')}</button>
    <button class="icon-button" data-action="feedback-artifact" aria-label="反馈修改结果"
      title="反馈修改结果">${icon('feedback')}</button></div>`;
}

/** @brief 渲染第二个运行中的用户会话。 */
function researchConversation(state) {
  const task = researchTask(state);
  return `<div class="day-line">今天 · 09:38</div>
    <div class="user-message">帮我对比现有的 MCP 连接更新方案，整理一下适用边界。</div>
    <div class="assistant-heading"><span class="mori-symbol">ⅿ</span>Mori
      <span class="role-label">对话 · 快速模型</span></div>
    <div class="prose" data-message-id="research-plan" data-version="1">
      <p>我正在核对现有实现的连接生命周期。重点看两件事：
      <strong>新连接什么时候接收请求，以及旧调用如何安全结束。</strong></p>
      <p>资料检索使用独立角色会话。你可以继续聊，也可以切回编码任务。</p>
    </div>
    <div class="context-chips"><span class="context-chip">${icon('folder')} 资料研究</span>
      <span class="context-chip">${icon('shield')} 只读检索</span></div>
    <div class="trace">
      ${traceRow('已确认比较范围', '目标整理 · 4s', '覆盖工具定义、认证、连接交接与正在运行的调用。')}
    </div>
    <div class="guard-note"><div class="guard-title">${icon('clock')} ${task.progress}</div>
      <p>${task.detail}</p></div>`;
}

/** @brief 渲染新会话的输入提示。 */
function emptyConversation(state) {
  return `<div class="empty-chat"><div class="assistant-heading"><span class="mori-symbol">ⅿ</span>Mori</div>
    <h1>从一个想法开始。</h1><p>这是 ${escapeHtml(state.projects[state.sessionProjects[state.session]].name)} 中的新会话。</p>
    <p>说说你想完成什么，Mori 会整理目标、执行并核对结果。</p>
    <div class="prompt-suggestions">
      <button data-action="start-coding">看看编码任务如何协作 ${icon('chevron')}</button>
      <button data-action="start-research">查看并行的资料研究 ${icon('chevron')}</button>
    </div></div>`;
}

/** @brief 展示当前会话中的纠正记录与自定义输入。 */
function followups(state) {
  const records = state.feedbacks.filter(item => item.session === state.session).map(item => `
    <div class="feedback-record">${icon('check')} 已记录 · 待模型判断<br>
      ${escapeHtml(item.expected)}<br><span class="muted">已保留原文和上下文，无需选择分类。</span><br>
      <button class="feedback-review-link" data-action="review-select" data-kind="feedback"
        data-id="current-${state.feedbacks.indexOf(item)}">在工作回顾中查看 ${icon('chevron')}</button></div>`).join('');
  const messages = state.messages[state.session].map((message, index) => renderFollowup(message, index, state.titles));
  return records + messages.join('');
}

/** @brief 显示选区原文快照和当前会话名称，并保留返回原对象的位置。 */
export function referenceMarkup(reference, titles) {
  const attributes = reference.fileId
    ? `data-action="open-reference" data-file-id="${reference.fileId}"
      data-start-line="${reference.startLine}" data-end-line="${reference.endLine}"`
    : `data-action="open-chat-reference" data-session="${reference.session}"
      data-source="${escapeHtml(reference.source)}" data-version="${escapeHtml(reference.version)}"`;
  const label = reference.fileId
    ? `${reference.filePath} · 行 ${reference.startLine}–${reference.endLine}`
    : `${titles[reference.session]} · 消息选区`;
  return `<div class="sent-reference"><button type="button" ${attributes}>
    ${icon(reference.fileId ? 'file' : 'feedback')}${escapeHtml(label)}</button>
    <blockquote>${escapeHtml(reference.quote)}</blockquote></div>`;
}

/** @brief 展示本地提问回执，明确未产生真实模型回答或文件修改。 */
function renderFollowup(message, index, titles) {
  const reference = message.reference;
  const sessions = message.sessions.map(session => `<div class="sent-session-reference">
    <button data-action="session-${session.id}" title="打开引用的会话">
      ${icon('feedback')}引用会话 · ${escapeHtml(titles[session.id])}</button></div>`).join('');
  return `<div class="user-message followup-message" data-message-id="user-${index}" data-version="1">
    ${sessions}${reference ? referenceMarkup(reference, titles) : ''}
    ${escapeHtml(message.text)}</div>
    <div class="assistant-heading"><span class="mori-symbol">ⅿ</span>Mori<span class="role-label">交互演示</span></div>
    <div class="prose" data-message-id="reply-${index}" data-version="1"><p>${reference || message.sessions.length
      ? '已带上引用的内容和你的要求，作为这次对话的上下文。'
      : '已收到这条补充。'}<br>demo 未连接模型，正式运行时将在这里回应；当前没有修改文件。</p></div>`;
}

/** @brief 按当前用户会话生成聊天视图。 */
export function renderConversation(state) {
  const content = state.session === 'coding' ? codingConversation(state)
    : state.session === 'research' ? researchConversation(state)
      : state.messages[state.session].length ? '' : emptyConversation(state);
  return `<div class="conversation-inner">${content}${followups(state)}</div>`;
}

/** @brief 返回当前会话可读的进展摘要。 */
export function progressLabel(state) {
  if (!['coding', 'research'].includes(state.session)) {
    return state.messages[state.session].length ? '已记录消息 · 演示模式' : '准备好开始';
  }
  if (state.session === 'coding' && state.phase === 'completed') return '已完成';
  if (state.session === 'coding') return codingTask(state).progress;
  return researchTask(state).progress;
}
