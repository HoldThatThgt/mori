// M6 整机测试（"/"补全与布局）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖 docs/v0/screens/slash.md（方案第 7 节 M6 走查 7）和 M6 的布局限制（models.md、split.md、layout.md、defaults.md）：
// 打出 "/" 的读取中（只有一行"Loading…"）、列表（两组各列各的项、只有第一项高亮、/名字、argument-hint、说明、浮在输入框上方
// 且在最上层）、筛选（先开头再包含、不分大小写）、↑ ↓ 首尾循环、Enter / Tab 插入高亮项、点一项插入且不发送、插入时保留后面的字、
// 没有匹配（继续打字、Esc；没有可选的项时 Enter 照常发送，在新建的会话里发、不动会话 A 的名字）、光标在第一个空白之后关闭、
// 输入法组字中 Enter 不插入也不关列表；
// 生成中：Esc 只关列表不停止生成、列表开着时有项 Enter 插入（不排队）、没有可选的项时 Enter 照常排队、排队的技能命令写回
// "/skill:名字 参数"；发出技能命令（气泡"Skill · 名字"+参数、展开 / 收起、侧栏和标题行的会话名、模型收到展开后的 <skill> 块）
// 与提示词模板（气泡是展开后的全文）；会话没有任何模板和技能（Enter 照常发送）、只列这个会话加载了的（启用的、信任的项目里的）、
// 关闭 enableSkillCommands 时不列技能、读取失败显示原文（synthetic 做法：在后台进程里关掉会话而界面不知道）、
// 后台进程退出 / 重新载入中 / 会话重新打开中不出列表，就绪后照常出列表；
// 布局（2026-10-21 起选择范围（v1）、Effort、权限按钮和上下文用量圆环在输入框下面一行，顶栏只剩"项目名 › 会话名"、协作开关和
// 这一栏的按钮，docs/v0/composer-pickers.md；chat.md"顶栏""输入框下面一行"、models.md"窄栏"）：1280 宽单栏、1400 宽右栏开
// （面板约 690px）、800×600 打开右栏（约 300px）、1280 和 1200 宽分屏（右栏关 / 开，最窄 280px）、800×600 分屏；各档的
// 上沿和下沿（分屏时拖中线凑出 279–681px，单栏 930 / 761 / 740 / 490 / 300px），生成中有字、生成中、空闲、拒绝启动
// （no_pick）、后台进程退出、重新载入中、Restart 之后重新打开中、第一次打开中、打开失败：顶栏不溢出不裁切、会话名有地方
// （截断时项目名已收到 40px、占满剩下的地方）；这一行不换行、高 33px、不超出输入框，各档该收的收起，截短按"不能发送的说明
// → 选择范围（先模型 id、再范围名）→ 模式名 → Effort 的强度"的先后（比元素宽度和全文的宽，不比字面），最挤时三个按钮不窄于
// 最窄；悬停按行、读屏的描述（aria-describedby）、不可用读 aria-disabled（composer-pickers.md"测试要改的地方"C1、C2）；
// 菜单、圆环详情和"Queue"的下拉往上打开、在这一栏和窗口里、按 models.md 对齐，280px 时范围菜单收到这一行的宽；
// ≤ 400px 时用键盘走"More send options"排队；"Medium""High""Allow all"各走一次 280px（"Allow all"对比度 ≥ 4.5:1）；
// 拒绝启动卡的"Change model…"打开这一行的范围菜单；F8 的"Pane width""Model range""Effort"；聊天页没有小于 12px 的字；
// 从新会话的文字框 Tab 依次到权限 → 范围 → Effort → 圆环，Shift+Tab 回到会话树的次数（应为 6 次：M6 是 8 次，
// TaskBoard 加了协作开关是 9 次，权限、思考强度、模型三个按钮移到文字框后面）。
// 与原设计不同（v1 做不到，按最接近的做）：思考强度"Extra high"在 v1 里没有途径打开（v1 的模型配置不写 thinkingLevelMap，
// pi 的 getSupportedThinkingLevels 只给 off–high），所以 280px 的这一项改用"High"；"Unavailable"仍是最宽的写法、各档都走。
// 为了最挤的情况，布局检查前把会话 A、C 的范围换成提供商（按钮"Mori endpoint · <很长的模型 id>"）。
// 用户级的提示词模板和技能是本测试在启动前写进 <agentDir>/prompts、<agentDir>/skills 的（synthetic），
// 项目级的写在第二个测试项目的 .pi/ 里（synthetic）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-slash.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m6-app-slash(-packaged).json，截图在 test-results/m6-app-slash(-packaged)/。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, sleep } from './lib.mjs';
import { smallText } from './m1-layout.mjs';
import {
  activeFile, ctrlN, focusInfo, kernelOpen, lastReply, openRow, rowOf, samePath, settle, startRename, STOPPED,
  waitComposerFocus, waitIdle, waitRowTitle, waitRunning,
} from './m3-helpers.mjs';
import { composerAt, sendAt, splitState, waitPaneReady, waitSplit } from './m5-helpers.mjs';
import {
  at1, backToApp, bandKey, buttonState, choosePick, colorStack, contrastOf, firstRunAndOpen, fitLeft, fitPane, KINDS,
  layoutBrief, layoutReport, NOTE, openAndPlace, openProject, openSettingsSection, paneProblems, paneWidths,
  placeProblems, popupBox, popupGone, POPUPS, RANGE_MAX, resizeWindow, ringState, ROW, rowControls, seenRows,
  setDefaultPick, setReasoning, splitOpen, startFakeEndpoint, watchRows,
} from './m6-helpers.mjs';
import { pageHelpers } from './page.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const port = 4363;
const baseUrl = `http://127.0.0.1:${port}/v1`;
// 合成端点要求的 key：只是测试值，与任何真实服务无关。
const testKey = 'synthetic-test-key-m6-slash-not-a-real-key';
const shots = join(appRoot, `test-results/m6-app-slash${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 焦点所在的一栏（单栏时也带 data-focused） */
const FOCUSED = '.pane-slot[data-focused="true"]:not([hidden])';
/** 技能正文里的标记：只出现在 SKILL.md 里，模型回显时能看到它说明收到了展开后的正文 */
const SKILL_MARKER = 'SKILL-BODY-MARKER-M6';
/** 提示词模板展开后的全文（"/review x"） */
const TEMPLATE_TEXT = 'plain review template for x (synthetic M6-TEMPLATE-MARKER)';
/** 会话没有任何模板和技能时的说明 */
const EMPTY_NOTE = 'This session has no prompt templates or skills. Add them in Customize.';
/** 过滤后为空时的说明 */
const NO_MATCH = 'No matching prompt templates or skills';
/** 技能命令发出的文字与会话名（正好 20 个字，不截断） */
const SKILL_COMMAND = '/skill:fmt echo back';
/** 生成中的检查用的一轮的长度（秒）：Esc、Enter、排队都要在它结束前做完 */
const WAIT_SECONDS = 6;
/** 生成中排队的技能命令（参数里的 plain 让合成端点只回文字） */
const QUEUED_SKILL = '/skill:fmt plain queued';
/** 提供商里的模型 ID：故意很长（合成端点接受任何 ID），宽栏时范围按钮停在最长 200px，窄栏时收短（models.md"窄栏"） */
const MODEL_ID = 'fake-coder-synthetic-long-model-id-for-layout';
/** 列表里没有匹配的项、按 Enter 照常发出的消息（像一个不在列表里的扩展命令；plain 让合成端点只回文字） */
const NO_MATCH_SEND = '/zzz-plain';
/** 布局检查用的会话 C 的第一条消息（会话名取前 20 个字，足够长，窄栏时会被挤到省略号） */
const LONG_NAME_MESSAGE = 'plain long session name for the narrow layout checks';

/**
 * 写进 <agentDir> 的用户级模板和技能（synthetic）：名字安排成筛选 "rev" 时 review（开头）排在 a-review（包含）前面；
 * 正文不含合成端点的其他规则词（plain 只在模板里，让端点只回文字）。
 */
const COMMANDS = [
  { name: 'a-review', kind: 'prompt', hint: null, description: '合成模板：名字里含 review（synthetic）' },
  { name: 'review', kind: 'prompt', hint: '<文件>', description: '合成模板：审阅一个文件（synthetic）' },
  { name: 'skill:fmt', kind: 'skill', hint: null, description: '合成技能：检查格式（synthetic）' },
  { name: 'skill:review-notes', kind: 'skill', hint: null, description: '合成技能：整理审阅意见（synthetic）' },
];
/** 第二个测试项目 .pi/ 里的模板和技能（synthetic）：pi 要先信任这个文件夹才加载它们 */
const PROJECT_COMMANDS = [
  { name: 'proj-tmpl', kind: 'prompt', hint: null, description: '合成项目模板（synthetic）' },
  { name: 'skill:proj-skill', kind: 'skill', hint: null, description: '合成项目技能（synthetic）' },
];
/** 名字排好序连起来（比较"同一组名字"用） */
const sortedNames = (list) => [...list].sort().join();
/** 用户级的四项（排好序） */
const USER_NAMES = sortedNames(COMMANDS.map((command) => command.name));

// ---------- 准备 ----------

/** @brief 在 agentDir 里写两个用户级提示词模板和两个用户级技能（synthetic）。 */
function writeUserCommands(agentDir) {
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  writeFileSync(join(agentDir, 'prompts', 'a-review.md'), `---\ndescription: "${COMMANDS[0].description}"\n---\n`
    + 'plain a-review template: $@ (synthetic)\n');
  writeFileSync(join(agentDir, 'prompts', 'review.md'), `---\ndescription: "${COMMANDS[1].description}"\n`
    + `argument-hint: "${COMMANDS[1].hint}"\n---\n${TEMPLATE_TEXT.replace(' x ', ' $1 ')}\n`);
  const skill = (name, description, body) => {
    mkdirSync(join(agentDir, 'skills', name), { recursive: true });
    writeFileSync(join(agentDir, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "${description}"\n---\n${body}\n`);
  };
  skill('fmt', COMMANDS[2].description, `# Format check (synthetic)\n\n${SKILL_MARKER}: answer in one line.`);
  skill('review-notes', COMMANDS[3].description, '# Review notes (synthetic)\n\nCollect the notes in a list.');
}

