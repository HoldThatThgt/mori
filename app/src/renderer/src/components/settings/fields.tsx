// 提供商表单、模型表单与首次启动表单共用的字段与界面先做的检查（docs/v1/screens/models-settings.md "字段错误的文字"，
// 规格 §4.1、§9.1、§12）。字段值按输入框的文字保存，检查通过后再转成配置里的类型。

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import {
  API_TYPE_LABELS, API_TYPES, COMPAT_LABELS, COMPAT_OPTIONS, ConcurrencySchema, MODEL_LIMITS, ProviderFormSchema,
  suggestZone, THINKING_LEVELS, ZONES, type ApiType, type Compat, type ProviderForm, type ProviderModel,
  type ThinkingLevel, type Zone,
} from '../../../../shared/models';
import { FieldError, ZONE_LABELS } from './common';

/** @brief 思考强度的英文界面文字（models-settings.md "模型表单"）。 */
export const THINKING_NAMES: Readonly<Record<ThinkingLevel, string>> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

/** 新模型的上下文窗口（models-settings.md，临时） */
const DEFAULT_WINDOW = 128000;
/** 新模型的 Max output 上限（§12：16384 与窗口一半中较小的） */
const DEFAULT_MAX_OUTPUT = 16384;
/** 新模型的思考强度（models-settings.md，临时） */
const DEFAULT_THINKING: ThinkingLevel = 'medium';

/** @brief 新模型的 Max output：16384 与窗口一半中较小的（§12）；窗口不是正整数时为 16384。 */
export function defaultMaxOutput(window: string): string {
  const value = positiveInt(window);
  return String(value === null ? DEFAULT_MAX_OUTPUT : Math.min(DEFAULT_MAX_OUTPUT, Math.floor(value / 2)));
}

/** @brief 输入框的文字是正整数时返回它，否则为 null。 */
function positiveInt(text: string): number | null {
  const value = /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// ---- 草稿与改过的字段 ----

/** @brief 表单草稿与改过的字段：字段错误只在改过的字段旁显示，有错误时保存按钮不可用。 */
export function useDraft<T extends object>(initial: () => T) {
  const [draft, setDraft] = useState<T>(initial);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const edit = (patch: Partial<T>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setTouched((current) => new Set([...current, ...Object.keys(patch)]));
  };
  return { draft, setDraft, touched, edit };
}

/** @brief 字段错误：字段名 → 文字。 */
export type FieldErrors = Partial<Record<string, string>>;

/** @brief 只取改过的字段的错误（显示用）。 */
export function shownErrors(errors: FieldErrors, touched: ReadonlySet<string>): FieldErrors {
  return Object.fromEntries(Object.entries(errors).filter(([field]) => touched.has(field)));
}

/** @brief 有没有错误。 */
export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

// ---- 提供商字段 ----

/** @brief 提供商表单的草稿。 */
export interface ProviderDraft {
  /** 名称 */
  name: string;
  /** 地址 */
  baseUrl: string;
  /** 接口类型 */
  api: ApiType;
  /** 网络区域；Edit 区域还没确认的（迁移来的）提供商时为 null，要你选 */
  zone: Zone | null;
  /** 你手动选过区域（之后不再随地址改） */
  zoneChosen: boolean;
  /** 每个 key 的并发上限（输入框的文字） */
  concurrency: string;
  /** 兼容选项 */
  compat: Compat;
}

/** @brief 新提供商的草稿：区域按空地址的建议，并发上限为默认值。 */
export function emptyProvider(): ProviderDraft {
  return { name: '', baseUrl: '', api: 'openai-completions', zone: suggestZone(''), zoneChosen: false,
    concurrency: String(MODEL_LIMITS.concurrencyDefault), compat: {} };
}

/**
 * @brief 改提供商草稿：新建时你还没手动选过区域，地址一改预选就跟着改（models-settings.md "区域的建议值"）。
 * @param follow 区域随地址变（新建、首次启动）
 */
export function providerPatch(draft: ProviderDraft, patch: Partial<ProviderDraft>, follow: boolean):
  Partial<ProviderDraft> {
  if (patch.zone !== undefined) return { ...patch, zoneChosen: true };
  if (patch.baseUrl !== undefined && follow && !draft.zoneChosen) {
    return { ...patch, zone: suggestZone(patch.baseUrl) };
  }
  return patch;
}

/** @brief 提供商字段的检查（§4.1）。 */
export function providerErrors(draft: ProviderDraft): FieldErrors {
  const concurrency = positiveInt(draft.concurrency);
  return {
    name: draft.name.trim() ? undefined : 'Name is required.',
    baseUrl: ProviderFormSchema.shape.baseUrl.safeParse(draft.baseUrl.trim()).success ? undefined
      : 'Base URL must be an http or https URL.',
    concurrency: concurrency !== null && ConcurrencySchema.safeParse(concurrency).success ? undefined
      : 'Use a whole number from 1 to 64.',
    zone: draft.zone === null ? 'Choose a network zone.' : undefined,
  };
}

/** @brief 检查通过的草稿转成提供商表单（兼容选项只对 openai-completions 生效，别的接口不带）。 */
export function toProviderForm(draft: ProviderDraft): ProviderForm {
  return { name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), api: draft.api, zone: draft.zone ?? 'local',
    concurrency: Number(draft.concurrency), compat: draft.api === 'openai-completions' ? draft.compat : {} };
}

