// 普通模式的 subagent 工具的回放测试（docs/specs/subagent.md §14.1 的回放层，§14.3 的 SA-11、SA-14、SA-17）：在 Electron
// 里载入真正的界面，用回放进程桥（tests/ui/harness）回放从真实会话录下的 tests/fixtures/sa/sa-subagent.json（tb-record.mjs
// 录制，模型是负责人的 DeepSeek），以及 m1 的两个录制。测试像你一样操作（Open folder…、发录制里的消息、批准卡上的
// Alt+1、侧栏里打开会话），回放桥核对界面发出的每条命令都与录制一致；再按 docs/v1/screens/subagent-card.md 检查界面：
//   SA-11（sa-subagent 重启前）：执行中的卡片展开，标题 Running 2 agents、状态 <d> of 2 done、每一行的状态（Starting、
//     工具标题、Waiting for your approval、Done），结束时收起一次、标题 Ran 2 agents；点开一行的 Agent prompt 与 Response
//     等于录下的参数与回复；阶段行 Running 2 agents。
//   SA-14（sa-subagent 重启后）：重新打开会话时卡片按结果的 details 画出：收起、Ran 2 agents · Done（不显示耗时），行与结束时相同。
//   SA-17：m1 的录制（subagent 之前录的）照常回放，命令一致，没有 subagent 的卡片。
// 录制文件还不存在时，每个对应编号记一条失败"<编号> replay fixture missing"（不造假录制）。
// 用法（在 app/ 下）：node tests/ui/sa-replay.mjs [--only sa-subagent,m1/readme]
// 结果写到 test-results/sa-replay.json（--only 时 sa-partial-replay.json，不计入覆盖检查）；截图在 test-results/sa-replay/。

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { build } from 'vite';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { PANE, rowOf, waitReady } from './m3-helpers.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-sa');
const shots = join(appRoot, 'test-results/sa-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** SA-17 回放的 m1 录制（[目录, 名字]）：subagent 之前录的普通模式会话 */
const SA17 = [['m1', 'readme'], ['m1', 'edit']];

// ---------- 录制 ----------

/** @brief 回放桥当作只读查询回答的命令：从 harness/replay.js 的 QUERIES 读，保证与回放桥一致。 */
function harnessQueries() {
  const text = readFileSync(join(harnessDir, 'replay.js'), 'utf8');
  const match = /const QUERIES = \[([^\]]*)\]/.exec(text);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}
const QUERIES = harnessQueries();
const fixturePath = (dir, name) => join(appRoot, 'tests/fixtures', dir, `${name}.json`);
const readFixture = (dir, name) => JSON.parse(readFileSync(fixturePath(dir, name), 'utf8'));
/** @brief 录制里重启前（before）或重启后（after）的步骤；part 为空时是全部（同 harness/replay.js 的 partOf）。 */
function partOf(fx, part) {
  if (!part) return fx.steps;
  const at = fx.steps.findIndex((s) => s.restart);
  if (at < 0) throw new Error(`${fx.name} has no restart step`);
  return part === 'before' ? fx.steps.slice(0, at) : fx.steps.slice(at + 1);
}
/** @brief 一段里界面发出的命令（只读查询与 models.* 写命令除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (steps) => steps.filter((s) => s.command && !QUERIES.includes(s.command.type)
  && !s.command.type.startsWith('models.')).map((s) => s.command);
/** @brief 一段里某种事件（按顺序）。 */
const eventsOf = (steps, type) => steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);

// ---------- 页面 ----------

/** @brief 构建回放页面。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 载入录制文件（或它的一段），等侧栏读完会话列表，装上卡片记录器。 */
async function load(page, fx, { part = null, speed = 4, maxGap = 600 } = {}) {
  const index = pathToFileURL(join(outDir, 'index.html')).href;
  await page.goto(`${index}?fixture=${fx.name}${part ? `&part=${part}` : ''}&speed=${speed}&maxGap=${maxGap}`);
  await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
  await watchCards(page);
  return partOf(fx, part);
}