/** @brief 带 .pi 资源的测试项目：.pi/prompts 里一个模板、.pi/skills 里一个技能（synthetic）。 */
function makeTrustProject(root, name) {
  const project = join(root, name);
  const skillDir = join(project, '.pi', 'skills', 'proj-skill');
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(join(project, '.pi', 'prompts'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Trust fixture project\n');
  writeFileSync(join(project, '.pi', 'prompts', 'proj-tmpl.md'),
    `---\ndescription: "${PROJECT_COMMANDS[0].description}"\n---\nplain project template (synthetic)\n`);
  writeFileSync(join(skillDir, 'SKILL.md'),
    `---\nname: proj-skill\ndescription: "${PROJECT_COMMANDS[1].description}"\n---\n# Project skill (synthetic)\n`);
  return project;
}

/**
 * @brief 测试用的项目：README 和一个源文件；另有两个带同样 .pi 资源的项目（界面在本次运行里记住每个文件夹的回答、
 *        不再问，所以"Don’t trust"和"Trust workspace"各用一个文件夹）。
 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-slash-'));
  const project = join(root, 'm6slash');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used by the M6 slash test.\n');
  writeFileSync(join(project, 'src', 'a.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  return { root, project, untrusty: makeTrustProject(root, 'untrusty'), trusty: makeTrustProject(root, 'trusty') };
}

/** @brief 用 ctx.userData 启动 Mori，记下页面报错。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  ctx.h = pageHelpers(ctx.page);
}

// ---------- 等待 ----------

/** @brief 等 promise：完成为 true，超时为 false；超时以外的错误照常抛出（不吞掉）。 */
async function settled(promise) {
  try {
    await promise;
    return true;
  } catch (error) {
    if (error?.name === 'TimeoutError') return false;
    throw error;
  }
}

/** @brief 在 ms 毫秒内条件一直不成立时为 true（一成立就返回 false）：用于"不发送""不出列表"这类否定的检查。 */
async function neverWithin(page, fn, argument, ms) {
  return !(await settled(page.waitForFunction(fn, argument, { timeout: ms })));
}

/** @brief 焦点所在的一栏在 ms 毫秒内没有发出消息：没有进入发送中 / 生成中，你的消息条数也没有变多。 */
function staysUnsent(page, before, ms = 500) {
  return neverWithin(page, ({ focused, count }) => {
    const pane = document.querySelector(`${focused} [data-testid="chat-pane"]`);
    const sent = pane?.querySelectorAll('[data-testid="user-message"], [data-testid="skill-invocation"]').length ?? 0;
    return pane?.dataset.sending === 'true' || pane?.dataset.running === 'true' || sent > count;
  }, { focused: FOCUSED, count: before }, ms);
}

/** @brief 焦点所在的一栏排队区里每一条的文字（没有排队区时为空数组）。 */
const queueTexts = (page) => page.locator(`${FOCUSED} [data-testid="queue"] .queue-text`).allInnerTexts();

/** @brief 等焦点所在的一栏排队区里出现 text 这一条（最多 timeout 毫秒），返回此刻排队区每一条的文字。 */
async function waitQueued(page, text, timeout = 5000) {
  await settled(page.waitForFunction(({ focused, want }) => [...document
    .querySelectorAll(`${focused} [data-testid="queue"] .queue-text`)].some((item) => item.textContent === want),
  { focused: FOCUSED, want: text }, { timeout }));
  return queueTexts(page);
}

/** @brief 焦点所在的一栏在 ms 毫秒内排队区的条数一直不多于 count（没有排进新的一条）。 */
const queueStays = (page, count, ms = 400) => neverWithin(page, ({ focused, most }) => document
  .querySelectorAll(`${focused} [data-testid="queue"] .queue-text`).length > most,
{ focused: FOCUSED, most: count }, ms);

/** @brief 改窗口内容区的大小，等界面量到新的大小、再等两帧。 */
async function resizeTo(ctx, width, height) {
  await resizeWindow(ctx.app, width, height);
  await ctx.page.waitForFunction(({ w, h }) => innerWidth === w && innerHeight === h, { w: width, h: height },
    { timeout: 5000 });
  await settle(ctx.page);
}

// ---------- 页面上的小工具 ----------

/** @brief 焦点所在的一栏的输入框。 */
const composer = (page) => page.locator(`${FOCUSED} .composer textarea`);

/** @brief "/"补全列表与输入框此刻的样子；members 是每一组里的项名。 */
function slashView(page) {
  return page.evaluate((focused) => {
    const textarea = document.querySelector(`${focused} .composer textarea`);
    const menu = document.querySelector('[data-testid="slash-menu"]');
    const options = menu ? [...menu.querySelectorAll('[role="option"]')] : [];
    const groups = menu ? [...menu.querySelectorAll('[role="group"]')] : [];
    const note = menu?.querySelector('.slash-note');
    return { open: Boolean(menu), role: menu?.getAttribute('role') ?? null,
      groups: groups.map((group) => group.getAttribute('aria-label')),
      members: groups.map((group) => [...group.querySelectorAll('[role="option"]')].map((item) => item.dataset.name)),
      labels: menu ? [...menu.querySelectorAll('.slash-group-label')].map((label) => label.textContent) : [],
      items: options.map((option) => ({ name: option.dataset.name, kind: option.dataset.kind, id: option.id,
        selected: option.getAttribute('aria-selected') === 'true',
        label: option.querySelector('.slash-name')?.textContent ?? '',
        hint: option.querySelector('.slash-hint')?.textContent ?? null,
        description: option.querySelector('.slash-description')?.textContent ?? null })),
      selectedCount: options.filter((option) => option.getAttribute('aria-selected') === 'true').length,
      note: note?.textContent ?? null, noteRole: note?.getAttribute('role') ?? null,
      activeId: textarea?.getAttribute('aria-activedescendant') ?? null,
      draft: textarea?.value ?? null, caret: textarea?.selectionStart ?? null,
      focused: Boolean(textarea) && document.activeElement === textarea };
  }, FOCUSED);
}

/** @brief 高亮项的位置（没有时为 -1）。 */
const selectedIndex = (view) => view.items.findIndex((item) => item.selected);
/** @brief 高亮项的名字。 */
const selectedName = (view) => view.items[selectedIndex(view)]?.name ?? null;
/** @brief 列表里的名字（按显示顺序）。 */
const names = (view) => view.items.map((item) => item.name);
/** @brief 列表与输入框的主要字段（记进检查的说明）。 */
const brief = (view) => JSON.stringify({ open: view.open, names: names(view), selected: selectedName(view),
  note: view.note, draft: view.draft, caret: view.caret, focused: view.focused });

/** @brief 等列表出现并读完（不再是"Loading…"）。 */
function waitMenu(page, timeout = 10000) {
  return page.waitForFunction(() => {
    const menu = document.querySelector('[data-testid="slash-menu"]');
    return Boolean(menu) && !menu.textContent.includes('Loading…');
  }, null, { timeout });
}

/** @brief 列表在 timeout 毫秒内出现并读完时为 true。 */
const menuShown = (page, timeout = 5000) => settled(waitMenu(page, timeout));

/** @brief 清空焦点所在一栏的输入框，焦点放进去，再一个键一个键地打 text。 */
async function typeFresh(page, text) {
  const input = composer(page);
  await input.click();
  await input.fill('');
  if (text) await page.keyboard.type(text);
  await settle(page);
}

/** @brief 按一个键，等两帧后读列表。 */
async function pressAndView(page, key) {
  await page.keyboard.press(key);
  await settle(page);
  return slashView(page);
}

/** @brief 焦点所在的一栏里你的消息（普通气泡和技能调用）的条数。 */
const sentCount = (page) => page.locator(`${FOCUSED} [data-testid="user-message"], `
  + `${FOCUSED} [data-testid="skill-invocation"]`).count();

/** @brief 焦点所在的一栏是否在生成 / 发送中。 */
const paneBusy = (page) => page.evaluate((css) => {
  const pane = document.querySelector(`${css} [data-testid="chat-pane"]`);
  return { running: pane?.dataset.running === 'true', sending: pane?.dataset.sending === 'true' };
}, FOCUSED);

/**
 * @brief 用 MutationObserver 记下列表第一次出现"Loading…"时的样子（只持续一次往返，轮询抓不到）：
 *        列表的文字、项数、role=status 的文字、这时的草稿。读完用 loadingSeen 取回并停止观察。
 */
function watchLoading(page) {
  return page.evaluate((focused) => {
    window.__slashLoading = null;
    window.__slashObserver?.disconnect();
    window.__slashObserver = new MutationObserver(() => {
      const menu = document.querySelector('[data-testid="slash-menu"]');
      if (window.__slashLoading || !menu?.textContent?.includes('Loading…')) return;
      window.__slashLoading = { text: menu.innerText.trim(), options: menu.querySelectorAll('[role="option"]').length,
        status: menu.querySelector('[role="status"]')?.textContent ?? null,
        draft: document.querySelector(`${focused} .composer textarea`)?.value ?? null };
    });
    window.__slashObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  }, FOCUSED);
}

/** @brief 取回 watchLoading 记下的样子，停止观察。 */
const loadingSeen = (page) => page.evaluate(() => {
  window.__slashObserver?.disconnect();
  return window.__slashLoading;
});

/**
 * @brief 列表与输入框的位置：列表在输入框上方、与输入框同宽、在窗口里、没有横向溢出；
 *        onTop：第一项中间那一点上最上层的元素是列表自己（没有被别的东西盖住或裁掉）。
 */
function menuGeometry(page) {
  return page.evaluate((focused) => {
    const element = document.querySelector('[data-testid="slash-menu"]');
    const menu = element?.getBoundingClientRect();
    const box = document.querySelector(`${focused} .composer`)?.getBoundingClientRect();
    const textarea = document.querySelector(`${focused} .composer textarea`)?.getBoundingClientRect();
    if (!menu || !box || !textarea) return null;
    const probe = (element.querySelector('[role="option"]') ?? element).getBoundingClientRect();
    const hit = document.elementFromPoint(probe.left + probe.width / 2, probe.top + probe.height / 2);
    const round = (rect) => ({ left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top),
      bottom: Math.round(rect.bottom) });
    return { menu: round(menu), composer: round(box), window: { width: innerWidth, height: innerHeight },
      above: menu.bottom <= textarea.top + 1, sameWidth: Math.abs(menu.left - box.left) <= 1
        && Math.abs(menu.right - box.right) <= 1,
      inWindow: menu.top >= 0 && menu.left >= 0 && menu.right <= innerWidth + 1,
      noOverflow: element.scrollWidth <= element.clientWidth + 1, onTop: Boolean(hit && element.contains(hit)) };
  }, FOCUSED);
}

/** @brief 记下此刻聊天页里小于 12px 的字（最后统一判断）。 */
async function noteSmall(ctx, where) {
  const small = await smallText(ctx.page);
  ctx.small.push(...small.map((item) => `${where}: ${item}`));
  ctx.smallChecked.push(where);
}

/** @brief 会话文件里全部助手回复的文字（模型原样回的字，不经界面渲染）。 */
function assistantTexts(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((entry) => entry?.message?.role === 'assistant').map((entry) => {
    const content = entry.message.content;
    return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
  });
}

/** @brief 在 pi 的用户设置里临时加上 patch，执行 body，之后把设置文件恢复原样。 */
async function withSettings(ctx, patch, body) {
  const file = join(ctx.userData, 'pi', 'settings.json');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(original ?? '{}'), ...patch }, null, 2)}\n`);
  try {
    await body();
  } finally {
    writeFileSync(file, original ?? '{}\n');
  }
}

// ---------- 步骤：列表 ----------

/** @brief 准备：写模板和技能、首次启动填连接、打开项目（会话 A，还没有消息），窗口 1280×800。 */
async function setup(ctx) {
  await resizeWindow(ctx.app, 1280, 800);
  await firstRunAndOpen(ctx, { baseUrl, apiKey: testKey, modelId: MODEL_ID, project: ctx.project });
  ctx.a = await activeFile(ctx.page);
  record('准备：首次启动、打开项目，会话 A 就绪（用户级两个模板、两个技能在启动前写好）', Boolean(ctx.a), ctx.a ?? '');
}

/** @brief 走查 7：输入 "/"：先只有"Loading…"，再列出两组，每组只有自己的项；只有第一项高亮。 */
async function menuList(ctx) {
  const { page } = ctx;
  await watchLoading(page);
  await typeFresh(page, '/');
  await waitMenu(page);
  const view = await slashView(page);
  const loading = await loadingSeen(page);
  record('读取中：刚打出 "/"、结果还没回来时，列表里只有一行"正在读取…"（role=status，没有项）',
    loading?.text === 'Loading…' && loading.status === 'Loading…' && loading.options === 0, JSON.stringify(loading));
  const ofKind = (kind) => sortedNames(COMMANDS.filter((command) => command.kind === kind).map((c) => c.name));
  record('走查 7：输入 "/"：列表（role=listbox）分"提示词模板""技能"两组，模板组在前；模板组里是两个模板（a-review、review），'
    + '技能组里是两个技能命令（skill:fmt、skill:review-notes），data-kind 对得上', view.role === 'listbox'
    && view.groups.join() === 'Prompt templates,Skills' && view.labels.join() === 'Prompt templates,Skills'
    && sortedNames(view.members[0] ?? []) === ofKind('prompt') && sortedNames(view.members[1] ?? []) === ofKind('skill')
    && view.items.every((item) => item.kind === COMMANDS.find((c) => c.name === item.name)?.kind),
  JSON.stringify({ groups: view.groups, members: view.members }));
  const first = view.items[0];
  record('只有第一项高亮（aria-selected），输入框的 aria-activedescendant 指向它；焦点留在输入框', selectedIndex(view) === 0
    && view.selectedCount === 1 && view.activeId === first?.id && view.focused, JSON.stringify({
    selected: selectedIndex(view), count: view.selectedCount, id: first?.id, active: view.activeId,
    focused: view.focused }));
  await menuItemsShown(ctx, view);
}

/** @brief 接着 menuList：每项的 /名字、argument-hint、说明；列表的位置。 */
async function menuItemsShown(ctx, view) {
  const { page } = ctx;
  const shown = view.items.length === COMMANDS.length && view.items.every((item) => {
    const want = COMMANDS.find((c) => c.name === item.name);
    return want && item.label === `/${want.name}` && item.hint === want.hint && item.description === want.description;
  });
  record('每项显示 /名字、argument-hint（只有 review 有"<文件>"）和说明', shown, JSON.stringify(view.items));
  const geometry = await menuGeometry(page);
  record('列表浮在输入框上方、与输入框同宽、在窗口里，在最上层（第一项上没有别的东西盖住）',
    Boolean(geometry?.above && geometry.sameWidth && geometry.inWindow && geometry.onTop), JSON.stringify(geometry));
  await shot(page, '7-slash-list');
}

/** @brief ↑ ↓ 移动高亮、首尾循环；输入框的字不变。接着 menuList（列表开着，草稿是 "/"）。 */
async function menuArrows(ctx) {
  const { page } = ctx;
  const count = (await slashView(page)).items.length;
  const up = await pressAndView(page, 'ArrowUp');
  const wrapped = await pressAndView(page, 'ArrowDown');
  const next = await pressAndView(page, 'ArrowDown');
  const steps = [up, wrapped, next].map((view) => ({ index: selectedIndex(view), only: view.selectedCount === 1,
    follows: view.activeId === view.items[selectedIndex(view)]?.id, draft: view.draft }));
  record('↑ ↓ 首尾循环：第一项按 ↑ 到最后一项，再按 ↓ 回到第一项，再按 ↓ 到第二项；始终只有一项高亮，'
    + 'aria-activedescendant 跟着走；输入框仍是 "/"', count === 4 && steps[0].index === count - 1
    && steps[1].index === 0 && steps[2].index === 1 && steps.every((step) => step.only && step.follows
    && step.draft === '/'), JSON.stringify(steps));
}

/** @brief 筛选：名字以筛选词开头的在前、包含它的在后，不分大小写；筛选词变了高亮回到第一项。接着 menuArrows。 */
async function menuFilter(ctx) {
  const { page } = ctx;
  const moved = selectedIndex(await slashView(page));
  await page.keyboard.type('rev');
  await waitMenu(page);
  const lower = await slashView(page);
  await composer(page).press('Control+a');
  await page.keyboard.type('/ReV');
  await waitMenu(page);
  const mixed = await slashView(page);
  const want = 'review,a-review,skill:review-notes';
  record('筛选 "rev"：review（开头）排在 a-review（包含）前面，技能组只剩 skill:review-notes；高亮从第二项回到第一项',
    names(lower).join() === want && moved === 1 && selectedIndex(lower) === 0
    && lower.groups.join() === 'Prompt templates,Skills',
    JSON.stringify({ before: moved, names: names(lower), selected: selectedIndex(lower) }));
  record('筛选不分大小写（"/ReV" 与 "/rev" 相同）', names(mixed).join() === want && selectedIndex(mixed) === 0,
    JSON.stringify(names(mixed)));
  await shot(page, '7-slash-filter');
}

/** @brief Enter 插入的是高亮项：筛选 "rev" 后 ↓ 到 a-review 再 Enter："/a-review "（光标在末尾），列表关闭，不发送。 */
async function insertEnter(ctx) {
  const { page } = ctx;
  await typeFresh(page, '/rev');
  await waitMenu(page);
  const before = await sentCount(page);
  const moved = await pressAndView(page, 'ArrowDown');
  const view = await pressAndView(page, 'Enter');
  const unsent = await staysUnsent(page, before);
  record('Enter 插入高亮项：↓ 高亮 a-review 后按 Enter，输入框换成 "/a-review "（带一个空格），光标在末尾，列表关闭，'
    + '焦点在输入框；没有发送', selectedName(moved) === 'a-review' && view.draft === '/a-review '
    && view.caret === view.draft.length && !view.open && view.focused && unsent,
  `${brief(view)} highlighted=${selectedName(moved)} unsent=${unsent}`);
}

/** @brief Tab 插入高亮项（焦点不离开输入框）；点一项插入。 */
async function insertTabClick(ctx) {
  const { page } = ctx;
  await typeFresh(page, '/fm');
  await waitMenu(page);
  const listed = await slashView(page);
  const tab = await pressAndView(page, 'Tab');
  record('筛选 "fm" 只剩 skill:fmt（包含）；Tab 插入 "/skill:fmt "，光标在末尾，列表关闭，焦点仍在输入框（Tab 没有移走焦点）',
    names(listed).join() === 'skill:fmt' && tab.draft === '/skill:fmt ' && tab.caret === tab.draft.length && !tab.open
    && tab.focused, `listed=${names(listed)} ${brief(tab)}`);
  await typeFresh(page, '/');
  await waitMenu(page);
  const last = await pressAndView(page, 'ArrowUp');
  const tabLast = await pressAndView(page, 'Tab');
  record('Tab 插入的是高亮项：↑ 高亮最后一项 skill:review-notes 后按 Tab，输入框是 "/skill:review-notes "，焦点仍在输入框',
    selectedName(last) === 'skill:review-notes' && tabLast.draft === '/skill:review-notes ' && !tabLast.open
    && tabLast.focused, `highlighted=${selectedName(last)} ${brief(tabLast)}`);
  await typeFresh(page, '/');
  await waitMenu(page);
  const before = await sentCount(page);
  await page.locator('[data-testid="slash-menu"] [role="option"][data-name="review"]').click();
  await settle(page);
  const click = await slashView(page);
  const unsent = await staysUnsent(page, before);
  record('点一项插入：点第二项 review，输入框是 "/review "，光标在末尾，列表关闭，焦点仍在输入框，没有发送',
    click.draft === '/review ' && click.caret === click.draft.length && !click.open && click.focused && unsent,
    `${brief(click)} unsent=${unsent}`);
}

/** @brief 光标移回第一个词（Home）时列表出现；插入只换掉第一个词，后面原有的字保留。 */
async function insertKeepsRest(ctx) {
  const { page } = ctx;
  await typeFresh(page, '');
  await composer(page).fill('/re tail words');
  await settle(page);
  const closed = await slashView(page);
  await page.keyboard.press('Home');
  const reopened = await menuShown(page);
  const first = names(await slashView(page))[0];
  const kept = await pressAndView(page, 'Enter');
  record('光标移回第一个词（Home）时列表出现；Enter 只换掉第一个词："/review tail words"，光标在末尾，没有发送',
    !closed.open && reopened && first === 'review' && kept.draft === '/review tail words'
    && kept.caret === kept.draft.length && !kept.open && await staysUnsent(page, 0),
    JSON.stringify({ closed: closed.open, reopened, first, draft: kept.draft, caret: kept.caret }));
}

/**
 * @brief 没有匹配："No matching prompt templates or skills"；继续打字；Esc 关闭列表、字还在（会话 A 里，不按 Enter：
 *        没有可选的项时 Enter 照常发送，发出的消息会成为会话 A 的名字，见 noMatchSends）。
 */
async function noMatch(ctx) {
  const { page } = ctx;
  await typeFresh(page, '/zzz');
  await waitMenu(page);
  const view = await slashView(page);
  await noteSmall(ctx, '"/"没有匹配');
  await shot(page, '7-slash-nomatch');
  for (let count = 0; count < 3; count += 1) await page.keyboard.press('Backspace');
  await settle(page);
  const back = await slashView(page);
  await page.keyboard.type('zzz');
  await settle(page);
  const again = await slashView(page);
  const esc = await pressAndView(page, 'Escape');
  const unsent = await staysUnsent(page, 0);
  record('没有匹配：列表里"没有匹配的提示词模板或技能"，没有项', view.open && view.note === NO_MATCH
    && view.items.length === 0, brief(view));
  record('没有匹配时继续打字：删掉 "zzz" 又列出全部四项，再打 "zzz" 又是没有匹配', back.open && back.draft === '/'
    && sortedNames(names(back)) === USER_NAMES && again.note === NO_MATCH, `${brief(back)} → ${brief(again)}`);
  record('Esc 关闭列表，输入框的字还在、焦点还在，没有发出消息', !esc.open && esc.draft === '/zzz' && esc.focused && unsent,
    `${brief(esc)} unsent=${unsent}`);
  await typeFresh(page, '');
}

/**
 * @brief 输入框里打 text（列表出现，没有可选的项）后按 Enter，等这一轮结束。返回按之前的列表、发出的你的消息
 *        （没有发出时为 null）和按之后的列表与输入框。
 */
async function enterSends(ctx, text) {
  const { page, h } = ctx;
  await typeFresh(page, text);
  await waitMenu(page);
  const listed = await slashView(page);
  const bubbles = page.locator(`${FOCUSED} [data-testid="user-message"]`);
  const before = await bubbles.count();
  await page.keyboard.press('Enter');
  const sent = await settled(bubbles.nth(before).waitFor({ timeout: 10000 }));
  await settle(page);
  const after = await slashView(page);
  await h.idle(60000);
  return { listed, sent: sent ? (await bubbles.nth(before).innerText()).trim() : null, after };
}

/**
 * @brief 没有匹配时 Enter 照常发送（slash.md"没有匹配"：照 Claude 桌面版，不在列表里的扩展命令 /名字 直接发出）。
 *        在 Ctrl+N 新建的会话 N 里做：发出的消息成为 N 的名字，会话 A 仍没有消息（之后的会话名检查测的是技能命令）。
 */
async function noMatchSends(ctx) {
  const { page } = ctx;
  ctx.n = await ctrlN(page);
  const { listed, sent, after } = await enterSends(ctx, NO_MATCH_SEND);
  const title = await page.locator(`${FOCUSED} [data-testid="session-title"]`).innerText();
  record(`没有匹配时 Enter 照常发送：列表是"没有匹配…"，按 Enter 发出原样的 "${NO_MATCH_SEND}"（不当作命令展开），`
    + '列表关闭、输入框清空；它成为这个新会话的名字', listed.open && listed.note === NO_MATCH && listed.items.length === 0
    && sent === NO_MATCH_SEND && !after.open && after.draft === '' && title === NO_MATCH_SEND,
  `${brief(listed)} → sent=${sent} ${brief(after)} title=${title}`);
  await openRow(page, ctx.a);
  const inA = await sentCount(page);
  record('回到会话 A：它仍没有消息（"/"的检查都没有发出东西）', inA === 0, `messages in A: ${inA}`);
}

/**
 * @brief 读取中继续打字：后台进程的回答（一次往返）比下一次按键快，真按键赶不上"Loading…"，
 *        所以在列表刚显示"Loading…"的那一刻（MutationObserver 回调里，回答还没到）把输入框改成 text、发 input 事件，
 *        走的是与打字相同的 onChange。记下改字时列表是否仍是"Loading…"。
 */
function typeWhileLoading(page, text) {
  return page.evaluate(({ focused, value }) => {
    window.__typedWhileLoading = null;
    window.__typeObserver?.disconnect();
    window.__typeObserver = new MutationObserver(() => {
      const menu = document.querySelector('[data-testid="slash-menu"]');
      if (window.__typedWhileLoading || !menu?.textContent?.includes('Loading…')) return;
      const textarea = document.querySelector(`${focused} .composer textarea`);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      window.__typedWhileLoading = { loading: menu.textContent.includes('Loading…'), draft: textarea.value };
      window.__typeObserver.disconnect();
    });
    window.__typeObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  }, { focused: FOCUSED, value: text });
}

/** @brief 读取中继续打字；光标在第一个空白之后时关闭；输入框不以 / 开头时没有列表。 */
async function caretRule(ctx) {
  const { page } = ctx;
  await typeWhileLoading(page, '/rev');
  await typeFresh(page, '/');
  await waitMenu(page);
  const typed = await slashView(page);
  const during = await page.evaluate(() => window.__typedWhileLoading);
  record('读取中继续打字：列表还是"正在读取…"时把字改成 "/rev"，读完后按 "rev" 过滤（review、a-review、skill:review-notes）',
    during?.loading === true && during.draft === '/rev' && names(typed).join() === 'review,a-review,skill:review-notes'
    && typed.draft === '/rev' && selectedIndex(typed) === 0, `${brief(typed)} during=${JSON.stringify(during)}`);
  const space = (await pressAndView(page, 'Space')).open;
  await page.keyboard.type('x');
  await settle(page);
  const args = await slashView(page);
  await page.keyboard.press('Home');
  const home = await menuShown(page);
  const end = (await pressAndView(page, 'End')).open;
  await typeFresh(page, 'a /rev');
  const plain = (await slashView(page)).open;
  record('光标在第一个空白之后时关闭：打出 "/rev" 有列表，打了空格就关闭，接着写参数也不出；Home 回到第一个词里再出现、End 又关闭',
    typed.open && !space && !args.open && args.draft === '/rev x' && home && !end,
    JSON.stringify({ open: typed.open, space, args: args.open, home, end }));
  record('输入框不以 "/" 开头时没有列表（"a /rev"）', !plain, `open: ${plain}`);
}

/** @brief 记下此后输入框收到的 keydown（键名、isComposing），确认组字中的 Enter 真的送到了界面。 */
function watchKeys(page) {
  return page.evaluate(() => {
    window.__keys = [];
    if (window.__keysListening) return;
    window.__keysListening = true;
    const note = (event) => window.__keys.push({ key: event.key, composing: event.isComposing });
    document.addEventListener('keydown', note, { capture: true });
  });
}

/**
 * @brief 输入法组字中（CDP Input.imeSetComposition 开始组字、Input.insertText 上屏，同 m1-layout.mjs）：列表照常显示；
 *        这时按 Enter（真的输入法用这个 Enter 上屏，不产生换行，所以这里只发不带字符的 keydown / keyup，
 *        界面收到的是 isComposing 为真的 Enter）不插入、不发送、列表还在；上屏后 Enter 照常插入。
 */
async function imeComposition(ctx) {
  const { page } = ctx;
  await typeFresh(page, '/');
  await waitMenu(page);
  await watchKeys(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition', { text: 're', selectionStart: 2, selectionEnd: 2 });
    await settled(page.waitForFunction(() => document.querySelector('[data-testid="slash-menu"] [role="option"]')
      ?.dataset.name === 'review', null, { timeout: 5000 }));
    const composing = await slashView(page);
    const before = await sentCount(page);
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
    const unsent = await staysUnsent(page, before, 400);
    const during = await slashView(page);
    const keys = await page.evaluate(() => window.__keys);
    await cdp.send('Input.insertText', { text: 're' });
    await settle(page);
    const committed = await slashView(page);
    const after = await pressAndView(page, 'Enter');
    record('输入法组字中：列表照常显示（随组字的字过滤，第一项 review）', composing.open && composing.draft === '/re'
      && names(composing)[0] === 'review', brief(composing));
    record('输入法组字中按 Enter 只选词：界面收到 isComposing 的 Enter，不插入补全项、不发送，列表还在、字还是 "/re"',
      keys.some((key) => key.key === 'Enter' && key.composing) && during.open && during.draft === '/re' && unsent,
      `${brief(during)} keys=${JSON.stringify(keys)} unsent=${unsent}`);
    record('上屏后列表还在，Enter 照常插入 "/review "', committed.open && committed.draft === '/re'
      && after.draft === '/review ' && !after.open, `${brief(committed)} → ${brief(after)}`);
  } finally {
    await cdp.detach().catch(() => {});
  }
  await typeFresh(page, '');
}

// ---------- 步骤：发出之后 ----------

/** @brief 技能调用气泡此刻的样子。 */
const skillBubble = (locator) => locator.evaluate((element) => ({ skill: element.dataset.skill,
  label: element.querySelector('.skill-label')?.textContent ?? '',
  args: element.querySelector('.skill-args')?.textContent ?? '',
  toggle: element.querySelector('.skill-toggle')?.textContent ?? '',
  expanded: element.querySelector('.skill-toggle')?.getAttribute('aria-expanded') ?? null,
  location: element.querySelector('.skill-location')?.textContent ?? '',
  body: element.querySelector('.skill-body')?.textContent ?? null, text: element.textContent ?? '' }));

/** @brief 走查 7 后半：用列表选 skill:fmt、写参数 "echo back"、Enter 发出；气泡、展开 / 收起。 */
async function sendSkill(ctx) {
  const { page, h } = ctx;
  await typeFresh(page, '/fm');
  await waitMenu(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo back');
  await page.keyboard.press('Enter');
  await h.idle(60000);
  const bubble = page.locator(`${FOCUSED} [data-testid="skill-invocation"]`);
  const view = await skillBubble(bubble.first());
  record('发出技能命令后，你的消息是 skill-invocation 气泡：一行"技能 · fmt"和"展开"，下面是参数 "echo back"，不显示 <skill> 原文',
    await bubble.count() === 1 && view.skill === 'fmt' && view.label === 'Skill · fmt' && view.args === 'echo back'
    && view.toggle === 'Expand' && view.body === null && !view.text.includes('<skill')
    && !view.text.includes(SKILL_MARKER),
    JSON.stringify(view));
  await bubble.first().locator('.skill-toggle').click();
  const open = await skillBubble(bubble.first());
  const skillFile = join(ctx.userData, 'pi', 'skills', 'fmt', 'SKILL.md');
  record('点"展开"看技能正文：SKILL.md 的路径和正文（含 References are relative to 一行）；按钮变"收起"',
    open.expanded === 'true' && open.toggle === 'Collapse' && samePath(open.location, skillFile)
    && (open.body ?? '').includes(SKILL_MARKER) && (open.body ?? '').includes('References are relative to'),
    JSON.stringify(open));
  await shot(page, '7-skill-bubble');
  await bubble.first().locator('.skill-toggle').click();
  const closed = await skillBubble(bubble.first());
  await bubble.first().locator('.skill-toggle').click();
  record('再点"收起"：正文收起，按钮回到"展开"', closed.expanded === 'false' && closed.toggle === 'Expand'
    && closed.body === null, JSON.stringify({ ...closed, text: undefined }));
  await skillTitles(ctx);
}

/** @brief 技能调用的会话名（侧栏行、悬停、标题行）按 "/skill:fmt echo back" 算；模型收到展开后的 <skill> 块。 */
async function skillTitles(ctx) {
  const { page } = ctx;
  const row = rowOf(page, ctx.a).first();
  const titles = { row: await row.locator('.session-label').innerText(), tip: await row.getAttribute('title'),
    pane: await page.locator(`${FOCUSED} [data-testid="session-title"]`).innerText() };
  record(`会话名用 "${SKILL_COMMAND}" 算：侧栏的会话行、悬停提示和标题行都是它`, titles.row === SKILL_COMMAND
    && titles.tip === SKILL_COMMAND && titles.pane === SKILL_COMMAND, JSON.stringify(titles));
  const shown = await lastReply(page);
  const raw = assistantTexts(ctx.a).at(-1) ?? '';
  const head = /^收到的全文：\n\n<skill name="fmt" location="([^"]+)">\nReferences are relative to [^\n]+\.\n\n/;
  const block = new RegExp(`${head.source}([\\s\\S]*?)\\n</skill>\\n\\necho back$`).exec(raw.trim());
  record('模型收到的是展开后的文字：合成端点回显的全文以 <skill name="fmt" location="…SKILL.md"> 开头，含技能正文，'
    + '</skill> 后空一行接参数 "echo back"', Boolean(block) && raw.startsWith('收到的全文：')
    && block[2].includes(SKILL_MARKER) && block[1].toLowerCase().endsWith('skill.md')
    && shown.includes(SKILL_MARKER), oneLine(raw, 400));
}

/** @brief 提示词模板：列表选 review、写参数 x、Enter 发出；气泡里是展开后的全文（pi 不保留 "/review"）。 */
async function sendTemplate(ctx) {
  const { page, h } = ctx;
  await typeFresh(page, '/rev');
  await waitMenu(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  await page.keyboard.press('Enter');
  await h.idle(60000);
  const bubbles = await page.locator(`${FOCUSED} [data-testid="user-message"]`).allInnerTexts();
  const last = bubbles.at(-1)?.trim() ?? '';
  const raw = assistantTexts(ctx.a).at(-1) ?? '';
  record('发出提示词模板 "/review x"：气泡里是展开后的全文（参数代入 $1），不是 "/review x"', last === TEMPLATE_TEXT
    && !bubbles.some((text) => text.includes('/review')), JSON.stringify(bubbles));
  record('模板展开后由合成端点按 plain 规则回复（模型收到的是展开后的文字）', raw.includes('只有文字的回复'), oneLine(raw));
  await shot(page, '7-template-bubble');
}

/**
 * @brief 生成中（"wait 6s"）：打出 "/" 出列表；Esc 只关闭列表；列表开着、没有可选的项时 Enter 照常排队（生成中 Enter
 *        是排队）；有项时 Enter 插入高亮项、不排队。接着 queuedSkill 排一条技能命令，再一起记录。
 */
async function escWhileRunning(ctx) {
  const { page, h } = ctx;
  await typeFresh(page, '');
  await h.send(`wait ${WAIT_SECONDS}s`);
  await waitRunning(page);
  await typeFresh(page, '/');
  const open = await menuShown(page);
  const esc = await pressAndView(page, 'Escape');
  const busy = await paneBusy(page);
  await page.keyboard.type(NO_MATCH_SEND.slice(1));
  const reopened = await menuShown(page);
  const noMatchView = await slashView(page);
  await page.keyboard.press('Enter');
  const queuedNoMatch = await waitQueued(page, NO_MATCH_SEND);
  await settle(page);
  const noMatchEnter = await slashView(page);
  await composer(page).fill('/rev');
  await menuShown(page);
  const inserted = await pressAndView(page, 'Enter');
  const queueKept = await queueStays(page, queuedNoMatch.length, 300);
  const running = (await paneBusy(page)).running;
  ctx.running = { open, esc, busy, reopened, noMatchView, queuedNoMatch, noMatchEnter, inserted, queueKept, running };
  await queuedSkill(ctx);
}

/**
 * @brief 接着 escWhileRunning（仍在生成）：写一条技能命令按 Enter 排队；排队区写回 "/skill:fmt 参数"；本轮结束后
 *        排队的两条（没有匹配的那条和技能命令）都发出，都照常结束。
 */
async function queuedSkill(ctx) {
  const { page } = ctx;
  await composer(page).fill(QUEUED_SKILL);
  await settle(page);
  const closed = !(await slashView(page)).open;
  await page.keyboard.press('Enter');
  const queued = (await waitQueued(page, QUEUED_SKILL)).join(' | ');
  const bubbles = page.locator(`${FOCUSED} [data-testid="skill-invocation"]`);
  await bubbles.nth(1).waitFor({ timeout: 30000 });
  await waitIdle(page, 30000);
  const final = { closed, queued, second: await skillBubble(bubbles.nth(1)),
    stopped: await page.locator(`${FOCUSED} [data-testid="notice"]`).filter({ hasText: STOPPED }).count(),
    replies: await page.locator(`${FOCUSED} [data-testid="assistant"]`).allInnerTexts(),
    sent: (await page.locator(`${FOCUSED} [data-testid="user-message"]`).allInnerTexts()).map((text) => text.trim()) };
  recordRunning(ctx.running, final);
}

/** @brief 记录生成中的几项检查（escWhileRunning、queuedSkill 收集的结果）。 */
function recordRunning(state, final) {
  const waited = final.replies.some((text) => text.includes(`等了 ${WAIT_SECONDS} 秒`));
  record('生成中打出 "/" 也出列表；Esc 只关闭列表，不停止生成（仍在生成，本轮照常结束，没有"已停止"）', state.open
    && !state.esc.open && state.esc.draft === '/' && state.busy.running && final.stopped === 0 && waited,
  JSON.stringify({ open: state.open, esc: state.esc.open, running: state.busy.running, stopped: final.stopped,
    waited }));
  record(`生成中列表开着、没有可选的项时 Enter 照常排队：改了第一个词列表再出现（没有匹配），Enter 后排队区多了 `
    + `"${NO_MATCH_SEND}"，列表关闭、输入框清空；本轮结束后它原样发出`, state.reopened
    && state.noMatchView.note === NO_MATCH && state.queuedNoMatch.includes(NO_MATCH_SEND) && !state.noMatchEnter.open
    && state.noMatchEnter.draft === '' && final.sent.includes(NO_MATCH_SEND),
  `${brief(state.noMatchView)} → ${brief(state.noMatchEnter)} queue=${JSON.stringify(state.queuedNoMatch)} `
    + `sent=${JSON.stringify(final.sent)}`);
  record('生成中列表开着、有项时 Enter 插入高亮项 "/review "（不排队），仍在生成', state.inserted.draft === '/review '
    && !state.inserted.open && state.queueKept && state.running,
  `${brief(state.inserted)} queueKept=${state.queueKept} running=${state.running}`);
  record(`生成中排队的技能命令：写好参数后列表关闭，Enter 排队；排队区写回 "${QUEUED_SKILL}"，不显示展开后的 <skill> 原文`,
    final.closed && final.queued.includes(QUEUED_SKILL) && !final.queued.includes('<skill')
    && !final.queued.includes(SKILL_MARKER), oneLine(final.queued));
  record('排队的技能命令在本轮结束后发出：第二个技能调用气泡"技能 · fmt"，参数 "plain queued"', final.second.label === 'Skill · fmt'
    && final.second.args === 'plain queued', JSON.stringify({ ...final.second, text: undefined }));
}

// ---------- 步骤：布局 ----------
// 2026-10-21 起范围、Effort、权限按钮和上下文用量圆环从顶栏移到输入框下面一行（docs/v0/composer-pickers.md）：顶栏只剩
// "项目名 › 会话名"和这一栏的按钮；这一行按会话面板（.chat-pane）的宽度分档（680 / 600 / 460 / 400 / 340px），放不下时
// 依次截短不能发送的说明、选择范围按钮（先截当前模型 id、再截范围名）、模式名、Effort 的强度（models.md"窄栏"）。宽度都指
// .chat-pane（分屏右边那一栏比 .pane-slot 窄 1px），不取整：各档的边界要比到 1px。

/** 第一个提供商的 id（首次启动表单的名称 "Mori endpoint" 生成） */
const MAIN = 'mori-endpoint';
/** 中栏里显示着的会话面板（分屏时两个） */
const PANES = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';
/**
 * 范围按钮的读屏名称、悬停说明的第二行和读屏的描述（v1：docs/v1/screens/model-menu.md"选择范围按钮"，
 * composer-pickers.md"悬停和读屏的描述"：读屏名称"Model range: <按钮文字>"，悬停第一行是按钮文字、第二行
 * "<提供商名> · <区域>"，描述是第二行、" · "换成", "；首次启动的提供商名 "Mori endpoint"、区域 Local）
 */
const MODEL_LABEL = `Model range: ${MODEL_ID}`;
const MODEL_TIP = 'Mori endpoint · Local';
const MODEL_DESCRIBED = 'Mori endpoint, Local';
/** 范围换成这个提供商之后按钮上的字（"<提供商名> · <当前模型 id>"，很长，最挤的情况） */
const PROVIDER_TEXT = `Mori endpoint · ${MODEL_ID}`;
/** 改名后很长的会话名（顶栏的检查量会话名能用多宽，chat.md"顶栏"） */
const LONG_TITLES = { a: 'Give split-pane titles more room with English labels and a long tail (synthetic A)',
  c: 'Keep project and session names readable in narrow split panes with long names (synthetic C)' };
/** 布局检查时输入框里的草稿（生成中有字时这一行最挤） */
const DRAFT = 'plain draft for the layout checks';
/** 分屏时拖中线让左栏落在的宽度（各档的上沿和下沿）；最后拖到最右，右栏的 .pane-slot 280px、.chat-pane 279px */
const LEFT_WIDTHS = [280, 300, 320, 321, 340, 341, 370, 400, 401, 460, 461, 490, 600, 601, 680, 681, Infinity];
/** 分屏时要量到的宽度（composer-pickers.md"新加的检查"第 1、2 条；单栏的 740 / 761 / 930px 另量） */
const SPLIT_WANTED = [279, 280, 300, 320, 321, 340, 341, 370, 400, 401, 460, 461, 490, 600, 601, 680, 681];
/** 单栏时要量的会话面板宽度和右栏开关（800 宽右栏打开时约 300px，到不了更窄） */
const SINGLE_WIDTHS = [[930, false], [761, false], [740, false], [490, true], [300, true]];

/** @brief 一栏的选择器（side 为 left / right / single）。 */
const slotCss = (side) => `.pane-slot[data-side="${side}"]:not([hidden])`;
/** @brief 一栏的会话面板的选择器。 */
const paneCss = (side) => `${slotCss(side)} [data-testid="chat-pane"]`;
/** @brief 显示着的几栏（从左到右的 data-side）。 */
const visibleSides = (page) => page.locator('.pane-slot:not([hidden])').evaluateAll((slots) => slots
  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((slot) => slot.dataset.side));

/**
 * @brief 记一条布局检查：有 count 栏，每一栏的顶栏和这一行都符合（paneProblems），页面不横向溢出、没有元素出窗口；
 *        extra 是这一处另外的条件（面板宽度落在哪一档等）；state 同 paneProblems（默认空闲）。
 */
function recordBars(name, report, count, extra, state = 'idle') {
  const problems = paneProblems(report, state);
  const lines = report.panes.map((pane, index) => `${at1(pane.width)}px: ${problems[index].join(', ') || 'ok'}`);
  record(name, report.panes.length === count && problems.every((list) => list.length === 0)
    && report.page <= report.window && report.outside.length === 0 && extra,
  `${lines.join(' | ')} ${layoutBrief(report)}`);
}

/**
 * @brief 点第 index 栏的输入框，焦点换到这一栏（右栏跟随焦点：换成这一栏会话自己的开关状态，split.md），再等两帧。
 */
async function focusPane(page, index) {
  await page.locator(PANES).nth(index).locator('.composer textarea').click();
  await page.waitForFunction(({ css, at }) => document.querySelectorAll(css)[at]?.closest('.pane-slot')
    ?.dataset.focused === 'true', { css: PANES, at: index }, { timeout: 5000 });
  await settle(page);
}

/**
 * @brief 在每一栏依次打开 kinds 里的弹出层（范围、Effort、权限菜单，圆环详情，"Queue"的下拉），量位置（placeProblems），
 *        Esc 关上。按钮不可用（生成中的范围、Effort）或不在（不是生成中有字时的 ▾）时跳过；该在却打不开的记为问题。
 *        先把焦点换到那一栏（免得点按钮时焦点换栏、右栏跟着开关、按钮移位）。返回 [{ side, kind, problems }]。
 */
async function placeAll(page, kinds) {
  const bad = [];
  const sides = await visibleSides(page);
  for (const side of sides) {
    if (sides.length > 1) {
      await page.locator(`${slotCss(side)} .composer textarea`).click();
      await page.waitForFunction((css) => document.querySelector(css)?.dataset.focused === 'true', slotCss(side),
        { timeout: 5000 });
      await settle(page);
    }
    for (const kind of kinds) {
      const result = await openAndPlace(page, { paneCss: paneCss(side), ...POPUPS[kind] }).catch((error) => ({
        problems: [oneLine(error, 120)] }));
      if (result?.problems.length) bad.push({ side, kind, problems: result.problems });
    }
  }
  return bad;
}

/** @brief 记一条菜单检查：每一栏的范围、Effort、权限菜单和圆环详情都往上打开、在这一栏里、按 models.md 对齐。 */
async function recordMenus(ctx, where) {
  const bad = await placeAll(ctx.page, ['model', 'thinking', 'permission', 'usage']);
  record(`${where}：每一栏的范围、Effort 和权限菜单、圆环的详情都往上打开（下边在这一行上方 6px），整个在这一栏和窗口里、`
    + '不盖到顶栏，按 models.md 对齐（范围菜单 min(300px, 这一行) 宽、和 Effort 菜单右边对齐按钮或贴这一行左端，'
    + '权限菜单贴左端，详情贴右端）', bad.length === 0, JSON.stringify(bad));
}

/** @brief 把焦点所在一栏的右栏开关切到 open，等右栏出现或消失、再等两帧。 */
async function setRight(page, open) {
  const toggle = page.locator(`${FOCUSED} .topbar`).getByRole('button', { name: 'Toggle changes' });
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
  await page.waitForFunction((want) => {
    const panel = document.querySelector('[data-testid="right-panel"]');
    return (Boolean(panel) && panel.getBoundingClientRect().width > 0) === want;
  }, open, { timeout: 5000 });
  await settle(page);
}

/** @brief 当前一栏这一行里范围按钮的读屏名称、悬停说明的各行、读屏的描述和描述元素在不在按钮外面。 */
const rangeLabels = async (page) => {
  const state = await buttonState(page, 'model-button');
  return { text: state.text, name: state.name, lines: state.lines, described: state.described,
    tipOutside: state.tipOutside, inRow: state.inRow, inTopbar: state.inTopbar };
};

/**
 * @brief 1280 宽单栏（右栏关，会话 A）：顶栏只有会话名和右栏开关；这一行各项都完整显示（> 680px 一档）；菜单往上打开、
 *        在面板里；各种浮层打开时没有小于 12px 的字。
 */
async function wideLayout(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 1280, 800);
  await setRight(page, false);
  const report = await layoutReport(page);
  const pane = report.panes[0];
  const range = await rangeLabels(page);
  recordBars('1280 宽单栏（面板宽于 680px）：顶栏只有项目名 › 会话名和右栏开关；输入框下面一行从左到右权限（"Ask each time ▾"，'
    + '没有图标）、范围按钮（最长 200px，长模型 ID 截在 200px）、"Effort: <强度> ▾"、圆环、带文字的"Send"，间距 8px；'
    + '不溢出、不裁切，会话名完整', report, 1, pane?.width > 680 && pane.controls.model?.width >= RANGE_MAX - 1);
  record(`范围按钮在这一行里（不在顶栏）：读屏名称"${MODEL_LABEL}"；悬停第一行是按钮文字、第二行"${MODEL_TIP}"；读屏的描述`
    + `"${MODEL_DESCRIBED}"（第二行，" · "换成", "），描述元素（model-tip）在按钮外面`, range.inRow && !range.inTopbar
    && range.text === MODEL_ID && range.name === MODEL_LABEL && range.lines.join('|') === `${MODEL_ID}|${MODEL_TIP}`
    && range.described === MODEL_DESCRIBED && range.tipOutside === true, JSON.stringify(range));
  await shot(page, 'layout-1280');
  const toggle = page.locator(`${FOCUSED} [data-testid="skill-invocation"] .skill-toggle`).first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await noteSmall(ctx, '1280 单栏（技能气泡展开）');
  await typeFresh(page, '/');
  await waitMenu(page);
  await noteSmall(ctx, '1280 "/"列表');
  await typeFresh(page, '');
  await widePopupsSmall(ctx);
  await recordMenus(ctx, '1280 宽单栏');
}

/** @brief 接着 wideLayout：依次打开范围、Effort、权限菜单和圆环详情，键盘焦点落到圆环（显示悬停提示），各记一次小字。 */
async function widePopupsSmall(ctx) {
  const { page } = ctx;
  const names = { model: '范围菜单', thinking: 'Effort 菜单', permission: '权限菜单', usage: '圆环详情' };
  for (const kind of ['model', 'thinking', 'permission', 'usage']) {
    await page.locator(`${FOCUSED} ${ROW} ${POPUPS[kind].opener}`).click();
    await page.locator(POPUPS[kind].popup).waitFor({ timeout: 5000 });
    await noteSmall(ctx, `1280 ${names[kind]}`);
    await page.keyboard.press('Escape');
    await page.locator(POPUPS[kind].popup).waitFor({ state: 'detached', timeout: 5000 });
  }
  await page.mouse.move(0, 0);
  await page.locator(`${FOCUSED} ${ROW} [data-testid="usage"]`).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await noteSmall(ctx, '1280 圆环的悬停提示（键盘焦点）');
  await page.keyboard.press('Escape');
}

/**
 * @brief 1400 宽、右栏打开（面板约 690px，仍宽于 680px）：范围按钮仍最长 200px（不再有 ≤ 720 / 760px 的 120px 一档），
 *        "Effort: <强度> ▾"、带文字的发送按钮和项目名都还在。
 */
async function midLayout(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 1400, 800);
  await setRight(page, true);
  const report = await layoutReport(page);
  const pane = report.panes[0];
  recordBars('1400 宽、右栏打开（面板宽于 680px）：范围按钮最长 200px（长模型 ID 截在 200px，原来 ≤ 720px 时 120px 的一档'
    + '去掉了），"Effort: <强度> ▾"、带文字的"Send"、项目名都还在；顶栏和这一行不溢出、不裁切', report, 1,
  pane?.width > 680 && pane.controls.model?.width >= RANGE_MAX - 1);
  await shot(page, 'layout-1400-right');
  await noteSmall(ctx, '1400 右栏打开');
  await recordMenus(ctx, '1400 宽、右栏打开');
  await setRight(page, false);
  await resizeTo(ctx, 1280, 800);
}

/** @brief 焦点所在元素的简称：这一行按钮的 data-testid、aria-label、会话行、文字或标签名。 */
async function focusLabel(page) {
  const focus = await focusInfo(page);
  if (focus.file !== null) return `会话行 ${focus.text}`;
  return focus.composer ? 'textarea' : focus.testid || focus.label || focus.text || focus.tag;
}

/**
 * @brief 第一次打开中的样子（watchRows 记下的、按钮位置是"Starting…"的）：这一行只有权限按钮（不可用，悬停第二行和读屏的
 *        描述"Starting…"）和说明，没有范围按钮、Effort 和圆环；这一行仍高 33px、不溢出。返回不符合的（空数组为符合）。
 */
const openingProblems = (rows) => rows.filter((row) => row.kinds.join() !== KINDS.opening
  || !row.permission?.aria || row.permission.reason !== NOTE.starting
  || row.permission.title !== `Permission mode: Ask each time\n${NOTE.starting}` || row.height < 32 || row.overflow);

/**
 * @brief Ctrl+N 新建会话 C：第一次打开中（"Starting…"）这一行只有权限按钮和说明（chat.md"后台正在启动"）；打开后从文字框
 *        按 Tab 依次是权限 → 范围 → Effort → 圆环（"Send"输入为空时不可用，跳过）；Shift+Tab 回到会话树是 6 次（右栏开关 →
 *        协作开关 → 左栏分隔线 → 底部两个按钮 → 会话行）：M6 是 8 次，TaskBoard 在顶栏加了协作开关
 *        （parallel-agents-taskboard.md §13.1，一个真正可以聚焦的按钮）是 9 次，2026-10-21 起权限、思考强度和模型三个按钮
 *        移到了文字框后面。ctrlN 等到会话打开好才返回（打开中协作开关不可用、不在 Tab 路径上）。
 *        之后在 C 里发一条长消息（分屏的布局检查用它）。
 */
async function shiftTabPath(ctx) {
  const { page, h } = ctx;
  await watchRows(page);
  ctx.c = await ctrlN(page);
  const opening = (await seenRows(page)).filter((row) => row.wait === NOTE.starting);
  const focused = await waitComposerFocus(page);
  const forward = [];
  for (let n = 0; n < 5; n += 1) {
    await page.keyboard.press('Tab');
    forward.push(await focusLabel(page));
  }
  await composer(page).focus();
  const path = [];
  let landed = null;
  for (let presses = 1; presses <= 12 && !landed; presses += 1) {
    await page.keyboard.press('Shift+Tab');
    const focus = await focusInfo(page);
    path.push(await focusLabel(page));
    if (focus.file !== null) landed = { presses, focus };
  }
  ctx.shiftTab = landed?.presses ?? null;
  record('新会话第一次打开中（"Starting…"）：输入框下面一行只有权限按钮（不可用，悬停第二行和读屏的描述"Starting…"）和'
    + '按钮位置的说明，没有范围按钮、Effort 和圆环；这一行仍高 33px、不溢出', opening.length > 0
    && openingProblems(opening).length === 0, JSON.stringify(opening.slice(0, 4)));
  record('Tab：从新会话的文字框往后依次是权限 → 范围 → Effort → 圆环（"Send"输入为空时不可用，跳过）', focused
    && forward.slice(0, 4).join() === 'permission-button,model-button,thinking-button,usage'
    && forward[4] !== 'Send', `路径：${forward.join(' → ')}`);
  record(`Shift+Tab：从新会话的输入框按 ${landed?.presses ?? '12+'} 次回到会话树（应为 6 次：右栏开关 → 协作开关 → `
    + '左栏分隔线 → 底部两个按钮 → 会话行；权限、范围、Effort 在文字框后面，不在这条路上），落在新会话行', focused
    && landed?.presses === 6 && path[0] === 'Toggle changes' && path[1] === 'team-switch'
    && samePath(landed.focus.file, ctx.c),
  `路径：${path.join(' → ')}`);
  await h.send(LONG_NAME_MESSAGE);
  await h.idle(60000);
}

/**
 * @brief 最小窗口 800×600、右栏打开（中栏约 300px，≤ 340px 一档）：图标栏 + 中栏 + 右栏都完整；顶栏不显示项目名，会话名
 *        完整或占满剩下的地方；这一行收到最紧（只有图标的"Send"、没有 ▾、内边距 4px），菜单和"/"列表不被裁掉。
 */
async function narrowLayout(ctx) {
  const { page } = ctx;
  await openRow(page, ctx.a);
  await resizeTo(ctx, 800, 600);
  await setRight(page, true);
  const report = await layoutReport(page);
  const pane = report.panes[0];
  record('800×600、右栏打开：左栏收起为 60px 图标栏，中栏至少 300px，右栏完整，页面没有横向、纵向溢出，没有元素出窗口，'
    + '输入框完整在窗口里', report.window === 800 && report.sidebar === 60 && report.center >= 300 && report.right > 0
    && report.page <= 800 && report.pageHeight <= report.height && report.outside.length === 0
    && pane?.frame.composer.bottom > 0 && pane.frame.composer.bottom <= report.height, layoutBrief(report));
  recordBars('800×600、右栏打开（面板约 300px，≤ 340px）：顶栏不显示项目名和 ›，两个图标按钮 28px，会话名完整或占满剩下的地方；'
    + '这一行权限、范围、Effort 按钮都在（没有 ▾、内边距 4px），圆环在，"Send"只有图标（28px）；不溢出、不裁切', report, 1,
  pane?.width <= 340);
  await shot(page, 'layout-800-right');
  await noteSmall(ctx, '800×600 右栏打开');
  await recordMenus(ctx, '800×600、右栏打开');
  await typeFresh(page, '/');
  await waitMenu(page);
  const geometry = await menuGeometry(page);
  record('800×600、右栏打开："/"列表浮在输入框上方、与输入框同宽、在窗口里、在最上层，长说明省略号截断（列表不横向溢出）',
    Boolean(geometry?.above && geometry.sameWidth && geometry.inWindow && geometry.noOverflow && geometry.onTop),
    JSON.stringify(geometry));
  await shot(page, 'layout-800-slash');
  await noteSmall(ctx, '800×600 "/"列表');
  await typeFresh(page, '');
  await setRight(page, false);
}

/** @brief 分屏（A 在左、C 在右）：1280 宽（每栏约 510px）和 1200 宽（每栏约 470px），右栏关。 */
async function splitLayout(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 1280, 800);
  await splitOpen(page, ctx.c);
  const wide = await layoutReport(page);
  recordBars('1280 宽分屏、右栏关（每栏约 510px，460–600px）：两栏顶栏有项目名 › 会话名、右栏开关和"Close pane"；这一行'
    + '"Send"只有图标，Effort 只显示强度，三个按钮带 ▾；不溢出、不裁切', wide, 2,
  wide.panes.every((pane) => pane.width > 460 && pane.width <= 600));
  await shot(page, 'layout-1280-split');
  await noteSmall(ctx, '1280 分屏');
  await recordMenus(ctx, '1280 宽分屏');
  await resizeTo(ctx, 1200, 800);
  const closed = await layoutReport(page);
  recordBars('1200 宽分屏、右栏关（每栏约 470px，460–600px）：两栏都有范围、Effort 按钮（带 ▾）和圆环；顶栏和这一行不溢出、'
    + '不裁切', closed, 2, closed.panes.every((pane) => pane.width > 460 && pane.width <= 600));
  await shot(page, 'layout-1200-split');
  await noteSmall(ctx, '1200 分屏');
  await recordMenus(ctx, '1200 宽分屏');
  await splitRight(ctx);
  await narrowSplit(ctx);
  await page.locator(`${FOCUSED} [data-testid="close-pane"]`).click();
  await waitSplit(page, false);
  await resizeTo(ctx, 1280, 800);
}

/** @brief 分屏时两栏的会话都把右栏开关切到 open（右栏跟随焦点，各会话各自记住开关，split.md）。 */
async function setRightBoth(page, open) {
  for (const index of [0, 1]) {
    await focusPane(page, index);
    await setRight(page, open);
  }
}

/**
 * @brief 接着 splitLayout：1200 宽分屏、右栏开（两栏的会话都打开右栏），两栏各 280px（最窄，右边那一栏 .chat-pane 279px）：
 *        顶栏不显示项目名，会话名至少 185px（名字更短时完整）；这一行三个按钮和圆环都在，菜单在栏里。
 */
async function splitRight(ctx) {
  const { page } = ctx;
  await setRightBoth(page, true);
  const open = await layoutReport(page);
  const state = await splitState(page);
  recordBars('1200 宽分屏、右栏开：右栏贴在右边、两栏各 280px（右边那一栏的会话面板 279px）；顶栏不显示项目名；这一行权限、'
    + '范围、Effort 按钮和圆环都在（没有 ▾），不窄于最窄（40 / 36 / 36px）；不溢出、不裁切', open, 2, open.right > 0
    && state.slots.every((slot) => slot.width >= 280) && open.panes.every((pane) => pane.width <= 340));
  await shot(page, 'layout-1200-split-right');
  await noteSmall(ctx, '1200 分屏右栏开');
  await recordMenus(ctx, '1200 宽分屏、右栏开（每栏 280px）');
  await setRightBoth(page, false);
}

/**
 * @brief 接着 splitRight（分屏、右栏关）：最小窗口 800×600 时两栏（各约 370px）的顶栏和这一行也放得下（split.md"最小 800px"）：
 *        项目名还在（> 320px），会话名约 215px。
 */
async function narrowSplit(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 800, 600);
  const report = await layoutReport(page);
  recordBars('800×600 分屏、右栏关：图标栏 60px，两栏各约 370px（340–400px）；顶栏有项目名（> 320px）；这一行三个按钮去掉 ▾、'
    + '"Send"只有图标（32px）；顶栏和这一行不溢出、不裁切', report, 2, report.sidebar === 60
    && report.panes.every((pane) => pane.width > 340 && pane.width <= 400));
  await shot(page, 'layout-800-split');
  await noteSmall(ctx, '800×600 分屏');
  await recordMenus(ctx, '800×600 分屏');
  await resizeTo(ctx, 1200, 800);
}

// ---------- 步骤：各档的边界（composer-pickers.md"新加的检查"第 1–4 条） ----------

/**
 * @brief 分屏时把左栏依次拖到 LEFT_WIDTHS 的每个宽度，每处量两栏的顶栏和这一行（layoutReport）；at(target) 是每处另外要做的事
 *        （返回值记在 extra 里）。返回 [{ target, report, extra }]。
 */
async function sweep(page, at) {
  const samples = [];
  for (const target of LEFT_WIDTHS) {
    await fitLeft(page, target);
    const report = await layoutReport(page);
    samples.push({ target, report, extra: at ? await at(target) : null });
  }
  return samples;
}

/**
 * @brief 记一条各档检查：每个样本里每一栏的顶栏和这一行都符合 state（paneProblems），页面不溢出；wanted 里的每个宽度都量到了
 *        （差不到 1px、落在同一档）。
 */
function recordSweep(name, samples, state, wanted = SPLIT_WANTED) {
  const bad = [];
  const widths = [];
  for (const { report } of samples) {
    paneProblems(report, state).forEach((problems, index) => {
      const width = report.panes[index].width;
      widths.push(width);
      if (problems.length) bad.push(`${at1(width)}px: ${problems.join(', ')}`);
    });
    if (report.page > report.window || report.outside.length) bad.push(`page overflow ${layoutBrief(report)}`);
  }
  const missed = wanted.filter((want) => !widths.some((width) => Math.abs(width - want) < 1
    && bandKey(width) === bandKey(want)));
  record(name, bad.length === 0 && missed.length === 0 && samples.length > 0, bad.length || missed.length
    ? `${bad.slice(0, 8).join(' | ')} missed=${missed.join()}` : `widths ${widths.map(at1).join(', ')}`);
}

/** @brief 等 side 那一栏开始（want 为 true）或结束生成。 */
const waitRunningAt = (page, side, want = true, timeout = 30000) => page.waitForFunction(({ css, on }) => {
  const pane = document.querySelector(css);
  return (pane?.dataset.running === 'true' || pane?.dataset.sending === 'true') === on;
}, { css: paneCss(side), on: want }, { timeout });

/** @brief 停下所有在生成的栏（点"Stop"），等它们都结束。 */
async function stopAll(page) {
  for (const side of await visibleSides(page)) {
    const stop = page.locator(`${slotCss(side)} ${ROW} .stop-button`);
    if (await stop.count()) await stop.click();
    await waitRunningAt(page, side, false, 30000);
  }
}

/** @brief 分屏 A | C、1280 宽、两栏右栏都关；已经分屏时只把在生成的栏停下、把窗口放回 1280 宽。 */
async function ensureSplit(ctx) {
  const { page } = ctx;
  if (!(await splitState(page)).split) {
    await resizeTo(ctx, 1280, 800);
    await openRow(page, ctx.a);
    await splitOpen(page, ctx.c);
  }
  await stopAll(page);
  if ((await page.evaluate(() => innerWidth)) !== 1280) await resizeTo(ctx, 1280, 800);
  await setRightBoth(page, false);
}

/** @brief 把会话 file 改名为 title（会话行的菜单"Rename"），等会话行显示新名字。 */
async function renameTo(page, file, title) {
  const input = await startRename(page, file);
  await input.fill(title);
  await input.press('Enter');
  await waitRowTitle(page, file, title);
}

/**
 * @brief 各档检查的准备：把会话 A、C 的范围换成提供商 mori-endpoint（范围按钮"Mori endpoint · <很长的模型 id>"，这一行最挤；
 *        范围菜单 Providers 一节），再改成很长的名字。看一次 A 的范围按钮：两段（.range-scope、.range-model）、读屏名称、
 *        悬停、描述、data-pick / data-current。
 */
async function bandPrep(ctx) {
  const { page } = ctx;
  for (const file of [ctx.c, ctx.a]) {
    await openRow(page, file);
    await choosePick(page, MAIN);
  }
  await renameTo(page, ctx.a, LONG_TITLES.a);
  await renameTo(page, ctx.c, LONG_TITLES.c);
  await openRow(page, ctx.a);
  const range = await rangeLabels(page);
  const button = await buttonState(page, 'model-button');
  const parts = await page.locator(`${FOCUSED} ${ROW} [data-testid="model-button"]`).evaluate((el) => ({
    scope: el.querySelector('.range-scope')?.textContent ?? null, model: el.querySelector('.range-model')?.textContent
      ?? null }));
  record(`准备：会话 A 的范围换成提供商后，范围按钮"${PROVIDER_TEXT}"（.range-scope "Mori endpoint"、.range-model `
    + `" · <模型 id>"），data-pick 是提供商、data-current 是当前模型；读屏名称"Model range: <按钮文字>"，悬停两行`
    + `（按钮文字、"${MODEL_TIP}"），读屏的描述"${MODEL_DESCRIBED}"`, range.text === PROVIDER_TEXT
    && parts.scope === 'Mori endpoint' && parts.model === ` · ${MODEL_ID}` && button.pick === MAIN
    && button.current === `${MAIN}/${MODEL_ID}` && range.name === `Model range: ${PROVIDER_TEXT}`
    && range.lines.join('|') === `${PROVIDER_TEXT}|${MODEL_TIP}` && range.described === MODEL_DESCRIBED,
  JSON.stringify({ range, parts, pick: button.pick, current: button.current }));
}

/**
 * @brief 一个菜单里看得见的项（读屏名称：去掉 aria-hidden 的快捷键提示）、aria-keyshortcuts 和焦点所在的项。
 *        宽于 400px 时"Queue for later"由 CSS 藏起（display: none，不在读屏树里），不算。
 */
const sendMenu = (page, side) => page.evaluate((css) => {
  const menu = document.querySelector(`${css} .split-button [role="menu"]`);
  if (!menu) return null;
  const name = (item) => [...item.childNodes].filter((node) => node.nodeType === 3 || (node.nodeType === 1
    && node.getAttribute('aria-hidden') !== 'true')).map((node) => node.textContent).join('').trim();
  const items = [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => item.getClientRects().length > 0);
  return { items: items.map(name), keys: items.map((item) => item.getAttribute('aria-keyshortcuts')),
    focused: items.includes(document.activeElement) ? name(document.activeElement) : null };
}, slotCss(side));

/** @brief side 那一栏排队区的条数。 */
const queuedCount = (page, side) => page.locator(`${slotCss(side)} [data-testid="queue"] .queue-text`).count();

/**
 * @brief 生成中、输入框有字、这一栏 ≤ 400px（"Queue"收起，models.md"很窄"）：从文字框 Tab 到 ▾（经过权限、范围、Effort、
 *        圆环），Enter 打开 → 焦点在"Queue for later"，↓ 到"Steer"，Esc 回到 ▾；再 Enter、Enter 选"Queue for later"：
 *        排队区多一条，"Queue ▾"消失、焦点回到文字框。最后把草稿写回去。返回看到的。
 */
async function queueKeys(page, side) {
  await composerAt(page, side).focus();
  const path = [];
  for (let n = 0; n < 5; n += 1) {
    await page.keyboard.press('Tab');
    path.push(await focusLabel(page));
  }
  await page.keyboard.press('Enter');
  const menu = await sendMenu(page, side);
  await page.keyboard.press('ArrowDown');
  const down = (await sendMenu(page, side))?.focused ?? null;
  await page.keyboard.press('Escape');
  const back = await focusLabel(page);
  const before = await queuedCount(page, side);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const queued = await page.waitForFunction(({ css, n }) => document.querySelectorAll(`${css} [data-testid="queue"] `
    + '.queue-text').length > n, { css: slotCss(side), n: before }, { timeout: 5000 }).then(() => true, () => false);
  await settle(page);
  const focus = await page.evaluate((css) => (document.activeElement === document.querySelector(`${css} .composer `
    + 'textarea') ? 'textarea' : document.activeElement?.getAttribute('aria-label') ?? null), slotCss(side));
  const after = { queued, focus, toggle: await page.locator(`${slotCss(side)} .split-toggle`).count(),
    draft: await composerAt(page, side).inputValue() };
  await composerAt(page, side).fill(DRAFT);
  return { path, menu, down, back, after };
}

/** @brief queueKeys 的结果对不对。 */
const queueKeysOk = (seen) => seen?.path.join() === 'permission-button,model-button,thinking-button,usage,'
  + 'More send options' && seen.menu?.items.join() === 'Queue for later,Steer'
  && seen.menu.keys.join() === 'Enter,Control+Enter' && seen.menu.focused === 'Queue for later'
  && seen.down === 'Steer' && seen.back === 'More send options' && seen.after.queued && seen.after.focus === 'textarea'
  && seen.after.toggle === 0 && seen.after.draft === '';

/** @brief 宽于 400px 时点 ▾：菜单里只有"Steer"（没有"Queue for later"），Esc 关上。 */
async function steerOnly(page, side) {
  await page.locator(`${slotCss(side)} ${ROW} .split-toggle`).click();
  await page.locator(`${slotCss(side)} .split-button [role="menu"]`).waitFor({ timeout: 5000 });
  const menu = await sendMenu(page, side);
  await page.keyboard.press('Escape');
  return menu;
}

/**
 * @brief 分屏、两栏都在生成（"wait 240s"）且输入框有字（这一行最挤：Ask each time、Effort: Unavailable、很长的
 *        "<提供商名> · <模型 id>"、"Queue ▾"和"Stop"）：拖到各档的上沿和下沿，量两栏；每处打开两栏的圆环详情、权限菜单和
 *        "Queue"的下拉；左栏 400px 和 280px 时用键盘走"More send options"、选"Queue for later"排队，401px 时菜单里只有
 *        "Steer"。最后清空两栏的草稿，再拖一遍量"生成中、输入框为空"，停下两栏。
 */
async function bandTyped(ctx) {
  const { page } = ctx;
  await ensureSplit(ctx);
  for (const side of ['left', 'right']) {
    await sendAt(page, side, 'wait 240s');
    await waitRunningAt(page, side);
    await composerAt(page, side).fill(DRAFT);
  }
  const keys = {};
  const samples = await sweep(page, async (target) => {
    const placed = await placeAll(page, ['usage', 'permission', 'queue']);
    if (target === 400 || target === 280) keys[target] = await queueKeys(page, 'left');
    if (target === 401) keys[target] = await steerOnly(page, 'left');
    return placed;
  });
  await shot(page, 'bands-typed-279');
  recordSweep('各档的上沿和下沿（分屏，279–681px）、生成中、两栏输入框都有字（这一行最挤：Ask each time、Effort: Unavailable、'
    + '很长的"<提供商名> · <模型 id>"、"Queue ▾"、"Stop"）：顶栏只有会话名和两个按钮，会话名有地方；这一行不换行、不超出输入框、'
    + '高 33px，每档该收的收起（"Effort: "、发送组的文字、▾、≤ 400px 收起"Queue"），截短按说明 → 范围（先模型 id 再范围名）'
    + ' → 模式名 → Effort 的先后，宽于 400px 时模式名不截，三个按钮不窄于最窄；范围、Effort 不可用、原因在第三 / 第二行',
  samples, 'typed');
  const placed = samples.flatMap((sample) => sample.extra);
  record('各档、生成中有字：两栏的圆环详情、权限菜单和"Queue"的下拉都往上打开、整个在这一栏和窗口里、不盖到顶栏；'
    + '"Queue"的下拉右边对齐 ▾ 或贴这一行左端，权限菜单贴左端，详情贴右端（601、680px 和最挤时也在面板里）',
  placed.length === 0, JSON.stringify(placed.slice(0, 6)));
  for (const width of [400, 280]) {
    record(`${width}px、生成中有字：Tab 依次到权限 → 范围 → Effort → 圆环 → ▾"More send options"（"Queue"收起）；Enter 打开，`
      + '焦点在"Queue for later"，↓ 到"Steer"，Esc 回到 ▾；项的读屏名称只有文字（aria-keyshortcuts 是 Enter、Control+Enter）；'
      + '选"Queue for later"真的排队，"Queue ▾"消失、焦点回到文字框', queueKeysOk(keys[width]), JSON.stringify(keys[width]));
  }
  record('401px、生成中有字："Queue"按钮还在，▾ 菜单里只有"Steer"（没有"Queue for later"）',
    keys[401]?.items.join() === 'Steer', JSON.stringify(keys[401]));
  for (const side of ['left', 'right']) await composerAt(page, side).fill('');
  await settle(page);
  recordSweep('各档的上沿和下沿（分屏，279–681px）、生成中、输入框为空（按钮位置只有"Stop"，没有"Queue ▾"）：顶栏和这一行都'
    + '符合这一档，范围、Effort 不可用', await sweep(page), 'running');
  await stopAll(page);
}

/**
 * @brief 打开 side 那一栏的范围菜单（这一行只有 226px 时菜单收到这一行的宽），量每一项：名字（.switch-text）放不下时截断加
 *        "…"，区域（.pick-zone）和 ✓ 不收；每项的 title 是全名或原因。Esc 关上。
 */
async function menuItemsFit(page, side) {
  await page.locator(`${slotCss(side)} ${ROW} [data-testid="model-button"]`).click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  const items = await page.getByTestId('model-menu').locator('[role="menuitemradio"]').evaluateAll((list) => list
    .map((item) => {
      const fit = (el) => {
        if (!el) return null;
        const copy = el.cloneNode(true);
        Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', width: 'max-content',
          maxWidth: 'none' });
        el.parentElement.append(copy);
        const full = copy.getBoundingClientRect().width;
        copy.remove();
        return { width: el.getBoundingClientRect().width, full,
          ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' };
      };
      return { pick: item.dataset.pick, title: item.title, name: fit(item.querySelector('.switch-text')),
        zone: fit(item.querySelector('.pick-zone')), inside: item.scrollWidth <= item.clientWidth + 1 };
    }));
  const width = await page.getByTestId('model-menu').evaluate((el) => el.getBoundingClientRect().width);
  await page.keyboard.press('Escape');
  return { width, items };
}

/**
 * @brief 分屏、两栏空闲（输入框里还有字，"Send"可用）：拖到各档的上沿和下沿量两栏，每处打开两栏的范围、Effort、权限菜单和
 *        圆环详情；顶栏 ≤ 400px 时内边距收小；280px 时范围菜单收到这一行的宽、项名截断、区域完整。最后（右栏 279px）在右栏按
 *        F8，报告的"Current view"里"Pane width"是右栏 .chat-pane 的宽度（比 .pane-slot 窄 1px），还有"Model range"、
 *        "Effort""Model""Permission mode"。
 */
async function bandIdle(ctx) {
  const { page } = ctx;
  await ensureSplit(ctx);
  for (const side of ['left', 'right']) await composerAt(page, side).fill(DRAFT);
  let narrowMenu = null;
  const samples = await sweep(page, async (target) => {
    if (target === 280) narrowMenu = await menuItemsFit(page, 'left');
    return placeAll(page, ['model', 'thinking', 'permission', 'usage']);
  });
  recordSweep('各档的上沿和下沿（分屏，279–681px）、空闲：顶栏和这一行都符合这一档（同上，发送组是"Send"，范围、Effort 能用、'
    + '不带 aria-disabled）', samples, 'idle');
  const placed = samples.flatMap((sample) => sample.extra);
  record('各档、空闲：两栏的范围、Effort、权限菜单和圆环详情都往上打开、在这一栏和窗口里、不盖到顶栏；范围、Effort 菜单右边'
    + '对齐自己的按钮或（放不下时）贴这一行左端，任何宽度都不伸出这一行', placed.length === 0,
  JSON.stringify(placed.slice(0, 6)));
  recordNarrowMenu(narrowMenu);
  const tops = samples.flatMap((sample) => sample.report.panes.map((pane) => pane.top));
  const wide = tops.filter((top) => top.width > 400).map((top) => top.pad);
  const narrow = tops.filter((top) => top.width <= 400).map((top) => top.pad);
  record('顶栏：会话面板 ≤ 400px 时内边距收小（左内边距比宽于 400px 时小）', wide.length > 0 && narrow.length > 0
    && Math.max(...narrow) < Math.min(...wide),
  JSON.stringify({ wide: [...new Set(wide)], narrow: [...new Set(narrow)] }));
  await f8PaneWidth(ctx);
}

/** @brief 280px 一栏里范围菜单的样子（bandIdle 量的）。 */
function recordNarrowMenu(seen) {
  const cut = (fact) => fact && fact.width < fact.full - 0.01;
  const long = seen?.items.filter((item) => cut(item.name)) ?? [];
  record('280px 一栏（这一行约 226px）：范围菜单收到这一行的宽；放不下的项名（很长的模型 id）截断加"…"，区域和 ✓ 不收、'
    + '不溢出；每项的悬停是全名', Boolean(seen) && seen.width <= 227 && long.length > 0
    && long.every((item) => item.name.ellipsis && item.title.length > 0)
    && seen.items.every((item) => item.inside && (!item.zone || !cut(item.zone))), JSON.stringify(seen));
}

/** @brief 最新的一份 F8 报告（<userData>/ui-issues 里最后一个 .md）的文字；没有时为空串。 */
function latestIssue(ctx) {
  const dir = join(ctx.userData, 'ui-issues');
  if (!existsSync(dir)) return '';
  const name = readdirSync(dir).filter((file) => file.endsWith('.md')).sort().at(-1);
  return name ? readFileSync(join(dir, name), 'utf8') : '';
}

/**
 * @brief 在右栏（.pane-slot 280px）按 F8 保存一份报告：Current view 有"Pane width: <右栏 .chat-pane 的宽度>px"（比 .pane-slot
 *        窄 1px）、"Model range: mori-endpoint"、"Effort: Unavailable"，"Model""Permission mode"照旧
 *        （composer-pickers.md"我自己定的"第 16 条，f8.md"保存的内容"）。
 */
async function f8PaneWidth(ctx) {
  const { page } = ctx;
  await composerAt(page, 'right').click();
  const slot = (await splitState(page)).slots.at(-1)?.width ?? 0;
  const width = Math.round((await paneWidths(page)).at(-1));
  await page.keyboard.press('F8');
  await page.getByTestId('issue-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('issue-what').fill('composer-pickers：右栏的宽度（synthetic）');
  await page.getByTestId('issue-dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('issue-saved').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  const fields = /^- (Pane width|Model range|Effort|Model|Permission mode):/;
  const lines = latestIssue(ctx).split(/\r?\n/).filter((line) => fields.test(line));
  record('F8：焦点在分屏右边那一栏时，报告的"Current view"有"Pane width"（这一栏会话面板的宽度，比 .pane-slot 窄 1px）、'
    + '"Model range: mori-endpoint"和"Effort: Unavailable"，"Model"和"Permission mode"照旧', width === slot - 1
    && lines.includes(`- Pane width: ${width}px`) && lines.includes(`- Model range: ${MAIN}`)
    && lines.includes('- Effort: Unavailable') && lines.includes('- Permission mode: Ask each time')
    && lines.includes(`- Model: ${MAIN}/${MODEL_ID}`), `${lines.join(' | ')} slot=${slot}`);
}

/** @brief 关掉分屏（点右栏的"Close pane"），回到 1280 宽。 */
async function closeSplit(ctx) {
  const { page } = ctx;
  if ((await splitState(page)).split) {
    await page.locator(`${slotCss('right')} [data-testid="close-pane"]`).click();
    await waitSplit(page, false);
  }
  await resizeTo(ctx, 1280, 800);
}

/** @brief 单栏时依次调到 SINGLE_WIDTHS 的每个宽度，量顶栏和这一行，打开 kinds 里的弹出层；返回 [{ target, report, extra }]。 */
async function singleSamples(ctx, kinds) {
  const samples = [];
  for (const [width, right] of SINGLE_WIDTHS) {
    await fitPane(ctx, width, { right });
    const report = await layoutReport(ctx.page);
    samples.push({ target: width, report, extra: await placeAll(ctx.page, kinds) });
  }
  return samples;
}

/**
 * @brief 单栏（会话 A）：会话面板 930、761、740px（右栏关，改窗口宽度凑出）、490px 和 800 宽右栏打开（约 300px，≤ 340px），
 *        生成中有字和空闲各量一次：顶栏和这一行都符合这一档；每处打开圆环详情、权限菜单，生成中加"Queue"的下拉，空闲时加
 *        范围、Effort 菜单。
 */
async function bandSingle(ctx) {
  const { page } = ctx;
  await stopAll(page);
  await closeSplit(ctx);
  await openRow(page, ctx.a);
  await sendAt(page, 'single', 'wait 120s');
  await waitRunningAt(page, 'single');
  await composerAt(page, 'single').fill(DRAFT);
  const typed = await singleSamples(ctx, ['usage', 'permission', 'queue']);
  await stopAll(page);
  const idle = await singleSamples(ctx, ['model', 'thinking', 'permission', 'usage']);
  const wanted = SINGLE_WIDTHS.filter(([width]) => width !== 300).map(([width]) => width);
  recordSweep('单栏 930 / 761 / 740 / 490px 和 800 宽右栏打开、生成中有字：顶栏和这一行都符合这一档（> 680px 范围按钮最长 '
    + '200px、"Queue ▾"和"Stop"带文字）', typed, 'typed', wanted);
  recordSweep('单栏 930 / 761 / 740 / 490px 和 800 宽右栏打开、空闲：顶栏和这一行都符合这一档', idle, 'idle', wanted);
  const narrow = idle.at(-1)?.report.panes[0]?.width ?? 0;
  record('800 宽、右栏打开的会话面板落在 ≤ 340px 一档（约 300px）', narrow > 0 && narrow <= 340, String(narrow));
  const placed = [...typed, ...idle].flatMap((sample) => sample.extra);
  record('单栏各宽度：圆环详情、权限、范围、Effort 菜单和"Queue"的下拉都往上打开、在会话面板和窗口里、不盖到顶栏、按 models.md '
    + '对齐（圆环详情在 740、761px 生成中有字时也在面板里）', placed.length === 0, JSON.stringify(placed.slice(0, 6)));
  await resizeTo(ctx, 1280, 800);
  await setRight(page, false);
}

/** @brief 在 side 那一栏的 Effort 菜单里选 level，等按钮显示它、不再切换中。 */
async function levelIn(page, side, level) {
  await page.locator(`${slotCss(side)} ${ROW} [data-testid="thinking-button"]`).click();
  await page.locator(`[data-testid="thinking-menu"] [role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction(({ css, want }) => {
    const button = document.querySelector(css);
    return button?.dataset.level === want && button.dataset.pending !== 'true'
      && button.getAttribute('aria-disabled') !== 'true';
  }, { css: `${slotCss(side)} ${ROW} [data-testid="thinking-button"]`, want: level }, { timeout: 15000 });
}

