// 记忆页的中栏（docs/specs/memory.md §10.1，替换 M7 的工作回顾；状态表见 docs/v1/screens/memory-page.md）：
// 顶部"Back to app"和标题；层（User ｜ Project，Project 旁写项目文件夹名）；Project 时增强一块（MemoryEnhance）；
// 六个分节；当前分节的内容：四种条目的用量、Last change、New entry 与列表，AGENT（MemoryAgent），Revisions（MemoryRevisions）。
// 列表里 ↑ ↓ 在行之间移动，点一行在右栏打开详情（MemoryDetail）。重读时保留上一次的列表与滚动位置，标题旁显示 Loading…。

import { useShallow } from 'zustand/react/shallow';
import {
  countsText, KIND_LABEL, localDate, monthDay, type EntryRow, type MemoryKind, type MemoryListResult, type RevisionRow,
} from '../../../shared/memory';
import {
  chooseScope, chooseSection, MEMORY_SECTIONS, openNewEntry, SECTION_ID, SECTION_LABEL, selectEntry, selectRevision,
  SOURCE_LABEL, usePlace, useMemory, useUnavailable, type MemorySection, type MemoryState,
} from '../state/memory';
import { showChat } from '../state/projects';
import { Icon } from '../icons';
import { folderName } from './ChatPane';
import { moveMenuFocus } from './menu';
import { MemoryAgent } from './MemoryAgent';
import { LoadError, unavailableTitle } from './MemoryCommon';
import { MemoryEnhance } from './MemoryEnhance';
import { RevisionList } from './MemoryRevisions';

/** 没有打开的会话时 Project 的悬停说明 */
const NO_PROJECT = 'Open a session to see this project’s memory.';

/** @brief 当前分节读到的内容；还没读到时为 null。 */
function contentOf(state: MemoryState): unknown {
  if (state.section === 'agent') return state.agents;
  return state.section === 'revisions' ? state.revisions : state.list;
}

/** @brief 层：分段按钮 User ｜ Project，Project 旁写项目文件夹名；没有打开的会话时 Project 不可用。 */
function ScopeSwitch() {
  const { scope, cwd } = usePlace();
  const unavailable = useUnavailable();
  const projectTitle = cwd === null ? NO_PROJECT : unavailableTitle(unavailable);
  return (
    <div className="memory-scope">
      <div className="memory-segments" role="group" aria-label="Layer">
        <button type="button" data-testid="memory-scope-user" aria-pressed={scope === 'user'}
          disabled={unavailable !== null} title={unavailableTitle(unavailable)} onClick={() => chooseScope('user')}>
          User</button>
        <button type="button" data-testid="memory-scope-project" aria-pressed={scope === 'project'}
          disabled={cwd === null || unavailable !== null} title={projectTitle} onClick={() => chooseScope('project')}>
          Project</button>
      </div>
      {cwd !== null && <span className="memory-folder" title={cwd}>{folderName(cwd)}</span>}
    </div>
  );
}

/** @brief 六个分节（aria-pressed 为当前分节）。 */
function SectionNav({ section }: { section: MemorySection }) {
  const unavailable = useUnavailable();
  return (
    <div className="memory-segments memory-sections" role="group" aria-label="Sections">
      {MEMORY_SECTIONS.map((item) => (
        <button key={item} type="button" data-testid={`memory-section-${SECTION_ID[item]}`}
          aria-pressed={item === section} disabled={unavailable !== null} title={unavailableTitle(unavailable)}
          onClick={() => chooseSection(item)}>{SECTION_LABEL[item]}</button>
      ))}
    </div>
  );
}

/** @brief 用量：`<used> / 500 tokens`，Project 时加两层各自的数，超出时数字为警告色并加 ` · Over the limit`。 */
function Usage({ list, project }: { list: MemoryListResult; project: boolean }) {
  const { used, limit, user } = list.usage;
  const over = used > limit;
  return (
    <span className="memory-usage" data-testid="memory-usage">
      <span className={over ? 'memory-over' : undefined}>{used}</span>
      {` / ${limit} tokens`}
      {project && ` · User ${user} + this project ${list.usage.project}`}
      {over && <span className="memory-over">{' · Over the limit'}</span>}
    </span>
  );
}

/** @brief 最近一次改到这一种的修订：点它切到 Revisions 选中那一次。 */
function LastChange({ row }: { row: RevisionRow }) {
  const unavailable = useUnavailable();
  return (
    <button type="button" className="text-link memory-last" data-testid="memory-last-change"
      disabled={unavailable !== null} title={unavailableTitle(unavailable)} onClick={() => selectRevision(row.id)}>
      Last change {monthDay(localDate(Date.parse(row.time)))} · {countsText(row.counts)}
    </button>
  );
}

