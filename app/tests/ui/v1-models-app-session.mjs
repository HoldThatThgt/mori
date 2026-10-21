// v1 模型层的整机测试（会话一侧）：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint，synthetic），
// 覆盖 docs/specs/model-providers.md §14.2 中 MP-09、MP-10、MP-11、MP-12、MP-21、MP-22、MP-23、MP-34、MP-35 在 App 层的通过条件。
// 界面文字、状态与标识见 docs/v1/screens/model-chat.md、model-menu.md、models-settings.md。
// 每个场景用一个新的数据目录和自己的合成端点，启动前写好 model-config.json（synthetic test setup，代码里注明）；
// 场景之间互不依赖，可以用 --only 只跑其中几个。
// 合成端点前面放一个本进程里的转发代理（synthetic）：记下每个请求的请求体（发给模型的上下文、思考参数、压缩请求、认证头），
// MP-21、MP-22 另用它让压缩（摘要）请求返回 400，制造"压缩出错"。MP-11 的取消探针直连合成端点（断开要直接传到端点）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-app-session.mjs [--exe <Mori.exe 路径>] [--only 场景1,场景2]
// 场景：blocked、configInvalid、probes、consent、fingerprint、handover、compaction、range、preparing、thinking。
// 结果写到 test-results/v1-models-app-session(-packaged).json，截图在 test-results/v1-models-app-session(-packaged)/。
// 端口：4540–4549 是 Mori 连接的地址（代理或直连的合成端点），4550–4559 是代理后面的合成端点。
// 测试里的 key 都是合成的测试值（synthetic），与任何真实服务无关。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { probeStep } from '../fake-endpoint/probes.mjs';
import { contentText, isSummaryRequest } from '../fake-endpoint/replies.mjs';
import { appRoot, arg, createRecorder, launch, oneLine, sleep } from './lib.mjs';
import { activeFile, ctrlN, lastReply, PANE, paneOf, rowOf, samePath, settle, stubFolder, until, waitIdle, waitReady }
  from './m3-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/v1-models-app-session${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** Mori 连接的第一个端口；代理后面的合成端点在 +10 */
const PORT = 4540;
/** 合成端点 "plain" 的回复 */
const PLAIN_REPLY = '这是一段只有文字的回复，用来测试流式输出。';
/** 合成端点压缩请求的回复里的一句 */
const SUMMARY_TEXT = 'Synthetic summary of the earlier conversation.';
/** 生成中、准备中范围按钮的悬停说明（§9.2） */
const BUSY_TITLE = "Can't change the model while generating";
/** v0 的压缩提示与已停止提示 */
const COMPACTED_NOTICE = '已压缩较早的对话';
const STOPPED_NOTICE = '已停止 · 已经做出的修改不会自动撤销';
/** 被拒绝启动的会话收到 session.prompt 时的原文（§4.6） */
const BLOCKED_MESSAGE = "This session can't start: no model fits";
/** 填充对话用的文字：不含合成端点的任何关键词 */
const FILLER_UNIT = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ';
const filler = (chars) => FILLER_UNIT.repeat(Math.ceil(chars / FILLER_UNIT.length)).slice(0, chars);

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
    try { info = describeBody(JSON.parse(raw.toString('utf8')), req.headers.authorization ?? null); } catch { info = null; }
  }
  if (info) ep.bodies.push({ ...info, at: Date.now() });
  if (info?.summary && ep.failSummary) {
    ep.bodies.at(-1).failed = true;
    res.writeHead(ep.failSummary, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic summary failure from the test proxy', type: 'synthetic_error' } }));
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
async function startEndpoint(ctx, port, env = {}, { proxy = true } = {}) {
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
const talk = (ep) => ep.bodies.filter((body) => !body.probe && !body.summary);
/** @brief 消息里有没有工具调用或工具结果。 */
const hasToolHistory = (messages) => messages.some((message) => message.role === 'tool'
  || (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0));
/** @brief 请求体的简短说明（失败时的 detail）。 */
const brief = (body) => (body ? `${body.model} roles=${body.messages.map((m) => m.role).join(',')} `
  + `last="${oneLine(body.lastUser, 40)}"` : 'none');

// ---------- 配置与数据目录（synthetic test setup） ----------

/** @brief 一个模型。 */
function model(id, { ctx = 128000, max = 16384, reasoning = false } = {}) {
  return { id, family: '', contextWindow: ctx, maxTokens: max, reasoning, input: ['text'] };
}

/** @brief 一个提供商（openai-completions，没有 key）。 */
function provider(id, name, baseUrl, models, { zone = 'local', concurrency = 4 } = {}) {
  return { id, name, api: 'openai-completions', baseUrl, zone, compat: {}, concurrency, keys: [], nextKeyNumber: 1,
    models };
}

/** @brief 一个分组。 */
const group = (id, members) => ({ id, members });

/** @brief 启动前写好 model-config.json（synthetic test setup：跳过界面上的配置步骤，测的是会话一侧）。 */
function seedConfig(ctx, { providers, groups = [], normalDefault = null }) {
  const config = { version: 1, providers, groups, normalDefault, allowedZones: ['local', 'intranet'], projectZones: {} };
  writeFileSync(join(ctx.userData, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** @brief 启动前写好 pi 的 settings.json（synthetic test setup：压缩参数、按模型的新会话思考强度）。 */
function seedPiSettings(ctx, settings) {
  mkdirSync(join(ctx.userData, 'pi'), { recursive: true });
  writeFileSync(join(ctx.userData, 'pi', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/** @brief 建一个测试项目：README、一个源文件和 extra 里的文件。 */
function makeProject(ctx, name, extra = {}) {
  const project = join(ctx.root, name);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Mori fixture project\n\nThis folder is used to check the v1 model layer.\n');
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), text);
  }
  return project;
}

/** @brief 规范化的项目路径（§4.1：全部小写、/ 分隔）。 */
const projectKey = (path) => resolve(path).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/**
 * @brief 写一个 v0 的旧会话（synthetic test setup）：没有 mori.pick，有 model_change 和一条带 provider/model 的助手消息，
 *        放在 pi 的会话目录里，侧栏会列出它。
 */
function seedV0Session(ctx, cwd, providerId, modelId) {
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
const customs = (file, type) => readEntries(file).filter((entry) => entry.type === 'custom'
  && entry.customType === type).map((entry) => entry.data);

/** @brief 用户级配置文件。 */
const readConfig = (ctx) => JSON.parse(readFileSync(join(ctx.userData, 'model-config.json'), 'utf8'));

// ---------- App ----------

/** @brief 用 ctx.userData 启动 Mori，等左栏出来，在页面里装上事件记录（window.__events）。 */
async function startApp(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.getByRole('button', { name: '打开文件夹…' }).first().waitFor({ timeout: 60000 });
  await ctx.page.evaluate(() => {
    window.__events = [];
    window.mori.onEvent((envelope) => window.__events.push(JSON.parse(JSON.stringify(envelope))));
  });
}

/** @brief 关掉 Mori。 */
async function stopApp(ctx) {
  if (!ctx.app) return;
  await ctx.app.close().catch(() => {});
  ctx.app = null;
}

/** @brief 经进程桥发一条命令（只用于读状态和测试准备）。 */
const bridge = (page, command) => page.evaluate((item) => window.mori.request(item), command);
/** @brief 页面收到的某种事件。 */
const events = (page, type) => page.evaluate((want) => window.__events.filter((item) => item.event?.type === want), type);
/** @brief models.get 的结果。 */
const modelsInfo = (page) => bridge(page, { type: 'models.get' });
/** @brief 档案已完成一组探针（不在第一次探测中）。 */
const finished = (profile) => Boolean(profile) && profile.status !== 'probing' && profile.probedAt !== null;
/** @brief 档案的 tool_calling 已验证。 */
const verified = (profile) => profile?.tool_calling?.state === 'verified';

/** @brief 等 refs 的档案都满足 done，返回最后一次读到的全部档案；等不到时抛错。 */
async function waitProfiles(page, refs, done = verified, timeout = 120000) {
  let last = {};
  const ok = await until(async () => {
    last = (await modelsInfo(page)).profiles ?? {};
    return refs.every((ref) => done(last[ref]));
  }, timeout, 500);
  if (!ok) {
    const states = refs.map((ref) => `${ref}=${last[ref]?.status ?? 'none'}/${last[ref]?.tool_calling?.state ?? '-'}`);
    throw new Error(`profiles not ready: ${states.join(', ')}`);
  }
  return last;
}

/** @brief 点"打开文件夹…"打开 folder（会问信任时选"信任"），等新会话就绪。 */
async function openProject(ctx, folder) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: '打开文件夹…' }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll('.pane-slot').length > count
    || Boolean(document.querySelector('[data-testid="trust-dialog"]')), before, { timeout: 30000 });
  const trust = page.getByTestId('trust-dialog');
  if (await trust.isVisible().catch(() => false)) await trust.getByRole('button', { name: '信任', exact: true }).click();
  await waitReady(page);
  await settle(page);
}

/** @brief 在侧栏点会话文件为 file 的会话行（路径按 Windows 规则比较），等它就绪。 */
async function openRowFile(page, file) {
  const files = await page.locator('.session-item').evaluateAll((rows) => rows.map((row) => row.dataset.file));
  const match = files.find((item) => samePath(item, file));
  if (!match) throw new Error(`no session row for ${file}`);
  await rowOf(page, match).click();
  await waitReady(page);
  await settle(page);
}

/** @brief 当前一栏的会话标识（后台进程对已打开的会话直接返回它，不改界面）。 */
async function sessionIdOf(page) {
  const file = await activeFile(page);
  return page.evaluate(async (sessionFile) => (await window.mori.request({ type: 'session.open', sessionFile }))
    .sessionId, file);
}

/** @brief 当前一栏的输入框。 */
const composer = (page) => paneOf(page).locator('.composer textarea');
/** @brief 当前一栏的用户消息与助手回复条数。 */
const userCount = (page) => paneOf(page).getByTestId('user-message').count();
const errorCount = (page) => paneOf(page).getByTestId('error-card').count();

/** @brief 在输入框里写 text 按 Enter。 */
async function send(page, text) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** @brief 发一条消息，等它显示出来，再等本轮结束。 */
async function sendTurn(page, text, timeout = 120000) {
  const before = await userCount(page);
  await send(page, text);
  await until(async () => (await userCount(page)) > before, 10000, 100);
  await waitIdle(page, timeout);
}

/** @brief 当前一栏对话流里的提示（换模型、重建、压缩、已停止）。 */
function notices(page) {
  return page.evaluate((selector) => [...document.querySelectorAll(`${selector} [data-testid="notice"]`)]
    .map((item) => ({ kind: item.dataset.kind ?? null, text: item.textContent.trim(), from: item.dataset.from ?? null,
      to: item.dataset.to ?? null, reason: item.dataset.reason ?? null, hidden: item.dataset.hidden ?? null,
      summary: item.dataset.summary ?? null })), PANE);
}

/** @brief 当前一栏的阶段行此刻的 data-kind 与文字（去掉秒数）；没有时为 null。 */
function stageNow(page) {
  return page.evaluate((selector) => {
    const stage = document.querySelector(`${selector} [data-testid="stage"]`);
    return stage ? { kind: stage.dataset.kind ?? null, text: stage.textContent.replace(/ · \d+s$/, '').trim() } : null;
  }, PANE);
}

/** @brief 当前一栏顶栏的范围按钮与思考按钮。 */
function topbar(page) {
  return page.evaluate((selector) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    const thinking = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button && { text: button.textContent.trim(), pick: button.dataset.pick ?? null,
      current: button.dataset.current ?? null, disabled: button.disabled, title: button.title,
      thinking: thinking ? { level: thinking.dataset.level, reasoning: thinking.dataset.reasoning,
        disabled: thinking.disabled } : null };
  }, PANE);
}

/** @brief 在当前一栏的范围菜单里选 pick，等按钮显示它（不再是切换中）。 */
async function choosePick(page, pick) {
  await paneOf(page).getByTestId('model-button').click();
  await page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-pick="${pick}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    return button?.dataset.pick === want && !button.getAttribute('aria-disabled');
  }, { selector: PANE, want: pick }, { timeout: 15000 });
}

/** @brief 在当前一栏的思考菜单里选 level，等按钮的 data-level 变过去。 */
async function chooseThinking(page, level) {
  await paneOf(page).getByTestId('thinking-button').click();
  await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction(({ selector, want }) => document.querySelector(`${selector} [data-testid="thinking-button"]`)
    ?.dataset.level === want, { selector: PANE, want: level }, { timeout: 15000 });
}

/** @brief 拒绝启动卡此刻的内容；没有卡时为 null。 */
function blockedState(page) {
  return page.evaluate((selector) => {
    const card = document.querySelector(`${selector} [data-testid="blocked-card"]`);
    if (!card) return null;
    return { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? '',
      note: card.querySelector('.model-card-note')?.textContent ?? null,
      candidates: [...card.querySelectorAll('[data-testid="candidate"]')].map((item) => ({ ref: item.dataset.ref,
        reason: item.dataset.reason, text: item.textContent })),
      actions: [...card.querySelectorAll('[data-action]')].map((item) => [item.dataset.action, item.textContent]) };
  }, PANE);
}

/** @brief 等拒绝启动卡变成 kind；等不到时抛错。 */
async function waitBlocked(page, kind, timeout = 15000) {
  const card = await until(async () => {
    const state = await blockedState(page);
    return state?.kind === kind ? state : null;
  }, timeout, 200);
  if (!card) throw new Error(`blocked card ${kind} did not appear; now ${JSON.stringify(await blockedState(page))}`);
  return card;
}

/** @brief 点拒绝启动卡上的一个操作。 */
const clickCardAction = (page, action) => paneOf(page)
  .locator(`[data-testid="blocked-card"] [data-action="${action}"]`).click();

/** @brief 打开设置页的 Models 分节。 */
async function openModels(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 15000 });
}

