// 顶栏换模型、换思考强度（docs/v0/screens/models.md）：只作用于这个会话，pi 不写进默认设置。
// 请求期间按钮显示你选的值、不可用；返回后以后台进程给出的模型状态为准；失败时对话流里一张错误卡，按钮回到原来的值。

import { create } from 'zustand';
import type { Command, ModelState, ThinkingLevel } from '../../../shared/protocol';
import { describe, request } from './bridge';
import { pushItem } from './model';
import { updateTab, useApp } from './store';

/** @brief 一个会话正在切换的值（请求还没返回）。 */
export interface PendingSwitch {
  /** 你选的模型（provider/id）；没在换模型时为 undefined */
  model?: string;
  /** 你选的思考强度；没在换强度时为 undefined */
  level?: ThinkingLevel;
}

/** @brief 正在切换的会话（界面里的标识）和你选的值，只在这次运行的内存里。 */
export const usePendingSwitch = create<Record<string, PendingSwitch>>(() => ({}));

/** @brief 记下或清掉一个会话正在切换的值。 */
function setPending(key: string, pending: PendingSwitch | null): void {
  usePendingSwitch.setState((state) => {
    const { [key]: _old, ...rest } = state;
    return pending ? { ...rest, [key]: pending } : rest;
  }, true);
}

/**
 * @brief 发一条切换命令，把返回的模型状态记到会话上；失败时在这个会话的对话流里显示原文，会话保持原样。
 *        换模型成功后，打开时 pi 选不到默认模型的说明不再适用，一并清掉。
 * @param pending 请求期间按钮上显示的值
 */
async function switchState(key: string, pending: PendingSwitch, command: Command): Promise<void> {
  setPending(key, pending);
  try {
    const state = await request<ModelState>(command);
    updateTab(key, (tab) => ({ ...tab, model: state.model, thinkingLevel: state.thinkingLevel,
      thinkingLevels: state.thinkingLevels, reasoning: state.reasoning,
      modelNotice: pending.model && state.model ? null : tab.modelNotice }));
  } catch (error) {
    const message = describe(command.type, error);
    updateTab(key, (tab) => ({ ...tab,
      transcript: pushItem(tab.transcript, { kind: 'error', text: message, restore: null, live: true }) }));
  } finally {
    setPending(key, null);
  }
}

/** @brief 会话的 pi 会话 id；还没打开时为 null。 */
function sessionIdOf(key: string): string | null {
  return useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId ?? null;
}

/**
 * @brief 这个会话换模型（pi setModel，不改默认模型）。
 * @param ref 模型（provider/id）
 */
export async function setModel(key: string, ref: string): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await switchState(key, { model: ref }, { type: 'session.setModel', sessionId, model: ref });
}

/** @brief 这个会话换思考强度（pi setThinkingLevel，不改设置里的默认）。 */
export async function setThinking(key: string, level: ThinkingLevel): Promise<void> {
  const sessionId = sessionIdOf(key);
  if (sessionId) await switchState(key, { level }, { type: 'session.setThinking', sessionId, level });
}
