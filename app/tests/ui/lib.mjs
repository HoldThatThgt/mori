// 界面测试共用的小工具：启动 Mori（数据目录与快照目录都指到测试目录）、准备临时项目、复制走查用的数据目录、记录检查结果。
// 走查数据目录里的 key 是 Mori 加密保存的密文；这里只复制文件，从不读取或打印 key。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import koffi from 'koffi';

export const appRoot = resolve(import.meta.dirname, '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const oneLine = (text, max = 200) => String(text).replace(/\s+/g, ' ').slice(0, max);

/** @brief 读取命令行参数 --name 的值。 */
export function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

/**
 * @brief 测试数据目录配的快照目录（docs/specs/file-system.md §4.1、§19.4）：数据目录旁边的 <数据目录>-snapshots。
 *        不放进数据目录里（有的套件递归读数据目录的文件），同一个数据目录重启后仍是同一处；路径短（内部仓库在它下面再加
 *        projectDirName 的编码，git 不收接近 250 字符的 --git-dir）。测试不往真的 %LOCALAPPDATA%\Mori\snapshots 写。
 * @param userData 测试的数据目录（MORI_USER_DATA）
 */
export function snapshotsDirFor(userData) {
  return `${resolve(userData)}-snapshots`;
}

/**
 * @brief 删掉测试数据目录和它旁边的快照目录（snapshotsDirFor；launch 让 Mori 在那里建内部仓库）。Mori 或 git 子进程
 *        刚退出时文件可能还占着，多试几次；仍删不掉时打印一行，不抛错（不盖过检查结果和退出码）。
 * @param userData 测试的数据目录（MORI_USER_DATA）
 */
export function removeUserData(userData) {
  for (const dir of [userData, snapshotsDirFor(userData)]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      console.error(`cannot remove ${dir}: ${oneLine(error)}`);
    }
  }
}

/**
 * @brief 启动 Mori：exePath 为空时启动开发构建——默认是 out/；环境变量 MORI_APP_DIR 给出另一个构建目录时用它
 *        （tb-build.mjs 建的 .tb-runs/<名字>，几组 TaskBoard 套件同时开发时各用自己的构建，不互相覆盖）。
 *        MORI_USER_DATA 指向 userData，MORI_SNAPSHOTS_DIR 指向它旁边的快照目录（snapshotsDirFor）；env 里另给的
 *        （例如 fs-helpers.mjs 自己建的快照目录）盖过它们。
 */
export function launch({ exePath, userData, env = {} }) {
  const fullEnv = { ...process.env, MORI_USER_DATA: userData, MORI_SNAPSHOTS_DIR: snapshotsDirFor(userData),
    ...env };
  const appDir = process.env.MORI_APP_DIR ? resolve(process.env.MORI_APP_DIR) : appRoot;
  return electron.launch(exePath
    ? { executablePath: exePath, env: fullEnv }
    : { args: [appDir], cwd: appDir, env: fullEnv });
}

/** @brief 准备一个带 README 和一个源文件的临时项目。 */
export function prepareProject(prefix = 'mori-m1-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'),
    '# Mori fixture project\n\nThis folder is used to check Mori against a model.\n\n' +
    '- It has one README file.\n- It has one source file in src/.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return { root, project };
}

/**
 * @brief 把走查数据目录里的模型配置复制到新的临时目录：credentials.json（密文）、model-config.json、model-profiles.json、
 *        pi/models.json（v0 留下的，有的话；v1 不再读写它）、pi/settings.json，以及 Electron 的 Local State（safeStorage
 *        的密钥由 DPAPI 保护，存在这里；没有它解不开密文）。
 * @param source 由负责人在 Mori（v1）里保存过提供商的数据目录（例如 %TEMP%\mori-real-data）
 * @param options.withKey 为 false 时不复制 credentials.json 与 Local State（v1 里没有 key 的提供商请求不带认证头）
 */
export function scratchUserData(source, { withKey = true } = {}) {
  const target = mkdtempSync(join(tmpdir(), 'mori-m1-data-'));
  mkdirSync(join(target, 'pi'), { recursive: true });
  if (withKey) {
    copyFileSync(join(source, 'credentials.json'), join(target, 'credentials.json'));
    copyFileSync(join(source, 'Local State'), join(target, 'Local State'));
  }
  for (const name of ['model-config.json', 'model-profiles.json']) {
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(target, name));
  }
  for (const name of ['models.json', 'settings.json']) {
    const from = join(source, 'pi', name);
    if (existsSync(from)) copyFileSync(from, join(target, 'pi', name));
  }
  return target;
}