/** @brief 在 side 那一栏的权限菜单里选 mode（"Allow all"要在确认框里再点一次），等按钮显示它。 */
async function permissionIn(page, side, mode) {
  await page.locator(`${slotCss(side)} ${ROW} [data-testid="permission-button"]`).click();
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: mode }).click();
  if (mode === 'Allow all') await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Allow all' }).click();
  await page.waitForFunction(({ css, want }) => document.querySelector(css)
    ?.querySelector('[data-testid="permission-button"]')?.textContent?.trim() === want,
  { css: slotCss(side), want: mode }, { timeout: 10000 });
}

/** @brief 在 设置 → Models 里把会话 A、C 用的长模型标上或去掉"Supports thinking"，回到会话。 */
async function markLongModel(ctx, on) {
  const { page } = ctx;
  await openSettingsSection(page, 'models');
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
  await setReasoning(page, `${MAIN}/${MODEL_ID}`, on);
  await backToApp(page);
}

/**
 * @brief 280px 一栏的另外几种写法（composer-pickers.md"新加的检查"第 3 条："Medium"和"Allow all"各走一次 280px；"Extra high"
 *        v1 到不了，见文件头）：在设置里把长模型标为支持思考，左栏 A 的 Effort 选"Medium"、"High"，生成中有字时各量一次；
 *        生成中把权限切到"Allow all"量（字和底色的对比度 ≥ 4.5:1，看得见的开头两个字母不同于"Ask each time"）；最后切回
 *        "Ask each time"、去掉支持思考（之后的步骤仍是最宽的"Effort: Unavailable"）、关掉分屏。
 */
