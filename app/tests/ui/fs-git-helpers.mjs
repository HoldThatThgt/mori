// 文件系统第 2 步（git、快照与 Rewind，docs/specs/file-system.md §3–§5、§19.1）的 App 套件 fs-app-changes.mjs 用的准备、
// 读取与操作（只读页面和磁盘、发界面操作，不改 Mori 的源码）：
// - 测试项目（synthetic test setup）：用真实 git 建仓库、提交、分支与上游、合并冲突、子模块与独立的嵌套仓库、
//   坏掉的 index、很多个未跟踪的文件；
// - 内部仓库（§4.1）：位置 = 快照目录 + projectDirName(工作路径)；只读地列出它的 ref、核对提交在不在；FS-20 用
//   git update-ref -d 手工删掉一轮的 ref（测试做出的整理），FS-22 放进陈旧的锁（synthetic，模拟强行结束时留下的）；
// - 会话文件里的 mori.turn_changes（run / changes 记录）、你的消息与 mori.wake、当前分支；
// - 页面：git 状态读了几次（mori.workspace_status 的 at：每读一次一个新的 at，快照状态变了时的重发 at 不变）、工具执行完
//   的时刻（window.__fsGitTools）、右栏 Changes（外框、git 状态、This session、diff、阅读器）、顶栏 +N −M、Rewind 菜单与通知；
// - 进程：命令行里带内部仓库目录名的 git 进程（停止、关闭时它们要被结束，§4.5）。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  appLogLines, kernelEvents, oneLine, paneSel, poll, readJsonl, samePath, sendFs, setPermission, sleep,
} from './fs-helpers.mjs';
import { contentText, showTab } from './tb-helpers.mjs';

// ---------- 规格里的文字（file-system.md §4.4、§4.7、§5.1–§5.4，状态表 fs-changes.md） ----------

/** 右栏与 This session 的原文 */
export const TEXT = Object.freeze({
  gitRequired: 'Git is required to track changes and rewind.',
  notRepo: 'Not a git repository',
  noChanges: 'No changes yet.',
  noUncommitted: 'No uncommitted changes',
  overlap: 'Another session in this folder was running at the same time, so some of these changes may be theirs.',
  truncated: 'Some files in this turn aren’t listed. Too many changed at once.',
  binary: 'Binary file · No preview',
  noNet: 'No net changes in this turn.',
  pruned: 'Mori keeps snapshots for the last 100 turns of a session. This turn’s snapshots were removed.',
  paused: 'Snapshots are paused for this folder: more than 20,000 new files would be added. Add generated folders to '
    + '.gitignore to resume.',
  skippedOne: '1 large file isn’t in snapshots (over 10 MB).',
  nestedLead: 'Changes inside nested repositories aren’t tracked: ',
  stalePrefix: 'Couldn’t take a snapshot: ',
  teamNote: 'Changes made by team tasks aren’t listed here.',
  v0Note: 'Only edits and writes are listed.',
  stage: 'Taking a snapshot…',
});

/** @brief 读 git 状态失败的一行（§5.1、§5.2）。 */
export const statusErrorText = (error) => `Couldn’t read git status: ${error}`;

/** @brief +N −M 的读屏名（§5.4）：N 为 1 时 1 line added。 */
export function linesLabel({ added, removed }) {
  return `Changes in this session: ${added === 1 ? '1 line' : `${added} lines`} added, ${removed} removed`;
}

/** @brief +N −M 按钮的文字（− 是 U+2212，两段之间一个空格）。 */
export const linesText = ({ added, removed }) => `+${added} −${removed}`;

// ---------- git（测试仓库与内部仓库） ----------

/** 测试仓库里提交用的身份（只在这些临时仓库里用） */
const IDENTITY = ['-c', 'user.name=Mori Test', '-c', 'user.email=mori-test@example.invalid'];
/** Mori 读 git 状态的参数（kernel/workspace.ts，§3.5） */
export const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z'];

/** @brief 跑 git 的环境：去掉 GIT_ 开头的变量（同 Mori，§3.3），提示固定英文（LC_ALL=C）。 */
function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)));
  return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
}

/** @brief 在 cwd 里跑一次 git：{ code, stdout, stderr }；不抛错。 */
export function gitRun(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', windowsHide: true });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr || (result.error?.message ?? '') };
}

