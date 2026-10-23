// v1 模型层整机测试（配置、设置页、首次启动、迁移）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint，synthetic），逐条检查 docs/specs/model-providers.md §14.2 中 App 层的这些条目：
//   MP-01 配置读不出（不显示首次启动表单、Models 只显示错误与 Reload、会话 config_invalid、文件不被覆盖）、
//         各种校验错误指出位置（经 Reload）、由名称生成 id、删掉 key 后编号不复用；
//   MP-02 保存后模型在会话里可用、合成端点只收到真正的 key（从不收到占位的 mori-pool）、删除的提供商不能再用；
//   MP-06 公网提供商在没授权的项目里被排除、Project access 勾 Public 先确认（取消不写）、项目配置缩小区域与勾选框不可用、
//         项目配置不能放宽、项目路径大小写与分隔符不同仍按同一项目授权；
//   MP-07 项目配置的未知字段、坏 JSON、不存在的分组、不属于用户分组的项都让会话按 project_config 拒绝启动；
//   MP-10 加 key、删 key 也算修改提供商：未验证过的模型自动重新探测（错的 key 探测出错，换成对的 key 后不点 Verify 也通过）；
//   MP-08 从 v0 的 models.json 迁移（全部 provider、key 沿用原 ref、明文加密、密文优先、$ENV、不支持的接口、丢弃的兼容字段、
//         不合格的模型、改写的 id、默认范围、思考强度复制、区域建议、区域未确认时被排除、迁移后改 models.json 不生效、
//         Dismiss、迁移失败不写配置、迁移后这次启动停在 设置 → Models）；
//   MP-24 设置页的增删改立即写进配置并影响静态校验、确认框的连带改动、改地址删 key 且新端口收不到旧 key、分组的错误、
//         key 明文不回到界面、兼容选项的标签与说明；
//   MP-26 key 不落盘（数据目录的全部文件、迁移说明、日志、本测试的结果）、Add key 后 F8 报告里没有 key；
//   MP-30 删除的连带改动；
//   MP-33 首次启动（Local 与 Public 两种区域、Allow public、tool calling 判定失败的说明、改模型 id 再测仍只有一个提供商）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-app-settings.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/v1-models-app-settings(-packaged).json，截图在 test-results/v1-models-app-settings(-packaged)/。
// 合成端点用 4500–4519 之间的端口（与并行跑的其他测试错开）。
// 下面写进数据目录的 model-config.json、pi/models.json、pi/settings.json 和项目的 .mori/models.json 都是
// synthetic test setup（测试准备），代码里逐处注明。key 都是测试自己生成的合成值，与任何真实服务无关。

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import { activeFile, ctrlN, openRow, PANE, paneCount, stubFolder, waitPanes, waitReady } from './m3-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const RESULT = `v1-models-app-settings${suffix}`;
const shots = join(appRoot, 'test-results', RESULT);
mkdirSync(shots, { recursive: true });
const { results, record, write } = createRecorder(exePath ?? 'dev build');

/** 合成端点的端口（4500–4519） */
const PORT = { keyed: 4500, invalid: 4503, pub: 4504, seeded: 4505, moved: 4506, migrate: 4507, cascade: 4508,
  edits: 4509, reprobe: 4510 };
/** @brief 端口对应的 baseUrl。 */
const url = (port) => `http://127.0.0.1:${port}/v1`;

/** 测试用的合成 key（synthetic），末 4 位互不相同，合成端点的日志只记末 4 位 */
const KEY = {
  first: 'synthetic-v1-settings-key-first-K1A1',
  spare: 'synthetic-v1-settings-key-spare-K2B2',
  added: 'synthetic-v1-settings-key-added-K3C3',
  seedA: 'synthetic-v1-settings-key-seeda-K4D4',
  seedB: 'synthetic-v1-settings-key-seedb-K5E5',
  moved: 'synthetic-v1-settings-key-moved-K6F6',
  cascade: 'synthetic-v1-settings-key-cascade-K7G7',
  v0plain: 'synthetic-v1-settings-key-v0plain-K8H8',
  v0cipher: 'synthetic-v1-settings-key-v0cipher-K9I9',
  v0ignored: 'synthetic-v1-settings-key-v0ignored-K0J0',
  num1: 'synthetic-v1-settings-key-num1-N1N1',
  num2: 'synthetic-v1-settings-key-num2-N2N2',
  num3: 'synthetic-v1-settings-key-num3-N3N3',
  wrong: 'synthetic-v1-settings-key-wrong-W1R1',
  right: 'synthetic-v1-settings-key-right-R1G1',
};
const SECRETS = Object.values(KEY);
const last4 = (key) => key.slice(-4);
/** pi 里的占位 apiKey（§12）的末 4 位 */
const PLACEHOLDER_TAIL = last4('mori-pool');
/** 合成端点 "plain" 的回复 */
const REPLY = '这是一段只有文字的回复，用来测试流式输出。';
const TEXTAREA = '.pane-slot:not([hidden]) .composer textarea';
const CARD = '.pane-slot:not([hidden]) [data-testid="blocked-card"]';

/** 收集到的全部日志（每个 App 的 stdout/stderr 与界面 console），MP-26 检查里面没有 key */
const allLogs = [];
/** 每一步用过的数据目录（MP-26 最后再扫一遍） */
const dataDirs = [];
/** 合成端点 */
const fakes = {};

// ---------- 通用 ----------

/** @brief 反复读 read()，直到 test 通过或超时；返回是否通过和最后读到的值。 */
async function poll(read, test, timeout = 30000, step = 200) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!test(value) && Date.now() < deadline) {
    await sleep(step);
    value = await read();
  }
  return { ok: Boolean(test(value)), value };
}

/** @brief 读 JSON 文件；不存在或读不出时为 null。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const configFile = (dir) => join(dir, 'model-config.json');
const readConfig = (dir) => readJson(configFile(dir));
/** @brief 规范化项目路径（§4.1：全部小写、/ 分隔、无结尾 /）。 */
const norm = (path) => path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dataDirs.push(dir);
  return dir;
};

/** @brief 带 README 的临时项目；models 不为 undefined 时写项目配置 .mori/models.json（synthetic test setup）。 */
function makeProject(root, name, models) {
  const project = join(root, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nSynthetic project for the v1 model tests.\n');
  if (models !== undefined) {
    mkdirSync(join(project, '.mori'), { recursive: true });
    writeFileSync(join(project, '.mori', 'models.json'), typeof models === 'string' ? models : JSON.stringify(models));
  }
  return project;
}

/** @brief 配置里的一个提供商（synthetic test setup 用）；key 为空、模型按 ids。 */
function seedProvider(id, name, port, zone, ids = ['fake-coder']) {
  return { id, name, api: 'openai-completions', baseUrl: url(port), zone, compat: {}, concurrency: 4, keys: [],
    nextKeyNumber: 1, models: ids.map((model) => ({ id: model, family: '', contextWindow: 131072, maxTokens: 8192,
      reasoning: false, input: ['text'] })) };
}

/** @brief 一份完整的用户级配置（synthetic test setup 用）。 */
function seedConfig({ providers, groups = [], normalDefault = null, projectZones = {} }) {
  return { version: 1, providers, groups, normalDefault, allowedZones: ['local', 'intranet'], projectZones };
}

/** @brief 规格 §4.1 的"由名称生成 id"，测试按规格独立算一遍期望值。 */
function specId(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'provider';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base.slice(0, 40 - `-${n}`.length)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

// ---------- 合成端点 ----------

/** @brief 启动一个合成端点（synthetic），收集它每个对话请求的 JSON 日志行。 */
function startFake(port, env = {}) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '5', FAKE_FIRST_DELAY_MS: '20',
      FAKE_MODELS: 'fake-coder,fake-coder-b,fake-coder-notools', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fake = { child, port, chats: [] };
  let buffer = '';
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`fake endpoint ${port} did not start within 15 s`)), 15000);
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('{')) {
          try { fake.chats.push({ ...JSON.parse(line), at: Date.now() }); } catch { /* 不是日志行 */ }
        }
        if (line.includes('synthetic endpoint')) {
          clearTimeout(timer);
          done(fake);
        }
      }
    });
  });
}

/** @brief 不是探针的对话请求（since 之后）。 */
const chatsOf = (fake, since = 0) => fake.chats.filter((chat) => !chat.probe && chat.at >= since);

// ---------- App ----------

/** @brief 用 userData 启动 Mori，收集日志与页面报错，等到首次启动表单或三栏布局出现。 */
async function startApp(userData) {
  const app = await launch({ exePath, userData });
  const page = await app.firstWindow();
  const ctx = { app, page, userData, logs: [], pageErrors: [] };
  const keep = (text) => {
    ctx.logs.push(text);
    allLogs.push(text);
  };
  app.process().stdout?.on('data', (chunk) => keep(String(chunk)));
  app.process().stderr?.on('data', (chunk) => keep(String(chunk)));
  page.on('console', (message) => keep(message.text()));
  page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await page.waitForSelector('[data-testid="connection-form"], [data-testid="sidebar"]', { timeout: 60000 });
  return ctx;
}

/** @brief 关闭 Mori；记一条"页面没有报错"（名字以这一步的 MP 编号开头）。 */
async function closeApp(ctx, mp) {
  if (!ctx) return;
  record(`${mp} (${basenameOf(ctx.userData)}) the page reported no errors`, ctx.pageErrors.length === 0,
    ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app.close().catch(() => {});
  await sleep(500);
}
const basenameOf = (path) => path.split(/[\\/]/).pop();
const shot = (ctx, name) => ctx?.page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** @brief 打开设置页（左栏"设置"），等 Models 分节读好（或配置读不出的错误）。 */
async function openSettings(page) {
  if (!(await page.getByTestId('settings-page').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  await page.waitForSelector('[data-testid="models-section"], [data-testid="models-load-error"]', { timeout: 20000 });
}

/** @brief 设置页"返回会话"。 */
async function backToChat(page) {
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 5000 });
}

/** @brief 选文件夹对话框直接返回 folder，点"Open folder…"或"打开文件夹…"，等新会话就绪（问信任时选信任）。 */
async function openFolder(ctx, folder) {
  const { page } = ctx;
  const before = await paneCount(page);
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: 'Open folder…', exact: true }).first().click();
  await waitPanes(page, before + 1);
  const trust = page.getByTestId('trust-dialog');
  if (await trust.waitFor({ timeout: 1500 }).then(() => true, () => false)) {
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  }
  await waitReady(page);
  return activeFile(page);
}

/** @brief 当前一栏的拒绝启动卡：kind、主文字、全文、按钮与候选；没有卡时为 null。 */
function cardState(page) {
  return page.evaluate((selector) => {
    const card = document.querySelector(selector);
    if (!card) return null;
    return { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? '',
      text: card.textContent ?? '',
      actions: [...card.querySelectorAll('button[data-action]')].map((b) => ({ action: b.dataset.action,
        label: b.textContent })),
      candidates: [...card.querySelectorAll('[data-testid="candidate"]')].map((c) => ({ ref: c.dataset.ref,
        reason: c.dataset.reason, text: c.textContent })) };
  }, CARD);
}
const waitCard = (page, test, timeout = 60000) => poll(() => cardState(page), test, timeout, 250);
const cardText = (state) => (state ? `${state.kind}: ${state.title} [${state.actions.map((a) => a.label)
  .join(', ')}] ${state.candidates.map((c) => `${c.ref}=${c.reason}`).join(', ')}` : 'no card');

/** @brief 发一条消息，等助手回复出现且本轮结束（或出现错误卡）；返回最后一条回复。 */
async function sendText(ctx, text) {
  const { page } = ctx;
  const read = () => page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const list = pane?.querySelectorAll('[data-testid="assistant"]') ?? [];
    return { count: list.length, idle: pane?.dataset.running === 'false' && pane?.dataset.sending === 'false',
      text: list[list.length - 1]?.textContent ?? '',
      error: pane?.querySelector('[data-testid="error-card"], [data-testid="unavailable-card"]')?.textContent ?? null };
  }, PANE);
  const before = (await read()).count;
  await page.locator(TEXTAREA).fill(text);
  await page.locator(TEXTAREA).press('Enter');
  return (await poll(read, (s) => (s.count > before && s.idle) || s.error, 90000, 250)).value;
}

/** @brief 被拒绝启动时试着发送：发送按钮是否不可用、Enter 后草稿是否还在、对话流和合成端点有没有新东西。 */
async function trySend(ctx, fake, text) {
  const { page } = ctx;
  const since = Date.now();
  const users = await page.locator(`${PANE} [data-testid="user-message"]`).count();
  await page.locator(TEXTAREA).fill(text);
  const disabled = await page.locator(`${PANE} .send-button`).isDisabled();
  await page.locator(TEXTAREA).press('Enter');
  await sleep(1500);
  const kept = (await page.locator(TEXTAREA).inputValue()) === text;
  const added = (await page.locator(`${PANE} [data-testid="user-message"]`).count()) - users;
  await page.locator(TEXTAREA).fill('');
  return { disabled, kept, added, requests: chatsOf(fake, since).length };
}

/** @brief 在当前一栏输入框下面一行的范围菜单里选 pick，等按钮的 data-pick 变过去。 */
async function choosePick(page, pick) {
  const button = page.locator(`${PANE} [data-testid="model-button"]`);
  await button.click();
  await page.locator(`[data-testid="model-menu"] [role="menuitemradio"][data-pick="${pick}"]`).click();
  return poll(() => button.getAttribute('data-pick'), (value) => value === pick, 10000);
}

/** @brief 范围菜单的全部项（data-pick），看完按 Esc 关上。 */
async function menuPicks(page) {
  await page.locator(`${PANE} [data-testid="model-button"]`).click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  const picks = await page.locator('[data-testid="model-menu"] [role="menuitemradio"]')
    .evaluateAll((items) => items.map((item) => item.dataset.pick));
  await page.keyboard.press('Escape');
  return picks;
}

