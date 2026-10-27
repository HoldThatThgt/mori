// 收尾检查（docs/specs/finish-check.md §14.1 的回放与真实两行；§14.2 FC-11、FC-12、FC-13、FC-23、FC-27）的录制
// （fc-record.mjs）、回放（fc-replay.mjs）与真实走查（fc-real.mjs）共用的部分：
// - 页面里的录制器（格式同 mem-record.mjs、tb-record.mjs 与 tests/ui/harness/replay.js：{ t, command }、
//   { t, result: { type, value } }、{ t, envelope }）和 node 这边驱动它的 recDriver；录下的 fixture 的写出（不符合时写到
//   rejected）。
// - 页面里的记录器 watchFinish：对话流里出现过的 finish 工具卡与检查那一行（§10.1：都不该有）。
// - 后台进程的日志行（§7.4 的 "finish check <n> (<reason>)"、"finish check passed (<reason>)"）按会话读出，按下一行
//   给每次检查归成 a（确认）、b（干了活）、c（重写，没干活）。
// - 会话文件（pi 的 .jsonl）按运行分开（§1：一次运行从一条 role 为 user 的消息开始；mori.wake 指向的是 Mori 开始的），
//   检查那一行（custom_message mori.finish_check）之后的回应与用量、finish 调用与结果、被拒绝之后又发的调用。
// - 记录代理记下的请求体里检查那一行所在的消息（§6.2：原文与检查块在同一条 user 消息里）与检查块的问题。
// - 真实走查的数据目录：三个服务（DeepSeek、GLM、OpenRouter 上的 Qwen）与它们的模型；复制出的数据目录里三个提供商的地址
//   改指本机转发代理（synthetic test setup，档案跟着改地址）；key 方式下从负责人的 env 文件读 key（只读文件名
//   与变量名，值只留在进程里，不打印、不写盘），只经界面建数据目录（步骤与 md-real.mjs、v1-models-real.mjs 的 key 方式
//   共用 v1-real-helpers.mjs）。
// 常量 FINISH_TOOL、FINISH_CHECK_TYPE 同 src/shared/finishCheck.ts（测试不 import src/）；CHECK_LINE_HEAD 用合成端点自留的
// 那一份（scripts.mjs，FC-26 比对它与 src/shared/finishCheck.ts 相等）。只读页面和磁盘、发界面操作，不改 Mori 的源码。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_LINE_HEAD, WORK_CARD_OPEN } from '../fake-endpoint/scripts.mjs';
import { editModelConfig, launch, sleep } from './lib.mjs';
import {
  cardOf, installRecorder as installProbeRecorder, modelRowOf, OPENROUTER_BASE, readRows, waitFetched, waitProbed,
} from './md-real-helpers.mjs';
import {
  addedProblems, addProviderUi, chooseGlm, firstRunDeepSeek, firstRunProblems, glmAddProblems, KEY_MODE_URLS,
  openModelsSettings, PROBE_MS, providerBrief, readJson, tickModels, writeJson,
} from './v1-real-helpers.mjs';

export { CHECK_LINE_HEAD };

/** 确认最终回复的工具名（同 src/shared/finishCheck.ts 的 FINISH_TOOL） */
export const FINISH_TOOL = 'finish';
/** 检查那一行的条目种类（同 src/shared/finishCheck.ts 的 FINISH_CHECK_TYPE） */
export const FINISH_CHECK_TYPE = 'mori.finish_check';
/** 程序投递到用户会话的消息的标记条目（平行 Agent 规格 §5.6） */
const WAKE_TYPE = 'mori.wake';

// ---------- 页面里的录制器（fc-record.mjs 与 fc-real.mjs 共用） ----------

/**
 * @brief 页面里的录制器（page.evaluate 执行，window.__fcRec；同 mem-record.mjs）：记录它自己经 window.mori.request 发的
 *        命令与结果和后台进程转发的全部事件；turn_end 后读一次 session.state。命令一条接一条发（上一条有了结果才发下一条）：
 *        回放桥把结果配给它之前最近一条同类型命令，两条同类型的查询交错时会配错。on 为假时不记（真实走查里只录一段）。
 * @param offset 时间从多少毫秒起算（重启后接着重启前最后一步的时间）
 */
