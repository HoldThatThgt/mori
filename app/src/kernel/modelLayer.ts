// 模型层的单例（docs/specs/model-providers.md §2、§3、§4、§7.4、§8）：后台进程启动时建立一次，持有
// 用户级配置（读、迁移、读不出）、编译到 pi（modelCompile.ts）、按 key 的模型池（modelPool.ts）、模型档案与探针调度、
// 服务版本检查、项目（Project access）与项目配置，以及一个变化通知：配置、档案、key 记录每次变化后通知订阅者，
// 会话层据此重新做静态校验（§4.6）。
//
// 给会话层（sessions.ts / modelSession.ts）用的接口，都在 ModelLayer 上：
// - 状态：getConfig()、configError()、getRuntime()、getPool()、getProfiles()、timings、reserved；
// - 静态校验的输入：projectContext(cwd) → ProjectContext；staticBase(context) 给出 selector.staticCheck 除
//   pick、candidates 之外的全部输入；expandPickIn(context, pick) / expandPickFor(cwd, pick) 展开范围（§5.1、§4.3），
//   expandPicksIn(context, picks) 依次展开角色的 models（平行 Agent 规格 §12.1）；
// - 选择器第 1–4 步：exists(ref)、zoneOf(ref)、toolCallingOf(ref)、availabilityOf(ref)，角色会话第 3 步的
//   capabilitiesOf(ref)、familyOf(ref)（平行 Agent 规格 §12.2、§12.9）；档案 profileOf(ref)
//   （§5.7 用 cancel_verified）；serverGet(ref, url, signal) 读服务端接口（§5.7 发出前读基线，配合 probes.readRunningRequests）；
// - 原因文字：一律用 shared/models.ts 的 REASON_TEXTS、plainReasonText 与 selector.ts 的 availabilityText、triedText；
// - 会话打开时：registerProject(cwd)（Project access 列出它）、checkVersions(refs)（§7.1，异步，不挡打开）；
// - onModelsChanged(listener)：每次配置、档案或 key 记录变化后调用；emitGlobal(event) 发全局事件（§9.5）。
//
// 一键拉取模型（docs/specs/model-discovery.md §2）在这里只有接线，读取规则在 discoverRead.ts、modelDiscover.ts：
// reader（命令、探针第 0 步与读版本共用的读取器）、readTarget(provider)（已有提供商按 §5.1 取 key，明文只在这里）、
// 探针第 0 步的 readServer 依赖（§7.1）、checkVersions 每个提供商读一次版本（§7.3）。

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  THINKING_LEVELS, type ApiType, type MigrationNotice, type ModelConfig, type ModelGlobalEvent, type ModelPick,
  type ModelProvider, type ModelsInfo, type ProfileView, type ProjectAccess, type ProjectModelsFile,
  type ProviderModel, type ThinkingLevel, type Zone,
} from '../shared/models';
import { requestStoreKey } from './credentials';
import {
  MODEL_CONFIG_FILE, findProvider, formatIssues, modelExists, normalizeProjectPath, parseModelConfig,
  projectAllowedZones, readModelConfig, readProjectModels, reservedIds, splitRef, writeJsonAtomic, zoneOfRef,
  zoneSuggestions,
} from './modelConfig';
import { ModelCompiler, type ReplayLookup } from './modelCompile';
import { DiscoverReader, type ReadTarget } from './modelDiscover';
import { runMigration, type PiSettingsView, type ThinkingCopy } from './modelMigrate';
import { authHeaders, createModelPool, type ModelPool, type PoolKeySecret } from './modelPool';
import {
  ProfileBook, buildProfile, needsProbe, profileFingerprint, profileView, reasoningOf, versionChanged, visionOf,
  withCancel, withLongInput, type AutoResults, type CancelResult, type LongInputResult, type ProfileTarget,
  type ServerRead, type StoredProfile, type VersionRead,
} from './modelProfiles';
import { MODEL_TIMINGS, type ModelTimings } from './modelTimings';
import type { Availability, ModelCapabilities, ModelRef, ToolCallingState } from './modelTypes';
import { createRuntime, globalSettings, loadPi, markRuntimeReady } from './pi';
import { ProbeRuns, runAutoProbes, runCancelProbe, runLongInputProbe, type ProbeDeps } from './probes';
import { expandPick, expandPicks, familyKey, type ExpandedPicks, type StaticCheckInput } from './selector';

/** @brief 模型档案的文件名（在 userData 下，§3）。 */
export const MODEL_PROFILES_FILE = 'model-profiles.json';
/** @brief 迁移说明的文件名（在 userData 下，§3）。 */
export const MODEL_MIGRATION_FILE = 'model-migration.json';

/** @brief 探针的种类（models.verify 的 tests）：自动的第 0–7 步、长输入（第 8 步）、取消（第 9 步）。 */
export type ProbeTests = 'auto' | 'long_input' | 'cancel';

/** @brief 配置、档案或 key 记录的一次变化（onModelsChanged 的参数）。 */
export type ModelsChange =
  | {
    kind: 'config';
    /** 这次从配置里删掉的模型（§4.7：回复进行中被删时换模型，原因文字用 removed） */
    removedRefs: ModelRef[];
  }
  | {
    kind: 'profiles';
    /** 档案或探测状态变了的模型 */
    refs: ModelRef[];
  }
  | { kind: 'keys' };

/** @brief 一个项目（会话的工作文件夹）在模型层里的样子（§4.3）。 */
export interface ProjectContext {
  /** 规范化的项目路径（§4.1 projectZones 的键） */
  path: string;
  /** 项目配置 .mori/models.json；没有文件、无效、或用户级配置读不出时为 null */
  project: ProjectModelsFile | null;
  /** 项目配置无效时的原因或校验原文（project_config）；有效或没有文件时为 null */
  projectError: string | null;
  /** 这个项目允许的区域（§4.3 三步的结果） */
  allowedZones: Zone[];
  /** 项目配置写的 allowedZones；没写、没有文件或文件无效时为 null（决定能否提供 Allow <zone>） */
  projectZones: Zone[] | null;
}

/** @brief 一次保存（save）的附带信息。 */
export interface SaveOptions {
  /** 保存前的配置，检查 nextKeyNumber 只增不减、写失败时恢复编译；首次写入时为 null */
  previous: ModelConfig | null;
  /** 本次新存的 key 的明文（ref → 明文）：保存成功后交给模型池 */
  newSecrets?: ReadonlyMap<string, string>;
  /** 一起删除的 key：保存成功后删掉它们的密文 */
  removedKeyRefs?: readonly string[];
  /** 一起删除的模型：取消它们的探针 */
  removedRefs?: readonly ModelRef[];
  /** 不论指纹是否变化都要自动探测的模型（新加的模型、首次启动表单，§7.4） */
  probeRefs?: readonly ModelRef[];
}

