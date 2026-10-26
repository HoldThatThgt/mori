// 一键拉取模型 App 层：设置 → Models 的 Add provider 表单。真正的 Mori（界面 + 后台进程 + 主进程）对合成端点
// （tests/fake-endpoint/server.mjs，synthetic，端口 4800–4819），逐条检查 docs/specs/model-discovery.md §13.2 这些条目的
// "通过条件"（状态表与标识见 docs/v1/screens/models-settings.md 的 Add provider、清单、列表错误、Add a model ID）：
//   MD-07 清单：默认勾选的三种情况（typed 的 embedding 行不勾、只有一个模型时勾上、多个类型不明时都不勾）；Select all 与
//         Clear selection 只作用于显示着的、能勾的行（过滤框开着时）；Default（只在值仍是默认值时）、Not a chat model、
//         Can’t add this model、两种提示；空列表的一句；改窗口时 Max output 随之变、错误时 Add 不可用；超过 20 行时的
//         过滤框（不分大小写，被藏起来的勾选行照样加入）；Add 的按钮文字随勾选数变；
//   MD-08 手填一行：拿到列表、列表错误（nolist、401）时都能手填加入，列表错误时手填的行列在错误下面；id 检查与重复；
//         Entered by you 与 Default；
//   MD-09 加入新提供商：开始只有 Base URL、API key、Fetch models；拉取中两个框只读、关闭表单会取消拉取；预填的 Name、
//         API type、Network zone 可改；FAKE_NO_V1_ROOT 换框并写说明、nolist 只换框；改 Base URL 或 key 清掉清单；再拉一次
//         不覆盖改过的 Name、API type、区域，改过的 API type 作为 target.api 发出；Add 一次写入全部勾选的模型（顺序同清单）、
//         全部开始探针；保存失败时本次新存的 key 被删除；More settings 的并发与兼容选项保存进配置；Fetch cancelled；
//         Adding… 时两个框只读、Fetch models 不可用；
//         界面细节（docs/v1/discovery-checks.md A16–A19）：改 Base URL 也清掉 Fetch cancelled，改 Base URL 或 key 清掉
//         拉取命令出错的原文（key 中间有空格）与上次保存失败的原文（A16）；过滤框、Add a model ID 里按 Enter 什么也不做
//         （A17）；清单表头为 §6.2 的列名、最高 440px 的滚动框与固定的表头、数字框为 inputMode numeric 的文字框、
//         不能加入的行只有勾选框不可用、Fetch models 不是主按钮（A18）；拉取中 fetch-status 为没有文字的 role=status（A19）；
//   MD-06 发现命令（App，新提供商）：新提供商的 key 只用于这次读取（合成端点日志的末 4 位），配置、档案、日志、Fetch 后
//         按 F8 保存的报告里都没有；每个请求 15 秒时限（FAKE_LIST_DELAY_MS 16000）；不按项目区域过滤。
// 准备（synthetic test setup）：数据目录里先写好 model-config.json 与 model-profiles.json（md-form-helpers.mjs 的
// seedUserData：一个已有的提供商 seed，allowedZones 为空），不经首次启动表单；之后全部经界面操作。发出的命令（target.api、
// models.discoverCancel、models.saveProvider）从预加载脚本的隔离环境里记下（md-form-helpers.mjs 的命令记录，key 只记末 4 位）。
// 用法（在 app/ 下，先构建）：node tests/ui/md-app-form.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/md-app-form(-packaged).json；--only 时写 md-partial-app-form(-packaged).json（不计入覆盖检查）。
// 出错时的截图在 test-results/md-app-form(-packaged)/。key 都是测试自己生成的合成值，与任何真实服务无关。
// 2026-10-26（WP-02，负责人走查 M1、M6）：清单的"Not reported"改为"Default"，只在值仍是默认值时标（改成别的值就不标、
// 改回又标）；trained_window 的提示改短；More settings 的兼容选项五个、上面一行说明。

import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder } from './lib.mjs';
import {
  FORM, SEED_ID, addManual, addingSeen, brief, chatLines, checklistLook, checklistScroll, closeApp, closeForm,
  commandsOf, configOf, credentialRefs, fetchNow, fetchWith, field, fillAddress, filesWithSecrets, formState,
  listLines, logLines, oneLine, openAddProvider, openMore, poll, readText, rowOf, saveIssueReport, secretsIn,
  seedUserData, setPicked, setSize, sleep, startApp, startEndpoint, stopEndpoints, typeManual, urlOf, watchAdding,
  watchConfig,
} from './md-form-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',').filter(Boolean) ?? null;
const packaged = exePath ? '-packaged' : '';
const RESULT = only ? `md-partial-app-form${packaged}.json` : `md-app-form${packaged}.json`;
const shots = join(appRoot, `test-results/md-app-form${packaged}`);
mkdirSync(shots, { recursive: true });
const { results, record, write } = createRecorder(exePath ?? 'dev build');

/** 测试用的合成 key（synthetic），末 4 位互不相同（合成端点的日志只记末 4 位） */
const KEY = {
  disc: 'synthetic-md-form-key-discover-D1S1',
  wrong: 'synthetic-md-form-key-wrong-W2R2',
  add: 'synthetic-md-form-key-add-A3D3',
  fail: 'synthetic-md-form-key-fail-F4L4',
  probe: 'synthetic-md-form-key-cleared-P5B5',
  // 中间有空格：不能写进请求头，models.discover 命令本身失败（拉取规格 §5.1；docs/v1/discovery-checks.md A16）
  header: 'synthetic-md-form-key with-space-H6S6',
};
const SECRETS = Object.values(KEY);
const tail = (key) => key.slice(-4);

/** 22 个 id（synthetic）：大小写混写的 alpha（测过滤不分大小写）、beta、gamma，最后一个含空格（不能加入） */
const MANY = ['alpha-01', 'alpha-02', 'Alpha-03', 'ALPHA-04', 'alpha-15',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `beta-0${n}`), ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `gamma-0${n}`),
  'bad id'];
/** 正好 20 个 id（synthetic）：再手填一个才超过 20 行 */
const TWENTY = Array.from({ length: 20 }, (_, i) => `twenty-${String(i + 1).padStart(2, '0')}`);

/** 合成端点（synthetic）：名字 → [端口, 环境变量]；各形状的字段与读取器应读出的值见 server.mjs 开头 */
const ENDPOINTS = {
  plain: [4800, { FAKE_MODELS: 'fake-coder,fake-slow' }],
  keyed: [4801, { FAKE_MODELS: 'fake-coder,fake-coder-b', FAKE_REQUIRE_KEY: KEY.disc }],
  typed: [4802, { FAKE_LIST_SHAPE: 'typed', FAKE_MODELS: 'chat-one,embed-two,chat-three' }],
  solo: [4803, { FAKE_MODELS: 'solo-model' }],
  many: [4804, { FAKE_MODELS: MANY.join(',') }],
  ollama: [4805, { FAKE_LIST_SHAPE: 'ollama', FAKE_MODELS: 'llama-a,llama-b,llama-c' }],
  rich: [4806, { FAKE_LIST_SHAPE: 'rich', FAKE_MODELS: 'rich-a,rich-b' }],
  empty: [4807, { FAKE_MODELS: '' }],
  nolist: [4808, { FAKE_LIST_SHAPE: 'nolist' }],
  nov1: [4809, { FAKE_NO_V1_ROOT: '1', FAKE_MODELS: 'v1-model' }],
  slow: [4810, { FAKE_LIST_DELAY_MS: '5000', FAKE_MODELS: 'slow-model' }],
  timeout: [4811, { FAKE_LIST_DELAY_MS: '16000' }],
  twenty: [4812, { FAKE_MODELS: TWENTY.join(',') }],
  add: [4813, { FAKE_MODELS: 'add-a,add-b', FAKE_REQUIRE_KEY: KEY.add }],
  fail: [4814, { FAKE_MODELS: 'fail-model', FAKE_REQUIRE_KEY: KEY.fail }],
};
/** 启动的合成端点：名字 → md-form-helpers.mjs startEndpoint 的结果 */
const eps = {};
const portOf = (name) => ENDPOINTS[name][0];
const urlFor = (name) => urlOf(portOf(name));
const hostFor = (name) => `127.0.0.1:${portOf(name)}`;
/** 后台进程记下的被取消的发现（slow 端点，A9） */
const CANCELLED_LOG = /discover 127\.0\.0\.1:4810 cancelled/;

/** 界面文字（docs/v1/screens/models-settings.md、docs/v0/ui-strings.md） */
const TEXT = {
  notChat: 'Not a chat model',
  spaces: 'Can’t add this model: the ID contains spaces',
  noTools: 'The server doesn’t list tool support for this model.',
  trained: 'Trained context window. Ollama may use a smaller one.',
  empty: 'The server didn’t list any models.',
  stillAdd: 'You can still add model IDs below.',
  noList: 'This server doesn’t list its models.',
  idBad: 'Model ID must be non-empty and contain no spaces.',
  idDup: 'Model IDs must be unique within a provider.',
  window: 'Context window must be a whole number above 0.',
  maxSmall: 'Max output must be smaller than the context window.',
  baseUrl: 'Base URL must be an http or https URL.',
  concurrency: 'Use a whole number from 1 to 64.',
  compat: 'Endpoint needs max_tokens instead of max_completion_tokens',
  cost: 'Each model is verified with up to 13 short requests.',
  header: 'API key contains characters that cannot be sent in a header',
  compatHint: 'Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if this '
    + 'server rejects requests.',
  defaultTitle: 'The server didn’t report this, so Mori used a default. Change it if you know the real value.',
};
/** 清单表的表头：§6.2 每行的各列（勾选框一列没有文字） */
const COLUMNS = ['', 'Model ID', 'Context window', 'Max output', 'Supports thinking', 'Image input'];

