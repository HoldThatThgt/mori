// 会话面板：顶栏（会话名、模型、权限、上下文用量、右栏开关）、对话流、阶段行、后台进程退出提示、
// 批准卡、排队区与输入框。

import { reload } from '../state/actions';
import type { ContextUsage } from '../../../shared/protocol';
import { useApp, type KernelStatus, type Tab } from '../state/store';
import { Icon } from '../icons';
import { ApprovalCard } from './ApprovalCard';
import { Composer, QueueArea } from './Composer';
import { PermissionMenu } from './PermissionMenu';
import { StageLine } from './StageLine';
import { Transcript } from './Transcript';

/** 会话名取第一条消息的前几个字（方案 5.3） */
const TITLE_LENGTH = 20;

/** @brief 会话名。 */
export function sessionTitle(tab: Tab): string {
  const first = tab.transcript.firstUserText?.replace(/\s+/g, ' ').trim();
  if (!first) return '新会话';
  return [...first].length > TITLE_LENGTH ? `${[...first].slice(0, TITLE_LENGTH).join('')}…` : first;
}

/** @brief 文件夹名。 */
export function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** @brief 顶栏的上下文用量。 */
function UsageChip({ usage }: { usage: ContextUsage | null }) {
  if (!usage) return null;
  if (usage.tokens === null || usage.percent === null) {
    return <span className="usage-chip" title="刚压缩过，要等下一次回复才知道用量" data-testid="usage">上下文 —</span>;
  }
  const percent = usage.percent < 1 ? '<1%' : `${Math.round(usage.percent)}%`;
  const detail = `约 ${usage.tokens.toLocaleString('en-US')} / ${usage.contextWindow.toLocaleString('en-US')} token`;
  return <span className="usage-chip" title={detail} aria-label={`上下文用量 ${percent}，${detail}`} data-testid="usage">
    上下文 {percent}</span>;
}

/** @brief 输入框不能发送时的说明；能发送时为 null。 */
function notReadyText(kernel: KernelStatus, tab: Tab): string | null {
  if (kernel === 'exited') return '后台进程已退出';
  if (kernel === 'reloading') return '正在重新载入…';
  if (kernel === 'connecting' || tab.phase === 'opening') return '正在启动…';
  if (tab.phase === 'failed') return '会话没有打开';
  return null;
}

/** @brief 后台进程意外退出的提示和"重新载入"；detail 是重新载入失败时的原文。 */
export function KernelExitBanner({ detail }: { detail?: string | null }) {
  return (
    <div className="banner danger" role="alert" data-testid="kernel-exit">
      <span>Mori 的后台进程意外退出 · 刚才没完成的回复已中断</span>
      {detail && <span className="banner-detail">{detail}</span>}
      <button className="button" onClick={() => void reload()}><Icon name="refresh" />重新载入</button>
    </div>
  );
}

/** @brief 后台进程退出、重新载入中、打开失败的横幅。 */
function KernelBanner({ kernel, tab }: { kernel: KernelStatus; tab: Tab }) {
  if (kernel === 'exited') return <KernelExitBanner detail={tab.error} />;
  if (kernel === 'reloading') return <div className="banner" role="status">正在重新载入…</div>;
  if (tab.phase === 'failed') return <div className="banner danger" role="alert">打开失败：{tab.error}</div>;
  return null;
}

/** @brief 顶栏。 */
function TopBar({ tab, rightOpen, onToggleRight }: { tab: Tab; rightOpen: boolean; onToggleRight: () => void }) {
  const kernel = useApp((state) => state.kernel);
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span className="chat-project" title={tab.cwd}>{folderName(tab.cwd)}</span>
        <Icon name="chevron" />
        <span className="chat-title" data-testid="session-title">{sessionTitle(tab)}</span>
      </div>
      <div className="topbar-actions">
        <span className="model-chip" title={tab.model ?? ''}>{tab.model?.split('/').pop() ?? '没有可用模型'}</span>
        <PermissionMenu tab={tab} disabled={notReadyText(kernel, tab) !== null} />
        <UsageChip usage={tab.contextUsage} />
        <button className="icon-button" onClick={onToggleRight} aria-pressed={rightOpen} aria-label="右栏：本会话的改动"
          title="本会话的改动"><Icon name="right" /></button>
      </div>
    </header>
  );
}

/** @brief 一个会话的面板。 */
export function ChatPane({ tab, rightOpen, onToggleRight }: {
  tab: Tab; rightOpen: boolean; onToggleRight: () => void;
}) {
  const kernel = useApp((state) => state.kernel);
  return (
    <section className="chat-pane" aria-label={sessionTitle(tab)} data-testid="chat-pane" data-tab={tab.key}
      data-running={tab.transcript.running} data-sending={tab.transcript.sending}>
      <TopBar tab={tab} rightOpen={rightOpen} onToggleRight={onToggleRight} />
      {tab.modelNotice && <div className="banner">{tab.modelNotice}</div>}
      <Transcript tab={tab} />
      <div className="composer-area">
        <KernelBanner kernel={kernel} tab={tab} />
        <StageLine transcript={tab.transcript} cwd={tab.cwd} />
        <ApprovalCard tab={tab} />
        <QueueArea tab={tab} />
        <Composer tab={tab} notReady={notReadyText(kernel, tab)} />
      </div>
    </section>
  );
}
