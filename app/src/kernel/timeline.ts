// 快照模块的纯函数（docs/specs/file-system.md §3.5、§4.3、§4.5、§4.7、§5.3、§5.6，后台进程第 9 件事“工作区”）：
// git status 的 porcelain v2 解析、内部仓库 info/exclude 的生成与转义、diff --raw --numstat 与 ls-tree 的解析、
// 时间线的状态与一段的归属（段记给谁、记进哪一轮、run 记录、下一段的开始）、你的消息与 Turn 编号、
// mori.turn_changes 记录的读取与保留时要删的轮、Rewind 的文件集合与冲突。
// 这里不读写文件、不调 git、不碰 pi 的运行时：会话条目由调用方读出来（SessionManager 的 getEntries、getLeafId）传进来，
// 单元测试直接喂数据（§19.1）。快照作业、队列与 git 调用在 snapshots.ts，恢复在 rewind.ts。

import { createHash } from 'node:crypto';
import { TEAM_ENTRY_TYPES, WakeEntrySchema } from '../shared/team';
import {
  CHANGES_FILE_LIMIT, RewindRecordSchema, TurnChangesSchema, WORKSPACE_ENTRY_TYPES,
  type ChangedFile, type ChangesRecord, type RewindConflict, type RunAgent, type RunRecord, type StatusFile,
  type TurnChanges, type WorkspaceStatus,
} from '../shared/workspace';

// ---- 会话条目与你的消息（§4.5、§5.3） ----

/** @brief 时间线用到的会话条目字段：pi 的 SessionEntry 在结构上满足它，单元测试直接喂对象。 */
export interface TimelineEntry {
  /** 条目种类（message、custom、custom_message …） */
  type: string;
  /** 条目 id */
  id: string;
  /** 父条目 id；根为 null */
  parentId: string | null;
  /** message 条目的消息（只用到 role） */
  message?: { role?: string };
  /** custom、custom_message 条目的种类 */
  customType?: string;
  /** custom 条目的内容 */
  data?: unknown;
}

/** @brief 是不是 role 为 user 的消息条目（你的消息或程序投递的 [Mori] 消息）。 */
export function isUserMessage(entry: TimelineEntry): boolean {
  return entry.type === 'message' && entry.message?.role === 'user';
}

/**
 * @brief mori.wake 条目指向的消息 id（程序投递的 [Mori] 消息，平行 Agent 规格 §5.6）；不合格的 mori.wake 跳过。
 * @param entries 会话条目（通常是全部条目：投递消息的 mori.wake 写在它之后）
 */
export function wakeTargets(entries: readonly TimelineEntry[]): Set<string> {
  const targets = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== TEAM_ENTRY_TYPES.wake) continue;
    const parsed = WakeEntrySchema.safeParse(entry.data);
    if (parsed.success) targets.add(parsed.data.messageId);
  }
  return targets;
}

/** @brief 你的消息（§4.5）：role 为 user 的消息条目，且没有 mori.wake 指向它。 */
export function isYourMessage(entry: TimelineEntry, wakes: ReadonlySet<string>): boolean {
  return isUserMessage(entry) && !wakes.has(entry.id);
}

/** @brief 按 id 索引条目。 */
export function indexEntries(entries: readonly TimelineEntry[]): Map<string, TimelineEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/**
 * @brief 从根到这个条目的路径（同 pi 的 getBranch(id)）；id 为 null 或找不到时为空。
 * @param index indexEntries 的结果
 * @param id 末端条目
 */
export function pathTo(index: ReadonlyMap<string, TimelineEntry>, id: string | null): TimelineEntry[] {
  const path: TimelineEntry[] = [];
  const seen = new Set<string>();
  let at = id === null ? undefined : index.get(id);
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.push(at);
    at = at.parentId === null ? undefined : index.get(at.parentId);
  }
  return path.reverse();
}

/**
 * @brief 每条你的消息在这条分支上是第几轮（§5.3 的 Turn <n>，从 1 起；[Mori] 投递不算）。界面的 turnNumbers 用同一规则。
 * @param branch 当前分支的条目（从根到叶子）
 */
export function turnNumbers(branch: readonly TimelineEntry[]): Map<string, number> {
  const wakes = wakeTargets(branch);
  const turns = new Map<string, number>();
  for (const entry of branch) if (isYourMessage(entry, wakes)) turns.set(entry.id, turns.size + 1);
  return turns;
}

/**
 * @brief 分支上 leaf 之后的第一条 role 为 user 的消息条目（一次运行的起始消息，§4.5）。
 * @param branch 当前分支（从根到叶子）
 * @param leaf 运行开始时的叶子；null 为会话开头
 * @return 找不到（还没写下，或 leaf 不在这条分支上）时为 undefined
 */
