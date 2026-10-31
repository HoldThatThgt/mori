// v1 模型层的整机测试（思考关不掉的模型，2026-10-24 补丁）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点
// （tests/fake-endpoint，synthetic），覆盖 docs/specs/model-providers.md §7.7 与 §14.2 中 MP-38、MP-39 在 App 层的通过条件。
// 界面文字、状态与标识见 docs/v1/screens/models-settings.md、model-menu.md、memory-enhance.md 的 2026-10-24 行与
// "测试要用的标识"，文字见 docs/v0/ui-strings.md。
// 合成端点的行为（§14.1，2026-10-24 补）：-nooff 模型对明确的"关闭思考"（OpenRouter 写法 reasoning.effort "none"）回 400；
// pi 只在地址含 openrouter.ai 时用 OpenRouter 的写法，所以思考关不掉的提供商地址写 http://127.0.0.1:<端口>/openrouter.ai/v1；
// -thinklong 的探针开着思考时只回超过 256 token 的思考、以 finish_reason "length" 结束；对话请求的日志行带 "reasoning"
// （是否带思考参数）与 "effort"（reasoning_effort ?? reasoning.effort ?? null）。Mori 直连合成端点（没有转发代理），
// 请求里的思考参数从合成端点的日志行读。
// 场景（每个用一个新的数据目录和自己的合成端点，可以用 --only 只跑其中几个）：
//   probe（MP-38）：经设置页的 Add provider 加 fake-coder-nooff（OpenRouter 前缀地址、勾 Supports thinking），档案与模型行、
//     再跑一次自动探针（经进程桥发 models.verify）后同样的结果且第 2 步真的重新测了；经卡上的 Fetch models 加
//     fake-coder-thinklong（普通地址、勾 Supports thinking），档案出错"Stopped at the probe output limit before answering"、
//     tool calling 仍验证通过，模型行没有状态行；经卡上的 Fetch models 加 fake-coder-alwaysthink（普通地址、勾 Supports
//     thinking），思考关不掉但 Off 没被拒绝（can_disable 为假、off_refused 为假），模型行没有"Thinking can’t be turned off"。
//     2026-10-26 补（models-settings.md “Models 行”的出错写法）：fake-coder-toollong（第 3、4 步停在输出上限）的状态行
//     “Couldn’t verify: Stopped at the probe output limit before answering”；router 上的 -offlong、-offsilent（关闭思考被拒、
//     开思考的 medium 出错或没有正文）的状态行与没有“Thinking can’t be turned off”；最后重启 Mori，把 fake-coder-nooff 的
//     档案改成补丁之前的样子：启动时就按 §7.7 重新测并通过（2026-10-31 起，规格 §7.8：档案有出错的步的模型启动时再跑一次）。
//   effort（MP-39）：输入框下面一行的 Effort 菜单（没有标记的模型仍有 Off、Off 时不带思考参数；fake-coder-nooff 没有 Off、
//     有说明；原来是 Off 的会话显示 Minimal、请求带 minimal、没有 400）、提供商卡的 Test connection（带 medium）、模型表单
//     （Edit）的 Default effort for new sessions、默认强度是 Off 的新会话、增强设置对话框的 Effort。
// 2026-10-26（WP-02，负责人走查 M7，models-settings.md "Models 行"）：模型行没有档案摘要、Verify 与 Test；"Thinking can’t be
//   turned off"在说明一行最后（data-field="thinking_off"），tool calling 读行上的 data-probe，状态行只在模型不能用时有。
// 用法（在 app/ 下，先 npx electron-vite build）：
//   node tests/ui/v1-models-app-nooff.mjs [--exe <Mori.exe 路径>] [--only probe,effort]
// 结果写到 test-results/v1-models-app-nooff(-packaged).json，截图在 test-results/v1-models-app-nooff(-packaged)/。
// 端口：本套件独用 4900–4919（effort 4900，probe 4901）。
// 启动前写进数据目录的 model-config.json 与 pi/settings.json 是 synthetic test setup（测试准备），代码里逐处注明；
// 这里的提供商都没有 key。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import { ctrlN, lastReply, PANE, paneOf, settle, stubFolder, until, waitIdle, waitReady } from './m3-helpers.mjs';
import { cardAddModels, fetchIn, pickIn, PROVIDER_FORM } from './page.mjs';
import { pickers } from './v1-models-row-helpers.mjs';
import { makeProject, model, provider, readConfig, seedConfig, seedPiSettings, startEndpoint }
  from './v1-models-session-setup.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/v1-models-app-nooff${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 本套件的端口（4900–4919）：每个场景一个合成端点 */
const PORT = { effort: 4900, probe: 4901 };
/** 合成端点的模型：思考关不掉、探针停在输出上限、总在思考（关思考时什么也不发的地址上照常回答，不拒绝 Off） */
const NOOFF = 'fake-coder-nooff';
const THINKLONG = 'fake-coder-thinklong';
const ALWAYSTHINK = 'fake-coder-alwaysthink';
/**
 * 2026-10-26 补（synthetic，server.mjs 开头）：第 3、4 步停在输出上限；-nooff 拒绝关闭思考后第 2 步的 medium 停在输出上限
 * 或只有思考、没有正文
 */
const TOOLLONG = 'fake-coder-toollong';
const OFFLONG = 'fake-coder-nooff-offlong';
const OFFSILENT = 'fake-coder-nooff-offsilent';
/** 本套件的模型全名（提供商 id 由名称生成：Router → router；plain 由测试准备写好） */
const REF = { plain: 'plain/fake-coder', nooff: `router/${NOOFF}`, thinklong: `plain/${THINKLONG}`,
  alwaysthink: `plain/${ALWAYSTHINK}`, toollong: `plain/${TOOLLONG}`, offlong: `router/${OFFLONG}`,
  offsilent: `router/${OFFSILENT}` };
