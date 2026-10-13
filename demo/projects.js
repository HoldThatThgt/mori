import { escapeHtml } from './feedback.js';
import { icon } from './icons.js';
import { createToolState } from './tool-catalog.js';

/** @brief 项目集合保存在演示状态中，重置时恢复初始项目。 */
export function initialProjects() {
  return { projects: { mori: { name: 'mori', directory: 'D:\\code\\mori' },
    research: { name: '资料研究', directory: '' } }, selectedProject: 'mori' };
}

/** @brief 新项目从空的项目配置开始，共用用户级能力，不复制其他项目的工具。 */
export function createProject(state, project) {
  const id = `project-${crypto.randomUUID()}`;
  state.projects[id] = project;
  state.toolsByProject[id] = createToolState({ skills: {}, mcp: null, plugin: null });
  return id;
}

/** @brief 初始化真实区分项目归属的会话示例，不预建可重复覆盖的新会话。 */
export function initialSessions() {
  const sessionProjects = { coding: 'mori', research: 'research' };
  const entries = Object.keys(sessionProjects);
  return { sessionProjects,
    titles: { coding: '为工具热更新补上版本检查', research: 'MCP 连接更新方案对比' },
    messages: Object.fromEntries(entries.map(id => [id, []])),
    drafts: Object.fromEntries(entries.map(id => [id, ''])),
    references: Object.fromEntries(entries.map(id => [id, null])),
    sessionReferences: Object.fromEntries(entries.map(id => [id, []])),
  };
}

/** @brief 工具页使用所选项目，聊天使用活动会话所属项目。 */
export function currentProject(state) {
  if (state.view === 'project') return state.selectedProject;
  return state.view === 'tools' ? state.toolProject : state.sessionProjects[state.session];
}

/** @brief 创建有独立身份、草稿、消息和引用的新会话，返回其标识。 */
export function createSession(state, project, title) {
  const id = `chat-${crypto.randomUUID()}`;
  state.sessionProjects[id] = project;
  state.titles[id] = title;
  state.messages[id] = [];
  state.drafts[id] = '';
  state.references[id] = null;
  state.sessionReferences[id] = [];
  return id;
}

/** @brief 生成项目选择项，所有入口共用同一项目集合。 */
export function projectOptions(state, selected) {
  return Object.entries(state.projects).map(([id, project]) => `<option value="${id}"
    ${id === selected ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
}

/** @brief 按项目展示每个已有和新增会话，保留改名、引用和分屏入口。 */
export function renderProjectSessions(state) {
  return `<div class="project-sessions"><div class="section-caption">项目</div>${Object.entries(state.projects)
    .map(([id, project]) => `<div class="sidebar-section"><div class="workspace-heading">
      <button class="project-name" data-action="open-project" data-project="${id}"
        title="查看项目 ${escapeHtml(project.name)}">${icon('folder')}<span>${escapeHtml(project.name)}</span></button>
      <button class="icon-button project-new-session" data-action="new-chat" data-project="${id}"
        aria-label="在 ${escapeHtml(project.name)} 中新建会话"
        title="在 ${escapeHtml(project.name)} 中新建会话">${icon('plus')}</button></div>
      ${Object.keys(state.sessionProjects).filter(session => state.sessionProjects[session] === id)
        .map(session => sessionItem(state, session)).join('') ||
        '<span class="project-no-sessions">暂无会话 · 点击 ＋ 开始</span>'}</div>`).join('')}</div>`;
}

/** @brief 通过会话身份生成侧栏入口，新增会话与示例会话使用相同操作。 */
function sessionItem(state, id) {
  const label = escapeHtml(state.titles[id]);
  const running = id === 'research' || (id === 'coding' && !['completed', 'paused'].includes(state.phase));
  return `<button class="session-item ${state.view === 'chat' && state.session === id ? 'active' : ''}"
    data-action="session-${id}" draggable="true" data-session-id="${id}" data-session-title="${label}"
    title="右键改名，拖动引用或分屏"><span class="dot ${running ? '' : 'idle'}"></span>
    <span class="session-label">${label}</span><span class="session-time">${running ? '进行中' : '就绪'}</span></button>`;
}