// ---- 模型字段 ----

/** @brief 模型表单的草稿。 */
export interface ModelDraft {
  /** 模型 id */
  id: string;
  /** 上下文窗口（输入框的文字） */
  contextWindow: string;
  /** 最大输出（输入框的文字） */
  maxTokens: string;
  /** 你改过最大输出（之后不再随窗口变） */
  maxChosen: boolean;
  /** 模型族 */
  family: string;
  /** 支持思考 */
  reasoning: boolean;
  /** 图像输入 */
  image: boolean;
  /** 新会话的思考强度 */
  thinkingLevel: ThinkingLevel;
}

/** @brief 新模型的草稿（§9.1、§12）。 */
export function emptyModel(): ModelDraft {
  const contextWindow = String(DEFAULT_WINDOW);
  return { id: '', contextWindow, maxTokens: defaultMaxOutput(contextWindow), maxChosen: false, family: '',
    reasoning: false, image: false, thinkingLevel: DEFAULT_THINKING };
}

/**
 * @brief 已有模型的草稿（Edit）；Max output 不再随窗口变。
 * @param savedLevel models.get 的 thinkingDefaults 里这个模型的新会话强度；没设时为 null（显示默认值）
 */
export function modelDraft(model: ProviderModel, savedLevel: ThinkingLevel | null): ModelDraft {
  return { id: model.id, contextWindow: String(model.contextWindow), maxTokens: String(model.maxTokens),
    maxChosen: true, family: model.family, reasoning: model.reasoning, image: model.input.length > 1,
    thinkingLevel: savedLevel ?? DEFAULT_THINKING };
}

/** @brief 改模型草稿：你没改过 Max output 时它随窗口变。 */
export function modelPatch(draft: ModelDraft, patch: Partial<ModelDraft>): Partial<ModelDraft> {
  if (patch.maxTokens !== undefined) return { ...patch, maxChosen: true };
  if (patch.contextWindow !== undefined && !draft.maxChosen) {
    return { ...patch, maxTokens: defaultMaxOutput(patch.contextWindow) };
  }
  return patch;
}

/**
 * @brief 模型字段的检查（§4.1）。
 * @param otherIds 同一提供商里别的模型的 id（新建时检查重复）
 */
export function modelErrors(draft: ModelDraft, otherIds: readonly string[]): FieldErrors {
  const window = positiveInt(draft.contextWindow);
  const max = positiveInt(draft.maxTokens);
  const idError = !/^\S+$/.test(draft.id) ? 'Model ID must be non-empty and contain no spaces.'
    : otherIds.includes(draft.id) ? 'Model IDs must be unique within a provider.' : undefined;
  const maxError = max === null ? 'Max output must be a whole number above 0.'
    : window !== null && max >= window ? 'Max output must be smaller than the context window.' : undefined;
  const windowError = window === null ? 'Context window must be a whole number above 0.' : undefined;
  return { id: idError, contextWindow: windowError, maxTokens: maxError };
}

/** @brief 草稿转成配置里的模型。 */
export function toModel(draft: ModelDraft): ProviderModel {
  return { id: draft.id, family: draft.family.trim(), contextWindow: Number(draft.contextWindow),
    maxTokens: Number(draft.maxTokens), reasoning: draft.reasoning,
    input: draft.image ? ['text', 'image'] : ['text'] };
}

// ---- 字段 ----

/** @brief 一行：标签、输入控件、字段错误。 */
export function Row({ label, field, error, children }: {
  label: string; field?: string; error?: string; children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="mf-row">
      <label htmlFor={id}>{label}</label>
      <div className="mf-control">{children(id)}{field && <FieldError field={field} error={error} />}</div>
    </div>
  );
}

/** @brief 文字输入框一行。 */
export function TextRow({ label, field, error, value, onChange, ...rest }: {
  label: string; field: string; error?: string; value: string; onChange: (value: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <Row label={label} field={field} error={error}>
      {(id) => <input id={id} value={value} onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined} {...rest} />}
    </Row>
  );
}

