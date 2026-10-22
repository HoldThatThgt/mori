// 会话表：在一个后台进程里并存多个 pi 会话（M0 已验证可行），不做调度、优先级或并发限制。
// 每个会话带一个最小批准扩展（approval.ts）和扩展的界面上下文（extensionUi.ts），批准状态和挂起的询问只在这里的内存里。
// 照 Claude 桌面版，本次运行里打开过的会话一直保持打开，直到界面要求关闭（归档、删除前）或退出；界面重新加载也不停，
// 重新加载后的界面经 session.list 的 live 和 session.open 交出的这一刻的样子接上它们（docs/v0/screens/sessions.md）。
// M6：换思考强度只作用于一个会话（pi 不 persist）；"/"补全取会话的提示词模板和技能命令（docs/v0/screens/slash.md）。
// v1：模型层（docs/specs/model-providers.md §5、§6、§11）：每个会话一个 ModelSession（modelSession.ts）——虚拟模型、
// 选择范围与静态校验、流函数包装；这里接上它：会话的新建与打开、session.prompt 的准备中（§11.4）、段的结束、停止。

import { existsSync } from 'node:fs';
import type {
  AgentSession, AgentSessionEvent, ExtensionFactory, PromptOptions as PiPromptOptions, SessionEntry, SessionManager,
} from '@earendil-works/pi-coding-agent';
import {
  BLOCKED_PROMPT_MESSAGE, STOPPED_BEFORE_SENDING, type ModelEvent, type ModelPick, type PickOptions,
} from '../shared/models';
import type {
  ApprovalDecision, ApprovalMode, ApprovalState, ClearedQueue, EventEnvelope, ExtensionNotice, LiveSnapshot, LiveStatus,
  ModelState, OpenedSession, ProjectTrust, QuoteRef, SavedSession, SessionContent, SessionInfo, SessionState,
  SlashCommand, ThinkingLevel, TrustAnswer,
} from '../shared/protocol';
import { REF_ENTRY_TYPE } from '../shared/protocol';
import { ApprovalGate } from './approval';
import { PendingRefs, supplementEntry } from './entries';
import { ExtensionUi } from './extensionUi';
import { slimEvent } from './events';
import { createSharedTransport, loadMcpShare } from './mcpShare';
import { getModelLayer } from './modelLayer';
import { ModelSession, type PrepareResult } from './modelSession';
import { loadPi } from './pi';
import { decideTrust, type TrustDecision } from './trust';

type Emit = (envelope: EventEnvelope) => void;
/** @brief 等着 pi 记下的带引用的消息（PendingRefs.add 的返回值）。 */
type Pending = ReturnType<PendingRefs['add']>;

/** @brief 准备中又发的一条消息（§11.4）：pi 开始运行后作为 followUp 交给 pi。 */
interface HeldPrompt {
  /** 全文 */
  text: string;
  /** 引用芯片 */
  refs: QuoteRef[] | undefined;
  /** 等着写成 mori.ref 的引用；没有引用时为 null */
  pending: Pending | null;
}

/** @brief 你发消息后、pi 开始运行前（§11.4）：选模型、等待、重建（preparing），已调 pi 的 prompt、等它开始（starting）。 */
interface Preparing {
  /** 这条消息 */
  text: string;
  /** 它的引用芯片 */
  refs: QuoteRef[] | undefined;
  /** 等着写成 mori.ref 的引用；没有引用时为 null */
  pending: Pending | null;
  /** 准备中又发的消息，按发送顺序 */
  held: HeldPrompt[];
  /** 你按了停止（只在 preparing 阶段用） */
  controller: AbortController;
  /** 阶段 */
  phase: 'preparing' | 'starting';
}

/** @brief 一个打开的会话、它的批准状态和打开时就确定的信息。 */
interface Entry {
  /** pi 会话 */
  session: AgentSession;
  /** 这个会话的批准扩展和批准设置 */
  gate: ApprovalGate;
  /** 扩展的通知与询问 */
  ui: ExtensionUi;
  /** 工作目录 */
  cwd: string;
  /** 正在生成：发出提示到 agent_settled（pi 的 isStreaming 要等提示真正开始后才为真） */
  running: boolean;
  /** 打开的时刻（ms）：还没保存的会话在列表里按它排序 */
  openedAt: number;
  /** 正在执行的工具开始执行的时刻（ms），按 toolCallId */
  toolStarts: Map<string, number>;
  /** 扩展在打开过程中发的通知 */
  notices: ExtensionNotice[];
  /** 模型层的会话接线 */
  model: ModelSession;
  /** 你发消息后、pi 开始运行前（§11.4）；不在准备中时为 null */
  preparing: Preparing | null;
  /** 文件夹的信任状态和没能记住时的原文 */
  trust: TrustDecision;
  /** 加载失败的扩展（批准扩展以外） */
  extensionErrors: string[];
  /** 发出了、pi 还没记下的带引用的消息 */
  refs: PendingRefs;
  /**
   * 本轮开始时会话的叶子条目 id（会话引用只取到这里为止，即已完成的轮次）；会话还没有条目时为 null，
   * 不在生成时为 undefined
   */
  runStart: string | null | undefined;
}

