// 会话里的操作：每个操作对应 pi 的一个调用（经后台进程），结果与失败都回到界面状态。
// 项目与会话的新建、打开、改名、删除在 projects.ts，信任询问在 trust.ts。

import type {
  ApprovalDecision, ApprovalMode, ApprovalState, ClearedQueue, Command, ConfigInfo, EventEnvelope, ForwardedEvent,
  GlobalEventEnvelope, LiveStatus, QuoteRef, SavedSession, SessionState, TeamCommandResults,
} from '../../../shared/protocol';
import { STOPPED_BEFORE_SENDING } from '../../../shared/models';
import { recordAction } from './actionLog';
import type { AskReply } from './asks';
import { describe, request } from './bridge';
import { persistDrafts } from './drafts';
import { addPendingPrompt, pendingPrompt, pushItem, setPendingQueued, type Transcript } from './model';
import { loadSessions, reopenAll } from './projects';
import { addQuote, composePrompt, stripQuotes } from './quotes';
import { guardLeave } from './leaveGuard';
import { skillCommandText } from './skillText';
import { decidesFirst, parseTeamCommand, setTeam } from './teamActions';
import { applyEvent, finishOpenTools } from './transcript';
import { isShown, modelStateOf, sameFile, tabByFile, tabBySession, updateTab, useApp, type Tab } from './store';

