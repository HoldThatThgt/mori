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

/** @brief 连接表单：一个端点和一个模型。 */
export const ConnectionSchema = z.object({
  /** 显示名称 */
  name: z.string().trim().min(1),
  /** 服务地址，例如 http://host:8000/v1 */
  baseUrl: z.string().trim().url(),
  /** 接口类型 */
  api: z.enum(API_TYPES),
  /** API key；留空表示沿用已保存的 key（仅限服务地址 origin 不变）。Mori 加密保存，不写进 models.json */
  apiKey: z.string().trim(),
  /** 发给端点的模型 ID */
  modelId: z.string().trim().min(1),
  /** 上下文长度（token） */
  contextWindow: z.number().int().positive(),
  /** 勾选的兼容选项 id（只对 openai-completions 生效） */
  compat: z.array(z.string()),
});
export type Connection = z.infer<typeof ConnectionSchema>;

const sessionId = z.string().min(1);

/** @brief 界面发给后台进程的全部命令。 */
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('config.get') }),
  z.object({ type: z.literal('connection.save'), connection: ConnectionSchema }),
  z.object({ type: z.literal('connection.test') }),
  z.object({ type: z.literal('connection.testCancel') }),
  z.object({ type: z.literal('session.create'), cwd: z.string().min(1) }),
  z.object({ type: z.literal('session.open'), sessionFile: z.string().min(1) }),
  z.object({
    type: z.literal('session.prompt'),
    sessionId,
    text: z.string().min(1),
    /** 生成中时怎样送达：steer 插话，followUp 排队；空闲时两者都等于直接发送 */
    behavior: z.enum(['steer', 'followUp']).optional(),
  }),
  z.object({ type: z.literal('session.clearQueue'), sessionId }),
  z.object({ type: z.literal('session.abort'), sessionId }),
  z.object({ type: z.literal('session.state'), sessionId }),
]);
export type Command = z.infer<typeof CommandSchema>;

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
  /** 已保存的连接，没有时为 null */
  saved: SavedConnection | null;
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

/** @brief session.create / session.open 的结果。 */
export interface SessionInfo {
  /** pi 会话 id */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 会话文件；第一条消息之前文件还不存在 */
  sessionFile: string | null;
  /** 当前启用的工具名 */
  tools: string[];
  /** 会话使用的模型（provider/id），没有可用模型时为 null */
  model: string | null;
  /** pi 选不到默认模型时给出的说明 */
  modelNotice: string | null;
  /** 上下文用量（pi getContextUsage） */
  contextUsage: ContextUsage | null;
}

/** @brief session.open 的结果：会话信息加 pi 记录的当前分支（SessionManager.getBranch）。 */
export interface OpenedSession extends SessionInfo {
  /** 从根到当前叶子的条目 */
  entries: SessionEntry[];
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

/** @brief Mori 后台进程自己产生的事件：发出提示时就失败（例如没有可用模型）。 */
export type KernelEvent = { type: 'mori.prompt_error'; message: string; text: string };

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
