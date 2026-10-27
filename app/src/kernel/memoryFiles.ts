// 记忆文件的格式（docs/specs/memory.md §3、§6.2）：纯函数，不读写文件，也不引用 pi 的运行时。
// 项目目录名与归属检查（§3）、索引（§3.1）、detail（§3.2）、slug（§6.2）、修订 id 与修订记录（§3.3）的生成和解析。
// frontmatter 由调用方注入 pi 的 parseFrontmatter（YAML）；写的时候字符串值用 JSON.stringify（JSON 的字符串、数组、
// 对象都是合法的 YAML）。修订记录里改动前后的原文逐字保存，回滚的比较与恢复都按原文（§3.3、§6.6）。

import { resolve } from 'node:path';
import {
  ENHANCE_TASKS, KIND_LABEL, MEMORY_DEFAULTS, MEMORY_KINDS, MEMORY_LAYERS, evidenceLine, type EnhanceTask,
  type EntryPlace, type EntrySource, type MemoryBy, type MemoryKind, type MemoryLayer, type RevisionAction,
  type RevisionChange, type RevisionCounts, type RevisionDetail, type RevisionRow, type RevisionRun,
  type RevisionStatus, type StoredEvidence,
} from '../shared/memory';

// ---- 项目目录（§3） ----

/** @brief 项目目录里记下归属（工作目录原文）的文件名（§3）。 */
export const PROJECT_FILE = 'project.json';

/**
 * @brief 项目目录名，与 pi 的会话目录同一种编码。pi 没有导出这个函数，照写 pi 1.3.0
 *        `session-manager.js:290-295`（getDefaultSessionDirPath），升级 pi 时复查。
 *        按路径精确匹配：大小写不同算不同项目，子文件夹不算同一个项目（§3）。
 *        记忆模块的 projectDir 传入项目文件夹（file-system.md §11.7：Mori worktree 里的会话为主文件夹），编码本身不变。
 * @param cwd 工作目录（项目文件夹）
 */
