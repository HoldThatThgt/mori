// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-worktree：worktree 与 Initialize git（§11，
// 状态表 docs/v1/screens/fs-worktree.md）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint/server.mjs，synthetic：关键词模式，写法见 scenarios/fs-git.mjs、fs-worktree.mjs 开头），逐条验收这些编号
// 在 App 层的通过条件：
//   FS-98 开关与 Initialize git… 的出现、FS-99 第一条消息建 worktree、FS-100 建 worktree 失败、FS-101 侧栏与顶栏、
//   FS-102 按主文件夹算项目、FS-103 worktree 里读 pi 的配置、FS-104 归档、FS-105 打开 worktree 不在的会话、FS-106 删除、
//   FS-107 设置页 Clean up worktrees、FS-109 Initialize git、FS-110 在 worktree 会话里再开 worktree、FS-111 子文件夹、
//   FS-112 不在后台清理。
// 依据：file-system.md §11、§19，状态表 docs/v1/screens/fs-worktree.md。只在单元层的条件（FS-100 的 startInWorktree、
// FS-106 的 state/worktrees.ts、FS-109 直接调 initGit）不在这里。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-worktree.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-worktree(-packaged).json（--only 时 fs-partial-app-worktree…，不计入覆盖检查），截图与
// app.log 在 test-results/fs-app-worktree/。端口：合成端点 5014，记录代理 5015（fs-helpers FS_PORTS.worktree）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里两个本机提供商（fsp：fake-fs、fake-fs2，都支持思考；fst：每次对话
// 请求都回 404 的 fake-tiny-404）与分组 g = [fsp]（默认范围）；快照目录另建（MORI_SNAPSHOTS_DIR）；App 的 HOME 指向临时目录 ROOT\home，
// 里面的 .gitconfig 只有测试的提交者（FS-109 在步骤之间改写它：去掉 user、加一个总是失败的 pre-commit），从不读写你真的
// 全局配置；临时目录 ROOT 下的项目见 makeProjects（git 仓库用真实 git 建）。启动后先 away.set { timeout: 'never' }。
// 步骤有先后：后面的步骤用前面的会话（同 fs-app-changes），--only 时缺了前面的步骤会记成步骤失败。最后两步重新启动 App：
// restart 用同一个数据目录，noGit 另起一次、MORI_GIT_PATH 指向临时目录里不存在的 git.exe（§19.1）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gitStep, keywordSteps } from '../fake-endpoint/scenarios/fs-git.mjs';
import { wtStep } from '../fake-endpoint/scenarios/fs-worktree.mjs';
import {
  brief, closeFsApp, fsArgs, fsRecorder, fsRoot, fsUserData, kernelEvents, paneSel, poll, readJsonl, runSuite, same,
  samePath, sendFs, setPermission, sleep, startFsApp, startFsEndpoint, toolResultsIn, underPath,
} from './fs-helpers.mjs';
import {
  fileInCommit, git, gitRun, makeProject, projectDirName, sendTurn, setPanel, writeFiles,
} from './fs-git-helpers.mjs';
import { choosePick, recentActivity } from './fs-rewind-helpers.mjs';
import {
  WORKTREE_NAME, WT, adminDir, archiveRow, archivedFiles, attachReadme, bigRepo, branchGone, cancelDelete, cancelInit,
  chooseRowItem, cleanUpStorage, confirmDelete, confirmInit, deleteDialogOf, deleteNote, dialogsSince, failingHooks,
  hasBranch, infoOf, initDialogOf, leaveSettings, moriBranches, notCommitted, openArchived, openDelete,
  openStorage, paneFacts, plainFolder, refEntriesOf, refreshWho, repoProject, rowByFile, rowByTab, rowItemEnabled,
  rowItemOf, rowItemSeen, rowStatusOf, sessionDirName, setToggle, storageOf, treeFiles, tryCommand, typeAndSend,
  unregistered, waitPaneIdle, waitWorkspace, waitWorktreeSession, watchDialogs, watchRowItem, worktreeEntryOf,
  worktreeList, writeHomeConfig,
} from './fs-worktree-helpers.mjs';
import { composerRow, layoutProblems } from './m1-layout.mjs';
import { answerTrustDialog, archivedState, holdFile, stubFolder, treeState } from './m3-helpers.mjs';
import { openSettingsSection } from './m6-helpers.mjs';
import { feedbackSection, listedSessions, seedFeedback, waitSettled, enhanceRequests } from './mem-enhance-helpers.mjs';
import { backToApp as leaveMemory, memBase, openMemoryPage } from './mem-tool-helpers.mjs';
import {
  clickTeamSwitch, contentText, newSession, openProject, reopenSession, seedTeamUserData, showTab, tbModel, tbProvider,
} from './tb-helpers.mjs';
import { fitPane, resetWindow } from './v1-models-row-helpers.mjs';
import { stagesOf } from './v1-switch-helpers.mjs';

const args = fsArgs('worktree');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面（synthetic）；路径要短，内部仓库在快照目录下再加 worktree 路径的编码 */
const ROOT = fsRoot('mori-fs-wt-');
/** FS-99 建 worktree 中的拒绝：已提交的小文件数（worktree add 检出它们要一两秒） */
const BIG_FILES = 4000;
/** 范围 B 与思考强度（FS-99：发消息前选的，worktree 会话里要还在） */
const PICK_B = 'fsp/fake-fs2';
const EFFORT = 'high';
/** FS-99 发消息前改的会话名 */
const SESSION_NAME = 'fs99 kept name';
/** FS-102：cfg 项目 .mori/models.json 把分组 g 缩小到 fake-fs2（synthetic），别的项目按 g 用 fake-fs */
const NARROWED = 'fake-fs2';
/** FS-102、FS-103：cfg 项目已提交的 AGENTS.md 与 .pi/settings.json，没提交的改动（synthetic） */
const CFG_AGENTS = '# Synthetic project instructions\n\nMORI-AGENTS-FS103\n';
/** FS-100：每次对话请求都回 404 的模型（合成端点的 -404 后缀，server.mjs 开头）；第一次 404 之后它记为 not_found */
const NOT_FOUND_PICK = 'fst/fake-tiny-404';

/** @brief memory 工具的一次调用（关键词 call tool:，synthetic）。 */
const memoryCall = (abstract) => `call tool: memory ${JSON.stringify({ action: 'save', kind: 'fact', abstract,
  quote: `remember ${abstract}` })}`;

// ---------- 准备 ----------

/**
 * @brief 测试准备（synthetic）：ROOT 下的项目。p1 是主要的仓库（.gitignore 忽略 node_modules，FS-105 的目录联接）；
 *        fresh 还没有提交；plain1–plain3 不是仓库；badcfg 的 .git/config 坏了（认仓库出错）；slow 有很多已提交的文件；
 *        cfg 有已提交的 AGENTS.md 与 .pi/settings.json（{}），没提交的 .mori/models.json、.mori/agents 与改过的
 *        .pi/settings.json；mono 的 app/ 已提交，mono2 的 app/ 只有未跟踪的文件；failing 的 .mori/worktrees 是一个文件；
 *        tiny 给记为 not_found 的模型用；empty 是空文件夹（Initialize git 后也有一个提交）；rootgone 之后被改名（仓库根不在了）。
 */
function makeProjects() {
  const p = { p1: repoProject(ROOT, 'p1', { '.gitignore': 'node_modules\n', 'src/a.ts': 'export const a = 1;\n' }) };
  p.fresh = makeProject(ROOT, 'fresh');
  git(p.fresh, 'init', '-q');
  for (const name of ['plain1', 'plain2', 'plain3']) p[name] = plainFolder(ROOT, name);
  p.badcfg = repoProject(ROOT, 'badcfg');
  writeFileSync(join(p.badcfg, '.git', 'config'), '[[[ synthetic broken config\n');
  p.slow = bigRepo(ROOT, 'slow', BIG_FILES);
  p.cfg = repoProject(ROOT, 'cfg', { 'AGENTS.md': CFG_AGENTS, '.pi/settings.json': '{}\n' });
  writeFiles(p.cfg, { '.pi/settings.json': `${JSON.stringify({ defaultTools: ['+powershell'] })}\n`,
    '.mori/models.json': `${JSON.stringify({ groups: { g: [`fsp/${NARROWED}`] } })}\n` });
  writeSplitRoles(p.cfg);
  p.mono = repoProject(ROOT, 'mono', { 'app/README.md': '# app\n' });
  p.mono2 = repoProject(ROOT, 'mono2');
  writeFiles(p.mono2, { 'app/new.txt': 'not committed yet\n' });
  p.failing = repoProject(ROOT, 'failing');
  writeFiles(p.failing, { '.mori/worktrees': 'synthetic: a file where the worktrees folder should be\n' });
  p.tiny = repoProject(ROOT, 'tiny');
  p.rootgone = repoProject(ROOT, 'rootgone');
  p.empty = join(ROOT, 'empty');
  mkdirSync(p.empty);
  return p;
}

/** @brief 测试准备（synthetic）：cfg 主文件夹 .mori/agents 里分开配置的四个角色（没提交，worktree 里没有）。 */
function writeSplitRoles(project) {
  const roles = [['chat', 'Talks with the user', 'seats: [dialog]'], ['planner', 'Plans and closes requests',
    'seats: [create, close]'], ['executor', 'Changes code', null], ['reviewer', 'Reviews work', null]];
  for (const [name, description, seats] of roles) {
    const head = [`name: ${name}`, `description: ${description}`, ...(seats ? [seats] : [])].join('\n');
    writeFiles(project, { [`.mori/agents/${name}.md`]: `---\n${head}\n---\nYou are the ${name} role.\n` });
  }
}

/**
 * @brief 写数据目录（synthetic test setup）：提供商 fsp（fake-fs、fake-fs2，支持思考）与 fst（fake-tiny-404：对话请求
 *        都回 404），分组 g = [fsp] 为默认范围；地址都是记录代理。
 */
function seedWtUserData(ctx) {
  const fsp = tbProvider('fsp', ctx.ep.proxyPort, [tbModel('fake-fs', { reasoning: true }),
    tbModel(NARROWED, { reasoning: true })]);
  const fst = tbProvider('fst', ctx.ep.proxyPort, [tbModel('fake-tiny-404')]);
  seedTeamUserData(ctx.userData, { providers: [fsp, fst], groups: [{ id: 'g', members: ['fsp'] }],
    normalDefault: 'g' });
}

/** @brief 启动 App（fs-helpers startFsApp：away never），装上本套件的记录器与渲染进程的控制台记录。 */
async function startWt(ctx) {
  await startFsApp(ctx);
  ctx.console ??= [];
  ctx.page.on('console', (message) => ctx.console.push({ t: Date.now(), text: message.text() }));
  await watchRowItem(ctx);
  await watchDialogs(ctx);
}

/** @brief 关掉再用同一个数据目录启动 App（ctx.env 决定这次的环境）。 */
async function restartWt(ctx) {
  await closeFsApp(ctx);
  ctx.projectTabs = {};
  await startWt(ctx);
}

