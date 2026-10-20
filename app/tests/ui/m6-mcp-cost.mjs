// 测量"打开很多会话时 MCP 的内存与进程"（M6 先确认的第 4 条，见 docs/v0/m6-checks.md）：
// 用户级 mcp.json 里放 servers 个合成 MCP 服务（tests/mcp-server/server.mjs，synthetic），依次打开 1、5、10 个会话，
// 每次等服务连上后数 Mori 进程树里的进程，记下后台进程和 MCP 服务进程的内存（工作集）。
// 会话不发消息（不用模型），连接只靠 pi 的 MCP 扩展在 session_start 时自己连。
// 用法（在 app/ 下，先 npm run build）：node tests/ui/m6-mcp-cost.mjs [--servers 1] [--exe <Mori.exe>]

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRoot, arg, createRecorder, kernelPid, launch, sleep } from './lib.mjs';

const servers = Number(arg('servers') ?? 1);
const exePath = arg('exe');
const COUNTS = [1, 5, 10];

/** @brief 全部进程：PID、父 PID、名字、工作集（字节）。 */
function processRows() {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.WorkingSetSize)" }';
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).filter(Boolean).map((line) => line.split('|'))
    .map(([pid, parent, name, ws]) => ({ pid: Number(pid), parent: Number(parent), name, ws: Number(ws) }));
}

/** @brief rootPid 的全部子孙进程（不含它自己）。 */
function descendants(rows, rootPid) {
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.parent) && !tree.has(row.pid)) { tree.add(row.pid); grew = true; }
    }
  }
  tree.delete(rootPid);
  return rows.filter((row) => tree.has(row.pid));
}

/** @brief 一次采样：后台进程自己的工作集，以及它启动的全部子进程（按名字计数、合计工作集）。 */
function sample(kernel) {
  const rows = processRows();
  const self = rows.find((row) => row.pid === kernel);
  const children = descendants(rows, kernel);
  const byName = {};
  for (const child of children) byName[child.name] = (byName[child.name] ?? 0) + 1;
  const mb = (bytes) => Math.round(bytes / 1048576);
  return { kernelMb: mb(self?.ws ?? 0), childCount: children.length, byName,
    childMb: mb(children.reduce((sum, row) => sum + row.ws, 0)) };
}

/** @brief 准备数据目录：一个不用 key 的连接（合成端点地址，不会真的请求）和 servers 个直接调用的合成 MCP 服务。 */
function prepare() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-cost-'));
  const agentDir = join(root, 'data', 'pi');
  mkdirSync(agentDir, { recursive: true });
  const mcpServers = {};
  for (let i = 1; i <= servers; i += 1) {
    mcpServers[`cost${i}`] = { command: 'node', args: [join(appRoot, 'tests', 'mcp-server', 'server.mjs')],
      exposure: 'direct' };
  }
  writeFileSync(join(agentDir, 'mcp.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  return { userData: join(root, 'data'), project };
}

const recorder = createRecorder(exePath ? 'packaged' : 'dev');
const { userData, project } = prepare();
const app = await launch({ exePath, userData });
const page = await app.firstWindow();
await page.waitForFunction(() => window.mori);
const kernel = kernelPid(app.process().pid);
const baseline = sample(kernel);
console.log(`baseline (no session): ${JSON.stringify(baseline)}`);
let opened = 0;
for (const count of COUNTS) {
  while (opened < count) {
    await page.evaluate((cwd) => window.mori.request({ type: 'session.create', cwd }), project);
    opened += 1;
  }
  await sleep(4000);
  const now = sample(kernel);
  console.log(`${count} session(s), ${servers} server(s): ${JSON.stringify(now)}`);
  recorder.record(`${count} 个会话 × ${servers} 个 MCP 服务`, true, JSON.stringify(now));
}
await app.close();
recorder.results.baseline = baseline;
recorder.write(`m6-mcp-cost${exePath ? '-packaged' : ''}.json`);