/** @brief 在 cwd 里跑 git，失败时抛错（测试准备用）；返回去掉首尾空白的 stdout。 */
export function git(cwd, ...args) {
  const result = gitRun(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** @brief 提交（测试仓库里的身份）；extra 放在 -m 之前（例如 -a、--allow-empty）。 */
export const commit = (cwd, message, ...extra) => git(cwd, ...IDENTITY, 'commit', '-q', ...extra, '-m', message);

/** @brief 当前分支名（还没有提交的仓库也有）。 */
export const headName = (cwd) => git(cwd, 'symbolic-ref', '--short', 'HEAD');

/**
 * @brief 这次 git 调用的 stderr 第一行非空文字，去掉开头的 fatal: / error:（同 Mori 的 gitError，§3.3）：
 *        右栏“读失败的原文”的期望值。
 */
export function firstGitError(cwd, args) {
  const { stderr } = gitRun(cwd, args);
  const line = stderr.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? '';
  return line.replace(/^(fatal|error): /, '');
}

/** @brief 项目目录名，与 pi 的会话目录同一种编码（kernel/memoryFiles.ts projectDirName，§4.1）。 */
export const projectDirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/** @brief 这个工作路径的内部仓库目录：<快照目录>\<projectDirName 编码>（§4.1）。 */
export const internalRepo = (ctx, cwd) => join(ctx.snapshots, projectDirName(cwd));

/** @brief 在内部仓库里跑一次只读的 git（--git-dir，进程目录是内部仓库）。 */
export const repoGit = (ctx, cwd, args) => gitRun(internalRepo(ctx, cwd), [`--git-dir=${internalRepo(ctx, cwd)}`,
  ...args]);

/** @brief 内部仓库里 prefix 下的全部 ref（refs/mori/s/<会话>/<组>/ 等）；仓库不在时为 []。 */
export function refsUnder(ctx, cwd, prefix) {
  if (!existsSync(internalRepo(ctx, cwd))) return [];
  const result = repoGit(ctx, cwd, ['for-each-ref', '--format=%(refname)', prefix]);
  return result.code === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** @brief 内部仓库里有这个提交（git cat-file -e）。 */
export const commitExists = (ctx, cwd, oid) => Boolean(oid) && repoGit(ctx, cwd, ['cat-file', '-e', oid]).code === 0;

/** @brief 内部仓库的某个提交里有这个文件（git cat-file -e <提交>:<路径>）。 */
export const fileInCommit = (ctx, cwd, oid, path) => repoGit(ctx, cwd, ['cat-file', '-e', `${oid}:${path}`])
  .code === 0;

/**
 * @brief 测试做出的整理（FS-20，§19.2）：用 git update-ref -d 删掉内部仓库里一组 ref；返回删掉的 ref。
 * @param prefix 例如 refs/mori/s/<会话 id>/<轮的条目 id>/
 */
export function deleteRefs(ctx, cwd, prefix) {
  const refs = refsUnder(ctx, cwd, prefix);
  for (const ref of refs) {
    const result = repoGit(ctx, cwd, ['update-ref', '-d', ref]);
    if (result.code !== 0) throw new Error(`git update-ref -d ${ref} failed: ${result.stderr.trim()}`);
  }
  return refs;
}

/**
 * @brief 测试准备（synthetic）：在内部仓库里放进陈旧的锁（模拟后台进程在 git 调用中途被强行结束时留下的，§4.1）：
 *        index.lock、packed-refs.lock、refs\mori\synthetic.lock。返回它们的路径。
 */
export function plantLocks(repo) {
  const names = ['index.lock', 'packed-refs.lock', join('refs', 'mori', 'synthetic.lock')];
  const locks = names.map((name) => join(repo, name));
  for (const lock of locks) {
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'synthetic: stale lock\n');
  }
  return locks;
}

// ---------- 测试项目（synthetic test setup） ----------

/** @brief 写一组文件（相对 dir 的路径 → 内容），上级目录不在就建。 */
export function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/**
 * @brief root 下名为 name 的项目：README.md 加 files（相对路径 → 内容）；repo 为真时 git init 并提交一次。
 * @return 项目文件夹
 */
export function makeProject(root, name, { files = {}, repo = false } = {}) {
  const project = join(root, name);
  writeFiles(project, { 'README.md': '# Mori fixture project\n\nSynthetic project for the git tests.\n', ...files });
  if (repo) {
    git(project, 'init', '-q');
    git(project, 'add', '-A');
    commit(project, 'synthetic');
  }
  return project;
}

/**
 * @brief FS-13 四个分组的仓库：冲突（另一支与这一支都改了 conflict.txt 再 merge）、暂存（新文件 new.txt、改名
 *        b.txt → b2.txt、c.txt 暂存后又改）、未暂存（a.txt 改了、d.txt 删了、c.txt 又改）、未跟踪（u.txt、目录 ud/）。
 */
export function groupsProject(root) {
  const files = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n', 'conflict.txt': 'base\n' };
  const project = makeProject(root, 'groups', { files, repo: true });
  const head = headName(project);
  git(project, 'checkout', '-q', '-b', 'other');
  writeFiles(project, { 'conflict.txt': 'other\n' });
  commit(project, 'other side', '-a');
  git(project, 'checkout', '-q', head);
  writeFiles(project, { 'conflict.txt': 'mine\n' });
  commit(project, 'this side', '-a');
  // 两边都改了 conflict.txt：merge 以冲突结束（退出码不为 0，正是要的状态）
  gitRun(project, [...IDENTITY, 'merge', '-q', 'other']);
  writeFiles(project, { 'new.txt': 'new\n', 'c.txt': 'c staged\n' });
  git(project, 'add', 'new.txt', 'c.txt');
  git(project, 'mv', 'b.txt', 'b2.txt');
  writeFiles(project, { 'a.txt': 'a changed\n', 'c.txt': 'c staged then changed\n', 'u.txt': 'u\n',
    'ud/x.txt': 'x\n' });
  rmSync(join(project, 'd.txt'));
  return project;
}

/** @brief FS-13 的“超过 500 条”：仓库根下 count 个未跟踪的文件。 */
export function manyProject(root, count) {
  const project = makeProject(root, 'many', { repo: true });
  for (let i = 0; i < count; i += 1) writeFileSync(join(project, `u${String(i).padStart(4, '0')}.txt`), 'u\n');
  return project;
}

/** @brief FS-13 的“读失败”：index 坏了的仓库（git status 失败，rev-parse 照常）。 */
export function brokenProject(root) {
  const project = makeProject(root, 'broken', { repo: true });
  writeFileSync(join(project, '.git', 'index'), 'synthetic: not an index\n');
  return project;
}

/** @brief FS-13 的“No commits yet”：git init 了、还没有提交的仓库。 */
export function freshProject(root) {
  const project = makeProject(root, 'fresh');
  git(project, 'init', '-q');
  return project;
}

/**
 * @brief FS-26：外层是仓库，libs/sub 是子模块（来源是 root 下另一个有提交的仓库 subsrc），tools/other 是不是子模块、
 *        已有提交的独立仓库（外层不跟踪它）。
 */
export function nestProject(root) {
  const source = makeProject(root, 'subsrc', { files: { 's.txt': 's\n' }, repo: true });
  const project = makeProject(root, 'nest', { repo: true });
  git(project, ...IDENTITY, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q',
    source.replace(/\\/g, '/'), 'libs/sub');
  commit(project, 'submodule');
  const other = join(project, 'tools', 'other');
  writeFiles(other, { 'o.txt': 'o\n' });
  git(other, 'init', '-q');
  git(other, 'add', '-A');
  commit(other, 'independent');
  return project;
}

/** @brief 在 dir 里建 count 个空文件（FS-08 的 20,001 个新文件：只数不加，§4.4 第 3 步）。 */
export function writeEmptyFiles(dir, count) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) writeFileSync(join(dir, `e${i}.txt`), '');
}

