// 合成 MCP 服务（synthetic）：只用于本地验证 Mori 的工具页和 pi 的 MCP 扩展，不是真实服务。
// stdio 传输：每行一条 JSON-RPC 2.0 消息（MCP 规范的 stdio 传输），只用 Node 自带的模块，可以离线运行。
// 实现 initialize、ping、tools/list、tools/call；其余请求回 -32601。
// 工具：
//   - echo：原样返回参数 text（"mori-mcp echo: <text>"）。
//   - add：返回 a + b。
// 环境变量：
//   - MORI_MCP_TOOLS=none：不注册任何工具（tools/list 返回空列表），用来测"没有注册工具的服务不显示已连接"。
//   - MORI_MCP_FAIL_INIT=<原文>：initialize 以这段原文失败（JSON-RPC 错误），用来测服务报错时界面显示的原文。
//   - MORI_MCP_LOG=<文件>：把收到的每条消息追加写进这个文件（测试据此核对连接了几次）。

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const noTools = process.env.MORI_MCP_TOOLS === 'none';
const failInit = process.env.MORI_MCP_FAIL_INIT;
const logFile = process.env.MORI_MCP_LOG;

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back (synthetic test tool).',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two numbers (synthetic test tool).',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
];

/** @brief 写一条 JSON-RPC 消息到 stdout。 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** @brief 执行一次工具调用，返回 MCP 的 CallToolResult。 */
function callTool(name, args) {
  if (name === 'echo') return { content: [{ type: 'text', text: `mori-mcp echo: ${String(args?.text ?? '')}` }] };
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args?.a) + Number(args?.b)) }] };
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

/** @brief 处理一条请求，返回 result；不认识的方法抛出 JSON-RPC 错误。 */
function handle(method, params) {
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
      return { tools: noTools ? [] : TOOLS };
    case 'tools/call':
      return callTool(params?.name, params?.arguments);
    default:
      throw { code: -32601, message: `Method not found: ${method}` };
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
  // 通知（没有 id）不回复，例如 notifications/initialized。
  if (message.id === undefined || message.id === null) return;
  try {
    send({ jsonrpc: '2.0', id: message.id, result: handle(message.method, message.params) });
  } catch (error) {
    const { code = -32603, message: text = String(error) } = error ?? {};
    send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  }
});
lines.on('close', () => process.exit(0));
