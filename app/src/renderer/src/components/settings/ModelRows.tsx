// 提供商卡里的 Models（§9.1）：每行模型 id 与一行说明（窗口、最大输出、模型族、支持思考，思考关不掉时最后加
// “Thinking can’t be turned off”）；服务没报告、值仍是 Mori 默认值的窗口与最大输出标“(default)”，报告值与配置不一致时
// 一行提示和 Use（docs/specs/model-discovery.md §8）；模型不能用（tool calling 没验证通过）时一行状态与 Verify again；
// 上移下移、Edit、Delete。模型表单只有 Edit（拉取规格 §6.5），卡上的清单放在这一块的末尾。
// 状态表见 docs/v1/screens/models-settings.md “Models 行”（2026-10-26 负责人走查 M6、M7、M8：档案摘要、Verify、
// 需要你同意的两种探针和行上的 Test 删掉；探针第 0–7 步照旧自动跑，选择器、编译与 TaskBoard 照旧读档案）。

import { useState, type ReactNode } from 'react';
import {
  UNREPORTED_CONTEXT_WINDOW, unreportedMaxTokens, type ApiType, type ModelCommand, type ModelProvider,
  type ProfileView, type ProviderModel, type ReportedValues,
} from '../../../../shared/models';
import { useProfile, writeModels } from '../../state/settings';
import { DeleteDialog, MoveButtons, thousands, useDeleteFlow } from './common';
import { ModelEditor } from './ModelEditor';
import { probeState, statusLine, type StatusLine } from './probeStatus';

// ---- tool calling 的状态行（§7.4；models-settings.md “Models 行”，规则见 probeStatus.ts） ----

/** @brief 状态行的一行：文字，失败与出错时后面一个 Verify again（models.verify，第 0–7 步）。 */
function ProbeLine({ line, busy, onVerify }: { line: StatusLine; busy: boolean; onVerify: () => void }) {
  return (
    <div className="row-actions probe-line" data-testid="probe-status" data-state={line.state}>
      <span className={line.state === 'verifying' ? 'muted' : 'probe-problem'}>{line.text}</span>
      {line.state !== 'verifying' && (
        <button className="button compact" data-action="verify" disabled={busy} onClick={onVerify}>Verify again</button>
      )}
    </div>
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

// ---- 模型行 ----

/** “(default)”的悬停说明（models-settings.md “Models 行”，临时，走查时可以改） */
const DEFAULT_TITLE = 'The server didn’t report this, so Mori used a default. Use Edit to set the real value.';

/** @brief 接在数字后面的“ (default)”（拉取规格 §8，2026-10-26 改）：服务没报告、值仍是 Mori 的默认值。 */
function DefaultMark({ field }: { field: 'contextWindow' | 'maxTokens' }) {
  return <>{' '}<span data-testid="default-value" data-field={field} title={DEFAULT_TITLE}>(default)</span></>;
}

/**
 * @brief 标“(default)”的两项：档案有报告值、这一项没报告，而且配置的值仍等于默认值（窗口 128000；Max output 为 16384 与
 *        配置窗口一半中较小的，同清单与拉取规格 §11）。你用 Edit 改成别的值就不再标。
 * @param reported 档案里服务报告的值；旧档案或还没有档案时为 null（都不标）
 */
function defaultsOf(model: ProviderModel, reported: ReportedValues | null): { window: boolean; max: boolean } {
  return {
    window: reported?.contextWindow === null && model.contextWindow === UNREPORTED_CONTEXT_WINDOW,
    max: reported?.maxTokens === null && model.maxTokens === unreportedMaxTokens(model.contextWindow),
  };
}

/**
 * @brief 模型行的说明：窗口、最大输出、模型族（为空时不显示）、支持思考（勾了时显示）、思考关不掉（档案的
 *        reasoning.off_refused，§7.7；重新验证中按旧档案）；数字是配置的值，仍是默认值时后面写 (default)。
 */
function ModelMeta({ model, profile }: { model: ProviderModel; profile: ProfileView | null }) {
  const marks = defaultsOf(model, profile?.reported ?? null);
  return (
    <span className="model-meta">
      Context window: {thousands(model.contextWindow)}{marks.window && <DefaultMark field="contextWindow" />}
      {' · '}Max output: {thousands(model.maxTokens)}{marks.max && <DefaultMark field="maxTokens" />}
      {model.family && ` · Family: ${model.family}`}{model.reasoning && ' · Supports thinking'}
      {profile?.reasoning.off_refused && (
        <>{' · '}<span data-field="thinking_off">Thinking can’t be turned off</span></>
      )}
    </span>
  );
}

/** @brief 一行模型的立即保存（Verify again、上移下移、提示的 Use）：保存中按钮不可用，失败时原文写在这一行里。 */
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

/** @brief 一行模型。 */
export function ModelRow({ provider, model, index, onEdit }: ModelRowProps) {
  const ref = `${provider.id}/${model.id}`;
  const { profile, running } = useProfile(ref);
  const { busy, error, run } = useRowSave();
  const flow = useDeleteFlow((dryRun) => ({ type: 'models.deleteModel', providerId: provider.id, modelId: model.id,
    dryRun }));
  // 拉取规格 §8：Use 立即保存按表改过的模型，不带 thinkingLevel；指纹变了由后台进程重新探测（模型层规格 §7.4）
  const use = (changed: ProviderModel) => void run({ type: 'models.saveModel', providerId: provider.id,
    model: changed });
  const line = statusLine(profile, running);
  return (
    <li className="model-row" data-testid="model-row" data-model={ref} data-probe={probeState(profile, running)}>
      <div className="row-line">
        <span className="model-info"><span className="model-id">{model.id}</span>
          <ModelMeta model={model} profile={profile} /></span>
        <span className="row-actions">
          <MoveButtons index={index} count={provider.models.length} busy={busy} actions={['up', 'down']}
            onMove={(delta) => void run({ type: 'models.moveModel', providerId: provider.id, modelId: model.id,
              delta })} />
          <button className="button compact" data-action="edit" onClick={onEdit}>Edit</button>
          <button className="button compact danger" data-action="delete" onClick={() => void flow.start()}>
            Delete…</button>
        </span>
      </div>
      {modelHints(provider.api, model, profile).map((hint) => (
        <HintLine key={hint.kind} hint={hint} busy={busy} onUse={() => use(hint.model)} />))}
      {line && <ProbeLine line={line} busy={busy}
        onVerify={() => void run({ type: 'models.verify', refs: [ref] })} />}
      {error && <p className="form-message error" role="alert">{error}</p>}
      <DeleteDialog flow={flow} kind="delete-model" title={`Delete model ${model.id}?`} />
    </li>
  );
}

/** @brief Models 一块的参数（拉取规格 §6.5：模型表单只有 Edit，没有新建；卡上的清单在这一块的末尾）。 */
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
