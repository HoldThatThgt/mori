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
  return { baseUrl: provider.baseUrl, model: provider.models?.[0]?.id, contextWindow: provider.models?.[0]?.contextWindow,
    keyInModelsJson: 'apiKey' in provider };
}

const results = { target: exePath ?? 'dev build', checks: [] };

/** @brief 记录一项检查。 */
function record(name, ok, detail = '') {
  results.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** @brief 发一条消息并等本轮结束；期间每 100 毫秒采样阶段文字（变化才记录）和最后一条回复的长度。 */
async function sendAndWatch(page, text) {
  const started = Date.now();
  const statuses = [];
  const lengths = new Set();
  const timer = setInterval(() => {
    void page.getByTestId('status').innerText().then((s) => {
      if (s && statuses[statuses.length - 1] !== s) statuses.push(s);
    }, () => {});
    void page.locator('.assistant').last().innerText().then((t) => t && lengths.add(t.length), () => {});
  }, 100);
  await page.locator('.composer textarea').fill(text);
  await page.locator('.composer textarea').press('Enter');
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: 'Send' }).waitFor({ timeout: 180000 });
  clearInterval(timer);
  return { ms: Date.now() - started, statuses, lengths: lengths.size };
}

/** @brief 当前所有工具卡：名称、状态和参数。 */
function toolCards(page) {
  return page.getByTestId('tool-card').evaluateAll((cards) => cards.map((card) => ({
    name: card.querySelector('.tool-name')?.textContent ?? '',
    status: card.querySelector('.tool-status')?.textContent ?? '',
    args: (card.querySelector('pre')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
  })));
}

/** @brief 走查 2：不重填 key，直接测试连接。 */
async function connectionCheck(page) {
  await page.getByRole('button', { name: 'Test connection' }).click();
  const result = page.locator('.panel .ok, .panel .error').first();
  await result.waitFor({ timeout: 60000 });
  record('走查 2：测试连接成功（用加密保存的 key）', (await result.getAttribute('class')) === 'ok', oneLine(await result.innerText()));
}

/** @brief 走查 3：总结 README，确认流式文字和一次读取（原生工具调用）；再追问一轮确认多轮可用。 */
async function readmeCheck(app, page, project) {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await page.getByRole('button', { name: 'Open folder…' }).click();
  await page.locator('.chat-head').waitFor({ timeout: 30000 });
  const first = await sendAndWatch(page, '总结 README');
  const tools = await toolCards(page);
  const answer = await page.locator('.assistant').last().innerText();
  const thinking = await page.locator('.thinking').count();
  const errors = await page.locator('.chat .error').allInnerTexts();
  const readOk = tools.some((tool) => tool.name === 'read' && tool.status === 'Done');
  record('走查 3：一次读取（原生工具调用）', readOk && answer.trim().length > 0 && errors.length === 0,
    `耗时 ${first.ms} ms；工具：${tools.map((t) => `${t.name}/${t.status} ${t.args}`).join('；') || '无'}；` +
    `思考段 ${thinking} 个；回复：${oneLine(answer, 160)}` + (errors.length ? `；错误：${oneLine(errors.join(' | '))}` : ''));
  record('走查 3：回复是流式出现的', first.lengths > 2, `本轮采样到 ${first.lengths} 种不同的回复长度`);
  record('阶段文字（每 100 毫秒采样，变化才记录）', first.statuses.length > 0, first.statuses.join(' → '));
  const second = await sendAndWatch(page, '用一句话再概括一次。');
  const errorsAfter = await page.locator('.chat .error').allInnerTexts();
  record('第二轮对话无错误（请求里带上一轮的思考与工具结果）', errorsAfter.length === 0,
    `耗时 ${second.ms} ms；回复：${oneLine(await page.locator('.assistant').last().innerText(), 160)}` +
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
