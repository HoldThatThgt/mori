// 界面测试共用的页面操作：发消息、等本轮结束、采样阶段行、读工具卡、首次启动表单（v1）、设置 → Models 的提供商卡与
// Keys、打开文件夹。v1 的标识见 docs/v1/screens/first-run.md、models-settings.md，界面文字见 docs/v0/ui-strings.md。
// 一键拉取模型（docs/specs/model-discovery.md §6、§13.4）：首次启动、Add provider 与卡上的 Fetch models 都是
// "地址和 key → Fetch models → 在清单里勾选或用 Add a model ID 手填 → 加入"；fetchIn、pickIn、cardAddModels 是三处共用的
// 操作（范围用选择器给出：首次启动表单、Add provider 表单或一张提供商卡）。
// 2026-10-26（负责人走查 M2，first-run.md "测试成功之后：主窗口"）：测试连接成功就关掉首次启动表单、进入主窗口，
// "Connected · …"在主窗口 Open a folder 提示里（CONNECTED）；表单下方没有探针状态了，waitProbes 经进程桥读 models.get。
// 2026-10-26（WP-02）：点 Test connection 之前读表单下方的结果用 textNow（不在时不等，原来白等 Playwright 的默认 30 秒）。

import { sleep } from './lib.mjs';

/** "Open folder…"按钮的名字（侧栏与中栏 Open a folder 提示同一个词） */
export const OPEN_FOLDER = 'Open folder…';

/** 首次启动表单（first-run.md "界面测试用的标识"） */
export const FIRST_RUN_FORM = '[data-testid="connection-form"]';
/** 首次启动测试成功后主窗口 Open a folder 提示里的结果文字（first-run.md "界面测试用的标识"） */
export const CONNECTED = '[data-testid="open-folder"] [data-testid="connected"]';
/** 设置 → Models 的 Add provider 表单（models-settings.md "界面测试用的标识"） */
export const PROVIDER_FORM = '[data-testid="provider-form"]';
/** @brief 一张提供商卡的选择器（卡上的清单在卡里，models-settings.md "卡上的清单"）。 */
export const cardScope = (provider) => `[data-testid="provider-card"][data-provider="${provider}"]`;

/**
 * @brief locator 此刻的 textContent；元素不在时为 null，不等它出现。Playwright 的 innerText 会等元素出现，最多到默认时限
 *        30 秒：首次启动点 Test connection 之前表单下方多半还没有结果，原来那样读就白等 30 秒（2026-10-26 WP-02 查出的
 *        m0-smoke 首次启动两步各约 30 秒）。读 textContent 而不是 innerText：调用方拿它和之后在页面里读到的
 *        textContent 比较（testResult、testConnection），两边要是同一个属性，否则换行与连续空白不同时旧结果会被当成新的。
 */
export async function textNow(locator) {
  if (await locator.count() === 0) return null;
  return locator.first().textContent({ timeout: 1000 }).catch(() => null);
}

/** 拉取之后清单、列表错误与命令失败的原文（§6.1–§6.3）：拉取前先把已有的标为旧的，只认新出现的 */
const FETCH_OUTCOMES = '[data-testid="checklist"], [data-testid="list-error"], [data-testid="form-message"]';

/**
 * @brief 在 scope 里点 Fetch models，等这次拉取的结果（§6.1、§6.5）：清单、列表错误，或命令本身失败的原文。
 *        之前的清单、列表错误与原文先标为旧的（再拉一次时它们会被换掉），只认这次新出现的。
 * @param scope FIRST_RUN_FORM、PROVIDER_FORM 或 cardScope(<provider>)
 * @return { state: 'list' | 'list-error' | 'command', kind: 列表错误的 data-kind（其余为 null）,
 *         text: 显示的文字（前 300 字） }
 */