export function installRecorder(offset) {
  const rec = {
    t0: performance.now() - offset,
    steps: [],
    on: true,
    chain: Promise.resolve(),
    log(entry) {
      if (this.on) this.steps.push({ t: Math.round(performance.now() - this.t0), ...entry });
    },
    begin() {
      this.steps = [];
      this.t0 = performance.now();
      this.on = true;
    },
    end() {
      this.on = false;
      return this.steps;
    },
    cmd(command) {
      const send = async () => {
        this.log({ command });
        try {
          const result = await window.mori.request(command);
          this.log({ result: { type: command.type, value: result } });
          return result;
        } catch (error) {
          this.log({ result: { type: command.type, error: error.message } });
          throw error;
        }
      };
      const sent = this.chain.then(send, send);
      this.chain = sent.catch(() => {});
      return sent;
    },
  };
  window.mori.onEvent((envelope) => {
    rec.log({ envelope });
    if (rec.on && envelope.event.type === 'turn_end') {
      void rec.cmd({ type: 'session.state', sessionId: envelope.sessionId }).catch(() => {});
    }
  });
  window.__fcRec = rec;
}

/**
 * @brief node 这边驱动页面里的录制器（同 mem-record.mjs 的 driver）。
 * @param state { page }（重启后换成新的页面）
 * @param waitMs 等一件事的默认时限
 */
export function recDriver(state, waitMs) {
  const page = () => state.page;
  const d = {
    cmd: (command) => page().evaluate((c) => window.__fcRec.cmd(c), command),
    steps: () => page().evaluate(() => window.__fcRec.steps),
    count: (sessionId, type) => page().evaluate(({ id, kind }) => window.__fcRec.steps
      .filter((s) => s.envelope?.sessionId === id && s.envelope.event.type === kind).length,
    { id: sessionId, kind: type }),
    /** 等 fn() 为真 */
    async until(fn, what, timeout = waitMs) {
      const deadline = Date.now() + timeout;
      while (!(await fn())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(250);
      }
    },
    /** 像界面一样新建会话：先 trust.check（临时项目没有要信任的内容），再 session.create */
    async create(cwd) {
      await d.cmd({ type: 'trust.check', cwd });
      return d.cmd({ type: 'session.create', cwd });
    },
    /** 发一条消息，等这一次运行结束（agent_settled：收尾检查在同一次运行里，只有一个） */
    async say(session, text, timeout = waitMs) {
      const before = await d.count(session.sessionId, 'agent_settled');
      await d.cmd({ type: 'session.prompt', sessionId: session.sessionId, text });
      await d.until(async () => (await d.count(session.sessionId, 'agent_settled')) > before,
        `${session.sessionId} to settle`, timeout);
      await sleep(300);
    },
    /** 开头像界面一样读会话列表、设置与模型配置 */
    async start() {
      await d.cmd({ type: 'session.list' });
      await d.cmd({ type: 'config.get' });
      return d.cmd({ type: 'models.get' });
    },
  };
  return d;
}

// ---------- 录下的步骤的核对（在 node 里） ----------

/** @brief 条件不成立时的一条问题。 */
export const need = (ok, problem) => (ok ? [] : [problem]);
/** @brief 某种命令成功的结果，按顺序。 */
export const valuesOf = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
/** @brief 失败的命令。 */
export const failuresOf = (steps) => steps.filter((s) => s.result?.error)
  .map((s) => `${s.result.type}: ${s.result.error}`);
/** @brief 某个会话的某种事件，按顺序。 */
export const sessionEvents = (steps, sessionId, type) => steps.filter((s) => s.envelope?.sessionId === sessionId
  && s.envelope.event.type === type).map((s) => s.envelope.event);

/** @brief 有结果之前就又发了一条命令的位置（录制器应当一条接一条发）。 */
function overlaps(steps) {
  let pending = null;
  const out = [];
  steps.forEach((step, index) => {
    if (step.restart) pending = null;
    if (step.command) {
      if (pending) out.push(`${pending.type} then ${step.command.type} at ${index}`);
      pending = step.command;
    }
    if (step.result && pending?.type === step.result.type) pending = null;
  });
  return out;
}

