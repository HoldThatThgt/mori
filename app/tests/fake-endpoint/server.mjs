// 合成测试端点（synthetic）：只用于本地验证管线，不是真实模型。
// 实现 OpenAI 兼容的 /v1/models 与流式 /v1/chat/completions，另有 /version、/metrics（docs/specs/model-providers.md §14.1）。
// 多个提供商 = 多个端口（各起一个进程）。关键词回复在 replies.mjs，探针在 probes.mjs。
//
// 回复内容由下列规则决定（关键词都在最后一条用户消息里）：
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
//   - 用户消息含 "http-<状态码>"：每次都以该状态码返回错误（例如 http-500 是服务端错误，http-400 是请求错误）。
//   - 用户消息含 "http-<状态码>-once"：这个会话第一次以该状态码返回错误，之后按其他规则正常回复。
//   - 用户消息含 "overflow-once"：这个会话第一次返回 400，message "This model's maximum context length is 1000 tokens"、
//     code context_length_exceeded（pi-ai 的 overflow.js 认得这句），压缩后正常回复。
//     "会话"按第一条用户消息的哈希区分（去掉 Mori 重做时加在末尾的 "[Mori] ..." 说明），每个关键词每个会话只触发一次；
//     第一条用户消息已是 pi 的压缩摘要时，按最后一条用户消息的文字认出已经触发过。
//   - 用户消息含 "drop-after-first"：发出第一段内容后断开连接（有输出后中断）。
//   - 用户消息含单词 "slow"（独立的词，"mcp__shared__slow" 不算），或模型 ID 为 "fake-slow"：第一个分块前等 8 秒
//     （测"Test connection → Cancel"等）。
//   - pi 的压缩请求（系统提示是 pi 的摘要提示）：回一段纯文字摘要，不看关键词（摘要请求里是整段对话的文字）。
//   - 用量：prompt_tokens 按请求消息的字数估算，随对话增长。
//   - 其他：先说一句话，再调用 read 工具读取 README.md。
//
// 探针（§7.3 第 1–9 步，按最后一条消息认出）一律按"能力全通过"回答，先于上面的关键词：
//   - 第 1、2 步 "Reply with the single word: ready."：回 "ready"。
//   - 第 3 步 "Use the tool to get the weather for Paris for the next 3 days."（tools 里有 get_weather）：
//     调 get_weather {"city":"Paris","days":3}。
//   - 第 4 步 "What temperature did the tool report?"（或最后一条是工具结果 "Paris: 21°C, sunny for 3 days."）：回答含 21。
//   - 第 5 步 "Call submit_outcome with outcome banana."（tools 里有 submit_outcome）：调 submit_outcome {"outcome":"ok"}。
//   - 第 6 步 "Reply with JSON whose outcome is banana."：带 response_format json_schema 时回 {"outcome":"ok"}，
//     没带时回 {"outcome":"banana"}。
//   - 第 7 步：用户消息同时含 "<summary>" 与 "<outcome>"：回 "<summary>…</summary><outcome>ok</outcome>"。
//   - 第 8 步（本端点的约定，规格没有给原文）：用户消息含 "What is the passphrase?"：复述其中 "The passphrase is <暗号>"
//     的暗号。
//   - 第 9 步（本端点的约定，规格没有给原文）：用户消息以 "Count from 1 to <N>" 开头：逐行数到 N（最多 400），是长输出。
//   - 开了思考（请求带 reasoning_effort 且不是 none）时先返回一段 reasoning_content，没开时没有思考。
// 模型 ID 的后缀（以 "-" 分开的段，可以叠加，例如 fake-coder-stall-nocancel）：
//   - 只关掉对应的探针能力：-notools（第 3 步不调工具）、-nochoice（第 5 步忽略指定调用，只回文字）、
//     -noschema（第 6 步忽略 schema）、-truncate（第 8 步估算输入超过 max_model_len 的 70% 时静默丢掉开头，答不出暗号）、
//     -replay（开了思考时每次回复都带 reasoning_content；有带工具调用、没有 reasoning_content 的助手消息，且这次请求开了思考
//     或那个调用是本端点开着思考时发出的，就返回 400，探针第 4 步"不带"推理内容时因此被拒；对所有请求都生效）。
//   - 只作用于不是探针的请求：-404（返回 404）、-hang（不回响应头，等对方断开）、-stall（回了响应头后不发内容）。
//   - -nocancel：对方中途断开后，/metrics 的进行中计数 10 秒后才回落（对所有请求都生效，探针第 9 步靠它判出 false）。
//
// 认证（只对 /models 与 /chat/completions）：
//   - FAKE_REQUIRE_KEY：设置后要求 Authorization: Bearer <该值>，否则 401。
//   - FAKE_KEYS：逗号分隔的可接受 key（没设时不检查），不在其中为 401。
//   - FAKE_QUOTA_KEYS：其中的 key 的对话请求返回 402，type 与 code 为 insufficient_quota。
//   - FAKE_LIMITED_KEYS：其中的 key 的对话请求返回 429 带 Retry-After（秒）；从这个 key 第一次被限流起 FAKE_LIMIT_MS
//     之后恢复，Retry-After 为剩下的秒数；没设 FAKE_LIMIT_MS 时一直限流，Retry-After 为 60。
//   - 上面两个列表里写 "none" 表示不带 key 的请求（没有 key 的提供商）。
// 其他接口：
//   - GET /version：{"version": FAKE_SERVER_VERSION}（vLLM 的形状，默认 "0.10.1"）；/api/version、/props 为 404。
//   - GET /models：FAKE_MODELS（逗号分隔，默认 "fake-coder,fake-slow"）各一项，带 max_model_len = FAKE_MAX_MODEL_LEN
//     （默认 131072）。
//   - GET /metrics：Prometheus 文本，vllm:num_requests_running 为进行中的对话请求数；FAKE_NO_METRICS=1 时 404。
// 日志：每个请求一行 "[fake-endpoint] METHOD url"；每个对话请求另打一行 JSON
//   {"port","model","key"(key 末 4 位，没有为 null),"roles"(消息角色序列),"status"(-hang 为 null),"probe"}。
// 其他环境变量：FAKE_PORT（默认 4319）、FAKE_CHUNK_DELAY_MS（默认 20）、FAKE_FIRST_DELAY_MS（默认 0）。

