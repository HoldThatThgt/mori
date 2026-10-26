// MP-27 真实模型走查（docs/specs/model-providers.md §14.1、§14.2）：真正的 Mori 对两个真实提供商（默认 DeepSeek 与 GLM），
// 全部经界面操作。准备与故障的做法见 v1-real-helpers.mjs（§14.1）：复制负责人的数据目录（只复制加密的文件，不读 key），
// 在复制出的 model-config.json 里建分组 [首选, 第二] 作为默认范围（synthetic test setup），
// 首选提供商 key 的密文另存到备用 ref。走查：
//   1. 两个真实模型的探针结果合理（models.get 的档案；设置 → Models 的档案摘要）。
//   2. 正常对话：首选回答，没有换模型提示、没有错误卡。
//   3. 段开始时换模型：在设置 → Models 里给首选加错的 key（sk-invalid）、删掉原来的 key，再发消息：真实的 401，同一个请求
//      发给第二个，对话流一行"Switched model: A → B · API key rejected"，没有错误卡。
//   4. 退出，把首选的 key 改指备用 ref，重新启动，打开同一个会话：下一段用回首选。
//   5. 段内换模型：让模型一个一个读五个文件，回复开始后照 3 换 key：段内换到第二个并重做（提示带
//      "The new model redoes this response."），之前的工具卡仍显示，没有错误卡。
//   6. 再照 4 恢复并重新启动：重新打开后换模型提示仍在，下一段用回首选。
// 每一步的实际模型从会话文件里助手消息的 provider / model 读（包装后的流函数原样转发实际模型的消息，§11.2）。
// MP-40 真实的思考关不掉的模型（§7.7，§14.1 的 2026-10-24 补，§14.2 MP-40），在 MP-27 的步骤之后、同一次启动里走，
// 结果写进同一个 v1-models-real.json（检查名以 "MP-40" 开头）：
//   0. OpenRouter 的提供商从复制出的数据目录里找（名称或地址含 openrouter，同 md-real-helpers.mjs 的找法），要有保存的
//      key；找不到时用环境变量 MP_REAL_OPENROUTER_KEY（由运行它的人从 openrouter.env 读出、不打印；脚本一启动
//      就读进内存并从 process.env 删掉，之后启动的 Mori 拿不到）经 Add provider 加入；两样都没有时 MP-40 停下来报告
//      （同 MP-27）。复制出的配置里已经有 recursive/flint-v1.0:free 或 liquid/lfm-2.5-2.6b:free 时先删掉（synthetic test
//      setup，连同复制出的档案里它们的档案，见 v1-real-helpers.mjs prepareNoOff）。
//   1. 设置 → Models：卡上的 Fetch models（或 Add provider：https://openrouter.ai/api/v1，key 只输进 Mori 的密码框，输入前
//      核对框的 type 是 password）→ 过滤、勾上两个模型 → Add 2 models。
//   2. 等它们的探针跑完：flint 档案 ready、tool_calling verified、off_refused 为真，模型行说明一行末尾有 " · Thinking can’t be turned off"；
//      lfm tool_calling verified、off_refused 为真，等级 B 或第 6 步出错为 "Stopped at the probe output limit before
//      answering"（只能是出错，不能是不通过；§14.2 MP-40 的 2026-10-24 负责人改）。
//   3. 经进程桥对 flint 发 connection.test（测试连接，2026-10-26 起模型行没有 Test）成功。
//   4. 原来是 Off 的会话：新会话在默认范围里由首选（DeepSeek，有 Off 的模型）开始，Effort 菜单里选 Off；再把范围换成 flint：
//      Effort 按钮显示 Minimal，菜单没有 Off、有 "This model can’t turn thinking off."；发一条消息，flint 正常回答（会话文件里
//      助手消息的 provider / model），没有错误卡。
// 检查的名字与 detail 里的 key 换成 ***（一步出错时先换再截短）；窗口的文字里出现 key 时不截图。免费模型每天有请求上限，
// 与 md-real.mjs 同一天跑时注意（§14.1）。
// key 方式（§14.1 的 2026-10-24 补，负责人定：选项 A）：不给 --source，MP_REAL_DEEPSEEK_KEY、MP_REAL_GLM_KEY、
// MP_REAL_OPENROUTER_KEY 都有值（由运行它的进程从 deepseek.env、glm.env、openrouter.env 读出、不打印；脚本一启动就读进
// 内存并从 process.env 删掉）。脚本只经界面建一个新的数据目录（步骤在 v1-real-helpers.mjs，与 md-real.mjs 的 key 方式
// 共用）：首次启动表单接 DeepSeek（KEY_MODE_URLS.deepseek，只勾文档的一个模型，Test connection，等探针）；重新
// 打开，Add provider 接 GLM（KEY_MODE_URLS.glm，GLM-5.3）与 OpenRouter（OPENROUTER_BASE，只勾 flint：这就是 MP-40 的
// "经 Add provider 加入"，记一条 MP-40 add 检查），等探针跑完再关掉（不先加别的免费模型，免得同一天多探测一遍）。之后
// 把这个目录当作 --source 照原样跑 MP-27 与 MP-40；MP-40 不删 flint（这次加的），lfm 经卡上的 Fetch models 加入。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--first <id>] [--second <id>]
//   （数据目录里没有 OpenRouter 的提供商时，运行它的进程另设 MP_REAL_OPENROUTER_KEY）
//   key 方式（环境变量里有三个 key）：node tests/ui/v1-models-real.mjs [--exe <Mori.exe>]
//   只走 MP-27（测试分层第 5 条：只跑覆盖这次变化的用例）：再加 --only MP-27，不准备、不走 MP-40
// 结果写到 test-results/v1-models-real(-packaged).json（--only MP-27 时写 v1-models-real-mp27(-packaged).json，
// 不覆盖完整一次的结果，spec-coverage 也不把它算作真实层），截图在 test-results/v1-models-real(-packaged)/。
// 没有 --source 又没有三个 key、或没有第二个真实提供商时停下来报告（MP-27 与 MP-40 都记为失败，§14.1）。

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import { PANE, rowOf, waitReady } from './m3-helpers.mjs';
import {
  brief, GLM_MANUAL_ID, installRecorder, modelsGet, OPENROUTER_BASE, pollFor, redactor, waitProbed,
} from './md-real-helpers.mjs';
import { pageHelpers } from './page.mjs';
import {
  activeSessionFile, addLabel, addNotes, addOnCard, addOpenRouter, addProviderUi, assistantMessages, cardCounts,
  chooseEffort, chooseGlm, chooseRange, customEntries, effortButton, effortMenu, findOpenRouter, findRealProviders,
  firstRunDeepSeek, firstRunProblems, glmAddProblems, injectWrongKey, KEY_MODE_URLS, leaveSettings, NO_OFF_MODELS,
  NO_OFF_NOTE, noOffAddProblems, openModelsSettings, openNewSession, openProjectFolder, OPENROUTER_KEY_VAR,
  openRouterProblems, prepareNoOff, prepareRealConfig, PROBE_MS, profileProblems, providerBrief, rangeButton, readJson,
  restoreFirstKey, scratchModelData, sourceProblems, switchNotices, takeEnvSecret, TEST_GROUP, testModelBridge,
  THINKING_OFF_TEXT, thinkingOffItem, thinkingRecorded, waitProfiles,
} from './v1-real-helpers.mjs';
import { pickers } from './v1-models-row-helpers.mjs';

