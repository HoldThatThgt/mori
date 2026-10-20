// 设置页（docs/v0/screens/settings.md），照 Claude 桌面版：左边分节列表，右边这一节的内容，顶部"返回会话"。
// 打开时落在"连接与模型"；"去设置"落在出错会话所用模型的连接的"编辑连接"（state/settings.ts）。

import { useRef } from 'react';
import { Icon } from '../icons';
import { showChat } from '../state/projects';
import { selectSection, useSettings, type SettingsSection } from '../state/settings';
import { AgentsSection } from './AgentsSection';
import { ConnectionsSection } from './ConnectionsSection';

/** 分节，按列表顺序 */
const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'connections', label: '连接与模型' },
  { id: 'agents', label: 'AGENTS.md' },
];

/**
 * @brief 分节列表：Tab 在按钮之间移动，↑ ↓ 从焦点所在的按钮换到上一节、下一节（焦点不在按钮上时从当前分节算）；
 *        当前分节带 aria-current。
 */
function SettingsNav() {
  const section = useSettings((state) => state.section);
  const nav = useRef<HTMLElement>(null);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-section]')?.dataset.section;
    const at = SECTIONS.findIndex((item) => item.id === from);
    const index = at >= 0 ? at : SECTIONS.findIndex((item) => item.id === section);
    const next = SECTIONS[(index + (event.key === 'ArrowDown' ? 1 : -1) + SECTIONS.length) % SECTIONS.length];
    nav.current?.querySelector<HTMLButtonElement>(`[data-section="${next.id}"]`)?.focus();
    selectSection(next.id);
  }
  return (
    <nav ref={nav} className="settings-nav" data-testid="settings-nav" aria-label="设置分节" onKeyDown={onKeyDown}>
      {SECTIONS.map((item) => (
        <button key={item.id} className={`nav-item${item.id === section ? ' active' : ''}`} data-section={item.id}
          aria-current={item.id === section ? 'page' : undefined} onClick={() => selectSection(item.id)}>
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/** @brief 设置页。 */
export function SettingsPage() {
  const section = useSettings((state) => state.section);
  return (
    <section className="settings-page" data-testid="settings-page">
      <header className="topbar">
        <button className="button" onClick={() => showChat()}><Icon name="back" />返回会话</button>
        <span className="chat-title">设置</span>
      </header>
      <div className="settings-layout">
        <SettingsNav />
        <div className="settings-body">
          {section === 'connections' ? <ConnectionsSection /> : <AgentsSection />}
        </div>
      </div>
    </section>
  );
}
