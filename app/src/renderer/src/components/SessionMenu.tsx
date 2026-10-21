// 会话行的右键菜单（docs/v0/screens/sessions.md "右键菜单"）："Rename"、"Attach as context"、"Open in split view"（M5）、
// "Archive"、"Delete…"；已归档的会话是"Unarchive"、"Delete…"。分屏标题行上的会话名用同一个菜单。
// 贴着会话行（或鼠标位置），放不下时往上、往左挪；↑ ↓ 移动，Enter 执行，Esc、Tab 或点别处关闭。

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';
import { sameFile, useApp, type AppState } from '../state/store';
import { moveMenuFocus, useOutsideClose } from './menu';
import { isBusy, isUnsaved, type Row } from './sessionRows';

/** @brief 菜单项。 */
export type MenuAction = 'rename' | 'reference' | 'split' | 'archive' | 'restore' | 'delete';

/** @brief 一个菜单项：文字，以及不能用时的原因（能用时为 null）。 */
interface MenuItem {
  /** 操作 */
  action: MenuAction;
  /** 文字 */
  label: string;
  /** 不能用的原因 */
  blocked: string | null;
}

/** @brief "Attach as context"不能用的原因（docs/v0/screens/session-refs.md）；能用时为 null。 */
function referenceBlocked(row: Row, state: AppState): string | null {
  const current = state.view === 'chat' ? state.tabs.find((tab) => tab.key === state.activeKey) : undefined;
  if (!current) return 'No active session';
  if (row.tab?.key === current.key || sameFile(row.file, current.sessionFile)) return 'This is the current session';
  return isUnsaved(row) || !row.file ? 'No messages yet' : null;
}

/** @brief "Open in split view"不能用的原因：这一行就是单栏里显示的会话（docs/v0/screens/split.md）。 */
function splitBlocked(row: Row, state: AppState): string | null {
  return !state.split && state.view === 'chat' && row.tab && row.tab.key === state.activeKey ? 'Already open' : null;
}

/** @brief 这一行的菜单项。 */
function menuItems(row: Row, state: AppState): MenuItem[] {
  if (row.archived) {
    return [{ action: 'restore', label: 'Unarchive', blocked: null },
      { action: 'delete', label: 'Delete…', blocked: null }];
  }
  const opening = row.tab?.phase === 'opening' ? 'Opening…' : null;
  const busy = opening ?? (isBusy(row) ? 'Still running' : null);
  const unsaved = isUnsaved(row) ? 'No messages yet' : null;
  return [{ action: 'rename', label: 'Rename', blocked: opening },
    { action: 'reference', label: 'Attach as context', blocked: referenceBlocked(row, state) },
    { action: 'split', label: 'Open in split view', blocked: splitBlocked(row, state) },
    { action: 'archive', label: 'Archive', blocked: busy ?? unsaved },
    { action: 'delete', label: 'Delete…', blocked: busy }];
}

/** @brief 右键菜单。 */
export function SessionMenu({ at, row, onAction, onClose }: {
  at: { x: number; y: number }; row: Row; onAction: (action: MenuAction) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);
  const items = menuItems(row, useApp());
  useOverlay(true, onClose);
  useOutsideClose(true, menu, onClose);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({ x: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - height - 4)) });
    element.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [at]);
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    moveMenuFocus(event);
  }
  return createPortal(
    <div ref={menu} className="menu session-menu" role="menu" aria-label="Session actions" data-testid="session-menu"
      style={{ left: position.x, top: position.y }} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button key={item.action} role="menuitem" disabled={item.blocked !== null}
          onClick={() => onAction(item.action)}>
          {item.label}{item.blocked && <span className="menu-hint">{item.blocked}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
