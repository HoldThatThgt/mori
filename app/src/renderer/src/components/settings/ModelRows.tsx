// 提供商卡里的 Models（§7、§9.1）：每行模型 id、窗口、最大输出、模型族、支持思考与档案摘要；服务没报告的窗口与
// 最大输出标“(not reported)”，报告值与配置不一致时一行提示和 Use（docs/specs/model-discovery.md §8）；
// Verify、需要你同意的两种探针、上移下移、Edit、Delete、Test。模型表单只有 Edit（拉取规格 §6.5），卡上的清单放在
// 这一块的末尾。状态表见 docs/v1/screens/models-settings.md "Models 行与档案摘要""需要你同意的探针"。

import { useState, type ReactNode } from 'react';
import {
  unreportedMaxTokens, type ApiType, type ModelCommand, type ModelProvider, type ProfileView, type ProviderModel,
  type ReportedValues, type ServerKind,
} from '../../../../shared/models';
import { testAt, useProfile, writeModels } from '../../state/settings';
import {
  DeleteDialog, ModelDialog, MoveButtons, TestButton, TestNotice, thousands, useDeleteFlow,
} from './common';
import { ModelEditor } from './ModelEditor';

/** 能跑取消探针的服务（§7.3 第 9 步；拉取规格 §7.2：改认为 localai、tensorrt 的不再显示 Cancel test…） */
const CANCEL_SERVERS: readonly ServerKind[] = ['vllm', 'sglang', 'llamacpp'];

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

/**
 * @brief 档案摘要（§9.1）；探针出错时"Couldn't verify: <原文>"，静默截断时告警。思考关不掉的模型
 *        （reasoning.off_refused，§7.7）在 Reasoning field 后、Cancel 前多一项"Thinking: Can’t be turned off"。
 */
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
          {/* §7.7：第 2 步的说明只存在档案里，这里只写这一项；为假时没有它 */}
          {profile.reasoning.off_refused && (
            <Item field="thinking_off" label="Thinking" value="refused" text="Can’t be turned off" />
          )}
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

// ---- 模型行的提示（拉取规格 §8） ----

/** @brief 模型行的一条提示（拉取规格 §8）：报告值、实测值与配置不一致时一行小字和 Use。 */
interface ModelHint {
  /** data-kind：context、max-output、reasoning、thinking-seen、image，依次是拉取规格 §8 表的五行 */
  kind: 'context' | 'max-output' | 'reasoning' | 'thinking-seen' | 'image';
  /** 一行小字（数字按千分位写） */
  text: string;
  /** Use 保存的模型：按拉取规格 §8 表改过的配置 */
  model: ProviderModel;
}

/**
 * @brief 拉取规格 §8 表的前两行：服务报告的窗口与配置的不同；报告的输出上限与配置的不同且小于配置的窗口。
 *        窗口的 Use 在原来的 Max output 不小于 N 时把它改为 16384 与 N 一半中较小的。
 */
function sizeHints(model: ProviderModel, reported: ReportedValues): ModelHint[] {
  const hints: ModelHint[] = [];
  const window = reported.contextWindow;
  if (window !== null && window !== model.contextWindow) {
    const maxTokens = model.maxTokens >= window ? unreportedMaxTokens(window) : model.maxTokens;
    hints.push({ kind: 'context', text: `Server reports a context window of ${thousands(window)}.`,
      model: { ...model, contextWindow: window, maxTokens } });
  }
  const max = reported.maxTokens;
  if (max !== null && max !== model.maxTokens && max < model.contextWindow) {
    hints.push({ kind: 'max-output', text: `Server reports max output of ${thousands(max)}.`,
      model: { ...model, maxTokens: max } });
  }
  return hints;
}

/**
 * @brief 模型行的提示（拉取规格 §8），按表的顺序。档案的 reported 为 null（旧档案、还没有档案）时只可能有第四行：
 *        它只看档案的推理字段，把“reported.reasoning 不为真”当作成立。
 * @param api 提供商的接口
 * @param profile 这个模型的档案；还没有时为 null
 */
function modelHints(api: ApiType, model: ProviderModel, profile: ProfileView | null): ModelHint[] {
  const reported = profile?.reported ?? null;
  const thinking: ProviderModel = { ...model, reasoning: true };
  const hints = reported ? sizeHints(model, reported) : [];
  if (reported?.reasoning === true && !model.reasoning) {
    hints.push({ kind: 'reasoning', text: 'The server says this model supports thinking.', model: thinking });
  }
  if (api === 'openai-completions' && profile !== null && profile.reasoning.field !== 'none' && !model.reasoning
    && reported?.reasoning !== true) {
    hints.push({ kind: 'thinking-seen', text: 'This model returned thinking content.', model: thinking });
  }
  // 配置的 input 只有 text 时没勾 Image input
  if (reported?.image === true && model.input.length === 1) {
    hints.push({ kind: 'image', text: 'The server says this model accepts images.',
      model: { ...model, input: ['text', 'image'] } });
  }
  return hints;
}

