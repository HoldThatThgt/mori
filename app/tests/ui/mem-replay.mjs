// 记忆的回放测试（docs/specs/memory.md §14.1 的回放层；§14.2 的 MEM-10、14、17、25、26、27、30）：在 Electron 里载入
// 真正的界面，用回放进程桥（tests/ui/harness）回放 mem-record.mjs 从真实的 App 对合成端点录下的 tests/fixtures/mem/*.json
// （source 为 synthetic，§0 第 4 条）。测试像你一样操作（Open folder…、发录制里的消息、View in Memory、左栏 Memory、
// 记忆页的层与分节、New entry、Edit、Delete…、移动、回滚、增强开关、Run now、设置对话框、新会话提示的 View 与 Dismiss、
// 反馈表单、依据的 Jump to source、F8），回放桥核对界面发出的每条写命令都与录制一致，只读查询按参数配对回答
// （harness/replay.js 的 KEYED）；再按 docs/v1/screens/memory-*.md 检查界面。期望的文字由录下的结果独立算出
// （mem-replay-helpers.mjs），不从 src/ 引用。
//   MEM-10（mem-tool）：memory 工具卡的标题、Done / Failed、View in Memory 打开到那一层那一种那一条（删除打开那次修订），
//     失败的卡没有按钮，不出批准卡；重启后重新打开会话，卡片仍有按钮，删掉的那条只打开列表。
//   MEM-14（mem-page）：左栏 Memory（没有 Review）、页面结构、六个分节、空列表、表单的三句提示（不发命令）、新增、
//     [[slug]] 链接与 Linked from、编辑后的 History、离开确认框（Keep editing）、删除确认框、提升到用户级、用户级的
//     Revisions 与回滚、↑↓ 在行之间移动。
//   MEM-17（mem-settings）：开关、状态行、设置对话框四项（Effort 按录下的 effortPicks：所选范围的第一个候选没标支持思考时
//     不可用并悬停、标了时可用、没有范围时不可用并悬停 Choose a model first.；Choose a time.）、关掉再打开保留设置；
//     读不出设置的项目：状态行、开关失败与保存失败的文字。
//   MEM-25（mem-enhance）：Run now、进度事件下状态行与 Revisions 的 Running 标记、成功 / 全部跳过 / 失败三种状态行；
//     Run now 失败的那一行用回放桥的 failNext（synthetic，检查名里写明）。
//   MEM-26（mem-notice）：新会话提示的文字、View 打开那次修订、View 之后仍在、换会话再回来不再显示、第二个新会话没有、
//     两次修订之和、Dismiss。
//   MEM-27（mem-feedback）：开了增强与没开的两种说明（开着的那段一开始就是它）、保存后 Saved 没有链接。
//   MEM-30（mem-page、mem-enhance；动作记录另加 mem-tool、mem-settings、mem-notice）：一段里换分节、打开两条、修订
//     列表再打开一次修订、enhance.run 与进度事件，都按参数配对；没录过的查询是合成的空结果。§8 的动作记录文字：做完
//     一段里的操作后像你一样按 F8 保存一份报告（报告框不显示最近的操作；回放桥只记下报告，不写文件、不占回放顺序），
//     读它的 Recent activity（保留 30 条，读到 30 条算没读全），按先后有：左栏 Memory 的 Open Memory、换层的
//     Memory: User / Memory: Project、换分节的 Memory: <Facts|TASTE|STRATEGY|REVIEW|AGENT|Revisions>（六个都在
//     mem-page 里）、工具卡与新会话提示 View 的 View in Memory、提示 Dismiss 的 Dismiss memory notice、依据 Jump to
//     source 的 Jump to source from Memory（mem-tool 重启后那条事实的依据；录制里没有 session.read，回放桥按 Session
//     file not found 回答，这条错误日志在 mem-tool 允许），以及记忆与增强的写命令（Save / Edit / Delete memory entry、
//     Move to user level、Roll back revision、Turn on / Turn off enhancement、Save enhancement settings、Run enhancement
//     now，后四个带工作目录；Move to this project 没有录制，由单元层检查）；除了新建、打开、切换会话、Back to app、
//     发送与 F8 本身，没有别的行（只读查询不记）。
// 录制文件还不存在时，每个对应编号记一条失败"<编号> replay fixture missing"（不造假录制）。
// 用法（在 app/ 下）：node tests/ui/mem-replay.mjs [--only mem-tool,mem-page]
// 结果写到 test-results/mem-replay.json（--only 时 mem-partial-replay.json，不计入覆盖检查）；截图在 test-results/mem-replay/。

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, oneLine, sleep } from './lib.mjs';
import { PANE, rowOf, waitReady } from './m3-helpers.mjs';
import { showStep } from './page.mjs';
import {
  ACTIVITY_LINES, backToApp, buildHarness, click, commandsOf, countsText, eventsOf, finish, fixturePath, formatTokens,
  guarded, KIND, harnessDir, lastChangeText, load, memoryLines, metaText, monthDay, monthDayTime, newSession,
  noticeText, OFF_TEXT, openFolder, openMemory, outDir, readFixture, recentActivity, record, recorded, replayStatus,
  resultsOf, segmentEnd, sendRecorded, shot, snap, statusText, strayLines, toolTitle, until, untilPlayed, usageText,
  useZone, watched, write,
} from './mem-replay-helpers.mjs';

const only = arg('only')?.split(',');
/** 分节按钮的测试标识后缀（§10.11） */
const SECTION_ID = { fact: 'facts', taste: 'taste', strategy: 'strategy', review: 'review' };
/** 六个分节的文字（§10.1） */
const SECTIONS = ['Facts', 'TASTE', 'STRATEGY', 'REVIEW', 'AGENT', 'Revisions'];
/** 反馈表单的两种说明（§10.7） */
const NOTE_ON = 'Saved as evidence for this project’s daily enhancement. To have Mori act on it now, use “Attach as '
  + 'context” instead.';
const NOTE_OFF = 'This project doesn’t have enhancement on, so feedback is only saved. To have Mori act on it, use '
  + '“Attach as context” instead.';
/** 回放桥 failNext 的原文（synthetic） */
const SYNTHETIC_FAILURE = 'Synthetic run failure for the replay test';

/** @brief 两个值的 JSON 相同。 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** @brief 检查的 detail。 */
const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);

/**
 * @brief F8 读到的 Recent activity 合乎 want：读全了（不到 30 条）、没有 strayLines、记忆与增强的行按先后与 want 相同。
 * @param got memoryLines(texts) 的结果
 */
const activityOk = (texts, got, want) => texts.length < ACTIVITY_LINES && strayLines(texts).length === 0
  && same(got, want);
/** @brief activityOk 的检查的 detail。 */
const activityDetail = (texts, got, want, extra = {}) => brief({ ...extra, got, want, stray: strayLines(texts),
  texts }, 4000);

// ---------- MEM-10：mem-tool ----------

/** @brief 当前一栏第 n 张工具卡：标题两段、状态行、data-status、有没有 View in Memory。 */
const cardAt = (page, n) => page.locator(`${PANE} [data-testid="tool-card"]`).nth(n).evaluate((card) => ({
  verb: card.querySelector('.tool-verb')?.textContent ?? '', target: card.querySelector('.tool-target')?.textContent
    ?? '', status: card.querySelector('[data-testid="tool-status"]')?.textContent ?? '', data: card.dataset.status,
  view: Boolean(card.querySelector('[data-testid="tool-memory-view"]')) }));

/** @brief 一张 memory 卡是否符合 §7.5：标题、完成时 Done 与 View in Memory，失败时 Failed · <原因第一行> 且没有按钮。 */
function cardOk(card, start, end, live) {
  const title = toolTitle(start.args);
  const text = (end.result?.content ?? []).map((part) => part.text ?? '').join('');
  const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const failed = card.status.startsWith('Failed · ') && first.startsWith(card.status.slice(9).replace(/…$/, ''));
  const done = live ? /^Done( · [\d.]+s)?$/.test(card.status) : card.status === 'Done';
  return card.verb === title.verb && card.target === title.target
    && (end.isError ? card.data === 'failed' && failed && !card.view : card.data === 'done' && done && card.view);
}

/**
 * @brief 点第 n 张卡的 View in Memory，等记忆页的右栏出来（或等到 timeout）；返回记忆页的样子。一轮结束后卡折在步骤组里
 *        （docs/v0/screens/chat.md"步骤组"），先展开那一组。
 */
async function followCard(page, n, pred) {
  await showStep(page.locator(`${PANE} [data-testid="tool-card"]`).nth(n));
  await page.locator(`${PANE} [data-testid="tool-card"]`).nth(n).getByTestId('tool-memory-view').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  return until(page, pred);
}

