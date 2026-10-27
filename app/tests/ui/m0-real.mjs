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

/**
 * @brief --setup：打开 Mori，等你填好连接、保存并关闭窗口。数据目录里已有 v1 的 model-config.json 或 v0 的
 *        pi/models.json（迁移）时，窗口直接打开 设置 → Models 而不是首次启动表单（§4.5）。
 */
async function setup() {
  const previous = existsSync(join(userData, 'model-config.json')) || existsSync(join(userData, 'pi', 'models.json'));
  const app = await launch();
  console.log(previous
    ? 'Mori 已打开：数据目录里已有模型配置，窗口打开在 Settings → Models。确认各提供商的 Network zone，需要时添加提供商并测试连接；'
    : 'Mori 已打开：在首次启动表单里填 Base URL、API key，点 Fetch models，在清单里勾模型（没列出时用 Add a model ID '
      + '手填），确认 Name、Network zone，测试连接后保存；');
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

/**
 * @brief 已保存的全部提供商的地址解析出的 IP。v1 的后台进程启动时读每个已配置模型的服务版本（model-providers.md §7.1），
 *        所以"配置的端点"是全部提供商的，不只是第一个。
 */
async function endpointAddresses() {
  const providers = JSON.parse(readFileSync(join(userData, 'model-config.json'), 'utf8')).providers ?? [];
  const hosts = [...new Set(providers.map((provider) => new URL(provider.baseUrl).hostname))];
  const found = await Promise.all(hosts.map((host) => lookup(host, { all: true })));
  return new Set(found.flat().map((address) => address.address));
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

/** @brief 走查 2：不重填 key，在 设置 → Models 的提供商卡上测试连接（v1）。 */
async function connectionCheck(page, providerId) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  const card = page.locator(`[data-testid="provider-card"][data-provider="${providerId}"]`);
  await card.locator('[data-action="test-provider"]').click();
  const result = card.getByTestId('test-result');
  await result.waitFor({ timeout: 120000 });
  const text = await result.innerText();
  record('走查 2：测试连接成功（用加密保存的 key）', text.startsWith('Connected'), oneLine(text));
  await page.getByRole('button', { name: 'Back to app' }).click();
}

/**
 * @brief 走查 3：总结 README，确认流式文字和一次读取（原生工具调用）；再追问一轮确认多轮可用。
 *        M2 起命令先要批准，这里走查的是 M0 的行为，打开会话后先切到"Full access"（同 m1-real）。
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
    const endpointIps = await endpointAddresses();
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
