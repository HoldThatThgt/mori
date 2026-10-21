// M7 整机测试：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖工作回顾（docs/v0/screens/review.md 的各张表；方案第 7 节 M7 走查 1–4 与反例）：
// 入口（左栏"Customize"下面的"Review"、高亮、收起为图标栏）、读取中 / 读取失败与重新读取、空、"Open folder"（还没有时
// 先建好、打不开）；在界面里真的写下的记录（回复下的"Give feedback"、回复里的选区、文件阅读器里的选区、第二个会话、F8 报告
// 带截图）与"View in Review"（反馈表单、F8 报告框）；手写进数据目录的 synthetic 记录（没有截图的报告、读不出的 JSON 和报告、
// 文件开头带 BOM 的记录、createdAt 不是时间的反馈、
// 不是报告的 .md、zip 和别的文件不列出、回复不在会话里的反馈、原会话已删除、原会话没有保存、工作目录外的文件）；
// 一行摘要（期望最多两行、原文第一行、来源、MM-DD HH:mm 与带年份）、几种窗口宽度下列表和详情都没有横向滚动条、
// 从新到旧、会话改名后显示新名字、不监视文件夹、
// 记录不在了关闭详情、重新读取时的"Loading…"；右栏的详情（反馈、界面问题、读不出来的记录与打开所在文件夹、截图读取中 /
// 读不出（列表读完后、打开之前 PNG 被删了）、放大截图与 Esc / 点外面 / "Close"、焦点回到截图、可以展开的三节、
// 打开所在文件夹、与会话右栏共用宽度、窄窗口浮在上层）；↑ ↓ 与 Enter；分节各自记住的选中和滚动位置（选中的一行滚出视野时
// 也不被拉回去）、"View in Review"把刚记下的一行滚进视野；已处理与"Hide resolved"（变淡、标"Resolved"、条数、
// 开关开着时详情还在、关闭详情时焦点、都已隐藏、重启后还在、文件不变）；
// 导出为 Markdown（对话框标题与默认文件名、取消、内容与顺序、引用块、报告各节降一级、截图的相对链接、导出到 ui-issues
// 里时是文件名且不列出、不复制截图、"Show in Explorer"、导出失败）；回到原位置（重启后没开着的会话里的整条回复、选区高亮、
// 文件里的行、已归档的先恢复、回复不在了留在工作回顾、原会话已删除（列表里没有的、列表里有但文件被删了的）不新建会话、
// 没有保存不可用、"Opening…"、分屏放不下右栏时右栏浮出来）；返回会话（分屏、焦点、草稿、右栏的文件）；
// 工作回顾页上按 F8（"Page: Review"，新报告马上出现在最上面，你写的标题行不切错）；
// 后台进程退出后照常能看、能标、能导出，只有"Jump to source"不可用；打开、标记、导出都不发请求给模型；
// 没有小于 12px 的字；页面没有报错。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m7-app.mjs [--exe <Mori.exe 路径>]
// 结果写到 test-results/m7-app(-packaged).json，截图在 test-results/m7-app(-packaged)/。
// 主进程的 shell.openPath、shell.showItemInFolder 和 dialog.showSaveDialog 经 app.evaluate 换成只记下参数的版本
// （不真的打开资源管理器或保存对话框）。各步骤按顺序依赖前一步留下的记录和标记，所以不提供 --only。
// 下面手写进数据目录的记录（seedFeedback、seedIssues）都是 synthetic，内容里也写明了。

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, sleep } from './lib.mjs';
import {
  activeFile, chooseMenuItem, ctrlN, openRow, paneOf, renameClosed, rowOf, samePath, savedArchived, settle,
  startRename, until, waitReady, waitRowTitle,
} from './m3-helpers.mjs';
import { dragSelect, jumpHighlight, PANE, popoverShown, selectLines, viewerState, waitViewer } from './m4-helpers.mjs';
import { composerAt, savedLayout, splitState, waitPaneReady, waitSplit } from './m5-helpers.mjs';
import { firstRunAndOpen, resizeWindow, startFakeEndpoint } from './m6-helpers.mjs';
import {
  backToChat, chooseTab, detailState, exportTo, flashVisible, mainCalls, mdHead, mdSections, noticeText, openReviewPage,
  pressedRow, records, reviewState, rowAt, selectRow, shortOf, shotLink, sideOverflow, waitLoaded,
} from './m7-helpers.mjs';
import { pageHelpers } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const port = 4371;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m7-not-a-real-key';
const shots = join(appRoot, `test-results/m7-app${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 两节没有记录时的说明（review.md "空"） */
const EMPTY = {
  feedback: 'No feedback yet. Select text in a response or the file viewer and click “Feedback”, '
    + 'or use “Give feedback” under a response.',
  issues: 'No UI issues yet. Press F8 to report one.',
};
/** 两节的名字 */
const LABEL = { feedback: 'Feedback', issues: 'UI issues' };
/** 合成端点 "plain" 的回复 */
const REPLY = '这是一段只有文字的回复，用来测试流式输出。';
/** README 的第一行（文件里的反馈引用第 1–2 行） */
const TITLE = '# Mori fixture project';
/** 报告的文件名（不含扩展名），同 src/shared/review.ts 的 ISSUE_NAME */
const ISSUE_NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/;
/** 回到原位置不可用或没有成功时详情里的说明（review.md "回到原位置"） */
const JUMP_TEXT = {
  changed: 'This response is no longer in the session.', gone: 'Session deleted',
  unsaved: 'The session wasn’t saved, so there’s no source to jump to.',
  exited: 'Mori’s background process crashed. Restart it to continue.',
};
/** 第一个会话改名后的名字（摘要里的会话名用侧栏现在的名字） */
const RENAMED = '回顾测试会话';
/** synthetic 记录的文件名：日期早于真的记录（排在列表后面），年份不是今年（摘要里带年份） */
const SEED = {
  changed: '2024-06-15-120000.json', gone: '2024-06-14-120000.json', brokenJson: '2024-06-13-120000.json',
  unsaved: '2024-06-12-120000.json', outside: '2024-05-03-120000.json', filler1: '2024-05-02-120000.json',
  filler2: '2024-05-01-120000.json', notJson: 'synthetic-notes.txt', late: '2024-06-16-120000.json',
  sameSecond: '2024-06-15-120000-2.json', listedGone: '2024-06-14-130000.json', bom: '2024-05-04-120000.json',
  badTime: '2024-05-05-120000.json',
  noShot: '2024-06-15-120000.md', brokenMd: '2024-06-14-120000.md', onlyExpect: '2024-06-13-120000.md',
  notReport: 'ui-issues-2000-01-01.md', zip: 'synthetic-share.zip',
};
/** synthetic 的长期望：摘要里最多两行，详情里是全文 */
const LONG_EXPECTED = `synthetic：${'这条期望很长，摘要里最多显示两行，详情里显示全文。'.repeat(8)}`;
/** synthetic 的长原文（两百多行）：摘要里只有第一行，详情里在框里滚动 */
const LONG_QUOTE = ['synthetic 第一行：这段原文不在会话里', 'synthetic 第二行',
  ...Array.from({ length: 200 }, (_, index) => `synthetic 第 ${index + 3} 行`)].join('\n');
/** 查小于 12px 的字的范围 */
const SMALL_SCOPE = ['[data-testid="review-page"]', '[data-testid="review-detail"]', '[data-testid="shot-viewer"]',
  '[data-testid="feedback-form"]', '[data-testid="issue-dialog"]', '[data-testid="nav-review"]'];

// ---------- 磁盘 ----------

/** @brief 反馈或报告的文件夹。 */
const dirOf = (ctx, kind) => join(ctx.userData, kind === 'feedback' ? 'feedback' : 'ui-issues');
/** @brief 两个值的 JSON 相同（顺序也算）。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 两位数字。 */
const pad = (value) => String(value).padStart(2, '0');

/** @brief 读一份反馈记录；读不出来时为 null。 */
function readFeedback(ctx, name) {
  try {
    return JSON.parse(readFileSync(join(dirOf(ctx, 'feedback'), name), 'utf8'));
  } catch {
    return null;
  }
}

/** @brief 按保存时刻比较文件名：去掉扩展名按数字比较（同一秒再存的 -2 比不带序号的新）。 */
function byStamp(left, right) {
  const stem = (name) => name.slice(0, name.lastIndexOf('.'));
  return stem(left).localeCompare(stem(right), 'en', { numeric: true });
}

/** @brief 文件夹里应列出的记录（反馈：.json；界面问题：报告时间格式的 .md），按保存时刻从新到旧。 */
function expectedNames(ctx, kind) {
  const dir = dirOf(ctx, kind);
  if (!existsSync(dir)) return [];
  const listed = (name) => (kind === 'feedback' ? name.endsWith('.json')
    : name.endsWith('.md') && ISSUE_NAME.test(name.slice(0, -3)));
  return readdirSync(dir).filter(listed).sort(byStamp).reverse();
}

/** @brief 文件夹里每个文件的大小、修改时间和内容的 SHA-1（比较"文件不变"）。 */
function snapshot(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).sort().map((name) => {
    const path = join(dir, name);
    const digest = createHash('sha1').update(readFileSync(path)).digest('hex');
    return [name, `${statSync(path).size}|${statSync(path).mtimeMs}|${digest}`];
  }));
}

/** @brief 两个文件夹的快照。 */
const snapshots = (ctx) => ({ feedback: snapshot(dirOf(ctx, 'feedback')), issues: snapshot(dirOf(ctx, 'issues')) });

/** @brief 两份快照里不同（新加、删掉、改过）的文件名。 */
function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]);
}

/** @brief 本地时间 YYYY-MM-DD HH:mm:ss。 */
function localTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** @brief 反馈的完整本地时间（记录里的 createdAt 是 UTC）。 */
const feedbackTime = (createdAt) => localTime(new Date(createdAt));
/** @brief 报告标题里的时间。 */
const reportTime = (file) => /^# UI issue · (.+)$/m.exec(readFileSync(file, 'utf8'))?.[1].trim() ?? '';
/** @brief 今天（本地）YYYY-MM-DD。 */
const today = () => localTime(new Date()).slice(0, 10);

// ---------- synthetic 记录 ----------

/** @brief synthetic 反馈记录的 JSON（与 main/feedback.ts 存的格式相同）。 */
function feedbackJson(createdAt, expected, quote, source, session) {
  return `${JSON.stringify({ createdAt, expected, quote, source, session }, null, 2)}\n`;
}

/** @brief synthetic 报告的 Markdown（与 main/feedback.ts 写的格式相同）。 */
function reportMarkdown(time, what, expect, shotText) {
  return [`# UI issue · ${time}`, '', '## What went wrong', '', what, '', '## What you expected', '', expect, '',
    '## Screenshot', '', shotText, '', '## Current view', '', '- Page: synthetic', '', '## Recent activity', '',
    '- 12:00:00 synthetic 操作', '', '## Versions', '', '- Mori: synthetic', ''].join('\n');
}

/** @brief 回复里的锚点（synthetic：条目 id 和消息时间都不在任何会话里）。 */
const messageAnchor = (sessionFile, scope) => ({ kind: 'message', sessionFile, entryId: 'synthetic-missing-entry',
  time: 1, scope });

/**
 * @brief 会话文件夹里第二个会话的一份副本（synthetic，修改时间放到 2024 年，排在侧栏最后）：重启后在会话列表里，
 *        之后删掉它，测"列表里还有、会话文件被删了"的原会话已删除。
 */
function seedListedSession(ctx) {
  ctx.listedGoneFile = join(dirname(ctx.file2), `synthetic-listed-${basename(ctx.file2)}`);
  copyFileSync(ctx.file2, ctx.listedGoneFile);
  const old = new Date('2024-06-14T05:00:00.000Z');
  utimesSync(ctx.listedGoneFile, old, old);
}

/**
 * @brief 写进 synthetic 反馈：回复不在会话里（会话文件是真的，原文两百多行）、原会话已删除、列表里还有但文件会被删的会话、
 *        读不出的 JSON、原会话没有保存、工作目录外的文件、两条填充（列表才滚得动）、同一秒再存的一份（-2）、
 *        一个不是 .json 的文件。
 */
