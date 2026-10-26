// 一键拉取模型的首次启动 App 测试：真正的 Mori（界面 + 后台进程 + pi + 主进程）从空的数据目录启动（首次启动），
// 对合成端点（tests/fake-endpoint/server.mjs，synthetic），逐条检查 docs/specs/model-discovery.md §13.2 的：
//   MD-11 首次启动：填地址和 key → Fetch → 勾一个模型 → Test connection → 进入主窗口（Open a folder 提示里一行
//         “Connected · …”）→ Open folder（会话的拒绝启动卡上“Verifying …”，探针结束自动解除），新会话的范围是这个模型；
//         勾两个时范围是提供商、Test connection 测第一个；探针代价一句；没有关闭表单的 Cancel（只有拉取中的 Cancel）；
//         保存后只改路径再拉取用内存里的 key（FAKE_REQUIRE_KEY 下不出 rejected）；改到另一个 origin 时占位写 Optional、
//         拉取不带 key（端点日志 key 为 null、rejected），改回来恢复“Saved. Leave empty to keep it.”和 key，带着另一个
//         origin 保存后 key 丢掉（2026-10-23 负责人决定，§6.6）；再次保存（测试失败或取消之后）整体替换，配置里仍只有
//         一个提供商；列表错误（nolist、只拒绝列表的 401）后手填模型 ID 仍能完成首次启动；
//         以及 docs/v1/screens/first-run.md “进入与不进入”、状态表与“测试成功之后：主窗口”的每一行（读取失败除外，
//         见下面的说明），“打开文件夹之后”的拒绝启动卡（验证中、tool calling 判定失败、探针出错与 Verify now）；
//         实现时定的 A20（docs/v1/discovery-checks.md）：内存里的 key 是上次保存成功时发出的 key（用 key B 的
//         保存失败后，框空着拉取发的仍是 key A），只改 key 框或只改 Name 时 Test connection 重新保存、没有改动时不保存，
//         新的一次拉取清掉测试结果，有清单的行时卡片宽 720px（窗口更窄时占满可用宽度）、否则是默认的 560px；
//   2026-10-26（负责人走查 M2）：测试成功就关掉表单、进入主窗口，所以要留在表单上接着测的保存（内存里的 key、
//         再次保存、A20）都让测试失败：勾 fake-coder-400（合成端点对不是探针的请求回 400，server.mjs 的 -400 后缀）；
//         探针状态经进程桥读 models.get 的档案（page.mjs readProbe），给你看的在会话的拒绝启动卡上；
//   MD-08 手填一行（首次启动部分）：拿到列表与列表错误（nolist、401）时都能手填加入，列表错误时手填的行在错误下面；
//         id 检查与重复；Entered by you 与 Default（2026-10-26 起取代 Not reported，只在值仍是默认值时标）；
//   MD-07 在首次启动表单里的一条：过滤框打开时 Select all、Clear selection 只作用于显示着的行（藏起来的勾选行照样保存
//         记在 MD-11 的“保存中”）。
//   2026-10-26 补（负责人回答 8：状态表各行都要有用例，WP-01 的“测试成功之后：主窗口”）：Connected 一行的 role="status"
//         （listed）；打开失败也清掉这一行（shapes 的最后）；侧栏的 Open folder…（nolist）与中栏没有会话时的 Ctrl+N
//         （rejected）；数据目录里已有会话时的说明、点侧栏的会话、打开已有的会话也清掉这一行（seeded，新的一步）。
// 用法（在 app/ 下，先构建；本套件不构建）：
//   node tests/ui/md-app-firstrun.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 步骤：entry、listed、keys、changes、shapes、nolist、rejected、seeded。结果写到 test-results/md-app-firstrun(-packaged).json（--only 时
// md-partial-app-firstrun…，不计入覆盖检查），截图在 test-results/md-app-firstrun(-packaged)/。
// 合成端点与列表门用 4840–4859 之间的端口；同一时刻只开一个 Mori。
// 写进数据目录的文件（读不出的 v0 models.json、读不出的 model-config.json、挡住配置写入的同名文件夹、seeded 的 pi 会话文件）
// 与设成只读的 model-config.json、shapes 里选的不存在的文件夹都是 synthetic test setup，代码里逐处注明；key 都是测试自己
// 生成的合成值，与任何真实服务无关。
// first-run.md 的“读取失败”（config.get 本身报错）从外面造不出来（数据目录里读不出的文件都有各自的状态：迁移失败、
// 配置读不出），这一行不在本套件里检查（它不是 MD-11 的通过条件，也不随一键拉取模型改变）。

import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder } from './lib.mjs';
import {
  activeProject, addManual, atStart, blockedCard, brief, CARD, cardWidth, chatLogs, clickTest, closeApp, compatBox,
  emulateViewport, fetchModels, fetchObserved, FORM, GATE_BODY, GATE_PROBE_MESSAGE, lastDiscover, listLogs,
  openFolderFromPrompt, openMoreSettings, pickRow,
  plainChats, poll, readForm, readMain, resultText, rowIn, rowsDigest, sendText, sentCommands, setApi, setBaseUrl,
  setKey, setName, setRowValue, startApp, startEndpoint, startListGate, stopEndpoint, stopListGate,
  testConnection, typeManual, waitProbe, waitTestResult, watchCards, watchCommands, watchedCards, watchedStates,
} from './md-firstrun-helpers.mjs';
import {
  activeFile, chooseMenuItem, PANE, samePath, startDelete, stubFolder, waitReady,
} from './m3-helpers.mjs';
import { chatItems, seedSession } from './mem-enhance-helpers.mjs';
import { readProbe } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const RESULT = only ? `md-partial-app-firstrun${suffix}` : `md-app-firstrun${suffix}`;
const shots = join(appRoot, 'test-results', `md-app-firstrun${suffix}`);
mkdirSync(shots, { recursive: true });
const { results, record, write } = createRecorder(exePath ?? 'dev build');

/** 合成端点与列表门的端口（4840–4859） */
const PORT = { listed: 4840, slow: 4841, other: 4842, nolist: 4843, upstream: 4844, gate: 4845, empty: 4846,
  many: 4847, typed: 4848, ollama: 4849, open: 4850 };
/** @brief 端口对应的地址。 */
const url = (port, path = '/v1') => `http://127.0.0.1:${port}${path}`;

/** 测试用的合成 key（synthetic），末 4 位互不相同（合成端点的日志只记末 4 位） */
const KEY = { one: 'synthetic-md-firstrun-key-one-F1A1', gate: 'synthetic-md-firstrun-key-gate-G2B2',
  a: 'synthetic-md-firstrun-key-a-H3C3', b: 'synthetic-md-firstrun-key-b-J4D4' };
/** 带空格的 key（不能放进请求头，§5.1） */
const BAD_KEY = 'synthetic key with spaces';
const SECRETS = Object.values(KEY);
const tail = (secret) => secret.slice(-4);

/** 列表里的模型（FAKE_MODELS，listed 端点；vllm 形状不报告类型，三行都能加入，默认都不勾） */
const LISTED = ['fake-coder', 'fake-coder-notools', 'fake-coder-b'];
/**
 * 测试连接会失败的模型（synthetic）：合成端点对它不是探针的请求回 400（server.mjs 的 -400 后缀），探针照常通过。
 * 2026-10-26 起测试成功就关掉首次启动表单（first-run.md），要留在表单上接着测的保存都勾它（用 Add a model ID 手填）。
 * 当初用 400 不用 404：那时模型池对 404 记下 not_found（§8.3）之后，没改配置的测试连接不再发出（"Connection error."），
 * A20 的"没有改动时不保存、测试带着存着的 key"就查不到端点。2026-10-26（WP-02，§8.3 的补充）起测试连接总是发出、
 * 不看这些记录，404 也可以；400 照旧不改
 */
const FAILING = 'fake-coder-400';
/** many 端点的 1001 个模型 id（超过 §11 的 1000 条） */
const MANY = Array.from({ length: 1001 }, (_, i) => `model-${String(i + 1).padStart(4, '0')}`);

/** 界面文字（docs/v1/screens/first-run.md、models-settings.md、docs/v0/ui-strings.md） */
const TEXT = {
  title: 'Connect a model',
  description: 'Enter the base URL and API key, then fetch the models.',
  saved: 'Saved. Leave empty to keep it.',
  optional: 'Optional',
  cost: 'Each model is verified with up to 13 short requests.',
  badUrl: 'Base URL must be an http or https URL.',
  badKey: 'API key contains characters that cannot be sent in a header',
  stillAdd: 'You can still add model IDs below.',
  noList: 'This server doesn’t list its models.',
  emptyList: 'The server didn’t list any models.',
  compat: 'Endpoint needs max_tokens instead of max_completion_tokens',
  idSpaces: 'Model ID must be non-empty and contain no spaces.',
  idUnique: 'Model IDs must be unique within a provider.',
  migration: 'Couldn’t import your previous model settings: ',
  chooseFolder: 'Choose a project folder to start a session.',
  pickSession: 'Pick a session on the left to continue, or open a folder to start a new session.',
  noFit: 'This session can’t start: no model fits.',
};
/** seeded 一步启动前放进数据目录的会话（synthetic test setup）：会话名、第一条消息与回复 */
const SEEDED = { name: 'Seeded session', question: 'Seeded question from an earlier run', answer: 'Seeded answer.' };
/**
 * 合成端点 key 不对时 401 的响应体（server.mjs 的 keyFailure 与 errorBody）；§5.2：rejected 的 detail 是服务的原文
 */
const DENIED = JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
/** 测试成功的结果文字（state/settings.ts 的 testMessage） */
const CONNECTED = /^Connected · First token \d+ms · Total \d+ms/;
/** 测试失败的结果文字的开头（state/settings.ts 的 testMessage） */
const FAILED = 'Connection failed: ';
/** @brief 测试的结果是失败，表单留着、没有进入主窗口（first-run.md 状态表"测试失败"）。 */
const failedOnForm = (done) => done?.handedOver === false && (resultText(done) ?? '').startsWith(FAILED);

/** 端点（startEndpoint 的返回值）与列表门 */
const endpoints = {};
let gate = null;
/** 用过的数据目录与收集到的全部 App 日志（最后扫一遍 key） */
const dataDirs = [];
const allLogs = [];

// ---------- 通用 ----------

/** @brief 读 JSON 文件；不存在或读不出时为 null。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
const readConfig = (dir) => readJson(join(dir, 'model-config.json'));
/** @brief credentials.json 里的 ref（只看键，不读密文）。 */
const credentialRefs = (dir) => Object.keys(readJson(join(dir, 'credentials.json')) ?? {});
/** @brief 文字里出现的合成 key。 */
const secretsIn = (text) => SECRETS.filter((secret) => text.includes(secret));

/** @brief 目录下的全部文件（递归）。 */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** @brief 新的临时目录（记下，最后扫一遍）。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dataDirs.push(dir);
  return dir;
}

