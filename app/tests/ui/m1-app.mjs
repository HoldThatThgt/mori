// M1 整机测试：真正的 Mori（界面 + 后台进程 + pi）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖首次启动、测试连接与取消、代码块的"Copy code"、停止、排队与插话、三种错误来源、后台进程退出与重新载入、
// 重启后布局还在。v1（docs/specs/model-providers.md §14.4）：首次启动是英文表单；重试改为 http-503-once 与
// "Retrying 1/3"；key 被拒改为删 key、加错的 key → 说明卡 → Open settings（焦点在 Keys）→ 加回对的 key。
// 一键拉取模型（docs/specs/model-discovery.md §13.4）：首次启动是 Base URL 和 API key → Fetch models → 清单里勾模型；
// 卡上加 fake-slow 改为卡上 Fetch models → 勾 fake-slow → Add 1 model（page.mjs cardAddModels）。
// 2026-10-21 起（docs/v0/composer-pickers.md）：输入框下面一行的上下文用量圆环（docs/v0/screens/models.md"上下文用量
// （圆环）"）：还没有消息、颜色分档（改小上下文窗口）、999,950 写成 1M、刚压缩完（pi 的压缩参数调到每轮都压缩）；
// 准备中、切换中（很短的范围"o3"，范围菜单往上打开、右边对齐范围按钮）、后台进程退出、Restart 之后这一行的样子和焦点。
// 2026-10-26 起（WP-12，models.md"详情里的分项"）：详情里的分项——默认的自动压缩有"Autocompact buffer"（16,384）；
// 另起一个关掉自动压缩、带用户级 AGENTS.md（synthetic）的 Mori，看"Memory files"一行、没有"Autocompact buffer"。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m1-app.mjs                         测开发构建
//   node tests/ui/m1-app.mjs --exe <Mori.exe 路径>   测打包后的程序
//   node tests/ui/m1-app.mjs --only 步骤1,步骤2       只跑这几步（firstRun 总是跑；测试分层第 2 条）；步骤名是下面 steps 的键，
//                                                    以及最后的 layoutRestart、ringRuns、mainKilled
// 2026-10-26（WP-02，负责人走查 M7，models-settings.md "Models 行"）：模型行没有 Test、档案摘要和常显的 Verify：设置页的取消测试
// 改用提供商卡的 Test connection（先把 fake-slow 移到第一个）；加模型后等行上的 data-probe 为 verified，出错时点状态行的
// "Verify again"。
// 结果写到 test-results/m1-app.json（文件名带 -packaged 后缀区分），截图在 test-results/m1-app/。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  appRoot, arg, createRecorder, killKernel, launch, mainPid, oneLine, prepareProject, processTree, sleep, sleepProcessIds,
  stillAlive, waitGone,
} from './lib.mjs';
import {
  composerRow, focusName, hoverRing, layoutProblems, openRingDetails, pendingProblems, popoverChecks,
  ringColorProblems, ringState, ringTextProblems, rowSummary, seenRows, seenWith, setPaneWidth, SINGLE, smallText,
  stateProblems, watchRows,
} from './m1-layout.mjs';
import { pageHelpers } from './page.mjs';
import { partsBrief, partsProblems, readParts } from './ring-parts.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
/** @brief 这一步要不要跑：没有 --only 时都跑；firstRun 总是跑（其余步骤都要它打开的会话）。 */
const wanted = (name) => !only || name === 'firstRun' || only.includes(name);
const suffix = exePath ? '-packaged' : '';
const port = 4321;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key';
const shots = join(appRoot, `test-results/m1-app${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
/** 重新载入后对话流里的说明（state/projects.ts RELOADED_NOTE） */
const RESTARTED_NOTE = 'Restarted · Queued messages, pending approvals, and “Allow for this session” choices '
  + 'weren’t restored';
/** 还没有消息、刚压缩完时圆环的描述和详情里的说明（models.md"上下文用量（圆环）"） */
const EMPTY_NOTE = 'Send a message to see context usage.';
const COMPACTED_NOTE = 'Just compacted. Context usage shows after the next response.';
/** 选择范围按钮悬停的第二行：首次启动建的提供商名和区域 */
const APP_OPTS = { modelTip: 'Mori endpoint · Local' };
/** pi 不自动压缩（改小上下文窗口看圆环的颜色时，不让压缩把用量清掉） */
const NO_COMPACTION = { compaction: { enabled: false } };
/** 量圆环时新会话的第一条消息（同一个项目、同一句话，第一次回复之后的用量相同） */
const RING_FIRST = 'plain 圆环的第一条';
/** 首次启动表单填的上下文窗口（ringParts、ringPartsMemory 按它核对百分比和 Free space） */
const RING_WINDOW = 128000;
/** pi 默认的自动压缩留出的 token 数（compaction.js DEFAULT_COMPACTION_SETTINGS.reserveTokens） */
const PI_RESERVE = 16384;
/** 用户级 AGENTS.md 的内容（synthetic，只用来看"Memory files"一行） */
const AGENTS_TEXT = '# Fixture instructions (synthetic)\n\nAnswer in one short paragraph.\n';

/** @brief 启动合成端点（第一个分块前等 1.2 秒，便于看到"Waiting for the model…"）。 */
function startFakeEndpoint() {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '25', FAKE_FIRST_DELAY_MS: '1200',
      FAKE_REQUIRE_KEY: testKey },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((done) => child.stdout.on('data', (chunk) => String(chunk).includes('synthetic') && done(child)));
}

/**
 * @brief pi 的重试间隔调短（pi 自己的 settings.json）。v1 里 pi 的自动重试对 Mori 的会话关闭（规格 §5.5），重试由
 *        模型池按 §12 的真实间隔做；这份设置留着，保证 pi 读到的是一个合法的 settings.json。extra 是另外要写的设置
 *        （例如压缩参数）。
 */
function fastRetry(userData, extra = {}) {
  mkdirSync(join(userData, 'pi'), { recursive: true });
  const settings = { retry: { baseDelayMs: 200 }, ...extra };
  writeFileSync(join(userData, 'pi', 'settings.json'), JSON.stringify(settings, null, 2));
}

/**
 * @brief 选文件夹对话框（"Open folder…"和"Add plugin from folder…"共用）带英文的标题和按钮，不用 Windows 按显示语言给的
 *        默认文字（中文 Windows 上是"选择文件夹"）。系统对话框换成记下参数、返回取消的替身，经页面的 pickFolder 走真的主进程代码。
 */
async function pickerOptions(app, page) {
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (...args) => {
      globalThis.moriPickOptions = args.at(-1);
      return { canceled: true, filePaths: [] };
    };
  });
  const picked = await page.evaluate(() => window.mori.pickFolder());
  const options = await app.evaluate(() => globalThis.moriPickOptions ?? null);
  record('选文件夹对话框的标题"Select a folder"、按钮"Select folder"（不是 Windows 按显示语言给的默认文字）；取消时返回 null',
    picked === null && options?.title === 'Select a folder' && options.buttonLabel === 'Select folder'
    && options.properties?.join() === 'openDirectory', JSON.stringify({ picked, options }));
}

/**
 * @brief 首次启动（v1，英文表单，docs/v1/screens/first-run.md）：只有首次启动表单；字段错误是英文；测试中可以取消
 *        （"Testing…"、"Cancel" → "Test cancelled"）；401 原文；测试成功后表单关掉、进入主窗口（"Connected · …"在
 *        Open a folder 提示里，2026-10-26 负责人走查 M2），等探针跑完（经进程桥），再"Open folder…"。
 *        测试取消用 fake-slow（合成端点对它第一个分块前等 8 秒），之后同一张表单改回 fake-coder 再测（整体替换，
 *        配置里仍只有一个提供商）。
 *        一键拉取模型（model-discovery.md §13.4）：Base URL 和 API key → Fetch models → 清单；小字与 Name 必填的检查
 *        也看拉取之后的表单（清单与字段）；错的 key 在 Fetch models 时就得到列表错误 rejected，手填 fake-coder 继续。
 */
async function firstRun({ app, page, h, project, userData }) {
  const form = page.getByTestId('connection-form');
  await form.waitFor({ timeout: 60000 });
  record('首次启动：只有连接表单（没有侧栏和会话）', await page.getByTestId('sidebar').count() === 0);
  const small = await smallText(page);
  await h.fillConnection({ baseUrl, apiKey: testKey, modelId: 'fake-coder', name: 'x' });
  const fetched = await smallText(page);
  record('首次启动：没有小于 12px 的文字（拉取前，以及拉取后的清单与字段）', small.length === 0 && fetched.length === 0
    && await form.getByTestId('checklist').count() === 1, [...small, ...fetched].slice(0, 3).join('; '));
  await h.fillConnection({ name: '' });
  const nameError = await form.locator('[data-testid="field-error"][data-field="name"]').innerText().catch(() => '');
  const picked = await form.locator('[data-testid="discovered-row"] input[name="pick"]:checked').count();
  record('首次启动：没填的字段给出英文说明，Test connection 不可用（清单里勾着 fake-coder，只差 Name）',
    /^Name is required\.?$/.test(nameError) && picked === 1 && await form.locator('[data-action="test"]').isDisabled(),
    `${nameError}；勾选 ${picked} 行`);
  await cancelFormTest({ page, h });
  const rejected = await h.fillConnection({ apiKey: 'wrong-key', modelId: 'fake-coder' });
  await form.locator('[data-action="test"]').click();
  const wrong = await h.formMessage('Test cancelled', { test: true });
  record('首次启动：key 错误时 Fetch models 得到列表错误 rejected，手填 fake-coder 后测试连接显示错误原文',
    /^(Connection failed|Failed)/.test(wrong) && wrong.includes('401') && rejected?.state === 'list-error'
    && rejected.kind === 'rejected', `${JSON.stringify(rejected)}；${oneLine(wrong)}`);
  await firstRunPassed({ page, h, userData }, wrong);
  await page.screenshot({ path: join(shots, '01-first-run-ok.png') });
  await h.openFolder(app, project);
  await pickerOptions(app, page);
  const empty = await page.locator('.empty-chat').innerText();
  record('首次启动：打开文件夹后是新会话的空状态（项目名和输入提示）',
    empty.includes('project') && empty.includes('Enter to send · Shift+Enter for new line'), oneLine(empty));
  // M2 起命令和编辑要先批准；这里测的是 M1 的行为，先切到全部允许。
  await h.allowAll();
}

/**
 * @brief 首次启动的最后一次测试（换回对的 key）：Fetch models 拿到列表、勾 fake-coder，测试成功就关掉表单、进入主窗口
 *        （"Connected · …"在 Open a folder 提示里，first-run.md "测试成功之后：主窗口"）；再经进程桥等探针跑完。
 * @param wrong 上一次（key 错误时）测试的结果文字，等结果变化用
 */
async function firstRunPassed({ page, h, userData }, wrong) {
  const form = page.getByTestId('connection-form');
  // 圆环的检查（composer-pickers）按 128,000 的窗口写；原来首次启动表单的默认窗口就是它，拉取之后清单行是合成端点报告的
  // 131072，这里在清单行里改成 128000（model-discovery.md §6.2：行的 Context window 可以改）
  const listed = await h.fillConnection({ apiKey: testKey, modelId: 'fake-coder', contextWindow: 128000 });
  // model-discovery.md §13.4：换回对的 key 后 Fetch models 拿到列表，fake-coder 在清单里勾（行上没有"Entered by you"）；
  // 测试成功后表单就关掉了，所以在点 Test connection 之前读
  const coder = '[data-testid="discovered-row"][data-model="fake-coder"]:has(input[name="pick"]:checked)';
  const typed = await form.locator(coder).evaluateAll((rows) => rows
    .map((row) => row.querySelector('[data-testid="row-tag"][data-kind="entered"]') !== null));
  // 错的 key 那次保存已存下 error 档案；这次保存会重新探测，只认完成时刻不早于 since 的新档案（page.mjs waitProbes）
  const since = Date.now();
  await form.locator('[data-action="test"]').click();
  const ok = await h.testResult(wrong);
  await page.getByTestId('open-folder').waitFor({ timeout: 60000 });
  const handedOver = await form.count() === 0 && await page.getByTestId('sidebar').count() === 1;
  record('首次启动：换回对的 key 后 Fetch models 拿到列表、勾 fake-coder，测试连接成功就关掉表单、进入主窗口，'
    + 'Open a folder 提示里显示首字耗时（"Connected · First token …"）和"Open folder…"',
  /^Connected · [Ff]irst token \d+ ?ms/.test(ok) && listed?.state === 'list' && typed.join() === 'false' && handedOver,
  `${JSON.stringify(listed)}；手填 ${typed.join()}；主窗口 ${handedOver}；${oneLine(ok)}`);
  const probe = await h.waitProbes(since);
  const providers = JSON.parse(readFileSync(join(userData, 'model-config.json'), 'utf8')).providers;
  record('首次启动：探针跑完（经进程桥读档案）、tool calling 已验证；同一张表单保存了三次，配置里仍只有一个提供商',
    probe === 'verified' && providers.length === 1 && providers[0].models.map((m) => m.id).join() === 'fake-coder',
    `probe=${probe}；providers=${providers.map((p) => `${p.id}:${p.models.map((m) => m.id)}`).join(' ')}`);
}

/**
 * @brief 准备中（v1，chat.md"输入框下面一行"准备中，models.md"不可用时、按钮消失时的焦点"）：发了第一条消息、pi 还没开始时
 *        按钮位置是"Stop"；选择范围和 Effort 不可用（aria-disabled），原因是"Can’t switch models until the response
 *        finishes"（范围按钮悬停第三行）、"Can’t change effort until the response finishes"；权限和圆环可用；占位文字
 *        "Enter to queue · Shift+Enter for new line"。seen 是 watchRows 抓到的状态。
 */
function preparingRow(seen) {
  const row = seenWith(seen, 'preparing');
  const problems = [...layoutProblems(row), ...stateProblems(row, 'preparing', APP_OPTS)];
  record('对话：准备中（发了消息、pi 还没开始）按钮位置是"Stop"，选择范围和 Effort 不可用（aria-disabled）、原因对，'
    + '权限和圆环可用，占位文字"Enter to queue · Shift+Enter for new line"', problems.length === 0,
  `${problems.join('; ')} ${rowSummary(row)}`);
}

/**
 * @brief 发第一条消息：先"Waiting for the model…"，再流式文字；读取卡完成；上下文用量随对话增长。
 *        还没有消息时圆环为空（data-state="empty"、data-tokens="0"），增长从第一次回复之后开始比（composer-pickers.md
 *        "测试要改的地方"）；第一次回复之后圆环有用量、强调色。发出时抓一次准备中的这一行。
 */
async function firstMessage({ page, h }) {
  const empty = await ringState(page);
  record('对话：新会话还没有消息时输入框下面一行的圆环为空（data-state="empty"、data-tokens 为 0，读屏名"Context window"、'
    + '描述"Send a message to see context usage."）', empty?.state === 'empty' && empty.tokens === '0'
    && empty.label === 'Context window' && empty.desc === EMPTY_NOTE, JSON.stringify(empty));
  await h.sampleStages();
  await watchRows(page);
  await h.send('总结 README');
  await h.idle();
  preparingRow(await seenRows(page));
  const used = await hoverRing(page);
  const usedProblems = [...ringTextProblems(used), ...ringColorProblems(used)];
  record('对话：第一次回复之后圆环有用量：读屏名"Usage: Context approximately … of 128,000 tokens (N%)"、悬停'
    + '"Context ≈ …k / 128k (N%)"与 data-tokens 一致，填充是强调色、底圈 --color-line', usedProblems.length === 0
    && / \/ 128k \(\d+%\)$/.test(used?.tip ?? ''), `${usedProblems.join('; ')} ${used?.tip} | ${used?.label}`);
  const stages = await h.stages();
  record('对话：先显示"等待模型响应"，再"生成中"', stages[0] === 'Waiting for the model…'
    && stages.includes('Responding…'), stages.join(' → '));
  const cards = await h.cards();
  record('对话：读取卡完成', cards[0]?.title.includes('README.md') && cards[0].status === 'done', JSON.stringify(cards));
  record('对话：会话名取第一条消息', (await page.getByTestId('session-title').innerText()) === '总结 README');
  const before = await h.usageTokens();
  await h.send('plain 再说一句');
  await h.idle();
  const after = await h.usageTokens();
  record('对话：输入框下面一行的上下文用量（圆环）随对话增长', before !== null && after !== null && after > before,
    `${before} → ${after}`);
}

/**
 * @brief 详情里的分项（models.md"详情里的分项"）：接着 firstMessage（两轮之后；pi 的自动压缩是默认的，留出 16,384），
 *        点开详情：分项按固定顺序、名字照 Claude，至少有 System prompt、System tools、Autocompact buffer（"16.4k"、
 *        "12.8%"）和 Free space，没有 MCP tools（没有 MCP 服务）；Messages 是 tokens 减去前五项（不小于 0；合成端点报的
 *        用量不算工具说明，常是 0、不显示），Free space 是 128,000 − tokens − 16,384；各行与分段条同序同色、段间 2px；
 *        圆环的读屏描述是各行；详情里没有能停焦点的东西，焦点留在圆环；Esc 关上。
 */
async function ringParts({ page }) {
  const opened = await openRingDetails(page);
  const seen = await readParts(page, SINGLE);
  await page.keyboard.press('Escape');
  const problems = partsProblems(seen, { window: RING_WINDOW, reserve: PI_RESERVE,
    has: ['systemPrompt', 'systemTools', 'autocompactBuffer', 'freeSpace'], lacks: ['mcpTools'] });
  const buffer = seen?.rows.find((row) => row.part === 'autocompactBuffer');
  record('分项：详情一打开就有分段条和各行（System prompt、System tools、……、Autocompact buffer "16.4k" "12.8%"、'
    + 'Free space，固定顺序、Claude 的名字）；Messages = tokens − 前五项，Free space = 128,000 − tokens − 16,384；'
    + '条与各行同序同色、段间 2px；圆环的读屏描述是各行；详情里没有能停焦点的东西，焦点留在圆环', problems.length === 0
    && buffer?.count === '16.4k' && buffer.percent === '12.8%' && Boolean(opened?.focused),
  `${problems.join('; ')} | ${partsBrief(seen)} | ${seen?.desc}`);
}

/** @brief 代码块上的"Copy code"：代码进系统剪贴板（Mori 只放行自己页面写剪贴板这一项权限）。 */
async function copyCode({ app, page, h }) {
  await h.send('code block 给我一段代码');
  await h.idle();
  await app.evaluate(({ clipboard }) => clipboard.writeText('剪贴板原来的内容'));
  await page.getByRole('button', { name: 'Copy code' }).last().click();
  let copied = '';
  for (let tries = 0; tries < 10 && !copied.includes('export function add'); tries += 1) {
    await sleep(200);
    copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  }
  record('代码块：点"复制代码"后代码进系统剪贴板', copied.includes('export function add(a: number, b: number): number {')
    && copied.includes('return a + b;') && !copied.includes('下面是一段代码'), oneLine(copied));
}

/** @brief 等提供商卡 mori-endpoint 的第一个模型行是 ref（上移下移立即保存，§9.1）。 */
function firstModelIs(page, ref) {
  return page.waitForFunction((want) => document.querySelector('[data-testid="provider-card"]'
    + '[data-provider="mori-endpoint"] [data-testid="model-row"]')?.dataset.model === want, ref, { timeout: 15000 });
}

/**
 * @brief 设置 → Models：提供商卡的"Test connection"测试中可以取消（models-settings.md "提供商卡"：测试中"Testing…"与
 *        "Cancel"，结果写在卡里）。Test connection 测提供商的第一个模型，所以先在卡上 Fetch models、在清单里勾 fake-slow、
 *        Add 1 model（合成端点对它第一个分块前等 8 秒，model-discovery.md §6.5、§13.4），用它这一行的 Move up 把它移到
 *        第一个，测完再移回去。默认范围仍是 fake-coder（检查），之后的步骤不受影响。
 *        2026-10-26（WP-02，负责人走查 M7）：原来用模型行的"Test"，模型行上的 Test 删掉了。
 */
async function cancelTest({ page, h, userData }) {
  await h.openModels();
  const added = await h.addModels(['fake-slow']);
  if (added.error !== null) throw new Error(`add fake-slow: ${added.error}`);
  const row = page.locator('[data-testid="model-row"][data-model="mori-endpoint/fake-slow"]');
  await row.waitFor({ timeout: 15000 });
  await row.locator('[data-action="up"]').click();
  await firstModelIs(page, 'mori-endpoint/fake-slow');
  const card = h.providerCard();
  await card.locator('[data-action="test-provider"]').click();
  await card.getByRole('button', { name: 'Testing…' }).waitFor({ timeout: 10000 });
  await card.locator('[data-action="test-cancel"]').click();
  const result = card.getByTestId('test-result');
  await result.waitFor({ timeout: 15000 });
  const text = await result.innerText();
  record('设置：提供商卡的"Test connection"（测第一个模型 fake-slow）在测试中变为"Testing…"，可以取消，结果写在卡里',
    text === 'Test cancelled', text);
  await row.locator('[data-action="down"]').click();
  await firstModelIs(page, 'mori-endpoint/fake-coder');
  const config = JSON.parse(readFileSync(join(userData, 'model-config.json'), 'utf8'));
  record('设置：卡上 Fetch models 加入模型不改默认范围：normalDefault 仍是 mori-endpoint/fake-coder',
    config.normalDefault === 'mori-endpoint/fake-coder', String(config.normalDefault));
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/** @brief 在这一栏的范围菜单里选 pick（模型全名或范围名），等按钮显示它、切换结束。 */
async function chooseRange(page, pick) {
  await page.locator(`${SINGLE} [data-testid="model-button"]`).click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-pick="${pick}"]`).click();
  await page.waitForFunction((want) => {
    const button = document.querySelector('.pane-slot:not([hidden]) [data-testid="model-button"]');
    return button?.dataset.pick === want && !button.dataset.pending;
  }, pick, { timeout: 30000 });
}

