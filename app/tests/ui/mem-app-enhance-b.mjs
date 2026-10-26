// 记忆规格（docs/specs/memory.md §14.2）增强部分的 App 套件 B：启动 App 之前就要写好数据的情形，每种一次启动：
// - catchUp：六个项目的 enhance.json 与会话文件写在前几天（每天的时刻 04:00），启动时补跑：MEM-18（启动时补跑）、
//   MEM-24（几个项目同时到点，全应用一次一个，顺序按日子、cwd、TASTE→STRATEGY→REVIEW，不重复排，排着的项目的状态行与
//   Run now）、MEM-23（某任务连续两轮失败而别的任务跑到更晚的日子，失败的那天重跑）、MEM-19（没有会话时跳过、水位条目
//   找不到时从 since 那天开始、行号是物理行、有 TaskBoard 时列出目录）、MEM-25（排着、全部跳过的状态行与 skipped、
//   failed 的进度）、MEM-26（两天有改动的运行之后提示写日子范围、数相加、View 选中最近的那次）、MEM-17（启动时就在
//   补跑的项目，enhance.get 的 effortPicks 与写好的模型设置相符）；
// - timer：一个项目的时刻是启动前的现在 + 1–2 分钟（MEM-18：启动时没有该跑的日子，到点后跑这一天），另一个是
//   现在 + 3–4 分钟（MEM-25：Run now 跑今天、再聊一句、到点后同一天再跑一次只读新增部分；MEM-19：Run now 时在生成的
//   会话不列、水位不动，日子结束的那次从它的开头列出）；
// - kill：启动时补跑的任务写入一条之后一直等，结束后台进程、点 Restart（MEM-23：running 的修订变为 failed、last 记失败、
//   重跑、写入过的改动可以回滚；MEM-26：中途结束后台进程的运行写入过改动时同样有提示，View 打开那次失败的修订）。
// - exitDuring（2026-10-26，docs/v0/screens/window.md"退出，只有增强任务在运行"，WP-20 记录"状态表各行的用例"）：
//   启动时补跑的 TASTE 写入一条之后一直等，没有会话在生成时点托盘"Exit"：不问、Mori 退出；同一个数据目录再启动后
//   那条修订是 Failed（"Mori closed during the run"，改动留着），那一天重跑（名字以 "window.md" 开头，不计入覆盖检查）。
// 用法（在 app/ 下，先构建）：node tests/ui/mem-app-enhance-b.mjs [--exe <Mori.exe>] [--only catchUp,timer,kill,exitDuring]
// 结果写到 test-results/mem-app-enhance-b(-packaged).json（--only 时 mem-partial-app-enhance-b…），截图与 App 日志在
// test-results/mem-app-enhance-b/。端口：合成端点 4740，记录代理 4741。timer 这一次要等约 4 分钟（真实时钟）。
// 测试准备（synthetic test setup，逐处注明）：提供商 me（fake-me 标了支持思考），默认范围 me；会话文件、enhance.json、
// TaskBoard 目录、增强脚本（tests/fake-endpoint/enhance.mjs）都由测试按规格 §3 写好。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TASKS, addDays, backToApp, brief, chatItems, dayLabel, dayOf, dayStart, enhanceGet,
  enhanceProgress, enhanceRequests, enhanceSeed, errorLine, ev, expectedStatus, hhmm, listedSessions, makeProject,
  mem, memArgs, memoryList, memRecorder, monthDay, monthDayTime, noticeOf, openMemoryProject, phaseBrief, quietScript,
  readEnhance, revisionDetail, revisionRows, revisionView, runEnabled, runRevisions, same, say, seededEffortPicks,
  seedSession,
  seedTeamDir, sleep, toolResultsOf, headlessFiles, waitFor, waitSettled, waitStatus, writeEnhance, writeScript,
} from './mem-enhance-helpers.mjs';
import {
  bridge, closeTbApp, killTbKernel, newSession, openProject, paneSel, paneState, poll, readJsonl, reopenSession,
  seedTeamUserData, sendMessage, shot, startTbApp, startTbEndpoint, stopTbEndpoint, tbModel, tbProvider, tempUserData,
  userSession,
} from './tb-helpers.mjs';
import { exitFromTray, messageBoxes, stubMessageBox } from './tray-helpers.mjs';

const args = memArgs('enhance-b');
const { record, finish } = memRecorder(args);

/** 本套件的端口（§14.1 的 4700–4799 里分给它的 4740–4749）：合成端点与它前面的记录代理 */
const PORT = 4740;
const PROXY = 4741;
/** 临时目录：项目文件夹与增强脚本文件（synthetic） */
const ROOT = mkdtempSync(join(tmpdir(), 'mori-mem-enh-b-'));
const SCRIPT = join(ROOT, 'enhance-script.json');
/** 每天的时刻（catchUp 与 kill） */
const TIME = '04:00';

// ---------- 小工具 ----------

/** @brief 日子 day 里 hours 点（本地时间；day 从 04:00 开始，hours 取 5–27 之间都在这一天里）。 */
const atOn = (day, hours) => dayStart(day, TIME) + (hours - 4) * 3600000;

/** @brief 测试准备（synthetic）：数据目录与 App（每次启动一个新的数据目录）。 */
async function launchApp(ctx, seed) {
  ctx.userData = tempUserData('mori-mem-enh-b-data-');
  ctx.pageErrors ??= [];
  const providers = [tbProvider('me', PROXY, [tbModel('fake-me', { reasoning: true })])];
  ctx.effortPicks = seededEffortPicks(providers);
  seedTeamUserData(ctx.userData, { providers, normalDefault: 'me' });
  seed(ctx);
  await startTbApp(ctx);
}