export function startMessage(branch: readonly TimelineEntry[], leaf: string | null): TimelineEntry | undefined {
  const at = leaf === null ? -1 : branch.findIndex((entry) => entry.id === leaf);
  if (leaf !== null && at < 0) return undefined;
  return branch.slice(at + 1).find(isUserMessage);
}

// ---- git status（porcelain v2，§3.5） ----

/** @brief parsePorcelainV2 的结果：WorkspaceStatus 里来自 git status 的部分。 */
export type PorcelainStatus = Pick<WorkspaceStatus, 'branch' | 'files' | 'total' | 'truncated'>;

/** @brief # branch.* 行读到的值。 */
interface BranchLines {
  /** 读到过至少一行 # branch.* */
  seen: boolean;
  /** 当前提交（# branch.oid）；(initial)（还没有提交）为 null */
  oid: string | null;
  /** 分支名（# branch.head）；(detached)（分离的 HEAD）为 null */
  head: string | null;
  /** 上游（# branch.upstream）；没有上游为 null */
  upstream: string | null;
  /** 领先、落后（# branch.ab）；没有这一行（没有上游或上游已不在）为 null */
  ab: [number, number] | null;
}

/** @brief 读一行 # branch.*（其他 # 行忽略）。 */
function readBranchLine(line: string, into: BranchLines): void {
  const match = /^# branch\.(oid|head|upstream|ab) ([\s\S]*)$/.exec(line);
  if (!match) return;
  into.seen = true;
  const value = match[2];
  if (match[1] === 'oid') into.oid = value === '(initial)' ? null : value;
  else if (match[1] === 'head') into.head = value === '(detached)' ? null : value;
  else if (match[1] === 'upstream') into.upstream = value;
  else {
    const ab = /^\+(\d+) -(\d+)$/.exec(value);
    if (ab) into.ab = [Number(ab[1]), Number(ab[2])];
  }
}

/** @brief 分支信息：没有 # branch 行时为 null；有上游却没有 branch.ab（上游已不在）时领先、落后为 null。 */
function branchOf(lines: BranchLines): WorkspaceStatus['branch'] {
  if (!lines.seen) return null;
  const ab = lines.upstream !== null ? lines.ab : null;
  return {
    head: lines.head, oid: lines.oid, upstream: lines.upstream, ahead: ab?.[0] ?? null, behind: ab?.[1] ?? null,
  };
}

/** @brief 跳过前 count 个以空格分隔的字段，返回其余部分（路径里可以有空格）；字段不够时为 null。 */
function afterFields(line: string, count: number): string | null {
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    at = line.indexOf(' ', at);
    if (at < 0) return null;
    at += 1;
  }
  return line.slice(at);
}

/** @brief 1、2 行的 XY：X 不是 . 为暂存一条（code = X），Y 不是 . 为未暂存一条（code = Y）。 */
function xyFiles(xy: string, path: string | null, from: string | null): StatusFile[] {
  if (path === null || xy.length !== 2) return [];
  const files: StatusFile[] = [];
  if (xy[0] !== '.') files.push({ path, from, group: 'staged', code: xy[0] });
  if (xy[1] !== '.') files.push({ path, from, group: 'unstaged', code: xy[1] });
  return files;
}

/**
 * @brief 一条文件记录（§3.5 的表）变成 0–2 个 StatusFile。
 * @param records 全部记录（NUL 分隔）
 * @param i 这一条的下标
 * @return 文件与下一条的下标（2 行的原路径占一条）
 */
function fileRecord(records: readonly string[], i: number): { files: StatusFile[]; next: number } {
  const line = records[i];
  const xy = line.slice(2, 4);
  switch (line.slice(0, 2)) {
    case '1 ': return { files: xyFiles(xy, afterFields(line, 8), null), next: i + 1 };
    case '2 ': {
      const from = records[i + 1];
      return { files: from === undefined ? [] : xyFiles(xy, afterFields(line, 9), from), next: i + 2 };
    }
    case 'u ': {
      const path = afterFields(line, 10);
      return { files: path === null ? [] : [{ path, from: null, group: 'conflicted', code: 'U' }], next: i + 1 };
    }
    case '? ': return { files: [{ path: line.slice(2), from: null, group: 'untracked', code: '?' }], next: i + 1 };
    default: return { files: [], next: i + 1 };
  }
}

/**
 * @brief 解析 git status --porcelain=v2 --branch -z（§3.5）：路径相对仓库根、/ 分隔，原样保留。
 *        输出不以 NUL 结尾（被 stdout 上限截断）时只解析到最后一个完整的 NUL，truncated 为真、total 为已解析的条数。
 * @param stdout git 的输出
 * @param limit files 最多留几条（STATUS_FILE_LIMIT）
 */
