import { icon } from './icons.js';
import { resizeHandle } from './chat-pane.js';
import { renderToolsPage } from './tools-page.js';
import { renderReviewPage } from './review-page.js';
import { renderSettingsPage } from './settings-page.js';
import { renderProjectPage } from './project-page.js';

export const pageNames = { tools: '工具', maintenance: '工作回顾', settings: '设置', project: '项目' };

/** @brief 在中间主区域展示独立功能，在右侧展示所选项目。 */
export function renderFeaturePage(state) {
  const pages = { tools: renderToolsPage, maintenance: renderReviewPage,
    settings: renderSettingsPage, project: renderProjectPage };
  const page = pages[state.view](state);
  const pageKey = state.view === 'tools' ? `tools-${state.toolProject}-${state.toolCategory}`
    : state.view === 'settings' ? `settings-${state.settingsCategory}`
    : state.view === 'project' ? `project-${state.selectedProject}` : state.view;
  return `<div class="feature-body"><section class="feature-main" data-page="${pageKey}"
    aria-label="${pageNames[state.view]}页面">
    <div class="feature-content">${page.main}${page.detail && !state.pageDetailsOpen
      ? '<button class="button" data-action="open-page-detail">显示所选项目详情</button>' : ''}</div></section>
    ${page.detail && state.pageDetailsOpen ? `<aside class="feature-detail" aria-label="${page.detailTitle}">
      ${resizeHandle('workspace', '调整右侧详情宽度')}<div class="panel-header">${icon('file')}${page.detailTitle}
        <button class="icon-button" data-action="close-page-detail" aria-label="关闭详情">${icon('close')}</button>
      </div><div class="feature-detail-content">${page.detail}</div></aside>` : ''}</div>`;
}
