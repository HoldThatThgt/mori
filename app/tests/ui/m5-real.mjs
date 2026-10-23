// M5 真实端点走查（方案第 7 节 M5 走查 1–6 与反例），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 状态表见 docs/v0/screens/split.md 与 session-refs.md。脚本不接触 key：只把走查数据目录里 Mori 加密保存的密文
// （credentials.json 与 Local State）复制到临时目录，整个走查（包括重启）都用这一个复制出来的数据目录。
// 像负责人一样操作界面：用鼠标把会话行拖到中栏右半边、拖进输入框，两栏里各自发消息、Alt+1，点另一栏切焦点、Esc、F8，
// 拖分屏中线，预览里改范围，点发出的引用，改名、重启、删除；走查 6 只用右键菜单。
// 系统的选文件夹对话框经 app.evaluate 换成直接返回测试文件夹。只删测试数据目录里的测试会话。
// 2026-10-21 起（docs/v0/composer-pickers.md）：分屏后两栏的输入框下面一行（真实的选择范围"<分组> · <模型 id>"）放得下；
// F8 报告"Current view"的"Model range""Effort""Pane width"。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m5-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,3,4,5,6,c]
// 结果写到 test-results/m5-real(-packaged).json，截图在 test-results/m5-real(-packaged)/。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  allowRealProject, appRoot, arg, createRecorder, launch, oneLine, realProviders, scratchUserData, sleep,
} from './lib.mjs';
import { composerRow, rowProblems, rowSummary } from './m1-layout.mjs';
import { rowOf, stubFolder, waitReady, waitStatus } from './m3-helpers.mjs';
import {
  centerPoint, chipsAt, composerAt, dragWithHint, flashedAt, headingWhole, paneAt, paneView, pickRange,
  previewHeading, previewState, reportField, reportLabels, sendAt, sentSessionRefs, slotSelector, splitState,
  viewProblems, waitPaneIdle, waitPaneReady, waitPreview, waitSessionChip, waitSplit,
} from './m5-helpers.mjs';

const source = arg('source');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/m5-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const wanted = (item) => !only || only.includes(String(item));
const UI_WORDS = ['Copy', 'Attach message as context', 'Give feedback', 'Thought process', 'Thinking…', 'Running…',
  'Waiting for your approval', 'Stopped', 'open preview'];

const PROMPTS = {
  introA: '用一句话介绍你自己。不要调用任何工具。',
  introB: '用一句话说说今天适合做什么。不要调用任何工具。',
  editLeft: '请用 edit 工具把 README.md 的第一行改成 "# Mori M5 左栏"。不要运行命令，改完用一句话告诉我。',
  writeRight: '请用 write 工具新建 notes.md，内容只有一行 "Mori M5 右栏"。不要运行命令，写完用一句话告诉我。',
  sleep: '请运行命令 `sleep 37`，然后告诉我它的输出。',
  longer: '不要调用任何工具。请写五段文字，每段四到五句话：第一段讲春天，第二段讲夏天，第三段讲秋天，'
    + '第四段讲冬天，第五段讲四季轮回给人的启发。',
  turns: [
    '用一句话介绍你自己。不要调用任何工具。',
    '请读取 README.md，然后用一句话说明它的内容。',
    '我们来讨论一个小功能：给 src/a.ts 加一个减法函数。先用两句话说说思路，不要调用任何工具。',
    '函数名用 sub 还是 subtract 好？一句话回答，不要调用任何工具。',
    '参数要不要做类型检查？一句话回答，不要调用任何工具。',
    '好的，用一句话总结我们定下来的做法。不要调用任何工具。',
  ],
  askRef: '根据上面引用的讨论，用一句话说明我们定下来的函数名。不要调用任何工具。',
  askMenu: '用一句话概括引用的内容。不要调用任何工具。',
};

/** @brief 测试项目：README.md 和 src/a.ts。 */
function makeProject(root) {
  const project = join(root, 'm5-walk');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used to check Mori against a '
    + 'model.\n\n- It has one README file.\n- It has one source file in src/.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return project;
}