export function parsePorcelainV2(stdout: Buffer, limit: number): PorcelainStatus {
  const end = stdout.lastIndexOf(0);
  const truncated = stdout.length > 0 && end !== stdout.length - 1;
  const records = end < 0 ? [] : stdout.subarray(0, end).toString('utf8').split('\0');
  const lines: BranchLines = { seen: false, oid: null, head: null, upstream: null, ab: null };
  const files: StatusFile[] = [];
  let total = 0;
  for (let i = 0; i < records.length;) {
    if (records[i].startsWith('# ')) {
      readBranchLine(records[i], lines);
      i += 1;
      continue;
    }
    const record = fileRecord(records, i);
    for (const file of record.files) {
      total += 1;
      if (files.length < limit) files.push(file);
    }
    i = record.next;
  }
  return { branch: branchOf(lines), files, total, truncated };
}

// ---- 内部仓库的 info/exclude（§4.3） ----

/** @brief 总是排除的（只在工作路径根）。 */
export const ALWAYS_EXCLUDED: readonly string[] = Object.freeze(['/.work/', '/.mori/worktrees/']);

/** @brief 不是 git 仓库时默认排除的目录（任何一层，proposal §13 第 14 条）。 */
export const NON_REPO_EXCLUDED: readonly string[] = Object.freeze(['node_modules/', '.venv/', 'dist/', 'build/',
  'target/']);

/**
 * @brief 你的 git 列出的一条被忽略的路径写成内部仓库 info/exclude 的一行锚定规则（§4.3）：前面加 /，目录保留结尾的 /；
 *        \、*、?、[ 前加 \ 转义（行首是 /，所以 ! 与 # 不会在行首，不用转义）；结尾的每个空格写成 \ ；
 *        整个工作路径被忽略时（./）写成 /*。
 * @param path ls-files 给的路径（相对工作路径，/ 分隔）
 */
export function excludeLine(path: string): string {
  if (path === './') return '/*';
  const escaped = path.replace(/[\\*?[]/g, (char) => `\\${char}`);
  const body = escaped.replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length));
  return `/${body}`;
}

/**
 * @brief 内部仓库 info/exclude 的全文（§4.3），每次拍快照前生成。
 * @param ignored 是 git 仓库时你的 git 列出的被忽略的路径（ls-files --others --ignored --exclude-standard --directory）；
 *        不是 git 仓库时为 null
 */
export function excludeText(ignored: readonly string[] | null): string {
  const rules = ignored === null ? NON_REPO_EXCLUDED : ignored.filter((path) => path !== '').map(excludeLine);
  return `${[...ALWAYS_EXCLUDED, ...rules].join('\n')}\n`;
}

// ---- git 输出的解析（§4.4、§4.5、§5.6） ----

/**
 * @brief NUL 分隔的列表（ls-files -z、diff --name-only -z、ls-tree --name-only -z）：只取到最后一个完整的 NUL，去掉空项。
 * @param stdout git 的输出
 */
export function nulList(stdout: Buffer): string[] {
  const end = stdout.lastIndexOf(0);
  if (end < 0) return [];
  return stdout.subarray(0, end).toString('utf8').split('\0').filter((item) => item !== '');
}

/** @brief 不进记录的 mode：gitlink（嵌套仓库）与符号链接（§4.2）。 */
const UNLISTED_MODES = new Set(['160000', '120000']);

/** @brief --raw 的一条：两边的 mode 与状态字母。 */
interface RawItem {
  /** 旧的一边的 mode（新增的为 000000） */
  srcMode: string;
  /** 新的一边的 mode（删除的为 000000） */
  dstMode: string;
  /** 状态字母（A、M、D、T …） */
  status: string;
}

/**
 * @brief 解析 git diff --no-renames --raw --numstat -z（§4.5 第 2 步：先是全部 raw 记录，再是全部 numstat 记录）。
 *        mode 160000、120000 的去掉；状态取 raw 的 A、M、D（T 等其余记为 M）；行数取 numstat，二进制（- -）为 null。
 * @param stdout git 的输出
 * @return 改动的文件，按路径排序（全部，不截断）
 */
