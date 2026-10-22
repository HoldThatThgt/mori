// M7 真实端点走查（方案第 7 节 M7 走查 1–4 与反例），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 状态表见 docs/v0/screens/review.md（写反馈见 selection.md "反馈"，F8 报告见 f8.md）。脚本不接触 key：只把走查数据目录里
// Mori 加密保存的密文（credentials.json 与 Local State）复制到临时目录（lib.mjs scratchUserData），整个走查（包括重启）都用
// 这一个复制出来的数据目录。
// 像负责人一样操作界面：发消息（批准卡点"Allow once"）、回复下的"Give feedback"、在回复里拖选一段点"Feedback"、点工具卡里
// 的路径在阅读器里选两行点"Feedback"、按 F8 写报告、Ctrl+N 开第二个会话并在侧栏里永久删除它（只删临时数据目录里的这个测试
// 会话）；左栏"Review"、选中一行、"Jump to source"、"Resolve"、"Hide resolved"、"Export as Markdown…"。"重启"是关掉窗口（Mori 有序
// 退出）再用同一个数据目录启动。系统的选文件夹对话框和保存对话框经 app.evaluate 换成直接返回测试文件夹、临时目录里的导出
// 文件（不弹对话框）。
// "回复不在了"：pi 和 Mori 都没有让一条回复离开当前分支的操作（不手改会话文件），所以写进一份 synthetic 反馈（指向真的会话
// 文件里不存在的条目 id 和消息时间，内容写明 synthetic）；会话和 session.read 是真的（同 m7-record.mjs 的 review-changed）。
// "不发给模型"：脚本看不到后台进程发给端点的请求，用三样看得到的代替：会话文件里的消息条数不变（pi 发请求前先把你的消息写进
// 会话文件）、工作回顾这段时间里没有会话进入生成中、最后一份 F8 报告的"Recent activity"里没有"Send / Steer / Queue"。
// 模型行为（是否用 read 读了 README.md）DeepSeek 不保证，这类检查失败时记为 KNOWN，标"（模型行为）"。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m7-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,3,4,c]
// 写记录、删第二个会话和第一次重启各项都要用，总会做；--only 只挑之后的检查。
// 结果写到 test-results/m7-real(-packaged).json，截图和导出的两个 Markdown 文件的副本在 test-results/m7-real(-packaged)/。

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  allowRealProject, appRoot, arg, createRecorder, launch, oneLine, prepareProject, realProviders, scratchUserData,
  sleep,
} from './lib.mjs';
import {
  activeFile, chooseMenuItem, ctrlN, paneOf, rowOf, samePath, settle, stubFolder, until, waitReady,
} from './m3-helpers.mjs';
import {
  dragSelect, jumpHighlight, PANE, popoverShown, selectLines, sessionEntries, viewerState, waitViewer,
} from './m4-helpers.mjs';
import {
  backToChat, chooseTab, detailState, exportTo, flashVisible, mdHead, mdSections, noticeText, openReviewPage,
  pressedRow, records, reviewState, selectRow, shotLink,
} from './m7-helpers.mjs';
import { pageHelpers } from './page.mjs';

const source = arg('source');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/m7-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const wanted = (item) => !only || only.includes(String(item));

const PROMPTS = {
  summary: '请用 read 工具读取 README.md，然后用两句话概括它的内容。不要修改任何文件，不要运行命令。',
  readAgain: '请调用 read 工具读取 README.md（只读，不要修改），读完用一句话告诉我它的第一行是什么。',
  ask: '用两句话介绍一下 Markdown 是什么。不要调用任何工具。',
};
/** 写下的期望 */
const EXPECT = {
  reply: '希望概括里直接说出这个项目是做什么用的', selection: '希望这句话说得更具体一些',
  file: '希望 README 把这两行合成一句完整的话', gone: '希望回答再短一点',
};
/** 两份 F8 报告（先写的那份之后标已处理） */
const ISSUES = [
  { what: '（m7-real 走查）回复下的按钮太小，不好点', expect: '按钮再大一点' },
  { what: '（m7-real 走查）阅读器里行号和正文挨得太近', expect: '行号和正文之间留点空' },
];
/** 阅读器里选的行（lib.mjs prepareProject 的 README 第 5–6 行是两条列表项） */
const FILE_LINES = [5, 6];
/** synthetic 反馈的文件名（日期早于真的记录，排在列表最后） */
const SEED_NAME = '2024-06-15-120000.json';
/** 回到原位置不成功时详情里的说明（review.md "回到原位置"） */
const JUMP_TEXT = { changed: 'This response is no longer in the session.', gone: 'Session deleted' };
/** 导出的报告一节里降一级的标题（review.md "导出的内容"） */
const ISSUE_HEADINGS = ['What went wrong', 'What you expected', 'Screenshot', 'Current view', 'Recent activity',
  'Versions'];

// ---------- 磁盘 ----------

/** @brief 反馈或报告的文件夹。 */
const dirOf = (ctx, kind) => join(ctx.userData, kind === 'feedback' ? 'feedback' : 'ui-issues');
/** @brief 两个值的 JSON 相同（顺序也算）。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 文件夹里的文件名；文件夹不存在时为空。 */
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
/** @brief 读一份反馈记录（JSON）；读不出来时为 null。 */
function readFeedback(ctx, name) {
  try {
    return JSON.parse(readFileSync(join(dirOf(ctx, 'feedback'), name), 'utf8'));
  } catch {
    return null;
  }
}