const providerCard = (page, id) => page.locator(`[data-testid="provider-card"][data-provider="${id}"]`);
const modelRow = (page, ref) => page.locator(`[data-testid="model-row"][data-model="${ref}"]`);
const dialogOf = (page, kind) => page.locator(`[data-testid="confirm-dialog"][data-kind="${kind}"]`);

/** @brief 对话框的标题、全文和连带改动列表。 */
function dialogInfo(dialog) {
  return dialog.evaluate((box) => ({ title: box.querySelector('h2')?.textContent ?? '', text: box.textContent ?? '',
    cascade: [...box.querySelectorAll('[data-testid="cascade"] li')].map((li) => li.textContent) }));
}

/** @brief 模型行的 Tool calling 状态（data-value）。 */
const toolCalling = (page, ref) => modelRow(page, ref).locator('[data-field="tool_calling"]').getAttribute('data-value')
  .catch(() => null);
const waitVerified = (page, ref, timeout = 60000) => poll(() => toolCalling(page, ref), (v) => v === 'verified',
  timeout, 300);

/** @brief 设置页里新建提供商（Add provider 表单）。 */
async function addProvider(page, { name, baseUrl, modelId = 'fake-coder', secret = '', zone = null }) {
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  if (zone) await form.locator(`input[name="zone"][value="${zone}"]`).check();
  if (secret) await form.getByLabel('API key', { exact: true }).fill(secret);
  await form.getByLabel('Model ID', { exact: true }).fill(modelId);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 20000 });
}

/** @brief 在提供商卡上 Add key（label 为空时用默认的 "Key <n>"）。 */
async function addKey(page, providerId, secret, label = null) {
  const card = providerCard(page, providerId);
  await card.locator('[data-action="add-key"]').click();
  const form = card.getByTestId('key-form');
  if (label) await form.getByLabel('Label').fill(label);
  await form.getByLabel('Secret').fill(secret);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
}

/** @brief 等配置文件满足 test。 */
const waitConfig = (dir, test, timeout = 15000) => poll(() => readConfig(dir), (cfg) => cfg && test(cfg), timeout);
const providerOf = (cfg, id) => cfg?.providers?.find((item) => item.id === id);
const keyRefs = (cfg, id) => providerOf(cfg, id)?.keys.map((key) => key.ref) ?? null;

/** @brief 首次启动表单：填写，返回预选的区域。 */
async function fillFirstRun(page, { name, baseUrl, secret, modelId }) {
  const form = page.getByTestId('connection-form');
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  if (secret) await form.getByLabel('API key', { exact: true }).fill(secret);
  await form.getByLabel('Model ID', { exact: true }).fill(modelId);
  return form.locator('input[name="zone"]:checked').getAttribute('value');
}

/** @brief 点 Test connection，等结果文字（Connected / Connection failed / Couldn’t save）。 */
async function testConnection(page) {
  const before = await page.getByTestId('form-message').textContent().catch(() => null);
  await page.locator('[data-testid="connection-form"] [data-action="test"]').click();
  const result = await poll(() => page.getByTestId('form-message').textContent().catch(() => null),
    (text) => text && text !== before
      && /^(Connected|Connection failed|Couldn’t test|Couldn’t save|Test cancelled)/.test(text), 90000);
  return result.value ?? '';
}

/** @brief 首次启动表单下方的探针状态：依次见过的状态，直到 final 之一。 */
async function probeStates(page, final, timeout = 90000) {
  const seen = [];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="probe-status"]');
      return el ? { state: el.dataset.state, text: el.textContent } : null;
    });
    if (state && seen.at(-1)?.state !== state.state) seen.push(state);
    if (state && final.includes(state.state)) break;
    await sleep(50);
  }
  return seen;
}

/** @brief 等 credentials.json 里没有 ref（主进程删密文可能晚于配置写入），最多 5 秒；value 是最后读到的全部 ref。 */
const credsWithout = (dir, ref) => poll(() => Object.keys(readJson(join(dir, 'credentials.json')) ?? {}),
  (refs) => !refs.includes(ref), 5000);

/** @brief 文件夹下的全部文件（递归）。 */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    try {
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    } catch {
      return [];
    }
  });
}

/** @brief 文件夹里含任何 key 明文（UTF-8 或 UTF-16）的文件；skip 里的文件不看。 */
function filesWithSecrets(dir, skip = []) {
  const hits = [];
  for (const file of filesUnder(dir)) {
    if (skip.some((item) => resolve(item).toLowerCase() === resolve(file).toLowerCase())) continue;
    let data;
    try {
      if (statSync(file).size > 64 * 1024 * 1024) continue;
      data = readFileSync(file);
    } catch {
      continue;
    }
    const found = SECRETS.filter((secret) => data.includes(Buffer.from(secret, 'utf8'))
      || data.includes(Buffer.from(secret, 'utf16le')));
    if (found.length) hits.push(`${file} (${found.map(last4).join(',')})`);
  }
  return hits;
}

/** @brief 文字里出现的 key 明文（末 4 位）。 */
const secretsIn = (text) => SECRETS.filter((secret) => text.includes(secret)).map(last4);

// ---------- MP-01：配置读不出、校验位置、生成 id、key 编号 ----------

/** 校验错误的几种写法：名称、改动、期望在错误文字里出现的位置与说明 */
const VARIANTS = [
  ['unknown field', (c) => { c.providers[0].extra = 1; }, ['providers.0', 'extra']],
  ['duplicate provider id', (c) => { c.providers.push(structuredClone(c.providers[0])); },
    ['providers.1.id', 'already used']],
  ['group id equal to a provider id', (c) => { c.groups.push({ id: 'alpha', members: ['alpha/fake-coder'] }); },
    ['groups.1.id', 'already used']],
  ['reserved id mori', (c) => { c.providers[0].id = 'mori'; c.groups = []; c.normalDefault = null; },
    ['providers.0.id', 'mori is reserved']],
  ['pi built-in id openai', (c) => { c.providers[0].id = 'openai'; c.groups = []; c.normalDefault = null; },
    ['providers.0.id', 'openai is reserved']],
  ['maxTokens not smaller than contextWindow', (c) => { c.providers[0].models[0].maxTokens = 131072; },
    ['providers.0.models.0.maxTokens']],
  ['allowedZones containing public', (c) => { c.allowedZones.push('public'); }, ['allowedZones.2']],
  ['default range naming a missing model', (c) => { c.normalDefault = 'ghost/model'; },
    ['normalDefault', 'ghost/model is not in your model settings']],
  ['group member naming a missing provider', (c) => { c.groups[0].members.push('ghost'); },
    ['groups.0.members.1', 'ghost']],
  ['nextKeyNumber going back', (c) => { c.providers[0].keys = [{ ref: 'alpha#3', label: 'Key 3' }]; },
    ['providers.0.nextKeyNumber']],
];

/** @brief MP-01 的合法配置：一个没有 key 的本机提供商 alpha 和分组 team（synthetic test setup）。 */
const invalidBase = () => seedConfig({ providers: [seedProvider('alpha', 'Alpha', PORT.invalid, 'local')],
  groups: [{ id: 'team', members: ['alpha'] }], normalDefault: 'alpha/fake-coder' });

/** @brief 配置读不出时的整窗、Models 分节、会话与文件。 */
async function configInvalid() {
  const userData = tempDir('mori-v1s-invalid-');
  const root = tempDir('mori-v1s-invalid-proj-');
  const project = makeProject(root, 'proj');
  const file = configFile(userData);
  const broken = '{ "version": 1, "providers": [ '; // synthetic test setup：不是合法 JSON
  writeFileSync(file, broken);
  let ctx;
  try {
    ctx = await startApp(userData);
    await invalidStart(ctx, file, project);
    record('MP-01 config can\'t be read: model-config.json is not overwritten (bytes unchanged, no migration notice)',
      readText(file) === broken && !existsSync(join(userData, 'model-migration.json')), oneLine(readText(file)));
    await invalidVariants(ctx, file);
    await invalidFixed(ctx, file);
    await keyNumbers(ctx);
    await idsFromNames(ctx);
  } catch (error) {
    record('MP-01 configInvalid: flow', false, oneLine(error, 400));
    await shot(ctx, 'configInvalid-error');
  } finally {
    await closeApp(ctx, 'MP-01');
  }
}

/** @brief 启动后：没有首次启动表单；Models 只有错误与 Reload；会话 config_invalid、不能发送。 */
async function invalidStart(ctx, file, project) {
  const { page } = ctx;
  record('MP-01 config can\'t be read: no first-run form; the main window opens',
    await page.getByTestId('connection-form').count() === 0 && await page.getByTestId('sidebar').isVisible());
  await openSettings(page);
  const view = await page.evaluate(() => ({
    error: document.querySelector('[data-testid="models-load-error"]')?.textContent ?? null,
    reload: Boolean(document.querySelector('[data-testid="models-load-error"] [data-action="reload"]')),
    sections: ['defaults', 'providers', 'groups', 'project-access', 'migration-notice']
      .filter((id) => document.querySelector(`[data-testid="${id}"]`)) }));
  record('MP-01 config can\'t be read: Settings → Models shows only "Couldn’t read model settings: <path>: <raw>" '
    + 'and Retry', Boolean(view.error?.startsWith(`Couldn’t read model settings: ${file}: `)) && view.reload
    && view.sections.length === 0, oneLine(JSON.stringify(view)));
  await shot(ctx, 'mp01-load-error');
  await backToChat(page);
  await openFolder(ctx, project);
  const card = (await waitCard(page, (s) => s?.kind === 'config_invalid', 20000)).value;
  record('MP-01 config can\'t be read: the session is blocked config_invalid ("Model settings can’t be read: '
    + '<path>: <raw>"), with only Open settings', card?.kind === 'config_invalid'
    && card.title.startsWith(`Model settings can’t be read: ${file}: `)
    && card.actions.map((a) => a.action).join() === 'open-settings', cardText(card));
  const attempt = await trySend(ctx, fakes.invalid, 'plain while blocked');
  record('MP-01 config can\'t be read: Send is unavailable, Enter keeps the draft, nothing is sent',
    attempt.disabled && attempt.kept && attempt.added === 0 && attempt.requests === 0, JSON.stringify(attempt));
}

/** @brief 各种校验错误：写进文件后点 Reload，错误文字指出位置。 */
async function invalidVariants(ctx, file) {
  const { page } = ctx;
  await openSettings(page);
  for (const [name, change, expected] of VARIANTS) {
    const config = invalidBase();
    change(config);
    writeJson(file, config); // synthetic test setup：手工写坏的配置
    await page.locator('[data-testid="models-load-error"] [data-action="reload"]').click();
    const shown = await poll(() => page.getByTestId('models-load-error').textContent().catch(() => ''),
      (text) => expected.every((part) => text.includes(part)), 8000);
    record(`MP-01 validation: ${name} is reported with its location (${expected[0]}) after Reload`,
      shown.ok && shown.value.includes(`${file}: `), oneLine(shown.value, 300));
  }
}

/** @brief 修好文件后 Reload：完整的分节出现；会话不再是 config_invalid，能发送。 */
async function invalidFixed(ctx, file) {
  const { page } = ctx;
  writeJson(file, invalidBase()); // synthetic test setup：修好的配置
  await page.locator('[data-testid="models-load-error"] [data-action="reload"]').click();
  const full = await poll(() => page.evaluate(() => ['defaults', 'providers', 'groups', 'project-access']
    .every((id) => document.querySelector(`[data-testid="${id}"]`))
    && !document.querySelector('[data-testid="models-load-error"]')), Boolean, 10000);
  record('MP-01 after fixing the file, Reload shows the full Models sections',
    full.ok && await providerCard(page, 'alpha').count() === 1);
  await backToChat(page);
  // 会话是在配置读不出时建的，当时没有默认范围可记（§5.1），所以修好之后是 no_pick；选一个范围后可以发送。
  const unblocked = await waitCard(page, (s) => s?.kind !== 'config_invalid', 15000);
  await choosePick(page, 'alpha/fake-coder');
  const card = await waitCard(page, (s) => s === null, 60000);
  const reply = card.ok ? await sendText(ctx, 'plain after reload') : null;
  record('MP-01 after Reload with a valid file the session is no longer config_invalid (no range recorded → no_pick); '
    + 'after picking a range it sends', unblocked.ok && unblocked.value?.kind === 'no_pick' && card.ok
    && reply?.text.includes(REPLY),
  `${cardText(unblocked.value)} → ${cardText(card.value)} | ${oneLine(reply?.text ?? '')}`);
}

/** @brief 删掉 key 后新 key 的编号不复用：alpha#1、alpha#2，删 alpha#2，再加是 alpha#3。 */
async function keyNumbers(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await addKey(page, 'alpha', KEY.num1);
  await addKey(page, 'alpha', KEY.num2);
  const two = await waitConfig(userData, (cfg) => keyRefs(cfg, 'alpha')?.length === 2);
  await providerCard(page, 'alpha').locator('[data-testid="key-row"][data-ref="alpha#2"] [data-action="key-remove"]')
    .click();
  await waitConfig(userData, (cfg) => keyRefs(cfg, 'alpha')?.length === 1);
  await addKey(page, 'alpha', KEY.num3);
  const after = await waitConfig(userData, (cfg) => keyRefs(cfg, 'alpha')?.length === 2
    && keyRefs(cfg, 'alpha')[1] !== 'alpha#2');
  const refs = keyRefs(after.value, 'alpha');
  record('MP-01 a removed key\'s number is not reused (alpha#1, alpha#2 → remove alpha#2 → new key is alpha#3)',
    two.ok && JSON.stringify(refs) === '["alpha#1","alpha#3"]' && providerOf(after.value, 'alpha').nextKeyNumber === 4,
    `${JSON.stringify(keyRefs(two.value, 'alpha'))} → ${JSON.stringify(refs)}`);
}

