// M1 界面测试：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放真实录制的会话，检查界面状态。
// 2026-10-21 起权限、选择范围（v1）、Effort 和上下文用量（圆环）在输入框下面一行（docs/v0/composer-pickers.md）：
// 这里查圆环的各状态、悬停提示、读屏名和详情；这一行在各档宽度和各状态下的样子（bands：分档、截短的先后、不可用的原因、
// 往上打开的菜单、键盘、焦点、换范围失败那一行）；第一次打开中和打开失败（open-failed）。
// 2026-10-26 走查 M16（WP-13）：mermaid 代码块流式时显示代码、写完画成图（流程、时序、类、状态、甘特、pie）、画不出来
// （语法错误、超过 2 万字、超过 400 条边）显示代码（mermaid，synthetic-mermaid）。
// 用法（在 app/ 下）：node tests/ui/m1-replay.mjs [--only readme,stop]
// 结果写到 test-results/m1-replay.json；截图在 test-results/m1-replay/。

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  composerRow, focusName, hoverRing, layoutChecks, layoutProblems, openRingDetails, popoverBox, popoverChecks,
  popoverProblems, REPLAY_TIP, ringColorProblems, ringState, ringTextProblems, rowProblems, rowSummary, seenRows,
  seenWith, setDraftKeepingFocus, setPaneWidth, SINGLE, stateProblems, tabPath, watchRows,
} from './m1-layout.mjs';
import { pageHelpers } from './page.mjs';
import { readParts } from './ring-parts.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness');
const shots = join(appRoot, 'test-results/m1-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
/** 重新载入后对话流里的说明（state/projects.ts RELOADED_NOTE） */
const RESTARTED_NOTE = 'Restarted · Queued messages, pending approvals, and “Allow for this session” choices '
  + 'weren’t restored';
/** 停止后对话流里的提示（Transcript.tsx） */
const STOPPED_NOTICE = 'Stopped · Changes made so far stay as they are';
/** 还没有消息时圆环的描述和详情里的说明（models.md"上下文用量（圆环）"，Claude 原句） */
const EMPTY_NOTE = 'Send a message to see context usage.';
/** 选择范围按钮悬停的第二行（回放桥合成的提供商名和区域） */
const OPTS = { modelTip: REPLAY_TIP };
/**
 * 这一行要量的单栏宽度（composer-pickers.md"测试要改的地方"新加的检查第 2 条：各档的上沿和下沿；单栏能设的从 300px 起，
 * 279、280px 在 m5 的分屏里量）
 */
const BAND_WIDTHS = [300, 340, 341, 370, 400, 401, 460, 461, 490, 600, 601, 680, 681, 740, 930];
/** 后台进程退出时量的宽度（各档的边） */
const CRASH_WIDTHS = [300, 340, 341, 400, 401, 460, 461, 600, 601, 680, 681, 930];
/** 从文字框按 Tab 先后停到的这一行的四项（models.md"位置"） */
const ROW_PATH = 'permission-button,model-button,thinking-button,usage';
/** 量"生成中有字""空闲有字"时输入框里的字（与 stop 录制里排队的那一条相同，"Queue for later"发出的就是它） */
const BAND_DRAFT = '排队：这条会被撤回';
/** 回放桥 failNext 让 session.setPick 失败时的原文（synthetic） */
const PICK_FAIL = 'Synthetic: session.setPick failed';
/**
 * 本测试用 failNext 注入的失败原文，每注入一次记一条：界面照例（异常分支记错误日志）为它写一条
 * "[renderer] <命令> failed: <原文>"（state/bridge.ts describe），"页面没有报错"只扣掉这些，每次注入扣一条，多的照样算错
 */
const injected = [];

/** @brief 让回放桥的下一条界面命令以 text 失败（synthetic，不占回放顺序），并记下界面因此该写的那条错误日志。 */
async function failNext(page, text) {
  injected.push(text);
  await page.evaluate((message) => { window.__replay.failNext = message; }, text);
}

/** @brief 控制台的错误里去掉每次注入的那一条（"[renderer] <命令> failed: <原文>"，各扣一次），剩下的是真的报错。 */
function unexpectedErrors(errors) {
  const left = [...errors];
  const ours = (line, text) => /^\[renderer\] [\w.]+ failed: /.test(line) && line.endsWith(` failed: ${text}`);
  for (const text of injected) {
    const index = left.findIndex((line) => ours(line, text));
    if (index >= 0) left.splice(index, 1);
  }
  return left;
}

/** markdown 录制里你发的消息（synthetic-mermaid 照用它，只换了回复正文） */
const MARKDOWN_PROMPT = '不要调用任何工具。用 Markdown 回复：一个二级标题、一个三项列表、一个两列表格、'
  + '一段 TypeScript 代码块，内容是介绍 add 函数。';

/** @brief 构建回放页面。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 测试用的页面操作：共用的 pageHelpers 加上回放页面的载入。 */
function helpers(page) {
  const base = pageHelpers(page);
  return {
    ...base,
    url: (fixture, speed = 1, maxGap = 1500) => `${pathToFileURL(join(outDir, 'index.html')).href}?fixture=${fixture}`
      + `&speed=${speed}&maxGap=${maxGap}`,
    async load(fixture, { speed = 1, maxGap = 1500 } = {}) {
      await page.goto(this.url(fixture, speed, maxGap));
      await page.getByTestId('open-folder').waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'Open folder…' }).first().click();
      await page.getByTestId('chat-pane').waitFor({ timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('[data-testid="not-ready"]'));
    },
    replayErrors: () => page.evaluate(() => window.__replay.status.errors),
    /** @brief 界面发给回放桥的命令条数（只读查询除外；failNext 拒掉的不算） */
    commandCount: () => page.evaluate(() => window.__replay.status.commands.length),
  };
}

/** @brief 点"Restart"但不挪焦点（element.click()），用来看重新打开时焦点是否留在这一行原来的按钮上。 */
const restartKeepingFocus = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="kernel-exit"] '
  + 'button')].find((button) => button.textContent.includes('Restart'))?.click());

/**
 * @brief 焦点在单栏的文字框里（最多等 1 秒）：按钮消失时界面在下一帧才把焦点放回文字框（focusComposer 用
 *        requestAnimationFrame，先等刚关掉的菜单退出浮层栈），所以不能在按钮消失的同一刻就读。
 */
const focusInComposer = (page) => page.waitForFunction((css) => document.activeElement
  ?.matches(`${css} .composer textarea`) ?? false, SINGLE, { timeout: 1000 }).then(() => true, () => false);

/**
 * @brief 新会话还没有消息时的圆环（models.md"上下文用量（圆环）"还没有消息）：空圆环、data-state="empty"、
 *        data-tokens / data-percent 为 0，悬停和读屏名"Context window"，描述和详情里是 Claude 的那句话，不显示 0%；
 *        点开详情 aria-expanded、aria-controls 指向详情，Esc 关上、焦点留在圆环、aria-controls 去掉；点开不发命令。
 */
async function emptyRing(page, h) {
  const before = await h.commandCount();
  const hovered = await hoverRing(page);
  const opened = await openRingDetails(page);
  await page.keyboard.press('Escape');
  await sleep(200);
  const closed = await ringState(page);
  const sent = (await h.commandCount()) - before;
  record('readme：还没有消息时圆环为空：data-state="empty"、data-tokens 和 data-percent 为 0，读屏名和悬停"Context window"，'
    + '描述"Send a message to see context usage."，没有 title、悬停提示 aria-hidden', hovered?.state === 'empty'
    && hovered.tokens === '0' && hovered.percent === '0' && hovered.label === 'Context window'
    && hovered.tip === 'Context window' && hovered.desc === EMPTY_NOTE && !hovered.title
    && hovered.tipHidden === 'true', JSON.stringify(hovered));
  record('readme：空圆环的底圈是 --color-faint、实线，没有填充', ringColorProblems(hovered).length === 0,
    ringColorProblems(hovered).join('; '));
  record('readme：点开空圆环的详情：左边"Context window"，条的位置是那句说明、没有百分比；aria-expanded、aria-controls '
    + '指向详情；Esc 关上详情、焦点留在圆环、aria-controls 去掉；点开不发命令', opened?.details?.includes('Context window')
    && opened.details.includes(EMPTY_NOTE) && !opened.details.includes('%') && opened.expanded === 'true'
    && Boolean(opened.controls) && opened.controls === opened.detailsId && closed?.details === null
    && closed.expanded === 'false' && closed.controls === null && closed.focused && sent === 0,
  JSON.stringify({ opened: opened?.details, closed, sent }));
}

