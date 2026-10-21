// v1 模型层整机测试（换 key、换模型、重做、排队与停止、结果未知、候选耗尽、认证与额度、槽位、认证头、回复中改配置）：
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对多个合成端点（tests/fake-endpoint，synthetic），逐条验收
// docs/specs/model-providers.md §14.2 的 MP-03、MP-04、MP-13、MP-14、MP-15、MP-16、MP-17、MP-18、MP-19、MP-20、MP-25、
// MP-29、MP-31、MP-32、MP-36 在 App 层的通过条件。每条检查的名字以 MP 编号开头。界面标识见 docs/v1/screens/model-chat.md。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-app-switch.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/v1-models-app-switch(-packaged).json，截图在 test-results/v1-models-app-switch(-packaged)/。
// 测试准备（synthetic test setup，代码里逐处注明）：
//   - 启动前写 model-config.json（几十个提供商与分组，key 不写）与 model-profiles.json（已验证的档案，cancel_verified
//     按需要给 true / false / unknown），以及 pi 的 settings.json（压缩只保留最近 1 个 token，短对话也能压缩）；
//   - 启动后经 models.addKey 加 key（密文由 Mori 自己加密保存）；
//   - 部分提供商经本脚本的记录代理（v1-switch-helpers.mjs startProxy）连到合成端点：看请求体（重做时发给新模型的上下文、
//     说明文字、压缩请求）和认证头，并在指定的那一次请求上断开连接（真实的连接失败）；
//   - MP-29 额度用完后重新启动那个合成端点、不再带 FAKE_QUOTA_KEYS（额度已充值）。
// 时长都是 §12 的真实值：结果未知（120 s 首个内容时限 + 2 min held）、排队超时 60 s、候选耗尽最长等 60 s 各跑一次，
// 放在 longBatch 一步里同时进行；429 的恢复用 FAKE_LIMIT_MS 给的短 Retry-After。
// 步骤之间互不依赖（各用自己的提供商和会话），只有 reopen15 依赖 redo15（--only reopen15 时一起跑）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import { chooseMenuItem, stubFolder } from './m3-helpers.mjs';
import { slotSelector, waitSplit } from './m5-helpers.mjs';
import {
  captureEvents, eventsOf, modelOf, paneCounts, paneSel, paneState, poll, providerOf, seedUserData, stagesOf,
  startEndpoint, startProxy, stopEndpoint, waitStageKind, waitTabBusy, waitTabIdle, watchStages,
} from './v1-switch-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const only = arg('only')?.split(',');
const shots = join(appRoot, `test-results/v1-models-app-switch${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 本脚本用的端口（4520–4539）：合成端点、记录代理，4539 不监听（连接失败） */
const PORT = { ok: 4520, keys2: 4521, lim1: 4522, limAll: 4523, short: 4524, long: 4525, slow: 4526, hangT: 4527,
  hangF: 4528, stallF: 4529, noMetrics: 4530, quota: 4531, auth: 4532, keyless: 4533, proxyA: 4534, proxyB: 4535,
  proxyH: 4536, closed: 4539 };

// 合成端点认的 key：只是测试值（synthetic），与任何真实服务无关；末 4 位各不相同，合成端点的日志据此认出用的是哪个。
const K = { m03a: 'sk-synthetic-mp03-a001', m03b: 'sk-synthetic-mp03-b002', l25a: 'sk-synthetic-mp25-c003',
  l25b: 'sk-synthetic-mp25-d004', m04a: 'sk-synthetic-mp04-e005', m04b: 'sk-synthetic-mp04-f006',
  bad14: 'sk-synthetic-mp14-wrong-g007', good14: 'sk-synthetic-mp14-good-h008', bad29: 'sk-synthetic-mp29-wrong-i009',
  good29: 'sk-synthetic-mp29-good-j010', q1: 'sk-synthetic-mp29-quota-k011', q2: 'sk-synthetic-mp29-quota-l012',
  s13a: 'sk-synthetic-mp13-m013', s13b: 'sk-synthetic-mp13-n014', s13c: 'sk-synthetic-mp13-o015',
  s13d: 'sk-synthetic-mp13-p016', s13e: 'sk-synthetic-mp13-q017', s20: 'sk-synthetic-mp20-r018',
  l20x: 'sk-synthetic-mp20-s019', l20c: 'sk-synthetic-mp20-t020', l17a: 'sk-synthetic-mp17-u021',
  l17b: 'sk-synthetic-mp17-v022', b32: 'sk-synthetic-mp32-bearer-w023', bad20: 'sk-synthetic-mp20-wrong-x024' };
const tail = (key) => key.slice(-4);

/** 每个合成端点的环境变量（规格 §14.1 的行为） */
const ENDPOINTS = [
  [PORT.ok, {}],
  [PORT.keys2, { FAKE_KEYS: `${K.m03a},${K.m03b}` }],
  [PORT.lim1, { FAKE_KEYS: `${K.l25a},${K.l25b}`, FAKE_LIMITED_KEYS: K.l25a }],
  [PORT.limAll, { FAKE_KEYS: `${K.m04a},${K.m04b}`, FAKE_LIMITED_KEYS: `${K.m04a},${K.m04b}` }],
  [PORT.short, { FAKE_LIMITED_KEYS: [K.s13a, K.s13b, K.s13c, K.s13d, K.s13e, K.s20].join(','),
    FAKE_LIMIT_MS: '6000' }],
  [PORT.long, { FAKE_LIMITED_KEYS: [K.l20x, K.l20c, K.l17a, K.l17b].join(','), FAKE_LIMIT_MS: '100000' }],
  [PORT.slow, { FAKE_FIRST_DELAY_MS: '7000' }],
  [PORT.hangT, {}], [PORT.hangF, {}], [PORT.stallF, {}],
  [PORT.noMetrics, { FAKE_NO_METRICS: '1' }],
  [PORT.quota, { FAKE_QUOTA_KEYS: K.q1 }],
  [PORT.auth, { FAKE_KEYS: `${K.good14},${K.good29}` }],
  [PORT.keyless, { FAKE_LIMITED_KEYS: 'none', FAKE_LIMIT_MS: '15000' }],
];

/** 提供商：[id, 端口, { keys, concurrency, model, cancel, window, maxTokens, reasoning }]；模型 id 默认 fake-coder-<id> */
const PROVIDERS = [
  ['okd', PORT.ok],
  ['m03', PORT.keys2, { keys: [K.m03a, K.m03b], concurrency: 1 }], ['m03b', PORT.lim1, { keys: [K.l25a, K.l25b] }],
  ['m04', PORT.limAll, { keys: [K.m04a, K.m04b] }], ['m04bk', PORT.ok],
  ['m14', PORT.auth, { keys: [K.bad14] }], ['m14bk', PORT.ok],
  ['m16', PORT.ok], ['m16bk', PORT.ok], ['m17', PORT.ok], ['m17bk', PORT.ok], ['q17', PORT.ok, { concurrency: 1 }],
  ['w17a', PORT.long, { keys: [K.l17a] }], ['w17b', PORT.long, { keys: [K.l17b] }],
  ['h17', PORT.noMetrics, { model: 'fake-coder-stall-h17', cancel: 'unknown' }], ['h17bk', PORT.ok],
  ['t18h', PORT.hangT, { model: 'fake-coder-hang-t18h', cancel: true }], ['t18hbk', PORT.ok],
  ['t18s', PORT.hangT, { model: 'fake-coder-stall-t18s', cancel: true }], ['t18sbk', PORT.ok],
  ['f18h', PORT.hangF, { model: 'fake-coder-hang-nocancel-f18h', cancel: false }], ['f18hbk', PORT.ok],
  ['f18s', PORT.stallF, { model: 'fake-coder-stall-nocancel-f18s', cancel: false }], ['f18sbk', PORT.ok],
  ['u18h', PORT.noMetrics, { model: 'fake-coder-hang-u18h', cancel: 'unknown' }], ['u18hbk', PORT.ok],
  ['u18s', PORT.noMetrics, { model: 'fake-coder-stall-u18s', cancel: 'unknown' }], ['u18sbk', PORT.ok],
  ['s18', PORT.noMetrics, { model: 'fake-coder-stall-s18', cancel: 'unknown' }],
  ['q19', PORT.ok, { concurrency: 1 }], ['q19p', PORT.ok, { concurrency: 1 }],
  ['qt19', PORT.ok, { concurrency: 1 }], ['qt19bk', PORT.ok], ['c19', PORT.ok, { concurrency: 2 }],
  ['d19', PORT.keys2, { keys: [K.m03a, K.m03b], concurrency: 1 }],
  ['a19', PORT.keys2, { keys: [K.m03a], concurrency: 1 }],
  ['r19', PORT.slow], ['r19bk', PORT.ok],
  ['p20', PORT.short, { keys: [K.s20] }], ['p20x', PORT.long, { keys: [K.l20x] }],
  ['n20', PORT.auth, { keys: [K.bad20] }],
  ['x20', PORT.slow, { window: 20000, maxTokens: 1000 }], ['y20', PORT.long, { keys: [K.l20c] }],
  ['m25x', PORT.lim1, { keys: [K.l25a] }], ['m25y', PORT.lim1, { keys: [K.l25a], reasoning: true }],
  ['au29', PORT.auth, { keys: [K.bad29, K.good29] }], ['qu29', PORT.quota, { keys: [K.q1, K.q2] }],
  ['nf29', PORT.ok, { model: 'fake-coder-404-nf29' }], ['nf29bk', PORT.ok],
  ['cn29', PORT.closed], ['cn29bk', PORT.ok], ['kl29', PORT.keyless], ['kl29bk', PORT.ok],
  ['s31', PORT.ok, { concurrency: 1 }],
  ['b32', PORT.proxyH, { keys: [K.b32] }], ['kl32', PORT.proxyH],
  ['d36', PORT.slow], ['d36bk', PORT.ok], ['cc36', PORT.slow], ['cc36bk', PORT.ok],
  ['a13a', PORT.short, { keys: [K.s13a] }], ['b13a', PORT.slow],
  ['a13b', PORT.short, { keys: [K.s13b] }], ['b13b', PORT.slow], ['c13b', PORT.ok],
  ['a13c', PORT.short, { keys: [K.s13c] }], ['b13c', PORT.slow],
  ['a13d', PORT.short, { keys: [K.s13d] }], ['b13d', PORT.slow],
  ['a13e', PORT.short, { keys: [K.s13e] }], ['b13e', PORT.slow],
  ['a15', PORT.proxyA], ['b15', PORT.proxyB], ['a15c', PORT.proxyA], ['b15c', PORT.proxyA], ['c15c', PORT.proxyB],
  ['a15d', PORT.proxyA], ['b15d', PORT.proxyB], ['a15e', PORT.proxyA], ['b15e', PORT.proxyB],
  ['a15f', PORT.proxyA], ['b15f', PORT.proxyB, { window: 20000, maxTokens: 1000 }],
];
const OPTS = Object.fromEntries(PROVIDERS.map(([id, port, opts = {}]) => [id, { port, ...opts }]));

/** 分组：id → 成员 */
const GROUPS = {
  g04: ['m04', 'm04bk'], g14: ['m14', 'm14bk'], g16: ['m16', 'm16bk'], g17: ['m17', 'm17bk'], g17w: ['w17a', 'w17b'],
  gh17: ['h17', 'h17bk'], gt18h: ['t18h', 't18hbk'], gt18s: ['t18s', 't18sbk'], gf18h: ['f18h', 'f18hbk'],
  gf18s: ['f18s', 'f18sbk'], gu18h: ['u18h', 'u18hbk'], gu18s: ['u18s', 'u18sbk'], gqt19: ['qt19', 'qt19bk'],
  g19r: ['r19', 'r19bk'], g20c: ['x20', 'y20'], g29n: ['nf29', 'nf29bk'], g29c: ['cn29', 'cn29bk'],
  g29k: ['kl29', 'kl29bk'], g36d: ['d36', 'd36bk'], g36c: ['cc36', 'cc36bk'], g13a: ['a13a', 'b13a'],
  g13b: ['a13b', 'b13b', 'c13b'], g13c: ['a13c', 'b13c'], g13d: ['a13d', 'b13d'], g13e: ['a13e', 'b13e'],
  g15: ['a15', 'b15'], g15c: ['a15c', 'b15c', 'c15c'], g15d: ['a15d', 'b15d'], g15e: ['a15e', 'b15e'],
  g15f: ['a15f', 'b15f'],
};

/** @brief 提供商的模型 id。 */
const M = (id) => OPTS[id].model ?? `fake-coder-${id}`;
/** @brief 提供商唯一模型的全名 <provider>/<model>。 */
const R = (id) => `${id}/${M(id)}`;
/** 合成端点 "plain" 的回复 */
const PLAIN = '这是一段只有文字的回复，用来测试流式输出。';
/** §6.1 重做说明的开头 */
const NOTE_HEAD = '[Mori] The previous model';
/** @brief §6.1 重做说明的全文。 */
const noteOf = (from, reason) => `${NOTE_HEAD} (${from}) stopped partway through this reply (${reason}). Its partial `
  + 'work is hidden from you. Files in the workspace may already have been changed; check before you redo anything.';
/** pi 压缩请求的系统提示开头（同 tests/fake-endpoint/replies.mjs） */
const SUMMARY_SYSTEM = 'You are a context summarization assistant.';
/** 阶段行里的 hh:mm:ss */
const CLOCK = '\\d\\d:\\d\\d:\\d\\d';

/** @brief 测试准备（synthetic test setup）：用户级配置，全部本机区域，默认范围 okd。 */
function buildConfig() {
  const providers = PROVIDERS.map(([id, port, opts = {}]) => providerOf(id, id.toUpperCase(), port,
    [modelOf(M(id), { contextWindow: opts.window, maxTokens: opts.maxTokens, reasoning: opts.reasoning })],
    { concurrency: opts.concurrency }));
  const groups = Object.entries(GROUPS).map(([id, members]) => ({ id, members }));
  return { version: 1, providers, groups, normalDefault: 'okd', allowedZones: ['local', 'intranet'],
    projectZones: {} };
}

/** @brief 测试准备：cancel_verified 按提供商给出（其余档案没跑过取消探针）。 */
function cancels() {
  return Object.fromEntries(PROVIDERS.filter(([, , opts]) => opts?.cancel !== undefined)
    .map(([id, , opts]) => [R(id), opts.cancel]));
}

// ---------- 小工具 ----------

/** @brief 经进程桥发一条命令（界面里的 window.mori）。 */
const bridge = (ctx, command) => ctx.page.evaluate((cmd) => window.mori.request(cmd), command);
/** @brief 合成端点日志里某个模型的对话请求（不含探针）。 */
const chatLogs = (ctx, model, since = 0) => ctx.logs.filter((line) => line.model === model && line.t >= since
  && !line.probe);
/** @brief 记录代理收到的某个模型的对话请求。 */
const captures = (proxy, model, since = 0) => proxy.captures.filter((item) => item.chat && item.model === model
  && item.t >= since);
/** @brief 消息内容的文字。 */
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '');
/** @brief 请求体里的角色序列。 */
const rolesOf = (body) => (body?.messages ?? []).map((message) => message.role);
/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 一行概括（检查的 detail）。 */
const brief = (value) => oneLine(JSON.stringify(value), 1500);
/** @brief 合成端点日志行的简写。 */
const lineBrief = (lines, since = lines[0]?.t ?? 0) => lines.map((line) => `${line.model}:${line.status}:`
  + `${line.key ?? '-'}@${Math.round((line.t - since) / 100) / 10}s`);

/** @brief 某个会话的模型层事件（type 以 mori. 开头的，可按类型筛）。 */
async function moriEvents(ctx, tab, type, since = 0) {
  const sid = ctx.sids[tab];
  return (await eventsOf(ctx.page, sid ?? '__none__', since)).filter((item) => item.type === type);
}

/** @brief 某个会话从 since 起有没有进入排队（mori.model_queue active）。 */
async function queued(ctx, tab, since) {
  return (await moriEvents(ctx, tab, 'mori.model_queue', since)).some((item) => item.data.active);
}

// ---------- 启动与会话 ----------

/** @brief 启动 Mori，订阅事件、装阶段行记录。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await captureEvents(ctx.page);
  await watchStages(ctx.page);
}

/** @brief 测试准备：经 models.addKey 给提供商加 key（按表里的顺序，标签 Key 1、Key 2…）。 */
async function addKeys(ctx) {
  for (const [id, , opts] of PROVIDERS) {
    for (const [index, secret] of (opts?.keys ?? []).entries()) {
      const result = await bridge(ctx, { type: 'models.addKey', providerId: id, label: `Key ${index + 1}`, secret });
      if (result.error) throw new Error(`models.addKey ${id}: ${result.error}`);
      (ctx.refs[id] ??= []).push(result.ref);
    }
  }
}

/** @brief 点"打开文件夹…"打开 folder（系统对话框换成直接返回它），等新会话就绪，返回它的标识。 */
async function openFolder(ctx, folder) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: /^(Open folder…|打开文件夹…)$/ }).first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length === n, before + 1,
    { timeout: 30000 });
  return visibleReady(ctx);
}

/** @brief 等当前显示的会话就绪，返回它的标识。 */
async function visibleReady(ctx) {
  await ctx.page.waitForFunction(() => {
    const pane = document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
    return pane && !pane.querySelector('[data-testid="not-ready"]');
  }, null, { timeout: 30000 });
  return ctx.page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]').first().getAttribute('data-tab');
}

/** @brief Ctrl+N 新建会话（同一个项目），返回它的标识。 */
async function newSession(ctx) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  await page.locator('.pane-slot:not([hidden]) .composer textarea').first().focus();
  await page.keyboard.press('Control+n');
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length === n, before + 1,
    { timeout: 30000 });
  return visibleReady(ctx);
}

/** @brief 让某个会话显示出来（点侧栏里它的一行）。 */
async function showTab(ctx, tab) {
  const shown = ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`);
  if (await shown.count()) return;
  await ctx.page.locator(`.session-item[data-row="${tab}"]`).click();
  await shown.waitFor({ timeout: 10000 });
}