/** @brief 反馈的文件名，按记录里的保存时刻从新到旧（工作回顾的顺序）。 */
function feedbackOrder(ctx) {
  const moment = (name) => Date.parse(readFeedback(ctx, name)?.createdAt ?? '') || 0;
  return filesIn(dirOf(ctx, 'feedback')).filter((name) => name.endsWith('.json'))
    .sort((left, right) => moment(right) - moment(left));
}

/** @brief 报告的文件名（报告时间格式的 .md），按保存时刻从新到旧。 */
function issueOrder(ctx) {
  const stem = (name) => name.slice(0, -3);
  return filesIn(dirOf(ctx, 'issues')).filter((name) => /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.md$/.test(name))
    .sort((left, right) => stem(right).localeCompare(stem(left), 'en', { numeric: true }));
}

/** @brief 文件夹里每个文件的大小、修改时间和内容的 SHA-1（比较"文件不变"）。 */
function snapshot(dir) {
  return Object.fromEntries(filesIn(dir).map((name) => {
    const path = join(dir, name);
    const digest = createHash('sha1').update(readFileSync(path)).digest('hex');
    return [name, `${statSync(path).size}|${statSync(path).mtimeMs}|${digest}`];
  }));
}

/** @brief 两份快照里不同（新加、删掉、改过）的文件名。 */
function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]);
}

/** @brief 数据目录里全部会话文件的消息条数（pi 发请求前先把你的消息写进会话文件）。 */
function messageCounts(ctx) {
  const root = join(ctx.userData, 'pi', 'sessions');
  if (!existsSync(root)) return {};
  const files = readdirSync(root, { recursive: true }).map(String).filter((name) => name.endsWith('.jsonl'));
  return Object.fromEntries(files.map((name) => [name,
    sessionEntries(join(root, name)).filter((entry) => entry.type === 'message').length]));
}

/** @brief 引用块：每行前加"> "（与导出相同）。 */
const quoted = (text) => text.replace(/\r\n/g, '\n').split('\n').map((line) => `> ${line}`).join('\n');
/** @brief PNG 文件头里的宽度。 */
const pngWidth = (file) => readFileSync(file).readUInt32BE(16);

// ---------- 启动与重启 ----------

/** @brief 页面里运行：记下有没有会话进入生成中（data-running 变成 true）。 */
function watchRunning() {
  window.__m7Running = 0;
  const look = () => {
    if (document.querySelector('[data-testid="chat-pane"][data-running="true"]')) window.__m7Running += 1;
  };
  new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-running'] });
}

/** @brief 启动 Mori（连接已在走查数据目录的副本里），等侧栏读完；换掉选文件夹的对话框。 */
async function start(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.h = pageHelpers(ctx.page);
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 60000 });
  await ctx.page.evaluate(watchRunning);
  await stubFolder(ctx.app, ctx.project);
  await sleep(1500);
}

/** @brief 重启：关掉窗口（Mori 有序退出），再用同一个数据目录启动，等侧栏列出第一个会话。 */
async function restart(ctx) {
  ctx.ran.push(await ctx.page.evaluate(() => window.__m7Running ?? 0).catch(() => -1));
  const exited = new Promise((done) => ctx.app.process().once('exit', () => done(true)));
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  if (!await Promise.race([exited, sleep(20000).then(() => false)])) await ctx.app.close().catch(() => {});
  await start(ctx);
  await rowOf(ctx.page, ctx.s1).first().waitFor({ timeout: 60000 });
  await sleep(800);
}

/** @brief 出错后尽量回到能继续的样子：关掉浮层和对话框。 */
async function recover(page) {
  const overlays = '[data-testid="issue-dialog"], [data-testid="feedback-form"], [data-testid="session-menu"], '
    + '[data-testid="delete-dialog"]';
  for (let tries = 0; tries < 3; tries += 1) {
    if (!await page.locator(overlays).count().catch(() => 0)) return;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

// ---------- 会话 ----------

/** @brief 当前会话里助手回复和错误卡的个数。 */
const turnCounts = (page) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  return { replies: root?.querySelectorAll('[data-testid="assistant"]').length ?? 0,
    errors: root?.querySelectorAll('[data-testid="error-card"]').length ?? 0 };
}, PANE);

/** @brief 当前会话本轮结束了（不在生成、不在发送、没有阶段行）。 */
const turnIdle = (page) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  return root?.dataset.running === 'false' && root?.dataset.sending === 'false'
    && !root.querySelector('[data-testid="stage"]');
}, PANE);

/** @brief 发一条消息，等本轮结束（批准卡都点"Allow once"）；没有新回复或出了错误卡时抛错（流程失败，不算模型行为）。 */
async function sendTurn(ctx, text) {
  const { page, h } = ctx;
  const before = await turnCounts(page);
  await h.send(text);
  await page.waitForFunction(({ sel, n }) => document.querySelector(sel)?.dataset.running === 'true'
    || document.querySelectorAll(`${sel} [data-testid="assistant"]`).length > n, { sel: PANE, n: before.replies },
  { timeout: 30000 }).catch(() => {});
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline && !await turnIdle(page)) {
    const allow = paneOf(page).getByTestId('approval-allow');
    if (await allow.count() > 0) await allow.click().catch(() => {});
    await sleep(300);
  }
  const after = await turnCounts(page);
  if (after.replies <= before.replies || after.errors > before.errors) {
    const error = await paneOf(page).getByTestId('error-card').last().innerText().catch(() => '');
    throw new Error(`turn did not complete: ${JSON.stringify({ before, after, error: oneLine(error, 200) })}`);
  }
}

/** @brief 当前会话里"Read README.md"的工具卡。 */
const readCards = (page) => paneOf(page).getByTestId('tool-card')
  .filter({ has: page.locator('.tool-verb', { hasText: 'Read' }) })
  .filter({ has: page.locator('.tool-target', { hasText: 'README.md' }) });

