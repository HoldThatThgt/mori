// 输入框下面一行（.composer-bottom）的菜单和浮层共用的行为（docs/v0/screens/models.md"菜单的位置与键盘"、
// "不可用时、按钮消失时的焦点"）：往上打开、以这一行定位；Esc、点外面、Tab 移出时关闭；新的批准卡或询问卡来了时关闭；
// 焦点所在的按钮消失时焦点回到这一栏的文字框。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useOverlay } from '../state/overlays';
import { focusComposer } from '../state/split';
import type { Tab } from '../state/store';
import { useOutsideClose, useTabOutClose } from './menu';

/** 菜单最高（px） */
const MAX_HEIGHT = 440;
/** 菜单上边到顶栏下边至少留的距离加上菜单下边到这一行的距离（px） */
const EDGE = 12;

/** @brief 浮层左右怎样对齐：右边对齐打开它的按钮（放不下时左边贴这一行左端）、对齐这一行左端、对齐这一行右端。 */
export type RowAlign = 'anchor' | 'start' | 'end';

/** @brief 这一行的一个菜单的开关。 */
export interface RowMenu {
  /** 菜单是否打开 */
  open: boolean;
  /** 打开或关闭菜单 */
  setOpen: (open: boolean) => void;
  /** 按钮和菜单外面的容器：在它之外按下鼠标、或焦点 Tab 到它外面时关闭 */
  root: React.RefObject<HTMLDivElement | null>;
  /** 打开菜单的按钮 */
  button: React.RefObject<HTMLButtonElement | null>;
  /** 关闭菜单，焦点回到按钮（选了一项之后） */
  close: () => void;
}

/** @brief 焦点在 root 里（或已经掉到 body 上）时把焦点放回按钮；焦点在别处（例如 F8 报告框）时不动。 */
function refocus(root: React.RefObject<HTMLElement | null>, button: React.RefObject<HTMLElement | null>): void {
  const focused = document.activeElement;
  if (!focused || focused === document.body || root.current?.contains(focused)) button.current?.focus();
}

/**
 * @brief 这一栏来了新的批准卡或询问卡（卡片列表变长）且浮层开着时调用 onArrive。
 * @param open 浮层是否开着
 */
export function useCardArrival(tab: Tab, open: boolean, onArrive: () => void): void {
  const count = tab.transcript.approvals.length + tab.transcript.questions.length;
  const last = useRef(count);
  const latest = useRef(onArrive);
  latest.current = onArrive;
  useEffect(() => {
    if (open && count > last.current) latest.current();
    last.current = count;
  }, [count, open]);
}

/**
 * @brief 卸载时焦点还在 element 里（按钮随状态消失：本轮结束时的"Stop"、清空草稿时的"Queue"、打开失败时的模型按钮等），
 *        把焦点放回这一栏的文字框，不让它掉到 body 上。
 */
export function useFocusFallback(element: React.RefObject<HTMLElement | null>, tabKey: string): void {
  useLayoutEffect(() => {
    const node = element.current;
    return () => {
      if (node?.contains(document.activeElement)) focusComposer(tabKey);
    };
  }, [element, tabKey]);
}

/**
 * @brief 有 Stop agents 时 chat.css 按栏宽把 root 里的排队按钮藏起（≤ 520px 的"Queue"、≤ 340px 整组，models.md"窄栏"，
 *        display: none）：Stop agents 出现时，以及之后栏宽跨过这些宽度时（拖分隔线、改窗口：root 的大小随之变），先调
 *        onHidden（root 自己被藏起时，例如关上"Queue"的下拉），焦点在一个藏起的元素上时放回这一栏的文字框
 *        （不让它掉到 body 上；浮层还开着时 focusComposer 等它关上）。Chromium 的焦点修正常常先于 ResizeObserver：
 *        藏起的按钮先失去焦点（focusout，relatedTarget 为 null，焦点到了 body），所以也按 focusout 的目标查。
 * @param stopTeam Stop agents 是否显示（tab.team.background）
 */