async function bandEffort(ctx) {
  const { page } = ctx;
  await closeSplit(ctx);
  await markLongModel(ctx, true);
  await ensureSplit(ctx);
  await fitLeft(page, 280);
  const seen = {};
  for (const level of ['medium', 'high']) {
    await levelIn(page, 'left', level);
    await sendAt(page, 'left', 'wait 60s');
    await waitRunningAt(page, 'left');
    await composerAt(page, 'left').fill(DRAFT);
    seen[level] = await layoutReport(page);
    if (level === 'high') await allowAllAt280(page, seen);
    await stopAll(page);
  }
  recordEffortBands(seen);
  await permissionIn(page, 'left', 'Ask each time');
  await closeSplit(ctx);
  await markLongModel(ctx, false);
}

/** @brief 接着 bandEffort（左栏 280px、生成中有字）：切到"Allow all"，量这一行和"Allow all"的字与底色的对比度。 */
async function allowAllAt280(page, seen) {
  await permissionIn(page, 'left', 'Allow all');
  seen.all = await layoutReport(page);
  seen.contrast = contrastOf(await colorStack(page, `${slotCss('left')} ${ROW} .permission-text`));
  seen.lead = await page.locator(`${slotCss('left')} ${ROW} .permission-text`)
    .evaluate((el) => el.textContent.slice(0, 2));
}