function seedFeedback(ctx) {
  const dir = dirOf(ctx, 'feedback');
  const put = (name, text) => writeFileSync(join(dir, name), text);
  const session = (file, title) => ({ file, cwd: ctx.project, title });
  ctx.goneFile = join(ctx.root, 'synthetic-deleted-session.jsonl');
  ctx.outsideFile = join(ctx.root, 'synthetic-outside.txt');
  seedListedSession(ctx);
  put(SEED.changed, feedbackJson('2024-06-15T04:00:00.000Z', LONG_EXPECTED, LONG_QUOTE,
    messageAnchor(ctx.file, 'selection'), session(ctx.file, 'synthetic 记录里的名字')));
  put(SEED.listedGone, feedbackJson('2024-06-14T05:00:00.000Z', 'synthetic：会话文件会被删掉',
    'synthetic：列表里还有的会话里的回复', messageAnchor(ctx.listedGoneFile, 'reply'),
    session(ctx.listedGoneFile, 'synthetic 列表里还有的会话')));
  put(SEED.gone, feedbackJson('2024-06-14T04:00:00.000Z', 'synthetic：原会话已删除', 'synthetic：已删除的会话里的回复',
    messageAnchor(ctx.goneFile, 'reply'), session(ctx.goneFile, 'synthetic 已删除的会话')));
  put(SEED.brokenJson, '{ "synthetic": "broken json"\n');
  put(SEED.unsaved, feedbackJson('2024-06-12T04:00:00.000Z', 'synthetic：原会话没有保存', 'synthetic：没有保存的回复',
    messageAnchor(null, 'selection'), session(null, 'synthetic 没有保存的会话')));
  const outside = { kind: 'file', path: ctx.outsideFile, sha256: '0'.repeat(64), startLine: 3, endLine: 4 };
  put(SEED.outside, feedbackJson('2024-05-03T04:00:00.000Z', 'synthetic：工作目录外的文件',
    'synthetic 第 3 行\nsynthetic 第 4 行', outside, session(null, 'synthetic')));
  for (const [name, index] of [[SEED.filler1, 1], [SEED.filler2, 2]]) {
    put(name, feedbackJson(`2024-05-0${3 - index}T04:00:00.000Z`, `synthetic 填充 ${index}`,
      `synthetic 填充原文 ${index}`, messageAnchor(null, 'reply'), session(null, 'synthetic')));
  }
  put(SEED.sameSecond, feedbackJson('2024-06-15T04:00:00.000Z', 'synthetic：同一秒再存的一份',
    'synthetic：同一秒的原文', messageAnchor(null, 'reply'), session(null, 'synthetic')));
  put(SEED.bom, `\uFEFF${feedbackJson('2024-05-04T04:00:00.000Z', 'synthetic：带 BOM 的反馈', 'synthetic：BOM 原文',
    messageAnchor(null, 'reply'), session(null, 'synthetic'))}`);
  put(SEED.badTime, feedbackJson('yesterday', 'synthetic：时间不对的反馈', 'synthetic：原文', messageAnchor(null, 'reply'),
    session(null, 'synthetic')));
  put(SEED.notJson, 'synthetic: not a feedback record\n');
}

/**
 * @brief 写进 synthetic 报告：没有截图的（文件开头带 BOM）、读不出的、"What went wrong"没有填写的（带截图）、不是报告的 .md、zip。
 */
function seedIssues(ctx) {
  const dir = dirOf(ctx, 'issues');
  const png = SEED.onlyExpect.replace(/\.md$/, '.png');
  writeFileSync(join(dir, SEED.noShot), `\uFEFF${reportMarkdown('2024-06-15 12:00:00', 'synthetic：没有截图的报告',
    'synthetic：照样列出', 'Couldn’t capture a screenshot: Synthetic capture failure')}`);
  writeFileSync(join(dir, SEED.brokenMd), '# UI issue · 2024-06-14 12:00:00\n\nsynthetic: a report without sections\n');
  copyFileSync(ctx.issue1.replace(/\.md$/, '.png'), join(dir, png));
  writeFileSync(join(dir, SEED.onlyExpect), reportMarkdown('2024-06-13 12:00:00', '(left blank)',
    'synthetic：只写了你期望什么', `![Screenshot](${png})`));
  writeFileSync(join(dir, SEED.notReport), '# synthetic: an exported file, not a report\n');
  writeFileSync(join(dir, SEED.zip), Buffer.from('PK\u0003\u0004synthetic'));
}

// ---------- 主进程里运行的函数（经 app.evaluate） ----------

/** @brief 换掉 shell.openPath 和 shell.showItemInFolder：只记下路径；openPath 按 fail 返回错误文字。 */
function stubShell({ shell }, fail) {
  globalThis.__m7Opened = globalThis.__m7Opened ?? [];
  globalThis.__m7Revealed = globalThis.__m7Revealed ?? [];
  shell.openPath = async (path) => {
    globalThis.__m7Opened.push(path);
    return fail ?? '';
  };
  shell.showItemInFolder = (path) => {
    globalThis.__m7Revealed.push(path);
  };
}

/** @brief 清空记下的路径。 */
function clearShell() {
  globalThis.__m7Opened = [];
  globalThis.__m7Revealed = [];
}

/** @brief 等主进程在资源管理器里选中一个文件，返回它（5 秒内没有时为 undefined）。 */
const firstRevealed = (app) => until(async () => (await mainCalls(app)).revealed[0], 5000);

// ---------- 启动 ----------

/** @brief 测试用的项目：README、src/a.ts。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m7-app-'));
  const project = join(root, 'm7proj');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), `${TITLE}\n\nThis folder is used to check Mori against a model.\n`);
  writeFileSync(join(project, 'src', 'a.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return { root, project };
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错；先换掉主进程的 shell（不真的打开资源管理器）。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
  await ctx.app.evaluate(stubShell, null);
}

/** @brief 关掉 Mori 再启动，等侧栏列出第一个会话（重启后没有打开的会话）。 */
async function restart(ctx) {
  await ctx.app.close();
  await startApp(ctx);
  await rowOf(ctx.page, ctx.file).first().waitFor({ timeout: 60000 });
  await sleep(800);
}

/** @brief 某一步出错后尽量回到能继续的样子：关掉浮层和对话框。 */
async function recover(ctx) {
  const overlays = '[data-testid="issue-dialog"], [data-testid="feedback-form"], [data-testid="shot-viewer"], '
    + '[data-testid="session-menu"]';
  for (let tries = 0; tries < 3; tries += 1) {
    const open = await ctx.page?.locator(overlays).count().catch(() => 0);
    if (!open) return;
    await ctx.page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

// ---------- 页面 ----------

/** @brief 焦点所在的列表行的文件名。 */
const focusedRow = (page) => settle(page).then(() => page.evaluate(() => document.activeElement
  ?.closest('[data-testid="review-row"]')?.dataset.name ?? null));
/** @brief 焦点所在元素的读屏名称。 */
const focusedLabel = (page) => settle(page).then(() => page.evaluate(() => document.activeElement
  ?.getAttribute('aria-label') ?? null));

/** @brief 这一行是否整个在列表的可见范围里（最近的可滚动祖先）。 */
function rowInView(page, name) {
  return page.evaluate((file) => {
    const row = document.querySelector(`[data-testid="review-row"][data-name="${file}"]`);
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    let box = { top: 0, bottom: innerHeight };
    for (let el = row.parentElement; el; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        box = el.getBoundingClientRect();
        break;
      }
    }
    return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  }, name);
}

/**
 * @brief 列表所在的滚动区域（列表或它最近的滚得动的祖先）：name 不为空时先把这一行滚到顶上；返回滚动位置和最大值，
 *        没有滚得动的区域时为 null。
 */
function listScroll(page, name = null) {
  return page.evaluate((file) => {
    let el = document.querySelector('[data-testid="review-list"]');
    while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) {
      el = el.parentElement;
    }
    if (!el) return null;
    const row = file && document.querySelector(`[data-testid="review-row"][data-name="${file}"]`);
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    return { top: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight };
  }, name);
}

/**
 * @brief 两行"淡"的比较：各取含 text 的最深的元素，算它到这一行的不透明度连乘和文字颜色；第一行比第二行淡
 *        （不透明度低得多，或颜色不同）时 dim 为真。
 */
function rowDim(page, [nameA, textA], [nameB, textB]) {
  return page.evaluate(({ a, b }) => {
    const measure = ([name, wanted]) => {
      const row = document.querySelector(`[data-testid="review-row"][data-name="${name}"]`);
      if (!row) return null;
      const target = [...row.querySelectorAll('*')].reverse().find((el) => el.textContent.includes(wanted)) ?? row;
      let opacity = 1;
      for (let el = target; el && el !== row.parentElement; el = el.parentElement) {
        opacity *= Number(getComputedStyle(el).opacity);
      }
      return { opacity, color: getComputedStyle(target).color };
    };
    const first = measure(a);
    const second = measure(b);
    return { first, second, dim: Boolean(first && second
      && (first.opacity < second.opacity - 0.05 || first.color !== second.color)) };
  }, { a: [nameA, textA], b: [nameB, textB] });
}

/** @brief 一行里文字以 prefix 开头的最深的元素占几行（按行高算）。 */
function linesOf(page, name, prefix) {
  return page.evaluate(({ file, start }) => {
    const row = document.querySelector(`[data-testid="review-row"][data-name="${file}"]`);
    const el = row && [...row.querySelectorAll('*')].reverse().find((item) => item.textContent.startsWith(start));
    if (!el) return null;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    return { lines: Math.round(el.getBoundingClientRect().height / line), height: el.getBoundingClientRect().height,
      line, clamp: style.webkitLineClamp };
  }, { file: name, start: prefix });
}

/** @brief 截图浮层此刻的样子；不在时为 null。 */
function viewerOverlay(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="shot-viewer"]');
    if (!dialog) return null;
    const img = dialog.querySelector('img');
    const rect = img?.getBoundingClientRect();
    return { role: dialog.getAttribute('role'), label: dialog.getAttribute('aria-label'),
      outsideApp: !dialog.closest('.app') && !dialog.closest('[data-testid="review-detail"]'),
      loaded: Boolean(img && img.naturalWidth > 0), fits: Boolean(rect && rect.left >= -1 && rect.top >= -1
        && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
      close: [...dialog.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Close') };
  });
}

/** @brief 截图浮层里截图外面的一点（不在截图上、不在按钮上）；找不到时为 null。 */
function outsidePoint(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="shot-viewer"]');
    const img = dialog?.querySelector('img');
    if (!dialog || !img) return null;
    const points = [[8, 8], [innerWidth - 8, innerHeight - 8], [8, innerHeight - 8], [innerWidth - 8, 8],
      [innerWidth / 2, 6], [innerWidth / 2, innerHeight - 6]];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      const related = hit && (dialog.contains(hit) || hit.contains(dialog));
      if (related && hit !== img && !hit.closest('button')) return { x, y };
    }
    return null;
  });
}

/** @brief 一栏（会话的右栏或工作回顾的详情）的宽度和它的分隔线的值、上限；没有时为 null。 */
function panelWidth(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const divider = el.querySelector('[data-resize="workspace"]');
    return { width: Math.round(el.getBoundingClientRect().width), now: Number(divider?.getAttribute('aria-valuenow')),
      max: Number(divider?.getAttribute('aria-valuemax')) };
  }, testId);
}

/** @brief 开始记下这些标识有没有出现过（只出现一两帧的状态轮询抓不到；做法同 m6 的 watchTools）。 */
function watchSeen(page, ids) {
  return page.evaluate((list) => {
    window.__m7Seen = Object.fromEntries(list.map((id) => [id, false]));
    window.__m7Observer?.disconnect();
    const look = () => {
      for (const id of list) if (document.querySelector(`[data-testid="${id}"]`)) window.__m7Seen[id] = true;
    };
    look();
    window.__m7Observer = new MutationObserver(look);
    window.__m7Observer.observe(document.body, { subtree: true, childList: true });
  }, ids);
}

/** @brief 停下 watchSeen，返回记下的结果。 */
const seenNow = (page) => page.evaluate(() => {
  window.__m7Observer?.disconnect();
  return window.__m7Seen ?? {};
});

/** @brief 开始记下"Jump to source"有没有显示过"Opening…"并且不可点。 */
function watchJump(page) {
  return page.evaluate(() => {
    window.__m7Jump = { checking: false };
    window.__m7JumpObserver?.disconnect();
    const look = () => {
      const button = document.querySelector('[data-testid="detail-jump"]');
      if (button?.textContent.includes('Opening…') && button.disabled) window.__m7Jump.checking = true;
    };
    window.__m7JumpObserver = new MutationObserver(look);
    window.__m7JumpObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true });
  });
}

/** @brief 停下 watchJump，返回记下的结果。 */
const jumpSeen = (page) => page.evaluate(() => {
  window.__m7JumpObserver?.disconnect();
  return window.__m7Jump ?? {};
});