/** key 方式的三个 key 的环境变量（§14.1 的 2026-10-24 补；OpenRouter 的那个 --source 方式下也用，见 MP-40） */
const KEY_VARS = { deepseek: 'MP_REAL_DEEPSEEK_KEY', glm: 'MP_REAL_GLM_KEY', openrouter: OPENROUTER_KEY_VAR };
/** 三个 key：一启动就读进内存并从 process.env 删掉（之后启动的 Mori 拿不到）；只输进 Mori 的密码框，没有值的为 null */
const keys = Object.fromEntries(Object.entries(KEY_VARS).map(([id, name]) => [id, takeEnvSecret(name)]));
/** MP-40 的 OpenRouter key（--source 方式下数据目录里没有 OpenRouter 的提供商时经 Add provider 用） */
const openrouterKey = keys.openrouter;
/** 这次运行知道的 key（只用来把检查与日志里的 key 换成 ***、截图前查窗口的文字） */
const secrets = Object.values(keys).filter(Boolean);
/** @brief 把文字里的 key 换成 ***。 */
const redact = redactor(secrets);
const source = arg('source') ? resolve(arg('source')) : null;
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
/** --only MP-27：只走 MP-27 的步骤（不准备、不走 MP-40）；--only 只接受 MP-27 */
const only = arg('only');
if (only && only !== 'MP-27') {
  console.error(`[v1-models-real] --only takes MP-27 (got ${only})`);
  process.exit(1);
}
const shots = join(appRoot, `test-results/v1-models-real${suffix}`);
mkdirSync(shots, { recursive: true });
const recorder = createRecorder(exePath ?? 'dev build');
/** @brief 记一条检查：名字与 detail 里的 key 换成 ***（Playwright 的报错可能带着输入框里填的值）。 */
const record = (name, ok, detail = '') => recorder.record(redact(name), ok, redact(detail));
/**
 * @brief 一步出错时的 detail：先把 key 换成 *** 再截成一行（Playwright 填输入框出错时报错里带着填的值；先截短的话，
 *        跨过截断处的 key 会留下前一段）。
 */
const errorLine = (error, max) => oneLine(redact(String(error)), max);
/** @brief 一行概括（检查的 detail）：同 md-real-helpers.mjs 的 brief，同样先把 key 换成 *** 再截短。 */
const briefLine = (value) => brief(redact(typeof value === 'string' ? value : JSON.stringify(value)));
const { write } = recorder;

/** @brief 截图（失败也不报错）；窗口的文字（innerText，不含输入框的值）里出现 key 时不截。 */
async function shot(page, name) {
  if (!page) return;
  const text = secrets.length ? await page.evaluate(() => document.body.innerText).catch(() => '') : '';
  if (secrets.some((secret) => text.includes(secret))) {
    console.log(`[v1-models-real] screenshot ${name} not taken: the window text shows a key`);
    return;
  }
  await page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
}

/** 走查里发的文字 */
const PROMPTS = {
  HELLO: '用一句话介绍你自己。不要调用任何工具。',
  START: '用一句话说说今天适合做什么。不要调用任何工具。',
  BACK: '用一句话说说你是哪个模型。不要调用任何工具。',
  MULTI: '请依次读取 notes-1.md、notes-2.md、notes-3.md、notes-4.md、notes-5.md 这五个文件：每次只调用一次 read 工具，'
    + '读完一个再读下一个，不要同时调用多个工具。全部读完后用一句话说明它们的共同点。不要修改任何文件，不要运行命令。',
  AGAIN: '用一句话总结我们刚才做了什么。不要调用任何工具。',
};

/**
 * @brief 启动 Mori，等 ready 的标识出现（侧栏；key 方式建目录时全新数据目录的首次启动表单 connection-form）。
 */
async function startApp(ctx, ready = 'sidebar') {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
  await ctx.page.getByTestId(ready).waitFor({ timeout: 60000 });
}

/** @brief 关掉 Mori（出错也不报错），清掉 ctx 里的窗口。 */
async function closeApp(ctx) {
  await ctx.app?.close().catch(() => {});
  ctx.app = null;
  ctx.page = null;
}

/** @brief 退出 Mori，把首选提供商的 key 改指备用 ref（§14.1 的恢复），重新启动并打开走查的会话。 */
async function restartRestored(ctx) {
  await ctx.app.close();
  restoreFirstKey(ctx.userData, ctx.first.id, ctx.cipher);
  await startApp(ctx);
  await rowOf(ctx.page, ctx.sessionFile).click();
  await waitReady(ctx.page);
}

/** @brief 发一条消息，等这一轮结束；返回这一轮新加的助手消息（会话文件）与新出现的换模型提示。 */
async function sendAndWait(ctx, text, timeout = 600000) {
  const before = { messages: assistantMessages(ctx.sessionFile).length,
    notices: (await switchNotices(ctx.page)).length };
  await ctx.h.send(text);
  await ctx.h.idle(timeout);
  await sleep(500);
  return { messages: assistantMessages(ctx.sessionFile).slice(before.messages),
    notices: (await switchNotices(ctx.page)).slice(before.notices), cards: await cardCounts(ctx.page) };
}

/** @brief 一轮的实际模型（去重，按出现顺序）。 */
const refsOf = (messages) => [...new Set(messages.map((message) => message.ref))];