/** -nooff 拒绝时服务原文里的一句（server.mjs 的 NOOFF_MESSAGE，2026-10-24 在 OpenRouter 上录下） */
const NOOFF_MESSAGE = 'Reasoning is mandatory for this endpoint and cannot be disabled.';
/** 模型行说明一行最后的一段（models-settings.md "Models 行"，2026-10-26 起；原来是档案摘要的"Thinking: Can’t be turned off"） */
const THINKING_OFF_TEXT = 'Thinking can’t be turned off';
/** Effort 菜单底部的说明（model-menu.md"思考关不掉"） */
const OFF_NOTE = 'This model can’t turn thinking off.';
/** 停在探针输出上限的说明（§7.7） */
const LIMIT_DETAIL = 'Stopped at the probe output limit before answering';
/** 合成端点 "plain" 的回复 */
const PLAIN_REPLY = '这是一段只有文字的回复，用来测试流式输出。';
/** 测试连接结果的开头（models-settings.md"测试结果的文字"） */
const TEST_DONE = /^(Connected|Connection failed|Test cancelled|Couldn[’']t test)/;
/** 没有 Off 的模型的强度（pi 的七档去掉 Off，§7.7） */
const NO_OFF_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Default effort for new sessions 的标签（ui-strings.md） */
const LEVEL_FIELD = 'Default effort for new sessions';

/** @brief OpenRouter 前缀的地址（§14.1：pi 只在地址含 openrouter.ai 时用 OpenRouter 的写法）。 */
const routerUrl = (port) => `http://127.0.0.1:${port}/openrouter.ai/v1`;
/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 检查失败时的说明。 */
const brief = (value) => oneLine(JSON.stringify(value), 600);

// ---------- App ----------

/** @brief 用 ctx.userData 启动 Mori，等左栏出来。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByRole('button', { name: 'Open folder…', exact: true }).first().waitFor({ timeout: 60000 });
}

/** @brief 关掉 Mori。 */
async function stopApp(ctx) {
  if (!ctx.app) return;
  await ctx.app.close().catch(() => {});
  ctx.app = null;
}

/** @brief 经进程桥发一条命令（只用于读状态：models.get、enhance.get）。 */
const bridge = (page, command) => page.evaluate((item) => window.mori.request(item), command);
/** @brief models.get 的结果。 */
const modelsInfo = (page) => bridge(page, { type: 'models.get' });
/** @brief 档案已完成一组探针（不在探测中，有完成时刻）。 */
/**
 * @brief 档案已完成一组探针（不在探测中，有完成时刻）；tool calling 验证通过的还要等后台一段跑完（规格 §7.8：必需一段过了
 *        先存档案，第 5 步在后台一段之后才不是 not_run）。
 */
const finished = (profile) => Boolean(profile) && profile.status !== 'probing' && profile.probedAt !== null
  && (profile.tool_calling?.state !== 'verified' || profile.tier?.a?.outcome !== 'not_run');
/**
 * @brief 档案已完成一组探针且 tool_calling 已验证，后台一段也跑完了（规格 §7.8：必需一段过了先存档案，等级等后台一段；
 *        后台一段跑完后第 5 步不再是 not_run）。
 */
const verified = (profile) => finished(profile) && profile.tool_calling?.state === 'verified'
  && profile.tier?.a?.outcome !== 'not_run';

/** @brief 等 refs 的档案都满足 done，返回最后一次读到的全部档案；等不到时抛错。 */
async function waitProfiles(page, refs, done = verified, timeout = 180000) {
  let last = {};
  const ok = await until(async () => {
    last = (await modelsInfo(page)).profiles ?? {};
    return refs.every((ref) => done(last[ref]));
  }, timeout, 500);
  if (!ok) {
    const states = refs.map((ref) => `${ref}=${last[ref]?.status ?? 'none'}/${last[ref]?.tool_calling?.state ?? '-'}`);
    throw new Error(`profiles not ready: ${states.join(', ')}`);
  }
  return last;
}

/** @brief 点"Open folder…"打开 folder（会问信任时选"Trust workspace"），等新会话就绪。 */
async function openProject(ctx, folder) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: 'Open folder…', exact: true }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll('.pane-slot').length > count
    || Boolean(document.querySelector('[data-testid="trust-dialog"]')), before, { timeout: 30000 });
  const trust = page.getByTestId('trust-dialog');
  if (await trust.isVisible().catch(() => false)) {
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  }
  await waitReady(page);
  await settle(page);
}

