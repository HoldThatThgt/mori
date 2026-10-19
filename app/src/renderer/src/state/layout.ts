// 栏宽与收起状态：存在本机（localStorage），重启后保留。范围与默认值移植自 demo/resize.js。

import { create } from 'zustand';

/** @brief 可以拖动的两条分隔线。 */
export type DividerKind = 'sidebar' | 'workspace';

/** @brief 保存下来的布局。 */
export interface LayoutPrefs {
  /** 左栏宽度（px） */
  sidebar: number;
  /** 右栏宽度（px） */
  workspace: number;
  /** 宽窗口下你是否收起了左栏 */
  sidebarCollapsed: boolean;
}

const STORAGE_KEY = 'mori.layout';
/** 中栏至少留出的宽度 */
export const CENTER_MIN = 300;
/** 窄于此宽度时左栏自动收起（方案 5.1） */
export const NARROW_WIDTH = 1024;
/** 收起后的图标栏宽度 */
export const RAIL_WIDTH = 60;
const LIMITS = { sidebar: { min: 180, max: 360 }, workspace: { min: 260, max: 800 } } as const;

/** @brief 当前窗口宽度下的默认宽度（双击恢复）。 */
export function defaultWidth(kind: DividerKind, windowWidth = window.innerWidth): number {
  const narrow = windowWidth <= 1150;
  if (kind === 'sidebar') return narrow ? 220 : 260;
  return narrow ? 400 : 450;
}

/** @brief 读取保存的布局；没有或读不出时用默认值。 */
function loadPrefs(): LayoutPrefs {
  const fallback = { sidebar: defaultWidth('sidebar'), workspace: defaultWidth('workspace'), sidebarCollapsed: false };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<LayoutPrefs> | null;
    return { ...fallback, ...saved };
  } catch (error) {
    console.error(`[renderer] cannot read saved layout: ${(error as Error).message}`);
    return fallback;
  }
}

export const useLayout = create<LayoutPrefs>(loadPrefs);

/** @brief 改布局并保存。 */
export function setLayout(patch: Partial<LayoutPrefs>): void {
  useLayout.setState(patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useLayout.getState()));
  } catch (error) {
    console.error(`[renderer] cannot save layout: ${(error as Error).message}`);
  }
}

/** @brief 计算分隔线时需要的当前几何信息。 */
export interface Geometry {
  /** 窗口（.app）宽度 */
  width: number;
  /** 左栏实际占用的宽度（浮层不占） */
  sidebar: number;
  /** 右栏实际占用的宽度（浮层或关闭时为 0） */
  workspace: number;
}

/**
 * @brief 当前空间下某条分隔线允许的范围；空间不够时返回 null（分隔线不可用）。
 *        与 demo/resize.js 的 sizeLimits 相同：先给中栏留出 CENTER_MIN。
 */
export function limitsFor(kind: DividerKind, geometry: Geometry): { min: number; max: number } | null {
  const other = kind === 'sidebar' ? geometry.workspace : geometry.sidebar;
  const room = geometry.width - other - CENTER_MIN;
  const max = Math.floor(Math.min(LIMITS[kind].max, room));
  return max >= LIMITS[kind].min ? { min: LIMITS[kind].min, max } : null;
}

/** @brief 把宽度限制在范围内。 */
export function clamp(value: number, limits: { min: number; max: number }): number {
  return Math.max(limits.min, Math.min(Math.round(value), limits.max));
}