/** @brief 会话行上的会话文件；还没有时为空串。 */
const fileOf = (ctx, tab) => ctx.page.locator(`.session-item[data-row="${tab}"]`).getAttribute('data-file');

/** @brief 在顶栏的范围菜单里选 pick，等按钮换过去；从 mori.model_state 认出这个会话的 pi 会话 id。 */
async function chooseRange(ctx, tab, pick) {
  const { page } = ctx;
  await showTab(ctx, tab);
  const since = Date.now();
  await page.locator(paneSel(tab)).getByTestId('model-button').click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-pick="${pick}"]`).click();
  await page.waitForFunction(([selector, want]) => document.querySelector(selector)
    ?.querySelector('[data-testid="model-button"]')?.dataset.pick === want, [paneSel(tab), pick], { timeout: 15000 });
  const sid = await poll(async () => (await eventsOf(page, null, since))
    .find((item) => item.type === 'mori.model_state' && item.data.pick === pick)?.sid, 5000);
  if (!sid) throw new Error(`no mori.model_state for ${pick}`);
  ctx.sids[tab] = sid;
  return sid;
}

/** @brief 新会话并选好范围。 */
async function sessionWith(ctx, pick) {
  const tab = await newSession(ctx);
  await chooseRange(ctx, tab, pick);
  return tab;
}

/** @brief 在某个会话的输入框里写字并按 key（默认 Enter）。 */
async function send(ctx, tab, text, key = 'Enter') {
  await showTab(ctx, tab);
  const box = ctx.page.locator(`${paneSel(tab)} .composer textarea`);
  await box.fill(text);
  await box.press(key);
}

/** @brief 发一条消息并等它结束（开始发送或生成之后再等空闲）。 */
async function sendWait(ctx, tab, text, timeout = 120000) {
  await showTab(ctx, tab);
  const before = await paneCounts(ctx.page, tab);
  await send(ctx, tab, text);
  await waitTabBusy(ctx.page, tab, 10000, before);
  await waitTabIdle(ctx.page, tab, timeout);
  return paneState(ctx.page, tab);
}

/** @brief 点某个会话的"停止"。 */
async function stop(ctx, tab) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .stop-button`).click();
}

/** @brief 等合成端点日志里出现某个模型的第 count 个对话请求（从 since 起）；出现时为 true。 */
const waitLine = (ctx, model, since, count = 1, timeout = 20000) => poll(() => chatLogs(ctx, model, since).length
  >= count, timeout, 100);

/** @brief 这个会话的换模型提示（对话流里）。 */
async function switchesOf(ctx, tab) {
  return (await paneState(ctx.page, tab)).switches;
}

/** @brief 打开设置页的 Models 分节，返回某个提供商的 key 行（ref、记录、文字）。 */
async function keyRows(ctx, providerId) {
  const { page } = ctx;
  if (!(await page.getByTestId('settings-page').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  }
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  const card = page.locator(`[data-testid="provider-card"][data-provider="${providerId}"]`);
  await card.waitFor({ timeout: 10000 });
  await card.scrollIntoViewIfNeeded();
  return card.locator('[data-testid="key-row"]').evaluateAll((rows) => rows.map((row) => {
    const state = row.querySelector('[data-testid="key-state"]');
    return { ref: row.dataset.ref, state: state?.dataset.state ?? null, text: state?.textContent ?? null };
  }));
}

/** @brief 从设置页回到会话。 */
async function backToChat(ctx) {
  const { page } = ctx;
  if (!(await page.getByTestId('settings-page').isVisible().catch(() => false))) return;
  await page.getByRole('button', { name: '返回会话' }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 改提供商（models.saveProvider，与设置页的提供商表单相同的命令）。 */
function saveProvider(ctx, id, changes) {
  const [, port, opts = {}] = PROVIDERS.find(([pid]) => pid === id);
  const current = providerOf(id, id.toUpperCase(), port, [], { concurrency: opts.concurrency });
  const provider = { name: current.name, api: current.api, baseUrl: current.baseUrl, compat: {},
    concurrency: current.concurrency, zone: 'local', ...changes };
  return bridge(ctx, { type: 'models.saveProvider', id, provider });
}

// ---------- MP-03、MP-04、MP-14、MP-25：多个 key、全部 key 不可用、第一个请求就失败、只有一层重试 ----------

/** @brief MP-03：两个会话分屏同时发送，一个提供商两个 key、并发各 1。 */
async function multiKey(ctx) {
  const { page } = ctx;
  const first = await sessionWith(ctx, 'm03');
  await sendWait(ctx, first, 'plain MP03 warm-up');
  const file = await fileOf(ctx, first);
  const second = await sessionWith(ctx, 'm03');
  await chooseMenuItem(page, file, '在右侧分屏打开');
  await waitSplit(page, true);
  const tabAt = (side) => page.locator(`${slotSelector(side)} [data-testid="chat-pane"]`).getAttribute('data-tab');
  const [left, right] = [await tabAt('left'), await tabAt('right')];
  const since = Date.now();
  await send(ctx, left, 'wait 3s MP03 left');
  await send(ctx, right, 'wait 3s MP03 right');
  await Promise.all([left, right].map((tab) => waitTabBusy(page, tab)));
  await Promise.all([left, right].map((tab) => waitTabIdle(page, tab, 60000)));
  const lines = chatLogs(ctx, M('m03'), since);
  const keys = lines.map((line) => line.key).sort();
  const gap = lines.length === 2 ? Math.abs(lines[0].t - lines[1].t) : null;
  const waits = [await queued(ctx, left, since), await queued(ctx, right, since)];
  const states = [await paneState(page, left), await paneState(page, right)];
  record('MP-03 two sessions in split view sending at once on one provider with two keys (concurrency 1 each): '
    + 'each request uses a different key and both go out together without queueing',
  lines.length === 2 && same(keys, [tail(K.m03a), tail(K.m03b)].sort()) && lines.every((line) => line.status === 200)
    && gap !== null && gap < 2000 && !waits.includes(true)
    && states.every((state) => state.assistants.at(-1)?.includes('等了 3 秒') && state.errors.length === 0),
  brief({ lines: lineBrief(lines, since), gap, waits, second: Boolean(second) }));
  await page.locator(`${slotSelector('right')} [data-testid="close-pane"]`).click();
  await waitSplit(page, false);
}

/** @brief MP-03：第一个 key 被 429 后同一个请求改用第二个 key，不提示换模型。 */
async function firstKeyLimited(ctx) {
  const tab = await sessionWith(ctx, 'm03b');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'plain MP03 second key');
  const lines = chatLogs(ctx, M('m03b'), since);
  const switches = await moriEvents(ctx, tab, 'mori.model_switch', since);
  record('MP-03 FAKE_LIMITED_KEYS on key 1: the request gets 429 on key 1 and is resent on key 2, with no '
    + 'model-switch notice and no error card',
  same(lineBrief(lines).map((item) => item.split('@')[0]),
    [`${M('m03b')}:429:${tail(K.l25a)}`, `${M('m03b')}:200:${tail(K.l25b)}`])
    && state.switches.length === 0 && switches.length === 0 && state.errors.length === 0
    && state.assistants.at(-1)?.includes(PLAIN), brief({ lines: lineBrief(lines, since), state }));
}

/** @brief MP-04：两个 key 都 429 → 换到下一个提供商，一行换模型提示，没有错误卡。 */
async function allKeysLimited(ctx) {
  const tab = await sessionWith(ctx, 'g04');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'plain MP04');
  const lines = chatLogs(ctx, M('m04'), since);
  const backup = chatLogs(ctx, M('m04bk'), since);
  record('MP-04 both keys answer 429: Mori tries both keys, then switches to the next candidate provider; one '
    + 'model-switch notice, no error card',
  same(lines.map((line) => `${line.status}:${line.key}`), [`429:${tail(K.m04a)}`, `429:${tail(K.m04b)}`])
    && backup.length === 1 && backup[0].status === 200 && state.switches.length === 1
    && state.switches[0].from === R('m04') && state.switches[0].to === R('m04bk')
    && state.switches[0].reason === 'rate_limited' && state.errors.length === 0 && state.unavailable.length === 0
    && state.assistants.at(-1)?.includes(PLAIN), brief({ lines: lineBrief([...lines, ...backup], since), state }));
}

/** @brief MP-14：首选 401（错的 key）→ 同一个请求发给第二候选，有换模型提示，没有错误卡。 */
async function firstRequestFails(ctx) {
  const tab = await sessionWith(ctx, 'g14');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'plain MP14');
  const failed = chatLogs(ctx, M('m14'), since);
  const backup = chatLogs(ctx, M('m14bk'), since);
  const notice = state.switches[0];
  record('MP-14 the preferred model answers 401 (wrong key) on the first request: the same request (same roles) '
    + 'goes to the second candidate; one model-switch notice "API key rejected" without the redo sentence; '
    + 'no error card',
  failed.length === 1 && failed[0].status === 401 && failed[0].key === tail(K.bad14) && backup.length === 1
    && backup[0].status === 200 && same(backup[0].roles, failed[0].roles) && state.switches.length === 1
    && notice.reason === 'auth' && !notice.hidden && notice.text.includes('API key rejected')
    && !notice.text.includes('redoes') && state.errors.length === 0 && state.assistants.at(-1)?.includes(PLAIN),
  brief({ lines: lineBrief([...failed, ...backup], since), roles: [failed[0]?.roles, backup[0]?.roles], state }));
}