/** @brief bandEffort 看到的。 */
function recordEffortBands(seen) {
  const left = (report) => report?.panes[0];
  for (const [level, label] of [['medium', 'Medium'], ['high', 'High']]) {
    recordBars(`280px、生成中有字、Effort "${label}"：这一行放得下，三个按钮不窄于最窄（40 / 36 / 36px），截短的先后照旧，`
      + `读屏名称和悬停第一行"Effort: ${label}"`, seen[level], 2, left(seen[level])?.width < 281
      && left(seen[level]).controls.thinking?.name === `Effort: ${label}`, ['typed', 'idle']);
  }
  recordBars('280px、生成中有字、"Allow all"：权限按钮只有文字"Allow all"（警示色，没有图标），看得见的开头两个字母"Al"不同于'
    + '"Ask each time"的"As"；这一行放得下', seen.all, 2, left(seen.all)?.width < 281 && left(seen.all).controls.all
    && seen.lead === 'Al', ['typed', 'idle']);
  record('"Allow all"的字和它的底色（警示色的 12%）对比度 ≥ 4.5:1（--color-warn-text，approval.md）', seen.contrast >= 4.5,
    String(seen.contrast));
}

/**
 * @brief 后台进程退出时会话 A 的这一行（chat.md"后台进程退出"）：开着的权限菜单关闭；权限、范围、Effort 按钮不可用
 *        （aria-disabled），权限、Effort 悬停的第二行、范围按钮的第三行和读屏的描述是"Mori’s background process crashed"
 *        （范围按钮的描述前面是提供商和区域；权限、Effort 的描述里没有第一行）；圆环保留最后一次的用量（data-tokens 不变），
 *        详情仍能打开。
 */
