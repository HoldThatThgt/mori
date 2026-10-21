// 合成测试端点（synthetic）的自检：在空闲端口上起几份 server.mjs（不同的环境变量），用 fetch 逐条检查
// docs/specs/model-providers.md §14.1 的行为与原有关键词，以及 docs/specs/parallel-agents-taskboard.md §17.1 的脚本模式
// （scripts.mjs 的 tb-selfcheck-* 场景），每条打印 PASS/FAIL；有 FAIL 时退出码为 1。
// 用法（在 app/ 下）：node tests/fake-endpoint/selfcheck.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOSE_REQUEST_TAGS, END_TEXT, KIND_ORDER, NO_STEP_TEXT, RESTART_PREFIX, SEGMENT_SENTENCES, SHARED_SENTENCE,
  WORK_CARD_CLOSE, WORK_CARD_OPEN } from './scripts.mjs';

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
    for (const call of delta.tool_calls ?? []) {
      out.calls[call.index] ??= { id: call.id, name: call.function?.name, args: '' };
      out.calls[call.index].args += call.function?.arguments ?? '';
    }
    if (delta.content || delta.reasoning_content || delta.tool_calls) {
      out.contentChunks += 1;
      out.firstAt ??= Date.now();
    }
  }
}

/** @brief 读 SSE 响应体；opts.abortAfterFirst 时收到第一段内容后先调 opts.onFirst，再断开。 */
async function readStream(res, out, controller, opts) {
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
    if (opts.abortAfterFirst && out.contentChunks > 0) {
      await opts.onFirst?.();
      controller.abort();
      out.error = 'aborted';
      return;
    }
  }
}

/**
 * @brief 发一个流式对话请求。
 * @param opts { key, abortAfterFirst, onFirst, timeoutMs }
 * @return { status, headers, body（错误体）, text, reasoning, calls, contentChunks, done, error, startedAt, firstAt }
 */
async function chat(port, body, opts = {}) {
  const controller = new AbortController();
  const headers = { 'Content-Type': 'application/json' };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
  const out = { status: 0, text: '', reasoning: '', calls: [], contentChunks: 0, done: false, error: null,
    startedAt: Date.now(), firstAt: null };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers,
      body: JSON.stringify({ model: 'fake-coder', stream: true, ...body }), signal: controller.signal });
    out.status = res.status;
    out.headers = res.headers;
    if (!res.ok) out.body = await res.json().catch(() => null);
    else await readStream(res, out, controller, opts);
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

/** @brief /metrics 里的进行中请求数；没有时为 null。 */
async function running(port) {
  const { status, text } = await get(port, '/metrics');
  const match = /^vllm:num_requests_running\{[^}]*\} ([\d.]+)$/m.exec(text);
  return status === 200 && match ? Number(match[1]) : null;
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

/** @brief 第 8 步的提示：开头放暗号，填充到约 tokens 个 token，最后问暗号。 */
function passphrasePrompt(tokens) {
  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil((tokens * 4) / 45));
  return `The passphrase is ZEBRA-42.\n${filler.slice(0, tokens * 4)}\nWhat is the passphrase?`;
}

/** @brief GET 接口：/version、/models、/metrics、/api/version、/props。 */
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
  const metrics = await get(a.port, '/metrics');
  record('GET /metrics is Prometheus text with vllm:num_requests_running 0',
    metrics.status === 200 && metrics.text.includes('# TYPE vllm:num_requests_running gauge')
    && (await running(a.port)) === 0, metrics.text);
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

/** @brief 第 8 步：没有 -truncate 时 50%、90% 都答对；-truncate 时 50% 答对、90% 答不出。 */
async function checkLongInput(a) {
  const key = 'key-aaaa1';
  const ask = (model, tokens) => chat(a.port, { model, messages: [user(passphrasePrompt(tokens))] }, { key });
  const half = await ask('fake-coder', 2000);
  const most = await ask('fake-coder', 3600);
  record('probe 8: passphrase recalled at 50% and 90% of max_model_len',
    half.text === 'ZEBRA-42' && most.text === 'ZEBRA-42', `${half.text} / ${most.text}`);
  const tHalf = await ask('fake-coder-truncate', 2000);
  const tMost = await ask('fake-coder-truncate', 3600);
  record('-truncate: 50% recalled, 90% silently loses the passphrase (200, no error)',
    tHalf.text === 'ZEBRA-42' && tMost.status === 200 && tMost.text !== 'ZEBRA-42', `${tHalf.text} / ${tMost.text}`);
}

