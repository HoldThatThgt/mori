// M0 真实端点走查（走查项 2–3）：测试连接 →"总结 README"，确认流式文字与原生工具调用。
// key 只经 pi 的 "$变量名" 引用传给 Mori：脚本只把这一个变量从 env 文件载入 Mori 的进程环境，表单里只填 "$变量名"。
// 脚本不打印、不写入 key：输出前把 key 替换为 <redacted>；结束时检查并删除临时数据目录。用法：
//   node tests/ui/m0-real.mjs --env-file <路径> --key-var <变量名> --base-url <地址> --model <模型 ID>
//     [--context <上下文长度>] [--exe <Mori.exe 路径>]
// 结果写到 test-results/m0-real.json。

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { _electron as electron } from 'playwright-core';
import { startNetWatch } from './net-watch.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const envFile = arg('env-file');
const keyVar = arg('key-var');
const baseUrl = arg('base-url');
const model = arg('model');
const contextWindow = arg('context', '128000');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
if (!envFile || !keyVar || !baseUrl || !model) throw new Error('Missing --env-file, --key-var, --base-url or --model');
// Playwright 的调试日志会把启动环境（含 key）原样打印出来，开着就不运行。
if (/pw:|\*/.test(process.env.DEBUG ?? '') || process.env.DEBUG_FILE) {
  throw new Error('Unset DEBUG / DEBUG_FILE before running: Playwright debug logs would print the environment');
}

const results = { target: exePath ?? 'dev build', baseUrl, model, contextWindow: Number(contextWindow), checks: [] };
const oneLine = (text, max = 300) => String(text).replace(/\s+/g, ' ').slice(0, max);
let secret = '';

/** @brief 把 key（及其 JSON 转义形式）替换为 <redacted>。 */
function redact(text) {
  if (!secret) return text;
  return [secret, JSON.stringify(secret).slice(1, -1)].reduce((out, s) => out.split(s).join('<redacted>'), text);
}

/** @brief 记录一项检查；输出前先去掉 key。 */
function record(name, ok, detail = '') {
  const safe = redact(String(detail));
  results.checks.push({ name, ok, detail: safe });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${safe ? ` — ${safe}` : ''}`);
}

/** @brief 从 env 文件读出指定变量（KEY=VALUE，忽略注释与空行）。 */
function readEnvVar(path, name) {
  for (const raw of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line.startsWith(`${name}=`)) continue;
    return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error(`${name} not found in env file`);
}

/** @brief 填连接表单并测试。 */
async function connect(page) {
  const fields = page.locator('.panel label input');
  await fields.nth(0).fill('DeepSeek（开发期替代端点）');
  await fields.nth(1).fill(baseUrl);
  await fields.nth(2).fill(`$${keyVar}`);
  await fields.nth(3).fill(model);
  await fields.nth(4).fill(contextWindow);
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('已保存').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '测试连接' }).click();
  const result = page.locator('.panel .ok, .panel .error').first();
  await result.waitFor({ timeout: 60000 });
  record('走查 2：测试连接成功', (await result.getAttribute('class')) === 'ok', oneLine(await result.innerText()));
}

/** @brief models.json 里只有 "$变量名"，没有明文 key；只记录布尔结果。 */
function keyCheck(userData) {
  const text = readFileSync(join(userData, 'pi', 'models.json'), 'utf8');
  let isReference = false;
  try {
    isReference = JSON.parse(text).providers?.['mori-endpoint']?.apiKey === `$${keyVar}`;
  } catch {
    isReference = false;
  }
  const plaintext = text.includes(secret);
  record('models.json 只保存环境变量引用', isReference && !plaintext,
    `apiKey 是 $${keyVar}=${isReference}；文件中出现明文 key=${plaintext}`);
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

/** @brief 在目录下查找 key（含逗号或空白分隔的每一段），只返回命中的文件数。 */
function scanForSecret(dir) {
  const parts = [secret, ...secret.split(/[,;\s]+/)].filter((part) => part.length >= 8);
  let hits = 0;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (parts.some((part) => readFileSync(path).includes(part))) hits += 1;
    }
  };
  walk(dir);
  return hits;
}

secret = readEnvVar(envFile, keyVar);
const root = mkdtempSync(join(tmpdir(), 'mori-real-'));
const project = join(root, 'project');
const userData = join(root, 'user-data');
mkdirSync(project);
writeFileSync(join(project, 'README.md'),
  '# Mori smoke project\n\nThis folder is used to check Mori against a real model.\n\n' +
  '- It has one README file.\n- The model should read this file before summarizing it.\n');
const env = { ...process.env, [keyVar]: secret, MORI_USER_DATA: userData };
const app = await electron.launch(exePath ? { executablePath: exePath, env } : { args: [appRoot], cwd: appRoot, env });
const net = startNetWatch(app.process().pid);
try {
  const page = await app.firstWindow();
  await connect(page);
  keyCheck(userData);
  await readmeCheck(app, page, project);
  const endpointIps = new Set((await lookup(new URL(baseUrl).hostname, { all: true })).map((a) => a.address));
  const others = [...net.seen.ext].filter((remote) => !endpointIps.has(remote.replace(/^\[|\]?:\d+$/g, '')));
  record('对外连接只有配置的端点（近似检查）', net.seen.ext.size > 0 && others.length === 0,
    `端点解析为 ${[...endpointIps].join(', ')}；观察到 ${[...net.seen.ext].join(', ') || '无'}；其他：${others.join(', ') || '无'}`);
} catch (error) {
  record('真实端点走查', false, oneLine(error));
} finally {
  net.stop();
  await app.close().catch(() => {});
  const hits = scanForSecret(root);
  record('临时数据目录中没有 key 原文（检查后删除该目录）', hits === 0, `命中文件 ${hits} 个`);
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(join(appRoot, 'test-results'), { recursive: true });
writeFileSync(join(appRoot, 'test-results/m0-real.json'), `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.checks.every((c) => c.ok) ? 0 : 1;
