// 界面测试共用的页面操作：发消息、等本轮结束、采样阶段行、读工具卡、打开并填连接表单、打开文件夹。

/**
 * 表单下方"测试连接"的结果（含保存失败和表单校验的提示）开头的样子，ConnectionForm.tsx、state/settings.ts；
 * "Saved"、"Saved, but…"等保存后的提示不算
 */
const TEST_RESULTS = [String.raw`^(Connected|Connection failed|Test cancelled)`,
  String.raw`^(Couldn’t test the connection|Couldn’t save)`, String.raw`^(Enter a valid URL|[\w ]* is required\.$)`];

/** @brief 一个页面上的常用操作。 */
export function pageHelpers(page) {
  const textarea = page.locator('.pane-slot:not([hidden]) .composer textarea');
  return {
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
      const match = /About ([\d,]+) \//.exec(title ?? '');
      return match ? Number(match[1].replace(/,/g, '')) : null;
    },
    /** @brief 填连接表单；apiKey 为 null 时不碰 key 输入框。 */
    async fillConnection({ name, baseUrl, apiKey, modelId, contextWindow }) {
      const form = page.getByTestId('connection-form');
      const inputs = form.locator('input:not([type=checkbox])');
      if (name !== undefined) await inputs.nth(0).fill(name);
      if (baseUrl !== undefined) await inputs.nth(1).fill(baseUrl);
      if (apiKey !== null && apiKey !== undefined) await inputs.nth(2).fill(apiKey);
      if (modelId !== undefined) await inputs.nth(3).fill(modelId);
      if (contextWindow !== undefined) await inputs.nth(4).fill(String(contextWindow));
    },
    /**
     * @brief 打开设置页，在连接卡上点"Edit connection"，等连接表单出现。M6 起设置页先是连接列表（settings.md"列表"），
     *        编辑连接的表单只有名称、服务地址、接口类型、API key 和兼容选项（输入框 0–2 仍是名称、服务地址、key）。
     * @param provider 连接的 provider id（第一个连接是 mori-endpoint）
     */
    async editConnection(provider = 'mori-endpoint') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
      const card = page.locator(`[data-testid="connection-card"][data-provider="${provider}"]`);
      await card.getByRole('button', { name: 'Edit connection' }).click();
      await page.getByTestId('connection-form').waitFor({ timeout: 10000 });
    },
    /**
     * @brief 点了错误卡的"Go to settings"之后：等焦点落到连接表单的 API key 框（最多 timeout 毫秒，等不到也照常返回），
     *        返回焦点所在元素的类型、它在不在连接表单里，以及表单的标题（settings.md 外框："Go to settings"打开
     *        "Edit connection"，焦点在 API key；标题"Edit connection · <连接名>"）。设置页里没有连接表单时 title 为 null。
     */
    async keyFocus(timeout = 5000) {
      await page.waitForFunction(() => document.activeElement
        ?.matches('[data-testid="connection-form"] input[type="password"]'), null, { timeout }).catch(() => {});
      return page.evaluate(() => {
        const el = document.activeElement;
        const form = document.querySelector('[data-testid="settings-page"] [data-testid="connection-form"]');
        return { type: el?.getAttribute('type') ?? null, tag: el?.tagName?.toLowerCase() ?? null,
          inForm: Boolean(el?.closest('[data-testid="connection-form"]')),
          title: form?.closest('.settings-form')?.querySelector('h3')?.textContent ?? null };
      });
    },
    /**
     * @brief 等表单下方出现一条新的结果文字并返回它。
     * @param previous 之前的文字（要等它变化）；test 为真时只认测试连接的结果，跳过中间的"Saved"
     */
    async formMessage(previous = null, { test = false, timeout = 60000 } = {}) {
      await page.waitForFunction(({ old, onlyTest, patterns }) => {
        const text = document.querySelector('[data-testid="form-message"]')?.textContent;
        if (!text || text === old || text.startsWith('Saving')) return false;
        return !onlyTest || patterns.some((pattern) => new RegExp(pattern).test(text));
      }, { old: previous, onlyTest: test, patterns: TEST_RESULTS }, { timeout });
      return page.getByTestId('form-message').innerText();
    },
    /**
     * @brief 把当前会话切到"Allow all"（权限菜单 → Allow all → 确认）。M2 起命令和编辑先要批准，
     *        M0/M1 的测试测的是批准之外的行为，打开会话后先切到 Allow all。
     */
    async allowAll() {
      const pane = page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
      await pane.getByTestId('permission-button').click();
      await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: 'Allow all' }).click();
      await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Allow all' }).click();
      await page.waitForFunction(() => document.querySelector(
        '.pane-slot:not([hidden]) [data-testid="permission-button"]')?.textContent?.includes('Allow all'),
      null, { timeout: 10000 });
    },
    /** @brief 让系统的选文件夹对话框直接返回 folder，再点"Open folder…"。 */
    async openFolder(app, folder) {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, folder);
      await page.getByRole('button', { name: 'Open folder…' }).first().click();
      await page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]').waitFor({ timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('.pane-slot:not([hidden]) [data-testid="not-ready"]'),
        null, { timeout: 30000 });
    },
  };
}
