// 平行 Agent 与 TaskBoard 的 App 套件：角色、权限、关闭模式、对话只传话、实例会话、模型菜单里的 Task mode 一行
// （docs/specs/parallel-agents-taskboard.md §17.2）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的脚本模式
// （tests/fake-endpoint/scenarios/roles.mjs，synthetic），逐条验收这些条目在 App 层的通过条件：
//   TB-01 角色文件校验、TB-02 权限与基座、TB-03 关闭模式与 v0 一致（App 的部分；回放与 m1–m6 fixture 由回放套件做）、
//   TB-09 对话只传话、TB-43 实例会话的存放与事件、TB-53 Task mode 开关（App 的部分；2026-10-26 起在模型菜单里）。
// 记忆规格（docs/specs/memory.md §14.4）之后：TB-03 比较 system prompt 时两边都去掉开头的身份段（到第一个 <addendum>、
// <project_context>、<skills> 或 <cwd> 段之前：新版是 Mori 的身份段，对照版是 pi 的身份句、<tools>、<rules>、<docs>），
// 新版再去掉 taste、strategy、review、facts 四段；请求的工具列表在全部比较之前去掉 memory；工具页的行去掉 memory 那一行
// 再比较。TB-09 的工具集合按 §7.6 加 memory（关闭模式的对话、chat.md 写 tools: [read] 的对话、分开时的立项实例）。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs roles；TB-03 的对照构建 node tests/ui/tb-build-base.mjs，没有时才建）：
//   MORI_APP_DIR=.tb-runs/roles node tests/ui/tb-app-roles.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/tb-app-roles(-packaged).json（--only 时 tb-partial-app-roles…），截图在 test-results/tb-app-roles/。
// 端口（§17.1 的 4600–4699 里分给本套件的 4600–4609）：合成端点 4600，记录代理 4601。
// 测试准备（synthetic test setup，逐处注明）：数据目录里两个本机提供商 tba、tbb（各一个模型，模型族不同、窗口 128000 与
// 256000，写入等级 A，跳过探针）；临时项目各写自己的角色文件（正文带合成端点认角色用的 MORI-ROLE-<name>）、
// .pi/mcp.json（合成 MCP 服务 tests/mcp-server/server.mjs，连上 8 秒后才列出工具）、.pi/extensions（在实例里询问的
// 项目扩展）。
// 同一时间只开一个 App：TB-03 先用对照构建（.tb-runs/base，提交 2e67197，没有 TaskBoard）跑一次关闭模式，再用本构建跑；
// TB-43 的 mori-team 载入失败用本构建的一份拷贝（.tb-runs/roles-teamfail），只在拷贝的内核代码里让 mori-team 的工厂函数
// 抛错（synthetic fault injection，本构建与 src 不变），最后单独启动。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROLES_TEXT } from '../fake-endpoint/scenarios/roles.mjs';
import { SEGMENT_SENTENCES } from '../fake-endpoint/scripts.mjs';
import { appRoot } from './lib.mjs';
import { stubFolder } from './m3-helpers.mjs';
import { openToolsSection } from './m6-helpers.mjs';
import { PI_DEFAULT_TOOLS, PI_TOOLS, TOOL_REASONS, toolRows, v0Fields } from './m6-tools-helpers.mjs';
import {
  allowAll, bridge, brief, clickTeamSwitch, closeTbApp, contentText, instanceFiles, instanceSuffix, kernelEvents,
  killTbKernel, messagesOf, missingSteps, newSession, OFF_CARD_TOOLS, openProject, paneSel, paneState, poll,
  menuArrows, progressOf, readBoard, readJsonl, receiptsOf, recentActions, reopenSession, restartTbApp, scenarioLines,
  scenarioRequests, seedTeamUserData, sendMessage, showTab, sleep, shot, startTbApp, startTbEndpoint, stopTbEndpoint,
  suiteArgs, closeModelMenu, modelButtonSel, modelMenuSel, openModelMenu, SPLIT_ROLES, taskModeRow, taskRowSel,
  tbModel, tbProvider, tbRecorder, teamStateOf, teamSwitch, tempProject, tempUserData, userSession, waitTeamIdle,
  writeRole, writeRoles,
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
/** §5.5 协作模式下对话调用范围外的工具的理由 */
const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';
/** 关闭模式的对话段（附录 A）的第一句 */
const OFF_SENTENCE = SEGMENT_SENTENCES['off-dialog'];

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

/** @brief 对话流里 TaskBoard 才有的元素：回执、进展摘要、Stop agents 按钮的个数。 */
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
  addBaseFields(ctx.baseData);
  seedTeamUserData(ctx.userData, ctx.seed);
}

