// F8 报告界面问题（方案 5.15，状态表见 docs/v0/screens/f8.md）：先截下当前窗口，截完才显示报告框，
// 所以截图里没有报告框本身。保存在本机（主进程写文件），不经过后台进程和 pi，也不发给模型。

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { IssueAction, IssueField, WindowCapture } from '../../../shared/issues';
import { mainError } from '../state/bridge';
import { recentActions, recordAction } from '../state/actionLog';
import { useLayout } from '../state/layout';
import { useOverlay } from '../state/overlays';
import { fileName, openReview, reviewChanged } from '../state/review';
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
  /** 按 F8 那一刻的"Current view" */
  view: IssueField[];
  /** 按 F8 那一刻的最近操作，从早到晚 */
  actions: IssueAction[];
  /** 每次要把焦点放回报告框第一个输入框时加一 */
  focusRequest: number;
  /** 保存中（主进程还在写文件）：这时 Esc 和"Cancel"都不关闭报告框，等保存有结果 */
  saving: boolean;
}

const useIssue = create<IssueState>(() => ({
  phase: 'closed', capture: null, view: [], actions: [], focusRequest: 0, saving: false,
}));

/** 打开报告框前焦点所在的元素，关闭后回到这里 */
let returnFocus: HTMLElement | null = null;

const KERNEL_TEXT: Record<KernelStatus, string> = {
  connecting: 'Starting…', ready: 'Running', exited: 'Crashed', reloading: 'Restarting…',
};

/** 右栏：会话的右栏，或工作回顾页上的详情（docs/v0/screens/review.md，宽度与会话的右栏共用） */
const RIGHT_PANEL = 'aside.right-panel';

/** 中栏页面的名字 */
const PAGE_NAME: Record<AppState['view'], string> = {
  chat: 'Session', settings: 'Settings', tools: 'Customize', review: 'Review',
};

/** @brief 当前显示的页面。 */
function pageName(state: AppState): string {
  if (state.configError) return 'Couldn’t load connections';
  if (!state.config) return 'Loading connections…';
  if (state.firstRun) return 'First run';
  return PAGE_NAME[state.view];
}

/**
 * @brief 一栏的实际宽度；与保存的宽度不同（被收紧或收起）时一并写出。
 * @param selector 这一栏的元素（右栏是 aside.right-panel：会话的右栏或工作回顾的详情）
 */
function columnWidth(selector: string, saved: number): string {
  const element = document.querySelector(selector);
  if (!element) return `Hidden (saved width ${saved}px)`;
  const actual = Math.round(element.getBoundingClientRect().width);
  return actual === saved ? `${actual}px` : `${actual}px (saved width ${saved}px)`;
}

/** @brief 当前会话的几项；没有打开的会话时只有一项"Current session: None"。 */
function tabFields(state: AppState): IssueField[] {
  const tab = activeTab(state);
  if (!tab) return [{ label: 'Current session', value: 'None' }];
  const transcript = tab.transcript;
  return [
    { label: 'Current session', value: sessionTitle(tab) },
    { label: 'Folder', value: tab.cwd },
    { label: 'Session file', value: tab.sessionFile ?? 'Not saved yet' },
    { label: 'Model', value: tab.current ?? 'None' },
    { label: 'Running', value: transcript.running ? 'Yes' : 'No' },
    { label: 'Status line', value: stageText(transcript, tab.cwd, Date.now()) ?? 'Hidden' },
    { label: 'Pending requests', value: String(transcript.approvals.length) },
    { label: 'Permission mode', value: tab.approval.mode === 'all' ? 'Allow all' : 'Ask each time' },
  ];
}

/** @brief 分屏时左右两栏的会话名和焦点在哪边（docs/v0/screens/split.md）；单栏时没有这一项。 */
function splitFields(state: AppState): IssueField[] {
  if (!state.split || state.view !== 'chat') return [];
  const [left, right] = state.split.map((key) => state.tabs.find((tab) => tab.key === key));
  const focus = state.activeKey === state.split[0] ? 'left' : 'right';
  const names = `Left: ${left ? sessionTitle(left) : 'None'} · Right: ${right ? sessionTitle(right) : 'None'}`;
  return [{ label: 'Split view', value: `${names} (focus in the ${focus} pane)` }];
}

