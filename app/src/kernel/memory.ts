// 记忆模块（docs/specs/memory.md §3、§6、§8、§9.8、§9.10）：<userData>/memory 唯一的读写入口（proposal 规则 1）。
// 读：每次按目录读索引与 detail，不缓存（你可能手改过文件，§3）；读不出来的条目单独列出、不进 prompt，记错误日志。
// 写：进程内一个写入队列，按调用顺序一个接一个做（§6.7）。每次写入先查谁能改、字段与预算（§6.3、§6.4），
// 再原子写条目文件与索引、删文件，最后写修订（§6.7），写完发 mori.memory_changed（§8）。
// 增强运行整次一条修订：beginRun 写出 running 的修订，运行里的写入并进它并重写，endRun 定下状态（§9.8、§9.10）。
// 增强调度的 enhance.json 也经这个队列写（enqueue + writeProjectJson）。

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  KIND_INDEX_FILE, KIND_LABEL, MEMORY_DEFAULTS, MEMORY_KINDS, MEMORY_LAYERS, evidenceLine, localDate, monthDay,
  type BrokenEntry, type EnhanceTask, type EntryDetail, type EntryPlace, type EntryRef, type EntryRow, type MemoryBy,
  type MemoryCaller, type MemoryGetResult, type MemoryGlobalEvent, type MemoryKind, type MemoryLayer,
  type MemoryListResult, type MemoryWriteResult, type RevisionChange, type RevisionCounts, type RevisionDetail,
  type RevisionRow, type StoredEvidence,
} from '../shared/memory';
import { writeFileAtomic } from './agents';
import {
  MOVE_TEXT, PROJECT_FILE, canonicalEvidence, isSafeName, localIso, makeSlug, oneLine, parseDetail, parseIndex,
  parseRevision, parseRevisionRow, projectDirName, projectOwnerError, renderDetail, renderIndex, renderRevision,
  revisionId, uniqueSlug, type DetailFile, type FrontmatterParser, type IndexItem,
} from './memoryFiles';
import {
  backlinkSlugs, budgetError, countChanges, mergeRunChange, pageFieldError, rollbackConflict, sourceAfter, usageOf,
  writeRefusal, type Candidate, type Snapshot,
} from './memoryRules';
import { loadPi } from './pi';

// ---- 对外的类型与文字 ----

/** @brief beginRun 的参数（§9.8）。 */
export interface RunSpec {
  /** 项目的工作目录 */
  cwd: string;
  /** 任务（也是这次能改的种类） */
  task: EnhanceTask;
  /** 日子 D（YYYY-MM-DD） */
  day: string;
  /** 第一条消息列出的会话数 */
  sessions: number;
  /** 第一条消息列出的反馈数 */
  feedback: number;
}

/** @brief 一次增强运行的句柄：带着它的写入都并进这次运行的修订（§9.8）。 */
export interface RunHandle {
  /** 修订 id */
  readonly id: string;
  /** 项目的工作目录 */
  readonly cwd: string;
  /** 任务 */
  readonly task: EnhanceTask;
  /** 日子 D */
  readonly day: string;
}

/** @brief 写入的一方（§6.1）。 */
export interface MemoryActor {
  /** detail 的 created/modified、修订的 by 与标题里写的“谁” */
  by: MemoryBy;
  /** memory 工具的调用方；记忆页与回滚为 null */
  caller: MemoryCaller | null;
  /** 增强运行；别的写入为 null */
  run: RunHandle | null;
}

/** @brief memory 工具匹配到的条目（§7.4）。 */
export interface ToolTarget {
  /** 会话的工作目录 */
  cwd: string;
  /** 条目所在的层 */
  layer: MemoryLayer;
  /** 条目的种类 */
  kind: MemoryKind;
  /** slug */
  id: string;
}

/** @brief 要改的条目：记忆页的命令没有种类时按 id 在这一层的四种索引里找。 */
export interface EntryTarget {
  /** 工作目录；只看用户级时为 null */
  cwd: string | null;
  /** 条目所在的层 */
  layer: MemoryLayer;
  /** 种类；不给时在这一层的四种里找 */
  kind?: MemoryKind;
  /** slug */
  id: string;
}

/** @brief save 的参数（§6.1）。 */
export interface SaveInput {
  /** 工作目录（写用户级时也用来做“本项目”的预算检查）；只看用户级时为 null */
  cwd: string | null;
  /** 写入的层 */
  layer: MemoryLayer;
  /** 种类 */
  kind: MemoryKind;
  /** 进 prompt 的一行 */
  abstract: string;
  /** `## Details` 的原文 */
  detail: string;
  /** 依据（记忆页为空） */
  evidence: StoredEvidence[];
  /** 修订的 Note 行（可选） */
  note?: string;
  /** agent 调用方：你明确要它记（memory 工具的 asked，§6.4）；没给按假，别的写入方不看 */
  asked?: boolean;
}

/** @brief update 的参数（§6.1）：没给的字段不变，依据追加。 */
export interface UpdateInput {
  /** 要改的条目 */
  target: EntryTarget;
  /** 新的 abstract */
  abstract?: string;
  /** 新的 `## Details` */
  detail?: string;
  /** 追加的依据 */
  evidence?: StoredEvidence[];
  /** 修订说明（进 `## Revisions` 与修订的 Note 行）；记忆页的修改固定为 PAGE_EDIT_NOTE */
  note: string;
  /** agent 调用方：你明确要它改（memory 工具的 asked，§6.4）；没给按假，别的写入方不看 */
  asked?: boolean;
  /** 移到另一种的目标种类（增强任务的 move，§6.9）；不给时种类不变 */
  kind?: MemoryKind;
}

/** @brief forget 的参数（§6.1）。 */
export interface ForgetInput {
  /** 要删的条目 */
  target: EntryTarget;
  /** 删除原因（进修订的 Note 行；记忆页的删除为空） */
  note: string;
  /** 增强任务删除时带的依据（进修订的 Evidence 行，§9.8）；记忆页与 agent 的删除没有 */
  evidence?: StoredEvidence[];
}

/** @brief 条目已经不在时的原因（§8）。 */
export const ENTRY_GONE = 'This entry no longer exists.';

/** @brief 记忆页修改的修订说明（§3.2）。 */
export const PAGE_EDIT_NOTE = 'Edited on the Memory page';

/** @brief 后台进程在运行中退出时，那次运行的原因与 Notes（§9.10）。 */
export const RUN_CLOSED = 'Mori closed during the run';

/** 运行中的修订不能回滚（§6.6） */
const RUN_GOING = 'This revision’s run is still going.';
/** 要回滚的修订已经不在 */
const REVISION_GONE = 'This revision no longer exists.';
/** 修订里没有改动，没有可回滚的 */
const NO_CHANGES = 'This revision has no changes.';
/** 要读写本项目一层却没有工作目录（同记忆页 Project 不可用时的悬停文字，§10.1） */
const NO_PROJECT = 'Open a session to see this project’s memory.';
/** 运行已经结束后又有带着它的写入 */
const RUN_ENDED = 'This enhancement run has already ended.';
/** 索引里有、entries 里没有的条目（§3.1） */
const MISSING_FILE = 'The entry file doesn’t exist.';

/** detail 与修订记录的子目录（§3） */
const ENTRIES = 'entries';
const REVISIONS = 'revisions';
/** 读修订列表时先读文件开头这么多字节，里面有 frontmatter 的结尾就不再读正文（§6.5） */
const HEAD_BYTES = 8192;
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

// ---- 内部状态 ----

/** @brief 读出来的一条。 */
interface LoadedEntry {
  /** 文件名（不含 .md） */
  slug: string;
  /** 解析后的内容 */
  detail: DetailFile;
  /** 文件原文（修订的 before/after 按它逐字比较） */
  text: string;
}

/** @brief 一层一种：索引的行、读得出来的条目、读不出来的条目。 */
interface KindState {
  /** 这一层的目录 */
  base: string;
  /** 种类 */
  kind: MemoryKind;
  /** 索引的行（含读不出来的），按顺序 */
  items: IndexItem[];
  /** 读得出来的条目，按 slug */
  entries: Map<string, LoadedEntry>;
  /** 读不出来的条目与原因 */
  broken: BrokenEntry[];
}

/** @brief 进行中的增强运行。 */
interface RunState {
  /** 交给增强调度的句柄 */
  handle: RunHandle;
  /** 这次运行的修订（每次写入后重写） */
  revision: RevisionDetail;
  /** 本项目的目录 */
  dir: string;
}

/** @brief 要原子写的一个文件。 */
interface FileWrite {
  /** 绝对路径 */
  path: string;
  /** 全文 */
  text: string;
}

