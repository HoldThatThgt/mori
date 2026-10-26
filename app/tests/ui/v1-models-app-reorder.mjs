// v1 模型层整机测试：设置 → Models 的拖动排序（负责人走查 M5，2026-10-26，原话“use drag to order model, not arrow button”）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），逐条检查
// docs/specs/model-providers.md §14.2 MP-24 的 2026-10-26 补（§9.1“拖动排序”、§9.5）；状态表与标识见
// docs/v1/screens/models-settings.md “拖动排序”。每条检查的名字以 MP-24 开头。步骤：
//   handles  三种列表的每行一个柄：读屏名“Reorder <名字>”（成员的“ · ”换成“, ”）、悬停“Drag or use the arrow keys to
//            reorder”、鼠标是抓手；页面上没有 Move up / Move down；只有一行的列表（Solo B 的 Models 与 Keys、分组 one 的
//            成员）没有柄
//   models   用鼠标把第三个模型拖到第一个的上半边：松开前那一行 data-drop="before"（上沿 2px 的线）、被拖的行
//            data-dragging（不透明度 0.45），松开后配置的顺序与播报；在柄上按下：移一格、保存中列表按新顺序显示且柄全部
//            aria-disabled（MutationObserver 抓），保存中再按上不发命令、焦点留在这一行的柄上、播报；第一行按上、最后一行
//            按下不发命令；F8 报告的操作记录里只有“Move model ro/fake-coder-c -2”“Move model ro/fake-coder 1”两条
//            （一次放下一条命令）
//   keys     key 从第三拖到第一（before）、从第一拖到最后一行的下半边（after，往后两格）、方向键上移（models.moveKey）
//   members  分组成员的拖动与方向键（models.saveGroup 的新顺序）
//   cross    把 key 的柄拖到模型行上：没有线，松开后线与变淡都消失，key 与模型的顺序都不变
//   editor   正在 Edit 的模型那一行（模型表单）没有柄；把别的模型拖到它上面没有线，松开后什么都不变；Cancel 后柄回来
//   inplace  放下后顺序不变的位置（被拖的 key 自己那一行的上下半边、上一行的下半边、下一行的上半边）：没有线，松开后
//            什么都不变
//   failure  保存失败：经进程桥先改配置里 Keys、Models 的顺序、删掉分组 trio（界面不重新读 models.get，还显示旧的），
//            再在界面上按一个会被后台进程拒绝的方向键：原文在列表下面、列表回到原顺序、焦点留在这一行的柄上、没有新播报
// 步骤之间互不依赖：每步只动自己的列表（cross、editor、inplace 只读），--only 时其他列表保持启动时的顺序。failure 总在
// 最后（它让 Keys、Models、分组停在没重新读的旧样子上）。
// 2026-10-26 按状态表逐行补（WP-03 的覆盖审查）：
//   handles  柄的样子：六个点的图标、淡色（--color-faint）、悬停变深（--color-text）并有 --color-hover 的底；柄在行的左端、
//            行的按钮靠右、Keys 的“Saved”紧跟标签（临时默认值，docs/v1/defaults.md“拖动排序”）
//   models   拖着的影子是整行（dragstart 里 setDragImage 的参数是被拖的 li）；能放下的行上 dragover 被接受
//            （defaultPrevented）；鼠标放下的保存中（列表按新顺序、柄全部 aria-disabled、不能拖），保存中柄的鼠标是默认的、
//            半透明（0.5）
//   keys、members  拖动放下的保存中同上；members 另查打开的会话（范围是分组 trio）立即重新校验：范围按钮的 data-current
//            从 ro/fake-coder 变成 solo/fake-coder
//   cross    不能放下的地方：别的提供商卡、别的分组、页面别处（Providers 的标题）都没有线、dragover 不被接受（鼠标显示不能
//            放下）、松开后什么都不变；拖动中按 Esc（Playwright 接管的拖放按 Esc 发 dragCancel）：线与变淡都消失，松开后
//            什么都不发
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-app-reorder.mjs [--exe <Mori.exe 路径>]
//     [--only handles,models,keys,members,cross,editor,inplace,failure]
// 结果写到 test-results/v1-models-app-reorder(-packaged).json（--only 时同一个文件，同 v1-models-app-settings.mjs），
// 截图在 test-results/v1-models-app-reorder(-packaged)/。合成端点用 4944 端口（walkthrough-1026 各包的 4920–4949）。
// 测试准备（synthetic test setup）：启动前写 model-config.json（两个提供商、一个三成员的分组 trio、一个一成员的分组 one，
// 默认范围 trio，key 不写），启动后经 models.addKey 给 Reorder A 加三个 key、给 Solo B 加一个（密文由 Mori 自己加密保存），
// 打开一个临时项目（会话的范围是 trio）；key 是测试自己生成的合成值，与任何真实服务无关。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, prepareProject, sleep } from './lib.mjs';
import { PANE, stubFolder, waitReady } from './m3-helpers.mjs';
import {
  addKeyBridge, bridge, cardOf, closeApp, configOf, modelOf, modelRow, openModels, poll, providerIn, providerOf,
  reportActions, secretsIn, seedUserData, startApp, startFake, stopFake, verified, waitProfiles,
} from './md-card-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',').filter(Boolean) ?? null;
const suffix = exePath ? '-packaged' : '';
const RESULT = `v1-models-app-reorder${suffix}`;
const shots = join(appRoot, 'test-results', RESULT);
mkdirSync(shots, { recursive: true });
const { results, record, write } = createRecorder(exePath ?? 'dev build');
const shot = (ctx, name) => ctx?.page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 合成端点的端口 */
const PORT = 4944;
/** 测试用的合成 key（synthetic） */
const SECRETS = ['synthetic-v1-reorder-key-one-R1O1', 'synthetic-v1-reorder-key-two-R2T2',
  'synthetic-v1-reorder-key-three-R3T3'];
