// 进程桥协议：Mori 自己的命令用 zod 定义与校验；pi 的事件只引用类型，不重新定义。

import { z } from 'zod';
import type { AgentSessionEvent, ContextUsage, SessionEntry } from '@earendil-works/pi-coding-agent';

// 界面只经这里引用 pi 的类型。
export type { ContextUsage, SessionEntry };

/** @brief 连接表单可选的接口类型（pi models.json 的 api 字段）。 */
export const API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;

/** @brief 一个兼容选项：勾选时把 compat[field] 写成 value，取消勾选时删除该字段。 */
export interface CompatOption {
  /** 表单里的标识 */
  id: string;
  /** pi compat 字段名 */
  field: string;
  /** 勾选时写入的值 */
  value: boolean | string;
  /** 选项文字 */
  label: string;
  /** 中文说明 */
  hint: string;
}

/** @brief OpenAI 兼容端点的兼容选项，登记在 docs/v0/defaults.md。 */
export const COMPAT_OPTIONS: readonly CompatOption[] = [
  { id: 'noDeveloperRole', field: 'supportsDeveloperRole', value: false, label: '端点不支持 developer 角色',
    hint: '系统提示改用 system 角色发送' },
  { id: 'noStore', field: 'supportsStore', value: false, label: '端点不接受 store 字段',
    hint: '请求里不带 store' },
  { id: 'maxTokens', field: 'maxTokensField', value: 'max_tokens', label: '最大输出用 max_tokens 字段',
    hint: '较老的端点不认识 max_completion_tokens' },
  { id: 'noStreamUsage', field: 'supportsUsageInStreaming', value: false, label: '端点不支持流式用量',
    hint: '不发送 stream_options；上下文用量会显示不准' },
  { id: 'noStrict', field: 'supportsStrictMode', value: false, label: '端点不支持工具参数的 strict 模式',
    hint: '工具定义里不带 strict' },
  { id: 'toolResultName', field: 'requiresToolResultName', value: true, label: '工具结果需要带工具名',
    hint: '部分端点要求工具结果消息带 name 字段' },
];

/** @brief pi 的思考强度（pi-agent-core ThinkingLevel），从低到高。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** @brief 思考强度的界面文字（docs/v0/screens/models.md）。 */
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '关', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
};

