// 自动找 Git Bash（负责人走查 M28 "bash not usable in mori"；docs/app-v0.md 第 6 节"Shell"，检查记录
// docs/v1/walkthrough-1026/WP-00.md）。负责人的机器上 Git for Windows 装在 D:\Git，PATH 上只有 D:\Git\cmd，pi 自己
// 找不到 bash。这里照样造出 pi 找不到 bash 的环境再启动 Mori：PATH 去掉每个含 bash.exe 或 git.exe 的目录，
// ProgramFiles 与 ProgramFiles(x86) 指向空的临时目录（测试准备，synthetic test setup）。
//   A：PATH 上加回 <Git>\cmd（安装程序的默认），Mori 从 git.exe 推出 <Git>\bin\bash.exe；
//   B：PATH 上没有 git.exe，Mori 从 Git for Windows 注册表的 InstallPath 找到它（这台机器的注册表里没有时记 KNOWN、不跑）。
// 每种情形用新的数据目录走首次启动，打开临时项目、切到 Allow all，让合成端点调用 bash，检查命令跑在 Git Bash 里、
// 后台进程记了一行找到的结果，且 pi 的 settings.json 里没有写进 shellPath。
// --real：用走查数据目录的复制（只复制密文文件，不读 key）和情形 A 的环境，让真实模型跑一条 bash 命令。
// 用法（在 app/ 下，先 npx electron-vite build）：
//   node tests/ui/m0-shell.mjs [--exe <Mori.exe>]                          结果 test-results/m0-shell(-packaged).json
//   node tests/ui/m0-shell.mjs --only A                                     只跑列出的合成情形（A、B；测试分层第 2 条）
//   node tests/ui/m0-shell.mjs --real --source <走查数据目录> [--exe …]     结果 test-results/m0-shell-real(-packaged).json

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import {
  appRoot, arg, createRecorder, oneLine, prepareProject, scratchUserData, useRealGroup,
} from './lib.mjs';
import { startFakeEndpoint } from './m6-helpers.mjs';
import { OPEN_FOLDER, pageHelpers, showStep } from './page.mjs';

const PORT = 4390;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const KEY = 'synthetic-test-key';
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const real = process.argv.includes('--real');
/** --only：只跑列出的合成情形（A、B），没给时两种都跑 */
const only = arg('only')?.split(',');
const source = arg('source');
const recorder = createRecorder(exePath ?? 'dev build');
const { record } = recorder;
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
/** 让合成端点调用 bash 的命令：打出 bash 版本、系统名和 Git Bash 的根目录（Windows 路径） */
const COMMAND = 'echo "bash=$BASH_VERSION"; uname -s; cygpath -w /';
/** 后台进程启动时记下的找 bash 的结果（kernel/shell.ts describeShell） */
const SHELL_LOG = /\[kernel\] shell: [^\r\n]*/g;

