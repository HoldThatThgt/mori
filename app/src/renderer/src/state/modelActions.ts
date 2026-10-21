// 顶栏换选择范围、换思考强度（docs/v1/screens/model-menu.md）：只作用于这个会话，不改设置里的默认范围。
// 请求期间按钮显示你选的值、不可用；返回后以后台进程给出的模型状态为准。换范围失败时按钮下方一行原文，
// 换思考强度失败时对话流里一张错误卡（同 v0）；按钮都回到原来的值。拒绝启动卡上的 Verify now 也在这里。

import { create, type StoreApi } from 'zustand';
import type { Command, ModelState, ThinkingLevel } from '../../../shared/protocol';
import type { ModelsResult, PickOption, PickOptions } from '../../../shared/models';
import { describe, request } from './bridge';
import { pushItem } from './model';
import { modelStateOf, updateTab, useApp } from './store';

/** 换范围失败的一行显示多久（ms），临时默认值（model-menu.md "切换失败"） */
const PICK_ERROR_MS = 10_000;

/** @brief 一个会话正在切换的值（请求还没返回）。 */
export interface PendingSwitch {
  /** 你选的选择范围；没在换范围时为 undefined */
  pick?: string;
  /** 你选的思考强度；没在换强度时为 undefined */
  level?: ThinkingLevel;
}

/** @brief 正在切换的会话（界面里的标识）和你选的值，只在这次运行的内存里。 */
export const usePendingSwitch = create<Record<string, PendingSwitch>>(() => ({}));

/** @brief 每个会话顶栏菜单的各项（session.pickOptions 的结果，按界面里的标识）。 */
export const usePickOptions = create<Record<string, PickOption[]>>(() => ({}));

/** @brief 每个会话换范围失败的原文（按界面里的标识）；下次打开菜单或 10 秒后清掉。 */
export const usePickError = create<Record<string, string>>(() => ({}));

/** @brief "Change model…"打开范围菜单的请求：会话（界面里的标识）与序号（同一个会话再点一次也要再打开）。 */
export const useRangeMenuRequest = create<{ key: string | null; nonce: number }>(() => ({ key: null, nonce: 0 }));

/** @brief 改写按会话索引的一张表：value 为 null 时删掉这一项。 */
function setEntry<T>(store: StoreApi<Record<string, T>>, key: string, value: T | null): void {
  store.setState((state) => {
    const { [key]: _old, ...rest } = state;
    return value === null ? rest : { ...rest, [key]: value };
  }, true);
}

/** @brief 会话的 pi 会话 id；还没打开时为 null。 */
function sessionIdOf(key: string): string | null {
  return useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId ?? null;
}

/** @brief 把后台进程返回的模型状态记到会话上。 */
function applyState(key: string, state: Partial<ModelState>): void {
  updateTab(key, (tab) => ({ ...tab, ...modelStateOf(state) }));
}

/** @brief 读取这个会话顶栏菜单的各项（只读）；失败时只记录，按钮与菜单用已有的。 */
export async function loadPickOptions(key: string): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (!sessionId) return;
  try {
    const result = await request<PickOptions>({ type: 'session.pickOptions', sessionId });
    if (result.error) throw new Error(result.error);
    setEntry(usePickOptions, key, result.options);
  } catch (error) {
    describe('session.pickOptions', error);
  }
}

/** @brief 清掉换范围失败的一行（打开菜单时）。 */
export function clearPickError(key: string): void {
  setEntry(usePickError, key, null);
}

/** @brief 换范围失败：按钮下方一行原文，10 秒后自动消失（期间又失败时以最新的为准）。 */
function showPickError(key: string, message: string): void {
  setEntry(usePickError, key, message);
  setTimeout(() => {
    if (usePickError.getState()[key] === message) clearPickError(key);
  }, PICK_ERROR_MS);
}

/**
 * @brief 这个会话换选择范围（session.setPick：写一条 mori.pick，重新做静态校验，下一段起生效；不改默认范围）。
 * @param pick 分组 id、提供商 id 或 <provider>/<model>
 */
export async function setPick(key: string, pick: string): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (!sessionId) return;
  setEntry(usePendingSwitch, key, { pick });
  try {
    const state = await request<ModelState & ModelsResult>({ type: 'session.setPick', sessionId, pick });
    if (state.error) throw new Error(state.error);
    applyState(key, state);
  } catch (error) {
    showPickError(key, describe('session.setPick', error));
  } finally {
    setEntry(usePendingSwitch, key, null);
  }
}

/**
 * @brief 发一条换思考强度的命令，把返回的模型状态记到会话上；失败时在这个会话的对话流里显示原文，会话保持原样。
 * @param pending 请求期间按钮上显示的值
 */
async function switchThinking(key: string, pending: PendingSwitch, command: Command): Promise<void> {
  setEntry(usePendingSwitch, key, pending);
  try {
    applyState(key, await request<ModelState>(command));
  } catch (error) {
    const message = describe(command.type, error);
    updateTab(key, (tab) => ({ ...tab,
      transcript: pushItem(tab.transcript, { kind: 'error', text: message, restore: null, live: true }) }));
  } finally {
    setEntry(usePendingSwitch, key, null);
  }
}

/** @brief 这个会话换思考强度（pi setThinkingLevel，不改设置里的默认）。 */
export async function setThinking(key: string, level: ThinkingLevel): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await switchThinking(key, { level }, { type: 'session.setThinking', sessionId, level });
}

/** @brief 拒绝启动卡的"Change model…"：打开这一栏顶栏的范围菜单。 */
export function openRangeMenu(key: string): void {
  useRangeMenuRequest.setState((state) => ({ key, nonce: state.nonce + 1 }));
}

/**
 * @brief 拒绝启动卡的"Verify now"：探测还没验证的候选（models.verify，tests 为 auto）。之后由 mori.model_state 更新卡片。
 * @return 失败时的原文；成功时为 null
 */
export async function verifyNow(refs: string[]): Promise<string | null> {
  if (refs.length === 0) return null;
  try {
    const result = await request<ModelsResult>({ type: 'models.verify', refs, tests: 'auto' });
    if (result.error) throw new Error(result.error);
    return null;
  } catch (error) {
    return describe('models.verify', error);
  }
}
