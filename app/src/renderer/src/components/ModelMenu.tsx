// 顶栏的选择范围按钮和菜单（docs/v1/screens/model-menu.md）：Groups、Providers、Models 三节，每项标区域，
// 本会话静态校验排除的项变淡但仍可以选，当前范围打勾；只作用于这个会话，新会话用设置里的默认范围。
// 菜单的各项取自 session.pickOptions。思考强度按钮（ThinkingMenu.tsx）与它共用菜单的开关行为。

import { useEffect, useRef, useState } from 'react';
import type { PickOption, Zone } from '../../../shared/models';
import {
  clearPickError, loadPickOptions, setPick, usePendingSwitch, usePickError, usePickOptions, useRangeMenuRequest,
} from '../state/modelActions';
import { useOverlay } from '../state/overlays';
import { openModelsSettings } from '../state/settings';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { moveMenuFocus, useOutsideClose } from './menu';

/** 没读到菜单各项时用的空列表（固定一个引用，免得每次渲染都换新数组） */
const NO_OPTIONS: PickOption[] = [];

/** 生成中、准备中按钮的悬停说明（§9.2） */
const BUSY_TITLE = 'Can’t switch models until the response finishes';

/** 区域在标签里的写法 */
const ZONE_LABELS: Readonly<Record<Zone, string>> = { local: 'Local', intranet: 'Intranet', public: 'Public' };

/** @brief 顶栏切换菜单的开关。 */
export interface SwitchMenu {
  /** 菜单是否打开 */
  open: boolean;
  /** 打开或关闭菜单 */
  setOpen: (open: boolean) => void;
  /** 按钮和菜单外面的容器：在它之外按下鼠标时关闭 */
  root: React.RefObject<HTMLDivElement | null>;
  /** 按钮 */
  button: React.RefObject<HTMLButtonElement | null>;
  /** 选了一项之后：关闭菜单，焦点回到按钮 */
  close: () => void;
}

/**
 * @brief 顶栏切换菜单（选择范围、思考强度）的开关：Esc 关闭并把焦点还给按钮，点外面关闭；
 *        按钮变得不可用（开始生成、后台进程不可用）时关闭。
 */
export function useSwitchMenu(disabled: boolean): SwitchMenu {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useOverlay(open, close);
  useOutsideClose(open, root, () => setOpen(false));
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return { open, setOpen, root, button, close };
}

/** @brief 菜单打开时焦点放在当前项上；没有可用的当前项时放在第一个可用的项上。 */
export function useFocusCurrent(menu: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const current = menu.current?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)');
    (current ?? menu.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
  }, [menu]);
}

/** @brief <provider>/<model> 的提供商 id。 */
function providerOf(ref: string): string {
  return ref.slice(0, ref.indexOf('/'));
}

/** @brief <provider>/<model> 的模型 id。 */
function modelIdOf(ref: string): string {
  return ref.slice(ref.indexOf('/') + 1);
}

/** @brief 一项的区域标记：按 Local、Intranet、Public 的顺序 " · " 分隔；没有已确认的区域时"Zone not confirmed"。 */
function zoneLabel(zones: Zone[]): string {
  return zones.length > 0 ? zones.map((zone) => ZONE_LABELS[zone]).join(' · ') : 'Zone not confirmed';
}

/** @brief 选择范围按钮上显示的内容。 */
interface RangeLabel {
  /** 范围名（分组写 id，提供商写名称）；范围是模型或没有范围时为空串 */
  scope: string;
  /** 模型 id（范围是模型时是它，否则是当前模型）；没有时为空串 */
  model: string;
  /** 悬停说明 */
  title: string;
}

/**
 * @brief 按钮上的文字（model-menu.md "选择范围按钮"）：分组或提供商 "<范围名> · <当前模型 id>"，没有当前模型时只写范围名；
 *        模型写模型 id；没有范围时 "No model range"。悬停写当前模型的 "<提供商名> · <区域>"。
 *        还没读到菜单各项时，提供商名退回 id。
 */