/** @brief 设置 → Models：两个模型的档案合理（models.get），模型行上的 data-probe 为 verified（2026-10-26 起没有档案摘要）。 */
async function probes(ctx) {
  const info = await waitProfiles(ctx.page, [ctx.firstRef, ctx.secondRef]);
  await openModelsSettings(ctx.page);
  for (const [provider, ref] of [[ctx.first, ctx.firstRef], [ctx.second, ctx.secondRef]]) {
    const problems = profileProblems(info.profiles[ref], provider.models[0].contextWindow);
    const row = ctx.page.locator(`[data-testid="model-row"][data-model="${ref}"]`);
    await row.scrollIntoViewIfNeeded();
    const shown = await row.getAttribute('data-probe', { timeout: 10000 }).catch(() => null);
    const p = info.profiles[ref];
    record(`MP-27 probe results for ${ref} are plausible: probed, tool calling verified, a handoff tier, `
      + 'an effective window within the declared one, a known reasoning field and server kind; the Models row '
      + 'is verified (data-probe)',
    problems.length === 0 && shown === 'verified', JSON.stringify({ problems, shown, server: p?.server,
      tier: p?.tier?.level, context: p?.context, reasoning: p?.reasoning, cancel: p?.cancel_verified }));
  }
  await shot(ctx.page, '01-profiles');
  await ctx.page.getByTestId('settings-page').getByRole('button', { name: 'Back to app' }).click();
  await ctx.page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 正常对话：新会话在默认范围（分组）里由首选回答，没有换模型提示、没有错误卡。 */
async function normalChat(ctx) {
  await openProjectFolder(ctx.app, ctx.page, ctx.project);
  ctx.sessionFile = await activeSessionFile(ctx.page);
  const button = await rangeButton(ctx.page);
  const place = await pickers(ctx.page);
  const hover = ctx.first.name;
  record(`MP-27 normal chat: the range button is in the message-box row, not the top bar (2026-10-21); hover line 1 is `
    + `its text, line 2 "${hover}"`, Boolean(place) && place.inRow && !place.inTopbar && place.tip[0] === button?.text
    && place.tip[1] === hover, JSON.stringify({ inRow: place?.inRow, inTopbar: place?.inTopbar, tip: place?.tip }));
  const turn = await sendAndWait(ctx, PROMPTS.HELLO);
  await shot(ctx.page, '02-normal');
  record(`MP-27 normal chat: the new session's range is ${TEST_GROUP} with ${ctx.firstRef} first (range button `
    + `"${TEST_GROUP} · ${ctx.first.models[0].id}"); ${ctx.firstRef} answers; no switch line, no error card`,
  button?.pick === TEST_GROUP && button?.text === `${TEST_GROUP} · ${ctx.first.models[0].id}`
    && refsOf(turn.messages).join() === ctx.firstRef && turn.messages.at(-1)?.stopReason === 'stop'
    && turn.notices.length === 0 && turn.cards.errors === 0,
  JSON.stringify({ button, refs: refsOf(turn.messages), notices: turn.notices, cards: turn.cards }));
}

/** @brief 段开始时换模型：界面里换成错的 key，下一条消息的第一个请求得到真实的 401，同一个请求发给第二个。 */
async function switchAtStart(ctx) {
  const keys = await injectWrongKey(ctx.page, ctx.first.id);
  const turn = await sendAndWait(ctx, PROMPTS.START);
  await shot(ctx.page, '03-switch-start');
  const notice = turn.notices[0];
  const want = `Switched model: ${ctx.firstRef} → ${ctx.secondRef} · API key rejected`;
  record('MP-27 switch at reply start (wrong key entered in Settings → Models → Keys → real HTTP 401): one line '
    + `"${want}" without the redo note; ${ctx.secondRef} answers; no error card, no No model available card`,
  turn.notices.length === 1 && notice?.text === want && notice.from === ctx.firstRef && notice.to === ctx.secondRef
    && notice.reason === 'auth' && !notice.hidden && refsOf(turn.messages).at(-1) === ctx.secondRef
    && turn.cards.errors === 0 && turn.cards.unavailable === 0,
  JSON.stringify({ keys, notices: turn.notices, refs: refsOf(turn.messages), cards: turn.cards }));
}

/** @brief 恢复首选的 key 并重新启动：打开同一个会话，下一段用回首选，不另提示。 */
async function backToFirst(ctx, label) {
  await restartRestored(ctx);
  const reopened = await switchNotices(ctx.page);
  const entries = customEntries(ctx.sessionFile, 'mori.model_switch').length;
  const turn = await sendAndWait(ctx, label === 'after the mid-reply switch' ? PROMPTS.AGAIN : PROMPTS.BACK);
  const button = await rangeButton(ctx.page);
  await shot(ctx.page, `04-back-${label.replace(/\W+/g, '-')}`);
  record(`MP-27 back to first choice ${label}: after restoring ${ctx.first.id}'s key and restarting, the reopened `
    + `session still shows its switch lines, and the next reply runs on ${ctx.firstRef} with no new switch line`,
  entries > 0 && reopened.length === entries && refsOf(turn.messages).join() === ctx.firstRef
    && turn.notices.length === 0 && turn.cards.errors === 0 && button?.current === ctx.firstRef,
  JSON.stringify({ reopened: reopened.length, entries, refs: refsOf(turn.messages), notices: turn.notices,
    button }));
}

/** @brief 段内换模型：读五个文件的回复开始后界面里换成错的 key；之后的请求 401，换到第二个并重做。 */
async function switchMidReply(ctx) {
  const before = { messages: assistantMessages(ctx.sessionFile).length, notices: (await switchNotices(ctx.page)).length,
    tools: await ctx.page.locator(`${PANE} [data-testid="tool-card"]`).count() };
  await ctx.h.send(PROMPTS.MULTI);
  // 回复开始后第一个请求已经带着原来的 key 发出；之后的请求用错的 key（读五个文件要连着发好几个请求）。
  await ctx.page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'true', PANE,
    { timeout: 60000 });
  const running = await ctx.page.locator(PANE).getAttribute('data-running');
  const keys = await injectWrongKey(ctx.page, ctx.first.id);
  const stillRunning = await ctx.page.locator(PANE).getAttribute('data-running');
  await ctx.h.idle(900000);
  await sleep(500);
  const notices = (await switchNotices(ctx.page)).slice(before.notices);
  const messages = assistantMessages(ctx.sessionFile).slice(before.messages);
  const cards = await cardCounts(ctx.page);
  const tools = await ctx.page.locator(`${PANE} [data-testid="tool-card"]`).count() - before.tools;
  const entry = customEntries(ctx.sessionFile, 'mori.model_switch').at(-1);
  const firstTools = messages.filter((m) => m.ref === ctx.firstRef).reduce((sum, m) => sum + m.tools, 0);
  await shot(ctx.page, '05-switch-mid');
  const want = `Switched model: ${ctx.firstRef} → ${ctx.secondRef} · API key rejected`
    + ' The new model redoes this response.';
  record('MP-27 switch mid-reply (wrong key entered while the reply was reading files → real HTTP 401): one line '
    + `"${want}"; ${ctx.secondRef} finishes the reply; no error card`,
  running === 'true' && stillRunning === 'true' && notices.length === 1 && notices[0].text === want && notices[0].hidden
    && notices[0].reason === 'auth' && messages.at(-1)?.ref === ctx.secondRef && messages.at(-1)?.stopReason === 'stop'
    && cards.errors === 0 && cards.unavailable === 0,
  JSON.stringify({ running, stillRunning, keys, notices, refs: refsOf(messages), cards }));
  record(`MP-27 switch mid-reply: ${ctx.firstRef} had called tools before the switch, its tool cards stay in the `
    + 'transcript, and the session file records the hidden range (hideUntil > replyStartedAt)',
  firstTools >= 1 && tools >= firstTools && entry?.from === ctx.firstRef && entry?.to === ctx.secondRef
    && entry.hideUntil > entry.replyStartedAt, JSON.stringify({ firstTools, tools, entry }));
}