/** @brief MP-25：429 时 pi 不自动重试（没有 auto_retry_*），合成端点每次尝试对得上；打开工具页、改思考强度后仍然没有。 */
async function oneRetryLayer(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'm25x');
  const since = Date.now();
  const first = await sendWait(ctx, tab, 'plain MP25 first');
  const firstLines = chatLogs(ctx, M('m25x'), since);
  const retries = async (from) => (await eventsOf(page, ctx.sids[tab], from))
    .filter((item) => item.type.startsWith('auto_retry'));
  const firstRetries = await retries(since);
  record('MP-25 a 429 with no other key or candidate: no pi auto_retry_start/end events; the fake endpoint log has '
    + 'exactly the one attempt Mori made (one 429), and one "No model available" card',
  firstRetries.length === 0 && firstLines.length === 1 && firstLines[0].status === 429
    && first.unavailable.length === 1 && first.errors.length === 0,
  brief({ retries: firstRetries, lines: lineBrief(firstLines, since), state: first }));
  await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  await sleep(1000);
  await page.locator(`.session-item[data-row="${tab}"]`).click();
  await page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 10000 });
  await chooseRange(ctx, tab, 'm25y');
  await page.locator(paneSel(tab)).getByTestId('thinking-button').click();
  await page.getByTestId('thinking-menu').locator('[role="menuitemradio"][data-level="high"]').click();
  await page.waitForFunction((selector) => document.querySelector(selector)
    ?.querySelector('[data-testid="thinking-button"]')?.dataset.level === 'high', paneSel(tab), { timeout: 10000 });
  const later = Date.now();
  const second = await sendWait(ctx, tab, 'plain MP25 after tools page and thinking change');
  const secondLines = chatLogs(ctx, M('m25y'), later);
  const secondRetries = await retries(later);
  record('MP-25 after opening the Tools page and changing the thinking level to high: a 429 still gives no pi '
    + 'auto_retry_* events and exactly one attempt in the fake endpoint log',
  secondRetries.length === 0 && secondLines.length === 1 && secondLines[0].status === 429
    && second.unavailable.length === 2 && second.errors.length === 0,
  brief({ retries: secondRetries, lines: lineBrief(secondLines, later), state: second }));
}

// ---------- MP-16、MP-17：原地重试、不换的情况与停止 ----------

/** @brief MP-16：http-503-once 重试一次后成功；http-503 重试用完后错误卡；都不换模型。 */
async function serverRetry(ctx) {
  const tab = await sessionWith(ctx, 'g16');
  const since = Date.now();
  const once = await sendWait(ctx, tab, 'http-503-once plain MP16 first');
  const onceStages = (await stagesOf(ctx.page, tab, since)).map((item) => item.v);
  const onceLines = chatLogs(ctx, M('m16'), since);
  record('MP-16 http-503-once: the stage line shows "Retrying 1/3 · HTTP 503", the retry succeeds on the same '
    + 'model, no model switch and no error card',
  onceStages.includes('retry|Retrying 1/3 · HTTP 503') && same(onceLines.map((line) => line.status), [503, 200])
    && chatLogs(ctx, M('m16bk'), since).length === 0 && once.switches.length === 0 && once.errors.length === 0
    && once.assistants.at(-1)?.includes(PLAIN), brief({ stages: onceStages, lines: lineBrief(onceLines, since) }));
  const later = Date.now();
  const always = await sendWait(ctx, tab, 'http-503 plain MP16 second', 90000);
  const stages = (await stagesOf(ctx.page, tab, later)).map((item) => item.v);
  const lines = chatLogs(ctx, M('m16'), later);
  record('MP-16 http-503: Retrying 1/3, 2/3, 3/3 on the stage line, four attempts on the same model, then the v0 '
    + 'error card; no model switch (the second candidate gets nothing)',
  ['1/3', '2/3', '3/3'].every((n) => stages.includes(`retry|Retrying ${n} · HTTP 503`)) && lines.length === 4
    && lines.every((line) => line.status === 503) && chatLogs(ctx, M('m16bk'), since).length === 0
    && always.switches.length === 0 && always.errors.length === 1 && always.errors[0].includes('503')
    && always.unavailable.length === 0, brief({ stages, lines: lineBrief(lines, later), errors: always.errors }));
}

/** @brief MP-17：400、有输出后中断都不换模型；生成中按停止不换。 */
async function noSwitchCases(ctx) {
  const tab = await sessionWith(ctx, 'g17');
  const since = Date.now();
  const bad = await sendWait(ctx, tab, 'http-400 plain MP17');
  record('MP-17 HTTP 400 (request error): the reply ends with the v0 error card showing the original text; no model '
    + 'switch, the second candidate gets nothing',
  bad.errors.length === 1 && bad.errors[0].includes('400') && bad.switches.length === 0
    && chatLogs(ctx, M('m17bk'), since).length === 0, brief({ errors: bad.errors, switches: bad.switches }));
  const dropped = await sendWait(ctx, tab, 'drop-after-first plain MP17');
  record('MP-17 the connection drops after the first output (partial): error card, the partial output stays, no '
    + 'model switch',
  dropped.errors.length === 2 && dropped.switches.length === 0 && chatLogs(ctx, M('m17bk'), since).length === 0
    && (dropped.assistants.at(-1) ?? '').includes('这是'), brief({ errors: dropped.errors,
    last: dropped.assistants.at(-1) }));
  await send(ctx, tab, 'wait 6s MP17 stop before output');
  await waitTabBusy(ctx.page, tab);
  await sleep(1500);
  await stop(ctx, tab);
  await waitTabIdle(ctx.page, tab, 30000);
  await send(ctx, tab, 'long reply MP17 stop while streaming');
  await poll(async () => (await paneState(ctx.page, tab)).assistants.at(-1)?.includes('第一段'), 20000, 50);
  await stop(ctx, tab);
  await waitTabIdle(ctx.page, tab, 30000);
  const stopped = await paneState(ctx.page, tab);
  record('MP-17 Stop while waiting for the first output and Stop while streaming: "已停止" each time, no new error '
    + 'card, no model switch, the second candidate gets nothing',
  stopped.stopped === 2 && stopped.errors.length === 2 && stopped.switches.length === 0
    && chatLogs(ctx, M('m17bk'), since).length === 0, brief({ stopped: stopped.stopped, errors: stopped.errors }));
}

/** @brief MP-17：两个会话排同一个提供商，在排队中按停止其中一个，另一个照常发出；停止的那个没有请求到达端点。 */
async function stopQueued(ctx) {
  const { page } = ctx;
  const holder = await sessionWith(ctx, 'q17');
  const since = Date.now();
  await send(ctx, holder, 'wait 20s MP17 holder');
  await waitLine(ctx, M('q17'), since);
  const other = await sessionWith(ctx, 'q17');
  await send(ctx, other, 'plain MP17 other queued');
  const otherQueued = await waitStageKind(page, other, 'queue', 15000);
  const stopped = await sessionWith(ctx, 'q17');
  await send(ctx, stopped, 'plain MP17 stopped while queued');
  const queuedStage = await waitStageKind(page, stopped, 'queue', 15000);
  const stageText = (await paneState(page, stopped)).stage;
  await stop(ctx, stopped);
  await waitTabIdle(page, stopped, 30000);
  const state = await paneState(page, stopped);
  await waitTabIdle(page, other, 60000);
  await waitTabIdle(page, holder, 60000);
  const lines = chatLogs(ctx, M('q17'), since);
  const otherState = await paneState(page, other);
  record('MP-17 Stop while queued for a slot ("Waiting for Q17" on the stage line): "已停止", no error card, no '
    + 'model switch, and the fake endpoint never receives that request',
  queuedStage && /^Waiting for Q17/.test(stageText ?? '') && state.stopped === 1 && state.errors.length === 0
    && state.unavailable.length === 0 && state.switches.length === 0 && lines.length === 2,
  brief({ stageText, state, lines: lineBrief(lines, since) }));
  record('MP-17 two sessions queued on one provider, one is stopped: the other one is sent when the slot frees '
    + 'up and replies normally',
  otherQueued && lines.length === 2 && lines[1].t - lines[0].t >= 18000 && otherState.assistants.at(-1)
    ?.includes(PLAIN) && otherState.errors.length === 0, brief({ lines: lineBrief(lines, since) }));
}