/** @brief 设置页上点"返回会话"。 */
async function backToChat(page) {
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
  await waitReady(page);
}

/** @brief 设置页是否落在 Models 分节、停在顶部。 */
async function settingsShown(page) {
  await page.getByTestId('models-section').waitFor({ timeout: 10000 });
  await sleep(400);
  return page.evaluate(() => ({ models: Boolean(document.querySelector('[data-testid="models-section"]')),
    section: document.querySelector('[data-testid="settings-nav"] .active')?.dataset.section ?? null,
    scroll: Math.round(document.querySelector('.settings-body')?.scrollTop ?? 0) }));
}

/** @brief 模型行的档案摘要、告警、按钮。 */
function profileRow(page, ref) {
  return page.evaluate((target) => {
    const row = document.querySelector(`[data-testid="model-row"][data-model="${target}"]`);
    if (!row) return null;
    const items = [...row.querySelectorAll('[data-testid="profile"] [data-field]')];
    return { fields: Object.fromEntries(items.map((item) => [item.dataset.field, { value: item.dataset.value,
      text: item.textContent }])), warning: row.querySelector('[data-testid="truncation-warning"]')?.textContent ?? null,
    actions: [...row.querySelectorAll('[data-action]')].map((item) => item.dataset.action) };
  }, ref);
}

/** @brief 在提供商卡上点"Add model"，按 spec 填模型表单并保存，等新行出现。 */
async function addModelUi(page, providerId, spec) {
  const card = page.locator(`[data-testid="provider-card"][data-provider="${providerId}"]`);
  await card.locator('[data-action="add-model"]').click();
  const form = card.getByTestId('model-form');
  await form.waitFor({ timeout: 5000 });
  await form.getByLabel('Model id').fill(spec.id);
  if (spec.ctx) await form.getByLabel('Context window').fill(String(spec.ctx));
  if (spec.max) await form.getByLabel('Max output').fill(String(spec.max));
  if (spec.reasoning) await form.getByLabel('Supports thinking').check();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  await page.locator(`[data-testid="model-row"][data-model="${providerId}/${spec.id}"]`).waitFor({ timeout: 10000 });
}

/**
 * @brief 在页面里装一个 MutationObserver，DOM 每次变化时按 kind 记一个快照（与上一个相同时不记），抓只持续一瞬间的状态。
 * @param kind stage：阶段行的 data-kind、文字和此刻的用户消息条数；card：拒绝启动卡的 kind；
 *        tool：ref 那一行的 Tool calling；thinking：思考按钮的 data-reasoning 与是否可用
 */
async function watch(page, kind, ref = null) {
  await page.evaluate(({ which, selector, target }) => {
    const pane = () => document.querySelector(selector);
    const snaps = {
      stage: () => {
        const stage = pane()?.querySelector('[data-testid="stage"]');
        return stage && `${stage.dataset.kind ?? ''}|${stage.textContent.replace(/ · \d+s$/, '').trim()}|`
          + `${pane().querySelectorAll('[data-testid="user-message"]').length}`;
      },
      card: () => pane()?.querySelector('[data-testid="blocked-card"]')?.dataset.kind ?? 'none',
      tool: () => document.querySelector(`[data-testid="model-row"][data-model="${target}"] [data-field="tool_calling"]`)
        ?.dataset.value,
      thinking: () => {
        const button = pane()?.querySelector('[data-testid="thinking-button"]');
        return button && `${button.dataset.reasoning}|${button.disabled}`;
      },
    };
    window.__seen = [];
    window.__seenObserver?.disconnect();
    const push = () => {
      const value = snaps[which]();
      if (value && window.__seen.at(-1) !== value) window.__seen.push(value);
    };
    push();
    window.__seenObserver = new MutationObserver(push);
    window.__seenObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  }, { which: kind, selector: PANE, target: ref });
}

/** @brief 停下 watch，返回记下的快照。 */
const seen = (page) => page.evaluate(() => {
  window.__seenObserver?.disconnect();
  return window.__seen ?? [];
});

/** @brief 一个场景里的一步：出错时记一条失败（以场景的 MP 编号开头）、截图，回到会话页，继续下一步。 */
async function step(ctx, label, fn, mp = ctx.mp) {
  try {
    await fn();
  } catch (error) {
    record(`${mp} ${ctx.name} / ${label}: flow`, false, oneLine(error?.message ?? error, 500));
    await shot(ctx.page, `${ctx.name}-${label.replace(/\W+/g, '-')}`);
    await ctx.page?.keyboard.press('Escape').catch(() => {});
    if (await ctx.page?.getByTestId('settings-page').isVisible().catch(() => false)) {
      await backToChat(ctx.page).catch(() => {});
    }
  }
}

/** @brief 两个列表的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// ---------- 场景：拒绝启动卡（MP-09） ----------

/** @brief no_pick：卡、操作、Open settings、Change model…，然后选一个正在验证的分组。 */
async function noPickStep(ctx) {
  const { page } = ctx;
  await openProject(ctx, ctx.project);
  const card = await waitBlocked(page, 'no_pick');
  record('MP-09 no_pick: card text "No default model range; pick one."',
    card.title === 'No default model range; pick one.', card.title);
  record('MP-09 no_pick: actions "Change model…" and "Open settings", no candidate list',
    same(card.actions, [['change-model', 'Change model…'], ['open-settings', 'Open settings']])
    && card.candidates.length === 0, JSON.stringify(card));
  const bar = await topbar(page);
  record('MP-09 no_pick: the range button shows "No model range"', bar?.text === 'No model range', bar?.text);
  await clickCardAction(page, 'open-settings');
  const shown = await settingsShown(page);
  record('MP-09 no_pick: "Open settings" opens Settings → Models at the top',
    shown.models && shown.section === 'models' && shown.scroll === 0, JSON.stringify(shown));
  await backToChat(page);
  await clickCardAction(page, 'change-model');
  const menu = await page.getByTestId('model-menu').waitFor({ timeout: 5000 }).then(() => true, () => false);
  record('MP-09 no_pick: "Change model…" opens the range menu of this pane', menu, '');
  await page.getByTestId('model-menu').locator('[role="menuitemradio"][data-pick="slowg"]').click();
}

/** @brief verifying：全部候选在验证中时的卡；发送不可用、后台进程拒绝；探针结束后卡自动消失。 */
async function verifyingStep(ctx) {
  const { page } = ctx;
  const card = await waitBlocked(page, 'verifying');
  record('MP-09 verifying: card text "Verifying slowp/slow-coder…"', card.title === 'Verifying slowp/slow-coder…',
    card.title);
  record('MP-09 verifying: no "Verify now" (no actions) and no candidate list while every candidate is verifying',
    card.actions.length === 0 && card.candidates.length === 0, JSON.stringify(card));
  await send(page, 'plain must not be sent');
  await sleep(800);
  const draft = await composer(page).inputValue();
  const sendDisabled = await paneOf(page).locator('.send-button').isDisabled();
  record('MP-09 blocked: Enter does not send, the draft stays and Send is disabled',
    (await userCount(page)) === 0 && draft === 'plain must not be sent' && sendDisabled,
    `users=${await userCount(page)} draft="${draft}" sendDisabled=${sendDisabled}`);
  await composer(page).fill('');
  const before = ctx.eps.reduce((sum, ep) => sum + talk(ep).length, 0);
  const id = await sessionIdOf(page);
  await bridge(page, { type: 'session.prompt', sessionId: id, text: 'plain kernel must refuse' });
  const refused = await until(async () => (await events(page, 'mori.prompt_error'))
    .find((item) => item.sessionId === id && item.event.text === 'plain kernel must refuse'), 5000, 200);
  const after = ctx.eps.reduce((sum, ep) => sum + talk(ep).length, 0);
  record(`MP-09 blocked: the kernel refuses session.prompt with "${BLOCKED_MESSAGE}"`,
    refused?.event?.message === BLOCKED_MESSAGE, JSON.stringify(refused?.event ?? null));
  // 这条提示是测试经进程桥直接发的（界面上没有先显示的消息），所以界面按 v0 的规则显示错误卡，不检查它。
  record('MP-09 blocked: the refused prompt reaches no endpoint', after === before,
    `conversation requests ${before} → ${after}`);
  await composer(page).fill('');
  const cleared = await until(async () => (await blockedState(page)) === null, 90000, 500);
  const bar = await topbar(page);
  record('MP-09 verifying: the card clears by itself when the probes finish', Boolean(cleared)
    && bar?.text === 'slowg · slow-coder', `card=${JSON.stringify(await blockedState(page))} button=${bar?.text}`);
}

