// 文件系统第 3 步（worktree 与 Initialize git，docs/specs/file-system.md §11、§19.1）的 App 套件 fs-app-worktree.mjs 用的
// 准备、读取与操作（只读页面和磁盘、发界面操作，不改 Mori 的源码）：
// - 规格与状态表（docs/v1/screens/fs-worktree.md）里的原文；
// - 测试准备（synthetic test setup）：测试用的 HOME（里面的 .gitconfig 只给这次的 App 用，从不读写你真的全局配置）、
//   各种仓库与不是仓库的文件夹、worktree 的登记与分支（真实 git）；
// - 页面：输入框下一行的 Worktree 开关与 Initialize git…、建 worktree 的发送、侧栏行的菜单、归档与删除确认框、
//   设置页 Storage、Initialize git 确认框，以及抓一闪而过的状态的记录器（开关与 Starting… / 发送中同时出现、删除确认框
//   刚打开时的样子、归档时有没有弹框）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  bridge, kernelEvents, liveInfo, paneSel, poll, readJsonl, samePath, sleep,
} from './fs-helpers.mjs';
import { git, gitRun, makeProject, writeFiles } from './fs-git-helpers.mjs';
import { selectLines, viewSource } from './m4-helpers.mjs';
import { showTab, userSession } from './tb-helpers.mjs';

// ---------- 规格与状态表里的原文（fs-worktree.md） ----------

/** 输入框下一行与对话框的原文 */
export const WT = Object.freeze({
  toggleHint: 'Work in a separate worktree on a new branch. It starts with only the committed files.',
  initHint: 'Make this folder a git repository so sessions can use worktrees',
  creating: 'Creating worktree…',
  stillCreating: 'The worktree is still being created.',
  createFailed: 'Couldn’t create the worktree: ',
  initText: 'Mori will run git init in this folder and commit its current files as the first commit. Files matched '
    + 'by .gitignore aren’t included. Afterward, new sessions here can use a worktree.',
  initFailed: 'Couldn’t initialize git: ',
  identity: 'Git needs your name and email for the first commit. Set user.name and user.email with git config '
    + '--global, then try again.',
  running: 'This session is still running. Stop it first.',
  alreadyRepo: 'This folder is already a git repository.',
  checking: 'Checking its worktree…',
  storageEmpty: 'No worktrees are left from archived sessions.',
  storageNote: 'Archived sessions keep their worktree when it has uncommitted changes. Clean up deletes these '
    + 'worktrees and the changes in them. Branches and sessions are kept.',
  noMessages: 'This session has no messages yet.',
  storageNoGit: 'Git is required to clean up worktrees.',
  inUse: 'In use by an open session',
  changes: 'Uncommitted changes',
  clean: 'No uncommitted changes',
  cleanUpText: 'These worktrees and the uncommitted changes in them will be deleted. Their branches and sessions are '
    + 'kept. This can’t be undone.',
  openFailed: 'Failed to open session: ',
});

/** @brief 删除确认框里 worktree 的一句（fs-worktree.md“归档、恢复、删除”）。 */
export const deleteNote = Object.freeze({
  clean: (name, branch) => `Its worktree “${name}” will also be deleted. The branch ${branch} is kept.`,
  changes: (name, branch) => `Its worktree “${name}” and the uncommitted changes in it will also be deleted. The `
    + `branch ${branch} is kept.`,
  unknown: (name, branch) => `Its worktree “${name}” will also be deleted, with any uncommitted changes in it. The `
    + `branch ${branch} is kept.`,
  'in-use': (name) => `Its worktree “${name}” is kept because another open session uses it.`,
  'no-git': (name) => `Its worktree “${name}” is kept because Git is required to delete it.`,
});

/** @brief 打开 worktree 不在的会话失败的原文（§11.9.4）。 */
export const branchGone = (branch) => `The branch ${branch} no longer exists, so this session’s worktree can’t be `
  + 'restored.';
/** @brief 文件夹在、登记没有时的原文（§11.9.4）。 */
export const unregistered = (path) => `The worktree folder ${path} exists but isn’t registered with git. Move or `
  + 'delete it, then open this session again.';
/** @brief 子文件夹还没提交时的原文（§11.5.2）。 */
export const notCommitted = (sub) => `The folder ${sub} isn’t committed yet, so a worktree can’t start there. Commit `
  + 'it first.';

