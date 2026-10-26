// M3 整机测试里新建会话的两个 +（docs/v0/screens/sessions.md"项目行的 +""打开、新建与切换"、layout.md"左栏收起"；
// 2026-10-26 负责人走查 M9，WP-06）：由 m3-app.mjs 在同一次运行里调用（同一个 Mori、同一个合成端点，synthetic），
// 检查结果用 ctx.record 记。
// 项目行与它的 +（plusButtons、plusOf、clickPlus）；鼠标不在上面时也一直显示、淡色 --color-faint、项目行不因为 + 变高
// （plusLook）；悬停时正文颜色、底色同别的图标按钮悬停时（plusHover）；文件夹名很长、左栏 180px 时先截项目名（longProjectName）；
// 上一个新会话还在"Starting…"时 + 照常可用（plusWhileStarting）；收起的图标栏上的七个图标按钮（railButtons）；
// 点图标栏的 +：在当前会话所在的项目里新建（railPlus），没有当前会话时等于"Open folder…"（railNoSession）；
// 需要时先问信任（saveInDelta 存一个会话、重启后 plusTrust）。

import { basename } from 'node:path';
import { sleep } from './lib.mjs';
import {
  activeFile, allRows, answerTrustDialog, clickOpenFolder, liveInfo, paneCount, paneOf, resizeMain, restoreMain,
  rowState, samePath, sendWait, startDelete, stubFolder, treeState, until, waitComposerFocus, waitPanes, waitReady,
} from './m3-helpers.mjs';

/** 新会话（还没有名字和消息）的名字 */
const NEW_SESSION = 'New session';
/** 收起的图标栏上"Open sidebar"之后依次的按钮名（layout.md"左栏收起"） */
const RAIL_NAMES = ['New session (Ctrl+N)', 'Open folder…', 'Customize', 'Memory', 'Report a UI issue (F8)',
  'Settings'];
/** saveInDelta 在 delta 里发的消息（含 "plain" 让合成端点只回文字） */
const DELTA_MESSAGE = 'plain 德尔塔项目里存下来的会话';

// ---------- 读项目行与 + ----------

/**
 * @brief 会话树里每个项目行和它的 +：工作目录、项目行的文字和悬停，+ 的读屏名、悬停、tabIndex、是否不可用、
 *        图标颜色、不透明度、离项目行右边几 px。
 */
export function plusButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="session-tree"] .project-group')]
    .map((group) => {
      const heading = group.querySelector('.project-heading');
      const plus = heading?.querySelector('[data-testid="project-new-session"]');
      const right = (el) => el.getBoundingClientRect().right;
      return { cwd: group.dataset.cwd, name: heading?.textContent?.trim() ?? '',
        headingTip: heading?.getAttribute('title') ?? '', label: plus?.getAttribute('aria-label') ?? null,
        tip: plus?.getAttribute('title') ?? null, tabIndex: plus?.tabIndex ?? null, disabled: plus?.disabled ?? null,
        color: plus ? getComputedStyle(plus.querySelector('svg')).color : null,
        opacity: plus ? Number(getComputedStyle(plus).opacity) : null,
        gap: plus ? Math.round(right(heading) - right(plus)) : null };
    }));
}

/** @brief 工作目录为 folder 的项目行上的 +。 */
export async function plusOf(page, folder) {
  const index = (await treeState(page)).findIndex((group) => samePath(group.cwd, folder));
  if (index < 0) throw new Error(`no project row for ${folder}`);
  return page.locator('[data-testid="session-tree"] .project-group').nth(index).getByTestId('project-new-session');
}

/** @brief + 图标此刻的颜色。 */
export const plusColor = (plus) => plus.evaluate((el) => getComputedStyle(el.querySelector('svg')).color);

/**
 * @brief 点 folder 项目行上的 +，等新会话加入并就绪；返回新会话的行（当前会话那一行）、焦点是否在输入框、
 *        会话面板多了几个。
 */
export async function clickPlus(page, folder) {
  const before = await paneCount(page);
  await (await plusOf(page, folder)).click();
  await waitPanes(page, before + 1);
  await waitReady(page);
  const row = await rowState(page, await activeFile(page));
  return { row, focused: await waitComposerFocus(page), added: await paneCount(page) - before };
}

/** @brief 页面里 CSS 变量 token 算出来的值（prop 为 color 或 backgroundColor），与 getComputedStyle 的写法相同。 */
function tokenColor(page, token, prop = 'color') {
  return page.evaluate(({ name, key }) => {
    const probe = document.createElement('span');
    probe.style[key] = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe)[key];
    probe.remove();
    return value;
  }, { name: token, key: prop });
}

