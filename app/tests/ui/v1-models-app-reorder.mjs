// v1 模型层整机测试：设置 → Models 的拖动排序（负责人走查 M5，2026-10-26，原话“use drag to order model, not arrow button”）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），逐条检查
// docs/specs/model-providers.md §14.2 MP-24 的 2026-10-26 补（§9.1“拖动排序”、§9.5）；状态表与标识见
// docs/v1/screens/models-settings.md “拖动排序”。每条检查的名字以 MP-24 开头。步骤：
//   handles  三种列表的每行一个柄：读屏名“Reorder <名字>”（成员的“ · ”换成“, ”）、悬停“Drag or use the arrow keys to
//            reorder”；页面上没有 Move up / Move down；只有一行的列表（Solo B 的 Models）没有柄
//   models   用鼠标把第三个模型拖到第一个的上半边：松开前那一行 data-drop="before"、被拖的行 data-dragging，松开后配置的
//            顺序与播报；在柄上按下：移一格、焦点留在这一行的柄上、播报；第一行按上、最后一行按下不发命令；F8 报告的
//            操作记录里只有“Move model ro/fake-coder-c -2”“Move model ro/fake-coder 1”两条（一次放下一条命令）
//   keys     key 从第三拖到第一（before）、从第一拖到最后一行的下半边（after，往后两格）、方向键上移（models.moveKey）
//   members  分组成员的拖动与方向键（models.saveGroup 的新顺序）
//   cross    把 key 的柄拖到模型行上：没有线，松开后 key 与模型的顺序都不变
// 步骤之间互不依赖：每步只动自己的列表（cross 只读），--only 时其他列表保持启动时的顺序。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-app-reorder.mjs [--exe <Mori.exe 路径>] [--only handles,models,keys,members,cross]
// 结果写到 test-results/v1-models-app-reorder(-packaged).json（--only 时同一个文件，同 v1-models-app-settings.mjs），
// 截图在 test-results/v1-models-app-reorder(-packaged)/。合成端点用 4944 端口（walkthrough-1026 各包的 4920–4949）。
// 测试准备（synthetic test setup）：启动前写 model-config.json（两个提供商、一个三成员的分组，key 不写），启动后经
// models.addKey 加三个 key（密文由 Mori 自己加密保存）；key 是测试自己生成的合成值，与任何真实服务无关。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  addKeyBridge, cardOf, closeApp, configOf, modelOf, modelRow, openModels, poll, providerIn, providerOf, readText,
  secretsIn, seedUserData, startApp, startFake, stopFake, verified, waitProfiles,
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
const HINT = 'Drag or use the arrow keys to reorder';
/** 两个值按 JSON 相同 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 准备与读取 ----------

/** @brief 数据目录（synthetic test setup）：Reorder A 三个模型、Solo B 一个模型，分组 trio 三个成员。 */
function seed() {
  const userData = seedUserData({ providers: [
    providerOf('ro', 'Reorder A', PORT, ['fake-coder', 'fake-coder-b', 'fake-coder-c'].map((id) => modelOf(id))),
    providerOf('solo', 'Solo B', PORT, [modelOf('fake-coder')]),
  ] });
  const config = configOf(userData);
  config.groups = [{ id: 'trio', members: ['ro/fake-coder', 'ro/fake-coder-b', 'solo'] }];
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

/** @brief 拖动中读到的样子：带 data-drop 的行与位置、带 data-dragging 的行（行用 data-model / data-ref / data-member 认）。 */
function dragState(page) {
  return page.evaluate(() => {
    const name = (row) => row.dataset.model ?? row.dataset.ref ?? row.dataset.member ?? row.tagName;
    return { drops: [...document.querySelectorAll('[data-drop]')].map((row) => `${name(row)}:${row.dataset.drop}`),
      dragging: [...document.querySelectorAll('[data-dragging="true"]')].map(name) };
  });
}

/**
 * @brief 真的用鼠标把 handle 拖到 target 行的上半边（half 为 before）或下半边（after），松开前读一次 dragState。
 *        浏览器原生拖放，写法同 m5-helpers.mjs 的 dragWithHint。
 */
async function dragRow(page, handle, target, half) {
  // 设置页比窗口高（Groups 在下面）：先把两头滚进来（这里的柄与目标都在同一张卡或同一个分组里，两个都看得见）
  await handle.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag handle or target row is not visible');
  const x = to.x + Math.min(60, to.width / 2);
  const y = to.y + to.height * (half === 'before' ? 0.25 : 0.75);
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

/** @brief 在 row 的柄上按一个键；返回之后有焦点的元素（读屏名与所在行）。 */
async function pressOn(page, row, key) {
  await handleOf(row).focus();
  await handleOf(row).press(key);
  await sleep(300);
  return page.evaluate(() => {
    const focused = document.activeElement;
    const row = focused?.closest('li');
    return { label: focused?.getAttribute('aria-label') ?? null,
      row: row?.dataset.model ?? row?.dataset.ref ?? row?.dataset.member ?? null };
  });
}

/** @brief 页面上的全部柄：所在行、读屏名、悬停、是不是按钮。 */
function handles(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-action="reorder"]')].map((handle) => {
    const row = handle.closest('li');
    return { row: row?.dataset.model ?? row?.dataset.ref ?? row?.dataset.member ?? null,
      label: handle.getAttribute('aria-label'), title: handle.getAttribute('title'),
      button: handle.tagName === 'BUTTON' };
  }));
}