/** @brief 共同的要求：开头是会话列表；没有失败的命令；命令不交错；恰好一个 session.create。 */
export function commonProblems(steps) {
  const first = steps.find((s) => s.command)?.command;
  return [...need(first?.type === 'session.list', 'the recording does not start with session.list'),
    ...need(failuresOf(steps).length === 0, `failed commands: ${failuresOf(steps).join('; ')}`),
    ...need(overlaps(steps).length === 0, `overlapping commands: ${overlaps(steps).slice(0, 3)}`),
    ...need(valuesOf(steps, 'session.create').length === 1, 'not exactly one session.create')];
}

/**
 * @brief 写出一个 fixture（JSON，一格缩进）；problems 不为空时写到 rejectedDir/<名字>.rejected.json，并设退出码 1。
 * @return 写出的文件路径
 */
export function saveFixture(fixture, problems, { outDir, rejectedDir }) {
  const dir = problems.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${fixture.name}${problems.length ? '.rejected' : ''}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.steps;
  const summary = `${steps.length} steps, ${steps.filter((s) => s.envelope).length} events`;
  if (problems.length) {
    console.log(`FAIL ${fixture.name}: ${problems.join('; ')} — ${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`RECORDED ${fixture.name}: ${summary}`);
  }
  return file;
}

// ---------- 页面里的记录器：finish 与检查那一行从不显示（§10.1） ----------

/**
 * @brief 在页面里装一个 MutationObserver（变化之后 200 毫秒查一次）：记下每个会话面板的对话流里出现过的、标题含 finish 的
 *        工具卡，以及对话流的文字里出现过检查那一行的开头。结果在 window.__fcSeen：{ cards: [{ tab, title }], lines:
 *        [tab], scans }。
 */
export function watchFinish(page) {
  return page.evaluate((head) => {
    if (window.__fcSeen) return;
    const seen = { cards: [], lines: [], scans: 0 };
    let queued = false;
    const scan = () => {
      queued = false;
      seen.scans += 1;
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const tab = pane.dataset.tab ?? '';
        for (const title of pane.querySelectorAll('[data-testid="tool-card"] .tool-title')) {
          const text = title.textContent ?? '';
          const known = seen.cards.some((card) => card.tab === tab && card.title === text);
          if (/\bfinish\b/i.test(text) && !known) seen.cards.push({ tab, title: text });
        }
        const transcript = pane.querySelector('[data-testid="transcript"]');
        if (transcript?.textContent.includes(head) && !seen.lines.includes(tab)) seen.lines.push(tab);
      }
    };
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(scan, 200);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    scan();
    window.__fcSeen = seen;
  }, CHECK_LINE_HEAD);
}

/** @brief watchFinish 记下的内容。 */
export const finishSeen = (page) => page.evaluate(() => window.__fcSeen ?? { cards: [], lines: [], scans: 0 });

// ---------- 后台进程的日志行（§7.4） ----------

/** 加检查的日志行 */
const CHECK_LOG = /\[kernel\] (\S+): finish check (\d+) \(([^)]+)\)/;
/** 检查过之后放行的日志行 */
const PASS_LOG = /\[kernel\] (\S+): finish check passed \(([^)]+)\)/;
/** 检查那次请求出错按已完成算的日志行（§8.3） */
const FAILED_LOG = /\[kernel\] (\S+): the finish check request failed/;

/**
 * @brief 后台进程输出里收尾检查的日志行，按先后：{ sessionId, kind: 'check' | 'pass' | 'failed', n, reason }。
 * @param lines 输出的行（字符串）
 */
export function checkLogEvents(lines) {
  const out = [];
  for (const line of lines) {
    const check = CHECK_LOG.exec(line);
    const pass = PASS_LOG.exec(line);
    const failed = FAILED_LOG.exec(line);
    if (check) out.push({ sessionId: check[1], kind: 'check', n: Number(check[2]), reason: check[3] });
    else if (pass) out.push({ sessionId: pass[1], kind: 'pass', n: null, reason: pass[2] });
    else if (failed) out.push({ sessionId: failed[1], kind: 'failed', n: null, reason: null });
  }
  return out;
}

/** 放行的原因 → 那次检查的结果（§5.3：confirmed 为 a，no work 为 c，limit 是第 3 次检查之后又干了活，算 b） */
const PASS_OUTCOME = { confirmed: 'a', 'no work': 'c', limit: 'b' };

/**
 * @brief 一个会话的每次检查的结果，按下一行日志归类：下一行是 "finish check <n+1> (work)" 为 b，放行按 PASS_OUTCOME，
 *        检查那次请求出错为 failed；没有下一行、或下一行是新一次运行的 "(first)"（检查时停止或出错）为 open。
 * @param events checkLogEvents 里这个会话的项，按先后
 * @return [{ n, reason, outcome }]
 */
export function checkOutcomes(events) {
  return events.flatMap((event, i) => {
    if (event.kind !== 'check') return [];
    const next = events[i + 1];
    let outcome = 'open';
    if (next?.kind === 'check' && next.reason === 'work') outcome = 'b';
    else if (next?.kind === 'pass') outcome = PASS_OUTCOME[next.reason] ?? 'open';
    else if (next?.kind === 'failed') outcome = 'failed';
    return [{ n: event.n, reason: event.reason, outcome }];
  });
}

// ---------- 会话文件 ----------

/** @brief 消息内容的文字（字符串，或内容块里 type 为 text 的块相接）。 */
export const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (part?.type === 'text' ? part.text ?? '' : '')).join('') : '');
/** @brief 助手消息内容里的工具调用块。 */
export const toolCallsOf = (content) => (Array.isArray(content)
  ? content.filter((part) => part?.type === 'toolCall') : []);
/** @brief 是不是检查那一行的条目。 */
export const isCheckEntry = (entry) => entry.type === 'custom_message' && entry.customType === FINISH_CHECK_TYPE;
/** @brief 是不是某种角色的消息条目。 */
const isMessage = (entry, role) => entry.type === 'message' && entry.message?.role === role;

/**
 * @brief 会话文件的条目按运行分开：一次运行从一条 role 为 user 的消息开始（§1），mori.wake 指向的是 Mori 开始的
 *        （程序投递）。运行里只放进上下文的条目（message、custom_message）。
 * @param entries readJsonl 的结果
 * @return [{ id, mori, items }]
 */
export function runsOf(entries) {
  const wakes = new Set(entries.filter((e) => e.type === 'custom' && e.customType === WAKE_TYPE)
    .map((e) => e.data?.messageId));
  const runs = [];
  for (const entry of entries) {
    if (isMessage(entry, 'user')) runs.push({ id: entry.id, mori: wakes.has(entry.id), items: [] });
    else if (runs.length && (entry.type === 'message' || entry.type === 'custom_message')) {
      runs.at(-1).items.push(entry);
    }
  }
  return runs;
}

/**
 * @brief 每行检查之后的第一条助手消息（检查那次请求的回应）与再下一条（下一次请求的回应，可能在你的下一条消息之后）。
 * @return [{ response, next }]（消息对象；没有时为 null）
 */
export function checkResponses(entries) {
  const assistants = entries.flatMap((entry, i) => (isMessage(entry, 'assistant') ? [i] : []));
  return entries.flatMap((entry, i) => {
    if (!isCheckEntry(entry)) return [];
    const at = assistants.find((j) => j > i);
    const next = at === undefined ? undefined : assistants.find((j) => j > at);
    return [{ response: at === undefined ? null : entries[at].message,
      next: next === undefined ? null : entries[next].message }];
  });
}

/**
 * @brief 对检查的回应是哪一种：只调 finish、写话 + finish、只写话（不调工具）、干活（finish 以外的调用）、出错、
 *        中止、空；没有回应为 none。
 */
export function responseKind(message) {
  if (!message) return 'none';
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return message.stopReason;
  const calls = toolCallsOf(message.content);
  const text = textOf(message.content).trim();
  if (calls.some((call) => call.name !== FINISH_TOOL)) return 'work';
  if (calls.length > 0) return text ? 'text + finish' : 'finish only';
  return text ? 'text only' : 'empty';
}

/** @brief 助手消息的用量里走查要记的几项（pi-ai 的 Usage；reasoning 没报时为 null）。 */
export const usageOf = (message) => (message?.usage ? { output: message.usage.output ?? 0,
  reasoning: message.usage.reasoning ?? null, cacheRead: message.usage.cacheRead ?? 0,
  cacheWrite: message.usage.cacheWrite ?? 0 } : null);

/** @brief 会话里的 finish 调用与它的结果：[{ args, result（toolResult 消息，没有时 null） }]。 */
export function finishCalls(entries) {
  const results = new Map(entries.filter((e) => isMessage(e, 'toolResult'))
    .map((e) => [e.message.toolCallId, e.message]));
  return entries.filter((e) => isMessage(e, 'assistant')).flatMap((e) => toolCallsOf(e.message.content))
    .filter((call) => call.name === FINISH_TOOL)
    .map((call) => ({ args: call.arguments ?? {}, result: results.get(call.id) ?? null }));
}

/** 被拒绝的调用的结果原文（批准拒绝 REJECTED_TEXT 等、协作模式的 RELAY_ONLY、对话不能用的工具） */
const REJECTED = /^Rejected\b|only relays|is not one of/;

/**
 * @brief 一次运行里被拒绝的调用（工具名 + 参数），以及第一行检查之后又发出的同样的调用（只记，不断言，FC-27）。
 * @return { rejected, retried }
 */
function runRetries(run) {
  const calls = new Map();
  const rejected = new Set();
  const out = { rejected: 0, retried: 0 };
  let checked = false;
  for (const entry of run.items) {
    if (isCheckEntry(entry)) checked = true;
    if (isMessage(entry, 'assistant')) {
      for (const call of toolCallsOf(entry.message.content)) {
        const key = `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
        calls.set(call.id, key);
        if (checked && rejected.has(key)) out.retried += 1;
      }
    }
    if (isMessage(entry, 'toolResult') && entry.message.isError && REJECTED.test(textOf(entry.message.content))) {
      rejected.add(calls.get(entry.message.toolCallId));
      out.rejected += 1;
    }
  }
  return out;
}

