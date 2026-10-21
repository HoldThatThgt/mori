// 顶栏的模型按钮和菜单（docs/v0/screens/models.md）：按连接分组列出 pi 现在能用的模型，当前的打勾，默认模型标"Default"；
// 只作用于这个会话，新会话用设置里的默认模型。思考强度按钮（ThinkingMenu.tsx）与它共用菜单的开关行为。

import { useEffect, useRef, useState } from 'react';
import type { AvailableModel } from '../../../shared/protocol';
import { openSettings } from '../state/actions';
import { setModel, usePendingSwitch } from '../state/modelActions';
import { useOverlay } from '../state/overlays';
import { useApp, type Tab } from '../state/store';
import { Icon } from '../icons';
import { moveMenuFocus, useOutsideClose } from './menu';

/** 没读到模型列表时用的空列表（固定一个引用，免得每次渲染都换新数组） */
const NO_MODELS: AvailableModel[] = [];

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
 * @brief 顶栏切换菜单（模型、思考强度）的开关：Esc 关闭并把焦点还给按钮，点外面关闭；
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

/** @brief 按连接（provider）分组，组和组里的模型都保持 pi 给出的顺序。 */
function groupByConnection(models: AvailableModel[]): AvailableModel[][] {
  const groups = new Map<string, AvailableModel[]>();
  for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups.values()];
}

/** @brief 模型按钮上显示的内容。 */
interface ModelLabel {
  /** 模型 ID；没有模型时"No models available" */
  id: string;
  /** 后面标" (deleted)"时的文字（带开头的空格）；没删时为空串 */
  deleted: string;
  /** 悬停说明 */
  title: string;
}

/**
 * @brief 按钮上的文字和悬停说明。模型不在列表里（在设置里删掉了）时标" (deleted)"，悬停说明里也有；
 *        还没读到列表（models 为 undefined）时不判断。
 */
function modelLabel(ref: string | null, models: AvailableModel[] | undefined): ModelLabel {
  if (!ref) return { id: 'No models available', deleted: '', title: 'Select model' };
  const listed = models?.find((model) => model.ref === ref);
  const provider = listed?.provider ?? ref.slice(0, ref.indexOf('/'));
  const id = listed?.id ?? ref.slice(provider.length + 1);
  const connection = listed?.providerName ?? models?.find((model) => model.provider === provider)?.providerName;
  const deleted = models !== undefined && !listed ? ' (deleted)' : '';
  return { id, deleted, title: `${connection ?? provider} · ${id}${deleted}` };
}

/** @brief 模型菜单的内容。 */
interface ModelPanelProps {
  /** pi 现在能用的模型 */
  models: AvailableModel[];
  /** 会话现在的模型（provider/id） */
  current: string | null;
  /** 默认模型（provider/id） */
  defaultModel: string | null;
  /** 选了一个模型 */
  onChoose: (ref: string) => void;
  /** 点了"Manage models" */
  onManage: () => void;
}

/** @brief 菜单：按连接分组的模型（当前的打勾、默认的标"Default"）、底部说明、"Manage models"。打开时焦点在当前项上。 */
function ModelPanel({ models, current, defaultModel, onChoose, onManage }: ModelPanelProps) {
  const menu = useRef<HTMLDivElement>(null);
  useFocusCurrent(menu);
  return (
    <div ref={menu} className="menu switch-menu model-menu" role="menu" aria-label="Model" data-testid="model-menu"
      onKeyDown={moveMenuFocus}>
      {groupByConnection(models).map((group) => (
        <div key={group[0].provider} className="model-group" role="group" aria-label={group[0].providerName}>
          <div className="model-group-name" aria-hidden="true">{group[0].providerName}</div>
          {group.map((model) => (
            <button key={model.ref} role="menuitemradio" aria-checked={model.ref === current} data-model={model.ref}
              title={model.id} onClick={() => onChoose(model.ref)}>
              <span className="switch-text">{model.id}</span>
              {model.ref === defaultModel && <span className="model-default">Default</span>}
              {model.ref === current && <Icon name="check" />}
            </button>
          ))}
        </div>
      ))}
      {models.length === 0 && <div className="menu-empty">No models available</div>}
      <p className="menu-note">Applies to this session only. New sessions use the default model from Settings.</p>
      <button role="menuitem" onClick={onManage}>Manage models</button>
    </div>
  );
}

/**
 * @brief 顶栏的模型按钮和菜单。disabled 为真时（会话没打开、后台进程不可用）不能切换；生成中也不能切换。
 *        换模型的请求还没返回时按钮显示你选的模型、不可用（仍可聚焦，焦点留在按钮上）。
 *        面板窄时按钮收短（省略号），完整的文字在悬停说明和读屏名称里（models.md"窄栏"）。
 */
export function ModelMenu({ tab, disabled }: { tab: Tab; disabled: boolean }) {
  const models = useApp((state) => state.config?.models);
  // models.json 读不出时 pi 的列表里没有 Mori 的模型：这时不标" (deleted)"（列表上方的设置页会显示原文）。
  const broken = useApp((state) => Boolean(state.config?.modelsError));
  const defaultModel = useApp((state) => state.config?.defaultModel ?? null);
  const pending = usePendingSwitch((state) => state[tab.key]);
  const running = tab.transcript.running || tab.transcript.sending;
  const menu = useSwitchMenu(disabled || running);
  const shown = modelLabel(pending?.model ?? tab.model, broken ? undefined : models);

  function choose(ref: string) {
    menu.close();
    if (ref !== tab.model) void setModel(tab.key, ref);
  }

  function manage() {
    menu.setOpen(false);
    openSettings();
  }

  return (
    <div className="model-switch" ref={menu.root}>
      <button ref={menu.button} className="model-button" data-testid="model-button" aria-haspopup="menu"
        aria-expanded={menu.open} aria-label={`Model: ${shown.id}${shown.deleted}`} disabled={disabled || running}
        aria-disabled={pending ? true : undefined}
        title={running ? 'Can’t switch models until the response finishes' : shown.title}
        onClick={() => { if (!pending) menu.setOpen(!menu.open); }}>
        {/* 窄栏里按钮收短时先截模型 ID，" (deleted)"留到最后（models.css） */}
        <span className="switch-text">{shown.id}</span>
        {shown.deleted && <span className="switch-text model-deleted">{shown.deleted}</span>}
        <Icon name="down" />
      </button>
      {menu.open && <ModelPanel models={models ?? NO_MODELS} current={tab.model} defaultModel={defaultModel}
        onChoose={choose} onManage={manage} />}
    </div>
  );
}
