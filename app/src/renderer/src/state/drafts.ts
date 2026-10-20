// 各会话的草稿：按会话文件存在本机（localStorage），切换会话、去别的页面、重启 App 后都还在（方案 5.3）。
// 还没发过消息的新会话也有会话文件路径（文件要等第一条消息才写出）；它重启后不在会话列表里，草稿留在本机但不再显示。
// 不按会话列表清理草稿：pi 读不出会话目录时列表为空，按它清理会误删全部草稿。

import { useApp, type Tab } from './store';

const STORAGE_KEY = 'mori.drafts';

/** @brief 读出全部草稿；读不出来时记录错误并当作没有。 */
function readAll(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return value && typeof value === 'object' ? value as Record<string, string> : {};
  } catch (error) {
    console.error(`[renderer] cannot read saved drafts: ${(error as Error).message}`);
    return {};
  }
}

/** @brief 写回全部草稿。 */
function writeAll(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch (error) {
    console.error(`[renderer] cannot save drafts: ${(error as Error).message}`);
  }
}

/** @brief 某个会话保存的草稿；没有时为空串。 */
export function savedDraft(sessionFile: string | null): string {
  return sessionFile ? readAll()[sessionFile] ?? '' : '';
}

/** @brief 删除某个会话的草稿（会话被删除时）。 */
export function dropDraft(sessionFile: string | null): void {
  if (!sessionFile) return;
  const drafts = readAll();
  delete drafts[sessionFile];
  writeAll(drafts);
}

/** @brief 有会话文件、且草稿或文件变了的会话。 */
function changed(tabs: Tab[], previous: Tab[]): Tab[] {
  const before = new Map(previous.map((tab) => [tab.key, tab]));
  return tabs.filter((tab) => {
    const old = before.get(tab.key);
    return tab.sessionFile && (old?.draft !== tab.draft || old?.sessionFile !== tab.sessionFile);
  });
}

/** @brief 草稿一变就保存：输入、发送后清空、停止时放回输入框，都经过会话的 draft 字段。 */
export function persistDrafts(): void {
  useApp.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return;
    const dirty = changed(state.tabs, previous.tabs);
    if (dirty.length === 0) return;
    const drafts = readAll();
    for (const tab of dirty) {
      const key = tab.sessionFile!;
      if (tab.draft) drafts[key] = tab.draft;
      else delete drafts[key];
    }
    writeAll(drafts);
  });
}
