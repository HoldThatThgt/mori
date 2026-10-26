// Providers：每个提供商一张卡（名称、地址、接口类型、并发上限、兼容选项（只对 OpenAI-compatible）；Keys 与 Models），
// 卡上 Edit、Delete、Test connection、Fetch models（docs/specs/model-discovery.md §6.5：用已保存的 key 拉取，
// 在卡里 Models 一块的末尾打开清单，按"Add N models"发 models.addModels）；节底部 Add provider。
// 表单就地打开，同一时刻只开一张：提供商表单、模型表单（只有 Edit）或卡上的清单（§9.1、§6.5）。
// 状态表见 docs/v1/screens/models-settings.md "提供商卡""卡上的 Fetch models"。

import { useEffect, useMemo, useState } from 'react';
import {
  API_TYPE_LABELS, COMPAT_LABELS, COMPAT_OPTIONS, type Compat, type DiscoverResult, type ModelProvider,
} from '../../../../shared/models';
import { testAt, writeModels } from '../../state/settings';
import {
  AddFooter, ChecklistView, FetchControls, FetchError, useChecklist, useFetch, type FetchControl,
} from './Checklist';
import { DeleteDialog, TestButton, TestNotice, useDeleteFlow } from './common';
import { Keys } from './Keys';
import { useMounted } from './fields';
import { ModelRows } from './ModelRows';
import { ProviderForm } from './ProviderForm';

/**
 * @brief 开着的表单：提供商（id 为 null 时新建）、某个提供商的模型（Edit）、或某张卡上的清单（Fetch models，§6.5）。
 */
type OpenForm =
  | { kind: 'provider'; id: string | null }
  | { kind: 'model'; providerId: string; modelId: string }
  | { kind: 'fetch'; providerId: string }
  | null;

/** @brief 勾了的兼容选项的标签，逗号分隔，按表单里的顺序；没有时"None"（存着的 supportsStrictMode 没有勾选框，不列）。 */
function compatText(compat: Compat): string {
  const fields = COMPAT_OPTIONS.map((option) => option.field).filter((field) => compat[field] !== undefined);
  return fields.length ? fields.map((field) => COMPAT_LABELS[field]).join(', ') : 'None';
}

/** @brief 卡头的字段。 */
function ProviderFieldsView({ provider }: { provider: ModelProvider }) {
  return (
    <dl className="provider-fields">
      <dt>Base URL</dt><dd>{provider.baseUrl}</dd>
      <dt>API type</dt><dd>{API_TYPE_LABELS[provider.api]}</dd>
      <dt>Concurrency per key</dt><dd>{provider.concurrency}</dd>
      {/* 2026-10-26 负责人走查 M1：兼容选项只对 OpenAI-compatible，同表单（models-settings.md "提供商卡"） */}
      {provider.api === 'openai-completions' && (
        <><dt>Compatibility options</dt><dd data-testid="provider-compat">{compatText(provider.compat)}</dd></>
      )}
    </dl>
  );
}

/** @brief 卡上的清单的参数。 */
interface CardChecklistProps {
  /** 提供商 */
  provider: ModelProvider;
  /** 拉取后的结果 */
  result: DiscoverResult;
  /** 关掉清单（底部 Cancel，或加入成功） */
  onClose: () => void;
}

/**
 * @brief 卡上的清单（§6.5）：清单或列表错误、Not listed、Add a model ID（重复检查含这个提供商已有的全部模型）
 *        与底部；没有 Detected 一行、Name、API type、More settings。Add 发 models.addModels，
 *        成功时清单关闭；失败时清单里原文，配置不变。
 */
