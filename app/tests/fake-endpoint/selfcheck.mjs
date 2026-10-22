// 合成测试端点（synthetic）的自检：在空闲端口上起几份 server.mjs（不同的环境变量），用 fetch 逐条检查
// docs/specs/model-providers.md §14.1 的行为与原有关键词，每条打印 PASS/FAIL；有 FAIL 时退出码为 1。
// 用法（在 app/ 下）：node tests/fake-endpoint/selfcheck.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const a = await startEndpoint({ FAKE_KEYS: 'key-aaaa1,key-bbbb2,key-cccc3', FAKE_LIMITED_KEYS: 'key-bbbb2',
  FAKE_LIMIT_MS: '1500', FAKE_QUOTA_KEYS: 'key-cccc3', FAKE_SERVER_VERSION: '0.9.9', FAKE_MAX_MODEL_LEN: '4000' });
const b = await startEndpoint({ FAKE_NO_METRICS: '1', FAKE_REQUIRE_KEY: 'req-key-1' });
const c = await startEndpoint({ FAKE_LIMITED_KEYS: 'none' });
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
  await checkCancel(a, b);
  checkLogs(a);
} catch (error) {
  record('selfcheck ran to the end', false, error.stack);
} finally {
  a.kill();
  b.kill();
  c.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