/** @brief 记下此刻工作回顾各处小于 12px 的字（最后统一判断）；做法同 m6 的 toolsSmallText。 */
async function noteSmall(ctx, where) {
  const small = await ctx.page.evaluate((scopes) => scopes.flatMap((scope) => [...document.querySelectorAll(scope)])
    .flatMap((root) => [root, ...root.querySelectorAll('*')])
    .filter((el) => el.getClientRects().length > 0
      && [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} ${getComputedStyle(el).fontSize} `
      + `"${el.textContent.trim().slice(0, 20)}"`), SMALL_SCOPE);
  ctx.small.push(...small.map((item) => `${where}: ${item}`));
  ctx.smallChecked.push(where);
}

// ---------- 步骤：准备与入口 ----------

/** @brief 准备：首次启动填连接、打开项目、收到一条回复（pi 在第一条回复后才写会话文件）。 */
async function setup(ctx) {
  await startApp(ctx);
  await firstRunAndOpen(ctx, { baseUrl, apiKey: testKey, project: ctx.project });
  await ctx.h.send('plain 第一个会话');
  await ctx.h.idle(60000);
  ctx.file = await activeFile(ctx.page);
  record('准备：首次启动填连接，打开项目并收到一条回复', Boolean(ctx.file), ctx.file ?? '');
}

/** @brief 左栏"Review"：nav 里按钮的读屏名称顺序、文字、悬停提示、图标、是否在"Customize"下面。 */
function navPlace(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-testid="sidebar"] .sidebar-nav');
    const labels = [...nav.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    const tools = nav.querySelector('[data-testid="nav-tools"]').getBoundingClientRect();
    const review = nav.querySelector('[data-testid="nav-review"]');
    return { labels, text: review?.textContent.trim() ?? '', title: review?.getAttribute('title') ?? '',
      nav: review?.classList.contains('nav-item') ?? false, icon: Boolean(review?.querySelector('svg')),
      below: Boolean(review) && review.getBoundingClientRect().top >= tools.bottom - 1 };
  });
}

/**
 * @brief 入口与读取失败：左栏"Customize"下面的"Review"；feedback 的位置是个文件时读取失败（先"Loading…"，
 *        再原文和"Retry"），删掉它再"Retry"变成空（文件夹不存在不算错）。
 */
async function entry(ctx) {
  const { page } = ctx;
  const place = await navPlace(page);
  record('左栏："工具"下面一项"工作回顾"（nav-item、图标、悬停提示"工作回顾"）', place.below && place.nav && place.icon
    && place.labels.indexOf('Review') === place.labels.indexOf('Customize') + 1 && place.text === 'Review'
    && place.title === 'Review', JSON.stringify(place));
  writeFileSync(dirOf(ctx, 'feedback'), 'synthetic: a file where the feedback folder should be');
  await watchSeen(page, ['review-loading']);
  await page.getByTestId('nav-review').click();
  const error = page.getByTestId('review-error');
  await error.waitFor({ timeout: 10000 }).catch(() => {});
  const failed = await error.innerText().catch(() => '');
  const retry = await error.getByRole('button', { name: 'Retry' }).count();
  const seen = await seenNow(page);
  await shot(page, '1-read-failure');
  record('读取失败（主进程读文件夹报错）：先显示"正在读取…"，再显示原文和"重新读取"', seen['review-loading']
    && /ENOTDIR|not a directory/i.test(failed) && retry === 1, JSON.stringify({ seen, failed }));
  rmSync(dirOf(ctx, 'feedback'));
  await error.getByRole('button', { name: 'Retry' }).click();
  const empty = await page.getByTestId('review-empty').waitFor({ timeout: 10000 }).then(() => true, () => false);
  record('重新读取：文件夹不存在不算错，算空', empty && await page.getByTestId('review-error').count() === 0);
}

/** @brief 空的两节；顶部、分节、工具行；没有选中时不显示右栏。 */
async function emptyStates(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'feedback');
  const feedback = await reviewState(page);
  const lit = await page.getByTestId('nav-review').evaluate((el) => el.classList.contains('active'));
  record('工作回顾页：左栏"工作回顾"高亮；顶部"返回会话"、标题"工作回顾"', lit && feedback.back
    && feedback.title === 'Review', JSON.stringify({ lit, back: feedback.back, title: feedback.title }));
  const { tabs } = feedback;
  record('分节："对内容的反馈""界面问题"两个切换按钮，当前分节按下；读屏名称带未处理的条数（"对内容的反馈，0 条未处理"），'
    + '没有记录时不显示数字', tabs.feedback.pressed && !tabs.issues.pressed && tabs.feedback.text === LABEL.feedback
    && tabs.issues.text === LABEL.issues && tabs.feedback.label === 'Feedback, 0 unresolved'
    && tabs.issues.label === 'UI issues, 0 unresolved' && tabs.feedback.count === null && tabs.issues.count === null,
  JSON.stringify(tabs));
  const toggle = await page.getByRole('switch', { name: 'Hide resolved' }).count();
  record('工具行："隐藏已处理"开关（默认关）、"导出为 Markdown…"（没有记录时不可用）、"打开文件夹"', toggle === 1
    && feedback.hide.checked === 'false' && feedback.exportText === 'Export as Markdown…'
    && feedback.exportDisabled === true && feedback.folderText === 'Open folder', JSON.stringify({ toggle,
    hide: feedback.hide, exportText: feedback.exportText, disabled: feedback.exportDisabled }));
  await noteSmall(ctx, '空的对内容的反馈');
  await chooseTab(page, 'issues');
  const issues = await reviewState(page);
  record('空：反馈"还没有反馈。…"，界面问题"还没有界面问题。按 F8 报告界面问题。"', feedback.empty === EMPTY.feedback
    && issues.empty === EMPTY.issues && issues.tabs.issues.pressed && issues.exportDisabled === true
    && feedback.rows.length === 0 && issues.rows.length === 0, JSON.stringify({ feedback: feedback.empty,
    issues: issues.empty }));
  const panels = { detail: await page.getByTestId('review-detail').count(),
    session: await page.getByTestId('right-panel').count() };
  record('没有选中：不显示右栏（没有详情，也没有会话的右栏），中栏占满', panels.detail === 0 && panels.session === 0,
    JSON.stringify(panels));
  await shot(page, '1-empty');
}

/** @brief "Open folder"：还没有文件夹时先建好再打开，两节各开自己的文件夹；打不开时工具行下面显示原文。 */
async function folderEmpty(ctx) {
  const { app, page } = ctx;
  const before = { feedback: existsSync(dirOf(ctx, 'feedback')), issues: existsSync(dirOf(ctx, 'issues')) };
  await app.evaluate(clearShell);
  await chooseTab(page, 'feedback');
  await page.getByTestId('review-open-folder').click();
  await chooseTab(page, 'issues');
  await page.getByTestId('review-open-folder').click();
  const calls = await until(async () => {
    const now = await mainCalls(app);
    return now.opened.length >= 2 && now;
  }, 5000);
  const opened = calls ? calls.opened : [];
  record('"打开文件夹"：资源管理器打开这一节的文件夹 <userData>\\feedback\\、<userData>\\ui-issues\\（还没有时先建好）',
    !before.feedback && !before.issues && samePath(opened[0], dirOf(ctx, 'feedback'))
    && samePath(opened[1], dirOf(ctx, 'issues')) && existsSync(dirOf(ctx, 'feedback'))
    && existsSync(dirOf(ctx, 'issues')), JSON.stringify({ before, opened }));
  await app.evaluate(stubShell, 'Synthetic open failure');
  await page.getByTestId('review-open-folder').click();
  await page.getByTestId('review-notice').waitFor({ timeout: 5000 }).catch(() => {});
  const notice = await page.getByTestId('review-notice').innerText({ timeout: 1000 }).catch(() => '');
  record('打不开文件夹：工具行下面显示原文', notice.includes('Synthetic open failure'), notice);
  await app.evaluate(stubShell, null);
  await page.getByTestId('review-open-folder').click();
  const cleared = await page.getByTestId('review-notice').waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  record('打不开之后再试，这次打开了：工具行下面的原文消失', cleared);
}

/** @brief 收起为图标栏时"Review"是图标按钮（悬停"Review"），点它打开并高亮；返回会话回到原来的会话。 */
async function railEntry(ctx) {
  const { page } = ctx;
  await backToChat(page);
  await page.getByRole('button', { name: 'Close sidebar' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]')?.classList.contains('collapsed'),
    null, { timeout: 5000 });
  const rail = await page.getByTestId('nav-review').evaluate((el) => ({ shown: el.getClientRects().length > 0,
    name: el.getAttribute('aria-label'), title: el.getAttribute('title'), icon: Boolean(el.querySelector('svg')),
    labelHidden: getComputedStyle(el.querySelector('.nav-label')).display === 'none' }));
  await page.getByTestId('nav-review').click();
  await page.getByTestId('review-page').waitFor({ timeout: 10000 });
  const lit = await page.getByTestId('nav-review').evaluate((el) => el.classList.contains('active'));
  await shot(page, '1-rail');
  record('收起为图标栏时"工作回顾"是图标按钮（名称、悬停提示"工作回顾"），点它打开工作回顾并高亮', rail.shown
    && rail.name === 'Review' && rail.title === 'Review' && rail.icon && rail.labelHidden && lit,
  JSON.stringify({ ...rail, lit }));
  await backToChat(page);
  await page.getByRole('button', { name: /^Open sidebar/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="sidebar"]')?.classList.contains('collapsed'),
    null, { timeout: 5000 });
  const back = { file: await activeFile(page),
    lit: await page.getByTestId('nav-review').evaluate((el) => el.classList.contains('active')) };
  record('返回会话：回到原来的会话，"工作回顾"不再高亮', samePath(back.file, ctx.file) && !back.lit, JSON.stringify(back));
}

// ---------- 步骤：在界面里写下的记录 ----------

/** @brief 表单出现后写 expected 点"Save"，等"Saved"；返回那一行的文字、链接、新的记录文件名和"Saved"出现的时刻。 */
async function submitFeedback(ctx, expected) {
  const { page } = ctx;
  const before = new Set(expectedNames(ctx, 'feedback'));
  const form = page.getByTestId('feedback-form');
  await form.waitFor({ timeout: 5000 });
  await page.getByTestId('feedback-input').fill(expected);
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('feedback-saved').waitFor({ timeout: 5000 });
  const savedAt = Date.now();
  const text = await page.getByTestId('feedback-saved').innerText();
  const link = await form.getByTestId('feedback-open-review').evaluate((el) => ({ tag: el.tagName.toLowerCase(),
    text: el.textContent.trim(), textLink: el.classList.contains('text-link') })).catch(() => null);
  const name = await until(() => expectedNames(ctx, 'feedback').find((item) => !before.has(item)), 5000);
  return { text, link, name, savedAt };
}

/** @brief 等反馈表单关闭（"Saved"约 3 秒后）。 */
const formClosed = (page) => page.getByTestId('feedback-form').waitFor({ state: 'detached', timeout: 6000 })
  .then(() => true, () => false);

/** @brief 回复下的"Give feedback"：已记录一行带"View in Review"链接；不点时约 3 秒后关闭。 */
async function replyFeedback(ctx) {
  const { page } = ctx;
  await paneOf(page).getByTestId('reply-actions').last().getByRole('button', { name: 'Give feedback' }).click();
  const saved = await submitFeedback(ctx, '希望整条回复更短');
  ctx.fb.reply = saved.name;
  await noteSmall(ctx, '反馈已记录');
  record('反馈已记录："已记录 · 在工作回顾中查看"，"在工作回顾中查看"是链接（button.text-link）',
    saved.text === 'Saved · View in Review' && saved.link?.tag === 'button' && saved.link.textLink
    && saved.link.text === 'View in Review' && Boolean(saved.name), JSON.stringify(saved));
  await sleep(Math.max(0, saved.savedAt + 2000 - Date.now()));
  const still = await page.getByTestId('feedback-form').count();
  record('不点链接时表单仍约 3 秒后关闭（约 2 秒时还在，6 秒内关闭）', still === 1 && await formClosed(page),
    `2 秒时 ${still}`);
}

/** @brief 回复里选字点"Feedback"，记录后点"View in Review"：表单关闭，打开"Feedback"一节并选中这一条。 */
async function selectionFeedback(ctx) {
  const { page } = ctx;
  const index = await paneOf(page).getByTestId('assistant').count() - 1;
  await dragSelect(page, `${PANE} [data-testid="assistant"]`, '只有文字的回复', index);
  await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const saved = await submitFeedback(ctx, '希望先给结论');
  ctx.fb.selection = saved.name;
  await page.getByTestId('feedback-open-review').click();
  await page.getByTestId('review-page').waitFor({ timeout: 10000 });
  await waitLoaded(page);
  await until(async () => (await pressedRow(page)) === saved.name, 5000);
  const state = await reviewState(page);
  const detail = await detailState(page);
  const view = { form: await page.getByTestId('feedback-form').count(), pressed: state.tabs.feedback.pressed,
    selected: await pressedRow(page), inView: await rowInView(page, saved.name), expected: detail?.expected ?? null };
  await shot(page, '2-open-review-feedback');
  record('点"在工作回顾中查看"：关闭反馈表单，打开工作回顾的"对内容的反馈"，选中刚记下的这一条（右栏是它的详情）',
    view.form === 0 && view.pressed && view.selected === saved.name && view.inView && view.expected === '希望先给结论',
    JSON.stringify(view));
  await backToChat(page);
}

/** @brief 文件阅读器里选两行点"Feedback"：记下的锚点是文件和行。 */
async function fileFeedback(ctx) {
  const { page, h } = ctx;
  await h.send('看看 README');
  await h.idle(60000);
  const card = paneOf(page).getByTestId('tool-card').filter({ has: page.locator('.tool-verb', { hasText: 'Read' }) });
  await card.last().getByTestId('tool-path').click();
  await waitViewer(page);
  await selectLines(page, 1, 2);
  await popoverShown(page);
  await page.getByTestId('selection-popover').getByRole('button', { name: 'Feedback' }).click();
  const saved = await submitFeedback(ctx, '希望标题更具体');
  ctx.fb.file = saved.name;
  const source = readFeedback(ctx, saved.name)?.source;
  record('文件阅读器里选两行点"反馈"：记下的锚点是 README.md 的第 1–2 行', source?.kind === 'file'
    && samePath(source.path, join(ctx.project, 'README.md')) && source.startLine === 1 && source.endLine === 2,
  JSON.stringify(source));
  await formClosed(page);
}

/** @brief 第二个会话（之后归档它，测回到原位置先恢复）：收到回复后"Give feedback"。 */
async function secondSession(ctx) {
  const { page, h } = ctx;
  await ctrlN(page);
  await h.send('plain 第二个会话');
  await h.idle(60000);
  ctx.file2 = await activeFile(page);
  await paneOf(page).getByTestId('reply-actions').last().getByRole('button', { name: 'Give feedback' }).click();
  const saved = await submitFeedback(ctx, '第二个会话里的反馈');
  ctx.fb.second = saved.name;
  const source = readFeedback(ctx, saved.name)?.source;
  record('第二个会话里"反馈这条回复"：记下整条回复和这个会话的会话文件', source?.scope === 'reply'
    && samePath(source.sessionFile, ctx.file2) && !samePath(ctx.file2, ctx.file), JSON.stringify(source));
  await formClosed(page);
}

/** @brief 等"Saved to <路径>"，返回 Markdown 文件路径（同 m2-app.mjs）。 */
async function savedIssuePath(page) {
  const saved = page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  return /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
}

/** @brief 按 F8 写一份报告并保存；返回报告框和 Markdown 路径。 */
async function saveReport(page, what, expect) {
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByTestId('issue-expect').fill(expect);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  return { dialog, file: await savedIssuePath(page) };
}

/** @brief F8 报告（带截图）：保存后"Show in Explorer"旁边有"View in Review"，点它打开"UI issues"并选中这一份。 */
async function f8Report(ctx) {
  const { page } = ctx;
  const { dialog, file } = await saveReport(page, '列表的字太挤', '行距大一点');
  ctx.issue1 = file;
  const buttons = (await dialog.locator('button').allInnerTexts()).map((text) => text.trim());
  const at = buttons.indexOf('Show in Explorer');
  await noteSmall(ctx, 'F8 已保存');
  record('界面问题已保存：报告框里"打开所在文件夹"旁边多一个"在工作回顾中查看"', Boolean(file) && at >= 0
    && buttons[at + 1] === 'View in Review', JSON.stringify(buttons));
  await dialog.getByTestId('issue-open-review').click();
  await page.getByTestId('review-page').waitFor({ timeout: 10000 });
  await waitLoaded(page);
  const name = basename(file ?? '');
  await until(async () => (await pressedRow(page)) === name, 5000);
  await page.waitForFunction(() => document.querySelector('[data-testid="detail-shot"]')?.naturalWidth > 0, null,
    { timeout: 10000 }).catch(() => {});
  const state = await reviewState(page);
  const detail = await detailState(page);
  const view = { dialog: await page.getByTestId('issue-dialog').count(), pressed: state.tabs.issues.pressed,
    selected: await pressedRow(page), what: detail?.what, expect: detail?.expect, shot: detail?.shot };
  await shot(page, '2-open-review-issue');
  record('点"在工作回顾中查看"：关闭报告框，打开工作回顾的"界面问题"，选中这一份（右栏有它的两段和截图）',
    view.dialog === 0 && view.pressed && view.selected === name && view.what === '列表的字太挤'
    && view.expect === '行距大一点' && Boolean(view.shot?.loaded), JSON.stringify(view));
}

// ---------- 步骤：synthetic 记录与列表 ----------

/** @brief 写进 synthetic 记录后重启：两节按文件名从新到旧列出，只认 Mori 写的文件，读不出来的一行带原文。 */
async function seeded(ctx) {
  seedFeedback(ctx);
  seedIssues(ctx);
  await restart(ctx);
  ctx.posts0 = ctx.posts;
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const feedback = await reviewState(page);
  await chooseTab(page, 'issues');
  const issues = await reviewState(page);
  const want = { feedback: expectedNames(ctx, 'feedback'), issues: expectedNames(ctx, 'issues') };
  const names = { feedback: feedback.rows.map((row) => row.name), issues: issues.rows.map((row) => row.name) };
  record(`对内容的反馈：${want.feedback.length} 条按记录的时间从新到旧（文件名从新到旧，同一秒再存的 -2 在前），`
    + `只列 .json（${SEED.notJson} 不列）`, same(names.feedback, want.feedback) && !names.feedback.includes(SEED.notJson)
    && names.feedback.indexOf(SEED.sameSecond) + 1 === names.feedback.indexOf(SEED.changed),
  JSON.stringify(names.feedback));
  record(`界面问题：只列报告时间格式的 .md（${SEED.notReport}、zip、PNG 都不列），从新到旧`, same(names.issues, want.issues)
    && want.issues.length === 4 && names.issues.every((name) => ISSUE_NAME.test(name.replace(/\.md$/, ''))),
  JSON.stringify(names.issues));
  record('分节上是未处理的条数（读屏名称"对内容的反馈，N 条未处理"）；每条记录是一个行按钮',
    feedback.tabs.feedback.count === String(want.feedback.length)
    && feedback.tabs.feedback.label === `Feedback, ${want.feedback.length} unresolved`
    && issues.tabs.issues.count === String(want.issues.length)
    && feedback.rows.every((row) => row.tagName === 'button'),
  JSON.stringify({ feedback: feedback.tabs.feedback, issues: issues.tabs.issues }));
  const json = feedback.rows.find((row) => row.name === SEED.brokenJson)?.text ?? '';
  const md = issues.rows.find((row) => row.name === SEED.brokenMd)?.text ?? '';
  record('读不出来的记录：一行"读不出这份记录：<文件名>"和原文（坏的 JSON；缺"哪里不对"等标题的报告）',
    json.includes(`Couldn’t read the record ${SEED.brokenJson}`) && /JSON/.test(json)
    && md.includes(`Couldn’t read the record ${SEED.brokenMd}`) && md.includes('The report has no'),
  oneLine(`${json} | ${md}`));
  await shot(page, '3-seeded');
}

/** @brief 文件开头带 BOM 的反馈和报告照样读出；createdAt 不是时间的反馈列为读不出来。 */
async function seededReads(ctx) {
  const { page } = ctx;
  const text = async (kind, name) => {
    await chooseTab(page, kind);
    return (await reviewState(page)).rows.find((row) => row.name === name)?.text ?? '';
  };
  const bom = { feedback: await text('feedback', SEED.bom), issue: await text('issues', SEED.noShot) };
  const badTime = await text('feedback', SEED.badTime);
  record('文件开头带 BOM 的反馈和报告（在"UTF-8 带 BOM"的编辑器里另存过）照样读出；createdAt 不是时间的反馈列为读不出来',
    bom.feedback.includes('synthetic：带 BOM 的反馈') && bom.issue.includes('synthetic：没有截图的报告')
    && !`${bom.feedback}${bom.issue}`.includes('Couldn’t read the record')
    && badTime.includes(`Couldn’t read the record ${SEED.badTime}`)
    && badTime.includes('createdAt'), oneLine(`${bom.feedback} | ${bom.issue} | ${badTime}`));
}

/** @brief 不监视文件夹：页面开着时写进来的记录要下次打开才看到；记录被删后重新读取，列表里没有它、详情关闭。 */
async function noWatch(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'feedback');
  const file = join(dirOf(ctx, 'feedback'), SEED.late);
  writeFileSync(file, feedbackJson('2024-06-16T04:00:00.000Z', 'synthetic：别的程序写进来的', 'synthetic：原文',
    messageAnchor(null, 'reply'), { file: null, cwd: ctx.project, title: 'synthetic' }));
  await sleep(1500);
  const listed = async () => (await reviewState(page)).rows.some((row) => row.name === SEED.late);
  const before = await listed();
  await backToChat(page);
  await watchSeen(page, ['review-loading']);
  await openReviewPage(page, 'feedback');
  const seen = await seenNow(page);
  const after = await until(listed, 5000);
  record('不监视文件夹：页面开着时别的程序写进来的记录不出现，下次打开工作回顾才看到', !before && Boolean(after),
    JSON.stringify({ before, after }));
  record('重新读取（已有上一次的列表）时也显示"正在读取…"，读完消失', seen['review-loading']
    && await page.getByTestId('review-loading').count() === 0, JSON.stringify(seen));
  await selectRow(page, SEED.late);
  rmSync(file);
  await backToChat(page);
  await openReviewPage(page, 'feedback');
  const gone = await until(async () => !(await listed()), 5000);
  const detail = await page.getByTestId('review-detail').count();
  record('记录不在了（文件被删了）：重新读取后列表里没有它，右栏的详情关闭', Boolean(gone) && detail === 0,
    JSON.stringify({ gone, detail }));
}

/** @brief 在侧栏把第一个会话改名，等侧栏显示新名字。 */
async function renameFirst(ctx) {
  const input = await startRename(ctx.page, ctx.file);
  await input.fill(RENAMED);
  await input.press('Enter');
  await renameClosed(ctx.page);
  return waitRowTitle(ctx.page, ctx.file, RENAMED);
}

/** @brief 真的反馈的一行摘要：期望、原文第一行、来源（改名后的会话名 · 范围 / 相对路径和行）和时间。 */
async function feedbackRows(ctx) {
  const { page } = ctx;
  const renamed = await renameFirst(ctx);
  await chooseTab(page, 'feedback');
  const textOf = async (name) => (await reviewState(page)).rows.find((row) => row.name === name)?.text ?? '';
  await until(async () => (await textOf(ctx.fb.reply)).includes(RENAMED), 5000);
  const rows = Object.fromEntries((await reviewState(page)).rows.map((row) => [row.name, row.text]));
  const time = (name) => shortOf(feedbackTime(readFeedback(ctx, name).createdAt));
  const has = (name, parts) => parts.every((part) => (rows[name] ?? '').includes(part));
  const year = `${new Date().getFullYear()}-`;
  record('反馈一行（整条回复）：你的期望、原文第一行、"<会话名> · 整条回复"、时间 MM-DD HH:mm（今年的不带年份）；'
    + '会话名是侧栏现在的名字（改名后）', renamed && has(ctx.fb.reply, ['希望整条回复更短', REPLY,
    `${RENAMED} · Whole response`, time(ctx.fb.reply)]) && !(rows[ctx.fb.reply] ?? '').includes(year),
  oneLine(rows[ctx.fb.reply] ?? ''));
  record('反馈一行（回复里的选区）："<会话名> · 回复里的选区"，原文是选中的字', has(ctx.fb.selection, ['希望先给结论',
    '只有文字的回复', `${RENAMED} · Selection in response`, time(ctx.fb.selection)]), oneLine(rows[ctx.fb.selection] ?? ''));
  record('反馈一行（文件里的）："README.md 第 1–2 行"（按工作目录的相对路径），原文第一行', has(ctx.fb.file,
    ['希望标题更具体', TITLE, 'README.md · lines 1–2', time(ctx.fb.file)]), oneLine(rows[ctx.fb.file] ?? ''));
  await noteSmall(ctx, '对内容的反馈列表');
}

/**
 * @brief synthetic 反馈的一行：不是今年的带年份、原文只显示第一行、找得到会话时用侧栏的名字、找不到时用记录里的名字、
 *        工作目录外的文件显示完整路径；长期望最多两行。
 */
async function seededRows(ctx) {
  const { page } = ctx;
  const rows = Object.fromEntries((await reviewState(page)).rows.map((row) => [row.name, row.text]));
  const time = shortOf(feedbackTime(readFeedback(ctx, SEED.changed).createdAt));
  const changed = rows[SEED.changed] ?? '';
  record('不是今年的记录时间带年份；原文只显示第一行；找得到会话时用侧栏现在的名字（不是记录里的名字）',
    time.startsWith('2024-') && changed.includes(time) && changed.includes('synthetic 第一行')
    && !changed.includes('synthetic 第二行') && changed.includes(`${RENAMED} · Selection in response`)
    && !changed.includes('synthetic 记录里的名字'), oneLine(changed));
  record('找不到会话时用记录里的名字（已删除的、没有保存的）', (rows[SEED.gone] ?? '').includes(
    'synthetic 已删除的会话 · Whole response')
    && (rows[SEED.unsaved] ?? '').includes('synthetic 没有保存的会话 · Selection in response'),
  oneLine(`${rows[SEED.gone]} | ${rows[SEED.unsaved]}`));
  record('不在工作目录里的文件显示完整路径（"<路径> 第 3–4 行"）', (rows[SEED.outside] ?? '').includes(
    `${ctx.outsideFile} · lines 3–4`), oneLine(rows[SEED.outside] ?? ''));
  const clamp = await linesOf(page, SEED.changed, 'synthetic：这条期望很长');
  record('你的期望最多显示 2 行（长期望在行里截断）', Boolean(clamp) && clamp.lines >= 1 && clamp.lines <= 2,
    JSON.stringify(clamp));
}

/** @brief 界面问题的一行摘要："What went wrong"（没有填写时用"What you expected"）、时间、没有截图时标"No screenshot"。 */
async function issueRows(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'issues');
  const rows = Object.fromEntries((await reviewState(page)).rows.map((row) => [row.name, row.text]));
  const first = basename(ctx.issue1);
  const time = shortOf(reportTime(ctx.issue1));
  record('界面问题一行："哪里不对"和时间（MM-DD HH:mm）；有截图时没有"没有截图"', (rows[first] ?? '').includes('列表的字太挤')
    && rows[first].includes(time) && !rows[first].includes('No screenshot'), oneLine(rows[first] ?? ''));
  const noShot = rows[SEED.noShot] ?? '';
  record('界面问题一行：没有截图时标"没有截图"；不是今年的带年份', noShot.includes('synthetic：没有截图的报告')
    && noShot.includes('No screenshot') && noShot.includes('2024-06-15 12:00'), oneLine(noShot));
  const only = rows[SEED.onlyExpect] ?? '';
  record('界面问题一行："哪里不对"没有填写时用"你期望什么"', only.includes('synthetic：只写了你期望什么')
    && !only.includes('(left blank)'), oneLine(only));
  await noteSmall(ctx, '界面问题列表');
}

// ---------- 步骤：详情 ----------

/** @brief 反馈的详情：右栏（aside.right-panel、分隔线）、标题和 ×、完整时间、来源、全文、回到原位置、标为已处理；关闭。 */
async function feedbackDetail(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'feedback');
  const detail = await selectRow(page, ctx.fb.reply);
  const center = await page.getByTestId('review-page').boundingBox();
  const frame = { right: Math.round(center.x + center.width), session: await page.getByTestId('right-panel').count() };
  record('点一条：右栏打开详情（aside.right-panel，读屏名称"工作回顾的详情"，有分隔线），中栏让出位置，没有会话的右栏',
    detail.tag === 'aside' && detail.panel && detail.label === 'Review details' && detail.divider
    && frame.right <= detail.left + 1 && frame.session === 0, JSON.stringify({ ...frame, left: detail.left }));
  const stored = readFeedback(ctx, ctx.fb.reply);
  record('反馈的详情：标题"对内容的反馈"和"关闭详情"；完整时间；来源（会话名、整条回复、工作目录）；期望和原文全文；'
    + '"回到原位置"；"标为已处理"', detail.heading.includes(LABEL.feedback) && detail.close
    && (detail.time ?? '').startsWith(feedbackTime(stored.createdAt).slice(0, 16))
    && (detail.source ?? '').includes(RENAMED) && detail.source.includes('Whole response')
    && detail.source.includes(ctx.project) && detail.expected === '希望整条回复更短' && detail.quote === REPLY
    && detail.jump?.text === 'Jump to source' && !detail.jump.disabled && !detail.jumpStatus
    && detail.handled === 'Resolve', JSON.stringify({ ...detail, text: undefined }));
  await noteSmall(ctx, '反馈的详情');
  await shot(page, '4-feedback-detail');
  const file = await selectRow(page, ctx.fb.file);
  record('文件里的反馈：来源是文件和行范围（README.md 第 1–2 行）和工作目录', (file.source ?? '').includes(
    'README.md · lines 1–2') && file.source.includes(ctx.project), file.source ?? '');
  const long = await selectRow(page, SEED.changed);
  record('详情里"你希望得到的结果"是全文（摘要里最多两行）；"引用的原文"每一行都在，太长时在框里滚动（框不超过 300px）',
    long.expected === LONG_EXPECTED && (long.quote ?? '').includes('synthetic 第二行')
    && long.quote.includes('synthetic 第 202 行') && ['auto', 'scroll'].includes(long.quoteScroll)
    && long.quoteBox.scroll > long.quoteBox.client + 20 && long.quoteBox.client <= 300,
  JSON.stringify({ length: long.expected?.length, quote: long.quote?.length, scroll: long.quoteScroll,
    box: long.quoteBox }));
  await page.getByTestId('review-detail').getByRole('button', { name: 'Close details' }).click();
  const closed = { detail: await page.getByTestId('review-detail').count(), pressed: await pressedRow(page) };
  record('关闭（×）：详情关闭，中栏占满，没有行高亮', closed.detail === 0 && closed.pressed === null, JSON.stringify(closed));
}

/**
 * @brief 列表没有横向滚动条：详情开着长期望那一条，窗口为默认大小、1200、1024、800 px 宽时，这一条滚进视野，
 *        列表滚动区域和中栏都不比可见宽度宽，每一行、这一行里的每一段都不超出列表；期望最多两行并截断，单行的段落
 *        截断时有省略号；详情也没有横向溢出。
 */
async function noSideScroll(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await chooseTab(page, 'feedback');
  await selectRow(page, SEED.changed);
  const seen = [];
  try {
    for (const width of [size[0], 1200, 1024, 800]) {
      await resizeWindow(app, width, size[1]);
      await rowAt(page, SEED.changed).scrollIntoViewIfNeeded();
      seen.push(await sideOverflow(page, SEED.changed));
      await shot(page, `4-no-side-scroll-${width}`);
    }
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
  const fits = (item) => item.page[0] <= item.page[1] && item.content[0] <= item.content[1] && item.listInside
    && item.wideRows.length === 0 && item.wideParts.length === 0;
  const all = (test) => seen.length === 4 && seen.every((item) => Boolean(item) && test(item));
  record('列表没有横向滚动条：默认大小、1200、1024、800 px 宽时 .review-content 的 scrollWidth 不超过 clientWidth，'
    + '每一行的右边不超出列表（长期望那一条在视野里）', all((item) => fits(item) && item.visible), JSON.stringify(seen));
  const brief = (item) => item && { width: item.width, title: item.title, cut: item.cut, plain: item.plain };
  record('长期望在行里最多两行并截断；原文、来源、错误这类单行放不下时以省略号截断', all((item) => item.title.lines >= 1
    && item.title.lines <= 2 && item.title.clamped && item.plain === 0), JSON.stringify(seen.map(brief)));
  const detail = (item) => item && [item.width, item.detail, item.detailParts];
  record('详情没有横向溢出（同上四个宽度）', all((item) => Boolean(item.detail) && item.detail[0] <= item.detail[1]
    && item.detailParts === 0), JSON.stringify(seen.map(detail)));
  await page.getByTestId('review-detail').getByRole('button', { name: 'Close details' }).click();
}

/** @brief 依次展开"Current view""Recent activity""Versions"，返回每节展开前是否打开和展开后的样子。 */
async function expandMore(page) {
  const keys = { 'detail-view': 'view', 'detail-actions': 'actions', 'detail-versions': 'versions' };
  const result = [];
  for (const [id, key] of Object.entries(keys)) {
    const before = (await detailState(page))?.[key]?.open ?? null;
    await page.getByTestId(id).locator('summary').click();
    await settle(page);
    result.push({ id, before, after: (await detailState(page))?.[key] ?? null });
  }
  return result;
}

/** @brief 界面问题的详情：截图读取中再显示（按右栏宽度缩小）、两段全文、可以展开的三节、打开所在文件夹。 */
async function issueDetail(ctx) {
  const { app, page } = ctx;
  await chooseTab(page, 'issues');
  await watchSeen(page, ['detail-shot-loading']);
  await selectRow(page, basename(ctx.issue1));
  await page.waitForFunction(() => document.querySelector('[data-testid="detail-shot"]')?.naturalWidth > 0, null,
    { timeout: 10000 }).catch(() => {});
  const seen = await seenNow(page);
  const detail = await detailState(page);
  record('界面问题的详情：标题"界面问题"和 ×；时间；"哪里不对""你期望什么"全文；截图先"正在读取截图…"，读完按右栏宽度缩小',
    detail.heading.includes(LABEL.issues) && detail.close && (detail.time ?? '').startsWith(reportTime(ctx.issue1)
      .slice(0, 16)) && detail.what === '列表的字太挤' && detail.expect === '行距大一点' && seen['detail-shot-loading']
    && detail.shot?.loaded && detail.shot.width <= detail.width && detail.shot.width < detail.shot.natural,
  JSON.stringify({ seen, ...detail, text: undefined }));
  const more = await expandMore(page);
  const [view, actions, versions] = more.map((item) => item.after);
  record('"当前界面""最近的操作""版本"默认收起、可以展开，展开后是报告里的原文（保留换行）', more.every((item) => item.before
    === false && item.after?.open && item.after.wrap === 'pre-wrap') && view.summary === 'Current view'
    && view.text.includes('Page: Session') && actions.summary === 'Recent activity'
    && actions.text.includes('Report a UI issue') && versions.summary === 'Versions'
    && versions.text.includes('Electron'), JSON.stringify(more));
  await noteSmall(ctx, '界面问题的详情（展开）');
  await shot(page, '4-issue-detail');
  await app.evaluate(clearShell);
  await page.getByTestId('detail-show-file').click();
  const revealed = await firstRevealed(app);
  record('"打开所在文件夹"：资源管理器里选中这份报告', samePath(revealed, ctx.issue1), String(revealed));
}

/** @brief 放大截图：浮层显示截图、缩到窗口内、有"Close"；Esc、点外面、"Close"都关闭，焦点回到截图。 */
async function shotViewer(ctx) {
  const { page } = ctx;
  const zoom = page.getByTestId('review-detail').getByRole('button', { name: 'View full screenshot' });
  const viewer = page.getByTestId('shot-viewer');
  const gone = () => viewer.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);
  await zoom.click();
  await viewer.waitFor({ timeout: 5000 });
  const opened = await viewerOverlay(page);
  await noteSmall(ctx, '放大截图');
  await shot(page, '4-shot-viewer');
  await page.keyboard.press('Escape');
  const esc = { closed: await gone(), focus: await focusedLabel(page),
    detail: await page.getByTestId('review-detail').count() };
  record('放大截图：浮层（role=dialog，读屏名称"截图"，挂在 body 下）显示截图、缩到窗口内，有"关闭"；'
    + 'Esc 关闭（详情还在），焦点回到截图', opened?.role === 'dialog' && opened.label === 'Screenshot'
    && opened.outsideApp && opened.loaded && opened.fits && opened.close && esc.closed
    && esc.focus === 'View full screenshot' && esc.detail === 1,
  JSON.stringify({ opened, esc }));
  await zoom.focus();
  await page.keyboard.press('Enter');
  await viewer.waitFor({ timeout: 5000 });
  const point = await outsidePoint(page);
  if (point) await page.mouse.click(point.x, point.y);
  const outside = { point, closed: await gone(), focus: await focusedLabel(page) };
  await zoom.click();
  await viewer.waitFor({ timeout: 5000 });
  await viewer.getByRole('button', { name: 'Close' }).click();
  const button = { closed: await gone(), focus: await focusedLabel(page) };
  record('焦点在截图上按 Enter 也放大；点截图外面、点"关闭"都关闭，焦点回到截图', Boolean(point) && outside.closed
    && outside.focus === 'View full screenshot' && button.closed && button.focus === 'View full screenshot',
  JSON.stringify({ outside, button }));
}

/** @brief 读不出来的记录的详情；没有截图的报告；列表读完后、打开工作回顾之前 PNG 被删了（截图读不出来）。 */
async function brokenDetail(ctx) {
  const { app, page } = ctx;
  await chooseTab(page, 'feedback');
  const json = await selectRow(page, SEED.brokenJson);
  await app.evaluate(clearShell);
  await page.getByTestId('detail-show-file').click();
  const shown = await firstRevealed(app);
  record('读不出来的反馈：详情里文件名和原文、"打开所在文件夹"（资源管理器里选中它）、"标为已处理"，没有"回到原位置"',
    (json.broken ?? '').includes(SEED.brokenJson) && /JSON/.test(json.broken) && json.handled === 'Resolve'
    && !json.jump && samePath(shown, join(dirOf(ctx, 'feedback'), SEED.brokenJson)),
  JSON.stringify({ broken: json.broken, handled: json.handled, shown }));
  await chooseTab(page, 'issues');
  const md = await selectRow(page, SEED.brokenMd);
  await app.evaluate(clearShell);
  await page.getByTestId('review-detail').getByRole('button', { name: 'Show in Explorer' }).click();
  const revealed = await firstRevealed(app);
  record('读不出来的报告：详情里文件名和原文、"打开所在文件夹"（资源管理器里选中它）、"标为已处理"',
    (md.broken ?? '').includes(SEED.brokenMd) && md.broken.includes('The report has no') && md.handled === 'Resolve'
    && samePath(revealed, join(dirOf(ctx, 'issues'), SEED.brokenMd)), JSON.stringify({ broken: md.broken, revealed }));
  const noShot = await selectRow(page, SEED.noShot);
  record('没有截图的报告：详情里"截图失败：Synthetic capture failure"，没有截图', noShot.text.includes(
    'Couldn’t capture a screenshot: Synthetic capture failure') && !noShot.shot, noShot.shotError ?? '');
  rmSync(join(dirOf(ctx, 'issues'), SEED.onlyExpect.replace(/\.md$/, '.png')));
  await selectRow(page, SEED.onlyExpect);
  const failed = await page.getByTestId('detail-shot-error').innerText({ timeout: 5000 }).catch(() => '');
  record('截图读不出来（列表读完后 PNG 被删了）：详情里"截图读不出来："和原文', failed.startsWith('Couldn’t load the screenshot: ')
    && failed.length > 'Couldn’t load the screenshot: '.length, failed);
  await backToChat(page);
  await openReviewPage(page, 'issues');
  const row = (await reviewState(page)).rows.find((item) => item.name === SEED.onlyExpect)?.text ?? '';
  await selectRow(page, SEED.onlyExpect);
  const reread = await page.getByTestId('detail-shot-error').innerText({ timeout: 5000 }).catch(() => '');
  record('截图读不出来（打开工作回顾之前 PNG 就被删了）：这一行不标"没有截图"，详情里"截图读不出来："和原文，'
    + '不说"截图失败"', Boolean(row) && !row.includes('No screenshot')
    && reread.startsWith('Couldn’t load the screenshot: '),
  oneLine(`${row} | ${reread}`));
}

/** @brief ↓ ↓ ↑ 在行之间移动焦点，Enter 打开详情。 */
async function keyboardRows(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'feedback');
  const names = (await reviewState(page)).rows.map((row) => row.name);
  await rowAt(page, names[0]).focus();
  const seen = [];
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(key);
    seen.push(await focusedRow(page));
  }
  await page.keyboard.press('Enter');
  await settle(page);
  const selected = await pressedRow(page);
  const detail = await page.getByTestId('review-detail').count();
  record('键盘：↑ ↓ 在行之间移动焦点，Enter 打开详情', same(seen, [names[1], names[2], names[1]])
    && selected === names[1] && detail === 1, JSON.stringify({ seen, selected, names: names.slice(0, 3) }));
}

/**
 * @brief 分节各自记住选中的记录和滚动位置：选中第一行再滚到最下面（选中的一行在视野外），切换分节、离开再回来，
 *        滚动位置不被拉回选中的那一行（窗口调矮，列表才滚得动）。
 */
async function sectionMemory(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await resizeWindow(app, 1100, 600);
  try {
    await chooseTab(page, 'feedback');
    const names = (await reviewState(page)).rows.map((row) => row.name);
    const pick = names[0];
    await selectRow(page, pick);
    await listScroll(page, names.at(-1));
    await sleep(400);
    const before = await listScroll(page);
    const outOfView = !(await rowInView(page, pick));
    const issue = basename(ctx.issue1);
    await chooseTab(page, 'issues');
    await selectRow(page, issue);
    await chooseTab(page, 'feedback');
    const switched = { scroll: await listScroll(page), selected: await pressedRow(page) };
    await backToChat(page);
    await openReviewPage(page);
    const revisit = { tab: (await reviewState(page)).tabs.feedback.pressed, scroll: await listScroll(page),
      selected: await pressedRow(page) };
    await chooseTab(page, 'issues');
    const other = await pressedRow(page);
    const near = (now) => Boolean(now && before) && Math.abs(now.top - before.top) <= 2;
    record('分节各自记住选中的记录和滚动位置（选中的一行滚出视野后，切换分节、离开工作回顾再回来，滚动位置不变、'
      + '选中的还在）', before?.top > 0 && outOfView && near(switched.scroll) && switched.selected === pick
      && revisit.tab && near(revisit.scroll) && revisit.selected === pick && other === issue,
    JSON.stringify({ pick, before, outOfView, switched, revisit, other }));
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
}

/**
 * @brief "View in Review"把刚记下的一行滚到看得见的地方：列表记住的滚动位置在最下面（最上面的新记录在视野外）时
 *        也一样（窗口调矮，列表才滚得动）。
 */
async function revealSaved(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await resizeWindow(app, 1100, 600);
  try {
    await chooseTab(page, 'feedback');
    const names = (await reviewState(page)).rows.map((row) => row.name);
    await listScroll(page, names.at(-1));
    await sleep(400);
    const before = await listScroll(page);
    await backToChat(page);
    await openRow(page, ctx.file);
    await waitReady(page);
    await paneOf(page).getByTestId('reply-actions').last().getByRole('button', { name: 'Give feedback' }).click();
    const saved = await submitFeedback(ctx, '希望回到列表时看得见这一条');
    await page.getByTestId('feedback-open-review').click();
    await page.getByTestId('review-page').waitFor({ timeout: 10000 });
    await waitLoaded(page);
    await until(async () => (await pressedRow(page)) === saved.name, 5000);
    await sleep(300);
    const view = { before, top: (await reviewState(page)).rows[0]?.name, inView: await rowInView(page, saved.name) };
    record('列表记住的滚动位置在最下面时点"在工作回顾中查看"：刚记下的这一条（最上面）滚到看得见的地方',
      before?.top > 0 && view.top === saved.name && view.inView, JSON.stringify({ saved: saved.name, ...view }));
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
}

// ---------- 步骤：已处理与"Hide resolved" ----------

/** @brief 标为已处理：变淡、标"Resolved"、数字少一、按钮变"Reopen"、本机存了。 */
async function handled(ctx) {
  const { page } = ctx;
  ctx.snap = snapshots(ctx);
  await chooseTab(page, 'feedback');
  const total = expectedNames(ctx, 'feedback').length;
  await selectRow(page, ctx.fb.reply);
  await page.getByTestId('detail-handled').click();
  await until(async () => (await reviewState(page)).rows.find((row) => row.name === ctx.fb.reply)?.handled, 3000);
  const state = await reviewState(page);
  const row = state.rows.find((item) => item.name === ctx.fb.reply);
  const dim = await rowDim(page, [ctx.fb.reply, '希望整条回复更短'], [ctx.fb.selection, '希望先给结论']);
  const detail = await detailState(page);
  record('标为已处理：这一行变淡并标"已处理"，分节上的数字少一（读屏名称跟着变），按钮变成"标为未处理"', row?.handled
    && row.tag === 'Resolved' && dim.dim && state.tabs.feedback.count === String(total - 1)
    && state.tabs.feedback.label === `Feedback, ${total - 1} unresolved` && detail.handled === 'Reopen',
  JSON.stringify({ row: row && { ...row, text: undefined }, dim, tab: state.tabs.feedback, button: detail.handled }));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mori.review') ?? 'null'));
  record('已处理记在本机界面状态（localStorage 的 mori.review，按"文件夹/文件名"），开关默认关',
    same(stored?.handled, [`feedback/${ctx.fb.reply}`]) && stored.hideHandled === false, JSON.stringify(stored));
  await noteSmall(ctx, '已处理的行');
  await shot(page, '5-handled');
}

/** @brief 打开"Hide resolved"：已处理的不列出、数字不变、详情还在；马上"Reopen"又列出；再标回已处理详情不消失。 */
async function hideHandled(ctx) {
  const { page } = ctx;
  const total = expectedNames(ctx, 'feedback').length;
  await page.getByTestId('review-hide-handled').click();
  const hidden = await reviewState(page);
  const kept = await detailState(page);
  record('打开"隐藏已处理"：已处理的不列出，分节上的数字不变（未处理的条数），右栏的详情还在、按钮是"标为未处理"',
    hidden.hide.checked === 'true' && !hidden.rows.some((row) => row.name === ctx.fb.reply)
    && hidden.rows.length === total - 1 && hidden.tabs.feedback.count === String(total - 1)
    && kept?.expected === '希望整条回复更短' && kept.handled === 'Reopen', JSON.stringify({ hide: hidden.hide,
    rows: hidden.rows.length, count: hidden.tabs.feedback.count, kept: kept?.handled }));
  await page.getByTestId('detail-handled').click();
  const back = await reviewState(page);
  const row = back.rows.find((item) => item.name === ctx.fb.reply);
  record('开关开着时马上"标为未处理"：回到平常的样子（重新列出、不标"已处理"、数字加回）', Boolean(row) && !row.handled
    && !row.tag && back.tabs.feedback.count === String(total), JSON.stringify({ row: row && { ...row, text: undefined },
    count: back.tabs.feedback.count }));
  await page.getByTestId('detail-handled').click();
  const again = await reviewState(page);
  const still = await detailState(page);
  record('反例：开关开着时标了已处理，这一行马上不列出，详情不会跟着消失（还能"标为未处理"）',
    !again.rows.some((item) => item.name === ctx.fb.reply) && still?.handled === 'Reopen',
    JSON.stringify({ rows: again.rows.length, still: still?.handled }));
  await page.getByTestId('review-detail').getByRole('button', { name: 'Close details' }).click();
  await settle(page);
  const focus = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
  record('这时关闭详情（这一行没有列出）：焦点回到"对内容的反馈"分节按钮，不掉到页面外', focus === 'review-tab-feedback',
    String(focus));
}

/** @brief 界面问题都标已处理：都已隐藏的说明、导出不可用、没有数字；关掉开关全部列出；之后留两份已处理、开关打开。 */
async function allHidden(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'issues');
  const names = expectedNames(ctx, 'issues');
  for (const name of names) {
    await selectRow(page, name);
    await page.getByTestId('detail-handled').click();
    await until(async () => !(await reviewState(page)).rows.some((row) => row.name === name), 3000);
  }
  const state = await reviewState(page);
  const hidden = `No unresolved records · ${names.length} resolved ${names.length === 1 ? 'record' : 'records'} hidden`;
  record(`都已隐藏："没有未处理的记录 · 已处理的 ${names.length} 条已隐藏"，导出不可用，分节上没有数字`,
    state.allHidden === hidden && state.rows.length === 0
    && state.exportDisabled === true && state.tabs.issues.count === null
    && state.tabs.issues.label === 'UI issues, 0 unresolved', JSON.stringify({ ...state, rows: state.rows.length }));
  await shot(page, '5-all-hidden');
  await page.getByTestId('review-hide-handled').click();
  const shown = await reviewState(page);
  record('关掉"隐藏已处理"：全部列出，已处理的都标"已处理"', shown.hide.checked === 'false'
    && shown.rows.length === names.length && shown.rows.every((row) => row.handled && row.tag === 'Resolved'),
  JSON.stringify(shown.rows.map((row) => [row.name, row.handled])));
  for (const name of [basename(ctx.issue1), SEED.onlyExpect]) {
    await selectRow(page, name);
    await page.getByTestId('detail-handled').click();
  }
  await page.getByTestId('review-hide-handled').click();
}

/** @brief 重启后标记和开关都还在；打开、标记、重启都没有改反馈和报告文件。 */
async function handledRestart(ctx) {
  await restart(ctx);
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const feedback = await reviewState(page);
  await chooseTab(page, 'issues');
  const issues = await reviewState(page);
  const total = expectedNames(ctx, 'feedback').length;
  const left = expectedNames(ctx, 'issues').filter((name) => ![SEED.noShot, SEED.brokenMd].includes(name));
  record('重启后已处理的标记和"隐藏已处理"都还在（mori.review）', feedback.hide.checked === 'true'
    && !feedback.rows.some((row) => row.name === ctx.fb.reply) && feedback.tabs.feedback.count === String(total - 1)
    && same(issues.rows.map((row) => row.name), left), JSON.stringify({ hide: feedback.hide,
    issues: issues.rows.map((row) => row.name) }));
  const now = snapshots(ctx);
  const changed = [...changedFiles(ctx.snap.feedback, now.feedback), ...changedFiles(ctx.snap.issues, now.issues)];
  record('反例：打开工作回顾、标已处理、重启都不改反馈和报告文件（大小、修改时间、内容都不变）', changed.length === 0,
    changed.join(', '));
}

// ---------- 步骤：导出与打开文件夹 ----------

/** @brief 取消保存对话框：什么都不变；对话框的标题和默认文件名（在"文档"里）。 */
async function exportCancel(ctx) {
  const { app, page } = ctx;
  await chooseTab(page, 'feedback');
  const { dialog } = await exportTo(ctx, null);
  const documents = await app.evaluate(({ app: main }) => main.getPath('documents'));
  const notice = await page.getByTestId('review-notice').count();
  record('导出：保存对话框标题"导出对内容的反馈"，默认文件名"对内容的反馈-<今天>.md"，默认放在"文档"里',
    dialog?.title === 'Export as Markdown' && basename(dialog.defaultPath ?? '') === `feedback-${today()}.md`
    && samePath(dirname(dialog.defaultPath), documents), JSON.stringify({ dialog, documents }));
  record('取消保存对话框：什么都不变（没有写文件，没有提示）', notice === 0 && readdirSync(ctx.exportDir).length === 0,
    JSON.stringify({ notice, files: readdirSync(ctx.exportDir) }));
}

/**
 * @brief 导出对内容的反馈：开关开着时只导出列出的、顺序与列表相同；"Exported N records to <路径>"和打开所在文件夹；
 *        关掉开关后全部导出（checkFeedbackSections）。
 */
async function exportFeedback(ctx) {
  const { app, page } = ctx;
  const listed = (await reviewState(page)).rows.map((row) => row.name);
  const hiddenFile = join(ctx.exportDir, 'feedback-hidden.md');
  const { md } = await exportTo(ctx, hiddenFile);
  const head = mdHead(md);
  const sections = mdSections(md);
  record('导出（"隐藏已处理"开着）：只含列出的记录，顺序与列表相同、按序号；开头"# 对内容的反馈"和'
    + '"导出于 … · 共 N 条：未处理 N 条，已处理 0 条"', head.title === '# Feedback' && head.total === listed.length
    && head.open === listed.length && head.done === 0 && same(sections.map((item) => item.name), listed)
    && !listed.includes(ctx.fb.reply) && sections.every((item, index) => item.heading.startsWith(`## ${index + 1}. `)),
  JSON.stringify({ head, names: sections.map((item) => item.name) }));
  const notice = await noticeText(page, 'Exported ');
  await app.evaluate(clearShell);
  await page.getByTestId('review-notice').getByRole('button', { name: 'Show in Explorer' }).click();
  const revealed = await firstRevealed(app);
  record('已导出：工具行下面"已导出 N 条到 <路径>"和"打开所在文件夹"（资源管理器里选中导出的文件）', notice.startsWith(
    `Exported ${records(listed.length)} to ${hiddenFile}`) && samePath(revealed, hiddenFile),
  JSON.stringify({ notice, revealed }));
  await noteSmall(ctx, '已导出');
  await page.getByTestId('review-hide-handled').click();
  const all = await exportTo(ctx, join(ctx.exportDir, 'feedback-all.md'));
  checkFeedbackSections(ctx, all.md);
}

/** @brief 全部导出的反馈：已处理的注明"Resolved"，每条的来源、期望和引用块，读不出来的写文件名和原文。 */
function checkFeedbackSections(ctx, md) {
  const head = mdHead(md);
  const sections = Object.fromEntries(mdSections(md).map((item) => [item.name, item]));
  const total = expectedNames(ctx, 'feedback').length;
  record('关掉开关再导出：全部记录，已处理的标"已处理"、其余"未处理"（"共 N 条：未处理 N-1 条，已处理 1 条"）',
    head.total === total && head.done === 1 && head.open === total - 1
    && Boolean(sections[ctx.fb.reply]?.heading.endsWith(' · Resolved'))
    && Boolean(sections[ctx.fb.selection]?.heading.endsWith(' · Unresolved')), JSON.stringify(head));
  const reply = sections[ctx.fb.reply]?.text ?? '';
  const time = feedbackTime(readFeedback(ctx, ctx.fb.reply).createdAt);
  record('导出的反馈一节："## <序号>. <时间> · <状态>"，来源（范围、会话文件、工作目录）、"### 你希望得到的结果"、'
    + '"### 引用的原文"（每行前加 "> "）', reply.split('\n')[0].endsWith(`${time} · Resolved`) && reply.includes('Whole response')
    && reply.toLowerCase().includes(ctx.file.toLowerCase()) && reply.includes(ctx.project)
    && reply.includes('### What you hoped for\n\n希望整条回复更短') && reply.includes(`### Quoted text\n\n> ${REPLY}`)
    && Boolean(sections[SEED.changed]?.text.includes('> synthetic 第一行：这段原文不在会话里\n> synthetic 第二行')),
  oneLine(reply, 400));
  record('导出里读不出来的记录：一节，写文件名和原文', Boolean(sections[SEED.brokenJson]?.heading.includes(SEED.brokenJson))
    && sections[SEED.brokenJson].text.includes('Couldn’t read this record: '),
  oneLine(sections[SEED.brokenJson]?.text ?? '', 300));
}

/** @brief 导出界面问题到别的文件夹：报告各节降一级，截图链接是到原来 PNG 的相对路径，不复制截图。 */
async function exportIssues(ctx) {
  const { page } = ctx;
  await chooseTab(page, 'issues');
  const listed = (await reviewState(page)).rows.map((row) => row.name);
  const { dialog, md } = await exportTo(ctx, join(ctx.exportDir, 'issues.md'));
  const head = mdHead(md);
  const sections = mdSections(md);
  record('导出界面问题：对话框标题"导出界面问题"、默认文件名"界面问题-<今天>.md"；开头"# 界面问题"和条数；顺序与列表相同',
    dialog?.title === 'Export as Markdown' && basename(dialog.defaultPath ?? '') === `ui-issues-${today()}.md`
    && head.title === '# UI issues' && head.total === listed.length && head.done === 2
    && same(sections.map((item) => item.name), listed), JSON.stringify({ dialog, head,
    names: sections.map((item) => item.name) }));
  const first = sections.find((item) => item.name === basename(ctx.issue1))?.text ?? '';
  const headings = ['What went wrong', 'What you expected', 'Screenshot', 'Current view', 'Recent activity',
    'Versions'];
  record('导出的报告一节：报告文件的完整路径，原来的各节标题降一级（### 哪里不对 … ### 版本），没有 "## 哪里不对"',
    headings.every((title) => first.includes(`\n### ${title}\n`)) && first.includes(ctx.issue1)
    && !new RegExp(`^## (${headings.join('|')})$`, 'm').test(md), oneLine(first, 300));
  const link = shotLink(first);
  const png = ctx.issue1.replace(/\.md$/, '.png');
  const target = (href) => href && resolve(ctx.exportDir, ...href.split('/').map(decodeURIComponent));
  const deleted = shotLink(sections.find((item) => item.name === SEED.onlyExpect)?.text ?? '');
  record('截图链接：从导出文件所在的文件夹到原来那张 PNG 的相对路径（用 /，每段按网址编码）；PNG 已被删了的照样链接原来的'
    + ' PNG；没有截图的写"截图失败："', Boolean(link) && !isAbsolute(link) && !link.includes('\\')
    && samePath(target(link), png)
    && samePath(target(deleted), join(dirOf(ctx, 'issues'), SEED.onlyExpect.replace(/\.md$/, '.png')))
    && Boolean(sections.find((item) => item.name === SEED.noShot)?.text
      .includes('Couldn’t capture a screenshot: Synthetic capture failure')),
  `${link} | ${deleted}`);
  record('反例：导出不复制截图（导出的文件夹里只有导出的 .md）', readdirSync(ctx.exportDir).every((name) => name
    .endsWith('.md')), JSON.stringify(readdirSync(ctx.exportDir)));
}

/** @brief 导出到 ui-issues 文件夹里：截图链接就是文件名；只多这一个 .md，不复制截图，它也不出现在列表里。 */
async function exportIntoIssues(ctx) {
  const { page } = ctx;
  const target = join(dirOf(ctx, 'issues'), `ui-issues-${today()}.md`);
  const fresh = !existsSync(target);
  const before = snapshot(dirOf(ctx, 'issues'));
  const { md } = await exportTo(ctx, target);
  const first = mdSections(md).find((item) => item.name === basename(ctx.issue1))?.text ?? '';
  const added = changedFiles(before, snapshot(dirOf(ctx, 'issues')));
  await backToChat(page);
  await openReviewPage(page, 'issues');
  const names = (await reviewState(page)).rows.map((row) => row.name);
  ctx.exported = basename(target);
  record('导出到 ui-issues 文件夹里：截图链接就是文件名；文件夹里只多了这一个 .md（不复制截图）；重新读取后它不在列表里',
    fresh && shotLink(first) === basename(ctx.issue1).replace(/\.md$/, '.png') && same(added, [ctx.exported])
    && !names.includes(ctx.exported), JSON.stringify({ fresh, link: shotLink(first), added, names }));
}

/** @brief 导出失败（主进程写文件报错）："Couldn’t export: "和原文。 */
async function exportFailure(ctx) {
  await exportTo(ctx, join(ctx.root, 'synthetic-missing-folder', 'x.md'), false);
  const notice = await noticeText(ctx.page, 'Couldn’t export: ');
  record('导出失败：工具行下面"没有导出："和原文', notice.startsWith('Couldn’t export: ') && /ENOENT/.test(notice), notice);
}

/** @brief 反例：工作回顾里的操作都没有发请求给模型；反馈文件没变，报告文件夹里只多了选的那一个导出文件。 */
async function untouched(ctx) {
  await sleep(300);
  const now = snapshots(ctx);
  const changed = [...changedFiles(ctx.snap.feedback, now.feedback), ...changedFiles(ctx.snap.issues, now.issues)];
  record('反例：打开工作回顾、标已处理、导出都不发请求给模型（合成端点没有收到新的对话请求）', ctx.posts === ctx.posts0,
    `${ctx.posts0} → ${ctx.posts}`);
  record('反例：导出不改反馈和报告文件，ui-issues 里除了选的那一个 .md 不留下别的文件', same(changed, [ctx.exported]),
    changed.join(', '));
}

/** @brief 有记录时"Open folder"：两节各打开自己的文件夹。 */
async function openFolders(ctx) {
  const { app, page } = ctx;
  await app.evaluate(clearShell);
  await chooseTab(page, 'feedback');
  await page.getByTestId('review-open-folder').click();
  await chooseTab(page, 'issues');
  await page.getByTestId('review-open-folder').click();
  const opened = await until(async () => {
    const calls = await mainCalls(app);
    return calls.opened.length >= 2 && calls.opened;
  }, 5000);
  record('工具行"打开文件夹"：对内容的反馈打开 <userData>\\feedback\\，界面问题打开 <userData>\\ui-issues\\',
    Boolean(opened) && samePath(opened[0], dirOf(ctx, 'feedback')) && samePath(opened[1], dirOf(ctx, 'issues')),
    JSON.stringify(opened));
}

// ---------- 步骤：回到原位置 ----------

/** @brief 点详情里的"Jump to source"。 */
const clickJump = (page) => page.getByTestId('detail-jump').click();

/** @brief 会话面板的个数和工作回顾页在不在（检查没有打开、新建会话，也没有离开工作回顾）。 */
const stayed = async (page) => ({ panes: await page.locator('.pane-slot').count(),
  page: await page.getByTestId('review-page').count() });

/** @brief 等中栏换回会话（工作回顾页消失、会话就绪）。 */
async function waitChat(page) {
  await page.getByTestId('review-page').waitFor({ state: 'detached', timeout: 20000 });
  await waitReady(page);
  await settle(page);
}

/**
 * @brief 回复不在了（会话没开着，读会话文件）："Opening…"，留在工作回顾，"This response is no longer in the session."，
 *        引用的原文仍在。
 */
async function jumpChanged(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'feedback');
  const panes = await page.locator('.pane-slot').count();
  await selectRow(page, SEED.changed);
  await watchJump(page);
  await clickJump(page);
  await page.getByTestId('detail-jump-status').waitFor({ timeout: 15000 }).catch(() => {});
  const seen = await jumpSeen(page);
  const detail = await detailState(page);
  const after = await stayed(page);
  await shot(page, '8-jump-changed');
  record('回复不在了（会话没开着，读会话文件）：检查时按钮"正在打开…"且不可点；之后留在工作回顾，详情里'
    + '"原文已变化：会话里找不到这条回复了"，引用的原文仍在；没有打开会话（不跳到会话底部假装找到了）', seen.checking
    && detail.jumpStatus === JUMP_TEXT.changed && (detail.quote ?? '').includes('synthetic 第一行') && after.page === 1
    && panes === 0 && after.panes === 0, JSON.stringify({ seen, status: detail.jumpStatus, jump: detail.jump, panes,
    after }));
}

