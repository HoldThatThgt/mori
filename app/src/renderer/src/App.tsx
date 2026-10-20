// 根组件：读取连接 → 首次启动或三栏工作区；全局 Esc（先关浮层，再停止当前会话）；
// 全局 Alt+1 / Alt+2 / Alt+3（当前会话最前面的批准卡；有浮层开着时不起作用）。
// M5：中栏可以左右分屏，"当前会话"是焦点所在的那一栏，Esc、Alt+数字、F8、右栏都以它为准（docs/v0/screens/split.md）。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalDecision } from '../../shared/protocol';
import { stop } from './state/actions';
import { recordAction } from './state/actionLog';
import { newSession } from './state/projects';
import {
  CENTER_MIN, clamp, limitsFor, NARROW_WIDTH, PANE_MIN, RAIL_WIDTH, setLayout, splitLimits, useLayout, type DividerKind,
} from './state/layout';
import { closeTopOverlay, hasOverlay, useOverlay } from './state/overlays';
import { focusPane } from './state/split';
import { activeTab, updateTab, useApp, type Tab } from './state/store';
import { answerFrontApproval } from './components/ApprovalCard';
import { collectChanges, RightPanel } from './components/ChangesPanel';
import { ChatPane, KernelExitBanner } from './components/ChatPane';
import { Divider } from './components/Divider';
import { FirstRun, OpenFolderPrompt, SettingsPage } from './components/Pages';
import { PaneDeleteDialog } from './components/PaneTitle';
import { RefPreview } from './components/RefPreview';
import { DropHint, useSessionDrop } from './components/SessionDrag';
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

/** 右栏最窄的宽度 */
const RIGHT_MIN = 260;

/**
 * @brief 实际栏宽：保存的宽度按当前空间收紧（不改保存值，窗口变宽后恢复）。分屏时中栏至少留出两栏各 PANE_MIN；
 *        放不下两栏加最窄的右栏时 cramped 为真，右栏先收起（docs/v0/screens/split.md）。
 * @param railed 左栏收起为图标栏（或在窄窗口下浮动展开）
 * @param wantRight 当前会话的右栏想要打开
 */
function useColumns(width: number, railed: boolean, wantRight: boolean, split: boolean) {
  const layout = useLayout();
  const overlayRight = width < OVERLAY_RIGHT_WIDTH;
  const centerMin = split ? 2 * PANE_MIN : CENTER_MIN;
  const reserve = wantRight && !overlayRight && !split ? layout.workspace : 0;
  const sidebarLimits = railed ? null : limitsFor('sidebar', { width, sidebar: 0, workspace: reserve }, centerMin);
  const sidebar = sidebarLimits ? clamp(layout.sidebar, sidebarLimits) : Math.min(layout.sidebar, 360);
  const sidebarSpace = railed ? RAIL_WIDTH : sidebar;
  const cramped = split && !overlayRight && width - sidebarSpace - RIGHT_MIN < centerMin;
  const floating = overlayRight || cramped;
  const workspaceLimits = floating ? { min: RIGHT_MIN, max: Math.max(RIGHT_MIN, Math.min(800, width - RAIL_WIDTH)) }
    : limitsFor('workspace', { width, sidebar: sidebarSpace, workspace: 0 }, centerMin);
  const workspace = workspaceLimits ? clamp(layout.workspace, workspaceLimits) : RIGHT_MIN;
  return { sidebar, sidebarLimits, workspace, workspaceLimits, overlayRight, cramped };
}

/** @brief 分隔线拖动中只改内存，松开或键盘调整时保存。 */
function resize(kind: DividerKind | 'split', value: number, commit: boolean): void {
  if (commit) setLayout({ [kind]: value });
  else useLayout.setState({ [kind]: value });
}

/** @brief 元素的宽度（随窗口和栏宽变化）；还没量到时为 0。 */
function useElementWidth(element: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(target.getBoundingClientRect().width)));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** 中栏没有会话、侧栏有会话时的说明 */
const PICK_HINT = '从左侧选一个会话继续，或打开一个文件夹开始新的会话。';

/** @brief 一栏在中栏里的位置：不显示时为 undefined。 */
function sideOf(key: string, shown: string[], split: boolean): 'left' | 'right' | 'single' | undefined {
  const index = shown.indexOf(key);
  if (index < 0) return undefined;
  if (!split) return 'single';
  return index === 0 ? 'left' : 'right';
}

/** @brief 每一栏的右栏开关：按下状态和点了之后做什么。 */
interface RightToggle {
  /** 这一栏有焦点时右栏是否打开 */
  openFor: (tab: Tab) => boolean;
  /** 点了这一栏的开关 */
  toggle: (tab: Tab) => void;
}

/** @brief 分屏中线：值是左栏的像素宽度，保存为占中栏的比例。 */
function SplitDivider({ width, left }: { width: number; left: number }) {
  const limits = splitLimits(width);
  if (!width || !limits) return null;
  return (
    <Divider kind="split" label="调整两栏的宽度" value={left} limits={limits} fallback={width / 2}
      valueText={`左栏 ${left} 像素`} onChange={(value, commit) => resize('split', value / width, commit)} />
  );
}

