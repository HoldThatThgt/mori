import { icon } from './icons.js';
import { renderPanel } from './panels.js';
import { demoFiles, renderFileWorkspace } from './files.js';
import { initFeedback, openFeedback, escapeHtml } from './feedback.js';
import { renderConversation } from './conversation.js';
import { renderChatPane, resizeHandle } from './chat-pane.js';
import { initResize } from './resize.js';
import { initSessionActions } from './session-actions.js';
import { renderPool, poolStatus } from './pool.js';
import { pageNames, renderFeaturePage } from './feature-pages.js';
import { initialTools, handleToolsAction } from './tool-catalog.js';
import { initialSettings, handleSettingsAction, updateSettingsDraft, saveSettings } from './user-settings.js';
import { initialProjects, initialSessions, currentProject, createProject } from './projects.js';
import { createSession, renderProjectSessions } from './projects.js';
import { openNewSession } from './session-create.js';
import { openNewProject } from './project-create.js';
import { renderRuntimePanel } from './runtime-panel.js';
import { initialRuntimeState, selectRuntimeScenario, resolveRuntimeScenario, canAdvanceTask } from './task-state.js';

const state = {
  ...initialProjects(), ...initialTools(), ...initialSettings(), ...initialSessions(),
  view: 'chat', pageDetailsOpen: true,
  reviewSelection: { kind: 'run', id: 'example' },
  chatScrolls: {}, pageScrolls: {}, workspaceScrolls: {}, fileScroll: { top: 0, left: 0 },
  session: 'coding', panel: window.innerWidth >= 800 ? 'files' : null,
  fileId: 'dispatch', fileHighlight: null,
  phase: 'acceptance', revision: 1, ...initialRuntimeState(),
  panes: ['coding'],
  sidebarWidth: window.innerWidth <= 1150 ? 220 : 260,
  workspaceWidth: window.innerWidth <= 1150 ? 400 : 450, splitRatio: 0.5,
  feedbacks: [],
  poolOpen: false, poolFilter: 'all', poolState: 'normal', collapsed: window.innerWidth < 1024,
};
const panelNames = {
  files: '任务与文件', terminal: '终端', runtime: '运行记录',
};
const panelIcons = {
  files: 'folder', terminal: 'terminal', runtime: 'clock',
};
let toastTimer;
const toolTimers = new Map();

/** @brief 创建侧栏导航按钮。 */
function navItem(action, name, label) {
  const active = action === `show-${state.view}`;
  return `<button class="nav-item ${action === 'new-project' ? 'new-project' : ''} ${active ? 'active' : ''}"
    data-action="${action}" ${active ? 'aria-current="page"' : ''}
    title="${label}">${icon(name)}<span class="nav-label">${label}</span></button>`;
}

/** @brief 渲染 DSH 风格侧栏与 Mori 模型池入口。 */
function sidebar() {
  const pool = poolStatus(state);
  return `<aside class="sidebar ${state.collapsed ? 'collapsed' : ''}" aria-label="会话侧栏">
    <div class="brand-row"><svg class="brand-mark" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path d="M4 23V8l11 11L26 8v15" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>
      <span class="brand">mori</span><button class="icon-button" data-action="sidebar"
      aria-label="展开或收起侧栏">${icon('panel')}</button></div>
    <button class="pool-button" data-action="toggle-pool" aria-expanded="${state.poolOpen}" title="模型池详情">
      <span class="pool-dots"><span class="dot idle"></span><span class="dot ${pool.dot}"></span></span>
      <span class="pool-label">${pool.label}</span><span class="down">${icon('down')}</span></button>
    <nav class="sidebar-nav">
      ${navItem('new-project', 'plus', '新项目')}
      ${navItem('show-tools', 'grid', '工具')}
      ${navItem('show-maintenance', 'clock', '工作回顾')}
    </nav>
    ${renderProjectSessions(state)}
    <div class="sidebar-bottom"><div class="demo-label">INTERACTIVE DEMO · 演示数据</div>
      <div class="profile"><span class="avatar">B</span><span class="profile-text">本地工作区
        <small>你的机器，你的工作</small></span><button
        class="icon-button ${state.view === 'settings' ? 'settings-active' : ''}" data-action="show-settings"
        aria-label="设置" title="用户设置：AGENTS.md、Skill、MCP、Plugin 与模型">${icon('settings')}</button></div></div>
    ${resizeHandle('sidebar', '调整左侧栏宽度')}</aside>`;
}

