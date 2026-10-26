// 记忆的规则（docs/specs/memory.md §6.3、§6.4、§6.6、§7.4、§9.8、§10.1）：纯函数。
// 预算检查与用量、谁能改什么、memory 工具的条目匹配与字段检查、记忆页表单的句子、增强运行里同一条目的改动合并与计数、
// 回滚的冲突判断、[[slug]] 链接。错误都是给模型或界面看的英文原文，只有原因，不带动词前缀（§8）。

import {
  KIND_LABEL, MEMORY_DEFAULTS, MEMORY_LIMIT, layerUsage, type EnhanceTask, type EntrySource, type MemoryCaller,
  type MemoryKind, type MemoryLayer, type MemoryUsage, type RevisionChange, type RevisionCounts,
} from '../shared/memory';

// ---- 快照与预算（§5.2、§6.3） ----

/** @brief 会话打开时读到的两层四种 abstract（§5.2），按索引顺序，只有读得出来的条目。 */
export interface Snapshot {
  /** 用户级 */
  user: Record<MemoryKind, string[]>;
  /** 本项目；项目目录被别的工作目录占用时四种都为空 */
  project: Record<MemoryKind, string[]>;
}

/** @brief 超出时的原文（§6.3）；没超出时为 null。 */
function exceeded(kind: MemoryKind, user: number, label: string, other: number): string | null {
  if (user + other <= MEMORY_LIMIT) return null;
  return `Over the ${MEMORY_LIMIT}-token limit for ${KIND_LABEL[kind]}: user ${user} + ${label} ${other} = `
    + `${user + other}. Merge or delete entries first.`;
}

/**
 * @brief 预算检查（§6.3），用写入之后的 abstract 算：写本项目时用户级 + 本项目 > 500 拒绝（恰好 500 允许）；
 *        写用户级时对每个有这一种条目的项目（先本项目，再按给出的顺序）检查用户级 + 那个项目，原因写出第一个超出的项目，
 *        另外用户级自己 > 500 也拒绝。
 * @param kind 种类
 * @param target 写入的层
 * @param user 用户级这一种（写入之后）
 * @param project 本项目这一种（写入之后；没有项目时为空）
 * @param others 写用户级时：其他有这一种条目的项目（cwd 与 abstract）；写本项目时不看
 * @return 错误原文；不超出时为 null
 */
export function budgetError(kind: MemoryKind, target: MemoryLayer, user: readonly string[],
  project: readonly string[], others: readonly { cwd: string; abstracts: readonly string[] }[]): string | null {
  const userTokens = layerUsage(user);
  if (target === 'project') return exceeded(kind, userTokens, 'this project', layerUsage(project));
  const projects = [{ label: 'this project', abstracts: project },
    ...others.map((other) => ({ label: `project ${other.cwd}`, abstracts: other.abstracts }))];
  for (const each of projects) {
    if (each.abstracts.length === 0) continue;
    const error = exceeded(kind, userTokens, each.label, layerUsage(each.abstracts));
    if (error) return error;
  }
  if (userTokens <= MEMORY_LIMIT) return null;
  return `Over the ${MEMORY_LIMIT}-token limit for ${KIND_LABEL[kind]}: user ${userTokens}. `
    + 'Merge or delete entries first.';
}

/**
 * @brief 一种的用量（§6.3）：两层分别估算再相加。
 * @param user 用户级这一种的 abstract
 * @param project 本项目这一种的 abstract（看用户级时传空）
 */
export function usageOf(user: readonly string[], project: readonly string[]): MemoryUsage {
  const userTokens = layerUsage(user);
  const projectTokens = layerUsage(project);
  return { used: userTokens + projectTokens, limit: MEMORY_LIMIT, user: userTokens, project: projectTokens };
}

// ---- 谁能改什么（§6.4、§7.4） ----

/** @brief agent 调用方写用户级规则时的原文（§7.4）。 */
export const USER_RULES_REFUSAL = 'TASTE, STRATEGY, and REVIEW are saved to this project; only you can change '
  + 'user-level entries on the Memory page.';

