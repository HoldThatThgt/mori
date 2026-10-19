// 进程桥协议：Mori 自己的命令用 zod 定义与校验；pi 的事件只引用类型，不重新定义。

import { z } from 'zod';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** @brief 连接表单：一个 OpenAI 兼容端点和一个模型。 */
export const ConnectionSchema = z.object({
  /** 显示名称 */
  name: z.string().trim().min(1),
  /** 服务地址，例如 http://host:8000/v1 */
  baseUrl: z.string().trim().url(),
  /** API key；留空表示沿用已保存的 key（仅限服务地址 origin 不变）。Mori 加密保存，不写进 models.json */
  apiKey: z.string().trim(),
  /** 发给端点的模型 ID */
  modelId: z.string().trim().min(1),
  /** 上下文长度（token） */
  contextWindow: z.number().int().positive(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** @brief 界面发给后台进程的全部命令。 */
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('config.get') }),
  z.object({ type: z.literal('connection.save'), connection: ConnectionSchema }),
  z.object({ type: z.literal('connection.test') }),
  z.object({ type: z.literal('session.create'), cwd: z.string().min(1) }),
  z.object({ type: z.literal('session.prompt'), sessionId: z.string().min(1), text: z.string().min(1) }),
  z.object({ type: z.literal('session.abort'), sessionId: z.string().min(1) }),
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

/** @brief session.create 的结果。 */
export interface SessionInfo {
  /** pi 会话 id */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 会话文件；第一条消息之前可能为空 */
  sessionFile: string | null;
  /** 当前启用的工具名 */
  tools: string[];
  /** 会话使用的模型（provider/id），没有可用模型时为 null */
  model: string | null;
  /** pi 选不到默认模型时给出的说明 */
  modelNotice: string | null;
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
    /** done / error 时的原因 */
    reason?: string;
    /** error 时的错误原文 */
    errorMessage?: string;
  };
}

/** @brief Mori 后台进程自己产生的事件：发出提示时就失败（例如没有可用模型）。 */
export type KernelEvent = { type: 'mori.prompt_error'; message: string };

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