/** 这次运行的 Mori：{ userData, exePath, logs, pageErrors, app, page, cdp, world, spy } */
const ctx = { userData: seedUserData(), exePath, logs: [], pageErrors: [] };

// ---------- 小工具 ----------

/** @brief 表单状态里的行（按 id）。 */
const rowIn = (state, id) => state?.rows.find((row) => row.id === id) ?? null;
/** @brief 表单状态里的行 id 与勾选，例如 "a+ b-"。 */
const picks = (state) => (state?.rows ?? []).map((row) => `${row.id}${row.picked ? '+' : '-'}`).join(' ');
/** @brief 表单里没有拉取后的字段（回到开始）：没有 Name、API type、区域、清单、列表错误、Add a model ID、底部。 */
const atStart = (state) => Boolean(state) && state.name === null && state.api === null && state.zoneCount === 0
  && !state.checklist && state.listError === null && state.manual === null && state.more === null
  && state.add === null && state.cost === null && state.detected === null && state.rows.length === 0;
/** @brief 配置里的一个提供商。 */
const providerIn = (id) => configOf(ctx.userData)?.providers?.find((item) => item.id === id) ?? null;
/** @brief 设置页里提供商卡的顺序（data-provider）。 */
const cardOrder = () => ctx.page.locator('[data-testid="provider-card"]')
  .evaluateAll((cards) => cards.map((card) => card.dataset.provider));
/** @brief 一张卡里模型行的顺序（data-model）。 */
const rowOrder = (provider) => ctx.page.locator(`[data-testid="provider-card"][data-provider="${provider}"] `
  + '[data-testid="model-row"]').evaluateAll((rows) => rows.map((row) => row.dataset.model));
/** @brief 点 Add，等表单关上；返回是否关上了。 */
async function clickAdd(timeout = 20000) {
  await ctx.page.locator(`${FORM} [data-action="add-models"]`).click();
  return ctx.page.locator(FORM).waitFor({ state: 'detached', timeout }).then(() => true, () => false);
}
/** @brief 表单的 Name 改成 name。 */
const setName = (name) => field(ctx.page, 'Name').fill(name);
/** @brief 出错时截图（不影响结果）。 */
const shot = (name) => ctx.page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

// ---------- MD-09：开始 ----------

/** @brief 开始只有 Base URL、API key、Fetch models 与 Cancel；Base URL 不合格时 Fetch models 不可用。 */
async function startState() {
  const { page } = ctx;
  await openAddProvider(page);
  const s0 = await formState(page);
  record('MD-09 start: the Add provider form shows only Base URL, API key (password box, placeholder "Optional"), '
    + 'Fetch models (below the API key) and Cancel; no Name, API type, Network zone, checklist, More settings or Add',
  s0?.title === 'Add provider' && JSON.stringify(s0.labels) === '["Base URL","API key"]' && atStart(s0)
    && s0.baseUrl?.placeholder === 'http://host:8000/v1' && s0.baseUrl.value === ''
    && s0.apiKey?.type === 'password' && s0.apiKey.placeholder === 'Optional' && s0.fetch?.text === 'Fetch models'
    && s0.order.fetchAfterKey && s0.close?.text === 'Cancel' && s0.fetchCancel === null && s0.status === null,
  brief(s0));
  await field(page, 'Base URL').fill('ftp://127.0.0.1/v1');
  const bad = await formState(page);
  await field(page, 'Base URL').fill(urlFor('plain'));
  const good = await formState(page);
  record('MD-09 start: Fetch models is unavailable while the Base URL is empty or not http/https ("Base URL must be '
    + 'an http or https URL."), available for an http URL', s0?.fetch?.disabled === true && bad.fetch.disabled
    && bad.fieldErrors.baseUrl === TEXT.baseUrl && !good.fetch.disabled && good.fieldErrors.baseUrl === undefined,
  `empty ${s0?.fetch?.disabled}; ftp ${bad.fetch.disabled} ${bad.fieldErrors.baseUrl}; http ${good.fetch.disabled}`);
  await closeForm(page);
}

// ---------- MD-09：拉取中、取消、关闭表单 ----------

/** @brief 点 Fetch models（不等结果），等表单进入拉取中。 */
async function startFetch() {
  await ctx.page.locator(`${FORM} [data-action="fetch-models"]`).click();
  // 拉取中 fetch-status 是没有文字的 role=status（A19），不可见，只等它出现在文档里
  await ctx.page.locator(`${FORM} [data-testid="fetch-status"][data-state="fetching"]`)
    .waitFor({ state: 'attached', timeout: 5000 });
}

/** @brief 拉取中两个框只读、按钮变成 Fetching models…、旁边 Cancel；Cancel 后回到开始并显示 Fetch cancelled。 */
async function fetchingState() {
  const { page } = ctx;
  await openAddProvider(page);
  await fillAddress(page, urlFor('slow'), KEY.probe);
  const since = Date.now();
  await startFetch();
  const s = await formState(page);
  await field(page, 'Base URL').focus();
  await page.keyboard.type('x');
  const typed = (await formState(page)).baseUrl.value;
  record('MD-09 fetching: Fetch models reads "Fetching models…" and is unavailable, a Cancel appears beside it, '
    + 'Base URL and API key are readonly (typing changes nothing) and the form\'s own Cancel stays available',
  s.fetch?.text === 'Fetching models…' && s.fetch.disabled && s.fetchCancel?.text === 'Cancel'
    && s.status?.state === 'fetching' && s.baseUrl.readOnly && s.apiKey.readOnly && typed === urlFor('slow')
    && s.close?.disabled === false, brief({ fetch: s.fetch, cancel: s.fetchCancel, status: s.status,
    base: s.baseUrl, key: s.apiKey.readOnly, typed, close: s.close }));
  record('MD-09 fetching: fetch-status is an empty role="status" element with data-state "fetching" (the button '
    + 'already reads "Fetching models…")', s.status?.state === 'fetching' && s.status.role === 'status'
    && s.status.text === '', brief(s.status));
  await page.locator(`${FORM} [data-action="fetch-cancel"]`).click();
  const back = await poll(() => formState(page), (st) => st?.status?.state === 'cancelled', 10000);
  const sent = await commandsOf(ctx, null, since);
  const discover = sent.find((entry) => entry.command.type === 'models.discover');
  const cancelled = await poll(async () => logLines(ctx, CANCELLED_LOG, since), (l) => l.length, 5000);
  record('MD-09 Cancel while fetching sends models.discoverCancel; the fetch returns cancelled and the form goes back '
    + 'to the start with "Fetch cancelled" beside Fetch models', back.ok && back.value.status.text === 'Fetch cancelled'
    && atStart(back.value) && !back.value.fetch.disabled && sent.some((e) => e.command.type === 'models.discoverCancel')
    && discover?.result?.cancelled === true && cancelled.ok,
  brief({ status: back.value?.status, sent: sent.map((e) => e.command.type), result: discover?.result,
    log: cancelled.value }));
  await sleep(1500);
  const stayed = await formState(page);
  await field(page, 'API key').fill('');
  const cleared = await formState(page);
  record('MD-09 "Fetch cancelled" stays until the Base URL or API key changes: still shown 1.5 s after the cancel, '
    + 'editing the API key removes it', stayed.status?.state === 'cancelled' && stayed.status.text === 'Fetch cancelled'
    && cleared.status === null && atStart(cleared), brief({ stayed: stayed.status, cleared: cleared.status }));
  await closeWhileFetching(since);
}

/** @brief 拉取中点表单的 Cancel：表单关上，先发 models.discoverCancel，这次拉取被取消。 */
async function closeWhileFetching(since) {
  const { page } = ctx;
  const mark = Date.now();
  await startFetch();
  await page.locator(`${FORM} [data-action="close-form"]`).click();
  const gone = await page.locator(FORM).waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
  const done = await poll(() => commandsOf(ctx, null, mark), (list) => list.find((e) => e.command.type
    === 'models.discover')?.done, 10000);
  const types = done.value.map((entry) => entry.command.type);
  const discover = done.value.find((entry) => entry.command.type === 'models.discover');
  const logs = await poll(async () => logLines(ctx, CANCELLED_LOG, since), (l) => l.length >= 2, 5000);
  record('MD-09 closing the form while fetching cancels the fetch: the form closes, models.discoverCancel is sent '
    + 'after models.discover, the discover returns cancelled and the kernel logs the cancelled read', gone
    && types.indexOf('models.discoverCancel') > types.indexOf('models.discover') && discover?.result?.cancelled === true
    && logs.ok, brief({ gone, types, result: discover?.result, logs: logs.value }));
  record('MD-09 both cancelled fetches had reached the endpoint (two list requests on the slow endpoint)',
    listLines(eps.slow, since).length === 2, brief(listLines(eps.slow, since)));
  await leaveWhileFetching();
}

/**
 * @brief 表单关闭的另外两种（§6.1：打开别的表单、离开设置页）：拉取中点已有提供商卡上的 Edit，或点 Back to app，
 *        同样先发 models.discoverCancel，这次拉取被取消。
 */