// ---------- 常态与悬停 ----------

/**
 * @brief 鼠标不在左栏上时每个项目行的 +（sessions.md"项目行的 +"常态）：一直显示（有框、24×24、opacity 为 1、
 *        visibility 为 visible），图标是 --color-faint；项目行不因为 + 变高（与同一行藏起 + 时一样高；不是状态表的行，
 *        是 M9 的布局细节，登记在 docs/v0/defaults.md"项目行的 +"）。
 */
export async function plusLook(ctx) {
  const { page, record } = ctx;
  await page.mouse.move(0, 0);
  const faint = await tokenColor(page, '--color-faint');
  const shown = await page.locator('[data-testid="project-new-session"]').evaluateAll((items) => items.map((plus) => {
    const style = getComputedStyle(plus);
    const icon = getComputedStyle(plus.querySelector('svg'));
    const box = plus.getBoundingClientRect();
    return { rects: plus.getClientRects().length, width: Math.round(box.width), height: Math.round(box.height),
      opacity: style.opacity, iconOpacity: icon.opacity, visibility: style.visibility, color: icon.color };
  }));
  record('项目行的 +：鼠标不在左栏上时也一直显示（每个 + 都有框、24×24，opacity 为 1，visibility 为 visible，'
    + '不用悬停才出现），图标是淡色 --color-faint', shown.length >= 2 && shown.every((item) => item.rects > 0
    && item.width === 24 && item.height === 24 && item.opacity === '1' && item.iconOpacity === '1'
    && item.visibility === 'visible' && item.color === faint), JSON.stringify({ faint, shown }));
  const heights = await page.locator('[data-testid="session-tree"] .project-heading').evaluateAll((items) => items
    .map((heading) => {
      const plus = heading.querySelector('[data-testid="project-new-session"]');
      const withPlus = heading.getBoundingClientRect().height;
      plus.style.display = 'none';
      const without = heading.getBoundingClientRect().height;
      plus.style.display = '';
      return { withPlus, without };
    }));
  record('项目行的 +（临时默认值，defaults.md）：项目行不因为 + 变高（与同一行藏起 + 时一样高）', heights.length >= 2
    && heights.every((item) => item.without > 0 && Math.abs(item.withPlus - item.without) < 1),
  JSON.stringify(heights));
}

/**
 * @brief 鼠标在 + 上（sessions.md"项目行的 +"悬停）：图标变成正文颜色 --color-text；底色同别的图标按钮悬停时
 *        （左栏顶部"Close sidebar"那个图标按钮悬停时量到的底色，也就是 --color-hover）。
 */
export async function plusHover(ctx, plus) {
  const { page, record } = ctx;
  const text = await tokenColor(page, '--color-text');
  const hoverToken = await tokenColor(page, '--color-hover', 'backgroundColor');
  const toggle = page.locator('[data-testid="sidebar"] .rail-toggle');
  await toggle.hover();
  const other = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  await plus.hover();
  const now = await plus.evaluate((el) => ({ icon: getComputedStyle(el.querySelector('svg')).color,
    background: getComputedStyle(el).backgroundColor }));
  await page.mouse.move(0, 0);
  record('项目行的 +：鼠标移上去时图标变成正文颜色（--color-text），底色同别的图标按钮悬停时（左栏的"Close sidebar"'
    + '悬停时的底色，--color-hover）', now.icon === text && now.background === other && other === hoverToken,
  JSON.stringify({ text, hoverToken, other, now }));
}

// ---------- 左栏很窄、文件夹名很长 ----------

/** @brief 按 ← / → 把左栏分隔线挪到 want（每次 20px），最多 10 次；返回挪到的宽度。 */
export async function sidebarTo(page, want) {
  const divider = page.locator('[data-resize="sidebar"]');
  await divider.focus();
  for (let presses = 0; presses < 10; presses += 1) {
    const value = Number(await divider.getAttribute('aria-valuenow'));
    if (value === want) return value;
    await page.keyboard.press(value > want ? 'ArrowLeft' : 'ArrowRight');
  }
  return Number(await divider.getAttribute('aria-valuenow'));
}

