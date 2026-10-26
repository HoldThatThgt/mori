// 收尾检查的回放测试（docs/specs/finish-check.md §14.1 的回放层；§14.2 的 FC-11、FC-12、FC-13、FC-23 的回放部分）：
// 在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放 fc-record.mjs 从真实的 App 对合成端点录下的
// tests/fixtures/finish/*.json（source 为 synthetic），以及 fc-real.mjs 的真实录制 fc-a-real.json、fc-b-real.json、
// fc-c-real.json（有时一并回放，没有不算失败）。测试像你一样操作（Open folder…、权限菜单 Allow all、发录制里的消息、
// 侧栏打开会话、回复下的 Copy 与 Attach message as context），回放桥核对界面发出的每条命令都与录制一致；再按 §10 检查界面。
// 期望的文字由录下的事件独立算出（助手消息的文字块），不从 src/ 引用。每个录制都检查：
//   - 录制里真有收尾检查：这个会话一个 agent_settled、每次检查多一个 agent_start（§3 第 2 条），finish 的调用数；
//   - 界面任何时候都不画 finish（没有标题含 finish 的工具卡，阶段行从不出现 finish），对话流里从不出现检查那一行
//     （页面里的记录器，fc-real-helpers.mjs watchFinish）；
//   - 运行结束之后对话流里没有空的 [data-item]（§10.1：只有 finish 的助手消息不留项）；
//   - 回复下的操作行一轮一行，挂在这一轮最后一个有正文的助手项上（§0 第 14 条）；Copy 复制整轮正文（各段之间空一行）。
// 各录制另查：
//   FC-11 fc-a：一项回复（Done.）、没有工具卡；重启后打开同一个会话（打开会话、history.ts）同样。
//   FC-11 fc-a-text：确认时写的 The reply stands. 是最后一段正文，操作行在它那一项，Copy 带着它。
//   FC-11 fc-early：检查之前的 finish 与检查之后的 finish 都不画，一项回复。
//   FC-12 fc-b：第一段回复留在原处，后面是 bash 的卡、最终回复 The tests passed.（先后不变）；重新打开后 bash 的卡仍在。
//   FC-13 fc-c：两段都显示（Draft answer. 在前），没有 finish 的调用；Copy 与 Attach message as context 的内容两段都在。
//   FC-23 fc-a-think：只多一块收起的 Thought process（两块，都收起），操作行在回复正文那一项；重新打开后同样。
// 真实录制只查上面每个录制都查的几项（模型写了什么不断言）。
// 录制文件还不存在时，每个对应编号记一条失败"<编号> replay fixture missing"（不造假录制）；真实录制不存在时不记。
// 用法（在 app/ 下）：node tests/ui/fc-replay.mjs [--only fc-a,fc-b-real]
// 结果写到 test-results/fc-replay.json（--only 时 fc-partial-replay.json，不计入覆盖检查）；截图在 test-results/fc-replay/。

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { build } from 'vite';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { PANE, rowOf, waitReady } from './m3-helpers.mjs';
import { finishSeen, FINISH_TOOL, watchFinish } from './fc-real-helpers.mjs';

const only = arg('only')?.split(',').filter(Boolean);
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-fc');
const fixtureDir = join(appRoot, 'tests/fixtures/finish');
const shots = join(appRoot, 'test-results/fc-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
/** @brief 检查的 detail。 */
const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);
/** @brief 一条检查按录制覆盖的每个编号各记一条："<编号> replay <text>"。 */
function note(ids, text, ok, detail) {
  for (const id of ids) record(`${id} replay ${text}`, ok, detail);
}

// ---------- 录制 ----------

/** @brief 回放桥当作只读查询回答的命令：从 harness/replay.js 的 QUERIES 读，保证与回放桥一致。 */
function harnessQueries() {
  const text = readFileSync(join(harnessDir, 'replay.js'), 'utf8');
  const match = /const QUERIES = \[([^\]]*)\]/.exec(text);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}