/**
 * @brief 设置 → Models 里给合成端点加一个模型 id，等它的 tool calling 验证过（行上的 data-probe；探针出错、tool calling
 *        没验证时点一次状态行的"Verify again"，models-settings.md "Models 行"）。
 *        一键拉取模型（model-discovery.md §6.5、§13.4）：卡上 Fetch models → 列表里没有的 id 用 Add a model ID 手填 → Add 1 model。
 */
async function addVerifiedModel(page, h, id) {
  await h.openModels();
  const added = await h.addModels([id]);
  if (added.error) throw new Error(`Add ${id}: ${added.error}`);
  const row = page.locator(`[data-testid="model-row"][data-model="mori-endpoint/${id}"]`);
  const verified = page.locator(`[data-testid="model-row"][data-model="mori-endpoint/${id}"][data-probe="verified"]`);
  await row.waitFor({ timeout: 15000 });
  if (!await verified.waitFor({ timeout: 60000 }).then(() => true, () => false)) {
    await row.locator('[data-testid="probe-status"] [data-action="verify"]').click();
    await verified.waitFor({ timeout: 120000 });
  }
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/**
 * @brief 很短的范围（models.md"菜单的位置与键盘"：模型 id"o3"时范围按钮约 46px、被 margin-left: auto 推到右边，左边到
 *        这一行右端不到 300px；composer-pickers.md"测试要改的地方"新加的检查第 4 条）：设置 → Models 里加一个模型"o3"
 *        （合成端点对任何模型 id 都回答），在这一行的范围菜单里选它：切换中范围按钮和 Effort 都 aria-disabled、
 *        带 data-pending，悬停只有第一行、没有描述，焦点留在范围按钮上（models.md"选择范围按钮"切换中）；空闲时在 930px 和
 *        680px 的单栏各打开一次范围菜单（300px）：往上打开、右边对齐范围按钮、不伸出这一行。最后换回 fake-coder。
 */
async function shortRange({ app, page, h }) {
  await addVerifiedModel(page, h, 'o3');
  await watchRows(page);
  await chooseRange(page, 'mori-endpoint/o3');
  const switching = seenWith(await seenRows(page), 'pending');
  const pending = pendingProblems(switching, 'o3');
  record('范围：在这一行的范围菜单里选"o3"：切换中范围按钮和 Effort 都 aria-disabled、带 data-pending，悬停只有第一行'
    + '（"o3"）、没有描述，焦点留在范围按钮上', pending.length === 0, `${pending.join('; ')} ${rowSummary(switching)}`);
  const menus = [];
  for (const width of [930, 680]) {
    await setPaneWidth(page, app, width);
    menus.push(...(await popoverChecks(page, SINGLE, ['model'])).map((problem) => `${width}px ${problem}`));
  }
  const row = await composerRow(page);
  const idle = stateProblems(row, 'idle', APP_OPTS);
  record('范围：范围按钮"o3"（约 46px）时 930px、680px 空闲打开范围菜单（宽 300px）：往上打开、右边对齐范围按钮、'
    + '不伸出这一行和会话面板；按钮可用、悬停第二行"Mori endpoint · Local"', menus.length === 0 && idle.length === 0
    && row?.items.model?.content === 'o3', `${menus.join('; ')} ${idle.join('; ')} ${rowSummary(row)}`);
  await chooseRange(page, 'mori-endpoint/fake-coder');
  await setPaneWidth(page, app, 930);
}

/**
 * @brief 首次启动表单的"Test connection → Cancel"（first-run.md "测试中"）：模型 fake-slow（合成端点对它第一个分块前等 8 秒），
 *        测试中按钮变为"Testing…"，旁边"Cancel"；取消后表单下方"Test cancelled"。
 */
async function cancelFormTest({ page, h }) {
  const form = page.getByTestId('connection-form');
  await h.fillConnection({ name: 'Mori endpoint', baseUrl, zone: 'local', apiKey: testKey, modelId: 'fake-slow' });
  await form.locator('[data-action="test"]').click();
  const testing = await form.getByRole('button', { name: 'Testing…' }).waitFor({ timeout: 15000 })
    .then(() => true, () => false);
  if (testing) await form.locator('[data-action="test-cancel"]').click();
  const text = await h.formMessage(null, { test: true, timeout: 15000 }).catch(() => '');
  record('首次启动：测试连接时按钮变为"Testing…"，可以取消，表单下方"Test cancelled"',
    testing && text === 'Test cancelled', `Testing… 出现 ${testing}；${text}`);
}

/** @brief 运行耗时命令时排队一条，然后按 Esc：命令卡"Stopped"，提示，排队消息回到输入框。 */
async function escStop({ page, h }) {
  await h.send('run: sleep 30');
  await page.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 30000 });
  await h.send('plain 排队的消息');
  await page.getByTestId('queue').waitFor({ timeout: 10000 });
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await h.idle(30000);
  const last = (await h.cards()).at(-1);
  const notice = await page.getByText('Stopped · Changes made so far stay as they are').count();
  record('停止：命令卡显示"已停止"并提示修改不会自动撤销', last?.status === 'stopped' && notice >= 1, JSON.stringify(last));
  record('停止：排队消息回到输入框', (await h.textarea.inputValue()).includes('plain 排队的消息'));
  record('停止：没有错误卡', await page.getByTestId('error-card').count() === 0);
  await page.screenshot({ path: join(shots, '02-stopped.png') });
  await h.textarea.fill('');
}