/** @brief View in Memory（save、update）：那一层那一种、选中那一条、右栏是录下的详情、依据一行带原话。 */
async function viewEntry(page, n, { steps, end, cwd, details, quote, label }) {
  const listCwd = details.layer === 'user' ? null : cwd;
  const list = recorded(steps, end, 'memory.list', { cwd: listCwd, layer: details.layer, kind: details.kind });
  const got = recorded(steps, end, 'memory.get', { cwd, layer: details.layer, id: details.entry });
  const s = await followCard(page, n, (x) => x.detail?.title === got.entry.abstract);
  const at = got.entry.evidence.findIndex((item) => item.quote === quote);
  const evidence = got.entry.evidence[at] ?? {};
  const line = s.detail?.evidence[at] ?? '';
  record(`MEM-10 replay mem-tool: View in Memory on the ${label} card opens the Memory page at ${details.layer} / `
    + `${KIND[details.kind]} with ${details.entry} selected; the right panel shows the recorded entry (title, `
    + '"<KIND> · <Layer> · <You said|Added by Mori> · Created … by Mori" line, the evidence line with the user\'s '
    + 'words and Jump to source); the usage line matches the recorded list',
  s.scope === `memory-scope-${details.layer}` && s.section === `memory-section-${SECTION_ID[details.kind]}`
    && same(s.rows.map((r) => r.id), list.entries.map((e) => e.id))
    && s.rows.find((r) => r.pressed)?.id === details.entry && s.detail.meta[0] === metaText(got.entry)
    && line.startsWith(`${monthDay(evidence.at)} · Session “`) && line.endsWith(`: “${quote}”`)
    && at >= 0 && s.detail.jumps.length === got.entry.evidence.length && s.detail.jumps[at] === 'Jump to source'
    && s.usage === usageText(list.usage, details.layer === 'project'), brief({ s, list: list.entries }));
  await backToApp(page);
  return s;
}

/** @brief View in Memory（forget）：那一层的 Revisions，选中那次修订，右栏是它（Deleted 一块与删除原因）。 */
async function viewForget(page, n, { steps, end, cwd, details, taste, note }) {
  const got = recorded(steps, end, 'memory.revisions', { cwd, layer: details.layer, id: details.revision });
  const s = await followCard(page, n, (x) => x.detail?.title === got.revision.title);
  record('MEM-10 replay mem-tool: View in Memory on the "Delete from memory" card opens Revisions of that layer with '
    + 'the deleting revision selected ("Mori · Deleted TASTE: …", a "Deleted · TASTE · <abstract>" block and '
    + '"Note: <reason>")', s.section === 'memory-section-revisions' && s.scope === 'memory-scope-project'
    && s.revisions.find((r) => r.pressed)?.id === details.revision && s.detail.revision
    && same(s.detail.changes, [`Deleted · TASTE · ${taste}`]) && same(s.detail.notes, [`Note: ${note}`]),
  brief({ s, title: got.revision.title }));
  await backToApp(page);
}

/** @brief mem-tool 重启前：发录制里的七条消息，每条之后查工具卡，成功的点 View in Memory。 */
async function toolBefore(page, fx) {
  const steps = await load(page, fx, { part: 'before' });
  const commands = commandsOf(steps);
  const starts = eventsOf(steps, 'tool_execution_start').filter((e) => e.toolName === 'memory');
  const ends = eventsOf(steps, 'tool_execution_end').filter((e) => e.toolName === 'memory');
  const cwd = commands[0].cwd;
  const cards = [];
  await openFolder(page);
  for (const [i, command] of commands.entries()) {
    if (command.type !== 'session.prompt') continue;
    await sendRecorded(page, commands, i);
    const n = cards.length;
    // 这一轮已经结束，卡折在步骤组里（不显示），只等它在页面里
    await page.locator(`${PANE} [data-testid="tool-card"]`).nth(n).waitFor({ state: 'attached', timeout: 10000 });
    cards.push(await cardAt(page, n));
    const details = ends[n].result?.details;
    const ctx = { steps, end: segmentEnd(steps, i), cwd, details, quote: starts[n].args.quote };
    if (ends[n].isError) continue;
    if (details.action === 'forget') {
      await viewForget(page, n, { ...ctx, taste: starts[2].args.abstract, note: starts[n].args.note });
    } else await viewEntry(page, n, { ...ctx, label: `"${toolTitle(starts[n].args).verb}"` });
  }
  return { steps, cards, starts, ends };
}

/** @brief mem-tool 重启前的检查：卡片、不出批准卡。 */
async function toolCards(page, { steps, cards, starts, ends }) {
  const seen = await watched(page);
  record('MEM-10 replay mem-tool: each memory call is one tool card titled by §7.5 ("Save to Facts" · abstract, '
    + '"Save to TASTE" · abstract, "Update memory" · entry, "Delete from memory" · entry); finished cards show Done '
    + 'and View in Memory, the refused call shows "Failed · <first line of the reason>" and no button',
  cards.length === 7 && cards.every((card, i) => cardOk(card, starts[i], ends[i], true)), brief(cards));
  const stated = ends[6]?.result?.details;
  const meta = stated && recorded(steps, steps.length, 'memory.get', { cwd: commandsOf(steps)[0].cwd,
    layer: stated.layer, id: stated.entry })?.entry;
  record('MEM-10 replay mem-tool: the fact saved without asked (2026-10-26) reads back as added by Mori (source agent, '
    + '"Added by Mori" in the detail line)', meta?.source === 'agent' && metaText(meta).includes(' · Added by Mori · '),
  brief(meta));
  record('MEM-10 replay mem-tool: memory never shows an approval card under Ask each time (tool gate free) and its '
    + 'cards carry no "Allowed for this session" / "Allow all" badge', seen.approvals === 0 && seen.badges === 0,
  brief(seen));
}

/**
 * @brief MEM-30（mem-tool 重启前）：F8 的 Recent activity 里，每张完成的卡上点过的 View in Memory 紧跟在发出它的
 *        消息之后。
 */
async function toolActivity(page, { ends }) {
  const texts = await recentActivity(page, 'MEM-30 recent activity after the memory tool cards');
  const got = memoryLines(texts, true);
  const want = ends.flatMap((end) => (end.isError ? ['Send'] : ['Send', 'View in Memory']));
  record('MEM-30 replay mem-tool: F8 Recent activity records View in Memory on a finished memory card as "View in '
    + 'Memory", once per card used, each right after the message that made the card; the refused card adds nothing',
  activityOk(texts, got, want), activityDetail(texts, got, want));
}

/**
 * @brief 条目详情里第一项依据的 Jump to source：点它，等跳转的结果出来。录制里没有 session.read，回放桥按"Session file
 *        not found"回答（synthetic），所以结果是 Session deleted、界面记一条错误日志（FIXTURES 里 mem-tool 允许它）；
 *        跳转本身由 App 层的 MEM-10 检查，这里为的是动作记录。
 * @return 界面是否按 §8 问过 session.read（这项依据的会话文件，条目作 anchor）
 */
async function jumpFromEntry(page, evidence) {
  await page.getByTestId('memory-detail').getByTestId('memory-jump').first().click();
  await page.getByTestId('memory-jump-status').first().waitFor({ timeout: 10000 });
  return (await replayStatus(page)).queries.some((q) => q.type === 'session.read'
    && q.sessionFile === evidence.session && q.anchor === evidence.entry);
}

/**
 * @brief MEM-30（mem-tool 重启后）：F8 的 Recent activity 按先后有 View in Memory、Jump to source from Memory、
 *        View in Memory。
 * @param asked 点 Jump to source 时界面是否问过 session.read（jumpFromEntry 的结果）
 */
async function reopenActivity(page, asked) {
  const texts = await recentActivity(page, 'MEM-30 recent activity after View in Memory and Jump to source');
  const got = memoryLines(texts);
  const want = ['View in Memory', 'Jump to source from Memory', 'View in Memory'];
  record('MEM-30 replay mem-tool reopened: F8 Recent activity has, in order, "View in Memory" (first card), "Jump to '
    + 'source from Memory" (Jump to source on that entry\'s evidence, which asked session.read with the evidence\'s '
    + 'session file and entry as anchor) and "View in Memory" (third card)', asked && activityOk(texts, got, want),
  activityDetail(texts, got, want, { asked }));
}

/** @brief mem-tool 重启后：打开同一个会话，卡片仍有按钮；点两张卡（删掉的那条只打开列表、不打开详情）。 */
async function toolReopen(page, fx, { starts, ends }) {
  const steps = await load(page, fx, { part: 'after' });
  const open = commandsOf(steps).find((c) => c.type === 'session.open');
  await rowOf(page, open.sessionFile).click();
  await waitReady(page);
  await page.locator(`${PANE} [data-testid="tool-card"]`).nth(6).waitFor({ state: 'attached', timeout: 15000 });
  const cards = [];
  for (let n = 0; n < 7; n += 1) cards.push(await cardAt(page, n));
  record('MEM-10 replay mem-tool reopened: after a restart the reopened session shows the same seven memory cards; the '
    + 'finished ones still have View in Memory (status "Done" without a duration), the refused one has none',
  cards.every((card, i) => cardOk(card, starts[i], ends[i], false)), brief(cards));
  const { cwd } = resultsOf(steps, 'session.open')[0];
  const fact = ends[0].result.details;
  const got = recorded(steps, steps.length, 'memory.get', { cwd, layer: 'project', id: fact.entry });
  const s = await followCard(page, 0, (x) => x.detail?.title === got.entry.abstract);
  record('MEM-10 replay mem-tool reopened: View in Memory on the first card opens the fact (now updated) from the '
    + 'tool result details read back from the session file', s.rows.find((r) => r.pressed)?.id === fact.entry
    && s.detail.title === got.entry.abstract, brief(s));
  const asked = await jumpFromEntry(page, got.entry.evidence[0]);
  await backToApp(page);
  const gone = await followCard(page, 2, (x) => x.state === 'No entries yet.');
  await sleep(500);
  const after = await snap(page);
  record('MEM-10 replay mem-tool reopened: View in Memory on the card of the TASTE entry deleted later opens '
    + 'Project / TASTE with the list as it is ("No entries yet.") and no details panel',
  gone.section === 'memory-section-taste' && after.state === 'No entries yet.' && after.detail === null, brief(after));
  await shot(page, 'mem-tool-reopened');
  await reopenActivity(page, asked);
  await finish(page, 'MEM-10', 'mem-tool after the restart', steps);
}

