// 内联扩展 mori-memory（docs/specs/memory.md §4、§5、§7、§9.6）：每个会话（用户会话、实例会话、增强会话）一个工厂。
// before_agent_start：把 Mori 的身份段写成 customPrompt（覆盖 SYSTEM.md，§4.3；权限句按这次运行开始时的模式，
// docs/specs/file-system-permissions.md §6.16），按这次运行的身份写 taste、strategy、review、facts 四个分节（内容取
// 会话打开时的快照，§5.2）；需要时注册 memory 工具（§7.6）；tool_call：拒绝 write、edit 写进 <userData>/memory
// （§7.7，路径按 pathGate.ts 照抄的 pi 规则解析），增强会话与它的实例里拒绝全部 write、edit（§9.6）。
// 扩展顺序 mori-models、mori-team（有 Team 时）、mori-memory、mori-approval、mcp 由会话表保证（§5.3）：
// mori-team 在同一个 before_agent_start 里先设好这次运行启用的工具，这里读到的才是实际启用的（§4.2）。
// 收尾检查（docs/specs/finish-check.md §4–§6、§9.3）：用户会话（增强会话除外）另注册 finish，运行要结束时
// （agent_before_settle）按分支上这次运行的记录检查或放行，检查那次请求的 context 钩子把这次运行的 <taste>、<review> 接进检查那一行。