/** @brief 一次写入要做的事：先按顺序写文件（条目文件在前、索引在后），再删文件，最后写修订（§6.7）。 */
interface Plan {
  /** 改到本项目时的工作目录，否则为 null（修订与事件的 cwd） */
  cwd: string | null;
  /** 改到的层与各自的目录：修订写进每一层的 revisions/ */
  bases: Partial<Record<MemoryLayer, string>>;
  /** 改到的种类 */
  kinds: MemoryKind[];
  /** 修订标题（§6.5） */
  title: string;
  /** 回滚的那一次的 id；不是回滚时为 null */
  rollbackOf: string | null;
  /** 按顺序原子写的文件 */
  writes: FileWrite[];
  /** 要删的条目文件 */
  removes: string[];
  /** 修订里的改动 */
  changes: RevisionChange[];
  /** 返回给调用方的条目 id（新增、移动）；否则为 null */
  id: string | null;
}

/** Electron 的 userData 目录；startMemory 之前为 null */
let userDataDir: string | null = null;
/** 发全局事件（startMemory 交来的） */
let emitGlobal: (event: MemoryGlobalEvent) => void = () => {};
/** 写入队列的末尾：下一个 job 排在它之后 */
let tail: Promise<unknown> = Promise.resolve();
/** 进行中的增强运行，按修订 id */
const runs = new Map<string, RunState>();

// ---- 启动、队列与目录 ----

/**
 * @brief 后台进程收到 start 后调用一次（kernel/index.ts）：记下 userData 与全局事件的发送函数。
 * @param userData Electron 的 userData 目录
 * @param emit 发全局事件（sessionId 为 null）
 */
export function startMemory(userData: string, emit: (event: MemoryGlobalEvent) => void): void {
  userDataDir = userData;
  emitGlobal = emit;
}

/** @brief `<userData>/memory`。 */
export function memoryDir(): string {
  if (userDataDir === null) throw new Error('The memory module has not started.');
  return join(userDataDir, 'memory');
}

/**
 * @brief 写入队列（§6.7）：job 排在之前所有写入之后，一个接一个做。记忆模块的写入函数自己排队，
 *        所以不要在 job 里再调 save、update、forget、move、rollback、beginRun、endRun、failStaleRun（会互相等待）；
 *        enhance.json 的读改写放在一个 job 里，用 readProjectJson 与 writeProjectJson。
 */
export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = tail.then(job);
  tail = result.catch(() => undefined);
  return result;
}

/** @brief 错误的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief 读文本文件；不存在时为 null。 */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** @brief 目录里的名字；目录不存在时为空。 */
async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** @brief 4 位小写字母数字（slug 与修订 id 的后缀）。 */
function random4(): string {
  return Array.from({ length: 4 }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]).join('');
}

/** 这个进程最近发出的修订 id */
let lastRevisionId = '';

/**
 * @brief 新的修订 id（§3.3）。同一秒里的几次写入后缀随机，按名字排序会乱，所以不大于上一个 id 时取上一个的后缀加一
 *        （小写字母数字按 0-9a-z 排，与 36 进制的大小一致）：按名字排序就是写入的先后，回滚找“之后改过它的修订”按它比较。
 *        后缀已到 zzzz 时（同一秒里一百多万次）只能用随机的那个。
 */
function nextRevisionId(now: Date): string {
  const id = revisionId(now, random4);
  const bumped = parseInt(lastRevisionId.slice(-4), 36) + 1;
  if (id > lastRevisionId || !(bumped < 36 ** 4)) {
    lastRevisionId = id;
  } else {
    lastRevisionId = `${lastRevisionId.slice(0, -4)}${bumped.toString(36).padStart(4, '0')}`;
  }
  return lastRevisionId;
}

/** @brief 用户级一层的目录 `memory/user`。 */
function userBase(): string {
  return join(memoryDir(), 'user');
}

/** @brief 各项目目录的上一级 `memory/projects`。 */
function projectsRoot(): string {
  return join(memoryDir(), 'projects');
}

/** @brief 一层里一条的 detail 文件 `entries/<slug>.md`。 */
function entryPath(base: string, slug: string): string {
  return join(base, ENTRIES, `${slug}.md`);
}

/** @brief 一层里一种的索引文件（MEMORY.md、TASTE.md…）。 */
function indexPath(base: string, kind: MemoryKind): string {
  return join(base, KIND_INDEX_FILE[kind]);
}

/** @brief 一层里一次修订的文件 `revisions/<id>.md`。 */
function revisionPath(base: string, id: string): string {
  return join(base, REVISIONS, `${id}.md`);
}

/** @brief 项目目录的 project.json 记下的工作目录；还没有或读不出来时为 null（读不出来记日志）。 */
function readOwner(dir: string): string | null {
  const path = join(dir, PROJECT_FILE);
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { cwd?: unknown } | null;
    return typeof data?.cwd === 'string' ? data.cwd : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] reading ${path} failed: ${errorText(error)}`);
    }
    return null;
  }
}

/**
 * @brief 工作目录对应的项目目录与编码冲突的检查（§3）：凡是按 cwd 找项目目录的地方都经它。
 *        目录已被别的工作目录认领时 error 为 `This project’s memory folder belongs to <cwd>.`，调用方不读不写。
 * @param cwd 工作目录
 */
export function projectDir(cwd: string): { dir: string; error: string | null } {
  const dir = join(projectsRoot(), projectDirName(cwd));
  return { dir, error: projectOwnerError(cwd, readOwner(dir)) };
}

/** @brief 第一次写这个项目目录时先写 project.json（§3）。 */
async function claimProject(cwd: string, dir: string): Promise<void> {
  if ((await readText(join(dir, PROJECT_FILE))) !== null) return;
  await writeFileAtomic(join(dir, PROJECT_FILE), `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`);
}

/** @brief 一层的目录；本项目一层没有工作目录或被别的工作目录占用时给出原因。 */
function layerBase(cwd: string | null, layer: MemoryLayer): { base: string; error: string | null } {
  if (layer === 'user') return { base: userBase(), error: null };
  if (cwd === null) return { base: '', error: NO_PROJECT };
  const { dir, error } = projectDir(cwd);
  return { base: dir, error };
}

/** @brief Windows 上文件夹名不分大小写。 */
function sameFolder(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** @brief memory/projects/ 下的每个项目目录与它记下的工作目录。 */
async function projectFolders(): Promise<{ name: string; dir: string; cwd: string | null }[]> {
  let folders;
  try {
    folders = await readdir(projectsRoot(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return folders.filter((folder) => folder.isDirectory()).map((folder) => {
    const dir = join(projectsRoot(), folder.name);
    return { name: folder.name, dir, cwd: readOwner(dir) };
  });
}

/** @brief 有 project.json 的项目目录（增强调度读每个项目的 enhance.json 用）。 */
export async function listProjectDirs(): Promise<{ cwd: string; dir: string }[]> {
  return (await projectFolders())
    .flatMap((folder) => (folder.cwd === null ? [] : [{ cwd: folder.cwd, dir: folder.dir }]));
}

/**
 * @brief 读项目目录里的 JSON 文件（例如 enhance.json）。
 * @return 不存在时为 null
 * @throws Error 项目目录被别的工作目录占用（§3 的原文）、读或解析失败
 */
export async function readProjectJson<T>(cwd: string, name: string): Promise<T | null> {
  const { dir, error } = projectDir(cwd);
  if (error) throw new Error(error);
  const text = await readText(join(dir, name));
  return text === null ? null : (JSON.parse(text) as T);
}

/**
 * @brief 原子写项目目录里的 JSON 文件（第一次写这个目录时先写 project.json）。自己不排队：调用方放在 enqueue 的 job 里。
 * @throws Error 项目目录被别的工作目录占用（§3 的原文）或写入失败
 */
export async function writeProjectJson(cwd: string, name: string, value: unknown): Promise<void> {
  const { dir, error } = projectDir(cwd);
  if (error) throw new Error(error);
  await claimProject(cwd, dir);
  await writeFileAtomic(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

// ---- 读条目 ----

/** @brief pi 的 parseFrontmatter。 */
async function parser(): Promise<FrontmatterParser> {
  return (await loadPi()).parseFrontmatter;
}

/** @brief 读一个 detail 文件；读不出来时给出原因。 */
async function readEntry(base: string, slug: string, parse: FrontmatterParser):
  Promise<LoadedEntry | { error: string }> {
  try {
    const text = await readText(entryPath(base, slug));
    if (text === null) return { error: MISSING_FILE };
    return { slug, detail: parseDetail(text, parse), text };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/**
 * @brief 读一层一种（§3.1）：索引的每一行读它的 detail。读不出来的、种类与索引不符的列为读不出来（记错误日志）；
 *        索引的 abstract 与 detail 不同时以 detail 为准（记错误日志），下一次写这一种时按 detail 重写索引。
 */
async function readKind(base: string, kind: MemoryKind): Promise<KindState> {
  const parse = await parser();
  const items = parseIndex((await readText(indexPath(base, kind))) ?? '');
  const state: KindState = { base, kind, items, entries: new Map(), broken: [] };
  for (const item of items) {
    const loaded = await readEntry(base, item.slug, parse);
    if ('error' in loaded || loaded.detail.kind !== kind) {
      const error = 'error' in loaded ? loaded.error
        : `The entry’s kind is ${loaded.detail.kind}, but it’s listed in ${KIND_INDEX_FILE[kind]}.`;
      state.broken.push({ name: `${item.slug}.md`, error });
      console.error(`[kernel] memory entry ${entryPath(base, item.slug)} can't be read: ${error}`);
      continue;
    }
    if (loaded.detail.abstract !== item.abstract) {
      console.error(`[kernel] ${indexPath(base, kind)} differs from ${item.slug}.md; using the entry's abstract`);
    }
    state.entries.set(item.slug, loaded);
  }
  return state;
}