/** @brief 一步出错时的收尾：截图，关掉菜单或对话框。 */
async function recover(ctx, name) {
  await shot(ctx.page, `${name}-error`);
  await ctx.page?.keyboard.press('Escape').catch(() => {});
}

// ---------- MP-40：思考关不掉的模型（§7.7，§14.1 的 2026-10-24 补，§14.2 MP-40） ----------

/** MP-40 原来是 Off 的会话里发的文字 */
const NO_OFF_PROMPT = '用一句话说说你是哪个模型。不要调用任何工具。';
/** MP-40 准备那一条检查的名字 */
const NO_OFF_SETUP = 'MP-40 setup: the copied data dir has an OpenRouter provider (name or base URL contains '
  + `"openrouter") with a saved key, or ${OPENROUTER_KEY_VAR} is set to add one through `
  + 'Add provider (spec §14.1)';

/** @brief MP-40 的一个模型的全名 <OpenRouter 提供商 id>/<模型 id>（加入之后才知道提供商 id）。 */
const noOffRef = (ctx, key) => `${ctx.noOff.providerId}/${NO_OFF_MODELS[key]}`;

/** @brief 档案的摘要（detail 用）。 */
const noOffBrief = (p) => (p ? { status: p.status, error: p.error, tool: p.tool_calling?.state, tier: p.tier?.level,
  reasoning: p.reasoning, server: p.server?.kind } : null);

/**
 * @brief MP-40 的准备（key 方式）：OpenRouter 的提供商是建目录时 Add provider 加的、只有 flint（keyOpenRouter），不做
 *        prepareNoOff（新目录里 flint 是这次加的，lfm 还没有）；lfm 之后经卡上的 Fetch models 加入。记一条 setup 检查。
 * @return 同 setupNoOff
 */
function keyNoOff(ctx, config) {
  const provider = config.providers.find((item) => item.id === ctx.keyOpenRouter) ?? null;
  if (!provider) {
    record(NO_OFF_SETUP, false, 'key mode: the OpenRouter Add provider while building the data dir did not pass (see '
      + 'the "MP-40 add (key mode" check)');
    return null;
  }
  record(NO_OFF_SETUP, true, `key mode: ${provider.id} (${provider.baseUrl}) was added through Add provider with `
    + `${NO_OFF_MODELS.flint} while building the data dir; ${NO_OFF_MODELS.lfm} is added through Fetch models on its `
    + 'card');
  return { existing: provider.id, providerId: provider.id, add: [NO_OFF_MODELS.lfm] };
}

/**
 * @brief MP-40 的准备（Mori 启动之前，只读写复制出的数据目录）：找 OpenRouter 的提供商（要有保存的 key），
 *        没有时要有 MP_REAL_OPENROUTER_KEY；再做 synthetic test setup（prepareNoOff：去掉已有的两个免费模型和它们的档案）。
 *        key 方式见 keyNoOff。记一条 setup 检查。
 * @return { existing: 已有的 OpenRouter 提供商 id（没有时 null，经 Add provider 加入）, providerId, add: 这一步要加入的
 *         模型 id }；不能跑时为 null
 */
function setupNoOff(ctx) {
  try {
    const config = readJson(join(ctx.userData, 'model-config.json'));
    if (ctx.keyMode) return keyNoOff(ctx, config);
    const provider = findOpenRouter(config);
    // 只看 credentials.json 的键名（key 的 ref），不读、不解密密文
    const refs = Object.keys(readJson(join(ctx.userData, 'credentials.json')));
    const ids = config.providers.map((item) => item.id).join(', ');
    const problems = provider ? openRouterProblems(provider, refs) : openrouterKey ? []
      : [`no OpenRouter provider in model-config.json (providers: ${ids}) and ${OPENROUTER_KEY_VAR} is not set`];
    if (problems.length) {
      // §14.1 只在数据目录里找不到 OpenRouter 的提供商时经 Add provider 用这个 key；找到的提供商不能用时照实写明
      const unused = provider && openrouterKey ? [`${OPENROUTER_KEY_VAR} is set but not used: spec §14.1 adds `
        + 'OpenRouter through Add provider with it only when the data dir has no OpenRouter provider'] : [];
      record(NO_OFF_SETUP, false, [...problems, ...unused].join('; '));
      return null;
    }
    const notes = prepareNoOff(ctx.userData, provider?.id ?? null);
    record(NO_OFF_SETUP, true, `${provider ? `${provider.id} (${provider.baseUrl}): Fetch models on its card`
      : `no OpenRouter provider: Add provider with ${OPENROUTER_BASE} and ${OPENROUTER_KEY_VAR}`}; synthetic test `
      + `setup on the copy: ${notes.join('; ') || 'nothing to remove'}`);
    return { existing: provider?.id ?? null, providerId: provider?.id ?? null, add: Object.values(NO_OFF_MODELS) };
  } catch (error) {
    record(NO_OFF_SETUP, false, errorLine(error, 600));
    return null;
  }
}