/**
 * @brief 最后一条助手回复里一段没有格式的文字（段落或列表项里一个文字节点开头的 12 个字，去掉末尾的空白：选区存下的原文
 *        不带首尾空白），在这条回复的全文里只出现一次（拖选时不会选到思考块或工具卡里的同样的字）；没有时为 null。
 */
function plainPick(page) {
  return page.evaluate((sel) => {
    const all = document.querySelectorAll(`${sel} [data-testid="assistant"]`);
    const last = all[all.length - 1];
    if (!last) return null;
    const flat = last.textContent;
    for (const block of last.querySelectorAll('p, li')) {
      if (block.closest('[data-testid="thinking"], [data-testid="tool-card"]')) continue;
      for (const node of block.childNodes) {
        const text = node.nodeType === Node.TEXT_NODE ? node.data.trim() : '';
        const pick = [...text].slice(0, 12).join('').trimEnd();
        const once = flat.indexOf(pick) === flat.lastIndexOf(pick);
        if ([...pick].length >= 8 && once) return { pick, index: all.length - 1 };
      }
    }
    return null;
  }, PANE);
}

// ---------- 反馈与 F8 ----------

/** @brief 反馈表单出现后写 expected 点"Save"，等"Saved"；返回那一行的文字和新的记录文件名。 */
async function submitFeedback(ctx, expected) {
  const { page } = ctx;
  const before = new Set(filesIn(dirOf(ctx, 'feedback')));
  const form = page.getByTestId('feedback-form');
  await form.waitFor({ timeout: 5000 });
  await page.getByTestId('feedback-input').fill(expected);
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('feedback-saved').waitFor({ timeout: 10000 });
  const text = await page.getByTestId('feedback-saved').innerText();
  const name = await until(() => filesIn(dirOf(ctx, 'feedback')).find((item) => !before.has(item)), 5000);
  return { text, name };
}

/** @brief 等反馈表单关闭（"Saved"约 3 秒后）。 */
const formClosed = (page) => page.getByTestId('feedback-form').waitFor({ state: 'detached', timeout: 8000 })
  .catch(() => {});

/** @brief 按 F8 写一份报告并保存；返回报告框和"Saved to"里的 Markdown 路径。 */
async function saveReport(page, { what, expect }) {
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByTestId('issue-expect').fill(expect);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  return { dialog, file: /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null };
}

/** @brief 工作回顾里选中的一份报告的截图读完（img 有了宽度），最多 10 秒。 */
const shotLoaded = (page) => page.waitForFunction(() => document.querySelector('[data-testid="detail-shot"]')
  ?.naturalWidth > 0, null, { timeout: 10000 }).catch(() => {});

// ---------- 准备：在界面里写下记录，删掉第二个会话，重启 ----------

/** @brief 打开测试项目，让模型用 read 读 README 并概括；没有读时再明确要它读一次（模型行为）。 */
async function firstSession(ctx) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Open folder…' }).first().click();
  await waitReady(page);
  await sendTurn(ctx, PROMPTS.summary);
  if (await readCards(page).count() === 0) await sendTurn(ctx, PROMPTS.readAgain);
  ctx.s1 = await activeFile(page);
  const cards = await readCards(page).count();
  record('（模型行为）模型用 read 读了 README.md（对话里有"读取 README.md"的工具卡）', cards > 0, `${cards} 张`, true);
  return cards > 0;
}

/** @brief 回复下的"Give feedback"和回复里拖选一段点"Feedback"：都显示"Saved"，记下整条回复 / 选区的锚点。 */
async function replyFeedbacks(ctx) {
  const { page } = ctx;
  await paneOf(page).getByTestId('reply-actions').last().getByRole('button', { name: 'Give feedback' }).click();
  const reply = await submitFeedback(ctx, EXPECT.reply);
  ctx.fb.reply = reply.name;
  await formClosed(page);
  const picked = await plainPick(page);
  if (!picked) throw new Error('no plain text in the last reply to select');
  ctx.picked = picked.pick;
  await dragSelect(page, `${PANE} [data-testid="assistant"]`, picked.pick, picked.index);
  await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const selection = await submitFeedback(ctx, EXPECT.selection);
  ctx.fb.selection = selection.name;
  await formClosed(page);
  const [whole, part] = [readFeedback(ctx, reply.name), readFeedback(ctx, selection.name)];
  record('走查 1：回复下的"反馈这条回复"和回复里拖选一段点"反馈"：都显示"已记录 · 在工作回顾中查看"，记下整条回复 / '
    + '回复里的选区（锚点是这个会话的会话文件）', [reply.text, selection.text].every((text) => text
    === 'Saved · View in Review') && whole?.source.scope === 'reply' && part?.source.scope === 'selection'
    && part.quote === picked.pick && samePath(whole.source.sessionFile, ctx.s1)
    && samePath(part.source.sessionFile, ctx.s1), JSON.stringify({ reply, selection, picked: picked.pick,
    scopes: [whole?.source.scope, part?.source.scope] }));
}

