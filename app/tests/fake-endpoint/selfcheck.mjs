// 合成测试端点（synthetic）的自检：在空闲端口上起几份 server.mjs（不同的环境变量），用 fetch 逐条检查
// docs/specs/model-providers.md §14.1 的行为与原有关键词，docs/specs/parallel-agents-taskboard.md §17.1 的脚本模式
// （scripts.mjs 的 tb-selfcheck-* 场景），以及 docs/specs/memory.md §14.1 的增强脚本（enhance.mjs，脚本文件写在临时目录）
// 与协作模式增强的场景 mem-team（scenarios/mem.mjs，依据由环境变量给），docs/specs/model-discovery.md §13.1 的发现行为
// （discovery.mjs 的每种 FAKE_LIST_SHAPE、FAKE_NO_V1_ROOT、FAKE_LIST_DELAY_MS、{port,path,key} 日志行、-alwaysthink），
// 以及 docs/specs/model-providers.md §7.7、§14.1 的 2026-10-24 补丁（-nooff 的 400 原文、/openrouter.ai/v1 前缀、
// 日志的 effort 字段、按 reasoning.effort 认出开了思考、-thinklong、-nooff 的判断顺序），
// 每条打印 PASS/FAIL；有 FAIL 时退出码为 1。
// 用法（在 app/ 下）：node tests/fake-endpoint/selfcheck.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOSE_REQUEST_TAGS, END_TEXT, KIND_ORDER, NO_STEP_TEXT, RESTART_PREFIX, SEGMENT_SENTENCES, SHARED_SENTENCE,
  WORK_CARD_CLOSE, WORK_CARD_OPEN } from './scripts.mjs';
import { ENHANCE_DONE } from './enhance.mjs';
import { MEM_TEAM_TEXT } from './scenarios/mem.mjs';
import { NOOFF_ERROR_BODY, THINKLONG_THINKING, explicitThinkingOff, requestedEffort, thinkingOn } from './probes.mjs';

const here = import.meta.dirname;
const overflowUrl = pathToFileURL(join(here, '..', '..', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils',
  'overflow.js')).href;
const { isContextOverflow } = await import(overflowUrl);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

/** @brief 记一条检查结果并打印。 */
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail}`}`);
}

/** @brief 取一个空闲端口。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** @brief 起一份端点，等启动行出现；返回 { port, lines, kill }。 */
async function startEndpoint(extraEnv) {
  const port = await freePort();
  const env = { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '5', ...extraEnv };
  const child = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop();
    lines.push(...parts);
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  for (let i = 0; i < 100 && !lines.some((line) => line.includes('synthetic')); i += 1) await sleep(50);
  return { port, lines, kill: () => child.kill() };
}

/** @brief 处理一个 SSE 数据块，累加到 out。 */
function takeEvent(raw, out) {
  const data = raw.replace(/^data: /, '');
  if (data === '[DONE]') {
    out.done = true;
    return;
  }
  const chunk = JSON.parse(data);
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta ?? {};
    if (delta.content) out.text += delta.content;
    if (delta.reasoning_content) out.reasoning += delta.reasoning_content;
    if (choice.finish_reason) out.finish = choice.finish_reason;
    for (const call of delta.tool_calls ?? []) {
      out.calls[call.index] ??= { id: call.id, name: call.function?.name, args: '' };
      out.calls[call.index].args += call.function?.arguments ?? '';
    }
    if (delta.content || delta.reasoning_content || delta.tool_calls) {
      out.contentChunks += 1;
      out.firstAt ??= Date.now();
      // 第一段内容是什么：reasoning、content 或 tool（-alwaysthink 要求思考在最前面）
      out.firstKind ??= delta.reasoning_content ? 'reasoning' : delta.content ? 'content' : 'tool';
    }
  }
}

/** @brief 读 SSE 响应体。 */
async function readStream(res, out) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      takeEvent(buffer.slice(0, at), out);
      buffer = buffer.slice(at + 2);
    }
  }
}

/**
 * @brief 发一个流式对话请求。
 * @param opts { key, timeoutMs, path（请求路径，默认 /v1/chat/completions） }
 * @return { status, headers, body（错误体，不是 JSON 时为 null）, raw（错误体原文）, text, reasoning, calls,
 *         contentChunks, done, error, startedAt, firstAt, finish（最后的 finish_reason） }
 */
