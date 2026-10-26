// v1 模型层整机测试（配置、设置页、首次启动、迁移）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint，synthetic），逐条检查 docs/specs/model-providers.md §14.2 中 App 层的这些条目：
//   MP-01 配置读不出（不显示首次启动表单、Models 只显示错误与 Reload、会话 config_invalid、文件不被覆盖）、
//         各种校验错误指出位置（经 Reload）、由名称生成 id、删掉 key 后编号不复用；
//   MP-02 保存后模型在会话里可用、合成端点只收到真正的 key（从不收到占位的 mori-pool）、删除的提供商不能再用；
//   MP-06 没有网络区域（2026-10-26，负责人走查 M3）：首次启动表单、设置页、提供商卡与表单都没有区域，配置文件里没有区域的
//         字段，新打开、从没授权过的项目里会话直接发送（原来的公网授权、Project access、项目配置缩小区域都删掉）；
//   MP-07 项目配置的未知字段（包括原来的 allowedZones）、坏 JSON、不存在的分组、不属于用户分组的项都让会话按
//         project_config 拒绝启动；
//   MP-10 加 key、删 key 也算修改提供商：未验证过的模型自动重新探测（错的 key 探测出错，换成对的 key 后不点 Verify 也通过）；
//   MP-08 从 v0 的 models.json 迁移（全部 provider、key 沿用原 ref、明文加密、密文优先、$ENV、不支持的接口、丢弃的兼容字段、
//         不合格的模型、改写的 id、默认范围、思考强度复制、迁移来的提供商没有区域、探针通过后马上能用、迁移后改 models.json 不生效、
//         Dismiss、迁移失败不写配置、迁移后这次启动停在 设置 → Models）；
//   MP-24 设置页的增删改立即写进配置并影响静态校验、确认框的连带改动、改地址删 key 且新端口收不到旧 key、分组的错误、
//         key 明文不回到界面、兼容选项的标签与说明（2026-10-26 起拖动排序在 v1-models-app-reorder.mjs）；
//   MP-26 key 不落盘（数据目录的全部文件、迁移说明、日志、本测试的结果）、Add key 后 F8 报告里没有 key；
//   MP-30 删除的连带改动；
//   MP-33 首次启动（打开文件夹后直接发送、tool calling 判定失败的说明、改模型 id 再测仍只有一个提供商）；
//         2026-10-26 起测试成功就进入主窗口（docs/v1/screens/first-run.md）：探针状态经进程桥读档案，判定失败的说明在
//         会话的拒绝启动卡上（firstRunToolFailure），改模型再测放在测试失败之后（fake-coder-404）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-app-settings.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/v1-models-app-settings(-packaged).json，截图在 test-results/v1-models-app-settings(-packaged)/。
// 合成端点用 4500–4519 之间的端口（与并行跑的其他测试错开）；2026-10-26 补的 testRecords 与 keyTestRecords（MP-41，Keys 一行的
// Test，U17）共用 4945（walkthrough-1026 各包的 4920–4949）。
// 下面写进数据目录的 model-config.json、pi/models.json、pi/settings.json 和项目的 .mori/models.json 都是
// synthetic test setup（测试准备），代码里逐处注明。key 都是测试自己生成的合成值，与任何真实服务无关。
// 一键拉取模型（docs/specs/model-discovery.md §13.4）：首次启动与 Add provider 是 Base URL 和 API key → Fetch models →
// 在清单里勾模型（page.mjs fetchIn、pickIn）；卡上加模型是 Fetch models → 勾选 → Add 1 model（cardAddModels）；
// 兼容选项在拉取后的 More settings 里；MP-24、MP-33 的检查照这个流程。合成端点的列表、详情请求的日志行（带 path）不算对话请求。
// 2026-10-26（WP-02，负责人走查 M1、M7）：兼容选项五个、上面一行说明，卡上的"Compatibility options"只对 OpenAI-compatible
// （settingsEdits 另写一个 Anthropic Messages 的提供商看卡）；模型行的 tool calling 读行上的 data-probe，探针出错读状态行
// probe-status；点 Test connection 之前读表单结果不等（page.mjs textNow）。

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import { activeFile, ctrlN, openRow, PANE, paneCount, stubFolder, waitPanes, waitReady } from './m3-helpers.mjs';
import { poll, readJson, readText } from './md-card-helpers.mjs';
import { readMain, waitProbe } from './md-firstrun-helpers.mjs';
import { cardAddModels, CONNECTED, fetchIn, FIRST_RUN_FORM, pickIn, PROVIDER_FORM, textNow } from './page.mjs';
import {
  cardText, chatsOf, choosePick, dialogInfo, filesUnder, menuPicks, paneReply, sendOnly, sendText, startFake, stopFake,
  testOnce, TEXTAREA, trySend, waitCard, waitReply,
} from './v1-settings-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const RESULT = `v1-models-app-settings${suffix}`;
const shots = join(appRoot, 'test-results', RESULT);
mkdirSync(shots, { recursive: true });
const { results, record, write } = createRecorder(exePath ?? 'dev build');

/** 合成端点的端口（4500–4519；records 为 4945） */
const PORT = { keyed: 4500, invalid: 4503, fresh: 4504, seeded: 4505, moved: 4506, migrate: 4507, cascade: 4508,
  edits: 4509, reprobe: 4510, records: 4945 };
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
  keyTest: 'synthetic-v1-settings-key-keytest-T2K2',
};
const SECRETS = Object.values(KEY);
const last4 = (key) => key.slice(-4);
/** pi 里的占位 apiKey（§12）的末 4 位 */
const PLACEHOLDER_TAIL = last4('mori-pool');
/** 合成端点 "plain" 的回复 */
const REPLY = '这是一段只有文字的回复，用来测试流式输出。';

/** 收集到的全部日志（每个 App 的 stdout/stderr 与界面 console），MP-26 检查里面没有 key */
const allLogs = [];
/** 每一步用过的数据目录（MP-26 最后再扫一遍） */
const dataDirs = [];
/** 合成端点 */
const fakes = {};

// ---------- 通用 ----------

// poll、readJson、readText 用 md-card-helpers.mjs 的（同一个写法，2026-10-26 WP-02 为文件行数挪走）
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const configFile = (dir) => join(dir, 'model-config.json');
const readConfig = (dir) => readJson(configFile(dir));
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
function seedProvider(id, name, port, ids = ['fake-coder']) {
  return { id, name, api: 'openai-completions', baseUrl: url(port), compat: {}, concurrency: 4, keys: [],
    nextKeyNumber: 1, models: ids.map((model) => ({ id: model, family: '', contextWindow: 131072, maxTokens: 8192,
      reasoning: false, input: ['text'] })) };
}

