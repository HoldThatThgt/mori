// 平行 Agent 与 TaskBoard 的回放测试（docs/specs/parallel-agents-taskboard.md §17.1、§17.2 的回放层）：在 Electron 里载入
// 真正的界面，用回放进程桥（tests/ui/harness）回放从真实会话录下的 tests/fixtures/tb/*.json（tb-record.mjs 录制，模型是
// 负责人的 DeepSeek 与 GLM），以及 m1–m6 的一组录制。测试像你一样操作（Open folder…、发录制里的消息、/task、在模型菜单里点
// Task mode 一行、
// 权限菜单、批准卡上的 Alt+1），回放桥核对界面发出的每条命令都与录制一致；再按 docs/v1/screens/team-*.md 检查界面：
//   TB-03：m1–m6 的录制在合成的空 TeamState/BoardView 下照常回放：模型按钮一直是 off（没有 "Task mode"），没有回执、
//     进展摘要、Stop agents
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
//   TB-53（tb-ask、tb-team；2026-10-26 起开关在模型菜单里，docs/v1/screens/team-switch.md）：模型按钮上的
//     "Task mode · <模型 id>" 与 data-team-mode、Task mode 一行的 aria-checked 与第二行、三种点击（off → always → off、
//     once → always → once，菜单不关）、打开中与后台进程退出时切不了、做完为止在汇报的那一轮结束时回到 off；
//     切换失败的一行在菜单里与输入框下面一行上方（synthetic：回放桥 failNext 让 session.setTeam 失败，不占回放顺序）。
//   TB-58（tb-ask、tb-team）：每次模式改变对话流里一行（Task mode on / on until done / off），/task 进入时在你的消息之前，
//     重新打开后一样（2026-10-26；录制要在这之后重录，才有 mori.team_mode 事件）。
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
import { PICK_ERROR, placeProblems, popupBox } from './m6-helpers.mjs';
import { expandSteps, foldSteps, showStep, stepsState } from './page.mjs';
import { modeNoticesOf, progressOf, receiptsOf, setProgressOpen, transcriptItems } from './tb-helpers.mjs';
import { expectedTitle, label } from './tb-real-helpers.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-tb');
const shots = join(appRoot, 'test-results/tb-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** Task mode 一行在三种模式下的 aria-checked 与第二行（§13.1）；<create role> 是基座 Mori */
const SWITCH = {
  off: { checked: 'false', hint: null },
  always: { checked: 'true', hint: 'Messages go to Mori first' },
  once: { checked: 'true', hint: 'Until done · Ends when open requests are done' },
};
/** 对话流里模式提示的文字（§13.11，TB-58） */
const NOTICE = { always: 'Task mode on', once: 'Task mode on until done', off: 'Task mode off' };
/** 协作模式下模型按钮悬停的第二行（§12.11） */
const TASK_PICKS = 'Task mode picks the model for each agent';
/** 当前一栏的模型按钮、模型菜单、菜单里的 Task mode 一行 */
const BUTTON = `${PANE} [data-testid="model-button"]`;
const MENU = `${PANE} [data-testid="model-menu"]`;
const ROW = `${MENU} [data-testid="team-switch"]`;
/** 当前一栏切换失败的一行（菜单开着时在菜单里，关着时在输入框下面一行上方；team-switch.md“切换失败”） */
const TEAM_ERROR = `${PANE} [data-testid="team-error"]`;
/** 回放桥 failNext 让 session.setTeam 失败时的原文（synthetic）：菜单开着时点 Task mode 一行、菜单关着时 /task on */
const TEAM_FAIL = { menu: 'Synthetic: session.setTeam failed (menu)', command: 'Synthetic: session.setTeam failed' };
/** @brief 切换失败那一行的文字（§13.1）。 */
const teamFailText = (message) => `Couldn’t change task mode: ${message}`;
/**
 * 本测试用 failNext 注入的失败原文，每注入一次记一条：界面照例（异常分支记错误日志）为它写一条
 * "[renderer] session.setTeam failed: <原文>"（state/bridge.ts describe），"the page has no errors" 每次注入只扣掉
 * 一条（同 m1-replay.mjs），多的照样算错。
 */
const injected = [];
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
 * @brief 在页面里装一个 MutationObserver，只在变化时记下当前一栏：模型按钮上的模式（data-team-mode、看得到的字、
 *        是否 aria-disabled）、显示"Starting…"时能不能切 Task mode（opening：看到几次、其中几次模型按钮可用或模型菜单开着）、
 *        进展摘要的标题行与 task 行、出现过的批准卡，以及回执、进展摘要、Stop agents、批准卡归属行、右栏说明、模式提示
 *        （TB-58）出现过的最多个数。
 *        结果在 window.__tbWatch。
 */
function watchTeam(page) {
  return page.evaluate((pane) => {
    const seen = { switches: [], rows: [], cards: [], max: {}, opening: { seen: 0, usable: 0 } };
    const last = new Map();
    const push = (list, key, item) => {
      const value = JSON.stringify(item);
      if (last.get(key) === value) return;
      last.set(key, value);
      list.push({ t: Date.now(), ...item });
    };
    const counts = { receipt: '[data-testid="receipt"]', progress: '[data-testid="progress"]',
      stopTeam: '[data-testid="stop-team"]', attribution: '[data-testid="approval-attribution"]',
      teamNote: '[data-testid="team-changes-note"]', modeNotice: '[data-kind="team-mode"]' };
    const scan = () => {
      const root = document.querySelector(pane);
      if (!root) return;
      const button = root.querySelector('[data-testid="model-button"]');
      if (button) {
        push(seen.switches, 'switch', { mode: button.dataset.teamMode ?? null, text: button.textContent.trim(),
          disabled: button.getAttribute('aria-disabled') === 'true' });
      }
      if (root.querySelector('[data-testid="not-ready"]')?.textContent === 'Starting…') {
        seen.opening.seen += 1;
        const open = button && button.getAttribute('aria-disabled') !== 'true';
        if (open || root.querySelector('[data-testid="model-menu"]')) seen.opening.usable += 1;
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

/** @brief 让回放桥的下一条界面命令以 text 失败（synthetic，不占回放顺序），并记下界面因此该写的那条错误日志。 */
async function failNext(page, text) {
  injected.push(text);
  await page.evaluate((message) => { window.__replay.failNext = message; }, text);
}

/** @brief 页面错误里去掉每次注入的那一条（"[renderer] <命令> failed: <原文>"，各扣一次）并清空记录，剩下的是真的报错。 */
function unexpectedErrors(errors) {
  const left = [...errors];
  const ours = (line, text) => /^\[renderer\] [\w.]+ failed: /.test(line) && line.endsWith(` failed: ${text}`);
  for (const text of injected.splice(0)) {
    const index = left.findIndex((line) => ours(line, text));
    if (index >= 0) left.splice(index, 1);
  }
  return left;
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

/** @brief TB-03：一个 m1–m6 的录制照常回放，模型按钮一直是 off（没有 "Task mode"），没有任何协作的元素。 */
async function tb03(page, [dir, name, part]) {
  const fx = readFixture(dir, name);
  const steps = await load(page, fx, { part, speed: 6, maxGap: 400 });
  await driveGeneric(page, steps);
  const seen = await watched(page);
  const off = seen.switches.every((s) => s.mode === 'off' && !s.text.startsWith('Task mode'));
  const status = await page.evaluate(() => window.__replay.status);
  const total = commandsOf(steps).length;
  await shot(page, `tb03-${dir}-${name}`);
  record(`TB-03 replay ${dir}/${name}${part ? ` (${part})` : ''}: the recording replays as before under the synthetic `
    + `empty TeamState/BoardView (all ${total} commands match); the model button stays in off mode `
    + '(data-team-mode off, no "Task mode" on it) throughout; no receipt, no progress summary, no Stop agents, no '
    + 'approval attribution, no mode notice line',
  status.errors.length === 0 && status.cursor === total && seen.switches.length > 0 && off
    && Object.values(seen.max).every((n) => n === 0),
  oneLine(JSON.stringify({ errors: status.errors, cursor: status.cursor, total, max: seen.max,
    switches: [...new Set(seen.switches.map((s) => `${s.mode}|${s.text}|${s.disabled}`))] }), 600));
}

// ---------- TB-04、TB-53：tb-ask ----------

/** @brief tb-ask 的开头：打开中切不了 Task mode；就绪后是 off；发录制里的问题，等这一轮放完。 */
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
    + 'model button stays in off mode during the ask; the sidebar lists only user sessions (no instance session file)',
  seen.max.receipt === 0 && seen.max.progress === 0 && seen.cards.length === 0 && rows.length >= 1
    && rows.every((file) => file && !/[\\/]teams[\\/]/.test(file) && !/\.ask\./.test(file))
    && seen.switches.every((s) => s.mode === 'off'), oneLine(JSON.stringify({ max: seen.max, rows }), 600));
}

/** @brief 当前一栏模型按钮上的模式（不打开菜单）：data-team-mode、看得到的字、悬停、aria-disabled。 */
const buttonNow = (page) => page.locator(BUTTON).evaluate((el) => ({ mode: el.dataset.teamMode ?? null,
  text: el.textContent.trim(), title: el.getAttribute('title') ?? '',
  disabled: el.getAttribute('aria-disabled') === 'true' }));

/** @brief 打开当前一栏的模型菜单（开着时不动），等 Task mode 一行出现。 */
async function openMenu(page) {
  if (!(await page.locator(MENU).count())) await page.locator(BUTTON).click();
  await page.locator(ROW).waitFor({ timeout: 10000 });
}

/** @brief 关上当前一栏的模型菜单：开着时再点一下模型按钮（不按 Esc，免得停掉回放里的回复）。 */
async function closeMenu(page) {
  if (await page.locator(MENU).count()) await page.locator(BUTTON).click();
  await page.locator(MENU).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

/**
 * @brief 当前一栏 Task mode 的样子：模型按钮（buttonNow）加菜单里的这一行（data-mode、aria-checked、role、读屏名称、
 *        第二行、可不可用）；打开菜单读，keepOpen 为假时读完关上。
 */
async function switchNow(page, keepOpen = false) {
  await openMenu(page);
  const row = await page.locator(ROW).evaluate((el) => ({ rowMode: el.dataset.mode,
    checked: el.getAttribute('aria-checked'), role: el.getAttribute('role'), label: el.getAttribute('aria-label'),
    hint: el.querySelector('[data-testid="team-hint"]')?.textContent ?? null,
    rowDisabled: el.disabled || el.getAttribute('aria-disabled') === 'true' }));
  const state = { ...(await buttonNow(page)), ...row };
  if (!keepOpen) await closeMenu(page);
  return state;
}

/** @brief 在模型菜单里点 Task mode 一行，等模型按钮的 data-team-mode 变成 want；菜单不关。 */
async function clickRow(page, want) {
  await openMenu(page);
  await page.locator(ROW).click();
  await page.waitForFunction(({ css, mode }) => document.querySelector(css)?.dataset.teamMode === mode,
    { css: BUTTON, mode: want }, { timeout: 10000 });
}

/**
 * @brief Task mode 的样子与表相同（§13.1、§12.11）：这一行是 menuitemcheckbox、读屏名称 "Task mode"、aria-checked 与
 *        第二行按模式；off 时模型按钮上没有 "Task mode"，打开时是 "Task mode · <模型 id>"、悬停第二行 TASK_PICKS。
 */
const sameSwitch = (s, want) => s.rowMode === s.mode && s.role === 'menuitemcheckbox' && s.label === 'Task mode'
  && s.checked === want.checked && s.hint === want.hint && !s.rowDisabled
  && (s.mode === 'off' ? !s.text.startsWith('Task mode')
    : s.text.startsWith('Task mode · ') && s.title.split('\n')[1] === TASK_PICKS);

/** @brief TB-53（tb-ask）：打开中切不了；off → always → off 两次点击（菜单不关）；两种状态的按钮与这一行。 */
async function askSwitch(page, steps) {
  const { opening } = await watched(page);
  const states = [await switchNow(page, true)];
  await clickRow(page, 'always');
  states.push(await switchNow(page, true));
  await clickRow(page, 'off');
  states.push(await switchNow(page, true));
  const focused = await page.evaluate((css) => document.activeElement === document.querySelector(css), ROW);
  await closeMenu(page);
  record('TB-53 replay tb-ask: while the session is opening ("Starting…") task mode cannot be switched: no usable '
    + 'model button and no model menu', opening.seen > 0 && opening.usable === 0, JSON.stringify(opening));
  record('TB-53 replay tb-ask: off — the model button without "Task mode", the Task mode row unchecked with no second '
    + 'line; a click sends session.setTeam on → "Task mode · <model id>", the row checked with "Messages go to Mori '
    + 'first"; a second click sends session.setTeam off and, with no open request, returns to off; the menu stays '
    + 'open with the focus on the row; no confirmation',
  states.map((s) => s.mode).join() === 'off,always,off' && states.every((s) => sameSwitch(s, SWITCH[s.mode]))
    && focused && await page.getByTestId('confirm-dialog').count() === 0, JSON.stringify({ states, focused }));
  await finish(page, 'TB-53', 'tb-ask', steps);
}

/** @brief TB-53：后台进程退出（界面没准备好）时模型按钮不可用、点了不开菜单，仍是最后知道的模式。 */
async function exitedSwitch(page) {
  const before = await buttonNow(page);
  await page.evaluate(() => window.__replay.exit(1));
  await page.waitForFunction((css) => document.querySelector(css)?.getAttribute('aria-disabled') === 'true',
    BUTTON, { timeout: 10000 }).catch(() => {});
  const after = await buttonNow(page);
  await page.locator(BUTTON).click({ force: true }).catch(() => {});
  await sleep(300);
  const menu = await page.locator(MENU).count();
  record('TB-53 replay: after the kernel exits the model button is aria-disabled, a click opens no model menu (so task '
    + 'mode cannot be switched), and it keeps the last known mode and text', after.disabled && !before.disabled
    && after.mode === before.mode && after.text === before.text && menu === 0, JSON.stringify({ before, after, menu }));
}

/** @brief 开着的模型菜单里切换失败那一行：文字、role、是不是紧跟在 Task mode 一行下面；这一行的模式、切换中、焦点。 */
const menuError = (page) => page.locator(MENU).evaluate((menu) => {
  const row = menu.querySelector('[data-testid="team-switch"]');
  const line = menu.querySelector('[data-testid="team-error"]');
  return { text: line?.textContent ?? null, role: line?.getAttribute('role') ?? null,
    underRow: Boolean(line) && line.previousElementSibling === row, mode: row?.dataset.mode ?? null,
    pending: row?.getAttribute('aria-disabled') === 'true', focused: document.activeElement === row };
});

/** @brief 菜单关着时切换失败那一行（输入框下面一行上方）：文字、role、在不在模型菜单里。 */
const lineError = (page) => page.locator(TEAM_ERROR).evaluate((el) => ({ text: el.textContent,
  role: el.getAttribute('role'), inMenu: Boolean(el.closest('[data-testid="model-menu"]')) }));

/**
 * @brief TB-53（tb-ask，synthetic：回放桥 failNext 让 session.setTeam 失败，不占回放顺序）：切换失败的一行
 *        "Couldn’t change task mode: <原文>"（role=alert）。菜单开着时紧跟在 Task mode 一行下面，这一行回到 off、
 *        焦点留在它上面；菜单关着时（/task on 失败）从输入框下面一行往上弹出、右边对齐模型按钮（同换范围失败），
 *        模型按钮仍是 off，约 10 秒后自己消失。
 */
async function failedSwitch(page) {
  await openMenu(page);
  await failNext(page, TEAM_FAIL.menu);
  await page.locator(ROW).click();
  await page.locator(`${MENU} [data-testid="team-error"]`).waitFor({ timeout: 5000 });
  const open = await menuError(page);
  await closeMenu(page);
  await failNext(page, TEAM_FAIL.command);
  await typeAndSend(page, '/task on');
  await page.waitForFunction(({ css, want }) => document.querySelector(css)?.textContent === want,
    { css: TEAM_ERROR, want: teamFailText(TEAM_FAIL.command) }, { timeout: 5000 }).catch(() => {});
  const geo = await popupBox(page, { popup: TEAM_ERROR, anchor: PICK_ERROR.opener });
  const closed = { ...await lineError(page), button: await buttonNow(page) };
  const start = Date.now();
  const gone = await page.locator(TEAM_ERROR).waitFor({ state: 'detached', timeout: 13000 })
    .then(() => true, () => false);
  const waited = Date.now() - start;
  const problems = placeProblems(geo, { ...PICK_ERROR, popup: TEAM_ERROR });
  record('TB-53 replay tb-ask (synthetic failure): with the model menu open, a failed switch shows "Couldn’t change '
    + 'task mode: <error>" (role=alert) right under the Task mode row; the row stays off, is usable again and keeps '
    + 'the focus', open.text === teamFailText(TEAM_FAIL.menu) && open.role === 'alert' && open.underRow
    && open.mode === 'off' && !open.pending && open.focused, JSON.stringify(open));
  record('TB-53 replay tb-ask (synthetic failure): with the menu closed, a failed /task on shows the same line '
    + '(role=alert) above the composer row, right-aligned with the model button like a failed range change; the '
    + 'model button stays off; the line goes away by itself after about 10 seconds',
  closed.text === teamFailText(TEAM_FAIL.command) && closed.role === 'alert' && !closed.inMenu
    && closed.button.mode === 'off' && problems.length === 0 && gone && waited > 8000,
  JSON.stringify({ closed, problems, gone, waited }));
}

/** @brief TB-58（tb-ask）：开关点了两次（off → always → off），对话流末尾两行 Task mode on、Task mode off。 */
async function askNotices(page) {
  const notices = await modeNoticesOf(ctxOf(page), await paneTab(page));
  record('TB-58 replay tb-ask: the two clicks add "Task mode on" then "Task mode off" at the end of the transcript '
    + '(no message after them)', JSON.stringify(notices.map((item) => [item.mode, item.text, item.before]))
    === JSON.stringify([['always', NOTICE.always, null], ['off', NOTICE.off, null]]), JSON.stringify(notices));
}

/** @brief tb-ask 的全部检查。 */
async function askFixture(page, fx) {
  const steps = await askRun(page, fx);
  await askChecks(page, steps);
  await askSwitch(page, steps);
  await askNotices(page);
  await failedSwitch(page);
  await exitedSwitch(page);
}

// ---------- TB-08、TB-37、TB-53：tb-team ----------

/** @brief tb-team 重启前的一段：Allow all、/task、登记后在模型菜单里点 Task mode 一行两次，等全部放完；返回观察到的东西。 */
async function teamRun(page, fx) {
  const steps = await load(page, fx, { part: 'before' });
  const prompt = commandsOf(steps).find((c) => c.type === 'session.prompt');
  await openFolder(page);
  await allowAll(page);
  await typeAndSend(page, `/task ${prompt.text}`);
  await page.locator(`${PANE} [data-testid="receipt"][data-kind="registered"]`).first().waitFor({ timeout: 120000 });
  const states = [await switchNow(page, true)];
  for (const want of ['always', 'once']) {
    await clickRow(page, want);
    states.push(await switchNow(page, true));
  }
  await closeMenu(page);
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
  // 模式提示（TB-58）不算：录制时点开关的时刻可能落在回复与摘要之间
  const order = snap.order.filter((kind) => kind !== 'team-mode');
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

/** @brief TB-53 tb-team：/task 进入做完为止；once → always → once（需求还开着）；汇报那一轮结束时回到 off。 */
async function teamSwitchChecks(page, steps, states) {
  const final = await switchNow(page);
  const modes = resultsOf(steps, 'session.setTeam').map((v) => v.mode);
  record('TB-53 replay tb-team: "/task <text>" puts task mode in once (the model button "Task mode · <model id>", the '
    + 'row checked with "Until done · Ends when open requests are done"); a click sends session.setTeam on → always '
    + '("Messages go to Mori first"); a click with the request still open sends session.setTeam off and it stays once '
    + '("Until done · …"), not off',
  states.map((s) => s.mode).join() === 'once,always,once' && states.every((s) => sameSwitch(s, SWITCH[s.mode]))
    && modes.join() === 'always,once', JSON.stringify({ states, modes }));
  record('TB-53 replay tb-team: once the request is done and the report turn ends, task mode returns to off by itself '
    + '(mori.team_state; the model button without "Task mode", the row unchecked)',
  final.mode === 'off' && sameSwitch(final, SWITCH.off), JSON.stringify(final));
}

/**
 * @brief TB-58（tb-team）：/task 进入时一行 Task mode on until done 在你的消息之前；两次点击 Task mode on、
 *        Task mode on until done；汇报那一轮结束 Task mode off。
 * @return 看到的模式提示（重新打开后比较）
 */
async function teamNotices(page, steps) {
  const notices = await modeNoticesOf(ctxOf(page), await paneTab(page));
  const prompt = commandsOf(steps).find((c) => c.type === 'session.prompt');
  record('TB-58 replay tb-team: "Task mode on until done" right before the message sent with /task, then '
    + '"Task mode on" and "Task mode on until done" for the two clicks, and "Task mode off" when the report turn ends',
  JSON.stringify(notices.map((item) => [item.mode, item.text])) === JSON.stringify(['once', 'always', 'once', 'off']
    .map((mode) => [mode, NOTICE[mode]])) && (notices[0]?.before ?? '').includes(prompt.text.slice(0, 30)),
  oneLine(JSON.stringify(notices), 800));
  return notices;
}

/** @brief tb-team 重启后：打开同一个会话，回执、进展摘要、模式提示与条目的先后与重启前相同（TB-08、TB-37、TB-58）。 */
async function teamReopen(page, fx, before, notices) {
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
  const reopened = await modeNoticesOf(ctxOf(page), await paneTab(page));
  record('TB-58 replay tb-team reopened: the mode notices read and sit as before the restart (from the mori.team '
    + 'entries)', notices.length === 4 && JSON.stringify(reopened) === JSON.stringify(notices),
  oneLine(JSON.stringify({ before: notices, after: reopened }), 1000));
  await finish(page, 'TB-37', 'tb-team after the restart', steps);
}

/**
 * @brief TB-08（2026-10-26 走查 M18，docs/v0/screens/chat.md"步骤组"）：一轮结束后思考块与工具卡折成"{n} steps"，写回执的
 *        工具卡跟着收起，回执照常显示（页面里仍紧跟在它的卡后面，snap.inside 已查），进展摘要不在组里、一直显示（§13.2）；
 *        点开全部步骤组后卡都显示、回执与进展摘要不变；最后折回去，后面的 TB-37 检查和截图看的是默认折起的样子。
 *        TB-58 的模式提示（"Task mode on/off"）不是助手回复、结束一组：折起、展开、折回时都显示，不在任何步骤组里。
 * @param snap streamSnapshot 的结果（回执与进展摘要的个数）
 */
async function foldedReceipts(page, name, snap) {
  const count = snap.receipts.length;
  const blocks = snap.collapsed.length;
  const folded = await stepsState(page, PANE);
  await expandSteps(page, PANE);
  const opened = await stepsState(page, PANE);
  await foldSteps(page, PANE);
  const refolded = await stepsState(page, PANE);
  const summaries = (state) => state.progress.shown === blocks && state.progress.hidden === 0;
  record(`TB-08 replay ${name}: when a finished turn's thinking and tool cards fold into "<n> steps" rows (button, `
    + 'aria-expanded false) the tool cards that wrote receipts are hidden with them, but every receipt and every '
    + 'progress summary stays visible; expanding the rows shows the cards with the same receipts and summaries, and '
    + 'folding them again hides the cards', folded.rows.length > 0
    && folded.rows.every((row) => row.expanded === 'false' && /^\d+ steps?( · \d+ failed)?$/.test(row.text))
    && folded.cards.shown === 0 && folded.receipts.hidden === 0 && folded.receipts.shown === count && count > 0
    && blocks > 0 && summaries(folded) && opened.cards.hidden === 0 && opened.receipts.shown === count
    && summaries(opened) && refolded.cards.shown === 0 && refolded.rows.every((row) => row.expanded === 'false'),
  oneLine(JSON.stringify({ folded, opened, refolded }), 1500));
  const notices = (state) => state.modeNotices.hidden === 0 && state.modeNotices.grouped === 0
    && state.modeNotices.shown === folded.modeNotices.shown;
  record(`TB-58 replay ${name}: the Task mode notice lines stay visible and outside every step group while the `
    + 'steps are folded, expanded and folded again (a notice is not an assistant reply, so it ends a group)',
  folded.modeNotices.shown > 0 && notices(folded) && notices(opened) && notices(refolded),
  JSON.stringify([folded, opened, refolded].map((state) => state.modeNotices)));
}

/** @brief tb-team 的全部检查。 */
async function teamFixture(page, fx) {
  const { steps, states } = await teamRun(page, fx);
  const snap = await streamSnapshot(page);
  await shot(page, 'tb-team');
  teamReceipts(steps, snap);
  await foldedReceipts(page, 'tb-team', snap);
  await teamProgress(page, steps, snap);
  await teamSwitchChecks(page, steps, states);
  const notices = await teamNotices(page, steps);
  await finish(page, 'TB-08', 'tb-team before the restart', steps);
  await teamReopen(page, fx, snap, notices);
}

// ---------- TB-08、TB-37：tb-receipts ----------

/** @brief tb-receipts：Allow all，照录制发三条消息（/task、补充、撤销），每条之前等上一轮放完、对话空闲。 */
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
    await typeAndSend(page, command.team === 'once' ? `/task ${command.text}` : command.text);
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
  await foldedReceipts(page, 'tb-receipts', snap);
  await receiptsProgress(page, steps, snap);
  await finish(page, 'TB-08', 'tb-receipts', steps);
}

// ---------- TB-34、TB-37：tb-approval ----------

/** @brief tb-approval：/task 之后等后台批准卡；查卡、进展摘要与侧栏；问进展那一轮结束后卡还在；Alt+1 允许。 */
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
  await watchStage(page);
  await typeAndSend(page, commands[second].text);
  await untilPlayed(page, commands.findIndex((c) => c.type === 'approval.answer'), 'the progress turn');
  await page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'false', PANE,
    { timeout: 30000 });
  const stages = await page.evaluate(() => window.__tbStages);
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
  record('TB-34 replay tb-approval: a TaskBoard background card leaves the stage line alone — while the progress turn '
    + 'runs with the task\'s card pending the stage line never reads "Waiting for your approval" (only a normal-mode '
    + 'subagent\'s card does, subagent spec §7.1)', settled === 1 && stages.length > 0
    && !stages.includes('Waiting for your approval'), stages.join(' | '));
  await finish(page, 'TB-34', 'tb-approval', steps);
}

/** @brief 从现在起记下这一栏阶段行出现过的每段文字（MutationObserver），放在 window.__tbStages。 */
function watchStage(page) {
  return page.evaluate((pane) => {
    const seen = [];
    let last = '';
    const scan = () => {
      const now = document.querySelector(`${pane} [data-testid="stage"]`)?.textContent ?? '';
      if (now && now !== last) seen.push(now);
      last = now;
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
    scan();
    window.__tbStages = seen;
  }, PANE);
}

/** @brief Open folder…、/task，等第一张后台卡与它的 task 行，查卡、task 行、侧栏与权限菜单。 */
async function approvalFirst(page, commands, event, css) {
  await openFolder(page);
  await typeAndSend(page, `/task ${commands.find((c) => c.type === 'session.prompt').text}`);
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
  { name: 'tb-ask', ids: ['TB-04', 'TB-53', 'TB-58'], run: askFixture },
  { name: 'tb-team', ids: ['TB-08', 'TB-37', 'TB-53', 'TB-58'], run: teamFixture },
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
  const mine = unexpectedErrors(errors.slice(before));
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