/** @brief mem-tool 的全部检查。 */
async function toolFixture(page, fx) {
  const before = await toolBefore(page, fx);
  await shot(page, 'mem-tool');
  await toolCards(page, before);
  await toolActivity(page, before);
  await finish(page, 'MEM-10', 'mem-tool before the restart', before.steps);
  await toolReopen(page, fx, before);
}

// ---------- MEM-14、MEM-30：mem-page ----------

/** @brief mem-page 的开头：Open folder…，左栏 Memory；页面结构、六个分节、空列表与用量。 */
async function pageOpen(page, ctx) {
  await openFolder(page);
  await untilPlayed(page, 1, 'session.create');
  const nav = { memory: await page.getByTestId('nav-memory').count(), review: await page.getByTestId('sidebar')
    .getByRole('button', { name: 'Review', exact: true }).count() };
  await openMemory(page);
  const s = await until(page, (x) => x.state === 'No entries yet.' && Boolean(x.enhance?.status));
  const list = recorded(ctx.steps, ctx.end(0), 'memory.list', { cwd: ctx.cwd, layer: 'project', kind: 'fact' });
  record('MEM-14 replay mem-page: the left bar has Memory and no Review; the page has Back to app and the title '
    + 'Memory, User | Project with Project pressed and the folder name, the enhancement block, the six sections '
    + '(Facts pressed), "No entries yet." and the usage "0 / 500 tokens · User 0 + this project 0" with no Last change',
  nav.memory === 1 && nav.review === 0 && /Back to app/.test(s.header) && /Memory/.test(s.header)
    && s.scope === 'memory-scope-project' && s.folder === 'mem-page' && same(s.sections, SECTIONS)
    && s.section === 'memory-section-facts' && s.usage === usageText(list.usage, true)
    && s.usage === '0 / 500 tokens · User 0 + this project 0' && s.last === null, brief({ nav, s }));
}

/** @brief 在表单里填两项、点 Save，返回字段下方的提示与回放桥收到的命令数。 */
async function trySave(page, abstract, details) {
  await page.getByTestId('memory-abstract').fill(abstract);
  await page.getByTestId('memory-details').fill(details);
  await page.getByTestId('memory-save').click();
  await sleep(250);
  return { errors: await page.locator('[data-testid="memory-form"] .field-error').allTextContents(),
    commands: (await replayStatus(page)).commands.length };
}

/** @brief 表单的三句提示（§10.1，不发命令），然后照录制保存第一条。 */
async function pageValidate(page, ctx) {
  const save = ctx.commands[1];
  await click(page, 'memory-new');
  await page.getByTestId('memory-form').waitFor({ timeout: 5000 });
  const empty = await trySave(page, '   ', '');
  const long = await trySave(page, 'x'.repeat(201), '');
  const big = await trySave(page, save.abstract, 'y'.repeat(4001));
  record('MEM-14 replay mem-page: on Save the New entry form shows "Abstract is required." (blank), "Abstract must be '
    + 'at most 200 characters." (201) and "Details must be at most 4,000 characters." (4,001) under the field and '
    + 'sends no command', same(empty.errors, ['Abstract is required.'])
    && same(long.errors, ['Abstract must be at most 200 characters.'])
    && same(big.errors, ['Details must be at most 4,000 characters.'])
    && [empty, long, big].every((x) => x.commands === 1), brief({ empty, long, big }));
}

/** @brief 照录制的第 i 条命令（memory.save，没有 id）新增一条，等它放完、右栏是它。 */
async function addEntry(page, ctx, i) {
  const save = ctx.commands[i];
  if (!(await page.getByTestId('memory-form').count())) await click(page, 'memory-new');
  await page.getByTestId('memory-abstract').fill(save.abstract);
  await page.getByTestId('memory-details').fill(save.detail);
  await page.getByTestId('memory-save').click();
  await untilPlayed(page, i + 1, `memory.save ${i}`);
  return until(page, (x) => x.detail?.title === save.abstract && !x.detail.form
    && x.rows.some((r) => r.title === save.abstract));
}

/** @brief 新增三条：行（You said、日期、选中）、用量、Last change、详情各块；第三条的 [[slug]] 是链接。 */
async function pageAdd(page, ctx) {
  const first = await addEntry(page, ctx, 1);
  const list = recorded(ctx.steps, ctx.end(1), 'memory.list', { cwd: ctx.cwd, layer: 'project', kind: 'fact' });
  const got = recorded(ctx.steps, ctx.end(1), 'memory.get', { cwd: ctx.cwd, layer: 'project', id: list.entries[0].id });
  const row = first.rows[0];
  record('MEM-14 replay mem-page: after Save the new entry is the selected row with "You said" and its date, the usage '
    + 'and "Last change <Mon D> · Added 1" follow the recorded list, and the right panel shows its title, the '
    + '"Facts · Project · You said · Created … by you · Modified … by you" line, "No evidence recorded.", the Details '
    + 'and Edit / Delete… / Move to user level',
  first.rows.length === 1 && row.pressed && row.source === 'user' && same(row.tags, ['You said'])
    && row.meta.includes(monthDay(got.entry.modified)) && first.usage === usageText(list.usage, true)
    && first.last === lastChangeText(list.last) && /Added 1$/.test(first.last)
    && first.detail.meta[0] === metaText(got.entry) && first.detail.noEvidence
    && first.detail.details === got.entry.details && same(first.detail.actions, ['Edit', 'Delete…',
      'Move to user level']), brief(first));
  await addEntry(page, ctx, 2);
  const third = await addEntry(page, ctx, 3);
  const linked = await until(page, (x) => x.detail?.links.length === 1);
  record('MEM-14 replay mem-page: the third entry\'s Details render [[slug]] as a link showing the linked entry\'s '
    + `abstract ("${ctx.commands[2].abstract}")`, same(linked?.detail?.links, [ctx.commands[2].abstract])
    && third.rows.length === 3, brief(linked?.detail));
}

/** @brief 选第二条：Linked from 列出第三条；Edit 改 abstract 并保存：History 多一行 Edited on the Memory page。 */
async function pageEdit(page, ctx) {
  const edit = ctx.commands[4];
  await click(page, 'memory-row', edit.id);
  const second = await until(page, (x) => x.detail?.title === ctx.commands[2].abstract && x.detail.backlinks.length);
  record('MEM-14 replay mem-page: the linked entry lists "Linked from" with "Facts · <abstract of the linking entry>"',
    same(second.detail.backlinks, [`Facts · ${ctx.commands[3].abstract}`]), brief(second.detail));
  await click(page, 'memory-edit');
  const initial = { abstract: await page.getByTestId('memory-abstract').inputValue(),
    details: await page.getByTestId('memory-details').inputValue() };
  await page.getByTestId('memory-abstract').fill(edit.abstract);
  await page.getByTestId('memory-save').click();
  await untilPlayed(page, 5, 'the edit');
  const s = await until(page, (x) => x.detail?.title === edit.abstract && !x.detail.form);
  const got = recorded(ctx.steps, ctx.end(4), 'memory.get', { cwd: ctx.cwd, layer: 'project', id: edit.id });
  record('MEM-14 replay mem-page: Edit opens the form with the entry\'s abstract and Details; Save sends memory.save '
    + 'with the id and the History gains "<Mon D> · You: Edited on the Memory page"',
  initial.abstract === ctx.commands[2].abstract && initial.details === edit.detail
    && s.detail.history.includes(`${monthDay(got.entry.modified)} · You: Edited on the Memory page`)
    && s.rows.some((r) => r.id === edit.id && r.title === edit.abstract), brief({ initial, s: s.detail }));
}

/** @brief 确认框的标题、说明与按钮。 */
const dialogTexts = async (dialog) => ({ title: await dialog.locator('h2').textContent(),
  text: await dialog.locator('p').first().textContent(), buttons: await dialog.locator('button').allTextContents() });

