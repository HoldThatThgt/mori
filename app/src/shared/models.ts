// 模型层的进程桥协议（docs/specs/model-providers.md §4、§7.2、§9.4、§9.5）：配置文件的 zod 校验、命令、结果与事件。
// 跨字段的规则（id 在提供商与分组间唯一、key ref 全局唯一、引用的名字存在、保留 id、nextKeyNumber 只增不减）
// 由后台进程的 modelConfig.ts 检查；这里只做单个字段、单个对象内能判断的部分。

import { z } from 'zod';

// ---- 共用的取值 ----

/** @brief 提供商的接口类型（§4.1，沿用 v0）。 */
export const API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type ApiType = (typeof API_TYPES)[number];

/** @brief 提供商表单里接口类型的界面文字（§9.1）。 */
export const API_TYPE_LABELS: Readonly<Record<ApiType, string>> = Object.freeze({
  'openai-completions': 'OpenAI-compatible (Chat Completions)',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
});

/** @brief pi 的思考强度（pi-agent-core ThinkingLevel），从低到高。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** @brief 每个 key 的并发上限与每个提供商的 key 数（§12）；kernel/modelTimings.ts 引用同一份。 */
export const MODEL_LIMITS = Object.freeze({
  /** 新提供商每个 key 的并发上限 */
  concurrencyDefault: 4,
  /** 并发上限的最小值 */
  concurrencyMin: 1,
  /** 并发上限的最大值 */
  concurrencyMax: 64,
  /** 每个提供商最多的 key 数 */
  maxKeys: 8,
});

/**
 * @brief 服务没报告时的窗口（model-discovery.md §11，同 §12 的新模型表单）；读取器（kernel/discoverRead.ts）与清单里
 *        手填的行（renderer settings/fields.tsx）共用。
 */
export const UNREPORTED_CONTEXT_WINDOW = 128000;

/** @brief 服务没报告输出上限时的上限值（model-discovery.md §11：16384 与窗口一半中较小的）。 */
const UNREPORTED_MAX_TOKENS = 16384;

/**
 * @brief 没报告时的输出上限：16384 与窗口一半中较小的（model-discovery.md §4.1、§4.3、§11；§12）。
 * @param contextWindow 窗口（正整数）
 */
export function unreportedMaxTokens(contextWindow: number): number {
  return Math.min(UNREPORTED_MAX_TOKENS, Math.floor(contextWindow / 2));
}

/** @brief 提供商与分组 id 的规则（§4.1、§12）。 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** @brief 选择范围或分组成员：分组 id、提供商 id，或 <provider>/<model>（模型 id 不含空白，可以含 /）。 */
export const PICK_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}(\/\S+)?$/;

/** @brief 会话的虚拟模型用的提供商 id（§11.1），不能用作提供商或分组 id。 */
export const VIRTUAL_PROVIDER_ID = 'mori';

/** @brief 选择范围：分组 id、提供商 id，或 <provider>/<model>（§1、§4.2）。 */
export type ModelPick = string;

/** @brief 判断数组里没有重复的值。 */
function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

// ---- 用户级配置 model-config.json（§4.1） ----

/** @brief 提供商或分组 id。 */
export const IdSchema = z.string().regex(ID_PATTERN, 'Use lowercase letters, digits and -');

/** @brief 选择范围（§4.2）。名字是否存在由后台进程判断。 */
export const PickSchema = z.string().regex(PICK_PATTERN, 'Not a model range name');

/**
 * @brief 兼容选项（§4.1）：只能写 v0 COMPAT_OPTIONS 的六个字段，值同 v0（勾选时写入的那个值），只对 openai-completions 生效。
 *        supportsStrictMode 从 2026-10-26 起没有勾选框（负责人走查 M1：pi 1.3.0 默认就不发 strict，勾不勾都一样，
 *        模型层规格 §9.1 的 2026-10-26 注），留在 schema 里只为已经存着它的配置照样读得出；编译照旧交给 pi。
 */
export const CompatSchema = z.strictObject({
  /** 端点不支持 developer 角色 */
  supportsDeveloperRole: z.literal(false).optional(),
  /** 端点不接受 store 字段 */
  supportsStore: z.literal(false).optional(),
  /** 最大输出用 max_tokens 字段 */
  maxTokensField: z.literal('max_tokens').optional(),
  /** 端点不支持流式用量 */
  supportsUsageInStreaming: z.literal(false).optional(),
  /** 端点不支持工具参数的 strict 模式 */
  supportsStrictMode: z.literal(false).optional(),
  /** 工具结果需要带工具名 */
  requiresToolResultName: z.literal(true).optional(),
});
export type Compat = z.infer<typeof CompatSchema>;

/** @brief 有勾选框的兼容选项字段（2026-10-26 起不含 supportsStrictMode，见 CompatSchema）。 */
export type CompatField = Exclude<keyof Compat, 'supportsStrictMode'>;

/** @brief 一个兼容选项：勾选时把 compat[field] 写成 value，取消勾选时删除该字段；界面文字见 COMPAT_LABELS、COMPAT_HINTS。 */
export interface CompatOption {
  /** 表单里的标识 */
  id: string;
  /** pi compat 字段名 */
  field: CompatField;
  /** 勾选时写入的值 */
  value: boolean | string;
}

/** @brief OpenAI 兼容端点的兼容选项，登记在 docs/v0/defaults.md（2026-10-26 起五个，见 CompatSchema）。 */
export const COMPAT_OPTIONS: readonly CompatOption[] = [
  { id: 'noDeveloperRole', field: 'supportsDeveloperRole', value: false },
  { id: 'noStore', field: 'supportsStore', value: false },
  { id: 'maxTokens', field: 'maxTokensField', value: 'max_tokens' },
  { id: 'noStreamUsage', field: 'supportsUsageInStreaming', value: false },
  { id: 'toolResultName', field: 'requiresToolResultName', value: true },
];

/** @brief 兼容选项的界面文字（§9.1，沿用 english-ui 的标签），按 compat 字段名索引。 */
export const COMPAT_LABELS: Readonly<Record<CompatField, string>> = Object.freeze({
  supportsDeveloperRole: 'Endpoint doesn’t support the developer role',
  supportsStore: 'Endpoint doesn’t accept the store field',
  maxTokensField: 'Endpoint needs max_tokens instead of max_completion_tokens',
  supportsUsageInStreaming: 'Endpoint doesn’t report usage while streaming',
  requiresToolResultName: 'Tool results must include the tool name',
});

