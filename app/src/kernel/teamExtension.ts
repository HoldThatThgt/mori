// 内联扩展 mori-team（docs/specs/parallel-agents-taskboard.md §6.3、§7.1、§7.3、§7.5、§8.2、§8.3、§8.5、§14.3）：
// 每个会话（用户会话或实例）一个工厂，注册这个会话的 TaskBoard 工具，并把 pi 的钩子交给 Team：
// context（请求末尾追加工作卡，单独一条 custom 消息，不写进会话文件，§8.3、§14.6 T-T3）、
// tool_result（task 实例的证据编号，§7.3、T-T4）、tool_call（实例交接之后、强制填写的运行里的拒绝，在批准之前，§14.3；
// 对话会话的收窄不在这里，在路径闸第 2 步，file-system-permissions.md §8.3、§8.5）、
// message_start（合并会话的判断入口、程序投递的认出，§5.3）、before_agent_start（用户会话的 mori_team 段与本次运行的职责工具，
// §5.5、§8.5，file-system-permissions.md §8.6）。
// 扩展顺序 mori-models、mori-team、mori-approval、mcp 由会话表保证（§8.2）。

import type {
  AgentSessionEvent, BeforeAgentStartEvent, ExtensionAPI, ExtensionFactory, ToolCallEvent, ToolCallEventResult,
  ToolDefinition, ToolResultEvent, ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { WORK_CARD_TYPE } from './modelContext';

/** @brief pi 的 AgentMessage（context 钩子的消息）。 */
type AgentMessage = Extract<AgentSessionEvent, { type: 'message_start' }>['message'];

/** @brief 一个会话的 mori-team 交给 Team 的钩子；没有的钩子不注册。 */
export interface TeamHooks {
  /** 加载时注册的 TaskBoard 工具（用户会话没有别的角色、没用过协作模式时为空，之后经 onApi 拿到的 API 再注册） */
  tools: readonly ToolDefinition[];
  /** @brief 拿到这个会话的扩展 API（用户会话：之后注册工具、按模式启用工具）。 */
  onApi?(api: ExtensionAPI): void;
  /**
   * @brief 这次请求的工作卡全文（§8.3）；没有卡片时为 null。
   * @param messages 这次请求的上下文（模型层已处理过）
   */
  card?(messages: readonly AgentMessage[]): string | null;
  /** @brief 工具结果（task 实例加证据编号，§7.3）；不改时返回 undefined。 */
  toolResult?(event: ToolResultEvent): ToolResultEventResult | undefined;
  /** @brief 工具调用之前（拒绝时返回结果，带 terminate 的结束这次运行）；放行时返回 undefined。 */
  toolCall?(event: ToolCallEvent): ToolCallEventResult | undefined;
  /** @brief 一条消息开始（用户会话：role 为 user 的消息开始新的一次判断，§5.3）。 */
  messageStart?(message: AgentMessage): void;
  /** @brief 一次运行开始之前（用户会话：按这次运行的模式写 mori_team 段、启用工具，§5.5、§8.5）。 */
  beforeAgentStart?(event: BeforeAgentStartEvent): void;
}

/**
 * @brief 工作卡作为 pi 的 custom 消息（customType mori.work_card，pi 把它作为 user 角色发出，§14.6 T-T3）。
 * @param text 工作卡全文
 */
export function workCardMessage(text: string): AgentMessage {
  return { role: 'custom', customType: WORK_CARD_TYPE, content: text, display: false, timestamp: Date.now() };
}

/**
 * @brief 一个会话的 mori-team 扩展：注册 TaskBoard 工具与 Team 给出的钩子。
 * @param hooks 这个会话的工具与钩子
 */
export function teamExtension(hooks: TeamHooks): ExtensionFactory {
  return (pi) => {
    for (const tool of hooks.tools) pi.registerTool(tool);
    hooks.onApi?.(pi);
    if (hooks.card) {
      const card = hooks.card.bind(hooks);
      pi.on('context', (event) => {
        const text = card(event.messages);
        return text === null ? undefined : { messages: [...event.messages, workCardMessage(text)] };
      });
    }
    if (hooks.toolResult) pi.on('tool_result', hooks.toolResult.bind(hooks));
    if (hooks.toolCall) pi.on('tool_call', hooks.toolCall.bind(hooks));
    if (hooks.messageStart) {
      const start = hooks.messageStart.bind(hooks);
      pi.on('message_start', (event) => start(event.message));
    }
    if (hooks.beforeAgentStart) {
      const before = hooks.beforeAgentStart.bind(hooks);
      pi.on('before_agent_start', (event) => {
        before(event);
      });
    }
  };
}
