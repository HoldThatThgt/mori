// 菜单共用的键盘与鼠标行为：↑ ↓ 在可用的菜单项之间移动焦点；在菜单之外按下鼠标、或 Tab 到菜单外面时关闭。

import { useEffect, useRef } from 'react';

/** @brief 看得见（没有被 CSS 藏起）的元素：窄栏里藏起的菜单项（"Queue for later"）不参与 ↑ ↓。 */
function shown(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

/** @brief 菜单里第一个可用、看得见的按钮；没有时为 undefined。 */
export function firstMenuItem(menu: HTMLElement | null): HTMLElement | undefined {
  return [...(menu?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])].find(shown);
}

/** @brief 菜单里用 ↑ ↓ 在可用、看得见的按钮之间移动焦点（首尾循环）。 */
export function moveMenuFocus(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')].filter(shown);
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

/**
 * @brief 打开期间，键盘焦点从 root 移到外面一个能停焦点的元素上时调用 close（docs/v0/screens/models.md
 *        "Tab 移出时关闭"）。焦点去了盖住窗口的对话框（F8 报告框）、或没有新的焦点（点了菜单里不能停焦点的文字、
 *        切到别的程序）时不关。
 */
export function useTabOutClose(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const element = root.current;
    if (!open || !element) return;
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Element | null;
      if (!next || element.contains(next) || next.closest(MODAL)) return;
      latest.current();
    };
    element.addEventListener('focusout', onFocusOut);
    return () => element.removeEventListener('focusout', onFocusOut);
  }, [open, root]);
}
