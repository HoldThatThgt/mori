// 界面上的操作：每个操作对应 pi 的一个调用（经后台进程），结果与失败都回到界面状态。

import type {
  ApprovalDecision, ApprovalMode, ApprovalState, ClearedQueue, Command, ConfigInfo, EventEnvelope, OpenedSession,
  SessionInfo, SessionState,
} from '../../../shared/protocol';
import { logCommand, recordAction } from './actionLog';
import { transcriptFromEntries } from './history';
import { emptyTranscript, pushItem, type Transcript } from './model';
import { applyEvent, finishOpenTools } from './transcript';
import { newTab, tabBySession, updateTab, useApp, type Tab } from './store';

/** 对话流每次载入的消息数（一条你的消息或一条助手回复算一条），见方案 5.4 */
export const PAGE_SIZE = 50;

/** 重新载入后在对话流里说明哪些没有恢复（方案 5.8） */
const RELOADED_NOTE = '已重新载入 · 排队消息、批准卡和"本会话已允许"不会恢复';

/** @brief 把异常转成一行原文，并记录到控制台。 */
export function describe(what: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[renderer] ${what} failed: ${message}`);
  return message;
}

/** @brief 发一条命令给后台进程，并记进最近的操作（F8 报告用，不含机密）。 */
export function request<T>(command: Command): Promise<T> {
  logCommand(command);
  return window.mori.request<T>(command);
}

/** @brief 让对话流先显示最近 PAGE_SIZE 条消息，返回起始下标。 */
export function startIndexFor(transcript: Transcript, count = PAGE_SIZE): number {
  let seen = 0;
  for (let index = transcript.items.length - 1; index >= 0; index -= 1) {
    const kind = transcript.items[index]?.kind;
    if (kind === 'user' || kind === 'assistant') seen += 1;
    if (seen > count) return index + 1;
  }
  return 0;
}

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

/** @brief 把会话信息写进会话。批准设置以后台进程返回的为准（新建和重新打开的会话都是"每次询问"）。 */
function withInfo(tab: Tab, info: SessionInfo): Tab {
  return { ...tab, sessionId: info.sessionId, sessionFile: info.sessionFile, model: info.model,
    modelNotice: info.modelNotice, contextUsage: info.contextUsage, approval: info.approval, phase: 'ready',
    error: null };
}

/** @brief 选文件夹并在其中新建会话。 */
export async function openFolder(): Promise<void> {
  const cwd = await window.mori.pickFolder();
  if (!cwd) return;
  const tab = newTab(cwd);
  useApp.setState((state) => ({ tabs: [...state.tabs, tab], activeKey: tab.key, view: 'chat' }));
  try {
    const info = await request<SessionInfo>({ type: 'session.create', cwd });
    updateTab(tab.key, (current) => withInfo(current, info));
    useApp.setState({ firstRun: false });
  } catch (error) {
    const message = describe('session.create', error);
    updateTab(tab.key, (current) => ({ ...current, phase: 'failed', error: message }));
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
  updateTab(key, (current) => ({ ...current, draft: '',
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

/** @brief 归并一个后台进程事件；本轮或压缩结束后刷新上下文用量。 */
export function handleEvent(envelope: EventEnvelope): void {
  const tab = tabBySession(envelope.sessionId);
  if (!tab) return;
  updateTranscript(tab.key, (t) => applyEvent(t, envelope.event, Date.now()));
  if (['turn_end', 'compaction_end', 'agent_settled'].includes(envelope.event.type)) void refreshUsage(tab.key);
  if (envelope.event.type === 'mori.approval_request') void requestAttention();
}

/** @brief 后台进程意外退出：没结束的工具标"已中断"，运行状态清空，草稿不动。 */
export function handleKernelExit(): void {
  useApp.setState((state) => ({
    kernel: 'exited',
    tabs: state.tabs.map((tab) => ({ ...tab, transcript: { ...finishOpenTools(tab.transcript, 'interrupted'),
      running: false, sending: false, stage: null, steering: [], followUp: [], stopRequested: false } })),
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

/** @brief 从会话文件重新打开一个会话，按 pi 记录的当前分支重画对话流。 */
async function reopenFromFile(tab: Tab, sessionFile: string): Promise<void> {
  const opened = await request<OpenedSession>({ type: 'session.open', sessionFile });
  const transcript = pushItem(transcriptFromEntries(opened.entries), { kind: 'note', text: RELOADED_NOTE });
  const startIndex = startIndexFor(transcript);
  updateTab(tab.key, (current) => ({ ...withInfo(current, opened), transcript, startIndex }));
}

/** @brief 重新打开一个会话；会话文件还不存在（没发过消息）时在同一文件夹新建。 */
async function reopen(tab: Tab): Promise<void> {
  try {
    try {
      if (!tab.sessionFile) throw new Error('Session file not found');
      await reopenFromFile(tab, tab.sessionFile);
      return;
    } catch (error) {
      if (!String((error as Error).message).includes('Session file not found')) throw error;
    }
    const info = await request<SessionInfo>({ type: 'session.create', cwd: tab.cwd });
    const transcript = pushItem(emptyTranscript, { kind: 'note', text: '已重新载入 · 这个会话还没有消息，已重新打开' });
    updateTab(tab.key, (current) => ({ ...withInfo(current, info), transcript, startIndex: 0 }));
  } catch (error) {
    const message = describe('reopen', error);
    updateTab(tab.key, (current) => ({ ...current, phase: 'failed', error: message }));
  }
}

/** @brief 通道连上：启动时读取配置；重新载入时重新打开全部会话。 */
export function handleKernelReady(): void {
  const { kernel, tabs, config } = useApp.getState();
  useApp.setState({ kernel: 'ready' });
  // 启动时后台进程就已退出过（例如刷新页面时），配置还没读到：重新读取。
  if (!config && kernel !== 'connecting') void loadConfig();
  if (kernel === 'reloading') {
    for (const tab of tabs) void reopen(tab);
  }
}

/** @brief 打开设置页；fromError 为真时焦点放到 API key（"去设置"）。 */
export function openSettings(fromError = false): void {
  recordAction(fromError ? '去设置' : '打开设置');
  useApp.setState((state) => ({ view: 'settings',
    settingsFocus: fromError ? state.settingsFocus + 1 : state.settingsFocus }));
}

/** @brief 回到会话页：key 为左栏点的会话；不传时回到当前会话（设置页的"返回会话"）。 */
export function showChat(key?: string): void {
  recordAction(key ? '切换会话' : '返回会话');
  useApp.setState((state) => ({ view: 'chat', activeKey: key ?? state.activeKey }));
}

/** @brief 订阅后台进程的事件、退出与就绪。 */
export function connectKernel(): void {
  window.mori.onEvent(handleEvent);
  window.mori.onKernelExit(handleKernelExit);
  window.mori.onKernelReady(handleKernelReady);
  void loadConfig();
}
