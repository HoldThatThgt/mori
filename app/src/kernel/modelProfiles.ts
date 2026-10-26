// 模型档案（docs/specs/model-providers.md §7.1、§7.2、§7.4、§7.5）：档案键与指纹、model-profiles.json 的读写、
// 由探针结果派生能力三态与交接写入等级、给界面的 ProfileView，以及选择器第 3 步用的 tool_calling 状态。
// 档案描述的是服务端上的模型（地址、接口、模型 id、服务版本），所以按这几项存，不按 Mori 的提供商 id 存。
// 一键拉取模型（docs/specs/model-discovery.md §7.2、§7.3）：auto.meta 记第 0 步读到的报告值，ProfileView.reported
// 给模型行的提示；server.kind 为 §3.3 的全部种类；versionChanged 按读版本的结果（种类、版本）判断要不要重新探测。
// 适配层（§7.6、§7.7）：auto.offRefused 记第 2 步判出的“关闭思考被拒”，compileFlagsOf 给编译用的档案项。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  SERVER_KINDS,
  type ApiType, type Capability, type Compat, type ProbeProgress, type ProbeStepResult, type ProfileView,
  type ProviderModel, type ReasoningField, type ReportedValues, type ServerKind,
} from '../shared/models';
import type { CompileFlags } from './modelCompile';
import type { ModelRef, ToolCallingState } from './modelTypes';
import { renameReplacing } from './renameRetry';

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
  /**
   * 第 2 步：思考 off 时没有思考内容为 pass，有为 fail；off 被 400 或 422 拒绝、medium 有正文时也为 fail（§7.7）；
   * reasoning 为 false 的模型 not_applicable
   */
  thinking: ProbeStepResult;
  /** 第 3 步：调用 get_weather，参数类型正确 */
  call: ProbeStepResult;
  /** 第 4 步：回答含 21 */
  result: ProbeStepResult;
  /** 第 4 步的回传检查（openai-completions 且 reasoning 为 true）：pass 为 not_required，fail 为 required */
  replay: ProbeStepResult;
  /** 第 5 步：A 级；本组判出 offRefused 时 not_applicable（§7.7） */
  a: ProbeStepResult;
  /** 第 6 步：B 级；anthropic-messages 为 not_applicable */
  b: ProbeStepResult;
  /** 第 7 步：C 级；第 5、6 步不是都判定为不通过或不适用时 not_run（§7.7） */
  c: ProbeStepResult;
}

/**
 * @brief 第 0 步按 model-discovery.md §4.1 读到的、窗口以外的报告值（§7.2 auto.meta）：没报告为 null；
 *        reasoning、image 明确报告“没有”时为 false。
 */
export interface ServerMeta {
  /** 服务报告的输出上限（不小于窗口的不算报告） */
  maxTokens: number | null;
  /** 服务报告的思考支持 */
  reasoning: boolean | null;
  /** 服务报告的图片输入 */
  image: boolean | null;
}

/** @brief 读取器单模型模式的结果（探针第 0 步，model-discovery.md §7.1），由 modelDiscover.ts 给出。 */
export interface ServerRead {
  /** 服务种类：拿不到列表时按 §3.3 第 6 步能判断的，判断不了为 unknown */
  kind: ServerKind;
  /** 服务版本（§3.3 的读法）；这个种类没有版本请求或读不到时为 null */
  version: string | null;
  /** 服务报告的窗口；Ollama 只读到训练窗口、模型不在列表里或拿不到列表时为 null（§7.2） */
  reported: number | null;
  /** 窗口以外的报告值；拿不到列表或模型不在列表里时各项为 null */
  meta: ServerMeta;
}

/** @brief 读版本的结果（model-discovery.md §7.3），每个提供商（baseUrl + api）读一次。 */
export interface VersionRead {
  /** 拿到了模型列表 */
  listed: boolean;
  /** 按 §3.3 认出的种类；没拿到列表时为 unknown */
  kind: ServerKind;
  /** 读到的版本；这个种类没有版本请求或没读到时为 null */
  version: string | null;
  /** 这个种类有版本请求并且读到了版本 */
  versionRead: boolean;
}

/** @brief 一组自动探针（第 0–7 步）的结果，由 probes.ts 给出。 */
export interface AutoResults {
  /** 第 0 步：服务种类与版本；版本取不到时为 unknown */
  server: { kind: ServerKind; version: string };
  /** 第 0 步：服务报告的窗口（model-discovery.md §4.1、§4.2 的读法；Ollama 只读到训练窗口时为 null）；没有时为 null */
  reported: number | null;
  /** 第 0 步：窗口以外的报告值（model-discovery.md §7.2）；2026-10-23 以前的档案没有这一项，照样读、不重新探测 */
  meta?: ServerMeta;
  /** 各步的判定 */
  steps: AutoSteps;
  /** 第 1、2、4 步观察到的推理字段名（openai-completions）；没有思考内容时为 none，其他接口为 native */
  field: ReasoningField;
  /**
   * 第 2 步关闭思考被服务以 400 或 422 拒绝、medium 有正文（§7.7）。probes.ts 每次都写；
   * 2026-10-24 以前的档案没有这一项，读作 false，不重新探测（PROBE_SUITE 不变）
   */
  offRefused?: boolean;
}