/** Solo B 唯一的 key（synthetic）：只有一行的 Keys */
const SOLO_SECRET = 'synthetic-v1-reorder-key-solo-S1S1';
const HINT = 'Drag or use the arrow keys to reorder';
/** 两个值按 JSON 相同 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 准备与读取 ----------

/** @brief 数据目录（synthetic test setup）：Reorder A 三个模型、Solo B 一个模型，分组 trio 三个成员、one 一个成员。 */
function seed() {
  const userData = seedUserData({ providers: [
    providerOf('ro', 'Reorder A', PORT, ['fake-coder', 'fake-coder-b', 'fake-coder-c'].map((id) => modelOf(id))),
    providerOf('solo', 'Solo B', PORT, [modelOf('fake-coder')]),
  ] });
  const config = configOf(userData);
  config.groups = [{ id: 'trio', members: ['ro/fake-coder', 'ro/fake-coder-b', 'solo'] },
    { id: 'one', members: ['solo'] }];
  // 默认范围 trio：打开的会话的范围是它（members 查拖动成员后会话立即重新校验）
  config.normalDefault = 'trio';
  writeFileSync(join(userData, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return userData;
}

/** @brief 配置里 Reorder A 的模型 id、key ref 与分组 trio 的成员。 */
function orders(userData) {
  const config = configOf(userData);
  const provider = providerIn(config, 'ro');
  return { models: provider?.models.map((model) => model.id) ?? null,
    keys: provider?.keys.map((key) => key.ref) ?? null,
    members: config?.groups.find((group) => group.id === 'trio')?.members ?? null };
}

/** @brief 等配置里的某个列表（models / keys / members）变成 want。 */
const waitOrder = (ctx, list, want) => poll(() => orders(ctx.userData)[list], (value) => same(value, want), 15000);

const keyRow = (page, ref) => cardOf(page, 'ro').locator(`[data-testid="key-row"][data-ref="${ref}"]`);
const memberRow = (page, member) => page.locator(`[data-testid="group-row"][data-group="trio"] `
  + `[data-testid="group-member"][data-member="${member}"]`);
const handleOf = (row) => row.locator('[data-action="reorder"]');
/** @brief 一个列表的播报区的文字。 */
const statusOf = (page, list) => page.locator(`[data-testid="reorder-status"][data-list="${list}"]`).textContent();
/**
 * @brief 等播报区出现 text：播报在保存成功、重新读 models.get 之后才写，所以它出现时这个列表已不在保存中
 *        （柄又能拖、能按）。返回 { ok, value }。
 */
const waitSaid = (page, list, text) => poll(() => statusOf(page, list), (value) => value === text, 10000);

/**
 * @brief 拖动中读到的样子：带 data-drop 的行与位置、带 data-dragging 的行（行用 data-model / data-ref / data-member 认），
 *        以及看得见的样子：lines 是带 data-drop 的行算出的 box-shadow（线），dims 是被拖的行算出的不透明度。
 *        只认 li：输入框那一块（Composer）也有 data-drop="composer"，会话页一直挂着。
 */
function dragState(page) {
  return page.evaluate(() => {
    const name = (row) => row.dataset.model ?? row.dataset.ref ?? row.dataset.member ?? row.tagName;
    const drops = [...document.querySelectorAll('li[data-drop]')];
    const dragged = [...document.querySelectorAll('li[data-dragging="true"]')];
    return { drops: drops.map((row) => `${name(row)}:${row.dataset.drop}`), dragging: dragged.map(name),
      lines: drops.map((row) => getComputedStyle(row).boxShadow),
      dims: dragged.map((row) => getComputedStyle(row).opacity) };
  });
}

/**
 * @brief 算出的 box-shadow 是不是状态表的线：before 为上沿、after 为下沿 2px 的内阴影
 *        （Chromium 写成“<颜色> 0px 2px 0px 0px inset”）。
 */
const lineAt = (shadow, half) =>
  new RegExp(` 0px ${half === 'before' ? '' : '-'}2px 0px 0px inset$`).test(shadow ?? '');

/**
 * @brief 真的用鼠标把 handle 拖到 target 行的上半边（half 为 before）或下半边（after），或行高的某个比例处（half 为
 *        0–1 的数），松开前读一次 dragState。浏览器原生拖放，写法同 m5-helpers.mjs 的 dragWithHint。
 */
async function dragRow(page, handle, target, half) {
  // 设置页比窗口高（Groups 在下面）：先把两头滚进来（这里的柄与目标都在同一张卡或同一个分组里，两个都看得见）
  await handle.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag handle or target row is not visible');
  const x = to.x + Math.min(60, to.width / 2);
  const y = to.y + to.height * (typeof half === 'number' ? half : half === 'before' ? 0.25 : 0.75);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 4, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(x, y, { steps: 8 });
  await sleep(150);
  await page.mouse.move(x + 1, y + 1);
  await sleep(150);
  const during = await dragState(page);
  await page.mouse.up();
  await sleep(300);
  return during;
}

/** @brief 有焦点的元素：读屏名与所在行。 */
const focused = (page) => page.evaluate(() => {
  const element = document.activeElement;
  const row = element?.closest('li');
  return { label: element?.getAttribute('aria-label') ?? null,
    row: row?.dataset.model ?? row?.dataset.ref ?? row?.dataset.member ?? null };
});

/** @brief 在 row 的柄上按一个键；返回之后有焦点的元素（读屏名与所在行）。 */
async function pressOn(page, row, key) {
  await handleOf(row).focus();
  await handleOf(row).press(key);
  await sleep(300);
  return focused(page);
}

/** 三种列表在页面上的位置：所在的卡或分组、行、行的标识属性（watchList 用） */
const LISTS = {
  models: { scope: '[data-testid="provider-card"][data-provider="ro"]', rows: '[data-testid="model-row"]',
    attr: 'data-model' },
  keys: { scope: '[data-testid="provider-card"][data-provider="ro"]', rows: '[data-testid="key-row"]',
    attr: 'data-ref' },
  members: { scope: '[data-testid="group-row"][data-group="trio"]', rows: '[data-testid="group-member"]',
    attr: 'data-member' },
};

/**
 * @brief 在页面里装一个 MutationObserver，DOM 每次变化时记下一个列表（LISTS 的一项）的样子（与上一个相同时不记），抓只持续
 *        一瞬间的保存中：“<saving|idle|mixed>:<各行的标识，逗号分隔>”，saving 是每行的柄都 aria-disabled="true" 且不能拖
 *        （draggable="false"）。写法同 v1-models-app-session.mjs 的 watch。第一次看到保存中时记下柄算出的鼠标与不透明度
 *        （look）；press 不为 null 时，同时在 press 那一行的柄上发一次方向键上（同步发出，这时 React 已按保存中渲染完）。
 */
function watchList(page, list, press = null) {
  return page.evaluate(({ where, pressRow }) => {
    const rowsNow = () => [...document.querySelectorAll(`${where.scope} ${where.rows}`)];
    const handleOf = (row) => row.querySelector('[data-action="reorder"]');
    const snap = () => {
      const busy = rowsNow().map(handleOf).map((handle) => handle?.getAttribute('aria-disabled') === 'true'
        && handle.getAttribute('draggable') === 'false');
      const state = busy.length && busy.every(Boolean) ? 'saving' : busy.some(Boolean) ? 'mixed' : 'idle';
      return `${state}:${rowsNow().map((row) => row.getAttribute(where.attr)).join(',')}`;
    };
    window.__reorderSeen = [snap()];
    window.__reorderPressed = null;
    window.__reorderLook = null;
    window.__reorderObserver?.disconnect();
    window.__reorderObserver = new MutationObserver(() => {
      const value = snap();
      if (window.__reorderSeen.at(-1) !== value) window.__reorderSeen.push(value);
      if (window.__reorderLook !== null || !value.startsWith('saving:')) return;
      window.__reorderLook = rowsNow().map(handleOf).map((handle) => `${getComputedStyle(handle).cursor} `
        + `${getComputedStyle(handle).opacity}`);
      if (pressRow === null) return;
      window.__reorderPressed = value;
      document.querySelector(`${where.scope} [${where.attr}="${pressRow}"] [data-action="reorder"]`)
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    window.__reorderObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
  }, { where: LISTS[list], pressRow: press });
}

/**
 * @brief 停下 watchList，返回记下的样子（seen）、发方向键时的样子（pressed，没发时为 null）与保存中柄的样子（look：
 *        每个柄“<cursor> <opacity>”，没看到保存中时为 null）。
 */
const seenList = (page) => page.evaluate(() => {
  window.__reorderObserver?.disconnect();
  return { seen: window.__reorderSeen ?? [], pressed: window.__reorderPressed ?? null,
    look: window.__reorderLook ?? null };
});

/** @brief 保存中正好出现一次：旧顺序能用 → 新顺序保存中 → 新顺序能用（旧顺序不再出现）。 */
const savedOnce = (seen, before, after) => same(seen, [`idle:${before}`, `saving:${after}`, `idle:${after}`]);

/** @brief 保存中每个柄的鼠标是默认的、不透明度 0.5（临时默认值，docs/v1/defaults.md“拖动排序”）。 */
const savingLook = (look) => Array.isArray(look) && look.length > 0 && look.every((item) => item === 'default 0.5');

/**
 * @brief 在页面里装拖放的记录（每次拖动前重装）：包一层 DataTransfer.prototype.setDragImage，记下传进去的元素（标签与行的
 *        标识）；window 上（冒泡最后）听 dragover，记下每次落在标了 data-drag-target 的元素里的那些是否被接受
 *        （defaultPrevented：Reorder.tsx 只在能放下时 preventDefault，没被接受时鼠标显示不能放下）。
 */
function watchDrag(page) {
  return page.evaluate(() => {
    const name = (el) => el?.dataset?.model ?? el?.dataset?.ref ?? el?.dataset?.member ?? null;
    window.__dragImages = [];
    window.__dragOvers = [];
    if (!window.__dragImageWrapped) {
      const original = DataTransfer.prototype.setDragImage;
      DataTransfer.prototype.setDragImage = function setDragImage(element, x, y) {
        window.__dragImages.push({ tag: element?.tagName ?? null, row: name(element) });
        return original.call(this, element, x, y);
      };
      window.addEventListener('dragover', (event) => {
        if (event.target instanceof Element && event.target.closest('[data-drag-target]')) {
          window.__dragOvers.push(event.defaultPrevented);
        }
      });
      window.__dragImageWrapped = true;
    }
  });
}

/** @brief watchDrag 记下的：images（setDragImage 的元素）与 overs（落在目标里的 dragover 是否被接受）。 */
const dragSeen = (page) => page.evaluate(() => ({ images: window.__dragImages ?? [],
  overs: window.__dragOvers ?? [] }));

/** @brief 给拖动的目标标上 data-drag-target（watchDrag 只记落在它里面的 dragover），返回去掉标记的函数。 */
async function markTarget(target) {
  await target.evaluate((el) => el.setAttribute('data-drag-target', 'true'));
  return () => target.evaluate((el) => el.removeAttribute('data-drag-target')).catch(() => {});
}

/** @brief 没有一次被接受的 dragover：落在目标里的 dragover 至少一次、全部没有 preventDefault（鼠标显示不能放下）。 */
const refusedOver = (overs) => overs.length > 0 && overs.every((prevented) => prevented === false);

/** @brief 页面上的全部柄：所在行、读屏名、悬停、是不是按钮、算出的鼠标样子。 */
function handles(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-action="reorder"]')].map((handle) => {
    const row = handle.closest('li');
    return { row: row?.dataset.model ?? row?.dataset.ref ?? row?.dataset.member ?? null,
      label: handle.getAttribute('aria-label'), title: handle.getAttribute('title'),
      button: handle.tagName === 'BUTTON', cursor: getComputedStyle(handle).cursor };
  }));
}