/** @brief 带 README 的临时项目。 */
function makeProject(name) {
  const project = join(tempDir(`mori-mdfr-${name}-`), 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nSynthetic project for the first-run tests.\n');
  return project;
}

/** @brief 截图（出错时）。 */
const shot = (ctx, name) => ctx?.page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** @brief 关掉 App；记一条“页面没有报错”（名字以 MD-11 开头），日志并入 allLogs。 */
async function finish(ctx, step) {
  if (!ctx) return;
  allLogs.push(...ctx.logs);
  record(`MD-11 (${step}) the page reported no errors`, ctx.pageErrors.length === 0,
    ctx.pageErrors.slice(0, 3).join(' | '));
  await closeApp(ctx);
}

/** @brief 启动 App 并装上命令记录（HOOK）；装不上时先关掉 App 再报错（调用方拿不到 ctx，不留 Electron 进程）。 */
async function openApp(userData) {
  const ctx = await startApp(userData, exePath);
  try {
    await watchCommands(ctx);
  } catch (error) {
    allLogs.push(...ctx.logs);
    await closeApp(ctx);
    throw error;
  }
  return ctx;
}

/** @brief 一个提供商的模型 id。 */
const modelIds = (provider) => (provider?.models ?? []).map((model) => model.id);

/** @brief 发出的 models.firstRun 与 connection.test（since 之后）。 */
const saveAndTest = (ctx, since) => sentCommands(ctx, ['models.firstRun', 'connection.test'], since);

/**
 * @brief 从主窗口的 Open a folder 提示打开文件夹之后：等拒绝启动卡消失，发一条消息，返回 { pick, card, cards, reply,
 *        chats }；cards 是这期间出现过的拒绝启动卡（watchedCards，例如探针还在跑时的“Verifying …”）。
 */
async function sessionCheck(ctx, project, endpoint) {
  const pick = await openFolderFromPrompt(ctx, project);
  const card = await poll(() => blockedCard(ctx.page), (value) => value === null, 90000, 300);
  const cards = await watchedCards(ctx.page);
  const since = Date.now();
  const reply = await sendText(ctx.page, 'plain md-11 first message');
  return { pick, card, cards, reply, chats: plainChats(endpoint, since) };
}

/** @brief 当前一栏拒绝启动卡上按钮的 data-action，按显示顺序。 */
const cardActions = (page) => page.locator(`${CARD} button[data-action]`)
  .evaluateAll((buttons) => buttons.map((button) => button.dataset.action));

/** @brief sessionCheck 的结果是否“没被拒绝、收到了回复、请求来自 model”。 */
const sessionOk = (session, model) => session.card.ok && session.reply.count > 0 && !session.reply.error
  && session.chats.length > 0 && session.chats.every((chat) => chat.model === model);

/** @brief sessionCheck 的结果的概括。 */
const sessionBrief = (session) => brief({ pick: session.pick, card: session.card.value, cards: session.cards,
  error: session.reply.error, replies: session.reply.count, models: session.chats.map((chat) => chat.model) });

// ---------- entry：进入与不进入（first-run.md "进入与不进入"） ----------

/** @brief 迁移失败：表单上方的原文，表单在开始的状态、两个框为空。 */
async function entryMigration() {
  const userData = tempDir('mori-mdfr-migrate-');
  mkdirSync(join(userData, 'pi'), { recursive: true });
  // synthetic test setup：v0 留下的、读不出的 pi/models.json（同 MP-08 的迁移失败用例）
  writeFileSync(join(userData, 'pi', 'models.json'), '{ "providers": { "x": ');
  let ctx;
  try {
    ctx = await startApp(userData, exePath);
    const state = await readForm(ctx.page);
    // “表单上方”：迁移失败的一句在文档里位于表单之前
    const above = await ctx.page.evaluate((form) => {
      const note = document.querySelector('[data-testid="migration-error"]');
      const element = document.querySelector(form);
      return Boolean(note && element && note.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, FORM);
    record('MD-11 first-run entry (migration failed): "Couldn’t import your previous model settings: <raw>" above the '
      + 'form, and the form is at the start state (only Base URL, API key, Fetch models) with both boxes empty',
    state?.migrationError?.startsWith(TEXT.migration) && state.migrationError.length > TEXT.migration.length
      && above && atStart(state) && state.baseUrl.value === '' && state.apiKey.length === 0
      && state.title === TEXT.title, brief({ above, state }));
  } catch (error) {
    record('MD-11 entry (migration failed): flow', false, brief(String(error), 400));
    await shot(ctx, 'entry-migration-error');
  } finally {
    await finish(ctx, 'entry migration');
  }
}

/** @brief 配置读不出：不显示首次启动表单，进入三栏布局。 */
async function entryBrokenConfig() {
  const userData = tempDir('mori-mdfr-broken-');
  // synthetic test setup：存在但读不出的 model-config.json（同 MP-01）
  writeFileSync(join(userData, 'model-config.json'), '{ "version": 1, "providers": [ ');
  let ctx;
  try {
    ctx = await startApp(userData, exePath);
    const form = await ctx.page.locator(FORM).count();
    const sidebar = await ctx.page.getByTestId('sidebar').isVisible();
    record('MD-11 first-run entry (config can’t be read): no first-run form; the main window opens', form === 0
      && sidebar, `form ${form}, sidebar ${sidebar}`);
  } catch (error) {
    record('MD-11 entry (config can’t be read): flow', false, brief(String(error), 400));
    await shot(ctx, 'entry-broken-error');
  } finally {
    await finish(ctx, 'entry broken config');
  }
}

/**
 * 在页面里执行（页面重新加载前装上，新文档一开始就运行）：用 MutationObserver 记下每次出现的“Loading…”和那时有没有
 * 首次启动表单。
 */
function watchLoadingInPage() {
  window.__mdLoading = [];
  new MutationObserver(() => {
    const loading = document.querySelector('[data-testid="first-run-loading"]');
    if (loading) window.__mdLoading.push({ text: loading.textContent,
      form: Boolean(document.querySelector('[data-testid="connection-form"]')) });
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

/**
 * @brief 读取中：config.get 返回之前整窗只有“Loading…”。窗口第一次出现时 config.get 已经返回，所以在新文档开始前装上
 *        观察（addInitScript）再重新加载页面（主进程在 did-finish-load 时重新给页面接上后台进程）。
 */
async function entryLoading() {
  const userData = tempDir('mori-mdfr-loading-');
  let ctx;
  try {
    ctx = await startApp(userData, exePath);
    await ctx.page.addInitScript(watchLoadingInPage);
    await ctx.page.reload();
    await ctx.page.waitForSelector(FORM, { timeout: 60000 });
    const seen = await ctx.page.evaluate(() => window.__mdLoading ?? []);
    const state = await readForm(ctx.page);
    record('MD-11 first-run entry (loading): until config.get returns the window shows only "Loading…" (no form), '
      + 'then the first-run form at the start state', seen.length > 0 && seen.every((item) => item.text === 'Loading…'
      && !item.form) && atStart(state), brief({ seen: seen.slice(0, 3), start: atStart(state) }));
  } catch (error) {
    record('MD-11 entry (loading): flow', false, brief(String(error), 400));
    await shot(ctx, 'entry-loading-error');
  } finally {
    await finish(ctx, 'entry loading');
  }
}

/** @brief 进入与不进入。 */
async function entry() {
  await entryLoading();
  await entryMigration();
  await entryBrokenConfig();
}

// ---------- listed：开始、拉取中、已取消、命令失败、拉取后、清单、改 API type、Public、再拉一次、填写、一个模型 ----------

/** @brief 开始：标题、说明、只有三项；不是 http/https 的地址；拉取的命令失败。 */
async function listedStart(ctx) {
  const { page } = ctx;
  const start = await readForm(page);
  const sidebar = await page.getByTestId('sidebar').count();
  record('MD-11 first-run start: the window has only the first-run form (no sidebar), titled "Connect a model" with '
    + '"Enter the base URL and API key, then fetch the models."', sidebar === 0 && start.title === TEXT.title
    && start.description === TEXT.description, brief([sidebar, start.title, start.description]));
  record('MD-11 first-run start: only Base URL (placeholder http://host:8000/v1), API key (password box, placeholder '
    + '"Optional") and Fetch models, which is unavailable while Base URL is empty; no Cancel of any kind',
  atStart(start) && start.baseUrl.placeholder === 'http://host:8000/v1' && start.apiKey.type === 'password'
    && start.apiKey.placeholder === TEXT.optional && start.fetch.text === 'Fetch models' && start.fetch.disabled
    && start.closeForm === 0 && start.cancelButtons.length === 0, brief(start));
  await setBaseUrl(page, 'ftp://example.test/v1');
  const bad = await readForm(page);
  record('MD-11 first-run start: a Base URL that is not http/https shows "Base URL must be an http or https URL." and '
    + 'Fetch models stays unavailable', bad.fieldErrors.includes(`baseUrl:${TEXT.badUrl}`) && bad.fetch.disabled
    && atStart(bad), brief(bad.fieldErrors));
  const since = Date.now();
  await setBaseUrl(page, url(PORT.listed));
  await setKey(page, BAD_KEY);
  const failed = await fetchModels(ctx);
  record('MD-11 fetch command failed: a key with spaces gives "API key contains characters that cannot be sent in a '
    + 'header" under Fetch models; the form stays at the start state and nothing reaches the endpoint',
  failed.messages.includes(TEXT.badKey) && atStart(failed) && listLogs(endpoints.listed, since).length === 0,
  brief({ messages: failed.messages, requests: listLogs(endpoints.listed, since).length }));
}

/** @brief 拉取中：按钮、Cancel、两个框只读、没有关闭表单的 Cancel；Cancel 后回到开始并显示 Fetch cancelled。 */
async function listedCancel(ctx) {
  const { page } = ctx;
  await setKey(page, '');
  await setBaseUrl(page, url(PORT.slow));
  const since = Date.now();
  await page.locator(`${FORM} [data-action="fetch-models"]`).click();
  const during = (await poll(() => readForm(page), (state) => Boolean(state?.fetchCancel), 5000, 50)).value;
  record('MD-11 fetching: the button reads "Fetching models…" and is unavailable, Cancel is beside it, fetch-status is '
    + 'fetching, Base URL and API key are read-only, and the only Cancel is the fetch Cancel (no close-form)',
  during?.fetch?.text === 'Fetching models…' && during.fetch.disabled && during.fetchStatus?.state === 'fetching'
    && during.baseUrl.readOnly && during.apiKey.readOnly && during.closeForm === 0
    && JSON.stringify(during.cancelButtons) === '["fetch-cancel"]', brief(during));
  await poll(() => listLogs(endpoints.slow, since).length > 0, Boolean, 5000);
  await page.locator(`${FORM} [data-action="fetch-cancel"]`).click();
  const after = (await poll(() => readForm(page), (state) => state?.fetchStatus?.state === 'cancelled', 10000)).value;
  const cancels = await sentCommands(ctx, ['models.discoverCancel'], since);
  record('MD-11 fetch cancelled: the fetch Cancel sends models.discoverCancel and the form returns to the start state '
    + 'with "Fetch cancelled"; the boxes are editable again', after?.fetchStatus?.text === 'Fetch cancelled'
    && atStart(after) && !after.baseUrl.readOnly && !after.apiKey.readOnly && cancels.length === 1
    && listLogs(endpoints.slow, since).length > 0, brief({ after, cancels }));
}

/** @brief 拉取后：发出的命令、端点收到的 key、Detected、换框与说明、预填、清单、顺序、探针代价、按钮。 */
async function listedFetch(ctx) {
  const { page } = ctx;
  const since = Date.now();
  await setBaseUrl(page, url(PORT.listed, '/v1/models'));
  await setKey(page, KEY.one);
  const state = await fetchModels(ctx);
  const sent = await lastDiscover(ctx, since);
  const lists = listLogs(endpoints.listed, since);
  record('MD-11 fetch: models.discover goes out with target kind new, the Base URL box value, api null (API type not '
    + 'edited) and the API key box value; the list request reached the endpoint with that key (FAKE_REQUIRE_KEY)',
  sent?.kind === 'new' && sent.baseUrl === url(PORT.listed, '/v1/models') && sent.api === null
    && sent.key === tail(KEY.one) && lists.length > 0 && lists.every((line) => line.key === tail(KEY.one)),
  brief({ sent, lists }));
  record('MD-11 after fetch: "Detected: vLLM 0.10.1" (data-kind vllm)', state.detected?.kind === 'vllm'
    && state.detected.text === 'Detected: vLLM 0.10.1', brief(state.detected));
  record('MD-11 after fetch: the Base URL box becomes the suggested http://127.0.0.1:4840/v1 with "Updated to '
    + 'http://127.0.0.1:4840/v1 so the model list loads."', state.baseUrl.value === url(PORT.listed)
    && state.baseUrlNote === `Updated to ${url(PORT.listed)} so the model list loads.`,
  brief([state.baseUrl.value, state.baseUrlNote]));
  record('MD-11 after fetch: Name is prefilled with the host and port "127.0.0.1:4840", API type OpenAI-compatible',
    state.name === '127.0.0.1:4840' && state.api === 'openai-completions', brief([state.name, state.api]));
  const rows = state.rows;
  record('MD-11 after fetch: checklist "Models (3)" in list order with Select all and Clear selection; vLLM reports no '
    + 'type and three rows can be added, so none is ticked; the window 131072 is reported and Max output 16384 is '
    + 'the default ("Default"); no "Added" row (first run)', state.checklist && state.heading === 'Models (3)'
    && state.selectAll && state.clearSelection && JSON.stringify(rows.map((row) => row.id)) === JSON.stringify(LISTED)
    && rows.every((row) => !row.picked && !row.added && !row.tags.some((tag) => tag.kind === 'added')
      && row.chat === 'unknown' && row.contextWindow === '131072' && row.maxTokens === '16384'
      && JSON.stringify(row.defaults) === '["maxTokens:Default"]' && row.pickLabel === `Add ${row.id}`),
  brief({ heading: state.heading, rows }));
  record('MD-11 after fetch: the blocks follow §6.1/§6.6 order (Base URL, API key, Fetch models, Detected, the note, '
    + 'Name, API type, checklist, Add a model ID, More settings, the probe-cost note, Test connection)',
  state.order && state.blocks === 12, `order ${state.order}, blocks ${state.blocks}`);
  record('MD-11 after fetch: "Each model is verified with up to 13 short requests." is above Test connection, which is '
    + 'unavailable with no ticked model; no close-form Cancel; More settings is there for OpenAI-compatible',
  state.probeCost === TEXT.cost && state.test?.text === 'Test connection' && state.test.disabled
    && state.closeForm === 0 && state.cancelButtons.length === 0 && state.moreSettings, brief(state));
  record('MD-11 after fetch: Fetch models stays under the API key box and can be clicked again',
    state.fetch?.text === 'Fetch models' && !state.fetch.disabled, brief(state.fetch));
}

/** @brief MD-08（拿到列表）：id 检查、重复、加进清单末尾的样子；Select all 与 Clear selection。 */
async function listedManual(ctx) {
  const { page } = ctx;
  await typeManual(page, 'bad id');
  const spaced = await readForm(page);
  record('MD-08 first run with a list: an ID with a space shows "Model ID must be non-empty and contain no spaces." '
    + 'and Add to list is unavailable', spaced.manual?.errors.includes(TEXT.idSpaces) && spaced.manual.addDisabled,
  brief(spaced.manual));
  await typeManual(page, 'fake-coder');
  const twice = await readForm(page);
  record('MD-08 first run with a list: an ID already in the checklist shows "Model IDs must be unique within a '
    + 'provider." and Add to list is unavailable', twice.manual?.errors.includes(TEXT.idUnique)
    && twice.manual.addDisabled, brief(twice.manual));
  await addManual(page, 'fake-coder-typed');
  const added = await readForm(page);
  const typed = rowIn(added, 'fake-coder-typed');
  record('MD-08 first run with a list: Add to list puts the row at the end of the checklist, ticked, tagged "Entered '
    + 'by you", 128000 / 16384 both "Default", Supports thinking and Image input unticked; the box is cleared',
  added.rows.at(-1)?.id === 'fake-coder-typed' && typed.picked && !typed.reasoning && !typed.image
    && JSON.stringify(typed.tags) === '[{"kind":"entered","text":"Entered by you"}]'
    && typed.contextWindow === '128000' && typed.maxTokens === '16384'
    && JSON.stringify(typed.defaults) === '["contextWindow:Default","maxTokens:Default"]'
    && added.manual.value === '' && !added.test.disabled, brief(typed));
  await page.locator(`${FORM} [data-action="select-all"]`).click();
  const all = await readForm(page);
  await page.locator(`${FORM} [data-action="clear-selection"]`).click();
  const none = await readForm(page);
  record('MD-11 after fetch: Select all ticks every row that can be added (listed and entered) and Clear selection '
    + 'clears them; with nothing ticked Test connection is unavailable', all.rows.every((row) => row.picked)
    && all.rows.length === 4 && none.rows.every((row) => !row.picked) && none.test.disabled,
  brief({ all: all.rows.map((row) => row.picked), none: none.rows.map((row) => row.picked) }));
}

/** @brief 改 API type：清单不变、More settings 随之隐藏或出现。 */
async function listedApi(ctx) {
  const { page } = ctx;
  await pickRow(page, 'fake-coder', true);
  const before = await readForm(page);
  await setApi(page, 'anthropic-messages');
  const anthropic = await readForm(page);
  record('MD-11 changing API type: the checklist, its ticks and values stay; More settings is not shown for Anthropic '
    + 'Messages', anthropic.api === 'anthropic-messages' && rowsDigest(anthropic) === rowsDigest(before)
    && !anthropic.moreSettings && anthropic.checklist, brief(anthropic.rows));
  await setApi(page, 'openai-completions');
  const back = await readForm(page);
  record('MD-11 changing API type back to OpenAI-compatible shows More settings again; the checklist is unchanged',
    back.moreSettings && rowsDigest(back) === rowsDigest(before), brief(back.rows));
}

/** @brief 再拉一次：改过的 Name、API type、兼容选项留着，改过的 API type 作为 target.api 发出，清单从头来。 */
async function listedRefetch(ctx) {
  const { page } = ctx;
  await setName(page, 'Fake first run');
  await openMoreSettings(page);
  await compatBox(page, TEXT.compat).check();
  await setApi(page, 'openai-responses');
  const since = Date.now();
  const state = await fetchModels(ctx);
  const sent = await lastDiscover(ctx, since);
  record('MD-11 fetching again: the edited API type goes out as target.api (openai-responses) with the key in the box',
    sent?.api === 'openai-responses' && sent.key === tail(KEY.one), brief(sent));
  record('MD-11 fetching again: the edited Name and API type are not overwritten; the checklist starts '
    + 'over with the default ticks (none) and the entered row is gone', state.name === 'Fake first run'
    && state.api === 'openai-responses' && state.rows.every((row) => !row.picked)
    && JSON.stringify(state.rows.map((row) => row.id)) === JSON.stringify(LISTED), brief(state.rows));
  await setApi(page, 'openai-completions');
  await openMoreSettings(page);
  const kept = await compatBox(page, TEXT.compat).isChecked();
  record('MD-11 fetching again keeps the compatibility option ticked in More settings (only compatibility options, no '
    + 'Concurrency per key)', kept && (await page.locator(`${FORM} [data-testid="more-settings"]`)
    .getByText('Concurrency per key').count()) === 0, `kept ${kept}`);
}

/** @brief 填写：Name 必填、行的窗口错误、Max output 随窗口变，有错误时 Test connection 不可用。 */
async function listedFilling(ctx) {
  const { page } = ctx;
  await pickRow(page, 'fake-coder', true);
  await setName(page, '');
  const noName = await readForm(page);
  record('MD-11 filling in: clearing Name shows "Name is required." and Test connection is unavailable',
    noName.fieldErrors.includes('name:Name is required.') && noName.test.disabled, brief(noName.fieldErrors));
  await setName(page, 'Fake first run');
  await setRowValue(page, 'fake-coder', 'contextWindow', '0');
  const zero = rowIn(await readForm(page), 'fake-coder');
  const blocked = (await readForm(page)).test.disabled;
  record('MD-11 filling in: a ticked row with window 0 shows "Context window must be a whole number above 0." and Test '
    + 'connection is unavailable', zero.errors.includes('contextWindow:Context window must be a whole number above 0.')
    && blocked, brief(zero.errors));
  await setRowValue(page, 'fake-coder', 'contextWindow', '20000');
  const small = await readForm(page);
  const row = rowIn(small, 'fake-coder');
  record('MD-11 filling in: window 20000 makes the untouched Max output 10000 (half the window, the default, '
    + '"Default"); the window has no "Default" (the server reported it) and Test connection is available again',
  row.maxTokens === '10000' && JSON.stringify(row.defaults) === '["maxTokens:Default"]'
    && row.errors.length === 0 && !small.test.disabled, brief(row));
  await setRowValue(page, 'fake-coder', 'contextWindow', '131072');
  const chats = chatLogs(endpoints.listed).length + chatLogs(endpoints.slow).length;
  record('MD-11 before Test connection nothing is written and nothing but reads is sent: no model-config.json, no '
    + 'credentials.json entry, and the fetches sent no chat request (first-run.md counter-examples)',
  !existsSync(join(ctx.userData, 'model-config.json')) && credentialRefs(ctx.userData).length === 0 && chats === 0,
  `config ${existsSync(join(ctx.userData, 'model-config.json'))}, chats ${chats}`);
}

/**
 * @brief 保存与测试一个勾选的模型：Saving…、Testing…、命令、结果；测试成功后表单关掉、进入主窗口（first-run.md
 *        "测试成功之后：主窗口"），探针在后台照样跑；配置；key 不在页面上。
 */
async function listedSave(ctx) {
  const { page, userData } = ctx;
  const since = Date.now();
  await clickTest(ctx);
  const done = await waitTestResult(page);
  const samples = await watchedStates(page);
  const locked = (sample) => sample.testDisabled && sample.readOnly.every(Boolean) && sample.fetchDisabled;
  record('MD-11 saving: Test connection reads "Saving…" and then "Testing…" (with its Cancel), unavailable both times; '
    + 'Base URL and API key are read-only and Fetch models is unavailable meanwhile',
  samples.some((s) => s.test === 'Saving…' && locked(s)) && samples.some((s) => s.test === 'Testing…' && locked(s)
    && s.testCancel), brief(samples.map((s) => `${s.test}/${s.testCancel}`)));
  const runs = await saveAndTest(ctx, since);
  record('MD-11 saving: one models.firstRun (providerId null, the typed key, the Base URL box and API type of '
    + 'the form, models = the one ticked row) and then connection.test for that model',
  runs[0]?.type === 'models.firstRun' && runs[0].providerId === null && runs[0].key === tail(KEY.one)
    && runs[0].baseUrl === url(PORT.listed) && runs[0].api === 'openai-completions'
    && JSON.stringify(runs[0].models) === '["fake-coder"]' && runs[1]?.type === 'connection.test'
    && runs[1].providerId === 'fake-first-run' && runs[1].modelId === 'fake-coder' && runs.length === 2, brief(runs));
  record('MD-11 test passed: "Connected · First token Nms · Total Nms"', CONNECTED.test(resultText(done) ?? ''),
    resultText(done));
  await listedHandOver(page, done);
  const chats = plainChats(endpoints.listed, since);
  record('MD-11 the endpoint got the connection test for fake-coder with the saved key', chats.some((chat) =>
    chat.model === 'fake-coder' && chat.key === tail(KEY.one)), brief(chats));
  listedSavedConfig(userData);
  record('MD-11 saved: the key is not shown anywhere on the page (the form, its box and its in-memory key are gone '
    + 'with the hand-over)', secretsIn(await page.content()).length === 0);
}

/**
 * @brief 测试成功之后（2026-10-26 负责人走查 M2，first-run.md "测试成功之后：主窗口"）：表单关掉，三栏布局，中栏
 *        Open a folder 提示的标题下面紧跟一行"Connected · …"（成功的颜色），说明与 Open folder…；页面上没有探针状态；
 *        探针在后台照样跑（经进程桥读档案：测试的那个模型这时还在探测，listed 端点每个对话请求先等 1.5 秒）。
 *        这是这个数据目录里第一次保存，models.get 的档案 status 为 probing 只在从未完成探测、正在探测时出现，
 *        所以查 status，不查 probeState（没有档案也算 verifying，分不出“在探测”和“没开始探测”）。
 */
async function listedHandOver(page, done) {
  const main = done?.main;
  const samples = (await watchedStates(page)).filter((s) => s.connected);
  record('MD-11 test passed: the first-run form closes and the main window opens (sidebar); its "Open a folder" '
    + 'prompt has the "Connected · …" result right under the heading (ok tone), "Choose a project folder to start a '
    + 'session." and Open folder…; there is no probe status anywhere', Boolean(done?.handedOver) && !main.form
    && main.sidebar && main.prompt?.heading === 'Open a folder' && main.prompt.underHeading && main.prompt.tone
    && CONNECTED.test(main.prompt.connected ?? '') && main.prompt.hint === TEXT.chooseFolder && main.prompt.open
    && samples.length > 0 && samples.every((s) => s.test === null)
    && await page.locator('[data-testid="probe-status"]').count() === 0, brief(main));
  record('MD-11 test passed: the "Connected · …" line in the main window’s "Open a folder" prompt is a status '
    + 'message for screen readers (role="status")', Boolean(done?.handedOver)
    && CONNECTED.test(main?.prompt?.connected ?? '') && main.prompt.role === 'status', brief(main?.prompt));
  const probe = await readProbe(page, 'fake-first-run/fake-coder');
  record('MD-11 the probes keep running after the hand-over: right after the test the tested model '
    + 'fake-first-run/fake-coder is still being verified (models.get: its profile status is probing)',
  probe.status === 'probing', brief(probe));
}

/** @brief 一个勾选的模型保存后的配置（first-run.md "保存中""已保存"与"API key""表单字段"）。 */
function listedSavedConfig(userData) {
  const config = readConfig(userData);
  const provider = config?.providers?.[0];
  record('MD-11 saved with one ticked model: one provider fake-first-run named "Fake first run" on '
    + 'http://127.0.0.1:4840/v1 (OpenAI-compatible, no zone, compat max_tokens, Concurrency per key 4) with only '
    + 'fake-coder (131072 / 16384), one key fake-first-run#1 "Key 1" and normalDefault fake-first-run/fake-coder',
  config?.providers.length === 1 && provider.id === 'fake-first-run' && provider.name === 'Fake first run'
    && provider.baseUrl === url(PORT.listed) && provider.api === 'openai-completions' && !('zone' in provider)
    && provider.compat?.maxTokensField === 'max_tokens' && provider.concurrency === 4
    && JSON.stringify(modelIds(provider)) === '["fake-coder"]' && provider.models[0].contextWindow === 131072
    && provider.models[0].maxTokens === 16384 && JSON.stringify(provider.keys)
    === '[{"ref":"fake-first-run#1","label":"Key 1"}]' && config.normalDefault === 'fake-first-run/fake-coder'
    && JSON.stringify(credentialRefs(userData)) === '["fake-first-run#1"]', brief(config));
}

/**
 * @brief 一个模型：主窗口的 Open folder… 后新会话的范围是这个模型；探针还在跑时会话的拒绝启动卡是
 *        "Verifying fake-first-run/fake-coder…"，探针结束自动解除（first-run.md "打开文件夹之后"，原来表单下方
 *        "Verifying tool calling…"的去处），之后能发送；打开会话后"Connected · …"一行不再出现（listedShownOnce）。
 */
async function listedSession(ctx) {
  const session = await sessionCheck(ctx, makeProject('listed'), endpoints.listed);
  const ref = 'fake-first-run/fake-coder';
  record('MD-11 Open folder… from the main window with one ticked model: the new session’s range is that model '
    + `(${ref}); while its probes run the session shows only the blocked card "Verifying ${ref}…", which clears by `
    + 'itself, and then the session gets a reply from fake-coder', session.pick === ref
    && session.cards.some((card) => card.kind === 'verifying' && card.title === `Verifying ${ref}…`)
    && session.cards.every((card) => card.kind === 'verifying') && sessionOk(session, 'fake-coder'),
  sessionBrief(session));
  await listedShownOnce(ctx.page);
}

/**
 * @brief "只显示一次"（first-run.md 状态表"打开了会话"）：Open a folder 提示只在中栏没有会话时出现，会话开着时看不出
 *        那一行清没清掉；所以把刚才的会话归档（会话行菜单的 Archive，照 Claude 桌面版不确认），中栏回到 Open a folder
 *        提示，再查提示里没有"Connected · …"。
 */
async function listedShownOnce(page) {
  await chooseMenuItem(page, await activeFile(page), 'Archive');
  const main = (await poll(() => readMain(page), (value) => value.prompt !== null, 10000, 200)).value;
  record('MD-11 the "Connected · …" line is shown once: after the session is archived the centre is back at the '
    + '"Open a folder" prompt, without the line', main.prompt?.heading === 'Open a folder'
    && main.prompt.connected === null && main.prompt.open
    && await page.locator('[data-testid="connected"]').count() === 0, brief(main));
}

/** @brief 已有配置：首次启动之后再启动，不显示表单。 */
async function listedRelaunch(userData) {
  let ctx;
  try {
    ctx = await startApp(userData, exePath);
    const form = await ctx.page.locator(FORM).count();
    const sidebar = await ctx.page.getByTestId('sidebar').isVisible();
    record('MD-11 first-run entry (existing config): after the first run, starting Mori again opens the main window '
      + 'without the first-run form', form === 0 && sidebar, `form ${form}, sidebar ${sidebar}`);
  } catch (error) {
    record('MD-11 listed relaunch: flow', false, brief(String(error), 400));
    await shot(ctx, 'listed-relaunch-error');
  } finally {
    await finish(ctx, 'listed relaunch');
  }
}

/** @brief 拿到列表的整条首次启动。 */
async function listed() {
  const userData = tempDir('mori-mdfr-listed-');
  let ctx;
  try {
    ctx = await openApp(userData);
    await listedStart(ctx);
    await listedCancel(ctx);
    await listedFetch(ctx);
    await listedManual(ctx);
    await listedApi(ctx);
    await listedRefetch(ctx);
    await listedFilling(ctx);
    await listedSave(ctx);
    await listedSession(ctx);
  } catch (error) {
    record('MD-11 listed: flow', false, brief(String(error?.stack ?? error), 600));
    await shot(ctx, 'listed-error');
  } finally {
    await finish(ctx, 'listed');
  }
  await listedRelaunch(userData);
}

// ---------- keys：内存里的 key 与 origin（§6.6，2026-10-23 负责人决定）、再次保存、勾两个模型 ----------

/**
 * @brief 第一次保存：拉取（key 在框里）→ 只勾手填的 FAILING → Test connection：保存成功、测试失败（400），表单留着
 *        （测试成功就进入主窗口了，内存里的 key 要在表单上接着测）；返回提供商 id。
 */
async function keysFirstSave(ctx) {
  const { page, userData } = ctx;
  await setBaseUrl(page, url(PORT.listed));
  await setKey(page, KEY.one);
  await fetchModels(ctx);
  await addManual(page, FAILING);
  const done = await testConnection(ctx);
  const config = readConfig(userData);
  const providerId = config?.providers?.[0]?.id ?? null;
  record(`MD-11 (keys) first save: the save works and the test fails (${FAILING} answers it with 400: "Connection `
    + 'failed: <raw>"), so the form stays (no main window); one provider with only that model and its key; saved: '
    + 'the API key box is emptied with placeholder "Saved. Leave empty to keep it."', failedOnForm(done)
    && config?.providers.length === 1 && JSON.stringify(modelIds(config.providers[0])) === `["${FAILING}"]`
    && config.providers[0].keys.length === 1 && done.apiKey.length === 0 && done.apiKey.placeholder === TEXT.saved,
  brief({ done: resultText(done), config }));
  return { providerId, keyRef: config?.providers?.[0]?.keys?.[0]?.ref ?? null };
}

/** @brief 同一个 origin（只改路径）：回到开始、占位不变；框空着再拉取用内存里的 key，不出 rejected。 */
async function keysSameOrigin(ctx) {
  const { page } = ctx;
  await setBaseUrl(page, url(PORT.listed, '/proxy/v1'));
  const start = await readForm(page);
  record('MD-11 changing Base URL after saving returns to the start state: the checklist and the test result are '
    + 'cleared', atStart(start) && resultText(start) === null, brief(start));
  record('MD-11 same origin after saving (only the path changed): the API key placeholder stays "Saved. Leave empty to '
    + 'keep it." and the box stays empty', start.apiKey.placeholder === TEXT.saved && start.apiKey.length === 0,
  brief(start.apiKey));
  const since = Date.now();
  const state = await fetchModels(ctx);
  const sent = await lastDiscover(ctx, since);
  const lists = listLogs(endpoints.listed, since);
  record('MD-11 refetch with an empty box on the same origin uses the in-memory key: models.discover carries it, the '
    + 'endpoint (FAKE_REQUIRE_KEY) logs its last 4 on /proxy/v1/models and the list loads (no rejected)',
  sent?.key === tail(KEY.one) && lists.some((line) => line.path === '/proxy/v1/models' && line.key === tail(KEY.one))
    && state.listError === null && state.checklist && state.apiKey.length === 0, brief({ sent, lists,
    listError: state.listError }));
}

/**
 * @brief 同一个 origin、框空着再次保存（first-run.md "保存中"与"API key"：框为空时 keySecret 为 null，保留已存的 key，
 *        内存里的 key 不再发送；测试仍用 FAILING，失败，表单留着）；之后什么也不改再点 Fetch models
 *        （"保存后再拉取"的"或再点 Fetch models"）。
 */
async function keysSameOriginSave(ctx, first) {
  const { page, userData } = ctx;
  await addManual(page, FAILING);
  const since = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, since);
  const provider = readConfig(userData)?.providers;
  const tests = plainChats(endpoints.listed, since);
  record('MD-11 saving again on the same origin with an empty box sends no key and keeps the saved key: still one '
    + 'provider (same id) now on /proxy/v1 with the same key ref; the test reaches the endpoint with that key (and '
    + 'fails with 400, so the form stays)',
  runs[0]?.type === 'models.firstRun' && runs[0].key === null && runs[0].providerId === first.providerId
    && runs[0].baseUrl === url(PORT.listed, '/proxy/v1') && provider?.length === 1
    && provider[0].baseUrl === url(PORT.listed, '/proxy/v1') && JSON.stringify(provider[0].keys.map((key) => key.ref))
    === JSON.stringify([first.keyRef]) && credentialRefs(userData).includes(first.keyRef)
    && tests.some((chat) => chat.model === FAILING && chat.key === tail(KEY.one)) && failedOnForm(done),
  brief({ runs, keys: provider?.[0]?.keys, tests }));
  record('MD-11 after saving on the same origin the API key box stays empty with "Saved. Leave empty to keep it."',
    done.apiKey.placeholder === TEXT.saved && done.apiKey.length === 0, brief(done.apiKey));
  const after = Date.now();
  const again = await fetchModels(ctx);
  const sent = await lastDiscover(ctx, after);
  record('MD-11 clicking Fetch models again after saving (nothing changed, the box empty) uses the in-memory key: '
    + 'models.discover carries it, the endpoint logs its last 4 and the list loads (no rejected)',
  sent?.key === tail(KEY.one) && listLogs(endpoints.listed, after).some((line) => line.key === tail(KEY.one))
    && again.listError === null && again.checklist && again.apiKey.length === 0,
  brief({ sent, listError: again.listError }));
}

/** @brief 另一个 origin：占位 Optional，拉取不带 key（rejected）；改回来占位与 key 恢复。 */
async function keysOtherOrigin(ctx) {
  const { page } = ctx;
  await setBaseUrl(page, url(PORT.other));
  const moved = await readForm(page);
  record('MD-11 another origin after saving (2026-10-23 owner decision): the API key placeholder is "Optional"',
    moved.apiKey.placeholder === TEXT.optional && moved.apiKey.length === 0, brief(moved.apiKey));
  let since = Date.now();
  const state = await fetchModels(ctx);
  const sent = await lastDiscover(ctx, since);
  const lists = listLogs(endpoints.other, since);
  record('MD-11 another origin: the fetch does not send the in-memory key (keySecret null; the endpoint logs key null) '
    + 'and the key-checking server answers "The server rejected the API key: <raw 401 body>"',
  sent?.key === null && lists.length > 0 && lists.every((line) => line.key === null)
    && state.listError?.kind === 'rejected' && state.listError.text[0] === `The server rejected the API key: ${DENIED}`
    && state.listError.text[1] === TEXT.stillAdd, brief({ sent, lists, listError: state.listError }));
  record('MD-11 list error: no Detected line, no "Models (N)", Select all, Clear selection or filter; Name and API '
    + 'type are prefilled; Add a model ID, More settings and the probe-cost note are there; Test connection is '
    + 'unavailable with nothing entered', !state.detected && !state.checklist && !state.selectAll
    && !state.clearSelection && !state.filter && state.name === '127.0.0.1:4842' && state.api === 'openai-completions'
    && Boolean(state.manual) && state.moreSettings && state.probeCost === TEXT.cost
    && state.test.disabled && state.closeForm === 0, brief(state));
  await setBaseUrl(page, url(PORT.listed));
  const back = await readForm(page);
  since = Date.now();
  const again = await fetchModels(ctx);
  const resent = await lastDiscover(ctx, since);
  record('MD-11 switching back to the saved origin restores "Saved. Leave empty to keep it." and the in-memory key: '
    + 'the fetch carries it, the endpoint logs its last 4 and the list loads', back.apiKey.placeholder === TEXT.saved
    && resent?.key === tail(KEY.one) && listLogs(endpoints.listed, since).some((line) => line.key === tail(KEY.one))
    && again.listError === null && again.checklist, brief({ placeholder: back.apiKey.placeholder, resent }));
}

/** @brief 带着另一个 origin、框空着保存：不发 key，整体替换，已存的 key 删掉；之后内存里的 key 也不再用。 */
async function keysDropKey(ctx, first) {
  const { page, userData } = ctx;
  await setBaseUrl(page, url(PORT.other));
  await fetchModels(ctx);
  await addManual(page, 'fake-coder');
  const since = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, since);
  const config = readConfig(userData);
  const provider = config?.providers?.[0];
  record('MD-11 saving with another origin and an empty box sends no key and replaces the provider: one provider with '
    + 'the same id on the new origin, models [fake-coder], normalDefault <id>/fake-coder, and the saved key is deleted '
    + '(origin changed, model layer §4.1)', runs[0]?.type === 'models.firstRun' && runs[0].key === null
    && runs[0].providerId === first.providerId && config?.providers.length === 1 && provider.id === first.providerId
    && provider.baseUrl === url(PORT.other) && provider.keys.length === 0
    && JSON.stringify(modelIds(provider)) === '["fake-coder"]'
    && config.normalDefault === `${first.providerId}/fake-coder` && !credentialRefs(userData).includes(first.keyRef),
  brief({ runs, config, refs: credentialRefs(userData) }));
  record('MD-11 test failed: with no key the key-checking server refuses the test: "Connection failed: <raw>" and the '
    + 'form stays (no main window)', failedOnForm(done), resultText(done));
  record('MD-11 after saving with another origin the in-memory key is dropped: the placeholder is "Optional"',
    done.apiKey.placeholder === TEXT.optional, brief(done.apiKey));
  await setBaseUrl(page, url(PORT.listed));
  const back = await readForm(page);
  const after = Date.now();
  const state = await fetchModels(ctx);
  record('MD-11 after the key was dropped the first origin gets no in-memory key either: placeholder "Optional", the '
    + 'fetch sends no key and is rejected', back.apiKey.placeholder === TEXT.optional
    && (await lastDiscover(ctx, after))?.key === null && listLogs(endpoints.listed, after).every((line) =>
    line.key === null) && state.listError?.kind === 'rejected', brief({ placeholder: back.apiKey.placeholder,
    listError: state.listError }));
}

/** @brief 再次保存（key 重新填）：勾两个列出的模型和一个手填的，测第一个勾选的；范围是提供商。 */
async function keysTwoModels(ctx, first) {
  const { page, userData } = ctx;
  await setKey(page, KEY.one);
  await fetchModels(ctx);
  await addManual(page, 'fake-coder-typed');
  await pickRow(page, 'fake-coder-notools', true);
  await pickRow(page, 'fake-coder-b', true);
  const since = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, since);
  const config = readConfig(userData);
  const provider = config?.providers?.[0];
  const order = ['fake-coder-notools', 'fake-coder-b', 'fake-coder-typed'];
  record('MD-11 saving again replaces the whole provider: still one provider with the same id, back on the first '
    + 'origin with one new key, models in checklist order [fake-coder-notools, fake-coder-b, fake-coder-typed]',
  runs[0]?.providerId === first.providerId && runs[0].key === tail(KEY.one) && config?.providers.length === 1
    && provider.id === first.providerId && provider.baseUrl === url(PORT.listed) && provider.keys.length === 1
    && JSON.stringify(modelIds(provider)) === JSON.stringify(order), brief({ runs, provider }));
  record('MD-11 two or more ticked models: normalDefault is the provider id',
    config?.normalDefault === first.providerId, String(config?.normalDefault));
  const typed = provider?.models.find((model) => model.id === 'fake-coder-typed');
  record('MD-08 first run with a list: the entered row is saved with the ticked rows, last, as 128000 / 16384, no '
    + 'thinking, text only, empty family', typed?.contextWindow === 128000 && typed.maxTokens === 16384
    && typed.reasoning === false && JSON.stringify(typed.input) === '["text"]' && typed.family === '', brief(typed));
  const tests = plainChats(endpoints.listed, since);
  record('MD-11 two ticked models: Test connection tests the first ticked one (connection.test for fake-coder-notools; '
    + 'the endpoint got that test with the new key), says Connected and the main window opens', runs.find((run) =>
    run.type === 'connection.test')?.modelId === 'fake-coder-notools' && tests.some((chat) => chat.model
    === 'fake-coder-notools' && chat.key === tail(KEY.one)) && CONNECTED.test(resultText(done) ?? '')
    && Boolean(done?.handedOver), brief({ runs, tests }));
  await keysTwoProbes(page, since, order, first.providerId);
}

/**
 * @brief 再次保存后：这次勾选的模型都开始探针；进入主窗口后探针照样跑完，测试的那个（第一个勾选的）
 *        fake-coder-notools 判定失败（经进程桥读档案；首次启动里不再显示探针状态）。
 */
async function keysTwoProbes(page, since, order, providerId) {
  const probed = await poll(() => new Set(chatLogs(endpoints.listed, since).filter((chat) => chat.probe)
    .map((chat) => chat.model)), (models) => order.every((id) => models.has(id)), 60000, 300);
  record('MD-11 saving again starts the probes of every model ticked this time (the endpoint gets probe requests for '
    + 'all three)', probed.ok, brief([...probed.value]));
  const probe = await waitProbe(page, `${providerId}/fake-coder-notools`, { since });
  const main = await readMain(page);
  record('MD-11 after the hand-over the probes of the tested (first ticked) model fake-coder-notools end with tool '
    + 'calling failed (models.get); the main window still offers Open folder…', probe === 'failed'
    && Boolean(main.prompt?.open), brief({ probe, main }));
}

/** @brief 勾了多个模型：新会话的范围是提供商，其中一个已验证就能发送（下一个候选 fake-coder-b）。 */
async function keysSession(ctx, first) {
  const session = await sessionCheck(ctx, makeProject('keys'), endpoints.listed);
  record('MD-11 Open folder… with several ticked models: the new session’s range is the provider; it can send once one '
    + 'of them is verified, and the reply comes from fake-coder-b (the next candidate after the failed '
    + 'fake-coder-notools)', session.pick === first.providerId && sessionOk(session, 'fake-coder-b'),
  sessionBrief(session));
}

/** @brief 内存里的 key、origin、再次保存与勾两个模型。 */
async function keys() {
  const userData = tempDir('mori-mdfr-keys-');
  let ctx;
  try {
    ctx = await openApp(userData);
    const first = await keysFirstSave(ctx);
    await keysSameOrigin(ctx);
    await keysSameOriginSave(ctx, first);
    await keysOtherOrigin(ctx);
    await keysDropKey(ctx, first);
    await keysTwoModels(ctx, first);
    await keysSession(ctx, first);
  } catch (error) {
    record('MD-11 keys: flow', false, brief(String(error?.stack ?? error), 600));
    await shot(ctx, 'keys-error');
  } finally {
    await finish(ctx, 'keys');
  }
}

// ---------- changes（A20）：卡片宽度、新的一次拉取清掉测试结果、“表单有改动”、内存里的 key 是上次保存成功时的 key ----------

/** 首次启动卡片的默认宽度与有清单的行时的宽度（A20；forms.css 的 .first-run-card、models-settings.css） */
const CARD_WIDTH = { plain: 560, wide: 720 };
/** 比 720px 窄、放得下 560px 卡片的视口（CDP 模拟，见 emulateViewport） */
const NARROW = { width: 680, height: 800 };
/** @brief 卡片宽度是不是 px（差不到半个像素）。 */
const widthIs = (card, px) => Boolean(card) && Math.abs(card.width - px) < 0.5;

/** @brief 宽窗口里的卡片宽度：开始、列表错误没有行、列表错误下手填一行、空列表、列出的行；然后看窄窗口。 */
async function changesWidth(ctx) {
  const { page } = ctx;
  const seen = { start: await cardWidth(page) };
  await setBaseUrl(page, url(PORT.nolist));
  await fetchModels(ctx);
  seen.listError = await cardWidth(page);
  await addManual(page, 'fake-coder');
  seen.entered = await cardWidth(page);
  await setBaseUrl(page, url(PORT.empty));
  await fetchModels(ctx);
  seen.empty = await cardWidth(page);
  await setBaseUrl(page, url(PORT.open));
  await fetchModels(ctx);
  seen.listed = await cardWidth(page);
  const plain = [seen.start, seen.listError, seen.empty];
  const wide = [seen.entered, seen.listed];
  record('MD-11 first-run card width (A20): 720px while checklist rows show (the listed rows, or an entered row under '
    + 'a list error), its default 560px otherwise (at the start, with a list error and no rows, with "Models (0)")',
  plain.every((card) => widthIs(card, CARD_WIDTH.plain) && card.rows === 0 && !card.table)
    && wide.every((card) => widthIs(card, CARD_WIDTH.wide) && card.rows > 0 && card.table)
    && seen.listed.rows === LISTED.length && seen.listed.room > CARD_WIDTH.wide, brief(seen));
  await changesNarrow(ctx);
}

/** @brief 窄窗口：有清单的行时卡片占满它能占的宽度（不到 720px），回到开始时仍是 560px。 */
async function changesNarrow(ctx) {
  const { page } = ctx;
  await emulateViewport(ctx, NARROW);
  try {
    const rows = await cardWidth(page);
    await setBaseUrl(page, '');
    const start = await cardWidth(page);
    record('MD-11 first-run card width (A20) in a window narrower than 720px (a 680px viewport via CDP): with '
      + 'checklist rows the card takes the whole width it has (min(720px, the room)); back at the start it is 560px',
    Boolean(rows && start) && rows.rows > 0 && rows.table && rows.room < CARD_WIDTH.wide
      && rows.room > CARD_WIDTH.plain
      && widthIs(rows, rows.room) && widthIs(start, CARD_WIDTH.plain) && start.rows === 0, brief({ rows, start }));
  } finally {
    await emulateViewport(ctx, null);
  }
}

/**
 * @brief 第一次保存（key A，只勾手填的 FAILING）：保存成功、测试失败，表单留着（这一步之后的 A20 检查都要在表单上做）；
 *        等它的探针跑完（经进程桥）；返回提供商 id、key 的 ref 与这次 models.firstRun 的摘要。
 */
async function changesFirstSave(ctx) {
  const { page, userData } = ctx;
  await setBaseUrl(page, url(PORT.open));
  await setKey(page, KEY.a);
  await fetchModels(ctx);
  await addManual(page, FAILING);
  const since = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, since);
  const provider = readConfig(userData)?.providers;
  const probe = await waitProbe(page, `${provider?.[0]?.id}/${FAILING}`, { since });
  record(`MD-11 (changes) first save with key A: models.firstRun carries A, the test of ${FAILING} fails ("Connection `
    + 'failed: <raw>") and the form stays; one provider with one key; its probes finish (models.get)',
  runs[0]?.type === 'models.firstRun' && runs[0].key === tail(KEY.a) && failedOnForm(done) && provider?.length === 1
    && provider[0].keys.length === 1 && probe !== 'verifying', brief({ runs, result: resultText(done), probe }));
  return { providerId: provider?.[0]?.id ?? null, keyRef: provider?.[0]?.keys?.[0]?.ref ?? null, save: runs[0] };
}

/**
 * @brief 测试失败后什么也不改再点 Fetch models：拉取一开始测试结果就清掉（A20；2026-10-26 起表单上只剩测试结果，
 *        探针状态与 Open folder… 不在表单上）；勾回同一行（再手填 FAILING）再测：表单没有改动，不保存。
 */
async function changesRefetch(ctx, first) {
  const { page } = ctx;
  // 点之前测试结果在（否则“清掉”无从谈起）
  const before = await readForm(page);
  const shown = Boolean(before) && (resultText(before) ?? '').startsWith(FAILED);
  const since = Date.now();
  const { during, after } = await fetchObserved(ctx);
  const sent = await lastDiscover(ctx, since);
  const cleared = (state) => Boolean(state) && resultText(state) === null;
  record('MD-11 a new fetch clears the test result (A20): Fetch models clicked again after a failed test (its '
    + '"Connection failed: …" shown before the click) shows no test result while fetching, nor after the list loads',
  shown && cleared(during) && cleared(after) && Boolean(after?.checklist) && sent?.key === tail(KEY.a),
  brief({ before: resultText(before), during: resultText(during), after: resultText(after), sent }));
  await addManual(page, FAILING);
  const at = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, at);
  record('MD-11 the form changed (A20): after that fetch, with the same ticks and values (the entered row again) and '
    + 'the key box empty, Test connection does not save again (no models.firstRun), it only runs connection.test',
  runs.length === 1 && runs[0].type === 'connection.test' && runs[0].providerId === first.providerId
    && failedOnForm(done), brief({ runs, result: resultText(done) }));
}

/** @brief 只改 Name：Test connection 重新保存（不带 key，其余同上次），配置里的名字跟着改；返回这次的摘要。 */
async function changesName(ctx, first) {
  const { page, userData } = ctx;
  await setName(page, 'Renamed first run');
  const since = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, since);
  const provider = readConfig(userData)?.providers;
  const same = (run) => ['baseUrl', 'api'].every((key) => run[key] === first.save?.[key])
    && JSON.stringify(run.models) === JSON.stringify(first.save?.models);
  record('MD-11 the form changed (A20): changing only Name makes Test connection save again: one models.firstRun '
    + '(same provider id, no key, the new Name, the same Base URL, API type and models) and then '
    + 'connection.test; the saved provider is renamed and keeps its key',
  runs.length === 2 && runs[0].type === 'models.firstRun' && runs[0].providerId === first.providerId
    && runs[0].key === null && runs[0].name === 'Renamed first run' && same(runs[0])
    && runs[0].digest !== first.save?.digest && runs[1].type === 'connection.test'
    && provider?.length === 1 && provider[0].name === 'Renamed first run'
    && JSON.stringify(provider[0].keys.map((key) => key.ref)) === JSON.stringify([first.keyRef])
    && failedOnForm(done), brief({ runs, provider }));
  // 这次保存重新探测 FAILING（firstRun 的 probeRefs）：等完成时刻不早于 since 的新档案，之后的检查不和探针重叠
  await waitProbe(page, `${first.providerId}/${FAILING}`, { since });
  return runs[0] ?? null;
}

