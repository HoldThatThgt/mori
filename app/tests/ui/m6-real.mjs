// M6 真实端点走查（方案第 7 节 M6 走查 1–8 与反例），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 状态表见 docs/v0/screens/settings.md、models.md、tools.md、slash.md；pi 的行为见 docs/v0/m6-checks.md。
// 脚本不接触 key：只把走查数据目录里 Mori 加密保存的密文（credentials.json 与 Local State）复制到临时目录
// （lib.mjs scratchUserData），之后也不打开它们（"添加模型不改 key"只比较 credentials.json 的修改时间和大小）。
// 像负责人一样操作界面：设置页里添加模型、编辑模型，Customize 里写 AGENTS.md（2026-10-26 从设置页挪来，是 Customize 的
// 最后一节 Instructions）；输入框下面一行换范围和思考强度（2026-10-21 起这几个按钮
// 从顶栏移到这一行，docs/v0/composer-pickers.md；走查 8 最后在分屏的一栏里再换一次）；工具页里启停技能、用表单添加
// MCP 服务、添加本地包并按资源启停；输入框打 "/"；批准卡点"Allow once"。系统的选文件夹对话框经 app.evaluate 换成直接
// 返回测试文件夹。项目技能和项目的 CLAUDE.md、用户级技能和提示词模板、MCP 服务（tests/mcp-server）、pi 包
// （tests/pi-package 的副本）都是测试用的（synthetic）。
// 模型行为（是否照 AGENTS.md 开头、是否列出技能、是否思考、是否调用工具）DeepSeek 不保证，这类检查失败时记为 KNOWN，
// 旁边另有 Mori 一侧的检查（写进的文件、会话文件里的记录、界面状态）。每一轮都检查确实发出并有了回复（没有错误卡），
// 发不出去时这一项的流程记为 FAIL，不会被当成模型行为。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,3,4,5,6,7,8,c,t]
// t（2026-10-26，负责人走查 M12）：Customize 的内置工具里打开 ls，新会话里真实模型用 ls 列出文件（只跑它：--only t）。
// 结果写到 test-results/m6-real(-packaged).json，截图在 test-results/m6-real(-packaged)/。
// v1（docs/specs/model-providers.md §14.1、§14.4）：提供商从 model-config.json 取；测试准备在复制出的配置里把
// 默认范围设为 [DeepSeek, GLM] 的分组。走查 1 改为在 设置 → Models 里给首选提供商加模型（等它的探针跑完）、
// 在输入框下面一行的范围菜单里选它；走查 8 改用 v1 的模型表单（Supports thinking、Default effort for new sessions）。
// 一键拉取模型（docs/specs/model-discovery.md §13.4）：走查 1 加模型改为卡上 Fetch models → 清单里勾（或手填）→ Add 1 model。
// 按钮状态的读法（composer-pickers.md"测试要改的地方"C1、C2）："不可用"读 aria-disabled（没有 data-pending），"切换中"读
// data-pending；悬停按换行分开（范围按钮三行、Effort 两行），读屏的描述读 aria-describedby 指向的元素。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  appRoot, arg, createRecorder, launch, oneLine, REAL_GROUP, realProviders, scratchUserData, sleep, useRealGroup,
} from './lib.mjs';
import { activeFile, PANE, samePath, stubFolder, topTitle, waitPanes, waitReady } from './m3-helpers.mjs';
import { composerAt, slotSelector, waitPaneIdle, waitSplit } from './m5-helpers.mjs';
import {
  chooseThinking, modelRow, NOTE, openAndPlace, openToolsSection, POPUPS, providerCard, slashItems, splitOpen,
} from './m6-helpers.mjs';
import { cardScope, fetchIn, pickIn } from './page.mjs';

const source = arg('source');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/m6-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const wanted = (item) => !only || only.includes(String(item));

/** 合成 MCP 服务（synthetic，本地 stdio） */
const MCP_SERVER = join(appRoot, 'tests', 'mcp-server', 'server.mjs');
/** pi config 自己写出的启停条目（tests/ui/m6-pi-config.mjs 录制） */
const PI_CONFIG = JSON.parse(readFileSync(join(appRoot, 'tests/fixtures/m6/pi-config-toggles.json'), 'utf8'));
/** 走查 1 添加的模型和它的上下文长度 */
const SECOND_MODEL = 'deepseek-v4-pro';
const CONTEXT = 1000000;
/** 新加的模型等探针跑完最多这么久（真实端点，第 0–7 步） */
const PROBE_WAIT_MS = 600000;
/** 生成中范围按钮的悬停说明（规格 §9.2） */
const MODEL_BUSY = 'Can’t switch models until the response finishes';
/** 模型没标支持思考时思考菜单里的说明开头（规格 §9.2） */
const UNSUPPORTED_NOTE = 'This model isn’t marked “Supports thinking”';
/** 项目技能（synthetic）：信任的项目和不信任的项目各一个 */
const PROJECT_SKILL = 'm6-proj-skill';
const UNTRUSTED_SKILL = 'm6-untrusted-skill';
/** 走查 7 放进 agentDir 的技能和提示词模板（synthetic） */
const USER_SKILL = 'm6-hello';
const USER_PROMPT = 'm6-summary';
/** 测试项目里的 CLAUDE.md（synthetic，没有任何要求）：设置页"Files loaded by <项目名>"列出它 */
const PROJECT_NOTES = '# Notes\n\nThis folder is a Mori test fixture (synthetic). It has no special instructions.\n';
/** pi 每个目录只读第一个存在的（m6-checks.md）；Windows 不分大小写，AGENTS.MD、CLAUDE.MD 与这里的相同 */
const AGENTS_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'];
/** "/"列表：会话没有任何模板和技能时 */
const SLASH_EMPTY = 'This session has no prompt templates or skills. Add them in Customize.';
/** 工具页顶部"改动何时生效"的一行 */
const TOOLS_NOTICE = 'Changes apply to new sessions. Sessions already open aren’t affected.';

const PROMPTS = {
  intro: '用一句话介绍你自己。不要调用任何工具。',
  today: '用一句话说说今天适合做什么。不要调用任何工具。',
  agents: '每次回答都以“收到”两个字开头。\n',
  skills: '你现在能用哪些技能？只列出技能名，不要调用任何工具。',
  mcpCall: '请调用 mcp__mori_test__echo 工具，参数 text 为 hello-mori，然后用一句话告诉我它返回了什么。',
  packageCall: '请调用 package_hello 工具（不需要参数），然后用一句话告诉我它返回了什么。',
  reason1: '笼子里有鸡和兔共 35 只，脚共 94 只。鸡兔各几只？只给出答案，不要调用任何工具。',
  reason2: '一个数加上它的一半等于 45，这个数是多少？只给出答案，不要调用任何工具。',
  ls: '请调用 ls 工具（不要用 bash 或 read）列出当前文件夹里的文件，然后用一句话告诉我有哪些文件。',
};

// ---------- 测试文件（synthetic） ----------

/** @brief 写一个测试用的技能文件夹（synthetic）。 */
function writeSkill(dir, name, description, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

/** @brief 测试项目：README.md、src/a.ts、CLAUDE.md，和 .pi/skills 里的一个项目技能（synthetic）。 */
function makeProject(root, name, skill) {
  const project = join(root, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used to check Mori against a '
    + 'model.\n\n- It has one README file.\n- It has one source file in src/.\n');
  writeFileSync(join(project, 'src', 'a.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  writeFileSync(join(project, 'CLAUDE.md'), PROJECT_NOTES);
  writeSkill(join(project, '.pi', 'skills', skill), skill,
    `Synthetic project skill for the Mori M6 walkthrough (${name}).`,
    `# ${skill}\n\nReply with ${skill.toUpperCase()}-OK.`);
  return project;
}

/** @brief 走查 7：agentDir 里的用户级技能和提示词模板（synthetic）。 */
function writeUserCommands(agentDir) {
  writeSkill(join(agentDir, 'skills', USER_SKILL), USER_SKILL,
    'Synthetic skill for the Mori M6 walkthrough; when used, reply with exactly M6-SKILL-OK.',
    `# ${USER_SKILL}\n\nReply with exactly one line: M6-SKILL-OK`);
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  writeFileSync(join(agentDir, 'prompts', `${USER_PROMPT}.md`),
    '---\ndescription: 用一句话总结一个文件\nargument-hint: "<file>"\n---\n请读取 $1，然后用一句话总结它的内容。\n');
}

/** @brief 按 pi 的规则（m6-checks.md），cwd 从文件系统根起逐级加载的 AGENTS.md / CLAUDE.md（不含 agentDir 的）。 */
function projectAgentsFiles(cwd) {
  const dirs = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  return dirs.flatMap((dir) => {
    const name = AGENTS_NAMES.find((item) => existsSync(join(dir, item)));
    return name ? [join(dir, name)] : [];
  });
}

/** @brief 两组路径逐个相同。 */
const samePaths = (a, b) => a.length === b.length && a.every((path, index) => samePath(path, b[index]));
/** @brief 读 JSON 文件；不存在时为 null。 */
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
/** @brief 会话文件的全部记录。 */
const sessionEntries = (file) => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line));
/** @brief 一条记录里的文字（消息内容序列化后，用来找某条你的消息）。 */
const contentOf = (entry) => JSON.stringify(entry.message?.content ?? '');
/** @brief 一条消息的正文（文字块拼起来）。 */
const textOf = (entry) => {
  const content = entry?.message?.content ?? '';
  return typeof content === 'string' ? content
    : content.filter((part) => part.type === 'text').map((part) => part.text).join('');
};
/** @brief credentials.json 的修改时间和大小（不打开文件）。 */
const keyStamp = (userData) => {
  const info = statSync(join(userData, 'credentials.json'));
  return `${info.mtimeMs}/${info.size}`;
};

// ---------- 页面操作 ----------

/** @brief 当前显示的会话面板和它的输入框。 */
const pane = (page) => page.locator(PANE);
const composer = (page) => page.locator(`${PANE} .composer textarea`);

/** @brief 启动 Mori（连接已在走查数据目录的副本里），等侧栏读完。 */
async function start(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 60000 });
}

/** @brief 点"Open folder…"打开 folder，在信任询问里点 answer（Trust workspace / Don’t trust），等会话就绪。 */
async function openFolder(ctx, folder, answer) {
  const { page } = ctx;
  await stubFolder(ctx.app, folder);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…' }).click();
  const dialog = page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole('button', { name: answer, exact: true }).click();
  await waitReady(page);
}

