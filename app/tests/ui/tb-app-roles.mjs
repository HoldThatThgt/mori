// 平行 Agent 与 TaskBoard 的 App 套件：角色、权限、关闭模式、对话只传话、实例会话、协作开关
// （docs/specs/parallel-agents-taskboard.md §17.2）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式
// （tests/fake-endpoint/scenarios/roles.mjs，synthetic），逐条验收这些条目在 App 层的通过条件：
//   TB-01 角色文件校验、TB-02 权限与基座、TB-03 关闭模式与 v0 一致（App 的部分；回放与 m1–m6 fixture 由回放套件做）、
//   TB-09 对话只传话、TB-43 实例会话的存放与事件、TB-53 协作开关（App 的部分）。
// 记忆规格（docs/specs/memory.md §14.4）之后：TB-03 比较 system prompt 时两边都去掉开头的身份段（到第一个 <addendum>、
// <project_context>、<skills> 或 <cwd> 段之前：新版是 Mori 的身份段，对照版是 pi 的身份句、<tools>、<rules>、<docs>），
// 新版再去掉 taste、strategy、review、facts 四段；请求的工具列表在全部比较之前去掉 memory；工具页的行去掉 memory 那一行
// 再比较。TB-09 的工具集合按 §7.6 加 memory（关闭模式的对话、分开时的立项实例）。
// 文件系统规格第 3 步（docs/specs/file-system.md §19.4 的 TB-01、TB-09 两行，file-system-permissions.md §8.3、§8.6）之后：
// 角色文件没有 tools 字段（写了就是 unknown field "tools"）；碰文件的工具所有会话一样（pi 的默认工具 read、bash、edit、
// write，实例另有 mcp__*），协作模式下对话会话只多职责工具，越界的调用在路径闸第 2 步按收窄拒绝（对话为 RELAY_ONLY，
// 立项、结案为各自的 Not allowed …），不出卡、文件不变（seatLimits 一步用合成端点的通用场景 fs-team，scenarios/fs.mjs，
// synthetic；对话调用 MCP 的一半在 lateMcp）；立项、结案、task 实例的请求里有 MCP 服务的工具（instances 一步的项目带
// 一个马上列出工具的合成 MCP 服务）。chat.md 写 tools: [read] 的一步去掉（由 FS-61 覆盖）。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs roles；TB-03 的对照构建 node tests/ui/tb-build-base.mjs，没有时才建）：
//   MORI_APP_DIR=.tb-runs/roles node tests/ui/tb-app-roles.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-roles(-packaged).json（--only 时 tb-partial-app-roles…），截图在 test-results/tb-app-roles/。
// 端口（§17.1 的 4600–4699 里分给本套件的 4600–4609）：合成端点 4600，记录代理 4601。
// 测试准备（synthetic test setup，逐处注明）：数据目录里两个本机提供商 tba、tbb（各一个模型，模型族不同、窗口 128000 与
// 256000，写入等级 A，跳过探针）；临时项目各写自己的角色文件（正文带合成端点认角色用的 MORI-ROLE-<name>）、
// .pi/mcp.json（合成 MCP 服务 tests/mcp-server/server.mjs：一个连上 8 秒后才列出工具，一个马上列出）、.pi/extensions
// （在实例里询问的项目扩展）。
// 同一时间只开一个 App：TB-03 先用对照构建（.tb-runs/base，提交 2e67197，没有 TaskBoard）跑一次关闭模式，再用本构建跑；
// TB-43 的 mori-team 载入失败用本构建的一份拷贝（.tb-runs/roles-teamfail），只在拷贝的内核代码里让 mori-team 的工厂函数
// 抛错（synthetic fault injection，本构建与 src 不变），最后单独启动。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROLES_TEXT } from '../fake-endpoint/scenarios/roles.mjs';
import { SEGMENT_SENTENCES } from '../fake-endpoint/scripts.mjs';
import { RELAY_ONLY, teamMessage } from './fs-helpers.mjs';
import { appRoot } from './lib.mjs';
import { stubFolder } from './m3-helpers.mjs';
import { fitPane, openToolsSection, resizeWindow } from './m6-helpers.mjs';
import { toolRows } from './m6-tools-helpers.mjs';
import {
  allowAll, bridge, brief, closeTbApp, contentText, instanceFiles, instanceSuffix, kernelEvents,
  killTbKernel, messagesOf, missingSteps, newSession, openProject, paneSel, paneState, poll,
  progressOf, readBoard, readJsonl, receiptsOf, reopenSession, restartTbApp, scenarioLines, scenarioRequests,
  seedTeamUserData, sendMessage, showTab, sleep, shot, startTbApp, startTbEndpoint, stopTbEndpoint, suiteArgs,
  SPLIT_ROLES, tbModel, tbProvider, tbRecorder, teamStateOf, teamSwitch, tempProject, tempUserData, userSession,
  waitTeamIdle, writeRole, writeRoles,
} from './tb-helpers.mjs';

const args = suiteArgs('roles');
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4600;
const PROXY = 4601;
/** 合成端点上的两个模型（synthetic）：模型族不同、窗口不同 */
const MODEL_A = 'fake-roles-a';
const MODEL_B = 'fake-roles-b';
/** TB-03 两次运行发的同一条消息（合成端点按 plain 回一段文字） */
const V0_TEXT = 'plain hello for the v0 comparison';
const PLAIN = '这是一段只有文字的回复，用来测试流式输出。';
/** TaskBoard 的工具名（§6.3） */
const TEAM_TOOLS = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close'];
/** 关闭模式的对话段（附录 A）的第一句 */
const OFF_SENTENCE = SEGMENT_SENTENCES['off-dialog'];
/** pi 设置的默认工具（测试的数据目录没有设 defaultTools；file-system-permissions.md §8.6），排好序 */
const DEFAULT_TOOLS = ['bash', 'edit', 'read', 'write'];
/** 按席位给的职责工具（§8.6 的表：TaskBoard 工具与 memory；ask_user_question 在用户会话里一直启用，§10.1） */
const DUTY_TOOLS = [...TEAM_TOOLS, 'memory', 'ask_user_question'];
/** 立项、结案越界时的拒绝原文（file-system-permissions.md §8.3 的开头加 §8.4 的规则文字） */
const NARROWED = { create: 'Not allowed while deciding requests: no file changes or commands.',
  close: 'Not allowed while closing a request: no file changes or commands.' };
/** instances 一步的项目里马上列出工具的合成 MCP 服务的名字与它的一个工具（tests/mcp-server/server.mjs） */
const MCP_SERVER = 'srv';
const MCP_ECHO = `mcp__${MCP_SERVER}__echo`;

// ---------- 小工具 ----------

/** 显示着的会话面板 */
const SHOWN_PANE = '.pane-slot:not([hidden]) [data-testid="chat-pane"]';
/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
/** @brief 会话文件里 pi 消息的文字。 */
const textOfMessage = (message) => contentText(message?.content);
/** @brief 会话文件里某个工具的工具结果（toolResult 消息），按顺序。 */
const toolResults = (entries, tool) => messagesOf(entries)
  .filter((m) => m.role === 'toolResult' && m.toolName === tool);
/** @brief 一个请求里某个工具的定义（请求体 tools 的一项）。 */
const toolDef = (request, name) => (request?.body.tools ?? [])
  .find((tool) => (tool.function?.name ?? tool.name) === name);

/**
 * @brief 记录代理收到的、since 之后的对话请求里的第一个（不按脚本筛：关闭模式下 v0 对照的请求没有脚本）。
 * @return scenarioRequests 的一项；没有时为 undefined
 */
const firstChat = (ctx, since) => scenarioRequests(ctx.ep, null, { since })[0];

/**
 * @brief 等某个会话面板有 n 条回复且不在生成、发送（不读 TeamState：对照构建没有它）。
 * @return 等到时为 true
 */