/** @brief 启动 Mori（连接已在走查数据目录里），等侧栏读完。 */
async function start(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 60000 });
  await sleep(1500);
}

/** @brief 重启：关掉窗口（Mori 有序退出），再用同一个数据目录启动。 */
async function restart(ctx) {
  const exited = new Promise((done) => ctx.app.process().once('exit', () => done(true)));
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  if (!await Promise.race([exited, sleep(20000).then(() => false)])) await ctx.app.close().catch(() => {});
  await start(ctx);
}

/** @brief 当前会话行的会话文件。 */
const activeFile = (page) => page.locator('.session-item.active').first().getAttribute('data-file');

/** @brief Ctrl+N 新建会话，等它就绪，返回它的会话文件。 */
async function newSession(page) {
  const before = await page.locator('.pane-slot').count();
  await page.keyboard.press('Control+n');
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, before, { timeout: 30000 });
  await waitPaneReady(page, 'focused');
  return activeFile(page);
}

/** @brief 在某一栏发一条消息；出批准卡就在那一栏按 Alt+1；等这一栏本轮结束。 */
async function sendIn(page, side, text) {
  await sendAt(page, side, text);
  await approveUntilIdle(page, [side]);
}

/** @brief 等这些栏都结束；途中哪一栏出批准卡，就点那一栏的输入框按 Alt+1（编辑、写入、命令都允许）。 */
async function approveUntilIdle(page, sides, timeout = 300000) {
  const deadline = Date.now() + timeout;
  await sleep(1500);
  while (Date.now() < deadline) {
    const state = await splitState(page);
    const busy = sides.filter((side) => state.slots.find((slot) => slot.side === side)?.running);
    if (busy.length === 0) break;
    for (const side of busy) {
      if (await paneAt(page, side).getByTestId('approval-card').count() === 0) continue;
      await composerAt(page, side).click();
      await composerAt(page, side).press('Alt+1');
    }
    await sleep(500);
  }
  for (const side of sides) await waitPaneIdle(page, side, 30000);
}

/** @brief 某一栏最后一张标题以 verb 开头、对象含 target 的工具卡的状态。 */
const cardStatus = (page, side, verb, target) => paneAt(page, side).locator('[data-testid="tool-card"]')
  .filter({ has: page.locator('.tool-verb', { hasText: verb }) })
  .filter({ has: page.locator('.tool-target', { hasText: target }) }).last()
  .getAttribute('data-status', { timeout: 5000 }).catch(() => null);

/** @brief 打开测试项目（会话 A），各建一个会话 B，两边各发一句。 */
async function prepare(ctx) {
  const { page } = ctx;
  await stubFolder(ctx.app, ctx.project);
  await page.getByRole('button', { name: 'Open folder…' }).first().click();
  await waitReady(page);
  await sendIn(page, 'single', PROMPTS.introA);
  ctx.a = await activeFile(page);
  ctx.b = await newSession(page);
  await sendIn(page, 'single', PROMPTS.introB);
}

/** @brief 走查 1：把 B 拖到 A 的右侧；两边各自发消息、各自批准。 */
async function item1(ctx) {
  const { page } = ctx;
  await prepare(ctx);
  await rowOf(page, ctx.a).first().click();
  await waitPaneReady(page, 'single');
  const hint = await dragWithHint(page, rowOf(page, ctx.b).first(), page.locator('.center'),
    await centerPoint(page, 'right'));
  await waitSplit(page);
  const state = await splitState(page);
  await shot(page, '1-split');
  await splitRows(page);
  await sendAt(page, 'left', PROMPTS.editLeft);
  await sendAt(page, 'right', PROMPTS.writeRight);
  await approveUntilIdle(page, ['left', 'right']);
  const cards = { left: await cardStatus(page, 'left', 'Edit', 'README.md'),
    right: await cardStatus(page, 'right', 'Write', 'notes.md') };
  const readme = readFileSync(join(ctx.project, 'README.md'), 'utf8');
  record('走查 1：把会话 B 拖到 A 的右侧：放下前提示"松开以在右侧分屏打开"；松开后左 A、右 B 分屏，B 有焦点',
    hint?.text === 'Drop to open in split view on the right' && state.split && state.slots[1].focused
    && state.slots.length === 2,
    JSON.stringify({ hint, slots: state.slots.map((s) => [s.side, s.title, s.focused]) }));
  record('走查 1：两边各自发消息、各自出批准卡并在自己那一栏按 Alt+1 允许：左栏改了 README.md，右栏写了 notes.md',
    cards.left === 'done' && cards.right === 'done' && readme.startsWith('# Mori M5 左栏')
    && existsSync(join(ctx.project, 'notes.md')), JSON.stringify({ cards, readme: oneLine(readme, 40) }));
  await shot(page, '1-both');
}

