// 设置 → Models 模型行上数字的标记与提示（docs/specs/model-discovery.md §8；docs/v1/screens/models-settings.md
// “Models 行”“模型行的提示”）：纯函数，ModelRows.tsx 用，单元测试（tests/unit/discovery/row-marks.test.mjs）直接测。
// “(default)”：服务没报告、值仍是 Mori 的默认值（2026-10-26 负责人走查 M6）；“(from pi)”与表的后三行：服务没报告、
// 按地址取自 pi 自带模型表的值（档案的 catalog，2026-10-26 负责人走查回答 1，WP-15）。

import {
  UNREPORTED_CONTEXT_WINDOW, unreportedMaxTokens, type ApiType, type CatalogValues, type ProfileView,
  type ProviderModel, type ReportedValues,
} from '../../../../shared/models';
import { thousands } from './format';

/** @brief 模型行的一条提示（拉取规格 §8）：报告值、实测值或 pi 的值与配置不一致时一行小字和 Use。 */
export interface ModelHint {
  /**
   * data-kind：context、max-output、reasoning、thinking-seen、image、pi-context、pi-max-output、pi-reasoning，
   * 依次是拉取规格 §8 表的八行
   */
  kind: 'context' | 'max-output' | 'reasoning' | 'thinking-seen' | 'image' | 'pi-context' | 'pi-max-output'
    | 'pi-reasoning';
  /** 一行小字（数字按千分位写） */
  text: string;
  /** Use 保存的模型：按拉取规格 §8 表改过的配置 */
  model: ProviderModel;
}

/** @brief 数字后面的标记：default 为“(default)”，pi 为“(from pi)”，null 为不标。 */
export type ValueMark = 'default' | 'pi' | null;

/** @brief 模型行说明一行里的标记（拉取规格 §8）。 */
export interface ValueMarks {
  /** Context window 后面 */
  contextWindow: ValueMark;
  /** Max output 后面 */
  maxTokens: ValueMark;
  /** “Supports thinking”后面写“(from pi)” */
  reasoning: boolean;
}

/**
 * @brief “(from pi)”的悬停说明（models-settings.md “Models 行”，临时，走查时可以改）。
 * @param provider pi 的提供商显示名（catalog.provider）
 */
export function piRowTitle(provider: string): string {
  return `The server didn’t report this, so Mori used pi’s model list for ${provider}. `
    + 'Use Edit to set the real value.';
}

/**
 * @brief 窗口与 Max output 后面的标记（拉取规格 §8）：档案的 catalog 有这一项、配置的值等于它时为 pi；否则服务没报告、
 *        配置的值仍是 Mori 的默认值（窗口 128000；Max output 为 16384 与配置窗口一半中较小的）时为 default。
 *        档案的 reported 为 null（旧档案、还没有档案）时 catalog 也为 null，都不标。
 * @param profile 这个模型的档案；还没有时为 null
 */
export function valueMarks(model: ProviderModel, profile: ProfileView | null): ValueMarks {
  const reported = profile?.reported ?? null;
  const catalog = profile?.catalog ?? null;
  const mark = (unreported: boolean, pi: number | null | undefined, value: number, fallback: number): ValueMark => {
    if (pi !== null && pi !== undefined && pi === value) return 'pi';
    return unreported && value === fallback ? 'default' : null;
  };
  return {
    contextWindow: mark(reported?.contextWindow === null, catalog?.contextWindow, model.contextWindow,
      UNREPORTED_CONTEXT_WINDOW),
    maxTokens: mark(reported?.maxTokens === null, catalog?.maxTokens, model.maxTokens,
      unreportedMaxTokens(model.contextWindow)),
    reasoning: catalog?.reasoning === true && model.reasoning,
  };
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
 * @brief 拉取规格 §8 表的后三行（2026-10-26，WP-15）：pi 的值与配置不同，并且配置的值仍是 Mori 的默认值（你设过的值
 *        不提示改成 pi 的）；窗口的 Use 同第一行，Max output 只在小于配置的窗口时提示。
 */
function piHints(model: ProviderModel, catalog: CatalogValues): ModelHint[] {
  const hints: ModelHint[] = [];
  const lead = `pi’s model list for ${catalog.provider}`;
  const window = catalog.contextWindow;
  if (window !== null && window !== model.contextWindow && model.contextWindow === UNREPORTED_CONTEXT_WINDOW) {
    const maxTokens = model.maxTokens >= window ? unreportedMaxTokens(window) : model.maxTokens;
    hints.push({ kind: 'pi-context', text: `${lead} has a context window of ${thousands(window)}.`,
      model: { ...model, contextWindow: window, maxTokens } });
  }
  const max = catalog.maxTokens;
  if (max !== null && max !== model.maxTokens && max < model.contextWindow
    && model.maxTokens === unreportedMaxTokens(model.contextWindow)) {
    hints.push({ kind: 'pi-max-output', text: `${lead} has max output of ${thousands(max)}.`,
      model: { ...model, maxTokens: max } });
  }
  if (catalog.reasoning && !model.reasoning) {
    hints.push({ kind: 'pi-reasoning', text: `${lead} says this model supports thinking.`,
      model: { ...model, reasoning: true } });
  }
  return hints;
}

/**
 * @brief 模型行的提示（拉取规格 §8），按表的顺序。档案的 reported 为 null（旧档案、还没有档案）时只可能有第四行：
 *        它只看档案的推理字段，把“reported.reasoning 不为真”当作成立；档案的 catalog 说支持思考时第四行不出，
 *        同一件事只提示一条（pi 的那一条）。
 * @param api 提供商的接口
 * @param profile 这个模型的档案；还没有时为 null
 */
export function modelHints(api: ApiType, model: ProviderModel, profile: ProfileView | null): ModelHint[] {
  const reported = profile?.reported ?? null;
  const catalog = profile?.catalog ?? null;
  const thinking: ProviderModel = { ...model, reasoning: true };
  const hints = reported ? sizeHints(model, reported) : [];
  if (reported?.reasoning === true && !model.reasoning) {
    hints.push({ kind: 'reasoning', text: 'The server says this model supports thinking.', model: thinking });
  }
  if (api === 'openai-completions' && profile !== null && profile.reasoning.field !== 'none' && !model.reasoning
    && reported?.reasoning !== true && catalog?.reasoning !== true) {
    hints.push({ kind: 'thinking-seen', text: 'This model returned thinking content.', model: thinking });
  }
  // 配置的 input 只有 text 时没勾 Image input
  if (reported?.image === true && model.input.length === 1) {
    hints.push({ kind: 'image', text: 'The server says this model accepts images.',
      model: { ...model, input: ['text', 'image'] } });
  }
  return catalog ? [...hints, ...piHints(model, catalog)] : hints;
}