/** @brief 全部运行里被拒绝的调用与检查之后又发出的同样的调用之和。 */
export function retriesOf(runs) {
  return runs.map(runRetries).reduce((sum, item) => ({ rejected: sum.rejected + item.rejected,
    retried: sum.retried + item.retried }), { rejected: 0, retried: 0 });
}

// ---------- 记录代理的请求体（§6.2、§7.2） ----------

/**
 * @brief 请求体里检查那一行所在消息的全文：从末尾往前跳过只有工作卡的 user 消息，第一条是 user 消息、去掉首部空白后以
 *        CHECK_LINE_HEAD 开头时返回它的文字（检查那次请求）；否则为 null。OpenAI 与 Anthropic 两种请求体都是 messages。
 */
export function checkMessageText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = textOf(messages[i].content).trimStart();
    if (messages[i].role === 'user' && text.startsWith(WORK_CARD_OPEN)) continue;
    return messages[i].role === 'user' && text.startsWith(CHECK_LINE_HEAD) ? text : null;
  }
  return null;
}

/**
 * @brief 检查那一行所在消息的问题（§7.1、§7.2）：第三行点名的是 want 里的分节，每个点名的分节在同一条消息里以
 *        `<名字>\n…\n</名字>` 接在 "\n\n" 之后，内容里有测试写进记忆的那条。
 * @param text checkMessageText 的结果
 * @param want 应当点名的分节（'taste'、'review'）；为 null 时只要求至少点名一节（那次运行的席位不确定时）
 * @param seeds 分节 → 测试写进记忆的 abstract
 */