/** @brief 读取配置；后台进程说要首次启动（还没有模型配置、也没有迁移成，§9.4）时进入首次启动。 */
export async function loadConfig(): Promise<void> {
  try {
    const config = await request<ConfigInfo>({ type: 'config.get' });
    // 首次启动只在第一次读取时判断；首次启动页里保存连接后仍停在首次启动，直到测试成功并打开文件夹。
    useApp.setState((state) => ({ config, configError: null,
      firstRun: state.config === null ? config.firstRun : state.firstRun }));
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
 * @brief 把没发出去的带引用的消息放回输入框：引用芯片放回芯片（已有的不重复），全文去掉引用块只放回你写的字；
 *        引用块对不上时放回全文。
 */
export function putBackQuoted(key: string, text: string, refs: QuoteRef[]): void {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  if (!tab) return;
  putBack(key, [stripQuotes(text, refs, tab.cwd) ?? text]);
  for (const ref of refs) addQuote(key, ref);
}

/** @brief 会话是否在准备中（模型层 §11.4）：你发了消息，pi 还没开始运行。 */
export function isPreparing(tab: Tab): boolean {
  return tab.transcript.sending && !tab.transcript.running;
}

/**
 * @brief 发送前对话流的变化：空闲时你的消息先显示出来、会话进入"发送中"（准备中，§11.4）；
 *        准备中再发的显示在排队区；生成中的插话与排队等 pi 的排队区（不变）。
 */
function beforeSend(transcript: Transcript, text: string, refs: QuoteRef[], how: SendHow): Transcript {
  if (how === 'pending') return setPendingQueued(transcript, text, true);
  return how === 'idle' ? addPendingPrompt(transcript, text, refs) : transcript;
}

/** @brief 发送失败：撤掉发送前加的（先显示的消息或排队区里暂存的那条），会话不再"发送中"。 */
function afterFailure(transcript: Transcript, text: string, how: SendHow): Transcript {
  if (how === 'pending') return setPendingQueued(transcript, text, false);
  if (how !== 'idle') return transcript;
  const items = transcript.items.filter((item) => !(item.kind === 'user' && item.pending));
  return { ...transcript, items, sending: false };
}

/** @brief 一次发送的方式：空闲时发、准备中再发（暂存）、生成中插话或排队。 */
type SendHow = 'idle' | 'pending' | 'steer' | 'followUp';

/**
 * @brief 发送输入框里的文字和引用芯片：发给模型的全文是引用块加你的文字（quotes.ts composePrompt），
 *        芯片随命令带给后台进程，pi 记下这条消息后写成 mori.ref 条目。会话被拒绝启动时不发送（草稿不丢，§4.6）。
 *        准备中再发的按排队处理（准备中不能插话，§11.4），由后台进程暂存，pi 开始后作为排队消息交给 pi。
 *        协作（平行 Agent 规格 §5.1）：原文是 /team on、/team off 时不发消息、改协作模式（被拒绝启动时也照样执行），
 *        只清空文字、芯片留着；只有 /team 时不发送；/team <文字> 去掉前缀、带 team: 'once' 发出。分开时立项先判断的
 *        消息在准备中再发时不进暂存区，由待判断队列显示在排队区（§5.3）；不经立项的扩展命令由后台进程暂存，按结果的
 *        held 显示在排队区。
 * @param behavior 生成中时：steer 插话，followUp 排队；空闲时不传
 */
export async function send(key: string, behavior?: 'steer' | 'followUp'): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  if (!tab?.sessionId) return;
  const command = parseTeamCommand(tab.draft);
  if (command.kind === 'switch') {
    updateTab(key, (current) => ({ ...current, draft: '' }));
    await setTeam(key, command.mode);
    return;
  }
  if (command.kind === 'bare' || tab.blocked) return;
  const once = command.kind === 'once';
  const refs = tab.draftRefs;
  const text = composePrompt(refs, once ? command.text : tab.draft, tab.cwd);
  if (!text) return;
  const preparing = isPreparing(tab);
  const how: SendHow = preparing ? (decidesFirst(tab, once) ? 'followUp' : 'pending') : behavior ?? 'idle';
  updateTab(key, (current) => ({ ...current, draft: '', draftRefs: [], activity: Date.now(),
    transcript: beforeSend(current.transcript, text, refs, how) }));
  try {
    const result = await request<{ held: boolean }>({ type: 'session.prompt', sessionId: tab.sessionId, text,
      behavior: how === 'idle' ? undefined : how === 'pending' ? 'followUp' : how,
      refs: refs.length > 0 ? refs : undefined, team: once ? 'once' : undefined });
    // 立项先判断的消息不进暂存区；照 v0 交给对话的扩展命令（§5.3）却暂存在准备中，同样显示在排队区
    if (how === 'followUp' && preparing && result.held) {
      updateTranscript(key, (t) => setPendingQueued(t, text, true));
    }
  } catch (error) {
    const message = describe('session.prompt', error);
    updateTranscript(key, (t) => pushItem(afterFailure(t, text, how),
      { kind: 'error', text: message, restore: text, live: true, ...(refs.length ? { refs } : {}) }));
  }
}

/**
 * @brief 撤回、停止期间待判断队列里少了的消息是回到输入框（teamEvents.ts applyDeciding）：命令返回之前一直如此。
 * @param run 发命令的那一段
 */
async function holdingDeciding(key: string, run: () => Promise<void>): Promise<void> {
  updateTranscript(key, (t) => ({ ...t, decidingHold: true }));
  try {
    await run();
  } finally {
    updateTranscript(key, (t) => ({ ...t, decidingHold: false }));
  }
}

/**
 * @brief 撤回排队区里的全部消息，放回输入框。pi 排队的是展开后的文字：技能命令按排队区的写法
 *        放回"/skill:名字 参数"，不放回展开后的 <skill> 块（docs/v0/screens/slash.md）。
 *        协作模式下同时撤回立项还没开始判断的消息（平行 Agent 规格 §5.3），结果的 texts 按放回的顺序列出全部。
 */
export async function withdraw(key: string): Promise<void> {
  const sessionId = useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId;
  if (!sessionId) return;
  await holdingDeciding(key, async () => {
    try {
      const cleared = await request<ClearedQueue>({ type: 'session.clearQueue', sessionId });
      putBack(key, cleared.texts.map(skillCommandText));
    } catch (error) {
      describe('session.clearQueue', error);
    }
  });
}

/**
 * @brief 停止：先把排队消息放回输入框，再停止生成（方案 5.8）。准备中（§11.4）只停止：后台进程撤回这条消息和暂存的
 *        消息，经 mori.prompt_error 交回文字，由 handleEvent 放回输入框。协作模式下不先撤回：pi 排队区的消息、立项为
 *        这次回复判断的消息与其余待判断的消息由后台进程按发送顺序经一个 mori.prompt_error 交回；后台的 Agent 照常运行
 *        （平行 Agent 规格 §11.4）。
 */
export async function stop(key: string): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  if (!tab?.sessionId || !(tab.transcript.running || tab.transcript.sending)) return;
  const sessionId = tab.sessionId;
  updateTranscript(key, (t) => ({ ...t, stopRequested: true }));
  if (tab.transcript.running && tab.team.mode === 'off') await withdraw(key);
  await holdingDeciding(key, async () => {
    try {
      await request({ type: 'session.abort', sessionId });
    } catch (error) {
      const message = describe('session.abort', error);
      updateTranscript(key, (t) => pushItem(t, { kind: 'error', text: message, restore: null, live: true }));
    }
  });
}