/** @brief 渲染聊天标题和原生工作区入口。 */
function topbar() {
  if (state.view !== 'chat') return `<header class="topbar"><div class="breadcrumb">
    <span>${state.view === 'settings' ? '用户' : '工作区'}</span>
    ${icon('chevron')}<span class="chat-title">${pageNames[state.view]}</span></div>
    <div class="topbar-actions"><button class="button return-chat" data-action="return-chat">
      ${icon('panel')}返回会话</button></div></header>`;
  return `<header class="topbar"><div class="breadcrumb">
    <span class="chat-project">${escapeHtml(state.projects[state.sessionProjects[state.session]].name)}</span>
    ${icon('chevron')}<span class="chat-title">${escapeHtml(state.titles[state.session])}</span></div>
    <div class="topbar-actions"><span class="local-chip"><span class="dot"></span>本地演示</span>
      <button class="icon-button secondary-action" data-action="show-files" aria-label="打开项目文件"
        title="项目文件">${icon('folder')}</button>
      <button class="icon-button secondary-action" data-action="show-terminal" aria-label="打开终端"
        title="终端">${icon('terminal')}</button>
      <button class="icon-button" data-action="toggle-panel" aria-label="展开或收起工作区"
        title="工作区">${icon('right')}</button></div></header>`;
}

/** @brief 渲染可以按需关闭的文件和任务面板。 */
function rightPanel() {
  if (!state.panel) return '';
  const content = state.panel === 'files' ? renderFileWorkspace(state)
    : state.panel === 'runtime' ? renderRuntimePanel(state) : renderPanel(state);
  const tabs = Object.entries(panelNames);
  return `<aside class="right-panel" aria-label="工作区面板">
    ${resizeHandle('workspace', '调整右侧工作区宽度')}
    <div class="panel-header">${icon(panelIcons[state.panel])}${panelNames[state.panel]}
      <button class="icon-button" data-action="close-panel" aria-label="关闭工作区面板">${icon('close')}</button></div>
    <div class="panel-tabs">${tabs.map(([id,label]) => `<button data-action="show-${id}"
      class="panel-tab ${state.panel === id ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div class="panel-body ${state.panel === 'files' ? 'file-panel-body' : ''}"
      data-workspace-key="${state.session}-${state.panel}">${content}</div></aside>`;
}

/** @brief 在切换页面前保存会话和文件的阅读位置。 */
function saveReadingPositions() {
  document.querySelectorAll('.conversation').forEach(element => {
    state.chatScrolls[element.dataset.session] = element.scrollTop;
  });
  const reader = document.querySelector('.file-reader');
  if (reader) state.fileScroll = { top: reader.scrollTop, left: reader.scrollLeft };
  const page = document.querySelector('.feature-main');
  if (page) state.pageScrolls[page.dataset.page] = page.scrollTop;
  const workspace = document.querySelector('.panel-body');
  if (workspace) state.workspaceScrolls[workspace.dataset.workspaceKey] = workspace.scrollTop;
}

/** @brief 创建会话区，独立功能页面不复用聊天或文件容器。 */
function chatBody() {
  return `<div class="body"><div class="chat-group ${state.panes.length > 1 ? 'is-split' : ''}">
    ${state.panes.map(session => renderChatPane(state, session)).join('')}
    ${state.panes.length > 1 ? resizeHandle('chats', '调整两个会话的宽度') : ''}
    </div>${rightPanel()}</div>`;
}

/** @brief 切换独立页面时保留会话布局、草稿和阅读位置。 */
function render() {
  saveReadingPositions();
  document.querySelector('#app').innerHTML = `<div class="app" data-active-session="${state.session}"
    style="--sidebar-width:${state.sidebarWidth}px;--workspace-width:${state.workspaceWidth}px;
      --chat-split:${state.splitRatio * 100}%">${sidebar()}<main class="main">${topbar()}
    ${state.view === 'chat' ? chatBody() : renderFeaturePage(state)}</main></div>`;
  document.querySelectorAll('.conversation').forEach(element => {
    element.scrollTop = state.chatScrolls[element.dataset.session] ?? 0;
  });
  const reader = document.querySelector('.file-reader');
  if (reader) { reader.scrollTop = state.fileScroll.top; reader.scrollLeft = state.fileScroll.left; }
  const page = document.querySelector('.feature-main');
  if (page) page.scrollTop = state.pageScrolls[page.dataset.page] ?? 0;
  const workspace = document.querySelector('.panel-body');
  if (workspace) workspace.scrollTop = state.workspaceScrolls[workspace.dataset.workspaceKey] ?? 0;
  document.querySelector('#pool-layer').innerHTML = state.poolOpen ? renderPool(state) : '';
}

/** @brief 显示短暂的可访问操作反馈。 */
function toast(message) {
  clearTimeout(toastTimer);
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('visible');
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3500);
}

/** @brief 只替换当前会话窗口，已经打开的会话直接聚焦。 */
function switchSession(session) {
  state.view = 'chat';
  if (!state.panes.includes(session)) {
    state.panes[state.panes.indexOf(state.session)] = session;
  }
  state.session = session;
  state.poolOpen = false;
  render();
  focusInput(session);
}

/** @brief 聚焦会话时更新活动标识，不重绘或破坏正在输入的文字。 */
function activateSession(session) {
  if (state.session === session) return;
  saveReadingPositions();
  state.session = session;
  document.querySelector('.app').dataset.activeSession = session;
  document.querySelectorAll('.chat-pane').forEach(pane => {
    pane.classList.toggle('is-active', pane.dataset.chatSession === session);
  });
  document.querySelectorAll('.session-item').forEach(item => {
    item.classList.toggle('active', item.dataset.sessionId === session);
  });
  document.querySelector('.chat-title').textContent = state.titles[session];
  document.querySelector('.chat-project').textContent = state.projects[state.sessionProjects[session]].name;
  const workspace = document.querySelector('.right-panel');
  if (workspace) workspace.outerHTML = rightPanel();
  if (state.poolOpen) document.querySelector('#pool-layer').innerHTML = renderPool(state);
}

/** @brief 把输入焦点放回指定会话，不滚动整个页面。 */
function focusInput(session) {
  document.querySelector(`#message-input-${session}`).focus({ preventScroll: true });
}