/** @brief 连接（pi models.json 里 Mori 的一个 provider）：服务地址、接口类型、key 和兼容选项，下面的模型共用。 */
export const EndpointSchema = z.object({
  /** 显示名称 */
  name: z.string().trim().min(1),
  /** 服务地址，例如 http://host:8000/v1 */
  baseUrl: z.string().trim().url(),
  /** 接口类型 */
  api: z.enum(API_TYPES),
  /** API key；留空表示沿用已保存的 key（仅限服务地址 origin 不变）。Mori 加密保存，不写进 models.json */
  apiKey: z.string().trim(),
  /** 勾选的兼容选项 id（只对 openai-completions 生效） */
  compat: z.array(z.string()),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

/** @brief 连接下的一个模型（models.json 的模型条目，加上 pi 设置里这个模型的新会话默认思考强度）。 */
export const ModelFormSchema = z.object({
  /** 发给端点的模型 ID */
  modelId: z.string().trim().min(1),
  /** 上下文长度（token） */
  contextWindow: z.number().int().positive(),
  /** 支持思考：写 models.json 的 reasoning: true（为假时删掉这个字段），pi 才发送思考参数 */
  reasoning: z.boolean(),
  /** 新会话默认的思考强度：reasoning 为真时写 pi 设置的 modelThinkingLevels["provider/模型"]，为假时删掉 */
  thinkingLevel: z.enum(THINKING_LEVELS),
});
export type ModelForm = z.infer<typeof ModelFormSchema>;

/** @brief 连接表单（首次启动、"添加连接"）：一个连接和它的第一个模型。 */
export const ConnectionSchema = EndpointSchema.extend(ModelFormSchema.shape);
export type Connection = z.infer<typeof ConnectionSchema>;

/** @brief pi 资源的四类（pi 设置里的 extensions / skills / prompts / themes）。 */
export const RESOURCE_KINDS = ['extensions', 'skills', 'prompts', 'themes'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

const sessionId = z.string().min(1);

/** @brief 你对项目信任询问的回答（方案 5.3）；只在 trust.check 说要问时由界面带上。 */
export const TrustAnswerSchema = z.object({
  /** 信任 / 不信任 */
  trusted: z.boolean(),
  /** 勾了"记住"：写进 pi 的 trust.json */
  remember: z.boolean(),
});
export type TrustAnswer = z.infer<typeof TrustAnswerSchema>;

/** @brief 批准权限：每次询问 / 全部允许（方案 5.7，只作用于一个会话）。 */
export type ApprovalMode = 'ask' | 'all';

/** @brief 一个会话的批准设置；只存在后台进程的内存里，重新载入后回到默认值。 */
export interface ApprovalState {
  /** 权限 */
  mode: ApprovalMode;
  /** "本会话不再询问"记下的工具名，按记下的顺序 */
  allowed: string[];
}

/** @brief 新会话的批准设置。 */
export const DEFAULT_APPROVAL: ApprovalState = { mode: 'ask', allowed: [] };

/** @brief "每次询问"时也直接执行的只读工具（方案 5.7：放行名单是一个常量）。 */
export const READ_ONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/**
 * 拒绝时回给模型的工具结果的固定写法（临时默认值，见 docs/v0/defaults.md）。
 * 从会话记录载入时，界面按这几种写法认出"已拒绝"。
 */
export const REJECTED_TEXT = 'Rejected by the user.';
/** @brief 你写了理由时：前缀加理由原文。 */
export const REJECTED_REASON_PREFIX = 'Rejected by the user. Reason: ';
/** @brief 你按了停止、卡还挂着时。 */
export const REJECTED_BY_STOP = 'Rejected: the user stopped the run.';

/** @brief 你在批准卡上的选择：允许一次 / 本会话不再询问此工具 / 拒绝。 */
export const APPROVAL_DECISIONS = ['allow', 'allowSession', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** @brief 引用的来源：一条助手回复里的选区或整轮回复（docs/v0/screens/selection.md "回到原位置"）。 */
export const MessageSourceSchema = z.object({
  kind: z.literal('message'),
  /** 会话文件；还没有时为 null */
  sessionFile: z.string().nullable(),
  /** 这条助手消息的条目 id（mori.entry_id 补发）；还在生成时为 null */
  entryId: z.string().nullable(),
  /** 这条助手消息的时间（pi 消息的 timestamp，ms）；没有 id 时用它找 */
  time: z.number().nullable(),
  /** 选区，或整轮回复（回复下的"引用到输入框"、"反馈这条回复"） */
  scope: z.enum(['selection', 'reply']),
});

/** @brief 引用的来源：文件阅读器里的选区。 */
export const FileSourceSchema = z.object({
  kind: z.literal('file'),
  /** 绝对路径（主进程解析后的） */
  path: z.string().min(1),
  /** 引用时文件内容的 SHA-256（十六进制） */
  sha256: z.string(),
  /** 第一行（从 1 起） */
  startLine: z.number().int().positive(),
  /** 最后一行 */
  endLine: z.number().int().positive(),
});

/** @brief 引用的来源：另一个会话的几轮（docs/v0/screens/session-refs.md）。 */
export const SessionSourceSchema = z.object({
  kind: z.literal('session'),
  /** 原会话的会话文件（改名不变） */
  sessionFile: z.string().min(1),
  /** 引用时显示的会话名 */
  name: z.string(),
  /** 第一轮（从 1 起） */
  fromTurn: z.number().int().positive(),
  /** 最后一轮 */
  toTurn: z.number().int().positive(),
  /** 第一轮你的消息的条目 id */
  fromEntryId: z.string().min(1),
  /** 最后一轮你的消息的条目 id */
  toEntryId: z.string().min(1),
});

/** @brief 一个引用：引用时的原文和来源。 */
export const QuoteRefSchema = z.object({
  /** 引用时的原文；会话引用是按轮整理的内容 */
  quote: z.string().min(1),
  /** 来源 */
  source: z.discriminatedUnion('kind', [MessageSourceSchema, FileSourceSchema, SessionSourceSchema]),
});
export type QuoteRef = z.infer<typeof QuoteRefSchema>;
export type QuoteSource = QuoteRef['source'];
export type MessageSource = z.infer<typeof MessageSourceSchema>;
export type FileSource = z.infer<typeof FileSourceSchema>;
export type SessionSource = z.infer<typeof SessionSourceSchema>;

/** @brief 引用来源写进 pi 会话文件时自定义条目的类型（方案第 6 节）。 */
export const REF_ENTRY_TYPE = 'mori.ref';

/** @brief mori.ref 条目的内容：带引用的那条你的消息和它的引用。 */
export interface RefEntryData {
  /** 你的消息的条目 id */
  messageId: string;
  /** 引用，按芯片顺序 */
  refs: QuoteRef[];
}

/** @brief 界面发给后台进程的全部命令。 */
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('config.get') }),
  /** 测试连接：测这个模型；不带时测默认模型 */
  z.object({
    type: z.literal('connection.test'),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('connection.testCancel') }),
  /** 问后台进程：打开这个文件夹里的会话之前要不要先问你是否信任它 */
  z.object({ type: z.literal('trust.check'), cwd: z.string().min(1) }),
  z.object({ type: z.literal('session.create'), cwd: z.string().min(1), trust: TrustAnswerSchema.optional() }),
  z.object({ type: z.literal('session.open'), sessionFile: z.string().min(1), trust: TrustAnswerSchema.optional() }),
  /** pi 的会话列表（全部项目） */
  z.object({ type: z.literal('session.list') }),
  /** 读出一个会话当前分支的条目（会话引用）；不打开会话，在生成时只给已完成的轮次 */
  z.object({ type: z.literal('session.read'), sessionFile: z.string().min(1) }),
  /**
   * 改名：打开中的会话用 sessionId（经 pi 的 setSessionName）；没打开的用 sessionFile（写进会话文件）。
   * 两个都给时以打开中的会话为准。
   */
  z.object({
    type: z.literal('session.rename'),
    sessionId: sessionId.optional(),
    sessionFile: z.string().min(1).optional(),
    name: z.string().trim().min(1),
  }),
  /** 关闭并释放一个打开中的会话（归档、删除前）；正在生成时拒绝 */
  z.object({ type: z.literal('session.close'), sessionId }),
  /** 你对扩展询问的回答；value 为 null 表示取消（docs/v0/screens/extension-ui.md） */
  z.object({
    type: z.literal('ui.answer'),
    sessionId,
    requestId: z.string().min(1),
    value: z.union([z.boolean(), z.string(), z.null()]),
  }),
  z.object({
    type: z.literal('session.prompt'),
    sessionId,
    text: z.string().min(1),
    /** 生成中时怎样送达：steer 插话，followUp 排队；空闲时两者都等于直接发送 */
    behavior: z.enum(['steer', 'followUp']).optional(),
    /** 输入框里的引用芯片；pi 记下这条消息后写成 mori.ref 条目 */
    refs: z.array(QuoteRefSchema).optional(),
  }),
  z.object({ type: z.literal('session.clearQueue'), sessionId }),
  z.object({ type: z.literal('session.abort'), sessionId }),
  z.object({ type: z.literal('session.state'), sessionId }),
  z.object({
    type: z.literal('approval.answer'),
    sessionId,
    /** 批准请求 id（mori.approval_request） */
    requestId: z.string().min(1),
    decision: z.enum(APPROVAL_DECISIONS),
    /** 拒绝理由；只在拒绝时有意义，空串等于没写 */
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('approval.setMode'), sessionId, mode: z.enum(['ask', 'all']) }),
  /** 从"本会话已允许"里清除一个工具名 */
  z.object({ type: z.literal('approval.forget'), sessionId, toolName: z.string().min(1) }),
  // ---- M6：连接与模型（docs/v0/screens/settings.md） ----
  /** 保存连接表单：providerId 为 null 时新建一个连接，否则改这个连接并写入（或更新）表单里的模型 */
  z.object({
    type: z.literal('connection.save'),
    providerId: z.string().min(1).nullable(),
    connection: ConnectionSchema,
  }),
  /** 只改连接（地址、接口类型、key、兼容选项），不动它下面的模型 */
  z.object({ type: z.literal('endpoint.save'), providerId: z.string().min(1), endpoint: EndpointSchema }),
  /** 添加（adding 为真；ID 已存在时报错）或修改连接下的一个模型 */
  z.object({
    type: z.literal('model.save'),
    providerId: z.string().min(1),
    model: ModelFormSchema,
    adding: z.boolean(),
  }),
  /** 删除模型；是连接的最后一个模型时连接和它的 key 一起删除；默认模型（还有别的模型时）和唯一的模型不能删 */
  z.object({ type: z.literal('model.delete'), providerId: z.string().min(1), modelId: z.string().min(1) }),
  /** 设为默认模型（pi 设置的 defaultProvider / defaultModel） */
  z.object({ type: z.literal('model.setDefault'), providerId: z.string().min(1), modelId: z.string().min(1) }),
  // ---- M6：会话的模型、思考强度与"/"补全（docs/v0/screens/models.md、slash.md） ----
  /** 这个会话换模型（pi setModel，不改默认）；model 为 provider/id */
  z.object({ type: z.literal('session.setModel'), sessionId, model: z.string().min(1) }),
  /** 这个会话换思考强度（pi setThinkingLevel，不改默认） */
  z.object({ type: z.literal('session.setThinking'), sessionId, level: z.enum(THINKING_LEVELS) }),
  /** 这个会话的提示词模板和技能命令 */
  z.object({ type: z.literal('session.commands'), sessionId }),
  // ---- M6：AGENTS.md（docs/v0/screens/settings.md） ----
  /** 用户级 AGENTS.md 和焦点会话加载的文件；没有会话时不带 sessionId */
  z.object({ type: z.literal('agents.get'), sessionId: sessionId.optional() }),
  /** 写 <agentDir>/AGENTS.md */
  z.object({ type: z.literal('agents.save'), content: z.string() }),
  // ---- M6：工具页（docs/v0/screens/tools.md） ----
  /** 工具页的全部内容；跟随的会话的 sessionId，没有会话时不带 */
  z.object({ type: z.literal('tools.get'), sessionId: sessionId.optional() }),
  /** 启停一个资源（照 pi config 的写法）；path 是 tools.get 给出的资源路径 */
  z.object({
    type: z.literal('resource.toggle'),
    sessionId: sessionId.optional(),
    kind: z.enum(RESOURCE_KINDS),
    path: z.string().min(1),
    enabled: z.boolean(),
  }),
  /** 添加本地包（写进用户级设置的 packages） */
  z.object({ type: z.literal('package.add'), path: z.string().min(1) }),
  /** 停用整个包（四类都写成 []）或启用整个包（去掉过滤）；source 是设置里写的 */
  z.object({ type: z.literal('package.setAll'), source: z.string().min(1), enabled: z.boolean() }),
  /** 从用户级设置里移除一个包（不删文件） */
  z.object({ type: z.literal('package.remove'), source: z.string().min(1) }),
  /** 写 <agentDir>/mcp.json 的一个服务；previousName 为 null 时是添加，否则是修改（可以改名） */
  z.object({
    type: z.literal('mcp.save'),
    name: z.string().min(1),
    previousName: z.string().min(1).nullable(),
    entry: z.record(z.string(), z.unknown()),
  }),
  /** 用户级 MCP 服务的启停（enabled） */
  z.object({ type: z.literal('mcp.setEnabled'), name: z.string().min(1), enabled: z.boolean() }),
  /** 把用户级 MCP 服务改为直接调用（exposure: direct） */
  z.object({ type: z.literal('mcp.setDirect'), name: z.string().min(1) }),
  /** 从用户级 mcp.json 移除一个服务 */
  z.object({ type: z.literal('mcp.remove'), name: z.string().min(1) }),
]);
export type Command = z.infer<typeof CommandSchema>;

