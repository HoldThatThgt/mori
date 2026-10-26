// 进程桥协议：Mori 自己的命令用 zod 定义与校验；pi 的事件只引用类型，不重新定义。

import { z } from 'zod';
import type { AgentSessionEvent, ContextUsage, SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  ModelCommandSchemas, THINKING_LEVELS, type ModelEvent, type ModelGlobalEvent, type ModelState,
  type ThinkingLevel,
} from './models';
import { MemoryCommandSchemas, type MemoryGlobalEvent, type MemoryNotice } from './memory';
import { RoleCommandSchemas } from './roles';
import {
  TASK_ID_PATTERN, TEAM_SWITCH, type BoardView, type TaskDetail, type TeamApprovalRequest, type TeamDeciding,
  type TeamEvent, type TeamState,
} from './team';

// 界面只经这里引用 pi 的类型。
export type { ContextUsage, SessionEntry };

// 模型层的取值与类型在 models.ts 定义（protocol.ts 的 CommandSchema 要用到其中的 schema，反过来引用会成环）。
export {
  API_TYPES, COMPAT_OPTIONS, THINKING_LEVELS, type CompatOption, type ConfigInfo, type ModelState, type ThinkingLevel,
} from './models';

/** @brief 思考强度的界面文字（docs/v0/screens/models.md）。 */
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

