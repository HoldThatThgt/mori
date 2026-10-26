// v1 模型层的整机测试（会话一侧）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖 docs/specs/model-providers.md §14.2 中 MP-09、MP-10、MP-12、MP-21、MP-22、MP-23、MP-34、MP-35 在 App 层的通过条件。
// 界面文字、状态与标识见 docs/v1/screens/model-chat.md、model-menu.md、models-settings.md。
// 每个场景用一个新的数据目录和自己的合成端点，启动前写好 model-config.json（synthetic test setup，代码里注明）；
// 场景之间互不依赖，可以用 --only 只跑其中几个。
// 2026-10-21 起选择范围按钮、Effort 和权限按钮在输入框下面一行（docs/v0/composer-pickers.md、docs/v0/screens/models.md）：
// 按钮状态按那里"测试要改的地方"的 C1、C2 读（不可用读 aria-disabled、切换中读 data-pending、悬停说明按行比较，
// v1-models-row-helpers.mjs）；场景 row 另查这一行里范围按钮的位置、宽度、截短、悬停、菜单往上打开、键盘、后台进程退出与
// 重新载入、分屏 280px 的一栏（多个提供商的范围只在 v1 的配置里有）。
// 合成端点前面放一个本进程里的转发代理（synthetic，v1-models-session-setup.mjs）：记下每个请求的请求体（发给模型的上下文、
// 思考参数、压缩请求、认证头），MP-21、MP-22 另用它让压缩（摘要）请求返回 400，制造"压缩出错"。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-app-session.mjs [--exe <Mori.exe 路径>] [--only 场景1,场景2]
// 场景：blocked、configInvalid、probes、fingerprint、handover、compaction、range、row、preparing、thinking。
// 结果写到 test-results/v1-models-app-session(-packaged).json，截图在 test-results/v1-models-app-session(-packaged)/。
// 端口：4540–4549 是 Mori 连接的地址（代理或直连的合成端点），4550–4559 是代理后面的合成端点。
// 测试里的 key 都是合成的测试值（synthetic），与任何真实服务无关。
// 一键拉取模型（docs/specs/model-discovery.md §13.4）：MP-10 加模型改为卡上 Fetch models → 勾选或手填 → Add 1 model
// （page.mjs cardAddModels）；合成端点的列表、详情请求的日志行（带 path）不算对话请求。
// 2026-10-26（WP-02，负责人走查 M7、M8，models-settings.md "Models 行"）：模型行没有档案摘要和需要同意的探针的按钮。
// MP-10 的等级、推理字段读 models.get 的档案，tool calling 读档案与行上的 data-probe、判定失败的状态行；MP-12 的重新验证
// 看行上的 data-probe，全程没有状态行。WP-02 评审补：场景 probes 点 pv/fake-coder-notools 状态行的 Verify again
// （重新探测、Verifying…、回到 failed 并再带 Verify again）。
// 2026-10-26（WP-04，负责人走查 M7 决定 1）：长输入、取消两个探针删掉，场景 consent（MP-11）同删。
// 2026-10-26（WP-05，负责人走查 M3）：没有网络区域。场景 blocked 的 no_candidate 用“地址上没有服务”与“tool calling 判定
// 不通过”两种原因（原来另有公网、区域未确认），没有 Allow <zone>、Confirm zone 两个操作；场景 range 的菜单项没有区域标记，
// 悬停第二行只有提供商名（MP-06 的两条 App 检查）。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contentText } from '../fake-endpoint/replies.mjs';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, sleep } from './lib.mjs';
import { activeFile, ctrlN, lastReply, PANE, paneOf, rowOf, samePath, settle, stubFolder, until, waitIdle, waitReady }
  from './m3-helpers.mjs';
import {
  at1, fitPane, focusKind, frameProblems, isCut, kindsOf, least, menuItemFacts, NOTE, pickers, placeBrief,
  rangeDescription, rangeMenuPlace, rangeName, resetWindow, rowFacts, seenPickers, setRightPanel, watchPickers,
} from './v1-models-row-helpers.mjs';
import {
  brief, customs, group, hasToolHistory, makeProject, model, provider, readConfig, seedConfig,
  seedPiSettings, seedV0Session, startEndpoint, talk,
} from './v1-models-session-setup.mjs';
import { cardAddModels } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/v1-models-app-session${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** Mori 连接的第一个端口；代理后面的合成端点在 +10 */
const PORT = 4540;
/** 合成端点 "plain" 的回复 */
const PLAIN_REPLY = '这是一段只有文字的回复，用来测试流式输出。';
/** 合成端点压缩请求的回复里的一句 */
const SUMMARY_TEXT = 'Synthetic summary of the earlier conversation.';
/** 生成中、准备中范围按钮悬停的第三行（§9.2） */
const BUSY_TITLE = 'Can’t switch models until the response finishes';
/** 生成中、准备中 Effort 悬停的第二行与读屏的描述（models.md"思考强度"） */
const EFFORT_BUSY = NOTE.effortBusy;
/** v0 的压缩提示与已停止提示 */
const COMPACTED_NOTICE = 'Compacted session';
const STOPPED_NOTICE = 'Stopped · Changes made so far stay as they are';
/** 被拒绝启动的会话收到 session.prompt 时的原文（§4.6） */
const BLOCKED_MESSAGE = 'This session can’t start: no model fits';
/** 填充对话用的文字：不含合成端点的任何关键词 */
const FILLER_UNIT = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ';
const filler = (chars) => FILLER_UNIT.repeat(Math.ceil(chars / FILLER_UNIT.length)).slice(0, chars);

// ---------- App ----------

/** @brief 用 ctx.userData 启动 Mori，等左栏出来，在页面里装上事件记录（window.__events）。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByRole('button', { name: 'Open folder…', exact: true }).first().waitFor({ timeout: 60000 });
  await ctx.page.evaluate(() => {
    window.__events = [];
    window.mori.onEvent((envelope) => window.__events.push(JSON.parse(JSON.stringify(envelope))));
  });
}

/** @brief 关掉 Mori。 */
async function stopApp(ctx) {
  if (!ctx.app) return;
  await ctx.app.close().catch(() => {});
  ctx.app = null;
}

/** @brief 经进程桥发一条命令（只用于读状态和测试准备）。 */
const bridge = (page, command) => page.evaluate((item) => window.mori.request(item), command);
/** @brief 页面收到的某种事件。 */
const events = (page, type) => page.evaluate((want) => window.__events.filter((item) => item.event?.type === want), type);
/** @brief models.get 的结果。 */
const modelsInfo = (page) => bridge(page, { type: 'models.get' });
/** @brief 档案已完成一组探针（不在第一次探测中）。 */
const finished = (profile) => Boolean(profile) && profile.status !== 'probing' && profile.probedAt !== null;
/** @brief 档案的 tool_calling 已验证。 */
const verified = (profile) => profile?.tool_calling?.state === 'verified';

/** @brief 等 refs 的档案都满足 done，返回最后一次读到的全部档案；等不到时抛错。 */
async function waitProfiles(page, refs, done = verified, timeout = 120000) {
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

/** @brief 点"打开文件夹…"打开 folder（会问信任时选"信任"），等新会话就绪。 */
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

/** @brief 在侧栏点会话文件为 file 的会话行（路径按 Windows 规则比较），等它就绪。 */
async function openRowFile(page, file) {
  const files = await page.locator('.session-item').evaluateAll((rows) => rows.map((row) => row.dataset.file));
  const match = files.find((item) => samePath(item, file));
  if (!match) throw new Error(`no session row for ${file}`);
  await rowOf(page, match).click();
  await waitReady(page);
  await settle(page);
}

/** @brief 当前一栏的会话标识（后台进程对已打开的会话直接返回它，不改界面）。 */
async function sessionIdOf(page) {
  const file = await activeFile(page);
  return page.evaluate(async (sessionFile) => (await window.mori.request({ type: 'session.open', sessionFile }))
    .sessionId, file);
}

/** @brief 当前一栏的输入框。 */
const composer = (page) => paneOf(page).locator('.composer textarea');
/** @brief 当前一栏的用户消息与助手回复条数。 */
const userCount = (page) => paneOf(page).getByTestId('user-message').count();
const errorCount = (page) => paneOf(page).getByTestId('error-card').count();

/** @brief 在输入框里写 text 按 Enter。 */
async function send(page, text) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** @brief 发一条消息，等它显示出来，再等本轮结束。 */
async function sendTurn(page, text, timeout = 120000) {
  const before = await userCount(page);
  await send(page, text);
  await until(async () => (await userCount(page)) > before, 10000, 100);
  await waitIdle(page, timeout);
}

/** @brief 当前一栏对话流里的提示（换模型、重建、压缩、已停止）。 */
function notices(page) {
  return page.evaluate((selector) => [...document.querySelectorAll(`${selector} [data-testid="notice"]`)]
    .map((item) => ({ kind: item.dataset.kind ?? null, text: item.textContent.trim(), from: item.dataset.from ?? null,
      to: item.dataset.to ?? null, reason: item.dataset.reason ?? null, hidden: item.dataset.hidden ?? null,
      summary: item.dataset.summary ?? null })), PANE);
}

/** @brief 当前一栏的阶段行此刻的 data-kind 与文字（去掉秒数）；没有时为 null。 */
function stageNow(page) {
  return page.evaluate((selector) => {
    const stage = document.querySelector(`${selector} [data-testid="stage"]`);
    return stage ? { kind: stage.dataset.kind ?? null, text: stage.textContent.replace(/ · \d+s$/, '').trim() } : null;
  }, PANE);
}

/**
 * @brief 在 paneCss 那一栏输入框下面一行的范围菜单里选 pick，等按钮显示它（不再是切换中：能用时按钮上没有 aria-disabled，
 *        composer-pickers.md C1）。
 */
async function choosePick(page, pick, paneCss = PANE) {
  await page.locator(`${paneCss} [data-testid="model-button"]`).click();
  await page.locator(`${paneCss} [data-testid="model-menu"] [role="menuitemradio"][data-pick="${pick}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    return button?.dataset.pick === want && !button.getAttribute('aria-disabled');
  }, { selector: paneCss, want: pick }, { timeout: 15000 });
}

/** @brief 范围菜单关上了（5 秒内从页面上消失）。 */
const menuGone = (page) => page.getByTestId('model-menu').waitFor({ state: 'detached', timeout: 5000 })
  .then(() => true, () => false);

/**
 * @brief 拒绝启动卡的"Change model…"打开的菜单（composer-pickers.md 新加的检查第 10 条）：是这一栏输入框下面一行的范围菜单，
 *        往上打开、在面板里、不盖到顶栏；按 Esc 关上后焦点在范围按钮。记两条检查，label 是检查名的开头。
 */
async function cardMenuChecks(page, label) {
  await clickCardAction(page, 'change-model');
  const opened = await page.getByTestId('model-menu').waitFor({ timeout: 5000 }).then(() => true, () => false);
  const place = opened ? await rangeMenuPlace(page) : null;
  record(`${label}: "Change model…" opens the range menu of this pane's message-box row, upward above the row, `
    + 'inside the pane and not over the top bar', place?.problems.length === 0,
  `${place?.problems.join('; ') ?? 'no menu'} ${placeBrief(place?.geo)}`);
  await page.keyboard.press('Escape');
  const gone = await menuGone(page);
  const focus = await focusKind(page);
  record(`${label}: Esc closes the menu opened from the card and the focus is on the range button (not on the card)`,
    opened && gone && focus === 'model-button', `menu gone ${gone}, focus ${focus}`);
  return opened;
}

/**
 * @brief 在当前一栏的思考菜单里选 level，等按钮的 data-level 变过去、不再切换中（没有 data-pending）：切换中按钮已经显示
 *        选的强度（data-level 立刻就是 level），只等 data-level 会在 session.setThinking 返回之前就往下走。
 */
async function chooseThinking(page, level) {
  await paneOf(page).getByTestId('thinking-button').click();
  await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.level === want && button.dataset.pending !== 'true';
  }, { selector: PANE, want: level }, { timeout: 15000 });
}

/** @brief 拒绝启动卡此刻的内容；没有卡时为 null。 */
function blockedState(page) {
  return page.evaluate((selector) => {
    const card = document.querySelector(`${selector} [data-testid="blocked-card"]`);
    if (!card) return null;
    return { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? '',
      note: card.querySelector('.model-card-note')?.textContent ?? null,
      candidates: [...card.querySelectorAll('[data-testid="candidate"]')].map((item) => ({ ref: item.dataset.ref,
        reason: item.dataset.reason, text: item.textContent })),
      actions: [...card.querySelectorAll('[data-action]')].map((item) => [item.dataset.action, item.textContent]) };
  }, PANE);
}

/** @brief 等拒绝启动卡变成 kind；等不到时抛错。 */
async function waitBlocked(page, kind, timeout = 15000) {
  const card = await until(async () => {
    const state = await blockedState(page);
    return state?.kind === kind ? state : null;
  }, timeout, 200);
  if (!card) throw new Error(`blocked card ${kind} did not appear; now ${JSON.stringify(await blockedState(page))}`);
  return card;
}

/** @brief 点拒绝启动卡上的一个操作。 */
const clickCardAction = (page, action) => paneOf(page)
  .locator(`[data-testid="blocked-card"] [data-action="${action}"]`).click();

/** @brief 打开设置页的 Models 分节。 */
async function openModels(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
}

/** @brief 设置页上点"返回会话"。 */
async function backToChat(page) {
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
  await waitReady(page);
}

/** @brief 设置页是否落在 Models 分节、停在顶部。 */
async function settingsShown(page) {
  await page.getByTestId('models-section').waitFor({ timeout: 10000 });
  await sleep(400);
  return page.evaluate(() => ({ models: Boolean(document.querySelector('[data-testid="models-section"]')),
    section: document.querySelector('[data-testid="settings-nav"] .active')?.dataset.section ?? null,
    scroll: Math.round(document.querySelector('.settings-body')?.scrollTop ?? 0) }));
}