export function projectDirName(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * @brief 编码冲突的检查（§3）：项目目录已被别的项目文件夹认领时给出原因原文，否则为 null。
 *        凡是按工作目录找项目目录的地方都经它（记忆模块的 projectDir）；两边都按项目文件夹比
 *        （file-system.md §11.7：project.json 记主文件夹，worktree 会话传入的也是主文件夹，不算被占用）。
 * @param folder 要用这个目录的项目文件夹（projectFolder(cwd)）
 * @param owner project.json 记下的项目文件夹；还没有认领时为 null
 */
export function projectOwnerError(folder: string, owner: string | null): string | null {
  if (owner === null || resolve(owner) === resolve(folder)) return null;
  return `This project’s memory folder belongs to ${owner}.`;
}

/** Windows 文件名里不能有的字符与控制字符：slug 只用作 entries/ 下的文件名，修订 id 只用作 revisions/ 下的文件名 */
const UNSAFE_NAME = /[/\\:*?"<>|\u0000-\u001f]/;

/**
 * @brief 这个名字能不能用作记忆目录下的文件名（不含扩展名）：不能为空、不能是 . 或 ..，不能有路径分隔符等字符。
 *        索引里手改出来的链接、命令带来的 id 都先经它，读写不会落到别的目录。
 */
export function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !UNSAFE_NAME.test(name);
}

// ---- 共用的小工具 ----

/** @brief 把换行连同两边的空白换成一个空格：写成一行的文字（依据行、修订说明、Evidence/Note 行）不会拆开文件的结构。 */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

/** @brief 两位（或指定位数）补零。 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** @brief frontmatter 的值：字符串原样，没有时为空串，其他类型转成文字。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : String(value);
}

/**
 * @brief 必有、且只能取几个值之一的字段。
 * @throws Error 缺少或取值不在 allowed 里
 */
function oneOf<T extends string>(front: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = front[key];
  if (value === undefined || value === null || value === '') throw new Error(`${key} is missing.`);
  if (!allowed.includes(value as T)) throw new Error(`${key} must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

/** @brief 注入的 pi parseFrontmatter：YAML frontmatter 与去掉 frontmatter、统一换行并去掉首尾空白的正文。 */
export type FrontmatterParser = (text: string) => { frontmatter: Record<string, unknown>; body: string };

// ---- 索引（§3.1） ----

/** @brief 索引里的一行。 */
export interface IndexItem {
  /** 链接文字（已去掉转义） */
  abstract: string;
  /** 链接指向的 entries/<slug>.md */
  slug: string;
}

/** 索引的一行：`- [<text>](entries/<slug>.md)`，text 里的 `]`、`\` 写作 `\]`、`\\` */
const INDEX_LINE = /^- \[((?:\\.|[^\\\]])*)\]\(entries\/(.+)\.md\)\s*$/;

/**
 * @brief 解析索引（§3.1）：只认 `- [<text>](entries/<slug>.md)` 的行，别的行忽略；slug 不能用作文件名的行也忽略。
 * @param text 索引文件全文
 * @return 按文件里的顺序
 */
export function parseIndex(text: string): IndexItem[] {
  const items: IndexItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = INDEX_LINE.exec(line);
    if (match && isSafeName(match[2])) items.push({ abstract: match[1].replace(/\\(.)/g, '$1'), slug: match[2] });
  }
  return items;
}

/**
 * @brief 生成索引（§3.1）：第一行标题（`# Facts`、`# TASTE`…），之后一行一条，顺序就是进 prompt 的顺序。
 *        手改的 detail 里多行的 abstract 在索引里写成一行，索引的行不会被拆开。
 * @param kind 种类
 * @param items 条目，按顺序
 */
export function renderIndex(kind: MemoryKind, items: readonly IndexItem[]): string {
  const lines = items.map((item) => {
    const text = oneLine(item.abstract).replace(/[\\\]]/g, '\\$&');
    return `- [${text}](entries/${item.slug}.md)`;
  });
  return `${[`# ${KIND_LABEL[kind]}`, ...lines].join('\n')}\n`;
}

// ---- detail（§3.2） ----

/** @brief 一个 detail 文件的内容。 */
export interface DetailFile {
  /** 种类 */
  kind: MemoryKind;
  /** 进 prompt 的一行 */
  abstract: string;
  /** 你说的、它学的 */
  source: EntrySource;
  /** `YYYY-MM-DD · <谁>` */
  created: string;
  /** `YYYY-MM-DD · <谁>` */
  modified: string;
  /** frontmatter 里的依据 */
  evidence: StoredEvidence[];
  /** `## Details` 的原文 */
  details: string;
  /** `## Revisions` 的每一行（不含 `- `） */
  history: string[];
}

const SOURCES: readonly EntrySource[] = ['user', 'learned'];

/** 程序生成的三个小标题（§3.2） */
const EVIDENCE_HEADING = '## Evidence';
const DETAILS_HEADING = '## Details';
const REVISIONS_HEADING = '## Revisions';

/** @brief 一项依据按固定的键顺序写（没有的键不写），写出与读回的文字一致。 */
export function canonicalEvidence(item: StoredEvidence): StoredEvidence {
  const result: StoredEvidence = { at: item.at };
  if (item.session !== undefined) result.session = item.session;
  if (item.entry !== undefined) result.entry = item.entry;
  if (item.title !== undefined) result.title = item.title;
  if (item.feedback !== undefined) result.feedback = item.feedback;
  if (item.quote !== undefined) result.quote = item.quote;
  return result;
}

/**
 * @brief frontmatter 的 evidence：没有时为空；每项要有日期，其他字段取对的类型。
 * @throws Error 不是列表，或某一项没有日期
 */