/** @brief 增强改别的种类、别的层时的原文（§7.4）。 */
function otherKindRefusal(task: EnhanceTask): string {
  return `This run maintains this project’s ${KIND_LABEL[task]} entries only.`;
}

/** @brief 增强改你写的条目时的原文（§7.4）。 */
function userEntryRefusal(abstract: string): string {
  return `“${abstract}” is an entry the user wrote; it’s read-only for enhancement. Mention the conflict in your `
    + 'final reply.';
}

/** @brief 增强移的不是 Mori 记的条目时的原文（§7.4、§6.9）。 */
function notAgentRefusal(abstract: string): string {
  return `“${abstract}” wasn’t added by Mori; only entries added by Mori can be moved.`;
}

/** @brief 增强把条目移到它现在的种类时的原文（§7.4、§6.9）。 */
function alreadyRefusal(abstract: string, kind: MemoryKind): string {
  return `“${abstract}” is already in ${KIND_LABEL[kind]}.`;
}

/** @brief 要写的位置（§6.4）。 */
export interface WriteTarget {
  /** 条目所在（新增时写入）的层 */
  layer: MemoryLayer;
  /** 条目现在（新增时写入）的种类 */
  kind: MemoryKind;
  /** 现有条目的来源；新增时为 null */
  source: EntrySource | null;
  /** 现有条目的 abstract（拒绝的原文用） */
  abstract?: string;
  /** 移到另一种时的目标种类（只有增强的 move，§6.9）；别的写入没有 */
  toKind?: MemoryKind;
}

/**
 * @brief 谁能改什么（§6.4）：记忆页与回滚（caller 为 null）两层全部；agent 事实两层、TASTE/STRATEGY/REVIEW 只有本项目；
 *        增强只有本项目这一种的 learned 与 agent 条目，移动时只移本项目的 agent 条目、这次的种类是一端（§6.9）。
 * @param caller memory 工具的调用方；记忆页与回滚为 null
 * @param target 要写的位置
 * @return 拒绝的原文（§7.4）；可以写时为 null
 */
export function writeRefusal(caller: MemoryCaller | null, target: WriteTarget): string | null {
  if (caller === null) return null;
  if (caller.kind === 'agent') return target.layer === 'user' && target.kind !== 'fact' ? USER_RULES_REFUSAL : null;
  const ends = target.toKind === undefined ? [target.kind] : [target.kind, target.toKind];
  if (target.layer !== 'project' || !ends.includes(caller.task)) return otherKindRefusal(caller.task);
  const abstract = target.abstract ?? '';
  if (target.source === 'user') return userEntryRefusal(abstract);
  if (target.toKind === undefined) return null;
  if (target.source !== 'agent') return notAgentRefusal(abstract);
  return target.toKind === target.kind ? alreadyRefusal(abstract, target.kind) : null;
}

/**
 * @brief 写入之后条目的来源（§6.4）：记忆页为 user；增强新增为 learned、修改与移动不变；agent 调用方 asked 为真时为
 *        user，否则 user 条目仍为 user、其余为 agent（2026-10-26，§0 第 5 条）。
 * @param caller memory 工具的调用方；记忆页为 null
 * @param asked agent 调用方：你明确要它记（memory 工具的 asked）；别的写入方不看
 * @param current 现有条目的来源；新增时为 null
 */
export function sourceAfter(caller: MemoryCaller | null, asked: boolean, current: EntrySource | null): EntrySource {
  if (caller === null) return 'user';
  if (caller.kind === 'enhance') return current ?? 'learned';
  return asked || current === 'user' ? 'user' : 'agent';
}

// ---- 条目匹配（§7.4） ----

/** @brief 一条可以被匹配的条目。 */
export interface Candidate {
  /** 所在的层 */
  layer: MemoryLayer;
  /** 种类 */
  kind: MemoryKind;
  /** slug */
  id: string;
  /** 进 prompt 的一行（detail 里的） */
  abstract: string;
  /** 你说的、它学的 */
  source: EntrySource;
}