async function leaveWhileFetching() {
  const { page } = ctx;
  const ways = {
    'opening another form (Edit on the seed card)': async () => {
      await page.locator(`[data-testid="provider-card"][data-provider="${SEED_ID}"] [data-action="edit-provider"]`)
        .click();
      await page.locator(FORM).filter({ hasText: 'Edit provider' }).waitFor({ timeout: 5000 });
    },
    'leaving the settings page (Back to app)': async () => {
      await page.getByRole('button', { name: 'Back to app', exact: true }).click();
      await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 5000 });
    },
  };
  for (const [label, leave] of Object.entries(ways)) {
    await openAddProvider(page);
    await fillAddress(page, urlFor('slow'), '');
    const mark = Date.now();
    await startFetch();
    await leave();
    const done = await poll(() => commandsOf(ctx, null, mark), (list) => list.find((e) => e.command.type
      === 'models.discover')?.done, 10000);
    const types = done.value.map((entry) => entry.command.type);
    const result = done.value.find((entry) => entry.command.type === 'models.discover')?.result;
    record(`MD-09 ${label} while fetching sends models.discoverCancel and the fetch returns cancelled`,
      types.indexOf('models.discoverCancel') > types.indexOf('models.discover') && result?.cancelled === true,
      brief({ types, result }));
    const edit = page.locator(FORM).filter({ hasText: 'Edit provider' });
    if (await edit.count()) await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
}

// ---------- MD-07：默认勾选与 Add 的文字 ----------

/** @brief typed：embedding 行不勾、聊天行勾上；只有一个模型时勾上；多个类型不明时都不勾；Add 的文字 0 / 1 / N。 */
async function defaultPicks() {
  const { page } = ctx;
  await openAddProvider(page);
  const typed = (await fetchWith(ctx, urlFor('typed'), '')).state;
  const embed = rowIn(typed, 'embed-two');
  record('MD-07 default picks (typed shape): the embedding row is unticked with "Not a chat model"; the chat rows are '
    + 'ticked; Add reads "Add 2 models"', picks(typed) === 'chat-one+ embed-two- chat-three+'
    && embed?.chat === 'false' && embed.tags.some((t) => t.kind === 'not-chat' && t.text === TEXT.notChat)
    && rowIn(typed, 'chat-one')?.chat === 'true' && typed.add?.text === 'Add 2 models' && !typed.add.disabled,
  brief({ picks: picks(typed), embed, add: typed.add }));
  await setPicked(page, 'embed-two', true);
  const forced = await formState(page);
  record('MD-07 a "Not a chat model" row can still be ticked by hand', rowIn(forced, 'embed-two')?.picked === true
    && forced.add.text === 'Add 3 models', brief({ picks: picks(forced), add: forced.add }));
  await unreportedWindow(typed);
  const solo = (await fetchWith(ctx, urlFor('solo'))).state;
  record('MD-07 default picks: a list with a single model (type not reported) has it ticked; Add reads "Add 1 model"',
    picks(solo) === 'solo-model+' && rowIn(solo, 'solo-model')?.chat === 'unknown' && solo.add?.text === 'Add 1 model',
    brief({ picks: picks(solo), add: solo.add }));
  const plain = (await fetchWith(ctx, urlFor('plain'))).state;
  record('MD-07 default picks: several models without a reported type are all unticked; Add reads "Add models" and is '
    + 'unavailable', picks(plain) === 'fake-coder- fake-slow-' && plain.rows.every((row) => row.chat === 'unknown')
    && plain.add?.text === 'Add models' && plain.add.disabled, brief({ picks: picks(plain), add: plain.add }));
  await setPicked(page, 'fake-coder', true);
  const one = await formState(page);
  await setPicked(page, 'fake-slow', true);
  const two = await formState(page);
  record('MD-07 the Add button follows the ticked count: "Add 1 model" with one, "Add 2 models" with two',
    one.add.text === 'Add 1 model' && !one.add.disabled && two.add.text === 'Add 2 models' && !two.add.disabled,
    `${one.add.text} / ${two.add.text}`);
  await refetchFromScratch();
}

/**
 * @brief typed 形状的行没有窗口（server.mjs 开头）：服务列出的行 Context window 与 Max output 都是默认值、都标 Default
 *        （带悬停说明）；窗口改成 20000 后它不再是默认值、不标，Max output 随窗口变成 10000、仍是默认值、照标
 *        （2026-10-26，负责人走查 M6）。
 * @param typed 拉取 typed 端点后的表单状态
 */
async function unreportedWindow(typed) {
  const one = rowIn(typed, 'chat-one');
  await setSize(ctx.page, 'chat-one', 'contextWindow', 20000);
  const edited = rowIn(await formState(ctx.page), 'chat-one');
  record('MD-07 Default on a listed row without a reported window: 128000 / 16384 both "Default" with the hover '
    + 'explanation; after the window is edited to 20000 only the Max output, which follows it (10000), is still '
    + '"Default"', one?.window === '128000' && one.max === '16384'
    && JSON.stringify(one.defaults) === '["contextWindow:Default","maxTokens:Default"]'
    && one.defaultTitles.every((title) => title === TEXT.defaultTitle) && edited?.window === '20000'
    && edited.max === '10000' && JSON.stringify(edited.defaults) === '["maxTokens:Default"]', brief({ one, edited }));
}

/** @brief 再点 Fetch models：清单、勾选和手填的行都从头来（MD-09）。 */
async function refetchFromScratch() {
  const { page } = ctx;
  await addManual(page, 'typed-by-hand');
  const before = await formState(page);
  const again = (await fetchNow(ctx)).state;
  record('MD-09 Fetch models again starts over: ticks and the hand-entered row are dropped, the default picks come '
    + 'back', picks(before) === 'fake-coder+ fake-slow+ typed-by-hand+' && picks(again) === 'fake-coder- fake-slow-',
  `${picks(before)} -> ${picks(again)}`);
  await closeForm(page);
}

// ---------- MD-07：标记、提示、改值 ----------

/** @brief Default（改成别的值就不标、改回又标）、改窗口时 Max output 随之变、字段错误时 Add 不可用。 */
async function markersAndEdits() {
  const { page } = ctx;
  await openAddProvider(page);
  const s = (await fetchWith(ctx, urlFor('plain'), '')).state;
  const coder = rowIn(s, 'fake-coder');
  record('MD-07 Default: a listed window (vLLM max_model_len) has no marker; the unreported Max output shows '
    + '"Default" with the default 16384', coder?.window === '131072' && coder.max === '16384'
    && JSON.stringify(coder.defaults) === '["maxTokens:Default"]', brief(coder));
  await setSize(page, 'fake-coder', 'maxTokens', 4096);
  await setSize(page, 'fake-coder', 'contextWindow', 100000);
  const edited = rowIn(await formState(page), 'fake-coder');
  await setSize(page, 'fake-coder', 'maxTokens', 16384);
  const back = rowIn(await formState(page), 'fake-coder');
  record('MD-07 "Default" goes away when you edit the value (4096) and an edited Max output no longer follows the '
    + 'window (100000); typing the default 16384 back shows "Default" again (2026-10-26)', edited?.max === '4096'
    && edited.window === '100000' && JSON.stringify(edited.defaults) === '[]' && back?.max === '16384'
    && JSON.stringify(back.defaults) === '["maxTokens:Default"]', brief({ edited, back }));
  await setPicked(page, 'fake-coder', true);
  await setPicked(page, 'fake-slow', true);
  await setSize(page, 'fake-slow', 'contextWindow', 'abc');
  const badWindow = await formState(page);
  await setSize(page, 'fake-slow', 'contextWindow', 8000);
  const follow = await formState(page);
  record('MD-07 a ticked row with a field error makes Add unavailable ("Context window must be a whole number above '
    + '0."); a valid window makes the untouched Max output follow it (min(16384, window/2) = 4000, "Default")',
  rowIn(badWindow, 'fake-slow')?.errors.contextWindow === TEXT.window && badWindow.add.disabled
    && rowIn(follow, 'fake-slow')?.max === '4000' && rowIn(follow, 'fake-slow').defaults.includes(
      'maxTokens:Default') && !follow.add.disabled && follow.add.text === 'Add 2 models',
  brief({ bad: rowIn(badWindow, 'fake-slow'), add: badWindow.add, follow: rowIn(follow, 'fake-slow') }));
  await setSize(page, 'fake-slow', 'maxTokens', 9000);
  const tooBig = await formState(page);
  await setPicked(page, 'fake-slow', false);
  const unticked = await formState(page);
  record('MD-07 Max output not below the window shows "Max output must be smaller than the context window." and blocks '
    + 'Add while the row is ticked; unticking the row makes Add available again', rowIn(tooBig, 'fake-slow')?.errors
    .maxTokens === TEXT.maxSmall && tooBig.add.disabled && !unticked.add.disabled
    && unticked.add.text === 'Add 1 model',
  brief({ error: rowIn(tooBig, 'fake-slow')?.errors, add: tooBig.add, after: unticked.add }));
  await richFollow();
}