/** @brief 运行 System32 下的一个命令，返回标准输出；退出码不为 0 时为 null。 */
function system(exe, args, env = process.env) {
  const result = spawnSync(join(SYSTEM32, exe), args, { env, cwd: appRoot, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

/** @brief 当前 PATH 的各项（Windows 上变量名不分大小写）。 */
function pathEntries() {
  const name = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  return (name ? process.env[name] : '').split(';').filter(Boolean);
}

/** @brief git.exe 推出的 Git for Windows 目录（<Git>\cmd、<Git>\bin、<Git>\mingw64\bin）；不是这几处时为 null。 */
function rootOfGit(gitExe) {
  const dir = dirname(gitExe);
  const leaf = dir.split('\\').at(-1).toLowerCase();
  if (leaf === 'cmd') return dirname(dir);
  if (leaf !== 'bin') return null;
  return dirname(dir).toLowerCase().endsWith('\\mingw64') ? dirname(dirname(dir)) : dirname(dir);
}

/** @brief 这台机器的 Git for Windows：注册表里的 InstallPath（没有时为 null），以及测试用的 Git 目录（先看 git.exe）。 */
function machineGit() {
  const output = system('reg.exe', ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'])
    ?? system('reg.exe', ['query', 'HKCU\\SOFTWARE\\GitForWindows', '/v', 'InstallPath']);
  const registry = /^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output ?? '')?.[1] ?? null;
  const fromPath = (system('where.exe', ['git.exe']) ?? '').split(/\r?\n/).filter(Boolean).map(rootOfGit)
    .find((root) => root && existsSync(join(root, 'bin', 'bash.exe'))) ?? null;
  const registryRoot = registry && existsSync(join(registry, 'bin', 'bash.exe')) ? registry : null;
  return { root: fromPath ?? registryRoot, registryRoot };
}

/**
 * @brief 让 pi 自己找不到 bash 的环境（测试准备）：PATH 去掉每个含 bash.exe 或 git.exe 的目录，再加上 extra；
 *        ProgramFiles 与 ProgramFiles(x86) 指向空目录。原来的同名变量不论大小写都去掉，免得子进程拿到两份。
 */
function strippedEnv(emptyDir, userData, extra = []) {
  const replaced = ['PATH', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'MORI_USER_DATA'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !replaced.includes(key.toUpperCase())));
  const keep = pathEntries().filter((dir) => !['bash.exe', 'git.exe'].some((exe) => existsSync(join(dir, exe))));
  return { ...env, Path: [...keep, ...extra].join(';'), ProgramFiles: emptyDir, 'ProgramFiles(x86)': emptyDir,
    MORI_USER_DATA: userData };
}

/** @brief 前提：这个环境里 pi 自己的查找确实落空（PATH 上没有 bash.exe、Program Files 下没有 Git Bash）。 */
function checkPrecondition(label, env, emptyDir) {
  const where = system('where.exe', ['bash.exe'], env);
  const programFiles = existsSync(join(emptyDir, 'Git', 'bin', 'bash.exe'));
  record(`${label} 前提：pi 自己找不到 bash（PATH 上没有 bash.exe，ProgramFiles 指向空目录）`,
    where === null && !programFiles, `where bash.exe：${oneLine(where ?? '(none)')}；ProgramFiles=${emptyDir}`);
}

/** @brief 用给定的环境启动 Mori（MORI_APP_DIR 同 lib.mjs launch），收集主进程转出的后台进程输出。 */
async function launchWith(env) {
  const appDir = process.env.MORI_APP_DIR ? resolve(process.env.MORI_APP_DIR) : appRoot;
  const app = await electron.launch(exePath ? { executablePath: exePath, env } : { args: [appDir], cwd: appDir, env });
  const log = [];
  app.process().stdout?.on('data', (chunk) => log.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => log.push(String(chunk)));
  return { app, log, page: await app.firstWindow() };
}

/** @brief 发一条消息、等本轮结束，返回本轮的工具卡（动词、状态、展开后的文字；卡折在步骤组里时先展开那一组）。 */
async function sendForCards(page, text, timeout) {
  const h = pageHelpers(page);
  const cards = page.locator('.pane-slot:not([hidden]) [data-testid="tool-card"]');
  const before = await cards.count();
  await h.send(text);
  await h.idle(timeout);
  const found = [];
  for (let i = before; i < await cards.count(); i += 1) {
    const card = cards.nth(i);
    await showStep(card);
    await card.locator('summary').click();
    await card.locator('.tool-body').waitFor({ timeout: 5000 }).catch(() => {});
    found.push({ verb: await card.locator('.tool-verb').textContent(), status: await card.getAttribute('data-status'),
      text: oneLine(await card.innerText(), 400) });
  }
  return found;
}

/**
 * @brief 一张 Run 卡是否证明命令跑在 root 下的 Git Bash 里：完成、打出 bash 版本与 MINGW 系统名；
 *        root 给出时 cygpath -w / 打出的根目录就是它。
 */
function ranInGitBash(card, root) {
  const { text } = card;
  return card.verb === 'Run' && card.status === 'done' && /bash=\d/.test(text) && /MINGW/.test(text)
    && (!root || text.toLowerCase().includes(`${root.toLowerCase().replace(/\\$/, '')}\\`));
}

/** @brief 后台进程记的找 bash 的结果：只有一行，且就是 expected（正则）。 */
function checkLog(label, log, expected) {
  const lines = log.join('').match(SHELL_LOG) ?? [];
  record(`${label} 后台进程启动时记一行找 bash 的结果`, lines.length === 1 && expected.test(lines[0]),
    lines.join(' | ') || '(no shell line)');
}

/** @brief pi 的 settings.json（数据目录 pi/ 下）没有写进 shellPath 和 defaultTools；文件不存在也算。 */
function checkSettings(label, userData) {
  const file = join(userData, 'pi', 'settings.json');
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  record(`${label} 你的 pi settings.json 里没有写进 shellPath 或 defaultTools`,
    !('shellPath' in settings) && !('defaultTools' in settings),
    existsSync(file) ? `keys: ${Object.keys(settings).join(', ') || '(none)'}` : 'settings.json not written');
}

/**
 * @brief 一种情形：新的数据目录走首次启动（合成端点），打开临时项目、切到 Allow all，让合成端点调用 bash。
 * @param label 情形的名字（A / B）
 * @param root 命令应在其下运行的 Git for Windows 目录
 * @param extra PATH 上加回的目录
 * @param expected 后台进程那行日志应有的样子
 */
async function syntheticCase(label, root, extra, expected) {
  const emptyDir = mkdtempSync(join(tmpdir(), 'mori-shell-pf-'));
  const userData = mkdtempSync(join(tmpdir(), 'mori-shell-data-'));
  const { project } = prepareProject('mori-shell-');
  const env = strippedEnv(emptyDir, userData, extra);
  checkPrecondition(label, env, emptyDir);
  const { app, log, page } = await launchWith(env);
  try {
    const h = pageHelpers(page);
    await h.setupFirstRun({ baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: KEY, modelId: 'fake-coder' });
    await h.openFolder(app, project);
    await h.allowAll();
    const cards = await sendForCards(page, `run: ${COMMAND}`, 60000);
    record(`${label} 模型的 bash 调用完成，命令跑在 ${root} 的 Git Bash 里`,
      cards.length === 1 && ranInGitBash(cards[0], root), cards.map((card) => card.text).join(' | ') || '(no card)');
    checkLog(label, log, expected);
  } catch (error) {
    record(`${label} 流程`, false, oneLine(error, 300));
  } finally {
    await app.close().catch(() => {});
  }
  checkSettings(label, userData);
  rmSync(emptyDir, { recursive: true, force: true });
}

/** @brief 后台进程日志里 Git Bash 那一行的正则：路径为 <root>\bin\bash.exe，途径为 from。 */
function gitLine(root, from) {
  const path = join(root, 'bin', 'bash.exe').replace(/[\\.()]/g, '\\$&');
  return new RegExp(`^\\[kernel\\] shell: Git Bash ${path} \\(${from}\\), set as shellPath in memory$`, 'i');
}

/** @brief 合成端点的两种情形（A：git.exe 在 PATH 上；B：只有注册表）。 */
async function synthetic() {
  const git = machineGit();
  if (!git.root) {
    record('这台机器装有 Git for Windows（测试要用它的 bash.exe）', false, 'no git.exe with bin\\bash.exe, no registry key');
    return;
  }
  const fake = await startFakeEndpoint(PORT, KEY);
  try {
    if (!only || only.includes('A')) {
      await syntheticCase('A', git.root, [join(git.root, 'cmd')], gitLine(git.root, 'from git\\.exe on PATH'));
    }
    if (only && !only.includes('B')) return;
    if (git.registryRoot) {
      const expected = gitLine(git.registryRoot, 'from the Git for Windows registry key');
      await syntheticCase('B', git.registryRoot, [], expected);
    } else {
      record('B 注册表的途径没有检查：这台机器的注册表里没有 Git for Windows 的 InstallPath', false, '', true);
    }
  } finally {
    fake.kill();
  }
}

/** @brief --real：复制走查数据目录，用情形 A 的环境让真实模型跑一条 bash 命令（模型自己调用 bash 工具）。 */
async function realRun() {
  if (!source) throw new Error('Missing --source <data dir>');
  const git = machineGit();
  if (!git.root) throw new Error('This check needs Git for Windows (git.exe with bin\\bash.exe, or the registry key)');
  const emptyDir = mkdtempSync(join(tmpdir(), 'mori-shell-pf-'));
  const userData = scratchUserData(resolve(source));
  const { project } = prepareProject('mori-shell-real-');
  useRealGroup(userData);
  const env = strippedEnv(emptyDir, userData, [join(git.root, 'cmd')]);
  checkPrecondition('real', env, emptyDir);
  const { app, log, page } = await launchWith(env);
  try {
    const h = pageHelpers(page);
    await page.getByRole('button', { name: OPEN_FOLDER }).first().waitFor({ timeout: 60000 });
    await h.openFolder(app, project);
    await h.allowAll();
    const cards = await sendForCards(page, 'Use the bash tool to run exactly this command, then tell me what it '
      + `printed: ${COMMAND}`, 240000);
    const errors = await page.getByTestId('error-card').allInnerTexts();
    record('real 真实模型调用 bash，命令跑在 Git Bash 里，没有错误卡',
      cards.some((card) => ranInGitBash(card, git.root)) && errors.length === 0,
      `${cards.map((card) => `${card.verb}/${card.status}: ${card.text}`).join(' | ') || '(no card)'}`
        + (errors.length ? `；错误：${oneLine(errors.join(' | '))}` : ''));
    checkLog('real', log, gitLine(git.root, 'from git\\.exe on PATH'));
  } catch (error) {
    record('real 流程', false, oneLine(error, 300));
  } finally {
    await app.close().catch(() => {});
  }
  checkSettings('real', userData);
  rmSync(emptyDir, { recursive: true, force: true });
}

try {
  await (real ? realRun() : synthetic());
} catch (error) {
  record(real ? 'real 准备' : '准备', false, oneLine(error, 300));
}
const suffix = exePath ? '-packaged' : '';
process.exitCode = recorder.write(`m0-shell${real ? '-real' : ''}${suffix}.json`) ? 0 : 1;
