// 首次启动、还没有打开会话时的中栏。设置页在 SettingsPage.tsx。

import { useState } from 'react';
import { openFolder } from '../state/projects';
import { useApp } from '../state/store';
import { BrandMark, Icon } from '../icons';
import { ConnectionForm } from './ConnectionForm';
import { folderName, KernelExitBanner } from './ChatPane';

/** @brief "打开文件夹…"：正在打开时显示文件夹名，失败时显示原文；hint 替换默认的说明。 */
export function OpenFolderPrompt({ heading, detail, hint }: { heading: string; detail?: string; hint?: string }) {
  const tabs = useApp((state) => state.tabs);
  const last = tabs[tabs.length - 1];
  const opening = last?.phase === 'opening';
  return (
    <div className="open-folder" data-testid="open-folder">
      <h2>{heading}</h2>
      {detail && <p className="form-message ok" data-testid="test-result">{detail}</p>}
      <p className="muted">{hint ?? '选择一个项目文件夹开始对话。'}</p>
      <button className="button primary" disabled={opening} onClick={() => void openFolder()}>
        <Icon name="folder" />打开文件夹…
      </button>
      {opening && <p className="muted">正在打开 {folderName(last.cwd)}…</p>}
      {last?.phase === 'failed' && <p className="form-message error">打开失败：{last.error}</p>}
    </div>
  );
}

/**
 * @brief 首次启动：只有连接表单；测试成功后进入"打开文件夹…"。exited 为真时提示后台进程退出。
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
        {tested ? <OpenFolderPrompt heading="连接成功" detail={tested} /> : (
          <>
            <h2>连接模型</h2>
            <p className="muted">填好服务地址、API key 和模型 ID，先测试连接。</p>
            <ConnectionForm mode="full" providerId={providerId} onTested={(ok, text) => ok && setTested(text)} />
          </>
        )}
      </div>
    </main>
  );
}