export function blockProblems(text, want, seeds) {
  const [line, ...rest] = text.split('\n\n');
  const block = rest.join('\n\n');
  const named = ['taste', 'review'].filter((kind) => line.includes(`<${kind}>`));
  const problems = want === null ? need(named.length > 0, 'the check line names no section')
    : need(JSON.stringify(named) === JSON.stringify(want), `the check line names ${named}, want ${want}`);
  for (const kind of named) {
    const found = new RegExp(`(^|\\n)<${kind}>\\n([\\s\\S]*?)\\n</${kind}>`).exec(block);
    if (!found) problems.push(`no <${kind}> block after the check line`);
    else if (!found[2].includes(seeds[kind])) problems.push(`<${kind}> does not have the seeded entry`);
  }
  return problems;
}

// ---------- 真实走查的数据目录 ----------

/** @brief 一个提供商是否像 pattern 指的那一家（按 id、名称、地址，同 v1-real-helpers.mjs）。 */
const looksLike = (provider, pattern) => pattern.test(`${provider.id} ${provider.name} ${provider.baseUrl}`);
/** @brief 模型 id 是不是 Qwen（OpenRouter 的 id 以厂商前缀 qwen/ 开头）。 */
export const isQwen = (id) => /^qwen\//i.test(id);

/**
 * @brief 走查的三个服务（§14.2 FC-27）：DeepSeek 与 GLM 各取提供商的第一个模型（同 tb-real-helpers.mjs refOf），
 *        OpenRouter 取第一个 Qwen 模型（没有时 model 为 null，由走查经卡上的 Fetch models 加入）。
 * @return [{ label, key（--only 的名字）, provider（没有时 null）, model }]
 */
