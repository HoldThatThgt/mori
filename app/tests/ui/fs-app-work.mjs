// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-work：工作路径里的 .work 与命令的临时目录。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic：关键词模式、
// 脚本 fs-team），逐条验收这些编号在 App 层的通过条件：
//   FS-53 App 里的 .work 与临时目录（什么时候建、TEMP / TMP / TMPDIR、.gitignore、截断输出的文件、git 状态、.work 是文件、
//   分析不了的命令的日志、task 实例、工具页、默认启用的工具）、FS-54 告诉模型 .work（请求的 system 里有这一行）。
// 依据：file-system-permissions.md §7.10–§7.12，file-system.md §14。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-work.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-work(-packaged).json（--only 时 fs-partial-app-work…，不计入覆盖检查），截图与 app.log 在
// test-results/fs-app-work/。端口：合成端点 4952，记录代理 4953（fs-helpers FS_PORTS.work）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商（fs-helpers seedFsUserData）；临时目录 ROOT 下
// 六个项目：fresh、write、git（git 仓库，提交过一次）、file（.work 是一个文件）、ps（信任；.pi/settings.json 的
// defaultTools 加上 powershell）、team（没有角色文件，协作模式下是合并会话）。启动后先 away.set { timeout: 'never' }。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  IDENTITY_WORK, answerCard, appLogLines, brief, builtinsOf, cardOf, cardsSince, deniedStatus, fsArgs, fsProject,
  fsRecorder, fsRoot, fsUserData, gateEvents, gitPorcelain, liveInfo, openFsSession, poll, readText, reopenFs,
  requestsSince, restartFsApp, runSuite, same, samePath, seedFsUserData, sendFs, setPermission, startFsApp,
  startFsEndpoint, teamMessage, toolResultsIn, underPath, waitIdleFs, waitToolCard, workDenial,
} from './fs-helpers.mjs';
import { openToolsSection } from './m6-helpers.mjs';
import { toolRows } from './m6-tools-helpers.mjs';
import { instanceFiles, showTab, waitTeamIdle } from './tb-helpers.mjs';

const args = fsArgs('work');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面（synthetic） */
const ROOT = fsRoot('mori-fs-work-');
/** .work 是文件时的原因（§7.10 第 2 步）与工具结果（§14） */
const WORK_IS_FILE = '.work is a file, not a folder';
/** pi 截断输出时的那一行里的文件（bash.js：`Full output: <path>]`） */
const FULL_OUTPUT = /Full output: (.+?)\]/;
/** 写进 .work 的文件内容（关键词 write file: 不带 size 时，replies.mjs WRITE_CONTENT） */
const WRITE_CONTENT = 'hello from mori\n';

// ---------- 准备 ----------

/** @brief 合成端点、项目、数据目录（synthetic test setup），启动 App 并设 away never。 */
async function setup(ctx) {
  ctx.p = Object.fromEntries(['fresh', 'write', 'file', 'ps', 'team'].map((name) => [name, fsProject(ROOT, name)]));
  ctx.p.git = fsProject(ROOT, 'git', { git: true });
  writeFileSync(join(ctx.p.file, '.work'), 'synthetic: .work is a file here\n');
  mkdirSync(join(ctx.p.ps, '.pi'), { recursive: true });
  writeFileSync(join(ctx.p.ps, '.pi', 'settings.json'), `${JSON.stringify({ defaultTools: ['+powershell'] })}\n`);
  ctx.ep = await startFsEndpoint('work');
  seedFsUserData(ctx, { trusted: [ctx.p.ps] });
  await startFsApp(ctx);
}

/** @brief 这个会话的 .work 与 .work\tmp（按后台进程里的工作路径）。 */
const workOf = (who) => ({ work: join(who.cwd, '.work'), tmp: join(who.cwd, '.work', 'tmp') });

/** @brief 在 who 这个会话里发一条消息，要求出卡；返回卡（cardOf）。 */
async function cardFor(ctx, who, text) {
  const { outcome } = await sendFs(ctx, who, text);
  if (outcome !== 'card') throw new Error(`no approval card for "${text}"`);
  return cardOf(ctx, who.tab);
}

/** @brief 在看得到的那张卡上选 Allow once 或 Deny，等这次运行结束。 */
async function answerAndSettle(ctx, who, choice) {
  await answerCard(ctx, who.tab, choice);
  await waitIdleFs(ctx, who.tab);
}

/** @brief 这个会话的会话文件里最后一个 tool 工具的结果；没有时为 null。 */
const lastResult = (who, tool) => toolResultsIn(who.sessionFile).findLast((item) => item.tool === tool) ?? null;

/** @brief 输出的非空行（去掉首尾空白）。 */
const outputLines = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