/**
 * @brief MP-40 加入：设置 → Models；有 OpenRouter 的提供商时用它卡上的 Fetch models，没有时 Add provider（key 输进密码框）；
 *        过滤、勾上 ctx.noOff.add（两个免费模型；key 方式下只有 lfm，flint 建目录时已加）、Add。
 * @return flint 存进了配置（之后的步骤要它）；lfm 有没有存进记在 ctx.noOff.lfmSaved，只有探针那一步要它
 */
async function noOffAdd(ctx) {
  const ids = ctx.noOff.add;
  const form = ctx.noOff.existing === null;
  await openModelsSettings(ctx.page);
  const added = form ? await addOpenRouter(ctx.page, openrouterKey, ids)
    : await addOnCard(ctx.page, ctx.noOff.existing, ids);
  await shot(ctx.page, '06-nooff-added');
  const provider = (await modelsGet(ctx.page)).config.providers.find((item) => item.id === added.providerId) ?? null;
  const problems = noOffAddProblems(added, provider, ids, form);
  const where = form ? `Add provider with ${OPENROUTER_BASE} and the key typed into its password field`
    : `Fetch models on the ${ctx.noOff.existing} card (with its saved key)`;
  const both = ids.length > 1;
  record(`MP-40 add: ${where} lists ${ids.join(' and ')} with Supports thinking; after filtering for `
    + `${both ? 'each' : 'it'}, ticking ${both ? 'both' : 'it'} and "${addLabel(ids.length)}", `
    + `${both ? 'both are' : 'it is'} saved in ${provider?.id ?? 'the provider'}`, problems.length === 0,
  JSON.stringify({ problems, providerId: added.providerId, title: added.state.title, listed: added.ticked?.listed,
    filter: added.ticked?.filter }));
  ctx.noOff.providerId = provider?.id ?? null;
  const saved = (id) => Boolean(provider?.models.some((model) => model.id === id));
  ctx.noOff.lfmSaved = saved(NO_OFF_MODELS.lfm);
  return saved(NO_OFF_MODELS.flint);
}

/**
 * @brief lfm 的档案：没存进配置时不等（note 写明）；存进了时等它的探针跑完，时限内没跑完时 note 为报错。
 * @return { profile（没有时 null）, note（没有时 null） }
 */
async function lfmProfile(ctx, lfm) {
  if (!ctx.noOff.lfmSaved) return { profile: null, note: `${lfm} was not saved (see the MP-40 add check)` };
  try {
    return { profile: (await waitProfiles(ctx.page, [lfm], PROBE_MS)).profiles[lfm], note: null };
  } catch (error) {
    return { profile: null, note: errorLine(error, 300) };
  }
}

/**
 * @brief MP-40 探针：flint 与 lfm 分开等、分开记（lfm 没加成或探针没跑完时 flint 的检查与之后的步骤照常走）：
 *        flint 的档案与模型行的 Thinking 一项，lfm 的工具调用与等级。时限为 PROBE_MS（免费模型慢，同 md-real.mjs）。
 */
async function noOffProbes(ctx) {
  const [flint, lfm] = [noOffRef(ctx, 'flint'), noOffRef(ctx, 'lfm')];
  const a = (await waitProfiles(ctx.page, [flint], PROBE_MS)).profiles[flint];
  // 界面收到同一个 mori.profiles 之后才重画模型行：最多等 10 秒
  const shown = await pollFor(() => thinkingOffItem(ctx.page, flint), (item) => item !== null, 10000);
  record(`MP-40 ${flint}: after Add its probes finish with status ready, tool calling verified and `
    + `reasoning.off_refused true, and its model row's line ends with "${THINKING_OFF_TEXT}"`, a?.status === 'ready'
    && a.tool_calling?.state === 'verified' && a.reasoning?.off_refused === true && shown?.text === THINKING_OFF_TEXT,
  JSON.stringify({ profile: noOffBrief(a), shown }));
  const b = await lfmProfile(ctx, lfm);
  await shot(ctx.page, '07-nooff-probed');
  record(`MP-40 ${lfm}: after Add its probes finish with tool calling verified, reasoning.off_refused true, and `
    + `handoff tier B or step 6 an error "${OUTPUT_LIMIT_TEXT}" (never a fail)`,
  b.profile?.tool_calling?.state === 'verified' && b.profile.reasoning?.off_refused === true && lfmTierOk(b.profile),
  JSON.stringify({ profile: noOffBrief(b.profile), step6: b.profile?.tier?.b ?? null, note: b.note }));
}

/** MP-40 lfm 第 6 步停在探针输出上限时的说明（§7.7，同 probes.ts 的 OUTPUT_LIMIT_TEXT） */
const OUTPUT_LIMIT_TEXT = 'Stopped at the probe output limit before answering';

/**
 * @brief MP-40 lfm 的等级一项（§14.2 MP-40 的 2026-10-24 负责人改）：等级 B，或第 6 步出错、说明是输出上限那一句
 *        （只能是出错，不能是不通过）。lfm 在 medium 下第 6 步的思考长度不定，在 256 token 的探针上限上两样都可能。
 * @param profile lfm 的档案；没有时为 null
 */
function lfmTierOk(profile) {
  if (profile?.tier?.level === 'B') return true;
  const step6 = profile?.tier?.b;
  return step6?.outcome === 'error' && step6.detail === OUTPUT_LIMIT_TEXT;
}

/**
 * @brief MP-40 测试连接：flint 的 connection.test（§7.7：勾了 Supports thinking 的模型带 medium）成功。2026-10-26 起
 *        模型行没有 Test、提供商卡的 Test connection 只测第一个模型，所以经进程桥发同一个命令（testModelBridge）。
 *        在探针之后点：这时没有 Off 的标记已编译进 flint，所以这一条只核对 MP-40 的"测试连接成功"；测试连接发的是
 *        medium，由 MP-39 的 App 层在合成端点的请求日志里核对（effort 为 medium 且成功）。
 *        不在探针跑完之前抢着点：探针同时在发请求，免费模型每天有请求上限；key 方式下 flint 的探针建目录时就跑完了。
 */
async function noOffTest(ctx) {
  const flint = noOffRef(ctx, 'flint');
  const result = await testModelBridge(ctx.page, flint);
  await shot(ctx.page, '08-nooff-test');
  record(`MP-40 Test connection on ${flint} (connection.test through the bridge) succeeds`, result?.ok === true,
    JSON.stringify(result));
}