/** @brief F8 保存一份报告（设置页上按 F8），返回报告里的“Move model / Move key”操作记录（去掉时刻）。 */
const movesInReport = async (page) => (await reportActions(page, 'Reorder check'))
  .filter((line) => /^Move (model|key) \S+ -?\d+$/.test(line));

/**
 * @brief 拖动中按 Esc（状态表“取消”）：同 dragRow 拖到 target，松开之前按 Escape（Playwright 接管的拖放按 Esc 发
 *        dragCancel，源行收到 dragend），读拖动中与按 Esc 之后的样子，再松开鼠标。
 */
async function dragEscape(page, handle, target, half) {
  await handle.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag handle or target row is not visible');
  const y = to.y + to.height * (half === 'before' ? 0.25 : 0.75);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 4, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(to.x + Math.min(60, to.width / 2), y, { steps: 8 });
  await sleep(150);
  await page.mouse.move(to.x + Math.min(60, to.width / 2) + 1, y + 1);
  await sleep(150);
  const during = await dragState(page);
  await page.keyboard.press('Escape');
  await sleep(300);
  const cancelled = await dragState(page);
  await page.mouse.up();
  await sleep(300);
  return { during, cancelled };
}

/** @brief 回到会话页读范围按钮的 data-current（等它变成 want，最多 10 秒），再回到设置 → Models。 */
async function rangeCurrent(page, want) {
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
  const button = page.locator(`${PANE} [data-testid="model-button"]`);
  const got = await poll(() => button.getAttribute('data-current', { timeout: 5000 }).catch(() => null),
    (value) => value === want, 10000);
  await openModels(page);
  return got.value;
}

/** @brief 点“Open folder…”打开 folder（选文件夹的对话框直接返回它；问信任时选信任），等会话就绪。 */
async function openProject(ctx, folder) {
  const { page } = ctx;
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: 'Open folder…', exact: true }).first().click();
  const trust = page.getByTestId('trust-dialog');
  if (await trust.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  }
  await waitReady(page);
}

// ---------- 步骤 ----------

