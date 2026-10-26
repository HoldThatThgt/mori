// 一键拉取模型首次启动表单的 App 套件（tests/ui/md-app-firstrun.mjs）用的准备、操作与读取
// （docs/specs/model-discovery.md §6.6、§13.2 的 MD-08 与 MD-11；状态表与界面标识见 docs/v1/screens/first-run.md）：
// - 合成端点（tests/fake-endpoint/server.mjs，synthetic）：一个端口一种行为（4840–4859），收集列表、详情与对话请求的
//   JSON 日志行（带收到的时刻 t）；
// - 列表门（synthetic test setup，见 startListGate）：列表请求一律 401，其余请求原样转发给合成端点；可以让探针第 1 步
//   与第 3 步（tool calling）的请求得到 400（制造“探针出错”，tool calling 因此没有验证）；
// - App：启动、关闭，收集主进程与后台进程的输出和页面 console；经 CDP 在 preload 的隔离环境里给 MessagePort 的
//   postMessage 包一层，记下发出的命令摘要（window.mori 被 contextBridge 冻结，页面里包不了；key 只记末 4 位）；
// - 表单：填 Base URL 与 API key、Fetch models 并等它返回、一次读出表单与清单的全部状态、改清单的行、Test connection 与
//   它的结果（成功时表单关掉，结果在主窗口的 Open a folder 提示里，readMain）、记录按钮的变化；首次启动卡片的宽度，
//   以及经 CDP 模拟比 720px 窄的视口；
// - 探针：经进程桥读 models.get 的档案（page.mjs readProbe；2026-10-26 起首次启动表单下方没有探针状态）；
// - 会话：首次启动测试成功后，主窗口 Open a folder 提示的 Open folder… 之后新会话的范围（模型按钮的 data-pick）、
//   拒绝启动卡的每一次变化（watchCards）与发送。
// 只读页面和磁盘、发界面操作，不改 Mori 的源码；key 都是测试自己生成的合成值，与任何真实服务无关。

import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { appRoot, launch, oneLine, sleep } from './lib.mjs';
import { PANE, stubFolder, waitReady } from './m3-helpers.mjs';
import { readProbe } from './page.mjs';

export { oneLine, sleep };

/** 首次启动表单 */
export const FORM = '[data-testid="connection-form"]';
/** 当前一栏的拒绝启动卡 */
export const CARD = `${PANE} [data-testid="blocked-card"]`;

/** @brief 反复读 read()，直到 test 通过或超时；返回是否通过和最后读到的值。 */
export async function poll(read, test, timeout = 15000, step = 150) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!test(value) && Date.now() < deadline) {
    await sleep(step);
    value = await read();
  }
  return { ok: Boolean(test(value)), value };
}

/** @brief 一行概括（检查的 detail）。 */
export const brief = (value, max = 900) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);

// ---------- 合成端点 ----------

/** @brief 按行收集一个流。 */
function collectLines(stream, onLine) {
  let rest = '';
  stream.on('data', (chunk) => {
    rest += String(chunk);
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
}

/**
 * @brief 启动一个合成端点（synthetic），收集它的 JSON 日志行（带收到的时刻 t）。
 * @param port 端口（4840–4859）
 * @param env 环境变量（FAKE_LIST_SHAPE、FAKE_MODELS、FAKE_LIST_DELAY_MS、FAKE_REQUIRE_KEY、FAKE_FIRST_DELAY_MS）
 * @return { child, port, logs }
 */
export function startEndpoint(port, env = {}) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '5', FAKE_FIRST_DELAY_MS: '20', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endpoint = { child, port, logs: [] };
  return new Promise((done, fail) => {
    // 15 秒内没起来：结束这个进程再报错（它还没放进调用方的列表，调用方的 finally 关不到它）
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`fake endpoint ${port} did not start within 15 s`));
    }, 15000);
    child.on('exit', (code) => fail(new Error(`fake endpoint ${port} exited with ${code}`)));
    child.stderr.on('data', () => {});
    collectLines(child.stdout, (line) => {
      if (line.includes('synthetic endpoint on')) {
        clearTimeout(timer);
        done(endpoint);
      }
      if (!line.startsWith('{')) return;
      try {
        endpoint.logs.push({ t: Date.now(), ...JSON.parse(line) });
      } catch {
        // 不是日志行
      }
    });
  });
}

/** @brief 结束合成端点进程，等它退出（最多 5 秒）。 */
export async function stopEndpoint(endpoint) {
  const { child } = endpoint;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((done) => child.once('exit', done));
  child.kill();
  await Promise.race([gone, sleep(5000)]);
}