/** @brief no_candidate：三种排除原因、五个操作；每个操作的去处（不改配置）。 */
async function noCandidateStep(ctx) {
  const { page } = ctx;
  await waitProfiles(page, ['dead/dead-coder'], finished, 60000);
  await choosePick(page, 'mix');
  const card = await waitBlocked(page, 'no_candidate');
  record('MP-09 no_candidate: card text "This session can\'t start: no model fits."',
    card.title === "This session can't start: no model fits.", card.title);
  const lines = card.candidates.map((item) => `${item.reason}:${item.text}`);
  record('MP-09 no_candidate: one line per candidate with its reason', same(lines, [
    'unverified:dead/dead-coder — tool calling not verified yet',
    'zone_blocked:pubp/pub-coder — zone public is not allowed for this project',
    'zone_unconfirmed:unc/unc-coder — network zone not confirmed']), lines.join(' | '));
  record('MP-09 no_candidate: actions Verify now / Allow public for this project… / Confirm zone… / Change model… / '
    + 'Open settings, in this order', same(card.actions, [['verify', 'Verify now'],
    ['allow-zone', 'Allow public for this project…'], ['confirm-zone', 'Confirm zone…'],
    ['change-model', 'Change model…'], ['open-settings', 'Open settings']]), JSON.stringify(card.actions));
  await clickCardAction(page, 'confirm-zone');
  const zoneFocus = await until(() => page.evaluate(() => {
    const el = document.activeElement;
    return el?.matches('[data-action="confirm-zone"]')
      ? el.closest('[data-testid="zone-unconfirmed"]')?.dataset.provider ?? '' : null;
  }), 5000, 200);
  record('MP-09 no_candidate: "Confirm zone…" opens Settings → Models with focus on the unconfirmed provider\'s row',
    zoneFocus === 'unc', `focused confirm-zone of ${zoneFocus}`);
  await backToChat(page);
  await clickCardAction(page, 'allow-zone');
  const projectFocus = await until(() => page.evaluate(() => {
    const el = document.activeElement;
    return el?.matches('[data-testid="project-zone"]')
      ? `${el.closest('[data-testid="project-row"]')?.dataset.path}|${el.dataset.zone}` : null;
  }), 5000, 200);
  const [path, zone] = (projectFocus ?? '|').split('|');
  record('MP-09 no_candidate: "Allow public for this project…" opens Project access with focus on this project',
    projectKey(path || '.') === projectKey(ctx.project) && zone === 'public', `focused ${projectFocus}`);
  await backToChat(page);
  await noCandidateMenuAndSettings(ctx);
}

/** @brief no_candidate 的 Change model… 与 Open settings。 */
async function noCandidateMenuAndSettings(ctx) {
  const { page } = ctx;
  await clickCardAction(page, 'change-model');
  const menu = await page.getByTestId('model-menu').waitFor({ timeout: 5000 }).then(() => true, () => false);
  record('MP-09 no_candidate: "Change model…" opens the range menu', menu, '');
  await page.keyboard.press('Escape');
  await page.getByTestId('model-menu').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await clickCardAction(page, 'open-settings');
  const shown = await settingsShown(page);
  record('MP-09 no_candidate: "Open settings" opens Settings → Models at the top', shown.models && shown.scroll === 0,
    JSON.stringify(shown));
  await backToChat(page);
}

/** @brief Verify now：端点恢复后点它，卡先变成 verifying，探针通过后消失，会话可以发送。 */
async function verifyNowStep(ctx) {
  const { page } = ctx;
  // 启动时探针连不上 dead 端口，提供商的 connection 记录 30 秒后到期（§12）；等过这段再开端点，避免测到这条记录。
  const wait = ctx.startedAt + 33000 - Date.now();
  if (wait > 0) await sleep(wait);
  const dead = await startEndpoint(ctx, PORT + 2, {}, { proxy: false });
  await watch(page, 'card');
  const id = await sessionIdOf(page);
  const mark = (await events(page, 'mori.model_state')).length;
  await clickCardAction(page, 'verify');
  const cleared = await until(async () => (await blockedState(page)) === null, 90000, 300);
  const kinds = await seen(page);
  const states = (await events(page, 'mori.model_state')).slice(mark).filter((item) => item.sessionId === id)
    .map((item) => item.event.blocked?.kind ?? 'none');
  record('MP-09 Verify now: while the probes run the card is verifying (no Verify now)',
    kinds.includes('verifying'), `card ${kinds.join(' > ')}; mori.model_state blocked ${states.join(' > ')}`);
  const bar = await topbar(page);
  record('MP-09 Verify now: the card clears after the probes pass', Boolean(cleared) && bar?.text === 'mix · dead-coder',
    `cards ${kinds.join(' > ')}; button ${bar?.text}`);
  await sendTurn(page, 'plain after verify now');
  const reply = await lastReply(page);
  record('MP-09 Verify now: the session can send afterwards', reply.includes(PLAIN_REPLY)
    && dead.log.some((line) => !line.probe && line.status === 200), oneLine(reply, 80));
}