/** @brief F8 保存一份报告（设置页上按 F8），返回报告里的“Move model / Move key”操作记录（去掉时刻）。 */
async function movesInReport(page) {
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-what').fill('Reorder check');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const path = /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  await page.keyboard.press('Escape');
  const lines = (path && readText(path)) || '';
  return lines.split(/\r?\n/).map((line) => /Move (model|key) \S+ -?\d+/.exec(line)?.[0]).filter(Boolean);
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
    + '"Reorder <name>" (member names with ", " for " · ") with the hover "Drag or use the arrow keys to reorder"',
  same(shape, want) && found.every((item) => item.button && item.title === HINT), JSON.stringify(found));
  const arrows = await page.getByRole('button', { name: /^Move (up|down)$/ }).count();
  const solo = await handleOf(modelRow(page, 'solo/fake-coder')).count();
  record('MP-24 reorder handles: no Move up / Move down buttons on the page; a list with one row (Solo B’s Models) has '
    + 'no handle', arrows === 0 && solo === 0 && await modelRow(page, 'solo/fake-coder').count() === 1,
  `Move buttons ${arrows}, Solo B handles ${solo}`);
}

/** @brief Models：鼠标把第三个拖到第一个，再用方向键把它后面那个移到最后；第一行按上、最后一行按下不发命令。 */
async function modelsStep(ctx) {
  const { page } = ctx;
  const during = await dragRow(page, handleOf(modelRow(page, 'ro/fake-coder-c')), modelRow(page, 'ro/fake-coder'),
    'before');
  const dropped = await waitOrder(ctx, 'models', ['fake-coder-c', 'fake-coder', 'fake-coder-b']);
  const said = await waitSaid(page, 'models:ro', 'fake-coder-c was dropped at position 1 of 3.');
  record('MP-24 Models: dragging fake-coder-c onto the top half of fake-coder shows the line above it '
    + '(data-drop="before") and dims the dragged row; the drop saves fake-coder-c first and announces '
    + '"fake-coder-c was dropped at position 1 of 3."', same(during.drops, ['ro/fake-coder:before'])
    && same(during.dragging, ['ro/fake-coder-c']) && dropped.ok && said.ok,
  `${JSON.stringify(during)} | ${JSON.stringify(dropped.value)} | ${said.value}`);
  const focus = await pressOn(page, modelRow(page, 'ro/fake-coder'), 'ArrowDown');
  const keyed = await waitOrder(ctx, 'models', ['fake-coder-c', 'fake-coder-b', 'fake-coder']);
  const keySaid = await waitSaid(page, 'models:ro', 'fake-coder was dropped at position 3 of 3.');
  record('MP-24 Models: ArrowDown on fake-coder’s handle moves it one place at once, focus stays on its handle and '
    + '"fake-coder was dropped at position 3 of 3." is announced', keyed.ok && focus.label === 'Reorder fake-coder'
    && focus.row === 'ro/fake-coder' && keySaid.ok,
  `${JSON.stringify(keyed.value)} | ${JSON.stringify(focus)} | ${keySaid.value}`);
  await pressOn(page, modelRow(page, 'ro/fake-coder-c'), 'ArrowUp');
  await pressOn(page, modelRow(page, 'ro/fake-coder'), 'ArrowDown');
  await sleep(700);
  const kept = orders(ctx.userData).models;
  const moves = await movesInReport(page);
  record('MP-24 Models: ArrowUp on the first row and ArrowDown on the last send nothing; the F8 report’s recent '
    + 'actions have exactly "Move model ro/fake-coder-c -2" and "Move model ro/fake-coder 1" (one drop, one command)',
  same(kept, ['fake-coder-c', 'fake-coder-b', 'fake-coder'])
    && same(moves, ['Move model ro/fake-coder-c -2', 'Move model ro/fake-coder 1']),
  `${JSON.stringify(kept)} | ${JSON.stringify(moves)}`);
}