const sessions = new Map<string, Entry>();
/** 正在从会话文件打开的会话（按会话文件）：同一个文件再打开时等它打开完，不另起一个写入者 */
const opening = new Map<string, Promise<OpenedSession>>();

/** 批准扩展的名字；pi 用 `<inline:名字>` 标出它的加载错误 */
const APPROVAL_EXTENSION = 'mori-approval';
const APPROVAL_EXTENSION_PATH = `<inline:${APPROVAL_EXTENSION}>`;
/** 模型层扩展（context 钩子、排队消息、压缩前去掉被隐藏的过程）的名字 */
const MODEL_EXTENSION = 'mori-models';
const MODEL_EXTENSION_PATH = `<inline:${MODEL_EXTENSION}>`;
/** pi 的会话列表里没有你的消息时 firstMessage 的写法（session-manager.js buildSessionInfo） */
const NO_MESSAGES = '(no messages)';

/**
 * @brief 转发一个 pi 事件。tool_execution_start 之前紧挨着由批准扩展发 mori.tool_gate：pi 先发
 *        tool_execution_start、再调用批准处理器，界面要在同一时刻就知道这张卡是"Waiting for your approval"还是"Running…"；
 *        处理器后来判断不同时由批准扩展发更正。
 */
function forward(entry: Entry, sessionId: string, event: AgentSessionEvent, emit: Emit): void {
  // 重建对话时的压缩（§6.3 第 1 步）不转给界面：结果只经 mori.model_rebuild 或换模型提示显示。
  if (entry.model.isSuppressed(event.type)) return;
  if (event.type === 'agent_start') {
    entry.running = true;
    // 扩展发起的一轮没有经过 prompt()：这时才记下本轮开始时的叶子（你的消息还没写入）。
    if (entry.runStart === undefined) entry.runStart = entry.session.sessionManager.getLeafId();
    entry.model.onAgentStart();
    releaseHeld(entry, sessionId, emit);
  }
  if (event.type === 'agent_settled') {
    entry.running = false;
    entry.runStart = undefined;
  }
  if (event.type === 'tool_execution_start') {
    entry.toolStarts.set(event.toolCallId, Date.now());
    entry.gate.announce(event.toolCallId, event.toolName);
  }
  emit({ kind: 'event', sessionId, event: slimEvent(event) });
  if (event.type === 'message_end') supplementEntry(entry.session, sessionId, entry.refs, event.message, emit);
  if (event.type === 'tool_execution_end') {
    entry.toolStarts.delete(event.toolCallId);
    entry.gate.noteToolEnd(event.toolCallId);
  }
  // 一段结束（§5.2）：pi 每次运行结束发一次 agent_settled（K13）。
  if (event.type === 'agent_settled') entry.model.endReply();
}

/** @brief 打开中的会话的信息。 */
function describeEntry(entry: Entry): SessionInfo {
  const { session } = entry;
  return {
    sessionId: session.sessionId,
    cwd: entry.cwd,
    sessionFile: session.sessionFile ?? null,
    name: session.sessionName ?? null,
    projectTrust: entry.trust.projectTrust,
    trustRemembered: entry.trust.remembered,
    trustSaveError: entry.trust.saveError,
    extensionErrors: entry.extensionErrors,
    extensionNotices: entry.notices,
    tools: session.getActiveToolNames(),
    ...entry.model.state(),
    contextUsage: session.getContextUsage() ?? null,
    approval: entry.gate.state(),
  };
}

/**
 * @brief 资源加载器与 createAgentSession 默认建的相同（同一个 settingsManager），只多两个 inline extension：
 *        批准扩展和模型层扩展（modelSession.ts）。
 */
async function loadResources(cwd: string, gate: ApprovalGate, trust: TrustAnswer | undefined,
  models: ExtensionFactory) {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  // 先按"Don’t trust"创建；pi 在加载项目资源之前调用 resolveProjectTrust，由它决定（trust.ts）。
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // MCP 照 pi 命令行的注册方式作为内置扩展加入（方案第 6 节）：`pi config` 和设置里的 -builtin:mcp 对它有效；
  // bindExtensions 发 session_start 时它在后台连接服务。codemode 不进 v0，所以服务要用直接调用方式。
  // 传输交给 Mori 的共享连接（mcpShare.ts，docs/v0/m6-mcp-shared.md）：每个服务一个进程，所有会话共用。
  await loadMcpShare();
  const mcp = { name: 'mcp', factory: pi.createMcpExtension({ createTransport: createSharedTransport }),
    replaceable: true, builtin: true };
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: [{ name: APPROVAL_EXTENSION, factory: gate.extension() },
      { name: MODEL_EXTENSION, factory: models }, mcp] });
  let decision: TrustDecision = { trusted: false, projectTrust: 'unasked', remembered: false, saveError: null };
  await resourceLoader.reload({
    resolveProjectTrust: async () => {
      decision = await decideTrust(cwd, trust);
      return decision.trusted;
    },
  });
  return { settingsManager, resourceLoader, decision };
}