// ---------- 会话文件 ----------

/** @brief 会话文件里的 mori.turn_changes 条目：[{ id, record }]（按写下的先后）。 */
export function turnRecords(file) {
  return readJsonl(file).filter((entry) => entry.type === 'custom' && entry.customType === 'mori.turn_changes')
    .map((entry) => ({ id: entry.id, record: entry.data }));
}

/** @brief changes 记录（§4.6）。 */
export const changesOf = (file) => turnRecords(file).filter((item) => item.record?.kind === 'changes');
/** @brief run 记录（§4.6）。 */
export const runsOf = (file) => turnRecords(file).filter((item) => item.record?.kind === 'run');

/** @brief mori.wake 指向的消息（程序投递的 [Mori] 消息，不是你的话）。 */
export function wakeTargets(file) {
  return new Set(readJsonl(file).filter((entry) => entry.type === 'custom' && entry.customType === 'mori.wake')
    .map((entry) => entry.data?.messageId).filter(Boolean));
}

/** @brief 会话文件里的 user 消息：[{ id, text, index（在文件里的行序）, wake（是程序投递） }]。 */
export function userMessages(file) {
  const wakes = wakeTargets(file);
  return readJsonl(file).map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === 'message' && entry.message?.role === 'user')
    .map(({ entry, index }) => ({ id: entry.id, text: contentText(entry.message.content), index,
      wake: wakes.has(entry.id) }));
}

/** @brief 最后一条含 marker 的你的消息（不算程序投递）的条目 id；没有时为 null。 */
export function messageIdOf(file, marker) {
  return userMessages(file).filter((item) => !item.wake && item.text.includes(marker)).at(-1)?.id ?? null;
}

/** @brief 当前分支（pi 打开会话时的叶子 = 文件里最后一条，按 parentId 走到根）上的条目。 */
export function branchEntries(file) {
  const entries = readJsonl(file).filter((entry) => entry.type !== 'session' && entry.id);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  for (let at = entries.at(-1); at; at = byId.get(at.parentId)) branch.unshift(at);
  return branch;
}

/** @brief 当前分支上的 changes 记录。 */
export const branchChanges = (file) => branchEntries(file).filter((entry) => entry.type === 'custom'
  && entry.customType === 'mori.turn_changes' && entry.data?.kind === 'changes').map((entry) => entry.data);

/** @brief 记录里 added、removed 之和，二进制（null）不计（§5.4）。 */
export function lineSums(records) {
  let added = 0;
  let removed = 0;
  for (const record of records) {
    for (const file of record.files) {
      added += file.added ?? 0;
      removed += file.removed ?? 0;
    }
  }
  return { added, removed };
}

/** @brief 这一轮（round）各条 changes 记录里列出的路径。 */
export const roundPaths = (file, round) => [...new Set(changesOf(file).filter((item) => item.record.round === round)
  .flatMap((item) => item.record.files.map((entry) => entry.path)))];

/**
 * @brief 等最后一条含 marker 的你的消息的这一轮写完：有它的 run 记录（结束快照做完，§4.5），paths 都在它的 changes
 *        记录里。返回 { id, runs, changes }；等不到时为 null。
 */
export async function waitTurn(file, marker, paths = [], timeout = 30000) {
  return poll(() => {
    const id = file ? messageIdOf(file, marker) : null;
    if (!id) return null;
    const runs = runsOf(file).filter((item) => item.record.round === id);
    const changes = changesOf(file).filter((item) => item.record.round === id);
    const listed = new Set(changes.flatMap((item) => item.record.files.map((entry) => entry.path)));
    return runs.length > 0 && paths.every((path) => listed.has(path)) ? { id, runs, changes } : null;
  }, timeout, 250);
}