/** @brief 兼容选项勾选框下的说明（§9.1，沿用 english-ui），按 compat 字段名索引。 */
export const COMPAT_HINTS: Readonly<Record<CompatField, string>> = Object.freeze({
  supportsDeveloperRole: 'Sends the system prompt with the system role instead',
  supportsStore: 'Leaves store out of requests',
  maxTokensField: 'Older endpoints don’t recognize max_completion_tokens',
  supportsUsageInStreaming: 'Doesn’t send stream_options, so the context usage shown will be inaccurate',
  requiresToolResultName: 'Some endpoints require a name field on tool result messages',
});

/** @brief 提供商下的一个 key：配置里只存引用，密文在 credentials.json。 */
export const ProviderKeySchema = z.strictObject({
  /** 密文的引用，全局唯一；新 key 为 <提供商 id>#<nextKeyNumber>，迁移来的沿用 v0 的提供商 id */
  ref: z.string().regex(/^[A-Za-z0-9._#-]+$/, 'Key ref may only contain letters, digits and . _ # -'),
  /** 界面显示的标签 */
  label: z.string().trim().min(1, 'Label is required'),
});
export type ProviderKey = z.infer<typeof ProviderKeySchema>;

/** @brief 提供商下的一个模型；全名 <provider>/<id>。 */
export const ProviderModelSchema = z.strictObject({
  /** 发给端点的模型 id：非空、不含空白，同一提供商内唯一，建好后不能改 */
  id: z.string().regex(/^\S+$/, 'Model id must be non-empty and contain no spaces'),
  /** 模型族，可以为空字符串 */
  family: z.string(),
  /** 上下文窗口（token） */
  contextWindow: z.number().int().positive(),
  /** 最大输出（token），小于 contextWindow */
  maxTokens: z.number().int().positive(),
  /** 支持思考 */
  reasoning: z.boolean(),
  /** 输入类型 */
  input: z.union([z.tuple([z.literal('text')]), z.tuple([z.literal('text'), z.literal('image')])]),
}).refine((model) => model.maxTokens < model.contextWindow,
  { message: 'Max output must be smaller than the context window', path: ['maxTokens'] });
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/** @brief 并发上限（每个 key）。 */
export const ConcurrencySchema = z.number().int().min(MODEL_LIMITS.concurrencyMin).max(MODEL_LIMITS.concurrencyMax);

/** @brief 提供商的基本信息，配置文件与表单共用。 */
const providerFields = {
  /** 显示名称 */
  name: z.string().trim().min(1, 'Name is required'),
  /** 接口类型 */
  api: z.enum(API_TYPES),
  /** 服务地址，http 或 https */
  baseUrl: z.url({ protocol: /^https?$/, message: 'Base URL must be an http or https URL' }),
  /** 兼容选项 */
  compat: CompatSchema,
  /** 每个 key 的并发上限 */
  concurrency: ConcurrencySchema,
};

/** @brief 一个提供商（一个端点）。 */
export const ProviderSchema = z.strictObject({
  /** 提供商 id，建好后不能改 */
  id: IdSchema,
  ...providerFields,
  /** key，顺序就是使用顺序；没有 key 时请求不带认证头 */
  keys: z.array(ProviderKeySchema).max(MODEL_LIMITS.maxKeys),
  /** 下一个新 key 的编号，只增不减 */
  nextKeyNumber: z.number().int().min(1),
  /** 模型，列出的顺序就是范围里的顺序 */
  models: z.array(ProviderModelSchema).min(1),
}).refine((provider) => distinct(provider.models.map((model) => model.id)),
  { message: 'Model ids must be unique within a provider', path: ['models'] });
export type ModelProvider = z.infer<typeof ProviderSchema>;

/** @brief 分组的成员列表：有序、不重复、至少一个；每项是提供商 id 或 <provider>/<model>。 */
export const GroupMembersSchema = z.array(PickSchema).min(1, 'A group needs at least one member')
  .refine(distinct, 'Group members must not repeat');

/** @brief 一个分组。 */
export const GroupSchema = z.strictObject({
  /** 分组 id，与提供商 id 共用名字空间 */
  id: IdSchema,
  /** 有序的成员 */
  members: GroupMembersSchema,
});
export type ModelGroup = z.infer<typeof GroupSchema>;

/**
 * @brief 用户级模型配置 model-config.json。严格校验：2026-10-26 删掉的网络区域字段（zone、allowedZones、projectZones）
 *        按未知字段报错（负责人走查 M3，不写兼容代码，§4.1“启动时配置读不出”）。
 */
export const ModelConfigSchema = z.strictObject({
  /** 文件格式版本 */
  version: z.literal(1),
  /** 提供商 */
  providers: z.array(ProviderSchema),
  /** 分组 */
  groups: z.array(GroupSchema),
  /** 新会话的默认选择范围；没有时为 null */
  normalDefault: PickSchema.nullable(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * @brief 改 Base URL 的 origin 要删除 key 时确认框的文字（§4.1），后台进程（applyAddressChange）与界面（提供商表单）共用。
 * @param count 要删除的 key 数（≥ 1）
 */
export function addressChangeText(count: number): string {
  return count === 1 ? 'Changing the base URL removes this provider’s saved key. Add it again after saving.'
    : `Changing the base URL removes this provider’s ${count} saved keys. Add them again after saving.`;
}

// ---- 项目配置 <project>/.mori/models.json（§4.3），只能收紧 ----

/**
 * @brief 项目配置：把用户的分组缩小到它的一部分（2026-10-26 起只有 groups，原来的 allowedZones 按未知字段报错）。
 *        分组与成员是否存在由后台进程判断。
 */
export const ProjectModelsFileSchema = z.strictObject({
  /** 用户分组 id → 这个项目里用到的成员（用户分组的成员，或某个提供商成员下的模型）；列表不能为空（§4.3） */
  groups: z.record(z.string(), z.array(PickSchema).min(1, 'A group needs at least one member')
    .refine(distinct, 'Group members must not repeat')).optional(),
});
export type ProjectModelsFile = z.infer<typeof ProjectModelsFileSchema>;

// ---- 选择器的原因与会话的模型状态（§5.3、§4.6、§9.5） ----

/**
 * @brief 选择器的排除原因代码（§5.3 原因代码列）；requires_unmet、same_family 是角色会话第 3 步的原因
 *        （平行 Agent 规格 §12.2、§12.9），不会恢复。
 */
export const EXCLUSION_REASONS = [
  'missing', 'probing', 'unverified', 'failed', 'requires_unmet', 'same_family',
  'rate_limited', 'auth', 'quota', 'connection', 'not_found', 'timeout', 'held', 'tried', 'earlier', 'no_handover',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** @brief 换模型、等待、说明卡用的原因：排除原因，加上只让一次请求换模型的排队超时（§5.3）。 */
export type ModelReason = ExclusionReason | 'queue_timeout';

/**
 * @brief 把时刻格式化为本地时间 hh:mm:ss（24 小时制），用于 §5.3 界面文字的 until 部分。
 * @param ms 时刻（ms）
 * @return 例如 "09:05:07"
 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

/** @brief 带 until 部分的原因文字：until 为 null 时返回不带 until 的部分（§5.3：tried 与重做说明里用）。 */
function withUntil(base: string, joiner: string, until: number | null): string {
  return until === null ? base : `${base}${joiner}until ${formatClock(until)}`;
}

/**
 * @brief §5.3 各原因代码的界面文字，后台进程（重做说明、没有可用模型的说明）与界面（卡片、菜单）共用这一份。
 *
 * 带 until 参数的四项：传恢复时刻得到完整文字；传 null 得到不带 until 部分的文字（§5.3 "<它的原因文字>不带 until 部分"，
 * 用于 tried 的内层原因与 §6.1 的重做说明）。
 */
export const REASON_TEXTS = Object.freeze({
  /** removed 为真：回复进行中被删除（§4.7） */
  missing: (removed = false): string => (removed ? 'removed from your model settings' : 'not in your model settings'),
  probing: (): string => 'verifying…',
  unverified: (): string => 'tool calling not verified yet',
  failed: (): string => 'tool calling failed verification',
  /**
   * unmet：不满足的那一项，由选择器在判断时写出（平行 Agent 规格 §12.2），例如 handoff tier C is below B、
   * effective window 32768 < 65536、structured_output not verified
   */
  requires_unmet: (unmet: string): string => unmet,
  /** family：要避开的作者模型族（平行 Agent 规格 §12.9；族为空的模型用 <provider>/<model>） */
  same_family: (family: string): string => `same model family as the author (${family})`,
  rate_limited: (until: number | null): string => withUntil('rate limited', ' ', until),
  auth: (): string => 'API key rejected',
  quota: (): string => 'quota exhausted',
  connection: (until: number | null): string => withUntil('can’t connect', ' ', until),
  not_found: (): string => 'model not found on the server',
  timeout: (until: number | null): string => withUntil('no response', '; unavailable ', until),
  held: (until: number | null): string => withUntil('waiting to make sure it stopped', ', ', until),
  /** inner：它在本段失败时的原因文字（不带 until 部分） */
  tried: (inner: string): string => `failed earlier in this reply: ${inner}`,
  earlier: (): string => 'skipped at the start of this reply',
  /** rebuildError：重建的压缩失败时的原文；null 表示窗口放不下 */
  no_handover: (rebuildError: string | null): string => (rebuildError === null
    ? 'conversation too long for this model' : `couldn’t rebuild the conversation: ${rebuildError}`),
  /** waitedMs：排队等过的时长（§12 的排队超时） */
  queue_timeout: (waitedMs: number): string => `waited ${Math.round(waitedMs / 1000)} s for a free slot`,
}) satisfies Readonly<Record<ModelReason, (...args: never[]) => string>>;

/** @brief 界面文字带 until 部分的原因（§5.3 第 4 步）。 */
export const UNTIL_REASONS = ['rate_limited', 'connection', 'timeout', 'held'] as const;
export type UntilReason = (typeof UNTIL_REASONS)[number];

/** @brief 是否是界面文字带 until 部分的原因。 */
export function isUntilReason(reason: ModelReason): reason is UntilReason {
  return (UNTIL_REASONS as readonly string[]).includes(reason);
}

/**
 * @brief 不带 until 部分的原因文字（§5.3 tried 的内层原因、§6.1 的重做说明、换模型提示）。
 * @param reason 原因代码
 * @param detail 这个原因的完整界面文字（不带 until 的原因原样返回它）
 */
export function plainReasonText(reason: ModelReason, detail: string): string {
  return isUntilReason(reason) ? REASON_TEXTS[reason](null) : detail;
}

/** @brief 准备中按了停止时 session.prompt 的错误原文（§11.4）：界面撤回消息，不显示错误卡。 */
export const STOPPED_BEFORE_SENDING = 'Stopped before sending';
/** @brief 被拒绝启动的会话收到 session.prompt 时的错误原文（§4.6）：原因由拒绝启动卡说明，界面不另显示错误卡。 */
export const BLOCKED_PROMPT_MESSAGE = 'This session can’t start: no model fits';
/**
 * @brief task 会话中途换模型时结束这次运行的错误文字（平行 Agent 规格 §12.4）：运行以 stopReason error 和这段文字结束，
 *        后台进程读 ModelSession.takeRestart()，不解析这段文字。
 */
export const MODEL_RESTART = 'MODEL_RESTART';

/** @brief 一个候选和它被排除的原因。 */
export interface CandidateExclusion {
  /** <provider>/<model> */
  ref: string;
  /** 原因代码 */
  reason: ModelReason;
  /** 原因的说明（§5.3 界面文字所需的细节，例如恢复时刻、原文） */
  detail: string;
}

/**
 * @brief 拒绝启动的种类（§4.6）；agents_invalid 是 .mori/agents/*.md 有错（平行 Agent 规格 §4.4），优先于其他各项。
 */
export const BLOCKED_KINDS = [
  'verifying', 'no_candidate', 'no_pick', 'pick_missing', 'project_config', 'config_invalid', 'agents_invalid',
] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];

/**
 * @brief 拒绝启动卡上的操作（§4.6）；check_agents 是 Check again（平行 Agent 规格 §4.4），
 *        turn_off_team 是协作模式下代替 change_model 的 Turn off team mode（平行 Agent 规格 §5.1、§12.11）。
 */
export const BLOCKED_ACTIONS = [
  'verify', 'change_model', 'open_settings', 'check_agents', 'turn_off_team',
] as const;
export type BlockedAction = (typeof BLOCKED_ACTIONS)[number];

/** @brief 会话被拒绝启动的说明（§4.6、§9.5）。 */
export interface ModelBlocked {
  /** 种类 */
  kind: BlockedKind;
  /** 卡片文字所需的细节（缺的名字、项目配置的原因或原文、配置文件路径与原文） */
  detail: string;
  /** 每个候选及排除原因（no_candidate、verifying 时） */
  candidates: CandidateExclusion[];
  /** 卡上可做的操作 */
  actions: BlockedAction[];
  /** Verify now 要探测的候选（unverified 的） */
  verifyRefs: string[];
  /** agents_invalid 时卡上逐条列出的问题（平行 Agent 规格 §4.4 表的写法，<file>: …）；其他种类为空 */
  problems: string[];
}

/** @brief 会话的模型状态（范围按钮、Effort 按钮与拒绝启动卡，§9.5）。 */
export interface ModelState {
  /** 会话的选择范围；没有时为 null */
  pick: ModelPick | null;
  /** 当前模型 <provider>/<model>：本段正在用的，没有段时是静态校验后的第一个候选；没有候选时为 null */
  current: string | null;
  /** 拒绝启动的说明；可以发送时为 null */
  blocked: ModelBlocked | null;
  /** 当前的思考强度 */
  thinkingLevel: ThinkingLevel;
  /** 当前模型（实际模型）可选的思考强度 */
  thinkingLevels: ThinkingLevel[];
  /** 当前模型标了支持思考 */
  reasoning: boolean;
  /**
   * 对话会话在协作模式下为真（平行 Agent 规格 §12.11）：范围按钮只显示正在用的模型、不能打开菜单，
   * session.setPick 被拒绝，session.pickOptions 返回空
   */
  pickLocked: boolean;
}

// ---- 模型档案（§7.2），界面看到的样子 ----

/** @brief 能力三态：已验证、未验证、验证失败（proposal §4）。 */
export type Capability = 'verified' | 'unverified' | 'failed';

/** @brief 探针一步的结果：通过、判定不通过、出错没有结果、不适用、没有跑（例如第 7 步在 A、B 通过时）。 */
export interface ProbeStepResult {
  /** 结果 */
  outcome: 'pass' | 'fail' | 'error' | 'not_applicable' | 'not_run';
  /** 判定不通过或出错时的原因或原文；没有时为 null */
  detail: string | null;
}

/**
 * @brief 推理服务的种类（探针第 0 步与一键拉取模型，docs/specs/model-discovery.md §3.3）；
 *        前四种与 unknown 是模型层原来的五种，档案里的旧值都在其中。
 */
export const SERVER_KINDS = [
  'vllm', 'sglang', 'llamacpp', 'ollama', 'lmstudio', 'xinference', 'gpustack', 'mindie', 'tgi', 'lmdeploy',
  'localai', 'tensorrt', 'litellm', 'newapi', 'oneapi', 'deepseek', 'moonshot', 'dashscope', 'qianfan', 'openrouter',
  'anthropic', 'unknown',
] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

/**
 * @brief "Detected: …" 一行的种类名（model-discovery.md §3.3）；unknown 写 OpenAI-compatible server，
 *        列表是 Anthropic 形状时见 serverKindLabel。
 */
export const SERVER_KIND_LABELS: Readonly<Record<ServerKind, string>> = Object.freeze({
  vllm: 'vLLM', sglang: 'SGLang', llamacpp: 'llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio',
  xinference: 'Xinference', gpustack: 'GPUStack', mindie: 'MindIE', tgi: 'TGI', lmdeploy: 'LMDeploy',
  localai: 'LocalAI', tensorrt: 'TensorRT-LLM', litellm: 'LiteLLM', newapi: 'New API', oneapi: 'One API',
  deepseek: 'DeepSeek', moonshot: 'Moonshot AI', dashscope: 'Alibaba Cloud Model Studio', qianfan: 'Baidu Qianfan',
  openrouter: 'OpenRouter', anthropic: 'Anthropic', unknown: 'OpenAI-compatible server',
});

/**
 * @brief 种类名（model-discovery.md §3.3）：unknown 且列表是 Anthropic 形状时为 Anthropic-compatible server，
 *        否则取 SERVER_KIND_LABELS。
 * @param anthropicShape DiscoverResult.anthropicShape
 */
export function serverKindLabel(kind: ServerKind, anthropicShape: boolean): string {
  return kind === 'unknown' && anthropicShape ? 'Anthropic-compatible server' : SERVER_KIND_LABELS[kind];
}

/**
 * @brief 档案里服务报告的值（model-discovery.md §7.2、§8）：探针第 0 步按 §4.1 读到的，没报告为 null；
 *        reasoning、image 明确报告“没有”时为 false。contextWindow 同 context.reported（Ollama 只读到训练窗口时为 null）。
 */
export interface ReportedValues {
  /** 服务报告的窗口 */
  contextWindow: number | null;
  /** 服务报告的输出上限（不小于窗口的不算报告） */
  maxTokens: number | null;
  /** 服务报告的思考支持 */
  reasoning: boolean | null;
  /** 服务报告的图片输入 */
  image: boolean | null;
}

/**
 * @brief 服务没报告、按服务地址取自 pi 自带模型表的值（model-discovery.md §4.4、§7.2，2026-10-26 负责人走查回答 1）：
 *        只有服务没报告的项；模型行的“(from pi)”与 pi 的三种提示按它。
 */
export interface CatalogValues {
  /** pi 的提供商显示名（例如 Z.AI）：标记的悬停说明与提示里写它 */
  provider: string;
  /** pi 的窗口；服务报告了窗口时为 null */
  contextWindow: number | null;
  /** pi 的最大输出；服务报告了、或 pi 的不小于这一行的窗口时为 null */
  maxTokens: number | null;
  /** pi 说支持思考，服务没报告思考支持 */
  reasoning: boolean;
}

/** @brief 推理内容的字段名：openai-completions 为前四种之一，另两种接口为 native。 */
export type ReasoningField = 'reasoning_content' | 'reasoning' | 'reasoning_text' | 'none' | 'native';

/** @brief 一个模型的档案（§7.2）。 */
export interface ProfileView {
  /** 探测中、完成、至少一步因连接或 HTTP 错误没有结果 */
  status: 'probing' | 'ready' | 'error';
  /** status 为 error 时的原文；否则为 null */
  error: string | null;
  /** 服务种类与版本；版本取不到时为 unknown */
  server: { kind: ServerKind; version: string };
  /** 工具调用：第 3 步（调用）与第 4 步（读结果）各自的结果 */
  tool_calling: { state: Capability; call: ProbeStepResult; result: ProbeStepResult };
  /** 交接写入等级（§7.5）与每级的结果（A 第 5 步、B 第 6 步、C 第 7 步） */
  tier: { level: 'A' | 'B' | 'C' | null; a: ProbeStepResult; b: ProbeStepResult; c: ProbeStepResult };
  /** 由 tier 派生 */
  protocol_write: Capability;
  /** 第 6 步；anthropic-messages 为 unverified */
  structured_output: Capability;
  /** 配置声明了图像输入为 unverified，否则 failed */
  vision: Capability;
  /** 推理字段、能否关掉思考、要不要回传推理内容、关闭思考是否被服务拒绝 */
  reasoning: {
    field: ReasoningField; can_disable: boolean | 'unknown'; replay: 'required' | 'not_required' | 'unknown';
    /**
     * 第 2 步关闭思考被服务以 400 或 422 拒绝、medium 有正文（§7.7）；这时 can_disable 为 false。
     * 补丁之前的档案（没有 auto.offRefused）为 false
     */
    off_refused: boolean;
  };
  /** 窗口：配置声明的、服务报告的（没有时为 null）、有效的（两者中较小的） */
  context: { declared: number; reported: number | null; effective: number };
  /**
   * 第 0 步读到的服务报告的值（model-discovery.md §7.2）：模型行的“(default)”与“Server reports …”提示按它；
   * 档案没有 meta（旧档案）或还没有档案时为 null
   */
  reported: ReportedValues | null;
  /**
   * 按配置的地址与模型 id 取自 pi 自带模型表、服务没报告的值（model-discovery.md §7.2，2026-10-26）：不存在档案里，
   * 每次拼视图时查；reported 为 null、地址没对上 pi 的条目、一项都没取时为 null
   */
  catalog: CatalogValues | null;
  /** 最近一次探测完成的时刻（ms）；从未完成时为 null */
  probedAt: number | null;
  /** 探针套件版本 */
  suite: number;
}

/** @brief 正在跑的一组探针：模型、第几步、共几步。 */
export interface ProbeProgress {
  /** <provider>/<model> */
  ref: string;
  /** 正在跑的步 */
  step: number;
  /** 这组共几步 */
  of: number;
}

// ---- 迁移说明（§4.5） ----

/** @brief 从 v0 的 models.json 迁移的说明（model-migration.json）。 */
export interface MigrationNotice {
  /** 迁移的时刻（ms） */
  at: number;
  /** 迁入的提供商：原 id 与迁移后的 id（不同即改写过）和名称 */
  providers: { from: string; id: string; name: string }[];
  /** 丢弃的内容：对象（提供商、模型、兼容字段）与原因，文字为英文 */
  dropped: { subject: string; reason: string }[];
  /** 要重新填写 key 的提供商 id（v0 用 $ 环境变量写法的） */
  reenterKeys: string[];
  /** 手写明文 key 与已存的密文并存、以密文为准的提供商 id */
  keptCiphertext: string[];
}

// ---- 命令（§9.4、§9.5） ----

const sessionId = z.string().min(1);
const providerRef = z.string().min(1);
/** 移动的格数（§9.5，2026-10-26 负责人走查 M5）：不为 0 的整数，往前为负；一次拖动放下是一条命令 */
const delta = z.number().int().refine((value) => value !== 0, 'delta must not be 0');

/**
 * @brief 把第 from 项移到第 to 项，其余各项次序不变（§9.1“拖动排序”）：设置页按它先显示新顺序，后台进程按它写配置。
 * @param items 原来的列表（不改动它）
 * @param from 被移动的那一项的位置
 * @param to 移到的位置（按移动之后的列表算）
 * @return 新的列表
 */
export function movedItems<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** @brief 提供商表单：新建、修改、首次启动共用；id 由后台进程按名称生成。 */
export const ProviderFormSchema = z.strictObject(providerFields);
export type ProviderForm = z.infer<typeof ProviderFormSchema>;

/** @brief 一次加入的模型（model-discovery.md §5.4）：1 个以上，按清单顺序；id 是否重复由后台进程判断。 */
const AddedModelsSchema = z.array(ProviderModelSchema).min(1);

/**
 * @brief models.discover 要读的服务（model-discovery.md §5.1）：新提供商带你填的地址、改过的 API type（没改过为 null）
 *        与临时 key（为 null 或空时不带认证头；只用于这次读取）；已有提供商用配置里的地址、接口与已保存的 key。
 *        地址与 key 是否合格由后台进程检查（结果的 error）。
 */
export const DiscoverTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), baseUrl: z.string(), api: z.enum(API_TYPES).nullable(),
    keySecret: z.string().nullable() }),
  z.object({ kind: z.literal('provider'), providerId: z.string().min(1) }),
]);
export type DiscoverTarget = z.infer<typeof DiscoverTargetSchema>;