/** @brief 只返回 pi 报告的配置错误的命令结果（保存成功但 pi 读到的配置有问题时 error 为原文）。 */
export interface SaveResult {
  /** pi 报告的配置错误；没有时为 null */
  error: string | null;
}

/** @brief connection.save 的结果。 */
export interface ConnectionSaveResult extends SaveResult {
  /** 保存到的连接（新建时是新的 provider id） */
  providerId: string;
}

/** @brief 一个模型（设置页的列表）。 */
export interface ModelInfo {
  /** 模型 ID */
  id: string;
  /** 上下文长度 */
  contextWindow: number;
  /** 标了支持思考（models.json 的 reasoning） */
  reasoning: boolean;
  /** 新会话默认的思考强度：pi 会用的那个（modelThinkingLevels → defaultThinkingLevel → medium，按模型收紧） */
  thinkingLevel: ThinkingLevel;
  /** 这个模型可选的思考强度（pi getSupportedThinkingLevels）；不支持思考时只有 off */
  thinkingLevels: ThinkingLevel[];
}

/** @brief 一个连接（models.json 里 Mori 的一个 provider）和它下面的模型。 */
export interface ConnectionInfo {
  /** provider id：第一个连接 mori-endpoint，之后 mori-endpoint-<数字>（删掉的不再用） */
  providerId: string;
  /** 连接本身；apiKey 总是空串 */
  endpoint: Endpoint;
  /** 是否已有保存的 key */
  keySaved: boolean;
  /** 模型，按 models.json 里的顺序 */
  models: ModelInfo[];
}

