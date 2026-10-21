// 会话表：在一个后台进程里并存多个 pi 会话（M0 已验证可行），不做调度、优先级或并发限制。
// 每个会话带一个最小批准扩展（approval.ts）和扩展的界面上下文（extensionUi.ts），批准状态和挂起的询问只在这里的内存里。
// 照 Claude 桌面版，本次运行里打开过的会话一直保持打开，直到界面要求关闭（归档、删除前）或退出；界面重新加载也不停，
// 重新加载后的界面经 session.list 的 live 和 session.open 交出的这一刻的样子接上它们（docs/v0/screens/sessions.md）。
// M6：换思考强度只作用于一个会话（pi 不 persist）；"/"补全取会话的提示词模板和技能命令（docs/v0/screens/slash.md）。
// v1：模型层（docs/specs/model-providers.md §5、§6、§11）：每个会话一个 ModelSession（modelSession.ts）——虚拟模型、
// 选择范围与静态校验、流函数包装；这里接上它：会话的新建与打开、session.prompt 的准备中（§11.4）、段的结束、停止。
// 平行 Agent（docs/specs/parallel-agents-taskboard.md §2、§4.4、§5、§8.2、§11、§13.10、§14）：用户会话打开时读角色文件，
// 合格时建它的 Team（team.ts）；实例会话（instances.ts）与用户会话在同一张表里，但不进侧栏、事件交给 Team。
// 这里为 Team 提供 TeamHost：建、开、关实例，程序的投递，对话的回复，停止；协作模式下的用户消息与命令交给 Team。

import { existsSync } from 'node:fs';
import type {
  AgentSession, AgentSessionEvent, ExtensionFactory, PromptOptions as PiPromptOptions, SessionEntry, SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  BLOCKED_PROMPT_MESSAGE, STOPPED_BEFORE_SENDING, type ModelEvent, type ModelPick, type PickOptions,
} from '../shared/models';
import type {
  ApprovalDecision, ApprovalMode, ApprovalState, ClearedQueue, EventEnvelope, ExtensionNotice, KernelEvent,
  LiveSnapshot, LiveStatus, ModelState, OpenedSession, ProjectTrust, QuoteRef, SavedSession, SessionContent,
  SessionInfo, SessionState, SlashCommand, ThinkingLevel, TrustAnswer,
} from '../shared/protocol';
import {
  emptyBoard, noDeciding, soloTeamState, type BoardView, type InstanceKind, type PromptBehavior, type TeamState,
  type TeamSwitch,
} from '../shared/team';
import { ApprovalPolicy, type ApprovalGate, type GateOutput } from './approval';
import { PendingRefs, quotableEntries, supplementEntry } from './entries';
import { ExtensionUi } from './extensionUi';
import { slimEvent } from './events';
import { instanceEnvelope, instanceSetup, newInstanceManager, teamDirOf } from './instances';
import { createSharedTransport, loadMcpShare } from './mcpShare';
import { getModelLayer } from './modelLayer';
import { ModelSession, type PrepareResult } from './modelSession';
import { loadPi } from './pi';
import { findRole, loadRoles, type RoleLoad } from './roles';
import { createTeam } from './team';
import type {
  HeldItem, HostEntry, InstanceSpec, SegmentPreference, StopReason, TeamArgs, TeamHost, TeamLike,
} from './teamHost';
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
  /** 程序的投递（平行 Agent 规格 §5.6、§8.2）：不展开模板与命令；没能发出时不回到输入框（mori.prompt_error 的 text 为 null） */
  program: boolean;
  /** 你停止对话的回复时 Team 撤回的待判断消息（§11.4），随这条消息一起回到输入框；没有时为 null */
  withdrawn: Promise<string[]> | null;
}

/** @brief 一个打开的会话、它的批准状态和打开时就确定的信息。 */
interface Entry {
  /** pi 会话 */
  session: AgentSession;
  /** 这个会话的批准扩展（批准设置在共用的 ApprovalPolicy 里） */
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
  /** 会话的种类：你打开的用户会话，或实例会话的种类（平行 Agent 规格 §8.1） */
  kind: 'user' | InstanceKind;
  /** 实例所属的用户会话 id；用户会话为 null */
  owner: string | null;
  /** 用户会话的协作；角色文件有问题时与实例会话为 null */
  team: TeamLike | null;
  /** 最近一次停止的原因（§9.4）；下一次运行开始时清掉，没有停止过为 null */
  stop: StopReason | null;
  /** 这个会话的信封事件的去处：用户会话发给界面，实例会话丢弃（§8.2） */
  emit: Emit;
  /** 实例会话：pi 事件交给 Team，不发给界面（§8.2）；用户会话为 null */
  onEvent: ((event: AgentSessionEvent) => void) | null;
}

const sessions = new Map<string, Entry>();
/** 正在从会话文件打开的会话（按会话文件）：同一个文件再打开时等它打开完，不另起一个写入者 */
const opening = new Map<string, Promise<unknown>>();

/** 批准扩展的名字；pi 用 `<inline:名字>` 标出它的加载错误 */
const APPROVAL_EXTENSION = 'mori-approval';
const APPROVAL_EXTENSION_PATH = `<inline:${APPROVAL_EXTENSION}>`;
/** 模型层扩展（context 钩子、排队消息、压缩前去掉被隐藏的过程）的名字 */
const MODEL_EXTENSION = 'mori-models';
const MODEL_EXTENSION_PATH = `<inline:${MODEL_EXTENSION}>`;
/** 协作扩展（TaskBoard 的工具与钩子，team.ts）的名字（平行 Agent 规格 §8.2、§14.3） */
export const TEAM_EXTENSION = 'mori-team';
export const TEAM_EXTENSION_PATH = `<inline:${TEAM_EXTENSION}>`;
/** pi 的会话列表里没有你的消息时 firstMessage 的写法（session-manager.js buildSessionInfo） */
const NO_MESSAGES = '(no messages)';
/** pi 设置没有 defaultTools 时默认启用的工具（pi core/settings-manager.js DEFAULT_TOOL_NAMES） */
const PI_DEFAULT_TOOLS: readonly string[] = ['read', 'bash', 'edit', 'write'];
/** 会话在生成（含协作模式下有 Agent 在运行、排队或有待判断的消息）时拒绝的原文 */
const GENERATING = 'The session is generating; stop it first';

