// 输入框下面一行的选择范围按钮和菜单（docs/v1/screens/model-menu.md；这一行里的位置、悬停、不可用和窄栏见
// docs/v0/screens/models.md）：Groups、Providers、Models 三节，本会话静态校验排除的项变淡但仍可以选，
// 当前范围打勾；只作用于这个会话，新会话用设置里的默认范围。菜单的各项取自 session.pickOptions。
// 开关、位置和焦点的行为在 rowMenu.ts；思考强度按钮（ThinkingMenu.tsx）、权限按钮（PermissionMenu.tsx）相同。

import { useEffect, useId, useRef } from 'react';
import type { PickOption } from '../../../shared/models';
import {
  clearPickError, loadPickOptions, setPick, usePendingSwitch, usePickError, usePickOptions, useRangeMenuRequest,
} from '../state/modelActions';
import { openModelsSettings } from '../state/settings';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { firstMenuItem, moveMenuFocus } from './menu';
import { useRowMenu, useRowPlacement, type RowMenu } from './rowMenu';

/** 没读到菜单各项时用的空列表（固定一个引用，免得每次渲染都换新数组） */
const NO_OPTIONS: PickOption[] = [];

/** 准备中、生成中不能换范围的原因（§9.2；悬停的第三行） */
const BUSY_TITLE = 'Can’t switch models until the response finishes';

/** 没有当前模型时悬停的第二行 */
const NO_CURRENT = 'No model can run in this session';

/** @brief 悬停说明的写法：每项一行，空的项不写。 */
export function tipLines(...lines: (string | null)[]): string {
  return lines.filter(Boolean).join('\n');
}

/**
 * @brief 读屏的描述：藏起来的元素，里面只有悬停说明第一行以外的部分（不让 Chromium 把整个 title 当成描述，
 *        第一行和读屏名重复）。text 为空时不显示。
 */
export function Description({ id, text, testId }: { id: string; text: string | null; testId?: string }) {
  return text ? <span id={id} hidden data-testid={testId}>{text}</span> : null;
}

/** @brief 菜单打开时焦点放在当前项上；没有可用的当前项时放在第一个可用的项上（例如"Open settings"）。 */
export function useFocusCurrent(menu: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const current = menu.current?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)');
    (current ?? firstMenuItem(menu.current))?.focus();
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

/** @brief 选择范围按钮上显示的内容。 */
interface RangeLabel {
  /** 范围名（分组写 id，提供商写名称）；范围是模型或没有范围时为空串 */
  scope: string;
  /** 模型 id（范围是模型时是它，否则是当前模型）；没有时为空串 */
  model: string;
  /** 悬停说明的第二行：当前模型的提供商名（2026-10-26 起不带区域），没有当前模型时 NO_CURRENT */
  where: string;
}

/**
 * @brief 按钮上的文字（model-menu.md "选择范围按钮"）：分组或提供商 "<范围名> · <当前模型 id>"，没有当前模型时只写范围名；
 *        模型写模型 id；没有范围时 "No model range"。悬停的第二行写当前模型的提供商名。
 *        还没读到菜单各项时，提供商名退回 id。
 */
function rangeLabel(pick: string | null, current: string | null, options: PickOption[]): RangeLabel {
  const find = (value: string) => options.find((option) => option.pick === value);
  const where = current ? find(providerOf(current))?.label ?? providerOf(current) : NO_CURRENT;
  if (pick === null) return { scope: 'No model range', model: '', where };
  if (pick.includes('/')) return { scope: '', model: modelIdOf(pick), where };
  return { scope: find(pick)?.label ?? pick, model: current ? modelIdOf(current) : '', where };
}

/** @brief 选择范围按钮的悬停说明和读屏的描述。 */
interface RangeTip {
  /** 悬停说明：按钮文字 / 提供商名 / 不可用的原因，每项一行 */
  title: string;
  /** 读屏的描述：第二行，不可用时加". <原因>"；切换中没有 */
  description: string | null;
}

/**
 * @brief 悬停说明分三行（docs/v0/composer-pickers.md"v1 之后的调整"）：按钮文字、"<提供商名>"、不可用的原因。
 *        切换中只有第一行（你选的范围），不写"No model can run in this session"。
 * @param reason 不可用的原因；能用时为 null
 */
function rangeTip(text: string, where: string, switching: boolean, reason: string | null): RangeTip {
  if (switching) return { title: text, description: null };
  const description = where + (reason ? `. ${reason}` : '');
  return { title: tipLines(text, where, reason), description };
}

/**
 * @brief 菜单里的一项：只写名字（2026-10-26 起不标区域）；被排除时原因写进读屏的描述（描述来自 aria-describedby，
 *        title 不再变成描述）。
 */