export function parseRawNumstat(stdout: Buffer): ChangedFile[] {
  const tokens = nulList(stdout);
  const raw = new Map<string, RawItem>();
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith(':')) {
      const [srcMode, dstMode, , , status] = token.slice(1).split(' ');
      const path = tokens[i + 1];
      if (path !== undefined && status !== undefined) raw.set(path, { srcMode, dstMode, status });
      i += 1;
      continue;
    }
    const numstat = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(token);
    if (!numstat) continue;
    counts.set(numstat[3], { added: numstat[1] === '-' ? null : Number(numstat[1]),
      removed: numstat[2] === '-' ? null : Number(numstat[2]) });
  }
  const files: ChangedFile[] = [];
  for (const [path, item] of raw) {
    if (UNLISTED_MODES.has(item.srcMode) || UNLISTED_MODES.has(item.dstMode)) continue;
    const status = item.status[0] === 'A' || item.status[0] === 'D' ? item.status[0] : 'M';
    const count = counts.get(path) ?? { added: null, removed: null };
    files.push({ path, status, added: count.added, removed: count.removed });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * @brief ls-tree -r -z <树> 里 mode 160000 的条目（工作路径里嵌套的 git 仓库，§4.4 第 7 步），按树里的顺序。
 * @param stdout git 的输出（每条为 "<mode> <type> <object>\t<path>"）
 */
export function parseGitlinks(stdout: Buffer): string[] {
  const links: string[] = [];
  for (const item of nulList(stdout)) {
    const tab = item.indexOf('\t');
    if (tab > 0 && item.startsWith('160000 ')) links.push(item.slice(tab + 1));
  }
  return links;
}

/**
 * @brief 把路径分成几批作命令行参数（§3.3：ls-files 不认 --pathspec-from-file，每批命令行不超过 maxChars 字符）。
 * @param paths 路径
 * @param maxChars 每批路径的总字符数上限（含分隔的空格）
 */
export function argBatches(paths: readonly string[], maxChars: number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const path of paths) {
    if (batch.length > 0 && size + path.length + 1 > maxChars) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(path);
    size += path.length + 1;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// ---- 时间线（§4.5） ----

/** @brief 一张快照：提交与树。 */
export interface Snap {
  /** 快照的提交（内部仓库里的 commit-tree 结果） */
  oid: string;
  /** 这个提交的树（write-tree 结果）：树相同即工作路径的内容没变 */
  tree: string;
}

/** @brief 一个用户会话这一段开始时的情况（段的归属用）。 */
export interface OpenMark {
  /** 段开始时它的叶子 */
  leaf: string | null;
  /** 段开始那张是它自己由 user 消息开始的运行的开始 */
  own: boolean;
}

/** @brief 一次运行（§4.5）。 */
export interface ActiveRun {
  /** 所属的用户会话（实例为它的 owner） */
  user: string;
  /** 标出的 Agent：用户会话自己的运行 self 为真、role 为持有对话的角色；实例为它的角色与 task */
  agent: RunAgent;
  /** 用户会话自己的运行：开始快照（没拍成为 null）、开始时的叶子、是否由 user 消息开始；实例为 null */
  own: { start: string | null; leaf: string | null; byUser: boolean } | null;
}

/**
 * @brief 一段找不到轮、先留着的 changes 记录（§4.5“一段的轮”，2026-10-27 注）：协作模式分开时立项在对话写下你的消息
 *        之前就派出 task，会话里还没有你的消息时 task 的改动记进之后写下的第一条你的消息。
 */
export interface HeldChanges {
  /** 这一段开始时这个会话的叶子：它之后写下的第一条你的消息是这一段的轮 */
  leaf: string | null;
  /** 记录（解析出轮时填上 round） */
  record: Omit<ChangesRecord, 'round'>;
}

/** @brief 一个工作路径的时间线（只在内存里）。 */
export interface Timeline {
  /** 上一张快照；还没有、失败或暂停后为 null */
  last: Snap | null;
  /** 正在运行的：每次运行一项（键为 pi 会话 id），在它的开始快照之后、结束快照之前 */
  active: Map<string, ActiveRun>;
  /** 每个有运行在进行的用户会话：这一段开始时的情况 */
  open: Map<string, OpenMark>;
  /** 每个用户会话找不到轮、先留着的段（按先后），写下你的消息后记进它 */
  held: Map<string, HeldChanges[]>;
}

/** @brief 新的时间线：没有上一张，没人在运行。 */
export function emptyTimeline(): Timeline {
  return { last: null, active: new Map(), open: new Map(), held: new Map() };
}

/** @brief 一个用户会话在段结束时的样子（调用方从它的 SessionManager 读出）。 */
export interface UserView {
  /** 现在的叶子 */
  leaf: string | null;
  /** 全部条目（文件里的顺序） */
  entries: readonly TimelineEntry[];
}

/**
 * @brief 这一张之前的一段要不要算（§4.5 第 1 步）：有上一张、树变了、有人在运行时为这一段的起点（上一张的提交），否则 null。
 * @param timeline 时间线（这一张之前）
 * @param snap 这一张
 */
export function segmentBase(timeline: Timeline, snap: Snap): string | null {
  const last = timeline.last;
  if (last === null || last.tree === snap.tree || timeline.active.size === 0) return null;
  return last.oid;
}

/** @brief 同一个 Agent（角色、task、self 都相同）。 */
function sameAgent(a: RunAgent, b: RunAgent): boolean {
  return a.role === b.role && a.task === b.task && a.self === b.self;
}

/**
 * @brief 一段涉及的用户会话与各自在跑的 Agent（§4.5 第 3 步）：同一个会话不论有几个运行都只记一次，按运行登记的先后。
 * @param active 正在运行的
 */
export function segmentShares(active: ReadonlyMap<string, ActiveRun>): Map<string, RunAgent[]> {
  const shares = new Map<string, RunAgent[]>();
  for (const run of active.values()) {
    const agents = shares.get(run.user) ?? [];
    if (!agents.some((agent) => sameAgent(agent, run.agent))) agents.push({ ...run.agent });
    shares.set(run.user, agents);
  }
  return shares;
}

/** @brief 从一个条目往回找到的第一条你的消息（含它自己）；找不到为 null。 */
function latestYourMessage(path: readonly TimelineEntry[], wakes: ReadonlySet<string>): string | null {
  for (let i = path.length - 1; i >= 0; i -= 1) if (isYourMessage(path[i], wakes)) return path[i].id;
  return null;
}

/**
 * @brief 一段记进哪一轮（§4.5“一段的轮”）：段开始那张是这个会话自己由 user 消息开始的运行的开始时，为这次运行的起始消息
 *        （当前分支上 open.leaf 之后第一条 role 为 user 的消息，且是你的消息）；其他情况、起始消息不在或是程序投递时，
 *        为从 open.leaf 往回找到的第一条你的消息。
 * @param view 这个会话现在的样子
 * @param open 这一段开始时的情况；没有时按“现在的叶子、不是自己的开始”
 * @return 轮（你的一条消息的条目 id）；会话里还没有你的消息时为 null（这一段不记给它）
 */
export function segmentRound(view: UserView, open: OpenMark | undefined): string | null {
  const mark = open ?? { leaf: view.leaf, own: false };
  const index = indexEntries(view.entries);
  const wakes = wakeTargets(view.entries);
  if (mark.own) {
    const first = startMessage(pathTo(index, view.leaf), mark.leaf);
    if (first && !wakes.has(first.id)) return first.id;
  }
  return latestYourMessage(pathTo(index, mark.leaf), wakes);
}

/**
 * @brief 用户会话自己的一次运行的起始消息（run 记录的轮，§4.5“运行记录”）：由 user 消息开始、起始消息已写下且是你的消息。
 * @param view 这个会话现在的样子
 * @param own 这次运行的 own
 * @return 起始消息的条目 id；不写 run 记录时为 null
 */
export function runRound(view: UserView, own: NonNullable<ActiveRun['own']>): string | null {
  if (!own.byUser) return null;
  const first = startMessage(pathTo(indexEntries(view.entries), view.leaf), own.leaf);
  if (!first || wakeTargets(view.entries).has(first.id)) return null;
  return first.id;
}

/**
 * @brief 一个还在运行的用户会话的新一段的开始（§4.5 第 4 步）。例外：它自己由 user 消息开始的运行在进行、起始消息还没写下
 *        （当前分支上 own.leaf 之后还没有 role 为 user 的消息条目）时记 { leaf: own.leaf, own: true }，这一段仍归起始消息。
 * @param view 这个会话现在的样子
 * @param ownRun 它自己的、由 user 消息开始的运行（在进行时）
 * @param startedOwn 这一张是它自己由 user 消息开始的运行的开始
 */
export function nextOpen(view: UserView, ownRun: ActiveRun | undefined, startedOwn: boolean): OpenMark {
  const own = ownRun?.own;
  if (!startedOwn && own?.byUser) {
    const branch = pathTo(indexEntries(view.entries), view.leaf);
    if (startMessage(branch, own.leaf) === undefined) return { leaf: own.leaf, own: true };
  }
  return { leaf: view.leaf, own: startedOwn };
}

/** @brief closeSegment 的输入：一张快照做完（或没拍成）时的全部情况。 */
export interface CloseInput {
  /** 这一张之前的时间线（不改它） */
  timeline: Timeline;
  /** 这一张；没拍成（失败、暂停、off）为 null */
  snap: Snap | null;
  /** 这一段改动的文件（segmentBase 不为 null 时由调用方 diff 得到、已去掉恢复集合）；不算这一段时为 null */
  files: readonly ChangedFile[] | null;
  /** 这一张是谁的开始：pi 会话 id 与这次运行（own.start 已填好） */
  start: { key: string; run: ActiveRun } | null;
  /** 这一张是谁的结束：pi 会话 id */
  end: string | null;
  /** 涉及的用户会话现在的样子（段里在运行的、开始的、结束的） */
  views: ReadonlyMap<string, UserView>;
  /** 这一刻包含这个工作路径或在它里面的别的工作路径上有运行（§4.5 第 3 步，调用方用 insideDir 比） */
  nested: boolean;
  /** 写记录的时刻（ms） */
  at: number;
}

/** @brief closeSegment 的结果：新的时间线与要写的记录（每条记录写进 user 这个用户会话）。 */
export interface CloseResult {
  /** 这一张之后的时间线 */
  timeline: Timeline;
  /**
   * changes 记录：先是先留着、这时写下了你的消息的段（按先后），再是之前那一段涉及的每个用户会话各一条
   * （没有文件改动、会话里还没有你的消息时没有）
   */
  changes: { user: string; record: ChangesRecord }[];
  /** 这一张结束的运行的 run 记录；不写时为 null */
  run: { user: string; record: RunRecord } | null;
}

/** @brief 一段的记录：能定下轮的，与会话里还没有你的消息、先留着的（各带会话 id）。 */
interface SegmentRecords {
  /** 定下轮的记录 */
  changes: CloseResult['changes'];
  /** 先留着的段 */
  held: { user: string; item: HeldChanges }[];
}

/**
 * @brief 一段的 changes 记录（§4.5 第 3 步、§4.6）：涉及的每个用户会话各一条；没有文件改动时不记。会话读不出时不记；
 *        读得出、但这一段开始时会话里还没有你的消息时先留着（HeldChanges），之后写下的第一条你的消息是它的轮。
 */
function segmentRecords(input: CloseInput, base: string, head: string): SegmentRecords {
  const result: SegmentRecords = { changes: [], held: [] };
  const files = input.files ?? [];
  if (files.length === 0) return result;
  const shares = segmentShares(input.timeline.active);
  const overlap = shares.size > 1 || input.nested;
  for (const [user, agents] of shares) {
    const view = input.views.get(user);
    if (!view) continue;
    const open = input.timeline.open.get(user);
    const record = { v: 1 as const, kind: 'changes' as const, base, head,
      files: files.slice(0, CHANGES_FILE_LIMIT).map((file) => ({ ...file })), total: files.length, agents, overlap,
      at: input.at };
    const round = segmentRound(view, open);
    if (round !== null) result.changes.push({ user, record: withRound(record, round) });
    else result.held.push({ user, item: { leaf: open?.leaf ?? view.leaf, record } });
  }
  return result;
}

/** @brief 填上轮的 changes 记录（字段顺序同 ChangesRecord）。 */
function withRound(record: Omit<ChangesRecord, 'round'>, round: string): ChangesRecord {
  const { v, kind, ...rest } = record;
  return { v, kind, round, ...rest };
}

/**
 * @brief 分支上 leaf 之后的第一条你的消息（先留着的段的轮）。
 * @return 条目 id；还没写下时为 null；leaf 不在这条分支上（对话已恢复到它之前）时为 undefined
 */
function nextYourMessage(view: UserView, leaf: string | null): string | null | undefined {
  const branch = pathTo(indexEntries(view.entries), view.leaf);
  const at = leaf === null ? -1 : branch.findIndex((entry) => entry.id === leaf);
  if (leaf !== null && at < 0) return undefined;
  const wakes = wakeTargets(view.entries);
  return branch.slice(at + 1).find((entry) => isYourMessage(entry, wakes))?.id ?? null;
}

/**
 * @brief 先留着的段（含这一段刚留下的）里，会话读得出、之后已写下你的消息的写成记录；leaf 已不在当前分支上的丢掉；
 *        其余继续留着。不改输入。
 * @param held 每个用户会话先留着的段（按先后）
 * @param views 涉及的用户会话现在的样子
 */
function releaseHeld(held: ReadonlyMap<string, readonly HeldChanges[]>, views: ReadonlyMap<string, UserView>):
  { changes: CloseResult['changes']; held: Map<string, HeldChanges[]> } {
  const changes: CloseResult['changes'] = [];
  const kept = new Map<string, HeldChanges[]>();
  for (const [user, items] of held) {
    const view = views.get(user);
    const left = items.filter((item) => {
      const round = view ? nextYourMessage(view, item.leaf) : null;
      if (round) changes.push({ user, record: withRound(item.record, round) });
      return round === null;
    });
    if (left.length > 0) kept.set(user, left);
  }
  return { changes, held: kept };
}

/** @brief 结束的运行的 run 记录（§4.5“运行记录”）：用户会话自己的、由你的消息开始、开始快照拍成了的才写。 */
function endRecord(input: CloseInput, ending: ActiveRun | undefined): CloseResult['run'] {
  const own = ending?.own;
  if (!ending || !own || own.start === null) return null;
  const view = input.views.get(ending.user);
  const round = view ? runRound(view, own) : null;
  if (round === null) return null;
  return { user: ending.user, record: { v: 1, kind: 'run', round, start: own.start, end: input.snap?.oid ?? null,
    at: input.at } };
}

/**
 * @brief 一张快照做完后的段与时间线（§4.5“一张快照做完后”第 1–5 步）：之前那一段记给当时在运行的用户会话
 *        （会话里还没有你的消息时先留着，连同之前留着的、这时已写下你的消息的一起记下）；这一张是谁的开始就加进 active、
 *        是谁的结束就去掉（并给出 run 记录）；给每个还在运行的用户会话记下新一段的开始；last 换成这一张（没拍成时清空）。
 *        不改输入。
 * @param input 这一张的情况
 */
export function closeSegment(input: CloseInput): CloseResult {
  const before = input.timeline;
  const base = input.snap ? segmentBase(before, input.snap) : null;
  const segment = base !== null && input.snap ? segmentRecords(input, base, input.snap.oid) : null;
  const pending = new Map([...before.held].map(([user, items]) => [user, [...items]]));
  for (const { user, item } of segment?.held ?? []) pending.set(user, [...(pending.get(user) ?? []), item]);
  const released = releaseHeld(pending, input.views);
  // 同一个会话这一段要么定下了轮、要么留着：先留着的（更早的段）排在这一段的记录前面
  const changes = [...released.changes, ...(segment?.changes ?? [])];
  const active = new Map(before.active);
  const ending = input.end === null ? undefined : active.get(input.end);
  if (input.end !== null) active.delete(input.end);
  const run = endRecord(input, ending);
  if (input.start) active.set(input.start.key, input.start.run);
  const open = new Map<string, OpenMark>();
  for (const user of new Set([...active.values()].map((item) => item.user))) {
    const view = input.views.get(user);
    const ownRun = [...active.values()].find((item) => item.user === user && item.own?.byUser);
    const startedOwn = input.start?.run.user === user && input.start.run.own?.byUser === true;
    if (view) open.set(user, nextOpen(view, ownRun, startedOwn));
    else if (before.open.has(user)) open.set(user, before.open.get(user) as OpenMark);
  }
  return { timeline: { last: input.snap, active, open, held: released.held }, changes, run };
}

/**
 * @brief 去掉一次没开始的运行（§4.5：before_agent_start 之后 pi 没有开始运行）：从 active 里去掉；
 *        这个会话没有别的运行时一并去掉它的 open。不改输入。
 * @param timeline 时间线
 * @param key 运行的 pi 会话 id
 */
export function withoutRun(timeline: Timeline, key: string): Timeline {
  const run = timeline.active.get(key);
  if (!run) return timeline;
  const active = new Map(timeline.active);
  active.delete(key);
  const open = new Map(timeline.open);
  if (![...active.values()].some((item) => item.user === run.user)) open.delete(run.user);
  return { last: timeline.last, active, open, held: timeline.held };
}

// ---- mori.turn_changes 记录与保留（§4.6、§4.7） ----

/** @brief 会话文件里的一条 mori.turn_changes。 */
export interface TurnEntry {
  /** 条目 id */
  id: string;
  /** 条目内容（已按 TurnChangesSchema 校验） */
  record: TurnChanges;
}

/**
 * @brief 条目里合格的 mori.turn_changes（按条目的顺序）；不合格的跳过并交给 onInvalid（调用方记日志）。
 * @param entries 会话条目（当前分支或全部）
 * @param onInvalid 不合格条目的 id
 */
export function turnEntries(entries: readonly TimelineEntry[], onInvalid?: (id: string) => void): TurnEntry[] {
  const found: TurnEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== WORKSPACE_ENTRY_TYPES.turnChanges) continue;
    const parsed = TurnChangesSchema.safeParse(entry.data);
    if (parsed.success) found.push({ id: entry.id, record: parsed.data });
    else onInvalid?.(entry.id);
  }
  return found;
}