/**
 * @brief 有用量的圆环（readme 录制：1,000,000 的上下文窗口、2,130 tokens）：悬停"Context ≈ 2.1k / 1M (0%)"，
 *        读屏名"Usage: Context approximately 2,130 of 1,000,000 tokens (0%)"（不到 0.5% 写 0%，不写 <1%），
 *        详情里同一个 summary；底圈 --color-line、填充强调色。
 */
async function usedRing(page) {
  const hovered = await hoverRing(page);
  const opened = await openRingDetails(page);
  const parts = await readParts(page, SINGLE);
  await page.keyboard.press('Escape');
  record('readme：录制早于分项（session.state 里没有 contextBreakdown），按没有：有用量时详情只有第一行，没有分段条和分项，'
    + '圆环没有读屏描述（models.md"回放旧的录制"）', parts?.open && parts.rows.length === 0
    && parts.segments.length === 0 && parts.desc === '' && hovered?.desc === null, JSON.stringify(parts));
  record('readme：输入框下面一行的圆环显示上下文用量：读屏名"Usage: Context approximately 2,130 of 1,000,000 tokens (0%)"，'
    + '悬停"Context ≈ 2.1k / 1M (0%)"（1,000,000 写成 1M，不到 0.5% 写 0%），详情里同一个数，描述里没有"/"',
  hovered?.label === 'Usage: Context approximately 2,130 of 1,000,000 tokens (0%)'
    && hovered.tip === 'Context ≈ 2.1k / 1M (0%)' && hovered.tokens === '2130' && hovered.percent === '0'
    && ringTextProblems({ ...opened, tip: hovered.tip }).length === 0, JSON.stringify({ hovered, opened }));
  record('readme：有用量的圆环底圈是 --color-line，填充是强调色（< 75%）', ringColorProblems(hovered).length === 0,
    ringColorProblems(hovered).join('; '));
}

/** @brief 总结 README：等待→思考→工具→生成；思考流入时展开、之后收起；工具卡完成；上下文用量（圆环）。 */
async function readmeCheck(page, h) {
  await h.load('readme');
  await emptyRing(page, h);
  await h.sampleStages();
  await h.watchThinking();
  await h.send('总结一下 README.md');
  await page.locator('.stop-button').waitFor({ timeout: 10000 }).catch(() => {});
  const during = await openRingDetails(page);
  await h.idle();
  const after = await ringState(page);
  record('readme：生成中点开圆环的详情，用量刷新后详情跟着变；生成开始、结束都不关详情',
    Boolean(during?.details) && during.details !== after?.details && after?.details?.includes('≈ 2.1k / 1M (0%)')
    && after.expanded === 'true', JSON.stringify({ during: during?.details, after: after?.details }));
  await page.keyboard.press('Escape');
  const stages = await h.stages();
  record('readme：阶段行先显示"等待模型响应"', stages[0]?.startsWith('Waiting for the model…'), stages.join(' → '));
  // 读取只用了约 4ms，采样抓不到；运行命令约 200ms。
  record('readme：阶段行出现思考中、运行命令、生成中',
    ['Thinking…', 'Run ls', 'Responding…'].every((part) => stages.some((s) => s.startsWith(part))), stages.join(' → '));
  record('readme：思考流入时展开', await h.thinkingOpened());
  const closed = await page.locator('details.thinking').evaluateAll((items) => items.length > 0 && items.every((d) => !d.open));
  record('readme：回复结束后思考收起', closed);
  const cards = await h.cards();
  record('readme：工具卡从执行中变为完成',
    cards.length === 3 && cards.every((c) => c.status === 'done' && c.text.startsWith('Done')),
    cards.map((c) => `${c.title}/${c.text}`).join('；'));
  await page.getByTestId('tool-card').nth(1).locator('summary').click();
  await page.getByTestId('tool-card').nth(1).locator('.tool-body').waitFor();
  const body = oneLine(await page.getByTestId('tool-card').nth(1).innerText(), 300);
  record('readme：展开读取卡能看到参数和输出', body.includes('Input') && body.includes('Mori fixture project'), body);
  await usedRing(page);
  record('readme：Markdown 渲染', await page.locator('.prose li, .prose strong, .prose p').count() > 0);
  record('readme：回放命令与录制一致（点开圆环不发命令）', (await h.replayErrors()).length === 0,
    (await h.replayErrors()).join('; '));
  await page.screenshot({ path: join(shots, 'readme.png') });
}

/**
 * @brief 只有 Markdown 的回复：标题、列表、表格、代码高亮；流式出现。这一次用"Send"按钮发（焦点在它上面按 Enter）：
 *        开始生成时"Send"消失，焦点回到这一栏的文字框（models.md"不可用时、按钮消失时的焦点"）。
 */
async function markdownCheck(page, h) {
  await h.load('markdown', { speed: 1 });
  await page.evaluate(() => {
    window.__newContentSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="new-content"]')) window.__newContentSeen = true;
    }).observe(document.body, { subtree: true, childList: true });
  });
  await page.evaluate(() => {
    window.__lengths = new Set();
    window.__lengthTimer = setInterval(() => {
      const text = document.querySelector('.prose')?.textContent;
      if (text) window.__lengths.add(text.length);
    }, 40);
  });
  await h.watchThinking();
  await h.textarea.fill(MARKDOWN_PROMPT);
  await page.locator(`${SINGLE} .send-button`).focus();
  await page.keyboard.press('Enter');
  await page.locator(`${SINGLE} .stop-button`).waitFor({ timeout: 10000 }).catch(() => {});
  const focus = await focusInComposer(page);
  record('markdown：焦点在"Send"上按 Enter 发出；开始生成时"Send"消失，焦点回到这一栏的文字框（不掉到页面开头）',
    focus === true, await focusName(page));
  await h.idle();
  const lengths = await page.evaluate(() => window.__lengths.size);
  record('markdown：正文是流式出现的', lengths > 3, `采样到 ${lengths} 种长度`);
  record('scroll：你在底部时一直跟随，不出现"有新内容"', !(await page.evaluate(() => window.__newContentSeen))
    && await page.getByTestId('transcript').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30));
  record('markdown：思考流入时展开，正文开始后收起', (await h.thinkingOpened())
    && await page.locator('details.thinking').evaluateAll((items) => items.every((d) => !d.open)));
  const counts = await page.evaluate(() => ({
    heading: document.querySelectorAll('.prose [data-streamdown="heading-2"]').length,
    items: document.querySelectorAll('.prose li').length,
    table: document.querySelectorAll('.prose table').length,
    tokens: document.querySelectorAll('.prose pre span[style*="--sdm-c"]').length,
  }));
  record('markdown：标题、列表、表格、代码高亮', counts.heading > 0 && counts.items >= 3 && counts.table > 0 && counts.tokens > 3,
    JSON.stringify(counts));
  record('markdown：回放命令与录制一致', (await h.replayErrors()).length === 0, (await h.replayErrors()).join('; '));
  await page.screenshot({ path: join(shots, 'markdown.png') });
}

/** @brief 失败的命令显示"Failed · Exit code N"，不显示"Done"。 */
async function commandFailCheck(page, h) {
  await h.load('command-fail', { speed: 2 });
  await h.send('运行命令 `ls does-not-exist-dir`，然后用一句话告诉我结果。');
  await h.idle();
  const cards = await h.cards();
  record('command-fail：失败的命令显示"失败 · 退出码"，不显示"完成"',
    cards.length === 1 && cards[0].status === 'failed' && /^Failed · Exit code \d+$/.test(cards[0].text),
    JSON.stringify(cards));
}

/** @brief 编辑：工具卡展开有 diff；右栏自动打开并列出文件。 */
async function editCheck(page, h) {
  await h.load('edit', { speed: 2 });
  await h.send('把 README.md 第一行的标题改成 `# Mori fixture project (edited)`，只改这一行。');
  await h.idle();
  const cards = await h.cards();
  const edit = cards.findIndex((card) => card.title.startsWith('Edit'));
  await page.getByTestId('tool-card').nth(edit).locator('summary').click();
  const diff = await page.getByTestId('tool-card').nth(edit).getByTestId('tool-diff').waitFor({ timeout: 5000 })
    .then(() => 1, () => 0);
  record('edit：修改卡完成，展开能看到 diff', edit >= 0 && cards[edit].status === 'done' && diff === 1, JSON.stringify(cards));
  const panel = page.getByTestId('right-panel');
  const listed = await panel.isVisible() && (await panel.innerText()).includes('README.md');
  record('edit：右栏自动打开并列出改动的文件，注明命令改动不在此列', listed
    && (await panel.innerText())
      .includes('Only edits and writes are listed. Files changed by commands aren’t included.'));
  await page.screenshot({ path: join(shots, 'edit.png') });
}

/**
 * @brief 生成中有字时输入框下面一行的发送组：按读屏名找"Queue"和"Stop"（这一行里还有权限、选择范围、Effort 的字，
 *        只有图标时名字在 aria-label，composer-pickers.md"测试要改的地方"），它们在这一行的最右端、圆环之后。
 */
