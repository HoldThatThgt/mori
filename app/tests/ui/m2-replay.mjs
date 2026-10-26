// M2 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的批准会话（tests/fixtures/m2）。
// 测试像你一样操作（Alt+1 / Alt+2、写理由后点"Deny"、理由框里 Enter 或 Esc、权限菜单与确认框、在输入框按 Esc、F8），
// 回放桥核对界面发出的每条命令都与录制时一致；再按 docs/v0/screens/approval.md 与 f8.md 的状态表检查界面。
// 2026-10-21 起权限按钮在输入框下面一行的左端（docs/v0/composer-pickers.md、screens/models.md）：查它的位置、只有文字
// 没有图标、悬停两行和读屏的描述、"Allow all"的颜色和对比度（含会话面板 300px 时）、权限菜单往上打开不出界、
// 从文字框 Tab 的顺序、菜单的键盘、Tab 移出和 F8、生成中这一行不可用的原因，以及 F8 报告"Current view"的
// "Model range""Effort"和"Pane width"。
// 用法（在 app/ 下）：node tests/ui/m2-replay.mjs [--only edit-allow,f8]
// 结果写到 test-results/m2-replay.json；截图在 test-results/m2-replay/。M1 的回放检查仍由 m1-replay.mjs 负责。

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { smallText } from './m1-layout.mjs';
import {
  EFFORT_BUSY, effortTipProblems, f8ViewProblems, MODEL_BUSY, modeProblems, paneFacts, PERMISSION_MENU,
  permissionMenuProblems, permissionState, permissionTipProblems, rangeTipProblems, ROW, rowControls, rowMenuState,
} from './m2-helpers.mjs';
import { pageHelpers } from './page.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-m2');
const fixtureDir = join(appRoot, 'tests/fixtures/m2');
const shots = join(appRoot, 'test-results/m2-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 当前会话面板 */
const P = '.pane-slot:not([hidden]) ';
const PANE = `${P}[data-testid="chat-pane"]`;
const CARD = `${P}[data-testid="approval-card"]`;
// 与 src/shared/protocol.ts 的 READ_ONLY_TOOLS、REJECTED_REASON_PREFIX 相同。
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];
const REJECTED_REASON_PREFIX = 'Rejected by the user. Reason: ';
const COMMAND_TOOLS = ['bash', 'powershell'];
// 平行 Agent 规格 §11.1：权限菜单的说明作用于这个用户会话的全部 Agent。
const MENU_NOTE = 'Applies to all agents in this session. New sessions start at Ask each time.';
const F8_NOTE = 'Includes a screenshot, the current view, and your recent activity. Saved on this computer and never '
  + 'sent to the model.';
const STOPPED_TEXT = 'Stopped · Changes made so far stay as they are';

/** @brief 读取一个 M2 录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
/** @brief 录制里某种事件。 */
const eventsOfType = (fx, type) => fx.steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);
/** @brief 录制里界面发出的命令（session.state 除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (fx) => fx.steps.filter((s) => s.command && s.command.type !== 'session.state')
  .map((s) => s.command);
/** @brief 一个批准请求。 */
const requestFor = (fx, requestId) => eventsOfType(fx, 'mori.approval_request').find((r) => r.requestId === requestId);
/** @brief 某个请求的批准卡。 */
const cardFor = (page, requestId) => page.locator(`${CARD}[data-request="${requestId}"]`);
/** @brief 回放桥收到的命令数。 */
const commandCount = (page) => page.evaluate(() => window.__replay.status.commands.length);
/** @brief 焦点是否在当前会话的输入框里。 */
const composerFocused = (page) => page.evaluate((p) => document.activeElement
  === document.querySelector(`${p}.composer textarea`), P);
/** @brief 焦点所在元素的 data-testid；发送按钮记为 send-button，文字框记为 textarea。 */
const focusedTestId = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (el?.classList.contains('send-button')) return 'send-button';
  return el?.dataset?.testid ?? el?.tagName.toLowerCase() ?? null;
});
/** @brief 焦点所在元素的文字。 */
const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
/** @brief 路径的最后一段。 */
const baseName = (path) => String(path ?? '').split(/[\\/]/).pop();
/** @brief 压掉空白，便于比较界面上的文字。 */
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
/** @brief 界面上带引号的标签：用排版引号 “ ”。 */
const quoted = (label) => `“${label}”`;

/** @brief 工具名在"Allow “…” for this session"和权限菜单里的叫法（approval.md 选项表）。 */
function toolLabel(name) {
  if (COMMAND_TOOLS.includes(name)) return 'Run commands';
  if (name === 'edit') return 'Edit files';
  if (name === 'write') return 'Write files';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** @brief 构建回放页面（与 m1-replay 用不同的输出目录，两者可以同时跑）。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 用 MutationObserver 记下批准卡、阶段行和工具卡状态的每次变化（有的只持续几十毫秒，轮询抓不到）。 */
async function watchApproval(page) {
  await page.evaluate((p) => {
    window.__approvalSamples = [];
    let last = '';
    const sample = () => {
      const pane = document.querySelector(p.trim());
      const card = pane?.querySelector('[data-testid="approval-card"]');
      const stage = pane?.querySelector('[data-testid="stage"]')?.textContent?.replace(/\s\d+(\.\d+)?s$/, '') ?? '';
      const statuses = [...(pane?.querySelectorAll('[data-testid="tool-card"]') ?? [])].map((c) => c.dataset.status);
      const entry = { request: card?.dataset.request ?? null, tool: card?.dataset.tool ?? null, stage,
        running: statuses.filter((s) => s === 'running').length,
        awaiting: statuses.filter((s) => s === 'awaiting').length };
      const key = JSON.stringify(entry);
      if (key !== last) { last = key; window.__approvalSamples.push(entry); }
    };
    window.__approvalObserver?.disconnect();
    window.__approvalObserver = new MutationObserver(sample);
    window.__approvalObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true });
  }, P);
}

/** @brief 测试用的页面操作：共用的 pageHelpers 加上回放页面的载入。 */
function helpers(page) {
  const base = pageHelpers(page);
  return {
    ...base,
    /** @brief 载入录制文件并打开文件夹（session.create），返回录制文件内容。 */
    async load(name, { speed = 2, maxGap = 1500 } = {}) {
      const fx = readFixture(name);
      const url = `${pathToFileURL(join(outDir, 'index.html')).href}?fixture=${name}&speed=${speed}&maxGap=${maxGap}`;
      await page.goto(url);
      await page.getByTestId('open-folder').waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'Open folder…' }).first().click();
      await page.getByTestId('chat-pane').waitFor({ timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('[data-testid="not-ready"]'));
      await watchApproval(page);
      return fx;
    },
    replayErrors: () => page.evaluate(() => window.__replay.status.errors),
    samples: () => page.evaluate(() => window.__approvalSamples),
    toolCards: () => page.locator(`${P}[data-testid="tool-card"]`).evaluateAll((cards) => cards.map((card) => ({
      title: card.querySelector('.tool-title')?.textContent ?? '', status: card.dataset.status,
      text: card.querySelector('[data-testid="tool-status"]')?.textContent ?? '',
      badge: card.querySelector('[data-testid="tool-badge"]')?.textContent ?? '' }))),
  };
}

