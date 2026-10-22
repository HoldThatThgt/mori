// 删除用户会话时一并删除它的 TaskBoard 目录（docs/specs/parallel-agents-taskboard.md §3、§11.5）：
// <userData>/teams/<会话 id>/（board.json 与实例会话文件）。会话 id 取会话文件第一行（pi 的会话头部）里的 id，
// 在删除会话文件之前读出；还没写盘的会话按 pi 给会话文件起的名字 <时刻>_<id>.jsonl 取 id。归档不动它。

import { open, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** pi 允许的会话 id（pi core/session-manager.js assertValidSessionId）：不会是 . 或 ..，拼进路径不会跳出 teams 目录 */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** 读会话头部最多读的字节数：头部只有类型、版本、id、时间、工作目录和 parentSession */
const HEADER_BYTES = 64 * 1024;

/**
 * @brief 读会话文件第一行（pi 的会话头部）里的会话 id。
 * @param sessionFile 会话文件
 * @return 会话 id；文件不存在、第一行不是 pi 的会话头部或 id 不合 pi 的写法时为 null（记错误日志）
 */
export async function sessionIdOfFile(sessionFile: string): Promise<string | null> {
  let text: string;
  try {
    const handle = await open(sessionFile, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    console.error(`[main] cannot read the header of ${sessionFile}: ${(error as Error).message}`);
    return null;
  }
  try {
    const header = JSON.parse(text.split(/\r?\n/)[0] ?? '') as { type?: unknown; id?: unknown };
    if (header.type === 'session' && typeof header.id === 'string' && SESSION_ID.test(header.id)) return header.id;
  } catch (error) {
    console.error(`[main] the header of ${sessionFile} is not JSON: ${(error as Error).message}`);
    return null;
  }
  console.error(`[main] the first line of ${sessionFile} is not a session header with a valid id`);
  return null;
}

/**
 * @brief 还没写盘的会话的 id：pi 给会话文件起的名字是 `<时刻>_<id>.jsonl`（core/session-manager.js）。
 *        立项在对话写下第一条消息之前就可能写了 TaskBoard（§5.3），所以没写盘的会话也可能有 teams/<id>。
 * @param sessionFile 会话文件（不存在）
 * @return 会话 id；名字不是这种写法时为 null（记错误日志）
 */
export function sessionIdOfName(sessionFile: string): string | null {
  const id = /^[^_]+_(.+)\.jsonl$/i.exec(basename(sessionFile))?.[1];
  if (id !== undefined && SESSION_ID.test(id)) return id;
  console.error(`[main] the name of ${sessionFile} does not carry a session id`);
  return null;
}

/**
 * @brief 永久删除一个用户会话的 TaskBoard 目录 <userData>/teams/<会话 id>/；目录不存在时什么都不做。
 * @param userData Electron 的 userData 目录
 * @param sessionId 用户会话 id（sessionIdOfFile 的结果）
 * @return 删不掉时的原文（记错误日志）；删掉或本来就没有时为 null
 */
export async function removeTeamDir(userData: string, sessionId: string): Promise<string | null> {
  const dir = join(userData, 'teams', sessionId);
  try {
    await rm(dir, { recursive: true, force: true });
    return null;
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[main] cannot delete ${dir}: ${message}`);
    return message;
  }
}
