// M6 整机测试 m6-app-slash.mjs 的布局部分：输入框下面一行各档的边界（composer-pickers.md"新加的检查"第 1–4 条：分屏拖中线
// 凑出 279–681px、单栏 930 / 761 / 740 / 490 / 300px，生成中有字、生成中、空闲、"Medium""High""Allow all"、后台进程退出、
// 重新载入中、Restart 之后重新打开中、打开失败）和拒绝启动（no_pick，第 2、10 条），以及布局检查共用的常量和小工具。
// 2026-10-22 从 m6-app-slash.mjs 搬出来（那个文件超过了 AGENTS.md 每文件 2000 行的限制）；步骤仍由 m6-app-slash.mjs 按
// 原来的顺序和名字执行，检查记进同一份结果（bindRecorder），记录的名字没有改。

import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { killKernel, oneLine } from './lib.mjs';
import {
  ctrlN, focusInfo, openRow, settle, startRename, waitRowTitle,
} from './m3-helpers.mjs';
import { composerAt, sendAt, splitState, waitPaneReady, waitSplit } from './m5-helpers.mjs';
import {
  at1, backToApp, bandKey, buttonState, choosePick, colorStack, contrastOf, fitLeft, fitPane, KINDS, layoutBrief,
  layoutReport, NOTE, openAndPlace, openSettingsSection, paneProblems, paneWidths, placeProblems, popupBox, popupGone,
  POPUPS, resizeWindow, ringState, ROW, rowControls, seenRows, setDefaultPick, setReasoning, splitOpen,
  watchRows,
} from './m6-helpers.mjs';

/** 检查结果的记录与截图：m6-app-slash.mjs 开始前交进来（bindRecorder），这里的步骤和那边的记进同一份结果 */
let record;
let shot;

/** @brief 交进 m6-app-slash.mjs 的 record（createRecorder 的）和 shot（截图到这次的截图目录）。 */
export function bindRecorder(api) {
  ({ record, shot } = api);
}

/** 焦点所在的一栏（单栏时也带 data-focused） */
export const FOCUSED = '.pane-slot[data-focused="true"]:not([hidden])';
/** 提供商里的模型 ID：故意很长（合成端点接受任何 ID），宽栏时范围按钮停在最长 200px，窄栏时收短（models.md"窄栏"） */
export const MODEL_ID = 'fake-coder-synthetic-long-model-id-for-layout';

/** @brief 改窗口内容区的大小，等界面量到新的大小、再等两帧。 */
export async function resizeTo(ctx, width, height) {
  await resizeWindow(ctx.app, width, height);
  await ctx.page.waitForFunction(({ w, h }) => innerWidth === w && innerHeight === h, { w: width, h: height },
    { timeout: 5000 });
  await settle(ctx.page);
}

// ---------- 布局检查共用的常量和小工具 ----------

/** 第一个提供商的 id（首次启动表单的名称 "Mori endpoint" 生成） */
export const MAIN = 'mori-endpoint';
/** 中栏里显示着的会话面板（分屏时两个） */
export const PANES = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';
/**
 * 范围按钮的读屏名称、悬停说明的第二行和读屏的描述（v1：docs/v1/screens/model-menu.md"选择范围按钮"，
 * composer-pickers.md"悬停和读屏的描述"：读屏名称"Model range: <按钮文字>"，悬停第一行是按钮文字、第二行
 * "<提供商名>"，描述是第二行；首次启动的提供商名 "Mori endpoint"；2026-10-26 起不带区域）
 */
export const MODEL_LABEL = `Model range: ${MODEL_ID}`;
export const MODEL_TIP = 'Mori endpoint';
export const MODEL_DESCRIBED = 'Mori endpoint';
/** 范围换成这个提供商之后按钮上的字（"<提供商名> · <当前模型 id>"，很长，最挤的情况） */
export const PROVIDER_TEXT = `Mori endpoint · ${MODEL_ID}`;
/** 改名后很长的会话名（顶栏的检查量会话名能用多宽，chat.md"顶栏"） */
export const LONG_TITLES = { a: 'Give split-pane titles more room with English labels and a long tail (synthetic A)',
  c: 'Keep project and session names readable in narrow split panes with long names (synthetic C)' };
