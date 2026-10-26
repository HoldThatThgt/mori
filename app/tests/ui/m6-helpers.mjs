// M6 测试（m6-app-*.mjs、m6-replay.mjs、m6-real.mjs）共用的准备与页面操作：合成端点、首次启动填表并打开项目、
// 设置页（v1 的 Models：提供商卡、模型行；AGENTS.md）、Customize 页的分节、"/"补全列表，以及输入框下面一行
// （2026-10-21 起选择范围、Effort、权限按钮和上下文用量圆环都在这里，docs/v0/composer-pickers.md）：按钮、菜单的位置、
// 圆环、各档的样子与截短的先后。
// 只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。标识见 docs/v0/screens/settings.md、models.md、tools.md、slash.md、
// docs/v1/screens/model-menu.md。

import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { appRoot, sleep } from './lib.mjs';
import { PANE, paneOf, rowOf, settle, stubFolder, waitReady } from './m3-helpers.mjs';
import { waitPaneReady, waitSplit } from './m5-helpers.mjs';
import { cardAddModels, OPEN_FOLDER } from './page.mjs';

/**
 * @brief 启动合成端点（synthetic），等它打出启动行；最多等 15 秒。
 * @param env 额外的环境变量（FAKE_CHUNK_DELAY_MS 等）
 */
export function startFakeEndpoint(port, key, env = {}) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '10', FAKE_FIRST_DELAY_MS: '50',
      FAKE_REQUIRE_KEY: key, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('fake endpoint did not start within 15 s')), 15000);
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('synthetic')) return;
      clearTimeout(timer);
      done(child);
    });
  });
}

/** @brief 改窗口内容区的大小（主进程里改，界面随之响应）。 */
export async function resizeWindow(app, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
    { w: width, h: height });
  await sleep(500);
}

/**
 * @brief 首次启动（v1，规格 §14.4）：填英文表单、Test connection（成功后进入主窗口），等测试的那个模型的
 *        探针跑完（page.mjs waitProbes，经进程桥读档案），再打开 project（系统对话框换成直接返回它）。
 *        trust 为 true / false 时在信任询问里选"Trust workspace" / "Don’t trust"；undefined 表示不会问。
 *        名称默认 "Mori endpoint"（提供商 id mori-endpoint）。
 *        一键拉取模型（model-discovery.md §13.4，page.mjs firstRun）：先 Fetch models，这次拉取必须拿到列表（对的 key），
 *        否则报错；modelId 不在列表里时用 Add a model ID 手填（m6-app-slash 的长模型 id）。
 *        contextWindow 给出时在清单行里改上下文窗口（不给时是合成端点报告的 131072）。
 */
export async function firstRunAndOpen(ctx, { name = 'Mori endpoint', baseUrl, apiKey, modelId = 'fake-coder', project,
  trust, reasoning, contextWindow }) {
  const { page, h } = ctx;
  const run = await h.firstRun({ name, baseUrl, apiKey, modelId, reasoning, contextWindow });
  if (!run.ok || run.probe !== 'verified') throw new Error(`first run: ${run.text}; probes ${run.probe}`);
  if (run.fetch?.state !== 'list') throw new Error(`first run: Fetch models gave ${JSON.stringify(run.fetch)}`);
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  await openProject(ctx, project, trust);
}

/** @brief 打开一个项目文件夹（"Open folder…"）；trust 同 firstRunAndOpen。 */
export async function openProject(ctx, project, trust) {
  const { app, page } = ctx;
  await stubFolder(app, project);
  await page.getByRole('button', { name: OPEN_FOLDER }).first().click();
  if (trust !== undefined) {
    const dialog = page.getByTestId('trust-dialog');
    await dialog.waitFor({ timeout: 15000 });
    await dialog.getByRole('button', { name: trust ? 'Trust workspace' : 'Don’t trust', exact: true }).click();
  }
  await waitReady(page);
}

/** @brief 当前显示的会话面板（分屏时焦点所在的一栏）。 */
export const focusedPane = (page) => page.locator('.pane-slot[data-focused="true"]:not([hidden]) [data-testid="chat-pane"]')
  .or(page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]')).first();

/** @brief 打开设置页并切到某一节（models / agents，v1 的 Models 取代 v0 的 connections）。 */
export async function openSettingsSection(page, section = 'models') {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator(`[data-testid="settings-nav"] button[data-section="${section}"]`).click();
}

/** @brief 设置 → Models 的提供商卡（provider id，v1 取代 v0 的连接卡）。 */
export const providerCard = (page, provider) => page
  .locator(`[data-testid="provider-card"][data-provider="${provider}"]`);
/** @brief 设置 → Models 的模型行（provider/id）。 */
export const modelRow = (page, ref) => page.locator(`[data-testid="model-row"][data-model="${ref}"]`);

/** @brief 设置页"Back to app"，等会话面板就绪。 */
export async function backToApp(page) {
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
  await waitReady(page);
}

/**
 * @brief 等 设置 → Models 里 ref 那一行的探针跑完、tool calling 为 verified（规格 §7.3）；返回最后的取值。
 *        2026-10-26（WP-02）：读行上的 data-probe（models-settings.md "Models 行"），取值同原来档案摘要的 Tool calling。
 */
export async function waitVerified(page, ref, timeout = 120000) {
  const value = () => modelRow(page, ref).getAttribute('data-probe', { timeout: 2000 }).catch(() => null);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && await value() !== 'verified') await sleep(500);
  return value();
}

/**
 * @brief 设置 → Models 的提供商卡上加一个模型（一键拉取模型，model-discovery.md §6.5、§13.4）：卡上 Fetch models →
 *        清单里勾它（列表里没有时用 Add a model ID 手填），改 Context window、Max output → Add 1 model，等新行出现、
 *        探针跑完（不跑完时这个模型被静态校验排除）。返回行上 data-probe 的取值（同原来的 Tool calling）。设置页要已经在 Models 一节。
 * @param model.id 模型 id；model.contextWindow 上下文长度；model.maxTokens 最大输出（不给时随窗口取一半与 16384 中较小的）
 */
export async function addModelUi(page, provider, { id, contextWindow, maxTokens }) {
  const added = await cardAddModels(page, provider, [{ id, contextWindow, maxTokens }]);
  if (added.error) throw new Error(`Add ${provider}/${id}: ${added.error}`);
  await modelRow(page, `${provider}/${id}`).waitFor({ timeout: 10000 });
  return waitVerified(page, `${provider}/${id}`);
}

/** @brief 设置 → Models 里编辑 ref 那个模型：勾上或去掉"Supports thinking"，Save。设置页要已经在 Models 一节。 */
export async function setReasoning(page, ref, on) {
  await modelRow(page, ref).locator('[data-action="edit"]').click();
  const form = page.getByTestId('model-form');
  await form.waitFor({ timeout: 5000 });
  await form.getByLabel('Supports thinking').setChecked(on);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
}

/**
 * @brief 设置 → Models → Defaults 的"Default model range for new sessions"选 value（空串为 None，models-settings.md），
 *        等它保存好（下拉框不再不可用、值是它）。设置页要已经在 Models 一节。
 */
export async function setDefaultPick(page, value) {
  const select = page.getByTestId('default-pick');
  await select.selectOption(value);
  await page.waitForFunction((want) => {
    const element = document.querySelector('[data-testid="default-pick"]');
    return element && !element.disabled && element.value === want;
  }, value, { timeout: 15000 });
}

/**
 * @brief 打开 Customize 页并切到某一节（builtin / skills / mcp / plugins / agents；agents 是 2026-10-26 加的最后一节
 *        Instructions），等读取结束（没有"Loading…"）。
 */
export async function openToolsSection(page, section) {
  if (!(await page.getByTestId('tools-page').isVisible().catch(() => false))) await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  await page.locator(`[data-testid="tools-page"] button[data-section="${section}"]`).first().click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="tools-page"]')?.textContent
    ?.includes('Loading…'), null, { timeout: 30000 });
}

/**
 * @brief 等焦点所在一栏（没有焦点标记时第一栏）里 testId 按钮的 data-<key> 是 want、且不再切换中（没有 data-pending）：
 *        切换中按钮已经显示你选的强度（data-level 立刻就变），只等它会在 session.setThinking / setPick 返回之前就往下走，
 *        之后发的消息可能还用旧的设置。
 */
function settledTo(page, testId, key, want) {
  return page.waitForFunction(({ id, name, value }) => {
    const pane = document.querySelector('.pane-slot[data-focused="true"]:not([hidden]) [data-testid="chat-pane"]')
      ?? document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
    const button = pane?.querySelector(`[data-testid="${id}"]`);
    return button?.dataset[name] === value && button.dataset.pending !== 'true';
  }, { id: testId, name: key, value: want }, { timeout: 15000 });
}

/**
 * @brief 在当前一栏输入框下面一行打开范围菜单（v1，docs/v1/screens/model-menu.md），选 ref（模型 provider/id），等按钮
 *        的 data-pick 是它、不再切换中（data-pick 是会话的范围，切换返回后才变）。
 */