/** @brief 点工具卡里的 README.md，阅读器里选第 5–6 行点"Feedback"；记录后点"View in Review"。 */
async function fileFeedback(ctx) {
  const { page } = ctx;
  await readCards(page).last().getByTestId('tool-path').click();
  await waitViewer(page);
  await selectLines(page, ...FILE_LINES);
  await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const saved = await submitFeedback(ctx, EXPECT.file);
  ctx.fb.file = saved.name;
  const anchor = readFeedback(ctx, saved.name)?.source;
  await page.getByTestId('feedback-open-review').click();
  await page.getByTestId('review-page').waitFor({ timeout: 10000 });
  await until(async () => (await pressedRow(page)) === saved.name, 5000);
  const view = { form: await page.getByTestId('feedback-form').count(), tab: (await reviewState(page)).tabs.feedback
    .pressed, selected: await pressedRow(page), expected: (await detailState(page))?.expected ?? null };
  record('走查 1：阅读器里选第 5–6 行点"反馈"，锚点是 README.md 的第 5–6 行；点"在工作回顾中查看"：关闭表单，'
    + '打开"对内容的反馈"并选中这一条', anchor?.kind === 'file' && samePath(anchor.path, join(ctx.project, 'README.md'))
    && anchor.startLine === FILE_LINES[0] && anchor.endLine === FILE_LINES[1] && view.form === 0 && view.tab
    && view.selected === saved.name && view.expected === EXPECT.file, JSON.stringify({ anchor, view }));
  await backToChat(page);
}

/** @brief 两份 F8 报告：第一份保存后点"View in Review"（打开"UI issues"、选中它、右栏有截图），第二份点"Close"。 */
async function issueReports(ctx) {
  const { page } = ctx;
  const first = await saveReport(page, ISSUES[0]);
  await first.dialog.getByTestId('issue-open-review').click();
  await page.getByTestId('review-page').waitFor({ timeout: 10000 });
  const name = basename(first.file ?? '');
  await until(async () => (await pressedRow(page)) === name, 5000);
  await shotLoaded(page);
  const detail = await detailState(page);
  const view = { dialog: await page.getByTestId('issue-dialog').count(), tab: (await reviewState(page)).tabs.issues
    .pressed, selected: await pressedRow(page), what: detail?.what, shot: detail?.shot };
  record('走查 2：F8 报告保存后点"在工作回顾中查看"：关闭报告框，打开"界面问题"并选中这一份，右栏有截图',
    Boolean(first.file) && view.dialog === 0 && view.tab && view.selected === name && view.what === ISSUES[0].what
    && Boolean(view.shot?.loaded), JSON.stringify({ file: first.file, view }));
  await backToChat(page);
  const second = await saveReport(page, ISSUES[1]);
  await second.dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await second.dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  ctx.issues = { [name]: ISSUES[0], [basename(second.file ?? '')]: ISSUES[1] };
  ctx.issueFirst = name;
}

/** @brief 第二个会话：收到回复后"Give feedback"，再在侧栏里永久删除这个会话。 */
async function goneSession(ctx) {
  const { page } = ctx;
  await ctrlN(page);
  await sendTurn(ctx, PROMPTS.ask);
  ctx.s2 = await activeFile(page);
  await paneOf(page).getByTestId('reply-actions').last().getByRole('button', { name: 'Give feedback' }).click();
  ctx.fb.gone = (await submitFeedback(ctx, EXPECT.gone)).name;
  await formClosed(page);
  await chooseMenuItem(page, ctx.s2, 'Delete…');
  const dialog = page.getByTestId('delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  await sleep(500);
  const deleted = { file: existsSync(ctx.s2), row: await rowOf(page, ctx.s2).count() };
  await openReviewPage(page, 'feedback');
  const detail = await selectRow(page, ctx.fb.gone);
  record('反例：在侧栏永久删除了第二个会话（会话文件和侧栏行都没了）；同一次运行里打开工作回顾，那条反馈的详情是'
    + '"原会话已删除"，"回到原位置"不可用', !deleted.file && deleted.row === 0 && detail?.jumpStatus === JUMP_TEXT.gone
    && Boolean(detail.jump?.disabled), JSON.stringify({ deleted, status: detail?.jumpStatus, jump: detail?.jump }));
  await backToChat(page);
}

/** @brief 写进 synthetic 反馈：会话文件是第一个会话的（真的），条目 id 和消息时间不在会话里（"回复不在了"）。 */
function seedChanged(ctx) {
  const base = readFeedback(ctx, ctx.fb.reply);
  const fake = { ...base, createdAt: '2024-06-15T04:00:00.000Z',
    expected: 'synthetic：m7-real 写进的反馈，指向会话里不存在的回复',
    quote: 'synthetic：这条回复不在会话里（条目 id 和消息时间都是编的）',
    source: { ...base.source, entryId: 'synthetic-missing-entry', time: 1 } };
  writeFileSync(join(dirOf(ctx, 'feedback'), SEED_NAME), `${JSON.stringify(fake, null, 2)}\n`);
  ctx.fb.changed = SEED_NAME;
}

/** @brief 准备：写下三条反馈和两份报告、删掉第二个会话（它的反馈留着）、写进 synthetic 反馈，然后重启。 */
async function prepare(ctx) {
  const read = await firstSession(ctx);
  await replyFeedbacks(ctx);
  if (read) await fileFeedback(ctx);
  await issueReports(ctx);
  await goneSession(ctx);
  seedChanged(ctx);
  await restart(ctx);
  [ctx.ranBefore] = ctx.ran;
  ctx.ran = [];
  ctx.snap = { feedback: snapshot(dirOf(ctx, 'feedback')), issues: snapshot(dirOf(ctx, 'issues')) };
  ctx.messages = messageCounts(ctx);
}

// ---------- 走查 1：重启后反馈都在，各自回到原位置 ----------

/** @brief 列表里每行的期望和来源。 */
const rowTexts = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="review-row"]')]
  .map((row) => ({ name: row.dataset.name, title: row.querySelector('.review-row-title')?.textContent ?? '',
    source: row.querySelector('.review-row-source')?.textContent ?? '' })));

/**
 * @brief 一条反馈在列表里应有的来源："<会话名> · Whole response / Selection in response"，文件的是
 *        "README.md · lines a–b"。
 */