/** @brief MP-17：回复中等模型时按停止：已停止，不是错误卡，端点没有收到新的请求。 */
async function stopWaitingModel(ctx) {
  const { page } = ctx;
  const helper = await sessionWith(ctx, 'w17b');
  await sendWait(ctx, helper, 'plain MP17 cool down w17b');
  const tab = await sessionWith(ctx, 'g17w');
  const since = Date.now();
  await send(ctx, tab, 'plain MP17 waiting for a model');
  const waiting = await waitStageKind(page, tab, 'wait-model', 15000);
  const stageText = (await paneState(page, tab)).stage;
  const stoppedAt = Date.now();
  await stop(ctx, tab);
  await waitTabIdle(page, tab, 30000);
  await sleep(1000);
  const state = await paneState(page, tab);
  const after = [...chatLogs(ctx, M('w17a'), stoppedAt), ...chatLogs(ctx, M('w17b'), stoppedAt)];
  record('MP-17 Stop while "Waiting for a model · rate limited until hh:mm:ss" in a reply: "已停止" instead of '
    + 'an error card or a "No model available" card, and no new request reaches the fake endpoint',
  waiting && new RegExp(`^Waiting for a model · rate limited until ${CLOCK}`).test(stageText ?? '')
    && state.stopped === 1 && state.errors.length === 0 && state.unavailable.length === 0 && after.length === 0
    && chatLogs(ctx, M('w17a'), since).length === 1, brief({ stageText, state, after: lineBrief(after) }));
}

// ---------- MP-19、MP-31：排队与优先级、槽位不泄漏 ----------

/** @brief MP-19：并发 1 时第二个请求排队，阶段行显示等待，前一个结束后发出。 */
async function queueStage(ctx) {
  const { page } = ctx;
  const holder = await sessionWith(ctx, 'q19');
  const since = Date.now();
  await send(ctx, holder, 'wait 8s MP19 holder');
  await waitLine(ctx, M('q19'), since);
  const tab = await sessionWith(ctx, 'q19');
  await send(ctx, tab, 'plain MP19 queued');
  const shown = await waitStageKind(page, tab, 'queue', 10000);
  const text = (await paneState(page, tab)).stage;
  await waitTabIdle(page, tab, 60000);
  const lines = chatLogs(ctx, M('q19'), since);
  const state = await paneState(page, tab);
  record('MP-19 concurrency 1: the second request queues with "Waiting for Q19 · Ns" on the stage line and is sent '
    + 'when the first one ends',
  shown && /^Waiting for Q19 · \d+s$/.test(text ?? '') && lines.length === 2 && lines[1].t - lines[0].t >= 7000
    && state.assistants.at(-1)?.includes(PLAIN) && state.switches.length === 0,
  brief({ text, lines: lineBrief(lines, since) }));
}

/** @brief MP-19：并发 1、对话占着槽位时添加模型：探针排在对话之后（包括之后才来的对话），结束后档案为 verified。 */
async function probeAfterConversation(ctx) {
  const { page } = ctx;
  const holder = await sessionWith(ctx, 'q19p');
  const since = Date.now();
  await send(ctx, holder, 'wait 12s MP19 probe holder');
  await waitLine(ctx, M('q19p'), since);
  const added = await bridge(ctx, { type: 'models.saveModel', providerId: 'q19p', model: modelOf('fake-coder-q19new'),
    adding: true });
  await sleep(1000);
  const tab = await sessionWith(ctx, 'q19p/fake-coder-q19p');
  await send(ctx, tab, 'plain MP19 conversation after probe');
  await waitTabIdle(page, tab, 60000);
  const verified = await poll(async () => (await bridge(ctx, { type: 'models.get' }))
    .profiles?.['q19p/fake-coder-q19new']?.tool_calling?.state === 'verified', 90000, 1000);
  const probes = ctx.logs.filter((line) => line.model === 'fake-coder-q19new' && line.probe && line.t >= since);
  const lines = chatLogs(ctx, M('q19p'), since);
  record('MP-19 concurrency 1 with a conversation holding the slot when a model is added: its probes wait until '
    + 'the conversation ends, a conversation request that came later still goes first, and the profile ends verified',
  added.error === null && lines.length === 2 && probes.length > 0 && probes[0].t >= lines[0].t + 11000
    && probes[0].t >= lines[1].t && lines[1].t >= lines[0].t + 11000 && verified,
  brief({ lines: lineBrief(lines, since), firstProbe: probes[0] && (probes[0].t - since), verified,
    error: added.error }));
  await uiVerified(ctx, 'q19p/fake-coder-q19new');
}

/** @brief MP-19：设置页的模型行显示 Tool calling: Verified。 */
async function uiVerified(ctx, ref) {
  const { page } = ctx;
  await keyRows(ctx, ref.split('/')[0]);
  const value = await page.locator(`[data-testid="model-row"][data-model="${ref}"] [data-field="tool_calling"]`)
    .getAttribute('data-value', { timeout: 10000 }).catch(() => null);
  record('MP-19 after the queued probes the Models row of the added model shows "Tool calling: Verified"',
    value === 'verified', `tool_calling=${value}`);
  await backToChat(ctx);
}

/** @brief MP-19：调低并发：进行中的照常完成，新请求等到占用数低于新上限。 */
async function lowerConcurrency(ctx) {
  const { page } = ctx;
  const first = await sessionWith(ctx, 'c19');
  const since = Date.now();
  await send(ctx, first, 'wait 6s MP19 lower first');
  const second = await sessionWith(ctx, 'c19');
  await send(ctx, second, 'wait 12s MP19 lower second');
  await waitLine(ctx, M('c19'), since, 2);
  const saved = await saveProvider(ctx, 'c19', { concurrency: 1 });
  const third = await sessionWith(ctx, 'c19');
  await send(ctx, third, 'plain MP19 lower third');
  const waited = await waitStageKind(page, third, 'queue', 10000);
  await Promise.all([first, second, third].map((tab) => waitTabIdle(page, tab, 60000)));
  const lines = chatLogs(ctx, M('c19'), since);
  const states = await Promise.all([first, second].map((tab) => paneState(page, tab)));
  record('MP-19 lowering concurrency from 2 to 1 with two requests in flight: both finish normally and a new '
    + 'request queues until both are done (usage below the new limit)',
  saved.error === null && waited && lines.length === 3 && lines[2].t >= lines[1].t + 11000
    && states[0].assistants.at(-1)?.includes('等了 6 秒') && states[1].assistants.at(-1)?.includes('等了 12 秒'),
  brief({ lines: lineBrief(lines, since), error: saved.error }));
}

/** @brief MP-19：删 key：它上面进行中的请求照常完成，排队中的请求重新取 key（不用删掉的）。 */
async function removeKeyQueued(ctx) {
  const { page } = ctx;
  const first = await sessionWith(ctx, 'd19');
  const since = Date.now();
  await send(ctx, first, 'wait 8s MP19 key one');
  await waitLine(ctx, M('d19'), since, 1);
  const second = await sessionWith(ctx, 'd19');
  await send(ctx, second, 'wait 14s MP19 key two');
  await waitLine(ctx, M('d19'), since, 2);
  const third = await sessionWith(ctx, 'd19');
  await send(ctx, third, 'plain MP19 waits for a key');
  const waited = await waitStageKind(page, third, 'queue', 10000);
  const removed = await bridge(ctx, { type: 'models.removeKey', providerId: 'd19', ref: ctx.refs.d19[1] });
  await Promise.all([first, second, third].map((tab) => waitTabIdle(page, tab, 60000)));
  const lines = chatLogs(ctx, M('d19'), since);
  const secondState = await paneState(page, second);
  record('MP-19 removing a key with a request in flight on it and another request queued: the in-flight request '
    + 'finishes normally, the queued one takes the remaining key when its slot frees up',
  removed.error === null && waited && lines.length === 3 && lines[2].key === tail(K.m03a)
    && lines[2].t >= lines[0].t + 7000 && lines[2].t < lines[1].t + 13000
    && secondState.assistants.at(-1)?.includes('等了 14 秒'), brief({ lines: lineBrief(lines, since) }));
}

/** @brief MP-19：加 key：新加的 key 立即可用，排队中的请求马上用它发出。 */
async function addKeyQueued(ctx) {
  const { page } = ctx;
  const first = await sessionWith(ctx, 'a19');
  const since = Date.now();
  await send(ctx, first, 'wait 10s MP19 only key');
  await waitLine(ctx, M('a19'), since, 1);
  const second = await sessionWith(ctx, 'a19');
  await send(ctx, second, 'plain MP19 new key');
  const waited = await waitStageKind(page, second, 'queue', 10000);
  const added = await bridge(ctx, { type: 'models.addKey', providerId: 'a19', label: 'Key 2', secret: K.m03b });
  await waitTabIdle(page, second, 60000);
  const lines = chatLogs(ctx, M('a19'), since);
  record('MP-19 adding a key while a request is queued: the queued request is sent at once with the new key',
    added.error === null && waited && lines.length >= 2 && lines[1].key === tail(K.m03b)
      && lines[1].t < lines[0].t + 8000, brief({ lines: lineBrief(lines, since) }));
  await waitTabIdle(page, first, 60000);
}

/**
 * @brief MP-19 / MP-36：会话 2 段内，会话 1 让它当前模型的 key 冷却（http-429）：会话 2 的下一个请求不发出、不排队，
 *        直接换模型。
 */
async function cooledByOther(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'g19r');
  const helper = await sessionWith(ctx, 'r19');
  const since = Date.now();
  await send(ctx, tab, 'MP19 cooled read the readme');
  await waitLine(ctx, M('r19'), since);
  await sendWait(ctx, helper, 'http-429 plain MP19 cool down');
  await waitTabIdle(page, tab, 60000);
  const state = await paneState(page, tab);
  const ok = chatLogs(ctx, M('r19'), since).filter((line) => line.status === 200);
  const backup = chatLogs(ctx, M('r19bk'), since);
  const wasQueued = await queued(ctx, tab, since);
  const detail = brief({ wasQueued, lines: lineBrief([...chatLogs(ctx, M('r19'), since), ...backup], since),
    switches: state.switches, errors: state.errors, tools: state.tools });
  // 第一个请求（r19 读 README）之后换模型：新模型重做这段（自己再读一次），所以两张工具卡。
  const passed = ok.length === 1 && backup.length >= 1 && !wasQueued && state.switches.length === 1
    && state.switches[0].from === R('r19') && state.switches[0].to === R('r19bk')
    && state.switches[0].reason === 'rate_limited' && state.errors.length === 0 && state.tools === 2;
  record('MP-19 session 2 in a reply meets a cooldown of all keys caused by session 1: it switches model at once '
    + 'without queueing and without sending to the cooled provider', passed, detail);
  record('MP-36 the current model is cooled down by another session during a reply: the next request switches '
    + 'model without being sent to it, with a model-switch notice', passed, detail);
}

/** @brief MP-31：正常结束、停止、出错、中断之后，并发 1 的下一个请求不排队、马上发出。 */
async function slotsReleased(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 's31');
  await sendWait(ctx, tab, 'plain MP31 first');
  const cases = [
    ['a normal reply', null],
    ['Stop while streaming', async () => {
      await send(ctx, tab, 'long reply MP31');
      await poll(async () => (await paneState(page, tab)).assistants.at(-1)?.includes('第一段'), 20000, 50);
      await stop(ctx, tab);
      await waitTabIdle(page, tab, 30000);
    }],
    ['Stop before any output', async () => {
      await send(ctx, tab, 'wait 6s MP31');
      await sleep(1500);
      await stop(ctx, tab);
      await waitTabIdle(page, tab, 30000);
    }],
    ['an HTTP 400 error', () => sendWait(ctx, tab, 'http-400 plain MP31')],
    ['a dropped connection after output', () => sendWait(ctx, tab, 'drop-after-first plain MP31')],
  ];
  for (const [label, run] of cases) {
    if (run) await run();
    const since = Date.now();
    const state = await sendWait(ctx, tab, `plain MP31 after ${label}`, 30000);
    const lines = chatLogs(ctx, M('s31'), since);
    const wasQueued = await queued(ctx, tab, since);
    record(`MP-31 concurrency 1, after ${label}: the next request is not queued and is sent at once (slot back to 0)`,
      !wasQueued && lines.length === 1 && lines[0].t - since < 3000 && state.assistants.at(-1)?.includes(PLAIN),
      brief({ wasQueued, lines: lineBrief(lines, since) }));
  }
}

// ---------- MP-32：认证头 ----------

