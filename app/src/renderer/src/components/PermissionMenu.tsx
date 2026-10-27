// 输入框下面一行左端的权限按钮和菜单（docs/v0/screens/approval.md；文件系统改为 Ask each time / Full access，
// docs/specs/file-system-permissions.md §6.7、§6.9、§6.13，状态表 docs/v1/screens/fs-permissions.md）："Allowed for this
// session:"的列表先列工具名、再列按目录放行的目录（Writes to <目录>），每项可以清除（Forget）。只作用于这个会话（含它的
// 全部后台 Agent，平行 Agent 规格 §11.1）；切到"Full access"前确认一次，切回"Ask each time"不需要确认。按钮照 Claude 的
// 模式选择只有文字（模式名和 ▾），任何宽度都没有图标；这一行放不下时模式名截断加"…"，全名在悬停的第一行和读屏名
// "Permission mode: <模式>"里。开关、位置和焦点的行为在 rowMenu.ts。

import { useEffect, useId, useRef, useState } from 'react';
import { APPROVAL_MODES, type ApprovalMode } from '../../../shared/protocol';
import { forgetApproval, setApprovalMode } from '../state/actions';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { approvalLabel } from './approvalLabel';
import { ConfirmDialog } from './ConfirmDialog';
import { moveMenuFocus } from './menu';
import { Description, tipLines } from './ModelMenu';
import { useRowMenu, useRowPlacement } from './rowMenu';

const modeText: Record<ApprovalMode, string> = { ask: 'Ask each time', full: 'Full access' };

/** 切到"Full access"的确认框正文（proposal §6，§6.13） */
const FULL_ACCESS_CONFIRM = 'Edits, writes, and commands inside the working directory will run without asking. '
  + 'Mori still asks before writes it can detect outside it or to protected files. This isn’t a sandbox: scripts '
  + 'and MCP tools can still write anywhere.';

/**
 * 悬停的第二行：照 Claude 的模式选择用当前模式的说明，"Full access"取确认框第一句的现在时；"Ask each time"没有说明，
 * 借用 /permissions 命令的说明
 */
const modeNote: Record<ApprovalMode, string> = {
  ask: 'Change the permission mode',
  full: 'Edits, writes, and commands inside the working directory run without asking.',
};

/** @brief 菜单的内容。 */
interface PermissionPanelProps {
  /** 菜单元素（以这一行定位时要量它） */
  menu: React.RefObject<HTMLDivElement | null>;
  /** 这个会话 */
  tab: Tab;
  /** 选了一个权限 */
  onChoose: (mode: ApprovalMode) => void;
}

/** @brief "Allowed for this session:"的一项：名字和 Forget（悬停 Forget “<名字>”）。 */
function AllowedItem({ kind, label, onForget }: { kind: 'tool' | 'dir'; label: string; onForget: () => void }) {
  return (
    <li data-kind={kind}>
      <span>{label}</span>
      <button className="text-link" title={`Forget “${label}”`} onClick={onForget}>Forget</button>
    </li>
  );
}

/**
 * @brief 菜单内容：两个权限（当前项打勾）、"Allowed for this session:"列表（工具名，之后按放行的顺序是目录）、底部说明。
 *        打开时焦点在当前项上。
 */
function PermissionPanel({ menu, tab, onChoose }: PermissionPanelProps) {
  const { mode, allowed, allowedDirs } = tab.approval;
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [menu]);
  return (
    <div ref={menu} className="menu permission-menu" role="menu" aria-label="Permissions" data-testid="permission-menu"
      onKeyDown={moveMenuFocus}>
      {APPROVAL_MODES.map((item) => (
        <button key={item} role="menuitemradio" aria-checked={mode === item} onClick={() => onChoose(item)}>
          {modeText[item]}{mode === item && <Icon name="check" />}
        </button>
      ))}
      <div className="menu-caption">Allowed for this session:</div>
      <ul className="permission-allowed" data-testid="permission-allowed">
        {allowed.map((name) => (
          <AllowedItem key={`tool:${name}`} kind="tool" label={approvalLabel(name)}
            onForget={() => void forgetApproval(tab.key, { toolName: name })} />
        ))}
        {allowedDirs.map((dir) => (
          <AllowedItem key={`dir:${dir}`} kind="dir" label={`Writes to ${dir}`}
            onForget={() => void forgetApproval(tab.key, { dir })} />
        ))}
      </ul>
      {allowed.length === 0 && allowedDirs.length === 0 && <div className="menu-empty">None</div>}
      <p className="menu-note">Applies to all agents in this session. New sessions start at Ask each time.</p>
    </div>
  );
}

/**
 * @brief 权限按钮和菜单。unavailable 是不能发送时的说明（"Starting…"等）：这时按钮 aria-disabled（仍能 Tab 到，
 *        点了不开菜单），开着的菜单关闭，原因在悬停的第二行和读屏的描述里。准备中、生成中仍可用，菜单不关。
 *        菜单往上打开、左边对齐这一行的左端。
 */
export function PermissionMenu({ tab, unavailable }: { tab: Tab; unavailable: string | null }) {
  const [confirming, setConfirming] = useState(false);
  const menu = useRowMenu(tab, unavailable !== null);
  const panel = useRef<HTMLDivElement>(null);
  const tipId = useId();
  useRowPlacement(menu.open, menu.button, panel, 'start');
  const { mode } = tab.approval;
  const name = `Permission mode: ${modeText[mode]}`;
  const note = unavailable ?? modeNote[mode];

  function choose(next: ApprovalMode) {
    menu.setOpen(false);
    if (next === 'full' && mode !== 'full') {
      setConfirming(true);
      return;
    }
    menu.button.current?.focus();
    if (next !== mode) void setApprovalMode(tab.key, next);
  }

  function confirmed(ok: boolean) {
    setConfirming(false);
    menu.button.current?.focus();
    if (ok) void setApprovalMode(tab.key, 'full');
  }

  // 按钮变得不可用（后台进程退出、重新载入中、重新打开中）时确认框也关上、按取消算，焦点回到按钮（approval.md）：
  // 不然点"Full access"会把 approval.setMode 发给已经退出或正在重启的后台进程
  useEffect(() => {
    if (unavailable !== null && confirming) confirmed(false);
  }, [unavailable]);

  return (
    <div className="permission" ref={menu.root}>
      <button ref={menu.button} className={`permission-button${mode === 'full' ? ' full' : ''}`}
        data-testid="permission-button" aria-haspopup="menu" aria-expanded={menu.open}
        aria-disabled={unavailable !== null ? true : undefined} aria-label={name} aria-describedby={tipId}
        title={tipLines(name, note)} onClick={() => { if (unavailable === null) menu.setOpen(!menu.open); }}>
        <span className="permission-text">{modeText[mode]}</span><Icon name="down" />
      </button>
      <Description id={tipId} text={note} />
      {menu.open && <PermissionPanel menu={panel} tab={tab} onChoose={choose} />}
      {confirming && <ConfirmDialog title="Switch to “Full access”?" text={FULL_ACCESS_CONFIRM}
        confirmLabel="Full access" tone="warn" testId="confirm-dialog" onConfirm={() => confirmed(true)}
        onCancel={() => confirmed(false)} />}
    </div>
  );
}