function rangeLabel(pick: string | null, current: string | null, options: PickOption[]): RangeLabel {
  const find = (value: string) => options.find((option) => option.pick === value);
  const title = current
    ? `${find(providerOf(current))?.label ?? providerOf(current)} · ${zoneLabel(find(current)?.zones ?? [])}`
    : 'No model can run in this session';
  if (pick === null) return { scope: 'No model range', model: '', title };
  if (pick.includes('/')) return { scope: '', model: modelIdOf(pick), title };
  return { scope: find(pick)?.label ?? pick, model: current ? modelIdOf(current) : '', title };
}

/** @brief 菜单里的一项。 */
function OptionItem({ option, current, onChoose }: { option: PickOption; current: string | null;
  onChoose: (pick: string) => void }) {
  return (
    <button role="menuitemradio" aria-checked={option.pick === current} data-pick={option.pick}
      data-zone={option.zones.join(' ')} data-excluded={option.excluded ? 'true' : undefined}
      className={option.excluded ? 'pick-excluded' : undefined} title={option.reason ?? option.label}
      onClick={() => onChoose(option.pick)}>
      <span className="switch-text">{option.label}</span>
      <span className="pick-zone">{zoneLabel(option.zones)}</span>
      {option.pick === current && <Icon name="check" />}
    </button>
  );
}

/** @brief Models 一节：按提供商分小节（小节名是提供商名称），各按 session.pickOptions 给出的顺序。 */
function ModelSection({ options, current, onChoose }: { options: PickOption[]; current: string | null;
  onChoose: (pick: string) => void }) {
  const byProvider = new Map<string, PickOption[]>();
  for (const option of options.filter((item) => item.kind === 'model')) {
    const provider = providerOf(option.pick);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), option]);
  }
  if (byProvider.size === 0) return null;
  const nameOf = (id: string) => options.find((item) => item.kind === 'provider' && item.pick === id)?.label ?? id;
  return (
    <div className="pick-section" role="group" aria-label="Models" data-section="models">
      <div className="pick-section-name" aria-hidden="true">Models</div>
      {[...byProvider.entries()].map(([provider, models]) => (
        <div key={provider} className="model-group" role="group" aria-label={nameOf(provider)}>
          <div className="model-group-name" aria-hidden="true">{nameOf(provider)}</div>
          {models.map((option) => <OptionItem key={option.pick} option={option} current={current}
            onChoose={onChoose} />)}
        </div>
      ))}
    </div>
  );
}

/** @brief Groups 或 Providers 一节；没有项时不显示。 */
function KindSection({ kind, title, options, current, onChoose }: { kind: 'group' | 'provider'; title: string;
  options: PickOption[]; current: string | null; onChoose: (pick: string) => void }) {
  const items = options.filter((option) => option.kind === kind);
  if (items.length === 0) return null;
  return (
    <div className="pick-section" role="group" aria-label={title} data-section={`${kind}s`}>
      <div className="pick-section-name" aria-hidden="true">{title}</div>
      {items.map((option) => <OptionItem key={option.pick} option={option} current={current} onChoose={onChoose} />)}
    </div>
  );
}