/** @brief MP-32：openai-completions 带 Authorization: Bearer <key>；没有 key 的提供商不带认证头；占位 key 不发出。 */
async function authHeaders(ctx) {
  const tab = await sessionWith(ctx, 'b32');
  const since = Date.now();
  await sendWait(ctx, tab, 'plain MP32 with key');
  const keyed = captures(ctx.proxyH, M('b32'), since);
  record('MP-32 openai-completions with a key: the request carries "Authorization: Bearer <the key\'s secret>" and '
    + 'no x-api-key', keyed.length === 1 && keyed[0].auth === `Bearer ${K.b32}` && keyed[0].apiKey === null,
  `requests=${keyed.length} bearerMatches=${keyed[0]?.auth === `Bearer ${K.b32}`} apiKey=${keyed[0]?.apiKey}`);
  await chooseRange(ctx, tab, 'kl32');
  const later = Date.now();
  await sendWait(ctx, tab, 'plain MP32 keyless');
  const keyless = captures(ctx.proxyH, M('kl32'), later);
  record('MP-32 a provider without keys: the request carries no Authorization and no x-api-key header',
    keyless.length === 1 && keyless[0].auth === null && keyless[0].apiKey === null,
    brief(keyless.map((item) => ({ auth: item.auth, apiKey: item.apiKey }))));
  const proxied = [ctx.proxyA, ctx.proxyB, ctx.proxyH].flatMap((proxy) => proxy.captures);
  const leaked = proxied.filter((item) => String(item.auth ?? '').includes('mori-pool')
    || String(item.apiKey ?? '').includes('mori-pool'));
  const tails = ctx.logs.filter((line) => line.key === 'pool');
  record('MP-32 the pi placeholder key "mori-pool" never reaches a server (recording proxies and fake endpoint logs)',
    leaked.length === 0 && tails.length === 0,
    `proxied=${proxied.length} leaked=${leaked.length} tails=${tails.length}`);
}

// ---------- MP-29：认证、额度、404、连接失败、没有 key 的 429 ----------

/** @brief MP-29：401 → 换 key，key 记为 Rejected，之后跳过它；删掉重加后清除，再次使用。 */
async function authKey(ctx) {
  const tab = await sessionWith(ctx, 'au29');
  const since = Date.now();
  const first = await sendWait(ctx, tab, 'plain MP29 auth first');
  const firstLines = chatLogs(ctx, M('au29'), since);
  const rows = await keyRows(ctx, 'au29');
  await backToChat(ctx);
  record('MP-29 401 on key 1: the request is resent on key 2 (no model switch) and key 1 shows "Rejected"',
    same(firstLines.map((line) => `${line.status}:${line.key}`), [`401:${tail(K.bad29)}`, `200:${tail(K.good29)}`])
      && first.switches.length === 0 && first.errors.length === 0 && rows[0]?.state === 'auth'
      && rows[0]?.text === 'Rejected' && rows[1]?.state === null, brief({ lines: lineBrief(firstLines), rows }));
  const later = Date.now();
  await sendWait(ctx, tab, 'plain MP29 auth second');
  const secondLines = chatLogs(ctx, M('au29'), later);
  record('MP-29 the rejected key is remembered: the next reply goes straight to key 2',
    same(secondLines.map((line) => `${line.status}:${line.key}`), [`200:${tail(K.good29)}`]),
    brief(lineBrief(secondLines)));
  await bridge(ctx, { type: 'models.removeKey', providerId: 'au29', ref: ctx.refs.au29[0] });
  const readded = await bridge(ctx, { type: 'models.addKey', providerId: 'au29', label: 'Key 3', secret: K.bad29 });
  await bridge(ctx, { type: 'models.moveKey', providerId: 'au29', ref: readded.ref, delta: -1 });
  const after = await keyRows(ctx, 'au29');
  await backToChat(ctx);
  const third = Date.now();
  await sendWait(ctx, tab, 'plain MP29 auth third');
  const thirdLines = chatLogs(ctx, M('au29'), third);
  record('MP-29 removing the rejected key and adding it again clears the record: the new row has no state and '
    + 'the key is used again (401 again, then key 2)',
  after[0]?.ref === readded.ref && after[0]?.state === null && same(thirdLines.map((line) => line.key),
    [tail(K.bad29), tail(K.good29)]), brief({ after, lines: lineBrief(thirdLines) }));
}

/** @brief MP-29：402 → 换 key，key 行 Quota exhausted；额度恢复后 Test 成功清除记录，下一段用回它。 */
async function quotaKey(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'qu29');
  const since = Date.now();
  const first = await sendWait(ctx, tab, 'plain MP29 quota first');
  const lines = chatLogs(ctx, M('qu29'), since);
  const rows = await keyRows(ctx, 'qu29');
  await backToChat(ctx);
  record('MP-29 402 insufficient_quota on key 1: resent on key 2 without a model switch; key 1 shows '
    + '"Quota exhausted"', same(lines.map((line) => `${line.status}:${line.key}`), [`402:${tail(K.q1)}`,
    `200:${tail(K.q2)}`]) && first.switches.length === 0 && rows[0]?.state === 'quota'
    && rows[0]?.text === 'Quota exhausted', brief({ lines: lineBrief(lines), rows }));
  const later = Date.now();
  await sendWait(ctx, tab, 'plain MP29 quota second');
  record('MP-29 the exhausted key is skipped by the next reply', same(chatLogs(ctx, M('qu29'), later)
    .map((line) => line.key), [tail(K.q2)]), brief(lineBrief(chatLogs(ctx, M('qu29'), later))));
  // 测试准备（synthetic test setup）：额度已充值 = 重新启动这个合成端点，不再带 FAKE_QUOTA_KEYS。
  await stopEndpoint(ctx.endpoints[PORT.quota]);
  ctx.endpoints[PORT.quota] = await startEndpoint(PORT.quota, {}, ctx.logs);
  await keyRows(ctx, 'qu29');
  const row = page.locator(`[data-testid="key-row"][data-ref="${ctx.refs.qu29[0]}"]`);
  await row.locator('[data-action="key-test"]').click();
  const result = await poll(async () => {
    const text = await row.getByTestId('key-test').textContent().catch(() => '');
    return /^(Connected|Failed)/.test(text ?? '') ? text : null;
  }, 30000);
  const cleared = await keyRows(ctx, 'qu29');
  await backToChat(ctx);
  const third = Date.now();
  await sendWait(ctx, tab, 'plain MP29 quota third');
  const thirdLines = chatLogs(ctx, M('qu29'), third);
  record('MP-29 after the quota is restored, the key\'s Test succeeds and clears "Quota exhausted"; the next reply '
    + 'uses key 1 again', /^Connected · first token \d+ ms · total \d+ ms/.test(result ?? '')
    && cleared[0]?.state === null && same(thirdLines.map((line) => `${line.status}:${line.key}`),
    [`200:${tail(K.q1)}`]), brief({ result, cleared, lines: lineBrief(thirdLines) }));
}

/** @brief MP-29：404 → 换模型并记为 not_found，下一段跳过它；改了这个模型的配置后清除。 */
async function notFound(ctx) {
  const tab = await sessionWith(ctx, 'g29n');
  const since = Date.now();
  const first = await sendWait(ctx, tab, 'plain MP29 not found first');
  record('MP-29 HTTP 404: switches model with the reason "model not found on the server"',
    chatLogs(ctx, M('nf29'), since).map((line) => line.status).join() === '404' && first.switches.length === 1
      && first.switches[0].reason === 'not_found' && first.switches[0].text.includes('model not found on the server')
      && first.errors.length === 0, brief({ lines: lineBrief(chatLogs(ctx, M('nf29'), since)), first }));
  const later = Date.now();
  const second = await sendWait(ctx, tab, 'plain MP29 not found second');
  record('MP-29 the not_found model is remembered: the next reply skips it (no request, no new notice)',
    chatLogs(ctx, M('nf29'), later).length === 0 && second.switches.length === 1
      && chatLogs(ctx, M('nf29bk'), later).length === 1, brief(lineBrief(chatLogs(ctx, M('nf29bk'), later))));
  const saved = await bridge(ctx, { type: 'models.saveModel', providerId: 'nf29',
    model: modelOf(M('nf29'), { maxTokens: 16000 }), adding: false });
  const third = Date.now();
  const after = await sendWait(ctx, tab, 'plain MP29 not found third');
  record('MP-29 changing the model\'s configuration clears not_found: the next reply tries it again (404 again)',
    saved.error === null && chatLogs(ctx, M('nf29'), third).map((line) => line.status).join() === '404'
      && after.switches.length === 2,
    brief({ error: saved.error, lines: lineBrief(chatLogs(ctx, M('nf29'), third)) }));
}

/** @brief MP-29：连接失败 → 换模型，提供商 30 秒内被跳过，之后再试。 */
async function connectionFails(ctx) {
  const tab = await sessionWith(ctx, 'g29c');
  const since = Date.now();
  const first = await sendWait(ctx, tab, 'plain MP29 connection first');
  record('MP-29 connection refused: switches model with the reason "can\'t connect"',
    first.switches.length === 1 && first.switches[0].reason === 'connection'
      && first.switches[0].text.includes("can't connect") && first.errors.length === 0, brief(first.switches));
  const second = await sendWait(ctx, tab, 'plain MP29 connection second');
  record('MP-29 within 30 s the provider is skipped (no new switch notice, the backup answers)',
    second.switches.length === 1 && second.assistants.at(-1)?.includes(PLAIN), brief(second.switches));
  await sleep(Math.max(0, since + 32000 - Date.now()));
  const third = await sendWait(ctx, tab, 'plain MP29 connection third');
  record('MP-29 after 30 s the provider is tried again (a new switch notice "can\'t connect")',
    third.switches.length === 2 && third.switches[1].reason === 'connection', brief(third.switches));
}

/** @brief MP-29：没有 key 的提供商 429 带 Retry-After：下一段跳过它直到那个时刻，之后用回它。 */
async function keylessLimited(ctx) {
  const tab = await sessionWith(ctx, 'g29k');
  const since = Date.now();
  const first = await sendWait(ctx, tab, 'plain MP29 keyless first');
  const lines = chatLogs(ctx, M('kl29'), since);
  record('MP-29 a provider without keys answers 429 with Retry-After: switches model ("rate limited")',
    lines.length === 1 && lines[0].status === 429 && lines[0].key === null && first.switches.length === 1
      && first.switches[0].reason === 'rate_limited',
    brief({ lines: lineBrief(lines, since), first: first.switches }));
  const later = Date.now();
  const second = await sendWait(ctx, tab, 'plain MP29 keyless second');
  record('MP-29 before the Retry-After time the next reply skips the keyless provider (no request, no notice)',
    chatLogs(ctx, M('kl29'), later).length === 0 && second.switches.length === 1, brief(second.switches));
  await sleep(Math.max(0, (lines[0]?.t ?? since) + 16500 - Date.now()));
  const third = Date.now();
  const after = await sendWait(ctx, tab, 'plain MP29 keyless third');
  const thirdLines = chatLogs(ctx, M('kl29'), third);
  record('MP-29 after the Retry-After time the next reply uses the keyless provider again',
    thirdLines.length === 1 && thirdLines[0].status === 200 && after.switches.length === 1
      && after.assistants.at(-1)?.includes(PLAIN), brief(lineBrief(thirdLines, third)));
}

// ---------- MP-36：回复进行中改配置 ----------

/** @brief MP-36：回复中删除它正在用的提供商：下一个请求换到下一个候选并提示。 */
async function deleteCurrent(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'g36d');
  const since = Date.now();
  await send(ctx, tab, 'MP36 delete read the readme');
  await waitLine(ctx, M('d36'), since);
  const deleted = await bridge(ctx, { type: 'models.deleteProvider', id: 'd36', dryRun: false });
  await waitTabIdle(page, tab, 60000);
  const state = await paneState(page, tab);
  const notice = state.switches[0];
  record('MP-36 deleting the provider in use during a reply: the request in flight finishes, the next request '
    + 'switches to the next candidate with "removed from your model settings"',
  deleted.error === null && chatLogs(ctx, M('d36'), since).length === 1
    && chatLogs(ctx, M('d36bk'), since).length >= 1 && state.switches.length === 1 && notice.from === R('d36')
    && notice.to === R('d36bk') && notice.reason === 'missing'
    && notice.text.includes('removed from your model settings')
    && state.errors.length === 0, brief({ error: deleted.error, state,
    lines: lineBrief([...chatLogs(ctx, M('d36'), since), ...chatLogs(ctx, M('d36bk'), since)], since) }));
}