/** @brief 模型层的命令，由 protocol.ts 并进 CommandSchema。 */
export const ModelCommandSchemas = [
  /** 测试连接：经模型池测这个模型；带 keyRef 时只用这个 key（Keys 行的 Test），不看它的不可用记录 */
  z.object({ type: z.literal('connection.test'), providerId: providerRef, modelId: z.string().min(1),
    keyRef: z.string().min(1).optional() }),
  /** 设置页 Models 的全部内容 */
  z.object({ type: z.literal('models.get') }),
  /**
   * 首次启动表单：一次写入提供商、勾选的全部模型、key 和 normalDefault（一个模型时为它，多个时为提供商 id，
   * model-discovery.md §5.4）；providerId 非空时整体替换它与它的全部模型
   */
  z.object({ type: z.literal('models.firstRun'), providerId: providerRef.nullable(), provider: ProviderFormSchema,
    models: AddedModelsSchema, keySecret: z.string().min(1).nullable() }),
  /** 新建（id 为 null，带第一个 key 和清单里勾选的模型，model-discovery.md §5.4）或修改提供商（不带 models） */
  z.object({ type: z.literal('models.saveProvider'), id: providerRef.nullable(), provider: ProviderFormSchema,
    keySecret: z.string().min(1).optional(), models: AddedModelsSchema.optional() }),
  /** 删除提供商；dryRun 为真时只算连带改动、不改配置（确认框先用它列出各项） */
  z.object({ type: z.literal('models.deleteProvider'), id: providerRef, dryRun: z.boolean() }),
  /** 修改已有的模型（model-discovery.md §5.4：不再加模型）；thinkingLevel 写 pi 设置的 modelThinkingLevels */
  z.object({ type: z.literal('models.saveModel'), providerId: providerRef, model: ProviderModelSchema,
    thinkingLevel: z.enum(THINKING_LEVELS).optional() }),
  /** 卡上清单的 Add：加在这个提供商已有的模型之后；任一 id 已在其中或同一次里重复时整次拒绝（model-discovery.md §5.4） */
  z.object({ type: z.literal('models.addModels'), providerId: providerRef, models: AddedModelsSchema }),
  /** 读服务的模型列表（model-discovery.md §5.1）：不写配置、不进写入队列；同一时刻只做一次，新的取消旧的 */
  z.object({ type: z.literal('models.discover'), target: DiscoverTargetSchema }),
  /** 取消正在进行的 models.discover（model-discovery.md §5.3）；不取消探针第 0 步和读版本 */
  z.object({ type: z.literal('models.discoverCancel') }),
  /** 删除模型；dryRun 同上 */
  z.object({ type: z.literal('models.deleteModel'), providerId: providerRef, modelId: z.string().min(1),
    dryRun: z.boolean() }),
  z.object({ type: z.literal('models.moveModel'), providerId: providerRef, modelId: z.string().min(1), delta }),
  /** 加 key（加在末尾）；secret 只经进程通道交给后台进程 */
  z.object({ type: z.literal('models.addKey'), providerId: providerRef,
    label: ProviderKeySchema.shape.label, secret: z.string().min(1) }),
  z.object({ type: z.literal('models.removeKey'), providerId: providerRef, ref: z.string().min(1) }),
  z.object({ type: z.literal('models.moveKey'), providerId: providerRef, ref: z.string().min(1), delta }),
  /** 新建（creating 为真）或修改分组 */
  z.object({ type: z.literal('models.saveGroup'), id: IdSchema, members: GroupMembersSchema, creating: z.boolean() }),
  /** 删除分组；dryRun 同上 */
  z.object({ type: z.literal('models.deleteGroup'), id: z.string().min(1), dryRun: z.boolean() }),
  z.object({ type: z.literal('models.setDefaults'), normalDefault: PickSchema.nullable() }),
  z.object({ type: z.literal('models.dismissMigration') }),
  /** 重新读配置文件（配置读不出时的 Reload） */
  z.object({ type: z.literal('models.reload') }),
  /** 对这些模型跑自动探针第 0–7 步（§7.4、§9.5） */
  z.object({ type: z.literal('models.verify'), refs: z.array(z.string().min(1)).min(1) }),
  /** 这个会话换选择范围（写一条 mori.pick，不改 normalDefault） */
  z.object({ type: z.literal('session.setPick'), sessionId, pick: PickSchema }),
  /** 范围菜单的每一项，按这个会话的项目做静态校验（只读，§9.2） */
  z.object({ type: z.literal('session.pickOptions'), sessionId }),
] as const;
export type ModelCommand = z.infer<(typeof ModelCommandSchemas)[number]>;

