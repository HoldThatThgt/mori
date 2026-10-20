// F8 报告界面问题（方案 5.15，状态表见 docs/v0/screens/f8.md）：先截下当前窗口，截完才显示报告框，
// 所以截图里没有报告框本身。保存在本机（主进程写文件），不经过后台进程和 pi，也不发给模型。

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { IssueAction, IssueField, WindowCapture } from '../../../shared/issues';
import { describe } from '../state/bridge';
import { recentActions, recordAction } from '../state/actionLog';
import { useLayout } from '../state/layout';
import { useOverlay } from '../state/overlays';
import { activeTab, useApp, type AppState, type KernelStatus } from '../state/store';
import { Icon } from '../icons';
import { sessionTitle } from './ChatPane';
import { stageText } from './StageLine';

/** @brief 报告框的状态。 */
interface IssueState {
  /** 关闭；截图中（什么都不显示，免得截进图里）；打开 */
  phase: 'closed' | 'capturing' | 'open';
  /** 截图结果；截图完成前为 null */
  capture: WindowCapture | null;
  /** 按 F8 那一刻的"当前界面" */
  view: IssueField[];
  /** 按 F8 那一刻的最近操作，从早到晚 */
  actions: IssueAction[];
  /** 每次要把焦点放回报告框第一个输入框时加一 */
  focusRequest: number;
  /** 保存中（主进程还在写文件）：这时 Esc 和"取消"都不关闭报告框，等保存有结果 */
  saving: boolean;
}

const useIssue = create<IssueState>(() => ({
  phase: 'closed', capture: null, view: [], actions: [], focusRequest: 0, saving: false,
}));

/** 打开报告框前焦点所在的元素，关闭后回到这里 */
let returnFocus: HTMLElement | null = null;

const KERNEL_TEXT: Record<KernelStatus, string> = {
  connecting: '启动中', ready: '正常', exited: '已退出', reloading: '正在重新载入',
};

/** @brief 主进程报错的原文：去掉 Electron 加在前面的 "Error invoking remote method …"。 */
function mainError(what: string, error: unknown): string {
  return describe(what, error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

/** @brief 当前显示的页面。 */
function pageName(state: AppState): string {
  if (state.configError) return '读取连接失败';
  if (!state.config) return '正在读取连接';
  if (state.firstRun) return '首次启动';
  if (state.view === 'settings') return '设置';
  return state.view === 'tools' ? '工具' : '会话';
}

/** @brief 一栏的实际宽度；与保存的宽度不同（被收紧或收起）时一并写出。 */
function columnWidth(testId: string, saved: number): string {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) return `不显示（保存的宽度 ${saved}px）`;
  const actual = Math.round(element.getBoundingClientRect().width);
  return actual === saved ? `${actual}px` : `${actual}px（保存的宽度 ${saved}px）`;
}

/** @brief 当前会话的几项；没有打开的会话时只有一项"没有"。 */
function tabFields(state: AppState): IssueField[] {
  const tab = activeTab(state);
  if (!tab) return [{ label: '当前会话', value: '没有' }];
  const transcript = tab.transcript;
  return [
    { label: '当前会话', value: sessionTitle(tab) },
    { label: '文件夹', value: tab.cwd },
    { label: '会话文件', value: tab.sessionFile ?? '还没有' },
    { label: '模型', value: tab.model ?? '没有' },
    { label: '是否在生成', value: transcript.running ? '是' : '否' },
    { label: '阶段行', value: stageText(transcript, tab.cwd, Date.now()) ?? '不显示' },
    { label: '等你批准', value: String(transcript.approvals.length) },
    { label: '权限', value: tab.approval.mode === 'all' ? '全部允许' : '每次询问' },
  ];
}

/** @brief 分屏时左右两栏的会话名和焦点在哪边（docs/v0/screens/split.md）；单栏时没有这一项。 */
function splitFields(state: AppState): IssueField[] {
  if (!state.split || state.view !== 'chat') return [];
  const [left, right] = state.split.map((key) => state.tabs.find((tab) => tab.key === key));
  const focus = state.activeKey === state.split[0] ? '左' : '右';
  const names = `左：${left ? sessionTitle(left) : '没有'} · 右：${right ? sessionTitle(right) : '没有'}`;
  return [{ label: '分屏', value: `${names}（焦点在${focus}栏）` }];
}

/** @brief "当前界面"：界面状态与窗口、栏宽。 */
function currentView(): IssueField[] {
  const state = useApp.getState();
  const layout = useLayout.getState();
  return [
    { label: '页面', value: pageName(state) },
    ...tabFields(state),
    ...splitFields(state),
    { label: '右栏', value: document.querySelector('[data-testid="right-panel"]') ? '打开' : '关闭' },
    { label: '窗口大小', value: `${window.innerWidth}×${window.innerHeight}` },
    { label: '左栏宽度', value: columnWidth('sidebar', layout.sidebar) },
    { label: '右栏宽度', value: columnWidth('right-panel', layout.workspace) },
    { label: '后台进程', value: KERNEL_TEXT[state.kernel] },
  ];
}

/** @brief 打开报告框：先记下界面并截图，截完才显示；已经开着时把焦点放回第一个输入框。 */
export async function openIssueReport(): Promise<void> {
  const state = useIssue.getState();
  if (state.phase === 'open') {
    useIssue.setState({ focusRequest: state.focusRequest + 1 });
    return;
  }
  if (state.phase === 'capturing') return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  recordAction('报告界面问题');
  useIssue.setState({ phase: 'capturing', capture: null, view: currentView(), actions: recentActions() });
  let capture: WindowCapture;
  try {
    capture = await window.mori.captureWindow();
  } catch (error) {
    capture = { captureId: null, dataUrl: null, error: mainError('captureWindow', error) };
  }
  // 截图期间按 Esc 关掉了就不再打开。
  if (useIssue.getState().phase === 'capturing') useIssue.setState({ phase: 'open', capture });
}

/**
 * @brief 关闭报告框（不保存草稿），焦点回到打开前的位置。
 * @return 保存中不关闭，返回 false（浮层栈据此把报告框留在栈顶，Esc 什么都不做）
 */
function closeIssueReport(): boolean {
  if (useIssue.getState().saving) return false;
  useIssue.setState({ phase: 'closed', capture: null, view: [], actions: [] });
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
  return true;
}

/** @brief 在遮罩空白处按下鼠标时不让焦点离开报告框（否则焦点落到 body，键盘操作会走到背后的界面）。 */
function keepFocus(event: React.MouseEvent<HTMLElement>): void {
  if (event.target === event.currentTarget) event.preventDefault();
}

/** @brief F8：任何页面、焦点在哪里都有效；捕获阶段处理，先于输入框自己的按键。 */
function useF8(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'F8') return;
      event.preventDefault();
      void openIssueReport();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

/** @brief 报告框里能获得焦点的元素，按顺序。 */
function focusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)')];
}