async function sendGroup(page) {
  const row = page.locator(`${SINGLE} [data-testid="composer"] .composer-bottom`);
  const queue = await row.getByRole('button', { name: 'Queue', exact: true }).isVisible().catch(() => false);
  const stop = await row.getByRole('button', { name: 'Stop', exact: true }).isVisible().catch(() => false);
  const kinds = (await composerRow(page))?.kids.map((kid) => kid.kind) ?? [];
  return { queue, stop, kinds };
}

/** @brief 生成中插话、排队：先进排队区；插话在工具执行完后进入对话流，排队在本轮结束后。之后模拟后台进程退出并重新载入。 */
async function queueSteerCheck(page, h) {
  await h.load('queue-steer', { speed: 1 });
  await h.watchThinking();
  await h.send('运行命令 `sleep 8; echo done`，完成后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 20000 });
  await h.textarea.fill('插话：另外告诉我 README.md 有几行。');
  const group = await sendGroup(page);
  record('queue：生成中有字时输入框下面一行的最右端是"Queue ▾"和"Stop"（按读屏名找，在圆环之后）',
    group.queue && group.stop && group.kinds.slice(-3).join() === 'ring,queue,stop', JSON.stringify(group));
  await h.textarea.press('Control+Enter');
  await h.send('排队：最后用一句话总结你做了什么。');
  await page.waitForFunction(() => document.querySelector('[data-testid="queue"]')?.textContent?.includes('排队：最后'),
    null, { timeout: 10000 }).catch(() => {});
  const queue = await page.getByTestId('queue').innerText().catch(() => '');
  record('queue：插话和排队两条都先出现在排队区', queue.includes('插话') && queue.includes('排队：最后') && queue.includes('README.md 有几行'),
    oneLine(queue));
  await page.locator('[data-testid="user-message"]', { hasText: '插话：' }).waitFor({ timeout: 30000 });
  const atSteer = await h.cards();
  const queueAtSteer = await page.getByTestId('queue').innerText().catch(() => '');
  record('queue：插话在本轮工具执行完后进入对话流', atSteer[0]?.status === 'done' && queueAtSteer.includes('排队：最后')
    && !queueAtSteer.includes('插话'), `${JSON.stringify(atSteer)} | 排队区：${oneLine(queueAtSteer)}`);
  await h.idle();
  const users = await page.getByTestId('user-message').allInnerTexts();
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant"]')]
    .map((element) => (element.dataset.testid === 'user-message' ? 'U' : 'A')).join(''));
  record('queue：排队的消息在本轮结束后进入对话流', users.length === 3 && users[2].startsWith('排队：') && order.endsWith('UA'), order);
  record('queue：思考流入时展开，之后收起', await h.thinkingOpened()
    && await page.locator('details.thinking').evaluateAll((items) => items.every((d) => !d.open)));
  record('queue：回放命令与录制一致（插话用 steer，排队用 followUp）', (await h.replayErrors()).length === 0,
    (await h.replayErrors()).join('; '));
  await reloadCheck(page, h);
}

/**
 * @brief 后台进程退出时输入框下面一行（chat.md"后台进程退出"、models.md）：权限、选择范围、Effort 不可用（aria-disabled，
 *        仍能 Tab 到），权限、Effort 悬停第二行、范围按钮第三行和读屏描述是"Mori’s background process crashed"；
 *        开着的权限菜单关上；圆环保留最后的用量，详情仍能打开。
 */
async function crashedRow(page, before) {
  const row = await composerRow(page);
  // 菜单在按钮变得不可用之后的 effect 里关上（rowMenu.ts useRowMenu），晚于"crashed"那次渲染；先等它关上再数，
  // 不然量到的是关上之前的一刻（2026-10-24，思考关不掉的模型的完整回归里在本机连续出现，见 docs/v1/models-checks.md）
  await page.getByTestId('permission-menu').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  const menus = await page.getByTestId('permission-menu').count();
  const ring = await openRingDetails(page);
  await page.keyboard.press('Escape');
  const problems = stateProblems(row, 'crashed', OPTS);
  record('reload：后台进程退出后输入框下面一行的权限、选择范围、Effort 不可用（aria-disabled），原因"Mori’s background '
    + 'process crashed"（范围按钮的描述前面是提供商和区域）；开着的权限菜单关上', problems.length === 0 && menus === 0,
  `${problems.join('; ')} 权限菜单 ${menus}`);
  record('reload：后台进程退出后圆环保留最后一次的用量，详情仍能打开', ring?.state === before?.state
    && ring?.tokens === before?.tokens && ring?.details?.includes('Context window'), JSON.stringify({ before, ring }));
}

/**
 * @brief Restart 之后（chat.md"后台进程退出"重新载入中、Restart 之后重新打开中）：选择范围、Effort、圆环仍在（上一次的值、
 *        不可用，原因"Restarting…"、"Starting…"），不像第一次打开那样藏起；焦点在范围按钮上时一直留在那里。
 */
function restartedRows(seen, focus) {
  const restarting = seenWith(seen, 'Restarting…');
  const reopening = seenWith(seen, 'Starting…');
  const problems = [...stateProblems(restarting, 'restarting', OPTS).map((p) => `Restarting…: ${p}`),
    ...stateProblems(reopening, 'reopening', OPTS).map((p) => `Starting…: ${p}`)];
  record('reload：Restart 之后"Restarting…"和重新打开中"Starting…"时这一行仍有上一次的选择范围、Effort 和圆环（不可用，'
    + '原因是按钮位置的说明）', problems.length === 0, problems.join('; ') || Object.keys(seen).join(', '));
  record('reload：焦点在范围按钮上时 Restart，重新载入和重新打开中、打开之后焦点都留在范围按钮上（按钮不可用但还在）',
    restarting?.focus === 'model-button' && reopening?.focus === 'model-button' && focus === 'model-button',
    JSON.stringify({ restarting: restarting?.focus, reopening: reopening?.focus, after: focus }));
}

/** @brief 模拟后台进程退出：提示与"Restart"，草稿保留；重新载入后按会话记录重画。 */
async function reloadCheck(page, h) {
  await h.textarea.fill('这是一段还没发出的草稿');
  const before = await ringState(page);
  await page.locator(`${SINGLE} [data-testid="permission-button"]`).click();
  await page.getByTestId('permission-menu').waitFor({ timeout: 3000 }).catch(() => {});
  await page.evaluate(() => window.__replay.exit(1));
  const banner = await page.getByTestId('kernel-exit').innerText().catch(() => '');
  record('reload：显示"Mori 的后台进程意外退出 · 刚才没完成的回复已中断"和"重新载入"',
    banner.includes('Mori’s background process crashed · Unfinished responses were interrupted')
    && banner.includes('Restart'), oneLine(banner));
  record('reload：输入框显示后台进程已退出，不能发送',
    (await page.getByTestId('not-ready').innerText()) === 'Mori’s background process crashed');
  await crashedRow(page, before);
  await page.screenshot({ path: join(shots, 'kernel-exit.png') });
  await page.locator(`${SINGLE} [data-testid="model-button"]`).focus();
  await watchRows(page);
  await restartKeepingFocus(page);
  await page.getByText(RESTARTED_NOTE).waitFor({ timeout: 10000 });
  restartedRows(await seenRows(page), await focusName(page));
  const users = await page.getByTestId('user-message').count();
  const cards = await h.cards();
  record('reload：从会话记录恢复对话（3 条你的消息、工具卡完成且不显示耗时）', users === 3
    && cards.every((c) => c.status === 'done' && c.text === 'Done'), `${users} 条；${JSON.stringify(cards)}`);
  record('reload：草稿还在', (await h.textarea.inputValue()) === '这是一段还没发出的草稿');
}

/** @brief 一条回复里两个工具调用时插话：两个调用都执行完，插话才送达；没有"已跳过"。 */
async function twoToolsCheck(page, h) {
  await h.load('two-tools-steer', { speed: 1 });
  await h.send('请在同一条回复里同时调用两次 bash：第一次运行 `sleep 3; echo first`，第二次运行 `echo second`。两个都完成后告诉我结果。');
  await page.getByTestId('tool-card').first().waitFor({ timeout: 20000 });
  await h.send('插话：结果用英文写。', 'Control+Enter');
  await h.idle();
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="user-message"], [data-testid="tool-card"]')]
    .map((element) => (element.dataset.testid === 'tool-card' ? `T:${element.dataset.status}` : 'U')).join(' '));
  record('steer：两个工具调用都执行完后插话才送达（不跳过）', order === 'U T:done T:done U', order);
}