/** @brief 顶栏模型菜单里的一项：pi 现在能用的模型（有 key 的）。 */
export interface AvailableModel {
  /** provider/id */
  ref: string;
  /** provider id */
  provider: string;
  /** 模型 ID */
  id: string;
  /** 连接名（provider 的 name；没有时为 provider id） */
  providerName: string;
}

/** @brief 会话的模型和思考强度（顶栏，docs/v0/screens/models.md）。 */
export interface ModelState {
  /** 模型（provider/id）；没有可用模型时为 null */
  model: string | null;
  /** 当前的思考强度 */
  thinkingLevel: ThinkingLevel;
  /** 这个模型可选的思考强度（pi getAvailableThinkingLevels） */
  thinkingLevels: ThinkingLevel[];
  /** 模型标了支持思考（pi supportsThinking） */
  reasoning: boolean;
}

/** @brief "/"补全里的一项（docs/v0/screens/slash.md）。 */
export interface SlashCommand {
  /** 不带 / 的名字：模板名，或 skill:技能名 */
  name: string;
  /** 提示词模板或技能 */
  kind: 'prompt' | 'skill';
  /** 说明 */
  description: string;
  /** 模板的 argument-hint；没有时为 null */
  argumentHint: string | null;
}

/** @brief agents.get 的结果（docs/v0/screens/settings.md "AGENTS.md"）。 */
export interface AgentsInfo {
  /** 用户级文件 <agentDir>/AGENTS.md */
  userPath: string;
  /** 它的内容；文件不存在时为 null */
  content: string | null;
  /** agentDir 里实际生效的文件（AGENTS.override.md、AGENTS.md、AGENTS.MD、CLAUDE.md、CLAUDE.MD 中第一个存在的）；都没有时为 null */
  effectivePath: string | null;
  /** 焦点会话加载的其他文件（不含 agentDir 的那个），按 pi 的顺序；没有会话时为 null */
  loaded: string[] | null;
}