/** @brief Allow <zone>：勾 Public 并确认后，只因区域被排除的会话可以发送。 */
async function allowZoneStep(ctx) {
  const { page } = ctx;
  await ctrlN(page);
  await waitBlocked(page, 'no_pick');
  await choosePick(page, 'pubg');
  const card = await waitBlocked(page, 'no_candidate');
  record('MP-09 no_candidate (zone only): actions Allow public… / Change model… / Open settings',
    same(card.actions.map(([action]) => action), ['allow-zone', 'change-model', 'open-settings']),
    JSON.stringify(card.actions));
  await clickCardAction(page, 'allow-zone');
  const box = page.locator('[data-testid="project-zone"][data-zone="public"]:focus');
  await box.waitFor({ timeout: 5000 });
  // 勾 Public 先弹确认框，确认前勾选框不变（受控），所以用 click 而不是 check。
  await box.click();
  const dialog = page.getByTestId('public-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.locator('.dialog-actions button:not([data-role="cancel"])').click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await backToChat(page);
  const cleared = await until(async () => (await blockedState(page)) === null, 15000, 300);
  record('MP-09 Allow public for this project…: after allowing in Project access the card clears', Boolean(cleared),
    JSON.stringify(await blockedState(page)));
}

/** @brief pick_missing：会话的范围指向的分组被删掉。 */
async function pickMissingStep(ctx) {
  const { page } = ctx;
  await ctrlN(page);
  await waitBlocked(page, 'no_pick');
  await choosePick(page, 'tmpg');
  await until(async () => (await blockedState(page)) === null, 15000, 300);
  await openModels(page);
  await page.locator('[data-testid="group-row"][data-group="tmpg"] [data-action="delete-group"]').click();
  const dialog = page.locator('[data-testid="confirm-dialog"][data-kind="delete-group"]');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.locator('.dialog-actions button:not([data-role="cancel"])').click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  await backToChat(page);
  const card = await waitBlocked(page, 'pick_missing');
  record('MP-09 pick_missing: card text "tmpg is not in your model settings." / "Used by this session\'s model range."',
    card.title === 'tmpg is not in your model settings.' && card.note === "Used by this session's model range.",
    `${card.title} / ${card.note}`);
  record('MP-09 pick_missing: actions "Change model…" and "Open settings"',
    same(card.actions, [['change-model', 'Change model…'], ['open-settings', 'Open settings']]),
    JSON.stringify(card.actions));
  const bar = await topbar(page);
  record('MP-09 pick_missing: the range button shows the missing name', bar?.text === 'tmpg', bar?.text);
}

/** @brief project_config：项目的 .mori/models.json 有未知字段。 */
async function projectConfigStep(ctx) {
  const { page } = ctx;
  await openProject(ctx, ctx.broken);
  const card = await waitBlocked(page, 'project_config');
  record('MP-09 project_config: card text ".mori/models.json: <reason>" naming the bad field',
    card.title.startsWith('.mori/models.json: ') && card.title.includes('bogus'), card.title);
  record('MP-09 project_config: only "Open settings"', same(card.actions, [['open-settings', 'Open settings']]),
    JSON.stringify(card.actions));
  await clickCardAction(page, 'open-settings');
  const shown = await settingsShown(page);
  record('MP-09 project_config: "Open settings" opens Settings → Models at the top', shown.models && shown.scroll === 0,
    JSON.stringify(shown));
  await backToChat(page);
}

/** @brief 场景 blocked（MP-09）：除 config_invalid 外的每种拒绝启动卡、操作与解除。 */
async function blockedScenario(ctx) {
  const main = await startEndpoint(ctx, PORT);
  // 慢端点：每个请求先等 6 秒，第一次探测要半分钟以上，这期间会话按 verifying 拒绝启动。
  const slow = await startEndpoint(ctx, PORT + 1, { FAKE_FIRST_DELAY_MS: '6000' });
  ctx.project = makeProject(ctx, 'proj');
  ctx.broken = makeProject(ctx, 'proj-broken', { '.mori/models.json': '{ "allowedZones": ["local"], "bogus": true }\n' });
  // synthetic test setup：五个提供商（本机、公网、区域未确认、地址上没有服务、慢）与四个分组，没有默认范围。
  seedConfig(ctx, { providers: [
    provider('local1', 'Local One', main.url, [model('fake-coder')]),
    provider('pubp', 'Public P', main.url, [model('pub-coder')], { zone: 'public' }),
    provider('unc', 'Unconfirmed P', main.url, [model('unc-coder')], { zone: null }),
    provider('dead', 'Dead P', `http://127.0.0.1:${PORT + 2}/v1`, [model('dead-coder')]),
    provider('slowp', 'Slow P', slow.url, [model('slow-coder')]),
  ], groups: [group('mix', ['dead', 'pubp', 'unc']), group('slowg', ['slowp']), group('tmpg', ['local1']),
    group('pubg', ['pubp'])] });
  await startApp(ctx);
  ctx.startedAt = Date.now();
  await step(ctx, 'no_pick', () => noPickStep(ctx));
  await step(ctx, 'verifying', () => verifyingStep(ctx));
  await step(ctx, 'no_candidate', () => noCandidateStep(ctx));
  await step(ctx, 'verify now', () => verifyNowStep(ctx));
  await step(ctx, 'allow zone', () => allowZoneStep(ctx));
  await step(ctx, 'pick_missing', () => pickMissingStep(ctx));
  await step(ctx, 'project_config', () => projectConfigStep(ctx));
}

/** @brief 场景 configInvalid（MP-09）：model-config.json 读不出时会话按 config_invalid 拒绝启动，文件不被覆盖。 */
async function configInvalidScenario(ctx) {
  const project = makeProject(ctx, 'proj');
  const file = join(ctx.userData, 'model-config.json');
  // synthetic test setup：写坏的配置文件。
  const broken = '{ "version": 1, "providers": [\n';
  writeFileSync(file, broken);
  await startApp(ctx);
  const { page } = ctx;
  const form = await page.getByTestId('connection-form').count();
  await openProject(ctx, project);
  const card = await waitBlocked(page, 'config_invalid');
  record('MP-09 config_invalid: card text "Model settings can\'t be read: <path>: <message>"',
    card.title.startsWith("Model settings can't be read: ") && card.title.includes('model-config.json')
    && card.title.length > "Model settings can't be read: ".length + file.length, card.title);
  record('MP-09 config_invalid: only "Open settings"; no first-run form',
    same(card.actions, [['open-settings', 'Open settings']]) && form === 0, JSON.stringify(card.actions));
  await clickCardAction(page, 'open-settings');
  const error = await page.getByTestId('models-load-error').innerText({ timeout: 10000 }).catch(() => '');
  record('MP-09 config_invalid: "Open settings" shows only the read error and Reload in Settings → Models',
    error.includes("Model settings can't be read:") && error.includes('Reload'), oneLine(error, 200));
  await backToChat(page);
  await send(page, 'plain must not be sent');
  await sleep(800);
  record('MP-09 config_invalid: sending is disabled and the file is not overwritten',
    (await userCount(page)) === 0 && readFileSync(file, 'utf8') === broken, '');
}

// ---------- 场景：探针与档案（MP-10） ----------

/** 加进 pv 的模型与期望的档案摘要（合成端点的后缀各关掉一项探针能力） */
const PROBE_MODELS = [
  { id: 'fake-coder-notools', expect: { tool_calling: 'failed' }, texts: { tool_calling: 'Failed' } },
  { id: 'fake-coder-nochoice', expect: { tool_calling: 'verified', tier: 'B', reasoning: 'none' },
    texts: { tier: 'B' } },
  { id: 'fake-coder-noschema', expect: { tool_calling: 'verified', tier: 'A' }, texts: { tier: 'A' } },
  { id: 'fake-coder-nochoice-noschema', expect: { tool_calling: 'verified', tier: 'C' }, texts: { tier: 'C' } },
  { id: 'fake-coder-replay', reasoning: true, expect: { tool_calling: 'verified', tier: 'A',
    reasoning: 'reasoning_content' }, texts: { reasoning: 'reasoning_content', tool_calling: 'Verified' } },
];

/** @brief 档案摘要的一项是否符合期望（data-value 与显示的文字）。 */
function rowMatches(row, spec) {
  const valuesOk = Object.entries(spec.expect).every(([field, value]) => row?.fields[field]?.value === value);
  const textsOk = Object.entries(spec.texts).every(([field, text]) => row?.fields[field]?.text.endsWith(`: ${text}`));
  return valuesOk && textsOk;
}

/** @brief 加模型后自动探测，Models 行显示正确的 Tool calling、Handoff tier、Reasoning field。 */
async function probeRowsStep(ctx) {
  const { page } = ctx;
  await openModels(page);
  for (const spec of PROBE_MODELS) await addModelUi(page, 'pv', spec);
  const refs = PROBE_MODELS.map((spec) => `pv/${spec.id}`);
  const profiles = await waitProfiles(page, refs, finished, 240000);
  const base = await profileRow(page, 'pv/fake-coder');
  record('MP-10 pv/fake-coder: Tool calling Verified, Handoff tier A, Reasoning field none',
    rowMatches(base, { expect: { tool_calling: 'verified', tier: 'A', reasoning: 'none' }, texts: {} }),
    JSON.stringify(base?.fields));
  for (const spec of PROBE_MODELS) {
    const row = await profileRow(page, `pv/${spec.id}`);
    const shown = Object.entries(spec.expect).map(([field, value]) => `${field}=${value}`).join(', ');
    record(`MP-10 pv/${spec.id}: added in Settings → Models, probed automatically; row shows ${shown}`,
      rowMatches(row, spec), JSON.stringify(row?.fields));
  }
  const replay = profiles['pv/fake-coder-replay']?.reasoning;
  record('MP-10 pv/fake-coder-replay: profile reasoning.replay is required', replay?.replay === 'required',
    JSON.stringify(replay));
  await backToChat(page);
}

/** @brief 并发 1、对话占着槽位时加模型：探针排在对话之后，对话结束后完成。 */
async function probeQueueStep(ctx, ep) {
  const { page } = ctx;
  await send(page, 'wait 8s');
  const convo = await until(() => talk(ep).find((body) => body.lastUser === 'wait 8s'), 10000, 100);
  if (!convo) throw new Error('the conversation request did not arrive');
  await openModels(page);
  await addModelUi(page, 'pv', { id: 'fake-coder-late' });
  const addedAt = Date.now();
  await waitProfiles(page, ['pv/fake-coder-late'], verified, 120000);
  const probes = ep.bodies.filter((body) => body.probe && body.model === 'fake-coder-late');
  const first = probes[0]?.at ?? 0;
  record('MP-10 background: with concurrency 1, probes of a model added during a conversation wait until it ends',
    addedAt < convo.at + 7000 && first >= convo.at + 7800,
    `conversation sent at 0 ms, model added at ${addedAt - convo.at} ms, first probe sent at ${first - convo.at} ms`);
  record('MP-10 background: the queued probes then complete and the model is verified', probes.length > 0,
    `${probes.length} probe requests`);
  await backToChat(page);
  await waitIdle(page, 30000);
}

/** @brief 场景 probes（MP-10）。 */
async function probesScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  // synthetic test setup：一个并发上限为 1 的提供商。
  seedConfig(ctx, { providers: [provider('pv', 'Probe Provider', ep.url, [model('fake-coder')], { concurrency: 1 })],
    normalDefault: 'pv' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['pv/fake-coder']);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'rows', () => probeRowsStep(ctx));
  await step(ctx, 'background queue', () => probeQueueStep(ctx, ep));
}

// ---------- 场景：需要同意的探针（MP-11） ----------

/** @brief 合成端点日志里的探针请求条数。 */
const probeLines = (ep) => ep.log.filter((line) => line.probe).length;

/**
 * @brief 在模型行上点需要同意的探针：run 为假时在确认框点 Cancel；为真时点 Run test，等档案的 probedAt 变化。
 * @return 确认框的文字、之后的档案、这期间合成端点多了几条探针请求
 */
async function consent(ctx, ep, ref, action, run) {
  const { page } = ctx;
  const row = page.locator(`[data-testid="model-row"][data-model="${ref}"]`);
  const before = (await modelsInfo(page)).profiles[ref]?.probedAt ?? 0;
  const lines = probeLines(ep);
  await row.locator(`[data-action="${action}"]`).click();
  const dialog = page.locator(`[data-testid="confirm-dialog"][data-kind="${action}"]`);
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  if (!run) {
    await dialog.locator('[data-role="cancel"]').click();
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
    await sleep(2500);
    return { text, added: probeLines(ep) - lines };
  }
  await dialog.locator('.dialog-actions button:not([data-role="cancel"])').click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  const profiles = await waitProfiles(page, [ref], (profile) => (profile?.probedAt ?? 0) > before, 240000);
  await sleep(500);
  return { text, profile: profiles[ref], added: probeLines(ep) - lines, row: await profileRow(page, ref) };
}

/** @brief 长输入探针：确认前不跑；不截断的模型 truncation none；-truncate 判出静默截断并告警。 */
async function longInputStep(ctx, e1) {
  const cancelled = await consent(ctx, e1, 'lp/fake-coder', 'long-input', false);
  record('MP-11 long-input: the confirm dialog states about 4,096 + 7,373 tokens; Cancel sends nothing',
    cancelled.text.includes('Run the long-input test on fake-coder?') && cancelled.text.includes('4,096')
    && cancelled.text.includes('7,373') && cancelled.added === 0, `${oneLine(cancelled.text, 200)}; +${cancelled.added}`);
  const plain = await consent(ctx, e1, 'lp/fake-coder', 'long-input', true);
  record('MP-11 long-input: runs only after "Run test"; a model that keeps long input stays truncation none',
    plain.added >= 2 && plain.profile.context.truncation === 'none' && plain.profile.context.effective === 8192
    && plain.row.warning === null, `+${plain.added} probes, ${JSON.stringify(plain.profile.context)}`);
  const cut = await consent(ctx, e1, 'lp/fake-coder-truncate', 'long-input', true);
  record('MP-11 long-input: -truncate is judged silent, the row warns "Silently truncates long input"',
    cut.profile.context.truncation === 'silent' && cut.row.warning === 'Silently truncates long input'
    && Number(cut.row.fields.context?.value) < 8192, `${JSON.stringify(cut.profile.context)} warning=${cut.row.warning}`);
}

/** @brief 取消探针：确认前不跑；/metrics 回落为 Verified，-nocancel 为 Not verified，没有指标为 Unknown。 */
async function cancelStep(ctx, e1, e2) {
  const row = await profileRow(ctx.page, 'lp/fake-coder');
  record('MP-11 cancel: "Cancel test…" is offered for the vLLM server', row.actions.includes('cancel-test'),
    row.actions.join(','));
  const cancelled = await consent(ctx, e1, 'lp/fake-coder', 'cancel-test', false);
  record('MP-11 cancel: the confirm dialog explains the test; Cancel sends nothing',
    cancelled.text.includes('Run the cancel test on fake-coder?') && cancelled.added === 0,
    `${oneLine(cancelled.text, 160)}; +${cancelled.added}`);
  const ok = await consent(ctx, e1, 'lp/fake-coder', 'cancel-test', true);
  record('MP-11 cancel: metrics fall back after disconnect → cancel_verified true, row "Cancel: Verified"',
    ok.added >= 1 && ok.profile.cancel_verified === true && ok.row.fields.cancel?.text.endsWith(': Verified'),
    `+${ok.added} ${JSON.stringify(ok.row.fields.cancel)}`);
  const stuck = await consent(ctx, e1, 'lp/fake-coder-nocancel', 'cancel-test', true);
  record('MP-11 cancel: -nocancel → cancel_verified false, row "Cancel: Not verified"',
    stuck.profile.cancel_verified === false && stuck.row.fields.cancel?.text.endsWith(': Not verified'),
    JSON.stringify(stuck.row.fields.cancel));
  const blind = await consent(ctx, e2, 'nm/fake-coder', 'cancel-test', true);
  // consent 等到档案的 probedAt 变化才返回，即取消探针确实跑过；没有指标时不必再发长输出请求。
  record('MP-11 cancel: FAKE_NO_METRICS=1 → the test runs and gives cancel_verified unknown, row "Cancel: Unknown"',
    blind.profile.cancel_verified === 'unknown' && blind.row.fields.cancel?.text.endsWith(': Unknown'),
    `+${blind.added} probe requests, ${JSON.stringify(blind.row.fields.cancel)}`);
}

