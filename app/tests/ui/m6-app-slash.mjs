// M6 整机测试（"/"补全与顶栏布局）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖 docs/v0/screens/slash.md（方案第 7 节 M6 走查 7）和 M6 的布局限制（models.md、split.md、layout.md、defaults.md）：
// 打出 "/" 的读取中（只有一行"正在读取…"）、列表（两组各列各的项、只有第一项高亮、/名字、argument-hint、说明、浮在输入框上方
// 且在最上层）、筛选（先开头再包含、不分大小写）、↑ ↓ 首尾循环、Enter / Tab 插入高亮项、点一项插入且不发送、插入时保留后面的字、
// 没有匹配（继续打字、Enter 不发送、Esc）、光标在第一个空白之后关闭、输入法组字中 Enter 不插入也不关列表；
// 生成中：Esc 只关列表不停止生成、列表开着时 Enter 不排队（没有匹配时什么都不做，有项时插入）、排队的技能命令写回
// "/skill:名字 参数"；发出技能命令（气泡"技能 · 名字"+参数、展开 / 收起、侧栏和标题行的会话名、模型收到展开后的 <skill> 块）
// 与提示词模板（气泡是展开后的全文）；会话没有任何模板和技能、只列这个会话加载了的（启用的、信任的项目里的）、
// 关闭 enableSkillCommands 时不列技能、读取失败显示原文（synthetic 做法：在后台进程里关掉会话而界面不知道）、
// 后台进程退出 / 重新载入中 / 会话重新打开中不出列表，就绪后照常出列表；
// 布局：1280 宽单栏、1400 宽右栏开（面板 600–720px：权限按钮去掉图标、模型名最长 120px）、800×600 打开右栏、
// 1200 宽分屏（右栏关 / 开）、800×600 分屏时顶栏不溢出不裁切，窄栏藏起模型和思考按钮；聊天页没有小于 12px 的字；
// 从新会话的输入框 Shift+Tab 回到会话树的次数（M3 是 6 次，M6 多两个按钮，应为 8 次）。
// 用户级的提示词模板和技能是本测试在启动前写进 <agentDir>/prompts、<agentDir>/skills 的（synthetic），
// 项目级的写在第二个测试项目的 .pi/ 里（synthetic）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-app-slash.mjs [--exe <Mori.exe 路径>] [--only 步骤1,步骤2]
// 结果写到 test-results/m6-app-slash(-packaged).json，截图在 test-results/m6-app-slash(-packaged)/。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, sleep } from './lib.mjs';
import { smallText } from './m1-layout.mjs';
import {
  activeFile, ctrlN, focusInfo, kernelOpen, lastReply, openRow, rowOf, samePath, settle, STOPPED, waitComposerFocus,
  waitIdle, waitRunning,
} from './m3-helpers.mjs';
import { splitState, waitPaneReady, waitSplit } from './m5-helpers.mjs';
import { firstRunAndOpen, openProject, resizeWindow, startFakeEndpoint } from './m6-helpers.mjs';
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
const EMPTY_NOTE = '这个会话没有提示词模板或技能（在工具页添加）';
/** 过滤后为空时的说明 */
const NO_MATCH = '没有匹配的提示词模板或技能';
/** 技能命令发出的文字与会话名（正好 20 个字，不截断） */
const SKILL_COMMAND = '/skill:fmt echo back';
/** 生成中的检查用的一轮的长度（秒）：Esc、Enter、排队都要在它结束前做完 */
const WAIT_SECONDS = 6;
/** 生成中排队的技能命令（参数里的 plain 让合成端点只回文字） */
const QUEUED_SKILL = '/skill:fmt plain queued';

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
 *        不再问，所以"不信任"和"信任"各用一个文件夹）。
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

/** @brief 焦点所在的一栏在 ms 毫秒内没有出现排队区。 */
const staysUnqueued = (page, ms = 400) => neverWithin(page,
  (focused) => Boolean(document.querySelector(`${focused} [data-testid="queue"]`)), FOCUSED, ms);

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