/**
 * @brief 只改 key 框（填 key B，拉取与勾选同上次）：Test connection 重新保存并带 key B；model-config.json 设成只读
 *        （synthetic test setup，同 md-app-form 的保存失败），这次保存失败，配置与存着的 key 不变。
 * @param last 上次保存成功的 models.firstRun 摘要（只改 Name 那次）
 */
async function changesFailedKey(ctx, first, last) {
  const { page, userData } = ctx;
  await setKey(page, KEY.b);
  await fetchModels(ctx);
  await addManual(page, FAILING);
  const file = join(userData, 'model-config.json');
  const before = readFileSync(file, 'utf8');
  const refs = JSON.stringify(credentialRefs(userData));
  // synthetic test setup：model-config.json 设成只读，挡住这次保存的写入
  chmodSync(file, 0o444);
  try {
    const since = Date.now();
    const done = await testConnection(ctx);
    const runs = await saveAndTest(ctx, since);
    const kept = await poll(() => credentialRefs(userData), (list) => JSON.stringify(list) === refs, 5000);
    record('MD-11 the form changed (A20): changing only the API key box (key B typed, the same fetch and ticks) makes '
      + 'Test connection save again: models.firstRun goes out with key B and otherwise the same content as the last '
      + 'save (same digest); with model-config.json read-only that save fails ("Couldn’t save: <raw>"), no test runs, '
      + 'and the config and the stored keys stay as they were', runs.length === 1 && runs[0].type === 'models.firstRun'
      && runs[0].key === tail(KEY.b) && runs[0].providerId === first.providerId && runs[0].digest === last?.digest
      && (resultText(done) ?? '').startsWith('Couldn’t save: ') && readFileSync(file, 'utf8') === before && kept.ok,
    brief({ runs, result: resultText(done), refs: kept.value }));
  } finally {
    chmodSync(file, 0o666);
  }
}