/** @brief 生成中插话和排队：都先进排队区；插话在工具执行完后进入对话流，排队在本轮结束后。 */
async function queueSteer({ page, h }) {
  const usersBefore = await page.getByTestId('user-message').count();
  await h.send('run: sleep 4');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 30000 });
  await h.send('plain 插话', 'Control+Enter');
  await h.send('plain 排队');
  await page.waitForFunction(() => document.querySelector('[data-testid="queue"]')?.textContent?.includes('plain 排队'),
    null, { timeout: 10000 }).catch(() => {});
  const queue = await page.getByTestId('queue').innerText();
  record('排队：插话和排队两条都先出现在排队区', queue.includes('插话') && queue.includes('plain 排队'), oneLine(queue));
  await page.getByTestId('user-message').filter({ hasText: 'plain 插话' }).waitFor({ timeout: 30000 });
  const lastCard = (await h.cards()).at(-1);
  const stillQueued = (await page.getByTestId('queue').innerText().catch(() => '')).includes('plain 排队');
  record('排队：插话在本轮工具执行完后才进入对话流', lastCard?.status === 'done' && stillQueued, JSON.stringify(lastCard));
  await h.idle();
  const users = (await page.getByTestId('user-message').allInnerTexts()).slice(usersBefore);
  record('排队：排队的消息在本轮结束后进入对话流', users.join(' | ') === 'run: sleep 4 | plain 插话 | plain 排队', users.join(' | '));
}

