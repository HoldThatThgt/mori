// 平行 Agent 与 TaskBoard 的真实模型一层（tb-real.mjs）与录制（tb-record.mjs）共用的准备与核对
// （docs/specs/parallel-agents-taskboard.md §17.1“真实模型一层”，数据目录的做法同统一模型提供商规格 §14.1）：
// - 数据目录：v1-real-helpers.mjs scratchModelData 只复制加密的 credentials.json、Local State 与模型配置、档案，
//   从不读取、打印、解密 key，也不写进来源目录；测试准备（synthetic test setup）在复制出的 model-config.json 里
//   建分组 [DeepSeek, GLM] 作为默认范围、给临时项目授权公网。
// - 记录代理（只在 tb-real.mjs 里用，synthetic test setup）：复制出的配置里两个提供商的地址改指本机端口上的转发代理，
//   档案的键与指纹跟着改地址（档案仍是负责人数据里真实探测的结果，不重新探测）；代理把请求原样转发到真实地址，
//   只记下请求体（模型、工具名、消息），不看、不记任何请求头（key 在请求头里）。用来核对“对话会话的请求里没有写入类工具”
//   和“临时提问只读”。
// - 临时项目：只改一个文件就能修好的失败测试（npm test）；角色文件 executor、reviewer（reviewer 的 models 写第二个
//   提供商，所以两个真实模型都用到）。
// - 核对（§17.1 只断言程序保证的事）：回执与 board.json 的写入一一对应、证据编号都在那个实例会话里、每次运行结束后
//   task 的去向按 §9.4 / §7.1、进展摘要的标题与当前在做什么、批准卡的归属；每项返回问题列表（空为通过）。
// §13.8 的标题在这里独立实现一遍（不从 shared/team.ts 导入），用来核对界面。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { sessionOf } from '../fake-endpoint/scripts.mjs';
import { oneLine } from './lib.mjs';
import { contentText, readJsonl, tempProject, writeRoles } from './tb-helpers.mjs';
import {
  findRealProviders, readJson, scratchModelData, sourceProblems, writeJson,
} from './v1-real-helpers.mjs';

/** 测试准备建的分组 id（默认范围） */
export const TB_GROUP = 'mori-tb-real';
/** 对话会话在协作模式下不能有的写入与命令类工具（§5.5） */
export const WRITE_TOOLS = ['bash', 'powershell', 'edit', 'write'];
/** 临时提问的请求里不能有的工具（TB-04） */
export const ASK_FORBIDDEN = ['bash', 'powershell', 'edit', 'write', 'agent_message'];
/** 强制填写与换模型继续的投递开头（§7.5、§12.4）：没有交接的运行之后接着这些投递时，那一棒还没结束 */
const FOLLOW_UPS = ['[Mori] Your turn ended without task_handoff', '[Mori] Your handoff could not be used',
  '[Mori] The model changed'];
/** 强制填写的投递开头（§7.5）：这次运行里写的交接去向一律是结案 */
const FORCED = ['[Mori] Your turn ended without task_handoff', '[Mori] Your handoff could not be used'];
/** 终态 */
const ENDED = ['done', 'failed', 'cancelled'];

/** 录制与真实走查里发的文字（英文：Agent 的附加段与工具都是英文） */
export const PROMPTS = {
  ASK: 'Use the agent_message tool to ask the reviewer role this one question: "What is the first line of '
    + 'README.md?" Do not read the file yourself. Then tell me its answer in one sentence.',
  TEAM: 'The test in this project fails (npm test). Have executor fix sum.js and run npm test, then have reviewer '
    + 'verify the fix by running npm test again.',
  APPROVAL: 'Have executor run the command `node --version` in this project and tell me the version it prints. '
    + 'No file changes are needed.',
  PROGRESS: 'How is it going? Answer in one sentence from what you already know, without calling any tools; this is '
    + 'not a new request.',
  SLOW: 'Have executor run the command `node -e "setTimeout(() => console.log(\'slow job done\'), 90000)"` in this '
    + 'project and tell me what it prints. It takes about 90 seconds.',
  SUPPLEMENT: 'One more constraint for request 1, in my own words: when the slow job finishes, report the exact line '
    + 'it printed and how long it took, and do not change any file in this project.',
  CANCEL: 'Please cancel request 1; I no longer need the slow job.',
};

