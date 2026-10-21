// 界面测试共用的页面操作：发消息、等本轮结束、采样阶段行、读工具卡、首次启动表单（v1）、设置 → Models 的提供商卡与
// Keys、打开文件夹。v1 的标识与文字见 docs/v1/screens/first-run.md、models-settings.md。

/** "打开文件夹…"按钮的名字：首次启动表单上是英文（v1），侧栏与空状态仍是中文 */
export const OPEN_FOLDER = /^(Open folder…|打开文件夹…)$/;

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
    /** @brief 上下文用量（token 数），读不到时为 null。 */
    async usageTokens() {
      const title = await page.getByTestId('usage').getAttribute('title').catch(() => null);
      const match = /约 ([\d,]+) \//.exec(title ?? '');
      return match ? Number(match[1].replace(/,/g, '')) : null;
    },
    /**
     * @brief 填首次启动表单（v1，英文，docs/v1/screens/first-run.md）；不给的字段不碰。apiKey 为 null 时不碰 key 输入框。
     * @param zone 网络区域 local / intranet / public（测试一律选 Local，除非要测公网）
     */
    async fillConnection({ name, baseUrl, apiKey, modelId, contextWindow, zone, reasoning }) {
      const form = page.getByTestId('connection-form');
      const field = (label) => form.getByLabel(label, { exact: true });
      if (name !== undefined) await field('Name').fill(name);
      if (baseUrl !== undefined) await field('Address').fill(baseUrl);
      if (zone !== undefined) await form.locator(`input[name="zone"][value="${zone}"]`).check();
      if (apiKey !== null && apiKey !== undefined) await field('API key').fill(apiKey);
      if (modelId !== undefined) await field('Model id').fill(modelId);
      if (contextWindow !== undefined) await field('Context window').fill(String(contextWindow));
      if (reasoning !== undefined) await form.getByLabel('Supports thinking').setChecked(reasoning);
    },
    /**
     * @brief 首次启动：填表（区域默认 Local）→ Test connection → 成功后等探针都跑完（表单下方的探针状态不再是
     *        verifying，规格 §14.4）。返回测试结果文字、是否成功和探针状态（data-state）。
     *        名称默认 "Mori endpoint"，生成的提供商 id 为 mori-endpoint（同 v0 的连接 id，现有测试的模型全名不变）。
     */
    async firstRun({ name = 'Mori endpoint', baseUrl, apiKey, modelId = 'fake-coder', zone = 'local', contextWindow,
      reasoning, probeTimeout = 180000 } = {}) {
      await page.getByTestId('connection-form').waitFor({ timeout: 60000 });
      await h.fillConnection({ name, baseUrl, apiKey, modelId, zone, contextWindow, reasoning });
      const previous = await page.getByTestId('form-message').innerText().catch(() => null);
      await page.getByTestId('connection-form').locator('[data-action="test"]').click();
      const text = await h.formMessage(previous, { test: true, timeout: 180000 });
      const ok = text.startsWith('Connected');
      const probe = ok ? await h.waitProbes(probeTimeout) : null;
      return { ok, text, probe };
    },
    /**
     * @brief 只走流程的首次启动（M1 已测过表单）：同 firstRun，测试失败或探针没有验证通过时报错；之后等"Open folder…"。
     */
    async setupFirstRun(options) {
      const run = await h.firstRun(options);
      if (!run.ok || run.probe !== 'verified') throw new Error(`first run: ${run.text}; probe-status ${run.probe}`);
      await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
      return run;
    },
    /** @brief 等首次启动表单下方的探针跑完（mori.profiles 里没有这个模型在跑），返回探针状态（data-state）。 */
    async waitProbes(timeout = 180000) {
      await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="probe-status"]')?.dataset.state;
        return state !== undefined && state !== 'verifying';
      }, null, { timeout });
      return page.getByTestId('probe-status').getAttribute('data-state');
    },
    /** @brief 打开设置页的 Models 分节（规格 §9.1），等它读完。 */
    async openModels() {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
      await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
      await page.getByTestId('models-section').waitFor({ timeout: 15000 });
    },
    /** @brief 设置 → Models 的提供商卡（provider id）。 */
    providerCard: (provider = 'mori-endpoint') => page
      .locator(`[data-testid="provider-card"][data-provider="${provider}"]`),
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
     * @brief 等表单下方出现一条新的结果文字并返回它（首次启动表单的 form-message）。
     * @param previous 之前的文字（要等它变化）；test 为真时只认测试连接的结果与保存失败，跳过中间的"Saving…"
     */
    async formMessage(previous = null, { test = false, timeout = 60000 } = {}) {
      await page.waitForFunction(({ old, onlyTest }) => {
        const text = document.querySelector('[data-testid="form-message"]')?.textContent;
        if (!text || text === old) return false;
        return !onlyTest || /^(Connected|Failed|Test cancelled|Couldn't save)/.test(text);
      }, { old: previous, onlyTest: test }, { timeout });
      return page.getByTestId('form-message').innerText();
    },
    /**
     * @brief 把当前会话切到"全部允许"（权限菜单 → 全部允许 → 确认）。M2 起命令和编辑先要批准，
     *        M0/M1 的测试测的是批准之外的行为，打开会话后先切到全部允许。
     */
    async allowAll() {
      const pane = page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
      await pane.getByTestId('permission-button').click();
      await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: '全部允许' }).click();
      await page.getByTestId('confirm-dialog').getByRole('button', { name: '全部允许' }).click();
      await page.waitForFunction(() => document.querySelector(
        '.pane-slot:not([hidden]) [data-testid="permission-button"]')?.textContent?.includes('全部允许'),
      null, { timeout: 10000 });
    },
    /**
     * @brief 让系统的选文件夹对话框直接返回 folder，再点"打开文件夹…"（首次启动表单上是英文的"Open folder…"）。
     */
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