/** 布局检查时输入框里的草稿（生成中有字时这一行最挤） */
export const DRAFT = 'plain draft for the layout checks';
/** 分屏时拖中线让左栏落在的宽度（各档的上沿和下沿）；最后拖到最右，右栏的 .pane-slot 280px、.chat-pane 279px */
export const LEFT_WIDTHS = [280, 300, 320, 321, 340, 341, 370, 400, 401, 460, 461, 490, 600, 601, 680, 681, Infinity];
/** 分屏时要量到的宽度（composer-pickers.md"新加的检查"第 1、2 条；单栏的 740 / 761 / 930px 另量） */
export const SPLIT_WANTED = [279, 280, 300, 320, 321, 340, 341, 370, 400, 401, 460, 461, 490, 600, 601, 680, 681];
/** 单栏时要量的会话面板宽度和右栏开关（800 宽右栏打开时约 300px，到不了更窄） */
export const SINGLE_WIDTHS = [[930, false], [761, false], [740, false], [490, true], [300, true]];

/** @brief 一栏的选择器（side 为 left / right / single）。 */
export const slotCss = (side) => `.pane-slot[data-side="${side}"]:not([hidden])`;
/** @brief 一栏的会话面板的选择器。 */
export const paneCss = (side) => `${slotCss(side)} [data-testid="chat-pane"]`;
/** @brief 显示着的几栏（从左到右的 data-side）。 */
export const visibleSides = (page) => page.locator('.pane-slot:not([hidden])').evaluateAll((slots) => slots
  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((slot) => slot.dataset.side));

/**
 * @brief 记一条布局检查：有 count 栏，每一栏的顶栏和这一行都符合（paneProblems），页面不横向溢出、没有元素出窗口；
 *        extra 是这一处另外的条件（面板宽度落在哪一档等）；state 同 paneProblems（默认空闲）。
 */
export function recordBars(name, report, count, extra, state = 'idle') {
  const problems = paneProblems(report, state);
  const lines = report.panes.map((pane, index) => `${at1(pane.width)}px: ${problems[index].join(', ') || 'ok'}`);
  record(name, report.panes.length === count && problems.every((list) => list.length === 0)
    && report.page <= report.window && report.outside.length === 0 && extra,
  `${lines.join(' | ')} ${layoutBrief(report)}`);
}

/**
 * @brief 点第 index 栏的输入框，焦点换到这一栏（右栏跟随焦点：换成这一栏会话自己的开关状态，split.md），再等两帧。
 */
export async function focusPane(page, index) {
  await page.locator(PANES).nth(index).locator('.composer textarea').click();
  await page.waitForFunction(({ css, at }) => document.querySelectorAll(css)[at]?.closest('.pane-slot')
    ?.dataset.focused === 'true', { css: PANES, at: index }, { timeout: 5000 });
  await settle(page);
}

/**
 * @brief 在每一栏依次打开 kinds 里的弹出层（范围、Effort、权限菜单，圆环详情，"Queue"的下拉），量位置（placeProblems），
 *        Esc 关上。kinds 由调用方按状态给（生成中不给范围、Effort，不是生成中有字时不给"Queue"）：给了的每一种都该打得开，
 *        按钮不在或不可用（openAndPlace 返回 null）也记为问题，不跳过（不然一个都没量到时检查也会过）。
 *        先把焦点换到那一栏（免得点按钮时焦点换栏、右栏跟着开关、按钮移位）。返回 [{ side, kind, problems }]。
 */
export async function placeAll(page, kinds) {
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
      if (result === null) bad.push({ side, kind, problems: ['did not open (no button, or it is aria-disabled)'] });
      else if (result.problems.length) bad.push({ side, kind, problems: result.problems });
    }
  }
  return bad;
}

/** @brief 记一条菜单检查：每一栏的范围、Effort、权限菜单和圆环详情都往上打开、在这一栏里、按 models.md 对齐。 */
export async function recordMenus(ctx, where) {
  const bad = await placeAll(ctx.page, ['model', 'thinking', 'permission', 'usage']);
  record(`${where}：每一栏的范围、Effort 和权限菜单、圆环的详情都往上打开（下边在这一行上方 6px），整个在这一栏和窗口里、`
    + '不盖到顶栏，按 models.md 对齐（范围菜单 min(300px, 这一行) 宽、和 Effort 菜单右边对齐按钮或贴这一行左端，'
    + '权限菜单贴左端，详情贴右端）', bad.length === 0, JSON.stringify(bad));
}