import type {
  AgentBeforeSettleEvent, AgentBeforeSettleEventResult, AgentSession, BeforeAgentStartEvent, ExtensionAPI,
  ExtensionContext, ExtensionFactory, SessionEntry, ToolCallEvent, ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { FINISH_CHECK_TYPE } from '../shared/finishCheck';
import type { EnhanceTask } from '../shared/memory';
import type { InstanceKind } from '../shared/team';
import { cardTokens } from './boardText';
import { sessionTitle } from './enhanceDays';
import {
  checkBlock, checkLine, checkRequestIndex, finishTool, runMessages, settleDecision, withCheckBlock, type CheckKind,
  type CheckMessage, type FinishCheckLink,
} from './finishCheck';
import { abstracts, memoryDir, type RunHandle } from './memory';
import { kindsFor, memoryCallerFor, type SessionSeat } from './memoryAssemble';
import type { Snapshot } from './memoryRules';
import { memorySections, renderIdentity, type PromptPermission } from './memoryText';
import { memoryTool, type EvidenceScope, type MemoryPosition, type MemoryToolContext } from './memoryTool';
import { insideDir, resolveToCwd } from './pathGate';
import type { SessionEntryLike } from './sessionReader';

/** @brief 记忆扩展的名字；pi 用 `<inline:名字>` 标出它的加载错误（§5.3）。 */
export const MEMORY_EXTENSION = 'mori-memory';
export const MEMORY_EXTENSION_PATH = `<inline:${MEMORY_EXTENSION}>`;

/** @brief write、edit 写进记忆目录时的拒绝（§7.7，所有会话）。 */
const MEMORY_FILES_ONLY = 'Memory files can only be changed with the memory tool or on the Memory page.';
/** @brief 增强会话与它的实例里 write、edit 的拒绝（§9.6）。 */
const ENHANCEMENT_WRITES = 'Enhancement runs can only change memory, with the memory tool.';

/** @brief 增强会话（与它的实例）所属的这次运行（§9.6）。 */
export interface EnhanceSessionSpec {
  /** 任务 */
  task: EnhanceTask;
  /** beginRun 返回的句柄：写入并进这次运行的修订（§9.8） */
  run: RunHandle;
  /** 这次运行的依据范围（§9.7） */
  scope: EvidenceScope;
}

/** @brief 会话建立时定下的记忆设置（SessionSetup.memory、InstanceSpec.memory）。 */
export interface MemorySessionSpec {
  /** 增强会话与它的实例：这次运行；普通会话为 null */
  enhance: EnhanceSessionSpec | null;
  /** 收尾检查（finish-check §4.2）：用户会话（增强会话除外）的共用状态；实例与增强会话为 null */
  check: FinishCheckLink | null;
}

/** @brief mori-memory 的设置（会话建立时定下）。 */
export interface MemoryExtensionSetup {
  /** 会话打开时读到的两层四种 abstract（§5.2） */
  snapshot: Snapshot;
  /** @brief 这次运行的身份（用户会话按 Team 此刻的模式，实例会话固定，§5.1）；每次运行开始时调用。 */
  seats: () => ReadonlySet<SessionSeat>;
  /** memory 工具的上下文；这个会话没有 memory 工具时为 null（§7.2） */
  tool: MemoryToolContext | null;
  /** 增强会话或它的实例：全部 write、edit 都拒绝（§9.6） */
  enhancement: boolean;
  /** `<userData>/memory`：write、edit 不能写进这里（§7.7） */
  memoryDir: string;
  /** 收尾检查（finish-check §4.2）：为真时注册 finish 与检查的处理器；实例与增强会话为 null */
  check: FinishCheckLink | null;
  /**
   * @brief 身份段权限句用的模式（file-system-permissions.md §6.16，ApprovalPolicy.promptMode()）；每次运行开始时调用，
   *        运行中途换模式不改这次的身份段。
   */
  permission: () => PromptPermission;
}

/** @brief 建 mori-memory 的设置要用的、会话表给出的信息。 */
export interface MemorySetupInput {
  /** 会话的工作目录 */
  cwd: string;
  /** 用户会话，或实例的种类 */
  kind: 'user' | InstanceKind;
  /** 会话的记忆设置 */
  spec: MemorySessionSpec;
  /** @brief 这次运行的身份（§5.1）。 */
  seats: () => ReadonlySet<SessionSeat>;
  /** @brief memory 工具执行时 agent 调用方的位置（§7.3）。 */
  position: () => MemoryPosition;
  /** @brief 身份段权限句用的模式（会话的 ApprovalPolicy.promptMode()，file-system-permissions.md §6.16）。 */
  permission: () => PromptPermission;
}

/**
 * @brief 会话建立时（建资源加载器之前）定下 mori-memory 的设置：读快照（§5.2），按身份定调用方（§7.2、§0 第 1 条）。
 * @param input 会话的工作目录、种类、记忆设置、身份与位置
 */
export async function memorySetup(input: MemorySetupInput): Promise<MemoryExtensionSetup> {
  const enhance = input.spec.enhance;
  const caller = memoryCallerFor(input.seats(), enhance?.task ?? null, input.kind === 'user' ? null : input.kind);
  const tool: MemoryToolContext | null = caller === null ? null : { cwd: input.cwd, caller,
    run: enhance?.run ?? null, scope: enhance?.scope ?? null, position: input.position };
  return { snapshot: await abstracts(input.cwd), seats: input.seats, tool, enhancement: enhance !== null,
    memoryDir: memoryDir(), check: input.spec.check ?? null, permission: input.permission };
}

/**
 * @brief agent 调用方记下的位置（§7.3）：用户会话的文件、写入时侧栏的会话名（§12：pi 的会话名，没有时第一条用户消息的
 *        前 60 字符），以及工具执行时当前分支上最后一条 role: user 的消息条目 id（pi 在 message_end 写进会话，早于工具调用）。
 * @param session 用户会话（实例为它所属的用户会话）
 * @param exact 记下条目 id；分开时的立项实例为假，条目为 null（它判断的消息要等判断完才写进用户会话）
 */
export function sessionPosition(session: AgentSession, exact: boolean): MemoryPosition {
  const manager = session.sessionManager;
  const lines = manager.getEntries().map((entry, index) => ({ line: index + 2,
    entry: entry as unknown as Record<string, unknown> }));
  const last = exact ? lastUserEntry(manager.getBranch()) : null;
  return { session: session.sessionFile ?? null, entry: last, title: sessionTitle(lines, session.sessionName ?? null) };
}

/** @brief 分支上最后一条 role: user 的消息条目 id；没有时为 null。 */
function lastUserEntry(branch: readonly SessionEntry[]): string | null {
  return branch.findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id ?? null;
}

// ---- 身份段与分节（§4.2、§5.2） ----

/**
 * @brief 每次运行开始：customPrompt 为身份段（工具清单取 pi.getActiveTools()，其余取事件里的选项，§4.2；权限句按此刻的
 *        模式，file-system-permissions.md §6.16），四个分节按这次运行的身份写（没有内容的删掉这个键，§5.2）。
 *        不改 selectedTools。
 * @return 这次运行的分节（收尾检查按它定检查那一行与检查块，finish-check §6.3）
 */
function writePrompt(pi: ExtensionAPI, event: BeforeAgentStartEvent,
  setup: MemoryExtensionSetup): Record<string, string | null> {
  const options = event.systemPromptOptions;
  options.customPrompt = renderIdentity({ selectedTools: pi.getActiveTools(), hiddenTools: options.hiddenTools,
    toolSnippets: options.toolSnippets, toolGuidelines: options.toolGuidelines,
    promptGuidelines: options.promptGuidelines }, setup.permission());
  const sections = memorySections(setup.snapshot, kindsFor(setup.seats()));
  for (const [name, text] of Object.entries(sections)) {
    if (text === null) delete options.sections[name];
    else options.sections[name] = text;
  }
  return sections;
}

// ---- 收尾检查（finish-check §5、§6、§9.3） ----

/** @brief 这次运行开始时定下的检查那一行与检查块（finish-check §6.3）：运行中切换协作模式不改它。 */
export interface CheckRun {
  /** 有内容的分节，按 taste、review 的顺序 */
  kinds: CheckKind[];
  /** 检查块；两段都没有时为 null */
  block: string | null;
  /** 检查块（连同前面的空行）的 token 估算，同工作卡的估算（§9.3） */
  blockTokens: number;
}

/**
 * @brief 按这次运行的分节定下检查那一行的种类与检查块（finish-check §6.3）。
 * @param sections writePrompt 写的分节（memorySections 的结果）
 */
export function checkRunOf(sections: Readonly<Record<string, string | null>>): CheckRun {
  const taste = sections.taste ?? null;
  const review = sections.review ?? null;
  const kinds: CheckKind[] = [...(taste === null ? [] : ['taste' as const]),
    ...(review === null ? [] : ['review' as const])];
  const block = checkBlock({ taste, review });
  return { kinds, block, blockTokens: block === null ? 0 : cardTokens(`\n\n${block}`) };
}

/**
 * @brief agent_before_settle（finish-check §5.1）：运行以 completed 要结束时按分支上这次运行的记录检查或放行（§5.2、§5.3；
 *        不按 event.context 的投影数：压缩会把这次运行的检查那一行收进摘要）。检查时记下这次的检查块估算（§9.3），在已有条目
 *        之后加一条不显示的检查那一行，要求接着跑；放行时不返回结果。
 * @param event 边界事件（event.entries 是前面的处理器给的条目）
 * @param ctx 扩展上下文（当前分支；会话 id 写日志）
 * @param run 这次运行的检查那一行与检查块
 * @param link 与会话表共用的估算
 */
export function onBeforeSettle(event: AgentBeforeSettleEvent, ctx: Pick<ExtensionContext, 'sessionManager'>,
  run: CheckRun, link: FinishCheckLink): AgentBeforeSettleEventResult | undefined {
  if (event.outcome !== 'completed') return undefined;
  const decision = settleDecision(runMessages(ctx.sessionManager.getBranch() as SessionEntryLike[]));
  const sessionId = ctx.sessionManager.getSessionId();
  if (!decision.check) {
    if (decision.checks > 0) console.log(`[kernel] ${sessionId}: finish check passed (${decision.reason})`);
    return undefined;
  }
  link.pendingTokens = run.blockTokens;
  console.log(`[kernel] ${sessionId}: finish check ${decision.checks + 1} (${decision.reason})`);
  const line = { type: 'custom_message' as const, customType: FINISH_CHECK_TYPE, content: checkLine(run.kinds),
    display: false };
  return { entries: [...event.entries, line], continue: true };
}

/**
 * @brief 注册收尾检查（finish-check §4.2、§5、§6）：finish 工具，before_agent_start 写身份段与分节并记下这次运行的
 *        检查那一行与检查块，agent_before_settle 检查或放行，context 给检查那次请求接上检查块，agent_settled 清掉
 *        没用上的估算（§9.3）。
 * @param pi 扩展 API
 * @param setup 会话的设置
 * @param link 与会话表共用的估算
 */
function registerFinishCheck(pi: ExtensionAPI, setup: MemoryExtensionSetup, link: FinishCheckLink): void {
  let run: CheckRun = { kinds: [], block: null, blockTokens: 0 };
  pi.registerTool(finishTool());
  pi.on('before_agent_start', (event) => {
    run = checkRunOf(writePrompt(pi, event, setup));
  });
  pi.on('agent_before_settle', (event, ctx) => onBeforeSettle(event, ctx, run, link));
  pi.on('context', (event) => {
    link.pendingTokens = 0;
    const messages = event.messages as unknown as CheckMessage[];
    const index = checkRequestIndex(messages);
    if (index < 0 || run.block === null) return undefined;
    return { messages: [...withCheckBlock(messages, index, run.block)] as unknown as typeof event.messages };
  });
  pi.on('agent_settled', () => {
    link.pendingTokens = 0;
  });
}

// ---- 记忆目录的写保护（§7.7、§9.6） ----

/**
 * @brief tool_call（§7.7、§9.6）：增强会话与它的实例里 write、edit 一律拒绝；其他会话 write、edit 的 path（按
 *        pathGate.ts 的 resolveToCwd 解析）落在 <userData>/memory 里（pathGate.ts 的 insideDir）时拒绝。
 *        命令的写入目标改由路径闸分析（file-system-permissions.md §6、§7），MCP 仍不分析，这里都不检查。
 * @param setup 是否增强会话、记忆目录
 * @param event 工具调用（参数已经 pi 校验）
 * @param cwd 会话的工作目录
 * @return 拒绝；放行时为 undefined
 */
export function guardWrite(setup: Pick<MemoryExtensionSetup, 'enhancement' | 'memoryDir'>, event: ToolCallEvent,
  cwd: string): ToolCallEventResult | undefined {
  if (event.toolName !== 'write' && event.toolName !== 'edit') return undefined;
  if (setup.enhancement) return { block: true, reason: ENHANCEMENT_WRITES };
  const path = (event.input as { path?: unknown }).path;
  if (typeof path !== 'string') return undefined;
  return insideDir(setup.memoryDir, resolveToCwd(path, cwd)) ? { block: true, reason: MEMORY_FILES_ONLY } : undefined;
}

/**
 * @brief 一个会话的 mori-memory：注册 memory 工具（这个会话有它时，只注册一次），每次运行开始时写身份段与分节，
 *        tool_call 拒绝写记忆目录与增强会话里的 write、edit；用户会话（增强会话除外）另有收尾检查（finish-check §4.2）。
 * @param setup 会话建立时定下的设置
 */
export function memoryExtension(setup: MemoryExtensionSetup): ExtensionFactory {
  return (pi) => {
    if (setup.tool) pi.registerTool(memoryTool(setup.tool));
    if (setup.check) registerFinishCheck(pi, setup, setup.check);
    else {
      pi.on('before_agent_start', (event) => {
        writePrompt(pi, event, setup);
      });
    }
    pi.on('tool_call', (event, ctx) => guardWrite(setup, event, ctx.cwd));
  };
}
