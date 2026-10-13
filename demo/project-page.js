import { escapeHtml } from './feedback.js';
import { icon } from './icons.js';

/** @brief 项目创建后展示独立项目页面，明确开始会话和查看工具的入口。 */
export function renderProjectPage(state) {
  const id = state.selectedProject;
  const project = state.projects[id];
  const sessions = Object.keys(state.sessionProjects).filter(session => state.sessionProjects[session] === id);
  const main = `<div class="page-heading"><span class="page-eyebrow">项目</span>
    <h1>${escapeHtml(project.name)}</h1><p>${project.directory ? escapeHtml(project.directory) : '未关联工作目录'}</p>
    </div><div class="project-page-actions"><button class="button primary" data-action="new-chat"
      data-project="${id}">${icon('plus')}新建会话</button><button class="button" data-action="show-tools">
      ${icon('grid')}查看项目工具</button></div><div class="page-section-heading"><h2>会话</h2>
      <span>${sessions.length} 个会话</span></div><div class="page-list">${sessions.map(session => `
      <button class="page-list-row" data-action="session-${session}">${icon('feedback')}
        <span class="list-copy"><strong>${escapeHtml(state.titles[session])}</strong></span>
        ${icon('chevron')}</button>`)
        .join('') || '<p class="settings-empty">项目已准备好，新建会话开始工作。</p>'}</div>
    <p class="page-demo-note">项目和会话仅保存在本次演示中，刷新后恢复示例数据。</p>`;
  return { main, detail: null };
}
