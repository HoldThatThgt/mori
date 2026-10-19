// 会话表：在一个后台进程里并存多个 pi 会话（M0 已验证可行），不做调度、优先级或并发限制。
// 每个会话带一个最小批准扩展（approval.ts），批准状态只在这里的内存里。

import { existsSync } from 'node:fs';
import type { AgentSession, AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  ApprovalDecision, ApprovalMode, ApprovalState, ClearedQueue, EventEnvelope, OpenedSession, SessionInfo, SessionState,
} from '../shared/protocol';
import { ApprovalGate } from './approval';
import { slimEvent } from './events';
import { getRuntime, loadPi } from './pi';

type Emit = (envelope: EventEnvelope) => void;

/** @brief 一个打开的会话和它的批准状态。 */
interface Entry {
  /** pi 会话 */
  session: AgentSession;
  /** 这个会话的批准扩展和批准设置 */
  gate: ApprovalGate;
}

const sessions = new Map<string, Entry>();

/** 批准扩展的名字；pi 用 `<inline:名字>` 标出它的加载错误 */
const APPROVAL_EXTENSION = 'mori-approval';
const APPROVAL_EXTENSION_PATH = `<inline:${APPROVAL_EXTENSION}>`;

/**
 * @brief 转发一个 pi 事件。tool_execution_start 之前紧挨着由批准扩展发 mori.tool_gate：pi 先发
 *        tool_execution_start、再调用批准处理器，界面要在同一时刻就知道这张卡是"等你批准"还是"执行中"；
 *        处理器后来判断不同时由批准扩展发更正。
 */
function forward(entry: Entry, sessionId: string, event: AgentSessionEvent, emit: Emit): void {
  if (event.type === 'tool_execution_start') entry.gate.announce(event.toolCallId, event.toolName);
  emit({ kind: 'event', sessionId, event: slimEvent(event) });
  if (event.type === 'tool_execution_end') entry.gate.noteToolEnd(event.toolCallId);
}

/**
 * @brief 用给定的 SessionManager 在 cwd 创建 pi 会话，带上批准扩展，绑定扩展并开始转发事件。模型取 pi 设置里的默认模型。
 *        资源加载器与 createAgentSession 默认建的相同（同一个 settingsManager），只多一个 inline extension。
 */
async function startSession(cwd: string, sessionManager: SessionManager, emit: Emit): Promise<SessionInfo> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  // 项目信任弹窗在 M3；在此之前一律按"不信任"创建：项目自带的扩展与配置不加载，AGENTS.md 照常加载。
  // 这是临时默认值，见 docs/v0/defaults.md。
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const gate = new ApprovalGate(emit);
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: [{ name: APPROVAL_EXTENSION, factory: gate.extension() }] });
  await resourceLoader.reload();
  const modelRuntime = await getRuntime();
  const result = await pi.createAgentSession({ cwd, modelRuntime, settingsManager, sessionManager, resourceLoader });
  const { session } = result;
  // 一条回复里的多个调用按顺序执行：允许一张卡就执行一张（临时默认值，见 docs/v0/defaults.md）。
  session.agent.toolExecution = 'sequential';
  for (const error of result.extensionsResult.errors) {
    console.error(`[kernel] extension failed to load: ${error.path}: ${error.error}`);
  }
  // 批准扩展没加载上时，pi 没有 tool_call 处理器就不经询问直接执行：这时不打开会话。
  const approvalError = result.extensionsResult.errors.find((error) => error.path === APPROVAL_EXTENSION_PATH);
  if (approvalError) {
    session.dispose();
    throw new Error(`The approval extension failed to load: ${approvalError.error}`);
  }
  await session.bindExtensions({
    onError: (error) => console.error(`[kernel] extension error ${error.extensionPath}: ${error.error}`),
  });
  const sessionId = session.sessionId;
  const entry: Entry = { session, gate };
  gate.attach(sessionId);
  sessions.set(sessionId, entry);
  session.subscribe((event) => forward(entry, sessionId, event, emit));
  return {
    sessionId,
    cwd,
    sessionFile: session.sessionFile ?? null,
    tools: session.getActiveToolNames(),
    model: session.model ? `${session.model.provider}/${session.model.id}` : null,
    modelNotice: result.modelFallbackMessage ?? null,
    contextUsage: session.getContextUsage() ?? null,
    approval: gate.state(),
  };
}

