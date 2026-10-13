import { escapeHtml } from './feedback.js';

/** @brief 创建具备原生校验的文本配置项。 */
function field(name, label, value, type = 'text') {
  return `<label class="settings-field"><span>${label}</span><input data-settings-field="${name}"
    name="${name}" type="${type}" value="${escapeHtml(value)}" required ${type === 'number' ? 'min="1" step="1"' : ''}>
    </label>`;
}

/** @brief 创建规则或技能正文编辑区。 */
function editor(label, content) {
  return `<label class="settings-field"><span>${label}</span><textarea class="settings-editor"
    data-settings-field="content" name="content" spellcheck="false">${escapeHtml(content)}</textarea></label>`;
}

/** @brief 编辑用户自定义技能，插件技能的正文由所属插件维护。 */
function skillForm(draft) {
  return `${field('name', 'Skill 名称', draft.name)}${field('description', '用途', draft.description)}
    ${editor('Skill 说明', draft.content)}`;
}

/** @brief 编辑 MCP 连接信息，仅接收认证引用名称。 */
function mcpForm(draft) {
  return `${field('name', 'MCP 名称', draft.name)}${field('description', '用途', draft.description)}
    ${field('endpoint', '服务地址 · Streamable HTTP', draft.endpoint, 'url')}
    ${field('credential', '认证引用', draft.credential)}
    <p class="page-secondary">这里只填写凭据名称，不填写密钥正文。</p>`;
}

/** @brief 编辑插件的演示登记信息，不假装安装或更新软件包。 */
function pluginForm(draft) {
  return `${field('name', 'Plugin 名称', draft.name)}${field('description', '用途', draft.description)}
    ${field('version', '版本 · 示例', draft.version)}
    <p class="page-secondary">本页只演示配置维护，不安装或更新实际插件。</p>`;
}

/** @brief 编辑所选模型服务，不为已有服务另建一份配置。 */
function modelsForm(draft) {
  const protocols = [['chat-completions', 'OpenAI Chat Completions'], ['messages', 'Anthropic Messages']];
  return `${field('name', '服务名称', draft.name)}${field('description', '用途', draft.description)}
    ${field('endpoint', '接口地址', draft.endpoint, 'url')}
    <label class="settings-field"><span>接口协议</span><select data-settings-field="protocol" name="protocol">
      ${protocols.map(([value, label]) => `<option value="${value}" ${draft.protocol === value ? 'selected' : ''}>
        ${label}</option>`).join('')}</select></label>${field('credential', '认证引用', draft.credential)}
    ${field('fast', '快速模型 ID', draft.fast)}${field('reasoning', '推理模型 ID', draft.reasoning)}
    ${field('concurrency', '共享并发上限 · 示例值', draft.concurrency, 'number')}`;
}

/** @brief 按当前条目的类型创建维护表单。 */
export function renderSettingsForm(category, draft) {
  if (category === 'agents') return editor('用户级 AGENTS.md', draft.content);
  const forms = { skills: skillForm, mcp: mcpForm, plugins: pluginForm, models: modelsForm };
  return forms[category](draft);
}
