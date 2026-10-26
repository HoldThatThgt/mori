// 一键拉取模型 App 层：提供商卡、探针第 0 步与模型行（docs/specs/model-discovery.md §13.2；状态表与标识见
// docs/v1/screens/models-settings.md "卡上的 Fetch models""Models 行""模型表单（Edit）"）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic），逐条检查：
//   MD-10 卡上的 Fetch models 用 §5.1 选的已保存 key（端点日志里 key 末 4 位；第一个 key 被限流或被拒时用第二个）；
//         拉取中按钮不可用；清单开着时卡上的按钮不可用、没有 Detected 一行；已加入的行标 Added、不能勾也不能改；
//         Not listed 一行；Add 发 models.addModels，加在已有模型之后、按清单顺序，并开始探针；重复的 id 整次拒绝、配置不变
//         （经进程桥）；卡上没有 Add model；models.saveModel 没有 adding（模型不存在时出错）；Edit 里没设过强度的模型显示
//         config.get 的 defaultThinkingLevel（pi 设置里没有时 Medium），没改就不写；拉取被别处取消（新的一次发现、
//         打开别的表单）时卡上"Fetch cancelled"，留到再点这张卡的 Fetch models、点了就清掉（实现时定的 A16）。
//   MD-08（卡上）Add a model ID 的重复检查含这个提供商已有的模型：配置里有、服务没列出的（只在 Not listed 一行里）、
//         Added 的行、列表错误时（没有清单的行）提供商的模型，都显示"Model IDs must be unique within a provider."、
//         Add to list 不可用；没用过的 id 没有错误。
//   MD-12（App 部分）第 0 步经读取器得出种类、版本、窗口与 meta（sglang、ollama、rich 三种形状；Ollama 每个第 0 步只
//         POST 自己的 /api/show）；Ollama 只有训练窗口时报告的窗口为 null；Ollama 报告的窗口让有效窗口变小；一次加入
//         3 个模型时列表只读一次、每个档案都有种类与 meta，期间点 Fetch models 再点 Cancel 不取消探针；没有 meta 的旧档案
//         照样读、不重新探测；读版本每个提供商一次、不发 §4.2 的详情请求；localai、tensorrt 形状（旧档案写的是 vllm）
//         认出后重新探测一次（2026-10-26 起模型行没有 Cancel test…，不再查）。
//   MD-13 没报告、值仍是默认值的窗口与输出写 (default)，用 Edit 改了就不写（2026-10-26，负责人走查 M6）；§8 表五行提示各自的显示条件与 Use 的改动（窗口改小时 Max output 一起改，
//         Max output 小于 N 时不改；-alwaysthink 给第四行，服务报告了思考或接口不是 openai-completions 时没有第四行）；
//         Use 立即保存、不带思考强度、之后重新探测；旧档案只显示第四行。
//   MD-06（已有提供商）models.discover 用 §5.1 选的 key（端点日志）；key 不回到界面（拉取结果、models.get、页面 DOM
//         与输入框），也不进日志和本套件的结果文件。
// 用法（在 app/ 下，out/ 是当前的构建）：node tests/ui/md-app-card.mjs [--exe <Mori.exe 路径>] [--only card,shapes,…]
//   步骤：card（MD-10、MD-08、MD-06、旧档案）、shapes（MD-12 三种形状、读版本、localai/tensorrt；MD-13 训练窗口）、
//   batch（MD-12 一次加入 3 个）、hints（MD-13）。
// 结果写到 test-results/md-app-card(-packaged).json；--only 时写 md-partial-app-card(-packaged).json（不计入覆盖检查）。
// 截图在 test-results/md-app-card(-packaged)/。端口：本套件的 4820–4839（一键拉取模型各套件分开的范围，同时只开一个 Mori）。
// 测试准备（synthetic test setup）：数据目录里的 model-config.json、model-profiles.json（旧档案）与 pi/settings.json 由
// md-card-helpers.mjs seedUserData 写入；key 是测试自己生成的合成值，启动后经 models.addKey 加（同 v1-models-app-switch.mjs）。

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, sleep } from './lib.mjs';
import {
  FAKE_VERSION, addKeyBridge, baseOf, brief, bridge, cardFetch, cardOf, cardState, closeApp, configOf, detailLines,
  listLines, manualState, modelOf, modelRow, modelRowState, modelsInfo, oldProfile, openModels, pageDump, poll,
  probeLines, providerIn, providerOf, readJson, readText, savedThinking, secretsIn, seedUserData, startApp, startFake,
  stopFake, storedProfile, typeManual, verified, waitProfiles,
} from './md-card-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',').filter(Boolean) ?? null;
const suffix = exePath ? '-packaged' : '';
const RESULT = only ? `md-partial-app-card${suffix}.json` : `md-app-card${suffix}.json`;
const shots = join(appRoot, `test-results/md-app-card${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write, results } = createRecorder(exePath ?? 'dev build');
const shot = (ctx, name) => ctx?.page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 合成端点的端口（本套件的 4820–4839） */
const PORT = { card: 4820, keyed: 4821, sglang: 4822, ollama: 4823, rich: 4824, localai: 4825, tensorrt: 4826,
  batch: 4827, hintsVllm: 4828, hintsRich: 4829, hintsTyped: 4830, hintsThink: 4831, hintsResponses: 4832 };
/** 测试用的合成 key（synthetic），末 4 位互不相同，合成端点的日志只记末 4 位 */
const KEY = { one: 'synthetic-md-card-key-one-C1A1', two: 'synthetic-md-card-key-two-C2B2',
  three: 'synthetic-md-card-key-three-C3C3', four: 'synthetic-md-card-key-four-C4D4' };
const SECRETS = Object.values(KEY);
const last4 = (secret) => secret.slice(-4);
/** 合成端点默认的窗口（FAKE_MAX_MODEL_LEN 的默认值）与 rich 形状的输出上限（W/16） */
const W = 131072;
const RICH_MAX = W / 16;
/** 两个值按 JSON 相同 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @brief 记一条"页面没有报错"（名字以这一步的 MD 编号开头）。 */
function recordPageErrors(ctx, id, step) {
  if (!ctx) return;
  record(`${id} (${step}) the page reported no errors`, ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3)
    .join(' | '));
}

/** @brief 关掉卡上的清单（底部的 Cancel，标识 data-action="close-form"），等它消失。 */
async function closeChecklist(page, providerId) {
  await cardOf(page, providerId).locator('[data-action="close-form"]').click();
  await poll(() => cardState(page, providerId), (state) => state && !state.checklist && !state.listError, 10000);
}

/** @brief 点卡上的 Fetch models，等清单或列表错误出现；返回 { since（点击前的时刻）, ok, state }。 */
async function fetchOnCard(page, providerId, timeout = 30000) {
  const since = Date.now();
  await cardFetch(page, providerId).click();
  const done = await poll(() => cardState(page, providerId), (state) => state?.checklist || state?.listError,
    timeout);
  return { since, ok: done.ok, state: done.value };
}

/** @brief 卡上清单的一行（按模型 id）。 */
const discovered = (page, providerId, id) => cardOf(page, providerId)
  .locator(`[data-testid="discovered-row"][data-model="${id}"]`);

/** @brief Keys 行（按 ref）。 */
const keyRow = (page, providerId, ref) => cardOf(page, providerId)
  .locator(`[data-testid="key-row"][data-ref="${ref}"]`);

/** @brief 点 Keys 行的 Test，等这一行的记录变成 state（rate_limited、auth）。 */
async function testKeyUntil(page, providerId, ref, state) {
  await keyRow(page, providerId, ref).locator('[data-action="key-test"]').click();
  return poll(() => keyRow(page, providerId, ref).getByTestId('key-state').getAttribute('data-state')
    .catch(() => null), (value) => value === state, 30000);
}

// ---------- card：卡上的 Fetch models（MD-10、MD-06、MD-12 旧档案） ----------

/**
 * @brief card 一步的数据目录（synthetic test setup）：cardp（4820，fake-coder 与服务不再列出的 fake-old）、
 *        keyp（4821，fake-coder），都是已验证的旧档案（没有 meta）；pi 设置的 defaultThinkingLevel 为 high。
 */
function cardSetup() {
  const cardModels = [modelOf('fake-coder'), modelOf('fake-old')];
  const keyModels = [modelOf('fake-coder')];
  const profiles = [
    ...cardModels.map((model) => oldProfile(baseOf(PORT.card), model, { reported: W })),
    ...keyModels.map((model) => oldProfile(baseOf(PORT.keyed), model, { reported: W })),
  ];
  const providers = [providerOf('cardp', 'Card Provider', PORT.card, cardModels),
    providerOf('keyp', 'Key Provider', PORT.keyed, keyModels)];
  return { userData: seedUserData({ providers, profiles, piSettings: { defaultThinkingLevel: 'high' },
    normalDefault: 'cardp' }), profiles };
}

/** @brief 没有 meta 的旧档案照样读、启动时不重新探测（§7.2）；读版本（§7.3）读完后再看。 */
async function oldProfilesKept(env) {
  const { ctx, fakes, profiles } = env;
  const read = await poll(() => listLines(fakes.card).length > 0 && listLines(fakes.keyed).length > 0, Boolean, 20000);
  await sleep(3000);
  const info = await modelsInfo(ctx.page);
  const views = Object.fromEntries(['cardp/fake-coder', 'cardp/fake-old', 'keyp/fake-coder']
    .map((ref) => [ref, info?.profiles?.[ref] ?? null]));
  const stored = profiles.map((seed) => storedProfile(ctx.userData, seed.baseUrl, seed.modelId));
  const kept = stored.every((item, i) => item?.probedAt === profiles[i].probedAt && item.auto.meta === undefined);
  const probes = probeLines(fakes.card).length + probeLines(fakes.keyed).length;
  record('MD-12 an old profile without meta loads (Verified, ProfileView.reported null) and is not re-probed at '
    + 'startup (probedAt unchanged, no probe request)', read.ok && Object.values(views).every((view) => verified(view)
    && view.reported === null) && kept && probes === 0,
  brief({ views: Object.fromEntries(Object.entries(views).map(([ref, v]) => [ref, v && { state: v.tool_calling.state,
    reported: v.reported, probedAt: v.probedAt }])), kept, probes }));
}

/** @brief 卡上只有 Fetch models，没有 Add model（§6.5）。 */
async function noAddModel(env) {
  const { page } = env.ctx;
  const state = await cardState(page, 'cardp');
  const total = await page.locator('[data-testid="settings-page"] [data-action="add-model"]').count();
  record('MD-10 the provider card has "Fetch models" and no "Add model" button (none anywhere in Settings)',
    state?.fetch?.text === 'Fetch models' && state.fetch.disabled === false && state.addModel === 0 && total === 0,
    brief({ fetch: state?.fetch, addModel: state?.addModel, total }));
}

/** @brief 第一次拉取：拉取中、用第一个 key、清单开着时的卡（§5.1、§6.5）。 */
async function firstFetch(env) {
  const { page } = env.ctx;
  const since = Date.now();
  await cardFetch(page, 'cardp').click();
  const during = await cardState(page, 'cardp');
  record('MD-10 while the card fetches, its button reads "Fetching models…" and is disabled, with a Cancel beside it',
    during?.fetch?.text === 'Fetching models…' && during.fetch.disabled && during.cancel
    && during.status?.state === 'fetching', brief({ fetch: during?.fetch, cancel: during?.cancel,
      status: during?.status }));
  const open = await poll(() => cardState(page, 'cardp'), (state) => state?.checklist, 20000);
  const lists = listLines(env.fakes.card, since);
  record('MD-10 with no key record the card’s Fetch models uses the first saved key: one list request '
    + `/v1/models with key …${last4(KEY.one)} (endpoint log)`, open.ok && lists.length === 1
    && lists[0].path === '/v1/models' && lists[0].key === last4(KEY.one), brief(lists));
  return open.value;
}

/**
 * @brief 清单开着时：卡上的按钮不可用、没有 Detected，也没有 Name、API type、More settings 与 Network zone、Added 的行锁住、
 *        Not listed 一行（§6.5；models-settings.md“卡上的 Fetch models”的拉取后）。
 */
async function openChecklist(env, state) {
  const { page } = env.ctx;
  record('MD-10 while the card’s checklist is open, the card’s "Fetch models" is disabled',
    state?.fetch?.text === 'Fetch models' && state.fetch.disabled === true, brief(state?.fetch));
  const anywhere = await page.getByTestId('detected-server').count();
  record('MD-10 the card’s checklist shows no "Detected: …" line', state?.detected === 0 && anywhere === 0,
    brief({ inCard: state?.detected, anywhere }));
  record('MD-10 the card’s checklist has no Name, API type or More settings, and no Network zone (2026-10-26)',
    state?.checklist === true && Array.isArray(state.extras) && state.extras.length === 0,
  brief({ checklist: state?.checklist, extras: state?.extras }));
  const coder = state?.rows.find((row) => row.id === 'fake-coder');
  record('MD-10 a model already in the provider is marked "Added" and locked: not picked, pick box and every field '
    + 'disabled', Boolean(coder?.added && coder.tags.includes('added:Added') && coder.picked === false
    && coder.pickDisabled && coder.fields.length === 4 && coder.fields.every((field) => field.disabled)),
  brief(coder));
  const fresh = state?.rows.filter((row) => row.id !== 'fake-coder') ?? [];
  record('MD-10 listed models not in the provider are not marked Added and can be picked',
    fresh.map((row) => row.id).join() === 'fake-new-a,fake-new-b'
    && fresh.every((row) => !row.added && !row.pickDisabled && !row.tags.some((tag) => tag.startsWith('added'))),
    brief(fresh));
  record('MD-10 a configured model the server does not list: "Not listed by the server: fake-old" below the '
    + 'checklist', state?.notListed === 'Not listed by the server: fake-old', brief(state?.notListed));
}

/** Add a model ID 重复时的字段错误（§6.4；models-settings.md "字段错误的文字"） */
const DUPLICATE_ID = 'Model IDs must be unique within a provider.';

/**
 * @brief 在卡上清单的 Add a model ID 里填 text，等字段错误变成 error（没有错误为 null）；超时时返回最后读到的样子，
 *        由检查判断。
 */
async function manualAfter(page, providerId, text, error) {
  await typeManual(page, providerId, text);
  const read = await poll(() => manualState(page, providerId), (state) => state?.text === text
    && state.error === error, 3000);
  return read.value;
}

/**
 * @brief 卡上清单的 Add a model ID 查重复时含这个提供商已有的全部模型（§6.4；models-settings.md "卡上的 Fetch models"
 *        拉取后一行、"Add a model ID" id 错误一行）。前提：fake-old 在配置里、服务没列出，只在"Not listed by the server"
 *        一行里，不是清单的行；fake-coder 是 Added 的行。对照：没用过的 fake-typed-new 没有错误、Add to list 可用。
 *        最后清空输入框，不点 Add to list，清单的行不变。
 */
async function manualDuplicates(env) {
  const { page, userData } = env.ctx;
  const before = await cardState(page, 'cardp');
  const initial = await manualState(page, 'cardp');
  const configured = providerIn(configOf(userData), 'cardp')?.models.map((model) => model.id) ?? [];
  const old = await manualAfter(page, 'cardp', 'fake-old', DUPLICATE_ID);
  const coder = await manualAfter(page, 'cardp', 'fake-coder', DUPLICATE_ID);
  const fresh = await manualAfter(page, 'cardp', 'fake-typed-new', null);
  await typeManual(page, 'cardp', '');
  const after = await cardState(page, 'cardp');
  const rowIds = (state) => state?.rows.map((row) => row.id).join() ?? null;
  record('MD-08 card checklist: Add a model ID checks duplicates against the provider’s existing models — "fake-old" '
    + '(configured, not listed by the server, shown only in "Not listed by the server") shows "Model IDs must be '
    + 'unique within a provider." and Add to list is disabled', configured.includes('fake-old')
    && !before?.rows.some((row) => row.id === 'fake-old') && before?.notListed === 'Not listed by the server: fake-old'
    && initial?.text === '' && initial.error === null && initial.blocked === true && old?.error === DUPLICATE_ID
    && old.blocked === true,
  brief({ configured, rows: rowIds(before), notListed: before?.notListed, initial, old }));
  record('MD-08 card checklist: the id of an Added row (fake-coder) shows the same error with Add to list disabled; an '
    + 'unused id (fake-typed-new) shows no error and Add to list is available; no row is added',
  coder?.error === DUPLICATE_ID && coder.blocked === true && fresh?.error === null && fresh.blocked === false
    && rowIds(after) === rowIds(before), brief({ coder, fresh, before: rowIds(before), after: rowIds(after) }));
}

/**
 * @brief 列表错误时卡上没有清单的行，Add a model ID 的重复只能来自这个提供商已有的模型（§6.3、§6.4）：keyp 的
 *        fake-coder 显示重复、Add to list 不可用；对照：fake-extra（服务有、这个提供商没有）没有错误。最后清空输入框。
 */
async function manualOnListError(env) {
  const { page } = env.ctx;
  const before = await cardState(page, 'keyp');
  const coder = await manualAfter(page, 'keyp', 'fake-coder', DUPLICATE_ID);
  const extra = await manualAfter(page, 'keyp', 'fake-extra', null);
  await typeManual(page, 'keyp', '');
  record('MD-08 card list error (rejected): with no checklist rows, the provider’s model "fake-coder" typed in Add a '
    + 'model ID shows "Model IDs must be unique within a provider." and Add to list is disabled; "fake-extra" (not in '
    + 'the provider) shows no error', before?.listError?.kind === 'rejected' && before.rows.length === 0
    && coder?.error === DUPLICATE_ID && coder.blocked === true && extra?.error === null && extra.blocked === false,
  brief({ listError: before?.listError?.kind, rows: before?.rows.length, coder, extra }));
}

/** @brief 勾两个（先勾后一个），Add 2 models：models.addModels 加在已有模型之后、按清单顺序，并开始探针（§5.4）。 */
async function addTwo(env) {
  const { page, userData } = env.ctx;
  await discovered(page, 'cardp', 'fake-new-b').locator('input[name="pick"]').setChecked(true);
  await discovered(page, 'cardp', 'fake-new-a').locator('input[name="pick"]').setChecked(true);
  await discovered(page, 'cardp', 'fake-new-a').locator('input[data-field="reasoning"]').setChecked(true);
  const button = cardOf(page, 'cardp').locator('[data-action="add-models"]');
  const label = (await button.textContent())?.trim();
  const since = Date.now();
  await button.click();
  const closed = await poll(() => cardState(page, 'cardp'), (state) => state && !state.checklist
    && state.rows.length === 0 && state.models.length === 4, 20000);
  const rows = await Promise.all(['cardp/fake-new-a', 'cardp/fake-new-b'].map((ref) => modelRowState(page, ref)));
  const models = providerIn(configOf(userData), 'cardp')?.models ?? [];
  const ids = models.map((model) => model.id);
  record('MD-10 "Add 2 models" (models.addModels) closes the checklist and appends the picked models after the '
    + 'existing ones in checklist order; fake-old (not listed) is kept', label === 'Add 2 models' && closed.ok
    && ids.join() === 'fake-coder,fake-old,fake-new-a,fake-new-b'
    && closed.value.models.join() === ids.map((id) => `cardp/${id}`).join() && models[2]?.reasoning === true
    && closed.value.fetch?.disabled === false, brief({ label, ids, rows: closed.value?.models,
      fetch: closed.value?.fetch }));
  const done = await waitProfiles(page, ['cardp/fake-new-a', 'cardp/fake-new-b'], verified, 120000);
  const probes = ['fake-new-a', 'fake-new-b'].map((id) => probeLines(env.fakes.card, since, id).length);
  record('MD-10 the added models start probing at once: "Verifying…" on both rows (data-probe verifying, status line '
    + 'verifying), probe requests for each, then verified', rows.every((row) => row?.tool === 'verifying'
    && row.status === 'verifying') && probes.every((n) => n > 0) && done.ok,
  brief({ rows: rows.map((row) => [row?.tool, row?.status]), probes, done: done.ok }));
}

/** @brief Edit 里没设过强度的模型显示 config.get 的 defaultThinkingLevel；没改就不写（§5.4）。 */
async function editLevel(env) {
  const { page, userData } = env.ctx;
  await modelRow(page, 'cardp/fake-new-a').locator('[data-action="edit"]').click();
  const form = cardOf(page, 'cardp').getByTestId('model-form');
  await form.waitFor({ timeout: 10000 });
  const level = await form.getByLabel('Default effort for new sessions', { exact: true }).inputValue();
  const info = await modelsInfo(page);
  const config = await bridge(page, { type: 'config.get' });
  record('MD-10 Edit of a model with no saved thinking level shows config.get’s defaultThinkingLevel (High) in '
    + '"Default effort for new sessions"', level === 'high' && info?.thinkingDefaults?.['cardp/fake-new-a'] === null
    && config?.defaultThinkingLevel === 'high', brief({ level, saved: info?.thinkingDefaults?.['cardp/fake-new-a'],
    defaultThinkingLevel: config?.defaultThinkingLevel }));
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  await sleep(500);
  const after = (await modelsInfo(page))?.thinkingDefaults?.['cardp/fake-new-a'];
  record('MD-10 saving that Edit form without changing the level writes no thinking level for the model',
    savedThinking(userData, 'cardp/fake-new-a') === null && after === null,
    brief({ settings: savedThinking(userData, 'cardp/fake-new-a'), thinkingDefaults: after }));
}

/** @brief 经进程桥发一条命令；命令被拒（抛错）时返回 { error: 原文 }。 */
async function tryBridge(page, command) {
  try {
    return await bridge(page, command);
  } catch (error) {
    return { error: String(error?.message ?? error), thrown: true };
  }
}

/** @brief models.addModels 的重复 id 整次拒绝、配置不变；models.saveModel 不能加模型（§5.4，经进程桥）。 */
async function bridgeRejections(env) {
  const { page, userData } = env.ctx;
  const file = join(userData, 'model-config.json');
  const before = readText(file);
  const since = Date.now();
  const inProvider = await tryBridge(page, { type: 'models.addModels', providerId: 'cardp',
    models: [modelOf('fake-dup-x'), modelOf('fake-coder')] });
  const afterOne = readText(file);
  const twice = await tryBridge(page, { type: 'models.addModels', providerId: 'cardp',
    models: [modelOf('fake-dup-y'), modelOf('fake-dup-y')] });
  const afterTwo = readText(file);
  await sleep(800);
  const ids = providerIn((await modelsInfo(page))?.config, 'cardp')?.models.map((model) => model.id) ?? [];
  const probes = probeLines(env.fakes.card, since).length;
  record('MD-10 models.addModels with an id already in the provider rejects the whole command ("fake-coder is already '
    + 'in Card Provider.") and leaves the config unchanged (nothing added, no probe)', inProvider?.error
    === 'fake-coder is already in Card Provider.' && afterOne === before && !ids.includes('fake-dup-x') && probes === 0,
  brief({ result: inProvider, ids, probes, unchanged: afterOne === before }));
  record('MD-10 models.addModels with the same id twice in one command is rejected ("fake-dup-y is already in Card '
    + 'Provider.") and leaves the config unchanged', twice?.error === 'fake-dup-y is already in Card Provider.'
    && afterTwo === before && !ids.includes('fake-dup-y'), brief({ result: twice, unchanged: afterTwo === before }));
  const missing = await tryBridge(page, { type: 'models.saveModel', providerId: 'cardp',
    model: modelOf('fake-ghost') });
  const adding = await tryBridge(page, { type: 'models.saveModel', providerId: 'cardp', model: modelOf('fake-ghost-2'),
    adding: true });
  const afterSave = readText(file);
  const idsAfter = providerIn((await modelsInfo(page))?.config, 'cardp')?.models.map((model) => model.id) ?? [];
  record('MD-10 models.saveModel has no adding: saving a model that is not in the provider fails (also with '
    + '"adding: true") and adds nothing', typeof missing?.error === 'string' && missing.error.includes('fake-ghost')
    && typeof adding?.error === 'string' && adding.error.length > 0 && afterSave === before
    && !idsAfter.some((id) => id.startsWith('fake-ghost')), brief({ missing, adding, idsAfter }));
}

/** @brief 第一个 key 被限流（cardp）、被拒（keyp）时卡上的拉取用第二个（§5.1）。 */
async function keyChoice(env) {
  const { page } = env.ctx;
  const limited = await testKeyUntil(page, 'cardp', 'cardp#1', 'rate_limited');
  const second = await fetchOnCard(page, 'cardp');
  const lists = listLines(env.fakes.card, second.since);
  record(`MD-10 with the first key rate limited (key Test → 429), the card’s Fetch models uses the second key `
    + `…${last4(KEY.two)} (endpoint log)`, limited.ok && second.state?.checklist && lists.length === 1
    && lists[0].key === last4(KEY.two), brief({ limited: limited.value, lists }));
  await closeChecklist(page, 'cardp');
  const first = await fetchOnCard(page, 'keyp');
  const rejected = listLines(env.fakes.keyed, first.since);
  record(`MD-10 on keyp with no key record the first key …${last4(KEY.three)} is used; the server rejects it and the `
    + 'card shows the rejected list error', first.state?.listError?.kind === 'rejected' && rejected.length === 1
    && rejected[0].key === last4(KEY.three), brief({ listError: first.state?.listError, rejected }));
  // models-settings.md "清单开着时卡上的按钮"：清单或列表错误开着时卡上的 Fetch models 不可用；卡里没有 Detected
  record('MD-10 while the card’s list error is open (rejected), the card’s "Fetch models" is disabled and there is no '
    + '"Detected: …" line', first.state?.listError?.kind === 'rejected' && first.state.fetch?.disabled === true
    && first.state.detected === 0, brief({ fetch: first.state?.fetch, detected: first.state?.detected }));
  await manualOnListError(env);
  await closeChecklist(page, 'keyp');
  const auth = await testKeyUntil(page, 'keyp', 'keyp#1', 'auth');
  const retry = await fetchOnCard(page, 'keyp');
  const lists2 = listLines(env.fakes.keyed, retry.since);
  record(`MD-10 with the first key rejected (key Test → 401, auth record), the card’s Fetch models uses the second `
    + `key …${last4(KEY.four)} and gets the list`, auth.ok && retry.state?.checklist === true && !retry.state.listError
    && lists2.length === 1 && lists2[0].key === last4(KEY.four), brief({ auth: auth.value, lists2,
    rows: retry.state?.rows.map((row) => row.id) }));
  return retry.state;
}

/** @brief 已有提供商的 key 不回到界面（§5.1、§9）：拉取结果、models.get、页面 DOM 与输入框里都没有。 */
async function keyNeverShown(env) {
  const { page } = env.ctx;
  const dump = await pageDump(page);
  await closeChecklist(page, 'keyp');
  const since = Date.now();
  const result = await bridge(page, { type: 'models.discover', target: { kind: 'provider', providerId: 'keyp' } });
  const info = await modelsInfo(page);
  const hits = { result: secretsIn(JSON.stringify(result), SECRETS), info: secretsIn(JSON.stringify(info), SECRETS),
    page: secretsIn(dump, SECRETS) };
  const used = listLines(env.fakes.keyed, since).map((line) => line.key);
  record('MD-06 existing provider: models.discover (sent through the bridge) uses the key §5.1 picks — keyp’s first '
    + `key has an auth record, so its one list request carries the second key …${last4(KEY.four)} (endpoint log)`,
  result?.error === null && result.cancelled === false && same(used, [last4(KEY.four)]), brief({ used }));
  record('MD-06 existing provider: the saved key never comes back to the UI — the models.discover result, models.get '
    + 'and the page (DOM and input values, checklist open) contain no key', result?.error === null
    && result.models?.length > 0 && Object.values(hits).every((list) => list.length === 0),
  brief({ hits, used, keys: info?.config?.providers?.map((provider) => provider.keys) }));
}

/**
 * @brief 卡上正在进行的拉取被别处取消：新的一次发现（经进程桥）、打开别的表单（§5.3；实现时定的 A16）。
 * @return 第二次取消后卡上显示"Fetch cancelled"的时刻（cancelledStays 从这里算它留了多久）
 */
async function cancelledElsewhere(env) {
  const { page, logs } = env.ctx;
  const since = Date.now();
  await cardFetch(page, 'cardp').click();
  const sent = await poll(() => listLines(env.fakes.card, since).length > 0, Boolean, 5000);
  const other = await bridge(page, { type: 'models.discover', target: { kind: 'new', baseUrl: baseOf(PORT.keyed),
    api: null, keySecret: null } });
  const cancelled = await poll(() => cardState(page, 'cardp'), (state) => state?.status?.state === 'cancelled', 10000);
  await sleep(2000);
  const still = await cardState(page, 'cardp');
  record('MD-10 a new discover started elsewhere cancels the card’s running fetch: "Fetch cancelled" beside an enabled '
    + '"Fetch models", no checklist (still so after the list would have answered)', sent.ok
    && other?.cancelled === false
    && cancelled.ok && still?.status?.state === 'cancelled' && still.status.text === 'Fetch cancelled'
    && !still.checklist && !still.listError && still.fetch?.text === 'Fetch models' && still.fetch.disabled === false,
  brief({ other: other && { cancelled: other.cancelled, error: other.error }, status: still?.status,
    fetch: still?.fetch }));
  const from = logs.length;
  const again = Date.now();
  await cardFetch(page, 'cardp').click();
  const sentAgain = await poll(() => listLines(env.fakes.card, again).length > 0, Boolean, 5000);
  await page.locator('[data-action="add-provider"]').click();
  const closed = await poll(() => cardState(page, 'cardp'), (state) => state?.status?.state === 'cancelled', 10000);
  const cancelledAt = Date.now();
  const logged = await poll(() => logs.slice(from).join('').includes(`discover 127.0.0.1:${PORT.card} cancelled`),
    Boolean, 5000);
  await sleep(2000);
  const after = await cardState(page, 'cardp');
  record('MD-10 opening another form (Add provider) while the card fetches sends models.discoverCancel (the background '
    + 'process logs the cancelled discover) and the card shows "Fetch cancelled" without a checklist', sentAgain.ok
    && closed.ok && logged.ok && after?.status?.text === 'Fetch cancelled' && !after.checklist,
  brief({ status: after?.status, logged: logged.ok }));
  await page.getByTestId('provider-form').locator('[data-action="close-form"]').click();
  return cancelledAt;
}

/** @brief 卡上的拉取状态是"Fetch cancelled"。 */
const showsCancelled = (state) => state?.status?.state === 'cancelled' && state.status.text === 'Fetch cancelled';
/** "Fetch cancelled"至少要留这么久（从显示出来算起；比一闪而过的提示长，排除到时自动消失的写法） */
const CANCELLED_HOLD_MS = 8000;

/**
 * @brief 卡上的"Fetch cancelled"留到再点这张卡的 Fetch models，点了就清掉（实现时定的 A16；models-settings.md
 *        "本表定下的界面细节"）。接着 cancelledElsewhere：cardp 显示着"Fetch cancelled"，Add provider 表单刚点了关闭。
 *        Add provider 表单关掉、打开再关掉 keyp 卡上的清单（另一张卡的 Fetch models）都不清掉它，显示出来
 *        CANCELLED_HOLD_MS 之后也还在；再点 cardp 的 Fetch models：拉取中拉取的状态是 fetching、没有文字，清单打开后
 *        没有拉取的状态，关掉这张拉取完的清单后也没有，这三处卡里任何地方都没有"Fetch cancelled"这句。
 *        A16 的另一半"卡上拉取命令出错的原文留到再点 Fetch models"在这里造不出来，所以不检查：卡上的 models.discover
 *        （kind: 'provider'）只在配置读不出或提供商不存在时命令出错（kernel/modelCommands.ts 的 providerTarget），
 *        而卡只为最近一次 models.get 里的提供商显示：界面上删掉提供商（Delete…）成功后重新 models.get，卡随之消失；
 *        配置读不出时 Models 分节只显示读不出的说明，没有提供商卡。经进程桥在界面背后删掉提供商、留下一张过时的卡，
 *        是界面上走不到的状态，不拿它充当这条的检查。
 * @param cancelledAt cancelledElsewhere 返回的、卡上显示"Fetch cancelled"的时刻
 */
async function cancelledStays(env, cancelledAt) {
  const { page } = env.ctx;
  const formGone = await poll(() => page.getByTestId('provider-form').count(), (n) => n === 0, 10000);
  const afterForm = await cardState(page, 'cardp');
  const other = await fetchOnCard(page, 'keyp');
  const duringOther = await cardState(page, 'cardp');
  await closeChecklist(page, 'keyp');
  const afterOther = await cardState(page, 'cardp');
  await sleep(Math.max(0, cancelledAt + CANCELLED_HOLD_MS - Date.now()));
  const heldFor = Date.now() - cancelledAt;
  const held = await cardState(page, 'cardp');
  const states = [afterForm, duringOther, afterOther, held];
  record('MD-10 the card’s "Fetch cancelled" stays until that card’s Fetch models is clicked again: still shown after '
    + 'the Add provider form closes, while keyp’s checklist is open (another card’s Fetch models), after it closes '
    + `and ${CANCELLED_HOLD_MS / 1000} s after it appeared (A16)`, formGone.ok && other.state?.checklist === true
    && states.every(showsCancelled), brief({ formGone: formGone.ok, other: other.state?.checklist, heldFor,
    statuses: states.map((state) => state?.status) }));
  await cardFetch(page, 'cardp').click();
  const during = await cardState(page, 'cardp');
  const open = await poll(() => cardState(page, 'cardp'), (state) => state?.checklist, 20000);
  await closeChecklist(page, 'cardp');
  const closed = await cardState(page, 'cardp');
  const seen = [during, open.value, closed].map((state) => state?.cancelledText ?? null);
  record('MD-10 clicking the card’s Fetch models again clears "Fetch cancelled": right after the click fetch-status is '
    + 'fetching with no text, once the checklist opens there is no fetch-status, closing that loaded checklist '
    + 'shows none either, and none of the three has "Fetch cancelled" anywhere in the card (A16)',
  during?.status?.state === 'fetching' && during.status.text === '' && open.ok && open.value?.status === null
    && closed?.status === null && !closed.checklist && seen.every((text) => text === false),
  brief({ during: during?.status, open: open.value?.status, closed: closed?.status, seen }));
}

/** @brief card 一步：卡上的 Fetch models（MD-10）、已有提供商的 key（MD-06）、旧档案（MD-12）。 */
async function cardStep() {
  const fakes = {};
  let ctx;
  try {
    fakes.card = await startFake(PORT.card, { FAKE_MODELS: 'fake-coder,fake-new-a,fake-new-b',
      FAKE_LIMITED_KEYS: KEY.one, FAKE_LIST_DELAY_MS: '1500' });
    fakes.keyed = await startFake(PORT.keyed, { FAKE_MODELS: 'fake-coder,fake-extra', FAKE_KEYS: KEY.four });
    const { userData, profiles } = cardSetup();
    ctx = await startApp(userData, exePath);
    const env = { ctx, fakes, profiles };
    await oldProfilesKept(env);
    await addKeyBridge(ctx.page, 'cardp', 'Key 1', KEY.one);
    await addKeyBridge(ctx.page, 'cardp', 'Key 2', KEY.two);
    await addKeyBridge(ctx.page, 'keyp', 'Key 1', KEY.three);
    await addKeyBridge(ctx.page, 'keyp', 'Key 2', KEY.four);
    await openModels(ctx.page);
    await noAddModel(env);
    await openChecklist(env, await firstFetch(env));
    await manualDuplicates(env);
    await addTwo(env);
    await editLevel(env);
    await bridgeRejections(env);
    await keyChoice(env);
    await keyNeverShown(env);
    await cancelledStays(env, await cancelledElsewhere(env));
    record('MD-06 existing provider: no App log line (main, background process, page console) contains a saved key',
      secretsIn(ctx.logs.join('\n'), SECRETS).length === 0, brief(secretsIn(ctx.logs.join('\n'), SECRETS)));
  } catch (error) {
    record('MD-10 card step ran to the end', false, brief(error?.stack ?? error));
    await shot(ctx, 'card-error');
  } finally {
    recordPageErrors(ctx, 'MD-10', 'card');
    await closeApp(ctx);
    for (const fake of Object.values(fakes)) await stopFake(fake);
  }
}

// ---------- shapes：第 0 步的三种形状、读版本、localai 与 tensorrt（MD-12、MD-13） ----------

/** shapes 一步的提供商：id → [端口, 形状, 模型 id] */
const SHAPES = {
  sg: [PORT.sglang, 'sglang', ['sg-model']],
  olla: [PORT.ollama, 'ollama', ['olla-ps', 'olla-ctx', 'olla-train']],
  rich: [PORT.rich, 'rich', ['rich-a', 'rich-b']],
  lai: [PORT.localai, 'localai', ['lai-model']],
  trt: [PORT.tensorrt, 'tensorrt', ['trt-model']],
};
/** 没有档案、启动时跑探针的模型 */
const FRESH = ['sg/sg-model', 'olla/olla-ps', 'olla/olla-ctx', 'olla/olla-train', 'rich/rich-a', 'rich/rich-b'];
/** 旧档案写的是 vllm、读版本后认出种类变了的模型 */
const SWAPPED = ['lai/lai-model', 'trt/trt-model'];

/** @brief shapes 一步的数据目录（synthetic test setup）：五个提供商；localai、tensorrt 的模型有写着 vllm 的旧档案。 */
function shapesSetup() {
  const providers = Object.entries(SHAPES).map(([id, [port, , models]]) => providerOf(id, `Shape ${id}`, port,
    models.map((model) => modelOf(model))));
  const profiles = ['lai', 'trt'].map((id) => oldProfile(baseOf(SHAPES[id][0]), modelOf(SHAPES[id][2][0])));
  return { userData: seedUserData({ providers, profiles }), profiles };
}

/** @brief 档案文件里一个模型的 auto.meta。 */
const metaOf = (userData, id, model) => storedProfile(userData, baseOf(SHAPES[id][0]), model)?.auto.meta ?? null;
/** @brief 报告值里窗口以外的部分（对比 auto.meta）。 */
const metaPart = (reported) => reported && { maxTokens: reported.maxTokens, reasoning: reported.reasoning,
  image: reported.image };

/** @brief 第 0 步按形状读出的种类、版本、窗口与 meta（§7.1、§7.2）。 */
function shapeReads(env, views) {
  const { userData } = env;
  const reportedOf = (ref) => views[ref]?.reported ?? null;
  const metaOk = (ref) => {
    const [id, model] = ref.split('/');
    return same(metaOf(userData, id, model), metaPart(reportedOf(ref)));
  };
  const sg = views['sg/sg-model'];
  record('MD-12 step 0 reads the sglang shape through the reader: kind sglang, version 0.10.1 (/version), window '
    + '131,072, meta: max output not reported, thinking yes, image no (also in auto.meta)', sg?.server.kind === 'sglang'
    && sg.server.version === FAKE_VERSION && same(reportedOf('sg/sg-model'), { contextWindow: W, maxTokens: null,
    reasoning: true, image: false }) && metaOk('sg/sg-model'), brief({ server: sg?.server, reported: sg?.reported }));
  const olla = ['olla/olla-ps', 'olla/olla-ctx', 'olla/olla-train'];
  record('MD-12 step 0 reads the ollama shape: kind ollama, version 0.10.1 (/api/version); olla-ps window 8,192 '
    + '(/api/ps) with thinking, olla-ctx window 16,384 (num_ctx) without thinking; image no for all '
    + '(also in auto.meta)',
  olla.every((ref) => views[ref]?.server.kind === 'ollama' && views[ref].server.version === FAKE_VERSION
    && metaOk(ref)) && same(reportedOf(olla[0]), { contextWindow: 8192, maxTokens: null, reasoning: true,
    image: false }) && same(reportedOf(olla[1]), { contextWindow: 16384, maxTokens: null, reasoning: false,
    image: false }), brief(olla.map((ref) => ({ ref, server: views[ref]?.server, reported: reportedOf(ref) }))));
  const train = views['olla/olla-train'];
  record('MD-12 Ollama with only a trained window: olla-train’s reported window is null (reported.contextWindow and '
    + 'context.reported)', train?.reported !== null && train?.reported?.contextWindow === null
    && train.context.reported === null, brief({ reported: train?.reported, context: train?.context }));
  const rich = ['rich/rich-a', 'rich/rich-b'];
  record('MD-12 step 0 reads the rich shape: kind unknown; rich-a window 131,072, max output 8,192, thinking and image '
    + 'yes; rich-b thinking not reported, image no (also in auto.meta)', rich.every((ref) => views[ref]?.server.kind
    === 'unknown' && metaOk(ref)) && same(reportedOf(rich[0]), { contextWindow: W, maxTokens: RICH_MAX,
    reasoning: true, image: true }) && same(reportedOf(rich[1]), { contextWindow: W, maxTokens: RICH_MAX,
    reasoning: null, image: false }), brief(rich.map((ref) => ({ ref, server: views[ref]?.server,
    reported: reportedOf(ref) }))));
}

/**
 * @brief 第 0 步的单模型模式（§7.1）：Ollama 三个模型的第 0 步各只 POST 自己的 /api/show（共 3 个，不是每次都读全部
 *        3 个模型的），并读了 /api/tags 与 /api/ps。这一步第一次启动时没有发现命令、也没有读版本（模型都没有档案）。
 */
function ollamaSingle(env) {
  const paths = detailLines(env.fakes.olla, 0).map((line) => line.path);
  const count = (path) => paths.filter((item) => item === path).length;
  record('MD-12 step 0 reads Ollama’s details through the reader in single mode: three POST /api/show for the three '
    + 'models (one each, not every listed model per step 0), and /api/tags and /api/ps are read (endpoint log)',
  count('/api/show') === 3 && count('/api/tags') > 0 && count('/api/ps') > 0, brief(paths));
}

/**
 * @brief Ollama 报告的窗口让有效窗口变小（§7.2，看档案；2026-10-26 起模型行不列 Context）；只有训练窗口的那一行窗口是
 *        训练窗口、不是 Mori 的默认值，不标 (default)，也没有窗口的提示（§8）。
 */
async function ollamaWindows(env, views) {
  const { page } = env.ctx;
  const effective = (ref) => views[ref]?.context.effective;
  record('MD-12 an Ollama reported window lowers the effective window: configured 131,072 → olla-ps 8,192, olla-ctx '
    + '16,384 (profile); olla-train stays 131,072', effective('olla/olla-ps') === 8192
    && effective('olla/olla-ctx') === 16384 && effective('olla/olla-train') === W,
  brief({ effective: ['olla/olla-ps', 'olla/olla-ctx', 'olla/olla-train'].map(effective) }));
  const train = await modelRowState(page, 'olla/olla-train');
  record('MD-13 the Ollama model with only a trained window shows its window 131,072 without "(default)" (the trained '
    + 'window is not Mori’s default) and no "Server reports a context window" hint', Boolean(train?.meta?.includes(
    'Context window: 131,072 · ')) && same(train.defaults, []) && !train.hints.some((hint) => hint.kind === 'context'),
  brief(train));
}

/** @brief localai、tensorrt：读版本认出种类变了，各重新探测一次（§3.3、§7.2、§7.3）。 */
async function swappedKinds(env, swapped) {
  const { userData } = env.ctx;
  const views = swapped.value;
  const stored = env.profiles.map((seed) => storedProfile(userData, seed.baseUrl, seed.modelId));
  const probes = ['lai', 'trt'].map((id) => probeLines(env.fakes[id], 0).length);
  record('MD-12 the localai and tensorrt shapes with old profiles saying vllm are re-probed after the version read: '
    + 'kinds localai and tensorrt, version unknown, new probedAt, probe requests sent', swapped.ok
    && views['lai/lai-model']?.server.kind === 'localai' && views['trt/trt-model']?.server.kind === 'tensorrt'
    && SWAPPED.every((ref) => views[ref].server.version === 'unknown') && stored.every((item, i) => item
    && item.probedAt > env.profiles[i].probedAt && item.key.endsWith('|unknown')) && probes.every((n) => n > 0),
  brief({ servers: SWAPPED.map((ref) => views[ref]?.server), keys: stored.map((item) => item?.key), probes }));
}

/** @brief 重新启动后的读版本：每个提供商一次、不发 §4.2 的详情请求；localai、tensorrt 不再重新探测（§7.3）。 */
async function versionReads(env, since, kept) {
  const { fakes } = env;
  const reads = await poll(() => Object.values(fakes).every((fake) => listLines(fake, since).length > 0), Boolean,
    30000);
  await sleep(4000);
  const counts = Object.fromEntries(Object.entries(fakes).map(([id, fake]) => [id, listLines(fake, since).length]));
  record('MD-12 the version read at startup happens once per provider: one list request on each of the five '
    + 'endpoints (the ollama provider has three models)', reads.ok && Object.values(counts).every((n) => n === 1),
  brief(counts));
  const paths = (id) => detailLines(fakes[id], since).map((line) => line.path);
  const olla = paths('olla');
  const sg = paths('sg');
  const lai = paths('lai');
  const count = (list, path) => list.filter((item) => item === path).length;
  record('MD-12 the version read sends none of §4.2’s detail requests: ollama no /api/tags, /api/ps, /api/show '
    + '(/api/version once, from §3.3 step 6); sglang no /model_info (/version once); localai no /models/capabilities',
  !olla.some((path) => ['/api/tags', '/api/ps', '/api/show'].includes(path)) && count(olla, '/api/version') === 1
    && !sg.includes('/model_info') && count(sg, '/version') === 1
    && !lai.some((path) => path.endsWith('/models/capabilities')), brief({ olla, sg, lai }));
  const probes = Object.fromEntries(Object.entries(fakes).map(([id, fake]) => [id, probeLines(fake, since).length]));
  const stored = env.profiles.map((seed) => storedProfile(env.ctx.userData, seed.baseUrl, seed.modelId)?.probedAt);
  record('MD-12 localai and tensorrt are re-probed only once: after the next start no probe request reaches any '
    + 'endpoint and their profiles are unchanged', Object.values(probes).every((n) => n === 0) && kept.quiet
    && same(stored, kept.probedAt), brief({ probes, quiet: kept.quiet, stored, before: kept.probedAt }));
}

/** @brief shapes 一步。 */
async function shapesStep() {
  const fakes = {};
  let ctx;
  try {
    for (const [id, [port, shape, models]] of Object.entries(SHAPES)) {
      fakes[id] = await startFake(port, { FAKE_LIST_SHAPE: shape, FAKE_MODELS: models.join(',') });
    }
    const { userData, profiles } = shapesSetup();
    ctx = await startApp(userData, exePath);
    const env = { ctx, userData, fakes, profiles };
    const fresh = await waitProfiles(ctx.page, FRESH, verified, 180000);
    const swapped = await waitProfiles(ctx.page, SWAPPED, (view) => verified(view) && view.server.kind !== 'vllm',
      120000);
    await openModels(ctx.page);
    shapeReads(env, fresh.value);
    ollamaSingle(env);
    await ollamaWindows(env, fresh.value);
    await swappedKinds(env, swapped);
    // 第一次启动的探针都跑完后再等一会：localai、tensorrt 不会再被重新探测
    const settled = Date.now();
    await sleep(3000);
    const quiet = ['lai', 'trt'].every((id) => probeLines(fakes[id], settled).length === 0);
    const probedAt = profiles.map((seed) => storedProfile(userData, seed.baseUrl, seed.modelId)?.probedAt);
    recordPageErrors(ctx, 'MD-12', 'shapes, first start');
    await closeApp(ctx);
    ctx = null;
    const since = Date.now();
    ctx = await startApp(userData, exePath);
    env.ctx = ctx;
    await versionReads(env, since, { quiet, probedAt });
  } catch (error) {
    record('MD-12 shapes step ran to the end', false, brief(error?.stack ?? error));
    await shot(ctx, 'shapes-error');
  } finally {
    recordPageErrors(ctx, 'MD-12', 'shapes');
    await closeApp(ctx);
    for (const fake of Object.values(fakes)) await stopFake(fake);
  }
}

// ---------- batch：一次加入 3 个模型（MD-12） ----------

/** batch 一步新加入的三个模型（合成端点 ollama 形状：第二个有 num_ctx，其余只有训练窗口） */
const BATCH = ['olla-two', 'olla-three', 'olla-four'];

/**
 * @brief 一次加入 3 个：三个第 0 步只读一次列表；期间点 Fetch models 再点 Cancel 不取消探针（§5.3、§5.4、§7.1）。
 *        端点的列表请求要等 4 秒，点 Fetch models 和它的 Cancel 时三个第 0 步都还在等列表；之后它们各自 POST
 *        /api/show（单模型模式，§7.1）。从加入到最后一个 /api/show 只有一个列表请求（不算卡上拉取的那一小段时间），
 *        说明三个第 0 步等的是同一次列表；/api/show 都在 Cancel 之后，说明取消拉取没有取消它们。/api/show 一共 3 个，
 *        说明卡上被取消的拉取没有接着读详情（它会对 4 个模型各 POST 一次）。
 */
async function batchAdd(env) {
  const { page, userData } = env.ctx;
  const { fake } = env;
  const open = await fetchOnCard(page, 'olld');
  for (const id of BATCH) await discovered(page, 'olld', id).locator('input[name="pick"]').setChecked(true);
  const button = cardOf(page, 'olld').locator('[data-action="add-models"]');
  const label = (await button.textContent())?.trim();
  const added = Date.now();
  await button.click();
  const closed = await poll(() => cardState(page, 'olld'), (state) => state && !state.checklist
    && state.models.length === 4, 20000);
  const listed = await poll(() => listLines(fake, added).length > 0, Boolean, 5000);
  await sleep(800);
  const clicked = Date.now();
  await cardFetch(page, 'olld').click();
  const fetching = await poll(() => cardState(page, 'olld'), (state) => state?.status?.state === 'fetching'
    && state.cancel, 3000);
  const during = await Promise.all(BATCH.map((id) => modelRowState(page, `olld/${id}`)));
  await cardOf(page, 'olld').locator('[data-action="fetch-cancel"]').click();
  const cancelAt = Date.now();
  const cancelled = await poll(() => cardState(page, 'olld'), (state) => state?.status?.state === 'cancelled', 10000);
  const refs = BATCH.map((id) => `olld/${id}`);
  const done = await waitProfiles(page, refs, verified, 120000);
  const shows = detailLines(fake, added, '/api/show');
  const lastShow = shows.length ? Math.max(...shows.map((line) => line.t)) : Date.now();
  // 卡上的拉取只在 [clicked, cancelAt] 这一段里；其余时间到最后一个 /api/show 的列表请求都来自三个第 0 步
  const stepLists = listLines(fake, added).filter((line) => line.t <= lastShow
    && (line.t < clicked || line.t > cancelAt));
  const since = (line) => line.t - added;
  record('MD-12 adding 3 models at once reads the model list once for their three step 0s: from "Add 3 models" to the '
    + 'last of their three POST /api/show there is one list request on the endpoint (the card’s fetch aside)',
  open.state?.checklist === true && label === 'Add 3 models' && closed.ok && listed.ok && shows.length === 3
    && stepLists.length === 1, brief({ label, lists: listLines(fake, added).map(since), stepLists: stepLists.map(since),
    shows: shows.map(since), clicked: clicked - added, cancelAt: cancelAt - added }));
  const views = done.value;
  const metas = BATCH.map((id) => storedProfile(userData, env.baseUrl, id)?.auto.meta ?? null);
  record('MD-12 clicking Fetch models and then its Cancel during those probes’ step 0 does not cancel them: the three '
    + 'step 0s post /api/show after the Cancel, all three finish Verified and every profile has kind ollama and meta '
    + '(olla-two window 16,384, the others trained → null)',
  fetching.ok && cancelled.ok && during.every((row) => row?.tool === 'verifying') && shows.length === 3
    && shows.every((line) => line.t > cancelAt) && done.ok
    && refs.every((ref) => views[ref].server.kind === 'ollama' && views[ref].reported !== null)
    && metas.every((meta) => meta !== null) && views[refs[0]].reported.contextWindow === 16384
    && views[refs[1]].reported.contextWindow === null && views[refs[2]].reported.contextWindow === null,
  brief({ fetching: fetching.ok, cancelled: cancelled.value?.status, during: during.map((row) => row?.tool),
    showsAfterCancel: shows.map((line) => line.t - cancelAt), servers: refs.map((ref) => views[ref]?.server),
    reported: refs.map((ref) => views[ref]?.reported), metas }));
}

/** @brief batch 一步：ollama 形状的提供商（列表请求等 4 秒）已有 olla-base（旧档案），卡上一次加入另外三个。 */
async function batchStep() {
  let fake;
  let ctx;
  try {
    fake = await startFake(PORT.batch, { FAKE_LIST_SHAPE: 'ollama', FAKE_MODELS: ['olla-base', ...BATCH].join(','),
      FAKE_LIST_DELAY_MS: '4000' });
    const base = modelOf('olla-base');
    const baseUrl = baseOf(PORT.batch);
    const userData = seedUserData({ providers: [providerOf('olld', 'Ollama batch', PORT.batch, [base])],
      profiles: [oldProfile(baseUrl, base, { kind: 'ollama', reported: 8192 })] });
    ctx = await startApp(userData, exePath);
    // 启动时的读版本（§7.3，列表要等 4 秒）读完再开始，免得算进加入后的列表请求
    await poll(() => listLines(fake).length > 0, Boolean, 20000);
    await sleep(5000);
    await openModels(ctx.page);
    await batchAdd({ ctx, fake, baseUrl });
  } catch (error) {
    record('MD-12 batch step ran to the end', false, brief(error?.stack ?? error));
    await shot(ctx, 'batch-error');
  } finally {
    recordPageErrors(ctx, 'MD-12', 'batch');
    await closeApp(ctx);
    await stopFake(fake);
  }
}

// ---------- hints：模型行的提示（MD-13） ----------

/**
 * hints 一步的提供商：id → [端口, 合成端点的环境变量, 模型, 接口]。hv 的服务报告窗口 65,536、不报告输出上限；
 * hr 是 rich 形状（窗口 131,072、输出 8,192，第一行有思考与图片）；ht 是 typed 形状（窗口、输出都不报告）；
 * hk 是 rich 形状、只有一个总在思考的模型（服务报告思考，探针记下推理字段）；hp 是 OpenAI Responses 接口的提供商，
 * 它的模型用旧档案（合成端点没有 /v1/responses，所以不让它探测）：推理字段 native，同探针对 openai-completions
 * 以外的接口记下的（kernel/modelProfiles.ts），不是 none。
 */
const HINTS = {
  hv: [PORT.hintsVllm, { FAKE_MAX_MODEL_LEN: '65536' }, [modelOf('win-big', { maxTokens: 65536 }),
    modelOf('seen-alwaysthink', { contextWindow: 65536, maxTokens: 16384 }),
    modelOf('old-think', { contextWindow: 100000, maxTokens: 8192 })]],
  hr: [PORT.hintsRich, { FAKE_LIST_SHAPE: 'rich' }, [modelOf('rich-a', { maxTokens: 16384 }), modelOf('rich-b'),
    modelOf('rich-c', { contextWindow: 4096, maxTokens: 2048 })]],
  ht: [PORT.hintsTyped, { FAKE_LIST_SHAPE: 'typed' }, [modelOf('typed-a', { contextWindow: 128000,
    maxTokens: 16384 })]],
  hk: [PORT.hintsThink, { FAKE_LIST_SHAPE: 'rich' }, [modelOf('think-alwaysthink')]],
  hp: [PORT.hintsResponses, {}, [modelOf('resp-model')], 'openai-responses'],
};
/** 启动时探测的模型（old-think、resp-model 用旧档案） */
const HINTED = ['hv/win-big', 'hv/seen-alwaysthink', 'hr/rich-a', 'hr/rich-b', 'hr/rich-c', 'ht/typed-a',
  'hk/think-alwaysthink'];
/** 用旧档案的模型（没有 meta；推理字段 reasoning_content、native） */
const OLD_HINTED = ['hv/old-think', 'hp/resp-model'];
/** 提示的文字（§8，数字按千分位） */
const HINT_TEXT = {
  context: (n) => `Server reports a context window of ${n}.`,
  maxOutput: (n) => `Server reports max output of ${n}.`,
  reasoning: 'The server says this model supports thinking.',
  seen: 'This model returned thinking content.',
  image: 'The server says this model accepts images.',
};

/**
 * @brief hints 一步的数据目录（synthetic test setup）：old-think 与 resp-model 有旧档案（没有 meta；推理字段
 *        reasoning_content、native）。
 */
function hintsSetup() {
  const providers = Object.entries(HINTS).map(([id, [port, , models, api]]) => providerOf(id, `Hints ${id}`, port,
    models, api));
  const profiles = [
    oldProfile(baseOf(PORT.hintsVllm), HINTS.hv[2][2], { reported: 65536, field: 'reasoning_content' }),
    oldProfile(baseOf(PORT.hintsResponses), HINTS.hp[2][0], { reported: W, field: 'native',
      api: 'openai-responses' }),
  ];
  return { userData: seedUserData({ providers, profiles }), profiles };
}

/** @brief 一行的提示（data-kind 的列表）与某一种的文字。 */
const kindsOf = (row) => row?.hints.map((hint) => hint.kind) ?? null;
const hintText = (row, kind) => row?.hints.find((hint) => hint.kind === kind)?.text ?? null;

/** 模型行"(default)"的悬停说明（models-settings.md "Models 行"，2026-10-26 负责人走查 M6） */
const DEFAULT_TITLE = 'The server didn’t report this, so Mori used a default. Use Edit to set the real value.';

/** @brief 没报告、值仍是默认值的窗口与输出写 (default)，只标这样的那一项（§8，2026-10-26 改）。 */
function defaultRows(rows) {
  const typed = rows['ht/typed-a'];
  record('MD-13 a model whose server reports neither window nor max output and keeps the defaults shows "Context '
    + 'window: 128,000 (default)" and "Max output: 16,384 (default)", each with the hover explanation',
  Boolean(typed?.meta?.includes('Context window: 128,000 (default)') && typed.meta.includes('Max output: 16,384 '
    + '(default)')) && same(typed.defaults, ['contextWindow', 'maxTokens'])
    && typed.defaultTitles.every((title) => title === DEFAULT_TITLE), brief(typed));
  const [seen, win, richB] = ['hv/seen-alwaysthink', 'hv/win-big', 'hr/rich-b'].map((ref) => rows[ref]);
  record('MD-13 "(default)" marks only unreported values that still equal the default: seen-alwaysthink only Max '
    + 'output (16,384 is the default for its reported 65,536 window); win-big nothing (its unreported Max output is '
    + '65,536, not the default); rich-b nothing (both reported)', same(seen?.defaults, ['maxTokens'])
    && Boolean(seen.meta?.includes('Max output: 16,384 (default)')) && same(win?.defaults, [])
    && Boolean(win.meta?.includes('Max output: 65,536 · ') || win.meta?.endsWith('Max output: 65,536'))
    && same(richB?.defaults, []), brief({ seen: seen && [seen.meta, seen.defaults], win: win && [win.meta,
    win.defaults], richB: richB && [richB.meta, richB.defaults] }));
}

/**
 * @brief 用 Edit 改了默认的 Max output 之后不再标 (default)，窗口仍是默认值的照标（§8，2026-10-26：只在值仍是默认值时标）。
 *        typed-a 的 Max output 改成 8,000，Save 后等配置与行。
 */
async function defaultAfterEdit(env) {
  const { page, userData } = env.ctx;
  await modelRow(page, 'ht/typed-a').locator('[data-action="edit"]').click();
  const form = cardOf(page, 'ht').getByTestId('model-form');
  await form.waitFor({ timeout: 10000 });
  await form.getByLabel('Max output', { exact: true }).fill('8000');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const saved = await poll(() => providerIn(configOf(userData), 'ht')?.models[0]?.maxTokens, (value) => value === 8000,
    10000);
  const row = await poll(() => modelRowState(page, 'ht/typed-a'), (state) => same(state?.defaults, ['contextWindow']),
    10000);
  record('MD-13 after Edit sets typed-a’s Max output to 8,000 its "(default)" goes away; the window, still 128,000, '
    + 'keeps it', saved.ok && row.ok && Boolean(row.value.meta?.includes('Max output: 8,000 ·')
    || row.value.meta?.endsWith('Max output: 8,000')), brief({ saved: saved.value, row: row.value }));
  await defaultBack(env);
}

/**
 * @brief 改回默认值又标（models-settings.md “Models 行”的“默认值”，2026-10-26 补）：再用 Edit 把 typed-a 的 Max output 改回
 *        16,384（窗口 128,000 时的默认值），Save 后这一项又写“(default)”，悬停说明照旧。
 */
async function defaultBack(env) {
  const { page, userData } = env.ctx;
  await modelRow(page, 'ht/typed-a').locator('[data-action="edit"]').click();
  const form = cardOf(page, 'ht').getByTestId('model-form');
  await form.waitFor({ timeout: 10000 });
  await form.getByLabel('Max output', { exact: true }).fill('16384');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const saved = await poll(() => providerIn(configOf(userData), 'ht')?.models[0]?.maxTokens,
    (value) => value === 16384, 10000);
  const row = await poll(() => modelRowState(page, 'ht/typed-a'), (state) => same(state?.defaults,
    ['contextWindow', 'maxTokens']), 10000);
  record('MD-13 setting typed-a’s Max output back to the default 16,384 with Edit shows "Max output: 16,384 (default)" '
    + 'again, with the hover explanation', saved.ok && row.ok
    && Boolean(row.value.meta?.includes('Max output: 16,384 (default)'))
    && row.value.defaultTitles.every((title) => title === DEFAULT_TITLE),
  brief({ saved: saved.value, row: row.value }));
}

/** @brief §8 表五行的显示条件（正反两面）与顺序。 */
function hintConditions(rows) {
  const [win, seen, richA, richB, richC] = ['hv/win-big', 'hv/seen-alwaysthink', 'hr/rich-a', 'hr/rich-b',
    'hr/rich-c'].map((ref) => rows[ref]);
  record('MD-13 hint row 1 "Server reports a context window of <N>." shows when the reported window differs from the '
    + 'config (win-big 65,536, rich-c 131,072), not when equal (rich-a, rich-b)', hintText(win, 'context')
    === HINT_TEXT.context('65,536') && hintText(richC, 'context') === HINT_TEXT.context('131,072')
    && !kindsOf(richA)?.includes('context') && !kindsOf(richB)?.includes('context'),
  brief({ win: win?.hints, richC: richC?.hints }));
  record('MD-13 hint row 2 "Server reports max output of 8,192." shows when it differs and is below the configured '
    + 'window (rich-a); not when equal (rich-b) nor when it is not below the window (rich-c: 8,192 ≥ 4,096)',
  hintText(richA, 'max-output') === HINT_TEXT.maxOutput('8,192') && !kindsOf(richB)?.includes('max-output')
    && !kindsOf(richC)?.includes('max-output'), brief({ richA: richA?.hints, richC: richC?.hints }));
  record('MD-13 hint row 3 "The server says this model supports thinking." shows when the server reports thinking and '
    + 'it is not ticked (rich-a); not when thinking is not reported (rich-b)', hintText(richA, 'reasoning')
    === HINT_TEXT.reasoning && !kindsOf(richB)?.includes('reasoning'), brief(richA?.hints));
  record('MD-13 hint row 4 "This model returned thinking content." shows on the -alwaysthink model (reasoning field '
    + 'seen, thinking not reported, not ticked); not on win-big (field none)', same(kindsOf(seen), ['thinking-seen'])
    && hintText(seen, 'thinking-seen') === HINT_TEXT.seen && !kindsOf(win)?.includes('thinking-seen'),
  brief({ seen: seen?.hints, win: win?.hints }));
  record('MD-13 hint row 5 "The server says this model accepts images." shows when the server reports images and '
    + 'Image input is off (rich-a); not when images are reported as no (rich-b)', hintText(richA, 'image')
    === HINT_TEXT.image && !kindsOf(richB)?.includes('image') && same(kindsOf(richB), []), brief(richA?.hints));
  record('MD-13 the hints of a row follow the table order, each with its own Use (rich-a: max output, thinking, image)',
    same(kindsOf(richA), ['max-output', 'reasoning', 'image']) && richA.hints.every((hint) => hint.use),
    brief(richA?.hints));
}

/**
 * @brief §8 表各行不该显示的另外几种情形：服务什么都没报告的模型没有提示（第二行的"reported.maxTokens 不为 null"等）；
 *        第四行在服务报告了思考时不显示（换成第三行）、接口不是 openai-completions 时不显示。前提先成立：
 *        think-alwaysthink 的档案记着推理字段 reasoning_content；resp-model 的档案推理字段是 native（不是 none，只有接口
 *        这一条挡住第四行），旧档案没有被重新探测。
 */
function hintAbsences(env, rows, views) {
  const typed = views['ht/typed-a'];
  record('MD-13 a model whose server reports none of window, max output, thinking or image shows no hint row '
    + '(typed-a: every reported value null)', same(typed?.reported, { contextWindow: null, maxTokens: null,
    reasoning: null, image: null }) && same(kindsOf(rows['ht/typed-a']), []),
  brief({ reported: typed?.reported, hints: rows['ht/typed-a']?.hints }));
  const think = views['hk/think-alwaysthink'];
  const resp = views['hp/resp-model'];
  const seeded = env.profiles[1];
  const respProbes = probeLines(env.fakes.hp, 0).length;
  record('MD-13 hint row 4 does not show when the server reports thinking (think-alwaysthink: reasoning field '
    + 'reasoning_content and reported thinking → rows 3 and 5 only) nor on an OpenAI Responses provider '
    + '(resp-model: reasoning field native, not none, thinking not ticked → no hint)',
  think?.reasoning.field === 'reasoning_content' && think.reported?.reasoning === true
    && same(kindsOf(rows['hk/think-alwaysthink']), ['reasoning', 'image']) && verified(resp)
    && resp.reasoning.field === 'native' && resp.probedAt === seeded.probedAt && respProbes === 0
    && same(kindsOf(rows['hp/resp-model']), []),
  brief({ think: think && { field: think.reasoning.field, reported: think.reported },
    thinkHints: kindsOf(rows['hk/think-alwaysthink']), resp: resp && { field: resp.reasoning.field,
      probedAt: resp.probedAt }, seeded: seeded.probedAt, respProbes,
    respHints: kindsOf(rows['hp/resp-model']) }));
}

/** @brief 旧档案（没有 meta）只显示第四行、没有 (default)（§8）。 */
function oldProfileHints(rows, views) {
  const old = rows['hv/old-think'];
  const view = views['hv/old-think'];
  record('MD-13 an old profile without meta shows only hint row 4 and no "(default)" (old-think: reported null, '
    + 'although the old profile’s window 65,536 differs from the configured 100,000)', same(kindsOf(old),
    ['thinking-seen']) && same(old?.defaults, []) && view?.reported === null && view?.context.reported === 65536,
  brief({ row: old, reported: view?.reported, context: view?.context }));
}

/**
 * @brief 点一行某条提示的 Use：等配置里这个模型变了、重新探测完（probedAt 变新），返回改后的模型、探针请求数、
 *        这条提示还在不在、pi 设置里有没有写这个模型的思考强度（§8：Use 不带 thinkingLevel）。
 */
async function useHint(env, ref, kind) {
  const { page, userData } = env.ctx;
  const [providerId, id] = ref.split('/');
  const fake = env.fakes[providerId];
  const modelNow = () => providerIn(configOf(userData), providerId)?.models.find((model) => model.id === id) ?? null;
  const before = modelNow();
  const probedAt = (await modelsInfo(page))?.profiles?.[ref]?.probedAt ?? 0;
  const since = Date.now();
  await modelRow(page, ref).locator(`[data-testid="model-hint"][data-kind="${kind}"] [data-action="use-reported"]`)
    .click();
  const saved = await poll(modelNow, (model) => model && !same(model, before), 15000);
  const probed = await waitProfiles(page, [ref], (view) => verified(view) && view.probedAt > probedAt, 120000);
  const row = await poll(() => modelRowState(page, ref), (state) => state && !kindsOf(state).includes(kind), 10000);
  return { model: saved.value, saved: saved.ok, reprobed: probed.ok, probes: probeLines(fake, since, id).length,
    gone: row.ok, hints: kindsOf(row.value), level: savedThinking(userData, ref) };
}

/** @brief 一次 Use 的共同条件：立即保存、重新探测（有新的探针请求与新档案）、这条提示消失。 */
const usedOk = (use) => use.saved && use.reprobed && use.probes > 0 && use.gone;

/** @brief 五种提示的 Use：改动、立即保存、重新探测（§8）。 */
async function hintUses(env) {
  const win = await useHint(env, 'hv/win-big', 'context');
  record('MD-13 Use on "Server reports a context window of 65,536." saves at once: window 65,536 and Max output '
    + 'lowered from 65,536 to 16,384; the model is re-probed and the hint goes away', usedOk(win)
    && win.model.contextWindow === 65536 && win.model.maxTokens === 16384, brief(win));
  const max = await useHint(env, 'hr/rich-a', 'max-output');
  record('MD-13 Use on "Server reports max output of 8,192." saves Max output 8,192 (window unchanged); re-probed, '
    + 'hint gone', usedOk(max) && max.model.maxTokens === RICH_MAX && max.model.contextWindow === W, brief(max));
  const reasoning = await useHint(env, 'hr/rich-a', 'reasoning');
  record('MD-13 Use on "The server says this model supports thinking." ticks Supports thinking without writing a '
    + 'thinking level; re-probed, hint gone', usedOk(reasoning) && reasoning.model.reasoning === true
    && reasoning.level === null, brief(reasoning));
  const image = await useHint(env, 'hr/rich-a', 'image');
  record('MD-13 Use on "The server says this model accepts images." turns Image input on (input text + image); '
    + 're-probed, hint gone', usedOk(image) && same(image.model.input, ['text', 'image']), brief(image));
  const seen = await useHint(env, 'hv/seen-alwaysthink', 'thinking-seen');
  record('MD-13 Use on "This model returned thinking content." ticks Supports thinking (no thinking level written); '
    + 're-probed, hint gone', usedOk(seen) && seen.model.reasoning === true && seen.level === null
    && same(seen.hints, []), brief(seen));
  // §8 第一行的另一支：原来的 Max output 小于 N 时不改它；窗口变大后服务报告的 8,192 小于新窗口，第二行因此出现
  const wider = await useHint(env, 'hr/rich-c', 'context');
  record('MD-13 Use on "Server reports a context window of 131,072." when Max output (2,048) is below it saves window '
    + '131,072 and keeps Max output 2,048; re-probed, hint gone, and "Server reports max output of 8,192." now shows',
  usedOk(wider) && wider.model.contextWindow === W && wider.model.maxTokens === 2048
    && same(wider.hints, ['max-output']), brief(wider));
}

/**
 * @brief pi 设置里没有 defaultThinkingLevel 时（hints 一步的 pi/settings.json 为 {}），Edit 里没设过强度、勾了 Supports
 *        thinking 的模型（rich-a，Use 勾上的）显示 Medium（§5.4"没有时 Medium"）；点 Cancel 关掉，不写。
 */
async function editMedium(env) {
  const { page, userData } = env.ctx;
  await modelRow(page, 'hr/rich-a').locator('[data-action="edit"]').click();
  const form = cardOf(page, 'hr').getByTestId('model-form');
  await form.waitFor({ timeout: 10000 });
  const select = form.getByLabel('Default effort for new sessions', { exact: true });
  const level = await select.inputValue();
  const shown = (await select.locator('option:checked').textContent())?.trim();
  const saved = (await modelsInfo(page))?.thinkingDefaults?.['hr/rich-a'];
  const config = await bridge(page, { type: 'config.get' });
  const piSettings = readJson(join(userData, 'pi', 'settings.json'));
  record('MD-10 with no defaultThinkingLevel in the pi settings, Edit of a model with no saved thinking level shows '
    + '"Medium" in "Default effort for new sessions" (config.get gives medium)', level === 'medium'
    && shown === 'Medium' && saved === null && config?.defaultThinkingLevel === 'medium'
    && piSettings?.defaultThinkingLevel === undefined,
  brief({ level, shown, saved, defaultThinkingLevel: config?.defaultThinkingLevel, piSettings }));
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief hints 一步。 */
async function hintsStep() {
  const fakes = {};
  let ctx;
  try {
    for (const [id, [port, extra, models]] of Object.entries(HINTS)) {
      fakes[id] = await startFake(port, { ...extra, FAKE_MODELS: models.map((model) => model.id).join(',') });
    }
    const { userData, profiles } = hintsSetup();
    ctx = await startApp(userData, exePath);
    const env = { ctx, fakes, profiles };
    const ready = await waitProfiles(ctx.page, HINTED, verified, 180000);
    const seenField = ready.value['hv/seen-alwaysthink']?.reasoning.field;
    if (!ready.ok || seenField !== 'reasoning_content') {
      record('MD-13 (setup) the hint models finish probing; the -alwaysthink model records a reasoning field', false,
        brief({ ok: ready.ok, seenField }));
    }
    await openModels(ctx.page);
    const refs = [...HINTED, ...OLD_HINTED];
    const rows = Object.fromEntries(await Promise.all(refs.map(async (ref) => [ref, await modelRowState(ctx.page,
      ref)])));
    const views = (await modelsInfo(ctx.page))?.profiles ?? {};
    defaultRows(rows);
    hintConditions(rows);
    hintAbsences(env, rows, views);
    oldProfileHints(rows, views);
    await defaultAfterEdit(env);
    await hintUses(env);
    await editMedium(env);
  } catch (error) {
    record('MD-13 hints step ran to the end', false, brief(error?.stack ?? error));
    await shot(ctx, 'hints-error');
  } finally {
    recordPageErrors(ctx, 'MD-13', 'hints');
    await closeApp(ctx);
    for (const fake of Object.values(fakes)) await stopFake(fake);
  }
}

// ---------- 入口 ----------

const STEPS = { card: cardStep, shapes: shapesStep, batch: batchStep, hints: hintsStep };
for (const [name, run] of Object.entries(STEPS)) {
  if (only && !only.includes(name)) continue;
  console.log(`[md-app-card] ${name}`);
  await run();
}
// key 只在 card 一步里加；检查名与 detail 里都没有它（detail 里只有端点日志的末 4 位）
if (!only || only.includes('card')) {
  const leaked = secretsIn(JSON.stringify(results), SECRETS);
  record('MD-06 existing provider: no saved key in this suite’s results (check names and details)',
    leaked.length === 0, brief(leaked));
}
const ok = write(RESULT);
console.log(`[md-app-card] results in test-results/${RESULT}`);
process.exitCode = ok ? 0 : 1;
