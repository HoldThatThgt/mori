// 平行 Agent 与 TaskBoard 的 App 套件（tests/ui/tb-app-*.mjs）共用的准备、操作与读取
// （docs/specs/parallel-agents-taskboard.md §17.1；界面标识见 docs/v1/screens/team-*.md）：
// - 合成端点（tests/fake-endpoint/server.mjs 的脚本模式，synthetic）加一个记录代理：端点的日志行（agent、kind、task、
//   scenario、k、j、tools、toolChoice、format、calls…）和代理记下的完整请求体都按会话（角色，种类，task）分开；
// - 数据目录（synthetic test setup）：model-config.json、model-profiles.json（跳过探针，直接给出写入等级 A/B/C/没有、
//   能否关思考、模型族、并发）、pi 的 settings.json 与 trust.json；
// - 角色文件：临时项目的 .mori/agents/<name>.md，正文带合成端点认角色用的 MORI-ROLE-<name>；
// - App：启动、关掉、用同一个数据目录重新启动；打开文件夹拿到就绪的会话；发消息（Enter / Ctrl+Enter、/task）、
//   模型菜单里的 Task mode 一行（2026-10-26 前是顶栏的协作开关）；读会话 id 与会话文件、board.json、实例会话文件、
//   后台进程的事件；等回执、进展摘要、task 行、批准卡、模式提示；
//   等用户会话与整个协作都空闲（TeamState.busy 为假）；
// - 结果文件：test-results/tb-app-<suite>(-packaged).json；--only 时写 tb-partial-app-<suite>(-packaged).json（不计入覆盖检查）；
//   --exe 指向打包好的 Mori.exe。检查名以 TB 编号开头（调用方保证）。
// 只读页面和磁盘、发界面操作，不改 Mori 的源码与数据，模型的回复全部来自脚本（scenarios/<suite>.mjs）。

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sessionOf } from '../fake-endpoint/scripts.mjs';
import { appRoot, arg, createRecorder, killKernel, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import { stubFolder } from './m3-helpers.mjs';
import { dragSelect } from './m4-helpers.mjs';
import {
  FAKE_VERSION, baseOf, captureEvents, eventsOf, paneSel, paneState, poll, startProxy, stopEndpoint, watchStages,
} from './v1-switch-helpers.mjs';

export { baseOf, eventsOf, paneSel, paneState, poll, sleep, oneLine };

// ---------- 命令行与结果文件 ----------

/**
 * @brief 解析套件的命令行：--exe <Mori.exe>（打包版）、--only a,b（只跑这些步骤，结果写成 partial）。
 * @param suite 套件名（tb-app-<suite>.mjs 的 <suite>）
 * @return { suite, exePath（没有时 null）, only（步骤名数组或 null）, file（结果文件名）, shots（截图目录） }
 */
export function suiteArgs(suite) {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `tb-partial-app-${suite}${packaged}.json` : `tb-app-${suite}${packaged}.json`;
  const shots = join(appRoot, `test-results/tb-app-${suite}${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite, exePath, only, file, shots };
}

/**
 * @brief 结果收集器（同 lib.mjs createRecorder）：record(name, ok, detail) 记一条，finish() 写结果文件并设退出码。
 * @param args suiteArgs 的结果
 */
export function tbRecorder(args) {
  const recorder = createRecorder(args.exePath ?? 'dev build');
  return {
    record: recorder.record,
    results: recorder.results,
    /** @brief 写 test-results/<args.file>；全部通过（或已知问题）时退出码 0。 */
    finish() {
      const ok = recorder.write(args.file);
      process.exitCode = ok ? 0 : 1;
      console.log(`[${args.suite}] results in test-results/${args.file}`);
      return ok;
    },
  };
}

/** @brief 一行概括（检查的 detail，最多 max 个字符）。 */
export const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);

// ---------- 合成端点与记录代理 ----------

/**
 * @brief 启动脚本模式的合成端点（synthetic）和它前面的记录代理；提供商的地址写代理的端口（baseOf(proxyPort)），
 *        这样既有端点的日志行（scripts.mjs logFields），又有完整的请求体（system、工具、消息）。
 * @param port 合成端点的端口（每个套件自己的端口，§17.1 的 4600–4699 里）
 * @param proxyPort 记录代理的端口
 * @param env 合成端点的额外环境变量（FAKE_KEYS 等）
 * @return { child, proxy, logs（端点日志行，带收到的时刻 t）, stderr（端点 stderr 行，脚本找不到步骤时在这里）, port, proxyPort }
 */
export async function startTbEndpoint(port, proxyPort, env = {}) {
  const logs = [];
  const stderr = [];
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '5', FAKE_FIRST_DELAY_MS: '20', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 列表请求与详情请求的 JSON 行带 path（model-discovery.md §13.1、server.mjs 开头"日志"），不是对话请求，不记进 logs
  collectLines(child.stdout, (line) => {
    if (!line.startsWith('{')) return;
    try {
      const entry = JSON.parse(line);
      if (!('path' in entry)) logs.push({ t: Date.now(), ...entry });
    } catch {
      // 不是日志行
    }
  });
  collectLines(child.stderr, (line) => stderr.push({ t: Date.now(), line }));
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`fake endpoint ${port} did not start within 15 s`)), 15000);
    child.stdout.on('data', function onData(chunk) {
      if (!String(chunk).includes('synthetic')) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      done();
    });
  });
  const proxy = await startProxy(proxyPort, port);
  return { child, proxy, logs, stderr, port, proxyPort };
}

/** @brief 按行收集一个流。 */
function collectLines(stream, onLine) {
  let rest = '';
  stream.on('data', (chunk) => {
    rest += String(chunk);
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
}

/** @brief 关掉合成端点与记录代理。 */
export async function stopTbEndpoint(ep) {
  if (!ep) return;
  ep.proxy?.server.close();
  await stopEndpoint(ep.child);
}

/**
 * @brief 某个脚本的端点日志行（不含探针），可再按 agent、kind、task 筛；按收到的顺序。
 *        默认跳过收尾检查那次请求（日志行 check: true，finish-check.md §14.4、§0 第 15 条），where.check 为真时也取。
 * @param ep startTbEndpoint 的结果
 * @param scenario 脚本名（tb-<suite>-…）
 * @param where { agent?, kind?, task?（null 表示没有 task）, since?, check?（也取检查请求） }
 */
export function scenarioLines(ep, scenario, where = {}) {
  return ep.logs.filter((line) => !line.probe && line.scenario === scenario && line.t >= (where.since ?? 0)
    && (where.check || !line.check)
    && (where.agent === undefined || line.agent === where.agent)
    && (where.kind === undefined || line.kind === where.kind)
    && (where.task === undefined || line.task === where.task));
}

/** @brief 日志行的简写 "<agent>/<kind>/<task> k=<k> j=<j> calls=<…>"（检查的 detail）。 */
export const lineBrief = (lines) => lines.map((line) => `${line.agent}/${line.kind}/${line.task ?? '-'} k=${line.k} `
  + `j=${line.j} ${line.status} calls=${(line.calls ?? []).join('+') || '-'}`);

/** @brief 消息内容的文字。 */
export const contentText = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '');

/**
 * @brief 记录代理收到的某个脚本的对话请求（按收到的顺序），每项 { t, body, info（scripts.mjs sessionOf 的结果）,
 *        system（system/developer 消息的全文）, tools（工具名）, messages }；可按 agent、kind、task 筛。
 *        默认跳过收尾检查那次请求（info.check，finish-check.md §14.4），where.check 为真时也取。
 * @param ep startTbEndpoint 的结果
 * @param scenario 脚本名；null 时不按脚本筛（关闭模式下没有脚本的请求）
 * @param where { agent?, kind?, task?, since?, check?（也取检查请求） }
 */
export function scenarioRequests(ep, scenario, where = {}) {
  const out = [];
  for (const item of ep.proxy.captures) {
    if (!item.chat || !item.body || item.t < (where.since ?? 0)) continue;
    const messages = item.body.messages ?? [];
    const info = sessionOf(messages);
    if (info.check && !where.check) continue;
    if (scenario !== null && info.scenario !== scenario) continue;
    if (where.agent !== undefined && info.role !== where.agent) continue;
    if (where.kind !== undefined && info.kind !== where.kind) continue;
    if (where.task !== undefined && info.task !== where.task) continue;
    const system = messages.filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => contentText(m.content)).join('\n');
    const tools = (item.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    out.push({ t: item.t, body: item.body, info, system, tools, messages });
  }
  return out;
}

/** @brief 端点 stderr 里"没有脚本步骤"的行（脚本写错或程序多发了请求时出现）。 */
export const missingSteps = (ep, since = 0) => ep.stderr.filter((item) => item.t >= since
  && item.line.includes('no script step'));

// ---------- 数据目录（synthetic test setup） ----------

/**
 * @brief 一个模型的配置（统一模型提供商规格 §4.1）。
 * @param id 模型 id（在合成端点上任意；-nochoice、-noschema 等后缀见 server.mjs 开头）
 * @param opts { family（模型族，§12.9；空串时用 <provider>/<model>）, contextWindow, maxTokens, reasoning }
 */
export function tbModel(id, { family = '', contextWindow = 128000, maxTokens = 16384, reasoning = false } = {}) {
  return { id, family, contextWindow, maxTokens, reasoning, input: ['text'] };
}

/**
 * @brief 一个提供商的配置（没有 key：合成端点不检查认证）；地址指向 port（通常是记录代理的端口）。
 * @param id 提供商 id
 * @param port 端口
 * @param models tbModel 的列表
 * @param opts { concurrency（默认 4）, name }
 */
export function tbProvider(id, port, models, { concurrency = 4, name = id.toUpperCase() } = {}) {
  return { id, name, api: 'openai-completions', baseUrl: baseOf(port), compat: {}, concurrency,
    keys: [], nextKeyNumber: 1, models };
}

/** @brief 探针一步的结果。 */
const step = (outcome) => ({ outcome, detail: null });

/**
 * @brief 已验证的档案（synthetic test setup，跳过探针）：tool_calling 已验证；写入等级按 tier（§7.5：A 第 5 步通过、
 *        B 第 6 步通过、C 第 7 步通过、null 都不通过，protocol_write 为 failed）；能否关思考按 canDisable（true：思考一步
 *        通过，reasoning.can_disable 为真，A 级强制填写才用 tool_choice，§15；false：思考一步不通过；'unknown'：
 *        not_applicable）。A 但不能关思考时按 B 或 C（§7.5）：bPass 给出第 6 步是否通过（默认：tier 为 B，或 tier 为 A
 *        而 canDisable 不为 true）。键与指纹按 kernel/modelProfiles.ts 的写法算，启动时不重新探测。
 * @param baseUrl 提供商地址
 * @param model tbModel 的结果
 * @param opts { tier: 'A'|'B'|'C'|null（默认 'A'）, canDisable: true|false|'unknown'（默认 true）, bPass }
 */
export function tbProfile(baseUrl, model, { tier = 'A', canDisable = true, bPass } = {}) {
  const key = [baseUrl, 'openai-completions', model.id, FAKE_VERSION].join('|');
  const fingerprint = JSON.stringify([key, model.contextWindow, model.maxTokens, model.reasoning, model.input, []]);
  const b = bPass ?? (tier === 'B' || (tier === 'A' && canDisable !== true));
  const thinking = canDisable === true ? 'pass' : canDisable === false ? 'fail' : 'not_applicable';
  const steps = { ready: step('pass'), thinking: step(thinking), call: step('pass'), result: step('pass'),
    replay: step('not_applicable'), a: step(tier === 'A' ? 'pass' : 'fail'), b: step(b ? 'pass' : 'fail'),
    c: step(tier === 'C' || (tier === 'A' && !b) ? 'pass' : tier === null ? 'fail' : 'not_run') };
  return {
    key, fingerprint, baseUrl, api: 'openai-completions', modelId: model.id,
    auto: { server: { kind: 'vllm', version: FAKE_VERSION }, reported: null, field: 'none', steps },
    probedAt: Date.now(), suite: 1,
  };
}

/**
 * @brief 写数据目录（synthetic test setup）：model-config.json（全部本机地址）、model-profiles.json（每个模型一份
 *        tbProfile，选项按 profiles[<provider>/<model>]）、pi/settings.json，以及要信任的项目（pi/trust.json）。
 * @param userData 数据目录
 * @param setup { providers（tbProvider 的列表）, groups（[{ id, members }]，默认无）, normalDefault（默认第一个提供商）,
 *              profiles（<provider>/<model> → tbProfile 的选项）, piSettings（默认 {}）, trusted（要信任的项目文件夹） }
 */
export function seedTeamUserData(userData, setup) {
  const { providers, groups = [], profiles = {}, piSettings = {}, trusted = [] } = setup;
  mkdirSync(join(userData, 'pi'), { recursive: true });
  const config = { version: 1, providers, groups, normalDefault: setup.normalDefault ?? providers[0].id };
  writeFileSync(join(userData, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const list = [];
  const seen = new Set();
  for (const provider of providers) {
    for (const model of provider.models) {
      const key = `${provider.baseUrl}|${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(tbProfile(provider.baseUrl, model, profiles[`${provider.id}/${model.id}`]));
    }
  }
  writeFileSync(join(userData, 'model-profiles.json'), `${JSON.stringify({ version: 1, profiles: list }, null, 2)}\n`);
  writeFileSync(join(userData, 'pi', 'settings.json'), `${JSON.stringify(piSettings, null, 2)}\n`);
  if (trusted.length > 0) {
    const decisions = Object.fromEntries(trusted.map((folder) => [realpathSync(resolve(folder)), true]));
    writeFileSync(join(userData, 'pi', 'trust.json'), `${JSON.stringify(decisions, null, 2)}\n`);
  }
}

/** @brief 新的临时数据目录。 */
export const tempUserData = (prefix = 'mori-tb-data-') => mkdtempSync(join(tmpdir(), prefix));

/** @brief 新的临时项目（README.md 与 src/a.ts，lib.mjs prepareProject）。 */
export const tempProject = (prefix = 'mori-tb-') => prepareProject(prefix).project;

// ---------- 角色文件 ----------

/** @brief 合成端点认角色用的标记（scripts.mjs ROLE_MARK）：写进角色文件的正文。 */
export const roleMark = (name) => `MORI-ROLE-${name}`;

/** @brief YAML 里的一个值：列表写成 [a, b]，对象写成 JSON（YAML 的子集），字符串原样。 */
function yamlValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : item))
    .join(', ')}]`;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * @brief 写一个角色文件 <project>/.mori/agents/<file 或 name>.md（§4.1）：frontmatter 按 role 的字段（name、description、
 *        seats、tools、models、requires、differ_from、subscribe，没给的不写），正文为 body 加 MORI-ROLE-<name>。
 * @param project 项目文件夹
 * @param role { name, description, seats?, tools?, models?, requires?, differ_from?, subscribe?, body?, file? }
 * @return 写出的文件路径
 */
export function writeRole(project, role) {
  const dir = join(project, '.mori', 'agents');
  mkdirSync(dir, { recursive: true });
  const fields = ['name', 'description', 'seats', 'tools', 'models', 'requires', 'differ_from', 'subscribe'];
  const header = fields.filter((field) => role[field] !== undefined)
    .map((field) => `${field}: ${yamlValue(role[field])}`);
  const body = `${role.body ?? `You are the ${role.name} role.`}\n${roleMark(role.name)}\n`;
  const file = join(dir, `${role.file ?? role.name}.md`);
  writeFileSync(file, `---\n${header.join('\n')}\n---\n${body}`);
  return file;
}

/** @brief 写一组角色文件（writeRole），返回文件路径。 */
export const writeRoles = (project, roles) => roles.map((role) => writeRole(project, role));

// ---------- 只读会话碰文件的工具与 PATH 上的 rg、fd（file-system-permissions.md §8.11） ----------

/** pi 找 rg、fd 时认的程序（pi utils/tools-manager.js：rg；fd、fdfind） */
export const SEARCH_PROGRAMS = Object.freeze(['rg.exe', 'fd.exe', 'fdfind.exe']);

/**
 * @brief 测试进程的 PATH 上有没有这个程序（App 继承这个进程的 PATH；§8.11 先找 <agentDir>in，再找 PATH 的每一项，
 *        带引号的目录去掉引号）。
 */
export const onPath = (program) => (process.env.PATH ?? '').split(';')
  .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).some((dir) => dir !== '' && existsSync(join(dir, program)));

/**
 * 只读会话碰文件的工具，排好序：read 加 pi 的默认工具去掉 edit、write（测试的数据目录没有设 defaultTools：bash），再加
 * 装了程序的搜索工具（数据目录的 <agentDir>in 是空的，所以只看 PATH：有 rg.exe 时 grep，有 fd.exe 时 find；§8.11）
 */
export const READ_ONLY_FILE_TOOLS = Object.freeze(['bash', 'read', ...(onPath('rg.exe') ? ['grep'] : []),
  ...(onPath('fd.exe') ? ['find'] : [])].sort());

/**
 * @brief 测试准备：PATH 去掉每个含 rg.exe、fd.exe、fdfind.exe 的目录（同 m0-shell 去掉 bash 的做法），App 与 pi 在
 *        PATH 上找不到它们；变量名照 process.env 里原来的写法（Windows 上不分大小写，有两份时子进程拿到哪一份说不准）。
 * @return 交给 launch 的 env
 */
export function withoutSearchPrograms() {
  const name = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path';
  const keep = (process.env[name] ?? '').split(';').filter(Boolean)
    .filter((dir) => !SEARCH_PROGRAMS.some((exe) => existsSync(join(dir, exe))));
  return { [name]: keep.join(';') };
}

/** 关闭模式的工作卡里“工具是 Agent 的、不让用户调”那一行的开头（§8.3，M26） */
export const OFF_CARD_TOOLS = "Tools are yours, not the user's: never ask the user to call a tool";

/**
 * @brief 分开的配置（proposal §6.2）：chat 持有对话，planner 持有立项与结案，executor、reviewer 做 task；
 *        正文带各自的 MORI-ROLE 标记。角色文件没有 tools 字段（file-system-permissions.md §8.6：写了就是
 *        unknown field "tools"，writeRole 仍能写出它，给测这一行的套件用）。
 */
export const SPLIT_ROLES = [
  { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'] },
  { name: 'planner', description: 'Decides how to split each request and closes it', seats: ['create', 'close'] },
  { name: 'executor', description: 'Changes code and runs commands to finish a task' },
  { name: 'reviewer', description: 'Checks the work of another role and reports pass or fail' },
];

// ---------- App ----------

/**
 * @brief 启动 Mori（MORI_APP_DIR 指向 tb-build.mjs 建的目录时用它）：订阅后台进程的事件（captureEvents，window.__mp）、
 *        阶段行记录（watchStages），主进程与后台进程的输出收进 ctx.appLog（调试用）。
 * @param ctx { userData, exePath, pageErrors?, appLog? }；结果写进 ctx.app、ctx.page
 */
export async function startTbApp(ctx) {
  ctx.pageErrors ??= [];
  ctx.appLog ??= [];
  ctx.app = await launch({ exePath: ctx.exePath ?? null, userData: ctx.userData });
  const child = ctx.app.process();
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) collectLines(stream, (line) => ctx.appLog.push({ t: Date.now(), line }));
  }
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await captureEvents(ctx.page);
  await watchStages(ctx.page);
  return ctx.page;
}

/** @brief 关掉 Mori（有序关闭后台进程）；最多等 20 秒。 */
export async function closeTbApp(ctx) {
  if (!ctx.app) return;
  const app = ctx.app;
  ctx.app = null;
  ctx.page = null;
  await Promise.race([app.close().catch(() => {}), sleep(20000)]);
}

/** @brief 用同一个数据目录重新启动 Mori（重启测试，§11.6）；之后要重新打开会话（openRow / reopenSession）。 */
export async function restartTbApp(ctx) {
  await closeTbApp(ctx);
  return startTbApp(ctx);
}

/**
 * @brief 不经有序关闭直接结束 Mori 的整棵进程树（模拟崩溃或在任务管理器里结束，§11.6“后台进程退出或 App 重启”），
 *        然后用同一个数据目录重新启动；之后要重新打开会话。
 */
export async function killRestartTbApp(ctx) {
  const pid = ctx.app?.process().pid;
  ctx.app = null;
  ctx.page = null;
  if (pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已经退出
    }
  }
  await sleep(1000);
  return startTbApp(ctx);
}

/** @brief 只结束后台进程（utilityProcess，lib.mjs killKernel），界面留着（显示后台进程退出）；返回它的 PID。 */
export const killTbKernel = (ctx) => killKernel(ctx.app);

/** @brief 主进程与后台进程输出里含 pattern 的行（调试与检查日志）。 */
export const appLogLines = (ctx, pattern, since = 0) => ctx.appLog.filter((item) => item.t >= since
  && (typeof pattern === 'string' ? item.line.includes(pattern) : pattern.test(item.line))).map((item) => item.line);

/** @brief 经进程桥发一条命令（window.mori.request），返回结果。 */
export const bridge = (ctx, command) => ctx.page.evaluate((cmd) => window.mori.request(cmd), command);

/**
 * @brief 把"When you’re away"设为 Never（away.set { timeout: 'never' }，file-system-permissions.md §9.6）：测试里窗口
 *        可能不在前台，等卡超过几分钟的套件启动后先这样设，卡不会因为无人应答被自动拒绝（file-system.md §19.4）。
 *        设置存在这个数据目录的 away.json 里，重启 App 后仍有效；写不出时抛错。
 */
export async function awayNever(ctx) {
  const result = await bridge(ctx, { type: 'away.set', timeout: 'never' });
  if (result?.timeout !== 'never' || result.error) throw new Error(`away.set never failed: ${JSON.stringify(result)}`);
}

/** @brief 等某个会话面板就绪（不在"正在启动…"）。 */
async function waitPaneReady(ctx, selector, timeout = 30000) {
  await ctx.page.waitForFunction((css) => {
    const pane = document.querySelector(css);
    return pane && !pane.querySelector('[data-testid="not-ready"]');
  }, selector, { timeout });
}

/**
 * @brief 点"打开文件夹…"打开 folder（系统对话框换成直接返回它），回答信任询问（trust 为 true/false 时；出现了却没给时
 *        按"不信任"），等新会话就绪。
 * @param ctx startTbApp 之后的 ctx
 * @param folder 项目文件夹
 * @param opts { trust：出现信任询问时的回答（true 信任并记住，false 不信任） }
 * @return 新会话的标识（chat-pane 的 data-tab，也是侧栏行的 data-row）
 */
export async function openProject(ctx, folder, { trust } = {}) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  await stubFolder(ctx.app, folder);
  await page.getByRole('button', { name: 'Open folder…', exact: true }).first().click();
  const dialog = page.getByTestId('trust-dialog');
  const outcome = await Promise.race([
    page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length === n, before + 1, { timeout: 30000 })
      .then(() => 'pane'),
    dialog.waitFor({ timeout: 30000 }).then(() => 'trust'),
  ]);
  if (outcome === 'trust' || await dialog.isVisible().catch(() => false)) {
    if (trust) await dialog.getByRole('checkbox', { name: 'Remember my choice' }).check();
    await dialog.getByRole('button', { name: trust ? 'Trust workspace' : 'Don’t trust', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
  }
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length >= n, before + 1,
    { timeout: 30000 });
  const tab = await page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]').first().getAttribute('data-tab');
  await waitPaneReady(ctx, paneSel(tab));
  return tab;
}

/** @brief 让某个会话显示出来（点侧栏里它的一行），等它就绪。 */
export async function showTab(ctx, tab) {
  const shown = ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`);
  if (await shown.count()) return;
  await ctx.page.locator(`.session-item[data-row="${tab}"]`).click();
  await shown.waitFor({ timeout: 15000 });
  await waitPaneReady(ctx, paneSel(tab));
}

