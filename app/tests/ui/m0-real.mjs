// M0 真实端点走查（走查项 2–3）：测试连接 →"总结 README"，确认流式文字与原生工具调用。
// 脚本不接触 key：先用 --setup 打开 Mori，由你在界面里填连接并保存（key 由 Mori 加密保存），关闭窗口；
// 之后不带 --setup 运行，脚本用同一个数据目录走查。用法：
//   node tests/ui/m0-real.mjs --user-data <目录> --setup [--exe <Mori.exe 路径>]
//   node tests/ui/m0-real.mjs --user-data <目录> [--exe <Mori.exe 路径>]
// 数据目录专门用于走查，不要用日常使用的 %APPDATA%\Mori。结果写到 test-results/m0-real.json。

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { _electron as electron } from 'playwright-core';
import { startNetWatch } from './net-watch.mjs';
import { pageHelpers } from './page.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const userData = arg('user-data') ? resolve(arg('user-data')) : null;
const exePath = arg('exe') ? resolve(arg('exe')) : null;
if (!userData) throw new Error('Missing --user-data');
const oneLine = (text, max = 300) => String(text).replace(/\s+/g, ' ').slice(0, max);
const launch = () => {
  const env = { ...process.env, MORI_USER_DATA: userData };
  return electron.launch(exePath ? { executablePath: exePath, env } : { args: [appRoot], cwd: appRoot, env });
};

/** @brief --setup：打开 Mori，等你填好连接、保存并关闭窗口。 */
async function setup() {
  const app = await launch();
  console.log('Mori 已打开：在连接表单里填 Base URL、API key、Model ID 和 Context window，保存并测试后关闭窗口。');
  await new Promise((done) => app.process().once('exit', done));
  console.log(`已退出。数据目录：${userData}`);
}

/** @brief 读取已保存连接的非机密信息；确认 models.json 里没有 key。 */
function savedConnection() {
  const provider = JSON.parse(readFileSync(join(userData, 'pi', 'models.json'), 'utf8')).providers?.['mori-endpoint'];
  if (!provider) throw new Error('No saved connection: run with --setup first');
  const model = provider.models?.[0];
  return { baseUrl: provider.baseUrl, model: model?.id, contextWindow: model?.contextWindow,
    keyInModelsJson: 'apiKey' in provider };
}

const results = { target: exePath ?? 'dev build', checks: [] };

