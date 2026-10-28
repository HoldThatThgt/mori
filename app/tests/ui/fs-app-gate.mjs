// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-gate：路径闸在界面上的样子。真正的 Mori
// （界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic：关键词模式、脚本 fs-team、
// 增强脚本 enhance.mjs），逐条验收这些编号在 App 层的通过条件：
//   FS-34 没人能批（增强会话里写到工作路径外的命令被拒绝、没有卡）、FS-35 预告与更正（预告 full、随后要批准的工具卡）、
//   FS-36 卡片的原因行与第二个按钮（含后台卡、界面重新载入）、FS-37 权限按钮与菜单（确认框、Forget、F8 与操作记录）、
//   FS-38 工具卡的标签与 Denied（实时与重新打开会话）、FS-39 身份句（切模式后下一次运行、增强会话）。
// 依据：file-system-permissions.md §6.1、§6.7–§6.16，file-system.md §12、§14，屏幕表 docs/v1/screens/fs-permissions.md。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-gate.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-gate(-packaged).json（--only 时 fs-partial-app-gate…，不计入覆盖检查），截图与 app.log 在
// test-results/fs-app-gate/。端口：合成端点 5000，记录代理 5001（fs-helpers FS_PORTS.gate）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商（fs-helpers seedFsUserData）；临时目录 ROOT 下
// 六个项目：tools（信任；.pi/mcp.json 的合成 MCP 服务与一个把带标记的 bash 调用拦住几秒的项目扩展）、perm、label、
// ident、team（没有角色文件，协作模式下是合并会话）、fs34-enh（增强）；记忆目录下一个空文件夹（FS-38）；重新启动之前
// label 项目的 pi 会话目录里一个手写的用户会话文件，里面是几种不出卡的程序拒绝（FS-38，seedDenialSession）。启动后先
// away.set { timeout: 'never' }（§19.4）。
// 第 1 步的构建上 FS-38 的收窄两条（relayDenial 与 reopenReal 的 RELAY_ONLY）预期失败：用户会话的收窄与协作模式下
// 合并会话的工具开关（team?.userNarrowing()、applyDutyTools，§8.5、§8.6）由第 3 步接上；断言照 §19.2 不改。

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { FS_TEXT } from '../fake-endpoint/scenarios/fs.mjs';
import {
  FS_MODEL, FS_PROVIDER, FULL_CONFIRM, HINT, MEMORY_FILES_ONLY, MENU_NOTE, MODE_NOTE, REASON_LINE, RELAY_ONLY,
  SECOND_LABEL, answerCard, approvalOf, bashPath, bridge, brief, cardOf, cardsSince, closePermissionMenu,
  deniedStatus, errorLine, fillSession, fsArgs, fsProject, fsRecorder, fsRoot, fsUserData, gateEvents, identityLines,
  kernelEvents, liveInfo, nobodyText, openFsSession, openPermissionMenu, paneSel, permissionMenuState, poll,
  readJsonl, reloadFsUi, reopenFs, requestsSince, restartFsApp, runSuite, same, seedFsUserData, sendFs, setPermission,
  sleep, startFsApp, startFsEndpoint, teamMessage, toolCardsOf, waitCard, waitIdleFs, waitToolCard, writeMcpServer,
} from './fs-helpers.mjs';
import { modeProblems, permissionState } from './m2-helpers.mjs';
import {
  chatItems, headlessFiles, piSessionDir, quietScript, say, seedSession, toolResultsOf, waitSettled, writeScript,
} from './mem-enhance-helpers.mjs';
import { sendMessage, showTab, waitTeamIdle } from './tb-helpers.mjs';

const args = fsArgs('gate');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面（项目的上一级），写到外面的目标也在这里（synthetic） */
const ROOT = fsRoot('mori-fs-gate-');
/** 增强脚本文件（FAKE_ENHANCE_SCRIPT，synthetic） */
const SCRIPT = join(ROOT, 'enhance-script.json');
/** FS-35：项目扩展拦住的 bash 调用的标记与拦住的时长（预告之后、批准处理器之前切换权限模式） */
const HOLD_MARK = 'fs35-hold';
const HOLD_MS = 8000;
/** FS-38：记忆目录下的空文件夹（synthetic），先按目录放行，再让 mori-memory 拒绝写进去的 write */
const MEM_DIR = 'fs38-synthetic';
/** FS-34：增强会话里写到工作路径外的命令写的文件（在项目的上一级） */
const OUTSIDE_FILE = 'fs34-outside.txt';
/** 等批准时工具卡的状态行（tool-cards.md） */
const WAITING = 'Waiting for your approval';
/** 权限菜单里放行列表的标题（§6.13、fs-permissions.md“权限菜单”） */
const CAPTION = 'Allowed for this session:';

// ---------- 准备 ----------

/**
 * @brief synthetic 项目扩展（FS-35）：tool_call 里把命令含 HOLD_MARK 的 bash 调用拦住 HOLD_MS 毫秒再放过；项目扩展排在
 *        Mori 的 inline 扩展之前，所以这段时间在预告（tool_execution_start）之后、路径闸的处理器之前。
 */
function writeHoldExtension(project) {
  const source = [
    '// synthetic: written by tests/ui/fs-app-gate.mjs (FS-35); holds a bash call whose command has the marker,',
    '// so that the permission mode can change between the announcement and the approval handler.',
    'export default function (pi) {',
    "  pi.on('tool_call', async (event) => {",
    '    const command = event.input?.command;',
    `    if (event.toolName !== 'bash' || typeof command !== 'string' || !command.includes('${HOLD_MARK}')) return;`,
    `    await new Promise((done) => setTimeout(done, ${HOLD_MS}));`,
    '  });',
    '}',
    '',
  ].join('\n');
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'fs35-hold.ts'), source);
}

/** @brief 合成端点、项目、数据目录（synthetic test setup），启动 App 并设 away never。 */
async function setup(ctx) {
  writeScript(SCRIPT, {});
  ctx.p = Object.fromEntries(['tools', 'perm', 'label', 'ident', 'team', 'fs34-enh']
    .map((name) => [name, fsProject(ROOT, name)]));
  writeMcpServer(ctx.p.tools);
  writeHoldExtension(ctx.p.tools);
  mkdirSync(join(ctx.userData, 'memory', MEM_DIR), { recursive: true });
  ctx.ep = await startFsEndpoint('gate', { FAKE_ENHANCE_SCRIPT: SCRIPT });
  seedFsUserData(ctx, { trusted: [ctx.p.tools] });
  await startFsApp(ctx);
}