/** @brief 三种列表的柄、悬停与读屏名；没有上移下移；只有一行的列表没有柄。 */
async function handlesStep(ctx) {
  const { page } = ctx;
  const found = await handles(page);
  // 页面上的顺序：卡里 Keys 在 Models 前面，Groups 在 Providers 后面
  const want = [
    ...['ro#1', 'ro#2', 'ro#3'].map((ref, i) => ({ row: ref, label: `Reorder Key ${i + 1}` })),
    ...['fake-coder', 'fake-coder-b', 'fake-coder-c'].map((id) => ({ row: `ro/${id}`, label: `Reorder ${id}` })),
    { row: 'ro/fake-coder', label: 'Reorder Reorder A, fake-coder' },
    { row: 'ro/fake-coder-b', label: 'Reorder Reorder A, fake-coder-b' },
    { row: 'solo', label: 'Reorder Solo B, all models' },
  ];
  const shape = found.map(({ row, label }) => ({ row, label }));
  record('MP-24 reorder handles: every row of Reorder A’s Models and Keys and of group trio has one button named '
    + '"Reorder <name>" (member names with ", " for " · ") with the hover "Drag or use the arrow keys to reorder" '
    + 'and the grab cursor; no other handle on the page (providers and groups themselves have none)',
  same(shape, want) && found.every((item) => item.button && item.title === HINT && item.cursor === 'grab'),
  JSON.stringify(found));
  const arrows = await page.getByRole('button', { name: /^Move (up|down)$/ }).count();
  // 只有一行的三种列表：Solo B 的 Models、Solo B 的 Keys（一个 key）、分组 one 的成员
  const singles = [modelRow(page, 'solo/fake-coder'), cardOf(page, 'solo').locator('[data-testid="key-row"]'),
    page.locator('[data-testid="group-row"][data-group="one"] [data-testid="group-member"]')];
  const rows = await Promise.all(singles.map((row) => row.count()));
  const inSingles = await Promise.all(singles.map((row) => handleOf(row).count()));
  record('MP-24 reorder handles: no Move up / Move down buttons on the page; a list with one row (Solo B’s Models, '
    + 'Solo B’s Keys, group one’s members) has no handle', arrows === 0 && same(rows, [1, 1, 1])
    && same(inSingles, [0, 0, 0]), `Move buttons ${arrows}, rows ${JSON.stringify(rows)}, handles in them `
    + JSON.stringify(inSingles));
  await handleLook(page);
}

/** grip 图标的一个小圆（icons.tsx 的 grip：圆心、半径 1.2 的两段弧） */
const DOT = /M([\d.]+) ([\d.]+)a1\.2 1\.2 0 1 0 2\.4 0a1\.2 1\.2 0 1 0-2\.4 0/g;

/** @brief 每个柄与它那一行的样子：图标的 path、算出的颜色、柄与行里各块的左右边（handleLook 用）。 */
function handleFacts(page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const resolve = (property, value) => {
      probe.style[property] = value;
      return getComputedStyle(probe)[property];
    };
    const tokens = { faint: resolve('color', 'var(--color-faint)'), text: resolve('color', 'var(--color-text)'),
      hover: resolve('backgroundColor', 'var(--color-hover)') };
    probe.remove();
    const rows = [...document.querySelectorAll('[data-action="reorder"]')].map((handle) => {
      const line = handle.parentElement;
      const style = getComputedStyle(line);
      const edge = (el) => (el ? { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }
        : null);
      const others = [...line.children].filter((child) => child !== handle).map((child) => edge(child).left);
      return { path: handle.querySelector('svg path')?.getAttribute('d') ?? '', color: getComputedStyle(handle).color,
        handle: edge(handle), others, actions: edge(line.querySelector(':scope > .row-actions')),
        lineRight: line.getBoundingClientRect().right - parseFloat(style.paddingRight),
        label: edge(line.querySelector(':scope > .key-label')),
        saved: edge(line.querySelector(':scope > .key-saved')) };
    });
    return { tokens, rows };
  });
}

/** @brief 图标是不是两列三行的六个小圆（grip）。 */
function sixDots(path) {
  const dots = [...path.matchAll(DOT)];
  const xs = new Set(dots.map((dot) => dot[1]));
  const ys = new Set(dots.map((dot) => dot[2]));
  return dots.length === 6 && dots.map((dot) => dot[0]).join('') === path && xs.size === 2 && ys.size === 3;
}

/**
 * @brief 柄与行的样子（状态表“可以排序”：六个点的图标、淡色、悬停变深；临时默认值“拖动排序”：柄在行的左端、行的按钮靠右、
 *        Keys 的“Saved”紧跟在标签后面、悬停时柄有一块 --color-hover 的底）。只有真实桌面上的观感留给走查。
 */
async function handleLook(page) {
  const { tokens, rows } = await handleFacts(page);
  const layout = rows.map((row) => ({ left: row.others.every((left) => left > row.handle.left + 1),
    right: row.actions !== null && Math.abs(row.actions.right - row.lineRight) <= 2,
    saved: row.label === null || (row.saved.left - row.label.right >= 0 && row.saved.left - row.label.right <= 16
      && row.actions.left - row.saved.right > 24) }));
  record('MP-24 reorder handles look: every handle is the six-dot grip icon in --color-faint, sits at the left end of '
    + 'its row with the row’s buttons at the right end; a key row’s "Saved" follows its label right away',
  rows.length === 9 && rows.every((row) => sixDots(row.path) && row.color === tokens.faint)
    && layout.every((item) => item.left && item.right && item.saved), JSON.stringify({ tokens, rows: rows.map((row,
    i) => ({ color: row.color, dots: sixDots(row.path), ...layout[i] })) }));
  const first = page.locator('[data-action="reorder"]').first();
  await first.scrollIntoViewIfNeeded();
  await first.hover();
  await sleep(150);
  const hovered = await first.evaluate((el) => ({ color: getComputedStyle(el).color,
    background: getComputedStyle(el).backgroundColor }));
  await page.mouse.move(0, 0);
  record('MP-24 reorder handles look: hovering a handle turns it to --color-text on a --color-hover background',
    hovered.color === tokens.text && hovered.background === tokens.hover, JSON.stringify({ hovered, tokens }));
}

/** @brief Models：鼠标把第三个拖到第一个，再用方向键把它后面那个移到最后；第一行按上、最后一行按下不发命令。 */
async function modelsStep(ctx) {
  await modelsDrop(ctx);
  await modelsKeys(ctx);
}

