// 会话面板标题行上的会话名（docs/v0/screens/split.md）：可以拖（到另一栏的输入框是引用，到中栏另一侧是分屏），
// 右键打开与侧栏相同的会话菜单；重命名就在这里改。它不占 Tab 停靠点（M3 起"从输入框 Shift+Tab 回到会话树"的路径不变），
// 键盘用侧栏会话行上的同一个菜单。删除确认框挂在面板之外（PaneDeleteDialog）：删除时这一栏会关闭，确认框要留着显示失败的原文。

import { useRef, useState } from 'react';
import { create } from 'zustand';
import { describe } from '../state/bridge';
import { archiveSession } from '../state/projects';
import { focusComposer } from '../state/split';
import { useApp, type Tab } from '../state/store';
import { sessionTitle } from './ChatPane';
import { DeleteDialog, RenameInput } from './SessionEdits';
import { dragProps } from './SessionDrag';
import { SessionMenu, type MenuAction } from './SessionMenu';
import { buildRows, isUnsaved, type Row } from './sessionRows';
import { sessionAction } from './SessionTree';

/** @brief 从标题行菜单要删除的会话（它所在的一栏）；没有时为 null。 */
const usePaneDelete = create<{ row: Row | null; tabKey: string | null }>(() => ({ row: null, tabKey: null }));

/** @brief 这个会话在侧栏里的那一行（菜单、改名、删除用同样的数据）。 */
function useTabRow(tab: Tab): Row {
  const sessions = useApp((state) => state.saved.sessions);
  const archived = useApp((state) => state.archived);
  const marks = useApp((state) => state.rowMarks);
  return buildRows([tab], sessions, { archived, marks })[0]!;
}

/** @brief 标题行菜单的状态与操作：菜单、改名框、归档失败的原文；删除交给面板之外的确认框。 */
function useTitleMenu(tab: Tab, row: Row) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  function act(action: MenuAction) {
    setMenu(null);
    setProblem(null);
    if (action === 'rename') setRenaming(true);
    if (action === 'delete') usePaneDelete.setState({ row, tabKey: tab.key });
    if (action === 'reference' || action === 'split') sessionAction(row, action);
    if (action !== 'archive') return;
    archiveSession({ tabKey: tab.key, sessionFile: tab.sessionFile }).then(() => focusComposer(),
      (cause: unknown) => setProblem(`Couldn’t archive this session: ${describe('archive session', cause)}`));
  }
  return { menu, setMenu, renaming, setRenaming, problem, act };
}

/** 会话名按钮的悬停说明 */
const TITLE_HINT = 'Right-click for the session menu. Drag to the other pane’s message box to attach it as context, '
  + 'or to one side to open it in split view.';

/** @brief 标题行上的会话名。 */
export function PaneTitle({ tab }: { tab: Tab }) {
  const button = useRef<HTMLButtonElement>(null);
  const row = useTabRow(tab);
  const { menu, setMenu, renaming, setRenaming, problem, act } = useTitleMenu(tab, row);
  const source = { tabKey: tab.key, file: tab.sessionFile, title: row.title, hasMessages: !isUnsaved(row) };
  function onContextMenu(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY }
      : { x: rect.left + 12, y: rect.bottom + 2 });
  }
  return (
    <>
      {renaming ? <RenameInput row={row} onDone={() => setRenaming(false)} /> : (
        <button ref={button} className="chat-title" data-testid="session-title" title={TITLE_HINT} tabIndex={-1}
          {...dragProps(source)} onContextMenu={onContextMenu}>{sessionTitle(tab)}</button>
      )}
      {problem && <span className="pane-title-problem" role="alert">{problem}</span>}
      {menu && <SessionMenu at={menu} row={row} onAction={act} onClose={() => setMenu(null)} />}
    </>
  );
}

/** @brief 从标题行菜单删除会话的确认框：挂在面板之外，删除时这一栏关闭，确认框照常显示进度和失败的原文。 */
export function PaneDeleteDialog() {
  const { row, tabKey } = usePaneDelete();
  if (!row) return null;
  return (
    <DeleteDialog row={row} onClose={(deleted) => {
      usePaneDelete.setState({ row: null, tabKey: null });
      focusComposer(deleted ? undefined : tabKey ?? undefined);
    }} />
  );
}