/** @brief 打开设置页的 Models 分节（已经在那里时什么也不做）。 */
async function toModels(page) {
  if (await page.getByTestId('models-section').isVisible().catch(() => false)) return;
  await toChat(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
}

/** @brief 回到会话：设置页或记忆页开着时点它们的"Back to app"。 */
async function toChat(page) {
  for (const id of ['settings-page', 'memory-page']) {
    const view = page.getByTestId(id);
    if (!(await view.isVisible().catch(() => false))) continue;
    await view.getByRole('button', { name: 'Back to app', exact: true }).click();
    await view.waitFor({ state: 'detached', timeout: 10000 });
  }
  if (await paneOf(page).count() > 0) await waitReady(page);
}

/** @brief 设置页 Models 分节里的一个模型行。 */
const modelRow = (page, ref) => page.locator(`[data-testid="model-row"][data-model="${ref}"]`);

/**
 * @brief 模型行此刻的样子（models-settings.md "Models 行"，2026-10-26 起没有档案摘要）：行上的 data-probe、说明一行、
 *        说明一行里"Thinking can’t be turned off"的文字（没有时为 null）、状态行（data-state 与文字，没有时为 null）；
 *        没有这一行时为 null。
 */
function profileRow(page, ref) {
  return page.evaluate((target) => {
    const row = document.querySelector(`[data-testid="model-row"][data-model="${target}"]`);
    if (!row) return null;
    const meta = row.querySelector('.model-meta');
    const status = row.querySelector('[data-testid="probe-status"]');
    return { probe: row.dataset.probe ?? null, meta: meta?.textContent ?? '',
      thinkingOff: meta?.querySelector('[data-field="thinking_off"]')?.textContent ?? null,
      status: status && { state: status.dataset.state, text: status.textContent } };
  }, ref);
}

/** @brief 等模型行满足 test（mori.profiles 到了之后界面才更新），最多 10 秒；返回最后读到的样子。 */
async function rowWhen(page, ref, test) {
  let row = null;
  await until(async () => {
    row = await profileRow(page, ref);
    return Boolean(row) && test(row);
  }, 10000, 200);
  return row;
}

/** @brief 当前一栏的输入框与用户消息条数、错误卡条数。 */
const composer = (page) => paneOf(page).locator('.composer textarea');
const userCount = (page) => paneOf(page).getByTestId('user-message').count();
const errorCount = (page) => paneOf(page).getByTestId('error-card').count();

/** @brief 发一条消息，等它显示出来，再等本轮结束。 */
async function sendTurn(page, text, timeout = 120000) {
  const before = await userCount(page);
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await until(async () => (await userCount(page)) > before, 10000, 100);
  await waitIdle(page, timeout);
}

/** @brief 在当前一栏输入框下面一行的范围菜单里选 pick，等按钮显示它、不再切换中。 */
async function choosePick(page, pick) {
  await paneOf(page).getByTestId('model-button').click();
  await page.locator(`${PANE} [data-testid="model-menu"] [role="menuitemradio"][data-pick="${pick}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    return button?.dataset.pick === want && !button.getAttribute('aria-disabled');
  }, { selector: PANE, want: pick }, { timeout: 15000 });
}

/** @brief 在当前一栏的 Effort 菜单里选 level，等按钮的 data-level 变过去、不再切换中。 */
async function chooseThinking(page, level) {
  await paneOf(page).getByTestId('thinking-button').click();
  await paneOf(page).getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.level === want && button.dataset.pending !== 'true';
  }, { selector: PANE, want: level }, { timeout: 15000 });
}

/** @brief 等当前一栏 Effort 按钮的 data-level 为 level（最多 10 秒），返回此刻的按钮（pickers 的 thinking）。 */
async function effortWhen(page, level) {
  await until(async () => (await pickers(page))?.thinking?.level === level, 10000, 200);
  return (await pickers(page))?.thinking ?? null;
}

/**
 * @brief 打开当前一栏的 Effort 菜单，读它此刻的样子（model-menu.md"界面测试用的标识"）：强度项（data-level，按顺序）、
 *        打勾的项（aria-checked="true"）、有没有 [data-level="off"]、thinking-off-note 的文字（没有时为 null）与它是不是
 *        菜单项或能聚焦、菜单在不在这一栏输入框下面一行里；再按 Esc 关上。
 */
async function readEffortMenu(page) {
  await paneOf(page).getByTestId('thinking-button').click();
  const menu = paneOf(page).getByTestId('thinking-menu');
  await menu.waitFor({ timeout: 5000 });
  const facts = await menu.evaluate((el) => {
    const items = [...el.querySelectorAll('[role="menuitemradio"]')];
    const note = el.querySelector('[data-testid="thinking-off-note"]');
    return { levels: items.map((item) => item.dataset.level),
      checked: items.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.dataset.level),
      offItem: Boolean(el.querySelector('[data-level="off"]')), note: note?.textContent ?? null,
      noteInert: note ? !note.getAttribute('role') && note.tabIndex < 0 : null,
      inRow: Boolean(el.closest('[data-testid="composer"] .composer-bottom')) };
  });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return facts;
}

/** @brief 合成端点从下标 mark 起记下的、模型为 modelId 的对话请求日志行；probe 为 true / false 时只取探针 / 非探针。 */
const linesOf = (ep, mark, modelId, probe = null) => ep.log.slice(mark)
  .filter((line) => line.model === modelId && (probe === null || line.probe === probe));
/** @brief 日志行的简短说明。 */
const lineBrief = (lines) => lines.map((line) => `${line.probe ? 'probe' : 'chat'}:${line.status}:${line.effort}`
  + `:${line.reasoning}`).join(',');

/** @brief 一个场景里的一步：出错时记一条失败（以场景的编号开头）、截图，按 Esc，继续下一步。 */
async function step(ctx, label, fn) {
  try {
    await fn();
  } catch (error) {
    record(`${ctx.mp} ${ctx.name} / ${label}: flow`, false, oneLine(error?.message ?? error, 500));
    await shot(ctx.page, `${ctx.name}-${label.replace(/\W+/g, '-')}`);
    await ctx.page?.keyboard.press('Escape').catch(() => {});
  }
}

// ---------- 场景 probe：思考关不掉的判定与输出上限（MP-38 App） ----------

/**
 * @brief 设置页里新建提供商（Add provider 表单，model-discovery.md §6.1、§13.4）：Base URL → Fetch models → Name
 *        → 清单里只勾 specs（pickIn，可以改 Supports thinking）→ Add N models，等表单关掉。返回拉取的结果。
 */
async function addProviderUi(page, { name, baseUrl, specs }) {
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  const fetched = await fetchIn(page, PROVIDER_FORM);
  await form.getByLabel('Name', { exact: true }).fill(name);
  await pickIn(page, PROVIDER_FORM, specs);
  await form.locator('[data-action="add-models"]').click();
  await form.waitFor({ state: 'detached', timeout: 20000 });
  return fetched;
}

/**
 * @brief 思考关不掉的档案：ready、tool_calling verified、off_refused 为真、can_disable 为假（§7.7 第 2 步表第 3 行）；
 *        第 5 步不适用（tier.a 为 not_applicable），所以等级不是 A（models-settings.md"思考关不掉"）。
 */
const offRefusedProfile = (profile) => profile?.status === 'ready' && profile.tool_calling?.state === 'verified'
  && profile.reasoning?.off_refused === true && profile.reasoning.can_disable === false
  && profile.tier?.a?.outcome === 'not_applicable' && profile.tier.level !== 'A';
/**
 * @brief 模型行说明一行的最后是"Thinking can’t be turned off"（data-field="thinking_off"），tool calling 已验证
 *        （data-probe 为 verified，不是 verifying / reverifying），没有状态行（models-settings.md "Models 行""思考关不掉"）；
 *        即探测结束后的样子。
 */
const offRefusedRow = (row) => row?.thinkingOff === THINKING_OFF_TEXT
  && row.meta.endsWith(` · ${THINKING_OFF_TEXT}`) && row.probe === 'verified' && row.status === null;

/**
 * @brief 一组自动探针之后 fake-coder-nooff 的两条检查：档案（models.get）与模型行。
 * @param when 检查名里的时机（added / after Verify）
 */
async function offRefusedChecks(page, profile, when) {
  record(`MP-38 fake-coder-nooff ${when}: profile ready, tool_calling verified, reasoning.off_refused true `
    + '(can_disable false), step 5 not applicable and tier not A in models.get', offRefusedProfile(profile),
  brief({ status: profile?.status, error: profile?.error, tool: profile?.tool_calling?.state,
    reasoning: profile?.reasoning, tier: profile?.tier }));
  const row = await rowWhen(page, REF.nooff, offRefusedRow);
  record(`MP-38 fake-coder-nooff ${when}: the settled model row (data-probe verified) ends its line with `
    + `" · ${THINKING_OFF_TEXT}" (data-field="thinking_off") and has no status line`, offRefusedRow(row), brief(row));
}

/** @brief Add provider 加入 fake-coder-nooff（OpenRouter 前缀地址、勾 Supports thinking），自动探测后的档案与模型行。 */
async function addNoOffStep(ctx, ep) {
  const { page } = ctx;
  await toModels(page);
  const mark = ep.log.length;
  const fetched = await addProviderUi(page, { name: 'Router', baseUrl: routerUrl(ep.port),
    specs: [{ id: NOOFF, reasoning: true }] });
  const router = readConfig(ctx).providers.find((item) => item.id === 'router');
  record('MP-38 Settings → Models → Add provider: "Router" at http://127.0.0.1:<port>/openrouter.ai/v1 with '
    + 'fake-coder-nooff picked from Fetch models and Supports thinking checked is saved', fetched.state === 'list'
    && router?.baseUrl === routerUrl(ep.port) && same(router.models.map((item) => [item.id, item.reasoning]),
    [[NOOFF, true]]), brief({ fetched, router: router ?? null }));
  const profiles = await waitProfiles(page, [REF.nooff], finished);
  await offRefusedChecks(page, profiles[REF.nooff], 'added');
  const lines = linesOf(ep, mark, NOOFF, true);
  const refused = lines.filter((line) => line.status === 400);
  const others = lines.filter((line) => line.status !== 400);
  record('MP-38 fake-coder-nooff added: the fake endpoint refused exactly one probe request with 400 (step 2\'s '
    + 'explicit off, effort none); every other probe request carried an effort and was answered',
  refused.length === 1 && refused[0].effort === 'none' && others.length > 0
    && others.every((line) => line.status === 200 && line.effort !== null && line.effort !== 'none'),
  lineBrief(lines));
}

/**
 * @brief 再跑一次自动探针：同样的结果，合成端点的日志里这次又有一个第 2 步关闭思考的 400。2026-10-26 起能用的模型行上没有
 *        Verify（models-settings.md "Models 行"），所以经进程桥发 models.verify（第 0–7 步，同拒绝启动卡的 Verify now 与
 *        状态行的 Verify again）。
 */
async function verifyNoOffStep(ctx, ep) {
  const { page } = ctx;
  await toModels(page);
  const before = (await modelsInfo(page)).profiles[REF.nooff]?.probedAt ?? 0;
  const mark = ep.log.length;
  const sent = await page.evaluate((command) => window.mori.request(command),
    { type: 'models.verify', refs: [REF.nooff] });
  const profiles = await waitProfiles(page, [REF.nooff], (profile) => finished(profile)
    && profile.probedAt > before);
  await offRefusedChecks(page, profiles[REF.nooff], 'after models.verify');
  const lines = linesOf(ep, mark, NOOFF, true);
  const refused = lines.filter((line) => line.status === 400 && line.effort === 'none');
  record('MP-38 models.verify re-tests step 2 on the unmarked copy: the fake endpoint logs a new explicit-off 400 '
    + '(effort none) for fake-coder-nooff, and the other probe requests carry an effort', sent?.error === null
    && refused.length === 1 && lines.filter((line) => line.status !== 400)
    .every((line) => line.status === 200 && line.effort !== null && line.effort !== 'none'), lineBrief(lines));
}

/** @brief 卡上的 Fetch models 加入 fake-coder-thinklong（普通地址、勾 Supports thinking）：停在探针输出上限。 */
async function thinkLongStep(ctx, ep) {
  const { page } = ctx;
  await toModels(page);
  const mark = ep.log.length;
  const added = await cardAddModels(page, 'plain', [{ id: THINKLONG, reasoning: true }]);
  if (added.error !== null) throw new Error(`add ${REF.thinklong}: ${added.error}`);
  const profile = (await waitProfiles(page, [REF.thinklong], finished))[REF.thinklong];
  const row = await rowWhen(page, REF.thinklong, (item) => item.probe === 'verified');
  record('MP-38 fake-coder-thinklong (plain address, Supports thinking) added on the card: the profile is error with '
    + `"${LIMIT_DETAIL}"`, profile.status === 'error' && profile.error === LIMIT_DETAIL,
  brief({ status: profile.status, error: profile.error }));
  record('MP-38 fake-coder-thinklong: tool calling is still verified (profile and the row\'s data-probe), so the model '
    + 'is usable and the row shows no status line and no "Thinking can’t be turned off" (2026-10-26)',
  row?.probe === 'verified' && row.status === null && row.thinkingOff === null
    && profile.tool_calling.state === 'verified' && profile.reasoning.off_refused === false,
  brief({ row, tool: profile.tool_calling, reasoning: profile.reasoning }));
  const lines = linesOf(ep, mark, THINKLONG, true);
  record('MP-38 fake-coder-thinklong: its probes were answered (no HTTP error), so the error is the output limit',
    lines.length > 0 && lines.every((line) => line.status === 200), lineBrief(lines));
}

/** @brief 模型行的 tool calling 不在探测中（data-probe 不是 verifying、reverifying，探测结束后的样子）。 */
const settledRow = (row) => Boolean(row.probe) && !['verifying', 'reverifying'].includes(row.probe);

/**
 * @brief 卡上的 Fetch models 加入 fake-coder-alwaysthink（普通地址、勾 Supports thinking）：思考关不掉但 Off 没被拒绝
 *        （§7.7 第 2 步表第 2 行：can_disable 为假、off_refused 为假），模型行说明一行里没有"Thinking can’t be turned off"
 *        （models-settings.md "Models 行"：为假时没有），用来把 off_refused 与 can_disable 为假分开。
 */
async function alwaysThinkStep(ctx, ep) {
  const { page } = ctx;
  await toModels(page);
  const mark = ep.log.length;
  const added = await cardAddModels(page, 'plain', [{ id: ALWAYSTHINK, reasoning: true }]);
  if (added.error !== null) throw new Error(`add ${REF.alwaysthink}: ${added.error}`);
  const profile = (await waitProfiles(page, [REF.alwaysthink], finished))[REF.alwaysthink];
  const row = await rowWhen(page, REF.alwaysthink, settledRow);
  record('MP-38 fake-coder-alwaysthink (plain address, Supports thinking): thinking can\'t be disabled but Off is not '
    + 'refused (profile can_disable false, off_refused false), and its settled row has no data-field="thinking_off"',
  profile.reasoning.can_disable === false && profile.reasoning.off_refused === false && Boolean(row)
    && settledRow(row) && row.thinkingOff === null && !row.meta.includes(THINKING_OFF_TEXT),
  brief({ reasoning: profile.reasoning, status: profile.status, row }));
  const lines = linesOf(ep, mark, ALWAYSTHINK, true);
  record('MP-38 fake-coder-alwaysthink: the plain address sends no explicit off, so none of its probe requests was '
    + 'refused (all 200)', lines.length > 0 && lines.every((line) => line.status === 200), lineBrief(lines));
}

/** @brief 状态行是出错的一类、文字正好是 text、带“Verify again”，行的 data-probe 为 unverified。 */
const errorRow = (row, text) => row?.probe === 'unverified' && row.status?.state === 'error'
  && row.status.text === `${text}Verify again`;

/**
 * @brief 停在探针输出上限、是第 3、4 步（models-settings.md “停在探针输出上限”，2026-10-26 补）：卡上的 Fetch models 加入
 *        fake-coder-toollong（普通地址、没勾 Supports thinking；合成端点第 3、4 步只回很长的思考、以 length 结束）：档案的
 *        tool calling 为 unverified、error 为“Stopped at the probe output limit before answering”，行的状态行
 *        “Couldn’t verify: Stopped at the probe output limit before answering”带 Verify again。
 */
async function toolLongStep(ctx) {
  const { page } = ctx;
  await toModels(page);
  const added = await cardAddModels(page, 'plain', [{ id: TOOLLONG }]);
  if (added.error !== null) throw new Error(`add ${REF.toollong}: ${added.error}`);
  const profile = (await waitProfiles(page, [REF.toollong], finished))[REF.toollong];
  const row = await rowWhen(page, REF.toollong, settledRow);
  record('MP-38 fake-coder-toollong (steps 3 and 4 stop at the probe output limit): tool calling is unverified with '
    + `the error "${LIMIT_DETAIL}", and the row's status line reads "Couldn’t verify: ${LIMIT_DETAIL}" with `
    + '"Verify again"',
  profile.tool_calling.state === 'unverified' && profile.status === 'error' && profile.error === LIMIT_DETAIL
    && errorRow(row, `Couldn’t verify: ${LIMIT_DETAIL}`), brief({ tool: profile.tool_calling, error: profile.error,
    row }));
}

/**
 * @brief 关不掉、开思考也没答上（models-settings.md 那一行，规格 §7.7 第 2 步表第 4 行，2026-10-26 补）：卡上的 Fetch models
 *        给 router（OpenRouter 前缀地址）加入两个勾 Supports thinking 的模型：-offlong 第 2 步的 medium 停在输出上限，
 *        -offsilent 第 2 步的 medium 只有思考、没有正文。两者第 2 步都出错、没判出 off_refused（can_disable unknown），
 *        之后关闭思考的第 3 步被拒，tool calling 没验证：状态行“Couldn’t verify: <说明>”（-offlong 是输出上限那一句，
 *        -offsilent 是 off 被拒的原文“400 …”），说明一行没有“Thinking can’t be turned off”。
 */
async function offFailedStep(ctx) {
  const { page } = ctx;
  await toModels(page);
  const added = await cardAddModels(page, 'router', [{ id: OFFLONG, reasoning: true },
    { id: OFFSILENT, reasoning: true }]);
  if (added.error !== null) throw new Error(`add ${OFFLONG}, ${OFFSILENT}: ${added.error}`);
  const profiles = await waitProfiles(page, [REF.offlong, REF.offsilent], finished);
  const unjudged = (profile) => profile.reasoning.off_refused === false && profile.reasoning.can_disable === 'unknown'
    && profile.tool_calling.state !== 'verified' && profile.status === 'error';
  const long = { profile: profiles[REF.offlong], row: await rowWhen(page, REF.offlong, settledRow) };
  record('MP-38 fake-coder-nooff-offlong (off refused, the medium request of step 2 stops at the output limit): no '
    + `off_refused (can_disable unknown), tool calling not verified, the status line reads "Couldn’t verify: `
    + `${LIMIT_DETAIL}" with "Verify again" and the line has no "${THINKING_OFF_TEXT}"`, unjudged(long.profile)
    && long.profile.error === LIMIT_DETAIL && errorRow(long.row, `Couldn’t verify: ${LIMIT_DETAIL}`)
    && long.row.thinkingOff === null, brief({ reasoning: long.profile.reasoning, error: long.profile.error,
    row: long.row }));
  const silent = { profile: profiles[REF.offsilent], row: await rowWhen(page, REF.offsilent, settledRow) };
  const raw = silent.profile.error ?? '';
  record('MP-38 fake-coder-nooff-offsilent (off refused, the medium request of step 2 has no text): no off_refused, '
    + 'tool calling not verified, the status line reads "Couldn’t verify: <the off request’s raw 400 text>" with '
    + `"Verify again" and the line has no "${THINKING_OFF_TEXT}"`, unjudged(silent.profile) && raw.startsWith('400')
    && raw.includes(NOOFF_MESSAGE) && errorRow(silent.row, `Couldn’t verify: ${raw}`)
    && silent.row.thinkingOff === null,
  brief({ reasoning: silent.profile.reasoning, error: raw, row: silent.row }));
}

/** 补丁之前的第 2 步：关闭思考被拒算出错时说明的前缀（§7.7 之后是不通过，说明为这个前缀加 off 的原文） */
const OFF_REFUSED_PREFIX = 'Thinking can’t be turned off: ';

/**
 * @brief 补丁之前验证失败的这类模型（models-settings.md 那一行，2026-10-24 补，2026-10-26 改为状态行；2026-10-31 改，
 *        规格 §7.8：后台进程启动时档案有出错的步的模型自动再跑一次）：关掉 Mori，把 router/fake-coder-nooff 的档案改成
 *        补丁之前的样子（synthetic test setup：没有 auto.offRefused，第 2 步关闭思考被 400 拒绝算出错、第 3 步同样出错；
 *        键、指纹与服务版本不动），再启动：不用点 Verify again，启动时就按 §7.7 重新测（合成端点多一个 effort none 的 400），
 *        之后行为 verified、没有状态行、说明一行以“ · Thinking can’t be turned off”结尾。
 */
async function prePatchStep(ctx, ep) {
  await stopApp(ctx);
  const raw = prePatchProfile(ctx, ep);
  const launched = ep.log.length;
  await startApp(ctx);
  const { page } = ctx;
  await toModels(page);
  // 一组探针要几秒：先等档案换成这一次的结果，再等模型行跟上（rowWhen 只等 10 秒）
  await waitProfiles(page, [REF.nooff], (profile) => finished(profile) && profile.reasoning?.off_refused === true);
  const after = await rowWhen(page, REF.nooff, offRefusedRow);
  const refused = linesOf(ep, launched, NOOFF, true).filter((line) => line.status === 400 && line.effort === 'none');
  record('MP-38 a fake-coder-nooff profile from before the patch (no auto.offRefused, step 2’s 400 counted as an '
    + 'error) is probed again at launch under §7.7 without any click (§7.8: a profile with an error step is probed '
    + 'again at start; a new explicit-off 400 on the fake endpoint): the row ends verified with '
    + `" · ${THINKING_OFF_TEXT}" and no status line`,
  raw.startsWith('400') && offRefusedRow(after) && refused.length === 1,
  brief({ raw, after, lines: lineBrief(linesOf(ep, launched, NOOFF, true)) }));
}

/**
 * @brief 测试准备（synthetic test setup）：把数据目录里 router/fake-coder-nooff 的档案改成补丁之前的样子（去掉 auto.offRefused；
 *        第 2 步与第 3 步为出错、说明是 off 被拒的原文，第 4 步没跑），键、指纹、服务与其余各步照旧。
 * @return 写进去的 400 原文（从现在的第 2 步说明里去掉“Thinking can’t be turned off: ”）
 */
function prePatchProfile(ctx, ep) {
  const file = join(ctx.userData, 'model-profiles.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const stored = data.profiles.find((item) => item.modelId === NOOFF && item.baseUrl === routerUrl(ep.port));
  if (!stored) throw new Error('no stored profile for router/fake-coder-nooff');
  const raw = String(stored.auto.steps.thinking.detail ?? '').replace(OFF_REFUSED_PREFIX, '');
  delete stored.auto.offRefused;
  stored.auto.steps.thinking = { outcome: 'error', detail: raw };
  stored.auto.steps.call = { outcome: 'error', detail: raw };
  stored.auto.steps.result = { outcome: 'not_run', detail: 'Step 3 did not produce a valid call' };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return raw;
}

/** @brief 场景 probe（MP-38）。 */
async function probeScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT.probe, {
    FAKE_MODELS: `fake-coder,${NOOFF},${THINKLONG},${ALWAYSTHINK},${TOOLLONG},${OFFLONG},${OFFSILENT}` },
  { proxy: false });
  // synthetic test setup：一个普通地址的提供商 plain（fake-coder，没勾 Supports thinking）作为默认范围；
  // 要测的模型都经界面加入。
  seedConfig(ctx, { providers: [provider('plain', 'Plain', ep.url, [model('fake-coder')])], normalDefault: 'plain' });
  await startApp(ctx);
  await waitProfiles(ctx.page, [REF.plain]);
  await step(ctx, 'add nooff', () => addNoOffStep(ctx, ep));
  await step(ctx, 'verify nooff', () => verifyNoOffStep(ctx, ep));
  await step(ctx, 'thinklong', () => thinkLongStep(ctx, ep));
  await step(ctx, 'alwaysthink', () => alwaysThinkStep(ctx, ep));
  await step(ctx, 'toollong', () => toolLongStep(ctx));
  await step(ctx, 'off failed', () => offFailedStep(ctx));
  // 最后：要重启 Mori
  await step(ctx, 'pre-patch profile', () => prePatchStep(ctx, ep));
}

