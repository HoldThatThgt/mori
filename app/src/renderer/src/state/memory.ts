// 记忆页的状态与命令（docs/specs/memory.md §10.1–§10.5、§10.10）：层（User / Project，Project 跟随焦点会话的项目，
// 同工具页的 followedOf）、分节、当前分节读到的内容（memory.list、memory.revisions 或 agents.get）、右栏（条目、修订、
// 新增表单）、编辑与写入的结果、增强的状态（enhance.get）、依据回到原位置的结果。
// 不监视文件、不轮询：页面打开、你操作、收到 mori.memory_changed / mori.enhance_progress（全局事件）时读。
// 页面打开、换层、换分节、换项目时清空再读；收到事件时保留上一次的内容重读（标题旁 Loading…），编辑中不重读详情。
// 后台进程退出时保留最后读到的内容；重新连上后（Project 时先等跟随的会话打开好）重读。

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { StoredFeedbackSchema, type StoredFeedback } from '../../../shared/feedback';
import type { FileRead } from '../../../shared/files';
import {
  KIND_LABEL, LAYER_LABEL, MEMORY_KINDS, type EnhanceInfo, type EnhanceProgressEvent, type EntryRef, type EntrySource,
  type MemoryChangedEvent, type MemoryGetResult, type MemoryKind, type MemoryLayer, type MemoryListResult,
  type MemoryResult, type MemoryRevisionsResult, type MemoryWriteResult, type RevisionDetail, type RevisionRow,
  type StoredEvidence,
} from '../../../shared/memory';
import type { ModelPick, ThinkingLevel } from '../../../shared/models';
import type { AgentsInfo, Command, EventEnvelope, GlobalEventEnvelope } from '../../../shared/protocol';
import { displayTitle, sessionTitle } from '../components/ChatPane';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { guardLeave, leaveAllowed, setLeaveGuard } from './leaveGuard';
import {
  isTeamSessionFile, jumpToEntry, jumpToFeedback, sessionGone, SESSION_DELETED, type JumpNote, type JumpResult,
} from './refActions';
import { focusPane } from './split';
import { sameFile, shownKeys, useApp, type AppState } from './store';

// ---- 分节与文字 ----

/** @brief 记忆页的分节（§10.1）：四种条目、AGENT、Revisions。 */
export type MemorySection = MemoryKind | 'agent' | 'revisions';

/** @brief 分节按显示顺序。 */
export const MEMORY_SECTIONS: readonly MemorySection[] = [...MEMORY_KINDS, 'agent', 'revisions'];

/** @brief 分节按钮上的文字，也用于动作记录 `Memory: <分节>`。 */
export const SECTION_LABEL: Readonly<Record<MemorySection, string>> = {
  ...KIND_LABEL, agent: 'AGENT', revisions: 'Revisions',
};

/** @brief 分节的测试标识后缀（memory-section-<…>，§10.11）。 */
export const SECTION_ID: Readonly<Record<MemorySection, string>> = {
  fact: 'facts', taste: 'taste', strategy: 'strategy', review: 'review', agent: 'agent', revisions: 'revisions',
};

/** @brief 条目来源的标记（§10.1）。 */
export const SOURCE_LABEL: Readonly<Record<EntrySource, string>> = { user: 'You said', learned: 'Learned' };

/** @brief 后台进程退出时所有操作的悬停说明（§10.10，同 Customize）。 */
const CRASHED_TEXT = 'Mori’s background process crashed. Restart it to continue.';

/** @brief 依据是 TaskBoard 实例会话时的说明（§10.2）。 */
const TEAM_SESSION_TEXT = 'This is a team task’s session, which can’t be opened.';

/** 反馈依据的文件已经不在（§10.2） */
const FEEDBACK_REMOVED = 'The feedback file was removed.';

/** @brief 分节是不是四种条目之一。 */
function isKindSection(section: MemorySection): section is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(section);
}

// ---- 状态 ----

/** @brief 右栏显示什么：没有、一条条目的详情、一次修订的详情、新增条目的表单。 */
export type MemoryPanel = { kind: 'none' } | { kind: 'entry'; id: string } | { kind: 'revision'; id: string }
  | { kind: 'new' };

/** @brief 依据回到原位置的状态：检查中，或跳不过去 / 只打开了会话的说明。 */
export type EvidenceJump = 'checking' | JumpNote;

/** @brief 右栏里正在进行的写入。 */
export type MemoryBusy = 'save' | 'delete' | 'move' | 'rollback' | null;