/** @brief 工具页的一个工具（pi getAllTools 的一项，不含 hidden）。 */
export interface ToolEntry {
  /** 工具名 */
  name: string;
  /** 说明 */
  description: string;
  /** 给模型（在 getActiveToolNames 里） */
  active: boolean;
  /** pi 的 exposure */
  exposure: string;
  /** 来源种类 */
  source: 'builtin' | 'extension' | 'mcp' | 'package' | 'other';
  /** 来源的说明：扩展的路径、MCP 服务名、包的来源；内置工具为空串 */
  sourceLabel: string;
}

/** @brief 工具页的一个资源（DefaultPackageManager.resolve 的一项）。 */
export interface ResourceEntry {
  /** 种类 */
  kind: ResourceKind;
  /** 文件路径（resolve 给出的，resource.toggle 用它找回这一项） */
  path: string;
  /** 显示的名字（技能取 SKILL.md 的 name，其余取文件名） */
  name: string;
  /** 用途（技能的 description、模板的说明）；没有时为 null */
  description: string | null;
  /** 启用 */
  enabled: boolean;
  /** 用户级或本项目 */
  scope: 'user' | 'project';
  /** 顶层资源或包里的 */
  origin: 'top-level' | 'package';
  /** 包里的资源：包在设置里写的来源；顶层的为 null */
  packageSource: string | null;
  /** 不能在这里启停的原因（本项目的设置改了它等）；能启停时为 null */
  readOnly: string | null;
  /** 技能的正文（去掉 frontmatter）；其他种类为 null */
  body: string | null;
}

/** @brief 工具页的一个包（pi 设置的 packages 的一项）。 */
export interface PackageEntry {
  /** 设置里写的来源 */
  source: string;
  /** 用户级或本项目 */
  scope: 'user' | 'project';
  /** 解析后的文件夹；找不到时为 null */
  root: string | null;
  /** 包里的资源 */
  resources: ResourceEntry[];
  /** 不能在这里改的原因（本项目的包）；能改时为 null */
  readOnly: string | null;
}

/** @brief 工具页的一个 MCP 服务（mcp.json 的一项）。 */
export interface McpServerEntry {
  /** 服务名 */
  name: string;
  /** 来自用户级 mcp.json 或项目的 .pi/mcp.json */
  scope: 'user' | 'project';
  /** 启用（enabled 不是 false） */
  enabled: boolean;
  /** 调用方式（exposure；没写时为 pi 的默认 codemode） */
  exposure: string;
  /** stdio 服务的命令；HTTP 服务为 null */
  command: string | null;
  /** stdio 服务的参数 */
  args: string[];
  /** HTTP 服务的地址；stdio 服务为 null */
  url: string | null;
  /** 条目原样（以 JSON 编辑用） */
  entry: Record<string, unknown>;
  /** 项目的覆盖改了的字段（enabled / exposure / toolExposure）；没有时为空 */
  overrides: string[];
  /** 跟随的会话里它注册的工具名（不含 hidden）；没有会话时为 null */
  tools: string[] | null;
  /** 不能在这里改的原因（本项目的）；能改时为 null */
  readOnly: string | null;
  /** pi 不加载这个条目的原因（照 pi validateMcpServerConfig 和读配置时的检查，原文同 pi）；pi 会加载时为 null */
  problem: string | null;
}

/** @brief tools.get 的结果（docs/v0/screens/tools.md）。 */
export interface ToolsInfo {
  /** 跟随的会话的工作目录；没有会话时为 null */
  cwd: string | null;
  /** 跟随的会话所在文件夹的信任状态；没有会话时为 null */
  projectTrust: ProjectTrust | null;
  /** 跟随的会话注册的工具；没有会话时为 null */
  tools: ToolEntry[] | null;
  /** 全部技能（含停用的、包里的） */
  skills: ResourceEntry[];
  /** 全部包 */
  packages: PackageEntry[];
  /** MCP 服务；没有会话时为 null */
  mcp: { servers: McpServerEntry[]; errors: string[] } | null;
  /** pi 报告的问题原文（技能的 diagnostics、设置读不出等） */
  diagnostics: string[];
}

/** @brief 已保存连接的公开信息；key 不回传界面。 */
export interface SavedConnection {
  /** 连接本身；apiKey 总是空串 */
  connection: Connection;
  /** 是否已有保存的 key */
  keySaved: boolean;
}

