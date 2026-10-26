// v1 模型层的回放测试（docs/specs/model-providers.md §14.1、§14.2 的回放层）：在 Electron 里载入真正的界面，用回放进程桥
// （tests/ui/harness）回放从真实会话录下的 tests/fixtures/v1/*.json（由 v1-models-record.mjs 录制，故障是真实的 401）。
// 测试像你一样操作（打开文件夹、发录制里的消息、在输入框下面一行选范围与思考强度、拒绝启动卡上的操作），回放桥核对界面
// 发出的每条命令都与录制一致；再按 docs/v1/screens/model-chat.md、model-menu.md、models-settings.md 检查界面。
// 2026-10-21 起范围按钮和 Effort 在输入框下面一行（docs/v0/composer-pickers.md）：按钮状态按那里"测试要改的地方"的 C1、C2
// 读（v1-models-row-helpers.mjs：不可用读 aria-disabled、切换中读 data-pending、悬停说明按行比较），菜单往上打开。各录制：
//   switch-start（MP-14）：第一个请求就 401，一行换模型提示、没有错误卡。
//   switch-mid（MP-15、MP-13）：段内换模型，提示带"The new model redoes this response."，被隐藏的过程仍显示；之后一直用第二个；
//     重启（恢复 key）后重新打开，提示仍在，下一段用回首选。
//   blocked（MP-09、MP-23）：会话范围所在的分组被删掉（2026-10-26 重录，原来是项目没授权公网）：发第一句、回答之后
//     出现 pick_missing 的拒绝启动卡，文字与按钮，发送不可用；"Change model…"打开的菜单；再建分组后卡消失、可以发送。
//   range（MP-23）："<范围名> · <当前模型 id>"、菜单的三节与底部说明、选提供商与模型、生成中不能改、重新打开后沿用；
//     换范围失败（回放桥 failNext 让 session.setPick 失败，synthetic）那一行从输入框下面一行往上弹出、10 秒后或打开菜单时消失。
//   thinking（MP-37，§14.4 取代 m6/thinking.json 的回放检查）：输入框下面一行的思考强度随当前模型，high 有思考、off 没有。
// 录制文件还不存在时，每个对应编号记一条失败"<编号> replay fixture missing"（不造假录制）。
// 写配置的 models.* 命令由回放桥直接应答、不占回放顺序（§14.4）；录制时它们经界面或 window.mori 直接发出，在 fixture 里
// 只有 { note } 步骤，它们引起的事件（mori.model_state 等）按录制的时间回放。
// 用法（在 app/ 下）：node tests/ui/v1-models-replay.mjs [--only switch-start,blocked]
//   --fixtures <目录>：只用来检查本测试自己——用别处录的 fixture（例如对合成端点录的）代替 tests/fixtures/v1，结果写到
//   test-results/v1-selfcheck-replay.json，不算进覆盖检查。
// 结果写到 test-results/v1-models-replay.json；截图在 test-results/v1-models-replay/。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { PANE, rowOf, settle, waitReady } from './m3-helpers.mjs';
import { expandSteps, foldSteps, pageHelpers, stepsState } from './page.mjs';
import {
  focusKind, NOTE, pickers, placeBrief, placeProblems, popupBox, rangeDescription, rangeMenuPlace,
} from './v1-models-row-helpers.mjs';

const only = arg('only')?.split(',');
const selfcheck = arg('fixtures') ? resolve(arg('fixtures')) : null;
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-v1');
const fixtureDir = selfcheck ? join(appRoot, 'test-results/v1-selfcheck-fixtures') : join(appRoot, 'tests/fixtures/v1');
const resultFile = selfcheck ? 'v1-selfcheck-replay.json' : 'v1-models-replay.json';
const shots = join(appRoot, 'test-results/v1-models-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(selfcheck ? `replay harness (selfcheck: ${selfcheck})` : 'replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 不支持思考的说明以外，§5.3 的原因文字（shared/models.ts REASON_TEXTS）里本测试用到的 */
const AUTH_TEXT = 'API key rejected';
const REDO = ' The new model redoes this response.';
const BUSY_TITLE = 'Can’t switch models until the response finishes';
const MENU_NOTE = 'Applies to this session only. New sessions use the default range from Settings.';
/** 思考强度的界面文字（models.md"思考强度"） */
const LEVEL_TEXT = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high',
  max: 'Max' };
/** synthetic：回放桥让下一条界面命令直接以这段原文失败（failNext，不占回放顺序），制造一次换范围失败 */
const PICK_FAILURE = 'Synthetic setPick failure (replay)';
/**
 * 本测试故意让命令失败时界面该写的错误日志（state/bridge.ts 的 console.error，异常分支照规定记错误日志）：每注入一次记一条，
 * "the page has no errors"只扣掉这些，多出来的照样算错
 */
const expectedErrors = [];

/** @brief 让回放桥的下一条界面命令以 PICK_FAILURE 失败（synthetic），并记下界面因此该写的那条错误日志。 */
async function failNextPick(page) {
  expectedErrors.push(`[renderer] session.setPick failed: ${PICK_FAILURE}`);
  await page.evaluate((message) => { window.__replay.failNext = message; }, PICK_FAILURE);
}