// ---------- FS-53、FS-54：新项目 ----------

/**
 * @brief 新项目里只调读取工具：没有 .work；请求的 system 里身份段第三行是 .work 那一行（FS-54）；新会话启用的 pi 内置
 *        工具是 read、bash、edit、write，另有 memory 与 ask_user_question。
 */
async function readOnly(ctx) {
  const who = await openFsSession(ctx, ctx.p.fresh);
  ctx.fresh = who;
  const { since, outcome } = await sendFs(ctx, who, 'Look at the fs53 project notes');
  const { work } = workOf(who);
  const read = await waitToolCard(ctx, who.tab, 'README.md', (card) => card.status === 'done', 10000);
  record('FS-53 a new project whose session only calls read tools has no .work', outcome === 'idle'
    && read !== null && !existsSync(work), brief({ outcome, read, work }));
  const requests = requestsSince(ctx, since, 'fs53 project notes');
  record('FS-54 the requests\' system prompt has the .work line ("Put scripts, drafts, and temporary files you need '
    + 'along the way in .work/ …") as the identity section\'s third line', requests.length >= 1
    && requests.every((item) => item.identity.lines[2] === IDENTITY_WORK), brief({ requests: requests.length,
    third: requests.map((item) => item.identity.lines[2]).find((line) => line !== IDENTITY_WORK) }));
  const tools = requests[0]?.tools ?? [];
  record('FS-53 a new session enables pi\'s built-in read, bash, edit and write (plus memory and ask_user_question) '
    + 'and not powershell', same(builtinsOf(tools), ['bash', 'edit', 'read', 'write']) && tools.includes('memory')
    && tools.includes('ask_user_question'), brief(tools));
}

/** @brief Ask each time 下拒绝第一个 bash 调用：仍没有 .work。 */
async function deniedFirst(ctx) {
  const who = ctx.fresh;
  const card = await cardFor(ctx, who, 'run: echo fs53-denied');
  await answerAndSettle(ctx, who, 'deny');
  record('FS-53 denying the first bash call in Ask each time leaves no .work', card?.tool === 'bash'
    && !existsSync(workOf(who).work), brief(card));
}

/**
 * @brief 第一次放行的 bash 调用：cygpath -w 打出的 TEMP、TMP、TMPDIR 与 mktemp 建的文件都在 <项目>\.work\tmp 下，
 *        .work/.gitignore 的内容是 "*"。
 */
async function tempVars(ctx) {
  const who = ctx.fresh;
  await cardFor(ctx, who, 'run: cygpath -w "$TEMP" "$TMP" "$TMPDIR" "$(mktemp)"');
  await answerAndSettle(ctx, who, 'allow');
  const { work, tmp } = workOf(who);
  const result = lastResult(who, 'bash');
  const lines = outputLines(result?.text);
  record('FS-53 the first allowed bash call prints TEMP, TMP, TMPDIR and a mktemp file, all four under '
    + '<project>\\.work\\tmp, and .work/.gitignore is "*"', result?.isError === false && lines.length === 4
    && lines.every((line) => underPath(line, tmp)) && readText(join(work, '.gitignore')) === '*\n',
  brief({ lines, tmp, gitignore: readText(join(work, '.gitignore')) }));
}

/** @brief 输出超过截断上限的命令：Full output: 的文件在后台进程的 os.tmpdir()（它的 TEMP 没变），不在 .work 下。 */
async function fullOutput(ctx) {
  const who = ctx.fresh;
  await cardFor(ctx, who, 'run: seq 1 3000');
  await answerAndSettle(ctx, who, 'allow');
  const text = lastResult(who, 'bash')?.text ?? '';
  const file = FULL_OUTPUT.exec(text)?.[1]?.trim() ?? null;
  record('FS-53 a command whose output is truncated names a "Full output:" file in the kernel\'s own temp folder '
    + '(os.tmpdir(), its TEMP is unchanged), not under <project>\\.work', Boolean(file)
    && !underPath(file, workOf(who).work) && samePath(dirname(file), tmpdir()), brief({ file, tmp: tmpdir() }));
}

/** @brief 分析不了的命令（echo "abc）出卡；日志有 command not analyzed (bash): unclosed quote，没有命令原文。 */
async function unanalyzed(ctx) {
  const who = ctx.fresh;
  const since = Date.now();
  const card = await cardFor(ctx, who, 'run: echo "abc');
  const logged = await poll(() => appLogLines(ctx, 'command not analyzed', since).length > 0, 5000, 200);
  const lines = appLogLines(ctx, 'command not analyzed', since);
  const leaked = appLogLines(ctx, 'echo "abc', since);
  record('FS-53 an unanalyzable command (echo "abc) asks with a card, and the kernel log has "command not analyzed '
    + '(bash): unclosed quote" without the command text', card?.reasons?.[0]?.reason === 'unanalyzed'
    && Boolean(logged) && lines.some((line) => line.includes('[kernel] command not analyzed (bash): unclosed quote'))
    && leaked.length === 0, brief({ card: card?.reasons, lines, leaked }));
  await answerAndSettle(ctx, who, 'deny');
}