/**
 * @brief 错误来源（v1，§14.4）：模型回复出错（http-400，v0 的错误卡）；原地重试（http-503-once：阶段行"Retrying 1/3"，
 *        不换模型，之后正常回复）；key 被拒：删 key、加一个错的 key → 一张说明卡（"No model available"，候选行
 *        "API key rejected"，"Open settings"，没有错误卡）→ Open settings 落在提供商卡、焦点在 Keys → 加回对的 key。
 */
async function errors({ page, h }) {
  await h.send('http-400 坏请求');
  await h.idle();
  const card = page.getByTestId('error-card').last();
  const text = await card.innerText();
  record('错误：模型回复出错显示原文和"Put your last message back in the message box"', text.includes('400')
    && text.includes('Put your last message back in the message box'), oneLine(text));
  await card.getByRole('button', { name: 'Put your last message back in the message box' }).click();
  record('错误：点它把上一条消息放回输入框', (await h.textarea.inputValue()) === 'http-400 坏请求');
  await h.textarea.fill('');
  const cardsBefore = await page.getByTestId('error-card').count();
  await h.sampleStages();
  await h.send('http-503-once 服务忙');
  await h.idle(120000);
  const stages = await h.stages();
  record('错误：原地重试时阶段行显示"Retrying 1/3"，之后正常回复，没有错误卡、没有换模型',
    stages.some((stage) => /^Retrying \(?1\/3\)?/.test(stage))
      && await page.getByTestId('error-card').count() === cardsBefore
      && await page.locator('[data-testid="notice"][data-kind="model-switch"]').count() === 0,
    stages.join(' → '));
  await wrongKey({ page, h });
}