export async function chooseModel(page, ref) {
  const pane = focusedPane(page);
  await pane.getByTestId('model-button').click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-pick="${ref}"]`).click();
  await settledTo(page, 'model-button', 'pick', ref);
}

/** @brief 在当前一栏输入框下面一行打开 Effort 菜单，选 level，等按钮的 data-level 变过去、不再切换中。 */
export async function chooseThinking(page, level) {
  const pane = focusedPane(page);
  await pane.getByTestId('thinking-button').click();
  await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await settledTo(page, 'thinking-button', 'level', level);
}

/** @brief "/"补全列表里的项：名字、种类、是否高亮；列表不在时为 null。 */
export function slashItems(page) {
  return page.evaluate(() => {
    const menu = document.querySelector('[data-testid="slash-menu"]');
    if (!menu) return null;
    return [...menu.querySelectorAll('[role="option"]')].map((item) => ({ name: item.dataset.name, kind: item.dataset.kind,
      selected: item.getAttribute('aria-selected') === 'true' }));
  });
}

/** @brief 当前一栏对话流里最后一条助手回复的正文和思考块（展开前的文字）。 */
export function lastReply(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
    const messages = [...(pane?.querySelectorAll('[data-testid="assistant"]') ?? [])];
    const last = messages.at(-1);
    return { text: last?.querySelector('.markdown, [data-testid="assistant-text"]')?.textContent ?? last?.textContent ?? '',
      thinking: last ? last.querySelectorAll('details.thinking').length : 0 };
  });
}

// ---------- m6-app-settings.mjs 复查时加的：抓中间状态、菜单关闭、窄栏 ----------

/**
 * @brief 在页面里装一个 MutationObserver，每次 DOM 变化时记下 kind 的一个快照（与上一个相同时不记），用来抓只持续
 *        几毫秒的中间状态（切换中、读取中、保存中）；做法同 page.mjs 的 watchThinking。
 * @param kind model / thinking：当前一栏输入框下面一行按钮的文字或 data-level、aria-disabled 和 data-pending
 *        （"<文字>|<aria-disabled>|<data-pending>"，没有的属性写 null；切换中读 data-pending，不可用读 aria-disabled，
 *        composer-pickers.md"测试要改的地方"C1）；agents：Customize 的 Instructions 一节的"Loading…"、编辑框是否不可用、旁边的一行；
 *        modelForm：模型表单"Save"按钮的文字和是否不可用
 */
export async function watchStates(page, kind) {
  await page.evaluate(({ which, pane }) => {
    const button = (id) => document.querySelector(`${pane} [data-testid="${id}"]`);
    const flags = (el) => `${el.getAttribute('aria-disabled')}|${el.getAttribute('data-pending')}`;
    const agents = () => {
      const section = document.querySelector('[data-testid="agents-section"]');
      if (!section) return null;
      const loading = section.querySelector('.agents-user > p[role="status"]')?.textContent ?? '';
      const editor = document.querySelector('[data-testid="agents-editor"]');
      return `${loading}|${editor?.disabled}|${section.querySelector('.agents-status')?.textContent ?? ''}`;
    };
    const snapshots = {
      model: () => button('model-button') && `${button('model-button').textContent}|${flags(button('model-button'))}`,
      thinking: () => button('thinking-button')
        && `${button('thinking-button').dataset.level}|${flags(button('thinking-button'))}`,
      agents,
      modelForm: () => {
        const submit = document.querySelector('[data-testid="model-form"] button[type="submit"]');
        return submit && `${submit.textContent}|${submit.disabled}`;
      },
    };
    const snap = snapshots[which];
    window.__states = [];
    window.__statesObserver?.disconnect();
    const push = () => {
      const value = snap();
      if (value && window.__states.at(-1) !== value) window.__states.push(value);
    };
    push();
    window.__statesObserver = new MutationObserver(push);
    window.__statesObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  }, { which: kind, pane: PANE });
}

/** @brief 停下 watchStates，返回记下的快照。 */
export const seenStates = (page) => page.evaluate(() => {
  window.__statesObserver?.disconnect();
  return window.__states ?? [];
});

/** @brief 等菜单（model-menu / thinking-menu）关闭；5 秒内关闭时为 true。 */
export const menuGone = (page, testId) => page.getByTestId(testId).waitFor({ state: 'detached', timeout: 5000 })
  .then(() => true, () => false);

// ---------- 输入框下面一行：按钮（docs/v0/screens/models.md、approval.md、v1/screens/model-menu.md） ----------

/** 输入框下面一行（每一栏 [data-testid="composer"] 里的 .composer-bottom，models.md"界面测试用的标识"） */
export const ROW = '[data-testid="composer"] .composer-bottom';
/** 思考强度的界面文字（models.md"思考强度"） */
export const LEVEL_TEXT = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra high', max: 'Max' };
/** 悬停说明的第二行（范围按钮的原因在第三行）和读屏的描述：说明与不可用的原因（models.md、approval.md、ui-strings.md） */
export const NOTE = {
  ask: 'Change the permission mode', all: 'Edits, writes, and commands will run without asking.',
  effort: 'Set the effort level for this session', unsupported: 'This model isn’t marked “Supports thinking”',
  noModel: 'No model can run in this session', modelBusy: 'Can’t switch models until the response finishes',
  effortBusy: 'Can’t change effort until the response finishes', crashed: 'Mori’s background process crashed',
  restarting: 'Restarting…', starting: 'Starting…', failed: 'Session didn’t open',
};
/** 圆环没有数据时的说明（详情里条的位置、读屏的描述） */
export const RING_NOTE = { empty: 'Send a message to see context usage.',
  compacted: 'Just compacted. Context usage shows after the next response.' };
/**
 * 范围按钮悬停第二行"<提供商名>"的样子（model-menu.md"选择范围按钮"）：不空，后面不再带" · <区域>"
 * （2026-10-26 起没有网络区域，负责人走查 M3）
 */
export const PROVIDER_LINE = /^(?!.* · (Local|Intranet|Public|Zone not confirmed)$).+$/;
/** 范围按钮任何宽度的上限（composer-pickers.md"v1 之后的调整"第 3 条） */
export const RANGE_MAX = 200;

/**
 * @brief 范围按钮读屏的描述应有的文字（composer-pickers.md"悬停和读屏的描述"）：悬停第二行（提供商名，2026-10-26 起不带区域），
 *        不可用时加". "和第三行的原因；切换中（悬停只有第一行）为空串。
 * @param tip 按行分开的悬停说明
 */
export const rangeDescription = (tip) => (tip.length < 2 ? ''
  : `${tip[1]}${tip[2] ? `. ${tip[2]}` : ''}`);

/**
 * @brief 当前一栏的面板宽度、这一行的宽度和这一行里范围、Effort、权限按钮此刻的样子（是否显示、宽度、看得见的图标个数、
 *        textContent、读屏名称、强度、是否支持思考、"Effort: "前缀看不看得见）、范围按钮两段（.range-scope 范围名、
 *        .range-model 当前模型 id）的宽和全文的宽（没有这一段时为 null）、圆环在不在，以及顶栏里还有没有这几个按钮
 *        （不该有）。宽度不取整（各档的边界要比到 1px）。
 */
export function rowState(page) {
  return page.evaluate(({ selector, row: rowCss }) => {
    const pane = document.querySelector(selector);
    const row = pane?.querySelector(rowCss);
    const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
    const icons = (el) => [...(el?.querySelectorAll('svg') ?? [])].filter(visible).length;
    const width = (el) => el?.getBoundingClientRect().width ?? 0;
    const inRow = (id) => row?.querySelector(`[data-testid="${id}"]`) ?? null;
    const part = (el) => {
      if (!el) return null;
      const copy = el.cloneNode(true);
      Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', width: 'max-content', flex: 'none' });
      el.parentElement.append(copy);
      const full = copy.getBoundingClientRect().width;
      copy.remove();
      return { width: width(el), full };
    };
    const model = inRow('model-button');
    const thinking = inRow('thinking-button');
    const permission = inRow('permission-button');
    return { pane: width(pane), row: width(row), model: visible(model), thinking: visible(thinking),
      modelWidth: width(model), scope: part(model?.querySelector('.range-scope')),
      rangeModel: part(model?.querySelector('.range-model')), modelIcons: icons(model), thinkingIcons: icons(thinking),
      thinkingText: thinking?.textContent.trim() ?? null, prefix: visible(thinking?.querySelector('.thinking-prefix')),
      thinkingName: thinking?.getAttribute('aria-label') ?? null, level: thinking?.dataset.level ?? null,
      reasoning: thinking?.dataset.reasoning ?? null, permissionText: permission?.textContent.trim() ?? null,
      permissionIcons: icons(permission), usage: visible(inRow('usage')),
      inTopbar: ['model-button', 'thinking-button', 'permission-button', 'usage']
        .filter((id) => pane?.querySelector(`.topbar [data-testid="${id}"]`)) };
  }, { selector: PANE, row: ROW });
}

/**
 * @brief 当前一栏的一个按钮（model-button / thinking-button / permission-button / usage）：textContent、悬停说明（整段与
 *        按行分开）、读屏名称、读屏的描述（aria-describedby 指向的文字）；unavailable 为"不可用"（aria-disabled 为 true 且
 *        没有 data-pending），pending 为"切换中"（data-pending，C1），hasAria 为带不带 aria-disabled 属性；是否 disabled、
 *        在不在这一行里、在不在顶栏里、data-level / data-reasoning / data-pick / data-current、看得见的图标个数、文字颜色；
 *        范围按钮另有 tipOutside：描述元素（data-testid="model-tip"）在 .model-switch 里、按钮外面。
 */
export const buttonState = (page, testId) => paneOf(page).getByTestId(testId).evaluate((button) => {
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const described = (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const icons = [...button.querySelectorAll('svg')].filter(visible).length;
  const tip = button.closest('.model-switch')?.querySelector('[data-testid="model-tip"]') ?? null;
  const aria = button.getAttribute('aria-disabled') === 'true';
  return { text: button.textContent.trim(), title: button.title, lines: button.title ? button.title.split('\n') : [],
    name: button.getAttribute('aria-label'), described, ariaDisabled: aria,
    hasAria: button.hasAttribute('aria-disabled'),
    unavailable: aria && button.dataset.pending !== 'true', pending: button.dataset.pending === 'true',
    disabled: button.disabled, inRow: Boolean(button.closest('[data-testid="composer"] .composer-bottom')),
    inTopbar: Boolean(button.closest('.topbar')), level: button.dataset.level ?? null,
    reasoning: button.dataset.reasoning ?? null, pick: button.dataset.pick ?? null,
    current: button.dataset.current ?? null, icon: icons > 0, icons, color: getComputedStyle(button).color,
    tipOutside: tip ? !button.contains(tip) && tip.textContent === described : null };
}, null, { timeout: 10000 });

/**
 * @brief 在 paneCss 那一栏（默认当前一栏）这一行的范围菜单里选 pick（分组 id、提供商 id 或 provider/model），等按钮的
 *        data-pick 变过去、不再切换中（没有 data-pending）。
 */
export async function choosePick(page, pick, paneCss = PANE) {
  const css = `${paneCss} ${ROW} [data-testid="model-button"]`;
  await page.locator(css).click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-pick="${pick}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(selector);
    return button?.dataset.pick === want && button.dataset.pending !== 'true';
  }, { selector: css, want: pick }, { timeout: 15000 });
}

// ---------- 输入框下面一行：菜单的位置（models.md"菜单的位置与键盘"） ----------

/**
 * @brief 打开着的弹出层（菜单、圆环详情、换范围失败那一行）和它所在那一栏的位置：弹出层、会话面板、这一行、顶栏、对齐用的
 *        按钮（这一行里的 anchor）各一组位置，窗口大小，计算后的 max-height（px，没有时为 null），内容是不是比高度长
 *        （在菜单里滚动）。弹出层或那一栏不在时为 null。
 * @param where.popup 弹出层的选择器；where.paneCss 那一栏会话面板的选择器；where.anchor 这一行里对齐用的按钮的选择器
 */
export function popupBox(page, { popup, paneCss = PANE, anchor }) {
  return page.evaluate(({ css, paneSel, rowCss, opener }) => {
    const box = document.querySelector(css);
    const pane = document.querySelector(paneSel);
    if (!box || !pane) return null;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const row = pane.querySelector(rowCss);
    return { box: rect(box), pane: rect(pane), row: rect(row), topbar: rect(pane.querySelector(':scope > .topbar')),
      opener: rect(opener ? row?.querySelector(opener) : null), window: { width: innerWidth, height: innerHeight },
      maxHeight: parseFloat(getComputedStyle(box).maxHeight) || null,
      scrolls: box.scrollHeight > box.clientHeight + 1 };
  }, { css: popup, paneSel: paneCss, rowCss: ROW, opener: anchor ?? null });
}

/**
 * @brief 弹出层左右对齐不符合"左右对齐"一行的地方：anchor 右边对齐对齐用的按钮（放不下时左边贴这一行左端），start 对齐
 *        这一行左端，end 对齐这一行右端；width 给出时宽度是 min(width, 这一行的宽)（范围菜单 300px、圆环详情 260px），
 *        widest 给出时宽度不超过 min(widest, 这一行的宽)（换范围失败那一行 320px）。
 */
function alignProblems({ box, row, opener }, { align, width, widest }) {
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  const problems = [];
  const shifted = near(box.left, row.left) && (opener?.right ?? Infinity) - box.width < row.left + 1.5;
  if (align === 'anchor' && !(near(box.right, opener?.right ?? NaN) || shifted)) problems.push('not at its button');
  if (align === 'start' && !near(box.left, row.left)) problems.push('not at the row start');
  if (align === 'end' && !near(box.right, row.right)) problems.push('not at the row end');
  if (width && Math.abs(box.width - Math.min(width, row.width)) > 1) {
    problems.push(`width ${Math.round(box.width)} is not min(${width}, ${Math.round(row.width)})`);
  }
  if (widest && box.width > Math.min(widest, row.width) + 1) problems.push(`wider than min(${widest}, the row)`);
  return problems;
}

/**
 * @brief 弹出层的位置不符合 models.md"菜单的位置与键盘"的地方（空数组为符合）：往上打开（下边在这一行上方 6px）、上下左右
 *        都在这一栏里、不盖到顶栏、在窗口里、最高 min(440, 这一行上边到顶栏下边 − 12)、不伸出这一行，左右见 alignProblems。
 * @param spec POPUPS 里的一项（align、width、widest）
 */
export function placeProblems(geo, spec) {
  if (!geo?.row || !geo.pane) return [`not inside a row: ${JSON.stringify(geo)}`];
  const { box, row, pane, window: view } = geo;
  const ceiling = geo.topbar?.bottom ?? pane.top;
  const at = (value) => Math.round(value * 10) / 10;
  const problems = [];
  if (Math.abs(box.bottom - (row.top - 6)) > 1.5) {
    problems.push(`bottom ${at(box.bottom)} not 6px above the row (${at(row.top)})`);
  }
  if (box.left < pane.left - 1 || box.right > pane.right + 1 || box.bottom > pane.bottom + 1) {
    problems.push('off the pane');
  }
  if (box.top < ceiling - 0.5) problems.push(`top ${at(box.top)} over the top bar (${at(ceiling)})`);
  if (box.top < -0.5 || box.left < -0.5 || box.right > view.width + 0.5 || box.bottom > view.height + 0.5) {
    problems.push('off the window');
  }
  const limit = Math.min(440, row.top - ceiling - 12);
  if (box.height > limit + 1) problems.push(`height ${at(box.height)} above ${at(limit)}`);
  if (box.left < row.left - 1 || box.right > row.right + 1) problems.push('wider than the row');
  return [...problems, ...alignProblems(geo, spec)];
}

/** 这一行的弹出层：打开它的按钮、弹出层、左右对齐方式和宽度（models.md"左右对齐"） */
export const POPUPS = {
  model: { opener: '[data-testid="model-button"]', popup: '[data-testid="model-menu"]', align: 'anchor', width: 300 },
  thinking: { opener: '[data-testid="thinking-button"]', popup: '[data-testid="thinking-menu"]', align: 'anchor' },
  permission: { opener: '[data-testid="permission-button"]', popup: '[data-testid="permission-menu"]',
    align: 'start' },
  usage: { opener: '[data-testid="usage"]', popup: '[data-testid="usage-details"]', align: 'end', width: 260 },
  queue: { opener: '.split-toggle', popup: '.split-button [role="menu"]', align: 'anchor' },
};
/** 换范围失败那一行（不是浮层：只按"左右对齐"和"不出界"，最宽 min(320, 这一行的宽)，models.md 表下） */
export const PICK_ERROR = { opener: '[data-testid="model-button"]', popup: '[data-testid="pick-error"]',
  align: 'anchor', widest: 320 };

/**
 * @brief 在 paneCss 那一栏这一行点 opener 打开一个弹出层，量它的位置（placeProblems），再按 Esc 关上、等它消失。
 * @return problems（placeProblems 的结果）和 geo（popupBox 的结果）；按钮不在或不可用（aria-disabled）时为 null
 */
export async function openAndPlace(page, { paneCss = PANE, ...spec }) {
  const button = page.locator(`${paneCss} ${ROW} ${spec.opener}`).first();
  if (!(await button.isVisible().catch(() => false))) return null;
  if ((await button.getAttribute('aria-disabled')) === 'true') return null;
  await button.click();
  await page.locator(spec.popup).first().waitFor({ timeout: 5000 });
  await settle(page);
  const geo = await popupBox(page, { popup: spec.popup, paneCss, anchor: spec.opener });
  await page.keyboard.press('Escape');
  await page.locator(spec.popup).first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  // 鼠标移开：留在圆环上时它的悬停提示（能接鼠标，WCAG 1.4.13）盖在文字框上，后面点文字框会点到提示
  await page.mouse.move(0, 0);
  return { problems: placeProblems(geo, spec), geo };
}

/**
 * @brief 点开当前一栏 buttonId 的菜单，量它的位置（placeProblems，按钮的种类决定左右对齐），之后 Esc 关上。
 * @return inside（位置都符合）、upward（往上打开）、problems；按钮不显示或不可用时为 null
 */
export async function menuInside(page, buttonId) {
  const kind = Object.keys(POPUPS).find((key) => POPUPS[key].opener === `[data-testid="${buttonId}"]`);
  const result = await openAndPlace(page, POPUPS[kind]);
  if (!result) return null;
  return { inside: result.problems.length === 0, upward: !result.problems.some((item) => item.startsWith('bottom')),
    problems: result.problems };
}

/** @brief 等 css 那个弹出层消失；ms 毫秒内消失时为 true。 */
export const popupGone = (page, css, ms = 5000) => page.locator(css).first()
  .waitFor({ state: 'detached', timeout: ms }).then(() => true, () => false);

// ---------- 输入框下面一行：上下文用量圆环（models.md"上下文用量（圆环）"） ----------

/**
 * @brief paneCss 那一栏的圆环：data-state / data-tokens / data-percent、读屏名称、读屏的描述、有没有 title（不该有）、
 *        aria-expanded、aria-controls 和它是不是指向详情、按钮的大小、焦点在不在它上面、底圈（.ring-base，没有时第一个
 *        circle）和填充（.ring-fill，没有时第二个 circle）的 stroke 和虚线、悬停提示（usage-tip，看得见时的文字和
 *        aria-hidden）、详情（usage-details，看得见时的文字和 4px 高的条的底色）。没有圆环时为 null。
 */
export function ringState(page, paneCss = PANE) {
  return page.evaluate(({ selector, row: rowCss }) => {
    const pane = document.querySelector(selector);
    const ring = pane?.querySelector(`${rowCss} [data-testid="usage"]`);
    if (!ring) return null;
    const visible = (el) => Boolean(el) && el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden';
    const circles = ring.querySelectorAll('circle');
    const paint = (el) => (el ? { stroke: getComputedStyle(el).stroke,
      dashed: !['none', ''].includes(getComputedStyle(el).strokeDasharray) } : null);
    const tip = pane.querySelector('[data-testid="usage-tip"]');
    const details = pane.querySelector('[data-testid="usage-details"]');
    const controls = ring.getAttribute('aria-controls');
    const bars = (el) => [...el.querySelectorAll('*')].filter((item) => visible(item)
      && Math.abs(item.getBoundingClientRect().height - 4) < 0.6).map((item) => getComputedStyle(item).backgroundColor);
    const box = ring.getBoundingClientRect();
    return { state: ring.dataset.state ?? null, tokens: ring.getAttribute('data-tokens'),
      percent: ring.getAttribute('data-percent'), name: ring.getAttribute('aria-label'),
      described: (ring.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '').join(' '),
      title: ring.getAttribute('title'), expanded: ring.getAttribute('aria-expanded'), controls,
      controlsDetails: Boolean(controls) && Boolean(details) && document.getElementById(controls) === details,
      width: box.width, height: box.height, focused: document.activeElement === ring,
      base: paint(ring.querySelector('.ring-base') ?? circles[0] ?? null),
      fill: paint(ring.querySelector('.ring-fill') ?? circles[1] ?? null),
      tip: visible(tip) ? { text: tip.textContent, hidden: tip.getAttribute('aria-hidden') } : null,
      details: visible(details) ? { text: details.innerText, bars: bars(details) } : null };
  }, { selector: paneCss, row: ROW });
}

/** @brief 照 Claude 的写法缩短一个数（models.md）：1,000 起写成 k、999,950 起写成 M（一位小数、去掉".0"），不到 1,000 照写。 */
export function shortCount(count) {
  const trim = (text) => text.replace(/\.0$/, '');
  if (count < 1000) return String(count);
  if (count < 999950) return `${trim((count / 1000).toFixed(1))}k`;
  return `${trim((count / 1000000).toFixed(1))}M`;
}

/**
 * @brief 有用量时圆环应有的文字（models.md）：悬停"Context ≈ 15.4k / 128k (12%)"、详情右边的 summary、读屏名称
 *        "Usage: Context approximately 15,360 of 128,000 tokens (12%)"。percent 是四舍五入后的整数。
 */
export function ringTexts(tokens, contextWindow, percent) {
  const summary = `≈ ${shortCount(tokens)} / ${shortCount(contextWindow)} (${percent}%)`;
  return { summary, tip: `Context ${summary}`, name: `Usage: Context approximately ${tokens.toLocaleString('en-US')} `
    + `of ${contextWindow.toLocaleString('en-US')} tokens (${percent}%)` };
}

// ---------- 颜色（圆环的分档、"Allow all"的对比度） ----------

/**
 * @brief 几个颜色 token（--color-line 等）在页面里算出来的颜色：作 SVG 的 stroke、元素的 background-color 时的写法
 *        （与 getComputedStyle 读到的按钮、圆环的颜色可以直接比较）。
 */
export function tokenColors(page, names) {
  return page.evaluate((list) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const span = document.createElement('span');
    svg.append(circle);
    document.body.append(svg, span);
    const colors = Object.fromEntries(list.map((name) => {
      circle.style.stroke = `var(${name})`;
      span.style.backgroundColor = `var(${name})`;
      return [name, { stroke: getComputedStyle(circle).stroke, background: getComputedStyle(span).backgroundColor }];
    }));
    svg.remove();
    span.remove();
    return colors;
  }, names);
}

/** @brief selector 那个元素的文字颜色，和从它往上直到 html 的每一层底色（里层在前）。不在时为 null。 */
export function colorStack(page, selector) {
  return page.evaluate((css) => {
    const el = document.querySelector(css);
    if (!el) return null;
    const layers = [];
    for (let node = el; node instanceof Element; node = node.parentElement) {
      layers.push(getComputedStyle(node).backgroundColor);
    }
    return { color: getComputedStyle(el).color, layers };
  }, selector);
}

/** @brief 把计算后的颜色（rgb() / rgba() / color(srgb …)）拆成 0–1 的 r、g、b 和 a。 */
function parseColor(text) {
  const nums = (String(text).match(/-?\d*\.?\d+(e-?\d+)?/g) ?? []).map(Number);
  if (String(text).startsWith('color(')) return { r: nums[0], g: nums[1], b: nums[2], a: nums[3] ?? 1 };
  return { r: nums[0] / 255, g: nums[1] / 255, b: nums[2] / 255, a: nums[3] ?? 1 };
}

/** @brief 前景色盖在背景色上的结果（背景不透明）。 */
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });

/** @brief 相对亮度（WCAG 2）。 */
function luminance({ r, g, b }) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** @brief colorStack 的文字和它实际的底色（各层从外到里叠在白色上）的对比度；stack 为 null 时为 0。 */
export function contrastOf(stack) {
  if (!stack) return 0;
  const white = { r: 1, g: 1, b: 1, a: 1 };
  const background = [...stack.layers].reverse().reduce((under, layer) => over(parseColor(layer), under), white);
  const text = over(parseColor(stack.color), background);
  const [light, dark] = [luminance(text), luminance(background)].sort((a, b) => b - a);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

// ---------- 会话面板的宽度、这一行的中间状态 ----------

/** @brief 当前一栏 .chat-pane 的宽度（不取整）。 */
export const paneWidth = (page) => page.evaluate((selector) => document.querySelector(selector)
  ?.getBoundingClientRect().width ?? 0, PANE);

/**
 * @brief 单栏：把这一栏的右栏开关切到 right，再按量到的差改窗口宽度，让会话面板（.chat-pane）正好 target 宽（最多试 5 次；
 *        窗口最窄 800px，到不了时停在最接近的）。返回最后量到的宽度。
 * @param ctx 有 app、page
 * @param options.right 右栏开关；options.height 窗口内容区的高度
 */
export async function fitPane(ctx, target, { right = false, height = 800 } = {}) {
  const { app, page } = ctx;
  // 窗口窄于 1024px 时左栏收成 60px 的图标栏：从窄的样子往宽调会停在图标栏、窗口约 990px 的样子（会话行藏起来）。
  // 宽于 760px 的目标先回到默认的 1200 宽窗口，调完的样子不随前面的步骤变
  if (target > 760) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
      { w: 1200, h: height });
    await page.waitForFunction(() => innerWidth === 1200, null, { timeout: 5000 }).catch(() => {});
  }
  const toggle = paneOf(page).locator('.topbar').getByRole('button', { name: 'Toggle changes' });
  if ((await toggle.getAttribute('aria-pressed')) !== String(right)) await toggle.click();
  await settle(page);
  for (let tries = 0; tries < 5; tries += 1) {
    const now = await paneWidth(page);
    const current = await page.evaluate(() => innerWidth);
    const next = Math.max(800, Math.round(current + target - now));
    if (Math.abs(now - target) < 0.5 || next === current) break;
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
      { w: next, h: height });
    await page.waitForFunction((w) => innerWidth === w, next, { timeout: 5000 }).catch(() => {});
    await settle(page);
    await settle(page);
  }
  return paneWidth(page);
}

/**
 * @brief 用 MutationObserver 记下此后每次界面变化时每一栏输入框下面一行的样子（与这一栏上一次相同时不记）：哪一边、
 *        发送中 / 生成中、不能发送的说明、看得见的直接子项（从左到右的种类）、高度、是否横向溢出，权限 / 范围 / Effort 按钮
 *        是否不可用（aria-disabled）、是否切换中（data-pending）、读屏的描述、aria-description 的原值（没有时 null）和
 *        悬停说明，以及焦点在这一栏的什么上（这一行里的
 *        按钮的 data-testid 或 aria-label、"textarea"，不在这一栏时为 null）。抓"Starting…""Restarting…"、切换中这类
 *        只持续一小会儿的状态；seenRows 取回。
 */
export function watchRows(page) {
  return page.evaluate((rowCss) => {
    const kinds = [['permission', '[data-testid="permission-button"]'], ['model', '[data-testid="model-button"]'],
      ['thinking', '[data-testid="thinking-button"]'], ['usage', '[data-testid="usage"]'],
      ['wait', '[data-testid="not-ready"]'], ['queue', '.split-toggle, .queue-button'],
      ['stopTeam', '.stop-team-button'], ['stop', '.stop-button'], ['send', '.send-button']];
    const kindOf = (el) => kinds.find(([, css]) => el.matches(css) || el.querySelector(css))?.[0] ?? el.className;
    const control = (row, id) => {
      const el = row.querySelector(`[data-testid="${id}"]`);
      const refs = (el?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      return el ? { aria: el.getAttribute('aria-disabled') === 'true', pending: el.dataset.pending === 'true',
        title: el.title, reason: refs.map((ref) => document.getElementById(ref)?.textContent ?? '').join(' ') || null,
        ariaDescription: el.getAttribute('aria-description') } : null;
    };
    const focusIn = (pane, row) => {
      const el = document.activeElement;
      if (el && row.contains(el)) return el.dataset.testid || el.getAttribute('aria-label') || el.className;
      return el && el === pane.querySelector('.composer textarea') ? 'textarea' : null;
    };
    const snap = (slot) => {
      const pane = slot.querySelector('[data-testid="chat-pane"]');
      const row = pane?.querySelector(rowCss);
      if (!row) return null;
      return { side: slot.dataset.side, sending: pane.dataset.sending === 'true',
        running: pane.dataset.running === 'true',
        wait: row.querySelector('[data-testid="not-ready"]')?.textContent ?? null,
        kinds: [...row.children].filter((el) => el.getBoundingClientRect().width > 1).map(kindOf),
        height: Math.round(row.getBoundingClientRect().height), overflow: row.scrollWidth > row.clientWidth + 1,
        permission: control(row, 'permission-button'), model: control(row, 'model-button'),
        thinking: control(row, 'thinking-button'), focus: focusIn(pane, row) };
    };
    window.__rows = [];
    const last = new Map();
    const take = () => document.querySelectorAll('.pane-slot:not([hidden])').forEach((slot) => {
      const now = snap(slot);
      const text = JSON.stringify(now);
      if (now && last.get(now.side) !== text) {
        last.set(now.side, text);
        window.__rows.push(now);
      }
    });
    window.__rowsObserver?.disconnect();
    window.__rowsObserver = new MutationObserver(take);
    window.__rowsObserver.observe(document.body,
      { subtree: true, childList: true, attributes: true, characterData: true });
    take();
  }, ROW);
}

/** @brief 停下 watchRows，返回记下的样子（按时间顺序）。 */
export const seenRows = (page) => page.evaluate(() => {
  window.__rowsObserver?.disconnect();
  return window.__rows ?? [];
});

/**
 * @brief 记下此刻 selector 范围里小于 12px 的可见文字（ctx.small，最后统一判断；ctx.smallChecked 记看过的地方）。
 * @param where 记录里写的位置
 */
export async function noteSmallIn(ctx, where, selector) {
  const small = await ctx.page.evaluate((query) => [...document.querySelectorAll(query)]
    .flatMap((root) => [root, ...root.querySelectorAll('*')])
    .filter((element) => [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
    .filter((element) => element.getClientRects().length > 0)
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12)
    .map((element) => `${element.tagName.toLowerCase()}.${element.className}: ${getComputedStyle(element).fontSize}`),
  selector);
  ctx.small.push(...small.map((item) => `${where}: ${item}`));
  ctx.smallChecked.push(where);
}

// ---------- m6-app-mcp-shared.mjs 加的：带命令行的进程列表 ----------

/** Win32_Process 的一行：PID、父 PID、名字、命令行，用 | 分开 */
const PROCESS_QUERY = 'Get-CimInstance Win32_Process | ForEach-Object '
  + '{ "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';

/** @brief 全部进程：pid、parent、name、command（命令行；读不到时为空串）。 */
export function processList() {
  return execFileSync('powershell', ['-NoProfile', '-Command', PROCESS_QUERY], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, parent, name, ...command] = line.split('|');
      return { pid: Number(pid), parent: Number(parent), name, command: command.join('|') };
    });
}

/** @brief rootPid 的全部子孙进程（不含它自己），带命令行；rows 不给时现读一次进程列表。 */
export function descendantsOf(rootPid, rows = processList()) {
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.parent) && !tree.has(row.pid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  tree.delete(rootPid);
  return rows.filter((row) => tree.has(row.pid));
}

// ---------- 顶栏和这一行在各档的样子（composer-pickers.md"新加的检查"第 1–3 条） ----------
// 宽度都指 .chat-pane（分屏右边那一栏比 .pane-slot 窄 1px），不取整：各档的边界要比到 1px。

/** @brief 保留一位小数（记录里用）。 */
export const at1 = (value) => Math.round(value * 10) / 10;

/** 截短的几项最窄多宽：[宽于 340px 时, ≤ 340px 时]（models.md"放不下"） */
export const LEAST = { permission: [44, 40], model: [40, 36], thinking: [40, 36], wait: [48, 48] };
/** @brief 这一项在宽度 w 的一栏里最窄多宽。 */
export const least = (kind, w) => LEAST[kind][w <= 340 ? 1 : 0];
/** @brief 宽度 w 的一栏这一行用哪一档（models.md"窄栏"的状态表：680 / 600 / 460 / 400 / 340px）。 */
export const bandOf = (w) => ({ prefix: w > 680, sendText: w > 600, arrows: w > 460, gap: w > 460 ? 8 : 4,
  fold: w <= 400, tight: w <= 340 });
/** @brief 宽度落在哪几条边界之内（判断两个宽度是不是同一档；顶栏的 400 / 320px 也算）。 */
export const bandKey = (w) => [680, 600, 460, 400, 340, 320].filter((edge) => w <= edge).join();
/**
 * 各状态下这一行从左到右该有的几项（chat.md"输入框下面一行"的状态表）：idle 空闲、running 生成中、typed 生成中有字、
 * preparing 准备中、prepTyped 准备中有字（单个"Queue"）、exited 后台进程退出 / 重新载入中 / Restart 之后重新打开中、
 * opening 第一次打开中、failed 打开失败、blocked 拒绝启动且没有当前模型（没有 Effort；圆环按 pi 的结果，可能不在）；
 * 协作模式下后台有 Agent（有 Stop team）时：teamRunning 生成中、teamTyped 生成中有字（≤ 340px 时"Queue ▾"收起，
 * 同 teamRunning，models.md"窄栏"）
 */
export const KINDS = { idle: 'permission,model,thinking,usage,send', running: 'permission,model,thinking,usage,stop',
  typed: 'permission,model,thinking,usage,queue,stop', preparing: 'permission,model,thinking,usage,stop',
  prepTyped: 'permission,model,thinking,usage,queue,stop', exited: 'permission,model,thinking,usage,wait',
  opening: 'permission,wait', failed: 'permission,wait', blocked: 'permission,model,usage,send',
  teamRunning: 'permission,model,thinking,usage,stopTeam,stop',
  teamTyped: 'permission,model,thinking,usage,queue,stopTeam,stop' };
/** @brief 宽度 w 的一栏这一行从左到右的几项是不是 state 该有的（blocked 时圆环可以不在）。 */
const kindsMatch = (kinds, state, w) => kinds === (state === 'teamTyped' && w <= 340 ? KINDS.teamRunning
  : KINDS[state]) || (state === 'blocked' && kinds === 'permission,model,send');

/**
 * @brief 每一栏顶栏此刻的样子（在页面里执行）：宽度、左边、是不是分屏、内边距、项目名的宽度（不显示时 0）、›、会话名（宽度、
 *        全宽、文字）、顶栏上的按钮（读屏名称、宽度）、协作开关（宽度、文字和状态点看不看得见）、顶栏里有没有这一行的按钮
 *        （不该有）、溢出、裁切，和会话名还能变宽多少
 *        （slack：会话名右边到面包屑右边、面包屑到按钮组的距离减去顶栏的 gap、按钮组右边到顶栏内边距，三段相加）。
 */
export function topFacts(panes) {
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const width = (el) => (visible(el) ? el.getBoundingClientRect().width : 0);
  const right = (el) => el.getBoundingClientRect().right;
  return panes.map((pane) => {
    const bar = pane.querySelector(':scope > .topbar');
    const box = bar.getBoundingClientRect();
    const style = getComputedStyle(bar);
    const crumb = bar.querySelector('.breadcrumb');
    const actions = bar.querySelector('.topbar-actions');
    const title = bar.querySelector('[data-testid="session-title"]');
    const team = bar.querySelector('[data-testid="team-switch"]');
    const slack = (right(crumb) - right(title)) + (actions.getBoundingClientRect().left - right(crumb)
      - (parseFloat(style.columnGap) || 0)) + (box.right - parseFloat(style.paddingRight) - right(actions));
    const clipped = [...bar.querySelectorAll('.breadcrumb > *, .topbar-actions > *')].filter(visible).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left < box.left - 1 || rect.right > box.right + 1 || rect.right > innerWidth + 1;
    }).map((el) => el.getAttribute('aria-label') || el.className || el.tagName);
    return { width: pane.getBoundingClientRect().width, left: pane.getBoundingClientRect().left,
      split: Boolean(pane.closest('.center[data-split]')), pad: parseFloat(style.paddingLeft),
      project: width(bar.querySelector('.chat-project')), chevron: visible(crumb.querySelector(':scope > svg')),
      title: width(title), titleFull: title.scrollWidth, titleText: title.textContent, slack, clipped,
      overflow: [bar, crumb, actions].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className),
      buttons: [...actions.querySelectorAll('button')].filter(visible)
        .map((el) => ({ name: el.getAttribute('aria-label'), width: width(el), team: el === team })),
      team: team && { width: width(team), text: visible(team.querySelector('.team-text')),
        dot: visible(team.querySelector('.team-dot')) },
      pickers: ['model-button', 'thinking-button', 'permission-button', 'usage']
        .filter((id) => bar.querySelector(`[data-testid="${id}"]`)) };
  });
}

/**
 * @brief 每一栏输入框下面一行的框架（在页面里执行）：是否在生成或发送、不能发送的说明，这一行和输入框的位置、gap、
 *        是否横向溢出，以及从左到右看得见的直接子项（种类和位置；藏起来的描述元素这类 1px 以下的不算）。
 */
export function rowFrame(panes) {
  const kinds = [['permission', '[data-testid="permission-button"]'], ['model', '[data-testid="model-button"]'],
    ['thinking', '[data-testid="thinking-button"]'], ['usage', '[data-testid="usage"]'],
    ['wait', '[data-testid="not-ready"]'], ['queue', '.split-toggle, .queue-button'], ['stopTeam', '.stop-team-button'],
    ['stop', '.stop-button'], ['send', '.send-button']];
  const kindOf = (el) => kinds.find(([, css]) => el.matches(css) || el.querySelector(css))?.[0]
    ?? (el.className || el.tagName);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    && el.getBoundingClientRect().width > 1;
  return panes.map((pane) => {
    const composer = pane.querySelector('[data-testid="composer"]');
    const row = composer.querySelector('.composer-bottom');
    return { running: pane.dataset.running === 'true' || pane.dataset.sending === 'true',
      wait: row.querySelector('[data-testid="not-ready"]')?.textContent ?? null, row: rect(row),
      composer: rect(composer), gap: parseFloat(getComputedStyle(row).columnGap) || 0,
      scroll: row.scrollWidth > row.clientWidth + 1, rings: pane.querySelectorAll('[data-testid="usage"]').length,
      items: [...row.children].filter(shown).map((el) => ({ kind: kindOf(el), ...rect(el) })) };
  });
}

/**
 * @brief 每一栏这一行里各个按钮（在页面里执行）：宽度、读屏名称、悬停说明（按行）、textContent、innerText（看得见的字）、
 *        看得见的和全部的 svg 个数、左右内边距、是否 aria-disabled、带不带这个属性、是否切换中（data-pending）、是否 disabled、
 *        读屏的描述、data-reasoning、data-current、是否协作模式下锁定的模型按钮（data-locked）；不显示的为 null。还有权限按钮
 *        是不是"Allow all"（.all）、"Effort: "前缀看不看得见，以及 Stop team。
 */
export function rowControls(panes) {
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    && el.getBoundingClientRect().width > 0;
  const describe = (el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const info = (el) => (visible(el) ? { width: el.getBoundingClientRect().width, name: el.getAttribute('aria-label'),
    tip: el.title ? el.title.split('\n') : [], text: el.textContent.trim(), shown: el.innerText.trim(),
    svgs: [...el.querySelectorAll('svg')].filter(visible).length, allSvgs: el.querySelectorAll('svg').length,
    pad: [parseFloat(getComputedStyle(el).paddingLeft), parseFloat(getComputedStyle(el).paddingRight)],
    aria: el.getAttribute('aria-disabled') === 'true', hasAria: el.hasAttribute('aria-disabled'),
    pending: el.dataset.pending === 'true', disabled: Boolean(el.disabled), described: describe(el),
    reasoning: el.dataset.reasoning ?? null, current: el.dataset.current ?? null,
    locked: el.dataset.locked === 'true' } : null);
  return panes.map((pane) => {
    const row = pane.querySelector('[data-testid="composer"] .composer-bottom');
    const q = (css) => row.querySelector(css);
    return { permission: info(q('[data-testid="permission-button"]')), all: Boolean(q('.permission-button.all')),
      model: info(q('[data-testid="model-button"]')), thinking: info(q('[data-testid="thinking-button"]')),
      prefix: visible(q('.thinking-prefix')), usage: info(q('[data-testid="usage"]')),
      wait: info(q('[data-testid="not-ready"]')), queue: info(q('.split-button > .button:not(.split-toggle)')),
      toggle: info(q('.split-toggle')), queueOne: info(q('.queue-button')), stop: info(q('.stop-button')),
      send: info(q('.send-button')), stopTeam: info(q('.stop-team-button')) };
  });
}

/**
 * @brief 每一栏这一行里装字的元素是否截短（在页面里执行；composer-pickers.md"新加的检查"第 3 条）：元素的宽度和全文的宽
 *        （同样式下 width: max-content 的藏起来的副本，量完就删），以及 text-overflow 是不是 ellipsis。是否截短不用
 *        scrollWidth（截短时可能与 clientWidth 相等）。范围按钮的两段分开量（.range-scope 范围名、.range-model 带开头
 *        " · "的当前模型 id）。lead 是模式名开头两个字母加"…"的宽（最窄时至少看得见这么多）。
 */
export function rowTexts(panes) {
  const measure = (el, text) => {
    const copy = el.cloneNode(true);
    if (text !== undefined) copy.textContent = text;
    copy.removeAttribute('id');
    Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', width: 'max-content', maxWidth: 'none',
      minWidth: '0', flex: 'none' });
    el.parentElement.append(copy);
    const width = copy.getBoundingClientRect().width;
    copy.remove();
    return width;
  };
  const fact = (el) => (el && el.getClientRects().length > 0 ? { width: el.getBoundingClientRect().width,
    full: measure(el), ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' } : null);
  return panes.map((pane) => {
    const row = pane.querySelector('[data-testid="composer"] .composer-bottom');
    const q = (css) => row.querySelector(css);
    const mode = q('[data-testid="permission-button"] .permission-text');
    return { permission: fact(mode), lead: mode ? measure(mode, `${mode.textContent.slice(0, 2)}…`) : null,
      scope: fact(q('[data-testid="model-button"] .range-scope')),
      model: fact(q('[data-testid="model-button"] .range-model')),
      thinking: fact(q('[data-testid="thinking-button"] .switch-text')), wait: fact(q('[data-testid="not-ready"]')) };
  });
}

/** @brief 窗口、左栏、中栏、右栏的宽度，页面有没有横向、纵向溢出，有没有元素出窗口。 */
export function frameFacts() {
  const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
  const outside = [...document.querySelectorAll('.app *')].filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.right > innerWidth + 1 && !el.closest('.conversation, .panel-body');
  }).map((el) => el.className || el.tagName).slice(0, 5);
  return { window: innerWidth, height: innerHeight, page: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight, sidebar: width(document.querySelector('.sidebar')),
    center: width(document.querySelector('.center')),
    right: width(document.querySelector('[data-testid="right-panel"]')), outside };
}

/** @brief 整个窗口和每一栏（从左到右）的顶栏、输入框下面一行此刻的样子。 */
export async function layoutReport(page) {
  const panes = page.locator(PANE);
  const tops = await panes.evaluateAll(topFacts);
  const frames = await panes.evaluateAll(rowFrame);
  const controls = await panes.evaluateAll(rowControls);
  const texts = await panes.evaluateAll(rowTexts);
  const all = tops.map((top, index) => ({ width: top.width, left: top.left, top, frame: frames[index],
    controls: controls[index], texts: texts[index] }));
  return { ...(await page.evaluate(frameFacts)), panes: all.sort((a, b) => a.left - b.left) };
}

/** @brief 记录里放的简短样子：窗口、各栏宽度、这一行从左到右的几项、会话名的宽度。 */
export const layoutBrief = (report) => JSON.stringify({ window: report.window, sidebar: report.sidebar,
  center: report.center, right: report.right, outside: report.outside, panes: report.panes.map((pane) => ({
    width: at1(pane.width), items: pane.frame.items.map((item) => `${item.kind}:${at1(item.width)}`).join(' '),
    title: `${at1(pane.top.title)}/${pane.top.titleFull}`, project: at1(pane.top.project) })) });

/** 协作开关的读屏名称（docs/v1/screens/team-switch.md） */
const TEAM_NAME = /^Team: (Off|On|Until done)$/;

/**
 * @brief 一栏顶栏不符合 chat.md"顶栏"的地方（空数组为符合）：只有"项目名 › 会话名"、协作开关、右栏开关和分屏时的
 *        "Close pane"，没有范围、Effort、权限按钮和圆环；协作开关宽于 600px 时是完整文字、没有状态点，≤ 600px 时只有
 *        状态点（team-switch.md"窄栏"）；≤ 400px 时两个图标按钮 28px；> 320px 时有项目名（最长 160px）和 ›，≤ 320px 时
 *        没有；会话名截断时项目名已收到 40px、会话名占满剩下的地方（差 2px 以内）；460px 时会话名至少 253px、280px 和 279px 时
 *        至少 168px（只有状态点时算出的 258、173、172px 留 5、5、4px）；不溢出、不裁切。
 */
export function topProblems({ top }) {
  const problems = [];
  const [team, ...icons] = top.buttons;
  const names = icons.map((button) => button.name).join();
  const iconNames = top.split ? 'Toggle changes,Close pane' : 'Toggle changes';
  if (!team?.team || !TEAM_NAME.test(team.name) || names !== iconNames) {
    problems.push(`top buttons ${top.buttons.map((button) => button.name).join()}`);
  }
  const narrow = top.width <= 600;
  if (!top.team || top.team.text === narrow || top.team.dot !== narrow || (narrow && top.team.width > 20)) {
    problems.push(`team switch ${JSON.stringify(top.team)}`);
  }
  if (top.pickers.length) problems.push(`top bar still has ${top.pickers.join()}`);
  if (top.width <= 400 && icons.some((button) => Math.abs(button.width - 28) > 0.5)) {
    problems.push(`icon buttons ${icons.map((button) => at1(button.width)).join('/')}px`);
  }
  if (top.width > 320 ? top.project === 0 || !top.chevron : top.project > 0 || top.chevron) {
    problems.push(`project ${at1(top.project)}px, chevron ${top.chevron}`);
  }
  if (top.project > 160.5) problems.push(`project ${at1(top.project)}px`);
  const cut = top.titleFull > top.title + 1;
  if (cut && top.project > 40.5) problems.push(`title cut while the project is ${at1(top.project)}px`);
  if (cut && Math.abs(top.slack) > 2) problems.push(`title leaves ${at1(top.slack)}px`);
  if (cut && top.width < 281 && top.title < 168) problems.push(`title ${at1(top.title)}px at ${at1(top.width)}px`);
  if (cut && Math.abs(top.width - 460) <= 5 && top.title < 253) problems.push(`title ${at1(top.title)}px`);
  if (top.overflow.length || top.clipped.length) problems.push(`top overflow ${top.overflow} / ${top.clipped}`);
  return problems;
}

/** @brief 这一行的框架：高 33px（不能发送时也是）、不换行、不超出这一行和输入框、间距按档（8px，≤ 460px 时 4px）。 */
export function fitProblems(pane) {
  const { row, composer, items } = pane.frame;
  const problems = [];
  if (Math.abs(row.height - 33) > 1) problems.push(`row ${at1(row.height)}px high`);
  if (pane.frame.scroll || items.some((item) => item.left < row.left - 0.5 || item.right > row.right + 0.5)) {
    problems.push('items outside the row');
  }
  if (items.some((item) => item.top < row.top - 0.5 || item.bottom > row.bottom + 0.5)) problems.push('wrapped');
  if (row.left < composer.left - 0.5 || row.right > composer.right + 0.5) problems.push('row outside the message box');
  if (pane.frame.gap !== bandOf(pane.width).gap) problems.push(`gap ${pane.frame.gap}px`);
  return problems;
}

/**
 * @brief 权限按钮（approval.md"权限菜单"）：只有模式名（任何宽度都没有盾牌，> 460px 时只有 ▾ 一个图标），读屏名称和悬停说明
 *        的第一行是"Permission mode: <模式>"，第二行和读屏的描述是这个模式的说明（不能发送时是原因），宽度不窄于最窄，
 *        ≤ 340px 时左右内边距 4px；不能发送时 aria-disabled，能用时不带这个属性。
 */
export function permissionProblems({ width: w, frame, controls: { permission: p, all } }) {
  if (!p) return ['no permission button'];
  const mode = all ? 'Allow all' : 'Ask each time';
  const note = frame.wait ?? (all ? NOTE.all : NOTE.ask);
  const problems = [];
  if (p.text !== mode || p.name !== `Permission mode: ${mode}`) problems.push(`permission "${p.text}" / "${p.name}"`);
  if (p.tip.join('|') !== `Permission mode: ${mode}|${note}` || p.described !== note) {
    problems.push(`permission tip "${p.tip.join(' | ')}" / "${p.described}"`);
  }
  if (p.svgs !== (w > 460 ? 1 : 0) || p.allSvgs > 1) problems.push(`permission icons ${p.svgs}/${p.allSvgs}`);
  if (p.width < least('permission', w) - 0.5) problems.push(`permission ${at1(p.width)}px`);
  if (w <= 340 && p.pad.some((pad) => pad !== 4)) problems.push(`permission padding ${p.pad}`);
  if (p.aria !== (frame.wait !== null) || (frame.wait === null && p.hasAria)) {
    problems.push(`permission aria-disabled ${p.aria} (attribute ${p.hasAria})`);
  }
  return problems;
}

/** 协作模式下模型按钮的悬停（平行 Agent 规格 §12.11） */
export const LOCKED_TITLE = 'Team mode picks the model for each agent';

/**
 * @brief 协作模式下锁定的模型按钮（规格 §12.11、team-blocked.md，composer-pickers-checks.md 第 69 条）：在范围按钮的位置，
 *        读屏名称"Model: <模型 id>"，悬停只有"Team mode picks the model for each agent"，aria-disabled，没有 ▾；
 *        这一项不窄于最窄、按钮不宽于 200px；放不下时字截短（带"…"），截短的按钮撑满最窄；≤ 340px 时内边距 4px。
 */
function lockedProblems(w, frame, m, texts) {
  const problems = [];
  if (m.name !== `Model: ${m.text}` || m.tip.join('|') !== LOCKED_TITLE) {
    problems.push(`locked "${m.text}" / "${m.name}" / "${m.tip.join(' | ')}"`);
  }
  if (!m.aria || m.allSvgs !== 0 || m.disabled) problems.push(`locked aria ${m.aria}, icons ${m.allSvgs}`);
  const item = frame.items.find((entry) => entry.kind === 'model')?.width ?? m.width;
  const cut = Boolean(texts?.scope) && texts.scope.width < texts.scope.full - 0.01;
  if (m.width > RANGE_MAX + 0.5 || item < least('model', w) - 0.5) problems.push(`locked ${at1(m.width)}px`);
  if (cut && (m.width < least('model', w) - 0.5 || !texts.scope.ellipsis)) {
    problems.push(`locked cut at ${at1(m.width)}px`);
  }
  if (w <= 340 && m.pad.some((pad) => pad !== 4)) problems.push(`locked padding ${m.pad}`);
  return problems;
}

/**
 * @brief 选择范围按钮（models.md"选择范围按钮""窄栏"，composer-pickers.md"v1 之后的调整"）：读屏名称"Model range: <按钮文字>"
 *        （" · "换成", "）；悬停三行：按钮文字 / "<提供商名>"（没有当前模型时"No model can run in this session"）/ 不可用时的原因；
 *        准备中、生成中、不能发送时 aria-disabled（能用时不带这个属性，不在切换中）；读屏的描述是第二行加
 *        ". <原因>"；宽度在最窄和 200px 之间；▾ 按档；≤ 340px 时内边距 4px。
 */
export function modelProblems({ width: w, frame, controls: { model: m }, texts }) {
  if (!m) return [];
  if (m.locked) return lockedProblems(w, frame, m, texts);
  const reason = frame.wait ?? (frame.running ? NOTE.modelBusy : null);
  const second = m.current ? PROVIDER_LINE.test(m.tip[1] ?? '') : m.tip[1] === NOTE.noModel;
  const problems = [];
  if (m.name !== `Model range: ${m.text.replace(/ · /g, ', ')}` || m.tip[0] !== m.text) {
    problems.push(`range "${m.text}" / "${m.name}" / "${m.tip[0]}"`);
  }
  if (!second || (m.tip[2] ?? null) !== reason || m.tip.length > 3) problems.push(`range tip "${m.tip.join(' | ')}"`);
  if (m.aria !== Boolean(reason) || (!reason && m.hasAria) || m.pending) {
    problems.push(`range aria-disabled ${m.aria} (attribute ${m.hasAria}, pending ${m.pending})`);
  }
  if (m.described !== rangeDescription(m.tip)) problems.push(`range description "${m.described}"`);
  // C1：不可用只靠 aria-disabled，不用原生 disabled（原生的会把按钮移出 Tab 顺序）
  if (m.disabled) problems.push('range button is natively disabled');
  // 最窄在这一项（.model-switch）上：模型 id 很短（"o3"）时按钮比最窄窄、字完整，那一项仍占最窄；截短的按钮要撑满它
  const item = frame.items.find((entry) => entry.kind === 'model')?.width ?? m.width;
  const cut = [texts?.scope, texts?.model].some((fact) => Boolean(fact) && fact.width < fact.full - 0.01);
  if (m.width > RANGE_MAX + 0.5 || item < least('model', w) - 0.5) problems.push(`range ${at1(m.width)}px`);
  if (cut && m.width < least('model', w) - 0.5) problems.push(`range cut at ${at1(m.width)}px`);
  if (m.svgs !== (bandOf(w).arrows ? 1 : 0)) problems.push(`range icons ${m.svgs}`);
  if (w <= 340 && m.pad.some((pad) => pad !== 4)) problems.push(`range padding ${m.pad}`);
  return problems;
}

/**
 * @brief Effort 按钮（models.md"思考强度""窄栏"）：textContent 总是"Effort: <强度>"（窄时前缀藏起也在），> 680px 时前缀
 *        看得见；读屏名称和悬停第一行"Effort: <强度>"，第二行和读屏的描述是说明或原因；不可用时 aria-disabled（能用时不带
 *        这个属性）；这一项（.thinking-switch）不窄于最窄；▾ 按档；≤ 340px 时内边距 4px。
 */
export function effortProblems({ width: w, frame, controls: { thinking: t, prefix }, texts }) {
  if (!t) return [];
  const label = t.text.replace(/^Effort: /, '');
  const reason = frame.wait ?? (frame.running ? NOTE.effortBusy : null);
  const note = reason ?? (t.reasoning === 'true' ? NOTE.effort : NOTE.unsupported);
  const problems = [];
  if (!t.text.startsWith('Effort: ') || t.name !== `Effort: ${label}` || t.tip[0] !== t.name) {
    problems.push(`effort "${t.text}" / "${t.name}" / "${t.tip[0]}"`);
  }
  if (t.tip[1] !== note || t.tip.length > 2 || t.described !== note) {
    problems.push(`effort tip "${t.tip.join(' | ')}" / "${t.described}"`);
  }
  if (t.aria !== Boolean(reason) || (!reason && t.hasAria) || t.pending) {
    problems.push(`effort aria-disabled ${t.aria} (attribute ${t.hasAria}, pending ${t.pending})`);
  }
  if (t.disabled) problems.push('effort button is natively disabled');
  if (prefix !== bandOf(w).prefix) problems.push(`"Effort: " shown ${prefix}`);
  // 最窄（min-width）在这一行的直接子项 .thinking-switch 上：强度很短（≤ 340px 的"High"约 33px）时按钮本身比最窄窄、
  // 字是完整的，那一项仍占最窄；所以量这一项。按钮比最窄窄时字必须是完整的（截短的按钮要撑满这一项）
  const item = frame.items.find((entry) => entry.kind === 'thinking')?.width ?? t.width;
  if (item < least('thinking', w) - 0.5) problems.push(`effort ${at1(item)}px`);
  const cut = Boolean(texts?.thinking) && texts.thinking.width < texts.thinking.full - 0.01;
  if (cut && t.width < least('thinking', w) - 0.5) problems.push(`effort cut at ${at1(t.width)}px`);
  if (t.svgs !== (bandOf(w).arrows ? 1 : 0)) problems.push(`effort icons ${t.svgs}`);
  if (w <= 340 && t.pad.some((pad) => pad !== 4)) problems.push(`effort padding ${t.pad}`);
  return problems;
}

/**
 * @brief 一个只有图标或带文字的发送组按钮：> textAbove（默认 600px，Stop team 760px）时看得见文字 word；更窄时只有图标
 *        （innerText 为空）、读屏名称 word、悬停 tip、宽 size。
 */
export function sendButtonProblems(button, w, { word, tip, size, textAbove = 600 }) {
  if (!button) return [`no ${word}`];
  if (w > textAbove) return button.shown === word ? [] : [`${word} shows "${button.shown}"`];
  const problems = [];
  if (button.shown !== '' || button.name !== word || button.tip[0] !== tip) {
    problems.push(`${word} icon "${button.shown}" / "${button.name}" / "${button.tip[0]}"`);
  }
  if (Math.abs(button.width - size) > 0.5) problems.push(`${word} ${at1(button.width)}px`);
  return problems;
}

/** @brief 圆环（任何宽度约 26px、不收）；第一次打开中、打开失败时没有圆环，拒绝启动时可以没有（pi 返回空）。 */
function ringProblems(c, state) {
  if (state === 'failed' || state === 'opening') return c.usage ? ['ring shown'] : [];
  if (state === 'blocked' && !c.usage) return [];
  return !c.usage || Math.abs(c.usage.width - 26) > 1 ? [`ring ${at1(c.usage?.width ?? 0)}px`] : [];
}

/**
 * @brief 生成中有字时的"Queue ▾"（models.md"窄栏"）：≤ foldAt（400px；有 Stop team 时 520px）时"Queue"收起、只留 ▾，
 *        ▾ 在 ≤ 600px 时 24px。
 */
function queueProblems(c, w, foldAt = 400) {
  const problems = [];
  if (w <= foldAt) {
    if (c.queue) problems.push('"Queue" not folded');
  } else {
    problems.push(...sendButtonProblems(c.queue, w, { word: 'Queue', tip: 'Queue for later (Enter)', size: 32 }));
  }
  if (!c.toggle || c.toggle.name !== 'More send options') problems.push('no "More send options"');
  else if (w <= 600 && Math.abs(c.toggle.width - 24) > 0.5) problems.push(`▾ ${at1(c.toggle.width)}px`);
  return problems;
}

/**
 * @brief 圆环和发送组（models.md"窄栏"、chat.md 的状态表）："Send" / "Stop" / "Queue" > 600px 带文字，≤ 600px 只有图标
 *        （各 32px，≤ 340px 时"Send"、"Stop"和准备中的"Queue" 28px），▾ 24px；生成中有字、≤ 400px 时"Queue"收起；
 *        准备中有字时是单个"Queue"（.queue-button，没有 ▾，≤ 400px 也在）；拒绝启动时"Send"是 disabled。
 *        协作模式下后台有 Agent 时（teamRunning、teamTyped）"Stop"前有 Stop team（> 760px 带字，更窄时只有图标、同"Stop"
 *        的大小，悬停"Stop all agents in this session"）；teamTyped ≤ 520px 时"Queue"收起、只留 ▾，≤ 340px 时整组收起；
 *        别的状态没有 Stop team。
 */
export function sendProblems({ width: w, controls: c }, state) {
  const problems = [...ringProblems(c, state)];
  const small = w <= 340 ? 28 : 32;
  const team = state === 'teamRunning' || state === 'teamTyped';
  if (state === 'idle' || state === 'blocked') {
    problems.push(...sendButtonProblems(c.send, w, { word: 'Send', tip: 'Send (Enter)', size: small }));
    if (state === 'blocked' && c.send && !c.send.disabled) problems.push('"Send" is not disabled');
  }
  if (['running', 'typed', 'preparing', 'prepTyped'].includes(state) || team) {
    problems.push(...sendButtonProblems(c.stop, w, { word: 'Stop', tip: 'Stop response (Esc)', size: small }));
  }
  if (team) {
    problems.push(...sendButtonProblems(c.stopTeam, w, { word: 'Stop team', tip: 'Stop all agents in this session',
      size: small, textAbove: 760 }));
  } else if (c.stopTeam) problems.push('Stop team shown');
  if (state === 'typed') problems.push(...queueProblems(c, w));
  if (state === 'teamTyped' && w > 340) problems.push(...queueProblems(c, w, 520));
  if (state === 'teamTyped' && w <= 340 && (c.toggle || c.queue)) problems.push('"Queue ▾" not folded for Stop team');
  if (state === 'prepTyped') {
    problems.push(...sendButtonProblems(c.queueOne, w, { word: 'Queue', tip: 'Queue for later (Enter)', size: small }));
    if (c.toggle || c.queue) problems.push('the preparing "Queue" has a ▾');
  }
  return problems;
}

/**
 * @brief 截短的先后（models.md"放不下"，composer-pickers.md"新加的检查"第 3 条）：截短的都有"…"；范围按钮被挤得截短
 *        （比 200px 的上限窄）时不能发送的说明已在最窄；范围按钮里 .range-scope 截短时 .range-model 已收完（宽 0）；模式名截短时范围按钮已在最窄（差 1px
 *        以内）；Effort 截短时范围按钮和权限都在最窄；宽于 400px 时模式名不截；模式名至少看得见开头两个字母；说明截短时
 *        悬停是全文。
 */
export function truncProblems({ width: w, frame, controls: c, texts: t }) {
  const cut = (fact) => Boolean(fact) && fact.width < fact.full - 0.01;
  const atLeast = (kind, button) => !button || button.width <= least(kind, w) + 1;
  const problems = [];
  for (const key of ['permission', 'scope', 'model', 'thinking', 'wait']) {
    if (cut(t[key]) && !t[key].ellipsis) problems.push(`${key} cut without "…"`);
  }
  // 范围按钮在 200px 的上限时它的字是被上限截的（很长的模型 id 任何宽度都这样），不是挤的，不算先于说明截短
  const squeezed = (cut(t.model) || cut(t.scope)) && (c.model?.width ?? 0) < RANGE_MAX - 0.5;
  if (squeezed && !atLeast('wait', c.wait)) problems.push('range cut before the reason');
  if (cut(t.scope) && t.model && t.model.width > 0.5) problems.push('range name cut before the model id');
  if (cut(t.permission) && !atLeast('model', c.model)) problems.push('mode cut before the range');
  if (cut(t.thinking) && !(atLeast('model', c.model) && atLeast('permission', c.permission))) {
    problems.push('effort cut before the range and the mode');
  }
  if (w > 400 && cut(t.permission)) problems.push('mode cut above 400px');
  if (t.permission && t.lead && t.permission.width < t.lead - 0.5) problems.push('mode shows fewer than two letters');
  if (cut(t.wait) && c.wait.tip[0] !== frame.wait) problems.push('reason cut without its full text in the tip');
  return problems;
}

/** @brief 一栏输入框下面一行不符合 state 状态（KINDS 的键）的地方（空数组为符合）；圆环每栏最多一个。 */
export function rowProblems(pane, state) {
  const kinds = pane.frame.items.map((item) => item.kind).join();
  return [...(kindsMatch(kinds, state, pane.width) ? [] : [`items ${kinds}`]),
    ...(pane.frame.rings > 1 ? ['two rings'] : []), ...fitProblems(pane), ...permissionProblems(pane),
    ...modelProblems(pane), ...effortProblems(pane),
    ...sendProblems(pane, state), ...truncProblems(pane)];
}

/** @brief 一份报告里每一栏顶栏和这一行的问题（state 是一个状态，或从左到右每一栏的状态）。 */
export function paneProblems(report, state) {
  const states = Array.isArray(state) ? state : report.panes.map(() => state);
  return report.panes.map((pane, index) => [...topProblems(pane), ...rowProblems(pane, states[index])]);
}

/**
 * @brief 在会话行上按 Shift+F10，用 ↓ 走到"Open in split view"再 Enter，等分屏、右边那一栏就绪，再等焦点落进焦点所在
 *        一栏的文字框、再等两帧。菜单关上之后会话树才调 focusComposer()（SessionTree.tsx 的 sessionAction）：它等下一帧，
 *        浮层还开着时再等几帧（锁屏时帧被节流，晚得更多）；不等它，调用方接着把焦点放到别处、按键时会被它拉回文字框
 *        （2026-10-24，bandBlocked 的 Tab 顺序偶发为空）。已在界面里的会话只有 focusComposer() 会把焦点放进文字框；
 *        新打开的会话文字框挂载时自带 autoFocus，focusComposer() 在它就绪的同一刻调用，最晚在接着的两帧里落下。
 */
export async function splitOpen(page, file) {
  await rowOf(page, file).first().focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="session-menu"]'), null,
    { timeout: 5000 });
  const labels = await menu.getByRole('menuitem').evaluateAll((items) => items.filter((item) => !item.disabled)
    .map((item) => item.childNodes[0]?.textContent ?? ''));
  for (let index = 0; index < labels.indexOf('Open in split view'); index += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  await page.waitForFunction(() => document.activeElement === document
    .querySelector('.pane-slot[data-focused="true"]:not([hidden]) .composer textarea'), null, { timeout: 10000 });
  await settle(page);
}

/** @brief 显示着的各栏 .chat-pane 的宽度（从左到右，不取整）。 */
export const paneWidths = (page) => page.locator(PANE).evaluateAll((panes) => panes
  .map((pane) => pane.getBoundingClientRect()).sort((a, b) => a.left - b.left).map((rect) => rect.width));

/** @brief 按住分屏中线左右拖 dx（拖出窗口时停在窗口边上），再等两帧。 */
export async function dragSplit(page, dx) {
  const box = await page.locator('[data-resize="split"]').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(200, box.height / 2);
  const width = await page.evaluate(() => innerWidth);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(Math.min(width - 1, Math.max(1, x + dx)), y, { steps: 4 });
  await page.mouse.up();
  await settle(page);
}

/**
 * @brief 分屏时拖中线，让左栏的 .chat-pane 宽 target（差不到 1px 且落在同一档为止，最多拖 6 次）；target 为 Infinity 时拖到
 *        最右（右栏的 .pane-slot 280px、.chat-pane 279px）。返回两栏的宽度。
 */
export async function fitLeft(page, target) {
  if (target === Infinity) {
    await dragSplit(page, 5000);
    return paneWidths(page);
  }
  for (let tries = 0; tries < 6; tries += 1) {
    const [left] = await paneWidths(page);
    const delta = target - left;
    if (Math.abs(delta) < 1 && bandKey(left) === bandKey(target)) break;
    await dragSplit(page, Math.abs(delta) < 1 ? Math.sign(delta) : Math.round(delta));
  }
  return paneWidths(page);
}
