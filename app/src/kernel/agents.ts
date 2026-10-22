// AGENTS.md（docs/v0/screens/settings.md "AGENTS.md"）：读写用户级的 <agentDir>/AGENTS.md，
// 列出 agentDir 里实际生效的文件和焦点会话加载的其他文件。哪个文件生效、加载了哪些，都取 pi 自己的结果
// （loadProjectContextFiles、resourceLoader.getAgentsFiles），不重新列举文件名。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentsInfo } from '../shared/protocol';
import { loadPi } from './pi';
import { sessionContext } from './sessions';

/** 改名的目标正被别的进程短暂打开（杀毒、索引、读它的程序）时 Windows 报的错误：重试几次 */
const BUSY_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** 改名重试的次数与每次多等的毫秒数（第 n 次重试前等 n × 间隔，合计不到 1 秒） */
const RENAME_ATTEMPTS = 10;
const RENAME_STEP_MS = 20;

/**
 * @brief 改名替换目标文件。Windows 上目标文件正被别的进程打开时 MoveFileEx 会失败（EPERM、EACCES、EBUSY），
 *        这时稍等再试，最多 RENAME_ATTEMPTS 次；其余错误和最后一次的错误照常抛出。
 */
async function renameReplacing(from: string, to: string): Promise<void> {
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

/**
 * @brief 先写临时文件再改名，避免写到一半留下损坏的文件；目录不存在时先创建。
 * @param text 以 UTF-8 写入的全文
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, text, 'utf8');
  await renameReplacing(temp, path);
}

/** @brief 读用户级 AGENTS.md；文件不存在时为 null。 */
async function readUserFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** @brief pi 会从 agentDir 加载的那个文件（AGENTS.override.md、AGENTS.md…中第一个存在的）；都没有时为 null。 */
async function effectiveFile(agentDir: string): Promise<string | null> {
  const pi = await loadPi();
  const dir = resolve(agentDir);
  const files = pi.loadProjectContextFiles({ cwd: agentDir, agentDir });
  return files.find((file) => dirname(file.path) === dir)?.path ?? null;
}

/** @brief 用户级 AGENTS.md 和焦点会话加载的其他文件；没有会话时 loaded 为 null。 */
export async function readAgents(sessionId?: string): Promise<AgentsInfo> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  const userPath = join(agentDir, 'AGENTS.md');
  const dir = resolve(agentDir);
  const loaded = sessionId
    ? sessionContext(sessionId).session.resourceLoader.getAgentsFiles().agentsFiles
      .map((file) => file.path).filter((path) => dirname(path) !== dir)
    : null;
  return { userPath, content: await readUserFile(userPath), effectivePath: await effectiveFile(agentDir), loaded };
}

/** @brief 写 <agentDir>/AGENTS.md（UTF-8），返回之后 agentDir 里生效的文件。 */
export async function saveAgents(content: string): Promise<{ effectivePath: string | null }> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  await writeFileAtomic(join(agentDir, 'AGENTS.md'), content);
  return { effectivePath: await effectiveFile(agentDir) };
}