/** @brief 一份完整的用户级配置（synthetic test setup 用）。 */
function seedConfig({ providers, groups = [], normalDefault = null }) {
  return { version: 1, providers, groups, normalDefault };
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

const providerCard = (page, id) => page.locator(`[data-testid="provider-card"][data-provider="${id}"]`);
const modelRow = (page, ref) => page.locator(`[data-testid="model-row"][data-model="${ref}"]`);
const dialogOf = (page, kind) => page.locator(`[data-testid="confirm-dialog"][data-kind="${kind}"]`);

/** @brief 模型行上 tool calling 的验证状态（data-probe，models-settings.md "Models 行"；取值同原来档案摘要的 Tool calling）。 */
const toolCalling = (page, ref) => modelRow(page, ref).getAttribute('data-probe', { timeout: 5000 }).catch(() => null);
const waitVerified = (page, ref, timeout = 60000) => poll(() => toolCalling(page, ref), (v) => v === 'verified',
  timeout, 300);

/**
 * @brief 设置页里新建提供商（Add provider 表单，model-discovery.md §6.1、§13.4）：Base URL 和 API key → Fetch models →
 *        Name → 清单里只勾 modelId（没列出的手填，page.mjs pickIn）→ Add 1 model，等表单关掉。返回拉取的结果。
 */
async function addProvider(page, { name, baseUrl, modelId = 'fake-coder', secret = '' }) {
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  if (secret) await form.getByLabel('API key', { exact: true }).fill(secret);
  const fetched = await fetchIn(page, PROVIDER_FORM);
  await form.getByLabel('Name', { exact: true }).fill(name);
  await pickIn(page, PROVIDER_FORM, [modelId]);
  await form.locator('[data-action="add-models"]').click();
  await form.waitFor({ state: 'detached', timeout: 20000 });
  return fetched;
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

/**
 * @brief 首次启动表单（model-discovery.md §6.6、§13.4）：Base URL 和 API key → Fetch models → Name → 清单里只勾 modelId
 *        （page.mjs pickIn）。
 */
async function fillFirstRun(page, { name, baseUrl, secret, modelId }) {
  const form = page.getByTestId('connection-form');
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  if (secret) await form.getByLabel('API key', { exact: true }).fill(secret);
  await fetchIn(page, FIRST_RUN_FORM);
  await form.getByLabel('Name', { exact: true }).fill(name);
  await pickIn(page, FIRST_RUN_FORM, [modelId]);
}

/**
 * @brief 点 Test connection，等结果文字（Connected / Connection failed / Couldn’t save）：成功时首次启动表单关掉，
 *        读主窗口 Open a folder 提示里的"Connected · …"（page.mjs CONNECTED，docs/v1/screens/first-run.md）；
 *        失败、已取消、保存失败时读表单里的原文。
 */
async function testConnection(page) {
  const form = page.locator(FIRST_RUN_FORM);
  const before = await textNow(form.getByTestId('form-message'));
  await form.locator('[data-action="test"]').click();
  const read = () => page.evaluate(({ connected, root }) => document.querySelector(connected)?.textContent
    ?? document.querySelector(`${root} [data-testid="form-message"]`)?.textContent ?? null,
  { connected: CONNECTED, root: FIRST_RUN_FORM });
  const result = await poll(read, (text) => text && text !== before
    && /^(Connected|Connection failed|Couldn’t test|Couldn’t save|Test cancelled)/.test(text), 90000);
  return result.value ?? '';
}

// 首次启动测试成功之后（2026-10-26 起表单下方没有探针状态，docs/v1/screens/first-run.md）：主窗口的 Open a folder
// 提示用 md-firstrun-helpers.mjs 的 readMain 读；测试的那个模型的探针经进程桥读 models.get 的档案，用它的 waitProbe 等
// （这里等的都是这个数据目录里从未探测过的模型，不用 since）。

/** @brief 等 credentials.json 里没有 ref（主进程删密文可能晚于配置写入），最多 5 秒；value 是最后读到的全部 ref。 */
const credsWithout = (dir, ref) => poll(() => Object.keys(readJson(join(dir, 'credentials.json')) ?? {}),
  (refs) => !refs.includes(ref), 5000);

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
  ['the zone fields removed on 2026-10-26 (zone, allowedZones, projectZones)', (c) => {
    c.providers[0].zone = 'public'; c.allowedZones = ['local', 'intranet']; c.projectZones = {};
  }, ['providers.0', '"zone"', '"allowedZones"', '"projectZones"']],
  ['default range naming a missing model', (c) => { c.normalDefault = 'ghost/model'; },
    ['normalDefault', 'ghost/model is not in your model settings']],
  ['group member naming a missing provider', (c) => { c.groups[0].members.push('ghost'); },
    ['groups.0.members.1', 'ghost']],
  ['nextKeyNumber going back', (c) => { c.providers[0].keys = [{ ref: 'alpha#3', label: 'Key 3' }]; },
    ['providers.0.nextKeyNumber']],
];

/** @brief MP-01 的合法配置：一个没有 key 的本机提供商 alpha 和分组 team（synthetic test setup）。 */
const invalidBase = () => seedConfig({ providers: [seedProvider('alpha', 'Alpha', PORT.invalid)],
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
    sections: ['defaults', 'providers', 'groups', 'migration-notice']
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
  const full = await poll(() => page.evaluate(() => ['defaults', 'providers', 'groups']
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

/**
 * @brief 填首次启动表单，测试连接：成功后表单关掉、进入主窗口的 Open a folder 提示
 *        （"Connected · …"在标题下面，first-run.md "测试成功之后：主窗口"）；再经进程桥等测试的那个模型的探针。
 */
async function localForm(ctx) {
  const { page, userData } = ctx;
  const title = await page.locator('h2').first().textContent();
  await fillFirstRun(page, { name: 'Fake Local', baseUrl: url(PORT.keyed), secret: KEY.first, modelId: 'fake-coder' });
  record('MP-33 first run (Local): the form is "Connect a model"', title === 'Connect a model', title);
  const message = await testConnection(page);
  record('MP-33 first run (Local): Test connection saves and reports "Connected · First token Nms · Total Nms"',
    /^Connected · First token \d+ms · Total \d+ms/.test(message), message);
  const main = await readMain(page);
  record('MP-33 first run (Local): the passed test closes the first-run form and opens the main window: "Open a '
    + 'folder" with the "Connected · …" line under it and Open folder…', !main.form && main.sidebar
    && main.prompt?.heading === 'Open a folder' && main.prompt.connected === message && main.prompt.open,
  oneLine(JSON.stringify(main), 300));
  const probe = await waitProbe(page, 'fake-local/fake-coder', { timeout: 90000 });
  record('MP-33 first run (Local): after the hand-over the probes keep running and the tested model ends at tool '
    + 'calling verified (models.get; no probe status on a form any more)', probe === 'verified', probe);
  const cfg = readConfig(userData);
  const provider = cfg?.providers?.[0];
  record('MP-33 first run (Local): model-config.json has the provider, its model, key ref <id>#1 and '
    + 'normalDefault', cfg?.providers.length === 1 && provider.id === 'fake-local'
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

// ---------- MP-06、MP-33：没有网络区域（2026-10-26，负责人走查 M3；原来是首次启动选 Public 与 Project access） ----------

/**
 * @brief 首次启动表单里没有 Network zone；测试失败时表单留着，改勾选的模型再测；新打开、从没授权过的项目里会话不被拒绝、
 *        直接发送；设置页没有区域与 Project access；配置文件里没有区域的字段。
 */
async function noZones() {
  const userData = tempDir('mori-v1s-nozones-');
  const project = makeProject(tempDir('mori-v1s-nozones-proj-'), 'FreshProj');
  let ctx;
  try {
    ctx = await startApp(userData);
    await retestForm(ctx);
    await freshProject(ctx, project);
    await noZoneSettings(ctx);
  } catch (error) {
    record('MP-06 noZones: flow', false, oneLine(error, 400));
    await shot(ctx, 'noZones-error');
  } finally {
    await closeApp(ctx, 'MP-06');
  }
}

/** @brief 表单里的区域字段：zone 单选的个数、Public 的说明、"Network zone"的字样。 */
const zoneFields = (form) => form.evaluate((root) => ({ radios: root.querySelectorAll('input[name="zone"]').length,
  note: Boolean(root.querySelector('[data-testid="zone-public-note"]')),
  label: root.textContent.includes('Network zone') }));
/** @brief 表单里没有任何区域字段。 */
const noZoneField = (seen) => seen.radios === 0 && !seen.note && !seen.label;

/**
 * @brief 首次启动表单没有 Network zone；测试失败（fake-coder-404）时表单留着；改勾选的模型再测仍只有一个提供商，测试成功
 *        进入主窗口。fake-coder-404：合成端点对不是探针的请求回 404（server.mjs 的 -404 后缀），测试连接因此失败；端点的
 *        列表里没有它，pickIn 用 Add a model ID 手填。2026-10-26 起测试成功就关掉表单（first-run.md），改模型再测只能在测试
 *        没有成功之后。
 */
async function retestForm(ctx) {
  const { page, userData } = ctx;
  await fillFirstRun(page, { name: 'Fake Fresh', baseUrl: url(PORT.fresh), modelId: 'fake-coder-404' });
  const fields = await zoneFields(page.locator(FIRST_RUN_FORM));
  record('MP-06 the first-run form has no Network zone: no zone radios and no "Public providers must be allowed per '
    + 'project" note after Fetch models', noZoneField(fields), JSON.stringify(fields));
  const first = await testConnection(page);
  const before = readConfig(userData);
  const stays = await readMain(page);
  record('MP-33 a failed test keeps the first-run form: fake-coder-404 answers the test with 404, the form says '
    + '"Connection failed: <raw>" and the main window does not open', first.startsWith('Connection failed: ')
    && stays.form && stays.prompt === null && before?.providers.length === 1, `${first} | ${JSON.stringify(stays)}`);
  // model-discovery.md §13.4：改模型 id 改为在清单里换勾的模型（取消手填的 fake-coder-404，勾 fake-coder）
  await pickIn(page, FIRST_RUN_FORM, ['fake-coder']);
  const second = await testConnection(page);
  const after = readConfig(userData);
  const provider = after?.providers?.[0];
  record('MP-33 after the failed test, ticking another model in the checklist (fake-coder instead of fake-coder-404) '
    + 'and testing again there is still one provider, with only the new model; the passed test opens the main window',
  before?.providers.length === 1 && after?.providers.length === 1 && provider.id === before.providers[0].id
    && JSON.stringify(provider.models.map((m) => m.id)) === '["fake-coder"]'
    && after.normalDefault === `${provider.id}/fake-coder` && second.startsWith('Connected')
    && (await readMain(page)).prompt?.connected === second,
  oneLine(JSON.stringify(after?.providers.map((p) => ({ id: p.id, models: p.models.map((m) => m.id) })))));
  const again = await waitProbe(page, `${provider?.id}/fake-coder`, { timeout: 90000 });
  record('MP-33 the retest verifies tool calling (models.get)', again === 'verified', again);
}

/** @brief 打开一个从没打开过的项目：没有拒绝启动卡，直接发送，合成端点收到请求；配置文件里没有区域的字段。 */
async function freshProject(ctx, project) {
  const { page, userData } = ctx;
  await openFolder(ctx, project);
  const card = await waitCard(page, (s) => s === null, 30000);
  const since = Date.now();
  const reply = card.ok ? await sendText(ctx, 'plain fresh project') : null;
  record('MP-33 first run → Open folder… → the new session is not blocked; it sends and gets the reply',
    card.ok && Boolean(reply?.text.includes(REPLY)), `${cardText(card.value)} | ${oneLine(reply?.text ?? '')}`);
  record('MP-06 a project opened for the first time needs no grant: no blocked card, and the provider receives the '
    + 'session\'s request', card.ok && chatsOf(fakes.fresh, since).some((c) => c.model === 'fake-coder'),
  `${chatsOf(fakes.fresh, since).length} request(s)`);
  const cfg = readConfig(userData);
  const keys = [...Object.keys(cfg ?? {}), ...(cfg?.providers ?? []).flatMap((p) => Object.keys(p))];
  record('MP-06 model-config.json written by the first run has no zone, allowedZones or projectZones',
    cfg !== null && !keys.some((key) => ['zone', 'allowedZones', 'projectZones'].includes(key)),
    JSON.stringify(Object.keys(cfg ?? {})));
}

/** @brief 设置 → Models 没有 Project access、Allowed zones、区域未确认的几行；卡、Edit 与 Add provider 都没有 Network zone。 */
async function noZoneSettings(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  // models-settings.md 标识表“删掉的”一行：这些标识在页面上（含对话框）都不在
  const seen = await page.getByTestId('models-section').evaluate((root) => ({
    gone: ['project-access', 'project-row', 'project-zone', 'project-config-error', 'projects-empty', 'allowed-zone',
      'zone-unconfirmed', 'zone-dialog', 'public-dialog', 'provider-zone']
      .filter((id) => document.querySelector(`[data-testid="${id}"]`)),
    actions: ['confirm-zone', 'allow-zone'].filter((id) => document.querySelector(`[data-action="${id}"]`)),
    words: ['Project access', 'Allowed zones', 'Network zone', 'Confirm zone']
      .filter((w) => root.textContent.includes(w)),
  }));
  record('MP-06 Settings → Models has no Project access, no "Allowed zones for all projects", no unconfirmed-zone '
    + 'rows and no "Network zone" on the provider card (none of the removed test ids: project-access, project-row, '
    + 'project-zone, project-config-error, projects-empty, allowed-zone, zone-unconfirmed, zone-dialog, public-dialog, '
    + 'provider-zone, confirm-zone, allow-zone)', seen.gone.length === 0 && seen.actions.length === 0
    && seen.words.length === 0, JSON.stringify(seen));
  const id = readConfig(userData)?.providers?.[0]?.id;
  await providerCard(page, id).locator('[data-action="edit-provider"]').click();
  const edit = page.getByTestId('provider-form');
  await edit.waitFor({ timeout: 5000 });
  const editFields = await zoneFields(edit);
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await edit.waitFor({ state: 'detached', timeout: 5000 });
  await page.locator('[data-action="add-provider"]').click();
  await edit.getByLabel('Base URL', { exact: true }).fill(url(PORT.fresh));
  await fetchIn(page, PROVIDER_FORM);
  const addFields = await zoneFields(edit);
  await edit.locator('[data-action="close-form"]').click();
  await edit.waitFor({ state: 'detached', timeout: 5000 });
  record('MP-06 Edit provider and Add provider (after Fetch models) have no Network zone',
    noZoneField(editFields) && noZoneField(addFields), JSON.stringify({ editFields, addFields }));
  await backToChat(page);
}

// ---------- MP-33：首次启动测试的模型 tool calling 判定失败（2026-10-26 起说明在会话的拒绝启动卡上） ----------

/**
 * @brief 首次启动只勾 fake-coder-notools（合成端点第 3 步不调工具）：测试连接照样成功、进入主窗口；探针判定失败后，
 *        打开文件夹的新会话按 no_candidate 拒绝启动，卡上写出原因（"tool calling failed verification"），
 *        操作是 Change model… 与 Open settings，没有 Verify now（first-run.md "打开文件夹之后"）。
 */
async function firstRunToolFailure() {
  const userData = tempDir('mori-v1s-notools-');
  const project = makeProject(tempDir('mori-v1s-notools-proj-'), 'proj');
  let ctx;
  try {
    ctx = await startApp(userData);
    const { page } = ctx;
    await fillFirstRun(page, { name: 'Fake Tools', baseUrl: url(PORT.fresh), modelId: 'fake-coder-notools' });
    const message = await testConnection(page);
    const probe = await waitProbe(page, 'fake-tools/fake-coder-notools', { timeout: 90000 });
    record('MP-33 tool calling failed (-notools): the test still passes and opens the main window; the probes end at '
      + 'failed (models.get)', message.startsWith('Connected') && (await readMain(page)).prompt?.connected === message
      && probe === 'failed', `${message} | ${probe}`);
    await openFolder(ctx, project);
    const card = (await waitCard(page, (s) => s?.kind === 'no_candidate', 30000)).value;
    const candidate = card?.candidates.find((c) => c.ref === 'fake-tools/fake-coder-notools');
    const labels = card?.actions.map((a) => a.label) ?? [];
    record('MP-33 tool calling failed (-notools): the new session is blocked with "This session can’t start: no model '
      + 'fits.", the candidate says "tool calling failed verification", and the card offers Change model… and Open '
      + 'settings (no Verify now)', card?.title === 'This session can’t start: no model fits.'
      && candidate?.reason === 'failed' && candidate.text.includes('tool calling failed verification')
      && JSON.stringify(labels) === '["Change model…","Open settings"]', cardText(card));
  } catch (error) {
    record('MP-33 firstRunToolFailure: flow', false, oneLine(error, 400));
    await shot(ctx, 'firstRunToolFailure-error');
  } finally {
    await closeApp(ctx, 'MP-33');
  }
}

// ---------- MP-07：项目配置（预先写好的配置） ----------

/**
 * @brief MP-07 与 MP-24 用的配置（synthetic test setup）：三个提供商（nt 的模型 tool calling 判定不通过）与分组 team。
 *        2026-10-26 起没有网络区域（负责人走查 M3），原来的公网、内网提供商换成这两个。
 */
const teamConfig = (port) => seedConfig({
  providers: [seedProvider('loc', 'Local A', port), seedProvider('nt', 'No Tools B', port, ['fake-coder-notools']),
    seedProvider('intra', 'Intra C', port)],
  groups: [{ id: 'team', members: ['loc/fake-coder', 'nt'] }], normalDefault: 'loc/fake-coder' });

/** 项目配置的几种写法（synthetic test setup）与 MP-07 期望在拒绝启动卡里看到的原因 */
const PROJECT_CONFIGS = {
  unknown: { groups: { team: ['loc/fake-coder'] }, providers: {} },
  oldZones: { allowedZones: ['local'] },
  badJson: '{ "groups": [',
  noGroup: { groups: { ghost: ['loc/fake-coder'] } },
  stray: { groups: { team: ['intra/fake-coder'] } },
};

/** @brief 五种无效的项目配置。 */
async function projectRules() {
  const userData = tempDir('mori-v1s-project-');
  const root = tempDir('mori-v1s-project-proj-');
  const projects = Object.fromEntries(Object.entries(PROJECT_CONFIGS)
    .map(([name, models]) => [name, makeProject(root, `${name}Proj`, models)]));
  writeJson(configFile(userData), teamConfig(PORT.seeded));
  let ctx;
  try {
    ctx = await startApp(userData);
    await invalidProjects(ctx, projects);
  } catch (error) {
    record('MP-07 projectRules: flow', false, oneLine(error, 400));
    await shot(ctx, 'projectRules-error');
  } finally {
    await closeApp(ctx, 'MP-07');
  }
}

/**
 * @brief 五种无效的项目配置：会话按 project_config 拒绝启动并显示原因（2026-10-26 起只在拒绝启动卡上显示，设置页没有
 *        Project access 了；原来的 allowedZones 也是未知字段）。
 */
async function invalidProjects(ctx, projects) {
  const { page } = ctx;
  const cases = [
    ['unknown field', 'unknown', (t) => t.includes('providers')],
    ['the allowedZones field removed on 2026-10-26', 'oldZones', (t) => t.includes('allowedZones')],
    ['bad JSON', 'badJson', (t) => /JSON|Unexpected|Expected/i.test(t)],
    ['a group that does not exist', 'noGroup', (t) => t.includes('ghost is not in your model settings')],
    ['an item that is not in the user\'s group', 'stray', (t) => t.includes('intra/fake-coder is not a member of group '
      + 'team')],
  ];
  for (const [label, name, test] of cases) {
    await openFolder(ctx, projects[name]);
    const card = (await waitCard(page, (s) => s?.kind === 'project_config', 20000)).value;
    const reason = card?.title.replace(/^\.mori\/models\.json: /, '') ?? '';
    const attempt = await trySend(ctx, fakes.seeded, 'plain project config');
    record(`MP-07 ${label} in .mori/models.json blocks the session (project_config) with ".mori/models.json: <reason>"`,
      card?.title.startsWith('.mori/models.json: ') && test(reason)
      && card.actions.map((a) => a.action).join() === 'open-settings' && attempt.disabled && attempt.requests === 0,
      cardText(card));
  }
}

// ---------- MP-24：设置页的增删改 ----------

/** @brief 设置页的各种修改立即写进配置并影响打开的会话。 */
async function settingsEdits() {
  const userData = tempDir('mori-v1s-edits-');
  const project = makeProject(tempDir('mori-v1s-edits-proj-'), 'proj');
  // synthetic test setup：MP-07 的三个提供商，再加一个接口为 Anthropic Messages 的、一个存着兼容选项的（compatOptions
  // 看它们的卡与 Edit）
  const team = teamConfig(PORT.edits);
  writeJson(configFile(userData), { ...team, providers: [...team.providers, ANTHROPIC_SEED, COMPAT_SEED] });
  let ctx;
  try {
    ctx = await startApp(userData);
    ctx.main = await openFolder(ctx, project);
    await waitCard(ctx.page, (s) => s === null, 60000);
    await editDefaults(ctx);
    await defaultsFailure(ctx);
    await editProvider(ctx);
    await compatOptions(ctx);
    await editKeys(ctx);
    await editAddress(ctx);
    await editModels(ctx);
    await editGroups(ctx);
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

/** @brief Defaults：默认范围（新会话用它、打开的会话不变）。2026-10-26 起没有“Allowed zones for all projects”。 */
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
  ctx.second = second;
}

/**
 * @brief Defaults 的保存中与保存失败（models-settings.md “Defaults”的“保存”）：经进程桥建一个分组 gone，打开设置页（页面读到
 *        它），再经进程桥删掉它（页面不重新读，还在下拉里），在下拉里选它：保存中下拉不可用、显示选的值；后台进程拒绝
 *        （配置校验：gone 不在设置里），原文显示在这一节下面，下拉回到保存前的值，配置不变。
 */
async function defaultsFailure(ctx) {
  const { page, userData } = ctx;
  const bridge = (command) => page.evaluate((item) => window.mori.request(item), command);
  await bridge({ type: 'models.saveGroup', id: 'gone', members: ['intra/fake-coder'], creating: true });
  await openSettings(page);
  await bridge({ type: 'models.deleteGroup', id: 'gone', dryRun: false });
  const pick = page.getByTestId('default-pick');
  await pick.evaluate((select) => {
    window.__defaultsSeen = [];
    const take = () => window.__defaultsSeen.push(`${select.disabled}|${select.value}`);
    window.__defaultsObserver = new MutationObserver(take);
    window.__defaultsObserver.observe(select.closest('section'), { subtree: true, childList: true, attributes: true });
  });
  await pick.selectOption('gone');
  const error = page.locator('[data-testid="defaults"] .form-message.error');
  const text = await error.textContent({ timeout: 10000 }).catch(() => null);
  const seen = await page.evaluate(() => {
    window.__defaultsObserver.disconnect();
    return window.__defaultsSeen;
  });
  const after = { value: await pick.inputValue(), disabled: await pick.isDisabled() };
  record('MP-24 Defaults: while the default range saves the select is unavailable showing the new value; when the '
    + 'save fails (the group was deleted behind the page) the raw text shows under Defaults, the select goes back to '
    + 'the value before and the config keeps it', seen.includes('true|gone') && text?.includes('gone is not in your '
    + 'model settings') && after.value === 'team' && !after.disabled && readConfig(userData)?.normalDefault === 'team',
  JSON.stringify({ seen, text, after }));
  await backToChat(page);
}

/**
 * @brief 编辑提供商：并发上限立即写进配置，打开的会话照常可以发送；新建提供商。2026-10-26 起 Edit 里没有区域，
 *        原来按区域重新校验的那一半删掉（删除提供商让会话 pick_missing 由 deletedProvider 查）。
 */
async function editProvider(ctx) {
  const { page, userData } = ctx;
  const edit = async (concurrency) => {
    await openSettings(page);
    await providerCard(page, 'loc').locator('[data-action="edit-provider"]').click();
    const form = page.getByTestId('provider-form');
    await form.getByLabel('Concurrency per key', { exact: true }).fill(String(concurrency));
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 15000 });
    await showSession(ctx, ctx.main);
  };
  await edit(2);
  const cfg = readConfig(userData);
  const usable = await waitCard(page, (s) => s === null, 15000);
  await edit(4);
  record('MP-24 Providers: Edit saves the concurrency at once (2, then 4 again) and the open session stays usable',
    providerOf(cfg, 'loc')?.concurrency === 2 && providerOf(readConfig(userData), 'loc')?.concurrency === 4
    && usable.ok, `${providerOf(cfg, 'loc')?.concurrency} → ${providerOf(readConfig(userData), 'loc')?.concurrency}`);
  await openSettings(page);
  await addProvider(page, { name: 'Extra D', baseUrl: url(PORT.edits) });
  const verified = await waitVerified(page, 'extra-d/fake-coder');
  record('MP-24 Providers: Add provider saves it (id from the name), shows its card and probes its model to Verified',
    Boolean(providerOf(readConfig(userData), 'extra-d')) && await providerCard(page, 'extra-d').count() === 1
    && verified.ok, String(verified.value));
}

/**
 * settingsEdits 里接口不是 OpenAI-compatible 的提供商（synthetic test setup）：地址是本机 9 号端口，连不上、不发到合成端点；
 * 只用来看卡上没有"Compatibility options"一行（models-settings.md "提供商卡"，2026-10-26）
 */
const ANTHROPIC_SEED = { ...seedProvider('anth', 'Anth E', 9), api: 'anthropic-messages' };

/**
 * settingsEdits 里存着兼容选项的 OpenAI-compatible 提供商（synthetic test setup，2026-10-26 补）：地址同样是本机 9 号端口；
 * compat 里有两个有勾选框的（developer role、max_tokens，键的先后与表单相反）和 2026-10-26 起没有勾选框的 supportsStrictMode
 */
const STORED_COMPAT = { supportsStrictMode: false, maxTokensField: 'max_tokens', supportsDeveloperRole: false };
const COMPAT_SEED = { ...seedProvider('cmp', 'Compat F', 9), compat: STORED_COMPAT };
/** @brief 按键名排序后的 JSON（比较 compat 时不计键的先后）。 */
const sortedJson = (value) => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort()));

/** 兼容选项上面的一行说明（models-settings.md "提供商表单：Edit"，2026-10-26 负责人走查 M1） */
const COMPAT_HINT = 'Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if '
  + 'this server rejects requests.';

/**
 * 兼容选项勾选框的标签与下面一行说明（§9.1，shared/models.ts COMPAT_LABELS、COMPAT_HINTS），按表单里的顺序；
 * 2026-10-26 起没有"Endpoint doesn’t support strict mode for tool parameters"
 */
const COMPAT_TEXTS = [
  ['Endpoint doesn’t support the developer role', 'Sends the system prompt with the system role instead'],
  ['Endpoint doesn’t accept the store field', 'Leaves store out of requests'],
  ['Endpoint needs max_tokens instead of max_completion_tokens',
    'Older endpoints don’t recognize max_completion_tokens'],
  ['Endpoint doesn’t report usage while streaming',
    'Doesn’t send stream_options, so the context usage shown will be inaccurate'],
  ['Tool results must include the tool name', 'Some endpoints require a name field on tool result messages'],
];

/**
 * @brief Add provider 表单的兼容选项：上面一行说明，五个勾选框各有标签和一行说明；API type 不是 OpenAI-compatible 时
 *        都不显示。不保存。提供商卡上的"Compatibility options"只对 OpenAI-compatible 的卡（2026-10-26，负责人走查 M1）。
 *        一键拉取模型（model-discovery.md §6.1 第 7 项、§13.4）：兼容选项在拉取之后的"More settings"里，先 Fetch models
 *        再点开它。
 */
async function compatOptions(ctx) {
  const { page } = ctx;
  await openSettings(page);
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(url(PORT.edits));
  await fetchIn(page, PROVIDER_FORM);
  await form.locator('[data-testid="more-settings"] summary').click();
  const rows = form.locator('.compat-checks label.check-row');
  const shown = await rows.evaluateAll((labels) => labels.map((label) => {
    const span = label.querySelector('span');
    return [span?.firstChild?.textContent ?? '', span?.querySelector('small')?.textContent ?? ''];
  }));
  const hint = await textNow(form.getByTestId('compat-hint'));
  const api = form.getByLabel('API type', { exact: true });
  await api.selectOption('anthropic-messages');
  const hidden = await rows.count() + await form.getByTestId('compat-hint').count();
  await api.selectOption('openai-completions');
  const back = await rows.count();
  await form.locator('[data-action="close-form"]').click();
  await form.waitFor({ state: 'detached', timeout: 5000 });
  record('MP-24 Add provider: a hint line above the compatibility options, then the five options each with its label '
    + 'and a hint line (english-ui wording; no strict-mode option); all hidden for other API types',
  JSON.stringify(shown) === JSON.stringify(COMPAT_TEXTS) && hint === COMPAT_HINT && hidden === 0
    && back === COMPAT_TEXTS.length, JSON.stringify({ shown, hint, hidden, back }));
  const cards = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(
    '[data-testid="provider-card"]')].map((card) => [card.dataset.provider,
    card.querySelector('[data-testid="provider-compat"]')?.textContent ?? null])));
  record('MP-24 provider cards show "Compatibility options" only for OpenAI-compatible providers: Local A "None"; '
    + 'Anth E (Anthropic Messages) has no such row', cards.loc === 'None' && 'anth' in cards && cards.anth === null,
  JSON.stringify(cards));
  record('MP-24 the card lists the ticked compatibility options by label only, comma-separated, in the form’s order '
    + '(Compat F: developer role, then max_tokens), without their hint lines; the stored supportsStrictMode has no '
    + 'checkbox since 2026-10-26 and is not listed', cards.cmp === `${COMPAT_TEXTS[0][0]}, ${COMPAT_TEXTS[2][0]}`,
  JSON.stringify(cards.cmp));
  await compatEdit(ctx);
}

/**
 * @brief Edit provider 的兼容选项（models-settings.md “提供商表单：Edit”，2026-10-26 负责人走查 M1）：标题、图例下面一行说明、
 *        正好五个勾选框（没有 strict mode），存着的两项勾着；只改并发上限再 Save，存着的 compat 原样保留（supportsStrictMode
 *        也在）。
 */
async function compatEdit(ctx) {
  const { page, userData } = ctx;
  await providerCard(page, 'cmp').locator('[data-action="edit-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.waitFor({ timeout: 5000 });
  const shown = await form.evaluate((root) => ({ title: root.querySelector('h3')?.textContent ?? '',
    legend: root.querySelector('.compat-checks legend')?.textContent ?? null,
    hint: root.querySelector('.compat-checks [data-testid="compat-hint"]')?.textContent ?? null,
    rows: [...root.querySelectorAll('.compat-checks label.check-row')].map((label) => {
      const span = label.querySelector('span');
      return [span?.firstChild?.textContent ?? '', span?.querySelector('small')?.textContent ?? ''];
    }), ticked: [...root.querySelectorAll('.compat-checks label.check-row input')].map((input) => input.checked) }));
  await form.getByLabel('Concurrency per key', { exact: true }).fill('3');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const saved = await waitConfig(userData, (cfg) => providerOf(cfg, 'cmp')?.concurrency === 3);
  const compat = providerOf(saved.value, 'cmp')?.compat ?? null;
  record('MP-24 Edit provider (OpenAI-compatible) "Edit provider · Compat F": under the legend "Compatibility options" '
    + 'the hint line, then exactly the five options with labels and hint lines (no strict-mode option), the stored '
    + 'two (developer role, max_tokens) ticked; saving only the concurrency keeps the stored compat as it was, '
    + 'supportsStrictMode included', shown.title === 'Edit provider · Compat F'
    && shown.legend === 'Compatibility options' && shown.hint === COMPAT_HINT
    && JSON.stringify(shown.rows) === JSON.stringify(COMPAT_TEXTS)
    && JSON.stringify(shown.ticked) === '[true,false,true,false,false]' && saved.ok
    && sortedJson(compat) === sortedJson(STORED_COMPAT), JSON.stringify({ shown, compat }));
}

/**
 * @brief Keys：加、删（不是最后一个时不确认）、删最后一个（确认、Cancel、Remove）；明文不回到界面。
 *        拖动排序（2026-10-26，负责人走查 M5，取代上移）在 v1-models-app-reorder.mjs。
 */
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

/**
 * @brief Models：加、编辑、删除（确认框）。加模型是卡上 Fetch models → 勾 fake-coder-b → Add 1 model
 *        （models.addModels，model-discovery.md §6.5、§13.4）。拖动排序（2026-10-26，取代上移）在 v1-models-app-reorder.mjs。
 */
async function editModels(ctx) {
  const { page, userData } = ctx;
  await openSettings(page);
  const fetched = await cardAddModels(page, 'loc', ['fake-coder-b']);
  const added = await waitConfig(userData, (cfg) => providerOf(cfg, 'loc').models.length === 2);
  record('MP-24 Models: Fetch models on the card, tick fake-coder-b, Add 1 model saves it at the end of the provider '
    + 'and shows its row', fetched.error === null && fetched.fetch.state === 'list' && added.ok
    && JSON.stringify(providerOf(added.value, 'loc').models.map((m) => m.id)) === '["fake-coder","fake-coder-b"]'
    && await modelRow(page, 'loc/fake-coder-b').count() === 1, JSON.stringify(fetched));
  await modelRow(page, 'loc/fake-coder-b').locator('[data-action="edit"]').click();
  const form = page.getByTestId('model-form');
  await form.getByLabel('Context window', { exact: true }).fill('65536');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const edited = await waitConfig(userData, (cfg) => providerOf(cfg, 'loc').models[1]?.contextWindow === 65536);
  record('MP-24 Models: Edit saves the new context window', edited.ok,
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

/** @brief Groups：新分组 id 的错误、建立、加成员、只剩一个成员、改成员立即影响会话、删除（成员的拖动排序在 reorder 套件）。 */
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
  const order = await waitConfig(userData, (cfg) => JSON.stringify(cfg.groups.find((g) => g.id === 'duo')?.members)
    === '["intra/fake-coder","loc"]');
  record('MP-24 Groups: Create and Add member (already chosen members ticked and unavailable) save at once, the new '
    + 'member at the end', created.ok && locked && order.ok, JSON.stringify(order.value?.groups));
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

/** @brief 会话的范围是分组 duo：成员改成 tool calling 判定不通过的提供商立即拒绝启动；删除分组（确认框说明）后 pick_missing。 */
async function groupAffectsSession(ctx, row) {
  const { page, userData } = ctx;
  await showSession(ctx, ctx.main);
  await choosePick(page, 'duo');
  const usable = await waitCard(page, (s) => s === null, 15000);
  await openSettings(page);
  await row.locator('[data-action="add-member"]').click();
  await row.locator('[data-testid="member-picker"] [data-member="nt"]').click();
  await waitConfig(userData, (cfg) => cfg.groups.find((g) => g.id === 'duo')?.members.length === 2);
  await row.locator('[data-testid="group-member"][data-member="loc"] [data-action="member-remove"]').click();
  await waitConfig(userData, (cfg) => JSON.stringify(cfg.groups.find((g) => g.id === 'duo')?.members) === '["nt"]');
  await showSession(ctx, ctx.main);
  const blocked = (await waitCard(page, (s) => s?.kind === 'no_candidate', 10000)).value;
  record('MP-24 Groups: changing the members of the session\'s group re-validates it at once (only a member whose '
    + 'tool calling failed verification → blocked)', usable.ok
    && blocked?.candidates.some((c) => c.ref === 'nt/fake-coder-notools' && c.reason === 'failed'),
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
  providers: [seedProvider('p1', 'One', PORT.cascade, ['fake-coder', 'fake-coder-b']),
    seedProvider('p2', 'Two', PORT.cascade), seedProvider('p3', 'Three', PORT.cascade),
    seedProvider('p4', 'Four', PORT.cascade)],
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

/** 迁移后期望的提供商 id（按 models.json 的顺序） */
const MIGRATED = ['mori-endpoint', 'fake-1', 'env-box', 'env-box-2', 'openai-2'];

/** @brief 先用当前 App 的首次启动在数据目录里存下 ref 为 fake#1 的密文，再换成 v0 的 models.json。 */
async function prepareV0(userData) {
  const ctx = await startApp(userData);
  try {
    await fillFirstRun(ctx.page, { name: 'fake', baseUrl: url(PORT.migrate), secret: KEY.v0cipher,
      modelId: 'fake-coder' });
    await testConnection(ctx.page);
    await waitProbe(ctx.page, 'fake/fake-coder', { timeout: 90000 });
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

/** @brief 从 v0 迁移：说明、配置、key、思考强度、迁移来的提供商马上能用、发送、Dismiss、迁移后改 models.json。 */
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
    await migratedUsable(ctx, project);
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
  // models-settings.md 表下的顺序（2026-10-26 改）：迁移说明 → Defaults → Providers → Groups，标题就是这几个名字
  const blocks = await page.getByTestId('models-section').evaluate((root) => [...root.children]
    .filter((el) => el.tagName !== 'H2').map((el) => [el.dataset.testid ?? el.tagName,
      el.querySelector('h3')?.textContent ?? null]));
  record('MP-08 after migrating, this launch opens Settings → Models with the migration notice on top', landed.ok
    && await page.getByTestId('settings-page').isVisible() && nav === 'models'
    && blocks[0]?.[0] === 'migration-notice', `nav ${nav}; ${JSON.stringify(blocks)}`);
  record('MP-24 Settings → Models shows its sections from top to bottom as the migration notice, Defaults, Providers, '
    + 'Groups, titled "Defaults", "Providers", "Groups" (no zone or Project access section, 2026-10-26)',
  JSON.stringify(blocks) === JSON.stringify([['migration-notice', 'Imported your model settings from models.json'],
    ['defaults', 'Defaults'], ['providers', 'Providers'], ['groups', 'Groups']]), JSON.stringify(blocks));
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
  record('MP-08 model-config.json: the five usable providers with rewritten ids, no zone fields (2026-10-26), no '
    + 'groups', JSON.stringify(ids) === JSON.stringify(MIGRATED) && cfg.providers.every((p) => !('zone' in p))
    && !('allowedZones' in cfg) && !('projectZones' in cfg) && cfg.groups.length === 0, JSON.stringify(ids));
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

/**
 * @brief 迁移来的提供商没有区域（2026-10-26，负责人走查 M3；原来区域未确认时被排除、要先 Confirm zone）：打开文件夹，
 *        启动时的探针跑完后会话不被拒绝，用迁移来的 key 发送。
 */
async function migratedUsable(ctx, project) {
  const { page } = ctx;
  await backToChat(page);
  await openFolder(ctx, project);
  const cleared = await waitCard(page, (s) => s === null, 90000);
  const since = Date.now();
  const reply = cleared.ok ? await sendText(ctx, 'plain after migrating') : null;
  const keys = chatsOf(fakes.migrate, since).map((c) => c.key);
  record(`MP-08 a migrated provider needs no zone confirmation: once its probes pass the session sends with the `
    + `migrated (encrypted) key (…${last4(KEY.v0plain)})`, cleared.ok && Boolean(reply?.text.includes(REPLY))
    && keys.length > 0 && keys.every((k) => k === last4(KEY.v0plain)),
  `${cardText(cleared.value)} | ${keys.join(',')}`);
}

/** @brief fake-1（v0 的 fake#1）用已存的密文，不用 models.json 里手写的 key。 */
async function cipherWins(ctx) {
  const { page } = ctx;
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

/** @brief 模型行显示探针出错（状态行"Couldn't verify: …"带"Verify again"，models-settings.md "Models 行"）且不在探测中。 */
const probeFailed = async (page, ref) => (await toolCalling(page, ref)) === 'unverified' && modelRow(page, ref)
  .locator('[data-testid="probe-status"][data-state="error"] [data-action="verify"]:text-is("Verify again")')
  .isVisible().catch(() => false);

/** @brief 合成端点 since 之后收到的、带这个 key 的请求（探针或对话）。 */
const requestsWith = (fake, key, since) => fake.chats.filter((chat) => chat.key === last4(key) && chat.at >= since);

/** @brief 合成端点重新启动（synthetic test setup）：结束原来的进程，在同一个端口按 env 再起一份。 */
async function restartFake(name, env) {
  const { port } = fakes[name];
  await stopFake(fakes[name]);
  fakes[name] = await startFake(port, env);
}

/**
 * @brief 探针出错的状态行（models-settings.md “Models 行”的“探针出错”）：文字正好是“Couldn’t verify: ”加档案的 error
 *        （第一个出错的步的说明，这里是合成端点 401 的原文），后面是“Verify again”。
 */
async function errorLine(page, ref, label) {
  const error = (await page.evaluate(() => window.mori.request({ type: 'models.get' }))).profiles?.[ref]?.error ?? null;
  const line = await modelRow(page, ref).locator('[data-testid="probe-status"]').evaluate((el) => ({
    state: el.dataset.state, text: el.querySelector('span')?.textContent ?? null,
    button: el.querySelector('[data-action="verify"]')?.textContent ?? null })).catch(() => null);
  record(`MP-10 ${label}: the status line reads exactly "Couldn’t verify: <the profile's error>" (here the endpoint's `
    + '401 text) followed by "Verify again"', Boolean(error) && error.includes('401') && line?.state === 'error'
    && line.text === `Couldn’t verify: ${error}` && line.button === 'Verify again', JSON.stringify({ error, line }));
}

/** @brief 一行 key 的记录（“Rejected”等）；没有记录时为 null。 */
const keyState = (page, id, ref) => providerCard(page, id)
  .locator(`[data-testid="key-row"][data-ref="${ref}"] [data-testid="key-state"]`)
  .textContent({ timeout: 1000 }).catch(() => null);

/** @brief 点一次卡上的 Test connection（testOnce；requests 为 null 时端点停着、不等请求）。 */
const testCardOnce = (page, providerId, requests) => testOnce(providerCard(page, providerId),
  { action: 'test-provider', label: 'Test connection', result: 'test-result' }, requests);
/** @brief 点一次 Keys 一行的“Test”（testOnce；requests 为 null 时端点停着、不等请求）。 */
const testKeyOnce = (row, requests) => testOnce(row, { action: 'key-test', label: 'Test', result: 'key-test' },
  requests);

/**
 * @brief 提供商卡的“失败后再测”（models-settings.md “提供商卡”，规格 §8.3）：kr#1（错的 key）记为 Rejected 之后什么都不改，
 *        连点两次 Test connection：每次都发出请求（带 kr#1）、结果都是 401 的原文，第二次不因上一次失败而等。再把合成端点
 *        重启为认这个 key（synthetic test setup：服务那边改好了）：Test connection 成功，kr#1 的记录消失。
 */
async function retestCard(ctx) {
  const { page } = ctx;
  const requests = () => requestsWith(fakes.reprobe, KEY.wrong, 0).filter((chat) => !chat.probe);
  const rejected = await keyState(page, 'kr', 'kr#1');
  const tries = [await testCardOnce(page, 'kr', requests), await testCardOnce(page, 'kr', requests)];
  record('MP-41 provider card, retest after a failure (§8.3): with key 1 recorded as "Rejected", pressing Test '
    + 'connection twice without changing anything sends a request with that key each time and shows the server’s '
    + 'answer each time ("Connection failed: 401 …", not "Connection error."); the second test does not wait',
  rejected === 'Rejected' && tries.every((t) => t.sent === 1 && t.result?.startsWith('Connection failed: ')
    && t.result.includes('401') && !t.result.includes('Connection error.')) && tries[1].ms < 5000,
  JSON.stringify({ rejected, tries }));
  await restartFake('reprobe', { FAKE_KEYS: [KEY.right, KEY.wrong].join(',') });
  const fixed = await testCardOnce(page, 'kr', requests);
  const cleared = await poll(() => keyState(page, 'kr', 'kr#1'), (state) => state === null, 10000);
  record('MP-41 provider card: once the server takes key 1 (synthetic: the endpoint restarted with it), Test '
    + 'connection uses it, shows "Connected · …" and clears its "Rejected" record', fixed.sent === 1
    && fixed.result?.startsWith('Connected · ') && cleared.ok, JSON.stringify({ fixed, state: cleared.value }));
}

/**
 * @brief 规格 §7.4：加 key、删 key 也算修改提供商，档案不是 verified / failed 的模型自动重新探测。
 *   没有 key 时探针出错；加错的 key：重新探测、仍出错；加对的 key、删掉错的：重新探测并通过，全程不点 Verify。
 */
async function keyReprobe() {
  const userData = tempDir('mori-v1s-reprobe-');
  const ref = 'kr/fake-coder';
  // synthetic test setup：一个没有 key 的提供商，合成端点只认 KEY.right。
  writeJson(configFile(userData), seedConfig({ providers: [seedProvider('kr', 'Reprobe', PORT.reprobe)] }));
  let ctx;
  try {
    ctx = await startApp(userData);
    const { page } = ctx;
    await openSettings(page);
    const initial = await poll(() => probeFailed(page, ref), Boolean, 60000);
    await errorLine(page, ref, 'no key');
    let since = Date.now();
    await addKey(page, 'kr', KEY.wrong);
    const wrong = await poll(async () => requestsWith(fakes.reprobe, KEY.wrong, since).length > 0
      && probeFailed(page, ref), Boolean, 60000);
    record('MP-10 adding a key re-probes the never-verified model without Verify; with a wrong key the probes '
      + 'end in an error (status line with "Verify again")', initial.ok && wrong.ok, `no key: error ${initial.ok}; `
      + `wrong key requests ${requestsWith(fakes.reprobe, KEY.wrong, since).length}, error ${wrong.ok}`);
    await errorLine(page, ref, 'wrong key');
    await retestCard(ctx);
    await restartFake('reprobe', { FAKE_KEYS: KEY.right });
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

// ---------- MP-41：测试连接总是发出，成功时清除提供商的 connection 与模型的 not_found（规格 §8.3 的 2026-10-26 补） ----------

/** 连接失败后提供商不可用的时间（规格 §12 connectionCooldownMs 的临时默认值，kernel/modelTimings.ts） */
const CONNECTION_COOLDOWN_MS = 30000;
/** 候选都在等 connection 恢复时阶段行的写法（model-chat.md“等模型”，§5.3 第 4 步的界面文字） */
const WAITING_CONNECTION = /^Waiting for a model · can’t connect until \d\d:\d\d:\d\d/;
/** testRecords、keyTestRecords 的模型 fake-coder-404 收到的不是探针的请求（测试的与会话的；端点重启后读新的进程） */
const recordRequests = () => fakes.records.chats.filter((chat) => !chat.probe && chat.model === 'fake-coder-404');

/**
 * @brief 提供商的 connection 与模型的 not_found 之下再测（规格 §8.3）：端点停掉（synthetic test setup：服务连不上）后点一次
 *        测试，失败，提供商记下 connection——当前一栏的会话（模型记着 not_found，还没发过）发出后整轮在等（阶段行
 *        “Waiting for a model · can’t connect until …”）；端点以 FAKE_SERVE_404 重新启动（服务修好了）后再点一次。设置页开着时
 *        调用，结束时停在会话页；返回各项（testKey 是修好后那次测试请求的 key 末 4 位），由调用方记录。
 * @param test (requests) => 点一次测试（testCardOnce 或 testKeyOnce）
 */
async function downThenFixed(ctx, test) {
  const { page } = ctx;
  await stopFake(fakes.records);
  const downAt = Date.now();
  const down = await test(null);
  await backToChat(page);
  const before = await sendOnly(page, 'plain after the failed test');
  const waiting = await poll(() => paneReply(page), (s) => WAITING_CONNECTION.test(s.stage ?? ''), 15000, 100);
  await openSettings(page);
  fakes.records = await startFake(PORT.records, { FAKE_SERVE_404: '1' });
  const since = Date.now();
  const fixed = await test(recordRequests);
  const testKey = recordRequests().find((chat) => chat.at >= since && !(chat.tools?.length > 0))?.key ?? null;
  await backToChat(page);
  const reply = await waitReply(page, before, 60000);
  const served = recordRequests().find((chat) => chat.at >= since && chat.tools?.length > 0) ?? null;
  return { down, waited: waiting.ok, stage: waiting.value?.stage ?? null, fixed, testKey, reply, served,
    ms: served ? served.at - downAt : null };
}

/** @brief downThenFixed 修好之后的那次测试发出并成功，等着的那一轮在 connection 自己到期之前至少 5 秒就发出并得到回答。 */
const fixedInTime = (run) => run.fixed.sent >= 1 && run.fixed.result?.startsWith('Connected · ')
  && Boolean(run.reply?.text.includes(REPLY)) && run.served?.status === 200 && run.ms !== null
  && run.ms < CONNECTION_COOLDOWN_MS - 5000;
/** @brief downThenFixed 的结果摘要（检查的 detail）。 */
const runBrief = (run) => JSON.stringify({ down: run.down.result, stage: run.stage, fixed: run.fixed,
  testKey: run.testKey, reply: oneLine(run.reply?.error ?? run.reply?.text ?? ''), status: run.served?.status ?? null,
  ms: run.ms });

/**
 * @brief 卡上的 Test connection（models-settings.md “提供商卡”的“失败后再测”）：fake-coder-404 的提供商（合成端点对不是探针的
 *        请求回 404）。Test connection 失败（404）后什么都不改再测：照样发出、又是 404 的原文。打开文件夹，范围就是它的新会话
 *        没有被拒绝启动；再经 downThenFixed：端点停掉时测试失败、这一轮在等 connection，端点修好后测试成功并清除这个模型的
 *        not_found 与提供商的 connection（2026-10-26 补，复核：原来界面上只查了 not_found，清 connection 只在单元层）。
 */
async function testRecords() {
  const userData = tempDir('mori-v1s-records-');
  const project = makeProject(tempDir('mori-v1s-records-proj-'), 'proj');
  writeJson(configFile(userData), seedConfig({ providers: [seedProvider('nf', 'Not Found', PORT.records,
    ['fake-coder-404'])], normalDefault: 'nf' }));
  let ctx;
  try {
    ctx = await startApp(userData);
    const { page } = ctx;
    await openSettings(page);
    await waitVerified(page, 'nf/fake-coder-404', 90000);
    const tries = [await testCardOnce(page, 'nf', recordRequests), await testCardOnce(page, 'nf', recordRequests)];
    record('MP-41 a 404 on Test connection does not stop the next one: pressing it again without changing anything '
      + 'sends the request again and shows the server’s 404 text again', tries.every((t) => t.sent === 1
      && t.result?.startsWith('Connection failed: ') && t.result.includes('404')), JSON.stringify(tries));
    await backToChat(page);
    await openFolder(ctx, project);
    const card = await waitCard(page, (s) => s === null, 15000);
    await openSettings(page);
    const run = await downThenFixed(ctx, (requests) => testCardOnce(page, 'nf', requests));
    record('MP-41 provider card: with the endpoint stopped Test connection fails ("Connection failed: …") and the '
      + 'provider is recorded as unreachable: the session’s turn waits with "Waiting for a model · can’t connect '
      + 'until hh:mm:ss"', run.down.result?.startsWith('Connection failed: ') && run.waited, runBrief(run));
    record('MP-41 after the server is fixed (synthetic: the endpoint started again serving the -404 model) Test '
      + 'connection shows "Connected · …" and clears the model’s not_found and the provider’s connection: the new '
      + 'session on it is not blocked, and its waiting turn goes out and is answered well before the connection '
      + `record would run out (${CONNECTION_COOLDOWN_MS / 1000} s after the failed test)`, card.ok && fixedInTime(run),
    `card: ${cardText(card.value)}; ${runBrief(run)}`);
  } catch (error) {
    record('MP-41 testRecords: flow', false, oneLine(error, 400));
    await shot(ctx, 'testRecords-error');
  } finally {
    await closeApp(ctx, 'MP-41');
  }
}

// ---------- MP-41：Keys 一行的“Test”同样不看任何不可用记录，成功后清除提供商的 connection 与模型的 not_found（U17） ----------

/**
 * @brief 模型的 not_found 之下（models-settings.md Keys 的“Test 中”，U17）：第一次 Test 得到 404，模型记下 not_found——
 *        会话发出时整轮停在“model not found on the server”、端点收不到请求（记录确实在）；这时什么都不改再点 Test，照样带
 *        这个 key 马上发出（不等）、又是 404 的原文。之后另开一个会话（还没发过）留给 keyTestConnection。
 */
async function keyTestNotFound(ctx, row, projects) {
  const { page } = ctx;
  const first = await testKeyOnce(row, recordRequests);
  await backToChat(page);
  await openFolder(ctx, projects[0]);
  const since = Date.now();
  const blocked = await sendText(ctx, 'plain while the model is not found');
  const sent = recordRequests().filter((chat) => chat.at >= since).length;
  record('MP-41 Keys row "Test" (U17), the record is there: a first Test gets the server’s 404 ("Connection failed: '
    + '404 …") and the model is recorded as not found: a session on it ends the turn with "model not found on the '
    + 'server" and the server gets no request', first.sent === 1 && first.result?.startsWith('Connection failed: ')
    && first.result.includes('404') && Boolean(blocked?.error?.includes('model not found on the server')) && sent === 0,
  JSON.stringify({ first, blocked: oneLine(blocked?.error ?? blocked?.text ?? ''), sent }));
  await openFolder(ctx, projects[1]);
  await openSettings(page);
  const again = await testKeyOnce(row, recordRequests);
  const keyed = recordRequests().at(-1)?.key ?? null;
  record('MP-41 Keys row "Test" ignores the model’s not_found (models-settings.md Keys "Test 中", U17): pressed again '
    + 'without changing anything it sends the request with this key at once (the result within 5 s) and shows the '
    + 'server’s 404 text again, not "Connection error."', again.sent === 1 && again.ms < 5000
    && again.result?.startsWith('Connection failed: ') && again.result.includes('404')
    && !again.result.includes('Connection error.') && keyed === last4(KEY.keyTest), JSON.stringify({ again, keyed }));
}

/**
 * @brief 提供商的 connection 与模型的 not_found 之下（models-settings.md Keys 的“Test 结果”，规格 §8.3，U17）：经 downThenFixed，
 *        端点停掉后 Test 失败、另开的会话这一轮在等 connection；端点修好后 Test 在两条记录之下照样带这个 key 发出、成功，
 *        并清除两条：等着的那一轮在 connection 自己到期（停掉后点 Test 起 30 秒）之前就发出并得到回答。
 */
async function keyTestConnection(ctx, row) {
  const run = await downThenFixed(ctx, (requests) => testKeyOnce(row, requests));
  record('MP-41 with the endpoint stopped the Keys row "Test" fails ("Connection failed: …") and the provider is '
    + 'recorded as unreachable: a new session’s turn waits with "Waiting for a model · can’t connect until hh:mm:ss"',
  run.down.result?.startsWith('Connection failed: ') && run.waited, runBrief(run));
  record('MP-41 Keys row "Test" ignores the provider’s connection and the model’s not_found, and on success clears '
    + 'both (models-settings.md Keys "Test 结果", §8.3, U17): with the endpoint back (synthetic: restarted serving '
    + 'the -404 model) it sends with this key and shows "Connected · …"; the waiting turn then goes out and is '
    + 'answered well before the connection record would run out '
    + `(${CONNECTION_COOLDOWN_MS / 1000} s after the failed Test)`, fixedInTime(run)
    && run.testKey === last4(KEY.keyTest), runBrief(run));
}

/**
 * @brief Keys 一行的“Test”与卡上的 Test connection 走同一条路（U17）：一个模型 fake-coder-404 的提供商，在界面上加一个 key；
 *        not_found 之下照样发出（keyTestNotFound），connection 与 not_found 之下照样发出、成功后两条都清除（keyTestConnection）。
 */
async function keyTestRecords() {
  await restartFake('records', {});
  const userData = tempDir('mori-v1s-keytest-');
  const projects = ['p1', 'p2'].map((name) => makeProject(tempDir('mori-v1s-keytest-proj-'), name));
  // synthetic test setup：只有 fake-coder-404 一个模型、没有 key 的提供商（key 在界面上加），默认范围就是它
  writeJson(configFile(userData), seedConfig({ providers: [seedProvider('kt', 'Key Test', PORT.records,
    ['fake-coder-404'])], normalDefault: 'kt' }));
  let ctx;
  try {
    ctx = await startApp(userData);
    await openSettings(ctx.page);
    await waitVerified(ctx.page, 'kt/fake-coder-404', 90000);
    await addKey(ctx.page, 'kt', KEY.keyTest);
    const row = providerCard(ctx.page, 'kt').locator('[data-testid="key-row"][data-ref="kt#1"]');
    await row.waitFor({ timeout: 10000 });
    await keyTestNotFound(ctx, row, projects);
    await keyTestConnection(ctx, row);
  } catch (error) {
    record('MP-41 keyTestRecords: flow', false, oneLine(error, 400));
    await shot(ctx, 'keyTestRecords-error');
  } finally {
    await closeApp(ctx, 'MP-41');
  }
}

// ---------- 运行 ----------

const steps = { configInvalid, firstRunLocal, noZones, firstRunToolFailure, projectRules, settingsEdits,
  cascades, keyReprobe, testRecords, keyTestRecords, migration, migrationFailure };

const keyed = [KEY.first, KEY.spare].join(',');
const fakeEnv = {
  keyed: [PORT.keyed, { FAKE_KEYS: keyed }], invalid: [PORT.invalid], fresh: [PORT.fresh], seeded: [PORT.seeded],
  moved: [PORT.moved], migrate: [PORT.migrate, { FAKE_KEYS: [KEY.v0plain, KEY.v0cipher].join(',') }],
  cascade: [PORT.cascade], edits: [PORT.edits], reprobe: [PORT.reprobe, { FAKE_KEYS: KEY.right }],
  records: [PORT.records],
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