/** @brief 由名称生成 id（大小写、非字母数字、截断、与保留 id 或已有 id 冲突加 -2）。 */
async function idsFromNames(ctx) {
  const { page, userData } = ctx;
  const info = await page.evaluate(() => window.mori.request({ type: 'models.get' }));
  const builtin = info.reserved.includes('openai') ? 'openai' : info.reserved.find((id) => id !== 'mori');
  const long = 'An Extremely Long Provider Name For Testing Generated Ids';
  const names = ['My Server!!', 'My Server', builtin === 'openai' ? 'OpenAI' : builtin, 'Mori', '模型服务', 'Team',
    long, long];
  const labels = ['case and punctuation', 'same as an existing id', 'pi built-in (reserved) id',
    'reserved id mori', 'no letters or digits', 'same as a group id', 'longer than 40 characters',
    'long and taken (suffix shortens the front)'];
  for (const [index, name] of names.entries()) {
    const before = readConfig(userData);
    const taken = new Set([...info.reserved, ...before.providers.map((p) => p.id), ...before.groups.map((g) => g.id)]);
    const expected = specId(name, taken);
    await addProvider(page, { name, baseUrl: url(PORT.invalid) });
    const after = await waitConfig(userData, (cfg) => cfg.providers.length === before.providers.length + 1);
    const added = after.value?.providers.find((p) => !before.providers.some((old) => old.id === p.id));
    record(`MP-01 id from name (${labels[index]}): "${name}" → ${expected}`,
      added?.id === expected && added.id.length <= 40 && added.name === name, `got ${added?.id ?? 'nothing'}`);
  }
}

// ---------- MP-33、MP-02、MP-26：首次启动（Local） ----------

/** @brief 首次启动（Local）→ 测试连接 → 探针 → 打开文件夹 → 发送；占位 key；删除的提供商；F8；key 不落盘。 */
async function firstRunLocal() {
  const userData = tempDir('mori-v1s-local-');
  const project = makeProject(tempDir('mori-v1s-local-proj-'), 'proj');
  let ctx;
  try {
    ctx = await startApp(userData);
    await localForm(ctx);
    await localSession(ctx, project);
    await deletedProvider(ctx);
    await f8AfterAddKey(ctx);
  } catch (error) {
    record('MP-33 firstRunLocal: flow', false, oneLine(error, 400));
    await shot(ctx, 'firstRunLocal-error');
  } finally {
    await closeApp(ctx, 'MP-33');
  }
  const hits = filesWithSecrets(userData);
  const sessions = filesUnder(join(userData, 'pi')).filter((file) => file.endsWith('.jsonl'));
  const scanned = ['model-config.json', 'model-profiles.json', 'credentials.json'].filter((name) => existsSync(join(
    userData, name)));
  record('MP-26 no plaintext key in model-config.json, model-profiles.json, credentials.json, session files or any '
    + 'other file in the data dir (first run, Add key, F8)', hits.length === 0 && sessions.length > 0
    && scanned.length === 3,
  `${hits.join('; ')} | scanned ${scanned.join(',')} and ${sessions.length} session file(s)`);
  const logs = ctx?.logs.join('\n') ?? '';
  record('MP-26 no plaintext key in the app\'s stdout/stderr and the page console (first run context)',
    secretsIn(logs).length === 0 && logs.length > 0, `${logs.length} chars; found ${secretsIn(logs).join(',')}`);
}

/** @brief 填首次启动表单（区域按 127.0.0.1 预选 Local），测试连接，等探针。 */
async function localForm(ctx) {
  const { page, userData } = ctx;
  const title = await page.locator('h2').first().textContent();
  const zone = await fillFirstRun(page, { name: 'Fake Local', baseUrl: url(PORT.keyed), secret: KEY.first,
    modelId: 'fake-coder' });
  record('MP-33 first run (Local): the form "Connect a model" preselects Network zone Local for 127.0.0.1',
    title === 'Connect a model' && zone === 'local', `${title} · ${zone}`);
  const message = await testConnection(page);
  record('MP-33 first run (Local): Test connection saves and reports "Connected · First token Nms · Total Nms"',
    /^Connected · First token \d+ms · Total \d+ms/.test(message), message);
  const seen = await probeStates(page, ['verified', 'failed', 'error']);
  record('MP-33 first run (Local): the probe status under the form ends at "Tool calling verified"',
    seen.at(-1)?.state === 'verified' && seen.at(-1)?.text === 'Tool calling verified',
    seen.map((s) => `${s.state}: ${s.text}`).join(' → '));
  const cfg = readConfig(userData);
  const provider = cfg?.providers?.[0];
  record('MP-33 first run (Local): model-config.json has the provider (zone local), its model, key ref <id>#1 and '
    + 'normalDefault', cfg?.providers.length === 1 && provider.id === 'fake-local' && provider.zone === 'local'
    && JSON.stringify(provider.keys) === '[{"ref":"fake-local#1","label":"Key 1"}]'
    && cfg.normalDefault === 'fake-local/fake-coder', oneLine(JSON.stringify(cfg), 300));
  const creds = readJson(join(userData, 'credentials.json')) ?? {};
  record('MP-26 credentials.json keeps the key only as ciphertext under its ref; model-config.json has { ref, label }',
    Object.keys(creds).includes('fake-local#1') && Object.values(creds).every((v) => /^[A-Za-z0-9+/]+=*$/.test(v))
    && secretsIn(JSON.stringify(creds) + JSON.stringify(cfg)).length === 0, Object.keys(creds).join(','));
}

/** @brief 打开文件夹、发送；合成端点只见过真正的 key。 */
async function localSession(ctx, project) {
  const { page, userData } = ctx;
  await openFolder(ctx, project);
  const card = await waitCard(page, (s) => s === null, 30000);
  const reply = await sendText(ctx, 'plain first message');
  record('MP-33 first run (Local): Open folder… opens a session that is not blocked, and it sends and gets the reply',
    card.ok && reply.text.includes(REPLY), `${cardText(card.value)} | ${oneLine(reply.text)}`);
  const sent = chatsOf(fakes.keyed).filter((chat) => chat.model === 'fake-coder');
  record('MP-02 after the save pi finds the provider and model: the session\'s request reached the endpoint as '
    + 'fake-coder', sent.length > 0 && reply.text.includes(REPLY), `${sent.length} request(s)`);
  const tails = [...new Set(fakes.keyed.chats.map((chat) => chat.key))];
  record(`MP-02 pi only has the placeholder key: every request (probes, test, session) carried the saved key `
    + `(…${last4(KEY.first)}), none carried mori-pool`, fakes.keyed.chats.length > 0
    && tails.every((tail) => tail === last4(KEY.first)) && !tails.includes(PLACEHOLDER_TAIL), tails.join(','));
  record('MP-02 pi\'s own models.json is not written (pi gets the providers from Mori at run time)',
    !existsSync(join(userData, 'pi', 'models.json')));
}

/** @brief 设置页加第二个提供商并在会话里用它；删除后会话 pick_missing、菜单里没有它、不再收到它的 key。 */
async function deletedProvider(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await addProvider(page, { name: 'Spare', baseUrl: url(PORT.keyed), secret: KEY.spare });
  const verified = await waitVerified(page, 'spare/fake-coder');
  await backToChat(page);
  await choosePick(page, 'spare');
  await waitCard(page, (s) => s === null, 30000);
  const since = Date.now();
  const reply = await sendText(ctx, 'plain via spare');
  const used = chatsOf(fakes.keyed, since).map((chat) => chat.key);
  record('MP-02 a provider added in Settings is compiled to pi: picking it sends with its own key '
    + `(…${last4(KEY.spare)})`,
    verified.ok && reply.text.includes(REPLY) && used.length > 0 && used.every((k) => k === last4(KEY.spare)),
    used.join(','));
  await openSettings(page);
  await providerCard(page, 'spare').locator('[data-action="delete-provider"]').click();
  await dialogOf(page, 'delete-provider').getByRole('button', { name: 'Delete', exact: true }).click();
  const gone = await waitConfig(userData, (cfg) => !providerOf(cfg, 'spare'));
  await backToChat(page);
  const card = (await waitCard(page, (s) => s?.kind === 'pick_missing', 15000)).value;
  const picks = await menuPicks(page);
  const after = Date.now();
  const attempt = await trySend(ctx, fakes.keyed, 'plain after delete');
  record('MP-02 a deleted provider is removed: the session using it is blocked pick_missing ("spare is not in your '
    + 'model settings."), the menu no longer lists it, and nothing is sent with its key',
  gone.ok && card?.title === 'spare is not in your model settings.' && !picks.some((p) => p.startsWith('spare'))
    && attempt.requests === 0 && !fakes.keyed.chats.some((c) => c.at >= after && c.key === last4(KEY.spare)),
  `${cardText(card)} | menu ${picks.join(',')}`);
  await choosePick(page, 'fake-local');
}

/** @brief Add key 之后按 F8 保存报告：最近的操作里有 "Add key <id>"，报告里没有 key。 */
async function f8AfterAddKey(ctx) {
  const { page } = ctx;
  await openSettings(page);
  await addKey(page, 'fake-local', KEY.added);
  await backToChat(page);
  await page.locator(TEXTAREA).press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill('Model settings check');
  await dialog.getByTestId('issue-expect').fill('No API key in this report');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const path = /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  const md = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  await page.keyboard.press('Escape');
  const actions = md.split(/\r?\n/).filter((line) => /Add key|Save first-run/.test(line));
  record('MP-26 F8 report after Add key: recent actions list "Add key fake-local" and the report text has no key',
    md.length > 0 && actions.some((line) => line.includes('Add key fake-local')) && secretsIn(md).length === 0,
    `${path ?? 'not saved'} | ${actions.join(' | ')}`);
  const shown = await page.evaluate(async () => JSON.stringify(await window.mori.request({ type: 'models.get' })));
  record('MP-24 key plaintext never comes back to the UI: models.get and the page have no secret after Add key',
    secretsIn(shown).length === 0 && secretsIn(await page.content()).length === 0);
}

// ---------- MP-33、MP-06：首次启动（Public） ----------

/** @brief 首次启动选 Public；-notools 判定失败的说明；改模型 id 再测；Allow public；路径大小写。 */
async function firstRunPublic() {
  const userData = tempDir('mori-v1s-public-');
  const root = tempDir('mori-v1s-public-proj-');
  const project = makeProject(root, 'PubProj');
  const caseProject = makeProject(root, 'CaseProj');
  let ctx;
  try {
    ctx = await startApp(userData);
    await publicForm(ctx);
    await publicAllow(ctx, project);
    await publicPathCase(ctx, caseProject);
  } catch (error) {
    record('MP-33 firstRunPublic: flow', false, oneLine(error, 400));
    await shot(ctx, 'firstRunPublic-error');
  } finally {
    await closeApp(ctx, 'MP-33');
  }
}

/** @brief 选 Public 的说明；-notools 的失败说明；改模型 id 再测仍只有一个提供商。 */
async function publicForm(ctx) {
  const { page, userData } = ctx;
  await fillFirstRun(page, { name: 'Fake Public', baseUrl: url(PORT.pub), modelId: 'fake-coder-notools' });
  await page.locator('[data-testid="connection-form"] input[name="zone"][value="public"]').check();
  const note = await page.getByTestId('zone-public-note').textContent().catch(() => null);
  record('MP-33 first run (Public): choosing Public shows "Public providers must be allowed per project. You\'ll be '
    + 'asked when you open a folder."', note?.trim() === 'Public providers must be allowed per project. '
    + 'You’ll be asked when you open a folder.', note ?? 'no note');
  const first = await testConnection(page);
  const seen = await probeStates(page, ['verified', 'failed', 'error']);
  const text = seen.at(-1)?.text ?? '';
  const advice = '. Mori needs tool calling for the main agent; pick another model or check the server’s tool-call '
    + 'settings.';
  record('MP-33 tool calling failed (-notools): the probe status says "Tool calling failed verification: <detail>. '
    + 'Mori needs tool calling for the main agent; …"', first.startsWith('Connected') && seen.at(-1)?.state === 'failed'
    && text.startsWith('Tool calling failed verification: ') && text.endsWith(advice)
    && text.length > 'Tool calling failed verification: '.length + advice.length, `${first} | ${text}`);
  const before = readConfig(userData);
  await page.getByTestId('connection-form').getByLabel('Model ID', { exact: true }).fill('fake-coder');
  const second = await testConnection(page);
  const again = await probeStates(page, ['verified', 'failed', 'error']);
  const after = readConfig(userData);
  const provider = after?.providers?.[0];
  record('MP-33 after editing the model id and testing again there is still one provider, with only the new model',
    before?.providers.length === 1 && after?.providers.length === 1 && provider.id === before.providers[0].id
    && JSON.stringify(provider.models.map((m) => m.id)) === '["fake-coder"]'
    && after.normalDefault === `${provider.id}/fake-coder` && second.startsWith('Connected'),
    oneLine(JSON.stringify(after?.providers.map((p) => ({ id: p.id, models: p.models.map((m) => m.id) })))));
  record('MP-33 first run (Public): the retest verifies tool calling and the provider is saved with zone public',
    again.at(-1)?.state === 'verified' && provider?.zone === 'public', again.map((s) => s.state).join(' → '));
}

