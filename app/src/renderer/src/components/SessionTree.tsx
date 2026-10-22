// 左栏的项目 → 会话树（docs/v0/screens/sessions.md）：会话行的状态、键盘（整棵树一个 Tab 停靠点，↑ ↓ Home End 移动，
// Enter 打开）、右键菜单（右键、菜单键、Shift+F10）、改名框、删除确认框，以及底部的"Archived"。行的数据在 sessionRows.ts。

import { useState } from 'react';
import { describe } from '../state/bridge';
import { guardLeave } from '../state/leaveGuard';
import { archiveSession, loadSessions, openSaved, restoreSession, retryOpen, showChat } from '../state/projects';
import { referenceSession } from '../state/refActions';
import { focusComposer, openInSplit } from '../state/split';
import { useApp } from '../state/store';
import { Icon } from '../icons';
import { folderName } from './ChatPane';
import { DeleteDialog, RenameInput } from './SessionEdits';
import { dragProps, useDragging } from './SessionDrag';
import { SessionMenu, type MenuAction } from './SessionMenu';
import { buildRows, groupRows, isUnsaved, rowStatus, STATUS_TEXT, type Row } from './sessionRows';

/** @brief 把焦点放到某个会话行；找不到时放到"New session"。 */
function focusRow(id: string | null): void {
  requestAnimationFrame(() => {
    const row = id ? document.querySelector<HTMLElement>(`.session-item[data-row="${CSS.escape(id)}"]`) : null;
    (row ?? document.querySelector<HTMLElement>('[data-testid="new-session"]'))?.focus();
  });
}

/** @brief 屏幕上排在这一行下面的会话行（没有时上面的）；收起的"Archived"里的行不算。 */
function neighbourRow(id: string): string | null {
  const items = [...document.querySelectorAll<HTMLElement>('[data-testid="session-tree"] .session-item')];
  const index = items.findIndex((item) => item.dataset.row === id);
  return (items[index + 1] ?? items[index - 1])?.dataset.row ?? null;
}

/** @brief 会话行上的方向键：在全部会话行之间移动焦点（不打开会话）。 */
function moveRowFocus(event: React.KeyboardEvent<HTMLButtonElement>): boolean {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return false;
  event.preventDefault();
  const tree = event.currentTarget.closest('[data-testid="session-tree"]');
  const items = [...(tree?.querySelectorAll<HTMLElement>('.session-item') ?? [])];
  const index = items.indexOf(event.currentTarget);
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key] ?? index;
  items[Math.max(0, Math.min(next, items.length - 1))]?.focus();
  return true;
}

/** @brief 会话行上的操作：打开、获得焦点、打开菜单。 */
interface RowHandlers {
  onOpen: (row: Row) => void;
  onFocus: (row: Row) => void;
  onMenu: (row: Row, at: { x: number; y: number }) => void;
}

/** @brief 拖会话行时带的东西（已归档的不能拖）。 */
function rowSource(row: Row) {
  if (row.archived) return null;
  return { tabKey: row.tab?.key, saved: row.saved, file: row.file, title: row.title, hasMessages: !isUnsaved(row) };
}

/** @brief 一个会话行。tabStop 为真时它是整棵树的 Tab 停靠点；inSplit 为真时它显示在分屏的另一栏里。 */
function SessionRow({ row, active, inSplit, tabStop, onMenu, onOpen, onFocus }: RowHandlers & {
  row: Row; active: boolean; inSplit: boolean; tabStop: boolean;
}) {
  const status = rowStatus(row);
  const dragging = useDragging(row.file, row.tab?.key);
  const menuAt = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + 12, y: rect.bottom + 2 };
  };
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (moveRowFocus(event)) return;
    if (!(event.key === 'F10' && event.shiftKey) && event.key !== 'ContextMenu') return;
    event.preventDefault();
    onMenu(row, menuAt(event.currentTarget));
  }
  function onContextMenu(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    // 键盘触发的 contextmenu 没有鼠标位置（坐标为 0）：贴着会话行。
    onMenu(row, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : menuAt(event.currentTarget));
  }
  const title = row.archived ? `${folderName(row.cwd)} · ${row.full}` : row.full;
  const classes = ['session-item', active && 'active', inSplit && 'in-split', row.archived && 'archived',
    dragging && 'dragging'].filter(Boolean).join(' ');
  return (
    <button className={classes} role="treeitem" {...dragProps(rowSource(row))}
      aria-selected={active} data-row={row.id} data-file={row.file ?? ''} title={title} tabIndex={tabStop ? 0 : -1}
      onClick={() => onOpen(row)} onKeyDown={onKeyDown} onContextMenu={onContextMenu} onFocus={() => onFocus(row)}>
      <Icon name="chat" /><span className="session-label">{row.title}</span>
      {/* 文字单独一个 span：侧栏很窄时只藏文字、留下圆点（文字仍在读屏名里），悬停圆点看 title */}
      {status && (
        <span className={`session-status ${status}`} data-testid="session-status" data-status={status}
          title={STATUS_TEXT[status]}>
          <span className="session-status-text">{STATUS_TEXT[status]}</span>
        </span>
      )}
    </button>
  );
}

