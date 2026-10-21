// Providers：每个提供商一张卡（名称、地址、接口类型、区域、并发上限、兼容选项；Keys 与 Models），
// 卡上 Edit、Delete、Test connection、Add model；节底部 Add provider。表单就地打开（§9.1）。
// 状态表见 docs/v1/screens/models-settings.md "提供商卡"。

import { useState } from 'react';
import { API_TYPE_LABELS, COMPAT_LABELS, type Compat, type ModelProvider } from '../../../../shared/models';
import { testAt } from '../../state/settings';
import { DeleteDialog, TestButton, TestNotice, useDeleteFlow, ZONE_LABELS } from './common';
import { Keys } from './Keys';
import { ModelRows } from './ModelRows';
import { ProviderForm } from './ProviderForm';

/** @brief 开着的表单：提供商（id 为 null 时新建），或某个提供商的模型（modelId 为 null 时新建）。 */
type OpenForm =
  | { kind: 'provider'; id: string | null }
  | { kind: 'model'; providerId: string; modelId: string | null }
  | null;

/** @brief 勾了的兼容选项的英文说明，逗号分隔；没有时"None"。 */
function compatText(compat: Compat): string {
  const fields = Object.keys(compat) as (keyof Compat)[];
  return fields.length ? fields.map((field) => COMPAT_LABELS[field]).join(', ') : 'None';
}

/** @brief 卡头的字段。 */
function ProviderFieldsView({ provider }: { provider: ModelProvider }) {
  return (
    <dl className="provider-fields">
      <dt>Address</dt><dd>{provider.baseUrl}</dd>
      <dt>API type</dt><dd>{API_TYPE_LABELS[provider.api]}</dd>
      <dt>Network zone</dt>
      <dd data-testid="provider-zone" data-zone={provider.zone ?? 'unconfirmed'}>
        {provider.zone ? ZONE_LABELS[provider.zone] : 'Not confirmed'}</dd>
      <dt>Concurrency per key</dt><dd>{provider.concurrency}</dd>
      <dt>Compatibility</dt><dd>{compatText(provider.compat)}</dd>
    </dl>
  );
}

/** @brief 一张提供商卡的参数。 */
interface CardProps {
  /** 提供商 */
  provider: ModelProvider;
  /** 开着的表单 */
  form: OpenForm;
  /** 打开或关闭表单 */
  setForm: (form: OpenForm) => void;
}

/** @brief 一张提供商卡。 */
function ProviderCard({ provider, form, setForm }: CardProps) {
  const flow = useDeleteFlow((dryRun) => ({ type: 'models.deleteProvider', id: provider.id, dryRun }));
  const at = `provider:${provider.id}`;
  const close = () => setForm(null);
  if (form?.kind === 'provider' && form.id === provider.id) return <ProviderForm provider={provider} onClose={close} />;
  const editing = form?.kind === 'model' && form.providerId === provider.id ? form.modelId : undefined;
  return (
    <article className="provider-card" data-testid="provider-card" data-provider={provider.id} tabIndex={-1}>
      <header className="provider-head">
        <div className="provider-info">
          <span className="provider-name">{provider.name}</span>
          <ProviderFieldsView provider={provider} />
        </div>
        <div className="row-actions">
          <button className="button compact" data-action="edit-provider"
            onClick={() => setForm({ kind: 'provider', id: provider.id })}>Edit</button>
          <button className="button compact danger" data-action="delete-provider" onClick={() => void flow.start()}>
            Delete</button>
          <TestButton at={at} label="Test connection" action="test-provider"
            onTest={() => void testAt(at, { providerId: provider.id, modelId: provider.models[0].id })} />
          <button className="button compact" data-action="add-model"
            onClick={() => setForm({ kind: 'model', providerId: provider.id, modelId: null })}>Add model</button>
        </div>
      </header>
      <TestNotice at={at} testId="test-result" />
      <Keys provider={provider} />
      <ModelRows provider={provider} editing={editing} onClose={close}
        onEdit={(modelId) => setForm({ kind: 'model', providerId: provider.id, modelId })} />
      <DeleteDialog flow={flow} kind="delete-provider" title={`Delete provider ${provider.name}?`}
        lead="Its models and keys are deleted too." />
    </article>
  );
}

/** @brief Providers 一节。 */
export function Providers({ providers }: { providers: ModelProvider[] }) {
  const [form, setForm] = useState<OpenForm>(null);
  return (
    <section className="models-block" data-testid="providers">
      <h3>Providers</h3>
      {providers.length === 0 && (
        <p className="settings-empty" data-testid="providers-empty">No providers yet. Add one to start a session.</p>
      )}
      {providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} form={form} setForm={setForm} />
      ))}
      {form?.kind === 'provider' && form.id === null ? (
        <ProviderForm provider={null} onClose={() => setForm(null)} />
      ) : (
        <button className="button" data-action="add-provider" onClick={() => setForm({ kind: 'provider', id: null })}>
          Add provider</button>
      )}
    </section>
  );
}