/** @brief rich：报告的窗口与输出上限没有 Default；改小窗口时 Max output 退回默认值并标 Default。 */
async function richFollow() {
  const { page } = ctx;
  const s = (await fetchWith(ctx, urlFor('rich'))).state;
  const a = rowIn(s, 'rich-a');
  const b = rowIn(s, 'rich-b');
  record('MD-07 reported values (rich shape): window 131072 and Max output 8192 have no "Default"; thinking and '
    + 'image follow the server (rich-a ticked both, rich-b neither)', a?.window === '131072' && a.max === '8192'
    && a.defaults.length === 0 && a.reasoning && a.image && b?.defaults.length === 0 && !b.reasoning && !b.image,
  brief({ a, b }));
  await setSize(page, 'rich-a', 'contextWindow', 8000);
  const small = rowIn(await formState(page), 'rich-a');
  await setSize(page, 'rich-a', 'contextWindow', 100000);
  const large = rowIn(await formState(page), 'rich-a');
  record('MD-07 Max output follows an edited window: below the reported 8192 it falls back to the default (4000) and '
    + 'shows "Default"; above it the reported 8192 comes back without the marker', small?.max === '4000'
    && JSON.stringify(small.defaults) === '["maxTokens:Default"]' && large?.max === '8192'
    && large.defaults.length === 0, brief({ small, large }));
  await hintsAndUnusable();
}

/** @brief 两种提示（ollama 形状）、Can’t add this model（id 含空格）、空列表的一句。 */
async function hintsAndUnusable() {
  const { page } = ctx;
  const o = (await fetchWith(ctx, urlFor('ollama'))).state;
  const [a, b, c] = ['llama-a', 'llama-b', 'llama-c'].map((id) => rowIn(o, id));
  record('MD-07 hints (ollama shape): llama-b shows "The server doesn’t list tool support for this model."; llama-c '
    + 'shows "Trained context window. Ollama may use a smaller one."; llama-a '
    + 'has none', a?.hints.length === 0 && a.window === '8192' && JSON.stringify(b?.hints) === JSON.stringify(
    [{ kind: 'no_tools', text: TEXT.noTools }]) && b.window === '16384' && JSON.stringify(c?.hints)
    === JSON.stringify([{ kind: 'trained_window', text: TEXT.trained }]) && c.window === '131072', brief({ a, b, c }));
  const m = (await fetchWith(ctx, urlFor('many'))).state;
  const bad = rowIn(m, 'bad id');
  record('MD-07 Can’t add this model: an id with a space is listed, unticked, its pick box unavailable, tagged "Can’t '
    + 'add this model: the ID contains spaces"', bad?.unusable === true && !bad.picked && bad.pickDisabled
    && bad.tags.some((t) => t.kind === 'unusable' && t.text === TEXT.spaces) && bad.pickLabel === 'Add bad id',
  brief(bad));
  const e = (await fetchWith(ctx, urlFor('empty'))).state;
  await addManual(page, 'typed-in');
  const after = await formState(page);
  record('MD-07 an empty list shows "Models (0)" and "The server didn’t list any models.", then Add a model ID; a '
    + 'hand-entered row goes below the sentence, which stays', e.heading === 'Models (0)' && e.empty === TEXT.empty
    && e.rows.length === 0 && e.listError === null && e.manual !== null && after.empty === TEXT.empty
    && after.order.emptyThenRow && after.order.rowThenManual && picks(after) === 'typed-in+',
  brief({ heading: e.heading, empty: e.empty, after: picks(after), order: after.order }));
  await closeForm(page);
}

// ---------- MD-07：过滤框 ----------

/** @brief 超过 20 行时的过滤框；Select all / Clear selection 只作用于显示着的、能勾的行；藏起来的勾选行照样加入。 */
async function filterBox() {
  const { page } = ctx;
  await openAddProvider(page);
  const s = (await fetchWith(ctx, urlFor('many'), '')).state;
  const filter = page.locator(`${FORM} [data-testid="checklist-filter"]`);
  record('MD-07 more than 20 rows: a filter box (placeholder "Filter models") under "Models (22)"; nothing is ticked',
    s.heading === 'Models (22)' && s.filter?.placeholder === 'Filter models' && s.rows.length === 22
    && s.rows.every((row) => !row.picked), brief({ heading: s.heading, filter: s.filter, rows: s.rows.length }));
  await filter.fill('ALPHA');
  const alpha = await formState(page);
  await page.locator(`${FORM} [data-action="select-all"]`).click();
  const selected = await formState(page);
  await filter.fill('');
  const all = await formState(page);
  const alphaIds = ['alpha-01', 'alpha-02', 'Alpha-03', 'ALPHA-04', 'alpha-15'];
  const ticked = all.rows.filter((row) => row.picked).map((row) => row.id);
  record('MD-07 the filter matches id substrings ignoring case ("ALPHA" shows the 5 alpha rows); Select all ticks '
    + 'only the shown rows, hidden rows stay unticked', JSON.stringify(alpha.rows.map((r) => r.id))
    === JSON.stringify(alphaIds) && selected.rows.every((row) => row.picked) && JSON.stringify(ticked)
    === JSON.stringify(alphaIds) && all.add.text === 'Add 5 models', brief({ shown: alpha.rows.map((r) => r.id),
    ticked, add: all.add }));
  await filter.fill('bad');
  await page.locator(`${FORM} [data-action="select-all"]`).click();
  const bad = await formState(page);
  record('MD-07 Select all skips rows that can’t be ticked (the unusable "bad id" stays unticked)',
    picks(bad) === 'bad id-' && bad.add.text === 'Add 5 models', `${picks(bad)} ${bad.add.text}`);
  await filter.fill('alpha-0');
  await page.locator(`${FORM} [data-action="clear-selection"]`).click();
  await filter.fill('');
  const rest = await formState(page);
  record('MD-07 Clear selection unticks only the shown rows: after filtering "alpha-0" only alpha-15 stays ticked',
    JSON.stringify(rest.rows.filter((r) => r.picked).map((r) => r.id)) === '["alpha-15"]'
    && rest.add.text === 'Add 1 model', `${picks(rest)} ${rest.add.text}`);
  await hiddenAdded(filter);
}

/** @brief 藏起来的勾选行照样算进 Add 的 N、照样加入（顺序同清单）。 */
async function hiddenAdded(filter) {
  const { page } = ctx;
  await setPicked(page, 'beta-02', true);
  await setPicked(page, 'gamma-07', true);
  await filter.fill('GAMMA');
  const s = await formState(page);
  await setName('Filter Add');
  const closed = await clickAdd();
  const provider = await poll(() => providerIn('filter-add'), Boolean, 10000);
  record('MD-07 hidden ticked rows still count and are added: with "GAMMA" shown, Add reads "Add 3 models" and the new '
    + 'provider has alpha-15, beta-02, gamma-07 in checklist order', s.add.text === 'Add 3 models' && closed
    && JSON.stringify(provider.value?.models.map((m) => m.id)) === '["alpha-15","beta-02","gamma-07"]',
  brief({ shown: s.rows.map((r) => r.id), add: s.add, models: provider.value?.models.map((m) => m.id) }));
  await openAddProvider(page);
  const t = (await fetchWith(ctx, urlFor('twenty'), '')).state;
  await addManual(page, 'twenty-one');
  const more = await formState(page);
  const box = page.locator(`${FORM} [data-testid="checklist-filter"]`);
  await box.fill('TWENTY-1');
  const found = await formState(page);
  await box.fill('Y-ONE');
  const entered = await formState(page);
  record('MD-07 hand-entered rows count toward "more than 20": 20 listed rows have no filter box, one entered row adds '
    + 'it; the filter covers entered rows too ("TWENTY-1" hides twenty-one, "Y-ONE" shows only it)',
  t.rows.length === 20 && t.filter === null && more.filter !== null && more.rows.length === 21
    && JSON.stringify(found.rows.map((r) => r.id)) === JSON.stringify(['twenty-10', 'twenty-11', 'twenty-12',
      'twenty-13', 'twenty-14', 'twenty-15', 'twenty-16', 'twenty-17', 'twenty-18', 'twenty-19'])
    && JSON.stringify(entered.rows.map((r) => r.id)) === '["twenty-one"]',
  brief({ before: t.filter, after: more.filter, found: found.rows.map((r) => r.id),
    entered: entered.rows.map((r) => r.id) }));
  await closeForm(page);
}

// ---------- MD-07、MD-09：清单的样子（A18）、Enter（A17） ----------

/**
 * @brief 清单的样子（docs/v1/discovery-checks.md A18）：Fetch models 不是主按钮（开始时表单里没有主按钮，拉取后
 *        只有 Add）；表头为 §6.2 的列名、每行一列一格；数字框是 inputMode numeric 的文字框；22 行在最高 440px 的
 *        滚动框里，滚到底表头仍在框的上沿。
 */