/** @brief 读取中、读取失败时的说明，以及归档失败的原文。pi 读不出的会话文件直接略过、不报错，不会出现在这里。 */
function ListNote({ problem }: { problem: string | null }) {
  const saved = useApp((state) => state.saved);
  if (problem) return <p className="sidebar-note error" role="alert">{problem}</p>;
  if (saved.status === 'loading') return <p className="sidebar-note">Loading sessions…</p>;
  if (saved.status !== 'failed') return null;
  return (
    <div className="sidebar-note error" role="alert">
      <span>Couldn’t load sessions: {saved.error}</span>
      <button className="text-link" onClick={() => void loadSessions()}>Retry</button>
    </div>
  );
}

/** @brief 树上的会话行：项目下的（按项目分组、排好序）、已归档的，以及当前会话那一行。 */
function useTreeRows() {
  const tabs = useApp((state) => state.tabs);
  const sessions = useApp((state) => state.saved.sessions);
  const archived = useApp((state) => state.archived);
  const marks = useApp((state) => state.rowMarks);
  const activeKey = useApp((state) => state.activeKey);
  const view = useApp((state) => state.view);
  const all = buildRows(tabs, sessions, { archived, marks });
  const groups = groupRows(all.filter((row) => !row.archived));
  const shelved = all.filter((row) => row.archived).sort((a, b) => b.activity - a.activity);
  const rows = [...groups.flatMap((group) => group.rows), ...shelved];
  const activeRow = view === 'chat' ? rows.find((row) => row.tab && row.tab.key === activeKey) : undefined;
  const split = useApp((state) => state.split);
  const others = view === 'chat' && split ? split.filter((key) => key !== activeKey) : [];
  return { groups, shelved, rows, activeRow, others };
}

/** @brief 一个项目：项目行和它的会话行（正在改名的那一行换成改名框）。others 为分屏另一栏的会话。 */
function ProjectGroup({ cwd, rows, activeRow, others, tabStop, renaming, onRenamed, ...handlers }: RowHandlers & {
  cwd: string; rows: Row[]; activeRow: Row | undefined; others: string[]; tabStop: string | undefined;
  renaming: string | null; onRenamed: (row: Row, keepFocus: boolean) => void;
}) {
  return (
    <div className="project-group" role="group" aria-label={folderName(cwd)} data-cwd={cwd}>
      <div className="project-heading" title={cwd}>
        <Icon name="folder" /><span>{folderName(cwd)}</span>
      </div>
      {rows.map((row) => (renaming === row.id
        ? <RenameInput key={row.id} row={row} onDone={(keep) => onRenamed(row, keep)} />
        : <SessionRow key={row.id} row={row} active={row === activeRow} tabStop={row.id === tabStop}
          inSplit={Boolean(row.tab && others.includes(row.tab.key))} {...handlers} />))}
    </div>
  );
}

/** @brief 侧栏底部的"Archived N"：默认收起，展开后列出已归档的会话。 */
function ArchivedList({ rows, tabStop, ...handlers }: RowHandlers & { rows: Row[]; tabStop: string | undefined }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="archived" role="group" aria-label="Archived">
      <button className="archived-toggle" data-testid="archived-toggle" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'chevron'} /><span>Archived {rows.length}</span>
      </button>
      {open && (
        <div data-testid="archived-list">
          {rows.map((row) => <SessionRow key={row.id} row={row} active={false} inSplit={false}
            tabStop={row.id === tabStop} {...handlers} />)}
        </div>
      )}
    </div>
  );
}