/** @brief 合成端点、项目、HOME 与数据目录（synthetic test setup），启动 App。 */
async function setup(ctx) {
  ctx.home = join(ROOT, 'home');
  writeHomeConfig(ctx.home);
  ctx.env = { HOME: ctx.home };
  ctx.p = makeProjects();
  ctx.ep = await startFsEndpoint('worktree');
  seedWtUserData(ctx);
  await startWt(ctx);
}

// ---------- 共用的操作 ----------

/** @brief 点 Open folder… 在 folder 里开一个新会话（不信任询问），补上会话的 id 与会话文件。 */
async function openMain(ctx, folder) {
  const since = Date.now();
  const tab = await openProject(ctx, folder);
  return refreshWho(ctx, { tab, since });
}

/** @brief 等输入框下一行出现 kind（toggle / init-git）；等不到时抛错。 */
async function waitItem(ctx, tab, kind, timeout = 30000) {
  const item = await poll(async () => {
    const now = await rowItemOf(ctx, tab);
    return now.kind === kind ? now : null;
  }, timeout, 200);
  if (!item) throw new Error(`no ${kind} in ${tab} within ${timeout} ms`);
  return item;
}

/**
 * @brief 在 folder 里开一个新会话，Full access（full 为真时），打开 Worktree 开关发第一条消息，等 worktree 会话建好、
 *        这次运行结束。返回 who（含 worktree、cwd、会话文件）。
 */
async function createWorktree(ctx, folder, text, { full = true } = {}) {
  const who = await openMain(ctx, folder);
  await waitItem(ctx, who.tab, 'toggle');
  if (full) await setPermission(ctx, who.tab, 'full');
  await setToggle(ctx, who.tab, true);
  await typeAndSend(ctx, who.tab, text);
  if (!(await waitWorktreeSession(ctx, who.tab))) throw new Error(`no worktree session for "${text.slice(0, 60)}"`);
  await waitPaneIdle(ctx, who.tab);
  return refreshWho(ctx, who);
}

