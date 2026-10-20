// 浮层栈：Esc 先关闭最上层的浮层、菜单或对话框，没有浮层时才轮到停止（方案 5.8）。
// 选区浮层（M4）也在栈里，但不算"挡住"：它开着时 Alt+数字、Ctrl+N 照常可用（它不盖住批准卡）。

import { useEffect, useRef } from 'react';

/** 关闭一个浮层；返回 false 表示它现在不能关（例如报告框保存中），留在栈里 */
type Close = () => boolean | void;

/** @brief 栈里的一个浮层。 */
interface Entry {
  /** 关闭它 */
  close: Close;
  /** 是否挡住背后的快捷键（Alt+数字、Ctrl+N） */
  blocking: boolean;
}

const stack: Entry[] = [];

/**
 * @brief 打开期间把浮层压进栈；关闭或卸载时移出。close 返回 false 时这次不关，浮层留在栈顶。
 * @param blocking 为 false 时只参与 Esc，不挡住背后的快捷键（选区浮层）
 */
export function useOverlay(open: boolean, close: Close, blocking = true): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const entry: Entry = { close: () => latest.current(), blocking };
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [open, blocking]);
}

/** @brief 是否有开着的、挡住背后快捷键的浮层、菜单或对话框。 */
export function hasOverlay(): boolean {
  return stack.some((entry) => entry.blocking);
}

/** @brief 关闭最上层的浮层；没有浮层时返回 false。浮层拒绝关闭时也算处理了这次按键。 */
export function closeTopOverlay(): boolean {
  const top = stack.at(-1);
  if (!top) return false;
  if (top.close() === false) return true;
  const index = stack.lastIndexOf(top);
  if (index >= 0) stack.splice(index, 1);
  return true;
}