/**
 * @brief 转发一个 pi 事件。tool_execution_start 之前紧挨着由批准扩展发 mori.tool_gate：pi 先发
 *        tool_execution_start、再调用批准处理器，界面要在同一时刻就知道这张卡是"等你批准"还是"执行中"；
 *        处理器后来判断不同时由批准扩展发更正。实例会话的事件不发给界面，交给 Team；用户会话的事件发给界面后也交给它的 Team。
 *        交给 Team 放在最后：这时这次运行的记账（段的结束）已经做完，Team 在里面开始下一次投递不会被它清掉。
 */
function forward(entry: Entry, event: AgentSessionEvent): void {
  // 重建对话时的压缩（§6.3 第 1 步）不转给界面：结果只经 mori.model_rebuild 或换模型提示显示。
  if (entry.model.isSuppressed(event.type)) return;
  const sessionId = entry.session.sessionId;
  if (event.type === 'agent_start') {
    entry.running = true;
    entry.stop = null;
    // 扩展发起的一轮没有经过 prompt()：这时才记下本轮开始时的叶子（你的消息还没写入）。
    if (entry.runStart === undefined) entry.runStart = entry.session.sessionManager.getLeafId();
    entry.model.onAgentStart();
    releaseHeld(entry);
  }
  if (event.type === 'agent_settled') {
    entry.running = false;
    entry.runStart = undefined;
  }
  if (event.type === 'tool_execution_start') {
    entry.toolStarts.set(event.toolCallId, Date.now());
    entry.gate.announce(event.toolCallId, event.toolName);
  }
  if (!entry.onEvent) entry.emit({ kind: 'event', sessionId, event: slimEvent(event) });
  if (event.type === 'message_end' && !entry.onEvent) {
    supplementEntry(entry.session, sessionId, entry.refs, event.message, entry.emit);
  }
  if (event.type === 'tool_execution_end') {
    entry.toolStarts.delete(event.toolCallId);
    entry.gate.noteToolEnd(event.toolCallId);
  }
  // 一段结束（§5.2）：pi 每次运行结束发一次 agent_settled（K13）。
  if (event.type === 'agent_settled') entry.model.endReply();
  entry.onEvent?.(event);
  entry.team?.onUserEvent(event);
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
    ...teamPart(entry),
  };
}

/**
 * @brief 协作的部分（平行 Agent 规格 §13.10）：有 Team 时由它给出；没有 Team（角色文件有问题）时会话里只有对话 Agent——
 *        关闭模式、基座持有三项权限、TaskBoard 没有需求、没有后台批准与待判断的消息，busy 就是对话是否在运行或准备中。
 */
function teamPart(entry: Entry): Pick<SessionInfo, 'team' | 'board' | 'teamApprovals' | 'deciding'> {
  if (entry.team) return entry.team.info();
  return { team: soloTeamState(soloRunning(entry)), board: emptyBoard(), teamApprovals: [], deciding: noDeciding() };
}

/** @brief 对话 Agent 自己是否在运行或准备中。 */
function soloRunning(entry: Entry): boolean {
  return entry.running || entry.session.isStreaming;
}

/** @brief 新建会话与从文件打开会话共用的参数。 */
interface StartArgs {
  /** 工作目录 */
  cwd: string;
  /** 会话的 SessionManager */
  sessionManager: SessionManager;
  /** 发事件（这个会话的信封） */
  emit: Emit;
  /** 你对信任询问的回答；没问时为 undefined */
  trust: TrustAnswer | undefined;
  /** 打开已保存的会话 */
  restored: boolean;
}

/** @brief 用户会话另有的参数：Check again 重新建立时沿用的信任结果与刚读的角色（平行 Agent 规格 §4.4）。 */
interface UserStart extends StartArgs {
  /** 沿用的信任结果；省略时按 trust 判断 */
  decision?: TrustDecision;
  /** 已经读好的角色；省略时读角色文件 */
  roles?: RoleLoad;
}

/** @brief 建一个会话要用的、用户会话与各种实例会话不同的部分（平行 Agent 规格 §8.2）。 */
export interface SessionSetup {
  /** 会话的种类 */
  kind: 'user' | InstanceKind;
  /** 实例所属的用户会话 id；用户会话为 null */
  owner: string | null;
  /** 项目信任的结果（实例沿用用户会话的） */
  trust: TrustDecision;
  /** 批准状态（一个用户会话一份，实例共用） */
  approval: ApprovalPolicy;
  /** 批准扩展的请求 id 前缀与实例交给 Team 的回调（send 由会话表补上） */
  gate: Omit<GateOutput, 'send'>;
  /** 这个会话自己的 SettingsManager（按信任结果读项目设置） */
  settings: SettingsManager;
  /** mori-team 扩展；角色文件有问题的用户会话为 null（只有基座，不注册它，§4.4） */
  teamExtension: ExtensionFactory | null;
  /** 加在 system prompt 末尾的段（appendSystemPromptOverride）；为空时不改（与 v0 相同） */
  appendPrompt: string[];
  /** pi 的工具白名单（createAgentSession 的 tools）；用户会话为 null，照 v0 的方式加载工具（§14.1） */
  tools: string[] | null;
  /** 实例会话的 pi 事件交给 Team；用户会话为 null */
  onEvent: ((event: AgentSessionEvent) => void) | null;
}

/**
 * @brief 资源加载器与 createAgentSession 默认建的相同（同一个 settingsManager），另有几个 inline extension，
 *        顺序为 mori-models、mori-team（有 Team 时）、mori-approval、mcp（平行 Agent 规格 §8.2、§14.3：context 处理器先模型层
 *        后工作卡，tool_call 处理器先 mori-team 的拒绝后批准）。项目信任已经判断好，pi 在加载项目资源之前问时直接交给它。
 */
async function loadResources(cwd: string, setup: SessionSetup, gate: ApprovalGate, models: ExtensionFactory) {
  const pi = await loadPi();
  // MCP 照 pi 命令行的注册方式作为内置扩展加入（方案第 6 节）：`pi config` 和设置里的 -builtin:mcp 对它有效；
  // bindExtensions 发 session_start 时它在后台连接服务。codemode 不进 v0，所以服务要用直接调用方式。
  // 传输交给 Mori 的共享连接（mcpShare.ts，docs/v0/m6-mcp-shared.md）：每个服务一个进程，所有会话共用。
  await loadMcpShare();
  const mcp = { name: 'mcp', factory: pi.createMcpExtension({ createTransport: createSharedTransport }),
    replaceable: true, builtin: true };
  const team = setup.teamExtension ? [{ name: TEAM_EXTENSION, factory: setup.teamExtension }] : [];
  const extensionFactories = [{ name: MODEL_EXTENSION, factory: models }, ...team,
    { name: APPROVAL_EXTENSION, factory: gate.extension() }, mcp];
  const append = setup.appendPrompt;
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir: pi.getAgentDir(),
    settingsManager: setup.settings, extensionFactories,
    ...(append.length > 0 ? { appendSystemPromptOverride: (base: string[]) => [...base, ...append] } : {}) });
  await resourceLoader.reload({ resolveProjectTrust: async () => setup.trust.trusted });
  return resourceLoader;
}

