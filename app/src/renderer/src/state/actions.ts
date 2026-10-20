// 会话里的操作：每个操作对应 pi 的一个调用（经后台进程），结果与失败都回到界面状态。
// 项目与会话的新建、打开、改名、删除在 projects.ts，信任询问在 trust.ts。

import type {
  ApprovalDecision, ApprovalMode, ApprovalState, ClearedQueue, Command, ConfigInfo, EventEnvelope, ForwardedEvent,
  LiveStatus, SavedSession, SessionState,
} from '../../../shared/protocol';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { persistDrafts } from './drafts';
import { pushItem, type Transcript } from './model';
import { loadSessions, reopenAll } from './projects';
import { applyEvent, finishOpenTools } from './transcript';
import { sameFile, tabByFile, tabBySession, updateTab, useApp } from './store';

/** @brief 读取已保存的连接；没有时进入首次启动。 */
export async function loadConfig(): Promise<void> {
  try {
    const config = await request<ConfigInfo>({ type: 'config.get' });
    // 首次启动只在第一次读取时判断；首次启动页里保存连接后仍停在首次启动，直到测试成功并打开文件夹。
    useApp.setState((state) => ({ config, configError: null,
      firstRun: state.config === null ? config.saved === null : state.firstRun }));
  } catch (error) {
    useApp.setState({ configError: describe('config.get', error) });
  }
}

/** @brief 改写某个会话的对话流。 */
function updateTranscript(key: string, fn: (transcript: Transcript) => Transcript): void {
  updateTab(key, (tab) => ({ ...tab, transcript: fn(tab.transcript) }));
}

/** @brief 把文字放回输入框，放在已有草稿之前。 */
export function putBack(key: string, texts: string[]): void {
  updateTab(key, (tab) => ({ ...tab, draft: [...texts, tab.draft].filter((text) => text.trim()).join('\n\n') }));
}

/**
 * @brief 发送输入框里的文字。
 * @param behavior 生成中时：steer 插话，followUp 排队；空闲时不传
 */
export async function send(key: string, behavior?: 'steer' | 'followUp'): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  const text = tab?.draft.trim();
  if (!tab?.sessionId || !text) return;
  updateTab(key, (current) => ({ ...current, draft: '', activity: Date.now(),
    transcript: behavior ? current.transcript : { ...current.transcript, sending: true } }));
  try {
    await request({ type: 'session.prompt', sessionId: tab.sessionId, text, behavior });
  } catch (error) {
    const message = describe('session.prompt', error);
    updateTranscript(key, (t) => pushItem({ ...t, sending: false },
      { kind: 'error', text: message, restore: text, live: true }));
  }
}

/** @brief 撤回排队区里的全部消息，放回输入框。 */
export async function withdraw(key: string): Promise<void> {
  const sessionId = useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId;
  if (!sessionId) return;
  try {
    const cleared = await request<ClearedQueue>({ type: 'session.clearQueue', sessionId });
    putBack(key, [...cleared.steering, ...cleared.followUp]);
  } catch (error) {
    describe('session.clearQueue', error);
  }
}

/** @brief 停止：先把排队消息放回输入框，再停止生成（方案 5.8）。 */
export async function stop(key: string): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  if (!tab?.sessionId || !tab.transcript.running) return;
  updateTranscript(key, (t) => ({ ...t, stopRequested: true }));
  await withdraw(key);
  try {
    await request({ type: 'session.abort', sessionId: tab.sessionId });
  } catch (error) {
    const message = describe('session.abort', error);
    updateTranscript(key, (t) => pushItem(t, { kind: 'error', text: message, restore: null, live: true }));
  }
}

/**
 * @brief 发一条批准命令，把后台进程返回的批准设置记到会话上。
 *        失败时在对话流里显示原文；请求已经结束（例如你刚按了停止，卡已收到结束事件）只记日志。
 */
async function sendApproval(key: string, command: Command): Promise<void> {
  try {
    const approval = await request<ApprovalState>(command);
    updateTab(key, (tab) => ({ ...tab, approval }));
  } catch (error) {
    const message = describe(command.type, error);
    if (message.includes('is no longer pending')) return;
    updateTranscript(key, (t) => pushItem(t, { kind: 'error', text: message, restore: null, live: true }));
  }
}

/** @brief 会话的 pi 会话 id；还没打开时为 null。 */
function sessionIdOf(key: string): string | null {
  return useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId ?? null;
}

/**
 * @brief 你在批准卡上的选择。
 * @param reason 拒绝理由，只在拒绝时带上；空串等于没写
 */