import http from 'node:http';
import { createHash } from 'node:crypto';
import { contentText, isSummaryRequest, planReply, summaryReply } from './replies.mjs';
import { probeReply, probeStep, replayRejected, thinkingOn } from './probes.mjs';

const env = process.env;
const port = Number(env.FAKE_PORT ?? 4319);
const chunkDelayMs = Number(env.FAKE_CHUNK_DELAY_MS ?? 20);
const firstDelayMs = Number(env.FAKE_FIRST_DELAY_MS ?? 0);
const requiredKey = env.FAKE_REQUIRE_KEY;
const modelId = 'fake-coder';

/** @brief 逗号分隔的环境变量转成列表。 */
const listOf = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

/** 环境变量给出的 key 规则与服务信息 */
const config = {
  keys: listOf(env.FAKE_KEYS),
  limited: listOf(env.FAKE_LIMITED_KEYS),
  quota: listOf(env.FAKE_QUOTA_KEYS),
  limitMs: env.FAKE_LIMIT_MS ? Number(env.FAKE_LIMIT_MS) : null,
  version: env.FAKE_SERVER_VERSION ?? '0.10.1',
  noMetrics: env.FAKE_NO_METRICS === '1',
  maxModelLen: Number(env.FAKE_MAX_MODEL_LEN ?? 131072),
  models: listOf(env.FAKE_MODELS ?? 'fake-coder,fake-slow'),
};

/** 运行中的状态 */
const state = {
  /** 进行中的对话请求数（/metrics） */
  running: 0,
  /** 限流的 key → 第一次被限流的时刻 */
  limitedSince: new Map(),
  /** 已触发的 "-once" 关键词：关键词|会话哈希 */
  fired: new Set(),
  /** 已触发的 "-once" 关键词：关键词|最后一条用户消息的哈希（压缩后用） */
  firedTexts: new Set(),
  /** -replay 模型开着思考时发出的工具调用 id */
  reasonedCalls: new Set(),
};

