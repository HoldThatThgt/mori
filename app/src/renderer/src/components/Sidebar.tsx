// 左栏（M1 范围）：品牌与收起、"打开文件夹…"、本次运行打开过的会话（按文件夹分组）、设置。

import { openFolder, openSettings } from '../state/actions';
import { useApp, type Tab } from '../state/store';
import { BrandMark, Icon } from '../icons';
import { folderName, sessionTitle } from './ChatPane';

/** @brief 按文件夹分组，保持打开顺序。 */
function groupByFolder(tabs: Tab[]): Array<{ cwd: string; tabs: Tab[] }> {
  const groups = new Map<string, Tab[]>();
  for (const tab of tabs) groups.set(tab.cwd, [...(groups.get(tab.cwd) ?? []), tab]);
  return [...groups.entries()].map(([cwd, list]) => ({ cwd, tabs: list }));
}

/** @brief 左栏。children 是分隔线。 */
export function Sidebar({ collapsed, floating, onToggle, children }: {
  collapsed: boolean; floating: boolean; onToggle: () => void; children?: React.ReactNode;
}) {
  const tabs = useApp((state) => state.tabs);
  const activeKey = useApp((state) => state.activeKey);
  const view = useApp((state) => state.view);
  const className = `sidebar${collapsed ? ' collapsed' : ''}${floating ? ' floating' : ''}`;
  return (
    <aside className={className} aria-label="侧栏" data-testid="sidebar">
      <div className="brand-row">
        {!collapsed && <><BrandMark /><span className="brand">mori</span></>}
        <button className="icon-button" onClick={onToggle} aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!collapsed}><Icon name="panel" /></button>
      </div>
      <nav className="sidebar-nav">
        <button className="nav-item primary" onClick={() => void openFolder()} title="打开文件夹…">
          <Icon name="folder" /><span className="nav-label">打开文件夹…</span>
        </button>
      </nav>
      <div className="sidebar-sessions">
        {tabs.length > 0 && <div className="section-caption">本次打开的会话</div>}
        {groupByFolder(tabs).map((group) => (
          <div key={group.cwd} className="project-group">
            <div className="project-heading" title={group.cwd}>
              <Icon name="folder" /><span>{folderName(group.cwd)}</span>
            </div>
            {group.tabs.map((tab) => (
              <button key={tab.key}
                className={`session-item${view === 'chat' && tab.key === activeKey ? ' active' : ''}`}
                onClick={() => useApp.setState({ activeKey: tab.key, view: 'chat' })}>
                <Icon name="chat" /><span className="session-label">{sessionTitle(tab)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-bottom">
        <button className={`nav-item${view === 'settings' ? ' active' : ''}`} onClick={() => openSettings()} title="设置">
          <Icon name="settings" /><span className="nav-label">设置</span>
        </button>
      </div>
      {children}
    </aside>
  );
}
