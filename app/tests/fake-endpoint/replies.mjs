// 合成测试端点（synthetic）的关键词回复：只用于本地验证管线，不是真实模型。规则逐条列在 server.mjs 开头。

// 与 probes.mjs 互相 import：两边只在调用时用到对方的函数声明，模块求值时不用，循环引用没有问题
import { requestedEffort, thinkingOn } from './probes.mjs';

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

/** "mermaid diagram" 的回复：一段话加一张流程图（2026-10-26 走查 M16：测图在打包程序里离线画出） */
const mermaidReply = ['下面是一张图：', '', '```mermaid', 'flowchart LR', '  A["开始"] --> B["结束"]', '```', '']
  .join('\n');

/**
 * "image reply" 的回复：一张相对路径的图片、一张远程图片（2026-10-26，docs/v0/screens/chat.md"正文里的图片"：
 * 都载入不了，显示"Image not available"；远程的被窗口的内容安全策略拦下）
 */
const imageReply = ['下面有两张图：', '', '![logo](./logo.png)', '', '![remote](https://example.com/a.png)', '']
  .join('\n');

/** pi 压缩请求的系统提示开头（pi-coding-agent 1.3.0 compaction/utils.js 的 SUMMARIZATION_SYSTEM_PROMPT） */
const SUMMARY_SYSTEM = 'You are a context summarization assistant.';

/** 压缩请求的回复：一段纯文字摘要，不调用工具（pi 拒绝调用工具的摘要） */
const summaryText = [
  '## Goal',
  'Synthetic summary of the earlier conversation.',
  '',
  '## Progress',
  '- The earlier turns were summarized by the synthetic endpoint.',
].join('\n');

/** @brief 把消息内容（字符串或分段数组）转成纯文本。 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

/** @brief 是否 pi 的压缩（摘要）请求：系统提示是 pi 的摘要提示。 */
export function isSummaryRequest(messages) {
  return messages.some((m) => (m.role === 'system' || m.role === 'developer')
    && contentText(m.content).startsWith(SUMMARY_SYSTEM));
}

/** @brief 压缩请求的回复。 */
export function summaryReply() {
  return { text: summaryText, toolCalls: [] };
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
    // §14.1（2026-10-24）：开了思考 = 带 reasoning_effort 或 reasoning.effort 且不是 none（probes.mjs 的 thinkingOn）
    if (!thinkingOn(body)) return { text: '没有思考参数', toolCalls: [] };
    const effort = requestedEffort(body);
    return { thinking: `思考强度参数 ${effort}，这是思考内容。`, text: `收到思考参数：${effort}`, toolCalls: [] };
  }
  return null;
}

/** @brief 带命令或路径的关键词（call tool、wait、two commands、run、write file、edit README）；不是这几条时为 null。 */
function actionReply(userText) {
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
  return null;
}

/** @brief 按用户消息里的关键词决定回复（规则见 server.mjs 开头）；tools 是请求里的工具定义。 */
function userReply(userText, tools, body = {}) {
  const fromRequest = requestReply(userText, body);
  if (fromRequest) return fromRequest;
  if (userText.includes('list tools')) {
    const names = (tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
    return { text: `可用的工具：${names.join(', ')}`, toolCalls: [] };
  }
  const action = actionReply(userText);
  if (action) return action;
  if (userText.includes('code block')) return { text: codeReply, toolCalls: [] };
  if (userText.includes('mermaid diagram')) return { text: mermaidReply, toolCalls: [] };
  if (userText.includes('image reply')) return { text: imageReply, toolCalls: [] };
  if (userText.includes('echo back')) return { text: `收到的全文：\n\n${userText}`, toolCalls: [] };
  if (userText.includes('long reply')) return { text: longReply, toolCalls: [] };
  if (userText.includes('think first')) {
    return { thinking: '这是只在思考里出现的内容 THINKING-ONLY-MARKER。', text: '想好了，这是正文。', toolCalls: [] };
  }
  if (userText.includes('plain')) return { text: '这是一段只有文字的回复，用来测试流式输出。', toolCalls: [] };
  return { text: '我先读一下 README.md。', toolCalls: [{ name: 'read', args: { path: 'README.md' } }] };
}

/** @brief 根据对话末尾决定本次回复：文字与零到多个工具调用。 */
export function planReply(messages, tools, body) {
  const last = messages[messages.length - 1] ?? {};
  if (last.role === 'tool') return toolResultReply(last);
  return userReply(contentText(last.content), tools, body);
}
