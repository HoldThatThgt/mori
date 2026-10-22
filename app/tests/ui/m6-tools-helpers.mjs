// m6-app-tools.mjs 用的工具页读取（docs/v0/screens/tools.md 的标识）：外框、内置工具、技能、MCP、插件各节的行。
// 只读页面，不记录检查结果（检查结果由调用方记录）。

/** @brief 工具页的外框：分节、当前分节、跟随的会话、说明、信任说明、整页文字；不在工具页时为 null。 */
export function toolsHead(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="tools-page"]');
    if (!root) return null;
    const text = (element) => element?.textContent?.trim() ?? '';
    return {
      sections: [...root.querySelectorAll('[data-testid="tools-nav"] button[data-section]')]
        .map((b) => b.dataset.section),
      current: root.querySelector('[data-testid="tools-nav"] [aria-current="page"]')?.dataset.section ?? null,
      follow: text(root.querySelector('[data-testid="tools-follow"]')),
      notice: text(root.querySelector('.tools-notice span')),
      newSession: [...root.querySelectorAll('.tools-notice button')].some((b) => b.textContent.includes('New session')),
      trust: text(root.querySelector('[data-testid="tools-trust"]')) || null,
      title: text(root.querySelector('.topbar .chat-title')),
      back: [...root.querySelectorAll('.topbar button')].some((b) => b.textContent.includes('Back to app')),
      text: root.innerText,
    };
  });
}

/** @brief "Skills"一节的行（开关：aria-checked、是否不可用）。 */
export function skillRows(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    const sw = (row) => row.querySelector('[role="switch"]');
    return [...document.querySelectorAll('[data-testid="skill-row"]')].map((row) => ({
      name: row.dataset.name, scope: row.dataset.scope, tag: text(row.querySelector('.tools-tag')),
      desc: text(row.querySelector('.tools-row-desc')), off: row.classList.contains('off'),
      checked: sw(row)?.getAttribute('aria-checked') === 'true', disabled: sw(row)?.disabled ?? null,
      notes: [...row.querySelectorAll('.tools-row-note')].map(text),
      error: text(row.querySelector('.form-message.error')),
    }));
  });
}

/** @brief "Built-in tools"一节的行。 */
export function toolRows(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    return [...document.querySelectorAll('[data-testid="tool-row"]')].map((row) => ({
      name: row.dataset.tool, active: row.dataset.active, tag: text(row.querySelector('.tools-tag')),
      state: text(row.querySelector('.tools-state')), desc: text(row.querySelector('.tools-row-desc')) }));
  });
}

/**
 * @brief "MCP"一节的行。process 是进程状态那一行（tools.md"进程状态"）：data-state、状态文字（里面的 p）、
 *        是不是警示色（tools-warn 类，和 p 实际显示的颜色 color）、是不是紧接在命令行（.tools-mono）下面、
 *        "Full error"（details.tools-full-notice 的 summary、是否展开和 pre 的原文；没有时为 null）、这一行里任何地方
 *        有没有"Full error"几个字（fullWord）；没有这一行时为 null。
 *        errorColor 是行下面 pi 通知原文（mcp-error 的第一行）实际显示的颜色（警示色的参照；没有时为 null）。
 *        warn 是行里全部警示色的文字（进程状态失败时也算在里面）。
 */
export function mcpRows(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    const color = (element) => (element ? getComputedStyle(element).color : null);
    const sw = (row) => row.querySelector('[role="switch"]');
    const fullText = (details) => (details ? { summary: text(details.querySelector('summary')), open: details.open,
      pre: details.querySelector('pre')?.textContent ?? null } : null);
    const processLine = (line) => (line ? { state: line.dataset.state, text: text(line.querySelector(':scope > p')),
      warn: line.classList.contains('tools-warn'), color: color(line.querySelector(':scope > p')),
      afterCommand: line.previousElementSibling?.classList.contains('tools-mono') ?? false,
      full: fullText(line.querySelector(':scope > details.tools-full-notice')),
      fullWord: line.textContent.includes('Full error') } : null);
    return [...document.querySelectorAll('[data-testid="mcp-row"]')].map((row) => ({
      process: processLine(row.querySelector('[data-testid="mcp-process"]')),
      errorColor: color(row.querySelector('[data-testid="mcp-error"] > p')),
      name: row.dataset.server, scope: row.dataset.scope, tags: [...row.querySelectorAll('.tools-tag')].map(text),
      problem: text(row.querySelector('[data-testid="mcp-problem"]')),
      off: row.classList.contains('off'),
      checked: sw(row)?.getAttribute('aria-checked') === 'true', disabled: sw(row)?.disabled ?? null,
      command: text(row.querySelector('.tools-mono')), tools: text(row.querySelector('[data-testid="mcp-tools"]')),
      error: [...row.querySelectorAll('[data-testid="mcp-error"] > p')].map(text),
      fullNotice: Boolean(row.querySelector('[data-testid="mcp-error"] details')),
      warn: [...row.querySelectorAll('.tools-warn')].map(text).join(' | '),
      direct: Boolean(row.querySelector('[data-testid="mcp-direct"]')),
      notes: [...row.querySelectorAll('.tools-row-note:not([data-testid])')].map(text),
      buttons: [...row.querySelectorAll('.tools-row-actions button')]
        .map((b) => ({ text: text(b), disabled: b.disabled })),
    }));
  });
}

/** @brief "Plugins"一节的卡。 */
export function packageCards(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    const sw = (row) => row.querySelector('[role="switch"]');
    return [...document.querySelectorAll('[data-testid="package-card"]')].map((card) => ({
      source: card.dataset.source, tag: text(card.querySelector('.tools-card-head .tools-tag')),
      root: text(card.querySelector(':scope > .tools-mono')),
      groups: [...card.querySelectorAll('.tools-group h3')].map(text),
      actions: [...card.querySelectorAll('.tools-card-head button')]
        .map((b) => ({ text: text(b), disabled: b.disabled })),
      resources: [...card.querySelectorAll('[data-testid="package-resource"]')].map((row) => ({
        kind: row.dataset.kind, path: row.dataset.path, name: text(row.querySelector('.tools-row-name')),
        tags: [...row.querySelectorAll('.tools-tag')].map(text),
        checked: sw(row)?.getAttribute('aria-checked') === 'true',
        disabled: sw(row)?.disabled ?? null })),
    }));
  });
}