export async function fetchIn(page, scope, timeout = 60000) {
  await page.evaluate(({ root, outcomes }) => {
    for (const element of document.querySelectorAll(`${root} :is(${outcomes})`)) element.dataset.staleFetch = 'true';
  }, { root: scope, outcomes: FETCH_OUTCOMES });
  await page.locator(`${scope} [data-action="fetch-models"]`).click();
  const handle = await page.waitForFunction((root) => {
    const box = document.querySelector(root);
    if (!box || box.querySelector('[data-testid="fetch-status"][data-state="fetching"]')) return false;
    const fresh = (css) => [...box.querySelectorAll(css)].find((element) => element.dataset.staleFetch !== 'true');
    const text = (element) => element.textContent.replace(/\s+/g, ' ').trim().slice(0, 300);
    const list = fresh('[data-testid="checklist"]');
    if (list) return { state: 'list', kind: null, text: text(list) };
    const error = fresh('[data-testid="list-error"]');
    if (error) return { state: 'list-error', kind: error.dataset.kind, text: text(error) };
    const message = fresh('[data-testid="form-message"]');
    return message ? { state: 'command', kind: null, text: text(message) } : false;
  }, scope, { timeout });
  return handle.jsonValue();
}

/** @brief 清单的一行（服务列出的或手填的，§6.2、§6.4）。 */
const rowIn = (page, scope, id) => page.locator(`${scope} [data-testid="discovered-row"][data-model="${id}"]`);

/**
 * @brief 在 scope 的清单里只勾 specs 里的模型（§6.2–§6.4）：其余勾着的行取消勾选；清单里没有的 id 用 Add a model ID 手填
 *        （加进来就是勾上的）；再按 spec 改这一行的 Context window、Max output、Supports thinking、Image input
 *        （不给的不碰）。拉取之后才能用（fetchIn）。
 * @param specs 模型 id，或 { id, contextWindow, maxTokens, reasoning, image }，按要加入的顺序
 */
export async function pickIn(page, scope, specs) {
  const wanted = specs.map((spec) => (typeof spec === 'string' ? { id: spec } : spec));
  const ids = new Set(wanted.map((spec) => spec.id));
  const picked = await page.locator(`${scope} [data-testid="discovered-row"]`).evaluateAll((rows) => rows
    .filter((row) => row.querySelector('input[name="pick"]')?.checked).map((row) => row.dataset.model));
  for (const id of picked.filter((item) => !ids.has(item))) {
    await rowIn(page, scope, id).locator('input[name="pick"]').uncheck();
  }
  for (const spec of wanted) {
    const row = rowIn(page, scope, spec.id);
    if (await row.count() === 0) {
      await page.locator(`${scope} [data-testid="manual-model"] input[data-field="id"]`).fill(spec.id);
      await page.locator(`${scope} [data-action="add-to-list"]`).click();
      await row.waitFor({ timeout: 5000 });
    } else {
      await row.locator('input[name="pick"]').check();
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      if (spec[field] !== undefined) await row.locator(`input[data-field="${field}"]`).fill(String(spec[field]));
    }
    for (const field of ['reasoning', 'image']) {
      if (spec[field] !== undefined) await row.locator(`input[data-field="${field}"]`).setChecked(spec[field]);
    }
  }
}

/**
 * @brief 卡上的 Fetch models（§6.5）：拉取（用已保存的 key），在卡里的清单只勾 specs（没列出的手填，pickIn），
 *        点"Add N models"（models.addModels），等清单关掉、新模型的行都出现；加入失败时返回清单里的原文。
 * @return { fetch: fetchIn 的结果, error: 加入失败的原文，成功时为 null }
 */
export async function cardAddModels(page, provider, specs, timeout = 20000) {
  const scope = cardScope(provider);
  const fetch = await fetchIn(page, scope);
  await pickIn(page, scope, specs);
  await page.locator(`${scope} [data-action="add-models"]`).click();
  const refs = specs.map((spec) => `${provider}/${typeof spec === 'string' ? spec : spec.id}`);
  const handle = await page.waitForFunction(({ root, want }) => {
    const card = document.querySelector(root);
    const error = card?.querySelector('.card-checklist [data-testid="form-message"]');
    if (error) return { error: error.textContent };
    const rows = want.every((ref) => card?.querySelector(`[data-testid="model-row"][data-model="${ref}"]`));
    return rows && !card.querySelector('.card-checklist') ? { error: null } : false;
  }, { root: scope, want: refs }, { timeout });
  return { fetch, ...(await handle.jsonValue()) };
}

