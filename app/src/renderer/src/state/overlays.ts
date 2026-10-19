// 浮层栈：Esc 先关闭最上层的浮层、菜单或对话框，没有浮层时才轮到停止（方案 5.8）。

import { useEffect, useRef } from 'react';

/** 关闭一个浮层；返回 false 表示它现在不能关（例如报告框保存中），留在栈里 */
type Close = () => boolean | void;

const stack: Close[] = [];

/** @brief 打开期间把浮层压进栈；关闭或卸载时移出。close 返回 false 时这次不关，浮层留在栈顶。 */
export function useOverlay(open: boolean, close: Close): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const entry: Close = () => latest.current();
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [open]);
}

/** @brief 是否有开着的浮层、菜单或对话框。 */
export function hasOverlay(): boolean {
  return stack.length > 0;
}

/** @brief 关闭最上层的浮层；没有浮层时返回 false。浮层拒绝关闭时也算处理了这次按键。 */
export function closeTopOverlay(): boolean {
  const top = stack.at(-1);
  if (!top) return false;
  if (top() === false) return true;
  const index = stack.lastIndexOf(top);
  if (index >= 0) stack.splice(index, 1);
  return true;
}