/**
 * @brief 重新启动之后从侧栏打开一个已保存的会话（按会话文件），等它就绪；返回它的标识。
 * @param file 会话文件（userSession 的 sessionFile）
 */
export async function reopenSession(ctx, file) {
  const row = ctx.page.locator(`.session-item[data-file=${JSON.stringify(file)}]`);
  await row.waitFor({ timeout: 30000 });
  await row.click();
  await ctx.page.waitForFunction((f) => {
    const active = document.querySelector('.session-item.active');
    return active?.getAttribute('data-file') === f;
  }, file, { timeout: 15000 }).catch(() => {});
  const tab = await row.getAttribute('data-row');
  await ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 30000 });
  await waitPaneReady(ctx, paneSel(tab));
  return tab;
}

/**
 * @brief 某个会话（标识 tab）此刻的 pi 会话 id 与会话文件：会话文件取侧栏行的 data-file，id 取 pi 的文件名
 *        <时刻>_<id>.jsonl（文件还没写盘时也有名字）。
 * @return { sessionId, sessionFile }；侧栏还没有这一行时为 null
 */
export async function userSession(ctx, tab) {
  const file = await poll(() => ctx.page.locator(`.session-item[data-row="${tab}"]`).getAttribute('data-file')
    .catch(() => ''), 10000);
  if (!file) return null;
  const id = /[\\/][^\\/_]+_([^\\/]+)\.jsonl$/i.exec(file)?.[1] ?? null;
  return { sessionId: id, sessionFile: file };
}