async function recordExited(ctx, before, menuClosed) {
  const { page } = ctx;
  const focusedPane = `${FOCUSED} [data-testid="chat-pane"]`;
  const [controls] = await page.locator(focusedPane).evaluateAll(rowControls);
  const after = await ringState(page, focusedPane);
  await page.locator(`${FOCUSED} ${ROW} [data-testid="usage"]`).click();
  const opened = await page.getByTestId('usage-details').waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.keyboard.press('Escape');
  const crashed = (item) => item?.aria && item.tip[1] === NOTE.crashed && item.described === NOTE.crashed;
  const range = controls.model;
  record('后台进程退出：开着的权限菜单关闭（原来不关，2026-10-21 一起改）', menuClosed, String(menuClosed));
  record('后台进程退出：权限、范围、Effort 按钮还在这一行里但不可用（aria-disabled）；权限、Effort 悬停的第二行和读屏的描述是'
    + '"Mori’s background process crashed"（描述里没有第一行），范围按钮的悬停第三行是它、描述是'
    + `"${MODEL_DESCRIBED}. Mori’s background process crashed"`, crashed(controls.permission)
    && crashed(controls.thinking) && range?.aria && range.tip[1] === MODEL_TIP && range.tip[2] === NOTE.crashed
    && range.described === `${MODEL_DESCRIBED}. ${NOTE.crashed}`, JSON.stringify({ permission: controls.permission,
    model: range, thinking: controls.thinking }));
  record('后台进程退出：圆环保留最后一次的用量（data-tokens 不变），详情仍能打开', before?.state === 'used'
    && after?.state === 'used' && after.tokens === before.tokens && opened, JSON.stringify({ before, after, opened }));
}