/**
 * @brief 模型行此刻的样子（models-settings.md "Models 行"，2026-10-26 起没有档案摘要）：行上的 data-probe（tool calling 的
 *        验证状态）、说明一行、状态行（data-state 与文字，没有时为 null）、行里的按钮。行不在时为 null。
 */
function profileRow(page, ref) {
  return page.evaluate((target) => {
    const row = document.querySelector(`[data-testid="model-row"][data-model="${target}"]`);
    if (!row) return null;
    const status = row.querySelector('[data-testid="probe-status"]');
    return { probe: row.dataset.probe ?? null, meta: row.querySelector('.model-meta')?.textContent ?? '',
      status: status && { state: status.dataset.state, text: status.textContent },
      actions: [...row.querySelectorAll('[data-action]')].map((item) => item.dataset.action) };
  }, ref);
}

/**
 * @brief 在提供商卡上 Fetch models，在卡里的清单只勾 spec.id（合成端点没列出的 id 用 Add a model ID 手填），按 spec 改
 *        Context window、Max output、Supports thinking，点 Add 1 model（models.addModels，model-discovery.md §6.5、§13.4），
 *        等新行出现。
 */
async function addModelUi(page, providerId, spec) {
  const row = { id: spec.id, ...(spec.ctx ? { contextWindow: spec.ctx } : {}),
    ...(spec.max ? { maxTokens: spec.max } : {}), ...(spec.reasoning ? { reasoning: true } : {}) };
  const added = await cardAddModels(page, providerId, [row]);
  if (added.error !== null) throw new Error(`add ${providerId}/${spec.id}: ${added.error}`);
  await page.locator(`[data-testid="model-row"][data-model="${providerId}/${spec.id}"]`).waitFor({ timeout: 10000 });
}

/**
 * @brief 在页面里装一个 MutationObserver，DOM 每次变化时按 kind 记一个快照（与上一个相同时不记），抓只持续一瞬间的状态。
 * @param kind stage：阶段行的 data-kind、文字和此刻的用户消息条数；card：拒绝启动卡的 kind；
 *        tool：ref 那一行的 data-probe（tool calling 的验证状态）与状态行（data-state、Verify again、文字）；
 *        thinking：Effort 按钮的 data-reasoning 与是否不可用（aria-disabled 为 true 且不是切换中，composer-pickers.md C1；
 *        按钮不再真的 disabled）
 */
async function watch(page, kind, ref = null) {
  await page.evaluate(({ which, selector, target }) => {
    const pane = () => document.querySelector(selector);
    const snaps = {
      stage: () => {
        const stage = pane()?.querySelector('[data-testid="stage"]');
        return stage && `${stage.dataset.kind ?? ''}|${stage.textContent.replace(/ · \d+s$/, '').trim()}|`
          + `${pane().querySelectorAll('[data-testid="user-message"]').length}`;
      },
      card: () => pane()?.querySelector('[data-testid="blocked-card"]')?.dataset.kind ?? 'none',
      // 模型行："<data-probe>|<状态行的 data-state>|<Verify again 的文字>|<状态行的文字>"，没有状态行时后三段为空
      tool: () => {
        const row = document.querySelector(`[data-testid="model-row"][data-model="${target}"]`);
        const line = row?.querySelector('[data-testid="probe-status"]');
        const button = line?.querySelector('[data-action="verify"]');
        const text = line?.querySelector('span')?.textContent;
        return row && [row.dataset.probe, line?.dataset.state, button?.textContent, text].map((part) => part ?? '')
          .join('|');
      },
      thinking: () => {
        const button = pane()?.querySelector('[data-testid="thinking-button"]');
        return button && `${button.dataset.reasoning}|`
          + `${button.getAttribute('aria-disabled') === 'true' && button.dataset.pending !== 'true'}`;
      },
    };
    window.__seen = [];
    window.__seenObserver?.disconnect();
    const push = () => {
      const value = snaps[which]();
      if (value && window.__seen.at(-1) !== value) window.__seen.push(value);
    };
    push();
    window.__seenObserver = new MutationObserver(push);
    window.__seenObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  }, { which: kind, selector: PANE, target: ref });
}

/** @brief 停下 watch，返回记下的快照。 */
const seen = (page) => page.evaluate(() => {
  window.__seenObserver?.disconnect();
  return window.__seen ?? [];
});

/** @brief 一个场景里的一步：出错时记一条失败（以场景的 MP 编号开头）、截图，回到会话页，继续下一步。 */
async function step(ctx, label, fn, mp = ctx.mp) {
  try {
    await fn();
  } catch (error) {
    record(`${mp} ${ctx.name} / ${label}: flow`, false, oneLine(error?.message ?? error, 500));
    await shot(ctx.page, `${ctx.name}-${label.replace(/\W+/g, '-')}`);
    await ctx.page?.keyboard.press('Escape').catch(() => {});
    if (await ctx.page?.getByTestId('settings-page').isVisible().catch(() => false)) {
      await backToChat(ctx.page).catch(() => {});
    }
  }
}

/** @brief 两个列表的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// ---------- 场景：拒绝启动卡（MP-09） ----------

/** @brief no_pick：卡、操作、Open settings、Change model…，然后选一个正在验证的分组。 */
async function noPickStep(ctx) {
  const { page } = ctx;
  await openProject(ctx, ctx.project);
  const card = await waitBlocked(page, 'no_pick');
  record('MP-09 no_pick: card text "No default model range; pick one."',
    card.title === 'No default model range; pick one.', card.title);
  record('MP-09 no_pick: actions "Change model…" and "Open settings", no candidate list',
    same(card.actions, [['change-model', 'Change model…'], ['open-settings', 'Open settings']])
    && card.candidates.length === 0, JSON.stringify(card));
  const bar = await pickers(page);
  record('MP-09 no_pick: the range button shows "No model range"', bar?.text === 'No model range', bar?.text);
  await noPickRow(page, bar);
  await clickCardAction(page, 'open-settings');
  const shown = await settingsShown(page);
  record('MP-09 no_pick: "Open settings" opens Settings → Models at the top',
    shown.models && shown.section === 'models' && shown.scroll === 0, JSON.stringify(shown));
  await backToChat(page);
  await cardMenuChecks(page, 'MP-09 no_pick');
  await clickCardAction(page, 'change-model');
  const menu = await page.getByTestId('model-menu').waitFor({ timeout: 5000 }).then(() => true, () => false);
  record('MP-09 no_pick: "Change model…" opens the range menu of this pane', menu, '');
  await page.locator(`${PANE} [data-testid="model-menu"] [role="menuitemradio"][data-pick="slowg"]`).click();
  const gone = await menuGone(page);
  const focus = await focusKind(page);
  const next = await until(async () => (await blockedState(page))?.kind === 'verifying', 15000, 200);
  record('MP-09 no_pick: choosing a range in that menu closes it, the focus returns to the range button and the card '
    + 'follows the model state (no_pick → verifying)', gone && focus === 'model-button' && Boolean(next),
  `menu gone ${gone}, focus ${focus}, card ${JSON.stringify(await blockedState(page))}`);
}

/**
 * @brief no_pick 时的输入框下面一行（composer-pickers.md 新加的检查第 10 条、chat.md"拒绝启动"）：权限按钮、能用的范围按钮
 *        "No model range"（悬停两行"No model range" / "No model can run in this session"，描述是第二行，描述元素在按钮
 *        外面）、不可用的"Send"（输入框有字时也是），没有 Effort；这一行高 33px、不溢出。圆环按 pi 的结果可有可无。
 */
async function noPickRow(page, bar) {
  await composer(page).fill('plain must not be sent');
  const facts = await rowFacts(page);
  const send = await paneOf(page).locator('.send-button').isDisabled();
  await composer(page).focus();
  const path = [];
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab');
    path.push(await focusKind(page));
  }
  record('MP-09 no_pick keyboard: from the message box Tab reaches the permission button and the usable range button; '
    + 'the disabled Send is skipped', path[0] === 'permission-button' && path[1] === 'model-button'
    && !path.includes('send'), path.join(' > '));
  await composer(page).fill('');
  const kinds = kindsOf(facts).replace(',usage', '');
  record('MP-09 no_pick: the message-box row has the permission button, the usable range button "No model range" '
    + '(hover "No model range" / "No model can run in this session", described by line 2) and a disabled Send '
    + 'even with text typed, no Effort; the row is 33px high and nothing overflows', kinds === 'permission,model,send'
    && !bar?.thinking && bar?.ariaDisabled === null && bar.inRow && !bar.inTopbar
    && same(bar.tip, ['No model range', NOTE.noModel]) && bar.described === NOTE.noModel && bar.tipOutside
    && bar.name === 'Model range: No model range' && send && frameProblems(facts).length === 0,
  JSON.stringify({ kinds: kindsOf(facts), bar, send, problems: frameProblems(facts) }));
}

/** @brief verifying：全部候选在验证中时的卡；发送不可用、后台进程拒绝；探针结束后卡自动消失。 */
async function verifyingStep(ctx) {
  const { page } = ctx;
  const card = await waitBlocked(page, 'verifying');
  record('MP-09 verifying: card text "Verifying slowp/slow-coder…"', card.title === 'Verifying slowp/slow-coder…',
    card.title);
  record('MP-09 verifying: no "Verify now" (no actions) and no candidate list while every candidate is verifying',
    card.actions.length === 0 && card.candidates.length === 0, JSON.stringify(card));
  await send(page, 'plain must not be sent');
  await sleep(800);
  const draft = await composer(page).inputValue();
  const sendDisabled = await paneOf(page).locator('.send-button').isDisabled();
  record('MP-09 blocked: Enter does not send, the draft stays and Send is disabled',
    (await userCount(page)) === 0 && draft === 'plain must not be sent' && sendDisabled,
    `users=${await userCount(page)} draft="${draft}" sendDisabled=${sendDisabled}`);
  await composer(page).fill('');
  const before = ctx.eps.reduce((sum, ep) => sum + talk(ep).length, 0);
  const id = await sessionIdOf(page);
  await bridge(page, { type: 'session.prompt', sessionId: id, text: 'plain kernel must refuse' });
  const refused = await until(async () => (await events(page, 'mori.prompt_error'))
    .find((item) => item.sessionId === id && item.event.text === 'plain kernel must refuse'), 5000, 200);
  const after = ctx.eps.reduce((sum, ep) => sum + talk(ep).length, 0);
  record(`MP-09 blocked: the kernel refuses session.prompt with "${BLOCKED_MESSAGE}"`,
    refused?.event?.message === BLOCKED_MESSAGE, JSON.stringify(refused?.event ?? null));
  // 这条提示是测试经进程桥直接发的（界面上没有先显示的消息），所以界面按 v0 的规则显示错误卡，不检查它。
  record('MP-09 blocked: the refused prompt reaches no endpoint', after === before,
    `conversation requests ${before} → ${after}`);
  await composer(page).fill('');
  // 拒绝启动卡出现、消失不关范围菜单（models.md"什么时候自动关"）：卡还在时打开菜单，等卡自己消失。
  const shownWhileBlocked = (await blockedState(page))?.kind === 'verifying';
  await paneOf(page).getByTestId('model-button').click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 }).catch(() => {});
  const cleared = await until(async () => (await blockedState(page)) === null, 90000, 500);
  const stillOpen = await page.locator(`${PANE} [data-testid="model-menu"]`).count() === 1;
  record('MP-23 a range menu opened while the blocked card is shown stays open when the card goes away',
    shownWhileBlocked && Boolean(cleared) && stillOpen, `opened while verifying ${shownWhileBlocked}, `
    + `card cleared ${Boolean(cleared)}, menu still open ${stillOpen}`);
  await page.keyboard.press('Escape');
  await menuGone(page);
  const bar = await pickers(page);
  record('MP-09 verifying: the card clears by itself when the probes finish', Boolean(cleared)
    && bar?.text === 'slowg · slow-coder', `card=${JSON.stringify(await blockedState(page))} button=${bar?.text}`);
}

/** @brief no_candidate：两种排除原因、三个操作；每个操作的去处（不改配置）。 */
async function noCandidateStep(ctx) {
  const { page } = ctx;
  await waitProfiles(page, ['dead/dead-coder', 'nt/nt-coder-notools'], finished, 60000);
  await choosePick(page, 'mix');
  const card = await waitBlocked(page, 'no_candidate');
  record('MP-09 no_candidate: card text "This session can\'t start: no model fits."',
    card.title === 'This session can’t start: no model fits.', card.title);
  const lines = card.candidates.map((item) => `${item.reason}:${item.text}`);
  record('MP-09 no_candidate: one line per candidate with its reason', same(lines, [
    'unverified:dead/dead-coder — tool calling not verified yet',
    'failed:nt/nt-coder-notools — tool calling failed verification']), lines.join(' | '));
  record('MP-09 no_candidate: actions Verify now / Change model… / Open settings, in this order (no zone actions)',
    same(card.actions, [['verify', 'Verify now'], ['change-model', 'Change model…'],
      ['open-settings', 'Open settings']]),
    JSON.stringify(card.actions));
  await noCandidateMenuAndSettings(ctx);
}

/** @brief no_candidate 的 Change model… 与 Open settings。 */
async function noCandidateMenuAndSettings(ctx) {
  const { page } = ctx;
  const menu = await cardMenuChecks(page, 'MP-09 no_candidate');
  record('MP-09 no_candidate: "Change model…" opens the range menu', menu, '');
  await clickCardAction(page, 'open-settings');
  const shown = await settingsShown(page);
  record('MP-09 no_candidate: "Open settings" opens Settings → Models at the top', shown.models && shown.scroll === 0,
    JSON.stringify(shown));
  await backToChat(page);
}

