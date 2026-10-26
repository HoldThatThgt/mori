// 平行 Agent 与 TaskBoard 的回放测试（docs/specs/parallel-agents-taskboard.md §17.1、§17.2 的回放层）：在 Electron 里载入
// 真正的界面，用回放进程桥（tests/ui/harness）回放从真实会话录下的 tests/fixtures/tb/*.json（tb-record.mjs 录制，模型是
// 负责人的 DeepSeek 与 GLM），以及 m1–m6 的一组录制。测试像你一样操作（Open folder…、发录制里的消息、/team、点协作开关、
// 权限菜单、批准卡上的 Alt+1），回放桥核对界面发出的每条命令都与录制一致；再按 docs/v1/screens/team-*.md 检查界面：
//   TB-03：m1–m6 的录制在合成的空 TeamState/BoardView 下照常回放：开关一直是 Team: Off，没有回执、进展摘要、Stop team
//     （m7 的录制随工作回顾删除，docs/specs/memory.md §14.4）。
//   TB-04（tb-ask）：关闭模式下对话的 agent_message 是一张 "Ask reviewer" 工具卡，回答就是它的结果；没有回执、进展摘要、
//     批准卡，侧栏里只有用户会话。
//   TB-08（tb-team、tb-receipts）：三种回执的文字（§13.2，补充的原话超过 120 字符截断）与录下的写入一一对应；合并会话里
//     在写它的那张工具卡下面；重新打开后顺序相同；一轮的步骤折成"{n} steps"时卡收起、回执照常显示（2026-10-26 走查 M18）。
//   TB-37（tb-team、tb-receipts、tb-approval）：进展摘要的位置、标题行与 task 行（用录下的 TaskBoard 视图独立算出文字）、
//     当前在做什么（§13.8 的标题规则）、需求状态的先后、关闭后 Done / Cancelled、时长停住、没有 task 行、结论与交接链；
//     重新打开后一致；
//     等批准时 "Waiting for your approval"。
//   TB-34（tb-approval）：后台批准卡在用户会话那一栏、卡头 "<role> · T1 · <title>"、编号 <实例 id>:approval-<n>；
//     侧栏等你批准；对话一轮结束不清掉卡；Alt+1 允许；TaskBoard 工具从不出卡；权限菜单的说明。
//   TB-53（tb-ask、tb-team）：三种文字与悬停、aria-checked、三种点击（off → always → off、once → always → once）、
//     打开中与后台进程退出时不可用、窄栏（不宽于 600px）只显示状态点、做完为止在汇报的那一轮结束时回到 Team: Off。
// 录制文件还不存在时，每个对应编号记一条失败"<编号> replay fixture missing"（不造假录制）。
// 用法（在 app/ 下）：node tests/ui/tb-replay.mjs [--only tb-team,m1/readme]
// 结果写到 test-results/tb-replay.json（--only 时 tb-partial-replay.json，不计入覆盖检查）；截图在 test-results/tb-replay/。

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { build } from 'vite';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { PANE, rowOf, waitReady } from './m3-helpers.mjs';
import { expandSteps, showStep, stepsState } from './page.mjs';
import { progressOf, receiptsOf, setProgressOpen, transcriptItems } from './tb-helpers.mjs';
import { expectedTitle, label } from './tb-real-helpers.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-tb');
const shots = join(appRoot, 'test-results/tb-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 开关的三种文字与悬停（§13.1）；<create role> 是基座 Mori */
const SWITCH = {
  off: { text: 'Team: Off', title: 'Turn on team mode', checked: 'false' },
  always: { text: 'Team: On', title: 'Messages go to Mori first', checked: 'true' },
  once: { text: 'Team: Until done', title: 'Team mode ends when open requests are done', checked: 'true' },
};
/** 权限菜单的说明（§11.1） */
const PERMISSION_NOTE = 'Applies to all agents in this session. New sessions start at Ask each time.';
/** TaskBoard 的工具（§6.3），从不出卡 */
const TEAM_TOOLS = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close'];
/** TB-03 回放的 m1–m6 录制（[目录, 名字, 段]）：只有新建会话、发消息、批准卡、打开会话的，每个里程碑至少一个 */
const TB03 = [['m1', 'readme'], ['m1', 'edit'], ['m1', 'command-fail'], ['m2', 'edit-allow'], ['m2', 'two-tools'],
  ['m3', 'trust-deny'], ['m4', 'write-delete'], ['m4', 'stream-feedback'], ['m5', 'ref-reopen'], ['m6', 'slash']];

// ---------- 录制 ----------

/** @brief 回放桥当作只读查询回答的命令：从 harness/replay.js 的 QUERIES 读，保证与回放桥一致。 */
function harnessQueries() {
  const text = readFileSync(join(harnessDir, 'replay.js'), 'utf8');
  const match = /const QUERIES = \[([^\]]*)\]/.exec(text);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}
const QUERIES = harnessQueries();

/** @brief 录制文件的路径（tests/fixtures/<dir>/<name>.json）。 */
const fixturePath = (dir, name) => join(appRoot, 'tests/fixtures', dir, `${name}.json`);
/** @brief 读一个录制文件。 */
const readFixture = (dir, name) => JSON.parse(readFileSync(fixturePath(dir, name), 'utf8'));
/** @brief 录制里重启前（before）或重启后（after）的步骤；part 为空时是全部（同 harness/replay.js 的 partOf）。 */
function partOf(fx, part) {
  if (!part) return fx.steps;
  const at = fx.steps.findIndex((s) => s.restart);
  if (at < 0) throw new Error(`${fx.name} has no restart step`);
  return part === 'before' ? fx.steps.slice(0, at) : fx.steps.slice(at + 1);
}
/** @brief 一段里界面发出的命令（只读查询与回放桥直接应答的 models.* 写命令除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (steps) => steps.filter((s) => s.command && !QUERIES.includes(s.command.type)
  && !s.command.type.startsWith('models.')).map((s) => s.command);
/** @brief 一段里某种命令的结果（按顺序）。 */
const resultsOf = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
/** @brief 一段里某个会话的某种事件（按顺序）。 */
const eventsOf = (steps, type, sessionId = null) => steps.filter((s) => s.envelope?.event.type === type
  && (sessionId === null || s.envelope.sessionId === sessionId)).map((s) => s.envelope.event);
/** @brief 一段里录下的全部 TaskBoard 视图：会话信息里的与 mori.board 事件，按顺序。 */
const boardsOf = (steps) => [...[...resultsOf(steps, 'session.create'), ...resultsOf(steps, 'session.open')]
  .map((info) => info.board).filter(Boolean), ...eventsOf(steps, 'mori.board')];