function parseEvidence(value: unknown): StoredEvidence[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('evidence must be a list.');
  return value.map((raw: unknown, index) => {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || typeof item.at !== 'string') {
      throw new Error(`evidence ${index + 1} has no date.`);
    }
    const text = (key: string) => (typeof item[key] === 'string' ? (item[key] as string) : undefined);
    const entry = item.entry === null ? null : text('entry');
    return canonicalEvidence({ at: item.at, session: text('session'), entry, title: text('title'),
      feedback: text('feedback'), quote: text('quote') });
  });
}

/** @brief detail 正文的统一写法：换行统一为 \n，去掉开头的空行与结尾的空白（写出与读回一致）。 */
function normalizeDetails(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
}

/** @brief 这一行是不是某个程序生成的小标题。 */
function isHeading(line: string, heading: string): boolean {
  return line.trimEnd() === heading;
}

/**
 * @brief 从正文取 Details 与 Revisions（§3.2）。程序写的文件三节依次是 Evidence、Details、Revisions，依据行与修订行
 *        都写成一行，所以 Details 取第一个 `## Details` 到它之后最后一个 `## Revisions` 之间的原文：你在 Details 里
 *        写的 `## ` 小标题不会截断正文。Revisions 取那个 `## Revisions` 之后、下一个 `## ` 之前的 `- ` 行。
 * @param body pi 解析出的正文（换行已统一）
 */
function bodySections(body: string): Pick<DetailFile, 'details' | 'history'> {
  const lines = body.split('\n');
  const detailsAt = lines.findIndex((line) => isHeading(line, DETAILS_HEADING));
  let revisionsAt = -1;
  for (let at = lines.length - 1; at > detailsAt; at -= 1) {
    if (isHeading(lines[at], REVISIONS_HEADING)) {
      revisionsAt = at;
      break;
    }
  }
  const detailsEnd = revisionsAt >= 0 ? revisionsAt : lines.length;
  const details = detailsAt >= 0 ? normalizeDetails(lines.slice(detailsAt + 1, detailsEnd).join('\n')) : '';
  const history: string[] = [];
  for (const line of revisionsAt >= 0 ? lines.slice(revisionsAt + 1) : []) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) history.push(line.slice(2).trimEnd());
  }
  return { details, history };
}

/**
 * @brief 解析 detail 文件（§3.2）：frontmatter 的 kind、abstract、source 必有；正文按 bodySections 取。
 * @param text 文件全文（可以是手改过的）
 * @param parseFrontmatter pi 的 parseFrontmatter
 * @throws Error 读不出来的原因（英文，显示在记忆页读不出来的那一行）
 */
export function parseDetail(text: string, parseFrontmatter: FrontmatterParser): DetailFile {
  if (!text.replace(/^\uFEFF/, '').startsWith('---')) throw new Error('The file has no frontmatter.');
  const { frontmatter, body } = parseFrontmatter(text);
  const kind = oneOf(frontmatter, 'kind', MEMORY_KINDS);
  const abstract = frontmatter.abstract;
  if (typeof abstract !== 'string' || abstract.trim() === '') throw new Error('abstract is missing.');
  const source = oneOf(frontmatter, 'source', SOURCES);
  return { kind, abstract, source, created: textOf(frontmatter.created), modified: textOf(frontmatter.modified),
    evidence: parseEvidence(frontmatter.evidence), ...bodySections(body) };
}

/** @brief 一节：有内容时小标题下接内容，没有时只有小标题。 */
function section(heading: string, content: string): string {
  return content === '' ? heading : `${heading}\n${content}`;
}

/**
 * @brief 生成 detail 文件（§3.2 的版式）：frontmatter（字符串值 JSON.stringify，evidence 一行 JSON 数组），
 *        正文三节 Evidence（由 evidence 生成，同 §10.1 的依据行）、Details、Revisions，节之间空一行。
 */