/**
 * @brief 后台进程里这个用户会话此刻的信息（session.open 对开着的会话只读地交出它这一刻的样子）：
 *        SessionInfo（含 team、board、teamApprovals、deciding）与 live（LiveSnapshot）。
 * @param sessionFile 用户会话的会话文件
 */
export const liveInfo = (ctx, sessionFile) => bridge(ctx, { type: 'session.open', sessionFile });

/** @brief 这个用户会话的 TeamState（session.open 的 team）。 */
export async function teamStateOf(ctx, sessionFile) {
  return (await liveInfo(ctx, sessionFile)).team;
}

/** @brief 这个用户会话的 TaskBoard 视图（board.get）。 */
export const boardViewOf = (ctx, sessionId) => bridge(ctx, { type: 'board.get', sessionId });

/**
 * @brief 等用户会话与整个协作都空闲：后台进程里 TeamState.busy 为假、对话不在运行或准备中，界面里这个会话的面板
 *        不在生成、发送，并且连续 stableMs 保持这样（两次运行之间、写出 board.json 到唤醒之间会有一瞬间是空闲的）。
 * @param ctx ctx
 * @param who { tab, sessionFile }
 * @param opts { timeout（默认 120 s）, stableMs（默认 1500） }
 * @return 空闲时为 true，超时为 false
 */