/** @brief since 之后的列表与详情请求日志行（有 path 字段的）。 */
export const discoveryLogs = (endpoint, since = 0) => endpoint.logs.filter((line) => 'path' in line && line.t >= since);

/** @brief since 之后以 /models 结尾的列表请求日志行。 */
export const listLogs = (endpoint, since = 0) => discoveryLogs(endpoint, since)
  .filter((line) => line.path.endsWith('/models'));

/** @brief since 之后的对话请求日志行（有 model 字段、没有 path 字段的）。 */
export const chatLogs = (endpoint, since = 0) => endpoint.logs
  .filter((line) => !('path' in line) && 'model' in line && line.t >= since);

/** @brief since 之后不是探针的对话请求（测试连接与会话）。 */
export const plainChats = (endpoint, since = 0) => chatLogs(endpoint, since).filter((line) => !line.probe);

// ---------- 列表门（synthetic test setup） ----------

/**
 * 列表门回答列表请求的 401 原文（synthetic，依据：OpenAI 的受限 key 没有 Models 读权限时 GET /v1/models 返回 401
 * “You have insufficient permissions for this operation. Missing scopes: api.model.read.”，对话照样可用；
 * 合成端点的 key 规则对列表与对话相同，造不出“只有列表被拒”，所以在它前面放这一层）
 */
export const GATE_MESSAGE = 'You have insufficient permissions for this operation. Missing scopes: api.model.read.';
/** 列表门回答列表请求的 401 响应体（原文，§5.2 的 listError.detail 就是它） */
export const GATE_BODY = JSON.stringify({ error: { message: GATE_MESSAGE, type: 'invalid_request_error' } });
/** 列表门让探针第 1、3 步失败时的原文（synthetic） */
export const GATE_PROBE_MESSAGE = 'Synthetic probe failure from the list gate';
/**
 * 列表门让它失败的探针提示（kernel/probes.ts 的 PROBE_PROMPTS）：第 1 步（ready）与第 3 步（weather）。
 * 只拒绝第 1 步时第 3、4 步照样通过，tool calling 是 verified，会话不会被拒绝；第 3 步也拒绝，tool calling 才是
 * unverified（first-run.md “打开文件夹之后”的“探针出错”：卡上 tool calling not verified yet 与 Verify now）
 */
const GATE_PROBE_PROMPTS = ['Reply with the single word: ready.',
  'Use the tool to get the weather for Paris for the next 3 days.'];

/** @brief 读完请求体。 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** @brief 以 JSON 回复。 */
function answerJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** @brief 把请求原样转发给上游端口，原样交还响应（含流式）；对方断开时也断开上游。 */
function forward(req, res, raw, upstream) {
  const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url,
    headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  res.on('close', () => up.destroy());
  up.on('error', () => res.destroy());
  up.end(raw);
}

/** @brief 请求的 key 末 4 位（Authorization: Bearer，没有时 x-api-key）；没有为 null。 */
function keyTail(req) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? req.headers['x-api-key'] ?? null;
  return bearer ? bearer.slice(-4) : null;
}

/**
 * @brief 启动列表门（synthetic test setup）：GET 路径以 /models 结尾的请求一律 401（GATE_MESSAGE）；gate.probeFail
 *        为真时，带探针第 1 步或第 3 步提示（GATE_PROBE_PROMPTS）的对话请求得到 400（GATE_PROBE_MESSAGE）；
 *        其余原样转发给 upstream。
 *        每个请求记一行 { t, method, path, key（末 4 位）, answered（gate / forward） }。
 */
export function startListGate(port, upstream) {
  const gate = { port, logs: [], probeFail: false, server: null };
  gate.server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const path = (req.url ?? '').split('?')[0];
      const list = req.method === 'GET' && path.endsWith('/models');
      const probe = req.method === 'POST' && gate.probeFail
        && GATE_PROBE_PROMPTS.some((prompt) => String(raw).includes(prompt));
      gate.logs.push({ t: Date.now(), method: req.method, path, key: keyTail(req),
        answered: list || probe ? 'gate' : 'forward' });
      if (list) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(GATE_BODY);
      }
      if (probe) return answerJson(res, 400, { error: { message: GATE_PROBE_MESSAGE, type: 'invalid_request_error' } });
      return forward(req, res, raw, upstream);
    })().catch(() => res.destroy());
  });
  return new Promise((done) => gate.server.listen(port, '127.0.0.1', () => done(gate)));
}

/** @brief 关闭列表门（断开还开着的连接）。 */
export function stopListGate(gate) {
  gate.server.closeAllConnections?.();
  return new Promise((done) => gate.server.close(() => done()));
}