/**
 * @brief 这个会话最近一张快照 L（§5.6 第 4 步）：会话文件里按先后最后一个不为 null 的 run.end、changes.head、mori.rewind 的 post。
 * @param entries 全部条目（文件里的顺序）
 * @return 提交；还没有时为 null
 */
export function lastSnapshotOf(entries: readonly TimelineEntry[]): string | null {
  let last: string | null = null;
  for (const entry of entries) {
    if (entry.type !== 'custom') continue;
    if (entry.customType === WORKSPACE_ENTRY_TYPES.turnChanges) {
      const parsed = TurnChangesSchema.safeParse(entry.data);
      if (!parsed.success) continue;
      const commit = parsed.data.kind === 'run' ? parsed.data.end : parsed.data.head;
      if (commit !== null) last = commit;
    } else if (entry.customType === WORKSPACE_ENTRY_TYPES.rewind) {
      const parsed = RewindRecordSchema.safeParse(entry.data);
      if (parsed.success && parsed.data.post !== null) last = parsed.data.post;
    }
  }
  return last;
}

/**
 * @brief 保留时要删 ref 的轮（§4.7）：按会话文件里 mori.turn_changes 出现的先后列出不同的 round（所有分支），
 *        多于 keep 个时为最早的那些。
 * @param entries 全部条目（文件里的顺序）
 * @param keep 保留的轮数
 */