/** @brief MP-36：回复中改它的兼容选项：本段继续用它。 */
async function compatChange(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'g36c');
  const since = Date.now();
  await send(ctx, tab, 'MP36 compat read the readme');
  await waitLine(ctx, M('cc36'), since);
  const saved = await saveProvider(ctx, 'cc36', { compat: { supportsStore: false } });
  await waitTabIdle(page, tab, 60000);
  const state = await paneState(page, tab);
  const lines = chatLogs(ctx, M('cc36'), since);
  record('MP-36 changing the compatibility options of the provider in use during a reply: the reply keeps using '
    + 'it (both requests go to it), no model switch',
  saved.error === null && lines.length === 2 && chatLogs(ctx, M('cc36bk'), since).length === 0
    && state.switches.length === 0 && state.errors.length === 0 && state.tools === 1,
  brief({ error: saved.error, lines: lineBrief(lines, since), switches: state.switches }));
}

// ---------- MP-13：粘性与回到首选 ----------

/** @brief MP-13：段内换到第二候选后一直用它（首选恢复了也不换回）。 */
async function sticky(ctx) {
  const tab = await sessionWith(ctx, 'g13a');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'MP13 sticky read the readme');
  const preferred = chatLogs(ctx, M('a13a'), since);
  const second = chatLogs(ctx, M('b13a'), since);
  record('MP-13 after switching to the second candidate in a reply, the reply keeps using it: its next request goes '
    + 'to the second candidate although the preferred one has recovered (Retry-After passed)',
  preferred.length === 1 && preferred[0].status === 429 && second.length === 2
    && second[1].t >= preferred[0].t + 6500 && state.switches.length === 1 && state.tools === 1
    && state.errors.length === 0, brief({ lines: lineBrief([...preferred, ...second], since) }));
}

/**
 * @brief MP-13：首选在段开始时不可用（跳过），段内恢复后第二候选又失败 → 换到第三个而不是首选；
 *        第二条消息的第一次请求用段开始时选的模型；下一段首选可用时用回首选。
 */
async function thirdNotPreferred(ctx) {
  const { page } = ctx;
  const tab = await newSession(ctx);
  await sendWait(ctx, tab, 'plain MP13 first message');
  await chooseRange(ctx, tab, 'g13b');
  const helper = await sessionWith(ctx, 'a13b');
  // 首选的 key 只冷却 6 秒（FAKE_LIMIT_MS）：冷却之后马上回到 tab 发第二条消息。
  await sendWait(ctx, helper, 'plain MP13 cool the preferred');
  const limitedAt = chatLogs(ctx, M('a13b'))[0]?.t ?? Date.now();
  const since = Date.now();
  await send(ctx, tab, 'MP13 third read the readme');
  await waitLine(ctx, M('b13b'), since);
  await chooseRange(ctx, helper, 'b13b');
  await sendWait(ctx, helper, 'http-429 plain MP13 cool the second');
  await waitTabIdle(page, tab, 60000);
  const state = await paneState(page, tab);
  const lines = [...chatLogs(ctx, M('a13b'), since), ...chatLogs(ctx, M('b13b'), since),
    ...chatLogs(ctx, M('c13b'), since)].sort((a, b) => a.t - b.t);
  const firstReq = lines[0];
  const third = chatLogs(ctx, M('c13b'), since);
  record('MP-13 the first request of the second message uses the model chosen when its reply started (§11.4): '
    + 'the preferred one was unavailable then, so the second candidate', firstReq?.model === M('b13b')
    && firstReq?.status === 200, brief(lineBrief(lines, since)));
  record('MP-13 the preferred model was skipped at the start of the reply and recovered during it; when the second '
    + 'candidate then fails, the reply switches to the third candidate, not back to the preferred one',
  chatLogs(ctx, M('a13b'), since).length === 0 && third.length >= 1 && third[0].t >= limitedAt + 6500
    && state.switches.length === 1 && state.switches[0].from === R('b13b') && state.switches[0].to === R('c13b'),
  brief({ lines: lineBrief(lines, since), switches: state.switches }));
  const next = Date.now();
  const after = await sendWait(ctx, tab, 'plain MP13 next reply');
  record('MP-13 the next reply starts from the preferred model again once it is available (no notice)',
    chatLogs(ctx, M('a13b'), next).map((line) => line.status).join() === '200' && after.switches.length === 1
      && after.assistants.at(-1)?.includes(PLAIN), brief(lineBrief(chatLogs(ctx, M('a13b'), next), next)));
}

/** @brief MP-13：插话不开始新段：最后一条回答之后送达的插话、工具结果之后送达的插话，都还用段内的模型。 */
async function steerSameReply(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'g13c');
  const since = Date.now();
  await send(ctx, tab, 'long reply MP13 steer after answer');
  await poll(async () => (await paneState(page, tab)).assistants.at(-1)?.includes('第一段'), 30000, 50);
  await send(ctx, tab, 'plain MP13 steer one', 'Control+Enter');
  await waitTabIdle(page, tab, 60000);
  const preferred = chatLogs(ctx, M('a13c'), since);
  const second = chatLogs(ctx, M('b13c'), since);
  record('MP-13 a steer delivered after the last answer does not start a new reply: its request still goes to the '
    + 'model in use (second candidate) although the preferred one has recovered',
  preferred.length === 1 && second.length === 2 && same(second[1].roles.slice(-2), ['assistant', 'user'])
    && second[1].t >= preferred[0].t + 6500, brief(lineBrief([...preferred, ...second], since)));
  const tool = await sessionWith(ctx, 'g13d');
  const later = Date.now();
  await send(ctx, tool, 'MP13 steer after tool read the readme');
  await waitTabBusy(page, tool);
  await sleep(500);
  await send(ctx, tool, 'plain MP13 steer two', 'Control+Enter');
  await waitTabIdle(page, tool, 60000);
  const lines = chatLogs(ctx, M('b13d'), later);
  record('MP-13 a steer delivered after a tool result does not start a new reply: the request with it goes to the '
    + 'model in use', chatLogs(ctx, M('a13d'), later).length === 1 && lines.length === 2
    && same(lines[1].roles.slice(-3), ['assistant', 'tool', 'user']), brief(lineBrief(lines, later)));
}

/** @brief MP-13：溢出恢复（压缩后重试）留在同一段：重试仍用段内的模型，不回到已恢复的首选。 */
async function overflowKeepsReply(ctx) {
  const tab = await newSession(ctx);
  await sendWait(ctx, tab, 'plain MP13 overflow history');
  await chooseRange(ctx, tab, 'g13e');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'overflow-once plain MP13 overflow', 120000);
  const preferred = chatLogs(ctx, M('a13e'), since);
  const second = chatLogs(ctx, M('b13e'), since);
  record('MP-13 overflow recovery keeps the reply (tried is kept): after the context-overflow error and the '
    + 'compaction, the retry goes to the second candidate again, not to the recovered preferred model',
  // 压缩之后 pi 重试；之后的请求（压缩、重试、重试回复里的工具调用）都还在这一段，全部发给第二候选。
  preferred.length === 1 && preferred[0].status === 429 && second.length >= 3 && second[0].status === 400
    && second.slice(1).every((line) => line.status === 200) && second.at(-1).t >= preferred[0].t + 6500
    && state.switches.length === 1,
  brief({ lines: lineBrief([...preferred, ...second], since), roles: second.map((line) => line.roles.join(',')),
    errors: state.errors }));
}

// ---------- MP-15：段内换模型（重做） ----------

/** @brief 记录代理的规则：按模型分派（ctx.rules[model]）。 */
function installRules(ctx) {
  for (const proxy of [ctx.proxyA, ctx.proxyB]) proxy.rule = (info) => ctx.rules[info.model]?.(info) ?? null;
}

/** @brief 重做后检查新模型收到的第一个请求：只有 system 和这段的用户消息，用户消息末尾是说明。 */
function redoBody(body, from, reason) {
  const users = (body?.messages ?? []).filter((message) => message.role === 'user').map((m) => textOf(m.content));
  return { roles: rolesOf(body), noteOk: users.at(-1)?.endsWith(noteOf(from, reason)) ?? false,
    notes: users.join('\n').split(NOTE_HEAD).length - 1, user: users.at(-1)?.slice(-900) ?? null };
}

/** @brief A 的请求体里助手消息的工具调用 id（被隐藏的过程）。 */
const callIdsOf = (body) => (body?.messages ?? []).filter((m) => m.role === 'assistant')
  .flatMap((m) => (m.tool_calls ?? []).map((call) => call.id));

/** @brief 等某个会话进入生成中（pi 已开始运行）。 */
const waitRunning = (ctx, tab) => ctx.page.waitForFunction((selector) => document.querySelector(selector)
  ?.dataset.running === 'true', paneSel(tab), { timeout: 20000 });

/**
 * @brief MP-15：第三个请求时首选连不上（第一个请求读 README，插话在工具结果之后送达，第二个请求再读一次，第三个请求被拒）：
 *        新模型收到的上下文里没有之前的助手消息和工具结果，两条用户消息都在，说明加在插话末尾。
 */
async function redo15(ctx) {
  const { page } = ctx;
  ctx.rules[M('a15')] = ({ index }) => (index === 1 ? { delayMs: 3000 } : index >= 3 ? { refuse: true } : null);
  const tab = await sessionWith(ctx, 'g15');
  const since = Date.now();
  await send(ctx, tab, 'MP15 redo read the readme');
  await waitRunning(ctx, tab);
  await sleep(500);
  await send(ctx, tab, 'MP15 steer read the readme again', 'Control+Enter');
  await waitTabIdle(page, tab, 60000);
  const state = await paneState(page, tab);
  const failed = captures(ctx.proxyA, M('a15'), since);
  const redo = captures(ctx.proxyB, M('b15'), since);
  const callIds = callIdsOf(failed[2]?.body);
  const first = redoBody(redo[0]?.body, R('a15'), "can't connect");
  const users = (redo[0]?.body?.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content));
  record('MP-15 the preferred model fails on the third request of the reply (connection refused): the new model '
    + 'gets the system prompt and this reply\'s user messages (the message and the steer) without any earlier '
    + 'assistant message or tool result; the redo note is at the end of the last user message (the steer)',
  failed.length === 3 && failed[2].refused && callIds.length === 2
    && same(rolesOf(failed[2].body), ['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool'])
    && same(first.roles, ['system', 'user', 'user']) && first.noteOk && first.notes === 1
    && !users[0]?.includes(NOTE_HEAD), brief({ first, failedRoles: failed.map((item) => rolesOf(item.body)) }));
  const own = redo[1]?.body;
  record('MP-15 the new model\'s own messages are not hidden: its next request has its own assistant message and '
    + 'tool result, still without the hidden ones',
  same(rolesOf(own), ['system', 'user', 'user', 'assistant', 'tool'])
    && callIds.every((id) => !JSON.stringify(own).includes(id)), brief({ roles: rolesOf(own), callIds }));
  const file = await fileOf(ctx, tab);
  const text = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  record('MP-15 the session file and the transcript keep the hidden work: the file still has the first model\'s '
    + 'tool calls, the transcript shows all three tool cards and "The new model redoes this reply."',
  callIds.length === 2 && callIds.every((id) => text.includes(id)) && state.tools === 3
    && state.switches.length === 1 && state.switches[0].hidden
    && state.switches[0].text.includes('The new model redoes this reply.') && state.errors.length === 0,
  brief({ tools: state.tools, switches: state.switches, inFile: callIds.map((id) => text.includes(id)) }));
  ctx.redo15 = { tab, file, callIds };
  await shot(page, 'mp15-redo');
}

