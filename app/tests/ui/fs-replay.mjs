// 文件系统的回放测试（docs/specs/file-system.md §19.1 的回放层、§19.2）：在 Electron 里载入真正的界面，用回放进程桥
// （tests/ui/harness）回放录制，检查右栏 Changes、顶栏 +N −M 与消息上的 Rewind（状态表 docs/v1/screens/fs-changes.md）：
//   FS-13、FS-23（synthetic 的部分）：回放桥的 workspace.status 是合成的（synthetic，§19.4）。用现有的真实录制
//     m4/stream-feedback（一条消息，没有批准卡；§19.4 不重录它），发完消息后经 window.__replay.inject 给会话补一条手写的
//     mori.turn_changes（synthetic，syntheticTurnChanges：README.md +2 −1、src/a.ts +1 −0，轮为录下的那条你的消息）。
//     先在默认的 git ok（repo null）下看到 Not a git repository、This session 的这一轮、Rewind 与 +3 −1（对照，证明后面
//     "没有"的检查不是空的），再经 window.__replay.setWorkspace 换成 git old（2.31.0）；另一遍用页面参数 ?git=old 从头
//     就是 old：右栏正文只有 "Git 2.32 or newer is required to track changes and rewind (found 2.31.0)." 一行、
//     data-state="old"，没有 This session、Rewind 与 +N −M（这一栏宽于 600 px 时也没有）。这一遍里补的记录要让右栏
//     自己打开（§5.1），最后换回 git ok 时 Rewind 与 +3 −1 要出现：记录与条目 id 确实到了，"没有"才算数。
//   FS-36、FS-54、FS-78（录下的部分）：fs-real.mjs 从真实会话录下 tests/fixtures/filesystem/ 的 full-outside.json、
//     work-scratch.json、away-reminder.json（§19.1）。按录制里界面发出的命令操作界面（Open folder…、发消息、权限菜单、
//     批准卡的按钮），回放桥核对每条命令；再看批准卡的原因行（FS-36）、写进 .work 的 write 不出卡（FS-54）、自动拒绝的
//     Denied 与提醒不显示（FS-78）。录制文件还不存在时，每个对应编号记一条失败"<编号> replay fixture missing"（不造假录制）。
// 用法（在 app/ 下）：node tests/ui/fs-replay.mjs [--only git-ok,git-old,full-outside,work-scratch,away-reminder]
// 结果写到 test-results/fs-replay.json（--only 时 fs-partial-replay.json，不计入覆盖检查）；截图在 test-results/fs-replay/。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { REMINDER_PREFIX } from '../fake-endpoint/away.mjs';
import { AWAY_DENIED } from './fs-away-helpers.mjs';
import { REASON_LINE, setPermission } from './fs-helpers.mjs';
import { OK_GIT, OLD_GIT, answeredDirectly, syntheticTurnChanges } from './harness/replay.js';
import { ensureHarness as buildHarness, harnessDir, harnessOut as outDir } from './harness-page.mjs';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { PANE, waitIdle, waitReady } from './m3-helpers.mjs';
import { pageHelpers } from './page.mjs';