/** @brief 记忆页的状态（只在界面里，不跨重启保存）。 */
export interface MemoryState {
  /** 选的层；没有跟随的项目时页面显示 User（shownScope） */
  scope: MemoryLayer;
  /** 当前分节 */
  section: MemorySection;
  /** 跟随的项目（焦点会话的工作目录）；没有打开的会话或打开失败时为 null */
  cwd: string | null;
  /** 跟随的会话的 pi 会话 id（AGENT 读它加载的文件）；还在打开时为 null */
  sessionId: string | null;
  /** 跟随的会话还在打开（Project 时等它，不读） */
  waiting: boolean;
  /** 每个项目上次看的分节（换项目后回到它） */
  lastSections: Record<string, MemorySection>;
  /** 当前分节（四种条目之一）的 memory.list 结果；清空后、读到之前为 null */
  list: MemoryListResult | null;
  /** Revisions 节的列表；清空后、读到之前为 null */
  revisions: RevisionRow[] | null;
  /** AGENT 节的 agents.get 结果；清空后、读到之前为 null */
  agents: AgentsInfo | null;
  /** 当前分节正在读 */
  loading: boolean;
  /** 当前分节读取失败的原因（界面加 `Couldn’t load memory: `）；没有时为 null */
  loadError: string | null;
  /** 右栏 */
  panel: MemoryPanel;
  /** 右栏条目的 memory.get 结果；还没读到时为 null */
  entry: MemoryGetResult | null;
  /** 右栏修订的全文；还没读到时为 null */
  revision: RevisionDetail | null;
  /** 右栏读取失败的原因；没有时为 null */
  detailError: string | null;
  /** 右栏的条目换成了编辑表单 */
  editing: boolean;
  /** 正在进行的写入 */
  busy: MemoryBusy;
  /** 写入失败的整句（`Couldn’t save: …` 等），显示在详情顶部；没有时为 null */
  actionError: string | null;
  /** 本项目的增强状态（Project 时）；还没读到时为 null */
  enhance: EnhanceInfo | null;
  /** enhance.get 命令失败的原文 */
  enhanceError: string | null;
  /** `Run now` 失败的原因；下一次读到增强状态时清掉 */
  runError: string | null;
  /** 依据回到原位置的状态（键见 evidenceKey） */
  jumps: Record<string, EvidenceJump>;
}

/** @brief 记忆页的状态。 */
export const useMemory = create<MemoryState>(() => ({
  scope: 'project', section: 'fact', cwd: null, sessionId: null, waiting: false, lastSections: {}, list: null,
  revisions: null, agents: null, loading: false, loadError: null, panel: { kind: 'none' }, entry: null, revision: null,
  detailError: null, editing: false, busy: null, actionError: null, enhance: null, enhanceError: null, runError: null,
  jumps: {},
}));

/** @brief 页面显示的层：没有跟随的项目时只看 User（§10.1）。 */
export function shownScope(state: MemoryState): MemoryLayer {
  return state.cwd === null ? 'user' : state.scope;
}

/** @brief 记忆页开着、右栏有内容（App.tsx 据此打开右栏）。 */
export function useMemoryDetailOpen(): boolean {
  const onPage = useApp((state) => state.view === 'memory');
  const open = useMemory((state) => state.panel.kind !== 'none');
  return onPage && open;
}

/** @brief 记忆页里的操作不可用的原因：后台进程退出时为悬停说明，没有连上时为空串；可用时为 null。 */
export function useUnavailable(): string | null {
  return useApp((state) => {
    if (state.kernel === 'ready') return null;
    return state.kernel === 'exited' ? CRASHED_TEXT : '';
  });
}

/** @brief 当前层、分节与跟随的项目（组件取用）。 */
export function usePlace(): { scope: MemoryLayer; section: MemorySection; cwd: string | null; waiting: boolean } {
  return useMemory(useShallow((state) => ({ scope: shownScope(state), section: state.section, cwd: state.cwd,
    waiting: state.waiting })));
}

// ---- 跟随的项目（同工具页的 followedOf） ----

/** @brief 跟随的会话：焦点会话；不在界面里或打开失败时为 null。还没打开好（含后台进程重启后重新打开）时 opening 为真。 */
interface Followed {
  /** 工作目录 */
  cwd: string;
  /** pi 会话 id；没打开好时为 null */
  sessionId: string | null;
  /** 还在打开 */
  opening: boolean;
}

/** @brief 焦点会话（分屏时焦点所在的那一栏）。 */
function followedOf(app: AppState): Followed | null {
  const tab = app.tabs.find((item) => item.key === app.activeKey);
  if (!tab || tab.phase === 'failed') return null;
  const sessionId = tab.phase === 'ready' ? tab.sessionId : null;
  return { cwd: tab.cwd, sessionId, opening: sessionId === null };
}

/** 有读取因为后台进程没连上、跟随的会话还没打开好而没做：可以读时补上 */
let stale = false;
/** 每次读取的序号：只有最后一次的结果生效 */
let listGen = 0;
let detailGen = 0;
let enhanceGen = 0;
/** 编辑中你选了 Keep editing：页面留在原来的项目，表单关掉后再跟随 */
let pinned = false;
/** 正在问要不要离开编辑（换了跟随的项目） */
let asking = false;
/** 从 View in Memory 来时要落到的位置；进入页面时取走 */
let arrival: { scope: MemoryLayer; section: MemorySection; panel: MemoryPanel } | null = null;

/** @brief 现在能读：记忆页开着、后台进程连上、Project 时跟随的会话已经打开好。 */
function canRead(): boolean {
  const app = useApp.getState();
  const state = useMemory.getState();
  return app.view === 'memory' && app.kernel === 'ready' && !(shownScope(state) === 'project' && state.waiting);
}

