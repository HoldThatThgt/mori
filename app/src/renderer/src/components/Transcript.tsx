// 对话流：先显示最近 50 条消息，滚到顶部时载入更早的；你在底部时跟随新内容，不在底部时显示"Jump to latest ↓"。
// M4：你的消息上方显示引用，每轮回复末尾一行操作，点引用回到原位置时滚过去高亮（docs/v0/screens/selection.md）。
// M6：pi 展开的技能命令缩成一行"Skill · 名字"加参数，可以展开看正文（docs/v0/screens/slash.md）。
// v1：换模型与重建的一行、No model available 卡（docs/v1/screens/model-chat.md）；错误卡不再有"Go to settings"。
// 平行 Agent（docs/v1/screens/team-stream.md）：回执、进展摘要（挂在回复下面、回复操作之上），程序投递不显示。
// 你不在（docs/v1/screens/fs-question.md "一轮末尾"）：自动处理的记录本身不显示，这一轮最后（最后一条回复与回复操作之后）
// 画一块 Decided while you were away（AwayBlock.tsx）。
// Rewind（docs/specs/file-system.md §5.5–§5.10，状态表 docs/v1/screens/fs-rewind.md）：你的消息（含技能调用的气泡）下面的
// Rewind 与菜单（RewindMenu.tsx）；mori.rewind 的通知画在条目的位置，带 Undo 与可以展开的跳过、失败的文件；进行中
// Rewinding… / Undoing… 与后台进程拒绝时的错误行在对话流末尾。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { putBack, putBackQuoted } from '../state/actions';
import { awayBlocks } from '../state/away';
import { PAGE_SIZE, rebuildText, startIndexFor, switchText } from '../state/model';
import type { Item, ToolCall } from '../state/model';
import { stripQuotes } from '../state/quotes';
import {
  progressText, rewindButton, rewindNotice, STILL_RUNNING, undoOffer, undoRewind,
} from '../state/rewind';
import { parseSkillInvocation, type SkillInvocation } from '../state/skillText';
import { updateTab, useApp, type Tab } from '../state/store';
import { lastTurnEnded, replyTurns, type ReplyTurn } from '../state/turns';
import { Icon } from '../icons';
import { AssistantMessage } from './AssistantMessage';
import { AwayBlock } from './AwayBlock';
import { SentQuotes } from './QuoteChips';
import { findText, flashElements, flashRange } from './quoteHighlight';
import { ReplyActions } from './ReplyActions';
import { RewindButton } from './RewindMenu';
import { focusComposer } from './SelectionPopover';
import { ProgressSummary, Receipt } from './TeamStream';
import { UnavailableCard } from './UnavailableCard';
import '../styles/rewind.css';

/** 离底部不超过这么多像素就算"在底部" */
const BOTTOM_SLACK = 24;
/** 离顶部不超过这么多像素就载入更早的消息 */
const TOP_SLACK = 40;

/**
 * @brief 错误卡：显示原文，有没发出去的消息时附"Put your last message back in the message box"。认证类错误由模型层
 *        处理（换 key、换模型或 No model available 卡），不再按原文附"Go to settings"（§9.3）。
 */
function ErrorCard({ item, tabKey }: { item: Extract<Item, { kind: 'error' }>; tabKey: string }) {
  return (
    <div className="error-card" role="alert" data-testid="error-card">
      <pre className="error-text">{item.text}</pre>
      {item.live && item.restore !== null && (
        <button className="text-link" onClick={() => (item.refs ? putBackQuoted(tabKey, item.restore ?? '', item.refs)
          : putBack(tabKey, [item.restore ?? '']))}>Put your last message back in the message box</button>
      )}
    </div>
  );
}

/**
 * @brief 技能调用（照 pi 终端 SkillInvocationMessageComponent）：气泡里一行"Skill · 名字"，下面是你写的参数；
 *        "Expand"看 SKILL.md 的路径和技能正文。
 */