/** @brief 有未保存的编辑时点另一行：离开确认框，Keep editing 留在表单；Cancel 不问，回到详情；都不发命令。 */
async function pageLeave(page, ctx) {
  const edit = ctx.commands[4];
  await click(page, 'memory-edit');
  await page.getByTestId('memory-abstract').fill('Unsaved draft');
  await click(page, 'memory-row', ctx.ids[2]);
  const dialog = page.getByTestId('leave-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const shown = await dialogTexts(dialog);
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  const kept = await page.getByTestId('memory-abstract').inputValue();
  await page.getByTestId('memory-form').getByRole('button', { name: 'Cancel' }).click();
  const back = await until(page, (x) => x.detail?.title === edit.abstract && !x.detail.form);
  record('MEM-14 replay mem-page: with unsaved edits, choosing another row asks "Discard changes to this entry?" / '
    + '"Your edits haven’t been saved. Leaving now discards them." (Discard, Keep editing); Keep editing keeps the '
    + 'form and the typed text; Cancel closes the form without asking; no command is sent',
  shown.title === 'Discard changes to this entry?'
    && shown.text === 'Your edits haven’t been saved. Leaving now discards them.'
    && same(shown.buttons, ['Discard', 'Keep editing']) && kept === 'Unsaved draft'
    && back.detail.title === edit.abstract
    && (await replayStatus(page)).commands.length === 5, brief({ shown, kept }));
}

/** @brief Delete…：确认框的文字，Delete 之后这一行不在、右栏关闭。 */
async function pageDelete(page, ctx) {
  const del = ctx.commands[5];
  await click(page, 'memory-row', del.id);
  const s = await until(page, (x) => x.detail?.title === ctx.commands[1].abstract);
  await click(page, 'memory-delete');
  const dialog = page.getByTestId('memory-delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const shown = await dialogTexts(dialog);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await untilPlayed(page, 6, 'memory.delete');
  const after = await until(page, (x) => !x.rows.some((r) => r.id === del.id) && x.detail === null);
  record('MEM-14 replay mem-page: Delete… asks "Delete “<abstract>”?" / "You can roll it back from Revisions." '
    + '(Delete, Cancel); Delete sends memory.delete, the row goes away and the details panel closes',
  shown.title === `Delete “${s.detail.title}”?` && shown.text === 'You can roll it back from Revisions.'
    && same(shown.buttons, ['Delete', 'Cancel']) && !after.rows.some((r) => r.id === del.id) && after.detail === null,
  brief({ shown, rows: after.rows }));
}

/** @brief Move to user level：这一条离开本项目；User 层有它（You said），History 有移动的一行，按钮是放回本项目。 */
async function pageMove(page, ctx) {
  const move = ctx.commands[6];
  await click(page, 'memory-row', move.id);
  await until(page, (x) => x.detail?.title === ctx.commands[4].abstract);
  const label = (await snap(page)).detail.actions.at(-1);
  await click(page, 'memory-move');
  await untilPlayed(page, 7, 'memory.move');
  const left = await until(page, (x) => !x.rows.some((r) => r.id === move.id) && x.detail === null);
  await click(page, 'memory-scope-user');
  const list = recorded(ctx.steps, ctx.end(6), 'memory.list', { cwd: null, layer: 'user', kind: 'fact' });
  const user = await until(page, (x) => x.scope === 'memory-scope-user' && x.rows.length === list.entries.length);
  await click(page, 'memory-row', list.entries[0].id);
  const got = recorded(ctx.steps, ctx.end(6), 'memory.get', { cwd: ctx.cwd, layer: 'user', id: list.entries[0].id });
  const s = await until(page, (x) => x.detail?.title === got.entry.abstract);
  record('MEM-14 replay mem-page: "Move to user level" sends memory.move and the entry leaves Project; User lists it '
    + 'as "You said" (no enhancement block there), its History has "<Mon D> · You: Moved to user level" and the '
    + 'move button reads "Move to this project"', label === 'Move to user level' && left.rows.length === 1
    && user.enhance === null && same(user.rows.map((r) => [r.id, r.source]), list.entries.map((e) => [e.id, 'user']))
    && s.detail.meta[0] === metaText(got.entry)
    && s.detail.history.includes(`${monthDay(got.entry.modified)} · You: Moved to user level`)
    && s.detail.actions.at(-1) === 'Move to this project', brief({ left: left.rows, user: user.rows, s: s.detail }));
}

/** @brief 用户级 Revisions：移动那次的行与详情；Roll back this revision 之后多一条 Rollback，选中不变。 */
async function pageRollback(page, ctx) {
  const roll = ctx.commands[7];
  await click(page, 'memory-section-revisions');
  const list = recorded(ctx.steps, ctx.end(6), 'memory.revisions', { cwd: null, layer: 'user', id: null });
  const rows = await until(page, (x) => x.revisions.length === list.revisions.length);
  await click(page, 'revision-row', roll.id);
  const got = recorded(ctx.steps, ctx.end(6), 'memory.revisions', { cwd: null, layer: 'user', id: roll.id });
  const s = await until(page, (x) => x.detail?.title === got.revision.title);
  await click(page, 'revision-rollback');
  await untilPlayed(page, 8, 'memory.rollback');
  const after = await until(page, (x) => x.revisions[0]?.tags.includes('Rollback'));
  const row = rows.revisions[0];
  record('MEM-14 replay mem-page: User → Revisions lists "You · Moved to user level: <abstract>" with its time and '
    + '"Moved 1"; its details show the time and who, and a "Moved · Facts · <abstract>" block; Roll back this '
    + 'revision adds "Rolled back: …" marked Rollback on top and keeps the rolled-back revision selected',
  row.title === list.revisions[0].title && row.meta.includes(monthDayTime(Date.parse(list.revisions[0].time)))
    && row.meta.includes(countsText(list.revisions[0].counts))
    && s.detail.meta[0] === `${monthDayTime(Date.parse(got.revision.time))} · You`
    && same(s.detail.changes, [`Moved · Facts · ${ctx.commands[4].abstract}`])
    && after.revisions[0].title === `Rolled back: ${got.revision.title}` && after.detail?.title === got.revision.title
    && after.revisions.find((r) => r.pressed)?.id === roll.id, brief({ row, s: s.detail, after: after.revisions }));
}

/** @brief 最后一段（MEM-30）：换分节、打开两条、修订列表再打开一次修订，都按参数配对回答。 */
async function pageQueries(page, ctx) {
  const end = ctx.steps.length;
  const facts = recorded(ctx.steps, end, 'memory.list', { cwd: ctx.cwd, layer: 'project', kind: 'fact' });
  const taste = recorded(ctx.steps, end, 'memory.list', { cwd: ctx.cwd, layer: 'project', kind: 'taste' });
  await click(page, 'memory-scope-project');
  await click(page, 'memory-section-facts');
  const a = await until(page, (x) => same(x.rows.map((r) => r.id), facts.entries.map((e) => e.id)));
  await click(page, 'memory-section-taste');
  const b = await until(page, (x) => x.section === 'memory-section-taste' && x.state === 'No entries yet.');
  await click(page, 'memory-section-facts');
  const c = await until(page, (x) => x.section === 'memory-section-facts' && x.rows.length === facts.entries.length);
  const titles = [];
  for (const entry of facts.entries) {
    await click(page, 'memory-row', entry.id);
    titles.push((await until(page, (x) => x.detail?.title === entry.abstract))?.detail?.title);
  }
  record('MEM-30 replay mem-page: in one segment Facts → TASTE → Facts and opening two entries are each answered by '
    + 'parameters (the Facts list, the empty TASTE list with its usage, each entry\'s own details)',
  same(a.rows.map((r) => r.title), facts.entries.map((e) => e.abstract)) && b.usage === usageText(taste.usage, true)
    && c.rows.length === 2 && same(titles, facts.entries.map((e) => e.abstract)), brief({ a: a.rows, b, titles }));
  await pageRevisionQueries(page, ctx);
}

/** @brief 最后一段（MEM-30、MEM-14）：修订列表再打开一次修订；↑↓ 在行之间移动；没录过的查询是合成的空结果。 */
async function pageRevisionQueries(page, ctx) {
  const end = ctx.steps.length;
  const list = recorded(ctx.steps, end, 'memory.revisions', { cwd: ctx.cwd, layer: 'project', id: null });
  const id = list.revisions[0].id;
  const got = recorded(ctx.steps, end, 'memory.revisions', { cwd: ctx.cwd, layer: 'project', id });
  await click(page, 'memory-section-revisions');
  const rows = await until(page, (x) => x.revisions.length === list.revisions.length);
  await click(page, 'revision-row', id);
  const s = await until(page, (x) => x.detail?.title === got.revision.title);
  record('MEM-30 replay mem-page: the revision list and then one revision are answered by parameters (the project '
    + 'list, then that revision\'s details)', same(rows.revisions.map((r) => r.id), list.revisions.map((r) => r.id))
    && s.detail.title === got.revision.title, brief({ rows: rows.revisions, title: s.detail?.title }));
  const focus = () => page.evaluate(() => document.activeElement?.dataset.id ?? null);
  await page.locator(`[data-testid="revision-row"][data-id="${id}"]`).focus();
  await page.keyboard.press('ArrowDown');
  const down = await focus();
  await page.keyboard.press('ArrowUp');
  record('MEM-14 replay mem-page: ↓ and ↑ move the focus between the rows of a list',
    down === list.revisions[1]?.id && (await focus()) === id, brief({ down }));
  await click(page, 'memory-scope-user');
  await click(page, 'memory-section-review');
  const empty = await until(page, (x) => x.section === 'memory-section-review' && x.state === 'No entries yet.');
  const asked = (await replayStatus(page)).queries.some((q) => q.type === 'memory.list' && q.cwd === null
    && q.layer === 'user' && q.kind === 'review');
  record('MEM-30 replay mem-page: a read-only query the recording never made (memory.list user / REVIEW) gets the '
    + 'synthetic empty result: "No entries yet." and "0 / 500 tokens"', asked && empty.usage === '0 / 500 tokens'
    && recorded(ctx.steps, end, 'memory.list', { cwd: null, layer: 'user', kind: 'review' }) === undefined,
  brief(empty));
}

/** mem-page 里按先后做的记忆操作与写命令在 Recent activity 里的文字（§8） */
const PAGE_ACTIVITY = ['Open Memory', 'Save memory entry', 'Save memory entry', 'Save memory entry',
  'Edit memory entry', 'Delete memory entry', 'Move to user level', 'Memory: User', 'Memory: Revisions',
  'Roll back revision', 'Memory: Project', 'Memory: Facts', 'Memory: TASTE', 'Memory: Facts', 'Memory: Revisions',
  'Memory: User', 'Memory: REVIEW', 'Memory: STRATEGY', 'Memory: AGENT'];

/**
 * @brief 最后一段（MEM-30）：User 层再换到 STRATEGY（没录过，合成的空列表）与 AGENT，然后 F8：Recent activity 按先后是
 *        New session、PAGE_ACTIVITY、Report a UI issue，没有别的行（只读查询不记）。
 */
async function pageActivity(page) {
  await click(page, 'memory-section-strategy');
  await until(page, (x) => x.section === 'memory-section-strategy' && x.state === 'No entries yet.');
  await click(page, 'memory-section-agent');
  await page.getByTestId('memory-agent-total').waitFor({ timeout: 10000 });
  const texts = await recentActivity(page, 'MEM-30 recent activity on the Memory page');
  const got = memoryLines(texts);
  record('MEM-30 replay mem-page: F8 Recent activity lists, in order, left-bar Memory as "Open Memory", each layer '
    + 'switch as "Memory: User" / "Memory: Project", each section switch as "Memory: <Facts|TASTE|STRATEGY|REVIEW|'
    + 'AGENT|Revisions>" (all six), and the writes as "Save memory entry", "Edit memory entry", "Delete memory '
    + 'entry", "Move to user level" and "Roll back revision"; the read-only queries (lists, entries, revisions, '
    + 'enhance.get, agents.get) add no line', activityOk(texts, got, PAGE_ACTIVITY),
  activityDetail(texts, got, PAGE_ACTIVITY));
}

/** @brief mem-page 的全部检查。 */
async function pageFixture(page, fx) {
  const steps = await load(page, fx);
  const commands = commandsOf(steps);
  const ctx = { steps, commands, cwd: commands[0].cwd, end: (i) => segmentEnd(steps, i),
    ids: resultsOf(steps, 'memory.save').map((r) => r.id) };
  await pageOpen(page, ctx);
  await pageValidate(page, ctx);
  await pageAdd(page, ctx);
  await pageEdit(page, ctx);
  await pageLeave(page, ctx);
  await pageDelete(page, ctx);
  await pageMove(page, ctx);
  await pageRollback(page, ctx);
  await shot(page, 'mem-page-rollback');
  await pageQueries(page, ctx);
  await shot(page, 'mem-page');
  await pageActivity(page);
  await finish(page, 'MEM-14', 'mem-page', steps);
}

// ---------- MEM-17：mem-settings ----------

/** Effort 不可用时的两种悬停（§10.4；没有范围的那句是 docs/v1/screens/memory-enhance.md 的临时文字） */
const EFFORT_UNSUPPORTED = 'This model isn’t marked “Supports thinking”';
const EFFORT_NO_RANGE = 'Choose a model first.';

/**
 * @brief Effort 下拉按录下的 effortPicks 应有的样子（§8、§10.4、memory-enhance.md）：所选范围的第一个候选标了支持思考时
 *        可用、没有悬停；为假时不可用、悬停 EFFORT_UNSUPPORTED；没有选中范围或范围不在 effortPicks 里时不可用、悬停
 *        EFFORT_NO_RANGE。
 * @param info 对话框用的 EnhanceInfo（录下的结果）
 * @param pick 下拉里选中的范围；没有时为空串或 null
 */
function effortWant(info, pick) {
  const thinks = pick ? info.effortPicks?.[pick] : undefined;
  if (thinks === true) return { disabled: false, title: null };
  return { disabled: true, title: thinks === false ? EFFORT_UNSUPPORTED : EFFORT_NO_RANGE };
}

/** @brief 对话框里 Effort 的样子与 want 相同。 */
const effortOk = (state, want) => state.effortDisabled === want.disabled && state.effortTitle === want.title;

/** @brief 打开设置对话框，等模型设置读到（Model range 可用）之后返回它的样子。 */
async function openDialog(page) {
  await click(page, 'enhance-settings');
  await page.waitForFunction(() => document.querySelector('[data-testid="enhance-model"]')?.disabled === false, null,
    { timeout: 10000 });
  return dialogState(page);
}

/** @brief 设置对话框此刻的样子。 */
const dialogState = (page) => page.getByTestId('enhance-dialog').evaluate((el) => {
  const q = (css) => el.querySelector(css);
  const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  return { title: text(q('h2')), model: q('[data-testid="enhance-model"]').value,
    groups: [...el.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map(text)]),
    effort: q('[data-testid="enhance-effort"]').value, effortDisabled: q('[data-testid="enhance-effort"]').disabled,
    effortTitle: q('[data-testid="enhance-effort"]').getAttribute('title'),
    efforts: [...el.querySelectorAll('[data-testid="enhance-effort"] option')].map(text),
    team: q('[data-testid="enhance-team"]').checked, time: q('[data-testid="enhance-time"]').value,
    labels: [...el.querySelectorAll('label, legend')].map(text),
    hints: [...el.querySelectorAll('.field-hint')].map(text),
    alerts: [...el.querySelectorAll('[role="alert"]')].map(text) };
});

/** @brief 开关：Off 的样子；点开关之后按 enhance.set 的 info。 */
async function settingsSwitch(page, ctx) {
  await openFolder(page);
  await untilPlayed(page, 1, 'session.create');
  await openMemory(page);
  const off = await until(page, (x) => x.enhance?.status === OFF_TEXT);
  await click(page, 'enhance-switch');
  await untilPlayed(page, 2, 'enhance.set on');
  const info = ctx.sets[0].info;
  const on = await until(page, (x) => x.enhance?.checked === 'true' && x.enhance.status === statusText(info));
  record('MEM-17 replay mem-settings: off, the block shows the switch (aria-checked false), "Off · Each day, three '
    + 'background runs …" and Run now disabled; turning it on sends enhance.set { enabled: true } and shows '
    + `"${statusText(info)}" (default range ${info.pick}, 04:00, since today)`,
  off.enhance.checked === 'false' && off.enhance.runDisabled && on.enhance.status === statusText(info)
    && info.pick === 'mem/fake-coder' && info.time === '04:00' && info.since !== null && !on.enhance.runDisabled,
  brief({ off: off.enhance, on: on.enhance }));
}

/** @brief 设置对话框：初值、Effort 按 effortPicks（默认范围不可用、选 fake-think 可用）、清空时间时 Choose a time.、保存。 */
async function settingsDialog(page, ctx) {
  const save = ctx.commands[2];
  const info = ctx.sets[0].info;
  const first = await openDialog(page);
  await page.getByTestId('enhance-model').selectOption(save.pick);
  const think = await dialogState(page);
  const want = { first: effortWant(info, info.pick), think: effortWant(info, save.pick) };
  await page.getByTestId('enhance-effort').selectOption(save.thinking);
  await page.getByTestId('enhance-team').setChecked(save.team);
  await page.getByTestId('enhance-time').fill('');
  await click(page, 'enhance-save');
  await sleep(250);
  const cleared = { ...(await dialogState(page)), commands: (await replayStatus(page)).commands.length };
  await page.getByTestId('enhance-time').fill(save.time);
  await click(page, 'enhance-save');
  await untilPlayed(page, 3, 'enhance.set settings');
  await page.getByTestId('enhance-dialog').waitFor({ state: 'detached', timeout: 5000 });
  const s = await until(page, (x) => x.enhance?.status === statusText(ctx.sets[1].info));
  record('MEM-17 replay mem-settings: Settings… opens "Enhancement settings" with Model range (Providers / Models, no '
    + 'None) at the default range; Effort (seven levels) follows the recorded effortPicks of that range: its first '
    + 'candidate isn’t marked Supports thinking, so Effort is disabled with "This model isn’t marked “Supports '
    + 'thinking”"; Task mode "Run in task mode" with its hint, Daily time 04:00 with its hint',
  first.title === 'Enhancement settings' && first.model === info.pick && want.first.title === EFFORT_UNSUPPORTED
    && effortOk(first, want.first) && first.efforts.length === 7
    && first.effort === info.thinking && !first.team && first.time === '04:00'
    && !first.groups.flat(2).includes('None') && first.labels.includes('Run in task mode')
    && same(first.hints, ['Uses this project’s agents in .mori/agents.',
      'Runs once a day at this time. Conversations before it count as the previous day.']),
  brief({ first, effortPicks: info.effortPicks }));
  record('MEM-17 replay mem-settings: choosing a range whose first candidate is marked Supports thinking in the '
    + 'recorded effortPicks enables Effort with no hover; a cleared Daily time shows "Choose a time." and sends '
    + 'nothing; Save sends the four settings and the status line follows them',
  !want.think.disabled && effortOk(think, want.think) && same(cleared.alerts, ['Choose a time.'])
    && cleared.commands === 2 && s.enhance.status === statusText(ctx.sets[1].info),
  brief({ think, cleared, status: s.enhance.status }));
}

/** @brief 关掉再打开：状态行按 info，设置保留（对话框里是保存过的四项）。 */
async function settingsKeep(page, ctx) {
  const save = ctx.commands[2];
  await click(page, 'enhance-switch');
  await untilPlayed(page, 4, 'enhance.set off');
  const off = await until(page, (x) => x.enhance?.status === OFF_TEXT && x.enhance.checked === 'false');
  await click(page, 'enhance-switch');
  await untilPlayed(page, 5, 'enhance.set on again');
  const on = await until(page, (x) => x.enhance?.status === statusText(ctx.sets[3].info));
  const kept = await openDialog(page);
  await page.getByTestId('enhance-dialog').getByRole('button', { name: 'Cancel' }).click();
  record('MEM-17 replay mem-settings: off then on again keeps the range, effort, team mode and time (the dialog shows '
    + 'them, Effort enabled again for the saved range; Cancel sends nothing) and the status line uses the saved time',
  off.enhance.status === OFF_TEXT && on.enhance.status === statusText(ctx.sets[3].info)
    && on.enhance.status.endsWith(save.time) && kept.model === save.pick && kept.effort === save.thinking
    && effortOk(kept, effortWant(ctx.sets[3].info, save.pick))
    && kept.team === save.team && kept.time === save.time && (await replayStatus(page)).commands.length === 5,
  brief({ on: on.enhance, kept }));
}

/** @brief 读不出设置的项目：状态行、开关失败的一行（开关回到关）、对话框保存失败的一行（不关闭）。 */
async function settingsBroken(page, ctx) {
  await backToApp(page);
  await openFolder(page);
  await untilPlayed(page, 6, 'the second session');
  await openMemory(page);
  const info = recorded(ctx.steps, ctx.end(5), 'enhance.get', { cwd: ctx.commands[5].cwd });
  const read = await until(page, (x) => x.enhance?.status === statusText(info));
  await click(page, 'enhance-switch');
  await untilPlayed(page, 7, 'enhance.set on (refused)');
  const refused = await until(page, (x) => Boolean(x.enhance?.error));
  const opened = await openDialog(page);
  await click(page, 'enhance-save');
  await untilPlayed(page, 8, 'enhance.set settings (refused)');
  await sleep(300);
  const dialog = await dialogState(page);
  await page.getByTestId('enhance-dialog').getByRole('button', { name: 'Cancel' }).click();
  record('MEM-17 replay mem-settings: a project whose enhance.json can’t be read shows "Couldn’t read the enhancement '
    + 'settings: <reason>" with the switch off; the switch shows "Couldn’t change enhancement: <reason>" and stays '
    + 'off; the dialog Save shows "Couldn’t save the enhancement settings: <reason>" and stays open',
  read.enhance.status === `Couldn’t read the enhancement settings: ${info.error}` && read.enhance.checked === 'false'
    && refused.enhance.error === `Couldn’t change enhancement: ${ctx.sets[4].error}`
    && refused.enhance.checked === 'false'
    && same(dialog.alerts, [`Couldn’t save the enhancement settings: ${ctx.sets[5].error}`]),
  brief({ read: read.enhance, refused: refused.enhance, dialog: dialog.alerts }));
  const want = effortWant(info, opened.model);
  record('MEM-17 replay mem-settings: with no range chosen (the project has none) the dialog’s Model range has no '
    + 'selection and Effort is disabled with "Choose a model first." (temporary text, memory-enhance.md)',
  info.pick === null && opened.model === '' && want.title === EFFORT_NO_RANGE && effortOk(opened, want),
  brief({ opened, effortPicks: info.effortPicks }));
}

/**
 * @brief MEM-30（mem-settings）：F8 的 Recent activity 按先后有 Open Memory 与每次 enhance.set 的文字（只带开关的是
 *        Turn on / Turn off enhancement <文件夹>，设置对话框的 Save 是 Save enhancement settings <文件夹>，被拒绝的也记）。
 */
async function settingsActivity(page, ctx) {
  const [one, two] = [ctx.commands[0].cwd, ctx.commands[5].cwd];
  const want = ['Open Memory', `Turn on enhancement ${one}`, `Save enhancement settings ${one}`,
    `Turn off enhancement ${one}`, `Turn on enhancement ${one}`, 'Open Memory', `Turn on enhancement ${two}`,
    `Save enhancement settings ${two}`];
  const texts = await recentActivity(page, 'MEM-30 recent activity after the enhancement settings');
  const got = memoryLines(texts);
  record('MEM-30 replay mem-settings: F8 Recent activity records the switch as "Turn on enhancement <folder>" / "Turn '
    + 'off enhancement <folder>" and the settings dialog\'s Save as "Save enhancement settings <folder>" (refused ones '
    + 'too), in order with "Open Memory"; a Save stopped by "Choose a time." and Cancel add nothing',
  activityOk(texts, got, want), activityDetail(texts, got, want));
}

/** @brief mem-settings 的全部检查。 */
async function settingsFixture(page, fx) {
  const steps = await load(page, fx);
  const commands = commandsOf(steps);
  const ctx = { steps, commands, sets: resultsOf(steps, 'enhance.set'), end: (i) => segmentEnd(steps, i) };
  await settingsSwitch(page, ctx);
  await settingsDialog(page, ctx);
  await settingsKeep(page, ctx);
  await shot(page, 'mem-settings');
  await settingsBroken(page, ctx);
  await shot(page, 'mem-settings-broken');
  await settingsActivity(page, ctx);
  await finish(page, 'MEM-17', 'mem-settings', steps);
}

// ---------- MEM-25、MEM-30：mem-enhance ----------

/** @brief 第 i 条命令那一段里录下的 enhance.get 结果算出的状态行（去掉相邻重复）。 */
function segmentStatuses(steps, i, cwd) {
  const from = segmentEnd(steps, i - 1);
  const texts = steps.slice(from, segmentEnd(steps, i)).filter((s) => s.result?.type === 'enhance.get'
    && s.result.value?.cwd === cwd).map((s) => statusText(s.result.value));
  return texts.filter((text, k) => k === 0 || text !== texts[k - 1]);
}

/** @brief small 是否是 big 的子序列。 */
const subsequence = (small, big) => {
  let i = 0;
  for (const value of big) if (value === small[i]) i += 1;
  return i === small.length;
};

/** @brief 点 Run now，等第 i 条命令那一段放完、状态行是最后录下的那一行；返回这期间看到的状态行与 Revisions 标记。 */
async function runNow(page, ctx, i) {
  await page.evaluate(() => { window.__memWatch.statuses = []; window.__memWatch.tags = []; });
  const queries = (await replayStatus(page)).queries.length;
  const before = (await snap(page)).enhance.status;
  await click(page, 'enhance-run');
  await untilPlayed(page, i + 1, `enhance.run ${i}`);
  const want = segmentStatuses(ctx.steps, i, ctx.cwd);
  const s = await until(page, (x) => x.enhance?.status === want.at(-1));
  const seen = await watched(page);
  const status = await replayStatus(page);
  const asked = status.queries.slice(queries).filter((q) => q.type === 'enhance.get').length;
  const progress = ctx.steps.slice(segmentEnd(ctx.steps, i - 1), segmentEnd(ctx.steps, i))
    .filter((step) => step.envelope?.event.type === 'mori.enhance_progress').length;
  const texts = seen.statuses.map((x) => x.status).filter((text, k, all) => text && (k === 0 || text !== all[k - 1]));
  // 点 Run now 时（发送中按钮不可用）记录器记下的是点之前的那一行，不算运行中看到的
  if (texts.length > 1 && texts[0] === before) texts.shift();
  return { s, seen, want, texts, asked, progress };
}

/** @brief 状态行在运行中的样子都来自录下的结果，按录下的先后；运行中与排着时 Run now 不可用。 */
function progressOk(run) {
  const busy = run.seen.statuses.filter((x) => /^Running |queued/.test(x.status ?? ''));
  return run.texts.every((text) => run.want.includes(text)) && subsequence(run.texts, run.want)
    && run.texts.at(-1) === run.want.at(-1) && busy.every((x) => x.runDisabled) && run.asked >= run.progress;
}

/** @brief 第一次 Run now：TASTE 加一条，另两种没有改动；Running 的状态行与 Revisions 标记，最后是上次成功的一行。 */
async function enhanceFirst(page, ctx) {
  await openFolder(page);
  await sendRecorded(page, ctx.commands, 1);
  await openMemory(page);
  await until(page, (x) => x.enhance?.status === OFF_TEXT);
  await click(page, 'enhance-switch');
  await untilPlayed(page, 3, 'enhance.set on');
  const ready = await until(page, (x) => x.enhance?.checked === 'true' && !x.enhance.runDisabled);
  await click(page, 'memory-section-revisions');
  await until(page, (x) => x.state === 'No revisions yet.');
  const run = await runNow(page, ctx, 3);
  const list = recorded(ctx.steps, ctx.end(3), 'memory.revisions', { cwd: ctx.cwd, layer: 'project', id: null });
  record('MEM-25 replay mem-enhance: Run now (enabled once enhancement is on) sends enhance.run; while the three tasks '
    + 'run the status line goes through "Running TASTE enhancement… · 2 queued", STRATEGY, REVIEW in the recorded '
    + 'order with Run now disabled, and ends on "On · Last run <Mon D> <hh:mm> · TASTE: added 1 · <n>k tokens · Next '
    + 'run …"', !ready.enhance.runDisabled && run.texts.some((t) => t.startsWith('Running TASTE enhancement…'))
    && run.texts.some((t) => t.startsWith('Running REVIEW')) && progressOk(run)
    && /^On · Last run .+ · TASTE: added 1 · \d+k tokens · Next run /.test(run.s.enhance.status),
  brief({ texts: run.texts, want: run.want }));
  record('MEM-25 replay mem-enhance: Revisions shows each run\'s revision marked Running while it runs; afterwards '
    + 'the three rows "<KIND> enhancement · <Mon D>" carry their counts and no Running',
  run.seen.tags.includes('Running') && same(run.s.revisions.map((r) => r.title), list.revisions.map((r) => r.title))
    && run.s.revisions.every((r, k) => !r.tags.includes('Running') && r.meta.includes(countsText(
      list.revisions[k].counts))), brief({ tags: run.seen.tags, rows: run.s.revisions }));
  record('MEM-30 replay mem-enhance: during enhance.run every progress event makes the page re-read enhance.get, and '
    + 'each answer is the recorded result at that point of the replay (not the latest), so every status line seen '
    + 'is one recorded in the segment, in order', progressOk(run) && run.texts.length >= 3,
  brief({ asked: run.asked, progress: run.progress, texts: run.texts }));
}

/** @brief 第二次 Run now：没有新内容，全部跳过；之后 failNext 让 Run now 失败（synthetic）。 */
async function enhanceSkipped(page, ctx) {
  const run = await runNow(page, ctx, 4);
  record('MEM-25 replay mem-enhance: Run now again with nothing new: all three tasks are skipped and the status line '
    + 'reads "On · Last run <Mon D> <hh:mm> · No finished sessions to read · Next run <Mon D> <hh:mm>"',
  progressOk(run) && /^On · Last run .+ · No finished sessions to read · Next run /.test(run.s.enhance.status),
  brief({ texts: run.texts, want: run.want }));
  const before = (await replayStatus(page)).commands.length;
  await page.evaluate((text) => { window.__replay.failNext = text; }, SYNTHETIC_FAILURE);
  await click(page, 'enhance-run');
  const failed = await until(page, (x) => x.enhance?.status?.startsWith('Couldn’t run'));
  record('MEM-25 replay mem-enhance (synthetic failNext): when enhance.run itself fails the status line reads '
    + '"Couldn’t run enhancement: <reason>" and nothing is replayed',
  failed.enhance.status === `Couldn’t run enhancement: ${SYNTHETIC_FAILURE}`
    && (await replayStatus(page)).commands.length === before, brief(failed.enhance));
}

/** @brief 设置里换成 fake-coder-404、再发一条消息、Run now：三种都失败，状态行是失败的那一行，修订标 Failed。 */
async function enhanceFailed(page, ctx) {
  await click(page, 'enhance-settings');
  await page.getByTestId('enhance-model').selectOption(ctx.commands[5].pick);
  await click(page, 'enhance-save');
  await untilPlayed(page, 6, 'enhance.set pick');
  await backToApp(page);
  await sendRecorded(page, ctx.commands, 6);
  await openMemory(page);
  await until(page, (x) => x.section === 'memory-section-revisions' && x.enhance?.status?.startsWith('On ·'));
  const run = await runNow(page, ctx, 7);
  const list = recorded(ctx.steps, ctx.ctxEnd, 'memory.revisions', { cwd: ctx.cwd, layer: 'project', id: null });
  record('MEM-25 replay mem-enhance: with a model the endpoint answers 404 all three tasks fail: the status line reads '
    + '"On · Last run failed (TASTE, STRATEGY, REVIEW): <reason> · Next run …" and the three new revisions are '
    + 'marked Failed', progressOk(run)
    && /^On · Last run failed \(TASTE, STRATEGY, REVIEW\): .+ · Next run /.test(run.s.enhance.status)
    && run.s.revisions.slice(0, 3).every((r) => r.tags.includes('Failed'))
    && same(run.s.revisions.map((r) => r.id), list.revisions.map((r) => r.id)), brief({ texts: run.texts,
    rows: run.s.revisions.slice(0, 4) }));
}

/**
 * @brief MEM-30（mem-enhance）：F8 的 Recent activity 按先后有 Open Memory、Turn on enhancement、Memory: Revisions、
 *        每次 Run now 的 Run enhancement now <文件夹>（发送时就失败的那次也记）、设置对话框的 Save enhancement settings。
 */
async function enhanceActivity(page, ctx) {
  const run = `Run enhancement now ${ctx.cwd}`;
  const want = ['Open Memory', `Turn on enhancement ${ctx.cwd}`, 'Memory: Revisions', run, run, run,
    `Save enhancement settings ${ctx.cwd}`, 'Open Memory', run];
  const texts = await recentActivity(page, 'MEM-30 recent activity after Run now');
  const got = memoryLines(texts);
  record('MEM-30 replay mem-enhance: F8 Recent activity records each Run now as "Run enhancement now <folder>" (the '
    + 'one that failed when sent too) and the settings dialog\'s Save as "Save enhancement settings <folder>", in '
    + 'order with "Open Memory", "Turn on enhancement <folder>" and "Memory: Revisions"; progress events and the '
    + 'enhance.get / memory.revisions reads they cause add nothing', activityOk(texts, got, want),
  activityDetail(texts, got, want));
}

/** @brief mem-enhance 的全部检查。 */
async function enhanceFixture(page, fx) {
  const steps = await load(page, fx);
  const commands = commandsOf(steps);
  const ctx = { steps, commands, cwd: commands[0].cwd, end: (i) => segmentEnd(steps, i), ctxEnd: steps.length };
  await enhanceFirst(page, ctx);
  await shot(page, 'mem-enhance-done');
  await enhanceSkipped(page, ctx);
  await enhanceFailed(page, ctx);
  await shot(page, 'mem-enhance-failed');
  await enhanceActivity(page, ctx);
  await finish(page, 'MEM-25', 'mem-enhance', steps);
}

// ---------- MEM-26：mem-notice ----------

/** @brief 当前一栏的新会话提示：文字与按钮；没有时为 null。 */
const bannerOf = (page) => page.locator(PANE).evaluate((pane) => {
  const el = pane.querySelector('[data-testid="memory-notice"]');
  if (!el) return null;
  const view = el.querySelector('[data-testid="memory-notice-view"]');
  return { text: el.querySelector('span')?.textContent ?? '', view: view?.textContent ?? null,
    dismiss: el.querySelector('[data-action="dismiss"]')?.textContent ?? null };
});

/** @brief 打开增强，Run now 并等它放完（mem-notice 的两次运行）。 */
async function noticeRun(page, i) {
  await click(page, 'enhance-run');
  await untilPlayed(page, i + 1, `enhance.run ${i}`);
  await until(page, (x) => /^On · Last run /.test(x.enhance?.status ?? ''));
}

/** @brief 第一个新会话的提示：文字、View 打开那次修订、View 之后仍在、换会话再回来不再显示。 */
async function noticeFirst(page, ctx) {
  const created = resultsOf(ctx.steps, 'session.create');
  const notice = created[1].memoryNotice;
  await backToApp(page);
  await newSession(page);
  await untilPlayed(page, 5, 'the second session');
  const banner = await bannerOf(page);
  await page.locator(PANE).getByTestId('memory-notice-view').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  const id = notice.revisions.at(-1);
  const got = recorded(ctx.steps, ctx.end(4), 'memory.revisions', { cwd: ctx.cwd, layer: 'project', id });
  const s = await until(page, (x) => x.detail?.title === got.revision.title);
  const run = got.revision.run;
  record('MEM-26 replay mem-notice: the first new session after a run that changed memory shows "Enhancement updated '
    + 'this project’s memory from the <Mon D> sessions: TASTE 1." with View and Dismiss; View opens Memory → Project → '
    + 'Revisions with that revision selected (its "Day <Mon D> · 1 session · 0 feedback · <n>k tokens" line)',
  banner?.text === noticeText(notice) && banner.view === 'View' && banner.dismiss === 'Dismiss'
    && s.scope === 'memory-scope-project' && s.section === 'memory-section-revisions'
    && s.revisions.find((r) => r.pressed)?.id === id
    && s.detail.meta.includes(`Day ${monthDay(run.day)} · 1 session · 0 feedback · ${formatTokens(run.tokens)}`),
  brief({ banner, want: noticeText(notice), s: s?.detail }));
  await backToApp(page);
  const kept = await bannerOf(page);
  await rowOf(page, created[0].sessionFile).click();
  await waitReady(page);
  await rowOf(page, created[1].sessionFile).click();
  await waitReady(page);
  const gone = await bannerOf(page);
  record('MEM-26 replay mem-notice: after View the banner is still there; switching to another session and back hides '
    + 'it for good', kept?.text === noticeText(notice) && gone === null, brief({ kept, gone }));
}

/** @brief 第二个新会话没有提示；再发消息、Run now（两条修订），之后的新会话提示是两者之和；Dismiss 收起。 */
async function noticeSecond(page, ctx) {
  await newSession(page);
  await untilPlayed(page, 6, 'the third session');
  const none = await bannerOf(page);
  record('MEM-26 replay mem-notice: the second new session of the project has no notice', none === null, brief(none));
  const created = resultsOf(ctx.steps, 'session.create');
  await rowOf(page, created[0].sessionFile).click();
  await waitReady(page);
  await sendRecorded(page, ctx.commands, 6);
  await openMemory(page);
  await noticeRun(page, 7);
  await backToApp(page);
  await newSession(page);
  await untilPlayed(page, 9, 'the fourth session');
  const notice = created[3].memoryNotice;
  const banner = await bannerOf(page);
  await page.locator(PANE).locator('[data-testid="memory-notice"] [data-action="dismiss"]').click();
  await sleep(200);
  record('MEM-26 replay mem-notice: after another run that changed TASTE and STRATEGY the next new session sums both '
    + 'revisions ("…: TASTE 1, STRATEGY 1."); Dismiss hides the banner',
  banner?.text === noticeText(notice) && notice.revisions.length === 2 && /TASTE 1, STRATEGY 1\.$/.test(banner.text)
    && (await bannerOf(page)) === null, brief({ banner, want: noticeText(notice) }));
}

/**
 * @brief MEM-30（mem-notice）：F8 的 Recent activity 按先后有新会话提示的 View（View in Memory）、Dismiss（Dismiss memory
 *        notice），以及其间的 Open Memory、Turn on enhancement <文件夹>、Run enhancement now <文件夹>。
 */
async function noticeActivity(page, ctx) {
  const run = `Run enhancement now ${ctx.cwd}`;
  const want = ['Open Memory', `Turn on enhancement ${ctx.cwd}`, run, 'View in Memory', 'Open Memory', run,
    'Dismiss memory notice'];
  const texts = await recentActivity(page, 'MEM-30 recent activity after the memory notice');
  const got = memoryLines(texts);
  record('MEM-30 replay mem-notice: F8 Recent activity records the new-session notice’s View as "View in Memory" and '
    + 'its Dismiss as "Dismiss memory notice", in order with "Open Memory", "Turn on enhancement <folder>" and "Run '
    + 'enhancement now <folder>"', activityOk(texts, got, want), activityDetail(texts, got, want));
  // docs/v0/screens/sessions.md"项目行的 +"（2026-10-26 WP-06）：点项目行的 + 记"New session"，后台进程那一条不变。
  // 这一段的新会话都是点当前项目行的 +（newSession），没有 Ctrl+N。不是记忆规格的条目，检查名不带编号。
  const plus = texts.lastIndexOf('New session');
  record('replay mem-notice (sessions.md, a project’s +): F8 Recent activity records the last click on the project’s '
    + '+ as "New session", right before the background process’s "New session in <folder>"', plus >= 0
    && plus > texts.lastIndexOf('Back to app') && Boolean(texts[plus + 1]?.startsWith(`New session in ${ctx.cwd}`)),
  JSON.stringify(texts.slice(Math.max(0, plus - 2), plus + 3)));
}

/** @brief mem-notice 的全部检查。 */
async function noticeFixture(page, fx) {
  const steps = await load(page, fx);
  const commands = commandsOf(steps);
  const ctx = { steps, commands, cwd: commands[0].cwd, end: (i) => segmentEnd(steps, i) };
  await openFolder(page);
  await sendRecorded(page, commands, 1);
  await openMemory(page);
  await click(page, 'enhance-switch');
  await untilPlayed(page, 3, 'enhance.set on');
  await until(page, (x) => x.enhance?.checked === 'true' && !x.enhance.runDisabled);
  await noticeRun(page, 3);
  await noticeFirst(page, ctx);
  await noticeSecond(page, ctx);
  await shot(page, 'mem-notice');
  await noticeActivity(page, ctx);
  await finish(page, 'MEM-26', 'mem-notice', steps);
}

// ---------- MEM-27：mem-feedback ----------

/** @brief 对最后一条回复点 Give feedback，等说明有字；写字、Save，等 Saved；返回说明的变化与保存后的表单。 */
async function giveFeedback(page, text) {
  await page.evaluate(() => { window.__memWatch.notes = []; });
  await page.locator(`${PANE} [data-testid="reply-actions"]`).last().getByRole('button', { name: 'Give feedback' })
    .click();
  await page.getByTestId('feedback-form').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="feedback-note"]')?.textContent),
    null, { timeout: 10000 });
  const note = await page.getByTestId('feedback-note').textContent();
  await page.getByTestId('feedback-input').fill(text);
  await page.getByTestId('feedback-form').getByRole('button', { name: 'Save' }).click();
  const saved = await page.getByTestId('feedback-form').evaluate((form) => new Promise((done) => {
    const check = () => {
      const el = form.querySelector('[data-testid="feedback-saved"]');
      if (el) done({ text: el.textContent, links: form.querySelectorAll('a, button').length });
      else setTimeout(check, 50);
    };
    check();
  }));
  const notes = (await watched(page)).notes;
  await page.getByTestId('feedback-form').waitFor({ state: 'detached', timeout: 10000 });
  return { note, notes, saved };
}

