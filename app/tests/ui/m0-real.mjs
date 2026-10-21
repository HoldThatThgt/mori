// M0 真实端点走查（走查项 2–3）：测试连接 →"总结 README"，确认流式文字与原生工具调用。
// 脚本不接触 key：先用 --setup 打开 Mori，由你在界面里填连接并保存（key 由 Mori 加密保存），等探针显示 Verified 后关闭窗口；
// 之后不带 --setup 运行，脚本用同一个数据目录走查。用法：
//   node tests/ui/m0-real.mjs --user-data <目录> --setup [--exe <Mori.exe 路径>]
//   node tests/ui/m0-real.mjs --user-data <目录> [--exe <Mori.exe 路径>]
// 数据目录专门用于走查，不要用日常使用的 %APPDATA%\Mori。结果写到 test-results/m0-real.json。
// v1（docs/specs/model-providers.md §14.4）：已保存的提供商从 model-config.json 读，断言改为 model-config.json 与
// credentials.json（key 只有 ref、密文在 credentials.json）；测试连接在 设置 → Models 的提供商卡上；临时项目在走查期间
// 授权公网（测试准备，走查结束后删掉这一项）。

import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { _electron as electron } from 'playwright-core';
import { editModelConfig, projectKey } from './lib.mjs';
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

/**
 * @brief --setup：打开 Mori，等你填好连接、保存并关闭窗口。数据目录里已有 v1 的 model-config.json 或 v0 的
 *        pi/models.json（迁移）时，窗口直接打开 设置 → Models 而不是首次启动表单（§4.5）。
 */
async function setup() {
  const previous = existsSync(join(userData, 'model-config.json')) || existsSync(join(userData, 'pi', 'models.json'));
  const app = await launch();
  console.log(previous
    ? 'Mori 已打开：数据目录里已有模型配置，窗口打开在 设置 → Models。确认各提供商的 Network zone，需要时添加提供商并测试连接；'
    : 'Mori 已打开：在首次启动表单里填 Name、Address、Network zone、API key、Model id，测试连接后保存；');
  console.log('等每个模型的 Tool calling 都显示 Verified 后再关闭窗口（探针没跑完就关，下次启动会重新探测）。');
  await new Promise((done) => app.process().once('exit', done));
  console.log(`已退出。数据目录：${userData}`);
}

/**
 * @brief 读取已保存的第一个提供商的非机密信息（v1：model-config.json）；确认它的 key 只有 ref 与标签，密文在
 *        credentials.json 里（只看有没有这一项，不读密文）。
 */
function savedConnection() {
  const configPath = join(userData, 'model-config.json');
  const provider = JSON.parse(readFileSync(configPath, 'utf8')).providers?.[0];
  if (!provider) throw new Error('No saved provider: run with --setup first');
  const credentials = JSON.parse(readFileSync(join(userData, 'credentials.json'), 'utf8'));
  return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, model: provider.models?.[0]?.id,
    contextWindow: provider.models?.[0]?.contextWindow,
    keyRefsOnly: provider.keys.length > 0
      && provider.keys.every((key) => Object.keys(key).sort().join() === 'label,ref'),
    cipherSaved: provider.keys.every((key) => typeof credentials[key.ref] === 'string') };
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
  await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: '发送' }).waitFor({ timeout: 180000 });
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

/** @brief 走查 2：不重填 key，在 设置 → Models 的提供商卡上测试连接（v1）。 */
async function connectionCheck(page, providerId) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  const card = page.locator(`[data-testid="provider-card"][data-provider="${providerId}"]`);
  await card.locator('[data-action="test-provider"]').click();
  const result = card.getByTestId('test-result');
  await result.waitFor({ timeout: 120000 });
  const text = await result.innerText();
  record('走查 2：测试连接成功（用加密保存的 key）', text.startsWith('Connected'), oneLine(text));
  await page.getByRole('button', { name: '返回会话' }).click();
}

/** @brief 走查 3：总结 README，确认流式文字和一次读取（原生工具调用）；再追问一轮确认多轮可用。 */
async function readmeCheck(app, page, project) {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await page.getByRole('button', { name: '打开文件夹…' }).click();
  await page.locator('.chat-head').waitFor({ timeout: 30000 });
  const first = await sendAndWatch(page, '总结 README');
  const tools = await toolCards(page);
  const answer = await page.locator('.assistant').last().innerText();
  const thinking = await page.locator('.thinking').count();
  const errors = await page.locator('.chat .error').allInnerTexts();
  const readOk = tools.some((tool) => tool.name === 'read' && tool.status === '完成');
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
  record('model-config.json 里 key 只有 ref 与标签，密文在 credentials.json 里', saved.keyRefsOnly && saved.cipherSaved);
  const project = mkdtempSync(join(tmpdir(), 'mori-real-project-'));
  writeFileSync(join(project, 'README.md'),
    '# Mori smoke project\n\nThis folder is used to check Mori against a real model.\n\n' +
    '- It has one README file.\n- The model should read this file before summarizing it.\n');
  // 测试准备（synthetic test setup，§14.1）：走查期间给临时项目授权公网，结束后删掉这一项
  editModelConfig(userData, (config) => {
    config.projectZones[projectKey(project)] = ['public'];
  });
  const app = await launch();
  const net = startNetWatch(app.process().pid);
  try {
    const page = await app.firstWindow();
    await connectionCheck(page, saved.id);
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
    editModelConfig(userData, (config) => {
      delete config.projectZones[projectKey(project)];
    });
    rmSync(project, { recursive: true, force: true });
  }
  mkdirSync(join(appRoot, 'test-results'), { recursive: true });
  writeFileSync(join(appRoot, 'test-results/m0-real.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.exitCode = results.checks.every((c) => c.ok) ? 0 : 1;
}

if (process.argv.includes('--setup')) await setup();
else await walkthrough();