/**
 * @brief 清空 key 框再拉取：内存里的 key 仍是上次保存成功时发出的 key A，不是保存失败的 key B（A20）；
 *        勾回同一行（再手填 FAILING）再测：没有改动、不保存，测试带着存着的 key A（仍是 400，表单留着）。
 */
async function changesKeptKey(ctx) {
  const { page } = ctx;
  await setKey(page, '');
  const empty = await readForm(page);
  const since = Date.now();
  const state = await fetchModels(ctx);
  const sent = await lastDiscover(ctx, since);
  const lists = listLogs(endpoints.open, since);
  record('MD-11 the in-memory key is the key sent with the last successful models.firstRun (A20): after the save with '
    + 'key B failed, clearing the box ("Saved. Leave empty to keep it.") and fetching sends key A: models.discover and '
    + 'every list request at the endpoint carry A’s last 4, none B’s, and the list loads',
  empty?.apiKey.placeholder === TEXT.saved && empty.apiKey.length === 0 && sent?.key === tail(KEY.a)
    && lists.length > 0 && lists.every((line) => line.key === tail(KEY.a)) && state.checklist
    && state.listError === null, brief({ placeholder: empty?.apiKey.placeholder, sent, lists }));
  await addManual(page, FAILING);
  const at = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, at);
  const tests = plainChats(endpoints.open, at);
  record('MD-11 after the failed save with key B the stored key is still A (A20): Test connection with the box empty '
    + 'and nothing else changed does not save (only connection.test), and the test reaches the endpoint with key A',
  runs.length === 1 && runs[0].type === 'connection.test' && tests.length > 0
    && tests.every((chat) => chat.key === tail(KEY.a)) && failedOnForm(done),
  brief({ runs, tests: tests.map((chat) => chat.key), result: resultText(done) }));
}