/** @brief 会话改名同步侧栏、标题、引用和模型池，不改变消息内容。 */
function renameSession(session, title) {
  state.titles[session] = title;
  render();
  toast('会话已重命名。');
}

/** @brief 新会话明确选择项目并持有独立身份，创建后进入其空白聊天。 */
function newChat(project = currentProject(state)) {
  openNewSession(state, project, (selected, title) => {
    const session = createSession(state, selected, title);
    switchSession(session);
    document.querySelector(`.session-item[data-session-id="${session}"]`).scrollIntoView({ block: 'nearest' });
    toast(`已在 ${state.projects[selected].name} 中创建会话。`);
  });
}

/** @brief 创建项目后进入项目页面，侧栏与工具选择共用新增项目。 */
function newProject() {
  openNewProject(project => {
    const id = createProject(state, project);
    state.collapsed = false;
    openProject(id);
    document.querySelector(`.project-name[data-project="${id}"]`).scrollIntoView({ block: 'nearest' });
    toast(`已创建项目 ${project.name}。`);
  });
}

/** @brief 打开项目主页，提供该项目的会话与工具入口。 */
function openProject(id) {
  state.selectedProject = id;
  state.view = 'project';
  state.pageDetailsOpen = false;
  state.poolOpen = false;
  render();
}

/** @brief 将会话内容快照加入目标会话的输入上下文。 */
function referenceSession(source, target) {
  const list = state.sessionReferences[target];
  if (list.some(reference => reference.id === source)) return toast('这段会话已经在引用中。');
  const snapshot = document.createElement('div');
  snapshot.innerHTML = renderConversation({ ...state, session: source });
  list.push({ id: source, title: state.titles[source], text: snapshot.textContent.trim() });
  state.session = target;
  state.view = 'chat';
  render();
  focusInput(target);
  toast('已引用会话，补充问题后发送。');
}

