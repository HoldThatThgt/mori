// 设置 → Models 的拖动排序（docs/specs/model-providers.md §9.1“拖动排序”；2026-10-26 负责人走查 M5：“use drag to order
// model, not arrow button”）：提供商卡里的 Models、Keys 与分组的成员，有两行以上时每行左端一个拖动柄。用鼠标拖柄，放在
// 同一个列表里别的行的上半边（插在它前面）或下半边（插在它后面）；焦点在柄上时按上、下方向键移一格。一次放下或一次
// 方向键立即保存一次（调用方的 move），成功后读屏播报。浏览器原生拖放，写法同 SessionDrag.tsx：私有的拖放类型，
// 只在同一个列表里能放下（SessionDrag 的整窗监听只认它自己的类型，互不干扰）。
// 状态表见 docs/v1/screens/models-settings.md “拖动排序”。Customize › Agents 表单的模型列表也用它（Mori 只留这一份拖动
// 排序，docs/specs/customize-agents.md §6.4），那里的 move 只改表单、不保存。

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { movedItems, type ModelCommand } from '../../../../shared/models';
import { Icon } from '../../icons';
import { useImmediateSave } from './common';

/** 拖放数据的类型：只认设置页自己拖起来的行 */
const REORDER_TYPE = 'application/x-mori-reorder';

/** @brief 一个可以拖动排序的列表。 */
export interface ReorderList {
  /**
   * 列表标识（models:<provider id>、keys:<provider id>、members:<group id>、Agents 表单的 agent-models）：只能放在同一个
   * 列表里；播报区的 data-list
   */
  id: string;
  /** 各行的读屏名，按显示的顺序（柄的“Reorder <名字>”与播报用） */
  labels: readonly string[];
  /** 保存中：柄不能拖，方向键不动 */
  busy: boolean;
  /** 把第 from 行移到第 to 行并立即保存；返回是否保存成功 */
  move: (from: number, to: number) => Promise<boolean>;
}

/** @brief 拖动排序的共用状态（同一时刻只有一次拖动）。 */
interface ReorderState {
  /** 正在拖的行：所在列表与位置；没在拖时为 null */
  dragging: { list: string; from: number } | null;
  /** 放下的位置：列表、插入点（0 到行数）与鼠标下的那一行；不能放下时为 null */
  slot: { list: string; at: number; row: number } | null;
  /** 最近一次移动的播报：列表与文字 */
  said: { list: string; text: string } | null;
  /** 方向键移动之后要拿回焦点的柄：列表与新位置 */
  focus: { list: string; index: number } | null;
}

const useReorder = create<ReorderState>(() => ({ dragging: null, slot: null, said: null, focus: null }));

/** @brief 插入点换成移到的位置：插入点在原位置之后时，原来那一行先拿走，位置少一。 */
const targetOf = (from: number, at: number): number => (at > from ? at - 1 : at);

/** @brief 鼠标在这一行的上半边时插在它前面（插入点为 index），下半边时插在它后面（index + 1）。 */
function slotAt(event: React.DragEvent<HTMLElement>, index: number): number {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? index : index + 1;
}

/** @brief 正在拖的是这个列表里的行时为它原来的位置，否则（别的列表、别的拖动、拖进来的文件）为 null。 */
function draggedFrom(event: React.DragEvent<HTMLElement>, list: ReorderList): number | null {
  const { dragging } = useReorder.getState();
  if (!dragging || dragging.list !== list.id || !event.dataTransfer.types.includes(REORDER_TYPE)) return null;
  return dragging.from;
}

/**
 * @brief 移动并保存；成功后播报（Claude 的说法），方向键移动的让这一行的柄拿回焦点（行换了位置，React 可能把它的节点
 *        挪走，焦点会丢）。保存失败时列表回到原顺序，原文由调用方显示；方向键移动的，焦点回到原位置上这一行的柄
 *        （回到原顺序时 React 同样可能挪走它的节点）。
 */
async function commit(list: ReorderList, from: number, to: number, byKey: boolean): Promise<void> {
  const name = list.labels[from];
  const count = list.labels.length;
  if (byKey) useReorder.setState({ focus: { list: list.id, index: to } });
  if (await list.move(from, to)) {
    useReorder.setState({ said: { list: list.id, text: `${name} was dropped at position ${to + 1} of ${count}.` } });
  } else if (byKey) {
    useReorder.setState({ focus: { list: list.id, index: from } });
  }
}

