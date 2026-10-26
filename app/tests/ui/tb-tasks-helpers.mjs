// tb-app-tasks.mjs 与 tb-app-tasks-owner.mjs 共用的读法与操作：右栏的 Background tasks（docs/specs/parallel-agents-taskboard.md
// §13.13；docs/v1/screens/team-tasks.md “界面测试用的标识”）——页签、阶段行按钮、列表的两节与卡片、task 的视图、实例的会话，
// 以及 F8 报告里的“Recent activity”。文件名不含 real、replay，spec-ids 不把它算进任何一层（里面没有编号）。

import { existsSync, readFileSync } from 'node:fs';
import { paneSel, poll, showTab } from './tb-helpers.mjs';

/** @brief 右栏开着（贴在右边或浮在上层）。 */
export const panelOpen = async (ctx) => (await ctx.page.locator('[data-testid="right-panel"]').count()) > 0;

/** @brief 右栏的页签：[{ tab（data-tab）, text, role, selected（aria-selected）, list（所在容器的 role） }]；没有时为空。 */
export function bgTabs(ctx) {
  const tabs = ctx.page.locator('[data-testid="right-panel"] [data-testid="right-tab"]');
  return tabs.evaluateAll((els) => els.map((el) => ({
    tab: el.dataset.tab, text: el.textContent.trim(), role: el.getAttribute('role'),
    selected: el.getAttribute('aria-selected'), list: el.parentElement?.getAttribute('role') ?? null })));
}

/** @brief 点一个页签（changes / tasks）。 */
export async function clickTab(ctx, which) {
  await ctx.page.locator(`[data-testid="right-panel"] [data-testid="right-tab"][data-tab="${which}"]`).click();
}

/** @brief 这个会话阶段行右端的按钮：{ text, pressed（aria-pressed）, title }；没有时为 null。 */
export async function tasksButton(ctx, tab) {
  const button = ctx.page.locator(`${paneSel(tab)} [data-testid="tasks-button"]`);
  if (!(await button.count())) return null;
  return button.evaluate((el) => ({ text: el.textContent.trim(), pressed: el.getAttribute('aria-pressed'),
    title: el.getAttribute('title') }));
}

/**
 * @brief 列表里的卡片（按显示顺序）：[{ section（running / finished）, task, phase, request, title, line,
 *        requestTitle（悬停 Request 1 的标题）, deps（Depends on 一行）, links（View transcript 的文字）, stop, finished,
 *        error（停止失败的一行） }]。
 */
export function bgCards(ctx) {
  return ctx.page.locator('[data-testid="bg-tasks"] [data-testid="bg-task"]').evaluateAll((els) => els.map((el) => ({
    section: el.closest('[data-testid="bg-section"]')?.dataset.section ?? null, task: el.dataset.task,
    phase: el.dataset.phase, request: Number(el.dataset.request),
    title: el.querySelector('.bg-task-title')?.textContent ?? '',
    line: el.querySelector('.bg-task-line')?.textContent ?? '',
    requestTitle: el.querySelector('.bg-task-line span')?.getAttribute('title') ?? null,
    deps: el.querySelector('.bg-task-links .muted')?.textContent ?? null,
    links: [...el.querySelectorAll('[data-action="view-transcript"]')].map((link) => link.textContent),
    stop: Boolean(el.querySelector('[data-action="stop-task"]')), finished: el.classList.contains('finished'),
    error: el.querySelector('.bg-error')?.textContent ?? null })));
}

/** @brief 等一张卡片满足 pred（在列表里），返回它；超时为 null。 */
export function waitCard(ctx, task, pred = () => true, timeout = 20000) {
  return poll(async () => (await bgCards(ctx)).find((card) => card.task === task && pred(card)) ?? null, timeout, 100);
}

/** @brief 点一张卡片打开它的视图。 */
export async function clickCard(ctx, task) {
  await ctx.page.locator(`[data-testid="bg-task"][data-task="${task}"] .bg-task-open`).click();
}

/** @brief 点顶部的 Back。 */
export async function clickBack(ctx) {
  await ctx.page.locator('[data-testid="right-panel"] [data-action="back"]').first().click();
}

/**
 * @brief task 的视图：{ task, title, line, request（Request 1 · <title> 一行）, links, prompt, promptTable, deps,
 *        messages: [{ head, text, table }], handoffs: [{ n, head, text, evidence, transcript }], loading, error }；
 *        不在 task 的视图时为 null。
 */
export function taskViewOf(ctx) {
  return ctx.page.locator('[data-testid="bg-task-view"]').evaluate((root) => {
    const parts = [...root.querySelectorAll('.bg-part')];
    const part = (label) => parts.find((el) => el.querySelector('.bg-label')?.textContent === label) ?? null;
    const prompt = part('Prompt');
    return {
      task: root.dataset.task, title: root.querySelector('.bg-task-head .bg-task-title')?.textContent ?? '',
      line: root.querySelector(':scope > .bg-task-line')?.textContent ?? '',
      request: [...root.querySelectorAll(':scope > .bg-line')].map((el) => el.textContent)
        .find((text) => text.startsWith('Request ')) ?? null,
      links: [...root.querySelectorAll(':scope > .bg-task-links [data-action="view-transcript"]')]
        .map((el) => el.textContent),
      prompt: prompt?.textContent ?? '', promptTable: Boolean(prompt?.querySelector('table')),
      deps: [...(part('Depends on')?.querySelectorAll('.bg-dep') ?? [])].map((el) => el.textContent),
      messages: [...root.querySelectorAll('[data-testid="bg-message"]')].map((el) => ({
        head: el.querySelector('.muted')?.textContent ?? '', text: el.textContent,
        table: Boolean(el.querySelector('table')) })),
      handoffs: [...root.querySelectorAll('[data-testid="bg-handoff"]')].map((el) => ({ n: Number(el.dataset.n),
        head: el.querySelector('.bg-handoff-head')?.textContent ?? '', text: el.textContent,
        evidence: [...el.querySelectorAll('.bg-line')].map((line) => line.textContent),
        transcript: Boolean(el.querySelector('[data-action="view-transcript"]')) })),
      loading: root.textContent.includes('Loading…'),
      error: root.querySelector('.bg-read-error')?.textContent ?? null,
    };
  }, null, { timeout: 2000 }).catch(() => null);
}

