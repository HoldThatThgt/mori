// 对话流：先显示最近 50 条消息，滚到顶部时载入更早的；你在底部时跟随新内容，不在底部时显示"Jump to latest ↓"。
// M4：你的消息上方显示引用，每轮回复末尾一行操作，点引用回到原位置时滚过去高亮（docs/v0/screens/selection.md）。
// M6：pi 展开的技能命令缩成一行"Skill · 名字"加参数，可以展开看正文（docs/v0/screens/slash.md）。
// v1：换模型与重建的一行、No model available 卡（docs/v1/screens/model-chat.md）；错误卡不再有"Go to settings"。
// 平行 Agent（docs/v1/screens/team-stream.md）：回执、进展摘要（挂在回复下面、回复操作之上），程序投递不显示；
// 模式改变的一行提示（docs/v1/screens/team-switch.md）。
// 2026-10-26 走查 M18：一轮里正文之间的思考块与工具卡是步骤组，正文跟在后面或这一轮结束时折成一行"{n} steps"；
// 跳转进折起的组时先展开它（docs/v0/screens/chat.md"步骤组"）。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { modeNoticeText } from '../../../shared/team';
import { putBack, putBackQuoted } from '../state/actions';
import { PAGE_SIZE, rebuildText, startIndexFor, switchText } from '../state/model';
import type { Item, ToolCall } from '../state/model';
import { stripQuotes } from '../state/quotes';
import { parseSkillInvocation, type SkillInvocation } from '../state/skillText';
import { updateTab, type Tab } from '../state/store';
import {
  foldedIn, itemSteps, lastTurnEnded, replyTurns, stepGroups, type ItemSteps, type ReplyTurn,
} from '../state/turns';
import { Icon } from '../icons';
import { AssistantMessage } from './AssistantMessage';
import { SentQuotes } from './QuoteChips';
import { findText, flashElements, flashRange } from './quoteHighlight';
import { ReplyActions } from './ReplyActions';
import { ProgressSummary, Receipt } from './TeamStream';
import { UnavailableCard } from './UnavailableCard';

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

/** @brief 对话流中一项的参数。 */
interface ItemProps {
  /** 这一项 */
  item: Item;
  /** 工具调用 */
  tools: Record<string, ToolCall>;
  /** 会话的工作目录 */
  cwd: string;
  /** 会话在界面里的标识 */
  tabKey: string;
  /** 这条助手回复的步骤组视图；不是助手回复或没有组里的块时为 undefined */
  steps?: ItemSteps;
  /** 点摘要行：展开或折起那一组 */
  onSteps: (id: string) => void;
}

/** @brief ItemView 的参数是否没变：步骤组的视图每个增量都重算，按内容比（流式输出时别的回复不跟着重画）。 */
function sameItem(before: ItemProps, after: ItemProps): boolean {
  return before.item === after.item && before.tools === after.tools && before.cwd === after.cwd
    && before.tabKey === after.tabKey && before.onSteps === after.onSteps
    && JSON.stringify(before.steps) === JSON.stringify(after.steps);
}

/** @brief 对话流中的一项；Background tasks 的只读会话（BackgroundTranscript.tsx）也用它画。 */
export const ItemView = memo(function ItemView({ item, tools, cwd, tabKey, steps, onSteps }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} cwd={cwd} tabKey={tabKey} />;
    case 'assistant':
      return <AssistantMessage item={item} tools={tools} cwd={cwd} tabKey={tabKey} steps={steps} onSteps={onSteps} />;
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
    case 'team-mode':
      return <div className="notice" data-testid="notice" data-kind="team-mode" data-mode={item.mode}>
        {modeNoticeText(item.mode)}</div>;
    case 'receipt':
      return <Receipt receipt={item.receipt} />;
    case 'progress':
      return <ProgressSummary request={item.request} tabKey={tabKey} />;
    case 'wake':
      return null;
  }
}, sameItem);

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