/** @brief 拖入会话区域后建立左右分屏，已有窗口不复制。 */
function splitSession(source, target, side) {
  if (source === target) return toast('这段会话已经在当前窗口。');
  state.panes = side === 'left' ? [source, target] : [target, source];
  state.session = source;
  state.view = 'chat';
  state.splitRatio = 0.5;
  const sideWidth = state.collapsed ? 60 : state.sidebarWidth;
  if (window.innerWidth - sideWidth - state.workspaceWidth < 560) state.panel = null;
  render();
  focusInput(source);
  toast('已分屏打开，两边可以独立输入。');
}

/** @brief 关闭一个分屏，保留该会话的消息和未发送草稿。 */
function closeChatPane(session) {
  state.panes = state.panes.filter(id => id !== session);
  state.session = state.panes[0];
  render();
}

/** @brief 记录用户原话与上下文，不在未调用模型时伪造分类或任务修订。 */
function recordFeedback(feedback) {
  state.feedbacks.push(feedback);
  state.reviewSelection = { kind: 'feedback', id: `current-${state.feedbacks.length - 1}` };
  render();
  toast('已记录，可在工作回顾中查看；等待模型结合上下文判断。');
}

/** @brief 打开回复或产物的反馈入口。 */
function feedbackFor(artifact) {
  const research = state.session === 'research';
  openFeedback({
    quote: artifact ? demoFiles.dispatch.path
      : research ? '重点看新连接什么时候接收请求，以及旧调用如何安全结束。' : '已补上检查，修改范围保持在工具派发入口。',
    source: artifact ? 'artifact-dispatch'
      : research ? 'research-plan' : 'coding-result',
    version: !artifact && !research && state.phase === 'completed' ? 2 : 1,
    session: artifact ? 'coding' : state.session,
  });
}

/** @brief 演示新连接完成初始化后才切换版本的过程。 */
function refreshTools() {
  const project = state.toolProject;
  const tools = state.toolsByProject[project];
  if (['preparing', 'switching'].includes(tools.stage)) return;
  tools.stage = 'preparing';
  render();
  toolTimers.set(project, setTimeout(() => {
    tools.stage = 'switching';
    render();
    toolTimers.set(project, setTimeout(() => {
      tools.stage = 'updated';
      toolTimers.delete(project);
      render();
      toast(`演示：${state.projects[project].name} 的 MCP 连接更新完成。`);
    }, 1800));
  }, 1400));
}

/** @brief 通过显式交互推进示例任务的独立验收。 */
function advance() {
  if (state.session !== 'coding') switchSession('coding');
  if (!canAdvanceTask(state)) {
    state.panel = 'runtime';
    render();
    return toast('演示仍在等待，请先处理运行记录中的等待原因。');
  }
  const next = { acceptance: 'review', review: 'completed', completed: 'acceptance' };
  if (state.phase === 'completed') Object.assign(state, initialRuntimeState());
  state.phase = next[state.phase];
  state.panel = 'files';
  render();
  toast(state.phase === 'completed' ? '演示：独立验收通过，任务已完成。' : '演示：已推进到下一阶段。');
}

/** @brief 清空本次页面演示状态，不影响项目和外部系统。 */
function reset() {
  toolTimers.forEach(timer => clearTimeout(timer));
  toolTimers.clear();
  Object.assign(state, { ...initialProjects(), ...initialTools(), ...initialSettings(), ...initialSessions(),
    view: 'chat', pageDetailsOpen: true,
    ...initialRuntimeState(),
    reviewSelection: { kind: 'run', id: 'example' }, session: 'coding', panel: 'files',
    phase: 'acceptance', revision: 1,
    fileId: 'dispatch', fileHighlight: null, panes: ['coding'],
    feedbacks: [], chatScrolls: {}, pageScrolls: {}, workspaceScrolls: {}, fileScroll: { top: 0, left: 0 },
    poolState: 'normal', poolOpen: false, poolFilter: 'all' });
  render();
  toast('已重置演示。');
}

/** @brief 将用户消息显示在对应会话，并明确模拟边界。 */
function sendMessage() {
  const value = state.drafts[state.session].trim();
  if (!value) return;
  state.messages[state.session].push({ text: value, reference: state.references[state.session],
    sessions: state.sessionReferences[state.session].map(reference => ({
      ...reference, title: state.titles[reference.id],
    })),
  });
  state.sessionReferences[state.session] = [];
  state.references[state.session] = null;
  state.drafts[state.session] = '';
  render();
  const conversation = document.querySelector(`#conversation-${state.session}`);
  conversation.scrollTop = conversation.scrollHeight;
  focusInput(state.session);
}