/**
 * @brief 发一条消息（Full access 下不出卡），等这次运行结束、这一轮的记录写完（waitTurn，按消息的第一行认）。
 * @return waitTurn 的结果；出卡、等不到记录时抛错
 */
export async function sendTurn(ctx, who, text, paths = [], { team = false, timeout = 60000 } = {}) {
  const { outcome } = await sendFs(ctx, who, text, { team, timeout });
  if (outcome !== 'idle') throw new Error(`"${oneLine(text, 80)}" stopped at an approval card`);
  const turn = await waitTurn(who.sessionFile, text.split('\n')[0], paths, 30000);
  if (!turn) throw new Error(`no records for "${oneLine(text, 80)}" listing ${paths.join(', ') || 'nothing'}`);
  return turn;
}

/** @brief 把一个值的对象键排好序（比较事件与条目时不受键的先后影响）。 */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

// ---------- 页面：读 git 状态的次数、工具执行完、窗口回到前台 ----------

/**
 * @brief 记下工具执行完的时刻（window.__fsGitTools：{ t, sid, tool }）。启动、界面重新载入之后要重新装。
 *        fs-helpers 的 captureEvents 不记 tool_execution_end。
 */
export function watchTools(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__fsGitTools) return;
    window.__fsGitTools = [];
    window.mori.onEvent((envelope) => {
      const event = envelope.event;
      if (event?.type !== 'tool_execution_end') return;
      window.__fsGitTools.push({ t: Date.now(), sid: envelope.sessionId, tool: event.toolName ?? null });
    });
  });
}

/** @brief watchTools 记下的工具执行完（since 之后）。 */
export const toolEnds = (ctx, since) => ctx.page.evaluate((from) => (window.__fsGitTools ?? [])
  .filter((item) => item.t >= from), since);

/**
 * @brief 这个工作路径的 git 状态在 [from, to) 里读了几次：收到的 mori.workspace_status 里不同的 at（每读一次一个新的
 *        at，快照状态变了时的重发沿用上一次的 at，§3.5），每次带收到它的会话。
 * @return [{ at, sids }]，按 at 排
 */
export async function readsAt(ctx, cwd, from, to = Number.MAX_SAFE_INTEGER) {
  const events = await kernelEvents(ctx, null, 'mori.workspace_status', from);
  const reads = new Map();
  for (const item of events) {
    const status = item.data?.status;
    if (!status || !samePath(status.cwd, cwd) || status.at < from || status.at >= to) continue;
    reads.set(status.at, [...new Set([...(reads.get(status.at) ?? []), item.sid])]);
  }
  return [...reads].sort(([a], [b]) => a - b).map(([at, sids]) => ({ at, sids }));
}

/** @brief 等 settleMs 之后，这个工作路径从 from 起读了几次（readsAt）。 */
export async function readsAfter(ctx, cwd, from, settleMs = 2500) {
  await sleep(settleMs);
  return readsAt(ctx, cwd, from, Date.now());
}

/** @brief 窗口回到前台（synthetic：在页面上发一个 window 的 focus 事件，界面的刷新时机按它，§3.5）。 */
export const windowFocusEvent = (ctx) => ctx.page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));

// ---------- 页面：右栏 ----------

/** @brief 这个会话面板顶栏的右栏开关。 */
const toggleCss = (tab) => `${paneSel(tab)} .right-toggle`;

/** @brief 打开或关上这个会话的右栏（顶栏的 Toggle changes），等开关的 aria-pressed 变过来。 */
export async function setPanel(ctx, tab, open) {
  await showTab(ctx, tab);
  const toggle = ctx.page.locator(toggleCss(tab));
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
  await ctx.page.waitForFunction(({ css, want }) => document.querySelector(css)?.getAttribute('aria-pressed') === want,
    { css: toggleCss(tab), want: String(open) }, { timeout: 5000 });
}

/** @brief 点右栏标题栏的 Refresh。 */
export const clickRefresh = (ctx) => ctx.page.locator('[data-testid="right-panel"] [data-testid="changes-refresh"]')
  .click();

/**
 * @brief 点 Refresh，记下它的样子怎样变（MutationObserver）：[{ busy, label, disabled, status（git 状态那一块还在） }]，
 *        等它不再转圈（最多 timeout）。
 */
export async function refreshStates(ctx, timeout = 10000) {
  await ctx.page.evaluate(() => {
    const read = () => {
      const button = document.querySelector('[data-testid="right-panel"] [data-testid="changes-refresh"]');
      return { busy: button?.dataset.busy ?? null, label: button?.getAttribute('aria-label') ?? null,
        disabled: button?.getAttribute('aria-disabled') ?? null,
        status: Boolean(document.querySelector('[data-testid="right-panel"] [data-testid="git-status"]')) };
    };
    window.__fsRefresh = [read()];
    window.__fsRefreshObserver?.disconnect();
    window.__fsRefreshObserver = new MutationObserver(() => window.__fsRefresh.push(read()));
    window.__fsRefreshObserver.observe(document.querySelector('[data-testid="right-panel"]'), { subtree: true,
      childList: true, attributes: true });
  });
  await clickRefresh(ctx);
  await poll(() => ctx.page.evaluate(() => window.__fsRefresh.some((item) => item.busy)
    && !document.querySelector('[data-testid="right-panel"] [data-testid="changes-refresh"]')?.dataset.busy),
  timeout, 100);
  return ctx.page.evaluate(() => {
    window.__fsRefreshObserver?.disconnect();
    return window.__fsRefresh;
  });
}