function SkillMessage({ skill }: { skill: SkillInvocation }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="user-message skill-invocation" data-testid="skill-invocation" data-skill={skill.name}>
      <div className="skill-head">
        <span className="skill-label">Skill · {skill.name}</span>
        <button className="text-link skill-toggle" aria-expanded={open} data-no-quote
          onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Expand'}</button>
      </div>
      {skill.args && <div className="skill-args">{skill.args}</div>}
      {open && (
        <div className="skill-body">
          <div className="skill-location">{skill.location}</div>
          {skill.body}
        </div>
      )}
    </div>
  );
}

/**
 * @brief 你的消息：带引用时引用显示在气泡上方，气泡里只有你写的字；引用块对不上时按原文显示。
 *        pi 展开的技能命令显示成技能调用（带引用的消息 pi 不展开，不会是技能调用）。
 */
function UserMessage({ item, cwd, tabKey }: { item: Extract<Item, { kind: 'user' }>; cwd: string; tabKey: string }) {
  const own = item.refs?.length ? stripQuotes(item.text, item.refs, cwd) : null;
  if (!item.refs || own === null) {
    const skill = parseSkillInvocation(item.text);
    if (skill) return <SkillMessage skill={skill} />;
    return <div className="user-message" data-testid="user-message">{item.text}</div>;
  }
  return (
    <div className="user-turn">
      <SentQuotes refs={item.refs} tabKey={tabKey} cwd={cwd} />
      {own && <div className="user-message" data-testid="user-message">{own}</div>}
    </div>
  );
}

/**
 * @brief 一项上的 Rewind 或 Undo：enabled 可点；disabled 会话忙（aria-disabled，悬停 Still running）；null 没有。
 *        对话流按项 memo，所以只传这个字符串，不传整个会话。
 */
type RewindControl = 'enabled' | 'disabled' | null;

/** @brief 你的消息上的 Rewind（rewindButton）或通知上的 Undo（undoOffer）换成 RewindControl。 */
function rewindControl(tab: Tab, item: Item): RewindControl {
  const offer = item.kind === 'user' ? rewindButton(tab, item) : item.kind === 'rewind' ? undoOffer(tab, item) : null;
  if (!offer) return null;
  return offer.disabled ? 'disabled' : 'enabled';
}

/** @brief 通知里可以展开的一段（Skipped <n> files、Couldn’t restore <n> files）：展开后列出路径（失败的带原文）。 */
function NoticeList({ testId, label, lines, total }: { testId: string; label: string; lines: string[];
  total: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {' · '}
      <button className="text-link" data-testid={testId} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}</button>
      {open && (
        <ul className="rewind-notice-list">
          {lines.map((line) => <li key={line}>{line}</li>)}
          {total > lines.length && <li>and {(total - lines.length).toLocaleString('en-US')} more</li>}
        </ul>
      )}
    </>
  );
}

/**
 * @brief 一次 Rewind 或 Undo 的通知（fs-rewind.md "完成"、"Undo"），在 mori.rewind 条目的位置：第一段文字，提供 Undo 时
 *        " · Undo"（会话忙时不可点，悬停 Still running），跳过、失败的文件各一段可以展开的按钮；对话没恢复时下一行是原因
 *        （只在这次实时显示）。
 */
function RewindNotice({ item, undo, tabKey }: { item: Extract<Item, { kind: 'rewind' }>; undo: RewindControl;
  tabKey: string }) {
  const { record } = item;
  const text = rewindNotice(record);
  return (
    <div className="notice rewind-notice" data-testid="rewind-notice" data-kind={record.kind}
      data-code={String(record.code)} data-conversation={String(record.conversation)} data-no-quote>
      <div>
        <span>{text.text}</span>
        {undo && <>{' · '}<button className="text-link" data-testid="rewind-undo"
          aria-disabled={undo === 'disabled' ? true : undefined} title={undo === 'disabled' ? STILL_RUNNING : undefined}
          onClick={() => { if (undo === 'enabled') void undoRewind(tabKey, item.entryId); }}>Undo</button></>}
        {text.skipped && <NoticeList testId="rewind-skipped" label={text.skipped} lines={record.skipped}
          total={record.counts.skipped} />}
        {text.failed && <NoticeList testId="rewind-failed" label={text.failed}
          lines={record.failed.map((file) => `${file.path}: ${file.error}`)} total={record.counts.failed} />}
      </div>
      {item.warning && <div className="rewind-warning">{item.warning}</div>}
    </div>
  );
}