/** @brief 等回放桥的 status[field] 不小于 value；出现不一致时立即报错。 */
async function untilBridge(page, field, value, what) {
  await page.waitForFunction(({ f, v }) => window.__replay.status[f] >= v || window.__replay.status.errors.length > 0,
    { f: field, v: value }, { timeout: 60000 }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 等会话空闲：本轮结束，输入框可以发送。 */
function untilIdle(page, timeout = 60000) {
  return page.waitForFunction((p) => {
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="not-ready"]');
  }, P, { timeout });
}

/** @brief 按 Alt+数字；focus 为 composer 时先把焦点放进输入框，body 时让焦点离开所有元素。 */
async function altKey(page, h, digit, focus = 'composer') {
  if (focus === 'body') await page.evaluate(() => document.activeElement?.blur?.());
  else await h.textarea.focus();
  await page.keyboard.press(`Alt+${digit}`);
}

/** @brief 拒绝一张卡：先在理由框写理由，再用 way 指定的方式拒绝（click / enter / esc / alt3）。 */
async function rejectCard(page, h, card, reason, way) {
  const input = card.getByTestId('approval-reason');
  if (reason || way !== 'click') await input.fill(reason);
  if (way === 'click') await card.getByTestId('approval-reject').click();
  else if (way === 'enter') await input.press('Enter');
  else if (way === 'esc') await input.press('Escape');
  else await altKey(page, h, 3);
}

/** @brief 打开输入框下面一行的权限菜单（已经开着时直接返回）。 */
async function openMenu(page) {
  const menu = page.getByTestId('permission-menu');
  if (!(await menu.isVisible().catch(() => false))) {
    await page.locator(`${P}${ROW} [data-testid="permission-button"]`).click();
  }
  await menu.waitFor({ timeout: 5000 });
  return menu;
}

/** @brief 在权限菜单里切换；切到全部允许时在确认框里先调用 confirm(dialog)，再点"Allow all"。 */
async function chooseMode(page, mode, confirm) {
  const menu = await openMenu(page);
  await menu.getByRole('menuitemradio', { name: mode === 'all' ? 'Allow all' : 'Ask each time' }).click();
  if (mode !== 'all') return;
  const dialog = page.getByTestId('confirm-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await confirm?.(dialog);
  await dialog.getByRole('button', { name: 'Allow all', exact: true }).click();
}

/** @brief 在权限菜单里 Forget 一项"Allowed for this session"；菜单还开着时用 Esc 关上。 */
async function forgetTool(page, toolName) {
  const menu = await openMenu(page);
  const row = page.getByTestId('permission-allowed').locator('*').filter({ hasText: toolLabel(toolName) })
    .filter({ has: page.getByRole('button', { name: 'Forget' }) }).last();
  await row.getByRole('button', { name: 'Forget' }).click();
  if (await menu.isVisible().catch(() => false)) await page.keyboard.press('Escape');
}

/** @brief 权限菜单的内容：选项与勾选、"Allowed for this session:"的各行、全文。 */
function menuInfo(page) {
  return page.evaluate(() => {
    const menu = document.querySelector('[data-testid="permission-menu"]');
    const allowed = document.querySelector('[data-testid="permission-allowed"]');
    const rows = [...(allowed?.querySelectorAll('button') ?? [])].filter((b) => b.textContent.includes('Forget'))
      .map((b) => b.parentElement.textContent.replace('Forget', '').trim());
    const checked = (label) => [...(menu?.querySelectorAll('[role="menuitemradio"]') ?? [])]
      .find((item) => item.textContent.includes(label))?.getAttribute('aria-checked') ?? null;
    return { open: Boolean(menu), text: menu?.innerText ?? '', rows, ask: checked('Ask each time'),
      all: checked('Allow all') };
  });
}

/** @brief 一条命令之前要等的界面状态：要答复的卡已经出现；不带送达方式的发送要等本轮结束。 */
async function ready(page, command) {
  if (command.type === 'approval.answer') await cardFor(page, command.requestId).waitFor({ timeout: 20000 });
  if (command.type === 'session.prompt' && !command.behavior) await untilIdle(page);
}

/**
 * @brief 做出产生这条命令的用户操作，返回用掉的命令数（停止一次产生 clearQueue 和 abort 两条）。
 * @param hooks.reject(command) 拒绝的方式；hooks.focus(command) 按 Alt+数字前焦点在哪；hooks.confirm(dialog) 见 chooseMode
 */
async function act(page, h, command, next, hooks) {
  switch (command.type) {
    case 'session.prompt':
      if (!command.behavior) {
        await h.send(command.text);
        return 1;
      }
      await h.textarea.focus();
      await page.keyboard.type(command.text);
      await page.keyboard.press(command.behavior === 'steer' ? 'Control+Enter' : 'Enter');
      return 1;
    case 'approval.answer':
      if (command.decision === 'reject') {
        const way = hooks.reject?.(command) ?? 'click';
        await rejectCard(page, h, cardFor(page, command.requestId), command.reason ?? '', way);
      } else {
        await altKey(page, h, command.decision === 'allow' ? 1 : 2, hooks.focus?.(command) ?? 'composer');
      }
      return 1;
    case 'approval.setMode':
      await chooseMode(page, command.mode, hooks.confirm);
      return 1;
    case 'approval.forget':
      await forgetTool(page, command.toolName);
      return 1;
    case 'session.clearQueue':
      if (next?.type !== 'session.abort') throw new Error('clearQueue without abort is not a user action');
      await h.textarea.focus();
      await page.keyboard.press('Escape');
      return 2;
    case 'session.open':
      await page.evaluate(() => window.__replay.exit(1));
      await page.getByRole('button', { name: 'Restart', exact: true }).click();
      await page.getByText('Restarted · ', { exact: false }).first().waitFor({ timeout: 10000 });
      return 1;
    default:
      throw new Error(`No user action produces ${command.type}`);
  }
}

/**
 * @brief 按录制的命令顺序像你一样操作界面，让回放桥收到同样的命令。每条命令前先等回放桥放完它之前的事件。
 * @param hooks.before(command, request) 操作前的检查（approval.answer 时卡片已经出现，request 是对应的请求）
 * @param hooks.acted(command, request) 操作刚做完时的检查；hooks.after(command, request) 这条命令之后的事件放完后的检查
 */
async function drive(page, h, fx, hooks = {}) {
  const commands = commandsOf(fx);
  for (let n = 1; n < commands.length;) {
    const command = commands[n];
    await untilBridge(page, 'played', n, `the events before ${command.type}`);
    await ready(page, command);
    const request = command.requestId ? requestFor(fx, command.requestId) : null;
    await hooks.before?.(command, request);
    n += await act(page, h, command, commands[n + 1], hooks);
    await hooks.acted?.(command, request);
    await untilBridge(page, 'played', n, `the UI to send ${command.type}`);
    await hooks.after?.(command, request);
  }
  await untilIdle(page);
}

/** @brief 读批准卡上的内容（选择器见界面约定）。 */
function cardInfo(card) {
  return card.evaluate((el) => {
    const text = (id) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    const reason = el.querySelector('[data-testid="approval-reason"]');
    return {
      tool: el.dataset.tool, request: el.dataset.request, text: el.innerText,
      title: el.querySelector('[data-testid="approval-title"]')?.innerText ?? el.innerText.split('\n')[0],
      edits: [...el.querySelectorAll('[data-testid="approval-edit"]')].map((e) => ({
        old: e.querySelector('.approval-old')?.textContent ?? '',
        new: e.querySelector('.approval-new')?.textContent ?? '' })),
      content: text('approval-content'), command: text('approval-command'), args: text('approval-args'),
      more: text('approval-more'), allow: text('approval-allow') ?? '',
      allowSession: text('approval-allow-session') ?? '',
      reject: text('approval-reject') ?? '',
      reason: reason && { label: reason.getAttribute('aria-label'), placeholder: reason.getAttribute('placeholder') },
    };
  });
}

/** @brief 卡片标题与参数（approval.md "批准卡"表）；返回不符合的地方。 */
function bodyProblems(info, request) {
  const { toolName, args } = request;
  const problems = info.tool === toolName ? [] : [`data-tool=${info.tool}`];
  const title = (...parts) => {
    if (!parts.every((part) => info.title.includes(part))) problems.push(`title "${info.title}"`);
  };
  if (toolName === 'edit') {
    title('Edit', baseName(args.path));
    const edits = args.edits ?? [];
    const same = info.edits.length === edits.length && edits.every((e, i) => norm(info.edits[i].old)
      .includes(norm(e.oldText)) && norm(info.edits[i].new).includes(norm(e.newText)));
    if (!same) problems.push(`edits ${JSON.stringify(info.edits)}`);
  } else if (toolName === 'write') {
    title('Write', baseName(args.path));
    if (!norm(info.content).includes(norm(args.content))) problems.push(`content "${info.content}"`);
  } else if (COMMAND_TOOLS.includes(toolName)) {
    title('Run a command');
    if (!info.command?.includes(String(args.command).trim())) problems.push(`command "${info.command}"`);
    if (args.timeout && !info.text.includes(`Timeout: ${args.timeout}s`)) problems.push('no timeout');
  } else {
    title(toolLabel(toolName));
    if (info.args === null) problems.push('no formatted args');
  }
  return problems;
}

/** @brief 三个选项、快捷键、"Allow “…” for this session"的说明与理由框（approval.md "选项"表）；返回不符合的地方。 */
function optionProblems(info, request) {
  const label = toolLabel(request.toolName);
  const hint = COMMAND_TOOLS.includes(request.toolName) ? 'You won’t be asked again for any command in this session.'
    : `You won’t be asked again for ${quoted(label)} in this session.`;
  const checks = [
    [/Allow once/.test(info.allow) && /Alt\+1/.test(info.allow), `allow "${info.allow}"`],
    [info.allowSession.includes(`Allow ${quoted(label)} for this session`) && /Alt\+2/.test(info.allowSession),
      `allow-session "${info.allowSession}"`],
    [info.text.includes(hint), `hint "${hint}"`],
    [/Deny/.test(info.reject) && /Alt\+3/.test(info.reject), `reject "${info.reject}"`],
    [info.reason?.label === 'Reason for denying' && info.reason?.placeholder === 'Tell the model why (optional)',
      `reason ${JSON.stringify(info.reason)}`],
  ];
  return checks.filter(([ok]) => !ok).map(([, problem]) => problem);
}

/** @brief 检查一张卡的内容与录制的请求一致，并截图。 */
async function checkCard(page, label, request, name) {
  const info = await cardInfo(cardFor(page, request.requestId));
  const problems = [...bodyProblems(info, request), ...optionProblems(info, request)];
  record(label, problems.length === 0, problems.join('; '));
  await shot(page, name);
  return info;
}

/** @brief 拒绝时工具卡应显示的文字（tool-cards.md "已拒绝"）。 */
function rejectedText(end) {
  if (end.by === 'stop') return 'Denied · You pressed Stop';
  const reason = end.reason?.startsWith(REJECTED_REASON_PREFIX) ? end.reason.slice(REJECTED_REASON_PREFIX.length) : '';
  // 工具卡上的理由超过 40 字时截断加"…"（docs/v0/defaults.md）。
  const shown = [...reason].length > 40 ? `${[...reason].slice(0, 40).join('')}…` : reason;
  return reason ? `Denied · ${shown}` : 'Denied';
}

/**
 * @brief 按录制推出每次调用的工具卡最终状态与标签，按开始执行的顺序（一条回复的调用按顺序执行，与卡片顺序相同）。
 * @param live 实时运行时为真；从会话记录载入的卡没有"Allowed for this session / Allow all"标签
 */
function expectedCards(fx, live) {
  const ends = eventsOfType(fx, 'mori.approval_end');
  const stopAt = fx.steps.findIndex((s) => s.command?.type === 'session.abort');
  return eventsOfType(fx, 'mori.tool_gate').map((gate) => {
    const end = ends.find((e) => e.toolCallId === gate.toolCallId);
    const by = gate.gate === 'ask' ? end?.by : gate.gate;
    const badge = !live ? '' : by === 'session' ? 'Allowed for this session' : by === 'all' ? 'Allow all' : '';
    if (end?.decision === 'reject') return { status: 'rejected', text: rejectedText(end), badge };
    const at = fx.steps.findIndex((s) => s.envelope?.event.type === 'tool_execution_end'
      && s.envelope.event.toolCallId === gate.toolCallId);
    if (!fx.steps[at]?.envelope.event.isError) return { status: 'done', text: null, badge };
    // 你按了停止之后才结束的工具是"Stopped"，否则是"Failed"（tool-cards.md）。
    return { status: stopAt >= 0 && stopAt < at ? 'stopped' : 'failed', text: null, badge };
  });
}

/** @brief 工具卡的最终状态、文字和标签与录制推出的一致。 */
async function checkToolCards(h, fx, label, live = true) {
  const expected = expectedCards(fx, live);
  const cards = (await h.toolCards()).slice(0, expected.length);
  const ok = cards.length === expected.length && cards.every((card, i) => card.status === expected[i].status
    && card.badge === expected[i].badge && (expected[i].text === null || card.text === expected[i].text));
  record(label, ok, `期望 ${JSON.stringify(expected)}；实际 ${JSON.stringify(cards)}`);
}

/** @brief 共同的检查：工具卡状态与标签、等批准时的阶段行、每个请求都出了卡且只读工具不出卡、命令与录制一致。 */
async function commonChecks(page, h, fx) {
  const name = fx.name;
  await checkToolCards(h, fx, `${name}：工具卡的状态与"本会话已允许 / 全部允许"标签和录制一致`);
  const requested = eventsOfType(fx, 'mori.approval_request').map((r) => r.requestId);
  const shown = (await h.samples()).filter((s) => s.request);
  const wrong = shown.filter((s) => s.stage !== 'Waiting for your approval' || s.running > 0 || s.awaiting === 0);
  record(`${name}：等批准时阶段行显示"等你批准"（不显示"生成中"或"执行中"），工具卡"等你批准"`,
    (shown.length > 0 || requested.length === 0) && wrong.length === 0, JSON.stringify(wrong.slice(0, 3)));
  const seen = new Set(shown.map((s) => s.request));
  record(`${name}：每个批准请求都出了卡，没有多余的卡，只读工具不出卡`, requested.every((id) => seen.has(id))
    && [...seen].every((id) => requested.includes(id)) && !shown.some((s) => READ_ONLY_TOOLS.includes(s.tool)),
  `录制 ${requested.join(',')}；出卡 ${[...seen].join(',')}`);
  const errors = await h.replayErrors();
  record(`${name}：回放命令与录制一致`, errors.length === 0, errors.join('; '));
}

/**
 * @brief 生成中（批准卡挂着）输入框下面一行（models.md"不可用时、按钮消失时的焦点"、approval.md"权限菜单"）：权限按钮
 *        仍可用（悬停第二行和读屏的描述"Change the permission mode"）；范围、Effort 按钮不可用（aria-disabled，不是
 *        disabled，没有 data-pending，仍能 Tab 到），悬停第一行仍是全文，原因在范围按钮的第三行、Effort 的第二行，读屏的
 *        描述里没有第一行（范围按钮是"<提供商名>. <原因>"）；圆环在。
 */
async function checkRunningRow(page) {
  const row = await rowControls(page, PANE);
  const problems = [...permissionTipProblems(row.permission, 'ask', null), ...rangeTipProblems(row.model, MODEL_BUSY),
    ...effortTipProblems(row.effort, EFFORT_BUSY), ...(row.usage ? [] : ['no usage ring'])];
  record('edit-allow：生成中（卡挂着）输入框下面一行的权限按钮仍可用；范围、Effort 按钮不可用（aria-disabled，仍能 Tab 到），'
    + '悬停第一行是全文，原因在范围按钮的第三行和 Effort 的第二行、读屏的描述里（没有第一行）；圆环在',
  problems.length === 0, oneLine(problems.join('; '), 600));
}

/** @brief edit-allow：修改卡的内容；出卡不抢焦点、Enter 不批准、请求任务栏闪烁；Alt+1 允许后执行并完成，展开有 diff。 */
async function editAllowCheck(page, h) {
  const fx = await h.load('edit-allow');
  const [first] = eventsOfType(fx, 'mori.approval_request');
  await drive(page, h, fx, {
    async before(command, request) {
      if (request !== first) return;
      await checkCard(page, 'edit-allow：修改卡显示"修改 README.md"、每处替换的原文和新文、三个选项与快捷键', request,
        'edit-allow-card');
      record('edit-allow：卡片出现时焦点留在输入框', await composerFocused(page));
      const before = await commandCount(page);
      await page.keyboard.press('Enter');
      await sleep(300);
      record('edit-allow：在输入框按 Enter 不会批准', await cardFor(page, request.requestId).isVisible()
        && await commandCount(page) === before);
      record('edit-allow：出卡时请求任务栏闪烁（主进程只在窗口不在前台时闪烁）',
        await page.evaluate(() => window.__replay.status.attention) > 0);
      const small = await smallText(page);
      record('edit-allow：没有小于 12px 的文字（批准卡挂着时）', small.length === 0, small.slice(0, 3).join('; '));
      await checkRunningRow(page);
    },
  });
  const cards = await h.toolCards();
  const index = cards.findIndex((card) => card.title.startsWith('Edit'));
  const editCard = page.locator(`${P}[data-testid="tool-card"]`).nth(Math.max(0, index));
  await editCard.locator('summary').click();
  const diff = await editCard.getByTestId('tool-diff').waitFor({ timeout: 5000 }).then(() => true, () => false);
  record('edit-allow：Alt+1 允许后工具卡执行并完成，展开能看到实际 diff', index >= 0 && cards[index].status === 'done'
    && diff, JSON.stringify(cards));
  await commonChecks(page, h, fx);
  await shot(page, 'edit-allow');
}

/** @brief 拒绝后的阶段：卡片消失后第一个阶段（"Waiting for your approval"之外）。 */
function stageAfterCard(samples, requestId) {
  const last = samples.map((s) => s.request).lastIndexOf(requestId);
  return samples.slice(last + 1).map((s) => s.stage).filter((stage) => stage && stage !== 'Waiting for your approval');
}

/** @brief edit-reject：三种拒绝方式（点"Deny"、理由框 Enter、输入框 Alt+3）都带理由；模型的下一条回复在卡之后。 */
async function editRejectCheck(page, h) {
  const ways = { click: '写理由后点"拒绝"', enter: '在理由框里按 Enter', alt3: '写理由后在输入框按 Alt+3' };
  for (const [way, label] of Object.entries(ways)) {
    const fx = await h.load('edit-reject', { speed: way === 'click' ? 2 : 4 });
    await drive(page, h, fx, { reject: () => way });
    const [end] = eventsOfType(fx, 'mori.approval_end');
    const cards = await h.toolCards();
    record(`edit-reject：${label}：工具卡显示"${rejectedText(end)}"`, cards.some((c) => c.text === rejectedText(end)),
      JSON.stringify(cards));
    if (way !== 'click') {
      const errors = await h.replayErrors();
      record(`edit-reject：${label}：命令与录制一致`, errors.length === 0, errors.join('; '));
      continue;
    }
    const replied = await page.evaluate((p) => {
      const card = [...document.querySelectorAll(`${p}[data-testid="tool-card"][data-status="rejected"]`)].pop();
      const replies = [...document.querySelectorAll(`${p}[data-testid="assistant"]`)];
      return Boolean(card) && replies.some((reply) => !reply.contains(card)
        && (card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) && reply.textContent.trim());
    }, P);
    record('edit-reject：模型的下一条回复出现在已拒绝的卡之后', replied);
    const next = stageAfterCard(await h.samples(), end.requestId);
    record('edit-reject：拒绝后阶段行回到"等待模型响应"（不显示"运行"或"执行中"）', next[0] === 'Waiting for the model…',
      next.slice(0, 4).join(' → '));
    await commonChecks(page, h, fx);
    await shot(page, 'edit-reject');
  }
}

/** @brief 权限菜单：两个选项与勾选、"Allowed for this session:"列表与"Forget"、底部说明。 */
async function checkMenu(page, label, { mode, allowed }) {
  await openMenu(page);
  const view = await menuInfo(page);
  const rowsOk = allowed.every((item) => view.rows.some((row) => row.includes(item)))
    && view.rows.length === allowed.length;
  record(label, view.ask === String(mode === 'ask') && view.all === String(mode === 'all') && rowsOk
    && view.text.includes(MENU_NOTE), JSON.stringify(view));
  return view;
}

/**
 * @brief command-session：Alt+2"Allow “Run commands” for this session"，之后的命令不出卡、
 *        标"Allowed for this session"；菜单里 Forget 后又出卡。
 */
async function commandSessionCheck(page, h) {
  const fx = await h.load('command-session');
  const [first] = eventsOfType(fx, 'mori.approval_request');
  await drive(page, h, fx, {
    async before(command, request) {
      if (request === first) {
        await checkCard(page, 'command-session：命令卡显示"运行命令"、完整命令行、本会话不再询问"运行命令"与命令类说明',
          request, 'command-card');
      }
      if (command.type !== 'approval.forget') return;
      const seen = new Set((await h.samples()).map((s) => s.request).filter(Boolean));
      record('command-session：选"本会话不再询问"后，之后的命令不出卡', seen.size === 1, [...seen].join(','));
      await checkMenu(page, 'command-session：权限菜单列出"本会话已允许：运行命令"和"清除"，当前"每次询问"，有说明',
        { mode: 'ask', allowed: [toolLabel(command.toolName)] });
      const small = await smallText(page);
      record('command-session：权限菜单没有小于 12px 的文字', small.length === 0, small.slice(0, 3).join('; '));
      await shot(page, 'permission-menu');
    },
    async after(command) {
      if (command.type !== 'approval.forget') return;
      await checkMenu(page, 'command-session：清除后"本会话已允许"里不再有"运行命令"', { mode: 'ask', allowed: [] });
      await page.keyboard.press('Escape');
      record('command-session：Esc 关闭权限菜单', await page.getByTestId('permission-menu').count() === 0);
    },
  });
  const cards = await h.toolCards();
  record('command-session：清除后再运行命令又出卡（录制里清除之后还有一张卡）', eventsOfType(fx, 'mori.approval_request').length >= 2
    && cards.at(-1)?.badge === '', JSON.stringify(cards));
  await commonChecks(page, h, fx);
  await shot(page, 'command-session');
}

/** 从文字框往后按 Tab 依次停的地方（models.md"位置"：权限 → 选择范围 → Effort → 圆环 → "Send"；文字框有字时"Send"可用） */
const TAB_PATH = ['permission-button', 'model-button', 'thinking-button', 'usage', 'send-button'];

/** @brief 从文字框往后按 TAB_PATH.length 次 Tab，返回每次焦点所在元素（focusedTestId）。 */
async function tabPath(page, h) {
  await h.textarea.focus();
  const path = [];
  for (let index = 0; index < TAB_PATH.length; index += 1) {
    await page.keyboard.press('Tab');
    path.push(await focusedTestId(page));
  }
  return path;
}

/**
 * @brief 键盘走一遍（models.md"位置"、"菜单的位置与键盘"、"不会误发送"）：从文字框 Tab 依次是权限 → 范围 → Effort →
 *        圆环 → "Send"；Enter 打开权限菜单、焦点在打勾的"Ask each time"，↓ 到"Allow all"、再 ↓ 回到开头；Esc 关闭、
 *        焦点回按钮。文字框里有字时在菜单里按 Enter 只选菜单项：菜单关、焦点回按钮，不发命令（不发送也不排队），草稿还在。
 */
async function permissionKeys(page, h) {
  const draft = 'plain 菜单里按 Enter 不发送';
  const menu = page.getByTestId('permission-menu');
  const count = await commandCount(page);
  await h.textarea.fill(draft);
  const path = await tabPath(page, h);
  record('all-mode：从文字框按 Tab 依次停在输入框下面一行的权限 → 范围 → Effort → 圆环 → "Send"（页面顺序与看到的顺序相同）',
    JSON.stringify(path) === JSON.stringify(TAB_PATH), JSON.stringify(path));
  await h.textarea.focus();
  await page.keyboard.press('Tab');
  const onButton = await focusedTestId(page) === 'permission-button';
  await page.keyboard.press('Enter');
  await menu.waitFor({ timeout: 5000 });
  const keys = [await focusedText(page)];
  for (const key of ['ArrowDown', 'ArrowDown']) {
    await page.keyboard.press(key);
    keys.push(await focusedText(page));
  }
  await page.keyboard.press('Escape');
  const closed = await menu.count() === 0;
  const back = await focusedTestId(page) === 'permission-button';
  record('all-mode：从文字框按 Tab 先到输入框下面一行的权限按钮；Enter 打开，焦点在打勾的"Ask each time"，↓ 到'
    + '"Allow all"、再 ↓ 回到开头；Esc 关闭，焦点回到权限按钮', onButton && closed && back
    && JSON.stringify(keys) === JSON.stringify(['Ask each time', 'Allow all', 'Ask each time']),
  JSON.stringify({ onButton, keys, closed, back }));
  await page.keyboard.press('Enter');
  await menu.waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  await sleep(300);
  const after = { menu: await menu.count(), commands: await commandCount(page) - count,
    draft: await h.textarea.inputValue(), focus: await focusedTestId(page) };
  record('all-mode：文字框里有字、权限菜单开着时在菜单里按 Enter 只选菜单项（菜单关、焦点回按钮），不发送也不排队',
    after.menu === 0 && after.commands === 0 && after.draft === draft && after.focus === 'permission-button',
    JSON.stringify(after));
  await h.textarea.fill('');
}

/**
 * @brief 权限菜单开着时按 F8（models.md"Tab 移出时关闭"：焦点去了报告框不关）：报告框打开时菜单还在；在报告框里按 Esc
 *        只关报告框，菜单仍开着、焦点回到原来那一项；再按 Esc 关菜单。F8 不经过后台进程，不发命令。
 */
async function permissionF8(page) {
  const menu = await openMenu(page);
  const item = await focusedText(page);
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const during = await menu.count() === 1;
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  const view = { item, during, after: await menu.count() === 1, focus: await focusedText(page),
    inMenu: await page.evaluate((selector) => Boolean(document.activeElement?.closest(selector)), PERMISSION_MENU) };
  record('all-mode：权限菜单开着时按 F8：报告框打开时菜单不关；在报告框里按 Esc 只关报告框，菜单仍开着，焦点回到原来'
    + '那一项（打勾的"Ask each time"）', view.during && view.after && view.inMenu && view.focus === item
    && item === 'Ask each time', JSON.stringify(view));
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
}

/**
 * @brief 权限菜单开着时点"Allowed for this session:"（不能停焦点的文字）不关；焦点从打勾的一项往后 Tab，到菜单外面
 *        能停焦点的元素上时关闭（models.md"Tab 移出时关闭"）；再查开着时按 F8（permissionF8）。
 */
async function permissionFocusOut(page) {
  const menu = await openMenu(page);
  await menu.getByText('Allowed for this session:').click();
  await sleep(200);
  const kept = await menu.count() === 1;
  await menu.locator('[aria-checked="true"]').focus();
  let out = null;
  for (let tries = 0; tries < 6 && !out; tries += 1) {
    await page.keyboard.press('Tab');
    out = await page.evaluate((selector) => (document.activeElement?.closest(selector) ? null
      : document.activeElement?.dataset?.testid ?? document.activeElement?.tagName ?? 'none'), PERMISSION_MENU);
  }
  const closed = await menu.waitFor({ state: 'detached', timeout: 2000 }).then(() => true, () => false);
  record('all-mode：权限菜单开着时点"Allowed for this session:"不关；Tab 到菜单外面能停焦点的元素时关闭',
    kept && Boolean(out) && closed, JSON.stringify({ kept, out, closed }));
  if (!closed) await page.keyboard.press('Escape');
  await permissionF8(page);
}

/**
 * @brief 第一次打开权限菜单时：权限按钮在输入框下面一行的左端、顶栏上没有移走的几项，按钮只有文字"Ask each time"
 *        和 ▾（没有盾牌）、悬停两行、读屏的描述只有第二行；菜单往上打开、左对齐这一行、不出界（m2-helpers.mjs）。
 */
async function checkPlacement(page, button) {
  const problems = modeProblems(button, 'ask');
  record('all-mode：权限按钮在输入框下面一行的左端（顶栏上没有权限、范围、Effort 和上下文用量），只有文字"Ask each time"'
    + '和 ▾、没有盾牌图标，悬停两行"Permission mode: Ask each time""Change the permission mode"，读屏的描述只有第二行',
  Boolean(button?.first) && button.inTopbar.length === 0 && problems.length === 0,
  [`first ${button?.first}`, `in top bar ${JSON.stringify(button?.inTopbar ?? null)}`, ...problems].join('; '));
  const menu = permissionMenuProblems(await rowMenuState(page, PANE, PERMISSION_MENU));
  record('all-mode：权限菜单从输入框下面一行往上打开（下边在这一行上方 6px），左边对齐这一行的左端，整个在这一栏和窗口里、'
    + '不盖顶栏，最高 min(440px, 这一行上边到顶栏下边 − 12px)', menu.length === 0, menu.join('; '));
}

/** @brief 切到全部允许的确认框：文字、角色、初始焦点在"Cancel"。 */
async function checkConfirm(page, dialog) {
  const text = await dialog.innerText();
  const role = await dialog.getAttribute('role');
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  record('all-mode：切到全部允许前先确认："切换到全部允许？编辑、写入和命令都不再询问。"，焦点在"取消"',
    role === 'alertdialog' && text.includes('Switch to “Allow all”?')
      && text.includes('Edits, writes, and commands will run without asking.') && text.includes('Cancel')
      && focused === 'Cancel', `${oneLine(text)} | 焦点：${focused}`);
  await shot(page, 'confirm-all');
}

/** @brief all-mode 第一次切换前：按钮和菜单的位置（checkPlacement）；确认框按 Esc 等于取消，权限不变、不发命令。 */
async function cancelAllOnce(page) {
  const before = await permissionState(page, PANE);
  const count = await commandCount(page);
  await checkMenu(page, 'all-mode：权限菜单两个选项，当前"每次询问"打勾，底部说明', { mode: 'ask', allowed: [] });
  await checkPlacement(page, before);
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: 'Allow all' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await checkConfirm(page, dialog);
  await page.keyboard.press('Escape');
  await sleep(200);
  const after = await permissionState(page, PANE);
  record('all-mode：确认框里按 Esc 等于取消，权限不变', await dialog.count() === 0 && await commandCount(page) === count
    && after?.text === 'Ask each time' && before?.popup === 'menu', JSON.stringify(after?.text ?? null));
  return before;
}

/** @brief 等输入框下面一行的权限按钮显示 text（按钮在回放桥答复 approval.setMode 之后才变）。 */
function modeShown(page, text) {
  return page.waitForFunction(({ selector, want }) => document.querySelector(selector)?.textContent?.trim() === want,
    { selector: `${P}${ROW} [data-testid="permission-button"]`, want: text }, { timeout: 5000 })
    .then(() => true, () => false);
}

/**
 * @brief 把回放窗口的内容区改成 800×600 并打开右栏（会话面板最窄的一种，约 300px，models.md"窄栏"），读权限按钮
 *        （permissionState），再关上右栏、恢复窗口。右栏只读对话流，不发命令。窗口经文件末尾启动的 app（Electron）改。
 */
async function narrowPermission(page) {
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const before = win.getBounds();
    win.setContentSize(800, 600);
    return before;
  });
  const toggle = page.locator(PANE).getByRole('button', { name: 'Toggle changes' });
  let opened = false;
  try {
    await page.waitForFunction(() => Math.abs(innerWidth - 800) <= 2, null, { timeout: 5000 });
    opened = await toggle.getAttribute('aria-pressed') !== 'true';
    if (opened) await toggle.click();
    await sleep(300);
    return await permissionState(page, PANE);
  } finally {
    if (opened) await toggle.click();
    await app.evaluate(({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0].setBounds(box), bounds);
    await sleep(300);
  }
}

/** @brief 切到"Allow all"之后：会话面板窄时（narrowPermission）按钮仍只有文字、看得见、不窄于最窄，颜色和对比度。 */
async function checkNarrowAll(page) {
  const narrow = await narrowPermission(page);
  const problems = modeProblems(narrow, 'all');
  const least = (narrow?.pane ?? 0) <= 340 ? 40 : 44;
  record('all-mode：会话面板窄（800 宽窗口、右栏打开）时"全部允许"的按钮仍只有文字（≤ 460px 没有 ▾）、模式名看得见、'
    + '不窄于最窄，字用 --color-warn-text、对比度 ≥ 4.5:1', Boolean(narrow) && narrow.pane <= 460
    && narrow.width >= least - 0.5 && problems.length === 0,
  oneLine(`pane ${narrow?.pane}px, button ${narrow?.width}px; ${problems.join('; ')}`, 400));
  await shot(page, 'allow-all-narrow');
}

/**
 * @brief 每次切换之后输入框下面一行的权限按钮：切到"Allow all"时文字变成"Allow all"、颜色与"Ask each time"不同，
 *        只有文字（没有盾牌）、字用 --color-warn-text、对比度 ≥ 4.5:1，窄时也一样；切回"Ask each time"不需要确认。
 */
async function checkModeButton(page, mode, askLook) {
  await modeShown(page, mode === 'all' ? 'Allow all' : 'Ask each time');
  const button = await permissionState(page, PANE);
  const problems = modeProblems(button, mode);
  if (mode === 'all') {
    record('all-mode：确认后输入框下面一行的按钮显示"全部允许"，用警示色', button?.text === 'Allow all'
      && button.look !== askLook?.look, JSON.stringify([askLook?.look, button?.look]));
    record('all-mode："全部允许"的按钮只有文字和 ▾、没有盾牌图标；字用 --color-warn-text，和底色的对比度 ≥ 4.5:1；'
      + '悬停两行"Permission mode: Allow all"和确认框里那句，读屏的描述只有第二行', problems.length === 0,
    problems.join('; '));
    await checkNarrowAll(page);
    return;
  }
  record('all-mode：切回"每次询问"不需要确认', button?.text === 'Ask each time'
    && await page.getByTestId('confirm-dialog').count() === 0, JSON.stringify(button?.text ?? null));
  record('all-mode：切回后按钮只有文字"Ask each time"和 ▾，悬停第二行和读屏的描述是"Change the permission mode"',
    problems.length === 0, problems.join('; '));
}

/**
 * @brief all-mode：从文字框 Tab 的顺序、权限菜单的键盘、Tab 移出和 F8；确认后全部允许（警示色），改文件不出卡、
 *        标"Allow all"；切回每次询问不需要确认，之后又出卡。
 */
async function allModeCheck(page, h) {
  const fx = await h.load('all-mode');
  let askLook = null;
  await drive(page, h, fx, {
    async before(command) {
      if (command.type !== 'approval.setMode' || command.mode !== 'all' || askLook) return;
      await permissionKeys(page, h);
      await permissionFocusOut(page);
      askLook = await cancelAllOnce(page);
    },
    async after(command) {
      if (command.type === 'approval.setMode') await checkModeButton(page, command.mode, askLook);
    },
  });
  const cards = await h.toolCards();
  record('all-mode：全部允许时改文件不出卡，修改卡标"全部允许"', cards.some((c) => c.title.startsWith('Edit')
    && c.badge === 'Allow all'), JSON.stringify(cards));
  await commonChecks(page, h, fx);
  await shot(page, 'all-mode');
}

/** @brief pending-to-all：卡挂着时切到全部允许，挂起的卡按允许处理，工具卡标"Allow all"。 */
async function pendingToAllCheck(page, h) {
  const fx = await h.load('pending-to-all');
  await drive(page, h, fx, {
    async before(command) {
      if (command.type !== 'approval.setMode') return;
      record('pending-to-all：切换前批准卡挂着', await page.locator(CARD).count() === 1);
    },
    async acted(command) {
      if (command.type !== 'approval.setMode') return;
      const gone = await page.locator(CARD).waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
      record('pending-to-all：确认后挂起的卡消失（按允许处理）', gone);
    },
  });
  const cards = await h.toolCards();
  record('pending-to-all：被放行的命令卡标"全部允许"', cards[0]?.badge === 'Allow all', JSON.stringify(cards));
  await commonChecks(page, h, fx);
}

/** @brief stop-pending：卡挂着时在输入框按 Esc：撤回排队、停止，卡按拒绝处理；重新打开后仍是"Denied · You pressed Stop"。 */
async function stopPendingCheck(page, h) {
  const fx = await h.load('stop-pending');
  await drive(page, h, fx, {
    async before(command) {
      if (command.type !== 'session.clearQueue') return;
      const cards = await h.toolCards();
      record('stop-pending：停止前批准卡挂着，工具卡"等你批准"', await page.locator(CARD).count() === 1
        && cards[0]?.status === 'awaiting' && cards[0]?.text === 'Waiting for your approval', JSON.stringify(cards));
    },
    async after(command) {
      if (command.type === 'session.clearQueue') {
        await untilIdle(page);
        const cards = await h.toolCards();
        record('stop-pending：在输入框按 Esc：卡按拒绝处理，工具卡"已拒绝 · 你按了停止"', await page.locator(CARD).count() === 0
          && cards[0]?.status === 'rejected' && cards[0]?.text === 'Denied · You pressed Stop', JSON.stringify(cards));
        record('stop-pending：提示"已停止 · 已经做出的修改不会自动撤销"，不显示错误',
          await page.getByText(STOPPED_TEXT).count() === 1
            && await page.getByTestId('error-card').count() === 0);
        await commonChecks(page, h, fx);
        await shot(page, 'stop-pending');
      }
      if (command.type === 'session.open') {
        await checkToolCards(h, fx, 'stop-pending：从会话记录重新打开后仍是"已拒绝 · 你按了停止"，没有标签', false);
      }
    },
  });
  const errors = await h.replayErrors();
  record('stop-pending：重新打开后回放命令仍与录制一致', errors.length === 0, errors.join('; '));
}

/** @brief card-esc：焦点在理由框时按 Esc：带理由拒绝这张卡，生成继续，焦点回到输入框。 */
async function cardEscCheck(page, h) {
  const fx = await h.load('card-esc');
  await drive(page, h, fx, {
    reject: () => 'esc',
    async acted(command) {
      if (command.type !== 'approval.answer') return;
      await page.locator(CARD).waitFor({ state: 'detached', timeout: 5000 });
      const running = await page.locator(`${P}[data-testid="chat-pane"]`).getAttribute('data-running');
      record('card-esc：焦点在卡上按 Esc 只拒绝这张卡，生成继续', running === 'true');
      record('card-esc：卡片处理完后焦点回到输入框', await composerFocused(page));
    },
  });
  const [end] = eventsOfType(fx, 'mori.approval_end');
  const cards = await h.toolCards();
  record(`card-esc：工具卡显示"${rejectedText(end)}"，没有停止`, cards.some((c) => c.text === rejectedText(end))
    && await page.getByText(STOPPED_TEXT).count() === 0, JSON.stringify(cards));
  await commonChecks(page, h, fx);
}

/** @brief write-allow：写入卡；卡挂着时在输入框打字并按 Enter 是排队、不批准；Alt+1 允许后写入完成，排队那条随后送达。 */
async function writeAllowCheck(page, h) {
  const fx = await h.load('write-allow');
  const [first] = eventsOfType(fx, 'mori.approval_request');
  const queued = (command) => command.type === 'session.prompt' && command.behavior === 'followUp';
  await drive(page, h, fx, {
    async before(command) {
      if (!queued(command)) return;
      await checkCard(page, 'write-allow：写入卡显示"写入 notes.md"、将写入的完整内容、本会话不再询问"写入文件"', first,
        'write-card');
      record('write-allow：卡片出现时焦点留在输入框', await composerFocused(page));
    },
    async after(command) {
      if (!queued(command)) return;
      const queue = await page.getByTestId('queue').innerText().catch(() => '');
      const last = await page.evaluate(() => window.__replay.status.commands.at(-1)?.type);
      record('write-allow：卡挂着时继续打字并按 Enter 是排队，不会批准', await cardFor(page, first.requestId).isVisible()
        && queue.includes(command.text) && last === 'session.prompt', oneLine(queue));
    },
  });
  const users = await page.getByTestId('user-message').allInnerTexts();
  const cards = await h.toolCards();
  const written = cards.some((c) => c.title.startsWith('Write') && c.status === 'done');
  record('write-allow：Alt+1 允许后写入完成，排队的消息在本轮结束前送达', written && users.length === 2
    && users[1].startsWith('排队：'), `${JSON.stringify(cards)} | ${users.join(' | ')}`);
  await commonChecks(page, h, fx);
}

/** @brief two-tools：逐张出卡（没有"{n} more"，上一个调用执行完才出下一张）；焦点不在任何元素上时 Alt+1 也有效。 */
async function twoToolsCheck(page, h) {
  const fx = await h.load('two-tools');
  const requests = eventsOfType(fx, 'mori.approval_request');
  record('two-tools：录制情况', requests.length >= 2, fx.description);
  await drive(page, h, fx, {
    focus: (command) => (command.requestId === requests[1]?.requestId ? 'body' : 'composer'),
    async before(command, request) {
      if (command.type !== 'approval.answer') return;
      const index = requests.indexOf(request);
      const info = await cardInfo(cardFor(page, request.requestId));
      const cards = await h.toolCards();
      record(`two-tools：第 ${index + 1} 张卡单独出现，之前的调用已经执行完`, info.more === null
        && cards.filter((c) => c.status === 'awaiting').length === 1 && !cards.some((c) => c.status === 'running'),
      JSON.stringify(cards));
    },
  });
  record('two-tools：焦点不在任何元素上时 Alt+1 也能允许', (await h.replayErrors()).length === 0);
  await commonChecks(page, h, fx);
  await shot(page, 'two-tools');
}

/**
 * @brief F8 前：在 设置 → Models 的提供商卡上 Add key（v1，models.addKey，规格 §14.4；回放桥直接应答，之后 models.get
 *        读到的提供商多一个 key），之后检查它不进报告。提供商是回放桥按录制的模型合成的（synthetic）。
 */
async function saveFakeKey(page, h, key) {
  await h.openModels();
  const card = page.getByTestId('provider-card').first();
  const before = await card.getByTestId('key-row').count();
  await card.locator('[data-action="add-key"]').click();
  await card.getByTestId('key-form').getByLabel('Secret').fill(key);
  await card.getByTestId('key-form').getByRole('button', { name: 'Save', exact: true }).click();
  const rows = '[data-testid="provider-card"] [data-testid="key-row"]';
  await page.waitForFunction(({ css, count }) => document.querySelectorAll(css).length > count,
    { css: rows, count: before }, { timeout: 10000 });
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/**
 * @brief F8 打开报告框：截图期间什么都不显示，截完才出现报告框（截图里没有报告框）；两个框都空时不能保存；
 *        开着时再按 F8 焦点回到第一个输入框。
 */
async function f8Open(page) {
  await page.evaluate(() => { window.__replay.f8.captureDelayMs = 600; });
  await page.keyboard.press('F8');
  await sleep(200);
  const during = await page.evaluate(() => document.querySelector('[data-testid="issue-dialog"]')?.innerText ?? null);
  const atCapture = await page.evaluate(() => window.__replay.status.dialogAtCapture.at(-1));
  record('f8：按 F8 先截图再打开报告框（截图期间什么都不显示，截图那一刻没有报告框）', atCapture === false
    && during === null, `截图期间：${oneLine(during ?? '不显示')}`);
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 5000 });
  const view = await dialog.evaluate((el) => ({ role: el.getAttribute('role'), label: el.getAttribute('aria-label'),
    src: el.querySelector('[data-testid="issue-shot"]')?.getAttribute('src') ?? '', text: el.innerText,
    what: el.querySelector('[data-testid="issue-what"]')?.getAttribute('aria-label'),
    expect: el.querySelector('[data-testid="issue-expect"]')?.getAttribute('aria-label') }));
  record('f8：报告框有截图缩略图、"哪里不对""你期望什么"和说明', view.role === 'dialog'
    && view.label === 'Report a UI issue' && view.src.startsWith('data:image/png') && view.what === 'What went wrong'
    && view.expect === 'What you expected'
    && view.text.includes(F8_NOTE), JSON.stringify({ ...view, src: view.src.slice(0, 30) }));
  record('f8：两个框都空时"保存"不可用', await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled());
  await dialog.getByTestId('issue-expect').fill('按钮之间留出空隙');
  await page.keyboard.press('F8');
  const focused = await page.evaluate(() => document.activeElement?.dataset.testid);
  record('f8：报告框开着时再按 F8 不重复打开，焦点回到第一个输入框', await page.getByTestId('issue-dialog').count() === 1
    && focused === 'issue-what', focused);
  return dialog;
}

