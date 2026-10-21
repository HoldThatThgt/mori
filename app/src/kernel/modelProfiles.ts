// 模型档案（docs/specs/model-providers.md §7.1、§7.2、§7.4、§7.5）：档案键与指纹、model-profiles.json 的读写、
// 由探针结果派生能力三态与交接写入等级、给界面的 ProfileView，以及选择器第 3 步用的 tool_calling 状态。
// 档案描述的是服务端上的模型（地址、接口、模型 id、服务版本），所以按这几项存，不按 Mori 的提供商 id 存。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type {
  ApiType, Capability, Compat, ProbeProgress, ProbeStepResult, ProfileView, ProviderModel, ReasoningField,
  ServerKind,
} from '../shared/models';
import type { ModelRef, ToolCallingState } from './modelTypes';

/** @brief 探针套件版本（§7.2 suite）；探针的请求或判定改变时加 1。 */
export const PROBE_SUITE = 1;

/** @brief 取不到服务版本时档案键里的版本（§7.1）。 */
export const UNKNOWN_VERSION = 'unknown';

/** @brief 档案对应的服务端模型：配置里一个模型和它的提供商的相关字段。 */
export interface ProfileTarget {
  /** 提供商地址 */
  baseUrl: string;
  /** 接口类型 */
  api: ApiType;
  /** 配置里的模型（id、窗口、最大输出、思考、输入类型） */
  model: ProviderModel;
  /** 提供商的兼容选项 */
  compat: Compat;
}

/** @brief 自动探针（第 0–7 步）各步的结果；第 2 步与第 4 步的回传检查各占一项。 */
export interface AutoSteps {
  /** 第 1 步：有正文 */
  ready: ProbeStepResult;
  /** 第 2 步：思考 off 时没有思考内容为 pass，有为 fail；reasoning 为 false 的模型 not_applicable */
  thinking: ProbeStepResult;
  /** 第 3 步：调用 get_weather，参数类型正确 */
  call: ProbeStepResult;
  /** 第 4 步：回答含 21 */
  result: ProbeStepResult;
  /** 第 4 步的回传检查（openai-completions 且 reasoning 为 true）：pass 为 not_required，fail 为 required */
  replay: ProbeStepResult;
  /** 第 5 步：A 级 */
  a: ProbeStepResult;
  /** 第 6 步：B 级；anthropic-messages 为 not_applicable */
  b: ProbeStepResult;
  /** 第 7 步：C 级；第 5、6 步没有都判定为不通过时 not_run */
  c: ProbeStepResult;
}

/** @brief 一组自动探针（第 0–7 步）的结果，由 probes.ts 给出。 */
export interface AutoResults {
  /** 第 0 步：服务种类与版本；版本取不到时为 unknown */
  server: { kind: ServerKind; version: string };
  /** 第 0 步：服务报告的窗口（/models 的 max_model_len 或 /props 的 n_ctx）；没有时为 null */
  reported: number | null;
  /** 各步的判定 */
  steps: AutoSteps;
  /** 第 1、2、4 步观察到的推理字段名（openai-completions）；没有思考内容时为 none，其他接口为 native */
  field: ReasoningField;
}

/** @brief 长输入探针（第 8 步）的结果。 */
export interface LongInputResult {
  /** 这一步的判定：pass 为得出了 truncation，error 为有一个长度因连接或超时没有结果 */
  step: ProbeStepResult;
  /** 判出的截断方式；出错时为 null（保持原值） */
  truncation: 'none' | 'silent' | null;
  /** silent 时通过的那个长度（token，50% 也没通过时为 0）；其余为 null */
  limit: number | null;
}

/** @brief 取消探针（第 9 步）的结果。 */
export interface CancelResult {
  /** 这一步的判定：长输出请求因连接、HTTP 错误或超时没有收到输出时为 error */
  step: ProbeStepResult;
  /** 断开后服务端是否停止 */
  verified: boolean | 'unknown';
}

/** @brief model-profiles.json 里的一个档案。 */
export interface StoredProfile {
  /** 档案键 <baseUrl>|<api>|<模型 id>|<服务版本>（§7.1） */
  key: string;
  /** 指纹：档案键加配置的窗口、最大输出、思考、输入类型、兼容选项（§7.1） */
  fingerprint: string;
  /** 提供商地址 */
  baseUrl: string;
  /** 接口类型 */
  api: ApiType;
  /** 模型 id */
  modelId: string;
  /** 第 0–7 步的结果 */
  auto: AutoResults;
  /** 第 8 步的结果；没跑过为 null */
  longInput: LongInputResult | null;
  /** 第 9 步的结果；没跑过为 null */
  cancel: CancelResult | null;
  /** 最近一次探测完成的时刻（ms） */
  probedAt: number;
  /** 探针套件版本 */
  suite: number;
}

