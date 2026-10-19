// 界面测试共用的小工具：启动 Mori、准备临时项目、复制走查用的数据目录、记录检查结果。
// 走查数据目录里的 key 是 Mori 加密保存的密文；这里只复制文件，从不读取或打印 key。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

export const appRoot = resolve(import.meta.dirname, '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const oneLine = (text, max = 200) => String(text).replace(/\s+/g, ' ').slice(0, max);

/** @brief 读取命令行参数 --name 的值。 */
export function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

/** @brief 启动 Mori：exePath 为空时启动开发构建（out/）。 */
export function launch({ exePath, userData, env = {} }) {
  const fullEnv = { ...process.env, MORI_USER_DATA: userData, ...env };
  return electron.launch(exePath
    ? { executablePath: exePath, env: fullEnv }
    : { args: [appRoot], cwd: appRoot, env: fullEnv });
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
 * @brief 把走查数据目录里的连接复制到新的临时目录：credentials.json（密文）、pi/models.json、pi/settings.json，
 *        以及 Electron 的 Local State（safeStorage 的密钥由 DPAPI 保护，存在这里；没有它解不开密文）。
 * @param source 由负责人在 Mori 里填过连接的数据目录（例如 %TEMP%\mori-real-data）
 * @param options.withKey 为 false 时不复制 credentials.json，用来制造"找不到 key"
 */
export function scratchUserData(source, { withKey = true } = {}) {
  const target = mkdtempSync(join(tmpdir(), 'mori-m1-data-'));
  mkdirSync(join(target, 'pi'), { recursive: true });
  if (withKey) {
    copyFileSync(join(source, 'credentials.json'), join(target, 'credentials.json'));
    copyFileSync(join(source, 'Local State'), join(target, 'Local State'));
  }
  for (const name of ['models.json', 'settings.json']) {
    const from = join(source, 'pi', name);
    if (existsSync(from)) copyFileSync(from, join(target, 'pi', name));
  }
  return target;
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
