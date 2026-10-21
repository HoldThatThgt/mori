// 首次启动、还没有打开会话时的中栏。设置页在 SettingsPage.tsx。

import { useState } from 'react';
import { openFolder } from '../state/projects';
import { useApp } from '../state/store';
import { BrandMark, Icon } from '../icons';
import { ConnectionForm } from './ConnectionForm';
import { folderName, KernelExitBanner } from './ChatPane';

/** @brief "Open folder…"：正在打开时显示文件夹名，失败时显示原文；hint 替换默认的说明。 */
export function OpenFolderPrompt({ heading, detail, hint }: { heading: string; detail?: string; hint?: string }) {
  const tabs = useApp((state) => state.tabs);
  const last = tabs[tabs.length - 1];
  const opening = last?.phase === 'opening';
  return (
    <div className="open-folder" data-testid="open-folder">
      <h2>{heading}</h2>
      {detail && <p className="form-message ok" data-testid="test-result">{detail}</p>}
      <p className="muted">{hint ?? 'Choose a project folder to start a session.'}</p>
      <button className="button primary" disabled={opening} onClick={() => void openFolder()}>
        <Icon name="folder" />Open folder…
      </button>
      {opening && <p className="muted">Opening {folderName(last.cwd)}…</p>}
      {last?.phase === 'failed' && <p className="form-message error">Failed to open session: {last.error}</p>}
    </div>
  );
}

/**
 * @brief 首次启动：只有连接表单；测试成功后进入"Open folder…"。exited 为真时提示后台进程退出。
 *        表单保存到第一个连接（还没有时新建），保存两次改的是同一个连接。
 */
export function FirstRun({ exited }: { exited: boolean }) {
  const [tested, setTested] = useState<string | null>(null);
  const providerId = useApp((state) => state.config?.connections?.[0]?.providerId ?? null);
  return (
    <main className="first-run">
      <div className="first-run-card">
        <div className="first-run-brand"><BrandMark /><span className="brand">mori</span></div>
        {exited && <KernelExitBanner />}
        {tested ? <OpenFolderPrompt heading="Connected" detail={tested} /> : (
          <>
            <h2>Connect a model</h2>
            <p className="muted">Enter the base URL, API key, and model ID, then test the connection.</p>
            <ConnectionForm mode="full" providerId={providerId} onTested={(ok, text) => ok && setTested(text)} />
          </>
        )}
      </div>
    </main>
  );
}