/** @brief 工作目录为 folder 的项目行此刻的样子：左栏宽度、项目名是否被截、+ 的宽度与位置、项目行是否溢出。 */
async function headingFit(page, folder) {
  const index = (await treeState(page)).findIndex((group) => samePath(group.cwd, folder));
  if (index < 0) return null;
  return page.locator('[data-testid="session-tree"] .project-group').nth(index).evaluate((group) => {
    const heading = group.querySelector('.project-heading');
    const name = heading.querySelector('span');
    const plus = heading.querySelector('[data-testid="project-new-session"]');
    const box = (el) => el.getBoundingClientRect();
    return { sidebar: Math.round(box(document.querySelector('.sidebar')).width), text: name.textContent,
      cut: name.scrollWidth > name.clientWidth + 1, ellipsis: getComputedStyle(name).textOverflow,
      plus: Math.round(box(plus).width), plusAfterName: box(plus).left >= box(name).right - 1,
      plusInside: box(plus).right <= box(heading).right + 1, overflow: heading.scrollWidth > heading.clientWidth + 1 };
  });
}

/**
 * @brief 左栏拉到 180px（< 220px）时文件夹名很长（ctx.folders.long）的项目行（sessions.md 会话行"状态"、"项目行的 +"
 *        常态）：项目名先省略号截断（文字仍是完整的文件夹名），+ 不被挤出去（24px、在项目名右边、项目行之内），项目行不溢出。
 *        先在这个文件夹里新建一个会话让它出现在会话树里；量完左栏挪回原来的宽度，删掉这个会话（还没有消息，没有文件要删）。
 */
export async function longProjectName(ctx) {
  const { page, record } = ctx;
  const folder = ctx.folders.long;
  await clickOpenFolder(ctx, folder);
  await waitReady(page);
  const file = await activeFile(page);
  const original = Number(await page.locator('[data-resize="sidebar"]').getAttribute('aria-valuenow'));
  await sidebarTo(page, 180);
  await sleep(300);
  const narrow = await headingFit(page, folder);
  await ctx.shot(page, '11b-long-project-name');
  await sidebarTo(page, original);
  record('左栏窄于 220px（拉到 180px）、文件夹名很长时：项目名先省略号截断（文字仍是完整的文件夹名），+ 不被挤出去'
    + '（24px，在项目名右边、项目行之内），项目行不溢出', Boolean(narrow) && narrow.sidebar < 220
    && narrow.text === basename(folder) && narrow.cut && narrow.ellipsis === 'ellipsis' && narrow.plus === 24
    && narrow.plusAfterName && narrow.plusInside && !narrow.overflow, JSON.stringify(narrow));
  const dialog = await startDelete(page, file);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
}

// ---------- 上一个新会话还在打开 ----------

/**
 * @brief 在页面里运行（经 page.evaluate 序列化）：点 alpha 行上的 +，等新的一栏出现（最多 60 帧），记下这时中栏的说明和
 *        每个 + 是否可用，紧接着点 beta 行上的 +。按工作目录找项目行（新会话加进来后项目的顺序会变）。
 */
async function clickTwice({ alpha, beta }) {
  const plusOf = (cwd) => [...document.querySelectorAll('[data-testid="session-tree"] .project-group')]
    .find((group) => group.dataset.cwd === cwd)?.querySelector('[data-testid="project-new-session"]');
  const frame = () => new Promise((done) => requestAnimationFrame(done));
  const count = () => document.querySelectorAll('.pane-slot').length;
  const start = count();
  plusOf(alpha).click();
  for (let tries = 0; tries < 60 && count() === start; tries += 1) await frame();
  const pane = document.querySelector('.pane-slot:not([hidden]) [data-testid="chat-pane"]');
  const waiting = pane?.querySelector('[data-testid="not-ready"]')?.textContent ?? null;
  const pluses = [...document.querySelectorAll('[data-testid="project-new-session"]')]
    .map((plus) => ({ disabled: plus.disabled, tip: plus.title, label: plus.getAttribute('aria-label') }));
  plusOf(beta).click();
  return { waiting, pluses };
}

/**
 * @brief 上一个新会话还在打开（"Starting…"）时（sessions.md"项目行的 +"）：点 alpha 行上的 + 不等它打开，这时每个项目行的
 *        + 都可用（不是 disabled，悬停是"New session in <文件夹名>"）；再点 beta 行上的 +：两个新会话都建成（alpha、beta
 *        各一个，名为"New session"，没有出错），当前会话是 beta 的那个。在页面里连着点（element.click()），免得测试的往返
 *        比打开会话还慢；不可用的按钮 click() 不起作用，所以两个会话都建成也说明当时 + 可用。
 */