/** @brief 卡片宽度、新的一次拉取、表单有改动、内存里的 key（A20）。 */
async function changes() {
  const userData = tempDir('mori-mdfr-changes-');
  let ctx;
  try {
    ctx = await openApp(userData);
    await changesWidth(ctx);
    const first = await changesFirstSave(ctx);
    await changesRefetch(ctx, first);
    const renamed = await changesName(ctx, first);
    await changesFailedKey(ctx, first, renamed);
    await changesKeptKey(ctx);
  } catch (error) {
    record('MD-11 changes: flow', false, brief(String(error?.stack ?? error), 600));
    await shot(ctx, 'changes-error');
  } finally {
    await finish(ctx, 'changes');
  }
}

// ---------- shapes：空列表、过滤与截断（藏起来的勾选行照样保存），测试成功进入主窗口 ----------

/** @brief 空列表与超过 1000 条（过滤框、截断说明）。 */
async function shapesLists(ctx) {
  const { page } = ctx;
  await setBaseUrl(page, url(PORT.empty));
  const empty = await fetchModels(ctx);
  record('MD-11 empty list: "Models (0)" and "The server didn’t list any models.", then Add a model ID; Test '
    + 'connection is unavailable', empty.checklist && empty.heading === 'Models (0)'
    && empty.notes.includes(TEXT.emptyList) && empty.rows.length === 0 && Boolean(empty.manual) && empty.order
    && empty.test.disabled, brief(empty));
  await setBaseUrl(page, url(PORT.many));
  const many = await fetchModels(ctx, 60000);
  record('MD-11 more than 1,000 models: "Models (1000)", "Showing the first 1,000 models." and a filter box "Filter '
    + 'models" (more than 20 rows)', many.heading === 'Models (1000)' && many.truncated === 'Showing the first 1,000 '
    + 'models.' && many.filter?.placeholder === 'Filter models' && many.rows.length === 1000,
  brief({ heading: many.heading, truncated: many.truncated, filter: many.filter, rows: many.rows.length }));
  await page.locator(`${FORM} [data-testid="checklist-filter"]`).fill('MODEL-100');
  const filtered = await readForm(page);
  record('MD-11 the filter box filters by id substring ignoring case ("MODEL-100" leaves model-1000)',
    JSON.stringify(filtered.rows.map((row) => row.id)) === '["model-1000"]', brief(filtered.rows.map((r) => r.id)));
}

