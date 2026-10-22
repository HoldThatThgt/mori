// 测量"打开很多会话时 MCP 的内存与进程"（M6 先确认的第 4 条，见 docs/v0/m6-checks.md），并按共享连接的验收核对进程数
// （docs/v0/m6-mcp-shared.md"怎样验收"第一行，照 Claude 桌面版每个服务一个进程、所有会话共用）：
// 用户级 mcp.json 里放 servers 个合成 MCP 服务（tests/mcp-server/server.mjs，synthetic）。
// Mori 启动时就起用户级启用的 stdio 服务，所以先等到还没有会话时就有 servers 个服务进程（有上限地轮询），记为基线；
// 再依次打开 1、5、10 个会话，每次等每个服务的共享连接显示"Running"且在用的会话数等于打开的会话数（tools.get 的
// mcp.servers[].shared，共享服务表里的真实状态；会话真的挂上了，进程数才有意义），然后数 Mori 后台进程的子孙进程：
// 服务进程（命令行是合成 MCP 服务的 node.exe）的个数等于 servers 才记 PASS；同时照旧打印后台进程和子进程的内存（工作集）。
// 会话不发消息（不用模型），连接只靠 pi 的 MCP 扩展在 session_start 时自己连。
// 退出 Mori 后核对这次见过的服务进程都不在了（"怎样验收"：退出 Mori 不留下进程）；还在的记 FAIL，再按 PID 结束
// （只结束这次的后台进程起的、命令行仍是合成服务的进程）。
// 用法（在 app/ 下，先 npm run build）：node tests/ui/m6-mcp-cost.mjs [--servers 1] [--exe <Mori.exe>]
// 结果写到 test-results/m6-mcp-cost(-packaged)(-<servers>servers).json（servers 为 1 时不加后缀）；临时数据目录在 Mori
// 关闭后删掉。

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRoot, arg, createRecorder, kernelPid, launch, sleep, waitGone } from './lib.mjs';

const servers = Number(arg('servers') ?? 1);
const exePath = arg('exe');
const COUNTS = [1, 5, 10];
/** 合成 MCP 服务（synthetic） */
const MCP_SERVER = join(appRoot, 'tests', 'mcp-server', 'server.mjs');
/** 服务名 cost1…costN */
const NAMES = Array.from({ length: servers }, (_, index) => `cost${index + 1}`);
/** 等服务进程起来、等会话挂上的上限（毫秒） */
const WAIT_MS = 30000;
/** 会话都挂上之后再等一会儿才数进程：如果共享坏了、每个会话另起了进程，也有时间出现 */
const SETTLE_MS = 1500;
/** 一条命令等后台进程回答的上限（毫秒）：后台进程卡住时测试报错，不一直等 */
const REQUEST_MS = 30000;
/** 退出 Mori 后等服务进程结束的上限（毫秒） */
const EXIT_MS = 10000;
/** 这次在后台进程下面见过的服务进程的 PID（退出后核对、清理） */
const seenPids = new Set();