/** @brief 提供商卡上 key 的行数等于 count。 */
function keyRows(page, count) {
  return page.waitForFunction((want) => document.querySelectorAll(
    '[data-testid="provider-card"][data-provider="mori-endpoint"] [data-testid="key-row"]').length === want,
  count, { timeout: 15000 });
}

/** @brief key 被拒（§14.4 m1-app）：删 key、加错的 key → 说明卡 → Open settings（焦点在 Keys）→ 加回对的 key。 */
async function wrongKey({ page, h }) {
  await h.openModels();
  await h.addKey('wrong-key');
  const card = h.providerCard();
  await card.getByTestId('key-row').first().locator('[data-action="key-remove"]').click();
  await keyRows(page, 1);
  await page.getByRole('button', { name: 'Back to app' }).click();
  const errorsBefore = await page.getByTestId('error-card').count();
  await h.send('plain 你好');
  await h.idle();
  const unavailable = page.getByTestId('unavailable-card').last();
  const text = oneLine(await unavailable.innerText().catch(() => ''));
  const reason = await unavailable.locator('[data-testid="candidate"]').first().getAttribute('data-reason')
    .catch(() => null);
  record('错误：key 被拒时一张说明卡（"API key rejected"、"Open settings"），没有错误卡',
    text.includes('API key rejected') && text.includes('Open settings') && reason === 'auth'
      && await page.getByTestId('error-card').count() === errorsBefore, `${text}；data-reason=${reason}`);
  await page.screenshot({ path: join(shots, '02b-wrong-key.png') });
  await unavailable.locator('[data-action="open-settings"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="key-row"]'), null,
    { timeout: 5000 }).catch(() => {});
  const focus = await page.evaluate(() => ({ key: Boolean(document.activeElement?.closest('[data-testid="key-row"]')),
    provider: document.activeElement?.closest('[data-testid="provider-card"]')?.dataset.provider ?? null,
    text: document.activeElement?.textContent ?? null }));
  record('错误：说明卡的"Open settings"打开 设置 → Models，焦点在出错提供商的 Keys（第一行）',
    focus.key && focus.provider === 'mori-endpoint', JSON.stringify(focus));
  await h.addKey(testKey);
  await card.getByTestId('key-row').first().locator('[data-action="key-remove"]').click();
  await keyRows(page, 1);
  await page.getByRole('button', { name: 'Back to app' }).click();
  await h.send('plain 换回对的 key');
  await h.idle();
  const last = await page.getByTestId('assistant').last().innerText();
  record('错误：加回对的 key 后可以继续对话，没有新的说明卡', last.length > 0
    && await page.getByTestId('unavailable-card').count() === 1, oneLine(last));
}