/**
 * @brief 中栏：会话面板保持挂载（设置页只是把它藏起来，返回时滚动位置和草稿都在）；分屏时左右两栏并排，
 *        中间一条分隔线（docs/v0/screens/split.md）。
 */
function Center({ tabs, view, right }: { tabs: Tab[]; view: 'chat' | 'settings'; right: RightToggle }) {
  const activeKey = useApp((state) => state.activeKey);
  const split = useApp((state) => (view === 'chat' ? state.split : null));
  const ratio = useLayout((state) => state.split);
  const hasSaved = useApp((state) => state.saved.sessions.length > 0);
  const element = useRef<HTMLDivElement>(null);
  const width = useElementWidth(element);
  const limits = splitLimits(width);
  const left = limits ? clamp(ratio * width, limits) : Math.round(width / 2);
  const shown = view !== 'chat' ? [] : split ?? (activeKey ? [activeKey] : []);
  // 两栏的宽度由 CSS 按比例算（split.css，两栏各至少 280px），第一帧就对；量到的宽度只用于分隔线的数值和拖动。
  const style = split ? { '--split-ratio': String(ratio) } as React.CSSProperties : undefined;
  return (
    <div ref={element} className="center" data-split={split ? 'true' : undefined} style={style}>
      {tabs.map((tab) => {
        const side = sideOf(tab.key, shown, Boolean(split));
        return (
          <div key={tab.key} className="pane-slot" hidden={!side} data-tab={tab.key} data-side={side}
            data-focused={side && tab.key === activeKey ? 'true' : undefined}>
            <ChatPane tab={tab} split={Boolean(split)} rightOpen={right.openFor(tab)}
              onToggleRight={() => right.toggle(tab)} />
          </div>
        );
      })}
      {split && <SplitDivider width={width} left={left} />}
      {view === 'chat' && !tabs.some((tab) => tab.key === activeKey) && (
        <OpenFolderPrompt heading="打开一个文件夹" hint={hasSaved || tabs.length > 0 ? PICK_HINT : undefined} />
      )}
      {view === 'settings' && <SettingsPage />}
    </div>
  );
}

/** @brief 一个会话有没有改动（右栏默认跟随它）。 */
function hasChanges(tab: Tab): boolean {
  return collectChanges(tab.transcript, tab.cwd).length > 0;
}

/**
 * @brief 右栏怎么显示：贴在右边、浮在上层（窄窗口，或分屏放不下时你点开的）、不显示。右栏跟随焦点所在的一栏；
 *        分屏放不下时先收起，你点右栏开关才浮出来，回到放得下时恢复原来的开关状态。
 */
function useRightPanel(tab: Tab | undefined, view: 'chat' | 'settings', cramped: boolean) {
  const split = useApp((state) => state.split);
  const [floatRight, setFloatRight] = useState(false);
  const splitId = split?.join('|') ?? '';
  useEffect(() => setFloatRight(false), [cramped, splitId, view]);
  const openFor = (item: Tab) => (cramped ? floatRight && item.key === tab?.key : item.rightOpen ?? hasChanges(item));
  const toggle = (item: Tab) => {
    const open = openFor(item);
    focusPane(item.key);
    if (cramped) setFloatRight(!open);
    else updateTab(item.key, (current) => ({ ...current, rightOpen: !open }));
  };
  const shown = Boolean(tab) && view === 'chat' && (tab ? openFor(tab) : false);
  return { right: { openFor, toggle }, shown, floating: cramped && shown };
}

/** @brief 三栏工作区。 */
function Workspace() {
  const { tabs, activeKey, view, kernel } = useApp();
  const split = useApp((state) => state.split);
  const sidebarCollapsed = useLayout((state) => state.sidebarCollapsed);
  const width = useWindowWidth();
  const [floating, setFloating] = useState(false);
  const narrow = width < NARROW_WIDTH;
  useOverlay(narrow && floating, () => setFloating(false));
  useSessionDrop();
  const collapsed = narrow ? !floating : sidebarCollapsed;
  const tab = tabs.find((item) => item.key === activeKey);
  const wantRight = Boolean(tab) && view === 'chat' && (tab?.rightOpen ?? (tab ? hasChanges(tab) : false));
  const columns = useColumns(width, collapsed || (narrow && floating), wantRight, Boolean(split) && view === 'chat');
  const { right, shown: rightShown, floating: rightFloating } = useRightPanel(tab, view, columns.cramped);
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
          <Center tabs={tabs} view={view} right={right} />
          {rightShown && tab && (
            <aside className={`right-panel${rightFloating ? ' floating' : ''}`} aria-label="本会话的改动与文件"
              data-testid="right-panel">
              <Divider kind="workspace" label="调整右栏宽度" value={columns.workspace} limits={columns.workspaceLimits}
                onChange={(value, commit) => resize('workspace', value, commit)} />
              <RightPanel tab={tab} onClose={() => right.toggle(tab)} />
            </aside>
          )}
        </div>
      </main>
      <DropHint />
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
  return <><Workspace /><RefPreview /><PaneDeleteDialog /></>;
}
