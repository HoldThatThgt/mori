// AGENTS.md（docs/v0/screens/settings.md "AGENTS.md"）：读写用户级的 <agentDir>/AGENTS.md，
// 列出 agentDir 里实际生效的文件和焦点会话加载的其他文件。哪个文件生效、加载了哪些，都取 pi 自己的结果
// （loadProjectContextFiles、resourceLoader.getAgentsFiles），不重新列举文件名。
// v1：每个文件的 token 数与合计（docs/specs/memory.md §10.3），按 pi 加载结果里的 content（已去 BOM）用记忆的估算算。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { estimateMemoryTokens } from '../shared/memory';
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

/**
 * @brief pi 会从 agentDir 加载的那个文件（AGENTS.override.md、AGENTS.md…中第一个存在的）与 pi 读到的内容；
 *        都没有时为 null。
 */
async function effectiveFile(agentDir: string): Promise<{ path: string; content: string } | null> {
  const pi = await loadPi();
  const dir = resolve(agentDir);
  const files = pi.loadProjectContextFiles({ cwd: agentDir, agentDir });
  return files.find((file) => dirname(file.path) === dir) ?? null;
}

/**
 * @brief 用户级 AGENTS.md 和焦点会话加载的其他文件（没有会话时 loaded 为 null），以及 token 数（docs/specs/memory.md §10.3）：
 *        每个文件按 pi 加载的 content 单独估算（不含 pi 加的开头与包装）；userTokens 是生效的用户级文件的，没有时为 0；
 *        total = userTokens + loaded 各项之和。
 */
export async function readAgents(sessionId?: string): Promise<AgentsInfo> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  const userPath = join(agentDir, 'AGENTS.md');
  const dir = resolve(agentDir);
  const loaded = sessionId
    ? sessionContext(sessionId).session.resourceLoader.getAgentsFiles().agentsFiles
      .filter((file) => dirname(file.path) !== dir)
      .map((file) => ({ path: file.path, tokens: estimateMemoryTokens(file.content) }))
    : null;
  const effective = await effectiveFile(agentDir);
  const userTokens = effective === null ? 0 : estimateMemoryTokens(effective.content);
  const total = userTokens + (loaded ?? []).reduce((sum, file) => sum + file.tokens, 0);
  return { userPath, content: await readUserFile(userPath), effectivePath: effective?.path ?? null, loaded,
    userTokens, total };
}

/** @brief 写 <agentDir>/AGENTS.md（UTF-8），返回之后 agentDir 里生效的文件。 */
export async function saveAgents(content: string): Promise<{ effectivePath: string | null }> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  await writeFileAtomic(join(agentDir, 'AGENTS.md'), content);
  return { effectivePath: (await effectiveFile(agentDir))?.path ?? null };
}