/** @brief 记录代理收到的、最后一条 user 消息含 marker 的对话请求：[{ model, tools, lastUser }]（since 之后）。 */
function chatBodies(ctx, since, marker) {
  return ctx.ep.proxy.captures.filter((item) => item.chat && item.body && item.t >= since).map((item) => {
    const messages = item.body.messages ?? [];
    const lastUser = contentText(messages.findLast((m) => m.role === 'user')?.content);
    return { model: item.body.model, tools: (item.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
      lastUser };
  }).filter((item) => item.lastUser.includes(marker));
}

/** @brief 等渲染进程控制台出现这个 worktree 的清理结果（state/worktrees.ts logCleanUp），返回那一行；等不到为 null。 */
const cleanUpLine = (ctx, path, since, timeout = 30000) => poll(() => ctx.console.find((item) => item.t >= since
  && item.text.includes(`worktrees.cleanUp of ${path}`))?.text ?? null, timeout, 200);

/** @brief 这个 worktree 的分支在仓库里的提交（git rev-parse）。 */
const branchTip = (repo, branch) => gitRun(repo, ['rev-parse', '--verify', '--quiet', branch]).stdout.trim();

/** @brief 侧栏里工作目录为 folder 的那一组（treeState 的一项）；没有时为 null。 */
async function groupOf(ctx, folder) {
  return (await treeState(ctx.page)).find((group) => samePath(group.cwd, folder)) ?? null;
}

/** @brief 侧栏这一行的分支标签文字；没有时为 null。 */
const branchLabel = (ctx, file) => rowByFile(ctx, file).locator('[data-testid="session-branch"]')
  .textContent({ timeout: 2000 }).catch(() => null);

// ---------- FS-107（开头）：没有留下的 worktree ----------

/** @brief 还没有归档过任何会话时 Storage：No worktrees are left from archived sessions.，按钮不可用。 */
async function storageEmpty(ctx) {
  await openStorage(ctx);
  const view = await storageOf(ctx);
  record('FS-107 with no worktrees left from archived sessions Storage shows "No worktrees are left from archived '
    + 'sessions." and Clean up worktrees… is disabled', view?.items.length === 0 && view.empty === WT.storageEmpty
    && view.button?.disabled === true, brief(view));
  record('FS-107 Settings has a Storage section with a Worktrees block and its explanation', view?.section
    === 'Storage' && view.heading === 'Worktrees' && view.note === WT.storageNote, brief(view));
  await leaveSettings(ctx);
}

// ---------- FS-98：开关与 Initialize git… 的出现 ----------

/** @brief 有提交的仓库：Worktree 开关紧跟权限按钮、默认关；操作记录 Turn on / Turn off worktree。 */
async function toggleShown(ctx) {
  const base = await openMain(ctx, ctx.p.p1);
  ctx.base = base;
  const item = await waitItem(ctx, base.tab, 'toggle');
  const firstStatus = (await kernelEvents(ctx, base.sessionId, 'mori.workspace_status'))[0]?.t ?? null;
  const firstShown = (await rowItemSeen(ctx))?.first?.[base.tab] ?? null;
  record('FS-98 the toggle shows only once the session’s first git status (mori.workspace_status) has arrived',
    firstStatus !== null && firstShown !== null && firstShown >= firstStatus, brief({ firstStatus, firstShown }));
  record('FS-98 a repository with a commit shows the Worktree toggle right after the permission button, off by '
    + `default (aria-pressed false), named Worktree, hover "${WT.toggleHint}"`, item.afterPermission
    && item.pressed === 'false' && item.label === 'Worktree' && item.title === WT.toggleHint && item.textShown,
  brief(item));
  await setToggle(ctx, base.tab, true);
  await setToggle(ctx, base.tab, false);
  const actions = await recentActivity(ctx, base.tab, 'fs98 toggle');
  record('FS-98 turning the toggle on and off is recorded in the activity log as "Turn on worktree" and "Turn off '
    + 'worktree"', actions.includes('Turn on worktree') && actions.includes('Turn off worktree'), brief(actions));
}

/**
 * @brief 打开 folder 的新会话，等它的第一份 git 状态，再看一会儿输入框下一行。返回 { status, item, who }。
 */
async function rowAfterStatus(ctx, folder) {
  const who = await openMain(ctx, folder);
  const status = await waitWorkspace(ctx, who, who.since);
  await sleep(500);
  return { status, item: await rowItemOf(ctx, who.tab), who };
}

/** @brief 没有提交、不是 git 仓库、认仓库出错时各是什么。 */
async function toggleKinds(ctx) {
  const fresh = await rowAfterStatus(ctx, ctx.p.fresh);
  record('FS-98 a repository without commits shows neither the Worktree toggle nor Initialize git…',
    fresh.status?.repo?.hasCommit === false && fresh.item.kind === null, brief({ repo: fresh.status?.repo,
      item: fresh.item }));
  const plain = await rowAfterStatus(ctx, ctx.p.plain3);
  record(`FS-98 a folder that isn't a git repository shows Initialize git… right after the permission button, hover `
    + `"${WT.initHint}"`, plain.status?.repo === null && plain.status.error === null && plain.item.kind === 'init-git'
    && plain.item.afterPermission && plain.item.title === WT.initHint, brief({ status: plain.status?.git,
    item: plain.item }));
  const broken = await rowAfterStatus(ctx, ctx.p.badcfg);
  record('FS-98 when repoInfo fails (a broken .git/config: git rev-parse errors) neither shows',
    broken.status?.repo === null && Boolean(broken.status?.error) && broken.item.kind === null,
    brief({ error: broken.status?.error, item: broken.item }));
  await setToggle(ctx, ctx.base.tab, true);
  await showTab(ctx, fresh.who.tab);
  await showTab(ctx, ctx.base.tab);
  const kept = await rowItemOf(ctx, ctx.base.tab);
  record('FS-98 a toggle turned on stays on after switching to another session and back', kept.pressed === 'true',
    brief(kept));
  await setToggle(ctx, ctx.base.tab, false);
}

/** @brief 这一栏 ≤ 460px：只剩图标、读屏名仍是 Worktree，这一行不换行、不超出。 */
async function toggleNarrow(ctx) {
  await showTab(ctx, ctx.base.tab);
  const width = await fitPane(ctx.app, ctx.page, 440);
  await sleep(300);
  const item = await rowItemOf(ctx, ctx.base.tab);
  const row = await composerRow(ctx.page);
  const problems = layoutProblems(row);
  record('FS-98 in a pane of 460 px or less the toggle is only the branch icon, its accessible name is still '
    + 'Worktree (hover: name, then the hint) and the row neither wraps nor overflows (m1-layout layoutProblems)',
  width <= 460 && item.kind === 'toggle' && !item.textShown && item.icon && item.label === 'Worktree'
    && String(item.title).startsWith('Worktree') && String(item.title).includes(WT.toggleHint)
    && problems.length === 0, brief({ width, item, problems }));
  await resetWindow(ctx.app, ctx.page);
}

/**
 * @brief 有了你的消息之后不显示；发送中、运行中、Starting… 时从没和这一项同时出现（watchRowItem 一直在记，Starting… 与
 *        运行中都看到过才算数）。
 */
async function toggleBusy(ctx) {
  const base = ctx.base;
  await sendFs(ctx, base, 'fs98 first message plain');
  await sendFs(ctx, base, 'fs98 second message wait 3s');
  const item = await rowItemOf(ctx, base.tab);
  const seen = await rowItemSeen(ctx);
  record('FS-98 once the session has your message the toggle is gone', item.kind === null, brief(item));
  record('FS-98 the toggle and Initialize git… never showed together with Starting…, sending or a running reply in '
    + 'any pane (both states were seen)', seen?.notReady > 0 && seen.busy > 0 && seen.bad.length === 0, brief(seen));
}

// ---------- FS-99：第一条消息建 worktree ----------

/** @brief 在这个会话的 Effort 菜单里选 level，等按钮的 data-level 变过去。 */
async function chooseEffort(ctx, tab, level) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="thinking-button"]`).click();
  await ctx.page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await ctx.page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.level === want && button.dataset.pending !== 'true';
  }, { selector: paneSel(tab), want: level }, { timeout: 15000 });
}

/** @brief 侧栏里改这个会话的名字（右键菜单 Rename，写名字按 Enter），等改名框消失。 */
async function renameTab(ctx, tab, name) {
  await chooseRowItem(ctx, rowByTab(ctx, tab), 'Rename');
  const input = ctx.page.getByTestId('rename-input');
  await input.fill(name);
  await input.press('Enter');
  await input.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 发第一条消息前选好范围、Effort、会话名、Full access、协作模式，打开开关。 */
async function prepareSettings(ctx, who) {
  await waitItem(ctx, who.tab, 'toggle');
  await choosePick(ctx, who.tab, PICK_B);
  await chooseEffort(ctx, who.tab, EFFORT);
  await renameTab(ctx, who.tab, SESSION_NAME);
  await setPermission(ctx, who.tab, 'full');
  await clickTeamSwitch(ctx, who.tab, 'always');
  await setToggle(ctx, who.tab, true);
}

/**
 * @brief 打开开关后发消息：阶段行 Creating worktree…；同一个会话 id、同一个标签；cwd 是 worktree；会话文件在
 *        --<worktree 编码>-- 目录下、含一条 mori.worktree；回复照常显示。
 */
async function create(ctx) {
  const who = await openMain(ctx, ctx.p.p1);
  await prepareSettings(ctx, who);
  const before = { sessionId: who.sessionId, sessionFile: who.sessionFile };
  const since = Date.now();
  await typeAndSend(ctx, who.tab, 'fs99 settings plain');
  const found = await waitWorktreeSession(ctx, who.tab);
  await waitPaneIdle(ctx, who.tab);
  await refreshWho(ctx, who);
  ctx.settings = who;
  const stages = (await stagesOf(ctx.page, who.tab, since)).map((item) => item.v);
  const wt = found?.info.worktree ?? {};
  const name = basename(wt.path ?? '');
  const panes = await ctx.page.locator(paneSel(who.tab)).count();
  record('FS-99 sending with the toggle on shows the stage line "Creating worktree…"',
    stages.includes(`worktree|${WT.creating}`), brief(stages));
  record('FS-99 the result keeps the same session id and the same tab; the session\'s cwd is the new worktree '
    + '<repo>\\.mori\\worktrees\\<name> on branch mori/<name> with the main folder as mainFolder', Boolean(found)
    && found.sessionId === before.sessionId && panes === 1 && WORKTREE_NAME.test(name)
    && samePath(wt.path, join(ctx.p.p1, '.mori', 'worktrees', name)) && wt.branch === `mori/${name}`
    && samePath(wt.mainFolder, ctx.p.p1) && samePath(found.info.cwd, wt.path) && hasBranch(ctx.p.p1, wt.branch),
  brief({ before, after: found?.sessionId, panes, wt, cwd: found?.info.cwd }));
  const entry = found ? worktreeEntryOf(found.sessionFile) : null;
  record('FS-99 the session file is in the --<encoded worktree>-- folder and holds one mori.worktree entry with the '
    + 'worktree\'s path, branch and main folder', Boolean(found) && sessionDirName(found.sessionFile)
    === projectDirName(wt.path) && same(entry, { path: wt.path, branch: wt.branch, mainFolder: wt.mainFolder })
    && readJsonl(found.sessionFile).filter((item) => item.customType === 'mori.worktree').length === 1,
  brief({ file: found?.sessionFile, entry }));
  await createdFacts(ctx, who);
}

/** @brief 消息照常发出、回复照常显示；发消息前选的五样都还在；开关不再出现；顶栏项目名是主文件夹名。 */
async function createdFacts(ctx, who) {
  const facts = await paneFacts(ctx, who.tab);
  const info = who.info ?? {};
  record('FS-99 the message goes out as usual and the model\'s reply shows (one user message, a reply, no error card)',
    facts.users.length === 1 && facts.assistants.length >= 1 && facts.errors.length === 0, brief(facts));
  const ui = await ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const at = (css) => pane?.querySelector(css);
    return { permission: at('[data-testid="permission-button"] .permission-text')?.textContent ?? null,
      pick: at('[data-testid="model-button"]')?.dataset.pick ?? null,
      level: at('[data-testid="thinking-button"]')?.dataset.level ?? null,
      team: at('[data-testid="team-switch"]')?.dataset.mode ?? null,
      project: at('.chat-project')?.textContent ?? null, projectTitle: at('.chat-project')?.getAttribute('title') };
  }, paneSel(who.tab));
  record('FS-99 Full access, the range, Effort, team mode and the session name chosen before sending are kept in the '
    + 'new session (SessionInfo and the message-box row)', info.approval?.mode === 'full' && info.pick === PICK_B
    && info.thinkingLevel === EFFORT && info.team?.mode === 'always' && info.name === SESSION_NAME
    && ui.permission === 'Full access' && ui.pick === PICK_B && ui.level === EFFORT && ui.team === 'always',
  brief({ approval: info.approval?.mode, pick: info.pick, level: info.thinkingLevel, team: info.team?.mode,
    name: info.name, ui }));
  record('FS-98 a session that owns a worktree shows neither the toggle nor Initialize git…',
    (await rowItemOf(ctx, who.tab)).kind === null, '');
  record('FS-101 the top bar\'s project name of a worktree session is the main folder\'s name, its hover the worktree '
    + 'path', ui.project === basename(ctx.p.p1) && samePath(ui.projectTitle, who.cwd), brief(ui));
}

/** @brief 等这个会话的阶段行是 Creating worktree…（kind worktree），最多 timeout；返回是否等到。 */
const waitCreating = (ctx, tab, since, timeout = 20000) => poll(async () => (await stagesOf(ctx.page, tab, since))
  .some((item) => item.v.startsWith('worktree|')), timeout, 50);

/** @brief 这个会话面板此刻的阶段行 kind（没有时 null）。 */
const stageKindNow = (ctx, tab) => ctx.page.evaluate((selector) => document.querySelector(selector)
  ?.querySelector('[data-testid="stage"]')?.dataset.kind ?? null, paneSel(tab));

/** @brief 建 worktree 中在侧栏改名：返回改名框里的错误原文（没有时 null），再按 Esc 关掉。 */
async function renameWhileCreating(ctx, tab) {
  await chooseRowItem(ctx, rowByTab(ctx, tab), 'Rename');
  const input = ctx.page.getByTestId('rename-input');
  await input.fill('fs99 renamed while creating');
  await input.press('Enter');
  const error = await ctx.page.getByTestId('rename-error').textContent({ timeout: 5000 }).catch(() => null);
  await input.press('Escape').catch(() => {});
  await input.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return error;
}

/** @brief 建 worktree 中（很多文件的仓库）改名、发消息都被拒绝：The worktree is still being created.。 */
async function busyCreate(ctx) {
  const who = await openMain(ctx, ctx.p.slow);
  await waitItem(ctx, who.tab, 'toggle');
  await setToggle(ctx, who.tab, true);
  const since = Date.now();
  await typeAndSend(ctx, who.tab, 'fs99 busy plain');
  const creating = await waitCreating(ctx, who.tab, since);
  const rename = await tryCommand(ctx, { type: 'session.rename', sessionId: who.sessionId, name: 'fs99 bridge name' });
  const prompt = await tryCommand(ctx, { type: 'session.prompt', sessionId: who.sessionId, text: 'fs99 second plain' });
  const ui = await renameWhileCreating(ctx, who.tab);
  const still = await stageKindNow(ctx, who.tab);
  const found = await waitWorktreeSession(ctx, who.tab, 90000);
  await waitPaneIdle(ctx, who.tab);
  record('FS-99 while the worktree is being created session.rename and session.prompt are refused with "The worktree '
    + 'is still being created." and renaming in the sidebar shows "Couldn’t rename this session: The worktree is still '
    + 'being created."; the worktree is created afterwards', Boolean(creating) && still === 'worktree'
    && String(rename.error).includes(WT.stillCreating) && String(prompt.error).includes(WT.stillCreating)
    && ui === `Couldn’t rename this session: ${WT.stillCreating}` && Boolean(found),
  brief({ creating, still, rename: rename.error, prompt: prompt.error, ui, worktree: found?.info.worktree?.path }));
}

/**
 * @brief 带一个工作路径里的文件引用发出：引用块显示成芯片、不露出原文；mori.ref 里的 path 在 worktree 里；发给模型的
 *        全文与同一个文件夹里不开 worktree 时相同。
 */
async function refChip(ctx) {
  const text = 'fs99 quote plain';
  const plain = await openMain(ctx, ctx.p.p1);
  await attachReadme(ctx, plain.tab, ctx.p.p1);
  const s1 = Date.now();
  await sendFs(ctx, plain, text);
  const base = chatBodies(ctx, s1, text)[0]?.lastUser ?? null;
  const who = await openMain(ctx, ctx.p.p1);
  await waitItem(ctx, who.tab, 'toggle');
  await setToggle(ctx, who.tab, true);
  await attachReadme(ctx, who.tab, ctx.p.p1);
  const s2 = Date.now();
  await typeAndSend(ctx, who.tab, text);
  const found = await waitWorktreeSession(ctx, who.tab);
  await waitPaneIdle(ctx, who.tab);
  await refreshWho(ctx, who);
  const facts = await paneFacts(ctx, who.tab);
  const sent = chatBodies(ctx, s2, text)[0]?.lastUser ?? null;
  const path = refEntriesOf(who.sessionFile)[0]?.refs?.[0]?.source?.path ?? null;
  record('FS-99 with a file reference the quote shows as a chip on the message (the quote block itself isn\'t shown)',
    Boolean(found) && facts.sentQuotes === 1 && facts.users.length === 1 && !facts.users[0].includes('Quoting'),
    brief(facts));
  record('FS-99 the mori.ref entry\'s path is the same file inside the worktree',
    samePath(path, join(who.cwd ?? '', 'README.md')) && underPath(path, who.worktree?.path), brief({ path,
      cwd: who.cwd }));
  record('FS-99 the full text sent to the model is the same as without a worktree (same quote, same words)',
    Boolean(base) && base.includes('Quoting README.md') && sent === base, brief({ base, sent }));
}

// ---------- FS-100：建 worktree 失败 ----------

/** @brief 让 git 步骤失败（.mori/worktrees 是一个文件）：消息撤回、文字与芯片回到输入框、错误卡、开关仍开、会话没动。 */
async function failure(ctx) {
  const repo = ctx.p.failing;
  const who = await openMain(ctx, repo);
  await waitItem(ctx, who.tab, 'toggle');
  await setToggle(ctx, who.tab, true);
  await attachReadme(ctx, who.tab, repo);
  const [branches, list] = [moriBranches(repo), worktreeList(repo)];
  const text = 'fs100 failing plain';
  const since = Date.now();
  await typeAndSend(ctx, who.tab, text);
  const errors = await poll(async () => {
    const facts = await paneFacts(ctx, who.tab);
    return facts.errors.some((line) => line.includes(WT.createFailed)) ? facts : null;
  }, 60000, 200);
  await waitPaneIdle(ctx, who.tab);
  const facts = await paneFacts(ctx, who.tab);
  const item = await rowItemOf(ctx, who.tab);
  const info = await infoOf(ctx, who.sessionFile);
  const event = (await kernelEvents(ctx, who.sessionId, 'mori.prompt_error', since)).at(-1)?.data ?? null;
  const reason = String(event?.message ?? '').slice(WT.createFailed.length);
  record('FS-100 when a git step fails the message is withdrawn, its text and chip go back to the message box, an '
    + 'error card says "Couldn’t create the worktree: <reason>", the toggle stays on and the session is still the idle '
    + 'one in the original folder', Boolean(errors) && facts.users.length === 0 && facts.draft === text
    && facts.chips === 1 && facts.errors.some((line) => line.startsWith(`${WT.createFailed}${reason}`))
    && reason.length > 0 && item.kind === 'toggle' && item.pressed === 'true' && samePath(info?.cwd, repo)
    && info?.worktree === null && !info?.live?.running, brief({ facts, item, cwd: info?.cwd, event }));
  record('FS-100 the failed attempt leaves no mori/ branch and no worktree registration behind',
    same(moriBranches(repo), branches) && same(worktreeList(repo), list), brief({ branches: moriBranches(repo) }));
  rmSync(join(repo, '.mori', 'worktrees'), { force: true });
  await ctx.page.locator(`${paneSel(who.tab)} .composer textarea`).press('Enter');
  const found = await waitWorktreeSession(ctx, who.tab);
  await waitPaneIdle(ctx, who.tab);
  record('FS-100 after fixing the cause, sending again (the text and chip are still there) creates the worktree',
    Boolean(found?.info.worktree) && samePath(found.info.cwd, found.info.worktree.path),
    brief(found?.info.worktree));
}

/**
 * @brief 重建之后准备中失败（没有可用模型）：先在另一个会话里让唯一的候选回一次 404（记为 not_found，不是静态校验，
 *        会话不会被拒绝启动），再在 tiny 里选它、打开开关发消息：会话已在 worktree 里，开关不再出现。
 */
async function noModel(ctx) {
  const scratch = await openMain(ctx, ctx.p.tiny);
  await choosePick(ctx, scratch.tab, NOT_FOUND_PICK);
  await sendFs(ctx, scratch, 'fs100 mark not found plain');
  const who = await openMain(ctx, ctx.p.tiny);
  await waitItem(ctx, who.tab, 'toggle');
  await choosePick(ctx, who.tab, NOT_FOUND_PICK);
  await setToggle(ctx, who.tab, true);
  const since = Date.now();
  await typeAndSend(ctx, who.tab, 'fs100 no model plain');
  ctx.unsaved = who;
  const found = await waitWorktreeSession(ctx, who.tab);
  const card = await poll(async () => ((await paneFacts(ctx, who.tab)).unavailable > 0 ? true : null), 60000, 300);
  await waitPaneIdle(ctx, who.tab);
  const item = await rowItemOf(ctx, who.tab);
  const facts = await paneFacts(ctx, who.tab);
  const asked = chatBodies(ctx, since, 'fs100 no model plain').length;
  record('FS-100 when preparing fails after the rebuild (no model available: the only candidate is not_found, no '
    + 'request is sent) the session is already in the worktree (SessionInfo.worktree, cwd) and the toggle no longer '
    + 'shows', Boolean(card) && asked === 0 && Boolean(found?.info.worktree)
    && samePath(found.info.cwd, found.info.worktree.path) && item.kind === null, brief({ card, asked, facts,
    worktree: found?.info.worktree, cwd: found?.info.cwd, item }));
}

// ---------- FS-110、FS-111：在 worktree 里再开、子文件夹 ----------

/** FS-110 第一个 worktree 会话的第一条消息：写一个文件并提交，再留一个没提交的文件（synthetic） */
const NESTED_FIRST = keywordSteps(gitStep.write('wt1.txt', 'one'), wtStep.commit('fs110 first'),
  gitStep.write('dirty.txt', 'dirty'), gitStep.say('Nested ready.'));

/** @brief worktree 会话里 Ctrl+N 的新会话有开关，打开后新 worktree 与原来的并列、从原 worktree 的 HEAD 切出。 */
async function nested(ctx) {
  const w1 = await createWorktree(ctx, ctx.p.p1, NESTED_FIRST);
  const head = git(w1.cwd, 'rev-parse', 'HEAD');
  await showTab(ctx, w1.tab);
  const n1 = await refreshWho(ctx, { tab: await newSession(ctx) });
  const item = await waitItem(ctx, n1.tab, 'toggle');
  record('FS-98 Ctrl+N in a worktree session opens a session in that worktree that shows the Worktree toggle',
    samePath(n1.cwd, w1.cwd) && item.kind === 'toggle', brief({ cwd: n1.cwd, item }));
  await setToggle(ctx, n1.tab, true);
  await typeAndSend(ctx, n1.tab, 'fs110 nested plain');
  const found = await waitWorktreeSession(ctx, n1.tab);
  await waitPaneIdle(ctx, n1.tab);
  await refreshWho(ctx, n1);
  ctx.nested = { w1, n1 };
  const w2 = n1.worktree ?? {};
  record('FS-110 the new worktree sits next to the first one under <repo>\\.mori\\worktrees (not nested), its branch '
    + 'starts at the first worktree\'s HEAD, and the first worktree\'s uncommitted file isn\'t in it', Boolean(found)
    && samePath(dirname(w2.path), dirname(w1.worktree.path)) && samePath(w2.mainFolder, ctx.p.p1)
    && branchTip(ctx.p.p1, w2.branch) === head && existsSync(join(w2.path, 'wt1.txt'))
    && !existsSync(join(w2.path, 'dirty.txt')) && existsSync(join(w1.cwd, 'dirty.txt')),
  brief({ w1: w1.worktree, w2, head, tip: branchTip(ctx.p.p1, w2.branch) }));
  const group = await groupOf(ctx, ctx.p.p1);
  const files = group?.rows.map((row) => row.file) ?? [];
  record('FS-110 both worktree sessions are in the main folder\'s group in the sidebar', [w1.sessionFile,
    n1.sessionFile].every((file) => files.some((row) => samePath(row, file))), brief({ files }));
}

/** @brief 在仓库的 app 子文件夹里开 worktree；app 只有未跟踪文件时失败、什么都不改。 */
async function subfolder(ctx) {
  const app = join(ctx.p.mono, 'app');
  const who = await createWorktree(ctx, app, 'fs111 sub plain', { full: false });
  const wt = who.worktree ?? {};
  const name = basename(wt.path ?? '');
  record('FS-111 a session opened in <repo>\\app gets its worktree at <repo>\\.mori\\worktrees\\<name>, works in '
    + '<worktree>\\app, and its main folder is <repo>\\app', samePath(wt.path, join(ctx.p.mono, '.mori', 'worktrees',
    name)) && samePath(who.cwd, join(wt.path, 'app')) && samePath(wt.mainFolder, app)
    && existsSync(join(who.cwd, 'README.md')), brief({ wt, cwd: who.cwd }));
  const group = await groupOf(ctx, app);
  const row = group?.rows.find((item) => samePath(item.file, who.sessionFile));
  record('FS-101 the worktree session of a subfolder session is in that subfolder\'s group (<repo>\\app) with its '
    + 'branch label', Boolean(row) && group.name === 'app' && (await branchLabel(ctx, who.sessionFile)) === wt.branch,
  brief({ group: group?.cwd, row }));
  const repo = ctx.p.mono2;
  const other = await openMain(ctx, join(repo, 'app'));
  await waitItem(ctx, other.tab, 'toggle');
  await setToggle(ctx, other.tab, true);
  const [branches, list] = [moriBranches(repo), worktreeList(repo)];
  await typeAndSend(ctx, other.tab, 'fs111 untracked plain');
  const facts = await poll(async () => {
    const now = await paneFacts(ctx, other.tab);
    return now.errors.length > 0 ? now : null;
  }, 60000, 200);
  record('FS-111 when <repo>\\app only has untracked files the worktree isn\'t created: "Couldn’t create the worktree: '
    + 'The folder app isn’t committed yet, so a worktree can’t start there. Commit it first." and the repository\'s '
    + 'worktree registrations and branches are unchanged',
  facts?.errors.includes(`${WT.createFailed}${notCommitted('app')}`) && same(moriBranches(repo), branches)
    && same(worktreeList(repo), list), brief({ errors: facts?.errors }));
}

// ---------- FS-102、FS-103：按主文件夹算项目、worktree 里读 pi 的配置 ----------

/** @brief 点 Open folder… 打开 folder，信任询问里点 Trust workspace（不勾 Remember my choice）。 */
async function openTrusting(ctx, folder) {
  const since = Date.now();
  await stubFolder(ctx.app, folder);
  await ctx.page.getByRole('button', { name: 'Open folder…', exact: true }).first().click();
  await answerTrustDialog(ctx.page, { answer: 'Trust workspace' });
  const tab = await ctx.page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]').first()
    .getAttribute('data-tab');
  return refreshWho(ctx, { tab, since });
}

/** @brief cfg 的主文件夹会话（回答过信任）与它 Ctrl+N 出的 worktree 会话（memory 工具写一条事实）。 */
async function projectSessions(ctx) {
  const main = await openTrusting(ctx, ctx.p.cfg);
  const s1 = Date.now();
  await sendFs(ctx, main, memoryCall('Main fact fs102'));
  await showTab(ctx, main.tab);
  const draft = await refreshWho(ctx, { tab: await newSession(ctx) });
  await waitItem(ctx, draft.tab, 'toggle');
  await setToggle(ctx, draft.tab, true);
  const s2 = Date.now();
  await typeAndSend(ctx, draft.tab, memoryCall('Worktree fact fs102'));
  if (!(await waitWorktreeSession(ctx, draft.tab))) throw new Error('no worktree session in cfg');
  await waitPaneIdle(ctx, draft.tab);
  await refreshWho(ctx, draft);
  ctx.cfg = { main, wt: draft, s1, s2 };
}

/** @brief memory 工具写进主文件夹的项目记忆；project.json 记主文件夹；mori.memory_changed 的 cwd 是主文件夹。 */
async function projectMemory(ctx) {
  const { main, wt, s2 } = ctx.cfg;
  const base = memBase(ctx.userData, ctx.p.cfg);
  const owner = JSON.parse(readFileSync(join(base, 'project.json'), 'utf8'));
  const result = toolResultsIn(wt.sessionFile).findLast((item) => item.tool === 'memory') ?? null;
  const changed = (await kernelEvents(ctx, null, 'mori.memory_changed', s2)).map((item) => item.data.cwd);
  record('FS-102 the memory tool in a worktree session writes the main folder\'s project memory (no "This project’s '
    + 'memory folder belongs to …"), project.json records the main folder and mori.memory_changed carries the main '
    + 'folder', result?.isError === false && result.text.startsWith('Saved to Facts (this project): Worktree fact')
    && existsSync(join(base, 'entries', 'worktree-fact-fs102.md')) && samePath(owner.cwd, ctx.p.cfg)
    && !existsSync(memBase(ctx.userData, wt.cwd)) && changed.length > 0 && changed.every((cwd) => samePath(cwd,
    ctx.p.cfg)), brief({ result, owner, changed }));
  const mainResult = toolResultsIn(main.sessionFile).findLast((item) => item.tool === 'memory') ?? null;
  record('FS-102 a session that isn\'t in a worktree works as before: the main folder session writes the same project '
    + 'memory folder', mainResult?.isError === false && existsSync(join(base, 'entries', 'main-fact-fs102.md')),
  brief(mainResult));
  await showTab(ctx, wt.tab);
  await openMemoryPage(ctx.page);
  const folder = await ctx.page.locator('[data-testid="memory-page"] .memory-folder').evaluate((el) => ({
    text: el.textContent, title: el.getAttribute('title') })).catch(() => null);
  const project = await ctx.page.getByTestId('memory-scope-project').isEnabled().catch(() => false);
  record('FS-102 the Memory page following a worktree session shows the main folder at the Project layer (its name, '
    + 'hovering its path)', project && folder?.text === basename(ctx.p.cfg) && samePath(folder.title, ctx.p.cfg),
  brief(folder));
  await leaveMemory(ctx.page);
}

/** @brief .mori/models.json 与 .mori/agents 从主文件夹读（worktree 里没有这两个）；Project access 只列主文件夹。 */
async function projectConfig(ctx) {
  const { main, wt, s1, s2 } = ctx.cfg;
  const models = [...chatBodies(ctx, s1, 'Main fact fs102'), ...chatBodies(ctx, s2, 'Worktree fact fs102')]
    .map((item) => item.model);
  const other = chatBodies(ctx, 0, 'fs98 first message plain').map((item) => item.model);
  record('FS-102 .mori/models.json is read from the main folder: the worktree (which has no such file) still narrows '
    + `group g to ${NARROWED}, like the main folder; other projects use fake-fs`, !existsSync(join(wt.cwd, '.mori'))
    && models.length >= 2 && models.every((model) => model === NARROWED) && other.length > 0
    && other.every((model) => model === 'fake-fs'), brief({ models, other }));
  const info = await infoOf(ctx, wt.sessionFile);
  record('FS-102 .mori/agents is read from the main folder: the worktree session has the split roles (planner holds '
    + 'create)', info?.team?.holders?.create === 'planner' && info.team.roles.some((role) => role.name === 'executor'),
  brief(info?.team?.holders));
  await showTab(ctx, main.tab);
  await openSettingsSection(ctx.page, 'models');
  await ctx.page.locator('[data-testid="project-row"]').first().waitFor({ timeout: 15000 });
  const rows = await ctx.page.locator('[data-testid="project-row"]').evaluateAll((items) => items
    .map((item) => item.dataset.path));
  record('FS-102 Project access lists the main folder once and no worktree, although the session list has worktree '
    + 'sessions', rows.filter((path) => samePath(path, ctx.p.cfg)).length === 1
    && rows.every((path) => !/[\\/]\.mori[\\/]worktrees[\\/]/i.test(path)), brief(rows));
  await leaveSettings(ctx);
}

/**
 * @brief 增强读主文件夹和它的 worktree 里的会话与反馈：反馈（synthetic，会话在 worktree 里）与 worktree 会话都在主文件夹
 *        那次增强的第一条消息里。
 */
async function projectEnhance(ctx) {
  const { main, wt } = ctx.cfg;
  seedFeedback(ctx.userData, { name: 'synthetic-fs102-worktree.json', createdAt: Date.now() - 60000, cwd: wt.cwd,
    sessionFile: wt.sessionFile, title: 'fs102 worktree', expected: 'fs102 worktree feedback', quote: 'Answer.',
    source: { kind: 'message', sessionFile: wt.sessionFile, entryId: null, time: null, scope: 'reply' } });
  const set = await tryCommand(ctx, { type: 'enhance.set', cwd: ctx.p.cfg, enabled: true, pick: 'fsp' });
  const since = Date.now();
  const run = await tryCommand(ctx, { type: 'enhance.run', cwd: ctx.p.cfg });
  await waitSettled(ctx, ctx.p.cfg, since, 3, 240000);
  const firsts = [...new Set(enhanceRequests(ctx.ep, { since }).map((item) => item.first))];
  const files = firsts.flatMap((first) => listedSessions(first).map((item) => basename(item.file)));
  const feedback = firsts.flatMap((first) => feedbackSection(first) ?? []);
  record('FS-102 the enhancement of the main folder reads the sessions of the main folder and of its worktree, and '
    + 'feedback given in the worktree', !set.error && !run.error && firsts.length > 0
    && files.includes(basename(wt.sessionFile)) && files.includes(basename(main.sessionFile))
    && feedback.some((line) => line.includes('fs102 worktree feedback')), brief({ set: set.error, run: run.error,
    files, feedback }));
}

/** @brief 在主文件夹回答过信任后，同一次运行里 worktree 里 Ctrl+N 的会话（worktree 有 .pi/）不再问。 */
async function projectTrust(ctx) {
  const since = Date.now();
  await showTab(ctx, ctx.cfg.wt.tab);
  const other = await refreshWho(ctx, { tab: await newSession(ctx) });
  const { dialogs } = await dialogsSince(ctx, since);
  record('FS-102 after answering trust for the main folder, a new session in its worktree (which has .pi/) in the same '
    + 'run isn\'t asked again and is trusted', samePath(other.cwd, ctx.cfg.wt.cwd)
    && existsSync(join(other.cwd, '.pi', 'settings.json')) && !dialogs.some((item) => item.testid === 'trust-dialog')
    && other.info?.projectTrust === 'trusted', brief({ cwd: other.cwd, dialogs, trust: other.info?.projectTrust }));
}

/** @brief FS-102 全部：建会话，再查记忆、配置、增强、信任。 */
async function project(ctx) {
  await projectSessions(ctx);
  await projectMemory(ctx);
  await projectConfig(ctx);
  await projectEnhance(ctx);
  await projectTrust(ctx);
}

/** @brief worktree 会话的 AGENTS.md 页列出 worktree 里的 AGENTS.md；主文件夹里没提交的 .pi/ 设置在 worktree 里不生效。 */
async function piConfig(ctx) {
  const { main, wt, s1, s2 } = ctx.cfg;
  await showTab(ctx, wt.tab);
  await openSettingsSection(ctx.page, 'agents');
  await ctx.page.getByTestId('agents-loaded').waitFor({ timeout: 15000 });
  const listed = await ctx.page.locator('[data-testid="agents-loaded"] .agents-files .agents-path').allTextContents();
  record('FS-103 the AGENTS.md page of a worktree session lists the worktree\'s AGENTS.md, not the main folder\'s',
    listed.some((path) => samePath(path, join(wt.cwd, 'AGENTS.md')))
    && !listed.some((path) => samePath(path, join(ctx.p.cfg, 'AGENTS.md'))), brief(listed));
  await leaveSettings(ctx);
  const mainTools = chatBodies(ctx, s1, 'Main fact fs102')[0]?.tools ?? [];
  const wtTools = chatBodies(ctx, s2, 'Worktree fact fs102')[0]?.tools ?? [];
  record('FS-103 the main folder\'s uncommitted .pi/settings.json (defaultTools +powershell) applies to the main '
    + 'folder session but not to the worktree session', samePath(main.cwd, ctx.p.cfg)
    && mainTools.includes('powershell') && wtTools.length > 0 && !wtTools.includes('powershell'),
  brief({ mainTools, wtTools }));
}

// ---------- FS-109：Initialize git ----------

/** @brief 输入框下一行的 Initialize git…：确认框的文字、路径、按钮与焦点，Tab 只在两个按钮之间；右栏的是同一个。 */
async function initDialog(ctx) {
  const a = await openMain(ctx, ctx.p.plain1);
  const b = await openMain(ctx, ctx.p.plain1);
  ctx.init = { a, b };
  await showTab(ctx, a.tab);
  await waitItem(ctx, a.tab, 'init-git');
  await ctx.page.locator(`${paneSel(a.tab)} [data-testid="init-git"]`).click();
  await ctx.page.getByTestId('init-git-dialog').waitFor({ timeout: 5000 });
  const shown = await initDialogOf(ctx);
  await ctx.page.keyboard.press('Tab');
  const first = (await initDialogOf(ctx))?.focus;
  await ctx.page.keyboard.press('Tab');
  const second = (await initDialogOf(ctx))?.focus;
  record('FS-109 the confirm dialog: "Initialize git in “plain1”?", the explanation, the full path, buttons Initialize '
    + 'git and Cancel with the focus on Cancel; Tab moves only between the two buttons', shown?.title
    === 'Initialize git in “plain1”?' && shown.text === WT.initText && samePath(shown.path, ctx.p.plain1)
    && same(shown.buttons, ['Initialize git', 'Cancel']) && shown.focus === 'Cancel' && first === 'Initialize git'
    && second === 'Cancel', brief({ shown, first, second }));
  await cancelInit(ctx);
  await setPanel(ctx, a.tab, true);
  await ctx.page.locator('[data-testid="right-panel"] [data-testid="changes-init-git"]').click();
  await ctx.page.getByTestId('init-git-dialog').waitFor({ timeout: 5000 });
  const again = await initDialogOf(ctx);
  record('FS-109 Initialize git… under "Not a git repository" in the right panel opens the same confirm dialog',
    same(again, { ...shown, focus: 'Cancel' }), brief(again));
  await cancelInit(ctx);
}

/** @brief 从右栏打开确认框并点 Initialize git；返回 confirmInit 的结果。 */
async function initFromPanel(ctx, tab) {
  await setPanel(ctx, tab, true);
  await ctx.page.locator('[data-testid="right-panel"] [data-testid="changes-init-git"]').click();
  await ctx.page.getByTestId('init-git-dialog').waitFor({ timeout: 5000 });
  return confirmInit(ctx);
}

/** @brief 运行中拒绝（This session is still running. Stop it first.），什么都没做。 */
async function initRunning(ctx) {
  const { a } = ctx.init;
  await setPermission(ctx, a.tab, 'full');
  ctx.init.before = await sendTurn(ctx, a, gitStep.write('before.txt', 'before init'), ['before.txt']);
  await sendFs(ctx, a, 'fs109 hold wait 8s', { wait: false });
  await poll(() => ctx.page.evaluate((selector) => document.querySelector(selector)?.dataset.running === 'true',
    paneSel(a.tab)), 10000, 100);
  const outcome = await initFromPanel(ctx, a.tab);
  record('FS-109 while the session is running Initialize git is refused: "Couldn’t initialize git: This session is '
    + 'still running. Stop it first." and nothing is done', outcome === `${WT.initFailed}${WT.running}`
    && !existsSync(join(ctx.p.plain1, '.git')), brief({ outcome }));
  await cancelInit(ctx);
  await waitPaneIdle(ctx, a.tab);
}

/**
 * @brief 确认后：仓库建好，第一次提交按 .gitignore、不含 .work/；同一文件夹里另一个开着的会话随即有 git 状态与开关；
 *        已经是仓库时拒绝；操作记录有 Initialize git。
 */
async function initSuccess(ctx) {
  const { a, b } = ctx.init;
  const since = Date.now();
  const outcome = await initFromPanel(ctx, a.tab);
  const repo = ctx.p.plain1;
  const files = outcome === 'closed' ? treeFiles(repo, 'HEAD') : [];
  const message = outcome === 'closed' ? git(repo, 'log', '-1', '--format=%s') : null;
  record('FS-109 after confirming the folder is a repository with one commit "Initial commit" made by .gitignore: '
    + 'README.md, .gitignore and node_modules/x.js are in it, ignored.txt and .work/ are not', outcome === 'closed'
    && message === 'Initial commit' && ['README.md', '.gitignore', 'node_modules/x.js', 'before.txt']
    .every((file) => files.includes(file)) && !files.includes('ignored.txt')
    && !files.some((file) => file.startsWith('.work/')), brief({ outcome, message, files }));
  const item = await waitItem(ctx, b.tab, 'toggle', 15000).catch(() => null);
  const status = await poll(async () => (await kernelEvents(ctx, b.sessionId, 'mori.workspace_status', since))
    .map((event) => event.data.status).find((value) => value?.repo?.hasCommit) ?? null, 15000, 200);
  record('FS-109 another open session in the same folder (not shown) switches to the git status and the Worktree '
    + 'toggle right away', item?.kind === 'toggle' && status?.repo?.hasCommit === true, brief({ item,
    repo: status?.repo }));
  const again = await tryCommand(ctx, { type: 'workspace.initGit', sessionId: b.sessionId });
  record('FS-109 Initialize git in a folder that is already a repository is refused: "This folder is already a git '
    + 'repository."', String(again.error).includes(WT.alreadyRepo), brief(again));
  const actions = await recentActivity(ctx, a.tab, 'fs109 init');
  record('FS-109 the activity log has "Initialize git"', actions.includes('Initialize git'), brief(actions));
  await initSnapshots(ctx);
}

/** @brief 之后的快照不再有被 .gitignore 忽略的文件，没写进 .gitignore 的 node_modules 进快照（之前不进）。 */
async function initSnapshots(ctx) {
  const { a, before } = ctx.init;
  const after = await sendTurn(ctx, a, gitStep.write('after.txt', 'after init'), ['after.txt']);
  const ends = [before, after].map((turn) => turn.runs.at(-1)?.record.end ?? null);
  const has = (oid, path) => Boolean(oid) && fileInCommit(ctx, a.cwd, oid, path);
  record('FS-109 snapshots after Initialize git follow the repository: node_modules/x.js (not in .gitignore) is in '
    + 'the next snapshot although it wasn\'t before, and ignored.txt is not', ends.every(Boolean)
    && !has(ends[0], 'node_modules/x.js') && has(ends[1], 'node_modules/x.js') && !has(ends[1], 'ignored.txt')
    && has(ends[1], 'after.txt'), brief({ ends }));
}

/**
 * @brief 测试 HOME 的 .gitconfig 去掉 user：什么都没做、显示原因；再加一个总是失败的 pre-commit：.git 被删、显示原因、
 *        仍是 Initialize git…；去掉 hook 后再点成功，输入框下一行换成 Worktree 开关。
 */
async function initFailures(ctx) {
  const repo = ctx.p.plain2;
  const c = await openMain(ctx, repo);
  await waitItem(ctx, c.tab, 'init-git');
  writeHomeConfig(ctx.home, { identity: false });
  await ctx.page.locator(`${paneSel(c.tab)} [data-testid="init-git"]`).click();
  await ctx.page.getByTestId('init-git-dialog').waitFor({ timeout: 5000 });
  const identity = await confirmInit(ctx);
  record('FS-109 without user.name and user.email nothing is done and the dialog says "Couldn’t initialize git: Git '
    + 'needs your name and email for the first commit. …"', identity === `${WT.initFailed}${WT.identity}`
    && !existsSync(join(repo, '.git')), brief({ identity }));
  const hooks = failingHooks(ROOT);
  writeHomeConfig(ctx.home, { hooks });
  const hooked = await confirmInit(ctx);
  const row = await rowItemOf(ctx, c.tab);
  record('FS-109 when the first commit fails (a global core.hooksPath with a pre-commit that always fails) .git is '
    + 'removed, the dialog says "Couldn’t initialize git: <reason>" and the row still shows Initialize git…',
  hooked.startsWith(WT.initFailed) && hooked.length > WT.initFailed.length && !existsSync(join(repo, '.git'))
    && row.kind === 'init-git', brief({ hooked, row }));
  rmSync(join(hooks, 'pre-commit'), { force: true });
  const retried = await confirmInit(ctx);
  writeHomeConfig(ctx.home);
  const item = await waitItem(ctx, c.tab, 'toggle', 15000).catch(() => null);
  record('FS-109 after removing the hook, clicking Initialize git again succeeds and the row switches to the Worktree '
    + 'toggle', retried === 'closed' && gitRun(repo, ['rev-parse', 'HEAD']).code === 0 && item?.kind === 'toggle',
  brief({ retried, item }));
}

/** @brief 空文件夹 Initialize git 之后也有一个提交（--allow-empty）。 */
async function initEmpty(ctx) {
  const who = await openMain(ctx, ctx.p.empty);
  await waitItem(ctx, who.tab, 'init-git');
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="init-git"]`).click();
  await ctx.page.getByTestId('init-git-dialog').waitFor({ timeout: 5000 });
  const outcome = await confirmInit(ctx);
  const count = outcome === 'closed' ? git(ctx.p.empty, 'rev-list', '--count', 'HEAD') : null;
  const files = outcome === 'closed' ? treeFiles(ctx.p.empty, 'HEAD') : null;
  record('FS-109 Initialize git in an empty folder still makes one commit (with nothing in it but what .gitignore '
    + 'allows: no .work/)', outcome === 'closed' && count === '1' && Array.isArray(files)
    && !files.some((file) => file.startsWith('.work/')), brief({ outcome, count, files }));
}