function sourceLabel(ctx, record, s1Name) {
  const { source, session } = record;
  if (source.kind === 'file') return `README.md · lines ${source.startLine}–${source.endLine}`;
  const name = samePath(source.sessionFile, ctx.s1) ? s1Name : session.title;
  return `${name} · ${source.scope === 'reply' ? 'Whole response' : 'Selection in response'}`;
}

/** @brief 重启后打开工作回顾：写下的反馈都在（从新到旧），每行是自己的期望和来源。 */
async function reviewList(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const rows = await rowTexts(page);
  const s1Name = await rowOf(page, ctx.s1).locator('.session-label').innerText();
  const order = feedbackOrder(ctx);
  const wrong = order.filter((name) => {
    const fb = readFeedback(ctx, name);
    const row = rows.find((item) => item.name === name);
    return !row || row.title !== fb.expected || row.source !== sourceLabel(ctx, fb, s1Name);
  });
  const mine = Object.values(ctx.fb);
  record(`走查 1：重启后"对内容的反馈"列出写下的 ${mine.length} 条（真的 ${mine.length - 1} 条加 synthetic 1 条），`
    + '从新到旧，每行是自己的期望和来源（会话名 · 整条回复 / 回复里的选区，README.md 第 5–6 行）', same(rows
    .map((row) => row.name), order) && mine.every((name) => order.includes(name)) && wrong.length === 0,
  JSON.stringify({ rows, wrong }));
  await shot(page, '1-review');
}

/** @brief 等中栏换回会话（工作回顾页消失、会话就绪）。 */
async function waitChat(page) {
  await page.getByTestId('review-page').waitFor({ state: 'detached', timeout: 20000 });
  await waitReady(page);
  await settle(page);
}

/** @brief 选中一行点"Jump to source"，等中栏换回会话。 */
async function jumpFrom(page, name) {
  await openReviewPage(page, 'feedback');
  await selectRow(page, name);
  await page.getByTestId('detail-jump').click();
  await waitChat(page);
}

/** @brief 整条回复（重启后会话没开着）：中栏换回第一个会话，滚到那一轮并高亮；回到工作回顾时选中的还是它。 */
async function jumpReply(ctx) {
  const { page } = ctx;
  await jumpFrom(page, ctx.fb.reply);
  const flashed = await until(async () => (await jumpHighlight(page)).flashed > 0, 10000, 100);
  const view = { file: await activeFile(page), visible: await flashVisible(page) };
  await shot(page, '1-jump-reply');
  record('走查 1：整条回复的反馈"回到原位置"（重启后会话没开着）：中栏换回第一个会话，滚到那条回复，高亮整轮',
    Boolean(flashed) && samePath(view.file, ctx.s1) && view.visible, JSON.stringify({ flashed, ...view }));
  await openReviewPage(page);
  const selected = await pressedRow(page);
  record('走查 1：在左栏点"工作回顾"回来，选中的还是这一条', selected === ctx.fb.reply, String(selected));
}

/** @brief 回复里的选区：中栏换回会话，高亮当时选中的那段文字。 */
async function jumpSelection(ctx) {
  const { page } = ctx;
  await jumpFrom(page, ctx.fb.selection);
  const lit = await until(async () => {
    const now = await jumpHighlight(page);
    return now.text && now;
  }, 10000, 100);
  await shot(page, '1-jump-selection');
  record('走查 1：回复里选区的反馈"回到原位置"：中栏是第一个会话，高亮当时选中的那段文字', lit?.text === ctx.picked
    && samePath(await activeFile(page), ctx.s1), JSON.stringify({ lit, picked: ctx.picked }));
  // 等高亮（约 4 秒）消失，下一张截图里只有文件里的那条反馈的高亮。
  await until(async () => !(await jumpHighlight(page)).text, 8000);
}

/** @brief 文件里的：打开反馈时所在的会话，右栏阅读器打开 README.md，第 5–6 行高亮。 */
async function jumpFile(ctx) {
  const { page } = ctx;
  if (!ctx.fb.file) {
    record('走查 1：文件里的反馈"回到原位置"（模型行为：模型没有用 read 读 README.md，没有工具卡可点，没写这条反馈）',
      false, '', true);
    return;
  }
  await jumpFrom(page, ctx.fb.file);
  await waitViewer(page).catch(() => {});
  await sleep(300);
  const state = await viewerState(page);
  await shot(page, '1-jump-file');
  record('走查 1：文件里的反馈"回到原位置"：中栏是反馈时所在的会话，右栏阅读器打开 README.md，第 5–6 行高亮',
    state?.path === 'README.md' && same(state.target, FILE_LINES) && samePath(await activeFile(page), ctx.s1),
    JSON.stringify(state));
}

// ---------- 走查 2：F8 报告在"UI issues"里，带截图 ----------

/** @brief 重启后"UI issues"列出两份报告（从新到旧），每份的两段和截图（与 PNG 文件同宽）。 */
async function issueList(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'issues');
  const names = (await reviewState(page)).rows.map((row) => row.name);
  const seen = [];
  for (const name of names) {
    await selectRow(page, name);
    await shotLoaded(page);
    const detail = await detailState(page);
    const png = join(dirOf(ctx, 'issues'), name.replace(/\.md$/, '.png'));
    seen.push({ name, what: detail?.what, expect: detail?.expect, shot: detail?.shot,
      png: existsSync(png) ? pngWidth(png) : null });
    if (name === ctx.issueFirst) await shot(page, '2-issue');
  }
  const ok = seen.every((item) => item.what === ctx.issues[item.name]?.what
    && item.expect === ctx.issues[item.name]?.expect && item.shot?.loaded && item.shot.natural === item.png);
  record('走查 2：重启后"界面问题"列出两份 F8 报告（从新到旧）；选中每一份，右栏是它的"哪里不对""你期望什么"和截图'
    + '（截图与 ui-issues 里的 PNG 同宽）', same(names, issueOrder(ctx)) && names.length === 2 && ok,
  JSON.stringify(seen));
}