/**
 * @brief 交给主进程的报告：截图 id、两段文字、"Current view"的几项（含"Model range""Effort"和"Pane width"）、带时间的
 *        最近操作；不含填过的 key。facts 是按 F8 之前记下的那一栏宽度、范围、Effort 和权限（m2-helpers.mjs paneFacts）。
 */
function checkReport(report, key, facts) {
  const field = (part) => report.view.find((item) => item.label.includes(part))?.value;
  const actions = report.actions.map((item) => item.text);
  const timed = report.actions.every((item) => /^\d\d:\d\d:\d\d$/.test(item.time));
  record('f8：报告带截图、两段文字、当前界面（会话、每次询问、等你批准 1 张）和带时间的最近操作',
    report.captureId === 'replay-capture-1' && report.what === '批准卡的按钮太挤' && report.expect === '按钮之间留出空隙'
      && field('Page') === 'Session' && field('Permission mode') === 'Ask each time'
      && field('Pending requests') === '1'
      && actions.some((text) => text.startsWith('Send: ')) && timed, JSON.stringify({ view: report.view, actions }));
  const problems = f8ViewProblems(report.view, facts);
  record('f8："当前界面"里"Model""Permission mode"照旧，多了"Model range"（同范围按钮的 data-pick）、"Effort"（同输入框'
    + '下面一行的 Effort 按钮）和"Pane width"（焦点所在那一栏的宽度），顺序同 f8.md', problems.length === 0,
  problems.join('; '));
  const added = actions.filter((text) => /^Add key \S+$/.test(text));
  record('f8：Add key 填过的 key 不出现在报告里，"Recent activity"只记"Add key <提供商>"', !JSON.stringify(report).includes(key)
    && added.length === 1, actions.join(' | '));
}