async function checklistLookAndButtons() {
  const { page } = ctx;
  await openAddProvider(page);
  const start = await checklistLook(page);
  await fetchWith(ctx, urlFor('many'), '');
  const look = await checklistLook(page);
  const plain = (cls) => typeof cls === 'string' && cls.split(/\s+/).includes('button') && !cls.includes('primary');
  record('MD-09 Add provider\'s Fetch models is not the primary button: at the start the form has no primary button; '
    + 'after the fetch the only primary button is Add', plain(start?.buttons.fetch)
    && start.buttons.primary.length === 0 && plain(look?.buttons.fetch)
    && JSON.stringify(look.buttons.primary) === '["add-models"]',
  brief({ start: start?.buttons, after: look?.buttons }));
  record('MD-07 the checklist is a table whose headers are the §6.2 column names (pick box, Model ID, Context window, '
    + 'Max output, Supports thinking, Image input), with one cell per column on every row',
  JSON.stringify(look?.headers) === JSON.stringify(COLUMNS) && look.rows.length === 22
    && look.rows.every((row) => row.cells === COLUMNS.length), brief({ headers: look?.headers,
    cells: [...new Set(look?.rows.map((row) => row.cells))], rows: look?.rows.length }));
  const numeric = (box) => box?.type === 'text' && box.mode === 'numeric';
  record('MD-07 the Context window and Max output boxes are text inputs with inputMode "numeric" on every row',
    look?.rows.length === 22 && look.rows.every((row) => numeric(row.boxes.contextWindow)
      && numeric(row.boxes.maxTokens)), brief(look?.rows.slice(0, 2).map((row) => row.boxes)));
  const scroll = await checklistScroll(page);
  const box = scroll?.box;
  record('MD-07 the 22 rows scroll inside a box of at most 440px (max-height 440px, overflow auto) and the sticky '
    + 'header stays at the top of the box when it is scrolled to the bottom', box?.maxHeight === '440px'
    && ['auto', 'scroll'].includes(box.overflowY) && box.clientHeight <= 440 && box.scrollHeight > box.clientHeight
    && scroll.header.position === 'sticky' && box.scrolled > 0 && Math.abs(box.offset) <= 1, brief(scroll));
  await unusableRowEditable(look);
}

/**
 * @brief 不能加入的行（id 含空格）只有勾选框不可用（A18）：两个数字框、两个勾选框可用，也真的能改；这一行仍不勾、
 *        勾选框仍不可用。
 * @param look 拉取 many 端点后的 checklistLook
 */
async function unusableRowEditable(look) {
  const { page } = ctx;
  const bad = look?.rows.find((row) => row.id === 'bad id');
  const others = ['contextWindow', 'maxTokens', 'reasoning', 'image'];
  const row = rowOf(page, 'bad id');
  let blocked = null;
  try {
    await row.locator('input[data-field="contextWindow"]').fill('5000', { timeout: 3000 });
    await row.locator('input[data-field="maxTokens"]').fill('1000', { timeout: 3000 });
    await row.locator('input[data-field="reasoning"]').setChecked(true, { timeout: 3000 });
    await row.locator('input[data-field="image"]').setChecked(true, { timeout: 3000 });
  } catch (error) {
    blocked = oneLine(error?.message ?? error, 300);
  }
  const after = rowIn(await formState(page), 'bad id');
  record('MD-07 a "Can’t add this model" row has only its pick box unavailable: Context window, Max output, Supports '
    + 'thinking and Image input stay enabled and can be changed (5000 / 1000, both ticked); the row stays unticked',
  bad?.boxes.pick.disabled === true && others.every((name) => bad.boxes[name].disabled === false) && blocked === null
    && after?.window === '5000' && after.max === '1000' && after.reasoning && after.image && !after.picked
    && after.pickDisabled, brief({ boxes: bad?.boxes, blocked, after }));
  await enterDoesNothing();
}

/**
 * @brief 在过滤框与 Add a model ID 的输入框里按 Enter 什么也不做（A17）：Add N models 可用时也不发
 *        models.saveProvider、表单不关、配置里没有新的提供商；Add a model ID 里的 id 留在框里，不加进清单。
 */
async function enterDoesNothing() {
  const { page } = ctx;
  await setPicked(page, 'alpha-01', true);
  await setPicked(page, 'beta-01', true);
  await setName('Enter Check');
  const count = configOf(ctx.userData)?.providers?.length;
  const unchanged = () => configOf(ctx.userData)?.providers?.length === count;
  const filter = page.locator(`${FORM} [data-testid="checklist-filter"]`);
  const since = Date.now();
  await filter.fill('alpha');
  await filter.press('Enter');
  await sleep(1000);
  const one = await formState(page);
  const saves = await commandsOf(ctx, 'models.saveProvider', since);
  record('MD-07 Enter in the filter box does nothing: with "Add 2 models" available no models.saveProvider is sent, '
    + 'the form stays open with the filter text, and no provider is added', ctx.spy && saves.length === 0
    && one?.filter?.value === 'alpha' && one.add?.text === 'Add 2 models' && !one.add.disabled && unchanged(),
  brief({ saves: saves.length, filter: one?.filter, add: one?.add }));
  await filter.fill('');
  const mark = Date.now();
  const box = page.locator(`${FORM} [data-testid="manual-model"] input[data-field="id"]`);
  await box.fill('enter-id');
  await box.press('Enter');
  await sleep(1000);
  const two = await formState(page);
  const afterEnter = await commandsOf(ctx, 'models.saveProvider', mark);
  record('MD-08 Enter in the Add a model ID box does nothing: no models.saveProvider, the form stays open, the id '
    + 'stays in the box and is not added to the list ("Add 2 models" and Add to list available)', ctx.spy
    && afterEnter.length === 0 && two?.manual?.value === 'enter-id' && !two.manual.add.disabled
    && rowIn(two, 'enter-id') === null && two.rows.length === 22 && two.add?.text === 'Add 2 models'
    && !two.add.disabled && unchanged(), brief({ saves: afterEnter.length, manual: two?.manual, add: two?.add }));
  await closeForm(page);
}

// ---------- MD-08：手填一行 ----------

/** @brief 拿到列表时：id 检查与重复、Entered by you 与 Default、默认值、可以加多个。 */
async function manualWithList() {
  const { page } = ctx;
  await openAddProvider(page);
  const s = (await fetchWith(ctx, urlFor('plain'), '')).state;
  await typeManual(page, 'my model');
  const spaced = (await formState(page)).manual;
  await typeManual(page, '');
  const empty = (await formState(page)).manual;
  await typeManual(page, 'fake-coder');
  const dup = (await formState(page)).manual;
  await typeManual(page, 'my-model');
  const fine = (await formState(page)).manual;
  record('MD-08 Add a model ID checks the id: Add to list is unavailable at first; a space or an empty id shows "Model '
    + 'ID must be non-empty and contain no spaces."; a listed id shows "Model IDs must be unique within a provider."',
  s.manual?.add.disabled && s.manual.error === null && spaced.error === TEXT.idBad && spaced.add.disabled
    && empty.error === TEXT.idBad && empty.add.disabled && dup.error === TEXT.idDup && dup.add.disabled
    && fine.error === null && !fine.add.disabled, brief({ first: s.manual, spaced, empty, dup, fine }));
  await page.locator(`${FORM} [data-action="add-to-list"]`).click();
  await addManual(page, 'my-model-2');
  await typeManual(page, 'my-model');
  const after = await formState(page);
  const row = rowIn(after, 'my-model');
  record('MD-08 Add to list appends a ticked row "Entered by you" with 128000 / 16384 both "Default", thinking '
    + 'and image unticked; the box clears, several can be added, and an entered id counts as a duplicate',
  JSON.stringify(after.rows.map((r) => r.id)) === '["fake-coder","fake-slow","my-model","my-model-2"]' && row?.picked
    && row.tags.some((t) => t.kind === 'entered' && t.text === 'Entered by you') && row.chat === 'unknown'
    && row.window === '128000' && row.max === '16384' && JSON.stringify(row.defaults)
    === '["contextWindow:Default","maxTokens:Default"]' && !row.reasoning && !row.image
    && after.manual.error === TEXT.idDup && after.add.text === 'Add 2 models', brief({ rows: picks(after), row,
    manual: after.manual }));
  await setSize(page, 'my-model', 'contextWindow', 20000);
  const changed = rowIn(await formState(page), 'my-model');
  record('MD-08 an entered row can be edited: after a window change (20000, no longer the default) only the Max '
    + 'output, which follows it (min(16384, 10000) = 10000), keeps "Default"', changed?.window === '20000'
    && changed.max === '10000' && JSON.stringify(changed.defaults) === '["maxTokens:Default"]',
  brief(changed));
  await closeForm(page);
}

/**
 * @brief 列表错误时手填加入：错误一句与"You can still add model IDs below."，没有清单的标题和按钮，手填的行在错误下面，
 *        Add 后提供商里就是手填的模型。
 * @param label 检查名里的情形
 * @param want { kind, first（第一句的检查）, models（Add 后的模型 id）, baseUrl（配置里的地址） }
 */
async function manualUnderError(label, endpoint, url, key, want) {
  const { page } = ctx;
  await openAddProvider(page);
  const s = (await fetchWith(ctx, url, key)).state;
  await addManual(page, want.id);
  const after = await formState(page);
  record(`MD-08 list error (${label}): the list-error lines replace the checklist ("${want.firstText}" … "${TEXT
    .stillAdd}"), with no "Models (N)", Select all, Clear selection or filter; Add a model ID is there`,
  s.listError?.kind === want.kind && want.first(s.listError.text[0] ?? '') && s.listError.text[1] === TEXT.stillAdd
    && !s.checklist && s.heading === null && s.selectAll === null && s.clearSelection === null && s.filter === null
    && s.manual !== null, brief({ listError: s.listError, checklist: s.checklist }));
  await setName(want.name);
  const closed = await clickAdd();
  const provider = await poll(() => providerIn(want.provider), Boolean, 10000);
  record(`MD-08 list error (${label}): the entered row is listed below the error lines (above Add a model ID), tagged `
    + '"Entered by you", still with no "Models (N)", Select all, Clear selection or filter; Add saves the provider '
    + 'with it', after.order.errorThenRow && after.order.rowThenManual && after.listError?.kind === want.kind
    && !after.checklist && after.heading === null && after.selectAll === null && after.clearSelection === null
    && after.filter === null && rowIn(after, want.id)?.tags.some((t) => t.kind === 'entered') && closed
    && JSON.stringify(provider.value?.models.map((m) => m.id)) === JSON.stringify([want.id])
    && provider.value?.baseUrl === want.baseUrl, brief({ order: after.order, provider: provider.value?.baseUrl,
    models: provider.value?.models.map((m) => m.id), endpoint }));
  return s;
}