function CardChecklist({ provider, result, onClose }: CardChecklistProps) {
  const existing = useMemo(() => provider.models.map((model) => model.id), [provider.models]);
  const list = useChecklist(result, existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMounted();
  async function add() {
    if (busy || list.invalid || list.picked.length === 0) return;
    setBusy(true);
    const outcome = await writeModels({ type: 'models.addModels', providerId: provider.id, models: list.picked });
    setBusy(false);
    // 同一时刻只开一张（models-settings.md "卡上的 Fetch models"）：Adding… 时你打开了别的表单，这张清单已关掉，
    // 加入成功后不再关表单，免得关掉换上来的那张、或因此取消另一张卡上的拉取
    if (outcome.error !== null) setError(outcome.error);
    else if (mounted.current) onClose();
  }
  return (
    <form className="card-checklist mf-grid" noValidate onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <ChecklistView list={list} />
      <AddFooter count={list.picked.length} blocked={list.invalid} busy={busy} onClose={onClose} />
      {error && <p className="form-message error" role="alert" data-testid="form-message">{error}</p>}
    </form>
  );
}

/** @brief 卡头的参数。 */
interface CardHeadProps {
  /** 提供商 */
  provider: ModelProvider;
  /** 卡上的拉取 */
  fetcher: FetchControl;
  /** 卡上的清单开着（Fetch models 不可用，§6.5） */
  listOpen: boolean;
  /** 打开或关闭表单 */
  setForm: (form: OpenForm) => void;
  /** 点了 Delete… */
  onDelete: () => void;
}

/** @brief 卡头：名称与字段；Edit、Delete…、Test connection、Fetch models（取代原来的 Add model，§6.5）。 */
function CardHead({ provider, fetcher, listOpen, setForm, onDelete }: CardHeadProps) {
  const at = `provider:${provider.id}`;
  /** Fetch models：打开这张卡的清单（关掉别的表单），用已保存的 key 拉取（§5.1、§6.5） */
  const fetchModels = () => {
    setForm({ kind: 'fetch', providerId: provider.id });
    void fetcher.start({ kind: 'provider', providerId: provider.id });
  };
  return (
    <header className="provider-head">
      <div className="provider-info">
        <span className="provider-name">{provider.name}</span>
        <ProviderFieldsView provider={provider} />
      </div>
      <div className="row-actions">
        <button className="button compact" data-action="edit-provider"
          onClick={() => setForm({ kind: 'provider', id: provider.id })}>Edit</button>
        <button className="button compact danger" data-action="delete-provider" onClick={onDelete}>Delete…</button>
        <TestButton at={at} label="Test connection" action="test-provider"
          onTest={() => void testAt(at, { providerId: provider.id, modelId: provider.models[0].id })} />
        <FetchControls fetcher={fetcher} disabled={listOpen} compact onFetch={fetchModels} />
      </div>
    </header>
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
  const fetcher = useFetch();
  const open = form?.kind === 'fetch' && form.providerId === provider.id;
  const { close } = fetcher;
  // §6.5：卡上的清单关掉（底部 Cancel、打开别的表单）时丢掉拉取与结果，拉取还在进行就先发 models.discoverCancel，
  // 卡上的按钮旁显示"Fetch cancelled"（models-settings.md "卡上的 Fetch models"已取消一行，useFetch 的 close）
  useEffect(() => {
    if (!open) close();
  }, [open, close]);
  const closeForm = () => setForm(null);
  if (form?.kind === 'provider' && form.id === provider.id) {
    return <ProviderForm provider={provider} onClose={closeForm} />;
  }
  const editing = form?.kind === 'model' && form.providerId === provider.id ? form.modelId : undefined;
  const result = open ? fetcher.result : null;
  return (
    <article className="provider-card" data-testid="provider-card" data-provider={provider.id} tabIndex={-1}>
      <CardHead provider={provider} fetcher={fetcher} listOpen={result !== null} setForm={setForm}
        onDelete={() => void flow.start()} />
      <TestNotice at={`provider:${provider.id}`} testId="test-result" />
      <FetchError fetcher={fetcher} />
      <Keys provider={provider} />
      <ModelRows provider={provider} editing={editing} onClose={closeForm}
        onEdit={(modelId) => setForm({ kind: 'model', providerId: provider.id, modelId })}>
        {result && <CardChecklist provider={provider} result={result} onClose={closeForm} />}
      </ModelRows>
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