/** @brief 进 prompt 的 abstract：索引顺序，只有读得出来的条目。 */
function abstractsOf(state: KindState): string[] {
  return state.items.flatMap((item) => {
    const entry = state.entries.get(item.slug);
    return entry ? [entry.detail.abstract] : [];
  });
}

/** @brief 按 detail 重写的索引（读不出来的行原样保留在原位）。 */
function indexWrite(state: KindState): FileWrite {
  const items = state.items.map((item) => ({ slug: item.slug,
    abstract: state.entries.get(item.slug)?.detail.abstract ?? item.abstract }));
  return { path: indexPath(state.base, state.kind), text: renderIndex(state.kind, items) };
}

/** @brief 这一层已用的名字（entries 下的文件与四个索引里的链接），小写。 */
async function takenSlugs(base: string): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const name of await listNames(join(base, ENTRIES))) {
    if (name.toLowerCase().endsWith('.md')) taken.add(name.slice(0, -3).toLowerCase());
  }
  for (const kind of MEMORY_KINDS) {
    for (const item of parseIndex((await readText(indexPath(base, kind))) ?? '')) taken.add(item.slug.toLowerCase());
  }
  return taken;
}

/**
 * @brief 在这一层找一条（给了种类时只看那一种的索引）。
 * @return 条目与它那一种的状态；不在索引里时为 ENTRY_GONE，读不出来时为原因
 */
async function locate(base: string, id: string, kind?: MemoryKind): Promise<{ state: KindState; entry: LoadedEntry }
  | { error: string }> {
  if (!isSafeName(id)) return { error: ENTRY_GONE };
  for (const each of kind ? [kind] : MEMORY_KINDS) {
    const state = await readKind(base, each);
    if (!state.items.some((item) => item.slug === id)) continue;
    const entry = state.entries.get(id);
    if (entry) return { state, entry };
    return { error: state.broken.find((broken) => broken.name === `${id}.md`)?.error ?? ENTRY_GONE };
  }
  return { error: ENTRY_GONE };
}

/** @brief 四种都为空的一层。 */
function emptyKinds(): Record<MemoryKind, string[]> {
  return { fact: [], taste: [], strategy: [], review: [] };
}

/** @brief 读一层四种的 abstract 填进快照；某一种读失败时记日志、留空。 */
async function fillLayer(target: Record<MemoryKind, string[]>, base: string): Promise<void> {
  for (const kind of MEMORY_KINDS) {
    try {
      target[kind] = abstractsOf(await readKind(base, kind));
    } catch (error) {
      console.error(`[kernel] reading ${indexPath(base, kind)} failed: ${errorText(error)}`);
    }
  }
}

/**
 * @brief 会话打开时的快照（§5.2）：两层四种的 abstract，按索引顺序，只有读得出来的条目。
 *        本项目目录被别的工作目录占用时本项目一层为空，记错误日志，会话照常打开（§3）。
 * @param cwd 会话的工作目录
 */
export async function abstracts(cwd: string): Promise<Snapshot> {
  const snapshot: Snapshot = { user: emptyKinds(), project: emptyKinds() };
  await fillLayer(snapshot.user, userBase());
  const { dir, error } = projectDir(cwd);
  if (error) console.error(`[kernel] ${error} Sessions in ${cwd} get user-level memory only.`);
  else await fillLayer(snapshot.project, dir);
  return snapshot;
}

/** @brief 两层全部读得出来的条目（本项目不可用时只有用户级）。 */
async function allEntries(cwd: string | null): Promise<{ layer: MemoryLayer; entry: LoadedEntry }[]> {
  const bases: [MemoryLayer, string][] = [['user', userBase()]];
  if (cwd !== null) {
    const { dir, error } = projectDir(cwd);
    if (!error) bases.push(['project', dir]);
  }
  const result: { layer: MemoryLayer; entry: LoadedEntry }[] = [];
  for (const [layer, base] of bases) {
    for (const kind of MEMORY_KINDS) {
      const state = await readKind(base, kind);
      for (const item of state.items) {
        const entry = state.entries.get(item.slug);
        if (entry) result.push({ layer, entry });
      }
    }
  }
  return result;
}

/**
 * @brief memory 工具匹配用的全部条目（两层四种，读得出来的）。项目目录被占用时只有用户级：
 *        调用方先用 projectDir 检查并按 §3 拒绝。
 * @param cwd 会话的工作目录
 * @throws Error 读目录或文件失败（不是读不出来的条目，那些不在结果里）
 */
export async function candidates(cwd: string): Promise<Candidate[]> {
  return (await allEntries(cwd)).map(({ layer, entry }) => ({ layer, kind: entry.detail.kind, id: entry.slug,
    abstract: entry.detail.abstract, source: entry.detail.source }));
}

/** @brief 列表的一行。 */
function rowsOf(state: KindState): EntryRow[] {
  return state.items.flatMap((item) => {
    const entry = state.entries.get(item.slug);
    if (!entry) return [];
    const { abstract, source, created, modified } = entry.detail;
    return [{ id: item.slug, abstract, source, created, modified }];
  });
}

/** @brief 读失败时的 memory.list 结果。 */
function emptyList(error: string): MemoryListResult {
  return { entries: [], usage: usageOf([], []), broken: [], last: null, error };
}

/**
 * @brief memory.list（§8）：这一层这一种的条目、读不出来的条目、用量（看本项目时加上用户级）、最近一次改到这一种的修订。
 * @param cwd 工作目录；只看用户级时为 null
 * @param layer 层
 * @param kind 种类
 */
export async function list(cwd: string | null, layer: MemoryLayer, kind: MemoryKind): Promise<MemoryListResult> {
  const { base, error } = layerBase(cwd, layer);
  if (error) return emptyList(error);
  try {
    const state = await readKind(base, kind);
    const own = abstractsOf(state);
    const usage = layer === 'user' ? usageOf(own, []) : usageOf(abstractsOf(await readKind(userBase(), kind)), own);
    const last = (await revisionRows(base, (row) => row.kinds.includes(kind), 1))[0] ?? null;
    return { entries: rowsOf(state), usage, broken: state.broken, last, error: null };
  } catch (failure) {
    console.error(`[kernel] memory.list failed: ${errorText(failure)}`);
    return emptyList(errorText(failure));
  }
}

/** @brief EntryDetail（memory.get、增强的第一条消息）。 */
function entryDetail(entry: LoadedEntry, layer: MemoryLayer, base: string): EntryDetail {
  const { kind, abstract, source, created, modified, details, evidence, history } = entry.detail;
  return { id: entry.slug, abstract, source, created, modified, kind, layer, details, evidence, history,
    file: entryPath(base, entry.slug) };
}

/** @brief 读失败或条目不在时的 memory.get 结果。 */
function emptyGet(error: string | null): MemoryGetResult {
  return { entry: null, revisions: [], backlinks: [], error };
}

/**
 * @brief memory.get（§8）：解析后的 detail、改过它的修订（时间倒序）、反向链接（§6.8）。条目不在时 entry 为 null。
 * @param cwd 工作目录；只看用户级时为 null
 * @param layer 层
 * @param id slug
 */
export async function get(cwd: string | null, layer: MemoryLayer, id: string): Promise<MemoryGetResult> {
  const { base, error } = layerBase(cwd, layer);
  if (error) return emptyGet(error);
  try {
    const found = await locate(base, id);
    if ('error' in found) return emptyGet(found.error === ENTRY_GONE ? null : found.error);
    const place: EntryPlace = { layer, slug: found.entry.slug };
    return { entry: entryDetail(found.entry, layer, base), revisions: await touchingRevisions(base, place),
      backlinks: await backlinks(cwd, place), error: null };
  } catch (failure) {
    console.error(`[kernel] memory.get failed: ${errorText(failure)}`);
    return emptyGet(errorText(failure));
  }
}