/** @brief 等这个会话的工具里有 name（MCP 服务连上之后才注册）；最多 30 秒。 */
async function waitTool(ctx, who, name) {
  const ok = await poll(async () => ((await liveInfo(ctx, who.sessionFile).catch(() => null))?.tools ?? [])
    .includes(name), 30000, 300);
  if (!ok) throw new Error(`${name} is not registered in ${who.tab}`);
}

/** @brief 在 who 这个会话里发一条消息，要求出卡；返回卡（cardOf）。 */
async function cardFor(ctx, who, text) {
  const { outcome } = await sendFs(ctx, who, text);
  if (outcome !== 'card') throw new Error(`no approval card for "${text}"`);
  return cardOf(ctx, who.tab);
}

/** @brief 拒绝看得到的那张卡，等这次运行结束。 */
async function denyAndSettle(ctx, who) {
  await answerCard(ctx, who.tab, 'deny');
  await waitIdleFs(ctx, who.tab);
}

// ---------- FS-34、FS-39：增强会话（没人能批） ----------

/**
 * @brief 增强会话的准备：今天的一段合成会话、脚本（TASTE 跑一条里面的命令、一条写到外面的命令），打开增强并运行。
 * @return { cwd, since, events（这段时间这个项目的全部增强进度，waitSettled） }
 */
async function runEnhancement(ctx) {
  const cwd = ctx.p['fs34-enh'];
  seedSession(ctx.userData, cwd, { name: 'FS-34 session', items: chatItems(['Question about fs34-enh',
    'Answer one.', 'Another question', 'Answer two.'], Date.now() - 30 * 60000) });
  writeScript(SCRIPT, { ...quietScript('@fs34-enh'), 'taste@fs34-enh': [
    { call: 'bash', args: { command: 'echo fs34-inside' } },
    { call: 'bash', args: { command: `echo fs34 > ../${OUTSIDE_FILE}` } }, say('FS-34 done.')] });
  const set = await bridge(ctx, { type: 'enhance.set', cwd, enabled: true });
  if (set?.error) throw new Error(`enhance.set: ${set.error}`);
  const since = Date.now();
  const run = await bridge(ctx, { type: 'enhance.run', cwd });
  if (run?.error) throw new Error(`enhance.run: ${run.error}`);
  const events = await waitSettled(ctx, cwd, since, 3);
  return { cwd, since, events };
}

/**
 * @brief FS-34：增强会话（canAsk 为假）里工作路径里的命令照常执行，写到工作路径外的命令立即按 §6.15 的原文拒绝，
 *        文件没有写出；FS-39：增强会话的请求里身份段第二行是没人能批那一句。
 *        “没有卡”的依据：窗口里没有出现过批准卡、没有收到 mori.approval_request（无头会话的事件本来就不进窗口，
 *        MEM-20），并且 TASTE 在 away 为 never 时跑到 done（发出过批准请求的话会一直挂着、跑不完）。
 */
async function enhancement(ctx) {
  const { cwd, since, events } = await runEnhancement(ctx);
  const results = headlessFiles(ctx.userData, cwd).flatMap((file) => toolResultsOf(file.entries))
    .filter((result) => result.tool === 'bash');
  const [inside, outside] = results;
  const target = win32.resolve(cwd, '..', OUTSIDE_FILE);
  const taste = events.filter((e) => e.task === 'taste').map((e) => e.phase);
  const cards = await cardsSince(ctx, since);
  const asked = await kernelEvents(ctx, null, 'mori.approval_request', since);
  record('FS-34 in an enhancement run (nobody can approve) a command inside the working directory runs without asking',
    Boolean(inside) && !inside.isError && inside.text.includes('fs34-inside'), brief(inside));
  record('FS-34 in an enhancement run a command that writes outside the working directory is denied at once: its '
    + 'result is "Denied by Mori: nobody can approve tool calls in this run, and this call writes outside the working '
    + 'directory: <path>. Don\'t retry it.", the file is not written, no approval card or mori.approval_request '
    + 'appears and the TASTE run reaches done with away set to never (no approval request was left waiting)',
  outside?.isError === true && outside.text === nobodyText(`writes outside the working directory: ${target}`)
    && !existsSync(target) && cards.length === 0 && asked.length === 0
    && events.some((e) => e.phase === 'done' && e.task === 'taste'),
  brief({ outside, target, taste, cards, asked: asked.length }));
  const requests = requestsSince(ctx, since).filter((item) => item.lastUser.startsWith("You are running Mori's daily")
    && item.lastUser.includes('fs34-enh'));
  const bad = requests.filter((item) => !same(item.identity.lines, identityLines('none', item.tools)));
  record('FS-39 the enhancement session\'s requests have the "Nobody can approve tool calls in this run: …" sentence '
    + 'as the identity section\'s second line, the .work line after it and the fourth line ending with the appendix '
    + 'A.1.1 sentence for its tools', requests.length >= 3 && bad.length === 0,
  brief({ requests: requests.length, bad: bad.slice(0, 2).map((item) => item.identity.lines.slice(1)) }));
}

// ---------- FS-35：预告与更正 ----------

/**
 * @brief Full access 下发一条带 HOLD_MARK 的命令：预告 full，工具卡标上 Full access；项目扩展拦住处理器时切回 Ask each
 *        time，处理器要批准：后台进程再发一次 mori.tool_gate（ask）并出卡，工具卡是 Waiting for your approval、没有标签。
 */
async function preannounce(ctx) {
  const who = await openFsSession(ctx, ctx.p.tools);
  ctx.tools = who;
  await setPermission(ctx, who.tab, 'full');
  const since = Date.now();
  await sendMessage(ctx, who.tab, `run: echo ${HOLD_MARK}`);
  // 预告之后、项目扩展放过之前切换：补会话信息等读完卡再做，不占这段时间
  const labelled = await waitToolCard(ctx, who.tab, HOLD_MARK, (card) => card.badge === 'Full access', 20000);
  await setPermission(ctx, who.tab, 'ask');
  const card = await waitCard(ctx, who.tab, { timeout: HOLD_MS + 15000 });
  const tool = await waitToolCard(ctx, who.tab, HOLD_MARK, (item) => item.status === 'awaiting', 5000);
  await fillSession(ctx, who);
  const extensionErrors = await holdExtensionErrors(ctx, who);
  const gates = (await gateEvents(ctx, who.sessionId, since)).filter((item) => item.toolName === 'bash')
    .map((item) => item.gate);
  record('FS-35 a call announced as full (tool card labelled Full access) whose handler then asks (the mode changed in '
    + `between) gets a correcting mori.tool_gate (ask) and an approval card; its tool card reads "${WAITING}" with no `
    + 'label', labelled !== null && card?.tool === 'bash' && tool?.statusText === WAITING && tool.badge === null
    && same(gates, ['full', 'ask']), brief({ labelled, card, tool, gates, extensionErrors }));
  await denyAndSettle(ctx, who);
}