/**
 * 首次启动表单下方"Test connection"的结果（含保存失败）开头的样子，FirstRunForm.tsx、state/settings.ts；
 * 跳过中间的"Saving…"。成功的"Connected · …"不在表单里（表单已关掉），在主窗口的 CONNECTED
 */
const TEST_RESULTS = [String.raw`^(Connected|Connection failed|Failed|Test cancelled)`,
  String.raw`^Couldn[’']t (test the connection|save)`];

/**
 * @brief 档案（models.get 的 profiles 里的一项）的探针状态：verifying / verified / failed / error。
 *        没有档案、探测中，或档案早于 since 时为 verifying；有一步出错没有结果为 error；否则按 tool calling：
 *        verified / failed（还是 unverified 时仍算 verifying）。
 *        重新探测期间 models.get 给的仍是旧档案（modelProfiles.ts profileView，models.get 不带 running），
 *        所以要等一次保存引起的探针时，用 since 认出旧档案：probedAt（探针完成的时刻，ms）早于 since 的算还在验证。
 * @param since 点 Test connection（保存）之前的 Date.now()；0 表示任何档案都算（只用于从未探测过的模型）
 */
export function probeState(profile, since = 0) {
  if (!profile || profile.status === 'probing') return 'verifying';
  if (profile.probedAt === null || profile.probedAt < since) return 'verifying';
  if (profile.status === 'error') return 'error';
  const state = profile.tool_calling.state;
  return state === 'verified' || state === 'failed' ? state : 'verifying';
}

/**
 * @brief 经进程桥读 models.get（只读查询，lib.mjs 的 allowProjectsLive 同样经 window.mori.request），返回 ref 的探针状态
 *        （probeState，since 同它）与档案的 status（ready / error / probing；没有档案时为 null，probing 只在从未完成
 *        探测、正在探测时出现）；ref 为 null 时取第一个提供商的第一个模型（首次启动只有一个提供商，第一个模型就是测试的那个）。
 */
export async function readProbe(page, ref = null, since = 0) {
  const info = await page.evaluate(() => window.mori.request({ type: 'models.get' }));
  const provider = info?.config?.providers?.[0];
  const target = ref ?? (provider?.models?.[0] ? `${provider.id}/${provider.models[0].id}` : null);
  const profile = target ? info?.profiles?.[target] ?? null : null;
  return { ref: target, state: probeState(profile, since), status: profile?.status ?? null };
}

/**
 * @brief 当前显示的会话面板输入框下面一行圆环的上下文用量（token 数，data-tokens；docs/v0/screens/models.md
 *        "界面测试用的标识"）。还没有消息时是 0（data-state="empty"）；刚压缩完（没有 data-tokens）、没有圆环或
 *        分屏时两栏都有圆环（分不出是哪一栏）时为 null。2026-10-21 前读顶栏用量的悬停说明"About X / Y tokens"，
 *        现在悬停是"Context ≈ 15.4k / 128k (12%)"，不再读它。
 */
async function usageTokens(page) {
  const ring = page.locator('.pane-slot:not([hidden]) [data-testid="composer"] .composer-bottom [data-testid="usage"]');
  const tokens = await ring.getAttribute('data-tokens', { timeout: 5000 }).catch(() => null);
  return tokens === null ? null : Number(tokens);
}

/**
 * @brief 把当前会话切到"Allow all"（权限菜单 → Allow all → 确认）。M2 起命令和编辑先要批准，
 *        M0/M1 的测试测的是批准之外的行为，打开会话后先切到 Allow all。2026-10-21 起权限按钮在输入框下面一行的左端
 *        （approval.md"权限菜单"），只在这一行里找它。
 */
async function allowAll(page) {
  const row = page.locator('.pane-slot:not([hidden]) [data-testid="composer"] .composer-bottom');
  await row.getByTestId('permission-button').click();
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: 'Allow all' }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Allow all' }).click();
  await page.waitForFunction(() => document.querySelector('.pane-slot:not([hidden]) [data-testid="composer"] '
    + '.composer-bottom [data-testid="permission-button"]')?.textContent?.includes('Allow all'),
  null, { timeout: 10000 });
}