/** @brief 启动模型层的参数。 */
export interface ModelLayerOptions {
  /** Electron 的 userData 目录：model-config.json、model-profiles.json、model-migration.json 都在这里 */
  userData: string;
  /** pi 的配置目录：v0 的 models.json 在这里 */
  agentDir: string;
  /** 主进程解密后的全部 key：ref → 明文 */
  keys: Record<string, string>;
  /**
   * credentials.json 里有密文的全部 ref（不论解没解开，§4.5 迁移按它沿用 key）；
   * 主进程还没传来时省略，这时按 keys 的 ref 算
   */
  keyRefs?: readonly string[];
  /** credentials.json 读不出（或系统加密不可用）时的原文：这次启动不迁移；没有或省略时为 null */
  keyError?: string | null;
  /** @brief 发全局事件（信封 { kind: 'event', sessionId: null }，§9.5）。 */
  emitGlobal(event: ModelGlobalEvent): void;
}

/** @brief 一组要跑的探针。 */
interface ProbeJob {
  /** 模型 */
  ref: ModelRef;
  /** 档案对应的服务端模型 */
  target: ProfileTarget;
  /** pi 里注册的实际模型 */
  model: NonNullable<ReturnType<ModelRuntime['getModel']>>;
  /** 种类 */
  tests: ProbeTests;
}

/** @brief 一组探针的结果。 */
type ProbeOutcome =
  | { kind: 'auto'; auto: AutoResults }
  | { kind: 'long_input'; result: LongInputResult }
  | { kind: 'cancel'; result: CancelResult };

/** @brief 读版本时的一个提供商（baseUrl + api，model-discovery.md §7.3）：读一次，对比它下面的档案。 */
interface VersionCheck {
  /** 按它取 key 与地址（§5.1）：这个 baseUrl + api 下第一个出现的提供商 */
  provider: ModelProvider;
  /** 要对比的模型与读之前的档案 */
  entries: { ref: ModelRef; stored: StoredProfile }[];
}

/** @brief 各文件的位置。 */
interface LayerPaths {
  /** model-config.json */
  config: string;
  /** model-profiles.json */
  profiles: string;
  /** model-migration.json */
  notice: string;
  /** v0 的 <agentDir>/models.json */
  v0Models: string;
}

/** @brief 配置里的全部模型 <provider>/<model>，按配置顺序。 */
export function allRefs(config: ModelConfig | null): ModelRef[] {
  return (config?.providers ?? []).flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`));
}

/** @brief 档案对应的服务端模型。 */
function targetOf(provider: ModelProvider, model: ProviderModel): ProfileTarget {
  return { baseUrl: provider.baseUrl, api: provider.api, model, compat: provider.compat };
}

/**
 * @brief 配置里全部模型的 ref → 档案目标，一次快照建一次（model-discovery.md §9 安全与资源）：代替每个 ref 各找一遍
 *        提供商和模型。提供商 id 唯一且不含 /、模型 id 在提供商内唯一（模型层规格 §4.1 校验），结果与 profileTarget 相同。
 */
function refTargets(config: ModelConfig | null): Map<ModelRef, ProfileTarget> {
  const targets = new Map<ModelRef, ProfileTarget>();
  for (const provider of config?.providers ?? []) {
    for (const model of provider.models) targets.set(`${provider.id}/${model.id}`, targetOf(provider, model));
  }
  return targets;
}

/** @brief 探针开始时显示的步号与步数（running）。 */
function firstStep(tests: ProbeTests): [number, number] {
  if (tests === 'auto') return [0, 8];
  return tests === 'long_input' ? [8, 1] : [9, 1];
}

/** @brief 读 pi 设置里迁移要用的三项（§4.5）。 */
async function readPiSettings(): Promise<PiSettingsView> {
  const settings = await globalSettings();
  return { defaultProvider: settings.getDefaultProvider(), defaultModel: settings.getDefaultModel(),
    modelThinkingLevels: settings.getAllModelThinkingLevels() };
}

/**
 * @brief models.get 的 thinkingDefaults（§9.5）：pi 设置的 modelThinkingLevels 里每个模型的新会话默认强度，没设时为 null。
 * @param refs 配置里的全部模型
 */
async function readThinkingDefaults(refs: readonly ModelRef[]): Promise<Record<ModelRef, ThinkingLevel | null>> {
  const levels: Record<string, string | undefined> = (await globalSettings()).getAllModelThinkingLevels();
  const known = new Set<string>(THINKING_LEVELS);
  const result: Record<ModelRef, ThinkingLevel | null> = {};
  for (const ref of refs) {
    const level = levels[ref];
    result[ref] = level !== undefined && known.has(level) ? level as ThinkingLevel : null;
  }
  return result;
}

/** @brief 迁移改写了 id 的提供商：把 pi 设置的 modelThinkingLevels 旧键复制到新键，旧键不删（§4.5）。 */
async function applyThinkingCopies(copies: readonly ThinkingCopy[]): Promise<void> {
  if (copies.length === 0) return;
  const settings = await globalSettings();
  for (const copy of copies) {
    const from = splitRef(copy.from);
    const to = splitRef(copy.to);
    const level = from ? settings.getModelThinkingLevel(from.providerId, from.modelId) : undefined;
    if (to && level) settings.setModelThinkingLevel(to.providerId, to.modelId, level);
  }
  await settings.flush();
  for (const item of settings.drainErrors()) {
    console.error(`[kernel] cannot copy thinking levels: ${item.path ?? item.scope}: ${item.error.message}`);
  }
}

/** @brief 读迁移说明 model-migration.json；没有时为 null，读不出时记录并当作没有。 */
async function readNotice(path: string): Promise<MigrationNotice | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] cannot read ${path}: ${(error as Error).message}`);
    }
    return null;
  }
  try {
    const notice = JSON.parse(text) as MigrationNotice;
    if (Array.isArray(notice?.providers) && Array.isArray(notice.dropped)) return notice;
    console.error(`[kernel] ${path} is not a migration notice, ignoring it`);
  } catch (error) {
    console.error(`[kernel] cannot parse ${path}: ${(error as Error).message}`);
  }
  return null;
}

