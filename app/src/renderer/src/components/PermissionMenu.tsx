// 顶栏的权限菜单：每次询问 / 全部允许，"本会话已允许"的列表可以逐项清除（docs/v0/screens/approval.md）。
// 只作用于这个会话；切到"全部允许"前确认一次，切回"每次询问"不需要确认。

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalMode } from '../../../shared/protocol';
import { forgetApproval, setApprovalMode } from '../state/actions';
import { useOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { approvalLabel } from './approvalLabel';

const modeText: Record<ApprovalMode, string> = { ask: '每次询问', all: '全部允许' };

/** @brief 确认切到"全部允许"的对话框：焦点先在"取消"，Tab 只在两个按钮之间切换，Esc 等于取消。 */
function ConfirmAllDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  useOverlay(true, onCancel);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    (document.activeElement === cancel.current ? confirm : cancel).current?.focus();
  }
  // 会话面板是尺寸容器（container-type），fixed 定位会相对它，所以挂到 body 上。
  return createPortal(
    <div className="dialog-backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId}
        data-testid="confirm-dialog" onKeyDown={onKeyDown}>
        <h2 id={titleId}>切换到全部允许？</h2>
        <p id={textId}>编辑、写入和命令都不再询问。</p>
        <div className="dialog-actions">
          <button ref={confirm} className="button warn" onClick={onConfirm}>全部允许</button>
          <button ref={cancel} className="button" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** @brief 菜单里用 ↑ ↓ 在按钮之间移动焦点。 */
function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  items[(index + step + items.length) % items.length]?.focus();
}

/** @brief 菜单内容：两个权限（当前项打勾）、"本会话已允许"列表、底部说明。打开时焦点在当前项上。 */
function PermissionPanel({ tab, onChoose }: { tab: Tab; onChoose: (mode: ApprovalMode) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const { mode, allowed } = tab.approval;
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);
  return (
    <div ref={menu} className="menu permission-menu" role="menu" aria-label="权限" data-testid="permission-menu"
      onKeyDown={moveFocus}>
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

/** @brief 在 root 之外按下鼠标时关闭菜单。 */
function useOutsideClose(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) latest.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, root]);
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
      {confirming && <ConfirmAllDialog onConfirm={() => confirmed(true)} onCancel={() => confirmed(false)} />}
    </div>
  );
}