/** @brief pi 资源的四类（pi 设置里的 extensions / skills / prompts / themes）。 */
export const RESOURCE_KINDS = ['extensions', 'skills', 'prompts', 'themes'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
/** 资源种类的单数（小写），用在工具页开关的读屏名和操作记录里（"Enable skill review"） */
export const KIND_ONE: Record<ResourceKind, string> = {
  extensions: 'extension', skills: 'skill', prompts: 'prompt template', themes: 'theme',
};

const sessionId = z.string().min(1);

/** @brief 你对项目信任询问的回答（方案 5.3）；只在 trust.check 说要问时由界面带上。 */
export const TrustAnswerSchema = z.object({
  /** 信任 / 不信任 */
  trusted: z.boolean(),
  /** 勾了"Remember my choice"：写进 pi 的 trust.json */
  remember: z.boolean(),
});
export type TrustAnswer = z.infer<typeof TrustAnswerSchema>;

/** @brief 批准权限：每次询问 / 全部允许（方案 5.7，只作用于一个会话）。 */
export type ApprovalMode = 'ask' | 'all';

/** @brief 一个会话的批准设置；只存在后台进程的内存里，重新载入后回到默认值。 */
export interface ApprovalState {
  /** 权限 */
  mode: ApprovalMode;
  /** "Allow for this session"记下的工具名，按记下的顺序 */
  allowed: string[];
}

/** @brief 新会话的批准设置。 */
export const DEFAULT_APPROVAL: ApprovalState = { mode: 'ask', allowed: [] };

/** @brief "Ask each time"时也直接执行的只读工具（方案 5.7：放行名单是一个常量）。 */
export const READ_ONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/**
 * 拒绝时回给模型的工具结果的固定写法（临时默认值，见 docs/v0/defaults.md）。
 * 从会话记录载入时，界面按这几种写法认出"Denied"。
 */
export const REJECTED_TEXT = 'Rejected by the user.';
/** @brief 你写了理由时：前缀加理由原文。 */
export const REJECTED_REASON_PREFIX = 'Rejected by the user. Reason: ';
/** @brief 你按了停止、卡还挂着时。 */
export const REJECTED_BY_STOP = 'Rejected: the user stopped the run.';

/** @brief 你在批准卡上的选择："Allow once" / "Allow “<工具>” for this session" / "Deny"。 */
export const APPROVAL_DECISIONS = ['allow', 'allowSession', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** @brief 引用的来源：一条助手回复里的选区或整轮回复（docs/v0/screens/selection.md "Jump to source"）。 */
export const MessageSourceSchema = z.object({
  kind: z.literal('message'),
  /** 会话文件；还没有时为 null */
  sessionFile: z.string().nullable(),
  /** 这条助手消息的条目 id（mori.entry_id 补发）；还在生成时为 null */
  entryId: z.string().nullable(),
  /** 这条助手消息的时间（pi 消息的 timestamp，ms）；没有 id 时用它找 */
  time: z.number().nullable(),
  /** 选区，或整轮回复（回复下的"Attach message as context"、"Give feedback"） */
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
  z.object({ type: z.literal('connection.testCancel') }),
  /** 问后台进程：打开这个文件夹里的会话之前要不要先问你是否信任它 */
  z.object({ type: z.literal('trust.check'), cwd: z.string().min(1) }),
  z.object({ type: z.literal('session.create'), cwd: z.string().min(1), trust: TrustAnswerSchema.optional() }),
  z.object({ type: z.literal('session.open'), sessionFile: z.string().min(1), trust: TrustAnswerSchema.optional() }),
  /** pi 的会话列表（全部项目） */
  z.object({ type: z.literal('session.list') }),
  /** 读出一个会话当前分支的条目（会话引用）；不打开会话，在生成时只给已完成的轮次 */
  z.object({ type: z.literal('session.read'), sessionFile: z.string().min(1), anchor: z.string().min(1).optional() }),
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
    /** 以 /task <文字> 发出（已去掉前缀）：模式为 off 时变为 once（平行 Agent 规格 §5.1） */
    team: z.literal('once').optional(),
  }),
  /** 撤回排队区：pi 的插话与排队，协作模式下还有立项还没开始判断的消息（平行 Agent 规格 §5.3） */
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
  /** 从"Allowed for this session"里清除一个工具名 */
  z.object({ type: z.literal('approval.forget'), sessionId, toolName: z.string().min(1) }),
  // ---- M6：会话的思考强度与"/"补全（docs/v0/screens/models.md、slash.md） ----
  /** 这个会话换思考强度（pi setThinkingLevel，不改默认） */
  z.object({ type: z.literal('session.setThinking'), sessionId, level: z.enum(THINKING_LEVELS) }),
  /** 这个会话的提示词模板和技能命令 */
  z.object({ type: z.literal('session.commands'), sessionId }),
  // ---- M6：AGENTS.md（2026-10-26 起在 Customize，docs/v1/screens/customize-agents-md.md） ----
  /** 用户级 AGENTS.md 和跟随的会话（Customize、记忆页）加载的文件；没有会话时不带 sessionId */
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
  /**
   * pi 内置工具在新会话里默认启用与否（2026-10-26，负责人走查 M12）：写用户级 settings.json 的 defaultTools；
   * name 是 pi 的内置工具名，sessionId 是跟随的会话（受信任项目的设置改了这个工具时拒绝）
   */
  z.object({ type: z.literal('tools.setDefault'), sessionId: sessionId.optional(), name: z.string().min(1),
    enabled: z.boolean() }),
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
  // ---- v1：模型层（docs/specs/model-providers.md §9.5），含 connection.test 与 session.setPick ----
  ...ModelCommandSchemas,
  // ---- v1：平行 Agent 与 TaskBoard（docs/specs/parallel-agents-taskboard.md §13.10） ----
  /** 开关协作模式（顶栏开关、/task on、/task off）；关掉时还不能回到 off 的变为 once（§5.1） */
  z.object({ type: z.literal('session.setTeam'), sessionId, mode: z.enum(TEAM_SWITCH) }),
  /** 这个用户会话的 TaskBoard 视图（只读） */
  z.object({ type: z.literal('board.get'), sessionId }),
  /** 拒绝启动卡的 Check again：重新读、重新校验角色文件；只在会话空闲时可用（§4.4） */
  z.object({ type: z.literal('session.recheckAgents'), sessionId }),
  /** Stop agents（session.stopTeam）：停止这个用户会话的全部 Agent（§11.4） */
  z.object({ type: z.literal('session.stopTeam'), sessionId }),
  /** Background tasks 的 task 视图：一个 task 的详情（只读，§13.13.3） */
  z.object({ type: z.literal('board.readTask'), sessionId, task: z.string().regex(TASK_ID_PATTERN) }),
  /** Background tasks 的会话：task 实例会话或结案会话（只读，§13.13.4） */
  z.object({
    type: z.literal('board.readSession'), sessionId,
    of: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('task'), task: z.string().regex(TASK_ID_PATTERN), role: z.string().min(1) }),
      z.object({ kind: z.literal('close'), request: z.number().int().positive() }),
    ]),
  }),
  /** Stop this task：停止一个 task（§13.13.7） */
  z.object({ type: z.literal('session.stopTask'), sessionId, task: z.string().regex(TASK_ID_PATTERN) }),
  // ---- v1：提示词分层与记忆（docs/specs/memory.md §8） ----
  ...MemoryCommandSchemas,
  // ---- Customize › Agents（docs/specs/customize-agents.md §4、§5） ----
  ...RoleCommandSchemas,
]);
export type Command = z.infer<typeof CommandSchema>;

