// 合成 MCP 服务（synthetic）：只用于本地验证 Mori 的工具页、pi 的 MCP 扩展和 Mori 的共享连接，不是真实服务。
// stdio 传输：每行一条 JSON-RPC 2.0 消息（MCP 规范的 stdio 传输），只用 Node 自带的模块，可以离线运行。
// 实现 initialize、ping、tools/list、tools/call、notifications/cancelled；其余请求回 -32601。
// 工具：
//   - echo：原样返回参数 text（"mori-mcp echo: <text>"）。
//   - add：返回 a + b。
// 下面四个只在 MORI_MCP_EXTRA=1 时注册（M6 共享连接的测试用；默认只有 echo 和 add，M6 其他测试按这两个核对）：
//   - pid：返回服务进程的 PID（测几个会话是不是用同一个进程）。
//   - cwd：返回服务进程的工作目录。
//   - roots：向客户端发 roots/list，返回它回答的根目录（测共享连接报的 roots）。
//   - slow：分 steps 步、共 ms 毫秒；请求带了 _meta.progressToken 时每步发一条 notifications/progress；
//     收到这次调用的 notifications/cancelled 就停下、不回复；做完回复"slow done <steps>"（测进度和取消只到发起的会话）。
// 环境变量：
//   - MORI_MCP_TOOLS=none：不注册任何工具（tools/list 返回空列表），用来测"没有注册工具的服务不显示已连接"。
//   - MORI_MCP_FAIL_INIT=<原文>：initialize 以这段原文失败（JSON-RPC 错误），用来测服务报错时界面显示的原文。
//   - MORI_MCP_LOG=<文件>：把收到的每条消息追加写进这个文件（测试据此核对连接了几次）。
//   - MORI_MCP_EXTRA=1：另外注册 pid、cwd、roots、slow。

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const noTools = process.env.MORI_MCP_TOOLS === 'none';
const failInit = process.env.MORI_MCP_FAIL_INIT;
const logFile = process.env.MORI_MCP_LOG;
const extra = process.env.MORI_MCP_EXTRA === '1';

const object = (properties, required = []) => ({ type: 'object', properties, required });
const BASIC_TOOLS = [
  { name: 'echo', description: 'Echo the given text back (synthetic test tool).',
    inputSchema: object({ text: { type: 'string', description: 'Text to echo' } }, ['text']) },
  { name: 'add', description: 'Add two numbers (synthetic test tool).',
    inputSchema: object({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']) },
];
const EXTRA_TOOLS = [
  { name: 'pid', description: 'Return the server process id (synthetic test tool).', inputSchema: object({}) },
  { name: 'cwd', description: 'Return the server working directory (synthetic test tool).', inputSchema: object({}) },
  { name: 'roots', description: 'Ask the client for its roots and return them (synthetic test tool).',
    inputSchema: object({}) },
  { name: 'slow', description: 'Work for ms milliseconds in steps, reporting progress (synthetic test tool).',
    inputSchema: object({ ms: { type: 'number' }, steps: { type: 'number' } }) },
];

/** 正在执行的 slow 调用：请求 id → 是否已取消 */
const running = new Map();
/** 发给客户端、还没回答的请求：id → 回答到了时调用 */
const asked = new Map();
let nextAskId = 1;

/** @brief 写一条 JSON-RPC 消息到 stdout。 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @brief 向客户端发一个请求，等它回答。 */
function ask(method, params) {
  const id = `server-${nextAskId++}`;
  return new Promise((resolve) => {
    asked.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

/** @brief slow：分步执行，每步报进度；被取消时返回 null（不回复）。 */
async function slow(id, args, token) {
  const steps = Math.max(1, Number(args?.steps ?? 5));
  const ms = Math.max(0, Number(args?.ms ?? 1000));
  running.set(id, false);
  for (let step = 1; step <= steps; step += 1) {
    await sleep(ms / steps);
    if (running.get(id)) {
      running.delete(id);
      return null;
    }
    if (token !== undefined) {
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step,
        total: steps } });
    }
  }
  running.delete(id);
  return text(`slow done ${steps}`);
}

/** @brief 执行一次工具调用，返回 MCP 的 CallToolResult；slow 被取消时返回 null。 */
async function callTool(id, params) {
  const args = params?.arguments;
  switch (params?.name) {
    case 'echo': return text(`mori-mcp echo: ${String(args?.text ?? '')}`);
    case 'add': return text(Number(args?.a) + Number(args?.b));
    case 'pid': return text(process.pid);
    case 'cwd': return text(process.cwd());
    case 'roots': return text(JSON.stringify((await ask('roots/list', {}))?.result?.roots ?? null));
    case 'slow': return slow(id, args, params?._meta?.progressToken);
    default: return { ...text(`Unknown tool: ${params?.name}`), isError: true };
  }
}

/** @brief 处理一条请求，返回 result（null 表示不回复）；不认识的方法抛出 JSON-RPC 错误。 */
async function handle(id, method, params) {
  switch (method) {
    case 'initialize':
      if (failInit) throw { code: -32000, message: failInit };
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mori-test-mcp', version: '0.0.1' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: noTools ? [] : [...BASIC_TOOLS, ...(extra ? EXTRA_TOOLS : [])] };
    case 'tools/call':
      return callTool(id, params);
    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

/** @brief 一条通知：取消就标记那次 slow 调用；其余不处理。 */
function notified(message) {
  const requestId = message.params?.requestId;
  if (message.method === 'notifications/cancelled' && running.has(requestId)) running.set(requestId, true);
}

/** @brief 处理一条请求并回复（结果为 null 时不回复）。 */
async function reply(message) {
  try {
    const result = await handle(message.id, message.method, message.params);
    if (result !== null) send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    const { code = -32603, message: errorText = String(error) } = error ?? {};
    send({ jsonrpc: '2.0', id: message.id, error: { code, message: errorText } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  if (logFile) appendFileSync(logFile, `${line}\n`);
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }
  // 客户端对服务发出的请求（roots/list）的回答。
  if (message.method === undefined && asked.has(message.id)) {
    asked.get(message.id)(message);
    asked.delete(message.id);
    return;
  }
  // 通知（没有 id）不回复，例如 notifications/initialized、notifications/cancelled。
  if (message.id === undefined || message.id === null) {
    notified(message);
    return;
  }
  void reply(message);
});
lines.on('close', () => process.exit(0));