/** @brief 打开文件夹：拒绝启动卡带 Allow public；Project access 勾 Public 先确认，取消不写，Allow 后可以发送。 */
async function publicAllow(ctx, project) {
  const { page, userData } = ctx;
  await openFolder(ctx, project);
  const card = (await waitCard(page, (s) => s?.kind === 'no_candidate', 30000)).value;
  const allow = card?.actions.find((a) => a.action === 'allow-zone');
  record('MP-33 first run (Public): the new session is blocked with "Allow public for this project"',
    allow?.label === 'Allow public for this project', cardText(card));
  const candidate = card?.candidates.find((c) => c.ref === 'fake-public/fake-coder');
  record('MP-06 a public provider in a project without a grant is excluded: "zone public is not allowed for this '
    + 'project"', candidate?.reason === 'zone_blocked'
    && candidate.text.includes('zone public is not allowed for this project'), cardText(card));
  await page.locator(`${CARD} [data-action="allow-zone"]`).click();
  const focus = await poll(() => page.evaluate(() => {
    const el = document.activeElement;
    return { zone: el?.dataset?.zone ?? null, row: el?.closest('[data-testid="project-row"]')?.dataset.path ?? null };
  }), (f) => f.zone === 'public', 8000);
  record('MP-33 "Allow public for this project" opens Settings → Project access with focus on this project\'s Public '
    + 'box', focus.ok && focus.value.row === norm(project), JSON.stringify(focus.value));
  await grantPublic(ctx, project, 'Fake Public');
  await backToChat(page);
  const cleared = await waitCard(page, (s) => s === null, 20000);
  const since = Date.now();
  const reply = await sendText(ctx, 'plain public allowed');
  record('MP-33 first run (Public): after allowing public for the project the session sends and gets the reply',
    cleared.ok && reply.text.includes(REPLY), `${cardText(cleared.value)} | ${oneLine(reply.text)}`);
  record('MP-06 once Allow is confirmed the public provider is used in that project',
    chatsOf(fakes.pub, since).some((c) => c.model === 'fake-coder'), `${chatsOf(fakes.pub, since).length} request(s)`);
  record('MP-06 the grant is stored under the normalized project path',
    JSON.stringify(readConfig(userData)?.projectZones?.[norm(project)]) === '["public"]',
    JSON.stringify(readConfig(userData)?.projectZones));
}

/** @brief Project access 勾 Public：确认框的文字；Cancel 不写；Allow 写进配置。 */
async function grantPublic(ctx, project, names) {
  const { page, userData } = ctx;
  const row = page.locator(`[data-testid="project-row"][data-path="${norm(project)}"]`);
  const box = row.locator('[data-testid="project-zone"][data-zone="public"]');
  const before = JSON.stringify(readConfig(userData)?.projectZones ?? {});
  await box.click();
  const dialog = page.getByTestId('public-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const info = await dialogInfo(dialog);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await sleep(500);
  const unchanged = JSON.stringify(readConfig(userData)?.projectZones ?? {}) === before;
  record('MP-06 Project access: ticking Public asks "Allow public providers for this project?" naming the public '
    + 'providers; Cancel leaves the box unticked and writes nothing', info.title === 'Allow public providers for this '
    + 'project?' && info.text.toLowerCase().includes(`code and files from ${norm(project)} may be sent to: `)
    && info.text.includes(`${names}.`) && unchanged && !(await box.isChecked()), oneLine(info.text, 300));
  await box.click();
  await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
  const saved = await waitConfig(userData, (cfg) => cfg.projectZones?.[norm(project)]?.includes('public'));
  const allowed = await poll(() => row.textContent(), (text) => text.includes('Allowed: Local · Intranet · Public'),
    5000);
  record('MP-06 Project access: Allow writes the grant at once and the row shows "Allowed: Local · Intranet · Public"',
    saved.ok && allowed.ok && await box.isChecked(), oneLine(allowed.value));
}

/** @brief 授权后用大小写与分隔符不同的路径打开同一个项目：新会话不被拒绝。 */
async function publicPathCase(ctx, project) {
  const { page } = ctx;
  await openFolder(ctx, project);
  const blocked = await waitCard(page, (s) => s?.kind === 'no_candidate', 20000);
  await page.locator(`${CARD} [data-action="allow-zone"]`).click();
  const row = page.locator(`[data-testid="project-row"][data-path="${norm(project)}"]`);
  await row.locator('[data-testid="project-zone"][data-zone="public"]').click();
  await page.getByTestId('public-dialog').getByRole('button', { name: 'Allow', exact: true }).click();
  await waitConfig(ctx.userData, (cfg) => cfg.projectZones?.[norm(project)]?.includes('public'));
  await backToChat(page);
  const variant = project.toUpperCase().replace(/\\/g, '/');
  await openFolder(ctx, variant);
  const card = await waitCard(page, (s) => s === null, 20000);
  const reply = card.ok ? await sendText(ctx, 'plain via variant path') : null;
  record('MP-06 a grant made for a project applies when the same folder is opened with different case and '
    + `separators (${variant.slice(-30)})`, blocked.ok && card.ok && reply?.text.includes(REPLY),
  `${cardText(card.value)} | ${oneLine(reply?.text ?? '')}`);
}

// ---------- MP-06、MP-07：项目配置与区域（预先写好的配置） ----------

/** @brief MP-06、MP-07 与 MP-24 用的配置（synthetic test setup）：本机、公网、内网三个提供商，分组 team。 */
const zonesConfig = (port, projectZones = {}) => seedConfig({
  providers: [seedProvider('loc', 'Local A', port, 'local'), seedProvider('pub', 'Public B', port, 'public'),
    seedProvider('intra', 'Intra C', port, 'intranet')],
  groups: [{ id: 'team', members: ['loc/fake-coder', 'pub'] }], normalDefault: 'loc/fake-coder', projectZones });

/** 项目配置的几种写法（synthetic test setup）与 MP-07 期望在拒绝启动卡里看到的原因 */
const PROJECT_CONFIGS = {
  narrow: { allowedZones: ['intranet'] },
  widen: { allowedZones: ['local', 'intranet', 'public'] },
  unknown: { allowedZones: ['local'], providers: {} },
  badJson: '{ "allowedZones": [',
  noGroup: { groups: { ghost: ['loc/fake-coder'] } },
  stray: { groups: { team: ['intra/fake-coder'] } },
};

/** @brief 项目配置缩小与不能放宽、路径大小写；四种无效的项目配置。 */
async function projectRules() {
  const userData = tempDir('mori-v1s-zones-');
  const root = tempDir('mori-v1s-zones-proj-');
  const projects = Object.fromEntries(Object.entries(PROJECT_CONFIGS)
    .map(([name, models]) => [name, makeProject(root, `${name}Proj`, models)]));
  projects.caseProj = makeProject(root, 'CaseSeeded');
  // synthetic test setup：配置里已为 CaseSeeded 按规范化路径授权了公网
  writeJson(configFile(userData), zonesConfig(PORT.seeded, { [norm(projects.caseProj)]: ['public'] }));
  let ctx;
  try {
    ctx = await startApp(userData);
    await narrowZones(ctx, projects.narrow);
    await cannotWiden(ctx, projects.widen);
    await seededCase(ctx, projects.caseProj);
    await invalidProjects(ctx, projects);
  } catch (error) {
    record('MP-06 projectRules: flow', false, oneLine(error, 400));
    await shot(ctx, 'projectRules-error');
  } finally {
    await closeApp(ctx, 'MP-06');
  }
}

/** @brief allowedZones ["intranet"]：本机提供商被排除；内网的照常；Public 勾选框不可用并说明。 */
async function narrowZones(ctx, project) {
  const { page } = ctx;
  await openFolder(ctx, project);
  const card = (await waitCard(page, (s) => s?.kind === 'no_candidate', 60000)).value;
  const loc = card?.candidates.find((c) => c.ref === 'loc/fake-coder');
  record('MP-06 a project config narrowing to intranet excludes the local provider ("zone local is not allowed for '
    + 'this project") and offers no Allow', loc?.reason === 'zone_blocked'
    && loc.text.includes('zone local is not allowed for this project')
    && !card.actions.some((a) => a.action === 'allow-zone'), cardText(card));
  await choosePick(page, 'pub');
  const pub = (await waitCard(page, (s) => s?.candidates.some((c) => c.ref === 'pub/fake-coder'), 15000)).value;
  record('MP-06 the narrowed project excludes public too and does not offer "Allow public" (the project config '
    + 'excludes it)', pub?.candidates.find((c) => c.ref === 'pub/fake-coder')?.reason === 'zone_blocked'
    && !pub.actions.some((a) => a.action === 'allow-zone'), cardText(pub));
  await choosePick(page, 'intra/fake-coder');
  const ok = await waitCard(page, (s) => s === null, 60000);
  const reply = ok.ok ? await sendText(ctx, 'plain intranet in narrow project') : null;
  record('MP-06 in the narrowed project the intranet provider is still usable', ok.ok && reply?.text.includes(REPLY),
    cardText(ok.value));
  await openSettings(page);
  const row = page.locator(`[data-testid="project-row"][data-path="${norm(project)}"]`);
  const box = row.locator('[data-testid="project-zone"][data-zone="public"]');
  const text = await row.textContent();
  record('MP-06 Project access: the Public box is unavailable with ".mori/models.json in this project doesn\'t allow '
    + 'public."', await box.isDisabled() && text.includes('.mori/models.json in this project doesn’t allow public.')
    && text.includes('Allowed: Intranet'), oneLine(text));
  await backToChat(page);
}

/** @brief allowedZones 写了 public 也不放宽：没授权时公网提供商仍被排除，并提供 Allow public。 */
async function cannotWiden(ctx, project) {
  const { page } = ctx;
  await openFolder(ctx, project);
  await waitCard(page, (s) => s === null, 60000);
  await choosePick(page, 'pub');
  const card = (await waitCard(page, (s) => s?.kind === 'no_candidate', 15000)).value;
  record('MP-06 a project config cannot widen: listing public in .mori/models.json does not allow the public provider '
    + 'without a grant', card?.candidates.find((c) => c.ref === 'pub/fake-coder')?.reason === 'zone_blocked'
    && card.actions.some((a) => a.action === 'allow-zone'), cardText(card));
}

/** @brief 配置里按规范化路径授权的项目，用原路径和大小写、分隔符不同的路径打开都按同一项目授权。 */
async function seededCase(ctx, project) {
  const { page } = ctx;
  const variants = [project, project.toUpperCase().replace(/\\/g, '/')];
  const results = [];
  for (const path of variants) {
    await openFolder(ctx, path);
    await waitCard(page, (s) => s === null, 60000);
    await choosePick(page, 'pub');
    const card = await waitCard(page, (s) => s === null, 15000);
    const reply = card.ok ? await sendText(ctx, 'plain public seeded') : null;
    results.push(card.ok && Boolean(reply?.text.includes(REPLY)));
  }
  record('MP-06 a grant stored under the normalized path (lowercase, /) applies to the folder opened as '
    + `"${variants[0].slice(-20)}" and "${variants[1].slice(-20)}"`, results.every(Boolean), JSON.stringify(results));
}

/** @brief 四种无效的项目配置：会话按 project_config 拒绝启动并显示原因；Project access 的这一行显示原文。 */
async function invalidProjects(ctx, projects) {
  const { page } = ctx;
  const cases = [
    ['unknown field', 'unknown', (t) => t.includes('providers')],
    ['bad JSON', 'badJson', (t) => /JSON|Unexpected|Expected/i.test(t)],
    ['a group that does not exist', 'noGroup', (t) => t.includes('ghost is not in your model settings')],
    ['an item that is not in the user\'s group', 'stray', (t) => t.includes('intra/fake-coder is not a member of group '
      + 'team')],
  ];
  const reasons = {};
  for (const [label, name, test] of cases) {
    await openFolder(ctx, projects[name]);
    const card = (await waitCard(page, (s) => s?.kind === 'project_config', 20000)).value;
    const reason = card?.title.replace(/^\.mori\/models\.json: /, '') ?? '';
    reasons[name] = reason;
    const attempt = await trySend(ctx, fakes.seeded, 'plain project config');
    record(`MP-07 ${label} in .mori/models.json blocks the session (project_config) with ".mori/models.json: <reason>"`,
      card?.title.startsWith('.mori/models.json: ') && test(reason)
      && card.actions.map((a) => a.action).join() === 'open-settings' && attempt.disabled && attempt.requests === 0,
      cardText(card));
  }
  await openSettings(page);
  const readRows = () => page.evaluate(() => Object.fromEntries([
    ...document.querySelectorAll('[data-testid="project-row"]')].map((row) => [row.dataset.path,
    row.querySelector('[data-testid="project-config-error"]')?.textContent ?? null])));
  const same = (rows) => cases.every(([, name]) => rows[norm(projects[name])]
    === `.mori/models.json: ${reasons[name]}`);
  const { ok: shown, value: rows } = await poll(readRows, same, 10000);
  record('MP-07 Settings → Project access shows ".mori/models.json: <reason>" on each invalid project\'s row', shown,
    oneLine(JSON.stringify(rows), 400));
  await backToChat(page);
}

// ---------- MP-24：设置页的增删改 ----------

/** @brief 设置页的各种修改立即写进配置并影响打开的会话。 */
async function settingsEdits() {
  const userData = tempDir('mori-v1s-edits-');
  const project = makeProject(tempDir('mori-v1s-edits-proj-'), 'proj');
  writeJson(configFile(userData), zonesConfig(PORT.edits)); // synthetic test setup
  let ctx;
  try {
    ctx = await startApp(userData);
    ctx.main = await openFolder(ctx, project);
    await waitCard(ctx.page, (s) => s === null, 60000);
    await editDefaults(ctx);
    await editProvider(ctx);
    await compatOptions(ctx);
    await editKeys(ctx);
    await editAddress(ctx);
    await editModels(ctx);
    await editGroups(ctx);
    await editProjectAccess(ctx, project);
    await deleteExtra(ctx);
  } catch (error) {
    record('MP-24 settingsEdits: flow', false, oneLine(error, 400));
    await shot(ctx, 'settingsEdits-error');
  } finally {
    await closeApp(ctx, 'MP-24');
  }
}

/** @brief 回到会话 file（设置页里先"返回会话"）。 */
async function showSession(ctx, file) {
  if (await ctx.page.getByTestId('settings-page').isVisible().catch(() => false)) await backToChat(ctx.page);
  await openRow(ctx.page, file);
}

/** @brief Defaults：默认范围（新会话用它、打开的会话不变）；允许的区域（取消 Local 立即拒绝本机模型）。 */
async function editDefaults(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await page.getByTestId('default-pick').selectOption('team');
  const saved = await waitConfig(userData, (cfg) => cfg.normalDefault === 'team');
  await backToChat(page);
  const kept = await page.locator(`${PANE} [data-testid="model-button"]`).getAttribute('data-pick');
  const second = await ctrlN(page);
  const fresh = await page.locator(`${PANE} [data-testid="model-button"]`).getAttribute('data-pick');
  record('MP-24 Defaults: the default range is saved at once; a new session uses it and the open session keeps its '
    + 'range',
    saved.ok && kept === 'loc/fake-coder' && fresh === 'team', `open ${kept}, new ${fresh}`);
  await showSession(ctx, ctx.main);
  await openSettings(page);
  await page.locator('[data-testid="allowed-zone"][data-zone="local"]').click();
  const off = await waitConfig(userData, (cfg) => JSON.stringify(cfg.allowedZones) === '["intranet"]');
  await showSession(ctx, ctx.main);
  const blocked = (await waitCard(page, (s) => s?.kind === 'no_candidate', 10000)).value;
  await openSettings(page);
  await page.locator('[data-testid="allowed-zone"][data-zone="local"]').click();
  const on = await waitConfig(userData, (cfg) => cfg.allowedZones.includes('local'));
  await showSession(ctx, ctx.main);
  const cleared = await waitCard(page, (s) => s === null, 10000);
  record('MP-24 Defaults: unticking Local is saved at once and blocks the open session on a local model; ticking it '
    + 'again unblocks it', off.ok && on.ok && blocked?.candidates[0]?.reason === 'zone_blocked' && cleared.ok,
  `${cardText(blocked)} → ${cardText(cleared.value)}`);
  ctx.second = second;
}

/** @brief 编辑提供商：区域与并发上限立即写进配置，打开的会话重新校验；新建提供商。 */
async function editProvider(ctx) {
  const { page, userData } = ctx;
  const edit = async (zone, concurrency) => {
    await openSettings(page);
    await providerCard(page, 'loc').locator('[data-action="edit-provider"]').click();
    const form = page.getByTestId('provider-form');
    await form.locator(`input[name="zone"][value="${zone}"]`).check();
    await form.getByLabel('Concurrency per key', { exact: true }).fill(String(concurrency));
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 15000 });
    await showSession(ctx, ctx.main);
  };
  await edit('public', 2);
  const cfg = readConfig(userData);
  const blocked = (await waitCard(page, (s) => s?.kind === 'no_candidate', 10000)).value;
  await edit('local', 4);
  const cleared = await waitCard(page, (s) => s === null, 15000);
  record('MP-24 Providers: Edit saves zone and concurrency and the open session is re-validated at once (public → '
    + 'blocked, local → unblocked)', providerOf(cfg, 'loc')?.zone === 'public'
    && providerOf(cfg, 'loc').concurrency === 2
    && blocked?.candidates.some((c) => c.reason === 'zone_blocked') && cleared.ok
    && providerOf(readConfig(userData), 'loc')?.zone === 'local', `${cardText(blocked)} → ${cardText(cleared.value)}`);
  await openSettings(page);
  await addProvider(page, { name: 'Extra D', baseUrl: url(PORT.edits) });
  const verified = await waitVerified(page, 'extra-d/fake-coder');
  record('MP-24 Providers: Add provider saves it (id from the name), shows its card and probes its model to Verified',
    Boolean(providerOf(readConfig(userData), 'extra-d')) && await providerCard(page, 'extra-d').count() === 1
    && verified.ok, String(verified.value));
}

