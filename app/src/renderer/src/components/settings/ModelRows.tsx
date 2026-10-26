// 提供商卡里的 Models（§9.1）：每行模型 id 与一行说明（窗口、最大输出、模型族、支持思考，思考关不掉时最后加
// “Thinking can’t be turned off”）；服务没报告、值仍是 Mori 默认值的窗口与最大输出标“(default)”，取自 pi 自带模型表的
// 标“(from pi)”（2026-10-26，WP-15），报告值或 pi 的值与配置不一致时一行提示和 Use（docs/specs/model-discovery.md §8，
// 规则在 modelHints.ts）；模型不能用（tool calling 没验证通过）时一行状态与 Verify again；
// 行左端的拖动柄（2026-10-26 负责人走查 M5，取代上移下移，见 Reorder.tsx）、Edit、Delete。模型表单只有 Edit
// （拉取规格 §6.5），卡上的清单放在这一块的末尾。
// 状态表见 docs/v1/screens/models-settings.md “Models 行”（2026-10-26 负责人走查 M6、M7、M8：档案摘要、Verify、
// 需要你同意的两种探针和行上的 Test 删掉；探针第 0–7 步照旧自动跑，选择器、编译与 TaskBoard 照旧读档案）与“拖动排序”。

import { useState, type ReactNode } from 'react';
import type { ModelCommand, ModelProvider, ProfileView, ProviderModel } from '../../../../shared/models';
import { useProfile, writeModels } from '../../state/settings';
import { DeleteDialog, useDeleteFlow } from './common';
import { thousands } from './format';
import { ModelEditor } from './ModelEditor';
import { modelHints, piRowTitle, valueMarks, type ModelHint, type ValueMark } from './modelHints';
import { probeState, statusLine, type StatusLine } from './probeStatus';
import { ReorderHandle, ReorderStatus, useOrderedSave, useReorderRow, type ReorderList } from './Reorder';

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

// ---- 模型行的提示（拉取规格 §8，规则在 modelHints.ts） ----

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
 * @brief 接在数字或“Supports thinking”后面的“ (from pi)”（拉取规格 §8，2026-10-26 负责人走查回答 1）：服务没报告、
 *        按地址取自 pi 自带模型表的值；悬停写 pi 的提供商名。
 */
function PiMark({ field, provider }: { field: 'contextWindow' | 'maxTokens' | 'reasoning'; provider: string }) {
  return <>{' '}<span data-testid="pi-value" data-field={field} title={piRowTitle(provider)}>(from pi)</span></>;
}

/** @brief 数字后面的标记：(from pi)、(default) 或没有（valueMarks）。 */
function Mark({ mark, field, provider }: { mark: ValueMark; field: 'contextWindow' | 'maxTokens'; provider: string }) {
  if (mark === 'pi') return <PiMark field={field} provider={provider} />;
  return mark === 'default' ? <DefaultMark field={field} /> : null;
}

/**
 * @brief 模型行的说明：窗口、最大输出、模型族（为空时不显示）、支持思考（勾了时显示）、思考关不掉（档案的
 *        reasoning.off_refused，§7.7；重新验证中按旧档案）；数字是配置的值，后面按 valueMarks 写 (from pi) 或 (default)，
 *        取自 pi 的思考支持后面写 (from pi)。
 */
function ModelMeta({ model, profile }: { model: ProviderModel; profile: ProfileView | null }) {
  const marks = valueMarks(model, profile);
  const provider = profile?.catalog?.provider ?? '';
  return (
    <span className="model-meta">
      Context window: {thousands(model.contextWindow)}
      <Mark mark={marks.contextWindow} field="contextWindow" provider={provider} />
      {' · '}Max output: {thousands(model.maxTokens)}
      <Mark mark={marks.maxTokens} field="maxTokens" provider={provider} />
      {model.family && ` · Family: ${model.family}`}{model.reasoning && ' · Supports thinking'}
      {marks.reasoning && <PiMark field="reasoning" provider={provider} />}
      {profile?.reasoning.off_refused && (
        <>{' · '}<span data-field="thinking_off">Thinking can’t be turned off</span></>
      )}
    </span>
  );
}

/** @brief 一行模型的立即保存（Verify again、提示的 Use）：保存中按钮不可用，失败时原文写在这一行里。 */
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
  /** 在显示的顺序里的位置 */
  index: number;
  /** 这个提供商的 Models 列表（拖动排序） */
  list: ReorderList;
  /** 点了 Edit */
  onEdit: () => void;
}

/** @brief 一行模型。 */
export function ModelRow({ provider, model, index, list, onEdit }: ModelRowProps) {
  const ref = `${provider.id}/${model.id}`;
  const { profile, running } = useProfile(ref);
  const { busy, error, run } = useRowSave();
  const drop = useReorderRow(list, index);
  const flow = useDeleteFlow((dryRun) => ({ type: 'models.deleteModel', providerId: provider.id, modelId: model.id,
    dryRun }));
  // 拉取规格 §8：Use 立即保存按表改过的模型，不带 thinkingLevel；指纹变了由后台进程重新探测（模型层规格 §7.4）
  const use = (changed: ProviderModel) => void run({ type: 'models.saveModel', providerId: provider.id,
    model: changed });
  const line = statusLine(profile, running);
  return (
    <li className="model-row" data-testid="model-row" data-model={ref} data-probe={probeState(profile, running)}
      {...drop}>
      <div className="row-line">
        <ReorderHandle list={list} index={index} />
        <span className="model-info"><span className="model-id">{model.id}</span>
          <ModelMeta model={model} profile={profile} /></span>
        <span className="row-actions">
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

/**
 * @brief Models 一块：模型行（拖动排序，一次移动一条 models.moveModel，移动失败的原文在列表下面）、Edit 时就地换成
 *        模型表单（那一行没有柄、不能放下）、卡上的清单在最后。
 */
export function ModelRows({ provider, editing, onEdit, onClose, children }: ModelRowsProps) {
  const order = useOrderedSave(`models:${provider.id}`, provider.models, (model) => model.id,
    (model, delta) => ({ type: 'models.moveModel', providerId: provider.id, modelId: model.id, delta }));
  return (
    <div className="card-block">
      <h4>Models</h4>
      <ul className="row-list">
        {order.items.map((model, index) => (editing === model.id
          ? <li key={model.id}><ModelEditor provider={provider} model={model} onClose={onClose} /></li>
          : <ModelRow key={model.id} provider={provider} model={model} index={index} list={order.list}
            onEdit={() => onEdit(model.id)} />))}
      </ul>
      <ReorderStatus list={order.list} />
      {order.error && <p className="form-message error" role="alert">{order.error}</p>}
      {children}
    </div>
  );
}