const SUFFIXES = new Set(['notools', 'nochoice', 'noschema', 'replay', 'truncate', '404', 'hang', 'stall', 'nocancel']);
const NO_KEY = 'none';
const NOCANCEL_MS = 10000;
const SLOW_MS = 8000;
const UNLIMITED_RETRY_AFTER_S = 60;
const OVERFLOW_MESSAGE = "This model's maximum context length is 1000 tokens";
const REPLAY_THINKING = 'Synthetic reasoning before answering.';
const REPLAY_MESSAGE = 'The reasoning_content in the thinking mode must be passed back to the API.';
const MORI_NOTE = '[Mori] The previous model';
const COMPACTED = 'The conversation history before this point was compacted';
const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);

/** @brief OpenAI 形状的错误体。 */
function errorBody(message, type, code) {
  return { error: code ? { message, type, code } : { message, type } };
}

/** @brief 以 JSON 回复。 */
function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** @brief 请求里的 Bearer key；没有时为 null。 */
function bearer(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

/** @brief 模型 ID 的后缀集合（以 "-" 分开的段）。 */
function flagsOf(model) {
  return new Set(String(model ?? '').split('-').filter((part) => SUFFIXES.has(part)));
}

/** @brief 限流：从第一次限流起 FAKE_LIMIT_MS 之后恢复（返回 null）；否则 429 带 Retry-After 秒数。 */
function rateLimit(name) {
  const now = Date.now();
  if (!state.limitedSince.has(name)) state.limitedSince.set(name, now);
  const until = config.limitMs === null ? null : state.limitedSince.get(name) + config.limitMs;
  if (until !== null && now >= until) return null;
  const seconds = until === null ? UNLIMITED_RETRY_AFTER_S : Math.max(1, Math.ceil((until - now) / 1000));
  const body = errorBody('Rate limit reached for requests', 'rate_limit_error', 'rate_limit_exceeded');
  return { status: 429, body, headers: { 'Retry-After': String(seconds) } };
}

/** @brief key 规则：不认识的 key 为 401；对话请求另查额度（402）与限流（429）。通过时为 null。 */
function keyFailure(key, chat) {
  const denied = { status: 401, body: errorBody('Incorrect API key provided', 'invalid_request_error') };
  if (requiredKey && key !== requiredKey) return denied;
  if (config.keys.length > 0 && !config.keys.includes(key)) return denied;
  if (!chat) return null;
  const name = key ?? NO_KEY;
  if (config.quota.includes(name)) {
    const body = errorBody('You exceeded your current quota.', 'insufficient_quota', 'insufficient_quota');
    return { status: 402, body };
  }
  return config.limited.includes(name) ? rateLimit(name) : null;
}

/** @brief 用户消息的文字，去掉 Mori 重做时加在末尾的说明。 */
function userText(message) {
  const text = contentText(message?.content);
  const at = text.indexOf(MORI_NOTE);
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

/** @brief "-once" 关键词在这个会话里是不是第一次；是就记下。 */
function firstTime(messages, keyword) {
  const first = userText(messages.find((m) => m.role === 'user'));
  const convKey = `${keyword}|${hash(first)}`;
  const textKey = `${keyword}|${hash(userText(messages[messages.length - 1]))}`;
  const seen = first.startsWith(COMPACTED) ? state.firedTexts.has(textKey) : state.fired.has(convKey);
  if (seen) return false;
  state.fired.add(convKey);
  state.firedTexts.add(textKey);
  return true;
}

/** @brief 关键词造成的错误（http-NNN、http-NNN-once、overflow-once）；没有时为 null。 */
function keywordFailure(messages) {
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') return null;
  const text = contentText(last.content);
  const http = /http-(\d{3})(-once)?/.exec(text);
  if (http && (!http[2] || firstTime(messages, http[0]))) {
    return { status: Number(http[1]), body: errorBody(`Synthetic HTTP ${http[1]} for testing`, 'synthetic_error') };
  }
  if (text.includes('overflow-once') && firstTime(messages, 'overflow-once')) {
    return { status: 400, body: errorBody(OVERFLOW_MESSAGE, 'invalid_request_error', 'context_length_exceeded') };
  }
  return null;
}

/** @brief 计入进行中的请求；对方中途断开时 -nocancel 让计数 10 秒后才回落。 */
function trackRunning(res, flags) {
  state.running += 1;
  res.on('close', () => {
    res.fakeClosed = true;
    if (!res.writableFinished && flags.has('nocancel')) setTimeout(() => { state.running -= 1; }, NOCANCEL_MS);
    else state.running -= 1;
  });
}

/** @brief 每个对话请求一行 JSON 日志。 */
function logRequest(req, body, probe, status) {
  const key = bearer(req);
  const roles = (body.messages ?? []).map((m) => m.role);
  const line = { port: req.socket.localPort, model: body.model ?? null, key: key ? key.slice(-4) : null, roles, status,
    probe };
  console.log(JSON.stringify(line));
}

/** @brief 把字符串切成小段，模拟逐字流式输出。 */
function pieces(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** @brief 一次回复的增量序列：[delta, 发完是否等一个分块间隔]。 */
function deltas(reply) {
  const out = [];
  for (const piece of pieces(reply.thinking ?? '', 4)) out.push([{ reasoning_content: piece }, true]);
  for (const piece of pieces(reply.text, 2)) out.push([{ content: piece }, true]);
  // 多个调用按 OpenAI 的分块格式：每个调用先发带 id 和名字的头，再分段发参数；tool_calls[].index 区分是第几个调用。
  for (const [index, call] of reply.toolCalls.entries()) {
    const head = { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } };
    out.push([{ tool_calls: [head] }, false]);
    for (const piece of pieces(JSON.stringify(call.args), 8)) {
      out.push([{ tool_calls: [{ index, function: { arguments: piece } }] }, true]);
    }
  }
  return out;
}

/**
 * @brief 以 SSE 方式发送一次流式回复；对方断开后停止。
 * @param opts { includeUsage, promptTokens, delayMs（第一个分块前等多久）, dropAfterFirst（发出第一段内容后断开） }
 */
async function streamReply(res, reply, opts) {
  const id = `chatcmpl-fake-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId };
  const open = () => !res.fakeClosed && !res.destroyed;
  const send = (choice) => open() && res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
  res.writeHead(200, SSE_HEADERS);
  await sleep(opts.delayMs);
  send({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null });
  for (const [delta, pause] of deltas(reply)) {
    if (!open()) return;
    send({ index: 0, delta, finish_reason: null });
    if (opts.dropAfterFirst) {
      // 等这一段真正发出去再断开，对方先收到内容、再看到连接中断
      await sleep(Math.max(chunkDelayMs, 50));
      res.destroy();
      return;
    }
    if (pause) await sleep(chunkDelayMs);
  }
  if (!open()) return;
  send({ index: 0, delta: {}, finish_reason: reply.toolCalls.length > 0 ? 'tool_calls' : 'stop' });
  if (opts.includeUsage) {
    const usage = { prompt_tokens: opts.promptTokens, completion_tokens: 20, total_tokens: opts.promptTokens + 20 };
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

/** @brief 不是探针的请求按 -404、-hang、-stall 处理；处理了返回 true。 */
function nonProbeSuffix(res, body, flags, log) {
  if (flags.has('404')) {
    log(404);
    sendJson(res, 404, errorBody(`The model \`${body.model}\` does not exist.`, 'NotFoundError', 404));
    return true;
  }
  if (flags.has('hang')) {
    log(null);
    return true;
  }
  if (flags.has('stall')) {
    log(200);
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    return true;
  }
  return false;
}