/**
 * @brief 分屏后两栏的输入框下面一行（chat.md"输入框下面一行"、models.md"窄栏"）：权限、真实的选择范围（分组时
 *        "<分组> · <模型 id>"，常比 200px 的上限长）、Effort、圆环、"Send"不换行、不超出输入框，按这一栏的宽度收紧、
 *        截短的先后对（先截模型 id、再截范围名），读屏名和悬停第一行是全文，悬停第二行是"<提供商名> · <区域>"。
 */
async function splitRows(page) {
  const bad = [];
  for (const side of ['left', 'right']) {
    const row = await composerRow(page, slotSelector(side));
    bad.push(...rowProblems(row, 'idle').map((problem) => `${side} ${rowSummary(row)}: ${problem}`));
  }
  record('走查 1：分屏后两栏的输入框下面一行（权限、真实的选择范围、Effort、圆环、发送）放得下，按这一栏的宽度收紧',
    bad.length === 0, bad.join('; '));
}

/** @brief 走查 2：左栏的长命令在右栏生成时按 Esc，只停止左栏；右栏和 F8 跟随焦点。 */
async function item2(ctx) {
  const { page } = ctx;
  await sendAt(page, 'left', PROMPTS.sleep);
  await paneAt(page, 'left').getByTestId('approval-card').waitFor({ timeout: 120000 });
  await composerAt(page, 'left').press('Alt+1');
  const before = await paneAt(page, 'right').getByTestId('assistant').count();
  await sendAt(page, 'right', PROMPTS.longer);
  // 等右栏这一次的回复（发出后新出现的最后一条助手消息）有 40 字以上再按 Esc。不能用 querySelector 加
  // :last-of-type：它取文档里第一条不带回复操作行的助手消息（走查 1 里写 notes.md 那一轮的工具消息），
  // 那条不到 40 字时一直等到超时，左栏的 sleep 37 早已跑完，Esc 就没有可停的了
  await page.waitForFunction((count) => {
    const all = document.querySelectorAll('.pane-slot[data-side="right"] [data-testid="assistant"]');
    return all.length > count && all[all.length - 1].textContent.length > 40;
  }, before, { timeout: 120000 }).catch(() => {});
  await composerAt(page, 'left').click();
  await page.keyboard.press('Escape');
  await waitPaneIdle(page, 'left', 60000);
  const rightRunning = (await splitState(page)).slots[1].running;
  await waitPaneIdle(page, 'right', 240000);
  const notices = async (side) => paneAt(page, side).getByTestId('notice').allInnerTexts();
  const left = await notices('left');
  const right = await notices('right');
  record('走查 2：在左栏按 Esc 只停止左栏（命令卡和"已停止"）；右栏这时还在生成、之后照常写完', left.some((t) =>
    t.startsWith('Stopped')) && rightRunning && !right.some((t) => t.startsWith('Stopped')),
  JSON.stringify({ left, right, rightRunning }));
  await followFocus(ctx);
}