/**
 * @brief model-profiles.json 里的一个档案。2026-10-26 以前的档案可能还带长输入、取消两步的结果（longInput、cancel，
 *        §7.2 的 2026-10-26 改）：StoredProfileSchema 是 z.object，读的时候丢掉这两项，下一次写文件时不再写出。
 */
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
 * @brief 读版本的结果是否要重新探测（§7.1；model-discovery.md §7.3）：拿不到列表时档案不变；拿到列表且种类与档案不同时
 *        重新探测；种类相同时只有读到了版本（versionRead）且与档案不同才算。种类本来没有版本请求、或版本请求失败时
 *        versionRead 为假，只比种类。
 * @param stored 这个模型的档案；没有时为 undefined
 * @param read 这个模型所在提供商（baseUrl + api）的读版本结果
 */
export function versionChanged(stored: StoredProfile | undefined, read: VersionRead): boolean {
  if (!stored || !read.listed) return false;
  if (read.kind !== stored.auto.server.kind) return true;
  return read.versionRead && read.version !== stored.auto.server.version;
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

/**
 * @brief reasoning：openai-completions 取探针观察到的字段与第 2、4 步；另两种接口为 native、not_required。
 *        off_refused 三种接口都取 auto.offRefused（§7.7），没有档案或旧档案为 false；can_disable 仍按第 2 步。
 */
export function reasoningOf(api: ApiType, auto: AutoResults | null): ProfileView['reasoning'] {
  const thinking = auto?.steps.thinking.outcome;
  const can_disable = thinking === 'pass' ? true : thinking === 'fail' ? false : 'unknown';
  // §7.7：关闭思考被拒的第 2 步是 fail，所以这时 can_disable 为 false
  const off_refused = auto?.offRefused === true;
  if (api !== 'openai-completions') return { field: 'native', can_disable, replay: 'not_required', off_refused };
  const replayStep = auto?.steps.replay.outcome;
  const replay = replayStep === 'pass' ? 'not_required' : replayStep === 'fail' ? 'required' : 'unknown';
  return { field: auto?.field ?? 'none', can_disable, replay, off_refused };
}

/**
 * @brief 档案给出的编译项（§7.6 的表）：reasoning.replay 为 required、reasoning.off_refused 为真（§7.7）；
 *        没有档案时两项都为 false。
 * @param api 接口类型
 * @param auto 档案的第 0–7 步结果；没有档案时为 undefined
 */
export function compileFlagsOf(api: ApiType, auto: AutoResults | undefined): CompileFlags {
  const reasoning = reasoningOf(api, auto ?? null);
  return { replayRequired: reasoning.replay === 'required', offRefused: reasoning.off_refused };
}

/**
 * @brief context：effective 为 declared 与 reported 中较小的（§7.2）。
 * @param reported 服务报告的窗口；没有时为 null
 */
export function contextOf(model: ProviderModel, reported: number | null): ProfileView['context'] {
  const declared = model.contextWindow;
  return { declared, reported, effective: reported === null ? declared : Math.min(declared, reported) };
}

/**
 * @brief reported（model-discovery.md §7.2）：第 0 步读到的服务报告的值，窗口同 context.reported；
 *        档案没有 meta（2026-10-23 以前的旧档案）时为 null，模型行只按推理字段提示（§8）。
 * @param auto 档案的第 0–7 步结果
 */
export function reportedOf(auto: AutoResults): ReportedValues | null {
  const meta = auto.meta;
  if (!meta) return null;
  return { contextWindow: auto.reported, maxTokens: meta.maxTokens, reasoning: meta.reasoning, image: meta.image };
}

/** @brief status：第 0–7 步至少一步出错没有结果为 error（附第一条原文），否则 ready。 */
export function statusOf(stored: Pick<StoredProfile, 'auto'>): { status: 'ready' | 'error'; error: string | null } {
  const failed = Object.values(stored.auto.steps).find((step) => step.outcome === 'error');
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
    context: contextOf(target.model, null),
    // model-discovery.md §7.2：还没有档案，没有报告值
    reported: null,
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
    context: contextOf(target.model, stored.auto.reported),
    reported: reportedOf(stored.auto),
    probedAt: stored.probedAt,
    suite: stored.suite,
  };
}

/**
 * @brief 界面看到的档案（§7.2、§7.4）：有档案时按档案（重新探测期间仍是旧结果，界面按 running 把行的 data-probe 设为
 *        reverifying，tool calling 验证过的模型不显示状态行，§9.1）；从未完成探测、正在探测时为 probing；两者都不是时为
 *        null（界面的状态行为“Couldn’t verify”加 Verify again）。
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
  /** 当前时刻（ms） */
  now: number;
}