/** @brief 勾上的行的 id：清空过滤框读出全部行，再把过滤框改回 filter。 */
async function pickedIds(page, filter) {
  const box = page.locator(`${FORM} [data-testid="checklist-filter"]`);
  await box.fill('');
  const ids = (await readForm(page)).rows.filter((row) => row.picked).map((row) => row.id);
  await box.fill(filter);
  return ids;
}

/**
 * @brief 过滤框藏起来的行（first-run.md "清单"与"保存中"）：Select all、Clear selection 只作用于显示着的行；
 *        Test connection 保存勾选的全部行（按清单顺序，含藏起来的），测第一个勾选的（这里是藏起来的 model-0001），
 *        测试成功就进入主窗口（所以这一步放在 shapes 的最后）。
 */
async function shapesHidden(ctx) {
  const { page, userData } = ctx;
  const box = page.locator(`${FORM} [data-testid="checklist-filter"]`);
  await box.fill('model-0001');
  await pickRow(page, 'model-0001', true);
  await box.fill('MODEL-100');
  await page.locator(`${FORM} [data-action="select-all"]`).click();
  const shown = (await readForm(page)).rows.map((row) => [row.id, row.picked]);
  const selected = await pickedIds(page, 'MODEL-100');
  await page.locator(`${FORM} [data-action="clear-selection"]`).click();
  const cleared = await pickedIds(page, 'MODEL-100');
  record('MD-07 first run: with the filter on, Select all ticks only the shown row (model-1000) and Clear selection '
    + 'clears only it; the hidden ticked row model-0001 stays ticked', JSON.stringify(shown)
    === '[["model-1000",true]]' && JSON.stringify(selected) === '["model-0001","model-1000"]'
    && JSON.stringify(cleared) === '["model-0001"]', brief({ shown, selected, cleared }));
  await page.locator(`${FORM} [data-action="select-all"]`).click();
  const since = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, since);
  const provider = readConfig(userData)?.providers;
  record('MD-11 saving: models.firstRun carries every ticked row in checklist order, including model-0001 that the '
    + 'filter hides; Test connection tests that first ticked row, says Connected and the main window opens',
  JSON.stringify(runs.map((run) => run.models ?? run.modelId)) === '[["model-0001","model-1000"],"model-0001"]'
    && provider?.length === 1 && JSON.stringify(modelIds(provider[0])) === '["model-0001","model-1000"]'
    && CONNECTED.test(resultText(done) ?? '') && Boolean(done?.handedOver), brief({ runs, result: resultText(done) }));
}

/**
 * @brief 打开失败也算"打开了会话"（first-run.md "测试成功之后：主窗口"的"打开失败"，2026-10-26 补）：测试成功进入主窗口后，
 *        提示里的 Open folder… 选一个不存在的文件夹（synthetic test setup：临时目录下没有建的路径），新会话打开失败，
 *        中栏是它的"Failed to open session: …"；Delete… 删掉这个会话、中栏回到 Open a folder 提示时，没有"Connected · …"一行。
 */
async function shapesFailedOpen(ctx) {
  const { page } = ctx;
  const handed = await readMain(page);
  const missing = join(tempDir('mori-mdfr-missing-'), 'not-created');
  await stubFolder(ctx.app, missing);
  await page.locator('[data-testid="open-folder"] button').click();
  const banner = page.locator(`${PANE} .banner.danger`);
  const failed = await banner.waitFor({ timeout: 30000 }).then(() => banner.innerText(), () => null);
  const dialog = await startDelete(page, await activeFile(page));
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  const main = (await poll(() => readMain(page), (value) => value.prompt !== null, 10000, 200)).value;
  record('MD-11 the "Connected · …" line is shown once, also when the session fails to open: after the test passed, '
    + 'Open folder… on a folder that does not exist shows "Failed to open session: …" in the centre; once that session '
    + 'is deleted the centre is back at the "Open a folder" prompt, without the line', CONNECTED.test(handed.prompt
    ?.connected ?? '') && Boolean(failed?.startsWith('Failed to open session: ')) && main.prompt?.heading
    === 'Open a folder' && main.prompt.connected === null
    && await page.locator('[data-testid="connected"]').count() === 0, brief({ failed, main }));
}

/** @brief 空列表、截断与过滤框（藏起来的勾选行照样保存）；测试成功之后打开失败的会话。 */
async function shapes() {
  const userData = tempDir('mori-mdfr-shapes-');
  let ctx;
  try {
    ctx = await openApp(userData);
    await shapesLists(ctx);
    await shapesHidden(ctx);
    await shapesFailedOpen(ctx);
  } catch (error) {
    record('MD-11 shapes: flow', false, brief(String(error?.stack ?? error), 600));
    await shot(ctx, 'shapes-error');
  } finally {
    await finish(ctx, 'shapes');
  }
}

// ---------- nolist：列表错误（nolist）下手填、测试中与已取消、改勾选再测、tool calling 判定失败的拒绝启动卡 ----------

/** @brief 拉取后清单的标记与提示：服务报告的类型决定默认勾选、Not a chat model、Can’t add this model、两种提示。 */
async function nolistTags(ctx) {
  const { page } = ctx;
  await setBaseUrl(page, url(PORT.typed));
  const typed = await fetchModels(ctx);
  const [chat, embed, spaced] = ['fake-coder', 'embed-small', 'bad id'].map((id) => rowIn(typed, id));
  record('MD-11 after fetch (typed list): the row the server reports as chat is ticked; the embedding row shows "Not a '
    + 'chat model" and is not ticked; an ID with a space shows "Can’t add this model: the ID contains spaces" and '
    + 'cannot be ticked', chat?.picked && chat.chat === 'true' && embed?.chat === 'false' && !embed.picked
    && embed.tags.some((tag) => tag.kind === 'not-chat' && tag.text === 'Not a chat model') && spaced?.unusable
    && !spaced.picked && spaced.pickDisabled && spaced.tags.some((tag) => tag.kind === 'unusable'
    && tag.text === 'Can’t add this model: the ID contains spaces'), brief(typed.rows));
  await setBaseUrl(page, url(PORT.ollama));
  const ollama = await fetchModels(ctx);
  const hints = ollama.rows.map((row) => row.hints.join('+'));
  const texts = await page.locator(`${FORM} [data-testid="row-hint"]`).allTextContents();
  record('MD-11 after fetch (Ollama): "Detected: Ollama 0.10.1"; the second row hints "The server doesn’t list tool '
    + 'support for this model." and the third "Trained context window. Ollama may use a smaller one." (2026-10-26: '
    + 'no long-input test to point to)', ollama.detected?.text === 'Detected: Ollama 0.10.1'
    && JSON.stringify(hints) === '["","no_tools","trained_window"]'
    && texts.includes('The server doesn’t list tool support for this model.')
    && texts.includes('Trained context window. Ollama may use a smaller one.'),
  brief({ detected: ollama.detected, hints }));
}