/** @brief 等列表出现并读完（不再是"正在读取…"）。 */
function waitMenu(page, timeout = 10000) {
  return page.waitForFunction(() => {
    const menu = document.querySelector('[data-testid="slash-menu"]');
    return Boolean(menu) && !menu.textContent.includes('正在读取…');
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
 * @brief 用 MutationObserver 记下列表第一次出现"正在读取…"时的样子（只持续一次往返，轮询抓不到）：
 *        列表的文字、项数、role=status 的文字、这时的草稿。读完用 loadingSeen 取回并停止观察。
 */
function watchLoading(page) {
  return page.evaluate((focused) => {
    window.__slashLoading = null;
    window.__slashObserver?.disconnect();
    window.__slashObserver = new MutationObserver(() => {
      const menu = document.querySelector('[data-testid="slash-menu"]');
      if (window.__slashLoading || !menu?.textContent?.includes('正在读取…')) return;
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
  await firstRunAndOpen(ctx, { baseUrl, apiKey: testKey, project: ctx.project });
  ctx.a = await activeFile(ctx.page);
  record('准备：首次启动、打开项目，会话 A 就绪（用户级两个模板、两个技能在启动前写好）', Boolean(ctx.a), ctx.a ?? '');
}

/** @brief 走查 7：输入 "/"：先只有"正在读取…"，再列出两组，每组只有自己的项；只有第一项高亮。 */
async function menuList(ctx) {
  const { page } = ctx;
  await watchLoading(page);
  await typeFresh(page, '/');
  await waitMenu(page);
  const view = await slashView(page);
  const loading = await loadingSeen(page);
  record('读取中：刚打出 "/"、结果还没回来时，列表里只有一行"正在读取…"（role=status，没有项）',
    loading?.text === '正在读取…' && loading.status === '正在读取…' && loading.options === 0, JSON.stringify(loading));
  const ofKind = (kind) => sortedNames(COMMANDS.filter((command) => command.kind === kind).map((c) => c.name));
  record('走查 7：输入 "/"：列表（role=listbox）分"提示词模板""技能"两组，模板组在前；模板组里是两个模板（a-review、review），'
    + '技能组里是两个技能命令（skill:fmt、skill:review-notes），data-kind 对得上', view.role === 'listbox'
    && view.groups.join() === '提示词模板,技能' && view.labels.join() === '提示词模板,技能'
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
    names(lower).join() === want && moved === 1 && selectedIndex(lower) === 0 && lower.groups.join() === '提示词模板,技能',
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

/** @brief 没有匹配："没有匹配的提示词模板或技能"；Enter 不发送、不改字；继续打字；Esc 关闭列表、字还在。 */
async function noMatch(ctx) {
  const { page } = ctx;
  await typeFresh(page, '/zzz');
  await waitMenu(page);
  const view = await slashView(page);
  await noteSmall(ctx, '"/"没有匹配');
  await shot(page, '7-slash-nomatch');
  const enter = await pressAndView(page, 'Enter');
  const unsent = await staysUnsent(page, 0);
  for (let count = 0; count < 3; count += 1) await page.keyboard.press('Backspace');
  await settle(page);
  const back = await slashView(page);
  await page.keyboard.type('zzz');
  await settle(page);
  const again = await slashView(page);
  const esc = await pressAndView(page, 'Escape');
  record('没有匹配：列表里"没有匹配的提示词模板或技能"，没有项', view.open && view.note === NO_MATCH
    && view.items.length === 0, brief(view));
  record('列表开着时 Enter 不发送：没有匹配时按 Enter，列表还在，输入框仍是 "/zzz"，没有发出消息', enter.draft === '/zzz'
    && enter.open && unsent, `${brief(enter)} unsent=${unsent}`);
  record('没有匹配时继续打字：删掉 "zzz" 又列出全部四项，再打 "zzz" 又是没有匹配', back.open && back.draft === '/'
    && sortedNames(names(back)) === USER_NAMES && again.note === NO_MATCH, `${brief(back)} → ${brief(again)}`);
  record('Esc 关闭列表，输入框的字还在、焦点还在', !esc.open && esc.draft === '/zzz' && esc.focused, brief(esc));
}

/**
 * @brief 读取中继续打字：后台进程的回答（一次往返）比下一次按键快，真按键赶不上"正在读取…"，
 *        所以在列表刚显示"正在读取…"的那一刻（MutationObserver 回调里，回答还没到）把输入框改成 text、发 input 事件，
 *        走的是与打字相同的 onChange。记下改字时列表是否仍是"正在读取…"。
 */
function typeWhileLoading(page, text) {
  return page.evaluate(({ focused, value }) => {
    window.__typedWhileLoading = null;
    window.__typeObserver?.disconnect();
    window.__typeObserver = new MutationObserver(() => {
      const menu = document.querySelector('[data-testid="slash-menu"]');
      if (window.__typedWhileLoading || !menu?.textContent?.includes('正在读取…')) return;
      const textarea = document.querySelector(`${focused} .composer textarea`);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      window.__typedWhileLoading = { loading: menu.textContent.includes('正在读取…'), draft: textarea.value };
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
    await bubble.count() === 1 && view.skill === 'fmt' && view.label === '技能 · fmt' && view.args === 'echo back'
    && view.toggle === '展开' && view.body === null && !view.text.includes('<skill') && !view.text.includes(SKILL_MARKER),
    JSON.stringify(view));
  await bubble.first().locator('.skill-toggle').click();
  const open = await skillBubble(bubble.first());
  const skillFile = join(ctx.userData, 'pi', 'skills', 'fmt', 'SKILL.md');
  record('点"展开"看技能正文：SKILL.md 的路径和正文（含 References are relative to 一行）；按钮变"收起"',
    open.expanded === 'true' && open.toggle === '收起' && samePath(open.location, skillFile)
    && (open.body ?? '').includes(SKILL_MARKER) && (open.body ?? '').includes('References are relative to'),
    JSON.stringify(open));
  await shot(page, '7-skill-bubble');
  await bubble.first().locator('.skill-toggle').click();
  const closed = await skillBubble(bubble.first());
  await bubble.first().locator('.skill-toggle').click();
  record('再点"收起"：正文收起，按钮回到"展开"', closed.expanded === 'false' && closed.toggle === '展开'
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
 * @brief 生成中（"wait 6s"）：打出 "/" 出列表；Esc 只关闭列表；列表开着时 Enter 不排队：没有匹配时什么都不做，
 *        有项时插入高亮项。接着 queuedSkill 排一条技能命令，再一起记录。
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
  await page.keyboard.type('zzz');
  const reopened = await menuShown(page);
  const noMatchEnter = await pressAndView(page, 'Enter');
  const unqueued = await staysUnqueued(page);
  await composer(page).fill('/rev');
  await menuShown(page);
  const inserted = await pressAndView(page, 'Enter');
  const unqueuedInsert = await staysUnqueued(page, 300);
  const running = (await paneBusy(page)).running;
  ctx.running = { open, esc, busy, reopened, noMatchEnter, unqueued, inserted, unqueuedInsert, running };
  await queuedSkill(ctx);
}

/** @brief 接着 escWhileRunning（仍在生成）：写一条技能命令按 Enter 排队；排队区写回 "/skill:fmt 参数"；两轮都照常结束。 */
async function queuedSkill(ctx) {
  const { page } = ctx;
  await composer(page).fill(QUEUED_SKILL);
  await settle(page);
  const closed = !(await slashView(page)).open;
  await page.keyboard.press('Enter');
  const queue = page.locator(`${FOCUSED} [data-testid="queue"]`);
  const queued = await settled(queue.waitFor({ timeout: 5000 })) ? await queue.innerText() : '';
  const bubbles = page.locator(`${FOCUSED} [data-testid="skill-invocation"]`);
  await bubbles.nth(1).waitFor({ timeout: 30000 });
  await waitIdle(page, 30000);
  const final = { closed, queued, second: await skillBubble(bubbles.nth(1)),
    stopped: await page.locator(`${FOCUSED} [data-testid="notice"]`).filter({ hasText: STOPPED }).count(),
    replies: await page.locator(`${FOCUSED} [data-testid="assistant"]`).allInnerTexts() };
  recordRunning(ctx.running, final);
}

/** @brief 记录生成中的几项检查（escWhileRunning、queuedSkill 收集的结果）。 */
function recordRunning(state, final) {
  const waited = final.replies.some((text) => text.includes(`等了 ${WAIT_SECONDS} 秒`));
  record('生成中打出 "/" 也出列表；Esc 只关闭列表，不停止生成（仍在生成，本轮照常结束，没有"已停止"）', state.open
    && !state.esc.open && state.esc.draft === '/' && state.busy.running && final.stopped === 0 && waited,
  JSON.stringify({ open: state.open, esc: state.esc.open, running: state.busy.running, stopped: final.stopped,
    waited }));
  record('生成中列表开着时 Enter 不排队：改了第一个词列表再出现（没有匹配），Enter 后列表还在、字还是 "/zzz"、没有排队区',
    state.reopened && state.noMatchEnter.open && state.noMatchEnter.draft === '/zzz' && state.unqueued,
    `${brief(state.noMatchEnter)} unqueued=${state.unqueued}`);
  record('生成中列表开着、有项时 Enter 插入高亮项 "/review "（不排队），仍在生成', state.inserted.draft === '/review '
    && !state.inserted.open && state.unqueuedInsert && state.running,
  `${brief(state.inserted)} unqueued=${state.unqueuedInsert} running=${state.running}`);
  record(`生成中排队的技能命令：写好参数后列表关闭，Enter 排队；排队区写回 "${QUEUED_SKILL}"，不显示展开后的 <skill> 原文`,
    final.closed && final.queued.includes(QUEUED_SKILL) && !final.queued.includes('<skill')
    && !final.queued.includes(SKILL_MARKER), oneLine(final.queued));
  record('排队的技能命令在本轮结束后发出：第二个技能调用气泡"技能 · fmt"，参数 "plain queued"', final.second.label === '技能 · fmt'
    && final.second.args === 'plain queued', JSON.stringify({ ...final.second, text: undefined }));
}

// ---------- 步骤：布局 ----------

/** @brief 中栏各栏的顶栏：宽度、模型 / 思考 / 权限按钮、溢出、裁切、会话名宽度、输入框底边；以及窗口、左栏、中栏、右栏。 */
function layoutReport(page) {
  return page.evaluate(() => {
    const visible = (el) => Boolean(el) && el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden';
    const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
    const panes = [...document.querySelectorAll('.pane-slot:not([hidden]) [data-testid="chat-pane"]')].map((pane) => {
      const bar = pane.querySelector('.topbar');
      const box = bar.getBoundingClientRect();
      const overflow = [bar, ...bar.querySelectorAll('.breadcrumb, .topbar-actions')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className);
      const clipped = [...bar.querySelectorAll('.breadcrumb > *, .topbar-actions > *, .topbar-actions button')]
        .filter(visible).filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < box.left - 1 || rect.right > box.right + 1 || rect.right > innerWidth + 1;
        }).map((el) => el.getAttribute('aria-label') || el.className || el.tagName);
      return { width: width(pane), model: visible(pane.querySelector('[data-testid="model-button"]')),
        thinking: visible(pane.querySelector('[data-testid="thinking-button"]')),
        permission: visible(pane.querySelector('[data-testid="permission-button"]')),
        permissionIcon: visible(pane.querySelector('[data-testid="permission-button"] svg')),
        modelWidth: width(pane.querySelector('[data-testid="model-button"]')),
        title: width(pane.querySelector('[data-testid="session-title"]')), overflow, clipped,
        crumb: width(bar.querySelector('.breadcrumb')), project: width(bar.querySelector('.chat-project')),
        actionsWidth: width(bar.querySelector('.topbar-actions')),
        composerBottom: Math.round(pane.querySelector('.composer')?.getBoundingClientRect().bottom ?? 0),
        actions: [...bar.querySelectorAll('.topbar-actions button')].filter(visible)
          .map((el) => el.dataset.testid || el.getAttribute('aria-label') || el.className) };
    });
    const outside = [...document.querySelectorAll('.app *')].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.right > innerWidth + 1 && !el.closest('.conversation, .panel-body');
    }).map((el) => el.className || el.tagName).slice(0, 5);
    return { window: innerWidth, height: innerHeight, page: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      sidebar: width(document.querySelector('.sidebar')), center: width(document.querySelector('.center')),
      right: width(document.querySelector('[data-testid="right-panel"]')), panes, outside };
  });
}

/** @brief 一栏的顶栏放得下：不溢出、不裁切；按钮按面板宽度显示（≤ 600px 藏起模型和思考，defaults.md），权限按钮还在。 */
function barFits(pane) {
  const buttons = pane.width > 600 ? pane.model && pane.thinking : !pane.model && !pane.thinking;
  return pane.overflow.length === 0 && pane.clipped.length === 0 && pane.permission && buttons;
}

/** 会话名至少这么宽才算"省略号截断"而不是被挤没（两个字加省略号） */
const TITLE_MIN = 30;

/** @brief 把焦点所在一栏的右栏开关切到 open，等右栏出现或消失、再等两帧。 */
async function setRight(page, open) {
  const toggle = page.locator(`${FOCUSED} .topbar`).getByRole('button', { name: '右栏：本会话的改动' });
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
  await page.waitForFunction((want) => {
    const panel = document.querySelector('[data-testid="right-panel"]');
    return (Boolean(panel) && panel.getBoundingClientRect().width > 0) === want;
  }, open, { timeout: 5000 });
  await settle(page);
}

/** @brief 1280 宽单栏（右栏关）：模型、思考按钮和权限按钮的图标都显示；顶栏放得下；各种浮层打开时没有小于 12px 的字。 */
async function wideLayout(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 1280, 800);
  await setRight(page, false);
  const report = await layoutReport(page);
  const pane = report.panes[0];
  record('1280 宽单栏：顶栏显示模型和思考按钮（面板宽于 720px，权限按钮带图标），不溢出、不裁切，会话名看得到',
    report.panes.length === 1 && pane.width > 720 && pane.model && pane.thinking && pane.permissionIcon && barFits(pane)
    && pane.title >= TITLE_MIN && report.page <= report.window, JSON.stringify(report));
  await shot(page, 'layout-1280');
  const toggle = page.locator(`${FOCUSED} [data-testid="skill-invocation"] .skill-toggle`).first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await noteSmall(ctx, '1280 单栏（技能气泡展开）');
  await typeFresh(page, '/');
  await waitMenu(page);
  await noteSmall(ctx, '1280 "/"列表');
  await typeFresh(page, '');
  for (const id of ['model', 'thinking']) {
    await page.locator(`${FOCUSED} [data-testid="${id}-button"]`).click();
    await page.getByTestId(`${id}-menu`).waitFor({ timeout: 5000 });
    await noteSmall(ctx, `1280 ${id === 'model' ? '模型' : '思考'}菜单`);
    await page.keyboard.press('Escape');
    await page.getByTestId(`${id}-menu`).waitFor({ state: 'detached', timeout: 5000 });
  }
}

/** @brief 1400 宽、右栏打开（面板 600–720px）：模型和思考按钮还在；权限按钮去掉图标、模型按钮最宽 120px（defaults.md）。 */
async function midLayout(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 1400, 800);
  await setRight(page, true);
  const report = await layoutReport(page);
  const pane = report.panes[0];
  record('1400 宽、右栏打开（面板宽 600–720px）：模型和思考按钮显示，权限按钮去掉图标，模型按钮最宽 120px；'
    + '顶栏不溢出、不裁切，会话名看得到', report.panes.length === 1 && pane.width > 600 && pane.width <= 720
    && pane.model && pane.thinking && !pane.permissionIcon && pane.modelWidth <= 121 && barFits(pane)
    && pane.title >= TITLE_MIN && report.page <= report.window, JSON.stringify(report));
  await shot(page, 'layout-1400-right');
  await noteSmall(ctx, '1400 右栏打开');
  await setRight(page, false);
  await resizeTo(ctx, 1280, 800);
}

/**
 * @brief Shift+Tab 路径：Ctrl+N 新建会话 C（焦点在输入框）后按 Shift+Tab 直到焦点进入会话树；M3 是 6 次，
 *        M6 顶栏多了模型和思考两个按钮，应为 8 次，落在新会话行。记下次数和经过的元素。
 */
async function shiftTabPath(ctx) {
  const { page } = ctx;
  ctx.c = await ctrlN(page);
  const focused = await waitComposerFocus(page);
  const path = [];
  let landed = null;
  for (let presses = 1; presses <= 12 && !landed; presses += 1) {
    await page.keyboard.press('Shift+Tab');
    const focus = await focusInfo(page);
    path.push(focus.file !== null ? `会话行 ${focus.text}` : focus.testid || focus.label || focus.text || focus.tag);
    if (focus.file !== null) landed = { presses, focus };
  }
  ctx.shiftTab = landed?.presses ?? null;
  record(`Shift+Tab：从新会话的输入框按 ${landed?.presses ?? '12+'} 次回到会话树（M3 是 6 次；M6 多模型、思考两个按钮，`
    + '应为 8 次），落在新会话行', focused && landed?.presses === 8 && samePath(landed.focus.file, ctx.c),
  `路径：${path.join(' → ')}`);
}

/** @brief 最小窗口 800×600、右栏打开：图标栏 + 中栏 + 右栏都完整，顶栏不溢出，模型和思考按钮藏起；"/"列表不被裁掉。 */
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
    && pane?.composerBottom > 0 && pane.composerBottom <= report.height, JSON.stringify(report));
  record('800×600、右栏打开：顶栏不溢出、按钮不裁切；面板窄于 600px，模型和思考按钮藏起，权限按钮还在',
    report.panes.length === 1 && pane.width <= 600 && barFits(pane), JSON.stringify(pane));
  record('800×600、右栏打开：顶栏的会话名省略号截断、仍看得到（layout.md 最小窗口"顶栏文字省略号截断而不溢出"；'
    + `chat.css"会话名不被挤出去"），宽度至少 ${TITLE_MIN}px`, pane?.title >= TITLE_MIN,
  `会话名宽 ${pane?.title}px；面包屑 ${pane?.crumb}px（项目名 ${pane?.project}px）；按钮区 ${pane?.actionsWidth}px：`
  + `${pane?.actions.join(', ')}`);
  await shot(page, 'layout-800-right');
  await noteSmall(ctx, '800×600 右栏打开');
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

/** @brief 在会话行上按 Shift+F10，用 ↓ 走到"在右侧分屏打开"再 Enter。 */
async function splitOpen(page, file) {
  await rowOf(page, file).first().focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="session-menu"]'), null,
    { timeout: 5000 });
  const labels = await menu.getByRole('menuitem').evaluateAll((items) => items.filter((item) => !item.disabled)
    .map((item) => item.childNodes[0]?.textContent ?? ''));
  for (let index = 0; index < labels.indexOf('在右侧分屏打开'); index += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitSplit(page);
  await waitPaneReady(page, 'right');
}

/** @brief 1200 宽分屏（A 在左、C 在右）：右栏关、右栏开两种情况下两栏的顶栏都放得下。 */
async function splitLayout(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 1200, 800);
  await splitOpen(page, ctx.c);
  const closed = await layoutReport(page);
  const titled = (report) => report.panes.every((pane) => pane.title >= TITLE_MIN);
  record('1200 宽分屏、右栏关：两栏的顶栏都不溢出、不裁切，会话名没被挤没；面板窄于 600px 时模型和思考按钮藏起',
    closed.panes.length === 2 && closed.panes.every(barFits) && titled(closed) && closed.page <= 1200
    && closed.outside.length === 0, JSON.stringify(closed));
  await shot(page, 'layout-1200-split');
  await noteSmall(ctx, '1200 分屏');
  await setRight(page, true);
  const open = await layoutReport(page);
  const state = await splitState(page);
  record('1200 宽分屏、右栏开：右栏贴在右边、两栏各至少 280px，两栏的顶栏都不溢出、不裁切，会话名没被挤没',
    open.panes.length === 2 && open.right > 0 && state.slots.every((slot) => slot.width >= 280)
    && open.panes.every(barFits) && titled(open) && open.page <= 1200 && open.outside.length === 0,
    JSON.stringify(open));
  await shot(page, 'layout-1200-split-right');
  await noteSmall(ctx, '1200 分屏右栏开');
  await setRight(page, false);
  await narrowSplit(ctx);
  await page.locator(`${FOCUSED} [data-testid="close-pane"]`).click();
  await waitSplit(page, false);
  await resizeTo(ctx, 1280, 800);
}

/** @brief 接着 splitLayout（分屏、右栏关）：最小窗口 800×600 时两栏的顶栏也放得下（split.md"最小 800px"）。 */
async function narrowSplit(ctx) {
  const { page } = ctx;
  await resizeTo(ctx, 800, 600);
  const report = await layoutReport(page);
  record('800×600 分屏、右栏关：图标栏 60px，两栏各约 370px，两栏的顶栏都不溢出、不裁切，会话名看得到，模型和思考按钮藏起',
    report.sidebar === 60 && report.panes.length === 2 && report.panes.every((pane) => pane.width >= 360
    && barFits(pane) && pane.title >= TITLE_MIN) && report.page <= 800 && report.outside.length === 0,
    JSON.stringify(report));
  await shot(page, 'layout-800-split');
  await noteSmall(ctx, '800×600 分屏');
  await resizeTo(ctx, 1200, 800);
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
    await typeFresh(page, '');
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
    record('pi 设置 enableSkillCommands 为 false 时只列提示词模板，不列技能命令', view.groups.join() === '提示词模板'
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
      names(view).join() === 'review,skill:fmt' && view.groups.join() === '提示词模板,技能',
      JSON.stringify({ patch, groups: view.groups, names: names(view) }));
    await typeFresh(page, '');
  });
}

/**
 * @brief 只列信任的项目里的：带 .pi 模板和技能的项目选"不信任"打开时不列它们；另一个带同样资源的项目选"信任"打开后列出。
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
    + '没有 proj-tmpl 和 skill:proj-skill', banner.includes('没有信任这个文件夹') && sortedNames(names(untrusted)) === USER_NAMES,
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

/** @brief 后台进程退出（会话不能发送）时打出 "/" 不出列表；接着 reloadKernel。 */
async function kernelExited(ctx) {
  const { page, app } = ctx;
  await openRow(page, ctx.a);
  await typeFresh(page, '');
  killKernel(app);
  // 每个会话面板各有一条退出横幅（隐藏的面板里的也在），等显示着的那条
  await page.locator(`${FOCUSED} [data-testid="kernel-exit"]`).first().waitFor({ timeout: 15000 });
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
 * @brief 接着 kernelExited：输入框有焦点、草稿是 "/" 时点"重新载入"；重新载入中（"正在重新载入…"）、
 *        会话重新打开中（"正在启动…"，会话还没打开）都不出列表，也不闪出读取失败；就绪后打出 "/" 照常出列表。
 *        "正在重新载入…"只持续一小会儿，鼠标点按钮再点回输入框赶不上，所以用 DOM 的 click() 点按钮（不移动焦点）。
 */
async function reloadKernel(ctx) {
  const { page } = ctx;
  await composer(page).focus();
  await page.evaluate((css) => {
    const banner = document.querySelector(`${css} [data-testid="kernel-exit"]`);
    [...banner.querySelectorAll('button')].find((button) => button.textContent.includes('重新载入')).click();
  }, FOCUSED);
  await page.waitForFunction((css) => !document.querySelector(`${css} [data-testid="not-ready"]`)
    && [...document.querySelectorAll(`${css} [data-testid="notice"]`)].some((n) => n.textContent.includes('已重新载入')),
  FOCUSED, { timeout: 60000 });
  await settle(page);
  const log = await page.evaluate(() => {
    window.__readinessObserver.disconnect();
    return window.__readiness;
  });
  const during = (text) => log.filter((entry) => entry.notReady === text && entry.focused && entry.draft === '/');
  const shown = log.filter((entry) => entry.menu && entry.notReady !== null);
  const failed = log.filter((entry) => (entry.menuText ?? '').includes('Unknown session'));
  const seen = [...new Set(log.map((entry) => `${entry.notReady}|${entry.focused}|${entry.draft}|${entry.menu}`))];
  record('重新载入中（"正在重新载入…"）：输入框有焦点、草稿是 "/"，不出列表', during('正在重新载入…').length > 0
    && shown.length === 0, `出现过的（说明|焦点|草稿|列表）：${seen.join(' ; ')}`);
  record('会话重新打开中（"正在启动…"，会话还没打开）：输入框有焦点、草稿是 "/"，不出列表；整个重新载入过程不闪出读取失败',
    during('正在启动…').length > 0 && shown.length === 0 && failed.length === 0,
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
  record('聊天页没有小于 12px 的文字（1280 单栏与菜单、"/"列表各状态、1400 右栏开、800 宽右栏开、1200 和 800 宽分屏）',
    ctx.small.length === 0 && ctx.smallChecked.length > 0, ctx.small.length ? ctx.small.slice(0, 5).join('; ')
      : `checked: ${ctx.smallChecked.join(' / ')}`);
}

const steps = { setup, menuList, menuArrows, menuFilter, insertEnter, insertTabClick, insertKeepsRest, noMatch,
  caretRule, imeComposition, sendSkill, sendTemplate, escWhileRunning, wideLayout, midLayout, shiftTabPath,
  narrowLayout, splitLayout, emptySession, skillCommandsOff, disabledResources, projectTrust, commandsError,
  kernelExited, fontSizes };

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