// ---- 档案键与指纹（§7.1） ----

/**
 * @brief 档案键。
 * @param version 服务版本；取不到时为 null，写成 unknown
 */
export function profileKey(target: ProfileTarget, version: string | null): string {
  return [target.baseUrl, target.api, target.model.id, version ?? UNKNOWN_VERSION].join('|');
}

/** @brief 键排好序的兼容选项，指纹不受字段顺序影响。 */
function sortedCompat(compat: Compat): [string, unknown][] {
  return Object.entries(compat).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * @brief 指纹：档案键加上配置里的 contextWindow、maxTokens、reasoning、input、compat；变了就重新探测（§7.1）。
 * @param version 服务版本；取不到时为 null
 */
export function profileFingerprint(target: ProfileTarget, version: string | null): string {
  const { contextWindow, maxTokens, reasoning, input } = target.model;
  return JSON.stringify([profileKey(target, version), contextWindow, maxTokens, reasoning, input,
    sortedCompat(target.compat)]);
}

/**
 * @brief 按当前配置判断要不要重新探测：没有档案，或指纹（按档案记的服务版本算）变了（§7.1、§7.4）。
 * @param stored 这个模型的档案；没有时为 undefined
 */
export function needsProbe(target: ProfileTarget, stored: StoredProfile | undefined): boolean {
  if (!stored) return true;
  return stored.fingerprint !== profileFingerprint(target, stored.auto.server.version);
}

/**
 * @brief 读到的服务版本是否算版本变化：读失败（null）时档案不变；只有读到与档案不同的版本才算（§7.1）。
 * @param read 这次读到的版本；连接失败、非 2xx、没有版本字段时为 null
 */
export function versionChanged(stored: StoredProfile | undefined, read: string | null): boolean {
  if (!stored || read === null) return false;
  return read !== stored.auto.server.version;
}

// ---- 能力三态与等级（§7.2、§7.3、§7.5） ----

/** @brief tool_calling：第 3、4 步都通过为 verified；有一步判定不成立为 failed；其余（出错、没跑）为 unverified。 */
export function toolCallingOf(call: ProbeStepResult, result: ProbeStepResult): Capability {
  if (call.outcome === 'pass' && result.outcome === 'pass') return 'verified';
  if (call.outcome === 'fail' || result.outcome === 'fail') return 'failed';
  return 'unverified';
}

/** @brief tier：第 5 步通过为 A，否则第 6 步通过为 B，否则第 7 步通过为 C，否则 null（§7.5）。 */
export function tierOf(a: ProbeStepResult, b: ProbeStepResult, c: ProbeStepResult): 'A' | 'B' | 'C' | null {
  if (a.outcome === 'pass') return 'A';
  if (b.outcome === 'pass') return 'B';
  if (c.outcome === 'pass') return 'C';
  return null;
}

/**
 * @brief protocol_write：有等级为 verified；适用的级别都判定为不通过为 failed（不适用的不参与，§7.5）；
 *        有一级因出错或没跑而没有结果为 unverified。
 */
export function protocolWriteOf(a: ProbeStepResult, b: ProbeStepResult, c: ProbeStepResult): Capability {
  if (tierOf(a, b, c) !== null) return 'verified';
  const applicable = [a, b, c].filter((step) => step.outcome !== 'not_applicable');
  return applicable.every((step) => step.outcome === 'fail') ? 'failed' : 'unverified';
}

/** @brief structured_output：第 6 步；anthropic-messages 不跑第 6 步，为 unverified。 */
export function structuredOutputOf(api: ApiType, b: ProbeStepResult): Capability {
  if (api === 'anthropic-messages') return 'unverified';
  if (b.outcome === 'pass') return 'verified';
  return b.outcome === 'fail' ? 'failed' : 'unverified';
}

/** @brief vision：配置声明了图像输入为 unverified，否则 failed（没有图像探针）。 */
export function visionOf(model: ProviderModel): Capability {
  return (model.input as readonly string[]).includes('image') ? 'unverified' : 'failed';
}

/** @brief reasoning：openai-completions 取探针观察到的字段与第 2、4 步；另两种接口为 native、not_required。 */
export function reasoningOf(api: ApiType, auto: AutoResults | null): ProfileView['reasoning'] {
  const thinking = auto?.steps.thinking.outcome;
  const can_disable = thinking === 'pass' ? true : thinking === 'fail' ? false : 'unknown';
  if (api !== 'openai-completions') return { field: 'native', can_disable, replay: 'not_required' };
  const replayStep = auto?.steps.replay.outcome;
  const replay = replayStep === 'pass' ? 'not_required' : replayStep === 'fail' ? 'required' : 'unknown';
  return { field: auto?.field ?? 'none', can_disable, replay };
}

/**
 * @brief context：effective 为 declared 与 reported 中较小的；第 8 步判出静默截断时降到通过的长度。
 * @param reported 服务报告的窗口；没有时为 null
 * @param longInput 第 8 步的结果；没跑过为 null
 */
export function contextOf(model: ProviderModel, reported: number | null,
  longInput: LongInputResult | null): ProfileView['context'] {
  const declared = model.contextWindow;
  let effective = reported === null ? declared : Math.min(declared, reported);
  if (longInput?.truncation === 'silent' && longInput.limit !== null) effective = Math.min(effective, longInput.limit);
  return { declared, reported, effective, truncation: longInput?.truncation ?? 'unknown' };
}

/** @brief cancel_verified：第 9 步；没跑过为 unknown。 */
export function cancelVerifiedOf(cancel: CancelResult | null): boolean | 'unknown' {
  return cancel?.verified ?? 'unknown';
}

/** @brief status：至少一步出错没有结果为 error（附第一条原文），否则 ready。 */
export function statusOf(stored: StoredProfile): { status: 'ready' | 'error'; error: string | null } {
  const steps = [...Object.values(stored.auto.steps), stored.longInput?.step, stored.cancel?.step];
  const failed = steps.find((step) => step?.outcome === 'error');
  return failed ? { status: 'error', error: failed.detail ?? 'Probe failed' } : { status: 'ready', error: null };
}

/** @brief 一步没有跑的结果。 */
function notRun(): ProbeStepResult {
  return { outcome: 'not_run', detail: null };
}

/** @brief 从未完成探测、正在探测的模型的档案（status 为 probing，能力都未验证）。 */
function probingView(target: ProfileTarget): ProfileView {
  const b: ProbeStepResult = target.api === 'anthropic-messages'
    ? { outcome: 'not_applicable', detail: null } : notRun();
  return {
    status: 'probing',
    error: null,
    server: { kind: 'unknown', version: UNKNOWN_VERSION },
    tool_calling: { state: 'unverified', call: notRun(), result: notRun() },
    tier: { level: null, a: notRun(), b, c: notRun() },
    protocol_write: 'unverified',
    structured_output: 'unverified',
    vision: visionOf(target.model),
    reasoning: reasoningOf(target.api, null),
    context: contextOf(target.model, null, null),
    cancel_verified: 'unknown',
    probedAt: null,
    suite: PROBE_SUITE,
  };
}

/** @brief 已有档案的 ProfileView；vision 与 declared 窗口取当前配置。 */
function storedView(target: ProfileTarget, stored: StoredProfile): ProfileView {
  const { steps } = stored.auto;
  return {
    ...statusOf(stored),
    server: stored.auto.server,
    tool_calling: { state: toolCallingOf(steps.call, steps.result), call: steps.call, result: steps.result },
    tier: { level: tierOf(steps.a, steps.b, steps.c), a: steps.a, b: steps.b, c: steps.c },
    protocol_write: protocolWriteOf(steps.a, steps.b, steps.c),
    structured_output: structuredOutputOf(target.api, steps.b),
    vision: visionOf(target.model),
    reasoning: reasoningOf(target.api, stored.auto),
    context: contextOf(target.model, stored.auto.reported, stored.longInput),
    cancel_verified: cancelVerifiedOf(stored.cancel),
    probedAt: stored.probedAt,
    suite: stored.suite,
  };
}

/**
 * @brief 界面看到的档案（§7.2、§7.4）：有档案时按档案（重新探测期间仍是旧结果，界面按 running 显示 Re-verifying…）；
 *        从未完成探测、正在探测时为 probing；两者都不是时为 null（界面显示未验证）。
 * @param running 这个模型正在探测
 */
export function profileView(target: ProfileTarget, stored: StoredProfile | undefined,
  running: boolean): ProfileView | null {
  if (stored) return storedView(target, stored);
  return running ? probingView(target) : null;
}

/**
 * @brief 选择器第 3 步的 tool_calling（§5.3、§7.4）：验证过（verified 或 failed）的模型按档案（重新验证期间按旧结果）；
 *        从未验证过的（没有档案，或档案里是 unverified，例如上次出错）正在探测为 probing，否则 unverified。
 */
export function toolCallingState(stored: StoredProfile | undefined, running: boolean): ToolCallingState {
  const state = stored ? toolCallingOf(stored.auto.steps.call, stored.auto.steps.result) : 'unverified';
  if (state === 'verified' || state === 'failed') return state;
  return running ? 'probing' : 'unverified';
}

// ---- 档案的建立与更新 ----

/** @brief buildProfile 的参数。 */
export interface BuildProfileInput {
  /** 探测的模型 */
  target: ProfileTarget;
  /** 第 0–7 步的结果 */
  auto: AutoResults;
  /** 这个模型原来的档案；没有时为 undefined */
  previous: StoredProfile | undefined;
  /** 当前时刻（ms） */
  now: number;
}

/**
 * @brief 一组自动探针结束后的新档案，替换旧档案（§7.4）。第 8、9 步不在自动探针里：
 *        档案键（含服务版本）没变时沿用旧档案里它们的结果，变了就清掉。
 */
export function buildProfile(input: BuildProfileInput): StoredProfile {
  const { target, auto, previous, now } = input;
  const key = profileKey(target, auto.server.version);
  const keep = previous?.key === key;
  return {
    key, fingerprint: profileFingerprint(target, auto.server.version),
    baseUrl: target.baseUrl, api: target.api, modelId: target.model.id, auto,
    longInput: keep ? previous.longInput : null, cancel: keep ? previous.cancel : null,
    probedAt: now, suite: PROBE_SUITE,
  };
}

/** @brief 记下第 8 步的结果。 */
export function withLongInput(stored: StoredProfile, result: LongInputResult, now: number): StoredProfile {
  const kept = result.truncation === null ? stored.longInput : null;
  const longInput = kept ? { ...kept, step: result.step } : result;
  return { ...stored, longInput, probedAt: now };
}

/** @brief 记下第 9 步的结果。 */
export function withCancel(stored: StoredProfile, result: CancelResult, now: number): StoredProfile {
  return { ...stored, cancel: result, probedAt: now };
}

// ---- model-profiles.json ----

const StepSchema = z.object({
  outcome: z.enum(['pass', 'fail', 'error', 'not_applicable', 'not_run']),
  detail: z.string().nullable(),
});

const StoredProfileSchema = z.object({
  key: z.string(),
  fingerprint: z.string(),
  baseUrl: z.string(),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  modelId: z.string(),
  auto: z.object({
    server: z.object({ kind: z.enum(['vllm', 'sglang', 'ollama', 'llamacpp', 'unknown']), version: z.string() }),
    reported: z.number().int().positive().nullable(),
    steps: z.object({ ready: StepSchema, thinking: StepSchema, call: StepSchema, result: StepSchema,
      replay: StepSchema, a: StepSchema, b: StepSchema, c: StepSchema }),
    field: z.enum(['reasoning_content', 'reasoning', 'reasoning_text', 'none', 'native']),
  }),
  longInput: z.object({ step: StepSchema, truncation: z.enum(['none', 'silent']).nullable(),
    limit: z.number().int().min(0).nullable() }).nullable(),
  cancel: z.object({ step: StepSchema, verified: z.union([z.boolean(), z.literal('unknown')]) }).nullable(),
  probedAt: z.number(),
  suite: z.number().int(),
});

/** @brief 文件格式版本。 */
const FILE_VERSION = 1;

/**
 * @brief 读档案文件，宽容：文件不存在为空；不是合法 JSON、格式不对时记错误日志并当作空；不合格的单个档案跳过。
 * @return 档案列表
 */
export async function readProfiles(path: string): Promise<StoredProfile[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] cannot read ${path}: ${(error as Error).message}`);
    }
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    console.error(`[kernel] ${path} is not valid JSON, ignoring it: ${(error as Error).message}`);
    return [];
  }
  const list = (data as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(list)) {
    console.error(`[kernel] ${path} has no profiles list, ignoring it`);
    return [];
  }
  return parseEntries(path, list);
}

/** @brief 逐个校验档案，跳过不合格的并记日志。 */
function parseEntries(path: string, list: unknown[]): StoredProfile[] {
  const profiles: StoredProfile[] = [];
  for (const [index, entry] of list.entries()) {
    const parsed = StoredProfileSchema.safeParse(entry);
    if (parsed.success) profiles.push(parsed.data);
    else {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      console.error(`[kernel] ${path}: skipping invalid profile ${index}: ${issues}`);
    }
  }
  return profiles;
}

/**
 * @brief 原子写档案文件：先写临时文件再改名；目录不存在时先创建。
 * @param profiles 全部档案
 */
export async function writeProfiles(path: string, profiles: readonly StoredProfile[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: FILE_VERSION, profiles }, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/** @brief 同一个服务端模型（地址、接口、模型 id）只留一个档案，不论服务版本。 */
function sameModel(stored: StoredProfile, target: ProfileTarget): boolean {
  return stored.baseUrl === target.baseUrl && stored.api === target.api && stored.modelId === target.model.id;
}

/** @brief ProfileBook 的参数。 */
export interface ProfileBookOptions {
  /** model-profiles.json 的路径 */
  path: string;
  /**
   * @brief 按当前配置找到 <provider>/<model> 对应的服务端模型。
   * @return 配置里没有时为 null
   */
  resolve(ref: ModelRef): ProfileTarget | null;
}

/** @brief 全部档案与正在跑的探针：读写 model-profiles.json，给选择器和界面查询。 */
export class ProfileBook {
  private profiles: StoredProfile[] = [];
  private readonly progress = new Map<ModelRef, ProbeProgress>();
  private writing: Promise<void> = Promise.resolve();

  /** @param options 文件路径与 ref 的解析 */
  constructor(private readonly options: ProfileBookOptions) {}

  /** @brief 从文件载入（宽容，见 readProfiles）。 */
  async load(): Promise<void> {
    this.profiles = await readProfiles(this.options.path);
  }

  /** @brief 这个服务端模型的档案；没有时为 undefined。 */
  lookup(target: ProfileTarget): StoredProfile | undefined {
    return this.profiles.find((stored) => sameModel(stored, target));
  }

  /** @brief 按 ref 查档案；配置里没有这个 ref 或没有档案时为 undefined。 */
  lookupRef(ref: ModelRef): StoredProfile | undefined {
    const target = this.options.resolve(ref);
    return target ? this.lookup(target) : undefined;
  }

  /**
   * @brief 保存一个档案，替换同一服务端模型的旧档案，再原子写文件；写入按调用顺序排队。
   * @return 写完文件后结束；写失败时抛出
   */
  save(profile: StoredProfile): Promise<void> {
    this.profiles = [...this.profiles.filter((stored) => stored.baseUrl !== profile.baseUrl
      || stored.api !== profile.api || stored.modelId !== profile.modelId), profile];
    const snapshot = this.profiles;
    const write = this.writing.then(() => writeProfiles(this.options.path, snapshot));
    this.writing = write.catch((error: Error) => {
      console.error(`[kernel] cannot write ${this.options.path}: ${error.message}`);
    });
    return write;
  }

  /**
   * @brief 记下探针进度（mori.profiles 的 running）。
   * @param step 正在跑的步
   * @param of 这组共几步
   */
  setRunning(ref: ModelRef, step: number, of: number): void {
    this.progress.set(ref, { ref, step, of });
  }

  /** @brief 这个模型的探针结束或被取消。 */
  clearRunning(ref: ModelRef): void {
    this.progress.delete(ref);
  }

  /** @brief 这个模型正在探测。 */
  isRunning(ref: ModelRef): boolean {
    return this.progress.has(ref);
  }

  /** @brief 正在跑的探针。 */
  running(): ProbeProgress[] {
    return [...this.progress.values()];
  }

  /** @brief 选择器第 3 步（§5.3）：配置里没有的 ref 为 unverified（第 1 步已排除它）。 */
  toolCallingFor(ref: ModelRef): ToolCallingState {
    const target = this.options.resolve(ref);
    if (!target) return 'unverified';
    return toolCallingState(this.lookup(target), this.isRunning(ref));
  }

  /**
   * @brief 界面的档案（mori.profiles、models.get）。
   * @param refs 配置里的全部模型
   * @return 没有档案、也不在探测的模型不出现
   */
  views(refs: readonly ModelRef[]): Record<ModelRef, ProfileView> {
    const out: Record<ModelRef, ProfileView> = {};
    for (const ref of refs) {
      const target = this.options.resolve(ref);
      if (!target) continue;
      const view = profileView(target, this.lookup(target), this.isRunning(ref));
      if (view) out[ref] = view;
    }
    return out;
  }
}
