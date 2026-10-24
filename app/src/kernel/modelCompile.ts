// 编译到 pi（docs/specs/model-providers.md §4.4、§7.6、§7.7）：把 model-config.json 的提供商与模型注册成 pi 的提供商，
// 按档案设 §7.6 表里的适配（reasoning.replay 为 required 时回传推理内容；reasoning.off_refused 为真时模型带
// thinkingLevelMap: { off: null }，告诉 pi 这个模型没有 Off，§7.7），配置里删掉的提供商从 pi 去掉，出错时回滚。
// 纯函数（providerInput、compileInputs、compilePlan、rollbackPlan）不碰 pi，单元测试直接检查（MP-02）；
// ModelCompiler 记住上一次成功注册的内容，只重新注册本次改动过的提供商。

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Compat, ModelConfig, ModelProvider, ProviderModel } from '../shared/models';

/** @brief pi 的 registerProvider 的第二个参数（pi-coding-agent 没有从包入口导出这个类型）。 */
export type ProviderInput = Parameters<ModelRuntime['registerProvider']>[1];

/** @brief pi 里一个模型的注册内容。 */
export type ModelInput = NonNullable<ProviderInput['models']>[number];

/** @brief 档案给一个模型的编译项（§7.6 的表）。 */
export interface CompileFlags {
  /** 档案的 reasoning.replay 为 required：compat.requiresReasoningContentOnAssistantMessages 设为 true */
  replayRequired: boolean;
  /** 档案的 reasoning.off_refused 为真（§7.7）：模型带 thinkingLevelMap: { off: null } */
  offRefused: boolean;
}

/**
 * @brief 查某个模型的档案给出的编译项（§7.6）；没有档案时两项都为 false。
 * @param provider 模型所在的提供商（按要编译的配置）
 * @param model 模型
 */
export type ProfileLookup = (provider: ModelProvider, model: ProviderModel) => CompileFlags;

/** @brief 编译用到的 pi 运行时操作（ModelRuntime 的子集，测试可以用替身）。 */
export interface CompileRuntime {
  /** @brief 注册或重新注册一个提供商（pi 自己发起的刷新不等待，见 §11.6 K9）。 */
  registerProvider(providerId: string, input: ProviderInput): void;
  /** @brief 去掉一个提供商。 */
  unregisterProvider(providerId: string): void;
  /** @brief 刷新模型快照；编译每次都 await 它（§4.4 第 4 步）。 */
  refresh(options: { allowNetwork: false }): Promise<unknown>;
}

/** @brief 一次编译要做的事：按顺序注册（新增或改动的）、去掉（配置里删掉的）。 */
export interface CompilePlan {
  /** 要注册的提供商 id 与注册内容 */
  register: [string, ProviderInput][];
  /** 要 unregisterProvider 的提供商 id */
  unregister: string[];
}

/** @brief 模型的费用：Mori 不计费，全 0（§4.4 第 2 步）。 */
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * @brief 一个模型的 compat（§4.4 第 2 步、§7.6）：配置里的六个字段，加上档案给出的
 *        requiresReasoningContentOnAssistantMessages；只对 openai-completions 生效，其余接口不写。
 * @param provider 提供商
 * @param model 模型
 * @param lookup 查档案给出的编译项（这里只用 replayRequired）
 * @return compat；不写时为 undefined
 */
export function modelCompat(provider: ModelProvider, model: ProviderModel,
  lookup: ProfileLookup): (Compat & { requiresReasoningContentOnAssistantMessages?: boolean }) | undefined {
  if (provider.api !== 'openai-completions') return undefined;
  const compat: Compat & { requiresReasoningContentOnAssistantMessages?: boolean } = { ...provider.compat };
  if (lookup(provider, model).replayRequired) compat.requiresReasoningContentOnAssistantMessages = true;
  return Object.keys(compat).length > 0 ? compat : undefined;
}

/**
 * @brief 一个模型的注册内容：id、name（= id）、api、input、reasoning、contextWindow、maxTokens、cost（全 0）、compat，
 *        档案 reasoning.off_refused 为真时另带 thinkingLevelMap: { off: null }（§7.7）。
 * @param provider 提供商
 * @param model 模型
 * @param lookup 查档案给出的编译项（§7.6）
 */
export function modelInput(provider: ModelProvider, model: ProviderModel, lookup: ProfileLookup): ModelInput {
  const input: ModelInput = {
    id: model.id, name: model.id, api: provider.api, input: [...model.input], reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: { ...ZERO_COST },
  };
  const compat = modelCompat(provider, model, lookup);
  if (compat) (input as { compat?: unknown }).compat = compat;
  // §7.7：pi 自己的“这一档不支持”的写法；写在模型上、三种接口都写，不放进 compat；每个模型一个新对象
  if (lookup(provider, model).offRefused) (input as { thinkingLevelMap?: unknown }).thinkingLevelMap = { off: null };
  return input;
}

/**
 * @brief 一个提供商的注册内容（§4.4 第 2 步）：apiKey 是不保密的占位，只让 pi 把提供商当作已配置（§11.6 K1）；
 *        真正的 key 由模型池在发请求时写进认证头（§8.4）。
 * @param provider 提供商
 * @param lookup 查档案给出的编译项（§7.6）
 * @param placeholderApiKey 占位 key（§12 的 mori-pool）
 */