/** @brief MP-15：两次换模型时隐藏区间取并集，只有一段说明（来自最后一次）。 */
async function union15(ctx) {
  const refuse = ({ index }) => (index >= 2 ? { refuse: true } : null);
  ctx.rules[M('a15c')] = refuse;
  ctx.rules[M('b15c')] = refuse;
  const tab = await sessionWith(ctx, 'g15c');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'MP15 union read the readme');
  const third = captures(ctx.proxyB, M('c15c'), since);
  const first = redoBody(third[0]?.body, R('b15c'), "can't connect");
  record('MP-15 two switches in one reply: the third model gets neither model\'s work (intervals joined) and the '
    + 'user message carries exactly one note, naming the last model that failed',
  same(first.roles, ['system', 'user']) && first.noteOk && first.notes === 1 && state.switches.length === 2
    && state.switches.every((item) => item.hidden) && state.errors.length === 0,
  brief({ first, switches: state.switches }));
}

/** @brief MP-15：排队消息那一段被重做时，上一段的回答仍发给新模型。 */
async function follow15(ctx) {
  const { page } = ctx;
  ctx.rules[M('a15d')] = ({ index }) => (index >= 2 ? { refuse: true } : null);
  const tab = await sessionWith(ctx, 'g15d');
  const since = Date.now();
  await send(ctx, tab, 'wait 4s MP15 follow first');
  await waitTabBusy(page, tab);
  await sleep(800);
  await send(ctx, tab, 'plain MP15 follow queued');
  await waitTabIdle(page, tab, 60000);
  const redo = captures(ctx.proxyB, M('b15d'), since)[0]?.body;
  const messages = redo?.messages ?? [];
  record('MP-15 the reply of a queued message is redone on a new model: the previous reply\'s answer is still sent '
    + 'to the new model', same(rolesOf(redo), ['system', 'user', 'assistant', 'user'])
    && textOf(messages[2]?.content).includes('等了 4 秒') && textOf(messages[3]?.content).startsWith('plain MP15 follow')
    && (await paneState(page, tab)).switches.length === 1, brief({ roles: rolesOf(redo) }));
}

/** @brief MP-15：排队消息在上一段还在调工具时排进来，它那一段被重做时，上一段的回答完整地发给新模型。 */
async function followTool15(ctx) {
  const { page } = ctx;
  ctx.rules[M('a15e')] = ({ index }) => (index === 1 ? { delayMs: 4000 } : index >= 3 ? { refuse: true } : null);
  const tab = await sessionWith(ctx, 'g15e');
  const since = Date.now();
  await send(ctx, tab, 'MP15 follow tool read the readme');
  await waitTabBusy(page, tab);
  await sleep(800);
  await send(ctx, tab, 'plain MP15 follow tool queued');
  await waitTabIdle(page, tab, 60000);
  const redo = captures(ctx.proxyB, M('b15e'), since)[0]?.body;
  record('MP-15 a message queued while the previous reply was still working (tool call): when its reply is redone, '
    + 'the previous reply goes to the new model in full (user, tool call, tool result, answer)',
  same(rolesOf(redo), ['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
    && textOf(redo?.messages?.[4]?.content).includes('工具已返回'), brief({ roles: rolesOf(redo) }));
}

/** @brief MP-15：换到窗口更小的模型后触发阈值压缩，摘要请求里没有被隐藏的过程。 */
async function compact15(ctx) {
  const { page } = ctx;
  const readme = join(ctx.project2, 'README.md');
  const fill = (mark) => `# MP15 compaction project\n\n${Array.from({ length: 400 },
    (_, index) => `${mark} line ${index} of the synthetic readme used for the compaction check.`).join('\n')}\n`;
  writeFileSync(readme, fill('MARK-A'));
  ctx.rules[M('a15f')] = ({ index }) => (index >= 2 ? {
    refuse: true, before: async () => writeFileSync(readme, fill('MARK-B')) } : null);
  const tab = await openFolder(ctx, ctx.project2);
  await chooseRange(ctx, tab, 'g15f');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'MP15 compaction read the readme', 180000);
  const all = captures(ctx.proxyB, M('b15f'), since);
  const summaries = all.filter((item) => (item.body?.messages ?? []).some((m) => textOf(m.content)
    .startsWith(SUMMARY_SYSTEM)));
  const text = summaries.map((item) => JSON.stringify(item.body)).join('\n');
  record('MP-15 after switching to a model with a smaller window, the threshold compaction runs on it and the '
    + 'summary request does not contain the hidden work (the first model\'s tool result)',
  summaries.length >= 1 && !text.includes('MARK-A') && state.switches.length === 1 && state.switches[0].hidden,
  brief({ requests: all.length, summaries: summaries.length, hiddenInSummary: text.includes('MARK-A'),
    errors: state.errors, switches: state.switches }));
  await shot(page, 'mp15-compaction');
}

/** @brief MP-15：重新打开后仍然隐藏（重启 Mori，打开 redo15 的会话再发一条）。 */
async function reopen15(ctx) {
  const saved = ctx.redo15;
  if (!saved?.file) throw new Error('redo15 did not leave a session file');
  ctx.rules[M('a15')] = null;
  await ctx.app.close().catch(() => {});
  await startApp(ctx);
  await ctx.page.locator(`.session-item[data-file=${JSON.stringify(saved.file)}]`).click();
  const tab = await visibleReady(ctx);
  await ctx.page.waitForFunction((selector) => document.querySelectorAll(`${selector} [data-testid="tool-card"]`)
    .length >= 3, paneSel(tab), { timeout: 30000 });
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'plain MP15 after reopen');
  const sent = captures(ctx.proxyA, M('a15'), since)[0]?.body;
  const users = (sent?.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content));
  record('MP-15 after restarting Mori and reopening the session, the hidden work stays hidden: the next request has '
    + 'the new model\'s work but not the first model\'s tool calls, and the steer keeps the redo note',
  same(rolesOf(sent), ['system', 'user', 'user', 'assistant', 'tool', 'assistant', 'user'])
    && saved.callIds.every((id) => !JSON.stringify(sent).includes(id))
    && users[1]?.endsWith(noteOf(R('a15'), "can't connect")) && !users[0]?.includes(NOTE_HEAD)
    && state.switches.length === 1 && state.switches[0].hidden && state.tools === 3,
  brief({ roles: rolesOf(sent), switches: state.switches, tools: state.tools }));
}

// ---------- MP-20：候选耗尽 ----------

/** @brief MP-20：只剩不会恢复的原因时不等（说明卡、没有错误卡）；全部不可用但会恢复时先等并显示原因，恢复后继续。 */
async function exhaustion(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'p20');
  const since = Date.now();
  const first = await sendWait(ctx, tab, 'plain MP20 first');
  const firstStages = (await stagesOf(page, tab, since)).map((item) => item.v);
  record('MP-20 the only candidate failed in this reply (tried, does not recover within the reply): no waiting, '
    + 'one "No model available" card listing it, no error card',
  first.unavailable.length === 1 && first.unavailable[0].candidates[0]?.ref === R('p20') && first.errors.length === 0
    && !firstStages.some((value) => value.startsWith('wait-model')) && Date.now() - since < 10000,
  brief({ first: first.unavailable, stages: firstStages }));
  const later = Date.now();
  await send(ctx, tab, 'plain MP20 second');
  const waited = await waitStageKind(page, tab, 'wait-model', 10000);
  const stage = (await paneState(page, tab)).stage;
  await waitTabIdle(page, tab, 60000);
  const second = await paneState(page, tab);
  record('MP-20 every candidate unavailable but recovering: the reply waits with "Waiting for a model · rate limited '
    + 'until hh:mm:ss · Ns" and continues once the key recovers',
  waited && new RegExp(`^Waiting for a model · rate limited until ${CLOCK} · \\d+s$`).test(stage ?? '')
    && chatLogs(ctx, M('p20'), later).map((line) => line.status).join() === '200'
    && second.assistants.at(-1)?.includes(PLAIN) && second.unavailable.length === 1 && second.errors.length === 0,
  brief({ stage, lines: lineBrief(chatLogs(ctx, M('p20'), later), later) }));
}

/** @brief MP-20：段开始时只剩不会恢复的原因（API key rejected）：不等，消息撤回、文字放回输入框，一张说明卡。 */
async function noWaitAtStart(ctx) {
  const { page } = ctx;
  const tab = await sessionWith(ctx, 'n20');
  await sendWait(ctx, tab, 'plain MP20 rejected first');
  const since = Date.now();
  const state = await sendWait(ctx, tab, 'plain MP20 rejected second', 30000);
  const stages = (await stagesOf(page, tab, since)).map((item) => item.v);
  const gave = (await moriEvents(ctx, tab, 'mori.model_unavailable', since))[0];
  record('MP-20 at the start of a reply the only candidate has a reason that does not recover (API key rejected): '
    + 'no waiting; the message is withdrawn, its text goes back to the input box, one more "No model available" '
    + 'card with the reason, no error card and no request',
  gave?.data.firstRequest === true && gave.t - since < 5000 && !stages.some((value) => value.startsWith('wait-model'))
    && state.draft === 'plain MP20 rejected second' && !state.users.includes('plain MP20 rejected second')
    && state.unavailable.length === 2 && state.unavailable[1].candidates[0]?.reason === 'auth'
    && state.errors.length === 0 && chatLogs(ctx, M('n20'), since).length === 0,
  brief({ after: gave && gave.t - since, stages, draft: state.draft, users: state.users, cards: state.unavailable }));
}

/**
 * @brief MP-20：压缩时选不到模型：不等待，报压缩失败（No model available for compaction）。
 *        做法：会话的第一个候选 x20 窗口 20000（虚拟模型按它建，压缩阈值 20000 - 16384），一条长消息让用量超过阈值；
 *        回复生成中删掉 x20（正在用的模型），这一轮结束时 pi 的阈值压缩调 route()，剩下的 y20 在冷却中。
 */
async function compactionNoModel(ctx) {
  const { page } = ctx;
  const helper = await sessionWith(ctx, 'y20');
  await sendWait(ctx, helper, 'plain MP20 cool y20');
  // 测试准备：默认范围暂时改成 g20c，新会话的虚拟模型按它的第一个候选（小窗口）注册（§11.1），建好后改回。
  await bridge(ctx, { type: 'models.setDefaults', normalDefault: 'g20c', allowedZones: ['local', 'intranet'] });
  const tab = await newSession(ctx);
  await bridge(ctx, { type: 'models.setDefaults', normalDefault: 'okd', allowedZones: ['local', 'intranet'] });
  const since = Date.now();
  const text = `plain MP20 compaction ${'filler words for the context usage '.repeat(500)}`;
  await send(ctx, tab, text);
  await waitLine(ctx, M('x20'), since);
  const deleted = await bridge(ctx, { type: 'models.deleteProvider', id: 'x20', dryRun: false });
  await waitTabIdle(page, tab, 60000);
  const state = await paneState(page, tab);
  const stages = (await stagesOf(page, tab, since)).map((item) => item.v);
  const sid = (await eventsOf(page, null, since)).find((item) => item.type === 'message_start' && item.role === 'user'
    && item.text.startsWith('plain MP20 compaction'))?.sid;
  const ends = (await eventsOf(page, sid ?? '__none__', since)).filter((item) => item.type.startsWith('compaction'));
  record('MP-20 no model available when compacting (the current model was removed, the other candidate is cooling '
    + 'down): no waiting, the compaction fails with "No model available for compaction: <candidates>" on the v0 '
    + 'error card', deleted.error === null && state.errors.some((item) => item.includes('No model available for '
    + 'compaction') && item.includes(R('y20'))) && !stages.some((value) => value.startsWith('wait-model'))
    && chatLogs(ctx, M('y20'), since).length === 0,
  brief({ errors: state.errors, stages, ends, lines: lineBrief(chatLogs(ctx, M('x20'), since), since) }));
}

// ---------- 长时间的情形（同时进行）：MP-17 等它停下时停止、MP-18、MP-19 排队超时、MP-20 等不到 ----------

