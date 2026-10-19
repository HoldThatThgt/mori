// 浮层栈：Esc 先关闭最上层的浮层、菜单或对话框，没有浮层时才轮到停止（方案 5.8）。

import { useEffect, useRef } from 'react';

const stack: Array<() => void> = [];

/** @brief 打开期间把浮层压进栈；关闭或卸载时移出。 */
export function useOverlay(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const entry = () => latest.current();
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [open]);
}

/** @brief 关闭最上层的浮层；没有浮层时返回 false。 */
export function closeTopOverlay(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top();
  return true;
}