/** @brief 一条提示：一行小字和 Use（立即保存，拉取规格 §8）；这一行保存中 Use 不可用。 */
function HintLine({ hint, busy, onUse }: { hint: ModelHint; busy: boolean; onUse: () => void }) {
  return (
    <div className="row-actions model-hint" data-testid="model-hint" data-kind={hint.kind}>
      <span className="muted">{hint.text}</span>
      <button className="button compact" data-action="use-reported" disabled={busy} onClick={onUse}>Use</button>
    </div>
  );
}

/** @brief 服务没报告这一项（拉取规格 §8）：接在数字后面的“ (not reported)”。 */
function NotReported({ field }: { field: 'contextWindow' | 'maxTokens' }) {
  return <>{' '}<span data-testid="not-reported" data-field={field}>(not reported)</span></>;
}

// ---- 模型行 ----

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

/**
 * @brief 模型行的说明：窗口、最大输出、模型族（为空时不显示）、支持思考（勾了时显示）。档案的 reported 不为 null、
 *        其中窗口或输出上限为 null 时，那个数字后面写 (not reported)；数字是配置的值（拉取规格 §8）。
 * @param reported 档案里服务报告的值；旧档案或还没有档案时为 null（不标 not reported）
 */
function ModelMeta({ model, reported }: { model: ProviderModel; reported: ReportedValues | null }) {
  return (
    <span className="model-meta">
      Context window: {thousands(model.contextWindow)}
      {reported !== null && reported.contextWindow === null && <NotReported field="contextWindow" />}
      {' · '}Max output: {thousands(model.maxTokens)}
      {reported !== null && reported.maxTokens === null && <NotReported field="maxTokens" />}
      {model.family && ` · Family: ${model.family}`}{model.reasoning && ' · Supports thinking'}
    </span>
  );
}

/** @brief 一行模型的立即保存（Verify、上移下移、提示的 Use）：保存中按钮不可用，失败时原文写在这一行里。 */
function useRowSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(command: ModelCommand) {
    setBusy(true);
    setError((await writeModels(command)).error);
    setBusy(false);
  }
  return { busy, error, run };
}

/** @brief 一行模型。 */
export function ModelRow({ provider, model, index, onEdit }: ModelRowProps) {
  const ref = `${provider.id}/${model.id}`;
  const { profile } = useProfile(ref);
  const { busy, error, run } = useRowSave();
  const [consent, setConsent] = useState<'long-input' | 'cancel-test' | null>(null);
  const flow = useDeleteFlow((dryRun) => ({ type: 'models.deleteModel', providerId: provider.id, modelId: model.id,
    dryRun }));
  // 拉取规格 §8：Use 立即保存按表改过的模型，不带 thinkingLevel；指纹变了由后台进程重新探测（模型层规格 §7.4）
  const use = (changed: ProviderModel) => void run({ type: 'models.saveModel', providerId: provider.id,
    model: changed });
  const at = `model:${ref}`;
  return (
    <li className="model-row" data-testid="model-row" data-model={ref}>
      <div className="row-line">
        <span className="model-info"><span className="model-id">{model.id}</span>
          <ModelMeta model={model} reported={profile?.reported ?? null} /></span>
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
      {modelHints(provider.api, model, profile).map((hint) => (
        <HintLine key={hint.kind} hint={hint} busy={busy} onUse={() => use(hint.model)} />))}
      <ProfileSummary modelRef={ref} />
      <TestNotice at={at} testId="model-test" />
      {error && <p className="form-message error" role="alert">{error}</p>}
      {consent && <ConsentDialog kind={consent} model={ref} onClose={() => setConsent(null)}
        effective={profile?.context.effective ?? model.contextWindow} />}
      <DeleteDialog flow={flow} kind="delete-model" title={`Delete model ${model.id}?`} />
    </li>
  );
}

/** @brief Models 一块的参数（拉取规格 §6.5：模型表单只有 Edit，没有新建；卡上的清单放在这一块的末尾）。 */
export interface ModelRowsProps {
  /** 所在的提供商 */
  provider: ModelProvider;
  /** 正在 Edit 的模型 id；没有时为 undefined */
  editing: string | undefined;
  /** 点了某一行的 Edit */
  onEdit: (modelId: string) => void;
  /** 模型表单保存成功或点了 Cancel */
  onClose: () => void;
  /** 放在这一块末尾的内容：卡上的清单（原来 Add model 表单的位置，models-settings.md "卡上的 Fetch models"） */
  children?: ReactNode;
}

/** @brief Models 一块：模型行、Edit 时就地换成模型表单、卡上的清单在最后。 */
export function ModelRows({ provider, editing, onEdit, onClose, children }: ModelRowsProps) {
  return (
    <div className="card-block">
      <h4>Models</h4>
      <ul className="row-list">
        {provider.models.map((model, index) => (editing === model.id
          ? <li key={model.id}><ModelEditor provider={provider} model={model} onClose={onClose} /></li>
          : <ModelRow key={model.id} provider={provider} model={model} index={index}
            onEdit={() => onEdit(model.id)} />))}
      </ul>
      {children}
    </div>
  );
}
