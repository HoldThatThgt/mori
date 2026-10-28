// 收尾检查的真实模型走查（docs/specs/finish-check.md §14.1“真实”一行，§14.2 FC-27）：真正的 Mori 对三个真实服务——
// DeepSeek、GLM、OpenRouter 上的 Qwen，各一个模型——全部经界面操作（录 fixture 的那一段经页面里的录制器发命令，同
// tb-record.mjs）。数据目录有两种来源，之后的走查相同：
// - --source <数据目录>：负责人在 Mori（v1）里保存过这三个提供商（各有 key）的数据目录。只复制加密的文件，从不读、
//   不打印 key（v1-real-helpers.mjs scratchModelData）。DeepSeek 与 GLM 用提供商的第一个模型（同 tb-real-helpers.mjs
//   refOf），OpenRouter 用它的第一个 Qwen 模型（id 以 qwen/ 开头）；没有时在设置 → Models 里 OpenRouter 的卡上 Fetch
//   models、只勾一个列出了工具支持的 Qwen（先免费的）、Add 1 model，等它的探针跑完。
// - key 方式（不给 --source）：--keys <文件夹> 下负责人的 deepseek.env、glm.env、openrouter.env（每个文件里第一个名字含 key
//   的变量；只读文件名与变量名，值只留在这个进程里），或环境变量 FC_REAL_DEEPSEEK_KEY、FC_REAL_GLM_KEY、
//   FC_REAL_OPENROUTER_KEY（一启动就读进内存并从 process.env 删掉，之后启动的 Mori 拿不到）。然后只经界面建一个新的数据
//   目录（fc-real-helpers.mjs buildKeyData，步骤与 md-real.mjs、v1-models-real.mjs 的 key 方式共用）：首次启动表单接
//   DeepSeek，再 Add provider 接 GLM 与 OpenRouter（只勾一个 Qwen），等探针跑完。key 只输进 Mori 自己的密码框；检查的名字
//   与 detail、fixture、note 写出之前都把 key 换成 ***（fixture 里出现 key 时另记为问题、写到 rejected）；截图之前读窗口的
//   文字，出现 key 时不截；最后一条检查核对 Mori 的输出与这次用过的数据目录里（加密的 credentials.json 之外）都没有 key
//   的明文。
// 测试准备（synthetic test setup，只改复制出的数据目录）：两个临时项目（work：README.md 与 src/a.ts；team：另有角色文件
// executor）授权公网；三个提供商的地址改指本机 4975 端口的转发代理（tb-real-helpers.mjs startForwardProxy：只记请求体
// 与状态，不记请求头），档案跟着改地址；每个服务开始前（Mori 退出时）默认范围换成它的模型；第一次启动后经进程桥在用户级
// 记忆里写一条 TASTE、一条 REVIEW（SEEDS），检查那一行因此点名两节、带检查块。
// 每个服务一次启动，依次（--only 可选）：
//   record：录制器开两个会话（Full access），一个问普通问题、一个“说了要做”；第一次检查的结果是 a、b、c 时把这个会话录成
//     tests/fixtures/finish/fc-a-real.json、fc-b-real.json、fc-c-real.json（这次走查里每种只写第一个，source 为 real；
//     不覆盖 fc-record.mjs 的合成录制）。
//   tasks：一个会话（Full access）里四个普通任务：读文件、“说了要做”、一个纯问答、改一行注释。
//   reject：一个会话（Ask each time）让模型跑命令，界面上出现的批准卡都点 Reject；记检查之后又发了几个被拒绝的调用。
//   stop：一个会话问一句，看到检查那次请求就按停止，再发下一条消息，记下那次请求的状态（要求严格交替的服务会回 400）。
//   team：只在第一个服务上跑一次：/task 让 executor 跑 node --version，等协作空闲；Mori 开始的运行（程序投递）同样检查。
// 只断言程序保证的事（§14.1）：每个服务上收尾检查真的跑了（前提：服务限流或不可用时这一条失败，原因写进 detail，接着走
// 下一个服务）；每次运行至多 3 次检查（日志与会话文件）；每个检查那次请求的检查那一行与检查块在同一条 user 消息里，点名的
// 分节都在、内容是写进记忆的那条；界面从不显示检查那一行、从不画 finish（工具卡与阶段行）；没有字段的 finish 调得通
// （至少一次校验通过、结果不是错误）。模型怎么回应只写进 note（test-results/fc-real/notes.json）：按服务的 a、b、c
// （日志 "finish check <n> (<reason>)" 的下一行）、对检查的回应是“只调 finish”“写话 + finish”“只写话”还是干活、检查那次
// 请求的思考与输出 token、检查那次与下一次请求的 cache_read、cache_creation（会话文件里助手消息的用量）、你开始的运行与
// Mori 开始的运行各检查几次（mori.wake 指向的消息开始的运行是 Mori 开始的）、检查之后又发的被拒绝的调用、停止之后下一次
// 请求的状态。数字写进 note，由负责人抄进检查记录。
// 以下情况立即以退出码 1 结束，不启动 Mori、不写结果文件：带值的参数没给值、--only 有不认识的名字、--exe 不存在、
// 既没有 --source 也没有三个 key（--keys 的文件或环境变量）、--source 不合格（缺 model-config.json、credentials.json、
// Local State）。
// 用法（在 app/ 下，用 out/ 的构建或 MORI_APP_DIR 指的构建；真实服务的请求花一点钱）：
//   node tests/ui/fc-real.mjs --source <数据目录> [--exe <Mori.exe>]
//        [--only deepseek,glm,qwen,record,tasks,reject,stop,team]
//   node tests/ui/fc-real.mjs --keys C:/Users/56865/OneDrive/Documents/HoldThatThgt [--exe <Mori.exe>] [--only …]
//   （或不给 --keys，由运行它的进程设好 FC_REAL_DEEPSEEK_KEY、FC_REAL_GLM_KEY、FC_REAL_OPENROUTER_KEY，不回显）
// 结果写到 test-results/fc-real(-packaged).json（--only 时 fc-partial-real…，不计入覆盖检查），note 与截图在
// test-results/fc-real(-packaged)/。端口：4975（转发代理，§0 第 13 条的 4950–4979 里本脚本用它）。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, prepareProject, sleep } from './lib.mjs';
import {
  allowAll, bridge, closeTbApp, openSessionIn, paneSel, paneState, readJsonl, sendMessage, startTbApp, userSession,
  waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';
import { removeScratch, startForwardProxy, stopForwardProxy } from './tb-real-helpers.mjs';
import { paneCounts, poll, stagesOf, waitTabBusy } from './v1-switch-helpers.mjs';
import { findSecrets, installRecorder as installProbeRecorder, redactor } from './md-real-helpers.mjs';
import {
  openModelsSettings, readJson, scratchModelData, sourceProblems, takeEnvSecret,
} from './v1-real-helpers.mjs';
import {
  addQwenOnCard, blockProblems, buildKeyData, checkLogEvents, checkMessageText, checkOutcomes, checkResponses,
  commonProblems, finishCalls, finishSeen, FINISH_TOOL, installRecorder, isCheckEntry, need, readKeyFiles, recDriver,
  proxyRoutes, proxySegment, responseKind, retriesOf, routeThroughProxy, runsOf, saveFixture, servicesOf, sessionEvents,
  textOf, usageOf, useDefault, watchFinish,
} from './fc-real-helpers.mjs';

/** 转发代理的端口 */
const PROXY_PORT = 4975;
/** 一句对话（含检查与接着干的活）的时限 */
const TURN_MS = 10 * 60 * 1000;
/** team 驱动等协作空闲的时限 */
const TEAM_MS = 15 * 60 * 1000;
/** --only 认的名字：服务与驱动 */
const SERVICE_KEYS = ['deepseek', 'glm', 'qwen'];
const DRIVE_KEYS = ['record', 'tasks', 'reject', 'stop', 'team'];
/** 带值的参数 */
const VALUE_FLAGS = ['source', 'keys', 'exe', 'only'];
/** key 方式的环境变量 */
const KEY_VARS = { deepseek: 'FC_REAL_DEEPSEEK_KEY', glm: 'FC_REAL_GLM_KEY', openrouter: 'FC_REAL_OPENROUTER_KEY' };
/** 写进用户级记忆的两条（synthetic test setup）：检查块的两节 */
const SEEDS = { taste: 'Start every answer with its conclusion, then give the details',
  review: 'Before calling a change done, check it with a tool: read the file back or run it' };
/** 发给模型的文字（英文） */
const PROMPTS = {
  PLAIN: 'In one sentence, what is a closure in JavaScript?',
  SAID: 'Reply with exactly this sentence and nothing else, without calling any tool in this reply: "I will now '
    + 'count the lines of README.md."',
  TASKS: ['Read src/a.ts and tell me in two sentences what it does.',
    'Reply with exactly this sentence and nothing else, without calling any tool in this reply: "I will now list '
      + 'the files in src."',
    'In one sentence, what is the difference between let and const in JavaScript?',
    'Add a one-line comment above the add function in src/a.ts that says what it returns.'],
  REJECT: 'Run the command `node --version` in this project and tell me what it prints.',
  STOP: 'In one sentence, what is 2 + 2?',
  AFTER_STOP: 'And what is 3 + 3? Answer in one sentence.',
  TEAM: 'Have executor run the command `node --version` in this project and tell me the version it prints. No file '
    + 'changes are needed.',
};
/** 第一次检查的结果 → 真实录制的名字与覆盖的编号 */
const REAL_FIXTURES = { a: ['fc-a-real', 'FC-11'], b: ['fc-b-real', 'FC-12'], c: ['fc-c-real', 'FC-13'] };
/** fixture 里出现了 key 时的问题（写之前已换成 ***） */
const LEAKED = 'an API key typed into Mori appears in the recording (replaced by *** before writing)';

/** @brief --name 的值；缺失或紧跟着另一个 --参数时为 null。 */
function argValue(name) {
  const value = arg(name);
  return value && !value.startsWith('--') ? value : null;
}

/** @brief 参数的问题（带值的参数没给值、--only 有不认识的名字、--exe 或 --keys 不存在）。 */
function argProblems() {
  const problems = VALUE_FLAGS.filter((name) => process.argv.includes(`--${name}`) && !argValue(name))
    .map((name) => `--${name} needs a value`);
  const unknown = (argValue('only')?.split(',').filter(Boolean) ?? [])
    .filter((name) => ![...SERVICE_KEYS, ...DRIVE_KEYS].includes(name));
  if (unknown.length) problems.push(`--only has unknown names: ${unknown.join(', ')}`);
  for (const name of ['exe', 'keys', 'source']) {
    if (argValue(name) && !existsSync(resolve(argValue(name)))) problems.push(`--${name} ${argValue(name)} not found`);
  }
  return problems;
}

const source = argValue('source') ? resolve(argValue('source')) : null;
const exePath = argValue('exe') ? resolve(argValue('exe')) : null;
const only = argValue('only')?.split(',').filter(Boolean) ?? null;
const services = only?.some((name) => SERVICE_KEYS.includes(name)) ? only : SERVICE_KEYS;
const drives = only?.some((name) => DRIVE_KEYS.includes(name)) ? only : DRIVE_KEYS;
const envKeys = Object.fromEntries(Object.entries(KEY_VARS).map(([id, name]) => [id, takeEnvSecret(name)]));
const keys = source ? null : argValue('keys') ? readKeyFiles(resolve(argValue('keys'))) : envKeys;
const secrets = keys ? ['deepseek', 'glm', 'openrouter'].map((id) => keys[id]).filter(Boolean) : [];
const redact = redactor(secrets);
const suffix = exePath ? '-packaged' : '';
const resultFile = only ? `fc-partial-real${suffix}.json` : `fc-real${suffix}.json`;
const shots = join(appRoot, `test-results/fc-real${suffix}`);
const fixtureDir = join(appRoot, 'tests/fixtures/finish');
const base = createRecorder(exePath ?? 'dev build');
/** @brief 记一条检查（名字与 detail 里的 key 换成 ***）。 */
const record = (name, ok, detail = '') => base.record(redact(name), ok, redact(String(detail)));

/** @brief 截图；窗口的文字里出现 key 时不截。 */
async function shotPage(page, name) {
  if (!page) return;
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (secrets.some((secret) => text.includes(secret))) {
    console.log(`[fc-real] screenshot ${name} skipped: the window text has an API key`);
    return;
  }
  await page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
}

// ---------- 准备 ----------

/**
 * @brief 走查的数据目录：--source 给出时用它（只读，之后复制）；否则 key 方式经界面建一个（buildKeyData）。
 * @return 数据目录；key 方式第一步没通过时抛错
 */
async function dataDir(ctx) {
  if (source) {
    const problems = sourceProblems(source);
    if (problems.length) throw new Error(problems.join('; '));
    return source;
  }
  const built = await buildKeyData(keys, { exePath, record, shot: shotPage });
  ctx.keyDir = built.dir;
  if (!built.ok) throw new Error('key mode: the first run with DeepSeek did not pass (see the setup check)');
  return built.dir;
}

/**
 * @brief 一个服务能不能走：有提供商、有保存的 key、有模型（OpenRouter 没有 Qwen 时由 ensureQwen 加；2026-10-26 起
 *        没有网络区域，不再查区域）。
 */
function serviceProblems(service) {
  const name = service.key === 'qwen' ? 'OpenRouter' : service.label;
  if (!service.provider) return [`no ${name} provider in model-config.json`];
  return [...need((service.provider.keys ?? []).length > 0, `${service.provider.id} has no saved key`),
    ...need(service.key === 'qwen' || service.model !== null, `${service.provider.id} has no model`)];
}

/** @brief 两个临时项目：work（README.md 与 src/a.ts）与 team（另有角色文件 executor）。 */
function prepareProjects(ctx) {
  const work = prepareProject('mori-fc-real-');
  const team = prepareProject('mori-fc-real-team-');
  writeRoles(team.project, [{ name: 'executor', description: 'Changes code and runs commands to finish a task',
    body: 'You are the executor. Do what the task asks, then call task_handoff with the numbers of the tool results '
      + 'that show it.' }]);
  ctx.roots.push(work.root, team.root);
  ctx.work = work.project;
  ctx.team = team.project;
}

/** @brief 启动 Mori（tb-helpers.mjs startTbApp：输出收进 ctx.appLog），装好录制器（先不录）与 watchFinish。 */
async function startApp(ctx) {
  await startTbApp(ctx);
  await ctx.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
  await ctx.page.evaluate(installRecorder, 0);
  await ctx.page.evaluate(() => window.__fcRec.end());
  await watchFinish(ctx.page);
  ctx.projectTabs = {};
}

/**
 * @brief OpenRouter 的提供商还没有 Qwen 模型时：设置 → Models 卡上加一个（addQwenOnCard），等探针跑完；记一条 setup 检查。
 */
async function ensureQwen(ctx, service) {
  await startApp(ctx);
  try {
    await ctx.page.evaluate(installProbeRecorder);
    await openModelsSettings(ctx.page);
    const added = await addQwenOnCard(ctx.page, service.provider.id);
    await shotPage(ctx.page, 'qwen-added');
    record(`FC-27 Qwen setup: ${service.provider.id} has no Qwen model, so Fetch models on its card adds one that `
      + 'lists tool support (free first) and its probes finish', Boolean(added.id) && added.probed,
    JSON.stringify(added));
    service.model = added.id && added.probed ? added.id : null;
  } finally {
    await closeTbApp(ctx);
  }
}

/** @brief 测试准备：经进程桥在用户级记忆里写一条 TASTE、一条 REVIEW（synthetic test setup），之后打开的会话都带它们。 */
async function seedMemory(ctx) {
  for (const kind of ['taste', 'review']) {
    const result = await bridge(ctx, { type: 'memory.save', cwd: null, layer: 'user', kind, abstract: SEEDS[kind],
      detail: 'Synthetic entry written by tests/ui/fc-real.mjs so that the check block has this section.' });
    if (result?.error) throw new Error(`cannot write the ${kind} entry: ${result.error}`);
  }
  ctx.seeded = true;
}

// ---------- 驱动 ----------

/** @brief 在 project 里开一个新会话（allow 为真时 Full access），记进 ctx.sessions。 */
async function uiSession(ctx, service, drive, project, allow) {
  const tab = await openSessionIn(ctx, project);
  if (allow) await allowAll(ctx, tab);
  const item = { service: service.key, drive, ui: true, tab, ...(await userSession(ctx, tab)) };
  ctx.sessions.push(item);
  return item;
}

/** @brief 这个会话面板此刻空闲（不在生成、不在发送、没有阶段行）。 */
async function idleNow(ctx, tab) {
  const pane = await paneState(ctx.page, tab);
  return Boolean(pane && !pane.running && !pane.sending && pane.stage === null);
}

/** @brief 这个会话面板里的批准卡都点 Reject（reject 驱动）。 */
async function rejectCards(ctx, who) {
  const button = ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"] [data-testid="approval-reject"]`)
    .first();
  if (!(await button.count())) return;
  await button.click().catch(() => {});
  who.rejected = (who.rejected ?? 0) + 1;
  await sleep(300);
}

/**
 * @brief 发一条消息，等这一轮（含收尾检查与之后干的活）结束；reject 为真时其间的批准卡都点 Reject。
 * @return 没在时限内结束时的说明；结束了为 null
 */
async function turn(ctx, who, text, { reject = false } = {}) {
  const before = await paneCounts(ctx.page, who.tab);
  await sendMessage(ctx, who.tab, text);
  await waitTabBusy(ctx.page, who.tab, 15000, before);
  const deadline = Date.now() + TURN_MS;
  while (Date.now() < deadline) {
    if (reject) await rejectCards(ctx, who);
    if (await idleNow(ctx, who.tab)) return null;
    await sleep(500);
  }
  return `"${text.slice(0, 40)}…" did not finish within ${TURN_MS / 60000} minutes`;
}

/** @brief 代理记下的这个服务的对话请求（POST，有 messages），从 since 起。 */
const requestsOf = (ctx, service, since = 0) => ctx.proxy.captures.filter((item) => item.provider
  === proxySegment(service.provider.id, ctx.routes[service.provider.id]) && item.t >= since && item.method === 'POST'
  && Array.isArray(item.body?.messages));

/**
 * @brief 把录制器录下的一个会话写成真实录制：第一次检查的结果是 a、b、c 且这次走查还没写过那一种时写
 *        tests/fixtures/finish/fc-<a|b|c>-real.json；核对不通过（含出现了 key）时写到 test-results/fc-real/。
 */
function saveReal(ctx, service, session, steps) {
  const outcome = checkOutcomes(logEventsOf(ctx, session.sessionId))[0]?.outcome;
  const [name, covers] = REAL_FIXTURES[outcome] ?? [];
  if (!name || ctx.saved.has(name)) return;
  const text = JSON.stringify(steps);
  const leaked = secrets.some((secret) => text.includes(secret));
  const ref = `${service.provider.id}/${service.model}`;
  const problems = [...commonProblems(steps), ...need(!leaked, LEAKED),
    ...need(sessionEvents(steps, session.sessionId, 'agent_settled').length === 1, 'not exactly one agent_settled')];
  saveFixture({ source: 'real', note: 'Recorded from a real session by tests/ui/fc-real.mjs (FC-27); do not edit by '
    + 'hand.', name, description: `${service.label} (${ref}): one message in a new session (Full access); the first `
    + `finish check ended as ${outcome}.`, covers, endpoint: ctx.routes[service.provider.id], model: ref,
  notes: [`Setup (synthetic test setup): the provider's address points to the local forward proxy; one TASTE and `
    + 'one REVIEW entry at user level'], recordedAt: new Date().toISOString(),
  steps: leaked ? JSON.parse(redact(text)) : steps }, problems, { outDir: fixtureDir, rejectedDir: shots });
  if (problems.length === 0) ctx.saved.add(name);
}

/** @brief record：录制器开两个会话（普通问题、“说了要做”），把第一次检查的结果是 a、b、c 的录下来。 */
async function recordDrive(ctx, service) {
  const d = recDriver(ctx, TURN_MS);
  for (const text of [PROMPTS.PLAIN, PROMPTS.SAID]) {
    await ctx.page.evaluate(() => window.__fcRec.begin());
    await d.start();
    const session = await d.create(ctx.work);
    await d.cmd({ type: 'approval.setMode', sessionId: session.sessionId, mode: 'full' });
    ctx.sessions.push({ service: service.key, drive: 'record', ui: false, sessionId: session.sessionId,
      sessionFile: session.sessionFile });
    await d.say(session, text, TURN_MS);
    await sleep(800);
    saveReal(ctx, service, session, await ctx.page.evaluate(() => window.__fcRec.end()));
  }
  return null;
}

/** @brief tasks：一个会话（Full access）里依次四个普通任务。 */
async function tasksDrive(ctx, service) {
  const who = await uiSession(ctx, service, 'tasks', ctx.work, true);
  for (const text of PROMPTS.TASKS) {
    const unmet = await turn(ctx, who, text);
    if (unmet) return unmet;
  }
  return null;
}

/** @brief reject：一个会话（Ask each time）让模型跑命令，批准卡都点 Reject。 */
async function rejectDrive(ctx, service) {
  const who = await uiSession(ctx, service, 'reject', ctx.work, false);
  const unmet = await turn(ctx, who, PROMPTS.REJECT, { reject: true });
  return unmet ?? (who.rejected ? null : 'no approval card was shown');
}

/**
 * @brief stop：问一句，代理看到检查那次请求就按停止，再发下一条消息；记下停止时那次请求有没有回应、下一次请求的状态。
 */
async function stopDrive(ctx, service) {
  const who = await uiSession(ctx, service, 'stop', ctx.work, true);
  const since = Date.now();
  await sendMessage(ctx, who.tab, PROMPTS.STOP);
  // 等检查那次请求出去；这一轮没有它就结束了（例如第一次请求出错）时不再等
  const seen = await poll(async () => requestsOf(ctx, service, since)
    .find((item) => checkMessageText(item.body) !== null)
    ?? (Date.now() - since > 3000 && await idleNow(ctx, who.tab) ? 'ended' : null), TURN_MS, 100);
  const hit = seen && seen !== 'ended' ? seen : null;
  const stop = { checkSeen: Boolean(hit), statusAtStop: hit?.status ?? null, stopped: false, nextStatus: null };
  if (hit) await ctx.page.locator(`${paneSel(who.tab)} .stop-button`).click({ timeout: 5000 }).catch(() => {});
  await poll(() => idleNow(ctx, who.tab), TURN_MS, 300);
  stop.stopped = ((await paneState(ctx.page, who.tab))?.stopped ?? 0) > 0;
  const after = Date.now();
  const unmet = await turn(ctx, who, PROMPTS.AFTER_STOP);
  stop.nextStatus = requestsOf(ctx, service, after)[0]?.status ?? null;
  ctx.stops[service.key] = stop;
  return unmet ?? (hit ? null : 'no check request was seen');
}

/** @brief team：/task 让 executor 跑 node --version，等协作空闲（之后的汇报是 Mori 开始的运行）。 */
async function teamDrive(ctx, service) {
  const who = await uiSession(ctx, service, 'team', ctx.team, true);
  const before = await paneCounts(ctx.page, who.tab);
  await sendMessage(ctx, who.tab, PROMPTS.TEAM, { team: true });
  await waitTabBusy(ctx.page, who.tab, 15000, before);
  ctx.teamDone = true;
  const idle = await waitTeamIdle(ctx, who, { timeout: TEAM_MS, stableMs: 5000 });
  return idle ? null : `the team did not become idle within ${TEAM_MS / 60000} minutes`;
}

/** 驱动：名字 → 函数（返回没满足的前提的说明，满足时 null） */
const DRIVES = [['record', recordDrive], ['tasks', tasksDrive], ['reject', rejectDrive], ['stop', stopDrive],
  ['team', teamDrive]];

/** @brief 一个服务：默认范围换成它的模型，启动 Mori，按顺序跑驱动（出错记进 unmet，接着跑下一个），关掉。 */
async function phase(ctx, service) {
  useDefault(ctx.userData, `${service.provider.id}/${service.model}`);
  await startApp(ctx);
  try {
    if (!ctx.seeded) await seedMemory(ctx);
    for (const [name, run] of DRIVES) {
      if (!drives.includes(name) || (name === 'team' && ctx.teamDone)) continue;
      try {
        const unmet = await run(ctx, service);
        if (unmet) service.unmet.push(`${name}: ${unmet}`);
      } catch (error) {
        service.unmet.push(`${name}: ${oneLine(error?.message ?? error, 300)}`);
        await shotPage(ctx.page, `${service.key}-${name}-error`);
      }
      for (const item of ctx.sessions.filter((s) => s.ui && s.service === service.key && !s.stages)) {
        item.stages = (await stagesOf(ctx.page, item.tab)).map((stage) => stage.v);
      }
    }
    service.seen = await finishSeen(ctx.page);
  } finally {
    await closeTbApp(ctx);
  }
}

// ---------- 统计（Mori 退出之后读会话文件、日志与代理的记录） ----------

/** @brief 这次走查里收尾检查的日志行（全部会话）。 */
const allLogEvents = (ctx) => checkLogEvents(ctx.appLog.map((item) => item.line));
/** @brief 一个会话的收尾检查日志行，按先后。 */
const logEventsOf = (ctx, sessionId) => allLogEvents(ctx).filter((event) => event.sessionId === sessionId);
/** @brief 加一。 */
const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

/** @brief 日志行的统计：加检查的原因、每次检查的结果（a、b、c）、日志里最大的检查序号。 */
function logStats(ctx, sessions) {
  const out = { reasons: {}, passes: {}, outcomes: {}, maxLogged: 0, checks: 0 };
  for (const session of sessions) {
    const events = logEventsOf(ctx, session.sessionId);
    for (const event of events) {
      if (event.kind === 'check') {
        bump(out.reasons, event.reason);
        out.checks += 1;
        out.maxLogged = Math.max(out.maxLogged, event.n);
      } else bump(out.passes, event.kind === 'pass' ? event.reason : 'request failed');
    }
    for (const item of checkOutcomes(events)) bump(out.outcomes, item.outcome);
  }
  return out;
}

/** @brief 会话文件里按运行的统计：你开始与 Mori 开始的运行各几次、各检查几次、一次运行最多检查几次。 */
function addRuns(out, runs) {
  for (const run of runs) {
    const n = run.items.filter(isCheckEntry).length;
    const who = run.mori ? 'mori' : 'user';
    out.runs[who] += 1;
    out.checks[who] += n;
    out.maxPerRun = Math.max(out.maxPerRun, n);
  }
}

/** @brief 对检查的回应的种类与用量（检查那次请求与下一次请求）。 */
function addResponses(out, entries) {
  for (const { response, next } of checkResponses(entries)) {
    bump(out.responses, responseKind(response));
    if (usageOf(response)) out.checkUsage.push(usageOf(response));
    if (usageOf(next)) out.nextUsage.push(usageOf(next));
  }
}

/** @brief finish 调用：几次、几次没有字段、没有字段且校验通过、结果是错误的（含参数校验失败）。 */
function addFinish(out, entries) {
  for (const call of finishCalls(entries)) {
    const empty = Object.keys(call.args).length === 0;
    const ok = Boolean(call.result) && !call.result.isError;
    out.finish.calls += 1;
    if (empty) out.finish.noFields += 1;
    if (empty && ok) out.finish.accepted += 1;
    if (!ok) out.finish.failed.push(textOf(call.result?.content ?? '').slice(0, 160) || 'no result');
  }
}

/** @brief 一个服务的会话文件的统计。 */
function fileStats(sessions) {
  const out = { sessions: 0, runs: { user: 0, mori: 0 }, checks: { user: 0, mori: 0 }, maxPerRun: 0, responses: {},
    checkUsage: [], nextUsage: [], finish: { calls: 0, noFields: 0, accepted: 0, failed: [] },
    retries: { rejected: 0, retried: 0 } };
  for (const session of sessions.filter((item) => item.sessionFile && existsSync(item.sessionFile))) {
    const entries = readJsonl(session.sessionFile);
    const runs = runsOf(entries);
    out.sessions += 1;
    addRuns(out, runs);
    addResponses(out, entries);
    addFinish(out, entries);
    const retries = retriesOf(runs);
    out.retries.rejected += retries.rejected;
    out.retries.retried += retries.retried;
  }
  return out;
}

/** @brief system 的文字（OpenAI 的 system/developer 消息，或 Anthropic 的 system 字段）。 */
function systemText(body) {
  const messages = (body.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer');
  return [textOf(body.system ?? ''), ...messages.map((m) => textOf(m.content))].join('\n');
}

/** @brief 路径的比较形式（/ 分隔、小写）。 */
const pathKey = (path) => String(path).replace(/\\/g, '/').toLowerCase();

/**
 * @brief 代理记下的这个服务的请求：带 finish 的请求的状态、检查那次请求的个数与检查块的问题（work 项目的会话在关闭模式，
 *        点名 taste 与 review；team 项目的会话按那次运行的模式点名，只要求点名的都在）。
 */
function requestStats(ctx, service) {
  const requests = requestsOf(ctx, service);
  const statuses = {};
  for (const item of requests.filter((r) => (r.body.tools ?? []).some((t) => (t.function?.name ?? t.name)
    === FINISH_TOOL))) bump(statuses, String(item.status));
  const checks = requests.map((item) => ({ item, text: checkMessageText(item.body) })).filter((x) => x.text !== null);
  const problems = checks.flatMap(({ item, text }) => {
    const team = pathKey(systemText(item.body)).includes(pathKey(ctx.team));
    return blockProblems(text, team ? null : ['taste', 'review'], SEEDS);
  });
  const failed = requests.filter((item) => typeof item.errorText === 'string');
  const errors = [...new Set(failed.map((item) => `${item.status} ${item.errorText.slice(0, 300)}`))].slice(0, 5);
  return { requests: requests.length, withFinish: statuses, checkRequests: checks.length, blockProblems: problems,
    errors, failedSample: failed[0]?.body ?? null };
}

/** @brief 用量的一项的合计、最大、平均（reasoning 只算报了的）。 */
function usageSummary(list) {
  const of = (key) => {
    const values = list.map((item) => item[key]).filter((value) => value !== null && value !== undefined);
    const sum = values.reduce((a, b) => a + b, 0);
    return { reported: values.length, sum, max: values.length ? Math.max(...values) : 0,
      avg: values.length ? Math.round(sum / values.length) : 0 };
  };
  return { count: list.length, output: of('output'), reasoning: of('reasoning'), cacheRead: of('cacheRead'),
    cacheWrite: of('cacheWrite') };
}

/** @brief 一个服务的全部数字（写进 note）。 */
function serviceStats(ctx, service) {
  const sessions = ctx.sessions.filter((item) => item.service === service.key);
  const files = fileStats(sessions);
  return { model: `${service.provider.id}/${service.model}`, unmet: service.unmet, log: logStats(ctx, sessions),
    files: { ...files, checkUsage: usageSummary(files.checkUsage), nextUsage: usageSummary(files.nextUsage) },
    requests: requestStats(ctx, service), stop: ctx.stops[service.key] ?? null };
}

// ---------- 只断言程序保证的事 ----------

/** @brief 一个服务的检查（§14.1：至多 3 次、检查块、不显示、没有字段的 finish 调得通；收尾检查跑了是前提）。 */
function serviceChecks(ctx, service, stats) {
  const { label } = service;
  const ran = stats.log.checks > 0 && stats.requests.checkRequests > 0;
  const why = ran ? '' : ` — no finish check was observed (rate limited or down?): ${service.unmet.join('; ')}`;
  record(`FC-27 ${label}: the finish check ran (precondition: at least one logged check and one check request)`, ran,
    `${JSON.stringify({ logged: stats.log.checks, requests: stats.requests.checkRequests })}${why}`);
  record(`FC-27 ${label}: at most 3 finish checks per run (kernel log and session files)`, ran
    && stats.log.maxLogged <= 3 && stats.files.maxPerRun <= 3,
  JSON.stringify({ maxLogged: stats.log.maxLogged, maxPerRun: stats.files.maxPerRun }));
  record(`FC-27 ${label}: every check request carries the check block in the check line's own user message, with `
    + 'every named section and the seeded entry', ran && stats.requests.blockProblems.length === 0,
  JSON.stringify(stats.requests.blockProblems.slice(0, 5)));
  const tabs = ctx.sessions.filter((item) => item.ui && item.service === service.key);
  const stages = tabs.flatMap((item) => item.stages ?? []).filter((text) => /\bfinish\b/i.test(text));
  const seen = service.seen ?? { cards: [], lines: [] };
  // 只选了 record 时没有经界面的会话（录制器直接发命令），这一条到不了，不记（--only 的结果本来就不算覆盖）
  if (drives.some((name) => name !== 'record')) {
    record(`FC-27 ${label}: the check line never shows in the transcript and finish is never drawn (tool card or `
      + 'stage line)', tabs.length > 0 && seen.cards.length === 0 && seen.lines.length === 0 && stages.length === 0,
    JSON.stringify({ tabs: tabs.length, cards: seen.cards, lines: seen.lines, stages }));
  }
  record(`FC-27 ${label}: finish with no fields is accepted by the service and passes validation (result not an `
    + 'error)', stats.files.finish.accepted > 0, JSON.stringify({ finish: stats.files.finish,
    statuses: stats.requests.withFinish }));
}

/** @brief key 方式的最后一条：Mori 的输出与用过的数据目录里（credentials.json 之外）没有 key 的明文。 */
function leakCheck(ctx) {
  const output = ctx.appLog.map((item) => item.line).join('\n');
  const report = findSecrets([ctx.userData, ctx.keyDir, shots, fixtureDir].filter(Boolean), output, secrets);
  record('FC-27 key mode: no API key in plain text in Mori\'s output, the data dirs used (besides the encrypted '
    + 'credentials.json) and the walkthrough output', report.found.length === 0,
  JSON.stringify({ found: report.found, unreadable: report.unreadable.slice(0, 3), files: report.files }));
}

// ---------- 执行 ----------

/** @brief 准备、逐个服务走查、统计与检查。出错时抛出（由调用方记一条失败）。 */
async function run(ctx) {
  const dir = await dataDir(ctx);
  const all = servicesOf(readJson(join(dir, 'model-config.json'))).filter((item) => services.includes(item.key));
  for (const service of all) {
    const problems = serviceProblems(service);
    record(`FC-27 ${service.label} setup: the data dir has the provider with a saved key`,
      problems.length === 0, problems.join('; ') || `${service.provider.id} (${service.provider.baseUrl})`);
    service.unmet = [];
  }
  const ready = all.filter((service) => serviceProblems(service).length === 0);
  prepareProjects(ctx);
  ctx.userData = scratchModelData(dir);
  for (const service of ready.filter((item) => item.key === 'qwen' && item.model === null)) {
    await ensureQwen(ctx, service);
  }
  ctx.routes = routeThroughProxy(ctx.userData, ready.map((service) => service.provider.id), PROXY_PORT);
  ctx.proxy = await startForwardProxy(PROXY_PORT, proxyRoutes(ctx.routes));
  for (const service of ready.filter((item) => item.model !== null)) await phase(ctx, service);
  for (const service of ready.filter((item) => item.model !== null)) {
    const stats = serviceStats(ctx, service);
    ctx.notes.services[service.label] = stats;
    serviceChecks(ctx, service, stats);
  }
}

/** @brief 写 note（test-results/fc-real/notes.json，key 换成 ***），并在输出里打一行概括。 */
function writeNotes(ctx) {
  mkdirSync(shots, { recursive: true });
  ctx.notes.savedFixtures = [...ctx.saved];
  const text = redact(`${JSON.stringify(ctx.notes, null, 2)}\n`);
  writeFileSync(join(shots, 'notes.json'), text);
  for (const [label, stats] of Object.entries(ctx.notes.services)) {
    console.log(`[fc-real] ${label}: outcomes ${JSON.stringify(stats.log.outcomes)}, responses `
      + `${JSON.stringify(stats.files.responses)}, checks in your runs ${stats.files.checks.user}, in Mori's runs `
      + `${stats.files.checks.mori}`);
  }
  console.log(`[fc-real] numbers in ${join(shots, 'notes.json')}`);
}

const problems = argProblems();
if (!source && secrets.length < 3) {
  problems.push(`key mode needs all three keys (--keys <dir> with deepseek.env, glm.env, openrouter.env, or the env `
    + `vars ${Object.values(KEY_VARS).join(', ')})`);
}
if (problems.length) {
  for (const problem of problems) console.error(`[fc-real] ${problem}`);
  console.error('[fc-real] usage: node tests/ui/fc-real.mjs --source <data dir> | --keys <dir> [--exe <Mori.exe>] '
    + `[--only ${[...SERVICE_KEYS, ...DRIVE_KEYS].join(',')}]`);
  process.exit(1);
}
mkdirSync(shots, { recursive: true });
const ctx = { exePath, pageErrors: [], appLog: [], sessions: [], saved: new Set(), stops: {}, roots: [],
  notes: { recordedAt: new Date().toISOString(), mode: source ? 'source' : 'keys', seeds: SEEDS, services: {} } };
try {
  await run(ctx);
} catch (error) {
  record('FC-27 flow (data dir, setup, walkthrough)', false, oneLine(error?.stack ?? error, 800));
  await shotPage(ctx.page, 'flow-error');
} finally {
  await closeTbApp(ctx);
  stopForwardProxy(ctx.proxy);
  record('FC-27 the page has no uncaught errors during the walkthrough', ctx.pageErrors.length === 0,
    ctx.pageErrors.slice(0, 3).join(' | '));
  if (secrets.length) leakCheck(ctx);
  writeNotes(ctx);
  removeScratch([ctx.userData, ctx.keyDir, ...ctx.roots]);
  await sleep(200);
  process.exitCode = base.write(resultFile) ? 0 : 1;
}
