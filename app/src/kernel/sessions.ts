// 会话表：在一个后台进程里并存多个 pi 会话（M0 已验证可行），不做调度、优先级或并发限制。

import { existsSync } from 'node:fs';
import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ClearedQueue, EventEnvelope, OpenedSession, SessionInfo, SessionState } from '../shared/protocol';
import { slimEvent } from './events';
import { getRuntime, loadPi } from './pi';

type Emit = (envelope: EventEnvelope) => void;

const sessions = new Map<string, AgentSession>();

/** @brief 用给定的 SessionManager 在 cwd 创建 pi 会话，绑定扩展并开始转发事件。模型取 pi 设置里的默认模型。 */
async function startSession(cwd: string, sessionManager: SessionManager, emit: Emit): Promise<SessionInfo> {
  const pi = await loadPi();
  // 项目信任弹窗在 M3；在此之前一律按"不信任"创建：项目自带的扩展与配置不加载，AGENTS.md 照常加载。
  // 这是临时默认值，见 docs/v0/defaults.md。
  const settingsManager = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: false });
  const modelRuntime = await getRuntime();
  const result = await pi.createAgentSession({ cwd, modelRuntime, settingsManager, sessionManager });
  const { session } = result;
  for (const error of result.extensionsResult.errors) {
    console.error(`[kernel] extension failed to load: ${error.path}: ${error.error}`);
  }
  await session.bindExtensions({
    onError: (error) => console.error(`[kernel] extension error ${error.extensionPath}: ${error.error}`),
  });
  const sessionId = session.sessionId;
  sessions.set(sessionId, session);
  session.subscribe((event) => emit({ kind: 'event', sessionId, event: slimEvent(event) }));
  return {
    sessionId,
    cwd,
    sessionFile: session.sessionFile ?? null,
    tools: session.getActiveToolNames(),
    model: session.model ? `${session.model.provider}/${session.model.id}` : null,
    modelNotice: result.modelFallbackMessage ?? null,
    contextUsage: session.getContextUsage() ?? null,
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
function requireSession(sessionId: string): AgentSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  return session;
}

/**
 * @brief 发出提示；不等本轮结束，结果和失败都通过事件回到界面。
 * @param behavior 生成中时的送达方式（steer 插话 / followUp 排队），交给 pi 的 prompt；空闲时 pi 直接发送
 */
export function prompt(sessionId: string, text: string, behavior: 'steer' | 'followUp' | undefined, emit: Emit) {
  const session = requireSession(sessionId);
  session.prompt(text, behavior ? { streamingBehavior: behavior } : undefined).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kernel] prompt failed for ${sessionId}: ${message}`);
    emit({ kind: 'event', sessionId, event: { type: 'mori.prompt_error', message, text } });
  });
  return { accepted: true };
}

/** @brief 撤回排队与插话的消息，返回它们的原文。 */
export function clearQueue(sessionId: string): ClearedQueue {
  const { steering, followUp } = requireSession(sessionId).clearQueue();
  return { steering, followUp };
}

/** @brief 停止会话当前的运行。 */
export async function abort(sessionId: string): Promise<{ aborted: true }> {
  await requireSession(sessionId).abort();
  return { aborted: true };
}

/** @brief 读取会话的上下文用量。 */
export function sessionState(sessionId: string): SessionState {
  return { contextUsage: requireSession(sessionId).getContextUsage() ?? null };
}

/** @brief 退出前停止并释放所有会话。 */
export async function shutdownSessions(): Promise<void> {
  const all = [...sessions.values()];
  const results = await Promise.allSettled(all.map((session) => session.abort()));
  for (const result of results) {
    if (result.status === 'rejected') console.error(`[kernel] abort during shutdown failed: ${String(result.reason)}`);
  }
  for (const session of all) session.dispose();
  sessions.clear();
}