/** @brief 换了右栏内容：清掉上一项读到的详情与写入结果，还没回来的详情读取不再生效。 */
function panelPatch(panel: MemoryPanel): Partial<MemoryState> {
  detailGen += 1;
  return { panel, entry: null, revision: null, detailError: null, editing: false, actionError: null };
}

/**
 * @brief 进入记忆页：落到 View in Memory 给的位置，或保持上次的层与分节（换了项目时回到那个项目上次看的分节）；
 *        项目没变时上次打开的条目或修订重新读出来（例如 Jump to source 之后回来，看得到它的结果）。
 */
function enterPage(app: AppState): void {
  const now = followedOf(app);
  const state = useMemory.getState();
  const cwd = now?.cwd ?? null;
  const remembered = cwd !== null && cwd !== state.cwd ? state.lastSections[cwd] : undefined;
  const kept: MemoryPanel = cwd === state.cwd && state.panel.kind !== 'new' ? state.panel : { kind: 'none' };
  const place = arrival ?? { scope: state.scope, section: remembered ?? state.section, panel: kept };
  arrival = null;
  pinned = false;
  useMemory.setState({ ...panelPatch(place.panel), scope: place.scope, section: place.section, cwd,
    sessionId: now?.sessionId ?? null, waiting: now?.opening ?? false, enhance: null, enhanceError: null,
    runError: null, busy: null });
  rememberSection();
  load(false);
  void loadEnhance();
}

/** @brief 换到另一个项目（焦点换了）：清空并读，回到那个项目上次看的分节。 */
function applyProject(now: Followed | null): void {
  const state = useMemory.getState();
  const cwd = now?.cwd ?? null;
  const section = (cwd !== null ? state.lastSections[cwd] : undefined) ?? state.section;
  useMemory.setState({ ...panelPatch({ kind: 'none' }), cwd, section, sessionId: now?.sessionId ?? null,
    waiting: now?.opening ?? false, enhance: null, enhanceError: null, runError: null });
  rememberSection();
  load(false);
  void loadEnhance();
}

/** @brief 跟随的项目变了：有未保存的编辑时先问；你选 Keep editing 时留在原来的项目，表单关掉后再跟随。 */
async function changeProject(): Promise<void> {
  asking = true;
  const allowed = await leaveAllowed();
  asking = false;
  if (!allowed) {
    pinned = true;
    return;
  }
  if (useApp.getState().view === 'memory') applyProject(followedOf(useApp.getState()));
}

/** @brief 记忆页开着时界面状态变了：跟随的项目、会话打开好了、后台进程重新连上。 */
function followUpdate(app: AppState): void {
  const now = followedOf(app);
  const state = useMemory.getState();
  if ((now?.cwd ?? null) !== state.cwd) {
    if (!pinned && !asking) void changeProject();
    return;
  }
  const sessionId = now?.sessionId ?? null;
  const waiting = now?.opening ?? false;
  if (sessionId === state.sessionId && waiting === state.waiting) return;
  useMemory.setState({ sessionId, waiting });
  if (!waiting && state.section === 'agent' && shownScope(state) === 'project') stale = true;
}

useApp.subscribe((app, previous) => {
  if (app.view !== 'memory') return;
  if (previous.view !== 'memory') {
    enterPage(app);
    return;
  }
  if (app.kernel !== 'ready' && previous.kernel === 'ready') stale = true;
  followUpdate(app);
  if (stale && canRead()) {
    load(true);
    void loadEnhance();
  }
});

/** @brief 表单关掉之后：之前因为编辑留在原来的项目时，现在跟随焦点会话的项目。 */
function resyncFollow(): void {
  if (!pinned) return;
  pinned = false;
  if (useApp.getState().view === 'memory') followUpdate(useApp.getState());
}

/** @brief 记下这个项目现在看的分节。 */
function rememberSection(): void {
  const { cwd, section, lastSections } = useMemory.getState();
  if (cwd !== null && lastSections[cwd] !== section) {
    useMemory.setState({ lastSections: { ...lastSections, [cwd]: section } });
  }
}

// ---- 读取 ----

/** @brief 列表类命令的 cwd：User 时只看用户级（null），Project 时为跟随的项目。 */
function listCwd(state: MemoryState): string | null {
  return shownScope(state) === 'user' ? null : state.cwd;
}

/** @brief 结果里的失败原因（后台进程返回的 error）：不为 null 时记错误日志；原样返回。 */
function reported(what: string, error: string | null): string | null {
  if (error !== null) console.error(`[renderer] ${what}: ${error}`);
  return error;
}

/** @brief 读当前分节的内容，返回要写进状态的部分。 */
async function readSection(state: MemoryState): Promise<Partial<MemoryState>> {
  const layer = shownScope(state);
  const { section } = state;
  if (section === 'agent') {
    const sessionId = layer === 'project' ? state.sessionId : null;
    const agents = await request<AgentsInfo>(sessionId ? { type: 'agents.get', sessionId } : { type: 'agents.get' });
    return { agents, loadError: null };
  }
  if (section === 'revisions') {
    const result = await request<MemoryRevisionsResult>({ type: 'memory.revisions', cwd: listCwd(state), layer });
    return { revisions: 'revisions' in result ? result.revisions : [],
      loadError: reported('memory.revisions', result.error) };
  }
  const list = await request<MemoryListResult>({ type: 'memory.list', cwd: listCwd(state), layer, kind: section });
  return { list, loadError: reported('memory.list', list.error) };
}