// ---- 结果 ----

/** @brief 模型层命令的结果都带的字段。 */
export interface ModelsResult {
  /** 保存或编译失败时的原文；成功时为 null */
  error: string | null;
}

/** @brief key 的不可用记录（§8.3）；没有记录的 key 不出现。 */
export interface KeyStatus {
  /** 限流、被拒绝、额度用完 */
  state: 'rate_limited' | 'auth' | 'quota';
  /** rate_limited 的恢复时刻（ms）；其余为 null */
  until: number | null;
}

/** @brief models.get / models.reload 的结果。 */
export interface ModelsInfo extends ModelsResult {
  /** 用户级配置；key 只有 ref 与 label。读不出时为 null */
  config: ModelConfig | null;
  /** 档案：<provider>/<model> → 档案 */
  profiles: Record<string, ProfileView>;
  /** 迁移说明；没有或已 Dismiss 时为 null */
  migration: MigrationNotice | null;
  /** model-config.json 读不出时的路径与原文；没有时为 null */
  loadError: string | null;
  /** 不能用作提供商或分组 id 的名字（mori 和 pi 内置的提供商 id） */
  reserved: string[];
  /** key 的不可用记录：ref → 记录 */
  keyStatus: Record<string, KeyStatus>;
  /** pi 设置里按模型的新会话默认强度（modelThinkingLevels）：<provider>/<model> → 强度；没设时为 null */
  thinkingDefaults: Record<string, ThinkingLevel | null>;
}