/** @brief "Current view"：界面状态与窗口、栏宽。 */
function currentView(): IssueField[] {
  const state = useApp.getState();
  const layout = useLayout.getState();
  return [
    { label: 'Page', value: pageName(state) },
    ...tabFields(state),
    ...splitFields(state),
    { label: 'Right panel', value: document.querySelector(RIGHT_PANEL) ? 'Open' : 'Closed' },
    { label: 'Window size', value: `${window.innerWidth}×${window.innerHeight}` },
    { label: 'Sidebar width', value: columnWidth('[data-testid="sidebar"]', layout.sidebar) },
    { label: 'Right panel width', value: columnWidth(RIGHT_PANEL, layout.workspace) },
    { label: 'Background process', value: KERNEL_TEXT[state.kernel] },
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
  recordAction('Report a UI issue');
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

/** 两个输入框下面的说明 */
const ISSUE_NOTE = 'Includes a screenshot, the current view, and your recent activity. Saved on this computer and '
  + 'never sent to the model.';

/** @brief 截图缩略图；截图失败时是错误原文（仍可填写和保存）。 */
function CapturePreview({ capture }: { capture: WindowCapture }) {
  if (capture.dataUrl) {
    return <img className="issue-shot" data-testid="issue-shot" src={capture.dataUrl}
      alt="Screenshot of the window before this dialog opened" />;
  }
  return (
    <p className="form-message error" data-testid="issue-error">Couldn’t capture a screenshot: {capture.error}</p>
  );
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
      reviewChanged();
    } catch (failure) {
      setError(mainError('saveIssue', failure));
    } finally {
      useIssue.setState({ saving: false });
    }
  }
  return (
    <>
      <CapturePreview capture={capture} />
      <label className="issue-field">What went wrong
        <textarea data-testid="issue-what" aria-label="What went wrong" rows={3} value={what}
          onChange={(event) => setWhat(event.target.value)} />
      </label>
      <label className="issue-field">What you expected
        <textarea data-testid="issue-expect" aria-label="What you expected" rows={3} value={expect}
          onChange={(event) => setExpect(event.target.value)} />
      </label>
      <p className="muted">{ISSUE_NOTE}</p>
      {error && (
        <p className="form-message error" role="alert" data-testid="issue-error">Couldn’t save the report: {error}</p>
      )}
      <div className="issue-actions">
        <button ref={saveButton} className="button primary" disabled={saving || (!what.trim() && !expect.trim())}
          onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        <button className="button" disabled={saving} onClick={closeIssueReport}>Cancel</button>
      </div>
    </>
  );
}

/** @brief "View in Review"：关闭报告框，打开工作回顾的"UI issues"，选中这一份。 */
function viewInReview(file: string): void {
  if (!closeIssueReport()) return;
  openReview('issues', fileName(file));
}

/**
 * @brief 已保存：路径、"Show in Explorer"、"View in Review"（只在显示工作区时有：首次启动、读取连接中或失败的页面上
 *        没有工作回顾）、"Close"。
 */
function SavedView({ file }: { file: string }) {
  const [error, setError] = useState<string | null>(null);
  const workspace = useApp((state) => Boolean(state.config) && !state.configError && !state.firstRun);
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
      <p className="form-message ok issue-path" data-testid="issue-saved">Saved to {file}</p>
      {error && <p className="form-message error" role="alert" data-testid="issue-error">{error}</p>}
      <div className="issue-actions">
        <button className="button" onClick={() => void showInFolder()}><Icon name="folder" />Show in Explorer</button>
        {workspace && (
          <button className="button" data-testid="issue-open-review" onClick={() => viewInReview(file)}>
            View in Review</button>
        )}
        <button className="button" onClick={closeIssueReport}>Close</button>
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
      <div ref={dialog} className="issue-dialog" role="dialog" aria-modal="true" aria-label="Report a UI issue"
        data-testid="issue-dialog" tabIndex={-1} onKeyDown={trapTab}>
        <h2>Report a UI issue</h2>
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
