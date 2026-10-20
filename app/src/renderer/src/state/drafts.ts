// 各会话的草稿：按会话文件存在本机（localStorage），切换会话、去别的页面、重启 App 后都还在（方案 5.3）。
// 文字存在 mori.drafts，输入框里的引用芯片（M4）存在 mori.draftRefs，两者都按会话文件。
// 还没发过消息的新会话也有会话文件路径（文件要等第一条消息才写出）；它重启后不在会话列表里，草稿留在本机但不再显示。
// 不按会话列表清理草稿：pi 读不出会话目录时列表为空，按它清理会误删全部草稿。

import { z } from 'zod';
import { QuoteRefSchema, type QuoteRef } from '../../../shared/protocol';
import { useApp, type Tab } from './store';

const STORAGE_KEY = 'mori.drafts';
const REFS_KEY = 'mori.draftRefs';
const RefsSchema = z.array(QuoteRefSchema);

/** @brief 读出一个键下全部会话的值；读不出来时记录错误并当作没有。 */
function readAll<T>(key: string): Record<string, T> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown;
    return value && typeof value === 'object' ? value as Record<string, T> : {};
  } catch (error) {
    console.error(`[renderer] cannot read saved ${key}: ${(error as Error).message}`);
    return {};
  }
}

/** @brief 写回一个键下全部会话的值。 */
function writeAll(key: string, values: Record<string, unknown>): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch (error) {
    console.error(`[renderer] cannot save ${key}: ${(error as Error).message}`);
  }
}

/** @brief 某个会话保存的草稿；没有时为空串。 */
export function savedDraft(sessionFile: string | null): string {
  return sessionFile ? readAll<string>(STORAGE_KEY)[sessionFile] ?? '' : '';
}

/** @brief 某个会话保存的引用芯片；没有或内容不对时为空（内容不对时记录错误）。 */
export function savedDraftRefs(sessionFile: string | null): QuoteRef[] {
  const value = sessionFile ? readAll<unknown>(REFS_KEY)[sessionFile] : undefined;
  if (value === undefined) return [];
  const parsed = RefsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.error(`[renderer] ignored malformed saved quote chips: ${parsed.error.message}`);
  return [];
}

/** @brief 删除某个会话的草稿和引用芯片（会话被删除时）。 */
export function dropDraft(sessionFile: string | null): void {
  if (!sessionFile) return;
  for (const key of [STORAGE_KEY, REFS_KEY]) {
    const values = readAll<unknown>(key);
    delete values[sessionFile];
    writeAll(key, values);
  }
}

/** @brief 有会话文件、且草稿、引用芯片或文件变了的会话。 */
function changed(tabs: Tab[], previous: Tab[]): Tab[] {
  const before = new Map(previous.map((tab) => [tab.key, tab]));
  return tabs.filter((tab) => {
    const old = before.get(tab.key);
    return tab.sessionFile
      && (old?.draft !== tab.draft || old?.draftRefs !== tab.draftRefs || old?.sessionFile !== tab.sessionFile);
  });
}

/** @brief 草稿一变就保存：输入、加减引用芯片、发送后清空、停止时放回输入框，都经过会话的 draft / draftRefs。 */
export function persistDrafts(): void {
  useApp.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return;
    const dirty = changed(state.tabs, previous.tabs);
    if (dirty.length === 0) return;
    const drafts = readAll<string>(STORAGE_KEY);
    const refs = readAll<unknown>(REFS_KEY);
    for (const tab of dirty) {
      const key = tab.sessionFile!;
      if (tab.draft) drafts[key] = tab.draft;
      else delete drafts[key];
      if (tab.draftRefs.length > 0) refs[key] = tab.draftRefs;
      else delete refs[key];
    }
    writeAll(STORAGE_KEY, drafts);
    writeAll(REFS_KEY, refs);
  });
}
