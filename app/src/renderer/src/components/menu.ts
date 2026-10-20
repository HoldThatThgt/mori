// 菜单共用的键盘与鼠标行为：↑ ↓ 在可用的菜单项之间移动焦点；在菜单之外按下鼠标时关闭。

import { useEffect, useRef } from 'react';

/** @brief 菜单里用 ↑ ↓ 在可用的按钮之间移动焦点（首尾循环）。 */
export function moveMenuFocus(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  items[(index + step + items.length) % items.length]?.focus();
}

/** 盖住整个窗口的对话框（确认框、信任询问、F8 报告框）的遮罩 */
const MODAL = '.dialog-backdrop, .issue-backdrop';

/**
 * @brief 打开期间，在 root 之外按下鼠标时调用 close。按在盖在上面的对话框里不算（例如菜单开着时按了 F8，
 *        在报告框里点击不能关掉后面的菜单、也不能把焦点抢回去）。
 */
export function useOutsideClose(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (root.current?.contains(target)) return;
      if (target.closest?.(MODAL) && !root.current?.closest(MODAL)) return;
      latest.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, root]);
}
