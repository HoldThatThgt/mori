// 顶栏的权限菜单：Ask each time / Allow all，"Allowed for this session:"的列表可以逐项清除（Forget）
// （docs/v0/screens/approval.md）。只作用于这个会话；切到"Allow all"前确认一次，切回"Ask each time"不需要确认。
// 面板 400px 以下按钮只显示盾牌图标（chat.css 的 @container 藏起 .permission-text），模式名靠读屏名
// "Permission mode: <模式>"。

import { useEffect, useRef, useState } from 'react';
import type { ApprovalMode } from '../../../shared/protocol';
import { forgetApproval, setApprovalMode } from '../state/actions';
import { useOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { approvalLabel } from './approvalLabel';
import { ConfirmDialog } from './ConfirmDialog';
import { moveMenuFocus, useOutsideClose } from './menu';

const modeText: Record<ApprovalMode, string> = { ask: 'Ask each time', all: 'Allow all' };

/** @brief 菜单内容：两个权限（当前项打勾）、"Allowed for this session:"列表、底部说明。打开时焦点在当前项上。 */
function PermissionPanel({ tab, onChoose }: { tab: Tab; onChoose: (mode: ApprovalMode) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const { mode, allowed } = tab.approval;
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);
  return (
    <div ref={menu} className="menu permission-menu" role="menu" aria-label="Permissions" data-testid="permission-menu"
      onKeyDown={moveMenuFocus}>
      {(['ask', 'all'] as const).map((item) => (
        <button key={item} role="menuitemradio" aria-checked={mode === item} onClick={() => onChoose(item)}>
          {modeText[item]}{mode === item && <Icon name="check" />}
        </button>
      ))}
      <div className="menu-caption">Allowed for this session:</div>
      <ul className="permission-allowed" data-testid="permission-allowed">
        {allowed.map((name) => (
          <li key={name}>
            <span>{approvalLabel(name)}</span>
            <button className="text-link" title={`Forget “${approvalLabel(name)}”`}
              onClick={() => void forgetApproval(tab.key, name)}>Forget</button>
          </li>
        ))}
      </ul>
      {allowed.length === 0 && <div className="menu-empty">None</div>}
      <p className="menu-note">Applies to this session only. New sessions start with “Ask each time”.</p>
    </div>
  );
}

/** @brief 顶栏的权限按钮和菜单；disabled 为真时（会话没打开、后台进程不可用）不能切换。 */
export function PermissionMenu({ tab, disabled }: { tab: Tab; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { mode } = tab.approval;
  useOverlay(open, () => {
    setOpen(false);
    button.current?.focus();
  });
  useOutsideClose(open, root, () => setOpen(false));

  function choose(next: ApprovalMode) {
    setOpen(false);
    if (next === 'all' && mode !== 'all') {
      setConfirming(true);
      return;
    }
    button.current?.focus();
    if (next !== mode) void setApprovalMode(tab.key, next);
  }

  function confirmed(ok: boolean) {
    setConfirming(false);
    button.current?.focus();
    if (ok) void setApprovalMode(tab.key, 'all');
  }

  return (
    <div className="permission" ref={root}>
      <button ref={button} className={`permission-button${mode === 'all' ? ' all' : ''}`}
        data-testid="permission-button" aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        title="Set the permission mode for this session" aria-label={`Permission mode: ${modeText[mode]}`}
        onClick={() => setOpen(!open)}>
        <Icon name="shield" /><span className="permission-text">{modeText[mode]}</span><Icon name="down" />
      </button>
      {open && <PermissionPanel tab={tab} onChoose={choose} />}
      {confirming && <ConfirmDialog title="Switch to “Allow all”?"
        text="Edits, writes, and commands will run without asking." confirmLabel="Allow all" tone="warn"
        testId="confirm-dialog" onConfirm={() => confirmed(true)} onCancel={() => confirmed(false)} />}
    </div>
  );
}