/** @brief Models 的鼠标拖动：fake-coder-c 拖到 fake-coder 的上半边（线、变淡、整行的影子、能放下、保存中、播报）。 */
async function modelsDrop(ctx) {
  const { page } = ctx;
  await watchDrag(page);
  const unmark = await markTarget(modelRow(page, 'ro/fake-coder'));
  await watchList(page, 'models');
  const during = await dragRow(page, handleOf(modelRow(page, 'ro/fake-coder-c')), modelRow(page, 'ro/fake-coder'),
    'before');
  const dropped = await waitOrder(ctx, 'models', ['fake-coder-c', 'fake-coder', 'fake-coder-b']);
  const said = await waitSaid(page, 'models:ro', 'fake-coder-c was dropped at position 1 of 3.');
  const drop = await seenList(page);
  const probes = await dragSeen(page);
  await unmark();
  record('MP-24 Models: dragging fake-coder-c onto the top half of fake-coder shows the line above it '
    + '(data-drop="before", a 2px inset line on its top edge) and dims the dragged row (opacity 0.45); the drop saves '
    + 'fake-coder-c first and announces "fake-coder-c was dropped at position 1 of 3."',
  same(during.drops, ['ro/fake-coder:before']) && lineAt(during.lines[0], 'before')
    && same(during.dragging, ['ro/fake-coder-c']) && same(during.dims, ['0.45']) && dropped.ok && said.ok,
  `${JSON.stringify(during)} | ${JSON.stringify(dropped.value)} | ${said.value}`);
  record('MP-24 Models: the drag image is the whole row (setDragImage gets the dragged li, ro/fake-coder-c) and the '
    + 'row it can be dropped on accepts the drag (dragover default prevented, so the cursor shows a move)',
  same(probes.images, [{ tag: 'LI', row: 'ro/fake-coder-c' }]) && probes.overs.some(Boolean), JSON.stringify(probes));
  record('MP-24 Models: right after the drop the list already shows the new order with every handle aria-disabled '
    + 'and not draggable (saving), the cursor default and the handles half transparent (0.5); then they respond '
    + 'again (the old order never comes back)', savedOnce(drop.seen, 'ro/fake-coder,ro/fake-coder-b,ro/fake-coder-c',
    'ro/fake-coder-c,ro/fake-coder,ro/fake-coder-b') && savingLook(drop.look), JSON.stringify(drop));
}

/**
 * @brief Models 的方向键：fake-coder 下移一格（焦点、播报、保存中按上不发命令），第一行按上、最后一行按下不发命令，F8 报告里
 *        只有两条移动。
 */
async function modelsKeys(ctx) {
  const { page } = ctx;
  // 保存中（柄全部 aria-disabled）时在 fake-coder 的柄上再按一次上：要是发了，它会回到第二个，操作记录多一条
  await watchList(page, 'models', 'ro/fake-coder');
  const focus = await pressOn(page, modelRow(page, 'ro/fake-coder'), 'ArrowDown');
  const keyed = await waitOrder(ctx, 'models', ['fake-coder-c', 'fake-coder-b', 'fake-coder']);
  const keySaid = await waitSaid(page, 'models:ro', 'fake-coder was dropped at position 3 of 3.');
  const { seen, pressed } = await seenList(page);
  record('MP-24 Models: ArrowDown on fake-coder’s handle moves it one place at once, focus stays on its handle and '
    + '"fake-coder was dropped at position 3 of 3." is announced', keyed.ok && focus.label === 'Reorder fake-coder'
    && focus.row === 'ro/fake-coder' && keySaid.ok,
  `${JSON.stringify(keyed.value)} | ${JSON.stringify(focus)} | ${keySaid.value}`);
  const moved = 'ro/fake-coder-c,ro/fake-coder-b,ro/fake-coder';
  record('MP-24 Models: while the move saves, the list already shows the new order and every handle is '
    + 'aria-disabled="true" and not draggable; afterwards the handles respond again in the same order (the old order '
    + 'never comes back)', same(seen, ['idle:ro/fake-coder-c,ro/fake-coder,ro/fake-coder-b', `saving:${moved}`,
    `idle:${moved}`]), JSON.stringify(seen));
  await pressOn(page, modelRow(page, 'ro/fake-coder-c'), 'ArrowUp');
  await pressOn(page, modelRow(page, 'ro/fake-coder'), 'ArrowDown');
  await sleep(700);
  const kept = orders(ctx.userData).models;
  const moves = await movesInReport(page);
  const two = same(moves, ['Move model ro/fake-coder-c -2', 'Move model ro/fake-coder 1']);
  record('MP-24 Models: ArrowUp on the first row and ArrowDown on the last send nothing; the F8 report’s recent '
    + 'actions have exactly "Move model ro/fake-coder-c -2" and "Move model ro/fake-coder 1" (one drop, one command)',
  same(kept, ['fake-coder-c', 'fake-coder-b', 'fake-coder']) && two,
  `${JSON.stringify(kept)} | ${JSON.stringify(moves)}`);
  record('MP-24 Models: ArrowUp on fake-coder’s handle while its move saves (every handle aria-disabled) sends '
    + 'nothing: no third move in the F8 report, fake-coder stays last', pressed === `saving:${moved}` && two
    && same(kept, ['fake-coder-c', 'fake-coder-b', 'fake-coder']), `pressed at ${pressed} | ${JSON.stringify(moves)}`);
}

/** @brief Keys：第三拖到第一（before）、第一拖到最后一行的下半边（after，往后两格）、方向键上移。 */
async function keysStep(ctx) {
  const { page } = ctx;
  await watchList(page, 'keys');
  const up = await dragRow(page, handleOf(keyRow(page, 'ro#3')), keyRow(page, 'ro#1'), 'before');
  const first = await waitOrder(ctx, 'keys', ['ro#3', 'ro#1', 'ro#2']);
  const firstSaid = await waitSaid(page, 'keys:ro', 'Key 3 was dropped at position 1 of 3.');
  const saving = await seenList(page);
  record('MP-24 Keys: right after dropping Key 3 above Key 1 the Keys list shows the new order with every handle '
    + 'aria-disabled and not draggable (saving, cursor default, opacity 0.5), then the handles respond again',
  savedOnce(saving.seen, 'ro#1,ro#2,ro#3', 'ro#3,ro#1,ro#2') && savingLook(saving.look), JSON.stringify(saving));
  const down = await dragRow(page, handleOf(keyRow(page, 'ro#3')), keyRow(page, 'ro#2'), 'after');
  const last = await waitOrder(ctx, 'keys', ['ro#1', 'ro#2', 'ro#3']);
  const lastSaid = await waitSaid(page, 'keys:ro', 'Key 3 was dropped at position 3 of 3.');
  record('MP-24 Keys: dragging Key 3 above Key 1 saves it first ("Key 3 was dropped at position 1 of 3."); dragging it '
    + 'onto the bottom half of the last row (line below it: data-drop="after", a 2px inset line on its bottom edge) '
    + 'moves it two places back to the end',
  same(up.drops, ['ro#1:before']) && first.ok && firstSaid.ok && same(down.drops, ['ro#2:after'])
    && lineAt(down.lines[0], 'after') && same(down.dragging, ['ro#3']) && last.ok && lastSaid.ok,
  `${JSON.stringify(up)} ${firstSaid.value} | ${JSON.stringify(down)} ${JSON.stringify(last.value)} ${lastSaid.value}`);
  const focus = await pressOn(page, keyRow(page, 'ro#2'), 'ArrowUp');
  const keyed = await waitOrder(ctx, 'keys', ['ro#2', 'ro#1', 'ro#3']);
  const said = await waitSaid(page, 'keys:ro', 'Key 2 was dropped at position 1 of 3.');
  record('MP-24 Keys: ArrowUp on Key 2’s handle moves it to the top at once (key usage order), focus stays on '
    + '"Reorder Key 2" and "Key 2 was dropped at position 1 of 3." is announced', keyed.ok
    && focus.label === 'Reorder Key 2' && focus.row === 'ro#2' && said.ok,
  `${JSON.stringify(keyed.value)} | ${JSON.stringify(focus)} | ${said.value}`);
}