/** @brief 不是探针的回复：压缩请求回摘要，其他按关键词；-replay 开着思考时附思考。 */
function conversationReply(body, flags) {
  const messages = body.messages ?? [];
  if (isSummaryRequest(messages)) return summaryReply();
  const reply = planReply(messages, body.tools, body);
  if (flags.has('replay') && thinkingOn(body) && !reply.thinking) reply.thinking = REPLAY_THINKING;
  return reply;
}

/** @brief 给回复里的工具调用编 id；-replay 模型带思考发出的调用记下来。 */
function assignCallIds(reply, flags) {
  const stamp = Date.now();
  reply.toolCalls.forEach((call, index) => {
    call.id = `call_fake_${stamp}_${index}`;
    if (reply.thinking && flags.has('replay')) state.reasonedCalls.add(call.id);
  });
}

/** @brief 处理一个对话请求。 */
async function handleChat(req, res) {
  const body = await readJson(req);
  const messages = body.messages ?? [];
  const flags = flagsOf(body.model);
  const step = probeStep(messages);
  const log = (status) => logRequest(req, body, step > 0, status);
  trackRunning(res, flags);
  const replay = replayRejected(body, flags, state.reasonedCalls)
    ? { status: 400, body: errorBody(REPLAY_MESSAGE, 'invalid_request_error') } : null;
  const fail = (failure) => {
    log(failure.status);
    sendJson(res, failure.status, failure.body, failure.headers);
  };
  const early = keyFailure(bearer(req), true) ?? replay;
  if (early) return fail(early);
  if (step === 0 && nonProbeSuffix(res, body, flags, log)) return;
  const summary = step === 0 && isSummaryRequest(messages);
  const keyword = step > 0 || summary ? null : keywordFailure(messages);
  if (keyword) return fail(keyword);
  const reply = step > 0 ? probeReply(step, body, flags, config.maxModelLen) : conversationReply(body, flags);
  assignCallIds(reply, flags);
  const lastText = messages[messages.length - 1]?.role === 'user' ? contentText(messages.at(-1).content) : '';
  const keywords = step === 0 && !summary;
  const slow = body.model === 'fake-slow' || (keywords && /\bslow\b/.test(lastText));
  log(200);
  await streamReply(res, reply, {
    includeUsage: Boolean(body.stream_options?.include_usage),
    promptTokens: Math.ceil(JSON.stringify(messages).length / 4),
    delayMs: slow ? SLOW_MS : firstDelayMs + (reply.delayMs ?? 0),
    dropAfterFirst: keywords && lastText.includes('drop-after-first'),
  });
}