/**
 * @brief 一条的 detail（增强的第一条消息取本项目这一种的 detail）；不在或读不出来时为 null。
 * @param cwd 工作目录
 * @param layer 层
 * @param id slug
 */
export async function detailOf(cwd: string, layer: MemoryLayer, id: string): Promise<EntryDetail | null> {
  const { base, error } = layerBase(cwd, layer);
  if (error) return null;
  try {
    const found = await locate(base, id);
    return 'error' in found ? null : entryDetail(found.entry, layer, base);
  } catch (failure) {
    console.error(`[kernel] reading memory entry ${id} failed: ${errorText(failure)}`);
    return null;
  }
}

/**
 * @brief 反向链接（§6.8）：读两层全部 detail，正文里有 `[[<slug>]]` 并且链接解析到这一条的（同层先找，找不到再找另一层），
 *        按种类、abstract 排列。不缓存。
 */
async function backlinks(cwd: string | null, place: EntryPlace): Promise<EntryRef[]> {
  const all = await allEntries(cwd);
  const inLayer = (layer: MemoryLayer) => all.some((item) => item.layer === layer && item.entry.slug === place.slug);
  const refs = all.filter(({ layer, entry }) => !(layer === place.layer && entry.slug === place.slug)
    && backlinkSlugs(entry.detail.details).includes(place.slug) && (layer === place.layer || !inLayer(layer)));
  return refs.map(({ layer, entry }) => ({ layer, kind: entry.detail.kind, id: entry.slug,
    abstract: entry.detail.abstract }))
    .sort((a, b) => MEMORY_KINDS.indexOf(a.kind) - MEMORY_KINDS.indexOf(b.kind)
      || a.abstract.localeCompare(b.abstract));
}

// ---- 读修订 ----

/** @brief 这一层的修订 id，按名字（时间）升序。 */
async function revisionNames(base: string): Promise<string[]> {
  return (await listNames(join(base, REVISIONS))).filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3)).filter(isSafeName).sort();
}

/** @brief 只读修订文件开头的 frontmatter（§6.5）；开头一块里没有 frontmatter 的结尾时读整个文件。 */
async function readHead(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    if (bytesRead < HEAD_BYTES || head.indexOf('\n---', 3) >= 0) return head;
  } finally {
    await file.close();
  }
  return readFile(path, 'utf8');
}

/**
 * @brief 这一层的修订列表行，时间倒序，只看最新的 200 个文件（§6.5、§12）；读不出来的跳过并记日志。
 * @param accept 要哪些行
 * @param max 最多几行
 */
async function revisionRows(base: string, accept: (row: RevisionRow) => boolean, max: number): Promise<RevisionRow[]> {
  const parse = await parser();
  const rows: RevisionRow[] = [];
  for (const id of (await revisionNames(base)).reverse().slice(0, MEMORY_DEFAULTS.revisionsMax)) {
    try {
      const row = parseRevisionRow(await readHead(revisionPath(base, id)), parse);
      if (accept(row)) rows.push(row);
    } catch (error) {
      console.error(`[kernel] revision ${revisionPath(base, id)} can't be read: ${errorText(error)}`);
    }
    if (rows.length >= max) break;
  }
  return rows;
}

/** @brief 读一次修订的全文；不存在时为 null。 */
async function readRevision(base: string, id: string, parse: FrontmatterParser): Promise<RevisionDetail | null> {
  const text = await readText(revisionPath(base, id));
  return text === null ? null : parseRevision(text, parse);
}

/** @brief 修订的列表行部分。 */
function rowOnly(revision: RevisionDetail): RevisionRow {
  const { id, time, by, title, status, layers, kinds, counts, rollbackOf } = revision;
  return { id, time, by, title, status, layers, kinds, counts, rollbackOf };
}

/** @brief 这处改动是否改到这个位置的条目。 */
function touches(change: RevisionChange, place: EntryPlace): boolean {
  return [change.from, change.to].some((each) => each !== null && each.layer === place.layer
    && each.slug === place.slug);
}

/** @brief 改过这一条的修订（时间倒序，最新的 200 个文件里找）。 */
async function touchingRevisions(base: string, place: EntryPlace): Promise<RevisionRow[]> {
  const parse = await parser();
  const rows: RevisionRow[] = [];
  for (const id of (await revisionNames(base)).reverse().slice(0, MEMORY_DEFAULTS.revisionsMax)) {
    try {
      const revision = await readRevision(base, id, parse);
      if (revision?.changes.some((change) => touches(change, place))) rows.push(rowOnly(revision));
    } catch (error) {
      console.error(`[kernel] revision ${revisionPath(base, id)} can't be read: ${errorText(error)}`);
    }
  }
  return rows;
}

/**
 * @brief memory.revisions 没有 id（§8）：这一层的修订列表，时间倒序，最多 200 条，只读 frontmatter。
 * @param cwd 工作目录；只看用户级时为 null
 * @param layer 层
 */
export async function revisions(cwd: string | null, layer: MemoryLayer): Promise<{ revisions: RevisionRow[];
  error: string | null }> {
  const { base, error } = layerBase(cwd, layer);
  if (error) return { revisions: [], error };
  try {
    return { revisions: await revisionRows(base, () => true, MEMORY_DEFAULTS.revisionsMax), error: null };
  } catch (failure) {
    console.error(`[kernel] memory.revisions failed: ${errorText(failure)}`);
    return { revisions: [], error: errorText(failure) };
  }
}

/**
 * @brief memory.revisions 带 id（§8）：一次修订的全文；不存在时为 null。
 * @param cwd 工作目录；只看用户级时为 null
 * @param layer 层
 * @param id 修订 id
 */
export async function revision(cwd: string | null, layer: MemoryLayer, id: string): Promise<{
  revision: RevisionDetail | null; error: string | null }> {
  const { base, error } = layerBase(cwd, layer);
  if (error) return { revision: null, error };
  try {
    return { revision: isSafeName(id) ? await readRevision(base, id, await parser()) : null, error: null };
  } catch (failure) {
    console.error(`[kernel] memory.revisions ${id} failed: ${errorText(failure)}`);
    return { revision: null, error: errorText(failure) };
  }
}

// ---- 写入的共用部分 ----

/** @brief 失败的写入结果（记错误日志）。 */
function failed(error: string): MemoryWriteResult {
  console.error(`[kernel] memory write failed: ${error}`);
  return { error, revision: null, id: null };
}

/** @brief 在队列里做一次写入；意外的异常变成失败的结果。 */
async function guarded(job: () => Promise<MemoryWriteResult>): Promise<MemoryWriteResult> {
  try {
    return await job();
  } catch (error) {
    return failed(errorText(error));
  }
}

/** @brief 发 mori.memory_changed（§8）。 */
function emitChanged(cwd: string | null, layers: MemoryLayer[], kinds: MemoryKind[], revisionId: string): void {
  try {
    emitGlobal({ type: 'mori.memory_changed', cwd, layers, kinds, revision: revisionId });
  } catch (error) {
    console.error(`[kernel] sending mori.memory_changed failed: ${errorText(error)}`);
  }
}

/** @brief 记忆页的写入（不是工具、不是回滚）。 */
function isPage(actor: MemoryActor): boolean {
  return actor.caller === null && actor.by === 'You';
}

/** @brief 带着已经结束的运行写入时的原因。 */
function runError(actor: MemoryActor): string | null {
  return actor.run !== null && !runs.has(actor.run.id) ? RUN_ENDED : null;
}

/** @brief created/modified 与 `## Revisions` 行的日子：增强运行记它的日子 D，其他写入记当天的本地日期。 */
function dayOf(actor: MemoryActor): string {
  return actor.run ? actor.run.day : localDate(Date.now());
}

/** @brief 修订标题里的 abstract：前 60 字符（§6.5、§12）。 */
function clipTitle(abstract: string): string {
  return [...abstract].slice(0, MEMORY_DEFAULTS.titleAbstractMax).join('');
}

/** @brief 修订标题：`<谁> · <Added|Changed|Deleted> <KIND>: <abstract 前 60 字符>`（§6.5）。 */
function titleOf(by: MemoryBy, verb: string, kind: MemoryKind, abstract: string): string {
  return `${by} · ${verb} ${KIND_LABEL[kind]}: ${clipTitle(abstract)}`;
}

/** @brief 修订的 Evidence 行：每项按依据行，多项用 `; ` 连接（§3.3）；没有依据时为 undefined。 */
function evidenceText(evidence: readonly StoredEvidence[]): string | undefined {
  return evidence.length > 0 ? evidence.map((item) => oneLine(evidenceLine(item))).join('; ') : undefined;
}

