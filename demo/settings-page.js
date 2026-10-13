import { icon } from './icons.js';
import { escapeHtml } from './feedback.js';
import { settingsCategories, settingSource, settingStatus } from './settings-catalog.js';
import { settingsDirty } from './user-settings.js';
import { renderSettingsDetail } from './settings-detail.js';

/** @brief 分类入口同时展示已有数量，新增入口与已有列表分开。 */
function categoryTabs(state) {
  return `<nav class="settings-categories" aria-label="用户设置分类">${settingsCategories.map(category => `
    <button data-action="settings-category" data-category="${category.id}"
      class="${category.id === state.settingsCategory ? 'selected' : ''}"
      aria-pressed="${category.id === state.settingsCategory}">${category.name}
      <small>${state.userSettings[category.id].length}</small></button>`).join('')}</nav>`;
}

/** @brief 已有条目展示状态、来源与维护入口，不把编辑表单当成列表。 */
function settingRow(state, item) {
  const category = state.settingsCategory;
  const status = settingStatus(state, category, item);
  const selected = state.settingsSelection[category] === item.id;
  return `<button class="setting-row ${selected ? 'selected' : ''}" data-action="settings-open"
    data-category="${category}" data-id="${item.id}" aria-pressed="${selected}">
    <span class="setting-row-heading"><strong>${escapeHtml(item.name)}</strong>
      <span class="status-tag ${status === '已启用' || status === '已配置' ? '' : 'neutral'}">${status}</span></span>
    <span class="setting-row-description">${escapeHtml(item.description)}</span>
    <span class="setting-row-meta"><span>${escapeHtml(settingSource(state, item))}
      ${item.version ? ` · ${escapeHtml(item.version)}` : ''}</span>
      <span>${settingsDirty(state, item.id) ? '有未保存的修改' : '查看与管理'} ${icon('chevron')}</span></span></button>`;
}

/** @brief 展示未保存的新条目入口和最近一次移除的撤销入口。 */
function pendingNotices(state) {
  const category = state.settingsCategory;
  const pending = Object.values(state.settingsDrafts).find(draft => draft.category === category &&
    !state.userSettings[category].some(item => item.id === draft.item.id));
  const removed = state.settingsRemoved;
  return `${pending ? `<button class="settings-pending" data-action="settings-open"
    data-category="${category}" data-id="${pending.item.id}">未保存的新配置 · 继续编辑 ${icon('chevron')}</button>` : ''}
    ${removed ? `<div class="settings-removed" role="status"><span>已移除 ${escapeHtml(removed.name)}
    ${removed.entries.length > 1 ? '及包内能力' : ''}</span><button data-action="settings-restore">撤销移除</button>
    </div>` : ''}`;
}

/** @brief 设置主页优先呈现已有配置，支持逐条查看和独立新增。 */
function settingsMain(state) {
  const category = settingsCategories.find(entry => entry.id === state.settingsCategory);
  const items = state.userSettings[category.id];
  return `<div class="page-heading"><span class="page-eyebrow">用户级 · 所有项目</span><h1>设置</h1>
    <p>查看已有配置，选中条目后维护。</p></div>${categoryTabs(state)}
    <div class="settings-list-heading"><div><h2>${category.id === 'agents' ? '现有文件' : `已有 ${category.name}`}</h2>
      <span>${items.length} ${category.id === 'agents' ? '个文件' : '个配置'}</span></div>
      ${category.id !== 'agents' ? `<button class="button" data-action="settings-new">
        ${icon('plus')}新增 ${category.name}</button>` : ''}</div>
    <div class="settings-list">${items.map(item => settingRow(state, item)).join('') ||
      '<div class="settings-empty">还没有配置，可以从上方新增。</div>'}</div>${pendingNotices(state)}
    <div class="settings-scope-note">${icon('settings')}<p>这里维护的配置供所有项目使用。
      项目自己的配置在项目内维护。</p></div>
    <p class="page-demo-note">列表为已有配置的演示数据；修改仅保留在本次页面中，刷新后恢复。</p>`;
}

/** @brief 中间列出已有配置，右侧查看详情，并在明确编辑后显示表单。 */
export function renderSettingsPage(state) {
  const category = settingsCategories.find(entry => entry.id === state.settingsCategory);
  return { main: settingsMain(state), detailTitle: `${category.name} 详情`, detail: renderSettingsDetail(state) };
}
