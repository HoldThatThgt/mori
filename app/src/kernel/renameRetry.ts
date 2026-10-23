// 先写临时文件再改名的那一步：Windows 上目标文件正被别的进程短暂打开（杀毒、索引、正在读它的程序）时改名会失败，
// 稍等再试。AGENTS.md（agents.ts）、TaskBoard（board.ts 经 agents.ts）、model-config.json 与模型档案共用。

import { rename } from 'node:fs/promises';

/** 改名的目标正被别的进程短暂打开时 Windows 报的错误：重试几次 */
const BUSY_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** 改名重试的次数与每次多等的毫秒数（第 n 次重试前等 n × 间隔，合计不到 1 秒） */
const RENAME_ATTEMPTS = 10;
const RENAME_STEP_MS = 20;

/**
 * @brief 改名替换目标文件。Windows 上目标文件正被别的进程打开时 MoveFileEx 会失败（EPERM、EACCES、EBUSY），
 *        这时稍等再试，最多 RENAME_ATTEMPTS 次；其余错误和最后一次的错误照常抛出。
 * @param from 写好的临时文件
 * @param to 目标文件
 */
export async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !BUSY_RENAME.has(code)) throw error;
      console.error(`[kernel] renaming ${from} failed (${code}), attempt ${attempt}; retrying`);
      await new Promise((done) => setTimeout(done, RENAME_STEP_MS * attempt));
    }
  }
}