/** @brief 接收文件或聊天选区，保留原文来源和当前会话草稿。 */
function askAboutSelection(reference) {
  state.references[state.session] = reference;
  if (reference.fileId) {
    state.fileHighlight = { fileId: reference.fileId, startLine: reference.startLine, endLine: reference.endLine };
    if (window.innerWidth < 800) state.panel = null;
  }
  render();
  focusInput(state.session);
  toast('已引用选中内容，补充问题或修改要求后发送。');
}

/** @brief 打开对应文件；从聊天引用返回时显示原选区位置。 */
function openFile(dataset) {
  state.view = 'chat';
  const session = demoFiles[dataset.fileId].session;
  if (!state.panes.includes(session)) state.panes[state.panes.indexOf(state.session)] = session;
  state.session = session;
  state.fileId = dataset.fileId;
  state.panel = 'files';
  state.fileHighlight = dataset.startLine ? {
    fileId: dataset.fileId, startLine: Number(dataset.startLine), endLine: Number(dataset.endLine),
  } : null;
  render();
  if (dataset.startLine) document.querySelector('.file-line.is-referenced')?.scrollIntoView({ block: 'center' });
}

/** @brief 返回聊天引用的原消息，版本变化时保留原文快照并明确提示。 */
function openChatReference(dataset) {
  switchSession(dataset.session);
  const conversation = document.getElementById(`conversation-${dataset.session}`);
  const message = dataset.source === conversation.id ? conversation
    : conversation.querySelector(`[data-message-id="${CSS.escape(dataset.source)}"]`);
  if (!message) {
    console.error('Referenced chat message is no longer available.', dataset.source);
    toast('Referenced message is unavailable. The original quotation remains in the reference.');
    return;
  }
  message.scrollIntoView({ block: 'center', inline: 'nearest' });
  message.animate([
    { backgroundColor: '#e8f0ff', boxShadow: '0 0 0 7px #e8f0ff' },
    { backgroundColor: 'transparent', boxShadow: '0 0 0 7px transparent' },
  ], { duration: 2400, easing: 'ease-out' });
  if (message.dataset.version !== dataset.version) {
    toast(`原消息已变化；引用保留内容版本 ${dataset.version} 的原文。`);
  }
}

/** @brief 导航到独立页面或打开会话中的工作区。 */
function showView(name) {
  if (name === 'tools' && ['chat', 'project'].includes(state.view)) state.toolProject = currentProject(state);
  if (pageNames[name]) { state.view = name; state.pageDetailsOpen = window.innerWidth >= 800; }
  else { state.view = 'chat'; state.panel = name === 'task' ? 'files' : name; }
  state.poolOpen = false;
  render();
}

