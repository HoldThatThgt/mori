// Background tasks 里一条实例的会话（docs/specs/parallel-agents-taskboard.md §13.13.4；docs/v1/screens/team-tasks.md
// “实例的会话”）：task 实例会话或结案会话，只读。条目来自 board.readSession，照对话流的画法（复用对话流的条目与工具卡）：
// 程序的投递是用户一侧的气泡；没有输入框、回复操作、批准卡，也不能作为引用（data-no-quote，选区浮层不出现）。
// 实例在运行时这个 task 的视图变了就重新读，最多每秒一次；你在底部时跟随新内容。
// 一轮结束后的步骤照对话流折成 "{n} steps"（docs/v0/screens/chat.md“步骤组”，turns.ts）：实例在运行时最后一轮的步骤
// 全部显示；你的展开、收起只在这次打开里有效。

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionEntry } from '../../../shared/protocol';
import type { SessionOf } from '../../../shared/team';
import { commandSession, readSession } from '../state/backgroundTasks';
import type { Tab, TasksBack } from '../state/store';
import { doingText, modelLine, noActivity, sessionTranscript, transcriptTitle } from '../state/taskList';
import { itemSteps, stepGroups, type ItemSteps } from '../state/turns';
import { BackRow, ReadError, findListed, taskContext, useThrottledRead } from './BackgroundParts';
import { ItemView } from './Transcript';

/** 离底部不超过这么多像素就算“在底部”（同对话流） */
const BOTTOM_SLACK = 24;

/** @brief 读会话的状态。 */
type Read = { status: 'loading' } | { status: 'ready'; entries: SessionEntry[]; running: boolean }
  | { status: 'error'; error: string };

/** @brief 读到新内容时：读之前在底部就滚到底部（同对话流的跟随）。 */
function useFollowBottom(body: React.RefObject<HTMLDivElement | null>, read: Read) {
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    if (body.current && atBottom.current) body.current.scrollTop = body.current.scrollHeight;
  }, [read]);
  return () => {
    const el = body.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  };
}

/** @brief 步骤组的视图与点摘要行（同对话流的 useSteps）；只读会话没有跳转，不用展开几组。 */
function useSteps(items: Transcript['items'], tools: Transcript['tools'], running: boolean) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => stepGroups(items, tools, running), [items, tools, running]);
  const views: Map<string, ItemSteps> = useMemo(() => itemSteps(groups, opened), [groups, opened]);
  const toggle = useCallback((id: string) => setOpened((current) => ({ ...current, [id]: !(current[id] ?? false) })),
    []);
  return { views, toggle };
}

/** @brief sessionTranscript 的结果 */
type Transcript = ReturnType<typeof sessionTranscript>;

/** @brief 会话的正文：模型一行、对话流的条目（步骤照对话流折叠）；运行中最后一行是这个 task 当前在做什么。 */
function Entries({ tab, of, entries, running }: { tab: Tab; of: SessionOf; entries: SessionEntry[];
  running: boolean }) {
  const transcript = useMemo(() => sessionTranscript(entries, running), [entries, running]);
  const steps = useSteps(transcript.items, transcript.tools, running);
  if (noActivity(entries)) return <p className="muted">No activity yet</p>;
  const model = modelLine(entries);
  const listed = of.kind === 'task' ? findListed(tab.board, of.task) : null;
  return (
    <div className="bg-entries" data-no-quote>
      {model && <div className="bg-model muted">{model}</div>}
      {transcript.items.map((item) => (
        <div key={item.key} className="bg-entry">
          <ItemView item={item} tools={transcript.tools} cwd={tab.cwd} tabKey={tab.key}
            steps={steps.views.get(item.key)} onSteps={steps.toggle} />
        </div>
      ))}
      {running && listed && (
        <div className="stage-line bg-doing" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span className="stage-text">{doingText(listed.task, taskContext(tab))}</span>
        </div>
      )}
    </div>
  );
}

/** @brief 一条实例的会话（只读）。 */
export function BackgroundTranscript({ tab, of, back }: { tab: Tab; of: SessionOf; back: TasksBack }) {
  const [read, setRead] = useState<Read>({ status: 'loading' });
  const body = useRef<HTMLDivElement>(null);
  const onScroll = useFollowBottom(body, read);
  const listed = of.kind === 'task' ? findListed(tab.board, of.task) : null;
  const request = tab.board.requests.find((item) => item.no === (of.kind === 'close' ? of.request : -1));
  const load = useCallback(() => {
    const sessionId = commandSession(tab);
    if (sessionId === null) return;
    readSession(sessionId, of).then((result) => setRead(result.error
      ? { status: 'error', error: result.error }
      : { status: 'ready', entries: result.entries, running: result.running }),
    (error: unknown) => setRead({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
    // 组件按 of 建（BackgroundTasks 的 key），of 在组件里不变
  }, [tab.sessionId]);
  // 运行中（或还没有条目）时随这个 task（结案会话：这个需求）的视图重新读；运行结束后停在最后的样子
  const live = read.status === 'loading' || (read.status === 'ready' && (read.running || noActivity(read.entries)));
  useThrottledRead(JSON.stringify([tab.sessionId, listed?.task ?? request ?? null]), load, live);
  const running = read.status === 'ready' && read.running;
  return (
    <div className="panel-body bg-body" data-testid="bg-transcript" data-kind={of.kind}
      data-running={String(running)} ref={body} onScroll={onScroll}>
      <BackRow tab={tab} back={back} />
      <h3 className="bg-task-title">{transcriptTitle(of, tab.team.holders, listed?.task.title ?? '')}</h3>
      {read.status === 'loading' && <p className="muted">Loading…</p>}
      {read.status === 'error' && <ReadError text="Failed to read session transcript" detail={read.error}
        onRetry={load} />}
      {read.status === 'ready' && <Entries tab={tab} of={of} entries={read.entries} running={read.running} />}
    </div>
  );
}