/** @brief Tab 在报告框里循环，不走到背后的界面。 */
function trapTab(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const items = focusables(event.currentTarget);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const focused = document.activeElement;
  if (event.shiftKey && (focused === first || focused === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && focused === last) {
    event.preventDefault();
    first.focus();
  }
}

/** @brief 填写中、保存中、保存失败。onSaved 收到 Markdown 文件的路径。 */
function IssueForm({ capture, onSaved }: { capture: WindowCapture; onSaved: (file: string) => void }) {
  const [what, setWhat] = useState('');
  const [expect, setExpect] = useState('');
  const saving = useIssue((state) => state.saving);
  const [error, setError] = useState<string | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  // 保存中按钮不可用，焦点会离开它；保存失败后放回来，方便再保存。
  useEffect(() => {
    if (error) saveButton.current?.focus();
  }, [error]);
  async function save() {
    const { view, actions } = useIssue.getState();
    useIssue.setState({ saving: true });
    setError(null);
    try {
      const saved = await window.mori.saveIssue({
        captureId: capture.captureId, captureError: capture.error, what, expect, view, actions,
      });
      onSaved(saved.file);
    } catch (failure) {
      setError(mainError('saveIssue', failure));
    } finally {
      useIssue.setState({ saving: false });
    }
  }
  return (
    <>
      {capture.dataUrl
        ? <img className="issue-shot" data-testid="issue-shot" src={capture.dataUrl} alt="打开报告框前的窗口截图" />
        : <p className="form-message error" data-testid="issue-error">截图失败：{capture.error}</p>}
      <label className="issue-field">哪里不对
        <textarea data-testid="issue-what" aria-label="哪里不对" rows={3} value={what}
          onChange={(event) => setWhat(event.target.value)} />
      </label>
      <label className="issue-field">你期望什么
        <textarea data-testid="issue-expect" aria-label="你期望什么" rows={3} value={expect}
          onChange={(event) => setExpect(event.target.value)} />
      </label>
      <p className="muted">会附上截图、当前界面和最近的操作记录，保存在本机，不会发给模型</p>
      {error && <p className="form-message error" role="alert" data-testid="issue-error">保存失败：{error}</p>}
      <div className="issue-actions">
        <button ref={saveButton} className="button primary" disabled={saving || (!what.trim() && !expect.trim())}
          onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
        <button className="button" disabled={saving} onClick={closeIssueReport}>取消</button>
      </div>
    </>
  );
}

/** @brief 已保存：路径、"打开所在文件夹"、"关闭"。 */
function SavedView({ file }: { file: string }) {
  const [error, setError] = useState<string | null>(null);
  async function showInFolder() {
    setError(null);
    try {
      await window.mori.showIssueInFolder(file);
    } catch (failure) {
      setError(mainError('showIssueInFolder', failure));
    }
  }
  return (
    <>
      <p className="form-message ok issue-path" data-testid="issue-saved">已保存到 {file}</p>
      {error && <p className="form-message error" role="alert" data-testid="issue-error">{error}</p>}
      <div className="issue-actions">
        <button className="button" onClick={() => void showInFolder()}><Icon name="folder" />打开所在文件夹</button>
        <button className="button" onClick={closeIssueReport}>关闭</button>
      </div>
    </>
  );
}

/** @brief 报告框。打开、再按 F8、保存完成时，焦点放到第一个可用的输入框或按钮。 */
function IssueDialog({ capture }: { capture: WindowCapture }) {
  const focusRequest = useIssue((state) => state.focusRequest);
  const dialog = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (dialog.current) focusables(dialog.current)[0]?.focus();
  }, [focusRequest, saved]);
  return (
    <div className="issue-backdrop" onMouseDown={keepFocus}>
      <div ref={dialog} className="issue-dialog" role="dialog" aria-modal="true" aria-label="报告界面问题"
        data-testid="issue-dialog" tabIndex={-1} onKeyDown={trapTab}>
        <h2>报告界面问题</h2>
        {saved ? <SavedView file={saved} /> : <IssueForm capture={capture} onSaved={setSaved} />}
      </div>
    </div>
  );
}

/** @brief 报告界面问题：在根组件旁挂一次，首次启动、设置、会话里都能用 F8。 */
export function IssueReporter() {
  const phase = useIssue((state) => state.phase);
  const capture = useIssue((state) => state.capture);
  useF8();
  useOverlay(phase !== 'closed', closeIssueReport);
  if (phase !== 'open' || !capture) return null;
  return <IssueDialog capture={capture} />;
}
