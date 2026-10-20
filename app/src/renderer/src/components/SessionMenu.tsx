// 会话行的右键菜单（docs/v0/screens/sessions.md "右键菜单"）：重命名、归档、删除；已归档的会话是恢复、删除。
// 贴着会话行（或鼠标位置），放不下时往上、往左挪；↑ ↓ 移动，Enter 执行，Esc、Tab 或点别处关闭。

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';
import { moveMenuFocus, useOutsideClose } from './menu';
import { isBusy, isUnsaved, type Row } from './sessionRows';

/** @brief 菜单项。 */
export type MenuAction = 'rename' | 'archive' | 'restore' | 'delete';

/** @brief 一个菜单项：文字，以及不能用时的原因（能用时为 null）。 */
interface MenuItem {
  /** 操作 */
  action: MenuAction;
  /** 文字 */
  label: string;
  /** 不能用的原因 */
  blocked: string | null;
}

/** @brief 这一行的菜单项。 */
function menuItems(row: Row): MenuItem[] {
  if (row.archived) {
    return [{ action: 'restore', label: '恢复', blocked: null }, { action: 'delete', label: '删除', blocked: null }];
  }
  const opening = row.tab?.phase === 'opening' ? '正在打开' : null;
  const busy = opening ?? (isBusy(row) ? '正在生成' : null);
  const unsaved = isUnsaved(row) ? '还没有消息' : null;
  return [{ action: 'rename', label: '重命名', blocked: opening },
    { action: 'archive', label: '归档', blocked: busy ?? unsaved },
    { action: 'delete', label: '删除', blocked: busy }];
}

/** @brief 右键菜单。 */
export function SessionMenu({ at, row, onAction, onClose }: {
  at: { x: number; y: number }; row: Row; onAction: (action: MenuAction) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);
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
    <div ref={menu} className="menu session-menu" role="menu" aria-label="会话" data-testid="session-menu"
      style={{ left: position.x, top: position.y }} onKeyDown={onKeyDown}>
      {menuItems(row).map((item) => (
        <button key={item.action} role="menuitem" disabled={item.blocked !== null}
          onClick={() => onAction(item.action)}>
          {item.label}{item.blocked && <span className="menu-hint">{item.blocked}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
