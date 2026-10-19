// 合成测试端点（synthetic）：只用于本地验证管线，不是真实模型。
// 实现 OpenAI 兼容的 /v1/models 与流式 /v1/chat/completions，回复内容由下列规则决定：
//   - 最后一条是工具结果：流式返回一段摘要文字后结束。
//   - 用户消息含 "run: <命令>"：调用 bash 工具执行该命令，可加 "timeout=<秒>"。
//   - 用户消息含 "edit README"：调用 edit 工具修改 README.md 的标题（"# Smoke project" 或 "# Mori fixture project"，
//     由 "edit README: <原标题>" 指定，默认 "# Smoke project"）。
//   - 用户消息含 "code block"：返回一段带 ts 代码块的 Markdown。
//   - 用户消息含 "plain"：只返回文字。
//   - 用户消息含 "http-<状态码>"：直接以该状态码返回错误（例如 http-500 触发 pi 的自动重试，http-400 不重试）。
//   - 模型 ID 为 "fake-slow"：第一个分块前等 8 秒（测试"测试连接 → 取消"）。
//   - 用量：prompt_tokens 按请求消息的字数估算，随对话增长。
//   - 其他：先说一句话，再调用 read 工具读取 README.md。
// 环境变量：FAKE_PORT（默认 4319）、FAKE_CHUNK_DELAY_MS（默认 20）、FAKE_FIRST_DELAY_MS（默认 0）、
// FAKE_REQUIRE_KEY（设置后要求 Authorization: Bearer <该值>）。

import http from 'node:http';

const port = Number(process.env.FAKE_PORT ?? 4319);
const chunkDelayMs = Number(process.env.FAKE_CHUNK_DELAY_MS ?? 20);
const firstDelayMs = Number(process.env.FAKE_FIRST_DELAY_MS ?? 0);
const requiredKey = process.env.FAKE_REQUIRE_KEY;
const modelId = 'fake-coder';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const codeReply = [
  '下面是一段代码：',
  '',
  '```ts',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '```',
  '',
].join('\n');

/** @brief 把消息内容（字符串或分段数组）转成纯文本。 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

/** @brief 根据对话末尾决定本次回复：文字与可选的工具调用。 */
function planReply(messages) {
  const last = messages[messages.length - 1] ?? {};
  if (last.role === 'tool') {
    const head = contentText(last.content).replace(/\s+/g, ' ').slice(0, 80);
    return { text: `工具已返回。开头内容：${head}`, toolCall: null };
  }
  const userText = contentText(last.content);
  const run = /run:\s*(.+?)(?:\s+timeout=(\d+))?\s*$/m.exec(userText);
  if (run) {
    const args = { command: run[1] };
    if (run[2]) args.timeout = Number(run[2]);
    return { text: '我来运行这条命令。', toolCall: { name: 'bash', args } };
  }
  if (userText.includes('edit README')) {
    const title = /edit README:\s*(.+)$/m.exec(userText)?.[1]?.trim() ?? '# Smoke project';
    const edits = [{ oldText: title, newText: `${title} (edited)` }];
    return { text: '我来改一下标题。', toolCall: { name: 'edit', args: { path: 'README.md', edits } } };
  }
  if (userText.includes('code block')) return { text: codeReply, toolCall: null };
  if (userText.includes('plain')) return { text: '这是一段只有文字的回复，用来测试流式输出。', toolCall: null };
  return { text: '我先读一下 README.md。', toolCall: { name: 'read', args: { path: 'README.md' } } };
}

/** @brief 把字符串切成小段，模拟逐字流式输出。 */
function pieces(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** @brief 以 SSE 方式发送一次流式回复。 */
async function streamReply(res, reply, includeUsage, promptTokens, slow) {
  const id = `chatcmpl-fake-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId };
  const send = (choice) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  await sleep(slow ? 8000 : firstDelayMs);
  send({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null });
  for (const piece of pieces(reply.text, 2)) {
    send({ index: 0, delta: { content: piece }, finish_reason: null });
    await sleep(chunkDelayMs);
  }
  if (reply.toolCall) {
    const callId = `call_fake_${Date.now()}`;
    const head = { index: 0, id: callId, type: 'function', function: { name: reply.toolCall.name, arguments: '' } };
    send({ index: 0, delta: { tool_calls: [head] }, finish_reason: null });
    for (const piece of pieces(JSON.stringify(reply.toolCall.args), 8)) {
      send({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null });
      await sleep(chunkDelayMs);
    }
  }
  send({ index: 0, delta: {}, finish_reason: reply.toolCall ? 'tool_calls' : 'stop' });
  if (includeUsage) {
    const usage = { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 };
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** @brief 读取并解析请求体 JSON。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  console.log(`[fake-endpoint] ${req.method} ${req.url}`);
  if (requiredKey && req.headers.authorization !== `Bearer ${requiredKey}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));
    return;
  }
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model', owned_by: 'fake' }] }));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    try {
      const body = await readJson(req);
      const messages = body.messages ?? [];
      const status = /http-(\d{3})/.exec(contentText(messages[messages.length - 1]?.content))?.[1];
      if (status && messages[messages.length - 1]?.role === 'user') {
        res.writeHead(Number(status), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Synthetic HTTP ${status} for testing`, type: 'synthetic_error' } }));
        return;
      }
      const reply = planReply(messages);
      const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
      await streamReply(res, reply, Boolean(body.stream_options?.include_usage), promptTokens, body.model === 'fake-slow');
    } catch (error) {
      console.error('[fake-endpoint] error', error);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-endpoint] synthetic endpoint on http://127.0.0.1:${port}/v1 (model "${modelId}")`);
});