/** @brief 工具页（Customize → Built-in tools）：换掉的 bash、powershell 仍显示 Built-in。 */
async function toolsPage(ctx) {
  await showTab(ctx, ctx.fresh.tab);
  await openToolsSection(ctx.page, 'builtin');
  const rows = await toolRows(ctx.page);
  const shell = ['bash', 'powershell'].map((name) => rows.find((row) => row.name === name) ?? null);
  record('FS-53 the tools page shows bash and powershell as Built-in (they are replaced through customTools)',
    shell.every((row) => row?.tag === 'Built-in'), brief(shell));
  await ctx.page.getByTestId('tools-page').getByRole('button', { name: 'Back to app' }).click();
  await ctx.page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 });
}

// ---------- FS-53：写 .work、git 仓库、.work 是文件、PowerShell、task 实例 ----------

/** @brief Ask each time 下写 .work/n.md：不出卡，写之前 .work/.gitignore 已在（先建、内容 "*"）。 */
async function writeWork(ctx) {
  const who = await openFsSession(ctx, ctx.p.write);
  const { since, outcome } = await sendFs(ctx, who, 'write file: .work/n.md');
  const { work } = workOf(who);
  const cards = await cardsSince(ctx, since);
  const [ignore, note] = ['.gitignore', 'n.md'].map((name) => (existsSync(join(work, name))
    ? statSync(join(work, name)) : null));
  record('FS-53 a write into .work/n.md runs without a card in Ask each time, and .work/.gitignore ("*") exists '
    + 'before the file is written', outcome === 'idle' && cards.length === 0 && readText(join(work, '.gitignore'))
    === '*\n' && readText(join(work, 'n.md')) === WRITE_CONTENT && Boolean(ignore && note)
    && ignore.birthtimeMs <= note.birthtimeMs && ignore.mtimeMs <= note.mtimeMs,
  brief({ outcome, cards, ignore: ignore?.birthtimeMs, note: note?.birthtimeMs }));
}

/** @brief git 仓库项目跑过命令（建了 .work、.work/tmp，mktemp 在里面建了文件）之后 git status --porcelain 为空。 */
async function gitClean(ctx) {
  const who = await openFsSession(ctx, ctx.p.git);
  await cardFor(ctx, who, 'run: mktemp');
  await answerAndSettle(ctx, who, 'allow');
  const made = outputLines(lastResult(who, 'bash')?.text)[0] ?? null;
  const status = gitPorcelain(who.cwd);
  record('FS-53 in a git repository, after a command ran (.work/tmp exists and mktemp made a file there), git status '
    + '--porcelain is empty', existsSync(workOf(who).tmp) && Boolean(made) && status === '',
  brief({ made, status }));
}

/**
 * @brief .work 是文件：放行的 bash 调用的工具结果是 §14 的原文，日志有 couldn't prepare .work，工具卡 Denied · Mori
 *        couldn't prepare .work…、没有标签；Full access 下预告过 full 也一样。
 */
async function workIsFile(ctx) {
  const who = await openFsSession(ctx, ctx.p.file);
  const text = workDenial(WORK_IS_FILE);
  const since = Date.now();
  await cardFor(ctx, who, 'run: echo fs53-file');
  await answerAndSettle(ctx, who, 'allow');
  const result = lastResult(who, 'bash');
  const tool = await waitToolCard(ctx, who.tab, 'fs53-file', (card) => card.status === 'rejected', 10000);
  const logs = appLogLines(ctx, "couldn't prepare .work in ", since);
  record('FS-53 when .work is a file, an allowed bash call returns "Mori couldn\'t prepare .work in the working '
    + 'directory (.work is a file, not a folder), so this call didn\'t run. Tell the user.", the log has "couldn\'t '
    + 'prepare .work" and the tool card reads "Denied · Mori couldn\'t prepare .work…" (the whole text on hover) with '
    + 'no label', result?.isError === true && result.text === text && logs.some((line) => line.includes(WORK_IS_FILE))
    && tool?.statusText === deniedStatus(text) && tool.statusTitle === `Denied · ${text}` && tool.badge === null,
  brief({ result, logs, tool }));
  await setPermission(ctx, who.tab, 'full');
  const full = await sendFs(ctx, who, 'run: echo fs53-full');
  const gates = (await gateEvents(ctx, who.sessionId, full.since)).filter((item) => item.toolName === 'bash');
  const denied = await waitToolCard(ctx, who.tab, 'fs53-full', (card) => card.status === 'rejected', 10000);
  record('FS-53 in Full access the same kind of call, announced as full, also ends as "Denied · Mori couldn\'t prepare '
    + '.work…" with no tool-badge', full.outcome === 'idle' && gates[0]?.gate === 'full'
    && denied?.statusText === deniedStatus(text) && denied.badge === null
    && lastResult(who, 'bash')?.text === text, brief({ gates, denied }));
}