/**
 * @brief 点 Refresh 并等这次读完：右栏里这个会话的 git 状态换成 Refresh 之后读到的（mori.workspace_status 的 at 晚于点的
 *        时刻）、按钮不再转圈。
 */
export async function refreshAndWait(ctx, cwd, timeout = 10000) {
  const since = Date.now();
  await clickRefresh(ctx);
  await poll(async () => (await readsAt(ctx, cwd, since)).length > 0 && !(await ctx.page.evaluate(() => document
    .querySelector('[data-testid="right-panel"] [data-testid="changes-refresh"]')?.dataset.busy)), timeout, 100);
  await sleep(200);
}

/**
 * @brief 右栏此刻的外框与上半部分（fs-changes.md "右栏的外框"、"上半部分"）；右栏没打开时为 null：
 *        { view（changes | file | other）, title, refresh（{ label, title, busy }）, close（标题栏的 Close panel）, loading,
 *          required（{ state, text }）,
 *          notRepo, topError, gitStatus（有 git 状态那一块）, session（有 This session）, text（正文全文） }。
 */
export function panelView(ctx) {
  return ctx.page.evaluate(() => {
    const panel = document.querySelector('[data-testid="right-panel"]');
    if (!panel) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const body = panel.querySelector('[data-testid="changes"]');
    const refresh = panel.querySelector('[data-testid="changes-refresh"]');
    const required = body?.querySelector('[data-testid="git-required"]');
    return {
      view: body ? 'changes' : panel.querySelector('[data-testid="file-viewer"]') ? 'file' : 'other',
      title: text(panel.querySelector('.changes-title')),
      refresh: refresh ? { label: refresh.getAttribute('aria-label'), title: refresh.getAttribute('title'),
        busy: refresh.dataset.busy ?? null } : null,
      close: Boolean(panel.querySelector('.panel-header [aria-label="Close panel"]')),
      loading: text(body?.querySelector('[data-testid="changes-loading"]')),
      required: required ? { state: required.dataset.state ?? null, text: text(required) } : null,
      notRepo: text(body?.querySelector('[data-testid="not-a-repo"] .changes-line')),
      topError: text(body?.querySelector(':scope > [data-testid="git-error"]')),
      gitStatus: Boolean(body?.querySelector('[data-testid="git-status"]')),
      session: Boolean(body?.querySelector('[data-testid="session-changes"]')), text: text(body) ?? '',
    };
  });
}

/**
 * @brief 右栏的 git 状态（fs-changes.md "git 状态"）；没有这一块时为 null：{ branch, branchTitle, error, empty, footer,
 *        groups（[{ group, title, files: [{ path, code, label, letter, letterTitle }] }]） }。
 */
export function gitView(ctx) {
  return ctx.page.evaluate(() => {
    const status = document.querySelector('[data-testid="right-panel"] [data-testid="git-status"]');
    if (!status) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const branch = status.querySelector('[data-testid="git-branch"]');
    const fileOf = (row) => ({ path: row.dataset.path, code: row.dataset.code,
      label: text(row.querySelector('.change-row-path')), letter: text(row.querySelector('.status-letter')),
      letterTitle: row.querySelector('.status-letter')?.getAttribute('title') ?? null });
    return { branch: text(branch), branchTitle: branch?.getAttribute('title') ?? null,
      error: text(status.querySelector('[data-testid="git-error"]')),
      empty: text(status.querySelector('[data-testid="git-empty"]')),
      footer: text(status.querySelector('[data-testid="git-footer"]')),
      groups: [...status.querySelectorAll('[data-testid="git-group"]')].map((group) => ({ group: group.dataset.group,
        title: text(group.querySelector('.changes-subtitle')),
        files: [...group.querySelectorAll('[data-testid="git-file"]')].map(fileOf) })) };
  });
}

/**
 * @brief 右栏的 This session（fs-changes.md "This session"）；没有时为 null：{ nested, nestedAbove（在小标题上方）,
 *        notes（[{ kind, text, title, below（在小标题下面） }]）, empty, turns（从上到下：[{ round, turn, title, hover,
 *        overlap, truncated, files: [{ path, status, added, removed, letter, letterTitle, lines, agents, open }] }]） }。
 */
export function sessionView(ctx) {
  return ctx.page.evaluate(() => {
    const section = document.querySelector('[data-testid="right-panel"] [data-testid="session-changes"]');
    if (!section) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const fileOf = (row) => ({ path: row.dataset.path, status: row.dataset.status, added: Number(row.dataset.added),
      removed: Number(row.dataset.removed), letter: text(row.querySelector('.status-letter')),
      letterTitle: row.querySelector('.status-letter')?.getAttribute('title') ?? null,
      lines: text(row.querySelector('.turn-file-lines')),
      agents: text(row.querySelector('[data-testid="turn-file-agents"]')),
      open: Boolean(row.querySelector('[data-testid="turn-file-open"]')) });
    const turns = [...section.querySelectorAll('[data-testid="turn-changes"]')].map((group) => ({
      round: group.dataset.round, turn: group.dataset.turn ? Number(group.dataset.turn) : null,
      title: text(group.querySelector('.turn-title')),
      hover: group.querySelector('.turn-title')?.getAttribute('title') ?? null,
      overlap: text(group.querySelector('[data-testid="turn-overlap"]')),
      truncated: text(group.querySelector('[data-testid="turn-truncated"]')),
      files: [...group.querySelectorAll('[data-testid="turn-file"]')].map(fileOf) }));
    const nested = section.querySelector('[data-testid="nested-repos-note"]');
    const heading = section.querySelector('.session-changes-title');
    return { nested: text(nested), nestedAbove: Boolean(nested && heading
      && nested.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING),
    notes: [...section.querySelectorAll('[data-testid="snapshots-note"]')].map((el) => ({ kind: el.dataset.kind,
      text: text(el), title: el.getAttribute('title'),
      below: Boolean(heading && heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) })),
    empty: text(section.querySelector('[data-testid="session-changes-empty"]')), turns };
  });
}