export function servicesOf(config) {
  const find = (pattern) => config.providers.find((provider) => looksLike(provider, pattern)) ?? null;
  const deepseek = find(/deepseek/i);
  const glm = find(/glm|bigmodel|zhipu|z\.ai/i);
  const openrouter = find(/openrouter/i);
  return [
    { label: 'DeepSeek', key: 'deepseek', provider: deepseek, model: deepseek?.models[0]?.id ?? null },
    { label: 'GLM', key: 'glm', provider: glm, model: glm?.models[0]?.id ?? null },
    { label: 'Qwen', key: 'qwen', provider: openrouter,
      model: openrouter?.models.find((item) => isQwen(item.id))?.id ?? null },
  ];
}

/** @brief 档案的地址、键与指纹换成代理的地址（同 tb-real-helpers.mjs：档案的内容不变，只是地址变了）。 */
function moveProfiles(file, providers, routes) {
  if (!existsSync(file)) return;
  const data = readJson(file);
  for (const profile of data.profiles ?? []) {
    const provider = providers.find((item) => routes[item.id] === profile.baseUrl);
    if (!provider) continue;
    const from = `${profile.baseUrl}|`;
    const to = `${provider.baseUrl}|`;
    profile.key = profile.key.replace(from, to);
    profile.fingerprint = profile.fingerprint.replace(from, to);
    profile.baseUrl = provider.baseUrl;
  }
  writeJson(file, data);
}

/**
 * @brief 代理地址里的一段：<提供商 id>@<原地址的主机名>。pi 按地址认服务（openai-completions 的 detectCompat：地址含
 *        deepseek.com 时不发 developer 角色与 store、用 max_tokens、思考按 deepseek 的写法；openrouter.ai 同理），
 *        只写提供商 id 时地址里只有 127.0.0.1，pi 认不出，DeepSeek 以 422 拒绝 developer 角色（2026-10-27 走查时发现）。
 * @param id 提供商 id
 * @param baseUrl 提供商的真实地址
 */
export const proxySegment = (id, baseUrl) => `${id}@${new URL(baseUrl).host}`;

/** @brief 转发代理的路由：proxySegment → 真实地址（routes 为 routeThroughProxy 的结果）。 */
export const proxyRoutes = (routes) => Object.fromEntries(Object.entries(routes)
  .map(([id, baseUrl]) => [proxySegment(id, baseUrl), baseUrl]));

/**
 * @brief 测试准备（synthetic test setup，复制出的数据目录，Mori 退出时）：ids 里的提供商的地址改指本机转发代理
 *        http://127.0.0.1:<port>/p/<proxySegment>（tb-real-helpers.mjs startForwardProxy，路由用 proxyRoutes），
 *        档案跟着改地址（2026-10-26 起没有网络区域，不再给项目授权公网）。在走查需要的模型都加好之后做：拉取按主机认服务（model-discovery.md §3.3）。
 * @param userData 复制出的数据目录（v1-real-helpers.mjs scratchModelData）
 * @param ids 要经代理的提供商 id
 * @param proxyPort 转发代理的端口
 * @return routes（提供商 id → 真实地址）
 */
export function routeThroughProxy(userData, ids, proxyPort) {
  const routes = {};
  editModelConfig(userData, (config) => {
    for (const provider of config.providers.filter((item) => ids.includes(item.id))) {
      routes[provider.id] = provider.baseUrl;
      provider.baseUrl = `http://127.0.0.1:${proxyPort}/p/${proxySegment(provider.id, provider.baseUrl)}`;
    }
    moveProfiles(join(userData, 'model-profiles.json'), config.providers, routes);
  });
  return routes;
}