const waitReplies = (ctx, tab, n, timeout = 60000) => poll(async () => {
  const pane = await paneState(ctx.page, tab);
  return pane && pane.assistants.length >= n && !pane.running && !pane.sending;
}, timeout);

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the team of ${who.tab} did not become idle`);
}

/** @brief 一个会话面板的标识与会话 id、会话文件。 */
async function whoOf(ctx, tab) {
  return { tab, ...(await userSession(ctx, tab)) };
}

/** @brief 目录下的全部文件（递归，相对路径）；目录不存在时为 []。 */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((item) => item.isFile())
    .map((item) => relative(dir, join(item.parentPath ?? item.path, item.name)));
}

/**
 * @brief 工具页“内置工具”一节此刻的行（跟随 tab 这个会话：先让它显示出来、有焦点），读完点“Back to app”。
 * @return { rows（m6-tools-helpers toolRows：name、active、tag、state、desc）, follow（跟随的会话的文字） }
 */
async function toolsPage(ctx, tab) {
  await showTab(ctx, tab);
  await openToolsSection(ctx.page, 'builtin');
  const rows = await toolRows(ctx.page);
  const follow = await ctx.page.getByTestId('tools-follow').textContent();
  await ctx.page.locator('[data-testid="tools-page"] .topbar button', { hasText: 'Back to app' }).click();
  await ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 10000 });
  return { rows, follow };
}

/** @brief 对话流里 TaskBoard 才有的元素：回执、进展摘要、Stop team 按钮的个数。 */
async function teamElements(ctx, tab) {
  const count = (css) => ctx.page.locator(`${paneSel(tab)} ${css}`).count();
  return { receipts: (await receiptsOf(ctx, tab)).length, progress: (await progressOf(ctx, tab)).length,
    stopTeam: await count('[data-testid="stop-team"]') };
}

// ---------- 准备 ----------

/** @brief 测试准备（synthetic test setup）：数据目录的两个提供商与档案、合成端点与记录代理，启动本构建的 App。 */
async function setup(ctx) {
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  const providers = [
    tbProvider('tba', PROXY, [tbModel(MODEL_A, { family: 'fam-a', contextWindow: 128000 })]),
    tbProvider('tbb', PROXY, [tbModel(MODEL_B, { family: 'fam-b', contextWindow: 256000 })]),
  ];
  ctx.p03 = tempProject('mori-tb-roles-v0-');
  ctx.pm = lateMcpProject(ctx);
  ctx.seed = { providers, normalDefault: 'tba', trusted: [ctx.pm] };
  seedTeamUserData(ctx.baseData, ctx.seed);
  seedTeamUserData(ctx.userData, ctx.seed);
}

/**
 * @brief TB-09 用的项目（synthetic test setup）：分开配置，项目 .pi/mcp.json 里一个直接调用方式的合成 MCP 服务 late，
 *        连上之后 8 秒才发 tools/list_changed、列出工具（会话打开之后才注册），收到的消息记进 ctx.mcpLog；
 *        数据目录里预先信任这个项目。
 */
function lateMcpProject(ctx) {
  const project = tempProject('mori-tb-roles-mcp-');
  writeRoles(project, SPLIT_ROLES);
  ctx.mcpLog = join(args.shots, `late-mcp-${Date.now()}.log`);
  mkdirSync(join(project, '.pi'), { recursive: true });
  const server = { command: 'node', args: [join(appRoot, 'tests', 'mcp-server', 'server.mjs')], exposure: 'direct',
    env: { MORI_MCP_LATE_TOOLS_MS: '8000', MORI_MCP_LOG: ctx.mcpLog } };
  writeFileSync(join(project, '.pi', 'mcp.json'), `${JSON.stringify({ mcpServers: { late: server } }, null, 2)}\n`);
  return project;
}

/**
 * @brief TB-09 instances 一步的 MCP 服务（synthetic test setup）：项目 .pi/mcp.json 里一个直接调用方式、马上列出工具的
 *        合成 MCP 服务 srv（工具 mcp__srv__echo），收到的消息记进返回的日志文件（项目要被信任才加载）。
 * @return 日志文件
 */
function writeEchoServer(project) {
  const log = join(args.shots, `echo-mcp-${Date.now()}.log`);
  mkdirSync(join(project, '.pi'), { recursive: true });
  const server = { command: 'node', args: [join(appRoot, 'tests', 'mcp-server', 'server.mjs')], exposure: 'direct',
    env: { MORI_MCP_LOG: log } };
  writeFileSync(join(project, '.pi', 'mcp.json'), `${JSON.stringify({ mcpServers: { [MCP_SERVER]: server } }, null,
    2)}\n`);
  return log;
}

/** @brief 启动本构建的 App（装上开关在“没准备好”时的记录，TB-53）。 */
async function startApp(ctx) {
  await startTbApp(ctx);
  await watchNotReady(ctx);
  await watchSeen(ctx);
  await watchEnvelopes(ctx);
}

/**
 * @brief 在页面里数各种元素出现过几次（window.__tbSeen[testid] = [{ t, tab }]，tab 为所在会话面板的 data-tab，
 *        不在面板里时为 null）：批准卡、扩展询问卡、信任询问、确认框。轮询会错过一闪而过的卡，所以用 MutationObserver。
 */
function watchSeen(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__tbSeen) return;
    const ids = ['approval-card', 'ext-ui-card', 'trust-dialog', 'confirm-dialog'];
    window.__tbSeen = Object.fromEntries(ids.map((id) => [id, []]));
    const known = new WeakSet();
    const scan = () => {
      for (const id of ids) {
        for (const el of document.querySelectorAll(`[data-testid="${id}"]`)) {
          if (known.has(el)) continue;
          known.add(el);
          const tab = el.closest('[data-testid="chat-pane"]')?.dataset.tab ?? null;
          window.__tbSeen[id].push({ t: Date.now(), tab });
        }
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
    scan();
  });
}

/** @brief watchSeen 记下的某种元素（since 之后）。 */
const seenOf = (ctx, id, since = 0) => ctx.page.evaluate(({ key, from }) => (window.__tbSeen?.[key] ?? [])
  .filter((item) => item.t >= from), { key: id, from: since });

/**
 * @brief 记下界面收到的每个进程桥事件的信封（window.__tbEnv：{ t, sid, type }，全部类型，不只 mori.*），
 *        用来核对界面收不到实例会话的事件（TB-43）。
 */
function watchEnvelopes(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__tbEnv) return;
    window.__tbEnv = [];
    window.mori.onEvent((envelope) => {
      window.__tbEnv.push({ t: Date.now(), sid: envelope.sessionId ?? null, type: envelope.event?.type ?? null });
    });
  });
}

/**
 * @brief 在页面里装一个记录器：任何会话面板显示“没准备好”（data-testid="not-ready"：正在启动、后台进程退出……）时，
 *        记下那一刻这一栏协作开关的 disabled 与文字（window.__tbNotReady，每项 { t, tab, text, disabled, switchText }）。
 */
function watchNotReady(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__tbNotReady) return;
    window.__tbNotReady = [];
    const scan = () => {
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const wait = pane.querySelector('[data-testid="not-ready"]');
        const sw = pane.querySelector('[data-testid="team-switch"]');
        if (!wait || !sw) continue;
        const item = { tab: pane.dataset.tab, text: wait.textContent, disabled: sw.disabled,
          switchText: sw.querySelector('.team-text')?.textContent ?? '' };
        const last = window.__tbNotReady.findLast((old) => old.tab === item.tab);
        if (last && last.text === item.text && last.disabled === item.disabled) continue;
        window.__tbNotReady.push({ t: Date.now(), ...item });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
    scan();
  });
}

// ---------- TB-03：关闭模式与 v0 一致 ----------

/**
 * @brief 对照构建（.tb-runs/base，TaskBoard 合入前最新的 app-v0 提交 2e67197）：同一份合成配置、
 *        同一个项目，发 V0_TEXT，记下发给模型的第一个请求与工具页的行。打包版（--exe）运行时对照仍用这个开发构建。
 */
async function base(ctx) {
  const dir = join(appRoot, '.tb-runs', 'base');
  if (!existsSync(join(dir, 'out', 'main', 'index.js'))) {
    throw new Error('no base build: run node tests/ui/tb-build-base.mjs');
  }
  const saved = process.env.MORI_APP_DIR;
  process.env.MORI_APP_DIR = dir;
  const bctx = { userData: ctx.baseData, exePath: null };
  try {
    await startTbApp(bctx);
    const tab = await openProject(bctx, ctx.p03);
    const since = Date.now();
    await sendMessage(bctx, tab, V0_TEXT);
    if (!(await waitReplies(bctx, tab, 1))) throw new Error('the base build did not reply');
    ctx.v0 = { request: firstChat(ctx, since), tools: await toolsPage(bctx, tab),
      reply: (await paneState(bctx.page, tab)).assistants.at(-1) };
  } finally {
    await closeTbApp(bctx);
    if (saved === undefined) delete process.env.MORI_APP_DIR;
    else process.env.MORI_APP_DIR = saved;
  }
  writeFileSync(join(args.shots, 'v0-base-request.json'), JSON.stringify(ctx.v0.request?.body ?? null, null, 2));
}

/** 关闭模式、有别的角色时用户会话 system prompt 的 mori_team 段（附录 A 关闭模式的对话段全文，§8.5） */
const OFF_SEGMENT = `${OFF_SENTENCE}\n`
  + 'If a request needs several kinds of work, you may suggest that the user sends it with /team.';

/** @brief 请求体里工具的名字。 */
const toolNames = (body) => (body?.tools ?? []).map((tool) => tool.function?.name ?? tool.name);

/**
 * 对照构建（v0）之后用户会话多出来的工具：记忆的 memory（docs/specs/memory.md §7、§14.4）与提问的 ask_user_question
 * （file-system-permissions.md §10.1：用户会话一直启用它；file-system.md §19.4 的 TB-03 一行）
 */
const NEW_TOOLS = ['memory', 'ask_user_question'];
/** @brief 请求体的工具定义去掉 memory 与 ask_user_question（TB-03 在全部比较之前去掉它们）。 */
const withoutNewTools = (body) => (body?.tools ?? []).filter((tool) => !NEW_TOOLS.includes(tool.function?.name
  ?? tool.name));
/** @brief 工具页的行去掉 memory 与 ask_user_question 那两行。 */
const withoutNewRows = (rows) => rows.filter((row) => !NEW_TOOLS.includes(row.name));

/**
 * @brief system prompt 去掉开头的身份段（记忆规格 §14.4）：从第一个 <addendum>、<project_context>、<skills> 或 <cwd>
 *        段开始取（新版之前是 Mori 的身份段，对照版是 pi 的身份句、<tools>、<rules>、<docs>）；找不到时为 null。
 */
function afterIdentity(system) {
  const at = system?.search(/\n\n<(addendum|project_context|skills|cwd)>\n/) ?? -1;
  return at < 0 ? null : system.slice(at);
}

/** @brief 去掉记忆的四个分节 taste、strategy、review、facts（记忆规格 §5.2、§14.4）。 */
const withoutMemorySections = (text) => text?.replace(/\n\n<(taste|strategy|review|facts)>\n[\s\S]*?\n<\/\1>/g, '')
  ?? null;

/** @brief TB-03 比较用的 system prompt：去掉身份段与记忆的四个分节。 */
const comparable = (system) => withoutMemorySections(afterIdentity(system));

/**
 * @brief 装在本构建位置的 v0 会发的 system prompt：pi 的 system prompt 写着它自己文档的路径（pi 包所在的
 *        node_modules）。对照构建是开发构建（app/node_modules），打包版（--exe）的 pi 在 resources/app.asar/node_modules，
 *        所以打包版运行时把对照里的这个路径前缀换成打包版的；只换这一处，其余逐字节比较。
 * @param ctx 套件上下文（ctx.v0 为对照构建的结果，ctx.exePath 为打包版路径或 null）
 * @return 对照的 system prompt
 */
function baseSystem(ctx) {
  const system = ctx.v0.request.system;
  if (!ctx.exePath) return system;
  const dev = join(appRoot, 'node_modules') + sep;
  const packaged = join(dirname(ctx.exePath), 'resources', 'app.asar', 'node_modules') + sep;
  return system.split(dev).join(packaged);
}

/**
 * @brief 本构建跑同一个关闭模式的会话，与对照构建比较（TB-03）；再写一个 executor.md、新开会话，比较多出来的部分。
 *        两次用同一个项目文件夹（system prompt 里的 <cwd> 相同），pi 的 system prompt 里没有日期、数据目录这类
 *        每次运行不同的内容，所以请求体逐字节比较；例外是打包版的安装位置（baseSystem），以及记忆规格 §14.4 去掉的
 *        memory 工具、身份段与记忆分节（comparable）。
 */
async function v0same(ctx) {
  if (!ctx.v0?.request) throw new Error('the base build gave no request to compare with');
  const tab = await openProject(ctx, ctx.p03);
  const since = Date.now();
  await sendMessage(ctx, tab, V0_TEXT);
  if (!(await waitReplies(ctx, tab, 1))) throw new Error('no reply in the TaskBoard build');
  const who = { ...(await whoOf(ctx, tab)), since };
  const request = firstChat(ctx, since);
  const tools = await toolsPage(ctx, tab);
  await v0Compare(ctx, who, request, tools);
  writeRole(ctx.p03, { name: 'executor', description: 'Changes code and runs commands to finish a task' });
  const tab2 = await newSession(ctx);
  const since2 = Date.now();
  await sendMessage(ctx, tab2, V0_TEXT);
  if (!(await waitReplies(ctx, tab2, 1))) throw new Error('no reply with executor.md');
  const who2 = await whoOf(ctx, tab2);
  await v0Roles(ctx, who2, firstChat(ctx, since2), await toolsPage(ctx, tab2));
  ctx.v0Sessions = { none: who, executor: who2 };
}

/** @brief TB-03 没有角色文件：请求、工具页、没有实例与 teams 文件、对话流；TB-02 没有文件时全是 mori。 */
async function v0Compare(ctx, who, request, tools) {
  const base = ctx.v0.request;
  const kept = withoutNewTools(request?.body);
  const system = comparable(request?.system);
  record('TB-03 off mode without role files: the tool list sent to the model is byte-identical to v0 (the pre-'
    + 'TaskBoard build, same project and config) once memory and ask_user_question are left out, and so is the system '
    + 'prompt after the identity part with the taste, strategy, review and facts sections left out (memory spec §14.4, '
    + 'file-system spec §10.1)',
  request !== undefined && JSON.stringify(kept) === JSON.stringify(base.body.tools)
    && system !== null && system === comparable(baseSystem(ctx)),
  brief({ tools: toolNames(request?.body), baseTools: toolNames(base.body), system: system?.length,
    baseSystem: comparable(baseSystem(ctx))?.length, head: request?.system.slice(0, 60) }));
  const rows = withoutNewRows(tools.rows);
  record('TB-03 off mode without role files: the Tools page rows (name, source, on/off, description) are the same as '
    + 'in v0 once the memory and ask_user_question rows are left out (memory spec §14.4, file-system spec §10.1)',
  rows.length > 0 && same(rows, ctx.v0.tools.rows),
  brief({ tb: tools.rows.map((row) => `${row.name}|${row.tag}|${row.state}`),
    v0: ctx.v0.tools.rows.map((row) => `${row.name}|${row.tag}|${row.state}`) }));
  const files = filesUnder(join(ctx.userData, 'teams'));
  record('TB-03 off mode without role files: no instance is created (no instance session, the endpoint got exactly '
    + 'one request for the message) and there is no file under <userData>/teams',
  files.length === 0 && instanceFiles(ctx, who.sessionId).length === 0
    && scenarioRequests(ctx.ep, null, { since: who.since }).length === 1, brief({ files }));
  const pane = await paneState(ctx.page, who.tab);
  const sw = await teamSwitch(ctx, who.tab);
  const extra = await teamElements(ctx, who.tab);
  record('TB-03 off mode without role files: the reply is the same as v0, the switch reads "Team: Off" and there is '
    + 'no receipt, progress summary or Stop team', pane.assistants.at(-1) === ctx.v0.reply
    && ctx.v0.reply === PLAIN && sw.text === 'Team: Off' && sw.mode === 'off' && same(extra,
    { receipts: 0, progress: 0, stopTeam: 0 }), brief({ reply: pane.assistants.at(-1), sw, extra }));
  const team = await teamStateOf(ctx, who.sessionFile);
  record('TB-02 no role files: every seat is held by mori (TeamState.holders) and no role besides the base',
    same(team?.holders, { dialog: 'mori', create: 'mori', close: 'mori' }) && same(team.roles, []), brief(team));
}

/** @brief TB-03 有别的角色（只有 executor.md）：只多 agent_message 与它的说明段；工具页列出 TaskBoard 工具、来源 Mori。 */
async function v0Roles(ctx, who, request, tools) {
  const base = ctx.v0.request;
  const kept = withoutNewTools(request?.body);
  const names = kept.map((tool) => tool.function?.name ?? tool.name);
  const extraTool = toolDef(request, 'agent_message');
  const rest = kept.filter((tool) => tool !== extraTool);
  const system = comparable(request?.system);
  const v0System = comparable(baseSystem(ctx));
  const added = system !== null && v0System !== null && system.startsWith(v0System)
    ? system.slice(v0System.length) : null;
  record('TB-03 off mode with another role (executor.md): with memory and ask_user_question left out (memory spec '
    + '§14.4, file-system spec §10.1) the request '
    + 'differs from v0 only by agent_message — the tool list is the v0 list plus the agent_message definition (with '
    + 'its description) at the end, and the system prompt after the identity part (without the memory sections) is '
    + 'the v0 one plus the mori_team section holding the off-mode dialog segment that explains it',
  JSON.stringify(rest) === JSON.stringify(base.body.tools) && names.at(-1) === 'agent_message'
    && Boolean(extraTool?.function?.description) && added === `\n\n<mori_team>\n${OFF_SEGMENT}\n</mori_team>`,
  brief({ names, added }));
  const rows = withoutNewRows(tools.rows);
  const mori = rows.filter((row) => row.tag === 'Mori');
  const others = rows.filter((row) => row.tag !== 'Mori');
  const userTools = TEAM_TOOLS.filter((name) => !['task_handoff', 'request_close'].includes(name));
  record('TB-03 off mode with another role: with the memory and ask_user_question rows left out, the Tools page lists '
    + 'the TaskBoard tools of '
    + 'the user session (board_read … reply_via_dialog) with source "Mori" — only agent_message on — and every other '
    + 'row is the same as in v0',
  same(mori.map((row) => row.name).sort(), [...userTools].sort())
    && mori.every((row) => (row.name === 'agent_message') === (row.active === 'true'))
    && same(others, ctx.v0.tools.rows), brief(tools.rows.map((row) => `${row.name}|${row.tag}|${row.state}`)));
  const team = await teamStateOf(ctx, who.sessionFile);
  record('TB-02 only executor.md: every seat is held by mori and the only role file is executor',
    same(team?.holders, { dialog: 'mori', create: 'mori', close: 'mori' })
    && same(team.roles.map((role) => role.name), ['executor']), brief(team));
  record('TB-03 off mode with another role: still no instance and no file under <userData>/teams',
    filesUnder(join(ctx.userData, 'teams')).length === 0 && instanceFiles(ctx, who.sessionId).length === 0,
    brief(filesUnder(join(ctx.userData, 'teams'))));
}


// ---------- TB-53：协作开关 ----------

/** 三种模式的文字与悬停（§13.1；<create role> 为基座时显示 Mori） */
const SWITCH = {
  off: { text: 'Team: Off', checked: 'false', title: 'Turn on team mode' },
  always: { text: 'Team: On', checked: 'true', title: (role) => `Messages go to ${role} first` },
  once: { text: 'Team: Until done', checked: 'true', title: 'Team mode ends when open requests are done' },
};

/** @brief 开关此刻是不是 mode 的样子（文字、读屏名称、aria-checked、悬停、data-mode、role="switch"）。 */
async function switchIs(ctx, tab, mode, createRole = 'Mori') {
  const sw = await teamSwitch(ctx, tab);
  const role = await ctx.page.locator(`${paneSel(tab)} [data-testid="team-switch"]`).getAttribute('role');
  const want = SWITCH[mode];
  const title = typeof want.title === 'function' ? want.title(createRole) : want.title;
  return { ok: sw.mode === mode && sw.text === want.text && sw.label === want.text && sw.checked === want.checked
    && sw.title === title && role === 'switch' && !sw.disabled, sw };
}

/** @brief 点开关，等 data-mode 变成 want；返回 switchIs 的结果。 */
async function clickTo(ctx, tab, want, createRole = 'Mori') {
  const sel = `${paneSel(tab)} [data-testid="team-switch"]`;
  await ctx.page.locator(sel).click();
  await ctx.page.waitForFunction(({ css, mode }) => document.querySelector(css)?.dataset.mode === mode,
    { css: sel, mode: want }, { timeout: 10000 }).catch(() => {});
  return switchIs(ctx, tab, want, createRole);
}

/**
 * @brief 合并会话（没有角色文件，脚本 tb-roles-switch）：三种文字与悬停、aria-checked、三种点击（off → always，
 *        always → off / once，once → always）、不需要确认；最后撤销需求回到 off。
 */
async function switches(ctx) {
  const project = tempProject('mori-tb-roles-switch-');
  const tab = await openProject(ctx, project);
  const who = await whoOf(ctx, tab);
  const since = Date.now();
  const off0 = await switchIs(ctx, tab, 'off');
  const on1 = await clickTo(ctx, tab, 'always');
  const off1 = await clickTo(ctx, tab, 'off');
  await sendMessage(ctx, tab, 'Pick a file tb-scenario:tb-roles-switch', { team: true });
  const once = await poll(async () => ((await teamSwitch(ctx, tab)).mode === 'once'), 10000);
  const once1 = await switchIs(ctx, tab, 'once');
  await settle(ctx, who, 90000);
  const onceIdle = await switchIs(ctx, tab, 'once');
  const on2 = await clickTo(ctx, tab, 'always');
  const once2 = await clickTo(ctx, tab, 'once');
  const board = readBoard(ctx, who.sessionId);
  const confirms = await seenOf(ctx, 'confirm-dialog', since);
  record('TB-53 the switch is role="switch" with the three texts, hovers and aria-checked: "Team: Off" / "Turn on '
    + 'team mode" / false; "Team: On" / "Messages go to Mori first" / true (base holds create); "Team: Until done" / '
    + '"Team mode ends when open requests are done" / true; the screen-reader name is the full text',
  off0.ok && on1.ok && once1.ok && onceIdle.ok, brief({ off0: off0.sw, on1: on1.sw, once1: once1.sw }));
  record('TB-53 the three clicks: off → always; always → off when nothing is open; once → always; always → once '
    + 'while request 1 is open (T1 waits for your decision); no confirmation dialog for any click',
  on1.ok && off1.ok && once && on2.ok && once2.ok && confirms.length === 0
    && board?.requests[0]?.status === 'open', brief({ off1: off1.sw, on2: on2.sw, once2: once2.sw,
    request: board?.requests[0]?.status, confirms }));
  await sendMessage(ctx, tab, 'Cancel it');
  await settle(ctx, who, 60000);
  const back = await switchIs(ctx, tab, 'off');
  record('TB-53 after the request is cancelled in "Team: Until done", the switch goes back to "Team: Off" by itself',
    back.ok && readBoard(ctx, who.sessionId)?.requests[0]?.status === 'cancelled', brief(back.sw));
  await narrow(ctx, tab);
}

/**
 * @brief 窄栏（这一栏不宽于 600px，§15；composer-pickers 合入后由 860px 改为 600px）：右栏打开、把这一栏调到 601px 和
 *        600px（阈值的两边）。601px 时完整文字、没有状态点；600px 时只显示状态点（off 空心、always 实心），不显示文字，
 *        读屏名称与悬停仍是完整文字。之后关掉右栏、回到 1200 宽窗口。
 */
async function narrow(ctx, tab) {
  const pane = ctx.page.locator(paneSel(tab));
  const width = () => pane.evaluate((el) => el.getBoundingClientRect().width);
  await fitPane(ctx, 601, { right: true });
  const wide = await switchLook(ctx, tab);
  const wideWidth = await width();
  await fitPane(ctx, 600, { right: true });
  const narrowWidth = await width();
  const offLook = await switchLook(ctx, tab);
  await clickTo(ctx, tab, 'always');
  const onLook = await switchLook(ctx, tab);
  await clickTo(ctx, tab, 'off');
  await shot(ctx, args, 'narrow-switch');
  record('TB-53 in a pane 600px wide or narrower the switch shows only a status dot (hollow for off, filled for on) '
    + 'and no text, and its screen-reader name and hover keep the full text; a 601px pane shows the full text and no '
    + 'dot', Math.abs(narrowWidth - 600) < 0.5 && Math.abs(wideWidth - 601) < 0.5 && wide.text
    && wide.shown === 'Team: Off' && !wide.dot
    && !offLook.text && offLook.shown === '' && offLook.dot && !offLook.filled && offLook.label === 'Team: Off'
    && offLook.title === 'Turn on team mode' && !onLook.text && onLook.shown === '' && onLook.dot && onLook.filled
    && onLook.label === 'Team: On', brief({ wideWidth, narrowWidth, wide, offLook, onLook }));
  await fitPane(ctx, 930);
  await resizeWindow(ctx.app, 1200, 800);
}

/** @brief 开关此刻显示的部分：完整文字是否可见、看得到的文字、状态点是否可见与是否实心、读屏名称与悬停。 */
function switchLook(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="team-switch"]`).evaluate((el) => {
    const shown = (node) => Boolean(node) && getComputedStyle(node).display !== 'none'
      && node.getClientRects().length > 0;
    const dot = el.querySelector('.team-dot');
    const fill = dot ? getComputedStyle(dot).backgroundColor : '';
    return { text: shown(el.querySelector('.team-text')), shown: el.innerText.trim(), dot: shown(dot),
      filled: Boolean(fill) && fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent',
      label: el.getAttribute('aria-label'), title: el.getAttribute('title') };
  });
}