const only = arg('only')?.split(',');
const shots = join(appRoot, 'test-results/fs-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** git 版本太低时右栏正文唯一的一行（fs-changes.md "上半部分：三种文件夹"，回放桥合成的 2.31.0） */
const GIT_OLD_TEXT = 'Git 2.32 or newer is required to track changes and rewind (found 2.31.0).';
/** 不是 git 仓库时上半部分的一行 */
const NOT_A_REPO = 'Not a git repository';
/** synthetic 部分用的真实录制：一条消息、没有批准卡、你的消息有条目 id（mori.entry_id） */
const BASE = { dir: 'm4', name: 'stream-feedback' };
/** synthetic：补给那一轮的改动（手写的 mori.turn_changes 记录） */
const SYNTHETIC_FILES = [{ path: 'README.md', status: 'M', added: 2, removed: 1 },
  { path: 'src/a.ts', status: 'M', added: 1, removed: 0 }];
/** 上面那条记录在顶栏的读屏名（fs-changes.md "顶栏"：3 行增加、1 行删除） */
const LINES_LABEL = 'Changes in this session: 3 lines added, 1 removed';
/** 批准卡最多显示的原因行（ApprovalCard.tsx REASON_LINES，§6.13 的 and {n} more 之前） */
const REASON_LINES = 5;

// ---------- 录制 ----------

/** @brief 录制文件的路径（tests/fixtures/<dir>/<name>.json）。 */
const fixturePath = (dir, name) => join(appRoot, 'tests/fixtures', dir, `${name}.json`);
/** @brief 读一个录制文件。 */
const readFixture = (dir, name) => JSON.parse(readFileSync(fixturePath(dir, name), 'utf8'));
/** @brief 录制里界面发出、占回放顺序的命令（回放桥直接回答的除外，同 replay.js 的 boundaries）。 */
const commandsOf = (fx) => fx.steps.filter((s) => s.command && !answeredDirectly(s.command.type)).map((s) => s.command);
/** @brief 录制里某种事件（按顺序）。 */
const eventsOf = (fx, type) => fx.steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);
/** @brief 录制里你的第一条消息的条目 id（mori.entry_id，role user）。 */
const userRound = (fx) => eventsOf(fx, 'mori.entry_id').find((event) => event.role === 'user')?.entryId ?? null;
/** @brief 录制里第一个 session.create 的工作路径。 */
const createdCwd = (fx) => fx.steps.find((s) => s.result?.type === 'session.create')?.result.value?.cwd ?? '';
/** @brief 两个值的 JSON 相同。 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 页面 ----------

/** @brief 回放页面的地址；git 为 old 时合成的 workspace.status 从头就是 git old（main.jsx 的 git 参数）。 */
function harnessUrl(name, git) {
  const query = new URLSearchParams({ fixture: name, speed: '4', maxGap: '600' });
  if (git) query.set('git', git);
  return `${pathToFileURL(join(outDir, 'index.html')).href}?${query}`;
}

/**
 * @brief 在页面里记下出现过的 Rewind 按钮、+N −M 与批准卡（window.__fsReplay）：看"从来没出现过"时用，出现又马上消失的
 *        也记得到。批准卡按 data-request 记一次：{ request, tool, scope, reasons（原因行 [{ reason, text }]） }。
 */