/** worktree 的名字（§11.2：a-z0-9- 的词，后接 - 与 6 个十六进制字符） */
export const WORKTREE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{6}$/;

// ---------- 测试用的 HOME 与项目（synthetic test setup） ----------

/** 测试用的提交者（写进测试 HOME 的 .gitconfig，Initialize git 的第一次提交用它） */
export const WT_IDENTITY = Object.freeze({ name: 'Mori Worktree Test', email: 'mori-worktree@example.invalid' });

/**
 * @brief 写测试 HOME 的 .gitconfig（synthetic）：identity 为真时有 [user]；hooks 给出时 core.hooksPath 指向它。
 *        App 的 git 每次调用都重新读这个文件，所以步骤之间改写它就够了（不重启 App）。
 */
export function writeHomeConfig(home, { identity = true, hooks = null } = {}) {
  const lines = ['[commit]', '\tgpgsign = false'];
  if (identity) lines.push('[user]', `\tname = ${WT_IDENTITY.name}`, `\temail = ${WT_IDENTITY.email}`);
  if (hooks) lines.push('[core]', `\thooksPath = ${hooks.replace(/\\/g, '/')}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), `${lines.join('\n')}\n`);
}

/**
 * @brief 测试准备（synthetic）：一个总是失败的 pre-commit（hooks 目录里的 sh 脚本，exit 1）；返回 hooks 目录。
 */
export function failingHooks(root) {
  const dir = join(root, 'hooks');
  writeFiles(dir, { 'pre-commit': '#!/bin/sh\necho "synthetic pre-commit hook rejects every commit" >&2\nexit 1\n' });
  return dir;
}

/** @brief 有一次提交的仓库（README.md 加 files；synthetic）。 */
export const repoProject = (root, name, files = {}) => makeProject(root, name, { files, repo: true });

/**
 * @brief 很多个已提交小文件的仓库（synthetic）：worktree add 要检出它们，建 worktree 中这段时间长一些
 *        （§11.5.6 的拒绝要在这期间发）。count 个文件分在每 200 个一个的目录里。
 */
export function bigRepo(root, name, count) {
  const files = {};
  for (let i = 0; i < count; i += 1) files[`d${Math.floor(i / 200)}/f${i}.txt`] = `${i}\n`;
  return repoProject(root, name, files);
}

/**
 * @brief 不是 git 仓库的文件夹（synthetic）：README.md、.gitignore（忽略 ignored.txt）、ignored.txt、没写进 .gitignore 的
 *        node_modules/x.js 与 .work/draft.md（FS-109：.work 不进第一次提交，按 .gitignore 提交）。
 */
export function plainFolder(root, name) {
  return makeProject(root, name, { files: { '.gitignore': 'ignored.txt\n', 'ignored.txt': 'ignored\n',
    'node_modules/x.js': 'module.exports = 1;\n', '.work/draft.md': 'draft\n' } });
}

/** @brief git worktree list --porcelain 的各项：[{ path（反斜杠写法）, branch, locked, prunable }]。 */
export function worktreeList(repo) {
  const out = gitRun(repo, ['worktree', 'list', '--porcelain']).stdout;
  return out.split(/\r?\n\r?\n/).filter((block) => block.trim()).map((block) => {
    const lines = block.split(/\r?\n/);
    const value = (key) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
    return { path: value('worktree')?.replace(/\//g, '\\') ?? null, branch: value('branch'),
      locked: lines.some((line) => line.startsWith('locked')),
      prunable: lines.some((line) => line.startsWith('prunable')) };
  });
}

/** @brief 仓库里 mori/ 下的分支名（排好序）。 */
export const moriBranches = (repo) => gitRun(repo, ['branch', '--list', 'mori/*', '--format=%(refname:short)'])
  .stdout.split(/\r?\n/).filter(Boolean).sort();
/** @brief 仓库里有这个分支。 */
export const hasBranch = (repo, branch) => gitRun(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  .code === 0;
/** @brief 某个提交里的文件（git ls-tree -r --name-only）。 */
export const treeFiles = (repo, rev) => git(repo, 'ls-tree', '-r', '--name-only', rev).split(/\r?\n/)
  .filter(Boolean);
/** @brief 这个 worktree 在共用 .git 里的登记目录（<R>\.git\worktrees\<名字>）。 */
export const adminDir = (repo, path) => join(repo, '.git', 'worktrees', basename(path));

/** @brief 会话文件里最后一条 mori.worktree 的 data；没有时为 null。 */
export function worktreeEntryOf(file) {
  return readJsonl(file).filter((entry) => entry.type === 'custom' && entry.customType === 'mori.worktree')
    .at(-1)?.data ?? null;
}

/** @brief 会话文件里的 mori.ref 条目的 data（按顺序）。 */
export const refEntriesOf = (file) => readJsonl(file).filter((entry) => entry.type === 'custom'
  && entry.customType === 'mori.ref').map((entry) => entry.data);

/** @brief 会话文件所在目录的名字（pi 的 --<编码后的 cwd>--）。 */
export const sessionDirName = (file) => basename(dirname(file));

// ---------- 页面：会话与输入框下一行 ----------

/**
 * @brief 补上会话的 id、会话文件与工作路径（侧栏行的 data-file 与后台进程的 SessionInfo），会话在建 worktree 之后
 *        会话文件会换：每次都重新读。返回 who（就地更新）。
 */
export async function refreshWho(ctx, who) {
  const found = await userSession(ctx, who.tab);
  if (found?.sessionFile) Object.assign(who, found);
  const info = who.sessionFile ? await liveInfo(ctx, who.sessionFile).catch(() => null) : null;
  if (info) Object.assign(who, { cwd: info.cwd, worktree: info.worktree ?? null, info });
  return who;
}

/** @brief 等这个会话收到一条 mori.workspace_status（since 之后），返回它的 status；超时时为 null。 */
export function waitWorkspace(ctx, who, since, timeout = 20000) {
  return poll(async () => (await kernelEvents(ctx, who.sessionId, 'mori.workspace_status', since)).at(-1)?.data
    ?.status ?? null, timeout, 150);
}

/**
 * @brief 输入框下一行权限按钮后面那一项此刻的样子：{ kind（toggle / init-git / null）, afterPermission（是权限按钮
 *        紧跟的那一项）, pressed（aria-pressed）, label（读屏名）, title（悬停）, textShown（名字的文字看得见）, icon }。
 */
export function rowItemOf(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const button = pane?.querySelector('[data-testid="worktree-toggle"], [data-testid="init-git"]') ?? null;
    if (!button) return { kind: null };
    const text = button.querySelector('.worktree-text');
    const shown = Boolean(text) && getComputedStyle(text).display !== 'none' && text.getBoundingClientRect().width > 0;
    return { kind: button.dataset.testid === 'worktree-toggle' ? 'toggle' : 'init-git',
      afterPermission: Boolean(pane.querySelector('.composer-bottom > .permission + .worktree-item')?.contains(button)),
      pressed: button.getAttribute('aria-pressed'), label: button.getAttribute('aria-label'),
      title: button.getAttribute('title'), textShown: shown, icon: Boolean(button.querySelector('svg')) };
  }, paneSel(tab));
}

/** @brief 点 Worktree 开关，等 aria-pressed 变成 want（'true' / 'false'）。 */
export async function setToggle(ctx, tab, want) {
  await showTab(ctx, tab);
  const css = `${paneSel(tab)} [data-testid="worktree-toggle"]`;
  await ctx.page.locator(css).waitFor({ timeout: 30000 });
  if ((await ctx.page.locator(css).getAttribute('aria-pressed')) !== String(want)) await ctx.page.locator(css).click();
  await ctx.page.waitForFunction(({ sel, value }) => document.querySelector(sel)
    ?.getAttribute('aria-pressed') === value, { sel: css, value: String(want) }, { timeout: 5000 });
}

/**
 * @brief 在页面里记下输入框下一行那一项与 Starting… / 发送中 / 运行中同时出现过没有（window.__wtRow：notReady、busy
 *        为看到过的次数，bad 为同时出现的记录，first 为每个会话面板第一次出现这一项的时刻）。fs-worktree.md：这几种时候两样都不显示。重新启动 App 后要再装。
 */
export function watchRowItem(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__wtRow) return;
    const seen = { notReady: 0, busy: 0, bad: [], first: {} };
    window.__wtRow = seen;
    const scan = () => {
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const item = pane.querySelector('[data-testid="worktree-toggle"], [data-testid="init-git"]');
        const notReady = Boolean(pane.querySelector('[data-testid="not-ready"]'));
        const busy = pane.dataset.sending === 'true' || pane.dataset.running === 'true';
        if (notReady) seen.notReady += 1;
        if (busy) seen.busy += 1;
        if (item && (notReady || busy)) seen.bad.push({ t: Date.now(), tab: pane.dataset.tab, notReady, busy });
        if (item) seen.first[pane.dataset.tab] ??= Date.now();
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-sending', 'data-running'] });
    scan();
  });
}

/** @brief watchRowItem 记下的。 */
export const rowItemSeen = (ctx) => ctx.page.evaluate(() => window.__wtRow ?? null);

// ---------- 发第一条消息、等 worktree 会话 ----------

/** @brief 在这个会话的输入框里写字、按 Enter（不等结果）。 */
export async function typeAndSend(ctx, tab, text) {
  await showTab(ctx, tab);
  const box = ctx.page.locator(`${paneSel(tab)} .composer textarea`);
  await box.fill(text);
  await box.press('Enter');
}

/**
 * @brief 等这个标签换成 worktree 会话：侧栏行的会话文件换了、后台进程给出 SessionInfo.worktree；最多 timeout。
 * @return { sessionId, sessionFile, info }；超时为 null
 */
export function waitWorktreeSession(ctx, tab, timeout = 60000) {
  return poll(async () => {
    const found = await userSession(ctx, tab);
    const info = found?.sessionFile ? await liveInfo(ctx, found.sessionFile).catch(() => null) : null;
    return info?.worktree ? { ...found, info } : null;
  }, timeout, 300);
}

/** @brief 等这个会话面板空闲（不在发送、生成，没有阶段行），连续 stableMs；超时时报错。 */
export async function waitPaneIdle(ctx, tab, timeout = 90000, stableMs = 800) {
  const deadline = Date.now() + timeout;
  let since = null;
  while (Date.now() < deadline) {
    const idle = await ctx.page.evaluate((selector) => {
      const pane = document.querySelector(selector);
      return Boolean(pane) && pane.dataset.running === 'false' && pane.dataset.sending === 'false'
        && !pane.querySelector('[data-testid="stage"]');
    }, paneSel(tab));
    if (!idle) since = null;
    else if (since === null) since = Date.now();
    else if (Date.now() - since >= stableMs) return;
    await sleep(150);
  }
  throw new Error(`session ${tab} did not become idle within ${timeout} ms`);
}

/**
 * @brief 会话面板里的错误卡、你的消息、助手回复与发出的引用芯片：{ errors, users, assistants, sentQuotes, draft, chips }。
 */
export function paneFacts(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const all = (css) => [...(pane?.querySelectorAll(css) ?? [])];
    const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
    return { errors: all('[data-testid="error-card"]').map(text), users: all('[data-testid="user-message"]').map(text),
      assistants: all('[data-testid="assistant"]').map(text), sentQuotes: all('[data-testid="sent-quote"]').length,
      draft: pane?.querySelector('.composer textarea')?.value ?? null, chips: all('[data-testid="quote-chip"]').length,
      unavailable: all('[data-testid="unavailable-card"]').length,
      banner: pane?.querySelector('.banner.danger[role="alert"]')?.textContent?.trim() ?? null };
  }, paneSel(tab));
}

// ---------- 引用芯片（FS-99、FS-100） ----------

/**
 * @brief 测试准备与操作：项目里的 README.md 末尾加一行（没提交的改动，git 状态里出现它；第一行不变），打开右栏，
 *        点 git 状态里的 README.md 打开阅读器，选第 1 行点 Attach as context，等输入框上方出现一个芯片。
 */
export async function attachReadme(ctx, tab, project) {
  const file = join(project, 'README.md');
  if (!readFileSync(file, 'utf8').includes('synthetic uncommitted line')) {
    writeFileSync(file, `${readFileSync(file, 'utf8')}synthetic uncommitted line\n`);
  }
  await showTab(ctx, tab);
  const toggle = ctx.page.locator(`${paneSel(tab)} .right-toggle`);
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const row = ctx.page.locator('[data-testid="right-panel"] [data-testid="git-file"][data-path="README.md"]');
  await poll(async () => {
    if (await row.count()) return true;
    await ctx.page.locator('[data-testid="changes-refresh"]').click().catch(() => {});
    return false;
  }, 20000, 1000);
  await row.click();
  // .md 默认显示渲染后的预览（changes.md“显示 Markdown 预览”，M24）：等到预览或源码出现，是预览时切到源码再选行
  await ctx.page.locator('[data-testid="file-preview"], [data-testid="file-content"]').first()
    .waitFor({ timeout: 10000 });
  await viewSource(ctx.page);
  await selectLines(ctx.page, 1, 1);
  await ctx.page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  await ctx.page.locator(`${paneSel(tab)} [data-testid="quote-chip"]`).first().waitFor({ timeout: 5000 });
  await toggle.click();
}

// ---------- 侧栏：行的菜单、归档、恢复、删除 ----------

/** @brief 会话行（按标识或会话文件）。 */
export const rowByTab = (ctx, tab) => ctx.page.locator(`.session-item[data-row="${tab}"]`).first();
export const rowByFile = (ctx, file) => ctx.page.locator(`.session-item[data-file=${JSON.stringify(file)}]`).first();

/** @brief 键盘打开这一行的右键菜单（Shift+F10），↓ 移到文字为 label 的菜单项再按 Enter；走不到时抛错。 */
export async function chooseRowItem(ctx, row, label) {
  await row.focus();
  await ctx.page.keyboard.press('Shift+F10');
  await ctx.page.getByTestId('session-menu').waitFor({ timeout: 5000 });
  for (let step = 0; step < 7; step += 1) {
    const focused = await ctx.page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute('role') === 'menuitem' ? (el.firstChild?.textContent ?? '').trim() : null;
    });
    if (focused === label) {
      await ctx.page.keyboard.press('Enter');
      return;
    }
    await ctx.page.keyboard.press('ArrowDown');
  }
  throw new Error(`menu item ${label} cannot be reached by keyboard`);
}

/** @brief 这一行菜单里某一项是否可用（打开菜单读完再按 Esc 关上）。 */
export async function rowItemEnabled(ctx, row, label) {
  await row.focus();
  await ctx.page.keyboard.press('Shift+F10');
  const menu = ctx.page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  const enabled = await menu.getByRole('menuitem').evaluateAll((items, want) => items.some((item) => (item.firstChild
    ?.textContent ?? '').trim() === want && !item.disabled), label);
  await ctx.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  return enabled;
}

/** @brief 本机记下的已归档会话文件（localStorage 的 mori.archived）。 */
export const archivedFiles = (ctx) => ctx.page.evaluate(() => JSON.parse(localStorage.getItem('mori.archived')
  ?? '[]'));

/** @brief 归档这个会话（右键菜单 Archive），等它进了已归档列表。 */
export async function archiveRow(ctx, file) {
  await chooseRowItem(ctx, rowByFile(ctx, file), 'Archive');
  const done = await poll(async () => (await archivedFiles(ctx)).some((item) => samePath(item, file)), 15000, 200);
  if (!done) throw new Error(`${file} was not archived`);
}

/**
 * @brief 展开侧栏的 Archived，点这个已归档的会话（恢复并打开），等它打开（输入框在、没有 Starting…）或打开失败（横幅）。
 * @return 这个会话的标识（会话行的 data-row）
 */
export async function openArchived(ctx, file) {
  const toggle = ctx.page.getByTestId('archived-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const row = ctx.page.locator(`[data-testid="archived-list"] .session-item[data-file=${JSON.stringify(file)}]`);
  await row.click();
  await ctx.page.waitForFunction((f) => {
    const active = document.querySelector('.session-item.active');
    const pane = document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
    const ready = pane?.querySelector('.composer textarea') && !pane.querySelector('[data-testid="not-ready"]');
    return active?.getAttribute('data-file') === f && Boolean(pane?.querySelector('.banner.danger') || ready);
  }, file, { timeout: 90000 });
  return rowByFile(ctx, file).getAttribute('data-row');
}

/** @brief 侧栏这一行的状态（data-status）；没有状态时为 null。 */
export const rowStatusOf = (ctx, file) => rowByFile(ctx, file).locator('[data-testid="session-status"]')
  .getAttribute('data-status', { timeout: 2000 }).catch(() => null);

/**
 * @brief 在页面里记下出现过的删除确认框刚出现时的样子（window.__wtDelete：{ t, checking（有 Checking its worktree…）,
 *        blocked（Delete 为 aria-disabled） }），以及出现过的确认类对话框（window.__wtDialogs：{ t, testid }）。
 */
export function watchDialogs(ctx) {
  return ctx.page.evaluate((checkingText) => {
    if (window.__wtDelete) return;
    window.__wtDelete = [];
    window.__wtDialogs = [];
    const seen = new WeakSet();
    const scan = () => {
      const css = '[role="alertdialog"], [role="dialog"], [data-testid="trust-dialog"]';
      for (const el of document.querySelectorAll(css)) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__wtDialogs.push({ t: Date.now(), testid: el.dataset.testid ?? null });
        if (el.dataset.testid !== 'delete-dialog') continue;
        const confirm = el.querySelector('.dialog-actions .button.danger');
        window.__wtDelete.push({ t: Date.now(), checking: el.textContent.includes(checkingText),
          blocked: confirm?.getAttribute('aria-disabled') === 'true' });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
    scan();
  }, WT.checking);
}

/** @brief watchDialogs 记下的（since 之后）：{ deletes, dialogs }。 */
export const dialogsSince = (ctx, since) => ctx.page.evaluate((from) => ({
  deletes: (window.__wtDelete ?? []).filter((item) => item.t >= from),
  dialogs: (window.__wtDialogs ?? []).filter((item) => item.t >= from) }), since);

/** @brief 删除确认框此刻的样子：{ note（文字）, kind, blocked（Delete 为 aria-disabled）, error, text }；不在时 null。 */
export function deleteDialogOf(ctx) {
  return ctx.page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="delete-dialog"]');
    if (!dialog) return null;
    const note = dialog.querySelector('[data-testid="delete-worktree-note"]');
    const confirm = dialog.querySelector('.dialog-actions .button.danger');
    return { note: note?.textContent?.trim() ?? null, kind: note?.dataset.kind ?? null,
      blocked: confirm?.getAttribute('aria-disabled') === 'true',
      error: dialog.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
      text: dialog.querySelector('p')?.textContent?.trim() ?? null };
  });
}

/** @brief 打开这一行的删除确认框，等 worktrees.list 返回（Checking its worktree… 不在了）；返回 deleteDialogOf。 */
export async function openDelete(ctx, row) {
  await chooseRowItem(ctx, row, 'Delete…');
  const dialog = ctx.page.getByTestId('delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await ctx.page.waitForFunction((text) => !document.querySelector('[data-testid="delete-dialog"]')?.textContent
    .includes(text), WT.checking, { timeout: 30000 });
  return deleteDialogOf(ctx);
}

/** @brief 删除确认框里点 Delete，等对话框关掉或出现错误；返回 'closed' 或错误原文。 */
export async function confirmDelete(ctx) {
  const dialog = ctx.page.getByTestId('delete-dialog');
  await dialog.locator('.dialog-actions .button.danger').click();
  const outcome = await poll(async () => {
    if (!(await dialog.count())) return 'closed';
    const state = await deleteDialogOf(ctx);
    return state?.error ?? null;
  }, 60000, 200);
  return outcome ?? 'timeout';
}

/** @brief 删除确认框里点 Cancel，等它关掉。 */
export async function cancelDelete(ctx) {
  const dialog = ctx.page.getByTestId('delete-dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
}

// ---------- 设置页 Storage（FS-107） ----------

/** @brief 打开设置页并切到 Storage，等 Worktrees 读完（不再是 Loading…）。 */
export async function openStorage(ctx) {
  const page = ctx.page;
  if (!(await page.getByTestId('settings-page').count())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  }
  await page.locator('[data-testid="settings-nav"] button[data-section="storage"]').click();
  await page.getByTestId('storage-worktrees').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="storage-worktrees"] [role="status"]'), null,
    { timeout: 30000 });
}

/** @brief Storage 的 Worktrees 一块此刻的样子：{ items（{ path, mark, text }）, empty, button（null 为没有）, errors }。 */
export function storageOf(ctx) {
  return ctx.page.evaluate(() => {
    const block = document.querySelector('[data-testid="storage-worktrees"]');
    if (!block) return null;
    const button = block.querySelector('[data-testid="worktrees-cleanup"]');
    return {
      items: [...block.querySelectorAll('[data-testid="worktree-item"]')].map((el) => ({ path: el.dataset.path,
        mark: el.dataset.mark, text: el.textContent.replace(/\s+/g, ' ').trim(),
        markText: el.querySelector('.storage-mark')?.textContent ?? null })),
      empty: block.querySelector('.settings-empty')?.textContent?.trim() ?? null,
      heading: block.querySelector('h3')?.textContent ?? null,
      note: block.querySelector('p.muted')?.textContent ?? null,
      section: block.closest('.settings-section')?.querySelector('h2')?.textContent ?? null,
      button: button ? { disabled: button.disabled, text: button.textContent.trim() } : null,
      errors: [...block.querySelectorAll('[role="alert"]')].map((el) => el.textContent.trim()),
    };
  });
}

/** @brief 点 Clean up worktrees…，在确认框里点 Clean up，等确认框关掉、列表再读完；返回确认框的标题与说明。 */
export async function cleanUpStorage(ctx) {
  const page = ctx.page;
  await page.getByTestId('worktrees-cleanup').click();
  const dialog = page.getByTestId('worktrees-cleanup-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const shown = await dialog.evaluate((el) => ({ title: el.querySelector('h2')?.textContent ?? null,
    text: el.querySelector('p')?.textContent ?? null,
    focus: document.activeElement?.textContent ?? null }));
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="storage-worktrees"] [role="status"]'), null,
    { timeout: 30000 });
  return shown;
}

/** @brief 设置页的 Back to app，等设置页关掉。 */
export async function leaveSettings(ctx) {
  await ctx.page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await ctx.page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
}

// ---------- Initialize git 确认框（FS-109） ----------

/** @brief Initialize git 确认框此刻的样子；不在时为 null。 */
export function initDialogOf(ctx) {
  return ctx.page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="init-git-dialog"]');
    if (!dialog) return null;
    const buttons = [...dialog.querySelectorAll('.dialog-actions button')];
    return { title: dialog.querySelector('h2')?.textContent ?? null,
      text: dialog.querySelector('p')?.textContent ?? null,
      path: dialog.querySelector('[data-testid="init-git-path"]')?.textContent ?? null,
      buttons: buttons.map((button) => button.textContent.trim()),
      disabled: buttons.map((button) => button.disabled),
      focus: document.activeElement?.closest('[data-testid="init-git-dialog"]') ? document.activeElement.textContent
        .trim() : null,
      error: dialog.querySelector('[role="alert"]')?.textContent?.trim() ?? null };
  });
}

/** @brief 确认框里点 Initialize git，等它关掉（成功）或出现错误；返回 'closed' 或错误原文。 */
export async function confirmInit(ctx) {
  const dialog = ctx.page.getByTestId('init-git-dialog');
  await dialog.getByRole('button', { name: 'Initialize git', exact: true }).click();
  const outcome = await poll(async () => {
    if (!(await dialog.count())) return 'closed';
    const state = await initDialogOf(ctx);
    return state?.error && !state.disabled.some(Boolean) ? state.error : null;
  }, 120000, 200);
  return outcome ?? 'timeout';
}

/** @brief 确认框里点 Cancel，等它关掉。 */
export async function cancelInit(ctx) {
  const dialog = ctx.page.getByTestId('init-git-dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
}

// ---------- 其他 ----------

/** @brief 文件夹在不在。 */
export const exists = (path) => Boolean(path) && existsSync(path);

/** @brief 后台进程里会话的 SessionInfo（session.open 对开着的会话只读地交出它）；不在时为 null。 */
export const infoOf = (ctx, file) => liveInfo(ctx, file).catch(() => null);

/** @brief 经进程桥发一条命令，出错时不抛：{ result, error }。 */
export const tryCommand = (ctx, command) => ctx.page.evaluate((cmd) => window.mori.request(cmd)
  .then((result) => ({ result, error: null }), (error) => ({ result: null, error: String(error?.message ?? error) })),
command);

export { bridge };