export async function waitTeamIdle(ctx, who, { timeout = 120000, stableMs = 1500 } = {}) {
  const deadline = Date.now() + timeout;
  let since = null;
  while (Date.now() < deadline) {
    const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
    const pane = await paneState(ctx.page, who.tab);
    const idle = info && !info.team.busy && !info.live?.running && !info.live?.preparing && pane && !pane.running
      && !pane.sending;
    if (!idle) since = null;
    else if (since === null) since = Date.now();
    else if (Date.now() - since >= stableMs) return true;
    await sleep(200);
  }
  return false;
}

/**
 * @brief 在某个会话的输入框里写字并按键发送。
 * @param text 原文（/task 的写法由调用方写进文字，或用 opts.team）
 * @param opts { key：'Enter'（默认）或 'Control+Enter'（插话）, team：为真时在前面加 "/task "（2026-10-26 由 /team 改） }
 */
export async function sendMessage(ctx, tab, text, { key = 'Enter', team = false } = {}) {
  await showTab(ctx, tab);
  const box = ctx.page.locator(`${paneSel(tab)} .composer textarea`);
  await box.fill(team ? `/task ${text}` : text);
  await box.press(key);
}

/** @brief 这一栏输入框下面一行的模型按钮（docs/v1/screens/model-menu.md）。 */
export const modelButtonSel = (tab) => `${paneSel(tab)} [data-testid="model-button"]`;
/** @brief 这一栏的模型菜单。 */
export const modelMenuSel = (tab) => `${paneSel(tab)} [data-testid="model-menu"]`;
/** @brief 这一栏模型菜单里的 Task mode 一行（docs/v1/screens/team-switch.md）。 */
export const taskRowSel = (tab) => `${modelMenuSel(tab)} [data-testid="team-switch"]`;

