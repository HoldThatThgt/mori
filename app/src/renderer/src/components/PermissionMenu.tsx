// 顶栏的权限菜单：每次询问 / 全部允许，"本会话已允许"的列表可以逐项清除（docs/v0/screens/approval.md）。
// 只作用于这个会话；切到"全部允许"前确认一次，切回"每次询问"不需要确认。

import { useEffect, useRef, useState } from 'react';
import type { ApprovalMode } from '../../../shared/protocol';
import { forgetApproval, setApprovalMode } from '../state/actions';
import { useOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { approvalLabel } from './approvalLabel';
import { ConfirmDialog } from './ConfirmDialog';
import { moveMenuFocus, useOutsideClose } from './menu';

const modeText: Record<ApprovalMode, string> = { ask: '每次询问', all: '全部允许' };

/** @brief 菜单内容：两个权限（当前项打勾）、"本会话已允许"列表、底部说明。打开时焦点在当前项上。 */
function PermissionPanel({ tab, onChoose }: { tab: Tab; onChoose: (mode: ApprovalMode) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const { mode, allowed } = tab.approval;
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);
  return (
    <div ref={menu} className="menu permission-menu" role="menu" aria-label="权限" data-testid="permission-menu"
      onKeyDown={moveMenuFocus}>
      {(['ask', 'all'] as const).map((item) => (
        <button key={item} role="menuitemradio" aria-checked={mode === item} onClick={() => onChoose(item)}>
          {modeText[item]}{mode === item && <Icon name="check" />}
        </button>
      ))}
      <div className="menu-caption">本会话已允许：</div>
      <ul className="permission-allowed" data-testid="permission-allowed">
        {allowed.map((name) => (
          <li key={name}>
            <span>{approvalLabel(name)}</span>
            <button className="text-link" title={`清除"${approvalLabel(name)}"`}
              onClick={() => void forgetApproval(tab.key, name)}>清除</button>
          </li>
        ))}
      </ul>
      {allowed.length === 0 && <div className="menu-empty">还没有</div>}
      <p className="menu-note">只作用于这个会话，新会话从'每次询问'开始</p>
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
        title="权限：只作用于这个会话" onClick={() => setOpen(!open)}>
        <Icon name="shield" />{modeText[mode]}<Icon name="down" />
      </button>
      {open && <PermissionPanel tab={tab} onChoose={choose} />}
      {confirming && <ConfirmDialog title="切换到全部允许？" text="编辑、写入和命令都不再询问。" confirmLabel="全部允许"
        tone="warn" testId="confirm-dialog" onConfirm={() => confirmed(true)} onCancel={() => confirmed(false)} />}
    </div>
  );
}