/**
 * @brief 这个会话自己的 SettingsManager。按信任结果读项目设置：pi 在 reload 里先按"不信任"加载一遍、再按信任结果设回，
 *        结果与 v0 的先按"不信任"创建相同；先按结果创建，是为了在建 Team 之前读到默认工具（§4.2）。
 */
async function createSettings(cwd: string, trust: TrustDecision): Promise<SettingsManager> {
  const pi = await loadPi();
  return pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: trust.trusted });
}

/**
 * @brief 检查扩展的加载错误：批准扩展没加载上时，pi 没有 tool_call 处理器就不经询问直接执行；模型层扩展没加载上时，
 *        换模型后被隐藏的过程会发给新模型；给了 mori-team 而它没加载上时，TaskBoard 的工具与限制都不在（§8.2）。
 *        这些情况都不打开会话。
 * @param team 这个会话带 mori-team
 * @return 加载失败的扩展（路径和原文）
 */
function checkExtensions(session: AgentSession, errors: { path: string; error: string }[], team: boolean): string[] {
  for (const error of errors) console.error(`[kernel] extension failed to load: ${error.path}: ${error.error}`);
  const required = errors.find((error) => error.path === APPROVAL_EXTENSION_PATH
    || error.path === MODEL_EXTENSION_PATH || (team && error.path === TEAM_EXTENSION_PATH));
  if (required) {
    session.dispose();
    const which = required.path === APPROVAL_EXTENSION_PATH ? 'approval'
      : required.path === MODEL_EXTENSION_PATH ? 'model layer' : 'team';
    throw new Error(`The ${which} extension failed to load: ${required.error}`);
  }
  return errors.map((error) => `${error.path}: ${error.error}`);
}

/**
 * @brief 建立会话的模型层接线：读选择范围（新会话记下默认范围，v0 的旧会话按 §5.1 记下）并做静态校验。
 * @param args 打开会话的参数
 * @param extra 角色会话的模型层选项（候选来源、调度类别等，平行 Agent 规格 §12）；用户会话为对话持有者的能力要求
 * @param emit 模型层事件的去处：用户会话发给界面，实例会话交给 Team
 */
async function createModelSession(args: StartArgs, extra: InstanceSpec['model'],
  emit: (event: ModelEvent) => void): Promise<ModelSession> {
  const layer = await getModelLayer();
  const sessionId = args.sessionManager.getSessionId();
  const model = await ModelSession.create({ ...extra, layer, sessionId, cwd: args.cwd, emit });
  try {
    await model.loadPick(args.sessionManager, !args.restored);
  } catch (error) {
    await model.dispose();
    throw error;
  }
  return model;
}

/**
 * @brief 建 pi 会话并登记：虚拟模型、思考强度（§11.1）、流函数包装（§11.2）、扩展、事件转发。
 * @param args 打开会话的参数
 * @param setup 这种会话的设置
 * @param model 模型层的会话接线
 */
async function createEntry(args: StartArgs, setup: SessionSetup, model: ModelSession): Promise<Entry> {
  const pi = await loadPi();
  const sessionId = args.sessionManager.getSessionId();
  const gate = setup.approval.gate({ ...setup.gate, send: (event) => args.emit({ kind: 'event', sessionId, event }) });
  const ui = new ExtensionUi(args.emit, setup.kind !== 'user');
  try {
    const resourceLoader = await loadResources(args.cwd, setup, gate, model.extension());
    const virtual = await model.register();
    // 新会话按第一个候选取思考强度；打开已有会话时不传，pi 从会话记录恢复（§11.1）。
    const thinkingLevel = args.restored ? undefined : model.newSessionThinking(setup.settings);
    const result = await pi.createAgentSession({ cwd: args.cwd, modelRuntime: model.layer.getRuntime(),
      settingsManager: setup.settings, sessionManager: args.sessionManager, resourceLoader, model: virtual,
      thinkingLevel, ...(setup.tools ? { tools: setup.tools } : {}) });
    const { session } = result;
    // 一条回复里的多个调用按顺序执行：允许一张卡就执行一张（临时默认值，见 docs/v0/defaults.md）。
    session.agent.toolExecution = 'sequential';
    const extensionErrors = checkExtensions(session, result.extensionsResult.errors, setup.teamExtension !== null);
    model.attach(session);
    // 实例的工具由白名单决定（§14.1），不按 v0 的做法补上扩展工具。
    if (args.restored && setup.kind === 'user') refreshTools(session);
    ui.attach(sessionId);
    await session.bindExtensions({
      uiContext: ui.context(),
      onError: (error) => console.error(`[kernel] extension error ${error.extensionPath}: ${error.error}`),
    });
    const entry: Entry = { session, gate, ui, cwd: args.cwd, running: false, openedAt: Date.now(),
      toolStarts: new Map(), notices: ui.ready(), model, preparing: null, trust: setup.trust, extensionErrors,
      refs: new PendingRefs(), runStart: undefined, kind: setup.kind, owner: setup.owner, team: null, stop: null,
      emit: args.emit, onEvent: setup.onEvent };
    sessions.set(sessionId, entry);
    session.subscribe((event) => forward(entry, event));
    return entry;
  } catch (error) {
    gate.close();
    throw error;
  }
}

/**
 * @brief 读用户会话的角色文件（平行 Agent 规格 §4.3、§4.4）：models 引用的名字按模型层在这个项目里能否展开判断，
 *        frontmatter 用 pi 的 parseFrontmatter。
 */
async function readRoles(cwd: string): Promise<RoleLoad> {
  const [pi, layer] = await Promise.all([loadPi(), getModelLayer()]);
  const context = await layer.projectContext(cwd);
  return loadRoles(cwd, { pickExists: (name) => layer.expandPickIn(context, name) !== null,
    parseFrontmatter: (content) => pi.parseFrontmatter(content) });
}