/** @brief 全部进程：PID、父 PID、名字、工作集（字节）、命令行（放在最后，里面可能有"|"）。 */
function processRows() {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { '
    + '"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.WorkingSetSize)|$($_.CommandLine)" }';
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).filter(Boolean).map((line) => line.split('|'))
    .map(([pid, parent, name, ws, ...command]) => ({ pid: Number(pid), parent: Number(parent), name, ws: Number(ws),
      command: command.join('|') }));
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

/** @brief 是不是合成 MCP 服务的进程：node.exe，命令行里有 server.mjs 的路径（cmd.exe、conhost.exe 不算）。 */
function isServerProcess(row) {
  return /^node(\.exe)?$/i.test(row.name) && row.command.toLowerCase().includes(MCP_SERVER.toLowerCase());
}

/**
 * @brief 一次采样：后台进程自己的工作集，它启动的全部子进程（按名字计数、合计工作集），以及其中的服务进程数和 PID。
 */
function sample(kernel) {
  const rows = processRows();
  const self = rows.find((row) => row.pid === kernel);
  const children = descendants(rows, kernel);
  const byName = {};
  for (const child of children) byName[child.name] = (byName[child.name] ?? 0) + 1;
  const mb = (bytes) => Math.round(bytes / 1048576);
  const serverPids = children.filter(isServerProcess).map((row) => row.pid).sort((a, b) => a - b);
  for (const pid of serverPids) seenPids.add(pid);
  return { kernelMb: mb(self?.ws ?? 0), childCount: children.length, byName,
    childMb: mb(children.reduce((sum, row) => sum + row.ws, 0)), serverProcesses: serverPids.length, serverPids };
}

/** @brief 等到服务进程数达到 servers（最多 WAIT_MS），返回最后一次采样和等了多久。 */
async function waitServerProcesses(kernel) {
  const started = Date.now();
  let now = sample(kernel);
  while (now.serverProcesses < servers && Date.now() - started < WAIT_MS) {
    await sleep(500);
    now = sample(kernel);
  }
  return { now, waitedMs: Date.now() - started };
}

/** @brief 发一条命令给后台进程，最多等 REQUEST_MS；超时报错。 */
function moriRequest(page, command) {
  return page.evaluate(({ cmd, ms }) => Promise.race([window.mori.request(cmd), new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${cmd.type} got no answer within ${ms} ms`)), ms);
  })]), { cmd: command, ms: REQUEST_MS });
}

/** @brief tools.get（跟随 sessionId）里各个合成服务的共享连接状态：名字 → shared（没有时为 null）。 */
async function sharedStates(page, sessionId) {
  const info = await moriRequest(page, { type: 'tools.get', sessionId });
  const list = info?.mcp?.servers ?? [];
  return Object.fromEntries(NAMES.map((name) => [name, list.find((item) => item.name === name)?.shared ?? null]));
}

/** @brief 每个服务都是"Running"且在用的会话数为 count。 */
const allShared = (states, count) => NAMES.every((name) => states[name]?.state === 'running'
  && states[name].sessions === count);

/** @brief 等每个服务的共享连接都是"Running · Used by count sessions"（最多 WAIT_MS）；返回最后读到的状态和是否等到了。 */
async function waitSessions(page, sessionId, count) {
  const started = Date.now();
  let states = await sharedStates(page, sessionId);
  while (!allShared(states, count) && Date.now() - started < WAIT_MS) {
    await sleep(500);
    states = await sharedStates(page, sessionId);
  }
  return { states, ok: allShared(states, count) };
}

/** @brief 准备数据目录：一个不用 key 的连接（合成端点地址，不会真的请求）和 servers 个直接调用的合成 MCP 服务。 */
function prepare() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-cost-'));
  const agentDir = join(root, 'data', 'pi');
  mkdirSync(agentDir, { recursive: true });
  const mcpServers = Object.fromEntries(NAMES.map((name) => [name,
    { command: 'node', args: [MCP_SERVER], exposure: 'direct' }]));
  writeFileSync(join(agentDir, 'mcp.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  return { root, userData: join(root, 'data'), project };
}

/** @brief 基线：Mori 启动后、还没有会话时就有 servers 个服务进程（启动时起用户级启用的 stdio 服务）。 */
async function baselineCheck(recorder, kernel) {
  const { now, waitedMs } = await waitServerProcesses(kernel);
  console.log(`baseline (no session, after ${waitedMs} ms): ${JSON.stringify(now)}`);
  recorder.record(`Mori 启动后、还没有会话时：${servers} 个 MCP 服务各有 1 个进程（启动时就起），共 ${servers} 个`,
    now.serverProcesses === servers, JSON.stringify({ waitedMs, ...now }));
  return now;
}

/** @brief 依次打开到 1、5、10 个会话；每次等会话都挂上，再核对服务进程数仍等于 servers、PID 不变。 */
async function sessionChecks(recorder, page, kernel, project, baseline) {
  let opened = 0;
  let last = null;
  for (const count of COUNTS) {
    while (opened < count) {
      last = await moriRequest(page, { type: 'session.create', cwd: project });
      opened += 1;
    }
    const shared = await waitSessions(page, last?.sessionId, count);
    await sleep(SETTLE_MS);
    const now = sample(kernel);
    console.log(`${count} session(s), ${servers} server(s): ${JSON.stringify(now)}`);
    const samePids = JSON.stringify(now.serverPids) === JSON.stringify(baseline.serverPids);
    recorder.record(`${count} 个会话 × ${servers} 个 MCP 服务：每个服务都是"运行中 · ${count} 个会话在用"，`
      + `服务进程仍是 ${servers} 个（就是启动时起的那几个）`, shared.ok && now.serverProcesses === servers && samePids,
    JSON.stringify({ ...now, samePids, shared: shared.states }));
  }
}

/**
 * @brief 退出 Mori 之后：这次见过的服务进程都不在了（最多等 EXIT_MS）。还在的记 FAIL，再按 PID 结束：只结束
 *        PID 在 seenPids 里、命令行仍是合成服务的 node.exe（PID 没有被别的进程重用）。
 */
async function exitCheck(recorder) {
  const left = await waitGone([...seenPids], EXIT_MS);
  const ours = processRows().filter((row) => left.includes(row.pid) && isServerProcess(row));
  recorder.record(`退出 Mori 后：这次见过的 ${seenPids.size} 个服务进程都不在了（不留下进程）`,
    seenPids.size > 0 && ours.length === 0, JSON.stringify({ seen: [...seenPids], left: ours.map((row) => row.pid) }));
  for (const row of ours) {
    try {
      execFileSync('taskkill', ['/PID', String(row.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (error) {
      console.error(`[m6-mcp-cost] cannot end the leftover server ${row.pid}: ${error.message}`);
    }
  }
}

const recorder = createRecorder(exePath ? 'packaged' : 'dev');
const { root, userData, project } = prepare();
const app = await launch({ exePath, userData });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.mori);
  const kernel = kernelPid(app.process().pid);
  const baseline = await baselineCheck(recorder, kernel);
  await sessionChecks(recorder, page, kernel, project, baseline);
  recorder.results.baseline = baseline;
} catch (error) {
  recorder.record('m6-mcp-cost：流程', false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}
await exitCheck(recorder);
const resultFile = `m6-mcp-cost${exePath ? '-packaged' : ''}${servers === 1 ? '' : `-${servers}servers`}.json`;
const passed = recorder.write(resultFile);
const failed = recorder.results.checks.filter((check) => !check.ok).length;
console.log(`[m6-mcp-cost] ${recorder.results.checks.length - failed} passed, ${failed} failed`);
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
  console.error(`[m6-mcp-cost] cannot remove ${root}: ${error.message}`);
}
process.exitCode = passed ? 0 : 1;