export async function answerApproval(key: string, requestId: string, decision: ApprovalDecision,
  reason?: string): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (!sessionId) return;
  await sendApproval(key, { type: 'approval.answer', sessionId, requestId, decision,
    reason: decision === 'reject' ? reason : undefined });
}

/**
 * @brief 你对扩展询问的回答；value 为 null 表示取消。询问已经结束（例如刚超时）只记日志，其他失败在对话流里显示原文。
 */
export async function answerQuestion(key: string, requestId: string, value: boolean | string | null): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (!sessionId) return;
  try {
    await request({ type: 'ui.answer', sessionId, requestId, value });
  } catch (error) {
    const message = describe('ui.answer', error);
    if (message.includes('is no longer pending')) return;
    updateTranscript(key, (t) => pushItem(t, { kind: 'error', text: message, restore: null, live: true }));
  }
}

/** @brief 切换会话的权限（每次询问 / 全部允许）。 */
export async function setApprovalMode(key: string, mode: ApprovalMode): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await sendApproval(key, { type: 'approval.setMode', sessionId, mode });
}

/** @brief 从"本会话已允许"里清除一个工具名。 */
export async function forgetApproval(key: string, toolName: string): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await sendApproval(key, { type: 'approval.forget', sessionId, toolName });
}

/** @brief 窗口不在前台时让任务栏闪烁（出现批准卡时）。 */
async function requestAttention(): Promise<void> {
  try {
    await window.mori.requestAttention();
  } catch (error) {
    describe('requestAttention', error);
  }
}

/** @brief 读取上下文用量。 */
export async function refreshUsage(key: string): Promise<void> {
  const sessionId = useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId;
  if (!sessionId) return;
  try {
    const state = await request<SessionState>({ type: 'session.state', sessionId });
    updateTab(key, (tab) => ({ ...tab, contextUsage: state.contextUsage }));
  } catch (error) {
    describe('session.state', error);
  }
}

/** @brief 会话现在是否显示在中栏。 */
function isVisible(key: string): boolean {
  const { view, activeKey } = useApp.getState();
  return view === 'chat' && activeKey === key;
}

/** @brief 一个事件对还开着的会话的状态（侧栏）的改变；不改变时为 null。 */
function liveChange(live: LiveStatus, event: ForwardedEvent): LiveStatus | null {
  switch (event.type) {
    case 'agent_start': return { ...live, running: true };
    case 'agent_settled': return { ...live, running: false, approval: false, question: false };
    case 'mori.approval_request': return { ...live, approval: true };
    case 'mori.approval_end': return { ...live, approval: false };
    case 'mori.ui_request': return { ...live, question: true };
    case 'mori.ui_end': return { ...live, question: false };
    // 扩展命令等没有开始运行的提示只有这一个结束事件。
    case 'mori.prompt_done':
    case 'mori.prompt_error': return { ...live, running: event.running };
    default: return null;
  }
}

/** @brief 一个事件对还没点开的会话（侧栏的行）的改变：名字、最后活动时间、状态；不改变时为 null。 */
function untabbedChange(saved: SavedSession, event: ForwardedEvent): Partial<SavedSession> | null {
  if (event.type === 'session_info_changed') return { name: event.name ?? null };
  if (event.type === 'message_end' && (event.message.role === 'user' || event.message.role === 'assistant')) {
    return { modified: Date.now() };
  }
  const live = saved.live ? liveChange(saved.live, event) : null;
  return live ? { live } : null;
}

/**
 * @brief 界面重新加载后还没点开、但还在后台进程里的会话的事件：更新侧栏的行（列表带回的 live、名字、排序）；
 *        本轮结束时标"有新结果"，要批准时让任务栏闪烁。正在打开（还没拿到会话标识）的由打开结果接上，这里不记。
 *        一个会话可能同时有几个询问，结束一个时这里按"没有了"处理，下一个询问到来时再标上。
 */
function handleUntabbed(envelope: EventEnvelope): void {
  const { sessionId, event } = envelope;
  const saved = useApp.getState().saved.sessions.find((item) => item.sessionId === sessionId && item.live);
  if (!saved || tabByFile(saved.sessionFile)) return;
  const change = untabbedChange(saved, event);
  if (!change) return;
  useApp.setState((state) => ({
    saved: { ...state.saved,
      sessions: state.saved.sessions.map((item) => (item === saved ? { ...item, ...change } : item)) },
    rowMarks: event.type === 'agent_settled' ? { ...state.rowMarks, [saved.sessionFile]: 'unseen' } : state.rowMarks,
  }));
  if (event.type === 'mori.approval_request') void requestAttention();
}