// ---------- App ----------

/**
 * @brief 用 userData 启动 Mori，收集输出与页面报错，等到首次启动表单或三栏布局出现。
 * @return { app, page, userData, logs, pageErrors, cdp, world }（cdp、world 由 watchCommands 填上）
 */
export async function startApp(userData, exePath) {
  const app = await launch({ exePath, userData });
  const page = await app.firstWindow().catch(async (error) => {
    await app.close().catch(() => {});
    throw error;
  });
  const ctx = { app, page, userData, logs: [], pageErrors: [], cdp: null, world: null };
  app.process().stdout?.on('data', (chunk) => ctx.logs.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => ctx.logs.push(String(chunk)));
  page.on('console', (message) => ctx.logs.push(message.text()));
  page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  try {
    await page.waitForSelector(`${FORM}, [data-testid="sidebar"]`, { timeout: 60000 });
  } catch (error) {
    // 调用方拿不到 ctx，关不了这个 App：先关掉再报错，不留 Electron 进程
    await closeApp(ctx);
    throw error;
  }
  return ctx;
}

/** @brief 关闭 Mori。 */
export async function closeApp(ctx) {
  if (!ctx) return;
  await ctx.cdp?.detach().catch(() => {});
  await ctx.app.close().catch(() => {});
  await sleep(500);
}

/**
 * 在 preload 隔离环境里执行：给 MessagePort.prototype.postMessage 包一层，把命令摘要放进 globalThis.__mdSent。
 * models.discover 记 kind、baseUrl、api、key（末 4 位，没有为 null）；models.firstRun 记 providerId、key、
 * 提供商的 Name、地址、接口、模型 id，以及 digest：{ provider, models } 的 JSON（同 FirstRunForm 比较"表单有没有
 * 改动"用的内容，不含 key）的 FNV-1a 摘要，比较两次保存的内容是否相同；connection.test 记 providerId、modelId；
 * 其他只记 type。
 */
const HOOK = `(() => {
  if (globalThis.__mdSent) return 'already';
  globalThis.__mdSent = [];
  const tail = (secret) => (secret ? secret.slice(-4) : null);
  const digest = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return hash.toString(16);
  };
  const summary = (c) => {
    if (c.type === 'models.discover') return { type: c.type, kind: c.target.kind, baseUrl: c.target.baseUrl ?? null,
      api: c.target.api ?? null, key: tail(c.target.keySecret) };
    if (c.type === 'models.firstRun') return { type: c.type, providerId: c.providerId, key: tail(c.keySecret),
      name: c.provider.name, baseUrl: c.provider.baseUrl, api: c.provider.api,
      models: c.models.map((m) => m.id), digest: digest(JSON.stringify({ provider: c.provider, models: c.models })) };
    if (c.type === 'connection.test') return { type: c.type, providerId: c.providerId, modelId: c.modelId };
    return { type: c.type };
  };
  const original = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    try {
      if (message && message.command) globalThis.__mdSent.push({ t: Date.now(), ...summary(message.command) });
    } catch (error) {
      globalThis.__mdSent.push({ t: Date.now(), type: 'unreadable', error: String(error) });
    }
    return original.call(this, message, ...rest);
  };
  return 'hooked';
})()`;

