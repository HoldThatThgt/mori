// v1-models-app-session.mjs 的测试准备（synthetic）：合成端点（tests/fake-endpoint）进程、它前面本进程里的转发代理
// （记下每个请求的请求体；failSummary 让压缩请求直接失败），以及启动前写好的 model-config.json、pi 的 settings.json、
// 测试项目和 v0 的旧会话。从 v1-models-app-session.mjs 挪出来（2026-10-21：那个文件加了输入框下面一行的检查后超过 2000 行），
// 做法不变，只折了几处超过 120 个字符的行。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { probeStep } from '../fake-endpoint/probes.mjs';
import { contentText, isSummaryRequest } from '../fake-endpoint/replies.mjs';
import { appRoot, oneLine, sleep } from './lib.mjs';

// ---------- 合成端点与转发代理（synthetic） ----------

/** @brief 启动合成端点进程，收集它每个对话请求的一行 JSON 日志（加上收到的时刻）。 */
function spawnFake(port, env) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '10', FAKE_FIRST_DELAY_MS: '20', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  let rest = '';
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`fake endpoint on ${port} did not start within 15 s`)), 15000);
    child.once('exit', (code) => fail(new Error(`fake endpoint on ${port} exited (${code})`)));
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      rest += chunk;
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines.map((item) => item.trim())) {
        if (line.startsWith('{')) {
          try { log.push({ ...JSON.parse(line), at: Date.now() }); } catch { /* 不是 JSON 的行不记 */ }
        } else if (line.includes('synthetic')) {
          clearTimeout(timer);
          done({ child, log });
        }
      }
    });
  });
}

/** @brief 请求体的摘要：模型、消息、最后一条用户消息、是不是探针、是不是压缩（摘要）请求、思考参数、认证头。 */
function describeBody(body, auth) {
  const messages = body?.messages ?? [];
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  return { model: body?.model ?? null, messages, auth, probe: probeStep(messages) > 0,
    summary: isSummaryRequest(messages), lastUser: contentText(lastUser?.content).trim(),
    effort: body?.reasoning_effort ?? null, failed: false };
}

/** @brief 代理转发一个请求：记下请求体；failSummary 不为 null 时压缩请求直接回这个状态码（synthetic 的"压缩出错"）。 */
function forward(ep, upstream, req, res, raw) {
  let info = null;
  if (req.method === 'POST' && raw.length > 0) {
    try {
      info = describeBody(JSON.parse(raw.toString('utf8')), req.headers.authorization ?? null);
    } catch {
      info = null;
    }
  }
  if (info) ep.bodies.push({ ...info, at: Date.now() });
  if (info?.summary && ep.failSummary) {
    ep.bodies.at(-1).failed = true;
    res.writeHead(ep.failSummary, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic summary failure from the test proxy',
      type: 'synthetic_error' } }));
    return;
  }
  const out = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${upstream}` } }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
  });
  out.on('error', () => res.destroy());
  res.on('close', () => { if (!res.writableFinished) out.destroy(); });
  out.end(raw);
}

/** @brief 在 ep.port 上起转发代理，转给 upstream 端口的合成端点。 */
function startProxy(ep, upstream) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => forward(ep, upstream, req, res, Buffer.concat(chunks)));
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(ep.port, '127.0.0.1', () => done(server));
  });
}

/**
 * @brief 启动一个合成端点（默认带转发代理），记进 ctx.eps，场景结束时关掉。
 * @param env 合成端点的环境变量（FAKE_*）
 * @param options.proxy 为 false 时 Mori 直连合成端点（没有请求体记录）
 */
export async function startEndpoint(ctx, port, env = {}, { proxy = true } = {}) {
  const ep = { port, url: `http://127.0.0.1:${port}/v1`, bodies: [], failSummary: null, server: null };
  const fake = await spawnFake(proxy ? port + 10 : port, env);
  ep.child = fake.child;
  ep.log = fake.log;
  if (proxy) ep.server = await startProxy(ep, port + 10);
  ep.stop = () => stopEndpoint(ep);
  ctx.eps.push(ep);
  return ep;
}

/** @brief 关掉合成端点和代理，等进程真正退出（之后可以在同一端口重新启动）。 */
async function stopEndpoint(ep) {
  if (ep.stopped) return;
  ep.stopped = true;
  ep.child.removeAllListeners('exit');
  const exited = new Promise((done) => (ep.child.exitCode !== null ? done() : ep.child.once('exit', done)));
  ep.child.kill();
  await Promise.race([exited, sleep(5000)]);
  if (ep.server) {
    ep.server.closeAllConnections();
    await new Promise((done) => ep.server.close(() => done()));
  }
}