/** @brief sessionView 里这一轮的组；没有时为 null。 */
export const turnOf = (view, round) => view?.turns.find((turn) => turn.round === round) ?? null;
/** @brief 一组里这个路径的文件行；没有时为 null。 */
export const rowOf = (turn, path) => turn?.files.find((file) => file.path === path) ?? null;

/** @brief 等 This session 里这一轮的组列出 paths（右栏要开着），最多 timeout；返回那一刻的 sessionView 或 null。 */
export async function waitGroup(ctx, round, paths, timeout = 15000) {
  return poll(async () => {
    const view = await sessionView(ctx);
    const turn = turnOf(view, round);
    return turn && paths.every((path) => rowOf(turn, path)) ? view : null;
  }, timeout, 200);
}

/** @brief This session 里这一轮这个文件的行（CSS）。 */
const turnFileCss = (round, path) => `[data-testid="right-panel"] [data-testid="turn-changes"][data-round=`
  + `${JSON.stringify(round)}] [data-testid="turn-file"][data-path=${JSON.stringify(path)}]`;

/**
 * @brief 这一轮这个文件展开的 diff（fs-changes.md "一个文件的 diff"）；没展开时为 null：{ state（data-state）, note（说明行）,
 *        deep（diff 组件画出的文字，连 shadow DOM 一起读，不含 style、script 里的主题 CSS）, lines（diff 组件画出的每一个
 *        内容行：[{ type（data-line-type：change-addition、change-deletion、context）, text（这一行的文字） }]，
 *        不含行号栏与文件名标题）, error（Diff.tsx 的错误行） }。
 */
export function turnDiffOf(ctx, round, path) {
  return ctx.page.evaluate((css) => {
    const diff = document.querySelector(css)?.parentElement?.querySelector('[data-testid="turn-diff"]');
    if (!diff) return null;
    let deep = '';
    const roots = [];
    const walk = (node) => {
      if (node.nodeName === 'STYLE' || node.nodeName === 'SCRIPT') return;
      if (node.nodeType === 3) deep += node.textContent;
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
        walk(node.shadowRoot);
      }
      for (const child of node.childNodes) walk(child);
    };
    const body = diff.querySelector('.change-diff');
    if (body) walk(body);
    // @pierre/diffs 的内容行带 data-line（行号栏是 data-column-number）；每个 shadow root 各查一次
    const lines = (body ? [body, ...roots] : []).flatMap((root) => [...root.querySelectorAll(
      '[data-line]:not([data-column-number])')]).map((el) => ({ type: el.dataset.lineType ?? null,
      text: el.textContent.replace(/\r?\n$/, '') }));
    return { state: diff.dataset.state ?? null,
      note: diff.querySelector(':scope > .changes-line')?.textContent ?? null, deep, lines,
      error: diff.querySelector('[data-testid="diff-error"]')?.textContent ?? null };
  }, turnFileCss(round, path));
}

/**
 * @brief diff 里有没有这些整行：kind 为 add（加的行）、del（删的行）。
 * @param diff turnDiffOf 的结果
 * @param kind add | del
 * @param texts 每一行的全文
 */
export function diffHasLines(diff, kind, texts) {
  const want = kind === 'add' ? 'change-addition' : 'change-deletion';
  return texts.every((text) => Boolean(diff?.lines.some((line) => line.type === want && line.text === text)));
}

/**
 * @brief 点这一轮这个文件的行展开 diff（snapshots.diff），等它不再是 Loading…；显示 patch 时再等 diff 组件画出文字。
 * @return turnDiffOf 的结果；等不到时为最后一次读到的
 */
export async function expandTurnFile(ctx, round, path, timeout = 15000) {
  await ctx.page.locator(`${turnFileCss(round, path)} .turn-file-toggle`).click();
  let last = null;
  await poll(async () => {
    last = await turnDiffOf(ctx, round, path);
    if (!last || last.state === 'loading') return false;
    return last.state !== 'shown' || last.lines.length > 0 || last.error !== null;
  }, timeout, 200);
  return last;
}

/** @brief 点这一轮这个文件的 Open（在阅读器里打开现在的文件）。 */
export const clickOpen = (ctx, round, path) => ctx.page.locator(`${turnFileCss(round, path)} `
  + '[data-testid="turn-file-open"]').click();

/** @brief 阅读器的“← Changes”。 */
export const backToChanges = (ctx) => ctx.page.locator('[data-testid="right-panel"] .back-link').click();

/**
 * @brief 文件阅读器此刻的样子；没打开时为 null：{ path（显示的路径）, fullPath（悬停的完整路径）, state（说明的第一行，
 *        例如 File not found）, loading, lines（各行文字） }。
 */