/** @brief 场景 consent（MP-11）。 */
async function consentScenario(ctx) {
  const env = { FAKE_MAX_MODEL_LEN: '8192', FAKE_MODELS: 'fake-coder,fake-coder-truncate,fake-coder-nocancel' };
  const e1 = await startEndpoint(ctx, PORT, env, { proxy: false });
  const e2 = await startEndpoint(ctx, PORT + 1, { ...env, FAKE_NO_METRICS: '1', FAKE_MODELS: 'fake-coder' },
    { proxy: false });
  const small = (id) => model(id, { ctx: 8192, max: 1024 });
  // synthetic test setup：窗口 8192 的模型（长输入探针的请求不太大）；第二个端点没有 /metrics。
  seedConfig(ctx, { providers: [
    provider('lp', 'Long Provider', e1.url, [small('fake-coder'), small('fake-coder-truncate'),
      small('fake-coder-nocancel')]),
    provider('nm', 'No Metrics', e2.url, [small('fake-coder')]),
  ], normalDefault: 'lp' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['lp/fake-coder', 'lp/fake-coder-truncate', 'lp/fake-coder-nocancel', 'nm/fake-coder']);
  const untouched = (await modelsInfo(ctx.page)).profiles['lp/fake-coder'];
  record('MP-11 the automatic probes leave long input and cancel untested (truncation unknown, cancel unknown)',
    untouched.context.truncation === 'unknown' && untouched.cancel_verified === 'unknown',
    `${untouched.context.truncation}/${untouched.cancel_verified}`);
  await openModels(ctx.page);
  await step(ctx, 'long input', () => longInputStep(ctx, e1));
  await step(ctx, 'cancel', () => cancelStep(ctx, e1, e2));
}

// ---------- 场景：指纹与服务版本（MP-12） ----------

/** @brief model-profiles.json 里 fake-coder 的档案。 */
function storedProfile(ctx) {
  const file = join(ctx.userData, 'model-profiles.json');
  return JSON.parse(readFileSync(file, 'utf8')).profiles.find((item) => item.modelId === 'fake-coder');
}

/** @brief 改窗口后重新探测；重新探测期间打开的会话照常发送。 */
async function windowChangeStep(ctx, ep) {
  const { page } = ctx;
  const before = storedProfile(ctx);
  await openModels(page);
  await watch(page, 'tool', 'fp/fake-coder');
  await page.locator('[data-testid="model-row"][data-model="fp/fake-coder"] [data-action="edit"]').click();
  const form = page.getByTestId('model-form');
  await form.getByLabel('Context window').fill('100000');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  await until(() => page.evaluate(() => (window.__seen ?? []).includes('reverifying')), 10000, 200);
  const tools = await seen(page);
  record('MP-12 changing the context window re-probes the model: Tool calling shows Re-verifying…',
    tools.includes('reverifying'), tools.join(' > '));
  await backToChat(page);
  await watch(page, 'card');
  await sendTurn(page, 'plain during re-verify');
  const sentAt = talk(ep).find((body) => body.lastUser === 'plain during re-verify')?.at ?? 0;
  const reply = await lastReply(page);
  const cards = await seen(page);
  const after = await waitProfiles(page, ['fp/fake-coder'], (profile) => profile?.probedAt > before.probedAt, 180000);
  const laterProbes = ep.bodies.filter((body) => body.probe && body.at > sentAt).length;
  record('MP-12 while re-verifying, the open session still sends (old result used for selection)',
    reply.includes(PLAIN_REPLY) && same(cards, ['none']) && laterProbes > 0,
    `cards ${cards.join(' > ')}; probe requests after the message ${laterProbes}`);
  const stored = storedProfile(ctx);
  record('MP-12 the new profile replaces the old one after re-probing (new fingerprint, declared window 100000)',
    stored.fingerprint !== before.fingerprint && after['fp/fake-coder'].context.declared === 100000,
    `declared ${after['fp/fake-coder'].context.declared}`);
}

/** @brief 两次启动之间服务版本变了：启动时重新探测；第三次启动时端点连不上：档案不变。 */
async function versionStep(ctx, endpoint) {
  await stopApp(ctx);
  await endpoint.stop();
  const ep = await startEndpoint(ctx, PORT, { FAKE_SERVER_VERSION: '0.11.0' });
  const before = storedProfile(ctx);
  await startApp(ctx);
  const changed = await until(() => {
    const stored = storedProfile(ctx);
    return stored.auto.server.version === '0.11.0' ? stored : null;
  }, 120000, 500);
  record('MP-12 a different FAKE_SERVER_VERSION at the next launch re-probes the model',
    Boolean(changed) && ep.bodies.some((body) => body.probe) && changed.probedAt > before.probedAt,
    `version ${before.auto.server.version} → ${changed?.auto.server.version}; `
    + `probe requests ${ep.bodies.filter((body) => body.probe).length}`);
  await stopApp(ctx);
  await ep.stop();
  const text = readFileSync(join(ctx.userData, 'model-profiles.json'), 'utf8');
  await startApp(ctx);
  await openRowFile(ctx.page, ctx.sessionFile).catch(() => {});
  await sleep(8000);
  const view = (await modelsInfo(ctx.page)).profiles['fp/fake-coder'];
  record('MP-12 version endpoint unreachable at launch and on session open: the profile is unchanged',
    readFileSync(join(ctx.userData, 'model-profiles.json'), 'utf8') === text && view?.tool_calling.state === 'verified',
    `tool calling ${view?.tool_calling.state}`);
}

/** @brief 场景 fingerprint（MP-12）。 */
async function fingerprintScenario(ctx) {
  // 每个请求先等 1.5 秒：一组探针要十几秒，回复只要两秒，测"重新探测期间仍可发送"。
  const ep = await startEndpoint(ctx, PORT, { FAKE_FIRST_DELAY_MS: '1500', FAKE_SERVER_VERSION: '0.10.1' });
  seedConfig(ctx, { providers: [provider('fp', 'FP Provider', ep.url, [model('fake-coder')])], normalDefault: 'fp' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['fp/fake-coder'], verified, 180000);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'window change', () => windowChangeStep(ctx, ep));
  ctx.sessionFile = await activeFile(ctx.page);
  await step(ctx, 'server version', () => versionStep(ctx, ep));
}

// ---------- 场景：接手判断与重建（MP-21，含 MP-34 的重建阶段行） ----------

/** @brief 先由 A 用一条有工具调用的消息开头，再发 count 条带填充文字的 plain 消息，最后一条短消息。 */
async function buildHistory(page, label, count = 0, size = 6000) {
  await sendTurn(page, `hi there ${label}`);
  for (let index = 0; index < count; index += 1) await sendTurn(page, `plain ${label}-${index} ${filler(size)}`);
  if (count > 0) await sendTurn(page, `plain ${label} short`);
}

/** @brief 发一条消息前后的对照：提示、错误卡、v0 压缩提示、代理记下的新请求、合成端点日志的新行。 */
async function turnWith(ctx, ep, text, fn = null) {
  const { page } = ctx;
  const mark = { bodies: ep.bodies.length, log: ep.log.length, notices: (await notices(page)).length };
  const compactedBefore = (await notices(page)).filter((item) => item.text === COMPACTED_NOTICE).length;
  await (fn ? fn() : sendTurn(page, text));
  const all = await notices(page);
  return { sent: ep.bodies.slice(mark.bodies), lines: ep.log.slice(mark.log), notices: all.slice(mark.notices),
    errors: await errorCount(page), unavailable: await paneOf(page).getByTestId('unavailable-card').count(),
    compacted: all.filter((item) => item.text === COMPACTED_NOTICE).length - compactedBefore,
    reply: await lastReply(page) };
}

/** @brief 段开始、对话很短：只去掉工具调用（不压缩），提示文字。 */
async function startStripCase(ctx, ep) {
  const { page } = ctx;
  await buildHistory(page, 's1');
  await choosePick(page, 'pb/fake-coder-replay');
  const turn = await turnWith(ctx, ep, 'plain s1 after switch');
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  record('MP-21 reply start, short conversation: strip only; notice "Rebuilt the conversation for '
    + 'pb/fake-coder-replay: recent turns without tool calls"', rebuild?.summary === 'false'
    && rebuild.text === 'Rebuilt the conversation for pb/fake-coder-replay: recent turns without tool calls',
  JSON.stringify(rebuild ?? turn.notices));
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'fake-coder-replay');
  record('MP-21 reply start, short conversation: no compaction; the -replay model gets the history without tool calls',
    turn.sent.every((body) => !body.summary) && request && !hasToolHistory(request.messages), brief(request));
  record('MP-21 reply start, short conversation: the -replay model accepts it (no 400) and replies; no error card',
    turn.lines.every((line) => line.status !== 400) && turn.reply.includes(PLAIN_REPLY) && turn.errors === 0,
    turn.lines.map((line) => `${line.model}:${line.status}`).join(','));
  const entry = customs(await activeFile(page), 'mori.rebuild').at(-1);
  record('MP-21 reply start, short conversation: the session file records mori.rebuild { summary: false }',
    entry?.model === 'pb/fake-coder-replay' && entry.summary === false, JSON.stringify(entry));
}

/** @brief 段开始、对话较长：由新模型压缩出摘要再接手；阶段行显示重建中（MP-34）。 */
async function startRebuildCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await buildHistory(page, 's2', 3, 6000);
  await choosePick(page, 'pb/fake-coder-replay');
  const users = await userCount(page);
  await watch(page, 'stage');
  const turn = await turnWith(ctx, ep, 'plain s2 after long history');
  const stages = await seen(page);
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  record('MP-21 reply start, long conversation: rebuild with summary; notice "Rebuilt the conversation for '
    + 'pb/fake-coder-replay: summary + recent turns"', rebuild?.summary === 'true'
    && rebuild.text === 'Rebuilt the conversation for pb/fake-coder-replay: summary + recent turns',
  JSON.stringify(rebuild ?? turn.notices));
  const summary = turn.sent.find((body) => body.summary);
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'fake-coder-replay');
  const keeps = request?.messages.some((message) => contentText(message.content).includes(SUMMARY_TEXT));
  record('MP-21 reply start, long conversation: the compaction is made by the -replay model',
    summary?.model === 'fake-coder-replay', brief(summary));
  record('MP-21 reply start, long conversation: the rebuilt context keeps the compaction summary and has no tool calls',
    Boolean(keeps) && !hasToolHistory(request.messages) && turn.reply.includes(PLAIN_REPLY), brief(request));
  record('MP-21 rebuild: no v0 compaction notice and no error card while rebuilding',
    turn.compacted === 0 && turn.errors === 0, `compaction notices +${turn.compacted}, error cards ${turn.errors}`);
  const want = 'rebuild|Rebuilding the conversation for pb/fake-coder-replay…';
  record('MP-34 preparing: the stage line shows "Rebuilding the conversation for <B>…" with the message already shown',
    stages.includes(`${want}|${users + 1}`), stages.join(' > '));
}