// ---------- 场景 effort：没有 Off 的标记（MP-39 App） ----------

/** @brief 没有标记的模型（plain/fake-coder，勾 Supports thinking、普通地址）：菜单仍有 Off；Off 时请求不带思考参数。 */
async function unmarkedOffStep(ctx, ep) {
  const { page } = ctx;
  await toChat(page);
  const menu = await readEffortMenu(page);
  record('MP-39 an unmarked model (plain/fake-coder, Supports thinking, plain address): the Effort menu still lists '
    + 'Off and has no thinking-off-note', menu.offItem && menu.levels[0] === 'off' && menu.note === null,
  brief(menu));
  await chooseThinking(page, 'off');
  const mark = ep.log.length;
  await sendTurn(page, 'plain at Off on the unmarked model');
  const lines = linesOf(ep, mark, 'fake-coder', false);
  record('MP-39 the unmarked model at Off: its request carries no thinking params (fake log "reasoning": false, '
    + '"effort": null) and is answered', lines.length > 0 && lines.every((line) => line.reasoning === false
    && line.effort === null && line.status === 200) && (await lastReply(page)).includes(PLAIN_REPLY),
  lineBrief(lines));
}

/** @brief 会话是 Off 时把范围换到 router（fake-coder-nooff）：Minimal、没有 Off、有说明；请求带 minimal、没有 400。 */
async function switchNoOffStep(ctx, ep) {
  const { page } = ctx;
  await toChat(page);
  await choosePick(page, 'router');
  const button = await effortWhen(page, 'minimal');
  const menu = await readEffortMenu(page);
  record('MP-39 a session that was Off, after switching the range to router (fake-coder-nooff): Effort reads '
    + '"Effort: Minimal" (data-level minimal) and Minimal is checked in the menu', button?.level === 'minimal'
    && button.text === 'Effort: Minimal' && button.name === 'Effort: Minimal' && same(menu.checked, ['minimal']),
  brief({ button, menu }));
  record(`MP-39 fake-coder-nooff: the Effort menu in the message-box row has no [data-level="off"] item (starts at `
    + `Minimal) and has data-testid="thinking-off-note" "${OFF_NOTE}", not a menu item and not focusable`,
  menu.inRow && !menu.offItem && menu.levels[0] === 'minimal' && menu.note === OFF_NOTE && menu.noteInert === true,
  brief(menu));
  const mark = ep.log.length;
  await sendTurn(page, 'plain at Off on the model that cannot turn thinking off');
  const lines = linesOf(ep, mark, NOOFF, false);
  record('MP-39 that Off session\'s request to fake-coder-nooff carries "effort":"minimal" (fake log) and the fake '
    + 'endpoint returned no 400; the reply is shown', lines.length > 0
    && lines.every((line) => line.effort === 'minimal' && line.status === 200)
    && (await lastReply(page)).includes(PLAIN_REPLY) && (await errorCount(page)) === 0,
  lineBrief(lines));
  await chooseThinkingCurrent(page);
  await choosePick(page, 'plain');
  const back = await effortWhen(page, 'off');
  record('MP-39 choosing the shown Minimal changes nothing: switching back to the unmarked model shows "Effort: Off" '
    + 'again (the session still records Off)', back?.level === 'off' && back.text === 'Effort: Off', brief(back));
}