async function chat(port, body, opts = {}) {
  const controller = new AbortController();
  const headers = { 'Content-Type': 'application/json' };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
  const out = { status: 0, text: '', reasoning: '', calls: [], contentChunks: 0, done: false, error: null,
    startedAt: Date.now(), firstAt: null, firstKind: null, finish: null };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${opts.path ?? '/v1/chat/completions'}`, { method: 'POST',
      headers, body: JSON.stringify({ model: 'fake-coder', stream: true, ...body }), signal: controller.signal });
    out.status = res.status;
    out.headers = res.headers;
    if (!res.ok) {
      out.raw = await res.text().catch(() => null);
      out.body = out.raw === null ? null : parsed(out.raw);
    } else await readStream(res, out);
  } catch (error) {
    out.error = error.name === 'AbortError' ? 'aborted' : String(error.cause?.code ?? error.message);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return out;
}

/** @brief GET 一个路径，返回 { status, text }。 */
async function get(port, path, key) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, text: await res.text() };
}

const user = (content) => ({ role: 'user', content });
const SYSTEM = { role: 'system', content: 'You are a coding agent.' };
const weatherTool = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } };
const outcomeTool = { type: 'function', function: { name: 'submit_outcome', parameters: { type: 'object' } } };
const WEATHER = 'Use the tool to get the weather for Paris for the next 3 days.';
const SCHEMA = { type: 'json_schema', json_schema: { name: 'outcome', schema: { type: 'object' }, strict: true } };

/** @brief 第 4 步的对话：第 3 步的调用、工具结果、再问温度。 */
function step4Messages(call, reasoning) {
  const assistant = { role: 'assistant', content: null,
    tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] };
  if (reasoning !== undefined) assistant.reasoning_content = reasoning;
  return [user(WEATHER), assistant, { role: 'tool', tool_call_id: call.id, content: 'Paris: 21°C, sunny for 3 days.' },
    user('What temperature did the tool report?')];
}

/** @brief GET 接口：/version、/models、/api/version、/props。 */
async function checkGets(a, c) {
  const version = await get(a.port, '/version');
  record('GET /version returns FAKE_SERVER_VERSION in vLLM shape', JSON.parse(version.text).version === '0.9.9',
    version.text);
  const defaultVersion = await get(c.port, '/version');
  record('GET /version defaults to {"version":"0.10.1"}', JSON.parse(defaultVersion.text).version === '0.10.1');
  const models = JSON.parse((await get(a.port, '/v1/models', 'key-aaaa1')).text);
  const coder = models.data.find((m) => m.id === 'fake-coder');
  record('GET /v1/models lists fake-coder with max_model_len', coder?.max_model_len === 4000, JSON.stringify(models));
  record('GET /v1/models checks the key (401 without one)', (await get(a.port, '/v1/models')).status === 401);
  record('GET /api/version and /props are 404',
    (await get(a.port, '/api/version')).status === 404 && (await get(a.port, '/props')).status === 404);
}

/** @brief 认证：FAKE_KEYS、FAKE_QUOTA_KEYS、FAKE_LIMITED_KEYS + FAKE_LIMIT_MS、FAKE_REQUIRE_KEY、"none"。 */
async function checkKeys(a, b, c) {
  const plain = { messages: [user('plain')] };
  record('FAKE_KEYS: missing key is 401', (await chat(a.port, plain)).status === 401);
  record('FAKE_KEYS: unknown key is 401', (await chat(a.port, plain, { key: 'key-zzzz9' })).status === 401);
  record('FAKE_KEYS: accepted key streams 200', (await chat(a.port, plain, { key: 'key-aaaa1' })).done);
  const quota = await chat(a.port, plain, { key: 'key-cccc3' });
  record('FAKE_QUOTA_KEYS: 402 insufficient_quota',
    quota.status === 402 && quota.body?.error?.code === 'insufficient_quota', JSON.stringify(quota.body));
  const limited = await chat(a.port, plain, { key: 'key-bbbb2' });
  const retryAfter = Number(limited.headers?.get('retry-after'));
  record('FAKE_LIMITED_KEYS: 429 with Retry-After seconds',
    limited.status === 429 && retryAfter >= 1 && retryAfter <= 2,
    `${limited.status} ${retryAfter}`);
  await sleep(1600);
  record('FAKE_LIMIT_MS: the limited key recovers', (await chat(a.port, plain, { key: 'key-bbbb2' })).done);
  record('FAKE_REQUIRE_KEY: wrong key is 401', (await chat(b.port, plain, { key: 'nope' })).status === 401);
  record('FAKE_REQUIRE_KEY: right key streams 200', (await chat(b.port, plain, { key: 'req-key-1' })).done);
  const keyless = await chat(c.port, plain);
  record('FAKE_LIMITED_KEYS=none: keyless request is 429, Retry-After 60 without FAKE_LIMIT_MS',
    keyless.status === 429 && keyless.headers.get('retry-after') === '60');
}

/** @brief 探针第 1–7 步在 fake-coder 上全通过。 */
async function checkProbesPass(a) {
  const key = 'key-aaaa1';
  const ready = await chat(a.port, { messages: [user('Reply with the single word: ready.')] }, { key });
  record('probe 1: "ready" with no reasoning when thinking is off', ready.text === 'ready' && ready.reasoning === '');
  const readyThinking = { messages: [user('Reply with the single word: ready.')], reasoning_effort: 'medium' };
  const think = await chat(a.port, readyThinking, { key });
  record('probe 1/2: reasoning_content when thinking is on', think.text === 'ready' && think.reasoning.length > 0);
  const weather = await chat(a.port, { messages: [user(WEATHER)], tools: [weatherTool] }, { key });
  const args = JSON.parse(weather.calls[0]?.args ?? '{}');
  record('probe 3: calls get_weather with city string and integer days',
    weather.calls[0]?.name === 'get_weather' && args.city === 'Paris' && Number.isInteger(args.days), weather.calls);
  const temp = await chat(a.port, { messages: step4Messages(weather.calls[0]), tools: [weatherTool] }, { key });
  record('probe 4: answer contains 21', temp.status === 200 && temp.text.includes('21'), temp.text);
  const choice = { type: 'function', function: { name: 'submit_outcome' } };
  const outcome = await chat(a.port, { messages: [user('Call submit_outcome with outcome banana.')],
    tools: [outcomeTool], tool_choice: choice }, { key });
  record('probe 5: calls submit_outcome with an enum value',
    outcome.calls[0]?.name === 'submit_outcome' && JSON.parse(outcome.calls[0].args).outcome === 'ok');
  const json = await chat(a.port, { messages: [user('Reply with JSON whose outcome is banana.')],
    response_format: SCHEMA }, { key });
  record('probe 6: JSON with outcome in the enum', JSON.parse(json.text).outcome === 'ok', json.text);
  const tags = await chat(a.port, { messages: [user('Answer as <summary>...</summary><outcome>ok|fail</outcome>: '
    + 'is the sky blue?')] }, { key });
  record('probe 7: parsable summary/outcome tags',
    /^<summary>.+<\/summary><outcome>(ok|fail)<\/outcome>$/.test(tags.text), tags.text);
}

/** @brief 后缀关掉的探针能力：-notools、-nochoice、-noschema。 */
async function checkProbeSuffixes(a) {
  const key = 'key-aaaa1';
  const weather = await chat(a.port, { model: 'fake-coder-notools', messages: [user(WEATHER)], tools: [weatherTool] },
    { key });
  record('-notools: probe 3 answers without a tool call', weather.calls.length === 0 && weather.text.length > 0);
  const choice = { type: 'function', function: { name: 'submit_outcome' } };
  const outcome = await chat(a.port, { model: 'fake-coder-nochoice',
    messages: [user('Call submit_outcome with outcome banana.')], tools: [outcomeTool], tool_choice: choice }, { key });
  record('-nochoice: probe 5 ignores the forced call', outcome.calls.length === 0, outcome.text);
  const json = await chat(a.port, { model: 'fake-coder-noschema',
    messages: [user('Reply with JSON whose outcome is banana.')], response_format: SCHEMA }, { key });
  record('-noschema: probe 6 ignores the schema', JSON.parse(json.text).outcome === 'banana', json.text);
}

/** @brief -replay：开思考时带 reasoning_content；"不带"推理内容的回传被 400 拒绝，"带上"通过。 */
async function checkReplay(a) {
  const key = 'key-aaaa1';
  const model = 'fake-coder-replay';
  const thinkingWeather = { model, messages: [user(WEATHER)], tools: [weatherTool], reasoning_effort: 'medium' };
  const first = await chat(a.port, thinkingWeather, { key });
  record('-replay: thinking on returns reasoning_content with the tool call',
    first.reasoning.length > 0 && first.calls[0]?.name === 'get_weather');
  const call = first.calls[0];
  const withIt = await chat(a.port, { model, messages: step4Messages(call, first.reasoning), tools: [weatherTool],
    reasoning_effort: 'medium' }, { key });
  record('-replay: follow-up with reasoning_content passes', withIt.status === 200 && withIt.text.includes('21'));
  const without = await chat(a.port, { model, messages: step4Messages(call), tools: [weatherTool],
    reasoning_effort: 'medium' }, { key });
  record('-replay: follow-up without reasoning_content is 400 (thinking on)', without.status === 400,
    JSON.stringify(without.body));
  const offWithout = await chat(a.port, { model, messages: step4Messages(call), tools: [weatherTool] }, { key });
  record('-replay: a reasoned call replayed without reasoning_content is 400 even with thinking off',
    offWithout.status === 400);
  const plainCall = await chat(a.port, { model, messages: [user(WEATHER)], tools: [weatherTool] }, { key });
  const plainFollow = await chat(a.port, { model, messages: step4Messages(plainCall.calls[0]), tools: [weatherTool] },
    { key });
  record('-replay: thinking off end to end passes (tool calling probe unaffected)', plainFollow.status === 200);
  const normal = await chat(a.port, { model: 'fake-coder', messages: step4Messages(call), tools: [weatherTool],
    reasoning_effort: 'medium' }, { key });
  record('without -replay the same follow-up passes', normal.status === 200);
  const chatReply = await chat(a.port, { model, messages: [user('plain')], reasoning_effort: 'high' }, { key });
  record('-replay: non-probe reply carries reasoning_content when thinking is on', chatReply.reasoning.length > 0);
}

/** @brief 只作用于非探针请求的后缀：-404、-400、-hang、-stall。 */
async function checkNonProbeSuffixes(a) {
  const key = 'key-aaaa1';
  const probe = { messages: [user('Reply with the single word: ready.')] };
  const plain = { messages: [user('plain')] };
  for (const suffix of ['404', '400', 'hang', 'stall']) {
    const passed = await chat(a.port, { ...probe, model: `fake-coder-${suffix}` }, { key, timeoutMs: 2000 });
    record(`-${suffix}: probes are unaffected`, passed.done && passed.text === 'ready');
  }
  const missing = await chat(a.port, { ...plain, model: 'fake-coder-404' }, { key });
  record('-404: non-probe request is 404', missing.status === 404);
  const bad = await chat(a.port, { ...plain, model: 'fake-coder-400' }, { key });
  record('-400: non-probe request is 400', bad.status === 400);
  const hang = await chat(a.port, { ...plain, model: 'fake-coder-hang' }, { key, timeoutMs: 600 });
  record('-hang: no response headers', hang.status === 0 && hang.error === 'aborted');
  const stall = await chat(a.port, { ...plain, model: 'fake-coder-stall' }, { key, timeoutMs: 600 });
  record('-stall: headers 200 then no content', stall.status === 200 && stall.contentChunks === 0
    && stall.error === 'aborted');
}

/** @brief 关键词 http-NNN、http-NNN-once。 */
async function checkHttpKeywords(a) {
  const key = 'key-aaaa1';
  const twice = [await chat(a.port, { messages: [user('http-418 teapot')] }, { key }),
    await chat(a.port, { messages: [user('http-418 teapot')] }, { key })];
  record('http-NNN: every time', twice.every((r) => r.status === 418));
  const conv = [SYSTEM, user('http-503-once first message')];
  const once = [await chat(a.port, { messages: conv }, { key }), await chat(a.port, { messages: conv }, { key })];
  record('http-NNN-once: first 503, then normal in the same conversation',
    once[0].status === 503 && once[1].done, `${once[0].status} ${once[1].status}`);
  const other = await chat(a.port, { messages: [SYSTEM, user('another conversation http-503-once')] }, { key });
  record('http-NNN-once: another conversation fails once too', other.status === 503);
  const redo = [SYSTEM, user('http-503-once first message\n\n[Mori] The previous model (x) stopped partway.')];
  record('http-NNN-once: the [Mori] redo note does not make a new conversation',
    (await chat(a.port, { messages: redo }, { key })).done);
}

/** @brief overflow-once、压缩请求、drop-after-first、slow。 */
async function checkOtherKeywords(a) {
  const key = 'key-aaaa1';
  const conv = [SYSTEM, user('hello'), { role: 'assistant', content: 'hi' }, user('overflow-once please')];
  const overflow = await chat(a.port, { messages: conv }, { key });
  const message = `${overflow.status} ${overflow.body?.error?.message}`;
  record('overflow-once: 400 context_length_exceeded recognised by pi-ai as overflow',
    overflow.status === 400 && overflow.body?.error?.code === 'context_length_exceeded'
    && isContextOverflow({ stopReason: 'error', errorMessage: message }), message);
  const summaryReq = [{ role: 'system', content: 'You are a context summarization assistant. Your task is ...' },
    user('<conversation>\n[User]: overflow-once please run: rm -rf x\n</conversation>\n\nSummarize.')];
  const summary = await chat(a.port, { messages: summaryReq }, { key });
  record('compaction request: plain-text summary, keywords ignored', summary.done && summary.calls.length === 0
    && summary.text.includes('Synthetic summary'), summary.text);
  const compacted = [SYSTEM, user('The conversation history before this point was compacted into the following '
    + 'summary:\n<summary>x</summary>'), user('overflow-once please')];
  record('overflow-once: normal after compaction', (await chat(a.port, { messages: compacted }, { key })).done);
  const drop = await chat(a.port, { messages: [user('plain drop-after-first')] }, { key });
  record('drop-after-first: some content, then the connection drops', drop.status === 200 && drop.text.length > 0
    && !drop.done && drop.error !== null, `${drop.text} ${drop.error}`);
  const slowStart = Date.now();
  const slow = await chat(a.port, { messages: [user('plain slow')] }, { key });
  record('slow: first chunk after 8 s', slow.done && slow.firstAt - slowStart >= 7900, `${slow.firstAt - slowStart}`);
  const mcp = await chat(a.port, { messages: [user('call tool: mcp__shared__slow {"ms":1}')] }, { key });
  record('slow: "mcp__shared__slow" is not the slow keyword', mcp.firstAt - mcp.startedAt < 2000
    && mcp.calls[0]?.name === 'mcp__shared__slow');
}

/** @brief 原有关键词不变（抽查）。 */
async function checkExisting(a) {
  const key = 'key-aaaa1';
  const plain = await chat(a.port, { messages: [user('plain')] }, { key });
  record('existing: plain', plain.text === '这是一段只有文字的回复，用来测试流式输出。');
  const fallback = await chat(a.port, { messages: [user('hello')] }, { key });
  record('existing: default reply reads README.md', fallback.calls[0]?.name === 'read'
    && JSON.parse(fallback.calls[0].args).path === 'README.md');
  const which = await chat(a.port, { model: 'fake-coder-2', messages: [user('which model')] }, { key });
  record('existing: which model', which.text === '模型：fake-coder-2');
  const two = await chat(a.port, { messages: [user('two commands: echo a ;; echo b')] }, { key });
  record('existing: two commands', two.calls.length === 2 && two.calls[0].id !== two.calls[1].id);
  const tool = await chat(a.port, { messages: [user('x'), { role: 'tool', content: 'Rejected by user' }] }, { key });
  record('existing: rejected tool result', tool.text.startsWith('收到拒绝：Rejected'));
  const think = await chat(a.port, { messages: [user('thinking check')], reasoning_effort: 'low' }, { key });
  record('existing: thinking check', think.text === '收到思考参数：low' && think.reasoning.length > 0);
  const usage = await chat(a.port, { messages: [user('plain')], stream_options: { include_usage: true } }, { key });
  record('existing: usage chunk with include_usage', usage.done);
}

/** @brief 日志：METHOD url 行、启动的 synthetic 行、每个对话请求一行 JSON（发现请求的 JSON 行带 path，另查）。 */
function checkLogs(a) {
  record('log: startup line mentions synthetic', a.lines.some((l) => l.includes('synthetic')));
  record('log: "METHOD url" lines kept', a.lines.some((l) => l === '[fake-endpoint] POST /v1/chat/completions'));
  const json = jsonLines(a);
  const fields = json.every((e) => ['port', 'model', 'key', 'roles', 'status', 'probe'].every((k) => k in e));
  record('log: one JSON line per chat request with all fields', json.length > 0 && fields
    && json.length === a.lines.filter((l) => l.endsWith('POST /v1/chat/completions')).length);
  record('log: key is the last 4 characters', json.some((e) => e.key === 'aaa1') && json.every((e) => !e.key
    || e.key.length === 4));
  record('log: probe flag', json.some((e) => e.probe === true) && json.some((e) => e.probe === false));
  record('log: roles sequence and status', json.some((e) => e.roles.join() === 'user,assistant,tool,user')
    && json.some((e) => e.status === 429) && json.some((e) => e.status === null && e.model === 'fake-coder-hang'));
}

// ---------- 脚本模式（scripts.mjs，synthetic） ----------

/** 日志行在原有字段之外另加的字段 */
const SCRIPT_LOG_FIELDS = ['agent', 'kind', 'task', 'scenario', 'k', 'j', 'tools', 'toolChoice', 'format', 'calls',
  'strictTools', 'reasoning'];

const sys = (...lines) => ({ role: 'system', content: lines.join('\n') });
/** @brief 附录 A 句子里的 <…> 填上一个值（<n> 为 1，其余为 planner）。 */
const sample = (sentence) => sentence.replace(/<[^>]+>/g, (slot) => (slot === '<n>' ? '1' : 'planner'));
const card = (...lines) => user([WORK_CARD_OPEN, ...lines, WORK_CARD_CLOSE].join('\n'));
const said = (content) => ({ role: 'assistant', content });
const choose = (name) => ({ type: 'function', function: { name } });

/** @brief 一次工具调用与它的结果（结果开头带程序加的 "[#n] "）。 */
function toolTurn(id, name, args, result) {
  const callMessage = { role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
  return [callMessage, { role: 'tool', tool_call_id: id, content: result }];
}

/** @brief 严格版本的工具（全部字段 required、additionalProperties: false、strict）。 */
function strictTool(name, fields) {
  const properties = Object.fromEntries(fields.map((field) => [field, {}]));
  const parameters = { type: 'object', properties, required: fields, additionalProperties: false };
  return { type: 'function', function: { name, parameters, strict: true } };
}

const HANDOFF_TOOL = strictTool('task_handoff', ['task', 'conclusion', 'outcome', 'next', 'open_items', 'evidence']);
const CLOSE_TOOL = strictTool('request_close', ['request', 'outcome', 'conclusion']);
const HANDOFF_SCHEMA = { type: 'json_schema',
  json_schema: { name: 'task_handoff', schema: HANDOFF_TOOL.function.parameters, strict: true } };

const TASK_SYSTEM = sys('You fix code. MORI-ROLE-executor', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.task);
const TASK_CARD = card('You are executor on T1 (request 1).', 'Request 1: Fix the login page', "User's words:",
  '- [10:00] "Fix the login page tb-scenario:tb-selfcheck-task"', 'Task T1: Find and fix · changes files');
const TASK_START = user('[Mori] You are executor on T1 (request 1). Start work.');
const READ_DONE = toolTurn('call_r1', 'read', { path: 'README.md' }, '[#1] # Smoke project');
const FORCED = user('[Mori] Your turn ended without task_handoff. Hand off T1 now.');
const RETRY = user('[Mori] Your handoff could not be used: outcome is required. Hand off T1 now.');
/** @brief task 实例的请求：system、第一次投递、中间的消息、工作卡在最后。 */
const taskTurn = (...rest) => [TASK_SYSTEM, TASK_START, ...rest, TASK_CARD];
const forcedTask = () => taskTurn(...READ_DONE, said('I read it.'), FORCED);
const retryTask = () => taskTurn(...READ_DONE, said('I read it.'), FORCED, said('<outcome>'), RETRY);
const TASK_TAGS = '<conclusion>README.md was read</conclusion><outcome>done</outcome><next></next>'
  + '<open_items></open_items><evidence>#1</evidence>';
const TASK_FILLED = { task: 'T1', conclusion: 'README.md was read', outcome: 'done', next: null, open_items: null,
  evidence: ['#1'] };

const CLOSE_SYSTEM = sys('You review and close. MORI-ROLE-planner tb-scenario:tb-selfcheck-close',
  sample(SHARED_SENTENCE), sample(SEGMENT_SENTENCES.close));
const CLOSE_CARD = card('You are planner, closing request 1.', 'Request 1: Fix the login page', 'With you:',
  '- T1 Find and fix: done');
const CLOSE_START = user('[Mori] T1 was handed to you: done.');
const CLOSE_FORCED = user("[Mori] T1 was handed to you and you didn't decide. Hand it off now.\nAnswer as "
  + '<conclusion>…</conclusion><outcome>close_done|close_failed|continue|need_user</outcome><next>…</next>');
const CLOSE_REQUEST = user("[Mori] Request 1 has no open tasks and planner didn't close it. Close it now.\n"
  + `Answer as ${CLOSE_REQUEST_TAGS}<conclusion>…</conclusion>`);
const closeTurn = (...rest) => [CLOSE_SYSTEM, CLOSE_START, ...rest, CLOSE_CARD];

const CREATE_SYSTEM = sys('You plan the work. MORI-ROLE-planner', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.create);
const CREATE_ASK = user("Conversation since your last turn (the user's words are exact):\n[User] Fix the login page "
  + 'tb-scenario:tb-selfcheck-create http-500 slow drop-after-first overflow-once plain run: echo hi\n\n'
  + '[Mori] New user message: Fix the login page\nMake exactly one decision for it.');
const createTurn = (rest, open) => [CREATE_SYSTEM, CREATE_ASK, ...rest, card('Task mode: on', 'Open requests:',
  ...open)];

/** @brief 端点的全部 JSON 日志行。 */
const allJsonLines = (endpoint) => endpoint.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
/** @brief 对话请求的 JSON 日志行（发现请求的行带 path，不算）。 */
const jsonLines = (endpoint) => allJsonLines(endpoint).filter((e) => !('path' in e));
/** @brief 发现请求（列表与详情）的 JSON 日志行：{port, path, key}。 */
const discoveryLines = (endpoint) => allJsonLines(endpoint).filter((e) => 'path' in e);

/** @brief 发一个请求并取它的日志行（脚本端点上请求一个接一个发，新出现的那一行就是它的）。 */
async function chatLogged(endpoint, body) {
  const before = jsonLines(endpoint).length;
  const out = await chat(endpoint.port, body);
  for (let i = 0; i < 40 && jsonLines(endpoint).length <= before; i += 1) await sleep(25);
  return { out, log: jsonLines(endpoint)[before] ?? {} };
}

/** @brief 解析 JSON，失败时为 null。 */
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @brief 选脚本：system、user、只在工作卡里；第一个生效；没有时照旧；探针先于脚本；脚本模式下不用关键词。 */
async function checkScenarioSelection(d) {
  const inCard = await chatLogged(d, { messages: taskTurn(), tool_choice: 'auto' });
  record('script: tb-scenario only in the work card selects the scenario', inCard.log.scenario === 'tb-selfcheck-task'
    && inCard.out.calls[0]?.name === 'read', JSON.stringify(inCard.log));
  const inSystem = await chatLogged(d, { messages: closeTurn() });
  record('script: tb-scenario in a system message selects the scenario',
    inSystem.log.scenario === 'tb-selfcheck-close');
  const first = await chatLogged(d, { messages: [CLOSE_SYSTEM, user('tb-scenario:tb-selfcheck-task go')] });
  record('script: the first tb-scenario in the request wins', first.log.scenario === 'tb-selfcheck-close');
  const none = await chatLogged(d, { messages: [SYSTEM, user('plain')] });
  record('script: without tb-scenario the keyword rules apply and scenario is null', none.log.scenario === null
    && none.out.text === '这是一段只有文字的回复，用来测试流式输出。');
  const probe = await chatLogged(d, { messages: [sys('tb-scenario:tb-selfcheck-task'),
    user('Reply with the single word: ready.')] });
  record('script: probes are recognised before scripts', probe.out.text === 'ready' && probe.log.probe === true);
  const create = await chatLogged(d, { messages: createTurn([], []) });
  record('script: tb-scenario in a user message; keywords and failure keywords are not used',
    create.log.scenario === 'tb-selfcheck-create' && create.out.done && create.out.status === 200
    && create.out.calls[0]?.name === 'request_submit' && create.out.firstAt - create.out.startedAt < 2000,
    `${create.out.status} ${create.out.text} ${JSON.stringify(create.out.calls)}`);
  const unknown = await chatLogged(d, { messages: [user('tb-scenario:tb-no-such-scenario')] });
  record('script: no step for the request answers NO_STEP_TEXT', unknown.out.text === NO_STEP_TEXT
    && unknown.log.scenario === 'tb-no-such-scenario');
}

/** @brief 认会话：每个附录 A 段的种类、优先级、句子不在行首、角色标记与基座。 */
async function checkKinds(d) {
  const wrong = [];
  for (const kind of KIND_ORDER) {
    const messages = [sys(`Body of x. MORI-ROLE-x${kind}`, sample(SHARED_SENTENCE), sample(SEGMENT_SENTENCES[kind])),
      user('plain')];
    const { log } = await chatLogged(d, { messages });
    if (log.kind !== kind || log.agent !== `x${kind}`) wrong.push(`${kind}: ${log.kind}/${log.agent}`);
  }
  record('script: kind recognised for every Appendix A segment (from the shared sentence list)', wrong.length === 0,
    wrong.join('; '));
  const base = await chatLogged(d, { messages: [SYSTEM, user('plain')] });
  record('script: no segment is the off-mode dialog of the base agent', base.log.kind === 'dialog'
    && base.log.agent === 'mori' && base.log.task === null);
  const merged = await chatLogged(d, { messages: [sys(SEGMENT_SENTENCES.create,
    SEGMENT_SENTENCES['merged-create']), user('plain')] });
  const close = await chatLogged(d, { messages: [sys(SEGMENT_SENTENCES.task, sample(SEGMENT_SENTENCES.close)),
    user('plain')] });
  record('script: kind priority (merged-create before create, close before task)',
    merged.log.kind === 'merged-create' && close.log.kind === 'close', `${merged.log.kind} ${close.log.kind}`);
  const inline = await chatLogged(d, { messages: [sys(`Some body text. ${SEGMENT_SENTENCES.ask} More.`),
    user('plain')] });
  record('script: the first sentence need not start a line', inline.log.kind === 'ask');
}

/** @brief 步骤位置：工作卡不算投递；工具结果不算投递；j 从最后一次投递算起；restart 另记。 */
async function checkPositions(d) {
  const start = await chatLogged(d, { messages: taskTurn() });
  record('script: k=1 j=0 with a trailing work card; task from the work card', start.log.k === 1
    && start.log.j === 0 && start.log.task === 'T1' && start.log.agent === 'executor' && start.log.kind === 'task',
    JSON.stringify(start.log));
  const after = await chatLogged(d, { messages: taskTurn(...READ_DONE) });
  const args = parsed(after.out.calls[0]?.args ?? '');
  record('script: a tool result is not a delivery (k=1 j=1); {task} and {tag:read} filled',
    after.log.k === 1 && after.log.j === 1 && after.out.calls[0]?.name === 'task_handoff' && args?.task === 'T1'
    && args?.evidence?.[0] === '#1', `${JSON.stringify(after.log)} ${after.out.calls[0]?.args}`);
  const forced = await chatLogged(d, { messages: forcedTask() });
  record('script: j counts from the last delivery (k=2 j=0)', forced.log.k === 2 && forced.log.j === 0);
  const restart = await chatLogged(d, { messages: [TASK_SYSTEM,
    user(`${RESTART_PREFIX} (fake-a → fake-b: rate limited). Continue T1 on the new model from the work card.`),
    TASK_CARD] });
  record('script: a restart delivery is keyed separately (k=restart-1) and end() stops without a handoff',
    restart.log.k === 'restart-1' && restart.log.j === 0 && restart.out.text === END_TEXT
    && restart.out.calls.length === 0, JSON.stringify(restart.log));
  const beyond = await chatLogged(d, { messages: taskTurn(...READ_DONE, said('x'), FORCED, said('y'), RETRY,
    said('z'), RETRY) });
  record('script: a delivery without steps answers NO_STEP_TEXT', beyond.log.k === 4
    && beyond.out.text === NO_STEP_TEXT);
}

/** @brief 交接单的 A/B/C 写法（task 实例）与 -nochoice、-noschema。 */
async function checkTiers(d) {
  const a = await chatLogged(d, { messages: forcedTask(), tools: [HANDOFF_TOOL], tool_choice: choose('task_handoff') });
  const aArgs = parsed(a.out.calls[0]?.args ?? '');
  record('script: A calls task_handoff; strict schema fields not given are null',
    a.out.calls[0]?.name === 'task_handoff' && JSON.stringify(aArgs) === JSON.stringify(TASK_FILLED)
    && a.log.toolChoice === 'task_handoff' && a.log.calls.join() === 'task_handoff', a.out.calls[0]?.args);
  const b = await chatLogged(d, { messages: forcedTask(), tools: [HANDOFF_TOOL], response_format: HANDOFF_SCHEMA });
  record('script: B answers the JSON of the handoff form (strict: nulls filled)', b.out.calls.length === 0
    && JSON.stringify(parsed(b.out.text)) === JSON.stringify(TASK_FILLED) && b.log.format === 'json_schema',
    b.out.text);
  const c = await chatLogged(d, { messages: forcedTask(), tools: [HANDOFF_TOOL] });
  record('script: C answers the task instance tags of §7.5', c.out.text === TASK_TAGS && c.out.calls.length === 0,
    c.out.text);
  const noChoice = await chatLogged(d, { model: 'fake-coder-nochoice', messages: forcedTask(), tools: [HANDOFF_TOOL],
    tool_choice: choose('task_handoff') });
  record('script: -nochoice ignores the forced call and answers in C tags', noChoice.out.calls.length === 0
    && noChoice.out.text === TASK_TAGS, noChoice.out.text);
  const noSchema = await chatLogged(d, { model: 'fake-coder-noschema', messages: forcedTask(),
    response_format: HANDOFF_SCHEMA });
  record('script: -noschema ignores response_format and answers in C tags', noSchema.out.text === TASK_TAGS,
    noSchema.out.text);
}

/** @brief 结案会话：交接与关闭需求、结案的标签、强制关闭的标签与 A 级调用、{request} 是数字。 */
async function checkClose(d) {
  const first = await chatLogged(d, { messages: closeTurn() });
  const handed = parsed(first.out.calls[0]?.args ?? '');
  record('script: close session hands off the task named in the delivery', first.log.kind === 'close'
    && first.log.task === null && handed?.task === 'T1' && handed?.outcome === 'close_done', JSON.stringify(handed));
  const closing = await chatLogged(d, { messages: closeTurn(...toolTurn('call_c1', 'task_handoff', handed, 'ok')) });
  const closeArgs = parsed(closing.out.calls[0]?.args ?? '');
  record('script: {request} becomes the request number', closing.out.calls[0]?.name === 'request_close'
    && closeArgs?.request === 1, closing.out.calls[0]?.args);
  const forced = await chatLogged(d, { messages: closeTurn(said('Looking.'), CLOSE_FORCED) });
  record('script: C for a close session uses the close tags', forced.out.text
    === '<conclusion>Fixed and verified</conclusion><outcome>close_done</outcome><next></next>', forced.out.text);
  const rest = [said('Looking.'), CLOSE_FORCED, said('Done.'), CLOSE_REQUEST];
  const tags = await chatLogged(d, { messages: closeTurn(...rest) });
  record('script: C for a forced request_close uses its tags', tags.out.text
    === '<outcome>done</outcome><conclusion>The login page works again</conclusion>', tags.out.text);
  const viaA = await chatLogged(d, { messages: closeTurn(...rest), tools: [CLOSE_TOOL],
    tool_choice: choose('request_close') });
  const aArgs = parsed(viaA.out.calls[0]?.args ?? '');
  record('script: A for a forced request_close calls request_close', viaA.out.calls[0]?.name === 'request_close'
    && aArgs?.request === 1 && aArgs?.outcome === 'done', viaA.out.calls[0]?.args);
}

/** @brief malformed（A/B/C 都用不了）、fail({ model }) 只对那个模型且不占步骤、wait、{lastResult}。 */
async function checkFailuresAndTemplates(d) {
  const a = await chatLogged(d, { messages: retryTask(), tools: [HANDOFF_TOOL], tool_choice: choose('task_handoff') });
  const aRaw = a.out.calls[0]?.args ?? '';
  record('script: malformed A sends arguments that are not JSON and stop before outcome',
    a.out.calls[0]?.name === 'task_handoff' && parsed(aRaw) === null && aRaw.endsWith('"outcome":'), aRaw);
  const b = await chatLogged(d, { messages: retryTask(), response_format: HANDOFF_SCHEMA });
  record('script: malformed B answers text that is not JSON', parsed(b.out.text) === null, b.out.text);
  const c = await chatLogged(d, { messages: retryTask() });
  record('script: malformed C answers tags without an outcome', c.out.text.endsWith('<outcome>')
    && !c.out.text.includes('</outcome>'), c.out.text);
  const down = await chatLogged(d, { model: 'fake-down', messages: taskTurn() });
  record('script: fail(503, { model }) fails for that model', down.out.status === 503 && down.log.status === 503
    && down.log.calls.length === 0, `${down.out.status}`);
  const other = await chatLogged(d, { model: 'fake-other', messages: taskTurn() });
  record('script: fail does not apply to other models and does not take a step', other.out.calls[0]?.name === 'read');
  const created = createTurn([...toolTurn('call_s1', 'request_submit', {}, 'Request 1 registered'),
    ...toolTurn('call_t1', 'task_create', {}, 'T1 created')], ['Request 1 · Fix the login page · open']);
  const reply = await chatLogged(d, { messages: created });
  record('script: wait delays the reply; {request} and {lastResult:<tool>} filled',
    reply.out.firstAt - reply.out.startedAt >= 300 && reply.out.text === 'Registered request 1: Request 1 registered',
    `${reply.out.firstAt - reply.out.startedAt} ${reply.out.text}`);
  const task = await chatLogged(d, { messages: createTurn(toolTurn('call_s1', 'request_submit', {}, 'ok'),
    ['Request 1 · Fix the login page · open']) });
  record('script: create session registers then creates a task with the request number',
    task.out.calls[0]?.name === 'task_create' && parsed(task.out.calls[0].args)?.request === 1);
}

/** @brief 工具调用 id 在并行的请求之间不重复；日志行带全部新字段。 */
async function checkIdsAndLog(d, a) {
  const parallel = await Promise.all(Array.from({ length: 6 }, () => chat(d.port, { messages: taskTurn() })));
  const two = await chat(a.port, { messages: [user('two commands: echo a ;; echo b')] }, { key: 'key-aaaa1' });
  const ids = [...parallel.flatMap((r) => r.calls), ...two.calls].map((c) => c.id);
  record('call ids: a process-wide counter, unique across parallel requests', ids.length === 8
    && new Set(ids).size === 8 && ids.every((id) => /^call_fake_\d+_[a-z0-9]+_\d+$/.test(id)), ids.join(' '));
  await sleep(100);
  const lines = jsonLines(d);
  const old = ['port', 'model', 'key', 'roles', 'status', 'probe'];
  record('script log: every chat request line keeps the old fields and adds the script fields', lines.length > 0
    && lines.every((e) => [...old, ...SCRIPT_LOG_FIELDS].every((k) => k in e)));
  const sample1 = lines.find((e) => e.scenario === 'tb-selfcheck-task' && e.toolChoice === 'auto');
  record('script log: tools, toolChoice string, format and calls', sample1?.tools.length === 0
    && sample1.format === null && sample1.calls.join() === 'read' && Array.isArray(sample1.roles),
    JSON.stringify(sample1));
}

/** @brief 日志行的 strictTools（function.strict 为 true 的工具名）与 reasoning（请求带思考参数）。 */
async function checkStrictAndReasoningLog(d) {
  const plain = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } };
  const forced = await chatLogged(d, { messages: forcedTask(), tools: [plain, HANDOFF_TOOL],
    tool_choice: choose('task_handoff') });
  record('script log: strictTools names only the strict tool; reasoning false without a thinking parameter',
    forced.log.strictTools?.join() === 'task_handoff' && forced.log.reasoning === false, JSON.stringify(forced.log));
  const thinking = await chatLogged(d, { messages: taskTurn(), tools: [plain], reasoning_effort: 'medium' });
  record('script log: no strict tool gives strictTools []; reasoning_effort gives reasoning true',
    Array.isArray(thinking.log.strictTools) && thinking.log.strictTools.length === 0
    && thinking.log.reasoning === true, JSON.stringify(thinking.log));
  const other = await chatLogged(d, { messages: taskTurn(), thinking: { type: 'enabled' } });
  record('script log: a thinking object also counts as a thinking parameter', other.log.reasoning === true);
}

// ---------- 增强脚本（enhance.mjs）与协作模式增强的场景（scenarios/mem.mjs），synthetic ----------

/** @brief 附录 B 第一条消息的开头（synthetic，只有前两行，KIND 为大写）。 */
const enhanceFirst = (kind) => user(`You are running Mori's daily ${kind} enhancement for the project D:\\shop. `
  + "Day: Oct 22, 2026 (04:00 to 04:00).\nDon't change any file. Commands and MCP tools run without approval.");