/** 兼容选项勾选框的标签与下面一行说明（§9.1，shared/models.ts COMPAT_LABELS、COMPAT_HINTS），按表单里的顺序 */
const COMPAT_TEXTS = [
  ['Endpoint doesn’t support the developer role', 'Sends the system prompt with the system role instead'],
  ['Endpoint doesn’t accept the store field', 'Leaves store out of requests'],
  ['Endpoint needs max_tokens instead of max_completion_tokens',
    'Older endpoints don’t recognize max_completion_tokens'],
  ['Endpoint doesn’t report usage while streaming',
    'Doesn’t send stream_options, so the context usage shown will be inaccurate'],
  ['Endpoint doesn’t support strict mode for tool parameters', 'Leaves strict out of tool definitions'],
  ['Tool results must include the tool name', 'Some endpoints require a name field on tool result messages'],
];

/** @brief Add provider 表单的兼容选项：六个勾选框各有标签和一行说明；API type 不是 OpenAI-compatible 时不显示。不保存。 */
async function compatOptions(ctx) {
  const { page } = ctx;
  await openSettings(page);
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  const rows = form.locator('.compat-checks label.check-row');
  const shown = await rows.evaluateAll((labels) => labels.map((label) => {
    const span = label.querySelector('span');
    return [span?.firstChild?.textContent ?? '', span?.querySelector('small')?.textContent ?? ''];
  }));
  const api = form.getByLabel('API type', { exact: true });
  await api.selectOption('anthropic-messages');
  const hidden = await rows.count();
  await api.selectOption('openai-completions');
  const back = await rows.count();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 5000 });
  record('MP-24 Add provider: each compatibility option shows its label and a hint line (english-ui wording); '
    + 'the options are hidden for other API types', JSON.stringify(shown) === JSON.stringify(COMPAT_TEXTS)
    && hidden === 0 && back === COMPAT_TEXTS.length, JSON.stringify({ shown, hidden, back }));
}

/** @brief Keys：加、上移、删（不是最后一个时不确认）、删最后一个（确认、Cancel、Remove）；明文不回到界面。 */
async function editKeys(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  const card = providerCard(page, 'loc');
  await addKey(page, 'loc', KEY.seedA);
  await addKey(page, 'loc', KEY.seedB);
  const added = await waitConfig(userData, (cfg) => keyRefs(cfg, 'loc')?.length === 2);
  const rows = await card.locator('[data-testid="key-row"]').evaluateAll((items) => items.map((row) => ({
    ref: row.dataset.ref, saved: row.textContent.includes('Saved') })));
  record('MP-24 Keys: Add key saves new rows at the end showing "Saved" (loc#1, loc#2)', added.ok
    && JSON.stringify(rows) === '[{"ref":"loc#1","saved":true},{"ref":"loc#2","saved":true}]', JSON.stringify(rows));
  const dom = await page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll('input')]
    .map((input) => input.value)].join('\n'));
  const shown = await page.evaluate(async () => JSON.stringify(await window.mori.request({ type: 'models.get' })));
  record('MP-24 key plaintext never comes back to the UI (page text, input values, models.get)',
    secretsIn(dom).length === 0 && secretsIn(shown).length === 0, `${secretsIn(dom)} ${secretsIn(shown)}`);
  await card.locator('[data-testid="key-row"][data-ref="loc#2"] [data-action="key-up"]').click();
  const moved = await waitConfig(userData, (cfg) => keyRefs(cfg, 'loc')?.[0] === 'loc#2');
  record('MP-24 Keys: Move up reorders the keys in model-config.json at once', moved.ok,
    JSON.stringify(keyRefs(moved.value, 'loc')));
  await card.locator('[data-testid="key-row"][data-ref="loc#2"] [data-action="key-remove"]').click();
  const removed = await waitConfig(userData, (cfg) => JSON.stringify(keyRefs(cfg, 'loc')) === '["loc#1"]');
  const creds = await credsWithout(userData, 'loc#2');
  record('MP-24 Keys: Remove (not the last key) deletes it at once without asking, ciphertext included',
    removed.ok && await dialogOf(page, 'last-key').count() === 0 && creds.ok, creds.value.join(','));
  await lastKey(ctx, card);
}

/** @brief 删最后一个 key：确认框，Cancel 保留，Remove 后显示没有 key 的说明。 */
async function lastKey(ctx, card) {
  const { page, userData } = ctx;
  await card.locator('[data-testid="key-row"][data-ref="loc#1"] [data-action="key-remove"]').click();
  const dialog = dialogOf(page, 'last-key');
  await dialog.waitFor({ timeout: 5000 });
  const info = await dialogInfo(dialog);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await sleep(500);
  const kept = JSON.stringify(keyRefs(readConfig(userData), 'loc')) === '["loc#1"]';
  await card.locator('[data-testid="key-row"][data-ref="loc#1"] [data-action="key-remove"]').click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  const empty = await waitConfig(userData, (cfg) => keyRefs(cfg, 'loc')?.length === 0);
  const note = await card.getByTestId('no-keys').textContent().catch(() => null);
  record('MP-24 Keys: removing the last key asks "Remove the last key?" / "Requests to Local A will be sent without an '
    + 'API key."; Cancel keeps it; Remove leaves "Requests are sent without an API key."',
  info.title === 'Remove the last key?' && info.text.includes('Requests to Local A will be sent without an API key.')
    && kept && empty.ok && note === 'Requests are sent without an API key.', `${oneLine(info.text)} | ${note}`);
}

