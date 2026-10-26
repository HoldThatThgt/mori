// 提供商表单、模型表单、首次启动表单与拉取模型的清单共用的字段与界面先做的检查
// （docs/v1/screens/models-settings.md "字段错误的文字"，规格 §4.1、§9.1、§12；清单的行与 Add a model ID 用同一组检查，
// docs/specs/model-discovery.md §6.2、§6.4）。字段值按输入框的文字保存，检查通过后再转成配置里的类型。

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import {
  API_TYPE_LABELS, API_TYPES, COMPAT_HINTS, COMPAT_LABELS, COMPAT_OPTIONS, ConcurrencySchema, MODEL_LIMITS,
  ProviderFormSchema, THINKING_LEVELS, UNREPORTED_CONTEXT_WINDOW, unreportedMaxTokens,
  type ApiType, type Compat, type CompatField, type ProviderForm, type ProviderModel, type ThinkingLevel,
} from '../../../../shared/models';
import { FieldError } from './common';

/** @brief 思考强度的英文界面文字（models-settings.md "模型表单"）。 */
export const THINKING_NAMES: Readonly<Record<ThinkingLevel, string>> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

/**
 * Edit 里这个模型没设过强度、config.get 也没有 defaultThinkingLevel 时显示的强度（拉取规格 §5.4"没有时 Medium"；
 * models-settings.md "模型表单（Edit）"没设过强度一行）
 */
const DEFAULT_THINKING: ThinkingLevel = 'medium';

/**
 * @brief 没报告时的 Max output：16384 与窗口一半中较小的（§12；model-discovery.md §4.3、§11，规则取自 shared/models.ts
 *        的 unreportedMaxTokens，与读取器共用一份）；窗口不是正整数时按没报告的窗口（UNREPORTED_CONTEXT_WINDOW）算，
 *        为 16384。
 */
export function defaultMaxOutput(window: string): string {
  return String(unreportedMaxTokens(positiveInt(window) ?? UNREPORTED_CONTEXT_WINDOW));
}

/** @brief 输入框的文字是正整数时返回它，否则为 null。 */
export function positiveInt(text: string): number | null {
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

/** @brief useDraft 的返回值：草稿、改草稿（setDraft 不算改过）、改过的字段与 edit（算改过）。 */
export type DraftForm<T extends object> = ReturnType<typeof useDraft<T>>;

/**
 * @brief 表单还开着没有（current 为真表示还挂着）。设置页同一时刻只开一张表单，打开别的就关掉它
 *        （models-settings.md "卡上的 Fetch models"）：写命令返回时表单已被换掉，就不再关表单，
 *        免得关掉换上来的那张、或因此取消那张卡上的拉取。
 */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
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
  /** 每个 key 的并发上限（输入框的文字） */
  concurrency: string;
  /** 兼容选项 */
  compat: Compat;
}

/** @brief 新提供商的草稿：并发上限为默认值。 */
export function emptyProvider(): ProviderDraft {
  return { name: '', baseUrl: '', api: 'openai-completions', concurrency: String(MODEL_LIMITS.concurrencyDefault),
    compat: {} };
}

/**
 * @brief 地址的 origin（协议、主机、端口）；不是合法 URL 时为 null。Edit 提供商按它判断要不要先确认删除 key
 *        （§4.1）；首次启动表单按它判断内存里的 key 用不用（拉取规格 §6.6，2026-10-23 负责人决定）。
 */
export function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
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
  };
}

/** @brief 检查通过的草稿转成提供商表单（兼容选项只对 openai-completions 生效，别的接口不带）。 */
export function toProviderForm(draft: ProviderDraft): ProviderForm {
  return { name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), api: draft.api,
    concurrency: Number(draft.concurrency), compat: draft.api === 'openai-completions' ? draft.compat : {} };
}

// ---- 模型字段 ----

/** @brief 模型表单（Edit）的草稿。 */
export interface ModelDraft {
  /** 模型 id（只读） */
  id: string;
  /** 上下文窗口（输入框的文字） */
  contextWindow: string;
  /** 最大输出（输入框的文字；不随窗口变） */
  maxTokens: string;
  /** 模型族 */
  family: string;
  /** 支持思考 */
  reasoning: boolean;
  /** 图像输入 */
  image: boolean;
  /** 新会话的思考强度 */
  thinkingLevel: ThinkingLevel;
}

/**
 * @brief 已有模型的草稿（Edit，拉取规格 §5.4；models-settings.md "模型表单（Edit）"）；Max output 不随窗口变。
 * @param savedLevel 要显示的新会话强度：thinkingDefaults 里这个模型的值，没设过时 config.get 的 defaultThinkingLevel；
 *        都没有时为 null（显示 Medium）
 */
export function modelDraft(model: ProviderModel, savedLevel: ThinkingLevel | null): ModelDraft {
  return { id: model.id, contextWindow: String(model.contextWindow), maxTokens: String(model.maxTokens),
    family: model.family, reasoning: model.reasoning, image: model.input.length > 1,
    thinkingLevel: savedLevel ?? DEFAULT_THINKING };
}