/** @brief 发一句话，等这个会话回复完。 */
async function chatOnce(ctx, tab, text, timeout = 60000) {
  const before = (await paneState(ctx.page, tab))?.assistants.length ?? 0;
  await sendMessage(ctx, tab, text);
  const ok = await waitFor(async () => {
    const pane = await paneState(ctx.page, tab);
    return pane !== null && pane.assistants.length > before && !pane.running && !pane.sending;
  }, timeout);
  if (!ok) throw new Error(`no reply to "${text}" in ${tab}`);
}

/** @brief 等这些项目都没有在跑、也没有排着的项（连续 3 秒），最多 timeout。 */
async function waitQueueIdle(ctx, cwds, timeout = 240000) {
  let since = null;
  return waitFor(async () => {
    const infos = await Promise.all(cwds.map((cwd) => enhanceGet(ctx, cwd)));
    if (infos.some((info) => info.running !== null || info.queued > 0)) since = null;
    else since ??= Date.now();
    return since !== null && Date.now() - since >= 3000;
  }, timeout, 500);
}

/** @brief 打开 project 的一个新会话（打开文件夹），等它就绪。 */
const openTab = (ctx, project) => openProject(ctx, project);

// ---------- catchUp：启动时补跑、全应用串行、失败重试、跳过、物理行 ----------

/** @brief catchUp 的项目名（cwd 按字符串排序就是这个顺序）。 */
const CATCH = ['a-pa', 'b-pb', 'c-pf', 'd-pl', 'e-pw', 'f-ps'];

/** @brief 测试准备（synthetic）：六个项目的会话、TaskBoard 目录与 enhance.json，增强脚本。 */
function seedCatchUp(ctx) {
  const c = ctx.c = { D: dayOf(Date.now(), TIME) };
  c.Y = addDays(c.D, -1);
  c.Y2 = addDays(c.D, -2);
  c.Y3 = addDays(c.D, -3);
  c.p = Object.fromEntries(CATCH.map((name) => [name, makeProject(ROOT, name)]));
  const two = (name, hours) => seedSession(ctx.userData, c.p[name], { name: `${name} chat`, items: [
    ...chatItems([`${name} question on Y2`, `${name} answer on Y2.`], atOn(c.Y2, hours)),
    ...chatItems([`${name} question on Y`, `${name} answer on Y.`], atOn(c.Y, hours))] });
  c.sa = two('a-pa', 9);
  c.sb = seedSession(ctx.userData, c.p['b-pb'], { name: 'b-pb chat', items: chatItems(['b-pb question',
    'b-pb answer.'], atOn(c.Y, 10)) });
  c.sf = two('c-pf', 11);
  c.sl = seedSession(ctx.userData, c.p['d-pl'], { name: 'PL chat', items: [
    ...chatItems(['PL question one', 'PL answer one.'], atOn(c.Y, 9)), { kind: 'bad', at: atOn(c.Y, 9) },
    ...chatItems(['PL question two', 'PL answer two.'], atOn(c.Y, 10))] });
  c.team = seedTeamDir(ctx.userData, c.sl, atOn(c.Y, 10));
  c.sw = two('e-pw', 12);
  const old = { since: c.Y3, doneThrough: c.Y3 };
  for (const name of ['a-pa', 'b-pb', 'c-pf']) writeEnhance(ctx.userData, c.p[name], enhanceSeed(old));
  for (const name of ['d-pl', 'f-ps']) {
    writeEnhance(ctx.userData, c.p[name], enhanceSeed({ since: c.Y, doneThrough: c.Y2 }));
  }
  writeEnhance(ctx.userData, c.p['e-pw'], enhanceSeed({ since: c.Y, doneThrough: c.Y2,
    tasks: { taste: { watermarks: { [c.sw.file]: 'deadbeef' } } } }));
  writeScript(SCRIPT, catchUpScript(c));
}

/** @brief catchUp 的增强脚本（synthetic）：按项目与日子各自的步骤。 */
function catchUpScript(c) {
  return {
    ...Object.fromEntries(CATCH.flatMap((name) => Object.entries(quietScript(`@${name}`)))),
    [`taste@a-pa@${dayLabel(c.Y2)}`]: [{ ...mem({ action: 'save', abstract: 'PA taste from Y2',
      evidence: [ev(c.sa.file, c.sa.entries[0].id)] }), wait: 20000 }, say('PA Y2 taste done.')],
    [`taste@a-pa@${dayLabel(c.Y)}`]: [mem({ action: 'save', abstract: 'PA taste from Y',
      evidence: [ev(c.sa.file, c.sa.entries[2].id)] }), say('PA Y taste done.')],
    'taste@c-pf': [{ fail: 400 }],
    // 片段是第 2 行（会话名那一条，它的时刻也在这一天里）到第 7 行
    'taste@d-pl': [{ call: 'read', args: { path: c.sl.file, offset: 2, limit: 6 } }, say('Read the lines.')],
  };
}