/** @brief 等 task 的视图是这个 task、读完（不在 Loading…），可再要求 pred；返回它，超时为 null。 */
export function waitTaskView(ctx, task, pred = () => true, timeout = 15000) {
  return poll(async () => {
    const view = await taskViewOf(ctx);
    return view?.task === task && !view.loading && pred(view) ? view : null;
  }, timeout, 100);
}

/**
 * @brief 实例的会话：{ kind, running（data-running）, title, model, items: [{ kind, text }], tools: [{ title, status }],
 *        doing（运行中最后一行）, empty, error, composer, replyActions, approval }；不在会话视图时为 null。
 */
export function transcriptOf(ctx) {
  return ctx.page.locator('[data-testid="bg-transcript"]').evaluate((root) => ({
    kind: root.dataset.kind, running: root.dataset.running,
    title: root.querySelector('.bg-task-title')?.textContent ?? '',
    model: root.querySelector('.bg-model')?.textContent ?? null,
    items: [...root.querySelectorAll('.bg-entry')].map((el) => {
      const first = el.firstElementChild;
      const kind = first?.classList.contains('user-message') ? 'user'
        : first?.classList.contains('assistant-message') ? 'assistant' : first?.className ?? 'empty';
      return { kind, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) };
    }),
    tools: [...root.querySelectorAll('[data-testid="tool-card"]')].map((el) => ({
      title: el.querySelector('.tool-title')?.textContent ?? '', status: el.dataset.status })),
    doing: root.querySelector('.bg-doing .stage-text')?.textContent ?? null,
    empty: root.textContent.includes('No activity yet'),
    error: root.querySelector('.bg-read-error')?.textContent ?? null,
    loading: root.textContent.includes('Loading…'), composer: Boolean(root.querySelector('textarea')),
    replyActions: Boolean(root.querySelector('[data-testid="reply-actions"]')),
    approval: Boolean(root.querySelector('[data-testid="approval-card"]')),
  }), null, { timeout: 2000 }).catch(() => null);
}

/** @brief 等会话视图读完（kind 为 task / close），返回它；超时为 null。 */
export function waitTranscript(ctx, kind, timeout = 20000) {
  return poll(async () => {
    const view = await transcriptOf(ctx);
    return view?.kind === kind && !view.loading ? view : null;
  }, timeout, 100);
}

/**
 * @brief 点某处的 View transcript（within 是它所在的容器）；role 为 null 时点第一个，'close' 时点结案会话的那个。
 */
export async function openTranscript(ctx, within, role) {
  const css = role === null ? '[data-action="view-transcript"]'
    : `[data-action="view-transcript"][data-role="${role}"]`;
  await ctx.page.locator(`${within} ${css}`).first().click();
}

/** @brief Markdown 里“## 标题”下的非空行（到下一个“## ”为止）。 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim()).filter(Boolean);
}

/** @brief 在这个会话里按 F8、写两句、保存，读保存的 Markdown：“Current view”与“Recent activity”的各行。 */
export async function issueReport(ctx, tab, what) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).press('F8');
  const dialog = ctx.page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByTestId('issue-expect').fill('The actions are in the report');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = ctx.page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const path = /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  const md = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  await ctx.page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  return { path, view: section(md, 'Current view'), actions: section(md, 'Recent activity') };
}

/**
 * @brief 在页面里记下一闪而过的状态（team-tasks.md 的“读取中”“停止中”）：task 的视图与会话出现过 Loading… 时它们的
 *        标题（window.__bgLoading，每项 { kind, title, back }），停止按钮出现过不可用（window.__bgStopping）。
 *        每次调用清空记下的。
 */
export function watchMoments(ctx) {
  return ctx.page.evaluate(() => {
    window.__bgLoading = [];
    window.__bgStopping = false;
    if (window.__bgMoments) return;
    window.__bgMoments = new MutationObserver(() => {
      if (document.querySelector('[data-action="stop-task"]:disabled')) window.__bgStopping = true;
      for (const css of ['[data-testid="bg-task-view"]', '[data-testid="bg-transcript"]']) {
        const root = document.querySelector(css);
        if (!root || !root.textContent.includes('Loading…')) continue;
        const title = root.querySelector('.bg-task-head .bg-task-title, :scope > .bg-task-title')?.textContent ?? '';
        const entry = { kind: root.dataset.testid, title, back: Boolean(root.querySelector('[data-action="back"]')) };
        if (!window.__bgLoading.some((item) => item.kind === entry.kind && item.title === entry.title)) {
          window.__bgLoading.push(entry);
        }
      }
    });
    window.__bgMoments.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  });
}

/** @brief watchMoments 记下的：{ loading, stopping }。 */
export const momentsSeen = (ctx) => ctx.page.evaluate(() => ({ loading: window.__bgLoading ?? [],
  stopping: window.__bgStopping === true }));