/**
 * @brief 建用户会话的 Team 的参数（§2、§3）。
 * @param args 打开会话的参数
 * @param roles 合格的角色
 * @param setup 用户会话的设置（信任、批准状态、默认工具所在的设置）
 */
function teamArgs(args: StartArgs, roles: RoleLoad, setup: SessionSetup): TeamArgs {
  const userSessionId = args.sessionManager.getSessionId();
  return { userSessionId, userSessionFile: args.sessionManager.getSessionFile() ?? null, cwd: args.cwd, roles,
    teamDir: teamDirOf(userSessionId), baseTools: setup.settings.getDefaultTools() ?? PI_DEFAULT_TOOLS,
    trust: setup.trust, approval: setup.approval, restored: args.restored };
}

/**
 * @brief 新建或打开一个用户会话：读角色文件；有问题时会话照"只有基座"建立并按 agents_invalid 拒绝启动（§4.4），
 *        合格时在建资源加载器之前建 Team（它的 mori-team 扩展要进扩展列表），会话建好后交给它（attachUser）。
 *        对话持有者的正文进 system prompt 的附加段（基座没有，与 v0 相同，§8.5）。失败时注销虚拟模型。
 */
async function startUser(args: UserStart): Promise<Entry> {
  const roles = args.roles ?? await readRoles(args.cwd);
  const trust = args.decision ?? await decideTrust(args.cwd, args.trust);
  const valid = roles.problems.length === 0;
  const dialog = valid ? findRole(roles.roles, roles.holders.dialog) : null;
  const sessionId = args.sessionManager.getSessionId();
  // 对话持有者写了 requires 时，你选的范围另按它校验（统一模型提供商规格 §5.1）；基座只要求 tool_calling。
  const source = dialog?.file ? { source: { kind: 'pick' as const, requires: dialog.requires } } : {};
  let team: TeamLike | null = null;
  // 用户会话这次请求的工作卡算进接手判断与窗口估算（§8.3 最后一条、§12.6）。
  const extra = { ...source, extraContextTokens: () => team?.cardTokens() ?? 0 };
  const model = await createModelSession(args, extra, (event) => args.emit({ kind: 'event', sessionId, event }));
  try {
    if (!valid) await model.setAgentProblems(roles.problems);
    const setup: SessionSetup = { kind: 'user', owner: null, trust, approval: new ApprovalPolicy(),
      gate: { prefix: '' }, settings: await createSettings(args.cwd, trust), teamExtension: null,
      appendPrompt: dialog?.body ? [dialog.body] : [], tools: null, onEvent: null };
    team = valid ? createTeam(host, teamArgs(args, roles, setup)) : null;
    const entry = await createEntry(args, { ...setup, teamExtension: team?.userExtension() ?? null }, model);
    await attachTeam(entry, team);
    return entry;
  } catch (error) {
    if (team) await closeTeam(team);
    await model.dispose();
    throw error;
  }
}

/** @brief 会话建好后交给它的 Team（§5、§11.6）；Team 接不上时会话不打开。 */
async function attachTeam(entry: Entry, team: TeamLike | null): Promise<void> {
  if (!team) return;
  entry.team = team;
  try {
    await team.attachUser({ sessionId: entry.session.sessionId, session: entry.session, model: entry.model });
  } catch (error) {
    console.error(`[kernel] the team of ${entry.session.sessionId} did not start: ${errorText(error)}`);
    sessions.delete(entry.session.sessionId);
    await release(entry);
    throw error;
  }
}

/** @brief 关闭一个 Team（会话关闭、建立失败）；出错时只记日志。 */
async function closeTeam(team: TeamLike): Promise<void> {
  try {
    await team.close();
  } catch (error) {
    console.error(`[kernel] closing a team failed: ${errorText(error)}`);
  }
}

/** @brief 在指定目录新建 pi 会话。 */
export async function createSession(cwd: string, emit: Emit, trust?: TrustAnswer): Promise<SessionInfo> {
  const pi = await loadPi();
  if (!existsSync(cwd)) throw new Error(`Project folder not found: ${cwd}`);
  return describeEntry(await startUser({ cwd, sessionManager: pi.SessionManager.create(cwd), emit, trust,
    restored: false }));
}

/** @brief 已打开的、会话文件是 sessionFile 的用户会话（实例会话不在界面上，§8.1）。 */
function entryByFile(sessionFile: string): Entry | undefined {
  return [...sessions.values()].find((entry) => entry.kind === 'user' && entry.session.sessionFile === sessionFile);
}

/** @brief 还开着的会话的状态（侧栏）；没有 Team 时没有后台的运行与批准。 */
function liveStatus(entry: Entry): LiveStatus {
  const team = entry.team?.live() ?? { teamBusy: false, teamApproval: false };
  return { running: soloRunning(entry), approval: entry.gate.requests().length > 0,
    question: entry.ui.requests().length > 0, ...team };
}

/** @brief 还开着的会话这一刻的样子：正在生成的回复、正在执行的工具、挂起的批准请求和扩展询问、排队区。 */
export function snapshot(entry: Entry): LiveSnapshot {
  const { session } = entry;
  const runningTools = [...session.state.pendingToolCalls].map((toolCallId) => ({ toolCallId,
    startedAt: entry.toolStarts.get(toolCallId) ?? Date.now() }));
  return { running: soloRunning(entry), preparing: entry.preparing !== null && !session.isStreaming,
    streaming: session.state.streamingMessage ?? null, runningTools,
    approvals: entry.gate.requests(), questions: entry.ui.requests(), steering: [...session.getSteeringMessages()],
    // 准备中暂存的消息也在排队区（§11.4）。
    followUp: [...session.getFollowUpMessages(), ...(entry.preparing?.held.map((item) => item.text) ?? [])],
    ...teamPart(entry) };
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
  return whileOpening(sessionFile, openFromFile(sessionFile, emit, trust));
}

