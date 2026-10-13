import { escapeHtml } from './feedback.js';
import { icon } from './icons.js';
import { settingSource, settingStatus } from './settings-catalog.js';

/** @brief 项目工具页引用用户级集合，名称、数量、状态都来自同一份已保存配置。 */
export function renderUserCapability(state, category) {
  return `<div class="tool-scope-heading"><span>来自用户设置</span><span>所有项目</span></div>
    ${state.userSettings[category].map(item => `<button class="tool-card user-capability"
      data-action="settings-open" data-category="${category}" data-id="${item.id}">
      <span class="tool-card-top"><span class="tool-card-icon">${icon('settings')}</span>
        <strong>${escapeHtml(item.name)}</strong><span class="status-tag neutral">
        ${settingStatus(state, category, item)}</span></span><p>${escapeHtml(item.description)}</p>
      <span class="tool-card-bottom"><span>${escapeHtml(settingSource(state, item))}</span>
        <span>在用户设置中管理 ${icon('chevron')}</span></span></button>`).join('') ||
    '<p class="page-secondary">暂无用户级配置。</p>'}`;
}