// ---------- TB-01：角色文件校验 ----------

/** @brief 问题行里的文件（相对项目根）。 */
const agentFile = (name) => `.mori/agents/${name}`;
/** @brief 一个角色文件的 frontmatter 加正文。 */
const roleText = (header, body = 'Role body.') => `---\n${header}\n---\n${body}\n`;
/** 改好之后的角色文件：planner 认领立项与结案（Check again 之后按新的角色） */
const PLANNER_FILE = roleText('name: planner\ndescription: Plans the work\nseats: [create, close]');

/**
 * @brief YAML 读不出时卡上的原文：pi 导出的 parseFrontmatter（本测试按 pi 1.3.0 包里的文件路径载入同一个函数）
 *        抛出的错误的第一行（去掉末尾的冒号，§4.4 一条只写一行）。
 */
async function yamlError(text) {
  const file = join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js');
  const { parseFrontmatter } = await import(pathToFileURL(file).href);
  try {
    parseFrontmatter(text);
    return null;
  } catch (error) {
    const line = String(error.message).split(/\r?\n/).find((item) => item.trim()) ?? '';
    return line.trim().replace(/:$/, '');
  }
}

/**
 * @brief §4.4 表的每一行（每种写法一项）：要写的文件（文件名 → 全文）与卡上应有的那一行。
 *        a-first.md 先于 bad.md 读到（按文件名），所以重复与认领的问题记在 bad.md 上。
 */