/** @brief 在 Effort 菜单里点打勾的那一项（显示的当前强度，model-menu.md：不发 session.setThinking），等菜单关上。 */
async function chooseThinkingCurrent(page) {
  await paneOf(page).getByTestId('thinking-button').click();
  const menu = paneOf(page).getByTestId('thinking-menu');
  await menu.locator('[role="menuitemradio"][aria-checked="true"]').click();
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  await sleep(500);
}

/**
 * @brief 提供商卡 router 的 Test connection（connection.test，测它的第一个模型 fake-coder-nooff）：带 medium、成功。
 *        2026-10-26 起模型行没有 Test（models-settings.md "Models 行"）。
 */
async function testConnectionStep(ctx, ep) {
  const { page } = ctx;
  await toModels(page);
  const mark = ep.log.length;
  const card = page.locator('[data-testid="provider-card"][data-provider="router"]');
  await card.locator('[data-action="test-provider"]').click();
  const result = card.getByTestId('test-result');
  await until(async () => TEST_DONE.test((await result.innerText().catch(() => '')).trim()), 120000, 300);
  const text = (await result.innerText().catch(() => '')).trim();
  const lines = linesOf(ep, mark, NOOFF, false);
  record('MP-39 Test connection on the Router card (its first model fake-coder-nooff) succeeds ("Connected…") and its '
    + 'request carries "effort":"medium" '
    + '(fake log, status 200)', text.startsWith('Connected') && lines.length > 0
    && lines.every((line) => line.effort === 'medium' && line.status === 200),
  `${oneLine(text, 120)}; ${lineBrief(lines)}`);
}

