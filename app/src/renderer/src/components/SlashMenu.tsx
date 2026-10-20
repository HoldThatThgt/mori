// 输入框的"/"补全列表（docs/v0/screens/slash.md）：浮在输入框上方，分"提示词模板""技能"两组；↑ ↓ 移动（首尾循环），
// Enter / Tab / 点一项插入，不发送；Esc 关闭（浮层栈里不挡 Alt+数字和 Ctrl+N）。焦点一直留在输入框，
// 高亮项用 aria-activedescendant 指出。照 Claude 桌面版：输入框没有焦点时不显示列表；Esc 关掉后改动第一个词才再出现。

import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { SlashCommand } from '../../../shared/protocol';
import { useOverlay } from '../state/overlays';
import {
  filterCommands, firstWord, insertCommand, slashQuery, useSlashCommands, type SlashGroup, type SlashLoad,
} from '../state/slash';
import { updateTab, type Tab } from '../state/store';

/** @brief 输入框和列表共用的状态与操作（useSlashMenu 的返回值）。 */
export interface SlashMenuState {
  /** 列表是否开着 */
  open: boolean;
  /** 读取状态 */
  load: SlashLoad;
  /** 过滤后的分组 */
  groups: SlashGroup[];
  /** 按显示顺序排的全部项（先模板组，后技能组） */
  items: SlashCommand[];
  /** 高亮项在 items 里的位置 */
  active: number;
  /** 列表元素的 id */
  menuId: string;
  /** 高亮一项 */
  highlight: (index: number) => void;
  /** 插入一项 */
  insert: (command: SlashCommand) => void;
  /** 输入框的文字变了：记下光标（光标事件可能晚于文字变化） */
  track: (element: HTMLTextAreaElement) => void;
  /** 交给输入框的属性：读屏关联，以及跟踪光标和焦点 */
  inputProps: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
}

