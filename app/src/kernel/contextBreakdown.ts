// 上下文用量的分项（docs/v0/screens/models.md"详情里的分项"，2026-10-26 WP-12；后台进程第 1 件事：读 pi 会话的状态）。
// 输入都取自 pi 会话（sessions.ts contextState）：pi-ai 重放出的当前 system 消息、MCP 工具的名字、getContextUsage
// 和自动压缩留出的 token 数。前五项按 Mori 的估算（estimateMemoryTokens，与记忆页、AGENTS.md 的 token 数相同），
// Messages 取余下的，这样各项加起来等于用量（同 Claude）；Free space 按 pi 判断自动压缩的同一个窗口和留出的数算。

import type { ContextUsage } from '@earendil-works/pi-coding-agent';
import type { SystemMessage, Tool } from '@earendil-works/pi-ai';
import { estimateMemoryTokens, KIND_SECTION } from '../shared/memory';
import type { ContextBreakdown } from '../shared/protocol';

/** @brief 算分项要的输入。 */
export interface BreakdownInput {
  /** 重放之后的当前 system 消息（pi-ai getCurrentSystemMessage(session.messages)）；对话里还没有时为 undefined */
  system: SystemMessage | undefined;
  /** MCP 服务注册的工具名（pi getAllTools() 里来源是 builtin:mcp 的） */
  mcpTools: ReadonlySet<string>;
  /** pi 的上下文用量（getContextUsage） */
  usage: ContextUsage;
  /** pi 自动压缩留出的 token 数（getCompactionSettings 的 reserveTokens）；关掉了自动压缩时为 null */
  reserve: number | null;
}

/** @brief 系统提示词的三项。 */
type PromptParts = Pick<ContextBreakdown, 'systemPrompt' | 'memoryFiles' | 'skills'>;
/** @brief 工具说明的两项。 */
type ToolParts = Pick<ContextBreakdown, 'systemTools' | 'mcpTools'>;

/** 算进 Memory files 的分节：AGENTS.md（pi 的 project_context）和记忆的四个分节（docs/specs/memory.md §5.2） */
const MEMORY_SECTIONS: ReadonlySet<string> = new Set(['project_context', ...Object.values(KIND_SECTION)]);
/** 算进 Skills 的分节（pi system-prompt.js） */
const SKILLS_SECTION = 'skills';

/** @brief system 消息不分节的正文（同 pi-ai contentText：文字块用换行连起来）。 */
function contentText(content: SystemMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

/** @brief 系统提示词按分节归到 System prompt、Memory files、Skills；不分节的正文算 System prompt。 */
function promptParts(system: SystemMessage | undefined): PromptParts {
  const parts: PromptParts = { systemPrompt: 0, memoryFiles: 0, skills: 0 };
  if (!system) return parts;
  parts.systemPrompt += estimateMemoryTokens(contentText(system.content));
  for (const [name, text] of Object.entries(system.sections ?? {})) {
    if (text === null) continue;
    const key = MEMORY_SECTIONS.has(name) ? 'memoryFiles' : name === SKILLS_SECTION ? 'skills' : 'systemPrompt';
    parts[key] += estimateMemoryTokens(text);
  }
  return parts;
}

/** @brief 发给模型的工具说明（名字、说明、参数的 JSON）按来源归到 MCP tools 和 System tools。 */
function toolParts(tools: readonly Tool[], mcpTools: ReadonlySet<string>): ToolParts {
  const parts: ToolParts = { systemTools: 0, mcpTools: 0 };
  for (const tool of tools) {
    parts[mcpTools.has(tool.name) ? 'mcpTools' : 'systemTools'] += estimateMemoryTokens(JSON.stringify(tool));
  }
  return parts;
}

/**
 * @brief 上下文用量的分项。
 * @param input pi 会话的当前 system 消息、MCP 工具名、用量和自动压缩留出的数
 * @return 各分项；还没有消息（用量为 0）或刚压缩完（用量为 null）时为 null，这两种状态显示说明、不显示分项
 */
export function contextBreakdown(input: BreakdownInput): ContextBreakdown | null {
  const { usage, reserve } = input;
  if (usage.tokens === null || usage.tokens <= 0) return null;
  const tokens = Math.round(usage.tokens);
  const prompt = promptParts(input.system);
  const tools = toolParts(input.system?.toolsAdded ?? [], input.mcpTools);
  const fixed = prompt.systemPrompt + prompt.memoryFiles + prompt.skills + tools.systemTools + tools.mcpTools;
  return { ...prompt, ...tools, messages: Math.max(0, tokens - fixed), autocompactBuffer: reserve,
    freeSpace: Math.max(0, usage.contextWindow - tokens - (reserve ?? 0)) };
}
