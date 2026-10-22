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

/** @brief 网络区域（§4.3）：本机、内网、公网。 */
export const ZONES = ['local', 'intranet', 'public'] as const;
export const ZoneSchema = z.enum(ZONES);
export type Zone = z.infer<typeof ZoneSchema>;

/** @brief 所有项目默认允许的区域只能取这两个；公网只能按项目授权（§4.1 allowedZones）。 */
export const DEFAULT_ZONES = ['local', 'intranet'] as const;

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

/** @brief 一个兼容选项：勾选时把 compat[field] 写成 value，取消勾选时删除该字段；界面文字见 COMPAT_LABELS。 */
export interface CompatOption {
  /** 表单里的标识 */
  id: string;
  /** pi compat 字段名 */
  field: keyof Compat;
  /** 勾选时写入的值 */
  value: boolean | string;
}

/** @brief OpenAI 兼容端点的兼容选项，登记在 docs/v0/defaults.md。 */
export const COMPAT_OPTIONS: readonly CompatOption[] = [
  { id: 'noDeveloperRole', field: 'supportsDeveloperRole', value: false },
  { id: 'noStore', field: 'supportsStore', value: false },
  { id: 'maxTokens', field: 'maxTokensField', value: 'max_tokens' },
  { id: 'noStreamUsage', field: 'supportsUsageInStreaming', value: false },
  { id: 'noStrict', field: 'supportsStrictMode', value: false },
  { id: 'toolResultName', field: 'requiresToolResultName', value: true },
];

