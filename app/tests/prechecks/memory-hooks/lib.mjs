// 开工前实测（docs/specs/memory.md §11.2 的 M1–M7）：合成端点（4791）+ 记下请求体的代理（4790）+ 按 Mori 后台进程的方式
// 建的 pi 会话（每个会话自己的设置与加载器、内联扩展、SessionManager.create(cwd, 目录)、bindExtensions）。
// 用法（在 app/ 下）：node tests/prechecks/memory-hooks/m1.mjs（m2、m3、m4、m6、m6-reopen 同样）；输出写在系统临时目录的
// mori-memory-prechecks 下，不写进仓库。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROBES = join(tmpdir(), 'mori-memory-prechecks');
mkdirSync(PROBES, { recursive: true });
export const AGENT_DIR = join(PROBES, 'agent');
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PI_URL = pathToFileURL(join(APP, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
const PI_AI_URL = pathToFileURL(join(APP, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href;
const ENDPOINT_PORT = 4791;
const PROXY_PORT = 4790;

process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
mkdirSync(AGENT_DIR, { recursive: true });

export const pi = await import(PI_URL);
export const piAi = await import(PI_AI_URL);

/** Recorded chat request bodies (parsed JSON) */
export const requests = [];
let endpoint;
let proxy;

export async function startServers(logName) {
  const logFile = join(PROBES, `${logName}.requests.jsonl`);
  rmSync(logFile, { force: true });
  endpoint = spawn(process.execPath, [join(APP, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(ENDPOINT_PORT), FAKE_CHUNK_DELAY_MS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('endpoint did not start')), 15000);
    endpoint.stdout.on('data', (c) => { if (String(c).includes('synthetic')) { clearTimeout(timer); done(); } });
  });
  proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url.includes('chat/completions')) {
        const json = JSON.parse(body.toString('utf8'));
        requests.push(json);
        appendFileSync(logFile, JSON.stringify(json) + '\n');
      }
      const up = http.request({ host: '127.0.0.1', port: ENDPOINT_PORT, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${ENDPOINT_PORT}` } }, (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
      up.end(body);
    });
  });
  await new Promise((done) => proxy.listen(PROXY_PORT, '127.0.0.1', done));
}

export async function stopServers() {
  proxy?.close();
  if (endpoint && endpoint.exitCode === null) {
    const gone = new Promise((d) => endpoint.once('exit', d));
    endpoint.kill();
    await gone;
  }
}

let runtime;
/** Same shape as Mori's providerInput (modelCompile.ts): placeholder key, zero cost. */
export async function getModel({ reasoning = false, compat } = {}) {
  runtime ??= await pi.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const provider = reasoning ? 'fake-r' : compat ? 'fake-mid' : 'fake';
  if (!runtime.getModel(provider, 'fake-coder')) {
    const model = { id: 'fake-coder', name: 'fake-coder', api: 'openai-completions', input: ['text'], reasoning,
      contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    if (compat) model.compat = compat;
    runtime.registerProvider(provider, { name: provider, baseUrl: `http://127.0.0.1:${PROXY_PORT}/v1`,
      api: 'openai-completions', apiKey: 'probe-placeholder', models: [model] });
    await runtime.refresh({ allowNetwork: false });
  }
  return { runtime, model: runtime.getModel(provider, 'fake-coder') };
}

/**
 * Build a session like sessions.ts createEntry: own SettingsManager, DefaultResourceLoader with inline
 * extensionFactories, reload with resolveProjectTrust, SessionManager.create(cwd, sessionDir).
 */
export async function makeSession({ name, extensions = [], tools, trusted = false, loaderExtra = {},
  thinkingLevel, reasoning = false, compat, projectFiles = {} }) {
  const cwd = join(PROBES, 'proj', name);
  const sessionDir = join(PROBES, 'sessions', name);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  for (const [rel, text] of Object.entries(projectFiles)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  }
  const settings = pi.SettingsManager.create(cwd, AGENT_DIR, { projectTrusted: trusted });
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir: AGENT_DIR, settingsManager: settings,
    extensionFactories: extensions, ...loaderExtra });
  await resourceLoader.reload({ resolveProjectTrust: async () => trusted });
  const { runtime: modelRuntime, model } = await getModel({ reasoning, compat });
  const sessionManager = pi.SessionManager.create(cwd, sessionDir);
  const result = await pi.createAgentSession({ cwd, modelRuntime, settingsManager: settings, sessionManager,
    resourceLoader, model, thinkingLevel, ...(tools ? { tools } : {}) });
  for (const e of result.extensionsResult.errors) console.log('EXTENSION ERROR', e.path, e.error);
  await result.session.bindExtensions({ onError: (e) => console.log('EXT RUNTIME ERROR', e.extensionPath, e.error) });
  return { session: result.session, cwd, sessionDir };
}

/** Parsed lines of the session file */
export function sessionLines(session) {
  const file = session.sessionManager.getSessionFile();
  if (!file || !existsSync(file)) return { file, lines: [] };
  return { file, lines: readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

/** Text of each system-role message in a chat request */
export function systemTexts(body) {
  return body.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) =>
    typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join(''));
}

export const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name);
export const roles = (body) => body.messages.map((m) => m.role).join(',');
export const show = (label, value) => console.log(`\n=== ${label} ===\n` +
  (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