/**
 * @brief Stop team（平行 Agent 规格 §11.4、§13.6）：停止这个会话的全部 Agent；结果里的待判断消息按发送顺序放回输入框。
 *        对话在回复时“已停止”一行由它的 agent_settled 写（按停止处理）；对话没在回复时命令返回后写一行。
 */
export async function stopTeam(key: string): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  if (!tab?.sessionId) return;
  const sessionId = tab.sessionId;
  const running = tab.transcript.running;
  if (running) updateTranscript(key, (t) => ({ ...t, stopRequested: true }));
  await holdingDeciding(key, async () => {
    try {
      const result = await request<TeamCommandResults['session.stopTeam']>({ type: 'session.stopTeam', sessionId });
      if (result.error) throw new Error(result.error);
      putBack(key, result.texts);
      if (!running) updateTranscript(key, (t) => pushItem(t, { kind: 'stopped' }));
    } catch (error) {
      const message = describe('session.stopTeam', error);
      updateTranscript(key, (t) => pushItem(t, { kind: 'error', text: message, restore: null, live: true }));
    }
  });
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
 * @brief 你在批准卡上的选择：Allow once（allow）、按工具名 Allow for this session（allowSession，只用于 scope inside 的
 *        请求）、按目录 Allow writes to … for this session（allowDir，只用于 allowDirs 不为空的请求，目录由后台进程按
 *        请求定，docs/specs/file-system-permissions.md §6.8、§6.9）、Deny（reject）。后台批准卡同样用它（requestId
 *        是实例的请求 id）。用错时命令失败，原文显示在对话流里。
 * @param reason 拒绝理由，只在拒绝时带上；空串等于没写
 */
export async function answerApproval(key: string, requestId: string, decision: ApprovalDecision,
  reason?: string): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (!sessionId) return;
  await sendApproval(key, { type: 'approval.answer', sessionId, requestId, decision,
    reason: decision === 'reject' ? reason : undefined });
}

/** @brief 对询问的答复：扩展询问（ui.answer）、提问卡（question.answer）。 */
type AnswerCommand = Extract<Command, { type: 'ui.answer' | 'question.answer' }>;

/**
 * @brief 发一条对询问的答复。询问已经结束（例如刚超时、你不在时刚按默认处理）只记日志，其他失败在对话流里显示原文。
 */
async function sendAnswer(key: string, command: AnswerCommand): Promise<void> {
  try {
    await request(command);
  } catch (error) {
    const message = describe(command.type, error);
    if (message.includes('is no longer pending')) return;
    updateTranscript(key, (t) => pushItem(t, { kind: 'error', text: message, restore: null, live: true }));
  }
}

/** @brief 你对扩展询问的回答；value 为 null 表示取消。 */
export async function answerQuestion(key: string, requestId: string, value: boolean | string | null): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await sendAnswer(key, { type: 'ui.answer', sessionId, requestId, value });
}

/**
 * @brief 你在提问卡上的答复（question.answer，docs/specs/file-system-permissions.md §10.5、§10.6）：answers 按问题的
 *        顺序（asks.ts 的 askReply 由卡上的选择给出）；为 null 表示拒绝回答（焦点在卡上时按 Esc）。卡随后由
 *        mori.question_end 去掉。
 */
export async function answerAsk(key: string, requestId: string, answers: AskReply[] | null): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await sendAnswer(key, { type: 'question.answer', sessionId, requestId, answers });
}

/**
 * @brief 切换会话的权限（Ask each time / Full access，§6.7）：切到 Full access 之前界面先确认；之后挂起的 scope inside
 *        请求由后台进程按允许结束（by: 'full'）。
 */
export async function setApprovalMode(key: string, mode: ApprovalMode): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await sendApproval(key, { type: 'approval.setMode', sessionId, mode });
}

