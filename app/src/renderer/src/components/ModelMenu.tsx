// 输入框下面一行的选择范围按钮和菜单（docs/v1/screens/model-menu.md；这一行里的位置、悬停、不可用和窄栏见
// docs/v0/screens/models.md）：Groups、Providers、Models 三节，每项标区域，本会话静态校验排除的项变淡但仍可以选，
// 当前范围打勾；只作用于这个会话，新会话用设置里的默认范围。菜单的各项取自 session.pickOptions。
// 菜单里还有 Task mode 一行（TeamSwitch.tsx，docs/v1/screens/team-switch.md；2026-10-26 负责人走查 M10、M21 从顶栏移来）：
// 协作模式下按钮显示"Task mode · <模型 id>"，菜单只有说明、这一行和"Manage models"；回复进行中菜单也能打开，三节的项
// 不可用，只能切 Task mode。开关、位置和焦点的行为在 rowMenu.ts；思考强度按钮（ThinkingMenu.tsx）、权限按钮（PermissionMenu.tsx）相同。

import { useEffect, useId, useRef } from 'react';
import type { PickOption, Zone } from '../../../shared/models';
import {
  clearPickError, loadPickOptions, setPick, usePendingSwitch, usePickError, usePickOptions, useRangeMenuRequest,
  type PendingSwitch,
} from '../state/modelActions';
import { openModelsSettings } from '../state/settings';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { firstMenuItem, moveMenuFocus } from './menu';
import { useRowMenu, useRowPlacement, type RowMenu } from './rowMenu';
import { TeamErrorLine, TeamErrorNote, TeamSwitch } from './TeamSwitch';

/** 没读到菜单各项时用的空列表（固定一个引用，免得每次渲染都换新数组） */
const NO_OPTIONS: PickOption[] = [];

/** 准备中、生成中不能换范围的原因（§9.2；悬停的第三行，这时菜单里的说明） */
const BUSY_TITLE = 'Can’t switch models until the response finishes';

/** 菜单里一般的说明 */
const RANGE_NOTE = 'Applies to this session only. New sessions use the default range from Settings.';

/** 协作模式下按钮上模型 id 前面的字 */
const TASK_MODE = 'Task mode';

/** 协作模式下按钮悬停的第二行、菜单里的说明（平行 Agent 规格 §12.11） */
const TASK_PICKS = 'Task mode picks the model for each agent';

/** 没有当前模型时悬停的第二行 */
const NO_CURRENT = 'No model can run in this session';

/** 区域在标签里的写法 */
const ZONE_LABELS: Readonly<Record<Zone, string>> = { local: 'Local', intranet: 'Intranet', public: 'Public' };

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

/**
 * @brief 菜单打开时焦点放在打勾的单选项上；没有可用的打勾项时放在第一个可用的项上（例如"Open settings"、
 *        回复进行中范围菜单里的 Task mode 一行）。Task mode 一行是勾选项，打开着也不算当前项。
 */
export function useFocusCurrent(menu: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const current = menu.current
      ?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)');
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
  /** 悬停说明的第二行：当前模型的"<提供商名> · <区域>"，没有当前模型时 NO_CURRENT */
  where: string;
}

/**
 * @brief 按钮上的文字（model-menu.md "选择范围按钮"）：分组或提供商 "<范围名> · <当前模型 id>"，没有当前模型时只写范围名；
 *        模型写模型 id；没有范围时 "No model range"。悬停的第二行写当前模型的 "<提供商名> · <区域>"。
 *        还没读到菜单各项时，提供商名退回 id。
 */
function rangeLabel(pick: string | null, current: string | null, options: PickOption[]): RangeLabel {
  const find = (value: string) => options.find((option) => option.pick === value);
  const where = current
    ? `${find(providerOf(current))?.label ?? providerOf(current)} · ${zoneLabel(find(current)?.zones ?? [])}`
    : NO_CURRENT;
  if (pick === null) return { scope: 'No model range', model: '', where };
  if (pick.includes('/')) return { scope: '', model: modelIdOf(pick), where };
  return { scope: find(pick)?.label ?? pick, model: current ? modelIdOf(current) : '', where };
}

