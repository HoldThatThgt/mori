export const settingsCategories = [
  { id: 'agents', name: 'AGENTS.md', icon: 'file' }, { id: 'skills', name: 'Skill', icon: 'file' },
  { id: 'mcp', name: 'MCP', icon: 'link' }, { id: 'plugins', name: 'Plugin', icon: 'grid' },
  { id: 'models', name: '模型', icon: 'settings' },
];

/** @brief 提供已有用户配置的演示集合，条目身份不随改名改变。 */
export function initialSettings() {
  const userSettings = {
    agents: [{ id: 'user-agents', name: 'AGENTS.md', source: '用户文件', enabled: true,
      description: '在所有项目中使用的工作约定。',
      content: '# 用户级工作约定\n\n先说明结果，再补充必要依据。\n\n保留反馈原话与来源，不把一次纠正扩大成长期偏好。' }],
    skills: [{ id: 'communication', name: '沟通规范', description: '组织进展说明和结果交付。',
      source: '用户自定义', enabled: true,
      content: '先说明当前结果和下一步。\n复杂方案保留关键依据。\n有不确定之处直接说明。' },
    { id: 'notes', name: '整理笔记', description: '将资料中的要点整理为带来源的笔记。',
      source: 'Plugin', pluginId: 'library', enabled: true,
      content: '读取选中的资料。\n提取要点并保留来源。\n区分原文事实和自己的推断。' }],
    mcp: [{ id: 'personal-library', name: '个人资料', description: '搜索个人资料库。',
      source: 'Plugin', pluginId: 'library', endpoint: 'https://mcp.example.invalid/mcp',
      credential: 'PERSONAL_MCP_KEY', enabled: true }],
    plugins: [{ id: 'library', name: '资料助手', description: '提供资料检索和笔记整理能力。',
      source: '本地示例包', version: '1.0.0', enabled: true }],
    models: [{ id: 'intranet', name: '内网模型服务', description: '对话与任务执行共用的模型服务。',
      source: '用户配置', endpoint: 'https://models.example.invalid/v1', protocol: 'chat-completions',
      credential: 'MORI_MODEL_KEY', fast: 'fast-demo', reasoning: 'reasoning-demo', concurrency: 2, enabled: true }],
  };
  const settingsSelection = Object.fromEntries(Object.entries(userSettings).map(([key, items]) => [key, items[0].id]));
  return { settingsCategory: 'agents', userSettings, settingsSelection, settingsDrafts: {}, settingsRemoved: null };
}

/** @brief 为显式新增创建空白草稿，保存之前不进入已有列表。 */
export function newSetting(category) {
  const item = { id: crypto.randomUUID(), name: '', description: '', enabled: true, source: '用户自定义' };
  if (category === 'skills') Object.assign(item, { content: '' });
  if (category === 'mcp') Object.assign(item, { endpoint: '', credential: '' });
  if (category === 'plugins') Object.assign(item, { source: '本地示例包', version: '' });
  if (category === 'models') Object.assign(item, { source: '用户配置', endpoint: '', protocol: 'chat-completions',
    credential: '', fast: '', reasoning: '', concurrency: 1 });
  return item;
}

/** @brief 获取当前选中的已有配置或尚未保存的新条目。 */
export function selectedSetting(state) {
  const category = state.settingsCategory;
  const id = state.settingsSelection[category];
  return state.userSettings[category].find(item => item.id === id) || state.settingsDrafts[id]?.item;
}

/** @brief 查询某一插件提供的能力，保留能力类型以供直接导航。 */
export function pluginContents(state, id) {
  return ['skills', 'mcp'].flatMap(category => state.userSettings[category]
    .filter(item => item.pluginId === id).map(item => ({ category, item })));
}

/** @brief 说明条目的维护来源，插件改名后同步显示来源名称。 */
export function settingSource(state, item) {
  return item.pluginId ? `${state.userSettings.plugins.find(plugin => plugin.id === item.pluginId).name} Plugin`
    : item.source;
}

/** @brief 计算展示状态，配置启用不代表外部连接验证成功。 */
export function settingStatus(state, category, item) {
  if (item.pluginId && !state.userSettings.plugins.find(plugin => plugin.id === item.pluginId).enabled) {
    return '随 Plugin 停用';
  }
  if (!item.enabled) return '已停用';
  if (category === 'mcp') return '未连接';
  if (category === 'models') return '未验证';
  return category === 'agents' ? '已配置' : '已启用';
}