/** @brief 一项的元素 id。 */
function optionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`;
}

/**
 * @brief 列表开不开：输入框有焦点、会话能发送、筛选词成立（slashQuery），且不是你按 Esc 关掉、第一个词还没改过。
 * @param notReady 会话不能发送时的说明；能发送时为 null
 */
function useSlashTrigger(tab: Tab, notReady: string | null) {
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // 你按 Esc 关掉（或刚插入一项）时的第一个词；第一个词变了才再出列表
  const [dismissed, setDismissed] = useState<string | null>(null);
  const allowed = focused && notReady === null && tab.sessionId !== null && dismissed !== firstWord(tab.draft);
  const query = allowed ? slashQuery(tab.draft, caret) : null;
  /** 输入框的文字或光标变了：记下光标；第一个词改了就不再算关掉 */
  const track = (element: HTMLTextAreaElement) => {
    setFocused(true);
    setCaret(element.selectionStart);
    if (dismissed !== null && firstWord(element.value) !== dismissed) setDismissed(null);
  };
  return { query, track, setFocused, setCaret, setDismissed };
}

/**
 * @brief "/"补全的全部状态：开关、读取、过滤、高亮、插入，并把开着的列表登记进浮层栈（不挡背后的快捷键）。
 * @param input 输入框，插入后把光标放到末尾
 */
export function useSlashMenu(tab: Tab, notReady: string | null,
  input: React.RefObject<HTMLTextAreaElement | null>): SlashMenuState {
  const menuId = useId();
  const trigger = useSlashTrigger(tab, notReady);
  const open = trigger.query !== null;
  const load = useSlashCommands(open, tab.sessionId);
  const groups = open && load.status === 'ready' ? filterCommands(load.commands, trigger.query ?? '') : [];
  const items = groups.flatMap((group) => group.items);
  // 高亮位置跟着筛选词：筛选词变了回到第一项
  const [chosen, setChosen] = useState<{ query: string | null; index: number }>({ query: null, index: 0 });
  const active = chosen.query === trigger.query ? Math.min(chosen.index, Math.max(items.length - 1, 0)) : 0;
  // 插入的次数：每次插入后把光标放到末尾（插入后的文字可能与原来相同，不能靠草稿变化触发）
  const [inserted, setInserted] = useState(0);
  useLayoutEffect(() => {
    const element = input.current;
    if (inserted === 0 || !element) return;
    element.setSelectionRange(element.value.length, element.value.length);
  }, [inserted, input]);
  const close = () => {
    trigger.setDismissed(firstWord(tab.draft));
    setChosen({ query: null, index: 0 });
  };
  useOverlay(open, close, false);
  const insert = (command: SlashCommand) => {
    const draft = insertCommand(tab.draft, command.name);
    updateTab(tab.key, (current) => ({ ...current, draft }));
    setInserted((count) => count + 1);
    trigger.setCaret(draft.length);
    trigger.setDismissed(firstWord(draft));
    setChosen({ query: null, index: 0 });
  };
  const inputProps: SlashMenuState['inputProps'] = {
    'aria-autocomplete': 'list',
    'aria-controls': open ? menuId : undefined,
    'aria-activedescendant': open && items.length > 0 ? optionId(menuId, active) : undefined,
    onSelect: (event) => trigger.track(event.currentTarget),
    onFocus: (event) => trigger.track(event.currentTarget),
    onBlur: () => { trigger.setFocused(false); setChosen({ query: null, index: 0 }); },
  };
  return { open, load, groups, items, active, menuId, inputProps, insert, track: trigger.track,
    highlight: (index) => setChosen({ query: trigger.query, index }) };
}

/**
 * @brief 列表开着时的按键：↑ ↓ 移动（首尾循环）；Enter 插入高亮项（没有项时什么都不做，总之不发送）；
 *        Tab 插入高亮项。输入法组字时一律不管（Enter 只选词）。
 * @return 处理了这次按键（输入框不再处理）
 */
export function handleSlashKey(menu: SlashMenuState, event: React.KeyboardEvent, composing: boolean): boolean {
  if (!menu.open || composing) return false;
  const count = menu.items.length;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count > 0) {
    event.preventDefault();
    menu.highlight((menu.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    return true;
  }
  const tabKey = event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && count > 0;
  if (!tabKey && (event.key !== 'Enter' || event.shiftKey)) return false;
  event.preventDefault();
  if (count > 0) menu.insert(menu.items[menu.active]);
  return true;
}

/** @brief 一项：/名字、argument-hint（有时）和说明；鼠标移过高亮，点它插入。 */
function SlashOption({ menu, command, index }: { menu: SlashMenuState; command: SlashCommand; index: number }) {
  const selected = index === menu.active;
  return (
    <div role="option" id={optionId(menu.menuId, index)} aria-selected={selected} className="slash-option"
      data-name={command.name} data-kind={command.kind} data-index={index}
      onMouseMove={() => { if (!selected) menu.highlight(index); }} onClick={() => menu.insert(command)}>
      <span className="slash-name">/{command.name}</span>
      {command.argumentHint && <span className="slash-hint">{command.argumentHint}</span>}
      {command.description && <span className="slash-description" title={command.description}>
        {command.description}</span>}
    </div>
  );
}

/** @brief 列表内容：读取中、读取失败、会话没有任何项、没有匹配，或分组的项。 */
function SlashBody({ menu }: { menu: SlashMenuState }) {
  const { load } = menu;
  if (load.status === 'loading') return <div className="slash-note" role="status">正在读取…</div>;
  if (load.status === 'error') return <div className="slash-note slash-error" role="alert">{load.message}</div>;
  if (load.commands.length === 0) {
    return <div className="slash-note">这个会话没有提示词模板或技能（在工具页添加）</div>;
  }
  if (menu.items.length === 0) return <div className="slash-note">没有匹配的提示词模板或技能</div>;
  return menu.groups.map((group) => {
    const offset = menu.items.indexOf(group.items[0]);
    return (
      <div key={group.kind} role="group" aria-label={group.label} className="slash-group">
        <div className="slash-group-label" aria-hidden="true">{group.label}</div>
        {group.items.map((command, index) => (
          <SlashOption key={command.name} menu={menu} command={command} index={offset + index} />
        ))}
      </div>
    );
  });
}

/**
 * @brief 高亮项移出列表的可见范围时只滚列表本身（scrollIntoView 会连带滚动外层面板）；第一项连组名一起滚到顶。
 */
function keepVisible(list: HTMLElement, active: number): void {
  const option = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
  if (!option) return;
  const bottom = option.offsetTop + option.offsetHeight;
  if (active === 0) list.scrollTop = 0;
  else if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

/** @brief 浮在输入框上方的列表；按下鼠标不抢输入框的焦点；高亮项移出可见范围时滚过去。 */
export function SlashMenu({ menu }: { menu: SlashMenuState }) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current) keepVisible(list.current, menu.active);
  }, [menu.active, menu.items.length]);
  return (
    <div className="slash-menu" role="listbox" id={menu.menuId} aria-label="提示词模板和技能" data-testid="slash-menu"
      ref={list} onMouseDown={(event) => event.preventDefault()}>
      <SlashBody menu={menu} />
    </div>
  );
}