/**
 * @brief 把两层的全部条目分成调用方能改的范围与范围之外要再找的（§7.4）：agent 的范围是本项目四种与用户级事实，
 *        之外是用户级 TASTE/STRATEGY/REVIEW；增强的范围是本项目这一种（含 user 条目）加上本项目四种里 Mori 记的条目
 *        （移到另一种，§6.9），之外是第一条消息列出的其余条目（两层的 TASTE/STRATEGY/REVIEW 里的其他部分）。
 * @param caller 调用方
 * @param all 两层的全部条目
 */
export function matchScope(caller: MemoryCaller, all: readonly Candidate[]): { candidates: Candidate[];
  others: Candidate[] } {
  const inScope = (item: Candidate) => (caller.kind === 'agent'
    ? item.layer === 'project' || item.kind === 'fact'
    : item.layer === 'project' && (item.kind === caller.task || item.source === 'agent'));
  const listed = (item: Candidate) => caller.kind === 'agent' || item.kind !== 'fact';
  return { candidates: all.filter(inScope), others: all.filter((item) => !inScope(item) && listed(item)) };
}

/** @brief 比较 abstract 的写法：去掉首尾空白，连续空白换成一个空格。 */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** @brief 先按 id 精确匹配，不中时按 abstract 匹配。 */
function findMatches(entry: string, list: readonly Candidate[]): Candidate[] {
  const byId = list.filter((item) => item.id === entry);
  if (byId.length > 0) return byId;
  const wanted = normalizeText(entry);
  return list.filter((item) => normalizeText(item.abstract) === wanted);
}

/** @brief 匹配到多条时的原文：agent 两层各一条时报“两层都匹配”，否则列出全部。 */
function severalError(caller: MemoryCaller, entry: string, found: readonly Candidate[]): string {
  const user = found.find((item) => item.layer === 'user');
  const project = found.find((item) => item.layer === 'project');
  if (caller.kind === 'agent' && found.length === 2 && user && project) {
    return `“${entry}” matches entries in both layers (user: ${user.id}, this project: ${project.id}). Pass layer.`;
  }
  return `“${entry}” matches several entries: ${found.map((item) => `${item.layer}/${item.id}`).join(', ')}. `
    + 'Pass the id and layer.';
}

/** @brief 找不到时的原文：列出调用方能改的条目（增强不列你写的），最多 10 条；没有时写 (none)。 */
function notFoundError(caller: MemoryCaller, entry: string, candidates: readonly Candidate[]): string {
  const changeable = candidates.filter((item) => caller.kind === 'agent' || item.source !== 'user');
  const listed = changeable.slice(0, MEMORY_DEFAULTS.candidatesMax)
    .map((item) => `${item.layer}/${item.id}: ${item.abstract}`);
  return `No entry matches “${entry}”. Entries you can change: ${listed.length > 0 ? listed.join('; ') : '(none)'}`;
}

/**
 * @brief memory 工具的条目匹配（§7.4）：先在调用方能改的范围里找（给了 layer 时只在那一层），id 精确匹配优先，
 *        不中时按 abstract；范围里不中时再在范围之外找，找到报“写用户级规则”或“改别的种类、别的层”；都不中报“找不到”。
 *        增强匹配到你写的条目时照样返回，由 writeRefusal 报那一行。
 * @param caller 调用方
 * @param entry 模型给的 entry（id 或 abstract 原文）
 * @param layer 模型给的 layer（agent 才有）
 * @param candidates 范围里的条目（matchScope）
 * @param others 范围之外要再找的条目（matchScope）
 * @return 匹配到的条目，或错误原文（第一行；Correct form 由工具加）
 */
export function matchEntry(caller: MemoryCaller, entry: string, layer: MemoryLayer | undefined,
  candidates: readonly Candidate[], others: readonly Candidate[]): { match: Candidate } | { error: string } {
  const scope = layer ? candidates.filter((item) => item.layer === layer) : candidates;
  const found = findMatches(entry, scope);
  if (found.length === 1) return { match: found[0] };
  if (found.length > 1) return { error: severalError(caller, entry, found) };
  if (findMatches(entry, others).length > 0) {
    return { error: caller.kind === 'agent' ? USER_RULES_REFUSAL : otherKindRefusal(caller.task) };
  }
  return { error: notFoundError(caller, entry, candidates) };
}