/** @brief 在指定目录新建 pi 会话。 */
export async function createSession(cwd: string, emit: Emit): Promise<SessionInfo> {
  const pi = await loadPi();
  return startSession(cwd, pi.SessionManager.create(cwd), emit);
}

/** @brief 从会话文件重新打开会话（后台进程重启后），返回 pi 记录的当前分支，界面据此重画对话流。 */
export async function openSession(sessionFile: string, emit: Emit): Promise<OpenedSession> {
  if (!existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile}`);
  const pi = await loadPi();
  const manager = pi.SessionManager.open(sessionFile);
  const info = await startSession(manager.getCwd(), manager, emit);
  return { ...info, entries: manager.getBranch() };
}

/** @brief 取出已打开的会话。 */
function requireEntry(sessionId: string): Entry {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session ${sessionId}`);
  return entry;
}

/**
 * @brief 发出提示；不等本轮结束，结果和失败都通过事件回到界面。
 * @param behavior 生成中时的送达方式（steer 插话 / followUp 排队），交给 pi 的 prompt；空闲时 pi 直接发送
 */
export function prompt(sessionId: string, text: string, behavior: 'steer' | 'followUp' | undefined, emit: Emit) {
  const { session } = requireEntry(sessionId);
  session.prompt(text, behavior ? { streamingBehavior: behavior } : undefined).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kernel] prompt failed for ${sessionId}: ${message}`);
    emit({ kind: 'event', sessionId, event: { type: 'mori.prompt_error', message, text } });
  });
  return { accepted: true };
}

/** @brief 撤回排队与插话的消息，返回它们的原文。 */
export function clearQueue(sessionId: string): ClearedQueue {
  const { steering, followUp } = requireEntry(sessionId).session.clearQueue();
  return { steering, followUp };
}

/**
 * @brief 停止会话当前的运行；挂起的批准卡先按拒绝处理（方案 5.8）。
 *        从 rejectForStop 开始到 session.abort() 结束，批准扩展处在停止状态，排在后面的调用不出卡也不执行。
 */
export async function abort(sessionId: string): Promise<{ aborted: true }> {
  const entry = requireEntry(sessionId);
  try {
    await entry.gate.rejectForStop();
    await entry.session.abort();
  } finally {
    entry.gate.endStop();
  }
  return { aborted: true };
}

/** @brief 读取会话的上下文用量。 */
export function sessionState(sessionId: string): SessionState {
  return { contextUsage: requireEntry(sessionId).session.getContextUsage() ?? null };
}

/** @brief 你在批准卡上的选择。 */
export function answerApproval(sessionId: string, requestId: string, decision: ApprovalDecision,
  reason: string | undefined): ApprovalState {
  return requireEntry(sessionId).gate.answer(requestId, decision, reason);
}

/** @brief 切换会话的权限。 */
export function setApprovalMode(sessionId: string, mode: ApprovalMode): ApprovalState {
  return requireEntry(sessionId).gate.setMode(mode);
}

/** @brief 从"本会话已允许"里清除一个工具名。 */
export function forgetApproval(sessionId: string, toolName: string): ApprovalState {
  return requireEntry(sessionId).gate.forget(toolName);
}

/** @brief 退出前停止并释放所有会话；挂起的批准先按拒绝处理，pi 才不会卡在等待上。 */
export async function shutdownSessions(): Promise<void> {
  const all = [...sessions.values()];
  for (const { gate } of all) gate.close();
  const results = await Promise.allSettled(all.map(({ session }) => session.abort()));
  for (const result of results) {
    if (result.status === 'rejected') console.error(`[kernel] abort during shutdown failed: ${String(result.reason)}`);
  }
  for (const { session } of all) session.dispose();
  sessions.clear();
}