/** @brief 按 Ctrl+N 新建会话（在当前会话的项目里），等它就绪。 */
async function newSession(page) {
  const before = await page.locator('.pane-slot').count();
  await page.keyboard.press('Control+n');
  await waitPanes(page, before + 1);
  await waitReady(page);
}

/** @brief 点 locator（会新建会话的按钮），等新会话就绪。 */
async function clickNewSession(page, button) {
  const before = await page.locator('.pane-slot').count();
  await button.click();
  await waitPanes(page, before + 1);
  await waitReady(page);
}

/** @brief 工具页顶部"改动何时生效"一行里的"New session"。 */
const toolsNewSession = (page) => page.locator('.tools-notice').getByRole('button', { name: 'New session' });

/** @brief 从左栏打开设置页，切到 section（models）。 */
async function openSettings(page, section = 'models') {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator(`[data-testid="settings-nav"] button[data-section="${section}"]`).click();
}

/** @brief 设置页或工具页上点"Back to app"，等会话面板出现。 */
async function backToChat(page) {
  await page.getByRole('button', { name: 'Back to app' }).click();
  await page.locator(PANE).waitFor({ timeout: 10000 });
}

/** @brief 出错后回到会话页：关掉浮层；离开确认框选"Discard"；在设置页或工具页上时点"Back to app"。 */
async function recover(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const leave = page.getByTestId('leave-dialog');
  if (await leave.isVisible().catch(() => false)) {
    await leave.getByRole('button', { name: 'Discard', exact: true }).click();
  }
  const back = page.getByRole('button', { name: 'Back to app' });
  if (await back.isVisible().catch(() => false)) await back.click().catch(() => {});
}

/** @brief 等下一张没见过的批准卡（返回它的请求、工具、标题），或本轮结束（{ idle: true }）。 */
async function nextStop(page, seen, timeout) {
  const handle = await page.waitForFunction(({ sel, known }) => {
    const root = document.querySelector(sel);
    const card = root?.querySelector('[data-testid="approval-card"]');
    if (card && !known.includes(card.dataset.request)) {
      return { request: card.dataset.request, tool: card.dataset.tool,
        title: card.querySelector('[data-testid="approval-title"]')?.textContent ?? '' };
    }
    const idle = root?.dataset.running === 'false' && root?.dataset.sending === 'false'
      && !root.querySelector('[data-testid="stage"]');
    return idle ? { idle: true } : false;
  }, { sel: PANE, known: seen }, { timeout, polling: 200 });
  return handle.jsonValue();
}

/** @brief 当前会话里助手回复和错误卡的个数。 */
const turnCounts = (page) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  return { replies: root?.querySelectorAll('[data-testid="assistant"]').length ?? 0,
    errors: root?.querySelectorAll('[data-testid="error-card"]').length ?? 0 };
}, PANE);

/**
 * @brief 等本轮开始（运行中，或已经有了新的回复或错误卡），返回那一刻输入框下面一行的范围和思考按钮：不可用
 *        （aria-disabled 且没有 data-pending）、切换中（data-pending）、悬停说明（按行）、读屏的描述（aria-describedby）；
 *        20 秒内没有开始时为 null。
 */
async function turnStart(page, before) {
  const handle = await page.waitForFunction(({ sel, replies, errors }) => {
    const root = document.querySelector(sel);
    if (!root) return false;
    const running = root.dataset.running === 'true';
    const replied = root.querySelectorAll('[data-testid="assistant"]').length > replies;
    const failed = root.querySelectorAll('[data-testid="error-card"]').length > errors;
    if (!running && !replied && !failed) return false;
    const button = (id) => {
      const element = root.querySelector(`[data-testid="composer"] .composer-bottom [data-testid="${id}"]`);
      if (!element) return null;
      const refs = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      return { unavailable: element.getAttribute('aria-disabled') === 'true' && element.dataset.pending !== 'true',
        pending: element.dataset.pending === 'true', tip: element.title ? element.title.split('\n') : [],
        described: refs.map((ref) => document.getElementById(ref)?.textContent ?? '').join(' ') };
    };
    return { running, model: button('model-button'), thinking: button('thinking-button') };
  }, { sel: PANE, ...before }, { timeout: 20000 }).catch(() => null);
  return handle ? handle.jsonValue() : null;
}

/**
 * @brief 按 Enter 发出输入框里的文字，等本轮结束；途中出批准卡时记下它，点"Allow once"。本轮没有开始、没有新的回复、
 *        或出了错误卡时抛错（这一项的流程记为 FAIL，不当成模型行为）。
 * @return { cards: 出现过的批准卡 [{ request, tool, title }], start: 本轮开始那一刻输入框下面一行按钮的样子 }
 */
async function submitTurn(page, timeout = 300000) {
  const before = await turnCounts(page);
  await composer(page).press('Enter');
  const begun = await turnStart(page, before);
  const cards = [];
  for (;;) {
    const stop = await nextStop(page, cards.map((card) => card.request), timeout);
    if (stop.idle) break;
    cards.push(stop);
    await pane(page).getByTestId('approval-allow').click();
  }
  const after = await turnCounts(page);
  if (!begun || after.replies <= before.replies || after.errors > before.errors) {
    const error = await pane(page).getByTestId('error-card').last().innerText().catch(() => '');
    throw new Error(`turn did not complete: ${JSON.stringify({ begun, before, after, error: oneLine(error, 200) })}`);
  }
  return { cards, start: begun };
}

/** @brief 在当前会话里写一条消息并发出，等本轮结束（批准卡都点"Allow once"）。 */
async function sendTurn(page, text) {
  await composer(page).click();
  await composer(page).fill(text);
  return submitTurn(page);
}

/** @brief 当前会话最后一条助手回复：正文（去掉思考块和工具卡）和思考块的个数。 */
function lastAssistant(page) {
  return page.evaluate((sel) => {
    const last = [...(document.querySelector(sel)?.querySelectorAll('[data-testid="assistant"]') ?? [])].at(-1);
    if (!last) return { text: '', thinking: 0 };
    const copy = last.cloneNode(true);
    copy.querySelectorAll('[data-testid="thinking"], [data-testid="tool-card"]').forEach((element) => element.remove());
    return { text: copy.textContent.trim(), thinking: last.querySelectorAll('[data-testid="thinking"]').length };
  }, PANE);
}

/** @brief 当前会话最后一张工具卡：标题、状态、展开后的内容。 */
async function lastToolCard(page) {
  const card = pane(page).getByTestId('tool-card').last();
  if (await card.count() === 0) return null;
  const title = await card.locator('.tool-title').innerText();
  const status = await card.getAttribute('data-status');
  if (!(await card.evaluate((element) => element.open))) await card.locator('summary').click();
  return { title, status, body: await card.locator('.tool-body').innerText({ timeout: 5000 }).catch(() => '') };
}

/**
 * @brief 点一行里的开关，等它变成 want 且命令和重新读取都结束（settled）；返回开关和行最后的样子。
 *        15 秒内没有变过去时 settled 为 false（例如保存失败、开关回到原来的样子），由调用方的检查报告。
 */
async function flip(page, row, want) {
  const toggle = row.getByRole('switch');
  await toggle.click();
  const handle = await toggle.elementHandle();
  const settled = await page.waitForFunction(({ element, on }) => element.getAttribute('aria-checked') === String(on)
    && !element.disabled, { element: handle, on: want }, { timeout: 15000 }).then(() => true, () => false);
  const state = await row.evaluate((element) => ({
    checked: element.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
    off: element.classList.contains('off'),
    error: element.querySelector('.form-message.error')?.textContent ?? null }));
  return { settled, ...state };
}

/** @brief 工具页"Built-in tools"里某个工具行：来源、启用状态；不在时为 null。 */
async function toolInfo(page, name) {
  await openToolsSection(page, 'builtin');
  return page.evaluate((tool) => {
    const row = document.querySelector(`[data-testid="tool-row"][data-tool="${tool}"]`);
    return row ? { tag: row.querySelector('.tools-tag')?.textContent ?? '', active: row.dataset.active,
      state: row.querySelector('.tools-state')?.textContent ?? '' } : null;
  }, name);
}

// ---------- 走查 1：第二个模型与输入框下面一行的范围菜单 ----------

/** @brief model-config.json（测试数据目录的副本）。 */
const modelConfig = (ctx) => readJson(join(ctx.userData, 'model-config.json'));

/** @brief 一个模型行上 tool calling 的验证状态（data-probe，2026-10-26 起取代档案摘要的 Tool calling）；没有时为 null。 */
const toolCalling = (page, ref) => modelRow(page, ref).getAttribute('data-probe', { timeout: 2000 }).catch(() => null);

/**
 * @brief 设置 → Models 的提供商卡上点"Fetch models"（用已保存的 key 拉取，model-discovery.md §6.5、§13.4）：卡里打开
 *        清单，没有 key 框，清单开着时卡上的 Fetch models 不可用；只勾 deepseek-v4-pro（服务没列出时用 Add a model ID
 *        手填），Context window 填 1,000,000、不勾 Supports thinking，Add 1 model；等它的探针跑完（Tool calling 不再是
 *        验证中）。返回看到的。
 */
async function addModel(ctx) {
  const { page } = ctx;
  await openSettings(page);
  const scope = cardScope(ctx.conn.provider);
  const card = providerCard(page, ctx.conn.provider);
  const fetch = await fetchIn(page, scope);
  const seen = { fetch, keyFields: await card.locator('.card-checklist input[type="password"]').count(),
    fetchDisabled: await card.locator('[data-action="fetch-models"]').isDisabled() };
  await pickIn(page, scope, [{ id: SECOND_MODEL, contextWindow: CONTEXT, reasoning: false }]);
  await shot(page, '1-add-model');
  await card.locator('[data-action="add-models"]').click();
  await card.locator('.card-checklist').waitFor({ state: 'detached', timeout: 15000 });
  const ref = `${ctx.conn.provider}/${SECOND_MODEL}`;
  seen.row = oneLine(await modelRow(page, ref).innerText({ timeout: 5000 }).catch(() => ''));
  const deadline = Date.now() + PROBE_WAIT_MS;
  const settled = ['verified', 'failed', 'unverified'];
  while (Date.now() < deadline && !settled.includes(await toolCalling(page, ref))) await sleep(3000);
  seen.toolCalling = await toolCalling(page, ref);
  await shot(page, '1-model-list');
  return seen;
}

