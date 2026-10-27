// 文件系统规格（docs/specs/file-system.md §19.1、§19.2；续篇 file-system-permissions.md §6–§10）的 App 套件
// （tests/ui/fs-app-*.mjs）共用的准备、操作与读取：
// - 命令行与结果文件：test-results/fs-app-<suite>(-packaged).json；--only 时写 fs-partial-app-<suite>(-packaged).json
//   （§19.3：fs-partial-* 不计入覆盖检查）；--exe 指向打包好的 Mori.exe。检查名以 FS 编号开头（调用方保证）。
// - 合成端点（tests/fake-endpoint/server.mjs，synthetic）加记录代理（tb-helpers startTbEndpoint）：关键词模式驱动 bash、
//   edit、write、ask_user_question，脚本 fs-team（scenarios/fs.mjs）驱动后台实例；端口按 FS_PORTS，每个套件自己的一组。
// - 数据目录（synthetic test setup）：一个本机提供商 fsp（模型 fake-fs，写入等级 A，跳过探针）、pi 的 settings.json 与
//   trust.json；快照目录另建，启动时 MORI_SNAPSHOTS_DIR 指向它（§19.1，测试不往真的 %LOCALAPPDATA% 写）。
// - App：启动后先 away.set { timeout: 'never' }（§19.4；只有测你不在的套件传 away: null 并自己设 MORI_AWAY_TIMEOUT_MS）；
//   重启、界面重新载入；会话的工作路径；权限按钮与菜单；批准卡、工具卡、请求里的身份段、会话文件里的工具结果。
// 只读页面和磁盘、发界面操作，不改 Mori 的源码；模型的回复全部来自合成端点。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import {
  appLogLines, awayNever, bridge, closeTbApp, contentText, kernelEvents, liveInfo, openSessionIn, paneSel, paneState,
  poll, readJsonl, reopenSession, seedTeamUserData, sendMessage, showTab, startTbEndpoint, stopTbEndpoint, tbModel,
  tbProvider, userSession,
} from './tb-helpers.mjs';
import { captureEvents, watchStages } from './v1-switch-helpers.mjs';

export { appLogLines, bridge, kernelEvents, liveInfo, oneLine, paneSel, paneState, poll, readJsonl, sleep };

// ---------- 命令行与结果文件 ----------

/**
 * @brief 解析套件的命令行：--exe <Mori.exe>（打包版）、--only a,b（只跑这些步骤，结果写成 partial）。
 * @param suite 套件名（fs-app-<suite>.mjs 的 <suite>）
 * @return { suite, exePath（没有时 null）, only（步骤名数组或 null）, file（结果文件名）, shots（截图目录） }
 */
