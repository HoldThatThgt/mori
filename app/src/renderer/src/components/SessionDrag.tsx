// 拖会话（docs/v0/screens/split.md "拖会话到中栏"、session-refs.md "加入引用"）：侧栏的会话行和分屏标题行上的会话名
// 可以拖；拖到某一栏的输入框上是引用，拖到中栏左半边或右半边是分屏，拖已在中栏的会话只切焦点。
// 交互移植自 demo/session-actions.js（浏览器原生拖放；放下前浮一层提示，不挡住拖放；拖动取消时 dragend 清掉提示）。

import { useEffect } from 'react';
import { create } from 'zustand';
import type { SavedSession } from '../../../shared/protocol';
import { recordAction } from '../state/actionLog';
import { openSaved } from '../state/projects';
import { referenceSession } from '../state/refActions';
import { focusComposer, focusPane, openInSplit, type Side } from '../state/split';
import { sameFile, shownKeys, tabByFile, useApp, type AppState } from '../state/store';

/** 拖放数据的类型：只认 Mori 自己页面里的会话 */
const SESSION_TYPE = 'application/x-mori-session';

/** @brief 被拖的会话。 */
export interface DragSource {
  /** 本次打开过的会话的标识；没打开过时为 undefined */
  tabKey?: string;
  /** 会话列表里的会话（没打开过的从这里打开） */
  saved?: SavedSession;
  /** 会话文件；还没打开完的新会话为 null */
  file: string | null;
  /** 显示的会话名 */
  title: string;
  /** 有没有你的消息（没有时不能引用） */
  hasMessages: boolean;
}

/** @brief 放下的地方和提示。 */
interface DropTarget {
  /** 引用到输入框 / 在一侧分屏打开 / 只切焦点 / 中栏没有会话时打开 */
  kind: 'reference' | 'split' | 'focus' | 'open';
  /** 输入框或已在中栏的那一栏（界面里的会话标识） */
  tabKey?: string;
  /** 分屏的哪一侧 */
  side?: Side;
  /** 提示盖住的区域 */
  rect: { left: number; top: number; width: number; height: number };
  /** 提示文字 */
  text: string;
}

/** @brief 正在拖的会话和现在的放下目标。 */
const useDrag = create<{ source: DragSource | null; target: DropTarget | null }>(() => ({ source: null,
  target: null }));

/** @brief 会话行、标题行上拖动用的属性。 */
export function dragProps(source: DragSource | null) {
  return {
    draggable: source !== null,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      if (!source) return;
      event.dataTransfer.setData(SESSION_TYPE, source.file ?? source.tabKey ?? '');
      event.dataTransfer.effectAllowed = 'copyMove';
      useDrag.setState({ source, target: null });
    },
    onDragEnd: () => useDrag.setState({ source: null, target: null }),
  };
}

/** @brief 被拖的会话在界面里的标识（本次打开过的）。 */
function sourceKey(source: DragSource): string | undefined {
  return source.tabKey ?? (source.file ? tabByFile(source.file)?.key : undefined);
}

/** @brief 一个元素的矩形（提示盖住的区域）。 */
function rectOf(element: Element, part?: Side) {
  const { left, top, width, height } = element.getBoundingClientRect();
  if (!part) return { left, top, width, height };
  return { left: part === 'left' ? left : left + width / 2, top, width: width / 2, height };
}

/** @brief 一栏的元素。 */
function slotOf(key: string): Element | null {
  return document.querySelector(`.pane-slot[data-tab="${CSS.escape(key)}"]`);
}

/** @brief 鼠标下的输入框：拖的不是这一栏的会话、它有消息时是引用目标。 */
function composerTarget(element: Element, source: DragSource, state: AppState): DropTarget | null {
  const composer = element.closest<HTMLElement>('[data-drop="composer"]');
  const tab = composer && state.tabs.find((item) => item.key === composer.dataset.tab);
  if (!composer || !tab || !source.hasMessages || !source.file) return null;
  if (sourceKey(source) === tab.key || sameFile(tab.sessionFile, source.file)) return null;
  return { kind: 'reference', tabKey: tab.key, rect: rectOf(composer), text: '松开以引用到这个会话' };
}