export function viewerView(ctx) {
  return ctx.page.evaluate(() => {
    const panel = document.querySelector('[data-testid="right-panel"]');
    const viewer = panel?.querySelector('[data-testid="file-viewer"]');
    if (!viewer) return null;
    const path = panel.querySelector('[data-testid="file-path"]');
    const state = viewer.querySelector('[data-testid="file-state"]');
    const first = state?.querySelector('p') ?? state;
    return { path: path?.textContent ?? null, fullPath: path?.getAttribute('title') ?? null,
      state: first ? first.textContent.replace(/\s+/g, ' ').trim() : null,
      loading: viewer.textContent.includes('Loading…'),
      lines: [...viewer.querySelectorAll('[data-testid="file-content"] [data-line]')]
        .map((line) => line.textContent) };
  });
}

/** @brief 等阅读器读完（不再 Loading…），最多 timeout；返回 viewerView 或 null。 */
export const waitViewer = (ctx, timeout = 10000) => poll(async () => {
  const view = await viewerView(ctx);
  return view && !view.loading ? view : null;
}, timeout, 150);

// ---------- 页面：顶栏 +N −M ----------

/**
 * @brief 这个会话面板顶栏的 +N −M 与右栏开关（fs-changes.md "顶栏"）：{ present（元素在）, shown（不是 display: none）,
 *        added, removed, text, label（读屏名）, paneWidth（这一栏的宽度）, toggleLabel, toggleTitle, beforeToggle（紧挨在
 *        右栏开关左边） }。
 */
export function linesView(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    if (!pane) return null;
    const button = pane.querySelector('[data-testid="lines-indicator"]');
    const toggle = pane.querySelector('.right-toggle');
    return { present: Boolean(button), shown: button ? getComputedStyle(button).display !== 'none' : false,
      added: button ? Number(button.dataset.added) : null, removed: button ? Number(button.dataset.removed) : null,
      text: button?.textContent ?? null, label: button?.getAttribute('aria-label') ?? null,
      paneWidth: Math.round(pane.getBoundingClientRect().width),
      toggleLabel: toggle?.getAttribute('aria-label') ?? null,
      toggleTitle: toggle?.getAttribute('title') ?? null,
      beforeToggle: Boolean(button && toggle && button.nextElementSibling === toggle) };
  }, paneSel(tab));
}

/** @brief 点这个会话面板顶栏的 +N −M。 */
export const clickLines = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="lines-indicator"]`).click();

/** @brief 窗口内容区的大小 [宽, 高]。 */
export const contentSize = (ctx) => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]
  .getContentSize());

/** @brief 改窗口内容区的大小（主进程里改，界面随之响应），等界面重排。 */
export async function setContentSize(ctx, [width, height]) {
  await ctx.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
    { w: width, h: height });
  await sleep(700);
}

// ---------- 页面：Rewind ----------

/** @brief 这个会话面板里 entryId 那条消息的 Rewind 按钮（CSS）。 */
const rewindCss = (tab, entryId) => `${paneSel(tab)} [data-testid="rewind-button"]`
  + `[data-entry=${JSON.stringify(entryId)}]`;

/**
 * @brief 打开 entryId 那条消息的 Rewind 菜单（悬停后点 Rewind），返回菜单的各行：{ items（[{ id（data-testid）, label,
 *        disabled }]）, blocked（需求的说明或 null） }。
 */
export async function openRewindMenu(ctx, tab, entryId) {
  await showTab(ctx, tab);
  const button = ctx.page.locator(rewindCss(tab, entryId));
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  await button.click();
  const menu = ctx.page.getByTestId('rewind-menu');
  await menu.waitFor({ timeout: 5000 });
  return menu.evaluate((el) => ({
    items: [...el.querySelectorAll('[data-testid]')].filter((item) => item.dataset.testid !== 'rewind-blocked')
      .map((item) => ({ id: item.dataset.testid, label: item.textContent.trim(),
        disabled: item.disabled === true || item.getAttribute('aria-disabled') === 'true' })),
    blocked: el.querySelector('[data-testid="rewind-blocked"]')?.textContent ?? null }));
}

/** @brief Esc 关掉开着的 Rewind 菜单（等于 Never mind）。 */
export async function closeRewindMenu(ctx) {
  const menu = ctx.page.getByTestId('rewind-menu');
  if (!(await menu.isVisible().catch(() => false))) return;
  await ctx.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
}

/**
 * @brief 这个会话面板里 Rewind 的样子：{ progress（进行中的 data-kind 或 null）, error（错误行）, notices（[{ kind, code,
 *        conversation, text }]）, conflicts（冲突对话框开着） }。
 */
export function rewindView(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    return { progress: pane?.querySelector('[data-testid="rewind-progress"]')?.dataset.kind ?? null,
      error: text(pane?.querySelector('[data-testid="rewind-error"]')),
      notices: [...(pane?.querySelectorAll('[data-testid="rewind-notice"]') ?? [])].map((el) => ({
        kind: el.dataset.kind, code: el.dataset.code, conversation: el.dataset.conversation, text: text(el) })),
      conflicts: Boolean(document.querySelector('[data-testid="rewind-conflicts"]')) };
  }, paneSel(tab));
}

/**
 * @brief 在开着的 Rewind 菜单里选一项（data-testid），等它做完：不再进行中，且最后一条通知换了、出现错误行或冲突对话框
 *        （恢复了对话时对话流重建，通知的条数不一定变多）。出现冲突对话框时点 Cancel 关掉（调用方按结果判断）。
 * @return 做完时的 rewindView；超时为最后一次读到的
 */
export async function chooseRewind(ctx, tab, testId, timeout = 60000) {
  const before = JSON.stringify((await rewindView(ctx, tab)).notices.at(-1) ?? null);
  await ctx.page.getByTestId('rewind-menu').getByTestId(testId).click();
  let view = null;
  await poll(async () => {
    view = await rewindView(ctx, tab);
    return !view.progress && (view.error || view.conflicts || JSON.stringify(view.notices.at(-1) ?? null) !== before);
  }, timeout, 200);
  if (view?.conflicts) await ctx.page.getByTestId('rewind-conflict-cancel').click().catch(() => {});
  return view;
}

/** @brief 这个会话面板里 Rewind 按钮的个数。 */
export const rewindButtons = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="rewind-button"]`).count();

