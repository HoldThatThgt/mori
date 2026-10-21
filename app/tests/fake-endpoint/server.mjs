// 合成测试端点（synthetic）：只用于本地验证管线，不是真实模型。
// 实现 OpenAI 兼容的 /v1/models 与流式 /v1/chat/completions，回复内容由下列规则决定：
//   - 最后一条是工具结果，且以 "Rejected" 开头（Mori 拒绝时回给模型的固定写法）：回复"收到拒绝："加结果的前 60 个字。
//   - 最后一条是其他工具结果：流式返回一段摘要文字后结束。
//   - 用户消息含 "two commands: <命令一> ;; <命令二>"：同一条回复里调用两次 bash 工具
//     （tool_calls 的 index 为 0 和 1，id 不同），用来测一条回复里的多个调用。
//   - 用户消息含 "run: <命令>"：调用 bash 工具执行该命令，可加 "timeout=<秒>"。
//   - 用户消息含 "write file: <路径>"：调用 write 工具，把 "hello from mori\n" 写入该路径。
//   - 用户消息含 "edit README"：调用 edit 工具修改 README.md 的标题（"# Smoke project" 或 "# Mori fixture project"，
//     由 "edit README: <原标题>" 指定，默认 "# Smoke project"）。
//   - 用户消息含 "list tools"：回复"可用的工具："加请求里 tools 的全部工具名（逗号分隔），用来测项目扩展的工具有没有加载。
//   - 用户消息含 "call tool: <工具名>"：调用该工具，参数为空对象（例如项目扩展注册的 project_hello）；
//     工具名后面跟一段 JSON 对象时（"call tool: mcp__x__echo {"text":"hi"}"）用它作参数（M6）。
//   - 用户消息含 "agents check"：系统提示里有 MORI-AGENTS-<字母数字> 时回复"系统提示里有 <它>"，否则"系统提示里没有标记"
//     （M6：测用户级 AGENTS.md 进了新会话的系统提示）。
//   - 用户消息含 "which model"：回复"模型：<请求里的 model>"（M6：测顶栏换模型后新回复来自新模型）。
//   - 用户消息含 "thinking check"：请求带 reasoning_effort 时先流式返回一段思考，再回复"收到思考参数：<值>"；
//     不带时只回复"没有思考参数"（M6：测思考强度，pi 对 OpenAI 兼容端点在模型标了支持思考时才发这个参数）。
//   - 用户消息含 "wait <秒数>s then run: <命令>"：等这么多秒再调用 bash 工具执行该命令（测界面重新加载后才来的批准请求）。
//   - 用户消息含 "wait <秒数>s"：等这么多秒再回复一段文字（测生成中切走、"Unread"）。
//   - 用户消息含 "code block"：返回一段带 ts 代码块的 Markdown。
//   - 用户消息含 "echo back"：回复"收到的全文："加这条用户消息的全文（测引用块确实发给了模型）。
//   - 用户消息含 "long reply"：流式返回四段较长的文字（测生成中选字、反馈）。
//   - 用户消息含 "think first"：先流式返回一段思考（reasoning_content），再返回一句文字（测会话引用不含思考）。
//   - 用户消息含 "plain"：只返回文字。
//   - 用户消息含 "http-<状态码>"：直接以该状态码返回错误（例如 http-500 触发 pi 的自动重试，http-400 不重试）。
//   - 模型 ID 为 "fake-slow"：第一个分块前等 8 秒（测试"Test connection → Cancel"）。
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

/** "long reply" 的回复：四段，每段一句开头不同的话重复几次 */
const longReply = ['第一段：春天来了，河边的柳树发了新芽。', '第二段：夏天的午后，蝉在树上一直叫。',
  '第三段：秋天的稻田一片金黄，风吹过沙沙作响。', '第四段：冬天下了第一场雪，屋顶都白了。']
  .map((sentence) => sentence.repeat(8)).join('\n\n');

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

/** @brief 最后一条是工具结果时的回复：被拒绝时复述拒绝原文的开头，否则给出结果开头的摘要。 */
function toolResultReply(last) {
  const flat = contentText(last.content).replace(/\s+/g, ' ');
  const trimmed = flat.trimStart();
  if (trimmed.startsWith('Rejected')) return { text: `收到拒绝：${trimmed.slice(0, 60)}`, toolCalls: [] };
  return { text: `工具已返回。开头内容：${flat.slice(0, 80)}`, toolCalls: [] };
}

/** @brief M6 的规则（which model、agents check、thinking check）：看请求本身；不是这几条时为 null。 */
function requestReply(userText, body) {
  if (userText.includes('which model')) return { text: `模型：${body.model}`, toolCalls: [] };
  if (userText.includes('agents check')) {
    const system = (body.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => contentText(m.content)).join(' ');
    const marker = /MORI-AGENTS-\w+/.exec(system)?.[0];
    return { text: marker ? `系统提示里有 ${marker}` : '系统提示里没有标记', toolCalls: [] };
  }
  if (userText.includes('thinking check')) {
    const effort = body.reasoning_effort;
    if (!effort) return { text: '没有思考参数', toolCalls: [] };
    return { thinking: `思考强度参数 ${effort}，这是思考内容。`, text: `收到思考参数：${effort}`, toolCalls: [] };
  }
  return null;
}

