// MP-27 真实模型走查（docs/specs/model-providers.md §14.1、§14.2）：真正的 Mori 对两个真实提供商（默认 DeepSeek 与 GLM），
// 全部经界面操作。准备与故障的做法见 v1-real-helpers.mjs（§14.1）：复制负责人的数据目录（只复制加密的文件，不读 key），
// 在复制出的 model-config.json 里建分组 [首选, 第二] 作为默认范围、给临时项目授权公网（synthetic test setup），
// 首选提供商 key 的密文另存到备用 ref。走查：
//   1. 两个真实模型的探针结果合理（models.get 的档案；设置 → Models 的档案摘要）。
//   2. 正常对话：首选回答，没有换模型提示、没有错误卡。
//   3. 段开始时换模型：在设置 → Models 里给首选加错的 key（sk-invalid）、删掉原来的 key，再发消息：真实的 401，同一个请求
//      发给第二个，对话流一行"Switched model: A → B · API key rejected"，没有错误卡。
//   4. 退出，把首选的 key 改指备用 ref，重新启动，打开同一个会话：下一段用回首选。
//   5. 段内换模型：让模型一个一个读五个文件，回复开始后照 3 换 key：段内换到第二个并重做（提示带
//      "The new model redoes this reply."），之前的工具卡仍显示，没有错误卡。
//   6. 再照 4 恢复并重新启动：重新打开后换模型提示仍在，下一段用回首选。
// 每一步的实际模型从会话文件里助手消息的 provider / model 读（包装后的流函数原样转发实际模型的消息，§11.2）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--first <id>] [--second <id>]
// 结果写到 test-results/v1-models-real(-packaged).json，截图在 test-results/v1-models-real(-packaged)/。
// 没有第二个真实提供商时停下来报告（MP-27 记为失败，§14.1）。

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import { PANE, rowOf, waitReady } from './m3-helpers.mjs';
import { pageHelpers } from './page.mjs';
import {
  activeSessionFile, addNotes, assistantMessages, cardCounts, customEntries, findRealProviders, injectWrongKey,
  openModelsSettings, openProjectFolder, prepareRealConfig, profileProblems, rangeButton, readJson,
  restoreFirstKey, scratchModelData, sourceProblems, switchNotices, TEST_GROUP, waitProfiles,
} from './v1-real-helpers.mjs';

const source = arg('source') ? resolve(arg('source')) : null;
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/v1-models-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 走查里发的文字 */
const PROMPTS = {
  HELLO: '用一句话介绍你自己。不要调用任何工具。',
  START: '用一句话说说今天适合做什么。不要调用任何工具。',
  BACK: '用一句话说说你是哪个模型。不要调用任何工具。',
  MULTI: '请依次读取 notes-1.md、notes-2.md、notes-3.md、notes-4.md、notes-5.md 这五个文件：每次只调用一次 read 工具，'
    + '读完一个再读下一个，不要同时调用多个工具。全部读完后用一句话说明它们的共同点。不要修改任何文件，不要运行命令。',
  AGAIN: '用一句话总结我们刚才做了什么。不要调用任何工具。',
};

/** @brief 启动 Mori，等侧栏出现。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
  await ctx.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
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

/** @brief 设置 → Models：两个模型的档案合理（models.get），模型行的档案摘要显示 Tool calling: Verified。 */
async function probes(ctx) {
  const info = await waitProfiles(ctx.page, [ctx.firstRef, ctx.secondRef]);
  await openModelsSettings(ctx.page);
  for (const [provider, ref] of [[ctx.first, ctx.firstRef], [ctx.second, ctx.secondRef]]) {
    const problems = profileProblems(info.profiles[ref], provider.models[0].contextWindow);
    const row = ctx.page.locator(`[data-testid="model-row"][data-model="${ref}"]`);
    await row.scrollIntoViewIfNeeded();
    const shown = await row.locator('[data-field="tool_calling"]').getAttribute('data-value', { timeout: 10000 })
      .catch(() => null);
    const p = info.profiles[ref];
    record(`MP-27 probe results for ${ref} are plausible: probed, tool calling verified, a handoff tier, `
      + 'an effective window within the declared one, a known reasoning field and server kind; the Models row '
      + 'shows "Verified"',
    problems.length === 0 && shown === 'verified', JSON.stringify({ problems, shown, server: p?.server,
      tier: p?.tier?.level, context: p?.context, reasoning: p?.reasoning, cancel: p?.cancel_verified }));
  }
  await shot(ctx.page, '01-profiles');
  await ctx.page.getByTestId('settings-page').getByRole('button', { name: '返回会话' }).click();
  await ctx.page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 正常对话：新会话在默认范围（分组）里由首选回答，没有换模型提示、没有错误卡。 */
async function normalChat(ctx) {
  await openProjectFolder(ctx.app, ctx.page, ctx.project);
  ctx.sessionFile = await activeSessionFile(ctx.page);
  const button = await rangeButton(ctx.page);
  const turn = await sendAndWait(ctx, PROMPTS.HELLO);
  await shot(ctx.page, '02-normal');
  record(`MP-27 normal chat: the new session's range is ${TEST_GROUP} with ${ctx.firstRef} first (top bar `
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
  const want = `Switched model: ${ctx.firstRef} → ${ctx.secondRef} · API key rejected The new model redoes this reply.`;
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

const ctx = { pageErrors: [] };
let found = null;
try {
  if (!source) throw new Error('Missing --source <Mori v1 user data dir with the two real providers>');
  const problems = sourceProblems(source);
  if (problems.length) throw new Error(problems.join('; '));
  found = findRealProviders(readJson(join(source, 'model-config.json')),
    { first: arg('first'), second: arg('second') });
  record(`MP-27 setup: two real providers ${found.first.id} and ${found.second.id} with confirmed zones and a key on `
    + 'the first', true, `${found.first.name} (${found.first.zone}), ${found.second.name} (${found.second.zone})`);
} catch (error) {
  record('MP-27 setup: the data dir has two real providers (spec §14.1)', false, oneLine(error, 600));
}
if (found) {
  Object.assign(ctx, found, { firstRef: `${found.first.id}/${found.first.models[0].id}`,
    secondRef: `${found.second.id}/${found.second.models[0].id}` });
  const made = prepareProject('mori-v1-real-');
  ctx.project = made.project;
  addNotes(ctx.project);
  ctx.userData = scratchModelData(source);
  // synthetic test setup（§14.1）：分组作为默认范围、给临时项目授权公网、备份首选的 key 密文。
  ctx.cipher = prepareRealConfig(ctx.userData, found, [ctx.project]);
  const steps = [['probes', probes], ['normalChat', normalChat], ['switchAtStart', switchAtStart],
    ['backToFirst', (c) => backToFirst(c, 'after the switch at reply start')], ['switchMidReply', switchMidReply],
    ['backAgain', (c) => backToFirst(c, 'after the mid-reply switch')]];
  try {
    await startApp(ctx);
    for (const [name, step] of steps) {
      try {
        await step(ctx);
      } catch (error) {
        record(`MP-27 ${name}: flow`, false, oneLine(error, 400));
        await recover(ctx, name);
      }
    }
  } finally {
    record('MP-27 page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
    await ctx.app?.close().catch(() => {});
    console.log(`[v1-models-real] project in ${ctx.project}; data in ${ctx.userData}`);
    rmSync(join(ctx.userData, 'credentials.json'), { force: true });
  }
}
await sleep(200);
process.exitCode = write(`v1-models-real${suffix}.json`) ? 0 : 1;