/** @brief 经 CDP 找到 preload 的隔离环境并装上 HOOK；装不上时报错。 */
export async function watchCommands(ctx) {
  const cdp = await ctx.page.context().newCDPSession(ctx.page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
  await cdp.send('Runtime.enable');
  const found = await poll(() => contexts.find((c) => c.name === 'Electron Isolated Context'), Boolean, 5000, 100);
  if (!found.ok) throw new Error('preload isolated context not found');
  const result = await cdp.send('Runtime.evaluate', { contextId: found.value.id, expression: HOOK,
    returnByValue: true });
  if (!['hooked', 'already'].includes(result.result?.value)) throw new Error(`hook failed: ${brief(result)}`);
  ctx.cdp = cdp;
  ctx.world = found.value.id;
}

/** @brief 发出的命令摘要（since 之后，type 为 types 之一）。 */
export async function sentCommands(ctx, types, since = 0) {
  const result = await ctx.cdp.send('Runtime.evaluate', { contextId: ctx.world,
    expression: 'JSON.stringify(globalThis.__mdSent ?? [])', returnByValue: true });
  return JSON.parse(result.result.value).filter((c) => types.includes(c.type) && c.t >= since);
}

/** @brief 最后一个 models.discover 命令摘要；没有时为 null。 */
export async function lastDiscover(ctx, since = 0) {
  return (await sentCommands(ctx, ['models.discover'], since)).at(-1) ?? null;
}

// ---------- 读表单 ----------

/**
 * 在页面里执行：表单上半部分（first-run.md "表单字段"的 Base URL 到 API type）。表单不在时为 null。
 * 字段按标签找（TextRow 的 label 指向输入框）。
 */
function readHeadInPage() {
  const form = document.querySelector('[data-testid="connection-form"]');
  if (!form) return null;
  const all = (selector) => [...form.querySelectorAll(selector)];
  const one = (selector) => form.querySelector(selector);
  const byLabel = (label) => {
    const element = all('label').find((item) => item.textContent === label);
    return element?.htmlFor ? document.getElementById(element.htmlFor) : null;
  };
  const input = (element) => element && { value: element.value, readOnly: element.readOnly,
    placeholder: element.placeholder, type: element.type, disabled: element.disabled };
  const button = (element) => element && { text: element.textContent, disabled: element.disabled };
  const status = one('[data-testid="fetch-status"]');
  const detected = one('[data-testid="detected-server"]');
  return {
    title: document.querySelector('.first-run-card h2')?.textContent ?? null,
    description: document.querySelector('.first-run-card h2 + p')?.textContent ?? null,
    migrationError: document.querySelector('[data-testid="migration-error"]')?.textContent ?? null,
    baseUrl: input(byLabel('Base URL')), apiKey: input(byLabel('API key')),
    fetch: button(one('[data-action="fetch-models"]')), fetchCancel: button(one('[data-action="fetch-cancel"]')),
    fetchStatus: status && { state: status.dataset.state, text: status.textContent },
    fieldErrors: all('[data-testid="field-error"]').filter((e) => !e.closest('[data-testid="discovered-row"]'))
      .map((e) => `${e.dataset.field}:${e.textContent}`),
    messages: all('[data-testid="form-message"]').map((m) => m.textContent),
    detected: detected && { kind: detected.dataset.kind, text: detected.textContent },
    baseUrlNote: one('[data-testid="base-url-note"]')?.textContent ?? null,
    name: byLabel('Name')?.value ?? null, api: byLabel('API type')?.value ?? null,
  };
}

/** 在页面里执行：清单或列表错误、行（first-run.md "界面测试用的标识"）与 Add a model ID。表单不在时为 null。 */
function readListInPage() {
  const form = document.querySelector('[data-testid="connection-form"]');
  if (!form) return null;
  const all = (selector, root = form) => [...root.querySelectorAll(selector)];
  const one = (selector, root = form) => root.querySelector(selector);
  const listError = one('[data-testid="list-error"]');
  const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const row = (element) => {
    const field = (name) => element.querySelector(`input[data-field="${name}"]`);
    const pick = element.querySelector('input[name="pick"]');
    return { id: element.dataset.model, chat: element.dataset.chat, unusable: element.dataset.unusable === 'true',
      added: element.dataset.added === 'true', picked: pick.checked, pickDisabled: pick.disabled,
      pickLabel: pick.getAttribute('aria-label'), contextWindow: field('contextWindow').value,
      maxTokens: field('maxTokens').value, reasoning: field('reasoning').checked, image: field('image').checked,
      tags: all('[data-testid="row-tag"]', element).map((t) => ({ kind: t.dataset.kind, text: t.textContent })),
      hints: all('[data-testid="row-hint"]', element).map((t) => t.dataset.kind),
      defaults: all('[data-testid="default-value"]', element).map((t) => `${t.dataset.field}:${t.textContent}`),
      errors: all('[data-testid="field-error"]', element).map((e) => `${e.dataset.field}:${e.textContent}`),
      afterListError: listError ? after(listError, element) : null };
  };
  const checklist = one('[data-testid="checklist"]');
  const filter = one('[data-testid="checklist-filter"]');
  const manual = one('[data-testid="manual-model"]');
  return {
    checklist: Boolean(checklist), heading: checklist?.querySelector('h4')?.textContent ?? null,
    selectAll: Boolean(one('[data-action="select-all"]')),
    clearSelection: Boolean(one('[data-action="clear-selection"]')),
    filter: filter && { placeholder: filter.placeholder, value: filter.value },
    truncated: one('[data-testid="checklist-truncated"]')?.textContent ?? null,
    notes: all('.fetch-note').map((note) => note.textContent),
    listError: listError && { kind: listError.dataset.kind, text: all('p', listError).map((p) => p.textContent) },
    rows: all('[data-testid="discovered-row"]').map(row),
    manual: manual && { value: one('input[data-field="id"]', manual).value,
      addDisabled: one('[data-action="add-to-list"]', manual).disabled,
      errors: all('[data-testid="field-error"]', manual).map((e) => e.textContent) },
  };
}

/**
 * 在页面里执行：表单底部（More settings、探针代价、Test connection），以及 order：出现了的区块在文档里的先后是否同
 * §6.1、§6.6 的顺序。表单不在时为 null。2026-10-26 起表单下方没有探针状态与 Open folder…（first-run.md）。
 */
function readFootInPage() {
  const form = document.querySelector('[data-testid="connection-form"]');
  if (!form) return null;
  const one = (selector) => form.querySelector(selector);
  const byLabel = (label) => {
    const element = [...form.querySelectorAll('label')].find((item) => item.textContent === label);
    return element?.htmlFor ? document.getElementById(element.htmlFor) : null;
  };
  const button = (element) => element && { text: element.textContent, disabled: element.disabled };
  const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const blocks = [byLabel('Base URL'), byLabel('API key'), one('[data-action="fetch-models"]'),
    one('[data-testid="detected-server"]'), one('[data-testid="base-url-note"]'), byLabel('Name'),
    byLabel('API type'), one('[data-testid="checklist"], [data-testid="list-error"]'),
    one('[data-testid="manual-model"]'), one('[data-testid="more-settings"]'), one('[data-testid="probe-cost-note"]'),
    one('[data-action="test"]')].filter(Boolean);
  return {
    moreSettings: Boolean(one('[data-testid="more-settings"]')),
    probeCost: one('[data-testid="probe-cost-note"]')?.textContent ?? null,
    test: button(one('[data-action="test"]')), testCancel: button(one('[data-action="test-cancel"]')),
    closeForm: document.querySelectorAll('[data-action="close-form"]').length,
    cancelButtons: [...form.querySelectorAll('button')].filter((b) => b.textContent === 'Cancel')
      .map((b) => b.dataset.action ?? ''),
    order: blocks.every((block, index) => index === 0 || after(blocks[index - 1], block)), blocks: blocks.length,
  };
}

/**
 * 在页面里执行：首次启动表单在不在、侧栏在不在（三栏布局），以及主窗口的 Open a folder 提示（first-run.md
 * "测试成功之后：主窗口"）：标题、标题下面"Connected · …"一行（没有时为 null）与它是否紧跟在标题后、是不是成功的颜色、
 * 说明、有没有 Open folder…。没有提示时 prompt 为 null。
 */
function readMainInPage() {
  const prompt = document.querySelector('[data-testid="open-folder"]');
  const line = prompt?.querySelector('[data-testid="connected"]') ?? null;
  const heading = prompt?.querySelector('h2') ?? null;
  return {
    form: Boolean(document.querySelector('[data-testid="connection-form"]')),
    sidebar: Boolean(document.querySelector('[data-testid="sidebar"]')),
    prompt: prompt && { heading: heading?.textContent ?? null, connected: line?.textContent ?? null,
      underHeading: Boolean(line && heading?.nextElementSibling === line),
      tone: line?.classList.contains('ok') ?? false,
      hint: prompt.querySelector('p.muted')?.textContent ?? null,
      open: [...prompt.querySelectorAll('button')].some((button) => button.textContent === 'Open folder…') },
  };
}

/** @brief 首次启动表单、侧栏与主窗口的 Open a folder 提示（readMainInPage）。 */
export const readMain = (page) => page.evaluate(readMainInPage);

/**
 * @brief 读出首次启动表单的全部状态（上半部分、清单、底部三段合在一起）；表单不在时为 null。
 *        API key 框的值不带出来（检查的 detail 会写进结果文件）：换成 length（字数）与 tail（末 4 位）。
 */
export async function readForm(page) {
  const head = await page.evaluate(readHeadInPage);
  if (!head) return null;
  const list = await page.evaluate(readListInPage);
  const foot = await page.evaluate(readFootInPage);
  if (head.apiKey) {
    const { value, ...rest } = head.apiKey;
    head.apiKey = { ...rest, length: value.length, tail: value ? value.slice(-4) : null };
  }
  return list && foot ? { ...head, ...list, ...foot } : null;
}

/** @brief 清单里 id 那一行的状态；没有时为 undefined。 */
export const rowIn = (state, id) => state?.rows.find((row) => row.id === id);

/** @brief 清单的行的摘要（比较“没变”用）：id、勾选与四个值。 */
export const rowsDigest = (state) => JSON.stringify((state?.rows ?? []).map((row) => [row.id, row.picked,
  row.contextWindow, row.maxTokens, row.reasoning, row.image]));

/** @brief 表单是不是在“开始”的状态：只有 Base URL、API key、Fetch models（first-run.md 状态表“开始”）。 */
export const atStart = (state) => Boolean(state?.baseUrl && state.apiKey && state.fetch) && state.name === null
  && state.api === null && !state.checklist && !state.listError && !state.manual
  && !state.moreSettings && state.probeCost === null && !state.test && !state.detected;

/** @brief 拉取返回了（不在拉取中，且有结果、列表错误、命令错误或“Fetch cancelled”）。 */
const fetchSettled = (state) => Boolean(state) && state.fetch?.text === 'Fetch models' && !state.fetchCancel
  && (state.checklist || Boolean(state.listError) || state.messages.length > 0
    || state.fetchStatus?.state === 'cancelled');

// ---------- 表单操作 ----------

/** @brief 表单里按标签找的输入框。 */
const field = (page, label) => page.locator(FORM).getByLabel(label, { exact: true });

/** @brief 填 Base URL（一次输入事件）。 */
export const setBaseUrl = (page, url) => field(page, 'Base URL').fill(url);
/** @brief 填 API key（一次输入事件）。 */
export const setKey = (page, secret) => field(page, 'API key').fill(secret);
/** @brief 填 Name。 */
export const setName = (page, name) => field(page, 'Name').fill(name);
/** @brief 选 API type（option 的 value）。 */
export const setApi = (page, api) => field(page, 'API type').selectOption(api);
/**
 * @brief 点 Fetch models，等 models.discover 发出（HOOK 记下）再等它返回，读出表单。
 * @param ctx startApp 的返回值（已 watchCommands）
 */
export async function fetchModels(ctx, timeout = 30000) {
  const since = Date.now();
  await ctx.page.locator(`${FORM} [data-action="fetch-models"]`).click();
  await poll(() => lastDiscover(ctx, since), Boolean, 5000, 50);
  return (await poll(() => readForm(ctx.page), fetchSettled, timeout, 100)).value;
}

/**
 * @brief 点 Fetch models，读出拉取中的表单（拉取的 Cancel 出现时）和返回后的表单。
 * @param ctx startApp 的返回值（已 watchCommands）
 * @return { during, after }；拉取中没读到（5 秒内 Cancel 没出现）时 during 为 null
 */
export async function fetchObserved(ctx, timeout = 30000) {
  const since = Date.now();
  await ctx.page.locator(`${FORM} [data-action="fetch-models"]`).click();
  const during = await poll(() => readForm(ctx.page), (state) => Boolean(state?.fetchCancel), 5000, 50);
  await poll(() => lastDiscover(ctx, since), Boolean, 5000, 50);
  const after = (await poll(() => readForm(ctx.page), fetchSettled, timeout, 100)).value;
  return { during: during.ok ? during.value : null, after };
}

/**
 * 在页面里执行：首次启动卡片的宽度、它能占的宽度 room（外层 .first-run 的内容区：clientWidth 去掉左右内边距）、
 * 卡片里清单的行数与有没有清单的表格。没有卡片时为 null。
 */
function cardInPage() {
  const card = document.querySelector('.first-run-card');
  const outer = card?.parentElement;
  if (!card || !outer) return null;
  const style = getComputedStyle(outer);
  const room = outer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return { width: card.getBoundingClientRect().width, room,
    rows: card.querySelectorAll('[data-testid="discovered-row"]').length,
    table: Boolean(card.querySelector('table')) };
}

/** @brief 首次启动卡片的宽度（cardInPage）。 */
export const cardWidth = (page) => page.evaluate(cardInPage);

/**
 * @brief 经 CDP 把页面的视口模拟成 size（{ width, height }）；size 为 null 时取消模拟。
 *        主窗口最窄 800px（src/main/index.ts 的 minWidth），放得下 720px 的卡片加两边的内边距，
 *        比 720px 窄的窗口只能这样造出来。
 */
export function emulateViewport(ctx, size) {
  if (!size) return ctx.cdp.send('Emulation.clearDeviceMetricsOverride');
  return ctx.cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height,
    deviceScaleFactor: 0, mobile: false });
}