/** @brief models.firstRun / models.saveProvider 的结果。 */
export interface ProviderSaved extends ModelsResult {
  /** 保存到的提供商 id（新建时是生成的 id） */
  providerId: string;
}

/** @brief models.deleteProvider / deleteModel / deleteGroup 的结果。 */
export interface DeleteResult extends ModelsResult {
  /** 确认框的各行：§4.1 的连带改动（英文）；dryRun 为假时是已经做了的改动 */
  consequences: string[];
}

/** @brief 范围菜单的一项（§9.2、§9.5 session.pickOptions）。 */
export interface PickOption {
  /** 这一项的选择范围 */
  pick: ModelPick;
  /** 分组、提供商或模型 */
  kind: 'group' | 'provider' | 'model';
  /** 菜单文字：分组写 id，提供商写名称，模型写模型 id */
  label: string;
  /** 展开后的全部候选都被本会话的静态校验排除（变淡，仍可以选） */
  excluded: boolean;
  /** excluded 时每个候选一行“<provider>/<model> — <原因>”；否则为 null */
  reason: string | null;
}

/** @brief session.pickOptions 的结果。 */
export interface PickOptions extends ModelsResult {
  /** 菜单的各项：先分组，再提供商，再按提供商的模型，各按配置里的顺序 */
  options: PickOption[];
}

