// m6-app-tools.mjs 用的工具页读取（docs/v0/screens/tools.md 的标识）：外框、内置工具、技能、MCP、插件各节的行，
// 以及记下有没有出现过读取中、读取失败、跟随的会话还在打开中的 watchTools / toolsSeen（2026-10-26 从 m6-app-tools.mjs
// 挪来，那个文件不超过 2000 行；同样挪来的还有键盘的焦点与 Tab：focusDescriptor、tabWalk，小于 12px 的字：toolsSmallText，
// 和 canon）、Instructions 一节的项目一栏（agentsLoaded）。只读页面，不记录检查结果（检查结果由调用方记录）。

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

/**
 * @brief "Built-in tools"一节的行。name、active、tag、state、desc 是 v0 起就有的五项（TB-03 与对照构建比较的只有它们，
 *        v0Fields）；2026-10-26（WP-08）加：开关 checked、disabled、label（读屏名称；没有开关的行三项都是 null），
 *        行下面的说明 notes（.tools-row-note，按顺序），写入失败的原文 error（没有时为空串）。
 */
export function toolRows(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? '';
    return [...document.querySelectorAll('[data-testid="tool-row"]')].map((row) => {
      const sw = row.querySelector('[role="switch"]');
      return { name: row.dataset.tool, active: row.dataset.active, tag: text(row.querySelector('.tools-tag')),
        state: text(row.querySelector('.tools-state')), desc: text(row.querySelector('.tools-row-desc')),
        checked: sw ? sw.getAttribute('aria-checked') === 'true' : null, disabled: sw ? sw.disabled : null,
        label: sw?.getAttribute('aria-label') ?? null, notes: [...row.querySelectorAll('.tools-row-note')].map(text),
        error: text(row.querySelector('.form-message.error')) };
    });
  });
}

/** @brief toolRows 的一行里 v0 起就有的五项（TB-03 与没有 TaskBoard 的对照构建比较的部分）。 */
export const v0Fields = ({ name, active, tag, state, desc }) => ({ name, active, tag, state, desc });

/** 内置工具一节标题下的说明（tools.md"内置工具"；2026-10-26 加最后一句） */
export const BUILTIN_LEAD = 'All tools in this session. Only enabled tools are available to the model. '
  + 'Switches apply to new sessions.';
/** pi 的 8 个内置工具（各有开关）与 pi 默认启用的 4 个（没写 defaultTools 时） */
export const PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
export const PI_DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write'];
/** Mori 的 TaskBoard 工具（docs/specs/parallel-agents-taskboard.md §6.3） */
const TASKBOARD_TOOLS = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit',
  'request_update', 'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close'];
/** 没有开关的行下面的原因（tools.md"内置工具"最后一行） */
export const TOOL_REASONS = {
  task: 'Mori turns this on and off with Task mode.',
  memory: 'Mori turns this on for the main agent.',
  subagent: 'Mori turns this on when Task mode is off.',
  mcp: 'Turn its server on or off in MCP.',
  plugin: 'Turn it on or off in Plugins.',
  extension: 'Set by this extension. To change it, edit the extension file.',
};

/** @brief grep、find 下面的说明（要 rg.exe / fd.exe）；别的工具为 null。agentDir 是界面上写出的 pi 配置目录。 */
export function toolNeeds(name, agentDir) {
  const program = { grep: 'rg.exe', find: 'fd.exe' }[name];
  return program ? `Needs ${program} in ${agentDir}\\bin or on PATH. Mori doesn’t download it.` : null;
}

/**
 * @brief 一行工具下面应有的说明（不含本项目设置的只读原因与写入失败）：pi 内置工具只有 grep、find 有；其余按来源，
 *        Mori 的按工具名（TaskBoard 工具、memory、subagent：docs/specs/subagent.md §2）。
 * @param row toolRows 的一行（name、tag）
 * @param agentDir 界面上写出的 pi 配置目录
 */
