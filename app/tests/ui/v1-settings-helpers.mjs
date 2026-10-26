// v1-models-app-settings.mjs 用的合成端点与页面读取（2026-10-26 为文件行数从套件挪来，写法不变；新加的只有 paneReply
// 与 sendOnly，给“发出后先看阶段行、过一会儿再等回复”的一步用，以及卡上的 Test connection 与 Keys 一行的 Test 共用的
// testOnce）：启动合成端点并收集请求日志、当前一栏的拒绝启动卡、发送与读回复、被拒绝时试着发送、范围菜单、点一次测试、
// 对话框的文字、文件夹下的文件。只操作页面或启动子进程，不记录检查结果（检查结果由套件记录）。标识见
// docs/v1/screens/models-settings.md、model-chat.md、model-menu.md。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot, sleep } from './lib.mjs';
import { PANE } from './m3-helpers.mjs';
import { poll } from './md-card-helpers.mjs';
import { textNow } from './page.mjs';

/** 当前一栏的输入框 */
export const TEXTAREA = '.pane-slot:not([hidden]) .composer textarea';
/** 当前一栏的拒绝启动卡 */
const CARD = '.pane-slot:not([hidden]) [data-testid="blocked-card"]';

// ---------- 合成端点 ----------

/**
 * @brief 启动一个合成端点（synthetic），收集它每个对话请求的 JSON 日志行。列表请求与详情请求的 JSON 行带 path
 *        （model-discovery.md §13.1、server.mjs 开头"日志"），不是对话请求，不收集。
 */
export function startFake(port, env = {}) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '5', FAKE_FIRST_DELAY_MS: '20',
      FAKE_MODELS: 'fake-coder,fake-coder-b,fake-coder-notools', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fake = { child, port, chats: [] };
  let buffer = '';
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`fake endpoint ${port} did not start within 15 s`)), 15000);
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('{')) {
          try {
            const entry = JSON.parse(line);
            if (!('path' in entry)) fake.chats.push({ ...entry, at: Date.now() });
          } catch { /* 不是日志行 */ }
        }
        if (line.includes('synthetic endpoint')) {
          clearTimeout(timer);
          done(fake);
        }
      }
    });
  });
}

/** @brief 结束一个合成端点的进程（synthetic test setup：服务停了），等它退出。 */
export async function stopFake(fake) {
  if (fake.child.exitCode !== null || fake.child.signalCode !== null) return;
  const exited = new Promise((done) => fake.child.once('exit', done));
  fake.child.kill();
  await exited;
}

/** @brief 不是探针的对话请求（since 之后）。 */
export const chatsOf = (fake, since = 0) => fake.chats.filter((chat) => !chat.probe && chat.at >= since);

// ---------- 会话 ----------

/** @brief 当前一栏的拒绝启动卡：kind、主文字、全文、按钮与候选；没有卡时为 null。 */
export function cardState(page) {
  return page.evaluate((selector) => {
    const card = document.querySelector(selector);
    if (!card) return null;
    return { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? '',
      text: card.textContent ?? '',
      actions: [...card.querySelectorAll('button[data-action]')].map((b) => ({ action: b.dataset.action,
        label: b.textContent })),
      candidates: [...card.querySelectorAll('[data-testid="candidate"]')].map((c) => ({ ref: c.dataset.ref,
        reason: c.dataset.reason, text: c.textContent })) };
  }, CARD);
}
export const waitCard = (page, test, timeout = 60000) => poll(() => cardState(page), test, timeout, 250);
export const cardText = (state) => (state ? `${state.kind}: ${state.title} [${state.actions.map((a) => a.label)
  .join(', ')}] ${state.candidates.map((c) => `${c.ref}=${c.reason}`).join(', ')}` : 'no card');

/**
 * @brief 当前一栏此刻的回复：助手消息条数、是否空闲（不在生成、不在发送）、最后一条回复的文字、错误卡或“没有可用的模型”
 *        卡的文字（没有时为 null）、阶段行的文字（没有时为 null）。
 */
export function paneReply(page) {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const list = pane?.querySelectorAll('[data-testid="assistant"]') ?? [];
    return { count: list.length, idle: pane?.dataset.running === 'false' && pane?.dataset.sending === 'false',
      text: list[list.length - 1]?.textContent ?? '',
      error: pane?.querySelector('[data-testid="error-card"], [data-testid="unavailable-card"]')?.textContent ?? null,
      stage: pane?.querySelector('[data-testid="stage"]')?.textContent ?? null };
  }, PANE);
}