/** @brief 鼠标下的放下目标；不能放下时为 null。 */
function targetAt(event: DragEvent, source: DragSource): DropTarget | null {
  const state = useApp.getState();
  const element = event.target instanceof Element ? event.target : null;
  const center = element?.closest('.center');
  if (state.view !== 'chat' || !element || !center) return null;
  const reference = composerTarget(element, source, state);
  if (reference) return reference;
  const shown = shownKeys(state).filter((key) => state.tabs.some((tab) => tab.key === key));
  const key = sourceKey(source);
  const slot = key && shown.includes(key) ? slotOf(key) : null;
  if (key && slot) return { kind: 'focus', tabKey: key, rect: rectOf(slot), text: '已经打开 · 松开切换到这一栏' };
  // 拖到输入框上不会分屏（session-refs.md 反例）：不能引用的会话（还没有消息）在输入框上不能放下。
  if (element.closest('[data-drop="composer"]')) return null;
  if (shown.length === 0) return { kind: 'open', rect: rectOf(center), text: '松开以打开这个会话' };
  const box = center.getBoundingClientRect();
  const side: Side = event.clientX < box.left + box.width / 2 ? 'left' : 'right';
  const paneSlot = state.split ? slotOf(side === 'left' ? state.split[0] : state.split[1]) : null;
  return { kind: 'split', side, rect: paneSlot ? rectOf(paneSlot) : rectOf(center, side),
    text: `松开以在${side === 'left' ? '左' : '右'}侧分屏打开` };
}

/** @brief 在一侧分屏打开被拖的会话（没打开过的先打开）；之后焦点进它的输入框。 */
async function openAt(source: DragSource, side: Side): Promise<void> {
  const key = sourceKey(source);
  if (key) openInSplit(key, side);
  else if (source.saved) await openSaved(source.saved, side);
  focusComposer();
}

/** @brief 放下：引用、分屏、切焦点或打开。 */
function drop(source: DragSource, target: DropTarget): void {
  if (target.kind === 'reference' && target.tabKey && source.file) {
    void referenceSession(target.tabKey, source.file, source.title);
  } else if (target.kind === 'focus' && target.tabKey) {
    recordAction('拖已打开的会话到中栏');
    focusPane(target.tabKey);
    focusComposer(target.tabKey);
  } else {
    void openAt(source, target.side ?? 'right');
  }
}

/** @brief 整个窗口上的拖放：拖到哪里显示哪种提示，放下时执行。只认 Mori 自己页面里拖起来的会话。 */
export function useSessionDrop(): void {
  useEffect(() => {
    const over = (event: DragEvent) => {
      const { source } = useDrag.getState();
      if (!source || !event.dataTransfer?.types.includes(SESSION_TYPE)) return;
      const target = targetAt(event, source);
      useDrag.setState({ target });
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = target.kind === 'reference' ? 'copy' : 'move';
    };
    const onDrop = (event: DragEvent) => {
      const { source } = useDrag.getState();
      const target = source ? targetAt(event, source) : null;
      useDrag.setState({ source: null, target: null });
      if (!source || !target) return;
      event.preventDefault();
      drop(source, target);
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) useDrag.setState({ target: null });
    };
    document.addEventListener('dragover', over);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragleave', leave);
    return () => {
      document.removeEventListener('dragover', over);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('dragleave', leave);
    };
  }, []);
}

/** @brief 放下前的提示：盖在目标上的一层，不挡住拖放。 */
export function DropHint() {
  const target = useDrag((state) => state.target);
  if (!target) return null;
  const { left, top, width, height } = target.rect;
  return (
    <div className={`drop-hint ${target.kind}`} data-testid="drop-hint" data-kind={target.kind} aria-hidden="true"
      style={{ left: left + 5, top: top + 5, width: Math.max(0, width - 10), height: Math.max(0, height - 10) }}>
      {target.text}
    </div>
  );
}

/** @brief 正在被拖的会话（会话行据此变淡）。 */
export function useDragging(file: string | null, tabKey?: string): boolean {
  return useDrag((state) => Boolean(state.source && ((tabKey && state.source.tabKey === tabKey)
    || (file && sameFile(state.source.file, file)))));
}
