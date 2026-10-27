// 右栏（docs/specs/file-system.md §5.1–§5.3，状态表 docs/v1/screens/fs-changes.md）：改动视图 Changes 或文件阅读器
// （按会话记住显示哪一个，docs/v0/screens/changes.md）。Changes 的标题栏有 Refresh（只读 git 状态，刷新中转圈、不可点，
// 内容保持上一次的）与 Close panel；正文按这个会话最近一次的 WorkspaceStatus 分：还没有状态（Loading…）、git 仓库（git 状态）、
// 不是 git 仓库（Not a git repository，下面文字按钮 Initialize git…，打开与输入框下一行同一个确认框，§11.11）、认不出仓库
// （Couldn’t read git status: …）时下面都是 This session；没装 git、版本太低时整个正文只有一行说明。阅读器自动重读的依据是
// 当前分支上列出这个文件的 changes 记录条数（§5.1）。照 Claude 桌面版：标题 Changes。
// 这个会话的 TaskBoard 有需求、或协作模式打开时顶部是 Changes / Background tasks 两个页签（平行 Agent 规格 §13.13.1），
// Refresh 在 Changes 页签选中时放在页签那一行；"Expand" / "Collapse"（docs/v0/screens/layout.md"右栏展开"）在标题栏或
// 页签那一行（docs/v1/walkthrough-1026-checks.md 的 U58）。

import { showRightTab } from '../state/backgroundTasks';
import {
  NOT_A_REPO_TEXT, changesBody, fileChangeCount, refreshChanges, statusAllowed, type ChangesBody,
} from '../state/workspace';
import { useApp, type Tab } from '../state/store';
import { tasksShown } from '../state/taskList';
import { openInitGit } from '../state/worktrees';
import { Icon } from '../icons';
import { BackgroundTasks } from './BackgroundTasks';
import { FileViewer } from './FileViewer';
import { GitStatus } from './GitStatus';
import { PanelExpand } from './PanelExpand';
import { SessionChanges } from './SessionChanges';
import '../styles/changes.css';

/**
 * @brief 标题栏右边的 Refresh：刷新中（tab.refreshing）转圈、aria-disabled（仍留着焦点）、读屏名 Refreshing…；
 *        点了发 workspace.status 并记进操作记录（Refresh changes）。
 */