/** @brief nolist（no_list，地址带 /chat/completions：只换框不写说明）与 401（rejected）。 */
async function manualErrors() {
  const nolistUrl = urlOf(portOf('nolist'), '/v1/chat/completions');
  const s = await manualUnderError('nolist', 'nolist', nolistUrl, '', { kind: 'no_list', id: 'nl-model',
    first: (text) => text === TEXT.noList, firstText: TEXT.noList, name: 'Nolist Add', provider: 'nolist-add',
    baseUrl: urlFor('nolist') });
  record('MD-09 nolist: the Base URL box is replaced by the tidied address (…/v1) without the "Updated to …" line',
    s.baseUrl.value === urlFor('nolist') && s.note === null && s.detected === null
    && s.name?.value === hostFor('nolist'),
    brief({ base: s.baseUrl.value, note: s.note, detected: s.detected }));
  await manualUnderError('401', 'keyed', urlFor('keyed'), KEY.wrong, { kind: 'rejected', id: 'rj-model',
    first: (text) => text.startsWith('The server rejected the API key: ')
      && text.includes('Incorrect API key provided'),
    firstText: 'The server rejected the API key: <detail>', name: 'Rejected Add', provider: 'rejected-add',
    baseUrl: urlFor('keyed') });
}

// ---------- MD-09：预填、再拉一次、target.api ----------

/** @brief FAKE_NO_V1_ROOT：Base URL 换成 …/v1 并写说明；Name、API type、Network zone 预填且可改；改 API type 不清掉清单。 */
async function prefillAndEdit() {
  const { page } = ctx;
  await openAddProvider(page);
  const root = urlOf(portOf('nov1'), '');
  const first = await fetchWith(ctx, root, '');
  const s = first.state;
  record('MD-09 FAKE_NO_V1_ROOT=1: the Base URL box becomes …/v1 with "Updated to <url> so the model list loads."; '
    + 'Detected: vLLM 0.10.1', s.baseUrl.value === urlFor('nov1') && s.note === `Updated to ${urlFor('nov1')} so the `
    + 'model list loads.' && s.detected?.text === 'Detected: vLLM 0.10.1' && s.detected.kind === 'vllm'
    && picks(s) === 'v1-model+', brief({ base: s.baseUrl.value, note: s.note, detected: s.detected }));
  record('MD-09 after the fetch Name, API type and Network zone are prefilled (host:port, OpenAI-compatible, Local); '
    + 'the first fetch sends target.api null', s.name?.value === hostFor('nov1')
    && s.api?.value === 'openai-completions' && s.zone === 'local' && first.entry?.command.target.api === null
    && first.entry.command.target.kind === 'new',
  brief({ name: s.name, api: s.api?.value, zone: s.zone, target: first.entry?.command.target }));
  await setName('Prefill Edited');
  await field(page, 'API type').selectOption('anthropic-messages');
  await page.locator(`${FORM} input[name="zone"][value="intranet"]`).check();
  const edited = await formState(page);
  record('MD-09 the prefilled Name, API type and Network zone are editable; changing the API type keeps the checklist '
    + 'and its ticks', edited.name.value === 'Prefill Edited' && edited.api.value === 'anthropic-messages'
    && edited.zone === 'intranet' && picks(edited) === 'v1-model+' && edited.checklist,
  brief({ name: edited.name.value, api: edited.api.value, zone: edited.zone, picks: picks(edited) }));
  const again = await fetchNow(ctx);
  const a = again.state;
  record('MD-09 Fetch models again keeps your edited Name, API type and zone and sends the edited API type as '
    + 'target.api', again.entry?.command.target.api === 'anthropic-messages' && a.name?.value === 'Prefill Edited'
    && a.api?.value === 'anthropic-messages' && a.zone === 'intranet' && a.checklist,
  brief({ target: again.entry?.command.target, name: a.name?.value, api: a.api?.value, zone: a.zone }));
  await addressAndKeyEdits();
}

/** @brief 拉取后改 Base URL 或 API key：清单、说明、Detected 和下面的字段都收起；改过的值留着，下次拉取不覆盖。 */
async function addressAndKeyEdits() {
  const { page } = ctx;
  await addManual(page, 'kept-by-hand');
  const withManual = await formState(page);
  await field(page, 'Base URL').fill(urlFor('plain'));
  const moved = await formState(page);
  record('MD-09 editing the Base URL after a fetch clears the checklist, Detected and the note and folds the fields '
    + 'back to the start', atStart(moved) && moved.note === null, brief(moved));
  const third = await fetchNow(ctx);
  const t = third.state;
  record('MD-09 editing the Base URL also drops the hand-entered rows: the next fetch lists only the server\'s models',
    picks(withManual) === 'v1-model+ kept-by-hand+' && picks(t) === 'fake-coder- fake-slow-',
    `${picks(withManual)} -> ${picks(t)}`);
  await field(page, 'API key').fill('k');
  const keyed = await formState(page);
  record('MD-09 editing the API key after a fetch clears the checklist the same way', t.checklist && atStart(keyed),
    brief({ before: t.checklist, after: keyed.checklist }));
  record('MD-09 after the address change the next fetch still keeps the edited Name, API type and zone (target.api '
    + 'anthropic-messages)', third.entry?.command.target.api === 'anthropic-messages' && t.name?.value
    === 'Prefill Edited' && t.api?.value === 'anthropic-messages' && t.zone === 'intranet',
  brief({ target: third.entry?.command.target, name: t.name?.value, api: t.api?.value, zone: t.zone }));
  await closeForm(page);
  await openAddProvider(page);
  const p = (await fetchWith(ctx, urlFor('plain'), '')).state;
  const n = (await fetchWith(ctx, urlOf(portOf('nov1'), ''))).state;
  record('MD-09 fields you did not edit are prefilled again from the next result (Name follows the new host)',
    p.name?.value === hostFor('plain') && n.name?.value === hostFor('nov1') && n.api?.value === 'openai-completions',
    `${p.name?.value} -> ${n.name?.value}`);
  await closeForm(page);
}

// ---------- MD-09：加入、More settings、Adding…、一次写入、探针 ----------

/** @brief 填好 add 端点的表单：Select all 两行加一行手填、Name、More settings 的并发与兼容选项（先试一次字段错误）。 */
async function fillAddForm() {
  const { page } = ctx;
  await openAddProvider(page);
  await fetchWith(ctx, urlFor('add'), KEY.add);
  await page.locator(`${FORM} [data-action="select-all"]`).click();
  await addManual(page, 'add-c');
  await setName('Form Add');
  const folded = (await formState(page)).more;
  await openMore(page);
  const opened = (await formState(page)).more;
  await field(page, 'Concurrency per key').fill('0');
  const bad = await formState(page);
  await field(page, 'Concurrency per key').fill('7');
  await page.locator(`${FORM} .compat-checks label`).filter({ hasText: TEXT.compat }).locator('input').check();
  const s = await formState(page);
  record('MD-09 More settings: folded at first; opened it has Concurrency per key 4, the hint line and the five '
    + 'compatibility options (unticked, OpenAI-compatible; 2026-10-26); 0 shows "Use a whole number from 1 to 64." and '
    + 'blocks Add', folded?.open === false && opened?.open === true && opened.concurrency?.value === '4'
    && opened.compatHint === TEXT.compatHint && JSON.stringify(opened.compat) === JSON.stringify(Array(5).fill(false))
    && bad.fieldErrors.concurrency === TEXT.concurrency && bad.add.disabled
    && s.more.concurrency?.value === '7' && !s.add.disabled && s.add.text === 'Add 3 models' && s.cost === TEXT.cost,
  brief({ folded, opened, bad: bad.fieldErrors, add: s.add, more: s.more, cost: s.cost }));
  return s;
}