// ---- 字段检查（§7.4、§10.1） ----

/** @brief 按字符（码点）计的长度。 */
function charCount(text: string): number {
  return [...text].length;
}

type ToolAction = 'save' | 'update' | 'forget' | 'move';

/**
 * 每种调用方、每个动作的必填字段（§7.1），按检查的顺序；agent 没有 move（schema 不给）。增强的依据在执行时查，
 * 因为 move 不要依据（2026-10-26，§6.9）
 */
const REQUIRED: Readonly<Record<MemoryCaller['kind'], Readonly<Partial<Record<ToolAction, readonly string[]>>>>> = {
  agent: { save: ['kind', 'abstract', 'quote'], update: ['entry', 'note', 'quote'], forget: ['entry', 'note'] },
  enhance: { save: ['abstract', 'evidence'], update: ['entry', 'note', 'evidence'],
    forget: ['entry', 'note', 'evidence'], move: ['entry', 'kind', 'note'] },
};

/** 各字段的最长字符数（§12） */
const FIELD_MAX: Readonly<Record<string, number>> = {
  abstract: MEMORY_DEFAULTS.abstractMax, detail: MEMORY_DEFAULTS.detailMax, note: MEMORY_DEFAULTS.noteMax,
  quote: MEMORY_DEFAULTS.quoteMax,
};

/**
 * @brief 一个文字字段的长度：必填的写 `1–<max>`，可选的写 `at most <max>`（§7.4）。abstract 不论动作都是 1–200
 *        （§7.1 字段表：一行，1–200 字符）。
 */
function lengthError(field: string, value: unknown, required: boolean): string | null {
  if (typeof value !== 'string') return null;
  const max = FIELD_MAX[field];
  if (required || field === 'abstract') {
    return value.trim() === '' || charCount(value) > max ? `${field} must be 1–${max} characters.` : null;
  }
  return charCount(value) > max ? `${field} must be at most ${max} characters.` : null;
}

/**
 * @brief memory 工具的字段检查（§7.4、§7.1）：先查必填（`<field> is required for <action>.`），增强的 kind 只给 move
 *        （`kind is only for move.`），再查长度与 abstract 一行；增强的每项依据的 quote 不超过 600。
 *        schema 已由 pi 校验（类型、枚举、evidence 的项数）。
 * @param args 归一后的参数
 * @param caller 调用方
 * @return 错误原文（第一行；Correct form 由工具加）；没有问题时为 null
 */
export function toolFieldError(args: Record<string, unknown>, caller: MemoryCaller): string | null {
  const action = args.action as ToolAction;
  const required = REQUIRED[caller.kind][action] ?? [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) return `${field} is required for ${action}.`;
  }
  if (caller.kind === 'enhance' && action !== 'move' && args.kind !== undefined) return 'kind is only for move.';
  for (const field of ['abstract', 'detail', 'note', 'quote']) {
    const error = lengthError(field, args[field], required.includes(field));
    if (error) return error;
  }
  if (typeof args.abstract === 'string' && /[\r\n]/.test(args.abstract)) return 'abstract must be one line.';
  const evidence = Array.isArray(args.evidence) ? (args.evidence as { quote?: unknown }[]) : [];
  for (const item of evidence) {
    const error = lengthError('quote', item?.quote, false);
    if (error) return error;
  }
  return null;
}

/**
 * @brief 记忆页表单的句子（§10.1），内核的 memory.save 按同样的规则查、返回同样的句子。
 * @param abstract 表单的 Abstract
 * @param detail 表单的 Details
 * @return 第一个问题；没有时为 null
 */
export function pageFieldError(abstract: string, detail: string): string | null {
  const grouped = (n: number) => n.toLocaleString('en-US');
  if (abstract.trim() === '') return 'Abstract is required.';
  const { abstractMax, detailMax } = MEMORY_DEFAULTS;
  if (charCount(abstract) > abstractMax) return `Abstract must be at most ${grouped(abstractMax)} characters.`;
  if (charCount(detail) > detailMax) return `Details must be at most ${grouped(detailMax)} characters.`;
  return null;
}

