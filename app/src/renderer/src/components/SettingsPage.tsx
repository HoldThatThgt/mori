// 设置页（docs/v0/screens/settings.md），照 Claude 桌面版：左边分节列表，右边这一节的内容，顶部"Back to app"。
// 打开时落在 Models（docs/v1/screens/models-settings.md）；拒绝启动卡等入口经 openModelsSettings 落到指定位置。
// 第三节 UI issues（docs/specs/memory.md §10.8）：F8 的报告，F8 的"View in Settings"落在这里；详情在右栏（App.tsx）。
// 第四节 General（docs/specs/file-system-permissions.md §9.6）：When you’re away。
// 第五节 Storage（docs/specs/file-system.md §11.10，照 Claude 的 Settings > Storage，排在 General 之后）：Worktrees。

import { useRef } from 'react';
import { Icon } from '../icons';
import { showChat } from '../state/projects';
import { selectSection, useSettings, type SettingsSection } from '../state/settings';
import { AgentsSection } from './AgentsSection';
import { GeneralSection } from './settings/GeneralSection';
import { ModelsSection } from './settings/ModelsSection';
import { StorageSection } from './settings/StorageSection';
import { UiIssuesPage } from './UiIssuesPage';

/** 分节，按列表顺序 */
const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'models', label: 'Models' },
  { id: 'agents', label: 'AGENTS.md' },
  { id: 'issues', label: 'UI issues' },
  { id: 'general', label: 'General' },
  { id: 'storage', label: 'Storage' },
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
    <nav ref={nav} className="settings-nav" data-testid="settings-nav" aria-label="Settings sections"
      onKeyDown={onKeyDown}>
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
        <button className="button" onClick={() => showChat()}><Icon name="back" />Back to app</button>
        <span className="chat-title">Settings</span>
      </header>
      <div className="settings-layout">
        <SettingsNav />
        <div className="settings-body">
          {section === 'models' && <ModelsSection />}
          {section === 'agents' && <AgentsSection />}
          {section === 'issues' && <UiIssuesPage />}
          {section === 'general' && <GeneralSection />}
          {section === 'storage' && <StorageSection />}
        </div>
      </div>
    </section>
  );
}