/** @brief 段内换到 -replay 模型：只去掉工具调用，不压缩，新模型接手。 */
async function inReplyStripCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await choosePick(page, 'g3');
  await buildHistory(page, 's3');
  const turn = await turnWith(ctx, ep, 'plain s3 http-404-once');
  const change = turn.notices.find((item) => item.kind === 'model-switch');
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  record('MP-21 in reply: switching to the -replay model shows the switch and "recent turns without tool calls"',
    change?.from === 'pa3/fake-coder' && change.to === 'pb/fake-coder-replay' && rebuild?.summary === 'false',
    JSON.stringify(turn.notices));
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'fake-coder-replay');
  record('MP-21 in reply: strip only — no compaction request; the -replay model gets no tool calls and replies',
    turn.sent.every((body) => !body.summary) && request && !hasToolHistory(request.messages)
    && turn.lines.every((line) => line.status !== 400 || line.model !== 'fake-coder-replay')
    && turn.reply.includes(PLAIN_REPLY) && turn.errors === 0, brief(request));
}

/** @brief 窗口小的模型：段开始时重建后接手。 */
async function smallStartCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await buildHistory(page, 's4', 3, 10000);
  await choosePick(page, 'ps/small-coder');
  const turn = await turnWith(ctx, ep, 'plain s4 small window');
  const rebuild = turn.notices.find((item) => item.kind === 'rebuild');
  const summary = turn.sent.find((body) => body.summary);
  const request = turn.sent.find((body) => !body.probe && !body.summary && body.model === 'small-coder');
  record('MP-21 small window, reply start: rebuilt (summary by the small model) and the small model replies',
    rebuild?.summary === 'true' && rebuild.text.startsWith('Rebuilt the conversation for ps/small-coder')
    && summary?.model === 'small-coder' && Boolean(request) && turn.reply.includes(PLAIN_REPLY)
    && turn.errors === 0 && turn.unavailable === 0, `${JSON.stringify(rebuild)}; ${brief(summary)}; ${brief(request)}`);
}

/** @brief 窗口小的模型：段内换不过去（no_handover），没有别的候选时一张说明卡。 */
async function smallReplyCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await choosePick(page, 'g4');
  await buildHistory(page, 's5', 3, 10000);
  const turn = await turnWith(ctx, ep, 'plain s5 http-404-once');
  const card = paneOf(page).getByTestId('unavailable-card').last();
  const lines = await card.locator('[data-testid="candidate"]').evaluateAll((items) => items.map((item) =>
    `${item.dataset.reason}:${item.textContent}`)).catch(() => []);
  record('MP-21 small window, in reply: the small model is excluded (no compaction during the reply)',
    turn.sent.every((body) => !body.summary) && turn.sent.every((body) => body.probe || body.model !== 'small-coder')
    && lines.includes('no_handover:ps2/small-coder — conversation too long for this model'),
    `${lines.join(' | ')}; ${turn.sent.map(brief).join(' ; ')}`);
  record('MP-21 small window, in reply: one No model available card, no error card',
    turn.unavailable === 1 && turn.errors === 0, `unavailable ${turn.unavailable}, errors ${turn.errors}`);
}

/** @brief 重建的压缩失败：换到下一个候选，对话流没有错误卡。 */
async function rebuildFailureCase(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  await buildHistory(page, 's6', 3, 6000);
  await choosePick(page, 'g5');
  ep.failSummary = 400;
  let turn;
  try {
    turn = await turnWith(ctx, ep, 'plain s6 after failed rebuild');
  } finally {
    ep.failSummary = null;
  }
  const failed = turn.sent.find((body) => body.summary && body.failed);
  const answer = turn.sent.find((body) => !body.probe && !body.summary && body.lastUser.startsWith('plain s6 after'));
  record('MP-21 rebuild compaction fails: the -replay candidate is skipped and the next candidate answers',
    failed?.model === 'fake-coder-replay' && answer?.model === 'alt-coder'
    && turn.sent.every((body) => body.summary || body.model !== 'fake-coder-replay')
    && turn.reply.includes(PLAIN_REPLY), `${brief(failed)}; ${brief(answer)}`);
  record('MP-21 rebuild compaction fails: no error card, no v0 compaction notice, no No model available card',
    turn.errors === 0 && turn.compacted === 0 && turn.unavailable === 0,
    `errors ${turn.errors}, compaction notices +${turn.compacted}, unavailable ${turn.unavailable}`);
}

/** @brief 场景 handover（MP-21；重建的阶段行记为 MP-34）。 */
async function handoverScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT, { FAKE_FIRST_DELAY_MS: '300' });
  // synthetic test setup：压缩只保留最近约 300 token，较长的对话才有东西可压缩。
  seedPiSettings(ctx, { compaction: { reserveTokens: 1000, keepRecentTokens: 300 } });
  const replay = model('fake-coder-replay', { reasoning: true });
  const small = model('small-coder', { ctx: 6000, max: 1000 });
  seedConfig(ctx, { providers: [
    provider('pa', 'A', ep.url, [model('fake-coder')]), provider('pb', 'B', ep.url, [replay]),
    provider('pa3', 'A3', ep.url, [model('fake-coder')]), provider('pa4', 'A4', ep.url, [model('fake-coder')]),
    provider('ps', 'S', ep.url, [small]), provider('ps2', 'S2', ep.url, [small]),
    provider('pb5', 'B5', ep.url, [replay]), provider('pc', 'C', ep.url, [model('alt-coder')]),
  ], groups: [group('g3', ['pa3', 'pb']), group('g4', ['pa4', 'ps2']), group('g5', ['pb5', 'pc'])],
  normalDefault: 'pa' });
  await startApp(ctx);
  const refs = ['pa/fake-coder', 'pb/fake-coder-replay', 'pa3/fake-coder', 'pa4/fake-coder', 'ps/small-coder',
    'ps2/small-coder', 'pb5/fake-coder-replay', 'pc/alt-coder'];
  const profiles = await waitProfiles(ctx.page, refs, verified, 180000);
  record('MP-21 setup: the -replay model is profiled as reasoning.replay required',
    profiles['pb/fake-coder-replay'].reasoning.replay === 'required',
    JSON.stringify(profiles['pb/fake-coder-replay'].reasoning));
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'reply start strip', () => startStripCase(ctx, ep));
  await step(ctx, 'reply start rebuild', () => startRebuildCase(ctx, ep));
  await step(ctx, 'in-reply strip', () => inReplyStripCase(ctx, ep));
  await step(ctx, 'small window at start', () => smallStartCase(ctx, ep));
  await step(ctx, 'small window in reply', () => smallReplyCase(ctx, ep));
  await step(ctx, 'rebuild failure', () => rebuildFailureCase(ctx, ep));
}

// ---------- 场景：压缩走 Mori（MP-22） ----------

/** 压缩提供商的 key（synthetic）：合成端点日志只记末 4 位 c22k */
const COMPACT_KEY = 'synthetic-v1-session-compaction-key-c22k';

/** @brief 压缩请求都用 cmp-coder 和它的 key。 */
const viaPool = (bodies) => bodies.length > 0 && bodies.every((body) => body.model === 'cmp-coder'
  && body.auth === `Bearer ${COMPACT_KEY}`);

/** @brief overflow-once：溢出恢复的压缩经模型池，用当前模型和 key，之后重试成功。 */
async function overflowStep(ctx, ep, ep2) {
  const { page } = ctx;
  for (let index = 0; index < 3; index += 1) await sendTurn(page, `plain c${index} ${filler(2000)}`);
  const turn = await turnWith(ctx, ep, 'plain overflow-once please');
  const summaries = turn.sent.filter((body) => body.summary);
  const overflow = turn.lines.find((line) => line.status === 400 && !line.probe);
  const keys = [...new Set(turn.lines.filter((line) => !line.probe).map((line) => `${line.model}/${line.key}`))];
  record('MP-22 overflow-once: the recovery compaction goes through the pool with the current model and its key',
    Boolean(overflow) && viaPool(summaries) && same(keys, ['cmp-coder/c22k']),
    `400=${Boolean(overflow)}; summaries ${summaries.map(brief).join(' ; ')}; log ${keys.join(',')}`);
  record('MP-22 overflow-once: compaction then retry on the same model; the reply arrives, no model switch',
    turn.reply.includes(PLAIN_REPLY) && turn.compacted === 1 && same(turn.lines.map((line) => line.status), [400, 200, 200])
    && turn.notices.every((item) => item.kind !== 'model-switch') && talk(ep2).length === 0,
    `compaction notices +${turn.compacted}, other provider ${talk(ep2).length}, reply "${oneLine(turn.reply, 60)}", `
    + `log ${turn.lines.map((line) => line.status).join(',')}`);
  // §5.4：上下文超长不是让回复以错误结束的分类，由 pi 的溢出恢复处理；§9.3 的错误卡只给 server 重试用完、request、partial。
  record('MP-22 overflow-once: the recovered overflow error is not shown as an error card',
    turn.errors === 0, JSON.stringify(await paneOf(page).getByTestId('error-card').allInnerTexts()));
}

/** @brief 一直发长消息，直到出现一次压缩请求（最多 limit 条）；返回这段的对照。 */
async function untilCompaction(ctx, ep, label, limit = 6) {
  const { page } = ctx;
  const mark = { bodies: ep.bodies.length, log: ep.log.length };
  const errorsBefore = await errorCount(page);
  for (let index = 0; index < limit; index += 1) {
    await sendTurn(page, `plain ${label}${index} ${filler(16000)}`);
    const found = await until(() => ep.bodies.slice(mark.bodies).some((body) => body.summary), 4000, 200);
    if (found) break;
  }
  await waitIdle(page, 60000);
  await sleep(1000);
  return { sent: ep.bodies.slice(mark.bodies), lines: ep.log.slice(mark.log),
    errors: (await errorCount(page)) - errorsBefore, notices: await notices(page) };
}

/** @brief 到阈值的自动压缩经模型池，用当前模型和 key。 */
async function thresholdStep(ctx, ep, ep2) {
  const before = (await notices(ctx.page)).filter((item) => item.text === COMPACTED_NOTICE).length;
  const phase = await untilCompaction(ctx, ep, 't');
  const summaries = phase.sent.filter((body) => body.summary);
  const after = phase.notices.filter((item) => item.text === COMPACTED_NOTICE).length;
  record('MP-22 threshold compaction goes through the pool with the current model and its key',
    viaPool(summaries) && phase.lines.every((line) => line.status !== 400) && after > before
    && phase.lines.filter((line) => !line.probe).every((line) => line.model === 'cmp-coder' && line.key === 'c22k'),
    `summaries ${summaries.map((body) => `${body.model}/${body.auth?.slice(-4)}`).join(',')}; notices ${before}→${after}`);
  record('MP-22 threshold compaction: the other candidate gets nothing', talk(ep2).length === 0, '');
}

/** @brief 压缩出错：由 pi 报告压缩失败，不换模型。 */
async function compactionErrorStep(ctx, ep, ep2) {
  ep.failSummary = 400;
  let phase;
  try {
    phase = await untilCompaction(ctx, ep, 'e');
  } finally {
    ep.failSummary = null;
  }
  const failed = phase.sent.filter((body) => body.summary && body.failed);
  record('MP-22 compaction error: pi reports the failed compaction (error card); no model switch',
    failed.length > 0 && viaPool(failed) && phase.errors >= 1
    && phase.notices.every((item) => item.kind !== 'model-switch') && talk(ep2).length === 0,
    `failed summaries ${failed.length}, new error cards ${phase.errors}, other provider ${talk(ep2).length}`);
}

