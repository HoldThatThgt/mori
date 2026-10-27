// 合成测试端点（synthetic）的关键词回复：只用于本地验证管线，不是真实模型。规则逐条列在 server.mjs 开头。
// 文件系统第 1 步（docs/specs/file-system.md §19.1“合成端点”）加的单步关键词（ps:、edit file:、write file: … size=、
// ask user:、calls:、say:）、关键词链（steps:）与对提醒的回复也在这里；parseStep 与 firstFailure 同时给脚本模式的
// line 步骤用（scripts.mjs，修饰 [wait]、[fail-once] 在那里同样生效）。

import { createHash } from 'node:crypto';
import { REMINDER_ACK, askArgs, isReminder } from './away.mjs';
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

/** write file: 写的内容（size= 时重复它再截到那么多个字符，最后一个字符是换行） */
export const WRITE_CONTENT = 'hello from mori\n';
/** edit file: 不写 ":: <原文> => <新文>" 时改的那一段（write file: 写下的内容的第一行） */
export const EDIT_OLD = 'hello from mori';
export const EDIT_NEW = 'hello from mori (edited)';
/** 链走完、最后一条既不是工具结果也不是提醒时的回复 */
export const CHAIN_DONE = 'Done.';
/** 认不出的步骤文字的回复开头（后面接原文） */
export const UNKNOWN_STEP = 'Unknown step:';

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