/** @brief config.get 的结果。 */
export interface ConfigInfo {
  /** pi 的配置目录 */
  agentDir: string;
  /** 第一个连接和它的第一个模型（首次启动的表单），没有时为 null */
  saved: SavedConnection | null;
  /** Mori 的全部连接（M6） */
  connections: ConnectionInfo[];
  /** 默认模型（provider/id）；没有时为 null */
  defaultModel: string | null;
  /** pi 现在能用的全部模型（顶栏模型菜单） */
  models: AvailableModel[];
  /** pi 读 models.json 时报告的错误（modelRuntime.getError）；没有时为 null */
  modelsError: string | null;
  /**
   * pi 读设置文件（`<agentDir>/settings.json`）时报告的错误，带文件路径（SettingsManager.drainErrors）；没有时为 null。
   * 有错误时 pi 按空设置处理：默认模型读不到、思考强度是 pi 的默认值，模型照常能用
   */
  settingsError: string | null;
  /** pi 设置的 defaultThinkingLevel（没有时为 medium）：新模型的"新会话默认的思考强度"的初始值 */
  defaultThinkingLevel: ThinkingLevel;
}

/** @brief connection.test 的结果。 */
export interface TestResult {
  /** 是否收到了回复（正文或思考） */
  ok: boolean;
  /** 是否被你取消 */
  cancelled: boolean;
  /** 从发出请求到第一个增量的毫秒数 */
  firstTokenMs: number | null;
  /** 整个请求的毫秒数 */
  totalMs: number;
  /** 收到的正文（截断到 200 字符） */
  text: string;
  /** 回复中是否有思考内容 */
  thinking: boolean;
  /** 失败时的错误原文 */
  error: string | null;
}

/**
 * @brief 会话所在文件夹的信任状态：none 文件夹没有要信任的内容；trusted / untrusted 按你的回答或 trust.json 的记录；
 *        unasked 文件夹有要信任的内容却没有回答（问过之后才出现），按不信任打开。
 */
export type ProjectTrust = 'none' | 'trusted' | 'untrusted' | 'unasked';

/** @brief trust.check 的结果。 */
export interface TrustCheck {
  /** 要不要先问你：文件夹有要信任的内容，且 trust.json 没有本文件夹或上层文件夹的记录 */
  ask: boolean;
  /** 读不出 trust.json 时的原文（这时按没有记录处理，会问你） */
  readError: string | null;
}

/** @brief 后台进程里还开着的会话的状态（界面重新加载后，侧栏据此显示状态）。 */
export interface LiveStatus {
  /** 正在生成 */
  running: boolean;
  /** 有挂起的批准请求 */
  approval: boolean;
  /** 有挂起的扩展询问 */
  question: boolean;
}

/** @brief pi 会话列表里的一个会话（SessionManager.listAll 的一项，去掉了全文）。 */
export interface SavedSession {
  /** 会话文件 */
  sessionFile: string;
  /** pi 会话 id */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 名字（最后一条 session_info）；没有时为 null */
  name: string | null;
  /** 第一条你的消息；没有时为 null */
  firstMessage: string | null;
  /** 最后一条你的消息或助手回复的时间（毫秒） */
  modified: number;
  /** 后台进程里还开着这个会话时的状态；没开着时为 null */
  live: LiveStatus | null;
}

/** @brief session.create / session.open 的结果。 */
export interface SessionInfo {
  /** pi 会话 id */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 会话文件；第一条消息之前文件还不存在 */
  sessionFile: string | null;
  /** 会话名（pi 的 session_info）；没有时为 null */
  name: string | null;
  /** 文件夹的信任状态 */
  projectTrust: ProjectTrust;
  /** 信任状态已经记在 trust.json 里（原有的记录，或这次勾了"记住"并写进去了） */
  trustRemembered: boolean;
  /** 没能把"记住"写进 trust.json 时的原文 */
  trustSaveError: string | null;
  /** 加载失败的扩展：路径和原文 */
  extensionErrors: string[];
  /** 扩展在会话打开过程中（session_start）发的通知，打开后显示在对话流里 */
  extensionNotices: ExtensionNotice[];
  /** 当前启用的工具名 */
  tools: string[];
  /** 会话使用的模型（provider/id），没有可用模型时为 null */
  model: string | null;
  /** pi 选不到默认模型时给出的说明 */
  modelNotice: string | null;
  /** 上下文用量（pi getContextUsage） */
  contextUsage: ContextUsage | null;
  /** 批准设置；新建和重新打开的会话都是"每次询问" */
  approval: ApprovalState;
  /** 思考强度（M6，docs/v0/screens/models.md） */
  thinkingLevel: ThinkingLevel;
  /** 这个模型可选的思考强度（pi getAvailableThinkingLevels） */
  thinkingLevels: ThinkingLevel[];
  /** 模型标了支持思考（pi supportsThinking） */
  reasoning: boolean;
}

