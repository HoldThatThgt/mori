// 一键拉取模型 Add provider 表单的 App 套件（tests/ui/md-app-form.mjs）用的准备、操作与读取
// （docs/specs/model-discovery.md §13.1、§13.2 的 MD-06、MD-07、MD-08、MD-09；界面标识见
// docs/v1/screens/models-settings.md "界面测试用的标识"）：
// - 合成端点（tests/fake-endpoint/server.mjs，synthetic）：一个端口一种形状（4800–4819），收集列表、详情与对话请求的
//   JSON 日志行（带收到的时刻 t）；
// - 数据目录（synthetic test setup）：model-config.json 里有一个已有的提供商（地址指向没有服务的端口，新卡应排在它后面），
//   model-profiles.json 用 tb-helpers.mjs 的 tbProfile（跳过它的探针）；pi/settings.json 为空对象；
// - App：启动、关闭，收集主进程与后台进程的输出和页面 console；在预加载脚本的隔离环境里包一层
//   MessagePort.prototype.postMessage（页面里的 window.mori 是只读的），记下发出的命令（keySecret、secret 只记末 4 位）
//   与 models.discover 的结果摘要；
// - 数据目录的写入：model-config.json 的写入次数（原子写的临时文件名）与 credentials.json 的改写（watchConfig）；
// - 表单：打开 Add provider、填 Base URL 与 API key、Fetch models 并等它返回、一次读出表单与清单的全部状态、改清单的行；
//   清单的样子（docs/v1/discovery-checks.md A18：表头、数字框、各框是否可用、滚动框与固定的表头、哪个按钮是主按钮）；
// - F8：在设置页按 F8 保存一份报告，读出 Markdown。
// 只读页面和磁盘、发界面操作，不改 Mori 的源码；key 都是测试自己生成的合成值，与任何真实服务无关。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join, relative } from 'node:path';
import { appRoot, launch, oneLine, sleep } from './lib.mjs';
import { seedTeamUserData, tbModel, tbProvider, tempUserData } from './tb-helpers.mjs';
import { stopEndpoint } from './v1-switch-helpers.mjs';

export { oneLine, sleep };

/** 表单的选择器 */
export const FORM = '[data-testid="provider-form"]';
/** 已有提供商（synthetic test setup）：地址指向这个 lane 范围里没有服务的端口 */
export const SEED_PORT = 4819;
export const SEED_ID = 'seed';

// ---------- 通用 ----------

/** @brief 读 JSON 文件；不存在或读不出时为 null。 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** @brief 读文本文件；不存在时为空串。 */
export const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

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
 * @brief 启动一个合成端点（synthetic），收集它的 JSON 日志行。
 * @param port 端口（4800–4818）
 * @param env 发现用的环境变量（FAKE_LIST_SHAPE、FAKE_MODELS、FAKE_NO_V1_ROOT、FAKE_LIST_DELAY_MS、FAKE_REQUIRE_KEY）
 * @return { child, port, logs（JSON 行，带 t）, stderr }
 */
export function startEndpoint(port, env = {}) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '5', FAKE_FIRST_DELAY_MS: '10', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ep = { child, port, logs: [], stderr: [] };
  collectLines(child.stderr, (line) => ep.stderr.push(line));
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`fake endpoint ${port} did not start within 15 s`)), 15000);
    child.once('exit', (code) => fail(new Error(`fake endpoint ${port} exited (${code}): ${ep.stderr.join(' ')}`)));
    collectLines(child.stdout, (line) => {
      if (line.includes('synthetic endpoint on')) {
        clearTimeout(timer);
        done(ep);
      }
      if (!line.startsWith('{')) return;
      try {
        ep.logs.push({ t: Date.now(), ...JSON.parse(line) });
      } catch {
        // 不是日志行
      }
    });
  });
}

/** @brief 关掉一组合成端点。 */
export async function stopEndpoints(endpoints) {
  for (const ep of Object.values(endpoints)) await stopEndpoint(ep.child).catch(() => {});
}

/** @brief 列表请求（路径以 /models 结尾，LM Studio 的 /api/v1/models 除外）的日志行。 */
export const listLines = (ep, since = 0) => ep.logs.filter((line) => line.t >= since && typeof line.path === 'string'
  && line.path.endsWith('/models') && line.path !== '/api/v1/models');