/** @brief 工具结果的文字。 */
const resultText = (event) => (event?.result?.content ?? []).map((part) => part.text ?? '').join('');

// ---------- §13.2、§13.3 的文字（独立实现，用录下的视图算出界面该显示的） ----------

const STATE_TEXT = { done: 'Done', failed: 'Failed', cancelled: 'Cancelled', needs_decision: 'Needs your decision',
  stopped: 'Stopped', running: 'Running' };
/** @brief 需求状态的文字（§13.3 的表）。 */
function stateText(state, holders) {
  if (state === 'waiting_create') return `Waiting for ${label(holders.create)}`;
  if (state === 'with_close') return `With ${label(holders.close)}`;
  return STATE_TEXT[state];
}
/** @brief 时长：<1 min、6 min、1 h 12 min（§13.3）。 */
function durationText(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return '<1 min';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
/** @brief 回执的一行（§13.2，原话超过 120 个字符截断加 …）。 */
function receiptLine(receipt) {
  if (receipt.kind === 'registered') return `Request ${receipt.request} registered · ${receipt.title}`;
  if (receipt.kind === 'cancelled') return `Request ${receipt.request} cancelled`;
  const chars = [...(receipt.quote ?? '')];
  const quote = chars.length > 120 ? `${chars.slice(0, 120).join('')}…` : chars.join('');
  return `Added to request ${receipt.request}: “${quote}”`;
}
/** @brief task 一行的“在做什么”（§13.3 的 phase 表；running 按 §13.8 的标题规则）。 */
function phaseText(task, view, holders, cwd) {
  switch (task.phase) {
    case 'pending': return `Waiting for ${task.waitingFor.join(', ')}`;
    case 'queued': return 'Queued';
    case 'lock_wait': {
      const by = task.waitingFor[0];
      const stopped = view.requests.some((r) => r.tasks.some((t) => t.id === by && t.status === 'stopped'));
      return `Waiting to change files (${by}${stopped ? ', stopped' : ''})`;
    }
    case 'starting': return 'Starting';
    case 'running': return task.current ? expectedTitle(task.current.toolName, task.current.args,
      { cwd, task: task.id, seatRoles: [holders.create, holders.close] }) : 'Starting';
    case 'approval': return 'Waiting for your approval';
    case 'waiting_user': return `Waiting for ${label(holders.create)}`;
    case 'asked': return 'Needs your decision';
    case 'with_close': return `With ${label(holders.close)}`;
    case 'stopped_restart': return 'Stopped (Mori restarted)';
    default: return task.phase[0].toUpperCase() + task.phase.slice(1);
  }
}
/** @brief task 的一行：`T1 <title> · <role> · <在做什么>`（持有者为空或交到结案时没有角色段，team-stream.md）。 */
function rowText(task, view, holders, cwd) {
  const role = task.holder !== null && task.phase !== 'with_close' ? ` · ${label(task.holder)}` : '';
  const note = task.modelNote ? ` · ${task.modelNote}` : '';
  return `${task.id} ${task.title}${role} · ${phaseText(task, view, holders, cwd)}${note}`;
}
/** @brief 交接链（§13.3 展开时）：`<role>: <line> → …`。 */
const chainLine = (chain) => chain.map((link) => `${label(link.role)}: ${link.line}`).join(' → ');

// ---------- 页面 ----------

/** @brief 构建回放页面。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/**
 * @brief 载入录制文件（或它的一段），等侧栏读完会话列表，装上界面记录器（watchTeam）。
 * @return 这一段的步骤
 */
async function load(page, fx, { part = null, speed = 4, maxGap = 600 } = {}) {
  const index = pathToFileURL(join(outDir, 'index.html')).href;
  await page.goto(`${index}?fixture=${fx.name}${part ? `&part=${part}` : ''}&speed=${speed}&maxGap=${maxGap}`);
  await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
  await watchTeam(page);
  return partOf(fx, part);
}

/**
 * @brief 在页面里装一个 MutationObserver，只在变化时记下当前一栏：协作开关（模式、aria-checked、文字、读屏名称、悬停、
 *        是否可用）、进展摘要的标题行与 task 行、出现过的批准卡，以及回执、进展摘要、Stop team、批准卡归属行、
 *        右栏说明出现过的最多个数。结果在 window.__tbWatch。
 */
function watchTeam(page) {
  return page.evaluate((pane) => {
    const seen = { switches: [], rows: [], cards: [], max: {} };
    const last = new Map();
    const push = (list, key, item) => {
      const value = JSON.stringify(item);
      if (last.get(key) === value) return;
      last.set(key, value);
      list.push({ t: Date.now(), ...item });
    };
    const counts = { receipt: '[data-testid="receipt"]', progress: '[data-testid="progress"]',
      stopTeam: '[data-testid="stop-team"]', attribution: '[data-testid="approval-attribution"]',
      teamNote: '[data-testid="team-changes-note"]' };
    const scan = () => {
      const root = document.querySelector(pane);
      if (!root) return;
      const sw = root.querySelector('[data-testid="team-switch"]');
      if (sw) {
        push(seen.switches, 'switch', { mode: sw.dataset.mode, checked: sw.getAttribute('aria-checked'),
          text: sw.querySelector('.team-text')?.textContent ?? '', label: sw.getAttribute('aria-label'),
          title: sw.getAttribute('title'), disabled: sw.disabled });
      }
      for (const [name, css] of Object.entries(counts)) {
        seen.max[name] = Math.max(seen.max[name] ?? 0, root.querySelectorAll(css).length);
      }
      for (const block of root.querySelectorAll('[data-testid="progress"]')) {
        const request = Number(block.dataset.request);
        push(seen.rows, `h${request}`, { request, state: block.dataset.state,
          text: block.querySelector('.progress-title')?.textContent ?? '' });
        for (const row of block.querySelectorAll('[data-testid="progress-task"]')) {
          push(seen.rows, `r${request}${row.dataset.task}`, { task: row.dataset.task, phase: row.dataset.phase,
            text: row.textContent });
        }
      }
      for (const card of root.querySelectorAll('[data-testid="approval-card"]')) {
        push(seen.cards, `c${card.dataset.request}`, { request: card.dataset.request, tool: card.dataset.tool,
          agent: card.dataset.agent ?? null, task: card.dataset.task ?? null,
          attribution: card.querySelector('[data-testid="approval-attribution"]')?.textContent ?? null });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
    scan();
    window.__tbWatch = seen;
  }, PANE);
}
/** @brief 界面记录器记下的内容。 */
const watched = (page) => page.evaluate(() => window.__tbWatch);

/** @brief 当前一栏的标识（data-tab），tb-helpers 的读取函数按它找面板。 */
const paneTab = (page) => page.locator(PANE).getAttribute('data-tab');
/** @brief tb-helpers 的读取函数要的 ctx。 */
const ctxOf = (page) => ({ page });

/** @brief 等回放桥放完 total 段；出现不一致时立即报错。 */
async function untilPlayed(page, total, what, timeout = 600000) {
  await page.waitForFunction((v) => window.__replay.status.played >= v || window.__replay.status.errors.length > 0,
    total, { timeout }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 收尾：回放桥没有不一致，这一段录制里的命令全部用上了。 */
async function finish(page, id, label_, steps) {
  const total = commandsOf(steps).length;
  await untilPlayed(page, total, `all ${total} commands of ${label_}`).catch(() => {});
  const status = await page.evaluate(() => window.__replay.status);
  record(`${id} replay ${label_}: the commands the UI sent match the recording (${total}), none extra or missing`,
    status.errors.length === 0 && status.cursor === total && status.commands.length === total,
    status.errors.join('; ') || `commands ${status.commands.map((c) => c.type).join(', ')}`);
}

/** @brief 点侧栏"Open folder…"（回放桥返回下一条 session.create 的文件夹）；有信任询问时按 trust 回答；等会话就绪。 */
async function openFolder(page, trust = null) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
  if (trust) {
    const dialog = page.getByTestId('trust-dialog');
    await dialog.waitFor({ timeout: 15000 });
    if (trust.remember) await dialog.getByRole('checkbox', { name: 'Remember my choice' }).check();
    await dialog.getByRole('button', { name: trust.trusted ? 'Trust workspace' : 'Don’t trust', exact: true }).click();
  }
  await page.locator(PANE).waitFor({ timeout: 20000 });
  await waitReady(page);
}

/** @brief 在当前一栏的输入框里写字按 Enter；"/" 开头被补全列表插入（输入框还有字）时再按一次 Enter 发出。 */
async function typeAndSend(page, text) {
  const box = page.locator(`${PANE} .composer textarea`);
  await box.fill(text);
  await box.press('Enter');
  await sleep(300);
  if (text.startsWith('/') && (await box.inputValue()).trim() === text.trim()) await box.press('Enter');
}

/** @brief 在当前一栏的批准卡（data-request 为录下的 requestId）上照录制选择。 */
async function answerCard(page, command) {
  const card = page.locator(`${PANE} [data-testid="approval-card"][data-request="${command.requestId}"]`);
  await card.waitFor({ timeout: 30000 });
  const button = { allow: 'approval-allow', allowSession: 'approval-allow-session', reject: 'approval-reject' };
  if (command.decision === 'reject' && command.reason) await card.getByTestId('approval-reason').fill(command.reason);
  await card.getByTestId(button[command.decision]).click();
}

// ---------- TB-03：m1–m6 的录制 ----------

/** @brief 照录制的命令一条条在界面里做（新建会话、打开会话、发消息、批准卡），每条之前等上一段放完。 */
async function driveGeneric(page, steps) {
  const commands = commandsOf(steps);
  for (const [i, command] of commands.entries()) {
    await untilPlayed(page, i, `segment ${i} before ${command.type}`);
    if (command.type === 'session.create') await openFolder(page, command.trust ?? null);
    else if (command.type === 'session.open') {
      await rowOf(page, command.sessionFile).click();
      await waitReady(page);
    } else if (command.type === 'session.prompt') await typeAndSend(page, command.text);
    else if (command.type === 'approval.answer') await answerCard(page, command);
    else throw new Error(`no UI step for ${command.type}`);
  }
  await untilPlayed(page, commands.length, 'the last segment');
}

/** @brief TB-03：一个 m1–m6 的录制照常回放，开关一直是 Team: Off，没有任何协作的元素。 */
async function tb03(page, [dir, name, part]) {
  const fx = readFixture(dir, name);
  const steps = await load(page, fx, { part, speed: 6, maxGap: 400 });
  await driveGeneric(page, steps);
  const seen = await watched(page);
  const off = seen.switches.every((s) => s.mode === 'off' && s.checked === 'false' && s.text === SWITCH.off.text
    && s.title === SWITCH.off.title);
  const status = await page.evaluate(() => window.__replay.status);
  const total = commandsOf(steps).length;
  await shot(page, `tb03-${dir}-${name}`);
  record(`TB-03 replay ${dir}/${name}${part ? ` (${part})` : ''}: the recording replays as before under the synthetic `
    + `empty TeamState/BoardView (all ${total} commands match); the switch shows "Team: Off" (aria-checked false, `
    + 'hover "Turn on team mode") throughout; no receipt, no progress summary, no Stop team, no approval attribution',
  status.errors.length === 0 && status.cursor === total && seen.switches.length > 0 && off
    && Object.values(seen.max).every((n) => n === 0),
  oneLine(JSON.stringify({ errors: status.errors, cursor: status.cursor, total, max: seen.max,
    switches: [...new Set(seen.switches.map((s) => `${s.mode}|${s.text}|${s.disabled}`))] }), 600));
}

// ---------- TB-04、TB-53：tb-ask ----------

/** @brief tb-ask 的开头：打开中开关不可用；就绪后是 Team: Off；发录制里的问题，等这一轮放完。 */
async function askRun(page, fx) {
  const steps = await load(page, fx);
  const prompt = commandsOf(steps).find((c) => c.type === 'session.prompt');
  await openFolder(page);
  await typeAndSend(page, prompt.text);
  const at = commandsOf(steps).findIndex((c) => c.type === 'session.setTeam');
  await untilPlayed(page, at, 'the ask turn');
  await page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'false', PANE,
    { timeout: 30000 });
  return steps;
}

/** @brief TB-04：关闭模式下的临时提问在界面里是一张 Ask reviewer 工具卡，回答是它的结果；没有协作的元素。 */
async function askChecks(page, steps) {
  const id = resultsOf(steps, 'session.create')[0].sessionId;
  const call = eventsOf(steps, 'tool_execution_start', id).find((e) => e.toolName === 'agent_message');
  const answer = resultText(eventsOf(steps, 'tool_execution_end', id).find((e) => e.toolName === 'agent_message'));
  const card = page.locator(`${PANE} [data-testid="tool-card"]`).filter({ hasText: `Ask ${call.args.to}` });
  const cards = await page.locator(`${PANE} [data-testid="tool-card"] .tool-title`).allTextContents();
  await showStep(card);
  await card.first().locator('summary').click();
  const body = await card.first().locator('.tool-body').innerText().catch(() => '');
  const reply = (await page.locator(`${PANE} [data-testid="assistant"]`).last().innerText()).trim();
  const final = eventsOf(steps, 'message_end', id).filter((e) => e.message.role === 'assistant').at(-1);
  const want = final.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const rows = await page.locator('.session-item').evaluateAll((els) => els.map((el) => el.dataset.file));
  const seen = await watched(page);
  await shot(page, 'tb04-ask');
  record(`TB-04 replay tb-ask: off mode, the dialog's agent_message to ${call.args.to} is one tool card titled `
    + `"Ask ${call.args.to}" (status done) whose output is the recorded answer of the ask instance, and the reply `
    + 'after it is shown', cards.filter((t) => t === `Ask ${call.args.to}`).length === 1
    && await card.first().getAttribute('data-status') === 'done'
    && body.replace(/\s+/g, ' ').includes(answer.replace(/\s+/g, ' ').trim().slice(0, 40))
    && reply.replace(/\s+/g, ' ').includes(want.replace(/[`*]/g, '').replace(/\s+/g, ' ').slice(0, 20)),
  oneLine(JSON.stringify({ cards, answer, body, reply }), 600));
  record('TB-04 replay tb-ask: the ask is not a team action — no receipt, no progress summary, no approval card, the '
    + 'switch stays "Team: Off" during the ask; the sidebar lists only user sessions (no instance session file)',
  seen.max.receipt === 0 && seen.max.progress === 0 && seen.cards.length === 0 && rows.length >= 1
    && rows.every((file) => file && !/[\\/]teams[\\/]/.test(file) && !/\.ask\./.test(file))
    && seen.switches.every((s) => s.mode === 'off'), oneLine(JSON.stringify({ max: seen.max, rows }), 600));
}

/** @brief TB-53（tb-ask）：打开中不可用；off → always → off 两次点击；三种状态的文字、悬停与 aria-checked。 */
async function askSwitch(page, steps) {
  const opening = (await watched(page)).switches.find((s) => s.disabled);
  const sw = page.locator(`${PANE} [data-testid="team-switch"]`);
  const states = [await switchNow(page)];
  await sw.click();
  await page.waitForFunction((css) => document.querySelector(css)?.dataset.mode === 'always',
    `${PANE} [data-testid="team-switch"]`, { timeout: 10000 });
  states.push(await switchNow(page));
  await sw.click();
  await page.waitForFunction((css) => document.querySelector(css)?.dataset.mode === 'off',
    `${PANE} [data-testid="team-switch"]`, { timeout: 10000 });
  states.push(await switchNow(page));
  record('TB-53 replay tb-ask: while the session is opening the switch is visible but disabled ("Team: Off")',
    opening?.text === SWITCH.off.text && opening.disabled === true, JSON.stringify(opening));
  record('TB-53 replay tb-ask: off shows "Team: Off" / hover "Turn on team mode" / aria-checked false; a click sends '
    + 'session.setTeam on → "Team: On" / "Messages go to Mori first" / aria-checked true; a second click sends '
    + 'session.setTeam off and, with no open request, returns to "Team: Off"; no confirmation',
  states.map((s) => s.mode).join() === 'off,always,off' && states.every((s) => sameSwitch(s, SWITCH[s.mode]))
    && await page.getByTestId('confirm-dialog').count() === 0, JSON.stringify(states));
  await finish(page, 'TB-53', 'tb-ask', steps);
}

/** @brief 当前一栏开关此刻的样子。 */
const switchNow = (page) => page.locator(`${PANE} [data-testid="team-switch"]`).evaluate((el) => ({
  mode: el.dataset.mode, checked: el.getAttribute('aria-checked'), text: el.querySelector('.team-text')?.textContent,
  label: el.getAttribute('aria-label'), title: el.getAttribute('title'), disabled: el.disabled,
  wide: getComputedStyle(el.querySelector('.team-text')).display !== 'none',
  dot: getComputedStyle(el.querySelector('.team-dot')).display !== 'none', shown: el.innerText.trim(),
}));
/** @brief 开关的文字、读屏名称、悬停、aria-checked 与表相同。 */
const sameSwitch = (s, want) => s.text === want.text && s.label === want.text && s.title === want.title
  && s.checked === want.checked;

/** @brief TB-53：窄栏（这一栏不宽于 600px）只显示状态点，读屏名称仍是完整文字；宽栏是完整文字、没有状态点。 */
async function narrowSwitch(page, app) {
  const wide = await switchNow(page);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(400, 400);
    win.setSize(620, 800);
  });
  await page.waitForFunction((pane) => document.querySelector(pane)?.getBoundingClientRect().width <= 600, PANE,
    { timeout: 10000 }).catch(() => {});
  const width = await page.locator(PANE).evaluate((el) => el.getBoundingClientRect().width);
  const narrow = await switchNow(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
  await shot(page, 'tb53-narrow');
  record('TB-53 replay: in a pane 600px wide or narrower the switch shows only the status dot (no text; the '
    + 'accessible name stays the full text); in a wider pane the full text shows without the dot',
  width <= 600 && !narrow.wide && narrow.dot && narrow.shown === ''
    && narrow.label === SWITCH[narrow.mode].text && wide.wide && !wide.dot,
  JSON.stringify({ width, wide, narrow }));
}

/** @brief TB-53：后台进程退出（界面没准备好）时开关不可用，文字是最后知道的模式。 */
async function exitedSwitch(page) {
  const before = await switchNow(page);
  await page.evaluate(() => window.__replay.exit(1));
  await page.waitForFunction((css) => document.querySelector(css)?.disabled === true,
    `${PANE} [data-testid="team-switch"]`, { timeout: 10000 }).catch(() => {});
  const after = await switchNow(page);
  record('TB-53 replay: after the kernel exits the switch is disabled and keeps the last known text',
    after.disabled && after.text === before.text && !before.disabled, JSON.stringify({ before, after }));
}

/** @brief tb-ask 的全部检查。 */
async function askFixture(page, fx, app) {
  const steps = await askRun(page, fx);
  await askChecks(page, steps);
  await askSwitch(page, steps);
  await narrowSwitch(page, app);
  await exitedSwitch(page);
}

// ---------- TB-08、TB-37、TB-53：tb-team ----------

/** @brief tb-team 重启前的一段：Allow all、/team、登记后点开关两次，等全部放完；返回观察到的东西。 */
async function teamRun(page, fx) {
  const steps = await load(page, fx, { part: 'before' });
  const prompt = commandsOf(steps).find((c) => c.type === 'session.prompt');
  await openFolder(page);
  await allowAll(page);
  await typeAndSend(page, `/team ${prompt.text}`);
  await page.locator(`${PANE} [data-testid="receipt"][data-kind="registered"]`).first().waitFor({ timeout: 120000 });
  const sw = page.locator(`${PANE} [data-testid="team-switch"]`);
  const states = [await switchNow(page)];
  for (const want of ['always', 'once']) {
    await sw.click();
    await page.waitForFunction(({ css, mode }) => document.querySelector(css)?.dataset.mode === mode,
      { css: `${PANE} [data-testid="team-switch"]`, mode: want }, { timeout: 10000 });
    states.push(await switchNow(page));
  }
  await untilPlayed(page, commandsOf(steps).length, 'the whole tb-team run');
  await sleep(800);
  return { steps, states };
}

/** @brief 权限菜单 → Allow all → 确认（界面发 approval.setMode all）。 */
async function allowAll(page) {
  await page.locator(PANE).getByTestId('permission-button').click();
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: 'Allow all' }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Allow all', exact: true }).click();
}

/** @brief 对话流里回执、进展摘要（折叠与展开）和条目的先后，重启前后比较用。 */
async function streamSnapshot(page) {
  const tab = await paneTab(page);
  const ctx = ctxOf(page);
  const collapsed = await progressOf(ctx, tab);
  for (const block of collapsed) await setProgressOpen(ctx, tab, block.request, true);
  const expanded = await progressOf(ctx, tab);
  for (const block of collapsed) await setProgressOpen(ctx, tab, block.request, false);
  const items = (await transcriptItems(ctx, tab)).filter((item) => item.kind !== 'note');
  const strip = (list) => list.map(({ expanded: _open, ...rest }) => rest);
  return { receipts: await receiptsOf(ctx, tab), collapsed: strip(collapsed), expanded: strip(expanded),
    order: items.map((item) => `${item.kind}${item.request ? item.request : ''}${item.actions ? '*' : ''}`),
    inside: items.flatMap((item) => item.inside).map((part) => `${part.kind}:${part.text}`) };
}

/** @brief TB-08：回执的文字与录下的写入一一对应；合并会话里在 Register a request 卡下面、Create a task 卡之前。 */
function teamReceipts(steps, snap) {
  const id = resultsOf(steps, 'session.create')[0].sessionId;
  const recorded = eventsOf(steps, 'mori.receipt', id);
  const final = eventsOf(steps, 'mori.board', id).at(-1);
  const want = recorded.map((r) => ({ kind: r.kind, request: r.request, text: receiptLine(r) }));
  const got = snap.receipts.map((r) => ({ kind: r.kind, request: r.request, text: r.text }));
  record('TB-08 replay tb-team: each recorded board write (mori.receipt) shows exactly one receipt line with the §13.2 '
    + 'text ("Request 1 registered · <title>"); there is no receipt without a write, and every registered request on '
    + 'the board has its receipt', JSON.stringify(got) === JSON.stringify(want) && want.length > 0
    && final.requests.every((r) => got.some((x) => x.kind === 'registered' && x.request === r.no)),
  JSON.stringify({ got, want }));
  const at = (prefix) => snap.inside.findIndex((text) => text.startsWith(prefix));
  const receipt = at(`receipt:${want[0]?.text}`);
  record('TB-08 replay tb-team: in the merged session the receipt sits right under the "Register a request" tool '
    + 'card that wrote it and before the "Create a task" card that follows',
  at('tool:Register a request') >= 0 && receipt === at('tool:Register a request') + 1
    && (at('tool:Create a task') < 0 || receipt < at('tool:Create a task')), JSON.stringify(snap.inside));
}

/**
 * @brief TB-37：每次看到的标题行与 task 行都等于用录下的某个 TaskBoard 视图算出的文字（标题、状态、task 的持有者、
 *        在做什么与 §13.8 的标题）；时长按格式。返回不符合的行。
 */
function rowProblems(seen, boards, holders, cwd) {
  const problems = [];
  for (const item of seen.rows) {
    if (item.request !== undefined) {
      const views = boards.map((b) => b.requests.find((r) => r.no === item.request)).filter(Boolean);
      const ok = views.some((r) => {
        const head = `Request ${r.no} · ${r.title} · ${stateText(r.state, holders)} · `;
        return r.state === item.state && item.text.startsWith(head) && (r.closedAt === null
          ? /^(<1 min|\d+ min|\d+ h \d+ min)$/.test(item.text.slice(head.length))
          : item.text.slice(head.length) === durationText(r.closedAt - r.createdAt));
      });
      if (!ok) problems.push(`title "${item.text}" (${item.state})`);
      continue;
    }
    const texts = boards.flatMap((b) => b.requests.flatMap((r) => r.tasks.filter((t) => t.id === item.task
      && t.phase === item.phase).map((t) => rowText(t, b, holders, cwd))));
    if (!texts.includes(item.text)) problems.push(`row "${item.text}" (${item.phase}) not in ${texts.slice(0, 3)}`);
  }
  return problems;
}

/** @brief 一串值去掉相邻重复的。 */
const runs = (list) => list.filter((value, i) => i === 0 || value !== list[i - 1]);
/** @brief small 是否是 big 的子序列。 */
const subsequence = (small, big) => {
  let i = 0;
  for (const value of big) if (value === small[i]) i += 1;
  return i === small.length;
};

/** @brief TB-37 tb-team：位置、实时的行、状态的先后、关闭后的样子、交接链与结论。 */
async function teamProgress(page, steps, snap) {
  const created = resultsOf(steps, 'session.create')[0];
  const holders = created.team.holders;
  const boards = boardsOf(steps);
  const seen = await watched(page);
  const order = snap.order;
  const progress = order.findIndex((kind) => kind.startsWith('progress1'));
  const reply = progress - 1;
  record('TB-37 replay tb-team: the progress summary hangs right under the reply of the turn that registered the '
    + 'request (your message, the reply with its tool cards and receipt, then the summary) and that turn\'s reply '
    + 'actions are below the summary', progress > 1 && order[reply] === 'assistant' && order[progress] === 'progress1*'
    && order.slice(0, reply).includes('user'), JSON.stringify(order));
  const problems = rowProblems(seen, boards, holders, created.cwd);
  const running = seen.rows.filter((r) => r.phase === 'running');
  record('TB-37 replay tb-team: every title line and task row seen live equals the text computed from a recorded '
    + 'TaskBoard view ("Request 1 · <title> · <state> · <duration>", "T1 <title> · <role> · <doing>"), and running '
    + 'rows show the latest tool call with the §13.8 title rule (Run …, Read …, Edit …, Hand off …)',
  problems.length === 0 && running.length > 0, oneLine(JSON.stringify({ problems: problems.slice(0, 5),
    running: [...new Set(running.map((r) => r.text))] }), 1500));
  const recorded = runs(eventsOf(steps, 'mori.board', created.sessionId).map((b) => b.requests[0]?.state)
    .filter(Boolean));
  const live = runs(seen.rows.filter((r) => r.request === 1).map((r) => r.state));
  record('TB-37 replay tb-team: the request state updates live in the recorded order (the states seen are a '
    + 'subsequence of the recorded ones, ending in the final state), e.g. Running → With Mori → Done',
  live.length >= 2 && subsequence(live, recorded) && live.at(-1) === recorded.at(-1),
  JSON.stringify({ live, recorded }));
  teamClosed(boards.at(-1), snap, holders, created.cwd);
}

/** @brief TB-37：需求关闭后 Done/Failed/Cancelled、时长停在 closedAt、折叠时没有 task 行与 Running；展开后结论与交接链。 */
function teamClosed(board, snap, holders, cwd) {
  const request = board.requests[0];
  const title = `Request 1 · ${request.title} · ${stateText(request.state, holders)} · `
    + `${durationText(request.closedAt - request.createdAt)}`;
  const [collapsed] = snap.collapsed;
  const [open] = snap.expanded;
  const chains = Object.fromEntries(request.tasks.filter((t) => t.chain.length).map((t) => [t.id, chainLine(t.chain)]));
  record('TB-37 replay tb-team: after the request closes the summary reads "Request 1 · <title> · Done · <duration up '
    + 'to closedAt>", has no task rows and no "Running" when collapsed; expanded it lists every task with its '
    + 'final phase, the handoff chain of each task (each baton "<role>: <first sentence>", the close baton by Mori) '
    + 'and "Conclusion: <conclusion>"',
  ['done', 'failed', 'cancelled'].includes(request.status) && collapsed?.title === title
    && collapsed.tasks.length === 0 && !collapsed.title.includes('Running')
    && JSON.stringify(open?.tasks.map((t) => t.text)) === JSON.stringify(request.tasks.map((t) => rowText(t, board,
      holders, cwd))) && JSON.stringify(open?.chains) === JSON.stringify(chains)
    && open?.conclusion === `Conclusion: ${request.conclusion}`,
  oneLine(JSON.stringify({ title, collapsed, open, chains }), 1500));
}

/** @brief TB-53 tb-team：/team 进入做完为止；once → always → once（需求还开着）；汇报那一轮结束时回到 Team: Off。 */
async function teamSwitchChecks(page, steps, states) {
  const final = await switchNow(page);
  const modes = resultsOf(steps, 'session.setTeam').map((v) => v.mode);
  record('TB-53 replay tb-team: "/team <text>" turns the switch to "Team: Until done" (hover "Team mode ends when open '
    + 'requests are done", aria-checked true); a click sends session.setTeam on → "Team: On"; a click with the '
    + 'request still open sends session.setTeam off and the switch shows "Team: Until done", not "Team: Off"',
  states.map((s) => s.mode).join() === 'once,always,once' && states.every((s) => sameSwitch(s, SWITCH[s.mode]))
    && modes.join() === 'always,once', JSON.stringify({ states, modes }));
  record('TB-53 replay tb-team: once the request is done and the report turn ends, the switch returns to "Team: Off" '
    + 'by itself (mori.team_state), without a line in the transcript',
  final.mode === 'off' && sameSwitch(final, SWITCH.off), JSON.stringify(final));
}

/** @brief tb-team 重启后：打开同一个会话，回执、进展摘要与条目的先后与重启前相同（TB-08、TB-37）。 */
async function teamReopen(page, fx, before) {
  const steps = await load(page, fx, { part: 'after' });
  const open = commandsOf(steps).find((c) => c.type === 'session.open');
  await rowOf(page, open.sessionFile).click();
  await waitReady(page);
  await page.locator(`${PANE} [data-testid="progress"]`).first().waitFor({ timeout: 20000 });
  const after = await streamSnapshot(page);
  await shot(page, 'tb-team-reopened');
  record('TB-08 replay tb-team reopened: after a restart the reopened session shows the same receipts in the same '
    + 'place (same order of messages, tool cards, receipts and summary as live)',
  JSON.stringify(after.receipts) === JSON.stringify(before.receipts)
    && JSON.stringify(after.inside) === JSON.stringify(before.inside)
    && JSON.stringify(after.order) === JSON.stringify(before.order),
  oneLine(JSON.stringify({ before: before.order, after: after.order, inside: after.inside }), 1500));
  record('TB-37 replay tb-team reopened: the progress summary reads the same as before the restart, collapsed and '
    + 'expanded (title, state, duration, task rows, chains, conclusion)',
  JSON.stringify(after.collapsed) === JSON.stringify(before.collapsed)
    && JSON.stringify(after.expanded) === JSON.stringify(before.expanded),
  oneLine(JSON.stringify({ before: before.collapsed, after: after.collapsed }), 1500));
  await finish(page, 'TB-37', 'tb-team after the restart', steps);
}

/**
 * @brief TB-08（2026-10-26 走查 M18，docs/v0/screens/chat.md"步骤组"）：一轮结束后思考块与工具卡折成"{n} steps"，写回执的
 *        工具卡跟着收起，回执照常显示（页面里仍紧跟在它的卡后面，snap.inside 已查）；点开全部步骤组后卡都显示、回执不变。
 */
async function foldedReceipts(page, name, count) {
  const folded = await stepsState(page, PANE);
  await expandSteps(page, PANE);
  const opened = await stepsState(page, PANE);
  record(`TB-08 replay ${name}: when a finished turn's thinking and tool cards fold into "<n> steps" rows (button, `
    + 'aria-expanded false) the tool cards that wrote receipts are hidden with them, but every receipt stays visible; '
    + 'expanding the rows shows the cards and the same receipts', folded.rows.length > 0
    && folded.rows.every((row) => row.expanded === 'false' && /^\d+ steps?( · \d+ failed)?$/.test(row.text))
    && folded.cards.shown === 0 && folded.receipts.hidden === 0 && folded.receipts.shown === count && count > 0
    && opened.cards.hidden === 0 && opened.receipts.shown === count, oneLine(JSON.stringify({ folded, opened }), 1500));
}

/** @brief tb-team 的全部检查。 */
async function teamFixture(page, fx) {
  const { steps, states } = await teamRun(page, fx);
  const snap = await streamSnapshot(page);
  await shot(page, 'tb-team');
  teamReceipts(steps, snap);
  await foldedReceipts(page, 'tb-team', snap.receipts.length);
  await teamProgress(page, steps, snap);
  await teamSwitchChecks(page, steps, states);
  await finish(page, 'TB-08', 'tb-team before the restart', steps);
  await teamReopen(page, fx, snap);
}

// ---------- TB-08、TB-37：tb-receipts ----------

/** @brief tb-receipts：Allow all，照录制发三条消息（/team、补充、撤销），每条之前等上一轮放完、对话空闲。 */
async function receiptsRun(page, fx) {
  const steps = await load(page, fx);
  const commands = commandsOf(steps);
  await openFolder(page);
  await allowAll(page);
  for (const [i, command] of commands.entries()) {
    if (command.type !== 'session.prompt') continue;
    await untilPlayed(page, i, `segment ${i}`);
    await page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'false', PANE,
      { timeout: 30000 });
    await typeAndSend(page, command.team === 'once' ? `/team ${command.text}` : command.text);
  }
  await untilPlayed(page, commands.length, 'the whole tb-receipts run');
  await sleep(800);
  return steps;
}

/** @brief TB-08：三种写入各一行回执，文字按 §13.2（补充的原话超过 120 字符截断、悬停看全文），各在写它的工具卡下面。 */
async function receiptKinds(page, steps, snap) {
  const id = resultsOf(steps, 'session.create')[0].sessionId;
  const recorded = eventsOf(steps, 'mori.receipt', id);
  const want = recorded.map((r) => ({ kind: r.kind, request: r.request, text: receiptLine(r) }));
  const got = snap.receipts.map((r) => ({ kind: r.kind, request: r.request, text: r.text }));
  const added = recorded.find((r) => r.kind === 'added');
  const hover = snap.receipts.find((r) => r.kind === 'added')?.title;
  record('TB-08 replay tb-receipts: the three writes each show one receipt line — "Request 1 registered · <title>", '
    + '"Added to request 1: “<the first 120 characters of your words>…”" (hover shows the whole quote) and '
    + '"Request 1 cancelled" — in the order they were written',
  JSON.stringify(got) === JSON.stringify(want) && got.map((r) => r.kind).join() === 'registered,added,cancelled'
    && [...added.quote].length > 120 && got[1].text.endsWith('…”') && hover === `Added to request 1: “${added.quote}”`,
  oneLine(JSON.stringify({ got, hover }), 1200));
  const at = (prefix) => snap.inside.findIndex((text) => text.startsWith(prefix));
  const under = [['tool:Register a request', want[0]], ['tool:Add to request 1', want[1]],
    ['tool:Cancel request 1', want[2]]].map(([card, receipt]) => at(`receipt:${receipt.text}`) === at(card) + 1);
  record('TB-08 replay tb-receipts: in the merged session each receipt sits right under the tool card that wrote it '
    + '("Register a request", "Add to request 1", "Cancel request 1")', under.every(Boolean),
  oneLine(JSON.stringify({ under, inside: snap.inside }), 1200));
}

/** @brief TB-37：撤销后摘要停在 Cancelled（时长停在 closedAt），折叠时没有 task 行，展开后 task 为 Cancelled、结论是理由。 */
async function receiptsProgress(page, steps, snap) {
  const created = resultsOf(steps, 'session.create')[0];
  const boards = boardsOf(steps);
  const board = boards.at(-1);
  const request = board.requests[0];
  const holders = created.team.holders;
  const [collapsed] = snap.collapsed;
  const [open] = snap.expanded;
  const problems = rowProblems(await watched(page), boards, holders, created.cwd);
  record('TB-37 replay tb-receipts: after the cancel the summary reads "Request 1 · <title> · Cancelled · <duration up '
    + 'to closedAt>" with no task rows when collapsed; expanded the task reads "T1 <title> · Cancelled" and the '
    + 'conclusion is the cancel reason; every row seen live matches a recorded view',
  request.status === 'cancelled' && collapsed?.state === 'cancelled' && collapsed.title === `Request 1 · `
    + `${request.title} · Cancelled · ${durationText(request.closedAt - request.createdAt)}`
    && collapsed.tasks.length === 0 && JSON.stringify(open?.tasks.map((t) => t.text))
    === JSON.stringify(request.tasks.map((t) => `${t.id} ${t.title} · Cancelled`))
    && open.conclusion === `Conclusion: ${request.conclusion}` && problems.length === 0,
  oneLine(JSON.stringify({ collapsed, open, problems: problems.slice(0, 4) }), 1500));
}

/** @brief tb-receipts 的全部检查。 */
async function receiptsFixture(page, fx) {
  const steps = await receiptsRun(page, fx);
  const snap = await streamSnapshot(page);
  await shot(page, 'tb-receipts');
  await receiptKinds(page, steps, snap);
  await foldedReceipts(page, 'tb-receipts', snap.receipts.length);
  await receiptsProgress(page, steps, snap);
  await finish(page, 'TB-08', 'tb-receipts', steps);
}

// ---------- TB-34、TB-37：tb-approval ----------

/** @brief tb-approval：/team 之后等后台批准卡；查卡、进展摘要与侧栏；问进展那一轮结束后卡还在；Alt+1 允许。 */
async function approvalFixture(page, fx) {
  const steps = await load(page, fx);
  const id = resultsOf(steps, 'session.create')[0].sessionId;
  const commands = commandsOf(steps);
  const asked = eventsOf(steps, 'mori.team_approval_request', id);
  const css = `${PANE} [data-testid="approval-card"][data-request="${asked[0].requestId}"]`;
  await approvalFirst(page, commands, asked[0], css);
  const second = commands.findLastIndex((c) => c.type === 'session.prompt');
  await untilPlayed(page, second, 'the first turn');
  await page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'false', PANE,
    { timeout: 30000 });
  await typeAndSend(page, commands[second].text);
  await untilPlayed(page, commands.findIndex((c) => c.type === 'approval.answer'), 'the progress turn');
  await page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'false', PANE,
    { timeout: 30000 });
  const settled = await page.locator(css).count();
  await page.locator(PANE).locator('.composer textarea').focus();
  await page.keyboard.press('Alt+1');
  await page.locator(css).waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  const gone = await page.locator(css).count();
  await answerLater(page, commands);
  await untilPlayed(page, commands.length, 'the whole tb-approval run');
  const seen = await watched(page);
  await shot(page, 'tb-approval');
  approvalAfter(seen, { settled, gone, asked, steps, id });
  await finish(page, 'TB-34', 'tb-approval', steps);
}

/** @brief Open folder…、/team，等第一张后台卡与它的 task 行，查卡、task 行、侧栏与权限菜单。 */
async function approvalFirst(page, commands, event, css) {
  await openFolder(page);
  await typeAndSend(page, `/team ${commands.find((c) => c.type === 'session.prompt').text}`);
  await page.locator(css).waitFor({ timeout: 120000 });
  const rowCss = `${PANE} [data-testid="progress-task"][data-task="${event.task}"][data-phase="approval"]`;
  await page.locator(rowCss).waitFor({ timeout: 30000 }).catch(() => {});
  const card = (await watched(page)).cards.find((c) => c.request === event.requestId);
  const row = await page.locator(rowCss).textContent({ timeout: 1000 }).catch(() => null);
  const status = await page.locator('.session-item.active [data-testid="session-status"]').getAttribute('data-status')
    .catch(() => null);
  const note = await permissionNote(page);
  approvalCard(card, event, { row, status, note });
}

/** @brief 权限菜单的底部说明（打开再关上）。 */
async function permissionNote(page) {
  await page.locator(PANE).getByTestId('permission-button').click();
  const text = await page.getByTestId('permission-menu').locator('.menu-note').textContent().catch(() => null);
  await page.keyboard.press('Escape');
  return text;
}

/** @brief TB-34 / TB-37：第一张后台卡出现时的样子。 */
function approvalCard(card, event, { row, status, note }) {
  const want = `${label(event.role)} · ${event.task} · ${event.taskTitle}`;
  record(`TB-34 replay tb-approval: the task instance's ${event.toolName} shows a background approval card in the `
    + `user session's pane with the attribution "${want}" (data-agent ${event.role}, data-task ${event.task}), and `
    + 'its request id is "<instance id>:approval-<n>", which cannot clash with the dialog\'s "approval-<n>"',
  card?.attribution === want && card.agent === event.role && card.task === event.task && card.tool === event.toolName
    && card.request === `${event.instance}:${event.requestId.split(':').pop()}` && /:approval-\d+$/.test(card.request),
  JSON.stringify({ card, event: { ...event, args: undefined } }));
  record('TB-34 replay tb-approval: while the card is pending the sidebar row shows waiting for approval '
    + '(data-status approval), and the permission menu note reads "Applies to all agents in this session. New '
    + 'sessions start at Ask each time."', status === 'approval' && note === PERMISSION_NOTE,
  JSON.stringify({ status, note }));
  record('TB-37 replay tb-approval: the task row reads "Waiting for your approval" while its card is pending',
    row === `${event.task} ${event.taskTitle} · ${label(event.role)} · Waiting for your approval`, String(row));
}

/** @brief 录制里之后的每张卡：等它出现，Alt+1。 */
async function answerLater(page, commands) {
  const answers = commands.map((c, i) => [c, i]).filter(([c]) => c.type === 'approval.answer').slice(1);
  for (const [command, index] of answers) {
    await untilPlayed(page, index, `the card ${command.requestId}`);
    const css = `${PANE} [data-testid="approval-card"][data-request="${command.requestId}"]`;
    await page.locator(css).waitFor({ timeout: 30000 });
    await page.keyboard.press('Alt+1');
    await page.locator(css).waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  }
}

/** @brief TB-34：一轮结束不清掉卡、Alt+1 允许、TaskBoard 工具从不出卡。 */
function approvalAfter(seen, { settled, gone, asked, steps, id }) {
  const answers = commandsOf(steps).filter((c) => c.type === 'approval.answer');
  const teamCalls = eventsOf(steps, 'tool_execution_start', id).filter((e) => TEAM_TOOLS.includes(e.toolName));
  record('TB-34 replay tb-approval: the card is not cleared when a dialog turn ends (a progress message was sent and '
    + 'answered while it was pending); Alt+1 allows it (approval.answer allow with its request id) and it goes away',
  settled === 1 && gone === 0 && answers[0]?.decision === 'allow' && answers[0].requestId === asked[0].requestId,
  JSON.stringify({ settled, gone, answer: answers[0] }));
  record('TB-34 replay tb-approval: under "Ask each time" the TaskBoard tools never show a card — the merged '
    + `session's ${teamCalls.length} TaskBoard calls (${[...new Set(teamCalls.map((e) => e.toolName))]}) ran `
    + 'without one; the only cards are the instances\' recorded ones', teamCalls.length > 0
    && seen.cards.every((c) => !TEAM_TOOLS.includes(c.tool) && asked.some((a) => a.requestId === c.request)),
  JSON.stringify(seen.cards));
}

// ---------- 执行 ----------

/** 每个 TaskBoard 录制：名字、覆盖的编号、检查 */
const TB_FIXTURES = [
  { name: 'tb-ask', ids: ['TB-04', 'TB-53'], run: askFixture },
  { name: 'tb-team', ids: ['TB-08', 'TB-37', 'TB-53'], run: teamFixture },
  { name: 'tb-receipts', ids: ['TB-08', 'TB-37'], run: receiptsFixture },
  { name: 'tb-approval', ids: ['TB-34', 'TB-37'], run: approvalFixture },
];

/** @brief 跑一组检查；出错时记一条失败；之后记这一组的页面错误。 */
async function guarded(page, errors, { id, label: name }, run) {
  const before = errors.length;
  try {
    await run();
  } catch (error) {
    record(`${id} replay ${name}: flow`, false, oneLine(error, 600));
    await shot(page, `${name.replace(/\W+/g, '-')}-error`);
  }
  const mine = errors.slice(before);
  record(`${id} replay ${name}: the page has no errors`, mine.length === 0, mine.slice(0, 5).join(' | '));
}

const chosenTb = TB_FIXTURES.filter((f) => !only || only.includes(f.name));
const chosen03 = TB03.filter(([dir, name]) => !only || only.includes(`${dir}/${name}`));
const present = chosenTb.filter((f) => existsSync(fixturePath('tb', f.name)));
for (const f of chosenTb.filter((item) => !present.includes(item))) {
  for (const id of f.ids) {
    record(`${id} replay fixture missing: tests/fixtures/tb/${f.name}.json (record it with tb-record.mjs)`, false,
      'no real recording yet');
  }
}
if (present.length || chosen03.length) {
  await buildHarness();
  const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
    env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
      MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-tb-')) } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  for (const item of chosen03) {
    await guarded(page, errors, { id: 'TB-03', label: `${item[0]}/${item[1]}` }, () => tb03(page, item));
  }
  for (const f of present) {
    const fx = readFixture('tb', f.name);
    await guarded(page, errors, { id: f.ids[0], label: f.name }, () => f.run(page, fx, app));
  }
  await app.close();
}
process.exitCode = write(only ? 'tb-partial-replay.json' : 'tb-replay.json') ? 0 : 1;