/**
 * @brief 这个会话的协作模式此刻在模型按钮上的样子（2026-10-26 WP-09 起开关在模型菜单里，不打开菜单时读按钮，
 *        team-switch.md“模型按钮上的模式”）：{ mode（data-team-mode）, text（按钮上的字，用 textContent：两段是
 *        flex 的项，innerText 会在中间断行）, label（读屏名称）, title（悬停）, locked（data-locked，pickLocked）,
 *        disabled（aria-disabled） }。没有模型按钮时（第一次打开中、打开失败）等到超时报错。
 */
export function teamSwitch(ctx, tab) {
  return ctx.page.locator(modelButtonSel(tab)).evaluate((el) => ({
    mode: el.dataset.teamMode ?? null, text: el.textContent.trim(), label: el.getAttribute('aria-label'),
    title: el.getAttribute('title'), locked: el.dataset.locked === 'true',
    disabled: el.getAttribute('aria-disabled') === 'true' }));
}

/** @brief 打开这一栏的模型菜单（已经开着时不动），等 Task mode 一行出现。 */
export async function openModelMenu(ctx, tab) {
  if (!(await ctx.page.locator(modelMenuSel(tab)).count())) await ctx.page.locator(modelButtonSel(tab)).click();
  await ctx.page.locator(taskRowSel(tab)).waitFor({ timeout: 10000 });
}

/**
 * @brief 关上这一栏的模型菜单：开着时再点一下模型按钮（不按 Esc：菜单已经自己关上时，焦点不在文字框里按 Esc 也可能
 *        停掉回复）。
 */
export async function closeModelMenu(ctx, tab) {
  const menu = ctx.page.locator(modelMenuSel(tab));
  if (await menu.count()) await ctx.page.locator(modelButtonSel(tab)).click();
  await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

/**
 * @brief 打开模型菜单读 Task mode 一行（team-switch.md“Task mode 一行”）：{ mode（data-mode）, checked（aria-checked）,
 *        role, label（读屏名称）, hint（第二行，没有时 null）, described（读屏的描述）, disabled（disabled 或
 *        aria-disabled：切换中只有后者）, focused（焦点在它上面） }。
 * @param opts { keepOpen：为真时读完不关菜单 }
 */
export async function taskModeRow(ctx, tab, { keepOpen = false } = {}) {
  await openModelMenu(ctx, tab);
  const row = await ctx.page.locator(taskRowSel(tab)).evaluate((el) => {
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return { mode: el.dataset.mode, checked: el.getAttribute('aria-checked'), role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'), hint: el.querySelector('[data-testid="team-hint"]')?.textContent ?? null,
      described: ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' '),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', focused: document.activeElement === el };
  });
  if (!keepOpen) await closeModelMenu(ctx, tab);
  return row;
}

/**
 * @brief 在开着的菜单里依次按 keys 里的键（↑ ↓），每次记下焦点所在的元素：data-testid，没有时 data-action（Manage models），
 *        范围的项记 menuitemradio。
 */
export async function menuArrows(ctx, keys) {
  const seen = [];
  for (const key of keys) {
    await ctx.page.keyboard.press(key);
    seen.push(await ctx.page.evaluate(() => {
      const el = document.activeElement;
      if (el?.getAttribute('role') === 'menuitemradio') return 'menuitemradio';
      return el?.dataset.testid ?? el?.dataset.action ?? null;
    }));
  }
  return seen;
}

/**
 * @brief 在模型菜单里点 Task mode 一行，等模型按钮的 data-team-mode 变成 want（不给时只等它变化）；之后关上菜单。
 * @param opts { keepOpen：为真时点完不关菜单（看菜单不关、焦点留在这一行） }
 * @return 点之后的 teamSwitch 状态
 */
export async function clickTeamSwitch(ctx, tab, want = null, { keepOpen = false } = {}) {
  const before = await teamSwitch(ctx, tab);
  await openModelMenu(ctx, tab);
  await ctx.page.locator(taskRowSel(tab)).click();
  await ctx.page.waitForFunction(({ css, old, target }) => {
    const mode = document.querySelector(css)?.dataset.teamMode;
    return target ? mode === target : mode !== old;
  }, { css: modelButtonSel(tab), old: before.mode, target: want }, { timeout: 10000 });
  if (!keepOpen) await closeModelMenu(ctx, tab);
  return teamSwitch(ctx, tab);
}

// ---------- 磁盘：TaskBoard 与会话文件 ----------

/** @brief 读一个 .jsonl（pi 的会话文件）：每行一个 JSON；不存在时为 []，坏行跳过。 */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** @brief 这个用户会话的 TaskBoard 目录 <userData>/teams/<id>。 */
export const teamDir = (ctx, sessionId) => join(ctx.userData, 'teams', sessionId);

/** @brief 读 <userData>/teams/<id>/board.json；没有时为 null。 */
export function readBoard(ctx, sessionId) {
  const file = join(teamDir(ctx, sessionId), 'board.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** @brief <userData>/teams/<id>/ 下的文件名（检查没有留下临时文件）。 */
export function teamDirFiles(ctx, sessionId) {
  const dir = teamDir(ctx, sessionId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/**
 * @brief 这个用户会话的实例会话文件（<userData>/teams/<id>/sessions/*.jsonl），每项
 *        { id（pi 会话 id，例如 <用户会话 id>.t1.executor）, file, header（第一行会话头部）, first（头部之后第一条条目）,
 *        entries（全部条目） }，按文件名排。
 */
export function instanceFiles(ctx, sessionId) {
  const dir = join(teamDir(ctx, sessionId), 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().map((name) => {
    const file = join(dir, name);
    const entries = readJsonl(file);
    const id = entries[0]?.id ?? name.slice(name.indexOf('_') + 1, -'.jsonl'.length);
    return { id, file, header: entries[0] ?? null,
      first: entries[1] ?? null, entries: entries.slice(1) };
  });
}

/** @brief 实例会话 id 的后缀（去掉用户会话 id 与点）：例如 "t1.executor"、"close.1"、"ask.1.planner"。 */
export const instanceSuffix = (sessionId, id) => (id.startsWith(`${sessionId}.`) ? id.slice(sessionId.length + 1) : id);

/** @brief 会话条目里的消息（type 为 message 的 message），可按角色筛。 */
export const messagesOf = (entries, role = null) => entries.filter((entry) => entry.type === 'message'
  && (role === null || entry.message?.role === role)).map((entry) => entry.message);

/** @brief 会话条目里某种自定义条目（type custom、customType 为 type）的 data。 */
export const customOf = (entries, type) => entries.filter((entry) => entry.type === 'custom'
  && entry.customType === type).map((entry) => entry.data);

// ---------- 身份段里交出去的活那一句（记忆规格附录 A.1.1、subagent 规格 §6.4，测试里独立实现） ----------

/** 交出去的工具与那一句里它的两部分，按表的顺序 */
const HANDOFF_PARTS = [
  ['task_create', 'tasks you create', 'the task description'],
  ['agent_message', 'questions you send to other agents', 'the question'],
  ['subagent', 'prompts you give subagents', 'the prompt'],
];

/** @brief A、A and B、A, B and C。 */
const joinList = (items, word) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} `
  + `${items.at(-1)}`);

/**
 * @brief 这些工具时身份段第三行末尾应有的那一句；都没有交出去的工具时为 null。
 * @param tools 请求里的工具名
 */
export function expectedHandoff(tools) {
  const parts = HANDOFF_PARTS.filter(([tool]) => tools.includes(tool));
  if (parts.length === 0) return null;
  const who = joinList(parts.map((part) => part[1]), 'and');
  return `${who[0].toUpperCase()}${who.slice(1)} are worked on by agents that don't see <facts>: write the facts they `
    + `need into ${joinList(parts.map((part) => part[2]), 'or')}.`;
}

// ---------- 后台进程的事件（captureEvents 记在 window.__mp） ----------

/**
 * @brief 记下的后台进程事件：mori.* 的全文在 data；pi 的 message_start / message_end 有 role、text、stopReason；
 *        agent_start、agent_settled 只有类型。可按会话 id、类型、起始时刻筛。
 * @param sid 会话 id；null 时不筛
 * @param type 类型（字符串或正则）；null 时不筛
 */
export async function kernelEvents(ctx, sid, type = null, since = 0) {
  const all = await eventsOf(ctx.page, sid, since);
  return all.filter((item) => type === null || (typeof type === 'string' ? item.type === type : type.test(item.type)));
}

/**
 * @brief 订阅工具执行与回执的先后（合并会话的回执在工具执行时写，§13.2）：window.__tbOrder 记下用户会话的
 *        tool_execution_start / end（工具名）与 mori.receipt、mori.wake、mori.progress、message_start（角色与文字开头）。
 */
export function captureOrder(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__tbOrder) return;
    window.__tbOrder = [];
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
      if (type === 'tool_execution_start' || type === 'tool_execution_end') {
        Object.assign(item, { tool: event.toolName, id: event.toolCallId, isError: event.isError ?? null });
      } else if (type === 'message_start' || type === 'message_end') {
        Object.assign(item, { role: event.message?.role, text: text(event.message).slice(0, 200) });
      } else if (/^mori\.(receipt|wake|progress|team_state)$/.test(type)) {
        item.data = event;
      } else if (type !== 'agent_start' && type !== 'agent_settled') return;
      window.__tbOrder.push(item);
    });
  });
}