/** @brief 对话请求（没有 path 字段）的日志行。 */
export const chatLines = (ep, since = 0) => ep.logs.filter((line) => line.t >= since && line.path === undefined);

/** @brief 端点的地址（/v1）。 */
export const urlOf = (port, path = '/v1') => `http://127.0.0.1:${port}${path}`;

// ---------- 数据目录 ----------

/**
 * @brief 新的数据目录（synthetic test setup）：一个已有的提供商 seed（一个模型，地址是没有服务的端口，档案已验证，
 *        启动时不探测），pi/settings.json 为空对象。
 */
export function seedUserData() {
  const userData = tempUserData('mori-md-form-');
  const provider = { ...tbProvider(SEED_ID, SEED_PORT, [tbModel('seed-model')]), name: 'Seed' };
  seedTeamUserData(userData, { providers: [provider] });
  return userData;
}

export const configOf = (userData) => readJson(join(userData, 'model-config.json'));
export const credentialRefs = (userData) => Object.keys(readJson(join(userData, 'credentials.json')) ?? {});

// ---------- App ----------

/**
 * @brief 命令记录（在预加载脚本的隔离环境 "Electron Isolated Context" 里运行；页面里的 window.mori 是只读的，包不上）：
 *        包一层 MessagePort.prototype.postMessage，记下每条发往后台进程的命令（keySecret、secret 只记末 4 位，
 *        明文不留在记录里）；在这个 port 上另听回复，models.discover 的回复记下结果摘要。
 */
function spyInIsolatedWorld() {
  if (globalThis.__mdSpy) return true;
  const tail = (key) => (key ? `…${String(key).slice(-4)}` : key);
  const entries = new Map();
  globalThis.__mdSpy = { sent: [] };
  const summary = (r) => ({ cancelled: r.cancelled, error: r.error, listError: r.listError, baseUrl: r.baseUrl,
    api: r.api, name: r.name, server: r.server, models: (r.models ?? []).map((m) => m.id) });
  const onReply = (message) => {
    const data = message.data;
    const entry = data && data.kind !== 'event' ? entries.get(data.id) : undefined;
    if (!entry) return;
    entries.delete(data.id);
    entry.done = true;
    entry.doneAt = Date.now();
    const plain = (result) => ({ error: result?.error ?? null });
    const read = entry.command.type === 'models.discover' ? summary : plain;
    entry.result = data.ok ? read(data.result) : { thrown: data.error };
  };
  const original = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function postMessage(data, ...rest) {
    if (data && data.kind === 'request') {
      const copy = JSON.parse(JSON.stringify(data.command));
      if (copy.keySecret) copy.keySecret = tail(copy.keySecret);
      if (copy.secret) copy.secret = tail(copy.secret);
      if (copy.target?.keySecret) copy.target.keySecret = tail(copy.target.keySecret);
      const entry = { t: Date.now(), command: copy, done: false, result: null };
      globalThis.__mdSpy.sent.push(entry);
      entries.set(data.id, entry);
      if (!this.__mdHooked) {
        this.__mdHooked = true;
        this.addEventListener('message', onReply);
      }
    }
    return original.call(this, data, ...rest);
  };
  return true;
}

/** @brief 装上命令记录（CDP 在隔离环境里执行 spyInIsolatedWorld）；装不上时 ctx.spy 为 false。 */
async function installSpy(ctx) {
  const cdp = await ctx.page.context().newCDPSession(ctx.page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
  await cdp.send('Runtime.enable');
  const world = contexts.find((item) => item.name === 'Electron Isolated Context');
  if (!world) return false;
  const done = await cdp.send('Runtime.evaluate', { contextId: world.id, returnByValue: true,
    expression: `(${spyInIsolatedWorld.toString()})()` });
  ctx.cdp = cdp;
  ctx.world = world.id;
  return done.result?.value === true;
}

/**
 * @brief 启动 Mori（--exe 时打包版）：收集主进程与后台进程的输出、页面 console 与报错，等到三栏布局，装上命令记录。
 * @param ctx { userData, exePath, logs（全部输出，所有启动共用）, pageErrors }
 */
export async function startApp(ctx) {
  ctx.app = await launch({ exePath: ctx.exePath ?? null, userData: ctx.userData });
  const child = ctx.app.process();
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) collectLines(stream, (line) => ctx.logs.push({ t: Date.now(), line }));
  }
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.page.on('console', (message) => ctx.logs.push({ t: Date.now(), line: `[console] ${message.text()}` }));
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await ctx.page.waitForSelector('[data-testid="sidebar"]', { timeout: 60000 });
  ctx.spy = await installSpy(ctx);
  return ctx.page;
}

