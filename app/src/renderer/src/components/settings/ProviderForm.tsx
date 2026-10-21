// 提供商表单（新建 / Edit，§9.1）：按"Save"保存（models.saveProvider）。新建时另有第一个 key 与第一个模型
// （勾了 Supports thinking 时带它的新会话思考强度），区域随地址预选建议值；
// Edit 时地址的 origin 变了、提供商有 key 时先确认（§4.1）。
// 状态表见 docs/v1/screens/models-settings.md "提供商表单"。

import { useState } from 'react';
import type { ModelProvider, ProviderSaved } from '../../../../shared/models';
import { writeModels } from '../../state/settings';
import { ModelDialog } from './common';
import {
  ApiRow, CompatChecks, emptyModel, emptyProvider, hasErrors, modelErrors, ModelFields, providerErrors,
  providerPatch, shownErrors, TextRow, toModel, toProviderForm, useDraft, ZoneRadios, type ProviderDraft,
} from './fields';

/** @brief 已有提供商的草稿（Edit）：区域是当前值，不自动改。 */
function draftOf(provider: ModelProvider): ProviderDraft {
  return { name: provider.name, baseUrl: provider.baseUrl, api: provider.api, zone: provider.zone, zoneChosen: true,
    concurrency: String(provider.concurrency), compat: provider.compat };
}

/** @brief 地址的 origin（协议、主机、端口）；不是合法 URL 时为 null。 */
function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/** @brief 提供商字段：Name、Address、API type、Network zone、Concurrency per key、兼容选项。 */
function ProviderFields({ form, follow }: { form: ReturnType<typeof useDraft<ProviderDraft>>; follow: boolean }) {
  const { draft, touched, edit } = form;
  const set = (patch: Partial<ProviderDraft>) => edit(providerPatch(draft, patch, follow));
  const errors = shownErrors(providerErrors(draft), touched);
  return (
    <>
      <TextRow label="Name" field="name" error={errors.name} value={draft.name} onChange={(name) => set({ name })} />
      <TextRow label="Address" field="baseUrl" error={errors.baseUrl} value={draft.baseUrl} spellCheck={false}
        placeholder="http://host:8000/v1" onChange={(baseUrl) => set({ baseUrl })} />
      <ApiRow value={draft.api} onChange={(api) => set({ api })} />
      <ZoneRadios value={draft.zone} onChange={(zone) => set({ zone })} />
      <TextRow label="Concurrency per key" field="concurrency" error={errors.concurrency} inputMode="numeric"
        value={draft.concurrency} onChange={(concurrency) => set({ concurrency })} />
      <CompatChecks api={draft.api} value={draft.compat} onChange={(compat) => set({ compat })} />
    </>
  );
}

/** @brief 新建提供商：提供商字段、第一个 key（可空）、第一个模型。 */
function AddProvider({ onClose }: { onClose: () => void }) {
  const form = useDraft(emptyProvider);
  const model = useDraft(emptyModel);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelProblems = modelErrors(model.draft, []);
  const invalid = hasErrors(providerErrors(form.draft)) || hasErrors(modelProblems);
  async function save() {
    setBusy(true);
    const result = await writeModels<ProviderSaved>({ type: 'models.saveProvider', id: null,
      provider: toProviderForm(form.draft), model: toModel(model.draft), ...(secret ? { keySecret: secret } : {}),
      ...(model.draft.reasoning ? { thinkingLevel: model.draft.thinkingLevel } : {}) });
    setBusy(false);
    if (result.error === null) onClose();
    else setError(result.error);
  }
  return (
    <form className="settings-form mf-grid" data-testid="provider-form"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3>Add provider</h3>
      <ProviderFields form={form} follow />
      <h4>First key</h4>
      <TextRow label="API key" field="secret" type="password" autoComplete="off" placeholder="Optional"
        value={secret} onChange={setSecret} />
      <h4>First model</h4>
      <ModelFields draft={model.draft} edit={model.edit} errors={shownErrors(modelProblems, model.touched)}
        editing={false} full thinking />
      <FormButtons busy={busy} invalid={invalid} onClose={onClose} />
      {error && <p className="form-message error" role="alert" data-testid="form-message">{error}</p>}
    </form>
  );
}

/** @brief 表单的 Save 与 Cancel。 */
function FormButtons({ busy, invalid, onClose }: { busy: boolean; invalid: boolean; onClose: () => void }) {
  return (
    <div className="form-actions">
      <button type="submit" className="button primary" disabled={busy || invalid}>Save</button>
      <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  );
}

/** @brief Edit 提供商：不含 key 和模型字段；改了地址的 origin、有 key 时先确认。 */
function EditProvider({ provider, onClose }: { provider: ModelProvider; onClose: () => void }) {
  const form = useDraft(() => draftOf(provider));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const count = provider.keys.length;
  const originChanged = originOf(form.draft.baseUrl) !== originOf(provider.baseUrl);
  async function save() {
    setBusy(true);
    const result = await writeModels<ProviderSaved>({ type: 'models.saveProvider', id: provider.id,
      provider: toProviderForm(form.draft) });
    setBusy(false);
    setConfirming(false);
    if (result.error === null) onClose();
    else setError(result.error);
  }
  const submit = () => (originChanged && count > 0 ? setConfirming(true) : void save());
  return (
    <form className="settings-form mf-grid" data-testid="provider-form"
      onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <h3>Edit provider · {provider.name}</h3>
      <ProviderFields form={form} follow={false} />
      <FormButtons busy={busy} invalid={hasErrors(providerErrors(form.draft))} onClose={onClose} />
      {error && <p className="form-message error" role="alert" data-testid="form-message">{error}</p>}
      {confirming && (
        <ModelDialog testId="confirm-dialog" kind="address-change" title="Change the address?"
          confirmLabel="Save and remove keys" tone="danger" busy={busy} error={null}
          onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
          <p>{`Changing the address removes this provider's ${count} saved keys. Add them again after saving.`}</p>
        </ModelDialog>
      )}
    </form>
  );
}

/** @brief 提供商表单：provider 为 null 时新建。 */
export function ProviderForm({ provider, onClose }: { provider: ModelProvider | null; onClose: () => void }) {
  return provider ? <EditProvider provider={provider} onClose={onClose} /> : <AddProvider onClose={onClose} />;
}