/** @brief 最后一条是提醒时的回复：REMINDER_ACK 加清单的第一项（第二行），只有文字。 */
function reminderReply(text) {
  const first = text.split('\n').map((line) => line.trim()).find((line) => line.startsWith('- ')) ?? '';
  return { text: `${REMINDER_ACK} ${first}`.trim(), toolCalls: [] };
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

/** @brief write file: 的内容：没给 size 时是 WRITE_CONTENT，给了时重复它、截到 size 个字符（最后一个是换行）。 */
function writeContent(size) {
  if (size === undefined) return WRITE_CONTENT;
  const n = Math.max(1, Number(size));
  return `${WRITE_CONTENT.trim().concat(' ').repeat(Math.ceil(n / WRITE_CONTENT.length) + 1).slice(0, n - 1)}\n`;
}

/** @brief 一个 shell 工具的调用（run:、ps:）：command 与可选的 timeout（秒）。 */
function shellCall(name, command, timeout) {
  const args = { command };
  if (timeout) args.timeout = Number(timeout);
  return { text: name === 'bash' ? '我来运行这条命令。' : 'Running this PowerShell command.',
    toolCalls: [{ name, args }] };
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
  if (run) return shellCall('bash', run[1], run[2]);
  // size=<n>（文件系统第 1 步加）：内容为 n 个字符，测自动处理记录里截到 300 字符、去掉 content
  const write = /write file:\s*(.+?)(?:\s+size=(\d+))?\s*$/m.exec(userText);
  if (write) {
    const args = { path: write[1], content: writeContent(write[2]) };
    return { text: '我来写一个文件。', toolCalls: [{ name: 'write', args }] };
  }
  if (userText.includes('edit README')) {
    const title = /edit README:\s*(.+)$/m.exec(userText)?.[1]?.trim() ?? '# Smoke project';
    const edits = [{ oldText: title, newText: `${title} (edited)` }];
    return { text: '我来改一下标题。', toolCalls: [{ name: 'edit', args: { path: 'README.md', edits } }] };
  }
  return null;
}

/**
 * @brief 文件系统第 1 步的单步关键词（都写在一行的开头，见 server.mjs 开头）：calls:、ps:、edit file:、ask user:；
 *        不是这几条时为 null。
 */
function fsActionReply(userText) {
  const calls = /^calls:\s*(\[.*\])\s*$/m.exec(userText);
  if (calls) {
    const toolCalls = JSON.parse(calls[1]).map((item) => ({ name: item.name, args: item.args ?? {} }));
    return { text: 'Making these calls.', toolCalls };
  }
  const ps = /^ps:\s*(.+?)(?:\s+timeout=(\d+))?\s*$/m.exec(userText);
  if (ps) return shellCall('powershell', ps[1], ps[2]);
  const edit = /^edit file:\s*(.+?)(?:\s+::\s*(.*?)\s+=>\s+(.*?))?\s*$/m.exec(userText);
  if (edit) {
    const edits = [{ oldText: edit[2] ?? EDIT_OLD, newText: edit[3] ?? EDIT_NEW }];
    return { text: 'Editing this file.', toolCalls: [{ name: 'edit', args: { path: edit[1], edits } }] };
  }
  const ask = /^ask user:\s*([\w-]+)\s*$/m.exec(userText);
  if (ask) {
    const args = askArgs(ask[1]);
    if (!args) return { text: `${UNKNOWN_STEP} no ask preset ${ask[1]}`, toolCalls: [] };
    return { text: 'Asking the user.', toolCalls: [{ name: 'ask_user_question', args }] };
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
  const action = fsActionReply(userText) ?? actionReply(userText);
  if (action) return action;
  if (userText.includes('code block')) return { text: codeReply, toolCalls: [] };
  if (userText.includes('echo back')) return { text: `收到的全文：\n\n${userText}`, toolCalls: [] };
  if (userText.includes('long reply')) return { text: longReply, toolCalls: [] };
  if (userText.includes('think first')) {
    return { thinking: '这是只在思考里出现的内容 THINKING-ONLY-MARKER。', text: '想好了，这是正文。', toolCalls: [] };
  }
  if (userText.includes('plain')) return { text: '这是一段只有文字的回复，用来测试流式输出。', toolCalls: [] };
  return { text: '我先读一下 README.md。', toolCalls: [{ name: 'read', args: { path: 'README.md' } }] };
}

// ---------- 步骤与关键词链（文件系统第 1 步） ----------

/** 步骤文字开头的修饰：[wait <毫秒>]、[fail-once <状态码>]，可以叠加 */
const MODIFIER = /^\[(wait|fail-once)\s+(\d+)\]\s*/;
/** 关键词链：以 "steps:" 开头的一行，步骤以 " ;; " 分开（到行尾为止） */
const CHAIN = /^steps:\s*(.+?)\s*$/m;
const CHAIN_SPLIT = /\s;;\s/;

/**
 * @brief 一个步骤（关键词链的一步、脚本 line 步骤的值）：say: <文字> 只回文字；其余按单步关键词（fsActionReply、
 *        actionReply 的写法，一条一个回复）。认不出时为 null。
 */
function stepReply(text) {
  const said = /^say:\s*([\s\S]*)$/.exec(text);
  if (said) return { text: said[1].trim(), toolCalls: [] };
  return fsActionReply(text) ?? actionReply(text);
}

/**
 * @brief 解析一个步骤的文字：先去掉开头的修饰，再按 stepReply 认。
 * @param text 步骤原文
 * @return { waitMs（修饰 wait 的和）, failOnce（修饰 fail-once 的状态码，没有为 null）, reply（{ text, toolCalls }，
 *         认不出时为 null） }
 */
export function parseStep(text) {
  let rest = String(text ?? '').trim();
  let waitMs = 0;
  let failOnce = null;
  for (let match = MODIFIER.exec(rest); match; match = MODIFIER.exec(rest)) {
    if (match[1] === 'wait') waitMs += Number(match[2]);
    else failOnce = Number(match[2]);
    rest = rest.slice(match[0].length);
  }
  return { waitMs, failOnce, reply: stepReply(rest) };
}

/** 已经失败过一次的 fail-once 步骤：状态码|整个请求消息的哈希（重试的请求消息相同） */
const failedOnce = new Set();

/**
 * @brief 这个请求是不是第一次遇到这个 fail-once；是就记下。关键词链与脚本的 line 步骤（scripts.mjs）共用：
 *        同一段消息在端点进程里只失败一次，pi 重试时消息相同，得到这一步。
 */
export function firstFailure(messages, status) {
  const key = `${status}|${createHash('sha1').update(JSON.stringify(messages)).digest('hex')}`;
  if (failedOnce.has(key)) return false;
  failedOnce.add(key);
  return true;
}

/** @brief 链走完之后的回复：最后一条是工具结果、提醒时同不在链里的回复，其余为 CHAIN_DONE。 */
function chainEnd(last) {
  if (last?.role === 'tool') return toolResultReply(last);
  const text = contentText(last?.content);
  if (last?.role === 'user' && isReminder(text)) return reminderReply(text);
  return { text: CHAIN_DONE, toolCalls: [] };
}

/**
 * @brief 关键词链（规则见 server.mjs 开头）：最后一条不是提醒的用户消息里有 "steps:" 一行时，按它之后的助手消息数 j
 *        回答第 j 步；不是链时为 null。
 * @return { reply } | { failure: { status, body } } | null
 */
function chainPlan(messages) {
  const at = messages.findLastIndex((m) => m.role === 'user' && !isReminder(contentText(m.content)));
  const chain = at < 0 ? null : CHAIN.exec(contentText(messages[at].content));
  if (!chain) return null;
  const steps = chain[1].split(CHAIN_SPLIT).map((item) => item.trim()).filter(Boolean);
  const j = messages.slice(at + 1).filter((m) => m.role === 'assistant').length;
  if (j >= steps.length) return { reply: chainEnd(messages[messages.length - 1]) };
  const step = parseStep(steps[j]);
  if (step.failOnce !== null && firstFailure(messages, step.failOnce)) {
    const message = `Synthetic HTTP ${step.failOnce} from step ${j + 1} of the chain`;
    return { failure: { status: step.failOnce, body: { error: { message, type: 'synthetic_error' } } } };
  }
  const reply = step.reply ?? { text: `${UNKNOWN_STEP} ${steps[j]}`, toolCalls: [] };
  return { reply: { ...reply, delayMs: (reply.delayMs ?? 0) + step.waitMs } };
}

/**
 * @brief 根据对话末尾决定本次回复：关键词链 → 最后一条是工具结果 → 最后一条是提醒 → 用户消息里的关键词。
 * @return { reply: { text, toolCalls, … } } 或 { failure: { status, body } }（链里 fail-once 的一步）
 */
export function planReply(messages, tools, body) {
  const chained = chainPlan(messages);
  if (chained) return chained;
  const last = messages[messages.length - 1] ?? {};
  if (last.role === 'tool') return { reply: toolResultReply(last) };
  const text = contentText(last.content);
  if (last.role === 'user' && isReminder(text)) return { reply: reminderReply(text) };
  return { reply: userReply(text, tools, body) };
}
