// 输入框的"/"补全（docs/v0/screens/slash.md）：什么时候出列表、筛选词、过滤与分组、插入，以及读取这个会话的
// 提示词模板和技能命令（后台进程 session.commands）。列表界面在 components/SlashMenu.tsx。

import { useEffect, useState } from 'react';
import type { SlashCommand } from '../../../shared/protocol';
import { describe, request } from './bridge';

/** @brief 补全项的读取状态。 */
export type SlashLoad =
  | { status: 'loading' }
  | {
    status: 'ready';
    /** 这个会话的提示词模板和技能命令，按后台进程给出的顺序 */
    commands: SlashCommand[];
  }
  | {
    status: 'error';
    /** 报错原文 */
    message: string;
  };

/** @brief 列表里的一组。 */
export interface SlashGroup {
  /** 提示词模板或技能 */
  kind: SlashCommand['kind'];
  /** 组名 */
  label: string;
  /** 这一组过滤后的项：名字以筛选词开头的在前，包含它的在后 */
  items: SlashCommand[];
}

/** 两组的顺序和组名 */
const GROUPS: ReadonlyArray<Pick<SlashGroup, 'kind' | 'label'>> = [
  { kind: 'prompt', label: 'Prompt templates' },
  { kind: 'skill', label: 'Skills' },
];

/** @brief 草稿里第一个空白的位置；没有空白时为草稿长度。 */
function firstSpace(draft: string): number {
  const index = draft.search(/\s/);
  return index < 0 ? draft.length : index;
}

/** @brief 草稿的第一个词（含开头的 /）。 */
export function firstWord(draft: string): string {
  return draft.slice(0, firstSpace(draft));
}

/**
 * @brief 筛选词：草稿以 / 开头、光标在第一个空白之前时，是 / 后面到第一个空白的字；否则为 null（不出列表）。
 * @param caret 光标位置（selectionStart）
 */
export function slashQuery(draft: string, caret: number): string | null {
  if (!draft.startsWith('/')) return null;
  const end = firstSpace(draft);
  return caret <= end ? draft.slice(1, end) : null;
}

/** @brief 按筛选词过滤（不分大小写；名字以它开头的在前，包含它的在后），再分成"Prompt templates""Skills"两组；空组不列。 */
export function filterCommands(commands: SlashCommand[], query: string): SlashGroup[] {
  const needle = query.toLowerCase();
  const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(needle));
  const inside = commands.filter((command) => !prefix.includes(command) && command.name.toLowerCase().includes(needle));
  const ranked = [...prefix, ...inside];
  return GROUPS.map((group) => ({ ...group, items: ranked.filter((command) => command.kind === group.kind) }))
    .filter((group) => group.items.length > 0);
}

/** @brief 插入一项：第一个词换成"/名字 "（带一个空格），后面原有的文字去掉开头的空格接上。 */
export function insertCommand(draft: string, name: string): string {
  const rest = draft.slice(firstSpace(draft)).replace(/^[ \t]+/, '');
  return `/${name} ${rest}`;
}

/**
 * @brief 列表打开时读取这个会话的提示词模板和技能命令，每次打开都重新读；
 *        关闭时回到 loading（"Loading…"），下次打开不先闪出上一次的结果。
 */
export function useSlashCommands(open: boolean, sessionId: string | null): SlashLoad {
  const [load, setLoad] = useState<SlashLoad>({ status: 'loading' });
  useEffect(() => {
    if (!open || !sessionId) return;
    let current = true;
    request<SlashCommand[]>({ type: 'session.commands', sessionId }).then(
      (commands) => { if (current) setLoad({ status: 'ready', commands }); },
      (error: unknown) => {
        const message = describe('session.commands', error);
        if (current) setLoad({ status: 'error', message });
      },
    );
    return () => {
      current = false;
      setLoad({ status: 'loading' });
    };
  }, [open, sessionId]);
  return load;
}