/** @brief 选择范围按钮的悬停说明和读屏的描述。 */
interface RangeTip {
  /** 悬停说明：按钮文字 / 提供商和区域 / 不可用的原因，每项一行 */
  title: string;
  /** 读屏的描述：第二行（" · "换成", "），不可用时加". <原因>"；切换中没有 */
  description: string | null;
}

/**
 * @brief 悬停说明分三行（docs/v0/composer-pickers.md"v1 之后的调整"）：按钮文字、"<提供商名> · <区域>"（协作模式下是
 *        TASK_PICKS）、原因。切换中只有第一行（你选的范围），不写"No model can run in this session"。
 * @param reason 原因（不能发送；选择范围按钮回复进行中也写）；没有时为 null
 */
function rangeTip(text: string, where: string, switching: boolean, reason: string | null): RangeTip {
  if (switching) return { title: text, description: null };
  const description = where.replaceAll(' · ', ', ') + (reason ? `. ${reason}` : '');
  return { title: tipLines(text, where, reason), description };
}

/** @brief 三节共用的输入：菜单各项、现在的范围、选了一项、回复进行中项不可用。 */
interface SectionProps {
  /** 菜单各项 */
  options: PickOption[];
  /** 会话现在的选择范围 */
  current: string | null;
  /** 选了一项 */
  onChoose: (pick: string) => void;
  /** 回复进行中：项不可用（disabled，↑ ↓ 跳过），打勾照旧 */
  disabled: boolean;
}

/**
 * @brief 菜单里的一项。读屏名只有名字：看得见的区域标记用" · "分隔，读屏会念出来（ui-strings.md），所以它对读屏藏起，
 *        区域改用逗号写进读屏的描述，被排除时描述里再加原因（描述来自 aria-describedby，title 不再变成描述）。
 */
function OptionItem({ option, current, onChoose, disabled }: Omit<SectionProps, 'options'> & { option: PickOption }) {
  const describe = useId();
  const zones = zoneLabel(option.zones);
  const description = zones.replaceAll(' · ', ', ') + (option.reason ? `. ${option.reason}` : '');
  return (
    <button role="menuitemradio" aria-checked={option.pick === current} data-pick={option.pick}
      data-zone={option.zones.join(' ')} data-excluded={option.excluded ? 'true' : undefined}
      className={option.excluded ? 'pick-excluded' : undefined} title={option.reason ?? option.label}
      aria-describedby={describe} disabled={disabled} onClick={() => onChoose(option.pick)}>
      <span className="switch-text">{option.label}</span>
      <span className="pick-zone" aria-hidden="true">{zones}</span>
      <Description id={describe} text={description} />
      {option.pick === current && <Icon name="check" />}
    </button>
  );
}

/** @brief Models 一节：按提供商分小节（小节名是提供商名称），各按 session.pickOptions 给出的顺序。 */
function ModelSection({ options, ...item }: SectionProps) {
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
          {models.map((option) => <OptionItem key={option.pick} option={option} {...item} />)}
        </div>
      ))}
    </div>
  );
}

/** @brief Groups 或 Providers 一节；没有项时不显示。 */
function KindSection({ kind, title, options, ...item }: SectionProps & { kind: 'group' | 'provider'; title: string }) {
  const items = options.filter((option) => option.kind === kind);
  if (items.length === 0) return null;
  return (
    <div className="pick-section" role="group" aria-label={title} data-section={`${kind}s`}>
      <div className="pick-section-name" aria-hidden="true">{title}</div>
      {items.map((option) => <OptionItem key={option.pick} option={option} {...item} />)}
    </div>
  );
}

/** @brief 菜单的内容。 */
interface PickPanelProps {
  /** 菜单元素（以这一行定位时要量它） */
  menu: React.RefObject<HTMLDivElement | null>;
  /** 这一栏的会话（现在的范围、pickLocked、协作状态） */
  tab: Tab;
  /** 菜单各项 */
  options: PickOption[];
  /** 回复进行中（准备中、生成中）：三节的项不可用 */
  busy: boolean;
  /** 选了一项 */
  onChoose: (pick: string) => void;
  /** 点了"Manage models" */
  onManage: () => void;
}