/** @brief 打开 ref 那一行的模型表单（Edit），读 Default effort for new sessions 的选项与值。 */
async function editEffort(page, ref) {
  await modelRow(page, ref).locator('[data-action="edit"]').click();
  const form = page.getByTestId('model-form');
  await form.waitFor({ timeout: 10000 });
  const select = form.getByLabel(LEVEL_FIELD, { exact: true });
  const options = await select.locator('option').evaluateAll((items) => items.map((item) => item.value));
  return { form, options, value: await select.inputValue() };
}

/** @brief pi 设置里 ref 的新会话强度（modelThinkingLevels）。 */
function storedLevel(ctx, ref) {
  const settings = JSON.parse(readFileSync(join(ctx.userData, 'pi', 'settings.json'), 'utf8'));
  return settings.modelThinkingLevels?.[ref] ?? null;
}

/** @brief 模型表单（Edit）：没有 Off；存着的 Off 显示 minimal；不动它就 Save 时照存。没有标记的模型仍有 Off。 */
async function editFormStep(ctx) {
  const { page } = ctx;
  await toModels(page);
  const edit = await editEffort(page, REF.nooff);
  record(`MP-39 Edit fake-coder-nooff: "${LEVEL_FIELD}" has no option[value="off"] (Minimal … Max) and the stored `
    + 'Off shows as minimal', same(edit.options, NO_OFF_LEVELS) && edit.value === 'minimal',
  brief({ options: edit.options, value: edit.value }));
  await edit.form.getByRole('button', { name: 'Save', exact: true }).click();
  await edit.form.waitFor({ state: 'detached', timeout: 15000 });
  await sleep(500);
  const info = await modelsInfo(page);
  record('MP-39 Save with Default effort untouched keeps the stored Off: pi settings modelThinkingLevels and '
    + 'models.get thinkingDefaults are still "off" for router/fake-coder-nooff', storedLevel(ctx, REF.nooff) === 'off'
    && info.thinkingDefaults?.[REF.nooff] === 'off',
  brief({ stored: storedLevel(ctx, REF.nooff), shown: info.thinkingDefaults?.[REF.nooff] }));
  const plain = await editEffort(page, REF.plain);
  record(`MP-39 Edit an unmarked model (plain/fake-coder): "${LEVEL_FIELD}" still lists Off`,
    plain.options[0] === 'off' && plain.options.length === NO_OFF_LEVELS.length + 1, brief(plain.options));
  await plain.form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await plain.form.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 默认强度是 Off 的新会话：默认范围换成 router 后 Ctrl+N，显示 Minimal、请求带 minimal、没有 400。 */
async function newSessionOffStep(ctx, ep) {
  const { page } = ctx;
  await toModels(page);
  const select = page.getByTestId('default-pick');
  await select.selectOption('router');
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="default-pick"]');
    return element && !element.disabled && element.value === 'router';
  }, null, { timeout: 15000 });
  await toChat(page);
  await ctrlN(page);
  const button = await effortWhen(page, 'minimal');
  const bar = await pickers(page);
  const menu = await readEffortMenu(page);
  record('MP-39 a new session whose default effort is Off (default range router, stored Off for '
    + 'router/fake-coder-nooff): Effort reads "Effort: Minimal", Minimal is checked and there is no Off item',
  bar?.pick === 'router' && button?.level === 'minimal' && button.text === 'Effort: Minimal'
    && same(menu.checked, ['minimal']) && !menu.offItem && menu.note === OFF_NOTE, brief({ pick: bar?.pick, button,
    menu }));
  const mark = ep.log.length;
  await sendTurn(page, 'plain in a new session on the model that cannot turn thinking off');
  const lines = linesOf(ep, mark, NOOFF, false);
  record('MP-39 that new session\'s request carries "effort":"minimal" (fake log) and gets no 400',
    lines.length > 0 && lines.every((line) => line.effort === 'minimal' && line.status === 200)
    && (await errorCount(page)) === 0, lineBrief(lines));
}