// ---- 增强运行的修订（§9.8） ----

/** 一节 Evidence 行里各项的分界：`; ` 之后是下一项的 `<Mon D> · Session “` 或 `<Mon D> · Feedback` */
const EVIDENCE_SPLIT = /; (?=[A-Z][a-z]{2} \d{1,2} · (?:Session “|Feedback))/;

/** @brief 合并两段 Evidence 行：按写入顺序去重。 */
function joinEvidence(first: string | undefined, next: string | undefined): string | undefined {
  const items = [first, next].flatMap((text) => (text ? text.split(EVIDENCE_SPLIT) : []));
  const unique = [...new Set(items)];
  return unique.length > 0 ? unique.join('; ') : undefined;
}

/** @brief 改动所在的位置（层与 slug）。 */
function placeKey(change: RevisionChange): string {
  const place = change.to ?? change.from;
  return place ? `${place.layer}/${place.slug}` : '';
}

/**
 * @brief 同一条目的两次改动合成一节：before 取第一次之前，after 取最后一次之后；先加后删时为 null。
 *        种类（§6.9）：删除记在运行前的种类；新增、修改记在最后的种类，修改时运行前的种类不同就记下 fromKind。
 */
function combine(first: RevisionChange, next: RevisionChange): RevisionChange | null {
  const { before } = first;
  const { after } = next;
  if (before === '' && after === '') return null;
  const place = (next.to ?? next.from ?? first.to ?? first.from)!;
  const action = before === '' ? 'added' : after === '' ? 'deleted' : 'changed';
  const startKind = first.fromKind ?? first.kind;
  const kind = action === 'deleted' ? startKind : next.kind;
  const merged: RevisionChange = { action, kind, from: action === 'added' ? null : { ...place },
    to: action === 'deleted' ? null : { ...place }, before, after };
  if (action === 'changed' && startKind !== kind) merged.fromKind = startKind;
  const evidence = joinEvidence(first.evidence, next.evidence);
  if (evidence) merged.evidence = evidence;
  const note = next.note ?? first.note;
  if (note) merged.note = note;
  return merged;
}

/**
 * @brief 把一次写入的改动并进增强运行的修订（§9.8）：同一个条目（按层与 slug）只占一节，动作按前后原文定，
 *        Evidence 列出全部依据（按写入顺序去重），Note 取最近的一次（删除原因）；前后都为空（先加后删）的从修订里去掉。
 * @param changes 修订里已有的改动
 * @param change 这次写入的改动
 * @return 新的改动列表；输入不改
 */
export function mergeRunChange(changes: RevisionChange[], change: RevisionChange): RevisionChange[] {
  const index = changes.findIndex((item) => placeKey(item) === placeKey(change));
  if (index < 0) return change.before === '' && change.after === '' ? [...changes] : [...changes, change];
  const merged = combine(changes[index], change);
  return merged ? changes.map((item, at) => (at === index ? merged : item))
    : changes.filter((_, at) => at !== index);
}

/** @brief 修订的计数（§3.3）：按每节的动作，移动计入 moved。 */
export function countChanges(changes: readonly RevisionChange[]): RevisionCounts {
  const counts: RevisionCounts = { added: 0, changed: 0, deleted: 0, moved: 0 };
  for (const change of changes) counts[change.action] += 1;
  return counts;
}

// ---- 回滚与链接（§6.6、§6.8） ----

/**
 * @brief 回滚的冲突判断（§6.6）：条目现在的整个文件不等于这处改动的 after（之后又被改过）就是冲突。
 * @param change 修订里的一处改动
 * @param current after 所在位置现在的文件原文；文件不存在时为 null
 */
export function rollbackConflict(change: RevisionChange, current: string | null): boolean {
  return (current ?? '') !== change.after;
}

/** [[slug]] 链接 */
const LINK = /\[\[([^[\]\r\n]+)\]\]/g;

/** @brief detail 正文里的 `[[slug]]`（§3.2、§6.8），去重，按出现的顺序。 */
export function backlinkSlugs(details: string): string[] {
  return [...new Set([...details.matchAll(LINK)].map((match) => match[1].trim()))];
}
