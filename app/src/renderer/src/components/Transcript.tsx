// 对话流：先显示最近 50 条消息，滚到顶部时载入更早的；你在底部时跟随新内容，不在底部时显示"有新内容 ↓"。

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openSettings, PAGE_SIZE, putBack, startIndexFor } from '../state/actions';
import type { Item, ToolCall } from '../state/model';
import { updateTab, type Tab } from '../state/store';
import { Icon } from '../icons';
import { AssistantMessage } from './AssistantMessage';

/** 离底部不超过这么多像素就算"在底部" */
const BOTTOM_SLACK = 24;
/** 离顶部不超过这么多像素就载入更早的消息 */
const TOP_SLACK = 40;
/** 错误原文里出现这些字样时附"去设置"，临时默认值，见 docs/v0/defaults.md */
const SETTINGS_HINT = /401|unauthorized|api key/i;

/** @brief 错误卡：显示原文，按原文附"去设置"或"把上一条消息放回输入框"。 */
function ErrorCard({ item, tabKey }: { item: Extract<Item, { kind: 'error' }>; tabKey: string }) {
  const settings = SETTINGS_HINT.test(item.text);
  return (
    <div className="error-card" role="alert" data-testid="error-card">
      <pre className="error-text">{item.text}</pre>
      {item.live && settings && <button className="text-link" onClick={() => openSettings(true)}>去设置</button>}
      {item.live && !settings && item.restore !== null && (
        <button className="text-link" onClick={() => putBack(tabKey, [item.restore ?? ''])}>把上一条消息放回输入框</button>
      )}
    </div>
  );
}

/** @brief 对话流中的一项。 */
const ItemView = memo(function ItemView(
  { item, tools, cwd, tabKey }: { item: Item; tools: Record<string, ToolCall>; cwd: string; tabKey: string },
) {
  switch (item.kind) {
    case 'user':
      return <div className="user-message" data-testid="user-message">{item.text}</div>;
    case 'assistant':
      return <AssistantMessage item={item} tools={tools} cwd={cwd} />;
    case 'compaction':
      return <div className="notice" data-testid="notice">已压缩较早的对话</div>;
    case 'stopped':
      return <div className="notice stopped" data-testid="notice">已停止 · 已经做出的修改不会自动撤销</div>;
    case 'note':
      return <div className="notice" data-testid="notice">{item.text}</div>;
    case 'error':
      return <ErrorCard item={item} tabKey={tabKey} />;
  }
});

/** @brief 空会话：项目名和输入提示。 */
function EmptyChat({ cwd }: { cwd: string }) {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  return (
    <div className="empty-chat">
      <h1>{name}</h1>
      <p>Enter 发送 · Shift+Enter 换行</p>
    </div>
  );
}

/**
 * @brief 跟随与"有新内容"：内容变高、或对话流本身变矮（输入框上方出现批准卡、排队区、阶段行）时，
 *        在底部就跟到底部；你发消息时回到底部。
 *        只有你往上滚（比上次自动滚到底的位置更靠上）才算离开底部：流式输出很快时，
 *        自动滚动触发的 scroll 事件可能晚到、那时内容又长了一截，不能据此认为你离开了。
 */
function useFollow(scroller: React.RefObject<HTMLDivElement | null>, inner: React.RefObject<HTMLDivElement | null>,
  tab: Tab) {
  const atBottom = useRef(true);
  const lastAutoTop = useRef(0);
  const [hasNew, setHasNew] = useState(false);
  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    lastAutoTop.current = element.scrollTop;
    atBottom.current = true;
  }, [scroller]);
  useLayoutEffect(() => {
    if (!inner.current || !scroller.current) return;
    const observer = new ResizeObserver(() => atBottom.current && toBottom());
    observer.observe(inner.current);
    observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [inner, scroller, toBottom]);
  useEffect(() => {
    if (!atBottom.current) setHasNew(true);
  }, [tab.transcript.items, tab.transcript.tools]);
  useEffect(() => {
    if (!tab.transcript.sending) return;
    toBottom();
    setHasNew(false);
  }, [tab.transcript.sending, toBottom]);
  const track = () => {
    const element = scroller.current;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK) {
      atBottom.current = true;
      setHasNew(false);
    } else if (element.scrollTop < lastAutoTop.current - 1) {
      atBottom.current = false;
      lastAutoTop.current = Infinity;
    }
  };
  const jump = () => {
    toBottom();
    setHasNew(false);
  };
  return { hasNew, track, jump };
}

/** @brief 滚到顶部时载入更早的消息，并让原来最上面那条消息留在原位置（之后的异步变高由浏览器的滚动锚定处理）。 */
function useLoadEarlier(scroller: React.RefObject<HTMLDivElement | null>, inner: React.RefObject<HTMLDivElement | null>,
  tab: Tab) {
  const anchorBeforeLoad = useRef<{ element: Element; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorBeforeLoad.current;
    const element = scroller.current;
    if (!anchor || !element) return;
    element.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
    anchorBeforeLoad.current = null;
  }, [tab.startIndex, scroller]);
  return () => {
    const element = scroller.current;
    const first = inner.current?.querySelector('[data-item]');
    if (!element || !first || element.scrollTop > TOP_SLACK || tab.startIndex === 0 || anchorBeforeLoad.current) return;
    const items = tab.transcript.items.slice(tab.startIndex);
    const shown = items.filter((item) => item.kind === 'user' || item.kind === 'assistant').length;
    anchorBeforeLoad.current = { element: first, top: first.getBoundingClientRect().top };
    updateTab(tab.key, (current) => ({ ...current,
      startIndex: startIndexFor(current.transcript, shown + PAGE_SIZE) }));
  };
}

/** @brief 一个会话的对话流。 */
export function Transcript({ tab }: { tab: Tab }) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const { hasNew, track, jump } = useFollow(scroller, inner, tab);
  const loadEarlier = useLoadEarlier(scroller, inner, tab);
  const { items, tools } = tab.transcript;

  function onScroll() {
    track();
    loadEarlier();
  }

  return (
    <div className="transcript-wrap">
      <div className="conversation" ref={scroller} onScroll={onScroll} data-testid="transcript">
        <div className="conversation-inner" ref={inner}>
          {items.length === 0 && tab.phase === 'ready' && <EmptyChat cwd={tab.cwd} />}
          {tab.startIndex > 0 && <div className="load-earlier">向上滚动载入更早的消息</div>}
          {items.slice(tab.startIndex).map((item) => (
            <div key={item.key} data-item={item.kind}>
              <ItemView item={item} tools={tools} cwd={tab.cwd} tabKey={tab.key} />
            </div>
          ))}
        </div>
      </div>
      {hasNew && (
        <button className="new-content" onClick={jump} data-testid="new-content">
          有新内容 <Icon name="down" />
        </button>
      )}
    </div>
  );
}