export function renderDetail(detail: DetailFile): string {
  const front = ['---', `kind: ${detail.kind}`, `abstract: ${JSON.stringify(detail.abstract)}`,
    `source: ${detail.source}`, `created: ${JSON.stringify(detail.created)}`,
    `modified: ${JSON.stringify(detail.modified)}`,
    `evidence: ${JSON.stringify(detail.evidence.map(canonicalEvidence))}`, '---'];
  const evidence = detail.evidence.map((item) => `- ${oneLine(evidenceLine(item))}`).join('\n');
  const history = detail.history.map((line) => `- ${oneLine(line)}`).join('\n');
  const sections = [section(EVIDENCE_HEADING, evidence), section(DETAILS_HEADING, normalizeDetails(detail.details)),
    section(REVISIONS_HEADING, history)];
  return `${front.join('\n')}\n${sections.join('\n\n')}\n`;
}

// ---- slug 与修订 id（§6.2、§3.3） ----

/**
 * @brief 已被占用时末尾加 -2、-3…（§6.2）。
 * @param base 想用的 slug
 * @param taken 这一层是否已有这个名字
 */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/**
 * @brief 新条目的 slug（§6.2）：abstract 里的 ASCII 字母数字按空白和标点切成小写单词，用 - 连接，截到 48 字符
 *        （截断后去掉结尾的 -）；没有 ASCII 单词时 `<kind>-<YYYYMMDD>-<4 位>`；同一层已有同名时加后缀。
 * @param abstract 条目的 abstract
 * @param kind 种类
 * @param day 写入的日子 YYYY-MM-DD
 * @param taken 这一层是否已有这个名字
 * @param random4 4 位小写字母数字
 */
export function makeSlug(abstract: string, kind: MemoryKind, day: string, taken: (slug: string) => boolean,
  random4: () => string): string {
  const words = abstract.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words.join('-').toLowerCase().slice(0, MEMORY_DEFAULTS.slugMax).replace(/-+$/, '');
  const base = joined !== '' ? joined : `${kind}-${day.replace(/-/g, '')}-${random4()}`;
  return uniqueSlug(base, taken);
}

/**
 * @brief 修订 id（§3.3）：`<YYYYMMDD-HHmmss>-<4 位小写字母数字>`，本地时间，按名字排序就是时间顺序。
 * @param now 时刻
 * @param random4 4 位小写字母数字
 */
export function revisionId(now: Date, random4: () => string): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${random4()}`;
}

/** @brief 带时区的本地 ISO 时刻，例如 `2026-10-24T04:03:12.000+08:00`（修订的 time，§3.3）。 */
export function localIso(now: Date): string {
  const offset = -now.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date}T${time}.${pad(now.getMilliseconds(), 3)}${zone}`;
}

// ---- 修订记录（§3.3） ----

/** @brief 移动的文字，按目标层（§3.2、§3.3、§6.5）：修订小节的动作、修订说明与 `## Revisions` 行都用它。 */
export const MOVE_TEXT: Readonly<Record<MemoryLayer, string>> = Object.freeze({
  user: 'Moved to user level', project: 'Moved to this project',
});

/** 修订小节标题里的动作（移动见 MOVE_TEXT） */
const ACTION_HEAD: Readonly<Record<Exclude<RevisionAction, 'moved'>, string>> = Object.freeze({
  added: 'Added', changed: 'Changed', deleted: 'Deleted',
});
const ACTION_BY_HEAD = new Map<string, Exclude<RevisionAction, 'moved'>>(
  Object.entries(ACTION_HEAD).map(([action, head]) => [head, action as Exclude<RevisionAction, 'moved'>]),
);
const KIND_BY_LABEL = new Map<string, MemoryKind>(MEMORY_KINDS.map((kind) => [KIND_LABEL[kind], kind]));
const BY_VALUES: readonly MemoryBy[] = ['You', 'Mori', 'Enhancement', 'Rollback'];
const STATUSES: readonly RevisionStatus[] = ['done', 'failed', 'running'];
const CHANGE_HEADING = /^## (Added|Changed|Deleted|Moved to user level|Moved to this project) · (.+?) · (.+)$/;
const NOTES_HEADING = '## Notes';

