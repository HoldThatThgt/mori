// 模型表单（只有 Edit，§9.1；docs/specs/model-discovery.md §5.4、§6.5：没有新建，新模型从卡上的 Fetch models 加入）：
// 按"Save"保存（models.saveModel）。Default effort for new sessions 写 pi 设置的 modelThinkingLevels：
// 设过强度的显示 models.get 的 thinkingDefaults 里的值，没设过的显示 config.get 的 defaultThinkingLevel（没有时 Medium）；
// 只有你在这张表单里改了它才发送（没改时不替你写入）。思考关不掉的模型（档案 reasoning.off_refused，规格 §7.7）
// 不列 Off，存着的 Off 显示为 Minimal、照存。状态表见 models-settings.md "模型表单（Edit）"。

import { useState } from 'react';
import type { ModelProvider, ProviderModel } from '../../../../shared/models';
import { useProfile, useSettings, writeModels } from '../../state/settings';
import { useApp } from '../../state/store';
import { hasErrors, modelDraft, ModelFields, shownErrors, sizeErrors, toModel, useDraft, useMounted } from './fields';

/** @brief 模型表单的参数。 */
export interface ModelEditorProps {
  /** 所在的提供商 */
  provider: ModelProvider;
  /** 要改的模型（配置里已有的） */
  model: ProviderModel;
  /** 保存成功或点了 Cancel */
  onClose: () => void;
}

/** @brief 模型表单（Edit）。 */
export function ModelEditor({ provider, model, onClose }: ModelEditorProps) {
  const ref = `${provider.id}/${model.id}`;
  const savedLevel = useSettings((state) => state.info?.thinkingDefaults[ref] ?? null);
  // 拉取规格 §5.4：没设过强度时显示新会话实际用的 defaultThinkingLevel；它也没有时 modelDraft 显示 Medium
  const piLevel = useApp((state) => state.config?.defaultThinkingLevel ?? null);
  const { draft, touched, edit } = useDraft(() => modelDraft(model, savedLevel ?? piLevel));
  // §7.7：按 mori.profiles 里这个模型的档案（重新验证中是旧结果），表单开着时档案变了选项随之变
  const noOff = useProfile(ref).profile?.reasoning.off_refused === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMounted();
  // models-settings.md "模型表单（Edit）"字段错误：界面只查窗口与 Max output；Model ID 只读，不查
  const errors = sizeErrors(draft.contextWindow, draft.maxTokens);
  async function save() {
    // 拉取规格 §5.4：只有你改了 Default effort for new sessions（勾着 Supports thinking 时才显示）才带 thinkingLevel
    const sendLevel = draft.reasoning && touched.has('thinkingLevel');
    setBusy(true);
    const result = await writeModels({ type: 'models.saveModel', providerId: provider.id, model: toModel(draft),
      ...(sendLevel ? { thinkingLevel: draft.thinkingLevel } : {}) });
    setBusy(false);
    // 同一时刻只开一张表单（models-settings.md "卡上的 Fetch models"）：表单已被换掉时不再关，免得关掉换上来的那张
    if (result.error !== null) setError(result.error);
    else if (mounted.current) onClose();
  }
  return (
    <form className="settings-form mf-grid" data-testid="model-form" noValidate
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3>Edit model · {provider.name}</h3>
      <ModelFields draft={draft} edit={edit} errors={shownErrors(errors, touched)} noOff={noOff} />
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={busy || hasErrors(errors)}>Save</button>
        <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {error && <p className="form-message error" role="alert" data-testid="form-message">{error}</p>}
    </form>
  );
}
