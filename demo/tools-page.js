import { icon } from './icons.js';
import { categories, currentTools, skillAvailable, connectionState } from './tool-catalog.js';
import { projectOptions } from './projects.js';
import { escapeHtml } from './feedback.js';
import { renderToolDetail } from './tool-details.js';
import { renderUserCapability } from './user-capabilities.js';

/** @brief 用用户熟悉的 Skill、MCP 和 Plugin 作为分类入口。 */
function categoryTabs(state) {
  const tools = currentTools(state);
  const counts = { skills: Object.keys(tools.skills).length,
    mcp: Number(Boolean(tools.mcp)), plugins: Number(Boolean(tools.plugin)) };
  return `<div class="tool-categories" aria-label="工具类型">${categories.map(category => `
    <button data-action="tool-category" data-category="${category.id}"
      class="${state.toolCategory === category.id ? 'selected' : ''}"
      aria-pressed="${state.toolCategory === category.id}">${icon(category.icon)}
      <span>${category.name}</span><small>${counts[category.id] + state.userSettings[category.id].length}</small>
      </button>`).join('')}</div>`;
}

/** @brief 每个技能直接说明用途、来源和当前是否可用。 */
function skillList(state) {
  const tools = currentTools(state);
  if (!Object.keys(tools.skills).length) return emptyProjectTools('Skill');
  return `<div class="tool-catalog-list">${Object.entries(tools.skills).map(([id, skill]) => {
    const active = skillAvailable(state, id);
    const status = skill.plugin && !tools.pluginEnabled ? '随 Plugin 停用' : active ? '已启用' : '已停用';
    return `<button class="tool-card ${tools.selection.skills === id ? 'selected' : ''}"
      data-action="tool-open" data-category="skills" data-id="${id}"
      aria-pressed="${tools.selection.skills === id}"><span class="tool-card-top">
        <span class="tool-card-icon">${icon('file')}</span><strong>${skill.name}</strong>
        <span class="status-tag ${active ? '' : 'neutral'}">${status}</span></span>
      <p>${skill.description}</p><span class="tool-card-bottom"><span>${icon(skill.plugin ? 'grid' : 'folder')}
        ${skill.plugin ? `${tools.plugin.name} Plugin` : '项目自定义'}</span>
        <span>查看 Skill ${icon('chevron')}</span></span></button>`;
  }).join('')}</div><p class="page-secondary tool-explanation">Skill 提供工作方法。
    使用过程中需要哪些工具，仍由任务和工具权限决定。</p>`;
}

/** @brief MCP 提供的具体工具直接嵌套在其下，避免与独立分类混淆。 */
function mcpList(state) {
  const tools = currentTools(state);
  if (!tools.mcp) return emptyProjectTools('MCP');
  const selected = tools.selection.mcp;
  const connection = connectionState(state);
  return `<div class="mcp-service"><button class="tool-card ${selected === 'service' ? 'selected' : ''}"
    data-action="tool-open" data-category="mcp" data-id="service" aria-pressed="${selected === 'service'}">
    <span class="tool-card-top"><span class="tool-card-icon">${icon('link')}</span><strong>${tools.mcp.name}</strong>
      <span class="status-tag ${tools.pluginEnabled ? '' : 'neutral'}">${connection.label}</span></span>
    <p>${tools.mcp.description}</p>
    <span class="tool-card-bottom"><span>${icon('grid')}${tools.plugin.name} Plugin</span>
    <span>查看 MCP ${icon('chevron')}</span>
    </span></button><div class="mcp-tool-list"><div class="mcp-tool-caption">这个 MCP 提供的工具</div>
      ${tools.mcp.tools.map(tool => `<button class="page-list-row ${selected === tool.id ? 'selected' : ''}"
        data-action="tool-open" data-category="mcp" data-id="${tool.id}" aria-pressed="${selected === tool.id}">
        <span class="list-icon">${icon(tool.icon)}</span><span class="list-copy"><strong>${tool.name}</strong>
        <span>${tool.description}</span></span><span class="row-meta">${tool.access}</span>${icon('chevron')}
      </button>`).join('')}</div></div>`;
}

/** @brief 插件卡片展示它包含的能力，不把它与 MCP 混为同一种连接。 */
function pluginList(state) {
  const tools = currentTools(state);
  if (!tools.plugin) return emptyProjectTools('Plugin');
  const skill = tools.skills[tools.plugin.skill];
  return `<div class="tool-catalog-list"><button class="tool-card selected" data-action="tool-open"
    data-category="plugins" data-id="project" aria-pressed="true"><span class="tool-card-top">
      <span class="tool-card-icon plugin-icon">${icon('grid')}</span><strong>${tools.plugin.name}</strong>
      <span class="status-tag ${tools.pluginEnabled ? '' : 'neutral'}">${tools.pluginEnabled ? '已启用' : '已停用'}</span>
    </span><p>${tools.plugin.description}</p>
    <span class="plugin-contents"><span>Skill · ${skill.name}</span><span>MCP · ${tools.mcp.name}</span></span>
    <span class="tool-card-bottom"><span>本地示例包 · 1.0.0</span><span>查看 Plugin ${icon('chevron')}</span>
    </span></button></div><div class="page-inline-note">${icon('grid')}<p>Plugin 可以包含 Skill、MCP 等能力。
      从右侧可直接查看它包含的内容；停用后，包内能力一同停用。</p></div>`;
}

/** @brief 空项目明确展示尚未配置，用户级能力继续在下方展示。 */
function emptyProjectTools(category) {
  return `<p class="settings-empty">此项目尚未配置 ${category}。可使用下方来自用户设置的能力。</p>`;
}

/** @brief 输出工具独立页面及当前所选类型的详情。 */
export function renderToolsPage(state) {
  const category = categories.find(item => item.id === state.toolCategory);
  const lists = { skills: skillList, mcp: mcpList, plugins: pluginList };
  const project = state.projects[state.toolProject];
  const main = `<div class="page-heading"><span class="page-eyebrow">项目工具</span>
    <h1>工具</h1><p>选择项目，查看它的 Skill、MCP 与 Plugin。</p>
    <div class="tools-project-row"><label>项目<select id="tool-project" aria-label="查看哪个项目的工具">
      ${projectOptions(state, state.toolProject)}</select></label><button class="button" data-action="new-chat"
      data-project="${state.toolProject}">${icon('plus')}在此项目新建会话</button></div>
    <button class="tool-source-link" data-action="settings-category" data-category="${state.toolCategory}">
      ${icon('settings')}管理用户级配置 ${icon('chevron')}</button></div>${categoryTabs(state)}
    <div class="tool-category-heading"><h2>${category.name}</h2><p>${category.description}</p></div>
    <div class="tool-demo-label">${icon('play')}示例配置 · 启停和连接更新只在本页演示</div>
    <div class="tool-scope-heading"><span>来自项目配置</span><span>${escapeHtml(project.name)}</span></div>
    ${lists[state.toolCategory](state)}${renderUserCapability(state, state.toolCategory)}`;
  return { main, detailTitle: `${category.name} 详情`, detail: renderToolDetail(state) };
}