/** @brief 结束后台进程：退出提示和"Restart"，执行中的卡"Interrupted"，草稿还在；重新载入后从会话文件恢复。 */
async function kernelExit({ app, page, h }) {
  const before = new Set(sleepProcessIds(['33']));
  await h.send('run: sleep 33');
  await page.locator('[data-testid="tool-card"][data-status="running"]').last().waitFor({ timeout: 30000 });
  const running = sleepProcessIds(['33']).filter((id) => !before.has(id));
  await h.textarea.fill('还没发出的草稿');
  const pid = killKernel(app);
  await page.getByTestId('kernel-exit').waitFor({ timeout: 10000 });
  const left = await waitGone(running);
  record('退出：后台进程被强行结束时，它正在运行的命令也一起结束', running.length > 0 && left.length === 0,
    `运行中的 sleep.exe ${running.length} 个，3 秒内剩 ${left.length} 个`);
  const last = (await h.cards()).at(-1);
  record('退出：显示"Mori 的后台进程意外退出 · 刚才没完成的回复已中断"和"重新载入"',
    (await page.getByTestId('kernel-exit').innerText()).includes('Unfinished responses were interrupted'),
    `后台进程 PID ${pid}`);
  record('退出：执行中的命令卡变为"已中断"', last?.status === 'interrupted', JSON.stringify(last));
  record('退出：输入框里的草稿还在', (await h.textarea.inputValue()) === '还没发出的草稿');
  await crashedRow(page);
  await page.screenshot({ path: join(shots, '03-kernel-exit.png') });
  const usersBefore = await page.getByTestId('user-message').count();
  await restartFromModel(page);
  const usersAfter = await page.getByTestId('user-message').count();
  record('退出：重新载入后从会话文件恢复对话，草稿不受影响', usersAfter === usersBefore
    && (await h.textarea.inputValue()) === '还没发出的草稿', `${usersBefore} → ${usersAfter}`);
  await h.send('plain 重新载入之后');
  await h.idle();
  record('退出：重新载入后可以继续对话', (await page.getByTestId('assistant').last().innerText()).length > 0);
}

/**
 * @brief 后台进程退出时输入框下面一行（chat.md"后台进程退出"）：权限、选择范围、Effort 不可用（aria-disabled），
 *        原因"Mori’s background process crashed"（权限、Effort 悬停第二行，范围按钮第三行，读屏的描述）；
 *        圆环保留最后的用量，详情仍能打开。
 */
async function crashedRow(page) {
  const problems = stateProblems(await composerRow(page), 'crashed', APP_OPTS);
  const ring = await openRingDetails(page);
  await page.keyboard.press('Escape');
  record('退出：输入框下面一行的权限、选择范围、Effort 不可用（aria-disabled），原因"Mori’s background process crashed"；'
    + '圆环保留最后的用量、详情仍能打开', problems.length === 0 && ring?.state === 'used'
    && Number(ring.tokens) > 0 && ring.details !== null, `${problems.join('; ')} ${JSON.stringify(ring?.details)}`);
}

/**
 * @brief 焦点放在范围按钮上点"Restart"（element.click()，不挪焦点），等重新载入完：重新载入中"Restarting…"和
 *        Restart 之后重新打开中"Starting…"时这一行仍有上一次的选择范围、Effort 和圆环（不可用、原因同按钮位置的说明），
 *        焦点一直留在范围按钮上（models.md"不可用时、按钮消失时的焦点"）。
 */
async function restartFromModel(page) {
  await page.locator(`${SINGLE} [data-testid="model-button"]`).focus();
  await watchRows(page);
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="kernel-exit"] button')]
    .find((button) => button.textContent.includes('Restart'))?.click());
  await page.getByText(RESTARTED_NOTE).waitFor({ timeout: 30000 });
  const seen = await seenRows(page);
  const restarting = seenWith(seen, 'Restarting…');
  const reopening = seenWith(seen, 'Starting…');
  const problems = [...stateProblems(restarting, 'restarting', APP_OPTS).map((p) => `Restarting…: ${p}`),
    ...stateProblems(reopening, 'reopening', APP_OPTS).map((p) => `Starting…: ${p}`)];
  const focus = await focusName(page);
  record('退出：Restart 之后"Restarting…"和重新打开中"Starting…"时这一行仍有上一次的选择范围、Effort 和圆环（不可用，'
    + '原因是按钮位置的说明），焦点一直留在范围按钮上', problems.length === 0 && restarting?.focus === 'model-button'
    && reopening?.focus === 'model-button' && focus === 'model-button',
  `${problems.join('; ')} 焦点 ${restarting?.focus}/${reopening?.focus}/${focus}；${Object.keys(seen)}`);
}