/** 测试准备（§14.1）给真实提供商建的默认分组 id */
export const REAL_GROUP = 'real-providers';

/** @brief 项目路径的规范化写法（规格 §4.1 projectZones 的键）：全部小写、/ 分隔、无结尾 /。 */
export function projectKey(path) {
  return resolve(path).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * @brief 读数据目录里 model-config.json 的提供商（只读非机密部分：id、名称、地址、模型）；按 DeepSeek、GLM、其余的
 *        顺序排。没有提供商时报错（数据目录要先用 v1 打开一次，§14.1）。
 */
export function realProviders(dir) {
  const file = join(dir, 'model-config.json');
  if (!existsSync(file)) throw new Error(`No model-config.json in ${dir}; open it with Mori v1 first`);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const rank = (provider) => (/deepseek/i.test(provider.baseUrl) ? 0 : /bigmodel|glm|zhipu/i.test(provider.baseUrl)
    ? 1 : 2);
  const providers = [...config.providers].sort((a, b) => rank(a) - rank(b));
  if (providers.length === 0) throw new Error(`No providers in ${join(dir, 'model-config.json')}`);
  return providers.map((provider) => ({ provider: provider.id, name: provider.name, baseUrl: provider.baseUrl,
    api: provider.api, zone: provider.zone, model: provider.models[0].id,
    ref: `${provider.id}/${provider.models[0].id}`,
    contextWindow: provider.models[0].contextWindow,
    models: provider.models.map((model) => model.id), keys: provider.keys.map((key) => key.ref) }));
}

/**
 * @brief 测试准备（规格 §14.1，synthetic test setup）：在复制出的 model-config.json 里给临时项目授权公网
 *        （projectZones[项目] = ["public"]），建一个分组 [DeepSeek 提供商, GLM 提供商]（只有一个时就是它）作为默认范围。
 *        之后的界面操作照常。返回用到的提供商（同 realProviders）。
 * @param userData scratchUserData 复制出的数据目录
 * @param projects 要授权的临时项目文件夹（一个或多个）
 */
export function allowRealProject(userData, projects) {
  const file = join(userData, 'model-config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const providers = realProviders(userData).slice(0, 2);
  for (const project of [projects].flat()) config.projectZones[projectKey(project)] = ['public'];
  config.groups = config.groups.filter((group) => group.id !== REAL_GROUP);
  config.groups.push({ id: REAL_GROUP, members: providers.map((item) => item.provider) });
  config.normalDefault = REAL_GROUP;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return providers;
}

/**
 * @brief 测试准备（规格 §14.1，synthetic test setup）：Mori 已经启动之后才建的临时项目，经进程桥直接发
 *        models.setProjectZones 授权公网（与 allowRealProject 写的是同一个字段；Mori 运行时配置在后台进程里，改文件不生效）。
 *        不经界面，也不进录制器（录制器只记 rec.cmd 发的命令）。
 * @param page Mori 的页面
 * @param projects 项目文件夹（一个或多个）
 */
export async function allowProjectsLive(page, projects) {
  for (const path of [projects].flat()) {
    const result = await page.evaluate((cwd) => window.mori.request({ type: 'models.setProjectZones', path: cwd,
      zones: ['public'] }), path);
    if (result?.error) throw new Error(`cannot allow public for ${path}: ${result.error}`);
  }
}

/**
 * @brief 测试准备：改复制出的 model-config.json（只用于临时数据目录）。
 * @param edit 收到解析后的配置，就地修改或返回新的
 */
export function editModelConfig(userData, edit) {
  const file = join(userData, 'model-config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, `${JSON.stringify(edit(config) ?? config, null, 2)}\n`);
}

/** @brief 检查结果收集器；known 表示已知的上游问题，失败时标 KNOWN，不计入退出码。 */
export function createRecorder(target) {
  const results = { target, checks: [] };
  return {
    results,
    record(name, ok, detail = '', known = false) {
      results.checks.push({ name, ok, detail, known });
      const label = ok ? 'PASS' : known ? 'KNOWN' : 'FAIL';
      console.log(`${label} ${name}${detail ? ` — ${oneLine(detail, 400)}` : ''}`);
    },
    write(file) {
      mkdirSync(join(appRoot, 'test-results'), { recursive: true });
      writeFileSync(join(appRoot, 'test-results', file), `${JSON.stringify(results, null, 2)}\n`);
      return results.checks.every((c) => c.ok || c.known);
    },
  };
}

/**
 * @brief 找到后台进程（utilityProcess）的 PID。Playwright 在 Windows 上经 cmd.exe 启动程序，所以要在整棵进程树里找。
 *        与 m0-smoke.mjs 相同。
 */
export function kernelPid(rootPid) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }';
  const rows = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).filter(Boolean).map((line) => line.split('|'));
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of rows) {
      if (tree.has(Number(parent)) && !tree.has(Number(pid))) { tree.add(Number(pid)); grew = true; }
    }
  }
  const kernel = rows.find(([pid, , command]) => tree.has(Number(pid)) && command?.includes('node.mojom.NodeService'));
  if (!kernel) throw new Error('kernel process not found');
  return Number(kernel[0]);
}