/** @brief Verify now：端点恢复后点它，卡先变成 verifying，探针通过后消失，会话可以发送。 */
async function verifyNowStep(ctx) {
  const { page } = ctx;
  // 启动时探针连不上 dead 端口，提供商的 connection 记录 30 秒后到期（§12）；等过这段再开端点，避免测到这条记录。
  const wait = ctx.startedAt + 33000 - Date.now();
  if (wait > 0) await sleep(wait);
  const dead = await startEndpoint(ctx, PORT + 2, {}, { proxy: false });
  await watch(page, 'card');
  const id = await sessionIdOf(page);
  const mark = (await events(page, 'mori.model_state')).length;
  await clickCardAction(page, 'verify');
  const cleared = await until(async () => (await blockedState(page)) === null, 90000, 300);
  const kinds = await seen(page);
  const states = (await events(page, 'mori.model_state')).slice(mark).filter((item) => item.sessionId === id)
    .map((item) => item.event.blocked?.kind ?? 'none');
  record('MP-09 Verify now: while the probes run the card is verifying (no Verify now)',
    kinds.includes('verifying'), `card ${kinds.join(' > ')}; mori.model_state blocked ${states.join(' > ')}`);
  const bar = await pickers(page);
  record('MP-09 Verify now: the card clears after the probes pass', Boolean(cleared) && bar?.text === 'mix · dead-coder',
    `cards ${kinds.join(' > ')}; button ${bar?.text}`);
  await sendTurn(page, 'plain after verify now');
  const reply = await lastReply(page);
  record('MP-09 Verify now: the session can send afterwards', reply.includes(PLAIN_REPLY)
    && dead.log.some((line) => !line.probe && line.status === 200), oneLine(reply, 80));
}

/** @brief pick_missing：会话的范围指向的分组被删掉。 */
async function pickMissingStep(ctx) {
  const { page } = ctx;
  await ctrlN(page);
  await waitBlocked(page, 'no_pick');
  await choosePick(page, 'tmpg');
  await until(async () => (await blockedState(page)) === null, 15000, 300);
  await openModels(page);
  await page.locator('[data-testid="group-row"][data-group="tmpg"] [data-action="delete-group"]').click();
  const dialog = page.locator('[data-testid="confirm-dialog"][data-kind="delete-group"]');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.locator('.dialog-actions button:not([data-role="cancel"])').click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  await backToChat(page);
  const card = await waitBlocked(page, 'pick_missing');
  record('MP-09 pick_missing: card text "tmpg is not in your model settings." / "Used by this session\'s model range."',
    card.title === 'tmpg is not in your model settings.' && card.note === 'Used by this session’s model range.',
    `${card.title} / ${card.note}`);
  record('MP-09 pick_missing: actions "Change model…" and "Open settings"',
    same(card.actions, [['change-model', 'Change model…'], ['open-settings', 'Open settings']]),
    JSON.stringify(card.actions));
  const bar = await pickers(page);
  record('MP-09 pick_missing: the range button shows the missing name', bar?.text === 'tmpg', bar?.text);
}

/** @brief project_config：项目的 .mori/models.json 有未知字段。 */
async function projectConfigStep(ctx) {
  const { page } = ctx;
  await openProject(ctx, ctx.broken);
  const card = await waitBlocked(page, 'project_config');
  record('MP-09 project_config: card text ".mori/models.json: <reason>" naming the bad field',
    card.title.startsWith('.mori/models.json: ') && card.title.includes('bogus'), card.title);
  record('MP-09 project_config: only "Open settings"', same(card.actions, [['open-settings', 'Open settings']]),
    JSON.stringify(card.actions));
  await clickCardAction(page, 'open-settings');
  const shown = await settingsShown(page);
  record('MP-09 project_config: "Open settings" opens Settings → Models at the top', shown.models && shown.scroll === 0,
    JSON.stringify(shown));
  await backToChat(page);
}

/** @brief 场景 blocked（MP-09）：除 config_invalid 外的每种拒绝启动卡、操作与解除。 */
async function blockedScenario(ctx) {
  const main = await startEndpoint(ctx, PORT);
  // 慢端点：每个请求先等 6 秒，第一次探测要半分钟以上，这期间会话按 verifying 拒绝启动。
  const slow = await startEndpoint(ctx, PORT + 1, { FAKE_FIRST_DELAY_MS: '6000' });
  ctx.project = makeProject(ctx, 'proj');
  ctx.broken = makeProject(ctx, 'proj-broken', { '.mori/models.json': '{ "bogus": true }\n' });
  // synthetic test setup：四个提供商（本机、tool calling 判定不通过、地址上没有服务、慢）与三个分组，没有默认范围。
  seedConfig(ctx, { providers: [
    provider('local1', 'Local One', main.url, [model('fake-coder')]),
    provider('nt', 'No Tools P', main.url, [model('nt-coder-notools')]),
    provider('dead', 'Dead P', `http://127.0.0.1:${PORT + 2}/v1`, [model('dead-coder')]),
    provider('slowp', 'Slow P', slow.url, [model('slow-coder')]),
  ], groups: [group('mix', ['dead', 'nt']), group('slowg', ['slowp']), group('tmpg', ['local1'])] });
  await startApp(ctx);
  ctx.startedAt = Date.now();
  await step(ctx, 'no_pick', () => noPickStep(ctx));
  await step(ctx, 'verifying', () => verifyingStep(ctx));
  await step(ctx, 'no_candidate', () => noCandidateStep(ctx));
  await step(ctx, 'verify now', () => verifyNowStep(ctx));
  await step(ctx, 'pick_missing', () => pickMissingStep(ctx));
  await step(ctx, 'project_config', () => projectConfigStep(ctx));
}

/** @brief 场景 configInvalid（MP-09）：model-config.json 读不出时会话按 config_invalid 拒绝启动，文件不被覆盖。 */
async function configInvalidScenario(ctx) {
  const project = makeProject(ctx, 'proj');
  const file = join(ctx.userData, 'model-config.json');
  // synthetic test setup：写坏的配置文件。
  const broken = '{ "version": 1, "providers": [\n';
  writeFileSync(file, broken);
  await startApp(ctx);
  const { page } = ctx;
  const form = await page.getByTestId('connection-form').count();
  await openProject(ctx, project);
  const card = await waitBlocked(page, 'config_invalid');
  record('MP-09 config_invalid: card text "Model settings can’t be read: <path>: <message>"',
    card.title.startsWith('Model settings can’t be read: ') && card.title.includes('model-config.json')
    && card.title.length > 'Model settings can’t be read: '.length + file.length, card.title);
  record('MP-09 config_invalid: only "Open settings"; no first-run form',
    same(card.actions, [['open-settings', 'Open settings']]) && form === 0, JSON.stringify(card.actions));
  await clickCardAction(page, 'open-settings');
  const error = await page.getByTestId('models-load-error').innerText({ timeout: 10000 }).catch(() => '');
  record('MP-09 config_invalid: "Open settings" shows only the read error and Reload in Settings → Models',
    error.includes('Couldn’t read model settings:') && error.includes('Retry'), oneLine(error, 200));
  await backToChat(page);
  await send(page, 'plain must not be sent');
  await sleep(800);
  record('MP-09 config_invalid: sending is disabled and the file is not overwritten',
    (await userCount(page)) === 0 && readFileSync(file, 'utf8') === broken, '');
}

// ---------- 场景：探针与档案（MP-10） ----------

/** 加进 pv 的模型与期望的档案（合成端点的后缀各关掉一项探针能力） */
const PROBE_MODELS = [
  { id: 'fake-coder-notools', expect: { tool_calling: 'failed' } },
  { id: 'fake-coder-nochoice', expect: { tool_calling: 'verified', tier: 'B', reasoning: 'none' } },
  { id: 'fake-coder-noschema', expect: { tool_calling: 'verified', tier: 'A' } },
  { id: 'fake-coder-nochoice-noschema', expect: { tool_calling: 'verified', tier: 'C' } },
  { id: 'fake-coder-replay', reasoning: true, expect: { tool_calling: 'verified', tier: 'A',
    reasoning: 'reasoning_content' } },
];

/**
 * @brief 档案与模型行是否符合期望：等级、推理字段读档案（models.get）；tool calling 读档案与行上的 data-probe，判定失败的行
 *        有状态行"Tool calling failed verification: …"，验证通过的行没有状态行（models-settings.md "Models 行"）。
 */
function rowMatches(view, row, expect) {
  const facts = { tool_calling: view?.tool_calling.state, tier: view?.tier.level, reasoning: view?.reasoning.field };
  const profileOk = Object.entries(expect).every(([field, value]) => facts[field] === value);
  const line = expect.tool_calling === 'failed'
    ? row?.status?.state === 'failed' && row.status.text.startsWith('Tool calling failed verification: ')
    : row?.status === null;
  return profileOk && row?.probe === expect.tool_calling && line;
}

/** @brief 档案与行的要点（检查的 detail）。 */
const rowFactsOf = (view, row) => JSON.stringify({ tool: view?.tool_calling.state, tier: view?.tier.level,
  field: view?.reasoning.field, probe: row?.probe, status: row?.status });

/** @brief 加模型后自动探测：档案的 tool calling、等级、推理字段正确，模型行的 data-probe 与状态行随 tool calling。 */
async function probeRowsStep(ctx) {
  const { page } = ctx;
  await openModels(page);
  for (const spec of PROBE_MODELS) await addModelUi(page, 'pv', spec);
  const refs = PROBE_MODELS.map((spec) => `pv/${spec.id}`);
  const profiles = await waitProfiles(page, [...refs, 'pv/fake-coder'], finished, 240000);
  const base = await profileRow(page, 'pv/fake-coder');
  record('MP-10 pv/fake-coder: tool calling verified, handoff tier A, reasoning field none (profile); the row is '
    + 'verified with no status line', rowMatches(profiles['pv/fake-coder'], base, { tool_calling: 'verified',
    tier: 'A', reasoning: 'none' }), rowFactsOf(profiles['pv/fake-coder'], base));
  // 2026-10-26 负责人走查 M7：行上不再有探针按钮（WP-02 删按钮，WP-04 删第 8、9 步）；原来在 MP-11 的 consent 场景里查
  const has = (action) => Boolean(base?.actions.includes(action));
  record('MP-10 a verified model row offers Edit and Delete and no "Verify", "Test", "Long-input test…" or '
    + '"Cancel test…" (2026-10-26)', has('edit') && has('delete')
    && !['verify', 'test', 'long-input', 'cancel-test'].some(has), base?.actions.join(','));
  for (const spec of PROBE_MODELS) {
    const ref = `pv/${spec.id}`;
    const row = await profileRow(page, ref);
    const shown = Object.entries(spec.expect).map(([field, value]) => `${field}=${value}`).join(', ');
    record(`MP-10 ${ref}: added in Settings → Models, probed automatically; profile ${shown}, the row's data-probe `
      + 'and status line follow tool calling', rowMatches(profiles[ref], row, spec.expect),
    rowFactsOf(profiles[ref], row));
  }
  const replay = profiles['pv/fake-coder-replay']?.reasoning;
  record('MP-10 pv/fake-coder-replay: profile reasoning.replay is required', replay?.replay === 'required',
    JSON.stringify(replay));
  await backToChat(page);
}

/** 状态行"Verify again"的选择器（models-settings.md "Models 行"） */
const verifyAgainOf = (ref) => `[data-testid="model-row"][data-model="${ref}"] [data-testid="probe-status"] `
  + '[data-action="verify"]';

/**
 * @brief 状态行的 Verify again（models-settings.md "Models 行"的"Verify again"）：tool calling 判定为不通过的
 *        pv/fake-coder-notools 的状态行带 Verify again；点它发 models.verify（第 0–7 步）：行上 data-probe 变为
 *        reverifying、状态行"Verifying…"不带按钮，合成端点收到这个模型新的探针请求，结束后回到 failed、再带 Verify again。
 */
async function verifyAgainStep(ctx, ep) {
  const { page } = ctx;
  const ref = 'pv/fake-coder-notools';
  await openModels(page);
  const before = (await modelsInfo(page)).profiles[ref]?.probedAt ?? 0;
  const button = page.locator(verifyAgainOf(ref));
  const shown = { count: await button.count(),
    text: await button.first().textContent({ timeout: 2000 }).catch(() => null) };
  record(`MP-10 ${ref}: the status line "Tool calling failed verification: …" carries "Verify again"`,
    shown.count === 1 && shown.text === 'Verify again', JSON.stringify(shown));
  await watch(page, 'tool', ref);
  const clickedAt = Date.now();
  await button.click();
  await waitProfiles(page, [ref], (profile) => (profile?.probedAt ?? 0) > before, 120000);
  await until(() => page.evaluate((sel) => Boolean(document.querySelector(sel)), verifyAgainOf(ref)), 10000, 100);
  const states = await seen(page);
  const probes = ep.bodies.filter((body) => body.probe && body.model === 'fake-coder-notools' && body.at >= clickedAt);
  const settled = states.at(-1)?.startsWith('failed|failed|Verify again|Tool calling failed verification: ');
  record(`MP-10 ${ref}: clicking "Verify again" probes again (models.verify, steps 0–7): the row goes to reverifying `
    + 'with the status line "Verifying…" and no button, the endpoint gets new probe requests, and the row settles '
    + 'back to failed with "Verify again"', states.includes('reverifying|verifying||Verifying…') && probes.length > 0
    && settled === true, `${probes.length} probe requests; ${states.join(' > ')}`);
  await backToChat(page);
}

/**
 * @brief 并发 1、对话占着槽位时加模型：探针排在对话之后，对话结束后完成。从行出现到验证通过，行一直是验证中（排队等槽位的
 *        几秒也是），没有一刻是没有档案、不在探测的"Couldn’t verify"（models-settings.md "Models 行"：保存后探针在界面
 *        读到档案之前开始）。
 */