// ---------- FS-104：归档 ----------

/** @brief 等渲染进程记下这个 worktree 的清理结果，返回那一行（没有时 null）。 */
async function archiveAndWait(ctx, who) {
  const since = Date.now();
  await archiveRow(ctx, who.sessionFile);
  return cleanUpLine(ctx, who.worktree.path, since);
}

/** @brief 干净的（连同 .work 里的草稿）删掉、分支在；有改动的留着；被别的开着的会话用着的留着；都不弹确认。 */
async function archiving(ctx) {
  const clean = await createWorktree(ctx, ctx.p.p1, 'fs104 clean plain');
  await sendFs(ctx, clean, gitStep.write('.work/draft.md', 'fs104 draft'));
  const draft = existsSync(join(clean.cwd, '.work', 'draft.md'));
  const dirty = await createWorktree(ctx, ctx.p.p1, gitStep.write('notes.txt', 'fs104 dirty'));
  const owner = await createWorktree(ctx, ctx.p.p1, 'fs104 owner plain');
  await showTab(ctx, owner.tab);
  const other = await refreshWho(ctx, { tab: await newSession(ctx) });
  ctx.arc = { clean, dirty, owner, other };
  const since = Date.now();
  const lines = { clean: await archiveAndWait(ctx, clean), dirty: await archiveAndWait(ctx, dirty),
    owner: await archiveAndWait(ctx, owner) };
  const { dialogs } = await dialogsSince(ctx, since);
  record('FS-104 archiving a clean worktree session deletes the worktree with the draft in .work/; the branch is kept',
    draft && String(lines.clean).includes('removed') && !existsSync(clean.worktree.path)
    && hasBranch(ctx.p.p1, clean.worktree.branch), brief({ draft, line: lines.clean }));
  record('FS-104 a worktree with uncommitted files is kept when its session is archived', String(lines.dirty)
    .includes('kept (changes)') && existsSync(join(dirty.worktree.path, 'notes.txt')), brief(lines.dirty));
  record('FS-104 a worktree another open session uses is kept when its owner is archived', samePath(other.cwd,
    owner.cwd) && String(lines.owner).includes('kept (in_use)') && existsSync(owner.worktree.path), brief({
    line: lines.owner, other: other.cwd }));
  record('FS-104 archiving shows no confirm dialog in any of these cases', dialogs.length === 0, brief(dialogs));
}