/** @brief 按用户消息里的关键词决定回复（规则见文件开头）；tools 是请求里的工具定义。 */
function userReply(userText, tools, body = {}) {
  const fromRequest = requestReply(userText, body);
  if (fromRequest) return fromRequest;
  if (userText.includes('list tools')) {
    const names = (tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
    return { text: `可用的工具：${names.join(', ')}`, toolCalls: [] };
  }
  const call = /call tool:\s*([\w-]+)(?:\s+(\{.*\}))?/.exec(userText);
  if (call) return { text: '我来调用这个工具。', toolCalls: [{ name: call[1], args: call[2] ? JSON.parse(call[2]) : {} }] };
  const late = /wait (\d+)s then run:\s*(.+?)\s*$/m.exec(userText);
  if (late) {
    return { text: '我来运行这条命令。', toolCalls: [{ name: 'bash', args: { command: late[2] } }],
      delayMs: Number(late[1]) * 1000 };
  }
  const wait = /wait (\d+)s/.exec(userText);
  if (wait) return { text: `等了 ${wait[1]} 秒，这是回复。`, toolCalls: [], delayMs: Number(wait[1]) * 1000 };
  const two = /two commands:\s*(.+?)\s*;;\s*(.+?)\s*$/m.exec(userText);
  if (two) {
    const toolCalls = [{ name: 'bash', args: { command: two[1] } }, { name: 'bash', args: { command: two[2] } }];
    return { text: '我来依次运行这两条命令。', toolCalls };
  }
  const run = /run:\s*(.+?)(?:\s+timeout=(\d+))?\s*$/m.exec(userText);
  if (run) {
    const args = { command: run[1] };
    if (run[2]) args.timeout = Number(run[2]);
    return { text: '我来运行这条命令。', toolCalls: [{ name: 'bash', args }] };
  }
  const write = /write file:\s*(.+?)\s*$/m.exec(userText);
  if (write) {
    const args = { path: write[1], content: 'hello from mori\n' };
    return { text: '我来写一个文件。', toolCalls: [{ name: 'write', args }] };
  }
  if (userText.includes('edit README')) {
    const title = /edit README:\s*(.+)$/m.exec(userText)?.[1]?.trim() ?? '# Smoke project';
    const edits = [{ oldText: title, newText: `${title} (edited)` }];
    return { text: '我来改一下标题。', toolCalls: [{ name: 'edit', args: { path: 'README.md', edits } }] };
  }
  if (userText.includes('code block')) return { text: codeReply, toolCalls: [] };
  if (userText.includes('echo back')) return { text: `收到的全文：\n\n${userText}`, toolCalls: [] };
  if (userText.includes('long reply')) return { text: longReply, toolCalls: [] };
  if (userText.includes('think first')) {
    return { thinking: '这是只在思考里出现的内容 THINKING-ONLY-MARKER。', text: '想好了，这是正文。', toolCalls: [] };
  }
  if (userText.includes('plain')) return { text: '这是一段只有文字的回复，用来测试流式输出。', toolCalls: [] };
  return { text: '我先读一下 README.md。', toolCalls: [{ name: 'read', args: { path: 'README.md' } }] };
}

/** @brief 根据对话末尾决定本次回复：文字与零到多个工具调用。 */
function planReply(messages, tools, body) {
  const last = messages[messages.length - 1] ?? {};
  if (last.role === 'tool') return toolResultReply(last);
  return userReply(contentText(last.content), tools, body);
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
  await sleep(slow ? 8000 : firstDelayMs + (reply.delayMs ?? 0));
  send({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null });
  for (const piece of pieces(reply.thinking ?? '', 4)) {
    send({ index: 0, delta: { reasoning_content: piece }, finish_reason: null });
    await sleep(chunkDelayMs);
  }
  for (const piece of pieces(reply.text, 2)) {
    send({ index: 0, delta: { content: piece }, finish_reason: null });
    await sleep(chunkDelayMs);
  }
  // 多个调用按 OpenAI 的分块格式：每个调用先发带 id 和名字的头，再分段发参数；tool_calls[].index 区分是第几个调用。
  const stamp = Date.now();
  for (const [index, call] of reply.toolCalls.entries()) {
    const fn = { name: call.name, arguments: '' };
    const head = { index, id: `call_fake_${stamp}_${index}`, type: 'function', function: fn };
    send({ index: 0, delta: { tool_calls: [head] }, finish_reason: null });
    for (const piece of pieces(JSON.stringify(call.args), 8)) {
      send({ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] }, finish_reason: null });
      await sleep(chunkDelayMs);
    }
  }
  send({ index: 0, delta: {}, finish_reason: reply.toolCalls.length > 0 ? 'tool_calls' : 'stop' });
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
      const reply = planReply(messages, body.tools, body);
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
