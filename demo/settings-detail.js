import { escapeHtml } from './feedback.js';
import { icon } from './icons.js';
import {
  selectedSetting, settingsCategories, settingSource, settingStatus, pluginContents,
} from './settings-catalog.js';
import { settingsDirty } from './user-settings.js';
import { renderSettingsForm } from './settings-forms.js';

/** @brief 展示已有配置的具体字段，正文保留换行。 */
function configContent(category, item) {
  if (category === 'agents' || category === 'skills') {
    return `<section class="detail-section"><h3>当前内容</h3><pre class="settings-content">${
      escapeHtml(item.content)}</pre></section>`;
  }
  const fields = category === 'mcp' ? [['服务地址', item.endpoint], ['认证引用', item.credential]]
    : category === 'plugins' ? [['版本', item.version]]
    : [['接口地址', item.endpoint], ['接口协议', item.protocol === 'messages' ? 'Anthropic Messages'
      : 'OpenAI Chat Completions'], ['认证引用', item.credential], ['快速模型', item.fast],
    ['推理模型', item.reasoning], ['并发上限', `${item.concurrency} · 示例`]];
  return `<dl class="detail-facts">${fields.map(([label, value]) => `<div><dt>${label}</dt>
    <dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}

/** @brief 从包内能力跳转到其插件，避免孤立维护一份重复配置。 */
function pluginSource(state, item) {
  return item.pluginId ? `<button class="tool-source-link" data-action="settings-open"
    data-category="plugins" data-id="${item.pluginId}">${icon('grid')}
    管理 ${escapeHtml(settingSource(state, item))} ${icon('chevron')}</button>` : '';
}

/** @brief 在插件详情中列出包内能力，并说明统一移除的范围。 */
function includedSettings(state, item) {
  const contents = pluginContents(state, item.id);
  return `<section class="detail-section"><h3>包含的能力 · ${contents.length}</h3>${contents.map(entry => `
    <button class="review-related-link" data-action="settings-open" data-category="${entry.category}"
      data-id="${entry.item.id}">${icon(entry.category === 'mcp' ? 'link' : 'file')}<span>
      <strong>${escapeHtml(entry.item.name)}</strong><small>${entry.category === 'mcp' ? 'MCP' : 'Skill'} ·
      ${settingStatus(state, entry.category, entry.item)}</small></span>${icon('chevron')}</button>`).join('') ||
    '<p>这个示例配置尚未包含能力。</p>'}
    ${contents.length ? '<p>停用会影响包内能力；移除会同时移除上面的能力，可撤销。</p>' : ''}</section>`;
}

/** @brief 仅已有条目显示维护操作，插件提供的技能正文不在外部直接编辑。 */
function maintenanceActions(category, item) {
  const editable = category !== 'skills' || !item.pluginId;
  return `<div class="settings-actions">${editable ? `<button class="button primary" data-action="settings-edit">
    ${category === 'agents' ? '编辑正文' : '编辑配置'}</button>` : ''}
    ${category !== 'agents' ? `<button class="button" data-action="settings-toggle">
      ${item.enabled ? '停用' : '启用'}</button>` : ''}
    ${category !== 'agents' && !item.pluginId ? `<button class="button settings-remove" data-action="settings-remove">
      ${category === 'plugins' ? '移除 Plugin' : '移除配置'}</button>` : ''}</div>`;
}

/** @brief 编辑时明确正在修改已有条目还是新增，取消会放弃当前草稿。 */
function editDetail(state, item) {
  const category = state.settingsCategory;
  const saved = state.userSettings[category].some(entry => entry.id === item.id);
  const name = settingsCategories.find(entry => entry.id === category).name;
  const draft = state.settingsDrafts[item.id].item;
  return `<span class="detail-eyebrow">${saved ? '编辑已有配置' : `新增 ${name}`}</span>
    <h2>${saved ? escapeHtml(item.name) : `新增 ${name}`}</h2>
    <p class="detail-lead">${saved ? '保存后更新当前条目。' : '保存后加入已有列表。'}</p>
    <form class="user-settings-form">${renderSettingsForm(category, draft)}
      <div class="settings-save-bar"><span class="settings-save-status" role="status">
        ${settingsDirty(state) ? '有未保存的修改' : '尚未修改'}</span><div>
        <button type="button" class="button" data-action="settings-cancel">取消编辑</button>
        <button type="submit" class="button primary">${saved ? '保存修改' : '添加到列表'}</button></div></div></form>
    <p class="page-demo-note">仅保存本次演示；切换条目会保留草稿。</p>`;
}

/** @brief 默认展示已有配置详情，通过明确的编辑动作进入表单。 */
export function renderSettingsDetail(state) {
  const item = selectedSetting(state);
  const category = state.settingsCategory;
  if (!item) return '<div class="settings-empty">选中已有配置查看详情，或新增配置。</div>';
  if (state.settingsDrafts[item.id]) return editDetail(state, item);
  return `<span class="detail-eyebrow">已有配置 · 用户级</span><h2>${escapeHtml(item.name)}</h2>
    <p class="detail-lead">${escapeHtml(item.description)}</p>
    <span class="status-tag neutral">${settingStatus(state, category, item)}</span>
    ${maintenanceActions(category, item)}<dl class="detail-facts"><div><dt>来源</dt>
      <dd>${escapeHtml(settingSource(state, item))}</dd></div><div><dt>作用范围</dt><dd>所有项目</dd></div></dl>
    ${pluginSource(state, item)}${configContent(category, item)}
    ${category === 'plugins' ? includedSettings(state, item) : ''}
    ${category === 'skills' && item.pluginId ? '<p class="page-secondary">Skill 正文随所属 Plugin 维护。</p>' : ''}
    ${category === 'models' ? '<button class="button page-full-button" data-action="toggle-pool">查看模型池</button>' : ''}
    <p class="page-demo-note">示例配置 · 未读取本机配置或连接实际服务。</p>`;
}