export function roundsToDrop(entries: readonly TimelineEntry[], keep: number): string[] {
  const rounds: string[] = [];
  const seen = new Set<string>();
  for (const { record } of turnEntries(entries)) {
    if (seen.has(record.round)) continue;
    seen.add(record.round);
    rounds.push(record.round);
  }
  return rounds.length > keep ? rounds.slice(0, rounds.length - keep) : [];
}

// ---- Rewind 的文件集合与冲突（§5.6、§5.7、§5.9） ----

/**
 * @brief 从 M 起（含 M）当前分支上你的消息的 id（Rewind 的“M 或 M 之后的你的消息”）。
 * @param branch 当前分支（从根到叶子）
 * @param entryId M 的条目 id
 * @return M 不在当前分支上、或不是你的消息时为 null
 */
export function roundsFrom(branch: readonly TimelineEntry[], entryId: string): Set<string> | null {
  const at = branch.findIndex((entry) => entry.id === entryId);
  const wakes = wakeTargets(branch);
  if (at < 0 || !isYourMessage(branch[at], wakes)) return null;
  const rounds = new Set<string>();
  for (const entry of branch.slice(at)) if (isYourMessage(entry, wakes)) rounds.add(entry.id);
  return rounds;
}

/** @brief 当前分支上属于这些轮的 changes 记录。 */
function roundChanges(records: readonly TurnEntry[], rounds: ReadonlySet<string>): ChangesRecord[] {
  return records.flatMap(({ record }) => (record.kind === 'changes' && rounds.has(record.round) ? [record] : []));
}