// ---------- 其他 ----------

/** @brief 这个会话切到 Full access（已经是时不动）：工作路径里的编辑、写入、命令不出卡（§6.7）。 */
export async function ensureFull(ctx, tab) {
  await showTab(ctx, tab);
  const text = await ctx.page.locator(`${paneSel(tab)} [data-testid="permission-button"] .permission-text`)
    .textContent().catch(() => null);
  if (text !== 'Full access') await setPermission(ctx, tab, 'full');
}

/** @brief 清空这个会话的输入框（恢复对话把消息放回输入框之后）。 */
export const clearComposer = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} .composer textarea`).fill('');

/** @brief 等这个会话面板就绪（不在“正在启动…”，后台进程重启后会话重新打开完）。 */
export const waitPaneReady = (ctx, tab, timeout = 30000) => ctx.page.waitForFunction((css) => {
  const pane = document.querySelector(css);
  return pane && !pane.querySelector('[data-testid="not-ready"]');
}, paneSel(tab), { timeout });

/**
 * @brief 命令行里含 fragment（不分大小写；用内部仓库的目录名 projectDirName）的 git.exe 进程：[{ pid, parent, command }]。
 *        Git for Windows 的 cmd\git.exe 是启动器，真正的 git 是它的子进程，也叫 git.exe、带同样的参数（命令行开头是
 *        git.exe，不带 mingw64 的路径；2026-10-27 在本机看过），两者都算。
 */
export function gitProcesses(fragment) {
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'git.exe\'" | ForEach-Object '
    + '{ "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }';
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const want = fragment.toLowerCase();
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, parent, ...rest] = line.split('|');
    return { pid: Number(pid), parent: Number(parent), command: rest.join('|') };
  }).filter((item) => item.command.toLowerCase().includes(want));
}

/** Git for Windows 的启动器（cmd\git.exe）：真正干活的 git 是它的子进程（§3.3、fs-checks.md 负责人不在时的选择 #11） */
export const GIT_LAUNCHER = 'C:\\Program Files\\Git\\cmd\\git.exe';

/**
 * @brief 测试环境（synthetic test setup）：启动器在时让 Mori 只用它（MORI_GIT_PATH，§3.2 第 0 步），这样 Mori 找到的
 *        一定是启动器，内部仓库的调用才会换成它旁边真正的 git（§3.3）；PATH 里 mingw64\bin 排在前面时找到的本来就是真正的 git。
 * @return 给 startFsApp 的 ctx.env；启动器不在时为 {}
 */
export const launcherEnv = () => (existsSync(GIT_LAUNCHER) ? { MORI_GIT_PATH: GIT_LAUNCHER } : {});

/** @brief 这批进程里有启动器与它的子进程（某个进程的父进程也在这批里）。 */
export const hasLauncherPair = (processes) => processes.some((item) => processes.some((other) => other.pid
  === item.parent));

/** @brief 这个 PID 的进程还在（process.kill(pid, 0) 只查不发信号；进程不在时抛 ESRCH）。 */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * @brief 每 100 毫秒看一次这些 PID，等它们全都不在，最多到 from + limit。
 * @return 全都不在时距 from 的毫秒数；到时还有在的为 null
 */
export async function goneWithin(pids, from, limit) {
  for (;;) {
    if (pids.every((pid) => !processAlive(pid))) return Date.now() - from;
    if (Date.now() - from > limit) return null;
    await sleep(100);
  }
}

/** 快照模块的错误日志：snapshot failed，或 snapshots: 开头、不是删掉陈旧锁（§4.1 预期的清理）的那一行 */
const SNAPSHOT_ERROR = /\[kernel\] (snapshot failed|snapshots: (?!removed stale lock files))/;

/**
 * @brief since 起快照模块的错误日志，加上这个工作路径与它的内部仓库（命令行里的 projectDirName）的 git 错误
 *        （[kernel] git … failed / timed out 等）。
 */
export function snapshotErrors(ctx, cwd, since) {
  const keys = [projectDirName(cwd).toLowerCase(), resolve(cwd).toLowerCase()];
  return appLogLines(ctx, /\[kernel\] (snapshot|git )/, since).filter((line) => SNAPSHOT_ERROR.test(line)
    || (/\[kernel\] git /.test(line) && keys.some((key) => line.toLowerCase().includes(key))));
}