/** @brief 分组成员：Solo B · all models 拖到第一，再用方向键把 Reorder A · fake-coder 下移一格。 */
async function membersStep(ctx) {
  const { page } = ctx;
  const current = await rangeCurrent(page, 'ro/fake-coder');
  await watchList(page, 'members');
  const during = await dragRow(page, handleOf(memberRow(page, 'solo')), memberRow(page, 'ro/fake-coder'), 'before');
  const dropped = await waitOrder(ctx, 'members', ['solo', 'ro/fake-coder', 'ro/fake-coder-b']);
  const said = await waitSaid(page, 'members:trio', 'Solo B, all models was dropped at position 1 of 3.');
  const saving = await seenList(page);
  record('MP-24 Groups: dragging "Solo B · all models" above the first member saves the new member order at once '
    + '(models.saveGroup) and announces "Solo B, all models was dropped at position 1 of 3."',
  same(during.drops, ['ro/fake-coder:before']) && same(during.dragging, ['solo']) && dropped.ok && said.ok,
  `${JSON.stringify(during)} | ${JSON.stringify(dropped.value)} | ${said.value}`);
  record('MP-24 Groups: right after the drop the members show the new order with every handle aria-disabled and not '
    + 'draggable (saving, cursor default, opacity 0.5), then the handles respond again',
  savedOnce(saving.seen, 'ro/fake-coder,ro/fake-coder-b,solo', 'solo,ro/fake-coder,ro/fake-coder-b')
    && savingLook(saving.look), JSON.stringify(saving));
  const revalidated = await rangeCurrent(page, 'solo/fake-coder');
  record('MP-24 Groups: the member order is the candidate order; the open session whose range is trio is re-validated '
    + 'at once: its range button\'s current model (data-current) goes from ro/fake-coder to solo/fake-coder',
  current === 'ro/fake-coder' && revalidated === 'solo/fake-coder', `${current} -> ${revalidated}`);
  const focus = await pressOn(page, memberRow(page, 'ro/fake-coder'), 'ArrowDown');
  const keyed = await waitOrder(ctx, 'members', ['solo', 'ro/fake-coder-b', 'ro/fake-coder']);
  const keySaid = await waitSaid(page, 'members:trio', 'Reorder A, fake-coder was dropped at position 3 of 3.');
  record('MP-24 Groups: ArrowDown on a member’s handle moves it one place at once, keeps focus on its handle and '
    + 'announces "Reorder A, fake-coder was dropped at position 3 of 3."', keyed.ok
    && focus.label === 'Reorder Reorder A, fake-coder' && focus.row === 'ro/fake-coder' && keySaid.ok,
  `${JSON.stringify(keyed.value)} | ${JSON.stringify(focus)} | ${keySaid.value}`);
}

/** @brief 把 key 的柄拖到模型行上：不显示线，松开后线与变淡都消失，两个列表都不变。 */
async function crossStep(ctx) {
  const { page } = ctx;
  const before = orders(ctx.userData);
  const keys = await cardOf(page, 'ro').locator('[data-testid="key-row"]').all();
  const models = await cardOf(page, 'ro').locator('[data-testid="model-row"]').all();
  const dragged = await keys[0].getAttribute('data-ref');
  await watchDrag(page);
  const unmark = await markTarget(models[1]);
  const during = await dragRow(page, handleOf(keys[0]), models[1], 'before');
  const { overs } = await dragSeen(page);
  await unmark();
  const left = await dragState(page);
  await sleep(700);
  const after = orders(ctx.userData);
  const errors = await cardOf(page, 'ro').locator('[role="alert"]').count();
  record('MP-24 a key dragged onto a model row shows no drop line and the row refuses the drag (dragover not '
    + 'accepted, so the cursor shows no-drop; the key row is dimmed while dragging); releasing it there clears the '
    + 'dimming, shows no line and changes neither list',
  same(during.dragging, [dragged]) && during.drops.length === 0 && refusedOver(overs) && left.drops.length === 0
    && left.dragging.length === 0 && same(before, after) && errors === 0,
  `${JSON.stringify(during)} | overs ${JSON.stringify(overs)} | after release ${JSON.stringify(left)} | `
    + `${JSON.stringify(before)} -> ${JSON.stringify(after)} | alerts ${errors}`);
  await elsewhereDrops(ctx);
  await escapeCancels(ctx);
}

/**
 * @brief 另几处不能放下的地方（状态表“不能放下的地方”）：Reorder A 最后一个模型拖到 Solo B 卡里的 key 行（别的提供商卡）、
 *        分组 trio 最后一个成员拖到分组 one 的成员（别的分组）、Reorder A 第一个 key 拖到 Providers 一节的标题（页面别处）。
 *        源都选离目标最近的那一行，两头同时在窗口里。每处：拖动中被拖的行变淡、没有线、目标上的 dragover 都不被接受
 *        （鼠标显示不能放下）；松开后线与变淡都消失，配置不变。
 */