/**
 * @brief 对话流中的一项。
 * @param rewind 你的消息上的 Rewind、通知上的 Undo（rewindControl）；其余项为 null
 */
const ItemView = memo(function ItemView({ item, tools, cwd, tabKey, rewind }: {
  item: Item; tools: Record<string, ToolCall>; cwd: string; tabKey: string; rewind: RewindControl;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <>
          <UserMessage item={item} cwd={cwd} tabKey={tabKey} />
          {rewind && item.entryId !== null && <RewindButton tabKey={tabKey} entryId={item.entryId}
            disabled={rewind === 'disabled'} />}
        </>
      );
    case 'rewind':
      return <RewindNotice item={item} undo={rewind} tabKey={tabKey} />;
    case 'assistant':
      return <AssistantMessage item={item} tools={tools} cwd={cwd} tabKey={tabKey} />;
    case 'compaction':
      return <div className="notice" data-testid="notice">Compacted session</div>;
    case 'stopped':
      return <div className="notice stopped" data-testid="notice">Stopped · Changes made so far stay as they are</div>;
    case 'note':
      return <div className="notice" data-testid="notice">{item.text}</div>;
    case 'notify':
      return <div className={`notice ext-notify ${item.level}`} data-testid="ext-notify">Extension: {item.text}</div>;
    case 'error':
      return <ErrorCard item={item} tabKey={tabKey} />;
    case 'model-switch':
      return (
        <div className="notice model-notice" data-testid="notice" data-kind="model-switch" data-from={item.from}
          data-to={item.to} data-reason={item.reason} data-hidden={item.hidden ? 'true' : undefined}>
          {switchText(item)}</div>
      );
    case 'rebuild':
      return <div className="notice model-notice" data-testid="notice" data-kind="rebuild"
        data-summary={String(item.summary)}>{rebuildText(item.model, item.summary)}</div>;
    case 'unavailable':
      return <UnavailableCard candidates={item.candidates} tabKey={tabKey} />;
    case 'receipt':
      return <Receipt receipt={item.receipt} />;
    case 'progress':
      return <ProgressSummary request={item.request} tabKey={tabKey} />;
    case 'wake':
    case 'away':
      return null;
  }
});

/**
 * @brief 对话流末尾的 Rewind 状态（fs-rewind.md "进行中"、"不能做的情况"）：rewind / rewind.undo 还没返回时
 *        Rewinding… / Undoing…；后台进程拒绝时 Couldn’t rewind: <原文> / Couldn’t undo: <原文>（不写进会话文件，
 *        下一次 Rewind、Undo 或发送时消失）。做完时焦点若随消失的那条消息丢了（恢复了对话），放进输入框：
 *        消息的文字已经放回那里（照 Claude 桌面版）。
 */
function RewindStatus({ tab }: { tab: Tab }) {
  const { progress, error } = tab.rewind;
  const previous = useRef(progress);
  useEffect(() => {
    const was = previous.current;
    previous.current = progress;
    if (!was || progress || document.activeElement !== document.body) return;
    if (useApp.getState().activeKey === tab.key) focusComposer(tab.key);
  }, [progress, tab.key]);
  return (
    <>
      {progress && (
        <div className="notice rewind-progress" data-testid="rewind-progress" data-kind={progress} role="status"
          data-no-quote>
          <span className="spinner" aria-hidden="true" />{progressText(progress)}
        </div>
      )}
      {error && <div className="rewind-error" data-testid="rewind-error" data-kind={error.kind} role="alert"
        data-no-quote>{error.text}</div>}
    </>
  );
}

/** @brief 空会话：项目名和输入提示。 */
function EmptyChat({ cwd }: { cwd: string }) {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  return (
    <div className="empty-chat">
      <h1>{name}</h1>
      <p>Enter to send · Shift+Enter for new line</p>
    </div>
  );
}