/**
 * @brief 菜单开着时回复开始：焦点所在的项变得不可用（或已经掉到 body 上）时移到第一个可用的项（Task mode 一行），
 *        键盘照样能用（model-menu.md"回复进行中的菜单"）。
 */
function useBusyRefocus(menu: React.RefObject<HTMLElement | null>, busy: boolean): void {
  useEffect(() => {
    const root = menu.current;
    const focused = document.activeElement;
    if (!busy || !root) return;
    const lost = focused instanceof HTMLElement && root.contains(focused) && focused.matches(':disabled');
    if (focused === document.body || lost) {
      firstMenuItem(root)?.focus();
    }
  }, [menu, busy]);
}

/** @brief 说明的文字：协作模式下 TASK_PICKS，回复进行中 BUSY_TITLE，其他时候 RANGE_NOTE。 */
function noteOf(tab: Tab, busy: boolean): string {
  if (tab.pickLocked) return TASK_PICKS;
  return busy ? BUSY_TITLE : RANGE_NOTE;
}

/**
 * @brief 菜单：三节（pickLocked 时没有）、说明、Task mode 一行与切换失败的一行、"Manage models"。打开时焦点在当前范围上，
 *        没有可用的当前范围时在 Task mode 一行上。各部分的位置固定，范围的几节换成说明时 Task mode 一行还是同一个元素，
 *        焦点留在它上面。
 */
function PickPanel({ menu, tab, options, busy, onChoose, onManage }: PickPanelProps) {
  useFocusCurrent(menu);
  useBusyRefocus(menu, busy);
  const locked = tab.pickLocked;
  const props = { options, current: tab.pick, onChoose, disabled: busy };
  return (
    <div ref={menu} className="menu switch-menu model-menu" role="menu" aria-label="Model range"
      data-testid="model-menu" onKeyDown={moveMenuFocus}>
      {!locked && <KindSection kind="group" title="Groups" {...props} />}
      {!locked && <KindSection kind="provider" title="Providers" {...props} />}
      {!locked && <ModelSection {...props} />}
      <p className="menu-note" data-testid="model-menu-note">{noteOf(tab, busy)}</p>
      <div className="task-mode-group">
        <TeamSwitch tab={tab} />
        <TeamErrorNote tab={tab} />
      </div>
      <button role="menuitem" data-action="manage-models" onClick={onManage}>Manage models</button>
    </div>
  );
}

/**
 * @brief 菜单的开关与数据：会话的模型状态变了（换了范围、配置或档案变化、协作模式锁定或解锁）时重新读取菜单各项；
 *        打开菜单时也读一次、清掉换范围失败的一行；拒绝启动卡的"Change model…"打开这一栏这一行的菜单。
 * @param disabled 按钮不可用（不能发送、换范围或强度还没返回）：不打开，开着的关闭
 */