/** @brief 在输入框下面一行打开范围菜单（v1），读出菜单的样子，选 pick，等按钮不再是切换中。 */
async function switchModel(page, pick, name = '1-model-menu') {
  await pane(page).getByTestId('model-button').click();
  const menu = page.getByTestId('model-menu');
  await menu.waitFor({ timeout: 5000 });
  const state = await menu.evaluate((element) => ({
    items: [...element.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ pick: item.dataset.pick,
      checked: item.getAttribute('aria-checked') === 'true', excluded: item.dataset.excluded === 'true' })),
    sections: [...element.querySelectorAll('[data-section]')].map((section) => section.dataset.section),
    note: element.querySelector('[data-testid="model-menu-note"]')?.textContent ?? '',
    last: element.lastElementChild?.getAttribute('role') === 'menuitem'
      ? element.lastElementChild.textContent : null }));
  await shot(page, name);
  await menu.locator(`[role="menuitemradio"][data-pick="${pick}"]`).click();
  await page.waitForFunction(({ sel, want }) => {
    const button = document.querySelector(`${sel} [data-testid="model-button"]`);
    return button?.dataset.pick === want && !button.hasAttribute('aria-disabled');
  }, { sel: PANE, want: pick }, { timeout: 15000 });
  return state;
}

/** @brief 走查 1 的设置页部分：添加模型的表单与保存结果、探针、不改 key。 */
function recordAddModel(ctx, form, keyBefore) {
  const models = modelConfig(ctx)?.providers?.find((item) => item.id === ctx.conn.provider)?.models ?? [];
  const added = models.find((model) => model.id === SECOND_MODEL);
  record('走查 1：提供商卡上点"Fetch models"：用已保存的 key 拿到模型列表，卡里打开清单，没有 key 框，清单开着时卡上的'
    + ' Fetch models 不可用', form.fetch?.state === 'list' && form.keyFields === 0 && form.fetchDisabled === true,
  JSON.stringify(form));
  record('走查 1：保存后模型行出现（Context 1,000,000），自动跑探针，Tool calling 为 Verified；model-config.json 这个提供商下'
    + '多了这个模型（不支持思考）', form.row.includes(SECOND_MODEL) && form.row.includes('1,000,000')
    && form.toolCalling === 'verified' && added?.contextWindow === CONTEXT && added?.reasoning === false,
  JSON.stringify({ row: form.row, toolCalling: form.toolCalling, added }));
  record('反例：添加模型不填 key、不改 credentials.json（修改时间和大小不变）', keyStamp(ctx.userData) === keyBefore,
    `${keyBefore} → ${keyStamp(ctx.userData)}`);
}

/**
 * @brief 走查 1（v1）：在 设置 → Models 给首选提供商加 deepseek-v4-pro（不填 key），在输入框下面一行的范围菜单里选它，
 *        新回复来自它；设置里的默认范围不变。
 */
async function item1(ctx) {
  const { page } = ctx;
  await sendTurn(page, PROMPTS.intro);
  ctx.s1 = await activeFile(page);
  const keyBefore = keyStamp(ctx.userData);
  const form = await addModel(ctx);
  recordAddModel(ctx, form, keyBefore);
  await backToChat(page);
  const ref = `${ctx.conn.provider}/${SECOND_MODEL}`;
  const menu = await switchModel(page, ref);
  const button = pane(page).getByTestId('model-button');
  const shown = { text: (await button.textContent()).trim(),
    tip: ((await button.getAttribute('title')) ?? '').split('\n'),
    inRow: await button.evaluate((el) => Boolean(el.closest('[data-testid="composer"] .composer-bottom'))) };
  await sendTurn(page, PROMPTS.today);
  await shot(page, '1-switched');
  const entries = sessionEntries(ctx.s1);
  const models = entries.filter((e) => e.type === 'message' && e.message.role === 'assistant')
    .map((e) => e.message.model);
  const picks = entries.filter((e) => e.type === 'custom' && e.customType === 'mori.pick').map((e) => e.data?.pick);
  const config = modelConfig(ctx);
  const current = menu.items.find((item) => item.pick === REAL_GROUP);
  record('走查 1：输入框下面一行的范围菜单分 Groups、Providers、Models 三节，当前范围（测试分组）打勾，列出新加的模型，底部说明只作用于'
    + '这个会话，最后一项"Manage models"', menu.sections.join() === 'groups,providers,models' && current?.checked
    && menu.items.filter((item) => item.checked).length === 1 && menu.items.some((item) => item.pick === ref)
    && menu.note === 'Applies to this session only. New sessions use the default range from Settings.'
    && menu.last === 'Manage models', JSON.stringify(menu));
  record('走查 1：选 deepseek-v4-pro：输入框下面一行的范围按钮显示它，悬停第一行是按钮文字、第二行"<提供商名>"；'
    + '新回复来自 deepseek-v4-pro（会话文件里回复的 model 先是首选的第一个模型、后是 deepseek-v4-pro，记了一条 mori.pick）',
  shown.inRow && shown.text === SECOND_MODEL && shown.tip[0] === SECOND_MODEL
    && (shown.tip[1] ?? '').startsWith(`${ctx.conn.name} · `) && models[0] === ctx.conn.model
    && models.at(-1) === SECOND_MODEL
    && picks.at(-1) === ref, JSON.stringify({ shown, models, picks }));
  record('反例：在输入框下面一行换范围不改设置里的默认范围（model-config.json 的 normalDefault 仍是测试分组）',
    config?.normalDefault === REAL_GROUP, String(config?.normalDefault));
}

// ---------- 走查 2：用户级 AGENTS.md ----------

/**
 * @brief 从左栏进入 Customize 再点最后一节 Instructions（用户级 AGENTS.md），等读完；返回用户级的路径、编辑框、生效的文件，和项目级的标题、说明、
 *        文件。
 */
async function agentsState(page) {
  await page.getByTestId('nav-tools').click();
  await page.locator('[data-testid="tools-nav"] button[data-section="agents"]').click();
  await page.getByTestId('tools-page').getByTestId('agents-section').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="agents-editor"]')?.disabled === false
    && document.querySelector('[data-testid="agents-loaded"] .agents-files'), null, { timeout: 15000 });
  return page.evaluate(() => {
    const section = document.querySelector('[data-testid="agents-section"]');
    const loaded = section?.querySelector('[data-testid="agents-loaded"]');
    return { path: section?.querySelector('.agents-user .agents-path')?.textContent ?? '',
      value: section?.querySelector('[data-testid="agents-editor"]')?.value ?? null,
      missing: Boolean(section?.textContent.includes('This file doesn’t exist yet. Saving creates it.')),
      effective: section?.querySelector('[data-testid="agents-effective"]')?.textContent ?? null,
      title: loaded?.querySelector('h3')?.textContent ?? '', note: loaded?.querySelector('.muted')?.textContent ?? '',
      files: [...(loaded?.querySelectorAll('.agents-files .agents-path') ?? [])].map((item) => item.textContent),
      empty: loaded?.querySelector('.tools-empty')?.textContent ?? null };
  });
}

/** @brief Customize 的 Instructions 一节：先读出样子，再写进编辑框并保存；返回看到的。 */
async function saveAgents(ctx) {
  const { page } = ctx;
  const before = await agentsState(page);
  const section = page.getByTestId('agents-section');
  const editor = page.getByTestId('agents-editor');
  await editor.click();
  await editor.fill(PROMPTS.agents);
  const dirty = await section.getByText('Unsaved changes').count();
  await section.locator('.agents-user').getByRole('button', { name: 'Save', exact: true }).click();
  await section.getByText('Saved · Applies to new sessions').waitFor({ timeout: 15000 });
  await page.getByTestId('agents-effective').waitFor({ timeout: 10000 });
  const effective = await page.getByTestId('agents-effective').innerText();
  await shot(page, '2-agents');
  return { before, dirty, effective };
}

/** @brief 走查 2 的 Customize 部分：文件不存在时的样子、保存、生效的文件、项目级列表。 */
function recordAgents(ctx, seen) {
  const file = join(ctx.agentDir, 'AGENTS.md');
  const written = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const path = seen.effective.replace(/^In effect: /, '');
  const { before } = seen;
  record('走查 2：AGENTS.md 一节：路径 <agentDir>\\AGENTS.md，"还没有这个文件，保存后创建"，编辑框是空的；改了之后"有未保存的改动"',
    samePath(before.path, file) && before.missing && before.value === '' && seen.dirty === 1, JSON.stringify(before));
  record('走查 2：保存后"已保存 · 新建的会话才会读到"，文件写入；Customize 标出生效的文件"生效中：<agentDir>\\AGENTS.md"',
    written === PROMPTS.agents && seen.effective.startsWith('In effect: ') && samePath(path, file),
    JSON.stringify({ effective: seen.effective, written }));
  record('走查 2：项目级"m6-walk 加载的文件"：列出焦点会话按 pi 规则加载的文件（测试项目的 CLAUDE.md），说明会话打开时读取',
    before.title === 'Files loaded by m6-walk' && samePaths(before.files, ctx.agentsFiles)
    && before.note.startsWith('Read when the session opens. If you change a file later, only new sessions pick it up'),
    JSON.stringify({ title: before.title, files: before.files, expected: ctx.agentsFiles, note: before.note }));
}

/** @brief 走查 2：用户级 AGENTS.md 要求以"收到"开头；Customize 标出生效的文件；新会话的第一条回复照做。 */
async function item2(ctx) {
  const { page } = ctx;
  const seen = await saveAgents(ctx);
  recordAgents(ctx, seen);
  await backToChat(page);
  await newSession(page);
  const model = (await pane(page).getByTestId('model-button').textContent()).trim();
  record('反例：新会话仍用设置里的默认范围（测试分组，当前模型是首选的第一个；在那一栏换的范围只作用于那个会话）',
    model === `${REAL_GROUP} · ${ctx.conn.model}`, model);
  await sendTurn(page, PROMPTS.intro);
  const reply = await lastAssistant(page);
  await shot(page, '2-reply');
  record('走查 2：新会话的第一条回复以"收到"开头（模型行为）', reply.text.startsWith('收到'), oneLine(reply.text, 120), true);
  const again = await agentsState(page);
  await shot(page, '2-agents-again');
  record('走查 2：再打开 AGENTS.md 一节：编辑框里是保存的内容（已有文件），仍标"生效中"；项目级只列出项目的 CLAUDE.md，'
    + '不含 agentDir 里的 AGENTS.md（新会话已经读了它）', again.value === PROMPTS.agents && !again.missing
    && again.effective === seen.effective && samePaths(again.files, ctx.agentsFiles),
  JSON.stringify({ value: again.value, missing: again.missing, effective: again.effective, files: again.files }));
  await backToChat(page);
}

