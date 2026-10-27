// 你的消息上的 Rewind 与它的菜单（docs/specs/file-system.md §5.5，状态表 docs/v1/screens/fs-rewind.md "消息上的 Rewind"、
// "菜单"）。按钮是文字按钮 Rewind，一直在 Tab 顺序里，悬停在消息上或消息里的元素有键盘焦点时才看得见（rewind.css）；
// 会话忙时 aria-disabled、悬停 Still running。菜单贴着按钮弹出（挂到 body 上，跟着按钮的位置），四种情况由 state/rewind.ts 的
// rewindMenu 算：选项、不可选的 No code restore（次要文字色）、Never mind，需求还开着时最后一行说明。↑ ↓ 移动、Enter 选；
// Never mind、Esc、Tab、点别处关掉，焦点回到 Rewind。

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';
import {
  neverMind, REWIND_TITLE, rewindMenu, rewindTo, STILL_RUNNING, type RewindChoice, type RewindItemId,
} from '../state/rewind';
import { useApp } from '../state/store';
import { firstMenuItem, moveMenuFocus } from './menu';
import '../styles/rewind.css';

/** 菜单离按钮的距离（px） */
const MENU_GAP = 4;
/** 菜单离窗口边缘至少留的距离（px） */
const EDGE = 4;

/** @brief 菜单的位置：按钮下方、右边与按钮对齐；下面放不下时放到按钮上方；不超出窗口。 */
function menuPosition(button: HTMLElement, menu: HTMLElement): { left: number; top: number } {
  const anchor = button.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const below = anchor.bottom + MENU_GAP;
  const top = below + height <= window.innerHeight - EDGE ? below : anchor.top - MENU_GAP - height;
  return { left: Math.max(EDGE, Math.min(anchor.right - width, window.innerWidth - width - EDGE)),
    top: Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE)) };
}

/**
 * @brief 菜单一直贴着按钮：打开时、对话流滚动、窗口改变大小或菜单自己变了大小（例如需求的说明出现）时重新算位置。
 */
function useMenuPlacement(button: React.RefObject<HTMLElement | null>, menu: React.RefObject<HTMLElement | null>) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      if (button.current && menu.current) setPosition(menuPosition(button.current, menu.current));
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [button, menu]);
  return position;
}

/** 盖住整个窗口的对话框（F8 报告框等）的遮罩：在它们里面按下鼠标不关菜单（同 menu.ts 的 useOutsideClose） */
const MODAL = '.dialog-backdrop, .issue-backdrop';

/**
 * @brief 在菜单与 Rewind 按钮之外按下鼠标时关掉菜单。按钮不算外面：按在按钮上由按钮自己的点击收起菜单，
 *        否则按下时先关、松开后的点击又把它打开。
 */
function useOutsidePress(panel: React.RefObject<HTMLElement | null>, button: React.RefObject<HTMLElement | null>,
  close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      if (target.closest?.(MODAL)) return;
      latest.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [panel, button]);
}

/** @brief 菜单的属性。 */
interface RewindMenuProps {
  /** 会话的 key */
  tabKey: string;
  /** 你那条消息的条目 id */
  entryId: string;
  /** 打开它的 Rewind 按钮（定位用） */
  button: React.RefObject<HTMLButtonElement | null>;
  /** 选了一项（三个选项之一或 Never mind） */
  onChoose: (id: RewindChoice | 'cancel') => void;
  /** 不选就关掉（Tab、点别处） */
  onClose: () => void;
}

/** @brief 菜单本身：按 rewindMenu 的各行显示；打开时焦点在第一个能选的项上。 */
function RewindMenuPanel({ tabKey, entryId, button, onChoose, onClose }: RewindMenuProps) {
  const tab = useApp((state) => state.tabs.find((item) => item.key === tabKey));
  const panel = useRef<HTMLDivElement>(null);
  const noteId = useId();
  const position = useMenuPlacement(button, panel);
  useOutsidePress(panel, button, onClose);
  // 位置在同一次提交里算好（绘制之前），第一次渲染时透明但能取得焦点
  useLayoutEffect(() => {
    firstMenuItem(panel.current)?.focus();
  }, []);
  if (!tab) return null;
  const menu = rewindMenu(tab, entryId);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') {
      moveMenuFocus(event);
      return;
    }
    event.preventDefault();
    onClose();
  };
  const style: React.CSSProperties = position ? { left: position.left, top: position.top }
    : { left: 0, top: 0, opacity: 0 };
  return createPortal(
    <div ref={panel} className="menu rewind-menu" role="menu" aria-label="Rewind" data-testid="rewind-menu"
      aria-describedby={menu.blocked ? noteId : undefined} style={style} onKeyDown={onKeyDown}>
      {menu.items.map((item) => (item.id === 'no-code'
        ? <div key={item.id} className="rewind-no-code" role="menuitem" aria-disabled="true"
          data-testid="rewind-no-code">{item.label}</div>
        : (
          <button key={item.id} role="menuitem" data-testid={`rewind-${item.id}`} disabled={item.disabled}
            onClick={() => onChoose(item.id as Exclude<RewindItemId, 'no-code'>)}>{item.label}</button>
        )))}
      {menu.blocked && (
        <p id={noteId} className="menu-note rewind-blocked" data-testid="rewind-blocked"
          data-requests={menu.blocked.requests.join(',')}>{menu.blocked.text}</p>
      )}
    </div>,
    document.body,
  );
}

/**
 * @brief 消息上的 Rewind 和它的菜单。会话忙时不可点（点了不开菜单），开着的菜单关掉。
 * @param disabled 会话忙（任何 Agent 在运行、排队，有待判断的消息，或正在 Rewind / Undo）
 */
export function RewindButton({ tabKey, entryId, disabled }: { tabKey: string; entryId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  const choose = (id: RewindChoice | 'cancel') => {
    close();
    if (id === 'cancel') neverMind();
    else void rewindTo(tabKey, entryId, id);
  };
  // Esc 等于 Never mind（App 的全局 Esc 先关最上层的浮层）
  useOverlay(open, () => {
    close();
    neverMind();
  });
  // 菜单开着时会话变忙（后台 Agent 开始、别的栏开始运行等）：同样经 close() 关掉，焦点回到 Rewind 而不是掉到 body
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);
  return (
    <div className="user-actions" data-no-quote>
      <button ref={button} className="rewind-button" data-testid="rewind-button" data-entry={entryId}
        aria-disabled={disabled ? true : undefined} aria-haspopup="menu" aria-expanded={open}
        title={disabled ? STILL_RUNNING : REWIND_TITLE} onClick={() => { if (!disabled) setOpen(!open); }}>
        Rewind
      </button>
      {open && <RewindMenuPanel tabKey={tabKey} entryId={entryId} button={button} onChoose={choose}
        onClose={close} />}
    </div>
  );
}
