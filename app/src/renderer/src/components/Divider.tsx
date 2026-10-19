// 可拖动的分隔线：指针拖动、← → 每次 20px、双击恢复默认。行为移植自 demo/resize.js。

import { useRef } from 'react';
import { clamp, defaultWidth, type DividerKind } from '../state/layout';

/** @brief 分隔线的输入。 */
interface DividerProps {
  /** 哪一条 */
  kind: DividerKind;
  /** 无障碍名称 */
  label: string;
  /** 当前实际宽度 */
  value: number;
  /** 当前允许的范围；为 null 时空间不够，分隔线隐藏 */
  limits: { min: number; max: number } | null;
  /** 宽度变化；commit 为真时保存 */
  onChange: (value: number, commit: boolean) => void;
}

/** @brief 指针拖动：按下时捕获指针，移动时改宽度（不保存），松开、取消或失去捕获时保存。 */
function useDrag(kind: DividerKind, value: number, limits: DividerProps['limits'], onChange: DividerProps['onChange']) {
  const drag = useRef<{ pointerId: number; startX: number; startValue: number; last: number } | null>(null);
  const direction = kind === 'workspace' ? -1 : 1;

  function finish(element: HTMLElement) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    element.closest('.app')?.classList.remove('is-resizing');
    element.removeAttribute('data-resizing');
    if (element.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
    onChange(current.last, true);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const element = event.currentTarget;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, last: value };
    element.closest('.app')?.classList.add('is-resizing');
    element.setAttribute('data-resizing', '');
    element.focus({ preventScroll: true });
    window.getSelection()?.removeAllRanges();
    element.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId || !limits) return;
    event.preventDefault();
    current.last = clamp(current.startValue + (event.clientX - current.startX) * direction, limits);
    onChange(current.last, false);
  }

  return { dragging: () => drag.current !== null, finish, onPointerDown, onPointerMove, direction };
}

/** @brief 一条垂直分隔线；右栏的分隔线向左拖是变宽。 */
export function Divider({ kind, label, value, limits, onChange }: DividerProps) {
  const { dragging, finish, onPointerDown, onPointerMove, direction } = useDrag(kind, value, limits, onChange);
  if (!limits) return null;

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && dragging()) {
      finish(event.currentTarget);
      return;
    }
    if (!limits || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const step = (event.key === 'ArrowRight' ? 20 : -20) * direction;
    onChange(clamp(value + step, limits), true);
  }

  return (
    <div data-resize={kind} role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical"
      aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={value} aria-valuetext={`${value} 像素`}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event.currentTarget)} onPointerCancel={(event) => finish(event.currentTarget)}
      onLostPointerCapture={(event) => finish(event.currentTarget)} onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(clamp(defaultWidth(kind), limits), true)} />
  );
}