/** @brief errors 里去掉 expected 的每一条各一次（同一条出现得比预期多时，多的留下）。 */
function unexpectedErrors(errors, expected) {
  const left = [...errors];
  for (const text of expected) {
    const index = left.indexOf(text);
    if (index >= 0) left.splice(index, 1);
  }
  return left;
}

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** 拒绝启动卡按钮的顺序与文字（model-chat.md "拒绝启动卡"） */
const ACTION_ORDER = ['verify', 'change_model', 'open_settings'];
const ACTION_LABELS = { verify: 'Verify now', change_model: 'Change model…', open_settings: 'Open settings' };

// ---------- 录制 ----------

/** @brief 回放桥当作只读查询回答、不占回放顺序的命令：从 harness/replay.js 的 QUERIES 读，保证与回放桥一致。 */
function harnessQueries() {
  const text = readFileSync(join(harnessDir, 'replay.js'), 'utf8');
  const match = /const QUERIES = \[([^\]]*)\]/.exec(text);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}
const QUERIES = harnessQueries();

/** @brief 回放桥是否已按 §14.4 支持 v1：载入 fixtures/v1、models.get 与 session.pickOptions 是只读查询。 */
function harnessProblems() {
  const main = readFileSync(join(harnessDir, 'main.jsx'), 'utf8');
  return [...(main.includes("'../../fixtures/v1/*.json'") ? [] : ['harness/main.jsx does not load fixtures/v1']),
    ...['models.get', 'session.pickOptions'].filter((q) => !QUERIES.includes(q))
      .map((q) => `harness/replay.js does not answer ${q} as a read-only query`)];
}

/** @brief 读一个 v1 录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
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
const eventsOf = (steps, type) => steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);
/** @brief 一段里有正文的助手回复：实际模型与正文。 */
const repliesOf = (steps) => eventsOf(steps, 'message_end').map((e) => e.message)
  .filter((m) => m.role === 'assistant').map((m) => ({ ref: `${m.provider}/${m.model}`,
    text: m.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim(),
    thinking: m.content.some((c) => c.type === 'thinking' && c.thinking.trim()) }))
  .filter((m) => m.text);
/** @brief 一段里最后录下的 models.get 的配置。 */
const configOf = (steps) => resultsOf(steps, 'models.get').at(-1)?.config ?? null;
/** @brief 模型全名里的模型 id。 */
const modelId = (ref) => ref.slice(ref.indexOf('/') + 1);

/**
 * @brief 按 model-menu.md 的写法，范围按钮该显示的文字："<范围名> · <当前模型 id>"；范围是模型时只写模型 id；
 *        没有当前模型时只写范围名；没有范围时"No model range"。分组写 id，提供商写名称。
 */
function rangeText(pick, current, config) {
  if (!pick) return 'No model range';
  if (pick.includes('/')) return modelId(pick);
  const provider = config?.providers.find((item) => item.id === pick);
  const scope = provider ? provider.name : pick;
  return current ? `${scope} · ${modelId(current)}` : scope;
}

/**
 * @brief 范围按钮悬停的第二行（model-menu.md）：有当前模型时"<提供商名>"（2026-10-26 起不带区域），没有时
 *        "No model can run in this session"。
 */
function hoverLine2(current, config) {
  if (!current) return NOTE.noModel;
  const id = current.slice(0, current.indexOf('/'));
  const provider = config?.providers.find((item) => item.id === id);
  return provider?.name ?? id;
}

/** @brief 换模型提示的文字（model-chat.md）：原因是 auth 时"API key rejected"，有隐藏过程时加重做说明。 */
const switchText = (sw) => `Switched model: ${sw.from} → ${sw.to} · ${AUTH_TEXT}${sw.hidden ? REDO : ''}`;

// ---------- 页面 ----------

/** @brief 构建回放页面；--fixtures 时把 v1 的 glob 指到复制出的自检 fixture。 */
async function buildHarness() {
  const plugins = [react()];
  if (selfcheck) {
    rmSync(fixtureDir, { recursive: true, force: true });
    mkdirSync(fixtureDir, { recursive: true });
    for (const name of readdirSync(selfcheck).filter((n) => n.endsWith('.json'))) {
      copyFileSync(join(selfcheck, name), join(fixtureDir, name));
    }
    plugins.push({ name: 'v1-selfcheck-fixtures', enforce: 'pre', transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/harness/main.jsx')) return null;
      return code.replace("'../../fixtures/v1/*.json'", "'../../../test-results/v1-selfcheck-fixtures/*.json'");
    } });
  }
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins,
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 测试用的页面操作。 */
function helpers(page) {
  return {
    ...pageHelpers(page),
    /** @brief 载入录制文件（或它的一段），等侧栏读完会话列表；返回录制和这一段的步骤。 */
    async load(name, { part = null, speed = 4, maxGap = 600 } = {}) {
      const fx = readFixture(name);
      const index = pathToFileURL(join(outDir, 'index.html')).href;
      await page.goto(`${index}?fixture=${name}${part ? `&part=${part}` : ''}&speed=${speed}&maxGap=${maxGap}`);
      await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
      return { fx, steps: partOf(fx, part) };
    },
    /** @brief 点侧栏"打开文件夹…"（回放桥返回下一条 session.create 的文件夹），等会话面板出现。 */
    async openFolder() {
      await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…', exact: true }).click();
      await page.locator(PANE).waitFor({ timeout: 20000 });
    },
    status: () => page.evaluate(() => window.__replay.status),
    /**
     * @brief 输入框下面一行的范围按钮（pickers 的各项，按 C1、C2：unavailable、pending（data-pending）、tip 按行、
     *        described、inRow，另有 thinking），text 是按钮的完整文字（textContent；描述元素在按钮外面。读屏名里" · "
     *        换成了", "，不能从读屏名还原）。
     */
    button: () => pickers(page),
    /** @brief 换模型提示：文字与 data-*。 */
    notices: () => page.locator(`${PANE} [data-testid="notice"][data-kind="model-switch"]`).evaluateAll((items) => items
      .map((el) => ({ text: el.textContent, from: el.dataset.from, to: el.dataset.to, reason: el.dataset.reason,
        hidden: el.dataset.hidden === 'true' }))),
    count: (testId) => page.locator(`${PANE} [data-testid="${testId}"]`).count(),
    /** @brief 对话流里助手回复的正文（按顺序）。 */
    replies: () => page.locator(`${PANE} [data-testid="assistant"]`).evaluateAll((items) => items
      .map((el) => el.textContent.replace(/\s+/g, ' ').trim())),
  };
}

