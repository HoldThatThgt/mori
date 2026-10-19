// 首次启动、设置页、还没有打开会话时的中栏。

import { useState } from 'react';
import { openFolder } from '../state/actions';
import { useApp } from '../state/store';
import { BrandMark, Icon } from '../icons';
import { ConnectionForm } from './ConnectionForm';
import { folderName, KernelExitBanner } from './ChatPane';

/** @brief "打开文件夹…"：正在打开时显示文件夹名，失败时显示原文。 */
export function OpenFolderPrompt({ heading, detail }: { heading: string; detail?: string }) {
  const tabs = useApp((state) => state.tabs);
  const last = tabs[tabs.length - 1];
  const opening = last?.phase === 'opening';
  return (
    <div className="open-folder" data-testid="open-folder">
      <h2>{heading}</h2>
      {detail && <p className="form-message ok" data-testid="test-result">{detail}</p>}
      <p className="muted">选择一个项目文件夹开始对话。</p>
      <button className="button primary" disabled={opening} onClick={() => void openFolder()}>
        <Icon name="folder" />打开文件夹…
      </button>
      {opening && <p className="muted">正在打开 {folderName(last.cwd)}…</p>}
      {last?.phase === 'failed' && <p className="form-message error">打开失败：{last.error}</p>}
    </div>
  );
}

/** @brief 首次启动：只有连接表单；测试成功后进入"打开文件夹…"。exited 为真时提示后台进程退出。 */
export function FirstRun({ exited }: { exited: boolean }) {
  const [tested, setTested] = useState<string | null>(null);
  return (
    <main className="first-run">
      <div className="first-run-card">
        <div className="first-run-brand"><BrandMark /><span className="brand">mori</span></div>
        {exited && <KernelExitBanner />}
        {tested ? <OpenFolderPrompt heading="连接成功" detail={tested} /> : (
          <>
            <h2>连接模型</h2>
            <p className="muted">填好服务地址、API key 和模型 ID，先测试连接。</p>
            <ConnectionForm onTested={(ok, text) => ok && setTested(text)} />
          </>
        )}
      </div>
    </main>
  );
}

/** @brief 设置页：M1 只有"连接"。顶部"返回会话"。 */
export function SettingsPage() {
  const focus = useApp((state) => state.settingsFocus);
  return (
    <section className="settings-page" data-testid="settings-page">
      <header className="topbar">
        <button className="button" onClick={() => useApp.setState({ view: 'chat' })}><Icon name="back" />返回会话</button>
        <span className="chat-title">设置</span>
      </header>
      <div className="settings-body">
        <h2>连接</h2>
        <p className="muted">保存后，已经打开的会话也用新的连接。</p>
        <ConnectionForm focusKey={focus} />
      </div>
    </section>
  );
}