/** @brief mem-feedback 的全部检查。 */
async function feedbackFixture(page, fx) {
  const steps = await load(page, fx);
  const commands = commandsOf(steps);
  await openFolder(page);
  await sendRecorded(page, commands, 1);
  await openMemory(page);
  await click(page, 'enhance-switch');
  await untilPlayed(page, 3, 'enhance.set on');
  await until(page, (x) => x.enhance?.checked === 'true');
  await backToApp(page);
  const on = await giveFeedback(page, 'Shorter answers, please');
  record('MEM-27 replay mem-feedback: in a project with enhancement on the form note is "Saved as evidence for this '
    + 'project’s daily enhancement. To have Mori act on it now, use “Attach as context” instead." from the first text '
    + 'it shows (never the "not on" text first)', on.note === NOTE_ON
    && on.notes.filter(Boolean).every((text) => text === NOTE_ON), brief({ note: on.note, notes: on.notes }));
  await openFolder(page);
  await untilPlayed(page, 4, 'the second project');
  await sendRecorded(page, commands, 4);
  const off = await giveFeedback(page, 'Explain the folder first');
  const status = await replayStatus(page);
  record('MEM-27 replay mem-feedback: in a project without enhancement the note is "This project doesn’t have '
    + 'enhancement on, so feedback is only saved. To have Mori act on it, use “Attach as context” instead."; each '
    + 'form asked enhance.get for its own project', off.note === NOTE_OFF
    && off.notes.filter(Boolean).every((text) => text === NOTE_OFF)
    && [commands[0].cwd, commands[3].cwd].every((cwd) => status.queries.some((q) => q.type === 'enhance.get'
      && q.cwd === cwd)), brief({ note: off.note, notes: off.notes }));
  record('MEM-27 replay mem-feedback: after Save the form reads "Saved" with no link or button (no "View in Review"), '
    + 'and the feedback went to the main process (two records)', [on, off].every((x) => x.saved.text === 'Saved'
    && x.saved.links === 0) && status.feedback.length === 2, brief({ on: on.saved, off: off.saved,
    feedback: status.feedback.length }));
  await shot(page, 'mem-feedback');
  await finish(page, 'MEM-27', 'mem-feedback', steps);
}