/** 增强会话的 system（synthetic，没有 tb-scenario） */
const ENHANCE_SYSTEM = sys('You are Mori, a coding assistant working in the user\'s project folder.');
/** 增强脚本里的依据（synthetic） */
const ENHANCE_ARGS = { action: 'save', abstract: 'Plan first', evidence: [{ session: 'C:\\s.jsonl', entry: 'a1b2' }] };

/**
 * @brief 增强脚本：认出第一条消息与种类、第几步按助手消息数、步骤用完回 Done.、每次请求重读脚本文件、wait、
 *        日志的 enhance 字段；没有这种、没有脚本文件、tb-scenario、协作模式的投递都不按增强脚本。
 */
async function checkEnhance(e, d, scriptFile) {
  writeFileSync(scriptFile, JSON.stringify({ strategy: [{ call: 'memory', args: ENHANCE_ARGS },
    { say: 'Saved one entry.', wait: 600 }] }));
  const first = await chatLogged(e, { messages: [ENHANCE_SYSTEM, enhanceFirst('STRATEGY')] });
  record('enhance: the first message is recognised (STRATEGY → strategy) and step 0 calls the scripted tool with '
    + 'the scripted args', first.log.enhance === 'strategy' && first.out.calls[0]?.name === 'memory'
    && JSON.stringify(parsed(first.out.calls[0].args)) === JSON.stringify(ENHANCE_ARGS), JSON.stringify(first.log));
  const turn = toolTurn('call_m1', 'memory', ENHANCE_ARGS, 'Saved to STRATEGY (this project): Plan first');
  const cardOnly = user(`${WORK_CARD_OPEN}\nsynthetic card\n${WORK_CARD_CLOSE}`);
  const second = await chatLogged(e, { messages: [ENHANCE_SYSTEM, enhanceFirst('STRATEGY'), ...turn, cardOnly] });
  const waited = second.out.firstAt - second.out.startedAt;
  record('enhance: step = assistant messages after that user message (a trailing work-card message is skipped); '
    + '"wait" delays the first chunk', second.out.text === 'Saved one entry.' && second.log.enhance === 'strategy'
    && waited >= 550, `${second.out.text} ${waited}`);
  const later = await chat(e.port, { messages: [ENHANCE_SYSTEM, enhanceFirst('STRATEGY'), ...turn,
    said('Saved one entry.')] });
  const other = await chat(e.port, { messages: [ENHANCE_SYSTEM, enhanceFirst('STRATEGY'), ...turn,
    said('Saved one entry.'), user('plain')] });
  record('enhance: when the steps run out the reply is "Done."; a later user message that is not the first message '
    + 'is answered in keyword mode', later.text === ENHANCE_DONE && other.text !== ENHANCE_DONE
    && other.text.length > 0, `${later.text} | ${other.text.slice(0, 40)}`);
  writeFileSync(scriptFile, JSON.stringify({ strategy: [{ say: 'Rewritten between runs.' }] }));
  const reread = await chat(e.port, { messages: [ENHANCE_SYSTEM, enhanceFirst('STRATEGY')] });
  record('enhance: the script file is read again on every request', reread.text === 'Rewritten between runs.',
    reread.text);
  await checkEnhanceKeys(e, scriptFile);
  await checkEnhanceFallbacks(e, d);
}