export function providerInput(provider: ModelProvider, lookup: ProfileLookup,
  placeholderApiKey: string): ProviderInput {
  return {
    name: provider.name, baseUrl: provider.baseUrl, api: provider.api, apiKey: placeholderApiKey,
    models: provider.models.map((model) => modelInput(provider, model, lookup)),
  };
}

/**
 * @brief 整个配置的注册内容，按提供商 id。
 * @param config 配置；读不出或不存在时为 null（没有提供商）
 * @param lookup 查档案给出的编译项（§7.6）
 * @param placeholderApiKey 占位 key
 */
export function compileInputs(config: ModelConfig | null, lookup: ProfileLookup,
  placeholderApiKey: string): Map<string, ProviderInput> {
  const inputs = new Map<string, ProviderInput>();
  for (const provider of config?.providers ?? []) {
    inputs.set(provider.id, providerInput(provider, lookup, placeholderApiKey));
  }
  return inputs;
}

/** @brief 两份注册内容是否相同。 */
function sameInput(a: ProviderInput, b: ProviderInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @brief 编译计划（§4.4 第 2、3 步）：新增或内容变了的提供商注册，已注册而配置里没有的 unregisterProvider；
 *        内容没变的不动。
 * @param next 要编译成的注册内容
 * @param current 上一次成功注册的内容
 */
export function compilePlan(next: ReadonlyMap<string, ProviderInput>,
  current: ReadonlyMap<string, ProviderInput>): CompilePlan {
  const register: [string, ProviderInput][] = [];
  for (const [id, input] of next) {
    const before = current.get(id);
    if (!before || !sameInput(before, input)) register.push([id, input]);
  }
  const unregister = [...current.keys()].filter((id) => !next.has(id));
  return { register, unregister };
}

/**
 * @brief 回滚计划（§4.4 第 5 步）：用旧的注册内容把本次改动过的提供商恢复——本次注册过的、原来就有的重新按旧内容注册，
 *        原来没有的（新增的）unregisterProvider；本次去掉的重新注册。
 * @param plan 出错的那次编译计划
 * @param current 编译之前成功注册的内容
 */
export function rollbackPlan(plan: CompilePlan, current: ReadonlyMap<string, ProviderInput>): CompilePlan {
  const register: [string, ProviderInput][] = [];
  const unregister: string[] = [];
  for (const [id] of plan.register) {
    const before = current.get(id);
    if (before) register.push([id, before]);
    else unregister.push(id);
  }
  for (const id of plan.unregister) {
    const before = current.get(id);
    if (before) register.push([id, before]);
  }
  return { register, unregister };
}

/**
 * @brief 按计划注册、去掉，再 await 刷新（§4.4 第 2–4 步）。第一个出错的操作抛出，之后的不再做。
 * @param runtime pi 的运行时
 * @param plan 编译计划
 */
export async function applyPlan(runtime: CompileRuntime, plan: CompilePlan): Promise<void> {
  for (const [id, input] of plan.register) runtime.registerProvider(id, input);
  for (const id of plan.unregister) runtime.unregisterProvider(id);
  await runtime.refresh({ allowNetwork: false });
}

/**
 * @brief 尽力执行回滚计划：每个操作单独 try，出错只记录，最后刷新。
 * @param runtime pi 的运行时
 * @param plan 回滚计划
 */
async function applyRollback(runtime: CompileRuntime, plan: CompilePlan): Promise<void> {
  const attempt = (what: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      console.error(`[kernel] rollback: cannot ${what}: ${(error as Error).message}`);
    }
  };
  for (const [id, input] of plan.register) attempt(`register ${id}`, () => runtime.registerProvider(id, input));
  for (const id of plan.unregister) attempt(`unregister ${id}`, () => runtime.unregisterProvider(id));
  try {
    await runtime.refresh({ allowNetwork: false });
  } catch (error) {
    console.error(`[kernel] rollback: refresh failed: ${(error as Error).message}`);
  }
}

/** @brief 把配置编译到 pi 并记住成功注册的内容；同一个后台进程只有一个，由 modelLayer.ts 持有。 */
export class ModelCompiler {
  private registered = new Map<string, ProviderInput>();

  /**
   * @param runtime pi 的运行时
   * @param placeholderApiKey 注册到 pi 的占位 key（§12）
   */
  constructor(private readonly runtime: CompileRuntime, private readonly placeholderApiKey: string) {}

  /**
   * @brief 编译一份配置（§4.4）：只重新注册改动过的提供商，去掉删掉的，再 await 刷新。
   *        pi 抛错时按旧内容回滚（§4.4 第 5 步）并抛出原错误，记住的内容不变。
   * @param config 要编译的配置；null 表示没有提供商
   * @param lookup 查档案给出的编译项（§7.6）
   * @throws pi 拒绝注册或刷新失败时的原错误
   */
  async compile(config: ModelConfig | null, lookup: ProfileLookup): Promise<void> {
    const next = compileInputs(config, lookup, this.placeholderApiKey);
    const plan = compilePlan(next, this.registered);
    if (plan.register.length === 0 && plan.unregister.length === 0) return;
    try {
      await applyPlan(this.runtime, plan);
    } catch (error) {
      console.error(`[kernel] cannot compile the model settings into pi: ${(error as Error).message}`);
      await applyRollback(this.runtime, rollbackPlan(plan, this.registered));
      throw error;
    }
    this.registered = next;
  }

  /** @brief 上一次成功注册的提供商 id。 */
  registeredIds(): string[] {
    return [...this.registered.keys()];
  }
}