/** @brief 打开一个会话要用的参数。 */
interface StartArgs {
  /** 工作目录 */
  cwd: string;
  /** 会话的 SessionManager */
  sessionManager: SessionManager;
  /** 发事件 */
  emit: Emit;
  /** 你对信任询问的回答；没问时为 undefined */
  trust: TrustAnswer | undefined;
  /** 打开已保存的会话 */
  restored: boolean;
}

/**
 * @brief 检查扩展的加载错误：批准扩展没加载上时，pi 没有 tool_call 处理器就不经询问直接执行；模型层扩展没加载上时，
 *        换模型后被隐藏的过程会发给新模型。这两种情况都不打开会话。
 * @return 加载失败的扩展（路径和原文）
 */
function checkExtensions(session: AgentSession, errors: { path: string; error: string }[]): string[] {
  for (const error of errors) console.error(`[kernel] extension failed to load: ${error.path}: ${error.error}`);
  const required = errors.find((error) => error.path === APPROVAL_EXTENSION_PATH
    || error.path === MODEL_EXTENSION_PATH);
  if (required) {
    session.dispose();
    const which = required.path === APPROVAL_EXTENSION_PATH ? 'approval' : 'model layer';
    throw new Error(`The ${which} extension failed to load: ${required.error}`);
  }
  return errors.map((error) => `${error.path}: ${error.error}`);
}

/**
 * @brief 建立会话的模型层接线：读选择范围（新会话记下默认范围，v0 的旧会话按 §5.1 记下）并做静态校验。
 * @param args 打开会话的参数
 */
async function createModelSession(args: StartArgs): Promise<ModelSession> {
  const layer = await getModelLayer();
  const sessionId = args.sessionManager.getSessionId();
  const model = await ModelSession.create({ layer, sessionId, cwd: args.cwd,
    emit: (event: ModelEvent) => args.emit({ kind: 'event', sessionId, event }) });
  try {
    await model.loadPick(args.sessionManager, !args.restored);
  } catch (error) {
    await model.dispose();
    throw error;
  }
  return model;
}

/**
 * @brief 用给定的 SessionManager 在 cwd 创建 pi 会话，带上批准扩展与模型层扩展，绑定扩展并开始转发事件。
 *        会话的模型是它自己的虚拟模型（§11.1）；失败时注销虚拟模型。
 * @param restored 打开已保存的会话：绑定扩展之前补上当前注册的扩展工具（refreshTools），扩展的 session_start 仍可再改
 */
async function startSession(cwd: string, sessionManager: SessionManager, emit: Emit,
  trust: TrustAnswer | undefined, restored: boolean): Promise<SessionInfo> {
  const args: StartArgs = { cwd, sessionManager, emit, trust, restored };
  const model = await createModelSession(args);
  try {
    return await createEntry(args, model);
  } catch (error) {
    await model.dispose();
    throw error;
  }
}

/** @brief 建 pi 会话并登记：虚拟模型、思考强度（§11.1）、流函数包装（§11.2）、扩展、事件转发。 */
async function createEntry(args: StartArgs, model: ModelSession): Promise<SessionInfo> {
  const pi = await loadPi();
  const { cwd, emit } = args;
  const gate = new ApprovalGate(emit);
  const ui = new ExtensionUi(emit);
  const { settingsManager, resourceLoader, decision } = await loadResources(cwd, gate, args.trust, model.extension());
  const virtual = await model.register();
  // 新会话按第一个候选取思考强度；打开已有会话时不传，pi 从会话记录恢复（§11.1）。
  const thinkingLevel = args.restored ? undefined : model.newSessionThinking(settingsManager);
  const result = await pi.createAgentSession({ cwd, modelRuntime: model.layer.getRuntime(), settingsManager,
    sessionManager: args.sessionManager, resourceLoader, model: virtual, thinkingLevel });
  const { session } = result;
  // 一条回复里的多个调用按顺序执行：允许一张卡就执行一张（临时默认值，见 docs/v0/defaults.md）。
  session.agent.toolExecution = 'sequential';
  const extensionErrors = checkExtensions(session, result.extensionsResult.errors);
  model.attach(session);
  if (args.restored) refreshTools(session);
  const sessionId = session.sessionId;
  ui.attach(sessionId);
  await session.bindExtensions({
    uiContext: ui.context(),
    onError: (error) => console.error(`[kernel] extension error ${error.extensionPath}: ${error.error}`),
  });
  const entry: Entry = { session, gate, ui, cwd, running: false, openedAt: Date.now(), toolStarts: new Map(),
    notices: ui.ready(), model, preparing: null, trust: decision, extensionErrors, refs: new PendingRefs(),
    runStart: undefined };
  gate.attach(sessionId);
  sessions.set(sessionId, entry);
  session.subscribe((event) => forward(entry, sessionId, event, emit));
  return describeEntry(entry);
}

/** @brief 在指定目录新建 pi 会话。 */
export async function createSession(cwd: string, emit: Emit, trust?: TrustAnswer): Promise<SessionInfo> {
  const pi = await loadPi();
  if (!existsSync(cwd)) throw new Error(`Project folder not found: ${cwd}`);
  return startSession(cwd, pi.SessionManager.create(cwd), emit, trust, false);
}