/**
 * @brief 生成中（录制在等界面的下一条命令，一直在生成）：从文字框 Tab 依次是权限 → 选择范围 → Effort → 圆环 → "Queue" →
 *        ▾ → "Stop"（models.md"位置"）；Effort 不可用（aria-disabled）但能 Tab 到，范围按钮可用（2026-10-26 起能打开菜单
 *        切 Task mode），两者的读屏描述和悬停都写原因。
 */
async function runningKeys(page) {
  const path = await tabPath(page, `${SINGLE} .composer textarea`, (name) => name === 'Stop', 8);
  const row = await composerRow(page);
  const problems = stateProblems(row, 'running', OPTS);
  record('stop：生成中有字时从文字框按 Tab 依次是权限 → 选择范围 → Effort → 圆环 → "Queue" → ▾ → "Stop"',
    path.join() === `${ROW_PATH},Queue,More send options,Stop`, path.join(' → '));
  record('stop：生成中 Effort 不可用（aria-disabled、仍能 Tab 到）、范围按钮可用（能打开菜单切 Task mode），原因"Can’t '
    + 'switch models until the response finishes"（范围按钮悬停第三行，描述"replay, Local. …"）、"Can’t change effort '
    + 'until the response finishes"；'
    + '权限和圆环可用', problems.length === 0, problems.join('; '));
}

/**
 * @brief 生成中键盘到圆环（models.md"上下文用量（圆环）"）：Tab 到圆环时显示悬停提示；Esc 先藏起提示、焦点留在圆环、
 *        不停止生成；Enter 打开详情，Esc 关上详情、焦点留在圆环、不停止生成；都不发命令。
 */
async function ringKeys(page, h) {
  const before = await h.commandCount();
  await tabPath(page, `${SINGLE} [data-testid="thinking-button"]`, () => true, 1);
  await page.locator(`${SINGLE} [data-testid="usage-tip"]`).waitFor({ timeout: 3000 }).catch(() => {});
  const shown = await ringState(page);
  await page.keyboard.press('Escape');
  await sleep(200);
  const hidden = await ringState(page);
  const running = await page.locator(`${SINGLE} .stop-button`).count();
  await page.keyboard.press('Enter');
  await page.locator(`${SINGLE} [data-testid="usage-details"]`).waitFor({ timeout: 3000 }).catch(() => {});
  const opened = await ringState(page);
  await page.keyboard.press('Escape');
  await sleep(200);
  const closed = await ringState(page);
  const still = await page.locator(`${SINGLE} .stop-button`).count();
  const sent = (await h.commandCount()) - before;
  record('stop：Tab 到圆环时显示悬停提示；Esc 先藏起提示、焦点留在圆环，不停止生成', Boolean(shown?.tip)
    && shown?.focused && hidden?.tip === null && hidden.focused && running === 1 && sent === 0,
  JSON.stringify({ shown: shown?.tip, hidden: hidden?.tip, focused: hidden?.focused, running, sent }));
  record('stop：圆环上按 Enter 打开详情；Esc 关上详情、焦点留在圆环，不停止生成，不发命令', Boolean(opened?.details)
    && opened?.expanded === 'true' && closed?.details === null && closed.focused && still === 1 && sent === 0,
  JSON.stringify({ opened: opened?.details, closed: closed?.details, still, sent }));
}

/**
 * @brief ▾"More send options"的菜单（models.md"窄栏"）：宽于 400px 时只有"Steer"；项的读屏名只有文字（没有" · "和快捷键），
 *        快捷键在 aria-keyshortcuts；打开时焦点在第一项。
 */
async function sendMenu(page) {
  await page.getByRole('button', { name: 'More send options' }).click();
  await page.getByRole('menu').waitFor();
  const items = await page.getByRole('menu').getByRole('menuitem').evaluateAll((list) => list.map((item) => ({
    keys: item.getAttribute('aria-keyshortcuts'), focused: document.activeElement === item })));
  const named = await page.getByRole('menuitem', { name: 'Steer', exact: true }).count();
  record('stop：宽于 400px 时 ▾ 菜单里只有"Steer"（没有"Queue for later"），读屏名只有文字，快捷键在 aria-keyshortcuts，'
    + '打开时焦点在它上面', items.length === 1 && items[0].keys === 'Control+Enter' && items[0].focused && named === 1,
  JSON.stringify(items));
}

