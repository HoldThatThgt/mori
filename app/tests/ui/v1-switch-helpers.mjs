// v1-models-app-switch.mjs 用的准备与页面操作（docs/specs/model-providers.md §14.1、§14.2）：
// - 合成端点（tests/fake-endpoint/server.mjs，synthetic）：每个端口一个进程，收集每个对话请求的 JSON 日志行；
// - 记录代理（synthetic test setup）：转发到合成端点，记下每个请求的认证头与请求体（合成端点的日志只有角色序列和
//   key 末 4 位），并能按模型让某一次请求连接被拒（制造真实的连接失败）、晚一点转发、或在转发前做一件事；
// - 写 model-config.json 与 model-profiles.json（synthetic test setup：跳过探针，直接给出已验证的档案）；
// - 界面里收集后台进程的事件（window.mori.onEvent），读某个会话面板（可以是隐藏的）的提示、卡片、阶段行。
// 只读页面和磁盘，不记录检查结果（检查结果由调用方记录）。界面标识见 docs/v1/screens/model-chat.md。

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { checkPlan } from '../fake-endpoint/finish.mjs';
import { appRoot, sleep } from './lib.mjs';

/** 合成端点 /version 返回的服务版本（server.mjs 的默认值）；档案键里用它，启动时的版本检查才不会重新探测 */
export const FAKE_VERSION = '0.10.1';
/** 合成端点的地址 */
export const baseOf = (port) => `http://127.0.0.1:${port}/v1`;
/** 焦点所在的一栏 */
export const FOCUSED = '.pane-slot[data-focused="true"]:not([hidden])';
/** 某个会话面板（按界面里的标识，隐藏的也算） */
export const paneSel = (tab) => `[data-testid="chat-pane"][data-tab="${tab}"]`;
/** 停止后对话流里的提示（v0，仍是中文） */
export const STOPPED_TEXT = 'Stopped · Changes made so far stay as they are';

// ---------- 合成端点与记录代理 ----------

/**
 * @brief 启动一个合成端点进程，等它打出 synthetic 启动行；每个对话请求的 JSON 日志行（带收到的时刻 t）放进 sink。
 *        列表请求与详情请求的 JSON 行（带 path，model-discovery.md §13.1、server.mjs 开头"日志"）不是对话请求，不放进去。
 * @param port 端口
 * @param env 额外的环境变量（FAKE_KEYS、FAKE_LIMITED_KEYS 等）
 * @param sink 日志行数组
 */
export function startEndpoint(port, env, sink) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '10', FAKE_FIRST_DELAY_MS: '50', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let rest = '';
  child.stdout.on('data', (chunk) => {
    rest += String(chunk);
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      try {
        const entry = JSON.parse(line);
        if (!('path' in entry)) sink.push({ t: Date.now(), ...entry });
      } catch {
        // 不是日志行
      }
    }
  });
  child.stderr.on('data', () => {});
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`fake endpoint ${port} did not start within 15 s`)), 15000);
    const onData = (chunk) => {
      if (!String(chunk).includes('synthetic')) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      done(child);
    };
    child.stdout.on('data', onData);
  });
}

/** @brief 结束一个合成端点进程，等它退出（最多 5 秒）。 */
export async function stopEndpoint(child) {
  if (child.exitCode !== null) return;
  const gone = new Promise((done) => child.once('exit', done));
  child.kill();
  await Promise.race([gone, sleep(5000)]);
}

/** @brief 读完请求体。 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** @brief 把请求转发到上游端口，原样交还响应；对方断开时也断开上游。 */
function forward(req, res, raw, upstream) {
  const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url,
    headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  res.on('close', () => up.destroy());
  up.on('error', () => res.destroy());
  up.end(raw);
}

