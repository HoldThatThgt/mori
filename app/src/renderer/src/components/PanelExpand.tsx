// 右栏顶部的"Expand" / "Collapse"（docs/v0/screens/layout.md"右栏展开"，2026-10-26 走查 M23，照 Claude 桌面版 pane 上的
// 图标按钮）：改动列表和文件阅读器的顶部都有，放在"Close panel"前面。右栏浮在上层时由样式藏起（layout.css、split.css）。

import { setRightExpanded } from '../state/quotes';
import type { Tab } from '../state/store';
import { Icon } from '../icons';

/** @brief 展开或收回这个会话的右栏。 */
export function PanelExpand({ tab }: { tab: Tab }) {
  const label = tab.rightExpanded ? 'Collapse' : 'Expand';
  return (
    <button type="button" className="icon-button panel-expand" aria-label={label} title={label}
      onClick={() => setRightExpanded(tab.key, !tab.rightExpanded)}>
      <Icon name={tab.rightExpanded ? 'collapse' : 'expand'} />
    </button>
  );
}