function useRangeMenu(tab: Tab, disabled: boolean): RowMenu {
  const menu = useRowMenu(tab, disabled);
  const request = useRangeMenuRequest();
  const handled = useRef(request.nonce);
  const ready = tab.sessionId !== null;
  useEffect(() => {
    if (ready) void loadPickOptions(tab.key);
  }, [ready, tab.key, tab.pick, tab.current, tab.blocked, tab.pickLocked]);
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

/** @brief 模型按钮上显示的内容、读屏名和悬停。 */
interface ButtonLook {
  /** 范围名或"Task mode"（.range-scope）；没有时为空串 */
  scope: string;
  /** 模型 id（.range-model）；没有时为空串 */
  model: string;
  /** 读屏名：选择范围按钮"Model range: …"，协作模式下"Model: Task mode, <模型 id>"（不用" · "，ui-strings.md） */
  name: string;
  /** 悬停说明与读屏的描述 */
  tip: RangeTip;
}

/**
 * @brief 按钮的样子（model-menu.md"选择范围按钮"、team-switch.md"模型按钮上的模式"）：协作模式下（TeamState.mode
 *        不为 off，不等 pickLocked）"Task mode · <当前模型 id>"，悬停第二行 TASK_PICKS，不能发送时第三行是原因；
 *        其他时候是选择范围按钮，换范围还没返回时显示你选的范围，回复进行中第三行是 BUSY_TITLE。
 * @param pending 换范围或换强度还没返回时你选的值；没有时为 undefined
 * @param unavailable 不能发送时的说明；能发送时为 null
 */
function buttonLook(tab: Tab, options: PickOption[], pending: PendingSwitch | undefined,
  unavailable: string | null): ButtonLook {
  if (tab.team.mode !== 'off') {
    const model = tab.current ? modelIdOf(tab.current) : '';
    const parts = [TASK_MODE, model].filter(Boolean);
    return { scope: TASK_MODE, model, name: `Model: ${parts.join(', ')}`,
      tip: rangeTip(parts.join(' · '), TASK_PICKS, pending !== undefined, unavailable) };
  }
  const busy = tab.transcript.running || tab.transcript.sending;
  const shown = pending?.pick ? rangeLabel(pending.pick, null, options) : rangeLabel(tab.pick, tab.current, options);
  const parts = [shown.scope, shown.model].filter(Boolean);
  // 读屏名里不用" · "（ui-strings.md：读屏会念出来），范围名和模型 id 之间用逗号；模型 id 里的"/"是数据，照原样
  return { scope: shown.scope, model: shown.model, name: `Model range: ${parts.join(', ')}`,
    tip: rangeTip(parts.join(' · '), shown.where, pending !== undefined, unavailable ?? (busy ? BUSY_TITLE : null)) };
}

/**
 * @brief 输入框下面一行的模型按钮和菜单。只在不能发送（unavailable）和换范围、换强度还没返回时不可用：按钮 aria-disabled
 *        （仍能 Tab 到，点了不开菜单），原因在悬停的最后一行和读屏的描述里；切换中带 data-pending（焦点留在按钮上），
 *        没有读屏的描述：空的 aria-description 不让 Chromium 把 title（带" · "）当成描述。回复进行中按钮可用、菜单能打开
 *        （三节的项不可用，只能切 Task mode）。这一行放不下时按钮收短：先截模型 id，再截范围名或"Task mode"，全文在悬停的
 *        第一行和读屏名里（models.md"窄栏"）。按钮带 data-team-mode，pickLocked 时 data-locked（测试读它们）。
 * @param unavailable 不能发送时的说明（"Starting…"等）；能发送时为 null
 */
export function ModelMenu({ tab, unavailable }: { tab: Tab; unavailable: string | null }) {
  const options = usePickOptions((state) => state[tab.key]) ?? NO_OPTIONS;
  const pending = usePendingSwitch((state) => state[tab.key]);
  const disabled = unavailable !== null || pending !== undefined;
  const menu = useRangeMenu(tab, disabled);
  const panel = useRef<HTMLDivElement>(null);
  const tipId = useId();
  useRowPlacement(menu.open, menu.button, panel, 'anchor');
  const look = buttonLook(tab, options, pending, unavailable);
  const busy = tab.transcript.running || tab.transcript.sending;

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
        data-pick={tab.pick ?? undefined} data-current={tab.current ?? undefined} data-team-mode={tab.team.mode}
        data-locked={tab.pickLocked ? 'true' : undefined} aria-expanded={menu.open} aria-label={look.name}
        aria-disabled={disabled ? true : undefined} data-pending={pending ? 'true' : undefined}
        aria-describedby={look.tip.description ? tipId : undefined}
        aria-description={look.tip.description ? undefined : ''}
        title={look.tip.title} onClick={() => { if (!disabled) menu.setOpen(!menu.open); }}>
        {look.scope && <span className="switch-text range-scope">{look.scope}</span>}
        {look.model && <span className="switch-text range-model">{look.scope ? ` · ${look.model}` : look.model}</span>}
        <Icon name="down" />
      </button>
      <Description id={tipId} text={look.tip.description} testId="model-tip" />
      <PickError tab={tab} button={menu.button} />
      {!menu.open && <TeamErrorLine tab={tab} button={menu.button} />}
      {menu.open && <PickPanel menu={panel} tab={tab} options={options} busy={busy} onChoose={choose}
        onManage={manage} />}
    </div>
  );
}