/** @brief 已打开的、会话文件是 sessionFile 的会话。 */
function entryByFile(sessionFile: string): Entry | undefined {
  return [...sessions.values()].find((entry) => entry.session.sessionFile === sessionFile);
}

/** @brief 还开着的会话的状态（侧栏）。 */
function liveStatus(entry: Entry): LiveStatus {
  return { running: entry.running || entry.session.isStreaming, approval: entry.gate.requests().length > 0,
    question: entry.ui.requests().length > 0 };
}

/** @brief 还开着的会话这一刻的样子：正在生成的回复、正在执行的工具、挂起的批准请求和扩展询问、排队区。 */
export function snapshot(entry: Entry): LiveSnapshot {
  const { session } = entry;
  const runningTools = [...session.state.pendingToolCalls].map((toolCallId) => ({ toolCallId,
    startedAt: entry.toolStarts.get(toolCallId) ?? Date.now() }));
  return { running: liveStatus(entry).running, preparing: entry.preparing !== null && !session.isStreaming,
    streaming: session.state.streamingMessage ?? null, runningTools,
    approvals: entry.gate.requests(), questions: entry.ui.requests(), steering: [...session.getSteeringMessages()],
    // 准备中暂存的消息也在排队区（§11.4）。
    followUp: [...session.getFollowUpMessages(), ...(entry.preparing?.held.map((item) => item.text) ?? [])] };
}

/**
 * @brief 照 Claude Code 恢复会话的做法用当前的工具：pi 按会话记录恢复了当时启用的工具，这里把现在注册了的扩展工具
 *        （不是内置工具、会直接给模型用的、没有标成默认不启用的）加进启用的工具，例如信任之后重新打开不信任时保存的会话。
 *        在绑定扩展之前做，扩展在 session_start 里自己改的工具集仍然算数。
 */
function refreshTools(session: AgentSession): void {
  const active = session.getActiveToolNames();
  const missing = session.getAllTools().filter((tool) => !tool.sourceInfo.path.startsWith('builtin:')
    && (tool.exposure === 'direct' || tool.exposure === 'model-only') && !active.includes(tool.name)
    && session.getToolDefinition(tool.name)?.defaultActive !== false);
  if (missing.length > 0) session.setActiveToolsByName([...active, ...missing.map((tool) => tool.name)]);
}

/**
 * @brief 从会话文件打开会话（侧栏点开、后台进程重启后），返回 pi 记录的当前分支，界面据此画对话流。
 *        已经打开的直接返回它和它这一刻的样子（界面重新加载后接上）；正在打开的等它打开完再这样返回。同一个会话文件
 *        不会有两个写入者。接上这一路没有等待，之后的事件都排在这个结果后面送到界面；打开过程中扩展的通知只随真正
 *        打开它的那次结果交出，接上时不再交（界面重新加载前已经显示过）。
 */
export async function openSession(sessionFile: string, emit: Emit, trust?: TrustAnswer): Promise<OpenedSession> {
  while (opening.has(sessionFile)) await opening.get(sessionFile)?.catch(() => undefined);
  const live = entryByFile(sessionFile);
  if (live) {
    return { ...describeEntry(live), extensionNotices: [], entries: live.session.sessionManager.getBranch(),
      live: snapshot(live) };
  }
  const started = openFromFile(sessionFile, emit, trust);
  opening.set(sessionFile, started);
  try {
    return await started;
  } finally {
    opening.delete(sessionFile);
  }
}

/** @brief 从会话文件新打开一个会话（后台进程里还没有它）。 */
async function openFromFile(sessionFile: string, emit: Emit, trust?: TrustAnswer): Promise<OpenedSession> {
  if (!existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile}`);
  const pi = await loadPi();
  const manager = pi.SessionManager.open(sessionFile);
  const cwd = manager.getCwd();
  if (!existsSync(cwd)) throw new Error(`Project folder not found: ${cwd}`);
  const info = await startSession(cwd, manager, emit, trust, true);
  return { ...info, entries: manager.getBranch(), live: null };
}

/**
 * @brief 生成中的会话已完成的部分：本轮开始时的叶子（leafId，会话还没有条目时为 null）之后写进来的你的消息里，
 *        最后一条开始的是还在生成的那一轮；它之前的都已完成（插话、排队送达的消息开始新的一轮，前一轮就完了）。
 *        本轮的你的消息还没写进来时，到 leafId 为止。
 */
function completedPart(branch: SessionEntry[], leafId: string | null): SessionEntry[] {
  const start = leafId === null ? -1 : branch.findIndex((item) => item.id === leafId);
  // 本轮开始时的叶子不在当前分支上了（扩展在运行中换了分支）：分不清哪些已完成，一条也不交。
  if (leafId !== null && start < 0) return [];
  const isUser = (item: SessionEntry) => item.type === 'message' && item.message.role === 'user';
  const current = branch.findLastIndex((item, index) => index > start && isUser(item));
  return branch.slice(0, current < 0 ? start + 1 : current);
}

/**
 * @brief 会话引用用得到的条目：你的消息、助手回复和 mori.ref 条目。工具结果（文件内容、命令输出、图片）等引用里不取的
 *        不交给界面，免得每次引用、每次打开预览都把整段会话搬过去。
 */
function quotable(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter((item) => (item.type === 'message'
    && (item.message.role === 'user' || item.message.role === 'assistant'))
    || (item.type === 'custom' && item.customType === REF_ENTRY_TYPE));
}

/**
 * @brief 读出一个会话已完成的部分（会话引用，docs/v0/screens/session-refs.md）。后台进程里开着的会话读它自己的分支，
 *        在生成时只交出已完成的轮次；没开着的用 SessionManager.open 读（不创建会话、不加载扩展、不问信任）。
 */
export async function readSession(sessionFile: string): Promise<SessionContent> {
  const live = entryByFile(sessionFile);
  if (live) {
    const branch = live.session.sessionManager.getBranch();
    const unfinished = live.runStart !== undefined;
    return { sessionFile, cwd: live.cwd, name: live.session.sessionName ?? null, unfinished,
      entries: quotable(unfinished ? completedPart(branch, live.runStart ?? null) : branch) };
  }
  if (!existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile}`);
  const pi = await loadPi();
  const manager = pi.SessionManager.open(sessionFile);
  return { sessionFile, cwd: manager.getCwd(), name: manager.getSessionName() ?? null,
    entries: quotable(manager.getBranch()), unfinished: false };
}