/** @brief 停止：Esc 先关菜单；再按 Esc 时先撤回排队、再停止；命令卡"Stopped"，提示文字，排队消息回到输入框。 */
async function stopCheck(page, h) {
  await h.load('stop', { speed: 1 });
  await h.send('运行命令 `sleep 30; echo late`，然后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 20000 });
  await ringKeys(page, h);
  await h.textarea.fill('排队：这条会被撤回');
  await runningKeys(page);
  await sendMenu(page);
  await page.keyboard.press('Escape');
  const menuClosed = await page.getByRole('menu').count() === 0;
  const stillRunning = await page.locator('.stop-button').count() === 1;
  record('stop：有菜单时 Esc 只关菜单，不停止', menuClosed && stillRunning);
  await h.textarea.press('Enter');
  await page.getByTestId('queue').waitFor();
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await h.idle();
  const cards = await h.cards();
  const notice = await page.getByText(STOPPED_NOTICE).count();
  const errors = await page.getByTestId('error-card').count();
  record('stop：命令卡显示"已停止"，并提示修改不会自动撤销', cards[0]?.status === 'stopped' && cards[0].text === 'Stopped' && notice === 1,
    JSON.stringify(cards));
  record('stop：不把停止当成错误显示', errors === 0);
  record('stop：排队消息回到输入框', (await h.textarea.inputValue()).includes('排队：这条会被撤回'));
  record('stop：先撤回排队（clearQueue）再停止（abort）', (await h.replayErrors()).length === 0, (await h.replayErrors()).join('; '));
  await page.screenshot({ path: join(shots, 'stop.png') });
  const details = await openRingDetails(page);
  await page.evaluate(() => window.__replay.exit(1));
  await sleep(300);
  const kept = await ringState(page);
  record('stop：圆环详情开着时后台进程退出，详情不关（只有菜单关）', Boolean(details?.details) && Boolean(kept?.details),
    JSON.stringify({ before: details?.details, after: kept?.details }));
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText('Restarted', { exact: false }).first().waitFor({ timeout: 10000 });
  const reloaded = await h.cards();
  record('stop：从会话记录重新打开后，停止的命令仍显示"已停止"、提示仍在、没有错误卡',
    reloaded[0]?.status === 'stopped' && await page.getByText(STOPPED_NOTICE).count() === 1
      && await page.getByTestId('error-card').count() === 0, JSON.stringify(reloaded));
}

/**
 * @brief 在各个宽度下量这一行（drafts 里每段字各量一次；字为 null 时不改输入框），按 state 查；返回问题列表。
 *        宽度设不准时记"pane …px"。
 */
async function sweep(page, app, { widths, drafts, state }) {
  const bad = [];
  for (const width of widths) {
    const got = await setPaneWidth(page, app, width);
    for (const draft of drafts) {
      if (draft !== null) await page.locator(`${SINGLE} .composer textarea`).fill(draft);
      const row = await composerRow(page);
      const problems = Math.abs(got - width) > 0.5 ? [`pane ${got}px`] : rowProblems(row, state, OPTS);
      if (problems.length) bad.push(`${width}${draft ? '+字' : ''}: ${problems.join('; ')} (${rowSummary(row)})`);
    }
  }
  return bad;
}

/**
 * @brief 930px、生成中有字（models.md"不可用时、按钮消失时的焦点""什么时候自动关"）：焦点在 ▾ 上时清空草稿（不挪焦点），
 *        "Queue ▾"消失，焦点回到这一栏的文字框；再写上字、打开 ▾ 的菜单（焦点在菜单里）时清空草稿：菜单跟着关、▾ 消失，
 *        焦点回到文字框。
 */
async function clearDraftOnToggle(page, app) {
  await setPaneWidth(page, app, 930);
  const toggle = page.locator(`${SINGLE} .split-toggle`);
  const results = [];
  for (const withMenu of [false, true]) {
    await page.locator(`${SINGLE} .composer textarea`).fill(BAND_DRAFT);
    await toggle.focus();
    if (withMenu) {
      await page.keyboard.press('Enter');
      await page.getByRole('menu').waitFor({ timeout: 3000 }).catch(() => {});
    }
    const before = { focus: await focusName(page), menu: await page.getByRole('menu').count() };
    await setDraftKeepingFocus(page, SINGLE, '');
    await toggle.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
    results.push({ withMenu, before, menu: await page.getByRole('menu').count(), toggle: await toggle.count(),
      focus: await focusInComposer(page) });
  }
  const [plain, menu] = results;
  record('bands：焦点在 ▾ 上时清空草稿，"Queue ▾"消失，焦点回到文字框；▾ 的菜单开着时清空草稿，菜单跟着关、焦点回到文字框',
    plain.before.focus === 'More send options' && plain.toggle === 0 && plain.focus === true
    && menu.before.menu === 1 && menu.menu === 0 && menu.toggle === 0 && menu.focus === true, JSON.stringify(results));
}

/**
 * @brief 生成中有字、Effort 是"Unavailable"时，圆环详情在 601、680、740、761px 也往上打开、右边对齐这一行、在面板里
 *        （composer-pickers.md"测试要改的地方"新加的检查第 4 条）。
 */
async function wideRingDetails(page, app) {
  const bad = [];
  for (const width of [601, 680, 740, 761]) {
    await setPaneWidth(page, app, width);
    await page.locator(`${SINGLE} .composer textarea`).fill(BAND_DRAFT);
    bad.push(...(await popoverChecks(page, SINGLE, ['ring'])).map((problem) => `${width}px ${problem}`));
  }
  record('bands：生成中有字时圆环详情在 601、680、740、761px 往上打开、右边对齐这一行（宽 min(260px, 这一行)）、'
    + '在会话面板和窗口里、不抢焦点', bad.length === 0, bad.join('; '));
}

/** @brief 打开着的菜单里各项的名字（aria-label，没有时第一段字）和 aria-keyshortcuts，以及焦点所在那一项的名字。 */
const openMenuItems = (page) => page.evaluate(() => {
  const name = (item) => item?.getAttribute('aria-label') ?? item?.childNodes[0]?.textContent ?? null;
  const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
  return { items: items.map((item) => ({ name: name(item), keys: item.getAttribute('aria-keyshortcuts') })),
    focused: name(document.activeElement?.closest('[role="menuitem"]')) };
});

/**
 * @brief 400px、生成中有字（models.md"窄栏"很窄）："Queue"收起；Tab 到 ▾、Enter 打开 → 焦点在"Queue for later"，
 *        ↓ 到"Steer"，Esc 回到 ▾；再打开选"Queue for later"真的排队（排队区多一条"Queued"），草稿清空、▾ 消失后焦点回到
 *        文字框；项的读屏名只有文字（没有" · "和快捷键），aria-keyshortcuts 是"Enter"、"Control+Enter"。
 */
async function queueForLater(page, app) {
  await setPaneWidth(page, app, 400);
  await page.locator(`${SINGLE} .composer textarea`).fill(BAND_DRAFT);
  const path = await tabPath(page, `${SINGLE} .composer textarea`, (name) => name === 'More send options', 8);
  await page.keyboard.press('Enter');
  await page.getByRole('menu').waitFor({ timeout: 3000 }).catch(() => {});
  const first = await openMenuItems(page);
  const named = ['Queue for later', 'Steer'].map((name) => page.getByRole('menuitem', { name, exact: true }).count());
  const names = await Promise.all(named);
  await page.keyboard.press('ArrowDown');
  const second = (await openMenuItems(page)).focused;
  await page.keyboard.press('Escape');
  const back = await focusName(page);
  record('bands：400px 生成中有字时"Queue"收起；Tab 依次到权限、选择范围、Effort、圆环、▾；Enter 打开 ▾ 菜单焦点在'
    + '"Queue for later"，↓ 到"Steer"，Esc 回到 ▾；两项的读屏名只有文字，快捷键在 aria-keyshortcuts（Enter、Control+Enter）',
  path.join() === `${ROW_PATH},More send options` && first.focused === 'Queue for later' && second === 'Steer'
    && back === 'More send options' && names.join() === '1,1' && JSON.stringify(first.items)
    === JSON.stringify([{ name: 'Queue for later', keys: 'Enter' }, { name: 'Steer', keys: 'Control+Enter' }]),
  JSON.stringify({ path, first, second, back, names }));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const queued = await page.waitForFunction((text) => document.querySelector('[data-testid="queue"]')?.textContent
    ?.includes(text), BAND_DRAFT, { timeout: 10000 }).then(() => true, () => false);
  const queueText = await page.getByTestId('queue').innerText().catch(() => '');
  record('bands：400px 选"Queue for later"真的排队（排队区多一条"Queued"）；▾ 随草稿清空消失，焦点回到文字框',
    queued && queueText.includes('Queued') && await focusInComposer(page) === true,
    `${oneLine(queueText)} 焦点 ${await focusName(page)}`);
}

/**
 * @brief 输入框下面一行在各档宽度和各状态下（composer-pickers.md"测试要改的地方"新加的检查第 2–6 条；chat.md
 *        "输入框下面一行"、models.md"窄栏""菜单的位置与键盘"）：stop 录制在等界面的下一条命令时一直在生成，量"生成中"
 *        （空 / 有字）；300px 打开权限、▾、圆环详情；930px 清空草稿时 ▾ 消失；400px 用 ▾ 的"Queue for later"排队；
 *        焦点在"Stop"上按 Enter 停止；量"空闲"、范围和 Effort 菜单、换范围失败、菜单开着时的键盘；后台进程退出后量"退出"；
 *        300px 时 Restart，抓"Restarting…"和重新打开中"Starting…"。
 */
async function bandsCheck(page, h, { app }) {
  await h.load('stop', { speed: 1 });
  await h.send('运行命令 `sleep 30; echo late`，然后告诉我输出。');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 20000 });
  const running = await sweep(page, app, { widths: BAND_WIDTHS, drafts: ['', BAND_DRAFT], state: 'running' });
  record('bands：生成中（输入框空 / 有字）在 300–930px 各档的上下沿：这一行不换行、不超出输入框、高 33px，每档该有的都在、'
    + '截短的先后和最窄对，读屏名和悬停第一行是全文，Effort 不可用、范围按钮可用，两者悬停写明原因', running.length === 0,
  running.slice(0, 4).join(' | '));
  await setPaneWidth(page, app, 300);
  await page.locator(`${SINGLE} .composer textarea`).fill(BAND_DRAFT);
  const runningMenus = await popoverChecks(page, SINGLE, ['permission', 'queue', 'ring']);
  record('bands：300px 生成中有字：权限菜单（左对齐这一行）、▾ 菜单（右对齐 ▾）、圆环详情（右对齐这一行）都往上打开，'
    + '在会话面板和窗口里、不盖顶栏、不比这一行宽；打开时焦点进菜单（详情不抢焦点），Esc 后回到按钮',
  runningMenus.length === 0, runningMenus.join('; '));
  await wideRingDetails(page, app);
  await clearDraftOnToggle(page, app);
  await queueForLater(page, app);
  await page.locator(`${SINGLE} .stop-button`).focus();
  await page.keyboard.press('Enter');
  await h.idle();
  record('bands：焦点在"Stop"上按 Enter 停止；本轮结束"Stop"消失后焦点回到这一栏的文字框（不掉到页面开头）',
    await focusInComposer(page) === true, await focusName(page));
  await idleBands(page, h, app);
  await crashBands(page, h, app);
  record('bands：回放命令与录制一致（▾ 的"Queue for later"发 followUp，"Stop"先 clearQueue 再 abort；失败的换范围不占顺序）',
    (await h.replayErrors()).length === 0, (await h.replayErrors()).join('; '));
  await setPaneWidth(page, app, 930);
}

/** @brief 空闲（空 / 有字）的各档；300px 和 930px 空闲时打开范围、Effort、权限菜单和圆环详情；换范围失败；菜单的键盘。 */
async function idleBands(page, h, app) {
  const idle = await sweep(page, app, { widths: BAND_WIDTHS, drafts: ['', BAND_DRAFT], state: 'idle' });
  record('bands：空闲（输入框空 / 有字）在 300–930px 各档的上下沿：这一行不换行、不超出输入框，每档该有的都在，截短的先后对，'
    + '三个按钮可用（没有 aria-disabled 属性），悬停第二行和读屏描述对', idle.length === 0, idle.slice(0, 4).join(' | '));
  const menus = [];
  for (const width of [300, 930]) {
    await setPaneWidth(page, app, width);
    menus.push(...(await popoverChecks(page, SINGLE, ['model', 'effort', 'permission', 'ring']))
      .map((problem) => `${width}px ${problem}`));
  }
  record('bands：300px 和 930px 空闲时范围菜单（宽 min(300px, 这一行)）、Effort 菜单往上打开、右边对齐自己的按钮（放不下时'
    + '左边贴这一行左端），权限菜单左对齐、圆环详情右对齐这一行；都在会话面板和窗口里、不盖顶栏；打开、Esc 时焦点对',
  menus.length === 0, menus.join('; '));
  await setPaneWidth(page, app, 300);
  await pickErrorCheck(page, h);
  await setPaneWidth(page, app, 930);
  await menuKeys(page, h);
}