/** @brief 测试准备：默认范围换成一个模型 <provider>/<model>（App 退出时改复制出的配置）。 */
export const useDefault = (userData, ref) => editModelConfig(userData, (config) => {
  config.normalDefault = ref;
});

// ---------- key 方式（负责人的 env 文件） ----------

/** env 文件：服务 → 文件名（负责人的 HoldThatThgt 文件夹里，每个文件里第一个名字含 key 的变量是 key） */
const KEY_FILES = { deepseek: 'deepseek.env', glm: 'glm.env', openrouter: 'openrouter.env' };

/** @brief 读一个 env 文件的变量 name = value（值可带引号，# 开头的行跳过）；值不打印。 */
function envValues(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0 || line.trimStart().startsWith('#')) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * @brief key 方式：从 dir 下的 deepseek.env、glm.env、openrouter.env 读 key（每个文件里第一个名字含 key 的变量；值里有
 *        逗号或空白时取第一段）与 glm.env 的 base_url（没有或不是 http(s) 地址时为 KEY_MODE_URLS.glm）。值只留在返回的
 *        对象里，不打印、不写盘；缺的 key 为 null。
 */
export function readKeyFiles(dir) {
  const keys = { glmUrl: KEY_MODE_URLS.glm };
  for (const [id, name] of Object.entries(KEY_FILES)) {
    const file = join(dir, name);
    const values = existsSync(file) ? envValues(file) : {};
    const value = Object.entries(values).find(([key]) => /key/i.test(key))?.[1] ?? '';
    keys[id] = value.split(/[,;\s]+/).find(Boolean) ?? null;
    if (id === 'glm' && /^https?:\/\//.test(values.base_url ?? '')) keys.glmUrl = values.base_url;
  }
  return keys;
}

/** @brief OpenRouter 清单里能勾、服务列出了工具支持的 Qwen 行：先取免费的（:free），没有时取第一个；都没有时 undefined。 */
export function qwenRow(rows) {
  const qwen = rows.filter((row) => row.pickable && !row.added && isQwen(row.id) && !row.hints.includes('no_tools'));
  return qwen.find((row) => row.id.endsWith(':free')) ?? qwen[0];
}

/**
 * @brief 清单开着时（Add provider 表单或提供商卡）只勾一个 Qwen 模型：过滤框填 qwen/，按 qwenRow 选，tickModels 只勾它。
 * @return 勾上的 id；没有清单、没有合适的行或勾不成时为 null
 */
export async function chooseQwen(scope, state) {
  if (!state.checklist) return null;
  const filter = scope.getByTestId('checklist-filter');
  if (await filter.count()) await filter.fill('qwen/');
  const row = qwenRow(await readRows(scope));
  if (!row) return null;
  const ticked = await tickModels(scope, [row.id]);
  return ticked.missing.length === 0 && ticked.picked.length === 1 && ticked.picked[0] === row.id ? row.id : null;
}

/**
 * @brief 设置 → Models 里 OpenRouter 的卡上 Fetch models（用保存的 key）→ 只勾一个 Qwen（chooseQwen）→ Add 1 model，
 *        等它的模型行出现，再等它的探针跑完（页面里要先装 md-real-helpers.mjs 的录制器）。
 * @return { id（加入的模型；没加成时 null）, probed }
 */
export async function addQwenOnCard(page, providerId) {
  const card = cardOf(page, providerId);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-action="fetch-models"]').click();
  const id = await chooseQwen(card, await waitFetched(card, 90000));
  if (!id) {
    const close = card.locator('[data-action="close-form"]');
    if (await close.count()) await close.click();
    return { id: null, probed: false };
  }
  const since = Date.now() - 1000;
  await card.locator('[data-action="add-models"]').click();
  await modelRowOf(page, `${providerId}/${id}`).waitFor({ timeout: 30000 });
  return { id, probed: await waitProbed(page, `${providerId}/${id}`, since, PROBE_MS) };
}

/** @brief 启动一个全新或已有的数据目录的 Mori，等首次启动表单（form 为真）或侧栏，装好探针的录制器。 */
async function startForSetup(dir, exePath, form) {
  const app = await launch({ exePath, userData: dir });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.mori), null, { timeout: 60000 });
  await page.getByTestId(form ? 'connection-form' : 'sidebar').waitFor({ timeout: 60000 });
  await page.evaluate(installProbeRecorder);
  return { app, page };
}