// ---------- FS-105：打开 worktree 不在的会话 ----------

/** @brief 打开之后：worktree 在、是分支的最新提交、会话照常（没有横幅），能继续对话。 */
async function restoredOk(ctx, who, tab) {
  const head = existsSync(who.worktree.path) ? gitRun(who.worktree.path, ['rev-parse', 'HEAD']).stdout.trim() : '';
  const facts = await paneFacts(ctx, tab);
  const before = facts.assistants.length;
  await sendFs(ctx, { tab }, 'fs105 continue plain');
  const after = (await paneFacts(ctx, tab)).assistants.length;
  return { ok: head !== '' && head === branchTip(ctx.p.p1, who.worktree.branch) && facts.banner === null
    && after > before, head, banner: facts.banner, before, after };
}

/** @brief 归档时被删掉的 worktree：恢复并打开时从分支重新检出；手工删掉文件夹（登记还在）后打开也一样。 */
async function reopenRestore(ctx) {
  const { clean } = ctx.arc;
  const tab = await openArchived(ctx, clean.sessionFile);
  const first = await restoredOk(ctx, clean, tab);
  record('FS-105 opening an archived session whose clean worktree was deleted checks it out again from the branch; '
    + 'the session opens as usual and the conversation can go on', first.ok, brief(first));
  const gone = await createWorktree(ctx, ctx.p.p1, gitStep.write('gone.txt', 'fs105 gone'));
  await archiveAndWait(ctx, gone);
  rmSync(gone.worktree.path, { recursive: true, force: true });
  const second = await restoredOk(ctx, gone, await openArchived(ctx, gone.sessionFile));
  record('FS-105 after deleting the worktree folder by hand (git still has its registration) opening the session '
    + 'checks it out again the same way', second.ok, brief(second));
}

