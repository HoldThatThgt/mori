// 输入框下面一行的上下文用量圆环（docs/v0/screens/models.md"上下文用量（圆环）"，照 Claude 桌面版的 usage ring）：
// 只有图标的按钮，悬停或键盘焦点时显示自画的提示（不用 title，免得读屏把" / "念成描述），点开往上弹出详情。
// 详情只是看数：不算挡住快捷键的浮层（同选区浮层），不抢焦点，不发命令（只用已经刷新到的 contextUsage）。

import { useEffect, useId, useRef, useState } from 'react';
import type { ContextUsage } from '../../../shared/protocol';
import { useOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { useOutsideClose, useTabOutClose } from './menu';
import { useCardArrival, useFocusFallback, useRowPlacement } from './rowMenu';

/** 环的半径（14px 的环、2px 的线） */
const RADIUS = 6;
/** 环的周长 */
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 还没有消息时详情里的说明（Claude 原句） */
const EMPTY_NOTE = 'Send a message to see context usage.';
/** 刚压缩完时详情里的说明 */
const COMPACTED_NOTE = 'Just compacted. Context usage shows after the next response.';

/** @brief 圆环要显示的内容。 */
interface RingView {
  /** 还没有消息、刚压缩完、有用量 */
  state: 'empty' | 'compacted' | 'used';
  /** 四舍五入的百分比（有用量时） */
  percent: number;
  /** 填充的比例 0–1 */
  fill: number;
  /** 详情右边的数（"≈ 15.4k / 128k (12%)"）；没有数据时为空串 */
  summary: string;
  /** 悬停提示 */
  tip: string;
  /** 读屏名 */
  label: string;
  /** 没有数据时的说明（详情里条的位置、读屏的描述）；有用量时为 null */
  note: string | null;
  /** 填充的颜色分档：< 75% 强调色，75–89% 警示色，≥ 90% 危险色 */
  tone: 'accent' | 'warn' | 'danger';
}

/** @brief 去掉一位小数里的".0"。 */
function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** @brief 照 Claude 的写法缩短一个数：1,000 起写成 k、1,000,000 起写成 M（一位小数，去掉".0"），不到 1,000 照写。 */
function shortCount(count: number): string {
  if (count < 1000) return String(count);
  // 999,950 起按 k 会进成"1000k"，写成"1M"
  if (count < 999_950) return `${trimZero((count / 1000).toFixed(1))}k`;
  return `${trimZero((count / 1_000_000).toFixed(1))}M`;
}

/** @brief 按 pi 给的用量算圆环的样子和文字。 */
function ringView(usage: ContextUsage): RingView {
  const none = {
    percent: 0, fill: 0, summary: '', tip: 'Context window', label: 'Context window', tone: 'accent' as const,
  };
  if (usage.tokens === null || usage.percent === null) return { ...none, state: 'compacted', note: COMPACTED_NOTE };
  if (usage.tokens === 0) return { ...none, state: 'empty', note: EMPTY_NOTE };
  const tokens = Math.round(usage.tokens);
  const percent = Math.round(usage.percent);
  const summary = `≈ ${shortCount(tokens)} / ${shortCount(usage.contextWindow)} (${percent}%)`;
  const full = `${tokens.toLocaleString('en-US')} of ${usage.contextWindow.toLocaleString('en-US')}`;
  return {
    state: 'used', percent, fill: Math.min(1, Math.max(0, usage.percent / 100)), summary,
    tip: `Context ${summary}`, label: `Usage: Context approximately ${full} tokens (${percent}%)`, note: null,
    tone: percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : 'accent',
  };
}

/** @brief 圆环的图形：底圈（刚压缩完时是虚线），有用量时从正上方顺时针按比例填充。 */
function RingIcon({ view }: { view: RingView }) {
  return (
    <svg className="ring" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="ring-base" cx="7" cy="7" r={RADIUS} />
      {view.state === 'used' && (
        <circle className="ring-fill" cx="7" cy="7" r={RADIUS} transform="rotate(-90 7 7)"
          strokeDasharray={`${view.fill * CIRCUMFERENCE} ${CIRCUMFERENCE}`} />
      )}
    </svg>
  );
}

/**
 * @brief 悬停提示的开关：鼠标在圆环上（含提示本身）或键盘焦点在圆环上时显示，详情开着时不显示；
 *        Esc 藏起（WCAG 1.4.13），鼠标移开且焦点离开后再出现时重新显示。焦点在圆环上时这一下 Esc 只藏提示（在浮层栈里，
 *        不停止生成）；只因鼠标停在圆环上显示、焦点在别处（文字框、批准卡、另一栏）时 Esc 也藏起提示，但不占这一下，
 *        照 chat.md 的顺序停止生成、拒绝批准卡（models.md"上下文用量（圆环）"）。
 *        hovered 为假（只因键盘焦点显示）时提示不接鼠标：它盖在文字框上，点文字框时不能点到提示上。
 */
function useRingTip(detailsOpen: boolean) {
  const [hover, setHover] = useState(false);
  // 焦点在不在圆环上：none / 鼠标点的 / 键盘来的（:focus-visible，只有这种时显示提示）
  const [focus, setFocus] = useState<'none' | 'mouse' | 'keyboard'>('none');
  const [dismissed, setDismissed] = useState(false);
  const visible = (hover || focus === 'keyboard') && !dismissed && !detailsOpen;
  useOverlay(visible && focus !== 'none', () => setDismissed(true), false);
  useEffect(() => {
    if (!visible || focus !== 'none') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDismissed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, focus]);
  useEffect(() => {
    if (!hover && focus === 'none') setDismissed(false);
  }, [hover, focus]);
  return {
    visible,
    hovered: hover,
    pointer: { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) },
    focus: {
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        setFocus(event.currentTarget.matches(':focus-visible') ? 'keyboard' : 'mouse');
      },
      onBlur: () => setFocus('none'),
    },
  };
}

