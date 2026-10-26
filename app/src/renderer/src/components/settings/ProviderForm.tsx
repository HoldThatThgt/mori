// 提供商表单。Add provider（docs/specs/model-discovery.md §6.1）：先填 Base URL 和 API key，Fetch models 之后预填
// Name、API type，在清单里勾选模型，按"Add N models"一次加入（models.saveProvider 带 models）；
// 关闭表单时拉取还在进行就先发 models.discoverCancel（清单的状态与视图在 Checklist.tsx）。
// Edit（§9.1，不变）：按"Save"保存；地址的 origin 变了、提供商有 key 时先确认（§4.1）。
// 状态表见 docs/v1/screens/models-settings.md "提供商表单：Add provider""提供商表单：Edit"。

import { useState } from 'react';
import {
  addressChangeText, type DiscoverResult, type ModelProvider, type ProviderSaved,
} from '../../../../shared/models';
import { writeModels } from '../../state/settings';
import {
  AddFooter, BaseUrlNote, ChecklistView, DetectedLine, FetchRow, MoreSettings, useChecklist, useNewFetch,
} from './Checklist';
import { ModelDialog } from './common';
import {
  ApiRow, CompatChecks, emptyProvider, hasErrors, originOf, providerErrors, shownErrors, TextRow, toProviderForm,
  useDraft, useMounted, type DraftForm, type ProviderDraft,
} from './fields';

/** 新提供商还没有模型：Add a model ID 只和清单里的行比重复（§6.4） */
const NO_MODELS: readonly string[] = [];

/** @brief 已有提供商的草稿（Edit）。 */
function draftOf(provider: ModelProvider): ProviderDraft {
  return { name: provider.name, baseUrl: provider.baseUrl, api: provider.api, concurrency: String(provider.concurrency),
    compat: provider.compat };
}

/** @brief Edit 的字段：Name、Base URL、API type、Concurrency per key、兼容选项。 */
function ProviderFields({ form }: { form: DraftForm<ProviderDraft> }) {
  const { draft, touched, edit } = form;
  const errors = shownErrors(providerErrors(draft), touched);
  return (
    <>
      <TextRow label="Name" field="name" error={errors.name} value={draft.name} onChange={(name) => edit({ name })} />
      <TextRow label="Base URL" field="baseUrl" error={errors.baseUrl} value={draft.baseUrl} spellCheck={false}
        placeholder="http://host:8000/v1" onChange={(baseUrl) => edit({ baseUrl })} />
      <ApiRow value={draft.api} onChange={(api) => edit({ api })} />
      <TextRow label="Concurrency per key" field="concurrency" error={errors.concurrency} inputMode="numeric"
        value={draft.concurrency} onChange={(concurrency) => edit({ concurrency })} />
      <CompatChecks api={draft.api} value={draft.compat} onChange={(compat) => edit({ compat })} />
    </>
  );
}

/**
 * @brief Add provider 的状态（§6.1）：草稿、API key 框、拉取、清单与保存。
 * @param onClose 关闭表单（保存成功或 Cancel）
 */