/**
 * @brief MP-40 原来是 Off 的会话：回到会话页，在临时项目里开一个新会话（默认范围，首选是 DeepSeek，有 Off 的模型），
 *        Effort 菜单里有 Off、选它。
 */
async function noOffSession(ctx) {
  await leaveSettings(ctx.page);
  ctx.noOff.sessionFile = await openNewSession(ctx.app, ctx.page, ctx.project);
  if (!ctx.noOff.sessionFile) throw new Error(`Open folder… on ${ctx.project} did not show a new session in 30 s`);
  const range = await rangeButton(ctx.page);
  const menu = await effortMenu(ctx.page);
  const off = menu?.levels.find((item) => item.level === 'off');
  const usable = Boolean(off) && !off.disabled;
  if (usable) await chooseEffort(ctx.page, 'off');
  const after = await effortButton(ctx.page);
  ctx.noOff.offSet = usable && after?.level === 'off' && after.label === 'Effort: Off';
  await shot(ctx.page, '09-nooff-off');
  // 没标 Supports thinking 的模型菜单里的强度都不可用（model-menu.md），也就没有 Off 可选：detail 里写明
  const note = !menu ? 'no Effort button: the session has no current model'
    : menu.reasoning === 'true' ? null : `${ctx.firstRef} is not marked "Supports thinking" in the data dir, so its `
      + 'Effort menu has no Off to choose';
  record(`MP-40 Off session: a new session on ${ctx.firstRef} (a model with Off) lists Off in its Effort menu, and `
    + 'choosing it shows "Effort: Off"', range?.current === ctx.firstRef && menu?.reasoning === 'true'
    && ctx.noOff.offSet, JSON.stringify({ note, range, menu, after }));
}

/**
 * @brief MP-40 换到 flint：把这个 Off 的会话的范围换成 flint；Effort 按钮显示 Minimal（pi 收紧后的强度），菜单没有 Off、
 *        从 Minimal 起、Minimal 打勾，底部有"This model can’t turn thinking off."（model-menu.md）。
 */
async function noOffSwitch(ctx) {
  const flint = noOffRef(ctx, 'flint');
  await chooseRange(ctx.page, flint);
  const range = await rangeButton(ctx.page);
  const menu = await effortMenu(ctx.page);
  await shot(ctx.page, '10-nooff-flint');
  const levels = menu?.levels.map((item) => item.level) ?? [];
  const minimal = menu?.levels.find((item) => item.level === 'minimal');
  record(`MP-40 Off session switched to ${flint}: the Effort button reads "Effort: Minimal"; its menu has no Off, `
    + `starts at Minimal with Minimal checked, and shows "${NO_OFF_NOTE}"`, range?.pick === flint
    && range.current === flint && menu?.level === 'minimal' && menu.label === 'Effort: Minimal'
    && menu.reasoning === 'true' && levels[0] === 'minimal' && !levels.includes('off') && minimal?.checked === true
    && !minimal.disabled && menu.note === NO_OFF_NOTE, JSON.stringify({ range, menu }));
}

/** @brief MP-40 回答：原来是 Off 的会话在 flint 上发一条消息，flint 正常回答（会话文件），没有换模型提示和错误卡。 */
async function noOffAnswer(ctx) {
  const flint = noOffRef(ctx, 'flint');
  const turn = await sendAndWait({ ...ctx, sessionFile: ctx.noOff.sessionFile }, NO_OFF_PROMPT);
  await shot(ctx.page, '11-nooff-answer');
  const last = turn.messages.at(-1);
  record(`MP-40 Off session on ${flint}: a message gets a normal answer from ${flint} (the session file's assistant `
    + 'message provider/model) with no switch line and no error card', ctx.noOff.offSet === true
    && refsOf(turn.messages).join() === flint && last?.stopReason === 'stop' && Boolean(last.text.trim())
    && turn.notices.length === 0 && turn.cards.errors === 0 && turn.cards.unavailable === 0,
  JSON.stringify({ offSet: ctx.noOff.offSet, refs: refsOf(turn.messages), last, notices: turn.notices,
    cards: turn.cards, recorded: thinkingRecorded(ctx.noOff.sessionFile), effort: await effortButton(ctx.page) }));
}

/** MP-40 的步骤（按顺序，后面的要前面的结果） */
const NO_OFF_STEPS = [['add', noOffAdd], ['probes', noOffProbes], ['test', noOffTest], ['offSession', noOffSession],
  ['switch', noOffSwitch], ['answer', noOffAnswer]];

/**
 * @brief 跑 MP-40 的步骤：一步抛错时记一条失败、收尾并停下；flint 没有存进配置（noOffAdd 返回 false，它已记了失败）时
 *        停下，之后的步骤要它（lfm 没存进时只有探针那一步记 lfm 的失败，其余照走）。
 */
async function runNoOff(ctx) {
  for (const [name, step] of NO_OFF_STEPS) {
    try {
      if (await step(ctx) === false) {
        console.log(`[v1-models-real] MP-40 stops after ${name}: the next MP-40 steps need its result`);
        return;
      }
    } catch (error) {
      record(`MP-40 ${name}: flow`, false, errorLine(error, 400));
      await recover(ctx, `mp40-${name}`);
      return;
    }
  }
}

// ---------- key 方式：只经界面建数据目录（§14.1 的 2026-10-24 补，负责人定：选项 A） ----------

/** key 方式建目录出错时那一条检查的名字 */
const KEY_SETUP = 'MP-27 setup (key mode): the data dir is built through the UI (first run with DeepSeek, Add provider '
  + 'for GLM and OpenRouter, each API key typed into its password field)';

/**
 * @brief key 方式第一步：全新的数据目录启动到首次启动表单，经表单接上 DeepSeek（firstRunDeepSeek），记一条检查，关掉 Mori。
 * @return 保存的 DeepSeek 提供商 id；没接上时为 null
 */