/** 同时进行的会话：标识、范围、消息 */
const LONG = [
  { key: 'p20x', pick: 'p20x', pre: 'plain MP20 give up first', text: 'plain MP20 give up second' },
  { key: 'qt19x', pick: 'qt19', text: 'wait 75s MP19 timeout holder', waitLine: 'qt19' },
  { key: 'qt19y', pick: 'gqt19', text: 'plain MP19 queue timeout' },
  { key: 't18h', pick: 'gt18h', text: 'plain MP18 true hang' },
  { key: 't18s', pick: 'gt18s', text: 'plain MP18 true stall' },
  { key: 'f18h', pick: 'gf18h', text: 'plain MP18 false hang' },
  { key: 'f18s', pick: 'gf18s', text: 'plain MP18 false stall' },
  { key: 'u18h', pick: 'gu18h', text: 'plain MP18 unknown hang' },
  { key: 'u18s', pick: 'gu18s', text: 'plain MP18 unknown stall' },
  { key: 's18', pick: 's18', text: 'plain MP18 single unknown' },
  { key: 'h17', pick: 'gh17', text: 'plain MP17 stop while held' },
];

/** @brief 开始全部长时间的会话（最后一个 h17 留在前台，等它停下时要点停止）。 */
async function startLong(ctx) {
  const runs = {};
  for (const item of LONG) {
    const tab = await sessionWith(ctx, item.pick);
    if (item.pre) await sendWait(ctx, tab, item.pre);
    const sentAt = Date.now();
    await send(ctx, tab, item.text);
    await waitTabBusy(ctx.page, tab);
    if (item.waitLine) await waitLine(ctx, M(item.waitLine), sentAt);
    runs[item.key] = { tab, sentAt };
  }
  return runs;
}

/** @brief 结果未知的一个会话：换模型事件、阶段行、提示、请求数。 */
async function unknownOutcome(ctx, run, id) {
  const switches = await moriEvents(ctx, run.tab, 'mori.model_switch', run.sentAt);
  const stages = (await stagesOf(ctx.page, run.tab, run.sentAt)).map((item) => item.v);
  const state = await paneState(ctx.page, run.tab);
  return { after: switches[0] ? Math.round((switches[0].t - run.sentAt) / 1000) : null, event: switches[0]?.data,
    held: stages.filter((value) => value.startsWith('held|')), state, lines: chatLogs(ctx, M(id), run.sentAt).length,
    backup: OPTS[`${id}bk`] ? chatLogs(ctx, M(`${id}bk`), run.sentAt).length : 0 };
}

/** @brief MP-18：cancel_verified 为 true 时超时后立即换；为 false 时读指标确认停下后换；unknown 时等满 2 分钟再换。 */
async function checkUnknown(ctx, runs) {
  const heldText = (id) => new RegExp(`^held\\|Waiting to make sure ${R(id)} stopped · until ${CLOCK}$`);
  const common = (r) => r.event?.reason === 'timeout' && r.lines === 1 && r.backup === 1 && r.state.errors.length === 0
    && r.state.switches.length === 1 && r.state.assistants.at(-1)?.includes(PLAIN);
  for (const [id, kind] of [['t18h', '-hang'], ['t18s', '-stall']]) {
    const r = await unknownOutcome(ctx, runs[id], id);
    record(`MP-18 ${kind} with cancel_verified true: after the 120 s first-content limit the reply switches model at `
      + 'once (no waiting to make sure it stopped), the fake endpoint gets no second copy of the request',
    common(r) && r.after >= 115 && r.after <= 135 && r.held.length === 0 && !r.event.unconfirmed
      && !r.state.switches[0].text.includes("couldn't confirm"), brief(r));
  }
  for (const [id, kind] of [['f18h', '-hang-nocancel'], ['f18s', '-stall-nocancel']]) {
    const r = await unknownOutcome(ctx, runs[id], id);
    record(`MP-18 ${kind} with cancel_verified false: after the timeout the stage line shows "Waiting to make sure `
      + '<model> stopped · until hh:mm:ss", Mori reads the server metrics and switches once they are back to the '
      + 'baseline (well before 2 min), without "couldn\'t confirm"',
    common(r) && r.held.length >= 1 && heldText(id).test(r.held[0]) && r.after >= 120 && r.after <= 160
      && !r.event.unconfirmed && !r.state.switches[0].text.includes("couldn't confirm"), brief(r));
  }
  for (const [id, kind] of [['u18h', '-hang'], ['u18s', '-stall']]) {
    const r = await unknownOutcome(ctx, runs[id], id);
    record(`MP-18 ${kind} with cancel_verified unknown (FAKE_NO_METRICS=1): the stage line shows waiting to make sure `
      + 'it stopped, after the full 2 min the reply switches model and continues; the notice says "couldn\'t confirm '
      + 'it stopped"; no second copy of the request reaches the fake endpoint',
    common(r) && r.held.length >= 1 && heldText(id).test(r.held[0]) && r.after >= 235 && r.event.unconfirmed
      && r.state.switches[0].text.includes("couldn't confirm it stopped"), brief(r));
  }
  const single = await unknownOutcome(ctx, runs.s18, 's18');
  record('MP-18 only one candidate (cancel_verified unknown): after the timeout and the full 2 min wait, one "No '
    + 'model available" card and no error card',
  single.lines === 1 && single.held.length >= 1 && single.state.unavailable.length === 1
    && single.state.errors.length === 0 && single.state.switches.length === 0, brief(single));
}

/** @brief MP-17：等它停下时按停止：已停止，不是错误卡，没有新的请求。 */
async function stopHeld(ctx, run) {
  const { page } = ctx;
  const shown = await waitStageKind(page, run.tab, 'held', 200000);
  const stage = (await paneState(page, run.tab)).stage;
  await stop(ctx, run.tab);
  await waitTabIdle(page, run.tab, 30000);
  await sleep(1500);
  const state = await paneState(page, run.tab);
  record('MP-17 Stop while "Waiting to make sure <model> stopped": "已停止", no error card, no model switch, and the '
    + 'fake endpoint receives no new request',
  shown && /^Waiting to make sure \S+ stopped · until/.test(stage ?? '') && state.stopped === 1
    && state.errors.length === 0 && state.switches.length === 0 && state.unavailable.length === 0
    && chatLogs(ctx, M('h17'), run.sentAt).length === 1 && chatLogs(ctx, M('h17bk'), run.sentAt).length === 0,
  brief({ stage, state }));
}

/** @brief MP-19：排队超过 60 秒换模型；MP-20：段开始时等不到，消息撤回、文字回到输入框、说明卡。 */
async function checkWaits(ctx, runs) {
  const y = runs.qt19y;
  const stages = (await stagesOf(ctx.page, y.tab, y.sentAt)).map((item) => item.v);
  const sw = (await moriEvents(ctx, y.tab, 'mori.model_switch', y.sentAt))[0];
  const state = await paneState(ctx.page, y.tab);
  record('MP-19 a conversation request queued longer than 60 s: switches model with "waited 60 s for a free slot"; '
    + 'the queued request is never sent to the busy provider',
  stages.includes('queue|Waiting for QT19') && sw?.data.reason === 'queue_timeout'
    && /waited 6\d s for a free slot/.test(state.switches[0]?.text ?? '') && sw.t - y.sentAt >= 59000
    && sw.t - y.sentAt <= 75000 && chatLogs(ctx, M('qt19'), runs.qt19x.sentAt).length === 1
    && chatLogs(ctx, M('qt19bk'), y.sentAt).length === 1 && state.errors.length === 0,
  brief({ stages, after: sw && sw.t - y.sentAt, switches: state.switches }));
  const g = runs.p20x;
  const gStages = (await stagesOf(ctx.page, g.tab, g.sentAt)).map((item) => item.v);
  const gave = (await moriEvents(ctx, g.tab, 'mori.model_unavailable', g.sentAt))[0];
  const gState = await paneState(ctx.page, g.tab);
  record('MP-20 at the start of a reply nothing recovers within 60 s: it waits with the reason on the stage line, '
    + 'then the message is withdrawn, its text goes back to the input box, one "No model available" card and no '
    + 'error card', gStages.some((value) => new RegExp(`^wait-model\\|Waiting for a model · rate limited until `
    + CLOCK).test(value)) && gave?.data.firstRequest === true && gave.data.text === 'plain MP20 give up second'
    && gave.t - g.sentAt >= 58000 && gave.t - g.sentAt <= 75000 && gState.draft === 'plain MP20 give up second'
    && !gState.users.includes('plain MP20 give up second') && gState.unavailable.length === 2
    && gState.errors.length === 0, brief({ stages: gStages, after: gave && gave.t - g.sentAt, draft: gState.draft,
    users: gState.users, cards: gState.unavailable.length, errors: gState.errors }));
}

/** @brief 长时间的情形：同时开始，h17 等它停下时按停止，其余等结束后逐个检查。 */
async function longBatch(ctx) {
  const runs = await startLong(ctx);
  await stopHeld(ctx, runs.h17);
  for (const item of LONG) await waitTabIdle(ctx.page, runs[item.key].tab, 330000);
  await checkWaits(ctx, runs);
  await checkUnknown(ctx, runs);
}

// ---------- 主流程 ----------

const steps = {
  longBatch, multiKey, firstKeyLimited, allKeysLimited, firstRequestFails, oneRetryLayer, serverRetry, noSwitchCases,
  stopQueued, stopWaitingModel, queueStage, probeAfterConversation, lowerConcurrency, removeKeyQueued, addKeyQueued,
  cooledByOther, slotsReleased, authHeaders, authKey, quotaKey, notFound, connectionFails, keylessLimited,
  deleteCurrent, compatChange, sticky, thirdNotPreferred, steerSameReply, overflowKeepsReply, redo15, union15,
  follow15, followTool15, compact15, exhaustion, noWaitAtStart, compactionNoModel, reopen15,
};

/** @brief 启动全部合成端点与记录代理，写配置，启动 Mori，加 key，打开项目。 */
async function setup(ctx) {
  for (const [port, env] of ENDPOINTS) ctx.endpoints[port] = await startEndpoint(port, env, ctx.logs);
  ctx.proxyA = await startProxy(PORT.proxyA, PORT.ok);
  ctx.proxyB = await startProxy(PORT.proxyB, PORT.ok);
  ctx.proxyH = await startProxy(PORT.proxyH, PORT.ok);
  installRules(ctx);
  mkdirSync(join(ctx.userData, 'pi'), { recursive: true });
  // 测试准备（synthetic test setup）：配置、已验证的档案、pi 压缩只保留最近 1 个 token（短对话也有可压缩的内容）。
  seedUserData(ctx.userData, buildConfig(), cancels(), { compaction: { keepRecentTokens: 1 } });
  await startApp(ctx);
  await addKeys(ctx);
  ctx.home = await openFolder(ctx, ctx.project);
}

const ctx = { userData: mkdtempSync(join(tmpdir(), 'mori-v1-switch-data-')),
  project: prepareProject('mori-v1-switch-').project, project2: prepareProject('mori-v1-switch-compact-').project,
  logs: [], endpoints: {}, refs: {}, sids: {}, rules: {}, pageErrors: [] };
const wanted = only && only.includes('reopen15') && !only.includes('redo15') ? [...only, 'redo15'] : only;
try {
  await setup(ctx);
  const probesAtStart = ctx.logs.filter((line) => line.probe).length;
  record('setup: seeded profiles are used as they are (no probe requests at startup)', probesAtStart === 0,
    `probe requests=${probesAtStart}`);
  for (const [name, step] of Object.entries(steps)) {
    if (wanted && !wanted.includes(name)) continue;
    console.log(`[v1-models-app-switch] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: flow`, false, oneLine(error, 400));
      await shot(ctx.page, `${name}-error`);
      await ctx.page.keyboard.press('Escape').catch(() => {});
      await backToChat(ctx).catch(() => {});
      await ctx.page.locator(`${slotSelector('right')} [data-testid="close-pane"]`).click({ timeout: 2000 })
        .catch(() => {});
    }
  }
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  for (const child of Object.values(ctx.endpoints)) child.kill();
  for (const proxy of [ctx.proxyA, ctx.proxyB, ctx.proxyH]) proxy?.server.close();
}
console.log(`[v1-models-app-switch] project in ${ctx.project}; data in ${ctx.userData}`);
await sleep(200);
process.exitCode = write(`v1-models-app-switch${suffix}.json`) ? 0 : 1;
