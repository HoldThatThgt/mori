// 提供商卡里的 Keys（§8.3、§9.1）：每行拖动柄（2026-10-26 负责人走查 M5，取代上移下移，见 Reorder.tsx）、标签、
// "Saved"、当前记录、Test、Remove；Add key 内联表单。key 的明文从不显示、不回填、不能改。
// 状态表见 docs/v1/screens/models-settings.md "Keys"与"拖动排序"。

import { useState } from 'react';
import { formatClock, MODEL_LIMITS, type KeyAdded, type KeyStatus, type ModelProvider, type ProviderKey } from
  '../../../../shared/models';
import { testAt, useKeyStatus, writeModels } from '../../state/settings';
import { FieldError, ModelDialog, TestButton, TestNotice } from './common';
import { ReorderHandle, ReorderStatus, useOrderedSave, useReorderRow, type ReorderList } from './Reorder';

/** @brief key 记录的文字（§9.1）。 */
function statusText(status: KeyStatus): string {
  if (status.state === 'rate_limited') {
    return `Rate limited until ${status.until === null ? '?' : formatClock(status.until)}`;
  }
  return status.state === 'auth' ? 'Rejected' : 'Quota exhausted';
}

/** @brief 一个 key 的当前记录；没有时不显示。 */
function KeyState({ keyRef }: { keyRef: string }) {
  const status = useKeyStatus(keyRef);
  if (!status) return null;
  return <span className="key-state" data-testid="key-state" data-state={status.state}>{statusText(status)}</span>;
}

/** @brief 一行 key 的参数。 */
interface KeyRowProps {
  /** 所在的提供商 */
  provider: ModelProvider;
  /** 这个 key */
  item: ProviderKey;
  /** 在显示的顺序里的位置 */
  index: number;
  /** 这个提供商的 Keys 列表（拖动排序） */
  list: ReorderList;
}

/** @brief 一行 key：Remove 最后一个 key 时先确认（"Requests to <name> will be sent without an API key."）。 */
function KeyRow({ provider, item, index, list }: KeyRowProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const drop = useReorderRow(list, index);
  const count = provider.keys.length;
  const at = `key:${item.ref}`;
  async function run(command: Parameters<typeof writeModels>[0]) {
    setBusy(true);
    const result = await writeModels(command);
    setBusy(false);
    setError(result.error);
    return result.error === null;
  }
  const remove = () => run({ type: 'models.removeKey', providerId: provider.id, ref: item.ref });
  return (
    <li className="key-row" data-testid="key-row" data-ref={item.ref} {...drop}>
      <div className="row-line">
        <ReorderHandle list={list} index={index} />
        <span className="key-label">{item.label}</span>
        <span className="key-saved">Saved</span>
        <KeyState keyRef={item.ref} />
        <span className="row-actions">
          <TestButton at={at} label="Test" action="key-test" onTest={() => void testAt(at,
            { providerId: provider.id, modelId: provider.models[0].id, keyRef: item.ref })} />
          <button className="button compact" data-action="key-remove" disabled={busy}
            onClick={() => (count === 1 ? setConfirming(true) : void remove())}>
            {count === 1 ? 'Remove…' : 'Remove'}</button>
        </span>
      </div>
      <TestNotice at={at} testId="key-test" />
      {error && !confirming && <p className="form-message error" role="alert">{error}</p>}
      {confirming && (
        <ModelDialog testId="confirm-dialog" kind="last-key" title="Remove the last key?" confirmLabel="Remove"
          tone="danger" busy={busy} error={error} onCancel={() => { setConfirming(false); setError(null); }}
          onConfirm={() => void remove().then((done) => done && setConfirming(false))}>
          <p>Requests to {provider.name} will be sent without an API key.</p>
        </ModelDialog>
      )}
    </li>
  );
}

/** @brief Add key 的内联表单：Label 默认"Key <n>"、Secret 密码框；Secret 为空时 Save 不可用。 */
function KeyForm({ provider, onClose }: { provider: ModelProvider; onClose: () => void }) {
  const [label, setLabel] = useState(`Key ${provider.nextKeyNumber}`);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelError = label.trim() ? null : 'Label is required.';
  async function save() {
    setBusy(true);
    const result = await writeModels<KeyAdded>({ type: 'models.addKey', providerId: provider.id, label, secret });
    setBusy(false);
    if (result.error === null) onClose();
    else setError(result.error);
  }
  return (
    <form className="key-form" data-testid="key-form" noValidate
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Label
        <input value={label} onChange={(event) => setLabel(event.target.value)} aria-invalid={Boolean(labelError)} />
      </label>
      <FieldError field="label" error={labelError} />
      <label>Secret
        <input type="password" value={secret} autoComplete="off" onChange={(event) => setSecret(event.target.value)} />
      </label>
      <span className="row-actions">
        <button type="submit" className="button compact primary" disabled={busy || !secret || Boolean(labelError)}>
          Save</button>
        <button type="button" className="button compact" disabled={busy} onClick={onClose}>Cancel</button>
      </span>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </form>
  );
}

/** @brief Keys 一块：拖动排序一次移动一条 models.moveKey（顺序就是使用顺序），移动失败的原文在列表下面。 */
export function Keys({ provider }: { provider: ModelProvider }) {
  const [adding, setAdding] = useState(false);
  const order = useOrderedSave(`keys:${provider.id}`, provider.keys, (item) => item.label,
    (item, delta) => ({ type: 'models.moveKey', providerId: provider.id, ref: item.ref, delta }));
  const full = provider.keys.length >= MODEL_LIMITS.maxKeys;
  return (
    <div className="card-block">
      <h4>Keys</h4>
      {provider.keys.length === 0 && (
        <p className="muted" data-testid="no-keys">Requests are sent without an API key.</p>
      )}
      <ul className="row-list">
        {order.items.map((item, index) => <KeyRow key={item.ref} provider={provider} item={item} index={index}
          list={order.list} />)}
      </ul>
      <ReorderStatus list={order.list} />
      {order.error && <p className="form-message error" role="alert">{order.error}</p>}
      {adding ? <KeyForm provider={provider} onClose={() => setAdding(false)} /> : (
        <div className="row-actions">
          <button className="button compact" data-action="add-key" disabled={full} onClick={() => setAdding(true)}>
            Add key</button>
          {full && <span className="muted">A provider can have at most 8 keys.</span>}
        </div>
      )}
    </div>
  );
}