/**
 * @brief 换范围失败（models.md"菜单的位置与键盘"表下、model-menu.md"切换失败"）：回放桥 failNext 让 session.setPick
 *        失败一次（synthetic，不占回放顺序）："Couldn’t change the model range: <原文>"（role="alert"）从这一行往上弹出
 *        （下边在这一行上方 6px）、右边对齐范围按钮或左边贴这一行左端、不宽于 min(320px, 这一行)、在面板里；按钮回到原来的
 *        范围；打开菜单时消失；再失败一次，10 秒后消失。
 */
async function pickErrorCheck(page, h) {
  const error = page.locator(`${SINGLE} [data-testid="pick-error"]`);
  const button = page.locator(`${SINGLE} [data-testid="model-button"]`);
  const fail = async () => {
    await button.click();
    await page.getByTestId('model-menu').waitFor({ timeout: 3000 }).catch(() => {});
    await failNext(page, PICK_FAIL);
    await page.getByTestId('model-menu').locator('[role="menuitemradio"]:not([aria-checked="true"])').first().click();
    await error.waitFor({ timeout: 5000 }).catch(() => {});
  };
  const pick = await button.getAttribute('data-pick');
  const before = await h.commandCount();
  await fail();
  const box = await popoverBox(page, SINGLE, '[data-testid="pick-error"]', '[data-testid="model-button"]');
  const shown = { text: await error.innerText().catch(() => ''),
    role: await error.getAttribute('role').catch(() => null), pick: await button.getAttribute('data-pick'),
    pending: await button.getAttribute('data-pending') };
  const problems = popoverProblems(box, { align: 'anchor', maxWidth: 320 });
  await button.click();
  const cleared = await error.count() === 0;
  await page.keyboard.press('Escape');
  await fail();
  const start = Date.now();
  await error.waitFor({ state: 'detached', timeout: 13000 }).catch(() => {});
  const lasted = Date.now() - start;
  record('bands：300px 换范围失败："Couldn’t change the model range: <原文>"（role="alert"）从这一行往上弹出、对齐范围按钮、'
    + '不宽于 min(320px, 这一行)、在面板里；按钮回到原来的范围；打开菜单时消失，否则 10 秒后消失',
  shown.text === `Couldn’t change the model range: ${PICK_FAIL}` && shown.role === 'alert' && shown.pick === pick
    && shown.pending === null && problems.length === 0 && cleared && lasted >= 8000 && lasted <= 12500
    && (await h.commandCount()) === before, `${JSON.stringify(shown)} ${problems.join('; ')} 打开菜单清掉 ${cleared}；`
    + `${lasted}ms 后消失`);
}

/**
 * @brief 930px 空闲、范围菜单开着（models.md"菜单的位置与键盘"）：Ctrl+N 不新建会话；文字框里有字时在菜单里按 Enter
 *        只选项（当前范围：菜单关上、焦点回到范围按钮），不发送也不排队，草稿还在。之后查 Tab 移出（tabOut）。
 */
async function menuKeys(page, h) {
  const menu = page.getByTestId('model-menu');
  const open = async (css = '[data-testid="model-button"]') => {
    await page.locator(`${SINGLE} ${css}`).click();
    await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'), null, { timeout: 3000 })
      .catch(() => {});
  };
  await page.locator(`${SINGLE} .composer textarea`).fill(BAND_DRAFT);
  const before = { commands: await h.commandCount(), panes: await page.locator('.pane-slot').count() };
  await open();
  await page.keyboard.press('Control+n');
  await sleep(300);
  const ctrlN = await page.locator('.pane-slot').count() === before.panes && await menu.count() === 1;
  await page.keyboard.press('Enter');
  await sleep(300);
  const enter = { closed: await menu.count() === 0, focus: await focusName(page),
    draft: await page.locator(`${SINGLE} .composer textarea`).inputValue(),
    sent: (await h.commandCount()) - before.commands };
  record('bands：范围菜单开着时 Ctrl+N 不新建会话；文字框里有字时在菜单里按 Enter 只选项（菜单关上、焦点回到范围按钮），'
    + '不发送也不排队，草稿还在', ctrlN && enter.closed && enter.focus === 'model-button' && enter.draft === BAND_DRAFT
    && enter.sent === 0, JSON.stringify({ ctrlN, ...enter }));
  await tabOut(page, open);
}

/**
 * @brief Tab 移出时关闭（models.md"Tab 移出时关闭"）：打开范围菜单、按 F8 → 菜单不关，关掉报告框后焦点回到原来那一项；
 *        点底部说明 → 不关；从"Manage models"按 Tab 移到外面 → 关上；打开权限菜单、点"Allowed for this session:" → 不关。
 * @param open 打开一个菜单（按钮的选择器），等焦点进了菜单
 */
async function tabOut(page, open) {
  const menu = page.getByTestId('model-menu');
  await open();
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 }).catch(() => {});
  const withF8 = await menu.count() === 1;
  await page.keyboard.press('Escape');
  await page.getByTestId('issue-dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const back = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="model-menu"]'))
    && document.activeElement?.getAttribute('aria-checked') === 'true');
  await page.getByTestId('model-menu-note').click();
  const note = await menu.count() === 1;
  await menu.locator('[data-action="manage-models"]').focus();
  await page.keyboard.press('Tab');
  await sleep(200);
  const tabbed = { closed: await menu.count() === 0, focus: await focusName(page) };
  await open('[data-testid="permission-button"]');
  await page.getByTestId('permission-menu').getByText('Allowed for this session:').click();
  const caption = await page.getByTestId('permission-menu').count() === 1;
  await page.keyboard.press('Escape');
  record('bands：开着范围菜单按 F8 不关菜单，关掉报告框后焦点回到原来那一项；点底部说明不关；从"Manage models"按 Tab '
    + '移到外面时关上；开着权限菜单点"Allowed for this session:"不关', withF8 && back && note && tabbed.closed
    && caption, JSON.stringify({ withF8, back, note, tabbed, caption }));
}

/** @brief 后台进程退出的各档；300px 时 Restart，抓"Restarting…"和重新打开中"Starting…"的这一行。 */
async function crashBands(page, h, app) {
  await page.evaluate(() => window.__replay.exit(1));
  await page.getByTestId('kernel-exit').waitFor({ timeout: 5000 });
  const crashed = await sweep(page, app, { widths: CRASH_WIDTHS, drafts: [null], state: 'crashed' });
  record('bands：后台进程退出时各档：说明在按钮位置（先于范围按钮截短、最窄 48px、悬停是全文），权限、选择范围、Effort 不可用、'
    + '原因"Mori’s background process crashed"，圆环保留', crashed.length === 0, crashed.slice(0, 4).join(' | '));
  await setPaneWidth(page, app, 300);
  await watchRows(page);
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText('Restarted', { exact: false }).first().waitFor({ timeout: 10000 });
  const seen = await seenRows(page);
  const problems = [['Restarting…', 'restarting'], ['Starting…', 'reopening']].flatMap(([text, state]) => {
    const row = seenWith(seen, text);
    return [...layoutProblems(row), ...stateProblems(row, state, OPTS)].map((p) => `${text}: ${p}`);
  });
  record('bands：300px 时 Restart："Restarting…"和重新打开中"Starting…"这一行不换行、不溢出，选择范围、Effort、圆环仍在'
    + '（不可用，原因是按钮位置的说明）', problems.length === 0, problems.join('; ') || Object.keys(seen).join(', '));
}

/**
 * @brief 第一次打开中、打开失败（chat.md"输入框下面一行"后台正在启动、打开失败；models.md）。第一次打开中这一行只有
 *        权限按钮（不可用，原因"Starting…"）和"Starting…"；打开失败（synthetic：回放桥 failNext 让 session.create 失败）
 *        只有权限按钮（原因"Session didn’t open"）和说明，高 33px，930px、300px 都放得下。
 */
async function openStates(page, h, app) {
  await page.goto(h.url('readme'));
  await page.getByTestId('open-folder').waitFor({ timeout: 20000 });
  await watchRows(page);
  await page.getByRole('button', { name: 'Open folder…' }).first().click();
  await page.getByTestId('chat-pane').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="not-ready"]'), null, { timeout: 20000 });
  const opening = seenWith(await seenRows(page), 'Starting…');
  const openingProblems = [...layoutProblems(opening), ...stateProblems(opening, 'opening', OPTS)];
  record('open-failed：第一次打开中这一行只有权限按钮（不可用、原因"Starting…"）和"Starting…"，没有选择范围、Effort 和'
    + '圆环，高 33px', openingProblems.length === 0, `${openingProblems.join('; ')} ${rowSummary(opening)}`);
  await page.goto(h.url('readme'));
  await page.getByTestId('open-folder').waitFor({ timeout: 20000 });
  await failNext(page, 'Synthetic: session.create failed');
  await page.getByRole('button', { name: 'Open folder…' }).first().click();
  await page.locator('[data-testid="not-ready"]', { hasText: 'Session didn’t open' }).waitFor({ timeout: 20000 });
  const failed = [];
  for (const width of [930, 300]) {
    await setPaneWidth(page, app, width);
    failed.push(...rowProblems(await composerRow(page), 'failed', OPTS).map((p) => `${width}px ${p}`));
  }
  record('open-failed：打开失败时这一行只有权限按钮（不可用、原因"Session didn’t open"）和说明，没有选择范围、Effort 和'
    + '圆环，高 33px；930px 和 300px 都放得下', failed.length === 0, failed.join('; '));
  await setPaneWidth(page, app, 930);
}

