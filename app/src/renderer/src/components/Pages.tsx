// 首次启动页，和还没有打开会话时中栏的 Open a folder 提示（首次启动测试连接成功后也进入这里，
// docs/v1/screens/first-run.md "测试成功之后：主窗口"）。设置页在 SettingsPage.tsx。

import { openFolder } from '../state/projects';
import { useApp } from '../state/store';
import { BrandMark, Icon } from '../icons';
import { folderName, KernelExitBanner } from './ChatPane';
import { FirstRunForm } from './FirstRunForm';
import { NoticeLine } from './settings/common';

/**
 * @brief "Open folder…"：正在打开时显示文件夹名，失败时显示原文；hint 替换默认的说明。首次启动测试成功后，标题下面
 *        一行测试的结果"Connected · …"（界面状态 connected，有会话放进中栏前只显示这一次）。
 */
export function OpenFolderPrompt({ heading, hint }: { heading: string; hint?: string }) {
  const tabs = useApp((state) => state.tabs);
  const connected = useApp((state) => state.connected);
  const last = tabs[tabs.length - 1];
  const opening = last?.phase === 'opening';
  return (
    <div className="open-folder" data-testid="open-folder">
      <h2>{heading}</h2>
      <NoticeLine notice={connected === null ? null : { tone: 'ok', text: connected }} testId="connected" />
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
 * @brief 首次启动：整窗只有首次启动表单（docs/v1/screens/first-run.md），测试连接成功后换成三栏布局。
 *        exited 为真时提示后台进程退出。
 */
export function FirstRun({ exited }: { exited: boolean }) {
  return (
    <main className="first-run">
      <div className="first-run-card">
        <div className="first-run-brand"><BrandMark /><span className="brand">mori</span></div>
        {exited && <KernelExitBanner />}
        <FirstRunForm />
      </div>
    </main>
  );
}