// ---------- 数据目录与模型 ----------

/**
 * @brief 检查负责人的数据目录并找到两个真实提供商（默认 DeepSeek 与 GLM，§14.1）。只读 model-config.json
 *        的非机密部分（id、名称、地址、模型；key 只有 ref）。
 * @return { first, second }；数据目录不合格时抛错
 */
export function realProvidersOf(source) {
  const problems = sourceProblems(source);
  if (problems.length) throw new Error(problems.join('; '));
  return findRealProviders(readJson(join(source, 'model-config.json')));
}

/** @brief 提供商第一个模型的全名 <provider>/<model>。 */
export const refOf = (provider) => `${provider.id}/${provider.models[0].id}`;

/**
 * @brief 复制数据目录并做测试准备（synthetic test setup）：分组 [first, second] 为默认范围（2026-10-26 起没有网络区域，
 *        不再给临时项目授权公网）；
 *        proxyPort 给出时两个提供商的地址改指本机转发代理 http://127.0.0.1:<port>/p/<provider id>，档案跟着改地址。
 * @param source 负责人的数据目录（只读）
 * @param found realProvidersOf 的结果
 * @param proxyPort 转发代理的端口；不给时不改地址
 * @return { userData, routes（提供商 id → 真实地址，给 startForwardProxy） }
 */
export function prepareRealData(source, found, proxyPort = null) {
  const userData = scratchModelData(source);
  const configFile = join(userData, 'model-config.json');
  const config = readJson(configFile);
  config.groups = [...config.groups.filter((group) => group.id !== TB_GROUP),
    { id: TB_GROUP, members: [found.first.id, found.second.id] }];
  config.normalDefault = TB_GROUP;
  const routes = {};
  if (proxyPort !== null) {
    for (const provider of config.providers.filter((item) => [found.first.id, found.second.id].includes(item.id))) {
      routes[provider.id] = provider.baseUrl;
      provider.baseUrl = `http://127.0.0.1:${proxyPort}/p/${provider.id}`;
    }
    moveProfiles(join(userData, 'model-profiles.json'), config.providers, routes);
  }
  writeJson(configFile, config);
  return { userData, routes };
}

