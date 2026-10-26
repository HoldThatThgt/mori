// 界面测试共用的小工具：启动 Mori、准备临时项目、复制走查用的数据目录、记录检查结果。
// 走查数据目录里的 key 是 Mori 加密保存的密文；这里只复制文件，从不读取或打印 key。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
 * @brief 启动 Mori：exePath 为空时启动开发构建——默认是 out/；环境变量 MORI_APP_DIR 给出另一个构建目录时用它
 *        （tb-build.mjs 建的 .tb-runs/<名字>，几组 TaskBoard 套件同时开发时各用自己的构建，不互相覆盖）。
 */
export function launch({ exePath, userData, env = {} }) {
  const fullEnv = { ...process.env, MORI_USER_DATA: userData, ...env };
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
  writeFileSync(join(project, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n'
    + '  return a + b;\n}\n');
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
    api: provider.api, model: provider.models[0].id,
    ref: `${provider.id}/${provider.models[0].id}`,
    contextWindow: provider.models[0].contextWindow,
    models: provider.models.map((model) => model.id), keys: provider.keys.map((key) => key.ref) }));
}

/**
 * @brief 测试准备（规格 §14.1，synthetic test setup）：在复制出的 model-config.json 里建一个分组
 *        [DeepSeek 提供商, GLM 提供商]（只有一个时就是它）作为默认范围。之后的界面操作照常。返回用到的提供商（同 realProviders）。
 *        2026-10-26 起没有网络区域（负责人走查 M3），不再给临时项目授权公网。
 * @param userData scratchUserData 复制出的数据目录
 */
export function useRealGroup(userData) {
  const file = join(userData, 'model-config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const providers = realProviders(userData).slice(0, 2);
  config.groups = config.groups.filter((group) => group.id !== REAL_GROUP);
  config.groups.push({ id: REAL_GROUP, members: providers.map((item) => item.provider) });
  config.normalDefault = REAL_GROUP;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return providers;
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
 * @brief 系统剪贴板现在能不能用：经主进程的 clipboard 写进 text 再读回。会话锁屏时（LogonUI 在运行）Windows 拒绝
 *        所有进程打开剪贴板，读回的是空的，与 Mori 无关（docs/v0/english-ui-checks.md 第二轮，
 *        docs/v1/walkthrough-1026/regression.md）。读回一致时剪贴板里留着 text，调用方把它当"剪贴板原来的内容"。
 * @param app Playwright 的 ElectronApplication
 * @param text 写进剪贴板的文字
 * @return 能用时 null；不能用时 { locked: 会话是否锁屏（LogonUI 在运行）, detail: 说明的一行 }
 */
export async function clipboardBlocked(app, text) {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  const back = await app.evaluate(({ clipboard }) => clipboard.readText());
  if (back === text) return null;
  const locked = execFileSync('tasklist', ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH'], { encoding: 'utf8' })
    .includes('LogonUI.exe');
  return { locked, detail: `system clipboard unusable: wrote "${text}", read back "${back}"; `
    + `LogonUI running (session locked): ${locked}${locked ? ' (environment, not Mori)' : ''}` };
}

/**
 * @brief 找到后台进程（utilityProcess）的 PID。Playwright 在 Windows 上经 cmd.exe 启动程序，所以要在整棵进程树里找。
 *        与 m0-smoke.mjs 相同。
 */
export function kernelPid(rootPid) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { '
    + '"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }';
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
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'sleep.exe\'" | ForEach-Object { '
    + '"$($_.ProcessId)|$($_.CommandLine)" }';
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
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { '
    + '"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
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
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { '
    + '"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
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
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { '
    + '"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
  const all = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/);
  return pids.map((pid) => {
    const row = all.find((r) => r.startsWith(`${pid}|`)) ?? `${pid}|?`;
    const parent = row.split('|')[1];
    const prow = all.find((r) => r.startsWith(`${parent}|`)) ?? `${parent}|(gone)`;
    return `${row.slice(0, 120)} inJob=${inJob(pid)} parent=[${prow.slice(0, 100)}]`;
  });
}