export function fsArgs(suite) {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `fs-partial-app-${suite}${packaged}.json` : `fs-app-${suite}${packaged}.json`;
  const shots = join(appRoot, `test-results/fs-app-${suite}${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite, exePath, only, file, shots };
}

/**
 * @brief 结果收集器（同 lib.mjs createRecorder）：record(name, ok, detail) 记一条，finish() 写结果文件并设退出码。
 * @param args fsArgs 的结果
 */
export function fsRecorder(args) {
  const recorder = createRecorder(args.exePath ?? 'dev build');
  return {
    record: recorder.record,
    results: recorder.results,
    /** @brief 写 test-results/<args.file>；全部通过（或已知问题）时退出码 0。 */
    finish() {
      const ok = recorder.write(args.file);
      process.exitCode = ok ? 0 : 1;
      console.log(`[fs-app-${args.suite}] results in test-results/${args.file}`);
      return ok;
    },
  };
}

/** @brief 一行概括（检查的 detail，最多 max 个字符）。 */
export const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);
/** @brief 两个值的 JSON 相同。 */
export const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 错误的一行文字（步骤失败时的 detail）。 */
export const errorLine = (error) => String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 500);
/** @brief 两个 Windows 路径相同（不分大小写，统一斜杠，去掉末尾的分隔符）。 */
export const samePath = (a, b) => Boolean(a && b) && norm(a) === norm(b);
/** @brief path 在 dir 里（含 dir 本身；不分大小写）。 */
export const underPath = (path, dir) => Boolean(path && dir) && (samePath(path, dir)
  || norm(path).startsWith(`${norm(dir)}/`));
/** @brief 比较用的路径写法。 */
const norm = (path) => String(path).trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** @brief Git Bash 命令里用的路径写法（C:/a/b）。 */
export const bashPath = (path) => String(path).replace(/\\/g, '/');

/**
 * 每个 fs-app 套件的端口（合成端点、记录代理；4950–4965 没有别的套件用）：§19.1 的八个 App 套件各一组，
 * 推送前的完整测试一个接一个地跑，各用各的也不会在单独重跑某几个时互相占用
 */
export const FS_PORTS = Object.freeze({
  gate: { port: 4950, proxy: 4951 }, work: { port: 4952, proxy: 4953 }, team: { port: 4954, proxy: 4955 },
  away: { port: 4956, proxy: 4957 }, question: { port: 4958, proxy: 4959 }, changes: { port: 4960, proxy: 4961 },
  rewind: { port: 4962, proxy: 4963 }, worktree: { port: 4964, proxy: 4965 },
});

// ---------- 规格里的文字（file-system.md §14、file-system-permissions.md §6.13–§6.15） ----------

/** 身份段第一行（记忆规格附录 A.1，不变） */
export const IDENTITY_FIRST = "You are Mori, a coding assistant working in the user's project folder. You read files, "
  + "run commands, edit code and write files to get the user's work done.";
/** 身份段第二行：按这次运行开始时的模式三选一（§6.16、§14） */
export const PERMISSION_LINE = Object.freeze({
  ask: "Tool calls other than reading and searching may wait for the user's approval. A denied call returns the "
    + "user's reason as its result: follow it and don't repeat the call.",
  full: 'Reading, searching and MCP tools run without approval, and so do edits, writes and commands inside the '
    + 'working directory. Writes outside the working directory or to protected paths (.git, .mori, .pi and similar), '
    + "and commands that change to a directory outside it, wait for the user's approval. A denied call returns the "
    + "user's reason as its result: follow it and don't repeat the call.",
  none: 'Nobody can approve tool calls in this run: writes outside the working directory or to protected paths (.git, '
    + ".mori, .pi and similar), and commands that change to a directory outside it, are denied, so don't try them.",
});
/** 身份段第三行（.work，§7.12、§14）：三种模式、所有会话与实例都一样 */
export const IDENTITY_WORK = 'Put scripts, drafts, and temporary files you need along the way in .work/ in the '
  + "working directory. Git ignores it, and edit and write calls there never wait for the user's approval. Commands "
  + 'run with TEMP, TMP, and TMPDIR set to .work/tmp; use them instead of /tmp.';
/** 身份段第四行（四个分节，不变） */
export const IDENTITY_SECTIONS = 'The sections after the project information hold what Mori has learned with this '
  + 'user: <taste> how to talk with the user, <strategy> how to size and plan work, <review> what to check before '
  + 'saying work is done, <facts> what is true about the user and this project. Follow them unless the user says '
  + "otherwise. Tasks you create and questions you send with agent_message are worked on by agents that don't see "
  + '<facts>: write the facts they need into the task description or the question.';

/** @brief 某种权限模式下身份段的四行（§14）。 */
export const identityLines = (mode) => [IDENTITY_FIRST, PERMISSION_LINE[mode], IDENTITY_WORK, IDENTITY_SECTIONS];

/**
 * @brief 一个请求的 system 文字里的身份段（第一个空行之前，§4.2：身份段之后空一行是 <tools>）：{ lines, mode（第二行
 *        是哪一种权限句，认不出时为 null） }。
 */
export function identityOf(system) {
  const lines = String(system ?? '').split('\n\n')[0].split('\n');
  const mode = Object.keys(PERMISSION_LINE).find((key) => lines[1] === PERMISSION_LINE[key]) ?? null;
  return { lines, mode };
}

/** 切到 Full access 的确认框（§6.13、fs-permissions.md） */
export const FULL_CONFIRM = Object.freeze({
  title: 'Switch to “Full access”?',
  text: 'Edits, writes, and commands inside the working directory will run without asking. Mori still asks before '
    + 'writes it can detect outside it or to protected files. This isn’t a sandbox: scripts and MCP tools can still '
    + 'write anywhere.',
});
/** 权限按钮悬停的第二行（fs-permissions.md“权限按钮”） */
export const MODE_NOTE = Object.freeze({ ask: 'Change the permission mode',
  full: 'Edits, writes, and commands inside the working directory run without asking.' });
/** 权限菜单底部的说明（team-approvals.md，fs-permissions.md“权限菜单”） */
export const MENU_NOTE = 'Applies to all agents in this session. New sessions start at Ask each time.';

/** 第二个按钮下方的小字（§6.13 的表） */
export const HINT = Object.freeze({
  command: 'You won’t be asked again for commands in this session, unless Mori can’t analyze a command or detects '
    + 'that it writes outside the working directory or to a protected path, or changes to a folder outside it.',
  files: (label) => `You won’t be asked again for “${label}” in this session, except outside the working directory `
    + 'or in protected paths.',
  other: (label) => `You won’t be asked again for “${label}” in this session.`,
  oneDir: 'You won’t be asked again in this session for writes directly in this folder (not its subfolders).',
  dirs: (dirs) => `You won’t be asked again in this session for writes directly in: ${dirs.join(', ')}.`,
});
/** @brief 第二个按钮的文字（§6.13 的表）。 */
export const SECOND_LABEL = Object.freeze({
  tool: (label) => `Allow “${label}” for this session`,
  oneDir: (dir) => `Allow writes to ${dir} for this session`,
  dirs: 'Allow writes to these folders for this session',
});
/** @brief 原因行的文字（§6.13 的表）。 */
export const REASON_LINE = Object.freeze({
  outside: (path) => `Writes outside the working directory: ${path}`,
  protected: (path) => `Protected path: ${path}`,
  unresolved: (text) => `Writes to a path Mori can’t resolve: ${text}`,
  leaves: (where) => `Runs outside the working directory: ${where}`,
  unanalyzed: (reason) => `Couldn’t analyze this command: ${reason}`,
});

/** 没人能批时的拒绝（§6.15、§14）：`<why>` 由调用方按理由拼 */
export const nobodyText = (why) => `Denied by Mori: nobody can approve tool calls in this run, and this call ${why}. `
  + "Don't retry it.";
/** .work 建不起来时的拒绝（§7.10、§14） */
export const workDenial = (reason) => `Mori couldn’t prepare .work in the working directory (${reason}), so this call `
  + "didn't run. Tell the user.";
/** mori-memory 先于路径闸的拒绝（记忆规格 §7.7；§12 DENIAL_PREFIXES 的最后一行） */
export const MEMORY_FILES_ONLY = 'Memory files can only be changed with the memory tool or on the Memory page.';
/** 协作模式下对话与合并会话的收窄（§8.3，shared/workspace.ts RELAY_ONLY） */
export const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';
/** 状态行里理由最多显示的字数（tool-cards.md“已拒绝”，ToolCard.tsx REASON_MAX） */
const REASON_MAX = 40;
/** @brief 工具卡状态行里程序拒绝的写法：Denied · <原文>，超过 40 字截断加“…”（§6.15）。 */
export function deniedStatus(reason) {
  const chars = [...reason];
  return `Denied · ${chars.length > REASON_MAX ? `${chars.slice(0, REASON_MAX).join('')}…` : reason}`;
}

// ---------- 合成端点、数据目录与项目（synthetic test setup） ----------

/** 合成端点上的模型（synthetic） */
export const FS_MODEL = 'fake-fs';
/** 本机提供商的 id */
export const FS_PROVIDER = 'fsp';

/**
 * @brief 启动这个套件的合成端点与记录代理（tb-helpers startTbEndpoint）。
 * @param suite FS_PORTS 的键
 * @param env 合成端点的额外环境变量（FAKE_ENHANCE_SCRIPT 等）
 */
export function startFsEndpoint(suite, env = {}) {
  const { port, proxy } = FS_PORTS[suite];
  return startTbEndpoint(port, proxy, env);
}

/** @brief 关掉合成端点与记录代理。 */
export const stopFsEndpoint = (ep) => stopTbEndpoint(ep);

/** @brief 新的临时数据目录与快照目录：{ userData, snapshots }。 */
export function fsUserData(prefix = 'mori-fs-data-') {
  return { userData: mkdtempSync(join(tmpdir(), prefix)), snapshots: mkdtempSync(join(tmpdir(), 'mori-fs-snap-')) };
}

/**
 * @brief 写数据目录（synthetic test setup）：一个本机提供商 fsp（地址是记录代理，模型 fake-fs，写入等级 A）为默认范围，
 *        pi 的 settings.json（piSettings），要信任的项目（trusted，pi/trust.json）。
 * @param ctx { userData, ep（startFsEndpoint 的结果） }
 * @param opts { trusted（项目文件夹的列表）, piSettings }
 */
export function seedFsUserData(ctx, { trusted = [], piSettings = {} } = {}) {
  const providers = [tbProvider(FS_PROVIDER, ctx.ep.proxyPort, [tbModel(FS_MODEL)])];
  seedTeamUserData(ctx.userData, { providers, trusted, piSettings });
}

/** @brief 新的临时目录（各个项目放在它下面：项目的上一级就是它，写到外面的目标在这里）。 */
export const fsRoot = (prefix = 'mori-fs-') => mkdtempSync(join(tmpdir(), prefix));

/**
 * @brief 测试准备（synthetic）：root 下名为 name 的项目，带 README.md（标题 # Mori fixture project）与 src/a.ts；
 *        git 为真时 git init 并提交一次（只在这个临时仓库里设提交者）。
 * @return 项目文件夹
 */
export function fsProject(root, name, { git = false } = {}) {
  const project = join(root, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nSynthetic project for the file system tests.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  if (git) {
    const run = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
    run('init', '-q');
    run('add', '-A');
    run('-c', 'user.name=Mori Test', '-c', 'user.email=mori-test@example.invalid', 'commit', '-q', '-m', 'synthetic');
  }
  return project;
}

/** @brief git status --porcelain 的输出（项目是 git 仓库时）。 */
export const gitPorcelain = (project) => execFileSync('git', ['status', '--porcelain'], { cwd: project,
  encoding: 'utf8' });

/**
 * @brief 测试准备（synthetic）：项目 .pi/mcp.json 里一个直接调用的合成 MCP 服务 srv（tests/mcp-server/server.mjs，
 *        工具 mcp__srv__echo、mcp__srv__add；项目要被信任才加载）。
 */
export function writeMcpServer(project) {
  mkdirSync(join(project, '.pi'), { recursive: true });
  const server = { command: 'node', args: [join(appRoot, 'tests', 'mcp-server', 'server.mjs')], exposure: 'direct' };
  writeFileSync(join(project, '.pi', 'mcp.json'), `${JSON.stringify({ mcpServers: { srv: server } }, null, 2)}\n`);
}

/** @brief 脚本 fs-team 的一条消息（scenarios/fs.mjs 开头）：每个 [key, 步骤] 一行，最后一行是 tb-scenario:fs-team。 */
export const teamMessage = (lines) => `${lines.map(([key, step]) => `${key}: ${step}`).join('\n')}\n`
  + 'tb-scenario:fs-team';

// ---------- App ----------

/** @brief 按行收集一个流。 */
function collectLines(stream, onLine) {
  let rest = '';
  stream.on('data', (chunk) => {
    rest += String(chunk);
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
}

/**
 * @brief 启动 Mori：MORI_USER_DATA、MORI_SNAPSHOTS_DIR 指向测试目录（ctx.env 另加的环境变量盖过它们），主进程与后台进程
 *        的输出收进 ctx.appLog，订阅后台进程的事件（captureEvents）、阶段行（watchStages）、出现过的批准卡（watchCards）；
 *        away 为 'never' 时先 away.set { timeout: 'never' }（§19.4），为 null 时不设。
 * @param ctx { userData, snapshots, exePath?, env?, pageErrors?, appLog? }；结果写进 ctx.app、ctx.page
 */
export async function startFsApp(ctx, { away = 'never' } = {}) {
  ctx.pageErrors ??= [];
  ctx.appLog ??= [];
  const env = { MORI_SNAPSHOTS_DIR: ctx.snapshots, ...(ctx.env ?? {}) };
  ctx.app = await launch({ exePath: ctx.exePath ?? null, userData: ctx.userData, env });
  const child = ctx.app.process();
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) collectLines(stream, (line) => ctx.appLog.push({ t: Date.now(), line }));
  }
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await watchPage(ctx);
  if (away === 'never') await awayNever(ctx);
  return ctx.page;
}

/** @brief 页面里的记录：后台进程的事件、阶段行、出现过的批准卡（界面重新载入后要重新装）。 */
async function watchPage(ctx) {
  await captureEvents(ctx.page);
  await watchStages(ctx.page);
  await watchCards(ctx);
}

/** @brief 关掉 Mori（有序关闭后台进程）。 */
export const closeFsApp = (ctx) => closeTbApp(ctx);

/** @brief 用同一个数据目录重新启动 Mori；之后要重新打开会话（reopenFs）。 */
export async function restartFsApp(ctx, opts = {}) {
  await closeTbApp(ctx);
  ctx.projectTabs = {};
  return startFsApp(ctx, opts);
}

/** @brief 界面重新载入（page.reload，与 Ctrl+R 相同，后台进程不停）：等会话列表读完，重新装上页面里的记录。 */
export async function reloadFsUi(ctx) {
  ctx.projectTabs = {};
  await ctx.page.reload();
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 30000 });
  await ctx.page.waitForFunction(() => document.querySelectorAll('.session-item').length > 0
    && !document.querySelector('[data-testid="session-tree"]')?.textContent?.includes('Loading sessions…'), null,
  { timeout: 20000 });
  await watchPage(ctx);
}

/** @brief 截图到套件的截图目录（失败也不报错）。 */
export const shotFs = (ctx, args, name) => ctx.page?.screenshot({ path: join(args.shots, `${name}.png`) })
  .catch(() => {});

/**
 * @brief 在 project 里开一个新会话（tb-helpers openSessionIn），返回 { tab, sessionId, sessionFile, cwd（后台进程里
 *        这个会话的工作路径，SessionInfo.cwd） }；侧栏行还没有会话文件时后三项先为 null / project，第一次 sendFs 之后补上。
 */
export async function openFsSession(ctx, project, opts = {}) {
  const tab = await openSessionIn(ctx, project, opts);
  return fillSession(ctx, { tab, sessionId: null, sessionFile: null, cwd: project });
}

/** @brief 重新启动或重新载入之后从侧栏打开这个会话（按会话文件），更新 who.tab；返回 who。 */
export async function reopenFs(ctx, who) {
  who.tab = await reopenSession(ctx, who.sessionFile);
  return who;
}

/** @brief 后台进程里这个会话的批准状态（SessionInfo.approval：{ mode, allowed, allowedDirs }）。 */
export async function approvalOf(ctx, who) {
  return (await liveInfo(ctx, who.sessionFile))?.approval ?? null;
}

// ---------- 权限按钮与菜单 ----------

/** @brief 权限按钮的选择器。 */
const permissionButton = (tab) => `${paneSel(tab)} [data-testid="permission-button"]`;

/** @brief 打开这个会话的权限菜单（已开着时不动），返回菜单的 locator。 */
export async function openPermissionMenu(ctx, tab) {
  await showTab(ctx, tab);
  const menu = ctx.page.getByTestId('permission-menu');
  if (!(await menu.isVisible().catch(() => false))) await ctx.page.locator(permissionButton(tab)).click();
  await menu.waitFor({ timeout: 5000 });
  return menu;
}

/**
 * @brief 权限菜单此刻的内容：{ items（两个模式项 { name, checked }）, caption（列表上方的标题）, allowed（列表项
 *        { kind, label, forget（Forget 的悬停） }）, empty（None 那一行）, note（底部说明） }；菜单没开时为 null。
 */
export function permissionMenuState(ctx) {
  return ctx.page.evaluate(() => {
    const menu = document.querySelector('[data-testid="permission-menu"]');
    if (!menu) return null;
    const text = (el) => el?.textContent?.trim() ?? null;
    return {
      items: [...menu.querySelectorAll('[role="menuitemradio"]')].map((el) => ({ name: text(el),
        checked: el.getAttribute('aria-checked') === 'true' })),
      caption: text(menu.querySelector('.menu-caption')),
      allowed: [...menu.querySelectorAll('[data-testid="permission-allowed"] li')].map((li) => ({
        kind: li.dataset.kind ?? null, label: text(li.querySelector('span')),
        forget: li.querySelector('button')?.getAttribute('title') ?? null })),
      empty: text(menu.querySelector('.menu-empty')), note: text(menu.querySelector('.menu-note')),
    };
  });
}

/** @brief 关上开着的权限菜单（Esc），等它消失。 */
export async function closePermissionMenu(ctx) {
  const menu = ctx.page.getByTestId('permission-menu');
  if (!(await menu.isVisible().catch(() => false))) return;
  await ctx.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
}

/** @brief 等权限按钮的模式名变成 name。 */
const waitModeText = (ctx, tab, name) => ctx.page.waitForFunction(({ css, want }) => document.querySelector(css)
  ?.querySelector('.permission-text')?.textContent === want, { css: permissionButton(tab), want: name },
{ timeout: 10000 });

/**
 * @brief 切换权限模式：'full' 经菜单 → Full access → 确认框的 Full access；'ask' 经菜单 → Ask each time（不确认）。
 *        等按钮的模式名变过来。
 */
export async function setPermission(ctx, tab, mode) {
  const menu = await openPermissionMenu(ctx, tab);
  const name = mode === 'full' ? 'Full access' : 'Ask each time';
  await menu.getByRole('menuitemradio', { name, exact: true }).click();
  if (mode === 'full') {
    await ctx.page.getByTestId('confirm-dialog').getByRole('button', { name: 'Full access', exact: true }).click();
  }
  await waitModeText(ctx, tab, name);
}

// ---------- 批准卡 ----------

/**
 * @brief 这个会话面板里看得到的那张批准卡：{ request, tool, scope, agent, task, attribution, title, reasons（原因行
 *        [{ reason, text }]）, more（“and {n} more”那一行或 null）, second（{ kind, label, hint } 或 null） }；没有卡时为 null。
 */
export function cardOf(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const card = document.querySelector(`${selector} [data-testid="approval-card"]`);
    if (!card) return null;
    const text = (el) => el?.textContent?.trim() ?? null;
    const button = card.querySelector('[data-testid="approval-allow-session"]');
    const label = button ? [...button.childNodes].filter((node) => !node.classList?.contains('approval-key'))
      .map((node) => node.textContent).join('').trim() : null;
    return {
      request: card.dataset.request ?? null, tool: card.dataset.tool ?? null, scope: card.dataset.scope ?? null,
      agent: card.dataset.agent ?? null, task: card.dataset.task ?? null,
      attribution: text(card.querySelector('[data-testid="approval-attribution"]')),
      title: text(card.querySelector('[data-testid="approval-title"]')),
      reasons: [...card.querySelectorAll('[data-testid="approval-scope"]')].map((el) => ({
        reason: el.dataset.reason ?? null, text: text(el) })),
      more: text(card.querySelector('[data-testid="approval-scope-more"]')),
      second: button ? { kind: button.dataset.kind ?? null, label, hint: text(card.querySelector('.approval-hint')) }
        : null,
    };
  }, paneSel(tab));
}

/** @brief 等这个会话面板出现一张批准卡（可要求不是 notRequest 那张），最多 timeout；返回 cardOf 的结果或 null。 */
export async function waitCard(ctx, tab, { timeout = 30000, notRequest = null } = {}) {
  return poll(async () => {
    const card = await cardOf(ctx, tab);
    return card && card.request !== notRequest ? card : null;
  }, timeout, 150);
}

/** 卡上三个选项的按钮 */
const ANSWER_BUTTON = { allow: 'approval-allow', second: 'approval-allow-session', deny: 'approval-reject' };

/**
 * @brief 在看得到的那张卡上点一个选项（allow：Allow once；second：第二个按钮；deny：Deny），等这张卡消失或换成下一张。
 * @return 点之前的卡（cardOf）
 */
export async function answerCard(ctx, tab, choice) {
  const card = await cardOf(ctx, tab);
  if (!card) throw new Error(`no approval card in ${tab} to answer (${choice})`);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="approval-card"] [data-testid="${ANSWER_BUTTON[choice]}"]`)
    .click();
  await ctx.page.waitForFunction(({ selector, id }) => document.querySelector(`${selector} [data-testid=`
    + '"approval-card"]')?.dataset.request !== id, { selector: paneSel(tab), id: card.request }, { timeout: 10000 });
  return card;
}