/** @brief 清单行的提示（model-discovery.md §4.1、§4.2）：服务没列出工具支持；窗口是 Ollama 的训练窗口。 */
export type DiscoverHint = 'no_tools' | 'trained_window';

/** @brief 发现的一个模型（model-discovery.md §5.2），按服务列表的顺序。 */
export interface DiscoveredModel {
  /** 服务列表里的 id，原样 */
  id: string;
  /** 报告值、取自 pi 模型表的值（§4.4）或默认值（128000） */
  contextWindow: number;
  /** 报告值、取自 pi 模型表的值或默认值（16384 与窗口一半中较小的），总是小于 contextWindow */
  maxTokens: number;
  /** 支持思考：报告值，没报告时 pi 模型表说支持为 true，否则为 false */
  reasoning: boolean;
  /** 图片输入：报告值，没报告时为 false */
  image: boolean;
  /** 模型族；没报告时为空字符串 */
  family: string;
  /** 服务报告的类型是不是聊天模型；不报告为 null */
  chat: boolean | null;
  /**
   * 逐个字段是不是服务报告的：contextWindow、maxTokens 有报告值为真；reasoning、image 有报告值或明确报告“没有”为真；
   * family 有值为真
   */
  reported: { contextWindow: boolean; maxTokens: boolean; reasoning: boolean; image: boolean; family: boolean };
  /**
   * 服务没报告、取自 pi 自带模型表的项（§4.4，2026-10-26；清单写 From pi）：provider 为 pi 的提供商显示名，三项为真时
   * 上面同名的值来自 pi；一项都没取时为 null
   */
  catalog: { provider: string; contextWindow: boolean; maxTokens: boolean; reasoning: boolean } | null;
  /** 清单行的提示 */
  hints: DiscoverHint[];
  /** 不能加入的原因（the ID is empty、the ID contains spaces）；能加入为 null */
  unusable: string | null;
  /** 只对已有提供商：这个 id 已在配置里 */
  added: boolean;
}

