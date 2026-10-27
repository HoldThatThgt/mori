// 界面状态：后台进程连接状态、pi 的会话列表、已打开的会话（含各自的对话流和草稿）、信任询问、当前页面。
// 会话内容只有 pi 的会话文件一份；这里只是本次运行里界面上的副本。

import { create } from 'zustand';
import {
  DEFAULT_APPROVAL, type ApprovalState, type ConfigInfo, type ContextUsage, type ModelState, type ProjectTrust,
  type QuoteRef, type SavedSession,
} from '../../../shared/protocol';
import { emptyBoard, soloTeamState, type BoardView, type TeamState } from '../../../shared/team';
import type { MemoryNotice } from '../../../shared/memory';
import type { RewindConflict, WorkspaceStatus } from '../../../shared/workspace';
import { loadArchived } from './archive';
import { emptyTranscript, type Transcript } from './model';

/** @brief 一次"Jump to source"的请求：引用和请求序号（同一个引用再点一次也要再跳）。 */
export interface QuoteJump {
  /** 引用 */
  ref: QuoteRef;
  /** 请求序号 */
  nonce: number;
}

/** @brief 右栏显示什么（docs/v0/screens/changes.md）。 */
export type RightView =
  | { kind: 'changes' }
  | {
    kind: 'file';
    /** 文件路径：工具参数里的原文或引用里的绝对路径，由主进程相对工作目录解析 */
    path: string;
    /** 打开它的引用芯片；从路径或改动列表打开时为 null */
    jump: QuoteJump | null;
    /** 每次打开加一，同一个文件再打开时重新读取 */
    nonce: number;
  };

/**
 * @brief 再发 rewind / rewind.undo 要带的参数（冲突对话框的 Overwrite、Skip these files 用，docs/specs/file-system.md §5.6）。
 */
export type RewindRequest =
  | {
    kind: 'rewind';
    /** 回到哪条你的消息之前（条目 id） */
    entryId: string;
    /** 恢复代码 */
    code: boolean;
    /** 恢复对话 */
    conversation: boolean;
  }
  | {
    kind: 'undo';
    /** 撤销的那条 mori.rewind 的条目 id */
    undoId: string;
  };

/** @brief 冲突对话框（docs/v1/screens/fs-rewind.md "冲突"）：rewind / rewind.undo 返回的 conflicts。 */
export interface RewindConflicts {
  /** 再发的命令与参数（kind 为 undo 时说明换成 Undo 的那一句） */
  request: RewindRequest;
  /** 冲突，按路径排序，最多 200 条 */
  conflicts: RewindConflict[];
  /** 全部冲突的条数（多于列出的条数时末行 and {n} more） */
  total: number;
  /** 原样带回的 token */
  token: string;
  /** 第二次调用进行中：点的那个按钮（三个按钮不可用，它写 Restoring… / Undoing…）；没有为 null */
  pending: 'overwrite' | 'skip' | null;
}

/** @brief 一个会话的 Rewind 状态（docs/specs/file-system.md §5.10、fs-rewind.md），state/rewind.ts 改写。 */
export interface RewindUi {
  /** 进行中：rewind / rewind.undo 还没返回（对话流末尾 Rewinding… / Undoing…，发送按钮不可用）；没有为 null */
  progress: 'rewind' | 'undo' | null;
  /** 冲突对话框；没有为 null */
  conflicts: RewindConflicts | null;
  /**
   * 后台进程拒绝时对话流末尾的错误行（Couldn’t rewind: … / Couldn’t undo: …），不写进会话文件，下一次 Rewind、Undo 或
   * 发送时消失；没有为 null
   */
  error: { kind: 'rewind' | 'undo'; text: string } | null;
}

/** @brief 没有在 Rewind 的状态。 */
export const IDLE_REWIND: RewindUi = Object.freeze({ progress: null, conflicts: null, error: null });

/**
 * @brief 一个打开的会话。模型状态（ModelState 的各项：选择范围 pick、当前模型 current、拒绝启动 blocked、思考强度）
 *        取自会话信息、mori.model_state 事件与 session.setPick 的结果（docs/specs/model-providers.md §9.5）。
 */
