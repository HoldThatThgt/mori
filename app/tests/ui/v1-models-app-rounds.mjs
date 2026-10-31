// v1 模型层的整机测试（两段探针，2026-10-31 补丁）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint，synthetic），覆盖 docs/specs/model-providers.md §7.8 与 §14.2 中 MP-42、MP-43、MP-44 在 App 层的
// 通过条件。界面状态见 docs/v1/screens/models-settings.md "Models 行"的 2026-10-31 两行。
// 合成端点的行为（§14.1 的 2026-10-31 补）：探针合并后不再收到“ready”提示；图片探针 -vision 回 "Red."，其他回
// "I can’t see any image."；-slowtier 的后台一段晚 FAKE_SLOW_TIER_MS 回响应头；FAKE_LIMITED_KEYS=none 时没有 key 的请求回 429，
// FAKE_LIMIT_MS 后恢复。探针请求经本进程的转发代理记下请求体，按 server.mjs 的 probeStep 认出是哪一步（图片为 8）。
// 场景（每个用一个新的数据目录和自己的合成端点，可以用 --only 只跑其中几个）：
//   rounds（MP-42）：没勾 Supports thinking 的 fake-coder 与勾了的 fake-coder 各在一个端点，启动时自动探测：请求的步与个数、
//     没有“ready”提示；Add provider 的清单底部写“up to 10”。
//   slowtier（MP-42）：fake-coder-slowtier 的后台一段晚 45 秒回答：这期间模型行没有状态行、新会话没有拒绝启动卡、发送有回答；
//     之后档案有等级、phase 为 all。
//   retry（MP-43）：没有 key 的请求 25 秒内都是 429：第一次探测出错，模型行“Couldn’t verify: …”和 Verify again；什么都不点，
//     1 分钟后自动再跑、通过，状态行消失。
//   vision（MP-44）：fake-coder-vision（没勾 Image input）与 fake-coder：前者后台一段之后配置里有 image、Edit 里 Image input
//     勾着、没有第二组探针；后者配置不变、vision 为 failed。
// 用法（在 app/ 下，先 npx electron-vite build）：
//   node tests/ui/v1-models-app-rounds.mjs [--exe <Mori.exe 路径>] [--only rounds,slowtier,retry,vision]
// 结果写到 test-results/v1-models-app-rounds(-packaged).json，截图在 test-results/v1-models-app-rounds(-packaged)/。
// 端口：本套件独用 5100–5129（代理在 5100–5104，合成端点在 +10）。
// 启动前写进数据目录的 model-config.json 是 synthetic test setup（测试准备）；这里的提供商都没有 key。

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { until } from './m3-helpers.mjs';
import { cardScope, fetchIn, PROVIDER_FORM } from './page.mjs';
import { blockedState, makeProject, model, provider, readConfig, seedConfig, startEndpoint }
  from './v1-models-session-setup.mjs';
import { errorCount, modelsInfo, openProject, probeStepsOf, profileRow, profilesWhen, rowWhen, sendTurn, startApp,
  stopApp, storedProfile, toChat, toModels } from './v1-models-rounds-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/v1-models-app-rounds${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 本套件的端口（代理；合成端点在 +10） */
const PORT = { plain: 5100, think: 5101, slowtier: 5102, retry: 5103, vision: 5104 };
/** 探针代价的说明（model-discovery.md §6.1 第 8 项，2026-10-31 改） */
const COST_NOTE = 'Each model is verified with up to 10 short requests.';
/** 后台一段的步（server.mjs：第 5、6、7 步与图片探针 8） */
const BACKGROUND = [5, 6, 7, 8];
/** @brief 检查失败时的说明。 */
const brief = (value) => oneLine(JSON.stringify(value), 600);
/** @brief 档案已完成验证（不在探测中，有完成时刻，tool calling 已验证）。 */
const verified = (profile) => Boolean(profile) && profile.status !== 'probing' && profile.probedAt !== null
  && profile.tool_calling?.state === 'verified';
/** @brief model-profiles.json 里这个模型的档案已存到两段（phase all）。 */
const bothPhases = (ctx, ep, id) => storedProfile(ctx, ep.url, id)?.auto.phase === 'all';

// ---------- rounds（MP-42） ----------

