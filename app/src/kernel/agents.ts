// AGENTS.md（docs/v0/screens/settings.md "AGENTS.md"）：读写用户级的 <agentDir>/AGENTS.md，
// 列出 agentDir 里实际生效的文件和焦点会话加载的其他文件。哪个文件生效、加载了哪些，都取 pi 自己的结果
// （loadProjectContextFiles、resourceLoader.getAgentsFiles），不重新列举文件名。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentsInfo } from '../shared/protocol';
import { loadPi } from './pi';
import { renameReplacing } from './renameRetry';
import { sessionContext } from './sessions';

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
