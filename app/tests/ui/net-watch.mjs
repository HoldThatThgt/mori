// 冒烟测试辅助：每 300 毫秒用 netstat 采样指定进程树的 TCP 连接，进程树每 2 秒刷新一次。
// 只是近似检查：存在时间不足 300 毫秒的连接可能漏掉，DNS 查询也不在其中。

import { execFile } from 'node:child_process';

const LOOPBACK = /^(127\.0\.0\.1|\[::1\]):/;
const UNBOUND = /^(0\.0\.0\.0|\[::\]|\*):/;

/** @brief 运行一条命令，返回标准输出。 */
function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout));
  });
}

/** @brief 取 rootPid 及其全部子孙进程的 PID。 */
async function processTree(rootPid) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
  const out = await run('powershell', ['-NoProfile', '-Command', script]);
  const pairs = out.split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(' ').map(Number));
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of pairs) {
      if (tree.has(parent) && !tree.has(pid)) { tree.add(pid); grew = true; }
    }
  }
  return tree;
}

/** @brief 开始采样；返回收集结果与停止函数。 */
export function startNetWatch(rootPid) {
  const seen = { samples: 0, loop: new Set(), ext: new Set(), errors: [] };
  let tree = new Set([rootPid]);
  let stopped = false;
  const refreshTree = async () => {
    while (!stopped) {
      try { tree = await processTree(rootPid); } catch (error) { seen.errors.push(String(error)); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  const sample = async () => {
    while (!stopped) {
      try {
        const out = await run('netstat', ['-ano', '-p', 'TCP']);
        for (const line of out.split(/\r?\n/)) {
          const [proto, , remote, , pid] = line.trim().split(/\s+/);
          if (proto !== 'TCP' || !tree.has(Number(pid)) || UNBOUND.test(remote)) continue;
          (LOOPBACK.test(remote) ? seen.loop : seen.ext).add(remote);
        }
        seen.samples += 1;
      } catch (error) {
        seen.errors.push(String(error));
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  void refreshTree();
  void sample();
  return { seen, stop: () => { stopped = true; } };
}