/**
 * @brief 文件集合 F（§5.6 第 3 步）：这些轮的全部 changes 记录的文件之并；total 多于 files 的记录另外交回，由调用方用
 *        git diff --name-only 补全。
 * @param records 当前分支上的 mori.turn_changes（turnEntries）
 * @param rounds roundsFrom 的结果
 */
export function fileSet(records: readonly TurnEntry[], rounds: ReadonlySet<string>):
  { files: Set<string>; incomplete: ChangesRecord[] } {
  const files = new Set<string>();
  const incomplete: ChangesRecord[] = [];
  for (const record of roundChanges(records, rounds)) {
    for (const file of record.files) files.add(file.path);
    if (record.total > record.files.length) incomplete.push(record);
  }
  return { files, incomplete };
}

/**
 * @brief 出现在这些轮里 overlap 为真的记录里的文件（§5.6 第 4 步 overlap 的来源）。
 * @param records 当前分支上的 mori.turn_changes
 * @param rounds roundsFrom 的结果
 */
export function overlapFiles(records: readonly TurnEntry[], rounds: ReadonlySet<string>): Set<string> {
  const files = new Set<string>();
  for (const record of roundChanges(records, rounds)) {
    if (record.overlap) for (const file of record.files) files.add(file.path);
  }
  return files;
}