/** @brief 拿不到模型列表的原因（model-discovery.md §3.2、§5.2）。 */
export interface DiscoverListError {
  /** 认证被拒、连不上或超时、服务没有列表接口、读不出列表 */
  kind: 'rejected' | 'unreachable' | 'no_list' | 'invalid';
  /** rejected、invalid 为服务的原文（最多 2000 字，key 换成 ***）；unreachable 为连接错误或超时；no_list 为空字符串 */
  detail: string;
}

/** @brief models.discover 的结果（model-discovery.md §5.2）；只在界面的表单状态里，表单关闭就丢掉。 */
export interface DiscoverResult extends ModelsResult {
  /** 被 models.discoverCancel 或新的一次发现取消 */
  cancelled: boolean;
  /** 认出的服务种类与版本；没拿到列表时为 null */
  server: { kind: ServerKind; version: string | null } | null;
  /** API type：你改过的，否则按 Anthropic 提示；已有提供商为配置里的 */
  api: ApiType;
  /** 建议的 Base URL（补 /v1 成功时是 <base>/v1，否则是整理后的 base；已有提供商为配置里的） */
  baseUrl: string;
  /** 建议的名称：主机名，非默认端口时加 :<端口> */
  name: string;
  /** 列表是 Anthropic 形状（对象有 has_more 或 hasMore，规格 §3.2） */
  anthropicShape: boolean;
  /** 拿不到列表的原因；拿到时为 null */
  listError: DiscoverListError | null;
  /** 发现的模型，列表顺序 */
  models: DiscoveredModel[];
  /** 列表超过 1000 条，只取了前面的 */
  truncated: boolean;
  /** 只对已有提供商：配置里有、列表里没有的模型 id；没拿到列表时为空 */
  notListed: string[];
}

/** @brief models.addKey 的结果。 */
export interface KeyAdded extends ModelsResult {
  /** 新 key 的 ref */
  ref: string;
}

/** @brief config.get 的结果（§9.4）。 */
export interface ConfigInfo {
  /** pi 的配置目录 */
  agentDir: string;
  /** pi 读设置文件时报告的错误，带文件路径；没有时为 null */
  settingsError: string | null;
  /** pi 设置的 defaultThinkingLevel（没有时为 medium） */
  defaultThinkingLevel: ThinkingLevel;
  /** 显示首次启动表单：model-config.json 不存在，且没有迁移成 */
  firstRun: boolean;
  /** 迁移失败时的原文（显示在首次启动表单上方）；没有时为 null */
  migrationError: string | null;
  /** model-config.json 存在但读不出时的路径与原文；没有时为 null */
  configError: string | null;
  /** 这次启动刚从 v0 迁移完（只在迁移的那次启动为真）：界面据此直接打开 设置 → Models（§4.5） */
  migratedNow: boolean;
}

/** @brief 每个模型层命令的结果类型（connection.test 的结果 TestResult 在 protocol.ts）。 */
export interface ModelCommandResults {
  'models.get': ModelsInfo;
  'models.reload': ModelsInfo;
  'models.firstRun': ProviderSaved;
  'models.saveProvider': ProviderSaved;
  'models.addKey': KeyAdded;
  'models.deleteProvider': DeleteResult;
  'models.saveModel': ModelsResult;
  'models.addModels': ModelsResult;
  'models.discover': DiscoverResult;
  'models.discoverCancel': ModelsResult;
  'models.deleteModel': DeleteResult;
  'models.moveModel': ModelsResult;
  'models.removeKey': ModelsResult;
  'models.moveKey': ModelsResult;
  'models.saveGroup': ModelsResult;
  'models.deleteGroup': DeleteResult;
  'models.setDefaults': ModelsResult;
  'models.dismissMigration': ModelsResult;
  'models.verify': ModelsResult;
  'session.setPick': ModelState & ModelsResult;
  'session.pickOptions': PickOptions;
}

// ---- 事件（§9.5） ----