/** @brief 改地址的 origin：确认框（Cancel 不改）；保存后 key 被删，新端口收不到旧 key。 */
async function editAddress(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await addKey(page, 'intra', KEY.moved);
  await waitConfig(userData, (cfg) => keyRefs(cfg, 'intra')?.length === 1);
  const card = providerCard(page, 'intra');
  await card.locator('[data-action="edit-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(url(PORT.moved));
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = dialogOf(page, 'address-change');
  await dialog.waitFor({ timeout: 5000 });
  const info = await dialogInfo(dialog);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await sleep(500);
  const unchanged = providerOf(readConfig(userData), 'intra');
  record('MP-24 changing the address origin asks "Change the base URL?" with "Changing the base URL removes '
    + 'this provider’s saved key. Add it again after saving."; Cancel saves nothing',
  info.title === 'Change the base URL?'
    && info.text.includes('Changing the base URL removes this provider’s saved key. Add it again after saving.')
    && unchanged.baseUrl === url(PORT.edits) && unchanged.keys.length === 1, oneLine(info.text));
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save and remove keys', exact: true }).click();
  const moved = await waitConfig(userData, (cfg) => providerOf(cfg, 'intra')?.baseUrl === url(PORT.moved));
  const since = Date.now();
  await providerCard(page, 'intra').locator('[data-action="test-provider"]').click();
  const result = await poll(() => providerCard(page, 'intra').getByTestId('test-result').textContent().catch(() => ''),
    (text) => /^(Connected|Connection failed|Couldn’t test)/.test(text), 60000);
  const newPort = fakes.moved.chats.filter((chat) => chat.at >= since);
  const creds = await credsWithout(userData, 'intra#1');
  record('MP-24 after the address change the keys are deleted and the new port never receives the old key',
    moved.ok && providerOf(moved.value, 'intra').keys.length === 0 && creds.ok
    && result.value.startsWith('Connected') && newPort.length > 0
    && fakes.moved.chats.every((chat) => chat.key !== last4(KEY.moved)),
  `${result.value} | keys on ${PORT.moved}: ${[...new Set(fakes.moved.chats.map((c) => c.key))].join(',')}`);
}

/** @brief Models：加、编辑、上移、删除（确认框）。 */
async function editModels(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await providerCard(page, 'loc').locator('[data-action="add-model"]').click();
  let form = page.getByTestId('model-form');
  await form.getByLabel('Model ID', { exact: true }).fill('fake-coder-b');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const added = await waitConfig(userData, (cfg) => providerOf(cfg, 'loc').models.length === 2);
  record('MP-24 Models: Add model saves it at the end of the provider and shows its row', added.ok
    && await modelRow(page, 'loc/fake-coder-b').count() === 1);
  await modelRow(page, 'loc/fake-coder-b').locator('[data-action="edit"]').click();
  form = page.getByTestId('model-form');
  await form.getByLabel('Context window', { exact: true }).fill('65536');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const edited = await waitConfig(userData, (cfg) => providerOf(cfg, 'loc').models[1]?.contextWindow === 65536);
  await modelRow(page, 'loc/fake-coder-b').locator('[data-action="up"]').click();
  const moved = await waitConfig(userData, (cfg) => providerOf(cfg, 'loc').models[0].id === 'fake-coder-b');
  record('MP-24 Models: Edit saves the new context window; Move up reorders the models', edited.ok && moved.ok,
    JSON.stringify(providerOf(readConfig(userData), 'loc').models.map((m) => [m.id, m.contextWindow])));
  await modelRow(page, 'loc/fake-coder-b').locator('[data-action="delete"]').click();
  const dialog = dialogOf(page, 'delete-model');
  await dialog.waitFor({ timeout: 5000 });
  const title = (await dialogInfo(dialog)).title;
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  const deleted = await waitConfig(userData, (cfg) => providerOf(cfg, 'loc').models.length === 1);
  record('MP-24 Models: Delete asks "Delete model fake-coder-b?" and removes it', title === 'Delete model fake-coder-b?'
    && deleted.ok && await modelRow(page, 'loc/fake-coder-b').count() === 0, title);
}

/** @brief Groups：新分组 id 的错误、建立、加成员、上移、只剩一个成员、改成员立即影响会话、删除。 */
async function editGroups(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await page.locator('[data-action="new-group"]').click();
  const form = page.getByTestId('group-form');
  const errors = {};
  for (const id of ['loc', 'Bad_ID', 'mori']) {
    await form.getByLabel('Group ID').fill(id);
    errors[id] = { text: await form.getByTestId('group-error').textContent().catch(() => null),
      create: await form.getByRole('button', { name: 'Create', exact: true }).isDisabled() };
  }
  record('MP-24 Groups: new group id errors ("loc is already used by a provider or group.", "Use lowercase letters, '
    + 'digits, and hyphens.", "mori is reserved.") and Create unavailable', errors.loc.text === 'loc is already used '
    + 'by a provider or group.' && errors.Bad_ID.text === 'Use lowercase letters, digits, and hyphens.'
    && errors.mori.text === 'mori is reserved.' && Object.values(errors).every((e) => e.create),
  JSON.stringify(errors));
  await form.getByLabel('Group ID').fill('duo');
  await form.locator('[data-testid="member-picker"] [data-member="intra/fake-coder"]').click();
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  const created = await waitConfig(userData, (cfg) => cfg.groups.some((g) => g.id === 'duo'));
  const row = page.locator('[data-testid="group-row"][data-group="duo"]');
  await row.locator('[data-action="add-member"]').click();
  const chosen = row.locator('[data-testid="member-picker"] [data-member="intra/fake-coder"]');
  const locked = await chosen.getAttribute('aria-checked') === 'true' && await chosen.isDisabled();
  await row.locator('[data-testid="member-picker"] [data-member="loc"]').click();
  await waitConfig(userData, (cfg) => cfg.groups.find((g) => g.id === 'duo')?.members.length === 2);
  await row.locator('[data-testid="group-member"][data-member="loc"] [data-action="member-up"]').click();
  const order = await waitConfig(userData, (cfg) => cfg.groups.find((g) => g.id === 'duo')?.members[0] === 'loc');
  record('MP-24 Groups: Create, Add member (already chosen members ticked and unavailable) and Move up save at once',
    created.ok && locked && order.ok, JSON.stringify(order.value?.groups));
  await row.locator('[data-testid="group-member"][data-member="intra/fake-coder"] [data-action="member-remove"]')
    .click();
  await waitConfig(userData, (cfg) => cfg.groups.find((g) => g.id === 'duo')?.members.length === 1);
  const lone = row.locator('[data-testid="group-member"][data-member="loc"] [data-action="member-remove"]');
  const hint = await row.textContent();
  record('MP-24 Groups: with one member left Remove is unavailable with "A group needs at least one member; delete the '
    + 'group instead."', await lone.isDisabled()
    && hint.includes('A group needs at least one member; delete the group instead.'), oneLine(hint));
  await groupAffectsSession(ctx, row);
}

/** @brief 会话的范围是分组 duo：成员改成公网提供商立即拒绝启动；删除分组（确认框说明）后 pick_missing。 */
async function groupAffectsSession(ctx, row) {
  const { page, userData } = ctx;
  await showSession(ctx, ctx.main);
  await choosePick(page, 'duo');
  const usable = await waitCard(page, (s) => s === null, 15000);
  await openSettings(page);
  await row.locator('[data-action="add-member"]').click();
  await row.locator('[data-testid="member-picker"] [data-member="pub"]').click();
  await waitConfig(userData, (cfg) => cfg.groups.find((g) => g.id === 'duo')?.members.length === 2);
  await row.locator('[data-testid="group-member"][data-member="loc"] [data-action="member-remove"]').click();
  await waitConfig(userData, (cfg) => JSON.stringify(cfg.groups.find((g) => g.id === 'duo')?.members) === '["pub"]');
  await showSession(ctx, ctx.main);
  const blocked = (await waitCard(page, (s) => s?.kind === 'no_candidate', 10000)).value;
  record('MP-24 Groups: changing the members of the session\'s group re-validates it at once (only a public member → '
    + 'blocked)', usable.ok
    && blocked?.candidates.some((c) => c.ref === 'pub/fake-coder' && c.reason === 'zone_blocked'),
  cardText(blocked));
  await openSettings(page);
  await row.locator('[data-action="delete-group"]').click();
  const dialog = dialogOf(page, 'delete-group');
  await dialog.waitFor({ timeout: 5000 });
  const info = await dialogInfo(dialog);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  const gone = await waitConfig(userData, (cfg) => !cfg.groups.some((g) => g.id === 'duo'));
  await showSession(ctx, ctx.main);
  const card = (await waitCard(page, (s) => s?.kind === 'pick_missing', 10000)).value;
  record('MP-24 Groups: Delete asks "Delete group duo?" with "Sessions using this group will need a new model range." '
    + 'and the session using it becomes pick_missing', info.title === 'Delete group duo?'
    && info.text.includes('Sessions using this group will need a new model range.') && gone.ok
    && card?.title === 'duo is not in your model settings.', `${oneLine(info.text)} | ${cardText(card)}`);
}

/** @brief Project access：勾 Public（确认）立即解除打开的会话的拒绝；取消勾选不问、立即重新拒绝。 */
async function editProjectAccess(ctx, project) {
  const { page, userData } = ctx;
  await showSession(ctx, ctx.main);
  await choosePick(page, 'pub');
  const blocked = await waitCard(page, (s) => s?.kind === 'no_candidate', 10000);
  await openSettings(page);
  const box = page.locator(`[data-testid="project-row"][data-path="${norm(project)}"] [data-testid="project-zone"]`
    + '[data-zone="public"]');
  await box.click();
  await page.getByTestId('public-dialog').getByRole('button', { name: 'Allow', exact: true }).click();
  const granted = await waitConfig(userData, (cfg) => cfg.projectZones?.[norm(project)]?.includes('public'));
  await showSession(ctx, ctx.main);
  const open = await waitCard(page, (s) => s === null, 15000);
  await openSettings(page);
  await box.click();
  const asked = await page.getByTestId('public-dialog').count();
  const revoked = await waitConfig(userData, (cfg) => !cfg.projectZones?.[norm(project)]?.includes('public'));
  await showSession(ctx, ctx.main);
  const again = await waitCard(page, (s) => s?.kind === 'no_candidate', 10000);
  record('MP-24 Project access: ticking Public (after Allow) is saved at once and unblocks the open session; unticking '
    + 'saves at once without asking and blocks it again', blocked.ok && granted.ok && open.ok && asked === 0
    && revoked.ok && again.ok, `${cardText(blocked.value)} → ${cardText(open.value)} → ${cardText(again.value)}`);
}

/** @brief 删除提供商：确认框写明模型和 key 一起删除；卡片消失，配置里没有它。 */
async function deleteExtra(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  const info = await confirmDelete(page, providerCard(page, 'extra-d').locator('[data-action="delete-provider"]'),
    'delete-provider');
  const gone = await waitConfig(userData, (cfg) => !providerOf(cfg, 'extra-d'));
  record('MP-24 Providers: Delete asks "Delete provider Extra D?" ("Its models and keys are deleted too.") and removes '
    + 'the provider and its card', info.title === 'Delete provider Extra D?'
    && info.text.includes('Its models and keys are deleted too.') && gone.ok
    && await providerCard(page, 'extra-d').count() === 0, oneLine(info.text));
}

// ---------- MP-30：删除的连带改动 ----------

/** @brief MP-30 的配置（synthetic test setup）：四个提供商、四个分组，默认范围是会被删的模型。 */
const cascadeConfig = () => seedConfig({
  providers: [seedProvider('p1', 'One', PORT.cascade, 'local', ['fake-coder', 'fake-coder-b']),
    seedProvider('p2', 'Two', PORT.cascade, 'local'), seedProvider('p3', 'Three', PORT.cascade, 'local'),
    seedProvider('p4', 'Four', PORT.cascade, 'local')],
  groups: [{ id: 'g1', members: ['p1/fake-coder-b'] }, { id: 'g2', members: ['p1/fake-coder-b', 'p2'] },
    { id: 'g3', members: ['p3'] }, { id: 'g4', members: ['p4'] }],
  normalDefault: 'p1/fake-coder-b' });

/** @brief 删除模型、删最后一个模型、删除提供商、删除分组的连带改动，以及打开的会话 pick_missing。 */
async function cascades() {
  const userData = tempDir('mori-v1s-cascade-');
  const project = makeProject(tempDir('mori-v1s-cascade-proj-'), 'proj');
  writeJson(configFile(userData), cascadeConfig()); // synthetic test setup
  let ctx;
  try {
    ctx = await startApp(userData);
    const s1 = await openFolder(ctx, project);
    await waitCard(ctx.page, (s) => s === null, 60000);
    const s2 = await ctrlN(ctx.page);
    await choosePick(ctx.page, 'g3');
    const s3 = await ctrlN(ctx.page);
    await choosePick(ctx.page, 'g4');
    ctx.sessions = { s1, s2, s3 };
    ctx.dialogs = [];
    await cascadeModel(ctx);
    await cascadeLastModel(ctx);
    await cascadeProvider(ctx);
    await cascadeGroup(ctx);
    cascadeWording(ctx);
  } catch (error) {
    record('MP-30 cascades: flow', false, oneLine(error, 400));
    await shot(ctx, 'cascades-error');
  } finally {
    await closeApp(ctx, 'MP-30');
  }
}

/** @brief 删除一项：点删除按钮，读确认框，点 Delete，返回确认框的内容。 */
async function confirmDelete(page, button, kind) {
  await button.click();
  const dialog = dialogOf(page, kind);
  await dialog.waitFor({ timeout: 5000 });
  const info = await dialogInfo(dialog);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  return info;
}

/** @brief 会话 file 的拒绝启动卡。 */
async function cardOf(ctx, file, test) {
  await showSession(ctx, file);
  return (await waitCard(ctx.page, test, 15000)).value;
}

/** @brief 连带改动的意思（不论写法）：从分组去掉、分组变空被删、默认范围变 None。 */
const MEANS = {
  removed: (id) => new RegExp(`Removed from group ${id}\\b`),
  emptied: (id) => new RegExp(`Group ${id}\\b[^.]*\\bdeleted`),
  none: /default model range[^.]*None/,
};
/** 状态表（models-settings.md "确认框的文字"）给的每一行的写法，即后台进程给出的原文 */
const WORDING = {
  models: (ids) => `Its models are deleted: ${ids.join(', ')}.`,
  removed: (id, members) => `Removed from group ${id}: ${members.join(', ')}.`,
  emptied: (id) => `Group ${id} has no members left and is deleted.`,
  none: (pick) => `The default model range (${pick}) is set to None.`,
};

/** @brief 删除模型 p1/fake-coder-b：从 g1、g2 去掉，g1 变空被删，默认范围变 None，会话 s1 pick_missing。 */
async function cascadeModel(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  const info = await confirmDelete(page, modelRow(page, 'p1/fake-coder-b').locator('[data-action="delete"]'),
    'delete-model');
  ctx.dialogs.push({ text: info.text, lines: [WORDING.removed('g2', ['p1/fake-coder-b']), WORDING.emptied('g1'),
    WORDING.none('p1/fake-coder-b')] });
  record('MP-30 deleting a model lists every consequence in the confirm box (removed from group g2, emptied group g1 '
    + 'deleted, default range becomes None)', [MEANS.removed('g2'), MEANS.emptied('g1'), MEANS.none]
    .every((pattern) => pattern.test(info.text)), oneLine(info.text, 400));
  const cfg = (await waitConfig(userData, (c) => providerOf(c, 'p1').models.length === 1)).value;
  record('MP-30 after deleting the model: it is gone from every group, the emptied group g1 is deleted, normalDefault '
    + 'is null', JSON.stringify(providerOf(cfg, 'p1').models.map((m) => m.id)) === '["fake-coder"]'
    && !cfg.groups.some((g) => g.id === 'g1') && JSON.stringify(cfg.groups.find((g) => g.id === 'g2')?.members)
    === '["p2"]' && cfg.normalDefault === null, oneLine(JSON.stringify(cfg.groups)));
  const card = await cardOf(ctx, ctx.sessions.s1, (s) => s?.kind === 'pick_missing');
  record('MP-30 the open session whose range was the deleted model is blocked pick_missing', card?.title
    === 'p1/fake-coder-b is not in your model settings.', cardText(card));
}

/** @brief 删除 p3 的最后一个模型：提供商与它的 key 一起删除，g3 变空被删，会话 s2 pick_missing。 */
async function cascadeLastModel(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await addKey(page, 'p3', KEY.cascade);
  await waitConfig(userData, (cfg) => keyRefs(cfg, 'p3')?.length === 1);
  const info = await confirmDelete(page, modelRow(page, 'p3/fake-coder').locator('[data-action="delete"]'),
    'delete-model');
  ctx.dialogs.push({ text: info.text, lines: [WORDING.emptied('g3')] });
  record('MP-30 deleting the last model of a provider says "This is the last model of Three; the provider and its keys '
    + 'are deleted too." and lists the emptied group g3', info.text.includes('This is the last model of Three; the '
    + 'provider and its keys are deleted too.') && MEANS.emptied('g3').test(info.text), oneLine(info.text, 400));
  const cfg = (await waitConfig(userData, (c) => !providerOf(c, 'p3'))).value;
  const creds = await credsWithout(userData, 'p3#1');
  record('MP-30 after deleting the last model the provider, its key and the emptied group g3 are gone',
    Boolean(cfg) && !cfg.groups.some((g) => g.id === 'g3') && creds.ok, creds.value.join(','));
  const card = await cardOf(ctx, ctx.sessions.s2, (s) => s?.kind === 'pick_missing');
  record('MP-30 the open session on the deleted group g3 is blocked pick_missing', card?.title
    === 'g3 is not in your model settings.', cardText(card));
}

/** @brief 删除提供商 p2：它的模型和 key 一起删，从 g2 去掉，g2 变空被删。 */
async function cascadeProvider(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  const info = await confirmDelete(page, providerCard(page, 'p2').locator('[data-action="delete-provider"]'),
    'delete-provider');
  ctx.dialogs.push({ text: info.text, lines: [WORDING.models(['fake-coder']), WORDING.emptied('g2')] });
  const cfg = (await waitConfig(userData, (c) => !providerOf(c, 'p2'))).value;
  record('MP-30 deleting a provider lists "Its models and keys are deleted too." and the emptied group g2; g2 is '
    + 'deleted', info.text.includes('Its models and keys are deleted too.') && MEANS.emptied('g2').test(info.text)
    && !cfg?.groups.some((g) => g.id === 'g2'), oneLine(info.text, 400));
}

/** @brief 删除分组 g4（它是默认范围）：确认框说明，默认范围变 None，会话 s3 pick_missing，新会话没有范围。 */
async function cascadeGroup(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await page.getByTestId('default-pick').selectOption('g4');
  await waitConfig(userData, (cfg) => cfg.normalDefault === 'g4');
  const info = await confirmDelete(page, page.locator('[data-testid="group-row"][data-group="g4"] '
    + '[data-action="delete-group"]'), 'delete-group');
  ctx.dialogs.push({ text: info.text, lines: [WORDING.none('g4')] });
  const cfg = (await waitConfig(userData, (c) => !c.groups.some((g) => g.id === 'g4'))).value;
  record('MP-30 deleting the default group says "Sessions using this group will need a new model range." and that the '
    + 'default range becomes None; normalDefault becomes null', info.text.includes('Sessions using this group will '
    + 'need a new model range.') && MEANS.none.test(info.text) && cfg?.normalDefault === null, oneLine(info.text, 400));
  const card = await cardOf(ctx, ctx.sessions.s3, (s) => s?.kind === 'pick_missing');
  record('MP-30 the open session on the deleted group g4 is blocked pick_missing', card?.title
    === 'g4 is not in your model settings.', cardText(card));
  await ctrlN(page);
  const fresh = (await waitCard(page, (s) => s?.kind === 'no_pick', 10000)).value;
  record('MP-30 with the default range set to None a new session has no range ("No default model range; pick one.")',
    fresh?.title === 'No default model range; pick one.', cardText(fresh));
}

/** @brief 确认框里连带改动每一行的写法与状态表一致（models-settings.md "确认框的文字"）。 */
function cascadeWording(ctx) {
  const missing = ctx.dialogs.flatMap((dialog) => dialog.lines.filter((line) => !dialog.text.includes(line)));
  record('MP-30 the cascade lines use the wording of docs/v1/screens/models-settings.md ("Its models are deleted: '
    + '<ids>.", "Removed from group <id>: <members>.", "Group <id> has no members left and is deleted.", '
    + '"The default model range (<name>) is set to None.")',
  ctx.dialogs.length === 4 && missing.length === 0, `missing: ${missing.join(' | ')}`);
}

// ---------- MP-08：从 v0 迁移 ----------

/** @brief v0 的 models.json（synthetic test setup）：带 // 注释与多余逗号，同 v0 的读法。 */
function v0Models() {
  return `{
  // synthetic v0 models.json for the v1 migration test
  "providers": {
    "mori-endpoint": { "name": "Fake Endpoint", "baseUrl": "${url(PORT.migrate)}", "api": "openai-completions",
      "apiKey": "${KEY.v0plain}",
      "compat": { "supportsDeveloperRole": false, "supportsStore": true, "thinkingFormat": "qwen" },
      "models": [ { "id": "fake-coder", "contextWindow": 32000, "maxTokens": 64000 }, { "id": "bad model" } ] },
    "fake#1": { "name": "Cipher", "baseUrl": "${url(PORT.migrate)}", "api": "openai-completions",
      "apiKey": "${KEY.v0ignored}", "models": [ { "id": "fake-coder" } ] },
    "env-box": { "name": "Env Box", "baseUrl": "http://mori-intranet-box:9/v1", "api": "openai-completions",
      "models": [ { "id": "m1" } ] },
    "Env Box": { "name": "Env Box 2", "baseUrl": "http://mori-box.local:9/v1", "api": "openai-completions",
      "apiKey": "$MORI_V1_SYNTHETIC_KEY", "models": [ { "id": "m1" } ] },
    "openai": { "name": "Reserved", "baseUrl": "http://mori-public.invalid/v1", "api": "openai-responses",
      "models": [ { "id": "gpt-x" } ] },
    "gemini-ish": { "name": "Unsupported", "baseUrl": "http://127.0.0.1:9/v1", "api": "google-generative-ai",
      "models": [ { "id": "x" } ] },
    "empty-models": { "name": "No models", "baseUrl": "${url(PORT.migrate)}", "api": "openai-completions",
      "models": [ { "id": "" } ] },
  },
}
`;
}

/** 迁移后期望的 id、区域建议与说明 */
const MIGRATED = { 'mori-endpoint': 'local', 'fake-1': 'local', 'env-box': 'intranet', 'env-box-2': 'intranet',
  'openai-2': 'public' };

/** @brief 先用当前 App 的首次启动在数据目录里存下 ref 为 fake#1 的密文，再换成 v0 的 models.json。 */
async function prepareV0(userData) {
  const ctx = await startApp(userData);
  try {
    await fillFirstRun(ctx.page, { name: 'fake', baseUrl: url(PORT.migrate), secret: KEY.v0cipher,
      modelId: 'fake-coder' });
    await testConnection(ctx.page);
    await probeStates(ctx.page, ['verified', 'failed', 'error']);
  } finally {
    await ctx.app.close().catch(() => {});
    await sleep(500);
  }
  const creds = readJson(join(userData, 'credentials.json')) ?? {};
  for (const name of ['model-config.json', 'model-profiles.json', 'model-migration.json']) {
    rmSync(join(userData, name), { force: true });
  }
  // synthetic test setup：v0 的 models.json 与 pi 设置（默认模型、按模型的思考强度）
  writeFileSync(join(userData, 'pi', 'models.json'), v0Models());
  const settings = readJson(join(userData, 'pi', 'settings.json')) ?? {};
  writeJson(join(userData, 'pi', 'settings.json'), { ...settings, defaultProvider: 'mori-endpoint',
    defaultModel: 'fake-coder', modelThinkingLevels: { 'Env Box/m1': 'high', 'mori-endpoint/fake-coder': 'low' } });
  return Object.keys(creds).includes('fake#1');
}

/** @brief 从 v0 迁移：说明、配置、key、思考强度、区域建议与确认、发送、Dismiss、迁移后改 models.json。 */
async function migration() {
  const userData = tempDir('mori-v1s-migrate-');
  const project = makeProject(tempDir('mori-v1s-migrate-proj-'), 'proj');
  let ctx;
  try {
    const prepared = await prepareV0(userData);
    record('MP-08 setup: the current app\'s first run stored ciphertext under ref fake#1 (used as the v0 saved key)',
      prepared);
    const v0Text = readText(join(userData, 'pi', 'models.json'));
    ctx = await startApp(userData);
    await migratedLanding(ctx);
    migratedFiles(ctx, v0Text);
    await zoneSuggestions(ctx);
    await unconfirmedBlocked(ctx, project);
    await cipherWins(ctx);
    await dismissAndEdit(ctx);
  } catch (error) {
    record('MP-08 migration: flow', false, oneLine(error, 400));
    await shot(ctx, 'migration-error');
  } finally {
    await closeApp(ctx, 'MP-08');
  }
}

/** @brief 这次启动停在 设置 → Models，顶部是迁移说明，各行写对。 */
async function migratedLanding(ctx) {
  const { page } = ctx;
  const landed = await poll(() => page.getByTestId('migration-notice').isVisible().catch(() => false), Boolean, 30000);
  const nav = await page.evaluate(() => document.querySelector('[data-testid="settings-nav"] [aria-current="page"]')
    ?.dataset.section ?? null);
  record('MP-08 after migrating, this launch opens Settings → Models with the migration notice on top', landed.ok
    && await page.getByTestId('settings-page').isVisible() && nav === 'models', `nav ${nav}`);
  await shot(ctx, 'mp08-notice');
  const lines = await page.locator('[data-testid="migration-notice"] li').allTextContents();
  const has = (text) => lines.some((line) => line.includes(text));
  record('MP-08 notice: every v0 provider is imported, not only mori-endpoint ("Imported: Fake Endpoint, Cipher, Env '
    + 'Box, Env Box 2, Reserved")', ['Fake Endpoint', 'Cipher', 'Env Box', 'Env Box 2', 'Reserved']
    .every((name) => lines.some((line) => line.startsWith('Imported:') && line.includes(name))), lines.join(' | '));
  record('MP-08 notice: rewritten ids are listed (invalid id, conflict with an existing id, reserved id)',
    has('Renamed provider fake#1 to fake-1') && has('Renamed provider Env Box to env-box-2')
    && has('Renamed provider openai to openai-2'), lines.filter((l) => l.startsWith('Renamed')).join(' | '));
  record('MP-08 notice: the unsupported API type, the provider without usable models and the bad model are listed',
    has('Dropped gemini-ish: API type "google-generative-ai" is not supported') && has('Dropped empty-models:')
    && has('Dropped mori-endpoint/bad model:'), lines.filter((l) => l.startsWith('Dropped')).join(' | '));
  record('MP-08 notice: dropped compat fields are listed (a value v0 never wrote, an unknown field)',
    has('Dropped mori-endpoint compat.supportsStore:') && has('Dropped mori-endpoint compat.thinkingFormat:'));
  record('MP-08 notice: the $ENV key is listed as "Add the API key again for: Env Box 2"',
    has('Add the API key again for: Env Box 2'), lines.join(' | '));
  record('MP-08 notice: ciphertext wins over the key written in models.json ("Kept the saved key for: Cipher; the key '
    + 'written in models.json was ignored.")', has('Kept the saved key for: Cipher; the key written in models.json was '
    + 'ignored.'));
}

/** @brief 迁移写下的文件：配置、密文、思考强度、v0 文件不改、说明里没有 key。 */
function migratedFiles(ctx, v0Text) {
  const { userData } = ctx;
  const cfg = readConfig(userData);
  const ids = cfg?.providers.map((p) => p.id) ?? [];
  record('MP-08 model-config.json: the five usable providers with rewritten ids, all zones unconfirmed (null), no '
    + 'groups',
    JSON.stringify(ids) === JSON.stringify(Object.keys(MIGRATED)) && cfg.providers.every((p) => p.zone === null)
    && cfg.groups.length === 0, JSON.stringify(ids));
  const main = providerOf(cfg, 'mori-endpoint');
  record('MP-08 keys keep the v0 ref: mori-endpoint (plaintext encrypted) and fake#1 (saved ciphertext), '
    + 'nextKeyNumber 1; the $ENV provider has no key', JSON.stringify(main?.keys) === '[{"ref":"mori-endpoint",'
    + '"label":"Key 1"}]' && JSON.stringify(providerOf(cfg, 'fake-1')?.keys) === '[{"ref":"fake#1","label":"Key 1"}]'
    && main.nextKeyNumber === 1 && providerOf(cfg, 'env-box-2')?.keys.length === 0,
  JSON.stringify(cfg?.providers.map((p) => [p.id, p.keys.map((k) => k.ref)])));
  const creds = readJson(join(userData, 'credentials.json')) ?? {};
  record('MP-08 the hand-written plaintext key is encrypted into credentials.json under ref mori-endpoint',
    'mori-endpoint' in creds && /^[A-Za-z0-9+/]+=*$/.test(creds['mori-endpoint'] ?? ''), Object.keys(creds).join(','));
  record('MP-08 compat keeps only the value v0 wrote; maxTokens ≥ window becomes half the window',
    JSON.stringify(main?.compat) === '{"supportsDeveloperRole":false}' && main.models[0].maxTokens === 16000,
    JSON.stringify(main?.compat));
  record('MP-08 the v0 default model becomes the default range (mori-endpoint/fake-coder)',
    cfg?.normalDefault === 'mori-endpoint/fake-coder', String(cfg?.normalDefault));
  const levels = readJson(join(userData, 'pi', 'settings.json'))?.modelThinkingLevels ?? {};
  record('MP-08 modelThinkingLevels is copied to the rewritten key (env-box-2/m1) and the old key stays',
    levels['env-box-2/m1'] === 'high' && levels['Env Box/m1'] === 'high', JSON.stringify(levels));
  record('MP-08 the v0 models.json is left as it was', readText(join(userData, 'pi', 'models.json')) === v0Text);
  const hits = filesWithSecrets(userData, [join(userData, 'pi', 'models.json')]);
  record('MP-26 no plaintext key in model-migration.json, model-config.json or any other file after the migration '
    + '(the v0 models.json itself excepted)', existsSync(join(userData, 'model-migration.json')) && hits.length === 0,
  hits.join('; '));
}

/** @brief 区域建议（§12）：Confirm zone 对话框预选的值与 models.get 的 zoneSuggestions。 */
async function zoneSuggestions(ctx) {
  const { page } = ctx;
  const chosen = {};
  for (const id of Object.keys(MIGRATED)) {
    await page.locator(`[data-testid="zone-unconfirmed"][data-provider="${id}"] [data-action="confirm-zone"]`).click();
    const dialog = page.getByTestId('zone-dialog');
    await dialog.waitFor({ timeout: 5000 });
    chosen[id] = await dialog.locator('input[name="zone"]:checked').getAttribute('value');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
  }
  const info = await page.evaluate(() => window.mori.request({ type: 'models.get' }));
  record('MP-08 zone suggestions follow §12 (127.0.0.1 → Local, dotless host and .local → Intranet, other names → '
    + 'Public), preselected in Confirm zone', JSON.stringify(chosen) === JSON.stringify(MIGRATED)
    && Object.entries(MIGRATED).every(([id, zone]) => info.zoneSuggestions?.[id] === zone), JSON.stringify(chosen));
  const unchanged = readConfig(ctx.userData)?.providers.every((p) => p.zone === null);
  record('MP-08 Cancel in Confirm zone writes nothing (zones stay unconfirmed)', unchanged);
  await zoneRules(ctx);
}

/** 各种地址与 §12 给出的建议区域 */
const ZONE_RULES = {
  'http://127.5.5.5:8000/v1': 'local', 'http://localhost:11434/v1': 'local', 'http://[::1]:8000/v1': 'local',
  'http://10.1.2.3:8000/v1': 'intranet', 'http://172.20.0.5/v1': 'intranet', 'http://172.32.0.1/v1': 'public',
  'http://192.168.1.10/v1': 'intranet', 'http://169.254.1.1/v1': 'intranet', 'http://[fd00::1]:8000/v1': 'intranet',
  'http://[fe80::1]/v1': 'intranet', 'http://[::ffff:192.168.1.10]/v1': 'intranet',
  'http://[::ffff:8.8.8.8]/v1': 'public', 'http://box.local/v1': 'intranet', 'http://gpu-box:8000/v1': 'intranet',
  'https://api.example.com/v1': 'public',
};

/** @brief 区域建议的规则（§12）：在 Add provider 表单里逐个输入地址，读预选的区域，不保存（只在界面里算，不发请求）。 */
async function zoneRules(ctx) {
  const { page } = ctx;
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  const wrong = [];
  for (const [address, zone] of Object.entries(ZONE_RULES)) {
    await form.getByLabel('Base URL', { exact: true }).fill(address);
    const chosen = await form.locator('input[name="zone"]:checked').getAttribute('value');
    if (chosen !== zone) wrong.push(`${address} → ${chosen} (want ${zone})`);
  }
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 5000 });
  record('MP-08 zone suggestions follow every §12 rule (loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, '
    + 'fe80::/10, IPv4-mapped IPv6, .local, dotless host, others public)', wrong.length === 0, wrong.join('; '));
}