/** @brief captureOrder 记下的事件（可按会话 id 与起始时刻筛）。 */
export const orderOf = (ctx, sid, since = 0) => ctx.page.evaluate(({ id, from }) => (window.__tbOrder ?? [])
  .filter((item) => item.t >= from && (id === null || item.sid === id)), { id: sid, from: since });

// ---------- 对话流：回执、进展摘要、批准卡 ----------

/** @brief 某个会话面板里的回执：[{ kind, request, text, title }]，按对话流顺序。 */
export function receiptsOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="receipt"]`).evaluateAll((els) => els.map((el) => ({
    kind: el.dataset.kind, request: Number(el.dataset.request), text: el.textContent.trim(),
    title: el.getAttribute('title') })));
}

/**
 * @brief 某个会话面板里的进展摘要：[{ request, state, title（标题行文字）, expanded, tasks: [{ task, phase, text }],
 *        chains: { <task>: 文字 }, ruledOut: [行], conclusion（文字或 null） }]，按对话流顺序。
 */
export function progressOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="progress"]`).evaluateAll((els) => els.map((el) => {
    const title = el.querySelector('.progress-title');
    const chains = {};
    for (const chain of el.querySelectorAll('[data-testid="progress-chain"]')) {
      chains[chain.dataset.task] = chain.textContent;
    }
    return {
      request: Number(el.dataset.request), state: el.dataset.state, title: title?.textContent ?? '',
      expanded: title?.getAttribute('aria-expanded') === 'true',
      tasks: [...el.querySelectorAll('[data-testid="progress-task"]')].map((row) => ({ task: row.dataset.task,
        phase: row.dataset.phase, text: row.textContent })),
      chains,
      ruledOut: [...el.querySelectorAll('[data-testid="progress-ruled-out"] .progress-line')]
        .map((row) => row.textContent),
      conclusion: el.querySelector('[data-testid="progress-conclusion"]')?.textContent ?? null,
    };
  }));
}

/**
 * @brief 展开或折叠某个需求的进展摘要（点标题行），等 aria-expanded 变成 open。
 * @param request 需求编号
 * @param open 要展开（true）还是折叠
 */
export async function setProgressOpen(ctx, tab, request, open = true) {
  const title = ctx.page.locator(`${paneSel(tab)} [data-testid="progress"][data-request="${request}"] .progress-title`);
  if ((await title.getAttribute('aria-expanded')) === String(open)) return;
  await title.click();
  await ctx.page.waitForFunction(({ css, want }) => document.querySelector(css)?.getAttribute('aria-expanded') === want,
    { css: `${paneSel(tab)} [data-testid="progress"][data-request="${request}"] .progress-title`, want: String(open) },
    { timeout: 5000 });
}

/**
 * @brief 等界面里出现一条回执（data-kind、data-request），最多 timeout；出现时为 true。
 * @param want { kind?, request? }
 */
export function waitReceipt(ctx, tab, want, timeout = 30000) {
  const css = `${paneSel(tab)} [data-testid="receipt"]${want.kind ? `[data-kind="${want.kind}"]` : ''}`
    + `${want.request ? `[data-request="${want.request}"]` : ''}`;
  return ctx.page.locator(css).first().waitFor({ timeout }).then(() => true, () => false);
}

/**
 * @brief 等某个需求的进展摘要出现（可要求 data-state），最多 timeout；出现时为 true。
 * @param want { request, state? }
 */
export function waitProgress(ctx, tab, want, timeout = 60000) {
  const css = `${paneSel(tab)} [data-testid="progress"][data-request="${want.request}"]`
    + `${want.state ? `[data-state="${want.state}"]` : ''}`;
  return ctx.page.locator(css).first().waitFor({ timeout }).then(() => true, () => false);
}