async function elsewhereDrops(ctx) {
  const { page } = ctx;
  const config = configOf(ctx.userData);
  const now = orders(ctx.userData);
  const lastModel = `ro/${now.models.at(-1)}`;
  const places = [
    ['another provider card (Solo B’s key row)', modelRow(page, lastModel),
      cardOf(page, 'solo').locator('[data-testid="key-row"]').first(), lastModel],
    ['another group (group one’s member)', memberRow(page, now.members.at(-1)),
      page.locator('[data-testid="group-row"][data-group="one"] [data-testid="group-member"]').first(),
      now.members.at(-1)],
    ['elsewhere on the page (the Providers heading)', keyRow(page, now.keys[0]),
      page.getByTestId('providers').locator('h3').first(), now.keys[0]],
  ];
  const seen = [];
  for (const [label, row, target, name] of places) {
    await watchDrag(page);
    const unmark = await markTarget(target);
    const during = await dragRow(page, handleOf(row), target, 'before');
    const { overs } = await dragSeen(page);
    await unmark();
    const left = await dragState(page);
    seen.push({ label, ok: same(during.dragging, [name]) && during.drops.length === 0 && refusedOver(overs)
      && left.drops.length === 0 && left.dragging.length === 0, during, overs });
  }
  await sleep(700);
  const after = configOf(ctx.userData);
  record('MP-24 dragging a row onto another provider card, another group or elsewhere on the page (the Providers '
    + 'heading) shows no line there and the drag is refused (dragover not accepted: the cursor shows no-drop); '
    + 'releasing clears the dimming and changes nothing', seen.every((item) => item.ok)
    && same(after?.providers, config?.providers) && same(after?.groups, config?.groups), JSON.stringify(seen));
}

/**
 * @brief 拖动中按 Esc（状态表“拖动中”的 Esc 取消与“取消”）：把第一个 key 拖到最后一个 key 的下半边（能放下：有线），按
 *        Escape：线与变淡都消失；之后松开鼠标什么都不发：配置与播报都不变。
 */
async function escapeCancels(ctx) {
  const { page } = ctx;
  const before = orders(ctx.userData);
  const said = await statusOf(page, 'keys:ro');
  const [first, , last] = before.keys;
  const { during, cancelled } = await dragEscape(page, handleOf(keyRow(page, first)), keyRow(page, last), 'after');
  await sleep(700);
  const after = orders(ctx.userData);
  const saidAfter = await statusOf(page, 'keys:ro');
  record('MP-24 pressing Esc while dragging cancels: the line and the dimming go away at once, and releasing the '
    + 'mouse afterwards sends nothing (order and announcement unchanged)', same(during.drops, [`${last}:after`])
    && same(during.dragging, [first]) && cancelled.drops.length === 0 && cancelled.dragging.length === 0
    && same(before, after) && saidAfter === said, `${JSON.stringify({ during, cancelled })} | `
    + `${JSON.stringify(before.keys)} -> ${JSON.stringify(after.keys)} | said "${said}" -> "${saidAfter}"`);
}

/** @brief 正在 Edit 的模型：那一行换成模型表单，没有柄；把别的模型拖到它上面没有线，松开后什么都不变。 */
async function editorStep(ctx) {
  const { page } = ctx;
  const ids = orders(ctx.userData).models;
  await modelRow(page, `ro/${ids[1]}`).locator('[data-action="edit"]').click();
  const form = cardOf(page, 'ro').locator('[data-testid="model-form"]');
  await form.waitFor({ timeout: 10000 });
  const editor = form.locator('xpath=ancestor::li[1]');
  const editors = await editor.count();
  const inEditor = await editor.locator('[data-action="reorder"]').count();
  // 拖第三行到表单的上半边：表单那一行要是能放下，就是插在第二个位置（顺序会变），所以“没有线”不是因为顺序不变
  const during = await dragRow(page, handleOf(modelRow(page, `ro/${ids[2]}`)), editor, 0.4);
  const left = await dragState(page);
  await sleep(700);
  const after = orders(ctx.userData).models;
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 10000 });
  const back = await handleOf(modelRow(page, `ro/${ids[1]}`)).count();
  record('MP-24 Models: the row being edited (the model form) has no handle; dragging another model onto it shows '
    + 'no line, releasing there changes nothing and clears the dimming; after Cancel the row has its handle again',
  editors === 1 && inEditor === 0 && same(during.dragging, [`ro/${ids[2]}`])
    && during.drops.length === 0 && left.drops.length === 0 && left.dragging.length === 0 && same(after, ids)
    && back === 1, `editor rows ${editors}, handles in it ${inEditor} | ${JSON.stringify(during)} | after release `
    + `${JSON.stringify(left)} | ${JSON.stringify(ids)} -> ${JSON.stringify(after)} | handle after Cancel ${back}`);
}

/**
 * @brief 放下后顺序不变的位置（状态表“放下的位置”）：把中间那个 key 拖到它自己那一行的上半边、下半边，上一行的下半边，
 *        下一行的上半边，每次都在那里松开：没有线（被拖的行照样变淡，证明真的拖起来了），松开后配置与播报都不变。
 */
async function inplaceStep(ctx) {
  const { page } = ctx;
  const before = orders(ctx.userData);
  const said = await statusOf(page, 'keys:ro');
  const [above, middle, below] = before.keys;
  const spots = [[middle, 'before'], [middle, 'after'], [above, 'after'], [below, 'before']];
  const seen = [];
  for (const [ref, half] of spots) {
    const during = await dragRow(page, handleOf(keyRow(page, middle)), keyRow(page, ref), half);
    seen.push({ spot: `${ref}:${half}`, drops: during.drops, dragging: during.dragging });
  }
  await sleep(700);
  const after = orders(ctx.userData);
  const saidAfter = await statusOf(page, 'keys:ro');
  record('MP-24 Keys: dragging the middle key over a place where dropping would not change the order (its own row, '
    + 'the bottom half of the row above, the top half of the row below) shows no line; releasing there changes '
    + 'nothing and announces nothing', seen.every((spot) => spot.drops.length === 0 && same(spot.dragging, [middle]))
    && same(before, after) && saidAfter === said,
  `${JSON.stringify(seen)} | ${JSON.stringify(before)} -> ${JSON.stringify(after)} | said "${said}" -> "${saidAfter}"`);
}

/**
 * @brief 保存失败的一个列表：经进程桥先改配置（把第二项往前移一格，或删掉分组；界面不重新读 models.get，还显示旧的），
 *        再在界面上第二项的柄上按上：界面发的命令被后台进程拒绝。返回前后的样子。
 * @param spec field：orders 的字段（keys / models / members）；list：列表标识；scope：列表所在的卡或分组；
 *        rows：行的选择器；attr：行的标识属性；rowOf：(item) => 行；command：(item) => 经进程桥改配置的命令；
 *        want：(ids, item) => 之后配置里应有的样子
 */