/** @brief 代理记下的对话请求（不是探针、不是压缩请求）。 */
export const talk = (ep) => ep.bodies.filter((body) => !body.probe && !body.summary);
/** @brief 消息里有没有工具调用或工具结果。 */
export const hasToolHistory = (messages) => messages.some((message) => message.role === 'tool'
  || (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0));
/** @brief 请求体的简短说明（失败时的 detail）。 */
export const brief = (body) => (body ? `${body.model} roles=${body.messages.map((m) => m.role).join(',')} `
  + `last="${oneLine(body.lastUser, 40)}"` : 'none');

// ---------- 配置与数据目录（synthetic test setup） ----------

/** @brief 一个模型。 */
export function model(id, { ctx = 128000, max = 16384, reasoning = false } = {}) {
  return { id, family: '', contextWindow: ctx, maxTokens: max, reasoning, input: ['text'] };
}

/** @brief 一个提供商（openai-completions，没有 key）。 */
export function provider(id, name, baseUrl, models, { zone = 'local', concurrency = 4 } = {}) {
  return { id, name, api: 'openai-completions', baseUrl, zone, compat: {}, concurrency, keys: [], nextKeyNumber: 1,
    models };
}

/** @brief 一个分组。 */
export const group = (id, members) => ({ id, members });

/** @brief 启动前写好 model-config.json（synthetic test setup：跳过界面上的配置步骤，测的是会话一侧）。 */
export function seedConfig(ctx, { providers, groups = [], normalDefault = null }) {
  const config = { version: 1, providers, groups, normalDefault, allowedZones: ['local', 'intranet'],
    projectZones: {} };
  writeFileSync(join(ctx.userData, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** @brief 启动前写好 pi 的 settings.json（synthetic test setup：压缩参数、按模型的新会话思考强度）。 */
export function seedPiSettings(ctx, settings) {
  mkdirSync(join(ctx.userData, 'pi'), { recursive: true });
  writeFileSync(join(ctx.userData, 'pi', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/** @brief 建一个测试项目：README、一个源文件和 extra 里的文件。 */
export function makeProject(ctx, name, extra = {}) {
  const project = join(ctx.root, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'),
    '# Mori fixture project\n\nThis folder is used to check the v1 model layer.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), text);
  }
  return project;
}

/** @brief 规范化的项目路径（§4.1：全部小写、/ 分隔）。 */
export const projectKey = (path) => resolve(path).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/**
 * @brief 写一个 v0 的旧会话（synthetic test setup）：没有 mori.pick，有 model_change 和一条带 provider/model 的助手消息，
 *        放在 pi 的会话目录里，侧栏会列出它。
 */
export function seedV0Session(ctx, cwd, providerId, modelId) {
  const id = randomUUID();
  const when = new Date(Date.now() - 3600000);
  const iso = when.toISOString();
  const dir = join(ctx.userData, 'pi', 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${iso.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [
    { type: 'session', version: 3, id, timestamp: iso, cwd },
    { type: 'model_change', id: 'v0aa0001', parentId: null, timestamp: iso, provider: providerId, modelId },
    { type: 'thinking_level_change', id: 'v0aa0002', parentId: 'v0aa0001', timestamp: iso, thinkingLevel: 'off' },
    { type: 'message', id: 'v0aa0003', parentId: 'v0aa0002', timestamp: iso, message: { role: 'user',
      content: [{ type: 'text', text: 'v0 question (synthetic)' }], timestamp: when.getTime() } },
    { type: 'message', id: 'v0aa0004', parentId: 'v0aa0003', timestamp: iso, message: { role: 'assistant',
      content: [{ type: 'text', text: 'v0 answer (synthetic)' }], api: 'openai-completions', provider: providerId,
      model: modelId, usage, stopReason: 'stop', timestamp: when.getTime() + 1 } },
  ];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

/** @brief 会话文件里的全部条目（读不出的行跳过）。 */
function readEntries(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/** @brief 会话文件里某种自定义条目的数据。 */
export const customs = (file, type) => readEntries(file).filter((entry) => entry.type === 'custom'
  && entry.customType === type).map((entry) => entry.data);

/** @brief 用户级配置文件。 */
export const readConfig = (ctx) => JSON.parse(readFileSync(join(ctx.userData, 'model-config.json'), 'utf8'));
