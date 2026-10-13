import { icon } from './icons.js';
import { currentTools, skillAvailable, connectionState } from './tool-catalog.js';
import { escapeHtml } from './feedback.js';

/** @brief 从能力的详情返回提供该能力的插件。 */
function pluginSource(state) {
  return `<button class="tool-source-link" data-action="tool-open" data-category="plugins" data-id="project">
    ${icon('grid')}来自${currentTools(state).plugin.name} Plugin ${icon('chevron')}</button>`;
}

/** @brief 展示技能的使用场景与流程，启停只改变当前页面状态。 */
function skillDetail(state) {
  const tools = currentTools(state);
  const id = tools.selection.skills;
  const skill = tools.skills[id];
  const active = skillAvailable(state, id);
  const blocked = skill.plugin && !tools.pluginEnabled;
  return `<span class="detail-eyebrow">Skill · 示例</span><h2>${skill.name}</h2>
    <p class="detail-lead">${skill.description}</p>
    <span class="status-tag ${active ? '' : 'neutral'}">${blocked ? '随 Plugin 停用' : active ? '已启用' : '已停用'}</span>
    <dl class="detail-facts"><div><dt>所属项目</dt><dd>${escapeHtml(state.projects[state.toolProject].name)}</dd></div>
      <div><dt>Skill 名称</dt><dd><code>${skill.command}</code></dd></div>
      <div><dt>来源</dt><dd>${skill.plugin ? `${tools.plugin.name} Plugin` : '项目自定义'}</dd></div></dl>
    ${skill.plugin ? pluginSource(state) : '<p class="page-secondary">此 Skill 独立维护，不属于 Plugin。</p>'}
    <section class="detail-section"><h3>什么时候使用</h3><p>${skill.trigger}</p></section>
    <section class="detail-section"><h3>工作流程</h3><ul class="detail-checks">
      ${skill.steps.map(step => `<li>${icon('check')}<span>${step}</span></li>`).join('')}</ul></section>
    <button class="button page-full-button" data-action="tool-toggle-skill" data-id="${id}"
      ${blocked ? 'disabled' : ''}>${icon(active ? 'pause' : 'play')}${active ? '停用 Skill' : '启用 Skill'}</button>
    <p class="page-demo-note">${blocked ? '先启用所属 Plugin，才能使用这个 Skill。' : '启停仅演示可用状态。'}
      当前不会加载真实 Skill 或调用模型。</p>`;
}

/** @brief 把连接更新及其作用范围放在 MCP 详情中。 */
function mcpDetail(state) {
  const tools = currentTools(state);
  const connection = connectionState(state);
  const busy = ['preparing', 'switching'].includes(tools.stage);
  const position = { current: -1, preparing: 0, switching: 1, updated: 2 }[tools.stage];
  return `<span class="detail-eyebrow">MCP · 示例</span><h2>${tools.mcp.name}</h2>
    <p class="detail-lead">${connection.description}</p>
    <span class="status-tag ${tools.pluginEnabled ? '' : 'neutral'}">${connection.label}</span>
    <dl class="detail-facts"><div><dt>所属项目</dt><dd>${escapeHtml(state.projects[state.toolProject].name)}</dd></div>
      <div><dt>可用范围</dt><dd><code>${tools.mcp.scope}</code></dd></div>
      <div><dt>提供工具</dt><dd>${tools.mcp.tools.map(tool => tool.name).join('、')}</dd></div>
      <div><dt>工具版本</dt><dd>${connection.version}</dd></div>
      <div><dt>连接版本</dt><dd>${connection.connection}</dd></div></dl>${pluginSource(state)}
    <section class="detail-section"><h3>更新 MCP 连接</h3><div class="connection-steps">
      ${['准备', '切换', '完成'].map((label, index) => `<span class="${index <= position ? 'done' : ''}">
        <i></i>${label}</span>`).join('')}</div>
      <p>新连接准备完成后才接管新调用。旧调用的结果仍留在原任务和原版本中。</p>
      <button class="button primary page-full-button" data-action="refresh-tools"
        ${busy || !tools.pluginEnabled ? 'disabled' : ''}>
        ${icon('refresh')}${busy ? '正在更新…' : '演示连接更新'}</button></section>
    <p class="page-demo-note">${!tools.pluginEnabled ? '先启用所属 Plugin，才能使用这个 MCP。' : ''}
      此处仅演示连接状态，没有接入真实 MCP。</p>`;
}