/** @brief 等 PA 的第一个任务在跑时：PB 的状态行是排着的那一行、Run now 不可用；经进程桥对 PB 再发 enhance.run。 */
async function catchUpQueued(ctx) {
  const c = ctx.c;
  await waitFor(async () => (await enhanceGet(ctx, c.p['a-pa'])).running !== null, 30000, 200);
  c.pbTab = await openTab(ctx, c.p['b-pb']);
  await openMemoryProject(ctx, c.pbTab);
  const status = await waitStatus(ctx, /^On · \d+ queued · Waiting for another project’s enhancement$/, 10000);
  const blocked = !(await runEnabled(ctx));
  const pa = await enhanceGet(ctx, c.p['a-pa']);
  record('MEM-24 while another project\'s run is going, the waiting project\'s status line reads "On · <n> queued · '
    + 'Waiting for another project’s enhancement" and its Run now is disabled', status !== null
    && /^On · 6 queued · Waiting for another project’s enhancement$/.test(status) && blocked && pa.running !== null,
  brief({ status, blocked, pa: pa.running }));
  record('MEM-25 status line, queued: "On · <n> queued · Waiting for another project’s enhancement"',
    /^On · \d+ queued · Waiting for another project’s enhancement$/.test(status ?? ''), status ?? '');
  c.pbRunAt = Date.now();
  c.pbRun = await bridge(ctx, { type: 'enhance.run', cwd: c.p['b-pb'] });
  const picks = await Promise.all([c.p['a-pa'], c.p['b-pb']].map(async (cwd) => (await enhanceGet(ctx, cwd))
    .effortPicks));
  record('MEM-17 enhance.get carries effortPicks for a running and a queued project of the startup catch-up: '
    + 'every range of the seeded model settings, true exactly when its first candidate is marked "Supports '
    + 'thinking" (me true, me/fake-me true)', picks.every((value) => same(value, ctx.effortPicks)),
  brief({ got: picks, want: ctx.effortPicks }));
  await backToApp(ctx);
}

/** @brief 期望的 running 顺序：日子、cwd、TASTE→STRATEGY→REVIEW；c-pf 的 TASTE 在 Y2 失败后 Y 不跑；PB 的今天在最后。 */
function expectedOrder(c) {
  const items = [];
  for (const day of [c.Y2, c.Y]) {
    for (const name of CATCH) {
      if (day === c.Y2 && ['d-pl', 'e-pw', 'f-ps'].includes(name)) continue;
      for (const task of TASKS) {
        if (!(name === 'c-pf' && task === 'taste' && day === c.Y)) items.push(`${name} ${task} ${day}`);
      }
    }
  }
  return [...items, ...TASKS.map((task) => `b-pb ${task} ${c.D}`)];
}

/**
 * @brief MEM-24：一次只有一个在跑、顺序、不重复排。顺序按记录代理收到的增强请求（跳过的项没有请求；启动时最早的进度事件
 *        可能在界面订阅之前就发出了，所以顺序不按事件）；一次一个按事件（running 之后先有它的结束才有下一个 running）。
 */
async function catchUpSerial(ctx) {
  const c = ctx.c;
  const events = await enhanceProgress(ctx);
  const name = (cwd) => CATCH.find((n) => c.p[n] === cwd) ?? cwd;
  const labels = Object.fromEntries([c.Y2, c.Y, c.D].map((day) => [dayLabel(day), day]));
  const running = [...new Set(enhanceRequests(ctx.ep, { since: ctx.started })
    .map((q) => `${name(q.cwd)} ${q.kind} ${labels[q.day] ?? q.day}`))];
  const skipped = new Set(events.filter((e) => e.phase === 'skipped').map((e) => `${name(e.cwd)} ${e.task} ${e.day}`));
  let open = 0;
  let overlap = false;
  for (const e of events.slice(Math.max(0, events.findIndex((x) => x.phase === 'running')))) {
    if (e.phase === 'running') open += 1;
    if (['done', 'skipped', 'failed'].includes(e.phase)) open -= 1;
    if (open > 1) overlap = true;
  }
  const runs = enhanceRequests(ctx.ep, { since: ctx.started }).reduce((acc, q) => {
    if (acc.at(-1)?.first !== q.first) acc.push({ first: q.first, start: q.t, end: q.t });
    else acc.at(-1).end = q.t;
    return acc;
  }, []);
  const interleaved = new Set(runs.map((r) => r.first)).size !== runs.length;
  record('MEM-24 one enhancement at a time across the app: every "running" is followed by its end before the next '
    + '"running", and the enhancement sessions\' requests never interleave', !overlap && !interleaved
    && runs.length > 5,
  brief({ overlap, interleaved, runs: runs.length }));
  const want = expectedOrder(c).filter((item) => !skipped.has(item));
  record('MEM-24 queue order: by day, then project cwd, then TASTE → STRATEGY → REVIEW (a failed TASTE day stops that '
    + 'task\'s later days; Run now\'s today comes after all due days)', same(running, want), brief({ running, want }));
  const pbQueued = events.filter((e) => e.phase === 'queued' && e.cwd === c.p['b-pb'] && e.t >= c.pbRunAt)
    .map((e) => `${e.task} ${e.day}`);
  record('MEM-24 the same item is not queued twice: Run now on a project whose days are still queued adds only '
    + 'today\'s three tasks (no second "queued" for the queued days)', c.pbRun?.error === null
    && same(pbQueued, TASKS.map((task) => `${task} ${c.D}`)), brief(pbQueued));
}

