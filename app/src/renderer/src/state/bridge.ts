// 通往后台进程的命令：每条命令记进最近的操作（F8 报告用，不含机密），失败的原文记录到控制台。

import type { Command } from '../../../shared/protocol';
import { logCommand } from './actionLog';

/** @brief 把异常转成一行原文，并记录到控制台。 */
export function describe(what: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[renderer] ${what} failed: ${message}`);
  return message;
}

/** @brief 主进程报错的原文：去掉 Electron 加在前面的 "Error invoking remote method …"，并记录到控制台。 */
export function mainError(what: string, error: unknown): string {
  return describe(what, error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

/** @brief 发一条命令给后台进程，并记进最近的操作。 */
export function request<T>(command: Command): Promise<T> {
  logCommand(command);
  return window.mori.request<T>(command);
}