/** @brief 清单里 id 那一行。 */
export const rowLocator = (page, id) => page.locator(`${FORM} [data-testid="discovered-row"][data-model="${id}"]`);

/** @brief 勾上或取消一行。 */
export const pickRow = (page, id, on) => rowLocator(page, id).locator('input[name="pick"]').setChecked(on);

/** @brief 改一行的 Context window 或 Max output（一次输入事件）。 */
export const setRowValue = (page, id, name, value) => rowLocator(page, id).locator(`input[data-field="${name}"]`)
  .fill(String(value));

/** @brief Add a model ID：填 id（不点 Add to list）。 */
export const typeManual = (page, id) => page.locator(`${FORM} [data-testid="manual-model"] input[data-field="id"]`)
  .fill(id);

/** @brief Add a model ID：填 id 并点 Add to list，等这一行出现。 */
export async function addManual(page, id) {
  await typeManual(page, id);
  await page.locator(`${FORM} [data-testid="manual-model"] [data-action="add-to-list"]`).click();
  await rowLocator(page, id).waitFor({ timeout: 5000 });
}

/** @brief 打开 More settings。 */
export async function openMoreSettings(page) {
  const details = page.locator(`${FORM} [data-testid="more-settings"]`);
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
}

/** @brief More settings 里的兼容选项勾选框（按标签文字）。 */
export const compatBox = (page, label) => page.locator(`${FORM} [data-testid="more-settings"] label.check-row`)
  .filter({ hasText: label }).locator('input[type="checkbox"]');