async function staleMove(ctx, spec) {
  const { page } = ctx;
  const ids = orders(ctx.userData)[spec.field];
  const item = ids[1];
  const rowIds = () => spec.scope.locator(spec.rows).evaluateAll((rows, attr) =>
    rows.map((row) => row.getAttribute(attr)), spec.attr);
  const shown = await rowIds();
  const label = await handleOf(spec.rowOf(item)).getAttribute('aria-label');
  const said = await statusOf(page, spec.list);
  const moved = await bridge(page, spec.command(item));
  if (moved?.error) throw new Error(`${spec.command(item).type}: ${moved.error}`);
  await handleOf(spec.rowOf(item)).focus();
  await handleOf(spec.rowOf(item)).press('ArrowUp');
  const error = page.locator(`[data-testid="reorder-status"][data-list="${spec.list}"] + p.form-message.error`);
  await error.waitFor({ timeout: 10000 });
  await sleep(300);
  return { item, label, shown, said, error: await error.textContent(), rows: await rowIds(),
    rowErrors: await spec.scope.locator(`${spec.rows} .form-message.error`).count(),
    focus: await focused(page), saidAfter: await statusOf(page, spec.list), config: orders(ctx.userData)[spec.field],
    want: spec.want(ids, item) };
}

/** @brief 把 item 移到第一个之后的顺序（进程桥往前移一格之后配置里的样子）。 */
const itemFirst = (ids, item) => [item, ...ids.filter((id) => id !== item)];

/** @brief 一次被拒绝的移动是不是照状态表“保存失败”：原文在列表下面、回到原顺序、焦点留在柄上、没有播报、配置不变。 */
const refused = (got, text, row) => got.error === text && same(got.rows, got.shown) && got.rowErrors === 0
  && got.focus.label === got.label && got.focus.row === row && got.saidAfter === got.said && same(got.config, got.want);

/**
 * @brief 保存失败：Keys（models.moveKey）、Models（models.moveModel）与分组的成员（models.saveGroup）各一次被后台进程
 *        拒绝的方向键移动。
 */
async function failureStep(ctx) {
  const { page } = ctx;
  const card = cardOf(page, 'ro');
  const keys = await staleMove(ctx, { field: 'keys', list: 'keys:ro', scope: card, rows: '[data-testid="key-row"]',
    attr: 'data-ref', rowOf: (ref) => keyRow(page, ref), want: itemFirst,
    command: (ref) => ({ type: 'models.moveKey', providerId: 'ro', ref, delta: -1 }) });
  record('MP-24 Keys: a move the kernel refuses (the order changed behind the page) shows "Cannot move Key <ref> '
    + 'further" under the Keys list, not in the row; the list goes back to its order before the move, focus stays '
    + 'on that row’s handle, nothing is announced and the config keeps its order',
  refused(keys, `Cannot move Key ${keys.item} further`, keys.item), JSON.stringify(keys));
  const models = await staleMove(ctx, { field: 'models', list: 'models:ro', scope: card,
    rows: '[data-testid="model-row"]', attr: 'data-model', rowOf: (id) => modelRow(page, `ro/${id}`), want: itemFirst,
    command: (modelId) => ({ type: 'models.moveModel', providerId: 'ro', modelId, delta: -1 }) });
  record('MP-24 Models: a move the kernel refuses shows "Cannot move ro/<model> further" under the Models list, '
    + 'not in the row; the list goes back to its order before the move, focus stays on that row’s handle, nothing is '
    + 'announced and the config keeps its order',
  refused(models, `Cannot move ro/${models.item} further`, `ro/${models.item}`), JSON.stringify(models));
  const members = await staleMove(ctx, { field: 'members', list: 'members:trio',
    scope: page.locator('[data-testid="group-row"][data-group="trio"]'), rows: '[data-testid="group-member"]',
    attr: 'data-member', rowOf: (member) => memberRow(page, member), want: () => null,
    command: () => ({ type: 'models.deleteGroup', id: 'trio', dryRun: false }) });
  record('MP-24 Groups: a member move the kernel refuses (the group was deleted behind the page) shows "trio is not in '
    + 'your model settings" under the group, not in the member row; the members go back to their order before the '
    + 'move, focus stays on that member’s handle and nothing is announced',
  refused(members, 'trio is not in your model settings', members.item), JSON.stringify(members));
}

// ---------- 运行 ----------

// failure 必须在最后：它让 Keys、Models、分组停在没重新读的旧样子上
const STEPS = { handles: handlesStep, models: modelsStep, keys: keysStep, members: membersStep, cross: crossStep,
  editor: editorStep, inplace: inplaceStep, failure: failureStep };

/** @brief 启动 Mori、加四个 key（Reorder A 三个、Solo B 一个）、打开设置 → Models，等四个模型都验证完（行高不再变），再跑选中的步骤。 */
async function run() {
  let ctx;
  try {
    ctx = await startApp(seed(), exePath);
    for (const [i, secret] of SECRETS.entries()) await addKeyBridge(ctx.page, 'ro', `Key ${i + 1}`, secret);
    await addKeyBridge(ctx.page, 'solo', 'Key 1', SOLO_SECRET);
    await openProject(ctx, prepareProject('mori-v1-reorder-').project);
    await openModels(ctx.page);
    const refs = ['ro/fake-coder', 'ro/fake-coder-b', 'ro/fake-coder-c', 'solo/fake-coder'];
    const ready = await waitProfiles(ctx.page, refs, verified, 120000);
    if (!ready.ok) throw new Error(`models not verified: ${JSON.stringify(ready.value)}`);
    await poll(() => ctx.page.locator('[data-testid="probe-status"]').count(), (n) => n === 0, 15000);
    for (const [name, step] of Object.entries(STEPS)) {
      if (only && !only.includes(name)) continue;
      console.log(`[v1-models-app-reorder] step ${name}`);
      await step(ctx);
    }
  } catch (error) {
    record('MP-24 reorder: flow', false, oneLine(error, 400));
    await shot(ctx, 'reorder-error');
  } finally {
    if (ctx) {
      record('MP-24 (reorder) the page reported no errors', ctx.pageErrors.length === 0,
        ctx.pageErrors.slice(0, 3).join(' | '));
    }
    await closeApp(ctx);
  }
}

const fake = await startFake(PORT, { FAKE_MODELS: 'fake-coder,fake-coder-b,fake-coder-c' });
try {
  await run();
} finally {
  await stopFake(fake);
}
record('MP-24 no plaintext key in this test’s results',
  secretsIn(JSON.stringify(results), [...SECRETS, SOLO_SECRET]).length === 0);
process.exitCode = write(`${RESULT}.json`) ? 0 : 1;