/** @brief 记下正在从这个文件打开，打开完（成功或失败）后去掉。 */
async function whileOpening<T>(sessionFile: string, started: Promise<T>): Promise<T> {
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
  const entry = await startUser({ cwd, sessionManager: manager, emit, trust, restored: true });
  return { ...describeEntry(entry), entries: manager.getBranch(), live: null };
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
 * @brief 读出一个会话已完成的部分（会话引用，docs/v0/screens/session-refs.md）。后台进程里开着的会话读它自己的分支，
 *        在生成时只交出已完成的轮次；没开着的用 SessionManager.open 读（不创建会话、不加载扩展、不问信任）。
 *        程序投递到用户会话的消息不交（entries.ts quotableEntries，平行 Agent 规格 §13.11）。
 */
export async function readSession(sessionFile: string): Promise<SessionContent> {
  const live = entryByFile(sessionFile);
  if (live) {
    const branch = live.session.sessionManager.getBranch();
    const unfinished = live.runStart !== undefined;
    return { sessionFile, cwd: live.cwd, name: live.session.sessionName ?? null, unfinished,
      entries: quotableEntries(unfinished ? completedPart(branch, live.runStart ?? null) : branch) };
  }
  if (!existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile}`);
  const pi = await loadPi();
  const manager = pi.SessionManager.open(sessionFile);
  return { sessionFile, cwd: manager.getCwd(), name: manager.getSessionName() ?? null,
    entries: quotableEntries(manager.getBranch()), unfinished: false };
}

/** @brief 还开着、但还没保存（没有会话文件）的用户会话：界面重新加载后也能在侧栏看到、打开、删除。 */
function unsavedLive(listed: SavedSession[]): SavedSession[] {
  return [...sessions.values()].filter((entry) => entry.kind === 'user' && entry.session.sessionFile
    && !existsSync(entry.session.sessionFile)
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

/** @brief 对话 Agent 自己是否空闲（不在生成、不在准备中）。 */
function isIdle(entry: Entry): boolean {
  return !entry.running && !entry.preparing && !entry.session.isStreaming;
}

/** @brief 正在生成或准备中时拒绝（关闭、换范围、换思考强度），不替你停止。 */
function requireIdle(entry: Entry): void {
  if (!isIdle(entry)) throw new Error(GENERATING);
}

/**
 * @brief 关闭并释放一个会话（归档、删除前），注销它的虚拟模型；正在生成、或这个用户会话还有 Agent 在运行、排队、
 *        有待判断的消息时拒绝（平行 Agent 规格 §11.5），不替你停止。用户会话的实例会话随它的 Team 一起关闭。
 */
export async function closeSession(sessionId: string): Promise<{ closed: true }> {
  const entry = requireEntry(sessionId);
  requireIdle(entry);
  if (entry.team?.busy()) throw new Error(GENERATING);
  await closeEntry(entry);
  return { closed: true };
}

/** @brief 从表里去掉并释放一个空闲的会话：先关它的 Team（实例会话），再释放 pi 会话与虚拟模型。 */
async function closeEntry(entry: Entry): Promise<void> {
  sessions.delete(entry.session.sessionId);
  if (entry.team) await closeTeam(entry.team);
  await release(entry);
  await entry.model.dispose();
}

/** @brief 发出提示时的选项。 */
interface PromptOptions {
  /** 生成中时的送达方式（steer 插话 / followUp 排队），交给 pi 的 prompt；空闲时 pi 直接发送 */
  behavior?: PromptBehavior;
  /** 输入框里的引用芯片：pi 记下这条消息后写成 mori.ref 条目（entries.ts） */
  refs?: QuoteRef[];
  /** 以 /team <文字> 发出（平行 Agent 规格 §5.1） */
  team?: 'once';
}

/** @brief mori.prompt_error 的字段。 */
interface PromptErrorFields {
  /** 错误原文 */
  message: string;
  /** 撤回的消息；程序的投递、只撤回 queued 时为 null */
  text: string | null;
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

/** @brief 发一个这个会话的事件（实例会话丢弃，§8.2）。 */
function send(entry: Entry, event: KernelEvent): void {
  entry.emit({ kind: 'event', sessionId: entry.session.sessionId, event });
}

/** @brief 发 mori.prompt_error。 */
function promptError(entry: Entry, fields: PromptErrorFields): void {
  send(entry, { type: 'mori.prompt_error', ...fields });
}

/** @brief pi 的 prompt() 结束后按 pi 的状态重设运行状态；会话已不在运行时一段结束（§5.2）。 */
function settleRun(entry: Entry): void {
  entry.running = entry.session.isStreaming || entry.preparing !== null;
  if (entry.running) return;
  entry.runStart = undefined;
  entry.model.endReply();
}

/**
 * @brief 发出提示；不等本轮结束，结果和失败都通过事件回到界面。被拒绝启动的会话拒绝（§4.6）；协作模式下（或带
 *        team: 'once'）交给 Team（平行 Agent 规格 §5.3）；其余与关闭模式相同（dispatch）。
 */
export function prompt(sessionId: string, text: string, options: PromptOptions) {
  const entry = requireEntry(sessionId);
  if (entry.model.isBlocked()) {
    promptError(entry, { message: BLOCKED_PROMPT_MESSAGE, text, refs: options.refs ?? null, running: entry.running,
      queued: [] });
    return { accepted: true };
  }
  const item: HeldItem = { text, refs: options.refs };
  if (entry.team?.takesPrompt(text, options.team)) entry.team.onUserPrompt(item, options.behavior, options.team);
  else dispatch(entry, item, options.behavior);
  return { accepted: true };
}

/**
 * @brief 交给对话：准备中暂存，pi 开始运行后作为 followUp 交给 pi（§11.4）；生成中按 behavior 交给 pi（插话或排队）；
 *        空闲时开始一段：先准备（选模型、等待、重建），再调 pi。
 */
function dispatch(entry: Entry, item: HeldItem, behavior: PromptBehavior | undefined): void {
  const pending = item.refs?.length ? entry.refs.add(item.text, item.refs) : null;
  const held: HeldPrompt = { text: item.text, refs: item.refs, pending };
  if (entry.preparing) entry.preparing.held.push(held);
  else if (entry.running || entry.session.isStreaming) sendToPi(entry, held, behavior);
  else void startReply(entry, held, {});
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
function sendToPi(entry: Entry, item: HeldPrompt, behavior: PromptOptions['behavior']): void {
  const sessionId = entry.session.sessionId;
  entry.model.disableRetry();
  entry.session.prompt(item.text, streamingOptions(entry, behavior)).then(() => {
    settleRun(entry);
    send(entry, { type: 'mori.prompt_done', running: entry.running });
  }, (error: unknown) => {
    const message = errorText(error);
    console.error(`[kernel] prompt failed for ${sessionId}: ${message}`);
    if (item.pending) entry.refs.drop(item.pending);
    settleRun(entry);
    promptError(entry, { message, text: item.text, refs: item.refs ?? null, running: entry.running, queued: [] });
  });
}

/** @brief 一段怎样开始：程序的投递、段开始时的偏好、准备中先做的事（平行 Agent 规格 §8.2、§12.4、§5.3）。 */
interface ReplyStart {
  /** 程序的投递：prompt(text, { expandPromptTemplates: false })，没能发出时不回到输入框 */
  program?: boolean;
  /** 段开始时选模型的偏好 */
  choice?: SegmentPreference;
  /** 准备中、模型层 prepare 之前先做的事（分开时立项的判断）；停止时它的 signal 中止 */
  before?: (signal: AbortSignal) => Promise<void>;
}

/**
 * @brief 空闲时发消息（§11.4）：进入准备中（会话按“发送中”显示），模型层选模型、等待、重建；准备好后调 pi 的 prompt。
 *        停止、等不到模型或准备时出错：撤回这条消息和准备中又发的消息。
 * @return 这次回复结束时兑现（运行结束，或准备中就结束），从不拒绝
 */
async function startReply(entry: Entry, item: HeldPrompt, how: ReplyStart): Promise<void> {
  const preparing: Preparing = { ...item, held: [], controller: new AbortController(), phase: 'preparing',
    program: how.program ?? false, withdrawn: null };
  entry.preparing = preparing;
  entry.running = true;
  entry.stop = null;
  // 空闲时发出的提示开始新的一轮：记下这时的叶子，会话引用只取到这里（已完成的轮次）。
  entry.runStart = entry.session.sessionManager.getLeafId();
  const outcome = await prepareReply(entry, preparing, how);
  if (outcome.kind !== 'ok') {
    await giveBack(entry, outcome);
    return;
  }
  preparing.phase = 'starting';
  entry.model.disableRetry();
  await runPrompt(entry, preparing);
}

/** @brief 准备中（§11.4 第 1–3 步）：先做 before，再由模型层选模型、等待、重建；停止与出错都变成结果。 */
async function prepareReply(entry: Entry, preparing: Preparing, how: ReplyStart): Promise<PrepareOutcome> {
  const { signal } = preparing.controller;
  let outcome: PrepareOutcome;
  try {
    if (how.before) await how.before(signal);
    outcome = signal.aborted ? { kind: 'aborted' } : await entry.model.prepare(preparing.text, signal, how.choice);
  } catch (error) {
    if (!signal.aborted) {
      console.error(`[kernel] preparing the reply failed for ${entry.session.sessionId}: ${errorText(error)}`);
    }
    outcome = signal.aborted ? { kind: 'aborted' } : { kind: 'failed', message: errorText(error) };
  }
  if (outcome.kind === 'ok' && signal.aborted) outcome = { kind: 'aborted' };
  return outcome;
}

/**
 * @brief 准备中没能发出（§11.4）：撤回这条消息和暂存的消息，你停止对话的回复时还有 Team 撤回的待判断消息（§11.4）。
 *        停止或出错时发 mori.prompt_error；等不到模型时只发 mori.model_unavailable（§5.8，firstRequest 为真）。
 *        程序的投递不回到输入框（text 为 null，平行 Agent 规格 §5.6）。
 */
async function giveBack(entry: Entry, outcome: Exclude<PrepareOutcome, { kind: 'ok' }>): Promise<void> {
  const preparing = entry.preparing;
  if (!preparing) return;
  entry.preparing = null;
  for (const item of [preparing, ...preparing.held]) if (item.pending) entry.refs.drop(item.pending);
  entry.running = false;
  entry.runStart = undefined;
  entry.model.endReply();
  const withdrawn = preparing.withdrawn ? await preparing.withdrawn : [];
  const queued = [...preparing.held.map((item) => item.text), ...withdrawn];
  const text = preparing.program ? null : preparing.text;
  if (outcome.kind === 'unavailable') {
    entry.model.emitUnavailable(outcome.candidates, true, text, queued);
    return;
  }
  const message = outcome.kind === 'aborted' ? STOPPED_BEFORE_SENDING : outcome.message;
  promptError(entry, { message, text, refs: text === null ? null : preparing.refs ?? null, running: false, queued });
}

/**
 * @brief 准备好之后调 pi 的 prompt（§11.4 第 4 步）。pi 开始运行（agent_start）时暂存的消息交给 pi（releaseHeld）；
 *        prompt() 没有开始运行就结束时，抛错的撤回这条消息和暂存的消息，正常结束的（扩展命令接手）把暂存的消息放回输入框。
 *        程序的投递不展开提示词模板和 / 命令（平行 Agent 规格 §8.2、§14.6 T-S3）。
 * @return pi 的 prompt() 结束时兑现，从不拒绝
 */
function runPrompt(entry: Entry, preparing: Preparing): Promise<void> {
  const sessionId = entry.session.sessionId;
  const options = preparing.program ? { expandPromptTemplates: false } : undefined;
  return entry.session.prompt(preparing.text, options).then(() => {
    // prompt() 结束时消息早该记下了；还在等就是没有送达（例如交给了扩展命令）。
    if (preparing.pending && entry.refs.has(preparing.pending)) entry.refs.drop(preparing.pending);
    const unstarted = takeUnstarted(entry, preparing);
    settleRun(entry);
    send(entry, { type: 'mori.prompt_done', running: entry.running });
    const [first, ...rest] = unstarted;
    if (!first) return;
    promptError(entry, { message: STOPPED_BEFORE_SENDING, text: first.text, refs: first.refs ?? null,
      running: entry.running, queued: rest.map((item) => item.text) });
  }, (error: unknown) => {
    const message = errorText(error);
    console.error(`[kernel] prompt failed for ${sessionId}: ${message}`);
    if (preparing.pending) entry.refs.drop(preparing.pending);
    const unstarted = takeUnstarted(entry, preparing);
    settleRun(entry);
    const text = preparing.program ? null : preparing.text;
    promptError(entry, { message, text, refs: text === null ? null : preparing.refs ?? null,
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
function releaseHeld(entry: Entry): void {
  const preparing = entry.preparing;
  if (!preparing || preparing.phase !== 'starting') return;
  entry.preparing = null;
  if (preparing.held.length === 0) return;
  // 等 pi 发完 agent_start 再交：这时它已在运行，消息进它的排队区。
  queueMicrotask(() => {
    for (const item of preparing.held) sendToPi(entry, item, 'followUp');
  });
}

/**
 * @brief 撤回排队与插话的消息，返回它们的原文（texts 按放回输入框的顺序）；它们的引用不再写进会话（芯片不恢复）。
 *        协作模式下同时撤回立项还没开始判断的消息，排在后面（平行 Agent 规格 §5.3）。
 */
export function clearQueue(sessionId: string): ClearedQueue {
  const entry = requireEntry(sessionId);
  const { steering, followUp } = entry.session.clearQueue();
  const fromPi = [...steering, ...followUp];
  entry.refs.dropTexts(fromPi);
  return { steering, followUp, texts: [...fromPi, ...(entry.team?.withdrawDeciding() ?? [])] };
}

/**
 * @brief 停止会话当前的运行；准备中时取消准备（startReply 随后撤回消息）。挂起的批准卡先按拒绝处理（方案 5.8）：
 *        从 rejectForStop 开始到 session.abort() 结束，批准扩展处在停止状态，排在后面的调用不出卡也不执行。
 */
async function stopRun(entry: Entry): Promise<void> {
  if (entry.preparing?.phase === 'preparing') {
    // 准备中（§11.4）：取消等待或压缩；startReply 随后撤回消息并发 mori.prompt_error。
    entry.preparing.controller.abort();
    return;
  }
  entry.ui.beginStop();
  try {
    await entry.gate.rejectForStop();
    await entry.session.abort();
  } finally {
    entry.ui.endStop();
    entry.gate.endStop();
  }
}

/** @brief Team 撤回为这次回复判断的待判断消息（§11.4）；出错时记日志、不撤回。 */
async function dialogStopTexts(team: TeamLike): Promise<string[]> {
  try {
    return await team.onDialogStop();
  } catch (error) {
    console.error(`[kernel] withdrawing the deciding messages failed: ${errorText(error)}`);
    return [];
  }
}

/**
 * @brief 停止对话的回复（Esc、停止按钮；平行 Agent 规格 §11.4）：记下原因 dialog，停为它判断的立项；撤回的待判断消息
 *        跟准备中撤回的消息一起回到输入框（mori.prompt_error 的 queued）；没有准备中的消息时单独交回（text 为 null）。
 */
export async function abort(sessionId: string): Promise<{ aborted: true }> {
  const entry = requireEntry(sessionId);
  entry.stop = 'dialog';
  const withdrawn = entry.team ? dialogStopTexts(entry.team) : null;
  if (entry.preparing?.phase === 'preparing') {
    entry.preparing.withdrawn = withdrawn;
    entry.preparing.controller.abort();
    return { aborted: true };
  }
  await stopRun(entry);
  const texts = withdrawn ? await withdrawn : [];
  if (texts.length > 0) {
    promptError(entry, { message: STOPPED_BEFORE_SENDING, text: null, refs: null, running: entry.running,
      queued: texts });
  }
  return { aborted: true };
}

/** @brief 读取会话的上下文用量。 */
export function sessionState(sessionId: string): SessionState {
  return { contextUsage: requireEntry(sessionId).session.getContextUsage() ?? null };
}

/** @brief 你在批准卡上的选择：后台实例的卡交给 Team（平行 Agent 规格 §11.3），其余是对话自己的。 */
export function answerApproval(sessionId: string, requestId: string, decision: ApprovalDecision,
  reason: string | undefined): ApprovalState {
  const entry = requireEntry(sessionId);
  if (entry.team?.answerApproval(requestId, decision, reason)) return entry.gate.state();
  return entry.gate.answer(requestId, decision, reason);
}

/** @brief 你对扩展询问的回答；value 为 null 表示取消。 */
export function answerQuestion(sessionId: string, requestId: string, value: boolean | string | null) {
  requireEntry(sessionId).ui.answer(requestId, value);
  return { answered: true };
}

/** @brief 切换会话的权限（对这个用户会话的全部 Agent 生效，平行 Agent 规格 §11.1）。 */
export function setApprovalMode(sessionId: string, mode: ApprovalMode): ApprovalState {
  return requireEntry(sessionId).gate.setMode(mode);
}

/** @brief 从"本会话已允许"里清除一个工具名。 */
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

// ---- 平行 Agent 与 TaskBoard 的命令（平行 Agent 规格 §13.10） ----

/** @brief 取出用户会话的 Team；角色文件有问题（没有 Team）时报错。 */
function requireTeam(entry: Entry): TeamLike {
  if (!entry.team) throw new Error('The agent files have problems; fix them and choose Check again');
  return entry.team;
}

/** @brief session.setTeam（§5.1）：开关协作模式。 */
export async function setTeamMode(sessionId: string, mode: TeamSwitch): Promise<TeamState & { error: null }> {
  return { ...(await requireTeam(requireEntry(sessionId)).setMode(mode)), error: null };
}

/** @brief board.get（只读）：这个用户会话的 TaskBoard 视图；没有 Team 时是空的。 */
export function boardView(sessionId: string): BoardView & { error: null } {
  const entry = requireEntry(sessionId);
  return { ...(entry.team?.info().board ?? emptyBoard()), error: null };
}

/** @brief session.stopTeam（§11.4）：停止这个用户会话的全部 Agent，返回回到输入框的待判断消息；没有 Team 时什么都不做。 */
export async function stopTeam(sessionId: string): Promise<{ texts: string[]; error: null }> {
  const entry = requireEntry(sessionId);
  const { texts } = entry.team ? await entry.team.stopTeam() : { texts: [] };
  return { texts, error: null };
}

/**
 * @brief 拒绝启动卡的 Check again（session.recheckAgents，§4.4）：只在会话空闲时可用；重新读、重新校验角色文件。
 *        仍有问题时更新卡上的问题；通过时（或会话本来就有 Team）释放这条 pi 会话，从文件重新打开
 *        （还没写盘的新会话用同一个 id 重新建立），沿用这次的信任结果，返回新的会话信息。
 */
export async function recheckAgents(sessionId: string): Promise<SessionInfo & { error: null }> {
  const entry = requireEntry(sessionId);
  requireIdle(entry);
  if (entry.team?.busy()) throw new Error(GENERATING);
  const roles = await readRoles(entry.cwd);
  if (roles.problems.length > 0 && entry.team === null) {
    await entry.model.setAgentProblems(roles.problems);
    return { ...describeEntry(entry), error: null };
  }
  const pi = await loadPi();
  const file = entry.session.sessionFile;
  const saved = file !== undefined && existsSync(file) ? file : null;
  await closeEntry(entry);
  const sessionManager = saved !== null ? pi.SessionManager.open(saved)
    : pi.SessionManager.create(entry.cwd, undefined, { id: sessionId });
  const next = await startUser({ cwd: entry.cwd, sessionManager, emit: entry.emit, trust: undefined,
    restored: saved !== null, decision: entry.trust, roles });
  return { ...describeEntry(next), error: null };
}

// ---- Team 用的会话表操作（teamHost.ts TeamHost，平行 Agent 规格 §8.2、§14） ----

/**
 * @brief 建一个实例会话（§8.2）：它自己的设置与加载器、沿用的信任与批准状态、白名单与附加段、mori-team；
 *        模型层事件交给 Team。失败时注销虚拟模型。
 * @param spec 实例的设置
 * @param manager 实例的 SessionManager（新建或从文件打开）
 * @param restored 从文件重新打开
 * @return 实例的 pi 会话 id
 */
async function startInstance(spec: InstanceSpec, manager: SessionManager, restored: boolean): Promise<string> {
  const args: StartArgs = { cwd: spec.cwd, sessionManager: manager, emit: instanceEnvelope, trust: undefined,
    restored };
  const model = await createModelSession(args, spec.model, (event) => spec.onModelEvent(event));
  try {
    const settings = await createSettings(spec.cwd, spec.trust);
    const entry = await createEntry(args, instanceSetup(spec, settings, manager.getSessionId()), model);
    return entry.session.sessionId;
  } catch (error) {
    console.error(`[kernel] instance ${manager.getSessionId()} did not open: ${errorText(error)}`);
    await model.dispose();
    throw error;
  }
}

/** @brief 开着的实例会话；不在或不是实例时报错。 */
function requireInstance(sessionId: string): Entry {
  const entry = requireEntry(sessionId);
  if (entry.kind === 'user') throw new Error(`${sessionId} is not an instance session`);
  return entry;
}

/** @brief 从会话文件重新打开实例会话；已经开着（或正在打开）时直接用它（§8.2、§11.6）。 */
async function openInstance(file: string, spec: InstanceSpec): Promise<string> {
  while (opening.has(file)) await opening.get(file)?.catch(() => undefined);
  const live = [...sessions.values()].find((entry) => entry.kind !== 'user' && entry.session.sessionFile === file);
  if (live) return live.session.sessionId;
  if (!existsSync(file)) throw new Error(`Session file not found: ${file}`);
  const pi = await loadPi();
  return whileOpening(file, startInstance(spec, pi.SessionManager.open(file, spec.dir), true));
}

/** @brief 关闭一个空闲的实例会话（§8.2）：释放 pi 会话与虚拟模型，文件保留；在运行或准备中时拒绝。 */
async function closeInstance(sessionId: string): Promise<void> {
  const entry = requireInstance(sessionId);
  requireIdle(entry);
  await closeEntry(entry);
}

/**
 * @brief 程序的投递（§8.2、§14.2）：准备中 → 模型层 prepare（带偏好）→ prompt(text, { expandPromptTemplates: false })。
 *        调用方保证会话空闲；不空闲、会话不在时记日志、不投递。从不拒绝。
 */
async function deliver(sessionId: string, text: string, choice?: SegmentPreference): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry || !isIdle(entry)) {
    console.error(`[kernel] delivery to ${sessionId} dropped: the session is ${entry ? 'busy' : 'not open'}`);
    return;
  }
  await startReply(entry, { text, refs: undefined, pending: null }, { program: true, choice });
}

/**
 * @brief 开始对话的一次回复（§5.3 第 4 步），与关闭模式的发送相同；before 在准备中、模型层 prepare 之前执行。
 *        对话不空闲时（调用方本该保证）照发送时的路径交给它（排在后面），记日志。从不拒绝。
 */
async function dialogStart(userSessionId: string, item: HeldItem,
  before?: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const entry = sessions.get(userSessionId);
  if (!entry) {
    console.error(`[kernel] reply in ${userSessionId} dropped: the session is not open`);
    return;
  }
  if (!isIdle(entry)) {
    console.error(`[kernel] ${userSessionId} is busy; the message is queued instead of starting a reply`);
    dispatch(entry, item, 'followUp');
    return;
  }
  const pending = item.refs?.length ? entry.refs.add(item.text, item.refs) : null;
  await startReply(entry, { text: item.text, refs: item.refs, pending }, { before });
}

/** @brief 停止一个会话的运行（实例或对话）：先记下原因（§9.4），准备中时取消准备。 */
async function abortFor(sessionId: string, reason: StopReason): Promise<void> {
  const entry = requireEntry(sessionId);
  entry.stop = reason;
  await stopRun(entry);
}

/** @brief 后台批准卡上的选择交给那个实例的批准扩展；请求已经结束时为 false。 */
function answerInstance(sessionId: string, requestId: string, decision: ApprovalDecision, reason?: string): boolean {
  const entry = sessions.get(sessionId);
  if (!entry?.gate.has(requestId)) return false;
  entry.gate.answer(requestId, decision, reason);
  return true;
}

/** @brief 在用户会话的信封上发一个事件；会话已不在时记日志。 */
function emitUser(userSessionId: string, event: KernelEvent): void {
  const entry = sessions.get(userSessionId);
  if (!entry) {
    console.error(`[kernel] ${event.type} for ${userSessionId} dropped: the session is not open`);
    return;
  }
  send(entry, event);
}

/** @brief 会话表为 Team 提供的操作（teamHost.ts）。 */
const host: TeamHost = {
  createInstance: async (spec) => startInstance(spec, newInstanceManager(await loadPi(), spec), false),
  openInstance,
  closeInstance,
  deliver,
  dialogStart,
  dialogQueue: (userSessionId, item, behavior) => dispatch(requireEntry(userSessionId), item, behavior),
  abort: abortFor,
  answerApproval: answerInstance,
  status: (sessionId) => {
    const entry = sessions.get(sessionId);
    return entry ? { running: soloRunning(entry), preparing: entry.preparing !== null, stop: entry.stop } : null;
  },
  entry: (sessionId): HostEntry | null => {
    const entry = sessions.get(sessionId);
    return entry ? { session: entry.session, model: entry.model, cwd: entry.cwd,
      sessionFile: entry.session.sessionFile ?? null } : null;
  },
  emitUser,
};

/** @brief 退出前停止并释放所有会话（含实例会话）；挂起的批准先按拒绝处理，pi 才不会卡在等待上。 */
export async function shutdownSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(async (entry) => {
    await release(entry);
    await entry.model.dispose();
  }));
}
