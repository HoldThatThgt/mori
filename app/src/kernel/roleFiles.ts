// Customize › Agents 写出的角色文件（docs/specs/customize-agents.md §5.1–§5.3）：把表单的字段与编辑时保留的字段写成
// 文件全文，检查文件名与路径，取出编辑时保留的字段，看文件头有没有 # 注释。纯函数；读写文件在 roleCommands.ts。
// 写法只用 JSON（YAML 认得的子集），不新增依赖；读回用 pi 的 parseFrontmatter（单元测试对照）。

import type { Seat } from '../shared/team';
import { AGENTS_DIR } from './roles';

/** @brief 原样写的值：只含字母、数字、下划线与 ._/-（§5.1），且不是 NOT_A_STRING；其余写成 JSON 字符串。 */
const PLAIN = /^[\w./-]+$/;

/**
 * @brief pi 的 parseFrontmatter（yaml 包，YAML 1.2 core schema）不会读回成同一个字符串的写法：null、布尔、十进制、
 *        八进制、十六进制、浮点、.inf、.nan，以及单独的 -（序列的开头，读不出）。这些要写成 JSON 字符串（§5.1）。
 */
const NOT_A_STRING = new RegExp(`^(?:${[
  '~', '[Nn]ull', 'NULL', '[Tt]rue', 'TRUE', '[Ff]alse', 'FALSE', '-',
  '[-+]?\\.(?:inf|Inf|INF)', '\\.(?:nan|NaN|NAN)', '0o[0-7]+', '0x[0-9a-fA-F]+',
  '[-+]?(?:\\.[0-9]+|[0-9]+(?:\\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?',
].join('|')})$`);

/** @brief .mori/agents 下直接的一个 .md 文件（相对项目根，/ 分隔）；文件名部分不能为空。 */
const AGENT_FILE = /^\.mori\/agents\/([^/\\]+\.md)$/i;

/** @brief 文件头要写的字段：表单的六个字段里除正文外的五个，加上编辑时原样保留的三个（没有时不写）。 */
export interface RoleHeader {
  /** 名字 */
  name: string;
  /** 一句话说明，总写成 JSON 字符串 */
  description: string;
  /** 工具；null 不写 */
  tools: readonly string[] | null;
  /** 模型范围；null 不写 */
  models: readonly string[] | null;
  /** 职责；空时不写 */
  seats: readonly Seat[];
  /** 文件里原来的 requires；没有时省略 */
  requires?: unknown;
  /** 文件里原来的 differ_from；没有时省略 */
  differ_from?: unknown;
  /** 文件里原来的 subscribe（写成 JSON）；没有时省略 */
  subscribe?: unknown;
}

/** @brief 一个标量：PLAIN 且读回仍是同一个字符串时原样，否则 JSON。 */
function scalarText(value: unknown): string {
  return typeof value === 'string' && PLAIN.test(value) && !NOT_A_STRING.test(value) ? value : JSON.stringify(value);
}

/** @brief 一个值：列表写成单行的 [a, b]（每项按 scalarText），其余按 scalarText。 */
function valueText(value: unknown): string {
  return Array.isArray(value) ? `[${value.map(scalarText).join(', ')}]` : scalarText(value);
}

/**
 * @brief 角色文件的全文（§5.1）：字段按 name、description、tools、models、requires、seats、differ_from、subscribe 的顺序，
 *        没有的不写；正文去掉首尾空白，前面空一行，为空时没有这一段。换行一律 \n。
 * @param header 文件头的字段
 * @param body 正文（界面上的 Prompt）
 */
export function roleFileText(header: RoleHeader, body: string): string {
  const lines = [`name: ${scalarText(header.name)}`, `description: ${JSON.stringify(header.description)}`];
  if (header.tools !== null) lines.push(`tools: ${valueText(header.tools)}`);
  if (header.models !== null) lines.push(`models: ${valueText(header.models)}`);
  if (header.requires !== undefined) lines.push(`requires: ${valueText(header.requires)}`);
  if (header.seats.length > 0) lines.push(`seats: ${valueText(header.seats)}`);
  if (header.differ_from !== undefined) lines.push(`differ_from: ${valueText(header.differ_from)}`);
  if (header.subscribe !== undefined) lines.push(`subscribe: ${JSON.stringify(header.subscribe)}`);
  const text = body.replace(/\r\n?/g, '\n').trim();
  return `---\n${lines.join('\n')}\n---\n${text ? `\n${text}\n` : ''}`;
}

/**
 * @brief 文件名：file 是 .mori/agents/ 下直接的一个 .md 文件时为它的文件名，否则为 null（绝对路径、..、子目录、
 *        反斜杠、别的扩展名都不算，§5.2）。
 * @param file 界面发来的相对路径
 */
export function agentFileName(file: string): string | null {
  const match = AGENT_FILE.exec(file);
  if (!match || match[1].length <= '.md'.length) return null;
  return match[1];
}

/** @brief 新建时的文件：.mori/agents/<name>.md（§5.1）。 */
export function newAgentFile(name: string): string {
  return `${AGENTS_DIR}/${name}.md`;
}

/** @brief 编辑时原样写回的字段（§5.3）：文件里有的 requires、differ_from、subscribe。 */
export function keptFields(frontmatter: unknown): Pick<RoleHeader, 'requires' | 'differ_from' | 'subscribe'> {
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) return {};
  const fields = frontmatter as Record<string, unknown>;
  const kept: Pick<RoleHeader, 'requires' | 'differ_from' | 'subscribe'> = {};
  for (const key of ['requires', 'differ_from', 'subscribe'] as const) {
    if (fields[key] !== undefined) kept[key] = fields[key];
  }
  return kept;
}

/** @brief 一行 YAML 里有没有注释：引号外、行首或空白后面的 #。 */
function hasComment(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote === '"' && char === '\\') i += 1;
    else if (quote !== null) quote = char === quote ? null : quote;
    else if (char === '"' || char === '\'') quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return true;
  }
  return false;
}

/**
 * @brief 文件头（两行 --- 之间，同 pi 的 parseFrontmatter：文件以 --- 开头，到下一个 \n--- 为止）里有没有 # 注释；
 *        编辑保存会去掉它们（§5.3）。
 * @param text 文件全文
 */
export function hasHeaderComments(text: string): boolean {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---')) return false;
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return false;
  return normalized.slice(4, end).split('\n').some(hasComment);
}