/** @brief 分节的第一行：用量、Last change、New entry。 */
function ListHead({ list, project, waiting }: { list: MemoryListResult; project: boolean; waiting: boolean }) {
  const unavailable = useUnavailable();
  return (
    <div className="memory-head">
      <Usage list={list} project={project} />
      {list.last && <LastChange row={list.last} />}
      <button type="button" className="button memory-new" data-testid="memory-new" onClick={openNewEntry}
        disabled={unavailable !== null || waiting} title={unavailableTitle(unavailable)}>
        <Icon name="plus" />New entry</button>
    </div>
  );
}

/** @brief 列表的一行：abstract，右边 You said / Added by Mori / Learned 与修改日期；选中的高亮。 */
function EntryButton({ entry }: { entry: EntryRow }) {
  const selected = useMemory((state) => state.panel.kind === 'entry' && state.panel.id === entry.id);
  const unavailable = useUnavailable();
  return (
    <button type="button" className="memory-row" data-testid="memory-row" data-id={entry.id}
      data-source={entry.source} aria-pressed={selected} disabled={unavailable !== null}
      title={unavailableTitle(unavailable)} onClick={() => selectEntry(entry.id)}>
      <span className="memory-row-title">{entry.abstract}</span>
      <span className="memory-row-meta">
        <span className={`memory-tag ${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
        <span>{monthDay(entry.modified)}</span>
      </span>
    </button>
  );
}

/** @brief 一种条目的列表：读得出来的（可以选中）、读不出来的（文件名与原因，不能选中）；都没有时 No entries yet.。 */
function EntryList({ kind, list }: { kind: MemoryKind; list: MemoryListResult }) {
  const empty = list.entries.length === 0 && list.broken.length === 0;
  return (
    <>
      <ul className="memory-rows" data-testid="memory-list" aria-label={KIND_LABEL[kind]} onKeyDown={moveMenuFocus}>
        {list.entries.map((entry) => <li key={entry.id}><EntryButton entry={entry} /></li>)}
        {list.broken.map((item) => (
          <li key={`broken:${item.name}`}>
            <div className="memory-row broken" data-testid="memory-broken" data-name={item.name}>
              <span className="memory-row-title">Couldn’t read the entry {item.name}</span>
              <span className="memory-row-error">{item.error}</span>
            </div>
          </li>
        ))}
      </ul>
      {empty && <p className="memory-state">No entries yet.</p>}
    </>
  );
}

/** @brief 四种条目之一的分节：读取失败、读取中、第一行与列表。 */
function KindSection({ kind }: { kind: MemoryKind }) {
  const { list, loadError } = useMemory(useShallow((state) => ({ list: state.list, loadError: state.loadError })));
  const { scope, waiting } = usePlace();
  if (loadError) return <LoadError text={loadError} />;
  if (!list) return <p className="memory-state" role="status">Loading…</p>;
  return (
    <>
      <ListHead list={list} project={scope === 'project'} waiting={waiting && scope === 'project'} />
      <EntryList kind={kind} list={list} />
    </>
  );
}

/** @brief 当前分节的内容。 */
function SectionContent({ section }: { section: MemorySection }) {
  if (section === 'agent') return <MemoryAgent />;
  if (section === 'revisions') return <RevisionList />;
  return <KindSection kind={section} />;
}

/** @brief 记忆页（中栏）。换层、分节、项目时内容区从头显示；重读时（已经有内容）标题旁显示 Loading…。 */
export function MemoryPage() {
  const { scope, section, cwd } = usePlace();
  const rereading = useMemory((state) => state.loading && contentOf(state) !== null);
  return (
    <section className="memory-page" data-testid="memory-page">
      <header className="topbar">
        <button type="button" className="button" onClick={() => showChat()}><Icon name="back" />Back to app</button>
        <span className="chat-title">Memory</span>
        {rereading && <span className="memory-reading" role="status">Loading…</span>}
      </header>
      <div className="memory-controls"><ScopeSwitch /></div>
      {scope === 'project' && <MemoryEnhance />}
      <div className="memory-controls"><SectionNav section={section} /></div>
      <div className="memory-content" key={`${scope}|${section}|${cwd ?? ''}`}>
        <div className="memory-inner"><SectionContent section={section} /></div>
      </div>
    </section>
  );
}