/** @brief 一个等你回答的扩展询问（mori.ui_request）。 */
export interface UiRequest {
  /** 询问 id，ui.answer 用它答复 */
  requestId: string;
  /** 种类：确认 / 选择 / 输入 */
  method: 'confirm' | 'select' | 'input';
  /** 标题 */
  title: string;
  /** 确认的说明 */
  message?: string;
  /** 选择的选项 */
  options?: string[];
  /** 输入框的提示文字 */
  placeholder?: string;
  /** 超时（毫秒）；没有时为 undefined */
  timeoutMs?: number;
  /** 扩展提出询问的时刻（ms，同一台机器的时钟）；超时从这时算起 */
  askedAt: number;
}

/** @brief 扩展的一条通知（ctx.ui.notify）。 */
export interface ExtensionNotice {
  /** 原文 */
  message: string;
  /** 级别 */
  level: 'info' | 'warning' | 'error';
}

/** @brief 一个挂起的批准请求（与 mori.approval_request 相同）。 */
export interface ApprovalRequestInfo {
  /** 请求 id */
  requestId: string;
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 完整的调用参数 */
  args: Record<string, unknown>;
}

/** @brief 还开着的会话这一刻的样子（界面重新加载后接上它）。 */
export interface LiveSnapshot {
  /** 正在生成 */
  running: boolean;
  /** 正在生成、还没写进会话文件的助手回复（pi 的 state.streamingMessage）；没有时为 null */
  streaming: unknown;
  /** 正在执行的工具调用（pi 的 state.pendingToolCalls）和开始执行的时刻（ms） */
  runningTools: Array<{ toolCallId: string; startedAt: number }>;
  /** 挂起的批准请求 */
  approvals: ApprovalRequestInfo[];
  /** 挂起的扩展询问 */
  questions: UiRequest[];
  /** 排队区：插话（pi 的 getSteeringMessages） */
  steering: string[];
  /** 排队区：排队（pi 的 getFollowUpMessages） */
  followUp: string[];
}

/** @brief session.open 的结果：会话信息加 pi 记录的当前分支（SessionManager.getBranch）。 */
export interface OpenedSession extends SessionInfo {
  /** 从根到当前叶子的条目 */
  entries: SessionEntry[];
  /** 会话本来就在后台进程里开着时这一刻的样子；新打开的为 null */
  live: LiveSnapshot | null;
}

/** @brief session.read 的结果：一个会话已完成的部分（docs/v0/screens/session-refs.md）。 */
export interface SessionContent {
  /** 会话文件 */
  sessionFile: string;
  /** 工作目录 */
  cwd: string;
  /** 会话名（pi 的 session_info）；没有时为 null */
  name: string | null;
  /** 当前分支上引用用得到的条目（你的消息、助手回复、mori.ref），从根起；会话在生成时只到已完成的轮次为止 */
  entries: SessionEntry[];
  /** 会话在生成，最后一轮还没完成、没有交出 */
  unfinished: boolean;
}

/** @brief session.state 的结果。 */
export interface SessionState {
  /** 上下文用量；pi 不知道时为 null */
  contextUsage: ContextUsage | null;
}

/** @brief session.clearQueue 的结果：被撤回的消息。 */
export interface ClearedQueue {
  /** 插话 */
  steering: string[];
  /** 排队 */
  followUp: string[];
}

/** @brief 精简后的 message_update：只带类型、序号和增量，不带完整消息。 */
export interface SlimMessageUpdate {
  /** 固定为 message_update */
  type: 'message_update';
  /** 精简后的 pi-ai AssistantMessageEvent */
  update: {
    /** 事件类型，例如 text_delta、toolcall_start */
    type: string;
    /** 该增量属于助手消息的第几段内容 */
    contentIndex?: number;
    /** 新增的文字 */
    delta?: string;
    /** toolcall_* 时的工具名 */
    toolName?: string;
    /** toolcall_* 时的调用 id */
    toolCallId?: string;
    /** toolcall_end 时完整的调用参数（每次调用只发一次） */
    args?: Record<string, unknown>;
    /** done / error 时的原因 */
    reason?: string;
    /** error 时的错误原文 */
    errorMessage?: string;
  };
}

/**
 * @brief 一次工具调用会怎样处理：ask 要批准；session 本会话已允许；all 全部允许；free 只读工具。
 *        在 pi 的 tool_execution_start 转发之前紧挨着发出，界面据此决定工具卡是"等你批准"还是"执行中"；
 *        批准处理器后来判断不同时再发一次更正（见 KernelEvent 的 mori.tool_gate）。
 */
export type ToolGate = 'ask' | 'session' | 'all' | 'free';

/** @brief 批准请求由谁结束：你、"本会话不再询问"、切到"全部允许"、你按了停止、会话被中止或释放。 */
export type ApprovalEndBy = 'user' | 'session' | 'all' | 'stop' | 'closed';

