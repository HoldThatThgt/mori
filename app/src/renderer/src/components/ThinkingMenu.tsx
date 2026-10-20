// 顶栏的思考强度按钮和菜单（docs/v0/screens/models.md）：只作用于这个会话，新会话的默认在设置里按模型设定。
// 模型没标"支持思考"时按钮变淡但能点开，菜单里的强度都不可用（不是藏起来），并说明原因、可以去设置。

import { useRef } from 'react';
import { THINKING_LABELS, type ThinkingLevel } from '../../../shared/protocol';
import { openSettings } from '../state/actions';
import { setThinking, usePendingSwitch } from '../state/modelActions';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { moveMenuFocus } from './menu';
import { useFocusCurrent, useSwitchMenu } from './ModelMenu';

/** 模型没标支持思考时菜单里列出（都不可用）的强度：标了支持思考、没有强度映射的模型可选的 off–high（pi-ai models.js） */
const PLAIN_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

/** 模型没标支持思考时菜单里的说明 */
const UNSUPPORTED_TEXT = "这个模型没有标'支持思考'：pi 不发送思考参数，由端点自己决定（DeepSeek 默认会思考，但不能控制）。"
  + "在 设置 → 连接与模型 里编辑这个模型、勾选'支持思考'后可以选。";

/** @brief 思考强度菜单的内容。 */
interface ThinkingPanelProps {
  /** 这个模型可选的强度 */
  levels: ThinkingLevel[];
  /** 现在的强度 */
  current: ThinkingLevel;
  /** 模型标了支持思考 */
  reasoning: boolean;
  /** 选了一个强度 */
  onChoose: (level: ThinkingLevel) => void;
  /** 点了"打开设置" */
  onSettings: () => void;
}

/**
 * @brief 菜单：可选的强度（当前的打勾）和底部说明；模型没标支持思考时强度都不可用，换成原因和"打开设置"。
 *        打开时焦点在当前项上。
 */
function ThinkingPanel({ levels, current, reasoning, onChoose, onSettings }: ThinkingPanelProps) {
  const menu = useRef<HTMLDivElement>(null);
  useFocusCurrent(menu);
  return (
    <div ref={menu} className="menu switch-menu thinking-menu" role="menu" aria-label="思考强度"
      data-testid="thinking-menu" onKeyDown={moveMenuFocus}>
      {(reasoning ? levels : PLAIN_LEVELS).map((level) => (
        <button key={level} role="menuitemradio" aria-checked={reasoning && level === current} data-level={level}
          disabled={!reasoning} onClick={() => onChoose(level)}>
          {THINKING_LABELS[level]}{reasoning && level === current && <Icon name="check" />}
        </button>
      ))}
      {reasoning ? <p className="menu-note">只作用于这个会话；新会话的默认在设置里按模型设定</p> : (
        <>
          <p className="menu-note">{UNSUPPORTED_TEXT}</p>
          <button role="menuitem" onClick={onSettings}>打开设置</button>
        </>
      )}
    </div>
  );
}

/**
 * @brief 顶栏的思考强度按钮和菜单。disabled 为真时（会话没打开、后台进程不可用）不能切换；生成中也不能切换。
 *        换强度或换模型的请求还没返回时按钮显示你选的强度、不可用（仍可聚焦）。
 *        旧的会话数据没有思考强度时按"关"、不支持思考处理。面板窄于 600px 时按钮只显示强度（models.md"窄栏"）。
 */
export function ThinkingMenu({ tab, disabled }: { tab: Tab; disabled: boolean }) {
  const pending = usePendingSwitch((state) => state[tab.key]);
  const reasoning = tab.reasoning ?? false;
  const current = tab.thinkingLevel ?? 'off';
  const level = pending?.level ?? current;
  const running = tab.transcript.running || tab.transcript.sending;
  const menu = useSwitchMenu(disabled || running);
  const label = reasoning ? THINKING_LABELS[level] : '不可选';
  const title = running ? '生成中不能切换思考强度'
    : reasoning ? '思考强度：只作用于这个会话' : "这个模型没有标'支持思考'";

  function choose(next: ThinkingLevel) {
    menu.close();
    if (next !== current) void setThinking(tab.key, next);
  }

  function settings() {
    menu.setOpen(false);
    openSettings();
  }

  return (
    <div className="thinking-switch" ref={menu.root}>
      <button ref={menu.button} className={`thinking-button${reasoning ? '' : ' unsupported'}`}
        data-testid="thinking-button" data-level={level} data-reasoning={String(reasoning)} aria-haspopup="menu"
        aria-expanded={menu.open} disabled={disabled || running} aria-disabled={pending ? true : undefined}
        aria-label={`思考：${label}`} title={title} onClick={() => { if (!pending) menu.setOpen(!menu.open); }}>
        {/* 窄栏里不显示"思考："（models.css），读屏名称仍是完整的 */}
        <span className="switch-text"><span className="thinking-prefix">思考：</span>{label}</span><Icon name="down" />
      </button>
      {menu.open && <ThinkingPanel levels={tab.thinkingLevels ?? []} current={current} reasoning={reasoning}
        onChoose={choose} onSettings={settings} />}
    </div>
  );
}