/**
 * @brief F8 保存：Saving… → Saved to；报告内容（截图、文字、当前界面、最近的操作）不含 key；Show in Explorer；Close。
 * @param facts 按 F8 之前记下的那一栏宽度、范围、Effort 和权限（checkReport）
 */
async function f8Save(page, dialog, key, facts) {
  await dialog.getByTestId('issue-what').fill('批准卡的按钮太挤');
  await shot(page, 'f8-dialog');
  await page.evaluate(() => { window.__replay.f8.saveDelayMs = 1500; });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  record('f8：保存中按钮显示"保存中…"，不可再点',
    await dialog.getByRole('button', { name: 'Saving…' }).isDisabled().catch(() => false));
  // 保存中按 Esc 不关闭报告框，"Cancel"也不可用：要等保存结束、显示路径
  await page.keyboard.press('Escape');
  await sleep(200);
  const savingStill = await dialog.getByRole('button', { name: 'Saving…' }).count() === 1;
  const cancelOff = await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled().catch(() => false);
  record('f8：保存中按 Esc 不关闭报告框，"取消"不可用', savingStill && cancelOff,
    `报告框 ${await page.getByTestId('issue-dialog').count()} 个，保存中 ${savingStill}，取消不可用 ${cancelOff}`);
  await dialog.getByTestId('issue-saved').waitFor({ timeout: 5000 });
  const saved = await dialog.getByTestId('issue-saved').innerText();
  const report = await page.evaluate(() => window.__replay.status.issues.at(-1));
  const settingsLink = dialog.getByTestId('issue-open-settings');
  record('f8：已保存：显示"已保存到 <路径>"、"打开所在文件夹"、"在设置中查看"（View in Settings，记忆规格 §10.9，'
    + '原来的 View in Review 没有了）和"关闭"', saved.includes('Saved to C:\\replay\\ui-issues\\replay-1.md')
    && await dialog.getByRole('button', { name: 'Show in Explorer' }).count() === 1
    && await settingsLink.count() === 1 && (await settingsLink.innerText()).trim() === 'View in Settings'
    && await dialog.getByRole('button', { name: 'View in Review' }).count() === 0
    && await dialog.getByRole('button', { name: 'Close' }).count() === 1, oneLine(saved));
  checkReport(report, key, facts);
  await dialog.getByRole('button', { name: 'Show in Explorer' }).click();
  const shown = await page.evaluate(() => window.__replay.status.shown.at(-1));
  record('f8：点"打开所在文件夹"在资源管理器里选中这个文件', shown === 'C:\\replay\\ui-issues\\replay-1.md', shown);
  await dialog.getByRole('button', { name: 'Close' }).click();
  record('f8：关闭后焦点回到打开前的位置（输入框）', await page.getByTestId('issue-dialog').count() === 0
    && await composerFocused(page));
}