// ---------- 走查 3：信任的项目里的技能 ----------

/** @brief 工具页技能一节里某个技能行的样子；不在时为 null。 */
function skillInfo(page, name) {
  return page.evaluate((skill) => {
    const row = document.querySelector(`[data-testid="skill-row"][data-name="${skill}"]`);
    if (!row) return null;
    return { scope: row.dataset.scope, tag: row.querySelector('.tools-tag')?.textContent ?? '',
      description: row.querySelector('.tools-row-desc')?.textContent ?? '', off: row.classList.contains('off'),
      checked: row.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true' };
  }, name);
}

/**
 * @brief 在当前会话的输入框里打 text（从空开始），等"/"列表读完；返回列表项、组名、全部文字、每项的 argument-hint
 *        和说明，以及列表是否在输入框上方。
 */
async function openSlash(page, text) {
  await composer(page).click();
  await composer(page).fill('');
  await page.keyboard.type(text);
  const menu = page.getByTestId('slash-menu');
  await menu.waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="slash-menu"]')?.textContent
    .includes('Loading…'), null, { timeout: 15000 });
  const box = await menu.boundingBox();
  const input = await composer(page).boundingBox();
  return { items: await slashItems(page), text: (await menu.innerText()).trim(),
    groups: await menu.locator('.slash-group-label').allInnerTexts(),
    above: Boolean(box && input && box.y + box.height <= input.y + 1),
    info: await menu.locator('.slash-option').evaluateAll((items) => Object.fromEntries(items.map((item) => [
      item.dataset.name, { hint: item.querySelector('.slash-hint')?.textContent ?? null,
        description: item.querySelector('.slash-description')?.textContent ?? null }]))) };
}

/** @brief 关掉"/"列表，清空输入框。 */
async function closeSlash(page) {
  await page.keyboard.press('Escape');
  await composer(page).fill('');
}

/** @brief "/"列表里没有 name：列表读到了（是数组），且要么有别的项、要么是"This session has no prompt templates or skills"。 */
const slashLacks = (slash, name) => Array.isArray(slash.items) && !slash.items.some((item) => item.name === name)
  && (slash.items.length > 0 || slash.text === SLASH_EMPTY);

/** @brief 走查 3 前半：工具页列出项目技能（本项目），展开看正文和路径，关掉开关；返回看到的和写进的设置。 */
async function disableProjectSkill(ctx) {
  const { page } = ctx;
  await openToolsSection(page, 'skills');
  const row = page.locator(`[data-testid="skill-row"][data-name="${PROJECT_SKILL}"]`);
  const listed = await skillInfo(page, PROJECT_SKILL);
  if (listed) await row.locator('.tools-row-main').click();
  const body = listed ? await row.locator('.tools-body').innerText({ timeout: 5000 }).catch(() => '') : '';
  const path = listed ? await row.locator('.tools-path .tools-mono').innerText({ timeout: 5000 }).catch(() => '') : '';
  const notice = await page.locator('.tools-notice').first().locator('span').innerText();
  await shot(page, '3-skill');
  const userBefore = readJson(join(ctx.agentDir, 'settings.json'));
  const flipped = listed ? await flip(page, row, false) : null;
  await shot(page, '3-skill-off');
  return { listed, body, path, notice, flipped, userBefore, userAfter: readJson(join(ctx.agentDir, 'settings.json')),
    project: readJson(join(ctx.project, '.pi', 'settings.json')) };
}

/** @brief 走查 3 中段：工具页上的技能行和关掉开关后写进的设置。 */
function recordDisabledSkill(ctx, seen) {
  const file = join(ctx.project, '.pi', 'skills', PROJECT_SKILL, 'SKILL.md');
  record('走查 3：工具页"技能"列出项目 .pi/skills 里的 m6-proj-skill：标"本项目"，有用途，开关开着；展开看到文件路径和 SKILL.md '
    + '正文（去掉 frontmatter）；顶部"启停和添加对新建的会话生效"', seen.listed?.scope === 'project'
    && seen.listed.tag === 'Project' && seen.listed.checked
    && seen.listed.description.startsWith('Synthetic project skill')
    && seen.body.includes('M6-PROJ-SKILL-OK') && !seen.body.includes('description:') && samePath(seen.path, file)
    && seen.notice === TOOLS_NOTICE,
  JSON.stringify({ listed: seen.listed, body: oneLine(seen.body, 80), path: seen.path, notice: seen.notice }));
  const expected = PI_CONFIG.snapshots.find((s) => s.what === '停用项目技能').project.skills
    .map((entry) => entry.replace('proj-skill', PROJECT_SKILL));
  record('走查 3：关掉开关：行变淡；项目的 .pi/settings.json 写入与 pi config -l 相同的条目（-skills\\m6-proj-skill\\SKILL.md），'
    + '用户级设置不变', seen.flipped?.settled && seen.flipped.checked === 'false' && seen.flipped.off
    && !seen.flipped.error && JSON.stringify(seen.project) === JSON.stringify({ skills: expected })
    && JSON.stringify(seen.userAfter) === JSON.stringify(seen.userBefore),
  JSON.stringify({ flipped: seen.flipped, project: seen.project, expected }));
}

/** @brief 走查 3：信任的项目里的技能：工具页标"Project"；停用写项目设置（与 pi config -l 相同）；新会话里没有它。 */
async function item3(ctx) {
  const { page } = ctx;
  await newSession(page);
  const control = await openSlash(page, '/');
  await closeSlash(page);
  record('走查 3（Mori 一侧，对照）：停用前，信任的项目里新会话的"/"列表有 /skill:m6-proj-skill',
    Boolean(control.items?.some((item) => item.name === `skill:${PROJECT_SKILL}`)), oneLine(control.text, 200));
  await sendTurn(page, PROMPTS.skills);
  const before = await lastAssistant(page);
  record('走查 3：信任的项目里新会话问"你能用哪些技能"，回答里有 m6-proj-skill（模型行为，作对照）',
    before.text.includes(PROJECT_SKILL), oneLine(before.text, 200), true);
  recordDisabledSkill(ctx, await disableProjectSkill(ctx));
  ctx.skillDisabled = true;
  await clickNewSession(page, toolsNewSession(page));
  const slash = await openSlash(page, '/');
  await closeSlash(page);
  record('走查 3（Mori 一侧）：停用后新会话的"/"列表里没有 /skill:m6-proj-skill', slashLacks(slash, `skill:${PROJECT_SKILL}`),
    oneLine(slash.text, 200));
  await sendTurn(page, PROMPTS.skills);
  const after = await lastAssistant(page);
  await shot(page, '3-after');
  record('走查 3：停用后新会话问同样的问题，回答里没有 m6-proj-skill（模型行为）', !after.text.includes(PROJECT_SKILL),
    oneLine(after.text, 200), true);
  await openToolsSection(page, 'skills');
  const still = await skillInfo(page, PROJECT_SKILL);
  record('走查 3：停用的技能仍列在工具页里，开关关着、行变淡（可以再打开）', still?.checked === false && still.off,
    JSON.stringify(still));
  await backToChat(page);
}

// ---------- 走查 4、5：MCP ----------

/** @brief 工具页 MCP 一节点"Add"，在表单里填写并保存；返回表单的说明和保存后的提示。 */
async function addMcp(page, { name, command, args = [], env = [] }) {
  await openToolsSection(page, 'mcp');
  const tools = page.getByTestId('tools-page');
  await tools.getByRole('button', { name: 'Add', exact: true }).click();
  const form = page.getByTestId('mcp-form');
  await form.waitFor({ timeout: 5000 });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Command').fill(command);
  await form.getByLabel('Arguments').fill(args.join('\n'));
  await form.getByLabel('Environment variables').fill(env.join('\n'));
  const hint = await form.locator('.field-hint').innerText();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = tools.locator('.form-message.ok');
  await saved.waitFor({ timeout: 15000 }).catch(() => {});
  return { hint, saved: await saved.innerText().catch(() => null),
    error: await form.locator('.form-message.error').innerText({ timeout: 1000 }).catch(() => null) };
}