/**
 * @brief 原会话已删除：会话列表里没有的，详情里一开始就"Session deleted"、按钮不可用；列表里还有、会话文件被删了的，
 *        点了之后读会话文件时发现，变成"Session deleted"；都不新建会话。没有保存的：按钮不可用并说明。
 */
async function jumpBlocked(ctx) {
  const { page } = ctx;
  const panes = await page.locator('.pane-slot').count();
  const gone = await selectRow(page, SEED.gone);
  const after = await stayed(page);
  record('原会话已删除（会话列表读完了、里面没有它）：详情里"原会话已删除"，"回到原位置"不可用，引用的原文仍在；'
    + '不新建会话', gone.jumpStatus === JUMP_TEXT.gone && gone.jump?.disabled
    && gone.quote === 'synthetic：已删除的会话里的回复' && after.page === 1 && after.panes === panes
    && !existsSync(ctx.goneFile), JSON.stringify({ status: gone.jumpStatus, jump: gone.jump, after }));
  rmSync(ctx.listedGoneFile);
  const listed = await selectRow(page, SEED.listedGone);
  await clickJump(page);
  await page.getByTestId('detail-jump-status').waitFor({ timeout: 15000 }).catch(() => {});
  const read = await detailState(page);
  const stay = await stayed(page);
  record('原会话已删除（列表里还有它、会话文件被删了）："回到原位置"本来可用，点了之后读会话文件时发现，'
    + '"原会话已删除"、按钮不可用；不新建会话', Boolean(listed.jump) && !listed.jump.disabled && !listed.jumpStatus
    && read.jumpStatus === JUMP_TEXT.gone && read.jump?.disabled && stay.page === 1 && stay.panes === panes,
  JSON.stringify({ before: listed.jump, status: read.jumpStatus, jump: read.jump, stay }));
  const unsaved = await selectRow(page, SEED.unsaved);
  record('原会话没有保存：按钮不可用，说明"原会话没有保存，无法回到原位置"', Boolean(unsaved.jump?.disabled)
    && unsaved.jumpStatus === JUMP_TEXT.unsaved, JSON.stringify({ jump: unsaved.jump, status: unsaved.jumpStatus }));
}