async function probeQueueStep(ctx, ep) {
  const { page } = ctx;
  await send(page, 'wait 8s');
  const convo = await until(() => talk(ep).find((body) => body.lastUser === 'wait 8s'), 10000, 100);
  if (!convo) throw new Error('the conversation request did not arrive');
  await openModels(page);
  await watch(page, 'tool', 'pv/fake-coder-late');
  await addModelUi(page, 'pv', { id: 'fake-coder-late' });
  const addedAt = Date.now();
  await waitProfiles(page, ['pv/fake-coder-late'], verified, 120000);
  await until(() => profileRow(page, 'pv/fake-coder-late').then((row) => row?.probe === 'verified'), 10000, 100);
  const states = await seen(page);
  const shown = ['verifying|verifying||Verifying…', 'verified|||'];
  record('MP-10 background: from the moment its row appears until it is verified, the queued model shows only '
    + '"Verifying…" (data-probe verifying), never "Couldn’t verify"', states[0] === shown[0]
    && states.at(-1) === shown[1] && states.every((state) => shown.includes(state)), states.join(' > '));
  const probes = ep.bodies.filter((body) => body.probe && body.model === 'fake-coder-late');
  const first = probes[0]?.at ?? 0;
  record('MP-10 background: with concurrency 1, probes of a model added during a conversation wait until it ends',
    addedAt < convo.at + 7000 && first >= convo.at + 7800,
    `conversation sent at 0 ms, model added at ${addedAt - convo.at} ms, first probe sent at ${first - convo.at} ms`);
  record('MP-10 background: the queued probes then complete and the model is verified', probes.length > 0,
    `${probes.length} probe requests`);
  await backToChat(page);
  await waitIdle(page, 30000);
}

/** @brief 场景 probes（MP-10）。 */
async function probesScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  // synthetic test setup：一个并发上限为 1 的提供商。
  seedConfig(ctx, { providers: [provider('pv', 'Probe Provider', ep.url, [model('fake-coder')], { concurrency: 1 })],
    normalDefault: 'pv' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['pv/fake-coder']);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'rows', () => probeRowsStep(ctx));
  await step(ctx, 'verify again', () => verifyAgainStep(ctx, ep));
  await step(ctx, 'background queue', () => probeQueueStep(ctx, ep));
}

// ---------- 场景：指纹与服务版本（MP-12） ----------

/** @brief model-profiles.json 里 fake-coder 的档案。 */
function storedProfile(ctx) {
  const file = join(ctx.userData, 'model-profiles.json');
  return JSON.parse(readFileSync(file, 'utf8')).profiles.find((item) => item.modelId === 'fake-coder');
}

/** @brief 改窗口后重新探测；重新探测期间打开的会话照常发送。 */
async function windowChangeStep(ctx, ep) {
  const { page } = ctx;
  const before = storedProfile(ctx);
  await openModels(page);
  await watch(page, 'tool', 'fp/fake-coder');
  await page.locator('[data-testid="model-row"][data-model="fp/fake-coder"] [data-action="edit"]').click();
  const form = page.getByTestId('model-form');
  await form.getByLabel('Context window').fill('100000');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const reverifying = (value) => value.startsWith('reverifying|');
  await until(() => page.evaluate(() => (window.__seen ?? []).some((value) => value.startsWith('reverifying|'))),
    10000, 200);
  const tools = await seen(page);
  record('MP-12 changing the context window re-probes the model: the row’s data-probe goes to reverifying, and the '
    + 'verified model shows no status line throughout (2026-10-26)', tools.some(reverifying)
    && tools.every((value) => value.split('|')[1] === ''), tools.join(' > '));
  await backToChat(page);
  await watch(page, 'card');
  await sendTurn(page, 'plain during re-verify');
  const sentAt = talk(ep).find((body) => body.lastUser === 'plain during re-verify')?.at ?? 0;
  const reply = await lastReply(page);
  const cards = await seen(page);
  const after = await waitProfiles(page, ['fp/fake-coder'], (profile) => profile?.probedAt > before.probedAt, 180000);
  const laterProbes = ep.bodies.filter((body) => body.probe && body.at > sentAt).length;
  record('MP-12 while re-verifying, the open session still sends (old result used for selection)',
    reply.includes(PLAIN_REPLY) && same(cards, ['none']) && laterProbes > 0,
    `cards ${cards.join(' > ')}; probe requests after the message ${laterProbes}`);
  const stored = storedProfile(ctx);
  record('MP-12 the new profile replaces the old one after re-probing (new fingerprint, declared window 100000)',
    stored.fingerprint !== before.fingerprint && after['fp/fake-coder'].context.declared === 100000,
    `declared ${after['fp/fake-coder'].context.declared}`);
}

/** @brief 两次启动之间服务版本变了：启动时重新探测；第三次启动时端点连不上：档案不变。 */
async function versionStep(ctx, endpoint) {
  await stopApp(ctx);
  await endpoint.stop();
  const ep = await startEndpoint(ctx, PORT, { FAKE_SERVER_VERSION: '0.11.0' });
  const before = storedProfile(ctx);
  await startApp(ctx);
  const changed = await until(() => {
    const stored = storedProfile(ctx);
    return stored.auto.server.version === '0.11.0' ? stored : null;
  }, 120000, 500);
  record('MP-12 a different FAKE_SERVER_VERSION at the next launch re-probes the model',
    Boolean(changed) && ep.bodies.some((body) => body.probe) && changed.probedAt > before.probedAt,
    `version ${before.auto.server.version} → ${changed?.auto.server.version}; `
    + `probe requests ${ep.bodies.filter((body) => body.probe).length}`);
  await stopApp(ctx);
  await ep.stop();
  const text = readFileSync(join(ctx.userData, 'model-profiles.json'), 'utf8');
  await startApp(ctx);
  await openRowFile(ctx.page, ctx.sessionFile).catch(() => {});
  await sleep(8000);
  const view = (await modelsInfo(ctx.page)).profiles['fp/fake-coder'];
  record('MP-12 version endpoint unreachable at launch and on session open: the profile is unchanged',
    readFileSync(join(ctx.userData, 'model-profiles.json'), 'utf8') === text && view?.tool_calling.state === 'verified',
    `tool calling ${view?.tool_calling.state}`);
}

/** @brief 场景 fingerprint（MP-12）。 */
async function fingerprintScenario(ctx) {
  // 每个请求先等 1.5 秒：一组探针要十几秒，回复只要两秒，测"重新探测期间仍可发送"。
  const ep = await startEndpoint(ctx, PORT, { FAKE_FIRST_DELAY_MS: '1500', FAKE_SERVER_VERSION: '0.10.1' });
  seedConfig(ctx, { providers: [provider('fp', 'FP Provider', ep.url, [model('fake-coder')])], normalDefault: 'fp' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['fp/fake-coder'], verified, 180000);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'window change', () => windowChangeStep(ctx, ep));
  ctx.sessionFile = await activeFile(ctx.page);
  await step(ctx, 'server version', () => versionStep(ctx, ep));
}

// ---------- 场景：接手判断与重建（MP-21，含 MP-34 的重建阶段行） ----------

/** @brief 先由 A 用一条有工具调用的消息开头，再发 count 条带填充文字的 plain 消息，最后一条短消息。 */
async function buildHistory(page, label, count = 0, size = 6000) {
  await sendTurn(page, `hi there ${label}`);
  for (let index = 0; index < count; index += 1) await sendTurn(page, `plain ${label}-${index} ${filler(size)}`);
  if (count > 0) await sendTurn(page, `plain ${label} short`);
}

/** @brief 发一条消息前后的对照：提示、错误卡、v0 压缩提示、代理记下的新请求、合成端点日志的新行。 */
async function turnWith(ctx, ep, text, fn = null) {
  const { page } = ctx;
  const mark = { bodies: ep.bodies.length, log: ep.log.length, notices: (await notices(page)).length };
  const compactedBefore = (await notices(page)).filter((item) => item.text === COMPACTED_NOTICE).length;
  await (fn ? fn() : sendTurn(page, text));
  const all = await notices(page);
  return { sent: ep.bodies.slice(mark.bodies), lines: ep.log.slice(mark.log), notices: all.slice(mark.notices),
    errors: await errorCount(page), unavailable: await paneOf(page).getByTestId('unavailable-card').count(),
    compacted: all.filter((item) => item.text === COMPACTED_NOTICE).length - compactedBefore,
    reply: await lastReply(page) };
}

/** @brief 段开始、对话很短：只去掉工具调用（不压缩），提示文字。 */
async function startStripCase(ctx, ep) {
  const { page } = ctx;
  await buildHistory(page, 's1');
  await choosePick(page, 'pb/fake-coder-replay');
  const turn = await turnWith(ctx, ep, 'plain s1 after switch');
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  record('MP-21 reply start, short conversation: strip only; notice "Rebuilt the conversation for '
    + 'pb/fake-coder-replay: recent turns without tool calls"', rebuild?.summary === 'false'
    && rebuild.text === 'Rebuilt the conversation for pb/fake-coder-replay: recent turns without tool calls',
  JSON.stringify(rebuild ?? turn.notices));
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'fake-coder-replay');
  record('MP-21 reply start, short conversation: no compaction; the -replay model gets the history without tool calls',
    turn.sent.every((body) => !body.summary) && request && !hasToolHistory(request.messages), brief(request));
  record('MP-21 reply start, short conversation: the -replay model accepts it (no 400) and replies; no error card',
    turn.lines.every((line) => line.status !== 400) && turn.reply.includes(PLAIN_REPLY) && turn.errors === 0,
    turn.lines.map((line) => `${line.model}:${line.status}`).join(','));
  const entry = customs(await activeFile(page), 'mori.rebuild').at(-1);
  record('MP-21 reply start, short conversation: the session file records mori.rebuild { summary: false }',
    entry?.model === 'pb/fake-coder-replay' && entry.summary === false, JSON.stringify(entry));
}

/** @brief 段开始、对话较长：由新模型压缩出摘要再接手；阶段行显示重建中（MP-34）。 */
async function startRebuildCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await buildHistory(page, 's2', 3, 6000);
  await choosePick(page, 'pb/fake-coder-replay');
  const users = await userCount(page);
  await watch(page, 'stage');
  const turn = await turnWith(ctx, ep, 'plain s2 after long history');
  const stages = await seen(page);
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  record('MP-21 reply start, long conversation: rebuild with summary; notice "Rebuilt the conversation for '
    + 'pb/fake-coder-replay: summary + recent turns"', rebuild?.summary === 'true'
    && rebuild.text === 'Rebuilt the conversation for pb/fake-coder-replay: summary + recent turns',
  JSON.stringify(rebuild ?? turn.notices));
  const summary = turn.sent.find((body) => body.summary);
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'fake-coder-replay');
  const keeps = request?.messages.some((message) => contentText(message.content).includes(SUMMARY_TEXT));
  record('MP-21 reply start, long conversation: the compaction is made by the -replay model',
    summary?.model === 'fake-coder-replay', brief(summary));
  record('MP-21 reply start, long conversation: the rebuilt context keeps the compaction summary and has no tool calls',
    Boolean(keeps) && !hasToolHistory(request.messages) && turn.reply.includes(PLAIN_REPLY), brief(request));
  record('MP-21 rebuild: no v0 compaction notice and no error card while rebuilding',
    turn.compacted === 0 && turn.errors === 0, `compaction notices +${turn.compacted}, error cards ${turn.errors}`);
  const want = 'rebuild|Rebuilding the conversation for pb/fake-coder-replay…';
  record('MP-34 preparing: the stage line shows "Rebuilding the conversation for <B>…" with the message already shown',
    stages.includes(`${want}|${users + 1}`), stages.join(' > '));
}

/** @brief 段内换到 -replay 模型：只去掉工具调用，不压缩，新模型接手。 */
async function inReplyStripCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await choosePick(page, 'g3');
  await buildHistory(page, 's3');
  const turn = await turnWith(ctx, ep, 'plain s3 http-404-once');
  const change = turn.notices.find((item) => item.kind === 'model-switch');
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  record('MP-21 in reply: switching to the -replay model shows the switch and "recent turns without tool calls"',
    change?.from === 'pa3/fake-coder' && change.to === 'pb/fake-coder-replay' && rebuild?.summary === 'false',
    JSON.stringify(turn.notices));
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'fake-coder-replay');
  record('MP-21 in reply: strip only — no compaction request; the -replay model gets no tool calls and replies',
    turn.sent.every((body) => !body.summary) && request && !hasToolHistory(request.messages)
    && turn.lines.every((line) => line.status !== 400 || line.model !== 'fake-coder-replay')
    && turn.reply.includes(PLAIN_REPLY) && turn.errors === 0, brief(request));
}

/** @brief 窗口小的模型：段开始时重建后接手。 */
async function smallStartCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await buildHistory(page, 's4', 3, 10000);
  await choosePick(page, 'ps/small-coder');
  const turn = await turnWith(ctx, ep, 'plain s4 small window');
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  const summary = turn.sent.find((body) => body.summary);
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'small-coder');
  record('MP-21 small window, reply start: rebuilt (summary by the small model) and the small model replies',
    rebuild?.summary === 'true' && rebuild.text.startsWith('Rebuilt the conversation for ps/small-coder')
    && summary?.model === 'small-coder' && Boolean(request) && turn.reply.includes(PLAIN_REPLY)
    && turn.errors === 0 && turn.unavailable === 0, `${JSON.stringify(rebuild)}; ${brief(summary)}; ${brief(request)}`);
}

/** @brief 窗口小的模型：段内换不过去（no_handover），没有别的候选时一张说明卡。 */
async function smallReplyCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await choosePick(page, 'g4');
  await buildHistory(page, 's5', 3, 10000);
  const turn = await turnWith(ctx, ep, 'plain s5 http-404-once');
  const card = paneOf(page).getByTestId('unavailable-card').last();
  const lines = await card.locator('[data-testid="candidate"]').evaluateAll((items) => items.map((item) =>
    `${item.dataset.reason}:${item.textContent}`)).catch(() => []);
  record('MP-21 small window, in reply: the small model is excluded (no compaction during the reply)',
    turn.sent.every((body) => !body.summary) && turn.sent.every((body) => body.probe || body.model !== 'small-coder')
    && lines.includes('no_handover:ps2/small-coder — conversation too long for this model'),
    `${lines.join(' | ')}; ${turn.sent.map(brief).join(' ; ')}`);
  record('MP-21 small window, in reply: one No model available card, no error card',
    turn.unavailable === 1 && turn.errors === 0, `unavailable ${turn.unavailable}, errors ${turn.errors}`);
}