/** @brief 后台进程还连着（命令失败是不是因为它退出了：退出时页面保留最后读到的内容，§10.10）。 */
function kernelReady(): boolean {
  return useApp.getState().kernel === 'ready';
}

/**
 * @brief 读当前分节；失败时记下原因（已有的内容留着）。后台进程退出导致的失败（记错误日志）不记原因、
 *        保留最后读到的内容与原来的原因，重新连上后重读（§10.10）。
 */
async function loadSection(): Promise<void> {
  const generation = ++listGen;
  const state = useMemory.getState();
  useMemory.setState({ loading: true });
  try {
    const patch = await readSection(state);
    if (generation === listGen) useMemory.setState({ ...patch, loading: false });
  } catch (error) {
    const command = state.section === 'agent' ? 'agents.get' : state.section === 'revisions' ? 'memory.revisions'
      : 'memory.list';
    const reason = describe(command, error);
    if (generation !== listGen) return;
    useMemory.setState(kernelReady() ? { loading: false, loadError: reason } : { loading: false });
  }
}

/**
 * @brief 右栏的条目或修订已经不在（读到 null、删除或移走之后）：关闭详情，焦点回到列表。
 * @param gone 已经不在的那一行的 id（列表重读之前它还在，焦点不落到它上面）
 */