/** @brief 回到原位置（整条回复，重启后会话没开着）：中栏换回会话，滚到那条回复，高亮整轮约 4 秒；回来时选中的还是它。 */
async function jumpReply(ctx) {
  const { page } = ctx;
  await selectRow(page, ctx.fb.reply);
  await clickJump(page);
  await waitChat(page);
  const flashed = await until(async () => (await jumpHighlight(page)).flashed > 0, 10000, 100);
  const litAt = Date.now();
  const view = { file: await activeFile(page), visible: await flashVisible(page) };
  await shot(page, '8-jump-reply');
  record('回到原位置（整条回复，会话没开着时先读会话文件确认）：中栏换回这个会话，滚到那条回复，高亮整轮', Boolean(flashed)
    && samePath(view.file, ctx.file) && view.visible, JSON.stringify(view));
  await sleep(Math.max(0, litAt + 3000 - Date.now()));
  const mid = (await jumpHighlight(page)).flashed;
  await sleep(Math.max(0, litAt + 4300 - Date.now()));
  const end = (await jumpHighlight(page)).flashed;
  record('回到原位置的高亮约 4 秒后消失（约 3 秒时还在，4.3 秒时没有了）', mid > 0 && end === 0,
    JSON.stringify({ mid, end }));
  await openReviewPage(page);
  const selected = await pressedRow(page);
  const detail = await detailState(page);
  record('在侧栏点"工作回顾"回来，选中的还是这一条', (await reviewState(page)).tabs.feedback.pressed
    && selected === ctx.fb.reply && detail?.expected === '希望整条回复更短', JSON.stringify({ selected }));
}