/** @brief 模型层：后台进程里只有一个，见 startModelLayer / getModelLayer。 */
export class ModelLayer {
  /** §12 的时长与次数 */
  readonly timings: ModelTimings = MODEL_TIMINGS;
  /**
   * 读取器（model-discovery.md §5.3）：models.discover 命令、探针第 0 步与读版本共用；每个请求的时限取 timings（§11），
   * 不经模型池
   */
  readonly reader = new DiscoverReader({ timings: this.timings });
  private config: ModelConfig | null = null;
  private loadError: string | null = null;
  private migrationFailure: string | null = null;
  private notice: MigrationNotice | null = null;
  private migratedNow = false;
  private firstRunId: string | null = null;
  private readonly secrets = new Map<string, string>();
  private readonly projects = new Map<string, string>();
  private readonly listeners = new Set<(change: ModelsChange) => void>();
  private readonly probeRuns = new ProbeRuns();
  private readonly probeFingerprints = new Map<ModelRef, string>();
  private readonly profiles: ProfileBook;
  private readonly compiler: ModelCompiler;
  private readonly pool: ModelPool;
  private queue: Promise<unknown> = Promise.resolve();
  /** 这一轮事件循环里探针进度已发过一条 mori.profiles，轮末的检查还没到（scheduleProfiles） */
  private profilesThisTurn = false;
  /** 那一条之后探针进度又变了：轮末补发一条最新的 */
  private profilesPending = false;

  /**
   * @param runtime pi 的运行时（不读 models.json）
   * @param reserved 保留 id：mori 与 pi 内置的提供商 id（§4.1）
   * @param paths 各文件的位置
   * @param emitGlobal 发全局事件
   */
  constructor(private readonly runtime: ModelRuntime, readonly reserved: readonly string[],
    private readonly paths: LayerPaths, private readonly emitGlobalEvent: (event: ModelGlobalEvent) => void) {
    this.profiles = new ProfileBook({ path: paths.profiles, resolve: (ref) => this.profileTarget(ref) });
    this.compiler = new ModelCompiler(runtime, this.timings.placeholderApiKey);
    this.pool = createModelPool({ timings: this.timings });
    this.pool.onKeyStatus((keyStatus) => {
      this.emitGlobal({ type: 'mori.key_status', keyStatus });
      this.notify({ kind: 'keys' });
    });
  }

  // ---- 状态 ----

  /** @brief 当前的用户级配置；不存在（首次启动）或读不出时为 null。 */
  getConfig(): ModelConfig | null {
    return this.config;
  }

  /** @brief model-config.json 存在但读不出时的“<路径>: <原文>”（config_invalid，§4.1）；没有时为 null。 */
  configError(): string | null {
    return this.loadError;
  }

  /** @brief 迁移失败的原文（显示在首次启动表单上方，§4.5）；没有时为 null。 */
  migrationError(): string | null {
    return this.migrationFailure;
  }

  /** @brief 这次启动从 v0 迁移成功（§9.4 config.get 的 migratedNow：界面直接打开 设置 → Models，§4.5）。 */
  isMigratedNow(): boolean {
    return this.migratedNow;
  }

  /** @brief 显示首次启动表单：model-config.json 不存在且没有迁移成（§9.4 config.get 的 firstRun）。 */
  isFirstRun(): boolean {
    return this.config === null && this.loadError === null;
  }

  /** @brief 首次启动表单在本次运行中建的提供商 id（models.firstRun 只能替换它，§9.4）；没有时为 null。 */
  firstRunProvider(): string | null {
    return this.firstRunId;
  }

  /** @brief 记下首次启动表单建的提供商。 */
  setFirstRunProvider(providerId: string): void {
    this.firstRunId = providerId;
  }

  /** @brief pi 的运行时（已编译当前配置）。 */
  getRuntime(): ModelRuntime {
    return this.runtime;
  }

  /** @brief 模型池（§8），所有会话、探针、测试连接共用。 */
  getPool(): ModelPool {
    return this.pool;
  }

  /** @brief 模型档案与探针进度（§7）。 */
  getProfiles(): ProfileBook {
    return this.profiles;
  }

  /** @brief 迁移说明；没有或已 Dismiss 时为 null。 */
  migration(): MigrationNotice | null {
    return this.notice;
  }

  // ---- 选择器第 1–4 步的查询 ----

  /** @brief 模型在配置里（§5.3 第 1 步）。 */
  exists(ref: ModelRef): boolean {
    return this.config !== null && modelExists(this.config, ref);
  }

  /** @brief 模型所在提供商的区域；未确认或不在配置里时为 null（§5.3 第 2 步）。 */
  zoneOf(ref: ModelRef): Zone | null {
    return this.config ? zoneOfRef(this.config, ref) : null;
  }

  /** @brief 档案的 tool_calling（§5.3 第 3 步，重新验证期间按旧结果）。 */
  toolCallingOf(ref: ModelRef): ToolCallingState {
    return this.profiles.toolCallingFor(ref);
  }

  /** @brief 模型此刻是否可用（§5.3 第 4 步、§8.3）。 */
  availabilityOf(ref: ModelRef): Availability {
    return this.pool.availability(ref);
  }

  /** @brief 界面看到的档案（含 cancel_verified、context.effective）；没有档案也不在探测时为 null。 */
  profileOf(ref: ModelRef): ProfileView | null {
    const target = this.profileTarget(ref);
    return target ? profileView(target, this.profiles.lookup(target), this.profiles.isRunning(ref)) : null;
  }

  /**
   * @brief 选择器第 3 步判断能力要求用的档案能力（平行 Agent 规格 §12.2）：有档案时按档案（重新探测期间是旧结果）；
   *        没有档案时能力都未验证，图像输入按配置，窗口取配置的。不在配置里时按未验证、窗口 0（第 1 步已排除它）。
   * @param ref 模型
   */
  capabilitiesOf(ref: ModelRef): ModelCapabilities {
    const found = this.lookupModel(ref);
    const view = this.profileOf(ref);
    const probing = this.profiles.isRunning(ref);
    if (view) {
      return { tier: view.tier.level, protocolWrite: view.protocol_write, structuredOutput: view.structured_output,
        vision: view.vision, effectiveWindow: view.context.effective, probing };
    }
    return { tier: null, protocolWrite: 'unverified', structuredOutput: 'unverified',
      vision: found ? visionOf(found.model) : 'failed',
      effectiveWindow: found?.model.contextWindow ?? 0, probing };
  }

  /**
   * @brief 模型族（平行 Agent 规格 §12.9）：配置里模型的 family，为空或不在配置里时为 <provider>/<model> 本身。
   * @param ref 模型
   */
  familyOf(ref: ModelRef): string {
    return familyKey(this.lookupModel(ref)?.model.family ?? '', ref);
  }

  /** @brief 模型与它的提供商（按当前配置）；不在配置里时为 null。 */
  lookupModel(ref: ModelRef): { provider: ModelProvider; model: ProviderModel } | null {
    const split = splitRef(ref);
    const provider = split && this.config ? findProvider(this.config, split.providerId) : undefined;
    const model = provider?.models.find((item) => item.id === split?.modelId);
    return provider && model ? { provider, model } : null;
  }

  /** @brief 档案对应的服务端模型（按当前配置）；不在配置里时为 null。 */
  profileTarget(ref: ModelRef): ProfileTarget | null {
    const found = this.lookupModel(ref);
    return found ? targetOf(found.provider, found.model) : null;
  }