/**
 * @brief FS-35 的准备是否成立：会话的 extensionErrors（读不到时为 null，放进 FS-35 那条的 detail）。其中有拦住调用的
 *        synthetic 项目扩展（"<路径>: <原文>"，路径含 fs35-hold）时另记一条失败，这时 FS-35 的失败指向准备，不指向路径闸。
 */
async function holdExtensionErrors(ctx, who) {
  const info = who.sessionFile ? await liveInfo(ctx, who.sessionFile).catch(() => null) : null;
  const errors = info?.extensionErrors ?? null;
  const hold = (errors ?? []).filter((error) => error.includes(HOLD_MARK));
  if (hold.length > 0) {
    record('FS-35 test setup: the synthetic hold extension (.pi/extensions/fs35-hold.ts) did not load, so the mode '
      + 'could not change between the announcement and the handler', false, brief(hold));
  }
  return errors;
}

// ---------- FS-36：原因行与第二个按钮 ----------

/** @brief 一张卡与期望的原因行、“and {n} more”、第二个按钮相同。 */
function cardMatches(card, want) {
  return Boolean(card) && card.scope === want.scope && same(card.reasons, want.reasons ?? [])
    && card.more === (want.more ?? null) && same(card.second, want.second ?? null);
}

/** @brief 第二个按钮：按工具名放行（label 是工具名的说法，hint 是小字）。 */
const toolSecond = (label, hint) => ({ kind: 'tool', label: SECOND_LABEL.tool(label), hint });
/** @brief 第二个按钮：按一个目录放行。 */
const dirSecond = (dir) => ({ kind: 'dir', label: SECOND_LABEL.oneDir(dir), hint: HINT.oneDir });

/**
 * @brief 工作路径的上一级（词法路径）。词法上在工作路径外的目标不碰文件系统，它的真实路径就取词法路径（§6.3 第 1 条），
 *        所以写到上一级的原因行与按目录放行的目录（§6.9 的落点目录取真实路径）都是这个词法写法，不取 realpath。
 */
const parentOf = (who) => win32.resolve(who.cwd, '..');

/** @brief 写到外面（相对、绝对）、a/../b.md、.git/config 的卡（Alt+2 在受保护路径的卡上不起作用）。 */
async function reasonFiles(ctx, who) {
  const root = parentOf(who);
  const rel = await cardFor(ctx, who, 'write file: ..\\notes.md');
  record('FS-36 a write to ..\\notes.md shows "Writes outside the working directory: <real path>" and "Allow writes to '
    + '<folder> for this session" with its note', cardMatches(rel, { scope: 'outside', reasons: [{ reason: 'outside',
    text: REASON_LINE.outside(win32.resolve(who.cwd, '..\\notes.md')) }], second: dirSecond(root) }), brief(rel));
  await denyAndSettle(ctx, who);
  const absolute = join(root, 'fs36-abs.md');
  const abs = await cardFor(ctx, who, `write file: ${absolute}`);
  record('FS-36 a write to an absolute path outside shows "Writes outside the working directory: <path>"',
    cardMatches(abs, { scope: 'outside', reasons: [{ reason: 'outside', text: REASON_LINE.outside(absolute) }],
      second: dirSecond(root) }), brief(abs));
  await denyAndSettle(ctx, who);
  const inside = await cardFor(ctx, who, 'write file: a/../b.md');
  record('FS-36 a write to a/../b.md (inside after resolving) has no reason line (scope inside) and the button "Allow '
    + '“Write files” for this session" with its note', cardMatches(inside, { scope: 'inside',
    second: toolSecond('Write files', HINT.files('Write files')) }), brief(inside));
  await denyAndSettle(ctx, who);
  await protectedCard(ctx, who);
}

/**
 * @brief 在页面里记下下一次 Alt+2 派发完之后的 defaultPrevented（window.__fsAlt2，没按过时为 null）。App 的全局按键
 *        只在卡真的作出了选择时 preventDefault（answerFrontApproval 为真）；放到 setTimeout 里读，不管监听器谁先
 *        注册，读到的都是整个派发结束后的值。
 */
function watchAlt2(ctx) {
  return ctx.page.evaluate(() => {
    window.__fsAlt2 = null;
    window.addEventListener('keydown', function watch(event) {
      if (!event.altKey || event.code !== 'Digit2') return;
      window.removeEventListener('keydown', watch);
      setTimeout(() => { window.__fsAlt2 = event.defaultPrevented; }, 0);
    });
  });
}

/**
 * @brief 写 .git/config：Protected path: <真实路径>，没有第二个按钮，Alt+2 不起作用：按键没有被卡吞掉（界面没有发出
 *        任何选择；只看“卡还在”不够，界面误发 allowSession / allowDir 时后台进程拒绝它，卡同样还在），卡还在、没有写。
 */
async function protectedCard(ctx, who) {
  const card = await cardFor(ctx, who, 'write file: .git/config');
  const real = join(realpathSync.native(who.cwd), '.git', 'config');
  record('FS-36 a write to .git/config shows "Protected path: <real path>" and no second button',
    cardMatches(card, { scope: 'protected', reasons: [{ reason: 'protected', text: REASON_LINE.protected(real) }] }),
    brief(card));
  await ctx.page.locator(`${paneSel(who.tab)} .composer textarea`).focus();
  await watchAlt2(ctx);
  await ctx.page.keyboard.press('Alt+2');
  await sleep(1000);
  const swallowed = await ctx.page.evaluate(() => window.__fsAlt2);
  const after = await cardOf(ctx, who.tab);
  record('FS-36 Alt+2 does nothing on the protected path card: the key is not taken by the card (no choice is sent, '
    + 'defaultPrevented stays false), the same card is still waiting and the file is not written', swallowed === false
    && after?.request === card?.request && !existsSync(join(who.cwd, '.git', 'config')), brief({ swallowed, after }));
  await denyAndSettle(ctx, who);
}