/** @brief MEM-18：启动时补跑；MEM-26：两天有改动的运行之后的提示。 */
async function catchUpNotice(ctx) {
  const c = ctx.c;
  const cwd = c.p['a-pa'];
  const runs = await runRevisions(ctx, cwd, { task: 'taste' });
  const byDay = Object.fromEntries(runs.map((r) => [r.run.day, r]));
  const file = readEnhance(ctx.userData, cwd);
  record('MEM-18 at launch the days missed while Mori was closed are caught up: the project with doneThrough three '
    + 'days back ran the day before yesterday and yesterday (revisions done) without any action, doneThrough = '
    + 'yesterday', byDay[c.Y2]?.status === 'done' && byDay[c.Y]?.status === 'done'
    && TASKS.every((task) => file?.tasks[task].doneThrough === c.Y), brief({ days: Object.keys(byDay),
    done: TASKS.map((task) => file?.tasks[task].doneThrough) }));
  const notice = file?.notice;
  record('MEM-26 two runs with changes on different days accumulate in the notice: counts summed (TASTE 2), from the '
    + 'earlier day to the later one, both revisions in time order', same(notice, { revisions: [byDay[c.Y2]?.id,
    byDay[c.Y]?.id], counts: { taste: 2, strategy: 0, review: 0 }, from: c.Y2, to: c.Y }), brief(notice));
  const old = await reopenSession(ctx, c.sa.file);
  const oldBanner = await noticeOf(ctx, old);
  record('MEM-26 opening an existing session (from the sidebar, session.open) shows no banner and leaves the notice '
    + 'for the next new session', oldBanner === null && same(readEnhance(ctx.userData, cwd)?.notice, notice),
  brief({ oldBanner, notice: readEnhance(ctx.userData, cwd)?.notice }));
  const tab = await openTab(ctx, cwd);
  const banner = await noticeOf(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="memory-notice-view"]`).click();
  await ctx.page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  await waitFor(async () => (await revisionView(ctx)).title !== null, 10000);
  const view = await revisionView(ctx);
  const text = `Enhancement updated this project’s memory from the ${monthDay(c.Y2)}–${monthDay(c.Y)} sessions: `
    + 'TASTE 2.';
  record('MEM-26 the banner of the first new session gives the day range and the summed count ("…from the <Mon D>–'
    + '<Mon D> sessions: TASTE 2.") and View selects the most recent revision', banner?.text === text
    && view.selected === byDay[c.Y]?.id && view.title === `TASTE enhancement · ${monthDay(c.Y)}`, brief({ banner,
    view }));
  await backToApp(ctx);
}

/** @brief MEM-23：c-pf 的 TASTE 在 Y2 失败，别的任务跑到 Y；Run now 再失败一轮，状态行仍是失败那一行。 */
async function catchUpFailed(ctx) {
  const c = ctx.c;
  const cwd = c.p['c-pf'];
  const first = await enhanceProgress(ctx, { cwd });
  const tab = await openTab(ctx, cwd);
  await openMemoryProject(ctx, tab);
  const info = await enhanceGet(ctx, cwd);
  const status = await waitStatus(ctx, /^On · Last run failed \(TASTE\): /, 10000);
  const since = Date.now();
  await ctx.page.getByTestId('enhance-run').click();
  const second = await waitSettled(ctx, cwd, since, 3);
  const after = await enhanceGet(ctx, cwd);
  const again = await waitStatus(ctx, (text) => text === expectedStatus(after), 10000);
  const file = readEnhance(ctx.userData, cwd);
  record('MEM-23 a task failing in two rounds while the other tasks have run to later days keeps the failed line: '
    + 'TASTE failed on the day before yesterday (round 1 at launch, round 2 by Run now, both for that same day), '
    + 'STRATEGY and REVIEW are done through yesterday and then today, and the status line stays "On · Last run '
    + 'failed (TASTE): <reason> · Next run …"', first.some((e) => e.phase === 'failed' && e.task === 'taste'
    && e.day === c.Y2) && second.some((e) => e.phase === 'failed' && e.task === 'taste' && e.day === c.Y2)
    && status === expectedStatus(info) && again?.startsWith('On · Last run failed (TASTE): ')
    && file?.tasks.strategy.doneThrough === c.Y && file.tasks.taste.doneThrough === c.Y3
    && same(file.tasks.taste.watermarks, {}),
  brief({ status, again, first: phaseBrief(first), second: phaseBrief(second) }));
  record('MEM-25 progress events include failed (with the reason) for a failing task', first.some((e) =>
    e.phase === 'failed' && e.error?.includes('400')), brief(phaseBrief(first)));
  const queued = second.filter((e) => e.phase === 'queued').map((e) => `${e.task} ${e.day}`);
  record('MEM-25 Run now queues the days not processed yet and today: TASTE for the failed day, the next day and '
    + 'today; STRATEGY and REVIEW (done through yesterday) only today', same(queued, [`taste ${c.Y2}`, `taste ${c.Y}`,
    `taste ${c.D}`, `strategy ${c.D}`, `review ${c.D}`]), brief(queued));
  await backToApp(ctx);
}

/** @brief MEM-19：跳过；全部跳过的状态行；水位条目找不到；物理行与 TaskBoard 目录。 */
async function catchUpRead(ctx) {
  const c = ctx.c;
  const pb = await enhanceProgress(ctx, { cwd: c.p['b-pb'] });
  const pbFile = readEnhance(ctx.userData, c.p['b-pb']);
  const pbY2 = await runRevisions(ctx, c.p['b-pb'], { day: c.Y2 });
  record('MEM-19 a day without sessions to read is skipped: three skipped progress events for the day before '
    + 'yesterday, no revision for it, doneThrough moves on (yesterday after the next day ran)', pb.filter((e) =>
    e.phase === 'skipped' && e.day === c.Y2).length === 3 && pbY2.length === 0
    && TASKS.every((task) => pbFile?.tasks[task].doneThrough === c.Y), brief(phaseBrief(pb).slice(0, 10)));
  const ps = c.p['f-ps'];
  const psFile = readEnhance(ctx.userData, ps);
  const tab = await openTab(ctx, ps);
  await openMemoryProject(ctx, tab);
  const info = await enhanceGet(ctx, ps);
  const status = await waitStatus(ctx, /No finished sessions to read/, 10000);
  record('MEM-19 the skipped run records last = skipped (no revision, tokens 0) and doneThrough moves to that day',
    TASKS.every((task) => psFile?.tasks[task].last?.status === 'skipped' && psFile.tasks[task].last.revision === null
    && psFile.tasks[task].doneThrough === c.Y) && (await revisionRows(ctx, ps)).length === 0,
  brief(psFile?.tasks.taste));
  record('MEM-25 status line, all skipped: "On · Last run <Mon D> <hh:mm> · No finished sessions to read · Next run '
    + '<Mon D> <hh:mm>"; progress events include skipped', status === expectedStatus(info)
    && status.startsWith('On · Last run ') && pb.some((e) => e.phase === 'skipped'), status ?? '');
  await backToApp(ctx);
  await catchUpLines(ctx);
}

/** @brief MEM-19：水位条目找不到时从 since 那天开始；行号是物理行（中间一行坏的 JSON），列出 TaskBoard 目录。 */
async function catchUpLines(ctx) {
  const c = ctx.c;
  const pw = enhanceRequests(ctx.ep, { cwd: c.p['e-pw'], kind: 'taste' })[0];
  const [w] = pw ? listedSessions(pw.first) : [];
  const fromY = c.sw.entries[2];
  record('MEM-19 a watermark whose entry is not in the file: the slice starts at the since day ("lines <a>–<b> (from '
    + '<time>)" from the first entry of that day; the day before is not read)', w?.file === c.sw.file
    && w.from === fromY.line && w.to === c.sw.entries[3].line && w.start === `from ${monthDayTime(fromY.at)}`,
  brief({ w, want: [fromY.line, c.sw.entries[3].line] }));
  const pl = enhanceRequests(ctx.ep, { cwd: c.p['d-pl'], kind: 'taste' })[0];
  const [l] = pl ? listedSessions(pl.first) : [];
  const lines = [c.sl.info.line, ...c.sl.entries.map((e) => e.line)];
  record('MEM-19 line numbers are physical lines (a broken JSON line in the middle counts): the session is listed as '
    + `lines ${lines[0]}–${lines.at(-1)} and with its TaskBoard folder ("team: <dir> (board.json and sessions/)")`,
  l?.from === lines[0] && l.to === lines.at(-1) && l.team === c.team.dir && l.start === `from ${monthDayTime(
    c.sl.info.at)}`, brief({ l, lines }));
  const file = headlessFiles(ctx.userData, c.p['d-pl']).find((f) => toolResultsOf(f.entries).some((r) => r.tool
    === 'read'));
  const read = toolResultsOf(file?.entries ?? []).find((r) => r.tool === 'read')?.text ?? '';
  const ids = [c.sl.info.id, ...c.sl.entries.filter((e) => e.id).map((e) => e.id)];
  record('MEM-19 reading those lines with the read tool (offset = <a>, limit = <b> − <a> + 1) returns exactly those '
    + 'entries and the broken line, nothing before them (not the header)', ids.every((id) => read.includes(id))
    && read.includes('this line is not JSON') && !read.includes('"type":"session"'), brief(read.slice(0, 600)));
}

/** @brief catchUp 这一次启动。 */
async function catchUp(ctx) {
  ctx.started = Date.now();
  await launchApp(ctx, seedCatchUp);
  await catchUpQueued(ctx);
  if (!(await waitQueueIdle(ctx, Object.values(ctx.c.p)))) throw new Error('the startup queue never drained');
  await catchUpSerial(ctx);
  await catchUpNotice(ctx);
  await catchUpFailed(ctx);
  await catchUpRead(ctx);
}

// ---------- timer：到点自动跑、日子结束后同一天再跑 ----------

/** @brief 测试准备（synthetic）：两个项目，时刻分别是现在 + 1–2 分钟、+ 3–4 分钟。 */
function seedTimer(ctx) {
  const now = Date.now();
  const t = ctx.t = { T1: Math.ceil((now + 80000) / 60000) * 60000 };
  t.T2 = t.T1 + 120000;
  t.time1 = hhmm(t.T1);
  t.time2 = hhmm(t.T2);
  t.DT = dayOf(now, t.time1);
  t.DR = dayOf(now, t.time2);
  t.pt = makeProject(ROOT, 'g-pt');
  t.pr = makeProject(ROOT, 'h-pr');
  t.st = seedSession(ctx.userData, t.pt, { name: 'Timer chat', items: chatItems(['Timer question', 'Timer answer.'],
    now - 10 * 60000) });
  writeEnhance(ctx.userData, t.pt, enhanceSeed({ time: t.time1, since: t.DT, doneThrough: addDays(t.DT, -1) }));
  writeEnhance(ctx.userData, t.pr, enhanceSeed({ time: t.time2, since: t.DR, doneThrough: addDays(t.DR, -1) }));
  writeScript(SCRIPT, { ...quietScript('@g-pt'), ...quietScript('@h-pr'), 'taste@g-pt': [mem({ action: 'save',
    abstract: 'Timer taste', evidence: [ev(t.st.file, t.st.entries[0].id)] }), say('Timer run done.')] });
}

/** @brief Run now 跑今天：在生成的会话不列、水位不动；之后在另一个会话里再聊一句。 */
async function timerRunNow(ctx) {
  const t = ctx.t;
  t.r1 = await openTab(ctx, t.pr);
  await chatOnce(ctx, t.r1, 'plain first message for the day-end run');
  t.r2 = await newSession(ctx);
  await chatOnce(ctx, t.r2, 'plain first message of the second session');
  t.r1file = (await userSession(ctx, t.r1)).sessionFile;
  t.r2file = (await userSession(ctx, t.r2)).sessionFile;
  await sendMessage(ctx, t.r2, 'wait 45s');
  await waitFor(async () => (await paneState(ctx.page, t.r2))?.running === true, 10000, 200);
  await openMemoryProject(ctx, t.r1);
  const since = Date.now();
  await ctx.page.getByTestId('enhance-run').click();
  const events = await waitSettled(ctx, t.pr, since, 3);
  const first = enhanceRequests(ctx.ep, { cwd: t.pr, kind: 'taste', since })[0]?.first ?? '';
  const listed = listedSessions(first).map((s) => s.file);
  const file = readEnhance(ctx.userData, t.pr);
  t.mark = file?.tasks.taste.watermarks[t.r1file];
  record('MEM-25 Run now runs the day now belongs to (today): three tasks done for that day, doneThrough does not '
    + 'move', events.filter((e) => e.phase === 'done' && e.day === t.DR).length === 3
    && TASKS.every((task) => file?.tasks[task].doneThrough === addDays(t.DR, -1)), brief(phaseBrief(events)));
  record('MEM-19 a session that is generating when the run starts is not listed and its watermark does not move '
    + '(the idle session is listed and gets one)', same(listed, [t.r1file]) && typeof t.mark === 'string'
    && !(t.r2file in (file?.tasks.taste.watermarks ?? {})),
  brief({ listed, watermarks: file?.tasks.taste.watermarks }));
  await backToApp(ctx);
  await chatOnce(ctx, t.r1, 'plain second message after the first run');
  await waitFor(async () => (await paneState(ctx.page, t.r2))?.running === false, 90000);
}

/** @brief MEM-18：启动时没有该跑的日子；到点后跑这一天、修订 done。 */
async function timerFired(ctx) {
  const t = ctx.t;
  const events = await waitSettled(ctx, t.pt, 0, 3, Math.max(0, t.T1 - Date.now()) + 90000);
  const first = events[0];
  const [revision] = await runRevisions(ctx, t.pt, { task: 'taste' });
  const file = readEnhance(ctx.userData, t.pt);
  record('MEM-18 the timer fires at the project\'s time: nothing ran at launch (no due day), and at <time> (now + '
    + '1–2 min when seeded) the day now ends is queued and run (TASTE revision done, doneThrough = that day)',
  first?.phase === 'queued' && first.t >= t.T1 - 1500 && first.day === t.DT && revision?.status === 'done'
    && revision.run.day === t.DT && TASKS.every((task) => file?.tasks[task].doneThrough === t.DT),
  brief({ first, T1: new Date(t.T1).toISOString(), rev: revision?.run }));
}

/** @brief MEM-25 / MEM-19：日子结束后同一天再跑一次，只列新增的部分；在生成的那个会话这次从它的开头列出。 */
async function timerDayEnd(ctx) {
  const t = ctx.t;
  const events = await waitSettled(ctx, t.pr, t.T2 - 2000, 3, Math.max(0, t.T2 - Date.now()) + 120000);
  const first = enhanceRequests(ctx.ep, { cwd: t.pr, kind: 'taste', since: t.T2 - 2000 })[0]?.first ?? '';
  const listed = Object.fromEntries(listedSessions(first).map((s) => [s.file, s]));
  const lines = (file) => readJsonl(file).map((entry, index) => ({ entry, line: index + 1 }));
  const r1 = lines(t.r1file);
  const markLine = r1.find((item) => item.entry.id === t.mark)?.line;
  const r2first = lines(t.r2file)[1];
  const file = readEnhance(ctx.userData, t.pr);
  record('MEM-25 when the day ends the same day runs again and reads only what was added after today\'s Run now '
    + '("after entry <watermark>", starting on the next line)', events.filter((e) => e.phase === 'done'
    && e.day === t.DR).length === 3 && listed[t.r1file]?.start === `after entry ${t.mark}`
    && listed[t.r1file].from === markLine + 1 && TASKS.every((task) => file?.tasks[task].doneThrough === t.DR),
  brief({ r1: listed[t.r1file], markLine, events: phaseBrief(events) }));
  record('MEM-19 the session that was generating during the earlier run is listed by the day\'s final run from its '
    + 'beginning ("from <time>", line 2)', listed[t.r2file]?.from === 2 && listed[t.r2file].start
    === `from ${monthDayTime(Date.parse(r2first.entry.timestamp))}`, brief({ r2: listed[t.r2file] }));
}

/** @brief timer 这一次启动（约 4 分钟）。 */
async function timer(ctx) {
  await launchApp(ctx, seedTimer);
  await sleep(5000);
  const early = enhanceRequests(ctx.ep, { cwd: ctx.t.pt });
  const revisions = await revisionRows(ctx, ctx.t.pt);
  record('MEM-18 at launch the timer project has no due day: nothing runs for it at launch (no request and no '
    + 'revision a few seconds after launch)', early.length === 0 && revisions.length === 0,
  brief({ early: early.length, revisions }));
  await timerRunNow(ctx);
  await timerFired(ctx);
  await timerDayEnd(ctx);
}

// ---------- kill：运行中结束后台进程 ----------

/** @brief 测试准备（synthetic）：昨天的会话，启动时补跑的 TASTE 写入一条之后一直等。 */
function seedKill(ctx) {
  const k = ctx.k = { D: dayOf(Date.now(), TIME) };
  k.Y = addDays(k.D, -1);
  k.pk = makeProject(ROOT, 'i-pk');
  k.dummy = makeProject(ROOT, 'j-dummy');
  k.sk = seedSession(ctx.userData, k.pk, { name: 'Kill chat', items: chatItems(['Kill question', 'Kill answer.'],
    atOn(k.Y, 9)) });
  writeEnhance(ctx.userData, k.pk, enhanceSeed({ since: k.Y, doneThrough: addDays(k.Y, -1) }));
  writeScript(SCRIPT, { ...quietScript('@i-pk'), 'taste@i-pk': [mem({ action: 'save', abstract: 'Kill taste',
    evidence: [ev(k.sk.file, k.sk.entries[0].id)] }), say('Still working.', 600000)] });
}

/** @brief 等 TASTE 写入后结束后台进程；改脚本让重跑不改东西；点 Restart。 */
async function killDuring(ctx) {
  const k = ctx.k;
  const tab = await openTab(ctx, k.dummy);
  const running = await poll(async () => (await revisionRows(ctx, k.pk)).find((row) => row.status === 'running'
    && row.counts.added === 1), 60000, 300);
  if (!running) throw new Error('the TASTE run never wrote its entry');
  k.stale = running.id;
  await sleep(1000);
  killTbKernel(ctx);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="kernel-exit"]`).waitFor({ timeout: 15000 });
  writeScript(SCRIPT, { ...quietScript('@i-pk'), 'taste@i-pk': [say('Rerun after restart.', 8000)] });
  k.restart = Date.now();
  await ctx.page.locator(`${paneSel(tab)} [data-testid="kernel-exit"]`).getByRole('button', { name: 'Restart' })
    .click();
  await ctx.page.locator('[data-testid="kernel-exit"]').first().waitFor({ state: 'detached', timeout: 30000 });
}