/** @brief 工具页 MCP 一节里某个服务行的样子；不在时为 null。 */
function mcpInfo(page, name) {
  return page.evaluate((server) => {
    const row = document.querySelector(`[data-testid="mcp-row"][data-server="${server}"]`);
    if (!row) return null;
    return { tags: [...row.querySelectorAll('.tools-tag')].map((tag) => tag.textContent),
      command: row.querySelector('.tools-mono')?.textContent ?? '',
      tools: row.querySelector('[data-testid="mcp-tools"]')?.textContent ?? null,
      errors: [...row.querySelectorAll('[data-testid="mcp-error"] > p')].map((line) => line.textContent),
      checked: row.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true' };
  }, name);
}

/**
 * @brief 进入工具页 MCP 一节读这个服务，直到 fn(行的样子) 为真；服务在会话打开后才在后台连上，工具页不监视文件，
 *        也没有连接状态可等，所以像人一样回到会话、隔一秒再进来。返回最后的样子和进入的次数；返回时停在 MCP 一节。
 */
async function mcpUntil(page, name, fn, tries = 15) {
  for (let attempt = 1; ; attempt += 1) {
    await openToolsSection(page, 'mcp');
    const info = await mcpInfo(page, name);
    if (fn(info) || attempt >= tries) return { ...info, tries: attempt };
    await backToChat(page);
    await sleep(1000);
  }
}

/** @brief MCP 一节保存后，点保存提示里的"New session"（像人一样），等新会话就绪。 */
function savedNewSession(page) {
  return clickNewSession(page, page.getByTestId('tools-page').locator('.form-message.ok')
    .getByRole('button', { name: 'New session' }));
}

/** @brief 走查 4 后半：让模型调用 mcp__mori_test__echo，批准卡点"Allow once"，看工具卡。 */
async function callMcpTool(page) {
  const { cards } = await sendTurn(page, PROMPTS.mcpCall);
  const card = await lastToolCard(page);
  await shot(page, '4-mcp-call');
  const asked = cards.find((item) => item.tool === 'mcp__mori_test__echo');
  record('走查 4：让模型调用 mcp__mori_test__echo：出批准卡，标题"mori_test · echo"', asked?.title === 'mori_test · echo',
    cards.length ? JSON.stringify(cards) : `模型没有调用工具；回复：${oneLine((await lastAssistant(page)).text, 150)}`,
    cards.length === 0);
  record('走查 4：允许一次后工具卡"mori_test · echo"完成，输出 mori-mcp echo: hello-mori', card?.title === 'mori_test · echo'
    && card.status === 'done' && card.body.includes('mori-mcp echo: hello-mori'), JSON.stringify(card),
  cards.length === 0);
}

/** @brief 走查 4：用表单添加 stdio MCP 服务；新会话看到它的工具名；调用它的工具出批准卡"mori_test · echo"，允许后有结果。 */
async function item4(ctx) {
  const { page } = ctx;
  const added = await addMcp(page, { name: 'mori_test', command: 'node', args: [MCP_SERVER] });
  const entry = readJson(join(ctx.agentDir, 'mcp.json'))?.mcpServers?.mori_test;
  record('走查 4：MCP 表单（名称、命令、参数）保存：提示"已保存 · 新建的会话才会连接它"；mcp.json 写入这一项，调用方式 direct',
    added.saved?.startsWith('Saved · Only new sessions will connect to it') && entry?.command === 'node'
    && entry?.args?.[0] === MCP_SERVER && entry?.exposure === 'direct'
    && added.hint === 'Servers you add here always use direct calls (exposure: direct)',
  JSON.stringify({ added, entry }));
  await savedNewSession(page);
  const info = await mcpUntil(page, 'mori_test', (row) => row?.tools?.includes('mcp__mori_test__echo'));
  await shot(page, '4-mcp-tools');
  record('走查 4：新会话的工具页 MCP 一节：mori_test 一行（用户级、直接调用、命令行、开关开着），"当前会话里注册的工具：'
    + 'mcp__mori_test__echo、mcp__mori_test__add"',
  info.tools === 'Tools in this session: mcp__mori_test__echo, mcp__mori_test__add'
    && info.tags.includes('User') && info.tags.includes('Direct') && info.command === `node ${MCP_SERVER}`
    && info.checked, JSON.stringify(info));
  const tool = await toolInfo(page, 'mcp__mori_test__echo');
  record('走查 4：工具页"内置工具"列出 mcp__mori_test__echo，来源"MCP · mori_test"，状态"启用"',
    tool?.tag === 'MCP · mori_test' && tool.active === 'true' && tool.state === 'Enabled', JSON.stringify(tool));
  await backToChat(page);
  await callMcpTool(page);
}

/**
 * @brief 展开 MCP 一行下面 pi 通知的"Full notice"（不是进程状态的"Full error"）；返回展开后看得见没有，和通知原文。
 */
async function expandNotice(page, name) {
  const details = page.locator(`[data-testid="mcp-row"][data-server="${name}"] [data-testid="mcp-error"]`)
    .locator('.tools-full-notice');
  if (await details.count() === 0) return { open: false, texts: [] };
  await details.locator('summary').click();
  const open = await details.locator('pre').first().waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true, () => false);
  return { open, texts: await details.locator('pre').allInnerTexts() };
}

/** @brief 走查 5：命令写错的 MCP 服务：新会话的工具页显示 pi 通知里关于它的那一行原文。 */
async function item5(ctx) {
  const { page } = ctx;
  const file = join(ctx.agentDir, 'mcp.json');
  const before = readJson(file);
  const added = await addMcp(page, { name: 'mori_broken', command: 'no-such-command-mori' });
  const after = readJson(file);
  const kept = Object.entries(before?.mcpServers ?? {})
    .every(([name, entry]) => JSON.stringify(after?.mcpServers?.[name]) === JSON.stringify(entry));
  record('走查 5：表单保存命令写错的服务：mcp.json 加上 mori_broken（direct），已有的服务原样保留',
    added.saved?.startsWith('Saved · Only new sessions will connect to it')
    && after?.mcpServers?.mori_broken?.command === 'no-such-command-mori'
    && after.mcpServers.mori_broken.exposure === 'direct' && kept,
    JSON.stringify({ added, servers: Object.keys(after?.mcpServers ?? {}) }));
  await savedNewSession(page);
  const notice = pane(page).getByTestId('ext-notify').filter({ hasText: 'mori_broken' }).first();
  const arrived = await notice.waitFor({ timeout: 60000 }).then(() => true, () => false);
  const raw = arrived ? await notice.innerText() : '';
  await openToolsSection(page, 'mcp');
  const info = await mcpInfo(page, 'mori_broken');
  const full = await expandNotice(page, 'mori_broken');
  await shot(page, '5-mcp-error');
  const line = info?.errors?.[0] ?? '';
  record('走查 5：命令写错的服务：工具页这一行下面警示色显示 pi 的错误原文"mori_broken: failed: …"，与对话流里 pi 的通知相同，'
    + '"完整通知"展开后是整条通知', line.startsWith('mori_broken: failed:') && raw.includes(line) && full.open
    && full.texts.some((text) => text.startsWith('MCP servers need attention') && text.includes(line)),
  JSON.stringify({ line, raw, full }));
  record('走查 5：写错的服务不显示"已连接"，工具名一行写"当前会话里它没有注册工具"',
    info?.tools === 'This server has no tools in this session'
    && !(await page.getByTestId('tools-page').innerText()).includes('Connected'),
    JSON.stringify(info));
  await backToChat(page);
}

// ---------- 走查 6：本地 pi 包 ----------

