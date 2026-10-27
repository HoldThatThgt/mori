// 设置页的 Storage（docs/specs/file-system.md §11.10，状态表 docs/v1/screens/fs-worktree.md "设置页：Storage → Worktrees"）：
// 照 Claude 的 Settings > Storage，排在 General 之后；一块 Worktrees，列出已归档会话留下、文件夹还在的 worktree（会话名、
// 分支、有没有改动、在用）与 Clean up worktrees…。每次进入这一节读一次（worktrees.list），不轮询；确认后
// worktrees.cleanUp { force: true }，之后再读一次，删失败的在列表下面各一行（state/worktrees.ts）。

import { useEffect, useId, useRef, useState } from 'react';
import {
  cleanableItems, cleanUpStorage, cleanUpTitle, loadStorage, STORAGE_EMPTY_TEXT, STORAGE_GIT_REQUIRED_TEXT,
  storageMarkText, useStorage, type StorageItem,
} from '../../state/worktrees';
import { displayTitle } from '../ChatPane';
import { WorktreeDialog } from '../InitGitDialog';

/** Worktrees 一块的说明（fs-worktree.md） */
const WORKTREES_NOTE = 'Archived sessions keep their worktree when it has uncommitted changes. Clean up deletes these '
  + 'worktrees and the changes in them. Branches and sessions are kept.';
/** 清理确认框的说明（fs-worktree.md） */
const CLEAN_UP_TEXT = 'These worktrees and the uncommitted changes in them will be deleted. Their branches and '
  + 'sessions are kept. This can’t be undone.';

/** @brief 一行：会话名、分支（等宽字）、有没有改动或在用（读不出有没有改动时不写）。 */
function WorktreeRow({ item }: { item: StorageItem }) {
  const mark = storageMarkText(item.mark);
  return (
    <li className="storage-item" data-testid="worktree-item" data-path={item.path} data-mark={item.mark}
      title={item.path}>
      <span className="storage-name">{displayTitle(item.name, item.firstMessage)}</span>
      <span className="storage-branch">{item.branch}</span>
      {mark && <span className="storage-mark">{mark}</span>}
    </li>
  );
}

/**
 * @brief 清理确认框：标题 Clean up N worktrees?（N 不算在用的）、说明、Clean up（危险色）与 Cancel，焦点在 Cancel。
 *        点了 Clean up 到再读完列表之前按钮写 Cleaning up…、两个按钮不可用、Esc 不起作用，然后关掉。
 * @param count 会删的项数（打开时的）
 * @param onClose 关掉确认框
 */
function CleanUpDialog({ count, onClose }: { count: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    await cleanUpStorage();
    onClose();
  }
  return (
    <WorktreeDialog title={cleanUpTitle(count)} text={CLEAN_UP_TEXT}
      confirmLabel={busy ? 'Cleaning up…' : 'Clean up'} tone="danger" testId="worktrees-cleanup-dialog" busy={busy}
      error={null} onConfirm={() => void confirm()} onCancel={onClose} />
  );
}

/** @brief 上一次清理逐项删失败的各行 Couldn’t delete <branch>: <原文>（列表下面）。 */
function FailureLines({ failures }: { failures: string[] }) {
  return <>{failures.map((line) => <p key={line} className="form-message error" role="alert">{line}</p>)}</>;
}

/**
 * @brief 列表、删失败的各行与 Clean up worktrees…（没有可删的项时不可用）。确认框关掉后焦点回到按钮；按钮已经
 *        不可用（全删掉了），或清理后再读列表失败、没装 git 时按钮已经不在（这一块连同确认框一起卸下），回到这一块的标题。
 * @param heading 这一块的标题 Worktrees（tabIndex -1，焦点的去处；它属于 StorageSection，一直在）
 */
function WorktreeList({ items, failures, heading }: { items: StorageItem[]; failures: string[];
  heading: React.RefObject<HTMLHeadingElement | null> }) {
  // 确认框开着时的 N（打开时定下：清理后再读列表时不跟着变）；关着时为 null
  const [confirming, setConfirming] = useState<number | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const count = cleanableItems(items).length;
  function closed() {
    setConfirming(null);
    requestAnimationFrame(() => (button.current && !button.current.disabled ? button.current : heading.current)
      ?.focus());
  }
  return (
    <>
      {items.length === 0 ? <p className="settings-empty">{STORAGE_EMPTY_TEXT}</p> : (
        <ul className="storage-list">{items.map((item) => <WorktreeRow key={item.path} item={item} />)}</ul>
      )}
      <FailureLines failures={failures} />
      <div className="form-actions">
        <button ref={button} className="button" data-testid="worktrees-cleanup" disabled={count === 0}
          onClick={() => setConfirming(count)}>Clean up worktrees…</button>
      </div>
      {confirming !== null && <CleanUpDialog count={confirming} onClose={closed} />}
    </>
  );
}

/**
 * @brief Worktrees 一块的正文：读取中（Loading…）、读取失败（Couldn’t load worktrees: <原文> 与 Retry）、没装 git
 *        （只有一行，没有列表和按钮）、列表。
 */
function WorktreesBody({ heading }: { heading: React.RefObject<HTMLHeadingElement | null> }) {
  const view = useStorage();
  if (view.status === 'idle' || view.status === 'loading') return <p className="muted" role="status">Loading…</p>;
  if (view.status === 'failed') {
    return (
      <div className="settings-error" data-testid="worktrees-load-error">
        <p className="form-message error" role="alert">{view.problem}</p>
        <button className="button" onClick={() => void loadStorage()}>Retry</button>
        <FailureLines failures={view.failures} />
      </div>
    );
  }
  if (!view.git) return <p className="settings-empty">{STORAGE_GIT_REQUIRED_TEXT}</p>;
  return <WorktreeList items={view.items} failures={view.failures} heading={heading} />;
}

/** @brief Storage 一节：每次换到这一节时读一次 Worktrees（你的操作，不在后台读）。 */
export function StorageSection() {
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    void loadStorage();
  }, []);
  return (
    <div className="settings-section" data-section="storage">
      <h2>Storage</h2>
      <section className="storage-block" data-testid="storage-worktrees" aria-labelledby={headingId}>
        <h3 ref={heading} id={headingId} tabIndex={-1}>Worktrees</h3>
        <p className="muted">{WORKTREES_NOTE}</p>
        <WorktreesBody heading={heading} />
      </section>
    </div>
  );
}