/**
 * @brief 滚到顶部时载入更早的消息，并让原来最上面那条消息留在原位置（之后的异步变高由浏览器的滚动锚定处理）。
 *        在顶部向上滚轮也算：步骤组折起后已显示的部分可能不满一栏、滚不动，没有 scroll 事件（chat.md"步骤组"）。
 */
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

/** @brief 一次回到原位置。 */
type Jump = NonNullable<Tab['transcriptJump']>;

/**
 * @brief 跳转高亮哪些项（对话流里的 key）：会话引用是引用的几轮（docs/v0/screens/session-refs.md）、记忆页的
 *        Jump to source 是那一条消息（都由 jump.keys 给出）；整条回复的引用是整轮回复；选区引用找不到对应文字时是那一条回复。
 */
function flashKeys(jump: Jump, turns: Map<string, ReplyTurn>): string[] {
  if (jump.keys) return jump.keys;
  const source = jump.ref.source;
  const turnKeys = [...turns.values()].find((turn) => turn.keys.includes(jump.itemKey))?.keys;
  return source.kind === 'message' && source.scope === 'reply' && turnKeys ? turnKeys : [jump.itemKey];
}

/**
 * @brief 跳转前要先展开的步骤组（chat.md"步骤组"）：引用的文字在收着的块里时是那一组；否则是要高亮的各项里收着块的组
 *        （一条消息、整轮回复、会话引用的几轮都一样，展开后高亮的是整段内容）。
 * @param range 选区引用在这一项里找到的文字；不是选区引用或找不到时为 null
 * @param keys 不按文字高亮时要高亮的项（flashKeys）
 */
function jumpFolds(range: Range | null, keys: string[], views: Map<string, ItemSteps>): string[] {
  if (!range) return foldedIn(views, keys);
  const step = range.startContainer.parentElement?.closest<HTMLElement>('[data-step-group]');
  return step?.hidden && step.dataset.stepGroup ? [step.dataset.stepGroup] : [];
}

/**
 * @brief 点引用回到原位置（回复里的引用，见 quotes.ts jumpToQuote；会话引用与记忆页的 Jump to source 带 jump.keys）：
 *        等那一项渲染出来，滚过去，选区高亮引用的文字，其余按 flashKeys 高亮。要露出来的内容在折起的步骤组里时先展开
 *        那些组，重画之后这个 effect 再跑一次（依赖 steps）才滚动、高亮。
 */
function useQuoteJump(inner: React.RefObject<HTMLDivElement | null>, tab: Tab, turns: Map<string, ReplyTurn>,
  steps: Steps) {
  useLayoutEffect(() => {
    const jump = tab.transcriptJump;
    const root = inner.current;
    const element = jump && root?.querySelector<HTMLElement>(`[data-item-key="${jump.itemKey}"]`);
    if (!jump || !root || !element) return;
    const source = jump.ref.source;
    const selected = !jump.keys && source.kind === 'message' && source.scope === 'selection';
    const range = selected ? findText(element, jump.ref.quote) : null;
    const keys = range ? [] : flashKeys(jump, turns);
    const folds = jumpFolds(range, keys, steps.views);
    if (folds.length > 0) {
      steps.expand(folds);
      return;
    }
    updateTab(tab.key, (current) => ({ ...current, transcriptJump: null }));
    // 带 jump.keys 的（会话引用、记忆页的 Jump to source）滚到第一项的顶部（session-refs.md），其余滚到那一项的中间。
    element.scrollIntoView({ block: jump.keys ? 'start' : 'center' });
    if (range) flashRange(range);
    else flashElements(keys.flatMap((key) => [...root.querySelectorAll(`[data-item-key="${key}"]`)]));
  }, [tab.transcriptJump, tab.startIndex, tab.key, inner, turns, steps]);
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
  const ended = lastTurnEnded(items);
  const lastTurnEnd = ended ? undefined : [...turns.keys()].at(-1);
  // 最后一轮在运行（步骤组按它决定最后一轮的组是否还在进行中）
  const liveTurn = !ended && (running || (last?.kind === 'assistant' && last.streaming));
  const shown = [...turns.entries()].filter(([key, turn]) => turn.text && !(liveTurn && key === lastTurnEnd));
  return { turns, shown: new Map(shown), latest: shown.at(-1)?.[0], liveTurn };
}