/** @brief 把焦点所在一栏的右栏开关切到 open，等右栏出现或消失、再等两帧。 */
export async function setRight(page, open) {
  const toggle = page.locator(`${FOCUSED} .topbar`).getByRole('button', { name: 'Toggle changes' });
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
  await page.waitForFunction((want) => {
    const panel = document.querySelector('[data-testid="right-panel"]');
    return (Boolean(panel) && panel.getBoundingClientRect().width > 0) === want;
  }, open, { timeout: 5000 });
  await settle(page);
}

/** @brief 当前一栏这一行里范围按钮的读屏名称、悬停说明的各行、读屏的描述和描述元素在不在按钮外面。 */
export const rangeLabels = async (page) => {
  const state = await buttonState(page, 'model-button');
  return { text: state.text, name: state.name, lines: state.lines, described: state.described,
    tipOutside: state.tipOutside, inRow: state.inRow, inTopbar: state.inTopbar };
};

/** @brief 焦点所在元素的简称：这一行按钮的 data-testid、aria-label、会话行、文字或标签名。 */
export async function focusLabel(page) {
  const focus = await focusInfo(page);
  if (focus.file !== null) return `会话行 ${focus.text}`;
  return focus.composer ? 'textarea' : focus.testid || focus.label || focus.text || focus.tag;
}

/** @brief 分屏时两栏的会话都把右栏开关切到 open（右栏跟随焦点，各会话各自记住开关，split.md）。 */
export async function setRightBoth(page, open) {
  for (const index of [0, 1]) {
    await focusPane(page, index);
    await setRight(page, open);
  }
}

// ---------- 步骤：各档的边界（composer-pickers.md"新加的检查"第 1–4 条） ----------

/**
 * @brief 分屏时把左栏依次拖到 LEFT_WIDTHS 的每个宽度，每处量两栏的顶栏和这一行（layoutReport）；at(target) 是每处另外要做的事
 *        （返回值记在 extra 里）。返回 [{ target, report, extra }]。
 */