/**
 * @brief 在页面里记下出现过的批准卡（window.__fsCards：{ t, tool, request, scope }）：看“没有出卡”时用，
 *        卡出现又马上消失也记得到。
 */
export function watchCards(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__fsCards) return;
    window.__fsCards = [];
    const seen = new WeakSet();
    const scan = () => {
      for (const el of document.querySelectorAll('[data-testid="approval-card"]')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__fsCards.push({ t: Date.now(), tool: el.dataset.tool ?? null, request: el.dataset.request ?? null,
          scope: el.dataset.scope ?? null });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
    scan();
  });
}

/** @brief watchCards 记下的批准卡（since 之后）。 */
export const cardsSince = (ctx, since) => ctx.page.evaluate((from) => (window.__fsCards ?? [])
  .filter((item) => item.t >= from), since);

// ---------- 工具卡 ----------

/**
 * @brief 这个会话面板里的工具卡（按对话流的顺序）：[{ title, status（data-status）, badge（tool-badge 的文字或 null）,
 *        statusText（状态行）, statusTitle（状态行的悬停或 null） }]。
 */
export function toolCardsOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="tool-card"]`).evaluateAll((cards) => cards.map((card) => {
    const status = card.querySelector('[data-testid="tool-status"]');
    return { title: card.querySelector('.tool-title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      status: card.dataset.status ?? null,
      badge: card.querySelector('[data-testid="tool-badge"]')?.textContent?.trim() ?? null,
      statusText: status?.textContent?.trim() ?? null, statusTitle: status?.getAttribute('title') ?? null };
  }));
}

/** @brief 等标题含 marker 的工具卡符合 test（不给时只等它出现），最多 timeout；返回那张卡或 null。 */
export async function waitToolCard(ctx, tab, marker, test = () => true, timeout = 30000) {
  return poll(async () => (await toolCardsOf(ctx, tab)).findLast((card) => card.title.includes(marker)
    && test(card)) ?? null, timeout, 150);
}

// ---------- 发消息与等待 ----------

/** @brief 这个会话面板此刻是否空闲：不在生成、不在发送、没有阶段行、没有批准卡。 */
async function tabIdle(ctx, tab) {
  return ctx.page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    return Boolean(pane) && pane.dataset.running === 'false' && pane.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="stage"]') && !pane.querySelector('[data-testid="approval-card"]');
  }, paneSel(tab));
}

/**
 * @brief 等这个会话面板出现批准卡，或连续 stableMs 空闲（运行结束），最多 timeout。
 * @return 'card' | 'idle'；超时时报错
 */
export async function waitCardOrIdle(ctx, tab, { timeout = 60000, stableMs = 1200 } = {}) {
  const deadline = Date.now() + timeout;
  let since = null;
  while (Date.now() < deadline) {
    if (await cardOf(ctx, tab)) return 'card';
    if (!(await tabIdle(ctx, tab))) since = null;
    else if (since === null) since = Date.now();
    else if (Date.now() - since >= stableMs) return 'idle';
    await sleep(150);
  }
  throw new Error(`session ${tab} neither showed an approval card nor became idle within ${timeout} ms`);
}

/**
 * @brief 发一条消息，等合成端点收到这次的请求，再等出卡或运行结束（waitCardOrIdle）。
 * @param who 会话：openFsSession 的结果（还没有会话文件时发送后补上），或只给会话的标识 tab
 * @param opts { team（/team 发送）, wait（为 false 时不等出卡或结束，outcome 为 null；协作模式下后台实例的卡在用户会话
 *              空闲之后才来，由调用方自己等）, timeout }
 * @return { since（发送的时刻）, outcome（'card' | 'idle' | null） }
 */
export async function sendFs(ctx, who, text, { team = false, wait = true, timeout = 60000 } = {}) {
  const tab = typeof who === 'string' ? who : who.tab;
  const since = Date.now();
  await sendMessage(ctx, tab, text, { team });
  const asked = await poll(() => ctx.ep.proxy.captures.some((item) => item.chat && item.t >= since), 30000, 100);
  if (!asked) throw new Error(`no request for "${oneLine(text, 80)}" in ${tab}`);
  if (typeof who === 'object') await fillSession(ctx, who);
  return { since, outcome: wait ? await waitCardOrIdle(ctx, tab, { timeout }) : null };
}

/**
 * @brief 补上会话的 id、会话文件与工作路径（新会话在第一次发送之前侧栏行可能还没有会话文件，后台进程也可能还读不到
 *        它）；已经读到的不再读。
 * @param who { tab, sessionId?, sessionFile?, cwd?, cwdKnown?（cwd 已是后台进程给的 SessionInfo.cwd） }
 */
export async function fillSession(ctx, who) {
  if (!who.sessionFile) Object.assign(who, (await userSession(ctx, who.tab)) ?? {});
  if (who.sessionFile && !who.cwdKnown) {
    const cwd = (await liveInfo(ctx, who.sessionFile).catch(() => null))?.cwd;
    if (cwd) Object.assign(who, { cwd, cwdKnown: true });
  }
  return who;
}

/** @brief 等这个会话空闲（运行结束、没有卡）；超时时报错。 */
export async function waitIdleFs(ctx, tab, timeout = 60000) {
  const outcome = await waitCardOrIdle(ctx, tab, { timeout });
  if (outcome !== 'idle') throw new Error(`session ${tab} shows an approval card instead of ending its run`);
}

// ---------- 请求、事件与会话文件 ----------

/**
 * @brief 记录代理收到的对话请求（since 之后，按收到的顺序），可按最后一条用户消息含 marker 筛：
 *        [{ t, system, tools（工具名）, lastUser（最后一条 user 消息的文字）, identity（identityOf） }]。
 */
export function requestsSince(ctx, since = 0, marker = null) {
  return ctx.ep.proxy.captures.filter((item) => item.chat && item.body && item.t >= since).map((item) => {
    const messages = item.body.messages ?? [];
    const system = messages.filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => contentText(m.content)).join('\n');
    const lastUser = contentText(messages.findLast((m) => m.role === 'user')?.content);
    return { t: item.t, system, tools: (item.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
      lastUser, identity: identityOf(system) };
  }).filter((item) => marker === null || item.lastUser.includes(marker));
}

/** pi 的内置工具（有 promptSnippet 的那几个；请求的 tools 里按名字认） */
export const PI_BUILTINS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
/** @brief 工具名里 pi 的内置工具，排好序。 */
export const builtinsOf = (tools) => tools.filter((name) => PI_BUILTINS.includes(name)).sort();

/** @brief 记下的 mori.tool_gate 事件（这个会话，since 之后）：[{ t, toolCallId, toolName, gate }]。 */
export async function gateEvents(ctx, sessionId, since = 0) {
  const events = await kernelEvents(ctx, sessionId, 'mori.tool_gate', since);
  return events.map((item) => ({ t: item.t, toolCallId: item.data.toolCallId, toolName: item.data.toolName,
    gate: item.data.gate }));
}

/**
 * @brief 会话文件里的工具结果（按顺序）：[{ id（toolCallId）, tool, isError, text }]；文件不存在时为 []。
 * @param file pi 的会话文件（用户会话或实例会话）
 */
export function toolResultsIn(file) {
  return readJsonl(file).filter((entry) => entry.type === 'message' && entry.message?.role === 'toolResult')
    .map((entry) => ({ id: entry.message.toolCallId ?? null, tool: entry.message.toolName ?? null,
      isError: entry.message.isError === true, text: contentText(entry.message.content) }));
}

/** @brief 会话文件里某个工具调用的参数：[{ id, name, args }]（助手消息里的 toolCall 块）。 */
export function toolCallsIn(file) {
  return readJsonl(file).filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .flatMap((entry) => (Array.isArray(entry.message.content) ? entry.message.content : [])
      .filter((part) => part?.type === 'toolCall').map((part) => ({ id: part.id, name: part.name,
        args: part.arguments ?? {} })));
}

/** @brief 等会话文件里出现满足 test 的工具结果，最多 timeout；返回它或 null。 */
export async function waitToolResult(file, test, timeout = 15000) {
  return poll(() => toolResultsIn(file).findLast(test) ?? null, timeout, 200);
}

/** @brief 读一个文件的文字；不存在时为 null。 */
export const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

// ---------- 步骤与收尾 ----------

/**
 * @brief 这次要跑的步骤验收的编号（--only 时只算列出的步骤），去掉重复，按步骤的顺序。
 * @param ctx 套件的 ctx（ctx.args）
 * @param steps 同 runSteps
 */
function stepIds(ctx, steps) {
  const chosen = Object.entries(steps).filter(([name]) => !ctx.args.only || ctx.args.only.includes(name));
  return [...new Set(chosen.flatMap(([, [, ids]]) => ids))];
}

/**
 * @brief 依次跑步骤（--only 时只跑列出的）：每个步骤 [函数, 它验收的编号]；步骤抛错时每个编号记一条
 *        "<编号> step <名字> ran to the end" 的失败并截图。这次验收的编号记进 ctx.stepIds（finishFs 用）。
 * @param ctx 套件的 ctx（ctx.args、ctx.record）
 * @param steps { 名字: [async (ctx) => void, ['FS-n', …]] }
 */
export async function runSteps(ctx, steps) {
  ctx.stepIds ??= stepIds(ctx, steps);
  for (const [name, [step, ids]] of Object.entries(steps)) {
    if (ctx.args.only && !ctx.args.only.includes(name)) continue;
    console.log(`[fs-app-${ctx.args.suite}] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      for (const id of ids) ctx.record(`${id} step ${name} ran to the end`, false, errorLine(error));
      await shotFs(ctx, ctx.args, `${name}-error`);
      await closePermissionMenu(ctx).catch(() => {});
    }
  }
}