/** @brief 打开记忆页的 Project 一节，点增强的 Settings…，等 Model range 可用；返回对话框与 Model range、Effort。 */
async function openEnhanceDialog(page) {
  await toChat(page);
  await page.getByTestId('nav-memory').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  const project = page.getByTestId('memory-scope-project');
  if ((await project.getAttribute('aria-pressed')) !== 'true') await project.click();
  const open = page.getByTestId('enhance-settings');
  await until(() => open.isEnabled().catch(() => false), 15000, 200);
  await open.click();
  const dialog = page.getByTestId('enhance-dialog');
  await dialog.waitFor({ timeout: 10000 });
  const pick = dialog.getByTestId('enhance-model');
  await until(() => pick.isEnabled().catch(() => false), 10000, 200);
  return { dialog, pick, effort: dialog.getByTestId('enhance-effort') };
}

/** @brief 对话框里选范围 pick，读 Effort 此刻的选项、值与是否可用。 */
async function effortFor(c, pick) {
  await c.pick.selectOption(pick);
  return { pick: await c.pick.inputValue(), options: await c.effort.locator('option')
    .evaluateAll((items) => items.map((item) => item.value)), value: await c.effort.inputValue(),
  disabled: await c.effort.isDisabled() };
}

/** @brief 增强设置对话框的 Effort（memory-enhance.md"Effort 没有 Off"）：第一个候选是 fake-coder-nooff 时不列 Off。 */
async function enhanceDialogStep(ctx) {
  const { page } = ctx;
  const info = await bridge(page, { type: 'enhance.get', cwd: ctx.project });
  record('MP-39 enhance.get: noOffPicks lists exactly the ranges whose first candidate is fake-coder-nooff (router, '
    + 'router/fake-coder-nooff); effortPicks marks them as thinking', same([...(info.noOffPicks ?? [])].sort(),
    ['router', REF.nooff]) && info.effortPicks?.router === true && info.effortPicks?.[REF.nooff] === true,
  brief({ noOffPicks: info.noOffPicks, effortPicks: info.effortPicks }));
  const c = await openEnhanceDialog(page);
  const plain = await effortFor(c, 'plain');
  await c.effort.selectOption('off');
  const router = await effortFor(c, 'router');
  const model = await effortFor(c, REF.nooff);
  record('MP-39 enhancement settings dialog: with a range whose first candidate is fake-coder-nooff (router, '
    + 'router/fake-coder-nooff) Effort (data-testid="enhance-effort") has no option[value="off"]; with plain it has',
  [router, model].every((item) => !item.disabled && same(item.options, NO_OFF_LEVELS)) && !plain.disabled
    && plain.options.includes('off'), brief({ plain, router, model }));
  const back = await effortFor(c, 'plain');
  record('MP-39 enhancement settings dialog: Off chosen, then a range without Off shows minimal; back on plain it '
    + 'shows Off again', router.value === 'minimal' && model.value === 'minimal' && back.value === 'off',
  brief({ router: router.value, model: model.value, back: back.value }));
  await c.pick.selectOption('router');
  await c.dialog.getByTestId('enhance-save').click();
  await c.dialog.waitFor({ state: 'detached', timeout: 10000 });
  const saved = await bridge(page, { type: 'enhance.get', cwd: ctx.project });
  record('MP-39 enhancement settings dialog: saving with the shown Minimal untouched keeps thinking "off" '
    + '(enhance.get pick router, thinking off)', saved.pick === 'router' && saved.thinking === 'off',
  brief({ pick: saved.pick, thinking: saved.thinking }));
  await toChat(page);
}