/** @brief 命令的原因行：看不出的目标、换到外面、分析不了。 */
async function reasonCommands(ctx, who) {
  const unresolved = await cardFor(ctx, who, 'run: echo x > $OUT/a.log');
  record('FS-36 a command writing to $OUT/a.log shows "Writes to a path Mori can’t resolve: $OUT/a.log" and no second '
    + 'button', cardMatches(unresolved, { scope: 'outside', reasons: [{ reason: 'unresolved',
    text: REASON_LINE.unresolved('$OUT/a.log') }] }), brief(unresolved));
  await denyAndSettle(ctx, who);
  const leaves = await cardFor(ctx, who, 'run: cd .. && npm i');
  record('FS-36 "cd .. && npm i" shows "Runs outside the working directory: <parent folder>" and no second button',
    cardMatches(leaves, { scope: 'outside', reasons: [{ reason: 'leaves',
      text: REASON_LINE.leaves(win32.resolve(who.cwd, '..')) }] }), brief(leaves));
  await denyAndSettle(ctx, who);
  const unanalyzed = await cardFor(ctx, who, 'run: echo "abc');
  record('FS-36 a command that can\'t be analyzed (echo "abc) shows "Couldn’t analyze this command: unclosed quote" '
    + 'and no second button', cardMatches(unanalyzed, { scope: 'outside', reasons: [{ reason: 'unanalyzed',
    text: REASON_LINE.unanalyzed('unclosed quote') }] }), brief(unanalyzed));
  await denyAndSettle(ctx, who);
}

/**
 * @brief 七个写到外面的目标：五行加 "and 2 more"；界面重新载入（Ctrl+R）后从 LiveSnapshot 接上，原因行与第二个按钮照旧。
 *        两个目录：Allow writes to these folders for this session 与列出两个目录的小字。
 */
async function reasonMany(ctx, who) {
  const root = parentOf(who);
  const names = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
  const many = await cardFor(ctx, who, `run: touch ${names.map((name) => `../${name}`).join(' ')}`);
  const want = { scope: 'outside', reasons: names.slice(0, 5).map((name) => ({ reason: 'outside',
    text: REASON_LINE.outside(join(root, name)) })), more: 'and 2 more', second: dirSecond(root) };
  record('FS-36 a command with seven targets outside shows five reason lines and "and 2 more"', cardMatches(many, want),
    brief(many));
  await reloadFsUi(ctx);
  await reopenFs(ctx, who);
  const again = await waitCard(ctx, who.tab, { timeout: 20000 });
  record('FS-36 after the window reloads (Ctrl+R) the card comes back from LiveSnapshot with the same reason lines, '
    + '"and 2 more" and second button', again?.request === many?.request && cardMatches(again, want), brief(again));
  await denyAndSettle(ctx, who);
  const dirs = [join(root, 'fs36-a'), join(root, 'fs36-b')];
  const two = await cardFor(ctx, who, 'run: touch ../fs36-a/x.txt ../fs36-b/y.txt');
  record('FS-36 two folders to allow: "Allow writes to these folders for this session" and "You won’t be asked again '
    + 'in this session for writes directly in: <folder>, <folder>."', cardMatches(two, { scope: 'outside',
    reasons: [join(root, 'fs36-a', 'x.txt'), join(root, 'fs36-b', 'y.txt')].map((path) => ({ reason: 'outside',
      text: REASON_LINE.outside(path) })), second: { kind: 'dir', label: SECOND_LABEL.dirs, hint: HINT.dirs(dirs) } }),
  brief(two));
  await denyAndSettle(ctx, who);
}

/** @brief scope inside 的命令、edit、MCP 的第二个按钮与小字（write 在 reasonFiles 里）。 */
async function secondButtons(ctx, who) {
  const command = await cardFor(ctx, who, 'run: echo fs36-inside');
  record('FS-36 a command inside the working directory: no reason line, "Allow “Run commands” for this session" and '
    + 'the commands note of §6.13', cardMatches(command, { scope: 'inside',
    second: toolSecond('Run commands', HINT.command) }), brief(command));
  await denyAndSettle(ctx, who);
  const edit = await cardFor(ctx, who, 'edit file: README.md :: # Mori fixture project => # Mori fixture project 36');
  record('FS-36 an edit inside: "Allow “Edit files” for this session" and "You won’t be asked again for “Edit files” '
    + 'in this session, except outside the working directory or in protected paths."', cardMatches(edit,
    { scope: 'inside', second: toolSecond('Edit files', HINT.files('Edit files')) }), brief(edit));
  await denyAndSettle(ctx, who);
  await waitTool(ctx, who, 'mcp__srv__echo');
  const mcp = await cardFor(ctx, who, 'call tool: mcp__srv__echo {"text":"fs36"}');
  record('FS-36 an MCP tool: no reason line, "Allow “srv · echo” for this session" and "You won’t be asked again for '
    + '“srv · echo” in this session."', cardMatches(mcp, { scope: 'inside',
    second: toolSecond('srv · echo', HINT.other('srv · echo')) }), brief(mcp));
  await denyAndSettle(ctx, who);
}

/** @brief FS-36 对话自己的卡（tools 项目的会话，接着 FS-35 的那个）。 */
async function reasons(ctx) {
  const who = ctx.tools ?? await openFsSession(ctx, ctx.p.tools);
  await reasonFiles(ctx, who);
  await reasonCommands(ctx, who);
  await reasonMany(ctx, who);
  await secondButtons(ctx, who);
}

/** @brief FS-36 后台卡：协作模式（合并会话）的 task 实例写到外面，用户会话里的后台卡同样有原因行与第二个按钮。 */
async function teamCard(ctx) {
  const who = await openFsSession(ctx, ctx.p.team);
  await sendFs(ctx, who, teamMessage([['fs-call', 'write file: ../fs36-team.md']]), { team: true, wait: false });
  const card = await waitCard(ctx, who.tab, { timeout: 90000 });
  const root = parentOf(who);
  record('FS-36 a background card (the task instance writes outside) shows its attribution line, the same reason line '
    + 'and the folder button', card?.agent === 'mori' && card.attribution === `Mori · T1 · ${FS_TEXT.taskTitle}`
    && cardMatches(card, { scope: 'outside', reasons: [{ reason: 'outside',
      text: REASON_LINE.outside(join(root, 'fs36-team.md')) }], second: dirSecond(root) }), brief(card));
  if (card) await answerCard(ctx, who.tab, 'deny');
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the team session did not become idle');
}

// ---------- FS-37：权限按钮与菜单 ----------

/** @brief 权限按钮的类名（Full access 时含 full）。 */
const buttonClass = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="permission-button"]`)
  .getAttribute('class');

/** @brief 新会话里的按钮（Ask each time ▾、读屏名、悬停）与菜单（两项、None、底部说明）。 */
async function permButton(ctx) {
  const who = await openFsSession(ctx, ctx.p.perm);
  ctx.perm = who;
  const ask = await permissionState(ctx.page, paneSel(who.tab));
  const problems = modeProblems(ask, 'ask');
  record('FS-37 the permission button reads "Ask each time ▾" with the name "Permission mode: Ask each time" and the '
    + `hover's second line "${MODE_NOTE.ask}"`, problems.length === 0, brief({ problems, lines: ask?.lines }));
  await openPermissionMenu(ctx, who.tab);
  const menu = await permissionMenuState(ctx);
  record(`FS-37 the menu has two items, Ask each time (checked) and Full access; the caption "${CAPTION}" with None `
    + `under it; the note "${MENU_NOTE}"`, same(menu?.items, [{ name: 'Ask each time', checked: true },
    { name: 'Full access', checked: false }]) && menu.caption === CAPTION && menu.allowed.length === 0
    && menu.empty === 'None' && menu.note === MENU_NOTE, brief(menu));
  await closePermissionMenu(ctx);
}