/**
 * @brief 等某个 task 行出现某个 phase（data-phase），可再要求文字含 text；最多 timeout。出现时返回那一行的文字，否则 null。
 * @param want { task, phase, text? }
 */
export async function waitTaskPhase(ctx, tab, want, timeout = 60000) {
  const css = `${paneSel(tab)} [data-testid="progress-task"][data-task="${want.task}"][data-phase="${want.phase}"]`;
  const ok = await ctx.page.waitForFunction(({ selector, text }) => [...document.querySelectorAll(selector)]
    .some((el) => !text || el.textContent.includes(text)), { selector: css, text: want.text ?? null },
  { timeout }).then(() => true, () => false);
  return ok ? ctx.page.locator(css).first().textContent() : null;
}

/**
 * @brief 在页面里装一个记录器：每个会话面板的每个 task 行（data-task|data-phase|文字）变化时记进 window.__tbPhases，
 *        每项 { t, tab, task, phase, text }（短暂的 phase，例如 Starting、Run …，轮询抓不到）。
 */
export function watchTaskPhases(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__tbPhases) return;
    window.__tbPhases = [];
    const last = new Map();
    const scan = () => {
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        for (const row of pane.querySelectorAll('[data-testid="progress-task"]')) {
          const request = row.closest('[data-testid="progress"]')?.dataset.request;
          const key = `${pane.dataset.tab}|${request}|${row.dataset.task}`;
          const value = `${row.dataset.phase}|${row.textContent}`;
          if (last.get(key) === value) continue;
          last.set(key, value);
          window.__tbPhases.push({ t: Date.now(), tab: pane.dataset.tab, task: row.dataset.task,
            phase: row.dataset.phase, text: row.textContent });
        }
        for (const block of pane.querySelectorAll('[data-testid="progress"]')) {
          const key = `${pane.dataset.tab}|R${block.dataset.request}`;
          const value = `${block.dataset.state}|${block.querySelector('.progress-title')?.textContent ?? ''}`;
          if (last.get(key) === value) continue;
          last.set(key, value);
          window.__tbPhases.push({ t: Date.now(), tab: pane.dataset.tab, request: Number(block.dataset.request),
            state: block.dataset.state, text: block.querySelector('.progress-title')?.textContent ?? '' });
        }
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
  });
}

/** @brief watchTaskPhases 记下的变化（可按会话标识与起始时刻筛）。 */
export const phasesOf = (ctx, tab, since = 0) => ctx.page.evaluate(({ key, from }) => (window.__tbPhases ?? [])
  .filter((item) => item.t >= from && (key === null || item.tab === key)), { key: tab, from: since });

/**
 * @brief 对话流里按顺序的条目（Transcript.tsx 的每个 [data-item]；程序投递的 wake 条目不画，所以不在其中），每项
 *        { kind（user、assistant、receipt、progress、note、stopped…，即 data-item）, text（前 160 个字）,
 *          request（进展摘要与回执的 data-request，没有时 null）, actions（这一项下面有回复操作行）,
 *          inside（条目里按顺序的工具卡标题与回执：[{ kind: 'tool' | 'receipt', text }]） }。
 */
export function transcriptItems(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="transcript"]`).evaluate((root) => {
    // 你的消息下面一行的 Rewind 按钮（.user-actions，文件系统第 2 步，fs-rewind.md）不是消息的文字：去掉再取
    const text = (el) => {
      const copy = el.cloneNode(true);
      copy.querySelectorAll('.user-actions').forEach((node) => node.remove());
      return copy.textContent.replace(/\s+/g, ' ').trim();
    };
    return [...root.querySelectorAll('[data-item]')].map((el) => {
      const marked = el.querySelector('[data-testid="progress"], [data-testid="receipt"]');
      const inside = [...el.querySelectorAll('[data-testid="tool-card"], [data-testid="receipt"]')].map((node) => (
        node.dataset.testid === 'tool-card'
          ? { kind: 'tool', text: node.querySelector('.tool-title')?.textContent ?? '' }
          : { kind: 'receipt', text: text(node) }));
      return { kind: el.dataset.item, text: text(el).slice(0, 160),
        request: marked ? Number(marked.dataset.request) : null,
        actions: Boolean(el.querySelector('[data-testid="reply-actions"]')), inside };
    });
  });
}

/**
 * @brief 某个会话面板对话流里的模式提示（§13.11，docs/v1/screens/team-switch.md）：按先后 [{ mode（data-mode）, text,
 *        before（它后面第一条你的消息的文字，没有时为 null）, next（紧跟在它后面的那一项的 data-item，没有时为 null；
 *        “right before”的检查看它是不是 user） }]。
 */
export function modeNoticesOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="transcript"]`).evaluate((root) => {
    // 同 transcriptItems：你的消息下面一行的 Rewind 按钮（.user-actions，fs-rewind.md）不是消息的文字，去掉再取；
    // 重新打开的会话在 workspace.status 到之前还没有这个按钮，不去掉时实时与重新打开的对不上
    const text = (el) => {
      const copy = el.cloneNode(true);
      copy.querySelectorAll('.user-actions').forEach((node) => node.remove());
      return copy.textContent.replace(/\s+/g, ' ').trim();
    };
    const items = [...root.querySelectorAll('[data-item]')];
    return items.flatMap((el, at) => {
      const notice = el.querySelector('[data-kind="team-mode"]');
      if (!notice) return [];
      const next = items.slice(at + 1).find((item) => item.dataset.item === 'user');
      return [{ mode: notice.dataset.mode, text: notice.textContent.trim(),
        before: next ? text(next) : null,
        next: items[at + 1]?.dataset.item ?? null }];
    });
  });
}

/**
 * @brief 某个会话面板里折起的步骤组下面的回执（docs/v1/screens/team-stream.md“回执的位置”合并会话：卡收着时回执“看起来就在
 *        组的摘要行下面”）：每个折起的摘要行，这一组的卡写的、看得见的回执，[{ row（摘要行的字）,
 *        gap（第一条回执的上沿减摘要行的下沿，px）, below（这些回执都在摘要行下面） }]；这一组没有回执的行不列。
 *        一组可以跨几条助手消息（摘要行在第一条里，写回执的卡在后面的一条里，例如立项先调了一次被拒的 bash），
 *        所以按卡外层的 data-step-group 认组，不按回执所在的项。
 */