/** @brief 包卡片的样子：来源、文件夹、范围标签、分组和每个资源。 */
function packageInfo(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="package-card"]')].map((card) => ({
    source: card.dataset.source, root: card.querySelector('.tools-mono')?.textContent ?? '',
    tag: card.querySelector('.tools-card-head .tools-tag')?.textContent ?? '',
    groups: [...card.querySelectorAll('.tools-group h3')].map((heading) => heading.textContent),
    resources: [...card.querySelectorAll('[data-testid="package-resource"]')].map((row) => ({ kind: row.dataset.kind,
      name: row.querySelector('.tools-row-name')?.textContent ?? '',
      tags: [...row.querySelectorAll('.tools-tag')].map((tag) => tag.textContent),
      checked: row.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true' })) })));
}

/** @brief 走查 6 前半：添加本地包（系统对话框选文件夹），列出资源；返回卡片、说明和写进的设置。 */
async function addPackage(ctx, pkg) {
  const { page } = ctx;
  await openToolsSection(page, 'plugins');
  await stubFolder(ctx.app, pkg);
  const note = await page.locator('.tools-add .tools-row-note').innerText();
  await page.getByTestId('tools-page').getByRole('button', { name: 'Add plugin from folder…' }).click();
  await page.getByTestId('package-card').first().waitFor({ timeout: 15000 });
  await shot(page, '6-package');
  return { note, cards: await packageInfo(page), packages: readJson(join(ctx.agentDir, 'settings.json'))?.packages };
}

/**
 * @brief 走查 6 中段：关掉包里技能的开关，看设置、技能一节，和新会话的"/"列表；回到插件一节再打开。
 */
async function togglePackageSkill(ctx) {
  const { page } = ctx;
  const row = page.locator('[data-testid="package-card"] [data-testid="package-resource"][data-kind="skills"]').first();
  const off = await flip(page, row, false);
  const written = readJson(join(ctx.agentDir, 'settings.json'))?.packages;
  await shot(page, '6-skill-off');
  await openToolsSection(page, 'skills');
  const listed = await skillInfo(page, 'package-review');
  await clickNewSession(page, toolsNewSession(page));
  const slash = await openSlash(page, '/');
  await closeSlash(page);
  await openToolsSection(page, 'plugins');
  const on = await flip(page, row, true);
  return { off, written, listed, slash, on, rewritten: readJson(join(ctx.agentDir, 'settings.json'))?.packages };
}

/** @brief 走查 6 后半：新会话里包的扩展注册的 package_hello 出现，调用时出批准卡。 */
async function callPackageTool(ctx) {
  const { page } = ctx;
  await clickNewSession(page, toolsNewSession(page));
  const tool = await toolInfo(page, 'package_hello');
  await backToChat(page);
  const { cards } = await sendTurn(page, PROMPTS.packageCall);
  const card = await lastToolCard(page);
  await shot(page, '6-package-call');
  record('走查 6：新会话的工具页"内置工具"列出包的扩展注册的 package_hello，来源"插件 …"，状态"启用"',
    tool?.tag.startsWith('Plugin ') && tool.active === 'true', JSON.stringify(tool));
  record('反例：调用插件扩展注册的 package_hello 出批准卡；允许后输出 hello from package',
    cards.some((item) => item.tool === 'package_hello') && card?.status === 'done'
    && card.body.includes('hello from package'), JSON.stringify({ cards, card }), cards.length === 0);
}

/** @brief 走查 6 中段的检查：按资源停用、再启用，写法与 pi config 相同，并且只影响新会话。 */
function recordPackageToggle(toggled, source) {
  const expected = PI_CONFIG.snapshots.find((s) => s.what === '停用包里的技能').user.packages[0].skills;
  record('走查 6：关掉包里技能 package-review 的开关：行变淡；设置里这个包变成 { source, skills: ["-skills\\package-review\\'
    + 'SKILL.md"] }（与 pi config 相同）；技能一节里它标"插件 …"、开关关着', toggled.off.settled
    && toggled.off.checked === 'false' && toggled.off.off
    && JSON.stringify(toggled.written) === JSON.stringify([{ source, skills: expected }])
    && toggled.listed?.scope === 'package' && toggled.listed.tag.startsWith('Plugin ') && !toggled.listed.checked,
  JSON.stringify({ off: toggled.off, written: toggled.written, listed: toggled.listed }));
  record('走查 6（Mori 一侧）：停用后新会话的"/"列表没有 /skill:package-review，同一个包的提示词 /package-summary 还在',
    slashLacks(toggled.slash, 'skill:package-review')
    && Boolean(toggled.slash.items?.some((item) => item.name === 'package-summary')), oneLine(toggled.slash.text, 200));
  record('走查 6：再打开开关：技能重新启用（开关开着；设置里改成 +skills\\package-review\\SKILL.md，同 pi config 的写法）',
    toggled.on.settled && toggled.on.checked === 'true' && !toggled.on.off
    && JSON.stringify(toggled.rewritten)
      === JSON.stringify([{ source, skills: ['+skills\\package-review\\SKILL.md'] }]),
    JSON.stringify({ on: toggled.on, rewritten: toggled.rewritten }));
}

/** @brief 走查 6：添加本地文件夹的 pi 包：列出包内资源，可以按资源启停。 */
async function item6(ctx) {
  const pkg = join(ctx.root, 'pkg');
  cpSync(join(appRoot, 'tests', 'pi-package'), pkg, { recursive: true });
  const added = await addPackage(ctx, pkg);
  const card = added.cards[0];
  const names = Object.fromEntries(card?.resources.map((item) => [item.kind, item.name]) ?? []);
  const source = relative(ctx.agentDir, pkg);
  record('走查 6：添加本地包：出现包的卡（用户级、解析后的文件夹），按扩展、技能、提示词、主题分组列出资源，开关都开着，'
    + '主题标"Mori 不使用"；说明"内网只支持本地文件夹的包"；设置的 packages 写入相对 agentDir 的路径',
  added.cards.length === 1 && card.tag === 'User' && samePath(card.root, pkg) && card.source === source
    && card.groups.join() === 'Extensions,Skills,Prompt templates,Themes' && card.resources.length === 4
    && names.extensions === 'package-hello.ts' && names.skills === 'package-review'
    && names.prompts === 'package-summary.md' && names.themes === 'package-theme.json'
    && card.resources.every((item) => item.checked)
    && card.resources.find((item) => item.kind === 'themes')?.tags.includes('Not used by Mori')
    && added.note === 'Plugins must be local folders that include their dependencies. Nothing is downloaded.'
    && JSON.stringify(added.packages) === JSON.stringify([source]), JSON.stringify(added));
  recordPackageToggle(await togglePackageSkill(ctx), source);
  await callPackageTool(ctx);
}

// ---------- 走查 7："/"补全 ----------

/** @brief 按 key，等高亮项变成 want（最多 2 秒）；返回之后高亮的项。 */
async function slashKey(page, key, want) {
  await page.keyboard.press(key);
  const selected = '[data-testid="slash-menu"] [role="option"][aria-selected="true"]';
  await page.waitForFunction(({ sel, name }) => document.querySelector(sel)?.dataset.name === name,
    { sel: selected, name: want }, { timeout: 2000 }).catch(() => {});
  return page.evaluate((sel) => document.querySelector(sel)?.dataset.name ?? null, selected);
}

/** @brief "/"列表开着时按 ↑、↓、Esc：返回高亮的项、列表是否还在、输入框的字和是否在运行。 */
async function slashKeys(page, items) {
  const up = await slashKey(page, 'ArrowUp', items.at(-1)?.name);
  const down = await slashKey(page, 'ArrowDown', items[0]?.name);
  await page.keyboard.press('Escape');
  const closed = await page.getByTestId('slash-menu').waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  return { up, down, closed, value: await composer(page).inputValue(),
    running: await pane(page).getAttribute('data-running') };
}

/** @brief 当前会话最后一个技能调用的气泡：名字、那一行的字；点"Expand"后的路径和正文。 */
async function skillBubble(page) {
  const bubble = pane(page).getByTestId('skill-invocation').last();
  if (await bubble.count() === 0) return null;
  const head = { skill: await bubble.getAttribute('data-skill'),
    label: await bubble.locator('.skill-label').innerText() };
  await bubble.locator('.skill-toggle').click();
  return { ...head, location: await bubble.locator('.skill-location').innerText({ timeout: 5000 }).catch(() => ''),
    body: await bubble.locator('.skill-body').innerText({ timeout: 5000 }).catch(() => '') };
}

/** @brief 走查 7 中段：随打字过滤，点一项插入技能命令并发出；看气泡、会话名和会话文件。 */
async function slashSkill(ctx) {
  const { page } = ctx;
  await page.keyboard.type('m6-h');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="slash-menu"] [role="option"]').length === 1,
    null, { timeout: 5000 }).catch(() => {});
  const filtered = await slashItems(page);
  await page.locator(`[data-testid="slash-menu"] [role="option"][data-name="skill:${USER_SKILL}"]`).click();
  const inserted = { value: await composer(page).inputValue(), open: await page.getByTestId('slash-menu').count(),
    running: await pane(page).getAttribute('data-running') };
  await submitTurn(page);
  const bubble = await skillBubble(page);
  const reply = await lastAssistant(page);
  const sent = sessionEntries(await activeFile(page)).find((e) => e.type === 'message' && e.message.role === 'user');
  const title = await topTitle(page);
  await shot(page, '7-skill');
  record('走查 7：Esc 关掉后改了第一个词列表又出现，随打字过滤（"/m6-h" 只剩 /skill:m6-hello）；点它插入"/skill:m6-hello "，'
    + '列表关闭，没有发送', filtered?.length === 1 && filtered[0].name === `skill:${USER_SKILL}`
    && inserted.value === `/skill:${USER_SKILL} ` && inserted.open === 0 && inserted.running === 'false',
  JSON.stringify({ filtered, inserted }));
  record('走查 7：发出技能命令：你的消息显示为一行"技能 · m6-hello"，展开看到 SKILL.md 的路径和正文；会话名是"/skill:m6-hello"',
    bubble?.skill === USER_SKILL && bubble.label === `Skill · ${USER_SKILL}`
    && samePath(bubble.location, join(ctx.agentDir, 'skills', USER_SKILL, 'SKILL.md'))
    && bubble.body.includes('Reply with exactly one line: M6-SKILL-OK') && title === `/skill:${USER_SKILL}`,
  JSON.stringify({ bubble: bubble && { ...bubble, body: oneLine(bubble.body, 120) }, title }));
  record('走查 7（Mori 一侧）：会话文件里你的消息是 pi 展开后的 <skill name="m6-hello" …> 块',
    textOf(sent).startsWith(`<skill name="${USER_SKILL}"`), oneLine(textOf(sent), 120));
  record('走查 7：模型照技能回复 M6-SKILL-OK（模型行为）', reply.text.includes('M6-SKILL-OK'), oneLine(reply.text, 120), true);
}

/** @brief 走查 7 最后：Tab 插入提示词模板、写参数发出，你的消息是展开后的模板。 */
async function slashTemplate(ctx) {
  const { page } = ctx;
  await openSlash(page, '/m6-s');
  await page.keyboard.press('Tab');
  const inserted = await composer(page).inputValue();
  await page.keyboard.type('README.md');
  await submitTurn(page);
  const user = await pane(page).getByTestId('user-message').last().innerText().catch(() => '');
  await shot(page, '7-template');
  record('走查 7：Tab 插入"/m6-summary "，写参数 README.md 发出：你的消息是展开后的模板（"请读取 README.md，然后用一句话总结它的'
    + '内容。"），不再有 /m6-summary', inserted === `/${USER_PROMPT} ` && user.trim() === '请读取 README.md，然后用一句话总结它的内容。',
  JSON.stringify({ inserted, user }));
}

/** @brief 走查 7 前段的检查：列表的分组、每项的样子、位置。 */
function recordSlashList(ctx, all) {
  const names = all.items?.map((item) => item.name) ?? [];
  const kindOf = (name) => all.items?.find((item) => item.name === name)?.kind;
  const prompt = all.info[USER_PROMPT];
  const skill = all.info[`skill:${USER_SKILL}`];
  record('走查 7：输入 "/"：输入框上方分"提示词模板""技能"两组，列出 /m6-summary（<file>，说明）和 /skill:m6-hello（说明），'
    + '第一项高亮', all.above && all.groups[0] === 'Prompt templates' && all.groups[1] === 'Skills'
    && kindOf(USER_PROMPT) === 'prompt'
    && prompt?.hint === '<file>' && prompt?.description === '用一句话总结一个文件' && kindOf(`skill:${USER_SKILL}`) === 'skill'
    && Boolean(skill?.description?.startsWith('Synthetic skill for the Mori M6 walkthrough'))
    && all.items?.[0]?.selected && all.items.filter((item) => item.selected).length === 1,
  JSON.stringify({ above: all.above, groups: all.groups, items: all.items, info: all.info }));
  if (ctx.skillDisabled) {
    record('反例：停用的项目技能不在 "/" 列表里', !names.includes(`skill:${PROJECT_SKILL}`), names.join(', '));
  }
}

/** @brief 走查 7：agentDir 里放一个技能和一个提示词模板，新会话里打 "/" 列出它们。 */
async function item7(ctx) {
  const { page } = ctx;
  writeUserCommands(ctx.agentDir);
  await newSession(page);
  const all = await openSlash(page, '/');
  await shot(page, '7-slash');
  recordSlashList(ctx, all);
  const keys = await slashKeys(page, all.items ?? []);
  record('走查 7：列表开着时 ↑ 从第一项循环到最后一项，↓ 回到第一项；Esc 关闭列表，输入框里的 "/" 还在，没有发送',
    all.items?.length > 1 && keys.up === all.items.at(-1).name && keys.down === all.items[0].name && keys.closed
    && keys.value === '/' && keys.running === 'false', JSON.stringify(keys));
  await slashSkill(ctx);
  await slashTemplate(ctx);
}

// ---------- 走查 8：思考强度 ----------

/** @brief 输入框下面一行思考按钮的样子，打开菜单读出各项、说明，再按 Esc 关上。 */
async function thinkingMenu(page, name) {
  const button = pane(page).getByTestId('thinking-button');
  // textContent：会话面板窄时"Effort: "前缀藏起，但 textContent 里仍有（models.md"窄栏"）
  const head = { text: (await button.textContent()).trim(), reasoning: await button.getAttribute('data-reasoning') };
  await button.click();
  const menu = page.getByTestId('thinking-menu');
  await menu.waitFor({ timeout: 5000 });
  const state = await menu.evaluate((element) => ({
    items: [...element.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ level: item.dataset.level,
      disabled: item.disabled })),
    checked: element.querySelector('[role="menuitemradio"][aria-checked="true"]')?.dataset.level ?? null,
    note: element.querySelector('.menu-note')?.textContent ?? '',
    links: [...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent) }));
  await shot(page, name);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  return { ...head, ...state };
}