/** @brief 确认框此刻的样子：role、标题、正文、按钮（文字、是不是警示色）、焦点所在按钮的文字。 */
function confirmView(ctx) {
  return ctx.page.getByTestId('confirm-dialog').evaluate((el) => ({ role: el.getAttribute('role'),
    title: el.querySelector('h2')?.textContent ?? null, text: el.querySelector('p')?.textContent ?? null,
    buttons: [...el.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(),
      warn: b.classList.contains('warn') })), focus: document.activeElement?.textContent?.trim() ?? null }));
}

/** @brief 选 Full access 弹确认框（原文、焦点在 Cancel、警示色）；Esc 取消：模式不变，焦点回到权限按钮。 */
async function confirmDialog(ctx) {
  const { tab } = ctx.perm;
  const menu = await openPermissionMenu(ctx, tab);
  await menu.getByRole('menuitemradio', { name: 'Full access', exact: true }).click();
  const dialog = ctx.page.getByTestId('confirm-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const view = await confirmView(ctx);
  record(`FS-37 choosing Full access opens an alert dialog "${FULL_CONFIRM.title}" with the text of §6.13, the buttons `
    + 'Full access (warning colour) and Cancel, and focus on Cancel', view.role === 'alertdialog'
    && view.title === FULL_CONFIRM.title && view.text === FULL_CONFIRM.text && same(view.buttons,
    [{ text: 'Full access', warn: true }, { text: 'Cancel', warn: false }]) && view.focus === 'Cancel', brief(view));
  await ctx.page.keyboard.press('Escape');
  const closed = await dialog.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
  const state = await permissionState(ctx.page, paneSel(tab));
  const focus = await ctx.page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
  record('FS-37 Esc cancels the dialog: it closes, the mode stays Ask each time and focus returns to the permission '
    + 'button', closed && state?.modeText === 'Ask each time' && focus === 'permission-button',
  brief({ closed, mode: state?.modeText, focus }));
}

/** @brief 确认 Full access 时挂着的、工作路径里的卡结束（工具卡标 Full access）；按钮变成警示色的 Full access ▾。 */
async function confirmPending(ctx) {
  const who = ctx.perm;
  const card = await cardFor(ctx, who, 'run: echo fs37-inside');
  await setPermission(ctx, who.tab, 'full');
  const gone = await poll(async () => (await cardOf(ctx, who.tab))?.request !== card?.request, 10000, 150);
  const tool = await waitToolCard(ctx, who.tab, 'fs37-inside', (item) => item.badge === 'Full access', 10000);
  record('FS-37 confirming Full access ends the pending card inside the working directory: the card goes away and '
    + 'its tool card is labelled Full access', card?.scope === 'inside' && Boolean(gone) && tool !== null,
  brief({ card, tool }));
  const state = await permissionState(ctx.page, paneSel(who.tab));
  const problems = modeProblems(state, 'full');
  const cls = await buttonClass(ctx, who.tab);
  record('FS-37 in Full access the button reads "Full access ▾" in the warning colour (class full), its name is '
    + `"Permission mode: Full access" and the hover's second line is "${MODE_NOTE.full}"`,
  problems.length === 0 && /\bfull\b/.test(cls ?? ''), brief({ problems, cls, lines: state?.lines }));
  await waitIdleFs(ctx, who.tab);
}

/** @brief 挂着写到外面的卡时确认 Full access：卡还在；切回 Ask each time 不弹确认框。按目录放行这张卡。 */
async function confirmOutside(ctx) {
  const who = ctx.perm;
  await setPermission(ctx, who.tab, 'ask');
  const dialogs = await ctx.page.getByTestId('confirm-dialog').count();
  const card = await cardFor(ctx, who, 'write file: ../fs37-out/a.md');
  await setPermission(ctx, who.tab, 'full');
  await sleep(1000);
  const still = await cardOf(ctx, who.tab);
  record('FS-37 switching back to Ask each time needs no confirmation; a card that writes outside the working '
    + 'directory stays after confirming Full access (same request, reason line kept)', dialogs === 0
    && card?.scope === 'outside' && still?.request === card.request && same(still.reasons, card.reasons),
  brief({ dialogs, card, still }));
  await answerCard(ctx, who.tab, 'second');
  await waitIdleFs(ctx, who.tab);
}

/**
 * @brief “Allowed for this session:”列出工具名（Run commands）与 Writes to <目录>，各自带 Forget（悬停
 *        Forget “<名字>”）；Forget 之后列表里没有它、后台进程的批准状态里也没有，同样的调用又出卡。
 *        期望的目录独立算出：../fs37-out/a.md 的落点目录（§6.9），词法上在外面，真实路径就是词法路径（§6.3 第 1 条）。
 * @return 放行过的目录（给 F8 的检查）
 */
async function allowedList(ctx) {
  const who = ctx.perm;
  const want = win32.resolve(who.cwd, '..', 'fs37-out');
  await setPermission(ctx, who.tab, 'ask');
  await cardFor(ctx, who, 'run: echo fs37-session');
  await answerCard(ctx, who.tab, 'second');
  await waitIdleFs(ctx, who.tab);
  const dirs = (await approvalOf(ctx, who))?.allowedDirs ?? null;
  await openPermissionMenu(ctx, who.tab);
  const menu = await permissionMenuState(ctx);
  record(`FS-37 under the caption "${CAPTION}" the list has the tool name first (Run commands) and then "Writes to `
    + '<folder>" for the folder the ../fs37-out/a.md write lands in, each with Forget (hover Forget “<label>”)',
  same(dirs, [want]) && menu?.caption === CAPTION && same(menu.allowed, [
    { kind: 'tool', label: 'Run commands', forget: 'Forget “Run commands”' },
    { kind: 'dir', label: `Writes to ${want}`, forget: `Forget “Writes to ${want}”` }]), brief({ want, dirs, menu }));
  await forgetItem(ctx, who.tab, 'dir');
  await forgetItem(ctx, who.tab, 'tool');
  await openPermissionMenu(ctx, who.tab);
  const left = await permissionMenuState(ctx);
  await closePermissionMenu(ctx);
  const state = await approvalOf(ctx, who);
  record('FS-37 Forget removes each item: the list is back to None and the session\'s approval state has no tool '
    + 'names and no folders', left?.allowed.length === 0 && left.empty === 'None' && same(state?.allowed, [])
    && same(state?.allowedDirs, []), brief({ left, state }));
  await askedAgain(ctx, who);
  return want;
}

/** @brief 点“Allowed for this session:”里某一种（tool / dir）那一项的 Forget（菜单没开着时先打开），等它从列表里消失。 */
async function forgetItem(ctx, tab, kind) {
  await openPermissionMenu(ctx, tab);
  const item = ctx.page.locator(`[data-testid="permission-allowed"] li[data-kind="${kind}"]`);
  await item.getByRole('button', { name: 'Forget' }).click();
  await item.waitFor({ state: 'detached', timeout: 5000 });
}

/** @brief Forget 之后同样的命令、同一目录里的写入又出卡。 */
async function askedAgain(ctx, who) {
  const command = await cardFor(ctx, who, 'run: echo fs37-again');
  await denyAndSettle(ctx, who);
  const write = await cardFor(ctx, who, 'write file: ../fs37-out/b.md');
  await denyAndSettle(ctx, who);
  record('FS-37 after Forget the same kind of command and a write into the forgotten folder ask again',
    command?.scope === 'inside' && write?.scope === 'outside', brief({ command, write }));
}

/** @brief Markdown 里 "## 标题" 下的内容（到下一个 "## " 为止）。 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/**
 * @brief 按 F8、写一句、Save，关上报告框；返回写着这一句的那一份报告（<数据目录>\ui-issues 里按内容找，同 m5-app
 *        saveIssue：同一秒里存两份时文件名不按先后排）；找不到时为空串。
 */
async function issueReport(ctx, tab) {
  const what = `FS-37 synthetic report about the permission button ${Date.now()}`;
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} .composer textarea`).focus();
  await ctx.page.keyboard.press('F8');
  const dialog = ctx.page.getByTestId('issue-dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByTestId('issue-what').fill(what);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByTestId('issue-saved').waitFor({ timeout: 15000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  const dir = join(ctx.userData, 'ui-issues');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(dir, name), 'utf8'))
    .find((text) => text.includes(what)) ?? '';
}

/** @brief F8 报告的 Permission mode 与操作记录（Full access、按目录放行、Forget 目录）。 */
async function issueText(ctx, dir) {
  const who = ctx.perm;
  await setPermission(ctx, who.tab, 'full');
  const md = await issueReport(ctx, who.tab);
  const view = section(md, 'Current view');
  const actions = section(md, 'Recent activity');
  record('FS-37 the F8 report\'s current view has "Permission mode: Full access"',
    /^- Permission mode: Full access$/m.test(view), brief(view, 600));
  const want = ['Permission mode: Full access', 'Permission request: Allow writes to folders for this session',
    `Forget “Allow for this session”: writes to ${dir}`];
  record('FS-37 the action log (F8 "Recent activity") has "Permission mode: Full access", "Permission request: Allow '
    + 'writes to folders for this session" and "Forget “Allow for this session”: writes to <folder>"',
  Boolean(dir) && want.every((line) => actions.includes(line)), brief({ missing: want.filter((line) =>
    !actions.includes(line)), actions: actions.split(/\r?\n/).slice(-12) }));
}

/** @brief 新会话从 Ask each time 开始，列表为 None（不继承 Full access、工具名与目录）。 */
async function newSessionAsk(ctx) {
  const who = await openFsSession(ctx, ctx.p.perm);
  const state = await permissionState(ctx.page, paneSel(who.tab));
  await openPermissionMenu(ctx, who.tab);
  const menu = await permissionMenuState(ctx);
  await closePermissionMenu(ctx);
  record('FS-37 a new session starts at Ask each time with nothing allowed (the other session is in Full access)',
    state?.modeText === 'Ask each time' && menu?.allowed.length === 0 && menu.empty === 'None',
    brief({ mode: state?.modeText, menu }));
}

/** @brief FS-37 的整个流程。 */
async function permissions(ctx) {
  await permButton(ctx);
  await confirmDialog(ctx);
  await confirmPending(ctx);
  await confirmOutside(ctx);
  const dir = await allowedList(ctx);
  await issueText(ctx, dir);
  await newSessionAsk(ctx);
}

// ---------- FS-38：工具卡的标签与 Denied ----------

/** @brief 按目录放行的调用标 Allowed for this session（卡上自己允许的那次没有标签）。 */
async function dirLabel(ctx, who) {
  await cardFor(ctx, who, 'write file: ../fs38-out/a.md');
  await answerCard(ctx, who.tab, 'second');
  await waitIdleFs(ctx, who.tab);
  const first = await waitToolCard(ctx, who.tab, 'fs38-out/a.md', (card) => card.status === 'done', 10000);
  const { outcome } = await sendFs(ctx, who, 'write file: ../fs38-out/b.md');
  const covered = await waitToolCard(ctx, who.tab, 'fs38-out/b.md', (card) => card.status === 'done', 10000);
  record('FS-38 a write covered by "Allow writes to <folder>" runs without a card and its tool card is labelled '
    + '"Allowed for this session"; the call allowed on the card itself has no label', outcome === 'idle'
    && first?.badge === null && covered?.badge === 'Allowed for this session', brief({ outcome, first, covered }));
}

/** @brief Full access 下工作路径里的命令标 Full access；读取与写 .work 没有标签。 */
async function fullLabels(ctx, who) {
  await setPermission(ctx, who.tab, 'full');
  await sendFs(ctx, who, 'run: echo fs38-full');
  const full = await waitToolCard(ctx, who.tab, 'fs38-full', (card) => card.status === 'done', 10000);
  record('FS-38 in Full access a command inside the working directory is labelled "Full access"',
    full?.badge === 'Full access', brief(full));
  await sendFs(ctx, who, 'Please look at the fs38 project notes');
  await sendFs(ctx, who, 'write file: .work/fs38.md');
  const cards = await toolCardsOf(ctx, who.tab);
  const read = cards.findLast((card) => card.title.startsWith('Read'));
  const work = cards.findLast((card) => card.title.includes('.work/fs38.md'));
  record('FS-38 reads and writes into .work have no label, also in Full access', read?.status === 'done'
    && read.badge === null && work?.status === 'done' && work.badge === null, brief({ read, work }));
}

/**
 * @brief mori-memory 先于路径闸的拒绝：先把记忆目录下的文件夹按目录放行（命令写进去），再 write 进去：预告 dir（标上
 *        Allowed for this session），mori-memory 拒绝，工具卡 Denied · <原文>、标签去掉。
 */
async function memoryDenial(ctx, who) {
  await setPermission(ctx, who.tab, 'ask');
  const dir = join(ctx.userData, 'memory', MEM_DIR);
  const allow = await cardFor(ctx, who, `run: echo fs38 > '${bashPath(join(dir, 'a.txt'))}'`);
  await answerCard(ctx, who.tab, 'second');
  await waitIdleFs(ctx, who.tab);
  const { since } = await sendFs(ctx, who, `write file: ${join(dir, 'b.md')}`);
  const denied = await waitToolCard(ctx, who.tab, MEM_DIR, (card) => card.title.startsWith('Write')
    && card.status === 'rejected', 10000);
  const gates = (await gateEvents(ctx, who.sessionId, since)).filter((item) => item.toolName === 'write');
  record('FS-38 a write that mori-memory refuses before the path gate shows "Denied · Memory files can only be changed '
    + '…" (40 characters, the whole text on hover) and loses the "Allowed for this session" label of its announcement '
    + '(gate dir)', allow?.second?.kind === 'dir' && gates[0]?.gate === 'dir' && denied?.badge === null
    && denied.statusText === deniedStatus(MEMORY_FILES_ONLY) && denied.statusTitle === `Denied · ${MEMORY_FILES_ONLY}`
    && !existsSync(join(dir, 'b.md')), brief({ allow: allow?.second, gates, denied }));
}

/**
 * @brief 收窄的拒绝（§8.3：协作模式下合并会话 { write: false, mcp: false }，原文是整句 RELAY_ONLY）：Full access 下
 *        合并会话调用 bash 不出卡，工具卡 Denied · <原文>、没有标签。用户会话的收窄由第 3 步接上（§8.5、§8.6）。
 */
async function relayDenial(ctx) {
  const who = await openFsSession(ctx, ctx.p.team);
  ctx.relay = who;
  await setPermission(ctx, who.tab, 'full');
  const { since } = await sendFs(ctx, who, teamMessage([['fs-create', 'run: echo fs38-relay']]),
    { team: true, wait: false });
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the team session did not become idle');
  const denied = await waitToolCard(ctx, who.tab, 'fs38-relay', (card) => card.status === 'rejected', 10000);
  const cards = await cardsSince(ctx, since);
  record('FS-38 a call refused by narrowing (team mode, merged session) shows "Denied · Team mode is on: …" live, with '
    + 'no label and no approval card', denied?.badge === null && denied.statusText === deniedStatus(RELAY_ONLY)
    && denied.statusTitle === `Denied · ${RELAY_ONLY}` && cards.length === 0, brief({ denied, cards }));
}

/**
 * @brief 重新启动 App、重新打开会话：程序拒绝从会话记录载入时同样是 Denied · <原文>，没有任何放行标签。重新启动之前
 *        先写好合成的会话文件（seedDenialSession），启动后侧栏列出它；label、relay 两个会话之后再查它（reopenSynthetic）。
 */
async function reopenDenials(ctx) {
  const seed = seedDenialSession(ctx);
  await restartFsApp(ctx);
  await reopenReal(ctx);
  await reopenSynthetic(ctx, seed);
}

/** @brief 前面步骤里真的发生过的两种拒绝（mori-memory、收窄）在重新打开的会话里。 */
async function reopenReal(ctx) {
  const cases = [[ctx.label, MEM_DIR, MEMORY_FILES_ONLY], [ctx.relay, 'fs38-relay', RELAY_ONLY]];
  for (const [who, marker, reason] of cases) {
    const name = `FS-38 after reopening the session the refusal "${reason.slice(0, 40)}…" loaded from the session file `
      + 'still shows "Denied · <text>" and no tool card has a label';
    if (!who?.sessionFile) {
      // 这一种的会话没建成（前面的步骤在第一次发送之前就失败了）：记一条失败，不让这一半通过条件从结果里消失
      record(name, false, 'the session of this case was never created');
      continue;
    }
    await reopenFs(ctx, who);
    const denied = await waitToolCard(ctx, who.tab, marker, (card) => card.status === 'rejected', 15000);
    const labelled = (await toolCardsOf(ctx, who.tab)).filter((card) => card.badge !== null);
    record(name, denied?.statusText === deniedStatus(reason) && denied.statusTitle === `Denied · ${reason}`
      && labelled.length === 0, brief({ denied, labelled }));
  }
}

/**
 * FS-38 其余几种不出卡的程序拒绝（§12 DENIAL_PREFIXES 的表）：[标记, 工具, 参数, 工具结果原文]。
 * 这几种的实时一半在 App 层看不到，所以这里只测从会话记录载入的一半：没人能批（§6.11）只出在增强会话里，增强会话是
 * 无头的（MEM-20，FS-34 只能看它的工具结果）；交接后、强制填写的拒绝（mori-team）出在 task 实例与结案的会话里，实例的
 * 工具卡不进用户会话的对话流；增强会话里 write、edit 的拒绝（mori-memory）同样无头。§8 的收窄另放一例 task 的
 * Not allowed for this task（用户会话的 RELAY_ONLY 在 relayDenial 与 reopenReal 里实时与载入都测）。界面载入任何会话
 * 都走同一条路径（history.ts addToolResult → parseRejection），所以合成的用户会话文件足以测这一半。
 */
function syntheticDenials(cwd) {
  const outside = win32.resolve(cwd, '..', 'fs38-synth-nobody.txt');
  return [
    ['fs38-synth-nobody', 'bash', { command: 'echo x > ../fs38-synth-nobody.txt' },
      nobodyText(`writes outside the working directory: ${outside}`)],
    ['fs38-synth-limits', 'write', { path: 'docs/fs38-synth-limits.md', content: 'x\n' },
      'Not allowed for this task: writes are limited to src/ and .work/; docs/fs38-synth-limits.md is outside them.'],
    ['fs38-synth-handoff', 'bash', { command: 'echo fs38-synth-handoff' }, 'You handed off T1; stop here.'],
    ['fs38-synth-forced', 'edit', { path: 'fs38-synth-forced.md', edits: [{ oldText: 'a', newText: 'b' }] },
      'Only task_handoff works in this turn; call it now.'],
    ['fs38-synth-close', 'bash', { command: 'echo fs38-synth-close' },
      'Only request_close works in this turn; call it now.'],
    ['fs38-synth-enhance', 'write', { path: 'fs38-synth-enhance.md', content: 'x\n' },
      'Enhancement runs can only change memory, with the memory tool.'],
  ];
}

/** 合成会话里助手消息的模型与用量（synthetic，pi getSessionStats 的写法） */
const SYNTH_ASSISTANT = { api: 'openai-completions', provider: FS_PROVIDER, model: FS_MODEL,
  usage: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

/**
 * @brief 合成会话的条目（synthetic，pi 1.3.0 的格式）：会话名、你的一条消息，每个拒绝一条带 toolCall 的助手消息与
 *        一条 isError 的工具结果，最后一条回复；每条的 parentId 是上一条。
 */
function denialEntries(cases, at) {
  const lines = [];
  let parent = null;
  const push = (entry, t) => {
    const id = randomBytes(4).toString('hex');
    lines.push(JSON.stringify({ ...entry, id, parentId: parent, timestamp: new Date(t).toISOString() }));
    parent = id;
  };
  push({ type: 'session_info', name: 'FS-38 synthetic refusals' }, at);
  push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'FS-38 synthetic refusals' }],
    timestamp: at } }, at);
  cases.forEach(([marker, tool, args, text], index) => {
    const t = at + (index + 1) * 1000;
    const id = `call_${marker.replace(/-/g, '_')}`;
    push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: tool,
      arguments: args }], ...SYNTH_ASSISTANT, stopReason: 'toolUse', timestamp: t } }, t);
    push({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: tool,
      content: [{ type: 'text', text }], isError: true, timestamp: t + 10 } }, t + 10);
  });
  const end = at + (cases.length + 1) * 1000;
  push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Stopped here.' }],
    ...SYNTH_ASSISTANT, stopReason: 'stop', timestamp: end } }, end);
  return lines;
}

/**
 * @brief 测试准备（synthetic）：在 label 项目的 pi 会话目录（label 会话文件所在的目录，会话头的 cwd 照抄它的；那个会话
 *        没建成时按项目文件夹算）写一个用户会话文件，内容见 denialEntries。
 * @return { file, cases（syntheticDenials） }
 */
function seedDenialSession(ctx) {
  const known = ctx.label?.sessionFile ?? null;
  const cwd = (known && readJsonl(known)[0]?.cwd) || ctx.p.label;
  const dir = known ? dirname(known) : piSessionDir(ctx.userData, cwd);
  mkdirSync(dir, { recursive: true });
  const at = Date.now() - 60000;
  const id = randomUUID();
  const file = join(dir, `${new Date(at - 1000).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const head = JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(at - 1000).toISOString(), cwd });
  const cases = syntheticDenials(cwd);
  writeFileSync(file, `${[head, ...denialEntries(cases, at)].join('\n')}\n`);
  return { file, cases };
}

