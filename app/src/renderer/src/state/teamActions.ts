// Task mode 开关与 /task（docs/specs/parallel-agents-taskboard.md §5.1、§13.1；docs/v1/screens/team-switch.md）：
// 模型菜单里 Task mode 一行的三种点击、输入框里 /task on、/task off、/task <文字> 的识别（2026-10-26 由 /team 改名，
// 没有别名），以及 session.setTeam 的请求与失败的一行。
// 请求期间这一行保持原来的样子、不可用；返回后以后台进程给出的协作状态为准（之后的 mori.team_state 同样）。
// 停止全部 Agent（Stop agents）在 actions.ts，与停止对话的回复放在一起。

import { create, type StoreApi } from 'zustand';
import type { TeamCommandResults } from '../../../shared/protocol';
import type { TeamMode, TeamState, TeamSwitch } from '../../../shared/team';
import { describe, request } from './bridge';
import { updateTab, useApp, type Tab } from './store';

/** 切换失败的一行显示多久（ms），临时默认值（team-switch.md "切换失败"） */
const TEAM_ERROR_MS = 10_000;

/** @brief 正在切换协作模式的会话（界面里的标识）：session.setTeam 还没返回。 */
export const useTeamPending = create<Record<string, true>>(() => ({}));

/** @brief 每个会话切换协作模式失败的原文（按界面里的标识）；下次点开关或 10 秒后清掉。 */
export const useTeamError = create<Record<string, string>>(() => ({}));

/** @brief 改写按会话索引的一张表：value 为 null 时删掉这一项。 */
function setEntry<T>(store: StoreApi<Record<string, T>>, key: string, value: T | null): void {
  store.setState((state) => {
    const { [key]: _old, ...rest } = state;
    return value === null ? rest : { ...rest, [key]: value };
  }, true);
}

/** @brief 输入框里按 Enter 时原文里的 /task（§5.1）。 */
export type TeamCommand =
  /** 不是 /task：照普通消息发送 */
  | { kind: 'none' }
  /** 只有 /task：不发送，输入框不变 */
  | { kind: 'bare' }
  /** /task on、/task off：不发消息，发 session.setTeam */
  | {
    kind: 'switch';
    /** 打开或关掉 */
    mode: TeamSwitch;
  }
  /** /task <文字>：去掉前缀，以 team: 'once' 发出 */
  | {
    kind: 'once';
    /** 去掉 /task 前缀之后的文字 */
    text: string;
  };

/** /task 和它后面的部分；/tasks、/taskboard 不是 /task */
const TEAM_PREFIX = /^\s*\/task(?=\s|$)([\s\S]*)$/i;
/** /task on、/task off：不区分大小写，前后可以有空白 */
const TEAM_SWITCH_WORD = /^(on|off)$/i;

/**
 * @brief 认出输入框原文里的 /task（在引用芯片拼进消息之前，所以带芯片也能用，§5.1）。
 * @param draft 输入框里你写的字
 */
export function parseTeamCommand(draft: string): TeamCommand {
  const match = TEAM_PREFIX.exec(draft);
  if (!match) return { kind: 'none' };
  const rest = match[1] ?? '';
  const word = rest.trim();
  if (!word) return { kind: 'bare' };
  if (TEAM_SWITCH_WORD.test(word)) return { kind: 'switch', mode: word.toLowerCase() as TeamSwitch };
  return { kind: 'once', text: rest.trimStart() };
}

/**
 * @brief 这条消息是不是先由立项判断、而立项不在对话会话里（分开时，§5.3）：协作模式下，或带 team: 'once'；
 *        对话与立项是同一个角色时（合并会话）照普通发送。
 * @param once 以 /task <文字> 发出
 */
export function decidesFirst(tab: Tab, once: boolean): boolean {
  const { mode, holders } = tab.team;
  return (mode !== 'off' || once) && holders.dialog !== holders.create;
}

/** @brief Task mode 一行点击之后要的模式（§13.1）：off → on；always → off（不能回到 off 时后台进程给出 once）；once → on。 */
export function nextSwitch(mode: TeamMode): TeamSwitch {
  return mode === 'always' ? 'off' : 'on';
}

/** @brief 切换失败：一行原文（TeamSwitch.tsx 的 TeamErrorNote、TeamErrorLine），10 秒后自动消失（期间又失败时以最新的为准）。 */
function showTeamError(key: string, message: string): void {
  setEntry(useTeamError, key, message);
  setTimeout(() => {
    if (useTeamError.getState()[key] === message) setEntry(useTeamError, key, null);
  }, TEAM_ERROR_MS);
}

/** @brief 后台进程返回的协作状态（去掉结果里的 error）。 */
function teamOf(result: TeamCommandResults['session.setTeam']): TeamState {
  const { error: _error, ...team } = result;
  return team;
}

/**
 * @brief Task mode 一行或 /task on、/task off（session.setTeam）：返回的协作状态记到会话上；失败时回到原来的模式，
 *        显示一行原文。请求期间这一行不可用。
 */
export async function setTeam(key: string, mode: TeamSwitch): Promise<void> {
  const sessionId = useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId;
  if (!sessionId) return;
  setEntry(useTeamError, key, null);
  setEntry(useTeamPending, key, true);
  try {
    const result = await request<TeamCommandResults['session.setTeam']>({ type: 'session.setTeam', sessionId, mode });
    if (result.error) throw new Error(result.error);
    updateTab(key, (tab) => ({ ...tab, team: teamOf(result) }));
  } catch (error) {
    showTeamError(key, describe('session.setTeam', error));
  } finally {
    setEntry(useTeamPending, key, null);
  }
}

/** @brief 点了模型菜单里的 Task mode 一行；不需要确认（§13.1）。 */
export function toggleTeam(key: string): void {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  if (tab) void setTeam(key, nextSwitch(tab.team.mode));
}
