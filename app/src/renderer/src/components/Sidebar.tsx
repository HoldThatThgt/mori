// 左栏：品牌与收起、"Open folder…"、"Customize"（M6）、"Memory"（在 M7 "Review" 原来的位置，docs/specs/memory.md §10.1；
// 后台进程退出后不可用）、项目 → 会话树（SessionTree，每个项目行右端一个 + 新建会话）、"Report a UI issue (F8)"、
// "Settings"。收起为图标栏时最上面多一个 +（"New session (Ctrl+N)"）：图标栏没有项目行（docs/v0/screens/sessions.md"左栏"）。

import { openSettings, openTools } from '../state/actions';
import { guardLeave } from '../state/leaveGuard';
import { openMemory } from '../state/memory';
import { newSession, openFolder } from '../state/projects';
import { isShown, sameFile, useApp, type AppState } from '../state/store';
import { BrandMark, Icon } from '../icons';
import { openIssueReport } from './IssueDialog';
import { savedStatus, sessionStatus, type SessionStatus } from './sessionRows';
import { CRASHED_HINT, SessionTree } from './SessionTree';

/** F8 入口的文字；收起为图标栏时作为按钮的名称 */
const REPORT_LABEL = 'Report a UI issue (F8)';
/** 图标栏上 + 的名称 */
const NEW_SESSION_LABEL = 'New session (Ctrl+N)';

/** @brief 收起为图标栏时"Open sidebar"按钮上显示的状态（生成中不显示）。 */
type RailStatus = Exclude<SessionStatus, 'running'>;
/** 收起为图标栏时"Open sidebar"按钮上显示的状态，按这个顺序取第一个 */
const RAIL_ORDER: RailStatus[] = ['approval', 'question', 'error', 'unseen'];
/** 这些状态在"Open sidebar"按钮读屏名和悬停说明里的写法："Open sidebar (a session needs approval)" */
const RAIL_TEXT: Record<RailStatus, string> = {
  approval: 'a session needs approval', question: 'a session needs input', error: 'a session has an error',
  unseen: 'a session has unread results',
};

/** @brief 不在中栏显示的会话里最要紧的状态（收起为图标栏时看不到会话行）；包括界面重新加载后还没点开的会话。 */
function hiddenStatus(state: AppState): RailStatus | null {
  const hidden = state.tabs.filter((tab) => !isShown(tab.key, state));
  const untabbed = state.saved.sessions
    .filter((item) => !state.tabs.some((tab) => sameFile(tab.sessionFile, item.sessionFile)));
  const statuses = [...hidden.map((tab) => sessionStatus(tab)),
    ...untabbed.map((item) => savedStatus(item, state.rowMarks[item.sessionFile] ?? null))];
  return RAIL_ORDER.find((status) => statuses.includes(status)) ?? null;
}

/**
 * @brief 左栏顶部的导航："Open folder…"、"Customize"、"Memory"；collapsed 为真（图标栏）时最上面还有 +，同 Ctrl+N。
 *        后台进程退出后都不可用，悬停说明原因。
 */
function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const view = useApp((state) => state.view);
  const exited = useApp((state) => state.kernel === 'exited');
  const unavailable = exited ? CRASHED_HINT : undefined;
  return (
    <nav className="sidebar-nav">
      {collapsed && (
        <button className="nav-item primary" onClick={() => void newSession()} title={unavailable ?? NEW_SESSION_LABEL}
          aria-label={NEW_SESSION_LABEL} data-testid="rail-new-session" disabled={exited}>
          <Icon name="plus" />
        </button>
      )}
      <button className="nav-item" onClick={() => void openFolder()} title={unavailable ?? 'Open folder…'}
        aria-label="Open folder…" data-testid="nav-open-folder" disabled={exited}>
        <Icon name="folder" /><span className="nav-label">Open folder…</span>
      </button>
      <button className={`nav-item${view === 'tools' ? ' active' : ''}`} onClick={openTools}
        title={unavailable ?? 'Customize'} aria-label="Customize" data-testid="nav-tools" disabled={exited}>
        <Icon name="tools" /><span className="nav-label">Customize</span>
      </button>
      <button className={`nav-item${view === 'memory' ? ' active' : ''}`} onClick={openMemory}
        title={unavailable ?? 'Memory'} aria-label="Memory" data-testid="nav-memory" disabled={exited}>
        <Icon name="memory" /><span className="nav-label">Memory</span>
      </button>
    </nav>
  );
}

/** @brief 左栏。children 是分隔线；onNavigate 在打开或切换会话后调用（浮动的左栏据此收起）。 */
export function Sidebar({ collapsed, floating, onToggle, onNavigate, children }: {
  collapsed: boolean; floating: boolean; onToggle: () => void; onNavigate: () => void; children?: React.ReactNode;
}) {
  const view = useApp((state) => state.view);
  const railStatus = useApp(hiddenStatus);
  const className = `sidebar${collapsed ? ' collapsed' : ''}${floating ? ' floating' : ''}`;
  const toggleLabel = collapsed
    ? `Open sidebar${railStatus ? ` (${RAIL_TEXT[railStatus]})` : ''}` : 'Close sidebar';
  return (
    <aside className={className} aria-label="Sidebar" data-testid="sidebar">
      <div className="brand-row">
        {!collapsed && <><BrandMark /><span className="brand">mori</span></>}
        <button className="icon-button rail-toggle" onClick={onToggle} aria-label={toggleLabel} title={toggleLabel}
          aria-expanded={!collapsed}>
          <Icon name="panel" />
          {collapsed && railStatus && <span className={`rail-dot ${railStatus}`} data-testid="rail-status" />}
        </button>
      </div>
      <SidebarNav collapsed={collapsed} />
      <div className="sidebar-sessions">
        <SessionTree onNavigate={onNavigate} />
      </div>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => void openIssueReport()} title={REPORT_LABEL}
          aria-label={REPORT_LABEL}>
          <Icon name="flag" /><span className="nav-label">{REPORT_LABEL}</span>
        </button>
        <button className={`nav-item${view === 'settings' ? ' active' : ''}`}
          onClick={() => (view === 'settings' ? openSettings() : guardLeave(openSettings))} title="Settings">
          <Icon name="settings" /><span className="nav-label">Settings</span>
        </button>
      </div>
      {children}
    </aside>
  );
}