/** @brief 菜单：三节、底部说明与"Manage models"。打开时焦点在当前范围上。 */
function PickPanel({ options, current, onChoose, onManage }: { options: PickOption[]; current: string | null;
  onChoose: (pick: string) => void; onManage: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useFocusCurrent(menu);
  const props = { options, current, onChoose };
  return (
    <div ref={menu} className="menu switch-menu model-menu" role="menu" aria-label="Model range"
      data-testid="model-menu" onKeyDown={moveMenuFocus}>
      <KindSection kind="group" title="Groups" {...props} />
      <KindSection kind="provider" title="Providers" {...props} />
      <ModelSection {...props} />
      <p className="menu-note" data-testid="model-menu-note">
        Applies to this session only. New sessions use the default range from Settings.</p>
      <button role="menuitem" data-action="manage-models" onClick={onManage}>Manage models</button>
    </div>
  );
}

/**
 * @brief 菜单的开关与数据：会话的模型状态变了（换了范围、配置或档案变化）时重新读取菜单各项；打开菜单时也读一次、
 *        清掉换范围失败的一行；拒绝启动卡的"Change model…"打开这一栏的菜单。
 */
function useRangeMenu(tab: Tab, disabled: boolean) {
  const menu = useSwitchMenu(disabled);
  const request = useRangeMenuRequest();
  const handled = useRef(request.nonce);
  const ready = tab.sessionId !== null;
  useEffect(() => {
    if (ready) void loadPickOptions(tab.key);
  }, [ready, tab.key, tab.pick, tab.current, tab.blocked]);
  useEffect(() => {
    if (request.nonce === handled.current) return;
    handled.current = request.nonce;
    if (request.key === tab.key && !disabled) menu.setOpen(true);
  }, [request, tab.key, disabled, menu]);
  useEffect(() => {
    if (!menu.open) return;
    clearPickError(tab.key);
    void loadPickOptions(tab.key);
  }, [menu.open, tab.key]);
  return menu;
}

/**
 * @brief 顶栏的选择范围按钮和菜单。disabled 为真时（会话没打开、后台进程不可用）不能切换；准备中与生成中也不能切换。
 *        换范围的请求还没返回时按钮显示你选的范围、不可用（仍可聚焦，焦点留在按钮上）。
 *        面板窄时按钮收短：先截当前模型 id，再截范围名，完整的文字在悬停说明和读屏名称里（model-menu.md "窄栏"）。
 *        协作模式下（pickLocked）范围由角色的候选决定，按钮只显示正在用的模型、不能打开菜单。
 */
export function ModelMenu({ tab, disabled }: { tab: Tab; disabled: boolean }) {
  if (tab.pickLocked) return <LockedModelButton tab={tab} />;
  return <RangeMenu tab={tab} disabled={disabled} />;
}

/** 协作模式下模型按钮的悬停说明（平行 Agent 规格 §12.11） */
const LOCKED_TITLE = 'Team mode picks the model for each agent';

/**
 * @brief 协作模式下的模型按钮（平行 Agent 规格 §12.11，docs/v1/screens/team-blocked.md）：只显示正在用的模型 id，
 *        没有 ▾，点击、Enter 都不打开菜单；没有当前模型时 No model。生成中悬停说明也不变。
 */
function LockedModelButton({ tab }: { tab: Tab }) {
  const text = tab.current ? modelIdOf(tab.current) : 'No model';
  return (
    <div className="model-switch">
      <button className="model-button" data-testid="model-button" data-locked="true" aria-disabled="true"
        data-pick={tab.pick ?? undefined} data-current={tab.current ?? undefined} aria-label={`Model: ${text}`}
        title={LOCKED_TITLE}>
        <span className="switch-text range-scope">{text}</span>
      </button>
    </div>
  );
}

/** @brief 顶栏的选择范围按钮和菜单（关闭模式；见 ModelMenu）。 */
function RangeMenu({ tab, disabled }: { tab: Tab; disabled: boolean }) {
  const options = usePickOptions((state) => state[tab.key]) ?? NO_OPTIONS;
  const pickError = usePickError((state) => state[tab.key]);
  const pending = usePendingSwitch((state) => state[tab.key]);
  const busy = tab.transcript.running || tab.transcript.sending;
  const menu = useRangeMenu(tab, disabled || busy);
  const shown = pending?.pick ? rangeLabel(pending.pick, null, options) : rangeLabel(tab.pick, tab.current, options);
  const text = [shown.scope, shown.model].filter(Boolean).join(' · ');

  function choose(pick: string) {
    menu.close();
    if (pick !== tab.pick) void setPick(tab.key, pick);
  }

  function manage() {
    menu.setOpen(false);
    openModelsSettings();
  }

  return (
    <div className="model-switch" ref={menu.root}>
      <button ref={menu.button} className="model-button" data-testid="model-button" aria-haspopup="menu"
        data-pick={tab.pick ?? undefined} data-current={tab.current ?? undefined} aria-expanded={menu.open}
        aria-label={`Model range: ${text}`} disabled={disabled || busy} aria-disabled={pending ? true : undefined}
        title={busy ? BUSY_TITLE : shown.title} onClick={() => { if (!pending) menu.setOpen(!menu.open); }}>
        {shown.scope && <span className="switch-text range-scope">{shown.scope}</span>}
        {shown.model && (
          <span className="switch-text range-model">{shown.scope ? ` · ${shown.model}` : shown.model}</span>
        )}
        <Icon name="down" />
      </button>
      {pickError && <div className="pick-error" role="alert" data-testid="pick-error">
        Couldn’t change the model range: {pickError}</div>}
      {menu.open && <PickPanel options={options} current={tab.pick} onChoose={choose} onManage={manage} />}
    </div>
  );
}