/**
 * @brief key 方式第一步：全新的数据目录经首次启动表单接上 DeepSeek（firstRunDeepSeek：只勾文档的一个模型、Public、
 *        Test connection、等探针），记一条检查。
 * @param record (name, ok, detail) 记检查（调用方把 key 换成 ***）
 */
async function keyDeepSeek(dir, keys, { exePath, record, shot }) {
  const { app, page } = await startForSetup(dir, exePath, true);
  try {
    const run = await firstRunDeepSeek(page, { baseUrl: KEY_MODE_URLS.deepseek, key: keys.deepseek,
      shot: (name) => shot(page, name) });
    const problems = firstRunProblems(run, KEY_MODE_URLS.deepseek);
    record(`FC-27 setup (key mode): first run with DeepSeek (${KEY_MODE_URLS.deepseek}, API key typed into its `
      + 'password field) saves the provider with one documented model, connects, and its probes finish',
    problems.length === 0, JSON.stringify({ problems, picked: run.picked, provider: providerBrief(run.provider) }));
    return problems.length === 0;
  } finally {
    await app.close().catch(() => {});
  }
}

/**
 * @brief key 方式第二步：重新打开 Mori，设置 → Models → Add provider 接 GLM（chooseGlm）与 OpenRouter（只勾一个 Qwen），
 *        各记一条检查，等它们的探针跑完再关掉。
 */
async function keyProviders(dir, keys, { exePath, record }) {
  const { app, page } = await startForSetup(dir, exePath, false);
  const glmUrl = keys.glmUrl ?? KEY_MODE_URLS.glm;
  try {
    await openModelsSettings(page);
    const glm = await addProviderUi(page, { baseUrl: glmUrl, key: keys.glm, choose: chooseGlm });
    const glmProblems = glmAddProblems(glm, glmUrl);
    record(`FC-27 setup (key mode): Add provider for GLM (${glmUrl}, API key typed into its password field) `
      + 'saves the provider with only its model', glmProblems.length === 0,
    JSON.stringify({ problems: glmProblems, provider: providerBrief(glm.provider) }));
    const qwen = await addProviderUi(page, { baseUrl: OPENROUTER_BASE, key: keys.openrouter, choose: chooseQwen });
    const qwenProblems = addedProblems(qwen, OPENROUTER_BASE, 'Detected: OpenRouter');
    record(`FC-27 setup (key mode): Add provider for OpenRouter (${OPENROUTER_BASE}, API key typed into its password `
      + 'field) saves the provider with one Qwen model that lists tool support', qwenProblems.length === 0,
    JSON.stringify({ problems: qwenProblems, picked: qwen.picked, provider: providerBrief(qwen.provider) }));
    for (const added of [glm, qwen].filter((item) => item.provider && item.picked)) {
      const ref = `${added.provider.id}/${added.picked}`;
      const probed = await waitProbed(page, ref, added.since, PROBE_MS);
      console.log(`[fc-real] key mode: probes of ${ref} ${probed ? 'finished' : 'did not finish'}`);
    }
  } finally {
    await app.close().catch(() => {});
  }
}

/**
 * @brief key 方式：建一个全新的数据目录，只经界面接上 DeepSeek（首次启动表单）、GLM 与 OpenRouter 上的一个 Qwen
 *        （Add provider）；key 只输进 Mori 自己的密码框，由 Mori 加密保存。
 * @param keys readKeyFiles 或环境变量的 key（deepseek、glm、openrouter；glmUrl 没有时为 KEY_MODE_URLS.glm）
 * @param opts 选项：exePath（打包程序，没有时为开发构建）、record（记检查）、shot（截图，参数为页面与名字）
 * @return { dir（建的数据目录，调用方最后删掉）, ok（首次启动那一步通过了） }；之后两个提供商的结果由各自的检查记下
 */
export async function buildKeyData(keys, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-fc-real-keys-'));
  console.log(`[fc-real] key mode: building a new data dir in ${dir} through the UI`);
  const first = await keyDeepSeek(dir, keys, opts);
  if (first) await keyProviders(dir, keys, opts);
  return { dir, ok: first };
}