/**
 * @brief watchRows 的一个样子里三个按钮都不可用、读屏的描述是 wait（范围按钮是"<提供商名>, <区域>. <wait>"）。
 */
const reopenReasons = (row, wait) => ['permission', 'model', 'thinking'].every((kind) => row[kind]?.aria)
  && row.permission.reason === wait && row.thinking.reason === wait
  && row.model.reason === `${MODEL_DESCRIBED}. ${wait}`;

/**
 * @brief Restart 时 watchRows 记下的会话 A（单栏）的样子：重新载入中（"Restarting…"）和重新打开中（"Starting…"）权限、范围、
 *        Effort 按钮和圆环都还在（不像第一次打开那样藏起范围和 Effort），三个按钮不可用、原因就是按钮位置的那句话；这一行
 *        高 33px、不溢出。
 */
function recordReopen(rows) {
  const kept = (wait) => {
    const list = rows.filter((row) => row.side === 'single' && row.wait === wait);
    return list.length > 0 && list.every((row) => row.kinds.join() === KINDS.exited && reopenReasons(row, wait)
      && row.height >= 32 && !row.overflow);
  };
  const shown = rows.filter((row) => row.wait).slice(0, 6);
  record('重新载入中（"Restarting…"）：输入框下面一行的权限、范围、Effort 按钮和圆环都在，三个按钮不可用（aria-disabled），'
    + '读屏的描述（范围按钮的后半）是"Restarting…"；这一行高 33px、不溢出', kept(NOTE.restarting), JSON.stringify(shown));
  record('Restart 之后重新打开中（"Starting…"）：范围、Effort 和圆环保留上一次的值（不像第一次打开那样藏起），三个按钮不可用，'
    + '原因"Starting…"', kept(NOTE.starting), JSON.stringify(shown));
}

/**
 * @brief 后台进程再退出一次（分屏 A | C，1280 宽）：C 开着的圆环详情不关；拖到各档的上沿和下沿，两栏这一行（权限、范围、
 *        Effort、圆环和很长的"Mori’s background process crashed"）都放得下，这句说明最先截短、悬停是全文。接着 failRestart。
 */
async function exitBands(ctx) {
  const { page, app } = ctx;
  await ensureSplit(ctx);
  await fitLeft(page, 640);
  await page.locator(`${slotCss('right')} ${ROW} [data-testid="usage"]`).click();
  await page.getByTestId('usage-details').waitFor({ timeout: 5000 });
  killKernel(app);
  await page.locator(`${slotCss('right')} [data-testid="kernel-exit"]`).waitFor({ timeout: 15000 });
  await settle(page);
  const ring = await ringState(page, paneCss('right'));
  record('后台进程退出时开着的圆环详情不关（它只是看数），圆环保留最后的用量', Boolean(ring?.details)
    && ring.state === 'used', JSON.stringify(ring));
  await page.keyboard.press('Escape');
  const samples = await sweep(page);
  recordSweep('后台进程退出（分屏，279–681px）：两栏这一行（权限、范围、Effort、圆环和按钮位置的"Mori’s background process '
    + 'crashed"）不换行、不超出输入框、高 33px；说明先截短（最窄 48px，悬停是全文），之后才截范围、模式名、Effort', samples,
  'exited');
  await failRestart(ctx);
}

/**
 * @brief 接着 exitBands（后台进程已退出）：把 C 的会话文件挪开，焦点放在 C 的范围按钮上，点"Restart"（DOM 的 click()，
 *        不动焦点）：重新打开中 C 的范围、Effort 和圆环仍在（不可用），焦点留在范围按钮上；C 打开失败后这一行只剩权限按钮
 *        （原因"Session didn’t open"）和说明，没有范围、Effort 和圆环，焦点回到 C 的文字框。左栏 280px 和最右（C 279px）
 *        各量一次。最后把文件挪回来。
 */
async function failRestart(ctx) {
  const { page } = ctx;
  const away = `${ctx.c}.away`;
  renameSync(ctx.c, away);
  try {
    await page.locator(`${slotCss('right')} ${ROW} [data-testid="model-button"]`).focus();
    await watchRows(page);
    await page.evaluate((css) => [...document.querySelector(`${css} [data-testid="kernel-exit"]`)
      .querySelectorAll('button')].find((button) => button.textContent.includes('Restart')).click(), slotCss('right'));
    await page.waitForFunction((css) => document.querySelector(`${css} [data-testid="not-ready"]`)?.textContent
      === 'Session didn’t open', slotCss('right'), { timeout: 60000 });
    await waitPaneReady(page, 'left', 60000);
    await settle(page);
    const rows = (await seenRows(page)).filter((row) => row.side === 'right');
    const inTextarea = await page.evaluate((css) => document.activeElement === document
      .querySelector(`${css} .composer textarea`), slotCss('right'));
    const samples = [];
    for (const target of [280, Infinity]) {
      await fitLeft(page, target);
      samples.push({ target, report: await layoutReport(page) });
    }
    recordFailed(rows, inTextarea, samples);
  } finally {
    renameSync(away, ctx.c);
  }
}

/** @brief failRestart 看到的：重新打开中、打开失败、失败后两栏各宽度的样子。 */
function recordFailed(rows, inTextarea, samples) {
  const reopening = rows.filter((row) => row.wait === NOTE.starting);
  const failed = rows.filter((row) => row.wait === NOTE.failed).at(-1);
  record('Restart 之后重新打开中：C 的范围、Effort 和圆环仍在（不可用，原因"Starting…"），焦点留在 C 的范围按钮上',
    reopening.length > 0 && reopening.every((row) => row.kinds.join() === KINDS.exited
      && reopenReasons(row, NOTE.starting) && row.focus === 'model-button'),
  JSON.stringify(reopening.slice(0, 4)));
  record('打开失败（会话文件不在）：C 这一行只剩权限按钮（不可用，原因"Session didn’t open"）和按钮位置的说明，没有范围、'
    + 'Effort 和圆环；焦点在范围按钮上时它消失，焦点回到 C 的文字框（不落到 body）', failed?.kinds.join() === KINDS.failed
    && failed.permission?.aria && failed.permission.reason === NOTE.failed && failed.height >= 32 && !failed.overflow
    && inTextarea, JSON.stringify({ failed, inTextarea }));
  recordSweep('打开失败之后：左栏 A（空闲）和右栏 C（打开失败）在 280px / 279px 时这一行都放得下', samples, ['idle', 'failed'],
    [279, 280]);
}

// ---------- 步骤：拒绝启动（no_pick）时这一行（composer-pickers.md"新加的检查"第 2、10 条） ----------

/** @brief 设置 → Models → Defaults 的默认范围改成 value（空串为 None），回到会话。 */
async function defaultPickTo(ctx, value) {
  const { page } = ctx;
  await openSettingsSection(page, 'models');
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
  await setDefaultPick(page, value);
  await backToApp(page);
}

/**
 * @brief 拒绝启动卡上的"Change model…"打开这一栏这一行的范围菜单（model-chat.md、models.md"键盘"）：菜单往上、在面板里、
 *        在这一行上方、没盖到顶栏；Esc 后焦点在范围按钮。返回看到的。
 */
async function changeModelFromCard(page, side) {
  await page.locator(`${slotCss(side)} [data-testid="blocked-card"] [data-action="change-model"]`).click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  await settle(page);
  const geo = await popupBox(page, { popup: POPUPS.model.popup, paneCss: paneCss(side), anchor: POPUPS.model.opener });
  await page.keyboard.press('Escape');
  await popupGone(page, POPUPS.model.popup);
  const focus = await page.evaluate((css) => document.activeElement === document.querySelector(css),
    `${slotCss(side)} ${ROW} [data-testid="model-button"]`);
  return { problems: placeProblems(geo, POPUPS.model), focus };
}

/**
 * @brief side 那一栏从文字框往后按 Tab，直到焦点离开这一栏的输入框下面一行（最多 6 次）：返回这一行里依次停到的元素
 *        （focusLabel；离开这一行的那一次不算）。
 */
async function tabsFrom(page, side) {
  await composerAt(page, side).focus();
  const path = [];
  for (let n = 0; n < 6; n += 1) {
    await page.keyboard.press('Tab');
    const inRow = await page.evaluate((css) => Boolean(document.activeElement?.closest(css)),
      `${slotCss(side)} ${ROW}`);
    if (!inRow) break;
    path.push(await focusLabel(page));
  }
  return path;
}

/**
 * @brief 拒绝启动（no_pick）：设置里默认范围改成 None 后新建会话 B（拒绝启动卡"No default model range; pick one."），马上把
 *        默认范围改回来（之后新建的会话照常）。B 在左、A 在右分屏：B 的范围按钮"No model range"、能用（不带 aria-disabled），
 *        悬停两行（按钮文字、"No model can run in this session"），没有 Effort，"Send" disabled；Tab 依次是权限 → 范围 → 圆环，
 *        跳过"Send"；拖到各档的上沿和下沿，两栏这一行都放得下；卡上的"Change model…"打开 B 这一行的范围菜单（往上、盖住卡、
 *        不盖顶栏），Esc 后焦点在范围按钮；选一个范围后卡消失、菜单关闭。
 */
async function bandBlocked(ctx) {
  const { page } = ctx;
  await closeSplit(ctx);
  await defaultPickTo(ctx, '');
  ctx.b = await ctrlN(page);
  await page.locator(`${FOCUSED} [data-testid="blocked-card"][data-kind="no_pick"]`).waitFor({ timeout: 15000 });
  await defaultPickTo(ctx, `${MAIN}/${MODEL_ID}`);
  await openRow(page, ctx.b);
  await splitOpen(page, ctx.a);
  await composerAt(page, 'left').fill(DRAFT);
  const path = await tabsFrom(page, 'left');
  const range = (await page.locator(paneCss('left')).evaluateAll(rowControls))[0]?.model;
  const samples = await sweep(page);
  await fitLeft(page, 460);
  const card = await changeModelFromCard(page, 'left');
  await choosePick(page, `${MAIN}/${MODEL_ID}`, paneCss('left'));
  const gone = await page.locator(`${slotCss('left')} [data-testid="blocked-card"]`)
    .waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  recordBlocked({ path, range, samples, card, gone });
  await composerAt(page, 'left').fill('');
  await closeSplit(ctx);
}