/**
 * @brief 增强脚本的 "<kind>@<文字>" 键（按第一行的项目与日子选步骤，段数多的优先）与 "fail" 步骤
 *        （tests/ui/mem-app-enhance-*.mjs 用，synthetic）。
 */
async function checkEnhanceKeys(e, scriptFile) {
  writeFileSync(scriptFile, JSON.stringify({ taste: [{ say: 'Plain taste.' }], 'taste@D:\\shop': [{ say: 'Shop.' }],
    'taste@D:\\shop@Oct 22, 2026': [{ say: 'Shop on Oct 22.' }], 'taste@D:\\other': [{ say: 'Other.' }],
    review: [{ fail: 503 }] }));
  const keyed = await chat(e.port, { messages: [ENHANCE_SYSTEM, enhanceFirst('TASTE')] });
  const otherDay = await chat(e.port, { messages: [ENHANCE_SYSTEM, user(enhanceFirst('TASTE').content
    .replace('Oct 22, 2026', 'Oct 23, 2026'))] });
  const elsewhere = await chat(e.port, { messages: [ENHANCE_SYSTEM, user(enhanceFirst('TASTE').content
    .replace('D:\\shop', 'E:\\site'))] });
  record('enhance: "<kind>@<text>" keys apply when the first line contains every part (most parts win); otherwise '
    + 'the plain "<kind>" steps', keyed.text === 'Shop on Oct 22.' && otherDay.text === 'Shop.'
    && elsewhere.text === 'Plain taste.', `${keyed.text} | ${otherDay.text} | ${elsewhere.text}`);
  const failed = await chatLogged(e, { messages: [ENHANCE_SYSTEM, enhanceFirst('REVIEW')] });
  record('enhance: a "fail" step answers with that status and an OpenAI-shaped error (logged with enhance)',
    failed.out.status === 503 && failed.out.body?.error?.message === 'Synthetic HTTP 503 from the enhancement script'
    && failed.log.enhance === 'review' && failed.log.status === 503, JSON.stringify([failed.out.body, failed.log]));
  // 后面的检查要的是只有 strategy 的脚本（taste、review 按关键词回答）
  writeFileSync(scriptFile, JSON.stringify({ strategy: [{ say: 'Rewritten between runs.' }] }));
}

/** @brief 增强脚本不生效的情况：脚本里没有这种、没有环境变量、tb-scenario、协作模式的投递、普通请求。 */
async function checkEnhanceFallbacks(e, d) {
  const taste = await chatLogged(e, { messages: [ENHANCE_SYSTEM, enhanceFirst('TASTE')] });
  record('enhance: a kind missing from the script answers in keyword mode (reads README.md) and still logs enhance',
    taste.log.enhance === 'taste' && taste.out.calls[0]?.name === 'read', JSON.stringify(taste.log));
  const noScript = await chatLogged(d, { messages: [ENHANCE_SYSTEM, enhanceFirst('REVIEW')] });
  record('enhance: without FAKE_ENHANCE_SCRIPT the endpoint answers in keyword mode and logs enhance: review',
    noScript.log.enhance === 'review' && noScript.out.calls[0]?.name === 'read', JSON.stringify(noScript.log));
  const delivered = await chatLogged(e, { messages: [ENHANCE_SYSTEM,
    user("[Mori] New user message: You are running Mori's daily STRATEGY enhancement for the project D:\\shop.")] });
  const taskDelivery = await chatLogged(e, { messages: [ENHANCE_SYSTEM,
    user('[Mori] You are executor on T1 (request 1). Start work.')] });
  record('enhance: team-mode deliveries ("[Mori] New user message: …", "[Mori] You are executor on T1…") are not '
    + 'recognised (enhance null, keyword mode)', delivered.log.enhance === null && taskDelivery.log.enhance === null
    && delivered.out.calls[0]?.name === 'read', JSON.stringify([delivered.log.enhance, taskDelivery.log.enhance]));
  const scripted = await chatLogged(e, { messages: [sys('tb-scenario:tb-selfcheck-create'),
    enhanceFirst('STRATEGY')] });
  record('enhance: a request with tb-scenario stays in script mode (enhance null, scenario logged)',
    scripted.log.enhance === null && scripted.log.scenario === 'tb-selfcheck-create', JSON.stringify(scripted.log));
  const plain = await chatLogged(e, { messages: [SYSTEM, user('plain')] });
  record('enhance: other requests log enhance: null', plain.log.enhance === null && 'enhance' in plain.log);
}