/** @brief Keys：第三拖到第一（before）、第一拖到最后一行的下半边（after，往后两格）、方向键上移。 */
async function keysStep(ctx) {
  const { page } = ctx;
  const up = await dragRow(page, handleOf(keyRow(page, 'ro#3')), keyRow(page, 'ro#1'), 'before');
  const first = await waitOrder(ctx, 'keys', ['ro#3', 'ro#1', 'ro#2']);
  const firstSaid = await waitSaid(page, 'keys:ro', 'Key 3 was dropped at position 1 of 3.');
  const down = await dragRow(page, handleOf(keyRow(page, 'ro#3')), keyRow(page, 'ro#2'), 'after');
  const last = await waitOrder(ctx, 'keys', ['ro#1', 'ro#2', 'ro#3']);
  const lastSaid = await waitSaid(page, 'keys:ro', 'Key 3 was dropped at position 3 of 3.');
  record('MP-24 Keys: dragging Key 3 above Key 1 saves it first ("Key 3 was dropped at position 1 of 3."); dragging it '
    + 'onto the bottom half of the last row (line below it, data-drop="after") moves it two places back to the end',
  same(up.drops, ['ro#1:before']) && first.ok && firstSaid.ok
    && same(down.drops, ['ro#2:after']) && same(down.dragging, ['ro#3']) && last.ok && lastSaid.ok,
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
  const during = await dragRow(page, handleOf(memberRow(page, 'solo')), memberRow(page, 'ro/fake-coder'), 'before');
  const dropped = await waitOrder(ctx, 'members', ['solo', 'ro/fake-coder', 'ro/fake-coder-b']);
  const said = await waitSaid(page, 'members:trio', 'Solo B, all models was dropped at position 1 of 3.');
  record('MP-24 Groups: dragging "Solo B · all models" above the first member saves the new member order at once '
    + '(models.saveGroup) and announces "Solo B, all models was dropped at position 1 of 3."',
  same(during.drops, ['ro/fake-coder:before']) && same(during.dragging, ['solo']) && dropped.ok && said.ok,
  `${JSON.stringify(during)} | ${JSON.stringify(dropped.value)} | ${said.value}`);
  const focus = await pressOn(page, memberRow(page, 'ro/fake-coder'), 'ArrowDown');
  const keyed = await waitOrder(ctx, 'members', ['solo', 'ro/fake-coder-b', 'ro/fake-coder']);
  const keySaid = await waitSaid(page, 'members:trio', 'Reorder A, fake-coder was dropped at position 3 of 3.');
  record('MP-24 Groups: ArrowDown on a member’s handle moves it one place at once, keeps focus on its handle and '
    + 'announces "Reorder A, fake-coder was dropped at position 3 of 3."', keyed.ok
    && focus.label === 'Reorder Reorder A, fake-coder' && focus.row === 'ro/fake-coder' && keySaid.ok,
  `${JSON.stringify(keyed.value)} | ${JSON.stringify(focus)} | ${keySaid.value}`);
}

/** @brief 把 key 的柄拖到模型行上：不显示线，松开后两个列表都不变。 */
async function crossStep(ctx) {
  const { page } = ctx;
  const before = orders(ctx.userData);
  const keys = await cardOf(page, 'ro').locator('[data-testid="key-row"]').all();
  const models = await cardOf(page, 'ro').locator('[data-testid="model-row"]').all();
  const during = await dragRow(page, handleOf(keys[0]), models[1], 'before');
  await sleep(700);
  const after = orders(ctx.userData);
  const errors = await cardOf(page, 'ro').locator('[role="alert"]').count();
  record('MP-24 a key dragged onto a model row shows no drop line and dropping it there changes neither list',
    during.drops.length === 0 && same(before, after) && errors === 0,
    `${JSON.stringify(during)} | ${JSON.stringify(before)} -> ${JSON.stringify(after)} | alerts ${errors}`);
}

// ---------- 运行 ----------

const STEPS = { handles: handlesStep, models: modelsStep, keys: keysStep, members: membersStep, cross: crossStep };

/** @brief 启动 Mori、加三个 key、打开设置 → Models，等四个模型都验证完（行高不再变），再按顺序跑选中的步骤。 */
async function run() {
  let ctx;
  try {
    ctx = await startApp(seed(), exePath);
    for (const [i, secret] of SECRETS.entries()) await addKeyBridge(ctx.page, 'ro', `Key ${i + 1}`, secret);
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
record('MP-24 no plaintext key in this test’s results', secretsIn(JSON.stringify(results), SECRETS).length === 0);
process.exitCode = write(`${RESULT}.json`) ? 0 : 1;