/** @brief 选区是否在这个元素里（选中文字时暂停自动跟随，免得选区和浮层被滚走）。 */
function selectionWithin(element: HTMLElement | null): boolean {
  const selection = window.getSelection();
  return Boolean(element && selection && !selection.isCollapsed && selection.anchorNode
    && element.contains(selection.anchorNode));
}

/** @brief 滚动位置离底部还有多少像素。 */
function gapBelow(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/** @brief 内容变高、或对话流本身变矮（输入框上方出现批准卡、排队区、阶段行）时调 onResize。 */
function useResize(scroller: React.RefObject<HTMLDivElement | null>, inner: React.RefObject<HTMLDivElement | null>,
  onResize: () => void): void {
  const latest = useRef(onResize);
  latest.current = onResize;
  useLayoutEffect(() => {
    if (!inner.current || !scroller.current) return;
    const observer = new ResizeObserver(() => latest.current());
    observer.observe(inner.current);
    observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [inner, scroller]);
}

/** @brief 鼠标是否按在对话流里（开始拖选或拖滚动条）：按住期间暂停跟随，免得刚按下，下面的字就被滚走。 */
function useHolding(scroller: React.RefObject<HTMLDivElement | null>): React.RefObject<boolean> {
  const holding = useRef(false);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const down = () => { holding.current = true; };
    const up = () => { holding.current = false; };
    element.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    return () => {
      element.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
    };
  }, [scroller]);
  return holding;
}

/**
 * @brief 跟随与"Jump to latest"：内容变高、或对话流本身变矮（输入框上方出现批准卡、排队区、阶段行）时，
 *        在底部就跟到底部；你发消息时回到底部。对话流里按着鼠标或有选区时暂停跟随，显示"Jump to latest"。
 *        只有你往上滚（比上次自动滚到底的位置更靠上）才算离开底部：流式输出很快时，
 *        自动滚动触发的 scroll 事件可能晚到、那时内容又长了一截，不能据此认为你离开了。
 */