/** @brief 重建的压缩失败：换到下一个候选，对话流没有错误卡。 */
async function rebuildFailureCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await buildHistory(page, 's6', 3, 6000);
  await choosePick(page, 'g5');
  ep.failSummary = 400;
  let turn;
  try {
    turn = await turnWith(ctx, ep, 'plain s6 after failed rebuild');
  } finally {
    ep.failSummary = null;
  }
  const failed = turn.sent.find((body) => body.summary && body.failed);
  const answer = turn.sent.find((body) => !body.probe && !body.summary && body.lastUser.startsWith('plain s6 after'));
  record('MP-21 rebuild compaction fails: the -replay candidate is skipped and the next candidate answers',
    failed?.model === 'fake-coder-replay' && answer?.model === 'alt-coder'
    && turn.sent.every((body) => body.summary || body.model !== 'fake-coder-replay')
    && turn.reply.includes(PLAIN_REPLY), `${brief(failed)}; ${brief(answer)}`);
  record('MP-21 rebuild compaction fails: no error card, no v0 compaction notice, no No model available card',
    turn.errors === 0 && turn.compacted === 0 && turn.unavailable === 0,
    `errors ${turn.errors}, compaction notices +${turn.compacted}, unavailable ${turn.unavailable}`);
}

/** @brief 场景 handover（MP-21；重建的阶段行记为 MP-34）。 */
async function handoverScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT, { FAKE_FIRST_DELAY_MS: '300' });
  // synthetic test setup：压缩只保留最近约 300 token，较长的对话才有东西可压缩。
  seedPiSettings(ctx, { compaction: { reserveTokens: 1000, keepRecentTokens: 300 } });
  const replay = model('fake-coder-replay', { reasoning: true });
  const small = model('small-coder', { ctx: 6000, max: 1000 });
  seedConfig(ctx, { providers: [
    provider('pa', 'A', ep.url, [model('fake-coder')]), provider('pb', 'B', ep.url, [replay]),
    provider('pa3', 'A3', ep.url, [model('fake-coder')]), provider('pa4', 'A4', ep.url, [model('fake-coder')]),
    provider('ps', 'S', ep.url, [small]), provider('ps2', 'S2', ep.url, [small]),
    provider('pb5', 'B5', ep.url, [replay]), provider('pc', 'C', ep.url, [model('alt-coder')]),
  ], groups: [group('g3', ['pa3', 'pb']), group('g4', ['pa4', 'ps2']), group('g5', ['pb5', 'pc'])],
  normalDefault: 'pa' });
  await startApp(ctx);
  const refs = ['pa/fake-coder', 'pb/fake-coder-replay', 'pa3/fake-coder', 'pa4/fake-coder', 'ps/small-coder',
    'ps2/small-coder', 'pb5/fake-coder-replay', 'pc/alt-coder'];
  const profiles = await waitProfiles(ctx.page, refs, verified, 180000);
  record('MP-21 setup: the -replay model is profiled as reasoning.replay required',
    profiles['pb/fake-coder-replay'].reasoning.replay === 'required',
    JSON.stringify(profiles['pb/fake-coder-replay'].reasoning));
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'reply start strip', () => startStripCase(ctx, ep));
  await step(ctx, 'reply start rebuild', () => startRebuildCase(ctx, ep));
  await step(ctx, 'in-reply strip', () => inReplyStripCase(ctx, ep));
  await step(ctx, 'small window at start', () => smallStartCase(ctx, ep));
  await step(ctx, 'small window in reply', () => smallReplyCase(ctx, ep));
  await step(ctx, 'rebuild failure', () => rebuildFailureCase(ctx, ep));
}

// ---------- 场景：压缩走 Mori（MP-22） ----------

/** 压缩提供商的 key（synthetic）：合成端点日志只记末 4 位 c22k */
const COMPACT_KEY = 'synthetic-v1-session-compaction-key-c22k';

/** @brief 压缩请求都用 cmp-coder 和它的 key。 */
const viaPool = (bodies) => bodies.length > 0 && bodies.every((body) => body.model === 'cmp-coder'
  && body.auth === `Bearer ${COMPACT_KEY}`);

/** @brief overflow-once：溢出恢复的压缩经模型池，用当前模型和 key，之后重试成功。 */
async function overflowStep(ctx, ep, ep2) {
  const { page } = ctx;
  for (let index = 0; index < 3; index += 1) await sendTurn(page, `plain c${index} ${filler(2000)}`);
  const turn = await turnWith(ctx, ep, 'plain overflow-once please');
  const summaries = turn.sent.filter((body) => body.summary);
  const overflow = turn.lines.find((line) => line.status === 400 && !line.probe);
  const keys = [...new Set(turn.lines.filter((line) => !line.probe).map((line) => `${line.model}/${line.key}`))];
  record('MP-22 overflow-once: the recovery compaction goes through the pool with the current model and its key',
    Boolean(overflow) && viaPool(summaries) && same(keys, ['cmp-coder/c22k']),
    `400=${Boolean(overflow)}; summaries ${summaries.map(brief).join(' ; ')}; log ${keys.join(',')}`);
  record('MP-22 overflow-once: compaction then retry on the same model; the reply arrives, no model switch',
    turn.reply.includes(PLAIN_REPLY) && turn.compacted === 1 && same(turn.lines.map((line) => line.status), [400, 200, 200])
    && turn.notices.every((item) => item.kind !== 'model-switch') && talk(ep2).length === 0,
    `compaction notices +${turn.compacted}, other provider ${talk(ep2).length}, reply "${oneLine(turn.reply, 60)}", `
    + `log ${turn.lines.map((line) => line.status).join(',')}`);
  // §5.4：上下文超长不是让回复以错误结束的分类，由 pi 的溢出恢复处理；§9.3 的错误卡只给 server 重试用完、request、partial。
  record('MP-22 overflow-once: the recovered overflow error is not shown as an error card',
    turn.errors === 0, JSON.stringify(await paneOf(page).getByTestId('error-card').allInnerTexts()));
}

/** @brief 一直发长消息，直到出现一次压缩请求（最多 limit 条）；返回这段的对照。 */
async function untilCompaction(ctx, ep, label, limit = 6) {
  const { page } = ctx;
  const mark = { bodies: ep.bodies.length, log: ep.log.length };
  const errorsBefore = await errorCount(page);
  for (let index = 0; index < limit; index += 1) {
    await sendTurn(page, `plain ${label}${index} ${filler(16000)}`);
    const found = await until(() => ep.bodies.slice(mark.bodies).some((body) => body.summary), 4000, 200);
    if (found) break;
  }
  await waitIdle(page, 60000);
  await sleep(1000);
  return { sent: ep.bodies.slice(mark.bodies), lines: ep.log.slice(mark.log),
    errors: (await errorCount(page)) - errorsBefore, notices: await notices(page) };
}

/** @brief 到阈值的自动压缩经模型池，用当前模型和 key。 */
async function thresholdStep(ctx, ep, ep2) {
  const before = (await notices(ctx.page)).filter((item) => item.text === COMPACTED_NOTICE).length;
  const phase = await untilCompaction(ctx, ep, 't');
  const summaries = phase.sent.filter((body) => body.summary);
  const after = phase.notices.filter((item) => item.text === COMPACTED_NOTICE).length;
  record('MP-22 threshold compaction goes through the pool with the current model and its key',
    viaPool(summaries) && phase.lines.every((line) => line.status !== 400) && after > before
    && phase.lines.filter((line) => !line.probe).every((line) => line.model === 'cmp-coder' && line.key === 'c22k'),
    `summaries ${summaries.map((body) => `${body.model}/${body.auth?.slice(-4)}`).join(',')}; notices ${before}→${after}`);
  record('MP-22 threshold compaction: the other candidate gets nothing', talk(ep2).length === 0, '');
}

/** @brief 压缩出错：由 pi 报告压缩失败，不换模型。 */
async function compactionErrorStep(ctx, ep, ep2) {
  ep.failSummary = 400;
  let phase;
  try {
    phase = await untilCompaction(ctx, ep, 'e');
  } finally {
    ep.failSummary = null;
  }
  const failed = phase.sent.filter((body) => body.summary && body.failed);
  record('MP-22 compaction error: pi reports the failed compaction (error card); no model switch',
    failed.length > 0 && viaPool(failed) && phase.errors >= 1
    && phase.notices.every((item) => item.kind !== 'model-switch') && talk(ep2).length === 0,
    `failed summaries ${failed.length}, new error cards ${phase.errors}, other provider ${talk(ep2).length}`);
}

/** @brief 场景 compaction（MP-22）。 */
async function compactionScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  const ep2 = await startEndpoint(ctx, PORT + 1);
  // synthetic test setup：窗口 32000、保留 16000 → 约 16000 token 时自动压缩；只保留最近约 300 token。
  seedPiSettings(ctx, { compaction: { reserveTokens: 16000, keepRecentTokens: 300 } });
  seedConfig(ctx, { providers: [
    provider('cp', 'Compact P', ep.url, [model('cmp-coder', { ctx: 32000, max: 4000 })]),
    provider('cp2', 'Compact Two', ep2.url, [model('cmp-two')]),
  ], groups: [group('gc', ['cp', 'cp2'])], normalDefault: 'gc' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['cp/cmp-coder', 'cp2/cmp-two']);
  // synthetic test setup：经进程桥给 cp 加一个 key（只是测试值），之后的请求都带它。
  const added = await bridge(ctx.page, { type: 'models.addKey', providerId: 'cp', label: 'Key 1', secret: COMPACT_KEY });
  if (added?.error) throw new Error(`models.addKey failed: ${added.error}`);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'overflow-once', () => overflowStep(ctx, ep, ep2));
  await step(ctx, 'threshold', () => thresholdStep(ctx, ep, ep2));
  await step(ctx, 'compaction error', () => compactionErrorStep(ctx, ep, ep2));
}

// ---------- 场景：输入框下面一行的选择范围（MP-23） ----------

/**
 * @brief 点开范围菜单，读出各节、各项、说明与 Manage models，再 Esc 关上；另记下菜单的位置（rangeMenuPlace）、打开时和
 *        Esc 之后焦点在哪里。
 */
async function readMenu(page) {
  await paneOf(page).getByTestId('model-button').click();
  const menu = page.getByTestId('model-menu');
  await menu.waitFor({ timeout: 5000 });
  const place = await rangeMenuPlace(page);
  const opened = await focusKind(page);
  const state = await menu.evaluate((element) => ({
    sections: [...element.querySelectorAll('[data-section]')].map((item) => item.dataset.section),
    items: [...element.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ pick: item.dataset.pick,
      label: item.querySelector('.switch-text')?.textContent, zoneMark: Boolean(item.querySelector('.pick-zone'))
        || 'zone' in item.dataset,
      checked: item.getAttribute('aria-checked') === 'true', excluded: item.dataset.excluded === 'true',
      title: item.title, section: item.closest('[data-section]')?.dataset.section })),
    providerNames: [...element.querySelectorAll('.model-group-name')].map((item) => item.textContent),
    note: element.querySelector('[data-testid="model-menu-note"]')?.textContent ?? null,
    manage: element.querySelector('[data-action="manage-models"]')?.textContent ?? null,
  }));
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  return { ...state, place, focus: { opened, closed: await focusKind(page) } };
}

/** @brief 新会话的按钮文字、悬停、在输入框下面一行的位置与菜单。 */
async function menuStep(ctx) {
  const { page } = ctx;
  const bar = await pickers(page);
  record('MP-23 label: a group range shows "<group id> · <current model id>"; hover line 1 is the button text, '
    + 'line 2 "<provider name>"', bar.text === 'g1 · m1' && bar.pick === 'g1' && bar.current === 'p1/m1'
    && bar.tip[0] === 'g1 · m1' && bar.tip[1] === 'Provider One' && bar.tip.length === 2, JSON.stringify(bar));
  record('MP-06 the range button hover line 2 is only the provider name ("Provider One", no " · <zone>")',
    bar.tip[1] === 'Provider One', JSON.stringify(bar.tip));
  record('MP-23 the range button is in the message-box row, not the top bar: name "Model range: g1, m1", described '
    + 'by hover line 2 as "Provider One" (a hidden model-tip outside the button), no aria-disabled while usable',
  bar.inRow && !bar.inTopbar && bar.name === rangeName('g1 · m1') && bar.described === 'Provider One'
    && bar.tipOutside && bar.ariaDisabled === null && !bar.disabled, JSON.stringify(bar));
  const menu = await readMenu(page);
  record('MP-23 menu: opens upward from the message-box row, right-aligned with the range button, 300px wide, inside '
    + 'the pane and the window, not over the top bar; the focus starts on the ticked range, Esc returns it to '
    + 'the button',
  menu.place?.problems.length === 0 && menu.focus.opened === 'item:g1' && menu.focus.closed === 'model-button',
  `${menu.place?.problems.join('; ')} ${placeBrief(menu.place?.geo)} focus ${JSON.stringify(menu.focus)}`);
  const picks = (section) => menu.items.filter((item) => item.section === section).map((item) => item.label);
  record('MP-23 menu: sections Groups / Providers / Models (models under provider names)',
    same(menu.sections.filter((item) => ['groups', 'providers', 'models'].includes(item)),
      ['groups', 'providers', 'models'])
    && same(picks('groups'), ['g1', 'gbad'])
    && same(picks('providers'), ['Provider One', 'Provider Two', 'Provider Three', 'No Tools Provider'])
    && same(picks('models'), ['m1', 'm1b', 'm2a', 'm3', 'pn-notools'])
    && same(menu.providerNames, ['Provider One', 'Provider Two', 'Provider Three', 'No Tools Provider']),
    JSON.stringify({ sections: menu.sections, names: menu.providerNames, items: menu.items.map((item) => item.pick) }));
  const byPick = Object.fromEntries(menu.items.map((item) => [item.pick, item]));
  const faded = ['gbad', 'pn', 'pn/pn-notools'].every((pick) => byPick[pick]?.excluded
    && byPick[pick].title.includes('pn/pn-notools — tool calling failed verification'));
  record('MP-23 menu: items whose candidates are all excluded are faded with the reason on hover, still selectable',
    faded && !byPick.g1?.excluded && !byPick.p2?.excluded, JSON.stringify(['gbad', 'pn', 'pn/pn-notools', 'g1']
      .map((pick) => [pick, byPick[pick]?.excluded, byPick[pick]?.title])));
  record('MP-06 the range menu items carry no zone mark (no .pick-zone, no data-zone); each shows only its name',
    menu.items.length > 0 && menu.items.every((item) => !item.zoneMark), JSON.stringify(menu.items
      .map((item) => [item.pick, item.label, item.zoneMark])));
  record('MP-23 menu: the current range ticked, bottom note and "Manage models"',
    byPick.g1?.checked
    && menu.note === 'Applies to this session only. New sessions use the default range from Settings.'
    && menu.manage === 'Manage models', JSON.stringify({ g1: byPick.g1, note: menu.note, manage: menu.manage }));
}

