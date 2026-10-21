// 模型表单（新建 / Edit，§9.1）：按"Save"保存（models.saveModel）。New-session thinking level 写 pi 设置的
// modelThinkingLevels，Edit 时显示 models.get 的 thinkingDefaults 里保存的值；Edit 时只有你改过它或刚勾上
// Supports thinking 才发送（没设过时不替你写入）。状态表见 models-settings.md "模型表单"。

import { useState } from 'react';
import type { ModelProvider, ProviderModel } from '../../../../shared/models';
import { useSettings, writeModels } from '../../state/settings';
import {
  emptyModel, hasErrors, modelDraft, modelErrors, ModelFields, shownErrors, toModel, useDraft,
} from './fields';

/** @brief 模型表单的参数。 */
export interface ModelEditorProps {
  /** 所在的提供商 */
  provider: ModelProvider;
  /** 要改的模型；新建时为 null */
  model: ProviderModel | null;
  /** 保存成功或点了 Cancel */
  onClose: () => void;
}

/** @brief 模型表单。 */
export function ModelEditor({ provider, model, onClose }: ModelEditorProps) {
  const savedLevel = useSettings((state) => (model ? state.info?.thinkingDefaults[`${provider.id}/${model.id}`] ?? null
    : null));
  const { draft, touched, edit } = useDraft(() => (model ? modelDraft(model, savedLevel) : emptyModel()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adding = model === null;
  const others = adding ? provider.models.map((item) => item.id) : [];
  const errors = modelErrors(draft, others);
  async function save() {
    const sendLevel = draft.reasoning && (adding || touched.has('thinkingLevel') || touched.has('reasoning'));
    setBusy(true);
    const result = await writeModels({ type: 'models.saveModel', providerId: provider.id, model: toModel(draft),
      adding, ...(sendLevel ? { thinkingLevel: draft.thinkingLevel } : {}) });
    setBusy(false);
    if (result.error === null) onClose();
    else setError(result.error);
  }
  return (
    <form className="settings-form mf-grid" data-testid="model-form"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3>{adding ? 'Add model' : 'Edit model'} · {provider.name}</h3>
      <ModelFields draft={draft} edit={edit} errors={shownErrors(errors, touched)} editing={!adding} full thinking />
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={busy || hasErrors(errors)}>Save</button>
        <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {error && <p className="form-message error" role="alert" data-testid="form-message">{error}</p>}
    </form>
  );
}
