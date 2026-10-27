// 右栏（docs/specs/file-system.md §5.1–§5.3，状态表 docs/v1/screens/fs-changes.md）：改动视图 Changes 或文件阅读器
// （按会话记住显示哪一个，docs/v0/screens/changes.md）。Changes 的标题栏有 Refresh（只读 git 状态，刷新中转圈、不可点，
// 内容保持上一次的）与 Close panel；正文按这个会话最近一次的 WorkspaceStatus 分：还没有状态（Loading…）、git 仓库（git 状态）、
// 不是 git 仓库（Not a git repository；它下面的 Initialize git… 属于 worktree 那一步）、认不出仓库（Couldn’t read git status: …）
// 时下面都是 This session；没装 git、版本太低时整个正文只有一行说明。阅读器自动重读的依据是当前分支上列出这个文件的
// changes 记录条数（§5.1）。照 Claude 桌面版：标题 Changes。

import { NOT_A_REPO_TEXT, changesBody, fileChangeCount, refreshChanges, type ChangesBody } from '../state/workspace';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { FileViewer } from './FileViewer';
import { GitStatus } from './GitStatus';
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
        </div>
      );
  }
}

/** @brief 改动视图：标题栏与正文（data-testid changes，沿用 v0）。 */
function ChangesView({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const body = changesBody(tab.workspace);
  return (
    <>
      <div className="panel-header changes-header">
        <Icon name="file" /><span className="changes-title">Changes</span>
        <RefreshButton tab={tab} />
        <button className="icon-button" onClick={onClose} aria-label="Close panel"><Icon name="close" /></button>
      </div>
      <div className="panel-body" data-testid="changes">
        <ChangesTop tab={tab} body={body} />
        {body.session && <SessionChanges tab={tab} />}
      </div>
    </>
  );
}

/** @brief 右栏：改动视图或文件阅读器（按会话记住显示哪一个）。 */
export function RightPanel({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const view = tab.rightView;
  if (view.kind === 'changes') return <ChangesView tab={tab} onClose={onClose} />;
  return <FileViewer key={tab.key} tab={tab} view={view} version={fileChangeCount(tab, view.path)}
    onClose={onClose} />;
}