/** @brief 重启后：修订变为 failed、last 记失败、重跑同一天；提示；View 打开失败的修订；回滚。 */
async function killAfter(ctx) {
  const k = ctx.k;
  const info = await poll(async () => {
    const value = await enhanceGet(ctx, k.pk).catch(() => null);
    return value?.last.taste?.status === 'failed' ? value : null;
  }, 30000, 300);
  const stale = await revisionDetail(ctx, k.pk, k.stale);
  record('MEM-23 after the background process ends during a run and restarts, the running revision becomes failed '
    + '(Notes "Mori closed during the run", its change kept) and last records the failure with that reason',
  stale?.status === 'failed' && stale.notes === 'Mori closed during the run' && stale.counts.added === 1
    && info?.last.taste.error === 'Mori closed during the run' && info.last.taste.revision === k.stale,
  brief({ stale: stale && [stale.status, stale.notes, stale.counts], last: info?.last.taste }));
  const settled = await waitFor(async () => {
    const file = readEnhance(ctx.userData, k.pk);
    return TASKS.every((task) => file?.tasks[task].last?.status === 'done' && file.tasks[task].last.day === k.Y);
  }, 90000, 500);
  const reruns = (await runRevisions(ctx, k.pk, { task: 'taste', day: k.Y })).filter((r) => r.id !== k.stale);
  record('MEM-23 the day is run again after the restart (a new TASTE revision for the same day, done; all three tasks '
    + 'done for that day)', settled && reruns.length === 1 && reruns[0].status === 'done',
  brief({ settled, reruns: reruns.map((r) => [r.id, r.status]) }));
  const notice = readEnhance(ctx.userData, k.pk)?.notice;
  const tab = await openTab(ctx, k.pk);
  const banner = await noticeOf(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="memory-notice-view"]`).click();
  await ctx.page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  await waitFor(async () => (await revisionView(ctx)).title !== null, 10000);
  const view = await revisionView(ctx);
  record('MEM-26 a run cut off by the background process ending that had written a change still leaves a notice: '
    + `the banner reads "…from the ${monthDay(k.Y)} sessions: TASTE 1." and View opens that failed revision`,
  same(notice, { revisions: [k.stale], counts: { taste: 1, strategy: 0, review: 0 }, from: k.Y, to: k.Y })
    && banner?.text === `Enhancement updated this project’s memory from the ${monthDay(k.Y)} sessions: TASTE 1.`
    && view.selected === k.stale && view.tags.includes('Failed'), brief({ notice, banner, view }));
  await ctx.page.getByTestId('revision-rollback').click();
  const gone = await waitFor(async () => !(await memoryList(ctx, k.pk, 'taste')).entries.some((e) =>
    e.abstract === 'Kill taste'), 15000);
  record('MEM-23 the change written before the process ended can be rolled back from that failed revision', gone, '');
  await backToApp(ctx);
}

/** @brief kill 这一次启动。 */
async function kill(ctx) {
  await launchApp(ctx, seedKill);
  await killDuring(ctx);
  await killAfter(ctx);
}

// ---------- exitDuring：只有增强任务在运行时点托盘"Exit"（window.md，2026-10-26 补） ----------

/** 增强运行被 Mori 退出打断时的原因（memory.md §9.10） */
const RUN_CLOSED = 'Mori closed during the run';

/** @brief 测试准备（synthetic）：昨天的会话，启动时补跑的 TASTE 写入一条之后一直等（同 seedKill，另一个项目）。 */
function seedExit(ctx) {
  const x = ctx.x = { D: dayOf(Date.now(), TIME) };
  x.Y = addDays(x.D, -1);
  x.pe = makeProject(ROOT, 'l-exit');
  x.se = seedSession(ctx.userData, x.pe, { name: 'Exit chat', items: chatItems(['Exit question', 'Exit answer.'],
    atOn(x.Y, 9)) });
  writeEnhance(ctx.userData, x.pe, enhanceSeed({ since: x.Y, doneThrough: addDays(x.Y, -1) }));
  writeScript(SCRIPT, { ...quietScript('@l-exit'), 'taste@l-exit': [mem({ action: 'save', abstract: 'Exit taste',
    evidence: [ev(x.se.file, x.se.entries[0].id)] }), say('Still working.', 600000)] });
}

/**
 * @brief TASTE 写入后、没有会话在生成时点托盘"Exit"（确认框换成按"Cancel"回答：问了就不会退出）：不问，Mori 20 秒内
 *        退出。没退出时测试强行结束它（Playwright 的 close 也走 app.quit()，退不出时会一直等）。
 */
async function exitWhileEnhancing(ctx) {
  const x = ctx.x;
  const running = await poll(async () => (await revisionRows(ctx, x.pe)).find((row) => row.status === 'running'
    && row.counts.added === 1), 60000, 300);
  if (!running) throw new Error('the TASTE run never wrote its entry');
  x.stale = running.id;
  const app = ctx.app;
  await stubMessageBox(app, 1);
  const exited = await exitFromTray(app, 20000);
  const boxes = exited ? [] : await messageBoxes(app).catch((error) => `cannot read: ${error}`);
  if (!exited) app.process().kill();
  record('window.md (2026-10-26) tray "Exit" while only an enhancement run is running (no session generating): no '
    + 'confirmation, Mori exits within 20 s', exited && same(boxes, []), brief({ exited, boxes }));
}

/** @brief 同一个数据目录再启动：那条修订 Failed（原因、改动留着）、last 记失败，那一天重跑。 */
async function exitAfter(ctx) {
  const x = ctx.x;
  // 重跑那一次先等 8 秒，留出读到"失败"的时间
  writeScript(SCRIPT, { ...quietScript('@l-exit'), 'taste@l-exit': [say('Run again after the exit.', 8000)] });
  await startTbApp(ctx);
  const info = await poll(async () => {
    const value = await enhanceGet(ctx, x.pe).catch(() => null);
    return value?.last.taste?.status === 'failed' ? value : null;
  }, 30000, 300);
  const stale = await revisionDetail(ctx, x.pe, x.stale);
  const kept = (await memoryList(ctx, x.pe, 'taste')).entries.some((entry) => entry.abstract === 'Exit taste');
  const settled = await waitFor(async () => {
    const file = readEnhance(ctx.userData, x.pe);
    return TASKS.every((task) => file?.tasks[task].last?.status === 'done' && file.tasks[task].last.day === x.Y);
  }, 90000, 500);
  const reruns = (await runRevisions(ctx, x.pe, { task: 'taste', day: x.Y })).filter((r) => r.id !== x.stale);
  record('window.md (2026-10-26) after that exit the interrupted run is recorded as failed (its revision Failed with '
    + 'Notes "Mori closed during the run", last records that reason) and its change stays ("Exit taste" is in TASTE); '
    + 'the next start runs that day again (a new TASTE revision for the day, done; all three tasks done)',
  stale?.status === 'failed' && stale.notes === RUN_CLOSED && stale.counts.added === 1
    && info?.last.taste.error === RUN_CLOSED && info.last.taste.revision === x.stale && kept && settled
    && reruns.length === 1 && reruns[0].status === 'done',
  brief({ stale: stale && [stale.status, stale.notes, stale.counts], last: info?.last.taste, kept, settled,
    reruns: reruns.map((r) => [r.id, r.status]) }));
}

/** @brief exitDuring 这一次启动（再启动一次，同一个数据目录）。 */
async function exitDuring(ctx) {
  await launchApp(ctx, seedExit);
  await exitWhileEnhancing(ctx);
  await exitAfter(ctx);
}

// ---------- 主流程 ----------

/** @brief 关掉这一次的 App，留下 App 日志。 */
async function closeApp(ctx, name) {
  if (!ctx.app) return;
  writeFileSync(join(args.shots, `${name}-app.log`), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  ctx.appLog = [];
  await closeTbApp(ctx);
}

/** 步骤（每个一次启动）与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  catchUp: [catchUp, ['MEM-18', 'MEM-19', 'MEM-23', 'MEM-24', 'MEM-25', 'MEM-26', 'MEM-17']],
  timer: [timer, ['MEM-18', 'MEM-19', 'MEM-25']],
  kill: [kill, ['MEM-23', 'MEM-26']],
  exitDuring: [exitDuring, ['window.md']],
};

const ctx = { exePath: args.exePath, pageErrors: [] };
try {
  ctx.ep = await startTbEndpoint(PORT, PROXY, { FAKE_ENHANCE_SCRIPT: SCRIPT });
  for (const [name, [step, ids]] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[mem-app-enhance-b] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      for (const id of ids) record(`${id} step ${name} ran to the end`, false, errorLine(error));
      await shot(ctx, args, `${name}-error`);
    } finally {
      await closeApp(ctx, name);
    }
  }
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[mem-app-enhance-b] projects in ${ROOT}`);
finish();