export function expectedNotes(row, agentDir) {
  if (row.tag === 'Built-in') return [toolNeeds(row.name, agentDir)].filter(Boolean);
  if (row.tag === 'Mori') {
    if (TASKBOARD_TOOLS.includes(row.name)) return [TOOL_REASONS.task];
    if (row.name === 'subagent') return [TOOL_REASONS.subagent];
    return row.name === 'memory' ? [TOOL_REASONS.memory] : [];
  }
  if (row.tag.startsWith('MCP · ')) return [TOOL_REASONS.mcp];
  if (row.tag.startsWith('Plugin ')) return [TOOL_REASONS.plugin];
  return row.tag.startsWith('Extension ') ? [TOOL_REASONS.extension] : [];
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

/**
 * @brief 开始记录工具页有没有显示过"Loading…"（MutationObserver：只出现一两帧，轮询抓不到），
 *        以及有没有出现过读取失败、"New session"不可用（跟随的会话还在打开中）。
 */
export function watchTools(page) {
  return page.evaluate(() => {
    window.__toolsSeen = { loading: false, error: false, opening: false };
    window.__toolsObserver?.disconnect();
    window.__toolsObserver = new MutationObserver(() => {
      const root = document.querySelector('[data-testid="tools-page"]');
      if (!root) return;
      const seen = window.__toolsSeen;
      if ([...root.querySelectorAll('.tools-empty[role="status"]')].some((p) => p.textContent === 'Loading…')) {
        seen.loading = true;
      }
      if (root.querySelector('[data-testid="tools-error"]')) seen.error = true;
      const button = [...root.querySelectorAll('.tools-notice button')]
        .find((b) => b.textContent.includes('New session'));
      if (button?.disabled) seen.opening = true;
    });
    window.__toolsObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  });
}

/** @brief watchTools 开始之后看到的。 */
export const toolsSeen = (page) => page.evaluate(() => {
  window.__toolsObserver?.disconnect();
  return window.__toolsSeen;
});

/** @brief 焦点所在的元素的简短描述（2026-10-26 从 m6-app-tools.mjs 挪来，那个文件不超过 2000 行）。 */
export function focusDescriptor(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName?.toLowerCase() ?? null, role: el?.getAttribute?.('role') ?? null,
      label: el?.getAttribute?.('aria-label') ?? null, text: (el?.textContent ?? '').trim().slice(0, 40),
      section: el?.dataset?.section ?? null, inTools: Boolean(el?.closest?.('[data-testid="tools-page"]')) };
  });
}

/** @brief 从当前焦点按 Tab count 次，返回每次的焦点（同上，从 m6-app-tools.mjs 挪来）。 */
export async function tabWalk(page, count) {
  const seen = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Tab');
    seen.push(await focusDescriptor(page));
  }
  return seen;
}

/**
 * @brief Instructions 一节（docs/v1/screens/customize-agents-md.md）的项目一栏：标题、每个文件的路径，以及编辑框是否可用；
 *        不在这一节时为 null。
 */
export function agentsLoaded(page) {
  return page.evaluate(() => {
    const loaded = document.querySelector('[data-testid="agents-loaded"]');
    if (!document.querySelector('[data-testid="agents-section"]')) return null;
    return { title: loaded?.querySelector('h3')?.textContent ?? null,
      files: [...(loaded?.querySelectorAll('.agents-files .agents-path') ?? [])].map((el) => el.textContent),
      editable: document.querySelector('[data-testid="agents-editor"]')?.disabled === false };
  });
}

/** @brief 工具页（和开着的移除确认框）里小于 12px 的文字（2026-10-26 从 m6-app-tools.mjs 挪来）。 */
export function toolsSmallText(page) {
  const selector = '[data-testid="tools-page"] *, [data-testid="remove-dialog"] *';
  return page.evaluate((css) => [...document.querySelectorAll(css)]
    .filter((element) => element.getClientRects().length > 0
      && [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12)
    .map((element) => `${element.tagName.toLowerCase()}.${element.className} ${getComputedStyle(element).fontSize} `
      + `"${element.textContent.trim().slice(0, 20)}"`), selector);
}

/** @brief 对象的键排好序之后的值（只比内容、不比键的顺序时用；同上，从 m6-app-tools.mjs 挪来）。 */
export function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]));
}