/** @brief 修订小节的标题：`## <Added|Changed|Deleted> · <KIND> · <slug>` 或移动的 `<原层 slug> → <目标层 slug>`。 */
function changeHeading(change: RevisionChange): string {
  const kind = KIND_LABEL[change.kind];
  if (change.action === 'moved') {
    return `## ${MOVE_TEXT[change.to!.layer]} · ${kind} · ${change.from!.slug} → ${change.to!.slug}`;
  }
  return `## ${ACTION_HEAD[change.action]} · ${kind} · ${(change.to ?? change.from)!.slug}`;
}

/**
 * @brief 围起一份原文（§3.3）：围栏至少四个波浪号，比原文里只由波浪号组成的行中最长的多一个。
 *        空原文写成开头行接结尾行；否则开头行、原文、换行、结尾行，读回时逐字相同。
 */
function fenced(label: 'before' | 'after', text: string): string {
  const longest = text.split('\n').map((line) => line.replace(/\r$/, ''))
    .filter((line) => /^~+$/.test(line)).reduce((most, line) => Math.max(most, line.length), 3);
  const fence = '~'.repeat(longest + 1);
  return text === '' ? `${fence}${label}\n${fence}` : `${fence}${label}\n${text}\n${fence}`;
}

/** @brief 一处改动的一节：标题、可选的 Evidence 与 Note 行、空一行、改动前后两块。 */
function renderChange(change: RevisionChange): string {
  const lines = [changeHeading(change)];
  if (change.evidence) lines.push(`Evidence: ${oneLine(change.evidence)}`);
  if (change.note) lines.push(`Note: ${oneLine(change.note)}`);
  lines.push('', fenced('before', change.before), fenced('after', change.after));
  return lines.join('\n');
}

/** @brief 修订的 frontmatter（§3.3 的字段与顺序）。 */
function revisionFront(revision: RevisionDetail): string[] {
  const json = JSON.stringify;
  const { added, changed, deleted, moved } = revision.counts;
  const run = revision.run && { task: revision.run.task, day: revision.run.day, tokens: revision.run.tokens,
    sessions: revision.run.sessions, feedback: revision.run.feedback };
  return ['---', `id: ${json(revision.id)}`, `time: ${json(revision.time)}`, `by: ${json(revision.by)}`,
    `title: ${json(revision.title)}`, `status: ${json(revision.status)}`, `layers: ${json(revision.layers)}`,
    `kinds: ${json(revision.kinds)}`, `counts: ${json({ added, changed, deleted, moved })}`,
    `cwd: ${json(revision.cwd)}`, `run: ${json(run)}`, `rollbackOf: ${json(revision.rollbackOf)}`, '---'];
}

/**
 * @brief 生成修订记录（§3.3）：frontmatter、每处改动一节、增强运行的 `## Notes`。counts 由调用方按改动算好。
 */
export function renderRevision(revision: RevisionDetail): string {
  const parts = revision.changes.map(renderChange);
  if (revision.notes !== null) parts.push(section(NOTES_HEADING, revision.notes));
  const body = parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
  return `${revisionFront(revision).join('\n')}\n${body}`;
}

/**
 * @brief 分开修订文件的 frontmatter 与正文（正文原样，不统一换行）。
 * @throws Error 没有 frontmatter
 */
function splitRevision(text: string): { head: string; body: string } {
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  if (end < 0) throw new Error('The revision has no frontmatter.');
  const bodyAt = text.indexOf('\n', end + 1);
  return { head: text.slice(0, end + 4), body: bodyAt < 0 ? '' : text.slice(bodyAt + 1) };
}