/** @brief defaultTools 含 powershell 时，PowerShell 的 [IO.Path]::GetTempPath() 同样在 <项目>\.work\tmp。 */
async function powershellTemp(ctx) {
  const who = await openFsSession(ctx, ctx.p.ps);
  const { since } = await sendFs(ctx, who, 'ps: [IO.Path]::GetTempPath()');
  const card = await cardOf(ctx, who.tab);
  if (card) await answerAndSettle(ctx, who, 'allow');
  const result = lastResult(who, 'powershell');
  const path = outputLines(result?.text)[0] ?? null;
  const tools = requestsSince(ctx, since, 'GetTempPath')[0]?.tools ?? [];
  record('FS-53 with powershell in defaultTools, [IO.Path]::GetTempPath() in the powershell tool is under '
    + '<project>\\.work\\tmp', tools.includes('powershell') && card?.tool === 'powershell'
    && result?.isError === false && underPath(path, workOf(who).tmp), brief({ tools, path, tmp: workOf(who).tmp }));
}

/** @brief TaskBoard 的 task 实例（协作模式、合并会话、Full access）里 cygpath -w "$TMPDIR" 同样在 <项目>\.work\tmp。 */
async function taskTemp(ctx) {
  const who = await openFsSession(ctx, ctx.p.team);
  await setPermission(ctx, who.tab, 'full');
  await sendFs(ctx, who, teamMessage([['fs-call', 'run: cygpath -w "$TMPDIR"']]), { team: true, wait: false });
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the team session did not become idle');
  const task = instanceFiles(ctx, who.sessionId).find((file) => /\.t1\./.test(file.id));
  const result = task ? toolResultsIn(task.file).findLast((item) => item.tool === 'bash') ?? null : null;
  const path = outputLines(result?.text)[0] ?? null;
  record('FS-53 in a TaskBoard task instance cygpath -w "$TMPDIR" is also under <project>\\.work\\tmp',
    result?.isError === false && underPath(path, workOf(who).tmp), brief({ task: task?.id, path }));
}

// ---------- FS-53：重新打开的会话 ----------

/** @brief 重新启动 App、重新打开 fresh 会话：启用的 pi 内置工具仍是 read、bash、edit、write，不多出 powershell。 */
async function reopened(ctx) {
  const who = ctx.fresh;
  await restartFsApp(ctx);
  await reopenFs(ctx, who);
  const { since } = await sendFs(ctx, who, 'Look at the fs53 reopened notes');
  const tools = requestsSince(ctx, since, 'fs53 reopened notes')[0]?.tools ?? [];
  const active = (await liveInfo(ctx, who.sessionFile))?.tools ?? [];
  record('FS-53 a reopened session gets no extra powershell: its request and its enabled tools still have pi\'s '
    + 'read, bash, edit and write only', same(builtinsOf(tools), ['bash', 'edit', 'read', 'write'])
    && same(builtinsOf(active), ['bash', 'edit', 'read', 'write']), brief({ tools, active }));
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  readOnly: [readOnly, ['FS-53', 'FS-54']],
  deniedFirst: [deniedFirst, ['FS-53']],
  tempVars: [tempVars, ['FS-53']],
  fullOutput: [fullOutput, ['FS-53']],
  unanalyzed: [unanalyzed, ['FS-53']],
  toolsPage: [toolsPage, ['FS-53']],
  writeWork: [writeWork, ['FS-53']],
  gitClean: [gitClean, ['FS-53']],
  workIsFile: [workIsFile, ['FS-53']],
  powershellTemp: [powershellTemp, ['FS-53']],
  taskTemp: [taskTemp, ['FS-53']],
  // 重新启动 App：放在最后
  reopened: [reopened, ['FS-53']],
};

const ctx = { ...fsUserData('mori-fs-work-data-'), exePath: args.exePath, pageErrors: [], args, record };
await runSuite(ctx, setup, steps);
console.log(`[fs-app-work] data in ${ctx.userData}, projects in ${ROOT}`);
finish();
