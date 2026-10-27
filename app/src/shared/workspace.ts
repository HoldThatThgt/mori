// 文件系统的进程桥协议（docs/specs/file-system.md §12，后台进程第 9 件事“工作区”）：git 状态、快照与一轮的改动、Rewind、
// 收窄的拒绝开头、你不在的时长与记录、ask_user_question 的问题与答案、worktree 的路径规则，以及界面认出程序拒绝用的开头表。
// 界面与后台进程共用；这里只有类型、zod schema、常量与纯函数（不读文件、不调 git、不 import node:*，界面也能用）。

import { z } from 'zod';
import type { QuoteRef, SessionEntry } from './protocol';
import type { InstanceKind } from './team';

const sessionId = z.string().min(1);

// ---- §3 git 与工作路径 ----

/** @brief 工作路径所在的 git 仓库（§3.4）；不是 git 仓库时整个为 null。 */
export interface RepoInfo {
  /** 仓库根（--show-toplevel，绝对路径，反斜杠） */
  toplevel: string;
  /** 共用的 .git 目录（--git-common-dir） */
  commonDir: string;
  /** 这个 worktree 自己的 git 目录（--git-dir）；不是 worktree 时等于 commonDir */
  gitDir: string;
  /** 是链接出去的 worktree（gitDir !== commonDir） */
  isWorktree: boolean;
  /** 有没有提交（HEAD 指向一个提交） */
  hasCommit: boolean;
}

/** @brief git 程序的状态（§3.2）：ok 带版本；old 是版本太低（< 2.32）；missing 是没找到。 */
export type GitState = { state: 'ok' | 'old'; version: string } | { state: 'missing' };

/** @brief git 状态里的一个文件（porcelain v2 的一条，§3.5）。 */
export interface StatusFile {
  /** 相对仓库根的路径，/ 分隔；未跟踪的目录以 / 结尾 */
  path: string;
  /** 重命名、复制的原路径；其他为 null */
  from: string | null;
  /** 分组 */
  group: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
  /** 状态字母：暂存区的 X 或工作区的 Y；未合并为 U，未跟踪为 ? */
  code: string;
}

/** @brief 一个工作路径的快照状态（§4.4，WorkspaceStatus.snapshots）。 */
export interface SnapshotState {
  /** on：照常；paused：暂停（reason 写原因）；off：不可用（git 不是 ok、归属冲突） */
  state: 'on' | 'paused' | 'off';
  /** paused、off 的原因原文；on 时为 null */
  reason: string | null;
  /** 最近一次快照失败的原文（Couldn’t take a snapshot 后面那部分）；成功一次就清掉 */
  error: string | null;
  /** 最近一次快照跳过的大文件（相对工作路径），最多 20 个 */
  skipped: string[];
  /** 跳过的大文件总数 */
  skippedTotal: number;
  /** 最近一张快照里嵌套的 git 仓库（gitlink，相对工作路径），最多 20 个 */
  nested: string[];
  /** 嵌套仓库的总数 */
  nestedTotal: number;
}

/** @brief 右栏上半部分与快照状态的来源（mori.workspace_status 与 workspace.status 的结果，§3.5）。 */
export interface WorkspaceStatus {
  /** 工作路径 */
  cwd: string;
  /** git 程序 */
  git: GitState;
  /** 所在仓库；不是 git 仓库、git 不是 ok 时为 null */
  repo: RepoInfo | null;
  /** 分支（git status 的 # branch.* 行）；没有仓库或读失败时为 null */
  branch: {
    /** 分支名；detached 为 null */
    head: string | null;
    /** 当前提交；还没有提交（(initial)）为 null */
    oid: string | null;
    /** 上游；没有为 null */
    upstream: string | null;
    /** 领先；没有上游为 null，有上游却没有 branch.ab（上游已不在）也为 null */
    ahead: number | null;
    /** 落后；同 ahead */
    behind: number | null;
  } | null;
  /** 未提交的文件，最多 STATUS_FILE_LIMIT 条 */
  files: StatusFile[];
  /** 全部条数（truncated 时为已解析的条数） */
  total: number;
  /** 输出超过上限，只解析了一部分 */
  truncated: boolean;
  /** 认仓库或 git status 失败的原文；没有为 null */
  error: string | null;
  /** 这个工作路径的快照状态 */
  snapshots: SnapshotState;
  /** 读完的时刻（ms） */
  at: number;
}