/** @brief 选提供商：写进会话文件、不改默认范围；按钮格式；选模型；生成中不能改。 */
async function pickStep(ctx, ep) {
  const { page } = ctx;
  await watchPickers(page);
  await choosePick(page, 'p2');
  const states = await seenPickers(page);
  const bar = await pickers(page);
  record('MP-23 label: a provider range shows "<provider name> · <model id>"', bar.text === 'Provider Two · m2a',
    bar.text);
  // 切换中（session.setPick 还没返回）：两个按钮共用一个切换中的值，都带 data-pending 和 aria-disabled；范围按钮的悬停
  // 只有第一行、没有读屏的描述（composer-pickers.md"悬停和读屏的描述"、C1）。
  const switching = states.find((s) => s.rp && s.ra && s.e && s.ep && s.ea);
  record('MP-23 switching: while session.setPick runs the range button and Effort both carry data-pending="true" and '
    + 'aria-disabled; the range hover is just the chosen range, with no description; afterwards neither is '
    + 'aria-disabled',
  Boolean(switching) && switching.rt.length === 1 && switching.rd === '' && !bar.ariaDisabled
    && !bar.thinking?.ariaDisabled && !bar.pending && !bar.thinking?.pending,
  `${JSON.stringify(switching ?? states.slice(-3))}; after ${bar.ariaDisabled}/${bar.thinking?.ariaDisabled}`);
  await sendTurn(page, 'plain range one');
  ctx.s1 = await activeFile(page);
  const picks = customs(ctx.s1, 'mori.pick').map((item) => item.pick);
  record('MP-23 choosing a provider writes mori.pick into the session file (jsonl) and the next reply uses it',
    picks.at(-1) === 'p2' && talk(ep).at(-1)?.model === 'm2a', `picks ${picks.join(',')}; ${brief(talk(ep).at(-1))}`);
  record('MP-23 choosing in the range menu does not change the default range in model-config.json',
    readConfig(ctx).normalDefault === 'g1', String(readConfig(ctx).normalDefault));
  ctx.s2 = await ctrlN(page);
  await sendTurn(page, 'plain range two');
  ctx.s2 = await activeFile(page);
  ctx.s3 = await ctrlN(page);
  await choosePick(page, 'p3/m3');
  const modelBar = await pickers(page);
  record('MP-23 label: a model range shows just the model id', modelBar.text === 'm3', modelBar.text);
  await send(page, 'wait 3s');
  await until(() => page.evaluate((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE),
    10000, 100);
  const busy = await pickers(page);
  const { hit, menu } = await clickBusyRange(page);
  record(`MP-23 generating: the Effort button is unavailable (aria-disabled, still focusable) and the range button `
    + 'stays usable (2026-10-26: it opens the menu to switch task mode); range hover '
    + `line 3 "${BUSY_TITLE}", Effort hover line 2 "${EFFORT_BUSY}"`, !busy.unavailable && !busy.disabled
    && same(busy.tip, ['m3', 'Provider Three', BUSY_TITLE]) && busy.thinking?.unavailable === true
    && !busy.thinking.disabled && same(busy.thinking.tip, ['Effort: Unavailable', EFFORT_BUSY]), JSON.stringify(busy));
  record('MP-23 generating: the range description is "Provider Three. <reason>", the Effort description is the '
    + `reason (no line 1); clicking the range button opens its menu with every range item disabled and the note `
    + `"${BUSY_TITLE}" (docs/v1/screens/model-menu.md)`,
  busy.described === rangeDescription('Provider Three', BUSY_TITLE) && busy.thinking?.described === EFFORT_BUSY
    && hit && menu !== null && menu.items > 0 && menu.disabled === menu.items && menu.note === BUSY_TITLE,
  `${busy.described} | ${busy.thinking?.described} | hit ${hit} | menu ${JSON.stringify(menu)}`);
  await waitIdle(page, 30000);
  ctx.s3 = await activeFile(page);
}

/**
 * @brief 回复进行中在范围按钮中间点一下鼠标（2026-10-26 起按钮可用，model-menu.md"回复进行中的菜单"），返回点的那一点
 *        是否落在按钮上，和打开的菜单里范围的项有几个、几个不可用、说明的文字（没开菜单时为 null）；看完按 Esc 关上。
 */
async function clickBusyRange(page) {
  const range = paneOf(page).getByTestId('model-button');
  const hit = await range.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
  await range.click();
  const menu = await page.getByTestId('model-menu').evaluate((el) => {
    const items = [...el.querySelectorAll('[role="menuitemradio"]')];
    return { items: items.length, disabled: items.filter((item) => item.disabled).length,
      note: el.querySelector('[data-testid="model-menu-note"]')?.textContent ?? null };
  }, null, { timeout: 3000 }).catch(() => null);
  if (menu) await page.keyboard.press('Escape');
  return { hit, menu };
}

/** @brief 改设置里的默认范围：已有会话不变，新会话用新的。 */
async function defaultStep(ctx) {
  const { page } = ctx;
  await openModels(page);
  await page.getByTestId('default-pick').selectOption('p3');
  await until(() => readConfig(ctx).normalDefault === 'p3', 10000, 200);
  await backToChat(page);
  const s3 = await pickers(page);
  await openRowFile(page, ctx.s1);
  const s1 = await pickers(page);
  await openRowFile(page, ctx.s2);
  const s2 = await pickers(page);
  record('MP-23 changing the default range leaves existing sessions alone (including one that never switched)',
    s1.pick === 'p2' && s2.pick === 'g1' && s3.pick === 'p3/m3', `s1=${s1.pick} s2=${s2.pick} s3=${s3.pick}`);
  await ctrlN(page);
  const s4 = await pickers(page);
  record('MP-23 a new session uses the new default range', s4.pick === 'p3' && s4.text === 'Provider Three · m3',
    JSON.stringify(s4));
}

/** @brief v0 的旧会话：打开后以最后一条助手消息的模型为范围，并记下 mori.pick。 */
async function v0Step(ctx) {
  const { page } = ctx;
  await openRowFile(page, ctx.v0File);
  const bar = await pickers(page);
  const picks = await until(() => {
    const list = customs(ctx.v0File, 'mori.pick');
    return list.length > 0 ? list : null;
  }, 5000, 200);
  record('MP-23 a v0 session (no mori.pick) opens with its last assistant model as the range and records it',
    bar.pick === 'p1/m1b' && bar.text === 'm1b' && picks?.at(-1)?.pick === 'p1/m1b',
    `${JSON.stringify(bar)}; file picks ${JSON.stringify(picks)}`);
}

/** @brief 重新启动后打开会话：范围沿用会话文件里的。 */
async function reopenStep(ctx) {
  await stopApp(ctx);
  await startApp(ctx);
  await openRowFile(ctx.page, ctx.s1);
  const s1 = await pickers(ctx.page);
  await openRowFile(ctx.page, ctx.s2);
  const s2 = await pickers(ctx.page);
  record('MP-23 after a restart, reopened sessions keep their ranges (p2 and g1)',
    s1.pick === 'p2' && s1.text === 'Provider Two · m2a' && s2.pick === 'g1', `s1=${s1.text} s2=${s2.text}`);
}

/** @brief 场景 range（MP-23）。 */
async function rangeScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  const project = makeProject(ctx, 'proj');
  // synthetic test setup：三个本机提供商、一个 tool calling 判定不通过的提供商（菜单里变淡），默认范围 g1。
  seedConfig(ctx, { providers: [
    provider('p1', 'Provider One', ep.url, [model('m1'), model('m1b')]),
    provider('p2', 'Provider Two', ep.url, [model('m2a')]),
    provider('p3', 'Provider Three', ep.url, [model('m3')]),
    provider('pn', 'No Tools Provider', ep.url, [model('pn-notools')]),
  ], groups: [group('g1', ['p1', 'p3/m3']), group('gbad', ['pn'])], normalDefault: 'g1' });
  ctx.v0File = seedV0Session(ctx, resolve(project), 'p1', 'm1b');
  await startApp(ctx);
  await waitProfiles(ctx.page, ['p1/m1', 'p1/m1b', 'p2/m2a', 'p3/m3']);
  // pn 的 tool calling 永远验证不了（菜单里变淡的原因）：等它的探针跑完、判定为 failed
  await waitProfiles(ctx.page, ['pn/pn-notools'],
    (profile) => finished(profile) && profile.tool_calling?.state === 'failed');
  await openProject(ctx, project);
  await step(ctx, 'menu', () => menuStep(ctx));
  await step(ctx, 'pick', () => pickStep(ctx, ep));
  await step(ctx, 'default', () => defaultStep(ctx));
  await step(ctx, 'v0 session', () => v0Step(ctx));
  await step(ctx, 'reopen', () => reopenStep(ctx));
}

// ---------- 场景：输入框下面一行里的范围按钮（MP-23；composer-pickers.md"测试要改的地方"新加的检查） ----------

/** 文字约 161px（按钮约 193px，Segoe UI 12px）的提供商范围：宽于 680px 时完整显示，600px 最挤时先截模型 id */
const WIDE = { pick: 'wide', text: 'Wide Provider · wide-coder-v2', hover: 'Wide Provider' };
/** 名字很长的提供商：280px 一栏里的范围菜单（收到这一行的宽，约 226px）放不下它的名字 */
const LONG_NAME = 'Provider With A Really Long Display Name';
/** 分屏时左右两栏 */
const SIDE = { left: '.pane-slot[data-side="left"] [data-testid="chat-pane"]',
  right: '.pane-slot[data-side="right"] [data-testid="chat-pane"]' };

/** @brief 930px、空闲、提供商范围：这一行从左到右的几项、范围按钮完整显示、悬停与描述（新加的检查第 2、3 条）。 */
async function rowWideStep(ctx) {
  const { page } = ctx;
  await openProject(ctx, ctx.project);
  await waitBlocked(page, 'no_pick');
  await choosePick(page, WIDE.pick);
  // 先回答一轮：用量在 turn_end 之后刷新，拒绝启动时 pi 可能没有用量（圆环不显示）
  await sendTurn(page, 'plain row one');
  const facts = await rowFacts(page);
  const bar = await pickers(page);
  record('MP-23 row: left to right the permission button, the range button, Effort, the usage ring and Send, each a '
    + 'direct child of the message-box row; the top bar has none of them; the row is 33px high and nothing overflows',
  kindsOf(facts) === 'permission,model,thinking,usage,send' && frameProblems(facts).length === 0,
  `${kindsOf(facts)}; ${frameProblems(facts).join('; ')}`);
  record(`MP-23 row at ${at1(facts.pane.width)}px: the provider range shows "${WIDE.text}" whole with ▾, at most `
    + `200px; hover "${WIDE.text}" / "${WIDE.hover}", name "${rangeName(WIDE.text)}", description `
    + `"${rangeDescription(WIDE.hover)}"`, facts.pane.width > 680 && bar.text === WIDE.text
    && !isCut(facts.texts.scope) && !isCut(facts.texts.model) && bar.width <= 200.5 && bar.arrows === 1
    && same(bar.tip, [WIDE.text, WIDE.hover]) && bar.name === rangeName(WIDE.text)
    && bar.described === rangeDescription(WIDE.hover), JSON.stringify({ bar, texts: facts.texts }));
}

/**
 * @brief 键盘（新加的检查第 6 条）：从文字框 Tab 依次是权限 → 范围 → Effort → 圆环 → "Send"；在范围按钮上 Enter 打开菜单、
 *        焦点在打勾的一项，↓ 移动，Enter 选择后菜单关闭、焦点回到按钮；文字框里有字也不发送、不排队。选的是"o3"。
 */
async function rowKeyboardStep(ctx) {
  const { page } = ctx;
  await composer(page).fill('plain draft stays');
  await composer(page).focus();
  const path = [];
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press('Tab');
    path.push(await focusKind(page));
  }
  record('MP-23 keyboard: from the message box Tab goes to the permission button, the range button, Effort, the usage '
    + 'ring, then Send', same(path, ['permission-button', 'model-button', 'thinking-button', 'usage', 'send']),
  path.join(' > '));
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('Shift+Tab');
  const users = await userCount(page);
  await page.keyboard.press('Enter');
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  const first = await focusKind(page);
  let focus = first;
  for (let index = 0; index < 12 && focus !== 'item:short/o3'; index += 1) {
    await page.keyboard.press('ArrowDown');
    focus = await focusKind(page);
  }
  await page.keyboard.press('Enter');
  const gone = await menuGone(page);
  await page.waitForFunction((selector) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    return button?.dataset.pick === 'short/o3' && !button.getAttribute('aria-disabled');
  }, PANE, { timeout: 15000 });
  const back = await focusKind(page);
  const draft = await composer(page).inputValue();
  const queued = await paneOf(page).getByTestId('queue').count();
  record('MP-23 keyboard: Enter on the range button opens the menu on the ticked range, ↓ moves, Enter chooses "o3": '
    + 'the menu closes, the focus is back on the button, the draft stays and nothing is sent or queued',
  first === `item:${WIDE.pick}` && focus === 'item:short/o3' && gone && back === 'model-button'
    && draft === 'plain draft stays' && (await userCount(page)) === users && queued === 0,
  `first ${first}, reached ${focus}, gone ${gone}, focus ${back}, draft "${draft}", queue ${queued}`);
  await composer(page).fill('');
}

