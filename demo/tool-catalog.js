import { projectTools } from './project-tools.js';

export const categories = [
  { id: 'skills', name: 'Skill', description: '完成工作的流程和说明', icon: 'file' },
  { id: 'mcp', name: 'MCP', description: '连接外部工具和数据', icon: 'link' },
  { id: 'plugins', name: 'Plugin', description: '一起安装和管理的能力包', icon: 'grid' },
];

/** @brief 每个项目分别保留能力启停、连接进展及详情选择。 */
export function initialTools() {
  const toolsByProject = Object.fromEntries(Object.entries(projectTools).map(([id, catalog]) =>
    [id, createToolState(structuredClone(catalog))]));
  return { toolProject: 'mori', toolCategory: 'skills', toolsByProject };
}

/** @brief 初始化一个项目的独立工具集合，空配置明确表示尚未配置。 */
export function createToolState(catalog) {
  return { ...catalog,
    selection: { skills: Object.keys(catalog.skills)[0] ?? null,
      mcp: catalog.mcp ? 'service' : null, plugins: catalog.plugin ? 'project' : null },
    skillEnabled: Object.fromEntries(Object.keys(catalog.skills).map(skill => [skill, true])),
    pluginEnabled: Boolean(catalog.plugin), stage: 'current',
  };
}

/** @brief 获取所选项目的工具定义及其独立演示状态。 */
export function currentTools(state) {
  return state.toolsByProject[state.toolProject];
}

/** @brief 插件停用只影响本项目包内技能，独立技能保留自身状态。 */
export function skillAvailable(state, id) {
  const tools = currentTools(state);
  return tools.skillEnabled[id] && (!tools.skills[id].plugin || tools.pluginEnabled);
}

/** @brief 返回所选项目的 MCP 演示连接状态，不表示真实服务已经接入。 */
export function connectionState(state) {
  const tools = currentTools(state);
  const stages = {
    current: { label: '连接正常', version: 12, connection: 3, description: '当前连接可以接收新的工具调用。' },
    preparing: { label: '准备新连接', version: 12, connection: 3, description: '暂停新调用，等待新连接初始化。' },
    switching: { label: '切换中', version: 13, connection: 4, description: '新调用使用新连接，旧调用在原连接收尾。' },
    updated: { label: '更新完成', version: 13, connection: 4, description: '新版本已发布，旧调用结束后释放原连接。' },
  };
  const connection = stages[tools.stage];
  return tools.pluginEnabled ? connection : { ...connection, label: '随 Plugin 停用',
    description: `${tools.plugin.name} Plugin 已停用，其提供的 MCP 工具在本次演示中不可用。` };
}

/** @brief 处理工具页项目切换、分类及启停，只改变对应项目的演示状态。 */
export function handleToolsAction(state, action, dataset) {
  const tools = state.toolsByProject[state.toolProject];
  if (action === 'tool-project') {
    state.toolProject = dataset.project;
    state.pageDetailsOpen = window.innerWidth >= 800;
  } else if (action === 'tool-category' || action === 'tool-open') {
    state.toolCategory = dataset.category;
    if (dataset.id) tools.selection[dataset.category] = dataset.id;
    state.pageDetailsOpen = action === 'tool-open' || window.innerWidth >= 800;
  } else if (action === 'tool-toggle-skill') {
    tools.skillEnabled[dataset.id] = !tools.skillEnabled[dataset.id];
  } else if (action === 'tool-toggle-plugin') tools.pluginEnabled = !tools.pluginEnabled;
  else return false;
  return true;
}