/** @brief 分支被删后打开：Failed to open session: The branch … no longer exists…，会话行 Error，Delete… 可用。 */
async function reopenBranchGone(ctx) {
  const who = await createWorktree(ctx, ctx.p.p1, 'fs105 branch plain');
  await archiveAndWait(ctx, who);
  git(ctx.p.p1, 'branch', '-D', who.worktree.branch);
  const tab = await openArchived(ctx, who.sessionFile);
  const facts = await poll(async () => {
    const now = await paneFacts(ctx, tab);
    return now.banner ? now : null;
  }, 30000, 200);
  const status = await rowStatusOf(ctx, who.sessionFile);
  const deletable = await rowItemEnabled(ctx, rowByFile(ctx, who.sessionFile), 'Delete…');
  record('FS-105 when the branch is gone opening fails with "Failed to open session: The branch <branch> no longer '
    + 'exists, so this session’s worktree can’t be restored.", the row shows Error and Delete… is available',
  facts?.banner === `${WT.openFailed}${branchGone(who.worktree.branch)}` && status === 'error' && deletable,
  brief({ banner: facts?.banner, status, deletable }));
}

/** @brief 登记目录里写了 locked、文件夹删掉之后打开能恢复。 */
async function reopenLocked(ctx) {
  const who = await createWorktree(ctx, ctx.p.p1, gitStep.write('locked.txt', 'fs105 locked'));
  await archiveAndWait(ctx, who);
  writeFileSync(join(adminDir(ctx.p.p1, who.worktree.path), 'locked'), 'initializing\n');
  rmSync(who.worktree.path, { recursive: true, force: true });
  const result = await restoredOk(ctx, who, await openArchived(ctx, who.sessionFile));
  record('FS-105 with a locked registration left in .git/worktrees/<name>/ and the folder deleted, opening the '
    + 'session restores the worktree', result.ok && !existsSync(join(adminDir(ctx.p.p1, who.worktree.path), 'locked')),
  brief(result));
}