export function receiptsUnderRows(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="transcript"]`).evaluate((root) => {
    // 回执画在写它的工具卡那一层（Member，带 data-step-group）后面，同一张卡的几条回执相邻
    const groupOf = (receipt) => {
      let el = receipt.previousElementSibling;
      while (el?.dataset.testid === 'receipt') el = el.previousElementSibling;
      return el?.dataset.stepGroup ?? null;
    };
    const receipts = [...root.querySelectorAll('[data-testid="receipt"]')];
    const rows = [...root.querySelectorAll('[data-testid="step-group"][aria-expanded="false"]')];
    return rows.flatMap((row) => {
      const bottom = row.getBoundingClientRect().bottom;
      const tops = receipts.filter((receipt) => groupOf(receipt) === row.dataset.group && receipt.checkVisibility())
        .map((receipt) => receipt.getBoundingClientRect().top);
      if (!tops.length) return [];
      return [{ row: row.textContent, gap: Math.round(Math.min(...tops) - bottom),
        below: tops.every((top) => top >= bottom - 1) }];
    });
  });
}

/** @brief 按 F8、写一句（what）、保存，读保存的报告里“Recent activity”一节的各行（以 "- " 开头的）。 */
export async function recentActions(ctx, tab, what = 'TB-01 check of the recent actions') {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).press('F8');
  const dialog = ctx.page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = dialog.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const file = /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  await ctx.page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const md = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## Recent activity');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.startsWith('- '));
}

/**
 * @brief 某个会话面板里的批准卡：[{ request（data-request）, tool, agent（data-agent）, task（data-task）,
 *        subagent（data-subagent，普通模式的 subagent 的 description，docs/specs/subagent.md §7.4）,
 *        attribution（归属行文字）, title }]。
 */
export function approvalCardsOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="approval-card"]`).evaluateAll((els) => els.map((el) => ({
    request: el.dataset.request, tool: el.dataset.tool, agent: el.dataset.agent ?? null, task: el.dataset.task ?? null,
    subagent: el.dataset.subagent ?? null,
    attribution: el.querySelector('[data-testid="approval-attribution"]')?.textContent ?? null,
    title: el.querySelector('[data-testid="approval-title"]')?.textContent ?? '' })));
}

/** @brief 等这个会话面板出现一张批准卡（可要求 data-agent），最多 timeout；返回 approvalCardsOf 的第一张或 null。 */
export async function waitApprovalCard(ctx, tab, { agent = null } = {}, timeout = 30000) {
  const css = `${paneSel(tab)} [data-testid="approval-card"]${agent ? `[data-agent="${agent}"]` : ''}`;
  const ok = await ctx.page.locator(css).first().waitFor({ timeout }).then(() => true, () => false);
  return ok ? (await approvalCardsOf(ctx, tab)).find((card) => !agent || card.agent === agent) ?? null : null;
}

/** @brief 截图到套件的截图目录（失败也不报错）。 */
export const shot = (ctx, args, name) => ctx.page?.screenshot({ path: join(args.shots, `${name}.png`) })
  .catch(() => {});

/** @brief Ctrl+N 在当前项目里新建一个会话，等它就绪，返回它的标识（每个脚本用自己的会话：脚本按请求里第一个 tb-scenario 认）。 */
export async function newSession(ctx) {
  const { page } = ctx;
  const before = await page.locator('.pane-slot').count();
  await page.locator('.pane-slot:not([hidden]) .composer textarea').first().focus();
  await page.keyboard.press('Control+n');
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length === n, before + 1,
    { timeout: 30000 });
  const tab = await page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]').first().getAttribute('data-tab');
  await waitPaneReady(ctx, paneSel(tab));
  return tab;
}

/**
 * @brief 在某个项目里开一个新会话：这个项目已有会话面板时显示它再 Ctrl+N（新会话跟着焦点所在的项目），
 *        否则点"打开文件夹…"（openProject）。ctx.projectTabs 记下每个项目最近的会话。
 * @param project 项目文件夹
 * @param opts openProject 的选项（信任询问的回答）
 * @return 新会话的标识
 */
export async function openSessionIn(ctx, project, opts = {}) {
  ctx.projectTabs ??= {};
  const known = ctx.projectTabs[project];
  const tab = known && await ctx.page.locator(paneSel(known)).count()
    ? await showTab(ctx, known).then(() => newSession(ctx)) : await openProject(ctx, project, opts);
  ctx.projectTabs[project] = tab;
  return tab;
}

/**
 * @brief 把这个会话切到"Full access"（权限菜单 → Full access → 确认；作用于这个用户会话的全部 Agent，§11.1）。
 *        文件系统规格 §6.7 用 Full access 取代原来的 Allow all：工作路径里的编辑、写入、命令不再出卡，写到工作路径外、
 *        受保护路径仍出卡。函数名沿用 allowAll，引用它的 tb-app-* 套件不用改。
 */
export async function allowAll(ctx, tab) {
  await showTab(ctx, tab);
  const pane = ctx.page.locator(paneSel(tab));
  await pane.getByTestId('permission-button').click();
  await ctx.page.getByTestId('permission-menu').getByRole('menuitemradio', { name: 'Full access' }).click();
  await ctx.page.getByTestId('confirm-dialog').getByRole('button', { name: 'Full access', exact: true }).click();
  await ctx.page.waitForFunction((css) => document.querySelector(css)?.textContent?.includes('Full access'),
    `${paneSel(tab)} [data-testid="permission-button"]`, { timeout: 10000 });
}

/** @brief 某个会话面板里的工具卡：[{ verb（.tool-verb）, target（标题里动词之后的部分）, title, status }]。 */
export function toolCardsOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="tool-card"]`).evaluateAll((cards) => cards.map((card) => {
    const title = card.querySelector('.tool-title')?.textContent ?? '';
    const verb = card.querySelector('.tool-verb')?.textContent ?? '';
    return { verb, target: title.slice(verb.length).trim(), title, status: card.dataset.status };
  }));
}

/**
 * @brief 把某条回复里的一段文字作为引用芯片放进输入框（真的拖鼠标选中 → 选区浮层"Attach as context"，docs/v0/screens/quotes.md），
 *        等输入框上方多出一个芯片；/task 的识别在芯片拼进消息之前（§5.1），所以带芯片发 /task 也能用。
 * @param text 回复里的原文（在最后一条含它的回复里选）
 * @return 输入框上方的芯片数
 */
export async function quoteReply(ctx, tab, text) {
  await showTab(ctx, tab);
  const selector = `${paneSel(tab)} [data-testid="assistant"]`;
  const index = await ctx.page.locator(selector).evaluateAll((els, wanted) => els
    .findLastIndex((el) => el.textContent.includes(wanted)), text);
  if (index < 0) throw new Error(`no reply contains "${text}"`);
  const before = await quoteChipsOf(ctx, tab).then((chips) => chips.length);
  if (!(await dragSelect(ctx.page, selector, text, index))) throw new Error(`cannot select "${text}"`);
  await ctx.page.getByTestId('selection-popover').getByRole('button', { name: 'Attach as context' }).click();
  await ctx.page.waitForFunction(({ css, n }) => document.querySelectorAll(css).length > n,
    { css: `${paneSel(tab)} [data-testid="quote-chip"]`, n: before }, { timeout: 5000 });
  return before + 1;
}

/** @brief 某个会话输入框上方的引用芯片：[{ kind（data-kind）, label, text }]。 */
export function quoteChipsOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="quote-chip"]`).evaluateAll((chips) => chips.map((chip) => ({
    kind: chip.dataset.kind, label: chip.querySelector('.quote-chip-label')?.textContent ?? '',
    text: chip.querySelector('.quote-chip-text')?.textContent ?? '' })));
}