/** @brief 场景 compaction（MP-22）。 */
async function compactionScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  const ep2 = await startEndpoint(ctx, PORT + 1);
  // synthetic test setup：窗口 32000、保留 16000 → 约 16000 token 时自动压缩；只保留最近约 300 token。
  seedPiSettings(ctx, { compaction: { reserveTokens: 16000, keepRecentTokens: 300 } });
  seedConfig(ctx, { providers: [
    provider('cp', 'Compact P', ep.url, [model('cmp-coder', { ctx: 32000, max: 4000 })]),
    provider('cp2', 'Compact Two', ep2.url, [model('cmp-two')]),
  ], groups: [group('gc', ['cp', 'cp2'])], normalDefault: 'gc' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['cp/cmp-coder', 'cp2/cmp-two']);
  // synthetic test setup：经进程桥给 cp 加一个 key（只是测试值），之后的请求都带它。
  const added = await bridge(ctx.page, { type: 'models.addKey', providerId: 'cp', label: 'Key 1', secret: COMPACT_KEY });
  if (added?.error) throw new Error(`models.addKey failed: ${added.error}`);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'overflow-once', () => overflowStep(ctx, ep, ep2));
  await step(ctx, 'threshold', () => thresholdStep(ctx, ep, ep2));
  await step(ctx, 'compaction error', () => compactionErrorStep(ctx, ep, ep2));
}

// ---------- 场景：顶栏的选择范围（MP-23） ----------

/** @brief 点开范围菜单，读出各节、各项、说明与 Manage models…，再 Esc 关上。 */
async function readMenu(page) {
  await paneOf(page).getByTestId('model-button').click();
  const menu = page.getByTestId('model-menu');
  await menu.waitFor({ timeout: 5000 });
  const state = await menu.evaluate((element) => ({
    sections: [...element.querySelectorAll('[data-section]')].map((item) => item.dataset.section),
    items: [...element.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ pick: item.dataset.pick,
      label: item.querySelector('.switch-text')?.textContent, zone: item.querySelector('.pick-zone')?.textContent,
      checked: item.getAttribute('aria-checked') === 'true', excluded: item.dataset.excluded === 'true',
      title: item.title, section: item.closest('[data-section]')?.dataset.section })),
    providerNames: [...element.querySelectorAll('.model-group-name')].map((item) => item.textContent),
    note: element.querySelector('[data-testid="model-menu-note"]')?.textContent ?? null,
    manage: element.querySelector('[data-action="manage-models"]')?.textContent ?? null,
  }));
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  return state;
}

/** @brief 新会话的按钮文字、悬停与菜单。 */
async function menuStep(ctx) {
  const { page } = ctx;
  const bar = await topbar(page);
  record('MP-23 label: a group range shows "<group id> · <current model id>" with hover "<provider name> · <zone>"',
    bar.text === 'g1 · m1' && bar.pick === 'g1' && bar.current === 'p1/m1' && bar.title === 'Provider One · Local',
    JSON.stringify(bar));
  const menu = await readMenu(page);
  const picks = (section) => menu.items.filter((item) => item.section === section).map((item) => item.label);
  record('MP-23 menu: sections Groups / Providers / Models (models under provider names)',
    same(menu.sections.filter((item) => ['groups', 'providers', 'models'].includes(item)),
      ['groups', 'providers', 'models'])
    && same(picks('groups'), ['g1', 'gpub'])
    && same(picks('providers'), ['Provider One', 'Provider Two', 'Provider Three', 'Public Provider'])
    && same(picks('models'), ['m1', 'm1b', 'm2a', 'm3', 'pm'])
    && same(menu.providerNames, ['Provider One', 'Provider Two', 'Provider Three', 'Public Provider']),
    JSON.stringify({ sections: menu.sections, names: menu.providerNames, items: menu.items.map((item) => item.pick) }));
  const byPick = Object.fromEntries(menu.items.map((item) => [item.pick, item]));
  const faded = ['gpub', 'pp', 'pp/pm'].every((pick) => byPick[pick]?.excluded
    && byPick[pick].title.includes('pp/pm — zone public is not allowed for this project'));
  record('MP-23 menu: items whose candidates are all excluded are faded with the reason on hover, still selectable',
    faded && !byPick.g1?.excluded && !byPick.p2?.excluded, JSON.stringify(['gpub', 'pp', 'pp/pm', 'g1'].map((pick) =>
      [pick, byPick[pick]?.excluded, byPick[pick]?.title])));
  record('MP-23 menu: zones marked, the current range ticked, bottom note and "Manage models…"',
    byPick.g1?.checked && byPick.g1.zone === 'Local' && byPick.pp?.zone === 'Public'
    && menu.note === 'Applies to this session. New sessions use the default range from Settings.'
    && menu.manage === 'Manage models…', JSON.stringify({ g1: byPick.g1, note: menu.note, manage: menu.manage }));
}

/** @brief 选提供商：写进会话文件、不改默认范围；按钮格式；选模型；生成中不能改。 */
async function pickStep(ctx, ep) {
  const { page } = ctx;
  await choosePick(page, 'p2');
  const bar = await topbar(page);
  record('MP-23 label: a provider range shows "<provider name> · <model id>"', bar.text === 'Provider Two · m2a',
    bar.text);
  await sendTurn(page, 'plain range one');
  ctx.s1 = await activeFile(page);
  const picks = customs(ctx.s1, 'mori.pick').map((item) => item.pick);
  record('MP-23 choosing a provider writes mori.pick into the session file (jsonl) and the next reply uses it',
    picks.at(-1) === 'p2' && talk(ep).at(-1)?.model === 'm2a', `picks ${picks.join(',')}; ${brief(talk(ep).at(-1))}`);
  record('MP-23 choosing in the top bar does not change the default range in model-config.json',
    readConfig(ctx).normalDefault === 'g1', String(readConfig(ctx).normalDefault));
  ctx.s2 = await ctrlN(page);
  await sendTurn(page, 'plain range two');
  ctx.s2 = await activeFile(page);
  ctx.s3 = await ctrlN(page);
  await choosePick(page, 'p3/m3');
  const modelBar = await topbar(page);
  record('MP-23 label: a model range shows just the model id', modelBar.text === 'm3', modelBar.text);
  await send(page, 'wait 3s');
  await until(() => page.evaluate((selector) => document.querySelector(selector)?.dataset.running === 'true', PANE),
    10000, 100);
  const busy = await topbar(page);
  record('MP-23 generating: the range and thinking buttons are disabled; hover "Can\'t change the model while generating"',
    busy.disabled && busy.title === BUSY_TITLE && busy.thinking?.disabled === true, JSON.stringify(busy));
  await waitIdle(page, 30000);
  ctx.s3 = await activeFile(page);
}

/** @brief 改设置里的默认范围：已有会话不变，新会话用新的。 */
async function defaultStep(ctx) {
  const { page } = ctx;
  await openModels(page);
  await page.getByTestId('default-pick').selectOption('p3');
  await until(() => readConfig(ctx).normalDefault === 'p3', 10000, 200);
  await backToChat(page);
  const s3 = await topbar(page);
  await openRowFile(page, ctx.s1);
  const s1 = await topbar(page);
  await openRowFile(page, ctx.s2);
  const s2 = await topbar(page);
  record('MP-23 changing the default range leaves existing sessions alone (including one that never switched)',
    s1.pick === 'p2' && s2.pick === 'g1' && s3.pick === 'p3/m3', `s1=${s1.pick} s2=${s2.pick} s3=${s3.pick}`);
  await ctrlN(page);
  const s4 = await topbar(page);
  record('MP-23 a new session uses the new default range', s4.pick === 'p3' && s4.text === 'Provider Three · m3',
    JSON.stringify(s4));
}

/** @brief v0 的旧会话：打开后以最后一条助手消息的模型为范围，并记下 mori.pick。 */
async function v0Step(ctx) {
  const { page } = ctx;
  await openRowFile(page, ctx.v0File);
  const bar = await topbar(page);
  const picks = await until(() => {
    const list = customs(ctx.v0File, 'mori.pick');
    return list.length > 0 ? list : null;
  }, 5000, 200);
  record('MP-23 a v0 session (no mori.pick) opens with its last assistant model as the range and records it',
    bar.pick === 'p1/m1b' && bar.text === 'm1b' && picks?.at(-1)?.pick === 'p1/m1b',
    `${JSON.stringify(bar)}; file picks ${JSON.stringify(picks)}`);
}

/** @brief 重新启动后打开会话：范围沿用会话文件里的。 */
async function reopenStep(ctx) {
  await stopApp(ctx);
  await startApp(ctx);
  await openRowFile(ctx.page, ctx.s1);
  const s1 = await topbar(ctx.page);
  await openRowFile(ctx.page, ctx.s2);
  const s2 = await topbar(ctx.page);
  record('MP-23 after a restart, reopened sessions keep their ranges (p2 and g1)',
    s1.pick === 'p2' && s1.text === 'Provider Two · m2a' && s2.pick === 'g1', `s1=${s1.text} s2=${s2.text}`);
}

/** @brief 场景 range（MP-23）。 */
async function rangeScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  const project = makeProject(ctx, 'proj');
  // synthetic test setup：三个本机提供商、一个公网提供商（这个项目没有授权公网），默认范围 g1。
  seedConfig(ctx, { providers: [
    provider('p1', 'Provider One', ep.url, [model('m1'), model('m1b')]),
    provider('p2', 'Provider Two', ep.url, [model('m2a')]),
    provider('p3', 'Provider Three', ep.url, [model('m3')]),
    provider('pp', 'Public Provider', ep.url, [model('pm')], { zone: 'public' }),
  ], groups: [group('g1', ['p1', 'p3/m3']), group('gpub', ['pp'])], normalDefault: 'g1' });
  ctx.v0File = seedV0Session(ctx, resolve(project), 'p1', 'm1b');
  await startApp(ctx);
  await waitProfiles(ctx.page, ['p1/m1', 'p1/m1b', 'p2/m2a', 'p3/m3', 'pp/pm']);
  await openProject(ctx, project);
  await step(ctx, 'menu', () => menuStep(ctx));
  await step(ctx, 'pick', () => pickStep(ctx, ep));
  await step(ctx, 'default', () => defaultStep(ctx));
  await step(ctx, 'v0 session', () => v0Step(ctx));
  await step(ctx, 'reopen', () => reopenStep(ctx));
}

// ---------- 场景：准备中（MP-34，含 MP-23 的准备中不能改范围） ----------

/** 被限流的 key（synthetic）：合成端点对它回 429，FAKE_LIMIT_MS 之后恢复 */
const LIMITED_KEY = 'synthetic-v1-session-limited-key-lim1';