async function problemRows() {
  const d = 'description: A role';
  const bad = agentFile('bad.md');
  const yaml = roleText('name: [unclosed\ndescription: x');
  return [
    { row: 'header: YAML error', files: { 'bad.md': yaml },
      line: `${bad}: can’t read the header: ${await yamlError(yaml)}` },
    { row: 'header: no frontmatter', files: { 'bad.md': 'Just a body without a header.\n' },
      prefix: `${bad}: can’t read the header: ` },
    { row: 'unknown field', files: { 'bad.md': roleText(`name: bad\n${d}\ncolor: blue`) },
      line: `${bad}: unknown field "color"` },
    { row: 'missing description', files: { 'bad.md': roleText('name: bad') }, line: `${bad}: description is required` },
    { row: 'missing name', files: { 'bad.md': roleText(d) }, line: `${bad}: name is required` },
    { row: 'bad name value', files: { 'bad.md': roleText(`name: Bad_Name\n${d}`) },
      line: `${bad}: name must use lowercase letters, digits and - (at most 40, not starting with -)` },
    { row: 'name already used', files: { 'a-first.md': roleText(`name: twin\n${d}`),
      'bad.md': roleText(`name: twin\n${d}`) },
    line: `${bad}: name "twin" is already used by ${agentFile('a-first.md')}` },
    { row: 'name reserved', files: { 'bad.md': roleText(`name: mori\n${d}`) },
      line: `${bad}: name "mori" is reserved for the base agent` },
    { row: 'name like a number', files: { 'bad.md': roleText(`name: t12\n${d}`) },
      line: `${bad}: name "t12" looks like a task or request number` },
    { row: 'unknown seat', files: { 'bad.md': roleText(`name: bad\n${d}\nseats: [boss]`) },
      line: `${bad}: unknown seat "boss"` },
    { row: 'seat claimed twice', files: { 'a-first.md': roleText(`name: first\n${d}\nseats: [create]`),
      'bad.md': roleText(`name: bad\n${d}\nseats: [create]`) },
    line: `${bad}: seat "create" is also claimed by ${agentFile('a-first.md')}` },
    // 角色文件不再有 tools（file-system-permissions.md §8.6）：写了它按未知字段（file-system.md §19.4 的 TB-01 一行）
    { row: 'tools field', files: { 'bad.md': roleText(`name: bad\n${d}\ntools: [read]`) },
      line: `${bad}: unknown field "tools"` },
    { row: 'models not in settings', files: { 'bad.md': roleText(`name: bad\n${d}\nmodels: [tba, nosuch]`) },
      line: `${bad}: "nosuch" is not in your model settings (models[1])` },
    { row: 'unknown requirement', files: { 'bad.md': roleText(`name: bad\n${d}\nrequires: [telepathy]`) },
      line: `${bad}: unknown requirement "telepathy"` },
    { row: 'context>=N not positive', files: { 'bad.md': roleText(`name: bad\n${d}\nrequires: [context>=0]`) },
      line: `${bad}: unknown requirement "context>=0"` },
    { row: 'differ_from', files: { 'bad.md': roleText(`name: bad\n${d}\ndiffer_from: reviewer`) },
      line: `${bad}: differ_from can only be "author"` },
    { row: 'unknown moment', files: { 'bad.md': roleText(`name: bad\n${d}\nsubscribe: [request_opened]`) },
      line: `${bad}: unknown moment "request_opened"` },
    { row: 'unknown filter', files: { 'bad.md': roleText(`name: bad\n${d}\nsubscribe:\n  - request_closed:\n`
      + '      color: red') }, line: `${bad}: unknown filter "color"` },
  ];
}

/** @brief 把项目的 .mori/agents 换成 files（文件名 → 全文）。 */
function putAgentFiles(project, files) {
  const dir = join(project, '.mori', 'agents');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

/** @brief 这个会话面板的拒绝启动卡：{ kind, title, problems, actions（按钮文字）, disabled（各按钮） }；没有时为 null。 */
function blockedCard(ctx, tab) {
  return ctx.page.locator(paneSel(tab)).evaluate((pane) => {
    const card = pane.querySelector('[data-testid="blocked-card"]');
    if (!card) return null;
    const buttons = [...card.querySelectorAll('.model-card-actions button')];
    return { kind: card.dataset.kind, title: card.querySelector('.model-card-title')?.textContent ?? '',
      problems: [...card.querySelectorAll('[data-testid="agent-problem"]')].map((el) => el.textContent),
      actions: buttons.map((el) => el.textContent), disabled: buttons.map((el) => el.disabled),
      candidates: card.querySelectorAll('[data-testid="candidate"]').length };
  });
}

/** @brief 一行问题是否符合这一行的期望（line 完全相同，或 prefix 开头且后面还有原文）。 */
const rowMatches = (row, problems) => problems.length === 1 && (row.line !== undefined ? problems[0] === row.line
  : problems[0].startsWith(row.prefix) && problems[0].length > row.prefix.length);

/** @brief 点卡上的 Check again，等问题行变化（或卡消失），最多 15 秒。 */
async function checkAgain(ctx, tab) {
  const before = JSON.stringify(await blockedCard(ctx, tab));
  await ctx.page.locator(`${paneSel(tab)} [data-testid="blocked-card"] button[data-action="check-agents"]`).click();
  await poll(async () => JSON.stringify(await blockedCard(ctx, tab)) !== before, 15000);
  await sleep(300);
  return blockedCard(ctx, tab);
}

/**
 * @brief §4.4 表的每一行：第一行在新建会话时，其余各行改文件后点 Check again；每次都按 agents_invalid 拒绝启动、
 *        卡上只有那一行。然后模型层重新校验（换范围、改配置）时 agents_invalid 仍在；最后改好文件，Check again 解除，
 *        按新的角色重新打开（还没写盘的会话用同一个 id 重新建立）；F8 记下 Check agent files。
 */
async function files(ctx) {
  const rows = await problemRows();
  const project = tempProject('mori-tb-roles-files-');
  putAgentFiles(project, rows[0].files);
  const tab = await openProject(ctx, project);
  const who = await whoOf(ctx, tab);
  const seen = [];
  let card = await blockedCard(ctx, tab);
  for (const [index, row] of rows.entries()) {
    if (index > 0) {
      putAgentFiles(project, row.files);
      card = await checkAgain(ctx, tab);
    }
    const team = await teamStateOf(ctx, who.sessionFile);
    seen.push({ row: row.row, ok: card?.kind === 'agents_invalid' && card.title === 'Fix the agent files'
      && same(card.actions, ['Check again']) && card.candidates === 0 && rowMatches(row, card.problems)
      && same(team?.holders, { dialog: 'mori', create: 'mori', close: 'mori' }), problems: card?.problems });
  }
  const bad = seen.filter((item) => !item.ok);
  record(`TB-01 every row of the §4.4 table (${rows.length} ways to write it) makes the session refuse to start with `
    + 'agents_invalid: the card "Fix the agent files" lists exactly that row\'s line and offers only "Check again" '
    + '(the first at session creation, the rest after Check again); the session runs as base-only meanwhile',
  bad.length === 0 && seen.length === rows.length, brief(bad.length ? bad : seen.map((item) => item.problems[0])));
  const conflict = seen.find((item) => item.row === 'seat claimed twice');
  record('TB-02 two files claiming the same seat are refused: ".mori/agents/bad.md: seat "create" is also claimed by '
    + '.mori/agents/a-first.md"', conflict?.ok === true, brief(conflict));
  await blockedSending(ctx, who);
  await revalidate(ctx, who);
  await fixed(ctx, who, project);
}

/** @brief 拒绝启动时不能发送（Enter 不发出、草稿不丢），协作开关不可用（§13.1）。 */
async function blockedSending(ctx, who) {
  const since = Date.now();
  const box = ctx.page.locator(`${paneSel(who.tab)} .composer textarea`);
  await box.fill('plain while the agent files are wrong');
  await box.press('Enter');
  await sleep(1500);
  const pane = await paneState(ctx.page, who.tab);
  const sw = await teamSwitch(ctx, who.tab);
  record('TB-01 while agents_invalid the session cannot send: Enter sends nothing (no request reaches the endpoint, '
    + 'no user bubble) and the draft stays', scenarioRequests(ctx.ep, null, { since }).length === 0
    && pane.users.length === 0 && pane.draft === 'plain while the agent files are wrong', brief(pane));
  record('TB-53 the switch is not available while the session is refused with agents_invalid (§13.1)',
    sw.disabled === true && sw.text === 'Team: Off', brief(sw));
  await box.fill('');
}

/** @brief 模型层重新做静态校验（换选择范围、改模型配置）时 agents_invalid 仍在（§4.4）。 */
async function revalidate(ctx, who) {
  const since = Date.now();
  const pick = await bridge(ctx, { type: 'session.setPick', sessionId: who.sessionId, pick: 'tbb' });
  const group = await bridge(ctx, { type: 'models.saveGroup', id: 'tb-roles-group', members: ['tba', 'tbb'],
    creating: true });
  await poll(async () => (await kernelEvents(ctx, who.sessionId, 'mori.model_state', since)).length >= 2, 10000);
  const states = (await kernelEvents(ctx, who.sessionId, 'mori.model_state', since)).map((item) => item.data);
  const card = await blockedCard(ctx, who.tab);
  record('TB-01 when the model layer re-checks the session (session.setPick to another range, then a config change '
    + 'adding a group) every mori.model_state still has agents_invalid and the card stays "Fix the agent files"',
  pick?.blocked?.kind === 'agents_invalid' && !group?.error && states.length >= 2
    && states.every((state) => state.blocked?.kind === 'agents_invalid') && card?.kind === 'agents_invalid',
  brief({ pick: pick?.blocked?.kind ?? pick?.error, group: group?.error, states: states.map((s) => s.blocked?.kind),
    card: card?.title }));
}

/**
 * @brief 改好文件（换成 planner 认领立项与结案）后 Check again：卡消失，会话按新的角色重新打开（同一个 id），
 *        可以发送；F8 的最近操作里有 Check agent files。
 */
async function fixed(ctx, who, project) {
  putAgentFiles(project, { 'planner.md': PLANNER_FILE });
  const card = await checkAgain(ctx, who.tab);
  const after = await whoOf(ctx, who.tab).catch(() => null);
  const team = after ? await teamStateOf(ctx, after.sessionFile) : null;
  const since = Date.now();
  await sendMessage(ctx, who.tab, 'plain after the agent files are fixed');
  const replied = await waitReplies(ctx, who.tab, 1, 30000);
  record('TB-01 after the file is fixed, Check again clears the refusal and reopens the session with the new roles: '
    + 'no blocked card, the same session id, TeamState has planner holding create and close, and a message is sent '
    + 'and answered', card === null && after?.sessionId === who.sessionId
    && same(team?.holders, { dialog: 'mori', create: 'planner', close: 'planner' })
    && same(team.roles.map((role) => role.name), ['planner']) && replied
    && scenarioRequests(ctx.ep, null, { since }).length >= 1, brief({ card, after, team }));
  const actions = await recentActions(ctx, who.tab);
  record('TB-01 Check again is recorded in F8 as "Check agent files" (the saved report\'s recent actions)',
    actions.filter((line) => line.endsWith('Check agent files')).length >= 2, brief(actions.slice(-12)));
}

/** @brief 按 F8、写一句、保存，读保存的报告里“Recent activity”一节的各行。 */
async function recentActions(ctx, tab) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).press('F8');
  const dialog = ctx.page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill('TB-01 check of the recent actions');
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