  // ---- 项目（§4.3、§9.1 Project access） ----

  /** @brief 记下一个打开过的项目文件夹（会话新建或打开时），Project access 列出它。 */
  registerProject(projectPath: string): void {
    const path = normalizeProjectPath(projectPath);
    if (!this.projects.has(path)) this.projects.set(path, projectPath);
  }

  /**
   * @brief 一个项目的项目配置与允许的区域（§4.3）：读并校验 <project>/.mori/models.json。
   * @param projectPath 会话的工作文件夹
   */
  async projectContext(projectPath: string): Promise<ProjectContext> {
    const path = normalizeProjectPath(projectPath);
    const config = this.config;
    if (!config) return { path, project: null, projectError: null, allowedZones: [], projectZones: null };
    const parsed = await readProjectModels(projectPath, config);
    if (!parsed.ok) {
      // 项目配置无效时不放宽：没有允许的区域（§4.3），进行中的回复和压缩也选不到被它排除的提供商
      return { path, project: null, projectError: parsed.error, allowedZones: [], projectZones: null };
    }
    return { path, project: parsed.file, projectError: null,
      allowedZones: projectAllowedZones(config, projectPath, parsed.file),
      projectZones: parsed.file?.allowedZones ?? null };
  }

  /**
   * @brief 在一个项目里展开选择范围（§5.1、§4.3）。
   * @param context projectContext 的结果
   * @param pick 选择范围
   * @return 候选；范围指向的名字不存在或没有配置时为 null（pick_missing）；项目配置无效时为空（§4.3：
   *         不按用户分组放宽，静态校验先看 projectError，仍是 project_config）
   */
  expandPickIn(context: ProjectContext, pick: ModelPick): ModelRef[] | null {
    if (!this.config) return null;
    if (context.projectError !== null) return [];
    return expandPick(this.config, pick, context.project?.groups);
  }

  /**
   * @brief 在一个项目里把几个选择范围依次展开、去重（角色的 models，平行 Agent 规格 §12.1）；只有一个范围时与 expandPickIn 相同。
   * @param context projectContext 的结果
   * @param picks 选择范围，按顺序
   * @return 候选与第一个不存在的范围；没有配置时第一个范围算不存在，项目配置无效时候选为空（同 expandPickIn）
   */
  expandPicksIn(context: ProjectContext, picks: readonly ModelPick[]): ExpandedPicks {
    if (!this.config) return { refs: [], missing: picks[0] ?? null };
    if (context.projectError !== null) return { refs: [], missing: null };
    return expandPicks(this.config, picks, context.project?.groups);
  }

  /**
   * @brief 读项目配置后展开选择范围（expandPickIn 的便捷写法）。
   * @param projectPath 会话的工作文件夹
   * @param pick 选择范围
   */
  async expandPickFor(projectPath: string, pick: ModelPick): Promise<ModelRef[] | null> {
    return this.expandPickIn(await this.projectContext(projectPath), pick);
  }

  /**
   * @brief selector.staticCheck 除 pick、candidates 外的全部输入（§4.6）：配置与项目配置的错误、项目允许的区域、
   *        第 1–3 步的查询（含能力要求用的档案能力与模型族，平行 Agent 规格 §12.2、§12.9）。会话层补上 pick、
   *        candidates（expandPickIn）、需要时的 removedRefs，以及角色会话的 requires、avoidFamilies。
   * @param context projectContext 的结果
   */
  staticBase(context: ProjectContext): Omit<StaticCheckInput, 'pick' | 'candidates'> {
    return {
      configError: this.loadError, projectError: context.projectError, projectZones: context.projectZones,
      allowedZones: context.allowedZones, exists: (ref) => this.exists(ref), zoneOf: (ref) => this.zoneOf(ref),
      toolCalling: (ref) => this.toolCallingOf(ref), capabilities: (ref) => this.capabilitiesOf(ref),
      familyOf: (ref) => this.familyOf(ref),
    };
  }

  /** @brief Project access 的各项目（§9.1）：侧栏里的项目（pi 的会话列表）加本次打开过的文件夹。 */
  async projectAccess(): Promise<ProjectAccess[]> {
    const config = this.config;
    if (!config) return [];
    const paths = new Map(this.projects);
    try {
      const pi = await loadPi();
      for (const info of await pi.SessionManager.listAll()) {
        if (info.cwd && !paths.has(normalizeProjectPath(info.cwd))) paths.set(normalizeProjectPath(info.cwd), info.cwd);
      }
    } catch (error) {
      console.error(`[kernel] cannot list the projects: ${(error as Error).message}`);
    }
    return Promise.all([...paths].map(async ([path, original]) => {
      const parsed = await readProjectModels(original, config);
      return { path, zones: config.projectZones[path] ?? [],
        projectZones: parsed.ok ? parsed.file?.allowedZones ?? null : null,
        projectConfig: parsed.ok ? null : parsed.error };
    }));
  }

  // ---- 变化通知与全局事件 ----

  /**
   * @brief 订阅配置、档案、key 记录的变化（会话层据此重新做静态校验，§4.6）。
   * @return 取消订阅
   */
  onModelsChanged(listener: (change: ModelsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @brief 通知订阅者一次变化。 */
  notify(change: ModelsChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error(`[kernel] models change listener failed: ${(error as Error).message}`);
      }
    }
  }

  /** @brief 发一个全局事件（mori.profiles、mori.key_status，§9.5）。 */
  emitGlobal(event: ModelGlobalEvent): void {
    this.emitGlobalEvent(event);
  }

  /** @brief 发 mori.profiles：全部档案与正在跑的探针；轮末要补发的那一条（scheduleProfiles）随之满足，不再另发。 */
  emitProfiles(): void {
    this.profilesPending = false;
    this.emitGlobal({ type: 'mori.profiles', profiles: this.profileViews(this.config),
      running: this.profiles.running() });
  }

  /**
   * @brief 探针开始、每一步、结束时发 mori.profiles（§7.4、§9.5），一轮事件循环里最多两条、内容不变：这一轮的第一次
   *        变化立即发（各步落在不同轮次时与逐次发送相同），之后的变化合并到轮末（setImmediate）补发一条最新的。
   *        加入的每个模型都自动跑探针（model-discovery.md §5.4）：保存时 startProbes 一次开始全部加入的模型，共用的
   *        第 0 步列表读完时全部模型在同一轮进入第 1 步；逐次发全部档案时消息数与总量随模型数平方增长，并挡住后台进程
   *        （model-discovery.md §9 安全与资源；负责人：不能无限量地用内存、CPU）。
   */
  private scheduleProfiles(): void {
    if (this.profilesThisTurn) {
      this.profilesPending = true;
      return;
    }
    this.profilesThisTurn = true;
    setImmediate(() => this.endProfilesTurn());
    this.emitProfiles();
  }