/** @brief mem-team：task 实例按环境变量给的依据调用 memory save，再 write，再交接；合并会话先改两条被拒绝的条目。 */
async function checkMemTeam(e) {
  const system = sys('You are executor. tb-scenario:mem-team MORI-ROLE-executor', sample(SHARED_SENTENCE),
    SEGMENT_SENTENCES.task);
  const start = user('[Mori] You are executor on T1 (request 1). Start work.');
  const taskCard = card('You are executor on T1 (request 1).', 'Task T1: Save the lesson · changes files');
  const save = await chatLogged(e, { messages: [system, start, taskCard] });
  const args = parsed(save.out.calls[0]?.args);
  record('mem-team: T1 calls memory save with the evidence from MEM_TEAM_SESSION / MEM_TEAM_ENTRY',
    save.log.scenario === 'mem-team' && save.out.calls[0]?.name === 'memory' && args?.action === 'save'
    && args.abstract === MEM_TEAM_TEXT.abstract && args.evidence?.[0]?.session === 'C:\\synthetic\\a.jsonl'
    && args.evidence[0].entry === 'e1e2e3e4', JSON.stringify(args));
  const memory = toolTurn('call_t1', 'memory', args, '[#1] Saved to STRATEGY (this project): x');
  const write = await chat(e.port, { messages: [system, start, ...memory, taskCard] });
  const writeTurn = toolTurn('call_t2', 'write', {}, '[#2] Enhancement runs can only change memory, with the memory '
    + 'tool.');
  const handoff = await chat(e.port, { messages: [system, start, ...memory, ...writeTurn, taskCard] });
  record('mem-team: then write once, then task_handoff with the memory result as evidence',
    write.calls[0]?.name === 'write' && parsed(write.calls[0].args)?.path === MEM_TEAM_TEXT.writePath
    && handoff.calls[0]?.name === 'task_handoff' && parsed(handoff.calls[0].args)?.evidence?.[0] === '#1',
  `${write.calls[0]?.name} ${handoff.calls[0]?.args}`);
  const merged = await chat(e.port, { messages: [sys('tb-scenario:mem-team', SEGMENT_SENTENCES['merged-create']),
    enhanceFirst('STRATEGY')] });
  record('mem-team: the merged session first tries to update the user entry from MEM_TEAM_USER_ENTRY',
    merged.calls[0]?.name === 'memory' && parsed(merged.calls[0].args)?.entry === 'user-rule', merged.calls[0]?.args);
}

// ---------- 发现（discovery.mjs，synthetic）：docs/specs/model-discovery.md §13.1 ----------

/** 发现检查用的模型：第一个、第二个、其余在各形状里的详情不同（server.mjs 开头） */
const SHAPE_MODELS = 'fake-coder,fake-slow,fake-third';
/** 没设 FAKE_MAX_MODEL_LEN 时的窗口 W */
const W = 131072;
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/** @brief 发一个发现请求（opts.body 时为 POST JSON），返回 { status, headers, body（不是 JSON 时为 null）, ms }。 */
async function fetchJson(port, path, opts = {}) {
  const started = Date.now();
  const init = { method: opts.body ? 'POST' : 'GET', headers: opts.headers ?? {}, signal: opts.signal };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: parsed(text), ms: Date.now() - started };
}

/** @brief 列表的行；不是列表时为空。 */
async function listRowsOf(port, path = '/v1/models', headers = {}) {
  return (await fetchJson(port, path, { headers })).body?.data ?? [];
}

/** @brief 起发现检查用的端点：每种 FAKE_LIST_SHAPE 一份，另有 FAKE_NO_V1_ROOT 与 FAKE_LIST_DELAY_MS。 */
async function startShapes() {
  const models = { FAKE_MODELS: SHAPE_MODELS };
  const eps = {};
  for (const shape of ['sglang', 'ollama', 'localai', 'tensorrt', 'litellm', 'newapi', 'rich', 'typed', 'nolist']) {
    eps[shape] = await startEndpoint({ FAKE_LIST_SHAPE: shape, ...models });
  }
  eps.llamacpp = await startEndpoint({ FAKE_LIST_SHAPE: 'llamacpp', FAKE_SERVER_VERSION: 'b6123-abc', ...models });
  eps.anthropic = await startEndpoint({ FAKE_LIST_SHAPE: 'anthropic', FAKE_REQUIRE_KEY: 'sk-ant-wxyz', ...models });
  eps.noV1 = await startEndpoint({ FAKE_NO_V1_ROOT: '1' });
  eps.delayed = await startEndpoint({ FAKE_LIST_DELAY_MS: '600' });
  return eps;
}

/** @brief 默认形状 vllm 只改 owned_by；x-api-key 也过 key 检查；/api/v1/models 不算列表；列表以外的请求不查 key。 */
async function checkDefaultShape(a, c) {
  const row = (await listRowsOf(a.port, '/v1/models', { Authorization: 'Bearer key-aaaa1' }))[0];
  record('MD-02 discovery vllm (default): rows are {id, object, owned_by: "vllm", max_model_len}; '
    + 'only owned_by changed',
    same(Object.keys(row ?? {}), ['id', 'object', 'owned_by', 'max_model_len']) && row.owned_by === 'vllm'
    && row.object === 'model' && row.max_model_len === 4000, JSON.stringify(row));
  const apiKey = await fetchJson(a.port, '/v1/models', { headers: { 'x-api-key': 'key-aaaa1' } });
  const wrong = await fetchJson(a.port, '/v1/models', { headers: { 'x-api-key': 'key-zzzz9' } });
  record('MD-08 discovery: a list request carrying only x-api-key passes the FAKE_KEYS check (wrong one is 401)',
    apiKey.status === 200 && wrong.status === 401, `${apiKey.status} ${wrong.status}`);
  const lmstudio = await fetchJson(c.port, '/api/v1/models');
  const prefixed = await listRowsOf(c.port, '/glm/v1/models');
  const root = await listRowsOf(c.port, '/models');
  record('MD-12 discovery: /api/v1/models (LM Studio, §3.3 step 6) is 404; /models and prefixed /glm/v1/models '
    + 'still list',
    lmstudio.status === 404 && prefixed.length === 2 && root.length === 2, `${lmstudio.status}`);
  const version = await fetchJson(a.port, '/version');
  record('MD-10 discovery: requests other than the list are not key-checked (/version without a key on FAKE_KEYS)',
    version.status === 200 && version.body?.version === '0.9.9');
}

/** @brief sglang：owned_by、parent、max_model_len 与 /model_info；llama.cpp：meta.n_ctx 与 /props。 */
async function checkSglangAndLlamacpp(sglang, llamacpp) {
  const rows = await listRowsOf(sglang.port);
  const info = (await fetchJson(sglang.port, '/model_info')).body;
  record('MD-12 discovery sglang: rows owned_by "sglang", parent null, max_model_len W; /model_info has '
    + 'reasoning_parser, tool_call_parser, has_image_understanding false, is_generation true', rows.length === 3
    && rows.every((r) => r.owned_by === 'sglang' && r.parent === null && r.max_model_len === W)
    && info?.reasoning_parser === 'qwen3' && info.tool_call_parser === 'qwen25'
    && info.has_image_understanding === false && info.is_generation === true, JSON.stringify([rows[0], info]));
  const version = await fetchJson(sglang.port, '/version');
  const others = [await fetchJson(sglang.port, '/api/version'), await fetchJson(sglang.port, '/props')];
  record('MD-12 discovery sglang: /version answers; /api/version and /props are 404', version.body?.version === '0.10.1'
    && others.every((r) => r.status === 404));
  const llRows = await listRowsOf(llamacpp.port);
  const props = (await fetchJson(llamacpp.port, '/props')).body;
  record('MD-12 discovery llamacpp: rows owned_by "llamacpp" with meta.n_ctx W (n_ctx_train 2W); /props has n_ctx W, '
    + 'vision false and build_info = FAKE_SERVER_VERSION', llRows.length === 3
    && llRows.every((r) => r.owned_by === 'llamacpp' && r.meta?.n_ctx === W && r.meta.n_ctx_train === 2 * W)
    && props?.default_generation_settings?.n_ctx === W && props.modalities?.vision === false
    && props.build_info === 'b6123-abc', JSON.stringify([llRows[0], props]));
  record('MD-12 discovery llamacpp: /model_info and /api/tags are 404 (other shapes only)',
    (await fetchJson(llamacpp.port, '/model_info')).status === 404
    && (await fetchJson(llamacpp.port, '/api/tags')).status === 404);
}

/** @brief Ollama：/v1/models、/api/version、/api/tags、/api/ps 与 POST /api/show。 */
async function checkOllama(o) {
  const rows = await listRowsOf(o.port);
  record('MD-12 discovery ollama: /v1/models rows have owned_by "library" and created, no window', rows.length === 3
    && rows.every((r) => r.owned_by === 'library' && Number.isInteger(r.created) && !('max_model_len' in r)),
  JSON.stringify(rows[0]));
  const version = (await fetchJson(o.port, '/api/version')).body;
  const tags = (await fetchJson(o.port, '/api/tags')).body?.models ?? [];
  const ps = (await fetchJson(o.port, '/api/ps')).body?.models ?? [];
  record('MD-12 discovery ollama: /api/version; /api/tags has every model with details.family "llama" and no '
    + 'capabilities; /api/ps has only the first model at context_length 8192', version?.version === '0.10.1'
    && same(tags.map((t) => t.name), SHAPE_MODELS.split(',')) && tags.every((t) => t.details?.family === 'llama'
    && !('capabilities' in t)) && ps.length === 1 && ps[0].name === 'fake-coder' && ps[0].context_length === 8192,
  JSON.stringify([version, ps]));
  const shows = await Promise.all(SHAPE_MODELS.split(',').map((model) => fetchJson(o.port, '/api/show',
    { body: { model } })));
  const caps = shows.map((s) => s.body?.capabilities?.join('+'));
  record('MD-07/MD-12 discovery ollama: /api/show capabilities: first completion+tools+thinking, second '
    + 'completion only, the rest completion+tools',
  same(caps, ['completion+tools+thinking', 'completion', 'completion+tools']), caps.join(' | '));
  const numCtx = shows.map((s) => /^num_ctx\s+(\d+)$/m.exec(s.body?.parameters ?? '')?.[1] ?? null);
  const trained = shows.map((s) => s.body?.model_info?.['general.architecture'] === 'llama'
    && s.body.model_info['llama.context_length']);
  record('MD-07/MD-12 discovery ollama: only the second model\'s parameters have num_ctx 16384; every model_info '
    + 'has the trained window W', same(numCtx, [null, '16384', null]) && trained.every((w) => w === W),
  JSON.stringify(numCtx));
  const missing = await fetchJson(o.port, '/api/show', { body: { model: 'nope' } });
  record('MD-12 discovery ollama: /api/show of an unknown model is 404; /props is 404',
    missing.status === 404 && (await fetchJson(o.port, '/props')).status === 404);
}

/** @brief LocalAI：只有 id、object 的行、/.well-known/localai.json、<base>/models/capabilities；TensorRT-LLM 的行。 */
async function checkLocalaiAndTensorrt(localai, tensorrt) {
  const rows = await listRowsOf(localai.port);
  const known = (await fetchJson(localai.port, '/.well-known/localai.json')).body;
  record('MD-12 discovery localai: rows have only id and object; /.well-known/localai.json has a version; '
    + '/version answers',
    rows.length === 3 && rows.every((r) => same(Object.keys(r), ['id', 'object'])) && known?.version === '0.10.1'
    && (await fetchJson(localai.port, '/version')).body?.version === '0.10.1', JSON.stringify([rows[0], known]));
  const caps = (await fetchJson(localai.port, '/v1/models/capabilities')).body?.data ?? [];
  const atRoot = (await fetchJson(localai.port, '/models/capabilities')).body?.data ?? [];
  record('MD-12 discovery localai: <base>/models/capabilities (under /v1 or the root) lists capabilities, '
    + 'modalities and context_size W for every model', caps.length === 3 && atRoot.length === 3 && caps.every((m) =>
    same(m.capabilities, ['chat', 'completion', 'tools']) && same(m.input_modalities, ['text'])
    && same(m.output_modalities, ['text']) && m.context_size === W), JSON.stringify(caps[0]));
  const trt = await listRowsOf(tensorrt.port);
  record('MD-12 discovery tensorrt: rows owned_by "tensorrt_llm" without a window; /version answers', trt.length === 3
    && trt.every((r) => r.owned_by === 'tensorrt_llm' && !('max_model_len' in r))
    && (await fetchJson(tensorrt.port, '/version')).body?.version === '0.10.1', JSON.stringify(trt[0]));
}