/** @brief 给改动加上 Evidence 与 Note 行（空的不加）。 */
function withLines(change: RevisionChange, evidence: string | undefined, note: string | undefined): RevisionChange {
  if (evidence) change.evidence = evidence;
  if (note) change.note = note;
  return change;
}

/** @brief 只改一层一种时的计划骨架。 */
function singlePlan(cwd: string | null, state: KindState, layer: MemoryLayer): Pick<Plan, 'cwd' | 'bases' | 'kinds'
  | 'rollbackOf'> {
  const bases: Partial<Record<MemoryLayer, string>> = layer === 'user' ? { user: state.base }
    : { project: state.base };
  return { cwd: layer === 'project' ? cwd : null, bases, kinds: [state.kind], rollbackOf: null };
}

/** @brief 写入之后某一层这一种的 abstract。 */
function listsFor(layer: MemoryLayer, list: string[]): Partial<Record<MemoryLayer, string[]>> {
  return layer === 'user' ? { user: list } : { project: list };
}

/** @brief 本项目这一种的 abstract；没有工作目录或项目目录被占用时为空。 */
async function currentProject(cwd: string | null, kind: MemoryKind): Promise<string[]> {
  if (cwd === null) return [];
  const { dir, error } = projectDir(cwd);
  return error ? [] : abstractsOf(await readKind(dir, kind));
}