/** @brief 还开着、但还没保存（没有会话文件）的会话：界面重新加载后也能在侧栏看到、打开、删除。 */
function unsavedLive(listed: SavedSession[]): SavedSession[] {
  return [...sessions.values()].filter((entry) => entry.session.sessionFile && !existsSync(entry.session.sessionFile)
    && !listed.some((item) => item.sessionFile === entry.session.sessionFile)).map((entry) => ({
    sessionFile: entry.session.sessionFile!, sessionId: entry.session.sessionId, cwd: entry.cwd,
    name: entry.session.sessionName ?? null, firstMessage: null, modified: entry.openedAt, live: liveStatus(entry) }));
}

/** @brief pi 的会话列表（全部项目），按最后活动时间从新到旧；后面接着还开着、还没保存的会话。 */
export async function listSessions(): Promise<SavedSession[]> {
  const pi = await loadPi();
  const all = await pi.SessionManager.listAll();
  const saved: SavedSession[] = [];
  for (const info of all) {
    if (!info.cwd) {
      console.error(`[kernel] session without a working folder skipped: ${info.path}`);
      continue;
    }
    const live = entryByFile(info.path);
    saved.push({ sessionFile: info.path, sessionId: info.id, cwd: info.cwd, name: info.name ?? null,
      firstMessage: info.firstMessage === NO_MESSAGES ? null : info.firstMessage, modified: info.modified.getTime(),
      live: live ? liveStatus(live) : null });
  }
  return [...saved, ...unsavedLive(saved)];
}

/**
 * @brief 改名。打开中的会话经它自己的 setSessionName（pi 随后发 session_info_changed）；没打开的写进它的会话文件
 *        （与 pi 会话选择器的做法相同）。返回 pi 记下的名字。
 */