function watchMarks(page) {
  return page.evaluate(() => {
    const seen = { rewind: 0, lines: 0, cards: [] };
    window.__fsReplay = seen;
    const elements = new WeakSet();
    const requests = new Set();
    const text = (el) => el?.textContent?.trim() ?? null;
    const card = (el) => ({ request: el.dataset.request ?? null, tool: el.dataset.tool ?? null,
      scope: el.dataset.scope ?? null, reasons: [...el.querySelectorAll('[data-testid="approval-scope"]')]
        .map((line) => ({ reason: line.dataset.reason ?? null, text: text(line) })) });
    const scan = () => {
      for (const el of document.querySelectorAll('[data-testid="rewind-button"], [data-testid="lines-indicator"]')) {
        if (elements.has(el)) continue;
        elements.add(el);
        if (el.dataset.testid === 'rewind-button') seen.rewind += 1;
        else seen.lines += 1;
      }
      for (const el of document.querySelectorAll('[data-testid="approval-card"]')) {
        if (requests.has(el.dataset.request)) continue;
        requests.add(el.dataset.request);
        seen.cards.push(card(el));
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-request'] });
    scan();
  });
}

/** @brief watchMarks 记下的。 */
const seenMarks = (page) => page.evaluate(() => window.__fsReplay);

/** @brief 载入录制，等侧栏读完会话列表，装上 watchMarks。 */
async function load(page, name, git = null) {
  await page.goto(harnessUrl(name, git));
  await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
  await watchMarks(page);
}

/**
 * @brief 点"Open folder…"（回放桥直接返回下一条 session.create 的文件夹，不经系统对话框，所以不用 page.mjs 里要换掉
 *        dialog 的 openFolder），等会话就绪（m3-helpers 的 waitReady）。
 */
async function openFolder(page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
  await waitReady(page);
}

/** @brief 等回放桥放完 count 段（界面的第 count 条命令之前的事件都发完）；出现不一致时立即报错。 */
async function untilPlayed(page, count, what) {
  await page.waitForFunction((n) => window.__replay.status.played >= n || window.__replay.status.errors.length > 0,
    count, { timeout: 90000 }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
  const errors = await page.evaluate(() => window.__replay.status.errors);
  if (errors.length) throw new Error(errors.join('; '));
}

/** @brief 回放是否走完：录制里的命令全部用上、没有不一致。返回 { ok, detail }。 */
async function finished(page, fx) {
  const total = commandsOf(fx).length;
  await untilPlayed(page, total, `all ${total} commands of ${fx.name}`);
  const status = await page.evaluate(() => window.__replay.status);
  return { ok: status.errors.length === 0 && status.cursor === total,
    detail: JSON.stringify({ total, cursor: status.cursor, errors: status.errors }) };
}

/** @brief 回放桥记下的第一个打开的会话的 pi 会话 id（status.sessions）。 */
const sessionIdOf = (page) => page.evaluate(() => window.__replay.status.sessions[0]?.sessionId ?? null);

/** @brief synthetic：经回放桥给会话发一条手写的事件。 */
const inject = (page, sessionId, event) => page.evaluate(({ sid, ev }) => window.__replay.inject(sid, ev),
  { sid: sessionId, ev: event });

/** @brief 打开或关上右栏（Toggle changes），等它变过来。 */
async function setPanel(page, open) {
  const panel = page.getByTestId('right-panel');
  if (await panel.isVisible().catch(() => false) !== open) {
    await page.locator(`${PANE} button[aria-label="Toggle changes"]`).click();
  }
  await panel.waitFor({ state: open ? 'visible' : 'hidden', timeout: 5000 });
}

/**
 * @brief 右栏与这一栏此刻的样子：正文的文字与子元素个数、git-required、not-a-repo（notRepo 只取那一行的文字：下面的
 *        "Initialize git…"按钮属于 worktree 那一步，不算进去；notRepoShown 为那一块在不在）、This session 与其中的轮、
 *        Refresh、消息上的 Rewind（data-entry）、+N −M（数字、读屏名、是否显示）与这一栏的宽度。
 */
function readPanel(page) {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const panel = document.querySelector('[data-testid="right-panel"]');
    const body = panel?.querySelector('[data-testid="changes"]') ?? null;
    const required = body?.querySelector('[data-testid="git-required"]');
    const notRepo = body?.querySelector('[data-testid="not-a-repo"]') ?? null;
    const lines = pane?.querySelector('[data-testid="lines-indicator"]');
    const turn = (el) => ({ round: el.dataset.round ?? null, turn: el.dataset.turn ?? null,
      files: [...el.querySelectorAll('[data-testid="turn-file"]')].map((file) => file.dataset.path) });
    const visible = (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    return {
      body: body ? body.innerText.trim() : null, bodyChildren: body?.children.length ?? 0,
      required: required ? { state: required.dataset.state ?? null, text: required.textContent.trim() } : null,
      notRepo: notRepo?.querySelector('.changes-line')?.textContent.trim() ?? null, notRepoShown: Boolean(notRepo),
      session: Boolean(body?.querySelector('[data-testid="session-changes"]')),
      turns: [...(body?.querySelectorAll('[data-testid="turn-changes"]') ?? [])].map(turn),
      refresh: Boolean(panel?.querySelector('[data-testid="changes-refresh"]')),
      rewind: pane ? [...pane.querySelectorAll('[data-testid="rewind-button"]')].map((el) => el.dataset.entry) : [],
      lines: lines ? { added: lines.dataset.added, removed: lines.dataset.removed,
        label: lines.getAttribute('aria-label'), visible: visible(lines) } : null,
      paneWidth: pane?.getBoundingClientRect().width ?? 0,
    };
  }, PANE);
}

/** @brief 回放桥记下的 workspace.status 查询条数。 */
const statusQueries = (page) => page.evaluate(() => window.__replay.status.queries
  .filter((query) => query.type === 'workspace.status').length);

// ---------- FS-13、FS-23：合成的 git 状态（synthetic） ----------

/**
 * @brief 回放 BASE（Open folder…、发录下的消息、等本轮结束），再给这一轮补一条手写的 mori.turn_changes（synthetic），
 *        打开右栏。git 为 old 时页面从头就是 git old。返回 { fx, round, done（回放是否走完）, queries（补记录之前的
 *        workspace.status 查询条数）, sessionId, autoOpened（补记录之前右栏关着、补了之后自己打开：记录进了这个会话的
 *        turnChanges，§5.1；git old 时 This session 不显示，这是记录到了的凭据） }。
 */
async function replayBase(page, git) {
  const fx = readFixture(BASE.dir, BASE.name);
  const prompt = commandsOf(fx).find((command) => command.type === 'session.prompt');
  await load(page, BASE.name, git);
  await openFolder(page);
  await pageHelpers(page).send(prompt.text);
  const done = await finished(page, fx);
  await waitIdle(page, 90000);
  const queries = await statusQueries(page);
  const round = userRound(fx);
  const sessionId = await sessionIdOf(page);
  const panel = page.getByTestId('right-panel');
  const closedBefore = !(await panel.isVisible());
  await inject(page, sessionId, syntheticTurnChanges({ round, files: SYNTHETIC_FILES }));
  // 第一次收到 changes 记录时右栏自己打开（§5.1）：先等它，免得在它打开之前点开关反而把它关上
  const opened = await panel.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  await setPanel(page, true);
  return { fx, round, done, queries, sessionId, autoOpened: closedBefore && opened };
}

/** @brief git 是 old 时的正文：只有那一行（data-state old），没有 This session、Not a git repository 与轮。 */
const onlyOldLine = (panel) => panel.required?.state === 'old' && panel.required.text === GIT_OLD_TEXT
  && panel.body === GIT_OLD_TEXT && panel.bodyChildren === 1 && !panel.session && !panel.notRepoShown
  && panel.turns.length === 0 && panel.refresh;

/** @brief 对照：合成的 git ok（repo null）下补的那一轮在 This session 里、消息上有 Rewind、顶栏 +3 −1。 */
function recordControl({ round, done, autoOpened }, open, wide) {
  record('FS-13 replay (control, synthetic git ok with repo null): the injected synthetic record opens the right '
    + 'panel by itself; Changes shows "Not a git repository" with This session listing the injected turn (README.md, '
    + 'src/a.ts) and the message has Rewind, so the old-git checks below are not vacuous; the recorded commands '
    + 'replay without a mismatch', done.ok && autoOpened
    && open.notRepo === NOT_A_REPO && open.required === null && open.session && open.turns.length === 1
    && open.turns[0].round === round && same(open.turns[0].files, ['README.md', 'src/a.ts'])
    && same(open.rewind, [round]), JSON.stringify({ done, round, autoOpened, open }));
  record('FS-23 replay (control): with git ok the injected synthetic record shows the lines indicator +3 −1 '
    + `(data-added 3, data-removed 1, "${LINES_LABEL}"), visible once the pane is wider than 600 px`,
  open.lines?.added === '3' && open.lines.removed === '1' && open.lines.label === LINES_LABEL
    && wide.lines?.visible === true && wide.paneWidth > 600, JSON.stringify({ open: open.lines, wide }));
}

/** @brief 换成 git old 之后：右栏只有那一行，Rewind 与 +N −M 都没了。 */
function recordSwitched(sent, wide, panel) {
  record('FS-13 replay (setWorkspace git old 2.31.0 while the session is open): Changes shows only "Git 2.32 or newer '
    + 'is required to track changes and rewind (found 2.31.0)." with data-state="old" and Refresh; no This session, '
    + 'no "Not a git repository", and the message has no Rewind', sent === 1 && onlyOldLine(panel)
    && panel.rewind.length === 0 && wide.rewind.length === 0, JSON.stringify({ sent, panel, rewind: wide.rewind }));
  record('FS-23 replay (setWorkspace git old): the lines indicator goes away although the branch still has the +3 −1 '
    + 'record and the pane is wider than 600 px', wide.lines === null && wide.paneWidth > 600,
  JSON.stringify(wide));
}

/** @brief 对照之后在运行中换成 git old（setWorkspace 给打开的会话发合成的 mori.workspace_status）。 */
async function gitOkThenOld(page) {
  const base = await replayBase(page, null);
  await page.locator('[data-testid="right-panel"] [data-testid="turn-changes"]').waitFor({ timeout: 10000 });
  const open = await readPanel(page);
  await setPanel(page, false);
  const wide = await readPanel(page);
  recordControl(base, open, wide);
  await shot(page, 'git-ok');
  const sent = await page.evaluate((git) => window.__replay.setWorkspace({ git }), { ...OLD_GIT });
  await page.waitForFunction((p) => !document.querySelector(`${p} [data-testid="lines-indicator"]`)
    && !document.querySelector(`${p} [data-testid="rewind-button"]`), PANE, { timeout: 10000 }).catch(() => {});
  const wideOld = await readPanel(page);
  await setPanel(page, true);
  await page.getByTestId('git-required').waitFor({ timeout: 10000 }).catch(() => {});
  recordSwitched(sent, wideOld, await readPanel(page));
  await shot(page, 'git-switched-old');
}

/** @brief 点 Refresh，等它不再转圈；返回之后的右栏与多出的 workspace.status 查询条数。 */
async function refreshOnce(page) {
  const before = await statusQueries(page);
  await page.getByTestId('changes-refresh').click();
  await page.waitForFunction((n) => window.__replay.status.queries.filter((q) => q.type === 'workspace.status')
    .length > n && !document.querySelector('[data-testid="changes-refresh"][data-busy]'), before,
  { timeout: 10000 }).catch(() => {});
  return { panel: await readPanel(page), more: (await statusQueries(page)) - before };
}

/**
 * @brief ?git=old 那一遍最后的凭据：经 setWorkspace 换回 git ok，等消息上的 Rewind 与顶栏的 +N −M 出现（右栏关着，
 *        这一栏宽于 600 px）。证明补的记录与你那条消息的条目 id 确实到了这个会话，前面"从来没出现过"不是空的。
 *        返回 { sent（发出的 mori.workspace_status 条数）, rewind（data-entry）, lines（data-added、data-removed） }。
 */
async function backToOk(page) {
  const sent = await page.evaluate((git) => window.__replay.setWorkspace({ git }), { ...OK_GIT });
  await page.waitForFunction((p) => document.querySelector(`${p} [data-testid="lines-indicator"]`)
    && document.querySelector(`${p} [data-testid="rewind-button"]`), PANE, { timeout: 10000 }).catch(() => {});
  const view = await readPanel(page);
  return { sent, rewind: view.rewind, lines: view.lines && { added: view.lines.added, removed: view.lines.removed } };
}

/**
 * @brief 页面参数 ?git=old：从头就是 git old，Rewind 与 +N −M 从来没出现过；Refresh 之后照旧。补的记录自己打开了
 *        右栏、最后换回 git ok 时 Rewind 与 +3 −1 出现（backToOk），两者都要有，"没有"的检查才算数。
 */
async function gitOldFromStart(page) {
  const base = await replayBase(page, 'old');
  await page.getByTestId('git-required').waitFor({ timeout: 10000 }).catch(() => {});
  const open = await readPanel(page);
  const refreshed = await refreshOnce(page);
  await setPanel(page, false);
  const wide = await readPanel(page);
  const seen = await seenMarks(page);
  await shot(page, 'git-old');
  const proof = await backToOk(page);
  record('FS-13 replay (?git=old from the start, synthetic 2.31.0): Changes shows only "Git 2.32 or newer is required '
    + 'to track changes and rewind (found 2.31.0)." with data-state="old"; no This session, and no Rewind ever '
    + 'appeared on the message; Refresh asks workspace.status again and the line stays (the injected record opened '
    + 'the panel by itself, and Rewind shows on that message once git is ok again)', base.done.ok && base.autoOpened
    && base.queries > 0 && onlyOldLine(open) && open.rewind.length === 0 && seen.rewind === 0
    && refreshed.more >= 1 && onlyOldLine(refreshed.panel) && proof.sent === 1 && same(proof.rewind, [base.round]),
  JSON.stringify({ done: base.done, autoOpened: base.autoOpened, queries: base.queries, open, refreshed,
    seen: seen.rewind, proof }));
  record('FS-23 replay (?git=old from the start): the lines indicator never appeared although the branch has the +3 '
    + '−1 record and the pane is wider than 600 px (it shows +3 −1 once git is ok again)', base.autoOpened
    && wide.lines === null && seen.lines === 0 && wide.paneWidth > 600
    && same(proof.lines, { added: '3', removed: '1' }), JSON.stringify({ wide, seen: seen.lines, proof }));
}

// ---------- FS-36、FS-54、FS-78：fs-real.mjs 录下的 fixture ----------

/** @brief 这一栏权限按钮上的模式名（Ask each time / Full access）。 */
const modeText = (page) => page.locator(`${PANE} [data-testid="permission-button"] .permission-text`).textContent()
  .then((text) => text?.trim() ?? null, () => null);

/**
 * @brief 经权限菜单切换当前这一栏的模式：用 fs-helpers 的 setPermission（Full access 要在确认框里再点一次，等按钮的
 *        模式名变过来），这一栏的标识取它的 data-tab。
 */
async function setMode(page, mode) {
  const tab = await page.locator(PANE).getAttribute('data-tab');
  await setPermission({ page }, tab, mode);
}

/** 批准卡上各决定对应的按钮 */
const ANSWER_BUTTON = { allow: 'approval-allow', allowSession: 'approval-allow-session',
  allowDir: 'approval-allow-session', reject: 'approval-reject' };

/** @brief 答录下的那张批准卡：等它出现，按录下的决定点按钮（拒绝时先写上录下的理由）。 */
async function answerRecorded(page, command) {
  const card = page.locator(`${PANE} [data-testid="approval-card"][data-request="${command.requestId}"]`);
  await card.waitFor({ timeout: 30000 });
  if (command.decision === 'reject' && command.reason?.trim()) {
    await card.getByTestId('approval-reason').fill(command.reason);
  }
  await card.getByTestId(ANSWER_BUTTON[command.decision]).click();
  await card.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
}

/** @brief 照录制里界面发出的一条命令操作界面；不认识的命令报错（不造假操作）。 */
async function driveCommand(page, command, fx) {
  switch (command.type) {
    case 'session.create':
      if (command.trust) throw new Error(`${fx.name}: a trust answer on session.create is not driven by fs-replay`);
      return openFolder(page);
    case 'session.prompt':
      if (command.refs?.length || command.behavior || command.team) {
        throw new Error(`${fx.name}: session.prompt with refs, behavior or team is not driven by fs-replay`);
      }
      return pageHelpers(page).send(command.text);
    case 'approval.setMode':
      return setMode(page, command.mode);
    case 'approval.answer':
      return answerRecorded(page, command);
    default:
      throw new Error(`${fx.name}: fs-replay cannot drive ${command.type}`);
  }
}

/**
 * @brief 载入一份录下的 fixture，按录制里界面发出的命令逐条操作界面（每条命令之前等回放桥放完它之前的事件，
 *        同录制时的时刻），最后等本轮结束。返回回放是否走完（finished）。
 */
async function driveRecorded(page, fx) {
  await load(page, fx.name);
  const commands = commandsOf(fx);
  for (const [index, command] of commands.entries()) {
    await untilPlayed(page, index, `${fx.name} before ${command.type} #${index}`);
    await driveCommand(page, command, fx);
  }
  const done = await finished(page, fx);
  // 等不到空闲时不在这里报错：后面的检查读到的就是这时的样子，回放是否走完由 done 记
  await waitIdle(page, 90000).catch(() => {});
  return done;
}

/**
 * @brief 这一栏的工具卡（按对话流的顺序）：[{ title, status（data-status）, statusText（状态行） }]。
 */
const toolCards = (page) => page.locator(`${PANE} [data-testid="tool-card"]`).evaluateAll((cards) => cards
  .map((card) => ({ title: card.querySelector('.tool-title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    status: card.dataset.status ?? null,
    statusText: card.querySelector('[data-testid="tool-status"]')?.textContent?.trim() ?? null })));

/** @brief path 在工作路径的 .work 里（相对的 .work/…，或 <cwd>\.work\… 的绝对路径；不分大小写、统一斜杠）。 */
function inWork(path, cwd) {
  if (typeof path !== 'string') return false;
  const norm = (value) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return norm(path).startsWith('.work/') || norm(path).startsWith(`${norm(cwd).replace(/\/+$/, '')}/.work/`);
}

/**
 * @brief FS-36（full-outside.json）：Full access 下写到工作路径外的那张卡，scope 为 outside，每个显示出来的
 *        outside 目标一行 "Writes outside the working directory: <路径>"（路径取录下的 targets）。
 */
async function fullOutside(page, fx) {
  const asked = eventsOf(fx, 'mori.approval_request').filter((event) => event.scope === 'outside');
  const setFull = commandsOf(fx).some((command) => command.type === 'approval.setMode' && command.mode === 'full');
  const done = await driveRecorded(page, fx);
  const { cards } = await seenMarks(page);
  const mode = await modeText(page);
  const lines = asked.map((event) => {
    const card = cards.find((item) => item.request === event.requestId);
    const want = event.targets.slice(0, REASON_LINES).filter((target) => target.reason === 'outside')
      .map((target) => REASON_LINE.outside(target.path));
    const got = (card?.reasons ?? []).filter((line) => line.reason === 'outside').map((line) => line.text);
    return { request: event.requestId, scope: card?.scope ?? null, want, got };
  });
  record('FS-36 replay full-outside: under Full access (set through the permission menu, approval.setMode full) the '
    + 'recorded write outside shows a card with scope outside and the reason line "Writes outside the working '
    + 'directory: <real path>" for each shown outside target', setFull && mode === 'Full access' && lines.length > 0
    && lines.every((line) => line.scope === 'outside' && line.want.length > 0 && same(line.want, line.got)),
  JSON.stringify({ setFull, mode, lines }));
  record('FS-36 replay full-outside: the UI commands match the recording (setMode, prompt, the card answers)',
    done.ok, done.detail);
}

/**
 * @brief FS-54（work-scratch.json）：Ask each time 下模型写进 .work 的 write 不出卡：录制里它没有批准请求，回放时出现过的
 *        卡都是录下的请求，它的工具卡执行完成。
 */
async function workScratch(page, fx) {
  const cwd = createdCwd(fx);
  const writes = eventsOf(fx, 'tool_execution_start').filter((event) => event.toolName === 'write'
    && inWork(event.args?.path, cwd));
  const asked = eventsOf(fx, 'mori.approval_request');
  const askedWork = asked.filter((event) => writes.some((item) => item.toolCallId === event.toolCallId));
  const askMode = !commandsOf(fx).some((command) => command.type === 'approval.setMode');
  const done = await driveRecorded(page, fx);
  const { cards } = await seenMarks(page);
  const mode = await modeText(page);
  const work = (await toolCards(page)).filter((card) => card.title.includes('.work'));
  record('FS-54 replay work-scratch: under Ask each time the recorded write into .work/ runs without an approval '
    + 'card (no request for it in the recording, every card shown is a recorded request) and its tool card is done',
  askMode && mode === 'Ask each time' && writes.length > 0 && askedWork.length === 0
    && cards.every((card) => asked.some((event) => event.requestId === card.request))
    && work.some((card) => card.status === 'done'),
  JSON.stringify({ writes: writes.map((event) => event.args?.path), askedWork, cards, mode, work }));
  record('FS-54 replay work-scratch: the UI commands match the recording', done.ok, done.detail);
}

/**
 * @brief 工具卡标题里认得出一次调用的那段文字（toolTitle.ts：路径类工具显示路径，命令类显示命令的第一行）：有 path 时
 *        取文件名，有 command 时取第一行的前 40 个字符；都没有时为 null（认不出，检查不通过）。
 */
function titleMarker(args) {
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const path = text(args?.path);
  if (path) return path.replace(/\\/g, '/').split('/').at(-1);
  const command = text(args?.command);
  return command ? command.split(/\r?\n/)[0].slice(0, 40) : null;
}

/**
 * @brief 录下的每个自动拒绝（mori.approval_end by away）对应的工具卡：经同一 requestId 的 mori.approval_request 取到
 *        那次调用的参数，按 titleMarker 找标题含它的工具卡。返回 [{ request, marker, card（找不到时 null） }]。
 */
function deniedCards(fx, cards) {
  const requests = eventsOf(fx, 'mori.approval_request');
  return eventsOf(fx, 'mori.approval_end').filter((event) => event.by === 'away').map((event) => {
    const marker = titleMarker(requests.find((item) => item.requestId === event.requestId)?.args);
    return { request: event.requestId, marker,
      card: marker ? cards.findLast((card) => card.title.includes(marker)) ?? null : null };
  });
}

/** @brief 这一栏对话流的文字；没有对话流时为 null（检查不通过，不当成"没有提醒"）。 */
const transcriptText = (page) => page.evaluate((p) => document.querySelector(`${p} [data-testid="transcript"]`)
  ?.textContent ?? null, PANE);

/**
 * @brief FS-78（away-reminder.json）：你不在时自动拒绝的那次调用（按录下的 requestId 对上它的工具卡）在工具卡上是
 *        "Denied · No answer while you were away"，录下的提醒（custom_message，display: false）不出现在对话流里。
 */
async function awayReminder(page, fx) {
  const reminded = fx.steps.some((step) => step.envelope && JSON.stringify(step.envelope).includes(REMINDER_PREFIX));
  const done = await driveRecorded(page, fx);
  const denied = deniedCards(fx, await toolCards(page));
  const shown = await transcriptText(page);
  record('FS-78 replay away-reminder: the auto-denied call shows "Denied · No answer while you were away" on its tool '
    + 'card and the recorded reminder (custom_message, display false) is not shown in the transcript',
  denied.length > 0 && reminded && denied.every(({ card }) => card?.status === 'rejected'
    && card.statusText === AWAY_DENIED) && typeof shown === 'string' && shown.length > 0
    && !shown.includes(REMINDER_PREFIX.slice(0, 40)),
  JSON.stringify({ denied, reminded, transcript: shown === null ? null : shown.length }));
  record('FS-78 replay away-reminder: the UI commands match the recording', done.ok, done.detail);
}

// ---------- 执行 ----------

/** synthetic 部分：名字、覆盖的编号、检查 */
const SYNTHETIC = [
  { name: 'git-ok', ids: ['FS-13', 'FS-23'], run: gitOkThenOld },
  { name: 'git-old', ids: ['FS-13', 'FS-23'], run: gitOldFromStart },
];
/** fs-real.mjs 录下的 fixture（§19.1）：名字、覆盖的编号、检查 */
const RECORDED = [
  { name: 'full-outside', ids: ['FS-36'], run: fullOutside },
  { name: 'work-scratch', ids: ['FS-54'], run: workScratch },
  { name: 'away-reminder', ids: ['FS-78'], run: awayReminder },
];

/** @brief 跑一组检查；出错时给这一组的每个编号记一条失败；之后给每个编号记这一组的页面错误。 */
async function guarded(page, errors, item, run) {
  const before = errors.length;
  try {
    await run();
  } catch (error) {
    for (const id of item.ids) record(`${id} replay ${item.name}: flow`, false, oneLine(error, 600));
    await shot(page, `${item.name}-error`);
  }
  await sleep(200);
  const mine = errors.slice(before);
  for (const id of item.ids) {
    record(`${id} replay ${item.name}: the page has no errors`, mine.length === 0, mine.slice(0, 5).join(' | '));
  }
}

const chosenSynthetic = SYNTHETIC.filter((item) => !only || only.includes(item.name));
const chosenRecorded = RECORDED.filter((item) => !only || only.includes(item.name));
const present = chosenRecorded.filter((item) => existsSync(fixturePath('filesystem', item.name)));
for (const item of chosenRecorded.filter((entry) => !present.includes(entry))) {
  for (const id of item.ids) {
    record(`${id} replay fixture missing: tests/fixtures/filesystem/${item.name}.json (record it with fs-real.mjs)`,
      false, 'no real recording yet');
  }
}
/** @brief 开回放窗口，依次跑选中的 synthetic 部分与已有的录制；数据目录用完删掉。 */
async function runAll() {
  await buildHarness();
  const dataDir = mkdtempSync(join(tmpdir(), 'mori-harness-fs-'));
  const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
    env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'), MORI_HARNESS_DATA: dataDir } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    for (const item of chosenSynthetic) await guarded(page, errors, item, () => item.run(page));
    for (const item of present) {
      const fx = readFixture('filesystem', item.name);
      await guarded(page, errors, item, () => item.run(page, fx));
    }
  } finally {
    await app.close();
    removeDir(dataDir);
  }
}

/** @brief 删掉一个临时目录；删不掉（窗口刚关、文件还被占着）时只记一条错误日志，不影响结果文件。 */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`Could not remove ${dir}: ${oneLine(error, 300)}`);
  }
}

if (chosenSynthetic.length || present.length) await runAll();
process.exitCode = write(only ? 'fs-partial-replay.json' : 'fs-replay.json') ? 0 : 1;
