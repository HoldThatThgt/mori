// 会话面板：顶栏（"项目名 › 会话名"、协作开关、右栏开关；分屏时"Close pane"）、对话流、阶段行、后台进程退出提示、批准卡、
// 排队区、拒绝启动卡与输入框（文字框下面一行有权限、选择范围、Effort、上下文用量和发送，Composer.tsx）。分屏时每一栏是
// 一个完整的会话面板；在面板里按下鼠标或焦点进入它，焦点就切到这一栏（split.md）。模型层（docs/v1/screens/model-menu.md、
// model-chat.md）：输入框下面一行的选择范围，输入框上方的拒绝启动卡。平行 Agent（docs/v1/screens/team-switch.md）：
// 协作开关是顶栏右边一组的第一个，在右栏开关之前。
// 记忆（docs/specs/memory.md §10.6）：增强改了东西后这个项目新建的第一个会话，对话流上面有一行提示。
// 文件系统（docs/specs/file-system-permissions.md §10.4）：批准卡（对话的与后台的）在前；扩展询问与提问卡排在一个询问卡队列里，
// 按到达顺序一次一张（QuestionCard.tsx）。

import { useRef } from 'react';
import { reload } from '../state/actions';
import { memoryNoticeText, type MemoryNotice } from '../../../shared/memory';
import { seatRolesOf } from '../../../shared/team';
import { recordAction } from '../state/actionLog';
import { openMemoryAt } from '../state/memory';
import { dismissMemoryNotice } from '../state/projects';
import { skillCommandText } from '../state/skillText';
import { closePane, focusComposer, focusPane } from '../state/split';
import { useApp, type KernelStatus, type Tab } from '../state/store';
import { Icon } from '../icons';
import { ApprovalCard } from './ApprovalCard';
import { BlockedCard } from './BlockedCard';
import { Composer, QueueArea } from './Composer';
import { PaneTitle } from './PaneTitle';
import { QuestionCard } from './QuestionCard';
import { StageLine } from './StageLine';
import { TeamSwitch } from './TeamSwitch';
import { Transcript } from './Transcript';

/** 没有名字时会话名取第一条消息的前几个字（方案 5.3） */
export const TITLE_LENGTH = 20;

