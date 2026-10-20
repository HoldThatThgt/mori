// M6 测试（m6-app-*.mjs、m6-replay.mjs、m6-real.mjs）共用的准备与页面操作：合成端点、首次启动填连接并打开项目、
// 设置页（连接卡、模型行、AGENTS.md）、工具页的分节、顶栏的模型和思考菜单、"/"补全列表。
// 只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。标识见 docs/v0/screens/settings.md、models.md、tools.md、slash.md。

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { appRoot, sleep } from './lib.mjs';
import { PANE, paneOf, stubFolder, waitReady } from './m3-helpers.mjs';

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
 * @brief 首次启动：填连接表单、测试连接，再打开 project（系统对话框换成直接返回它）。
 *        trust 为 true / false 时在信任询问里选"信任" / "不信任"；undefined 表示不会问。
 */
export async function firstRunAndOpen(ctx, { name = '合成端点', baseUrl, apiKey, modelId = 'fake-coder', project,
  trust }) {
  const { app, page, h } = ctx;
  await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
  await h.fillConnection({ name, baseUrl, apiKey, modelId });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  await openProject(ctx, project, trust);
}

/** @brief 打开一个项目文件夹（"打开文件夹…"）；trust 同 firstRunAndOpen。 */
export async function openProject(ctx, project, trust) {
  const { app, page } = ctx;
  await stubFolder(app, project);
  await page.getByRole('button', { name: '打开文件夹…' }).first().click();
  if (trust !== undefined) {
    const dialog = page.getByTestId('trust-dialog');
    await dialog.waitFor({ timeout: 15000 });
    await dialog.getByRole('button', { name: trust ? '信任' : '不信任', exact: true }).click();
  }
  await waitReady(page);
}

/** @brief 当前显示的会话面板（分屏时焦点所在的一栏）。 */
export const focusedPane = (page) => page.locator('.pane-slot[data-focused="true"]:not([hidden]) [data-testid="chat-pane"]')
  .or(page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]')).first();

/** @brief 打开设置页并切到某一节（connections / agents）。 */
export async function openSettingsSection(page, section = 'connections') {
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator(`[data-testid="settings-nav"] button[data-section="${section}"]`).click();
}

/** @brief 设置页的连接卡（provider id）。 */
export const connectionCard = (page, provider) => page.locator(`[data-testid="connection-card"][data-provider="${provider}"]`);
/** @brief 设置页的模型行（provider/id）。 */
export const modelRow = (page, ref) => page.locator(`[data-testid="model-row"][data-model="${ref}"]`);

/** @brief 打开工具页并切到某一节（builtin / skills / mcp / plugins），等读取结束。 */
export async function openToolsSection(page, section) {
  if (!(await page.getByTestId('tools-page').isVisible().catch(() => false))) await page.getByTestId('nav-tools').click();
  await page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  await page.locator(`[data-testid="tools-page"] button[data-section="${section}"]`).first().click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="tools-page"]')?.textContent?.includes('正在读取…'),
    null, { timeout: 30000 });
}

/** @brief 在当前一栏的顶栏打开模型菜单，选 ref（provider/id），等按钮显示新模型。 */
export async function chooseModel(page, ref) {
  const pane = focusedPane(page);
  await pane.getByTestId('model-button').click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-model="${ref}"]`).click();
  await page.waitForFunction((id) => document.querySelector('.pane-slot:not([hidden]) [data-testid="model-button"]')
    ?.textContent?.includes(id), ref.split('/').pop(), { timeout: 15000 });
}

/** @brief 在当前一栏的顶栏打开思考菜单，选 level，等按钮的 data-level 变过去。 */
export async function chooseThinking(page, level) {
  const pane = focusedPane(page);
  await pane.getByTestId('thinking-button').click();
  await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction((want) => document.querySelector('.pane-slot:not([hidden]) [data-testid="thinking-button"]')
    ?.dataset.level === want, level, { timeout: 15000 });
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
 * @param kind model / thinking：当前一栏顶栏按钮的文字或 data-level 和 aria-disabled；agents：AGENTS.md 一节的
 *        "正在读取…"、编辑框是否不可用、旁边的一行；modelForm：模型表单"保存"按钮的文字和是否不可用
 */
export async function watchStates(page, kind) {
  await page.evaluate(({ which, pane }) => {
    const button = (id) => document.querySelector(`${pane} [data-testid="${id}"]`);
    const agents = () => {
      const section = document.querySelector('.settings-section[data-section="agents"]');
      if (!section) return null;
      const loading = section.querySelector('.agents-user > p[role="status"]')?.textContent ?? '';
      const editor = document.querySelector('[data-testid="agents-editor"]');
      return `${loading}|${editor?.disabled}|${section.querySelector('.agents-status')?.textContent ?? ''}`;
    };
    const snapshots = {
      model: () => button('model-button') && `${button('model-button').textContent}|`
        + `${button('model-button').getAttribute('aria-disabled')}`,
      thinking: () => button('thinking-button') && `${button('thinking-button').dataset.level}|`
        + `${button('thinking-button').getAttribute('aria-disabled')}`,
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

/** @brief 当前一栏的面板宽度和顶栏模型、思考按钮此刻的样子（是否显示、宽度、▾ 是否显示、文字、读屏名称）。 */
export function topbarState(page) {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const visible = (el) => Boolean(el) && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
    const icon = (el) => [...(el?.querySelectorAll('svg') ?? [])].some(visible);
    const model = pane?.querySelector('[data-testid="model-button"]');
    const thinking = pane?.querySelector('[data-testid="thinking-button"]');
    return { pane: Math.round(pane?.getBoundingClientRect().width ?? 0), model: visible(model),
      thinking: visible(thinking), modelWidth: Math.round(model?.getBoundingClientRect().width ?? 0),
      modelIcon: icon(model), thinkingIcon: icon(thinking), thinkingText: thinking?.innerText.trim() ?? null,
      thinkingName: thinking?.getAttribute('aria-label') ?? null, level: thinking?.dataset.level ?? null,
      reasoning: thinking?.dataset.reasoning ?? null };
  }, PANE);
}

/** @brief 点开 buttonId 的菜单，返回菜单是不是整个在会话面板里（按钮不显示时为 null）；之后 Esc 关上。 */
export async function menuInside(page, buttonId, menuId) {
  if (!(await paneOf(page).getByTestId(buttonId).isVisible())) return null;
  await paneOf(page).getByTestId(buttonId).click();
  await page.getByTestId(menuId).waitFor({ timeout: 5000 });
  const inside = await page.evaluate(({ selector, id }) => {
    const pane = document.querySelector(selector).getBoundingClientRect();
    const box = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
    return box.left >= pane.left - 1 && box.right <= pane.right + 1;
  }, { selector: PANE, id: menuId });
  await page.keyboard.press('Escape');
  await menuGone(page, menuId);
  return inside;
}