/**
 * @brief 从"Allowed for this session"里清除一个工具名（{ toolName }）或一个按目录放行的目录（{ dir }，§6.9 的 Forget）。
 */
export async function forgetApproval(key: string, target: { toolName: string } | { dir: string }): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await sendApproval(key, { type: 'approval.forget', sessionId, ...target });
}

/** @brief 窗口不在前台时让任务栏闪烁（出现批准卡、后台批准卡或提问卡时；扩展询问不闪，§9.9）。 */
async function requestAttention(): Promise<void> {
  try {
    await window.mori.requestAttention();
  } catch (error) {
    describe('requestAttention', error);
  }
}

/** @brief 这个事件要不要让任务栏闪烁：批准请求、后台批准请求、提问卡（file-system-permissions.md §9.9）。 */
function wantsAttention(event: ForwardedEvent): boolean {
  return event.type === 'mori.approval_request' || event.type === 'mori.team_approval_request'
    || event.type === 'mori.question_request';
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

/**
 * @brief 模型状态与思考强度的事件（docs/v1/screens/model-menu.md）：mori.model_state 带 ModelState 的全部各项，
 *        pi 的事件只带新的强度。
 */
function withModelEvent(tab: Tab, event: ForwardedEvent): Tab {
  if (event.type === 'thinking_level_changed') return { ...tab, thinkingLevel: event.level };
  if (event.type !== 'mori.model_state') return tab;
  return { ...tab, ...modelStateOf(event) };
}

/**
 * @brief 准备中被撤回的消息（§11.4、§5.8）：mori.prompt_error 或段开始时就没有可用模型的 mori.model_unavailable。
 *        这条消息（带引用芯片时去掉引用块、芯片放回）与暂存的消息按发送顺序放回输入框。没有要撤回的时不动。
 *        pi 的 prompt() 没有开始运行就结束时，mori.prompt_done 先到、已撤回先显示的消息，随后的
 *        “Stopped before sending”仍要放回（这时 text 是准备中又发的第一条，queued 是其余的）。
 */
function restoreWithdrawn(tab: Tab, event: ForwardedEvent): void {
  const pending = pendingPrompt(tab.transcript);
  if (event.type === 'mori.prompt_error' && (pending || event.message === STOPPED_BEFORE_SENDING)) {
    restoreTexts(tab, event.text, event.refs ?? pending?.refs ?? [], event.queued ?? []);
  }
  if (event.type === 'mori.model_unavailable' && event.firstRequest) {
    restoreTexts(tab, event.text, pending?.refs ?? [], event.queued);
  }
}

/**
 * @brief 把撤回的消息和暂存的消息放回输入框（在已有草稿之前），引用芯片一并放回。协作模式下停止时交回的有 pi 排队区的
 *        文字：技能命令同撤回一样放回 "/skill:名字 参数"（skillCommandText，对没展开的原文不改）。
 */
function restoreTexts(tab: Tab, text: string | null, refs: QuoteRef[], queued: string[]): void {
  const own = text === null || refs.length === 0 ? text : stripQuotes(text, refs, tab.cwd) ?? text;
  putBack(tab.key, [...(own === null ? [] : [own]), ...queued].map(skillCommandText));
  if (text !== null) for (const ref of refs) addQuote(tab.key, ref);
}

/** @brief 一个事件对还开着的会话的状态（侧栏）的改变；不改变时为 null。 */
function liveChange(live: LiveStatus, event: ForwardedEvent): LiveStatus | null {
  switch (event.type) {
    case 'agent_start': return { ...live, running: true };
    case 'agent_settled': return { ...live, running: false, approval: false, question: false };
    case 'mori.approval_request': return { ...live, approval: true };
    case 'mori.approval_end': return { ...live, approval: false };
    // 扩展询问与提问卡（ask_user_question）都是“等你回答”（docs/specs/file-system-permissions.md §9.9）。
    case 'mori.ui_request':
    case 'mori.question_request': return { ...live, question: true };
    case 'mori.ui_end':
    case 'mori.question_end': return { ...live, question: false };
    // 扩展命令等没有开始运行的提示只有这一个结束事件。
    case 'mori.prompt_done':
    case 'mori.prompt_error': return { ...live, running: event.running };
    // 段开始时就等不到模型（§5.8）：后台进程只发这一个事件，没有 prompt_error 或 agent_settled。
    case 'mori.model_unavailable': return event.firstRequest ? { ...live, running: false } : null;
    // 协作（平行 Agent 规格 §13.6、§13.10）：对话以外还有 Agent 在运行或排队、或有待判断的消息；后台批准卡。
    case 'mori.team_state': return { ...live, teamBusy: event.background };
    case 'mori.team_approval_request': return { ...live, teamApproval: true };
    case 'mori.team_approval_end': return { ...live, teamApproval: false };
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
 *        本轮结束时标"Unread"，要批准或有提问卡时让任务栏闪烁。正在打开（还没拿到会话标识）的由打开结果接上，这里不记。
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
  if (wantsAttention(event)) void requestAttention();
  if (event.type === 'mori.team_approval_request' || event.type === 'mori.team_approval_end') {
    const seq = (teamApprovalSeq.get(saved.sessionFile) ?? 0) + 1;
    teamApprovalSeq.set(saved.sessionFile, seq);
    if (event.type === 'mori.team_approval_end') void refreshTeamApproval(saved.sessionFile, seq);
  }
}

/** 还没点开的会话收到的后台批准卡事件的序号（按会话文件），refreshTeamApproval 据此丢掉过时的结果 */
const teamApprovalSeq = new Map<string, number>();

/**
 * @brief 还没点开的会话的一张后台批准卡结束了：几个实例可能各有卡挂着（平行 Agent 规格 §11.3），侧栏的"等你批准"
 *        按后台进程的会话列表重新取这一行的 teamApproval；取的期间这个会话又有后台批准卡的事件时不用这次的结果。
 * @param sessionFile 会话文件
 * @param seq 取之前的事件序号
 */
async function refreshTeamApproval(sessionFile: string, seq: number): Promise<void> {
  let listed: SavedSession[];
  try {
    listed = await request<SavedSession[]>({ type: 'session.list' });
  } catch (error) {
    console.error(`[renderer] cannot refresh the approval state of ${sessionFile}: ${describe('session.list', error)}`);
    return;
  }
  const pending = listed.find((item) => sameFile(item.sessionFile, sessionFile))?.live?.teamApproval;
  if (pending === undefined || teamApprovalSeq.get(sessionFile) !== seq) return;
  useApp.setState((state) => ({ saved: { ...state.saved, sessions: state.saved.sessions.map((item) => (
    sameFile(item.sessionFile, sessionFile) && item.live ? { ...item, live: { ...item.live, teamApproval: pending } }
      : item)) } }));
}

/** @brief 协作状态与 TaskBoard 视图的事件记到会话上（平行 Agent 规格 §13.10）。 */
function withTeamEvent(tab: Tab, event: ForwardedEvent): Tab {
  if (event.type === 'mori.team_state') {
    const { type: _type, ...team } = event;
    return { ...tab, team };
  }
  if (event.type !== 'mori.board') return tab;
  return { ...tab, board: { requests: event.requests, teamEdited: event.teamEdited } };
}

/**
 * @brief 归并一个后台进程事件；本轮或压缩结束后刷新上下文用量。改名事件更新会话名；
 *        不可见的会话本轮结束时标"Unread"。界面重新加载后还没点开的会话只更新侧栏状态。
 *        全局事件（sessionId 为 null：mori.profiles、mori.key_status）不属于任何会话，由设置页自己订阅处理。
 */
export function handleEvent(envelope: EventEnvelope | GlobalEventEnvelope): void {
  if (envelope.sessionId === null) return;
  const tab = tabBySession(envelope.sessionId);
  if (!tab) {
    handleUntabbed(envelope);
    return;
  }
  const { event } = envelope;
  restoreWithdrawn(tab, event);
  // 运行开始时记下协作模式：这次运行里的工具调用按它定标题（平行 Agent 规格 §5.1、§13.8）
  const started = (t: Transcript) => (event.type === 'agent_start' ? { ...t, runTeamMode: tab.team.mode } : t);
  updateTranscript(tab.key, (t) => applyEvent(started(t), event, Date.now()));
  if (event.type === 'session_info_changed') {
    updateTab(tab.key, (current) => ({ ...current, name: event.name ?? null }));
  }
  if (event.type === 'mori.model_state' || event.type === 'thinking_level_changed') {
    updateTab(tab.key, (current) => withModelEvent(current, event));
  }
  if (event.type === 'mori.team_state' || event.type === 'mori.board') {
    updateTab(tab.key, (current) => withTeamEvent(current, event));
  }
  if (event.type === 'agent_settled' && !isShown(tab.key)) {
    updateTab(tab.key, (current) => ({ ...current, unseen: true }));
  }
  // 侧栏按最后一条你的消息或助手回复的时间排序，与 pi 会话列表的 modified 同一规则。
  if (event.type === 'message_end' && (event.message.role === 'user' || event.message.role === 'assistant')) {
    updateTab(tab.key, (current) => ({ ...current, activity: Date.now() }));
  }
  if (['turn_end', 'compaction_end', 'agent_settled'].includes(event.type)) void refreshUsage(tab.key);
  if (wantsAttention(event)) void requestAttention();
}

/**
 * @brief 后台进程意外退出：没结束的工具标"Interrupted"，运行状态清空；准备中的消息和暂存的消息放回输入框；
 *        正在生成的会话在侧栏标"Error"。
 *        pi 会话随后台进程一起没了，会话标识清掉，之后的命令不会用到它（重新载入后换成新的）。
 */
export function handleKernelExit(): void {
  // 准备中的消息和暂存的消息 pi 还没收到，会话文件里没有：按发送顺序放回输入框（同 §11.4 的撤回）。
  // 先放回再清状态，读的是清掉之前的对话流。
  for (const tab of useApp.getState().tabs) {
    const pending = pendingPrompt(tab.transcript);
    if (pending || tab.transcript.pendingQueue.length > 0) {
      restoreTexts(tab, pending?.text ?? null, pending?.refs ?? [], tab.transcript.pendingQueue);
    }
  }
  useApp.setState((state) => ({
    kernel: 'exited',
    // 还没点开的会话：后台进程里的状态随它一起没了，退出时正在生成的标"Error"（打开着的看它自己的对话流）。
    saved: { ...state.saved, sessions: state.saved.sessions.map((item) => ({ ...item, live: null })) },
    rowMarks: { ...state.rowMarks, ...Object.fromEntries(state.saved.sessions.filter((item) => item.live?.running
      && !state.tabs.some((tab) => sameFile(tab.sessionFile, item.sessionFile)))
      .map((item) => [item.sessionFile, 'error' as const])) },
    // 协作：后台的 Agent、批准卡和待判断的消息随后台进程一起没了；开关保留最后知道的模式（team-switch.md）。
    tabs: state.tabs.map((tab) => ({ ...tab, sessionId: null,
      interrupted: tab.interrupted || tab.transcript.running || tab.transcript.sending,
      team: { ...tab.team, busy: false, background: false },
      transcript: { ...withoutPending(finishOpenTools(tab.transcript, 'interrupted')), running: false, sending: false,
        stage: null, modelStage: null, pendingQueue: [], steering: [], followUp: [], stopRequested: false,
        teamApprovals: [], deciding: null, wakes: [], decidingHold: false } })),
  }));
}

/** @brief 去掉准备中先显示的那条消息（文字已放回输入框）。 */
function withoutPending(transcript: Transcript): Transcript {
  return { ...transcript, items: transcript.items.filter((item) => !(item.kind === 'user' && item.pending)) };
}

/** @brief "Restart"：重启后台进程；新通道连上后由 handleKernelReady 重新打开会话。 */
export async function reload(): Promise<void> {
  recordAction('Restart background process');
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

/**
 * @brief 打开设置页（侧栏）。从工具页（Customize）过来时不用问（有未保存改动的编辑器只在设置页里）。
 *        卡片与范围菜单里打开 Settings → Models 的按钮用 settings.ts 的 openModelsSettings。
 */
export function openSettings(): void {
  recordAction('Open settings');
  useApp.setState({ view: 'settings' });
}

/** @brief 打开工具页（Customize，docs/v0/screens/tools.md）；从有未保存改动的设置页过来时先问。 */
export function openTools(): void {
  guardLeave(() => {
    recordAction('Open Customize');
    useApp.setState({ view: 'tools' });
  });
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