/** @brief 场景 rounds：两种模型的请求、没有 ready 提示、清单底部的说明。 */
async function roundsScenario(ctx) {
  const plain = await startEndpoint(ctx, PORT.plain);
  const think = await startEndpoint(ctx, PORT.think);
  // synthetic test setup：plain/fake-coder 没勾 Supports thinking；think/fake-coder 勾了；启动时自动探测
  seedConfig(ctx, { providers: [provider('plain', 'Plain', plain.url, [model('fake-coder')]),
    provider('think', 'Think', think.url, [model('fake-coder', { reasoning: true })])], normalDefault: 'plain' });
  await startApp(ctx, exePath);
  await profilesWhen(ctx.page, (all) => verified(all['plain/fake-coder']) && verified(all['think/fake-coder']),
    'both models verified');
  await until(async () => bothPhases(ctx, plain, 'fake-coder') && bothPhases(ctx, think, 'fake-coder'), 60000, 500);
  const steps = probeStepsOf(plain, 'fake-coder');
  record('MP-42 fake-coder (no thinking) at start: the fake endpoint got round 1 (1 request, step 3), round 2 '
    + '(1 request, step 4) and the background (3 requests: steps 5, 6 and the image), 5 in all',
  steps.length === 5 && steps[0] === 3 && steps[1] === 4
    && [...steps.slice(2)].sort().join() === [5, 6, 8].join(), brief(steps));
  const thinking = probeStepsOf(think, 'fake-coder');
  record('MP-42 fake-coder with Supports thinking: round 1 is 2 requests (step 3 off and medium), round 2 is 2 '
    + '(step 4 with and without the reasoning), then the background', thinking.slice(0, 4).join() === '3,3,4,4'
    && thinking.length === 7 && thinking.slice(4).every((step) => BACKGROUND.includes(step)), brief(thinking));
  const ready = [...plain.bodies, ...think.bodies]
    .filter((body) => body.lastUser.includes('Reply with the single word'));
  record('MP-42 no probe request carries the old "Reply with the single word: ready." prompt', ready.length === 0,
    `${ready.length} found`);
  const all = (await modelsInfo(ctx.page)).profiles;
  record('MP-42 after the background round the profiles have tier A and the stored phase is all',
    all['plain/fake-coder']?.tier?.level === 'A' && all['think/fake-coder']?.tier?.level === 'A',
  brief([all['plain/fake-coder']?.tier?.level, all['think/fake-coder']?.tier?.level]));
  await costNoteStep(ctx, plain);
}

/** @brief Add provider：填 Base URL、Fetch models，清单底部的探针代价说明；关掉表单不保存。 */
async function costNoteStep(ctx, ep) {
  const { page } = ctx;
  await toModels(page);
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(ep.url);
  await fetchIn(page, PROVIDER_FORM);
  const note = (await form.getByTestId('probe-cost-note').textContent())?.trim();
  record(`MP-42 Add provider: the checklist footer says "${COST_NOTE}"`, note === COST_NOTE, note ?? 'none');
  await form.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await form.waitFor({ state: 'detached', timeout: 10000 });
  // 卡上的 Fetch models（model-discovery.md §6.5）：清单底部同 Add provider
  const card = cardScope('plain');
  await fetchIn(page, card);
  const cardNote = (await page.locator(`${card} [data-testid="probe-cost-note"]`).textContent())?.trim();
  record(`MP-42 the card’s Fetch models: the checklist footer says "${COST_NOTE}"`, cardNote === COST_NOTE,
    cardNote ?? 'none');
  await page.locator(`${card} .card-checklist`).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator(`${card} .card-checklist`).waitFor({ state: 'detached', timeout: 10000 });
  await toChat(page);
}

// ---------- slowtier（MP-42） ----------

/** 后台一段晚回答的毫秒数（远大于打开项目、发一条消息的时间） */
const SLOW_TIER_MS = 45000;