/** @brief 显示的会话名：名字；没有时第一条消息的前 TITLE_LENGTH 个字；都没有时"New session"。 */
export function displayTitle(name: string | null, firstMessage: string | null): string {
  if (name?.trim()) return name;
  // 技能调用（pi 展开后的 <skill …> 块）按"/skill:名字 参数"算（docs/v0/screens/slash.md）。
  const first = (firstMessage && skillCommandText(firstMessage))?.replace(/\s+/g, ' ').trim();
  if (!first) return 'New session';
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

/** @brief 输入框不能发送时的说明；能发送时为 null。 */
function notReadyText(kernel: KernelStatus, tab: Tab): string | null {
  if (kernel === 'exited') return 'Mori’s background process crashed';
  if (kernel === 'reloading') return 'Restarting…';
  if (kernel === 'connecting' || tab.phase === 'opening') return 'Starting…';
  if (tab.phase === 'failed') return 'Session didn’t open';
  return null;
}

/** @brief 后台进程意外退出的提示和"Restart"按钮；detail 是重新启动失败时的原文。 */
export function KernelExitBanner({ detail }: { detail?: string | null }) {
  return (
    <div className="banner danger" role="alert" data-testid="kernel-exit">
      <span>Mori’s background process crashed · Unfinished responses were interrupted</span>
      {detail && <span className="banner-detail">{detail}</span>}
      <button className="button" onClick={() => void reload()}><Icon name="refresh" />Restart</button>
    </div>
  );
}

/** @brief 后台进程退出、重新启动中、打开失败的横幅。 */
function KernelBanner({ kernel, tab }: { kernel: KernelStatus; tab: Tab }) {
  if (kernel === 'exited') return <KernelExitBanner detail={tab.error} />;
  if (kernel === 'reloading') return <div className="banner" role="status">Restarting…</div>;
  if (tab.phase === 'failed') {
    return <div className="banner danger" role="alert">Failed to open session: {tab.error}</div>;
  }
  return null;
}

/** @brief 没有加载文件夹自带的扩展和配置时的说明，以及怎样改回；加载了或文件夹没有这些内容时为 null。 */
function trustText(tab: Tab, agentDir: string): string | null {
  if (tab.projectTrust === 'unasked') {
    return 'This workspace now has its own extensions or settings, which weren’t loaded this time · '
      + 'You’ll be asked when you start a new session';
  }
  if (tab.projectTrust !== 'untrusted') return null;
  const how = tab.trustRemembered
    ? `To change your remembered choice, delete this workspace’s entry from ${agentDir}\\trust.json and reopen `
      + 'the session'
    : 'You’ll be asked again after you restart Mori';
  return `This workspace isn’t trusted, so its extensions and settings weren’t loaded · ${how}`;
}

/**
 * @brief 增强的提示（docs/specs/memory.md §10.6）：View 打开记忆页 → Project → Revisions，选中最近的那次修订；
 *        Dismiss 之后这次打开里不再显示。后台进程退出时 View 不可用，悬停说明原因（§10.10）。
 */
function MemoryNoticeBanner({ tab, notice }: { tab: Tab; notice: MemoryNotice }) {
  const exited = useApp((state) => state.kernel === 'exited');
  const view = () => {
    recordAction('View in Memory');
    openMemoryAt({ cwd: tab.cwd, layer: 'project', revision: notice.revisions.at(-1) });
  };
  return (
    <div className="banner" role="status" data-testid="memory-notice">
      <span>{memoryNoticeText(notice)}</span>
      <button className="button" data-testid="memory-notice-view" disabled={exited}
        title={exited ? 'Mori’s background process crashed. Restart it to continue.' : undefined}
        onClick={view}>View</button>
      {/* .banner .button 的 margin-left: auto 让 View 靠右；Dismiss 紧跟在它后面。标识按 docs/v1/screens/memory-chat.md */}
      <button className="button" style={{ marginLeft: 0 }} data-action="dismiss"
        onClick={() => dismissMemoryNotice(tab.key)}>Dismiss</button>
    </div>
  );
}

/** @brief 信任与扩展的横幅（sessions.md "项目信任"），以及增强的提示。 */
function SessionBanners({ tab }: { tab: Tab }) {
  const agentDir = useApp((state) => state.config?.agentDir ?? '');
  const trust = trustText(tab, agentDir);
  return (
    <>
      {trust && <div className="banner" data-testid="trust-banner">{trust}</div>}
      {tab.trustSaveError && (
        <div className="banner danger" role="alert">Couldn’t save trust settings: {tab.trustSaveError}</div>
      )}
      {tab.extensionErrors.length > 0 && (
        <div className="banner danger" role="alert" data-testid="extension-errors">
          <span>Some extensions didn’t load:</span>
          {tab.extensionErrors.map((error) => <span key={error} className="banner-detail">{error}</span>)}
        </div>
      )}
      {tab.memoryNotice && <MemoryNoticeBanner tab={tab} notice={tab.memoryNotice} />}
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

/** @brief 按下的地方是不是顶栏右边一组的按钮（协作开关、右栏开关、"Close pane"）。 */
function isTopBarAction(target: EventTarget): boolean {
  return target instanceof Element && target.closest('.topbar-actions button') !== null;
}

/**
 * @brief 在面板里按下鼠标或焦点进入面板时把焦点切到这一栏（split.md"焦点所在的一栏"）。例外：鼠标主键按在顶栏右边一组的
 *        按钮（协作开关、右栏开关、"Close pane"）上时，到这一下按完才切（split.md"右栏开关"）。分屏时右栏跟随焦点所在的
 *        一栏，按下那一刻就切的话右栏先换成这一栏的开关状态（例如关着）、两栏变宽、按钮被挤到别处，松开时不在按钮上，
 *        这一下就点空了。按完是 click（右栏开关里先切焦点再开关；另两个按钮点完由下面的计时切，关掉的那一栏已不在分屏里时
 *        focusPane 不做事），或在别处松开：click 和 pointerup 在同一个任务里派发，下一个任务时还在按着就说明没点成，
 *        这时再切。焦点照常由按下鼠标放到按钮上（不用脚本 focus，免得鼠标点了也画出键盘焦点框）。右键照常在按下时切。
 * @return 面板的两个事件和包了一层的右栏开关（点了它就不再等）
 */
function usePaneFocus(key: string, onToggleRight: () => void) {
  const pressing = useRef(false);
  const onPointerDownCapture = (event: React.PointerEvent) => {
    if (!(event.button === 0 && isTopBarAction(event.target))) {
      focusPane(key);
      return;
    }
    pressing.current = true;
    const done = new AbortController();
    const end = () => {
      done.abort();
      setTimeout(() => {
        if (!pressing.current) return;
        pressing.current = false;
        focusPane(key);
      });
    };
    window.addEventListener('pointerup', end, { signal: done.signal });
    window.addEventListener('pointercancel', end, { signal: done.signal });
  };
  const onFocusCapture = () => {
    if (!pressing.current) focusPane(key);
  };
  const toggle = () => {
    pressing.current = false;
    onToggleRight();
  };
  return { onPointerDownCapture, onFocusCapture, toggle };
}

/**
 * @brief 顶栏："项目名 › 会话名"和这一栏的按钮：协作开关（界面没准备好时不可用）、右栏开关、分屏时"Close pane"
 *        （docs/v0/screens/chat.md"顶栏"）。会话名放不下时项目名先收短，会话面板 ≤ 320px 时不显示项目名（chat.css）。
 */
function TopBar({ tab, split, rightOpen, onToggleRight }: PaneProps & { tab: Tab }) {
  const kernel = useApp((state) => state.kernel);
  const notReady = notReadyText(kernel, tab) !== null;
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span className="chat-project" title={tab.cwd}>{folderName(tab.cwd)}</span>
        <Icon name="chevron" />
        <PaneTitle tab={tab} />
      </div>
      <div className="topbar-actions">
        <TeamSwitch tab={tab} disabled={notReady} />
        <button className="icon-button right-toggle" onClick={onToggleRight} aria-pressed={rightOpen}
          aria-label="Toggle changes" title="This session’s changes"><Icon name="right" /></button>
        {split && (
          <button className="icon-button close-pane" data-testid="close-pane" aria-label="Close pane"
            title="Close pane (doesn’t stop the response)" onClick={() => { closePane(tab.key); focusComposer(); }}>
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
  const focus = usePaneFocus(tab.key, pane.onToggleRight);
  return (
    <section className="chat-pane" aria-label={sessionTitle(tab)} data-testid="chat-pane" data-tab={tab.key}
      data-running={tab.transcript.running} data-sending={tab.transcript.sending}
      onPointerDownCapture={focus.onPointerDownCapture} onFocusCapture={focus.onFocusCapture}>
      <TopBar tab={tab} {...pane} onToggleRight={focus.toggle} />
      <SessionBanners tab={tab} />
      <Transcript tab={tab} />
      <div className="composer-area">
        <KernelBanner kernel={kernel} tab={tab} />
        <StageLine transcript={tab.transcript} cwd={tab.cwd} seatRoles={seatRolesOf(tab.team)} />
        <ApprovalCard tab={tab} />
        <QuestionCard tab={tab} />
        <QueueArea tab={tab} />
        <BlockedCard tab={tab} />
        <Composer tab={tab} notReady={notReadyText(kernel, tab)} />
      </div>
    </section>
  );
}
