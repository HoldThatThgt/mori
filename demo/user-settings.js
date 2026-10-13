import { initialSettings, newSetting, selectedSetting, pluginContents } from './settings-catalog.js';
export { initialSettings };

/** @brief 判断所选条目的草稿是否不同于已有配置。 */
export function settingsDirty(state, id = state.settingsSelection[state.settingsCategory]) {
  const draft = state.settingsDrafts[id];
  if (!draft) return false;
  const saved = state.userSettings[draft.category].find(item => item.id === id);
  return JSON.stringify(saved) !== JSON.stringify(draft.item);
}

/** @brief 编辑时只更新当前条目的草稿，不重绘输入中的内容。 */
export function updateSettingsDraft(state, element) {
  if (!element.matches('[data-settings-field]')) return;
  const id = state.settingsSelection[state.settingsCategory];
  const value = element.type === 'checkbox' ? element.checked
    : element.type === 'number' ? Number(element.value) : element.value;
  state.settingsDrafts[id].item[element.dataset.settingsField] = value;
  document.querySelector('.settings-save-status').textContent = settingsDirty(state) ? '有未保存的修改' : '尚未修改';
}

/** @brief 保存所选条目，新增和修改共用同一集合，保存后返回详情。 */
export function saveSettings(state) {
  const category = state.settingsCategory;
  const id = state.settingsSelection[category];
  const item = structuredClone(state.settingsDrafts[id].item);
  const index = state.userSettings[category].findIndex(entry => entry.id === id);
  if (index === -1) state.userSettings[category].push(item);
  else state.userSettings[category][index] = item;
  delete state.settingsDrafts[id];
}

/** @brief 显式进入新增或编辑状态，保留各条目尚未保存的草稿。 */
function editSetting(state, create) {
  const category = state.settingsCategory;
  const pending = Object.values(state.settingsDrafts).find(draft => draft.category === category &&
    !state.userSettings[category].some(item => item.id === draft.item.id));
  const item = create ? pending?.item || newSetting(category) : selectedSetting(state);
  state.settingsSelection[category] = item.id;
  if (!state.settingsDrafts[item.id]) {
    state.settingsDrafts[item.id] = { category, item: structuredClone(item) };
  }
  state.pageDetailsOpen = true;
}

/** @brief 取消所选条目草稿，取消新增后重新显示已有条目。 */
function cancelSetting(state) {
  const category = state.settingsCategory;
  const id = state.settingsSelection[category];
  delete state.settingsDrafts[id];
  if (!state.userSettings[category].some(item => item.id === id)) {
    state.settingsSelection[category] = state.userSettings[category][0]?.id || null;
  }
}

/** @brief 移除配置并保留一次撤销；移除插件时连同包内能力一起移除。 */
function removeSetting(state) {
  const category = state.settingsCategory;
  const item = selectedSetting(state);
  const affected = [{ category, item }, ...(category === 'plugins' ? pluginContents(state, item.id) : [])];
  const entries = affected.map(entry => ({ ...entry,
    index: state.userSettings[entry.category].findIndex(saved => saved.id === entry.item.id),
    draft: state.settingsDrafts[entry.item.id] }));
  state.settingsRemoved = { name: item.name, category, id: item.id, entries };
  for (const entry of entries) {
    state.userSettings[entry.category] = state.userSettings[entry.category].filter(saved => saved.id !== entry.item.id);
    delete state.settingsDrafts[entry.item.id];
    if (state.settingsSelection[entry.category] === entry.item.id) {
      state.settingsSelection[entry.category] = state.userSettings[entry.category][0]?.id || null;
    }
  }
}

/** @brief 撤销最近一次移除，仅恢复被移除的条目，不覆盖后续其他修改。 */
function restoreSetting(state) {
  const removed = state.settingsRemoved;
  for (const entry of removed.entries) {
    state.userSettings[entry.category].splice(entry.index, 0, entry.item);
    if (entry.draft) state.settingsDrafts[entry.item.id] = entry.draft;
  }
  state.settingsCategory = removed.category;
  state.settingsSelection[removed.category] = removed.id;
  state.settingsRemoved = null;
  state.pageDetailsOpen = true;
}

/** @brief 导航到分类或指定条目，列表选择与草稿分别保存。 */
function openSetting(state, dataset) {
  state.settingsCategory = dataset.category;
  state.view = 'settings';
  state.poolOpen = false;
  if (dataset.id) state.settingsSelection[dataset.category] = dataset.id;
  state.pageDetailsOpen = Boolean(dataset.id) || window.innerWidth >= 800;
}

/** @brief 处理条目查看、编辑、启停和移除，仅改变当前页面演示数据。 */
export function handleSettingsAction(state, action, dataset) {
  if (action === 'settings-category' || action === 'settings-open') openSetting(state, dataset);
  else if (action === 'settings-edit' || action === 'settings-new') editSetting(state, action === 'settings-new');
  else if (action === 'settings-cancel') cancelSetting(state);
  else if (action === 'settings-remove') removeSetting(state);
  else if (action === 'settings-restore') restoreSetting(state);
  else if (action === 'settings-toggle') {
    const item = selectedSetting(state);
    item.enabled = !item.enabled;
  } else return false;
  return true;
}
