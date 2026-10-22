// 提供商卡里的 Models（§7、§9.1）：每行模型 id、窗口、最大输出、模型族、支持思考与档案摘要；
// Verify、需要你同意的两种探针、上移下移、Edit、Delete、Test。状态表见 docs/v1/screens/models-settings.md
// "Models 行与档案摘要""需要你同意的探针"。

import { useState } from 'react';
import type { ModelProvider, ProfileView, ProviderModel } from '../../../../shared/models';
import { testAt, useProfile, writeModels } from '../../state/settings';
import {
  DeleteDialog, ModelDialog, MoveButtons, TestButton, TestNotice, thousands, useDeleteFlow,
} from './common';
import { ModelEditor } from './ModelEditor';

/** 能跑取消探针的服务（§7.3 第 9 步） */
const CANCEL_SERVERS = ['vllm', 'sglang', 'llamacpp'];

/** @brief 档案摘要的一项：名称、文字与 data-value。 */
function Item({ field, label, value, text }: { field: string; label: string; value: string; text: string }) {
  return <span className="profile-item" data-field={field} data-value={value}>{label}: <b>{text}</b></span>;
}

/**
 * @brief Tool calling 的状态（§7.4）：从未验证过的（没有档案，或档案里不是 verified、failed，例如上次出错）
 *        探测中为 Verifying…，验证过的重新探测为 Re-verifying…。
 */
function toolCalling(profile: ProfileView | null, running: boolean): { value: string; text: string } {
  const state = profile?.tool_calling.state;
  const verified = profile !== null && profile.status !== 'probing' && (state === 'verified' || state === 'failed');
  if (running && verified) return { value: 'reverifying', text: 'Re-verifying…' };
  if (running || !profile || profile.status === 'probing') return { value: 'verifying', text: 'Verifying…' };
  const texts = { verified: 'Verified', unverified: 'Not verified', failed: 'Failed' } as const;
  return { value: profile.tool_calling.state, text: texts[profile.tool_calling.state] };
}

/** @brief 档案摘要（§9.1）；探针出错时"Couldn't verify: <原文>"，静默截断时告警。 */
function ProfileSummary({ modelRef }: { modelRef: string }) {
  const { profile, running } = useProfile(modelRef);
  const tool = toolCalling(profile, running);
  const cancel = profile?.cancel_verified ?? 'unknown';
  const cancelText = cancel === 'unknown' ? 'Unknown' : cancel ? 'Verified' : 'Not verified';
  return (
    <div className="profile" data-testid="profile">
      <Item field="tool_calling" label="Tool calling" value={tool.value} text={tool.text} />
      {profile && (
        <>
          <Item field="tier" label="Handoff tier" value={profile.tier.level ?? 'none'}
            text={profile.tier.level ?? '—'} />
          <Item field="context" label="Context" value={String(profile.context.effective)}
            text={thousands(profile.context.effective)} />
          <Item field="reasoning" label="Reasoning field" value={profile.reasoning.field}
            text={profile.reasoning.field} />
          <Item field="cancel" label="Cancel" value={String(cancel)} text={cancelText} />
        </>
      )}
      {profile?.context.truncation === 'silent' && (
        <span className="profile-warn" data-testid="truncation-warning">Silently truncates long input</span>
      )}
      {profile?.status === 'error' && !running && (
        <p className="form-message error" data-testid="probe-error">Couldn’t verify: {profile.error}</p>
      )}
    </div>
  );
}