/** @brief LiteLLM 的 created、mode、窗口与输出（第二行的输出等于窗口）；New API 的响应头、success 与端点类型。 */
async function checkLitellmAndNewapi(litellm, newapi) {
  const rows = await listRowsOf(litellm.port);
  record('MD-07 discovery litellm: every row created 1677610602, owned_by "openai", mode "chat", max_input_tokens W, '
    + 'supports_* false', rows.length === 3 && rows.every((r) => r.created === 1677610602 && r.owned_by === 'openai'
    && r.mode === 'chat' && r.max_input_tokens === W && r.supports_reasoning === false
    && r.supports_function_calling === false), JSON.stringify(rows[0]));
  const outputs = rows.map((r) => r.max_output_tokens);
  record('MD-07 discovery litellm: the second row\'s max_output_tokens equals its window, the others are W/16',
    same(outputs, [W / 16, W, W / 16]), JSON.stringify(outputs));
  const list = await fetchJson(newapi.port, '/v1/models');
  record('MD-05 discovery newapi: X-New-Api-Version header, success: true, supported_endpoint_types on every row',
    list.headers.get('x-new-api-version') === 'v0.9.0' && list.body?.success === true && list.body.data.length === 3
    && list.body.data.every((r) => same(r.supported_endpoint_types, ['openai', 'anthropic'])),
  JSON.stringify(list.body?.data?.[0]));
}

/** @brief Anthropic 形状：要 anthropic-version 头、只有 /v1/models、Anthropic 形状的体与错误、key 检查。 */
async function checkAnthropicShape(an) {
  const auth = { 'x-api-key': 'sk-ant-wxyz', 'anthropic-version': '2023-06-01' };
  const noVersion = await fetchJson(an.port, '/v1/models', { headers: { 'x-api-key': 'sk-ant-wxyz' } });
  record('MD-05 discovery anthropic: without anthropic-version the list is 400 with an Anthropic-shaped error',
    noVersion.status === 400 && noVersion.body?.type === 'error'
    && noVersion.body.error?.type === 'invalid_request_error', JSON.stringify(noVersion.body));
  const list = await fetchJson(an.port, '/anthropic/v1/models', { headers: auth });
  const row = list.body?.data?.[0];
  record('MD-05 discovery anthropic: {data, has_more: false, first_id, last_id}; rows type "model" with '
    + 'max_input_tokens W, max_tokens W/4 and capabilities image_input / thinking supported', list.status === 200
    && list.body.has_more === false && list.body.first_id === 'fake-coder' && list.body.last_id === 'fake-third'
    && row?.type === 'model' && row.max_input_tokens === W && row.max_tokens === W / 4
    && row.capabilities?.image_input?.supported === true && row.capabilities.thinking?.supported === true,
  JSON.stringify(list.body));
  const bearer = await fetchJson(an.port, '/v1/models', { headers: { Authorization: 'Bearer sk-ant-wxyz',
    'anthropic-version': '2023-06-01' } });
  const wrong = await fetchJson(an.port, '/v1/models', { headers: { ...auth, 'x-api-key': 'sk-ant-nope' } });
  record('MD-05 discovery anthropic: Bearer also passes FAKE_REQUIRE_KEY; a wrong key is 401 authentication_error',
    bearer.status === 200 && wrong.status === 401 && wrong.body?.error?.type === 'authentication_error',
    `${bearer.status} ${JSON.stringify(wrong.body)}`);
  record('MD-05 discovery anthropic: /models (no /v1) is 404', (await fetchJson(an.port, '/models', { headers: auth }))
    .status === 404);
}

/** @brief rich：DeepSeek 式字段；typed：type 与 embedding 行；nolist；FAKE_NO_V1_ROOT。 */
async function checkRichTypedAndRoutes(eps) {
  const rich = await listRowsOf(eps.rich.port);
  record('MD-12/MD-13 discovery rich: context_window W and max_output_tokens W/16 on every row; the first row has '
    + 'input_modalities [text, image] and an effort object, the others [text] and no effort', rich.length === 3
    && rich.every((r) => r.context_window === W && r.max_output_tokens === W / 16)
    && same(rich[0].input_modalities, ['text', 'image']) && typeof rich[0].effort === 'object'
    && rich.slice(1).every((r) => same(r.input_modalities, ['text']) && !('effort' in r)), JSON.stringify(rich));
  const typed = await listRowsOf(eps.typed.port);
  record('MD-07 discovery typed: type "llm", "embedding" (second row), "llm"', same(typed.map((r) => r.type),
    ['llm', 'embedding', 'llm']), JSON.stringify(typed));
  const nolist = [await fetchJson(eps.nolist.port, '/models'), await fetchJson(eps.nolist.port, '/v1/models')];
  record('MD-08/MD-09 discovery nolist: /models and /v1/models are both 404; /version still answers',
    nolist.every((r) => r.status === 404) && (await fetchJson(eps.nolist.port, '/version')).status === 200);
  const root = await fetchJson(eps.noV1.port, '/models');
  const v1 = await listRowsOf(eps.noV1.port, '/v1/models');
  record('MD-09 FAKE_NO_V1_ROOT=1: /models is 404, /v1/models lists', root.status === 404 && v1.length === 2,
    `${root.status} ${v1.length}`);
}

/** @brief FAKE_LIST_DELAY_MS：列表等这么久；别的请求不等；等的时候断开，端点照样回答后面的请求。 */
async function checkListDelay(delayed) {
  const list = await fetchJson(delayed.port, '/v1/models');
  const version = await fetchJson(delayed.port, '/version');
  record('MD-06/MD-09 FAKE_LIST_DELAY_MS: the list answers after the delay; /version does not wait',
    list.status === 200 && list.ms >= 550 && version.ms < 400, `${list.ms} ${version.ms}`);
  const before = discoveryLines(delayed).length;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const aborted = await fetchJson(delayed.port, '/models', { signal: controller.signal }).then(() => 'answered',
    (error) => error.name);
  const logged = discoveryLines(delayed).length > before;
  await sleep(700);
  const again = await fetchJson(delayed.port, '/v1/models');
  record('MD-06/MD-09 FAKE_LIST_DELAY_MS: a request dropped during the delay is logged before the wait and the '
    + 'endpoint keeps answering', aborted === 'AbortError' && logged && again.status === 200, `${aborted} ${logged}`);
}

/** @brief 不认识的 FAKE_LIST_SHAPE：启动时报错，退出码 1。 */
async function checkUnknownShape() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_LIST_SHAPE: 'bogus' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  record('MD-07/MD-08/MD-09/MD-12 discovery: an unknown FAKE_LIST_SHAPE fails at start with exit code 1', code === 1
    && stderr.includes('unknown FAKE_LIST_SHAPE "bogus"'), `${code} ${stderr}`);
}

/** @brief -alwaysthink：不论请求带不带思考参数都先回思考；本来就有思考的回复不变；其他探针行为不变。 */
async function checkAlwaysThink(a) {
  const key = 'key-aaaa1';
  const model = 'fake-coder-alwaysthink';
  const ready = await chat(a.port, { model, messages: [user('Reply with the single word: ready.')] }, { key });
  record('MD-13 -alwaysthink: probe 1 without a thinking parameter streams reasoning_content first, then "ready"',
    ready.text === 'ready' && ready.reasoning.length > 0 && ready.firstKind === 'reasoning', JSON.stringify(ready));
  const plain = await chat(a.port, { model, messages: [user('plain')] }, { key });
  record('MD-13 -alwaysthink: a non-probe reply also streams reasoning_content first, text unchanged',
    plain.firstKind === 'reasoning' && plain.text === '这是一段只有文字的回复，用来测试流式输出。');
  const own = await chat(a.port, { model, messages: [user('think first')] }, { key });
  record('MD-13 -alwaysthink: a reply that already thinks keeps its own thinking',
    own.reasoning.includes('THINKING-ONLY'));
  const weather = await chat(a.port, { model, messages: [user(WEATHER)], tools: [weatherTool] }, { key });
  record('MD-13 -alwaysthink: probe 3 still calls get_weather (other behaviour unchanged)',
    weather.calls[0]?.name === 'get_weather' && weather.firstKind === 'reasoning');
}

/** @brief 发现请求的 JSON 日志行：只有 port、path、key；key 取 Bearer 或 x-api-key 的末 4 位。 */
function checkDiscoveryLogs(a, eps) {
  const all = [a, ...Object.values(eps)].flatMap((ep) => discoveryLines(ep).map((e) => ({ ...e, ep })));
  record('MD-06/MD-10/MD-12 discovery log: every list or detail line has exactly port, path, key', all.length > 0
    && all.every((e) => same(Object.keys(e).filter((k) => k !== 'ep'), ['port', 'path', 'key'])
    && e.port === e.ep.port));
  const onA = discoveryLines(a);
  record('MD-06/MD-10/MD-12 discovery log: the key is the last 4 characters of Bearer or x-api-key, null without '
    + 'a key; no query',
    onA.some((e) => e.path === '/v1/models' && e.key === 'aaa1') && onA.some((e) => e.key === 'zzz9')
    && onA.some((e) => e.path === '/version' && e.key === null)
    && discoveryLines(eps.anthropic).some((e) => e.path === '/anthropic/v1/models' && e.key === 'wxyz')
    && all.every((e) => !e.path.includes('?')), JSON.stringify(onA.slice(0, 6)));
  const paths = discoveryLines(eps.ollama).map((e) => e.path);
  record('MD-06/MD-10/MD-12 discovery log: GET details and POST /api/show are logged',
    paths.includes('/api/tags') && paths.filter((p) => p === '/api/show').length >= 4);
}

/** @brief 发现的全部检查（形状与 FAKE_NO_V1_ROOT、FAKE_LIST_DELAY_MS）。 */
async function checkDiscovery(a, c, eps) {
  await checkDefaultShape(a, c);
  await checkSglangAndLlamacpp(eps.sglang, eps.llamacpp);
  await checkOllama(eps.ollama);
  await checkLocalaiAndTensorrt(eps.localai, eps.tensorrt);
  await checkLitellmAndNewapi(eps.litellm, eps.newapi);
  await checkAnthropicShape(eps.anthropic);
  await checkRichTypedAndRoutes(eps);
  await checkListDelay(eps.delayed);
  await checkUnknownShape();
  await checkAlwaysThink(a);
}

// ---------- 思考关不掉的模型（docs/specs/model-providers.md §7.7、§14.1 的 2026-10-24 补丁），synthetic ----------

/** -nooff 的 400 响应体：照规格 §14.1 写出的原文（与 probes.mjs 的常量分开写，逐字节对照） */
const NOOFF_BODY_EXPECTED = '{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.",'
  + '"code":400,"metadata":{"provider_name":null}}}';
/** pi 只在地址含 openrouter.ai 时用 OpenRouter 的写法：测试的提供商地址是 http://127.0.0.1:<端口>/openrouter.ai/v1 */
const OPENROUTER_BASE = '/openrouter.ai/v1';
const OPENROUTER_CHAT = `${OPENROUTER_BASE}/chat/completions`;
const READY = 'Reply with the single word: ready.';
const PLAIN_TEXT = '这是一段只有文字的回复，用来测试流式输出。';
/** 三种明确的"关闭思考"写法（§14.1）：OpenRouter、Together、DeepSeek / z.ai / Anthropic */
const OFF_SPELLINGS = [['reasoning.effort "none"', { reasoning: { effort: 'none' } }],
  ['reasoning.enabled false', { reasoning: { enabled: false } }],
  ['thinking.type "disabled"', { thinking: { type: 'disabled' } }]];