/** @brief 读、改、写数据目录里的一个 JSON 文件。 */
function editJson(dir, name, change) {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`);
}

/**
 * @brief 测试准备（synthetic test setup）：对照构建（2e67197）的两个文件还要求 2026-10-26 删掉的字段，只给它的数据目录补上，
 *        本构建的数据目录不动（它按未知字段拒绝这些字段）。model-config.json 的网络区域（负责人走查 M3）：两个本机提供商的
 *        zone 为 local，allowedZones 为那时的默认（local、intranet），projectZones 为空，没有时对照构建读不出配置、拒绝启动
 *        会话；model-profiles.json 的长输入与取消两步（走查 M7）：longInput 为 null、取消一步通过（同删掉之前的 tbProfile），
 *        没有时对照构建丢掉档案、启动时重新探测。
 */
function addBaseFields(dir) {
  editJson(dir, 'model-config.json', (config) => ({ ...config, allowedZones: ['local', 'intranet'], projectZones: {},
    providers: config.providers.map((provider) => ({ ...provider, zone: 'local' })) }));
  const cancel = { step: { outcome: 'pass', detail: null }, verified: true };
  editJson(dir, 'model-profiles.json', (file) => ({ ...file,
    profiles: file.profiles.map((profile) => ({ ...profile, longInput: null, cancel })) }));
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
 *        记下那一刻这一栏能不能切 Task mode（2026-10-26 起开关在模型菜单里）：有没有模型按钮、它是否 aria-disabled、
 *        模型菜单是否开着（window.__tbNotReady，每项 { t, tab, text, button, disabled, menu }）。
 */
function watchNotReady(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__tbNotReady) return;
    window.__tbNotReady = [];
    const scan = () => {
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const wait = pane.querySelector('[data-testid="not-ready"]');
        if (!wait) continue;
        const button = pane.querySelector('[data-testid="model-button"]');
        const item = { tab: pane.dataset.tab, text: wait.textContent, button: Boolean(button),
          disabled: button ? button.getAttribute('aria-disabled') === 'true' : null,
          menu: Boolean(pane.querySelector('[data-testid="model-menu"]')) };
        const last = window.__tbNotReady.findLast((old) => old.tab === item.tab);
        if (last && last.text === item.text && last.disabled === item.disabled && last.menu === item.menu) continue;
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
  + 'If a request needs several kinds of work, you may suggest that the user sends it with /task.';

/** @brief 请求体里工具的名字。 */
const toolNames = (body) => (body?.tools ?? []).map((tool) => tool.function?.name ?? tool.name);

/** 记忆的工具名（docs/specs/memory.md §7） */
const MEMORY_TOOL = 'memory';
/** @brief 请求体的工具定义去掉 memory（记忆规格 §14.4：TB-03 在全部比较之前去掉它）。 */
const withoutMemoryTool = (body) => (body?.tools ?? []).filter((tool) => (tool.function?.name ?? tool.name)
  !== MEMORY_TOOL);
/** 工具页 subagent 那一行下面的原因（subagent 规格 §2） */
const SUBAGENT_REASON = 'Mori turns this on when Task mode is off.';
/** @brief subagent 的定义里每一项有 role（有别的角色时，subagent 规格 §3.1）。 */
const subagentRole = (tool) => Boolean(tool?.function?.parameters?.properties?.tasks?.items?.properties?.role);
/** @brief 工具页的行去掉 memory 那一行（记忆规格 §14.4）。 */
const withoutMemoryRow = (rows) => rows.filter((row) => row.name !== MEMORY_TOOL);
/** @brief pi 的 8 个内置工具行都有开关，没写 defaultTools 时开着的正是 read、bash、edit、write（tools.md，WP-08）。 */
const builtinSwitches = (rows) => PI_TOOLS.every((name) => rows.find((row) => row.name === name)?.checked
  === PI_DEFAULT_TOOLS.includes(name));

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
  const subagent = toolDef(request, 'subagent');
  const kept = withoutMemoryTool(request?.body).filter((tool) => tool !== subagent);
  const system = comparable(request?.system);
  record('TB-03 off mode without role files: normal mode differs from v0 only by subagent — once memory is left out '
    + 'the tool list is the v0 list (the pre-TaskBoard build, same project and config) plus the subagent definition '
    + '(with its description, no role), and the system prompt after the identity part (whose <tools> lists subagent) '
    + 'with the taste, strategy, review and facts sections left out is the v0 one (memory spec §14.4, subagent spec '
    + '§2)', request !== undefined && JSON.stringify(kept) === JSON.stringify(base.body.tools)
    && Boolean(subagent?.function?.description) && !subagentRole(subagent)
    && system !== null && system === comparable(baseSystem(ctx)),
  brief({ tools: toolNames(request?.body), baseTools: toolNames(base.body), system: system?.length,
    baseSystem: comparable(baseSystem(ctx))?.length, head: request?.system.slice(0, 60) }));
  const rows = withoutMemoryRow(tools.rows).filter((row) => row.name !== 'subagent');
  const row = tools.rows.find((item) => item.name === 'subagent');
  record('TB-03 off mode without role files: the Tools page rows (name, source, on/off, description) are the same as '
    + 'in v0 once the memory row is left out (memory spec §14.4), plus one subagent row from Mori with no switch and '
    + 'the line "Mori turns this on when Task mode is off." (subagent spec §2); since 2026-10-26 (WP-08) the eight pi '
    + 'rows also have a switch, on for read, bash, edit and write', rows.length > 0
    && same(rows.map(v0Fields), ctx.v0.tools.rows.map(v0Fields)) && builtinSwitches(rows) && row?.tag === 'Mori'
    && row.checked === null && same(row.notes, [SUBAGENT_REASON]),
  brief({ tb: tools.rows.map((item) => `${item.name}|${item.tag}|${item.state}|${item.checked}`),
    v0: ctx.v0.tools.rows.map((item) => `${item.name}|${item.tag}|${item.state}`) }));
  const files = filesUnder(join(ctx.userData, 'teams'));
  record('TB-03 off mode without role files: no instance is created (no instance session, the endpoint got exactly '
    + 'one request for the message) and there is no file under <userData>/teams',
  files.length === 0 && instanceFiles(ctx, who.sessionId).length === 0
    && scenarioRequests(ctx.ep, null, { since: who.since }).length === 1, brief({ files }));
  const pane = await paneState(ctx.page, who.tab);
  const sw = await teamSwitch(ctx, who.tab);
  const extra = await teamElements(ctx, who.tab);
  record('TB-03 off mode without role files: the reply is the same as v0, the model button is in off mode '
    + '(data-team-mode off, no "Task mode" on it) and there is no receipt, progress summary or Stop agents',
  pane.assistants.at(-1) === ctx.v0.reply && ctx.v0.reply === PLAIN && sw.mode === 'off'
    && !sw.text.startsWith('Task mode') && same(extra,
    { receipts: 0, progress: 0, stopTeam: 0 }), brief({ reply: pane.assistants.at(-1), sw, extra }));
  const team = await teamStateOf(ctx, who.sessionFile);
  record('TB-02 no role files: every seat is held by mori (TeamState.holders) and no role besides the base',
    same(team?.holders, { dialog: 'mori', create: 'mori', close: 'mori' }) && same(team.roles, []), brief(team));
}

/** @brief TB-03 有别的角色（只有 executor.md）：只多 agent_message 与它的说明段；工具页列出 TaskBoard 工具、来源 Mori。 */
async function v0Roles(ctx, who, request, tools) {
  const base = ctx.v0.request;
  const subagent = toolDef(request, 'subagent');
  const kept = withoutMemoryTool(request?.body).filter((tool) => tool !== subagent);
  const names = kept.map((tool) => tool.function?.name ?? tool.name);
  const extraTool = toolDef(request, 'agent_message');
  const rest = kept.filter((tool) => tool !== extraTool);
  const system = comparable(request?.system);
  const v0System = comparable(baseSystem(ctx));
  const added = system !== null && v0System !== null && system.startsWith(v0System)
    ? system.slice(v0System.length) : null;
  record('TB-03 off mode with another role (executor.md): with memory left out (memory spec §14.4) the request '
    + 'differs from v0 only by subagent (whose schema now has role) and agent_message — the tool list is the v0 list '
    + 'plus the agent_message definition (with its description) at the end, and the system prompt after the identity '
    + 'part (without the memory sections) is the v0 one plus the mori_team section holding the off-mode dialog '
    + 'segment that explains it', JSON.stringify(rest) === JSON.stringify(base.body.tools)
    && names.at(-1) === 'agent_message' && Boolean(extraTool?.function?.description) && subagentRole(subagent)
    && added === `\n\n<mori_team>\n${OFF_SEGMENT}\n</mori_team>`, brief({ names, added }));
  const rows = withoutMemoryRow(tools.rows).filter((row) => row.name !== 'subagent');
  const mori = rows.filter((row) => row.tag === 'Mori');
  const others = rows.filter((row) => row.tag !== 'Mori');
  const subRow = tools.rows.find((row) => row.name === 'subagent');
  const userTools = TEAM_TOOLS.filter((name) => !['task_handoff', 'request_close'].includes(name));
  record('TB-03 off mode with another role: with the memory row left out, the Tools page lists the TaskBoard tools of '
    + 'the user session (board_read … reply_via_dialog) with source "Mori" — only agent_message on, no switch, and the '
    + 'line "Mori turns this on and off with Task mode." under each (2026-10-26, WP-08) — and every other row is the '
    + 'same as in v0',
  same(mori.map((row) => row.name).sort(), [...userTools].sort())
    && mori.every((row) => (row.name === 'agent_message') === (row.active === 'true') && row.checked === null
      && same(row.notes, [TOOL_REASONS.task]))
    && same(others.map(v0Fields), ctx.v0.tools.rows.map(v0Fields)) && builtinSwitches(others)
    && subRow?.tag === 'Mori' && same(subRow.notes, [SUBAGENT_REASON]),
  brief(tools.rows.map((row) => `${row.name}|${row.tag}|${row.state}|${row.notes.join(' ')}`)));
  const team = await teamStateOf(ctx, who.sessionFile);
  record('TB-02 only executor.md: every seat is held by mori and the only role file is executor',
    same(team?.holders, { dialog: 'mori', create: 'mori', close: 'mori' })
    && same(team.roles.map((role) => role.name), ['executor']), brief(team));
  record('TB-03 off mode with another role: still no instance and no file under <userData>/teams',
    filesUnder(join(ctx.userData, 'teams')).length === 0 && instanceFiles(ctx, who.sessionId).length === 0,
    brief(filesUnder(join(ctx.userData, 'teams'))));
}


// ---------- TB-53：模型菜单里的 Task mode 一行（2026-10-26 WP-09 起；之前是顶栏的协作开关） ----------

/** Task mode 一行在三种模式下的 aria-checked 与第二行（§13.1；<create role> 为基座时显示 Mori） */
const SWITCH = {
  off: { checked: 'false', hint: () => null },
  always: { checked: 'true', hint: (role) => `Messages go to ${role} first` },
  once: { checked: 'true', hint: () => 'Until done · Ends when open requests are done' },
};
/** 协作模式下模型按钮悬停的第二行、协作模式的菜单里的说明（§12.11） */
const TASK_PICKS = 'Task mode picks the model for each agent';

/**
 * @brief 模型按钮是不是 mode 的样子（team-switch.md“模型按钮上的模式”）：data-team-mode；off 时按钮上没有
 *        “Task mode”，打开时文字“Task mode · <模型 id>”、读屏名“Model: Task mode, <模型 id>”、悬停第二行 TASK_PICKS。
 */
function buttonIs(sw, mode) {
  if (mode === 'off') return sw.mode === 'off' && !sw.text.startsWith('Task mode');
  return sw.mode === mode && /^Task mode · \S+$/.test(sw.text) && sw.label === `Model: ${sw.text.replace(' · ', ', ')}`
    && sw.title?.split('\n')[1] === TASK_PICKS;
}

/**
 * @brief 此刻是不是 mode 的样子：模型按钮（buttonIs），和模型菜单里 Task mode 一行的 role="menuitemcheckbox"、
 *        aria-checked、读屏名“Task mode”、第二行与读屏的描述、可用。读完关上菜单。
 */
async function switchIs(ctx, tab, mode, createRole = 'Mori') {
  const sw = await teamSwitch(ctx, tab);
  const row = await taskModeRow(ctx, tab);
  const want = SWITCH[mode];
  const hint = want.hint(createRole);
  return { ok: buttonIs(sw, mode) && row.mode === mode && row.role === 'menuitemcheckbox'
    && row.checked === want.checked && row.label === 'Task mode' && row.hint === hint
    && row.described === (hint ?? '') && !row.disabled, sw, row };
}

/** @brief 在模型菜单里点 Task mode 一行，等模型按钮的 data-team-mode 变成 want；返回 switchIs 的结果。 */
async function clickTo(ctx, tab, want, createRole = 'Mori') {
  await clickTeamSwitch(ctx, tab, want).catch(() => {});
  return switchIs(ctx, tab, want, createRole);
}

/**
 * @brief 合并会话（没有角色文件，脚本 tb-roles-switch）：顶栏没有开关；两种文字与第二行、aria-checked、三种点击
 *        （off → always，always → off / once，once → always）、不需要确认；点了之后菜单不关、焦点留在这一行，范围的
 *        几节换成说明；最后撤销需求回到 off。
 */
async function switches(ctx) {
  const project = tempProject('mori-tb-roles-switch-');
  const tab = await openProject(ctx, project);
  const who = await whoOf(ctx, tab);
  const since = Date.now();
  await topBarHasNoSwitch(ctx, tab);
  const off0 = await switchIs(ctx, tab, 'off');
  await menuStaysOpen(ctx, tab);
  const off1 = await switchIs(ctx, tab, 'off');
  const on1 = await clickTo(ctx, tab, 'always');
  const offAgain = await clickTo(ctx, tab, 'off');
  await sendMessage(ctx, tab, 'Pick a file tb-scenario:tb-roles-switch', { team: true });
  const once = await poll(async () => ((await teamSwitch(ctx, tab)).mode === 'once'), 10000);
  const once1 = await switchIs(ctx, tab, 'once');
  await settle(ctx, who, 90000);
  const onceIdle = await switchIs(ctx, tab, 'once');
  const on2 = await clickTo(ctx, tab, 'always');
  const once2 = await clickTo(ctx, tab, 'once');
  const board = readBoard(ctx, who.sessionId);
  const confirms = await seenOf(ctx, 'confirm-dialog', since);
  record('TB-53 the Task mode row in the model menu is role="menuitemcheckbox" named "Task mode": off → '
    + 'aria-checked false and no second line, the model button without "Task mode"; always → true, second line '
    + '"Messages go to Mori first" (base holds create), button "Task mode · <model id>" with hover line 2 "Task mode '
    + 'picks the model for each agent"; once → true, "Until done · Ends when open requests are done"; the second line '
    + 'is also the screen-reader description', off0.ok && off1.ok && on1.ok && once1.ok && onceIdle.ok,
  brief({ off0, on1, once1 }));
  record('TB-53 the three clicks: off → always; always → off when nothing is open; once → always; always → once '
    + 'while request 1 is open (T1 waits for your decision); no confirmation dialog for any click',
  on1.ok && offAgain.ok && once && on2.ok && once2.ok && confirms.length === 0
    && board?.requests[0]?.status === 'open', brief({ offAgain: offAgain.sw, on2: on2.sw, once2: once2.sw,
    request: board?.requests[0]?.status, confirms }));
  await sendMessage(ctx, tab, 'Cancel it');
  await settle(ctx, who, 60000);
  const back = await switchIs(ctx, tab, 'off');
  record('TB-53 after the request is cancelled while "Until done", task mode goes back to off by itself (the row '
    + 'unchecked, the model button without "Task mode")',
  back.ok && readBoard(ctx, who.sessionId)?.requests[0]?.status === 'cancelled', brief(back));
}

/** @brief 顶栏只有右栏开关（不分屏时）：没有协作开关，也没有任何 team-switch 元素在模型菜单之外（§13.1）。 */
async function topBarHasNoSwitch(ctx, tab) {
  const bar = await ctx.page.locator(`${paneSel(tab)} > .topbar`).evaluate((el) => ({
    buttons: [...el.querySelectorAll('.topbar-actions button')].map((button) => button.getAttribute('aria-label')),
    switches: el.querySelectorAll('[data-testid="team-switch"], [role="switch"]').length }));
  const outside = await ctx.page.locator(`${paneSel(tab)} [data-testid="team-switch"]`).count();
  record('TB-53 the top bar has no task mode switch any more: its buttons are only "Toggle changes", and with the '
    + 'model menu closed the pane has no team-switch element', same(bar.buttons, ['Toggle changes'])
    && bar.switches === 0 && outside === 0, brief({ bar, outside }));
}

/**
 * @brief 点了 Task mode 一行菜单不关、焦点留在这一行（§13.1）：打开后范围的三节换成说明“Task mode picks the model for
 *        each agent”（pickLocked）；切换中这一行只是 aria-disabled，焦点不掉，所以接着按 Space 就能关掉，三节和原来的
 *        说明回来；Esc 关菜单、焦点回到模型按钮。
 */
async function menuStaysOpen(ctx, tab) {
  const menu = ctx.page.locator(modelMenuSel(tab));
  const look = () => menu.evaluate((el) => ({ sections: el.querySelectorAll('[data-section]').length,
    note: el.querySelector('[data-testid="model-menu-note"]')?.textContent ?? null,
    tail: [...el.children].slice(-3).map((child) => child.dataset.testid ?? child.dataset.action ?? child.className),
    tasks: Boolean(el.querySelector('[data-action="see-background-tasks"]')),
    focused: document.activeElement?.dataset.testid ?? null }));
  await clickTeamSwitch(ctx, tab, 'always', { keepOpen: true });
  // 打开后 Task mode 一行下面有 See background tasks（协作模式下总有，model-menu.md“协作模式的菜单”）
  await poll(async () => { const now = await look(); return now.sections === 0 && now.tasks; }, 10000);
  const on = { open: await menu.count(), ...await look() };
  on.arrows = await menuArrows(ctx, ['ArrowDown', 'ArrowUp']);
  await watchPending(ctx, tab);
  await ctx.page.keyboard.press('Space');
  await ctx.page.waitForFunction((css) => document.querySelector(css)?.dataset.teamMode === 'off',
    modelButtonSel(tab), { timeout: 10000 }).catch(() => {});
  await poll(async () => (await look()).sections > 0, 10000);
  const off = { open: await menu.count(), ...await look() };
  off.arrows = await menuArrows(ctx, ['ArrowUp', 'ArrowDown']);
  off.enter = await enterTwice(ctx, tab);
  await ctx.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const closed = { open: await menu.count(),
    focus: await ctx.page.evaluate(() => document.activeElement?.dataset.testid ?? null) };
  const order = ['model-menu-note', 'task-mode-group', 'manage-models'];
  record('TB-53 clicking the Task mode row keeps the model menu open with the focus on the row: turned on, the '
    + 'Groups/Providers/Models sections give way to the note "Task mode picks the model for each agent"; Space on the '
    + 'still-focused row turns it off and the sections and "Applies to this session only. …" come back, followed by '
    + 'the Task mode row and Manage models (the sections, the note, Task mode, Manage models); Enter on the row turns '
    + 'it on and off again the same way; Esc closes the menu and the focus returns to the model button',
  on.open === 1 && on.sections === 0 && on.note === TASK_PICKS && on.focused === 'team-switch' && off.open === 1
    && off.sections > 0 && off.note?.startsWith('Applies to this session only.') && same(off.tail, order)
    && same(on.tail, order) && off.focused === 'team-switch' && same(off.enter, ['always', 'off'])
    && closed.open === 0 && closed.focus === 'model-button', brief({ on, off, closed }));
  record('TB-53 after a click on the Task mode row ↑ ↓ move between the usable items of the open menu (team-switch.md, '
    + 'the row after a click): in task mode (no range items) ↓ goes to "See background tasks" and ↑ back to the '
    + 'row; off, ↑ goes to the last range item and ↓ back to the row',
  same(on.arrows, ['see-background-tasks', 'team-switch'])
    && same(off.arrows, ['menuitemradio', 'team-switch']), brief({ on: on.arrows, off: off.arrows }));
  await pendingChecks(ctx, tab);
}

/** @brief 焦点在 Task mode 一行上按两次 Enter：每次等模型按钮的 data-team-mode 变了，返回两次之后的模式。 */
async function enterTwice(ctx, tab) {
  const modes = [];
  for (const want of ['always', 'off']) {
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForFunction(({ css, mode }) => document.querySelector(css)?.dataset.teamMode === mode,
      { css: modelButtonSel(tab), mode: want }, { timeout: 10000 }).catch(() => {});
    modes.push((await teamSwitch(ctx, tab)).mode);
  }
  return modes;
}

/**
 * @brief 切换中（team-switch.md“切换中”）：在这一行出现 data-pending 的那一刻记下它的样子与焦点，并在这时再点它一下
 *        （synthetic：切换中的点击不应再发 session.setTeam）。结果在 window.__pendingSeen。
 */
function watchPending(ctx, tab) {
  return ctx.page.locator(taskRowSel(tab)).evaluate((row) => {
    window.__pendingSeen = null;
    const observer = new MutationObserver(() => {
      if (row.dataset.pending !== 'true' || window.__pendingSeen) return;
      window.__pendingSeen = { aria: row.getAttribute('aria-disabled'), disabled: row.disabled,
        checked: row.getAttribute('aria-checked'), focused: document.activeElement === row };
      row.click();
      observer.disconnect();
    });
    observer.observe(row, { attributes: true, attributeFilter: ['data-pending'] });
  });
}

/**
 * @brief watchPending 看到的切换中，加 F8 里每次切换只记了一条：点开、Space 关（切换中的那一下点击没有再发命令）、
 *        Enter 开、Enter 关，共两条 Task mode on、两条 Task mode off。
 */
async function pendingChecks(ctx, tab) {
  const seen = await ctx.page.evaluate(() => window.__pendingSeen);
  const actions = await recentActions(ctx, tab, 'TB-53 check of the switches');
  const offs = actions.filter((line) => line.endsWith('Task mode off'));
  const ons = actions.filter((line) => line.endsWith('Task mode on'));
  record('TB-53 while switching the Task mode row keeps its look but is unavailable: aria-disabled="true" and '
    + 'data-pending="true" (not natively disabled, still aria-checked as before) with the focus kept on it; a click '
    + 'at that moment does nothing (F8 lists one entry per switch: two "Task mode on" and two "Task mode off" for '
    + 'click, Space, Enter, Enter — not a third off)', seen?.aria === 'true' && seen.disabled === false
    && seen.checked === 'true' && seen.focused === true && offs.length === 2 && ons.length === 2,
  brief({ seen, actions: actions.slice(-6) }));
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
    { row: 'unknown tool', files: { 'bad.md': roleText(`name: bad\n${d}\ntools: [read, hammer]`) },
      line: `${bad}: unknown tool "hammer"` },
    { row: 'TaskBoard tool', files: { 'bad.md': roleText(`name: bad\n${d}\ntools: [read, board_read]`) },
      line: `${bad}: "board_read" is added by Mori; remove it` },
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

/** @brief 拒绝启动时不能发送（Enter 不发出、草稿不丢），模型菜单里的 Task mode 一行不可用（§13.1）。 */
async function blockedSending(ctx, who) {
  const since = Date.now();
  const box = ctx.page.locator(`${paneSel(who.tab)} .composer textarea`);
  await box.fill('plain while the agent files are wrong');
  await box.press('Enter');
  await sleep(1500);
  const pane = await paneState(ctx.page, who.tab);
  const sw = await teamSwitch(ctx, who.tab);
  const row = await taskModeRow(ctx, who.tab);
  record('TB-01 while agents_invalid the session cannot send: Enter sends nothing (no request reaches the endpoint, '
    + 'no user bubble) and the draft stays', scenarioRequests(ctx.ep, null, { since }).length === 0
    && pane.users.length === 0 && pane.draft === 'plain while the agent files are wrong', brief(pane));
  record('TB-53 task mode cannot be switched while the session is refused with agents_invalid (§13.1): the model '
    + 'menu opens but its Task mode row is disabled and unchecked, and the model button stays in off mode',
  row.disabled === true && row.checked === 'false' && sw.mode === 'off', brief({ row, sw }));
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
  // 改好之前会话按只有基座跑、这一行不可用（blockedSending）；Check again 之后第二行按新的立项持有者
  const on = await clickTo(ctx, who.tab, 'always', 'planner');
  const off = await clickTo(ctx, who.tab, 'off', 'planner');
  record('TB-53 after Check again the Task mode row follows the new TeamState: turned on, its second line reads '
    + '"Messages go to planner first" (the new create holder; before the fix the row was unavailable and Mori held '
    + 'create), then it turns off again (team-switch.md and team-blocked.md, Check again passing)', on.ok && off.ok,
  brief({ on: on.row, off: off.row }));
  const actions = await recentActions(ctx, who.tab);
  record('TB-01 Check again is recorded in F8 as "Check agent files" (the saved report\'s recent actions)',
    actions.filter((line) => line.endsWith('Check agent files')).length >= 2, brief(actions.slice(-12)));
}

// ---------- TB-01 各字段、TB-02 分开配置、TB-09 工具（脚本 tb-roles-fields） ----------

/** chat 的正文：几行、缩进、标点与中文，看它原样进 system prompt（§4.1、§8.5） */
const CHAT_BODY = 'You are chat: you talk with the user.\n\n  Indented line with <tags> & "quotes" — 中文也原样。\n'
  + '- first rule\n- second rule';

/** proposal §6.2 的分开配置，再加一个订阅者；各角色写不同的字段，看每个字段都读出并生效 */
const FIELD_ROLES = [
  { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'], body: CHAT_BODY },
  { name: 'planner', description: 'Decides how to split each request and closes it', seats: ['create', 'close'],
    tools: ['read', 'ls', 'bash'], models: ['tbb'] },
  { name: 'executor', description: 'Changes code and runs commands to finish a task', tools: ['read', 'write'],
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

/**
 * @brief 分开配置的整条路（脚本 tb-roles-fields）：先在关闭模式问一次，开关切到 always 再切回（悬停里的立项持有者），
 *        /task 登记 → executor 写 → reviewer 复核 → planner 结案 → watcher 订阅 → chat 汇报，回到关闭模式再问一次。
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
    + 'holders {dialog: chat, create: planner, close: planner}; with task mode on the second line of the Task mode '
    + 'row reads "Messages go to planner first"', same(team?.holders, { dialog: 'chat', create: 'planner',
    close: 'planner' }) && on.ok && off.ok, brief({ holders: team?.holders, on: on.row.hint }));
  record('TB-53 the second line of the Task mode row names the create role of the session: "Messages go to planner '
    + 'first" when planner holds create', on.ok && on.row.hint === 'Messages go to planner first', brief(on.row));
  await sendMessage(ctx, tab, 'Hello first tb-scenario:tb-roles-fields');
  await settle(ctx, who, 60000);
  await sendMessage(ctx, tab, 'Write the note tb-scenario:tb-roles-fields', { team: true });
  await offWithBackground(ctx, who);
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
 * @brief 关闭模式下只有后台在运行（team-switch.md“只有后台在运行”：同一般）：需求关闭、汇报的回合结束、做完为止回到 off 时，
 *        watcher 的订阅还在跑（脚本让它等 8 秒）；这时打开模型菜单，范围的项可用、说明是平常的那句，Task mode 一行可用。
 */
async function offWithBackground(ctx, who) {
  const at = await poll(async () => {
    const pane = await paneState(ctx.page, who.tab);
    const info = await teamStateOf(ctx, who.sessionFile);
    return (await teamSwitch(ctx, who.tab)).mode === 'off' && info?.background === true && !pane.running
      && !pane.sending ? info : null;
  }, 120000, 100);
  let menu = null;
  if (at) {
    await openModelMenu(ctx, who.tab);
    menu = await ctx.page.locator(modelMenuSel(who.tab)).evaluate((el) => {
      const items = [...el.querySelectorAll('[role="menuitemradio"]')];
      const row = el.querySelector('[data-testid="team-switch"]');
      return { items: items.length, disabled: items.filter((item) => item.disabled).length,
        note: el.querySelector('[data-testid="model-menu-note"]')?.textContent ?? null,
        row: Boolean(row) && !row.disabled && row.getAttribute('aria-disabled') !== 'true' };
    });
    menu.background = (await teamStateOf(ctx, who.sessionFile))?.background;
    await closeModelMenu(ctx, who.tab);
  }
  record('TB-53 in off mode while only background agents run (the request closed and task mode went back to off, the '
    + 'watcher subscription still running) the model menu is as when idle: the range items are usable, the note is '
    + '"Applies to this session only. …" and the Task mode row is usable', Boolean(at) && menu.background === true
    && menu.items > 0 && menu.disabled === 0 && menu.note?.startsWith('Applies to this session only.') === true
    && menu.row, brief({ at, menu }));
}

/** @brief TB-01：合格的文件读出 name、description、seats（TeamState 与 next 枚举的说明）、tools。 */
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
  const create = requestsOf(ctx, 'tb-roles-fields', 'planner', 'create');
  record('TB-01 a valid file reads tools: executor (tools [read, write]) gets exactly read, write and its TaskBoard '
    + 'tools on its task; planner (tools [read, ls, bash]) gets read and ls (its read-class tools) on create',
  exec.length > 0 && exec.every((request) => same(sortedTools(request), ['agent_message', 'board_read', 'read',
    'read_session', 'task_handoff', 'write'])) && create.length > 0
    && create.every((request) => sortedTools(request).includes('ls') && sortedTools(request).includes('read')
      && !sortedTools(request).includes('bash')),
  brief({ exec: sortedTools(exec[0]), create: sortedTools(create[0]) }));
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

/**
 * @brief TB-09：协作模式下对话会话只传话（chat 没写 tools：读取类是 read、ls），回到 off 后恢复，TaskBoard 上有了需求
 *        所以另有 board_read、read_session 与关闭模式的工作卡（TB-59）；对话的工作卡带立项的决定与最后一段文字。
 */
function dialogTools(ctx, obs) {
  const offReqs = requestsOf(ctx, 'tb-roles-fields', 'chat', 'off-dialog');
  const teamReqs = requestsOf(ctx, 'tb-roles-fields', 'chat', 'team-dialog');
  const first = offReqs.filter((request) => request.info.k === 1);
  const last = offReqs.filter((request) => request.info.k === 4);
  record('TB-09 in task mode the dialog session\'s requests have no write or command tool (only read, ls, '
    + 'board_read, read_session, agent_message); back in off mode the requests have the set from before task mode '
    + '(read, bash, edit, write, agent_message, memory: memory spec §7.6, and subagent: subagent spec §2) plus '
    + 'board_read and read_session (the board has a request now, TB-59)', teamReqs.length >= 2
    && teamReqs.every((request) => same(sortedTools(request), ['agent_message', 'board_read', 'ls', 'read',
      'read_session']))
    && first.length === 1 && last.length === 1
    && same(sortedTools(first[0]), ['agent_message', 'bash', 'edit', 'memory', 'read', 'subagent', 'write'])
    && same(sortedTools(last[0]), [...sortedTools(first[0]), 'board_read', 'read_session'].sort())
    && obs.modeAfter === 'off',
  brief({ team: teamReqs.map(sortedTools), off1: first.map(sortedTools), off4: last.map(sortedTools),
    mode: obs.modeAfter }));
  const offCard = last[0]?.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)).at(-1) ?? '';
  record('TB-59 split roles: back in off mode after the request closed, chat\'s request ends with the off-mode work '
    + 'card ("Task mode: off", the line that tools are the agent\'s and never the user\'s, request 1 listed) and has '
    + 'no create tool', offCard.startsWith('<mori-work-card>\nTask mode: off\n')
    && offCard.includes(`\n${OFF_CARD_TOOLS}`) && /\n- Request 1: .* · done\n/.test(offCard)
    && !(last[0]?.tools ?? []).some((name) => name.startsWith('request_') || name.startsWith('task_')),
  brief(offCard));
  const card = teamReqs.find((request) => request.info.k === 2);
  const lastUser = card?.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)).at(-1) ?? '';
  const want = `For this message planner decided: new request (Request 1); their note: "${ROLES_TEXT.fieldsNote}"`;
  record('TB-09 the dialog\'s work card (the last message of its request) carries planner\'s decision and last text: '
    + `"${want}"`, lastUser.startsWith('<mori-work-card>') && lastUser.includes(want), brief(lastUser));
}

/** @brief TB-09：立项、结案会话的请求里只有读取类工具与它们的 TaskBoard 工具（planner 写的 bash 不在）。 */
function createTools(ctx) {
  const create = requestsOf(ctx, 'tb-roles-fields', 'planner', 'create');
  const close = requestsOf(ctx, 'tb-roles-fields', 'planner', 'close');
  record('TB-09 the create and close sessions\' requests have only read-class tools and their TaskBoard tools: '
    + 'create = read, ls + board_read, read_session, agent_message, request_*, task_create, task_edit, '
    + 'reply_via_dialog + memory (memory spec §7.6); close = read, ls + board_read, read_session, agent_message, '
    + 'task_handoff, request_close (planner\'s bash is left out)', create.length > 0
    && create.every((request) => same(sortedTools(request), ['agent_message', 'board_read', 'ls', 'memory', 'read',
      'read_session', 'reply_via_dialog', 'request_cancel', 'request_submit', 'request_update', 'task_create',
      'task_edit'])) && close.length > 0
    && close.every((request) => same(sortedTools(request), ['agent_message', 'board_read', 'ls', 'read',
      'read_session', 'request_close', 'task_handoff'])),
  brief({ create: sortedTools(create[0]), close: sortedTools(close[0]) }));
}

// ---------- TB-09：关闭模式下对话角色写了 tools、会话打开之后才连上的 MCP 服务、退出重开后关掉协作模式 ----------

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

/** @brief 关闭模式下 chat.md 写 tools: [read]（脚本 tb-roles-tools）：请求里没有 bash、edit、write，调用它们被拒绝。 */
async function readOnlyDialog(ctx) {
  const project = tempProject('mori-tb-roles-tools-');
  writeRoles(project, [{ name: 'chat', description: 'Talks with the user', seats: ['dialog'], tools: ['read'] },
    { name: 'executor', description: 'Changes code and runs commands to finish a task' }]);
  const readme = readFileSync(join(project, 'README.md'), 'utf8');
  const tab = await openProject(ctx, project);
  // 全部允许：调用即使到了执行那一步也不会停在批准上，拒绝只能来自工具的限制。
  await allowAll(ctx, tab);
  const who = await whoOf(ctx, tab);
  await sendMessage(ctx, tab, 'Try to change files tb-scenario:tb-roles-tools');
  await settle(ctx, who, 60000);
  const requests = requestsOf(ctx, 'tb-roles-tools', 'chat', 'off-dialog');
  const tried = changeAttempts(project, readme, readJsonl(who.sessionFile).slice(1));
  record('TB-09 off mode with chat.md "tools: [read]": every dialog request has only read, agent_message and memory '
    + '(memory spec §7.6; no bash, edit, write)', requests.length >= 4 && requests.every((request) => same(
    sortedTools(request), ['agent_message', 'memory', 'read'])), brief(requests.map(sortedTools)));
  record('TB-09 off mode with chat.md "tools: [read]": calling bash, edit and write is refused (error results), the '
    + 'command did not run and no file changed', ['bash', 'edit', 'write'].every((tool) => tried.results[tool]?.isError
    === true) && tried.untouched, brief(tried.view));
}

/**
 * @brief 协作模式下、会话打开之后才注册工具的 MCP 服务（脚本 tb-roles-mcp；合成 MCP 服务连上 8 秒后才列出工具，
 *        对话第一次请求的回复晚 12 秒到，工具在这次运行中注册）：权限为“每次询问”，对话调用 bash、edit、write 和那个
 *        MCP 工具。
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
    + 'pi enables the server\'s tool once it registers, and the dialog calling it gets the §5.5 reason "Task mode is '
    + 'on: the dialog agent only relays; the work is done in tasks."',
  (mcpLog.match(/"tools\/list"/g) ?? []).length >= 2 && requests.length >= 2
    && !requests[0].tools.includes(ROLES_TEXT.mcpTool)
    && withMcp > 0 && tried.results[ROLES_TEXT.mcpTool]?.isError === true
    && textOfMessage(tried.results[ROLES_TEXT.mcpTool]) === RELAY_ONLY,
  brief({ tools: requests.map(sortedTools), mcp: tried.view[ROLES_TEXT.mcpTool] }));
  // §5.5 的理由只给到这次运行里被启用的工具（这里是 MCP 工具）；bash、edit、write 没有启用，pi 在任何钩子之前就以
  // "Tool <name> not found" 拒绝（pi 1.3.0 没有白名单的会话只启用新注册的工具），见交付说明里的规格缺口。
  record('TB-09 with that late MCP server, the dialog calling bash, edit and write is refused (error results), no '
    + 'file changes and no approval card appears (permission is Ask each time)',
  ['bash', 'edit', 'write'].every((tool) => tried.results[tool]?.isError === true) && tried.untouched
    && cards.length === 0, brief({ view: tried.view, untouched: tried.untouched, cards }));
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

/** @brief 分开配置的 /task 流程：立项、task、结案三种实例；检查文件、侧栏、事件、扩展询问与信任。 */
async function instances(ctx) {
  const project = tempProject('mori-tb-roles-inst-');
  writeRoles(project, SPLIT_ROLES);
  const log = join(args.shots, `ask-probe-${Date.now()}.jsonl`);
  writeAskProbe(project, log);
  const since = Date.now();
  const tab = await openTrustingOnce(ctx, project);
  const who = await whoOf(ctx, tab);
  await sendMessage(ctx, tab, 'Read it tb-scenario:tb-roles-instances', { team: true });
  await settle(ctx, who, 120000);
  const filesNow = instanceFiles(ctx, who.sessionId);
  instanceStorage(ctx, who, filesNow);
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

/** @brief TB-09：协作模式下退出 App、重新打开、关掉协作模式后，请求里又有 bash、edit、write（与进入协作模式前相同）。 */
async function restartDialog(ctx, who) {
  who.tab = await reopenSession(ctx, who.sessionFile);
  const kept = await switchIs(ctx, who.tab, 'always', 'planner');
  const off = await clickTo(ctx, who.tab, 'off', 'planner');
  await sendMessage(ctx, who.tab, 'Back off after the restart');
  await settle(ctx, who, 60000);
  const off1 = requestsOf(ctx, 'tb-roles-restart', 'chat', 'off-dialog').filter((request) => request.info.k === 1);
  const off3 = requestsOf(ctx, 'tb-roles-restart', 'chat', 'off-dialog').filter((request) => request.info.k === 3);
  const team = requestsOf(ctx, 'tb-roles-restart', 'chat', 'team-dialog');
  record('TB-09 after task mode, quitting Mori, reopening the session (still in task mode) and turning it off, '
    + 'the dialog request has bash, edit and write again — the same tools as before team mode',
  kept.ok && off.ok && off1.length === 1 && off3.length === 1 && ['bash', 'edit', 'write']
    .every((tool) => off3[0].tools.includes(tool)) && same(sortedTools(off3[0]), sortedTools(off1[0]))
    && team.length >= 1 && team.every((request) => !request.tools.includes('bash')),
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

/**
 * @brief 打开会话时（Starting…）切不了 Task mode：没有模型按钮（第一次打开）或它不可用，模型菜单没开过；后台进程退出后
 *        模型按钮不可用、点了不开菜单，仍显示最后知道的模式（2026-10-26 起开关在模型菜单里）。
 */
async function notReady(ctx) {
  const records = [...(ctx.notReadyBefore ?? []), ...await ctx.page.evaluate(() => window.__tbNotReady ?? [])];
  const opening = records.filter((item) => item.text === 'Starting…');
  const tab = await ctx.page.locator(SHOWN_PANE).first().getAttribute('data-tab');
  // 退出前不在 off：“最后知道的 mode”与默认的 off 不同，检查才分得出来
  if ((await teamSwitch(ctx, tab)).mode === 'off') await clickTo(ctx, tab, 'always');
  const last = await teamSwitch(ctx, tab);
  // 退出时模型菜单开着：它随之关上（team-switch.md“界面没准备好”）
  await openModelMenu(ctx, tab);
  await killTbKernel(ctx);
  const exited = await poll(async () => {
    const sw = await teamSwitch(ctx, tab).catch(() => null);
    const wait = await ctx.page.locator(`${paneSel(tab)} [data-testid="not-ready"]`).textContent().catch(() => null);
    return sw?.disabled && wait === 'Mori’s background process crashed' ? { sw, wait } : null;
  }, 20000);
  await exitedChecks(ctx, tab, last, exited);
  await ctx.page.locator(modelButtonSel(tab)).click().catch(() => {});
  await sleep(300);
  const menu = await ctx.page.locator(modelMenuSel(tab)).count();
  const blocked = (item) => !item.menu && (!item.button || item.disabled);
  record('TB-53 while the UI is not ready task mode cannot be switched: every time a pane showed "Starting…" while '
    + 'its session opened there was no model button (first open) or it was aria-disabled, and no model menu was '
    + 'open; after the kernel exited ("Mori’s background process crashed") the model button is aria-disabled, a '
    + 'click opens no menu, and it still shows the last mode ("Task mode · …")',
  opening.length >= 3 && opening.every(blocked) && Boolean(exited) && last.mode !== 'off'
    && exited.sw.mode === last.mode && exited.sw.text === last.text && menu === 0,
  brief({ opening: opening.length, bad: opening.filter((item) => !blocked(item)), last, exited, menu }));
}

/**
 * @brief notReady 里后台进程退出之后：开着的模型菜单关上、焦点回到模型按钮，按钮悬停三行（文字、Task mode 的说明、原因）；
 *        输入框里写 /task off 按 Enter 不起作用（与普通发送一样，team-switch.md“输入框里的 /task”的“界面没准备好”）。
 * @param last 退出前模型按钮的样子；exited 退出后等到的 { sw, wait }
 */
async function exitedChecks(ctx, tab, last, exited) {
  const closed = { menu: await ctx.page.locator(modelMenuSel(tab)).count(),
    focus: await ctx.page.evaluate(() => document.activeElement?.dataset.testid ?? null) };
  const lines = exited?.sw.title?.split('\n') ?? [];
  record('TB-53 while the UI is not ready: the model menu that was open when the kernel exited is closed, the focus is '
    + 'back on the model button, and the hover of the button reads its text, "Task mode picks the model for each '
    + 'agent" and the reason "Mori’s background process crashed" as the third line', closed.menu === 0
    && closed.focus === 'model-button' && same(lines, [last.text, TASK_PICKS, 'Mori’s background process crashed']),
  brief({ closed, lines }));
  const box = ctx.page.locator(`${paneSel(tab)} .composer textarea`);
  await box.fill('/task off');
  await box.press('Enter');
  await sleep(1000);
  const typed = { sw: await teamSwitch(ctx, tab), draft: (await paneState(ctx.page, tab)).draft };
  await box.fill('');
  record('TB-53 while the UI is not ready "/task off" typed in the input box does nothing on Enter, like any send: '
    + 'the model button keeps the last mode ("Task mode · …") and the draft "/task off" stays',
  typed.sw.mode === last.mode && typed.sw.text.startsWith('Task mode · ') && typed.draft === '/task off',
  brief(typed));
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
    record('TB-43 when mori-team fails to load the session does not open: "Failed to open session: The TaskBoard '
      + 'extension failed to load: …" is shown, the pane stays "Session didn’t open" and no session file is written '
      + '(fault injected into a copy of the build)', typeof failed === 'string'
      && failed.includes('The TaskBoard extension failed to load') && failed.includes('synthetic fault injection')
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
const steps = { v0same, switches, files, fields, readOnlyDialog, lateMcp, instances, restart, notReady };

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