/** @brief F8 的失败状态：截图失败仍可保存（报告注明）；保存失败显示原文且文字还在；左栏按钮也能打开；"Cancel"关闭。 */
async function f8Failures(page) {
  const dialog = page.getByTestId('issue-dialog');
  await page.evaluate(() => Object.assign(window.__replay.f8, { captureDelayMs: 0, saveDelayMs: 0,
    captureError: 'capture failed in replay' }));
  await page.keyboard.press('F8');
  const captureError = await dialog.getByTestId('issue-error').innerText({ timeout: 5000 }).catch(() => '');
  await dialog.getByTestId('issue-what').fill('截图失败时也能保存');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByTestId('issue-saved').waitFor({ timeout: 5000 });
  const report = await page.evaluate(() => window.__replay.status.issues.at(-1));
  record('f8：截图失败时显示原文，仍可填写和保存（报告注明截图失败）', captureError.includes('capture failed in replay')
    && report.captureId === null && report.captureError?.includes('capture failed in replay'), oneLine(captureError));
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => Object.assign(window.__replay.f8, { captureError: null,
    saveError: 'disk full in replay' }));
  await page.getByRole('button', { name: 'Report a UI issue (F8)' }).click();
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 5000 });
  await dialog.getByTestId('issue-what').fill('保存失败时文字还在');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saveError = await dialog.getByTestId('issue-error').innerText({ timeout: 5000 }).catch(() => '');
  record('f8：左栏按钮打开报告框；保存失败时显示原文，已输入的文字还在', saveError.includes('disk full in replay')
    && await dialog.getByTestId('issue-what').inputValue() === '保存失败时文字还在', oneLine(saveError));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  record('f8：点"取消"关闭报告框', await dialog.count() === 0);
}