// ---------- 走查 3：标已处理，"Hide resolved"筛掉，重启后还在 ----------

/** @brief 选中 name 点"Resolve"，等这一行标上"Resolved"。 */
async function markHandled(page, name) {
  await selectRow(page, name);
  await page.getByTestId('detail-handled').click();
  await until(async () => (await reviewState(page)).rows.find((row) => row.name === name)?.handled, 3000);
}

/** @brief 一节此刻的样子：列出的行（名字和已处理）和分节上未处理的条数。 */
async function sectionView(page, kind) {
  await chooseTab(page, kind);
  const state = await reviewState(page);
  return { rows: state.rows.map((row) => [row.name, row.tag]), count: state.tabs[kind].count,
    hide: state.hide.checked };
}

/** @brief 标已处理（一条反馈、一份报告）：变淡标"Resolved"；打开"Hide resolved"：两节都不列出它们，数字不变，详情还在。 */
async function handledHide(ctx) {
  const { page } = ctx;
  const total = { feedback: feedbackOrder(ctx).length, issues: issueOrder(ctx).length };
  await openReviewPage(page, 'feedback');
  await markHandled(page, ctx.fb.reply);
  await chooseTab(page, 'issues');
  await markHandled(page, ctx.issueFirst);
  const marked = { feedback: await sectionView(page, 'feedback'), issues: await sectionView(page, 'issues') };
  const tagged = (view, name) => view.rows.some(([row, tag]) => row === name && tag === 'Resolved');
  record('走查 3：标为已处理（一条反馈、一份报告）：那一行标"已处理"，分节上的数字各少一', tagged(marked.feedback,
    ctx.fb.reply) && tagged(marked.issues, ctx.issueFirst) && marked.feedback.count === String(total.feedback - 1)
    && marked.issues.count === String(total.issues - 1), JSON.stringify(marked));
  await page.getByTestId('review-hide-handled').click();
  const detail = await detailState(page);
  const hidden = { issues: await sectionView(page, 'issues'), feedback: await sectionView(page, 'feedback') };
  const absent = (view, name) => !view.rows.some(([row]) => row === name);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mori.review') ?? 'null'));
  await shot(page, '3-hidden');
  record('走查 3：打开"隐藏已处理"：两节都不列出已处理的，其余照常列出，分节上的数字不变；刚标的那份详情还在（"标为未处理"）',
    hidden.feedback.hide === 'true' && absent(hidden.feedback, ctx.fb.reply) && absent(hidden.issues, ctx.issueFirst)
    && hidden.feedback.rows.length === total.feedback - 1 && hidden.issues.rows.length === total.issues - 1
    && hidden.feedback.count === marked.feedback.count && hidden.issues.count === marked.issues.count
    && detail?.handled === 'Reopen', JSON.stringify({ hidden, detail: detail?.handled }));
  record('走查 3：已处理和开关记在本机界面状态（localStorage 的 mori.review）', same([...(stored?.handled ?? [])].sort(),
    [`feedback/${ctx.fb.reply}`, `ui-issues/${ctx.issueFirst}`].sort()) && stored.hideHandled === true,
  JSON.stringify(stored));
}

/** @brief 重启后"Hide resolved"还开着，已处理的两条仍不列出。 */
async function handledRestart(ctx) {
  await restart(ctx);
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const view = { feedback: await sectionView(page, 'feedback'), issues: await sectionView(page, 'issues') };
  await chooseTab(page, 'feedback');
  await shot(page, '3-restart');
  record('走查 3：重启后"隐藏已处理"还开着，已处理的一条反馈和一份报告仍不列出', view.feedback.hide === 'true'
    && !view.feedback.rows.some(([row]) => row === ctx.fb.reply) && !view.issues.rows.some(([row]) => row
    === ctx.issueFirst) && view.feedback.rows.length === feedbackOrder(ctx).length - 1, JSON.stringify(view));
}

// ---------- 走查 4：两类都导出为 Markdown ----------

/** @brief 一节里每条反馈的期望、引用块和状态都对；返回不对的记录名。 */
function badFeedbackSections(ctx, sections, handled) {
  return sections.filter((section) => {
    const fb = readFeedback(ctx, section.name);
    const state = handled.includes(section.name) ? 'Resolved' : 'Unresolved';
    return !fb || !section.heading.endsWith(` · ${state}`)
      || !section.text.includes(`### What you hoped for\n\n${fb.expected}\n`)
      || !section.text.includes(`### Quoted text\n\n${quoted(fb.quote)}`);
  }).map((section) => section.name);
}