/** 判断顺序检查的端点 g 接受的 key 与不认识的 key（synthetic，不是真实的 key） */
const NOOFF_ORDER_KEY = 'key-dddd4';
const NOOFF_ORDER_BAD_KEY = 'key-zzzz8';

/** @brief 发一个请求并取它的日志行（这个端点上请求一个接一个发，新出现的那一行就是它的）；opts 同 chat。 */
async function chatLoggedAt(endpoint, body, opts = {}) {
  const before = jsonLines(endpoint).length;
  const out = await chat(endpoint.port, body, opts);
  for (let i = 0; i < 40 && jsonLines(endpoint).length <= before; i += 1) await sleep(25);
  return { out, log: jsonLines(endpoint)[before] ?? {} };
}

/** @brief -nooff：三种"关闭思考"写法都是 400，响应体逐字节为录下的原文；探针与非探针都一样；不看路径前缀。 */
async function checkNoOffRefusal(f) {
  record('MP-38 -nooff: the exported 400 body is the recorded OpenRouter text byte for byte',
    NOOFF_ERROR_BODY === NOOFF_BODY_EXPECTED, NOOFF_ERROR_BODY);
  for (const [name, off] of OFF_SPELLINGS) {
    const { out, log } = await chatLoggedAt(f, { model: 'fake-coder-nooff', messages: [user(READY)], ...off },
      { path: OPENROUTER_CHAT });
    record(`MP-38 -nooff: probe step 2 with ${name} is 400 with the recorded body byte for byte (JSON)`,
      out.status === 400 && out.raw === NOOFF_BODY_EXPECTED
      && out.headers.get('content-type') === 'application/json' && log.status === 400 && log.probe === true,
      `${out.status} ${out.raw} ${JSON.stringify(log)}`);
  }
  const plain = await chat(f.port, { model: 'fake-coder-nooff', messages: [user('plain')],
    reasoning: { effort: 'none' } });
  record('MP-38 -nooff: a non-probe request with thinking off is refused the same way (all requests)',
    plain.status === 400 && plain.raw === NOOFF_BODY_EXPECTED, `${plain.status} ${plain.raw}`);
  const v1 = await chat(f.port, { model: 'fake-coder-nooff', messages: [user(READY)], thinking: { type: 'disabled' } });
  record('MP-38 -nooff: the refusal does not depend on the path prefix (/v1 too)',
    v1.status === 400 && v1.raw === NOOFF_BODY_EXPECTED);
  const other = await chat(f.port, { model: 'fake-coder', messages: [user(READY)], reasoning: { effort: 'none' } },
    { path: OPENROUTER_CHAT });
  record('MP-38 without -nooff the same thinking-off request is answered, without thinking',
    other.done && other.text === 'ready' && other.reasoning === '', JSON.stringify(other));
}

/** @brief -nooff：不带思考参数、带强度时照常回答并带思考；只有三种写法算"关闭思考"。 */
async function checkNoOffAnswers(f) {
  const model = 'fake-coder-nooff';
  const bare = await chat(f.port, { model, messages: [user(READY)] }, { path: OPENROUTER_CHAT });
  record('MP-38 -nooff: without thinking parameters the probe answers normally with thinking content',
    bare.done && bare.text === 'ready' && bare.reasoning.length > 0 && bare.firstKind === 'reasoning',
    JSON.stringify(bare));
  const medium = await chat(f.port, { model, messages: [user(READY)], reasoning: { effort: 'medium' } },
    { path: OPENROUTER_CHAT });
  record('MP-38 -nooff: with reasoning.effort "medium" the probe answers normally with thinking',
    medium.done && medium.text === 'ready' && medium.reasoning.length > 0);
  const tools = await chat(f.port, { model, messages: [user(WEATHER)], tools: [weatherTool],
    reasoning: { effort: 'medium' } }, { path: OPENROUTER_CHAT });
  record('MP-38 -nooff: probe 3 at medium still calls get_weather (other probe behaviour unchanged)',
    tools.calls[0]?.name === 'get_weather' && tools.reasoning.length > 0);
  const session = await chat(f.port, { model, messages: [user('plain')], reasoning: { effort: 'minimal' } },
    { path: OPENROUTER_CHAT });
  record('MP-39 -nooff: a session request at reasoning.effort "minimal" is answered (200, thinking), not 400',
    session.status === 200 && session.done && session.text === PLAIN_TEXT && session.reasoning.length > 0,
    JSON.stringify(session));
  const bareChat = await chat(f.port, { model, messages: [user('plain')] });
  record('MP-39 -nooff: a non-probe reply without thinking parameters answers normally with thinking content',
    bareChat.done && bareChat.text === PLAIN_TEXT && bareChat.reasoning.length > 0);
  const notOff = [{ reasoning: { effort: 'low', enabled: true } }, { thinking: { type: 'enabled' } },
    { reasoning_effort: 'none' }];
  const answered = await Promise.all(notOff.map((extra) => chat(f.port, { model, messages: [user(READY)], ...extra })));
  record('MP-38 -nooff: only the three explicit off spellings are refused (enabled true, thinking enabled and a '
    + 'top-level reasoning_effort "none" are answered)', answered.every((r) => r.done && r.text === 'ready'),
    answered.map((r) => r.status).join());
}

/** @brief /openrouter.ai/v1 前缀：列表与对话照常回答（路由只看路径结尾）；/version 仍在 origin 下。 */
async function checkOpenRouterPrefix(f) {
  const prefixed = await fetchJson(f.port, `${OPENROUTER_BASE}/models`);
  const root = await fetchJson(f.port, '/v1/models');
  record('MP-38 /openrouter.ai/v1 prefix: GET /openrouter.ai/v1/models is the same list as /v1/models',
    prefixed.status === 200 && same(prefixed.body, root.body) && prefixed.body?.data?.[0]?.id === 'fake-coder',
    JSON.stringify(prefixed.body));
  const ready = await chat(f.port, { messages: [user(READY)] }, { path: OPENROUTER_CHAT });
  const plain = await chat(f.port, { messages: [user('plain')] }, { path: OPENROUTER_CHAT });
  record('MP-38 /openrouter.ai/v1 prefix: POST /openrouter.ai/v1/chat/completions answers probes and chat',
    ready.done && ready.text === 'ready' && plain.done && plain.text === PLAIN_TEXT);
  await sleep(100);
  record('MP-38 /openrouter.ai/v1 prefix: logged as "METHOD url", a chat JSON line and a list {port, path, key} line',
    f.lines.includes(`[fake-endpoint] POST ${OPENROUTER_CHAT}`)
    && discoveryLines(f).some((e) => e.path === `${OPENROUTER_BASE}/models`)
    && jsonLines(f).length === f.lines.filter((l) => l.endsWith('/chat/completions')).length);
  const version = await fetchJson(f.port, '/version');
  record('MP-38 /openrouter.ai/v1 prefix: /version stays at the origin',
    version.status === 200 && version.body?.version === '0.10.1');
}

/** @brief 日志的 effort 字段：reasoning_effort ?? reasoning.effort ?? null，接在 reasoning 后面，原有字段不变。 */
async function checkEffortLog(f) {
  const cases = [[{ reasoning_effort: 'high' }, 'high'], [{ reasoning: { effort: 'minimal' } }, 'minimal'],
    [{ reasoning: { effort: 'none' } }, 'none'], [{}, null], [{ reasoning: { enabled: false } }, null],
    [{ reasoning_effort: 'low', reasoning: { effort: 'high' } }, 'low']];
  const wrong = [];
  for (const [extra, effort] of cases) {
    const { log } = await chatLoggedAt(f, { messages: [user('plain')], ...extra }, { path: OPENROUTER_CHAT });
    if (log.effort !== effort) wrong.push(`${JSON.stringify(extra)} -> ${JSON.stringify(log.effort)}`);
  }
  record('MP-39 log: "effort" is reasoning_effort ?? reasoning.effort ?? null (the raw requested level)',
    wrong.length === 0, wrong.join('; '));
  const { log } = await chatLoggedAt(f, { messages: [user('plain')], reasoning: { effort: 'medium' } });
  const keys = Object.keys(log);
  const old = ['port', 'model', 'key', 'roles', 'status', 'probe', 'enhance', ...SCRIPT_LOG_FIELDS];
  record('MP-39 log: "effort" comes last, right after "reasoning"; every old field is kept',
    keys.at(-1) === 'effort' && keys.at(-2) === 'reasoning' && old.every((k) => k in log) && log.reasoning === true,
    keys.join());
  const refused = (await chatLoggedAt(f, { model: 'fake-coder-nooff', messages: [user(READY)],
    reasoning: { effort: 'none' } }, { path: OPENROUTER_CHAT })).log;
  record('MP-39 log: a refused -nooff request logs status 400 and effort "none"', refused.status === 400
    && refused.effort === 'none' && refused.model === 'fake-coder-nooff', JSON.stringify(refused));
}

/** @brief probes.mjs 的纯函数：每一条 [说明, 是否成立]，失败时列出说明。 */
function checkThinkingPredicates() {
  const cases = [['thinkingOn effort medium', thinkingOn({ reasoning: { effort: 'medium' } })],
    ['thinkingOn reasoning_effort low', thinkingOn({ reasoning_effort: 'low' })],
    ['not thinkingOn effort none', !thinkingOn({ reasoning: { effort: 'none' } })],
    ['not thinkingOn reasoning_effort none', !thinkingOn({ reasoning_effort: 'none' })],
    ['not thinkingOn without parameters', !thinkingOn({})],
    ['not thinkingOn enabled true', !thinkingOn({ reasoning: { enabled: true } })],
    ['not thinkingOn thinking enabled', !thinkingOn({ thinking: { type: 'enabled' } })],
    ['requestedEffort xhigh', requestedEffort({ reasoning: { effort: 'xhigh' } }) === 'xhigh'],
    ['requestedEffort null without parameters', requestedEffort({}) === null],
    ...OFF_SPELLINGS.map(([name, off]) => [`explicitThinkingOff ${name}`, explicitThinkingOff(off)]),
    ['not explicitThinkingOff without parameters', !explicitThinkingOff({})],
    ['not explicitThinkingOff reasoning_effort none', !explicitThinkingOff({ reasoning_effort: 'none' })],
    ['not explicitThinkingOff effort low', !explicitThinkingOff({ reasoning: { effort: 'low' } })]];
  const wrong = cases.filter(([, ok]) => !ok).map(([name]) => name);
  record('MP-38/MP-39 thinkingOn: reasoning_effort or reasoning.effort, not "none"; explicitThinkingOff: exactly '
    + 'the three spellings', wrong.length === 0, wrong.join('; '));
}

/** @brief "开了思考" = reasoning_effort 或 reasoning.effort 且不是 none（thinkingOn 与 thinking check）。 */
async function checkThinkingOn(f) {
  checkThinkingPredicates();
  const onProbe = await chat(f.port, { messages: [user(READY)], reasoning: { effort: 'medium' } },
    { path: OPENROUTER_CHAT });
  const offProbe = await chat(f.port, { messages: [user(READY)], reasoning: { effort: 'none' } },
    { path: OPENROUTER_CHAT });
  record('MP-38 thinkingOn: probe 1 with reasoning.effort "medium" carries reasoning_content; "none" does not',
    onProbe.text === 'ready' && onProbe.reasoning.length > 0 && offProbe.text === 'ready'
    && offProbe.reasoning === '');
  const check = await chat(f.port, { messages: [user('thinking check')], reasoning: { effort: 'high' } });
  const none = await chat(f.port, { messages: [user('thinking check')], reasoning: { effort: 'none' } });
  record('MP-39 thinking check: reasoning.effort "high" is thinking on ("收到思考参数：high" with thinking); '
    + '"none" is "没有思考参数"', check.text === '收到思考参数：high' && check.reasoning.length > 0
    && none.text === '没有思考参数' && none.reasoning === '', `${check.text} / ${none.text}`);
}