/** @brief 记录一项检查。 */
function record(name, ok, detail = '') {
  results.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** @brief 当前会话最后一条回复的正文（不含思考和工具卡）。 */
const lastReply = (page) => page.evaluate(() => {
  const replies = document.querySelectorAll('.pane-slot:not([hidden]) [data-testid="assistant"]');
  return [...(replies[replies.length - 1]?.querySelectorAll('.prose') ?? [])].map((el) => el.textContent).join('\n');
});

/**
 * @brief 发一条消息并等本轮结束；期间每 100 毫秒采样阶段行文字（去掉秒数，变化才记录）和最后一条回复正文的长度。
 *        M1 起阶段行是 [data-testid="stage"]，回复是 [data-testid="assistant"] 里的 .prose。
 */
async function sendAndWatch(page, text) {
  const h = pageHelpers(page);
  const started = Date.now();
  await page.evaluate(() => {
    window.__m0 = { statuses: [], lengths: new Set() };
    clearInterval(window.__m0Timer);
    window.__m0Timer = setInterval(() => {
      const stage = document.querySelector('[data-testid="stage"]')?.textContent?.replace(/\s\d+(\.\d+)?s$/, '');
      if (stage && window.__m0.statuses.at(-1) !== stage) window.__m0.statuses.push(stage);
      const replies = document.querySelectorAll('.pane-slot:not([hidden]) [data-testid="assistant"]');
      const prose = [...(replies[replies.length - 1]?.querySelectorAll('.prose') ?? [])];
      const length = prose.map((el) => el.textContent).join('\n').length;
      if (length) window.__m0.lengths.add(length);
    }, 100);
  });
  await h.send(text);
  await h.idle(180000);
  const watched = await page.evaluate(() => {
    clearInterval(window.__m0Timer);
    return { statuses: window.__m0.statuses, lengths: window.__m0.lengths.size };
  });
  return { ms: Date.now() - started, ...watched };
}

/** @brief 当前会话的所有工具卡：动词（read 是"Read"）、状态（data-status）和标题。 */
function toolCards(page) {
  const cards = page.locator('.pane-slot:not([hidden]) [data-testid="tool-card"]');
  return cards.evaluateAll((items) => items.map((card) => ({
    verb: card.querySelector('.tool-verb')?.textContent ?? '',
    status: card.dataset.status ?? '',
    title: (card.querySelector('.tool-title')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
  })));
}

/** @brief 走查 2：不重填 key，直接测试连接。M6 起"Test connection"在设置页连接卡的"Edit connection"表单里。 */
async function connectionCheck(page) {
  const h = pageHelpers(page);
  await h.editConnection();
  await page.getByTestId('connection-form').getByRole('button', { name: 'Test connection' }).click();
  const result = await h.formMessage(null, { test: true, timeout: 60000 });
  record('走查 2：测试连接成功（用加密保存的 key）', /^Connected · First token \d+ms/.test(result), oneLine(result));
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/**
 * @brief 走查 3：总结 README，确认流式文字和一次读取（原生工具调用）；再追问一轮确认多轮可用。
 *        M2 起命令先要批准，这里走查的是 M0 的行为，打开会话后先切到"Allow all"（同 m1-real）。
 */
async function readmeCheck(app, page, project) {
  const h = pageHelpers(page);
  await h.openFolder(app, project);
  await h.allowAll();
  const first = await sendAndWatch(page, '总结 README');
  const tools = await toolCards(page);
  const answer = await lastReply(page);
  const thinking = await page.locator('.pane-slot:not([hidden]) details.thinking').count();
  const errors = await page.getByTestId('error-card').allInnerTexts();
  const readOk = tools.some((tool) => tool.verb === 'Read' && tool.status === 'done');
  record('走查 3：一次读取（原生工具调用）', readOk && answer.trim().length > 0 && errors.length === 0,
    `耗时 ${first.ms} ms；工具：${tools.map((t) => `${t.title}/${t.status}`).join('；') || '无'}；` +
    `思考段 ${thinking} 个；回复：${oneLine(answer, 160)}` + (errors.length ? `；错误：${oneLine(errors.join(' | '))}` : ''));
  record('走查 3：回复是流式出现的', first.lengths > 2, `本轮采样到 ${first.lengths} 种不同的回复长度`);
  record('阶段文字（每 100 毫秒采样，变化才记录）', first.statuses.length > 0, first.statuses.join(' → '));
  const second = await sendAndWatch(page, '用一句话再概括一次。');
  const errorsAfter = await page.getByTestId('error-card').allInnerTexts();
  record('第二轮对话无错误（请求里带上一轮的思考与工具结果）', errorsAfter.length === 0,
    `耗时 ${second.ms} ms；回复：${oneLine(await lastReply(page), 160)}` +
    (errorsAfter.length ? `；错误：${oneLine(errorsAfter.join(' | '))}` : ''));
}

/** @brief 走查主流程。 */
async function walkthrough() {
  const saved = savedConnection();
  Object.assign(results, { baseUrl: saved.baseUrl, model: saved.model, contextWindow: saved.contextWindow });
  record('models.json 里没有 key', !saved.keyInModelsJson);
  const project = mkdtempSync(join(tmpdir(), 'mori-real-project-'));
  writeFileSync(join(project, 'README.md'),
    '# Mori smoke project\n\nThis folder is used to check Mori against a real model.\n\n' +
    '- It has one README file.\n- The model should read this file before summarizing it.\n');
  const app = await launch();
  const net = startNetWatch(app.process().pid);
  try {
    const page = await app.firstWindow();
    await connectionCheck(page);
    await readmeCheck(app, page, project);
    const endpointIps = new Set((await lookup(new URL(saved.baseUrl).hostname, { all: true })).map((a) => a.address));
    const local = [...endpointIps].every((ip) => ip === '127.0.0.1' || ip === '::1');
    const others = [...net.seen.ext].filter((remote) => !endpointIps.has(remote.replace(/^\[|\]?:\d+$/g, '')));
    record('对外连接只有配置的端点（近似检查）', (local || net.seen.ext.size > 0) && others.length === 0,
      `端点解析为 ${[...endpointIps].join(', ')}；观察到 ${[...net.seen.ext].join(', ') || '无'}；其他：${others.join(', ') || '无'}`);
  } catch (error) {
    record('真实端点走查', false, oneLine(error));
  } finally {
    net.stop();
    await app.close().catch(() => {});
    rmSync(project, { recursive: true, force: true });
  }
  mkdirSync(join(appRoot, 'test-results'), { recursive: true });
  writeFileSync(join(appRoot, 'test-results/m0-real.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.exitCode = results.checks.every((c) => c.ok) ? 0 : 1;
}

if (process.argv.includes('--setup')) await setup();
else await walkthrough();