/** @brief bandBlocked 看到的。 */
function recordBlocked({ path, range, samples, card, gone }) {
  record('拒绝启动（no_pick）：范围按钮"No model range"、能用（不带 aria-disabled），读屏名称"Model range: No model range"，'
    + '悬停两行（按钮文字、"No model can run in this session"），读屏的描述是第二行；没有 Effort 按钮',
  range?.text === 'No model range' && !range.hasAria && range.name === 'Model range: No model range'
    && range.tip.join('|') === `No model range|${NOTE.noModel}` && range.described === NOTE.noModel,
  JSON.stringify(range));
  record('拒绝启动：从文字框 Tab 依次是权限 → 范围 → 圆环（没有 Effort；圆环按 pi 的结果，可能不在），"Send"不可用、被跳过',
    ['permission-button,model-button,usage', 'permission-button,model-button'].includes(path.join()),
    `路径：${path.join(' → ')}`);
  recordSweep('拒绝启动（no_pick，分屏左栏 279–681px，右栏空闲）：两栏这一行都不换行、不超出输入框、高 33px；左栏只有权限、'
    + '范围按钮（能用）、圆环和 disabled 的"Send"，没有 Effort', samples, ['blocked', 'idle']);
  record('拒绝启动卡上的"Change model…"打开这一栏这一行的范围菜单：往上打开、盖住卡、在面板里、不盖顶栏、右边对齐范围按钮'
    + '或贴这一行左端；Esc 后焦点在范围按钮', card.problems.length === 0 && card.focus, JSON.stringify(card));
  record('在范围菜单里选一个范围后拒绝启动卡消失、菜单关闭', gone, String(gone));
}

// ---------- 步骤：其他来源 ----------

/** @brief 会话没有任何模板和技能：把用户级的文件夹挪开后新建的会话 D；原来的会话 A 仍列出它加载了的。 */
async function emptySession(ctx) {
  const { page } = ctx;
  const agentDir = join(ctx.userData, 'pi');
  renameSync(join(agentDir, 'prompts'), join(agentDir, 'prompts-away'));
  renameSync(join(agentDir, 'skills'), join(agentDir, 'skills-away'));
  try {
    ctx.d = await ctrlN(page);
    await typeFresh(page, '/');
    await waitMenu(page);
    const empty = await slashView(page);
    await noteSmall(ctx, '"/"会话没有任何项');
    const esc = await pressAndView(page, 'Escape');
    record('会话没有任何模板和技能：列表里"这个会话没有提示词模板或技能（在工具页添加）"；Esc 关闭', empty.note === EMPTY_NOTE
      && empty.items.length === 0 && !esc.open && esc.draft === '/', `${brief(empty)} → ${brief(esc)}`);
    await shot(page, '7-slash-empty');
    const sends = await enterSends(ctx, '/plain');
    record('会话没有任何模板和技能时 Enter 照常发送：列表是这条说明（没有可选的项），按 Enter 发出原样的 "/plain"，'
      + '列表关闭、输入框清空', sends.listed.note === EMPTY_NOTE && sends.sent === '/plain' && !sends.after.open
      && sends.after.draft === '', `${brief(sends.listed)} → sent=${sends.sent} ${brief(sends.after)}`);
    await openRow(page, ctx.a);
    await typeFresh(page, '/');
    await waitMenu(page);
    const loaded = await slashView(page);
    record('只列这个会话加载了的：文件挪开后，打开时加载过的会话 A 仍列出两个模板和两个技能',
      sortedNames(names(loaded)) === USER_NAMES, JSON.stringify(names(loaded)));
    await typeFresh(page, '');
  } finally {
    renameSync(join(agentDir, 'prompts-away'), join(agentDir, 'prompts'));
    renameSync(join(agentDir, 'skills-away'), join(agentDir, 'skills'));
  }
}

/** @brief pi 设置 enableSkillCommands 为 false 时不列技能（与 pi 终端相同）：改设置后新建的会话 E。 */
async function skillCommandsOff(ctx) {
  const { page } = ctx;
  await withSettings(ctx, { enableSkillCommands: false }, async () => {
    ctx.e = await ctrlN(page);
    await typeFresh(page, '/');
    await waitMenu(page);
    const view = await slashView(page);
    record('pi 设置 enableSkillCommands 为 false 时只列提示词模板，不列技能命令', view.groups.join() === 'Prompt templates'
      && names(view).join() === 'a-review,review', JSON.stringify({ groups: view.groups, names: names(view) }));
    await typeFresh(page, '');
  });
}

/**
 * @brief 只列启用的：在 pi 的用户设置里停用 a-review 模板和 review-notes 技能（写法同 pi config，
 *        见 tests/fixtures/m6/pi-config-toggles.json）后新建的会话 G 不列它们。
 */
async function disabledResources(ctx) {
  const { page } = ctx;
  const patch = { prompts: [`-${join('prompts', 'a-review.md')}`],
    skills: [`-${join('skills', 'review-notes', 'SKILL.md')}`] };
  await withSettings(ctx, patch, async () => {
    ctx.g = await ctrlN(page);
    await typeFresh(page, '/');
    await waitMenu(page);
    const view = await slashView(page);
    record('只列启用的：在 pi 设置里停用 a-review 模板和 review-notes 技能后新建的会话，列表只有 review 和 skill:fmt',
      names(view).join() === 'review,skill:fmt' && view.groups.join() === 'Prompt templates,Skills',
      JSON.stringify({ patch, groups: view.groups, names: names(view) }));
    await typeFresh(page, '');
  });
}

/**
 * @brief 只列信任的项目里的：带 .pi 模板和技能的项目选"Don’t trust"打开时不列它们；另一个带同样资源的项目选
 *        "Trust workspace"打开后列出。
 */
async function projectTrust(ctx) {
  const { page } = ctx;
  await openProject(ctx, ctx.untrusty, false);
  await typeFresh(page, '/');
  await waitMenu(page);
  const untrusted = await slashView(page);
  const banner = await page.locator(`${FOCUSED} [data-testid="trust-banner"]`).innerText({ timeout: 3000 });
  await typeFresh(page, '');
  record('项目没有信任时不列项目里的：选"不信任"打开带 .pi 资源的项目（横幅"没有信任这个文件夹"），列表只有用户级的四项，'
    + '没有 proj-tmpl 和 skill:proj-skill', banner.includes('This workspace isn’t trusted')
    && sortedNames(names(untrusted)) === USER_NAMES,
  `${oneLine(banner, 60)} ${JSON.stringify(names(untrusted))}`);
  await openProject(ctx, ctx.trusty, true);
  await typeFresh(page, '/');
  await waitMenu(page);
  const trusted = await slashView(page);
  const project = PROJECT_COMMANDS.every((want) => trusted.items.some((item) => item.name === want.name
    && item.kind === want.kind && item.description === want.description));
  record('信任后列出项目里的：选"信任"打开带同样资源的另一个项目，proj-tmpl 在"提示词模板"组、skill:proj-skill 在"技能"组，'
    + '用户级的四项也在', project && (trusted.members[0] ?? []).includes('proj-tmpl')
    && (trusted.members[1] ?? []).includes('skill:proj-skill') && trusted.items.length === 6,
  JSON.stringify({ groups: trusted.groups, members: trusted.members }));
  await typeFresh(page, '');
}

/**
 * @brief 读取失败显示原文。界面上没有让 session.commands 出错的操作，这里用 synthetic 的做法：经 window.mori 直接让
 *        后台进程关掉会话 E（界面不知道），再打出 "/"，列表里是后台进程真实的报错原文。Esc 关闭。
 */
async function commandsError(ctx) {
  const { page } = ctx;
  if (ctx.e) await openRow(page, ctx.e);
  else ctx.e = await ctrlN(page);
  const { sessionId } = await kernelOpen(page, ctx.e);
  await page.evaluate((id) => window.mori.request({ type: 'session.close', sessionId: id }), sessionId);
  await typeFresh(page, '/');
  await waitMenu(page);
  const view = await slashView(page);
  await noteSmall(ctx, '"/"读取失败');
  await shot(page, '7-slash-error');
  const esc = await pressAndView(page, 'Escape');
  record('读取失败：列表里是后台进程报错的原文（Unknown session <id>，role=alert），没有项；Esc 关闭、字还在',
    view.open && view.items.length === 0 && (view.note ?? '').includes(`Unknown session ${sessionId}`)
    && view.noteRole === 'alert' && !esc.open && esc.draft === '/',
    `${brief(view)} role=${view.noteRole} → ${brief(esc)}`);
  await typeFresh(page, '');
}

/**
 * @brief 记下此后每次界面变化时：列表在不在、列表的字、焦点所在一栏"不能发送"的说明、焦点在不在它的输入框、草稿。
 *        window.__readinessNote() 可以手动再记一次。
 */
function watchReadiness(page) {
  return page.evaluate((focused) => {
    window.__readiness = [];
    window.__readinessObserver?.disconnect();
    window.__readinessNote = () => {
      const textarea = document.querySelector(`${focused} .composer textarea`);
      const menu = document.querySelector('[data-testid="slash-menu"]');
      window.__readiness.push({ menu: Boolean(menu), menuText: menu?.textContent?.slice(0, 80) ?? null,
        notReady: document.querySelector(`${focused} [data-testid="not-ready"]`)?.textContent ?? null,
        focused: Boolean(textarea) && document.activeElement === textarea, draft: textarea?.value ?? null });
    };
    window.__readinessObserver = new MutationObserver(window.__readinessNote);
    window.__readinessObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__readinessNote();
  }, FOCUSED);
}

/**
 * @brief 后台进程退出（会话不能发送）：开着的权限菜单关闭，这一行的按钮不可用、原因读得到，圆环保留用量（recordExited）；
 *        打出 "/" 不出列表；接着 reloadKernel。
 */
async function kernelExited(ctx) {
  const { page, app } = ctx;
  await openRow(page, ctx.a);
  await typeFresh(page, '');
  const before = await ringState(page, `${FOCUSED} [data-testid="chat-pane"]`);
  // 2026-10-21 起：开着的权限菜单在后台进程退出时关闭（composer-pickers.md"我自己定的"第 13 条）
  await page.locator(`${FOCUSED} ${ROW} [data-testid="permission-button"]`).click();
  await page.getByTestId('permission-menu').waitFor({ timeout: 5000 });
  killKernel(app);
  // 每个会话面板各有一条退出横幅（隐藏的面板里的也在），等显示着的那条
  await page.locator(`${FOCUSED} [data-testid="kernel-exit"]`).first().waitFor({ timeout: 15000 });
  await recordExited(ctx, before, await popupGone(page, '[data-testid="permission-menu"]'));
  await watchReadiness(page);
  await typeFresh(page, '/');
  const quiet = await neverWithin(page, () => Boolean(document.querySelector('[data-testid="slash-menu"]')), null, 800);
  const view = await slashView(page);
  record('后台进程退出后打出 "/"：不出列表（800ms 内一次也没出现），字和焦点都在输入框', quiet && !view.open
    && view.draft === '/' && view.focused, brief(view));
  await shot(page, '7-slash-kernel-exit');
  await reloadKernel(ctx);
}

/**
 * @brief 接着 kernelExited：输入框有焦点、草稿是 "/" 时点"Restart"（同时用 watchRows 记下这一行，recordReopen）；
 *        重新载入中（"Restarting…"）、会话重新打开中（"Starting…"，会话还没打开）都不出列表，也不闪出读取失败；就绪后
 *        打出 "/" 照常出列表。"Restarting…"只持续一小会儿，鼠标点按钮再点回输入框赶不上，所以用 DOM 的 click() 点按钮
 *        （不移动焦点）。
 */
async function reloadKernel(ctx) {
  const { page } = ctx;
  await composer(page).focus();
  await watchRows(page);
  await page.evaluate((css) => {
    const banner = document.querySelector(`${css} [data-testid="kernel-exit"]`);
    [...banner.querySelectorAll('button')].find((button) => button.textContent.includes('Restart')).click();
  }, FOCUSED);
  await page.waitForFunction((css) => !document.querySelector(`${css} [data-testid="not-ready"]`)
    && [...document.querySelectorAll(`${css} [data-testid="notice"]`)].some((n) => n.textContent.includes('Restarted')),
  FOCUSED, { timeout: 60000 });
  await settle(page);
  recordReopen(await seenRows(page));
  const log = await page.evaluate(() => {
    window.__readinessObserver.disconnect();
    return window.__readiness;
  });
  const during = (text) => log.filter((entry) => entry.notReady === text && entry.focused && entry.draft === '/');
  const shown = log.filter((entry) => entry.menu && entry.notReady !== null);
  const failed = log.filter((entry) => (entry.menuText ?? '').includes('Unknown session'));
  const seen = [...new Set(log.map((entry) => `${entry.notReady}|${entry.focused}|${entry.draft}|${entry.menu}`))];
  record('重新载入中（"正在重新载入…"）：输入框有焦点、草稿是 "/"，不出列表', during('Restarting…').length > 0
    && shown.length === 0, `出现过的（说明|焦点|草稿|列表）：${seen.join(' ; ')}`);
  record('会话重新打开中（"正在启动…"，会话还没打开）：输入框有焦点、草稿是 "/"，不出列表；整个重新载入过程不闪出读取失败',
    during('Starting…').length > 0 && shown.length === 0 && failed.length === 0,
    `列表出现时：${JSON.stringify(log.filter((entry) => entry.menu).slice(0, 3))}`);
  await typeFresh(page, '/');
  const back = await menuShown(page, 10000);
  const view = await slashView(page);
  record('重新载入、会话打开之后打出 "/"：列表照常出现（用户级的四项）', back && sortedNames(names(view)) === USER_NAMES,
    brief(view));
  await typeFresh(page, '');
}

/** @brief 聊天页（各种状态下）没有小于 12px 的字。 */
async function fontSizes(ctx) {
  record('聊天页没有小于 12px 的文字（1280 单栏与范围、Effort、权限菜单、圆环详情和悬停提示，"/"列表各状态、1400 右栏开、'
    + '800 宽右栏开、1280、1200 和 800 宽分屏）',
    ctx.small.length === 0 && ctx.smallChecked.length > 0, ctx.small.length ? ctx.small.slice(0, 5).join('; ')
      : `checked: ${ctx.smallChecked.join(' / ')}`);
}

const steps = { setup, menuList, menuArrows, menuFilter, insertEnter, insertTabClick, insertKeepsRest, noMatch,
  noMatchSends, caretRule, imeComposition, sendSkill, sendTemplate, escWhileRunning, wideLayout, midLayout,
  shiftTabPath, narrowLayout, splitLayout, bandPrep, bandTyped, bandIdle, bandSingle, bandEffort, bandBlocked,
  emptySession, skillCommandsOff, disabledResources, projectTrust, commandsError, kernelExited, exitBands, fontSizes };

const fake = await startFakeEndpoint(port, testKey);
const { root, project, untrusty, trusty } = makeProject();
const userData = mkdtempSync(join(tmpdir(), 'mori-m6-slash-data-'));
writeUserCommands(join(userData, 'pi'));
const ctx = { userData, root, project, untrusty, trusty, pageErrors: [], small: [], smallChecked: [] };
await startApp(ctx);
try {
  for (const [name, step] of Object.entries(steps)) {
    if (only && name !== 'setup' && !only.includes(name)) continue;
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}：流程`, false, oneLine(error, 400));
      await shot(ctx.page, `${name}-error`);
      await ctx.page.keyboard.press('Escape').catch(() => {});
    }
  }
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await ctx.app.close().catch(() => {});
  fake.kill();
}
console.log(`[m6-app-slash] Shift+Tab presses: ${ctx.shiftTab}; project in ${project}; data in ${userData}`);
await sleep(200);
process.exitCode = write(`m6-app-slash${suffix}.json`) ? 0 : 1;