/** @brief 必有的文字字段。 */
function requiredText(front: Record<string, unknown>, key: string): string {
  const value = front[key];
  if (typeof value !== 'string' || value === '') throw new Error(`${key} is missing.`);
  return value;
}

/** @brief 只能由几个值组成的列表。 */
function listOf<T extends string>(front: Record<string, unknown>, key: string, allowed: readonly T[]): T[] {
  const value = front[key];
  if (!Array.isArray(value) || value.some((item) => !allowed.includes(item as T))) {
    throw new Error(`${key} must be a list of: ${allowed.join(', ')}.`);
  }
  return value as T[];
}

/** @brief counts：缺的计数按 0。 */
function countsOf(value: unknown): RevisionCounts {
  const counts = (value ?? {}) as Record<string, unknown>;
  const count = (key: string) => (typeof counts[key] === 'number' ? (counts[key] as number) : 0);
  return { added: count('added'), changed: count('changed'), deleted: count('deleted'), moved: count('moved') };
}

/** @brief 增强运行的 run；别的修订为 null。 */
function runOf(value: unknown): RevisionRun | null {
  if (value === undefined || value === null) return null;
  const run = value as Record<string, unknown>;
  if (!ENHANCE_TASKS.includes(run.task as EnhanceTask) || typeof run.day !== 'string') {
    throw new Error('run is not valid.');
  }
  const count = (key: string) => (typeof run[key] === 'number' ? (run[key] as number) : 0);
  return { task: run.task as EnhanceTask, day: run.day, tokens: typeof run.tokens === 'number' ? run.tokens : null,
    sessions: count('sessions'), feedback: count('feedback') };
}

/** @brief 修订列表的一行：只来自 frontmatter。 */
function rowOf(front: Record<string, unknown>): RevisionRow {
  return {
    id: requiredText(front, 'id'), time: requiredText(front, 'time'), by: oneOf(front, 'by', BY_VALUES),
    title: requiredText(front, 'title'), status: oneOf(front, 'status', STATUSES),
    layers: listOf(front, 'layers', MEMORY_LAYERS), kinds: listOf(front, 'kinds', MEMORY_KINDS),
    counts: countsOf(front.counts), rollbackOf: typeof front.rollbackOf === 'string' ? front.rollbackOf : null,
  };
}

/**
 * @brief 解析修订列表的一行（§6.5：只读 frontmatter，不读正文）。
 * @param text 修订文件全文，或至少含 frontmatter 结尾行的开头部分
 * @param parseFrontmatter pi 的 parseFrontmatter
 * @throws Error frontmatter 缺字段或取值不对
 */
export function parseRevisionRow(text: string, parseFrontmatter: FrontmatterParser): RevisionRow {
  return rowOf(parseFrontmatter(splitRevision(text).head).frontmatter);
}

/**
 * @brief 标题里的 slug 要能用作文件名（同 isSafeName）：手改或损坏的标题让这次修订读不出来，
 *        回滚与详情不会读写、删到记忆目录以外的文件。
 * @throws Error slug 不能用作文件名
 */
function safeSlug(slug: string, line: string): string {
  if (!isSafeName(slug)) throw new Error(`The slug in “${line}” isn’t a valid file name.`);
  return slug;
}

/**
 * @brief 小节标题 → 改动（还没有前后原文）。不是小节标题时为 null。
 * @param layer 非移动的改动所在的层（修订的 layers：只有移动会改到两层）
 * @throws Error 种类不认识、移动没有目标，或 slug 不能用作文件名
 */