/** @brief 列表错误（nolist）：两句、换框不写说明、没有清单的标题与按钮。 */
async function nolistError(ctx) {
  const { page } = ctx;
  await setBaseUrl(page, url(PORT.nolist, '/v1/chat/completions/'));
  const since = Date.now();
  const state = await fetchModels(ctx);
  record('MD-11 list error (nolist): "This server doesn’t list its models." and "You can still add model IDs below."; '
    + 'the Base URL box becomes http://127.0.0.1:4843/v1 without the "Updated to …" line; no Detected line',
  state.listError?.kind === 'no_list' && state.listError.text[0] === TEXT.noList
    && state.listError.text[1] === TEXT.stillAdd && state.baseUrl.value === url(PORT.nolist)
    && state.baseUrlNote === null && !state.detected && listLogs(endpoints.nolist, since).length > 0,
  brief({ listError: state.listError, baseUrl: state.baseUrl.value, note: state.baseUrlNote }));
  record('MD-11 list error (nolist): Name "127.0.0.1:4843" and API type are prefilled; the probe-cost '
    + 'note is above Test connection; no close-form Cancel', state.name === '127.0.0.1:4843'
    && state.api === 'openai-completions' && state.probeCost === TEXT.cost
    && state.order && state.closeForm === 0 && state.cancelButtons.length === 0, brief(state));
}

/** @brief MD-08（nolist）：id 检查、手填的行在错误下面、重复、没有清单的标题与按钮。 */
async function nolistManual(ctx) {
  const { page } = ctx;
  await typeManual(page, 'bad id');
  const spaced = await readForm(page);
  record('MD-08 first run with nolist: an ID with a space shows "Model ID must be non-empty and contain no spaces." '
    + 'and Add to list is unavailable', spaced.manual?.errors.includes(TEXT.idSpaces) && spaced.manual.addDisabled,
  brief(spaced.manual));
  await addManual(page, 'fake-slow');
  await typeManual(page, 'fake-slow');
  const twice = await readForm(page);
  record('MD-08 first run with nolist: an ID already entered shows "Model IDs must be unique within a provider." and '
    + 'Add to list is unavailable', twice.manual?.errors.includes(TEXT.idUnique) && twice.manual.addDisabled,
  brief(twice.manual));
  await addManual(page, 'fake-coder');
  const state = await readForm(page);
  const entered = (row) => row.picked && JSON.stringify(row.tags) === '[{"kind":"entered","text":"Entered by you"}]'
    && row.contextWindow === '128000' && row.maxTokens === '16384' && !row.reasoning && !row.image
    && JSON.stringify(row.defaults) === '["contextWindow:Default","maxTokens:Default"]';
  record('MD-08 first run with nolist: the entered rows are listed under the list error in the order added, ticked, '
    + '"Entered by you", 128000 / 16384 "Default"; there is no "Models (N)", Select all, Clear selection or '
    + 'filter',
  JSON.stringify(state.rows.map((row) => row.id)) === '["fake-slow","fake-coder"]'
    && state.rows.every((row) => row.afterListError === true && entered(row)) && !state.checklist
    && !state.selectAll && !state.clearSelection && !state.filter && !state.test.disabled, brief(state.rows));
}

/** @brief 测试中（fake-slow 第一个分块前等 8 秒）与测试已取消；两个手填的模型已保存、范围是提供商。 */
async function nolistCancelTest(ctx) {
  const { page, userData } = ctx;
  const since = Date.now();
  await clickTest(ctx);
  const testing = (await poll(() => readForm(page), (state) => Boolean(state?.testCancel), 20000, 100)).value;
  record('MD-11 testing: "Testing…" (unavailable) with Cancel beside it while the first ticked model fake-slow is '
    + 'tested', testing?.test?.text === 'Testing…' && testing.test.disabled && testing.testCancel?.text === 'Cancel',
  brief(testing));
  await page.locator(`${FORM} [data-action="test-cancel"]`).click();
  const done = await waitTestResult(page);
  const sent = await sentCommands(ctx, ['connection.test', 'connection.testCancel'], since);
  record('MD-11 test cancelled: the test Cancel sends connection.testCancel and the form says "Test cancelled"; the '
    + 'form stays (no main window)', resultText(done) === 'Test cancelled' && done?.handedOver === false
    && sent.some((c) => c.type === 'connection.test' && c.modelId === 'fake-slow')
    && sent.some((c) => c.type === 'connection.testCancel'), brief({ result: resultText(done), sent }));
  const config = readConfig(userData);
  const provider = config?.providers?.[0];
  record('MD-08 first run with nolist: Test connection saved both entered models in order (fake-slow, fake-coder) as '
    + '128000 / 16384; with two models normalDefault is the provider id', JSON.stringify(modelIds(provider))
    === '["fake-slow","fake-coder"]' && provider.models.every((model) => model.contextWindow === 128000
    && model.maxTokens === 16384) && config.normalDefault === provider.id, brief(config));
  const tests = sent.filter((c) => c.type === 'connection.test').map((c) => c.modelId);
  record('MD-11 exactly two ticked models (fake-slow, fake-coder): the default range is the provider id and Test '
    + 'connection tests only the first ticked, fake-slow', typeof provider?.id === 'string'
    && config.normalDefault === provider.id && provider.models.length === 2
    && JSON.stringify(tests) === '["fake-slow"]', brief({ normalDefault: config?.normalDefault, tests }));
  return provider?.id ?? null;
}

/**
 * @brief 测试取消之后改勾选再测（整体替换、一个模型，first-run.md 反例）：只勾手填的 fake-coder-notools（合成端点第 3 步
 *        不调工具），保存、测试通过，进入主窗口。
 */
async function nolistResave(ctx, providerId) {
  const { userData } = ctx;
  await addManual(ctx.page, 'fake-coder-notools');
  await pickRow(ctx.page, 'fake-slow', false);
  await pickRow(ctx.page, 'fake-coder', false);
  const since = Date.now();
  const done = await testConnection(ctx);
  const runs = await saveAndTest(ctx, since);
  const config = readConfig(userData);
  record('MD-11 after the cancelled test, changing the ticks and testing again replaces the provider and its models '
    + '(first-run.md counter-examples): one provider (same id), only the entered fake-coder-notools, normalDefault '
    + '<id>/fake-coder-notools; it is tested, says Connected and the main window opens',
  JSON.stringify(runs.map((run) => run.models ?? run.modelId)) === '[["fake-coder-notools"],"fake-coder-notools"]'
    && runs[0].providerId === providerId && config?.providers.length === 1 && config.providers[0].id === providerId
    && JSON.stringify(modelIds(config.providers[0])) === '["fake-coder-notools"]'
    && config.normalDefault === `${providerId}/fake-coder-notools` && Boolean(done?.handedOver)
    && CONNECTED.test(resultText(done) ?? ''), brief({ runs, config, result: resultText(done) }));
}

/**
 * @brief tool calling 判定失败（first-run.md "打开文件夹之后"，原来表单下方"Tool calling failed verification: …"的去处）：
 *        主窗口打开文件夹，新会话的范围是这个模型；探针还在跑时卡上"Verifying <id>/fake-coder-notools…"，判定失败后
 *        "This session can’t start: no model fits."，候选一行写原因，操作 Change model… 与 Open settings（没有 Verify now）。
 *        这次用侧栏的 Open folder…（first-run.md "进入主窗口"的可做的操作，2026-10-26 补的用例）：同提示里的那个按钮，
 *        新会话在选的文件夹里打开。
 */
async function nolistToolFailure(ctx, providerId) {
  const { page } = ctx;
  const ref = `${providerId}/fake-coder-notools`;
  const project = makeProject('nolist');
  const pick = await openFolderFromPrompt(ctx, project, 'sidebar');
  const opened = await activeProject(page);
  record('MD-11 main window after the first run: the sidebar’s Open folder… works like the prompt’s: the picked '
    + `folder opens as a new session in that project, range ${ref}`, samePath(opened, project) && pick === ref,
  brief({ opened, project, pick }));
  const card = (await poll(() => blockedCard(page), (value) => value?.kind === 'no_candidate', 90000, 300)).value;
  const seen = await watchedCards(page);
  const actions = await cardActions(page);
  record('MD-11 tool calling failed for the only ticked model (list error, entered fake-coder-notools): the session '
    + 'opened from the main window (range <id>/fake-coder-notools) first shows "Verifying <id>/fake-coder-notools…", '
    + 'then "This session can’t start: no model fits." with the candidate line "<id>/fake-coder-notools — tool calling '
    + 'failed verification" and Change model… and Open settings (no Verify now)', pick === ref
    && seen.some((item) => item.kind === 'verifying' && item.title === `Verifying ${ref}…`)
    && Boolean(card?.text.includes(TEXT.noFit)) && card.text.includes(`${ref} — tool calling failed verification`)
    && JSON.stringify(actions) === '["change-model","open-settings"]', brief({ pick, seen, card, actions }));
}

/** @brief 列表错误（nolist）下手填、测试中与已取消、改勾选再测、tool calling 判定失败的拒绝启动卡。 */
async function nolist() {
  const userData = tempDir('mori-mdfr-nolist-');
  let ctx;
  try {
    ctx = await openApp(userData);
    await nolistTags(ctx);
    await nolistError(ctx);
    await nolistManual(ctx);
    const providerId = await nolistCancelTest(ctx);
    await nolistResave(ctx, providerId);
    await nolistToolFailure(ctx, providerId);
  } catch (error) {
    record('MD-11 nolist: flow', false, brief(String(error?.stack ?? error), 600));
    await shot(ctx, 'nolist-error');
  } finally {
    await finish(ctx, 'nolist');
  }
}

// ---------- rejected：只拒绝列表的 401 下手填、保存失败、探针出错与拒绝启动卡上的 Verify now、完成首次启动 ----------

/** @brief 列表 401（key 在框里）：rejected 的两句；手填的行在错误下面。 */
async function rejectedFetch(ctx) {
  const { page } = ctx;
  gate.probeFail = true;
  await setBaseUrl(page, url(PORT.gate));
  await setKey(page, KEY.gate);
  const since = Date.now();
  const state = await fetchModels(ctx);
  const lists = gate.logs.filter((line) => line.t >= since && line.answered === 'gate' && line.method === 'GET');
  record('MD-11 list error (401 on the list only): "The server rejected the API key: <raw>" and "You can still add '
    + 'model IDs below."; the list request carried the typed key', state.listError?.kind === 'rejected'
    && state.listError.text[0] === `The server rejected the API key: ${GATE_BODY}`
    && state.listError.text[1] === TEXT.stillAdd && lists.length > 0 && lists.every((line) => line.key
    === tail(KEY.gate)), brief({ listError: state.listError, lists }));
  await addManual(page, 'fake-coder');
  const row = rowIn(await readForm(page), 'fake-coder');
  record('MD-08 first run with a 401 list error: the entered row is listed under the error, ticked, "Entered by you", '
    + '128000 / 16384 "Default"', row?.afterListError === true && row.picked && row.tags[0]?.kind === 'entered'
    && row.contextWindow === '128000' && row.maxTokens === '16384' && row.defaults.length === 2, brief(row));
}