/** @brief 模型层的会话事件，信封同其他会话事件。 */
export type ModelEvent =
  /** 会话的模型状态变了：范围、静态校验、当前模型、思考强度 */
  | ({ type: 'mori.model_state' } & ModelState)
  /** 换模型（§5.6） */
  | {
    type: 'mori.model_switch';
    /** 原模型 <provider>/<model> */
    from: string;
    /** 新模型 */
    to: string;
    /** 原因代码 */
    reason: ModelReason;
    /** 原因的细节 */
    detail: string;
    /** 有被隐藏的过程（显示 "The new model redoes this reply."） */
    hidden: boolean;
    /** 发出后超时、等满 held 后换的：没能确认旧请求已停下（§5.7，提示注明 Couldn’t confirm it stopped） */
    unconfirmed: boolean;
    /** 换模型的时刻（ms） */
    at: number;
  }
  /** 为新模型重建了对话（§6.3） */
  | {
    type: 'mori.model_rebuild';
    /** 新模型 */
    model: string;
    /** 有压缩摘要；false 时只去掉了工具调用和思考 */
    summary: boolean;
    /** 写 mori.rebuild 条目的时刻（ms） */
    at: number;
  }
  /**
   * 阶段行的等待：model 等模型恢复（§5.8），held 等它停下（§5.7），rebuild 为新模型重建对话（§6.3）。
   * active 为 false 时清掉阶段行。
   */
  | {
    type: 'mori.model_wait';
    /** 开始或结束 */
    active: boolean;
    /** 等待的种类 */
    kind: 'model' | 'held' | 'rebuild';
    /** held 时等的模型，rebuild 时重建给的模型；model 时为 null */
    model: string | null;
    /** model 时为最先恢复的那个候选的原因，held 时为 held；rebuild 或结束时为 null */
    reason: ModelReason | null;
    /** 原因的细节 */
    detail: string;
    /** 等到的时刻（ms）；不确定时为 null */
    until: number | null;
  }
  /** 排队等槽位（§8.2） */
  | {
    type: 'mori.model_queue';
    /** 开始或结束 */
    active: boolean;
    /** 提供商 id */
    provider: string;
    /** 提供商名称 */
    providerName: string;
  }
  /** 原地重试（§5.5），每次等待前发 */
  | {
    type: 'mori.model_retry';
    /** 第几次重试（从 1 起） */
    attempt: number;
    /** 共几次 */
    max: number;
    /** 这次失败的 HTTP 状态 */
    status: number;
    /** 等多久再发（ms） */
    delayMs: number;
  }
  /** 候选耗尽、没等到（§5.8）：一张说明卡 */
  | {
    type: 'mori.model_unavailable';
    /** 每个候选及原因 */
    candidates: CandidateExclusion[];
    /** 段开始时就选不到（消息没发出） */
    firstRequest: boolean;
    /** 撤回的消息，界面放回输入框；没有时为 null */
    text: string | null;
    /** 准备中又发的、一起撤回的消息，按发送顺序（§5.8、§11.4）；没有时为空数组 */
    queued: string[];
  };

/** @brief 档案变化或探针进度（全局事件，信封的 sessionId 为 null）。 */
export interface ProfilesEvent {
  type: 'mori.profiles';
  /** 全部档案：<provider>/<model> → 档案 */
  profiles: Record<string, ProfileView>;
  /** 正在跑的探针 */
  running: ProbeProgress[];
}

/** @brief key 的不可用记录变化（§8.3、§9.5；全局事件，信封的 sessionId 为 null）。 */
export interface KeyStatusEvent {
  type: 'mori.key_status';
  /** 全部有记录的 key：ref → 记录；没有记录的 key 不出现 */
  keyStatus: Record<string, KeyStatus>;
}

/** @brief 模型层的全局事件（§9.5，信封 { kind: 'event', sessionId: null }）。 */
export type ModelGlobalEvent = ProfilesEvent | KeyStatusEvent;

// ---- 会话文件里的自定义条目（§3、§5.1、§6.1、§6.3），经 pi 的 appendCustomEntry 写 ----

/** @brief 模型层自定义条目的 customType。 */
export const MODEL_ENTRY_TYPES = Object.freeze({
  /** 会话的选择范围（§5.1） */
  pick: 'mori.pick',
  /** 段内换模型（§6.1） */
  modelSwitch: 'mori.model_switch',
  /** 为新模型重建了对话（§6.3） */
  rebuild: 'mori.rebuild',
  /** task 会话中途换模型、从工作卡重来（平行 Agent 规格 §12.4） */
  taskRestart: 'mori.task_restart',
} as const);

/** @brief mori.pick 条目：会话的选择范围，以最后一条为准（§5.1）。 */
export interface PickEntryData {
  /** 选择范围：分组 id、提供商 id 或 <provider>/<model> */
  pick: ModelPick;
}

/** @brief mori.model_switch 条目：换模型与要隐藏的中断过程（§6.1）。 */
export interface ModelSwitchEntryData {
  /** 原模型 <provider>/<model> */
  from: string;
  /** 新模型 <provider>/<model> */
  to: string;
  /** 原因代码（§5.3） */
  reason: ModelReason;
  /** 原因的细节 */
  detail: string;
  /** 没能确认旧请求已停下就换的（§5.7，同 mori.model_switch 事件） */
  unconfirmed: boolean;
  /** 这段开始的时刻（ReplyState.startedAt，ms） */
  replyStartedAt: number;
  /** 这段 anchor 消息的时间戳（ms）；排队消息的时间戳是排队的时刻，可能早于 replyStartedAt */
  anchorAt: number;
  /** 换模型时上下文里助手消息与工具结果的最大时间戳；没有这类消息时等于 replyStartedAt（ms） */
  hideUntil: number;
}

/** @brief mori.rebuild 条目：为新模型重建了对话（§6.3 第 2 步）。 */
export interface RebuildEntryData {
  /** 接手的模型 <provider>/<model> */
  model: string;
  /** 写条目的时刻（ms）；之后发给模型的上下文里早于它的工具结果、思考与工具调用块去掉 */
  at: number;
  /** 第 1 步做了压缩（有摘要）；false 表示压缩被跳过 */
  summary: boolean;
}

/**
 * @brief mori.task_restart 条目：task 会话中途换模型，在新模型上从工作卡重来（平行 Agent 规格 §12.4）；
 *        时间戳早于 at 的消息都不再发给模型，会话文件不变。
 */
export interface TaskRestartEntryData {
  /** 写条目的时刻（ms） */
  at: number;
  /** 原模型 <provider>/<model> */
  from: string;
  /** 新模型 <provider>/<model> */
  to: string;
  /** 换模型的原因代码（§5.3） */
  reason: ModelReason;
  /** 原因的细节 */
  detail: string;
}