const QUERIES = harnessQueries();

/** @brief 录制文件的路径。 */
const fixturePath = (name) => join(fixtureDir, `${name}.json`);
/** @brief 读一个录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));
/** @brief 录制里重启前（before）或重启后（after）的步骤；part 为空时是全部（同 harness/replay.js 的 partOf）。 */
function partOf(fx, part) {
  if (!part) return fx.steps;
  const at = fx.steps.findIndex((s) => s.restart);
  return part === 'before' ? fx.steps.slice(0, at) : fx.steps.slice(at + 1);
}
/** @brief 一段里界面发出的命令（只读查询与回放桥直接应答的 models.* 写命令除外），下标与回放桥的 cursor 一致。 */
const commandsOf = (steps) => steps.filter((s) => s.command && !QUERIES.includes(s.command.type)
  && !s.command.type.startsWith('models.')).map((s) => s.command);
/** @brief 一段里某种命令的结果（按顺序）。 */
const resultsOf = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
/** @brief 一段里某个会话的某种事件（按顺序）。 */
const eventsOf = (steps, type, sessionId) => steps.filter((s) => s.envelope?.event.type === type
  && s.envelope.sessionId === sessionId).map((s) => s.envelope.event);

/**
 * @brief 录下的这一轮：会话 id、agent_start 与 agent_settled 的个数、finish 的调用数、助手消息的文字块（去掉首尾空白的
 *        非空块，按顺序；界面的整轮正文就是它们以空行相接，state/turns.ts）。
 */
function turnOf(fx) {
  const steps = partOf(fx, fx.steps.some((s) => s.restart) ? 'before' : null);
  const id = resultsOf(steps, 'session.create')[0]?.sessionId;
  const assistants = eventsOf(steps, 'message_end', id).map((e) => e.message).filter((m) => m.role === 'assistant');
  const blocks = assistants.flatMap((m) => (Array.isArray(m.content) ? m.content : [])
    .filter((part) => part.type === 'text' && part.text.trim()).map((part) => part.text.trim()));
  return { id, starts: eventsOf(steps, 'agent_start', id).length, settled: eventsOf(steps, 'agent_settled', id).length,
    finish: eventsOf(steps, 'tool_execution_start', id).filter((e) => e.toolName === FINISH_TOOL).length,
    blocks, text: blocks.join('\n\n') };
}

// ---------- 页面 ----------

/** @brief 构建回放页面（到 test-results/harness-fc，不碰 out/）。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/**
 * @brief 页面里的阶段行记录器：当前一栏的阶段行（[data-testid="stage"]）出现过的每种文字，在 window.__fcStages。
 */