/** @brief 回到原位置（回复里的选区，会话开着）：高亮引用的文字。 */
async function jumpSelection(ctx) {
  const { page } = ctx;
  await selectRow(page, ctx.fb.selection);
  await clickJump(page);
  await waitChat(page);
  const lit = await until(async () => {
    const now = await jumpHighlight(page);
    return now.text && now;
  }, 10000, 100);
  record('回到原位置（回复里的选区，会话开着时看对话流）：中栏换回会话，高亮引用的文字', lit?.text === '只有文字的回复'
    && samePath(await activeFile(page), ctx.file), JSON.stringify(lit));
  await openReviewPage(page);
}

/** @brief 回到原位置（文件里的）：打开反馈时所在的会话，右栏阅读器打开文件、高亮原来的行。 */
async function jumpFile(ctx) {
  const { page } = ctx;
  await selectRow(page, ctx.fb.file);
  await clickJump(page);
  await waitChat(page);
  await waitViewer(page).catch(() => {});
  await sleep(300);
  const state = await viewerState(page);
  record('回到原位置（文件里的）：中栏是反馈时所在的会话，右栏阅读器打开 README.md，第 1–2 行高亮',
    state?.path === 'README.md' && same(state.target, [1, 2]) && samePath(await activeFile(page), ctx.file),
    JSON.stringify(state));
}