/** @brief Add：一次 models.saveProvider、一次写入全部勾选的模型（清单顺序），新卡在最后，每个模型都开始探针。 */
async function addProvider() {
  const { page, userData } = ctx;
  const refsBefore = credentialRefs(userData);
  await fillAddForm();
  const since = Date.now();
  await watchAdding(page);
  const watcher = watchConfig(userData, 'form-add');
  const closed = await clickAdd();
  const provider = (await poll(() => providerIn('form-add'), Boolean, 10000)).value;
  const ids = ['add-a', 'add-b', 'add-c'];
  const probed = await poll(() => ids.filter((id) => chatLines(eps.add, since).some((line) => line.model === id
    && line.probe && line.key === tail(KEY.add))), (found) => found.length === ids.length, 60000);
  await sleep(500);
  watcher.close();
  const seen = await addingSeen(page);
  const saves = await commandsOf(ctx, 'models.saveProvider', since);
  record('MD-09 while Adding… the Base URL and API key are readonly and Fetch models and Add are unavailable',
    seen.adding?.baseUrlReadOnly === true && seen.adding.apiKeyReadOnly === true && seen.adding.fetchDisabled === true
    && seen.adding.addDisabled === true, brief(seen.adding));
  record('MD-09 Add sends one models.saveProvider (id null) with every ticked model in checklist order and the key; '
    + 'the form closes', closed && saves.length === 1 && saves[0].command.id === null && JSON.stringify(saves[0].command
    .models.map((m) => m.id)) === JSON.stringify(ids) && saves[0].command.keySecret === `…${tail(KEY.add)}`,
  brief(saves.map((e) => ({ id: e.command.id, models: e.command.models.map((m) => m.id) }))));
  record('MD-09 one write: Add writes model-config.json exactly once (one atomic-write temp file from Add until every '
    + 'model probed), and every state of the file seen with the new provider lists all three models in checklist '
    + 'order', watcher.configWrites.size === 1 && watcher.snapshots.length > 0
    && watcher.snapshots.every((ids2) => ids2 === JSON.stringify(ids)),
  brief({ writes: [...watcher.configWrites], snapshots: watcher.snapshots }));
  checkSavedProvider(provider, refsBefore);
  const order = await cardOrder();
  const rows = await rowOrder('form-add');
  record('MD-09 the new card is last and its model rows follow the checklist order; every added model starts probing '
    + '(Verifying… shown, probe requests with the new key reach the endpoint)', order.at(-1) === 'form-add'
    && order[0] === SEED_ID && JSON.stringify(rows) === JSON.stringify(ids.map((id) => `form-add/${id}`))
    && ids.every((id) => seen.verifying.includes(`form-add/${id}`)) && probed.ok,
  brief({ order, rows, verifying: seen.verifying, probed: probed.value }));
}

/** @brief 配置里的新提供商：名称、地址、区域、More settings 的并发与兼容选项、第一个 key、模型的值与顺序。 */
function checkSavedProvider(provider, refsBefore) {
  const refs = credentialRefs(ctx.userData);
  const models = provider?.models ?? [];
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  record('MD-09 More settings are saved: concurrency 7 and compat { maxTokensField: "max_tokens" } in '
    + 'model-config.json',
    provider?.concurrency === 7 && JSON.stringify(provider.compat) === '{"maxTokensField":"max_tokens"}',
    brief({ concurrency: provider?.concurrency, compat: provider?.compat }));
  record('MD-09 the saved provider: name "Form Add", the fetched address, OpenAI-compatible, Local, the key as "Key 1" '
    + '(credentials.json gets its ref), models with the checklist values (entered row 128000 / 16384)',
  provider?.name === 'Form Add' && provider.baseUrl === urlFor('add') && provider.api === 'openai-completions'
    && provider.zone === 'local' && provider.keys.length === 1 && provider.keys[0].label === 'Key 1'
    && refs.includes(provider.keys[0].ref) && !refsBefore.includes(provider.keys[0].ref)
    && byId['add-a']?.contextWindow === 131072 && byId['add-a'].maxTokens === 16384 && byId['add-c']?.contextWindow
    === 128000 && byId['add-c'].maxTokens === 16384 && models.every((m) => m.family === '' && !m.reasoning),
  brief({ provider: provider && { ...provider, models: models.map((m) => [m.id, m.contextWindow, m.maxTokens]) },
    refs }));
  const entered = byId['add-c'];
  record('MD-08 with a list, a hand-entered row is added together with the ticked listed rows: add-c is saved last, '
    + 'with the defaults 128000 / 16384, no thinking, text input', models.at(-1)?.id === 'add-c'
    && entered?.contextWindow === 128000 && entered.maxTokens === 16384 && entered.reasoning === false
    && JSON.stringify(entered.input) === '["text"]', brief(entered));
}

// ---------- MD-09：保存失败时删除本次新存的 key ----------

/** @brief model-config.json 只读时 Add 失败：表单里原文、配置不变、credentials.json 里没有新的 ref；改回可写后再 Add。 */
async function failedSave() {
  const { page, userData } = ctx;
  await openAddProvider(page);
  await fetchWith(ctx, urlFor('fail'), KEY.fail);
  await setName('Fail Save');
  // 预填的 API type 与区域改过后照样保存（MD-09"预填且可改"，最后一条检查看配置）
  await field(page, 'API type').selectOption('openai-responses');
  await page.locator(`${FORM} input[name="zone"][value="intranet"]`).check();
  const file = join(userData, 'model-config.json');
  const before = readText(file);
  const refsBefore = credentialRefs(userData);
  const since = Date.now();
  const watcher = watchConfig(userData, 'fail-save');
  chmodSync(file, 0o444);
  try {
    await page.locator(`${FORM} [data-action="add-models"]`).click();
    const failed = await poll(() => formState(page), (s) => Boolean(s?.message), 15000);
    const refs = await poll(() => credentialRefs(userData), (list) => !list.includes('fail-save#1'), 5000);
    await sleep(500);
    // 存 key 与删 key 各改写一次 credentials.json；只存不删时 ref 会留着，没存时删 key 不写文件（main/credentials.ts）
    const stored = watcher.credentialEvents;
    const logged = logLines(ctx, /\[kernel\] models\.saveProvider failed: /, since)
      .map((line) => line.slice(line.indexOf('failed: ') + 'failed: '.length));
    record('MD-09 a failed save (model-config.json read-only) keeps the form open with the kernel\'s error text, '
      + 'leaves the config unchanged and deletes the key it had just stored (credentials.json was written, and has '
      + 'no new ref)', failed.ok && failed.value.add?.text === 'Add 1 model' && failed.value.message.includes('EPERM')
      && logged.includes(failed.value.message) && readText(file) === before && refs.ok && stored > 0
      && JSON.stringify(refs.value) === JSON.stringify(refsBefore) && watcher.snapshots.length === 0,
    brief({ message: failed.value?.message, logged, credentialEvents: stored, refs: refs.value, before: refsBefore }));
  } finally {
    watcher.close();
    chmodSync(file, 0o666);
  }
  const closed = await clickAdd();
  const saved = await poll(() => providerIn('fail-save'), Boolean, 10000);
  record('MD-09 after the file is writable again the same form saves: the provider and its key ref are stored, with '
    + 'the API type and zone you changed (OpenAI Responses, Intranet)', closed && saved.ok
    && credentialRefs(userData).includes(saved.value.keys[0]?.ref) && saved.value.api === 'openai-responses'
    && saved.value.zone === 'intranet' && saved.value.name === 'Fail Save',
  brief({ keys: saved.value?.keys, api: saved.value?.api, zone: saved.value?.zone }));
}

// ---------- MD-09：改 Base URL 或 key 清掉的文字（A16） ----------

/** @brief 拉取中点 Cancel 后改 Base URL：“Fetch cancelled”同样消失（改 key 的一半在 fetchingState）。 */
async function cancelThenEditUrl() {
  const { page } = ctx;
  await openAddProvider(page);
  await fillAddress(page, urlFor('slow'), '');
  await startFetch();
  await page.locator(`${FORM} [data-action="fetch-cancel"]`).click();
  const back = await poll(() => formState(page), (st) => st?.status?.state === 'cancelled', 10000);
  await sleep(500);
  const stayed = await formState(page);
  await field(page, 'Base URL').fill(urlFor('plain'));
  const moved = await formState(page);
  record('MD-09 "Fetch cancelled" also goes away when the Base URL changes: shown after the cancel, removed by editing '
    + 'the Base URL, the form stays at the start', back.ok && back.value.status.text === 'Fetch cancelled'
    && stayed.status?.text === 'Fetch cancelled' && moved.status === null && atStart(moved)
    && moved.baseUrl.value === urlFor('plain'), brief({ before: stayed.status, after: moved.status }));
  await closeForm(page);
  await commandErrorCleared();
}

/**
 * @brief 拉取命令出错（key 中间有空格，§5.1）：停在开始，Fetch models 下方原文，留到你改 Base URL 或 API key；
 *        改 Base URL、改 API key 各清掉一次。
 */
async function commandErrorCleared() {
  const { page } = ctx;
  await openAddProvider(page);
  const first = await fetchWith(ctx, urlFor('plain'), KEY.header);
  await sleep(1000);
  const stayed = await formState(page);
  await field(page, 'Base URL').fill(`${urlFor('plain')}/`);
  const byUrl = await formState(page);
  record('MD-09 a fetch command error (an API key with a space: "API key contains characters that cannot be sent in a '
    + 'header") stays at the start below Fetch models until you edit; editing the Base URL removes it',
  first.entry?.result?.error === TEXT.header && atStart(first.state) && first.state.message === TEXT.header
    && first.state.order.messageBelowFetch && stayed.message === TEXT.header && stayed.order.messageBelowFetch
    && atStart(stayed) && byUrl.message === null && atStart(byUrl),
  brief({ result: first.entry?.result?.error, shown: stayed.message, below: stayed.order.messageBelowFetch,
    after: byUrl.message }));
  const again = await fetchNow(ctx);
  await field(page, 'API key').fill('');
  const byKey = await formState(page);
  record('MD-09 editing the API key also removes a fetch command error: the same error after a second fetch is gone '
    + 'once the API key box changes', again.state.message === TEXT.header && byKey.message === null && atStart(byKey),
  brief({ before: again.state.message, after: byKey.message }));
  await closeForm(page);
  await saveErrorCleared();
}

/** @brief 勾上 fake-coder、填 Name、点 Add，等表单里出现原文（model-config.json 只读时保存失败）。 */
async function failSave() {
  const { page } = ctx;
  await setPicked(page, 'fake-coder', true);
  await setName('Clear Error');
  await page.locator(`${FORM} [data-action="add-models"]`).click();
  return poll(() => formState(page), (s) => Boolean(s?.message), 15000);
}

