// 工具页的数据（docs/v0/screens/tools.md）：跟随的会话的 tools.get 结果。每次进入工具页、每次启停或添加之后重新读取，
// 不监视文件。改动配置的命令（启停、添加、移除、保存）都经 changeTools 发出，结束后重新读取。

import { useState } from 'react';
import { create } from 'zustand';
import type { Command, ResourceKind, ToolsInfo } from '../../../shared/protocol';
import { describe, request } from './bridge';
import type { Item } from './model';

/** @brief 工具页的读取状态。 */
export interface ToolsState {
  /** 读取用的会话 id（跟随的会话）；没有会话时为 null */
  sessionId: string | null;
  /** 最近一次读到的内容；还没读到时为 null（界面显示"Loading…"） */
  info: ToolsInfo | null;
  /** 最近一次读取失败的原文；重新读取时清除 */
  error: string | null;
}

/**
 * @brief Customize 的分节：读 tools.get 的四节（Built-in tools、Skills、MCP、Plugins）和最后一节 Instructions
 *        （agents：用户级 AGENTS.md，自己读 agents.get，docs/v1/screens/customize-agents-md.md）。
 */
export type ToolsSection = 'builtin' | 'skills' | 'mcp' | 'plugins' | 'agents';

/** @brief Customize 选中的分节。 */
export interface ToolsNav {
  /** 选中的分节；null 或这一节此刻不在列表里时是第一节（有会话时 Built-in tools，没有时 Skills） */
  chosen: ToolsSection | null;
}

/** @brief Customize 选中的分节：每次进入时由 openTools 设好（侧栏进入为 null，记忆页的 Edit in Customize 为 agents）。 */
export const useToolsNav = create<ToolsNav>(() => ({ chosen: null }));

/** 离开工具页后的状态：下次进入时先显示"Loading…" */
const EMPTY: ToolsState = { sessionId: null, info: null, error: null };

/** @brief 工具页读到的内容（跟随的会话的 tools.get 结果）；离开工具页时由 resetTools 清空。 */
export const useTools = create<ToolsState>(() => EMPTY);

/** 读取的序号：只有最后一次读取的结果生效 */
let generation = 0;
/** 工具页开着（读取过、还没离开）；离开后改动命令结束时不再重新读取 */
let shown = false;

/** @brief 离开工具页：丢掉读到的内容，进行中的读取结果也不再生效。 */
export function resetTools(): void {
  generation += 1;
  shown = false;
  useTools.setState(EMPTY);
}

/** @brief 读取工具页的内容；换了会话时先丢掉旧会话的内容，同一会话重新读取时旧内容留到新结果到达。 */
export async function loadTools(sessionId: string | null): Promise<void> {
  generation += 1;
  shown = true;
  const current = generation;
  useTools.setState((state) => ({ sessionId, error: null, info: state.sessionId === sessionId ? state.info : null }));
  try {
    const command: Command = sessionId ? { type: 'tools.get', sessionId } : { type: 'tools.get' };
    const info = await request<ToolsInfo>(command);
    if (current === generation) useTools.setState({ info });
  } catch (error) {
    const message = describe('tools.get', error);
    if (current === generation) useTools.setState({ error: message });
  }
}

/**
 * @brief 发出一条改动配置的命令，之后重新读取。成功时返回 null；命令报错，或结果里带 pi 报告的错误
 *        （SaveResult 的 error，例如设置的 drainErrors）时返回原文。
 */
export async function changeTools(command: Command): Promise<string | null> {
  let failure: string | null = null;
  try {
    const result = await request<{ error?: string | null } | null | undefined>(command);
    failure = result?.error ?? null;
    if (failure) console.error(`[renderer] ${command.type} reported: ${failure}`);
  } catch (error) {
    failure = describe(command.type, error);
  }
  if (shown) await loadTools(useTools.getState().sessionId);
  return failure;
}

/** @brief 启停一个资源的命令（照 pi config 的写法，由后台进程写入）；带上跟随的会话，本项目的资源据此找到项目。 */
export function toggleCommand(kind: ResourceKind, path: string, enabled: boolean): Command {
  const sessionId = useTools.getState().sessionId;
  return { type: 'resource.toggle', kind, path, enabled, ...(sessionId ? { sessionId } : {}) };
}

/** @brief 一行或一张卡上一次改动的状态。 */
export interface Change {
  /** 命令还没结束（含之后的重新读取） */
  busy: boolean;
  /** 上一次改动失败的原文；没有时为 null */
  error: string | null;
  /** 发出命令；成功时为 true */
  run: (command: Command) => Promise<boolean>;
  /** 清掉失败的原文 */
  clear: () => void;
}

/** @brief 一行或一张卡自己的改动状态：失败的原文留在这一行下面，直到下一次改动。 */
export function useChange(): Change {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(command: Command): Promise<boolean> {
    setBusy(true);
    setError(null);
    const failure = await changeTools(command);
    setBusy(false);
    setError(failure);
    return failure === null;
  }
  return { busy, error, run, clear: () => setError(null) };
}

/** @brief 对话流里 pi 的 MCP 扩展的通知（以 "MCP " 开头），按出现的顺序。 */
export function mcpNotices(items: Item[] | undefined): string[] {
  return (items ?? []).flatMap((item) => (item.kind === 'notify' && item.text.startsWith('MCP ') ? [item.text] : []));
}

/**
 * @brief 通知里关于一个服务的行（去掉缩进）：以 "<服务名>:" 开头的连接错误，例如 "broken: failed: MCP connection closed"；
 *        以 "config: " 开头、提到 `server "<服务名>"` 或 `invalid server name "<服务名>"` 的配置问题，例如
 *        `config: C:\…\mcp.json: server "x": args must be an array of strings`（pi 没有加载它）。
 */
export function serverLines(notice: string, name: string): string[] {
  const quoted = `"${name}"`;
  return notice.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(`${name}:`)
    || (line.startsWith('config: ') && (line.includes(`server ${quoted}`) || line.includes(`server name ${quoted}`))));
}