/** @brief 走查 2 后半：右栏和 F8 跟随焦点所在的一栏。 */
async function followFocus(ctx) {
  const { page } = ctx;
  const panel = () => page.getByTestId('right-panel').innerText({ timeout: 3000 }).catch(() => '');
  await paneAt(page, 'left').getByTestId('transcript').click({ position: { x: 10, y: 10 } });
  await sleep(300);
  const onLeft = await panel();
  await paneAt(page, 'right').getByTestId('transcript').click({ position: { x: 10, y: 10 } });
  await sleep(300);
  const onRight = await panel();
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('issue-what').fill('M5 走查：分屏时 F8');
  await page.getByTestId('issue-dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('issue-saved').waitFor({ timeout: 10000 });
  await shot(page, '2-f8');
  await page.keyboard.press('Escape');
  const dir = join(ctx.userData, 'ui-issues');
  const report = readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(dir, name),
    'utf8')).at(-1) ?? '';
  const right = (await splitState(page)).slots[1].title;
  record('走查 2：右栏跟随焦点所在的一栏（左栏 README.md，右栏 notes.md）', onLeft.includes('README.md')
    && !onLeft.includes('notes.md') && onRight.includes('notes.md') && !onRight.includes('README.md'),
  JSON.stringify({ onLeft: oneLine(onLeft, 80), onRight: oneLine(onRight, 80) }));
  record('走查 2：F8 跟随焦点：报告的"当前会话"是右栏，"分屏"一行写明焦点在右栏', report.includes(`Current session: ${right}`)
    && report.includes('(focus in the right pane)'),
  oneLine(report.split('\n').filter((l) => /Current session|Split view/.test(l)).join(' | ')));
  const view = await paneView(page, 'right');
  const problems = viewProblems((label) => reportField(report, label), reportLabels(report), view, 'right');
  record('走查 2：F8 的"Current view"里"Model range""Model""Effort"是右栏的，"Pane width"是右栏 .chat-pane 的宽'
    + '（比 .pane-slot 窄 1px），三项的位置对', problems.length === 0, `${problems.join('; ')} ${JSON.stringify(view)}`);
}

/** @brief 走查 3：拖动分屏中线调整比例（先关掉右栏给两栏腾出地方），双击恢复各一半。 */
async function item3(ctx) {
  const { page } = ctx;
  if (await page.getByTestId('right-panel').count()) {
    await page.getByTestId('right-panel').getByRole('button', { name: 'Close panel' }).first().click();
  }
  await sleep(300);
  const handle = page.locator('[data-resize="split"]');
  const before = await splitState(page);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + 250, { steps: 8 });
  await page.mouse.up();
  const after = await splitState(page);
  await shot(page, '3-divider');
  await handle.dblclick();
  const reset = await splitState(page);
  record('走查 3：拖动分屏中线，左栏变宽约 150px，右栏相应变窄；双击恢复各一半', Math.abs(after.slots[0].width
    - before.slots[0].width - 150) <= 3 && after.slots[1].width < before.slots[1].width
    && Math.abs(reset.slots[0].width - reset.slots[1].width) <= 2, JSON.stringify({ before: before.slots.map((s) => s.width),
    after: after.slots.map((s) => s.width), reset: reset.slots.map((s) => s.width) }));
}