export interface Tab extends ModelState {
  /** 界面里的标识；重新载入后 pi 会话 id 可能变化，它不变 */
  key: string;
  /** pi 会话 id；打开中为 null */
  sessionId: string | null;
  /** 工作目录 */
  cwd: string;
  /** pi 会话文件（新会话在第一条消息之前文件还不存在） */
  sessionFile: string | null;
  /** 会话名（pi 的 session_info）；没有时为 null */
  name: string | null;
  /** 从会话列表打开时列表里的第一条消息，对话流载入前用来显示会话名 */
  preview: string | null;
  /** 最后活动时间（ms）：新建、打开时列表里的时间、你发消息的时间；侧栏按它排序 */
  activity: number;
  /** 不可见时完成了一轮（"Unread"），点开后清除 */
  unseen: boolean;
  /** 后台进程意外退出时它正在生成（侧栏状态"Error"），重新打开后清除 */
  interrupted: boolean;
  /** 文件夹的信任状态 */
  projectTrust: ProjectTrust;
  /** 信任状态来自 trust.json 里记住的选择 */
  trustRemembered: boolean;
  /** 没能记住信任选择时的原文 */
  trustSaveError: string | null;
  /** 加载失败的扩展 */
  extensionErrors: string[];
  /** 上下文用量 */
  contextUsage: ContextUsage | null;
  /** 批准设置（权限与"Allowed for this session"），以后台进程返回的为准 */
  approval: ApprovalState;
  /**
   * 协作状态（平行 Agent 规格 §13.10）：会话信息、mori.team_state 与 session.setTeam 的结果；
   * 后台进程退出后保留最后知道的模式（开关照它显示、不可用，team-switch.md）
   */
  team: TeamState;
  /** 这个用户会话的 TaskBoard 视图：会话信息与 mori.board（进展摘要、右栏的说明） */
  board: BoardView;
  /** 对话流 */
  transcript: Transcript;
  /** 输入框草稿 */
  draft: string;
  /** 输入框里的引用芯片（随草稿保存） */
  draftRefs: QuoteRef[];
  /** 对话流从第几项开始显示；更早的在滚到顶部时载入 */
  startIndex: number;
  /**
   * 右栏是否打开；null 表示跟随"当前分支上有没有 changes 记录"（state/workspace.ts 的 hasTurnChanges：第一次收到
   * mori.turn_changes 的 changes 时自动打开，你手动开关过之后以你为准，docs/specs/file-system.md §5.1）
   */
  rightOpen: boolean | null;
  /** 右栏的视图 */
  rightView: RightView;
  /**
   * 等对话流处理的"Jump to source"（回复里的引用、会话引用的原会话）；itemKey 是要跳到的那一项，
   * keys 为要高亮的各项（会话引用的几轮）；没有时按引用的范围高亮
   */
  transcriptJump: (QuoteJump & { itemKey: string; keys?: string[] }) | null;
  /** 正在读取或没能加入的会话引用（输入框上方，不随草稿保存；docs/v0/screens/session-refs.md） */
  refPending: PendingRef[];
  /**
   * 增强改了东西后这个项目新建的第一个会话顶部的提示（docs/specs/memory.md §9.9、§10.6）；没有、Dismiss 或
   * 切走再回来之后为 null
   */
  memoryNotice: MemoryNotice | null;
  /**
   * 这个工作路径最近一次的 git 状态与快照状态（docs/specs/file-system.md §3.5：workspace.status 的结果与
   * mori.workspace_status 事件，较早读完的不覆盖较晚的）；还没收到过为 null（右栏上半部分 Loading…，没有 Rewind 与 +N −M）
   */
  workspace: WorkspaceStatus | null;
  /** 你点了 Refresh、workspace.status 还没返回（按钮转圈、不可点，内容保持上一次的） */
  refreshing: boolean;
  /** Rewind 与 Undo 的进行中、冲突对话框与错误行 */
  rewind: RewindUi;
  /** 打开中、可用、打开失败 */
  phase: 'opening' | 'ready' | 'failed';
  /** 打开失败或重新载入失败的原文 */
  error: string | null;
}

/** @brief 一个正在读取或没能加入的会话引用。 */
export interface PendingRef {
  /** 标识 */
  id: number;
  /** 原会话的会话文件 */
  sessionFile: string;
  /** 原会话的名字 */
  title: string;
  /** 没能加入的说明；正在读取时为 null */
  problem: string | null;
}

/** @brief 中栏显示什么：会话、设置页、工具页（M6）或记忆页（docs/specs/memory.md §10.1，替换 M7 的工作回顾）。 */
export type View = 'chat' | 'settings' | 'tools' | 'memory';

/** @brief 后台进程状态。 */
export type KernelStatus = 'connecting' | 'ready' | 'exited' | 'reloading';

/** @brief pi 会话列表的读取状态。 */
export interface SavedList {
  /** 读取中、已读到、读取失败 */
  status: 'loading' | 'ready' | 'failed';
  /** 会话，按最后活动时间从新到旧 */
  sessions: SavedSession[];
  /** 读取失败的原文 */
  error: string | null;
}

/** @brief 一个等你回答的信任询问。 */
export interface TrustPrompt {
  /** 询问 id */
  id: number;
  /** 文件夹 */
  cwd: string;
  /** 读不出已记住的选择（trust.json）时的原文 */
  readError: string | null;
}