/** @brief 一组自动探针结束后的新档案，替换这个服务端模型的旧档案（§7.4）。 */
export function buildProfile(input: BuildProfileInput): StoredProfile {
  const { target, auto, now } = input;
  return {
    key: profileKey(target, auto.server.version), fingerprint: profileFingerprint(target, auto.server.version),
    baseUrl: target.baseUrl, api: target.api, modelId: target.model.id, auto, probedAt: now, suite: PROBE_SUITE,
  };
}

// ---- model-profiles.json ----

const StepSchema = z.object({
  outcome: z.enum(['pass', 'fail', 'error', 'not_applicable', 'not_run']),
  detail: z.string().nullable(),
});

/**
 * auto.meta（model-discovery.md §7.2）：可选，2026-10-23 以前的档案没有这一项，照样读、不重新探测（PROBE_SUITE 不变）
 */
const MetaSchema = z.object({
  maxTokens: z.number().int().positive().nullable(),
  reasoning: z.boolean().nullable(),
  image: z.boolean().nullable(),
});

/**
 * z.object：不认识的字段读的时候丢掉，不算不合格。2026-10-26 以前的档案里长输入、取消两步的结果（longInput、cancel，
 * 模型层规格 §7.2 的 2026-10-26 改）因此照读、丢掉，不加迁移。
 */
const StoredProfileSchema = z.object({
  key: z.string(),
  fingerprint: z.string(),
  baseUrl: z.string(),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  modelId: z.string(),
  auto: z.object({
    // model-discovery.md §7.2：§3.3 的全部种类，原来的五种都在其中
    server: z.object({ kind: z.enum(SERVER_KINDS), version: z.string() }),
    reported: z.number().int().positive().nullable(),
    meta: MetaSchema.optional(),
    steps: z.object({ ready: StepSchema, thinking: StepSchema, call: StepSchema, result: StepSchema,
      replay: StepSchema, a: StepSchema, b: StepSchema, c: StepSchema }),
    field: z.enum(['reasoning_content', 'reasoning', 'reasoning_text', 'none', 'native']),
    // §7.7：可选，2026-10-24 以前的档案没有这一项；不写进 schema 的话读回时会被丢掉
    offRefused: z.boolean().optional(),
  }),
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
 * @brief 原子写档案文件：先写临时文件再改名（目标被别的进程短暂打开时重试）；目录不存在时先创建。
 * @param profiles 全部档案
 */
export async function writeProfiles(path: string, profiles: readonly StoredProfile[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: FILE_VERSION, profiles }, null, 2)}\n`, 'utf8');
  await renameReplacing(temp, path);
}

/** @brief 同一个服务端模型（地址、接口、模型 id）只留一个档案，不论服务版本。 */
function sameModel(stored: StoredProfile, target: ProfileTarget): boolean {
  return stored.baseUrl === target.baseUrl && stored.api === target.api && stored.modelId === target.model.id;
}

/**
 * @brief 服务端模型（地址、接口、模型 id，§7.1）的索引键，与 sameModel 的判断一致；写成 JSON 数组，
 *        地址或模型 id 里有 | 时也不会混淆。
 */
function serverModelId(baseUrl: string, api: ApiType, modelId: string): string {
  return JSON.stringify([baseUrl, api, modelId]);
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
   * @brief 界面的档案（mori.profiles、models.get）。加入的每个模型都自动跑探针（model-discovery.md §5.4），每次快照
   *        都算全部模型，所以一次调用只按服务端模型给档案建一次索引，整次随模型数线性增长，不再每个 ref 各找一遍
   *        （model-discovery.md §9 安全与资源；负责人：不能无限量地用内存、CPU）。
   * @param refs 配置里的全部模型
   * @param resolve ref → 服务端模型（调用方按配置建好一次的索引）；省略时用构造时的 resolve
   * @return 没有档案、也不在探测的模型不出现
   */
  views(refs: readonly ModelRef[], resolve?: (ref: ModelRef) => ProfileTarget | null): Record<ModelRef, ProfileView> {
    const find = resolve ?? ((ref: ModelRef) => this.options.resolve(ref));
    const byModel = new Map<string, StoredProfile>();
    for (const stored of this.profiles) {
      const id = serverModelId(stored.baseUrl, stored.api, stored.modelId);
      // 同 lookup 的 find：有重复时取第一个
      if (!byModel.has(id)) byModel.set(id, stored);
    }
    const out: Record<ModelRef, ProfileView> = {};
    for (const ref of refs) {
      const target = find(ref);
      if (!target) continue;
      const stored = byModel.get(serverModelId(target.baseUrl, target.api, target.model.id));
      const view = profileView(target, stored, this.isRunning(ref));
      if (view) out[ref] = view;
    }
    return out;
  }
}