/**
 * @brief 从侧栏打开合成的会话：每种拒绝的工具卡都是 Denied · <原文>（40 字截断，悬停全文），没有标签。打不开时每种
 *        各记一条失败（detail 是错误），不让这几条从结果里消失。
 */
async function reopenSynthetic(ctx, seed) {
  const name = (tool, text) => `FS-38 after reopening a session (synthetic session file) the ${tool} refusal `
    + `"${text.slice(0, 40)}…" shows "Denied · <text>" (cut at 40 characters, the whole text on hover) with no label`;
  const who = { tab: null, sessionFile: seed.file };
  const opened = await reopenFs(ctx, who).then(() => null, (error) => errorLine(error));
  if (opened !== null) {
    const detail = `could not open ${seed.file}: ${opened}`;
    for (const [, tool, , text] of seed.cases) record(name(tool, text), false, detail);
    return;
  }
  const all = await poll(async () => {
    const cards = await toolCardsOf(ctx, who.tab);
    return seed.cases.every(([marker]) => cards.some((card) => card.title.includes(marker))) ? cards : null;
  }, 15000, 200) ?? await toolCardsOf(ctx, who.tab);
  for (const [marker, tool, , text] of seed.cases) {
    const card = all.findLast((item) => item.title.includes(marker)) ?? null;
    record(name(tool, text), card?.status === 'rejected' && card.statusText === deniedStatus(text)
      && card.statusTitle === `Denied · ${text}` && card.badge === null, brief(card));
  }
}