export function useHiddenFallback(root: React.RefObject<HTMLElement | null>, tabKey: string, stopTeam: boolean,
  onHidden?: () => void): void {
  const latest = useRef(onHidden);
  latest.current = onHidden;
  useLayoutEffect(() => {
    const node = root.current;
    if (!stopTeam || !node) return;
    const hidden = (element: Element) => element.getClientRects().length === 0;
    const check = () => {
      if (hidden(node)) latest.current?.();
      const focused = document.activeElement;
      if (focused && node.contains(focused) && hidden(focused)) focusComposer(tabKey);
    };
    // 焦点没有移到别的元素上、失去焦点的元素已经藏起：是焦点修正把它移到了 body（点空白处时元素还看得见，不动）
    const blurred = (event: FocusEvent) => {
      if (event.relatedTarget !== null || !(event.target instanceof Element) || !hidden(event.target)) return;
      if (hidden(node)) latest.current?.();
      focusComposer(tabKey);
    };
    check();
    // 栏宽变了（藏起时 root 的大小变为 0，"Queue"收起时变窄）：再查一次（2026-10-26 覆盖补测，原来只在 Stop agents 出现时查）
    const observer = new ResizeObserver(check);
    observer.observe(node);
    node.addEventListener('focusout', blurred);
    return () => {
      observer.disconnect();
      node.removeEventListener('focusout', blurred);
    };
  }, [root, tabKey, stopTeam]);
}

/**
 * @brief 这一行的菜单（选择范围、Effort、权限、"Queue"的下拉）的开关：算作挡住快捷键的浮层；Esc 关闭，焦点在菜单里时
 *        还给按钮（在理由框等别处时不动）；点外面、Tab 移出时关闭；按钮变得不可用、新的卡片来了时关闭，焦点在菜单里时
 *        回到按钮；整个按钮消失时焦点回到文字框。
 * @param unavailable 按钮不可用（准备中、生成中、不能发送）
 */
export function useRowMenu(tab: Tab, unavailable: boolean): RowMenu {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const dismiss = () => {
    setOpen(false);
    refocus(root, button);
  };
  useOverlay(open, dismiss);
  useOutsideClose(open, root, () => setOpen(false));
  useTabOutClose(open, root, () => setOpen(false));
  useCardArrival(tab, open, dismiss);
  useFocusFallback(root, tab.key);
  useEffect(() => {
    if (!unavailable) return;
    setOpen(false);
    if (root.current?.querySelector('[role="menu"]')?.contains(document.activeElement)) button.current?.focus();
  }, [unavailable]);
  return { open, setOpen, root, button, close };
}

/** @brief 按这一行和按钮的位置摆一个浮层：往上打开、左右按 align、不超出这一行，最高到顶栏下面。 */
function placeInRow(row: HTMLElement, anchor: HTMLElement, popover: HTMLElement, align: RowAlign): void {
  const box = row.getBoundingClientRect();
  const topbar = row.closest('.chat-pane')?.querySelector(':scope > .topbar');
  const ceiling = topbar?.getBoundingClientRect().bottom ?? 0;
  // 先放到左端再量宽度：宽度随内容的浮层（悬停提示、"Queue"的下拉）在靠右时会被挤窄。
  // 最宽是这一行；浮层自己另有上限时写在 --row-max-width 里（换范围失败那一行 320px）
  popover.style.left = '0px';
  popover.style.maxWidth = `min(var(--row-max-width, ${box.width}px), ${box.width}px)`;
  popover.style.maxHeight = `${Math.max(0, Math.min(MAX_HEIGHT, box.top - ceiling - EDGE))}px`;
  const width = popover.getBoundingClientRect().width;
  const anchorRight = anchor.getBoundingClientRect().right - box.left;
  const left = align === 'start' ? 0 : align === 'end' ? box.width - width : Math.max(0, anchorRight - width);
  popover.style.left = `${left}px`;
}

/**
 * @brief 打开期间把浮层摆在这一行上方（以 .composer-bottom 定位）；这一行或窗口的大小变了、content 变了时重摆。
 * @param anchor 打开它的按钮
 * @param popover 浮层
 * @param content 浮层的内容（文字变了宽度会变，要重摆）
 */
export function useRowPlacement(open: boolean, anchor: React.RefObject<HTMLElement | null>,
  popover: React.RefObject<HTMLElement | null>, align: RowAlign, content?: string): void {
  useLayoutEffect(() => {
    const row = anchor.current?.closest<HTMLElement>('.composer-bottom');
    if (!open || !row) return;
    const place = () => {
      if (anchor.current && popover.current) placeInRow(row, anchor.current, popover.current, align);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(row);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, anchor, popover, align, content]);
}