/** @brief 导出对内容的反馈（换掉保存对话框，写到临时目录）：只含列出的，顺序相同，每条的期望和引用块。 */
async function exportFeedback(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const rows = (await reviewState(page)).rows;
  const handled = rows.filter((row) => row.handled).map((row) => row.name);
  const target = join(ctx.exportDir, 'feedback.md');
  const { dialog, md } = await exportTo(ctx, target);
  if (existsSync(target)) copyFileSync(target, join(shots, `4-${basename(target)}`));
  const head = mdHead(md);
  const sections = mdSections(md);
  const notice = await noticeText(page, 'Exported ');
  const bad = badFeedbackSections(ctx, sections, handled);
  record('走查 4：导出对内容的反馈：对话框标题"导出对内容的反馈"；导出文件开头"# 对内容的反馈"和条数，只含列出的记录，'
    + '顺序与列表相同；每条有"### 你希望得到的结果"和"### 引用的原文"（每行前加 "> "）；工具行下面"已导出 N 条到 <路径>"',
  dialog?.title === 'Export as Markdown' && head.title === '# Feedback' && head.total === rows.length
    && head.done === handled.length && same(sections.map((item) => item.name), rows.map((row) => row.name))
    && bad.length === 0 && notice.startsWith(`Exported ${records(rows.length)} to ${target}`),
  JSON.stringify({ dialog, head, bad, notice: oneLine(notice, 160) }));
}

/** @brief 导出的一份报告的截图链接：相对导出文件夹、用 /，指到 ui-issues 里原来那张（还在的）PNG。 */
function shotLinkOk(ctx, section) {
  const link = shotLink(section.text);
  const png = join(dirOf(ctx, 'issues'), section.name.replace(/\.md$/, '.png'));
  const target = link && resolve(ctx.exportDir, ...link.split('/').map(decodeURIComponent));
  return { link, ok: Boolean(link) && !isAbsolute(link) && !link.includes('\\') && samePath(target, png)
    && existsSync(png) };
}

/** @brief 导出界面问题（关掉"Hide resolved"，含已处理的）：各节降一级，截图链接到原来的 PNG。 */
async function exportIssues(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'issues');
  if ((await reviewState(page)).hide.checked === 'true') await page.getByTestId('review-hide-handled').click();
  const rows = (await reviewState(page)).rows;
  const handled = rows.filter((row) => row.handled).map((row) => row.name);
  const target = join(ctx.exportDir, 'issues.md');
  const { dialog, md } = await exportTo(ctx, target);
  if (existsSync(target)) copyFileSync(target, join(shots, `4-${basename(target)}`));
  const head = mdHead(md);
  const sections = mdSections(md);
  const links = sections.map((section) => ({ name: section.name, ...shotLinkOk(ctx, section) }));
  const bad = sections.filter((section) => !ISSUE_HEADINGS.every((title) => section.text.includes(`\n### ${title}\n`))
    || !section.text.includes(`### What went wrong\n\n${ctx.issues[section.name]?.what}\n`)
    || !section.heading.endsWith(handled.includes(section.name) ? ' · Resolved' : ' · Unresolved')).map((s) => s.name);
  const notice = await noticeText(page, 'Exported ');
  await shot(page, '4-export');
  record('走查 4：导出界面问题（关掉"隐藏已处理"，含已处理的一份并注明"已处理"）：开头"# 界面问题"和条数，顺序与列表相同，'
    + '报告各节降一级（### 哪里不对 … ### 版本）', dialog?.title === 'Export as Markdown' && head.title === '# UI issues'
    && head.total === rows.length && head.done === handled.length && same(sections.map((s) => s.name), rows
    .map((row) => row.name)) && bad.length === 0 && notice.startsWith(`Exported ${records(rows.length)} to ${target}`),
  JSON.stringify({ dialog, head, bad, notice: oneLine(notice, 160) }));
  record('走查 4：导出的截图链接是从导出文件所在的文件夹到 ui-issues 里原来那张 PNG 的相对路径（用 /，PNG 在）',
    links.length === rows.length && links.every((item) => item.ok), JSON.stringify(links));
  record('反例：导出不复制截图（导出的文件夹里只有导出的两个 .md）', same(filesIn(ctx.exportDir), ['feedback.md',
    'issues.md']), JSON.stringify(filesIn(ctx.exportDir)));
}

// ---------- 反例 ----------

/** @brief 会话面板和侧栏会话行的个数（检查没有打开、新建会话）。 */
const sessionCounts = async (page) => ({ panes: await page.locator('.pane-slot').count(),
  rows: await page.locator('.session-item').count(), review: await page.getByTestId('review-page').count() });

/**
 * @brief 回复不在了（synthetic 反馈，会话文件是真的；会话没开着时读会话文件）：留在工作回顾，
 *        "This response is no longer in the session."。
 */
async function jumpChanged(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const before = await sessionCounts(page);
  await selectRow(page, ctx.fb.changed);
  await page.getByTestId('detail-jump').click();
  await page.getByTestId('detail-jump-status').waitFor({ timeout: 15000 }).catch(() => {});
  const detail = await detailState(page);
  const after = await sessionCounts(page);
  await shot(page, 'c-changed');
  record('反例：回复不在了（synthetic 反馈指向真的会话文件里不存在的回复）：点"回到原位置"后留在工作回顾，详情里'
    + '"原文已变化：会话里找不到这条回复了"，引用的原文仍在；没有打开会话（不跳到会话底部假装找到了）', detail?.jumpStatus
    === JUMP_TEXT.changed && (detail.quote ?? '').startsWith('synthetic：') && after.review === 1
    && after.panes === before.panes, JSON.stringify({ status: detail?.jumpStatus, before, after }));
}

/** @brief 原会话已删除（重启后会话列表里没有它）：详情里"Session deleted"，按钮不可用，引用的原文仍在；不新建会话。 */
async function goneDetail(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const before = await sessionCounts(page);
  const detail = await selectRow(page, ctx.fb.gone);
  const quote = readFeedback(ctx, ctx.fb.gone)?.quote;
  await page.getByTestId('detail-jump').click({ force: true, timeout: 2000 }).catch(() => {});
  await sleep(500);
  const after = await sessionCounts(page);
  await shot(page, 'c-gone');
  record('反例：原会话已删除（在侧栏删掉的第二个会话，重启后）：详情里"原会话已删除"，"回到原位置"不可用，引用的原文仍在；'
    + '点它也不新建会话（会话面板和侧栏行的个数不变，会话文件仍不在）', detail?.jumpStatus === JUMP_TEXT.gone
    && Boolean(detail.jump?.disabled) && detail.quote === quote && same(before, after) && !existsSync(ctx.s2),
  JSON.stringify({ status: detail?.jumpStatus, jump: detail?.jump, before, after }));
}

