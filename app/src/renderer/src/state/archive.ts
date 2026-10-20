// 已归档的会话（docs/v0/screens/sessions.md "归档与删除"）：照 Claude 桌面版，归档是平常用、可以恢复的操作。
// pi 没有归档，已归档列表由 Mori 按会话文件记在本机（localStorage），会话内容仍只有 pi 的会话文件一份。

const STORAGE_KEY = 'mori.archived';

/** @brief 读出已归档的会话文件；读不出来时记录错误并当作没有。 */
export function loadArchived(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch (error) {
    console.error(`[renderer] cannot read archived sessions: ${(error as Error).message}`);
    return [];
  }
}

/** @brief 写回已归档的会话文件。 */
export function saveArchived(files: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  } catch (error) {
    console.error(`[renderer] cannot save archived sessions: ${(error as Error).message}`);
  }
}