function useAddProvider(onClose: () => void) {
  const form = useDraft(emptyProvider);
  const [secret, setSecret] = useState('');
  const fetcher = useNewFetch(form);
  const list = useChecklist(fetcher.result, NO_MODELS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMounted();
  const errors = providerErrors(form.draft);
  /** Add 不可用（§6.1、§6.2）：Name、Concurrency per key 等字段有错误，或勾选的行有错误 */
  const blocked = hasErrors(errors) || list.invalid;
  /** 改了 Base URL 或 API key：清单、列表错误、手填的行、Detected 与说明都清掉，回到开始（§6.1） */
  const restart = () => {
    fetcher.reset();
    setError(null);
  };
  const setBaseUrl = (baseUrl: string) => {
    form.edit({ baseUrl });
    restart();
  };
  const changeSecret = (value: string) => {
    setSecret(value);
    restart();
  };
  /** Fetch models（第一次或再拉一次）：API key 框为空时不带 key（§5.1） */
  const fetchModels = () => {
    setError(null);
    void fetcher.run(secret || null);
  };
  /** Add（§6.1）：models.saveProvider，models 为勾选的行（按清单顺序，含过滤框藏起来的），key 框为空时不带 */
  async function save() {
    if (busy || !fetcher.result || blocked || list.picked.length === 0) return;
    setBusy(true);
    const result = await writeModels<ProviderSaved>({ type: 'models.saveProvider', id: null,
      provider: toProviderForm(form.draft), models: list.picked, ...(secret ? { keySecret: secret } : {}) });
    setBusy(false);
    // 同一时刻只开一张表单（models-settings.md "卡上的 Fetch models"）：表单已被换掉（或关了又重开）时不再关，
    // 免得关掉换上来的那张、或因此取消那张卡上的拉取
    if (result.error !== null) setError(result.error);
    else if (mounted.current) onClose();
  }
  return { form, secret, fetcher, list, busy, error, errors, blocked, onClose, setBaseUrl, changeSecret,
    fetchModels, save };
}

/** @brief Add provider 的状态与操作。 */
type AddProviderState = ReturnType<typeof useAddProvider>;

/**
 * @brief 拉取后（§6.1 第 2–8 项）：Detected、Base URL 的说明、Name、API type、清单或列表错误、
 *        Add a model ID、More settings（Concurrency per key 与兼容选项）、探针代价的说明、Add 与 Cancel。
 */
function AfterFetch({ add, result }: { add: AddProviderState; result: DiscoverResult }) {
  const { form, fetcher, list } = add;
  const { draft, edit: set } = form;
  const errors = shownErrors(add.errors, form.touched);
  return (
    <>
      <DetectedLine result={result} />
      {fetcher.note && <BaseUrlNote url={fetcher.note} />}
      <TextRow label="Name" field="name" error={errors.name} value={draft.name} onChange={(name) => set({ name })} />
      <ApiRow value={draft.api} onChange={(api) => set({ api })} />
      <ChecklistView list={list} />
      <MoreSettings>
        <TextRow label="Concurrency per key" field="concurrency" error={errors.concurrency} inputMode="numeric"
          value={draft.concurrency} onChange={(concurrency) => set({ concurrency })} />
        <CompatChecks api={draft.api} value={draft.compat} onChange={(compat) => set({ compat })} />
      </MoreSettings>
      <AddFooter count={list.picked.length} blocked={add.blocked} busy={add.busy} onClose={add.onClose} />
      {add.error && <p className="form-message error" role="alert" data-testid="form-message">{add.error}</p>}
    </>
  );
}

/**
 * @brief Add provider（§6.1）：开始只有 Base URL、API key、Fetch models 与 Cancel；拉取中两个框只读；
 *        拉取后（不论有没有拿到列表）其余字段、清单与 Add。
 */
function AddProvider({ onClose }: { onClose: () => void }) {
  const add = useAddProvider(onClose);
  const { form, fetcher } = add;
  const errors = shownErrors(add.errors, form.touched);
  // 拉取中（§6.1）与加入中（models-settings.md "本表定下的界面细节"：Adding… 时 Base URL、API key 只读，
  // Fetch models 不可用）两个框只读，免得拉取或回到开始时收起清单、丢掉加入的结果
  const locked = fetcher.fetching || add.busy;
  return (
    <form className="settings-form mf-grid" data-testid="provider-form" noValidate
      onSubmit={(event) => { event.preventDefault(); void add.save(); }}>
      <h3>Add provider</h3>
      <TextRow label="Base URL" field="baseUrl" error={errors.baseUrl} value={form.draft.baseUrl} spellCheck={false}
        placeholder="http://host:8000/v1" readOnly={locked} onChange={add.setBaseUrl} />
      <TextRow label="API key" field="secret" type="password" autoComplete="off" placeholder="Optional"
        value={add.secret} readOnly={locked} onChange={add.changeSecret} />
      <FetchRow fetcher={fetcher} disabled={add.errors.baseUrl !== undefined || add.busy} onFetch={add.fetchModels} />
      {fetcher.result ? <AfterFetch add={add} result={fetcher.result} /> : (
        <div className="form-actions">
          <button type="button" className="button" data-action="close-form" onClick={onClose}>Cancel</button>
        </div>
      )}
    </form>
  );
}

/** @brief Edit 的 Save 与 Cancel。 */
function FormButtons({ busy, invalid, onClose }: { busy: boolean; invalid: boolean; onClose: () => void }) {
  return (
    <div className="form-actions">
      <button type="submit" className="button primary" disabled={busy || invalid}>Save</button>
      <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  );
}

/** @brief Edit 提供商：不含 key 和模型字段，没有 Fetch models；改了地址的 origin、有 key 时先确认。 */
function EditProvider({ provider, onClose }: { provider: ModelProvider; onClose: () => void }) {
  const form = useDraft(() => draftOf(provider));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const mounted = useMounted();
  const count = provider.keys.length;
  const originChanged = originOf(form.draft.baseUrl) !== originOf(provider.baseUrl);
  async function save() {
    setBusy(true);
    const result = await writeModels<ProviderSaved>({ type: 'models.saveProvider', id: provider.id,
      provider: toProviderForm(form.draft) });
    setBusy(false);
    setConfirming(false);
    // 表单已被换掉时不再关（同 Add provider，models-settings.md "卡上的 Fetch models"：同一时刻只开一张）
    if (result.error !== null) setError(result.error);
    else if (mounted.current) onClose();
  }
  const submit = () => (originChanged && count > 0 ? setConfirming(true) : void save());
  return (
    <form className="settings-form mf-grid" data-testid="provider-form" noValidate
      onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <h3>Edit provider · {provider.name}</h3>
      <ProviderFields form={form} />
      <FormButtons busy={busy} invalid={hasErrors(providerErrors(form.draft))} onClose={onClose} />
      {error && <p className="form-message error" role="alert" data-testid="form-message">{error}</p>}
      {confirming && (
        <ModelDialog testId="confirm-dialog" kind="address-change" title="Change the base URL?"
          confirmLabel="Save and remove keys" tone="danger" busy={busy} error={null}
          onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
          <p>{addressChangeText(count)}</p>
        </ModelDialog>
      )}
    </form>
  );
}

/** @brief 提供商表单：provider 为 null 时新建（Add provider）。 */
export function ProviderForm({ provider, onClose }: { provider: ModelProvider | null; onClose: () => void }) {
  return provider ? <EditProvider provider={provider} onClose={onClose} /> : <AddProvider onClose={onClose} />;
}