/**
 * @brief 归并一个后台进程事件；本轮或压缩结束后刷新上下文用量。改名事件更新会话名；
 *        不可见的会话本轮结束时标"有新结果"。界面重新加载后还没点开的会话只更新侧栏状态。
 */
export function handleEvent(envelope: EventEnvelope): void {
  const tab = tabBySession(envelope.sessionId);
  if (!tab) {
    handleUntabbed(envelope);
    return;
  }
  const { event } = envelope;
  updateTranscript(tab.key, (t) => applyEvent(t, event, Date.now()));
  if (event.type === 'session_info_changed') {
    updateTab(tab.key, (current) => ({ ...current, name: event.name ?? null }));
  }
  if (event.type === 'agent_settled' && !isVisible(tab.key)) {
    updateTab(tab.key, (current) => ({ ...current, unseen: true }));
  }
  // 侧栏按最后一条你的消息或助手回复的时间排序，与 pi 会话列表的 modified 同一规则。
  if (event.type === 'message_end' && (event.message.role === 'user' || event.message.role === 'assistant')) {
    updateTab(tab.key, (current) => ({ ...current, activity: Date.now() }));
  }
  if (['turn_end', 'compaction_end', 'agent_settled'].includes(event.type)) void refreshUsage(tab.key);
  if (event.type === 'mori.approval_request') void requestAttention();
}

/**
 * @brief 后台进程意外退出：没结束的工具标"已中断"，运行状态清空，草稿不动；正在生成的会话在侧栏标"出错"。
 *        pi 会话随后台进程一起没了，会话标识清掉，之后的命令不会用到它（重新载入后换成新的）。
 */
export function handleKernelExit(): void {
  useApp.setState((state) => ({
    kernel: 'exited',
    // 还没点开的会话：后台进程里的状态随它一起没了，退出时正在生成的标"出错"（打开着的看它自己的对话流）。
    saved: { ...state.saved, sessions: state.saved.sessions.map((item) => ({ ...item, live: null })) },
    rowMarks: { ...state.rowMarks, ...Object.fromEntries(state.saved.sessions.filter((item) => item.live?.running
      && !state.tabs.some((tab) => sameFile(tab.sessionFile, item.sessionFile)))
      .map((item) => [item.sessionFile, 'error' as const])) },
    tabs: state.tabs.map((tab) => ({ ...tab, sessionId: null,
      interrupted: tab.interrupted || tab.transcript.running || tab.transcript.sending,
      transcript: { ...finishOpenTools(tab.transcript, 'interrupted'), running: false, sending: false, stage: null,
        steering: [], followUp: [], stopRequested: false } })),
  }));
}

/** @brief "重新载入"：重启后台进程；新通道连上后由 handleKernelReady 重新打开会话。 */
export async function reload(): Promise<void> {
  recordAction('重新载入后台进程');
  useApp.setState({ kernel: 'reloading' });
  try {
    await window.mori.restartKernel();
  } catch (error) {
    const message = describe('restartKernel', error);
    useApp.setState((state) => ({ kernel: 'exited', tabs: state.tabs.map((tab) => ({ ...tab, error: message })) }));
  }
}

/** @brief 通道连上：启动时读取配置；重新载入时重新读取会话列表并重新打开全部会话。 */
export function handleKernelReady(): void {
  const { kernel, config } = useApp.getState();
  useApp.setState({ kernel: 'ready' });
  // 启动时后台进程就已退出过（例如刷新页面时），配置还没读到：重新读取。
  if (!config && kernel !== 'connecting') void loadConfig();
  if (kernel === 'reloading') reopenAll();
}

/** @brief 打开设置页；fromError 为真时焦点放到 API key（"去设置"）。 */
export function openSettings(fromError = false): void {
  recordAction(fromError ? '去设置' : '打开设置');
  useApp.setState((state) => ({ view: 'settings',
    settingsFocus: fromError ? state.settingsFocus + 1 : state.settingsFocus }));
}

/** @brief 订阅后台进程的事件、退出与就绪；读取配置和会话列表；草稿一变就保存。 */
export function connectKernel(): void {
  persistDrafts();
  window.mori.onEvent(handleEvent);
  window.mori.onKernelExit(handleKernelExit);
  window.mori.onKernelReady(handleKernelReady);
  void loadConfig();
  void loadSessions();
}