/** @brief 走查 4：建会话 C（6 轮），把 C 拖进 A 的输入框，预览按轮、改成第 3–5 轮后发出。 */
async function item4(ctx) {
  const { page } = ctx;
  await paneAt(page, 'right').getByTestId('close-pane').click();
  await waitSplit(page, false);
  ctx.c = await newSession(page);
  for (const text of PROMPTS.turns) await sendIn(page, 'single', text);
  await rowOf(page, ctx.a).first().click();
  await waitPaneReady(page, 'single');
  const hint = await dragWithHint(page, rowOf(page, ctx.c).first(), page.locator('.pane-slot[data-focused="true"]'
    + ' [data-drop="composer"]'));
  const chip = await waitSessionChip(page, 'focused');
  await page.locator('.pane-slot[data-focused="true"] [data-kind="session"] .quote-chip-main').click();
  await waitPreview(page);
  const preview = await previewState(page);
  const heading = await previewHeading(page);
  await shot(page, '4-preview');
  record('走查 4：轮次列表占满预览对话框时，标题"Context · <会话名>"完整显示，只有一行、没有被压矮',
    Boolean(heading?.listFull) && headingWhole(heading), JSON.stringify(heading));
  const words = UI_WORDS.filter((word) => preview.turns.some((turn) => turn.text.includes(word)));
  record('走查 4：把会话 C 拖进输入框：提示"松开以引用到这个会话"，芯片"引用 · C · 第 1–6 轮 · 约 X 字"',
    hint?.text === 'Drop to attach as context' && /· turns 1–6 · ~[\d,]+ characters$/.test(chip),
    JSON.stringify({ hint, chip }));
  record('走查 4：预览按"第 N 轮"标出内容和总字数；工具调用只有一行标题；反例：没有按钮文字等界面文字',
    preview.turns.length === 6 && preview.turns.every((t) => t.heading.startsWith(`Turn ${t.number} · ~`))
    && /^~[\d,]+ characters$/.test(preview.total ?? '') && words.length === 0
    && /\n\[Tool\] [^\n]+/.test(preview.turns[1].text), JSON.stringify({ words, turn2: preview.turns[1]?.text }));
  await pickRange(page, 3, 5);
  await page.getByTestId('ref-preview').getByRole('button', { name: 'Done' }).click();
  const after = await waitSessionChip(page, 'focused');
  await sendIn(page, 'single', PROMPTS.askRef);
  const reply = await paneAt(page, 'single').getByTestId('assistant').last().innerText();
  record('走查 4：改成第 3–5 轮后发出：芯片"第 3–5 轮"；模型按引用的讨论回答了函数名', after.includes('· turns 3–5 ·')
    && /sub/i.test(reply), JSON.stringify({ after, reply: oneLine(reply, 120) }));
  await shot(page, '4-sent');
}

/** @brief 点发出的引用，等原会话的几轮高亮，返回高亮的你的消息和那一栏的会话名。 */
async function clickSentRef(page) {
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').last().click();
  await page.waitForFunction(() => document.querySelectorAll('.pane-slot[data-focused="true"] .jump-flash').length > 0,
    null, { timeout: 30000 });
  return { flashed: await flashedAt(page, 'focused'), title: (await splitState(page)).focusedTitle };
}

/** @brief 走查 5：点引用跳回 C；C 改名后（含重启后）仍有效；C 删除后显示"Session deleted"，原文仍可查看。 */
async function item5(ctx) {
  let { page } = ctx;
  const first = await clickSentRef(page);
  await shot(page, '5-jump');
  record('走查 5：点消息里的引用跳回 C，第 3–5 轮高亮（3 条你的消息）', first.flashed.users.length === 3
    && first.flashed.users[0].startsWith('我们来讨论'), JSON.stringify(first));
  await rowOf(page, ctx.c).first().click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByTestId('rename-input').fill('减法函数的讨论');
  await page.getByTestId('rename-input').press('Enter');
  await restart(ctx);
  page = ctx.page;
  await rowOf(page, ctx.a).first().click();
  await waitPaneReady(page, 'single');
  const sent = await sentSessionRefs(page, 'single');
  const second = await clickSentRef(page);
  record('走查 5：C 改名、重启 Mori 后，引用显示新名字，点它仍跳回 C 并高亮第 3–5 轮', sent.at(-1)?.label
    .startsWith('Context · 减法函数的讨论 · turns 3–5') && second.title === '减法函数的讨论'
    && second.flashed.users.length === 3, JSON.stringify({ sent: sent.at(-1)?.label, second }));
  await rowOf(page, ctx.c).first().click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByTestId('delete-dialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByTestId('delete-dialog').waitFor({ state: 'detached', timeout: 15000 });
  await rowOf(page, ctx.a).first().click();
  await waitPaneReady(page, 'single');
  const gone = (await sentSessionRefs(page, 'single')).at(-1);
  await page.locator('.pane-slot[data-focused="true"] [data-testid="sent-quote"][data-kind="session"]').last().click();
  await page.getByTestId('ref-preview').waitFor({ timeout: 5000 });
  const stored = await previewState(page);
  await shot(page, '5-deleted');
  await page.keyboard.press('Escape');
  record('走查 5：C 删除后引用标"原会话已删除"，点它仍能看到引用时的原文（第 3–5 轮）', gone?.status === 'Session deleted'
    && stored.notes.includes('Session deleted · Showing the attached text') && stored.stored?.startsWith('Turn 3')
    && !existsSync(ctx.c), JSON.stringify({ gone, notes: stored.notes }));
}

/** @brief 走查 6：只用右键菜单完成同样的分屏和引用。 */
async function item6(ctx) {
  const { page } = ctx;
  await rowOf(page, ctx.b).first().click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: 'Open in split view' }).click();
  await waitSplit(page);
  const state = await splitState(page);
  await composerAt(page, 'left').click();
  await rowOf(page, ctx.b).first().click({ button: 'right' });
  await page.getByTestId('session-menu').getByRole('menuitem', { name: 'Attach as context' }).click();
  const chip = await waitSessionChip(page, 'left');
  await sendIn(page, 'left', PROMPTS.askMenu);
  const sent = await sentSessionRefs(page, 'left');
  record('走查 6：右键菜单"在右侧分屏打开"：B 在右栏分屏打开并得到焦点', state.split && state.slots[1].focused
    && state.slots[1].title === await rowOf(page, ctx.b).first().locator('.session-label').innerText(),
  JSON.stringify(state.slots));
  record('走查 6：右键菜单"引用到当前会话"：焦点所在的左栏输入框出现 B 的引用芯片，发出后消息上方显示引用',
    /^Context · .+ · turns 1–\d · ~[\d,]+ characters$/.test(chip) && sent.at(-1)?.label === chip,
  JSON.stringify({ chip, sent }));
  await shot(page, '6-menu');
}