/** @brief 等当前一栏的阶段行变成 kind。 */
const waitStage = (page, kind, timeout = 15000) => until(async () => {
  const stage = await stageNow(page);
  return stage?.kind === kind ? stage : null;
}, timeout, 100);

/** @brief 准备中等模型：消息已显示、阶段行、停止可用、顶栏不可用；再发一条进排队区；停止后两条文字回到输入框。 */
async function stopWhilePreparingStep(ctx, ep) {
  const { page } = ctx;
  await ctrlN(page);
  const mark = { bodies: ep.bodies.length, log: ep.log.length };
  await send(page, 'plain second');
  const stage = await waitStage(page, 'wait-model');
  const users = await paneOf(page).getByTestId('user-message').allInnerTexts();
  const stop = await paneOf(page).locator('.stop-button').isVisible();
  record('MP-34 preparing: the message is shown, the stage line says "Waiting for a model · rate limited until '
    + 'hh:mm:ss", Stop is available', /^Waiting for a model · rate limited until \d\d:\d\d:\d\d$/.test(stage?.text ?? '')
    && same(users, ['plain second']) && stop, `${stage?.text}; users ${JSON.stringify(users)}; stop ${stop}`);
  const bar = await topbar(page);
  record('MP-23 preparing: the range and thinking buttons are disabled with "Can\'t change the model while generating"',
    bar.disabled && bar.title === BUSY_TITLE && bar.thinking?.disabled === true, JSON.stringify(bar));
  await send(page, 'plain third');
  const pending = await paneOf(page).locator('[data-testid="queue"] li[data-pending="true"]').allInnerTexts()
    .catch(() => []);
  record('MP-34 preparing: a message sent while preparing waits in the queue area (pending)',
    pending.some((text) => text.includes('plain third')), JSON.stringify(pending));
  await paneOf(page).locator('.stop-button').click();
  await until(async () => (await userCount(page)) === 0, 10000, 100);
  const draft = await composer(page).inputValue();
  record('MP-34 Stop while preparing: both texts go back into the composer in order; the message is withdrawn',
    draft === 'plain second\n\nplain third' && (await userCount(page)) === 0, JSON.stringify(draft));
  const stopped = (await notices(page)).filter((item) => item.text === STOPPED_NOTICE).length;
  const queue = await paneOf(page).getByTestId('queue').count();
  record('MP-34 Stop while preparing: no error card, no "已停止", queue cleared, nothing reached the endpoint',
    (await errorCount(page)) === 0 && stopped === 0 && queue === 0 && ep.log.length === mark.log
    && talk(ep).length === talk({ bodies: ep.bodies.slice(0, mark.bodies) }).length,
    `errors ${await errorCount(page)}, stopped ${stopped}, queue ${queue}, new log lines ${ep.log.length - mark.log}`);
  await composer(page).fill('');
}

/** @brief 准备中再发的消息在 pi 开始后作为排队消息交给 pi。 */
async function followUpStep(ctx, ep) {
  const { page } = ctx;
  const mark = ep.bodies.length;
  await send(page, 'plain fourth');
  await waitStage(page, 'wait-model');
  await send(page, 'plain fifth');
  await paneOf(page).locator('[data-testid="queue"] li[data-pending="true"]').waitFor({ timeout: 5000 });
  await until(async () => (await paneOf(page).getByTestId('assistant').count()) >= 2, 90000, 500);
  await waitIdle(page, 90000);
  const sent = talk({ bodies: ep.bodies.slice(mark) });
  const fourth = sent.findIndex((body) => body.lastUser === 'plain fourth');
  const fifth = sent.find((body) => body.lastUser === 'plain fifth');
  const messages = fifth?.messages ?? [];
  const at = messages.findIndex((message) => message.role === 'user' && contentText(message.content) === 'plain fourth');
  record('MP-34 the message sent while preparing becomes a followUp: sent after the first reply, in the same context',
    fourth >= 0 && sent.indexOf(fifth) > fourth && at >= 0
    && messages.slice(at + 1, -1).some((message) => message.role === 'assistant'),
    sent.map(brief).join(' ; '));
  const users = await paneOf(page).getByTestId('user-message').allInnerTexts();
  record('MP-34 followUp: both messages and both replies are shown, no error card',
    same(users.slice(-2), ['plain fourth', 'plain fifth']) && (await errorCount(page)) === 0, JSON.stringify(users));
}

/** @brief 场景 preparing（MP-34）。 */
async function preparingScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT, { FAKE_LIMITED_KEYS: LIMITED_KEY, FAKE_LIMIT_MS: '35000' });
  seedConfig(ctx, { providers: [provider('rp', 'Rate Provider', ep.url, [model('rl-coder')])], normalDefault: 'rp' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['rp/rl-coder']);
  // synthetic test setup：探针跑完后才加 key，之后的对话请求都被限流（35 秒后恢复）。
  const added = await bridge(ctx.page, { type: 'models.addKey', providerId: 'rp', label: 'Key 1', secret: LIMITED_KEY });
  if (added?.error) throw new Error(`models.addKey failed: ${added.error}`);
  await openProject(ctx, makeProject(ctx, 'proj'));
  // 第一条消息让 key 进入限流：它是唯一的候选、本段已失败过（tried），不等待，直接一张说明卡（§5.8）。
  // 之后的新一段从头选，rl-coder 限流到 35 秒后恢复，这期间就是"准备中等模型"。
  await send(ctx.page, 'plain first');
  const limited = await until(async () => (await paneOf(ctx.page).getByTestId('unavailable-card').count()) > 0
    && ep.log.some((line) => line.status === 429), 20000, 200);
  if (!limited) {
    const lines = ep.log.map((line) => `${line.model}/${line.key}:${line.status}`).join(',');
    throw new Error(`the first message did not wait for the rate limit; stage ${JSON.stringify(await stageNow(ctx.page))}`
      + `; log ${lines}; notices ${JSON.stringify(await notices(ctx.page))}; errors ${await errorCount(ctx.page)}`);
  }
  await step(ctx, 'stop while preparing', () => stopWhilePreparingStep(ctx, ep));
  await step(ctx, 'followUp', () => followUpStep(ctx, ep));
}

// ---------- 场景：思考强度（MP-35） ----------

/** @brief 新会话按第一个候选的按模型默认强度开始，请求带思考参数；改成 high 后重新打开仍是 high。 */
async function thinkingLevelStep(ctx, ep) {
  const { page } = ctx;
  const bar = await topbar(page);
  await sendTurn(page, 'thinking check');
  const first = talk(ep).at(-1);
  const reply = await lastReply(page);
  record('MP-35 a new session starts at the first candidate\'s per-model default (low); the request carries it',
    bar.thinking?.level === 'low' && bar.thinking.reasoning === 'true' && first?.effort === 'low'
    && reply.includes('收到思考参数：low'), `${JSON.stringify(bar.thinking)}; effort ${first?.effort}`);
  await chooseThinking(page, 'high');
  await sendTurn(page, 'thinking check again');
  record('MP-35 after choosing high the next request carries high', talk(ep).at(-1)?.effort === 'high',
    String(talk(ep).at(-1)?.effort));
  const file = await activeFile(page);
  await stopApp(ctx);
  await startApp(ctx);
  await openRowFile(ctx.page, file);
  const reopened = await topbar(ctx.page);
  record('MP-35 close and reopen: the session is still at high', reopened.thinking?.level === 'high',
    JSON.stringify(reopened.thinking));
}

/** @brief 段内从不支持思考的模型换到推理模型：思考菜单的强度变为可选（按钮仍因生成中不可用）。 */
async function inReplyThinkingStep(ctx) {
  const { page } = ctx;
  await ctrlN(page);
  await choosePick(page, 'gswitch');
  const before = await topbar(page);
  await watch(page, 'thinking');
  await sendTurn(page, 'http-404-once wait 3s');
  const states = await seen(page);
  const change = (await notices(page)).find((item) => item.kind === 'model-switch');
  const id = await sessionIdOf(page);
  const levels = (await events(page, 'mori.model_state')).filter((item) => item.sessionId === id
    && item.event.current === 'tp/think-coder').map((item) => item.event);
  record('MP-35 in reply, switching from a non-reasoning to a reasoning model makes the thinking levels selectable',
    before.thinking?.reasoning === 'false' && states.includes('true|true') && change?.to === 'tp/think-coder'
    && levels.some((state) => state.reasoning && state.thinkingLevels.length > 1),
    `before ${before.thinking?.reasoning}; button states ${states.join(' > ')}; switch ${change?.text}; `
    + `states ${JSON.stringify(levels.map((state) => state.thinkingLevels))}`);
}

/** @brief 场景 thinking（MP-35）。 */
async function thinkingScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT);
  // synthetic test setup：推理模型的新会话默认强度 low（pi 设置的 modelThinkingLevels）。
  seedPiSettings(ctx, { modelThinkingLevels: { 'tp/think-coder': 'low' } });
  seedConfig(ctx, { providers: [
    provider('tp', 'Think Provider', ep.url, [model('think-coder', { reasoning: true })]),
    provider('np', 'Plain Provider', ep.url, [model('plain-coder')]),
  ], groups: [group('gswitch', ['np', 'tp'])], normalDefault: 'tp' });
  await startApp(ctx);
  await waitProfiles(ctx.page, ['tp/think-coder', 'np/plain-coder']);
  await openProject(ctx, makeProject(ctx, 'proj'));
  await step(ctx, 'level', () => thinkingLevelStep(ctx, ep));
  await step(ctx, 'in-reply switch', () => inReplyThinkingStep(ctx));
}

// ---------- 运行 ----------

const SCENARIOS = {
  blocked: [blockedScenario, 'MP-09'], configInvalid: [configInvalidScenario, 'MP-09'],
  probes: [probesScenario, 'MP-10'], consent: [consentScenario, 'MP-11'], fingerprint: [fingerprintScenario, 'MP-12'],
  handover: [handoverScenario, 'MP-21'], compaction: [compactionScenario, 'MP-22'], range: [rangeScenario, 'MP-23'],
  preparing: [preparingScenario, 'MP-34'], thinking: [thinkingScenario, 'MP-35'],
};

for (const [name, [scenario, mp]] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(name)) continue;
  const ctx = { name, mp, eps: [], pageErrors: [], app: null, page: null,
    userData: mkdtempSync(join(tmpdir(), `mori-v1s-${name}-data-`)), root: mkdtempSync(join(tmpdir(), `mori-v1s-${name}-`)) };
  console.log(`[v1-models-app-session] ${name}: data in ${ctx.userData}, projects in ${ctx.root}`);
  try {
    await scenario(ctx);
  } catch (error) {
    record(`${mp} ${name}: flow`, false, oneLine(error?.stack ?? error, 600));
    await shot(ctx.page, `${name}-error`);
  } finally {
    record(`${mp} ${name}: the page reported no errors`, ctx.pageErrors.length === 0,
      ctx.pageErrors.slice(0, 3).join(' | '));
    await stopApp(ctx);
    for (const ep of ctx.eps) await ep.stop().catch(() => {});
  }
}
await sleep(200);
process.exitCode = write(`v1-models-app-session${suffix}.json`) ? 0 : 1;