/** @brief 需要你同意的探针：长输入（第 8 步）或取消（第 9 步）的确认框。 */
function ConsentDialog({ kind, model, effective, onClose }: {
  kind: 'long-input' | 'cancel-test'; model: string; effective: number; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = model.slice(model.indexOf('/') + 1);
  const half = Math.round(effective * 0.5);
  const most = Math.round(effective * 0.9);
  async function run() {
    setBusy(true);
    const tests = kind === 'long-input' ? 'long_input' : 'cancel';
    const result = await writeModels({ type: 'models.verify', refs: [model], tests });
    setBusy(false);
    if (result.error === null) onClose();
    else setError(result.error);
  }
  const text = kind === 'long-input'
    ? `Sends two requests of about ${thousands(half)} and ${thousands(most)} tokens (about ${thousands(half + most)}`
      + ' tokens in all) to check whether long input is silently truncated.'
    : 'Sends one request for a long reply, disconnects after the first output, and reads the server’s metrics'
      + ' to see whether the request stopped.';
  const title = kind === 'long-input' ? `Run the long-input test on ${id}?` : `Run the cancel test on ${id}?`;
  return (
    <ModelDialog testId="confirm-dialog" kind={kind} title={title} confirmLabel="Run test" tone="primary" busy={busy}
      error={error} onConfirm={() => void run()} onCancel={onClose}>
      <p>{text}</p>
    </ModelDialog>
  );
}

/** @brief 一行模型的参数。 */
export interface ModelRowProps {
  /** 所在的提供商 */
  provider: ModelProvider;
  /** 这个模型 */
  model: ProviderModel;
  /** 在 models 里的位置 */
  index: number;
  /** 点了 Edit */
  onEdit: () => void;
}

/** @brief 模型行的说明：窗口、最大输出、模型族（为空时不显示）、支持思考（勾了时显示）。 */
function ModelMeta({ model }: { model: ProviderModel }) {
  return (
    <span className="model-meta">
      Context window: {thousands(model.contextWindow)} · Max output: {thousands(model.maxTokens)}
      {model.family && ` · Family: ${model.family}`}{model.reasoning && ' · Supports thinking'}
    </span>
  );
}

/** @brief 一行模型。 */
export function ModelRow({ provider, model, index, onEdit }: ModelRowProps) {
  const ref = `${provider.id}/${model.id}`;
  const { profile } = useProfile(ref);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<'long-input' | 'cancel-test' | null>(null);
  const flow = useDeleteFlow((dryRun) => ({ type: 'models.deleteModel', providerId: provider.id, modelId: model.id,
    dryRun }));
  async function run(command: Parameters<typeof writeModels>[0]) {
    setBusy(true);
    setError((await writeModels(command)).error);
    setBusy(false);
  }
  const at = `model:${ref}`;
  return (
    <li className="model-row" data-testid="model-row" data-model={ref}>
      <div className="row-line">
        <span className="model-info"><span className="model-id">{model.id}</span><ModelMeta model={model} /></span>
        <span className="row-actions">
          <button className="button compact" data-action="verify" disabled={busy}
            onClick={() => void run({ type: 'models.verify', refs: [ref], tests: 'auto' })}>Verify</button>
          <button className="button compact" data-action="long-input" onClick={() => setConsent('long-input')}>
            Long-input test…</button>
          {profile && CANCEL_SERVERS.includes(profile.server.kind) && <button className="button compact"
            data-action="cancel-test" onClick={() => setConsent('cancel-test')}>Cancel test…</button>}
          <MoveButtons index={index} count={provider.models.length} busy={busy} actions={['up', 'down']}
            onMove={(delta) => void run({ type: 'models.moveModel', providerId: provider.id, modelId: model.id,
              delta })} />
          <button className="button compact" data-action="edit" onClick={onEdit}>Edit</button>
          <button className="button compact danger" data-action="delete" onClick={() => void flow.start()}>
            Delete…</button>
          <TestButton at={at} label="Test" action="test"
            onTest={() => void testAt(at, { providerId: provider.id, modelId: model.id })} />
        </span>
      </div>
      <ProfileSummary modelRef={ref} />
      <TestNotice at={at} testId="model-test" />
      {error && <p className="form-message error" role="alert">{error}</p>}
      {consent && <ConsentDialog kind={consent} model={ref} onClose={() => setConsent(null)}
        effective={profile?.context.effective ?? model.contextWindow} />}
      <DeleteDialog flow={flow} kind="delete-model" title={`Delete model ${model.id}?`} />
    </li>
  );
}

/** @brief Models 一块：模型行、Edit 时就地换成模型表单、Add model 的表单在最后。 */
export function ModelRows({ provider, editing, onEdit, onClose }: {
  provider: ModelProvider; editing: string | null | undefined; onEdit: (modelId: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="card-block">
      <h4>Models</h4>
      <ul className="row-list">
        {provider.models.map((model, index) => (editing === model.id
          ? <li key={model.id}><ModelEditor provider={provider} model={model} onClose={onClose} /></li>
          : <ModelRow key={model.id} provider={provider} model={model} index={index}
            onEdit={() => onEdit(model.id)} />))}
      </ul>
      {editing === null && <ModelEditor provider={provider} model={null} onClose={onClose} />}
    </div>
  );
}