function OptionItem({ option, current, onChoose }: { option: PickOption; current: string | null;
  onChoose: (pick: string) => void }) {
  const describe = useId();
  return (
    <button role="menuitemradio" aria-checked={option.pick === current} data-pick={option.pick}
      data-excluded={option.excluded ? 'true' : undefined}
      className={option.excluded ? 'pick-excluded' : undefined} title={option.reason ?? option.label}
      aria-describedby={option.reason ? describe : undefined} onClick={() => onChoose(option.pick)}>
      <span className="switch-text">{option.label}</span>
      <Description id={describe} text={option.reason} />
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

/** @brief 菜单的内容。 */
interface PickPanelProps {
  /** 菜单元素（以这一行定位时要量它） */
  menu: React.RefObject<HTMLDivElement | null>;
  /** 菜单各项 */
  options: PickOption[];
  /** 会话现在的选择范围 */
  current: string | null;
  /** 选了一项 */
  onChoose: (pick: string) => void;
  /** 点了"Manage models" */
  onManage: () => void;
}

/** @brief 菜单：三节、底部说明与"Manage models"。打开时焦点在当前范围上。 */
function PickPanel({ menu, options, current, onChoose, onManage }: PickPanelProps) {
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
 *        清掉换范围失败的一行；拒绝启动卡的"Change model…"打开这一栏这一行的菜单。
 * @param disabled 按钮不可用（准备中、生成中、不能发送）：不打开，开着的关闭
 */
function useRangeMenu(tab: Tab, disabled: boolean): RowMenu {
  const menu = useRowMenu(tab, disabled);
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
 * @brief 换范围失败的一行（role="alert"）：从这一行往上弹出、右边对齐范围按钮，放不下时挪进这一行；不算浮层。
 *        下次打开菜单或 10 秒后消失（modelActions.ts）。
 */
function PickError({ tab, button }: { tab: Tab; button: React.RefObject<HTMLButtonElement | null> }) {
  const message = usePickError((state) => state[tab.key]);
  const line = useRef<HTMLDivElement>(null);
  useRowPlacement(Boolean(message), button, line, 'anchor', message);
  if (!message) return null;
  return <div ref={line} className="pick-error" role="alert" data-testid="pick-error">
    Couldn’t change the model range: {message}</div>;
}

/**
 * @brief 输入框下面一行的模型按钮。协作模式下（pickLocked）范围由角色的候选决定，按钮只显示正在用的模型、
 *        不能打开菜单；其他时候是选择范围按钮和菜单（RangeMenu）。
 * @param unavailable 不能发送时的说明（"Starting…"等），这时不能切换
 */
export function ModelMenu({ tab, unavailable }: { tab: Tab; unavailable: string | null }) {
  if (tab.pickLocked) return <LockedModelButton tab={tab} />;
  return <RangeMenu tab={tab} unavailable={unavailable} />;
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

/**
 * @brief 选择范围按钮和菜单（关闭协作模式时；见 ModelMenu）。unavailable 时和准备中、生成中一样
 *        不能切换：按钮 aria-disabled（仍能 Tab 到，点了不开菜单），原因在悬停的第三行和读屏的描述里。
 *        换范围或换强度的请求还没返回时按钮显示你选的范围、aria-disabled 并带 data-pending（焦点留在按钮上），
 *        没有读屏的描述：空的 aria-description 不让 Chromium 把 title（带" · "）当成描述。
 *        这一行放不下时按钮收短：先截当前模型 id，再截范围名，全文在悬停的第一行和读屏名里（models.md"窄栏"）。
 */
function RangeMenu({ tab, unavailable }: { tab: Tab; unavailable: string | null }) {
  const options = usePickOptions((state) => state[tab.key]) ?? NO_OPTIONS;
  const pending = usePendingSwitch((state) => state[tab.key]);
  const busy = tab.transcript.running || tab.transcript.sending;
  const reason = unavailable ?? (busy ? BUSY_TITLE : null);
  const menu = useRangeMenu(tab, reason !== null);
  const panel = useRef<HTMLDivElement>(null);
  const tipId = useId();
  useRowPlacement(menu.open, menu.button, panel, 'anchor');
  const shown = pending?.pick ? rangeLabel(pending.pick, null, options) : rangeLabel(tab.pick, tab.current, options);
  const parts = [shown.scope, shown.model].filter(Boolean);
  const text = parts.join(' · ');
  // 读屏名里不用" · "（ui-strings.md：读屏会念出来），范围名和模型 id 之间用逗号；模型 id 里的"/"是数据，照原样
  const name = `Model range: ${parts.join(', ')}`;
  const tip = rangeTip(text, shown.where, pending !== undefined, reason);

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
        aria-label={name} aria-disabled={reason !== null || pending ? true : undefined}
        data-pending={pending ? 'true' : undefined} aria-describedby={tip.description ? tipId : undefined}
        aria-description={tip.description ? undefined : ''}
        title={tip.title} onClick={() => { if (!pending && reason === null) menu.setOpen(!menu.open); }}>
        {shown.scope && <span className="switch-text range-scope">{shown.scope}</span>}
        {shown.model && (
          <span className="switch-text range-model">{shown.scope ? ` · ${shown.model}` : shown.model}</span>
        )}
        <Icon name="down" />
      </button>
      <Description id={tipId} text={tip.description} testId="model-tip" />
      <PickError tab={tab} button={menu.button} />
      {menu.open && <PickPanel menu={panel} options={options} current={tab.pick} onChoose={choose}
        onManage={manage} />}
    </div>
  );
}