// ---------- 测试连接与探针状态 ----------

/** 测试连接的结果文字（含保存失败）的开头（state/settings.ts 的 testMessage、FirstRunForm.tsx） */
const RESULT_TEXT = /^(Connected|Connection failed|Test cancelled|Couldn[’']t save|Couldn[’']t test)/;

/**
 * @brief 测试结果文字：表单关掉、进入了主窗口时是 Open a folder 提示里的"Connected · …"（waitTestResult 的 handedOver），
 *        否则是表单底部那一条结果文字；没有时为 null。
 */
export const resultText = (state) => (state?.handedOver ? state.main.prompt?.connected ?? null
  : state?.messages?.find((text) => RESULT_TEXT.test(text)) ?? null);

/**
 * 在页面里执行：用 MutationObserver 记下 Test connection 按钮、两个框、Fetch models、测试的 Cancel 与主窗口的
 * "Connected · …"一行的每一次变化（“Saving…”可能只持续几十毫秒，轮询抓不到）。
 */
function watchInPage() {
  window.__mdSamples = [];
  window.__mdObserver?.disconnect();
  const sample = () => {
    const form = document.querySelector('[data-testid="connection-form"]');
    const testButton = form?.querySelector('[data-action="test"]');
    const inputs = form ? [...form.querySelectorAll('input')] : [];
    const line = document.querySelector('[data-testid="open-folder"] [data-testid="connected"]');
    const now = { test: testButton?.textContent ?? null, testDisabled: testButton?.disabled ?? null,
      readOnly: inputs.slice(0, 2).map((item) => item.readOnly),
      fetchDisabled: form?.querySelector('[data-action="fetch-models"]')?.disabled ?? null,
      testCancel: Boolean(form?.querySelector('[data-action="test-cancel"]')),
      connected: line?.textContent ?? null };
    const last = window.__mdSamples.at(-1);
    if (!last || JSON.stringify(last) !== JSON.stringify(now)) window.__mdSamples.push(now);
  };
  sample();
  window.__mdObserver = new MutationObserver(sample);
  window.__mdObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
    characterData: true });
}