/** @brief 区域未确认时会话被拒绝；Confirm zone 带到区域未确认的那一行；确认后可以发送，用迁移来的 key。 */
async function unconfirmedBlocked(ctx, project) {
  const { page, userData } = ctx;
  await backToChat(page);
  await openFolder(ctx, project);
  const card = (await waitCard(page, (s) => s?.kind === 'no_candidate', 20000)).value;
  const candidate = card?.candidates.find((c) => c.ref === 'mori-endpoint/fake-coder');
  const attempt = await trySend(ctx, fakes.migrate, 'plain before confirming');
  record('MP-08 a provider whose zone is unconfirmed is excluded until confirmed ("network zone not confirmed"); the '
    + 'session is blocked and offers Confirm zone', candidate?.reason === 'zone_unconfirmed'
    && candidate.text.includes('network zone not confirmed') && card.actions.some((a) => a.action === 'confirm-zone')
    && attempt.disabled && attempt.requests === 0, cardText(card));
  await page.locator(`${CARD} [data-action="confirm-zone"]`).click();
  const focus = await poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="zone-unconfirmed"]')
    ?.dataset.provider ?? null), (v) => v === 'mori-endpoint', 8000);
  record('MP-08 Confirm zone on the card opens Settings → Models with focus on that provider\'s unconfirmed row',
    focus.ok, String(focus.value));
  await confirmZone(page, 'mori-endpoint');
  const saved = await waitConfig(userData, (cfg) => providerOf(cfg, 'mori-endpoint')?.zone === 'local');
  await backToChat(page);
  const cleared = await waitCard(page, (s) => s === null, 60000);
  const since = Date.now();
  const reply = cleared.ok ? await sendText(ctx, 'plain after confirming') : null;
  const keys = chatsOf(fakes.migrate, since).map((c) => c.key);
  record(`MP-08 after Confirm zone the session sends with the migrated (encrypted) key (…${last4(KEY.v0plain)})`,
    saved.ok && cleared.ok && reply?.text.includes(REPLY) && keys.length > 0
    && keys.every((k) => k === last4(KEY.v0plain)), `${cardText(cleared.value)} | ${keys.join(',')}`);
}