/** @brief 工作回顾里的操作（打开、选中、回到原位置、标记、导出、重启）都没有改记录文件，也没有发消息给模型。 */
async function untouched(ctx) {
  const now = { feedback: snapshot(dirOf(ctx, 'feedback')), issues: snapshot(dirOf(ctx, 'issues')) };
  const changed = [...changedFiles(ctx.snap.feedback, now.feedback), ...changedFiles(ctx.snap.issues, now.issues)];
  record('反例：打开工作回顾、回到原位置、标已处理、导出、重启都不改反馈和报告文件（大小、修改时间、内容都不变），'
    + 'ui-issues 里也没有多出文件', changed.length === 0, changed.join(', '));
  const messages = messageCounts(ctx);
  const ran = [...ctx.ran, await ctx.page.evaluate(() => window.__m7Running ?? 0)];
  record('反例：工作回顾里的操作都不发消息给模型：会话文件里的消息条数不变，这段时间里没有会话进入生成中（同一个记法在'
    + '重启前发消息时记到了生成中）', ctx.ranBefore > 0 && same(messages, ctx.messages) && ran.every((count) => count
    === 0), JSON.stringify({ before: ctx.messages, after: messages, ranBefore: ctx.ranBefore, ran }));
}

/** @brief 一份报告的"Recent activity"里的行，和其中发消息给模型的（"Send / Steer / Queue"）。 */
function reportActionLines(file) {
  const md = file && existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  const actions = (/\n## Recent activity\n\n([\s\S]*?)\n\n## /.exec(md)?.[1] ?? '').split('\n').filter(Boolean);
  return { md, actions, sent: actions.filter((line) => /^- \S+ (Send|Steer|Queue): /.test(line)) };
}

/**
 * @brief 最后在工作回顾页上按 F8：报告的"Recent activity"里没有"Send / Steer / Queue"（这次运行没有发过消息）；
 *        重启前的第一份报告里有（同一个认法认得出发消息）。
 */
async function reportActions(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'issues');
  const { dialog, file } = await saveReport(page, { what: '（m7-real 走查）最后一份报告，看最近的操作',
    expect: '最近的操作里没有发送消息' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const { md, actions, sent } = reportActionLines(file);
  const earlier = reportActionLines(join(dirOf(ctx, 'issues'), ctx.issueFirst ?? '')).sent;
  const top = await until(async () => (await reviewState(page))?.rows[0]?.name === basename(file ?? ''), 5000);
  record('反例：最后在工作回顾页上按 F8，报告的"最近的操作"里有工作回顾里的操作、没有"发送 / 插话 / 排队"（这次运行'
    + '没有发消息给模型；重启前的第一份报告里有"发送"）；新报告在"界面问题"最上面', earlier.length > 0
    && actions.length > 0 && sent.length === 0 && Boolean(top) && md.includes('- Page: Review'),
  JSON.stringify({ file, actions, sent, earlier }));
}

// ---------- 执行 ----------

/**
 * @brief 走查数据目录里要有 Mori（v1）保存的提供商（只读 model-config.json 的非机密部分，lib.mjs realProviders，
 *        规格 §14.4）；没有时在复制密文之前就失败。
 */
function requireConnection(dir) {
  realProviders(dir);
}

/** @brief 删掉临时目录；刚退出时文件夹可能还占着，多试几次。 */
function remove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.error(`cannot remove ${dir}: ${oneLine(error)}`);
  }
}

/** 准备之后的步骤：[走查项, 步骤]，按顺序执行（"回复不在了"放在最前，那时第一个会话还没打开，走 session.read） */
const STEPS = [
  ['1', reviewList], ['c', jumpChanged], ['1', jumpReply], ['1', jumpSelection], ['1', jumpFile], ['c', goneDetail],
  ['2', issueList], ['3', handledHide], ['3', handledRestart], ['4', exportFeedback], ['4', exportIssues],
  ['c', untouched], ['c', reportActions],
];

requireConnection(source);
const { root, project } = prepareProject('mori-m7-real-');
const ctx = { root, project, exportDir: join(root, 'export'), pageErrors: [], ran: [], fb: {} };
mkdirSync(ctx.exportDir, { recursive: true });
ctx.userData = scratchUserData(source);
// 测试准备（synthetic test setup，§14.1）：给临时项目授权公网，默认范围设为 [DeepSeek, GLM] 的分组
allowRealProject(ctx.userData, ctx.project);
try {
  await start(ctx);
  await prepare(ctx);
  for (const [item, fn] of STEPS) {
    if (!wanted(item)) continue;
    try {
      await fn(ctx);
    } catch (error) {
      record(`${item === 'c' ? '反例' : `走查 ${item}`}：流程（${fn.name}）`, false, oneLine(error, 400));
      await shot(ctx.page, `${item}-${fn.name}-error`);
      await recover(ctx.page);
    }
  }
} catch (error) {
  record('准备：打开测试项目、写下反馈和报告、删掉第二个会话、重启', false, oneLine(error, 400));
  if (ctx.page) await shot(ctx.page, 'prepare-error');
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  remove(ctx.userData);
  remove(root);
}
process.exitCode = write(`m7-real${suffix}.json`) ? 0 : 1;