/**
 * @brief 启动一个记录代理（synthetic test setup）：转发到 upstream 端口的合成端点，记下每个请求
 *        { t, port, method, url, chat, model, index（这个模型的第几个对话请求，从 1 起；不数收尾检查那次请求，
 *        它的 index 为 0）, check（是不是收尾检查那次请求，同合成端点 finish.mjs checkPlan 的认法，
 *        finish-check.md §14.4）, auth, apiKey, body, refused }。
 *        proxy.rule({ model, index, body, check }) 可以返回 { refuse, delayMs, before }：before 在转发（或拒绝）前执行，
 *        refuse 为真时直接断开连接（Mori 看到连接失败），delayMs 是转发前等多久。检查请求同样经过 rule（index 为 0）。
 */
export function startProxy(port, upstream) {
  const proxy = { port, captures: [], counts: new Map(), rule: null, server: null };
  proxy.server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      let body = null;
      try {
        body = raw.length ? JSON.parse(String(raw)) : null;
      } catch {
        body = null;
      }
      const chat = req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions');
      const model = body?.model ?? null;
      const check = chat && body !== null && checkPlan(body).check;
      const index = chat && !check ? (proxy.counts.get(model) ?? 0) + 1 : 0;
      if (chat && !check) proxy.counts.set(model, index);
      const rule = chat && proxy.rule ? proxy.rule({ model, index, body, check }) ?? {} : {};
      proxy.captures.push({ t: Date.now(), port, method: req.method, url: req.url, chat, model, index, check,
        auth: req.headers.authorization ?? null, apiKey: req.headers['x-api-key'] ?? null, body,
        refused: Boolean(rule.refuse) });
      if (rule.before) await rule.before();
      if (rule.refuse) {
        req.socket.destroy();
        return;
      }
      if (rule.delayMs) await sleep(rule.delayMs);
      forward(req, res, raw, upstream);
    })().catch(() => res.destroy());
  });
  return new Promise((done) => proxy.server.listen(port, '127.0.0.1', () => done(proxy)));
}

// ---------- 配置与档案（synthetic test setup） ----------

/** @brief 一个模型的配置。 */
export function modelOf(id, { contextWindow = 128000, maxTokens = 16384, reasoning = false } = {}) {
  return { id, family: '', contextWindow, maxTokens, reasoning, input: ['text'] };
}

/** @brief 一个提供商的配置：key 不写在这里（启动后经 models.addKey 加，密文由 Mori 自己加密保存）。 */
export function providerOf(id, name, port, models, { concurrency = 4 } = {}) {
  return { id, name, api: 'openai-completions', baseUrl: baseOf(port), compat: {}, concurrency,
    keys: [], nextKeyNumber: 1, models };
}

/** @brief 探针一步的结果。 */
const step = (outcome) => ({ outcome, detail: null });

/**
 * @brief 已验证的档案（synthetic test setup）：tool_calling 已验证、A 级；键与指纹按 kernel/modelProfiles.ts 的写法算，
 *        这样启动时不重新探测。
 */
export function profileOf(baseUrl, model) {
  const key = [baseUrl, 'openai-completions', model.id, FAKE_VERSION].join('|');
  const fingerprint = JSON.stringify([key, model.contextWindow, model.maxTokens, model.reasoning, model.input, []]);
  const thinking = model.reasoning ? 'pass' : 'not_applicable';
  return {
    key, fingerprint, baseUrl, api: 'openai-completions', modelId: model.id,
    auto: { server: { kind: 'vllm', version: FAKE_VERSION }, reported: null, field: 'none',
      steps: { ready: step('pass'), thinking: step(thinking), call: step('pass'), result: step('pass'),
        replay: step('not_applicable'), a: step('pass'), b: step('pass'), c: step('not_run') } },
    probedAt: Date.now(), suite: 1,
  };
}

/**
 * @brief 写 model-config.json、model-profiles.json 与 pi 的 settings.json（synthetic test setup）。
 * @param piSettings pi 的设置（例如压缩保留的 token 数）
 */