/** @brief 原会话已归档：回到原位置先恢复再打开，滚到那条回复并高亮。 */
async function jumpArchived(ctx) {
  const { page } = ctx;
  const isArchived = async () => (await savedArchived(page)).some((file) => samePath(file, ctx.file2));
  await chooseMenuItem(page, ctx.file2, 'Archive');
  const archived = await until(isArchived, 5000);
  await openReviewPage(page, 'feedback');
  await selectRow(page, ctx.fb.second);
  await clickJump(page);
  await waitChat(page);
  const flashed = await until(async () => (await jumpHighlight(page)).flashed > 0, 10000, 100);
  const after = { file: await activeFile(page), archived: await isArchived() };
  record('原会话已归档：回到原位置先恢复（不再在"已归档"里）再打开，滚到那条回复并高亮', Boolean(archived)
    && Boolean(flashed) && samePath(after.file, ctx.file2) && !after.archived, JSON.stringify({ archived, flashed,
    ...after }));
}

// ---------- 步骤：右栏宽度、返回会话、F8、后台进程退出 ----------

/** @brief 详情与会话的右栏共用宽度；键盘调整分隔线后保存，会话的右栏也跟着；返回会话时右栏的文件还在。 */
async function detailWidth(ctx) {
  const { page } = ctx;
  await openRow(page, ctx.file);
  if (await page.getByTestId('right-panel').count() === 0) {
    await paneOf(page).getByRole('button', { name: 'Toggle changes' }).click();
  }
  const panel = await panelWidth(page, 'right-panel');
  await openReviewPage(page, 'feedback');
  await selectRow(page, ctx.fb.reply);
  const detail = await panelWidth(page, 'review-detail');
  record('右栏的宽度与会话的右栏共用', Boolean(panel && detail) && Math.abs(panel.width - detail.width) <= 2
    && panel.now === detail.now, JSON.stringify({ panel, detail }));
  await page.locator('[data-testid="review-detail"] [data-resize="workspace"]').focus();
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  const wider = await panelWidth(page, 'review-detail');
  const saved = (await savedLayout(page)).workspace;
  await backToChat(page);
  const after = await panelWidth(page, 'right-panel');
  const file = (await viewerState(page))?.path ?? null;
  record('键盘调整详情的分隔线：宽度保存（mori.layout），回到会话后会话的右栏也是这个宽度，右栏的文件还在',
    wider?.now === Math.min((detail?.now ?? 0) + 20, detail?.max ?? 0) && saved === wider.now
    && Math.abs((after?.width ?? 0) - wider.width) <= 2 && file === 'README.md',
  JSON.stringify({ wider, saved, after, file }));
}