/** @brief worktree 里有目录联接（被忽略的 node_modules）：归档清掉后文件夹不在、联接指向的内容不变，再打开能检出。 */
async function reopenJunction(ctx) {
  const who = await createWorktree(ctx, ctx.p.p1, 'fs105 junction plain');
  const target = join(ROOT, 'jtarget');
  writeFiles(target, { 'keep.txt': 'kept by the junction test\n' });
  symlinkSync(target, join(who.worktree.path, 'node_modules'), 'junction');
  const line = await archiveAndWait(ctx, who);
  const cleaned = !existsSync(who.worktree.path);
  const kept = readFileSync(join(target, 'keep.txt'), 'utf8') === 'kept by the junction test\n';
  const result = await restoredOk(ctx, who, await openArchived(ctx, who.sessionFile));
  record('FS-105 a worktree with a directory junction (an ignored node_modules) is cleaned up on archiving: the folder '
    + 'is gone, the junction\'s target keeps its content, and opening the session checks it out again',
  String(line).includes('removed') && cleaned && kept && result.ok, brief({ line, cleaned, kept, result }));
}

/** @brief 文件夹在而登记没有：Failed to open session: The worktree folder … isn’t registered with git…，文件夹没被删。 */
async function reopenUnregistered(ctx) {
  const who = await createWorktree(ctx, ctx.p.p1, gitStep.write('unreg.txt', 'fs105 unregistered'));
  await archiveAndWait(ctx, who);
  git(ctx.p.p1, 'worktree', 'remove', '--force', who.worktree.path);
  writeFiles(who.worktree.path, { 'put-back.txt': 'synthetic: the folder is back\n' });
  const tab = await openArchived(ctx, who.sessionFile);
  const facts = await poll(async () => {
    const now = await paneFacts(ctx, tab);
    return now.banner ? now : null;
  }, 30000, 200);
  record('FS-105 a worktree folder that exists but isn\'t registered with git fails to open with "Failed to open '
    + 'session: The worktree folder <path> exists but isn’t registered with git. …" and the folder isn\'t deleted',
  facts?.banner === `${WT.openFailed}${unregistered(who.worktree.path)}`
    && existsSync(join(who.worktree.path, 'put-back.txt')), brief({ banner: facts?.banner }));
}

/** @brief 打开这个已归档的会话，等到失败的横幅；返回横幅的文字（没有时 null）。 */
async function failedBanner(ctx, file) {
  const tab = await openArchived(ctx, file);
  const facts = await poll(async () => {
    const now = await paneFacts(ctx, tab);
    return now.banner ? now : null;
  }, 30000, 200);
  return facts?.banner ?? null;
}

/** @brief worktree 根还在、cwd 那个子文件夹不在：Failed to open session: Project folder not found: <cwd>，不检出。 */
async function reopenSubGone(ctx) {
  const who = await createWorktree(ctx, join(ctx.p.mono, 'app'), gitStep.write('sub.txt', 'fs105 sub'));
  await archiveAndWait(ctx, who);
  rmSync(who.cwd, { recursive: true, force: true });
  const banner = await failedBanner(ctx, who.sessionFile);
  record('FS-105 when the worktree root is there but the session’s subfolder in it is gone, opening fails with '
    + '"Failed to open session: Project folder not found: <cwd>" and nothing is checked out',
  banner === `${WT.openFailed}Project folder not found: ${who.cwd}` && !existsSync(who.cwd), brief({ banner }));
}

/** @brief 仓库根不在了：Failed to open session: Project folder not found: <R>。 */
async function reopenRootGone(ctx) {
  const who = await createWorktree(ctx, ctx.p.rootgone, 'fs105 root plain');
  await archiveAndWait(ctx, who);
  renameSync(ctx.p.rootgone, `${ctx.p.rootgone}-moved`);
  const banner = await failedBanner(ctx, who.sessionFile);
  record('FS-105 when the repository root is gone, opening fails with "Failed to open session: Project folder not '
    + 'found: <repository root>"', banner === `${WT.openFailed}Project folder not found: ${ctx.p.rootgone}`,
  brief({ banner }));
}

/** @brief 分支正在别的 worktree 里检出：Failed to open session: 加 git 的原文。 */
async function reopenBranchBusy(ctx) {
  const who = await createWorktree(ctx, ctx.p.p1, 'fs105 busy branch plain');
  await archiveAndWait(ctx, who);
  const elsewhere = join(ROOT, 'elsewhere');
  git(ctx.p.p1, 'worktree', 'add', elsewhere, who.worktree.branch);
  const banner = await failedBanner(ctx, who.sessionFile);
  git(ctx.p.p1, 'worktree', 'remove', '--force', elsewhere);
  record('FS-105 when the branch is checked out in another worktree, opening fails with "Failed to open session: '
    + '<git’s message>" naming the branch', String(banner).startsWith(WT.openFailed)
    && String(banner).includes(who.worktree.branch) && !existsSync(who.worktree.path), brief({ banner }));
}

/** @brief FS-105 全部。 */
async function reopen(ctx) {
  await reopenRestore(ctx);
  await reopenBranchGone(ctx);
  await reopenLocked(ctx);
  await reopenJunction(ctx);
  await reopenUnregistered(ctx);
  await reopenSubGone(ctx);
  await reopenRootGone(ctx);
  await reopenBranchBusy(ctx);
}

// ---------- FS-106：删除 ----------

/** @brief 打开删除确认框，看刚出现时（读 worktree 中）与读完后的样子。 */
async function deleteView(ctx, file) {
  const since = Date.now();
  const state = await openDelete(ctx, rowByFile(ctx, file));
  const first = (await dialogsSince(ctx, since)).deletes[0] ?? null;
  return { first, state };
}

/** @brief 干净、有改动的两种：写法、Delete 的可用，确认后 worktree 删掉、分支在、会话文件删掉。 */
async function deleteOwned(ctx) {
  const clean = await createWorktree(ctx, ctx.p.p1, 'fs106 clean plain');
  const dirty = await createWorktree(ctx, ctx.p.p1, gitStep.write('d.txt', 'fs106 dirty'));
  for (const [who, kind] of [[clean, 'clean'], [dirty, 'changes']]) {
    const name = basename(who.worktree.path);
    const { first, state } = await deleteView(ctx, who.sessionFile);
    const outcome = await confirmDelete(ctx);
    record(`FS-106 (${kind}) the delete dialog first says "Checking its worktree…" with Delete disabled, then the `
      + `${kind} sentence from the screen table with Delete available; confirming deletes the worktree, keeps the `
      + 'branch and deletes the session file', first?.checking === true && first.blocked === true && state.kind === kind
      && state.note === deleteNote[kind](name, who.worktree.branch) && !state.blocked && outcome === 'closed'
      && !existsSync(who.worktree.path) && hasBranch(ctx.p.p1, who.worktree.branch) && !existsSync(who.sessionFile),
    brief({ first, state, outcome }));
  }
}

/** @brief 读不出有没有改动（worktree 的 index 坏了）：“读不出”那一句，Delete 可用。 */
async function deleteUnknown(ctx) {
  const who = await createWorktree(ctx, ctx.p.p1, 'fs106 unknown plain');
  writeFileSync(join(adminDir(ctx.p.p1, who.worktree.path), 'index'), 'synthetic: not an index\n');
  const { state } = await deleteView(ctx, who.sessionFile);
  record('FS-106 (unknown) when its changes can\'t be read the dialog has the "with any uncommitted changes in it" '
    + 'sentence and Delete is available', state.kind === 'unknown' && !state.blocked
    && state.note === deleteNote.unknown(basename(who.worktree.path), who.worktree.branch), brief(state));
  await cancelDelete(ctx);
}

/**
 * @brief 被别的开着的会话用着：那一句，确认后只删会话、worktree 留着；那个没有拥有 worktree 的会话删除时同现在
 *        （不加句子），worktree 仍在。
 */
async function deleteInUse(ctx) {
  const owner = await createWorktree(ctx, ctx.p.p1, 'fs106 owner plain');
  await showTab(ctx, owner.tab);
  const other = await refreshWho(ctx, { tab: await newSession(ctx) });
  await sendFs(ctx, other, 'fs106 other plain');
  await refreshWho(ctx, other);
  const { state } = await deleteView(ctx, owner.sessionFile);
  const outcome = await confirmDelete(ctx);
  record('FS-106 (in use) the dialog says the worktree is kept because another open session uses it; confirming '
    + 'deletes only the session file', state.kind === 'in-use' && state.note === deleteNote['in-use'](basename(
    owner.worktree.path)) && outcome === 'closed' && !existsSync(owner.sessionFile) && existsSync(owner.worktree.path),
  brief({ state, outcome }));
  const plain = await deleteView(ctx, other.sessionFile);
  const done = await confirmDelete(ctx);
  record('FS-106 a session in a worktree it doesn\'t own is deleted as before: no worktree sentence, the worktree '
    + 'stays', plain.state.note === null && plain.state.kind === null && done === 'closed'
    && !existsSync(other.sessionFile) && existsSync(owner.worktree.path), brief({ state: plain.state, done }));
}

/** @brief 删 worktree 失败（里面一个文件被占着）：会话文件还在，确认框显示原文。 */
async function deleteFails(ctx) {
  const who = await createWorktree(ctx, ctx.p.p1, 'fs106 held plain');
  const release = holdFile(join(who.worktree.path, 'README.md'));
  let outcome = null;
  try {
    await deleteView(ctx, who.sessionFile);
    outcome = await confirmDelete(ctx);
  } finally {
    release();
  }
  record('FS-106 when deleting the worktree fails (a file in it is held open) the session file is still there and '
    + 'the dialog shows "Couldn’t delete this session: <reason>"', String(outcome).startsWith('Couldn’t delete this '
    + 'session: ') && String(outcome).length > 'Couldn’t delete this session: '.length && existsSync(who.sessionFile),
  brief({ outcome }));
  if (await deleteDialogOf(ctx)) await cancelDelete(ctx);
}

/**
 * @brief 还没保存的 worktree 会话（FS-100 重建之后没能发出消息的那一个）：说明是 This session has no messages yet.，
 *        后面同样加干净的那一句；确认后 worktree 删掉、分支在。
 */
async function deleteUnsaved(ctx) {
  const who = await refreshWho(ctx, ctx.unsaved);
  const name = basename(who.worktree.path);
  const state = await openDelete(ctx, rowByTab(ctx, who.tab));
  const outcome = await confirmDelete(ctx);
  record('FS-106 an unsaved worktree session (its first message never got into the session) is deleted with "This '
    + 'session has no messages yet." followed by the worktree sentence; confirming deletes the worktree and keeps '
    + 'the branch', state.text === WT.noMessages && state.kind === 'clean'
    && state.note === deleteNote.clean(name, who.worktree.branch) && outcome === 'closed'
    && !existsSync(who.worktree.path) && hasBranch(ctx.p.tiny, who.worktree.branch), brief({ state, outcome }));
}

/** @brief FS-106 全部（有 git 的部分）。 */
async function deleting(ctx) {
  await deleteUnsaved(ctx);
  await deleteOwned(ctx);
  await deleteUnknown(ctx);
  await deleteInUse(ctx);
  await deleteFails(ctx);
}