export function seedUserData(userData, config, piSettings) {
  writeFileSync(join(userData, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const profiles = [];
  const seen = new Set();
  for (const provider of config.providers) {
    for (const model of provider.models) {
      const id = `${provider.baseUrl}|${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      profiles.push(profileOf(provider.baseUrl, model));
    }
  }
  writeFileSync(join(userData, 'model-profiles.json'), `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`);
  writeFileSync(join(userData, 'pi', 'settings.json'), `${JSON.stringify(piSettings, null, 2)}\n`);
}

// ---------- 界面里的事件 ----------

/**
 * @brief 在界面里订阅后台进程的事件，记进 window.__mp：模型层事件（mori.*）全文；pi 的 message_start / message_end
 *        （角色、文字开头、stopReason、errorMessage、实际模型）、auto_retry_*、compaction_*、agent_start / agent_settled。
 */
export function captureEvents(page) {
  return page.evaluate(() => {
    if (window.__mp) return;
    window.__mp = [];
    const text = (message) => {
      const content = message?.content;
      if (typeof content === 'string') return content;
      return Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';
    };
    window.mori.onEvent((envelope) => {
      const event = envelope.event;
      const type = event?.type;
      if (!type) return;
      const item = { t: Date.now(), sid: envelope.sessionId, type };
      if (type.startsWith('mori.')) item.data = event;
      else if (type === 'message_start' || type === 'message_end') {
        const message = event.message;
        Object.assign(item, { role: message?.role, text: text(message).slice(0, 400), stopReason: message?.stopReason,
          errorMessage: message?.errorMessage, model: message?.model, provider: message?.provider });
      } else if (/^(auto_retry|compaction)/.test(type)) {
        item.data = { reason: event.reason, errorMessage: event.errorMessage, attempt: event.attempt };
      } else if (type !== 'agent_start' && type !== 'agent_settled') return;
      window.__mp.push(item);
    });
  });
}

/** @brief 记下的事件（从 since 起，可按会话筛）。 */
export function eventsOf(page, sid = null, since = 0) {
  return page.evaluate(({ id, from }) => (window.__mp ?? []).filter((item) => item.t >= from
    && (id === null || item.sid === id)), { id: sid, from: since });
}

// ---------- 会话面板 ----------

/**
 * @brief 在页面里装一个 MutationObserver：每个会话面板（含隐藏的）的阶段行变化时记下 "<data-kind>|<文字>"
 *        （去掉末尾的秒数），放进 window.__stages[tab]，每项 { t, v }。
 */
export function watchStages(page) {
  return page.evaluate(() => {
    if (window.__stages) return;
    window.__stages = {};
    const scan = () => {
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const stage = pane.querySelector('[data-testid="stage"]');
        const value = stage ? `${stage.dataset.kind ?? ''}|${stage.textContent.replace(/( · )?\d+(\.\d+)?s$/, '')}`
          : '';
        const list = window.__stages[pane.dataset.tab] ?? (window.__stages[pane.dataset.tab] = []);
        if ((list.at(-1)?.v ?? '') !== value) list.push({ t: Date.now(), v: value });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  });
}

/** @brief 某个会话面板记下的阶段行（非空的）。 */
export function stagesOf(page, tab, since = 0) {
  return page.evaluate(({ key, from }) => (window.__stages?.[key] ?? []).filter((item) => item.v && item.t >= from),
    { key: tab, from: since });
}

/**
 * @brief 某个会话面板此刻的样子：是否生成中、发送中；换模型与重建提示、"Stopped"、错误卡、说明卡、拒绝启动卡、
 *        用户消息、助手回复、工具卡数、阶段行、输入框里的文字、排队区。
 */
export function paneState(page, tab) {
  return page.evaluate(({ selector, stopped }) => {
    const pane = document.querySelector(selector);
    if (!pane) return null;
    const all = (css) => [...pane.querySelectorAll(css)];
    const textOf = (el) => el.textContent.replace(/\s+/g, ' ').trim();
    return {
      running: pane.dataset.running === 'true', sending: pane.dataset.sending === 'true',
      switches: all('[data-testid="notice"][data-kind="model-switch"]').map((el) => ({ from: el.dataset.from,
        to: el.dataset.to, reason: el.dataset.reason, hidden: el.dataset.hidden === 'true', text: textOf(el) })),
      rebuilds: all('[data-testid="notice"][data-kind="rebuild"]').map(textOf),
      stopped: all('[data-testid="notice"]').filter((el) => el.textContent.includes(stopped)).length,
      errors: all('[data-testid="error-card"]').map(textOf),
      unavailable: all('[data-testid="unavailable-card"]').map((card) => ({ text: textOf(card),
        candidates: [...card.querySelectorAll('[data-testid="candidate"]')].map((el) => ({ ref: el.dataset.ref,
          reason: el.dataset.reason, text: textOf(el) })) })),
      blocked: pane.querySelector('[data-testid="blocked-card"]')?.dataset.kind ?? null,
      users: all('[data-testid="user-message"]').map(textOf),
      assistants: all('[data-testid="assistant"]').map(textOf),
      tools: all('[data-testid="tool-card"]').length,
      stage: pane.querySelector('[data-testid="stage"]')?.textContent ?? null,
      stageKind: pane.querySelector('[data-testid="stage"]')?.dataset.kind ?? null,
      draft: pane.querySelector('.composer textarea')?.value ?? null,
      queue: all('[data-testid="queue"] li, [data-testid="queue"] [data-pending]').map(textOf),
    };
  }, { selector: `[data-testid="chat-pane"][data-tab="${tab}"]`, stopped: STOPPED_TEXT });
}

/** @brief 等某个会话面板空闲（不在生成、不在发送、没有阶段行）。 */
export function waitTabIdle(page, tab, timeout = 120000) {
  return page.waitForFunction((selector) => {
    const pane = document.querySelector(selector);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="stage"]');
  }, `[data-testid="chat-pane"][data-tab="${tab}"]`, { timeout });
}

/** @brief 某个会话面板里用户消息、说明卡、错误卡各有几条（判断刚发的消息有没有被处理）。 */
export function paneCounts(page, tab) {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const count = (css) => pane?.querySelectorAll(css).length ?? 0;
    return { users: count('[data-testid="user-message"]'), cards: count('[data-testid="unavailable-card"]'),
      errors: count('[data-testid="error-card"]') };
  }, `[data-testid="chat-pane"][data-tab="${tab}"]`);
}

/**
 * @brief 等某个会话面板开始发送或生成（最多 timeout，等不到也照常返回）。很快就结束的一次（例如马上撤回、马上出说明卡）
 *        可能看不到发送中，所以 before（发送前的 paneCounts）里任何一项变多也算。
 */
export function waitTabBusy(page, tab, timeout = 10000, before = null) {
  return page.waitForFunction(({ selector, counts }) => {
    const pane = document.querySelector(selector);
    if (pane?.dataset.running === 'true' || pane?.dataset.sending === 'true') return true;
    if (!counts || !pane) return false;
    const count = (css) => pane.querySelectorAll(css).length;
    return count('[data-testid="user-message"]') > counts.users || count('[data-testid="unavailable-card"]')
      > counts.cards || count('[data-testid="error-card"]') > counts.errors;
  }, { selector: `[data-testid="chat-pane"][data-tab="${tab}"]`, counts: before }, { timeout })
    .then(() => true, () => false);
}

/** @brief 等某个会话面板的阶段行出现某种 data-kind（最多 timeout）；出现时为 true。 */
export function waitStageKind(page, tab, kind, timeout = 30000) {
  return page.waitForFunction(({ selector, want }) => document.querySelector(selector)
    ?.querySelector('[data-testid="stage"]')?.dataset.kind === want,
  { selector: `[data-testid="chat-pane"][data-tab="${tab}"]`, want: kind }, { timeout }).then(() => true, () => false);
}

/** @brief 等 fn() 为真，最多 timeoutMs；返回最后一次的结果。 */
export async function poll(fn, timeoutMs = 10000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let value = await fn();
  while (!value && Date.now() < deadline) {
    await sleep(stepMs);
    value = await fn();
  }
  return value;
}
