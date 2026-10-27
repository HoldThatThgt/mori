// 右栏 Changes 的上半部分：git 状态（docs/specs/file-system.md §5.2，状态表 docs/v1/screens/fs-changes.md "git 状态"）。
// 分支行（太长时省略号截断，悬停看全文）、按组列出的未提交文件（Conflicts、Staged、Unstaged、Untracked，没有的组不显示）、
// No uncommitted changes、超过 500 条的说明与读失败的原文。每行是状态字母（悬停 Modified 等，未跟踪的不带字母）和相对仓库根
// 的路径（重命名 <from> → <path>）；点一行（Enter、空格）在阅读器里打开 <toplevel>\<path>，不显示 git 的 diff。
// 路径用等宽字（同 v0 的改动列表）；放不下时省略号截断、悬停看全文（规格没给，照 Claude 桌面版的文件列表）。

import type { StatusFile, WorkspaceStatus } from '../../../shared/workspace';
import { openFile } from '../state/quotes';
import {
  gitStatusView, STATUS_CODE_TITLES, statusFileLabel, statusFilePath, type StatusGroup,
} from '../state/workspace';

/** @brief 一个文件的状态字母的悬停文字；未跟踪的不带字母，为 null。 */
function letterTitle(file: StatusFile): string | null {
  return file.group === 'untracked' ? null : STATUS_CODE_TITLES[file.code] ?? null;
}

/** @brief git 状态的一行：状态字母与路径；点了在阅读器里打开这个文件（删掉的显示 File not found，目录显示 v0 的状态）。 */
function GitFileRow({ tabKey, status, file }: { tabKey: string; status: WorkspaceStatus; file: StatusFile }) {
  const label = statusFileLabel(file);
  const title = letterTitle(file);
  const open = () => {
    const path = statusFilePath(status, file);
    if (path) openFile(tabKey, path);
  };
  return (
    <li>
      <button className="change-row git-file" data-testid="git-file" data-path={file.path} data-code={file.code}
        aria-label={title ? `${label}, ${title}` : label} onClick={open}>
        <span className="status-letter" data-code={title ? file.code : undefined} title={title ?? undefined}
          aria-hidden="true">{title ? file.code : ''}</span>
        <span className="change-row-path" title={label} aria-hidden="true">{label}</span>
      </button>
    </li>
  );
}

/** @brief 一组：组标题 <名字> · <条数> 与这一组的文件。 */
function GitGroup({ tabKey, status, group }: { tabKey: string; status: WorkspaceStatus; group: StatusGroup }) {
  return (
    <div className="git-group" data-testid="git-group" data-group={group.group}>
      <div className="changes-subtitle">{group.title}</div>
      <ul className="change-rows">
        {group.files.map((file) => <GitFileRow key={file.path} tabKey={tabKey} status={status} file={file} />)}
      </ul>
    </div>
  );
}

/**
 * @brief git 状态这一块（右栏正文是 git 仓库时）。读失败时分支行的位置是 Couldn’t read git status: <原文>，没有列表。
 * @param status 这个会话最近一次的 git 状态（repo 不为 null）
 */
export function GitStatus({ tabKey, status }: { tabKey: string; status: WorkspaceStatus }) {
  const view = gitStatusView(status);
  return (
    <section className="git-status" data-testid="git-status" aria-label="Git status">
      {view.branch && <div className="git-branch" data-testid="git-branch" title={view.branch}>{view.branch}</div>}
      {view.error && <p className="changes-line error" data-testid="git-error">{view.error}</p>}
      {view.empty && <p className="changes-line muted" data-testid="git-empty">{view.empty}</p>}
      {view.groups.map((group) => <GitGroup key={group.group} tabKey={tabKey} status={status} group={group} />)}
      {view.footer && <p className="changes-line muted" data-testid="git-footer">{view.footer}</p>}
    </section>
  );
}
