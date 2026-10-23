// 输入框下面一行的思考强度按钮（"Effort"）和菜单（docs/v0/screens/models.md，v1 改动见 docs/v1/screens/model-menu.md
// "思考强度"）：只作用于这个会话，新会话的默认在设置里按模型设定；可选的强度取当前模型（实际模型）的。
// 模型没标"Supports thinking"时按钮写"Unavailable"、能点开，菜单里的强度都不可用（不是藏起来），并说明原因、
// 可以打开 Settings → Models。开关、位置和焦点的行为在 rowMenu.ts。

import { useId, useRef } from 'react';
import { THINKING_LABELS, type ThinkingLevel } from '../../../shared/protocol';
import { setThinking, usePendingSwitch } from '../state/modelActions';
import { openModelsSettings } from '../state/settings';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { moveMenuFocus } from './menu';
import { Description, tipLines, useFocusCurrent } from './ModelMenu';
import { useRowMenu, useRowPlacement } from './rowMenu';

/** 模型没标支持思考时菜单里列出（都不可用）的强度：标了支持思考、没有强度映射的模型可选的 off–high（pi-ai models.js） */
const PLAIN_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

/** 模型没标支持思考时菜单里的说明（§9.2） */
const UNSUPPORTED_TEXT = 'This model isn’t marked “Supports thinking”, so Mori doesn’t send thinking parameters and '
  + 'the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit '
  + 'this model in Settings → Models and check “Supports thinking”.';

/** @brief 思考强度菜单的内容。 */
interface ThinkingPanelProps {
  /** 菜单元素（以这一行定位时要量它） */
  menu: React.RefObject<HTMLDivElement | null>;
  /** 这个模型可选的强度 */
  levels: ThinkingLevel[];
  /** 现在的强度 */
  current: ThinkingLevel;
  /** 模型标了支持思考 */
  reasoning: boolean;
  /** 选了一个强度 */
  onChoose: (level: ThinkingLevel) => void;
  /** 点了"Open settings" */
  onSettings: () => void;
}

/**
 * @brief 菜单：可选的强度（当前的打勾）和底部说明；模型没标支持思考时强度都不可用，换成原因和"Open settings"。
 *        打开时焦点在当前项上（都不可用时在"Open settings"上）。
 */
function ThinkingPanel({ menu, levels, current, reasoning, onChoose, onSettings }: ThinkingPanelProps) {
  useFocusCurrent(menu);
  return (
    <div ref={menu} className="menu switch-menu thinking-menu" role="menu" aria-label="Effort"
      data-testid="thinking-menu" onKeyDown={moveMenuFocus}>
      {(reasoning ? levels : PLAIN_LEVELS).map((level) => (
        <button key={level} role="menuitemradio" aria-checked={reasoning && level === current} data-level={level}
          disabled={!reasoning} onClick={() => onChoose(level)}>
          {THINKING_LABELS[level]}{reasoning && level === current && <Icon name="check" />}
        </button>
      ))}
      {reasoning ? (
        <p className="menu-note">
          Applies to this session only. Set each model’s default for new sessions in Settings.
        </p>
      ) : (
        <>
          <p className="menu-note">{UNSUPPORTED_TEXT}</p>
          <button role="menuitem" data-action="open-settings" onClick={onSettings}>Open settings</button>
        </>
      )}
    </div>
  );
}

/**
 * @brief 悬停说明的第二行（也是读屏的描述）：不可用的原因；能用时是说明。
 * @param unavailable 不能发送时的说明（"Starting…"等）；能发送时为 null
 */
function effortNote(reasoning: boolean, busy: boolean, unavailable: string | null): string {
  if (unavailable) return unavailable;
  if (busy) return 'Can’t change effort until the response finishes';
  return reasoning ? 'Set the effort level for this session' : 'This model isn’t marked “Supports thinking”';
}

/**
 * @brief 输入框下面一行的思考强度按钮和菜单。unavailable 是不能发送时的说明（"Starting…"等），这时和准备中、生成中一样
 *        不能切换：按钮 aria-disabled（仍能 Tab 到，点了不开菜单），原因在悬停的第二行和读屏的描述里。
 *        换强度或换范围的请求还没返回时按钮显示你选的强度、aria-disabled 并带 data-pending（悬停只有第一行，
 *        没有读屏的描述：空的 aria-description 不让 Chromium 把 title 当成描述）。
 *        旧的会话数据没有思考强度时按"Off"、不支持思考处理。会话面板 ≤ 680px 时按钮只显示强度，这一行放不下时强度
 *        截短，悬停的第一行和读屏名总是"Effort: <强度>"（models.md"窄栏"）。
 */
export function ThinkingMenu({ tab, unavailable }: { tab: Tab; unavailable: string | null }) {
  const pending = usePendingSwitch((state) => state[tab.key]);
  const reasoning = tab.reasoning ?? false;
  const current = tab.thinkingLevel ?? 'off';
  const level = pending?.level ?? current;
  const busy = tab.transcript.running || tab.transcript.sending;
  const inert = unavailable !== null || busy;
  const menu = useRowMenu(tab, inert);
  const panel = useRef<HTMLDivElement>(null);
  const tipId = useId();
  useRowPlacement(menu.open, menu.button, panel, 'anchor');
  const label = reasoning ? THINKING_LABELS[level] : 'Unavailable';
  const note = pending ? null : effortNote(reasoning, busy, unavailable);

  function choose(next: ThinkingLevel) {
    menu.close();
    if (next !== current) void setThinking(tab.key, next);
  }

  function settings() {
    menu.setOpen(false);
    openModelsSettings();
  }

  return (
    <div className="thinking-switch" ref={menu.root}>
      <button ref={menu.button} className="thinking-button" data-testid="thinking-button" data-level={level}
        data-reasoning={String(reasoning)} data-pending={pending ? 'true' : undefined} aria-haspopup="menu"
        aria-expanded={menu.open} aria-disabled={inert || pending ? true : undefined} aria-label={`Effort: ${label}`}
        aria-describedby={note ? tipId : undefined} aria-description={note ? undefined : ''}
        title={tipLines(`Effort: ${label}`, note)}
        onClick={() => { if (!pending && !inert) menu.setOpen(!menu.open); }}>
        {/* ≤ 680px 不显示"Effort: "（chat.css），读屏名和 textContent 仍是完整的 */}
        <span className="switch-text"><span className="thinking-prefix">Effort: </span>{label}</span>
        <Icon name="down" />
      </button>
      <Description id={tipId} text={note} />
      {menu.open && <ThinkingPanel menu={panel} levels={tab.thinkingLevels ?? []} current={current}
        reasoning={reasoning} onChoose={choose} onSettings={settings} />}
    </div>
  );
}
