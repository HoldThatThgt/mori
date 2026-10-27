// Initialize git 确认框（docs/specs/file-system.md §11.11，状态表 docs/v1/screens/fs-worktree.md "Initialize git 确认框"）：
// 输入框下一行与右栏 Not a git repository 下的 Initialize git… 打开的是同一个（Tab.initGit，state/worktrees.ts）。
// 标题 Initialize git in “<文件夹名>”?、说明、下一行完整路径；按钮 Initialize git 与 Cancel，焦点在 Cancel，Tab 只在两个按钮
// 之间切换，Esc 等于 Cancel；进行中按钮写 Initializing…、两个按钮不可用、Esc 不起作用；失败时对话框里
// Couldn’t initialize git: <原因>，按钮恢复可用。
// 本文件另有 §11 三个确认框（Initialize git、删除会话时 worktree 的一句、Storage 的 Clean up）共用的外框 WorktreeDialog：
// 结构同 ConfirmDialog（盖住整个窗口、挂到 body 上），多了说明下面的几行、确认按钮暂不可用（aria-disabled）与进行中
// 焦点停在对话框本身上。

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';
import { focusComposer } from '../state/split';
import type { InitGitUi, Tab } from '../state/store';
import { closeInitGit, confirmInitGit } from '../state/worktrees';
import { folderName } from './ChatPane';

/** @brief 外框的内容与状态。 */
export interface WorktreeDialogProps {
  /** 标题 */
  title: string;
  /** 说明 */
  text: string;
  /** 说明下面的几行（完整路径、worktree 的一句）；没有时省略 */
  children?: ReactNode;
  /** 确认按钮的文字（进行中要换字的由调用方换，例如 Initializing…） */
  confirmLabel: string;
  /** 确认按钮的样式：primary 主色，danger 危险色 */
  tone: 'primary' | 'danger';
  /** 测试标识（data-testid） */
  testId: string;
  /** 进行中：两个按钮不可用、Esc 不起作用，焦点停在对话框本身上（Tab 仍由它接住） */
  busy: boolean;
  /** 进行中时按钮下面的一行（删除的 Deleting…）；不需要时省略 */
  busyText?: string;
  /** 确认按钮暂不可用（aria-disabled，仍能 Tab 到，点了不做事；删除确认框读 worktree 时） */
  blocked?: boolean;
  /** 失败的原文；没有为 null */
  error: string | null;
  /** 点了确认（blocked 时不调用） */
  onConfirm: () => void;
  /** 点了取消或按了 Esc（进行中不调用） */
  onCancel: () => void;
}

/** @brief 对话框里 Tab 只在可用的按钮之间循环；按钮都不可用时焦点留在对话框上。 */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.shiftKey ? -1 : 1;
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}

/**
 * @brief §11 的确认框外框：打开时、失败后（按钮重新可用）焦点在 Cancel；进行中焦点在对话框本身上。
 *        在遮罩上按下鼠标不让焦点离开对话框（同 ConfirmDialog）。
 */
export function WorktreeDialog(props: WorktreeDialogProps) {
  const { title, text, children, confirmLabel, tone, testId, busy, busyText, blocked = false, error, onConfirm,
    onCancel } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  const extraId = useId();
  useOverlay(true, () => {
    if (busy) return false;
    onCancel();
  });
  useEffect(() => {
    if (busy) dialog.current?.focus();
    else cancel.current?.focus();
  }, [busy, error]);
  // 说明下面的几行（完整路径、worktree 的一句）也算进读屏的说明：删除时会丢掉的改动要和说明一起读出来
  const described = children == null ? textId : `${textId} ${extraId}`;
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget
      && event.preventDefault()}>
      <div ref={dialog} className="dialog" role="alertdialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={titleId} aria-describedby={described} data-testid={testId} onKeyDown={trapTab}>
        <h2 id={titleId}>{title}</h2>
        <p id={textId}>{text}</p>
        {children != null && <div id={extraId}>{children}</div>}
        {busy && busyText && <p className="dialog-status" role="status">{busyText}</p>}
        {error && <p className="form-message error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className={`button ${tone}`} disabled={busy} aria-disabled={blocked && !busy ? true : undefined}
            onClick={() => { if (!blocked) onConfirm(); }}>{confirmLabel}</button>
          <button ref={cancel} className="button" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Initialize git 确认框的说明（fs-worktree.md） */
const INIT_GIT_TEXT = 'Mori will run git init in this folder and commit its current files as the first commit. '
  + 'Files matched by .gitignore aren’t included. Afterward, new sessions here can use a worktree.';

/**
 * @brief 关掉（卸载）时焦点回到打开前的元素；它已经不在页面上（成功后 Initialize git… 换成了 Worktree 开关、右栏换成了
 *        git 状态）时回到这一栏的文字框。打开前的元素在第一次渲染时记下：子组件 WorktreeDialog 的 effect 先于这里的
 *        effect 运行，那时焦点已经到了 Cancel 上。
 */
function useRestoreFocus(tabKey: string): void {
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => {
    if (previous?.isConnected && previous !== document.body) previous.focus();
    else focusComposer(tabKey);
  }, [previous, tabKey]);
}

/**
 * @brief Initialize git 确认框（data-testid="init-git-dialog"）；ChatPane 在 tab.initGit 不为 null、这一栏显示着时挂上。
 * @param ui 这个会话的确认框状态（tab.initGit）
 */
export function InitGitDialog({ tab, ui }: { tab: Tab; ui: InitGitUi }) {
  useRestoreFocus(tab.key);
  return (
    <WorktreeDialog title={`Initialize git in “${folderName(tab.cwd)}”?`} text={INIT_GIT_TEXT}
      confirmLabel={ui.busy ? 'Initializing…' : 'Initialize git'} tone="primary" testId="init-git-dialog"
      busy={ui.busy} error={ui.error} onConfirm={() => void confirmInitGit(tab.key)}
      onCancel={() => closeInitGit(tab.key)}>
      <p className="dialog-path" data-testid="init-git-path">{tab.cwd}</p>
    </WorktreeDialog>
  );
}