/**
 * @brief 收尾：页面没有报错（按这次验收的每个编号各记一条 "<编号> (fs-app-<套件>) the page reported no errors"，
 *        检查名以编号开头，§19.2）、写 app.log、关掉 App 与合成端点。
 */
export async function finishFs(ctx) {
  const errors = ctx.pageErrors ?? [];
  for (const id of ctx.stepIds ?? []) {
    ctx.record(`${id} (fs-app-${ctx.args.suite}) the page reported no errors`, errors.length === 0,
      errors.slice(0, 3).join(' | '));
  }
  writeFileSync(join(ctx.args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeFsApp(ctx);
  await stopFsEndpoint(ctx.ep);
}

/**
 * @brief 跑一个套件：准备（setup）、依次跑步骤（runSteps），最后收尾（finishFs）。准备抛错时这次验收的每个编号记一条
 *        "<编号> suite setup ran to the end" 的失败并截图，收尾照做，结果文件由调用方随后的 finish() 写出。
 * @param ctx 套件的 ctx（ctx.args、ctx.record、ctx.pageErrors）
 * @param setup async (ctx) => void：合成端点、项目、数据目录与启动 App
 * @param steps 同 runSteps
 */
export async function runSuite(ctx, setup, steps) {
  ctx.stepIds = stepIds(ctx, steps);
  try {
    await setup(ctx);
    await runSteps(ctx, steps);
  } catch (error) {
    console.error(`[fs-app-${ctx.args.suite}] setup failed: ${errorLine(error)}`);
    for (const id of ctx.stepIds) ctx.record(`${id} suite setup ran to the end`, false, errorLine(error));
    await shotFs(ctx, ctx.args, 'setup-error');
  } finally {
    await finishFs(ctx);
  }
}