/** @brief 场景 slowtier：必需一段过了就能用，后台一段之后有等级。 */
async function slowTierScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT.slowtier, { FAKE_SLOW_TIER_MS: String(SLOW_TIER_MS) });
  const ref = 'slow/fake-coder-slowtier';
  // synthetic test setup：fake-coder-slowtier 是默认范围；启动时自动探测，后台一段的请求 45 秒后才回答
  seedConfig(ctx, { providers: [provider('slow', 'Slow', ep.url, [model('fake-coder-slowtier')])],
    normalDefault: 'slow' });
  await startApp(ctx, exePath);
  const profiles = await profilesWhen(ctx.page, (all) => verified(all[ref]), 'the essentials', 60000);
  const stored = storedProfile(ctx, ep.url, 'fake-coder-slowtier');
  record('MP-42 slowtier: once the essentials pass the profile is stored with phase essentials and tool calling '
    + 'verified while the background requests are still unanswered', stored?.auto.phase === 'essentials'
    && profiles[ref].tier.level === null, brief({ phase: stored?.auto.phase, tier: profiles[ref].tier.level }));
  await toModels(ctx.page);
  const row = await rowWhen(ctx.page, ref, (item) => item.status === null);
  record('MP-42 slowtier: during the background round the model row has no status line (data-probe reverifying)',
    row?.status === null && row.probe === 'reverifying', brief(row));
  await toChat(ctx.page);
  await openProject(ctx, makeProject(ctx, 'proj'));
  const blocked = await blockedState(ctx.page);
  const mark = ep.bodies.length;
  await sendTurn(ctx.page, 'plain hello', 60000);
  const talked = ep.bodies.slice(mark).filter((body) => !body.probe && !body.summary);
  const still = storedProfile(ctx, ep.url, 'fake-coder-slowtier')?.auto.phase;
  record('MP-42 slowtier: a new session whose range is the model has no "can’t start" card, and sending gets an '
    + 'answer before the background round ends', blocked === null && talked.length > 0 && still === 'essentials'
    && (await errorCount(ctx.page)) === 0, brief({ blocked, talked: talked.length, phase: still }));
  await until(async () => bothPhases(ctx, ep, 'fake-coder-slowtier'), SLOW_TIER_MS + 60000, 1000);
  const after = (await modelsInfo(ctx.page)).profiles[ref];
  record('MP-42 slowtier: after the background round the same profile has tier A and phase all',
    after?.tier?.level === 'A' && bothPhases(ctx, ep, 'fake-coder-slowtier'), brief(after?.tier));
}

// ---------- retry（MP-43） ----------

/** 没有 key 的请求被限流的毫秒数（第一次探测在这期间，1 分钟后的自动重试在这之后） */
const LIMIT_MS = 25000;

/** @brief 场景 retry：429 让第一次探测出错，1 分钟后自动再跑并通过。 */
async function retryScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT.retry, { FAKE_LIMITED_KEYS: 'none', FAKE_LIMIT_MS: String(LIMIT_MS) });
  const ref = 'limited/fake-coder';
  // synthetic test setup：没有 key 的提供商；合成端点对不带 key 的请求 25 秒内都回 429
  seedConfig(ctx, { providers: [provider('limited', 'Limited', ep.url, [model('fake-coder')])],
    normalDefault: 'limited' });
  await startApp(ctx, exePath);
  await toModels(ctx.page);
  const failed = await rowWhen(ctx.page, ref, (row) => row.status?.state === 'error', 30000);
  const firstAt = Date.now();
  record('MP-43 retry: the first probe set fails with the 429, the model row says "Couldn’t verify: …" with '
    + 'Verify again', failed?.status?.text.startsWith('Couldn’t verify: ') && failed.verifyAgain, brief(failed));
  const firstSets = probeStepsOf(ep, 'fake-coder').filter((step) => step === 3).length;
  const cleared = await rowWhen(ctx.page, ref, (row) => row.status === null, 120000);
  const waited = Date.now() - firstAt;
  const sets = probeStepsOf(ep, 'fake-coder').filter((step) => step === 3).length;
  record('MP-43 retry: without any click, about a minute after the failure the probes run again and pass; the '
    + 'status line is gone and the fake endpoint got a second probe set', cleared?.status === null
    && cleared.probe !== 'unverified' && sets > firstSets && waited > 20000,
  brief({ cleared, firstSets, sets, waited }));
  const profile = (await modelsInfo(ctx.page)).profiles[ref];
  record('MP-43 retry: the profile is ready with tool calling verified', verified(profile)
    && profile.status === 'ready', brief({ status: profile?.status, tool: profile?.tool_calling?.state }));
}