async function keyFirstRun(ctx) {
  await startApp(ctx, 'connection-form');
  await ctx.page.evaluate(installRecorder);
  const run = await firstRunDeepSeek(ctx.page, { baseUrl: KEY_MODE_URLS.deepseek, key: keys.deepseek,
    shot: (name) => shot(ctx.page, name) });
  const problems = firstRunProblems(run, KEY_MODE_URLS.deepseek);
  record(`MP-27 setup (key mode): first run with DeepSeek (${KEY_MODE_URLS.deepseek}, API key typed into its password `
    + `field): Fetch models shows "Detected: DeepSeek"; with only ${run.doc?.id ?? 'a documented model'} ticked and `
    + 'Test connection saves the provider (the Base URL host, one saved key, only that model), '
    + 'connects, and its probes finish with tool calling verified', problems.length === 0,
  briefLine({ problems, ids: run.rows.map((row) => row.id), picked: run.picked, text: run.text,
    provider: providerBrief(run.provider) }));
  await closeApp(ctx);
  return problems.length === 0 ? run.provider.id : null;
}

/**
 * @brief MP-40 加入的前一半（key 方式，§14.1）：建目录时 Add provider 接 OpenRouter（OPENROUTER_BASE，key 输进密码框），
 *        只勾 flint、Add 1 model；lfm 之后经卡上的 Fetch models 加入（noOffAdd）。记一条 MP-40 检查。
 * @return { provider（新的提供商；没有时 null）, since（点 Add 前的时刻）, ok（检查通过） }
 */
async function keyOpenRouter(ctx) {
  const ids = [NO_OFF_MODELS.flint];
  const added = await addOpenRouter(ctx.page, keys.openrouter, ids);
  const problems = noOffAddProblems(added, added.provider, ids, true);
  record(`MP-40 add (key mode, while building the data dir): Add provider with ${OPENROUTER_BASE} and the key typed `
    + `into its password field shows "Detected: OpenRouter" and lists ${ids[0]} with Supports thinking; `
    + `after filtering for it, ticking only it and "${addLabel(ids.length)}" saves the provider with it`,
  problems.length === 0, JSON.stringify({ problems, providerId: added.providerId, title: added.state.title,
    listed: added.ticked?.listed, filter: added.ticked?.filter }));
  return { provider: added.provider, since: added.since, ok: problems.length === 0 };
}

/**
 * @brief key 方式第二步：重新打开 Mori，设置 → Models → Add provider 接 GLM（chooseGlm）与 OpenRouter（keyOpenRouter），
 *        各记一条检查；等它们的探针跑完（复制这个目录之后不因档案没写完而重新探测）再关掉 Mori。
 * @return { second: GLM 提供商 id, openrouter: OpenRouter 提供商 id }；没加成的为 null
 */
async function keyProviders(ctx) {
  await startApp(ctx);
  await ctx.page.evaluate(installRecorder);
  await openModelsSettings(ctx.page);
  const glm = await addProviderUi(ctx.page, { baseUrl: KEY_MODE_URLS.glm, key: keys.glm, choose: chooseGlm });
  const glmProblems = glmAddProblems(glm, KEY_MODE_URLS.glm);
  record(`MP-27 setup (key mode): Add provider for GLM (${KEY_MODE_URLS.glm} and its API key in the password field): `
    + 'Fetch models shows the model list with "Detected: Anthropic-compatible server" (or a list error without a '
    + `Detected line); ${GLM_MANUAL_ID} is entered with Add a model ID (or ticked when the server lists it) and Add `
    + 'saves the provider (the Base URL host, its API type, one saved key) with only it',
  glmProblems.length === 0, briefLine({ problems: glmProblems, detected: glm.state.detected,
    listError: glm.state.listError, provider: providerBrief(glm.provider) }));
  const free = await keyOpenRouter(ctx);
  await shot(ctx.page, 'setup-providers');
  const probing = [glm.provider && glm.picked ? [`${glm.provider.id}/${glm.picked}`, glm.since] : null,
    free.provider ? [`${free.provider.id}/${NO_OFF_MODELS.flint}`, free.since] : null].filter(Boolean);
  for (const [ref, since] of probing) {
    const probed = await waitProbed(ctx.page, ref, since, PROBE_MS);
    console.log(`[v1-models-real] key mode: probes of ${ref} ${probed ? 'finished' : 'did not finish'}`);
  }
  await closeApp(ctx);
  return { second: glmProblems.length ? null : glm.provider.id, openrouter: free.ok ? free.provider.id : null };
}

/**
 * @brief key 方式：建一个全新的数据目录，只经界面接上 DeepSeek（首次启动表单）、GLM 与 OpenRouter（Add provider）。
 *        出错时记一条失败。这段时间的页面错误算进"MP-27 page has no errors"（建目录是 MP-27 的准备）。
 * @return { dir, ids: { first, second }, openrouter（OpenRouter 提供商 id；那一步没通过时 null） }；没建成时为 null
 */
async function buildKeyData(ctx) {
  ctx.keyDir = mkdtempSync(join(tmpdir(), 'mori-v1-real-keys-'));
  ctx.userData = ctx.keyDir;
  console.log(`[v1-models-real] key mode: building a new data dir in ${ctx.keyDir} through the UI`);
  try {
    const first = await keyFirstRun(ctx);
    const added = first ? await keyProviders(ctx) : null;
    return added?.second ? { dir: ctx.keyDir, ids: { first, second: added.second }, openrouter: added.openrouter }
      : null;
  } catch (error) {
    record(KEY_SETUP, false, errorLine(error, 600));
    await recover(ctx, 'setup');
    await closeApp(ctx);
    return null;
  }
}

/**
 * @brief MP-27 的数据目录：--source 给出时用它（sourceProblems 检查）；没给而三个 key 都有值时经界面建一个
 *        （buildKeyData）；两样都没有时抛错（停下来报告，§14.1）。
 * @return { dir, ids: { first, second }（--first / --second，或 key 方式建的时候得到的提供商 id） }
 */
async function dataSource(ctx) {
  if (source) {
    const problems = sourceProblems(source);
    if (problems.length) throw new Error(problems.join('; '));
    return { dir: source, ids: { first: arg('first'), second: arg('second') } };
  }
  const missing = Object.entries(KEY_VARS).filter(([id]) => !keys[id]).map(([, name]) => name);
  if (missing.length) {
    throw new Error('Missing --source <Mori v1 user data dir with the two real providers>, or for the key mode the '
      + `env vars ${missing.join(', ')}`);
  }
  if (arg('first') || arg('second')) throw new Error('--first and --second only apply with --source');
  ctx.keyMode = true;
  const built = await buildKeyData(ctx);
  if (!built) throw new Error('key mode: the data dir was not built through the UI (see the MP-27 setup checks)');
  ctx.keyOpenRouter = built.openrouter;
  return built;
}