/**
 * @brief 冲突（§5.6 第 4 步）：F 里在最近一张快照之后又变了的为 changed，出现在 overlap 记录里的为 overlap，两种都是记 changed；
 *        按路径排序（全部，不截断）。
 * @param files 文件集合
 * @param changed 最近一张快照到保险快照之间变了的文件
 * @param overlap overlapFiles 的结果
 */
export function conflictsOf(files: Iterable<string>, changed: ReadonlySet<string>, overlap: ReadonlySet<string>):
  RewindConflict[] {
  const conflicts: RewindConflict[] = [];
  for (const path of files) {
    if (changed.has(path)) conflicts.push({ path, reason: 'changed' });
    else if (overlap.has(path)) conflicts.push({ path, reason: 'overlap' });
  }
  return conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * @brief 冲突集合的 token（§5.6 第 5 步）：按路径排序的全部冲突（路径与原因）的 SHA-1 前 16 位。
 * @param conflicts 全部冲突
 */
export function conflictToken(conflicts: readonly RewindConflict[]): string {
  const sorted = [...conflicts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = sorted.map((item) => `${item.reason}\t${item.path}`).join('\0');
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * @brief 恢复集合分成两部分（§5.7 第 1–3 步）：基准里有的要 restore，基准里没有的（后来新建的）要先删掉。
 * @param restoring 恢复集合 R
 * @param inBase 基准快照的全部文件（ls-tree -r -z --name-only）
 */
export function splitRestore(restoring: Iterable<string>, inBase: ReadonlySet<string>):
  { restore: string[]; remove: string[] } {
  const restore: string[] = [];
  const remove: string[] = [];
  for (const path of restoring) (inBase.has(path) ? restore : remove).push(path);
  return { restore, remove };
}
