// 界面状态：后台进程连接状态、已打开的会话（含各自的对话流和草稿）、当前页面。
// 会话内容只有 pi 的会话文件一份；这里只是本次运行里界面上的副本。

import { create } from 'zustand';
import { DEFAULT_APPROVAL, type ApprovalState, type ConfigInfo, type ContextUsage } from '../../../shared/protocol';
import { emptyTranscript, type Transcript } from './model';

/** @brief 一个打开的会话。 */
export interface Tab {
  /** 界面里的标识；重新载入后 pi 会话 id 可能变化，它不变 */
  key: string;
  /** pi 会话 id；打开中为 null */
  sessionId: string | null;
  /** 工作目录 */
  cwd: string;
  /** pi 会话文件 */
  sessionFile: string | null;
  /** 模型（provider/id） */
  model: string | null;
  /** pi 选不到默认模型时的说明 */
  modelNotice: string | null;
  /** 上下文用量 */
  contextUsage: ContextUsage | null;
  /** 批准设置（权限与"本会话已允许"），以后台进程返回的为准 */
  approval: ApprovalState;
  /** 对话流 */
  transcript: Transcript;
  /** 输入框草稿 */
  draft: string;
  /** 对话流从第几项开始显示；更早的在滚到顶部时载入 */
  startIndex: number;
  /** 右栏是否打开；null 表示跟随"有没有改动" */
  rightOpen: boolean | null;
  /** 打开中、可用、打开失败 */
  phase: 'opening' | 'ready' | 'failed';
  /** 打开失败或重新载入失败的原文 */
  error: string | null;
}

/** @brief 后台进程状态。 */
export type KernelStatus = 'connecting' | 'ready' | 'exited' | 'reloading';

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
  /** 打开的会话 */
  tabs: Tab[];
  /** 当前会话 */
  activeKey: string | null;
  /** 中栏显示会话还是设置页 */
  view: 'chat' | 'settings';
  /** 每次"去设置"加一，设置页据此把焦点放到 API key */
  settingsFocus: number;
}

export const useApp = create<AppState>(() => ({
  kernel: 'connecting', config: null, configError: null, firstRun: false, tabs: [], activeKey: null, view: 'chat',
  settingsFocus: 0,
}));

let tabCounter = 0;

/** @brief 新建一个"打开中"的会话。 */
export function newTab(cwd: string): Tab {
  tabCounter += 1;
  return { key: `t${tabCounter}`, sessionId: null, cwd, sessionFile: null, model: null, modelNotice: null,
    contextUsage: null, approval: DEFAULT_APPROVAL, transcript: emptyTranscript, draft: '', startIndex: 0,
    rightOpen: null, phase: 'opening', error: null };
}

/** @brief 更新一个会话。 */
export function updateTab(key: string, fn: (tab: Tab) => Tab): void {
  useApp.setState((state) => ({ tabs: state.tabs.map((tab) => (tab.key === key ? fn(tab) : tab)) }));
}

/** @brief 按 pi 会话 id 找会话。 */
export function tabBySession(sessionId: string): Tab | undefined {
  return useApp.getState().tabs.find((tab) => tab.sessionId === sessionId);
}

/** @brief 取当前会话。 */
export function activeTab(state: AppState = useApp.getState()): Tab | undefined {
  return state.tabs.find((tab) => tab.key === state.activeKey);
}