/**
 * @brief 菜单里的"Attach as context"和"Open in split view"：与把会话拖进输入框、拖到中栏右半边相同（M5）。
 *        会话行和分屏标题行上的菜单共用。
 */
export function sessionAction(row: Row, action: 'reference' | 'split'): void {
  const { activeKey } = useApp.getState();
  if (action === 'reference') {
    if (activeKey && row.file) void referenceSession(activeKey, row.file, row.title);
    return;
  }
  if (row.tab) {
    openInSplit(row.tab.key, 'right');
    focusComposer();
  } else if (row.saved) {
    void openSaved(row.saved, 'right').then(() => focusComposer());
  }
}

/**
 * @brief 会话树上的操作：打开（先过离开确认；已归档的先恢复，打开失败的重试）、菜单里的重命名、归档、恢复、删除。
 *        删除、归档后焦点移到屏幕上排在下面（没有时上面）的会话行。
 */
function useTreeActions(onNavigate: () => void) {
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ row: Row; next: string | null } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const nextOf = (row: Row) => neighbourRow(row.id);
  const handlers: RowHandlers = {
    onOpen: (row) => {
      setProblem(null);
      // 先过离开确认（AGENTS.md 有未保存的改动时）：你选"Keep editing"时什么都不变，已归档的不恢复、失败的不重试。
      guardLeave(() => {
        if (row.archived && row.saved) restoreSession(row.saved, true);
        else if (row.tab?.phase === 'failed') retryOpen(row.tab.key);
        if (row.tab) showChat(row.tab.key);
        else if (row.saved && !row.archived) void openSaved(row.saved);
        onNavigate();
        focusComposer();
      });
    },
    onFocus: (row) => setFocused(row.id),
    onMenu: (row, at) => setMenu({ id: row.id, at }),
  };
  function act(row: Row, action: MenuAction) {
    setMenu(null);
    setProblem(null);
    if (action === 'reference' || action === 'split') {
      sessionAction(row, action);
      return;
    }
    if (action === 'rename') setRenaming(row.id);
    if (action === 'delete') setDeleting({ row, next: nextOf(row) });
    if (action === 'restore' && row.saved) restoreSession(row.saved, false);
    if (action === 'restore') focusRow(row.id);
    if (action !== 'archive') return;
    const next = nextOf(row);
    archiveSession({ tabKey: row.tab?.key, sessionFile: row.file }).then(() => focusRow(next),
      (cause: unknown) => setProblem(`Couldn’t archive this session: ${describe('archive session', cause)}`));
  }
  return { menu, setMenu, renaming, setRenaming, deleting, setDeleting, focused, setFocused, problem, handlers, act };
}

/** @brief 项目 → 会话树与已归档。onNavigate 在打开或切换会话后调用（浮动的左栏据此收起）。 */
export function SessionTree({ onNavigate }: { onNavigate: () => void }) {
  const { groups, shelved, rows, activeRow, others } = useTreeRows();
  const { menu, setMenu, renaming, setRenaming, deleting, setDeleting, focused, setFocused, problem, handlers, act }
    = useTreeActions(onNavigate);
  const menuRow = menu ? rows.find((row) => row.id === menu.id) : undefined;
  const tabStop = rows.find((row) => row.id === focused)?.id ?? activeRow?.id ?? rows[0]?.id;
  return (
    <div className="session-tree" role="tree" aria-label="Sessions" data-testid="session-tree"
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setFocused(null)}>
      <ListNote problem={problem} />
      {groups.map((group) => (
        <ProjectGroup key={group.cwd} cwd={group.cwd} rows={group.rows} activeRow={activeRow} others={others}
          tabStop={tabStop}
          renaming={renaming} {...handlers} onRenamed={(row, keep) => {
            setRenaming(null);
            if (keep) focusRow(row.id);
          }} />
      ))}
      <ArchivedList rows={shelved} tabStop={tabStop} {...handlers} />
      {menu && menuRow && <SessionMenu at={menu.at} row={menuRow} onAction={(action) => act(menuRow, action)}
        onClose={() => { setMenu(null); focusRow(menuRow.id); }} />}
      {deleting && <DeleteDialog row={deleting.row} onClose={(deleted) => {
        setDeleting(null);
        focusRow(deleted ? deleting.next : deleting.row.id);
      }} />}
    </div>
  );
}
