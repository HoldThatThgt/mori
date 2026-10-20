// 添加模型 / 编辑模型（docs/v0/screens/settings.md）：用所在连接的地址和 key，没有 key 框，保存不改 credentials.json。

import { useState } from 'react';
import {
  ModelFormSchema, type ConnectionInfo, type ModelForm as ModelFields, type ModelInfo,
} from '../../../shared/protocol';
import { describe } from '../state/bridge';
import { SAVED_NOTICE, saveModel, showView, type Notice } from '../state/settings';
import { useApp } from '../state/store';
import { defaultLevel, levelOptions, modelFields, ThinkingFields, validate } from './ConnectionForm';
import { connectionButton, modelButton } from './ConnectionsList';

/** @brief 保存前的检查：必填项，添加时 ID 不能与这个连接下已有的模型相同；通过时返回 null。 */
function problemOf(fields: ModelFields, connection: ConnectionInfo, adding: boolean): string | null {
  const problem = validate(ModelFormSchema, fields);
  if (problem) return problem;
  const id = fields.modelId.trim();
  return adding && connection.models.some((item) => item.id === id) ? `保存失败：这个连接下已经有模型 ${id}` : null;
}

/**
 * @brief 回到列表时焦点去的按钮：这个模型的"编辑"（编辑时、保存过之后）；添加时没保存就取消，去这个连接的"添加模型"。
 * @param modelId 模型 ID；列表里还没有这个模型时为 null
 */
function returnFocus(providerId: string, modelId: string | null): string {
  return modelId === null ? connectionButton(providerId, 'add-model') : modelButton(`${providerId}/${modelId}`, 'edit');
}

/** @brief 表单状态与保存：保存成功回到列表；pi 报告配置错误时留在表单里显示原文（模型已经写入，之后按编辑保存）。 */
function useModelForm(connection: ConnectionInfo, model: ModelInfo | undefined) {
  const level = useApp((state) => defaultLevel(state.config));
  const [fields, setFields] = useState<ModelFields>(() => modelFields(model, level));
  const [adding, setAdding] = useState(!model);
  const [saving, setSaving] = useState(false);
  const [everSaved, setEverSaved] = useState(false);
  const [message, setMessage] = useState<Notice | null>(null);
  const edit = (patch: Partial<ModelFields>) => setFields((current) => ({ ...current, ...patch }));
  async function save() {
    const problem = problemOf(fields, connection, adding);
    if (problem) {
      setMessage({ tone: 'error', text: problem });
      return;
    }
    setSaving(true);
    try {
      const result = await saveModel(connection.providerId, fields, adding);
      setAdding(false);
      setEverSaved(true);
      const focus = returnFocus(connection.providerId, fields.modelId.trim());
      if (!result.error) showView({ kind: 'list', focus }, { tone: 'ok', text: SAVED_NOTICE });
      else setMessage({ tone: 'error', text: `已保存，但配置有错误：${result.error}` });
    } catch (error) {
      setMessage({ tone: 'error', text: `保存失败：${describe('model.save', error)}` });
    } finally {
      setSaving(false);
    }
  }
  return { fields, edit, adding, saving, everSaved, message, save };
}

/** @brief 添加（model 为 undefined）或编辑连接下的一个模型；编辑时模型 ID 只读。 */
export function ModelForm({ connection, model }: { connection: ConnectionInfo; model: ModelInfo | undefined }) {
  const { fields, edit, adding, saving, everSaved, message, save } = useModelForm(connection, model);
  const focus = returnFocus(connection.providerId, adding ? null : fields.modelId.trim());
  const close = () => showView({ kind: 'list', focus }, everSaved ? { tone: 'ok', text: SAVED_NOTICE } : null);
  return (
    <form className="connection-form model-form" data-testid="model-form"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>模型 ID
        <input value={fields.modelId} readOnly={!adding} onChange={(e) => edit({ modelId: e.target.value })}
          placeholder="qwen3-coder" />
      </label>
      {!adding && <p className="field-hint field-indent">要换模型 ID，删掉这个模型再添加</p>}
      <label>上下文长度
        <input type="number" min={1} value={fields.contextWindow}
          onChange={(e) => edit({ contextWindow: Number(e.target.value) })} />
      </label>
      <ThinkingFields reasoning={fields.reasoning} level={fields.thinkingLevel} levels={levelOptions(model)}
        onChange={edit} />
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        <button type="button" className="button" disabled={saving} onClick={close}>{everSaved ? '返回列表' : '取消'}</button>
      </div>
      {message && (
        <p className={`form-message ${message.tone}`} role="status" data-testid="form-message">{message.text}</p>
      )}
    </form>
  );
}