/**
 * @brief Mori 启动之前的准备：临时项目与五个文件、复制数据目录（scratchModelData）、synthetic test setup（§14.1：
 *        分组作为默认范围、备份首选的 key 密文）与 MP-40 的准备（setupNoOff）。出错时抛出。
 * @param found findRealProviders 的结果
 * @param dir 要复制的数据目录（--source 或 key 方式建的）
 */
function prepareRun(ctx, found, dir) {
  Object.assign(ctx, found, { firstRef: `${found.first.id}/${found.first.models[0].id}`,
    secondRef: `${found.second.id}/${found.second.models[0].id}` });
  ctx.project = prepareProject('mori-v1-real-').project;
  addNotes(ctx.project);
  ctx.userData = scratchModelData(dir);
  ctx.cipher = prepareRealConfig(ctx.userData, found);
  // MP-40 的准备（§14.1 的 2026-10-24 补）：找 OpenRouter 的提供商，去掉复制出的配置里已有的两个免费模型；
  // --only MP-27 时不准备（ctx.noOff 一开始就是 null）
  if (!only) ctx.noOff = setupNoOff(ctx);
}

/** MP-27 的步骤（按顺序；一步出错时记一条失败、收尾，接着走下一步） */
const STEPS = [['probes', probes], ['normalChat', normalChat], ['switchAtStart', switchAtStart],
  ['backToFirst', (c) => backToFirst(c, 'after the switch at reply start')], ['switchMidReply', switchMidReply],
  ['backAgain', (c) => backToFirst(c, 'after the mid-reply switch')]];

/**
 * @brief 启动 Mori，按顺序走 MP-27 的步骤，再走 MP-40（有准备好时）；最后记页面错误的检查（MP-40 开始之后的记给
 *        MP-40）。启动 Mori 出错时抛出（各步里的错在这里记下，不抛出）。
 */
async function runSteps(ctx) {
  try {
    await startApp(ctx);
    for (const [name, step] of STEPS) {
      try {
        await step(ctx);
      } catch (error) {
        record(`MP-27 ${name}: flow`, false, errorLine(error, 400));
        await recover(ctx, name);
      }
    }
    if (ctx.noOff) {
      // 之后的页面错误记给 MP-40
      ctx.noOffFrom = ctx.pageErrors.length;
      await runNoOff(ctx);
    }
  } finally {
    const errors27 = ctx.pageErrors.slice(0, ctx.noOffFrom ?? ctx.pageErrors.length);
    record('MP-27 page has no errors', errors27.length === 0, errors27.slice(0, 3).join(' | '));
    if (ctx.noOffFrom !== undefined) {
      const errors40 = ctx.pageErrors.slice(ctx.noOffFrom);
      record('MP-40 page has no errors while the MP-40 steps run', errors40.length === 0,
        errors40.slice(0, 3).join(' | '));
    }
  }
}

/**
 * @brief 收尾（不管前面成功与否都做）：关掉 Mori；删掉复制出的数据目录与 key 方式建的目录里 Mori 加密保存的 key
 *        （credentials.json）。ctx.userData 只会是复制出的目录或 key 方式建的目录，不会是 --source 给的目录。
 */
async function cleanUp(ctx) {
  await ctx.app?.close().catch(() => {});
  if (ctx.project) console.log(`[v1-models-real] project in ${ctx.project}; data in ${ctx.userData}`);
  const kept = [];
  for (const folder of new Set([ctx.userData, ctx.keyDir].filter(Boolean))) {
    try {
      rmSync(join(folder, 'credentials.json'), { force: true });
    } catch (error) {
      kept.push(folder);
      console.error(`[v1-models-real] could not remove ${join(folder, 'credentials.json')}: ${errorLine(error, 300)}`);
    }
  }
  if (ctx.keyDir) {
    console.log(`[v1-models-real] key mode: data dir built in ${ctx.keyDir} (credentials.json `
      + `${kept.includes(ctx.keyDir) ? 'NOT removed, delete it by hand' : 'removed'})`);
  }
}

const ctx = { pageErrors: [], keyMode: false, noOff: only ? null : undefined };
let found = null;
let dir = null;
try {
  const data = await dataSource(ctx);
  dir = data.dir;
  found = findRealProviders(readJson(join(dir, 'model-config.json')), data.ids);
  record(`MP-27 setup: two real providers ${found.first.id} and ${found.second.id} and a key on the first`, true,
    `${found.first.name}, ${found.second.name}`
    + `${ctx.keyMode ? `; key mode: data dir built through the UI in ${dir}` : ''}`);
} catch (error) {
  record('MP-27 setup: the data dir has two real providers (spec §14.1)', false, errorLine(error, 600));
  if (!only) {
    record(NO_OFF_SETUP, false, 'not run: MP-40 runs on the copied data dir of MP-27 and its first provider (a model '
      + `with Off), and the MP-27 setup failed: ${errorLine(error, 400)}`);
  }
  if (!source && !ctx.keyMode) {
    console.error('[v1-models-real] usage: node tests/ui/v1-models-real.mjs --source <Mori v1 user data dir> '
      + '[--exe <Mori.exe>] [--first <id>] [--second <id>]');
    console.error(`[v1-models-real]   or (key mode) with ${Object.values(KEY_VARS).join(', ')} set: `
      + 'node tests/ui/v1-models-real.mjs [--exe <Mori.exe>]');
  }
}
try {
  if (found) {
    prepareRun(ctx, found, dir);
    await runSteps(ctx);
  }
} catch (error) {
  // 启动之前的准备或启动 Mori 出错（各步里的错已在 runSteps 里记下）：记一条失败；结果文件照写、密文照删（finally）
  record('MP-27 start: flow (temp project, copying the data dir, synthetic test setup, launching Mori)', false,
    errorLine(error, 600));
  if (ctx.noOff === undefined) {
    record(NO_OFF_SETUP, false, `not run: the MP-27 start failed before the MP-40 setup: ${errorLine(error, 400)}`);
  } else if (ctx.noOff && ctx.noOffFrom === undefined) {
    record('MP-40 start: flow', false, `not run: the MP-27 start failed: ${errorLine(error, 400)}`);
  }
} finally {
  await cleanUp(ctx);
  await sleep(200);
  process.exitCode = write(`v1-models-real${only ? '-mp27' : ''}${suffix}.json`) ? 0 : 1;
}
