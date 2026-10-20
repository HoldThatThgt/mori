// 会话面板：顶栏（会话名、模型、权限、上下文用量、右栏开关；分屏时"关闭这一栏"）、对话流、阶段行、后台进程退出提示、
// 批准卡、排队区与输入框。分屏时每一栏是一个完整的会话面板；在面板里按下鼠标或焦点进入它，焦点就切到这一栏（split.md）。

import { reload } from '../state/actions';
import type { ContextUsage } from '../../../shared/protocol';
import { closePane, focusComposer, focusPane } from '../state/split';
import { useApp, type KernelStatus, type Tab } from '../state/store';
import { Icon } from '../icons';
import { ApprovalCard } from './ApprovalCard';
import { Composer, QueueArea } from './Composer';
import { PaneTitle } from './PaneTitle';
import { PermissionMenu } from './PermissionMenu';
import { QuestionCard } from './QuestionCard';
import { StageLine } from './StageLine';
import { Transcript } from './Transcript';

/** 没有名字时会话名取第一条消息的前几个字（方案 5.3） */
export const TITLE_LENGTH = 20;

/** @brief 显示的会话名：名字；没有时第一条消息的前 TITLE_LENGTH 个字；都没有时"新会话"。 */
export function displayTitle(name: string | null, firstMessage: string | null): string {
  if (name?.trim()) return name;
  const first = firstMessage?.replace(/\s+/g, ' ').trim();
  if (!first) return '新会话';
  return [...first].length > TITLE_LENGTH ? `${[...first].slice(0, TITLE_LENGTH).join('')}…` : first;
}

/** @brief 会话名（打开前用会话列表里的第一条消息）。 */
export function sessionTitle(tab: Tab): string {
  return displayTitle(tab.name, tab.transcript.firstUserText ?? tab.preview);
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

/** @brief 没有加载文件夹自带的扩展和配置时的说明，以及怎样改回；加载了或文件夹没有这些内容时为 null。 */
function trustText(tab: Tab, agentDir: string): string | null {
  if (tab.projectTrust === 'unasked') return '这个文件夹刚出现了自带的扩展或配置，这次没有加载 · 新建会话时会问你';
  if (tab.projectTrust !== 'untrusted') return null;
  const how = tab.trustRemembered
    ? `你选过记住；要改回，删掉 ${agentDir}\\trust.json 里这个文件夹的记录后重新打开`
    : '重启 Mori 后会再问';
  return `没有信任这个文件夹，它自带的扩展和配置没有加载 · ${how}`;
}

/** @brief 信任与扩展的横幅（sessions.md "项目信任"）。 */
function SessionBanners({ tab }: { tab: Tab }) {
  const agentDir = useApp((state) => state.config?.agentDir ?? '');
  const trust = trustText(tab, agentDir);
  return (
    <>
      {trust && <div className="banner" data-testid="trust-banner">{trust}</div>}
      {tab.trustSaveError && <div className="banner danger" role="alert">没能记住你的选择：{tab.trustSaveError}</div>}
      {tab.extensionErrors.length > 0 && (
        <div className="banner danger" role="alert" data-testid="extension-errors">
          <span>有扩展没有加载：</span>
          {tab.extensionErrors.map((error) => <span key={error} className="banner-detail">{error}</span>)}
        </div>
      )}
    </>
  );
}

/** @brief 面板的显示方式：分屏时在哪一侧，以及这一栏的右栏开关。 */
export interface PaneProps {
  /** 是否在分屏里 */
  split: boolean;
  /** 这一栏有焦点时右栏是否打开（右栏开关的按下状态） */
  rightOpen: boolean;
  /** 点了这一栏的右栏开关 */
  onToggleRight: () => void;
}

/** @brief 顶栏。 */
function TopBar({ tab, split, rightOpen, onToggleRight }: PaneProps & { tab: Tab }) {
  const kernel = useApp((state) => state.kernel);
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span className="chat-project" title={tab.cwd}>{folderName(tab.cwd)}</span>
        <Icon name="chevron" />
        <PaneTitle tab={tab} />
      </div>
      <div className="topbar-actions">
        {tab.phase !== 'opening' && (
          <span className="model-chip" title={tab.model ?? ''}>{tab.model?.split('/').pop() ?? '没有可用模型'}</span>
        )}
        <PermissionMenu tab={tab} disabled={notReadyText(kernel, tab) !== null} />
        <UsageChip usage={tab.contextUsage} />
        <button className="icon-button" onClick={onToggleRight} aria-pressed={rightOpen} aria-label="右栏：本会话的改动"
          title="本会话的改动"><Icon name="right" /></button>
        {split && (
          <button className="icon-button close-pane" data-testid="close-pane" aria-label="关闭这一栏"
            title="关闭这一栏（不会停止生成）" onClick={() => { closePane(tab.key); focusComposer(); }}>
            <Icon name="close" />
          </button>
        )}
      </div>
    </header>
  );
}

/** @brief 一个会话的面板。 */
export function ChatPane({ tab, ...pane }: PaneProps & { tab: Tab }) {
  const kernel = useApp((state) => state.kernel);
  return (
    <section className="chat-pane" aria-label={sessionTitle(tab)} data-testid="chat-pane" data-tab={tab.key}
      data-running={tab.transcript.running} data-sending={tab.transcript.sending}
      onPointerDownCapture={() => focusPane(tab.key)} onFocusCapture={() => focusPane(tab.key)}>
      <TopBar tab={tab} {...pane} />
      {tab.modelNotice && <div className="banner">{tab.modelNotice}</div>}
      <SessionBanners tab={tab} />
      <Transcript tab={tab} />
      <div className="composer-area">
        <KernelBanner kernel={kernel} tab={tab} />
        <StageLine transcript={tab.transcript} cwd={tab.cwd} />
        <ApprovalCard tab={tab} />
        <QuestionCard tab={tab} />
        <QueueArea tab={tab} />
        <Composer tab={tab} notReady={notReadyText(kernel, tab)} />
      </div>
    </section>
  );
}