/** @brief 步骤组的视图与操作。 */
interface Steps {
  /** 每条助手回复的步骤组视图（turns.ts itemSteps） */
  views: Map<string, ItemSteps>;
  /** 点摘要行：展开或折起那一组 */
  toggle: (id: string) => void;
  /** 展开这几组（跳转前） */
  expand: (ids: string[]) => void;
}

/** 还没点过任何组 */
const NONE_OPENED: Record<string, boolean> = {};

/**
 * @brief 步骤组（chat.md"步骤组"）：按已显示的对话流算组；你的展开、收起按组记在这个会话面板里（同思考块的展开），
 *        没点过的折起的组收着。只对这一次打开的会话有效：后台进程重启后重新打开（sessionId 变了，对话流按会话记录重画、
 *        组的标识可能对不上）时回到折起。
 * @param liveTurn 最后一轮在运行
 */
function useSteps(tab: Tab, liveTurn: boolean): Steps {
  const { items, tools } = tab.transcript;
  const session = tab.sessionId;
  const [chosen, setChosen] = useState({ session, opened: NONE_OPENED });
  const opened = chosen.session === session ? chosen.opened : NONE_OPENED;
  const groups = useMemo(() => stepGroups(items.slice(tab.startIndex), tools, liveTurn),
    [items, tools, tab.startIndex, liveTurn]);
  const views = useMemo(() => itemSteps(groups, opened), [groups, opened]);
  const change = useCallback((next: (opened: Record<string, boolean>) => Record<string, boolean>) => setChosen(
    (current) => ({ session, opened: next(current.session === session ? current.opened : NONE_OPENED) })), [session]);
  const toggle = useCallback((id: string) => change((current) => ({ ...current, [id]: !(current[id] ?? false) })),
    [change]);
  const expand = useCallback((ids: string[]) => change((current) => ({ ...current,
    ...Object.fromEntries(ids.map((id) => [id, true])) })), [change]);
  return useMemo(() => ({ views, toggle, expand }), [views, toggle, expand]);
}

/** @brief 一个会话的对话流。 */
export function Transcript({ tab }: { tab: Tab }) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const { hasNew, track, jump } = useFollow(scroller, inner, tab);
  const loadEarlier = useLoadEarlier(scroller, inner, tab);
  const { turns, shown, latest, liveTurn } = useReplyActions(tab);
  const steps = useSteps(tab, liveTurn);
  useQuoteJump(inner, tab, turns, steps);
  const { items, tools } = tab.transcript;

  function onScroll() {
    track();
    loadEarlier();
  }

  return (
    <div className="transcript-wrap">
      <div className="conversation" ref={scroller} onScroll={onScroll} data-testid="transcript"
        onWheel={(event) => event.deltaY < 0 && loadEarlier()}>
        <div className="conversation-inner" ref={inner}>
          {items.length === 0 && tab.phase === 'ready' && <EmptyChat cwd={tab.cwd} />}
          {tab.startIndex > 0 && <div className="load-earlier">Scroll up to load earlier messages</div>}
          {items.slice(tab.startIndex).map((item) => {
            // 程序投递不显示（§13.7），只结束上一轮（replyTurns）。
            if (item.kind === 'wake') return null;
            const turn = shown.get(item.key);
            return (
              <div key={item.key} data-item={item.kind} data-item-key={item.key}>
                <ItemView item={item} tools={tools} cwd={tab.cwd} tabKey={tab.key} steps={steps.views.get(item.key)}
                  onSteps={steps.toggle} />
                {turn && <ReplyActions turn={turn} tabKey={tab.key} sessionFile={tab.sessionFile}
                  latest={item.key === latest} />}
              </div>
            );
          })}
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