/** @brief 开始记录按钮与"Connected · …"一行的变化（watchInPage）。 */
export const watchStates = (page) => page.evaluate(watchInPage);
/** @brief 记录到的变化。 */
export const watchedStates = (page) => page.evaluate(() => window.__mdSamples ?? []);

/**
 * @brief 点 Test connection（先开始记录变化），等 models.firstRun 或 connection.test 发出（HOOK 记下），不等结果。
 * @param ctx startApp 的返回值（已 watchCommands）
 */
export async function clickTest(ctx) {
  await watchStates(ctx.page);
  const since = Date.now();
  await ctx.page.locator(`${FORM} [data-action="test"]`).click();
  await poll(() => sentCommands(ctx, ['models.firstRun', 'connection.test'], since), (sent) => sent.length > 0,
    5000, 50);
}

/**
 * @brief 等测试连接结束。成功时首次启动表单关掉、进入主窗口（first-run.md "测试成功"）：返回 { handedOver: true, main }
 *        （main 为 readMain，resultText 取其中的"Connected · …"）；失败、已取消、保存失败时表单留着：返回读出的表单
 *        （按钮回到 Test connection 且有结果文字），另带 handedOver: false 与 main。
 */
export async function waitTestResult(page, timeout = 120000) {
  const read = async () => {
    const main = await readMain(page);
    if (!main.form && main.prompt?.connected) return { handedOver: true, main };
    const form = await readForm(page);
    return form && { ...form, handedOver: false, main };
  };
  const settled = (state) => Boolean(state) && (state.handedOver
    || (resultText(state) !== null && state.test?.text === 'Test connection'));
  return (await poll(read, settled, timeout, 150)).value;
}