/** @brief 窗口窄于 800px 时详情浮在中栏上层（同会话的右栏）。 */
async function narrowDetail(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await openReviewPage(page, 'feedback');
  try {
    await resizeWindow(app, 780, 700);
    const box = await page.evaluate(() => {
      const aside = document.querySelector('[data-testid="review-detail"]');
      const center = document.querySelector('[data-testid="review-page"]')?.getBoundingClientRect();
      const rect = aside?.getBoundingClientRect();
      return rect && center ? { left: Math.round(rect.left), centerRight: Math.round(center.right), width: innerWidth,
        position: getComputedStyle(aside).position } : null;
    });
    await shot(page, '8-narrow');
    record('窗口窄于 800px 时详情浮在中栏上层（同会话的右栏）', Boolean(box) && box.width < 800
      && box.left < box.centerRight - 20, JSON.stringify(box));
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
  await backToChat(page);
}

/** @brief 返回会话恢复分屏、焦点、草稿和右栏的文件（与设置页、工具页相同）。 */
async function backRestores(ctx) {
  const { page } = ctx;
  await chooseMenuItem(page, ctx.file2, 'Open in split view');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
  await composerAt(page, 'left').click();
  await settle(page);
  const draft = '去工作回顾之前写的草稿';
  await composerAt(page, 'left').fill(draft);
  const before = { split: await splitState(page), viewer: (await viewerState(page))?.path ?? null };
  await openReviewPage(page, 'feedback');
  await selectRow(page, ctx.fb.reply);
  await backToChat(page);
  const after = { split: await splitState(page), viewer: (await viewerState(page))?.path ?? null,
    draft: await composerAt(page, 'left').inputValue() };
  const slots = (state) => state.slots.map((slot) => [slot.key, slot.focused]);
  record('返回会话：恢复分屏和焦点、草稿、右栏（与设置页、工具页相同）', before.split.split && after.split.split
    && same(slots(after.split), slots(before.split)) && before.split.slots[0]?.focused && after.draft === draft
    && after.viewer === before.viewer, JSON.stringify({ before, after }));
  await composerAt(page, 'left').fill('');
}

/**
 * @brief 分屏放不下右栏时（窗口 1030px 宽，右栏先收起）回到文件里的反馈：右栏浮在上层，阅读器打开文件、高亮原来的行。
 *        接着 backRestores 留下的分屏（左栏是第一个会话）。
 */
async function jumpCramped(ctx) {
  const { app, page } = ctx;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await resizeWindow(app, 1030, 700);
  try {
    const before = { split: (await splitState(page)).split, panel: await page.getByTestId('right-panel').count() };
    await openReviewPage(page, 'feedback');
    await selectRow(page, ctx.fb.file);
    await clickJump(page);
    await waitChat(page);
    await waitViewer(page).catch(() => {});
    await sleep(300);
    const state = await viewerState(page);
    const floating = await page.locator('[data-testid="right-panel"].floating').count();
    await shot(page, '9-jump-cramped');
    record('分屏放不下右栏时回到原位置（文件里的）：右栏浮在上层，阅读器打开 README.md，第 1–2 行高亮',
      before.split && before.panel === 0 && floating === 1 && state?.path === 'README.md' && same(state.target, [1, 2]),
    JSON.stringify({ before, floating, state }));
  } finally {
    await resizeWindow(app, size[0], size[1]);
  }
}

/**
 * @brief 工作回顾页上按 F8（右栏开着详情）：报告的"Current view"是"Page: Review"、右栏打开和它的宽度；
 *        保存后新报告马上出现在"UI issues"最上面。"What you expected"里写了一行"## What you expected"：文件里加了转义，
 *        两节照样分清。
 */
async function f8OnReview(ctx) {
  const { page } = ctx;
  await openReviewPage(page, 'issues');
  await selectRow(page, basename(ctx.issue1));
  await page.getByTestId('review-page').getByRole('button', { name: 'Back to app' }).focus();
  const { dialog, file } = await saveReport(page, 'F8 来自工作回顾页', '新报告出现在列表最上面\n## What you expected\n第二段');
  const md = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  const name = basename(file ?? '');
  const top = await until(async () => (await reviewState(page))?.rows[0]?.name === name, 5000);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const fields = md.split(/\r?\n/).filter((line) => /^- (Page|Right panel|Right panel width): /.test(line));
  record('工作回顾页上按 F8：报告的"当前界面"写"页面：工作回顾"，开着详情时"右栏：打开"和右栏宽度；保存后不用重新打开，'
    + '新报告就在"界面问题"最上面', fields.includes('- Page: Review') && fields.includes('- Right panel: Open')
    && fields.some((line) => /^- Right panel width: \d+px/.test(line)) && Boolean(top),
  JSON.stringify({ file, fields, top }));
  const detail = await selectRow(page, name);
  record('"你期望什么"里写了一行"## 你期望什么"：报告文件里这一行前面加了 "\\"，工作回顾照样分清两节',
    /\n\\## What you expected\n/.test(md) && detail?.what === 'F8 来自工作回顾页'
    && (detail?.expect ?? '').startsWith('新报告出现在列表最上面') && detail.expect.includes('\\## What you expected')
    && detail.expect.includes('第二段'), JSON.stringify({ what: detail?.what, expect: detail?.expect }));
}

/** @brief 后台进程退出：横幅、"Review"照常可用（能看、能标、能导出），只有"Jump to source"不可用并说明。 */
async function kernelExit(ctx) {
  const { app, page } = ctx;
  await openReviewPage(page, 'feedback');
  killKernel(app);
  const banner = await page.locator('.global-banner [data-testid="kernel-exit"]').waitFor({ timeout: 15000 })
    .then(() => true, () => false);
  const nav = { review: await page.getByTestId('nav-review').isEnabled(),
    tools: await page.getByTestId('nav-tools').isEnabled() };
  await openReviewPage(page, 'feedback');
  const state = await reviewState(page);
  const detail = await selectRow(page, ctx.fb.selection);
  await shot(page, '10-kernel-exit');
  record('后台进程退出后：页面上方是后台进程退出的横幅，"工作回顾"照常可用（读的是本机文件）', banner && nav.review
    && state.rows.length === expectedNames(ctx, 'feedback').length && !state.error,
  JSON.stringify({ banner, nav, rows: state.rows.length }));
  record('后台进程退出后"回到原位置"不可用，说明"后台进程已退出，先重新载入"', Boolean(detail.jump?.disabled)
    && detail.jumpStatus === JUMP_TEXT.exited, JSON.stringify({ jump: detail.jump, status: detail.jumpStatus }));
  await page.getByTestId('detail-handled').click();
  const marked = (await reviewState(page)).rows.find((row) => row.name === ctx.fb.selection)?.handled;
  await page.getByTestId('detail-handled').click();
  const { md } = await exportTo(ctx, join(ctx.exportDir, 'after-exit.md'));
  record('后台进程退出后照常能标已处理、能导出', Boolean(marked) && md.startsWith('# Feedback'),
    JSON.stringify({ marked, length: md.length }));
}

/** @brief 新加的界面没有小于 12px 的字。 */
async function fontSizes(ctx) {
  record(`工作回顾（${ctx.smallChecked.join('、')}）没有小于 12px 的字`, ctx.small.length === 0
    && ctx.smallChecked.length > 0, ctx.small.slice(0, 6).join('; '));
}

const steps = {
  setup, entry, emptyStates, folderEmpty, railEntry, replyFeedback, selectionFeedback, fileFeedback, secondSession,
  f8Report, seeded, seededReads, noWatch, feedbackRows, seededRows, issueRows, feedbackDetail, noSideScroll,
  issueDetail, shotViewer,
  brokenDetail, keyboardRows, sectionMemory, revealSaved, handled, hideHandled, allHidden, handledRestart,
  exportCancel, exportFeedback, exportIssues, exportIntoIssues, exportFailure, untouched, openFolders, jumpChanged,
  jumpBlocked, jumpReply, jumpSelection, jumpFile, jumpArchived, detailWidth, narrowDetail, backRestores, jumpCramped,
  f8OnReview, kernelExit, fontSizes,
};

const fake = await startFakeEndpoint(port, testKey);
const { root, project } = makeProject();
const userData = mkdtempSync(join(tmpdir(), 'mori-m7-app-data-'));
const exportDir = join(root, 'export');
mkdirSync(exportDir, { recursive: true });
const ctx = { root, project, userData, exportDir, pageErrors: [], small: [], smallChecked: [], posts: 0, fb: {} };
// 合成端点每收到一个请求打一行；数对话请求，检查工作回顾里的操作没有发请求给模型。
fake.stdout.on('data', (chunk) => {
  ctx.posts += (String(chunk).match(/POST \S*\/chat\/completions/g) ?? []).length;
});
try {
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      if (ctx.page) await shot(ctx.page, `${name}-error`);
      await recover(ctx);
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  fake.kill();
}
console.log(`[m7-app] project in ${project}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`m7-app${suffix}.json`) ? 0 : 1;