/** @brief 调整两条分隔线后重启 App，宽度还在。 */
async function layoutRestart({ page, h, app, project, userData }) {
  await page.locator('[data-resize="sidebar"]').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  if (await page.locator('[data-resize="workspace"]').count() === 0) {
    await page.getByRole('button', { name: 'Toggle changes' }).click();
  }
  await page.locator('[data-resize="workspace"]').focus();
  await page.keyboard.press('ArrowLeft');
  const saved = { sidebar: await page.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'),
    workspace: await page.locator('[data-resize="workspace"]').getAttribute('aria-valuenow') };
  await app.close();
  const next = await launch({ exePath, userData });
  const nextPage = await next.firstWindow();
  const helpers = pageHelpers(nextPage);
  await nextPage.getByRole('button', { name: 'Open folder…' }).first().waitFor({ timeout: 60000 });
  await helpers.openFolder(next, project);
  await nextPage.getByRole('button', { name: 'Toggle changes' }).click();
  const after = { sidebar: await nextPage.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'),
    workspace: await nextPage.locator('[data-resize="workspace"]').getAttribute('aria-valuenow') };
  record('布局：重启后两条分隔线的宽度还在', saved.sidebar === after.sidebar && saved.workspace === after.workspace,
    `${JSON.stringify(saved)} → ${JSON.stringify(after)}`);
  return { app: next, page: nextPage, h: helpers };
}

/**
 * @brief 用新的数据目录启动 Mori（pi 的设置另加 options.settings），首次启动填好合成端点的连接（区域 Local；
 *        options.contextWindow、options.reasoning 给出时填进表单），等探针跑完（不通过时报错），打开 project。
 *        options.agents 给出时写成用户级的 <agentDir>/AGENTS.md（synthetic）。
 * @param prefix 临时数据目录的前缀
 */
async function freshApp(prefix, project, { settings = {}, contextWindow, reasoning, agents } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fastRetry(dir, settings);
  if (agents) writeFileSync(join(dir, 'pi', 'AGENTS.md'), agents);
  const freshMori = await launch({ exePath, userData: dir });
  const freshPage = await freshMori.firstWindow();
  const helpers = pageHelpers(freshPage);
  await helpers.setupFirstRun({ baseUrl, apiKey: testKey, contextWindow, reasoning });
  await helpers.openFolder(freshMori, project);
  return { app: freshMori, page: freshPage, h: helpers };
}

/** @brief 发一条消息、等本轮结束，返回悬停时量到的圆环。 */
async function sendAndHover(page, h, text) {
  await h.send(text);
  await h.idle();
  return hoverRing(page);
}

/**
 * @brief 圆环的数（models.md"上下文用量（圆环）"）：上下文窗口 999,950 时悬停写成"… / 1M (N%)"（按 k 会进成"1000k"），
 *        读屏名写完整的"999,950"；pi 不压缩。返回第一次回复之后的 token 数（ringTones 按它定窗口）；量不到时为 0。
 */
async function ringMillion({ project }) {
  const fresh = await freshApp('mori-m1-app-million-', project, { settings: NO_COMPACTION, contextWindow: 999950 });
  try {
    const ring = await sendAndHover(fresh.page, fresh.h, RING_FIRST);
    record('圆环：上下文窗口 999,950 时悬停写成"Context ≈ … / 1M (N%)"（不是"1000k"），读屏名写完整的"999,950"',
      / \/ 1M \(\d+%\)$/.test(ring?.tip ?? '') && Boolean(ring?.label?.includes(' of 999,950 tokens '))
      && ringTextProblems(ring).length === 0, `${ring?.tip} | ${ring?.label}`);
    return Number(ring?.tokens) || 0;
  } finally {
    await fresh.app.close().catch(() => {});
  }
}

/**
 * @brief 圆环的颜色分档（models.md"上下文用量（圆环）"快满；defaults.md"上下文用量圆环的样子"）：pi 不压缩；首次启动时把
 *        上下文窗口定成 tokens / 0.8（tokens 是 ringMillion 量到的第一次回复之后的用量：同一个项目、同一句话，用量相同），
 *        第一次回复之后应落在 75–89%（较深的警示色 --color-warn-text），再发一条补足字数的消息让它 ≥ 90%（危险色）；
 *        有填充时底圈 --color-line；读屏名、悬停与 data-tokens 一致。
 */
async function ringTones({ project }, tokens) {
  const window = Math.ceil(tokens / 0.8);
  const fresh = await freshApp('mori-m1-app-tones-', project, { settings: NO_COMPACTION, contextWindow: window });
  try {
    const { page, h } = fresh;
    const warn = await sendAndHover(page, h, RING_FIRST);
    // 合成端点的用量按请求里消息的字数 / 4 估算：补的字让下一次的用量约到窗口的 95%
    const pad = 'x'.repeat(Math.max(0, Math.ceil((window * 0.95 - Number(warn?.tokens ?? 0)) * 4)));
    const danger = await sendAndHover(page, h, `plain 圆环的第二条 ${pad}`);
    const percents = [warn, danger].map((ring) => Number(ring?.percent));
    const problems = [warn, danger].flatMap((ring) => [...ringColorProblems(ring), ...ringTextProblems(ring)]);
    record('圆环：75–89% 用较深的警示色（--color-warn-text）、≥ 90% 用危险色；有填充时底圈 --color-line；读屏名、悬停与 '
      + 'data-tokens 一致', percents[0] >= 75 && percents[0] < 90 && percents[1] >= 90 && problems.length === 0,
    `窗口 ${window}；${percents.join(' → ')}% ${problems.join('; ')}`);
  } finally {
    await fresh.app.close().catch(() => {});
  }
}

/**
 * @brief 刚压缩完（models.md"上下文用量（圆环）"刚压缩完）：pi 的压缩参数调到每轮之后都压缩（128,000 的窗口里 reserveTokens
 *        127500，超过 500 就压缩；keepRecentTokens 1），发消息直到对话流里出现"Compacted session"：这时圆环为空、底圈是虚线、
 *        没有 data-tokens 和 data-percent，悬停和读屏名"Context window"，描述和详情里是"Just compacted. …"。
 *        （回放的 m1/compaction.json 里录不到这个状态，见 m1-replay.mjs compactionCheck。）
 */