/** @brief 设置 → Models 里编辑首选的第一个模型：勾"Supports thinking"、新会话强度选 level，Save；返回看到的。 */
async function markReasoning(ctx, level) {
  const { page } = ctx;
  await openSettings(page);
  const row = modelRow(page, `${ctx.conn.provider}/${ctx.conn.model}`);
  await row.locator('[data-action="edit"]').click();
  const form = page.getByTestId('model-form');
  await form.waitFor({ timeout: 10000 });
  const before = { readOnly: await form.getByLabel('Model ID', { exact: true }).getAttribute('readonly'),
    selects: await form.getByLabel('Default effort for new sessions').count() };
  await form.getByLabel('Supports thinking').check();
  await form.getByLabel('Default effort for new sessions').selectOption(level);
  await shot(page, '8-edit-model');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  const meta = oneLine(await row.innerText());
  return { before, meta };
}

/** @brief 会话文件里某条你的消息之前最后记下的思考强度，和它之后那条助手回复的思考内容长度。 */
function levelAround(entries, text) {
  let level = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.type === 'thinking_level_change') level = entry.thinkingLevel;
    if (entry.type !== 'message' || entry.message.role !== 'user' || !contentOf(entry).includes(text)) continue;
    const reply = entries.slice(index + 1).find((e) => e.type === 'message' && e.message.role === 'assistant');
    const thinking = (reply?.message.content ?? []).filter((c) => c.type === 'thinking')
      .map((c) => c.thinking ?? '').join('').trim().length;
    return { level, thinking };
  }
  return { level, thinking: null };
}

/** @brief 走查 8 后半：新会话默认"Low"；切到"High"问鸡兔同笼（记下生成中这一行按钮的样子），切到"Off"再问一道。 */
async function askWithThinking(ctx) {
  const { page } = ctx;
  await newSession(page);
  const initial = await pane(page).getByTestId('thinking-button').getAttribute('data-level');
  const menu = await thinkingMenu(page, '8-menu');
  await chooseThinking(page, 'high');
  const { start } = await sendTurn(page, PROMPTS.reason1);
  const high = await lastAssistant(page);
  const file = await activeFile(page);
  await shot(page, '8-high');
  await chooseThinking(page, 'off');
  await sendTurn(page, PROMPTS.reason2);
  const off = await lastAssistant(page);
  await shot(page, '8-off');
  const entries = sessionEntries(file);
  return { initial, menu, start, high, off, first: levelAround(entries, '鸡和兔'), second: levelAround(entries, '它的一半'),
    settings: readJson(join(ctx.agentDir, 'settings.json')) };
}

/** @brief 走查 8 后半的检查：新会话的默认强度、生成中按钮不可用、高 / 关两次回复。 */
function recordThinkingRun(ctx, run) {
  record('走查 8：新会话的思考强度是设置里的默认"低"；菜单列出关、最低、低、中、高，"低"打勾，说明只作用于这个会话',
    run.initial === 'low' && run.menu.text === 'Effort: Low' && run.menu.reasoning === 'true'
    && run.menu.items.map((item) => item.level).join() === 'off,minimal,low,medium,high'
    && run.menu.items.every((item) => !item.disabled) && run.menu.checked === 'low'
    && run.menu.note === 'Applies to this session only. Set each model’s default for new sessions in Settings.',
    JSON.stringify(run.menu));
  record('走查 8：生成中输入框下面一行的范围和思考按钮不可用（aria-disabled，仍能 Tab 到），范围按钮悬停的第三行'
    + '"Can’t switch models until the response finishes"、Effort 悬停的第二行"Can’t change effort until the response '
    + 'finishes"，读屏的描述里也是', run.start?.running === true && run.start.model?.unavailable
    && run.start.model.tip[2] === MODEL_BUSY && run.start.model.described.endsWith(`. ${MODEL_BUSY}`)
    && run.start.thinking?.unavailable && run.start.thinking.tip[1] === NOTE.effortBusy
    && run.start.thinking.described === NOTE.effortBusy, JSON.stringify(run.start));
  record('反例：在输入框下面一行切换思考强度不改设置里的默认（modelThinkingLevels 仍是 low，没有写 defaultThinkingLevel）',
    run.settings?.modelThinkingLevels?.[`${ctx.conn.provider}/${ctx.conn.model}`] === 'low'
    && run.settings?.defaultThinkingLevel === undefined, JSON.stringify(run.settings?.modelThinkingLevels));
  record('走查 8：输入框下面一行切到"高"后问鸡兔同笼：回复带思考内容（模型行为：DeepSeek 可能跳过思考）', run.high.thinking > 0,
    JSON.stringify({ high: { thinking: run.high.thinking, text: oneLine(run.high.text, 80) } }), true);
  record('走查 8：切到"关"后再问一道：回复没有思考内容（pi 发 thinking: disabled）', run.off.thinking === 0,
    JSON.stringify({ off: { thinking: run.off.thinking, text: oneLine(run.off.text, 80) } }), true);
  record('走查 8（Mori 一侧）：会话文件里两次提问之前记下的思考强度分别是 high、off；界面上有没有思考块与会话文件里回复的思考内容一致',
    run.first.level === 'high' && run.second.level === 'off' && (run.high.thinking > 0) === (run.first.thinking > 0)
    && (run.off.thinking > 0) === (run.second.thinking > 0), JSON.stringify({ first: run.first, second: run.second }));
}

/** @brief 走查 8 最后：同一会话换到没标支持思考的模型（走查 1 加的），思考按钮按返回值变成"Unavailable"。 */
async function switchToUnmarked(ctx) {
  const { page } = ctx;
  const models = modelConfig(ctx)?.providers?.find((item) => item.id === ctx.conn.provider)?.models ?? [];
  if (!models.some((model) => model.id === SECOND_MODEL)) return;
  await switchModel(page, `${ctx.conn.provider}/${SECOND_MODEL}`, '8-model-menu');
  await page.waitForFunction((sel) => document.querySelector(`${sel} [data-testid="thinking-button"]`)
    ?.dataset.reasoning === 'false', PANE, { timeout: 5000 }).catch(() => {});
  const button = pane(page).getByTestId('thinking-button');
  const state = { text: (await button.textContent()).trim(), reasoning: await button.getAttribute('data-reasoning'),
    level: await button.getAttribute('data-level') };
  await shot(page, '8-unmarked-switch');
  record('走查 8：同一会话在输入框下面一行把范围换到没标支持思考的 deepseek-v4-pro：思考按钮按当前模型变成"Effort: Unavailable"',
    state.text === 'Effort: Unavailable' && state.reasoning === 'false', JSON.stringify(state));
}

/**
 * @brief 走查 8：把模型标为支持思考；输入框下面一行"High"有思考内容，"Off"没有。之前先看反例：没标时不可选。
 *        最后在分屏的一栏里换一次范围、发一句（splitPaneSwitch）。
 */
async function item8(ctx) {
  const { page } = ctx;
  await newSession(page);
  ctx.s8 = await activeFile(page);
  const unmarked = await thinkingMenu(page, '8-unmarked');
  record('反例：模型没标支持思考时，输入框下面一行"Effort: Unavailable"，菜单里的强度都不可用，说明原因（英文，§9.2）并有'
    + '"Open settings"',
    unmarked.text === 'Effort: Unavailable' && unmarked.reasoning === 'false' && unmarked.items.length > 0
    && unmarked.items.every((item) => item.disabled) && unmarked.note.startsWith(UNSUPPORTED_NOTE)
    && unmarked.links.includes('Open settings'), JSON.stringify(unmarked));
  const edited = await markReasoning(ctx, 'low');
  const model = modelConfig(ctx)?.providers?.find((item) => item.id === ctx.conn.provider)?.models
    ?.find((item) => item.id === ctx.conn.model);
  const levels = readJson(join(ctx.agentDir, 'settings.json'))?.modelThinkingLevels;
  record('走查 8：编辑模型（Model ID 只读；没勾时没有 Default effort for new sessions），勾"Supports thinking"、新会话强度选'
    + ' Low，Save：模型行显示"Supports thinking"；model-config.json 有 reasoning: true，settings.json 的 modelThinkingLevels'
    + ' 是 low', edited.before.readOnly !== null && edited.before.selects === 0
    && edited.meta.includes('Supports thinking') && model?.reasoning === true
    && levels?.[`${ctx.conn.provider}/${ctx.conn.model}`] === 'low', JSON.stringify({ edited, model, levels }));
  await backToChat(page);
  const reopened = await pane(page).getByTestId('thinking-button').getAttribute('data-reasoning');
  record('走查 8：已经打开的会话（用这个模型）的思考按钮随之可选', reopened === 'true', reopened);
  recordThinkingRun(ctx, await askWithThinking(ctx));
  await switchToUnmarked(ctx);
  await splitPaneSwitch(ctx);
}

/** @brief 分屏那一步要换到的模型：走查 1 加的 deepseek-v4-pro；没有时用默认分组里第二个提供商的第一个模型；都没有时为 null。 */
function splitTarget(ctx) {
  const models = modelConfig(ctx)?.providers?.find((item) => item.id === ctx.conn.provider)?.models ?? [];
  if (models.some((model) => model.id === SECOND_MODEL)) {
    return { ref: `${ctx.conn.provider}/${SECOND_MODEL}`, id: SECOND_MODEL };
  }
  const other = ctx.providers?.[1];
  return other ? { ref: other.ref, id: other.model } : null;
}

/**
 * @brief 走查 8 最后（composer-pickers.md"用真实模型走一遍"：含一次分屏里的一栏）：当前会话在左、item8 开头新建的会话 S8
 *        在右分屏；右栏这一行的范围菜单往上打开、在右栏里（models.md"菜单的位置与键盘"）；在右栏的菜单里选另一个模型
 *        （splitTarget），右栏的范围按钮显示它、左栏的范围不变；在右栏发一句，会话文件里这条回复来自它。最后关掉分屏。
 */