/** @brief 在工作回顾内选择原话、回顾或候选，并定位到对应条目。 */
function selectReview(dataset) {
  state.reviewSelection = { kind: dataset.kind, id: dataset.id };
  state.view = 'maintenance';
  state.pageDetailsOpen = true;
  state.poolOpen = false;
  render();
  const item = `${dataset.kind}-${dataset.id}`;
  document.querySelector(`.feature-main [data-review-item="${item}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** @brief 处理本地界面的按钮动作。 */
function handleAction(action, dataset) {
  if (action.startsWith('runtime-')) return handleRuntimeAction(action, dataset);
  if (action === 'new-project') return newProject();
  if (action === 'open-project') return openProject(dataset.project);
  if (action === 'new-chat') return newChat(dataset.project || currentProject(state));
  if (handleSettingsAction(state, action, dataset)) return render();
  if (handleToolsAction(state, action, dataset)) return render();
  if (action === 'review-select') return selectReview(dataset);
  if (action === 'feedback-source') { switchSession(dataset.session); return openFile(dataset); }
  if (action === 'open-file' || action === 'open-reference') return openFile(dataset);
  if (action.startsWith('session-')) return switchSession(action.slice(8));
  if (action === 'close-chat-pane') return closeChatPane(dataset.session);
  if (action === 'open-chat-reference') return openChatReference(dataset);
  if (action === 'remove-session-reference') {
    const references = state.sessionReferences[state.session];
    state.sessionReferences[state.session] = references.filter(ref => ref.id !== dataset.session);
    return render();
  }
  if (action.startsWith('show-')) return showView(action.slice(5));
  const actions = {
    'return-chat': () => switchSession(state.session),
    'close-page-detail': () => { state.pageDetailsOpen = false; render(); },
    'open-page-detail': () => { state.pageDetailsOpen = true; render(); },
    'sidebar': () => { state.collapsed = !state.collapsed; render(); },
    'toggle-pool': () => { state.poolOpen = !state.poolOpen; render(); },
    'pool-all': () => { state.poolFilter = 'all'; render(); },
    'pool-current': () => { state.poolFilter = 'current'; render(); },
    'toggle-panel': () => { state.panel = state.panel ? null : 'files'; render(); },
    'close-panel': () => { state.panel = null; render(); },
    'start-coding': () => switchSession('coding'),
    'start-research': () => switchSession('research'),
    'feedback-message': () => feedbackFor(false),
    'feedback-artifact': () => feedbackFor(true),
    'remove-reference': () => { state.references[state.session] = null; state.fileHighlight = null; render(); },
    'refresh-tools': refreshTools,
    'advance': advance,
    'reset': reset,
    'copy': () => copyReply(dataset),
  };
  if (actions[action]) actions[action]();
}

/** @brief 运行记录只改变当前示例，实际登录、外部操作和定时任务均不执行。 */
function handleRuntimeAction(action, dataset) {
  if (action === 'runtime-select-agent') state.runtimeAgent = dataset.agent;
  if (action === 'runtime-resolve' && !resolveRuntimeScenario(state, dataset.resolution)) return;
  render();
}

/** @brief 按按钮绑定的会话和消息复制对应回复。 */
async function copyReply(dataset) {
  try {
    const conversation = document.getElementById(`conversation-${dataset.session}`);
    const message = conversation.querySelector(`[data-message-id="${CSS.escape(dataset.copySource)}"]`);
    await navigator.clipboard.writeText(message.textContent.trim());
    toast('已复制回复。');
  } catch (error) {
    console.error('Failed to copy reply:', error);
    toast('Copy failed. Select the text and copy it manually.');
  }
}

/** @brief 绑定原生输入和事件委托，避免依赖额外界面运行时。 */
function bindEvents() {
  ['pointerdown', 'focusin'].forEach(name => document.addEventListener(name, event => {
    const pane = event.target.closest('.chat-pane');
    if (pane) activateSession(pane.dataset.chatSession);
  }));
  window.matchMedia('(max-width: 1023px)').addEventListener('change', event => {
    state.collapsed = event.matches;
    if (window.innerWidth < 800) state.panel = null;
    render();
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (button) handleAction(button.dataset.action, button.dataset);
    else if (state.poolOpen && !event.target.closest('.pool-popover')) { state.poolOpen = false; render(); }
  });
  document.addEventListener('input', event => {
    updateSettingsDraft(state, event.target);
    if (event.target.matches('.message-input')) {
      state.drafts[event.target.closest('[data-chat-session]').dataset.chatSession] = event.target.value;
    }
  });
  document.addEventListener('change', event => {
    updateSettingsDraft(state, event.target);
    if (event.target.id === 'tool-project') handleAction('tool-project', { project: event.target.value });
    if (event.target.id === 'pool-state') { state.poolState = event.target.value; render(); }
    if (event.target.id === 'runtime-scenario') {
      selectRuntimeScenario(state, event.target.value);
      render();
    }
  });
  document.addEventListener('submit', event => {
    if (event.target.matches('.user-settings-form')) {
      event.preventDefault(); saveSettings(state); render(); toast('已保存到本次演示，真实用户配置未修改。');
    }
    if (event.target.matches('.composer')) {
      event.preventDefault(); activateSession(event.target.dataset.chatSession); sendMessage();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.poolOpen) { state.poolOpen = false; render(); }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target.matches('.message-input')) {
      event.preventDefault(); sendMessage();
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); }
  });
}

initFeedback({ onSubmit: recordFeedback, onAsk: askAboutSelection });
initSessionActions({ onRename: renameSession, onReference: referenceSession, onSplit: splitSession });
initResize({ onChange: patch => Object.assign(state, patch) });
bindEvents();
render();