/** @brief 在设置页确认一个提供商的区域（对话框里预选的值）。 */
async function confirmZone(page, id) {
  const row = page.locator(`[data-testid="zone-unconfirmed"][data-provider="${id}"]`);
  await row.locator('[data-action="confirm-zone"]').click();
  const dialog = page.getByTestId('zone-dialog');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  await row.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief fake-1（v0 的 fake#1）用已存的密文，不用 models.json 里手写的 key。 */
async function cipherWins(ctx) {
  const { page } = ctx;
  await openSettings(page);
  await confirmZone(page, 'fake-1');
  await backToChat(page);
  await choosePick(page, 'fake-1/fake-coder');
  const cleared = await waitCard(page, (s) => s === null, 60000);
  const since = Date.now();
  const reply = cleared.ok ? await sendText(ctx, 'plain via cipher') : null;
  const keys = chatsOf(fakes.migrate, since).map((c) => c.key);
  record(`MP-08 the saved ciphertext wins: fake-1 sends with it (…${last4(KEY.v0cipher)}), never with the key written `
    + 'in models.json', reply?.text.includes(REPLY) && keys.length > 0 && keys.every((k) => k === last4(KEY.v0cipher))
    && !fakes.migrate.chats.some((c) => c.key === last4(KEY.v0ignored)), keys.join(','));
}

/** @brief Dismiss 后说明消失、文件删除；改 models.json 后重启：不再迁移、不再打开设置页、说明不回来。 */
async function dismissAndEdit(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  await page.locator('[data-testid="migration-notice"] [data-action="dismiss"]').click();
  const gone = await poll(() => page.getByTestId('migration-notice').count(), (n) => n === 0, 10000);
  record('MP-08 Dismiss removes the notice and deletes model-migration.json', gone.ok
    && !existsSync(join(userData, 'model-migration.json')));
  await backToChat(page);
  await ctx.app.close().catch(() => {});
  await sleep(500);
  const modelsPath = join(userData, 'pi', 'models.json');
  // synthetic test setup：迁移之后手工改 v0 的 models.json（加一个提供商、改名）
  writeFileSync(modelsPath, readText(modelsPath).replace('"Fake Endpoint"', '"Renamed Later"')
    .replace('"providers": {', `"providers": {\n    "late": { "name": "Late", "baseUrl": "${url(PORT.migrate)}", `
      + '"api": "openai-completions", "models": [ { "id": "fake-coder" } ] },'));
  const before = readText(configFile(userData));
  const next = await startApp(userData);
  ctx.app = next.app;
  ctx.page = next.page;
  next.pageErrors.unshift(...ctx.pageErrors);
  ctx.pageErrors = next.pageErrors;
  await next.page.getByTestId('sidebar').waitFor({ timeout: 30000 });
  await sleep(2000);
  const settingsShown = await next.page.getByTestId('settings-page').isVisible().catch(() => false);
  await openSettings(next.page);
  const notice = await next.page.getByTestId('migration-notice').count();
  const cfg = readConfig(userData);
  record('MP-08 after Dismiss and a restart the notice does not come back and Settings is not opened at launch',
    !settingsShown && notice === 0 && !existsSync(join(userData, 'model-migration.json')));
  record('MP-08 editing models.json after the migration has no effect (no new provider, no rename, config unchanged)',
    readText(configFile(userData)) === before && !providerOf(cfg, 'late')
    && providerOf(cfg, 'mori-endpoint')?.name === 'Fake Endpoint');
}

/** @brief 迁移失败：models.json 读不出、没有一个 provider 能迁移；都不写配置，首次启动表单上方显示原文。 */
async function migrationFailure() {
  const cases = [
    ['models.json can\'t be parsed', '{ "providers": { "x": ', (t) => t.includes('Cannot parse')],
    ['no provider can be migrated', JSON.stringify({ providers: { odd: { baseUrl: 'http://127.0.0.1:9/v1',
      api: 'google-generative-ai', models: [{ id: 'x' }] } } }), (t) => t.includes('could be migrated')],
  ];
  for (const [label, text, test] of cases) {
    const userData = tempDir('mori-v1s-migfail-');
    mkdirSync(join(userData, 'pi'), { recursive: true });
    writeFileSync(join(userData, 'pi', 'models.json'), text); // synthetic test setup：迁移不了的 v0 文件
    let ctx;
    try {
      ctx = await startApp(userData);
      const form = await ctx.page.getByTestId('connection-form').isVisible();
      const error = await ctx.page.getByTestId('migration-error').textContent().catch(() => '');
      const prefix = 'Couldn’t import your previous model settings: ';
      record(`MP-08 migration failure (${label}): no model-config.json is written and the first-run form shows `
        + `"${prefix}<raw>"`, form && error.startsWith(prefix) && test(error)
        && !existsSync(configFile(userData)) && !existsSync(join(userData, 'model-migration.json')), oneLine(error));
    } catch (error) {
      record(`MP-08 migrationFailure (${label}): flow`, false, oneLine(error, 400));
      await shot(ctx, 'migrationFailure-error');
    } finally {
      await closeApp(ctx, 'MP-08');
    }
  }
}

// ---------- MP-10：加 key、删 key 后重新探测 ----------

/** @brief 模型行显示探针出错（"Couldn't verify: …"）且不在探测中。 */
const probeFailed = async (page, ref) => (await toolCalling(page, ref)) === 'unverified'
  && modelRow(page, ref).getByTestId('probe-error').isVisible().catch(() => false);

/** @brief 合成端点 since 之后收到的、带这个 key 的请求（探针或对话）。 */
const requestsWith = (fake, key, since) => fake.chats.filter((chat) => chat.key === last4(key) && chat.at >= since);

/**
 * @brief 规格 §7.4：加 key、删 key 也算修改提供商，档案不是 verified / failed 的模型自动重新探测。
 *   没有 key 时探针出错；加错的 key：重新探测、仍出错；加对的 key、删掉错的：重新探测并通过，全程不点 Verify。
 */
async function keyReprobe() {
  const userData = tempDir('mori-v1s-reprobe-');
  const ref = 'kr/fake-coder';
  // synthetic test setup：一个没有 key 的提供商，合成端点只认 KEY.right。
  writeJson(configFile(userData), seedConfig({ providers: [seedProvider('kr', 'Reprobe', PORT.reprobe, 'local')] }));
  let ctx;
  try {
    ctx = await startApp(userData);
    const { page } = ctx;
    await openSettings(page);
    const initial = await poll(() => probeFailed(page, ref), Boolean, 60000);
    let since = Date.now();
    await addKey(page, 'kr', KEY.wrong);
    const wrong = await poll(async () => requestsWith(fakes.reprobe, KEY.wrong, since).length > 0
      && probeFailed(page, ref), Boolean, 60000);
    record('MP-10 adding a key re-probes the never-verified model without Verify; with a wrong key the '
      + 'probes end in an error', initial.ok && wrong.ok, `no key: error ${initial.ok}; wrong key requests `
      + `${requestsWith(fakes.reprobe, KEY.wrong, since).length}, error ${wrong.ok}`);
    since = Date.now();
    await addKey(page, 'kr', KEY.right);
    await waitConfig(userData, (cfg) => keyRefs(cfg, 'kr')?.length === 2);
    await providerCard(page, 'kr').locator('[data-testid="key-row"][data-ref="kr#1"] [data-action="key-remove"]')
      .click();
    const replaced = await waitConfig(userData, (cfg) => JSON.stringify(keyRefs(cfg, 'kr')) === '["kr#2"]');
    const verified = await waitVerified(page, ref, 90000);
    const right = requestsWith(fakes.reprobe, KEY.right, since).filter((chat) => chat.probe);
    record('MP-10 replacing the wrong key with a right one (add right, remove wrong) re-probes and verifies the model '
      + 'without Verify', replaced.ok && verified.ok && right.length > 0,
    `keys ${JSON.stringify(keyRefs(replaced.value, 'kr'))}; tool calling ${verified.value}; `
      + `probe requests with the right key ${right.length}`);
  } catch (error) {
    record('MP-10 keyReprobe: flow', false, oneLine(error, 400));
    await shot(ctx, 'keyReprobe-error');
  } finally {
    await closeApp(ctx, 'MP-10');
  }
}

// ---------- 运行 ----------

const steps = { configInvalid, firstRunLocal, firstRunPublic, projectRules, settingsEdits, cascades, keyReprobe,
  migration, migrationFailure };

const keyed = [KEY.first, KEY.spare].join(',');
const fakeEnv = {
  keyed: [PORT.keyed, { FAKE_KEYS: keyed }], invalid: [PORT.invalid], pub: [PORT.pub], seeded: [PORT.seeded],
  moved: [PORT.moved], migrate: [PORT.migrate, { FAKE_KEYS: [KEY.v0plain, KEY.v0cipher].join(',') }],
  cascade: [PORT.cascade], edits: [PORT.edits], reprobe: [PORT.reprobe, { FAKE_KEYS: KEY.right }],
};
for (const [name, [port, env]] of Object.entries(fakeEnv)) fakes[name] = await startFake(port, env);
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && !only.includes(name)) continue;
    console.log(`[v1-models-app-settings] step ${name}`);
    await step();
  }
} finally {
  for (const fake of Object.values(fakes)) fake.child.kill();
}
const leaked = secretsIn(allLogs.join('\n'));
record('MP-26 no plaintext key in any app log collected by this run (stdout/stderr of every launch, page console)',
  leaked.length === 0 && allLogs.length > 0, `${allLogs.length} chunks; found ${leaked.join(',')}`);
const hits = dataDirs.flatMap((dir) => filesWithSecrets(dir, [join(dir, 'pi', 'models.json')]));
record('MP-26 no plaintext key in any file of the data dirs and projects used by this run (v0 models.json excepted)',
  hits.length === 0, hits.slice(0, 5).join('; '));
record('MP-26 no plaintext key in this test\'s results', secretsIn(JSON.stringify(results)).length === 0);
console.log(`[v1-models-app-settings] data dirs: ${dataDirs.join(' ')}`);
process.exitCode = write(`${RESULT}.json`) ? 0 : 1;