/** @brief 结束后台进程（模拟在任务管理器里结束它）。 */
export function killKernel(app) {
  const pid = kernelPid(app.process().pid);
  execFileSync('taskkill', ['/PID', String(pid), '/F']);
  return pid;
}

/**
 * @brief 测试自己启动的 sleep.exe 的 PID：只认命令行是 `sleep <秒数>` 且秒数在 durations 里的。
 *        测试用少见的秒数（37、127 等），机器上别的程序（例如开发时的等待脚本）运行的 sleep 不会被算进来。
 */
export function sleepProcessIds(durations) {
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'sleep.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }';
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map((line) => line.split('|'))
    .filter(([, command]) => durations.includes(command?.trim().split(/\s+/).pop() ?? ''))
    .map(([pid]) => pid);
}

/** @brief 等到 pids 里的进程都不在了，最多 timeoutMs；返回还在的。 */
export async function waitGone(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let left = stillAlive(pids.map(Number));
  while (left.length && Date.now() < deadline) {
    await sleep(250);
    left = stillAlive(pids.map(Number));
  }
  return left;
}

/** @brief 全部进程：PID、父 PID、名字、命令行。 */
function processRowsAll() {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).filter(Boolean).map((line) => line.split('|'));
}

/** @brief rootPid 及其全部子孙进程的 PID 和名字。 */
export function processTree(rootPid) {
  const rows = processRowsAll();
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of rows) {
      if (tree.has(Number(parent)) && !tree.has(Number(pid))) { tree.add(Number(pid)); grew = true; }
    }
  }
  return rows.filter(([pid]) => tree.has(Number(pid))).map(([pid, , name]) => ({ pid: Number(pid), name }));
}

/** @brief pids 里还活着的进程。 */
export function stillAlive(pids) {
  const alive = new Set(processRowsAll().map(([pid]) => Number(pid)));
  return pids.filter((pid) => alive.has(pid));
}

/** @brief Mori 主进程（浏览器进程）的 PID：进程树里没有 --type= 参数的那个 Electron 进程。 */
export function mainPid(rootPid) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
  const rows = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).filter(Boolean).map((line) => line.split('|'));
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of rows) {
      if (tree.has(Number(parent)) && !tree.has(Number(pid))) { tree.add(Number(pid)); grew = true; }
    }
  }
  const main = rows.find(([pid, , name, command]) => tree.has(Number(pid)) && /^(electron|mori)\.exe$/i.test(name)
    && !command?.includes('--type='));
  if (!main) throw new Error('main process not found');
  return Number(main[0]);
}

/** @brief 诊断用：进程、父进程、是否在某个作业里。 */
const kernel32 = koffi.load('kernel32.dll');
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32_t, bool, uint32_t)');
const IsProcessInJob = kernel32.func('bool __stdcall IsProcessInJob(void*, void*, _Out_ bool*)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)');
function inJob(pid) {
  const h = OpenProcess(0x1000, false, Number(pid)); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!h) return 'cannot open';
  const out = [false];
  IsProcessInJob(h, null, out);
  CloseHandle(h);
  return out[0];
}
export function describeProcesses(pids) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
  const all = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 }).split(/\r?\n/);
  return pids.map((pid) => {
    const row = all.find((r) => r.startsWith(`${pid}|`)) ?? `${pid}|?`;
    const parent = row.split('|')[1];
    const prow = all.find((r) => r.startsWith(`${parent}|`)) ?? `${parent}|(gone)`;
    return `${row.slice(0, 120)} inJob=${inJob(pid)} parent=[${prow.slice(0, 100)}]`;
  });
}