/** @brief 详情的内容。 */
interface DetailsProps {
  /** 元素 id（圆环的 aria-controls 指向它） */
  id: string;
  /** 圆环要显示的内容 */
  view: RingView;
  /** 详情元素（以这一行定位时要量它） */
  panel: React.RefObject<HTMLDivElement | null>;
}

/** @brief 点开的详情：左边"Context window"、右边与悬停相同的数，下面 4px 的条；没有数据时条的位置是说明。 */
function UsageDetails({ id, view, panel }: DetailsProps) {
  return (
    <div ref={panel} id={id} className="usage-details" data-testid="usage-details">
      <div className="usage-head"><span>Context window</span><span>{view.summary}</span></div>
      {view.note ? <p className="usage-note">{view.note}</p> : (
        <div className="usage-bar"><span style={{ width: `${view.fill * 100}%` }} /></div>
      )}
    </div>
  );
}

/** @brief 上下文用量的圆环、悬停提示和详情（每栏一个）。 */
export function UsageRing({ tab, usage }: { tab: Tab; usage: ContextUsage }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const tipBox = useRef<HTMLDivElement>(null);
  const ids = useId();
  const view = ringView(usage);
  const tip = useRingTip(open);
  const close = () => setOpen(false);
  useOverlay(open, close, false);
  useOutsideClose(open, root, close);
  useTabOutClose(open, root, close);
  useCardArrival(tab, open, () => {
    setOpen(false);
    if (!root.current?.contains(document.activeElement)) return;
    button.current?.focus();
  });
  useFocusFallback(root, tab.key);
  useRowPlacement(open, button, details, 'end', view.summary + (view.note ?? ''));
  useRowPlacement(tip.visible, button, tipBox, 'anchor', view.tip);
  return (
    <div className={`usage tone-${view.tone}`} ref={root} {...tip.pointer}>
      <button ref={button} className="usage-ring" data-testid="usage" data-state={view.state}
        data-percent={view.state === 'compacted' ? undefined : view.percent}
        data-tokens={view.state === 'compacted' ? undefined : Math.round(usage.tokens ?? 0)}
        aria-label={view.label} aria-describedby={view.note ? `${ids}-note` : undefined} aria-expanded={open}
        aria-controls={open ? `${ids}-details` : undefined} onClick={() => setOpen(!open)} {...tip.focus}>
        <RingIcon view={view} />
      </button>
      {view.note && <span id={`${ids}-note`} hidden>{view.note}</span>}
      {tip.visible && (
        <div ref={tipBox} className={`usage-tip${tip.hovered ? '' : ' passive'}`} data-testid="usage-tip"
          aria-hidden="true">{view.tip}</div>
      )}
      {open && <UsageDetails id={`${ids}-details`} view={view} panel={details} />}
    </div>
  );
}