/** @brief 点 Test connection 并等它结束；返回读出的表单。 */
export async function testConnection(ctx, timeout = 120000) {
  await clickTest(ctx);
  return waitTestResult(ctx.page, timeout);
}

/**
 * @brief 经进程桥等 ref（<provider>/<model>）的探针状态（page.mjs readProbe：verifying / verified / failed / error）
 *        不再是 verifying（或等到 want），返回最后读到的状态。
 * @param since 点 Test connection（保存）之前的时刻：首次启动的保存会重新探测勾选的模型，重新探测期间 models.get 给的
 *        仍是旧档案，完成时刻早于 since 的档案算还在验证（page.mjs probeState）；0 只用于从未探测过的模型
 * @param want 要等到的状态；null 表示不再是 verifying 就行
 */
export async function waitProbe(page, ref, { since = 0, want = null, timeout = 120000 } = {}) {
  const done = (state) => (want ? state === want : state !== 'verifying');
  return (await poll(async () => (await readProbe(page, ref, since)).state, done, timeout, 300)).value;
}

// ---------- 打开文件夹之后 ----------

/**
 * 在页面里执行：用 MutationObserver 记下当前一栏拒绝启动卡的每一次变化（kind 与主文字；没有卡为 null），
 * “Verifying <模型>…”可能只持续几秒，轮询容易错过。
 */
function watchCardsInPage(selector) {
  window.__mdCards = [];
  window.__mdCardObserver?.disconnect();
  const sample = () => {
    const card = document.querySelector(selector);
    const now = card ? { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? '' }
      : null;
    if (JSON.stringify(window.__mdCards.at(-1) ?? null) !== JSON.stringify(now)) window.__mdCards.push(now);
  };
  window.__mdCardObserver = new MutationObserver(sample);
  window.__mdCardObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true });
}

/** @brief 开始记录拒绝启动卡的变化（watchCardsInPage）。 */
export const watchCards = (page) => page.evaluate(watchCardsInPage, CARD);
/** @brief 记录到的拒绝启动卡（按出现的先后，第一项之前没有卡；null 表示那时没有卡）。 */
export const watchedCards = (page) => page.evaluate(() => (window.__mdCards ?? []).filter(Boolean));

/**
 * @brief 主窗口 Open a folder 提示的 Open folder…（首次启动测试成功之后；选文件夹对话框直接返回 folder），先开始记录
 *        拒绝启动卡的变化（watchCards），等新会话就绪（问信任时选信任），返回模型按钮的 data-pick（新会话的范围）。
 */
export async function openFolderFromPrompt(ctx, folder) {
  const { page } = ctx;
  await stubFolder(ctx.app, folder);
  await watchCards(page);
  await page.locator('[data-testid="open-folder"] button').click();
  await page.locator(PANE).waitFor({ timeout: 30000 });
  const trust = page.getByTestId('trust-dialog');
  if (await trust.waitFor({ timeout: 1500 }).then(() => true, () => false)) {
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  }
  await waitReady(page);
  return page.locator(`${PANE} [data-testid="model-button"]`).getAttribute('data-pick');
}

/** @brief 当前一栏的拒绝启动卡：{ kind, text }；没有卡时为 null。 */
export const blockedCard = (page) => page.evaluate((selector) => {
  const card = document.querySelector(selector);
  return card ? { kind: card.dataset.kind, text: card.textContent } : null;
}, CARD);

/** @brief 发一条消息，等助手回复出现且本轮结束（或出现错误卡）；返回 { count, text, error }。 */
export async function sendText(page, text) {
  const read = () => page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const list = pane?.querySelectorAll('[data-testid="assistant"]') ?? [];
    return { count: list.length, idle: pane?.dataset.running === 'false' && pane?.dataset.sending === 'false',
      text: list[list.length - 1]?.textContent ?? '',
      error: pane?.querySelector('[data-testid="error-card"], [data-testid="unavailable-card"]')?.textContent ?? null };
  }, PANE);
  const before = (await read()).count;
  const box = page.locator(`${PANE} .composer textarea`);
  await box.fill(text);
  await box.press('Enter');
  return (await poll(read, (state) => (state.count > before && state.idle) || state.error, 90000, 250)).value;
}