/** @brief 拖到这一行上：能放下（同一个列表、放下后顺序会变）时记下位置并显示线，否则不接受放下。 */
function dragOver(event: React.DragEvent<HTMLElement>, list: ReorderList, index: number): void {
  const from = draggedFrom(event, list);
  if (from === null) return;
  const at = slotAt(event, index);
  const slot = targetOf(from, at) === from ? null : { list: list.id, at, row: index };
  const current = useReorder.getState().slot;
  if (current?.list !== slot?.list || current?.at !== slot?.at || current?.row !== slot?.row) {
    useReorder.setState({ slot });
  }
  if (!slot) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

/** @brief 离开这一行（不是进到它里面的元素）：它的线消失。 */
function dragLeave(event: React.DragEvent<HTMLElement>, list: ReorderList, index: number): void {
  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
  const { slot } = useReorder.getState();
  if (slot?.list === list.id && slot.row === index) useReorder.setState({ slot: null });
}

/** @brief 放在这一行上：按上半边、下半边算出新位置并保存。 */
function dropOn(event: React.DragEvent<HTMLElement>, list: ReorderList, index: number): void {
  const from = draggedFrom(event, list);
  useReorder.setState({ dragging: null, slot: null });
  if (from === null) return;
  event.preventDefault();
  const to = targetOf(from, slotAt(event, index));
  if (to !== from) void commit(list, from, to, false);
}

/**
 * @brief 一行（li）的拖放属性：拖到它上面时 data-drop 为 before / after（线在上沿或下沿），被拖的那一行
 *        data-dragging 为 true（变淡）。
 */
export function useReorderRow(list: ReorderList, index: number) {
  const drop = useReorder((state) => {
    const { slot } = state;
    if (slot?.list !== list.id || slot.row !== index) return undefined;
    return slot.at === index ? 'before' : 'after';
  });
  const dragging = useReorder((state) => state.dragging?.list === list.id && state.dragging.from === index);
  return {
    'data-drop': drop,
    'data-dragging': dragging ? 'true' : undefined,
    onDragOver: (event: React.DragEvent<HTMLElement>) => dragOver(event, list, index),
    onDragLeave: (event: React.DragEvent<HTMLElement>) => dragLeave(event, list, index),
    onDrop: (event: React.DragEvent<HTMLElement>) => dropOn(event, list, index),
  };
}

/** @brief 开始拖：拖着的影子是整行；记下列表与位置。保存中不能拖。 */
function dragStart(event: React.DragEvent<HTMLButtonElement>, list: ReorderList, index: number): void {
  if (list.busy) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(REORDER_TYPE, list.id);
  event.dataTransfer.effectAllowed = 'move';
  const row = event.currentTarget.closest('li');
  if (row) {
    const box = row.getBoundingClientRect();
    event.dataTransfer.setDragImage(row, event.clientX - box.left, event.clientY - box.top);
  }
  useReorder.setState({ dragging: { list: list.id, from: index }, slot: null });
}

/** @brief 方向键的步长：上为 -1，下为 1，别的键为 0。 */
const keyStep = (key: string): number => (key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0);

/**
 * @brief 拖动柄：读屏名“Reorder <名字>”，悬停“Drag or use the arrow keys to reorder”（Claude 的说法）；上、下方向键移一格。
 *        列表只有一行时没有柄。保存中只是不响应（aria-disabled），不设 disabled，免得焦点丢掉。
 */
export function ReorderHandle({ list, index }: { list: ReorderList; index: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const wanted = useReorder((state) => state.focus?.list === list.id && state.focus.index === index);
  useEffect(() => {
    if (!wanted) return;
    ref.current?.focus();
    useReorder.setState({ focus: null });
  }, [wanted]);
  if (list.labels.length < 2) return null;
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const step = keyStep(event.key);
    if (step === 0) return;
    event.preventDefault();
    const to = index + step;
    if (!list.busy && to >= 0 && to < list.labels.length) void commit(list, index, to, true);
  }
  return (
    <button ref={ref} type="button" className="icon-button reorder-handle" data-action="reorder"
      aria-label={`Reorder ${list.labels[index]}`} title="Drag or use the arrow keys to reorder"
      aria-disabled={list.busy || undefined} draggable={!list.busy} onKeyDown={onKeyDown}
      onDragStart={(event) => dragStart(event, list, index)}
      onDragEnd={() => useReorder.setState({ dragging: null, slot: null })}>
      <Icon name="grip" />
    </button>
  );
}

/** @brief 这个列表的播报区：读屏念出最近一次移动，屏幕上不显示。 */
export function ReorderStatus({ list }: { list: ReorderList }) {
  const text = useReorder((state) => (state.said?.list === list.id ? state.said.text : ''));
  return (
    <span className="visually-hidden" role="status" data-testid="reorder-status" data-list={list.id}>{text}</span>
  );
}

/** @brief 按一条写命令保存顺序的列表（Models、Keys）。 */
export interface OrderedSave<T> {
  /** 显示的顺序：保存中为新顺序，否则为配置里的顺序 */
  items: readonly T[];
  /** 交给柄与行的列表 */
  list: ReorderList;
  /** 最近一次移动失败的原文；没有时为 null */
  error: string | null;
}

/**
 * @brief Models、Keys 的拖动排序：一次移动发一条命令（delta 为移动的格数），保存中显示新顺序、柄不响应，
 *        失败时回到原顺序（§9.1 的立即保存）。
 * @param id 列表标识
 * @param items 配置里的顺序
 * @param nameOf 一行的读屏名
 * @param commandFor 把这一项移动 delta 格的写命令
 */
export function useOrderedSave<T>(id: string, items: readonly T[], nameOf: (item: T) => string,
  commandFor: (item: T, delta: number) => ModelCommand): OrderedSave<T> {
  const { pending, busy, error, save } = useImmediateSave<T[]>();
  const shown = pending?.value ?? items;
  const list: ReorderList = { id, labels: shown.map(nameOf), busy,
    move: (from, to) => save(movedItems(shown, from, to), commandFor(shown[from], to - from)) };
  return { items: shown, list, error };
}