async function ringCompacted({ project }) {
  const settings = { compaction: { enabled: true, reserveTokens: 127500, keepRecentTokens: 1 } };
  // 128,000 的窗口在清单行里填（拉取后清单行是合成端点报告的 131072，model-discovery.md §6.2）
  const fresh = await freshApp('mori-m1-app-compact-', project, { settings, contextWindow: 128000 });
  try {
    const { page, h } = fresh;
    const compactions = () => page.getByText('Compacted session', { exact: true }).count();
    for (let turn = 1; turn <= 3 && await compactions() === 0; turn += 1) {
      await h.send(`plain 压缩前的第 ${turn} 条`);
      await h.idle();
    }
    const ring = await hoverRing(page);
    const opened = await openRingDetails(page);
    await page.keyboard.press('Escape');
    const compacted = await compactions();
    record('圆环：刚压缩完（还没有新的回复）时为空、底圈虚线，没有 data-tokens / data-percent，悬停和读屏名"Context window"，'
      + '描述和详情里"Just compacted. Context usage shows after the next response."', compacted > 0
      && ring?.state === 'compacted' && ring.tokens === null && ring.percent === null
      && ring.label === 'Context window' && ring.tip === 'Context window' && ring.desc === COMPACTED_NOTE
      && Boolean(opened?.details?.includes(COMPACTED_NOTE)) && ringColorProblems(ring).length === 0,
    `压缩 ${compacted} 次；${JSON.stringify(ring)}`);
  } finally {
    await fresh.app.close().catch(() => {});
  }
}

/**
 * @brief 分项里的"Memory files"和关掉自动压缩（models.md"详情里的分项"）：用户级 AGENTS.md（synthetic）、pi 不压缩、
 *        窗口 128,000；第一次回复之后点开详情：有"Memory files"一行（不少于 AGENTS.md 正文按 Mori 的估算；正文是
 *        ASCII，即字数 ÷ 4 向上取整），没有"Autocompact buffer"，Free space 是 128,000 − tokens；其余同 ringParts。
 */
async function ringPartsMemory({ project }) {
  const fresh = await freshApp('mori-m1-app-parts-', project, { settings: NO_COMPACTION, contextWindow: RING_WINDOW,
    agents: AGENTS_TEXT });
  try {
    const { page, h } = fresh;
    await h.send(RING_FIRST);
    await h.idle();
    const opened = await openRingDetails(page);
    const seen = await readParts(page, SINGLE);
    await page.keyboard.press('Escape');
    const problems = partsProblems(seen, { window: RING_WINDOW, reserve: null,
      has: ['systemPrompt', 'systemTools', 'memoryFiles', 'freeSpace'], lacks: ['autocompactBuffer', 'mcpTools'] });
    const memory = seen?.rows.find((row) => row.part === 'memoryFiles');
    record('分项：有用户级 AGENTS.md 时有"Memory files"一行（不少于正文的估算）；pi 关掉自动压缩时没有'
      + '"Autocompact buffer"，Free space = 128,000 − tokens；其余同上（顺序、写法、加起来、颜色、读屏描述、没有焦点停留）',
    problems.length === 0 && memory?.tokens >= Math.ceil(AGENTS_TEXT.length / 4) && Boolean(opened?.focused),
    `${problems.join('; ')} | ${partsBrief(seen)} | ${seen?.desc}`);
  } finally {
    await fresh.app.close().catch(() => {});
  }
}

/** @brief 圆环要另起 Mori 的几项：999,950 写成 1M（顺便量出第一次回复后的用量）、颜色分档、刚压缩完、分项。 */
async function ringRuns(ctx) {
  const tokens = await ringMillion(ctx).catch((error) => {
    record('圆环 1M：流程', false, oneLine(error, 400));
    return 0;
  });
  if (tokens > 0) await ringTones(ctx, tokens).catch((error) => record('圆环颜色：流程', false, oneLine(error, 400)));
  else record('圆环颜色：没有量到第一次回复之后的用量，定不了上下文窗口', false);
  await ringCompacted(ctx).catch((error) => record('圆环刚压缩完：流程', false, oneLine(error, 400)));
  await ringPartsMemory(ctx).catch((error) => record('分项 Memory files：流程', false, oneLine(error, 400)));
}

/** @brief Mori 主进程被强行结束（模拟崩溃）时，后台进程和正在运行的命令也都结束，不留下任何 Mori 的进程。 */
async function mainKilled({ project }) {
  const { app: crashApp, page: crashPage, h: helpers } = await freshApp('mori-m1-app-crash-', project);
  await helpers.allowAll();
  const before = new Set(sleepProcessIds(['63']));
  await helpers.send('run: sleep 63');
  await crashPage.locator('[data-testid="tool-card"][data-status="running"]').waitFor({ timeout: 30000 });
  const running = sleepProcessIds(['63']).filter((id) => !before.has(id));
  const pid = mainPid(crashApp.process().pid);
  const tree = processTree(pid).filter((item) => item.pid !== pid);
  execFileSync('taskkill', ['/PID', String(pid), '/F']);
  const left = await waitGone(running, 8000);
  await sleep(2000);
  const alive = stillAlive(tree.map((item) => item.pid));
  const names = tree.filter((item) => alive.includes(item.pid)).map((item) => `${item.name}(${item.pid})`);
  record('崩溃：主进程被强行结束时，命令和后台进程都结束，不留下任何 Mori 的进程', running.length > 0 && left.length === 0
    && tree.length > 2 && alive.length === 0,
  `主进程 PID ${pid}，子孙进程 ${tree.length} 个；sleep.exe ${running.length} 个，剩 ${left.length} 个；残留：${names.join(', ') || '无'}`);
  await crashApp.close().catch(() => {});
}

const fake = await startFakeEndpoint();
const { project } = prepareProject('mori-m1-app-');
const userData = mkdtempSync(join(tmpdir(), 'mori-m1-app-data-'));
fastRetry(userData);
let app = await launch({ exePath, userData });
let page = await app.firstWindow();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const ctx = { app, page, h: pageHelpers(page), project, userData };
const steps = { firstRun, firstMessage, ringParts, copyCode, cancelTest, shortRange, escStop, queueSteer, errors,
  kernelExit };
try {
  for (const [name, step] of Object.entries(steps)) {
    if (!wanted(name)) continue;
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      await page.screenshot({ path: join(shots, `${name}-error.png`) }).catch(() => {});
    }
  }
  if (wanted('layoutRestart')) {
    Object.assign(ctx, await layoutRestart(ctx));
    app = ctx.app;
    page = ctx.page;
  }
  await app.close().catch(() => {});
  if (wanted('ringRuns')) await ringRuns(ctx);
  if (wanted('mainKilled')) await mainKilled(ctx).catch((error) => record('崩溃：流程', false, oneLine(error, 400)));
} catch (error) {
  record('布局重启：流程', false, oneLine(error, 400));
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await app.close().catch(() => {});
  fake.kill();
}
await sleep(200);
process.exitCode = write(`m1-app${suffix}.json`) ? 0 : 1;
