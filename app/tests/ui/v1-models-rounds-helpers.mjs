// 两段探针（docs/specs/model-providers.md §7.8，2026-10-31）的整机测试共用的部分：启动与关掉 Mori、读档案与
// model-profiles.json、打开项目、设置页 Models、模型行、发一条消息。v1-models-app-rounds.mjs 与 v1-models-app-ttft.mjs 用；
// 做法同 v1-models-app-nooff.mjs 里的同名函数（那边没有导出）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './lib.mjs';
import { paneOf, settle, stubFolder, until, waitIdle, waitReady } from './m3-helpers.mjs';
import { probeStep } from '../fake-endpoint/probes.mjs';

/** @brief 用 ctx.userData 启动 Mori（exePath 为 null 时用开发构建），等左栏出来。 */
export async function startApp(ctx, exePath) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByRole('button', { name: 'Open folder…', exact: true }).first().waitFor({ timeout: 60000 });
}

/** @brief 关掉 Mori。 */
export async function stopApp(ctx) {
  if (!ctx.app) return;
  await ctx.app.close().catch(() => {});
  ctx.app = null;
}

/** @brief 经进程桥发一条命令（只用于读状态：models.get）。 */
export const bridge = (page, command) => page.evaluate((item) => window.mori.request(item), command);
/** @brief models.get 的结果。 */
export const modelsInfo = (page) => bridge(page, { type: 'models.get' });

/** @brief 数据目录里 model-profiles.json 的档案（读不出时为空列表）。 */
export function storedProfiles(ctx) {
  try {
    return JSON.parse(readFileSync(join(ctx.userData, 'model-profiles.json'), 'utf8')).profiles ?? [];
  } catch {
    return [];
  }
}

/** @brief model-profiles.json 里模型 id 为 modelId、地址为 baseUrl 的档案；没有时为 null。 */
export function storedProfile(ctx, baseUrl, modelId) {
  return storedProfiles(ctx).find((item) => item.baseUrl === baseUrl && item.modelId === modelId) ?? null;
}

/**
 * @brief 等 test(profiles) 为真（profiles 为 models.get 的档案），返回最后读到的档案；等不到时抛错，说明里带 what。
 */
export async function profilesWhen(page, test, what, timeout = 180000) {
  let last = {};
  const ok = await until(async () => {
    last = (await modelsInfo(page)).profiles ?? {};
    return test(last);
  }, timeout, 500);
  if (!ok) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last).slice(0, 400)}`);
  return last;
}

/** @brief 点"Open folder…"打开 folder（会问信任时选"Trust workspace"），等新会话就绪。 */
export async function openProject(ctx, folder) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: 'Open folder…', exact: true }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll('.pane-slot').length > count
    || Boolean(document.querySelector('[data-testid="trust-dialog"]')), before, { timeout: 30000 });
  const trust = page.getByTestId('trust-dialog');
  if (await trust.isVisible().catch(() => false)) {
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  }
  await waitReady(page);
  await settle(page);
}

/** @brief 回到会话：设置页开着时点"Back to app"。 */
export async function toChat(page) {
  const view = page.getByTestId('settings-page');
  if (await view.isVisible().catch(() => false)) {
    await view.getByRole('button', { name: 'Back to app', exact: true }).click();
    await view.waitFor({ state: 'detached', timeout: 10000 });
  }
  if (await paneOf(page).count() > 0) await waitReady(page);
}

/** @brief 打开设置页的 Models 分节（已经在那里时什么也不做）。 */
export async function toModels(page) {
  if (await page.getByTestId('models-section').isVisible().catch(() => false)) return;
  await toChat(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
}

/** @brief 模型行此刻的样子：data-probe、状态行（data-state 与文字，没有时为 null）、有没有 Verify again；没有这一行为 null。 */
export function profileRow(page, ref) {
  return page.evaluate((target) => {
    const row = document.querySelector(`[data-testid="model-row"][data-model="${target}"]`);
    if (!row) return null;
    const status = row.querySelector('[data-testid="probe-status"]');
    const verify = status?.querySelector('[data-action="verify"]');
    const text = status ? status.textContent.slice(0, status.textContent.length - (verify?.textContent.length ?? 0))
      : '';
    return { probe: row.dataset.probe ?? null, status: status && { state: status.dataset.state, text: text.trim() },
      verifyAgain: Boolean(verify) };
  }, ref);
}

/** @brief 等模型行满足 test，最多 timeout 毫秒；返回最后读到的样子。 */
export async function rowWhen(page, ref, test, timeout = 10000) {
  let row = null;
  await until(async () => {
    row = await profileRow(page, ref);
    return Boolean(row) && test(row);
  }, timeout, 200);
  return row;
}

/** @brief 当前一栏的输入框、用户消息、助手回答、错误卡与换模型提示的条数。 */
export const composer = (page) => paneOf(page).locator('.composer textarea');
export const userCount = (page) => paneOf(page).getByTestId('user-message').count();
export const errorCount = (page) => paneOf(page).getByTestId('error-card').count();
export const switchCount = (page) => paneOf(page).locator('[data-testid="notice"][data-kind="model-switch"]').count();

/** @brief 发一条消息，等它显示出来，再等本轮结束（最多 timeout 毫秒）。 */
export async function sendTurn(page, text, timeout = 120000) {
  const before = await userCount(page);
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await until(async () => (await userCount(page)) > before, 10000, 100);
  await waitIdle(page, timeout);
}

/** @brief 代理记下的发给 model 的探针请求的步（server.mjs 的 probeStep：3、4、5、6、7，图片为 8），按到达的顺序。 */
export const probeStepsOf = (ep, model) => ep.bodies.filter((body) => body.probe && body.model === model)
  .map((body) => probeStep(body.messages));
