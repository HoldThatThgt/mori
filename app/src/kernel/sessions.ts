// 会话表：在一个后台进程里并存多个 pi 会话（M0 已验证可行），不做调度、优先级或并发限制。

import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { EventEnvelope, SessionInfo } from '../shared/protocol';
import { slimEvent } from './events';
import { getRuntime, loadPi } from './pi';

type Emit = (envelope: EventEnvelope) => void;

const sessions = new Map<string, AgentSession>();

/** @brief 在指定目录新建 pi 会话，绑定扩展并开始转发事件。模型取 pi 设置里的默认模型。 */
export async function createSession(cwd: string, emit: Emit): Promise<SessionInfo> {
  const pi = await loadPi();
  // M0 没有项目信任弹窗（M3 才做），一律按"不信任"创建：项目自带的扩展与配置不加载，AGENTS.md 照常加载。
  // 这是临时默认值，见 docs/v0/defaults.md。
  const settingsManager = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: false });
  const result = await pi.createAgentSession({
    cwd,
    modelRuntime: await getRuntime(),
    settingsManager,
    sessionManager: pi.SessionManager.create(cwd),
  });
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
  };
}

/** @brief 取出已打开的会话。 */
function requireSession(sessionId: string): AgentSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  return session;
}

/** @brief 发出提示；不等本轮结束，结果和失败都通过事件回到界面。 */
export function prompt(sessionId: string, text: string, emit: Emit): { accepted: true } {
  const session = requireSession(sessionId);
  session.prompt(text).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kernel] prompt failed for ${sessionId}: ${message}`);
    emit({ kind: 'event', sessionId, event: { type: 'mori.prompt_error', message } });
  });
  return { accepted: true };
}

/** @brief 停止会话当前的运行。 */
export async function abort(sessionId: string): Promise<{ aborted: true }> {
  await requireSession(sessionId).abort();
  return { aborted: true };
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