function detailGone(gone: string | null = null): void {
  useMemory.setState(panelPatch({ kind: 'none' }));
  requestAnimationFrame(() => {
    const list = document.querySelector<HTMLElement>('.memory-rows');
    const rows = [...(list?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    (rows.find((row) => row.dataset.id !== gone)
      ?? document.querySelector<HTMLElement>('[data-testid="memory-new"]'))?.focus();
  });
}

/**
 * @brief 读右栏的条目（memory.get）或修订（memory.revisions 带 id）；编辑中不读。后台进程退出导致的失败
 *        （记错误日志）保留最后读到的详情（§10.10）。
 */
async function loadDetail(): Promise<void> {
  const state = useMemory.getState();
  const { panel } = state;
  if ((panel.kind !== 'entry' && panel.kind !== 'revision') || state.editing) return;
  const generation = ++detailGen;
  const layer = shownScope(state);
  try {
    if (panel.kind === 'entry') {
      const result = await request<MemoryGetResult>({ type: 'memory.get', cwd: state.cwd, layer, id: panel.id });
      if (generation !== detailGen) return;
      if (reported('memory.get', result.error)) useMemory.setState({ detailError: result.error });
      else if (!result.entry) detailGone();
      else useMemory.setState({ entry: result, detailError: null });
      return;
    }
    const result = await request<MemoryRevisionsResult>({ type: 'memory.revisions', cwd: listCwd(state), layer,
      id: panel.id });
    if (generation !== detailGen) return;
    const revision = 'revision' in result ? result.revision : null;
    if (reported('memory.revisions', result.error)) useMemory.setState({ detailError: result.error });
    else if (!revision) detailGone();
    else useMemory.setState({ revision, detailError: null });
  } catch (error) {
    const reason = describe(`memory detail ${panel.kind}`, error);
    if (generation === detailGen && kernelReady()) useMemory.setState({ detailError: reason });
  }
}

/**
 * @brief 读当前分节与右栏。keep 为假时先清空（页面打开、换层、换分节、换项目：不显示别的地方的结果）；
 *        为真时保留上一次的内容、选中与滚动位置（收到事件、你操作之后、重新连上）。现在不能读时记下，能读时补上。
 */
function load(keep: boolean): void {
  if (!keep) {
    listGen += 1;
    useMemory.setState({ list: null, revisions: null, agents: null, loadError: null, loading: false });
  }
  if (!canRead()) {
    stale = true;
    return;
  }
  stale = false;
  void loadSection();
  void loadDetail();
}

/**
 * @brief 读本项目的增强状态（Project 时）。后台进程退出导致的失败（记错误日志）保留最后读到的状态行
 *        （memory-enhance.md）。
 */
async function loadEnhance(): Promise<void> {
  const state = useMemory.getState();
  if (shownScope(state) !== 'project' || state.cwd === null || !canRead()) return;
  const generation = ++enhanceGen;
  try {
    const enhance = await request<EnhanceInfo>({ type: 'enhance.get', cwd: state.cwd });
    reported('enhance.get', enhance.error);
    if (generation === enhanceGen) useMemory.setState({ enhance, enhanceError: null, runError: null });
  } catch (error) {
    const reason = describe('enhance.get', error);
    if (generation === enhanceGen && kernelReady()) useMemory.setState({ enhanceError: reason });
  }
}

// ---- 全局事件 ----

/** @brief 记忆写入之后（§10.1 数据）：这一层的写入改到当前分节时重读（保留内容）；AGENT 节不受影响。 */
function memoryChanged(event: MemoryChangedEvent): void {
  if (useApp.getState().view !== 'memory') return;
  const state = useMemory.getState();
  const layer = shownScope(state);
  const touches = (target: MemoryLayer) => event.layers.includes(target)
    && (target === 'user' || event.cwd === state.cwd);
  if (state.section === 'agent') return;
  if (state.section === 'revisions') {
    if (touches(layer)) load(true);
    return;
  }
  // Project 的用量含用户级，用户级的写入也要重读。
  if (event.kinds.includes(state.section) && (touches(layer) || (layer === 'project' && touches('user')))) {
    load(true);
  }
}

/** @brief 增强进度（§10.4）：记忆页开着、在看同一个项目时重读增强状态。 */
function enhanceProgress(event: EnhanceProgressEvent): void {
  const state = useMemory.getState();
  if (useApp.getState().view !== 'memory' || shownScope(state) !== 'project' || event.cwd !== state.cwd) return;
  void loadEnhance();
}

/** @brief 全局事件（信封的 sessionId 为 null）。 */
function onGlobalEvent(envelope: EventEnvelope | GlobalEventEnvelope): void {
  if (envelope.sessionId !== null) return;
  const { event } = envelope;
  if (event.type === 'mori.memory_changed') memoryChanged(event);
  else if (event.type === 'mori.enhance_progress') enhanceProgress(event);
}

window.mori.onEvent(onGlobalEvent);

// ---- 导航 ----

/** @brief 打开记忆页（左栏 Memory）；有未保存的编辑时先问。 */
export function openMemory(): void {
  if (useApp.getState().view === 'memory') return;
  guardLeave(() => {
    recordAction('Open Memory');
    useApp.setState({ view: 'memory' });
  });
}

/** @brief View in Memory 的落点（工具卡、新会话提示）。 */
export interface MemoryTarget {
  /** 条目或修订所在的项目；用户级为 null */
  cwd: string | null;
  /** 层 */
  layer: MemoryLayer;
  /** 种类（打开到那一节） */
  kind?: MemoryKind;
  /** 条目 id（选中那一条） */
  entry?: string;
  /** 修订 id（切到 Revisions 选中那一次；有它时不看 entry） */
  revision?: string;
}

/** @brief 落点的项目不是焦点会话的项目时，焦点换到中栏里那个项目的一栏（分屏时）。 */
function focusProject(cwd: string | null): void {
  const app = useApp.getState();
  const active = app.tabs.find((tab) => tab.key === app.activeKey);
  if (cwd === null || active?.cwd === cwd) return;
  const key = shownKeys(app).find((item) => app.tabs.find((tab) => tab.key === item)?.cwd === cwd);
  if (key) focusPane(key);
}

/**
 * @brief 打开记忆页，切到那一层那一种并选中那一条，或切到 Revisions 选中那一次修订（§7.5 View in Memory、§10.6 View）。
 *        动作 `View in Memory` 由按钮所在的一方记；有未保存的编辑时先问。
 */
export function openMemoryAt(target: MemoryTarget): void {
  guardLeave(() => {
    focusProject(target.cwd);
    const section: MemorySection = target.revision ? 'revisions' : target.kind ?? useMemory.getState().section;
    const panel: MemoryPanel = target.revision ? { kind: 'revision', id: target.revision }
      : target.entry ? { kind: 'entry', id: target.entry } : { kind: 'none' };
    if (useApp.getState().view !== 'memory') {
      arrival = { scope: target.layer, section, panel };
      useApp.setState({ view: 'memory' });
      return;
    }
    navigate(target.layer, section, panel);
  });
}

/**
 * @brief 在页面里换到另一个位置（层、分节、右栏）：分节或层变了时清空再读，否则只读右栏。换了层时增强状态也清空，
 *        回到 Project 时读到之前状态行留空（memory-enhance.md 的读取中）。
 */
function navigate(scope: MemoryLayer, section: MemorySection, panel: MemoryPanel): void {
  const state = useMemory.getState();
  const rescoped = shownScope(state) !== scope;
  const moved = rescoped || state.section !== section;
  const enhanceReset = rescoped ? { enhance: null, enhanceError: null, runError: null } : {};
  useMemory.setState({ ...panelPatch(panel), scope, section, ...enhanceReset });
  rememberSection();
  if (moved) load(false);
  else if (canRead()) void loadDetail();
  else stale = true;
  if (rescoped) void loadEnhance();
}

/** @brief 换层（分段按钮）；有未保存的编辑时先问。 */
export function chooseScope(scope: MemoryLayer): void {
  if (shownScope(useMemory.getState()) === scope) return;
  guardLeave(() => {
    recordAction(`Memory: ${LAYER_LABEL[scope]}`);
    navigate(scope, useMemory.getState().section, { kind: 'none' });
  });
}

/** @brief 换分节；有未保存的编辑时先问。 */
export function chooseSection(section: MemorySection): void {
  const state = useMemory.getState();
  if (state.section === section) return;
  guardLeave(() => {
    recordAction(`Memory: ${SECTION_LABEL[section]}`);
    navigate(shownScope(useMemory.getState()), section, { kind: 'none' });
  });
}

/** @brief 选中列表里的一条条目（右栏打开详情；读取失败后再选一次时重读）；有未保存的编辑时先问。 */
export function selectEntry(id: string): void {
  const { panel, editing, detailError } = useMemory.getState();
  if (panel.kind === 'entry' && panel.id === id && !editing && !detailError) return;
  guardLeave(() => {
    const state = useMemory.getState();
    navigate(shownScope(state), state.section, { kind: 'entry', id });
  });
}

/** @brief 选中 Revisions 里的一次修订；不在 Revisions 节时切过去（History、Last change 的链接）。 */
export function selectRevision(id: string): void {
  const { panel, section, detailError } = useMemory.getState();
  if (section === 'revisions' && panel.kind === 'revision' && panel.id === id && !detailError) return;
  guardLeave(() => navigate(shownScope(useMemory.getState()), 'revisions', { kind: 'revision', id }));
}

/** @brief 打开另一条条目（详情里的 [[slug]]、Linked from）：切到它的层和种类并选中；有未保存的编辑时先问。 */
export function openEntryRef(ref: EntryRef): void {
  guardLeave(() => navigate(ref.layer, ref.kind, { kind: 'entry', id: ref.id }));
}

/** @brief New entry：右栏打开空的表单（种类按当前分节、层按当前的 User / Project）。 */
export function openNewEntry(): void {
  if (useMemory.getState().panel.kind === 'new') return;
  guardLeave(() => useMemory.setState(panelPatch({ kind: 'new' })));
}

/** @brief 关闭右栏（Close details）；有未保存的编辑时先问。焦点回到列表里的那一行。 */
export function closePanel(): void {
  guardLeave(() => {
    const { panel } = useMemory.getState();
    useMemory.setState(panelPatch({ kind: 'none' }));
    const id = panel.kind === 'entry' || panel.kind === 'revision' ? panel.id : null;
    requestAnimationFrame(() => {
      const row = id ? document.querySelector<HTMLElement>(`[data-testid$="-row"][data-id="${CSS.escape(id)}"]`) : null;
      (row ?? document.querySelector<HTMLElement>('[data-testid="memory-new"]'))?.focus();
    });
  });
}

/** @brief Edit：详情换成表单。 */
export function startEdit(): void {
  useMemory.setState({ editing: true, actionError: null });
}

/**
 * @brief 表单关掉了（保存成功、Cancel、离开确认框的 Discard）：先取消它登记的离开检查（表单要到下一次渲染才卸下，
 *        跟随焦点会话的项目时不能再为它问一次），再按需要跟随焦点会话的项目。
 */
function formClosed(): void {
  setLeaveGuard(null);
  resyncFollow();
}

/** @brief 关掉表单（Cancel、离开确认框的 Discard）：编辑回到详情，新增关闭右栏；之后按需要跟随焦点会话的项目。 */
export function closeForm(): void {
  const { panel } = useMemory.getState();
  if (panel.kind === 'new') useMemory.setState(panelPatch({ kind: 'none' }));
  else useMemory.setState({ editing: false, actionError: null });
  formClosed();
  if (canRead()) void loadDetail();
}

// ---- 写入 ----

/** @brief 发一条写入命令；命令本身出错时把原文当作 error。失败都记错误日志。 */
async function write<T extends MemoryResult>(command: Command): Promise<T> {
  try {
    const result = await request<T>(command);
    reported(command.type, result.error);
    return result;
  } catch (error) {
    return { error: describe(command.type, error) } as T;
  }
}

/** @brief 写入之后（你操作）：重读当前分节与右栏。 */
function afterWrite(): void {
  load(true);
}

/**
 * @brief 写入返回时右栏已经换了内容（写入期间你选了别的行）：只重读，不再改右栏、不显示这次的结果。
 * @param panel 发出写入时的右栏
 * @return 已经换了时为 true
 */
function panelMoved(panel: MemoryPanel): boolean {
  if (useMemory.getState().panel === panel) return false;
  useMemory.setState({ busy: null });
  afterWrite();
  return true;
}

/**
 * @brief 保存表单（memory.save：新增没有 id，修改带 id）。成功后回到详情、选中这一条；失败时 `Couldn’t save: <原因>`，
 *        表单和文字保留。
 * @return 成功时为 true
 */
export async function saveEntry(abstract: string, detail: string): Promise<boolean> {
  const state = useMemory.getState();
  const { panel, section } = state;
  if (!isKindSection(section) || (panel.kind !== 'new' && panel.kind !== 'entry')) return false;
  useMemory.setState({ busy: 'save', actionError: null });
  const id = panel.kind === 'entry' ? panel.id : undefined;
  const result = await write<MemoryWriteResult>({ type: 'memory.save', cwd: listCwd(state), layer: shownScope(state),
    kind: section, ...(id ? { id } : {}), abstract, detail });
  if (panelMoved(panel)) return result.error === null;
  if (result.error !== null) {
    useMemory.setState({ busy: null, actionError: `Couldn’t save: ${result.error}` });
    return false;
  }
  useMemory.setState({ busy: null, ...panelPatch({ kind: 'entry', id: result.id ?? id ?? '' }) });
  formClosed();
  afterWrite();
  return true;
}

/** @brief 删除右栏的条目（确认框的 Delete）；失败时在详情顶部 `Couldn’t delete: <原因>`。 */
export async function deleteEntry(): Promise<void> {
  const state = useMemory.getState();
  if (state.panel.kind !== 'entry') return;
  useMemory.setState({ busy: 'delete', actionError: null });
  const result = await write<MemoryWriteResult>({ type: 'memory.delete', cwd: listCwd(state),
    layer: shownScope(state), id: state.panel.id });
  if (panelMoved(state.panel)) return;
  if (result.error !== null) {
    useMemory.setState({ busy: null, actionError: `Couldn’t delete: ${result.error}` });
    return;
  }
  useMemory.setState({ busy: null });
  detailGone(state.panel.id);
  afterWrite();
}

/** @brief Move to user level / Move to this project；失败时在详情顶部 `Couldn’t move: <原因>`。 */
export async function moveEntry(): Promise<void> {
  const state = useMemory.getState();
  if (state.panel.kind !== 'entry') return;
  useMemory.setState({ busy: 'move', actionError: null });
  const result = await write<MemoryWriteResult>({ type: 'memory.move', cwd: state.cwd, from: shownScope(state),
    id: state.panel.id });
  if (panelMoved(state.panel)) return;
  if (result.error !== null) {
    useMemory.setState({ busy: null, actionError: `Couldn’t move: ${result.error}` });
    return;
  }
  // 条目已经不在这一层：关闭详情，列表重读。
  useMemory.setState({ busy: null });
  detailGone(state.panel.id);
  afterWrite();
}

/** @brief Roll back this revision（一键，不确认）；失败时 `Couldn’t roll back: <原因>`。 */
export async function rollbackRevision(): Promise<void> {
  const state = useMemory.getState();
  if (state.panel.kind !== 'revision') return;
  useMemory.setState({ busy: 'rollback', actionError: null });
  const result = await write<MemoryWriteResult>({ type: 'memory.rollback', cwd: state.cwd, layer: shownScope(state),
    id: state.panel.id });
  if (panelMoved(state.panel)) return;
  useMemory.setState({ busy: null, actionError: result.error === null ? null : `Couldn’t roll back: ${result.error}` });
  if (result.error === null) afterWrite();
}

// ---- [[slug]] 链接 ----

/** @brief 详情正文里 [[slug]] 指向的条目：同层先找，找不到再找另一层（§3.2）；都没有时为 null。 */
export async function resolveLink(slug: string, layer: MemoryLayer, cwd: string | null): Promise<EntryRef | null> {
  const layers: MemoryLayer[] = layer === 'project' ? ['project', 'user'] : cwd ? ['user', 'project'] : ['user'];
  for (const target of layers) {
    try {
      const result = await request<MemoryGetResult>({ type: 'memory.get', cwd, layer: target, id: slug });
      const found = result.entry;
      if (found) return { layer: target, kind: found.kind, id: found.id, abstract: found.abstract };
    } catch (error) {
      describe('memory.get (link)', error);
    }
  }
  return null;
}

// ---- 依据（§10.1 Evidence、§10.2） ----

/** @brief 一项依据的键：条目所在的层与 id、依据的序号。 */
export function evidenceKey(layer: MemoryLayer, id: string, index: number): string {
  return `${layer}/${id}/${index}`;
}

/** @brief 依据里会话的名字：先按会话文件在侧栏找到它、用现在的名字；找不到时为 undefined（用存下的 title）。 */
export function evidenceTitle(app: AppState, evidence: StoredEvidence): string | undefined {
  const file = evidence.session;
  if (!file) return undefined;
  const tab = app.tabs.find((item) => sameFile(item.sessionFile, file));
  if (tab) return sessionTitle(tab);
  const saved = app.saved.sessions.find((item) => sameFile(item.sessionFile, file));
  return saved ? displayTitle(saved.name, saved.firstMessage) : undefined;
}

/** @brief 点之前就知道跳不过去的说明：TaskBoard 实例会话、会话已删除；可以点时为 null。 */
export function fixedJumpStatus(app: AppState, evidence: StoredEvidence): string | null {
  if (!evidence.session) return null;
  if (isTeamSessionFile(evidence.session, app.config?.agentDir ?? '')) return TEAM_SESSION_TEXT;
  return sessionGone(app, evidence.session) ? SESSION_DELETED : null;
}

/** @brief 记下或清掉一项依据的跳转状态。 */
function setJump(key: string, jump: EvidenceJump | null): void {
  useMemory.setState((state) => {
    const { [key]: _old, ...rest } = state.jumps;
    return { jumps: jump ? { ...rest, [key]: jump } : rest };
  });
}

/** @brief 读到的反馈文件（文件还在）里的反馈记录；读不出或不合格式时为带文件路径的原因（记错误日志）。 */
function feedbackOf(read: Exclude<FileRead, { status: 'missing' }>): StoredFeedback | string {
  let reason: string;
  if (read.status !== 'ok') reason = read.status === 'error' ? read.message : read.status;
  else {
    try {
      const parsed = StoredFeedbackSchema.safeParse(JSON.parse(read.text));
      if (parsed.success) return parsed.data;
      reason = parsed.error.issues[0]?.message ?? 'Not a feedback record';
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  console.error(`[renderer] cannot read feedback ${read.path}: ${reason}`);
  return `${read.path}: ${reason}`;
}

/** @brief 读反馈文件（<userData>/feedback/<name>，agentDir 是 <userData>/pi）并跳到它的来源。 */
async function feedbackJump(name: string, stillHere: () => boolean): Promise<JumpResult> {
  const agentDir = useApp.getState().config?.agentDir ?? '';
  const file = name.split(/[\\/]/).pop() ?? name;
  try {
    const read = await window.mori.readFile(`../feedback/${file}`, agentDir);
    if (!stillHere()) return 'cancelled';
    if (read.status === 'missing') return { tone: 'warn', text: FEEDBACK_REMOVED };
    const feedback = feedbackOf(read);
    if (typeof feedback === 'string') return { tone: 'error', text: feedback };
    return await jumpToFeedback(feedback, stillHere);
  } catch (error) {
    return stillHere() ? { tone: 'error', text: describe('feedback jump', error) } : 'cancelled';
  }
}

/** 点 Jump to source 的次数：检查期间你又点了别的 Jump to source 时，先点的那次检查完不再打开会话 */
let jumpSeq = 0;

/** @brief 依据的跳转（已经确认可以离开）：检查中显示 Opening…；离开了记忆页时取消、不显示状态。 */
async function runJump(key: string, evidence: StoredEvidence): Promise<void> {
  recordAction('Jump to source from Memory');
  const seq = ++jumpSeq;
  const stillHere = () => seq === jumpSeq && useApp.getState().view === 'memory';
  setJump(key, 'checking');
  let result: JumpResult = null;
  if (evidence.feedback !== undefined) result = await feedbackJump(evidence.feedback, stillHere);
  else if (evidence.session) {
    result = await jumpToEntry(evidence.session, evidence.entry ?? null, evidence.quote ?? '', stillHere);
  }
  setJump(key, result === 'cancelled' ? null : result);
}

/** @brief Jump to source（§10.2）：上一次的状态清掉；有未保存的编辑时先问。 */
export function jumpToEvidence(key: string, evidence: StoredEvidence): void {
  guardLeave(() => void runJump(key, evidence));
}

// ---- 增强（§10.4） ----

/**
 * @brief 发 enhance.set（开关、设置对话框的 Save），返回失败的原因。页面已经跟随了别的项目时丢掉结果（那个项目自己的
 *        读取会填上）；否则结果里的 info（失败时是没改的状态，开关据此回到 info.enabled）在其间没有更新的 enhance.get
 *        时生效。其间发过 enhance.get（它可能在设置写进之前就读了）或命令本身失败、没有 info 时，返回后再读一次。
 *        发出时作废了的读取由 info 或这次重读代替。
 */
async function sendEnhanceSet(command: Extract<Command, { type: 'enhance.set' }>): Promise<string | null> {
  const generation = ++enhanceGen;
  const result = await write<MemoryResult & { info?: EnhanceInfo }>(command);
  if (useMemory.getState().cwd !== command.cwd) return result.error;
  if (generation === enhanceGen && result.info) useMemory.setState({ enhance: result.info, enhanceError: null });
  else void loadEnhance();
  return result.error;
}

/** @brief 开关增强（enhance.set 只带 enabled）；返回失败的原因，成功时为 null。 */
export async function setEnhanceEnabled(enabled: boolean): Promise<string | null> {
  const { cwd } = useMemory.getState();
  if (cwd === null) return null;
  return sendEnhanceSet({ type: 'enhance.set', cwd, enabled });
}

/**
 * @brief Run now（enhance.run）；失败时状态行显示 `Couldn’t run enhancement: <原因>`（页面还看着发出时的项目时）。
 *        返回时命令已经有了结果。
 */
export async function runEnhanceNow(): Promise<void> {
  const { cwd } = useMemory.getState();
  if (cwd === null) return;
  const result = await write<MemoryResult>({ type: 'enhance.run', cwd });
  if (result.error === null) void loadEnhance();
  else if (useMemory.getState().cwd === cwd) useMemory.setState({ runError: result.error });
}

/** @brief 增强设置对话框保存的四项。 */
export interface EnhanceSettings {
  /** 选择范围；下拉里没有选中项时不带（保留已存的值） */
  pick?: ModelPick;
  /** 思考强度 */
  thinking: ThinkingLevel;
  /** 协作模式 */
  team: boolean;
  /** 每天的时刻 HH:MM */
  time: string;
}

/** @brief 保存增强设置（对话框的 Save）；返回失败的原因，成功时为 null。 */
export async function saveEnhanceSettings(settings: EnhanceSettings): Promise<string | null> {
  const { cwd } = useMemory.getState();
  if (cwd === null) return null;
  return sendEnhanceSet({ type: 'enhance.set', cwd, ...settings });
}