/** @brief Prometheus 文本：进行中与排队中的请求数（vLLM 的指标名）。 */
function metricsText() {
  const label = `{model_name="${config.models[0] ?? modelId}"}`;
  return [
    '# HELP vllm:num_requests_running Number of requests currently running.',
    '# TYPE vllm:num_requests_running gauge',
    `vllm:num_requests_running${label} ${state.running.toFixed(1)}`,
    '# HELP vllm:num_requests_waiting Number of requests waiting to be processed.',
    '# TYPE vllm:num_requests_waiting gauge',
    `vllm:num_requests_waiting${label} 0.0`,
    '',
  ].join('\n');
}

/** @brief GET 接口（/version、/metrics、/models）；处理了返回 true。 */
function handleGet(req, res, path) {
  if (path === '/version') {
    sendJson(res, 200, { version: config.version });
    return true;
  }
  if (path === '/metrics' && !config.noMetrics) {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(metricsText());
    return true;
  }
  if (!path.endsWith('/models')) return false;
  const failure = keyFailure(bearer(req), false);
  if (failure) {
    sendJson(res, failure.status, failure.body);
    return true;
  }
  const data = config.models.map((id) => ({ id, object: 'model', owned_by: 'fake',
    max_model_len: config.maxModelLen }));
  sendJson(res, 200, { object: 'list', data });
  return true;
}

const server = http.createServer(async (req, res) => {
  console.log(`[fake-endpoint] ${req.method} ${req.url}`);
  res.on('error', (error) => console.error('[fake-endpoint] response error', error));
  const path = (req.url ?? '').split('?')[0];
  try {
    if (req.method === 'GET' && handleGet(req, res, path)) return;
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      await handleChat(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    console.error('[fake-endpoint] error', error);
    if (!res.headersSent) sendJson(res, 400, errorBody(String(error)));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-endpoint] synthetic endpoint on http://127.0.0.1:${port}/v1 (model "${modelId}")`);
});