/**
 * @brief 开始用 MutationObserver 记下本栏的样子（范围按钮的 data-current、是否不可用（C1）与悬停说明，是否在运行，
 *        换模型提示、错误卡与说明卡的数量）；只在变化时记。watched 取回并停止。
 */
function watchPane(page) {
  return page.evaluate((pane) => {
    const seen = [];
    const take = () => {
      const root = document.querySelector(pane);
      const button = root?.querySelector('[data-testid="model-button"]');
      // buttonUnavailable 是范围按钮不可用（C1）；unavailable 是"模型不可用"说明卡的张数（两个不能同名，后者会盖掉前者）
      const now = { current: button?.dataset.current ?? null,
        buttonUnavailable: button
          ? button.getAttribute('aria-disabled') === 'true' && button.dataset.pending !== 'true' : null,
        title: button?.getAttribute('title') ?? null, running: root?.dataset.running ?? null,
        notices: root?.querySelectorAll('[data-testid="notice"][data-kind="model-switch"]').length ?? 0,
        errors: root?.querySelectorAll('[data-testid="error-card"]').length ?? 0,
        unavailable: root?.querySelectorAll('[data-testid="unavailable-card"]').length ?? 0 };
      const last = seen.at(-1);
      if (!last || Object.keys(now).some((key) => last[key] !== now[key])) seen.push(now);
    };
    const observer = new MutationObserver(take);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    take();
    window.__paneWatch = { seen, stop: () => observer.disconnect() };
  }, PANE);
}
const watched = (page) => page.evaluate(() => {
  window.__paneWatch.stop();
  return window.__paneWatch.seen;
});