export async function plusWhileStarting(ctx) {
  const { page, record } = ctx;
  const groups = await treeState(page);
  const cwdOf = (folder) => groups.find((group) => samePath(group.cwd, folder))?.cwd;
  const known = (await allRows(page)).map((row) => row.id);
  const panes = await paneCount(page);
  const seen = await page.evaluate(clickTwice, { alpha: cwdOf(ctx.folders.alpha), beta: cwdOf(ctx.folders.beta) });
  await waitPanes(page, panes + 2);
  await waitReady(page);
  const fresh = async () => (await allRows(page)).filter((row) => !known.includes(row.id));
  const made = await until(async () => {
    const rows = await fresh();
    return rows.length === 2 && rows.every((row) => row.file && row.status === null) ? rows : null;
  }, 15000) || await fresh();
  const current = await rowState(page, await activeFile(page));
  record('上一个新会话还在打开（"Starting…"）时：每个项目行的 + 照常可用（不是 disabled，悬停"New session in <文件夹名>"）；'
    + '再点另一个项目（beta）行上的 +，两个新会话都建成（alpha、beta 各一个，名为"New session"，没有出错），当前会话是 beta 的',
  seen.waiting === 'Starting…' && seen.pluses.length >= 2 && seen.pluses.every((plus) => plus.disabled === false
    && plus.label?.startsWith('New session in ') && plus.tip === plus.label) && made.length === 2
    && made.every((row) => row.title === NEW_SESSION && row.status === null)
    && made.some((row) => samePath(row.cwd, ctx.folders.alpha))
    && made.some((row) => samePath(row.cwd, ctx.folders.beta))
    && samePath(current?.cwd, ctx.folders.beta) && current.title === NEW_SESSION,
  JSON.stringify({ seen, made, current }));
}

// ---------- 图标栏的 + ----------

/**
 * @brief 左栏收起为图标栏（窄窗口、不浮动）时的按钮（layout.md"左栏收起"、sessions.md"项目行的 +"左栏收起为图标栏）：
 *        依次是"Open sidebar"、+、Open folder…、Customize、Memory、Report a UI issue (F8)、Settings，都只有图标（.nav-label
 *        藏起、没有显示的文字），名字在读屏名（Playwright 按无障碍名找得到）和悬停（title）里；没有项目行的 +。
 */
export async function railButtons(ctx) {
  const { page, record } = ctx;
  const sidebar = page.getByTestId('sidebar');
  const buttons = await sidebar.evaluate((el) => [...el.querySelectorAll('button')]
    .filter((button) => button.getClientRects().length > 0)
    .map((button) => ({ label: button.getAttribute('aria-label'), tip: button.getAttribute('title'),
      icon: Boolean(button.querySelector('svg')), text: button.innerText.trim(),
      labels: [...button.querySelectorAll('.nav-label')].map((label) => getComputedStyle(label).display) })));
  const spoken = [];
  for (const name of RAIL_NAMES) spoken.push(await sidebar.getByRole('button', { name, exact: true }).count());
  const [toggle, ...rest] = buttons;
  record('左栏收起为图标栏：依次是"Open sidebar"、+（New session (Ctrl+N)）、Open folder…、Customize、Memory、'
    + 'Report a UI issue (F8)、Settings，都是只有图标的按钮（没有显示的文字），名字在读屏名和悬停里；没有项目行的 +',
  buttons.length === RAIL_NAMES.length + 1 && Boolean(toggle?.label?.startsWith('Open sidebar'))
    && toggle.tip === toggle.label && toggle.icon && toggle.text === '' && rest.every((item, index) => item.icon
      && item.tip === RAIL_NAMES[index] && item.text === '' && item.labels.every((display) => display === 'none'))
    && spoken.every((count) => count === 1), JSON.stringify({ buttons, spoken }));
}

/** @brief 点图标栏上的 +，等新会话就绪；返回新会话的行、焦点是否在输入框、左栏是否仍是收起（不浮动）、面板多了几个。 */
async function clickRail(page) {
  const before = await paneCount(page);
  await page.getByTestId('rail-new-session').click();
  await waitPanes(page, before + 1);
  await waitReady(page);
  const row = await rowState(page, await activeFile(page));
  const focused = await waitComposerFocus(page);
  const rail = await page.getByTestId('sidebar').evaluate((el) => el.classList.contains('collapsed')
    && !el.classList.contains('floating'));
  return { row, focused, rail, added: await paneCount(page) - before };
}

/**
 * @brief 左栏收起（不浮动）时点图标栏上的 +（sessions.md"新会话（Ctrl+N，或收起的图标栏上的 +）"、"项目行的 +"左栏收起
 *        为图标栏）：在当前会话所在的项目里新建并切过去，名为"New session"，焦点在输入框，左栏仍是收起的图标栏。
 */
