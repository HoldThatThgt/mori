// 根组件：读取连接 → 首次启动或三栏工作区；全局 Esc（先关浮层，再停止当前会话）。

import { useEffect, useState } from 'react';
import { stop } from './state/actions';
import { clamp, limitsFor, NARROW_WIDTH, RAIL_WIDTH, setLayout, useLayout, type DividerKind } from './state/layout';
import { closeTopOverlay, useOverlay } from './state/overlays';
import { activeTab, updateTab, useApp, type Tab } from './state/store';
import { ChangesPanel, collectChanges } from './components/ChangesPanel';
import { ChatPane, KernelExitBanner } from './components/ChatPane';
import { Divider } from './components/Divider';
import { FirstRun, OpenFolderPrompt, SettingsPage } from './components/Pages';
import { Sidebar } from './components/Sidebar';

/** 窄于此宽度时右栏浮在中栏上层（方案 5.1） */
const OVERLAY_RIGHT_WIDTH = 800;

/** @brief 当前窗口宽度。 */
function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** @brief Esc：先关闭最上层的浮层；没有浮层、显示的是会话且焦点在会话面板里时停止生成。 */
function useEscape(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (closeTopOverlay()) {
        event.preventDefault();
        return;
      }
      const state = useApp.getState();
      const tab = activeTab(state);
      if (state.view !== 'chat' || !tab?.transcript.running) return;
      const focused = document.activeElement;
      const pane = document.querySelector('[data-testid="chat-pane"]');
      if (focused && focused !== document.body && !pane?.contains(focused)) return;
      event.preventDefault();
      void stop(tab.key);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** @brief 实际栏宽：保存的宽度按当前空间收紧（不改保存值，窗口变宽后恢复）。 */
function useColumns(width: number, collapsed: boolean, floating: boolean, rightOpen: boolean) {
  const layout = useLayout();
  const overlayRight = width < OVERLAY_RIGHT_WIDTH;
  const sidebarLimits = collapsed || floating ? null
    : limitsFor('sidebar', { width, sidebar: 0, workspace: rightOpen && !overlayRight ? layout.workspace : 0 });
  const sidebar = sidebarLimits ? clamp(layout.sidebar, sidebarLimits) : Math.min(layout.sidebar, 360);
  const sidebarSpace = collapsed || floating ? RAIL_WIDTH : sidebar;
  const workspaceLimits = !rightOpen ? null : overlayRight
    ? { min: 260, max: Math.max(260, Math.min(800, width - RAIL_WIDTH)) }
    : limitsFor('workspace', { width, sidebar: sidebarSpace, workspace: 0 });
  const workspace = workspaceLimits ? clamp(layout.workspace, workspaceLimits) : 260;
  return { sidebar, sidebarLimits, workspace, workspaceLimits };
}

/** @brief 分隔线拖动中只改内存，松开或键盘调整时保存。 */
function resize(kind: DividerKind, value: number, commit: boolean): void {
  if (commit) setLayout({ [kind]: value });
  else useLayout.setState({ [kind]: value });
}

/** @brief 中栏：会话面板保持挂载（设置页只是把它藏起来，返回时滚动位置和草稿都在）。 */
function Center({ tabs, activeKey, view, rightOpen, onToggleRight }: {
  tabs: Tab[]; activeKey: string | null; view: 'chat' | 'settings'; rightOpen: boolean; onToggleRight: () => void;
}) {
  return (
    <div className="center">
      {tabs.map((tab) => (
        <div key={tab.key} className="pane-slot" hidden={view !== 'chat' || tab.key !== activeKey}>
          <ChatPane tab={tab} rightOpen={rightOpen} onToggleRight={onToggleRight} />
        </div>
      ))}
      {view === 'chat' && tabs.length === 0 && <OpenFolderPrompt heading="打开一个文件夹" />}
      {view === 'settings' && <SettingsPage />}
    </div>
  );
}

/** @brief 三栏工作区。 */
function Workspace() {
  const { tabs, activeKey, view, kernel } = useApp();
  const sidebarCollapsed = useLayout((state) => state.sidebarCollapsed);
  const width = useWindowWidth();
  const [floating, setFloating] = useState(false);
  const narrow = width < NARROW_WIDTH;
  useOverlay(narrow && floating, () => setFloating(false));
  const collapsed = narrow ? !floating : sidebarCollapsed;
  const tab = tabs.find((item) => item.key === activeKey);
  const changes = tab ? collectChanges(tab.transcript, tab.cwd).length > 0 : false;
  const rightOpen = Boolean(tab) && view === 'chat' && (tab?.rightOpen ?? changes);
  const columns = useColumns(width, collapsed, narrow && floating, rightOpen);
  const toggleRight = () => tab && updateTab(tab.key, (current) => ({ ...current, rightOpen: !rightOpen }));
  const style = { '--sidebar-width': `${columns.sidebar}px`, '--workspace-width': `${columns.workspace}px` };
  return (
    <div className="app" style={style as React.CSSProperties}>
      {narrow && floating && <div className="sidebar-spacer" />}
      <Sidebar collapsed={collapsed && !(narrow && floating)} floating={narrow && floating}
        onToggle={() => (narrow ? setFloating(!floating) : setLayout({ sidebarCollapsed: !sidebarCollapsed }))}>
        {!collapsed && !floating && <Divider kind="sidebar" label="调整左栏宽度" value={columns.sidebar}
          limits={columns.sidebarLimits} onChange={(value, commit) => resize('sidebar', value, commit)} />}
      </Sidebar>
      <main className="main">
        {kernel === 'exited' && (view !== 'chat' || !tab) && <div className="global-banner"><KernelExitBanner /></div>}
        <div className="body">
          <Center tabs={tabs} activeKey={activeKey} view={view} rightOpen={rightOpen} onToggleRight={toggleRight} />
          {rightOpen && tab && (
            <aside className="right-panel" aria-label="本会话的改动" data-testid="right-panel">
              <Divider kind="workspace" label="调整右栏宽度" value={columns.workspace} limits={columns.workspaceLimits}
                onChange={(value, commit) => resize('workspace', value, commit)} />
              <ChangesPanel transcript={tab.transcript} cwd={tab.cwd} onClose={toggleRight} />
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}

/** @brief 根组件。 */
export function App() {
  const config = useApp((state) => state.config);
  const configError = useApp((state) => state.configError);
  const firstRun = useApp((state) => state.firstRun);
  const kernel = useApp((state) => state.kernel);
  useEscape();
  if (configError) {
    return (
      <main className="first-run">
        <div className="first-run-card">
          {kernel === 'exited' ? <KernelExitBanner /> : <p className="form-message error">读取连接失败：{configError}</p>}
        </div>
      </main>
    );
  }
  if (!config) return <main className="first-run"><p className="muted">正在读取连接…</p></main>;
  if (firstRun) return <FirstRun exited={kernel === 'exited'} />;
  return <Workspace />;
}