/** @brief 从 MCP 工具查看用途和权限，并返回所属 MCP。 */
function mcpToolDetail(state) {
  const tools = currentTools(state);
  const tool = tools.mcp.tools.find(item => item.id === tools.selection.mcp);
  return `<span class="detail-eyebrow">MCP 提供的工具 · 示例</span><h2>${tool.name}</h2>
    <p class="detail-lead">${tool.description}。</p>
    ${tools.pluginEnabled ? '' : '<span class="status-tag neutral">随 Plugin 停用</span>'}
    <dl class="detail-facts"><div><dt>所属项目</dt><dd>${escapeHtml(state.projects[state.toolProject].name)}</dd></div>
      <div><dt>所属 MCP</dt><dd>${tools.mcp.name}</dd></div>
      <div><dt>可用范围</dt><dd><code>${tools.mcp.scope}</code></dd></div>
      <div><dt>操作权限</dt><dd>${tool.access}</dd></div></dl>
    <section class="detail-section"><h3>使用方式</h3><p>${tool.id === 'write'
      ? '在会话中提出修改要求。执行前核对任务约束、文件范围和工具版本，结果回到任务与文件工作区。'
      : '在会话中提出需要查看或搜索的内容，Mori 在当前项目范围内调用工具，并保留来源。'}</p></section>
    <button class="button page-full-button" data-action="tool-open" data-category="mcp" data-id="service">
      ${icon('link')}查看所属 MCP</button><p class="page-demo-note">当前未连接真实 MCP，不会执行文件操作。</p>`;
}

/** @brief 插件的详情显示完整包含关系及停用的实际影响。 */
function pluginDetail(state) {
  const tools = currentTools(state);
  const skill = tools.skills[tools.plugin.skill];
  const busy = ['preparing', 'switching'].includes(tools.stage);
  return `<span class="detail-eyebrow">Plugin · 示例</span><h2>${tools.plugin.name}</h2>
    <p class="detail-lead">${tools.plugin.description}</p>
    <span class="status-tag ${tools.pluginEnabled ? '' : 'neutral'}">${tools.pluginEnabled ? '已启用' : '已停用'}</span>
    <dl class="detail-facts"><div><dt>所属项目</dt><dd>${escapeHtml(state.projects[state.toolProject].name)}</dd></div>
      <div><dt>版本</dt><dd>1.0.0</dd></div><div><dt>来源</dt><dd>本地示例包</dd></div></dl>
    <section class="detail-section"><h3>包含的内容</h3><div class="plugin-component-list">
      <button data-action="tool-open" data-category="skills" data-id="${tools.plugin.skill}">${icon('file')}
        <span><strong>${skill.name}</strong>
        <small>Skill · ${skillAvailable(state, tools.plugin.skill) ? '已启用' : '已停用'}</small></span>
        ${icon('chevron')}</button>
      <button data-action="tool-open" data-category="mcp" data-id="service">${icon('link')}
        <span><strong>${tools.mcp.name}</strong><small>MCP · ${connectionState(state).label}</small></span>
        ${icon('chevron')}</button></div></section>
    <div class="plugin-impact">${icon('grid')}<p>停用此 Plugin 后，${skill.name} Skill 和 ${tools.mcp.name} MCP 都会停用。
      其他项目、用户级能力和本项目独立维护的 Skill 不受影响。</p></div>
    <button class="button page-full-button" data-action="tool-toggle-plugin" ${busy ? 'disabled' : ''}>
      ${icon(tools.pluginEnabled ? 'pause' : 'play')}${tools.pluginEnabled ? '停用 Plugin' : '启用 Plugin'}</button>
    <p class="page-demo-note">${busy ? 'MCP 连接演示更新中，完成后可停用 Plugin。' : ''}
      此操作只改变本页示例状态，不会安装、停用或卸载真实 Plugin。</p>`;
}

/** @brief 根据明确的工具类型返回对应详情。 */
export function renderToolDetail(state) {
  if (!currentTools(state).selection[state.toolCategory]) return null;
  if (state.toolCategory === 'skills') return skillDetail(state);
  if (state.toolCategory === 'plugins') return pluginDetail(state);
  return currentTools(state).selection.mcp === 'service' ? mcpDetail(state) : mcpToolDetail(state);
}