/** @brief F8：报告框的各个状态；Esc 只关报告框、不停止生成；报告里没有 key。用 stop-pending 的录制（卡挂着、正在生成）。 */
async function f8Check(page, h) {
  const fx = await h.load('stop-pending');
  const commands = commandsOf(fx);
  const key = 'sk-mori-replay-not-in-report';
  await saveFakeKey(page, h, key);
  await untilBridge(page, 'played', 1, 'session.create');
  await h.send(commands[1].text);
  const [request] = eventsOfType(fx, 'mori.approval_request');
  await cardFor(page, request.requestId).waitFor({ timeout: 20000 });
  await h.textarea.focus();
  const before = await commandCount(page);
  const facts = await paneFacts(page, PANE);
  const dialog = await f8Open(page);
  await f8Save(page, dialog, key, facts);
  await page.keyboard.press('F8');
  await dialog.waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await sleep(300);
  const running = await page.locator(`${P}[data-testid="chat-pane"]`).getAttribute('data-running');
  record('f8：Esc 只关闭报告框；报告框不影响正在生成的会话（卡还在，没有停止，没有发命令）', await dialog.count() === 0
    && await cardFor(page, request.requestId).isVisible() && running === 'true' && await commandCount(page) === before);
  await f8Failures(page);
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await untilBridge(page, 'played', commands.indexOf(commands.find((c) => c.type === 'session.abort')) + 1, 'stop');
  const errors = await h.replayErrors();
  record('f8：F8 与报告框没有发出后台进程命令；之后 Esc 照常停止', errors.length === 0, errors.join('; '));
}

const checks = { 'edit-allow': editAllowCheck, 'edit-reject': editRejectCheck, 'command-session': commandSessionCheck,
  'all-mode': allModeCheck, 'pending-to-all': pendingToAllCheck, 'stop-pending': stopPendingCheck,
  'card-esc': cardEscCheck, 'write-allow': writeAllowCheck, 'two-tools': twoToolsCheck, f8: f8Check };

await buildHarness();
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
  env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
    MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-')) } });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
// f8Failures 故意制造的截图失败与保存失败，界面会按约定记一条错误日志，不算页面报错。
const induced = /(capture failed|disk full) in replay/;
page.on('console', (message) => {
  if (message.type() === 'error' && !induced.test(message.text())) pageErrors.push(message.text());
});
const h = helpers(page);
for (const [name, check] of Object.entries(checks)) {
  if (only && !only.includes(name)) continue;
  try {
    await check(page, h);
  } catch (error) {
    record(`${name}：流程`, false, oneLine(error, 400));
    await shot(page, `${name}-error`);
  }
}
record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
await app.close();
process.exitCode = write('m2-replay.json') ? 0 : 1;