/**
 * @brief 打开失败时焦点所在的范围按钮消失，焦点回到这一栏的文字框（models.md"不可用时、按钮消失时的焦点"）：
 *        后台进程退出后焦点放在范围按钮上，Restart 之后重新打开失败（synthetic：failNext）。
 */
async function reopenFails(page, h) {
  await h.load('readme');
  await page.evaluate(() => window.__replay.exit(1));
  await page.getByTestId('kernel-exit').waitFor({ timeout: 5000 });
  await page.locator(`${SINGLE} [data-testid="model-button"]`).focus();
  await failNext(page, 'Synthetic: session.open failed');
  await restartKeepingFocus(page);
  await page.locator('[data-testid="not-ready"]', { hasText: 'Session didn’t open' }).waitFor({ timeout: 20000 });
  await sleep(200);
  const focus = await focusInComposer(page);
  const row = await composerRow(page);
  record('open-failed：焦点在范围按钮上时重新打开失败，选择范围、Effort 按钮消失，焦点回到这一栏的文字框',
    focus === true && !row?.items.model && !row?.items.effort, `焦点 ${await focusName(page)}；${rowSummary(row)}`);
}

/** @brief 打开中、打开失败时输入框下面一行的样子和焦点。 */
async function openFailedCheck(page, h, { app }) {
  await openStates(page, h, app);
  await reopenFails(page, h);
}

/**
 * @brief key 填错（v1，docs/specs/model-providers.md §9.3、§14.4）：v0 错误卡的"Go to settings"删除，认证类错误由模型层处理，
 *        换不到模型时对话流是一张说明卡（"No model available"，候选行"API key rejected"，"Open settings"），没有错误卡；
 *        "Open settings"打开 设置 → Models，焦点在出错提供商的 Keys。
 *        m1/wrong-key.json 是 v0 录下的（pi 的 401 错误，没有 mori.model_unavailable）：这时只能查错误卡显示 401 原文、
 *        不再有"Go to settings"；说明卡的检查标 KNOWN，等用 m1-record.mjs 以 v1 重新录制。
 */
async function wrongKeyCheck(page, h) {
  await h.load('wrong-key');
  const fixture = JSON.parse(readFileSync(join(appRoot, 'tests/fixtures/m1/wrong-key.json'), 'utf8'));
  const recordedV1 = fixture.steps.some((step) => step.envelope?.event.type === 'mori.model_unavailable');
  await h.send('你好');
  if (!recordedV1) {
    const card = page.getByTestId('error-card');
    await card.waitFor({ timeout: 10000 });
    const text = await card.innerText();
    record('wrong-key：v0 的录制回放时错误卡显示 401 原文，不再有"Go to settings"（§9.3 删除）', text.includes('401')
      && !text.includes('Go to settings')
      && await card.getByRole('button', { name: 'Go to settings' }).count() === 0, oneLine(text));
    record('wrong-key：说明卡（"API key rejected"、"Open settings"，没有错误卡）', false,
      'm1/wrong-key.json 是 v0 录下的，没有 mori.model_unavailable；用 m1-record.mjs --only wrong-key 以 v1 重新录制', true);
    await page.screenshot({ path: join(shots, 'wrong-key.png') });
    return;
  }
  const card = page.getByTestId('unavailable-card');
  await card.waitFor({ timeout: 10000 });
  const text = oneLine(await card.innerText());
  record('wrong-key：说明卡（"API key rejected"、"Open settings"），没有错误卡', text.includes('No model available')
    && text.includes('API key rejected') && text.includes('Open settings')
    && await page.getByTestId('error-card').count() === 0, text);
  await page.screenshot({ path: join(shots, 'wrong-key.png') });
  await card.locator('[data-action="open-settings"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="key-row"]'), null,
    { timeout: 5000 }).catch(() => {});
  const focus = await page.evaluate(() => ({ key: Boolean(document.activeElement?.closest('[data-testid="key-row"]')),
    provider: document.activeElement?.closest('[data-testid="provider-card"]')?.dataset.provider ?? null }));
  record('wrong-key："Open settings"打开 设置 → Models，焦点在出错提供商的 Keys', focus.key, JSON.stringify(focus));
  await page.getByRole('button', { name: 'Back to app' }).click();
  record('wrong-key：返回会话后说明卡还在', await page.getByTestId('unavailable-card').isVisible());
}

/**
 * @brief 压缩：阶段行"Compacting session…"，对话流留下"Compacted session"；你不在底部时"Jump to latest"。
 *        8,000 的上下文窗口：圆环的数照 Claude 写成 k（"≈ 3k / 8k"，一位小数的".0"去掉），读屏名写完整的数。
 *        （"刚压缩完"的空圆环在这份录制里看不到：录制器只在 turn_end 后读 session.state，录下的结果都有用量，回放桥压缩之后
 *        回答的是下一次的用量；改在 m1-app 和 m1-real 里查。）
 */
async function compactionCheck(page, h) {
  await h.load('compaction', { speed: 4, maxGap: 300 });
  await h.sampleStages();
  const asks = ['读一下 README.md 和 src/a.ts，然后详细介绍这个项目。', '再详细解释 add 函数，并给出三个使用例子。',
    '把上面的内容整理成一份 Markdown 文档的大纲。', '最后用三句话总结我们聊了什么。'];
  await h.send(asks[0]);
  await h.idle();
  await h.send(asks[1]);
  await sleep(200);
  await page.getByTestId('transcript').evaluate((element) => { element.scrollTop = 0; });
  const sawNew = await page.getByTestId('new-content').waitFor({ timeout: 20000 }).then(() => true, () => false);
  record('scroll：不在底部时显示"有新内容 ↓"，不自动滚动', sawNew
    && await page.getByTestId('transcript').evaluate((element) => element.scrollTop < 50));
  if (sawNew) await page.getByTestId('new-content').click();
  const atBottom = await page.getByTestId('transcript').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30);
  record('scroll：点"有新内容 ↓"回到底部并继续跟随', atBottom);
  await h.idle();
  for (const text of asks.slice(2)) {
    await h.send(text);
    await h.idle();
  }
  const stages = await h.stages();
  record('compaction：阶段行显示"正在压缩较早的对话"', stages.includes('Compacting session…'), stages.slice(0, 12).join(' → '));
  const notices = await page.getByText('Compacted session', { exact: true }).count();
  record('compaction：对话流留下"已压缩较早的对话"', notices >= 1, `${notices} 处`);
  const ring = await hoverRing(page);
  record('compaction：8,000 的上下文窗口：圆环悬停"Context ≈ …k / 8k (N%)"，读屏名写完整的数，与 data-tokens 一致',
    ringTextProblems(ring).length === 0 && / \/ 8k \(\d+%\)$/.test(ring?.tip ?? ''),
    `${ringTextProblems(ring).join('; ')} ${ring?.tip} | ${ring?.label}`);
  const failed = page.getByTestId('error-card').filter({ hasText: 'Summarization failed' }).first();
  const failText = await failed.innerText().catch(() => '');
  record('compaction：压缩失败显示原文和"把上一条消息放回输入框"',
    failText.includes('Put your last message back in the message box'), oneLine(failText));
  await failed.getByRole('button', { name: 'Put your last message back in the message box' }).click();
  record('compaction：点它把上一条消息放回输入框', (await h.textarea.inputValue()).length > 0, await h.textarea.inputValue());
  await page.screenshot({ path: join(shots, 'compaction.png') });
}