// ---------- TB-01 各字段、TB-02 分开配置、TB-09 工具（脚本 tb-roles-fields） ----------

/** chat 的正文：几行、缩进、标点与中文，看它原样进 system prompt（§4.1、§8.5） */
const CHAT_BODY = 'You are chat: you talk with the user.\n\n  Indented line with <tags> & "quotes" — 中文也原样。\n'
  + '- first rule\n- second rule';

/**
 * proposal §6.2 的分开配置，再加一个订阅者；各角色写不同的字段，看每个字段都读出并生效（没有 tools 字段：
 * file-system-permissions.md §8.6）
 */
const FIELD_ROLES = [
  { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'], body: CHAT_BODY },
  { name: 'planner', description: 'Decides how to split each request and closes it', seats: ['create', 'close'],
    models: ['tbb'] },
  { name: 'executor', description: 'Changes code and runs commands to finish a task',
    models: ['tba', 'tbb'], requires: ['context>=200000'] },
  { name: 'reviewer', description: 'Checks the work of another role and reports pass or fail',
    differ_from: 'author', models: ['tbb', 'tba'] },
  { name: 'watcher', description: 'Keeps notes when a request closes', subscribe: ['request_closed'] },
];

/** @brief 一个角色文件的正文（pi 的读法：第二个 --- 之后，去掉首尾空白）。 */
function bodyOf(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return text.slice(text.indexOf('\n---', 3) + 4).trim();
}

/** @brief 某个会话（角色、种类、task）的请求（记录代理），按收到的顺序。 */
const requestsOf = (ctx, scenario, agent, kind, task) => scenarioRequests(ctx.ep, scenario, { agent, kind, task });
/** @brief 请求里的工具名，排好序。 */
const sortedTools = (request) => [...(request?.tools ?? [])].sort();
/** @brief 请求里碰文件的工具（去掉职责工具 DUTY_TOOLS），排好序。 */
const fileTools = (request) => sortedTools(request).filter((name) => !DUTY_TOOLS.includes(name));

/**
 * @brief 分开配置的整条路（脚本 tb-roles-fields）：先在关闭模式问一次，开关切到 always 再切回（悬停里的立项持有者），
 *        /team 登记 → executor 写 → reviewer 复核 → planner 结案 → watcher 订阅 → chat 汇报，回到关闭模式再问一次。
 */
async function fields(ctx) {
  const project = tempProject('mori-tb-roles-fields-');
  const roleFiles = writeRoles(project, FIELD_ROLES);
  const tab = await openProject(ctx, project);
  await allowAll(ctx, tab);
  const who = await whoOf(ctx, tab);
  const team = await teamStateOf(ctx, who.sessionFile);
  const on = await clickTo(ctx, tab, 'always', 'planner');
  const off = await clickTo(ctx, tab, 'off', 'planner');
  record('TB-02 the proposal §6.2 configuration (chat dialog, planner create + close, executor, reviewer) gives '
    + 'holders {dialog: chat, create: planner, close: planner}; the switch hover in Team: On reads "Messages go to '
    + 'planner first"', same(team?.holders, { dialog: 'chat', create: 'planner', close: 'planner' })
    && on.ok && off.ok, brief({ holders: team?.holders, on: on.sw.title }));
  record('TB-53 the hover names the create role of the session: "Messages go to planner first" when planner holds '
    + 'create', on.ok && on.sw.title === 'Messages go to planner first', brief(on.sw));
  await sendMessage(ctx, tab, 'Hello first tb-scenario:tb-roles-fields');
  await settle(ctx, who, 60000);
  await sendMessage(ctx, tab, 'Write the note tb-scenario:tb-roles-fields', { team: true });
  await settle(ctx, who, 150000);
  const modeAfter = (await teamSwitch(ctx, tab)).mode;
  await sendMessage(ctx, tab, 'Back in off mode');
  await settle(ctx, who, 60000);
  const obs = { team, roleFiles, modeAfter, board: readBoard(ctx, who.sessionId) };
  fieldNames(ctx, obs);
  fieldUse(ctx, who, obs);
  dialogTools(ctx, obs);
  createTools(ctx);
}

/**
 * @brief TB-01：合格的文件读出 name、description、seats（TeamState 与 next 枚举的说明）。tools 不再是字段
 *        （file-system.md §19.4 的 TB-01 一行：读出全部字段的检查去掉 tools）。
 */
function fieldNames(ctx, obs) {
  const exec = requestsOf(ctx, 'tb-roles-fields', 'executor', 'task', 'T1');
  const next = toolDef(exec[0], 'task_handoff')?.function?.parameters?.properties?.next;
  const lines = ['chat (dialog): Talks with the user and relays the team’s work',
    'planner (create, close): Decides how to split each request and closes it',
    'reviewer: Checks the work of another role and reports pass or fail', 'watcher: Keeps notes when a request closes'];
  const names = obs.team?.roles.map((role) => role.name);
  record('TB-01 a valid file reads name, description and seats: TeamState.roles lists every file\'s name and '
    + 'description, and executor\'s task_handoff "next" enum holds the other roles with "<name> (<seats>): '
    + '<description>"', same(names, ['chat', 'executor', 'planner', 'reviewer', 'watcher'])
    && FIELD_ROLES.every((role) => obs.team.roles.some((item) => item.name === role.name
      && item.description === role.description))
    && same([...(next?.enum ?? [])].sort(), ['chat', 'mori', 'planner', 'reviewer', 'watcher'])
    && lines.every((line) => next.description.includes(line)), brief({ roles: obs.team?.roles, next }));
}

/** @brief TB-01：models、requires、differ_from 决定各角色用的模型；subscribe 唤醒订阅者；正文原样进 system prompt。 */
function fieldUse(ctx, who, obs) {
  const sc = 'tb-roles-fields';
  const modelOf = (agent, kind) => [...new Set(scenarioLines(ctx.ep, sc, { agent, kind }).map((line) => line.model))];
  record('TB-01 a valid file reads models, requires and differ_from: planner (models [tbb]) runs on fake-roles-b while '
    + 'the dialog uses the session range (fake-roles-a); executor (models [tba, tbb], requires context>=200000) '
    + 'skips the 128000-token fake-roles-a and runs on fake-roles-b; reviewer (models [tbb, tba], differ_from: author) '
    + 'avoids the author\'s family fam-b and runs on fake-roles-a',
  same(modelOf('planner', 'create'), [MODEL_B]) && same(modelOf('planner', 'close'), [MODEL_B])
    && same(modelOf('chat', 'team-dialog'), [MODEL_A]) && same(modelOf('executor', 'task'), [MODEL_B])
    && same(modelOf('reviewer', 'task'), [MODEL_A]),
  brief({ planner: modelOf('planner', 'create'), close: modelOf('planner', 'close'),
    chat: modelOf('chat', 'team-dialog'), executor: modelOf('executor', 'task'),
    reviewer: modelOf('reviewer', 'task') }));
  const subs = instanceFiles(ctx, who.sessionId)
    .filter((file) => instanceSuffix(who.sessionId, file.id) === 'sub.1.watcher');
  record('TB-01 a valid file reads subscribe: watcher (subscribe [request_closed]) is woken in its own subscription '
    + 'session (sub.1.watcher) after request 1 closes', subs.length === 1
    && scenarioLines(ctx.ep, sc, { agent: 'watcher', kind: 'subscription' }).length === 1
    && obs.board?.requests[0]?.status === 'done', brief({ subs: subs.map((file) => file.id),
    status: obs.board?.requests[0]?.status, lines: scenarioLines(ctx.ep, sc, { agent: 'watcher' })
      .map((line) => `${line.kind} k=${line.k} j=${line.j}`) }));
  const body = (name) => bodyOf(obs.roleFiles[FIELD_ROLES.findIndex((role) => role.name === name)]);
  const chatReqs = scenarioRequests(ctx.ep, sc, { agent: 'chat' });
  const exec = requestsOf(ctx, sc, 'executor', 'task', 'T1');
  const create = requestsOf(ctx, sc, 'planner', 'create');
  record('TB-01 the body goes into the system prompt as written: chat\'s multi-line body (indentation, <tags>, '
    + 'quotes, Chinese) is in every request of the user session; executor\'s and planner\'s bodies are in their '
    + 'instance requests', chatReqs.length >= 4 && chatReqs.every((request) => request.system.includes(body('chat')))
    && body('chat').startsWith(CHAT_BODY) && exec.length > 0
    && exec.every((request) => request.system.includes(body('executor'))) && create.length > 0
    && create.every((request) => request.system.includes(body('planner'))), brief({ chat: chatReqs.length }));
}

/** 协作模式分开时对话会话的请求的工具（§8.6 的表：默认工具不动，职责工具为 board_read、read_session、agent_message） */
const TEAM_DIALOG_SET = [...DEFAULT_TOOLS, 'agent_message', 'ask_user_question', 'board_read', 'read_session'].sort();
/** 关闭模式、有别的角色时对话会话的请求的工具（§8.6 的表：agent_message、memory；记忆规格 §7.6） */
const OFF_DIALOG_SET = [...DEFAULT_TOOLS, 'agent_message', 'ask_user_question', 'memory'].sort();

/**
 * @brief TB-09：协作模式下对话会话碰文件的工具与关闭模式相同、只多职责工具（file-system.md §19.4 的 TB-09 一行），
 *        回到 off 后与之前相同；对话的工作卡带立项的决定与最后一段文字。用户会话在任何模式下都启用 ask_user_question
 *        （file-system-permissions.md §10.1），两种模式的集合里都有它。
 */
function dialogTools(ctx, obs) {
  const offReqs = requestsOf(ctx, 'tb-roles-fields', 'chat', 'off-dialog');
  const teamReqs = requestsOf(ctx, 'tb-roles-fields', 'chat', 'team-dialog');
  const first = offReqs.filter((request) => request.info.k === 1);
  const last = offReqs.filter((request) => request.info.k === 4);
  record('TB-09 in team mode the dialog session\'s requests have the same file tools as in off mode (read, bash, '
    + 'edit, write: file-system-permissions §8.6) and only the duty tools besides (board_read, read_session, '
    + 'agent_message, and ask_user_question, which the user session always has, §10.1); off mode before and after '
    + 'team mode has read, bash, edit, write, agent_message, memory (memory spec §7.6) and ask_user_question',
  teamReqs.length >= 2 && first.length === 1 && last.length === 1
    && teamReqs.every((request) => same(sortedTools(request), TEAM_DIALOG_SET)
      && same(fileTools(request), fileTools(first[0])))
    && same(sortedTools(first[0]), OFF_DIALOG_SET) && same(sortedTools(last[0]), OFF_DIALOG_SET)
    && same(fileTools(first[0]), DEFAULT_TOOLS) && obs.modeAfter === 'off',
  brief({ team: teamReqs.map(sortedTools), off1: first.map(sortedTools), off4: last.map(sortedTools),
    mode: obs.modeAfter }));
  const card = teamReqs.find((request) => request.info.k === 2);
  const lastUser = card?.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)).at(-1) ?? '';
  const want = `For this message planner decided: new request (Request 1); their note: "${ROLES_TEXT.fieldsNote}"`;
  record('TB-09 the dialog\'s work card (the last message of its request) carries planner\'s decision and last text: '
    + `"${want}"`, lastUser.startsWith('<mori-work-card>') && lastUser.includes(want), brief(lastUser));
}