function useFollow(scroller: React.RefObject<HTMLDivElement | null>, inner: React.RefObject<HTMLDivElement | null>,
  tab: Tab) {
  const atBottom = useRef(true);
  const lastAutoTop = useRef(0);
  const [hasNew, setHasNew] = useState(false);
  const holding = useHolding(scroller);
  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    lastAutoTop.current = element.scrollTop;
    atBottom.current = true;
  }, [scroller]);
  useResize(scroller, inner, () => {
    if (!atBottom.current) return;
    const element = scroller.current;
    if (holding.current || selectionWithin(element)) {
      if (element && gapBelow(element) > BOTTOM_SLACK) setHasNew(true);
      return;
    }
    toBottom();
    setHasNew(false);
  });
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
    if (gapBelow(element) <= BOTTOM_SLACK) {
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

/**
 * @brief 点引用回到原位置（回复里的引用，见 quotes.ts jumpToQuote）：等那一项渲染出来，滚过去，
 *        选区高亮引用的文字，整条回复或找不到对应文字时高亮整轮回复。
 */
function useQuoteJump(inner: React.RefObject<HTMLDivElement | null>, tab: Tab, turns: Map<string, ReplyTurn>) {
  useLayoutEffect(() => {
    const jump = tab.transcriptJump;
    const root = inner.current;
    const element = jump && root?.querySelector<HTMLElement>(`[data-item-key="${jump.itemKey}"]`);
    if (!jump || !root || !element) return;
    updateTab(tab.key, (current) => ({ ...current, transcriptJump: null }));
    // 会话引用的原会话：滚到引用的第一轮你的消息，高亮引用的几轮（docs/v0/screens/session-refs.md）。
    if (jump.keys) {
      element.scrollIntoView({ block: 'start' });
      flashElements(jump.keys.flatMap((key) => [...root.querySelectorAll(`[data-item-key="${key}"]`)]));
      return;
    }
    element.scrollIntoView({ block: 'center' });
    const source = jump.ref.source;
    const range = source.kind === 'message' && source.scope === 'selection' ? findText(element, jump.ref.quote) : null;
    if (range) {
      flashRange(range);
      return;
    }
    // 整轮回复高亮整轮；选区找不到对应文字时只高亮那一条回复。
    const turnKeys = [...turns.values()].find((turn) => turn.keys.includes(jump.itemKey))?.keys;
    const keys = source.kind === 'message' && source.scope === 'reply' && turnKeys ? turnKeys : [jump.itemKey];
    flashElements(keys.flatMap((key) => [...root.querySelectorAll(`[data-item-key="${key}"]`)]));
  }, [tab.transcriptJump, tab.startIndex, tab.key, inner, turns]);
}

/**
 * @brief 每轮回复末尾的操作行放在哪些项下面：这一轮有正文、不在生成（最后一轮在本轮运行中、或最后一条回复还在流入时不放）；
 *        最新的一轮标出来（一直显示）。
 */
function useReplyActions(tab: Tab) {
  const { items, running } = tab.transcript;
  const turns = useMemo(() => replyTurns(items), [items]);
  const last = items.findLast((item) => item.kind === 'assistant');
  // 最后一轮的操作行画在哪一项下（replyTurns 的键）；最后一项是你的消息或程序投递时（不算回执与进展摘要），最后一轮已经结束。
  // 自动处理的记录也不算：它只在它那一轮末尾加一块，不结束一轮、也不让上一轮重新算作进行中（fs-question.md "一轮末尾"），
  // 例如你发了新消息、新一轮的回复还没开始时后台实例的卡到时。
  const ended = useMemo(() => lastTurnEnded(items.filter((item) => item.kind !== 'away')), [items]);
  const lastTurnEnd = ended ? undefined : [...turns.keys()].at(-1);
  const live = running || (last?.kind === 'assistant' && last.streaming);
  const shown = [...turns.entries()].filter(([key, turn]) => turn.text && !(live && key === lastTurnEnd));
  return { turns, shown: new Map(shown), latest: shown.at(-1)?.[0] };
}

/** @brief 一个会话的对话流。 */
export function Transcript({ tab }: { tab: Tab }) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const { hasNew, track, jump } = useFollow(scroller, inner, tab);
  const loadEarlier = useLoadEarlier(scroller, inner, tab);
  const { turns, shown, latest } = useReplyActions(tab);
  useQuoteJump(inner, tab, turns);
  const { items, tools } = tab.transcript;
  const blocks = useMemo(() => awayBlocks(items), [items]);

  function onScroll() {
    track();
    loadEarlier();
  }

  return (
    <div className="transcript-wrap">
      <div className="conversation" ref={scroller} onScroll={onScroll} data-testid="transcript">
        <div className="conversation-inner" ref={inner}>
          {items.length === 0 && tab.phase === 'ready' && <EmptyChat cwd={tab.cwd} />}
          {tab.startIndex > 0 && <div className="load-earlier">Scroll up to load earlier messages</div>}
          {items.slice(tab.startIndex).map((item) => {
            // 程序投递不显示（§13.7），只结束上一轮（replyTurns）。
            if (item.kind === 'wake') return null;
            const block = blocks.get(item.key);
            // 自动处理的记录不显示；它是这一轮最后一项时，这一轮的那一块画在它的位置。
            if (item.kind === 'away') return block ? <AwayBlock key={item.key} block={block} cwd={tab.cwd} /> : null;
            const turn = shown.get(item.key);
            return (
              <div key={item.key} data-item={item.kind} data-item-key={item.key}>
                <ItemView item={item} tools={tools} cwd={tab.cwd} tabKey={tab.key} rewind={rewindControl(tab, item)} />
                {turn && <ReplyActions turn={turn} tabKey={tab.key} sessionFile={tab.sessionFile}
                  latest={item.key === latest} />}
                {block && <AwayBlock block={block} cwd={tab.cwd} />}
              </div>
            );
          })}
          <RewindStatus tab={tab} />
        </div>
      </div>
      {hasNew && (
        <button className="new-content" onClick={jump} data-testid="new-content">
          Jump to latest <Icon name="down" />
        </button>
      )}
    </div>
  );
}