export async function renameSession(sessionId: string | undefined, sessionFile: string | undefined,
  name: string): Promise<{ name: string | null }> {
  const entry = (sessionId ? sessions.get(sessionId) : undefined)
    ?? (sessionFile ? entryByFile(sessionFile) : undefined);
  if (entry) {
    entry.session.setSessionName(name);
    return { name: entry.session.sessionName ?? null };
  }
  if (sessionFile && opening.has(sessionFile)) throw new Error('The session is still opening');
  if (!sessionFile || !existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile ?? sessionId}`);
  const pi = await loadPi();
  const manager = pi.SessionManager.open(sessionFile);
  manager.appendSessionInfo(name);
  return { name: manager.getSessionName() ?? null };
}

/** @brief 取出已打开的会话。 */
function requireEntry(sessionId: string): Entry {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`Unknown session ${sessionId}`);
  return entry;
}

/** @brief 打开着的会话的只读信息（工具页、AGENTS.md 用）：pi 会话、工作目录、文件夹是否信任。 */
export interface SessionContext {
  /** pi 会话：只读它的工具、资源加载器，不经这里改会话 */
  session: AgentSession;
  /** 工作目录 */
  cwd: string;
  /** 打开时是否加载了项目自带的资源（pi resolveProjectTrust 的结果） */
  trusted: boolean;
  /** 文件夹的信任状态（与会话信息的 projectTrust 相同） */
  projectTrust: ProjectTrust;
}

/** @brief 取出打开着的会话的只读信息；没有这个会话时报错。 */
export function sessionContext(sessionId: string): SessionContext {
  const entry = requireEntry(sessionId);
  return { session: entry.session, cwd: entry.cwd, trusted: entry.trust.trusted,
    projectTrust: entry.trust.projectTrust };
}

/**
 * @brief 释放一个会话，顺序与 pi 自己替换会话时相同（agent-session-runtime.js teardownCurrent）：先停止，
 *        再通知扩展 session_shutdown（扩展在这里关掉自己的连接和进程），最后 dispose。挂起的批准先按拒绝处理。
 */
async function release(entry: Entry): Promise<void> {
  const { session, gate, ui } = entry;
  gate.close();
  ui.close();
  try {
    await session.abort();
    const runner = session.extensionRunner;
    if (runner.hasHandlers('session_shutdown')) await runner.emit({ type: 'session_shutdown', reason: 'quit' });
  } catch (error) {
    console.error(`[kernel] releasing ${session.sessionId} failed: ${(error as Error).message}`);
  }
  session.dispose();
}

/** @brief 正在生成或准备中时拒绝（关闭、换范围、换思考强度），不替你停止。 */
function requireIdle(entry: Entry): void {
  if (entry.running || entry.preparing || entry.session.isStreaming) {
    throw new Error('This session is still running. Stop it first.');
  }
}

/** @brief 关闭并释放一个会话（归档、删除前），注销它的虚拟模型；正在生成时拒绝，不替你停止。 */
export async function closeSession(sessionId: string): Promise<{ closed: true }> {
  const entry = requireEntry(sessionId);
  requireIdle(entry);
  sessions.delete(sessionId);
  await release(entry);
  await entry.model.dispose();
  return { closed: true };
}

/** @brief 发出提示时的选项。 */
interface PromptOptions {
  /** 生成中时的送达方式（steer 插话 / followUp 排队），交给 pi 的 prompt；空闲时 pi 直接发送 */
  behavior?: 'steer' | 'followUp';
  /** 输入框里的引用芯片：pi 记下这条消息后写成 mori.ref 条目（entries.ts） */
  refs?: QuoteRef[];
}

/** @brief mori.prompt_error 的字段。 */
interface PromptErrorFields {
  /** 错误原文 */
  message: string;
  /** 撤回的消息 */
  text: string;
  /** 它的引用芯片 */
  refs: QuoteRef[] | null;
  /** 这时会话是否还在运行 */
  running: boolean;
  /** 一起撤回的、准备中又发的消息 */
  queued: string[];
}

/** @brief 准备中的结果，加上停止与准备时出错。 */
type PrepareOutcome = PrepareResult | { kind: 'aborted' } | { kind: 'failed'; message: string };

/** @brief 错误的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief 发 mori.prompt_error。 */
function promptError(sessionId: string, emit: Emit, fields: PromptErrorFields): void {
  emit({ kind: 'event', sessionId, event: { type: 'mori.prompt_error', ...fields } });
}

/** @brief pi 的 prompt() 结束后按 pi 的状态重设运行状态；会话已不在运行时一段结束（§5.2）。 */
function settleRun(entry: Entry): void {
  entry.running = entry.session.isStreaming || entry.preparing !== null;
  if (entry.running) return;
  entry.runStart = undefined;
  entry.model.endReply();
}

/**
 * @brief 发出提示；不等本轮结束，结果和失败都通过事件回到界面。被拒绝启动的会话拒绝（§4.6）；准备中暂存，
 *        pi 开始运行后作为 followUp 交给 pi（§11.4）；生成中按 behavior 交给 pi（插话或排队）；空闲时开始一段：
 *        先准备（选模型、等待、重建），再调 pi。
 */
export function prompt(sessionId: string, text: string, options: PromptOptions, emit: Emit) {
  const entry = requireEntry(sessionId);
  if (entry.model.isBlocked()) {
    promptError(sessionId, emit, { message: BLOCKED_PROMPT_MESSAGE, text, refs: options.refs ?? null,
      running: entry.running, queued: [] });
    return { accepted: true };
  }
  const pending = options.refs?.length ? entry.refs.add(text, options.refs) : null;
  const item: HeldPrompt = { text, refs: options.refs, pending };
  if (entry.preparing) entry.preparing.held.push(item);
  else if (entry.running || entry.session.isStreaming) sendToPi(entry, sessionId, item, options.behavior, emit);
  else void startReply(entry, sessionId, item, emit);
  return { accepted: true };
}

/**
 * @brief 生成中交给 pi 的选项：插话或排队；排队时把 pi 真正排进排队区的文字记给模型层（§11.4、K13）。
 * @param entry 会话
 * @param behavior 插话或排队；空闲时省略
 * @return pi 的 prompt 选项；空闲时为 undefined
 */
export function streamingOptions(entry: Entry, behavior: PromptOptions['behavior']): PiPromptOptions | undefined {
  if (!behavior) return undefined;
  return { streamingBehavior: behavior, preflightResult: (disposition) => {
    // pi 排队的是输入处理器、技能命令与提示词模板展开后的文字；记下它，message_start 才能比上。
    // 被扩展命令或输入处理器接手（handled）的不记，不会留下比不上的文字。
    if (behavior !== 'followUp' || disposition !== 'queued') return;
    const queued = entry.session.getFollowUpMessages().at(-1);
    if (queued !== undefined) entry.model.noteFollowUp(queued);
  } };
}

/**
 * @brief 生成中把消息交给 pi（插话或排队）；排队的文字记给模型层，pi 送进上下文时开始新的一段（§11.4、K13）。
 *        pi 处理了提示却没有开始运行时（扩展命令、输入处理器接手）不会发 agent_settled：结束后按 pi 的状态重设。
 */
function sendToPi(entry: Entry, sessionId: string, item: HeldPrompt, behavior: PromptOptions['behavior'],
  emit: Emit): void {
  entry.model.disableRetry();
  entry.session.prompt(item.text, streamingOptions(entry, behavior)).then(() => {
    settleRun(entry);
    emit({ kind: 'event', sessionId, event: { type: 'mori.prompt_done', running: entry.running } });
  }, (error: unknown) => {
    const message = errorText(error);
    console.error(`[kernel] prompt failed for ${sessionId}: ${message}`);
    if (item.pending) entry.refs.drop(item.pending);
    settleRun(entry);
    promptError(sessionId, emit, { message, text: item.text, refs: item.refs ?? null, running: entry.running,
      queued: [] });
  });
}

/**
 * @brief 空闲时发消息（§11.4）：进入准备中（会话按“发送中”显示），模型层选模型、等待、重建；准备好后调 pi 的 prompt。
 *        停止、等不到模型或准备时出错：撤回这条消息和准备中又发的消息。
 */
async function startReply(entry: Entry, sessionId: string, item: HeldPrompt, emit: Emit): Promise<void> {
  const preparing: Preparing = { ...item, held: [], controller: new AbortController(), phase: 'preparing' };
  const { signal } = preparing.controller;
  entry.preparing = preparing;
  entry.running = true;
  // 空闲时发出的提示开始新的一轮：记下这时的叶子，会话引用只取到这里（已完成的轮次）。
  entry.runStart = entry.session.sessionManager.getLeafId();
  let outcome: PrepareOutcome;
  try {
    outcome = await entry.model.prepare(item.text, signal);
  } catch (error) {
    if (!signal.aborted) console.error(`[kernel] preparing the reply failed for ${sessionId}: ${errorText(error)}`);
    outcome = signal.aborted ? { kind: 'aborted' } : { kind: 'failed', message: errorText(error) };
  }
  if (outcome.kind === 'ok' && signal.aborted) outcome = { kind: 'aborted' };
  if (outcome.kind !== 'ok') {
    giveBack(entry, sessionId, outcome, emit);
    return;
  }
  preparing.phase = 'starting';
  entry.model.disableRetry();
  runPrompt(entry, sessionId, preparing, emit);
}

/**
 * @brief 准备中没能发出（§11.4）：撤回这条消息和暂存的消息。停止或出错时发 mori.prompt_error；
 *        等不到模型时只发 mori.model_unavailable（§5.8，firstRequest 为真）。
 */
function giveBack(entry: Entry, sessionId: string, outcome: Exclude<PrepareOutcome, { kind: 'ok' }>,
  emit: Emit): void {
  const preparing = entry.preparing;
  if (!preparing) return;
  entry.preparing = null;
  for (const item of [preparing, ...preparing.held]) if (item.pending) entry.refs.drop(item.pending);
  entry.running = false;
  entry.runStart = undefined;
  entry.model.endReply();
  const queued = preparing.held.map((item) => item.text);
  if (outcome.kind === 'unavailable') {
    entry.model.emitUnavailable(outcome.candidates, true, preparing.text, queued);
    return;
  }
  const message = outcome.kind === 'aborted' ? STOPPED_BEFORE_SENDING : outcome.message;
  promptError(sessionId, emit, { message, text: preparing.text, refs: preparing.refs ?? null, running: false,
    queued });
}

/**
 * @brief 准备好之后调 pi 的 prompt（§11.4 第 4 步）。pi 开始运行（agent_start）时暂存的消息交给 pi（releaseHeld）；
 *        prompt() 没有开始运行就结束时，抛错的撤回这条消息和暂存的消息，正常结束的（扩展命令接手）把暂存的消息放回输入框。
 */
function runPrompt(entry: Entry, sessionId: string, preparing: Preparing, emit: Emit): void {
  entry.session.prompt(preparing.text).then(() => {
    // prompt() 结束时消息早该记下了；还在等就是没有送达（例如交给了扩展命令）。
    if (preparing.pending && entry.refs.has(preparing.pending)) entry.refs.drop(preparing.pending);
    const unstarted = takeUnstarted(entry, preparing);
    settleRun(entry);
    emit({ kind: 'event', sessionId, event: { type: 'mori.prompt_done', running: entry.running } });
    const [first, ...rest] = unstarted;
    if (!first) return;
    promptError(sessionId, emit, { message: STOPPED_BEFORE_SENDING, text: first.text, refs: first.refs ?? null,
      running: entry.running, queued: rest.map((item) => item.text) });
  }, (error: unknown) => {
    const message = errorText(error);
    console.error(`[kernel] prompt failed for ${sessionId}: ${message}`);
    if (preparing.pending) entry.refs.drop(preparing.pending);
    const unstarted = takeUnstarted(entry, preparing);
    settleRun(entry);
    promptError(sessionId, emit, { message, text: preparing.text, refs: preparing.refs ?? null,
      running: entry.running, queued: unstarted.map((item) => item.text) });
  });
}

/** @brief pi 没有开始运行就结束：结束准备中，取出暂存的消息（它们的引用不再写进会话）。 */
function takeUnstarted(entry: Entry, preparing: Preparing): HeldPrompt[] {
  if (entry.preparing !== preparing) return [];
  entry.preparing = null;
  for (const item of preparing.held) if (item.pending) entry.refs.drop(item.pending);
  return preparing.held;
}

/** @brief pi 开始运行（agent_start）：准备中暂存的消息作为 followUp 交给 pi（§11.4），准备中结束。 */
function releaseHeld(entry: Entry, sessionId: string, emit: Emit): void {
  const preparing = entry.preparing;
  if (!preparing || preparing.phase !== 'starting') return;
  entry.preparing = null;
  if (preparing.held.length === 0) return;
  // 等 pi 发完 agent_start 再交：这时它已在运行，消息进它的排队区。
  queueMicrotask(() => {
    for (const item of preparing.held) sendToPi(entry, sessionId, item, 'followUp', emit);
  });
}

/** @brief 撤回排队与插话的消息，返回它们的原文；它们的引用不再写进会话（芯片不恢复）。 */
export function clearQueue(sessionId: string): ClearedQueue {
  const entry = requireEntry(sessionId);
  const { steering, followUp } = entry.session.clearQueue();
  entry.refs.dropTexts([...steering, ...followUp]);
  return { steering, followUp };
}

/**
 * @brief 停止会话当前的运行；挂起的批准卡先按拒绝处理（方案 5.8）。
 *        从 rejectForStop 开始到 session.abort() 结束，批准扩展处在停止状态，排在后面的调用不出卡也不执行。
 */
export async function abort(sessionId: string): Promise<{ aborted: true }> {
  const entry = requireEntry(sessionId);
  if (entry.preparing?.phase === 'preparing') {
    // 准备中（§11.4）：取消等待或压缩；startReply 随后撤回消息并发 mori.prompt_error。
    entry.preparing.controller.abort();
    return { aborted: true };
  }
  entry.ui.beginStop();
  try {
    await entry.gate.rejectForStop();
    await entry.session.abort();
  } finally {
    entry.ui.endStop();
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

/** @brief 你对扩展询问的回答；value 为 null 表示取消。 */
export function answerQuestion(sessionId: string, requestId: string, value: boolean | string | null) {
  requireEntry(sessionId).ui.answer(requestId, value);
  return { answered: true };
}

/** @brief 切换会话的权限。 */
export function setApprovalMode(sessionId: string, mode: ApprovalMode): ApprovalState {
  return requireEntry(sessionId).gate.setMode(mode);
}

/** @brief 从"Allowed for this session"里清除一个工具名。 */
export function forgetApproval(sessionId: string, toolName: string): ApprovalState {
  return requireEntry(sessionId).gate.forget(toolName);
}

/**
 * @brief 这个会话换思考强度（pi setThinkingLevel，不 persist）。会话的虚拟模型有全部七档，pi 按每次请求的实际模型收紧
 *        （§11.1）；顶栏显示按当前模型收紧后的强度。生成中或准备中拒绝（§11.4）。
 */
export function setSessionThinking(sessionId: string, level: ThinkingLevel): ModelState {
  const entry = requireEntry(sessionId);
  requireIdle(entry);
  entry.session.setThinkingLevel(level);
  entry.model.emitState();
  return entry.model.state();
}

/**
 * @brief 这个会话换选择范围（§5.10、§9.5 session.setPick）：写一条 mori.pick，重新做静态校验，下一段起生效；
 *        不改设置里的默认范围。生成中或准备中拒绝。
 */
export async function setSessionPick(sessionId: string, pick: ModelPick): Promise<ModelState & { error: null }> {
  const entry = requireEntry(sessionId);
  requireIdle(entry);
  return { ...(await entry.model.setPick(pick)), error: null };
}

/** @brief 顶栏菜单的各项（§9.2、§9.5 session.pickOptions，只读）：按这个会话的项目做静态校验。 */
export function sessionPickOptions(sessionId: string): Promise<PickOptions> {
  return requireEntry(sessionId).model.pickOptions();
}

/**
 * @brief "/"补全：这个会话加载了的提示词模板和技能命令，照 pi RPC 的 get_commands（rpc-mode.js 540–567）但不含扩展命令；
 *        会话的设置 enableSkillCommands 为 false 时不列技能命令（与 pi 终端的补全相同）。
 */
export function sessionCommands(sessionId: string): SlashCommand[] {
  const { session } = requireEntry(sessionId);
  const prompts = session.promptTemplates.map((template): SlashCommand => ({ name: template.name, kind: 'prompt',
    description: template.description, argumentHint: template.argumentHint ?? null }));
  if (!session.settingsManager.getEnableSkillCommands()) return prompts;
  const skills = session.resourceLoader.getSkills().skills.map((skill): SlashCommand => ({
    name: `skill:${skill.name}`, kind: 'skill', description: skill.description, argumentHint: null }));
  return [...prompts, ...skills];
}

/** @brief 退出前停止并释放所有会话；挂起的批准先按拒绝处理，pi 才不会卡在等待上。 */
export async function shutdownSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(async (entry) => {
    await release(entry);
    await entry.model.dispose();
  }));
}