/** @brief 整个界面的状态。 */
export interface AppState {
  /** 后台进程状态 */
  kernel: KernelStatus;
  /** 读取到的配置；读取前为 null */
  config: ConfigInfo | null;
  /** 读取配置失败的原文 */
  configError: string | null;
  /** 首次启动：启动时没有已保存的连接，测试成功并打开文件夹前一直显示首次启动页 */
  firstRun: boolean;
  /** pi 的会话列表 */
  saved: SavedList;
  /** 打开的会话 */
  tabs: Tab[];
  /** 当前会话：单栏时显示的会话，分屏时焦点所在的那一栏（docs/v0/screens/split.md） */
  activeKey: string | null;
  /** 分屏时左右两栏的会话（界面里的标识），单栏时为 null */
  split: [string, string] | null;
  /** 中栏显示会话、设置页还是工具页 */
  view: View;
  /** 等你回答的信任询问，一次显示第一个 */
  trustPrompts: TrustPrompt[];
  /** 已归档的会话文件（本机记下的，见 archive.ts） */
  archived: string[];
  /**
   * 界面重新加载后还没点开的、后台进程里的会话结束时留下的状态（按会话文件）：不可见时本轮结束为"Unread"，
   * 后台进程退出时它正在生成为"Error"；点开后清除，不跨重启保存
   */
  rowMarks: Record<string, 'unseen' | 'error'>;
}

export const useApp = create<AppState>(() => ({
  kernel: 'connecting', config: null, configError: null, firstRun: false,
  saved: { status: 'loading', sessions: [], error: null }, tabs: [], activeKey: null, split: null, view: 'chat',
  trustPrompts: [], archived: loadArchived(), rowMarks: {},
}));

let tabCounter = 0;

/** @brief 新建一个"打开中"的会话；fields 覆盖默认值（从会话列表打开时带上文件、名字、草稿等）。 */
export function newTab(cwd: string, fields: Partial<Tab> = {}): Tab {
  tabCounter += 1;
  return { key: `t${tabCounter}`, sessionId: null, cwd, sessionFile: null, name: null, preview: null,
    activity: Date.now(), unseen: false, interrupted: false, projectTrust: 'none', trustRemembered: false,
    trustSaveError: null, extensionErrors: [], pick: null, current: null, blocked: null,
    thinkingLevel: 'off', thinkingLevels: ['off'], reasoning: false, pickLocked: false, contextUsage: null,
    approval: DEFAULT_APPROVAL, team: soloTeamState(false), board: emptyBoard(), transcript: emptyTranscript, draft: '',
    draftRefs: [], startIndex: 0, rightOpen: null, rightView: { kind: 'changes' }, transcriptJump: null,
    refPending: [], memoryNotice: null, workspace: null, refreshing: false, rewind: IDLE_REWIND, phase: 'opening',
    error: null, ...fields };
}

/**
 * @brief 从会话信息、mori.model_state 事件或 session.setPick 的结果里取出模型状态的各项（不带其他字段）。
 *        旧的录制里没有的项按"没有"处理：没有范围、没有当前模型、可以发送、思考强度关、范围没有锁定。
 */
export function modelStateOf(state: Partial<ModelState>): ModelState {
  return { pick: state.pick ?? null, current: state.current ?? null, blocked: state.blocked ?? null,
    thinkingLevel: state.thinkingLevel ?? 'off', thinkingLevels: state.thinkingLevels ?? ['off'],
    reasoning: state.reasoning ?? false, pickLocked: state.pickLocked ?? false };
}

/** @brief 更新一个会话。 */
export function updateTab(key: string, fn: (tab: Tab) => Tab): void {
  useApp.setState((state) => ({ tabs: state.tabs.map((tab) => (tab.key === key ? fn(tab) : tab)) }));
}

/** @brief 按 pi 会话 id 找会话。 */
export function tabBySession(sessionId: string): Tab | undefined {
  return useApp.getState().tabs.find((tab) => tab.sessionId === sessionId);
}

/** @brief 两个会话文件路径是否相同（都来自 pi，同一个文件写法相同）。 */
export function sameFile(a: string | null, b: string | null): boolean {
  return a !== null && a === b;
}

/** @brief 按会话文件找已打开的会话。 */
export function tabByFile(sessionFile: string): Tab | undefined {
  return useApp.getState().tabs.find((tab) => sameFile(tab.sessionFile, sessionFile));
}

/** @brief 取当前会话（分屏时焦点所在的那一栏）。 */
export function activeTab(state: AppState = useApp.getState()): Tab | undefined {
  return state.tabs.find((tab) => tab.key === state.activeKey);
}

/** @brief 中栏里显示的会话（界面里的标识）：分屏时左右两栏，单栏时当前会话；不管中栏是不是设置页。 */
export function shownKeys(state: AppState = useApp.getState()): string[] {
  if (state.split) return [...state.split];
  return state.activeKey ? [state.activeKey] : [];
}

/** @brief 会话现在是否显示在中栏（在任一栏里，且中栏不是设置页）。 */
export function isShown(key: string, state: AppState = useApp.getState()): boolean {
  return state.view === 'chat' && shownKeys(state).includes(key);
}