export async function railPlus(ctx) {
  const { page, record } = ctx;
  const current = await rowState(page, await activeFile(page));
  const made = await clickRail(page);
  record('左栏收起时点图标栏上的 +：在当前会话所在的项目里新建会话并切过去，名为"New session"，焦点在输入框；'
    + '左栏仍是收起的图标栏（不浮动）', Boolean(current) && made.added === 1 && Boolean(made.row?.active)
    && made.row.title === NEW_SESSION && samePath(made.row.cwd, current.cwd) && made.focused && made.rail,
  JSON.stringify({ current, ...made }));
}

/**
 * @brief 没有当前会话（重启后中栏是"Open a folder"）时，窄窗口下点收起的图标栏上的 +（sessions.md"新会话（Ctrl+N，或收起的
 *        图标栏上的 +）"）：等于"Open folder…"，在选的文件夹（系统对话框换成直接返回 alpha）里新建会话，名为"New session"，
 *        焦点在输入框，左栏仍是收起的图标栏。最后把窗口改回原来的大小。
 */
export async function railNoSession(ctx) {
  const { app, page, record } = ctx;
  const empty = await page.getByTestId('open-folder').isVisible().catch(() => false);
  const current = await page.locator('.session-item.active').count();
  ctx.bounds = await app.evaluate(resizeMain, { width: 900, height: 700 });
  try {
    await page.waitForFunction(() => innerWidth < 1024 && document.querySelector('[data-testid="sidebar"]')
      ?.classList.contains('collapsed'), null, { timeout: 5000 });
    await stubFolder(app, ctx.folders.alpha);
    const made = await clickRail(page);
    record('没有当前会话时点收起的图标栏上的 +：等于"Open folder…"（在选的文件夹 alpha 里新建会话并切过去，名为'
      + '"New session"，焦点在输入框），左栏仍是收起的图标栏', empty && current === 0 && made.added === 1
      && Boolean(made.row?.active) && made.row.title === NEW_SESSION && samePath(made.row.cwd, ctx.folders.alpha)
      && made.focused && made.rail, JSON.stringify({ empty, current, ...made }));
  } finally {
    await app.evaluate(restoreMain, ctx.bounds);
    ctx.bounds = null;
  }
  await page.waitForFunction(() => innerWidth >= 1024
    && !document.querySelector('[data-testid="sidebar"]')?.classList.contains('collapsed'), null, { timeout: 5000 });
}

// ---------- 需要时先问信任 ----------

/**
 * @brief 在 delta（带项目扩展、没有记住选择）里新建一个会话（问信任时按 Esc，不信任、不记住），发一条消息让它保存下来，
 *        重启后 delta 的项目行在会话树里（plusTrust 用）。
 */
export async function saveInDelta(ctx) {
  await clickOpenFolder(ctx, ctx.trust.delta.project);
  await answerTrustDialog(ctx.page, { answer: 'esc' });
  await sendWait(ctx, DELTA_MESSAGE);
}

/**
 * @brief 需要时先问信任（sessions.md"项目行的 +"点了 +）：重启后（本次还没回答过）点 delta 行上的 +：先弹
 *        "Trust this workspace?"（路径是 delta），回答之前中栏已切到新会话、显示"Starting…"；按 Esc（不信任）后新会话在
 *        delta，名为"New session"，焦点在输入框，按不信任打开（projectTrust 为 untrusted）。
 */
export async function plusTrust(ctx) {
  const { page, record } = ctx;
  const { project } = ctx.trust.delta;
  const before = await paneCount(page);
  await (await plusOf(page, project)).click();
  const dialog = page.getByTestId('trust-dialog');
  const asked = await dialog.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const path = asked ? await dialog.getByTestId('trust-path').innerText() : null;
  const waiting = await paneOf(page).getByTestId('not-ready').innerText({ timeout: 2000 }).catch(() => '');
  const panes = await paneCount(page);
  if (asked) await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await waitReady(page);
  const file = await activeFile(page);
  const row = await rowState(page, file);
  const focused = await waitComposerFocus(page);
  const info = await liveInfo(page, file);
  record('需要时先问信任：重启后点要信任、本次还没回答过的项目（delta）行上的 +，先弹"Trust this workspace?"（路径是这个'
    + '项目），回答之前中栏已切到新会话、显示"Starting…"；按 Esc 后新会话在 delta，名为"New session"，焦点在输入框，'
    + '按不信任打开', asked && samePath(path, project) && waiting === 'Starting…' && panes === before + 1
    && Boolean(row?.active) && row.title === NEW_SESSION && samePath(row.cwd, project) && focused
    && info.projectTrust === 'untrusted', JSON.stringify({ asked, path, waiting, panes, before, row, focused,
    trust: info.projectTrust }));
}