/** @brief 场景 effort（MP-39）。 */
async function effortScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT.effort, {}, { proxy: false });
  // synthetic test setup：plain（fake-coder 勾 Supports thinking，普通地址）是默认范围；router（fake-coder-nooff 勾
  // Supports thinking，OpenRouter 前缀地址）启动时自动探测出 off_refused。
  seedConfig(ctx, { providers: [
    provider('plain', 'Plain', ep.url, [model('fake-coder', { reasoning: true })]),
    provider('router', 'Router', routerUrl(ep.port), [model(NOOFF, { reasoning: true })]),
  ], normalDefault: 'plain' });
  // synthetic test setup：router/fake-coder-nooff 的新会话强度存成 Off（pi 设置的 modelThinkingLevels）。
  seedPiSettings(ctx, { modelThinkingLevels: { [REF.nooff]: 'off' } });
  await startApp(ctx);
  const profiles = await waitProfiles(ctx.page, [REF.plain, REF.nooff]);
  record('MP-39 setup: router/fake-coder-nooff is probed off_refused true; the unmarked plain/fake-coder is '
    + 'can_disable true, off_refused false', offRefusedProfile(profiles[REF.nooff])
    && profiles[REF.plain].reasoning.can_disable === true && profiles[REF.plain].reasoning.off_refused === false,
  brief({ nooff: profiles[REF.nooff].reasoning, plain: profiles[REF.plain].reasoning }));
  const mark = ep.log.length;
  ctx.project = makeProject(ctx, 'proj');
  await openProject(ctx, ctx.project);
  await step(ctx, 'unmarked off', () => unmarkedOffStep(ctx, ep));
  await step(ctx, 'switch to nooff', () => switchNoOffStep(ctx, ep));
  await step(ctx, 'test connection', () => testConnectionStep(ctx, ep));
  await step(ctx, 'edit form', () => editFormStep(ctx));
  await step(ctx, 'new session off', () => newSessionOffStep(ctx, ep));
  await step(ctx, 'enhance dialog', () => enhanceDialogStep(ctx));
  const sent = linesOf(ep, mark, NOOFF, false);
  record('MP-39 across the scenario the fake endpoint answered every conversation and test request to '
    + 'fake-coder-nooff with 200 (no 400: Mori never sent it an explicit off)', sent.length >= 3
    && sent.every((line) => line.status === 200 && line.effort !== null && line.effort !== 'none'), lineBrief(sent));
}

// ---------- 运行 ----------

const SCENARIOS = { probe: [probeScenario, 'MP-38'], effort: [effortScenario, 'MP-39'] };

for (const [name, [scenario, mp]] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(name)) continue;
  const ctx = { name, mp, eps: [], pageErrors: [], app: null, page: null,
    userData: mkdtempSync(join(tmpdir(), `mori-v1n-${name}-data-`)),
    root: mkdtempSync(join(tmpdir(), `mori-v1n-${name}-`)) };
  console.log(`[v1-models-app-nooff] ${name}: data in ${ctx.userData}, projects in ${ctx.root}`);
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
process.exitCode = write(`v1-models-app-nooff${suffix}.json`) ? 0 : 1;