/** @brief 一个页面上的常用操作。 */
export function pageHelpers(page) {
  const textarea = page.locator('.pane-slot:not([hidden]) .composer textarea');
  const h = {
    textarea,
    async send(text, key = 'Enter') {
      await textarea.fill(text);
      await textarea.press(key);
    },
    /** @brief 等本轮开始（或发送失败出现错误卡），再等它结束。 */
    async idle(timeout = 180000) {
      await page.waitForFunction(() => {
        const pane = document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
        return pane?.dataset.running === 'true' || document.querySelectorAll('[data-testid="error-card"]').length > 0;
      }, null, { timeout: 20000 }).catch(() => {});
      await page.waitForFunction(() => {
        const pane = document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
        return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
          && !document.querySelector('[data-testid="stage"]');
      }, null, { timeout });
    },
    /** @brief 每 40ms 采样阶段行文字（去掉秒数），变化才记录。 */
    async sampleStages() {
      await page.evaluate(() => {
        window.__stages = [];
        clearInterval(window.__stageTimer);
        window.__stageTimer = setInterval(() => {
          const text = document.querySelector('[data-testid="stage"]')?.textContent?.replace(/\s\d+(\.\d+)?s$/, '');
          if (text && window.__stages.at(-1) !== text) window.__stages.push(text);
        }, 40);
      });
    },
    stages: () => page.evaluate(() => window.__stages),
    /** @brief 用 MutationObserver 记下思考块是否展开过（展开可能只持续几十毫秒，轮询抓不到）。 */
    async watchThinking() {
      await page.evaluate(() => {
        window.__thinkingOpened = false;
        window.__thinkingObserver?.disconnect();
        window.__thinkingObserver = new MutationObserver(() => {
          if (document.querySelector('details.thinking[open]')) window.__thinkingOpened = true;
        });
        window.__thinkingObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
      });
    },
    thinkingOpened: () => page.evaluate(() => window.__thinkingOpened),
    cards: () => page.getByTestId('tool-card').evaluateAll((cards) => cards.map((card) => ({
      title: card.querySelector('.tool-title')?.textContent ?? '', status: card.dataset.status,
      text: card.querySelector('[data-testid="tool-status"]')?.textContent ?? '' }))),
    /** @brief 上下文用量（token 数，见 usageTokens）。 */
    usageTokens: () => usageTokens(page),
    /**
     * @brief 填首次启动表单（v1，docs/v1/screens/first-run.md；model-discovery.md §6.6、§13.4）：先填 Base URL 和
     *        API key；它们改了，或表单还没拉取过时，Fetch models（fetchIn，拉取后改 Base URL 或 key 会回到开始，所以
     *        改了就再拉一次）；之后填 Name、选区域，在清单里只勾要的模型（pickIn：清单里没有的用 Add a model ID 手填）。
     *        不给的字段不碰；apiKey 为 null 时不碰 key 输入框。contextWindow、reasoning 改的是第一个模型那一行。
     * @param modelId 要勾的模型（只有一个时）；models 给出时用 models（模型 id 或 pickIn 的 spec，按勾选顺序）
     * @param zone 网络区域 local / intranet / public（测试一律选 Local，除非要测公网）
     * @return 这次拉取的结果（fetchIn）；没有拉取时为 null
     */
    async fillConnection({ name, baseUrl, apiKey, modelId, models, contextWindow, zone, reasoning }) {
      const form = page.getByTestId('connection-form');
      const field = (label) => form.getByLabel(label, { exact: true });
      const setText = async (label, value) => {
        if ((await field(label).inputValue()) === value) return false;
        await field(label).fill(value);
        return true;
      };
      const urlChanged = baseUrl !== undefined && await setText('Base URL', baseUrl);
      const keyChanged = apiKey !== null && apiKey !== undefined && await setText('API key', apiKey);
      const fetched = await form.locator('[data-testid="checklist"], [data-testid="list-error"]').count() > 0;
      const fetch = urlChanged || keyChanged || !fetched ? await fetchIn(page, FIRST_RUN_FORM) : null;
      if (name !== undefined) await field('Name').fill(name);
      if (zone !== undefined) await form.locator(`input[name="zone"][value="${zone}"]`).check();
      const specs = models ?? (modelId === undefined ? null : [modelId]);
      if (specs) {
        const [first, ...rest] = specs.map((spec) => (typeof spec === 'string' ? { id: spec } : spec));
        const values = Object.fromEntries(Object.entries({ contextWindow, reasoning })
          .filter(([, value]) => value !== undefined));
        await pickIn(page, FIRST_RUN_FORM, [{ ...first, ...values }, ...rest]);
      }
      return fetch;
    },
    /**
     * @brief 首次启动：Base URL 和 API key → Fetch models → 勾模型（默认 fake-coder；合成端点列出两行、类型不明，
     *        默认都不勾，§13.4）→ Name → 区域（默认 Local）→ Test connection → 成功时表单关掉、进入主窗口
     *        （first-run.md "测试成功之后：主窗口"），再等测试的那个模型这次保存引起的探针跑完（waitProbes，经进程桥，
     *        since 取点 Test connection 之前的时刻，之前存下的旧档案不算；规格 §14.4）。
     *        返回测试结果文字（成功时是主窗口 Open a folder 提示里的"Connected · …"，否则是表单里的原文）、是否成功、
     *        探针状态（probeState 的取值）、这次拉取的结果和 typed：勾着的行里用 Add a model ID 手填的模型 id
     *        （服务没列出，行上标"Entered by you"，§6.4；在点 Test connection 之前读，成功后表单就不在了）。
     *        名称默认 "Mori endpoint"，生成的提供商 id 为 mori-endpoint（同 v0 的连接 id，现有测试的模型全名不变）。
     */
    async firstRun({ name = 'Mori endpoint', baseUrl, apiKey, modelId = 'fake-coder', models, zone = 'local',
      contextWindow, reasoning, probeTimeout = 180000 } = {}) {
      const form = page.getByTestId('connection-form');
      await form.waitFor({ timeout: 60000 });
      const fetch = await h.fillConnection({ name, baseUrl, apiKey, modelId, models, zone, contextWindow, reasoning });
      const typed = await form.locator('[data-testid="discovered-row"]').evaluateAll((rows) => rows
        .filter((row) => row.querySelector('input[name="pick"]')?.checked
          && row.querySelector('[data-testid="row-tag"][data-kind="entered"]')).map((row) => row.dataset.model));
      const previous = await textNow(form.getByTestId('form-message'));
      const since = Date.now();
      await form.locator('[data-action="test"]').click();
      const text = await h.testResult(previous, 180000);
      const ok = text.startsWith('Connected');
      const probe = ok ? await h.waitProbes(since, probeTimeout) : null;
      return { ok, text, probe, fetch, typed };
    },
    /**
     * @brief 等首次启动"Test connection"的结果：成功时首次启动表单关掉，返回主窗口 Open a folder 提示里的
     *        "Connected · …"（CONNECTED）；测试失败、已取消与保存失败时表单留着，返回表单里新出现的结果文字
     *        （不同于 previous，跳过"Saving…"）。
     */
    async testResult(previous = null, timeout = 180000) {
      await page.waitForFunction(({ connected, form, old, patterns }) => {
        if (document.querySelector(connected)) return true;
        const text = document.querySelector(`${form} [data-testid="form-message"]`)?.textContent;
        if (!text || text === old || text.startsWith('Saving')) return false;
        return patterns.some((pattern) => new RegExp(pattern).test(text));
      }, { connected: CONNECTED, form: FIRST_RUN_FORM, old: previous, patterns: TEST_RESULTS }, { timeout });
      const connected = page.locator(CONNECTED);
      if (await connected.count() > 0) return connected.innerText();
      return page.locator(`${FIRST_RUN_FORM} [data-testid="form-message"]`).innerText();
    },
    /**
     * @brief 只走流程的首次启动（M1 已测过表单）：同 firstRun，测试失败或探针没有验证通过时报错；之后等主窗口的
     *        Open a folder 提示（data-testid="open-folder"，"Open folder…"在里面）。
     *        model-discovery.md §13.4：这次 Fetch models 必须拿到列表、勾的模型必须是服务列出的（不是手填的），否则报错
     *        （对的 key 拉取失败时不悄悄改成手填）。
     */
    async setupFirstRun(options) {
      const run = await h.firstRun(options);
      if (!run.ok || run.probe !== 'verified') throw new Error(`first run: ${run.text}; probe ${run.probe}`);
      if (run.fetch && run.fetch.state !== 'list') {
        throw new Error(`first run: Fetch models gave ${run.fetch.state} ${run.fetch.kind ?? ''}: ${run.fetch.text}`);
      }
      if (run.typed.length > 0) throw new Error(`first run: not listed by the server, typed: ${run.typed.join(', ')}`);
      await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
      return run;
    },
    /**
     * @brief 等首次启动测试的那个模型（ref 为 null 时是第一个提供商的第一个模型，readProbe）这次保存引起的探针跑完：
     *        每 500ms 经进程桥读一次 models.get，直到 probeState 不是 verifying 或超时；返回最后读到的状态（超时时为
     *        verifying）。2026-10-26 起首次启动表单下方没有探针状态（first-run.md），不再读页面。
     * @param since 点 Test connection 之前的 Date.now()：保存会重新探测勾选的模型，这之前完成的旧档案（例如先用错的
     *        key 保存时存下的 error）算还在验证
     */
    async waitProbes(since, timeout = 180000, ref = null) {
      const deadline = Date.now() + timeout;
      let probe = await readProbe(page, ref, since);
      while (probe.state === 'verifying' && Date.now() < deadline) {
        await sleep(500);
        probe = await readProbe(page, ref, since);
      }
      return probe.state;
    },
    /** @brief 打开设置页的 Models 分节（规格 §9.1），等它读完。 */
    async openModels() {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
      await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
      await page.getByTestId('models-section').waitFor({ timeout: 15000 });
    },
    /** @brief 设置 → Models 的提供商卡（provider id）。 */
    providerCard: (provider = 'mori-endpoint') => page
      .locator(`[data-testid="provider-card"][data-provider="${provider}"]`),
    /** @brief 卡上的 Fetch models → 勾选或手填 → Add N models（cardAddModels，§6.5）。 */
    addModels: (specs, provider = 'mori-endpoint') => cardAddModels(page, provider, specs),
    /** @brief 在提供商卡的 Keys 里 Add key：填 Secret（Label 用默认），Save，等新行出现；返回新行数。 */
    async addKey(secret, provider = 'mori-endpoint') {
      const card = h.providerCard(provider);
      const before = await card.getByTestId('key-row').count();
      await card.locator('[data-action="add-key"]').click();
      const form = card.getByTestId('key-form');
      await form.getByLabel('Secret').fill(secret);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(({ id, count }) => document.querySelectorAll(
        `[data-testid="provider-card"][data-provider="${id}"] [data-testid="key-row"]`).length > count,
      { id: provider, count: before }, { timeout: 15000 });
      return card.getByTestId('key-row').count();
    },
    /**
     * @brief 等表单下方出现一条新的结果文字并返回它（首次启动表单的 form-message）。测试连接成功时表单会关掉，
     *        成功的结果要用 testResult 等；这里只用于结果留在表单上的情形（失败、已取消、保存失败）。
     * @param previous 之前的文字（要等它变化）；test 为真时只认测试连接的结果与保存失败，跳过中间的"Saving…"
     */
    async formMessage(previous = null, { test = false, timeout = 60000 } = {}) {
      await page.waitForFunction(({ old, onlyTest, patterns }) => {
        const text = document.querySelector('[data-testid="form-message"]')?.textContent;
        if (!text || text === old || text.startsWith('Saving')) return false;
        return !onlyTest || patterns.some((pattern) => new RegExp(pattern).test(text));
      }, { old: previous, onlyTest: test, patterns: TEST_RESULTS }, { timeout });
      return page.getByTestId('form-message').innerText();
    },
    /** @brief 把当前会话切到"Allow all"（见 allowAll）。 */
    allowAll: () => allowAll(page),
    /** @brief 让系统的选文件夹对话框直接返回 folder，再点"Open folder…"。 */
    async openFolder(app, folder) {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, folder);
      await page.getByRole('button', { name: OPEN_FOLDER }).first().click();
      await page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]').waitFor({ timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('.pane-slot:not([hidden]) [data-testid="not-ready"]'),
        null, { timeout: 30000 });
    },
  };
  return h;
}
