// 左栏：品牌与收起、"新会话"（Ctrl+N）、"打开文件夹…"、项目 → 会话树（SessionTree）、报告界面问题（F8）、设置。

import { openSettings } from '../state/actions';
import { newSession, openFolder } from '../state/projects';
import { isShown, sameFile, useApp, type AppState } from '../state/store';
import { BrandMark, Icon } from '../icons';
import { openIssueReport } from './IssueDialog';
import { savedStatus, sessionStatus, STATUS_TEXT, type SessionStatus } from './sessionRows';
import { SessionTree } from './SessionTree';

/** F8 入口的文字；收起为图标栏时作为按钮的名称 */
const REPORT_LABEL = '报告界面问题（F8）';
/** 新会话按钮的名称 */
const NEW_SESSION_LABEL = '新会话（Ctrl+N）';

/** 收起为图标栏时"展开"按钮上显示的状态，按这个顺序取第一个 */
const RAIL_ORDER: SessionStatus[] = ['approval', 'question', 'error', 'unseen'];

/** @brief 不在中栏显示的会话里最要紧的状态（收起为图标栏时看不到会话行）；包括界面重新加载后还没点开的会话。 */
function hiddenStatus(state: AppState): SessionStatus | null {
  const hidden = state.tabs.filter((tab) => !isShown(tab.key, state));
  const untabbed = state.saved.sessions
    .filter((item) => !state.tabs.some((tab) => sameFile(tab.sessionFile, item.sessionFile)));
  const statuses = [...hidden.map((tab) => sessionStatus(tab)),
    ...untabbed.map((item) => savedStatus(item, state.rowMarks[item.sessionFile] ?? null))];
  return RAIL_ORDER.find((status) => statuses.includes(status)) ?? null;
}

/** @brief 左栏。children 是分隔线；onNavigate 在打开或切换会话后调用（浮动的左栏据此收起）。 */
export function Sidebar({ collapsed, floating, onToggle, onNavigate, children }: {
  collapsed: boolean; floating: boolean; onToggle: () => void; onNavigate: () => void; children?: React.ReactNode;
}) {
  const view = useApp((state) => state.view);
  const exited = useApp((state) => state.kernel === 'exited');
  const railStatus = useApp(hiddenStatus);
  const className = `sidebar${collapsed ? ' collapsed' : ''}${floating ? ' floating' : ''}`;
  const toggleLabel = collapsed
    ? `展开侧栏${railStatus ? `（有会话${STATUS_TEXT[railStatus]}）` : ''}` : '收起侧栏';
  const unavailable = exited ? '后台进程已退出，先重新载入' : undefined;
  return (
    <aside className={className} aria-label="侧栏" data-testid="sidebar">
      <div className="brand-row">
        {!collapsed && <><BrandMark /><span className="brand">mori</span></>}
        <button className="icon-button rail-toggle" onClick={onToggle} aria-label={toggleLabel} title={toggleLabel}
          aria-expanded={!collapsed}>
          <Icon name="panel" />
          {collapsed && railStatus && <span className={`rail-dot ${railStatus}`} data-testid="rail-status" />}
        </button>
      </div>
      <nav className="sidebar-nav">
        <button className="nav-item primary" onClick={() => void newSession()} title={unavailable ?? NEW_SESSION_LABEL}
          aria-label={NEW_SESSION_LABEL} data-testid="new-session" disabled={exited}>
          <Icon name="plus" /><span className="nav-label">新会话</span><span className="nav-hint">Ctrl+N</span>
        </button>
        <button className="nav-item" onClick={() => void openFolder()} title={unavailable ?? '打开文件夹…'}
          aria-label="打开文件夹…" disabled={exited}>
          <Icon name="folder" /><span className="nav-label">打开文件夹…</span>
        </button>
      </nav>
      <div className="sidebar-sessions">
        <SessionTree onNavigate={onNavigate} />
      </div>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => void openIssueReport()} title={REPORT_LABEL}
          aria-label={REPORT_LABEL}>
          <Icon name="flag" /><span className="nav-label">{REPORT_LABEL}</span>
        </button>
        <button className={`nav-item${view === 'settings' ? ' active' : ''}`} onClick={() => openSettings()} title="设置">
          <Icon name="settings" /><span className="nav-label">设置</span>
        </button>
      </div>
      {children}
    </aside>
  );
}