// ---------- 执行 ----------

/** 每个录制：名字、覆盖的编号、检查、允许出现的页面错误（界面按规格记下的错误日志） */
const FIXTURES = [
  // Jump to source 读会话文件：录制里没有 session.read，回放桥按 Session file not found 回答（synthetic，见 jumpFromEntry）
  { name: 'mem-tool', ids: ['MEM-10', 'MEM-30'], run: toolFixture,
    allowed: [/\[renderer\] session\.read failed: Session file not found: /] },
  { name: 'mem-page', ids: ['MEM-14', 'MEM-30'], run: pageFixture },
  { name: 'mem-settings', ids: ['MEM-17', 'MEM-30'], run: settingsFixture,
    allowed: [/\[renderer\] enhance\.(get|set)\b.*Unexpected end of JSON input/] },
  { name: 'mem-enhance', ids: ['MEM-25', 'MEM-30'], run: enhanceFixture, allowed: [new RegExp(SYNTHETIC_FAILURE)] },
  { name: 'mem-notice', ids: ['MEM-26', 'MEM-30'], run: noticeFixture },
  { name: 'mem-feedback', ids: ['MEM-27'], run: feedbackFixture },
];

const chosen = FIXTURES.filter((f) => !only || only.includes(f.name));
const present = chosen.filter((f) => existsSync(fixturePath(f.name)));
for (const f of chosen.filter((item) => !present.includes(item))) {
  for (const id of f.ids) {
    record(`${id} replay fixture missing: tests/fixtures/mem/${f.name}.json (record it with mem-record.mjs)`, false,
      'no recording yet');
  }
}
if (present.length) {
  await buildHarness();
  const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
    env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
      MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-mem-')) } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  for (const f of present) {
    const fx = readFixture(f.name);
    await useZone(page, fx);
    await guarded(page, errors, { id: f.ids[0], label: f.name, allowed: f.allowed ?? [] }, () => f.run(page, fx));
  }
  await app.close();
}
process.exitCode = write(only ? 'mem-partial-replay.json' : 'mem-replay.json') ? 0 : 1;