/** @brief 很短的范围（"o3"）、空闲：930px 和 680px 的会话面板里各开一次 300px 的范围菜单（新加的检查第 4 条）。 */
async function rowShortMenuStep(ctx) {
  const { app, page } = ctx;
  const seenAt = [];
  for (const target of [930, 680]) {
    const width = await fitPane(app, page, target);
    await paneOf(page).getByTestId('model-button').click();
    await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
    const place = await rangeMenuPlace(page);
    await page.keyboard.press('Escape');
    await menuGone(page);
    seenAt.push({ target, width, place });
  }
  await resetWindow(app, page);
  record('MP-23 a short range ("o3"), idle, 930px and 680px panes: the 300px range menu opens upward, right-aligned '
    + 'with the range button (or moved in to the row start), never out of the row, the pane or the window, not over '
    + 'the top bar', seenAt.every((item) => Math.abs(item.width - item.target) < 1.5
    && item.place?.problems.length === 0), seenAt.map((item) => `${at1(item.width)}px: `
    + `${item.place?.problems.join('; ') || 'ok'} ${placeBrief(item.place?.geo)}`).join(' | '));
  await choosePick(page, WIDE.pick);
}

/**
 * @brief 600px 的会话面板、生成中、输入框有字（"Queue ▾"和"Stop"）、"Ask each time"、"Effort: Unavailable"（新加的检查第 3 条）：
 *        范围按钮先截模型 id、范围名完整，模式名和强度不截；悬停第一行和读屏名是全文，第三行和描述是原因。
 */
async function rowCrowdedStep(ctx) {
  const { app, page } = ctx;
  const width = await fitPane(app, page, 600);
  await send(page, 'wait 12s');
  await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE,
    { timeout: 20000 });
  await composer(page).fill('plain queued draft');
  await settle(page);
  const facts = await rowFacts(page);
  const bar = await pickers(page);
  const { texts } = facts;
  record('MP-23 600px pane, generating with text typed, "Ask each time", "Effort: Unavailable": the range button cuts '
    + 'the model id first (.range-model, with "…") and keeps "Wide Provider" (.range-scope) whole; the mode name and '
    + 'the effort are not cut; nothing overflows', width <= 600.5 && width > 460
    && kindsOf(facts) === 'permission,model,thinking,usage,queue,stop' && isCut(texts.model) && texts.model.ellipsis
    && !isCut(texts.scope) && !isCut(texts.permission) && !isCut(texts.effort) && frameProblems(facts).length === 0,
  JSON.stringify({ width: at1(width), kinds: kindsOf(facts), texts, problems: frameProblems(facts) }));
  record('MP-23 600px pane, generating: the cut range button keeps the whole text in hover line 1 and in its name; '
    + 'line 3 and the description give the reason; it stays usable (2026-10-26, not aria-disabled)', !bar.unavailable
    && !bar.disabled && same(bar.tip, [WIDE.text, WIDE.hover, BUSY_TITLE]) && bar.name === rangeName(WIDE.text)
    && bar.described === rangeDescription(WIDE.hover, BUSY_TITLE), JSON.stringify(bar));
  await composer(page).fill('');
  await stopIfRunning(page, PANE);
  await waitIdle(page, 30000);
  await resetWindow(app, page);
}

/** @brief 这一栏还在生成时点"Stop"（已经结束时什么也不做），等它停下。 */
async function stopIfRunning(page, paneCss) {
  const stop = page.locator(`${paneCss} .stop-button`);
  if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
  await page.waitForFunction((css) => document.querySelector(css)?.dataset.running === 'false', paneCss,
    { timeout: 30000 });
}

/**
 * @brief 后台进程退出与 Restart（新加的检查第 4、6 条）：开着的范围菜单关闭；范围按钮、Effort 和圆环留着、不可用，原因是
 *        "Mori’s background process crashed"，重新载入中"Restarting…"、重新打开中"Starting…"；之后又能用。
 */
async function rowCrashStep(ctx) {
  const { app, page } = ctx;
  await paneOf(page).getByTestId('model-button').click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  killKernel(app);
  await paneOf(page).getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  const closed = await menuGone(page);
  const bar = await pickers(page);
  const ring = await paneOf(page).getByTestId('usage').count();
  record('MP-23 background process crashed: the open range menu closes; the range button and Effort stay, '
    + `aria-disabled, with "${NOTE.crashed}" as range hover line 3 / Effort line 2 and in their descriptions; `
    + 'the usage ring stays', closed && bar?.unavailable && same(bar.tip, [WIDE.text, WIDE.hover, NOTE.crashed])
    && bar.described === rangeDescription(WIDE.hover, NOTE.crashed) && bar.thinking?.unavailable === true
    && same(bar.thinking.tip, ['Effort: Unavailable', NOTE.crashed]) && bar.thinking.described === NOTE.crashed
    && ring === 1, `menu closed ${closed}, ring ${ring}, ${JSON.stringify(bar)}`);
  await watchPickers(page);
  await paneOf(page).getByRole('button', { name: 'Restart', exact: true }).click();
  await paneOf(page).getByTestId('notice').filter({ hasText: 'Restarted · ' }).last().waitFor({ timeout: 30000 });
  await waitReady(page);
  await settle(page);
  const states = await seenPickers(page);
  const after = await pickers(page);
  const both = (reason) => states.some((s) => s.rt[2] === reason && s.et[1] === reason && s.ra && s.ea);
  record(`MP-23 Restart: while restarting and reopening the range button, Effort and the ring stay (aria-disabled) `
    + `with "${NOTE.restarting}" and then "${NOTE.starting}" as the reason; afterwards they are usable again`,
  both(NOTE.restarting) && both(NOTE.starting) && states.every((s) => s.r && s.e && s.u)
    && after?.ariaDisabled === null && after.tip.length === 2,
  states.map((s) => `${s.r ? s.rt[2] ?? 'ok' : 'gone'}|${s.e ? s.et[1] ?? '' : 'gone'}|ring ${s.u}`).join(' > '));
}

/** @brief 在会话行的右键菜单（Shift+F10）里点"Open in split view"，等分屏、右边那一栏就绪。 */
async function openInSplit(page, file) {
  await rowOf(page, file).first().focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  await menu.getByRole('menuitem').filter({ hasText: 'Open in split view' }).click();
  await page.waitForFunction(() => document.querySelector('.center')?.dataset.split === 'true', null,
    { timeout: 10000 });
  await page.waitForFunction((css) => document.querySelector(css) && !document.querySelector(`${css} [data-testid=`
    + '"not-ready"]'), SIDE.right, { timeout: 30000 });
}

/**
 * @brief 1200 宽分屏、右栏开（两栏各 280px，右边一栏的会话面板 279px）。右栏（提供商范围）生成中有字：范围按钮在最窄、
 *        模型 id 和范围名都截了，其余各项不窄于最窄（新加的检查第 3 条）。左栏 no_pick：没有 Effort、"No model range"、
 *        "Send"不可用、不溢出（第 10 条）；选分组后先截模型 id；范围菜单收到这一行的宽，项名截断（第 4 条）。
 */
async function rowSplitStep(ctx) {
  const { page } = ctx;
  const s1 = await activeFile(page);
  await ctrlN(page);
  await waitBlocked(page, 'no_pick');
  await openInSplit(page, s1);
  for (const side of ['left', 'right']) await setRightPanel(page, true, SIDE[side]);
  const box = page.locator(`${SIDE.right} .composer textarea`);
  await box.click();
  await box.fill('wait 30s');
  await box.press('Enter');
  await page.waitForFunction((css) => document.querySelector(css)?.dataset.running === 'true', SIDE.right,
    { timeout: 20000 });
  await box.fill('plain queued draft');
  await settle(page);
  await narrowCrowded(page);
  await narrowNoPick(page);
  await narrowGroup(page);
  await stopIfRunning(page, SIDE.right);
}

/** @brief rowSplitStep 的右栏：最窄、生成中有字。 */
async function narrowCrowded(page) {
  const facts = await rowFacts(page, SIDE.right);
  const bar = await pickers(page, SIDE.right);
  const w = facts.pane.width;
  const { sizes, texts } = facts;
  record(`MP-23 ${at1(w)}px pane (the right one of a 1200px split, changes panel open), generating with text typed: `
    + 'the range button is at its narrowest (36px) with the model id and the provider name cut ("…"); the mode, '
    + 'the effort, the 26px ring, the 24px ▾ and the 28px Stop still fit; nothing overflows', w <= 340
    && kindsOf(facts) === 'permission,model,thinking,usage,queue,stop' && Math.abs(bar.width - least('model', w)) <= 1
    && isCut(texts.model) && isCut(texts.scope) && texts.scope.ellipsis
    && bar.permission.width >= least('permission', w) - 0.5 && bar.thinking.width >= least('thinking', w) - 0.5
    && Math.abs(sizes.usage - 26) <= 1 && Math.abs(sizes.toggle - 24) <= 0.5 && Math.abs(sizes.stop - 28) <= 0.5
    && sizes.queueMain === null && frameProblems(facts).length === 0,
  JSON.stringify({ w: at1(w), kinds: kindsOf(facts), range: at1(bar.width), mode: at1(bar.permission.width),
    effort: at1(bar.thinking.width), sizes, texts, problems: frameProblems(facts) }));
  record('MP-23 narrowest pane: the cut range button keeps the whole text in hover line 1 and in its name',
    same(bar.tip, [WIDE.text, WIDE.hover, BUSY_TITLE]) && bar.name === rangeName(WIDE.text),
    JSON.stringify(bar.tip));
}

/** @brief rowSplitStep 的左栏：no_pick（输入框有字）。 */
async function narrowNoPick(page) {
  const box = page.locator(`${SIDE.left} .composer textarea`);
  await box.click();
  await box.fill('plain must not be sent');
  const facts = await rowFacts(page, SIDE.left);
  const bar = await pickers(page, SIDE.left);
  const send = await page.locator(`${SIDE.left} .send-button`).isDisabled();
  await box.fill('');
  record(`MP-09 no_pick in a ${at1(facts.pane.width)}px pane: no Effort, the range button "No model range", Send `
    + 'disabled with text typed; the row is 33px high and nothing overflows', facts.pane.width <= 340
    && kindsOf(facts).replace(',usage', '') === 'permission,model,send' && !bar?.thinking
    && bar?.text === 'No model range' && send && frameProblems(facts).length === 0,
  JSON.stringify({ kinds: kindsOf(facts), text: bar?.text, send, problems: frameProblems(facts) }));
}

/** @brief rowSplitStep 的左栏：选分组范围（空闲），再开一次范围菜单。 */
async function narrowGroup(page) {
  await choosePick(page, 'grp', SIDE.left);
  await settle(page);
  const facts = await rowFacts(page, SIDE.left);
  const bar = await pickers(page, SIDE.left);
  const w = facts.pane.width;
  record(`MP-23 ${at1(w)}px pane, group range "grp · wide-coder-v2", idle: the model id is cut first while the group `
    + 'name stays whole; the range button is not narrower than 36px; nothing overflows',
  bar.text === 'grp · wide-coder-v2' && isCut(facts.texts.model) && !isCut(facts.texts.scope)
    && bar.width >= least('model', w) - 0.5 && frameProblems(facts).length === 0,
  JSON.stringify({ range: at1(bar.width), texts: facts.texts }));
  await page.locator(`${SIDE.left} [data-testid="model-button"]`).click();
  await page.locator(`${SIDE.left} [data-testid="model-menu"]`).waitFor({ timeout: 5000 });
  const place = await rangeMenuPlace(page, SIDE.left);
  const items = await menuItemFacts(page, SIDE.left);
  await page.keyboard.press('Escape');
  await menuGone(page);
  const long = items?.find((item) => item.pick === 'longp');
  record(`MP-23 range menu in a ${at1(w)}px pane: as wide as the row (not 300px), upward, inside the pane; a long name `
    + 'is cut with "…" and whole in its hover', place?.problems.length === 0
    && isCut(long?.label) && long.label.ellipsis && long.title === LONG_NAME,
  `${place?.problems.join('; ')} ${placeBrief(place?.geo)}; `
    + `${JSON.stringify(long)}`);
}

/** @brief 场景 row（MP-23）：多个提供商的范围在输入框下面一行里的样子。 */
async function rowScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  ctx.project = makeProject(ctx, 'proj');
  // synthetic test setup：一个名字约 75px 的提供商（范围按钮约 193px）、一个模型 id 很短的提供商、一个名字很长的提供商
  // 和一个分组；没有默认范围，新会话是 no_pick。
  seedConfig(ctx, { providers: [
    provider('wide', 'Wide Provider', ep.url, [model('wide-coder-v2')]),
    provider('short', 'Short P', ep.url, [model('o3')]),
    provider('longp', LONG_NAME, ep.url, [model('long-coder')]),
  ], groups: [group('grp', ['wide'])] });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['wide/wide-coder-v2', 'short/o3', 'longp/long-coder']);
  await step(ctx, 'wide', () => rowWideStep(ctx));
  await step(ctx, 'keyboard', () => rowKeyboardStep(ctx));
  await step(ctx, 'short menu', () => rowShortMenuStep(ctx));
  await step(ctx, 'crowded', () => rowCrowdedStep(ctx));
  await step(ctx, 'crash', () => rowCrashStep(ctx));
  await step(ctx, 'split', () => rowSplitStep(ctx));
}

// ---------- 场景：准备中（MP-34，含 MP-23 的准备中不能改范围） ----------

/** 被限流的 key（synthetic）：合成端点对它回 429，FAKE_LIMIT_MS 之后恢复 */
const LIMITED_KEY = 'synthetic-v1-session-limited-key-lim1';

/** @brief 等当前一栏的阶段行变成 kind。 */
const waitStage = (page, kind, timeout = 15000) => until(async () => {
  const stage = await stageNow(page);
  return stage?.kind === kind ? stage : null;
}, timeout, 100);

/**
 * @brief 准备中的输入框下面一行（composer-pickers.md 新加的检查第 11 条、chat.md"准备中"）：按钮位置是"Stop"；有字时左边是
 *        只有一个按钮的"Queue"（没有 ▾），占位文字"Enter to queue · Shift+Enter for new line"；会话面板 400px 时"Queue"
 *        仍在（只有图标，32px）；范围按钮的描述"<提供商名>. <原因>"，Effort 的描述是原因。留下输入框里的字。
 */