/** @brief 关掉 Mori（有序关闭后台进程）；最多等 20 秒。 */
export async function closeApp(ctx) {
  if (!ctx.app) return;
  const app = ctx.app;
  ctx.app = null;
  ctx.page = null;
  await Promise.race([app.close().catch(() => {}), sleep(20000)]);
}

/** @brief 后台进程与主进程输出里匹配 pattern 的行（since 之后）。 */
export const logLines = (ctx, pattern, since = 0) => ctx.logs.filter((item) => item.t >= since
  && pattern.test(item.line)).map((item) => item.line);

/**
 * @brief 命令记录（since 之后，type 为空时全部）：[{ t, command（key 只有末 4 位）, done, result }]；
 *        没装上命令记录时为空数组。
 */
export async function commandsOf(ctx, type = null, since = 0) {
  if (!ctx.spy) return [];
  const read = await ctx.cdp.send('Runtime.evaluate', { contextId: ctx.world, returnByValue: true,
    expression: 'JSON.stringify(globalThis.__mdSpy.sent)' });
  return JSON.parse(read.result.value).filter((entry) => entry.t >= since && (!type || entry.command.type === type));
}

// ---------- 设置页与表单 ----------

/** @brief 打开设置页的 Models 分节，等它读完。 */
export async function openModels(page) {
  if (!(await page.getByTestId('settings-page').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  await page.getByTestId('models-section').waitFor({ timeout: 20000 });
}

/** @brief 关掉开着的 Add provider 表单（底部或开始时的 Cancel），再点 Add provider，等新表单出现。 */
export async function openAddProvider(page) {
  await openModels(page);
  await closeForm(page);
  await page.locator('[data-action="add-provider"]').click();
  await page.locator(FORM).waitFor({ timeout: 10000 });
  return page.locator(FORM);
}

/** @brief 表单开着时点它关闭用的 Cancel（data-action="close-form"），等表单消失。 */
export async function closeForm(page) {
  const form = page.locator(FORM);
  if (await form.count() === 0) return;
  await form.locator('[data-action="close-form"]').click();
  await form.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 表单里按标签找的输入框（Base URL、API key、Name、API type、Concurrency per key）。 */
export const field = (page, label) => page.locator(FORM).getByLabel(label, { exact: true });

/** @brief 填 Base URL 与 API key（key 为 undefined 时不碰）。 */
export async function fillAddress(page, baseUrl, key) {
  await field(page, 'Base URL').fill(baseUrl);
  if (key !== undefined) await field(page, 'API key').fill(key);
}

/**
 * @brief 点表单的 Fetch models，等这次 models.discover 返回、表单不在拉取中；返回表单状态与这次命令的记录
 *        （没装上命令记录时 entry 为 null，只等表单离开拉取中）。
 * @param timeout 等结果的最长时间
 */
export async function fetchNow(ctx, timeout = 30000) {
  const { page } = ctx;
  const since = Date.now();
  await page.locator(`${FORM} [data-action="fetch-models"]`).click();
  const sent = await poll(() => commandsOf(ctx, 'models.discover', since), (list) => !ctx.spy || list.at(-1)?.done,
    timeout, 100);
  if (!sent.ok) throw new Error(`models.discover did not return within ${timeout} ms`);
  await page.waitForFunction(() => !document.querySelector(
    '[data-testid="provider-form"] [data-testid="fetch-status"][data-state="fetching"]'), null, { timeout });
  return { state: await formState(page), entry: sent.value.at(-1) ?? null };
}

/** @brief 填地址与 key，Fetch models，返回 fetchNow 的结果。 */
export async function fetchWith(ctx, baseUrl, key, timeout) {
  await fillAddress(ctx.page, baseUrl, key);
  return fetchNow(ctx, timeout);
}

/**
 * @brief 页面里的小工具（readFormInPage 与 readListInPage 用）：元素的文字；按标签找的输入框（值、只读、不可用、
 *        类型、占位）；按 data-action 找的按钮（文字、不可用）；两个元素在文档里的先后（before）、画面上一个在另一个
 *        下方（below：b 的上沿不高于 a 的下沿）。
 */
function formTools(form) {
  const text = (el) => el?.textContent?.trim() ?? null;
  const byLabel = (name) => {
    const label = [...form.querySelectorAll('label')].find((item) => item.textContent.trim() === name);
    return label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  };
  const input = (name) => {
    const el = byLabel(name);
    return el ? { value: el.value, readOnly: el.readOnly, disabled: el.disabled, type: el.type,
      placeholder: el.placeholder } : null;
  };
  const button = (action) => {
    const el = form.querySelector(`[data-action="${action}"]`);
    return el ? { text: text(el), disabled: el.disabled } : null;
  };
  const before = (a, b) => Boolean(a && b) && Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const below = (a, b) => Boolean(a && b) && b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom;
  return { text, byLabel, input, button, before, below };
}

/**
 * @brief 页面里读清单的一行（readListInPage 用）：id、类型、Added、不能加入、勾选与勾选框是否不可用、读屏名、
 *        两个数字框的值、两个勾选框、默认值的标记"Default"（2026-10-26 起取代 Not reported，"<字段>:<文字>"）与它们的
 *        悬停说明、字段错误、标记与提示。
 * @param text formTools 的 text
 */
function readRowInPage(tr, text) {
  const pick = tr.querySelector('input[name="pick"]');
  const num = (name) => tr.querySelector(`input[data-field="${name}"]`);
  const tags = (testId) => [...tr.querySelectorAll(`[data-testid="${testId}"]`)]
    .map((el) => ({ kind: el.dataset.kind, text: text(el) }));
  return { id: tr.dataset.model, chat: tr.dataset.chat, added: tr.dataset.added === 'true',
    unusable: tr.dataset.unusable === 'true', picked: pick.checked, pickDisabled: pick.disabled,
    pickLabel: pick.getAttribute('aria-label'), window: num('contextWindow').value, max: num('maxTokens').value,
    windowLabel: num('contextWindow').getAttribute('aria-label'),
    maxLabel: num('maxTokens').getAttribute('aria-label'),
    reasoning: num('reasoning').checked, image: num('image').checked,
    defaults: [...tr.querySelectorAll('[data-testid="default-value"]')]
      .map((el) => `${el.dataset.field}:${text(el)}`),
    // 取自 pi 的标记“From pi”的 data-field（2026-10-26 补，WP-15）
    pis: [...tr.querySelectorAll('[data-testid="pi-value"]')].map((el) => el.dataset.field),
    defaultTitles: [...tr.querySelectorAll('[data-testid="default-value"]')].map((el) => el.title),
    errors: Object.fromEntries([...tr.querySelectorAll('[data-testid="field-error"]')]
      .map((el) => [el.dataset.field, text(el)])),
    tags: tags('row-tag'), hints: tags('row-hint') };
}

/**
 * @brief 页面里读清单一块（readFormInPage 用）：清单（标题、按钮、过滤框、截断说明、空列表的一句、每一行）、列表错误、
 *        Add a model ID，以及列表错误、空列表的一句、第一个手填的行、Add a model ID 在文档里的先后（order）。
 * @param tools formTools 的结果
 * @param readRow readRowInPage
 */
function readListInPage(form, tools, readRow) {
  const { text, button, before } = tools;
  const checklist = form.querySelector('[data-testid="checklist"]');
  const listError = form.querySelector('[data-testid="list-error"]');
  const manual = form.querySelector('[data-testid="manual-model"]');
  const filter = form.querySelector('[data-testid="checklist-filter"]');
  const allRows = [...form.querySelectorAll('[data-testid="discovered-row"]')];
  const empty = [...form.querySelectorAll('p')]
    .find((p) => p.textContent.trim() === 'The server didn’t list any models.');
  const firstEntered = allRows.find((tr) => tr.querySelector('[data-testid="row-tag"][data-kind="entered"]'));
  const addToList = manual?.querySelector('[data-action="add-to-list"]');
  return {
    checklist: Boolean(checklist), heading: text(checklist?.querySelector('h4')),
    selectAll: button('select-all'), clearSelection: button('clear-selection'),
    filter: filter ? { value: filter.value, placeholder: filter.placeholder } : null,
    truncated: Boolean(form.querySelector('[data-testid="checklist-truncated"]')), empty: text(empty),
    rows: allRows.map((tr) => readRow(tr, text)),
    listError: listError ? { kind: listError.dataset.kind, text: [...listError.querySelectorAll('p')]
      .map((p) => text(p)) } : null,
    manual: manual ? { value: manual.querySelector('input[data-field="id"]').value,
      error: text(manual.querySelector('[data-testid="field-error"][data-field="id"]')),
      add: { text: text(addToList), disabled: addToList.disabled } } : null,
    order: { errorThenRow: before(listError, firstEntered), rowThenManual: before(firstEntered, manual),
      emptyThenRow: before(empty, firstEntered) },
  };
}

/**
 * @brief 页面里读 Add provider 表单的全部状态（没有表单时为 null）：各字段的有无、值、只读；拉取的按钮与状态；
 *        Detected、Base URL 的说明；清单一块（readListInPage）；More settings；底部；结果文字；以及几个元素的先后
 *        （order；messageBelowFetch：结果文字在 Fetch models 下方）。
 * @param parts { tools: formTools, row: readRowInPage, list: readListInPage }（formState 把它们一起送进页面）
 */
function readFormInPage(parts) {
  const form = document.querySelector('[data-testid="provider-form"]');
  if (!form) return null;
  const tools = parts.tools(form);
  const { text, byLabel, input, button, before, below } = tools;
  const list = parts.list(form, tools, parts.row);
  const fetchButton = form.querySelector('[data-action="fetch-models"]');
  const message = form.querySelector('[data-testid="form-message"]');
  const more = form.querySelector('[data-testid="more-settings"]');
  const status = form.querySelector('[data-testid="fetch-status"]');
  const detected = form.querySelector('[data-testid="detected-server"]');
  return {
    title: text(form.querySelector('h3')),
    labels: [...form.querySelectorAll('label, legend')].map((el) => text(el)).filter(Boolean),
    baseUrl: input('Base URL'), apiKey: input('API key'), name: input('Name'), api: input('API type'),
    fetch: button('fetch-models'), fetchCancel: button('fetch-cancel'),
    status: status ? { state: status.dataset.state, text: text(status), role: status.getAttribute('role') } : null,
    detected: detected ? { kind: detected.dataset.kind, text: text(detected) } : null,
    note: text(form.querySelector('[data-testid="base-url-note"]')),
    ...list,
    more: more ? { open: more.open, concurrency: input('Concurrency per key'),
      compat: [...more.querySelectorAll('.compat-checks input[type="checkbox"]')].map((box) => box.checked),
      compatHint: text(more.querySelector('[data-testid="compat-hint"]')) } : null,
    cost: text(form.querySelector('[data-testid="probe-cost-note"]')),
    add: button('add-models'), close: button('close-form'),
    // 2026-10-26 起没有网络区域（负责人走查 M3）：区域单选的个数、表单里有没有“Network zone”这几个字（都该没有）
    zone: { radios: form.querySelectorAll('input[name="zone"]').length,
      words: form.textContent.includes('Network zone') },
    message: text(message),
    fieldErrors: Object.fromEntries([...form.querySelectorAll('[data-testid="field-error"]')]
      .filter((el) => !el.closest('[data-testid="discovered-row"]')).map((el) => [el.dataset.field, text(el)])),
    order: { ...list.order, fetchAfterKey: before(byLabel('API key'), fetchButton),
      messageBelowFetch: below(fetchButton, message) },
  };
}

/** @brief Add provider 表单的状态：readFormInPage 与它用的三个页面函数一起送进页面，一次读完。 */
export const formState = (page) => page.evaluate(
  `(${readFormInPage})({ tools: ${formTools}, row: ${readRowInPage}, list: ${readListInPage} })`);

/** @brief 清单里的一行（data-model）。 */
export const rowOf = (page, id) => page.locator(`${FORM} [data-testid="discovered-row"][data-model="${id}"]`);

/**
 * @brief 页面里读清单与按钮的样子（docs/v1/discovery-checks.md A18）：表单里 Fetch models 的 class 与带 primary 的按钮
 *        （data-action）；清单表的表头文字；每行的格数与五个框（勾选框、两个数字框、两个勾选框）的类型、inputMode、
 *        是否不可用。没有表单时为 null；没有清单行时 headers 为 null、rows 为空。
 */
function readLookInPage() {
  const form = document.querySelector('[data-testid="provider-form"]');
  if (!form) return null;
  const buttons = { fetch: form.querySelector('[data-action="fetch-models"]')?.className ?? null,
    primary: [...form.querySelectorAll('button.primary')].map((el) => el.dataset.action ?? el.textContent.trim()) };
  const table = form.querySelector('[data-testid="discovered-row"]')?.closest('table');
  if (!table) return { buttons, headers: null, rows: [] };
  const box = (el) => ({ type: el?.type ?? null, mode: el?.inputMode ?? null, disabled: el?.disabled ?? null });
  const selector = (name) => (name === 'pick' ? 'input[name="pick"]' : `input[data-field="${name}"]`);
  const names = ['pick', 'contextWindow', 'maxTokens', 'reasoning', 'image'];
  const rows = [...table.querySelectorAll('[data-testid="discovered-row"]')].map((tr) => ({ id: tr.dataset.model,
    cells: tr.cells.length,
    boxes: Object.fromEntries(names.map((name) => [name, box(tr.querySelector(selector(name)))])) }));
  return { buttons, headers: [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()), rows };
}

/** @brief 清单与按钮的样子（readLookInPage）。 */
export const checklistLook = (page) => page.evaluate(readLookInPage);

/**
 * @brief 页面里量清单的滚动框（A18）：从清单表往上找第一个 overflow-y 为 auto / scroll 的祖先（到表单为止），读它的
 *        max-height、overflow-y、clientHeight、scrollHeight；第一个表头格的 position 与 top；把滚动框滚到底、等两帧后
 *        量表头上沿与滚动框内沿的距离（offset，表头固定时约为 0），再滚回顶部。没有清单表时为 null，没有滚动框时 box 为 null。
 */
async function readScrollInPage() {
  const form = document.querySelector('[data-testid="provider-form"]');
  const table = form?.querySelector('[data-testid="discovered-row"]')?.closest('table');
  const th = table?.querySelector('thead th');
  if (!th) return null;
  const header = { position: getComputedStyle(th).position, top: getComputedStyle(th).top };
  let el = table.parentElement;
  while (el && el !== form && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
  if (!el || el === form) return { header, box: null };
  const frames = () => new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(done));
    setTimeout(done, 500);
  });
  const style = getComputedStyle(el);
  const box = { maxHeight: style.maxHeight, overflowY: style.overflowY, clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight };
  el.scrollTop = el.scrollHeight;
  await frames();
  const scrolled = el.scrollTop;
  const offset = th.getBoundingClientRect().top - (el.getBoundingClientRect().top + el.clientTop);
  el.scrollTop = 0;
  await frames();
  return { header, box: { ...box, scrolled, offset } };
}

/** @brief 清单的滚动框与表头（readScrollInPage）。 */
export const checklistScroll = (page) => page.evaluate(readScrollInPage);

/** @brief 改一行的 Context window 或 Max output（field 为 contextWindow / maxTokens）。 */
export async function setSize(page, id, name, value) {
  await rowOf(page, id).locator(`input[data-field="${name}"]`).fill(String(value));
}

/** @brief 勾选或取消勾选一行。 */
export async function setPicked(page, id, on) {
  await rowOf(page, id).locator('input[name="pick"]').setChecked(on);
}

/** @brief Add a model ID：填 id（不点 Add to list）。 */
export async function typeManual(page, id) {
  await page.locator(`${FORM} [data-testid="manual-model"] input[data-field="id"]`).fill(id);
}

/** @brief Add a model ID：填 id，点 Add to list。 */
export async function addManual(page, id) {
  await typeManual(page, id);
  await page.locator(`${FORM} [data-action="add-to-list"]`).click();
}

/** @brief 展开 More settings（已展开时不动）。 */
export async function openMore(page) {
  const more = page.locator(`${FORM} [data-testid="more-settings"]`);
  if (!(await more.evaluate((el) => el.open))) await more.locator('summary').click();
}

// ---------- 加入 ----------

/**
 * @brief 页面里装一个 MutationObserver（同步记下一闪而过的状态）：Add 按钮第一次变成"Adding…"时 Base URL、API key 是否只读、
 *        Fetch models 与 Add 是否不可用；以及出现过"Verifying…"（tool_calling 为 verifying）的模型行（data-model）。
 */
export async function watchAdding(page) {
  await page.evaluate(() => {
    window.__mdAddObserver?.disconnect();
    const record = { adding: null, verifying: [] };
    window.__mdAdd = record;
    const readOnly = (form, name) => {
      const label = [...form.querySelectorAll('label')].find((item) => item.textContent.trim() === name);
      return document.getElementById(label?.htmlFor ?? '')?.readOnly ?? null;
    };
    const check = () => {
      const form = document.querySelector('[data-testid="provider-form"]');
      const button = form?.querySelector('[data-action="add-models"]');
      if (!record.adding && button?.textContent.trim() === 'Adding…') {
        record.adding = { baseUrlReadOnly: readOnly(form, 'Base URL'), apiKeyReadOnly: readOnly(form, 'API key'),
          fetchDisabled: form.querySelector('[data-action="fetch-models"]')?.disabled ?? null,
          addDisabled: button.disabled };
      }
      for (const el of document.querySelectorAll('[data-testid="model-row"][data-probe="verifying"]')) {
        const ref = el.dataset.model;
        if (ref && !record.verifying.includes(ref)) record.verifying.push(ref);
      }
    };
    window.__mdAddObserver = new MutationObserver(check);
    window.__mdAddObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  });
}

/** @brief watchAdding 记下的状态，并停掉 MutationObserver。 */
export const addingSeen = (page) => page.evaluate(() => {
  window.__mdAddObserver?.disconnect();
  return window.__mdAdd;
});

/** model-config.json 原子写的临时文件名（kernel/modelConfig.ts writeJsonAtomic：<路径>.<randomUUID>.tmp） */
const CONFIG_TEMP = /^model-config\.json\.[0-9a-f-]+\.tmp$/;

/**
 * @brief 盯着数据目录：model-config.json 每次变化时读出 providerId 这个提供商的模型 id（JSON 串）；写文件是原子改名，
 *        读到的总是一份完整的文件。事件名在事件发生时就记下（不靠之后再读文件）：configWrites 为出现过的
 *        model-config.json 临时文件名（每次写入一个不同的 UUID，个数就是写入次数）；credentialEvents 为
 *        credentials.json 的事件数（主进程 main/credentials.ts 存 key、删 key 都改写这个文件，没有这个 ref 时删 key 不写）。
 *        返回 { snapshots, configWrites, credentialEvents（读时取最新值）, close }。
 */
export function watchConfig(userData, providerId) {
  const snapshots = [];
  const configWrites = new Set();
  let credentialEvents = 0;
  const watcher = watch(userData, (_event, name) => {
    if (typeof name === 'string' && CONFIG_TEMP.test(name)) configWrites.add(name);
    if (name === 'credentials.json') credentialEvents += 1;
    if (name !== 'model-config.json') return;
    const provider = configOf(userData)?.providers?.find((item) => item.id === providerId);
    if (provider) snapshots.push(JSON.stringify(provider.models.map((model) => model.id)));
  });
  return { snapshots, configWrites, get credentialEvents() { return credentialEvents; }, close: () => watcher.close() };
}

/** @brief 目录里（递归）含有任一 key 的文件：[`<相对路径>: <key 末 4 位>`]。 */
export function filesWithSecrets(dir, secrets) {
  const hits = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (statSync(path).size < 64 * 1024 * 1024) {
        const text = readFileSync(path, 'latin1');
        const found = secrets.filter((secret) => text.includes(secret));
        hits.push(...found.map((secret) => `${relative(dir, path)}: ${secret.slice(-4)}`));
      }
    }
  };
  walk(dir);
  return hits;
}

// ---------- F8 ----------

/**
 * @brief 在当前页面按 F8，填两段文字并保存报告；返回 Markdown 的路径与全文（没保存成时路径为 null、全文为空串）。
 *        保存后关上报告框（Close）。
 */
export async function saveIssueReport(page, what, expect) {
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByTestId('issue-expect').fill(expect);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const path = /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  const md = path ? readText(path) : '';
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  return { path, md };
}

/** @brief 文字里出现的 key（全文匹配）。 */
export const secretsIn = (text, secrets) => secrets.filter((secret) => String(text).includes(secret));