  /** @brief 轮末（scheduleProfiles，§9.5）：这一轮第一条之后探针进度又变了、也还没有别处发过时，补发一条最新的。 */
  private endProfilesTurn(): void {
    this.profilesThisTurn = false;
    if (!this.profilesPending) return;
    try {
      this.emitProfiles();
    } catch (error) {
      console.error(`[kernel] cannot send mori.profiles: ${(error as Error).message}`);
    }
  }

  /** @brief 全部模型的 ProfileView（mori.profiles、models.get）：ref → 目标按配置建一次（model-discovery.md §9）。 */
  private profileViews(config: ModelConfig | null): Record<ModelRef, ProfileView> {
    const targets = refTargets(config);
    return this.profiles.views(allRefs(config), (ref) => targets.get(ref) ?? null);
  }

  // ---- models.get ----

  /** @brief 设置页 Models 的全部内容（models.get、models.reload）。 */
  async info(): Promise<ModelsInfo> {
    const config = this.config;
    return {
      error: null, config, profiles: this.profileViews(config), keyStatus: this.pool.keyStatus(),
      thinkingDefaults: await readThinkingDefaults(allRefs(config)),
      zoneSuggestions: config ? zoneSuggestions(config) : {}, migration: this.notice,
      projects: await this.projectAccess(), loadError: this.loadError, reserved: [...this.reserved],
    };
  }

  // ---- 保存（§4.4、§7.4、§9.5“写命令保存后”） ----

  /**
   * @brief 排队执行一次修改：同一时刻只有一个修改在读配置、编译和写文件（后台进程同时处理多条命令）。
   * @param task 拿到这时的配置，做修改
   */
  edit<T>(task: (config: ModelConfig | null) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => task(this.config));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * @brief 保存一份新配置（只在 edit 里调用）：校验 → 编译到 pi（出错回滚，§4.4 第 5 步）→ 原子写文件
   *        （写失败时恢复编译）→ 交给模型池 → 删除去掉的 key 的密文 → 取消删掉的模型的探针、按 §7.4 发起探针 →
   *        发 mori.profiles 并通知订阅者。
   * @param next 新配置
   * @param options 保存前的配置、新旧 key、删掉的模型、要探测的模型
   * @return 删除密文失败时的原文（配置已保存）；没有时为 null
   * @throws 校验、编译或写文件失败（配置文件与运行时不变）
   */
  async save(next: ModelConfig, options: SaveOptions): Promise<string | null> {
    const parsed = parseModelConfig(next, { reserved: this.reserved, previous: options.previous });
    if (!parsed.ok) throw new Error(formatIssues(parsed.issues));
    // 先从模型池撤下要删的 key，再让 pi 看到新地址（§4.1：key 不会发到新的地址）
    const held = this.withholdKeys(options.removedKeyRefs ?? []);
    try {
      await this.compiler.compile(parsed.config, this.replayLookup);
    } catch (error) {
      this.restoreKeys(held);
      throw error;
    }
    try {
      await writeJsonAtomic(this.paths.config, parsed.config);
    } catch (error) {
      // 只在 pi 恢复了旧地址之后放回撤下的 key
      if (await this.restoreCompile(options.previous)) this.restoreKeys(held);
      throw error;
    }
    this.config = parsed.config;
    this.loadError = null;
    for (const [ref, secret] of options.newSecrets ?? []) this.secrets.set(ref, secret);
    this.syncPool();
    const warning = await this.forgetKeys(options.removedKeyRefs ?? []);
    this.afterConfigChange(options.removedRefs ?? [], options.probeRefs ?? []);
    return warning;
  }

  /**
   * @brief 加密保存一个新 key（先于写配置，§9.1）；成功后明文才交给 save 的 newSecrets。
   * @param ref key 的引用
   * @param secret 明文
   */
  storeSecret(ref: string, secret: string): Promise<void> {
    return requestStoreKey(ref, secret);
  }

  /**
   * @brief 删掉 key 的密文与内存里的明文（保存失败后撤回本次新存的 key，或保存成功后删掉去掉的 key）。
   * @param refs key 的引用
   * @return 删除失败时的原文；没有时为 null
   */
  async forgetKeys(refs: readonly string[]): Promise<string | null> {
    const errors: string[] = [];
    for (const ref of refs) {
      this.secrets.delete(ref);
      try {
        await requestStoreKey(ref, null);
      } catch (error) {
        const message = `Cannot delete the key ${ref}: ${(error as Error).message}`;
        console.error(`[kernel] ${message}`);
        errors.push(message);
      }
    }
    return errors.length > 0 ? errors.join('; ') : null;
  }

  /** @brief 重新读 model-config.json（配置读不出时的 Reload，§4.1）：读成就编译，并通知订阅者。 */
  reload(): Promise<void> {
    return this.edit(async (previous) => {
      const load = await readModelConfig(this.paths.config, this.reserved);
      this.config = load.kind === 'ok' ? load.config : null;
      this.loadError = load.kind === 'invalid' ? load.error : null;
      await this.compileLoaded();
      this.syncPool();
      const kept = new Set(allRefs(this.config));
      this.afterConfigChange(allRefs(previous).filter((ref) => !kept.has(ref)), []);
    });
  }

  /** @brief 删除迁移说明（Dismiss，§4.5）。 */
  async dismissMigration(): Promise<void> {
    await rm(this.paths.notice, { force: true });
    this.notice = null;
  }

  /** @brief 档案要求回传推理内容（§7.6），按要编译的配置里的提供商与模型查档案。 */
  private readonly replayLookup: ReplayLookup = (provider, model) => {
    const stored = this.profiles.lookup(targetOf(provider, model));
    return stored !== undefined && reasoningOf(provider.api, stored.auto).replay === 'required';
  };