/** @brief -thinklong：探针开了思考时只回超过 256 token 的思考、以 length 结束；没开时照常；非探针不受影响。 */
async function checkThinkLong(f) {
  const model = 'fake-coder-thinklong';
  const long = await chat(f.port, { model, messages: [user(READY)], reasoning_effort: 'medium' });
  record('MP-38 -thinklong: with thinking on a probe streams only thinking (> 256 tokens, > 1100 chars), no text, '
    + 'and ends with finish_reason "length"', long.done && long.status === 200 && long.text === ''
    && long.calls.length === 0 && long.reasoning === THINKLONG_THINKING && long.reasoning.length > 1100
    && Math.ceil(long.reasoning.length / 4) > 256 && long.finish === 'length',
    `${long.status} ${long.finish} ${long.reasoning.length} ${long.text}`);
  const openRouter = await chat(f.port, { model, messages: [user(WEATHER)], tools: [weatherTool],
    reasoning: { effort: 'medium' } }, { path: OPENROUTER_CHAT });
  record('MP-38 -thinklong: thinking on via reasoning.effort works the same (probe 3: no tool call, length)',
    openRouter.calls.length === 0 && openRouter.text === '' && openRouter.finish === 'length');
  const off = await chat(f.port, { model, messages: [user(READY)] });
  const offTool = await chat(f.port, { model, messages: [user(WEATHER)], tools: [weatherTool] });
  record('MP-38 -thinklong: with thinking off the probe is answered as usual (ready / get_weather, stop / '
    + 'tool_calls)', off.text === 'ready' && off.reasoning === '' && off.finish === 'stop'
    && offTool.calls[0]?.name === 'get_weather' && offTool.finish === 'tool_calls',
    `${off.finish} ${offTool.finish}`);
  const chatReply = await chat(f.port, { model, messages: [user('plain')], reasoning_effort: 'medium' });
  record('MP-38 -thinklong: a non-probe request at medium is unaffected (text, finish_reason "stop")',
    chatReply.text === PLAIN_TEXT && chatReply.finish === 'stop');
  const normal = await chat(f.port, { messages: [user(READY)], reasoning_effort: 'medium' });
  record('MP-38 without -thinklong a probe at medium ends with finish_reason "stop" and has text',
    normal.text === 'ready' && normal.finish === 'stop' && normal.reasoning.length > 0);
}

/**
 * @brief -toollong（2026-10-26 补）：只有探针第 3、4 步不论开没开思考都只回很长的思考、以 length 结束；第 1 步与不是探针的
 *        请求照常。
 */
async function checkToolLong(f) {
  const model = 'fake-coder-toollong';
  const step3 = await chat(f.port, { model, messages: [user(WEATHER)], tools: [weatherTool] });
  const call = { id: 'call_selfcheck_toollong', name: 'get_weather', args: '{"city":"Paris","days":3}' };
  const step4 = await chat(f.port, { model, messages: step4Messages(call), tools: [weatherTool] });
  record('MP-38 -toollong: probe steps 3 and 4 with thinking off stream only thinking (> 1100 chars), no text and no '
    + 'tool call, and end with finish_reason "length"', [step3, step4].every((r) => r.status === 200 && r.text === ''
    && r.calls.length === 0 && r.reasoning === THINKLONG_THINKING && r.finish === 'length'),
  `${step3.finish} ${step3.calls.length} / ${step4.finish} ${step4.text}`);
  const ready = await chat(f.port, { model, messages: [user(READY)] });
  const plain = await chat(f.port, { model, messages: [user('plain')] });
  record('MP-38 -toollong: probe step 1 and a non-probe request are answered as usual (ready / plain text, stop)',
    ready.text === 'ready' && ready.finish === 'stop' && plain.text === PLAIN_TEXT && plain.finish === 'stop',
    `${ready.text} ${ready.finish} / ${plain.finish}`);
}

/**
 * @brief -offlong、-offsilent（2026-10-26 补，与 -nooff 一起）：第 1 步的 medium 照常；第 2 步的 off 被拒（400）之后，下一次
 *        medium 的第 1、2 步提示：-offlong 只回很长的思考、以 length 结束，-offsilent 只回思考、正常结束、没有正文；
 *        再下一次 medium 又照常（记录只用一次）。
 */
async function checkRefusedOffFollowUp(f) {
  const medium = { messages: [user(READY)], reasoning: { effort: 'medium' } };
  const off = { messages: [user(READY)], reasoning: { effort: 'none' } };
  const runs = {};
  for (const suffix of ['offlong', 'offsilent']) {
    const model = `fake-coder-nooff-${suffix}`;
    const send = (body) => chat(f.port, { model, ...body }, { path: OPENROUTER_CHAT });
    runs[suffix] = { first: await send(medium), refused: await send(off), next: await send(medium),
      again: await send(medium) };
  }
  const fine = (r) => r.status === 200 && r.text === 'ready' && r.finish === 'stop';
  const { offlong: long, offsilent: silent } = runs;
  record('MP-38 -nooff-offlong: step 1 at medium answers "ready"; after the refused off (400 body) the next medium '
    + 'ready prompt streams only thinking and ends with "length"; the one after answers "ready" again',
  fine(long.first) && long.refused.status === 400 && long.refused.raw === NOOFF_BODY_EXPECTED
    && long.next.status === 200 && long.next.text === '' && long.next.reasoning === THINKLONG_THINKING
    && long.next.finish === 'length' && fine(long.again), JSON.stringify([long.first.finish, long.refused.status,
    long.next.finish, long.next.text, long.again.text]));
  record('MP-38 -nooff-offsilent: after the refused off the next medium ready prompt has thinking but no text and ends '
    + 'with "stop"; the one after answers "ready" again', fine(silent.first) && silent.refused.status === 400
    && silent.next.status === 200 && silent.next.text === '' && silent.next.reasoning.length > 0
    && silent.next.finish === 'stop' && fine(silent.again), JSON.stringify([silent.next.finish, silent.next.text,
    silent.again.text]));
}

/** @brief FAKE_SERVE_404=1（2026-10-26 补）：-404 的模型照常回答；没有它时同一个请求是 404。 */
async function checkServe404(f, h) {
  const body = { model: 'fake-coder-404', messages: [user('plain')] };
  const broken = await chat(f.port, body);
  const fixed = await chat(h.port, body);
  record('MP-41 FAKE_SERVE_404=1: a -404 model is answered as usual (the server was fixed); without it the same '
    + 'request is 404', broken.status === 404 && fixed.status === 200 && fixed.text === PLAIN_TEXT,
  `${broken.status} / ${fixed.status} ${fixed.text}`);
}

/**
 * @brief -nooff 的判断顺序（server.mjs 开头）：认证 → -nooff → -replay → -404、-hang、-stall。
 * @param f 不查 key 的端点
 * @param g 设了 FAKE_KEYS（synthetic 的 key）的端点
 */
async function checkNoOffOrder(f, g) {
  const off = { model: 'fake-coder-nooff', messages: [user(READY)], reasoning: { effort: 'none' } };
  const denied = await chat(g.port, off, { key: NOOFF_ORDER_BAD_KEY, path: OPENROUTER_CHAT });
  const allowed = await chat(g.port, off, { key: NOOFF_ORDER_KEY, path: OPENROUTER_CHAT });
  record('MP-38 -nooff order: the key is checked first (a wrong key is 401, the right key gets the 400 body)',
    denied.status === 401 && allowed.status === 400 && allowed.raw === NOOFF_BODY_EXPECTED,
    `${denied.status} ${denied.raw} / ${allowed.status}`);
  const stacked = await Promise.all(['404', 'hang', 'stall'].map((suffix) => chat(f.port,
    { model: `fake-coder-nooff-${suffix}`, messages: [user('plain')], reasoning: { effort: 'none' } },
    { path: OPENROUTER_CHAT, timeoutMs: 2000 })));
  record('MP-38 -nooff order: refused before -404, -hang and -stall (stacked suffixes get the 400 body at once)',
    stacked.every((r) => r.status === 400 && r.raw === NOOFF_BODY_EXPECTED),
    stacked.map((r) => `${r.status} ${r.error ?? ''}`).join(', '));
  const notOff = await chat(f.port, { model: 'fake-coder-nooff-404', messages: [user('plain')],
    reasoning: { effort: 'medium' } }, { path: OPENROUTER_CHAT });
  record('MP-38 -nooff order: without thinking off a stacked -404 still answers 404', notOff.status === 404);
  // 先在 -nooff-replay 上开着思考调一次工具（调用记进 -replay 的名单），再关着思考、不带推理内容回传
  const model = 'fake-coder-nooff-replay';
  const first = await chat(f.port, { model, messages: [user(WEATHER)], tools: [weatherTool],
    reasoning: { effort: 'medium' } }, { path: OPENROUTER_CHAT });
  const follow = (name) => chat(f.port, { model: name, messages: step4Messages(first.calls[0]), tools: [weatherTool],
    reasoning: { effort: 'none' } }, { path: OPENROUTER_CHAT });
  const both = await follow(model);
  const replayOnly = await follow('fake-coder-replay');
  record('MP-38 -nooff order: refused before -replay (both apply: the -nooff body; -replay alone: its own 400)',
    first.calls[0]?.name === 'get_weather' && both.status === 400 && both.raw === NOOFF_BODY_EXPECTED
    && replayOnly.status === 400 && replayOnly.raw !== NOOFF_BODY_EXPECTED, `${both.raw} / ${replayOnly.raw}`);
}

/** @brief 2026-10-24 补丁（§7.7、§14.1）的全部检查，都在单独的端点上（不影响其他检查对日志行的计数）。 */
async function checkReasoningMandatory(f, g) {
  await checkNoOffRefusal(f);
  await checkNoOffAnswers(f);
  await checkOpenRouterPrefix(f);
  await checkEffortLog(f);
  await checkThinkingOn(f);
  await checkThinkLong(f);
  await checkNoOffOrder(f, g);
  await checkToolLong(f);
  await checkRefusedOffFollowUp(f);
}

const a = await startEndpoint({ FAKE_KEYS: 'key-aaaa1,key-bbbb2,key-cccc3', FAKE_LIMITED_KEYS: 'key-bbbb2',
  FAKE_LIMIT_MS: '1500', FAKE_QUOTA_KEYS: 'key-cccc3', FAKE_SERVER_VERSION: '0.9.9', FAKE_MAX_MODEL_LEN: '4000' });
const b = await startEndpoint({ FAKE_REQUIRE_KEY: 'req-key-1' });
const c = await startEndpoint({ FAKE_LIMITED_KEYS: 'none' });
const d = await startEndpoint({});
const scriptDir = mkdtempSync(join(tmpdir(), 'mori-enhance-script-'));
const scriptFile = join(scriptDir, 'enhance.json');
writeFileSync(scriptFile, '{}');
// synthetic：增强脚本文件与 mem-team 的依据（会话文件路径、条目 id 只是字符串，端点不读它们）
const e = await startEndpoint({ FAKE_ENHANCE_SCRIPT: scriptFile, MEM_TEAM_SESSION: 'C:\\synthetic\\a.jsonl',
  MEM_TEAM_ENTRY: 'e1e2e3e4', MEM_TEAM_USER_ENTRY: 'user-rule', MEM_TEAM_OTHER_ENTRY: 'other-kind' });
const shapes = await startShapes();
// 2026-10-24 补丁（§7.7、§14.1）的检查单独用一份端点：/openrouter.ai/v1 前缀的请求不进 a 的日志行计数；
// g 设了 FAKE_KEYS（synthetic 的 key），测 -nooff 排在认证之后
const f = await startEndpoint({});
const g = await startEndpoint({ FAKE_KEYS: NOOFF_ORDER_KEY });
// 2026-10-26 补：-404 的模型照常回答的一份端点（FAKE_SERVE_404）
const h = await startEndpoint({ FAKE_SERVE_404: '1' });
try {
  await checkGets(a, c);
  await checkKeys(a, b, c);
  await checkProbesPass(a);
  await checkProbeSuffixes(a);
  await checkReplay(a);
  await checkNonProbeSuffixes(a);
  await checkHttpKeywords(a);
  await checkOtherKeywords(a);
  await checkExisting(a);
  await checkScenarioSelection(d);
  await checkKinds(d);
  await checkPositions(d);
  await checkTiers(d);
  await checkClose(d);
  await checkFailuresAndTemplates(d);
  await checkIdsAndLog(d, a);
  await checkStrictAndReasoningLog(d);
  await checkEnhance(e, d, scriptFile);
  await checkMemTeam(e);
  await checkDiscovery(a, c, shapes);
  await checkReasoningMandatory(f, g);
  await checkServe404(f, h);
  checkLogs(a);
  checkDiscoveryLogs(a, shapes);
} catch (error) {
  record('selfcheck ran to the end', false, error.stack);
} finally {
  a.kill();
  b.kill();
  c.kill();
  d.kill();
  e.kill();
  f.kill();
  g.kill();
  h.kill();
  for (const endpoint of Object.values(shapes)) endpoint.kill();
  rmSync(scriptDir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