function parseHeading(line: string, layer: MemoryLayer): Omit<RevisionChange, 'before' | 'after'> | null {
  const match = CHANGE_HEADING.exec(line);
  if (!match) return null;
  const kind = KIND_BY_LABEL.get(match[2]);
  if (!kind) throw new Error(`Unknown kind in “${line}”.`);
  const action = ACTION_BY_HEAD.get(match[1]);
  if (action) {
    const place: EntryPlace = { layer, slug: safeSlug(match[3], line) };
    return { action, kind, from: action === 'added' ? null : place, to: action === 'deleted' ? null : { ...place } };
  }
  const to: MemoryLayer = match[1] === MOVE_TEXT.user ? 'user' : 'project';
  const [fromSlug, toSlug] = match[3].split(' → ');
  if (!fromSlug || !toSlug) throw new Error(`The move “${line}” has no target.`);
  return { action: 'moved', kind, from: { layer: to === 'user' ? 'project' : 'user', slug: safeSlug(fromSlug, line) },
    to: { layer: to, slug: safeSlug(toSlug, line) } };
}

/** @brief 逐行读正文的位置。 */
interface Cursor {
  /** 正文按 \n 切开的行 */
  lines: string[];
  /** 下一行的下标 */
  at: number;
}

/**
 * @brief 读一块原文（§3.3）：跳过前面的空行，开头行的波浪号个数就是围栏，只有恰好同样个数的单独一行才结束。
 * @throws Error 没有这一块或没有结尾
 */
function readBlock(cursor: Cursor, label: 'before' | 'after'): string {
  while (cursor.at < cursor.lines.length && cursor.lines[cursor.at] === '') cursor.at += 1;
  const open = /^(~{4,})(before|after)$/.exec(cursor.lines[cursor.at] ?? '');
  if (!open || open[2] !== label) throw new Error(`The ${label} block is missing.`);
  const content: string[] = [];
  for (cursor.at += 1; cursor.at < cursor.lines.length; cursor.at += 1) {
    if (cursor.lines[cursor.at] === open[1]) {
      cursor.at += 1;
      return content.join('\n');
    }
    content.push(cursor.lines[cursor.at]);
  }
  throw new Error(`The ${label} block is not closed.`);
}

/** @brief 读一处改动：标题之后可选的 Evidence、Note 行，再是改动前后两块。 */
function readChange(cursor: Cursor, head: Omit<RevisionChange, 'before' | 'after'>): RevisionChange {
  const change: RevisionChange = { ...head, before: '', after: '' };
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at];
    if (line.startsWith('Evidence: ')) change.evidence = line.slice('Evidence: '.length);
    else if (line.startsWith('Note: ')) change.note = line.slice('Note: '.length);
    else if (line !== '') break;
    cursor.at += 1;
  }
  change.before = readBlock(cursor, 'before');
  change.after = readBlock(cursor, 'after');
  return change;
}

/** @brief 解析修订正文：每处改动一节，`## Notes` 之后到文件末尾是 Notes。 */
function parseRevisionBody(body: string, layer: MemoryLayer): { changes: RevisionChange[]; notes: string | null } {
  const cursor: Cursor = { lines: body.split('\n'), at: 0 };
  const changes: RevisionChange[] = [];
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at];
    cursor.at += 1;
    if (line === NOTES_HEADING) return { changes, notes: cursor.lines.slice(cursor.at).join('\n').replace(/\n$/, '') };
    const head = parseHeading(line, layer);
    if (head) changes.push(readChange(cursor, head));
  }
  return { changes, notes: null };
}

/**
 * @brief 解析一次修订的全文（§3.3）。
 * @param text 修订文件全文
 * @param parseFrontmatter pi 的 parseFrontmatter
 * @throws Error 读不出来的原因
 */
export function parseRevision(text: string, parseFrontmatter: FrontmatterParser): RevisionDetail {
  const { head, body } = splitRevision(text);
  const front = parseFrontmatter(head).frontmatter;
  const row = rowOf(front);
  const parsed = parseRevisionBody(body, row.layers[0] ?? 'project');
  return { ...row, changes: parsed.changes, notes: parsed.notes, run: runOf(front.run),
    cwd: typeof front.cwd === 'string' ? front.cwd : null };
}