/** 分开时立项实例的工具：默认工具 + 立项的 TaskBoard 工具 + memory（§8.6 instanceTools；记忆规格 §7.6） */
const CREATE_SET = [...DEFAULT_TOOLS, 'agent_message', 'board_read', 'memory', 'read_session', 'reply_via_dialog',
  'request_cancel', 'request_submit', 'request_update', 'task_create', 'task_edit'].sort();
/** 结案实例的工具：默认工具 + 结案的 TaskBoard 工具（§8.6 instanceTools） */
const CLOSE_SET = [...DEFAULT_TOOLS, 'agent_message', 'board_read', 'read_session', 'request_close',
  'task_handoff'].sort();
/** task 实例的工具：默认工具 + task 的 TaskBoard 工具，不随 task 的 limits 变（§8.6 instanceTools） */
const TASK_SET = [...DEFAULT_TOOLS, 'agent_message', 'board_read', 'read_session', 'task_handoff'].sort();

/**
 * @brief TB-09：立项、结案会话的请求里是默认工具与它们的 TaskBoard 工具（这个项目没有 MCP 服务；file-system.md §19.4
 *        的 TB-09 一行，碰文件的工具不再只留读取类）。
 */
function createTools(ctx) {
  const create = requestsOf(ctx, 'tb-roles-fields', 'planner', 'create');
  const close = requestsOf(ctx, 'tb-roles-fields', 'planner', 'close');
  record('TB-09 the create and close sessions\' requests have the default tools (read, bash, edit, write; this project '
    + 'has no MCP server) and their TaskBoard tools: create + board_read, read_session, agent_message, request_*, '
    + 'task_create, task_edit, reply_via_dialog + memory (memory spec §7.6); close + board_read, read_session, '
    + 'agent_message, task_handoff, request_close (file-system-permissions §8.6)', create.length > 0
    && create.every((request) => same(sortedTools(request), CREATE_SET)) && close.length > 0
    && close.every((request) => same(sortedTools(request), CLOSE_SET)),
  brief({ create: sortedTools(create[0]), close: sortedTools(close[0]) }));
}

// ---------- TB-09：立项、结案与对话越界的调用（通用场景 fs-team） ----------

/** seatLimits 里各会话想写出的文件（都不该出现） */
const LIMIT_FILES = { create: 'made-by-create.txt', close: 'made-by-close.txt', closeBash: 'made-by-close-bash.txt',
  dialog: 'made-by-dialog.txt' };
/** @brief 改 README.md 标题的 edit 调用（关键词 calls: 的一项）。 */
const editReadme = (by) => ({ name: 'edit', args: { path: 'README.md',
  edits: [{ oldText: 'Mori fixture project', newText: `Changed by ${by}` }] } });
/** @brief 写出 file 的 bash 调用。 */
const bashTo = (file) => ({ name: 'bash', args: { command: `echo changed > ${file}` } });
/** @brief 写 file 的 write 调用。 */
const writeTo = (file) => ({ name: 'write', args: { path: file, content: 'changed\n' } });
/** @brief 关键词的 calls: 一步（replies.mjs fsActionReply：一个回复里依次做这些调用）。 */
const callsStep = (calls) => `calls: ${JSON.stringify(calls)}`;

/**
 * seatLimits 的 /team 消息（scenarios/fs.mjs 的 fs-team，synthetic）：立项登记需求 1 与 T1（executor 读 README），
 * 再 edit、bash；对话 bash、edit；T1 读后交接；结案 write、bash 后关闭。第一行是普通的一句话，key 都不在最后一行。
 */
const LIMITS_MESSAGE = `Check what each seat may do\n${teamMessage([
  ['fs-call', 'call tool: read {"path":"README.md"}'],
  ['fs-create', callsStep([editReadme('create'), bashTo(LIMIT_FILES.create)])],
  ['fs-dialog', callsStep([bashTo(LIMIT_FILES.dialog), editReadme('dialog')])],
  ['fs-close', callsStep([writeTo(LIMIT_FILES.close), bashTo(LIMIT_FILES.closeBash)])],
])}`;