function watchStageTexts(page) {
  return page.evaluate((pane) => {
    const seen = [];
    const scan = () => {
      const text = document.querySelector(`${pane} [data-testid="stage"]`)?.textContent?.replace(/\d+s$/, '') ?? '';
      if (text && !seen.includes(text)) seen.push(text);
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__fcStages = seen;
  }, PANE);
}

/** @brief 载入录制文件（或它的一段），等侧栏读完会话列表，装上页面里的记录器；返回这一段的步骤。 */
async function load(page, fx, part = null) {
  const index = pathToFileURL(join(outDir, 'index.html')).href;
  await page.goto(`${index}?fixture=${fx.name}${part ? `&part=${part}` : ''}&speed=4&maxGap=600`);
  await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
  await watchFinish(page);
  await watchStageTexts(page);
  return partOf(fx, part);
}

/** @brief 等回放桥放完 total 段；出现不一致时立即报错。 */
async function untilPlayed(page, total, what, timeout = 120000) {
  await page.waitForFunction((v) => window.__replay.status.played >= v || window.__replay.status.errors.length > 0,
    total, { timeout }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 当前一栏空闲（不在生成、不在发送、没有阶段行）。 */
const waitIdle = (page) => page.waitForFunction((pane) => {
  const el = document.querySelector(pane);
  return el && el.dataset.running === 'false' && el.dataset.sending === 'false'
    && !el.querySelector('[data-testid="stage"]');
}, PANE, { timeout: 30000 });

/** @brief 点侧栏"Open folder…"（回放桥返回下一条 session.create 的文件夹），等新会话就绪。 */
async function openFolder(page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
  await page.locator(PANE).waitFor({ timeout: 20000 });
  await waitReady(page);
}

/** @brief 权限菜单 → Allow all → 确认（界面发 approval.setMode all）。 */
async function allowAll(page) {
  await page.locator(PANE).getByTestId('permission-button').click();
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: 'Allow all' }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Allow all', exact: true }).click();
}

/** @brief 在当前一栏的输入框里写字按 Enter。 */
async function typeAndSend(page, text) {
  const box = page.locator(`${PANE} .composer textarea`);
  await box.fill(text);
  await box.press('Enter');
}

/** @brief 照录制的命令一条条在界面里做（新建会话、Allow all、发消息、打开会话），每条之前等上一段放完；最后等空闲。 */
async function drive(page, steps) {
  const commands = commandsOf(steps);
  for (const [i, command] of commands.entries()) {
    await untilPlayed(page, i, `segment ${i} before ${command.type}`);
    if (command.type === 'session.create') await openFolder(page);
    else if (command.type === 'approval.setMode' && command.mode === 'all') await allowAll(page);
    else if (command.type === 'session.prompt') await typeAndSend(page, command.text);
    else if (command.type === 'session.open') {
      await rowOf(page, command.sessionFile).click();
      await waitReady(page);
    } else throw new Error(`no UI step for ${command.type}`);
  }
  await untilPlayed(page, commands.length, 'the last segment');
  await waitIdle(page);
  await sleep(400);
}

/** @brief 收尾：回放桥没有不一致，这一段录制里的命令全部用上了。 */
async function finish(page, ids, label, steps) {
  const total = commandsOf(steps).length;
  await untilPlayed(page, total, `all ${total} commands of ${label}`).catch(() => {});
  const status = await page.evaluate(() => window.__replay.status);
  note(ids, `${label}: the commands the UI sent match the recording (${total}), none extra or missing`,
    status.errors.length === 0 && status.cursor === total && status.commands.length === total,
    status.errors.join('; ') || `commands ${status.commands.map((c) => c.type).join(', ')}`);
}

/**
 * @brief 当前一栏对话流里的每一项（Transcript.tsx 的 [data-item]）：kind、去掉操作行之后的文字、是不是空的（没有文字也
 *        没有工具卡）、有没有操作行（latest：最新一轮那一行）、正文段（.prose）、工具卡（标题与状态）、思考块（展开没有、
 *        摘要的文字）。
 */
function itemsOf(page) {
  return page.evaluate((pane) => {
    const root = document.querySelector(`${pane} [data-testid="transcript"]`);
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return [...(root?.querySelectorAll('[data-item]') ?? [])].map((el) => {
      const body = [...el.children].filter((child) => child.dataset.testid !== 'reply-actions');
      const actions = el.querySelector(':scope > [data-testid="reply-actions"]');
      return { kind: el.dataset.item, text: body.map(text).join(' ').slice(0, 200),
        empty: body.every((child) => !text(child) && !child.querySelector('[data-testid="tool-card"]')),
        actions: Boolean(actions), latest: Boolean(actions?.classList.contains('latest')),
        prose: [...el.querySelectorAll('.prose')].map(text).filter(Boolean),
        tools: [...el.querySelectorAll('[data-testid="tool-card"]')].map((card) => ({
          title: text(card.querySelector('.tool-title')), status: card.dataset.status })),
        thinking: [...el.querySelectorAll('[data-testid="thinking"]')].map((box) => ({ open: box.open,
          summary: text(box.querySelector('summary')) })) };
    });
  }, PANE);
}

/** @brief 正文的比较形式：弯引号换成直引号、空白归一（Markdown 渲染后的文字与原文比）。 */
const plain = (text) => String(text).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/** @brief 点最新一轮操作行的 Copy，返回回放桥记下的复制内容。 */
async function copyLatest(page) {
  await page.locator(`${PANE} [data-testid="reply-actions"].latest`).getByRole('button', { name: 'Copy' }).click();
  await sleep(200);
  return page.evaluate(() => window.__replay.status.copied.at(-1) ?? null);
}

/** @brief 点最新一轮操作行的 Attach message as context，返回输入框上方新芯片的原文（悬停说明是整段原文）。 */
async function attachLatest(page) {
  await page.locator(`${PANE} [data-testid="reply-actions"].latest`)
    .getByRole('button', { name: 'Attach message as context' }).click();
  const chip = page.locator(`${PANE} [data-testid="quote-chip"] .quote-chip-main`).last();
  await chip.waitFor({ timeout: 5000 });
  return chip.getAttribute('title');
}

// ---------- 每个录制都查的 ----------

/** @brief 录制里真有收尾检查：一个 agent_settled、每次检查多一个 agent_start；want 给出时 finish 的调用数也对。 */
function recordingCheck(ids, label, turn, want) {
  const starts = want ? turn.starts === want.checks + 1 : turn.starts >= 2;
  note(ids, `${label}: the recording has the finish check in the same run (one agent_settled, one more `
    + `agent_start per check${want ? `: ${want.checks} check(s), ${want.finish} finish call(s)` : ''})`,
  turn.settled === 1 && starts && (!want || turn.finish === want.finish), brief(turn));
}

/**
 * @brief §10.1 的不画：没有标题含 finish 的工具卡，阶段行从不出现 finish，对话流里从不出现检查那一行；运行结束之后
 *        没有空的 [data-item]；操作行一轮一行，挂在最后一个有正文的助手项上。
 */
async function hiddenCheck(page, ids, label, items) {
  const seen = await finishSeen(page);
  const stages = await page.evaluate(() => window.__fcStages ?? []);
  note(ids, `${label}: finish is never drawn (no tool card titled finish, no stage line naming it) and `
    + 'the check line never shows in the transcript', seen.cards.length === 0 && seen.lines.length === 0
    && !stages.some((text) => /\bfinish\b/i.test(text)), brief({ cards: seen.cards, lines: seen.lines, stages }));
  const lastText = items.findLastIndex((item) => item.kind === 'assistant' && item.prose.length > 0);
  const rows = items.flatMap((item, at) => (item.actions ? [at] : []));
  const turns = items.filter((item) => item.kind === 'user').length;
  note(ids, `${label}: after the run there is no empty [data-item] (a finish-only message leaves no item), `
    + 'and the reply actions are one row per turn, under the last assistant item that has reply text',
  items.every((item) => !item.empty) && rows.length === turns && rows.at(-1) === lastText && items[lastText]?.latest,
  brief({ items, rows, lastText }));
}

/** @brief Copy 复制整轮正文（录下的文字块以空行相接，state/turns.ts）。 */
async function copyCheck(page, ids, label, turn) {
  const copied = await copyLatest(page);
  note(ids, `${label}: Copy on the reply copies the whole turn's text (${turn.blocks.length} block(s), `
    + 'blank line between them)', copied === turn.text, brief({ copied, want: turn.text }));
}

/** @brief 一段回放的共同检查（不含 Copy：重新打开后的一段不点它）。 */
async function commonChecks(page, ctx, part) {
  const label = part === 'after' ? `${ctx.fx.name} reopened` : ctx.fx.name;
  const items = await itemsOf(page);
  await shot(page, label.replace(/\s+/g, '-'));
  await hiddenCheck(page, ctx.ids, label, items);
  return { label, items };
}

// ---------- 各录制另查的 ----------

/** @brief 助手项的个数、工具卡与思考块（want 给出的几项）。 */
function shapeCheck(ids, label, items, want) {
  const assistants = items.filter((item) => item.kind === 'assistant');
  const tools = assistants.flatMap((item) => item.tools);
  const thinking = assistants.flatMap((item) => item.thinking);
  note(ids, `${label}: ${want.assistants} assistant item(s), ${want.tools} tool card(s), `
    + `${want.thinking} collapsed "Thought process" block(s) and one user item`,
  items.filter((item) => item.kind === 'user').length === 1 && assistants.length === want.assistants
    && tools.length === want.tools && thinking.length === want.thinking
    && thinking.every((box) => !box.open && box.summary === 'Thought process'),
  brief({ assistants: assistants.map((item) => item.text), tools, thinking }));
}

/** @brief 最后一段正文是 final，操作行在它那一项（fc-a-text 的确认时写的话、fc-b、fc-c 的新回复）。 */
function finalCheck(ids, label, items, final) {
  const at = items.findIndex((item) => item.actions);
  note(ids, `${label}: "${final}" is the last reply text and the reply actions are under its item`,
    at >= 0 && plain(items[at].prose.at(-1) ?? '') === plain(final)
    && !items.slice(at + 1).some((item) => item.prose.length > 0), brief({ at, item: items[at] }));
}

/** @brief fc-b：第一段回复、bash 的卡、最终回复，按这个先后。 */
function orderCheck(ids, label, items, turn) {
  const of = (pred) => items.findIndex(pred);
  const first = of((item) => item.prose.some((text) => plain(text) === plain(turn.blocks[0])));
  const card = of((item) => item.tools.some((tool) => /^Run\b/.test(tool.title) && tool.status === 'done'));
  const last = of((item) => item.prose.some((text) => plain(text) === plain(turn.blocks.at(-1))));
  note(ids, `${label}: the first reply ("${turn.blocks[0]}") stays in place, then the bash card (done), `
    + `then the final reply ("${turn.blocks.at(-1)}")`, first >= 0 && card > first && last > card,
  brief({ first, card, last }));
}

/** @brief fc-c：Attach message as context 的芯片原文是整轮正文（两段都在）。 */
async function attachCheck(page, ids, label, turn) {
  const quoted = await attachLatest(page);
  note(ids, `${label}: Attach message as context quotes the whole turn (both the draft and the rewritten `
    + 'reply)', quoted === turn.text && turn.blocks.length === 2, brief({ quoted, want: turn.text }));
}

/**
 * 每个合成的录制：覆盖的编号、核对录制用的 want（checks、finish）、界面的形状（assistants、tools、thinking）、
 * 最后一段正文 final（给出时查操作行在它那一项）、另查的 extra
 */
const FIXTURES = [
  { name: 'fc-a', ids: ['FC-11', 'FC-23'], want: { checks: 1, finish: 1 },
    shape: { assistants: 1, tools: 0, thinking: 0 } },
  { name: 'fc-a-text', ids: ['FC-11'], want: { checks: 1, finish: 1 }, shape: { assistants: 2, tools: 0, thinking: 0 },
    final: 'The reply stands.' },
  { name: 'fc-early', ids: ['FC-11'], want: { checks: 1, finish: 2 }, shape: { assistants: 1, tools: 0, thinking: 0 } },
  { name: 'fc-b', ids: ['FC-12'], want: { checks: 2, finish: 1 }, shape: { assistants: 3, tools: 1, thinking: 0 },
    final: 'The tests passed.', extra: (page, ctx, label, items) => orderCheck(ctx.ids, label, items, ctx.turn) },
  { name: 'fc-c', ids: ['FC-13'], want: { checks: 1, finish: 0 }, shape: { assistants: 2, tools: 0, thinking: 0 },
    final: 'Conclusion first: rewritten answer.',
    extra: (page, ctx, label) => attachCheck(page, ctx.ids, label, ctx.turn) },
  { name: 'fc-a-think', ids: ['FC-23'], want: { checks: 1, finish: 1 },
    shape: { assistants: 2, tools: 0, thinking: 2 } },
];
/** 真实录制（fc-real.mjs 写的；没有不算失败）：名字与覆盖的编号 */
const REAL = [{ name: 'fc-a-real', ids: ['FC-11'] }, { name: 'fc-b-real', ids: ['FC-12'] },
  { name: 'fc-c-real', ids: ['FC-13'] }];

/** @brief 一段回放（part 为空时是整个录制）：照录制做，查共同的几项与这个录制的形状。 */
async function playPart(page, ctx, part) {
  const steps = await load(page, ctx.fx, part);
  await drive(page, steps);
  const { label, items } = await commonChecks(page, ctx, part);
  if (ctx.spec?.shape) shapeCheck(ctx.ids, label, items, ctx.spec.shape);
  if (ctx.spec?.final) finalCheck(ctx.ids, label, items, ctx.spec.final);
  if (part !== 'after') {
    await copyCheck(page, ctx.ids, label, ctx.turn);
    await ctx.spec?.extra?.(page, ctx, label, items);
  } else if (ctx.spec?.name === 'fc-b') orderCheck(ctx.ids, label, items, ctx.turn);
  await finish(page, ctx.ids, label, steps);
}

/** @brief 一个录制的全部检查：录制本身，再回放（有重启时先回放重启前，再回放重启后打开同一个会话的一段）。 */
async function fixtureRun(page, fx, spec, ids) {
  const ctx = { fx, spec, ids, turn: turnOf(fx) };
  recordingCheck(ids, fx.name, ctx.turn, spec?.want);
  const restarted = fx.steps.some((s) => s.restart);
  await playPart(page, ctx, restarted ? 'before' : null);
  if (restarted) await playPart(page, ctx, 'after');
}

/** @brief 跑一组检查；出错时记一条失败；之后记这一组的页面错误。 */
async function guarded(page, errors, { ids, label }, run) {
  const before = errors.length;
  try {
    await run();
  } catch (error) {
    note(ids, `${label}: flow`, false, oneLine(error?.stack ?? error, 800));
    await shot(page, `${label}-error`);
  }
  const mine = errors.slice(before);
  note(ids, `${label}: the page has no errors`, mine.length === 0, mine.slice(0, 5).join(' | '));
}

// ---------- 执行 ----------

const chosen = FIXTURES.filter((f) => !only || only.includes(f.name));
const chosenReal = REAL.filter((f) => !only || only.includes(f.name));
const present = chosen.filter((f) => existsSync(fixturePath(f.name)));
const presentReal = chosenReal.filter((f) => existsSync(fixturePath(f.name)));
for (const f of chosen.filter((item) => !present.includes(item))) {
  for (const id of f.ids) {
    record(`${id} replay fixture missing: tests/fixtures/finish/${f.name}.json (record it with fc-record.mjs)`, false,
      'no recording yet');
  }
}
for (const f of chosenReal.filter((item) => !presentReal.includes(item))) {
  console.log(`[fc-replay] no real recording tests/fixtures/finish/${f.name}.json (fc-real.mjs writes it); `
    + 'not replayed');
}
if (present.length || presentReal.length) {
  await buildHarness();
  const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
    env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
      MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-fc-')) } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  for (const f of [...present, ...presentReal]) {
    const fx = readFixture(f.name);
    const spec = FIXTURES.includes(f) ? f : null;
    await guarded(page, errors, { ids: f.ids, label: f.name }, () => fixtureRun(page, fx, spec, f.ids));
  }
  await app.close();
}
process.exitCode = write(only ? 'fc-partial-replay.json' : 'fc-replay.json') ? 0 : 1;
