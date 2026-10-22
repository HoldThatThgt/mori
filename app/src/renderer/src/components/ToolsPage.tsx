// 工具页（标题"Customize"，docs/v0/screens/tools.md）：中栏换成工具页，顶部"Back to app"、标题和跟随的会话，
// 下面一行说明改动对新建的会话生效；左边分节（Built-in tools、Skills、MCP、Plugins），右边这一节的内容。
// 跟随的是当前会话（分屏时焦点所在的那一栏）；工具页开着时在侧栏归档或删除了它，跟到剩下的那一栏。
// 还在打开中时等它打开；没有会话时只列出技能和插件（用户级）。

import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ToolsInfo } from '../../../shared/protocol';
import { newSession, showChat } from '../state/projects';
import { useApp, type AppState } from '../state/store';
import { loadTools, resetTools, useTools } from '../state/tools';
import { Icon } from '../icons';
import { folderName, sessionTitle } from './ChatPane';
import { BuiltinSection } from './ToolsBuiltin';
import { McpSection } from './ToolsMcp';
import { PluginsSection } from './ToolsPlugins';
import { SkillsSection } from './ToolsSkills';

/** @brief 工具页的分节。 */
type Section = 'builtin' | 'skills' | 'mcp' | 'plugins';

/** 分节的文字 */
const SECTION_TEXT: Record<Section, string> = {
  builtin: 'Built-in tools', skills: 'Skills', mcp: 'MCP', plugins: 'Plugins',
};

/** 没有跟随的会话时顶部的说明 */
const NO_SESSION = 'No open session. Only user-level skills and plugins are listed.';

/** @brief 跟随的会话。 */
interface Followed {
  /** 界面里的标识 */
  key: string;
  /** pi 会话 id；还在打开中时为 null */
  sessionId: string | null;
  /** 还在打开中 */
  opening: boolean;
  /** "<项目名> · <会话名>" */
  title: string;
}

/** @brief 跟随的会话；它已经不在界面里、或没有打开成功时为 null。 */
function followedOf(state: AppState, key: string | null): Followed | null {
  const tab = state.tabs.find((item) => item.key === key);
  if (!tab || tab.phase === 'failed') return null;
  return { key: tab.key, sessionId: tab.phase === 'ready' ? tab.sessionId : null, opening: tab.phase === 'opening',
    title: `${folderName(tab.cwd)} · ${sessionTitle(tab)}` };
}

/** @brief 进入工具页时读取；跟随的会话打开好了（或重新载入后换了 pi 会话 id）时再读；离开时丢掉读到的内容。 */
function useToolsLoad(followed: Followed | null): void {
  const sessionId = followed?.sessionId ?? null;
  const waiting = followed?.opening ?? false;
  useEffect(() => {
    if (!waiting) void loadTools(sessionId);
  }, [sessionId, waiting]);
  useEffect(() => resetTools, []);
}

/**
 * @brief 左边的分节列表：Tab 进入、在按钮之间移动，↑ ↓ 从焦点所在的按钮切到上一节 / 下一节（焦点不在分节按钮上时
 *        从当前分节算）；当前分节 aria-current。
 */
function SectionNav({ sections, current, onSelect }: {
  sections: Section[]; current: Section; onSelect: (section: Section) => void;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-section]')?.dataset.section;
    const at = sections.indexOf(focused as Section);
    const from = at >= 0 ? at : sections.indexOf(current);
    const next = sections[(from + step + sections.length) % sections.length];
    onSelect(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)?.focus();
  }
  return (
    <nav className="tools-nav" aria-label="Customize page sections" data-testid="tools-nav" onKeyDown={onKeyDown}>
      {sections.map((section) => (
        <button key={section} type="button" data-section={section} onClick={() => onSelect(section)}
          aria-current={section === current ? 'page' : undefined}>{SECTION_TEXT[section]}</button>
      ))}
    </nav>
  );
}

/** @brief 一节的内容；cwd 是跟随的会话的工作目录（没有会话时为 agentDir），只用于"Open in default app"。 */
function SectionContent({ section, info, tabKey, agentDir }: {
  section: Section; info: ToolsInfo; tabKey: string | null; agentDir: string;
}) {
  const cwd = info.cwd ?? agentDir;
  switch (section) {
    case 'builtin':
      return <BuiltinSection tools={info.tools ?? []} />;
    case 'skills':
      return <SkillsSection skills={info.skills} diagnostics={info.diagnostics} cwd={cwd} agentDir={agentDir} />;
    case 'mcp':
      return info.mcp && <McpSection mcp={info.mcp} tabKey={tabKey} cwd={cwd} />;
    default:
      return <PluginsSection packages={info.packages} />;
  }
}

/** @brief 右边：读取中、读取失败（原文和"Retry"）、这一节的内容。 */
function ToolsContent({ section, tabKey }: { section: Section; tabKey: string | null }) {
  const { info, error, sessionId } = useTools();
  const agentDir = useApp((state) => state.config?.agentDir ?? '');
  // 换分节时从头显示（滚动位置、展开的行和表单都不带到别的分节）。
  return (
    <div className="tools-content" key={section}>
      <div className="tools-inner">
        {error && (
          <p className="form-message error" role="alert" data-testid="tools-error">{error}
            <button type="button" className="text-link" onClick={() => void loadTools(sessionId)}>Retry</button></p>
        )}
        {!info && !error && <p className="tools-empty" role="status">Loading…</p>}
        {info && <SectionContent section={section} info={info} tabKey={tabKey} agentDir={agentDir} />}
      </div>
    </div>
  );
}

/** @brief 工具页。 */
export function ToolsPage() {
  const followed = useApp(useShallow((state) => followedOf(state, state.activeKey)));
  const exited = useApp((state) => state.kernel === 'exited');
  const trust = useTools((state) => state.info?.projectTrust ?? null);
  const sections: Section[] = followed ? ['builtin', 'skills', 'mcp', 'plugins'] : ['skills', 'plugins'];
  const [chosen, setChosen] = useState<Section>(sections[0]);
  const section = sections.includes(chosen) ? chosen : sections[0];
  useToolsLoad(followed);
  return (
    <section className="tools-page" data-testid="tools-page">
      <header className="topbar">
        <button type="button" className="button" onClick={() => showChat()}><Icon name="back" />Back to app</button>
        <span className="chat-title">Customize</span>
        <span className="tools-follow" title={followed?.title ?? NO_SESSION} data-testid="tools-follow">
          {followed?.title ?? NO_SESSION}</span>
      </header>
      <div className="tools-notice">
        <span>Changes apply to new sessions. Sessions already open aren’t affected.</span>
        <button type="button" className="button" disabled={exited || followed?.opening}
          onClick={() => void newSession()}>
          <Icon name="plus" />New session</button>
      </div>
      {(trust === 'untrusted' || trust === 'unasked') && (
        <div className="tools-notice warn" data-testid="tools-trust">
          This workspace isn’t trusted, so its skills and settings aren’t listed</div>
      )}
      <div className="tools-layout">
        <SectionNav sections={sections} current={section} onSelect={setChosen} />
        <ToolsContent section={section} tabKey={followed?.key ?? null} />
      </div>
    </section>
  );
}