  /**
   * @brief 写配置失败后把运行时恢复成保存前的配置；恢复失败只记录。
   * @return 恢复成功
   */
  private async restoreCompile(previous: ModelConfig | null): Promise<boolean> {
    try {
      await this.compiler.compile(previous, this.replayLookup);
      return true;
    } catch (error) {
      console.error(`[kernel] cannot restore the previous model settings in pi: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * @brief 保存前从模型池与内存撤下要删的 key（改地址的 origin、删 key、删提供商），pi 拿到新地址之前它们就不再发出。
   * @param refs 要删的 key
   * @return 撤下的明文（ref → 明文），保存失败时放回
   */
  private withholdKeys(refs: readonly string[]): Map<string, string> {
    const removed = new Set(refs);
    const held = new Map<string, string>();
    for (const ref of removed) {
      const secret = this.secrets.get(ref);
      if (secret !== undefined) held.set(ref, secret);
      this.secrets.delete(ref);
    }
    for (const provider of this.config?.providers ?? []) {
      if (!provider.keys.some((key) => removed.has(key.ref))) continue;
      this.pool.setKeys(provider.id, this.poolKeys({ ...provider,
        keys: provider.keys.filter((key) => !removed.has(key.ref)) }));
    }
    return held;
  }

  /** @brief 保存失败后放回撤下的 key（它们的不可用记录已在撤下时清除）。 */
  private restoreKeys(held: ReadonlyMap<string, string>): void {
    if (held.size === 0) return;
    for (const [ref, secret] of held) this.secrets.set(ref, secret);
    this.syncPool();
  }

  /** @brief 编译刚读出的配置；pi 拒绝时按读不出处理（会话按 config_invalid 拒绝启动），记录原文。 */
  private async compileLoaded(): Promise<void> {
    try {
      await this.compiler.compile(this.config, this.replayLookup);
    } catch (error) {
      this.loadError = `${this.paths.config}: ${(error as Error).message}`;
      this.config = null;
      await this.restoreCompile(null);
    }
  }

  /** @brief 把当前配置的提供商和 key（含明文）交给模型池（§8.2 最后一条、§8.3 恢复列）。 */
  private syncPool(): void {
    const providers = this.config?.providers ?? [];
    this.pool.setProviders(providers);
    for (const provider of providers) this.pool.setKeys(provider.id, this.poolKeys(provider));
  }

  /** @brief 一个提供商交给模型池的 key：按顺序，带明文；明文缺失（解不开）的 key 记录后跳过。 */
  private poolKeys(provider: ModelProvider): PoolKeySecret[] {
    const keys: PoolKeySecret[] = [];
    for (const key of provider.keys) {
      const secret = this.secrets.get(key.ref);
      if (secret === undefined) console.error(`[kernel] key ${key.ref} of ${provider.id} has no saved secret`);
      else keys.push({ ref: key.ref, secret });
    }
    return keys;
  }

  /** @brief 配置变了之后：取消删掉的模型的探针，按 §7.4 发起探针，发 mori.profiles，通知订阅者。 */
  private afterConfigChange(removedRefs: readonly ModelRef[], probeRefs: readonly ModelRef[]): void {
    for (const ref of removedRefs) {
      this.probeRuns.cancel(ref);
      this.profiles.clearRunning(ref);
      this.probeFingerprints.delete(ref);
    }
    const forced = new Set(probeRefs);
    const refs = allRefs(this.config).filter((ref) => forced.has(ref) || this.needsAutoProbe(ref));
    if (refs.length > 0) this.startProbes(refs, 'auto');
    this.emitProfiles();
    this.notify({ kind: 'config', removedRefs: [...removedRefs] });
  }

  // ---- 探针调度（§7.3、§7.4） ----

  /**
   * @brief 指纹变了（或从没探测过）的模型要自动探测；已经在按同一个指纹探测的不重复开始。
   * @param ref 模型
   */
  needsAutoProbe(ref: ModelRef): boolean {
    const target = this.profileTarget(ref);
    if (!target) return false;
    const stored = this.profiles.lookup(target);
    if (!needsProbe(target, stored)) return false;
    const fingerprint = profileFingerprint(target, stored?.auto.server.version ?? null);
    return !this.probeRuns.isRunning(ref) || this.probeFingerprints.get(ref) !== fingerprint;
  }

  /**
   * @brief 发起探针（§7.4）：每个模型一组，新的一组取消旧的；在后台跑，不等结果。
   *        长输入与取消探针要求这个模型已有档案（有效窗口、服务种类取自档案）。
   * @param refs 模型
   * @param tests 种类
   * @return 不能发起时的原文（模型不在配置里、还没有档案）；可以时为 null，这时全部已开始
   */
  startProbes(refs: readonly ModelRef[], tests: ProbeTests): string | null {
    const jobs: ProbeJob[] = [];
    for (const ref of refs) {
      const job = this.probeJob(ref, tests);
      if (typeof job === 'string') return job;
      jobs.push(job);
    }
    for (const job of jobs) void this.runProbe(job);
    // 探测开始时也重新做静态校验：从未验证过的模型此时为 probing，拒绝启动卡变成 verifying（§7.4、§4.6）。
    if (jobs.length > 0) this.notify({ kind: 'profiles', refs: jobs.map((job) => job.ref) });
    return null;
  }

  /** @brief 一组探针要用的模型与档案；不能跑时返回原文。 */
  private probeJob(ref: ModelRef, tests: ProbeTests): ProbeJob | string {
    const target = this.profileTarget(ref);
    const split = splitRef(ref);
    const model = target && split ? this.runtime.getModel(split.providerId, split.modelId) : undefined;
    if (!target || !model) return `${ref} is not in your model settings`;
    if (tests !== 'auto' && !this.profiles.lookup(target)) return `${ref} has not been verified yet; run Verify first`;
    return { ref, target, model, tests };
  }

  /** @brief 跑一组探针：进度经 mori.profiles 发出；仍是这个模型当前的一组时保存结果；结束后通知订阅者。 */
  private async runProbe(job: ProbeJob): Promise<void> {
    const { ref } = job;
    const signal = this.probeRuns.begin(ref);
    this.probeFingerprints.set(ref, profileFingerprint(job.target, this.profiles.lookup(job.target)?.auto.server.version
      ?? null));
    this.profiles.setRunning(ref, ...firstStep(job.tests));
    // 经 scheduleProfiles：保存时 startProbes 在同一轮开始全部加入的模型，第一个之后的合并到轮末一条
    this.scheduleProfiles();
    let outcome: ProbeOutcome | null = null;
    try {
      outcome = await this.executeProbe(job, signal);
    } catch (error) {
      console.error(`[kernel] probe ${job.tests} for ${ref} failed: ${(error as Error).message}`);
    }
    const current = this.probeRuns.end(ref, signal);
    if (current && outcome) {
      await this.edit(() => this.storeProbe(job, outcome)).catch((error: unknown) => {
        console.error(`[kernel] cannot save the profile of ${ref}: ${(error as Error).message}`);
      });
    }
    if (!this.probeRuns.isRunning(ref)) {
      this.profiles.clearRunning(ref);
      this.probeFingerprints.delete(ref);
    }
    // §7.4 探针结束时发 mori.profiles，经 scheduleProfiles：同一轮结束的探针（例如 key 被拒时模型池一起失败的）合并
    this.scheduleProfiles();
    this.notify({ kind: 'profiles', refs: [ref] });
  }

  /** @brief 按种类跑探针；被取消时为 null。 */
  private async executeProbe(job: ProbeJob, signal: AbortSignal): Promise<ProbeOutcome | null> {
    const deps = this.probeDeps(job.ref, job.target, signal);
    const target = { ref: job.ref, model: job.model };
    if (job.tests === 'auto') {
      const auto = await runAutoProbes(target, deps);
      return auto ? { kind: 'auto', auto } : null;
    }
    const stored = this.profiles.lookup(job.target);
    if (!stored) return null;
    if (job.tests === 'long_input') {
      const effective = profileView(job.target, stored, false)?.context.effective ?? job.target.model.contextWindow;
      const result = await runLongInputProbe(target, effective, deps);
      return result ? { kind: 'long_input', result } : null;
    }
    const result = await runCancelProbe(target, stored.auto.server.kind, deps);
    return result ? { kind: 'cancel', result } : null;
  }

  /** @brief 保存探针结果（在 edit 里）；reasoning.replay 变了时重新编译（只有这个提供商的注册内容会变，§7.4）。 */
  private async storeProbe(job: ProbeJob, outcome: ProbeOutcome): Promise<void> {
    const previous = this.profiles.lookup(job.target);
    const now = Date.now();
    let next: StoredProfile;
    if (outcome.kind === 'auto') next = buildProfile({ target: job.target, auto: outcome.auto, previous, now });
    else if (!previous) return;
    else if (outcome.kind === 'long_input') next = withLongInput(previous, outcome.result, now);
    else next = withCancel(previous, outcome.result, now);
    const replayBefore = previous ? reasoningOf(job.target.api, previous.auto).replay : null;
    await this.profiles.save(next);
    if (reasoningOf(job.target.api, next.auto).replay === replayBefore) return;
    try {
      await this.compiler.compile(this.config, this.replayLookup);
    } catch (error) {
      console.error(`[kernel] cannot recompile after the profile of ${job.ref} changed: ${(error as Error).message}`);
    }
  }

  /**
   * @brief 探针的依赖（§7.3）：pi 的 streamSimple、模型池 background 类别的 fetch、第 0 步的读取器
   *        （model-discovery.md §7.1）、第 9 步读服务端接口。
   */
  private probeDeps(ref: ModelRef, target: ProfileTarget, signal: AbortSignal): ProbeDeps {
    return {
      streamSimple: (model, context, options) => this.runtime.streamSimple(model, context, options),
      fetchFor: (request) => this.pool.createFetch({ ref: request.ref, api: target.api, sessionKey: `probe ${ref}`,
        cls: request.cls, signal: request.signal, attemptSignal: request.attemptSignal, onSent: request.onSent }),
      readServer: (readSignal) => this.readServer(ref, readSignal),
      getText: (url, getSignal) => this.serverGet(ref, url, getSignal),
      now: () => Date.now(),
      timings: this.timings,
      signal,
      onStep: (step, of) => {
        if (signal.aborted) return;
        this.profiles.setRunning(ref, step, of);
        // 经 scheduleProfiles：共用的第 0 步列表读完时，全部模型在同一轮进入第 1 步
        this.scheduleProfiles();
      },
    };
  }

  /**
   * @brief 读服务端接口（探针第 9 步，§5.7 的指标）：GET，带这个提供商第一个 key 的认证头；不经模型池（不计入请求）。
   * @param ref 模型（决定提供商与接口）
   * @param url 完整地址
   * @param signal 取消
   * @return 2xx 时的正文；非 2xx 时为 null；连接失败时抛出
   */
  async serverGet(ref: ModelRef, url: string, signal: AbortSignal): Promise<string | null> {
    const found = this.lookupModel(ref);
    const api: ApiType = found?.provider.api ?? 'openai-completions';
    const first = found?.provider.keys[0];
    const secret = first ? this.secrets.get(first.ref) ?? null : null;
    const response = await fetch(url, { headers: authHeaders(new Headers(), api, secret),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timings.probeStepTimeoutMs)]) });
    if (response.ok) return response.text();
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  // ---- 读取器的接线（model-discovery.md §2） ----

  /**
   * @brief 已有提供商交给读取器的目标（model-discovery.md §5.1、§3.1）：地址与 Anthropic 提示按配置（api 为
   *        anthropic-messages），不整理、不识别；key 用第一个不在 rate_limited、auth、quota 记录里的，都在时用第一个，
   *        没有 key 时不带认证头（同 Test connection：只看有明文的 key，模型池也只有它们）。key 的明文不回到界面。
   * @param provider 配置里的提供商
   */
  readTarget(provider: ModelProvider): ReadTarget {
    const status = this.pool.keyStatus();
    const usable = provider.keys.filter((key) => this.secrets.has(key.ref));
    const ref = (usable.find((key) => status[key.ref] === undefined) ?? usable[0])?.ref ?? null;
    return {
      base: provider.baseUrl, anthropicHint: provider.api === 'anthropic-messages', existing: true,
      secret: ref === null ? null : this.secrets.get(ref) ?? null,
      // §5.3：同一个提供商（baseUrl + api + key 的 ref）同时进行的列表与种类判断只做一次
      shareKey: `${provider.baseUrl}|${provider.api}|${ref ?? ''}`,
    };
  }

  /**
   * @brief 探针第 0 步（model-discovery.md §7.1）：按调用时的配置找到提供商，经读取器的单模型模式读；key 按 §5.1 选，
   *        每个请求用读取器的时限（§11），只随这组探针的 signal 停止。
   * @param ref 模型
   * @param signal 这组探针的 signal
   * @throws 模型已不在配置里
   */
  private readServer(ref: ModelRef, signal: AbortSignal): Promise<ServerRead> {
    const found = this.lookupModel(ref);
    if (!found) return Promise.reject(new Error(`${ref} is not in your model settings`));
    return this.reader.single(this.readTarget(found.provider), found.model.id, signal);
  }

  /**
   * @brief 读服务版本（§7.1；model-discovery.md §7.3）：后台进程启动时、会话新建或打开时对它范围内的模型调用
   *        （异步，不挡打开）。每个提供商（baseUrl + api）经读取器读一次，结果按 versionChanged 对比它下面每个模型的
   *        档案：种类变了、或读到了与档案不同的版本时重新自动探测；拿不到列表时档案不变。没有档案、正在探测的模型不参与，
   *        同一个服务端模型只对比一次。
   * @param refs 模型
   */
  async checkVersions(refs: readonly ModelRef[]): Promise<void> {
    const groups = new Map<string, VersionCheck>();
    const seen = new Set<string>();
    for (const ref of refs) {
      const found = this.lookupModel(ref);
      const target = found ? targetOf(found.provider, found.model) : null;
      const stored = target ? this.profiles.lookup(target) : undefined;
      if (!found || !target || !stored || this.probeRuns.isRunning(ref)) continue;
      const server = `${target.baseUrl}|${target.api}`;
      if (seen.has(`${server}|${target.model.id}`)) continue;
      seen.add(`${server}|${target.model.id}`);
      const group = groups.get(server) ?? { provider: found.provider, entries: [] };
      group.entries.push({ ref, stored });
      groups.set(server, group);
    }
    await Promise.all([...groups.values()].map((group) => this.checkProviderVersion(group)));
  }

  /**
   * @brief 读一个提供商的版本（model-discovery.md §7.3：列表请求、§3.3 的种类判断与版本请求，不发 §4.2 的详情请求，
   *        不改 reported、meta），再对比它下面每个模型的档案。
   * @param group 提供商（key 按 §5.1 选）与它下面要对比的档案
   */
  private async checkProviderVersion(group: VersionCheck): Promise<void> {
    let read: VersionRead;
    try {
      read = await this.reader.version(this.readTarget(group.provider), new AbortController().signal);
    } catch (error) {
      console.error(`[kernel] cannot read the server version of ${group.provider.id}: ${(error as Error).message}`);
      return;
    }
    for (const { ref, stored } of group.entries) {
      if (!versionChanged(stored, read)) continue;
      console.log(`[kernel] server of ${ref} changed to ${read.kind} ${read.version ?? 'unknown'}; probing again`);
      const error = this.startProbes([ref], 'auto');
      if (error !== null) console.error(`[kernel] cannot probe ${ref} again: ${error}`);
    }
  }

  // ---- 启动 ----

  /**
   * @brief 启动：读配置（不存在时从 v0 迁移，§4.5；读不出时 config_invalid，§4.1）、读档案、编译、交给模型池。
   * @param agentDirKeys 主进程解密后的全部 key
   * @param keyRefs credentials.json 里有密文的全部 ref（含解不开的）
   * @param keyError credentials.json 读不出时的原文；读出时为 null
   * @return 这次启动迁移成功
   */
  async load(agentDirKeys: Record<string, string>, keyRefs: readonly string[],
    keyError: string | null): Promise<boolean> {
    for (const [ref, secret] of Object.entries(agentDirKeys)) this.secrets.set(ref, secret);
    const migrated = await this.readOrMigrate(keyRefs, keyError);
    await this.profiles.load();
    await this.compileLoaded();
    this.syncPool();
    if (!migrated) this.notice = await readNotice(this.paths.notice);
    return migrated;
  }

  /**
   * @brief 读 model-config.json；不存在时迁移一次。credentials.json 读不出时不迁移（不写配置，下次启动再迁移，
   *        §4.5），否则有密文却当作没有，key 会被永久丢掉。
   */
  private async readOrMigrate(keyRefs: readonly string[], keyError: string | null): Promise<boolean> {
    const load = await readModelConfig(this.paths.config, this.reserved);
    if (load.kind === 'ok') this.config = load.config;
    if (load.kind === 'invalid') this.loadError = load.error;
    if (load.kind !== 'missing') return false;
    if (keyError !== null) {
      this.migrationFailure = `Cannot read saved keys: ${keyError}`;
      console.error(`[kernel] migration skipped: ${this.migrationFailure}`);
      return false;
    }
    const run = await runMigration({
      modelsPath: this.paths.v0Models, configPath: this.paths.config, noticePath: this.paths.notice,
      data: { credentialRefs: keyRefs, unreadableRefs: keyRefs.filter((ref) => !this.secrets.has(ref)),
        settings: await readPiSettings(), reserved: this.reserved, now: Date.now() },
      encryptKey: async (ref, secret) => {
        await requestStoreKey(ref, secret);
        this.secrets.set(ref, secret);
      },
    });
    if (run.kind === 'failed') this.migrationFailure = run.error;
    if (run.kind !== 'migrated') return false;
    this.config = run.config;
    this.notice = run.notice;
    this.migratedNow = true;
    await applyThinkingCopies(run.thinkingCopies);
    return true;
  }

  /**
   * @brief 启动后在后台：迁移来的模型全部探测；其余还没有档案的（上次探测没跑完 App 就关了）或指纹变了的
   *        自动探测（第 0–7 步，background 类别）；再读服务版本（§7.1、§7.4）。
   * @param migrated 这次启动迁移成功
   */
  async startupProbes(migrated: boolean): Promise<void> {
    const refs = allRefs(this.config);
    const probe = migrated ? refs : refs.filter((ref) => this.needsAutoProbe(ref));
    if (probe.length > 0) this.startProbes(probe, 'auto');
    await this.checkVersions(refs.filter((ref) => !probe.includes(ref)));
  }
}

let instance: ModelLayer | null = null;
let resolveLayer: (layer: ModelLayer) => void = () => {};
let rejectLayer: (error: unknown) => void = () => {};
const layerReady = new Promise<ModelLayer>((resolve, reject) => {
  resolveLayer = resolve;
  rejectLayer = reject;
});
layerReady.catch(() => undefined);

/**
 * @brief 后台进程启动时建立模型层（只调用一次）：建 pi 运行时、读出保留 id、读配置或迁移、编译、交给模型池，
 *        然后放行 getRuntime 与 getModelLayer，在后台发起启动时的探针与版本检查。
 * @param options userData、agentDir、全部 key 与全局事件的发送
 * @return 模型层
 */
export async function startModelLayer(options: ModelLayerOptions): Promise<ModelLayer> {
  try {
    const runtime = await createRuntime();
    // 还没有注册任何提供商：这时 pi 的提供商就是它内置的（§4.1 保留 id）。
    const reserved = reservedIds(runtime.getProviders().map((provider) => provider.id));
    const paths: LayerPaths = {
      config: join(options.userData, MODEL_CONFIG_FILE), profiles: join(options.userData, MODEL_PROFILES_FILE),
      notice: join(options.userData, MODEL_MIGRATION_FILE), v0Models: join(options.agentDir, 'models.json'),
    };
    const layer = new ModelLayer(runtime, reserved, paths, (event) => options.emitGlobal(event));
    const migrated = await layer.load(options.keys, options.keyRefs ?? Object.keys(options.keys),
      options.keyError ?? null);
    instance = layer;
    markRuntimeReady();
    resolveLayer(layer);
    void layer.startupProbes(migrated).catch((error: unknown) => {
      console.error(`[kernel] startup probes failed: ${(error as Error).message}`);
    });
    return layer;
  } catch (error) {
    console.error(`[kernel] cannot start the model layer: ${(error as Error).message}`);
    markRuntimeReady();
    rejectLayer(error);
    throw error;
  }
}

/** @brief 模型层；启动完成前等待，启动失败时拒绝。 */
export function getModelLayer(): Promise<ModelLayer> {
  return layerReady;
}

/** @brief 已启动的模型层；还没启动完时为 null（不等待）。 */
export function currentModelLayer(): ModelLayer | null {
  return instance;
}