async function preparingRow(ctx, bar) {
  const { app, page } = ctx;
  await composer(page).fill('plain third');
  const wide = await rowFacts(page);
  const placeholder = await composer(page).getAttribute('placeholder');
  record('MP-34 preparing: the button position shows Stop; with text typed a single "Queue" button (no ▾) sits left of '
    + 'it; placeholder "Enter to queue · Shift+Enter for new line"', kindsOf(wide).endsWith('queue-one,stop')
    && wide.sizes.toggle === null && placeholder === 'Enter to queue · Shift+Enter for new line',
  `${kindsOf(wide)}; ▾ ${wide.sizes.toggle}; "${placeholder}"`);
  record(`MP-23 preparing: the range description is "Rate Provider. ${BUSY_TITLE}", the Effort description is `
    + `"${EFFORT_BUSY}"`, bar.described === rangeDescription('Rate Provider', BUSY_TITLE)
    && bar.thinking?.described === EFFORT_BUSY, `${bar.described} | ${bar.thinking?.described}`);
  const width = await fitPane(app, page, 400);
  const narrow = await rowFacts(page);
  const name = await paneOf(page).locator('.queue-button').getAttribute('aria-label').catch(() => null);
  record('MP-34 preparing in a 400px pane: the single "Queue" stays (icon only, 32px, name "Queue") next to Stop and '
    + 'the row does not overflow', width <= 400.5 && width > 340 && kindsOf(narrow).endsWith('queue-one,stop')
    && Math.abs((narrow.sizes.queueOne ?? 0) - 32) <= 0.5 && name === 'Queue' && frameProblems(narrow).length === 0,
  `pane ${at1(width)}px; ${kindsOf(narrow)}; Queue ${narrow.sizes.queueOne} "${name}"; ${frameProblems(narrow)}`);
  await resetWindow(app, page);
}

/** @brief 准备中等模型：消息已显示、阶段行、停止可用、Effort 不可用（范围按钮可用）；再发一条进排队区；停止后两条文字回到输入框。 */
async function stopWhilePreparingStep(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  const mark = { bodies: ep.bodies.length, log: ep.log.length };
  await send(page, 'plain second');
  const stage = await waitStage(page, 'wait-model');
  const users = await paneOf(page).getByTestId('user-message').allInnerTexts();
  const stop = await paneOf(page).locator('.stop-button').isVisible();
  record('MP-34 preparing: the message is shown, the stage line says "Waiting for a model · rate limited until '
    + 'hh:mm:ss", Stop is available', /^Waiting for a model · rate limited until \d\d:\d\d:\d\d$/.test(stage?.text ?? '')
    && same(users, ['plain second']) && stop, `${stage?.text}; users ${JSON.stringify(users)}; stop ${stop}`);
  const bar = await pickers(page);
  record(`MP-23 preparing: the Effort button is unavailable (aria-disabled, still focusable) and the range button `
    + 'stays usable (2026-10-26: it opens the menu to switch task mode); range hover '
    + `line 3 "${BUSY_TITLE}", Effort hover line 2 "${EFFORT_BUSY}"`, !bar.unavailable && !bar.disabled
    && bar.tip[2] === BUSY_TITLE && bar.thinking?.unavailable === true && !bar.thinking.disabled
    && bar.thinking.tip[1] === EFFORT_BUSY, JSON.stringify(bar));
  await preparingRow(ctx, bar);
  await send(page, 'plain third');
  const pending = await paneOf(page).locator('[data-testid="queue"] li[data-pending="true"]').allInnerTexts()
    .catch(() => []);
  record('MP-34 preparing: a message sent while preparing waits in the queue area (pending)',
    pending.some((text) => text.includes('plain third')), JSON.stringify(pending));
  await paneOf(page).locator('.stop-button').click();
  await until(async () => (await userCount(page)) === 0, 10000, 100);
  const draft = await composer(page).inputValue();
  record('MP-34 Stop while preparing: both texts go back into the composer in order; the message is withdrawn',
    draft === 'plain second\n\nplain third' && (await userCount(page)) === 0, JSON.stringify(draft));
  const stopped = (await notices(page)).filter((item) => item.text === STOPPED_NOTICE).length;
  const queue = await paneOf(page).getByTestId('queue').count();
  record('MP-34 Stop while preparing: no error card, no "Stopped", queue cleared, nothing reached the endpoint',
    (await errorCount(page)) === 0 && stopped === 0 && queue === 0 && ep.log.length === mark.log
    && talk(ep).length === talk({ bodies: ep.bodies.slice(0, mark.bodies) }).length,
    `errors ${await errorCount(page)}, stopped ${stopped}, queue ${queue}, new log lines ${ep.log.length - mark.log}`);
  await composer(page).fill('');
}

/** @brief 准备中再发的消息在 pi 开始后作为排队消息交给 pi。 */
async function followUpStep(ctx, ep) {
  const { page } = ctx;
  const mark = ep.bodies.length;
  await send(page, 'plain fourth');
  await waitStage(page, 'wait-model');
  await send(page, 'plain fifth');
  await paneOf(page).locator('[data-testid="queue"] li[data-pending="true"]').waitFor({ timeout: 5000 });
  await until(async () => (await paneOf(page).getByTestId('assistant').count()) >= 2, 90000, 500);
  await waitIdle(page, 90000);
  const sent = talk({ bodies: ep.bodies.slice(mark) });
  const fourth = sent.findIndex((body) => body.lastUser === 'plain fourth');
  const fifth = sent.find((body) => body.lastUser === 'plain fifth');
  const messages = fifth?.messages ?? [];
  const at = messages.findIndex((message) => message.role === 'user' && contentText(message.content) === 'plain fourth');
  record('MP-34 the message sent while preparing becomes a followUp: sent after the first reply, in the same context',
    fourth >= 0 && sent.indexOf(fifth) > fourth && at >= 0
    && messages.slice(at + 1, -1).some((message) => message.role === 'assistant'),
    sent.map(brief).join(' ; '));
  const users = await paneOf(page).getByTestId('user-message').allInnerTexts();
  record('MP-34 followUp: both messages and both replies are shown, no error card',
    same(users.slice(-2), ['plain fourth', 'plain fifth']) && (await errorCount(page)) === 0, JSON.stringify(users));
}

/** @brief 场景 preparing（MP-34）。 */
async function preparingScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT, { FAKE_LIMITED_KEYS: LIMITED_KEY, FAKE_LIMIT_MS: '45000' });
  seedConfig(ctx, { providers: [provider('rp', 'Rate Provider', ep.url, [model('rl-coder')])], normalDefault: 'rp' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['rp/rl-coder']);
  // synthetic test setup：探针跑完后才加 key，之后的对话请求都被限流（45 秒后恢复：准备中那一步还要改一次窗口宽度）。
  const added = await bridge(ctx.page, { type: 'models.addKey', providerId: 'rp', label: 'Key 1', secret: LIMITED_KEY });
  if (added?.error) throw new Error(`models.addKey failed: ${added.error}`);
  await openProject(ctx, makeProject(ctx, 'proj'));
  // 第一条消息让 key 进入限流：它是唯一的候选、本段已失败过（tried），不等待，直接一张说明卡（§5.8）。
  // 之后的新一段从头选，rl-coder 限流到 45 秒后恢复，这期间就是"准备中等模型"。
  await send(ctx.page, 'plain first');
  const limited = await until(async () => (await paneOf(ctx.page).getByTestId('unavailable-card').count()) > 0
    && ep.log.some((line) => line.status === 429), 20000, 200);
  if (!limited) {
    const lines = ep.log.map((line) => `${line.model}/${line.key}:${line.status}`).join(',');
    throw new Error(`the first message did not wait for the rate limit; stage ${JSON.stringify(await stageNow(ctx.page))}`
      + `; log ${lines}; notices ${JSON.stringify(await notices(ctx.page))}; errors ${await errorCount(ctx.page)}`);
  }
  await step(ctx, 'stop while preparing', () => stopWhilePreparingStep(ctx, ep));
  await step(ctx, 'followUp', () => followUpStep(ctx, ep));
}

// ---------- 场景：思考强度（MP-35） ----------

/** @brief 新会话按第一个候选的按模型默认强度开始，请求带思考参数；改成 high 后重新打开仍是 high。 */
async function thinkingLevelStep(ctx, ep) {
  const { page } = ctx;
  const bar = await pickers(page);
  await sendTurn(page, 'thinking check');
  const first = talk(ep).at(-1);
  const reply = await lastReply(page);
  record('MP-35 a new session starts at the first candidate\'s per-model default (low); the request carries it',
    bar.thinking?.level === 'low' && bar.thinking.reasoning === 'true' && first?.effort === 'low'
    && reply.includes('收到思考参数：low'), `${JSON.stringify(bar.thinking)}; effort ${first?.effort}`);
  const effort = bar.thinking;
  const kinds = kindsOf(await rowFacts(page));
  record('MP-35 the Effort button is in the message-box row right after the range button: text and name '
    + '"Effort: Low", hover "Effort: Low" / "Set the effort level for this session", described by line 2, '
    + 'no aria-disabled while usable', Boolean(effort) && effort.inRow && !effort.inTopbar
    && kinds.includes('model,thinking') && effort.text === 'Effort: Low' && effort.name === 'Effort: Low'
    && same(effort.tip, ['Effort: Low', NOTE.effort]) && effort.described === NOTE.effort
    && effort.ariaDisabled === null, `${kinds}; ${JSON.stringify(effort)}`);
  await watchPickers(page);
  await chooseThinking(page, 'high');
  const states = await seenPickers(page);
  const after = await pickers(page);
  record('MP-35 switching effort: while session.setThinking runs Effort and the range button both carry '
    + 'data-pending="true" and aria-disabled; afterwards neither is aria-disabled',
  states.some((s) => s.ep && s.ea && s.rp && s.ra) && !after.ariaDisabled && !after.thinking?.ariaDisabled,
  `${JSON.stringify(states.map((s) => `${s.rp}/${s.ra}|${s.ep}/${s.ea}`))}`);
  await sendTurn(page, 'thinking check again');
  record('MP-35 after choosing high the next request carries high', talk(ep).at(-1)?.effort === 'high',
    String(talk(ep).at(-1)?.effort));
  const file = await activeFile(page);
  await stopApp(ctx);
  await startApp(ctx);
  await openRowFile(ctx.page, file);
  const reopened = await pickers(ctx.page);
  record('MP-35 close and reopen: the session is still at high', reopened.thinking?.level === 'high',
    JSON.stringify(reopened.thinking));
}

/** @brief 段内从不支持思考的模型换到推理模型：思考菜单的强度变为可选（按钮仍因生成中不可用）。 */
async function inReplyThinkingStep(ctx) {
  const { page } = ctx;
  await ctrlN(page);
  await choosePick(page, 'gswitch');
  const before = await pickers(page);
  record('MP-35 a current model without "Supports thinking": Effort reads "Effort: Unavailable" and stays usable, '
    + 'hover "Effort: Unavailable" / "This model isn’t marked “Supports thinking”", described by line 2',
  before.thinking?.text === 'Effort: Unavailable' && before.thinking.ariaDisabled === null
    && same(before.thinking.tip, ['Effort: Unavailable', NOTE.unsupported])
    && before.thinking.described === NOTE.unsupported,
  JSON.stringify(before.thinking));
  await watch(page, 'thinking');
  await sendTurn(page, 'http-404-once wait 3s');
  const states = await seen(page);
  const change = (await notices(page)).find((item) => item.kind === 'model-switch');
  const id = await sessionIdOf(page);
  const levels = (await events(page, 'mori.model_state')).filter((item) => item.sessionId === id
    && item.event.current === 'tp/think-coder').map((item) => item.event);
  record('MP-35 in reply, switching from a non-reasoning to a reasoning model makes the thinking levels selectable',
    before.thinking?.reasoning === 'false' && states.includes('true|true') && change?.to === 'tp/think-coder'
    && levels.some((state) => state.reasoning && state.thinkingLevels.length > 1),
    `before ${before.thinking?.reasoning}; button states ${states.join(' > ')}; switch ${change?.text}; `
    + `states ${JSON.stringify(levels.map((state) => state.thinkingLevels))}`);
}

/** @brief 场景 thinking（MP-35）。 */
async function thinkingScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  // synthetic test setup：推理模型的新会话默认强度 low（pi 设置的 modelThinkingLevels）。
  seedPiSettings(ctx, { modelThinkingLevels: { 'tp/think-coder': 'low' } });
  seedConfig(ctx, { providers: [
    provider('tp', 'Think Provider', ep.url, [model('think-coder', { reasoning: true })]),
    provider('np', 'Plain Provider', ep.url, [model('plain-coder')]),
  ], groups: [group('gswitch', ['np', 'tp'])], normalDefault: 'tp' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['tp/think-coder', 'np/plain-coder']);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'level', () => thinkingLevelStep(ctx, ep));
  await step(ctx, 'in-reply switch', () => inReplyThinkingStep(ctx));
}

// ---------- 运行 ----------

const SCENARIOS = {
  blocked: [blockedScenario, 'MP-09'], configInvalid: [configInvalidScenario, 'MP-09'],
  probes: [probesScenario, 'MP-10'], fingerprint: [fingerprintScenario, 'MP-12'],
  handover: [handoverScenario, 'MP-21'], compaction: [compactionScenario, 'MP-22'], range: [rangeScenario, 'MP-23'],
  row: [rowScenario, 'MP-23'], preparing: [preparingScenario, 'MP-34'], thinking: [thinkingScenario, 'MP-35'],
};

for (const [name, [scenario, mp]] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(name)) continue;
  const ctx = { name, mp, eps: [], pageErrors: [], app: null, page: null,
    userData: mkdtempSync(join(tmpdir(), `mori-v1s-${name}-data-`)), root: mkdtempSync(join(tmpdir(), `mori-v1s-${name}-`)) };
  console.log(`[v1-models-app-session] ${name}: data in ${ctx.userData}, projects in ${ctx.root}`);
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
process.exitCode = write(`v1-models-app-session${suffix}.json`) ? 0 : 1;