/** @brief 第 9 步与 /metrics：断开后计数回落；-nocancel 10 秒内不回落；FAKE_NO_METRICS=1 为 404。 */
async function checkCancel(a, b) {
  const key = 'key-aaaa1';
  const count = { messages: [user('Count from 1 to 300, one number per line.')] };
  let during = null;
  const first = await chat(a.port, count, { key, abortAfterFirst: true, onFirst: async () => {
    during = await running(a.port);
  } });
  await sleep(200);
  record('probe 9: long output; /metrics counts it while running and drops after disconnect',
    during === 1 && first.error === 'aborted' && (await running(a.port)) === 0, `during=${during}`);
  const stuck = await chat(a.port, { ...count, model: 'fake-coder-nocancel' }, { key, abortAfterFirst: true });
  await sleep(500);
  const after = await running(a.port);
  record('-nocancel: count stays up after disconnect (probe 9 too)', stuck.error === 'aborted' && after === 1,
    `after=${after}`);
  const full = await chat(a.port, { ...count, model: 'fake-coder-nocancel' }, { key });
  record('-nocancel: a completed request does not linger', full.done && (await running(a.port)) === 1);
  await sleep(10000);
  record('-nocancel: count drops after 10 s', (await running(a.port)) === 0);
  record('FAKE_NO_METRICS=1: /metrics is 404', (await get(b.port, '/metrics')).status === 404);
}

/** @brief 只作用于非探针请求的后缀：-404、-hang、-stall。 */
async function checkNonProbeSuffixes(a) {
  const key = 'key-aaaa1';
  const probe = { messages: [user('Reply with the single word: ready.')] };
  const plain = { messages: [user('plain')] };
  for (const suffix of ['404', 'hang', 'stall']) {
    const passed = await chat(a.port, { ...probe, model: `fake-coder-${suffix}` }, { key, timeoutMs: 2000 });
    record(`-${suffix}: probes are unaffected`, passed.done && passed.text === 'ready');
  }
  const missing = await chat(a.port, { ...plain, model: 'fake-coder-404' }, { key });
  record('-404: non-probe request is 404', missing.status === 404);
  const hang = await chat(a.port, { ...plain, model: 'fake-coder-hang' }, { key, timeoutMs: 600 });
  record('-hang: no response headers', hang.status === 0 && hang.error === 'aborted');
  const stall = await chat(a.port, { ...plain, model: 'fake-coder-stall' }, { key, timeoutMs: 600 });
  record('-stall: headers 200 then no content', stall.status === 200 && stall.contentChunks === 0
    && stall.error === 'aborted');
  await sleep(100);
  record('-hang/-stall: disconnect drops the running count', (await running(a.port)) === 0);
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

/** @brief 日志：METHOD url 行、启动的 synthetic 行、每个对话请求一行 JSON。 */
function checkLogs(a) {
  record('log: startup line mentions synthetic', a.lines.some((l) => l.includes('synthetic')));
  record('log: "METHOD url" lines kept', a.lines.some((l) => l === '[fake-endpoint] POST /v1/chat/completions'));
  const json = a.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
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
const createTurn = (rest, open) => [CREATE_SYSTEM, CREATE_ASK, ...rest, card('Team mode: on', 'Open requests:',
  ...open)];

/** @brief 端点的 JSON 日志行。 */
const jsonLines = (endpoint) => endpoint.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

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

const a = await startEndpoint({ FAKE_KEYS: 'key-aaaa1,key-bbbb2,key-cccc3', FAKE_LIMITED_KEYS: 'key-bbbb2',
  FAKE_LIMIT_MS: '1500', FAKE_QUOTA_KEYS: 'key-cccc3', FAKE_SERVER_VERSION: '0.9.9', FAKE_MAX_MODEL_LEN: '4000' });
const b = await startEndpoint({ FAKE_NO_METRICS: '1', FAKE_REQUIRE_KEY: 'req-key-1' });
const c = await startEndpoint({ FAKE_LIMITED_KEYS: 'none' });
const d = await startEndpoint({});
try {
  await checkGets(a, c);
  await checkKeys(a, b, c);
  await checkProbesPass(a);
  await checkProbeSuffixes(a);
  await checkReplay(a);
  await checkLongInput(a);
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
  await checkCancel(a, b);
  checkLogs(a);
} catch (error) {
  record('selfcheck ran to the end', false, error.stack);
} finally {
  a.kill();
  b.kill();
  c.kill();
  d.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