/** @brief 档案的地址、键与指纹换成代理的地址（档案的内容不变，§7.1 的键只是地址变了）。 */
function moveProfiles(file, providers, routes) {
  const data = readJson(file);
  for (const profile of data.profiles) {
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

/** @brief 删掉临时目录（数据目录里有 key 的密文副本，先删 credentials.json）；失败时打印，不抛错。 */
export function removeScratch(dirs) {
  for (const dir of dirs.filter(Boolean)) {
    try {
      rmSync(join(dir, 'credentials.json'), { force: true });
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      console.error(`cannot remove ${dir}: ${oneLine(error)}`);
    }
  }
}

// ---------- 转发代理（synthetic test setup，只记请求体） ----------

/**
 * @brief 启动转发代理：/p/<provider id>/<路径> 原样转发到 routes[id] + <路径>（请求头除 host 外原样带上，响应原样流回）。
 *        每个请求记一项 { t, provider, method, path, body（解析出的请求体，不是 JSON 时为 null）, status }；
 *        不记请求头。
 * @param port 端口（§17.1 的 4600–4699 里分给本套件的）
 * @param routes 提供商 id → 真实地址
 */
export function startForwardProxy(port, routes) {
  const proxy = { port, captures: [], errors: [], server: null };
  proxy.server = http.createServer((req, res) => {
    const match = /^\/p\/([^/?]+)(.*)$/.exec(req.url ?? '');
    const base = match ? routes[match[1]] : undefined;
    if (!base) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => forward(proxy, { req, res, provider: match[1], base, rest: match[2] }, Buffer.concat(chunks)));
  });
  return new Promise((done) => proxy.server.listen(port, '127.0.0.1', () => done(proxy)));
}

/** @brief 转发一个请求并记下它的请求体。 */
function forward(proxy, { req, res, provider, base, rest }, raw) {
  const target = new URL(`${base.replace(/\/+$/, '')}${rest}`);
  let body = null;
  try {
    body = raw.length ? JSON.parse(String(raw)) : null;
  } catch {
    body = null;
  }
  const item = { t: Date.now(), provider, method: req.method, path: rest, body, status: null };
  proxy.captures.push(item);
  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request(target, { method: req.method, headers: { ...req.headers, host: target.host } },
    (answer) => {
      item.status = answer.statusCode;
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
  upstream.on('error', (error) => {
    item.status = 'error';
    proxy.errors.push(`${provider} ${rest}: ${error.message}`);
    console.error(`[tb-proxy] ${provider} ${rest}: ${error.message}`);
    res.destroy();
  });
  res.on('close', () => upstream.destroy());
  upstream.end(raw);
}

/** @brief 关掉转发代理。 */
export function stopForwardProxy(proxy) {
  proxy?.server?.closeAllConnections?.();
  proxy?.server?.close();
}

/** @brief system 的文字（OpenAI 接口的 system/developer 消息，或 Anthropic 接口的 system 字段）。 */
function systemOf(body) {
  if (body.system !== undefined) return [{ role: 'system', content: body.system }];
  return [];
}

/**
 * @brief 代理记下的对话请求（有 messages 的 POST），从 since 起、system 里有 cwd 的（每个驱动一个临时项目），每项
 *        { t, provider, model, tools（工具名）, info（scripts.mjs sessionOf：kind、role、task、k） }。
 * @param proxy startForwardProxy 的结果
 * @param where { since, cwd }
 */
export function chatRequests(proxy, { since = 0, cwd = null } = {}) {
  const out = [];
  for (const item of proxy.captures) {
    const body = item.body;
    if (item.t < since || item.method !== 'POST' || !Array.isArray(body?.messages)) continue;
    const messages = [...systemOf(body), ...body.messages];
    const system = messages.filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => contentText(m.content)).join('\n');
    if (cwd && !system.replace(/\\/g, '/').toLowerCase().includes(cwd.replace(/\\/g, '/').toLowerCase())) continue;
    const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    out.push({ t: item.t, provider: item.provider, model: body.model, tools, info: sessionOf(messages),
      status: item.status });
  }
  return out;
}

// ---------- 临时项目与角色 ----------

/** 失败测试的小项目里那个错的文件 */
export const BUGGY_FILE = 'sum.js';

/**
 * @brief 只写一个文件就能修好的小项目（§17.1 驱动）：package.json（npm test = node test.js）、错的 sum.js、test.js；
 *        另有 tempProject 的 README.md 与 src/a.ts。
 */
export function sumProject(prefix) {
  const project = tempProject(prefix);
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'tb-real-sum', version: '1.0.0',
    private: true, scripts: { test: 'node test.js' } }, null, 2)}\n`);
  writeFileSync(join(project, BUGGY_FILE), 'function sum(a, b) {\n  return a - b;\n}\n\nmodule.exports = { sum };\n');
  writeFileSync(join(project, 'test.js'), "const assert = require('node:assert');\n"
    + "const { sum } = require('./sum');\n\nassert.strictEqual(sum(2, 3), 5);\nassert.strictEqual(sum(-1, 1), 0);\n"
    + "console.log('all tests passed');\n");
  return project;
}

/**
 * @brief 写角色文件（§4.1）：executor 做改动与命令，reviewer 只核对（models 为第二个提供商，两个真实模型都用到）；
 *        都不认领权限，基座持有对话、立项与结案（合并会话，§4.2）。正文带 MORI-ROLE 标记（代理认会话用）。
 */
export function writeRealRoles(project, found) {
  mkdirSync(join(project, '.mori', 'agents'), { recursive: true });
  return writeRoles(project, [
    { name: 'executor', description: 'Changes code and runs commands to finish a task',
      body: 'You are the executor. Make the smallest change that finishes the task, run the project tests, '
        + 'then call task_handoff with the numbers of the tool results that show it works.' },
    { name: 'reviewer', description: 'Verifies the work of another role by reading the code and running the tests; '
      + 'reports pass or fail', models: [found.second.id],
    body: 'You are the reviewer. Do not change files. Read the change, run the tests, then call task_handoff '
      + 'with pass or fail and the numbers of the tool results you checked.' },
  ]);
}

// ---------- §13.8 的标题（独立实现，核对界面用） ----------

/** v0 工具的英文动词（team-stream.md "running 的标题规则"） */
const VERBS = { read: 'Read', bash: 'Run', powershell: 'Run', edit: 'Edit', write: 'Write', grep: 'Search',
  find: 'Find', ls: 'List' };

/** @brief 在工作目录之内的路径写相对路径（同 v0 工具卡）。 */
function relPath(path, cwd) {
  const normal = path.replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return normal.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? normal.slice(base.length + 1) : path;
}

/** @brief 命令的标题：去掉首尾空白后的第一行，超过 80 个字符截断加 …；多行且没截断时加 " …"（§13.10、v0 工具卡）。 */
function commandText(command) {
  const lines = command.trim().split(/\r?\n/);
  const first = lines[0] ?? '';
  if (first.length > 80) return `${first.slice(0, 80)}…`;
  return lines.length > 1 ? `${first} …` : first;
}

/** @brief read 的行范围（v0 工具卡）：" · lines a–b"，只有 offset 时 " · from line a"。 */
function lineText(args) {
  const offset = Number(args.offset);
  const limit = Number(args.limit);
  if (!Number.isFinite(offset) || offset <= 0) return '';
  return Number.isFinite(limit) && limit > 0 ? ` · lines ${offset}–${offset + limit - 1}` : ` · from line ${offset}`;
}

/** @brief 参数里的 task 编号（t1、1、T1 都认，§6.2）。 */
function taskArg(args) {
  const raw = args.task ?? args.task_id ?? args.taskId;
  const match = /^t?(\d+)$/i.exec(String(raw ?? '').trim());
  return match ? `T${Number(match[1])}` : null;
}

/**
 * @brief 一次工具调用的 §13.8 标题，按进展摘要 TaskView.current 带的参数（§13.10：path、offset、limit、
 *        command 的前 200 个字符、pattern、task、request、role、to）。
 * @param ctx { cwd, task（这一行的 task）, seatRoles }
 */
export function expectedTitle(toolName, args, ctx) {
  const a = args ?? {};
  if (/^mcp__(.+?)__(.+)$/.test(toolName)) return toolName.replace(/^mcp__(.+?)__(.+)$/, '$1 · $2');
  if (toolName === 'bash' || toolName === 'powershell') {
    return `Run ${typeof a.command === 'string' ? commandText(a.command) : '…'}`;
  }
  if (toolName === 'grep' || toolName === 'find') return `${VERBS[toolName]} ${a.pattern ?? '…'}`;
  if (toolName === 'ls') return `List ${a.path ? relPath(a.path, ctx.cwd) : '.'}`;
  if (VERBS[toolName]) {
    const target = typeof a.path === 'string' ? relPath(a.path, ctx.cwd) : '…';
    return `${VERBS[toolName]} ${target}${toolName === 'read' ? lineText(a) : ''}`;
  }
  const task = taskArg(a);
  switch (toolName) {
    case 'task_handoff': return `Hand off ${task ?? ctx.task ?? '…'}`;
    case 'board_read': return task ? `Read ${task}` : a.request ? `Read request ${a.request}` : 'Read the board';
    case 'read_session': return `Read ${a.role ? label(a.role) : '…'}’s work on ${task ?? '…'}`;
    case 'agent_message': {
      const to = taskArg({ task: a.to });
      if (to) return `Message ${to}`;
      return `${ctx.seatRoles.includes(a.to) ? 'Message' : 'Ask'} ${a.to ? label(a.to) : '…'}`;
    }
    default: return toolName;
  }
}

/** @brief 角色的显示名：基座为 Mori（§1）。 */
export const label = (role) => (role === 'mori' ? 'Mori' : role);

// ---------- 核对：回执、证据、路由、进展摘要、批准卡 ----------

/**
 * @brief 回执与 board.json 的写入一一对应（§13.2）：每个需求一条 registered（标题相同），每条补充的原话一条 added
 *        （原话相同），撤销的需求一条 cancelled；没有多出来的回执。
 * @param board board.json
 * @param receipts 用户会话文件里的 mori.receipt 条目（或界面里的回执，有 kind、request、quote）
 */
export function receiptProblems(board, receipts) {
  const want = [];
  for (const request of board?.requests ?? []) {
    want.push({ kind: 'registered', request: request.no, title: request.title });
    for (const word of request.words.filter((item) => item.kind === 'supplement')) {
      want.push({ kind: 'added', request: request.no, quote: word.text });
    }
    if (request.status === 'cancelled') want.push({ kind: 'cancelled', request: request.no });
  }
  const left = [...receipts];
  const problems = [];
  for (const item of want) {
    const index = left.findIndex((r) => r.kind === item.kind && r.request === item.request
      && (item.kind !== 'added' || r.quote === item.quote) && (item.kind !== 'registered' || r.title === item.title));
    if (index < 0) problems.push(`no ${item.kind} receipt for request ${item.request}`);
    else left.splice(index, 1);
  }
  return [...problems, ...left.map((r) => `receipt without a board write: ${r.kind} request ${r.request}`)];
}

/** @brief 路径比较用的写法。 */
const pathKey = (path) => String(path ?? '').replace(/\\/g, '/').toLowerCase();

/** @brief 一个会话文件里的消息（type message 的 message），按顺序。 */
const messagesIn = (file) => readJsonl(file).filter((entry) => entry.type === 'message').map((entry) => entry.message);

/**
 * @brief 每个交接的证据编号都在那个实例会话里（§7.3）：交接的 session.file 里有这个 toolCallId 的工具结果，
 *        结果的文字以 "[#n] " 开头，并且有发出这次调用的助手消息。
 */
export function evidenceProblems(board) {
  const problems = [];
  for (const task of board?.tasks ?? []) {
    for (const handoff of task.handoffs.filter((item) => item.evidence.length > 0)) {
      const messages = handoff.session ? messagesIn(handoff.session.file) : [];
      for (const ev of handoff.evidence) {
        const result = messages.find((m) => m.role === 'toolResult' && m.toolCallId === ev.toolCallId);
        const called = messages.some((m) => m.role === 'assistant' && (m.content ?? [])
          .some((part) => part.type === 'toolCall' && part.id === ev.toolCallId));
        if (!result || !called || !contentText(result.content).startsWith(`[${ev.tag}] `)) {
          problems.push(`${task.id} handoff ${handoff.n} (${handoff.from}) evidence ${ev.tag} is not a tool result `
            + `of ${handoff.session?.file ?? 'no session'}`);
        }
      }
    }
  }
  return problems;
}

/**
 * @brief 一棒交接按 §7.1 该去哪里：程序写的交给结案（结案没处理时交给立项）；结案会话的四种结果；task 实例的
 *        need_user → 立项，done/pass/blocked → 结案，写了 next 的 continue/dead_end/fail → next，其余 → 结案；
 *        强制填写的运行里一律结案。
 * @param forced 这一棒是在强制填写的运行里写的
 */
export function expectedRoute(handoff, forced) {
  if (handoff.from === 'mori') return handoff.reason === 'close_undecided' ? { kind: 'create' } : { kind: 'close' };
  if (handoff.from.startsWith('close:')) {
    switch (handoff.outcome) {
      case 'close_done': return { kind: 'end', status: 'done' };
      case 'close_failed': return { kind: 'end', status: 'failed' };
      case 'continue': return { kind: 'role', role: handoff.next };
      default: return { kind: 'create' };
    }
  }
  if (forced) return { kind: 'close' };
  if (handoff.outcome === 'need_user') return { kind: 'create' };
  if (['done', 'pass', 'blocked'].includes(handoff.outcome)) return { kind: 'close' };
  if (handoff.next && ['continue', 'dead_end', 'fail'].includes(handoff.outcome)) {
    return { kind: 'role', role: handoff.next };
  }
  return { kind: 'close' };
}

/** @brief 一个实例会话文件里的投递（role 为 user 的消息的文字），按顺序；第 k 次运行是第 k 次投递。 */
const deliveriesIn = (file) => messagesIn(file).filter((m) => m.role === 'user').map((m) => contentText(m.content));

/**
 * @brief 每个 task 实例的每次运行结束后，task 处于 §9.4 规定的状态：这次运行写了交接（自己的或程序写的一棒，
 *        session.turns 的最后一个回合是它）时去向按 §7.1（expectedRoute）；没有时下一次投递是强制填写或换模型继续
 *        （那一棒还没结束）。结案会话的交接同样按 §7.1。
 * @param board board.json
 * @param instances tb-helpers.instanceFiles 的结果
 * @return { problems, runs（每次运行一行的说明，写进 note） }
 */
export function routingProblems(board, instances) {
  const problems = [];
  const runs = [];
  for (const task of board?.tasks ?? []) {
    for (const handoff of task.handoffs) {
      const deliveries = handoff.session ? deliveriesIn(handoff.session.file) : [];
      const at = deliveries[(handoff.session?.turns[1] ?? 0) - 1] ?? '';
      const want = expectedRoute(handoff, FORCED.some((text) => at.startsWith(text)));
      if (JSON.stringify(handoff.routedTo) !== JSON.stringify(want)) {
        problems.push(`${task.id} handoff ${handoff.n} (${handoff.from} ${handoff.outcome}) went to `
          + `${JSON.stringify(handoff.routedTo)}, want ${JSON.stringify(want)}`);
      }
    }
  }
  for (const inst of instances.filter((item) => item.first?.data?.kind === 'task')) {
    const { task: id, role } = inst.first.data;
    const task = board?.tasks.find((item) => item.id === id);
    const deliveries = deliveriesIn(inst.file);
    deliveries.forEach((text, i) => {
      const k = i + 1;
      const handoff = task?.handoffs.find((h) => pathKey(h.session?.file) === pathKey(inst.file)
        && h.session.turns[1] === k);
      const next = deliveries[k] ?? null;
      runs.push(`${id} ${role} run ${k}: ${handoff ? `${handoff.from} ${handoff.outcome ?? handoff.reason} → `
        + `${handoff.routedTo.kind}${handoff.routedTo.role ? ` ${handoff.routedTo.role}` : ''}` : 'no handoff'}`);
      if (!handoff && !(next && FOLLOW_UPS.some((prefix) => next.startsWith(prefix)))) {
        problems.push(`${id} ${role} run ${k} ended without a handoff and without a fallback (next: `
          + `${oneLine(next ?? 'none', 80)})`);
      }
    });
  }
  return { problems, runs };
}

/** @brief 每个 task 都到了终态、waiting_user，或交给了结案（TB-45）；返回不满足的。 */
export function unsettledTasks(board) {
  return (board?.tasks ?? []).filter((task) => !ENDED.includes(task.status) && task.status !== 'waiting_user'
    && task.holder?.kind !== 'close').map((task) => `${task.id} ${task.status} (${JSON.stringify(task.holder)})`);
}

/**
 * @brief 一个实例会话里 t 时刻可能是“当前”的工具调用：在 t 之前结束（条目写下的时刻就是 message_end）的最后一条
 *        带工具调用的助手消息的全部调用（pi 按顺序执行这一批，当前的是其中一个）；它结束不到 1.5 秒时也算上前一条的
 *        （界面最多每 250 毫秒收到一次 TaskBoard 视图）。
 * @param file 实例会话文件
 * @param t 界面上看到这一行的时刻（ms）
 */
function latestCalls(file, t) {
  const batches = readJsonl(file).filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => ({ end: Date.parse(entry.timestamp), calls: (entry.message.content ?? [])
      .filter((part) => part.type === 'toolCall') })).filter((b) => b.calls.length > 0 && b.end <= t + 300);
  const last = batches.at(-1);
  if (!last) return [];
  const previous = t - last.end < 1500 ? batches.at(-2)?.calls ?? [] : [];
  return [...last.calls, ...previous];
}

/**
 * @brief 进展摘要的文字（§13.3、TB-37 真实层）：标题行以 "Request <n> · <board 里的标题> · " 开头；task 行以
 *        "<id> <board 里的标题> · " 开头；running 的行里当前在做什么等于那个实例会话那时最近一次工具调用的标题。
 * @param board board.json
 * @param seen tb-helpers.phasesOf 的结果（MutationObserver 记下的每次变化）
 * @param ctx { instances（instanceFiles）, cwd, seatRoles }
 * @return { problems, checked（核对过的 running 行数） }
 */
export function progressProblems(board, seen, ctx) {
  const problems = [];
  let checked = 0;
  for (const item of seen) {
    if (item.request !== undefined) {
      const request = board?.requests.find((r) => r.no === item.request);
      if (!request || !item.text.startsWith(`Request ${request.no} · ${request.title} · `)) {
        problems.push(`title line "${item.text}" vs board title "${request?.title}"`);
      }
      continue;
    }
    const task = board?.tasks.find((t) => t.id === item.task);
    if (!task || !item.text.startsWith(`${task.id} ${task.title} · `)) {
      problems.push(`task row "${item.text}" vs board title "${task?.title}"`);
      continue;
    }
    if (item.phase !== 'running') continue;
    const problem = runningProblem(task, item, ctx);
    checked += 1;
    if (problem) problems.push(problem);
  }
  return { problems, checked };
}

/** @brief 一个 running 行：`<id> <title> · <role> · <当前在做什么>[ · <模型提示>]`，核对当前在做什么。 */
function runningProblem(task, item, ctx) {
  const rest = item.text.slice(`${task.id} ${task.title} · `.length);
  const role = [...new Set([task.assignee, ...task.handoffs.map((h) => h.next).filter(Boolean), 'executor',
    'reviewer'])].find((name) => rest.startsWith(`${label(name)} · `));
  if (!role) return `running row "${item.text}" has no known role`;
  const doing = rest.slice(`${label(role)} · `.length).split(' · Switched model:')[0];
  const inst = ctx.instances.find((i) => i.first?.data?.kind === 'task' && i.first.data.task === task.id
    && i.first.data.role === role);
  if (!inst) return `running row "${item.text}": no ${role} session on ${task.id}`;
  const titles = latestCalls(inst.file, item.t).map((call) => expectedTitle(call.name, call.arguments,
    { cwd: ctx.cwd, task: task.id, seatRoles: ctx.seatRoles }));
  return titles.includes(doing) ? null
    : `running row "${item.text}": "${doing}" is not the latest tool call of ${role} on ${task.id} (${titles})`;
}

/**
 * @brief 后台批准卡写明角色与 task（§11.3）：界面卡头的归属行等于 "<role> · <task> · <task 标题>"（role 的显示名），
 *        data-agent、data-task 与事件相同，task 标题等于 board.json 里的，请求 id 是 "<实例 id>:approval-<n>"，
 *        实例 id 是这个 task 的一个实例会话。
 * @param card { attribution, agent, task, request } 界面里看到的卡
 * @param event 对应的 mori.team_approval_request 事件
 * @param ctx { board, instances }
 */
export function approvalProblems(card, event, ctx) {
  if (!event) return [`no mori.team_approval_request for card ${card.request}`];
  const problems = [];
  const want = event.task ? `${label(event.role)} · ${event.task} · ${event.taskTitle}` : label(event.role);
  if (card.attribution !== want) problems.push(`attribution "${card.attribution}", want "${want}"`);
  if (card.agent !== event.role || (card.task ?? null) !== (event.task ?? null)) {
    problems.push(`data-agent ${card.agent} / data-task ${card.task}`);
  }
  const task = ctx.board?.tasks.find((t) => t.id === event.task);
  if (event.task && task?.title !== event.taskTitle) {
    problems.push(`task title "${event.taskTitle}" vs "${task?.title}"`);
  }
  if (!new RegExp(`^${event.instance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:approval-\\d+$`).test(card.request)) {
    problems.push(`request id ${card.request} is not <instance>:approval-<n> for ${event.instance}`);
  }
  if (!ctx.instances.some((i) => i.id === event.instance && i.first?.data?.role === event.role)) {
    problems.push(`no instance session ${event.instance} of ${event.role}`);
  }
  return problems;
}