/** @brief 保存失败（synthetic test setup：同名文件夹挡住 model-config.json 的写入）：原文、不开始测试、key 已删。 */
async function rejectedSaveFailure(ctx) {
  const { userData } = ctx;
  const blocker = join(userData, 'model-config.json');
  mkdirSync(join(blocker, 'blocker'), { recursive: true });
  const since = Date.now();
  try {
    const done = await testConnection(ctx);
    const sent = await saveAndTest(ctx, since);
    record('MD-11 save failed: "Couldn’t save: <raw>"; the test does not start (no connection.test, no request at the '
      + 'endpoint) and the form stays (no main window)', (resultText(done) ?? '').startsWith('Couldn’t save: ')
      && sent.length === 1 && sent[0].type === 'models.firstRun' && plainChats(endpoints.upstream, since).length === 0
      && done?.handedOver === false, brief({ result: resultText(done), sent }));
    record('MD-11 save failed: the key stored for this save is deleted again (credentials.json has no entry)',
      credentialRefs(userData).length === 0, brief(credentialRefs(userData)));
    record('MD-11 save failed: the API key box keeps the typed key (it is not cleared before a successful save)',
      done.apiKey.length === KEY.gate.length && done.apiKey.tail === tail(KEY.gate)
      && done.apiKey.placeholder === TEXT.optional, brief(done.apiKey.placeholder));
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
}

/**
 * @brief 再试一次：Connected、进入主窗口；探针第 1、3 步被列表门拒绝，这个模型的探针出错没有结果、tool calling 没有验证
 *        （经进程桥读档案；原来表单下方的"Couldn’t verify: …"与 Verify again 不再有）。返回测试的那个模型。
 */
async function rejectedRetry(ctx) {
  const { page, userData } = ctx;
  const since = Date.now();
  const done = await testConnection(ctx);
  const config = readConfig(userData);
  const ref = `${config?.providers?.[0]?.id ?? null}/fake-coder`;
  record('MD-11 retry after the failed save: Connected and the main window opens (the chat request passes the list '
    + 'gate with the saved key)', CONNECTED.test(resultText(done) ?? '') && Boolean(done?.handedOver)
    && config?.providers.length === 1 && plainChats(endpoints.upstream, since).some((chat) =>
    chat.key === tail(KEY.gate)), resultText(done));
  const saved = (config?.providers?.[0]?.models ?? []).map((model) => [model.id, model.contextWindow, model.maxTokens]);
  record('MD-08 first run with a 401 list error: the entered row is saved as the provider’s only model, 128000 / 16384',
    JSON.stringify(saved) === '[["fake-coder",128000,16384]]', brief(saved));
  const probe = await waitProbe(page, ref, { since, want: 'error', timeout: 90000 });
  const info = await page.evaluate(() => window.mori.request({ type: 'models.get' }));
  const error = info?.profiles?.[ref]?.error ?? null;
  record('MD-11 probe error after the hand-over: the list gate refuses probe steps 1 and 3, so the tested model’s '
    + 'probes end without a result (models.get: status error with the gate’s raw text)', probe === 'error'
    && Boolean(error?.includes(GATE_PROBE_MESSAGE)), brief({ probe, error }));
  return ref;
}

/**
 * @brief 探针出错之后（first-run.md "打开文件夹之后"）：主窗口打开文件夹，新会话按 no_candidate 拒绝启动，候选写
 *        "tool calling not verified yet"，卡上有 Verify now；列表门放行后点 Verify now，卡经"Verifying …"自动解除，
 *        会话用手填的模型收到回复（列表错误下完成首次启动）。
 *        这次用 Ctrl+N 打开文件夹（first-run.md "进入主窗口"的可做的操作：中栏没有会话时 Ctrl+N 等于 Open folder…，
 *        2026-10-26 补的用例）。
 */
async function rejectedVerifyNow(ctx, ref) {
  const { page } = ctx;
  const project = makeProject('rejected');
  const pick = await openFolderFromPrompt(ctx, project, 'ctrl+n');
  const opened = await activeProject(page);
  record('MD-11 main window after the first run: with no session in the centre Ctrl+N is Open folder…: the picked '
    + `folder opens as a new session in that project, range ${ref}`, samePath(opened, project) && pick === ref,
  brief({ opened, project, pick }));
  const blocked = (await poll(() => blockedCard(page), (value) => value?.kind === 'no_candidate', 90000, 300)).value;
  const actions = await cardActions(page);
  record(`MD-11 probe error: the new session (range ${ref}) is blocked with "This session can’t start: no model `
    + `fits.", the candidate line "${ref} — tool calling not verified yet", and Verify now, Change model… and Open `
    + 'settings', pick === ref && Boolean(blocked?.text.includes(TEXT.noFit))
    && blocked.text.includes(`${ref} — tool calling not verified yet`)
    && JSON.stringify(actions) === '["verify","change-model","open-settings"]', brief({ pick, blocked, actions }));
  gate.probeFail = false;
  const since = Date.now();
  await watchCards(page);
  await page.locator(`${CARD} [data-action="verify"]`).click();
  const cleared = await poll(() => blockedCard(page), (value) => value === null, 90000, 300);
  const seen = await watchedCards(page);
  const verifies = await sentCommands(ctx, ['models.verify'], since);
  record(`MD-11 Verify now sends models.verify; the card shows "Verifying ${ref}…" and clears by itself once tool `
    + 'calling is verified', cleared.ok && seen.some((item) => item.kind === 'verifying'
    && item.title === `Verifying ${ref}…`) && verifies.length === 1
    && chatLogs(endpoints.upstream, since).some((chat) => chat.probe), brief({ seen, verifies }));
  const at = Date.now();
  const reply = await sendText(page, 'plain md-11 first message');
  const chats = plainChats(endpoints.upstream, at);
  record('MD-11 list error (401): the first run completes with the entered model: the new session’s range is '
    + '<id>/fake-coder and it gets a reply', pick === ref && reply.count > 0 && !reply.error && chats.length > 0
    && chats.every((chat) => chat.model === 'fake-coder'), brief({ pick, reply, chats }));
}

/** @brief 只拒绝列表的 401。 */
async function rejected() {
  const userData = tempDir('mori-mdfr-rejected-');
  let ctx;
  try {
    ctx = await openApp(userData);
    await rejectedFetch(ctx);
    await rejectedSaveFailure(ctx);
    const ref = await rejectedRetry(ctx);
    await rejectedVerifyNow(ctx, ref);
  } catch (error) {
    record('MD-11 rejected: flow', false, brief(String(error?.stack ?? error), 600));
    await shot(ctx, 'rejected-error');
  } finally {
    await finish(ctx, 'rejected');
  }
}

// ---------- seeded：数据目录里已有会话时的首次启动（first-run.md "测试成功之后：主窗口"，2026-10-26 补的用例） ----------

/**
 * @brief 首次启动（other 端点：拿到列表，勾 fake-coder，测试成功）进入主窗口：侧栏里有数据目录里原有的会话，Open a folder
 *        提示的标题下面紧跟"Connected · …"（成功的颜色），说明换成"Pick a session on the left …"（v0 sessions.md
 *        "中栏没有会话"），还有 Open folder…。
 */
async function seededHandOver(ctx) {
  const { page } = ctx;
  await setBaseUrl(page, url(PORT.other));
  await setKey(page, KEY.one);
  await fetchModels(ctx);
  await pickRow(page, 'fake-coder', true);
  const done = await testConnection(ctx);
  const main = (await poll(() => readMain(page), (value) => value.prompt?.hint === TEXT.pickSession, 15000, 200)).value;
  const listed = await page.locator('.session-item').filter({ hasText: SEEDED.name }).count();
  record('MD-11 test passed with a saved session already in the data dir: the main window’s "Open a folder" prompt '
    + 'has the "Connected · …" line right under the heading (ok tone), the hint "Pick a session on the left to '
    + 'continue, or open a folder to start a new session." (the sidebar lists that session) and Open folder…',
  Boolean(done?.handedOver) && CONNECTED.test(main.prompt?.connected ?? '') && main.prompt.underHeading
    && main.prompt.tone && main.prompt.hint === TEXT.pickSession && main.prompt.open && listed === 1,
  brief({ result: resultText(done), main, listed }));
}

/**
 * @brief 点侧栏里原有的会话：它在中栏打开（对话流里是它的消息）；把它归档、中栏回到 Open a folder 提示后没有
 *        "Connected · …"一行（打开已有的会话也算"打开了会话"，只显示一次）。
 */
async function seededOpen(ctx) {
  const { page } = ctx;
  await page.locator('.session-item').filter({ hasText: SEEDED.name }).click();
  await page.locator(PANE).waitFor({ timeout: 30000 });
  await waitReady(page);
  const messages = await page.locator(`${PANE} [data-testid="user-message"]`).allInnerTexts();
  const replies = await page.locator(`${PANE} [data-testid="assistant"]`).allInnerTexts();
  record('MD-11 main window after the first run: clicking a session in the sidebar opens it in the centre (its '
    + 'message and reply are shown)', messages.some((text) => text.includes(SEEDED.question))
    && replies.some((text) => text.includes(SEEDED.answer)), brief({ messages, replies }));
  await chooseMenuItem(page, await activeFile(page), 'Archive');
  const main = (await poll(() => readMain(page), (value) => value.prompt !== null, 10000, 200)).value;
  record('MD-11 the "Connected · …" line is shown once, also when a saved session is opened from the sidebar: after '
    + 'that session is archived the centre is back at the "Open a folder" prompt, without the line',
  main.prompt?.heading === 'Open a folder' && main.prompt.connected === null && main.prompt.open
    && await page.locator('[data-testid="connected"]').count() === 0, brief(main));
}

/**
 * @brief 数据目录里已有一个会话文件（synthetic test setup，pi 的会话文件格式；没有 model-config.json，照样是首次启动）：
 *        测试成功进入主窗口时的说明、点侧栏的会话、打开已有的会话也清掉"Connected · …"。
 */
async function seeded() {
  const userData = tempDir('mori-mdfr-seeded-');
  // synthetic test setup：一问一答的 pi 会话文件（<userData>\pi\sessions\--<项目>--\），一小时前
  seedSession(userData, makeProject('seeded'), { name: SEEDED.name,
    items: chatItems([SEEDED.question, SEEDED.answer], Date.now() - 3600000) });
  let ctx;
  try {
    ctx = await openApp(userData);
    await seededHandOver(ctx);
    await seededOpen(ctx);
  } catch (error) {
    record('MD-11 seeded: flow', false, brief(String(error?.stack ?? error), 600));
    await shot(ctx, 'seeded-error');
  } finally {
    await finish(ctx, 'seeded');
  }
}

// ---------- 运行 ----------

/** 合成端点：端口与环境变量（synthetic） */
const ENDPOINTS = {
  // FAKE_FIRST_DELAY_MS 1500：每个对话请求先等 1.5 秒，探针（十几个请求，十几秒）在测试成功、进入主窗口、打开文件夹
  // 之后还在跑，新会话的拒绝启动卡看得到 Verifying（2026-10-26 起首次启动表单下方没有探针状态）
  listed: [PORT.listed, { FAKE_REQUIRE_KEY: KEY.one, FAKE_MODELS: LISTED.join(','), FAKE_FIRST_DELAY_MS: '1500' }],
  slow: [PORT.slow, { FAKE_LIST_DELAY_MS: '8000' }],
  other: [PORT.other, { FAKE_REQUIRE_KEY: KEY.one, FAKE_MODELS: LISTED.join(',') }],
  // 同 listed：打开文件夹时 fake-coder-notools 的探针还在跑，卡上先是 Verifying
  nolist: [PORT.nolist, { FAKE_LIST_SHAPE: 'nolist', FAKE_FIRST_DELAY_MS: '1500' }],
  upstream: [PORT.upstream, { FAKE_REQUIRE_KEY: KEY.gate, FAKE_FIRST_DELAY_MS: '400' }],
  // FAKE_MODELS 为 ","：逗号分隔后没有 id，列表为空
  empty: [PORT.empty, { FAKE_MODELS: ',' }],
  many: [PORT.many, { FAKE_MODELS: MANY.join(',') }],
  // typed 形状：第二行 type 为 embedding；第三个 id 含空格（§4.3 不能加入）
  typed: [PORT.typed, { FAKE_LIST_SHAPE: 'typed', FAKE_MODELS: 'fake-coder,embed-small,bad id' }],
  // ollama 形状：第二个模型没有 tools（no_tools），第三个只有训练窗口（trained_window）
  ollama: [PORT.ollama, { FAKE_LIST_SHAPE: 'ollama', FAKE_MODELS: 'llama-a,llama-b,llama-c' }],
  // 不查 key（key A、B 都能拉取，日志照样记末 4 位）；列表先等 1 秒，读得到拉取中的表单
  open: [PORT.open, { FAKE_MODELS: LISTED.join(','), FAKE_LIST_DELAY_MS: '1000' }],
};

const steps = { entry, listed, keys, changes, shapes, nolist, rejected, seeded };
try {
  for (const [name, [port, env]] of Object.entries(ENDPOINTS)) endpoints[name] = await startEndpoint(port, env);
  gate = await startListGate(PORT.gate, PORT.upstream);
  for (const [name, step] of Object.entries(steps)) {
    if (only && !only.includes(name)) continue;
    console.log(`[md-app-firstrun] step ${name}`);
    await step();
  }
} catch (error) {
  record('MD-11 md-app-firstrun: setup', false, brief(String(error?.stack ?? error), 600));
} finally {
  for (const endpoint of Object.values(endpoints)) await stopEndpoint(endpoint);
  if (gate) await stopListGate(gate);
}
const leaked = secretsIn(allLogs.join('\n'));
record('MD-11 no plaintext key in any app log collected by this run (stdout/stderr of every launch, page console)',
  leaked.length === 0 && allLogs.length > 0, `${allLogs.length} chunks; found ${leaked.length}`);
const hits = dataDirs.flatMap((dir) => filesUnder(dir)).filter((file) => secretsIn(readFileSync(file, 'latin1'))
  .length > 0);
record('MD-11 no plaintext key in any file of the data dirs and projects used by this run (the key is only kept '
  + 'encrypted, and the in-memory key is never written)', hits.length === 0 && dataDirs.length > 0, hits.join('; '));
record('MD-11 no plaintext key in this suite’s results', secretsIn(JSON.stringify(results)).length === 0);
console.log(`[md-app-firstrun] data dirs: ${dataDirs.join(' ')}`);
process.exitCode = write(`${RESULT}.json`) ? 0 : 1;