/** @brief git 状态最多列出的条数（§17）。 */
export const STATUS_FILE_LIMIT = 500;

/** @brief git 的最低版本（§3.2）：GIT_CONFIG_GLOBAL 从 2.32 起。 */
export const MIN_GIT_VERSION = '2.32';

// ---- §4 一轮的改动 ----

/** @brief 一段里标出的 Agent（§4.5）：self 为用户会话自己的运行，role 为持有对话的角色；实例为它的角色与 task。 */
export const RunAgentSchema = z.object({
  role: z.string(),
  task: z.string().nullable(),
  self: z.boolean(),
});
export type RunAgent = z.infer<typeof RunAgentSchema>;

/** @brief 运行记录（§4.6）：这条你的消息开始的那次运行的开始、结束快照。 */
export const RunRecordSchema = z.object({
  v: z.literal(1),
  kind: z.literal('run'),
  /** 起始消息的条目 id（这一轮） */
  round: z.string().min(1),
  /** 开始快照的提交 */
  start: z.string().min(1),
  /** 结束快照的提交；没拍成为 null */
  end: z.string().nullable(),
  /** 写下的时刻（ms） */
  at: z.number(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** @brief 一段改动里的一个文件（§4.6）。 */
export const ChangedFileSchema = z.object({
  /** 相对工作路径，/ 分隔 */
  path: z.string().min(1),
  /** --raw 的 A、M、D（T 记为 M） */
  status: z.enum(['A', 'M', 'D']),
  /** --numstat 的增加行数；二进制为 null */
  added: z.number().int().nonnegative().nullable(),
  /** --numstat 的删除行数；二进制为 null */
  removed: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** @brief 一段的改动（§4.5、§4.6）。 */
export const ChangesRecordSchema = z.object({
  v: z.literal(1),
  kind: z.literal('changes'),
  /** 记进的轮：你的一条消息的条目 id */
  round: z.string().min(1),
  /** 这一段两端的快照 */
  base: z.string().min(1),
  head: z.string().min(1),
  /** 改动的文件，最多 CHANGES_FILE_LIMIT 个，按路径排序 */
  files: z.array(ChangedFileSchema),
  /** 这一段改动的文件总数（多于 files 时界面说明没列全；Rewind 用 git 重新算全） */
  total: z.number().int().nonnegative(),
  /** 这一段在跑的这个会话的 Agent */
  agents: z.array(RunAgentSchema),
  /** 同一工作路径（或包含、被包含的工作路径）上别的用户会话这段时间也在运行 */
  overlap: z.boolean(),
  at: z.number(),
});
export type ChangesRecord = z.infer<typeof ChangesRecordSchema>;

/** @brief mori.turn_changes 条目与事件的内容（§4.6）。 */
export const TurnChangesSchema = z.discriminatedUnion('kind', [RunRecordSchema, ChangesRecordSchema]);
export type TurnChanges = z.infer<typeof TurnChangesSchema>;

/** @brief 一段记录里最多列出的文件数（§17）。 */
export const CHANGES_FILE_LIMIT = 500;

// ---- §5 Rewind ----

/** @brief 一次 Rewind（kind: rewind）或它的 Undo（kind: undo），mori.rewind 条目与事件（§5.9）。 */
export const RewindRecordSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['rewind', 'undo']),
  /** rewind：回到哪条你的消息之前；undo：撤销的那条 mori.rewind 的条目 id */
  target: z.string().min(1),
  /** rewind：M 当时是第几轮（通知里写 turn <n>）；undo 为 null */
  turn: z.number().int().positive().nullable(),
  /** 恢复了代码 / 对话 */
  code: z.boolean(),
  conversation: z.boolean(),
  /** 恢复对话前的叶子（Undo 回到这里）；没有恢复对话为 null */
  from: z.string().nullable(),
  /** 保险快照 P、恢复后快照 Q；只恢复对话时为 null */
  safety: z.string().nullable(),
  post: z.string().nullable(),
  /** 恢复的、删掉的、跳过的、失败的文件：各最多 REWIND_LIST_LIMIT 个，另记总数 */
  restored: z.array(z.string()),
  deleted: z.array(z.string()),
  skipped: z.array(z.string()),
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
  counts: z.object({
    restored: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  at: z.number(),
});
export type RewindRecord = z.infer<typeof RewindRecordSchema>;

/** @brief 冲突列表、记录里的文件列表各最多多少条（§17）。 */
export const REWIND_LIST_LIMIT = 200;

/** @brief 冲突的一项（§5.6）：changed 最近一张快照之后又变了；overlap 同时运行时改的。两种都是时记 changed。 */
export interface RewindConflict {
  /** 相对工作路径，/ 分隔 */
  path: string;
  reason: 'changed' | 'overlap';
}

/** @brief 带回的冲突选择（§5.11）：token 原样带回上一次结果里的。 */
export const ConflictChoiceSchema = z.object({
  action: z.enum(['overwrite', 'skip']),
  token: z.string().min(1),
});
export type ConflictChoice = z.infer<typeof ConflictChoiceSchema>;

/** @brief rewind 与 rewind.undo 的结果（§5.11）；不能做时命令失败，错误原文见 §5.5–§5.9。 */
export type RewindResult =
  | {
    kind: 'conflicts';
    /** 按路径排序，最多 REWIND_LIST_LIMIT 条 */
    conflicts: RewindConflict[];
    /** 全部冲突的条数 */
    total: number;
    /** 按路径排序的全部冲突（路径与原因）的 SHA-1 前 16 位 */
    token: string;
  }
  | {
    kind: 'done';
    /** 写下的 mori.rewind 条目 id */
    entryId: string;
    record: RewindRecord;
    /** 回到输入框的文字（恢复对话时为 M 的正文）；Undo 为 null */
    editorText: string | null;
    /** M 的引用（M 的 mori.ref）；没有为 null */
    refs: QuoteRef[] | null;
    /** 恢复了对话时为新的当前分支（同 session.open 的 entries），否则 null */
    entries: SessionEntry[] | null;
    /** 代码已恢复、对话没能恢复时的说明（Couldn’t restore the conversation: …）；没有为 null */
    warning: string | null;
  };

/** @brief snapshots.diff 的结果（§5.3）。 */
export interface SnapshotDiff {
  /** git diff 的原文（最多 1 MB）；二进制、失败时为 null；没有差别时为空串 */
  patch: string | null;
  /** 二进制文件 */
  binary: boolean;
  /** 超过 1 MB，只给了前 1 MB */
  truncated: boolean;
  /** 失败的原文（含 §4.7 的整理原文）；没有为 null */
  error: string | null;
}

// ---- §8 收窄 ----

/** @brief 收窄的来源：谁的收窄决定拒绝原文的开头（§8.3、§8.4）。 */
export type NarrowingOwner = 'task' | 'ask' | 'create' | 'close' | 'subscription' | 'dialog';

/** @brief 收窄拒绝原文的开头（§8.3）；dialog 用整句 RELAY_ONLY。 */
export const NARROWING_LEADS: Readonly<Record<Exclude<NarrowingOwner, 'dialog'>, string>> = Object.freeze({
  task: 'Not allowed for this task',
  ask: 'Not allowed for this question',
  create: 'Not allowed while deciding requests',
  close: 'Not allowed while closing a request',
  subscription: 'Not allowed in a subscription',
});

/** @brief 协作模式下对话会话与合并会话越界时的拒绝原文（平行 Agent 规格 §5.5，原文不变）。 */
export const RELAY_ONLY = 'Team mode is on: the dialog agent only relays; the work is done in tasks.';

// ---- §6、§7 程序拒绝的开头 ----

/** @brief 没人能批（§6.15）时拒绝原文的开头。 */
export const DENIED_BY_MORI_PREFIX = 'Denied by Mori: ';

/** @brief .work 建不起来（§7.10）时拒绝原文的开头。 */
export const WORK_DENIAL_PREFIX = "Mori couldn't prepare .work in the working directory";

// ---- §9 你不在 ----

/** @brief When you’re away 的四档（§9.6）。 */
export const AWAY_TIMEOUTS = ['60s', '5m', '10m', 'never'] as const;
export type AwayTimeout = (typeof AWAY_TIMEOUTS)[number];

/** @brief 默认时长。 */
export const DEFAULT_AWAY_TIMEOUT: AwayTimeout = '5m';

/** @brief 三档时长的毫秒数（MORI_AWAY_TIMEOUT_MS 有值时由后台进程换成它）。 */
export const AWAY_TIMEOUT_MS: Readonly<Record<Exclude<AwayTimeout, 'never'>, number>> = Object.freeze({
  '60s': 60_000, '5m': 300_000, '10m': 600_000,
});

/** @brief 原文里写的时长（§9.4、§14）。 */
export const AWAY_DURATION_TEXT: Readonly<Record<Exclude<AwayTimeout, 'never'>, string>> = Object.freeze({
  '60s': '60 seconds', '5m': '5 minutes', '10m': '10 minutes',
});

/** @brief 批准卡到时拒绝原文的开头（§9.4）；提问卡到时的工具结果开头相同，但不是 isError。 */
export const REJECTED_AWAY_PREFIX = "The user was away and didn't answer within ";

/** @brief 你不在时卡片倒计时在最后多少秒显示（§9.9）。 */
export const AWAY_COUNTDOWN_MS = 20_000;

// ---- §10 ask_user_question ----

/** @brief 提问工具的名字（§10.1）。 */
export const ASK_TOOL = 'ask_user_question';

/** @brief 一个问题（ask_user_question 的参数项，也是 mori.question_request 里的一项，§10.2）。 */
export interface AskQuestion {
  /** 完整的问题，1–500 字符 */
  question: string;
  /** 卡上的短标签，1–12 字符 */
  header: string;
  /** 2–4 个选项 */
  options: { label: string; description: string }[];
  /** 可以选多个 */
  multiSelect: boolean;
  /** 推荐的选项：等于某个选项的 label */
  recommended: string;
}

/** @brief 一个问题的答案（工具结果的 details、mori.question_end、mori.away_decision，§10.5）。 */
export const AskAnswerSchema = z.object({
  /** 问题原文 */
  question: z.string(),
  /** 问题的 header */
  header: z.string(),
  /** 选中的 label，按选项的顺序 */
  selected: z.array(z.string()),
  /** Other 里填的文字；没填为 null */
  other: z.string().nullable(),
  /** 你不在、按推荐项自动回答 */
  auto: z.boolean(),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

/** @brief 一个挂起的提问（mori.question_request 的载荷，LiveSnapshot.asks 的一项，§10.3）。 */
export interface AskRequest {
  /** ask-<n> */
  requestId: string;
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 问题，按参数的顺序 */
  questions: AskQuestion[];
  /** 提出的时刻（ms） */
  askedAt: number;
}

/** @brief 提问结束的方式（mori.question_end.by，§10.3）。 */
export type AskEndBy = 'user' | 'declined' | 'away' | 'stop' | 'closed';

/** @brief 你拒绝回答时的工具结果（isError，§10.6）。 */
export const ASK_DECLINED_TEXT = 'The user declined to answer your questions. '
  + 'Stop what you are doing and wait for the user to tell you how to proceed.';

/** @brief 提问时你按了停止、会话关闭时的工具结果（isError，§10.6）；界面算已停止。 */
export const ASK_STOPPED_TEXT = 'Not answered: the user stopped the run.';

// ---- §9.7 自动处理记录 ----

/** @brief 一条自动处理记录（mori.away_decision 的事件与会话条目，§9.7）。 */
export const AwayDecisionSchema = z.object({
  /** 请求 id */
  requestId: z.string().min(1),
  /** 批准卡 / 提问卡 / 扩展询问卡 */
  kind: z.enum(['approval', 'question', 'extension']),
  /** 处理的时刻（ms） */
  at: z.number(),
  /** 当时的时长（不会是 never） */
  timeout: z.enum(['60s', '5m', '10m']),
  /** 后台实例的请求：哪个实例、角色、task；用户会话自己的 Agent 为 null */
  agent: z.object({
    instance: z.string(),
    role: z.string(),
    task: z.string().nullable(),
    taskTitle: z.string().nullable(),
  }).nullable(),
  /** 工具调用 id；扩展询问为 null */
  toolCallId: z.string().nullable(),
  /** 批准卡的工具名；提问卡为 ask_user_question；扩展询问为 null */
  toolName: z.string().nullable(),
  /** 批准卡的参数：每个字符串截到 300 字符，去掉 content 与 edits；其余为 null */
  args: z.record(z.string(), z.unknown()).nullable(),
  /** 扩展询问的标题；其余为 null */
  title: z.string().nullable(),
  /** 提问卡用上的推荐项；其余为 null */
  answers: z.array(AskAnswerSchema).nullable(),
  /** 拒绝 / 推荐项 / 取消 */
  result: z.enum(['denied', 'recommended', 'cancelled']),
});
export type AwayDecision = z.infer<typeof AwayDecisionSchema>;

/** @brief 一个交给无人应答模块计时的请求的截止时刻（LiveSnapshot.awayTimers 的一项，§9.5）。 */
export interface AwayTimer {
  requestId: string;
  /** 截止时刻（ms） */
  deadline: number;
}

// ---- §11 worktree ----

/** @brief mori.worktree 条目（§11.6）：这个会话拥有这个 worktree。 */
export const WorktreeEntrySchema = z.object({
  /** worktree 根：<R>\.mori\worktrees\<名字> */
  path: z.string().min(1),
  /** mori/<名字> */
  branch: z.string().min(1),
  /** 主文件夹 */
  mainFolder: z.string().min(1),
});
export type WorktreeEntry = z.infer<typeof WorktreeEntrySchema>;

/** @brief worktrees.list 的一项（§11.9.1）。 */
export interface WorktreeItem extends WorktreeEntry {
  /** 拥有它的会话 */
  sessionFile: string;
  /** 文件夹还在 */
  exists: boolean;
  /** 有未提交或未跟踪的文件（被忽略的不算）；不在、没装 git、读不出时为 null */
  changes: boolean | null;
  /** 除拥有它的会话（和它的实例）之外，有开着的会话的工作路径是它或在它里面 */
  inUse: boolean;
}

/** @brief worktrees.cleanUp 的一项结果（§11.9.1）。 */
export interface WorktreeCleanUp {
  path: string;
  removed: boolean;
  reason: 'changes' | 'in_use' | 'missing' | null;
  error: string | null;
}

/** @brief Mori worktree 名字的写法（§11.2）。 */
const WORKTREE_NAME = /^[a-z0-9-]+$/;

/** @brief worktreeOf 的结果（§11.3）。 */
export interface WorktreePlace {
  /** 它所在仓库的 R（.mori 之前的部分） */
  root: string;
  /** worktree 根：<R>\.mori\worktrees\<名字>（保留 cwd 的写法） */
  path: string;
  /** 名字 */
  name: string;
  /** mori/<名字> */
  branch: string;
  /** 主文件夹：R 接上 <名字> 之后剩下的段 */
  mainFolder: string;
}

/** @brief 把段接回路径；只剩盘符（D:）时补上分隔符，得到盘符根。 */
function joinSegments(segments: string[], sep: string): string {
  const joined = segments.join(sep);
  return /^[A-Za-z]:$/.test(joined) ? `${joined}${sep}` : joined;
}

/**
 * @brief Mori worktree 里的路径（§11.3）：从左找第一处连续三段 .mori、worktrees、<名字>（前两段不分大小写，
 *        名字只含 a-z0-9-）；不在 Mori worktree 里时为 null。结果保留 cwd 原来的写法（分隔符用 cwd 里的）。
 */
export function worktreeOf(cwd: string): WorktreePlace | null {
  const sep = cwd.includes('\\') ? '\\' : '/';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  // 从第二段起找：.mori 之前至少要有一段（R）
  for (let i = 1; i + 2 < segments.length; i++) {
    const name = segments[i + 2];
    if (segments[i].toLowerCase() !== '.mori' || segments[i + 1].toLowerCase() !== 'worktrees') continue;
    if (!WORKTREE_NAME.test(name)) continue;
    const root = joinSegments(segments.slice(0, i), sep);
    return {
      root,
      path: segments.slice(0, i + 3).join(sep),
      name,
      branch: `mori/${name}`,
      mainFolder: joinSegments([...segments.slice(0, i), ...segments.slice(i + 3)], sep),
    };
  }
  return null;
}

/** @brief 会话按哪个文件夹算项目（§11.3）：Mori worktree 里时为主文件夹，否则为 cwd 本身。 */
export function projectFolder(cwd: string): string {
  return worktreeOf(cwd)?.mainFolder ?? cwd;
}

/** @brief 比较用的写法：分隔符统一为 \，去掉末尾的分隔符，小写。 */
function pathKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * @brief 第一条消息的文件引用换进 worktree（§11.5.5）：kind 为 file、path 在 from 里的，path 换成 to 下同样的相对路径
 *        （分隔符按 to）；工作路径外的、message 与 session 引用不动。
 */
export function refsInto(refs: readonly QuoteRef[], from: string, to: string): QuoteRef[] {
  const base = pathKey(from);
  const sep = to.includes('\\') || !to.includes('/') ? '\\' : '/';
  const head = to.replace(/[\\/]+$/, '');
  return refs.map((ref) => {
    if (ref.source.kind !== 'file') return ref;
    const key = pathKey(ref.source.path);
    if (key !== base && !key.startsWith(`${base}\\`)) return ref;
    const rest = ref.source.path.replace(/\//g, '\\').replace(/\\+$/, '').slice(base.length).replace(/^\\+/, '');
    const path = rest ? `${head}${sep}${rest.split('\\').join(sep)}` : head;
    return { ...ref, source: { ...ref.source, path } };
  });
}

// ---- §12 界面认出程序拒绝 ----

/** @brief 程序拒绝原文的一种开头（§12 DENIAL_PREFIXES）。 */
export interface DenialPrefix {
  /** 原文的开头；whole 为真时整句相等才算 */
  text: string;
  /** 整句比较 */
  whole: boolean;
  /** 工具卡 Denied · 后面的理由；null 时用原文全文 */
  label: string | null;
  /** 算已停止，不算拒绝（ASK_STOPPED_TEXT） */
  stopped: boolean;
}

/** @brief 程序拒绝原文的固定开头（§12）：界面在你拒绝、停止的三种原文之后按这张表认。 */
export const DENIAL_PREFIXES: readonly DenialPrefix[] = Object.freeze([
  { text: DENIED_BY_MORI_PREFIX, whole: false, label: null, stopped: false },
  ...Object.values(NARROWING_LEADS).map((lead) => ({ text: `${lead}: `, whole: false, label: null, stopped: false })),
  { text: RELAY_ONLY, whole: true, label: null, stopped: false },
  { text: REJECTED_AWAY_PREFIX, whole: false, label: 'No answer while you were away', stopped: false },
  { text: WORK_DENIAL_PREFIX, whole: false, label: null, stopped: false },
  { text: ASK_DECLINED_TEXT, whole: true, label: 'You declined to answer', stopped: false },
  { text: ASK_STOPPED_TEXT, whole: true, label: null, stopped: true },
]);

/**
 * @brief 按 DENIAL_PREFIXES 认一段工具结果原文：程序拒绝时给出工具卡的理由，ASK_STOPPED_TEXT 给出 stopped；
 *        都不是时为 null。
 */
export function denialOf(output: string): { kind: 'denied'; reason: string } | { kind: 'stopped' } | null {
  const text = output.trim();
  for (const item of DENIAL_PREFIXES) {
    const hit = item.whole ? text === item.text : text.startsWith(item.text);
    if (!hit) continue;
    if (item.stopped) return { kind: 'stopped' };
    return { kind: 'denied', reason: item.label ?? text };
  }
  return null;
}

// ---- 命令（§12） ----

const timeout = z.enum(AWAY_TIMEOUTS);

/** @brief 第 1 步（权限）的命令：你不在的时长、提问卡的答复（§9.6、§10.5）。 */
export const PermissionCommandSchemas = [
  z.object({ type: z.literal('away.get') }),
  z.object({ type: z.literal('away.set'), timeout }),
  /** answers 为 null 表示拒绝回答（Esc） */
  z.object({
    type: z.literal('question.answer'),
    sessionId,
    requestId: z.string().min(1),
    answers: z.array(z.object({ selected: z.array(z.string()), other: z.string().nullable() })).nullable(),
  }),
] as const;

/** @brief 第 2 步（git）的命令：git 状态、diff、删除会话后的整理、Rewind 与 Undo（§3.5、§4.7、§5）。 */
export const GitCommandSchemas = [
  z.object({ type: z.literal('workspace.status'), sessionId }),
  /** round 是轮的条目 id，path 相对工作路径 */
  z.object({ type: z.literal('snapshots.diff'), sessionId, round: z.string().min(1), path: z.string().min(1) }),
  /** mori:delete-session 成功后发，会话不必打开 */
  z.object({ type: z.literal('snapshots.drop'), sessionId, cwd: z.string().min(1) }),
  /** code、conversation 至少一个为真（后台进程检查） */
  z.object({
    type: z.literal('rewind'),
    sessionId,
    entryId: z.string().min(1),
    code: z.boolean(),
    conversation: z.boolean(),
    conflictChoice: ConflictChoiceSchema.optional(),
  }),
  z.object({
    type: z.literal('rewind.undo'),
    sessionId,
    undoId: z.string().min(1),
    conflictChoice: ConflictChoiceSchema.optional(),
  }),
] as const;

/** @brief 第 3 步（并行）的命令：Initialize git、worktree 的列表与清理（§11.9–§11.11）。 */
export const WorktreeCommandSchemas = [
  z.object({ type: z.literal('workspace.initGit'), sessionId }),
  z.object({ type: z.literal('worktrees.list'), sessionFiles: z.array(z.string().min(1)) }),
  z.object({ type: z.literal('worktrees.cleanUp'), paths: z.array(z.string().min(1)), force: z.boolean() }),
] as const;

/** @brief 本规格的全部命令（§12），并进 shared/protocol.ts 的 CommandSchema。 */
export const WorkspaceCommandSchemas = [
  ...PermissionCommandSchemas, ...GitCommandSchemas, ...WorktreeCommandSchemas,
] as const;

/** @brief away.get、away.set 的结果（§9.6）。 */
export interface AwaySetting {
  timeout: AwayTimeout;
  /** 读不出、写不出时的原文；没有为 null */
  error: string | null;
}

/** @brief 本规格每个命令的结果类型（§12）。 */
export interface WorkspaceCommandResults {
  'away.get': AwaySetting;
  'away.set': AwaySetting;
  'question.answer': null;
  'workspace.status': WorkspaceStatus;
  'snapshots.diff': SnapshotDiff;
  'snapshots.drop': { error: string | null };
  rewind: RewindResult;
  'rewind.undo': RewindResult;
  'workspace.initGit': { initialized: true };
  'worktrees.list': { git: boolean; items: WorktreeItem[] };
  'worktrees.cleanUp': { results: WorktreeCleanUp[] };
}

// ---- 会话条目与事件（§12） ----

/** @brief 本规格写进用户会话文件的自定义条目的 customType。 */
export const WORKSPACE_ENTRY_TYPES = Object.freeze({
  /** 一轮的改动（§4.6） */
  turnChanges: 'mori.turn_changes',
  /** Rewind 与 Undo（§5.9） */
  rewind: 'mori.rewind',
  /** 自动处理记录（§9.7） */
  awayDecision: 'mori.away_decision',
  /** 拥有的 worktree（§11.6） */
  worktree: 'mori.worktree',
});

/** @brief mori.worktree 条目的 customType（§11.6）。 */
export const WORKTREE_ENTRY_TYPE = WORKSPACE_ENTRY_TYPES.worktree;

/** @brief agent_before_settle 补的提醒（custom_message 的 customType，display: false，§9.8）。 */
export const AWAY_REMINDER_TYPE = 'mori.away_reminder';

/** @brief 本规格的后台进程事件（并进 KernelEvent，都在用户会话的信封上）。 */
export type WorkspaceEvent =
  /** git 状态读完一次，或快照状态变了（§3.5） */
  | { type: 'mori.workspace_status'; status: WorkspaceStatus }
  /** 一轮的改动，与写进会话文件的同名条目相同（§4.6） */
  | { type: 'mori.turn_changes'; entryId: string; record: TurnChanges }
  /** 用户会话自己的运行等开始快照：active 为真时阶段行显示 Taking a snapshot…（§4.5、§13） */
  | { type: 'mori.snapshot_stage'; active: boolean }
  /** Rewind 或 Undo 做完（§5.9） */
  | { type: 'mori.rewind'; entryId: string; record: RewindRecord }
  /** 开始计时发截止时刻，切回 Mori、计时清零时发 null（§9.3） */
  | { type: 'mori.away_timer'; requestId: string; deadline: number | null }
  /** 一条自动处理记录，与写进会话文件的同名条目相同（§9.7） */
  | { type: 'mori.away_decision'; decision: AwayDecision }
  /** 提问卡（§10.3） */
  | ({ type: 'mori.question_request' } & AskRequest)
  /** 提问结束（§10.3） */
  | { type: 'mori.question_end'; requestId: string; toolCallId: string; by: AskEndBy; answers: AskAnswer[] | null };

/** @brief 发起请求的会话种类（GateOutput.kind、AwayItem.kind）：到时原文与提醒的最后一句按它选（§9.4、§9.8）。 */
export type RequestKind = 'user' | InstanceKind;

/** @brief 到时原文与提醒的最后一句是不是“写进交接”：task 实例、结案会话为真（§9.4）。 */
export function mentionsHandoff(kind: RequestKind): boolean {
  return kind === 'task' || kind === 'close';
}