// ---------- vision（MP-44） ----------

/** @brief 场景 vision：图片探针通过时打开 Image input，不通过时配置不变。 */
async function visionScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT.vision);
  // synthetic test setup：两个模型都没勾 Image input
  seedConfig(ctx, { providers: [provider('plain', 'Plain', ep.url, [model('fake-coder-vision'),
    model('fake-coder')])], normalDefault: 'plain' });
  await startApp(ctx, exePath);
  await profilesWhen(ctx.page, (all) => verified(all['plain/fake-coder-vision']) && verified(all['plain/fake-coder']),
    'both models verified');
  await until(async () => bothPhases(ctx, ep, 'fake-coder-vision') && bothPhases(ctx, ep, 'fake-coder'), 60000, 500);
  await until(async () => readConfig(ctx).providers[0].models[0].input.includes('image'), 15000, 500);
  const models = readConfig(ctx).providers[0].models;
  const profiles = (await modelsInfo(ctx.page)).profiles;
  record('MP-44 vision: after the background round fake-coder-vision has image input in model-config.json and '
    + 'vision verified; fake-coder stays text only with vision failed', models[0].input.join() === 'text,image'
    && models[1].input.join() === 'text' && profiles['plain/fake-coder-vision']?.vision === 'verified'
    && profiles['plain/fake-coder']?.vision === 'failed', brief({ inputs: models.map((item) => item.input),
    vision: [profiles['plain/fake-coder-vision']?.vision, profiles['plain/fake-coder']?.vision] }));
  await sleep(5000);
  const sets = probeStepsOf(ep, 'fake-coder-vision').filter((step) => step === 3).length;
  record('MP-44 vision: turning image input on did not start a second probe set', sets === 1, `${sets} sets`);
  await editImageStep(ctx);
}

/** @brief Edit 里 fake-coder-vision 的 Image input 勾着、fake-coder 的没勾；关掉表单不保存。 */
async function editImageStep(ctx) {
  const { page } = ctx;
  await toModels(page);
  const checked = async (ref) => {
    await page.locator(`[data-testid="model-row"][data-model="${ref}"] [data-action="edit"]`).click();
    const form = page.getByTestId('model-form');
    await form.waitFor({ timeout: 10000 });
    const value = await form.getByLabel('Image input', { exact: true }).isChecked();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 10000 });
    return value;
  };
  const vision = await checked('plain/fake-coder-vision');
  const plain = await checked('plain/fake-coder');
  const row = await profileRow(page, 'plain/fake-coder-vision');
  record('MP-44 vision: Edit shows Image input checked for fake-coder-vision and unchecked for fake-coder; the row '
    + 'has no status line', vision === true && plain === false && row?.status === null, brief({ vision, plain, row }));
  await toChat(page);
}

// ---------- 运行 ----------

const SCENARIOS = { rounds: [roundsScenario, 'MP-42'], slowtier: [slowTierScenario, 'MP-42'],
  retry: [retryScenario, 'MP-43'], vision: [visionScenario, 'MP-44'] };

for (const [name, [scenario, mp]] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(name)) continue;
  const ctx = { name, mp, eps: [], pageErrors: [], app: null, page: null,
    userData: mkdtempSync(join(tmpdir(), `mori-v1r-${name}-data-`)),
    root: mkdtempSync(join(tmpdir(), `mori-v1r-${name}-`)) };
  console.log(`[v1-models-app-rounds] ${name}: data in ${ctx.userData}, projects in ${ctx.root}`);
  try {
    await scenario(ctx);
  } catch (error) {
    record(`${mp} ${name}: flow`, false, oneLine(error?.stack ?? error, 600));
    await shot(ctx.page, `${name}-error`);
  } finally {
    record(`${mp} ${name}: the page reported no errors`, ctx.pageErrors.length === 0,
      ctx.pageErrors.slice(0, 3).join(' | '));
    await stopApp(ctx);
    for (const ep of ctx.eps) await ep.stop().catch(() => {});
  }
}
await sleep(200);
process.exitCode = write(`v1-models-app-rounds${suffix}.json`) ? 0 : 1;