/** @brief 长会话：先显示最近 50 条，滚到顶部载入更早的，当前看到的内容不跳动（synthetic 拼出的会话记录）。 */
async function longHistoryCheck(page, h) {
  await h.load('synthetic-long-history');
  await page.evaluate(() => window.__replay.exit(1));
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByText('Restarted', { exact: false }).first().waitFor({ timeout: 10000 });
  const count = () => page.locator('[data-testid="user-message"], [data-testid="assistant"]').count();
  const first = await count();
  const hint = await page.getByText('Scroll up to load earlier messages').count();
  const anchor = page.getByTestId('user-message').first();
  const label = await anchor.innerText();
  // 先停在离顶部 60px 处量一次位置（还不会触发载入），再滚到顶部触发载入。
  await page.getByTestId('transcript').evaluate((element) => { element.scrollTop = 60; });
  await sleep(300);
  const before = await anchor.boundingBox();
  await page.getByTestId('transcript').evaluate((element) => { element.scrollTop = 0; });
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant"]').length > n,
    first, { timeout: 5000 }).catch(() => {});
  const second = await count();
  await sleep(1500);
  const top = await page.getByTestId('user-message').filter({ hasText: label }).first().boundingBox();
  record('history：先显示最近 50 条，滚到顶部再载入 50 条', first === 50 && hint === 1 && second === 100, `${first} → ${second}`);
  // 滚到顶部时它下移 60px；载入后应停在那里（容差 30px）。
  record('history：载入更早的消息时看到的内容不跳动', top !== null && Math.abs(top.y - (before.y + 60)) < 30,
    `载入前 y=${before?.y}，载入后 y=${top?.y}`);
}

/**
 * @brief 页面里：从现在起每次 DOM 变化时记下回复里 mermaid 代码块、其中还没写完的（Streamdown 标 data-incomplete）和图的
 *        个数（window.__mermaidSeen），看流式时还没写完的代码块显示为代码、写完才有图。
 *        （第一次渲染正文时往往已经有一两张写完的图：回放的增量比渲染快，所以不能要求"还没有图时先有代码"。）
 */
function watchMermaid(page) {
  return page.evaluate(() => {
    window.__mermaidSeen = [];
    new MutationObserver(() => {
      const prose = document.querySelector('.pane-slot:not([hidden]) [data-testid="assistant"]');
      if (!prose) return;
      const code = '[data-streamdown="code-block"][data-language="mermaid"]';
      window.__mermaidSeen.push({ code: prose.querySelectorAll(code).length,
        open: prose.querySelectorAll(`${code}[data-incomplete]`).length,
        hosts: prose.querySelectorAll('[data-testid="mermaid-diagram"]').length });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

/**
 * @brief 回复里的 mermaid：代码块（开头、结尾、长度、有没有"Copy code"）和图（读屏名、在画、shadow DOM 里的 SVG、字和
 *        图的种类：mermaid 写在 SVG 的 aria-roledescription 上）。
 */
function mermaidState(page) {
  return page.evaluate(() => {
    const prose = document.querySelector('.pane-slot:not([hidden]) [data-testid="assistant"]');
    const hosts = [...(prose?.querySelectorAll('[data-testid="mermaid-diagram"]') ?? [])];
    const code = [...(prose?.querySelectorAll('[data-streamdown="code-block"][data-language="mermaid"]') ?? [])];
    const text = (block) => block.querySelector('pre')?.textContent ?? '';
    return {
      code: code.map((block) => ({ head: text(block).slice(0, 40), tail: text(block).slice(-40),
        length: text(block).length, copy: Boolean(block.querySelector('[aria-label="Copy code"]')) })),
      hosts: hosts.map((host) => ({ role: host.getAttribute('role'), label: host.getAttribute('aria-label'),
        busy: host.getAttribute('aria-busy'), noQuote: host.hasAttribute('data-no-quote'),
        svg: Boolean(host.shadowRoot?.querySelector('svg')), text: host.shadowRoot?.textContent ?? '',
        type: host.shadowRoot?.querySelector('svg')?.getAttribute('aria-roledescription') ?? null,
        width: Math.round(host.shadowRoot?.querySelector('svg')?.getBoundingClientRect().width ?? 0) })),
    };
  });
}

/** synthetic-mermaid 里能画的六张图的种类，按出现的顺序（harness/main.jsx MERMAID_DRAWN；pie 由 langium 解析） */
const MERMAID_TYPES = [/^flowchart/, /^sequence$/, /^class/, /^state/, /^gantt$/, /^pie$/];

/**
 * @brief docs/v0/screens/chat.md"图"（2026-10-26 走查 M16，synthetic-mermaid）：流式时 mermaid 代码块先显示为代码、写完才画；
 *        能画的画成图（shadow DOM 里的 SVG，读屏名"Mermaid diagram"，role="img"，不进选区；流程图的中文标签和 <br/> 换行
 *        都在），流程、时序、类、状态、甘特、pie 六种都画得出来；画不出来的三张（语法错误、超过 2 万字、超过 400 条边）显示
 *        普通代码块（带"Copy code"），不显示错误原文；内容安全策略下页面没有报错（最后的"页面没有报错"）。
 */
async function mermaidCheck(page, h) {
  await h.load('synthetic-mermaid', { speed: 1 });
  await watchMermaid(page);
  await h.textarea.fill(MARKDOWN_PROMPT);
  await h.textarea.press('Enter');
  await h.idle();
  await page.waitForFunction(() => {
    const hosts = [...document.querySelectorAll('[data-testid="mermaid-diagram"]')];
    return hosts.length > 0 && hosts.every((host) => host.getAttribute('aria-busy') !== 'true');
  }, null, { timeout: 30000 }).catch(() => {});
  const seen = await page.evaluate(() => window.__mermaidSeen);
  const state = await mermaidState(page);
  const [diagram] = state.hosts;
  const types = state.hosts.map((host) => host.type);
  record('mermaid：流式时还没写完的代码块显示为代码（Streamdown 标为没写完，同时最多一个），写完才画；结束后没有没写完的',
    seen.some((s) => s.open === 1) && seen.every((s) => s.open <= 1) && seen.at(-1)?.open === 0,
    JSON.stringify(seen.filter((s, i) => i === 0 || JSON.stringify(s) !== JSON.stringify(seen[i - 1])).slice(0, 12)));
  record('mermaid：能画的画成图：shadow DOM 里的 SVG，读屏名"Mermaid diagram"、role="img"、不进选区，中文标签和 <br/> 的两行都在',
    diagram?.svg && diagram.role === 'img' && diagram.label === 'Mermaid diagram'
    && diagram.busy === null && diagram.noQuote && diagram.text.includes('读取配置')
    && diagram.text.includes('settings.json') && !diagram.text.includes('<br') && diagram.width > 100,
  JSON.stringify(diagram ?? null));
  record('mermaid：流程、时序、类、状态、甘特和 pie（langium 解析）六种图都画成图（内容安全策略拦下的会显示代码、控制台报错）',
    state.hosts.length === MERMAID_TYPES.length && state.hosts.every((host) => host.svg && host.busy === null)
    && MERMAID_TYPES.every((type, index) => type.test(types[index] ?? '')), JSON.stringify(types));
  const [syntax, long, edges] = state.code;
  record('mermaid：画不出来的三张（语法错误、超过 2 万字、401 条边）显示普通代码块（带"Copy code"），不显示错误原文',
    state.code.length === 3 && state.code.every((block) => block.copy) && syntax.head.includes('not a diagram at all')
    && long.head.startsWith('flowchart LR') && long.length > 20000 && edges.tail.includes('n400 --> n401')
    && !(await page.getByTestId('assistant').innerText()).match(/error|syntax|maximum|exceeded/i),
  JSON.stringify(state.code));
  record('mermaid：回放命令与录制一致', (await h.replayErrors()).length === 0, (await h.replayErrors()).join('; '));
  await page.screenshot({ path: join(shots, 'mermaid.png') });
}

const checks = { readme: readmeCheck, markdown: markdownCheck, mermaid: mermaidCheck, 'command-fail': commandFailCheck,
  edit: editCheck,
  'queue-steer': queueSteerCheck, 'two-tools-steer': twoToolsCheck, stop: stopCheck, bands: bandsCheck,
  'open-failed': openFailedCheck,
  // v1：m1/no-key.json 与它的检查删去（v1 里没有 key 的提供商请求不带认证头，没有这种情形，§14.4）
  'wrong-key': wrongKeyCheck, compaction: compactionCheck, history: longHistoryCheck, layout: layoutChecks };

await buildHarness();
const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
  env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'),
    MORI_HARNESS_DATA: mkdtempSync(join(tmpdir(), 'mori-harness-')) } });
const page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
// 控制台的错误另记：回放桥 failNext 造出的失败界面照例记一条错误日志，最后按注入的次数扣掉（unexpectedErrors）
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
const h = helpers(page);
for (const [name, check] of Object.entries(checks)) {
  if (only && !only.includes(name)) continue;
  try {
    await check(page, h, { app, record, shots, helpers: h });
  } catch (error) {
    record(`${name}：流程`, false, oneLine(error, 400));
    await page.screenshot({ path: join(shots, `${name}-error.png`) }).catch(() => {});
  }
}
const errors = [...pageErrors, ...unexpectedErrors(consoleErrors)];
record('页面没有报错', errors.length === 0, errors.slice(0, 5).join(' | '));
await app.close();
process.exitCode = write('m1-replay.json') ? 0 : 1;