/** @brief 兼容选项的界面文字（§9.1），按 compat 字段名索引。 */
export const COMPAT_LABELS: Readonly<Record<keyof Compat, string>> = Object.freeze({
  supportsDeveloperRole: "Endpoint doesn't support the developer role",
  supportsStore: "Endpoint doesn't accept the store field",
  maxTokensField: 'Send the output limit as max_tokens',
  supportsUsageInStreaming: "Endpoint doesn't report usage while streaming",
  supportsStrictMode: "Endpoint doesn't support strict mode",
  requiresToolResultName: 'Tool results must include the tool name',
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
  baseUrl: z.url({ protocol: /^https?$/, message: 'Address must be an http or https URL' }),
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
  /** 网络区域；只有迁移来、还没确认的提供商为 null（§4.5） */
  zone: ZoneSchema.nullable(),
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

/** @brief 所有项目默认允许的区域：local、intranet 的子集，不重复。 */
export const AllowedZonesSchema = z.array(z.enum(DEFAULT_ZONES)).refine(distinct, 'Zones must not repeat');

/** @brief 一组区域，不重复。 */
export const ZoneListSchema = z.array(ZoneSchema).refine(distinct, 'Zones must not repeat');

/** @brief 规范化的项目路径：绝对路径、全部小写、/ 分隔、无结尾 /（§4.1 projectZones）。 */
export const ProjectPathSchema = z.string().min(1).refine(
  (path) => !path.includes('\\') && path === path.toLowerCase() && (path === '/' || !path.endsWith('/')),
  'Project path must be normalized');

/** @brief 用户级模型配置 model-config.json。 */
export const ModelConfigSchema = z.strictObject({
  /** 文件格式版本 */
  version: z.literal(1),
  /** 提供商 */
  providers: z.array(ProviderSchema),
  /** 分组 */
  groups: z.array(GroupSchema),
  /** 新会话的默认选择范围；没有时为 null */
  normalDefault: PickSchema.nullable(),
  /** 所有项目默认允许的区域 */
  allowedZones: AllowedZonesSchema,
  /** 本机按项目授权：规范化的项目路径 → 在 allowedZones 之外额外允许的区域 */
  projectZones: z.record(ProjectPathSchema, ZoneListSchema),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

// ---- 区域建议（§12）：后台进程（models.get 的 zoneSuggestions）与界面（表单的预选）共用 ----

/** @brief 点分十进制的 IPv4 地址（URL 已把 127.1、0x7f.1 等写法规范化成这种形式）。 */
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/** @brief URL 规范化后的 IPv4 映射 IPv6 地址 ::ffff:hhhh:hhhh（不带方括号）。 */
const IPV4_MAPPED_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** @brief IPv4 地址的区域建议：127/8 本机；10/8、172.16/12、192.168/16、169.254/16 内网。 */
function ipv4Zone(host: string): Zone {
  const [a, b] = host.split('.').map(Number);
  if (a === 127) return 'local';
  const intranet = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254);
  return intranet ? 'intranet' : 'public';
}

/** @brief IPv6 地址（不带方括号，已由 URL 规范化）的区域建议：::1 本机；fc00::/7、fe80::/10 内网；IPv4 映射的按 IPv4。 */
function ipv6Zone(host: string): Zone {
  if (host === '::1') return 'local';
  const mapped = IPV4_MAPPED_PATTERN.exec(host);
  if (mapped) {
    const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return ipv4Zone([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'));
  }
  const first = host.startsWith('::') ? 0 : parseInt(host.split(':')[0], 16);
  const intranet = (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  return intranet ? 'intranet' : 'public';
}

/**
 * @brief 按地址建议区域（§12）：回环地址（127/8、::1、localhost）→ local；10/8、172.16/12、192.168/16、169.254/16、
 *        fc00::/7、fe80::/10、.local 与不含点的主机名 → intranet；IPv4 映射的 IPv6 地址按其中的 IPv4 判断；
 *        其余 → public。只是预选建议，由你确认。
 * @param baseUrl 提供商地址；不是合法 URL 时按"其余"给 public
 */
export function suggestZone(baseUrl: string): Zone {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return 'public';
  }
  if (host.startsWith('[')) return ipv6Zone(host.slice(1, -1));
  if (IPV4_PATTERN.test(host)) return ipv4Zone(host);
  const bare = host.replace(/\.$/, '');
  if (bare === 'localhost') return 'local';
  return bare.endsWith('.local') || !bare.includes('.') ? 'intranet' : 'public';
}

// ---- 项目配置 <project>/.mori/models.json（§4.3），只能收紧 ----

/** @brief 项目配置：缩小区域、把用户的分组缩小到它的一部分。分组与成员是否存在由后台进程判断。 */
export const ProjectModelsFileSchema = z.strictObject({
  /** 与用户级的结果取交集 */
  allowedZones: ZoneListSchema.optional(),
  /** 用户分组 id → 这个项目里用到的成员（用户分组的成员，或某个提供商成员下的模型）；列表不能为空（§4.3） */
  groups: z.record(z.string(), z.array(PickSchema).min(1, 'A group needs at least one member')
    .refine(distinct, 'Group members must not repeat')).optional(),
});
export type ProjectModelsFile = z.infer<typeof ProjectModelsFileSchema>;

// ---- 选择器的原因与会话的模型状态（§5.3、§4.6、§9.5） ----

/** @brief 选择器的排除原因代码（§5.3 原因代码列）。 */
export const EXCLUSION_REASONS = [
  'missing', 'zone_unconfirmed', 'zone_blocked', 'probing', 'unverified', 'failed', 'rate_limited', 'auth', 'quota',
  'connection', 'not_found', 'timeout', 'held', 'tried', 'earlier', 'no_handover',
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
  zone_unconfirmed: (): string => 'network zone not confirmed',
  /** zone：被排除的提供商所在区域 */
  zone_blocked: (zone: Zone): string => `zone ${zone} is not allowed for this project`,
  probing: (): string => 'verifying…',
  unverified: (): string => 'tool calling not verified yet',
  failed: (): string => 'tool calling failed verification',
  rate_limited: (until: number | null): string => withUntil('rate limited', ' ', until),
  auth: (): string => 'API key rejected',
  quota: (): string => 'quota exhausted',
  connection: (until: number | null): string => withUntil("can't connect", ' ', until),
  not_found: (): string => 'model not found on the server',
  timeout: (until: number | null): string => withUntil('no response', '; unavailable ', until),
  held: (until: number | null): string => withUntil('waiting to make sure it stopped', ', ', until),
  /** inner：它在本段失败时的原因文字（不带 until 部分） */
  tried: (inner: string): string => `failed earlier in this reply: ${inner}`,
  earlier: (): string => 'skipped at the start of this reply',
  /** rebuildError：重建的压缩失败时的原文；null 表示窗口放不下 */
  no_handover: (rebuildError: string | null): string => (rebuildError === null
    ? 'conversation too long for this model' : `couldn't rebuild the conversation: ${rebuildError}`),
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
export const BLOCKED_PROMPT_MESSAGE = "This session can't start: no model fits";

/** @brief 一个候选和它被排除的原因。 */
export interface CandidateExclusion {
  /** <provider>/<model> */
  ref: string;
  /** 原因代码 */
  reason: ModelReason;
  /** 原因的说明（§5.3 界面文字所需的细节，例如恢复时刻、区域、原文） */
  detail: string;
}

/** @brief 拒绝启动的种类（§4.6）。 */
export const BLOCKED_KINDS = [
  'verifying', 'no_candidate', 'no_pick', 'pick_missing', 'project_config', 'config_invalid',
] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];

/** @brief 拒绝启动卡上的操作（§4.6）。 */
export const BLOCKED_ACTIONS = ['verify', 'allow_zone', 'confirm_zone', 'change_model', 'open_settings'] as const;
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
  /** Allow <区域> for this project 的区域；没有这个操作时为 null */
  zone: Zone | null;
  /** Confirm zone 要确认区域的提供商 id */
  zoneProviders: string[];
}

/** @brief 会话的模型状态（顶栏与拒绝启动卡，§9.5）。 */
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

/** @brief 推理服务的种类（探针第 0 步）。 */
export type ServerKind = 'vllm' | 'sglang' | 'ollama' | 'llamacpp' | 'unknown';

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
  /** 推理字段、能否关掉思考、要不要回传推理内容 */
  reasoning: {
    field: ReasoningField; can_disable: boolean | 'unknown'; replay: 'required' | 'not_required' | 'unknown';
  };
  /** 窗口：配置声明的、服务报告的（没有时为 null）、有效的；长输入是否被静默截断 */
  context: {
    declared: number; reported: number | null; effective: number; truncation: 'unknown' | 'none' | 'silent';
  };
  /** 断开后服务端是否停止（第 9 步） */
  cancel_verified: boolean | 'unknown';
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
const delta = z.union([z.literal(-1), z.literal(1)]);

/** @brief 提供商表单：新建、修改、首次启动共用；id 由后台进程按名称生成，区域必须选。 */
export const ProviderFormSchema = z.strictObject({ ...providerFields, zone: ZoneSchema });
export type ProviderForm = z.infer<typeof ProviderFormSchema>;

/** @brief 探针的种类：自动的第 0–7 步、需要同意的长输入（第 8 步）或取消（第 9 步）。 */
export const PROBE_TESTS = ['auto', 'long_input', 'cancel'] as const;

/** @brief 模型层的命令，由 protocol.ts 并进 CommandSchema。 */
export const ModelCommandSchemas = [
  /** 测试连接：经模型池测这个模型；带 keyRef 时只用这个 key（Keys 行的 Test），不看它的不可用记录 */
  z.object({ type: z.literal('connection.test'), providerId: providerRef, modelId: z.string().min(1),
    keyRef: z.string().min(1).optional() }),
  /** 设置页 Models 的全部内容 */
  z.object({ type: z.literal('models.get') }),
  /** 首次启动表单：一次写入提供商、模型、key 和 normalDefault；providerId 非空时整体替换它与它唯一的模型 */
  z.object({ type: z.literal('models.firstRun'), providerId: providerRef.nullable(), provider: ProviderFormSchema,
    model: ProviderModelSchema, keySecret: z.string().min(1).nullable() }),
  /** 新建（id 为 null，带第一个 key 和第一个模型及它的新会话思考强度）或修改提供商 */
  z.object({ type: z.literal('models.saveProvider'), id: providerRef.nullable(), provider: ProviderFormSchema,
    keySecret: z.string().min(1).optional(), model: ProviderModelSchema.optional(),
    thinkingLevel: z.enum(THINKING_LEVELS).optional() }),
  /** 删除提供商；dryRun 为真时只算连带改动、不改配置（确认框先用它列出各项） */
  z.object({ type: z.literal('models.deleteProvider'), id: providerRef, dryRun: z.boolean() }),
  /** 添加（adding 为真）或修改模型；thinkingLevel 写 pi 设置的 modelThinkingLevels */
  z.object({ type: z.literal('models.saveModel'), providerId: providerRef, model: ProviderModelSchema,
    adding: z.boolean(), thinkingLevel: z.enum(THINKING_LEVELS).optional() }),
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
  z.object({ type: z.literal('models.setDefaults'), normalDefault: PickSchema.nullable(),
    allowedZones: AllowedZonesSchema }),
  /** 本机按项目授权：在 allowedZones 之外为这个项目额外允许的区域 */
  z.object({ type: z.literal('models.setProjectZones'), path: z.string().min(1), zones: ZoneListSchema }),
  z.object({ type: z.literal('models.confirmZone'), providerId: providerRef, zone: ZoneSchema }),
  z.object({ type: z.literal('models.dismissMigration') }),
  /** 重新读配置文件（配置读不出时的 Reload） */
  z.object({ type: z.literal('models.reload') }),
  z.object({ type: z.literal('models.verify'), refs: z.array(z.string().min(1)).min(1), tests: z.enum(PROBE_TESTS) }),
  /** 这个会话换选择范围（写一条 mori.pick，不改 normalDefault） */
  z.object({ type: z.literal('session.setPick'), sessionId, pick: PickSchema }),
  /** 顶栏菜单的每一项，按这个会话的项目做静态校验（只读，§9.2） */
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

/** @brief Project access 的一个项目（§9.1、§9.5 models.get 的 projects）。 */
export interface ProjectAccess {
  /** 规范化的项目路径 */
  path: string;
  /** 本机为这个项目在 allowedZones 之外额外授权的区域（model-config.json 的 projectZones[path]） */
  zones: Zone[];
  /** 项目配置 .mori/models.json 写的 allowedZones（排除了的区域的勾选框不可用）；没写、没有文件或文件无效时为 null */
  projectZones: Zone[] | null;
  /** 项目配置 .mori/models.json 的错误原文（§4.3）；有效或没有文件时为 null */
  projectConfig: string | null;
}

/** @brief models.get / models.reload 的结果。 */
export interface ModelsInfo extends ModelsResult {
  /** 用户级配置；key 只有 ref 与 label。读不出时为 null */
  config: ModelConfig | null;
  /** 档案：<provider>/<model> → 档案 */
  profiles: Record<string, ProfileView>;
  /** 按地址建议的区域（§12）：提供商 id → 区域 */
  zoneSuggestions: Record<string, Zone>;
  /** 迁移说明；没有或已 Dismiss 时为 null */
  migration: MigrationNotice | null;
  /** 已知项目（侧栏里的项目）的授权 */
  projects: ProjectAccess[];
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

/** @brief 顶栏菜单的一项（§9.2、§9.5 session.pickOptions）。 */
export interface PickOption {
  /** 这一项的选择范围 */
  pick: ModelPick;
  /** 分组、提供商或模型 */
  kind: 'group' | 'provider' | 'model';
  /** 菜单文字：分组写 id，提供商写名称，模型写模型 id */
  label: string;
  /** 展开后的候选涉及的区域，按 local、intranet、public 的顺序；区域未确认的提供商不计入 */
  zones: Zone[];
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
  'models.deleteModel': DeleteResult;
  'models.moveModel': ModelsResult;
  'models.removeKey': ModelsResult;
  'models.moveKey': ModelsResult;
  'models.saveGroup': ModelsResult;
  'models.deleteGroup': DeleteResult;
  'models.setDefaults': ModelsResult;
  'models.setProjectZones': ModelsResult;
  'models.confirmZone': ModelsResult;
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
    /** 没能确认旧请求已停下就换的（§5.7 cancel_verified 为 unknown，提示注明 couldn't confirm it stopped） */
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

/** @brief 三种自定义条目的 customType。 */
export const MODEL_ENTRY_TYPES = Object.freeze({
  /** 会话的选择范围（§5.1） */
  pick: 'mori.pick',
  /** 段内换模型（§6.1） */
  modelSwitch: 'mori.model_switch',
  /** 为新模型重建了对话（§6.3） */
  rebuild: 'mori.rebuild',
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