/** @brief 写用户级时要检查的其他项目（有这一种条目的，不含本项目），按 cwd 排序。 */
async function otherProjects(cwd: string | null, kind: MemoryKind): Promise<{ cwd: string; abstracts: string[] }[]> {
  const own = cwd !== null && projectDir(cwd).error === null ? projectDirName(cwd) : null;
  const result: { cwd: string; abstracts: string[] }[] = [];
  for (const folder of await projectFolders()) {
    if (own !== null && sameFolder(folder.name, own)) continue;
    const list = abstractsOf(await readKind(folder.dir, kind));
    if (list.length > 0) result.push({ cwd: folder.cwd ?? folder.name, abstracts: list });
  }
  return result.sort((a, b) => (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
}

/**
 * @brief 预算检查（§6.3）：lists 给出写入之后改到的层，没给的层按现在的文件读。
 * @param cwd 工作目录（写用户级时它是“本项目”）
 * @param kind 种类
 * @param target 写入的层
 * @param lists 写入之后的 abstract
 */
async function budgetFor(cwd: string | null, kind: MemoryKind, target: MemoryLayer,
  lists: Partial<Record<MemoryLayer, string[]>>): Promise<string | null> {
  const user = lists.user ?? abstractsOf(await readKind(userBase(), kind));
  const project = lists.project ?? (await currentProject(cwd, kind));
  const others = target === 'user' ? await otherProjects(cwd, kind) : [];
  return budgetError(kind, target, user, project, others);
}

/** @brief 计划改到的层，按 user、project 的顺序。 */
function layersOf(plan: Plan): MemoryLayer[] {
  return MEMORY_LAYERS.filter((layer) => plan.bases[layer] !== undefined);
}

/**
 * @brief 执行计划（§6.7）：认领项目目录，按顺序原子写文件，删文件，最后写修订。写到一半失败时已经改名成功的文件保留，
 *        返回错误原文（不写修订）。
 */
async function apply(actor: MemoryActor, plan: Plan): Promise<MemoryWriteResult> {
  try {
    if (plan.cwd !== null && plan.bases.project) await claimProject(plan.cwd, plan.bases.project);
    for (const write of plan.writes) await writeFileAtomic(write.path, write.text);
    for (const path of plan.removes) await rm(path, { force: true });
  } catch (error) {
    return failed(errorText(error));
  }
  return actor.run ? recordRun(actor.run, plan) : recordRevision(actor, plan);
}

/** @brief 修订写失败（§6.7）：条目的改动保留，原因 `The revision wasn’t written: <原文>`；仍发事件让界面重读。 */
function revisionFailed(plan: Plan, id: string, error: unknown): MemoryWriteResult {
  const reason = `The revision wasn’t written: ${errorText(error)}`;
  console.error(`[kernel] memory revision ${id}: ${reason}`);
  emitChanged(plan.cwd, layersOf(plan), plan.kinds, id);
  return { error: reason, revision: null, id: plan.id };
}

/** @brief 写一条新的修订，写进改到的每一层的 revisions/（§6.5），然后发事件。 */
async function recordRevision(actor: MemoryActor, plan: Plan): Promise<MemoryWriteResult> {
  const now = new Date();
  const layers = layersOf(plan);
  const record: RevisionDetail = { id: nextRevisionId(now), time: localIso(now), by: actor.by, title: plan.title,
    status: 'done', layers, kinds: plan.kinds, counts: countChanges(plan.changes), rollbackOf: plan.rollbackOf,
    changes: plan.changes, notes: null, run: null, cwd: plan.cwd };
  const text = renderRevision(record);
  try {
    for (const layer of layers) await writeFileAtomic(revisionPath(plan.bases[layer]!, record.id), text);
  } catch (error) {
    return revisionFailed(plan, record.id, error);
  }
  emitChanged(plan.cwd, layers, plan.kinds, record.id);
  return { error: null, revision: record.id, id: plan.id };
}

/** @brief 增强运行里的写入（§9.8）：改动并进这次运行的修订（同一条目一节），重写修订文件，然后发事件。 */
async function recordRun(run: RunHandle, plan: Plan): Promise<MemoryWriteResult> {
  const state = runs.get(run.id);
  if (!state) return failed(RUN_ENDED);
  let changes = state.revision.changes;
  for (const change of plan.changes) changes = mergeRunChange(changes, change);
  state.revision.changes = changes;
  state.revision.counts = countChanges(changes);
  state.revision.kinds = kindsIn([run.task, ...changes.flatMap((change) => [change.kind,
    ...(change.fromKind ? [change.fromKind] : [])])]);
  try {
    await writeFileAtomic(revisionPath(state.dir, run.id), renderRevision(state.revision));
  } catch (error) {
    return revisionFailed(plan, run.id, error);
  }
  emitChanged(run.cwd, ['project'], kindsIn([...state.revision.kinds, ...plan.kinds]), run.id);
  return { error: null, revision: run.id, id: plan.id };
}

// ---- 新增、修改、删除、移动（§6.1） ----

/**
 * @brief 新增一条（§6.1、§6.2）：查谁能改（§6.4）、记忆页的字段（§10.1）、预算（§6.3），定 slug，写条目、索引末尾、修订。
 *        source 按 sourceAfter（§6.4）：记忆页为 user，agent 按 asked 为 user 或 agent，增强为 learned。
 *        工具调用的字段由工具先查（toolFieldError）。
 * @param actor 写入的一方
 * @param input 新条目
 */
export async function save(actor: MemoryActor, input: SaveInput): Promise<MemoryWriteResult> {
  return enqueue(() => guarded(() => saveNow(actor, input)));
}

/** @brief save 在队列里做的部分。 */
async function saveNow(actor: MemoryActor, input: SaveInput): Promise<MemoryWriteResult> {
  const { base, error } = layerBase(input.cwd, input.layer);
  const refusal = error ?? runError(actor)
    ?? writeRefusal(actor.caller, { layer: input.layer, kind: input.kind, source: null })
    ?? (isPage(actor) ? pageFieldError(input.abstract, input.detail) : null);
  if (refusal) return failed(refusal);
  const abstract = oneLine(input.abstract).trim();
  const state = await readKind(base, input.kind);
  const budget = await budgetFor(input.cwd, input.kind, input.layer,
    listsFor(input.layer, [...abstractsOf(state), abstract]));
  if (budget) return failed(budget);
  const taken = await takenSlugs(base);
  const day = dayOf(actor);
  const slug = makeSlug(abstract, input.kind, day, (name) => taken.has(name.toLowerCase()), random4);
  const source = sourceAfter(actor.caller, input.asked === true, null);
  const detail: DetailFile = { kind: input.kind, abstract, source, created: `${day} · ${actor.by}`,
    modified: `${day} · ${actor.by}`, evidence: input.evidence.map(canonicalEvidence), details: input.detail,
    history: [] };
  const text = renderDetail(detail);
  state.items.push({ slug, abstract });
  state.entries.set(slug, { slug, detail, text });
  const change = withLines({ action: 'added', kind: input.kind, from: null, to: { layer: input.layer, slug },
    before: '', after: text }, evidenceText(input.evidence), input.note && oneLine(input.note).trim());
  return apply(actor, { ...singlePlan(input.cwd, state, input.layer), id: slug,
    title: titleOf(actor.by, 'Added', input.kind, abstract), writes: [{ path: entryPath(base, slug), text },
      indexWrite(state)], removes: [], changes: [change] });
}

/** @brief 修订说明：记忆页的修改固定为 PAGE_EDIT_NOTE（§3.2），其他取给的一行。 */
function noteOf(actor: MemoryActor, note: string): string {
  return isPage(actor) ? PAGE_EDIT_NOTE : oneLine(note).trim();
}

/**
 * @brief 这次修改的修订说明：noteOf；移到另一种时前面加 `Moved from <KIND> to <KIND>: `（§6.9）。
 * @param from 条目现在的种类
 */
function changeNote(actor: MemoryActor, input: UpdateInput, from: MemoryKind): string {
  const note = noteOf(actor, input.note);
  if (input.kind === undefined || input.kind === from) return note;
  return `Moved from ${KIND_LABEL[from]} to ${KIND_LABEL[input.kind]}: ${note}`;
}

/**
 * @brief 改过之后的 detail：依据追加，`## Revisions` 追加一行（note），source 按 sourceAfter（§6.4），
 *        移到另一种时 kind 为目标种类（§6.9）。
 */
function updatedDetail(actor: MemoryActor, current: DetailFile, input: UpdateInput, note: string): DetailFile {
  const day = dayOf(actor);
  return { ...current,
    kind: input.kind ?? current.kind,
    abstract: input.abstract !== undefined ? oneLine(input.abstract).trim() : current.abstract,
    details: input.detail ?? current.details,
    source: sourceAfter(actor.caller, input.asked === true, current.source),
    modified: `${day} · ${actor.by}`,
    evidence: [...current.evidence, ...(input.evidence ?? []).map(canonicalEvidence)],
    history: [...current.history, `${monthDay(day)} · ${actor.by}: ${note}`] };
}

/**
 * @brief 把改过的条目放回索引：种类不变时原位；移到另一种时从原种类的索引去掉、加在目标种类的末尾（§6.9）。
 * @param from 原种类的状态
 * @param into 目标种类的状态（种类不变时就是 from）
 * @param entry 改过的条目
 */
function placeEntry(from: KindState, into: KindState, entry: LoadedEntry): void {
  if (into !== from) {
    from.items = from.items.filter((item) => item.slug !== entry.slug);
    from.entries.delete(entry.slug);
    into.items.push({ slug: entry.slug, abstract: entry.detail.abstract });
  }
  into.entries.set(entry.slug, entry);
}

/** @brief 按 Facts、TASTE、STRATEGY、REVIEW 的顺序去重（修订与事件的 kinds，§9.8）。 */
function kindsIn(kinds: readonly MemoryKind[]): MemoryKind[] {
  return MEMORY_KINDS.filter((kind) => kinds.includes(kind));
}

/**
 * @brief 改一条（§6.1）：新 abstract、新 detail 可选，依据追加，修订一行追加；位置不变。增强任务给了目标种类时
 *        同一层里移到那一种（§6.9：slug 不变，原种类的索引去掉、目标种类末尾，预算按目标种类，修订一处 Changed 带
 *        fromKind）。条目已经不在时为 ENTRY_GONE（§8）。记忆页的修订说明固定为 PAGE_EDIT_NOTE（input.note 不用）。
 * @param actor 写入的一方
 * @param input 条目与改动
 */
export async function update(actor: MemoryActor, input: UpdateInput): Promise<MemoryWriteResult> {
  return enqueue(() => guarded(() => updateNow(actor, input)));
}

/** @brief 修改前的检查：谁能改（移动时带目标种类）与记忆页的字段；可以改时为 null。 */
function updateRefusal(actor: MemoryActor, input: UpdateInput, state: KindState, entry: LoadedEntry): string | null {
  const move = input.kind !== undefined ? { toKind: input.kind } : {};
  return writeRefusal(actor.caller, { layer: input.target.layer, kind: state.kind, source: entry.detail.source,
    abstract: entry.detail.abstract, ...move }) ?? (isPage(actor)
    ? pageFieldError(input.abstract ?? entry.detail.abstract, input.detail ?? entry.detail.details) : null);
}

/** @brief update 在队列里做的部分。 */
async function updateNow(actor: MemoryActor, input: UpdateInput): Promise<MemoryWriteResult> {
  const { target } = input;
  const { base, error } = layerBase(target.cwd, target.layer);
  const blocked = error ?? runError(actor);
  if (blocked) return failed(blocked);
  const found = await locate(base, target.id, target.kind);
  if ('error' in found) return failed(found.error);
  const { state, entry } = found;
  const refusal = updateRefusal(actor, input, state, entry);
  if (refusal) return failed(refusal);
  const note = changeNote(actor, input, state.kind);
  const detail = updatedDetail(actor, entry.detail, input, note);
  const text = renderDetail(detail);
  const into = detail.kind === state.kind ? state : await readKind(base, detail.kind);
  placeEntry(state, into, { slug: entry.slug, detail, text });
  const budget = await budgetFor(target.cwd, into.kind, target.layer, listsFor(target.layer, abstractsOf(into)));
  if (budget) return failed(budget);
  const place: EntryPlace = { layer: target.layer, slug: entry.slug };
  const moved = into !== state ? { fromKind: state.kind } : {};
  const change = withLines({ action: 'changed', kind: into.kind, ...moved, from: place, to: { ...place },
    before: entry.text, after: text }, evidenceText(input.evidence ?? []), note);
  return apply(actor, { ...singlePlan(target.cwd, state, target.layer), kinds: kindsIn([state.kind, into.kind]),
    id: null, title: titleOf(actor.by, 'Changed', into.kind, detail.abstract),
    writes: [{ path: entryPath(base, entry.slug), text }, indexWrite(into), ...(into !== state ? [indexWrite(state)]
      : [])], removes: [], changes: [change] });
}

/**
 * @brief 删一条（§6.1）：去掉索引行、删文件，原因进修订的 Note 行；从不因预算被拒绝（§6.3）。
 *        条目已经不在时为 ENTRY_GONE（§8）。
 * @param actor 写入的一方
 * @param input 条目与原因
 */
export async function forget(actor: MemoryActor, input: ForgetInput): Promise<MemoryWriteResult> {
  return enqueue(() => guarded(() => forgetNow(actor, input)));
}

/** @brief forget 在队列里做的部分。 */
async function forgetNow(actor: MemoryActor, input: ForgetInput): Promise<MemoryWriteResult> {
  const { target } = input;
  const { base, error } = layerBase(target.cwd, target.layer);
  const blocked = error ?? runError(actor);
  if (blocked) return failed(blocked);
  const found = await locate(base, target.id, target.kind);
  if ('error' in found) return failed(found.error);
  const { state, entry } = found;
  const refusal = writeRefusal(actor.caller, { layer: target.layer, kind: state.kind, source: entry.detail.source,
    abstract: entry.detail.abstract });
  if (refusal) return failed(refusal);
  state.items = state.items.filter((item) => item.slug !== entry.slug);
  state.entries.delete(entry.slug);
  const change = withLines({ action: 'deleted', kind: state.kind, from: { layer: target.layer, slug: entry.slug },
    to: null, before: entry.text, after: '' }, evidenceText(input.evidence ?? []), oneLine(input.note).trim());
  return apply(actor, { ...singlePlan(target.cwd, state, target.layer), id: null,
    title: titleOf(actor.by, 'Deleted', state.kind, entry.detail.abstract), writes: [indexWrite(state)],
    removes: [entryPath(base, entry.slug)], changes: [change] });
}

/** @brief 移动后的 detail（§3.2）：source 为 user，modified 当天 · 谁，`## Revisions` 追加移动的一行。 */
function movedDetail(actor: MemoryActor, current: DetailFile, to: MemoryLayer): DetailFile {
  const day = dayOf(actor);
  return { ...current, source: 'user', modified: `${day} · ${actor.by}`,
    history: [...current.history, `${monthDay(day)} · ${actor.by}: ${MOVE_TEXT[to]}`] };
}

/**
 * @brief 移动（§6.1）：本项目 → 用户级（Move to user level）或用户级 → 本项目（Move to this project）。
 *        沿用 slug（目标层已有同名时加后缀），加在目标层索引末尾；预算按目标层检查（§6.3）；修订写进两层。
 * @param actor 写入的一方（记忆页）
 * @param cwd 工作目录
 * @param from 原层
 * @param id 原层的 slug
 * @return id 为目标层的 slug
 */
export async function move(actor: MemoryActor, cwd: string, from: MemoryLayer, id: string): Promise<MemoryWriteResult> {
  return enqueue(() => guarded(() => moveNow(actor, cwd, from, id)));
}

/** @brief move 在队列里做的部分。 */
async function moveNow(actor: MemoryActor, cwd: string, from: MemoryLayer, id: string): Promise<MemoryWriteResult> {
  const to: MemoryLayer = from === 'project' ? 'user' : 'project';
  const project = projectDir(cwd);
  if (project.error) return failed(project.error);
  const bases: Record<MemoryLayer, string> = { user: userBase(), project: project.dir };
  const found = await locate(bases[from], id);
  if ('error' in found) return failed(found.error);
  const { state: source, entry } = found;
  const target = await readKind(bases[to], source.kind);
  const taken = await takenSlugs(bases[to]);
  const slug = uniqueSlug(entry.slug, (name) => taken.has(name.toLowerCase()));
  const detail = movedDetail(actor, entry.detail, to);
  const text = renderDetail(detail);
  source.items = source.items.filter((item) => item.slug !== entry.slug);
  source.entries.delete(entry.slug);
  target.items.push({ slug, abstract: detail.abstract });
  target.entries.set(slug, { slug, detail, text });
  const after = { [from]: abstractsOf(source), [to]: abstractsOf(target) } as Record<MemoryLayer, string[]>;
  const budget = await budgetFor(cwd, source.kind, to, after);
  if (budget) return failed(budget);
  return apply(actor, { cwd, bases, kinds: [source.kind], rollbackOf: null, id: slug,
    title: `${actor.by} · ${MOVE_TEXT[to]}: ${clipTitle(detail.abstract)}`,
    writes: [{ path: entryPath(bases[to], slug), text }, indexWrite(target), indexWrite(source)],
    removes: [entryPath(bases[from], entry.slug)],
    changes: [{ action: 'moved', kind: source.kind, from: { layer: from, slug: entry.slug }, to: { layer: to, slug },
      note: MOVE_TEXT[to], before: entry.text, after: text }] });
}

// ---- 回滚（§6.6） ----

/** @brief 回滚时读到的各层各种与要做的改动，最后一起写。 */
interface Workspace {
  /** 两层的目录；本项目不可用时没有 project */
  bases: Partial<Record<MemoryLayer, string>>;
  /** pi 的 parseFrontmatter */
  parse: FrontmatterParser;
  /** 按 `<layer>/<kind>` */
  states: Map<string, KindState>;
  /** 每层已用的名字（小写） */
  taken: Map<MemoryLayer, Set<string>>;
  /** 要写回的条目文件 */
  writes: FileWrite[];
  /** 要删的条目文件 */
  removes: string[];
  /** 恢复了条目（要查预算）的 `<layer>/<kind>` */
  restored: Set<string>;
  /** 回滚这次的改动（原改动的反方向） */
  changes: RevisionChange[];
}

/** @brief 一份 detail 原文的 abstract；空或读不出来时为 null。 */
function abstractFrom(text: string, parse: FrontmatterParser): string | null {
  if (text === '') return null;
  try {
    return parseDetail(text, parse).abstract;
  } catch (error) {
    console.error(`[kernel] reading the abstract of a revision's entry text failed: ${errorText(error)}`);
    return null;
  }
}

/** @brief 这一层里比 afterId 晚、改到同一个条目的最早一次修订的标题；找不到时为 null（§6.6）。 */
async function laterRevision(base: string, afterId: string, place: EntryPlace, parse: FrontmatterParser):
  Promise<string | null> {
  for (const id of (await revisionNames(base)).filter((name) => name > afterId)) {
    try {
      const later = await readRevision(base, id, parse);
      if (later?.changes.some((change) => touches(change, place))) return later.title;
    } catch (error) {
      console.error(`[kernel] revision ${revisionPath(base, id)} can't be read: ${errorText(error)}`);
    }
  }
  return null;
}

/**
 * @brief 冲突（§6.6）：有条目现在的整个文件不等于修订的 after 时整次拒绝，原因写出之后改过它的修订。
 * @return 原因；没有冲突时为 null
 */
async function findConflict(revision: RevisionDetail, bases: Partial<Record<MemoryLayer, string>>,
  parse: FrontmatterParser): Promise<string | null> {
  for (const change of revision.changes) {
    const place = (change.to ?? change.from)!;
    const base = bases[place.layer]!;
    const current = await readText(entryPath(base, place.slug));
    if (!rollbackConflict(change, current)) continue;
    const abstract = [current ?? '', change.after, change.before].map((text) => abstractFrom(text, parse))
      .find((each) => each !== null) ?? place.slug;
    const later = await laterRevision(base, revision.id, place, parse);
    return later === null ? `“${abstract}” changed later.`
      : `“${abstract}” changed later (${later}). Roll back that revision first.`;
  }
  return null;
}

/** @brief 回滚里某一层某一种的状态（第一次用到时读）。 */
async function workState(work: Workspace, layer: MemoryLayer, kind: MemoryKind): Promise<KindState> {
  const key = `${layer}/${kind}`;
  let state = work.states.get(key);
  if (!state) {
    state = await readKind(work.bases[layer]!, kind);
    work.states.set(key, state);
  }
  return state;
}

/** @brief 回滚里某一层已用的名字。 */
async function takenOf(work: Workspace, layer: MemoryLayer): Promise<Set<string>> {
  let taken = work.taken.get(layer);
  if (!taken) {
    taken = await takenSlugs(work.bases[layer]!);
    work.taken.set(layer, taken);
  }
  return taken;
}

/** @brief 删掉一条：去掉索引行、删文件。 */
async function dropEntry(work: Workspace, place: EntryPlace, kind: MemoryKind): Promise<void> {
  const state = await workState(work, place.layer, kind);
  state.items = state.items.filter((item) => item.slug !== place.slug);
  state.entries.delete(place.slug);
  work.removes.push(entryPath(state.base, place.slug));
}

/** @brief 按原文写回一条：不在索引里时加在末尾（§6.6），在时位置不变。 */
async function putEntry(work: Workspace, place: EntryPlace, kind: MemoryKind, text: string): Promise<void> {
  const state = await workState(work, place.layer, kind);
  if (!state.items.some((item) => item.slug === place.slug)) {
    state.items.push({ slug: place.slug, abstract: abstractFrom(text, work.parse) ?? place.slug });
  }
  try {
    state.entries.set(place.slug, { slug: place.slug, detail: parseDetail(text, work.parse), text });
  } catch (error) {
    console.error(`[kernel] restoring ${entryPath(state.base, place.slug)}: ${errorText(error)}`);
    state.entries.delete(place.slug);
  }
  work.writes.push({ path: entryPath(state.base, place.slug), text });
  work.restored.add(`${place.layer}/${kind}`);
  (await takenOf(work, place.layer)).add(place.slug.toLowerCase());
}

/**
 * @brief 撤销一处修改：按 before 原文写回；移到另一种的（§6.9）从目标种类的索引去掉、回到原种类（不在时加在末尾），
 *        记为反方向的移动。
 */
async function undoChanged(work: Workspace, change: RevisionChange): Promise<void> {
  const back = change.fromKind ?? change.kind;
  if (back !== change.kind) {
    const state = await workState(work, change.to!.layer, change.kind);
    state.items = state.items.filter((item) => item.slug !== change.to!.slug);
    state.entries.delete(change.to!.slug);
  }
  await putEntry(work, change.to!, back, change.before);
  work.changes.push({ action: 'changed', kind: back, ...(back !== change.kind ? { fromKind: change.kind } : {}),
    from: { ...change.to! }, to: { ...change.to! }, before: change.after, after: change.before });
}

/** @brief 撤销一处改动，并记下反方向的改动（§6.6）。移动回到原层末尾，原层已有同名时加后缀。 */
async function undoChange(work: Workspace, change: RevisionChange): Promise<void> {
  const { kind } = change;
  if (change.action === 'added') {
    await dropEntry(work, change.to!, kind);
    work.changes.push({ action: 'deleted', kind, from: { ...change.to! }, to: null, before: change.after, after: '' });
  } else if (change.action === 'deleted') {
    await putEntry(work, change.from!, kind, change.before);
    work.changes.push({ action: 'added', kind, from: null, to: { ...change.from! }, before: '', after: change.before });
  } else if (change.action === 'changed') {
    await undoChanged(work, change);
  } else {
    await dropEntry(work, change.to!, kind);
    const taken = await takenOf(work, change.from!.layer);
    const place: EntryPlace = { layer: change.from!.layer,
      slug: uniqueSlug(change.from!.slug, (name) => taken.has(name.toLowerCase())) };
    await putEntry(work, place, kind, change.before);
    work.changes.push({ action: 'moved', kind, from: { ...change.to! }, to: place, before: change.after,
      after: change.before });
  }
}

/** @brief 回滚之后的预算（§6.3、§6.6）：只查恢复了条目的层与种类（只删除的不查）。 */
async function rollbackBudget(work: Workspace, cwd: string | null): Promise<string | null> {
  for (const key of work.restored) {
    const [layer, kind] = key.split('/') as [MemoryLayer, MemoryKind];
    const lists: Partial<Record<MemoryLayer, string[]>> = {};
    for (const each of MEMORY_LAYERS) {
      const state = work.states.get(`${each}/${kind}`);
      if (state) lists[each] = abstractsOf(state);
    }
    const error = await budgetFor(cwd, kind, layer, lists);
    if (error) return error;
  }
  return null;
}

/** @brief 回滚的计划：先写恢复的条目，再写改到的索引，再删文件；修订 `Rolled back: <标题>`，写进改到的每一层。 */
function rollbackPlan(work: Workspace, revision: RevisionDetail, cwd: string | null): Plan {
  const touched = new Set(work.changes.flatMap((change) => [change.from?.layer, change.to?.layer]));
  const bases: Partial<Record<MemoryLayer, string>> = {};
  for (const layer of MEMORY_LAYERS) if (touched.has(layer)) bases[layer] = work.bases[layer];
  const kinds = kindsIn(work.changes.flatMap((change) => [change.kind, ...(change.fromKind ? [change.fromKind] : [])]));
  return { cwd: bases.project ? cwd : null, bases, kinds, title: `Rolled back: ${revision.title}`,
    rollbackOf: revision.id, id: null, writes: [...work.writes, ...[...work.states.values()].map(indexWrite)],
    removes: work.removes, changes: work.changes };
}

/** @brief 回滚用到的两层目录：本项目取修订记下的 cwd（没有时取调用方的）。 */
function rollbackBases(cwd: string | null): { bases: Partial<Record<MemoryLayer, string>>; error: string | null } {
  if (cwd === null) return { bases: { user: userBase() }, error: NO_PROJECT };
  const { dir, error } = projectDir(cwd);
  return { bases: error ? { user: userBase() } : { user: userBase(), project: dir }, error };
}

/**
 * @brief 回滚一次修订（§6.6）：每处改动恢复成 before（文件逐字相同、source 随之恢复），移动回到原层；
 *        之后又被改过、超出预算、运行中时整次拒绝。回滚写一条 `by: Rollback` 的修订，可以再回滚。水位不动。
 * @param actor 写入的一方（修订的 by 一律记为 Rollback）
 * @param cwd 工作目录；只看用户级时为 null
 * @param layer 修订所在的层
 * @param id 修订 id
 */
export async function rollback(actor: MemoryActor, cwd: string | null, layer: MemoryLayer, id: string):
  Promise<MemoryWriteResult> {
  return enqueue(() => guarded(() => rollbackNow({ ...actor, by: 'Rollback' }, cwd, layer, id)));
}

/** @brief rollback 在队列里做的部分。 */
async function rollbackNow(actor: MemoryActor, cwd: string | null, layer: MemoryLayer, id: string):
  Promise<MemoryWriteResult> {
  const { base, error } = layerBase(cwd, layer);
  if (error) return failed(error);
  const parse = await parser();
  const target = isSafeName(id) ? await readRevision(base, id, parse) : null;
  if (!target) return failed(REVISION_GONE);
  if (target.status === 'running') return failed(RUN_GOING);
  if (target.changes.length === 0) return failed(NO_CHANGES);
  const projectCwd = target.cwd ?? cwd;
  const { bases, error: projectError } = rollbackBases(projectCwd);
  const unreachable = target.changes.some((change) => [change.from, change.to]
    .some((place) => place !== null && bases[place.layer] === undefined));
  if (unreachable) return failed(projectError ?? NO_PROJECT);
  const conflict = await findConflict(target, bases, parse);
  if (conflict) return failed(conflict);
  const work: Workspace = { bases, parse, states: new Map(), taken: new Map(), writes: [], removes: [],
    restored: new Set(), changes: [] };
  for (const change of target.changes) await undoChange(work, change);
  const budget = await rollbackBudget(work, projectCwd);
  if (budget) return failed(budget);
  return apply(actor, rollbackPlan(work, target, projectCwd));
}

// ---- 增强运行的修订（§9.8、§9.10） ----

/**
 * @brief 开始一次增强运行（§9.8）：在建立看不见的会话之前调用，立即写出 `status: running` 的修订
 *        （标题 `<KIND> enhancement · <Mon D>`），发 mori.memory_changed。enhance.json 的 running 由增强调度记。
 * @throws Error 项目目录被占用（§3 的原文）或写入失败
 */
export async function beginRun(spec: RunSpec): Promise<RunHandle> {
  return queuedRun(`starting the ${spec.task} enhancement run in ${spec.cwd}`, async () => {
    const { dir, error } = projectDir(spec.cwd);
    if (error) throw new Error(error);
    await claimProject(spec.cwd, dir);
    const now = new Date();
    const id = nextRevisionId(now);
    const record: RevisionDetail = { id, time: localIso(now), by: 'Enhancement',
      title: `${KIND_LABEL[spec.task]} enhancement · ${monthDay(spec.day)}`, status: 'running', layers: ['project'],
      kinds: [spec.task], counts: countChanges([]), rollbackOf: null, changes: [], notes: null,
      run: { task: spec.task, day: spec.day, tokens: null, sessions: spec.sessions, feedback: spec.feedback },
      cwd: spec.cwd };
    await writeFileAtomic(revisionPath(dir, id), renderRevision(record));
    const handle: RunHandle = Object.freeze({ id, cwd: spec.cwd, task: spec.task, day: spec.day });
    runs.set(id, { handle, revision: record, dir });
    emitChanged(spec.cwd, ['project'], [spec.task], id);
    return handle;
  });
}

/** @brief 增强运行修订的队列任务：失败时记错误日志并照样抛出（调用方按运行失败处理）。 */
function queuedRun<T>(what: string, job: () => Promise<T>): Promise<T> {
  return enqueue(async () => {
    try {
      return await job();
    } catch (error) {
      console.error(`[kernel] ${what} failed: ${errorText(error)}`);
      throw error;
    }
  });
}

/** @brief Notes 不超过 4000 字符，超出截断并注明 (truncated)（§3.3）。 */
function clipNotes(notes: string): string {
  const chars = [...notes.trim()];
  const max = MEMORY_DEFAULTS.notesMax;
  return chars.length > max ? `${chars.slice(0, max).join('')}\n(truncated)` : chars.join('');
}

/**
 * @brief 结束一次增强运行（§9.8）：定为 done 或 failed，补上 run.tokens，写 `## Notes`（最后一条助手消息的正文或失败原因，
 *        ≤ 4000 字符；null 时不写这一节），发 mori.memory_changed。enhance.json 的 running 由增强调度清掉。
 *        每个句柄只结束一次：已经结束的运行再结束时报 RUN_ENDED，不改已定下的状态；写入失败时运行仍算进行中，可以再结束。
 * @return 这次运行的计数与修订 id
 * @throws Error 运行已经结束，或写入失败
 */
export async function endRun(handle: RunHandle, result: { status: 'done' | 'failed'; tokens: number;
  notes: string | null }): Promise<{ counts: RevisionCounts; revision: string }> {
  return queuedRun(`finishing revision ${handle.id}`, async () => {
    const state = runs.get(handle.id);
    if (!state) throw new Error(RUN_ENDED);
    const { revision } = state;
    const record: RevisionDetail = { ...revision, status: result.status,
      run: revision.run && { ...revision.run, tokens: result.tokens },
      notes: result.notes === null ? null : clipNotes(result.notes) };
    await writeFileAtomic(revisionPath(state.dir, handle.id), renderRevision(record));
    runs.delete(handle.id);
    emitChanged(handle.cwd, ['project'], record.kinds, handle.id);
    return { counts: record.counts, revision: handle.id };
  });
}

/**
 * @brief 上次后台进程在运行中退出（§9.10）：把那条 running 的修订定为 failed，Notes 写 RUN_CLOSED。
 *        已经不是 running 的修订不改。
 * @param cwd 项目的工作目录
 * @param revisionId enhance.json 里 tasks.<task>.running 记下的修订 id
 * @return 这条修订的计数（有改动时增强调度把它加进 notice）；修订不在或读不出来时为 null
 */
export async function failStaleRun(cwd: string, revisionId: string): Promise<RevisionCounts | null> {
  return enqueue(async () => {
    // 这个进程里 endRun 没写成的运行还留着它的状态：一并释放（它不会再结束）
    runs.delete(revisionId);
    try {
      const { dir, error } = projectDir(cwd);
      if (error) throw new Error(error);
      const record = isSafeName(revisionId) ? await readRevision(dir, revisionId, await parser()) : null;
      if (!record) throw new Error(`The revision ${revisionId} doesn’t exist.`);
      if (record.status === 'running') {
        record.status = 'failed';
        record.notes = RUN_CLOSED;
        await writeFileAtomic(revisionPath(dir, revisionId), renderRevision(record));
        emitChanged(cwd, ['project'], record.kinds, revisionId);
      }
      return record.counts;
    } catch (error) {
      console.error(`[kernel] closing the stale run ${revisionId} in ${cwd} failed: ${errorText(error)}`);
      return null;
    }
  });
}