/** @brief 接口类型下拉。 */
export function ApiRow({ value, onChange }: { value: ApiType; onChange: (value: ApiType) => void }) {
  return (
    <Row label="API type">
      {(id) => (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value as ApiType)}>
          {API_TYPES.map((api) => <option key={api} value={api}>{API_TYPE_LABELS[api]}</option>)}
        </select>
      )}
    </Row>
  );
}

/** @brief 网络区域单选（name="zone"）；没选时显示 error；note 放在单选下方（首次启动的 Public 说明）。 */
export function ZoneRadios({ value, onChange, note }: {
  value: Zone | null; onChange: (zone: Zone) => void; note?: ReactNode;
}) {
  const error = value === null ? 'Choose a network zone.' : null;
  return (
    <fieldset className="mf-row zone-radios">
      <legend>Network zone</legend>
      <div className="mf-control">
        <div className="radio-line">
          {ZONES.map((zone) => (
            <label key={zone} className="check-row">
              <input type="radio" name="zone" value={zone} checked={value === zone} onChange={() => onChange(zone)} />
              <span>{ZONE_LABELS[zone]}</span>
            </label>
          ))}
        </div>
        <FieldError field="zone" error={error} />
        {note}
      </div>
    </fieldset>
  );
}

/** @brief 兼容选项（只在 API type 为 openai-completions 时显示）：六个勾选框，文字用 §9.1 的英文说明。 */
export function CompatChecks({ api, value, onChange }: {
  api: ApiType; value: Compat; onChange: (compat: Compat) => void;
}) {
  if (api !== 'openai-completions') return null;
  function toggle(field: keyof Compat, on: boolean, written: boolean | string) {
    const { [field]: _removed, ...rest } = value;
    onChange(on ? { ...rest, [field]: written } : rest);
  }
  return (
    <fieldset className="mf-row compat-checks">
      <legend>Compatibility options</legend>
      <div className="mf-control">
        {COMPAT_OPTIONS.map((option) => (
          <label key={option.id} className="check-row">
            <input type="checkbox" checked={value[option.field] !== undefined}
              onChange={(event) => toggle(option.field, event.target.checked, option.value)} />
            <span>{COMPAT_LABELS[option.field]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** @brief 勾选框一行（Supports thinking、Image input）。 */
export function CheckRow({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return (
    <div className="mf-row">
      <span />
      <label className="check-row mf-control">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}</span>
      </label>
    </div>
  );
}

/** @brief 模型字段的参数。 */
export interface ModelFieldsProps {
  /** 草稿 */
  draft: ModelDraft;
  /** 改草稿 */
  edit: (patch: Partial<ModelDraft>) => void;
  /** 显示的字段错误 */
  errors: FieldErrors;
  /** Edit：Model ID 只读 */
  editing: boolean;
  /** 设置页的模型表单另有 Family、Image input；首次启动表单没有 */
  full: boolean;
  /**
   * 显示 Default effort for new sessions（勾了 Supports thinking 时）：设置页的模型表单与新建提供商的第一个模型有，
   * 首次启动表单没有
   */
  thinking: boolean;
}

/** @brief 模型字段：Model ID、Context window、Max output、（Family）、Supports thinking、（Image input、思考强度）。 */
export function ModelFields({ draft, edit, errors, editing, full, thinking }: ModelFieldsProps) {
  const set = (patch: Partial<ModelDraft>) => edit(modelPatch(draft, patch));
  return (
    <>
      <TextRow label="Model ID" field="id" error={errors.id} value={draft.id} readOnly={editing}
        onChange={(id) => set({ id })} spellCheck={false} />
      <TextRow label="Context window" field="contextWindow" error={errors.contextWindow} inputMode="numeric"
        value={draft.contextWindow} onChange={(contextWindow) => set({ contextWindow })} />
      <TextRow label="Max output" field="maxTokens" error={errors.maxTokens} inputMode="numeric"
        value={draft.maxTokens} onChange={(maxTokens) => set({ maxTokens })} />
      {full && <TextRow label="Family" field="family" value={draft.family} placeholder="Optional"
        onChange={(family) => set({ family })} />}
      <CheckRow label="Supports thinking" checked={draft.reasoning} onChange={(reasoning) => set({ reasoning })} />
      {full && <CheckRow label="Image input" checked={draft.image} onChange={(image) => set({ image })} />}
      {thinking && draft.reasoning && (
        <Row label="Default effort for new sessions">
          {(id) => (
            <select id={id} value={draft.thinkingLevel}
              onChange={(event) => set({ thinkingLevel: event.target.value as ThinkingLevel })}>
              {THINKING_LEVELS.map((level) => <option key={level} value={level}>{THINKING_NAMES[level]}</option>)}
            </select>
          )}
        </Row>
      )}
    </>
  );
}