export async function sweep(page, at) {
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
export function recordSweep(name, samples, state, wanted = SPLIT_WANTED) {
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

/**
 * @brief 等 side 那一栏开始（want 为 true）或结束生成。开始只认 data-running：发送中（data-sending）这一行有字时是单个
 *        "Queue"、没有 ▾"More send options"（Composer.tsx 的 SendGroup），量"生成中有字"要等真的在生成（2026-10-24，
 *        锁屏时发送中更久，量到的是发送中）；结束要生成和发送都结束。
 */
export const waitRunningAt = (page, side, want = true, timeout = 30000) => page.waitForFunction(({ css, on }) => {
  const pane = document.querySelector(css);
  if (on) return pane?.dataset.running === 'true';
  return pane?.dataset.running !== 'true' && pane?.dataset.sending !== 'true';
}, { css: paneCss(side), on: want }, { timeout });

/** @brief 停下所有在生成的栏（点"Stop"），等它们都结束。 */
export async function stopAll(page) {
  for (const side of await visibleSides(page)) {
    const stop = page.locator(`${slotCss(side)} ${ROW} .stop-button`);
    if (await stop.count()) await stop.click();
    await waitRunningAt(page, side, false, 30000);
  }
}

/** @brief 分屏 A | C、1280 宽、两栏右栏都关；已经分屏时只把在生成的栏停下、把窗口放回 1280 宽。 */
export async function ensureSplit(ctx) {
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
export async function renameTo(page, file, title) {
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
export async function bandPrep(ctx) {
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
    + `" · <模型 id>"），data-pick 是提供商、data-current 是当前模型；读屏名称"Model range: <按钮文字>"（" · "换成", "），悬停两行`
    + `（按钮文字、"${MODEL_TIP}"），读屏的描述"${MODEL_DESCRIBED}"`, range.text === PROVIDER_TEXT
    && parts.scope === 'Mori endpoint' && parts.model === ` · ${MODEL_ID}` && button.pick === MAIN
    && button.current === `${MAIN}/${MODEL_ID}` && range.name === `Model range: Mori endpoint, ${MODEL_ID}`
    && range.lines.join('|') === `${PROVIDER_TEXT}|${MODEL_TIP}` && range.described === MODEL_DESCRIBED,
  JSON.stringify({ range, parts, pick: button.pick, current: button.current }));
}

/**
 * @brief 一个菜单里看得见的项（读屏名称：去掉 aria-hidden 的快捷键提示）、aria-keyshortcuts 和焦点所在的项。
 *        宽于 400px 时"Queue for later"由 CSS 藏起（display: none，不在读屏树里），不算。
 */
export const sendMenu = (page, side) => page.evaluate((css) => {
  const menu = document.querySelector(`${css} .split-button [role="menu"]`);
  if (!menu) return null;
  const name = (item) => [...item.childNodes].filter((node) => node.nodeType === 3 || (node.nodeType === 1
    && node.getAttribute('aria-hidden') !== 'true')).map((node) => node.textContent).join('').trim();
  const items = [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => item.getClientRects().length > 0);
  return { items: items.map(name), keys: items.map((item) => item.getAttribute('aria-keyshortcuts')),
    focused: items.includes(document.activeElement) ? name(document.activeElement) : null };
}, slotCss(side));

/** @brief side 那一栏排队区的条数。 */
export const queuedCount = (page, side) => page.locator(`${slotCss(side)} [data-testid="queue"] .queue-text`).count();

/**
 * @brief 生成中、输入框有字、这一栏 ≤ 400px（"Queue"收起，models.md"很窄"）：从文字框 Tab 到 ▾（经过权限、范围、Effort、
 *        圆环），Enter 打开 → 焦点在"Queue for later"，↓ 到"Steer"，Esc 回到 ▾；再 Enter、Enter 选"Queue for later"：
 *        排队区多一条，"Queue ▾"消失、焦点回到文字框。最后把草稿写回去。返回看到的。
 */
export async function queueKeys(page, side) {
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
export const queueKeysOk = (seen) => seen?.path.join() === 'permission-button,model-button,thinking-button,usage,'
  + 'More send options' && seen.menu?.items.join() === 'Queue for later,Steer'
  && seen.menu.keys.join() === 'Enter,Control+Enter' && seen.menu.focused === 'Queue for later'
  && seen.down === 'Steer' && seen.back === 'More send options' && seen.after.queued && seen.after.focus === 'textarea'
  && seen.after.toggle === 0 && seen.after.draft === '';

/** @brief 宽于 400px 时点 ▾：菜单里只有"Steer"（没有"Queue for later"），Esc 关上。 */
export async function steerOnly(page, side) {
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
export async function bandTyped(ctx) {
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
    + ' → 模式名 → Effort 的先后，宽于 400px 时模式名不截，三个按钮不窄于最窄；范围按钮的原因在第三行（2026-10-26 起仍可打开菜单）、Effort 不可用、原因在第二行',
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
 *        "…"，✓ 不收；每项的 title 是全名或原因。Esc 关上。
 */
export async function menuItemsFit(page, side) {
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
        inside: item.scrollWidth <= item.clientWidth + 1 };
    }));
  const width = await page.getByTestId('model-menu').evaluate((el) => el.getBoundingClientRect().width);
  await page.keyboard.press('Escape');
  return { width, items };
}

/**
 * @brief 分屏、两栏空闲（输入框里还有字，"Send"可用）：拖到各档的上沿和下沿量两栏，每处打开两栏的范围、Effort、权限菜单和
 *        圆环详情；顶栏 ≤ 400px 时内边距收小；280px 时范围菜单收到这一行的宽、项名截断。最后（右栏 279px）在右栏按
 *        F8，报告的"Current view"里"Pane width"是右栏 .chat-pane 的宽度（比 .pane-slot 窄 1px），还有"Model range"、
 *        "Effort""Model""Permission mode"。
 */
export async function bandIdle(ctx) {
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
export function recordNarrowMenu(seen) {
  const cut = (fact) => fact && fact.width < fact.full - 0.01;
  const long = seen?.items.filter((item) => cut(item.name)) ?? [];
  record('280px 一栏（这一行约 226px）：范围菜单收到这一行的宽；放不下的项名（很长的模型 id）截断加"…"，✓ 不收、'
    + '不溢出；每项的悬停是全名', Boolean(seen) && seen.width <= 227 && long.length > 0
    && long.every((item) => item.name.ellipsis && item.title.length > 0)
    && seen.items.every((item) => item.inside), JSON.stringify(seen));
}

/** @brief 最新的一份 F8 报告（<userData>/ui-issues 里最后一个 .md）的文字；没有时为空串。 */
export function latestIssue(ctx) {
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
export async function f8PaneWidth(ctx) {
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
export async function closeSplit(ctx) {
  const { page } = ctx;
  if ((await splitState(page)).split) {
    await page.locator(`${slotCss('right')} [data-testid="close-pane"]`).click();
    await waitSplit(page, false);
  }
  await resizeTo(ctx, 1280, 800);
}

/** @brief 单栏时依次调到 SINGLE_WIDTHS 的每个宽度，量顶栏和这一行，打开 kinds 里的弹出层；返回 [{ target, report, extra }]。 */
export async function singleSamples(ctx, kinds) {
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
export async function bandSingle(ctx) {
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
export async function levelIn(page, side, level) {
  await page.locator(`${slotCss(side)} ${ROW} [data-testid="thinking-button"]`).click();
  await page.locator(`[data-testid="thinking-menu"] [role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction(({ css, want }) => {
    const button = document.querySelector(css);
    return button?.dataset.level === want && button.dataset.pending !== 'true'
      && button.getAttribute('aria-disabled') !== 'true';
  }, { css: `${slotCss(side)} ${ROW} [data-testid="thinking-button"]`, want: level }, { timeout: 15000 });
}

/** @brief 在 side 那一栏的权限菜单里选 mode（"Allow all"要在确认框里再点一次），等按钮显示它。 */
export async function permissionIn(page, side, mode) {
  await page.locator(`${slotCss(side)} ${ROW} [data-testid="permission-button"]`).click();
  await page.getByTestId('permission-menu').getByRole('menuitemradio', { name: mode }).click();
  if (mode === 'Allow all') await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Allow all' }).click();
  await page.waitForFunction(({ css, want }) => document.querySelector(css)
    ?.querySelector('[data-testid="permission-button"]')?.textContent?.trim() === want,
  { css: slotCss(side), want: mode }, { timeout: 10000 });
}

/** @brief 在 设置 → Models 里把会话 A、C 用的长模型标上或去掉"Supports thinking"，回到会话。 */
export async function markLongModel(ctx, on) {
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
export async function bandEffort(ctx) {
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
export async function allowAllAt280(page, seen) {
  await permissionIn(page, 'left', 'Allow all');
  seen.all = await layoutReport(page);
  seen.contrast = contrastOf(await colorStack(page, `${slotCss('left')} ${ROW} .permission-text`));
  seen.lead = await page.locator(`${slotCss('left')} ${ROW} .permission-text`)
    .evaluate((el) => el.textContent.slice(0, 2));
}

/** @brief bandEffort 看到的。 */
export function recordEffortBands(seen) {
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
 *        （范围按钮的描述前面是提供商名；权限、Effort 的描述里没有第一行）；圆环保留最后一次的用量（data-tokens 不变），
 *        详情仍能打开。
 */
export async function recordExited(ctx, before, menuClosed) {
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
 * @brief watchRows 的一个样子里三个按钮都不可用、读屏的描述是 wait（范围按钮是"<提供商名>. <wait>"）。
 */
export const reopenReasons = (row, wait) => ['permission', 'model', 'thinking'].every((kind) => row[kind]?.aria)
  && row.permission.reason === wait && row.thinking.reason === wait
  && row.model.reason === `${MODEL_DESCRIBED}. ${wait}`;

/**
 * @brief Restart 时 watchRows 记下的会话 A（单栏）的样子：重新载入中（"Restarting…"）和重新打开中（"Starting…"）权限、范围、
 *        Effort 按钮和圆环都还在（不像第一次打开那样藏起范围和 Effort），三个按钮不可用、原因就是按钮位置的那句话；这一行
 *        高 33px、不溢出。
 */
export function recordReopen(rows) {
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
export async function exitBands(ctx) {
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
export async function failRestart(ctx) {
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
export function recordFailed(rows, inTextarea, samples) {
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
export async function defaultPickTo(ctx, value) {
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
export async function changeModelFromCard(page, side) {
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
export async function tabsFrom(page, side) {
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
export async function bandBlocked(ctx) {
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
export function recordBlocked({ path, range, samples, card, gone }) {
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