function RefreshButton({ tab }: { tab: Tab }) {
  const label = tab.refreshing ? 'Refreshing…' : 'Refresh';
  return (
    <button className="icon-button changes-refresh" data-testid="changes-refresh"
      data-busy={tab.refreshing ? 'true' : undefined} aria-disabled={tab.refreshing ? true : undefined}
      aria-label={label} title={label} onClick={() => void refreshChanges(tab.key)}>
      {tab.refreshing ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
    </button>
  );
}

/**
 * @brief Not a git repository 下的 Initialize git…：只在这个会话能收命令时显示（statusAllowed：后台进程连着、会话已打开、
 *        不在建 worktree 中），同输入框下一行那一处在 Starting…、后台进程退出、打开失败时不显示；否则确认框里的
 *        Initialize git 发不出 workspace.initGit。
 */
function InitGitLink({ tab }: { tab: Tab }) {
  const kernel = useApp((state) => state.kernel);
  if (!statusAllowed(tab, kernel)) return null;
  return (
    <button className="text-link" data-testid="changes-init-git" onClick={() => openInitGit(tab.key)}>
      Initialize git…</button>
  );
}

/** @brief 正文上半部分：git 状态，或还没有状态、不是 git 仓库、认不出仓库、没装 git、版本太低时的一行。 */
function ChangesTop({ tab, body }: { tab: Tab; body: ChangesBody }) {
  switch (body.kind) {
    case 'repo':
      return <GitStatus tabKey={tab.key} status={body.status} />;
    case 'loading':
      return <p className="changes-line muted changes-top" data-testid="changes-loading">{body.text}</p>;
    case 'missing':
    case 'old':
      return <p className="changes-line" data-testid="git-required" data-state={body.kind}>{body.text}</p>;
    case 'error':
      return <p className="changes-line error changes-top" data-testid="git-error">{body.text}</p>;
    case 'not-repo':
      return (
        <div className="not-a-repo changes-top" data-testid="not-a-repo">
          <p className="changes-line">{NOT_A_REPO_TEXT}</p>
          <InitGitLink tab={tab} />
        </div>
      );
  }
}

/** @brief 改动视图：标题栏与正文（data-testid changes，沿用 v0）；有页签时没有自己的标题栏（§13.13.1）。 */
function ChangesView({ tab, onClose, tabbed }: { tab: Tab; onClose: () => void; tabbed: boolean }) {
  const body = changesBody(tab.workspace);
  return (
    <>
      {!tabbed && <div className="panel-header changes-header">
        <Icon name="file" /><span className="changes-title">Changes</span>
        <RefreshButton tab={tab} />
        <PanelExpand tab={tab} />
        <button className="icon-button" onClick={onClose} aria-label="Close panel"><Icon name="close" /></button>
      </div>}
      <div className="panel-body" data-testid="changes">
        <ChangesTop tab={tab} body={body} />
        {body.session && <SessionChanges tab={tab} />}
      </div>
    </>
  );
}

/** @brief Changes 一栏：改动视图或文件阅读器（按会话记住显示哪一个）。 */
function ChangesSide({ tab, onClose, tabbed }: { tab: Tab; onClose: () => void; tabbed: boolean }) {
  const view = tab.rightView;
  if (view.kind === 'changes') return <ChangesView tab={tab} onClose={onClose} tabbed={tabbed} />;
  return <FileViewer key={tab.key} tab={tab} view={view} version={fileChangeCount(tab, view.path)}
    onClose={onClose} tabbed={tabbed} />;
}

/**
 * @brief 页签那一行（平行 Agent 规格 §13.13.1）：Changes、Background tasks（Claude 右栏两栏的名字），Changes 的改动视图
 *        选中时右边有 Refresh（U58），再是“Expand” / “Collapse”与关闭；在列表、task 的视图、会话里都在顶部。
 */
function PanelTabs({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const tasks = tab.rightTab === 'tasks';
  const tabButton = (which: 'changes' | 'tasks', label: string) => (
    <button type="button" role="tab" className="panel-tab" data-testid="right-tab" data-tab={which}
      aria-selected={(which === 'tasks') === tasks} onClick={() => showRightTab(tab.key, which)}>{label}</button>
  );
  return (
    <div className="panel-header panel-tabs">
      <div role="tablist" aria-label="Right panel" className="panel-tablist">
        {tabButton('changes', 'Changes')}
        {tabButton('tasks', 'Background tasks')}
      </div>
      {!tasks && tab.rightView.kind === 'changes' && <RefreshButton tab={tab} />}
      <PanelExpand tab={tab} />
      <button className="icon-button" onClick={onClose} aria-label="Close panel"><Icon name="close" /></button>
    </div>
  );
}

/**
 * @brief 右栏。这个会话的 TaskBoard 有需求、或协作模式打开时顶部是两个页签（§13.13.1）；否则只有 Changes 一栏：
 *        改动视图或文件阅读器。
 */
export function RightPanel({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  if (!tasksShown(tab.board, tab.team.mode)) return <ChangesSide tab={tab} onClose={onClose} tabbed={false} />;
  return (
    <>
      <PanelTabs tab={tab} onClose={onClose} />
      {/* 按会话建：换到另一个会话时 task 的视图与会话不留着上一个会话读到的（两个会话都有 T1） */}
      {tab.rightTab === 'tasks' ? <BackgroundTasks key={tab.key} tab={tab} />
        : <ChangesSide tab={tab} onClose={onClose} tabbed />}
    </>
  );
}