async function splitPaneSwitch(ctx) {
  const { page } = ctx;
  const target = splitTarget(ctx);
  if (!ctx.s8 || !target) {
    record('走查 8（分屏）：在分屏右栏这一行换范围，下一条回复来自新模型', false, 'no second model or session', true);
    return;
  }
  await splitOpen(page, ctx.s8);
  const right = `${slotSelector('right')} [data-testid="chat-pane"]`;
  const button = (side) => page.locator(`${slotSelector(side)} [data-testid="composer"] .composer-bottom `
    + '[data-testid="model-button"]');
  const leftBefore = await button('left').getAttribute('data-pick');
  const placed = await openAndPlace(page, { paneCss: right, ...POPUPS.model });
  await button('right').click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-pick="${target.ref}"]`).click();
  await page.waitForFunction((css) => {
    const element = document.querySelector(css);
    return element?.dataset.pending !== 'true' && !element?.hasAttribute('aria-disabled');
  }, `${slotSelector('right')} [data-testid="model-button"]`, { timeout: 15000 });
  const shown = { right: (await button('right').innerText()).trim(),
    pick: await button('right').getAttribute('data-pick'), left: await button('left').getAttribute('data-pick') };
  await composerAt(page, 'right').fill(PROMPTS.today);
  await composerAt(page, 'right').press('Enter');
  await waitPaneIdle(page, 'right', 300000);
  await shot(page, '8-split-switch');
  const models = sessionEntries(ctx.s8).filter((e) => e.type === 'message' && e.message.role === 'assistant')
    .map((e) => e.message.model);
  record(`走查 8（分屏）：右栏这一行的范围菜单往上打开、在右栏里；选 ${target.id} 后右栏的范围按钮显示它，左栏的范围不变；`
    + '在右栏发一句，会话文件里这条回复来自它', placed?.problems.length === 0 && shown.pick === target.ref
    && shown.right === target.id && shown.left === leftBefore && models.at(-1) === target.id,
  JSON.stringify({ placed: placed?.problems, shown, models }));
  await page.locator(`${slotSelector('right')} [data-testid="close-pane"]`).click();
  await waitSplit(page, false);
}

// ---------- 反例 ----------

/**
 * @brief 反例：没有注册任何工具的 MCP 服务不显示"Connected"。先保证有一个会注册工具的服务（mori_test）和一个命令写错的服务
 *        （mori_broken）：pi 在全部启用的服务连上或失败之后才发"MCP servers need attention"，等到它就知道 mori_empty
 *        也已经连完，看到的"This server has no tools in this session"不是还在连接。
 */
async function emptyMcp(ctx) {
  const { page } = ctx;
  const servers = () => readJson(join(ctx.agentDir, 'mcp.json'))?.mcpServers ?? {};
  if (!servers().mori_test) await addMcp(page, { name: 'mori_test', command: 'node', args: [MCP_SERVER] });
  if (!servers().mori_broken) await addMcp(page, { name: 'mori_broken', command: 'no-such-command-mori' });
  const added = await addMcp(page, { name: 'mori_empty', command: 'node', args: [MCP_SERVER],
    env: ['MORI_MCP_TOOLS=none'] });
  await savedNewSession(page);
  const settled = await pane(page).getByTestId('ext-notify').filter({ hasText: 'mori_broken' }).first()
    .waitFor({ timeout: 60000 }).then(() => true, () => false);
  const test = await mcpUntil(page, 'mori_test', (row) => row?.tools?.includes('mcp__mori_test__echo'));
  const info = await mcpInfo(page, 'mori_empty');
  const text = await page.getByTestId('tools-page').innerText();
  await backToChat(page);
  const chat = await page.locator('body').innerText();
  await openToolsSection(page, 'mcp');
  await shot(page, 'c-mcp-empty');
  record('反例：没有注册任何工具的 MCP 服务：全部服务连完之后（mori_test 有工具、mori_broken 报错），这一行写"当前会话里它没有注册工具"，'
    + '没有错误；工具页和会话页上都没有"已连接"', added.saved?.startsWith('Saved')
    && servers().mori_empty?.env?.MORI_MCP_TOOLS === 'none' && settled && test.tools?.includes('mcp__mori_test__echo')
    && info?.tools === 'This server has no tools in this session'
    && info.errors.length === 0 && !text.includes('Connected') && !chat.includes('Connected'),
  JSON.stringify({ saved: added.saved, settled, info, test: test?.tools ?? null }));
  await backToChat(page);
}

/** @brief 反例：没有信任的项目里的技能不出现在工具页里，也不在"/"列表里。 */
async function untrustedSkill(ctx) {
  const { page } = ctx;
  await openFolder(ctx, ctx.untrusted, 'Don’t trust');
  const slash = await openSlash(page, '/');
  await closeSlash(page);
  await openToolsSection(page, 'builtin');
  const builtin = await page.locator('[data-testid="tool-row"]').count();
  await openToolsSection(page, 'skills');
  const names = await page.locator('[data-testid="skill-row"]')
    .evaluateAll((rows) => rows.map((row) => row.dataset.name));
  const notice = await page.getByTestId('tools-trust').innerText().catch(() => null);
  const follow = await page.getByTestId('tools-follow').innerText();
  await shot(page, 'c-untrusted');
  record('反例：没有信任的项目：它 .pi/skills 里的 m6-untrusted-skill 不出现在工具页"技能"里（工具页读到了这个会话：内置工具有列出）；'
    + '顶部说明"没有信任这个文件夹，它自带的技能和配置不列出"', builtin > 0 && !names.includes(UNTRUSTED_SKILL)
    && notice === 'This workspace isn’t trusted, so its skills and settings aren’t listed'
    && follow.startsWith('m6-untrusted · '),
  JSON.stringify({ builtin, names, notice, follow }));
  record('反例：没有信任的项目里会话的"/"列表没有 /skill:m6-untrusted-skill', slashLacks(slash, `skill:${UNTRUSTED_SKILL}`),
    oneLine(slash.text, 200));
  await backToChat(page);
}

/** @brief 反例（不在走查 1–8 里的）：没有工具的 MCP 服务、不信任的项目的技能。 */
async function counterExamples(ctx) {
  await emptyMcp(ctx);
  await untrustedSkill(ctx);
}

// ---------- 内置工具的开关（2026-10-26，负责人走查 M12） ----------

/** @brief settings.json 去掉 defaultTools 之后的其余字段（看开关没有动别的字段）。 */
function otherSettings(value) {
  const { defaultTools: _tools, ...rest } = value ?? {};
  return JSON.stringify(rest);
}

/**
 * @brief 负责人走查 M12（docs/v0/screens/tools.md"内置工具"）：Customize → Built-in tools 里打开 ls：开关开着、这个会话里
 *        仍是"Not enabled"，复制出的 settings.json 的 defaultTools 有 "+ls"、别的字段不变；工具页的"New session"建的会话里
 *        ls 是"Enabled"，真实模型用 ls 列出项目文件：一张"List"卡、Done、没有批准卡（模型没有调用 ls 时记 KNOWN：模型行为）。
 *        最后把开关关回去，defaultTools 回到原样。
 */
async function itemToolSwitch(ctx) {
  const { page } = ctx;
  const file = join(ctx.agentDir, 'settings.json');
  const before = readJson(file);
  await openToolsSection(page, 'builtin');
  const row = page.locator('[data-testid="tool-row"][data-tool="ls"]');
  const on = await flip(page, row, true);
  const state = await row.locator('.tools-state').innerText();
  const after = readJson(file);
  await shot(page, 't-ls-on');
  record('M12：内置工具里打开 ls：开关开着、这个会话里仍是"Not enabled"；settings.json 的 defaultTools 有 "+ls"，别的字段不变',
    on.settled && on.checked === 'true' && !on.error && state === 'Not enabled'
    && (after?.defaultTools ?? []).includes('+ls') && otherSettings(after) === otherSettings(before),
  JSON.stringify({ on, state, before: before?.defaultTools ?? null, after: after?.defaultTools ?? null }));
  await clickNewSession(page, toolsNewSession(page));
  const info = await toolInfo(page, 'ls');
  await backToChat(page);
  const turn = await sendTurn(page, PROMPTS.ls);
  const card = await lastToolCard(page);
  const listed = card?.title.startsWith('List') ?? false;
  record('M12：新会话的工具页里 ls 是"Enabled"', info?.active === 'true' && info.state === 'Enabled', JSON.stringify(info));
  record('M12：真实模型在新会话里用 ls 列出文件：一张"List"卡、Done，没有批准卡（模型没调用 ls 时记 KNOWN）',
    listed && card.status === 'done' && turn.cards.length === 0, JSON.stringify({ card, cards: turn.cards }), !listed);
  await shot(page, 't-ls-call');
  await openToolsSection(page, 'builtin');
  const off = await flip(page, row, false);
  await backToChat(page);
  record('M12：关回 ls 之后 settings.json 的 defaultTools 回到原样', off.settled
    && JSON.stringify(readJson(file)?.defaultTools ?? null) === JSON.stringify(before?.defaultTools ?? null),
  JSON.stringify(readJson(file)?.defaultTools ?? null));
}

// ---------- 执行 ----------

/**
 * @brief 走查数据目录里首选提供商（DeepSeek）的非机密信息（v1：model-config.json，lib.mjs realProviders）；没有时在复制密文
 *        之前就失败。
 */
function readConnection(dir) {
  const [first] = realProviders(dir);
  return { provider: first.provider, name: first.name, model: first.model };
}

/** @brief 删掉临时目录；MCP 服务刚退出时文件夹可能还占着，多试几次。 */
function remove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.error(`cannot remove ${dir}: ${oneLine(error)}`);
  }
}

const conn = readConnection(source);
const root = mkdtempSync(join(tmpdir(), 'mori-m6-real-'));
const ctx = { conn, root, project: makeProject(root, 'm6-walk', PROJECT_SKILL),
  untrusted: makeProject(root, 'm6-untrusted', UNTRUSTED_SKILL), pageErrors: [], skillDisabled: false };
ctx.agentsFiles = projectAgentsFiles(ctx.project);
ctx.userData = scratchUserData(source);
// 测试准备（synthetic test setup，§14.1）：默认范围设为 [DeepSeek, GLM] 的分组
ctx.providers = useRealGroup(ctx.userData);
ctx.agentDir = join(ctx.userData, 'pi');
try {
  await start(ctx);
  await openFolder(ctx, ctx.project, 'Trust workspace');
  const items = { 1: item1, 2: item2, 3: item3, 4: item4, 5: item5, 6: item6, 7: item7, 8: item8, c: counterExamples,
    t: itemToolSwitch };
  for (const [item, fn] of Object.entries(items)) {
    if (!wanted(item)) continue;
    try {
      await fn(ctx);
    } catch (error) {
      record(`${{ c: '反例', t: 'M12' }[item] ?? `走查 ${item}`}：流程`, false, oneLine(error, 400));
      await shot(ctx.page, `${item}-error`);
      await recover(ctx.page);
    }
  }
} catch (error) {
  record('启动并打开测试项目', false, oneLine(error, 400));
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  remove(ctx.userData);
  remove(root);
}
process.exitCode = write(`m6-real${suffix}.json`) ? 0 : 1;
