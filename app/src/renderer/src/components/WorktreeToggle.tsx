// 输入框下一行权限按钮后面的 Worktree 开关与 Initialize git…（docs/specs/file-system.md §11.4，状态表
// docs/v1/screens/fs-worktree.md "输入框下一行"）：新会话还没有你的消息、空闲、不在建 worktree 中、git 状态到了时才出现
// （state/worktrees.ts worktreeChoice）。有提交的 git 仓库是 Worktree 开关（aria-pressed，只改这个标签在界面里的状态、
// 不发命令，点或 Space / Enter 开关），不是 git 仓库是 Initialize git…（打开 InitGitDialog）。和权限按钮一起靠左，把右边
// 一组推开的 margin-left: auto 在它后面那一项上（chat.css）。这一栏 ≤ 460px 时只剩图标 branch（chat.css），名字在读屏名
// 和悬停第一行里、说明在第二行；宽时悬停只有说明（文字已经写在按钮上）。这一项从不截短（flex-shrink: 0）。

import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Tab } from '../state/store';
import { openInitGit, toggleWorktree, worktreeChoice } from '../state/worktrees';
import { Icon } from '../icons';
import { Description, tipLines } from './ModelMenu';
import { useFocusFallback } from './rowMenu';

/** Worktree 开关的说明（悬停、读屏的描述；fs-worktree.md） */
const WORKTREE_HINT = 'Work in a separate worktree on a new branch. It starts with only the committed files.';
/** Initialize git… 的说明（悬停、读屏的描述；fs-worktree.md） */
const INIT_GIT_HINT = 'Make this folder a git repository so sessions can use worktrees';
/** 会话面板不宽于它（px）时只显示图标：与 chat.css 的 @container (max-width: 460px) 是同一档 */
const NARROW_PANE = 460;

/**
 * @brief 这一项所在的会话面板（.chat-pane，尺寸容器）是否不宽于 NARROW_PANE：按它的内容宽度算，同容器查询。
 *        随面板变宽变窄更新（ResizeObserver，只在宽度变了时回调，不轮询）。
 */
function useNarrowPane(element: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const pane = element.current?.closest<HTMLElement>('.chat-pane');
    if (!pane) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width <= NARROW_PANE));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [element]);
  return narrow;
}

/** @brief 这一行里的一项（开关或 Initialize git…）。 */
interface ItemProps {
  /** 这一栏会话（界面里的标识） */
  tabKey: string;
  /** 名字：按钮上的字、读屏名、窄栏时悬停的第一行 */
  name: string;
  /** 说明：悬停（窄栏时的第二行）与读屏的描述 */
  hint: string;
  /** 界面测试用的标识（data-testid） */
  testId: string;
  /** 开关的开、关（aria-pressed）；不是开关时省略 */
  pressed?: boolean;
  /** 点了它（含 Space / Enter） */
  onClick: () => void;
}

/**
 * @brief 一项：图标 branch 加名字（窄栏只留图标）；外层 .worktree-item 是这一行的直接子项，读屏的描述藏在里面。
 *        这一项随状态消失（发送、git 状态变了）而焦点在它上面时，焦点回到文字框。
 */
function RowItem({ tabKey, name, hint, testId, pressed, onClick }: ItemProps) {
  const button = useRef<HTMLButtonElement>(null);
  const tipId = useId();
  const narrow = useNarrowPane(button);
  useFocusFallback(button, tabKey);
  return (
    <div className="worktree-item">
      <button ref={button} className="worktree-button" data-testid={testId} aria-pressed={pressed}
        aria-label={name} aria-describedby={tipId} title={narrow ? tipLines(name, hint) : hint} onClick={onClick}>
        <Icon name="branch" /><span className="worktree-text">{name}</span>
      </button>
      <Description id={tipId} text={hint} />
    </div>
  );
}

/** @brief 权限按钮后面的 Worktree 开关或 Initialize git…；都不该出现时什么都不画。 */
export function WorktreeToggle({ tab }: { tab: Tab }) {
  const choice = worktreeChoice(tab);
  if (choice === 'toggle') {
    return <RowItem key="toggle" tabKey={tab.key} name="Worktree" hint={WORKTREE_HINT} testId="worktree-toggle"
      pressed={tab.worktreeOn} onClick={() => toggleWorktree(tab.key)} />;
  }
  if (choice === 'init-git') {
    return <RowItem key="init-git" tabKey={tab.key} name="Initialize git…" hint={INIT_GIT_HINT} testId="init-git"
      onClick={() => openInitGit(tab.key)} />;
  }
  return null;
}