/** @brief Mori 后台进程自己产生的事件。 */
export type KernelEvent =
  /** 发出提示时就失败（例如没有可用模型） */
  | {
    type: 'mori.prompt_error';
    /** 错误原文 */
    message: string;
    /** 没发出去的提示原文，界面放回输入框 */
    text: string;
    /** 这条提示带的引用芯片，界面连同芯片一起放回；没有时为 null（M3 之前的录制里没有这个字段） */
    refs?: QuoteRef[] | null;
    /** 这时会话是否还在运行（插话、排队的提示失败时本轮可能还在继续） */
    running: boolean;
  }
  /**
   * 这次调用会怎样处理，见 ToolGate。每个调用在 tool_execution_start 之前发一次；批准处理器后来的判断
   * 与预告不同（预告 ask，实际已不用批准）时，同一 toolCallId 会再发一次更正，不带批准请求。
   */
  | {
    type: 'mori.tool_gate';
    /** pi 的 toolCallId */
    toolCallId: string;
    /** 工具名 */
    toolName: string;
    /** 处理方式；更正时为处理器实际的判断 */
    gate: ToolGate;
  }
  /** 批准扩展在等你选择 */
  | {
    type: 'mori.approval_request';
    /** 请求 id，approval.answer 用它答复 */
    requestId: string;
    /** pi 的 toolCallId */
    toolCallId: string;
    /** 工具名 */
    toolName: string;
    /** 完整的调用参数 */
    args: Record<string, unknown>;
  }
  /** 扩展的通知（ctx.ui.notify） */
  | ({ type: 'mori.notify' } & ExtensionNotice)
  /**
   * 补充条目 id（方案第 6 节第 4 件）：pi 先发 message_end、再把消息写进会话；写入后补发这条消息的条目 id。
   * 你的消息带了引用时，refs 是已经写成 mori.ref 条目的引用。
   */
  | {
    type: 'mori.entry_id';
    /** 消息的角色 */
    role: 'user' | 'assistant';
    /** 条目 id */
    entryId: string;
    /** 消息的时间（pi 消息的 timestamp，ms），界面用它对上对话流里的那一项 */
    time: number;
    /** 写进 mori.ref 条目的引用；没有时为 null */
    refs: QuoteRef[] | null;
  }
  /**
   * pi 的 prompt() 结束：通常在本轮结束（agent_settled）之后；pi 把提示交给扩展命令或输入处理器、没有开始运行时，
   * 只有这一个事件（界面据此清掉"刚发出"）。running 为这时会话是否还在运行（插话、排队的提示送进队列就结束）
   */
  | { type: 'mori.prompt_done'; running: boolean }
  /**
   * 会话的模型或思考强度变了（M6）：你在顶栏换了，或你在设置里改了它用的模型、后台进程把会话换成新的模型对象之后。
   * 顶栏以它为准（docs/v0/screens/models.md）
   */
  | ({ type: 'mori.model_state' } & ModelState)
  /** 扩展在等你回答（ctx.ui.confirm / select / input） */
  | ({ type: 'mori.ui_request' } & UiRequest)
  /** 扩展的询问结束：你回答了、超时、扩展取消、停止或会话关闭 */
  | {
    type: 'mori.ui_end';
    /** 询问 id */
    requestId: string;
  }
  /** 批准请求结束：允许或拒绝 */
  | {
    type: 'mori.approval_end';
    /** 结束的请求 id（mori.approval_request） */
    requestId: string;
    /** pi 的 toolCallId */
    toolCallId: string;
    /** 允许或拒绝 */
    decision: 'allow' | 'reject';
    /** 由谁结束，见 ApprovalEndBy */
    by: ApprovalEndBy;
    /** 拒绝时回给模型的工具结果原文；允许时为 null */
    reason: string | null;
  };

/** @brief 转发给界面的事件。 */
export type ForwardedEvent = Exclude<AgentSessionEvent, { type: 'message_update' }> | SlimMessageUpdate | KernelEvent;

/** @brief 界面发往后台进程的请求。 */
export interface RequestEnvelope {
  kind: 'request';
  /** 请求序号，用来匹配回复 */
  id: number;
  /** 要执行的命令 */
  command: Command;
}

/** @brief 后台进程对一条请求的回复。 */
export interface ResponseEnvelope {
  kind: 'response';
  /** 对应请求的序号 */
  id: number;
  /** 命令是否执行成功 */
  ok: boolean;
  /** 成功时的结果 */
  result?: unknown;
  /** 失败时的错误原文 */
  error?: string;
}

/** @brief 后台进程广播的会话事件。 */
export interface EventEnvelope {
  kind: 'event';
  /** 事件所属的 pi 会话 */
  sessionId: string;
  /** 事件本身 */
  event: ForwardedEvent;
}

/** @brief 后台进程发往界面的所有消息。 */
export type KernelMessage = ResponseEnvelope | EventEnvelope;