/**
 * @brief 上次保存失败的原文（model-config.json 只读）：改 API key 后清掉，再拉一次也不回来；再失败一次后改 Base URL
 *        同样清掉。之后改回可写，关闭表单不保存。
 */
async function saveErrorCleared() {
  const { page, userData } = ctx;
  await openAddProvider(page);
  await fetchWith(ctx, urlFor('plain'), '');
  const file = join(userData, 'model-config.json');
  chmodSync(file, 0o444);
  try {
    const one = await failSave();
    await field(page, 'API key').fill('k');
    const byKey = await formState(page);
    await field(page, 'API key').fill('');
    const refetched = (await fetchNow(ctx)).state;
    record('MD-09 editing the API key removes a previous save error: the form goes back to the start without the '
      + 'error text, and the next fetch shows the checklist without it', one.ok && one.value.message.includes('EPERM')
      && byKey.message === null && atStart(byKey) && refetched.checklist && refetched.message === null,
    brief({ error: one.value?.message, afterEdit: byKey.message, afterFetch: refetched.message }));
    const two = await failSave();
    await field(page, 'Base URL').fill(`${urlFor('plain')}/`);
    const byUrl = await formState(page);
    record('MD-09 editing the Base URL removes a previous save error the same way', two.ok
      && two.value.message.includes('EPERM') && byUrl.message === null && atStart(byUrl),
    brief({ error: two.value?.message, afterEdit: byUrl.message }));
  } finally {
    chmodSync(file, 0o666);
  }
  await closeForm(page);
}

// ---------- MD-06：key、F8、时限、区域 ----------

/** @brief 新提供商的 key 只用于这次读取：列表请求带它，不存盘、不进 F8 报告；关掉表单后不留着。 */
async function keyOnlyForFetch() {
  const { page, userData } = ctx;
  const refsBefore = credentialRefs(userData);
  await openAddProvider(page);
  const since = Date.now();
  const s = (await fetchWith(ctx, urlFor('keyed'), KEY.disc)).state;
  const lists = listLines(eps.keyed, since);
  // 列表以外的发现请求（vLLM 的版本 /version，D1：有 key 时带 Bearer）同样记一行带 path 的 JSON
  const reads = eps.keyed.logs.filter((line) => line.t >= since && typeof line.path === 'string');
  record('MD-06 the new provider\'s key is sent with the discover requests: every discover request on the endpoint '
    + '(the list and the version read) carries its last 4 characters, and the list loads', lists.length > 0
    && reads.length > lists.length && reads.every((line) => line.key === tail(KEY.disc))
    && picks(s) === 'fake-coder- fake-coder-b-', brief({ reads, picks: picks(s) }));
  const report = await saveIssueReport(page, 'Fetch models check', 'No API key in this report');
  const activity = report.md.split(/\r?\n/).filter((line) => line.includes('Fetch models'));
  record('MD-06 the F8 report saved after the fetch has no key; Recent activity lists "Fetch models 127.0.0.1:4801"',
    report.md.length > 0 && secretsIn(report.md, SECRETS).length === 0
    && activity.some((line) => line.includes(`Fetch models ${hostFor('keyed')}`)),
  `${report.path ?? 'not saved'} | ${activity.join(' | ')}`);
  await closeForm(page);
  await sleep(1000);
  const files = ['model-config.json', 'model-profiles.json'].map((name) => readText(join(userData, name)));
  record('MD-06 after closing the form the key is in neither model-config.json nor model-profiles.json, no key ref was '
    + 'stored, and no chat request ever used it', files.every((text) => text.length > 0 && !text.includes(KEY.disc))
    && JSON.stringify(credentialRefs(userData)) === JSON.stringify(refsBefore)
    && chatLines(eps.keyed).every((line) => line.key !== tail(KEY.disc)), brief(credentialRefs(userData)));
  await openAddProvider(page);
  const mark = Date.now();
  const again = (await fetchWith(ctx, urlFor('keyed'), '')).state;
  record('MD-06 the key is not kept after the form closed: a new fetch with an empty key box sends no key (endpoint '
    + 'log key null) and is rejected', again.listError?.kind === 'rejected'
    && listLines(eps.keyed, mark).length > 0 && listLines(eps.keyed, mark).every((line) => line.key === null),
  brief({ listError: again.listError, lists: listLines(eps.keyed, mark) }));
  await closeForm(page);
}

/** @brief 每个请求 15 秒时限：列表请求等 16 秒才回时，15 秒左右以 unreachable "Timed out after 15s" 结束。 */
async function requestTimeout() {
  const { page } = ctx;
  await openAddProvider(page);
  const run = await fetchWith(ctx, urlFor('timeout'), '', 40000);
  const ms = run.entry?.doneAt - run.entry?.t;
  record('MD-06 each discover request has the 15 s limit: a list request held for 16 s ends after about 15 s as '
    + '"Couldn’t reach 127.0.0.1:4811: Timed out after 15s"', run.state.listError?.kind === 'unreachable'
    && run.state.listError.text[0] === `Couldn’t reach ${hostFor('timeout')}: Timed out after 15s`
    && ms >= 14500 && ms < 19000, brief({ listError: run.state.listError, ms }));
  await closeForm(page);
}

/** @brief 不按项目区域过滤：没有任何默认允许的区域，选 Public 再拉取，照样拿到列表。 */
async function notZoneFiltered() {
  const { page } = ctx;
  await openAddProvider(page);
  await fetchWith(ctx, urlFor('plain'), '');
  await page.locator(`${FORM} input[name="zone"][value="public"]`).check();
  const since = Date.now();
  const again = await fetchNow(ctx);
  const config = configOf(ctx.userData);
  record('MD-06 discovery is not filtered by zone: with no zone allowed by default (allowedZones []) and Public '
    + 'chosen, Fetch models still reads the list', JSON.stringify(config?.allowedZones) === '[]'
    && again.state.zone === 'public' && again.state.checklist && again.state.rows.length === 2
    && again.entry?.result?.listError === null && listLines(eps.plain, since).length > 0,
  brief({ allowed: config?.allowedZones, zone: again.state.zone, result: again.entry?.result }));
  await closeForm(page);
}

// ---------- 运行 ----------

/** 步骤：名字 → [函数, 出错时记的编号] */
const STEPS = {
  start: [startState, 'MD-09'], fetching: [fetchingState, 'MD-09'], defaults: [defaultPicks, 'MD-07'],
  markers: [markersAndEdits, 'MD-07'], filter: [filterBox, 'MD-07'], look: [checklistLookAndButtons, 'MD-07'],
  manual: [manualWithList, 'MD-08'], manualErrors: [manualErrors, 'MD-08'], prefill: [prefillAndEdit, 'MD-09'],
  add: [addProvider, 'MD-09'], failedSave: [failedSave, 'MD-09'], cleared: [cancelThenEditUrl, 'MD-09'],
  keyOnly: [keyOnlyForFetch, 'MD-06'], timeout: [requestTimeout, 'MD-06'], zones: [notZoneFiltered, 'MD-06'],
};

/** @brief 跑一个步骤；出错时记一条失败（编号开头）并截图，关掉还开着的表单。 */
async function runStep(name, [step, id]) {
  console.log(`[md-app-form] step ${name}`);
  try {
    await step();
  } catch (error) {
    record(`${id} ${name}: flow`, false, oneLine(error?.stack ?? error, 600));
    await shot(`${name}-error`);
    await closeForm(ctx.page).catch(() => {});
  }
}

/** @brief 最后：页面没有报错；日志、数据目录、结果里都没有 key 的明文。 */
function finalChecks() {
  record('MD-09 (form suite) the page reported no errors', ctx.pageErrors.length === 0,
    ctx.pageErrors.slice(0, 3).join(' | '));
  const logs = ctx.logs.map((item) => item.line).join('\n');
  record('MD-06 no key appears in the kernel or main process logs or the page console of this run',
    ctx.logs.length > 0 && secretsIn(logs, SECRETS).length === 0, `${ctx.logs.length} lines`);
  const hits = filesWithSecrets(ctx.userData, SECRETS);
  record('MD-06 no plaintext key in any file of the data folder (model-config.json, model-profiles.json, '
    + 'credentials.json, ui-issues, pi)', hits.length === 0, hits.slice(0, 5).join('; '));
  record('MD-06 no plaintext key in this test\'s results', secretsIn(JSON.stringify(results), SECRETS).length === 0);
}

try {
  for (const [name, [port, env]] of Object.entries(ENDPOINTS)) eps[name] = await startEndpoint(port, env);
  await startApp(ctx);
  record('MD-09 the command recorder is installed in the preload world (target.api and models.discoverCancel are read '
    + 'from it)', ctx.spy === true, String(ctx.spy));
  for (const [name, step] of Object.entries(STEPS)) {
    if (!only || only.includes(name)) await runStep(name, step);
  }
} catch (error) {
  record('MD-09 form suite: setup', false, oneLine(error?.stack ?? error, 600));
  await shot('setup-error');
} finally {
  await closeApp(ctx);
  await stopEndpoints(eps);
}
finalChecks();
console.log(`[md-app-form] data dir: ${ctx.userData}`);
process.exitCode = write(RESULT) ? 0 : 1;
console.log(`[md-app-form] results in test-results/${RESULT}`);