/** @brief 在当前一栏输入框里写 text、按 Enter，不等回复；返回发送前的助手消息条数。 */
export async function sendOnly(page, text) {
  const before = (await paneReply(page)).count;
  await page.locator(TEXTAREA).fill(text);
  await page.locator(TEXTAREA).press('Enter');
  return before;
}

/** @brief 等助手消息多于 before 条且本轮结束（或出现错误卡），最多 timeout 毫秒；返回最后读到的样子。 */
export async function waitReply(page, before, timeout = 90000) {
  return (await poll(() => paneReply(page), (s) => (s.count > before && s.idle) || s.error, timeout, 250)).value;
}

/** @brief 发一条消息，等助手回复出现且本轮结束（或出现错误卡）；返回最后一条回复。 */
export async function sendText(ctx, text) {
  const before = await sendOnly(ctx.page, text);
  return waitReply(ctx.page, before);
}

/** @brief 被拒绝启动时试着发送：发送按钮是否不可用、Enter 后草稿是否还在、对话流和合成端点有没有新东西。 */
export async function trySend(ctx, fake, text) {
  const { page } = ctx;
  const since = Date.now();
  const users = await page.locator(`${PANE} [data-testid="user-message"]`).count();
  await page.locator(TEXTAREA).fill(text);
  const disabled = await page.locator(`${PANE} .send-button`).isDisabled();
  await page.locator(TEXTAREA).press('Enter');
  await sleep(1500);
  const kept = (await page.locator(TEXTAREA).inputValue()) === text;
  const added = (await page.locator(`${PANE} [data-testid="user-message"]`).count()) - users;
  await page.locator(TEXTAREA).fill('');
  return { disabled, kept, added, requests: chatsOf(fake, since).length };
}

/** @brief 在当前一栏输入框下面一行的范围菜单里选 pick，等按钮的 data-pick 变过去。 */
export async function choosePick(page, pick) {
  const button = page.locator(`${PANE} [data-testid="model-button"]`);
  await button.click();
  await page.locator(`[data-testid="model-menu"] [role="menuitemradio"][data-pick="${pick}"]`).click();
  return poll(() => button.getAttribute('data-pick'), (value) => value === pick, 10000);
}

/** @brief 范围菜单的全部项（data-pick），看完按 Esc 关上。 */
export async function menuPicks(page) {
  await page.locator(`${PANE} [data-testid="model-button"]`).click();
  await page.getByTestId('model-menu').waitFor({ timeout: 5000 });
  const picks = await page.locator('[data-testid="model-menu"] [role="menuitemradio"]')
    .evaluateAll((items) => items.map((item) => item.dataset.pick));
  await page.keyboard.press('Escape');
  return picks;
}

// ---------- 设置页的测试（models-settings.md “测试结果的文字”） ----------

/**
 * @brief 点一次测试按钮（卡上的 Test connection 或 Keys 一行的 Test），等按钮回到原来的文字、结果是“Connected …”或
 *        “Connection failed …”：requests 不为 null 时还要等合成端点多收到一条 requests() 里的请求；为 null 时（端点停着，
 *        收不到请求）等结果文字与点之前的不同。返回多出的请求数、按钮与结果的文字、从点击到出结果的毫秒数。
 * @param scope 按钮与结果所在的块（提供商卡或 key 行）
 * @param test 这种测试：action 是按钮的 data-action，label 是按钮平时的文字，result 是结果的 data-testid
 * @param requests () => 这次测试会发到的请求（不是探针的）；端点停着时为 null
 */
export async function testOnce(scope, test, requests) {
  const count = () => (requests ? requests().length : 0);
  const button = scope.locator(`[data-action="${test.action}"]`);
  const before = { sent: count(), result: await textNow(scope.getByTestId(test.result)) };
  const startedAt = Date.now();
  await button.click();
  const done = await poll(async () => ({ sent: count() - before.sent,
    button: await button.textContent().catch(() => ''), result: await textNow(scope.getByTestId(test.result)) }),
  (s) => s.button === test.label && /^(Connected|Connection failed)/.test(s.result ?? '')
    && (requests ? s.sent >= 1 : s.result !== before.result), 30000, 100);
  return { ...done.value, ms: Date.now() - startedAt };
}

/** @brief 对话框的标题、全文和连带改动列表。 */
export function dialogInfo(dialog) {
  return dialog.evaluate((box) => ({ title: box.querySelector('h2')?.textContent ?? '', text: box.textContent ?? '',
    cascade: [...box.querySelectorAll('[data-testid="cascade"] li')].map((li) => li.textContent) }));
}

// ---------- 文件 ----------

/** @brief 文件夹下的全部文件（递归）。 */
export function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    try {
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    } catch {
      return [];
    }
  });
}
