// 根组件：读取连接 → 首次启动或三栏工作区；全局 Esc（先关浮层，再停止当前会话）；
// 全局 Alt+1 / Alt+2 / Alt+3（当前会话最前面的批准卡；有浮层开着时不起作用）。

import { useEffect, useState } from 'react';
import type { ApprovalDecision } from '../../shared/protocol';
import { stop } from './state/actions';
import { recordAction } from './state/actionLog';
import { newSession } from './state/projects';
import { clamp, limitsFor, NARROW_WIDTH, RAIL_WIDTH, setLayout, useLayout, type DividerKind } from './state/layout';
import { closeTopOverlay, hasOverlay, useOverlay } from './state/overlays';
import { activeTab, updateTab, useApp, type Tab } from './state/store';
import { answerFrontApproval } from './components/ApprovalCard';
import { collectChanges, RightPanel } from './components/ChangesPanel';
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

/** @brief 焦点是否在这个会话的面板里（或不在任何元素上）。 */
function focusInPane(tabKey: string): boolean {
  const focused = document.activeElement;
  if (!focused || focused === document.body) return true;
  return Boolean(document.querySelector(`[data-testid="chat-pane"][data-tab="${tabKey}"]`)?.contains(focused));
}

/**
 * @brief Esc：先关闭最上层的浮层；没有浮层、显示的是会话且焦点在会话面板里时停止生成。
 *        焦点在批准卡上时卡片自己处理（先关浮层，没有浮层才拒绝这张卡），这里看到 defaultPrevented 就跳过。
 */
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
      if (state.view !== 'chat' || !tab?.transcript.running || !focusInPane(tab.key)) return;
      event.preventDefault();
      recordAction('按 Esc 停止');
      void stop(tab.key);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Alt+数字对应的批准卡选项：只认主键盘的数字行（按物理键位），数字键区不算（Alt+数字键区是 Windows 输入字符的方式） */
const APPROVAL_KEYS: Record<string, ApprovalDecision> = { Digit1: 'allow', Digit2: 'allowSession', Digit3: 'reject' };

/** @brief 按键对应的批准卡选项；不是 Alt+1 / Alt+2 / Alt+3 时为 null。按住不放的重复按键不算。 */
function approvalDecision(event: KeyboardEvent): ApprovalDecision | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return null;
  return APPROVAL_KEYS[event.code] ?? null;
}

/**
 * @brief Alt+1 / Alt+2 / Alt+3：显示的是会话、焦点在当前会话面板里（包括输入框）时，选择最前面那张批准卡；
 *        有菜单、对话框或报告框开着时不起作用（不能在它们背后批准）。
 */
function useApprovalKeys(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const decision = approvalDecision(event);
      if (!decision || event.defaultPrevented || hasOverlay()) return;
      const state = useApp.getState();
      const tab = activeTab(state);
      if (state.view !== 'chat' || !tab || !focusInPane(tab.key)) return;
      if (answerFrontApproval(tab.key, decision)) event.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** @brief Ctrl+N：新会话（在当前会话所在的项目里新建）；有菜单、对话框或报告框开着时不起作用。 */
function useNewSessionKey(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== 'KeyN' || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
      if (event.defaultPrevented || event.repeat || hasOverlay()) return;
      const state = useApp.getState();
      // 首次启动页、后台进程已退出、上一个新会话还在打开时不新建。
      if (!state.config || state.firstRun || state.kernel === 'exited' || activeTab(state)?.phase === 'opening') return;
      event.preventDefault();
      void newSession();
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

/** 中栏没有会话、侧栏有会话时的说明 */
const PICK_HINT = '从左侧选一个会话继续，或打开一个文件夹开始新的会话。';

/** @brief 中栏：会话面板保持挂载（设置页只是把它藏起来，返回时滚动位置和草稿都在）。 */
function Center({ tabs, activeKey, view, rightOpen, onToggleRight }: {
  tabs: Tab[]; activeKey: string | null; view: 'chat' | 'settings'; rightOpen: boolean; onToggleRight: () => void;
}) {
  const hasSaved = useApp((state) => state.saved.sessions.length > 0);
  return (
    <div className="center">
      {tabs.map((tab) => (
        <div key={tab.key} className="pane-slot" hidden={view !== 'chat' || tab.key !== activeKey}>
          <ChatPane tab={tab} rightOpen={rightOpen} onToggleRight={onToggleRight} />
        </div>
      ))}
      {view === 'chat' && !tabs.some((tab) => tab.key === activeKey) && (
        <OpenFolderPrompt heading="打开一个文件夹" hint={hasSaved || tabs.length > 0 ? PICK_HINT : undefined} />
      )}
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
        onToggle={() => (narrow ? setFloating(!floating) : setLayout({ sidebarCollapsed: !sidebarCollapsed }))}
        onNavigate={() => setFloating(false)}>
        {!collapsed && !floating && <Divider kind="sidebar" label="调整左栏宽度" value={columns.sidebar}
          limits={columns.sidebarLimits} onChange={(value, commit) => resize('sidebar', value, commit)} />}
      </Sidebar>
      <main className="main">
        {kernel === 'exited' && (view !== 'chat' || !tab) && <div className="global-banner"><KernelExitBanner /></div>}
        <div className="body">
          <Center tabs={tabs} activeKey={activeKey} view={view} rightOpen={rightOpen} onToggleRight={toggleRight} />
          {rightOpen && tab && (
            <aside className="right-panel" aria-label="本会话的改动与文件" data-testid="right-panel">
              <Divider kind="workspace" label="调整右栏宽度" value={columns.workspace} limits={columns.workspaceLimits}
                onChange={(value, commit) => resize('workspace', value, commit)} />
              <RightPanel tab={tab} onClose={toggleRight} />
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
  useApprovalKeys();
  useNewSessionKey();
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
