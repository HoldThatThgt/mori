// 侧栏会话行的数据（docs/v0/screens/sessions.md）：pi 的会话列表加本次打开的会话合成行，按项目分组、按最后活动排序；
// 会话行的状态；已归档的会话单独列出。纯函数，界面组件在 SessionTree.tsx。

import type { SavedSession } from '../../../shared/protocol';
import { sameFile, type Tab } from '../state/store';
import { skillCommandText } from '../state/skillText';
import { displayTitle, sessionTitle, TITLE_LENGTH } from './ChatPane';

/** @brief 侧栏里的一个会话。 */
export interface Row {
  /** 行的标识：本次打开过的用界面里的会话标识，否则用会话文件 */
  id: string;
  /** 工作目录 */
  cwd: string;
  /** 会话文件 */
  file: string | null;
  /** 本次打开过的会话 */
  tab?: Tab;
  /** 会话列表里的会话 */
  saved?: SavedSession;
  /** 显示的会话名 */
  title: string;
  /** 悬停显示的完整名字或第一条消息 */
  full: string;
  /** 改名框里预先填好的名字 */
  editName: string;
  /** 最后活动时间（ms） */
  activity: number;
  /** 在已归档列表里 */
  archived: boolean;
  /** 还没点开的、后台进程里的会话结束时留下的状态（store 的 rowMarks） */
  mark: 'unseen' | 'error' | null;
}

/** @brief 会话行的状态，文字见 STATUS_TEXT。 */
export type SessionStatus = 'approval' | 'question' | 'running' | 'error' | 'unseen';
export const STATUS_TEXT: Record<SessionStatus, string> = {
  approval: '等你批准', question: '等你回答', running: '生成中', error: '出错', unseen: '有新结果',
};

/** @brief 本次打开过的会话的状态；同时满足时取前面的。 */
export function sessionStatus(tab: Tab | undefined): SessionStatus | null {
  if (!tab) return null;
  const { transcript } = tab;
  if (transcript.approvals.length > 0) return 'approval';
  if (transcript.questions.length > 0) return 'question';
  if (transcript.running || transcript.sending) return 'running';
  const last = transcript.items.at(-1);
  if (tab.phase === 'failed' || tab.interrupted || (last?.kind === 'error' && last.live)) return 'error';
  return tab.unseen ? 'unseen' : null;
}

/**
 * @brief 还没点开的会话的状态：界面重新加载前就在后台进程里开着的看 live（随事件更新），结束后看留下的 mark。
 */
export function savedStatus(saved: SavedSession | undefined, mark: 'unseen' | 'error' | null): SessionStatus | null {
  const live = saved?.live;
  if (live?.approval) return 'approval';
  if (live?.question) return 'question';
  if (live?.running) return 'running';
  return mark;
}

/** @brief 会话行的状态：本次打开过的看它的对话流，其余看 savedStatus。 */
export function rowStatus(row: Row): SessionStatus | null {
  return row.tab ? sessionStatus(row.tab) : savedStatus(row.saved, row.mark);
}

/** @brief 还没有消息的会话（不能归档）。 */
export function isUnsaved(row: Row): boolean {
  return !(row.tab?.transcript.firstUserText ?? row.tab?.preview ?? row.saved?.firstMessage);
}

/** @brief 正在生成（生成中、等你批准、等你回答）：不能归档、删除。 */
export function isBusy(row: Row): boolean {
  const status = rowStatus(row);
  return status === 'running' || status === 'approval' || status === 'question';
}

/** @brief 名字或第一条消息的前 TITLE_LENGTH 个字（改名框预先填的名字，不带省略号）。 */
function editNameOf(name: string | null, first: string | null): string {
  if (name) return name;
  return [...(first?.replace(/\s+/g, ' ').trim() ?? '')].slice(0, TITLE_LENGTH).join('');
}

/** @brief 会话列表里的一个会话的行。 */
function savedRow(saved: SavedSession, archived: boolean, mark: 'unseen' | 'error' | null): Row {
  const first = saved.firstMessage && skillCommandText(saved.firstMessage);
  return { id: saved.sessionFile, cwd: saved.cwd, file: saved.sessionFile, saved,
    title: displayTitle(saved.name, saved.firstMessage), full: saved.name ?? first ?? '新会话',
    editName: editNameOf(saved.name, first), activity: saved.modified, archived, mark };
}

/** @brief 合成行用到的界面状态：已归档的会话文件、还没点开的会话留下的状态。 */
export interface RowState {
  archived: string[];
  marks: Record<string, 'unseen' | 'error'>;
}

/** @brief 本次打开过的会话和会话列表合在一起；同一个会话文件只出现一次。 */
export function buildRows(tabs: Tab[], sessions: SavedSession[], state: RowState): Row[] {
  const rows: Row[] = tabs.map((tab) => {
    const saved = sessions.find((session) => sameFile(session.sessionFile, tab.sessionFile));
    const raw = tab.transcript.firstUserText ?? tab.preview;
    const first = raw && skillCommandText(raw);
    return { id: tab.key, cwd: tab.cwd, file: tab.sessionFile, tab, saved, title: sessionTitle(tab),
      full: tab.name ?? first ?? '新会话', editName: editNameOf(tab.name, first),
      activity: Math.max(tab.activity, saved?.modified ?? 0), archived: false, mark: null };
  });
  for (const saved of sessions) {
    if (tabs.some((tab) => sameFile(tab.sessionFile, saved.sessionFile))) continue;
    rows.push(savedRow(saved, state.archived.includes(saved.sessionFile), state.marks[saved.sessionFile] ?? null));
  }
  return rows;
}

/** @brief 按项目分组：项目按其中最新的会话排，会话在项目内从新到旧。 */
export function groupRows(rows: Row[]): Array<{ cwd: string; rows: Row[] }> {
  const groups = new Map<string, Row[]>();
  for (const row of [...rows].sort((a, b) => b.activity - a.activity)) {
    groups.set(row.cwd, [...(groups.get(row.cwd) ?? []), row]);
  }
  return [...groups.entries()].map(([cwd, list]) => ({ cwd, rows: list }));
}
