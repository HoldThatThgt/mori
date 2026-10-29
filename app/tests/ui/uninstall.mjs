// 卸载时问要不要删掉 Mori 的数据（docs/v0/screens/uninstall.md，2026-10-28 U75）：另打一个产品名不同的安装包（不压缩），
// 装到临时目录，查状态表的每一行：装新版本到旧版本上、静默卸载都不删数据；卸载向导欢迎页之后那一页的文字、默认不勾与按钮
// （Win32 消息，uninstall-ui.ps1）；不勾卸载留下两个数据文件夹；勾上（再 < Back 回来勾选照旧）卸载删掉两个
// 数据文件夹，不动项目文件夹。
// 安装包的产品名、appId 与包名都和 Mori 不同：数据文件夹是 %APPDATA%\Mori Uninstall Test 与 %LOCALAPPDATA%\Mori Uninstall
// Test，卸载项按 appId 另记，碰不到装着的 Mori；测试前后比对真的 %APPDATA%\Mori、%LOCALAPPDATA%\Mori 一项都没少（Mori 开着时
// 自己会建、删的锁文件与数据库日志除外）、model-config.json 与 credentials.json 没变。会弹出卸载向导的窗口。
// 用法：node tests/ui/uninstall.mjs（先 npm run build；npm run test:uninstall 会先构建）
// 结果写到 test-results/uninstall.json；任何一项失败时退出码为 1。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '../..');
const PRODUCT = 'Mori Uninstall Test';
const APP_ID = 'com.holdthatthgt.mori.uninstall-test';
const PACKAGE = 'mori-uninstall-test';
const distDir = join(appRoot, 'test-results', 'uninstall-dist');
const roamingDir = join(process.env.APPDATA, PRODUCT);
const localDir = join(process.env.LOCALAPPDATA, PRODUCT);
/** 那一页上必须有的文字（ui-strings.md“卸载向导”），两个文件夹的路径另查 */
const PAGE_TEXTS = [
  'Your Mori data',
  'Choose whether to delete it along with Mori.',
  'Mori keeps your settings, saved API keys, sessions, memory and file snapshots in these folders:',
  'Uninstalling keeps them, so installing Mori again picks up where you left off.',
  'This can’t be undone. Files in your project folders aren’t changed.',
];
/** Mori 开着时自己会建、删的文件：比对真的数据文件夹时不算少了 */
const TRANSIENT = /^(lockfile|.*-journal|.*-wal|.*\.tmp.*)$/i;
const results = { target: PRODUCT, checks: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @brief 记录一项检查。 */
function record(name, ok, detail = '') {
  results.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** @brief 跑一段 PowerShell，返回去掉首尾空白的标准输出（UTF-8）。 */
function powershell(script) {
  const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
  return execFileSync('powershell', ['-NoProfile', '-Command', utf8 + script], { encoding: 'utf8' }).trim();
}

/** @brief 用 electron-builder 另打一个安装包（产品名、appId、包名都不同，不压缩），返回安装程序的路径。 */
function buildInstaller() {
  rmSync(distDir, { recursive: true, force: true });
  const cli = join(appRoot, 'node_modules', 'electron-builder', 'cli.js');
  const overrides = [`-c.productName=${PRODUCT}`, `-c.appId=${APP_ID}`, `-c.extraMetadata.name=${PACKAGE}`,
    '-c.directories.output=test-results/uninstall-dist', '-c.compression=store'];
  const run = spawnSync(process.execPath, [cli, '--win', 'nsis', '--publish', 'never', ...overrides],
    { cwd: appRoot, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`electron-builder failed: ${`${run.stdout}${run.stderr}`.slice(-3000)}`);
  const setup = readdirSync(distDir).find((name) => name.startsWith(`${PRODUCT} Setup`) && name.endsWith('.exe'));
  if (!setup) throw new Error(`no installer in ${distDir}`);
  return join(distDir, setup);
}

const appExe = (dir) => join(dir, `${PRODUCT}.exe`);
const uninstaller = (dir) => join(dir, `Uninstall ${PRODUCT}.exe`);

/** @brief 静默安装到 dir（只为当前用户），返回退出码；dir 不能有空格（NSIS 的 /D= 不认引号）。 */
function install(setup, dir) {
  return spawnSync(setup, ['/S', '/currentuser', `/D=${dir}`], { stdio: 'ignore', timeout: 300000 }).status;
}

/**
 * @brief 等卸载整个做完：安装目录没了（最后一步 RMDir /r），“设置 → 应用”里的卸载项也没了，最多 ms 毫秒。卸载程序把自己
 *        复制到临时目录再运行，原来的进程马上退出；只等程序文件没了就往下走时，下一次安装会和还在删目录的卸载撞在一起
 *        （2026-10-28 第一次跑时，下一轮装上的程序被删掉）。
 */
async function waitRemoved(dir, ms = 90000) {
  const deadline = Date.now() + ms;
  while (existsSync(dir) && Date.now() < deadline) await sleep(300);
  while (uninstallEntries() > 0 && Date.now() < deadline) await sleep(500);
  return !existsSync(dir) && uninstallEntries() === 0;
}

/** @brief 两个数据文件夹和项目文件夹里放的文件（synthetic，只是测试的数据）。 */
function seededFiles(project) {
  return [join(roamingDir, 'model-config.json'), join(roamingDir, 'pi', 'sessions', 'synthetic.jsonl'),
    join(localDir, 'snapshots', 'synthetic.blob'), join(project, '.mori', 'models.json')];
}

/** @brief 放好测试的数据。 */
function seed(project) {
  for (const file of seededFiles(project)) {
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, '{"synthetic":true}\n');
  }
}

/** @brief 放的文件里不在了的。 */
function missing(project) {
  return seededFiles(project).filter((file) => !existsSync(file));
}

/** @brief “设置 → 应用”里这个测试安装包的卸载项个数（HKCU 的 Uninstall 下 DisplayName 以产品名开头的）。 */
function uninstallEntries() {
  return Number(powershell("@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | "
    + `Get-ItemProperty | Where-Object { $_.DisplayName -like '${PRODUCT} *' }).Count`));
}

/** @brief 桌面快捷方式的路径（桌面可能被 OneDrive 挪走，按系统给的位置）。 */
function desktopShortcut() {
  return join(powershell("[Environment]::GetFolderPath('Desktop')"), `${PRODUCT}.lnk`);
}

/** @brief 真的 Mori 数据：两个文件夹的顶层项（不存在时 null）与 model-config.json、credentials.json 的内容。 */
function realData() {
  const list = (dir) => (existsSync(dir) ? readdirSync(dir) : null);
  const text = (name) => {
    const file = join(process.env.APPDATA, 'Mori', name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  return { roaming: list(join(process.env.APPDATA, 'Mori')), local: list(join(process.env.LOCALAPPDATA, 'Mori')),
    config: text('model-config.json'), credentials: text('credentials.json') };
}

/** @brief 测试前后真的 Mori 数据不一样的地方（少了的顶层项，不算 TRANSIENT；两个文件的内容）。 */
function realDataProblems(before, after) {
  const lost = (key, label) => (before[key] ?? []).filter((name) => !TRANSIENT.test(name)
    && !(after[key] ?? []).includes(name)).map((name) => `${label}\\Mori\\${name} is gone`);
  return [...lost('roaming', '%APPDATA%'), ...lost('local', '%LOCALAPPDATA%'),
    ...(before.config === after.config ? [] : ['model-config.json changed']),
    ...(before.credentials === after.credentials ? [] : ['credentials.json changed'])];
}

/**
 * @brief 从卸载向导卸载：运行卸载程序（不带 /S），由 uninstall-ui.ps1 读页面、按 check 勾选、点到 Finish，返回它的结果。
 */
function runWizard(dir, check) {
  spawn(uninstaller(dir), [], { detached: true, stdio: 'ignore' }).unref();
  const driver = join(appRoot, 'tests', 'ui', 'uninstall-ui.ps1');
  const run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver, '-Product', PRODUCT,
    ...(check ? ['-Check'] : [])], { encoding: 'utf8', timeout: 240000 });
  const line = run.stdout.trim().split(/\r?\n/).pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return { error: `driver output: ${`${run.stdout}${run.stderr}`.slice(-600)}` };
  }
}

/**
 * @brief 状态表“装新版本到旧版本上”“静默卸载”两行：装好、放数据，同一个安装包再静默装一次（旧版本的卸载程序带
 *        /S --updated 运行），之后 Uninstall <产品名>.exe /S；两次都不出那一页（静默），两个数据文件夹都不删。
 */
async function updateAndSilent(setup, dir, project) {
  const first = install(setup, dir);
  seed(project);
  const again = install(setup, dir);
  const kept = missing(project);
  record('装新版本到旧版本上（同一个安装包再静默装一次，旧版本的卸载程序带 /S --updated 运行）：两个数据文件夹都不删',
    first === 0 && again === 0 && existsSync(appExe(dir)) && kept.length === 0,
    `安装的退出码 ${first}、${again}；程序在=${existsSync(appExe(dir))}；少了：${kept.join(', ') || '无'}`);
  const code = spawnSync(uninstaller(dir), ['/S'], { stdio: 'ignore' }).status;
  const removed = await waitRemoved(dir);
  const left = missing(project);
  record('静默卸载（Uninstall <产品名>.exe /S）：程序删掉，两个数据文件夹都不删', code === 0 && removed && left.length === 0,
    `退出码 ${code}；程序删掉=${removed}；少了：${left.join(', ') || '无'}`);
}

/** @brief 状态表“Mori 的数据”一行：欢迎页没有勾选框、按钮 Next >；那一页的文字、两个文件夹的路径、默认不勾、三个按钮。 */
function pageChecks(ui) {
  const page = ui.page ?? {};
  const texts = page.texts ?? [];
  const absent = [...PAGE_TEXTS, roamingDir, localDir].filter((text) => !texts.includes(text));
  record('卸载向导：欢迎页没有勾选框、按钮是“Next >”', ui.welcome?.boxes === 0 && ui.welcome.next === 'Next >',
    JSON.stringify(ui.welcome ?? ui.error));
  record('Mori 的数据（欢迎页之后的一页）：标题“Your Mori data”、副标题、说明、两个文件夹展开后的路径、最后一行与勾选框下'
    + '的一行；勾选框“Also delete my Mori data”第一次进来不勾；按钮“Uninstall”“< Back”“Cancel”',
  absent.length === 0 && page.box === 'Also delete my Mori data' && page.state === 'Off' && page.next === 'Uninstall'
    && page.back === '< Back' && page.cancel === 'Cancel',
  `缺的文字：${absent.join(' | ') || '无'}；${JSON.stringify({ ...page, texts: undefined, error: ui.error })}`);
}

/** @brief 卸载做完之后程序、桌面快捷方式、卸载项都没了；返回不对的地方。 */
async function programProblems(dir) {
  const removed = await waitRemoved(dir);
  const entries = uninstallEntries();
  const shortcut = existsSync(desktopShortcut());
  return [...(removed ? [] : ['program still there']), ...(entries === 0 ? [] : [`${entries} uninstall entries`]),
    ...(shortcut ? ['desktop shortcut still there'] : [])];
}

/** @brief 状态表“Mori 的数据”“不勾，卸载”两行：装好、放数据，从卸载向导卸载，不勾。 */
async function wizardKeeps(setup, dir, project) {
  const code = install(setup, dir);
  seed(project);
  const shortcut = existsSync(desktopShortcut());
  const ui = runWizard(dir, false);
  pageChecks(ui);
  const problems = await programProblems(dir);
  const left = missing(project);
  record('不勾，卸载：删掉程序、桌面快捷方式和“设置 → 应用”里的这一项，两个数据文件夹原样留着；最后一页“Finish”',
    code === 0 && shortcut && ui.finish === 'Finish' && problems.length === 0 && left.length === 0,
    `安装的退出码 ${code}；装后有快捷方式=${shortcut}；finish=${ui.finish}；${problems.join(', ') || '程序都删了'}；`
    + `少了：${left.join(', ') || '无'}；${ui.error ?? ''}`);
}

/** @brief 状态表“勾上，卸载”一行与那一页的 < Back：勾上、Back 再回来勾选照旧，卸载后两个数据文件夹整个删掉。 */
async function wizardDeletes(setup, dir, project) {
  const code = install(setup, dir);
  seed(project);
  const ui = runWizard(dir, true);
  record('那一页勾上后点“< Back”回到欢迎页、再点“Next >”回来：勾选照旧', ui.back?.checked === 'On'
    && ui.back.afterBack === 'On', JSON.stringify(ui.back ?? ui.error));
  const problems = await programProblems(dir);
  const projectFile = seededFiles(project)[3];
  const gone = !existsSync(roamingDir) && !existsSync(localDir);
  record('勾上，卸载：两个数据文件夹整个删掉，程序、快捷方式与卸载项也删掉；项目文件夹里的 .mori 不动；最后一页“Finish”',
    code === 0 && ui.finish === 'Finish' && gone && problems.length === 0 && existsSync(projectFile),
    `安装的退出码 ${code}；finish=${ui.finish}；%APPDATA% 的在=${existsSync(roamingDir)}，%LOCALAPPDATA% 的在=`
    + `${existsSync(localDir)}；${problems.join(', ') || '程序都删了'}；项目的在=${existsSync(projectFile)}；`
    + `${ui.error ?? ''}`);
}

/** @brief 收尾：没卸掉的测试安装静默卸掉（_?= 在原处运行、等它做完），关掉留下的卸载向导，删掉测试的数据与临时目录。 */
function cleanUp(dir, work) {
  powershell(`Get-Process | Where-Object { $_.MainWindowTitle -eq '${PRODUCT} Uninstall' } | Stop-Process -Force`);
  if (existsSync(appExe(dir))) spawnSync(uninstaller(dir), ['/S', `_?=${dir}`], { stdio: 'ignore' });
  for (const folder of [roamingDir, localDir]) rmSync(folder, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

const real = realData();
const work = mkdtempSync(join(tmpdir(), 'mori-uninstall-'));
const dir = join(work, 'app');
const project = join(work, 'project');
try {
  if (/\s/.test(dir)) throw new Error(`the temp folder has spaces, NSIS /D= can't take it: ${dir}`);
  for (const folder of [roamingDir, localDir]) rmSync(folder, { recursive: true, force: true });
  const setup = buildInstaller();
  await updateAndSilent(setup, dir, project);
  await wizardKeeps(setup, dir, project);
  await wizardDeletes(setup, dir, project);
} catch (error) {
  record('卸载测试的流程', false, String(error?.stack ?? error).slice(0, 600));
} finally {
  cleanUp(dir, work);
}
const problems = realDataProblems(real, realData());
record('真的 Mori 数据没被碰到：%APPDATA%\\Mori、%LOCALAPPDATA%\\Mori 一项都没少，model-config.json 与 credentials.json 没变',
  problems.length === 0, problems.join('; ') || `顶层 ${real.roaming?.length ?? '无'} 项、${real.local?.length ?? '无'} 项`);
mkdirSync(join(appRoot, 'test-results'), { recursive: true });
writeFileSync(join(appRoot, 'test-results/uninstall.json'), `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.checks.every((check) => check.ok) ? 0 : 1;