/** @brief 只返回 pi 报告的配置错误的命令结果（保存成功但 pi 读到的配置有问题时 error 为原文）。 */
export interface SaveResult {
  /** pi 报告的配置错误；没有时为 null */
  error: string | null;
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

/** @brief agents.get 的结果（Customize 的 Instructions 一节，docs/v1/screens/customize-agents-md.md）。 */
export interface AgentsInfo {
  /** 用户级文件 <agentDir>/AGENTS.md */
  userPath: string;
  /** 它的内容；文件不存在时为 null */
  content: string | null;
  /** agentDir 里实际生效的文件（AGENTS.override.md、AGENTS.md、AGENTS.MD、CLAUDE.md、CLAUDE.MD 中第一个存在的）；都没有时为 null */
  effectivePath: string | null;
  /** 焦点会话加载的其他文件（不含 agentDir 的那个）与各自的 token 数（docs/specs/memory.md §10.3），按 pi 的顺序；没有会话时为 null */
  loaded: { path: string; tokens: number }[] | null;
  /** 生效的用户级文件（effectivePath）的 token 数；没有时为 0 */
  userTokens: number;
  /** userTokens 加 loaded 各项之和；超过 500 时界面标出来 */
  total: number;
}

/** @brief pi 的一个内置工具在新会话里的默认（Customize 内置工具的开关，docs/v0/screens/tools.md"内置工具"）。 */
export interface DefaultToolState {
  /** 新会话默认启用：用户级 settings.json 的 defaultTools 按 pi 的规则选出的；受信任项目的设置改了它时按合并后的 */
  enabled: boolean;
  /** 开关不可用的原因（受信任项目的 .pi/settings.json 改了它）；可以开关时为 null */
  readOnly: string | null;
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
  /** pi 的 8 个内置工具在新会话里的默认（开关）；别的工具为 null */
  byDefault: DefaultToolState | null;
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
  /** 共享连接的状态（docs/v0/m6-mcp-shared.md）；还没有这个服务的共享连接时为 null */
  shared: SharedServerState | null;
}

/** @brief 一个共享的 MCP 服务连接（后台进程的共享服务表，照 Claude 桌面版每个服务一份）。 */
export interface SharedServerState {
  /** 启动中（起进程、握手）/ 运行中 / 启动失败或连接断了（关掉的服务不在共享服务表里，不会读到） */
  state: 'starting' | 'running' | 'failed';
  /** 正在用它的会话数 */
  sessions: number;
  /** 失败时的原文（错误第一行，stdio 时接上 stderr 的末尾）；没有时为 null */
  error: string | null;
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
  /**
   * 对话 Agent 自己的运行之外，这个用户会话还有 Agent 在运行或排队（立项、结案、实例，投递队列里等着的运行），
   * 或有待判断的消息（平行 Agent 规格 §13.6：侧栏的“生成中”为 running 或 teamBusy）
   */
  teamBusy: boolean;
  /** 有挂起的后台实例批准卡（mori.team_approval_request，§11.3） */
  teamApproval: boolean;
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

/**
 * @brief 上下文用量的分项（docs/v0/screens/models.md"详情里的分项"）：每项的 token 数。前五项是 Mori 对当前系统提示词
 *        和工具说明的估算，Messages 是用量减去它们，Autocompact buffer 是 pi 的设置值，Free space 是窗口里余下的。
 */
export interface ContextBreakdown {
  /** 系统提示词里除 Memory files、Skills 以外的分节和不分节的正文 */
  systemPrompt: number;
  /** 发给模型的工具说明，MCP 服务的除外 */
  systemTools: number;
  /** MCP 服务的工具说明 */
  mcpTools: number;
  /** AGENTS.md（project_context 分节）和记忆的四个分节 */
  memoryFiles: number;
  /** 技能列表（skills 分节） */
  skills: number;
  /** 用量减去上面五项，不小于 0 */
  messages: number;
  /** pi 自动压缩留出的 token 数；关掉了自动压缩时为 null */
  autocompactBuffer: number | null;
  /** 窗口减去用量和留出的，不小于 0 */
  freeSpace: number;
}

/** @brief session.create / session.open 的结果；模型状态（范围、当前模型、拒绝启动、思考强度）见 ModelState。 */
export interface SessionInfo extends ModelState {
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
  /** 信任状态已经记在 trust.json 里（原有的记录，或这次勾了"Remember my choice"并写进去了） */
  trustRemembered: boolean;
  /** 没能把"Remember my choice"写进 trust.json 时的原文 */
  trustSaveError: string | null;
  /** 加载失败的扩展：路径和原文 */
  extensionErrors: string[];
  /** 扩展在会话打开过程中（session_start）发的通知，打开后显示在对话流里 */
  extensionNotices: ExtensionNotice[];
  /** 当前启用的工具名 */
  tools: string[];
  /** 上下文用量（pi getContextUsage） */
  contextUsage: ContextUsage | null;
  /** 上下文用量的分项；没有用量、还没有消息或刚压缩完时为 null */
  contextBreakdown: ContextBreakdown | null;
  /** 批准设置；新建和重新打开的会话都是"Ask each time" */
  approval: ApprovalState;
  /** 协作状态（平行 Agent 规格 §13.10） */
  team: TeamState;
  /** 这个用户会话的 TaskBoard 视图 */
  board: BoardView;
  /** 挂起的后台实例批准卡，按到达顺序 */
  teamApprovals: TeamApprovalRequest[];
  /** 待判断、还没交给对话的消息与正在判断的那条开始的时刻，与 mori.team_deciding 的载荷相同（§5.3、§13.10） */
  deciding: TeamDeciding;
  /** 增强改了东西后这个项目新建的第一个会话带上的提示（docs/specs/memory.md §9.9）；别的会话为 null */
  memoryNotice: MemoryNotice | null;
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
  /** 准备中：已发消息、pi 还没开始运行（选模型、等待、重建，§11.4） */
  preparing: boolean;
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
  /** 协作状态（平行 Agent 规格 §13.10、§11.6） */
  team: TeamState;
  /** 这个用户会话的 TaskBoard 视图 */
  board: BoardView;
  /** 挂起的后台实例批准卡，按到达顺序 */
  teamApprovals: TeamApprovalRequest[];
  /** 待判断、还没交给对话的消息与正在判断的那条开始的时刻，与 mori.team_deciding 的载荷相同（§5.3、§13.10） */
  deciding: TeamDeciding;
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
  /**
   * 带了 anchor 时（记忆的依据跳转，docs/specs/memory.md §10.2）：完整的当前分支上（不截到已完成的轮次）这个条目或它之上
   * 最近的一条你的消息或助手回复（不含程序投递）的条目 id；条目不在当前分支上时为 null。没带 anchor 时没有这个字段
   */
  anchor?: string | null;
}

/** @brief session.state 的结果。 */
export interface SessionState {
  /** 上下文用量；pi 不知道时为 null */
  contextUsage: ContextUsage | null;
  /** 上下文用量的分项；没有用量、还没有消息或刚压缩完时为 null */
  contextBreakdown: ContextBreakdown | null;
}

/** @brief session.clearQueue 的结果：被撤回的消息。 */
export interface ClearedQueue {
  /** 插话 */
  steering: string[];
  /** 排队 */
  followUp: string[];
  /**
   * 撤回的全部文字，按放回输入框的顺序：插话、排队，然后是立项还没开始判断的消息（平行 Agent 规格 §5.3、§13.10）
   */
  texts: string[];
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
 *        在 pi 的 tool_execution_start 转发之前紧挨着发出，界面据此决定工具卡是"Waiting for your approval"还是"Running…"；
 *        批准处理器后来判断不同时再发一次更正（见 KernelEvent 的 mori.tool_gate）。
 */
export type ToolGate = 'ask' | 'session' | 'all' | 'free';

/** @brief 批准请求由谁结束：你、"Allow for this session"、切到"Allow all"、你按了停止、会话被中止或释放。 */
export type ApprovalEndBy = 'user' | 'session' | 'all' | 'stop' | 'closed';

/** @brief Mori 后台进程自己产生的事件。 */
export type KernelEvent =
  /** 发出提示时就失败（例如没有可用模型） */
  | {
    type: 'mori.prompt_error';
    /** 错误原文 */
    message: string;
    /** 没发出去的提示原文，界面放回输入框；程序投递到用户会话的消息不放回，为 null（平行 Agent 规格 §5.6） */
    text: string | null;
    /** 这条提示带的引用芯片，界面连同芯片一起放回；没有时为 null（M3 之前的录制里没有这个字段） */
    refs?: QuoteRef[] | null;
    /** 这时会话是否还在运行（插话、排队的提示失败时本轮可能还在继续） */
    running: boolean;
    /** 准备中被撤回时一起撤回的、准备中又发的消息，按发送顺序（模型层 §11.4）；v1 之前的录制里没有这个字段 */
    queued?: string[];
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
  /** 模型层的事件（mori.model_state、换模型、重建、等待、排队、重试、说明卡，见 models.ts） */
  | ModelEvent
  /** 协作的事件（协作状态、TaskBoard、回执、进展摘要、程序投递、待判断、后台批准，见 team.ts） */
  | TeamEvent
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

/** @brief 平行 Agent 与 TaskBoard 命令的结果都带的字段（§13.10）。 */
export interface TeamResult {
  /** 命令没能执行时的原文；成功时为 null */
  error: string | null;
}

/** @brief 平行 Agent 与 TaskBoard 每个命令的结果类型（§13.10）。 */
export interface TeamCommandResults {
  'session.setTeam': TeamState & TeamResult;
  'board.get': BoardView & TeamResult;
  'session.recheckAgents': SessionInfo & TeamResult;
  /** texts：回到输入框的待判断消息，按发送顺序（§11.4） */
  'session.stopTeam': { texts: string[] } & TeamResult;
  /** task：这个 task 的详情；读不到时 task 为 null、error 是原文（§13.13.3） */
  'board.readTask': { task: TaskDetail; error: null } | { task: null; error: string };
  /** entries：会话的当前分支；running：实例正在运行（§13.13.4） */
  'board.readSession': { entries: SessionEntry[]; running: boolean } & TeamResult;
  /** 只有 error（§13.13.7） */
  'session.stopTask': TeamResult;
}

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

/** @brief 不属于某个会话的全局事件（模型层 §9.5：mori.profiles、mori.key_status）。 */
export type GlobalEvent = ModelGlobalEvent | MemoryGlobalEvent;

/** @brief 后台进程广播的全局事件。 */
export interface GlobalEventEnvelope {
  kind: 'event';
  /** 全局事件没有会话 */
  sessionId: null;
  /** 事件本身 */
  event: GlobalEvent;
}

/** @brief 后台进程发往界面的所有消息。 */
export type KernelMessage = ResponseEnvelope | EventEnvelope | GlobalEventEnvelope;