/**
 * @brief 模型 id 的检查（§4.1）：非空、不含空白，与 otherIds 不重复。清单的 Add a model ID 用它
 *        （model-discovery.md §6.4）；模型表单（Edit）的 Model ID 只读，不查。
 * @param otherIds 不能重复的 id（清单的全部行与这个提供商已有的模型）
 * @return 错误文字；没有错误时为 undefined
 */
export function idError(id: string, otherIds: readonly string[]): string | undefined {
  if (!/^\S+$/.test(id)) return 'Model ID must be non-empty and contain no spaces.';
  return otherIds.includes(id) ? 'Model IDs must be unique within a provider.' : undefined;
}

/**
 * @brief 窗口与 Max output 的检查（§4.1）：都是正整数，Max output 小于窗口。模型表单与清单的行共用
 *        （model-discovery.md §6.2）。
 * @param contextWindow 窗口输入框的文字
 * @param maxTokens Max output 输入框的文字
 */
export function sizeErrors(contextWindow: string, maxTokens: string): FieldErrors {
  const window = positiveInt(contextWindow);
  const max = positiveInt(maxTokens);
  const maxError = max === null ? 'Max output must be a whole number above 0.'
    : window !== null && max >= window ? 'Max output must be smaller than the context window.' : undefined;
  const windowError = window === null ? 'Context window must be a whole number above 0.' : undefined;
  return { contextWindow: windowError, maxTokens: maxError };
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

/**
 * 兼容选项上面的一行说明（2026-10-26 负责人走查 M1，models-settings.md "提供商表单：Edit"，临时，走查时可以改）：
 * pi 按地址认出 DeepSeek 等服务、自己调整请求，所以拉取模型不会也不必勾这些选项
 */
const COMPAT_NOTE = 'Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if '
  + 'this server rejects requests.';

/**
 * @brief 兼容选项（只在 API type 为 openai-completions 时显示）：上面一行说明，五个勾选框，标签和下面一行说明用 §9.1 的英文。
 *        value 里没有勾选框的字段（存着的 supportsStrictMode）原样留着。
 */
export function CompatChecks({ api, value, onChange }: {
  api: ApiType; value: Compat; onChange: (compat: Compat) => void;
}) {
  if (api !== 'openai-completions') return null;
  function toggle(field: CompatField, on: boolean, written: boolean | string) {
    const { [field]: _removed, ...rest } = value;
    onChange(on ? { ...rest, [field]: written } : rest);
  }
  return (
    <fieldset className="mf-row compat-checks">
      <legend>Compatibility options</legend>
      <div className="mf-control">
        <p className="field-hint" data-testid="compat-hint">{COMPAT_NOTE}</p>
        {COMPAT_OPTIONS.map((option) => (
          <label key={option.id} className="check-row">
            <input type="checkbox" checked={value[option.field] !== undefined}
              onChange={(event) => toggle(option.field, event.target.checked, option.value)} />
            <span>{COMPAT_LABELS[option.field]}<small>{COMPAT_HINTS[option.field]}</small></span>
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
  /** 显示的字段错误（Context window、Max output） */
  errors: FieldErrors;
  /**
   * 这个模型思考关不掉（档案 reasoning.off_refused，规格 §7.7）：Default effort for new sessions 不列 Off，
   * 草稿是 off 时显示 Minimal（草稿仍是 off，只有改选才写）
   */
  noOff: boolean;
}

/**
 * @brief 模型表单（Edit）的字段（models-settings.md "模型表单（Edit）"）：Model ID（只读）、Context window、
 *        Max output（不随窗口变）、Family、Supports thinking、Image input、Default effort for new sessions
 *        （勾了 Supports thinking 时；noOff 时没有 Off，存着的 Off 显示为 Minimal，§7.7）。
 */
export function ModelFields({ draft, edit, errors, noOff }: ModelFieldsProps) {
  // §7.7：pi 对这个模型把 Off 提到 Minimal，所以显示 Minimal；存着的 off 不改写
  const levels = noOff ? THINKING_LEVELS.filter((level) => level !== 'off') : THINKING_LEVELS;
  const shown = noOff && draft.thinkingLevel === 'off' ? 'minimal' : draft.thinkingLevel;
  return (
    <>
      <Row label="Model ID">{(id) => <input id={id} value={draft.id} readOnly spellCheck={false} />}</Row>
      <TextRow label="Context window" field="contextWindow" error={errors.contextWindow} inputMode="numeric"
        value={draft.contextWindow} onChange={(contextWindow) => edit({ contextWindow })} />
      <TextRow label="Max output" field="maxTokens" error={errors.maxTokens} inputMode="numeric"
        value={draft.maxTokens} onChange={(maxTokens) => edit({ maxTokens })} />
      <TextRow label="Family" field="family" value={draft.family} placeholder="Optional"
        onChange={(family) => edit({ family })} />
      <CheckRow label="Supports thinking" checked={draft.reasoning} onChange={(reasoning) => edit({ reasoning })} />
      <CheckRow label="Image input" checked={draft.image} onChange={(image) => edit({ image })} />
      {draft.reasoning && (
        <Row label="Default effort for new sessions">
          {(id) => (
            <select id={id} value={shown}
              onChange={(event) => edit({ thinkingLevel: event.target.value as ThinkingLevel })}>
              {levels.map((level) => <option key={level} value={level}>{THINKING_NAMES[level]}</option>)}
            </select>
          )}
        </Row>
      )}
    </>
  );
}