// ---------- FS-107：设置页 Clean up worktrees ----------

/** @brief 已归档、拥有的 worktree 还在的会话：{ file, path }。 */
async function leftWorktrees(ctx) {
  return (await archivedFiles(ctx)).map((file) => ({ file, path: worktreeEntryOf(file)?.path ?? null }))
    .filter((item) => item.path && existsSync(item.path));
}

/**
 * @brief 列出已归档会话留下、还在的 worktree 与有没有改动、在用；确认后可删的全部删掉（有改动的也删），分支和会话还在；
 *        在用的不删；操作记录有 Clean up worktrees。
 */
async function storage(ctx) {
  const { dirty, owner } = ctx.arc;
  const expected = await leftWorktrees(ctx);
  await openStorage(ctx);
  const view = await storageOf(ctx);
  const mark = (path) => view?.items.find((item) => samePath(item.path, path)) ?? null;
  record('FS-107 Storage lists exactly the worktrees left from archived sessions that still exist, each with '
    + 'Uncommitted changes / In use by an open session', view?.items.length === expected.length
    && expected.every((item) => mark(item.path)) && mark(dirty.worktree.path)?.markText === WT.changes
    && mark(owner.worktree.path)?.markText === WT.inUse && view.button?.disabled === false, brief({ view, expected }));
  const shown = await cleanUpStorage(ctx);
  const after = await storageOf(ctx);
  record('FS-107 the confirm dialog: "Clean up 1 worktree?" (in-use ones not counted), the explanation, the focus on '
    + 'Cancel', shown.title === 'Clean up 1 worktree?' && shown.text === WT.cleanUpText && shown.focus === 'Cancel',
  brief(shown));
  record('FS-107 after confirming the worktree with uncommitted changes is deleted; branches and sessions are kept; '
    + 'the one used by an open session is kept and still marked In use by an open session',
  !existsSync(dirty.worktree.path)
    && hasBranch(ctx.p.p1, dirty.worktree.branch) && existsSync(dirty.sessionFile) && existsSync(owner.worktree.path)
    && after?.items.length === 1 && samePath(after.items[0].path, owner.worktree.path)
    && after.items[0].markText === WT.inUse, brief(after));
  record('FS-107 when every listed worktree is in use, Clean up worktrees… is disabled', after?.items.length === 1
    && after.items.every((item) => item.mark === 'in-use') && after.button?.disabled === true, brief(after?.button));
  await leaveSettings(ctx);
  const actions = await recentActivity(ctx, ctx.arc.other.tab, 'fs107 cleanup');
  record('FS-107 the activity log has "Clean up worktrees"', actions.includes('Clean up worktrees'), brief(actions));
}

// ---------- 重新启动：FS-101、FS-112 ----------

/** @brief 重启之前准备 FS-112 的两个：归档时留下的有改动的 worktree，和一个之后手工删掉文件夹的 worktree 会话。 */
async function prepareRestart(ctx) {
  const kept = await createWorktree(ctx, ctx.p.p1, gitStep.write('kept.txt', 'fs112 kept'));
  const line = await archiveAndWait(ctx, kept);
  if (!String(line).includes('kept (changes)')) throw new Error(`fs112 worktree was not kept: ${line}`);
  const gone = await createWorktree(ctx, ctx.p.p1, 'fs112 gone plain');
  ctx.restart = { kept, gone };
  await showTab(ctx, ctx.settings.tab);
  await closeFsApp(ctx);
  ctx.projectTabs = {};
  // App 关着时手工删掉这个 worktree 的文件夹（登记还在，§11.9.4 第 1 种）
  rmSync(gone.worktree.path, { recursive: true, force: true });
  await startWt(ctx);
}

/** @brief 重启后还没打开：worktree 会话在主文件夹那一组、有分支标签；已归档行的悬停。 */
async function sidebarAfterRestart(ctx) {
  const { settings } = ctx;
  const { kept } = ctx.restart;
  await ctx.page.waitForFunction(() => document.querySelectorAll('.session-item').length > 0, null, { timeout: 20000 });
  const group = await groupOf(ctx, ctx.p.p1);
  const row = group?.rows.find((item) => samePath(item.file, settings.sessionFile)) ?? null;
  record('FS-101 after a restart, before it is opened, a worktree session is in the main folder\'s group (named after '
    + 'the main folder) with its branch label', Boolean(row) && group.name === basename(ctx.p.p1)
    && (await branchLabel(ctx, settings.sessionFile)) === settings.worktree.branch, brief({ group: group?.cwd, row }));
  const toggle = ctx.page.getByTestId('archived-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const archived = (await archivedState(ctx.page)).rows.find((item) => samePath(item.file, kept.sessionFile));
  const want = `${basename(ctx.p.p1)} · write file: kept.txt :: fs112 kept · ${kept.worktree.branch}`;
  record('FS-101 an archived worktree session\'s row hover is "<main folder> · <session name> · <branch>"',
    archived?.tip === want, brief({ tip: archived?.tip, want }));
  await toggle.click();
}

/** @brief 重启后打开、切换别的会话，跑完一轮，窗口切走再切回。 */
async function everydayUse(ctx) {
  await reopenSession(ctx, ctx.settings.sessionFile);
  const other = await openMain(ctx, ctx.p.p1);
  await sendFs(ctx, other, 'fs112 everyday plain');
  await reopenSession(ctx, ctx.settings.sessionFile);
  await showTab(ctx, other.tab);
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.emit('blur');
    win?.emit('focus');
  });
  await ctx.page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  await sleep(3000);
}

/**
 * @brief 不在后台清理：重启、打开切换、跑一轮、窗口切换之后，留下的 worktree 还在，被删文件夹的仍在登记里（prunable）；
 *        打开那个会话才检出，进设置页点 Clean up 才删前者。
 */
async function restart(ctx) {
  await prepareRestart(ctx);
  await sidebarAfterRestart(ctx);
  await everydayUse(ctx);
  const { kept, gone } = ctx.restart;
  const listed = worktreeList(ctx.p.p1).find((item) => samePath(item.path, gone.worktree.path)) ?? null;
  record('FS-112 after a restart, opening and switching sessions, a turn and the window losing and regaining focus, '
    + 'the archived worktree with changes is still there and the deleted one is still registered (prunable, not '
    + 'pruned)', existsSync(join(kept.worktree.path, 'kept.txt')) && listed?.prunable === true
    && !existsSync(gone.worktree.path), brief({ listed }));
  await reopenSession(ctx, gone.sessionFile);
  record('FS-112 opening that session is what checks its worktree out again', existsSync(gone.worktree.path)
    && worktreeList(ctx.p.p1).some((item) => samePath(item.path, gone.worktree.path) && !item.prunable), '');
  await openStorage(ctx);
  const listedKept = (await storageOf(ctx))?.items.some((item) => samePath(item.path, kept.worktree.path));
  await cleanUpStorage(ctx);
  record('FS-112 the archived worktree is deleted only when Clean up is clicked in Settings', Boolean(listedKept)
    && !existsSync(kept.worktree.path), brief({ listedKept }));
  await leaveSettings(ctx);
}

// ---------- 没装 git：FS-98、FS-106、FS-107 ----------

/** @brief 另起一次 App（MORI_GIT_PATH 指向不存在的 git.exe）：没有开关与 Initialize git…；删除只删会话；Storage 一行说明。 */
async function noGit(ctx) {
  ctx.env = { HOME: ctx.home, MORI_GIT_PATH: join(ROOT, 'no-git', 'git.exe') };
  await restartWt(ctx);
  const repo = await rowAfterStatus(ctx, ctx.p.p1);
  const plain = await rowAfterStatus(ctx, ctx.p.plain3);
  record('FS-98 without git (MORI_GIT_PATH pointing at a missing git.exe) a repository and a plain folder show neither '
    + 'the toggle nor Initialize git…', repo.status?.git.state === 'missing' && repo.item.kind === null
    && plain.item.kind === null, brief({ git: repo.status?.git, repo: repo.item, plain: plain.item }));
  const { n1 } = ctx.nested;
  const { state } = await deleteView(ctx, n1.sessionFile);
  const outcome = await confirmDelete(ctx);
  record('FS-106 (no git) the dialog says the worktree is kept because Git is required to delete it; confirming '
    + 'deletes the session file and leaves the worktree folder', state.kind === 'no-git'
    && state.note === deleteNote['no-git'](basename(n1.worktree.path)) && outcome === 'closed'
    && !existsSync(n1.sessionFile) && existsSync(n1.worktree.path), brief({ state, outcome }));
  await openStorage(ctx);
  const view = await storageOf(ctx);
  record('FS-107 without git Storage says "Git is required to clean up worktrees." with no list and no button',
    view?.empty === WT.storageNoGit && view.items.length === 0 && view.button === null, brief(view));
  await leaveSettings(ctx);
  const { dirty } = ctx.arc;
  const banner = await failedBanner(ctx, dirty.sessionFile);
  record('FS-105 without git, opening a session whose worktree is gone fails with "Failed to open session: Git is '
    + 'required to restore this session’s worktree."', !existsSync(dirty.worktree.path)
    && banner === `${WT.openFailed}Git is required to restore this session’s worktree.`, brief({ banner }));
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  storageEmpty: [storageEmpty, ['FS-107']],
  toggleShown: [toggleShown, ['FS-98']],
  toggleKinds: [toggleKinds, ['FS-98']],
  toggleNarrow: [toggleNarrow, ['FS-98']],
  toggleBusy: [toggleBusy, ['FS-98']],
  create: [create, ['FS-99', 'FS-98', 'FS-101']],
  busyCreate: [busyCreate, ['FS-99']],
  refChip: [refChip, ['FS-99']],
  failure: [failure, ['FS-100']],
  noModel: [noModel, ['FS-100']],
  nested: [nested, ['FS-110', 'FS-98']],
  subfolder: [subfolder, ['FS-111', 'FS-101']],
  project: [project, ['FS-102']],
  piConfig: [piConfig, ['FS-103']],
  initDialog: [initDialog, ['FS-109']],
  initRunning: [initRunning, ['FS-109']],
  initSuccess: [initSuccess, ['FS-109']],
  initFailures: [initFailures, ['FS-109']],
  initEmpty: [initEmpty, ['FS-109']],
  archiving: [archiving, ['FS-104']],
  reopen: [reopen, ['FS-105']],
  deleting: [deleting, ['FS-106']],
  storage: [storage, ['FS-107']],
  // 下面两步各重新启动一次 App：restart 用同一个环境，noGit 另起一次（MORI_GIT_PATH）
  restart: [restart, ['FS-101', 'FS-112']],
  noGit: [noGit, ['FS-98', 'FS-106', 'FS-107', 'FS-105']],
};

const ctx = { ...fsUserData('mori-fs-wt-data-'), exePath: args.exePath, pageErrors: [], args, record };
await runSuite(ctx, setup, steps);
console.log(`[fs-app-worktree] data in ${ctx.userData}, projects in ${ROOT}`);
finish();