/** @brief 一个会话文件里这些工具的结果：[{ tool, error, text（去掉证据编号） }]，按顺序。 */
function resultsFor(entries, tools) {
  return messagesOf(entries).filter((m) => m.role === 'toolResult' && tools.includes(m.toolName))
    .map((m) => ({ tool: m.toolName, error: m.isError === true, text: textOfMessage(m).replace(/^\[#\d+\] ?/, '') }));
}

/** @brief tools 每个都至少有一个结果，而且每个结果都是 isError、原文为 text。 */
const refusedAll = (results, tools, text) => tools.every((tool) => results.some((item) => item.tool === tool))
  && results.every((item) => item.error && item.text === text);

/**
 * @brief TB-09（file-system.md §19.4 的 TB-09 一行）：分开配置、权限为“每次询问”，/team 发 LIMITS_MESSAGE：立项、结案
 *        调用写入与命令得到它们的拒绝原文（程序给的收窄 { write: false }），对话调用 bash、edit 得到 RELAY_ONLY（对话会话
 *        的收窄 { write: false, mcp: false }，file-system-permissions.md §8.3）；文件不变、没有卡。对话调用 MCP 的一半在
 *        lateMcp，立项、结案请求里的 MCP 工具在 instances。
 */
async function seatLimits(ctx) {
  const project = tempProject('mori-tb-roles-limits-');
  writeRoles(project, SPLIT_ROLES);
  const readme = readFileSync(join(project, 'README.md'), 'utf8');
  const tab = await openProject(ctx, project);
  const who = await whoOf(ctx, tab);
  const since = Date.now();
  await sendMessage(ctx, tab, LIMITS_MESSAGE, { team: true });
  await settle(ctx, who, 150000);
  const entriesOf = (suffix) => instanceFiles(ctx, who.sessionId)
    .find((file) => instanceSuffix(who.sessionId, file.id) === suffix)?.entries ?? [];
  const obs = { cards: await seenOf(ctx, 'approval-card', since),
    create: resultsFor(entriesOf('create'), ['edit', 'bash']),
    close: resultsFor(entriesOf('close.1'), ['write', 'bash']),
    dialog: resultsFor(readJsonl(who.sessionFile).slice(1), ['bash', 'edit']),
    untouched: readFileSync(join(project, 'README.md'), 'utf8') === readme
      && Object.values(LIMIT_FILES).every((file) => !existsSync(join(project, file))) };
  record(`TB-09 the create session calling edit and bash gets "${NARROWED.create}", and the close session calling `
    + `write and bash gets "${NARROWED.close}" (file-system-permissions §8.3, §8.4)`,
  refusedAll(obs.create, ['edit', 'bash'], NARROWED.create)
    && refusedAll(obs.close, ['write', 'bash'], NARROWED.close), brief({ create: obs.create, close: obs.close }));
  record(`TB-09 in team mode the dialog session calling bash and edit gets "${RELAY_ONLY}" for each; nothing changes `
    + 'in the project and no approval card appears (permission is Ask each time)',
  refusedAll(obs.dialog, ['bash', 'edit'], RELAY_ONLY) && obs.untouched && obs.cards.length === 0,
  brief({ dialog: obs.dialog, untouched: obs.untouched, cards: obs.cards }));
}

// ---------- TB-09：会话打开之后才连上的 MCP 服务、退出重开后关掉协作模式 ----------

/** @brief 对话想改工作区的三个调用（脚本 tryChanges）的工具结果，与工作区是否没变。 */
function changeAttempts(project, readme, entries) {
  const results = Object.fromEntries(['bash', 'edit', 'write', ROLES_TEXT.mcpTool]
    .map((tool) => [tool, toolResults(entries, tool)[0] ?? null]));
  const untouched = !existsSync(join(project, ROLES_TEXT.bashFile)) && !existsSync(join(project, ROLES_TEXT.writeFile))
    && readFileSync(join(project, 'README.md'), 'utf8') === readme;
  const view = Object.fromEntries(Object.entries(results)
    .map(([tool, m]) => [tool, m && [m.isError, textOfMessage(m)]]));
  return { results, untouched, view };
}

/**
 * @brief 协作模式下、会话打开之后才注册工具的 MCP 服务（脚本 tb-roles-mcp；合成 MCP 服务连上 8 秒后才列出工具，
 *        对话第一次请求的回复晚 12 秒到，工具在这次运行中注册）：权限为“每次询问”，对话调用 bash、edit、write 和那个
 *        MCP 工具，都按对话会话的收窄（{ write: false, mcp: false }，file-system-permissions.md §8.3）得到 RELAY_ONLY。
 */
async function lateMcp(ctx) {
  const project = ctx.pm;
  const readme = readFileSync(join(project, 'README.md'), 'utf8');
  const since = Date.now();
  const tab = await openProject(ctx, project);
  const who = await whoOf(ctx, tab);
  await clickTo(ctx, tab, 'always', 'planner');
  await sendMessage(ctx, tab, 'Try the tools tb-scenario:tb-roles-mcp');
  await settle(ctx, who, 90000);
  const requests = requestsOf(ctx, 'tb-roles-mcp', 'chat', 'team-dialog');
  const tried = changeAttempts(project, readme, readJsonl(who.sessionFile).slice(1));
  const cards = await seenOf(ctx, 'approval-card', since);
  const mcpLog = existsSync(ctx.mcpLog) ? readFileSync(ctx.mcpLog, 'utf8') : '';
  const withMcp = requests.findIndex((request) => request.tools.includes(ROLES_TEXT.mcpTool));
  ctx.lateMcp = { tried, requests: requests.map(sortedTools) };
  record('TB-09 an MCP server that connects after the session opened: the dialog\'s first request has no MCP tool, '
    + 'pi enables the server\'s tool once it registers, and the dialog calling it gets the §5.5 reason "Team mode is '
    + 'on: the dialog agent only relays; the work is done in tasks."',
  (mcpLog.match(/"tools\/list"/g) ?? []).length >= 2 && requests.length >= 2
    && !requests[0].tools.includes(ROLES_TEXT.mcpTool)
    && withMcp > 0 && tried.results[ROLES_TEXT.mcpTool]?.isError === true
    && textOfMessage(tried.results[ROLES_TEXT.mcpTool]) === RELAY_ONLY,
  brief({ tools: requests.map(sortedTools), mcp: tried.view[ROLES_TEXT.mcpTool] }));
  // 碰文件的工具在协作模式下不再关掉（file-system-permissions.md §8.6）：bash、edit、write 在请求里，调用它们在路径闸
  // 第 2 步按对话会话的收窄拒绝，原文同 MCP 工具（file-system.md §19.4 的 TB-09 一行）
  record('TB-09 with that late MCP server, the dialog\'s requests keep bash, edit and write (the same file tools as '
    + `in off mode) and calling each of them gets "${RELAY_ONLY}"; no file changes and no approval card appears `
    + '(permission is Ask each time)', requests.length >= 2
    && requests.every((request) => same(fileTools(request).filter((name) => !name.startsWith('mcp__')),
      DEFAULT_TOOLS))
    && ['bash', 'edit', 'write'].every((tool) => tried.results[tool]?.isError === true
      && textOfMessage(tried.results[tool]) === RELAY_ONLY) && tried.untouched && cards.length === 0,
  brief({ view: tried.view, untouched: tried.untouched, cards, tools: requests.map(sortedTools) }));
}

// ---------- TB-43：实例会话的存放与事件（脚本 tb-roles-instances） ----------

/**
 * @brief 写一个 synthetic 项目扩展（.pi/extensions/ask-probe.ts）：只在实例会话里（pi 会话 id 带 “.”），每次运行开始前
 *        经 ctx.ui 问确认、选择、输入并发一条通知，把回答、会话 id 与 isProjectTrusted() 追加到 log（JSON 行）。
 */
function writeAskProbe(project, log) {
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'ask-probe.ts'), [
    '// synthetic: written by tests/ui/tb-app-roles.mjs (TB-43); asks through ctx.ui inside instance sessions only.',
    "import { appendFileSync } from 'node:fs';",
    '',
    'export default function (pi) {',
    "  pi.on('before_agent_start', async (_event, ctx) => {",
    '    const id = ctx.sessionManager.getSessionId();',
    "    if (!id.includes('.')) return;",
    "    const confirm = await ctx.ui.confirm('Probe confirm', 'Asked inside an instance');",
    "    const select = await ctx.ui.select('Probe select', ['a', 'b']);",
    "    const input = await ctx.ui.input('Probe input', 'hint');",
    "    ctx.ui.notify('probe notice', 'info');",
    `    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id, confirm, select: select ?? null,`,
    "      input: input ?? null, trusted: ctx.isProjectTrusted() }) + '\\n');",
    '  });',
    '}',
    '',
  ].join('\n'));
}

/** @brief 打开 folder，信任询问出现时选“Trust workspace”、不勾“Remember my choice”（这个决定只在这个会话里），等会话就绪。 */
async function openTrustingOnce(ctx, folder) {
  const before = await ctx.page.locator('.pane-slot').count();
  await stubFolder(ctx.app, folder);
  await ctx.page.getByRole('button', { name: /^Open folder…$/ }).first().click();
  const dialog = ctx.page.getByTestId('trust-dialog');
  await dialog.waitFor({ timeout: 30000 });
  await dialog.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  await ctx.page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length >= n, before + 1,
    { timeout: 30000 });
  const tab = await ctx.page.locator(SHOWN_PANE).first().getAttribute('data-tab');
  await ctx.page.waitForFunction((css) => {
    const pane = document.querySelector(css);
    return pane && !pane.querySelector('[data-testid="not-ready"]');
  }, paneSel(tab), { timeout: 30000 });
  return tab;
}

/** @brief 两个路径是否同一个文件（Windows 不区分大小写，斜杠方向不论）。 */
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();

/** @brief 分开配置的 /team 流程：立项、task、结案三种实例；检查文件、侧栏、事件、扩展询问与信任。 */
async function instances(ctx) {
  const project = tempProject('mori-tb-roles-inst-');
  writeRoles(project, SPLIT_ROLES);
  const log = join(args.shots, `ask-probe-${Date.now()}.jsonl`);
  writeAskProbe(project, log);
  const mcpLog = writeEchoServer(project);
  const since = Date.now();
  const tab = await openTrustingOnce(ctx, project);
  const who = await whoOf(ctx, tab);
  // 等 MCP 服务列出工具（它的日志里有 tools/list）再发：立项实例的第一个请求里就该有它的工具（TB-09）
  const listed = await poll(() => existsSync(mcpLog) && readFileSync(mcpLog, 'utf8').includes('"tools/list"'), 30000);
  if (!listed) throw new Error('the synthetic MCP server never got tools/list');
  await sendMessage(ctx, tab, 'Read it tb-scenario:tb-roles-instances', { team: true });
  await settle(ctx, who, 120000);
  const filesNow = instanceFiles(ctx, who.sessionId);
  instanceStorage(ctx, who, filesNow);
  instanceToolSets(ctx);
  await instanceLists(ctx, who, filesNow);
  await instanceEvents(ctx, who, since);
  await instanceAsks(ctx, { who, since, log, project, files: filesNow });
}

/** @brief TB-43：实例会话文件在 <userData>/teams/<id>/sessions，头部 parentSession 指向用户会话，首条 mori.instance。 */
function instanceStorage(ctx, who, files) {
  const dir = join(ctx.userData, 'teams', who.sessionId, 'sessions');
  const kinds = { create: 'create', 't1.executor': 'task', 'close.1': 'close' };
  const view = files.map((file) => ({ suffix: instanceSuffix(who.sessionId, file.id), dir: samePath(join(file.file,
    '..'), dir), parent: samePath(file.header?.parentSession, who.sessionFile), first: file.first?.type === 'custom'
    && file.first.customType === 'mori.instance' ? file.first.data : null }));
  record('TB-43 the instance session files (create, t1.executor, close.1) are in <userData>/teams/<id>/sessions, '
    + 'their header\'s parentSession is the user session file and their first entry is mori.instance { kind, role }',
  same(view.map((item) => item.suffix).sort(), Object.keys(kinds).sort()) && view.every((item) => item.dir
    && item.parent && item.first?.kind === kinds[item.suffix]
    && item.first.role === (item.suffix === 't1.executor' ? 'executor' : 'planner')), brief(view));
}

/**
 * @brief TB-09：三种实例（立项、task、结案）的请求里都是默认工具、项目 MCP 服务的工具（白名单的 mcp__*）加它的
 *        TaskBoard 工具（立项另有 memory）；T1 写了 limits.write 为 false（脚本的只读 task），它的工具仍是这一组
 *        （file-system-permissions.md §8.6：碰文件的工具不随角色、limits 开关，收窄在路径闸按调用判断）。
 */
function instanceToolSets(ctx) {
  const of = (agent, kind) => requestsOf(ctx, 'tb-roles-instances', agent, kind);
  const sets = { create: [of('planner', 'create'), CREATE_SET], task: [of('executor', 'task'), TASK_SET],
    close: [of('planner', 'close'), CLOSE_SET] };
  const withoutMcp = (request) => sortedTools(request).filter((name) => !name.startsWith('mcp__'));
  const view = Object.fromEntries(Object.entries(sets).map(([kind, [requests]]) => [kind, requests.map(sortedTools)]));
  record('TB-09 every instance session gets the default tools (read, bash, edit, write), the project MCP server\'s '
    + `tools (${MCP_ECHO} …) and its TaskBoard tools: create (+ memory), the write: false task T1 (board_read, `
    + 'read_session, agent_message, task_handoff) and close — the same file tools whatever the role or the task\'s '
    + 'limits (file-system-permissions §8.6)',
  Object.values(sets).every(([requests, want]) => requests.length > 0
    && requests.every((request) => same(withoutMcp(request), want) && request.tools.includes(MCP_ECHO))),
  brief(view));
}

/** @brief TB-43：侧栏与会话列表（session.list）里都没有实例会话。 */
async function instanceLists(ctx, who, files) {
  const rows = await ctx.page.locator('.session-item').evaluateAll((els) => els.map((el) => el.dataset.file ?? ''));
  const listed = await bridge(ctx, { type: 'session.list' });
  const saved = Array.isArray(listed) ? listed : (listed?.sessions ?? []);
  const isInstance = (file, id) => files.some((item) => samePath(item.file, file)) || String(id ?? '')
    .startsWith(`${who.sessionId}.`) || String(file ?? '').replaceAll('\\', '/').includes('/teams/');
  record('TB-43 neither the sidebar nor the session list (session.list) has the instance sessions: no row or entry '
    + 'points into teams/ or has an id "<user session id>.…", while the user session itself is listed',
  files.length === 3 && rows.some((file) => samePath(file, who.sessionFile)) && !rows.some((file) => isInstance(file))
    && saved.some((item) => samePath(item.sessionFile, who.sessionFile))
    && !saved.some((item) => isInstance(item.sessionFile, item.sessionId)),
  brief({ rows: rows.length, listed: saved.map((item) => item.sessionId) }));
}

/** @brief TB-43：界面收不到实例会话的 pi 事件（每个信封都在用户会话上）。 */
async function instanceEvents(ctx, who, since) {
  const all = await ctx.page.evaluate((from) => (window.__tbEnv ?? []).filter((item) => item.t >= from), since);
  const mine = all.filter((item) => item.sid === who.sessionId);
  const strangers = all.filter((item) => typeof item.sid === 'string' && item.sid.includes('.'));
  const types = [...new Set(mine.map((item) => item.type))];
  record('TB-43 the screen receives no pi event of an instance session: every envelope during the run is on a user '
    + 'session id (none is "<id>.create", "<id>.t1.executor", "<id>.close.1"), and the team\'s progress arrives on the '
    + 'user session (mori.board)', strangers.length === 0 && types.includes('mori.board') && mine.length > 0,
  brief({ strangers: strangers.slice(0, 5), sids: [...new Set(all.map((item) => item.sid))], types }));
}

/** @brief TB-43：实例里的扩展询问不出卡、按默认回答（记错误日志）；实例沿用项目信任、不再询问。 */
async function instanceAsks(ctx, { who, since, log, project, files }) {
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const suffixes = [...new Set(lines.map((line) => instanceSuffix(who.sessionId, line.id)))].sort();
  const cards = await seenOf(ctx, 'ext-ui-card', since);
  const logged = (ctx.appLog ?? []).filter((item) => item.t >= since
    && item.line.includes('answered as cancelled')).length;
  record('TB-43 an extension asking inside an instance gets no card: in create, t1.executor and close.1 the confirm '
    + 'answers false and select and input answer nothing (pi\'s no-UI defaults), no question card appears and the '
    + 'kernel logs each question as answered cancelled', same(suffixes, ['close.1', 'create', 't1.executor'])
    && lines.every((line) => line.confirm === false && line.select === null && line.input === null)
    && cards.length === 0 && logged >= lines.length * 3, brief({ lines, cards, logged }));
  const trustAsks = await seenOf(ctx, 'trust-dialog', since);
  const remembered = existsSync(join(ctx.userData, 'pi', 'trust.json'))
    && readFileSync(join(ctx.userData, 'pi', 'trust.json'), 'utf8').includes(JSON.stringify(project).slice(1, -1));
  record('TB-43 instances do not ask about project trust again: the trust question appeared once (when the folder '
    + 'was opened, answered "trust" without remembering) and the three instances ran trusted (the project '
    + 'extension loaded in them and isProjectTrusted() is true)', trustAsks.length === 1 && lines.length > 0
    && lines.every((line) => line.trusted === true) && !remembered && files.length === 3,
  brief({ trustAsks, trusted: lines.map((line) => line.trusted), remembered }));
}

// ---------- 重启：TB-09（退出重开后关掉协作模式）、TB-01（重新打开的已保存会话 Check again 从文件重新打开） ----------

/** @brief 重启前准备两个会话：分开配置在 always 下问过一次（tb-roles-restart）；一个已保存的会话随后角色文件写坏。 */
async function restartPrepare(ctx) {
  const ps = tempProject('mori-tb-roles-restart-');
  writeRoles(ps, SPLIT_ROLES);
  const tab = await openProject(ctx, ps);
  const who = await whoOf(ctx, tab);
  await sendMessage(ctx, tab, 'Hello tb-scenario:tb-roles-restart');
  await settle(ctx, who, 60000);
  await clickTo(ctx, tab, 'always', 'planner');
  await sendMessage(ctx, tab, 'Quick question');
  await settle(ctx, who, 60000);
  const pc = tempProject('mori-tb-roles-check-');
  writeRole(pc, { name: 'executor', description: 'Changes code and runs commands to finish a task' });
  const tabC = await openProject(ctx, pc);
  const whoC = await whoOf(ctx, tabC);
  await sendMessage(ctx, tabC, 'plain before the restart');
  if (!(await waitReplies(ctx, tabC, 1))) throw new Error('no reply before the restart');
  putAgentFiles(pc, { 'executor.md': roleText('name: executor\ndescription: A role\ncolor: blue') });
  return { who, whoC, pc };
}

/** @brief 退出 Mori、用同一个数据目录重新启动，再看两个会话。 */
async function restart(ctx) {
  const prep = await restartPrepare(ctx);
  ctx.notReadyBefore = await ctx.page.evaluate(() => window.__tbNotReady ?? []);
  await restartTbApp(ctx);
  await watchNotReady(ctx);
  await watchSeen(ctx);
  await watchEnvelopes(ctx);
  await restartDialog(ctx, prep.who);
  await restartCheckAgain(ctx, prep.whoC, prep.pc);
}

/**
 * @brief TB-09：协作模式下退出 App、重新打开、关掉协作模式后，请求里又有 bash、edit、write（与进入协作模式前相同）；
 *        协作模式下的请求碰文件的工具同样没变（file-system-permissions.md §8.6：模式改变不再改碰文件的工具）。
 */
async function restartDialog(ctx, who) {
  who.tab = await reopenSession(ctx, who.sessionFile);
  const kept = await switchIs(ctx, who.tab, 'always', 'planner');
  const off = await clickTo(ctx, who.tab, 'off', 'planner');
  await sendMessage(ctx, who.tab, 'Back off after the restart');
  await settle(ctx, who, 60000);
  const off1 = requestsOf(ctx, 'tb-roles-restart', 'chat', 'off-dialog').filter((request) => request.info.k === 1);
  const off3 = requestsOf(ctx, 'tb-roles-restart', 'chat', 'off-dialog').filter((request) => request.info.k === 3);
  const team = requestsOf(ctx, 'tb-roles-restart', 'chat', 'team-dialog');
  record('TB-09 after team mode, quitting Mori, reopening the session (still Team: On) and turning team mode off, '
    + 'the dialog request has bash, edit and write again — the same tools as before team mode; the team-mode '
    + 'request had the same file tools too (file-system-permissions §8.6)',
  kept.ok && off.ok && off1.length === 1 && off3.length === 1 && ['bash', 'edit', 'write']
    .every((tool) => off3[0].tools.includes(tool)) && same(sortedTools(off3[0]), sortedTools(off1[0]))
    && team.length >= 1 && team.every((request) => same(fileTools(request), fileTools(off1[0]))),
  brief({ kept: kept.sw, off1: off1.map(sortedTools), team: team.map(sortedTools), off3: off3.map(sortedTools) }));
}

/** @brief TB-01：重新打开时角色文件有错 → 拒绝启动；改好后 Check again 从文件重新打开、按新角色，对话流不变。 */
async function restartCheckAgain(ctx, whoC, pc) {
  whoC.tab = await reopenSession(ctx, whoC.sessionFile);
  const before = await blockedCard(ctx, whoC.tab);
  putAgentFiles(pc, { 'planner.md': PLANNER_FILE });
  const card = await checkAgain(ctx, whoC.tab);
  const after = await whoOf(ctx, whoC.tab);
  const team = await teamStateOf(ctx, after.sessionFile);
  const pane = await paneState(ctx.page, whoC.tab);
  await sendMessage(ctx, whoC.tab, 'plain after reopening');
  const replied = await waitReplies(ctx, whoC.tab, 2, 30000);
  record('TB-01 a saved session reopened after its role file broke is refused (agents_invalid, unknown field); after '
    + 'the fix Check again reopens it from its file with the new roles: same session file, the earlier message and '
    + 'reply still shown, planner holds create and close, and the next message is answered',
  before?.kind === 'agents_invalid' && same(before.problems, [`${agentFile('executor.md')}: unknown field "color"`])
    && card === null && samePath(after.sessionFile, whoC.sessionFile)
    && pane.users.includes('plain before the restart') && pane.assistants[0] === PLAIN
    && same(team?.holders, { dialog: 'mori', create: 'planner', close: 'planner' }) && replied,
  brief({ before, card, after, holders: team?.holders, users: pane.users }));
}

// ---------- TB-53：界面没准备好时不可用 ----------

/** @brief 打开会话时（Starting…）开关一直不可用；后台进程退出后开关不可用。 */
async function notReady(ctx) {
  const records = [...(ctx.notReadyBefore ?? []), ...await ctx.page.evaluate(() => window.__tbNotReady ?? [])];
  const opening = records.filter((item) => item.text === 'Starting…');
  const tab = await ctx.page.locator(SHOWN_PANE).first().getAttribute('data-tab');
  // 退出前不在 off：“最后知道的 mode”与默认的 Team: Off 不同，检查才分得出来
  if ((await teamSwitch(ctx, tab)).mode === 'off') await clickTo(ctx, tab, 'always');
  const last = await teamSwitch(ctx, tab);
  await killTbKernel(ctx);
  const exited = await poll(async () => {
    const sw = await teamSwitch(ctx, tab).catch(() => null);
    const wait = await ctx.page.locator(`${paneSel(tab)} [data-testid="not-ready"]`).textContent().catch(() => null);
    return sw?.disabled && wait === 'Mori’s background process crashed' ? { sw, wait } : null;
  }, 20000);
  record('TB-53 while the UI is not ready the switch is not available: disabled every time a pane showed "Starting…" '
    + 'while its session opened, and disabled after the kernel exited ("Mori’s background process crashed"), still '
    + 'showing the last mode',
  opening.length >= 3 && opening.every((item) => item.disabled) && Boolean(exited) && last.mode !== 'off'
    && exited.sw.mode === last.mode && exited.sw.text === last.text && exited.sw.checked === last.checked,
  brief({ opening: opening.length, bad: opening.filter((i) => !i.disabled), last, exited }));
}

// ---------- TB-43：mori-team 载入失败时会话不打开 ----------

/** 拷贝里被换掉的一行（mori-team 工厂函数注册工具的地方，teamExtension.ts） */
const TEAM_FACTORY_LINE = 'for (const tool of hooks.tools) pi.registerTool(tool);';
/** 换上的一行（synthetic fault injection） */
const TEAM_FACTORY_FAULT = 'throw new Error("synthetic fault injection by tb-app-roles: mori-team cannot load");';

/** @brief 把当前构建拷到 .tb-runs/roles-teamfail，只在拷贝的内核代码里让 mori-team 的工厂函数抛错。 */
function faultyBuild() {
  const from = process.env.MORI_APP_DIR ? resolve(process.env.MORI_APP_DIR) : appRoot;
  const dir = join(appRoot, '.tb-runs', 'roles-teamfail');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(from, 'out'), join(dir, 'out'), { recursive: true });
  cpSync(join(from, 'package.json'), join(dir, 'package.json'));
  const kernel = join(dir, 'out', 'main', 'kernel.js');
  const code = readFileSync(kernel, 'utf8');
  if (code.split(TEAM_FACTORY_LINE).length !== 2) {
    throw new Error(`cannot find the mori-team factory line in ${kernel}`);
  }
  writeFileSync(kernel, code.replace(TEAM_FACTORY_LINE, TEAM_FACTORY_FAULT));
  return dir;
}

/** @brief 用拷贝启动 Mori（新的数据目录），打开一个项目：会话不打开，界面写明原因。打包版（--exe）不跑这一步。 */
async function teamFail(ctx) {
  if (args.exePath) return;
  const dir = faultyBuild();
  const saved = process.env.MORI_APP_DIR;
  process.env.MORI_APP_DIR = dir;
  const fctx = { userData: tempUserData('mori-tb-roles-fail-'), exePath: null };
  seedTeamUserData(fctx.userData, ctx.seed);
  try {
    await startTbApp(fctx);
    const project = tempProject('mori-tb-roles-fail-');
    await stubFolder(fctx.app, project);
    await fctx.page.getByRole('button', { name: /^Open folder…$/ }).first().click();
    const failed = await poll(() => fctx.page.evaluate(() => [...document.querySelectorAll('[role="alert"], '
      + '.form-message.error')].map((el) => el.textContent)
      .find((text) => text.includes('Failed to open session: ')) ?? null), 30000);
    const sessions = filesUnder(join(fctx.userData, 'pi', 'sessions'));
    const ready = await fctx.page.locator('[data-testid="chat-pane"] [data-testid="not-ready"]').allTextContents();
    record('TB-43 when mori-team fails to load the session does not open: "Failed to open session: The team '
      + 'extension failed to load: …" is shown, the pane stays "Session didn’t open" and no session file is written '
      + '(fault injected into a copy of the build)', typeof failed === 'string'
      && failed.includes('The team extension failed to load') && failed.includes('synthetic fault injection')
      && sessions.length === 0
      && (ready.length === 0 || ready.every((text) => text === 'Session didn’t open')),
    brief({ failed, sessions, ready }));
  } finally {
    await closeTbApp(fctx);
    if (saved === undefined) delete process.env.MORI_APP_DIR;
    else process.env.MORI_APP_DIR = saved;
  }
}

// ---------- 主流程 ----------

/** 按顺序跑的步骤（都在本构建的同一个 App 里；restart 重启它，notReady 结束它的后台进程，所以放在最后） */
const steps = { v0same, switches, files, fields, seatLimits, lateMcp, instances, restart, notReady };

/** @brief 套件结束时的检查：端点没有收到脚本以外的请求。 */
function finalChecks(ctx) {
  const missing = missingSteps(ctx.ep);
  record('roles: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
}

const ctx = { userData: tempUserData('mori-tb-roles-data-'), baseData: tempUserData('mori-tb-roles-base-'),
  exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  if (!args.only || args.only.includes('v0same')) {
    console.log('[tb-app-roles] step base');
    try {
      await base(ctx);
    } catch (error) {
      record('base: roles', false, oneLineError(error));
    }
  }
  await startApp(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[tb-app-roles] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: roles`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  finalChecks(ctx);
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
}
if (!args.only || args.only.includes('teamFail')) {
  console.log('[tb-app-roles] step teamFail');
  try {
    await teamFail(ctx);
  } catch (error) {
    record('teamFail: roles', false, oneLineError(error));
  }
}
await stopTbEndpoint(ctx.ep);
console.log(`[tb-app-roles] data in ${ctx.userData}`);
finish();