/** @brief 反例：关闭分屏不停止正在生成的会话。 */
async function counterExample(ctx) {
  const { page } = ctx;
  await sendAt(page, 'right', PROMPTS.longer);
  await sleep(2500);
  await paneAt(page, 'right').getByTestId('close-pane').click();
  await waitSplit(page, false);
  const running = await waitStatus(page, ctx.b, 'running', 3000);
  const unseen = await waitStatus(page, ctx.b, 'unseen', 240000);
  await rowOf(page, ctx.b).first().click();
  await waitPaneReady(page, 'single');
  const notices = await paneAt(page, 'single').getByTestId('notice').allInnerTexts();
  const reply = await paneAt(page, 'single').getByTestId('assistant').last().innerText();
  record('反例：关闭分屏中正在生成的一栏不停止它：侧栏"生成中"，之后"有新结果"，回复写完、没有"已停止"', running && unseen
    && reply.length > 200 && !notices.some((t) => t.startsWith('Stopped')), JSON.stringify({ running, unseen,
    reply: reply.length, notices }));
}

/**
 * @brief 走查数据目录里要有 Mori（v1）保存的提供商（只读 model-config.json 的非机密部分，lib.mjs realProviders，
 *        规格 §14.4）；没有时在复制密文之前就失败。
 */
function requireConnection(dir) {
  realProviders(dir);
}

requireConnection(source);
const root = mkdtempSync(join(tmpdir(), 'mori-m5-real-'));
const ctx = { project: makeProject(root), pageErrors: [] };
ctx.userData = scratchUserData(source);
// 测试准备（synthetic test setup，§14.1）：给临时项目授权公网，默认范围设为 [DeepSeek, GLM] 的分组
allowRealProject(ctx.userData, ctx.project);
try {
  await start(ctx);
  const items = { 1: item1, 2: item2, 3: item3, 4: item4, 5: item5, 6: item6, c: counterExample };
  for (const [item, fn] of Object.entries(items)) {
    if (!wanted(item) && item !== '1') continue;
    try {
      await fn(ctx);
    } catch (error) {
      record(`${item === 'c' ? '反例' : `走查 ${item}`}：流程`, false, oneLine(error, 400));
      await shot(ctx.page, `${item}-error`);
      await ctx.page.keyboard.press('Escape').catch(() => {});
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  rmSync(ctx.userData, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = write(`m5-real${suffix}.json`) ? 0 : 1;