/** @brief 等回放桥放完 total 段；出现不一致时立即报错。 */
async function untilPlayed(page, total, what) {
  await page.waitForFunction((v) => window.__replay.status.played >= v || window.__replay.status.errors.length > 0,
    total, { timeout: 180000 }).catch(() => { throw new Error(`Timed out waiting for ${what}`); });
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

/** @brief 发录制里的下一条消息并等这一轮结束。 */
async function sendRecorded(h, prompt, timeout = 180000) {
  await h.send(prompt.text);
  await h.idle(timeout);
}

// ---------- switch-start（MP-14） ----------

/** @brief 第一个请求就 401：同一个请求发给第二候选，一行换模型提示，没有错误卡。 */
async function switchStart(page, h) {
  const { steps } = await h.load('switch-start');
  const sw = eventsOf(steps, 'mori.model_switch')[0];
  const [prompt] = commandsOf(steps).filter((c) => c.type === 'session.prompt');
  await h.openFolder();
  await waitReady(page);
  await watchPane(page);
  await sendRecorded(h, prompt);
  const seen = await watched(page);
  const notices = await h.notices();
  await shot(page, 'switch-start');
  record(`MP-14 replay switch-start: the reply that starts with a rejected key shows one line "${switchText(sw)}" `
    + '(no redo note); data-from / data-to / data-reason match the recorded switch',
  notices.length === 1 && notices[0].text === switchText(sw) && notices[0].from === sw.from
    && notices[0].to === sw.to && notices[0].reason === 'auth' && !notices[0].hidden && !sw.hidden,
  JSON.stringify({ notices, recorded: sw }));
  record('MP-14 replay switch-start: no error card and no No model available card at any time during the reply',
    seen.every((s) => s.errors === 0 && s.unavailable === 0), JSON.stringify(seen.at(-1)));
  const want = repliesOf(steps).at(-1);
  const shown = (await h.replies()).at(-1) ?? '';
  record(`MP-14 replay switch-start: the answer from ${sw.to} is shown`, want?.ref === sw.to
    && shown.includes(want.text.replace(/\s+/g, ' ').slice(0, 40)), `${want?.ref}: ${oneLine(shown, 120)}`);
  await finish(page, 'MP-14', 'switch-start', steps);
}

// ---------- switch-mid（MP-15、MP-13） ----------

/**
 * @brief model-chat.md“被隐藏的过程”（2026-10-26 走查 M18，chat.md“步骤组”）：这一轮结束后，换模型之前那段的工具卡同别的
 *        组一样折进"{n} steps"（卡不显示、仍在页面里，换模型的一行照常显示）；点开那些行，卡都看得见；最后折回去。
 */
async function hiddenPartFolds(page, sw) {
  const folded = await stepsState(page, PANE);
  await expandSteps(page, PANE);
  const opened = await stepsState(page, PANE);
  await foldSteps(page, PANE);
  record(`MP-15 replay switch-mid: once the reply ends the tool cards of the hidden part (${sw.from} before the `
    + 'switch) fold into "<n> steps" rows like any other steps (model-chat.md, hidden work), the switch line stays '
    + 'shown; expanding the rows shows every card', folded.rows.length > 0
    && folded.rows.every((row) => row.expanded === 'false') && folded.cards.shown === 0 && folded.cards.hidden > 0
    && opened.cards.hidden === 0 && opened.cards.shown === folded.cards.hidden
    && (await page.locator(`${PANE} [data-testid="notice"][data-kind="model-switch"]`).first().isVisible()
      .catch(() => false)),
  JSON.stringify({ rows: folded.rows, folded: folded.cards, opened: opened.cards }));
}

/** @brief 段内换模型（重做）：提示带重做说明，被隐藏的过程仍显示；换过去以后这段一直用第二个。 */
async function switchMidBefore(page, h) {
  const { steps } = await h.load('switch-mid', { part: 'before' });
  const sw = eventsOf(steps, 'mori.model_switch')[0];
  const [prompt] = commandsOf(steps).filter((c) => c.type === 'session.prompt');
  const tools = new Set(eventsOf(steps, 'tool_execution_start').map((e) => e.toolCallId)).size;
  await h.openFolder();
  await waitReady(page);
  await watchPane(page);
  await sendRecorded(h, prompt, 300000);
  const seen = await watched(page);
  const notices = await h.notices();
  const cards = await h.count('tool-card');
  await shot(page, 'switch-mid-before');
  record(`MP-15 replay switch-mid: one line "${switchText(sw)}" with data-hidden="true"`, sw.hidden
    && notices.length === 1 && notices[0].text === switchText(sw) && notices[0].hidden, JSON.stringify({ notices }));
  record(`MP-15 replay switch-mid: the hidden part stays in the transcript: all ${tools} tool cards of the reply (also `
    + `those of ${sw.from} before the switch) are kept in the page (folded into the "<n> steps" row once the turn `
    + 'ends, chat.md step groups); no error card at any time', tools > 0 && cards === tools
    && seen.every((s) => s.errors === 0 && s.unavailable === 0), JSON.stringify({ cards, tools, last: seen.at(-1) }));
  const running = seen.filter((s) => s.running === 'true');
  const firstB = running.findIndex((s) => s.current === sw.to);
  record(`MP-13 replay switch-mid: the range button shows ${sw.from} first, then ${sw.to} after the switch, and `
    + `stays on ${sw.to} for the rest of the reply`, running.some((s) => s.current === sw.from) && firstB >= 0
    && running.slice(firstB).every((s) => s.current === sw.to),
  running.map((s) => s.current).filter((c, i, all) => c !== all[i - 1]).join(' → '));
  await hiddenPartFolds(page, sw);
  await finish(page, 'MP-15', 'switch-mid before the restart', steps);
}

/** @brief 重启（恢复首选的 key）后重新打开：提示仍在、过程仍显示；下一段用回首选，不另提示。 */
async function switchMidAfter(page, h) {
  const { fx, steps } = await h.load('switch-mid', { part: 'after' });
  const before = partOf(fx, 'before');
  const sw = eventsOf(before, 'mori.model_switch')[0];
  const open = commandsOf(steps).find((c) => c.type === 'session.open');
  const [prompt] = commandsOf(steps).filter((c) => c.type === 'session.prompt');
  const opened = resultsOf(steps, 'session.open')[0];
  await rowOf(page, open.sessionFile).click();
  await waitReady(page);
  const notices = await h.notices();
  const cards = await h.count('tool-card');
  record(`MP-15 replay switch-mid reopened: the switch line from the session file still reads "${switchText(sw)}" `
    + 'and the hidden part\'s tool cards are still in the page (folded into the steps row)', notices.length === 1
    && notices[0].text === switchText(sw)
    && notices[0].hidden && cards > 0, JSON.stringify({ notices, cards }));
  await watchPane(page);
  await sendRecorded(h, prompt);
  const seen = await watched(page);
  const after = await h.notices();
  const button = await h.button();
  const want = rangeText(opened.pick, sw.from, configOf(steps));
  await shot(page, 'switch-mid-after');
  record(`MP-13 replay back to first choice: the next reply runs on ${sw.from} again (range button "${want}" while it `
    + 'runs and after), no new switch line, no error card', seen.filter((s) => s.running === 'true')
    .every((s) => s.current === sw.from) && seen.some((s) => s.running === 'true') && button?.text === want
    && after.length === 1 && seen.every((s) => s.errors === 0) && repliesOf(steps).at(-1)?.ref === sw.from,
  JSON.stringify({ button, notices: after.length, currents: [...new Set(seen.map((s) => s.current))] }));
  await finish(page, 'MP-13', 'switch-mid after the restart', steps);
}

// ---------- blocked（MP-09、MP-23） ----------

/** @brief 拒绝启动卡此刻的样子：kind、标题、第二行、候选行、按钮。 */
const blockedCard = (page) => page.evaluate((pane) => {
  const card = document.querySelector(`${pane} [data-testid="blocked-card"]`)
    ?? document.querySelector('[data-testid="blocked-card"]');
  return card && { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? null,
    note: card.querySelector('.model-card-note')?.textContent ?? null,
    candidates: [...card.querySelectorAll('[data-testid="candidate"]')].map((el) => ({ ref: el.dataset.ref,
      reason: el.dataset.reason, text: el.textContent })),
    actions: [...card.querySelectorAll('button[data-action]')].map((el) => ({ action: el.dataset.action,
      text: el.textContent })) };
}, PANE);

/** @brief 菜单此刻的各项：范围、文字、是否变淡、悬停、是否打勾、所在的节与小节（Models 按提供商分小节）。 */
const menuItems = (page) => page.locator('[data-testid="model-menu"] [role="menuitemradio"]')
  .evaluateAll((items) => items.map((el) => ({ pick: el.dataset.pick,
    label: el.querySelector('.switch-text')?.textContent ?? el.textContent,
    excluded: el.dataset.excluded === 'true', title: el.getAttribute('title'),
    checked: el.getAttribute('aria-checked') === 'true', section: el.closest('[data-section]')?.dataset.section ?? null,
    group: el.closest('.model-group')?.getAttribute('aria-label') ?? null })));
/**
 * @brief 拒绝启动卡（pick_missing，2026-10-26 重录：会话范围所在的分组在设置里被删掉）：发第一句、回答之后卡出现；
 *        文字、第二行与按钮；发送不可用；Change model… 的菜单；录下的再建分组之后卡消失，第二句照常发出、回答。
 */
async function blockedCheck(page, h) {
  const { steps } = await h.load('blocked', { speed: 0.25, maxGap: 40000 });
  const created = resultsOf(steps, 'session.create')[0];
  const blocked = eventsOf(steps, 'mori.model_state').find((state) => state.blocked)?.blocked ?? null;
  const options = resultsOf(steps, 'session.pickOptions').at(-1)?.options ?? [];
  const [first, second] = commandsOf(steps).filter((c) => c.type === 'session.prompt');
  await h.openFolder();
  await waitReady(page);
  await sendRecorded(h, first);
  await page.locator(`${PANE} [data-testid="blocked-card"]`).waitFor({ timeout: 60000 });
  const card = await blockedCard(page);
  await shot(page, 'blocked-card');
  const wantActions = ACTION_ORDER.filter((a) => blocked?.actions.includes(a))
    .map((a) => ({ action: a.replace('_', '-'), text: ACTION_LABELS[a] }));
  record(`MP-09 replay blocked: after the group of the session's range is deleted the card reads "${created.pick} is `
    + 'not in your model settings." with the second line "Used by this session’s model range." and no candidates',
  blocked?.kind === 'pick_missing' && card?.kind === 'pick_missing'
    && card.title === `${created.pick} is not in your model settings.`
    && card.note === 'Used by this session’s model range.' && card.candidates.length === 0, JSON.stringify(card));
  const names = wantActions.map((a) => `"${a.text}"`).join(', ');
  record(`MP-09 replay blocked: the card's buttons are ${names} in this order`, wantActions.length === 2
    && JSON.stringify(card?.actions) === JSON.stringify(wantActions), JSON.stringify(card?.actions));
  const sent = (await h.status()).commands.length;
  await h.textarea.fill(second.text);
  await h.textarea.press('Enter');
  await sleep(500);
  record('MP-09 replay blocked: sending is unavailable: Enter sends nothing and the draft stays in the input',
    (await h.status()).commands.length === sent && await h.textarea.inputValue() === second.text,
    `commands ${sent} → ${(await h.status()).commands.length}`);
  await blockedButton(page, h, created, configOf(steps));
  await blockedMenu(page, options);
  await page.locator('[data-testid="blocked-card"]').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
  const gone = await page.locator('[data-testid="blocked-card"]').count() === 0;
  await h.textarea.fill(second.text);
  await h.textarea.press('Enter');
  await h.idle();
  const shown = (await h.replies()).at(-1) ?? '';
  const want = repliesOf(steps).at(-1);
  record('MP-09 replay blocked: once the recorded model state lifts the block (the group is created again) the card '
    + 'goes away and the message is sent and answered', gone && Boolean(want)
    && shown.includes(want.text.replace(/\s+/g, ' ').slice(0, 40)), `card gone ${gone}; ${oneLine(shown, 100)}`);
  await finish(page, 'MP-09', 'blocked', steps);
}

/**
 * @brief 被拒绝启动时输入框下面一行的范围按钮（chat.md"拒绝启动"、composer-pickers.md 新加的检查第 10 条）：在这一行里、
 *        能用；只写那个不存在的范围名，悬停两行与读屏的描述（没有当前模型）；输入框有字时"Send"仍不可用。
 */
async function blockedButton(page, h, created, config) {
  const bar = await h.button();
  const text = rangeText(created.pick, null, config);
  const line2 = hoverLine2(null, config);
  const send = await page.locator(`${PANE} .send-button`).isDisabled().catch(() => null);
  record(`MP-23 replay blocked: the range button in the message-box row stays usable while blocked: "${text}", hover `
    + `"${text}" / "${line2}", described as "${rangeDescription(line2)}"; Send is disabled with text typed`,
  Boolean(bar) && bar.inRow && !bar.inTopbar && bar.ariaDisabled === null && bar.text === text
    && same(bar.tip, [text, line2]) && bar.described === rangeDescription(line2) && send === true,
  JSON.stringify({ bar, send }));
}

/**
 * @brief Change model…：打开这一栏的范围菜单，项与录下的 session.pickOptions 相同（删掉的分组不在，没有打勾的项），
 *        底部说明与 Manage models；Esc 关上、焦点回到范围按钮。
 */
async function blockedMenu(page, options) {
  await page.locator(`${PANE} [data-testid="blocked-card"] [data-action="change-model"]`).click();
  const opened = await page.getByTestId('model-menu').waitFor({ timeout: 5000 }).then(() => true, () => false);
  const place = opened ? await rangeMenuPlace(page) : null;
  const items = opened ? await menuItems(page) : [];
  const note = opened ? await page.getByTestId('model-menu-note').innerText() : null;
  const manage = opened ? await page.locator('[data-testid="model-menu"] [data-action="manage-models"]').innerText()
    : null;
  await shot(page, 'blocked-menu');
  record('MP-23 replay blocked: "Change model…" opens the range menu with the recorded items (the deleted group is not '
    + 'there, nothing is ticked, an item is faded only when the recording says so); the note and "Manage models" are '
    + 'at the bottom', opened && items.length > 0 && items.length === options.length
    && items.every((item, i) => item.pick === options[i].pick && item.excluded === options[i].excluded
      && !item.checked) && note?.trim() === MENU_NOTE && manage?.trim() === 'Manage models',
  JSON.stringify({ items, note }));
  record('MP-23 replay blocked: that menu is the range menu of this pane\'s message-box row: it opens upward above the '
    + 'row, right-aligned with the range button, inside the pane and not over the top bar',
  place?.problems.length === 0, `${place?.problems.join('; ') ?? 'no menu'} ${placeBrief(place?.geo)}`);
  await page.keyboard.press('Escape');
  const gone = await page.getByTestId('model-menu').waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  const focus = await focusKind(page);
  record('MP-23 replay blocked: Esc closes the menu opened from the card and the focus is on the range button',
    opened && gone && focus === 'model-button', `menu gone ${gone}, focus ${focus}`);
}

// ---------- range（MP-23） ----------

/**
 * @brief 打开这一栏的范围菜单，选 pick 那一项；返回选之前菜单里的各项与底部说明，以及菜单打开后换范围失败那一行是否
 *        还在（errorLeft：打开菜单时它该消失）。
 */
async function choosePick(page, pick) {
  await page.locator(`${PANE} [data-testid="model-button"]`).click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  const items = await menuItems(page);
  items.note = await page.getByTestId('model-menu-note').innerText().catch(() => null);
  items.errorLeft = await page.locator(`${PANE} [data-testid="pick-error"]`)
    .waitFor({ state: 'detached', timeout: 1500 }).then(() => false, () => true);
  await page.locator(`[data-testid="model-menu"] [role="menuitemradio"][data-pick="${pick}"]`).click();
  return items;
}

/**
 * @brief 换范围失败那一行（models.md"菜单的位置与键盘"、composer-pickers.md 新加的检查第 4 条）：回放桥让 session.setPick
 *        失败一次（failNext，synthetic，不占回放顺序）；"Couldn’t change the model range: <原文>"（role="alert"）从这一行
 *        往上弹出、右边对齐范围按钮（放不下时挪进这一行）、最宽 min(320px, 这一行的宽)、在面板里，按钮仍是原来的范围；
 *        约 10 秒后自己消失。最后再让它失败一次、留着那一行（下一次打开菜单时该消失，由调用方检查）。
 * @param kept 失败后按钮该显示的范围（原来的 data-pick）
 */
async function pickErrorCheck(page, h, pick, kept) {
  const alert = page.locator(`${PANE} [data-testid="pick-error"]`);
  await failNextPick(page);
  await choosePick(page, pick);
  const shown = await alert.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const at = Date.now();
  await settle(page);
  const geo = shown ? await popupBox(page, '[data-testid="pick-error"]') : null;
  const text = shown ? (await alert.textContent())?.trim() : null;
  const role = shown ? await alert.getAttribute('role') : null;
  const button = await h.button();
  const problems = geo ? placeProblems(geo, { maxWidth: Math.min(320, geo.row?.width ?? 320) }) : ['no pick-error'];
  await shot(page, 'range-pick-error');
  record('MP-23 replay range: a failed session.setPick shows "Couldn’t change the model range: <message>" (role alert) '
    + 'popping up from the message-box row, right-aligned with the range button, at most 320px wide, inside the pane; '
    + 'the button keeps its range', text === `Couldn’t change the model range: ${PICK_FAILURE}` && role === 'alert'
    && problems.length === 0 && button?.pick === kept && !button.pending,
  `${text}; ${problems.join('; ')} ${placeBrief(geo)}; button ${button?.pick}`);
  await sleep(Math.max(0, at + 8000 - Date.now()));
  const stays = await alert.count() === 1;
  const gone = await alert.waitFor({ state: 'detached', timeout: 4000 }).then(() => true, () => false);
  record('MP-23 replay range: the failure line stays for about 10 s and then goes away by itself', stays && gone,
    `still there at 8 s ${stays}, gone by 12 s ${gone}`);
  await failNextPick(page);
  await choosePick(page, pick);
  return alert.waitFor({ timeout: 5000 }).then(() => true, () => false);
}

/** @brief 选范围：新会话的范围、菜单、选提供商、生成中不能改、选模型。 */
async function rangeBefore(page, h) {
  const { steps } = await h.load('range', { part: 'before' });
  const config = configOf(steps);
  const created = resultsOf(steps, 'session.create')[0];
  const picks = commandsOf(steps).filter((c) => c.type === 'session.setPick');
  const picked = resultsOf(steps, 'session.setPick');
  const prompts = commandsOf(steps).filter((c) => c.type === 'session.prompt');
  const options = resultsOf(steps, 'session.pickOptions')[0]?.options ?? [];
  await h.openFolder();
  await waitReady(page);
  const first = await h.button();
  record(`MP-23 replay range: a new session shows "${rangeText(created.pick, created.current, config)}" (its range is `
    + 'the default from Settings)', first?.text === rangeText(created.pick, created.current, config)
    && first.pick === created.pick && first.current === created.current, JSON.stringify(first));
  const failed = await pickErrorCheck(page, h, picks[0].pick, created.pick);
  const items = await choosePick(page, picks[0].pick);
  record('MP-23 replay range: after another failed session.setPick, opening the range menu clears the failure line',
    failed && !items.errorLeft, `failure line shown ${failed}, still there with the menu open ${items.errorLeft}`);
  menuShape(items, options, created.pick, config);
  await page.waitForFunction(({ pane, pick }) => document.querySelector(`${pane} [data-testid="model-button"]`)
    ?.dataset.pick === pick, { pane: PANE, pick: picks[0].pick }, { timeout: 15000 }).catch(() => {});
  const second = await h.button();
  const wantSecond = rangeText(picked[0].pick, picked[0].current, config);
  record(`MP-23 replay range: choosing a provider sends session.setPick and the button reads "${wantSecond}"`,
    second?.text === wantSecond && second.current === picked[0].current, JSON.stringify(second));
  await h.send(prompts[0].text);
  await page.waitForFunction((pane) => document.querySelector(pane)?.dataset.running === 'true', PANE,
    { timeout: 20000 }).catch(() => {});
  const busy = await h.button();
  record(`MP-23 replay range: while generating the button stays usable (2026-10-26: not aria-disabled, it opens the `
    + `menu to switch task mode) and hover line 3 says "${BUSY_TITLE}"`, busy?.unavailable === false
    && busy.tip[2] === BUSY_TITLE, JSON.stringify(busy));
  record(`MP-23 replay range: while generating the range button stays focusable, hover line 1 is its text, the `
    + `description ends with ". ${BUSY_TITLE}"; Effort is unavailable with "${NOTE.effortBusy}" as line 2 and `
    + 'description', Boolean(busy) && !busy.disabled && busy.tip[0] === busy.text
    && busy.described === rangeDescription(busy.tip[1] ?? '', BUSY_TITLE) && busy.thinking?.unavailable === true
    && busy.thinking.tip[1] === NOTE.effortBusy && busy.thinking.described === NOTE.effortBusy,
  JSON.stringify({ tip: busy?.tip, described: busy?.described, thinking: busy?.thinking }));
  await h.idle();
  await choosePick(page, picks[1].pick);
  await page.waitForFunction(({ pane, pick }) => document.querySelector(`${pane} [data-testid="model-button"]`)
    ?.dataset.pick === pick, { pane: PANE, pick: picks[1].pick }, { timeout: 15000 }).catch(() => {});
  const third = await h.button();
  record(`MP-23 replay range: choosing a model makes it the range; the button reads just "${modelId(picks[1].pick)}"`,
    third?.text === modelId(picks[1].pick) && third.pick === picks[1].pick, JSON.stringify(third));
  await sendRecorded(h, prompts[1]);
  await shot(page, 'range-before');
  await finish(page, 'MP-23', 'range before the restart', steps);
}

/** @brief 菜单的三节、项的文字、Models 按提供商分小节、当前范围打勾、底部说明（2026-10-26 起没有区域标记）。 */
function menuShape(items, options, pick, config) {
  const sections = { group: 'groups', provider: 'providers', model: 'models' };
  const providerName = (ref) => config?.providers.find((p) => p.id === ref.slice(0, ref.indexOf('/')))?.name ?? null;
  const want = options.map((o) => ({ pick: o.pick, label: o.label, section: sections[o.kind],
    group: o.kind === 'model' ? providerName(o.pick) : null, checked: o.pick === pick }));
  const got = items.map((item) => ({ pick: item.pick, label: item.label.trim(),
    section: item.section, group: item.group, checked: item.checked }));
  record('MP-23 replay range: the menu lists Groups, Providers and Models (group id, provider name, model id under its '
    + `provider's name; the current range ticked) and ends with "${MENU_NOTE}"`,
  JSON.stringify(got) === JSON.stringify(want) && items.note?.trim() === MENU_NOTE,
  JSON.stringify({ got, want, note: items.note }));
}

/** @brief 重启后打开：范围沿用（会话文件里的 mori.pick）。 */
async function rangeAfter(page, h) {
  const { steps } = await h.load('range', { part: 'after' });
  const open = commandsOf(steps).find((c) => c.type === 'session.open');
  const opened = resultsOf(steps, 'session.open')[0];
  await rowOf(page, open.sessionFile).click();
  await waitReady(page);
  const button = await h.button();
  record(`MP-23 replay range reopened: the session keeps its range "${opened.pick}" (button "${modelId(opened.pick)}")`,
    button?.pick === opened.pick && button.text === rangeText(opened.pick, opened.current, configOf(steps)),
    JSON.stringify(button));
  await finish(page, 'MP-23', 'range after the restart', steps);
}

// ---------- thinking（MP-37） ----------

/** @brief 输入框下面一行的思考强度：新会话按模型的默认，菜单的强度取当前模型；high 有思考，off 没有。 */
async function thinkingCheck(page, h) {
  const { steps } = await h.load('thinking');
  const created = resultsOf(steps, 'session.create')[0];
  const levels = commandsOf(steps).filter((c) => c.type === 'session.setThinking').map((c) => c.level);
  const prompts = commandsOf(steps).filter((c) => c.type === 'session.prompt');
  const replies = repliesOf(steps);
  await h.openFolder();
  await waitReady(page);
  const button = page.locator(`${PANE} [data-testid="thinking-button"]`);
  const start = { level: await button.getAttribute('data-level'),
    reasoning: await button.getAttribute('data-reasoning') };
  const effort = (await h.button())?.thinking ?? null;
  const label = `Effort: ${LEVEL_TEXT[created.thinkingLevel] ?? created.thinkingLevel}`;
  record(`MP-37 replay thinking: the Effort button is in the message-box row: "${label}", hover "${label}" / `
    + `"${NOTE.effort}", described by line 2, no aria-disabled while usable`, Boolean(effort) && effort.inRow
    && !effort.inTopbar && effort.name === label && effort.text === label && same(effort.tip, [label, NOTE.effort])
    && effort.described === NOTE.effort && effort.ariaDisabled === null, JSON.stringify(effort));
  await button.click();
  await page.getByTestId('thinking-menu').waitFor({ timeout: 5000 });
  const offered = await page.locator('[data-testid="thinking-menu"] [role="menuitemradio"]')
    .evaluateAll((items) => items.map((el) => el.dataset.level));
  record(`MP-37 replay thinking: a new session on ${created.current} starts at "${created.thinkingLevel}" and the menu `
    + 'offers that model\'s levels', start.level === created.thinkingLevel && start.reasoning === 'true'
    && JSON.stringify(offered) === JSON.stringify(created.thinkingLevels), JSON.stringify({ start, offered }));
  const thinkingBlocks = [];
  for (const [i, level] of levels.entries()) {
    if (i > 0) await button.click();
    await page.locator(`[data-testid="thinking-menu"] [role="menuitemradio"][data-level="${level}"]`).click();
    await page.waitForFunction(({ pane, want }) => document.querySelector(`${pane} [data-testid="thinking-button"]`)
      ?.dataset.level === want, { pane: PANE, want: level }, { timeout: 15000 });
    await sendRecorded(h, prompts[i]);
    thinkingBlocks.push(await page.locator(`${PANE} [data-testid="assistant"]`).last().locator('details.thinking')
      .count());
  }
  await shot(page, 'thinking');
  record(`MP-37 replay thinking: at "${levels[0]}" the reply shows a thinking block, at "${levels[1]}" it does not `
    + '(as recorded)', replies[0]?.thinking === true && replies[1]?.thinking === false && thinkingBlocks[0] > 0
    && thinkingBlocks[1] === 0, JSON.stringify({ thinkingBlocks, recorded: replies.map((r) => r.thinking) }));
  await finish(page, 'MP-37', 'thinking', steps);
}

// ---------- 执行 ----------

/** 每个录制：名字、覆盖的编号、检查（一个录制可以分重启前后两段） */
const FIXTURES = [
  { name: 'switch-start', ids: ['MP-14'], checks: [switchStart] },
  { name: 'switch-mid', ids: ['MP-15', 'MP-13'], checks: [switchMidBefore, switchMidAfter] },
  { name: 'blocked', ids: ['MP-09', 'MP-23'], checks: [blockedCheck] },
  { name: 'range', ids: ['MP-23'], checks: [rangeBefore, rangeAfter] },
  { name: 'thinking', ids: ['MP-37'], checks: [thinkingCheck] },
];

const chosen = FIXTURES.filter((f) => !only || only.includes(f.name));
const present = chosen.filter((f) => existsSync(join(selfcheck ?? fixtureDir, `${f.name}.json`)));
for (const f of chosen.filter((item) => !present.includes(item))) {
  for (const id of f.ids) {
    record(`${id} replay fixture missing: tests/fixtures/v1/${f.name}.json (record it with v1-models-record.mjs)`,
      false,
      'no real recording yet; spec §14.1 needs the owner\'s data dir with two real providers');
  }
}
const problems = harnessProblems();
if (present.length && problems.length) {
  for (const f of present) {
    for (const id of f.ids) record(`${id} replay harness supports v1 (§14.4)`, false, problems.join('; '));
  }
} else if (present.length) {
  await buildHarness();
  const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
    env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
      MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-v1-')) } });
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
  const h = helpers(page);
  for (const f of present) {
    const errorsBefore = pageErrors.length;
    for (const check of f.checks) {
      try {
        await check(page, h);
      } catch (error) {
        record(`${f.ids[0]} replay ${f.name} (${check.name}): flow`, false, oneLine(error, 400));
        await shot(page, `${check.name}-error`);
      }
    }
    const errors = unexpectedErrors(pageErrors.slice(errorsBefore), expectedErrors.splice(0));
    record(`${f.ids[0]} replay ${f.name}: the page has no errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
  }
  await app.close();
}
process.exitCode = write(resultFile) ? 0 : 1;