/** @brief 页面里的 MutationObserver：subagent 卡片（标题、状态、展开、每一行）与阶段行变了就记一条，在 window.__saWatch。 */
function watchCards(page) {
  return page.evaluate((pane) => {
    const seen = { cards: [], stages: [] };
    let last = '';
    let stage = '';
    const scan = () => {
      const root = document.querySelector(pane);
      if (!root) return;
      const card = root.querySelector('[data-tool="subagent"]');
      if (card) {
        const item = { title: card.querySelector('.tool-verb')?.textContent ?? '', open: card.open,
          status: card.querySelector(':scope > summary [data-testid="tool-status"]')?.textContent ?? '',
          rows: [...card.querySelectorAll('[data-testid="subagent-row"]')].map((row) => [
            row.querySelector('[data-testid="subagent-label"]')?.textContent ?? '',
            row.querySelector('[data-testid="subagent-state"]')?.textContent ?? '', row.dataset.phase]) };
        const text = JSON.stringify(item);
        if (text !== last) seen.cards.push(item);
        last = text;
      }
      const now = root.querySelector('[data-testid="stage"]')?.textContent ?? '';
      if (now && now !== stage) seen.stages.push(now);
      stage = now;
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
    scan();
    window.__saWatch = seen;
  }, PANE);
}
const watched = (page) => page.evaluate(() => window.__saWatch);

/** @brief 等回放桥放完 total 段；出现不一致时立即报错。 */
async function untilPlayed(page, total, what, timeout = 600000) {
  await page.waitForFunction((v) => window.__replay.status.played >= v || window.__replay.status.errors.length > 0,
    total, { timeout }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 收尾：回放桥没有不一致，这一段录制里的命令全部用上了。 */
async function finish(page, id, label, steps) {
  const total = commandsOf(steps).length;
  await untilPlayed(page, total, `all ${total} commands of ${label}`).catch(() => {});
  const status = await page.evaluate(() => window.__replay.status);
  record(`${id} replay ${label}: the commands the UI sent match the recording (${total}), none extra or missing`,
    status.errors.length === 0 && status.cursor === total && status.commands.length === total,
    status.errors.join('; ') || `commands ${status.commands.map((c) => c.type).join(', ')}`);
}

/** @brief 点侧栏"Open folder…"（回放桥返回下一条 session.create 的文件夹），等会话就绪。 */
async function openFolder(page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
  await page.locator(PANE).waitFor({ timeout: 20000 });
  await waitReady(page);
}

/** @brief 在当前一栏的输入框里写字按 Enter。 */
async function typeAndSend(page, text) {
  const box = page.locator(`${PANE} .composer textarea`);
  await box.fill(text);
  await box.press('Enter');
  await sleep(300);
}

/** @brief 照录制的命令一条条在界面里做（新建会话、打开会话、发消息、批准卡 Alt+1），每条之前等上一段放完。 */
async function drive(page, steps) {
  const commands = commandsOf(steps);
  for (const [i, command] of commands.entries()) {
    await untilPlayed(page, i, `segment ${i} before ${command.type}`);
    if (command.type === 'session.create') await openFolder(page);
    else if (command.type === 'session.open') {
      await rowOf(page, command.sessionFile).click();
      await waitReady(page);
    } else if (command.type === 'session.prompt') await typeAndSend(page, command.text);
    else if (command.type === 'approval.answer') {
      const css = `${PANE} [data-testid="approval-card"][data-request="${command.requestId}"]`;
      await page.locator(css).waitFor({ timeout: 30000 });
      await page.locator(`${PANE} .composer textarea`).focus();
      await page.keyboard.press('Alt+1');
    } else throw new Error(`no UI step for ${command.type}`);
  }
  await untilPlayed(page, commands.length, 'the last segment');
}

/**
 * @brief 一轮结束后 subagent 的卡在哪个步骤组里（WP-14，docs/v0/screens/chat.md“步骤组”）：{ group（卡在组里）, hidden（组折着、
 *        卡不显示）, row（摘要行的字）, expanded }；然后点开那一行（有的话），之后的检查照常看得到卡。
 */
async function foldOf(page, pane) {
  const state = await page.evaluate((css) => {
    const root = document.querySelector(css);
    const member = root?.querySelector('[data-tool="subagent"]')?.closest('[data-step-group]') ?? null;
    const row = member ? root.querySelector(`[data-testid="step-group"][data-group="${member.dataset.stepGroup}"]`)
      : null;
    return { group: member !== null, hidden: member?.hidden ?? null, row: row?.textContent.trim() ?? null,
      expanded: row?.getAttribute('aria-expanded') ?? null };
  }, pane);
  if (state.row !== null) {
    const id = await page.locator(`${pane} [data-tool="subagent"]`).first()
      .evaluate((el) => el.closest('[data-step-group]')?.dataset.stepGroup ?? '');
    await page.locator(`${pane} [data-testid="step-group"][data-group="${id}"]`).click();
  }
  const card = await page.locator(`${pane} [data-tool="subagent"]`).first()
    .evaluate((el) => ({ visible: el.closest('[hidden]') === null, open: el.open })).catch(() => null);
  return { ...state, card };
}

/** @brief 点开第一张 subagent 卡（收起时）与它的第 index 行，读 Agent prompt 与 Response 和每一行。 */
async function openRow(page, index) {
  const card = page.locator(`${PANE} [data-tool="subagent"]`).first();
  if (!(await card.evaluate((el) => el.open))) await card.locator(':scope > summary').click();
  const row = card.locator(`[data-testid="subagent-row"][data-index="${index}"]`);
  await row.locator(':scope > summary').click();
  const text = (id) => row.locator(`[data-testid="${id}"]`).textContent({ timeout: 3000 }).catch(() => null);
  const prompt = await text('subagent-prompt');
  const response = await text('subagent-response');
  const rows = await card.locator('[data-testid="subagent-row"]').evaluateAll((els) => els.map((el) => [
    el.querySelector('[data-testid="subagent-label"]')?.textContent ?? '',
    el.querySelector('[data-testid="subagent-state"]')?.textContent ?? '']));
  return { prompt, response, rows };
}

// ---------- SA-11、SA-14：sa-subagent ----------

/** @brief 录下的 subagent 调用：参数与最终的 details。 */
function recorded(steps) {
  const end = eventsOf(steps, 'tool_execution_end').find((e) => e.toolName === 'subagent');
  const start = eventsOf(steps, 'tool_execution_start').find((e) => e.toolName === 'subagent');
  return { args: start?.args ?? null, rows: end?.result?.details?.agents ?? [] };
}

/** @brief SA-11：重启前的一段：执行中的卡片、行的状态、阶段行、结束时收起、展开一行。 */
async function before(page, fx) {
  const steps = await load(page, fx, { part: 'before' });
  await drive(page, steps);
  await page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'false', PANE,
    { timeout: 30000 });
  const seen = await watched(page);
  const { rows } = recorded(steps);
  const n = rows.length;
  const running = seen.cards.filter((card) => card.title === `Running ${n} agents`);
  const states = new Set(running.flatMap((card) => card.rows.map((row) => row[1])));
  await shot(page, 'sa-subagent-before');
  const progress = running.filter((card) => /^\d of \d done · \d/.test(card.status));
  record(`SA-11 replay sa-subagent: while running the card is open with "Running ${n} agents" (Preparing…, Queued, then `
    + `"<d> of ${n} done · <s>"), one row per subagent; rows show Starting or a tool title, and "Waiting for your `
    + 'approval" for the general one while its card is pending', running.length > 0 && progress.length > 0
    && running.every((card) => card.open && card.rows.length === n
      && (['Preparing…', 'Queued'].includes(card.status) || /^\d of \d done · \d/.test(card.status)))
    && states.has('Waiting for your approval')
    && [...states].some((state) => /^(Read|Run) /.test(state)), oneLine(JSON.stringify({ states: [...states],
    opens: [...new Set(running.map((card) => card.open))], statuses: [...new Set(running.map((card) => card.status))],
    counts: [...new Set(running.map((card) => card.rows.length))] }), 900));
  const fold = await foldOf(page, PANE);
  record('SA-11 replay sa-subagent: after the turn the subagent card folds into the turn\'s "<n> steps" row (WP-14) '
    + 'and, when that row is opened, the card itself is still collapsed', fold.group && fold.hidden === true
    && /^\W*\d+ steps?( · \d+ failed)?$/.test(fold.row ?? '') && fold.card?.visible === true
    && fold.card.open === false, oneLine(JSON.stringify(fold), 600));
  const final = seen.cards.at(-1);
  record(`SA-11 replay sa-subagent: when the call ends the card collapses once to "Ran ${n} agents" · "Done · <s>"`,
    final?.title === `Ran ${n} agents` && !final.open && /^Done · \d/.test(final.status),
    oneLine(JSON.stringify(final), 600));
  record(`SA-11 replay sa-subagent: the stage line read "Running ${n} agents <s>" while it ran`,
    seen.stages.some((text) => new RegExp(`^Running ${n} agents \\d`).test(text)), seen.stages.join(' | '));
  const opened = await openRow(page, 1);
  const want = rows.map((row) => [labelOf(row), 'Done']);
  record('SA-11 replay sa-subagent: opening a row shows the recorded prompt and final reply; the rows read '
    + '"<description>[ · Read-only][ · <k> tool uses]" · Done', opened.prompt === rows[0]?.prompt
    && opened.response === (rows[0]?.reply || '(no reply)') && JSON.stringify(opened.rows) === JSON.stringify(want),
  oneLine(JSON.stringify({ opened, want }), 900));
  await finish(page, 'SA-11', 'sa-subagent (before the restart)', steps);
}

/** @brief 一行的标签（状态表）：description · Read-only · <k> tool uses（基座不写角色）。 */
function labelOf(row) {
  const uses = row.toolUses === 1 ? '1 tool use' : `${row.toolUses} tool uses`;
  return [row.description, ...(row.readOnly ? ['Read-only'] : []), ...(row.toolUses > 0 ? [uses] : [])].join(' · ');
}

/** @brief SA-14：重启后打开同一个会话：卡片按 details 画出，收起，Ran n agents · Done，行与结束时相同。 */
async function after(page, fx) {
  const steps = await load(page, fx, { part: 'after' });
  await drive(page, steps);
  const { rows } = recorded(partOf(fx, 'before'));
  const seen = await watched(page);
  const first = seen.cards[0];
  const opened = await openRow(page, 2);
  await shot(page, 'sa-subagent-after');
  record(`SA-14 replay sa-subagent: reopened, the card is drawn from the result's details: collapsed "Ran ${rows.length} `
    + 'agents" · "Done" (no duration), the same rows, all Done', first?.title === `Ran ${rows.length} agents`
    && !first.open && first.status === 'Done' && JSON.stringify(opened.rows) === JSON.stringify(rows.map((row) =>
    [labelOf(row), 'Done'])) && opened.response === (rows[1]?.reply || '(no reply)'),
  oneLine(JSON.stringify({ first, opened }), 900));
  await finish(page, 'SA-14', 'sa-subagent (reopened after the restart)', steps);
}

// ---------- SA-17：m1 的录制 ----------

/** @brief SA-17：一个 subagent 之前的录制照常回放，命令一致，没有 subagent 的卡片。 */
async function sa17(page, [dir, name]) {
  const fx = readFixture(dir, name);
  const steps = await load(page, fx, { speed: 6, maxGap: 400 });
  await drive(page, steps);
  const cards = await page.locator(`${PANE} [data-tool="subagent"]`).count();
  const tools = await page.locator(`${PANE} [data-testid="tool-card"]`).count();
  const status = await page.evaluate(() => window.__replay.status);
  const total = commandsOf(steps).length;
  record(`SA-17 replay ${dir}/${name}: a recording from before subagent replays as before (all ${total} commands `
    + `match, ${tools} tool cards) and shows no subagent card`, status.errors.length === 0 && status.cursor === total
    && cards === 0, oneLine(JSON.stringify({ errors: status.errors, cursor: status.cursor, total, cards, tools }), 600));
}

// ---------- 执行 ----------

/** @brief 跑一组检查；出错时记一条失败；之后记这一组的页面错误。 */
async function guarded(page, errors, { id, label }, run) {
  const start = errors.length;
  try {
    await run();
  } catch (error) {
    record(`${id} replay ${label}: flow`, false, oneLine(error, 600));
    await shot(page, `${label.replace(/\W+/g, '-')}-error`);
  }
  const mine = errors.slice(start);
  record(`${id} replay ${label}: the page has no errors`, mine.length === 0, mine.slice(0, 5).join(' | '));
}

const wantSa = !only || only.includes('sa-subagent');
const chosen17 = SA17.filter(([dir, name]) => !only || only.includes(`${dir}/${name}`));
const hasSa = existsSync(fixturePath('sa', 'sa-subagent'));
if (wantSa && !hasSa) {
  for (const id of ['SA-11', 'SA-14']) {
    record(`${id} replay fixture missing: tests/fixtures/sa/sa-subagent.json (record it with tb-record.mjs)`, false,
      'no real recording yet');
  }
}
if ((wantSa && hasSa) || chosen17.length) {
  await buildHarness();
  const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
    env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
      MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-sa-')) } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  for (const item of chosen17) {
    await guarded(page, errors, { id: 'SA-17', label: `${item[0]}/${item[1]}` }, () => sa17(page, item));
  }
  if (wantSa && hasSa) {
    const fx = readFixture('sa', 'sa-subagent');
    await guarded(page, errors, { id: 'SA-11', label: 'sa-subagent' }, () => before(page, fx));
    await guarded(page, errors, { id: 'SA-14', label: 'sa-subagent reopened' }, () => after(page, fx));
  }
  await app.close();
}
process.exitCode = write(only ? 'sa-partial-replay.json' : 'sa-replay.json') ? 0 : 1;