/** @brief FS-38 的标签与 mori-memory 的拒绝（label 项目的会话）。 */
async function labels(ctx) {
  const who = await openFsSession(ctx, ctx.p.label);
  ctx.label = who;
  await dirLabel(ctx, who);
  await fullLabels(ctx, who);
  await memoryDenial(ctx, who);
}

// ---------- FS-39：身份句 ----------

/** @brief 这些请求里身份段不是 mode 与请求的工具那四行的（检查的 detail：第二到第四行）。 */
const identityBad = (requests, mode) => requests
  .filter((item) => !same(item.identity.lines, identityLines(mode, item.tools)))
  .map((item) => item.identity.lines.slice(1));

/**
 * @brief Ask each time 下开始的运行中途切到 Full access（卡按 full 结束）：这次运行的请求仍是 Ask each time 那一句；
 *        下一次运行的请求是 Full access 那一句。
 */
async function identity(ctx) {
  const who = await openFsSession(ctx, ctx.p.ident);
  const mid = await sendFs(ctx, who, 'run: echo fs39-mid');
  if (mid.outcome !== 'card') throw new Error('no approval card for the fs39-mid command');
  await setPermission(ctx, who.tab, 'full');
  await waitIdleFs(ctx, who.tab);
  const during = requestsSince(ctx, mid.since, 'fs39-mid');
  record('FS-39 switching to Full access in the middle of a run does not change that run: its requests before and '
    + 'after the switch have the Ask each time sentence and the .work line', during.length >= 2
    && identityBad(during, 'ask').length === 0, brief({ requests: during.length, bad: identityBad(during, 'ask') }));
  const next = await sendFs(ctx, who, 'Next run fs39-next question');
  await waitIdleFs(ctx, who.tab);
  const after = requestsSince(ctx, next.since, 'fs39-next');
  record('FS-39 the next run after switching to Full access has the Full access sentence ("Reading, searching and MCP '
    + 'tools run without approval, …") as the identity section\'s second line', after.length >= 1
    && identityBad(after, 'full').length === 0, brief({ requests: after.length, bad: identityBad(after, 'full') }));
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  enhancement: [enhancement, ['FS-34', 'FS-39']],
  preannounce: [preannounce, ['FS-35']],
  reasons: [reasons, ['FS-36']],
  teamCard: [teamCard, ['FS-36']],
  permissions: [permissions, ['FS-37']],
  identity: [identity, ['FS-39']],
  labels: [labels, ['FS-38']],
  relay: [relayDenial, ['FS-38']],
  // 重新启动 App：放在最后
  reopen: [reopenDenials, ['FS-38']],
};

const ctx = { ...fsUserData('mori-fs-gate-data-'), exePath: args.exePath, pageErrors: [], args, record };
await runSuite(ctx, setup, steps);
console.log(`[fs-app-gate] data in ${ctx.userData}, projects in ${ROOT}`);
finish();
