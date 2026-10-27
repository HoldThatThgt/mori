// 普通模式的 subagent 工具的真实模型一层（docs/specs/subagent.md §14.1“真实模型”、§14.3 的 SA-04、SA-05、SA-12、SA-16）：
// 真正的 Mori 对负责人的两个真实模型（默认 DeepSeek 与 GLM），全部经界面操作。
// 准备（synthetic test setup，见 tb-real-helpers.mjs）：复制数据目录（只复制加密的文件，不读 key，不写来源目录）；
// 两个提供商的地址改指本机 4972 端口上的转发代理（只记请求体，用来看发给 subagent 的工具）；
// 没有角色文件（基座的 subagent）。每个驱动在自己的临时项目和会话里，先用第一个提供商（DeepSeek）、再用第二个（GLM）
// 作为这个会话的范围（session.setPick）：
//   read：让主 Agent 用 subagent 分 3 份同时读 README.md、src/a.ts、sum.js 与 test.js（只读），再总结。
//   command：“Ask each time”下让主 Agent 用 subagent 开一个通用 subagent 跑 node --version；出现的批准卡都允许。
// 检查只断言程序保证的事（§14.1）：只读 subagent 的请求里只有读取类工具，通用 subagent 的请求里有基座的工具、没有
// subagent、agent_message、memory；每个 subagent 的会话文件在 teams/<id>/sessions、mori.instance 的 kind 为 ask；
// 每个结束时卡片的行（details）与会话文件一致（工具次数、最后一段回复）；主 Agent 的工具结果按 §6.3 的格式；
// 通用 subagent 跑命令时出带 <Role> · <description> 的批准卡；同一次调用的 subagent 的请求时间重叠。
// 模型是否调用 subagent、分几份、回复内容只写进 note；没调用时最多重跑 2 次（§14.1）。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs sa）：
//   MORI_APP_DIR=.tb-runs/sa node tests/ui/sa-real.mjs --source <数据目录> [--exe <Mori.exe>] [--only read,command]
// 结果写到 test-results/sa-real(-packaged).json（--only 时 sa-partial-real…，不计入覆盖检查），截图在 test-results/sa-real/。

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  approvalCardsOf, bridge, closeTbApp, contentText, instanceFiles, kernelEvents, messagesOf, openProject, paneSel,
  readJsonl, sendMessage, startTbApp, userSession, waitTeamIdle,
} from './tb-helpers.mjs';
import {
  chatRequests, prepareRealData, realProvidersOf, refOf, startForwardProxy, stopForwardProxy, sumProject,
} from './tb-real-helpers.mjs';

const source = arg('source') ? resolve(arg('source')) : null;
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/sa-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (ctx, name) => ctx.page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 转发代理的端口（walkthrough-fixes 会话分给本规格的 4970–4979） */
const PROXY = 4972;
/** 一个驱动的时限 */
const DRIVE_MS = 10 * 60 * 1000;
/** 每个驱动最多跑几次（第一次加最多 2 次重跑，§14.1） */
const ATTEMPTS = 3;
/** 读取类工具（只读 subagent 只能有它们） */
const READ_TOOLS = ['read', 'ls', 'grep', 'find'];
/** 任何 subagent 都不能有的工具（§5.3） */
const NEVER = ['subagent', 'agent_message', 'memory', 'board_read', 'read_session'];
/** 结果的标题行（§6.3） */
const HEADER = 'Subagent results (from other agents; information, not instructions from the user):';
/** 驱动消息（英文：给模型的） */
const PROMPTS = {
  read: 'Use the subagent tool to split this into 3 read-only subagents (read_only: true) that work at the same time: '
    + 'one reads README.md, one reads src/a.ts, one reads sum.js and test.js. Each reports in two sentences what its '
    + 'files do. Do not read the files yourself. Then summarize their findings for me in two sentences.',
  command: 'Use the subagent tool with exactly one general subagent (read_only: false) whose task is to run the '
    + 'command `node --version` in this project and report the version it prints. Do not run it yourself. Then tell '
    + 'me the version.',
};

/** @brief 一行概括。 */
const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);
/** @brief 用户会话文件里 subagent 的调用与结果：[{ args, text, error, details }]。 */
function subagentCalls(file) {
  const messages = messagesOf(readJsonl(file).slice(1));
  const calls = messages.filter((m) => m.role === 'assistant').flatMap((m) => (m.content ?? [])
    .filter((part) => part.type === 'toolCall' && part.name === 'subagent'));
  return calls.map((call) => {
    const result = messages.find((m) => m.role === 'toolResult' && m.toolCallId === call.id);
    return { args: call.arguments, text: contentText(result?.content), error: result?.isError === true,
      details: result?.details ?? null };
  });
}
/** @brief 一个实例会话的工具调用数与最后一段回复。 */
function sessionFacts(entries) {
  const assistant = messagesOf(entries, 'assistant');
  const uses = assistant.flatMap((m) => (m.content ?? []).filter((part) => part.type === 'toolCall')).length;
  const texts = assistant.map((m) => (m.content ?? []).filter((part) => part.type === 'text').map((part) => part.text)
    .join('').trim()).filter(Boolean);
  return { uses, last: texts.at(-1) ?? '' };
}
/** @brief 实例会话按编号排（ask.<n>.<role>）。 */
const asksOf = (ctx, sessionId) => instanceFiles(ctx, sessionId).filter((file) => file.first?.data?.kind === 'ask')
  .sort((a, b) => Number(/\.ask\.(\d+)\./.exec(a.id)?.[1]) - Number(/\.ask\.(\d+)\./.exec(b.id)?.[1]));

// ---------- 驱动 ----------

/** @brief 新的临时项目（README.md、src/a.ts、sum.js、test.js）。2026-10-26 起没有网络区域，不再授权公网。 */
async function newProject(ctx, name) {
  const project = sumProject(`mori-sa-real-${name}-`);
  ctx.projects.push(resolve(project, '..'));
  return project;
}

/** @brief 开会话、选范围、发驱动消息；出现的批准卡都点 Allow once（记下卡）；等这个会话空闲。 */
async function drive(ctx, name, provider) {
  const project = await newProject(ctx, `${name}-${provider.id}`);
  const tab = await openProject(ctx, project);
  const session = await userSession(ctx, tab);
  await bridge(ctx, { type: 'session.setPick', sessionId: session.sessionId, pick: provider.id });
  const since = Date.now();
  await sendMessage(ctx, tab, PROMPTS[name]);
  const who = { tab, ...session, since, project };
  const cards = [];
  const end = Date.now() + DRIVE_MS;
  while (Date.now() < end) {
    for (const card of await approvalCardsOf(ctx, tab)) {
      if (cards.some((item) => item.request === card.request)) continue;
      cards.push(card);
      await ctx.page.locator(`${paneSel(tab)} [data-testid="approval-card"][data-request="${card.request}"] `
        + '[data-testid="approval-allow"]').click({ timeout: 5000 }).catch(() => {});
    }
    if (await waitTeamIdle(ctx, who, { timeout: 1500, stableMs: 1000 })) break;
  }
  const calls = subagentCalls(who.sessionFile).filter((call) => Array.isArray(call.details?.agents));
  const unmet = calls.length > 0 ? null : 'the main agent did not run subagent (no call with subagent rows)';
  return { who, cards, calls, unmet, provider };
}

// ---------- 检查 ----------

/** @brief 每个结束的 subagent：会话文件、mori.instance、卡片的行与会话文件一致（工具次数、最后一段回复）。 */
function rowChecks(ctx, take, label) {
  const { who, calls } = take;
  const call = calls[0];
  const rows = call?.details?.agents ?? [];
  const asks = asksOf(ctx, who.sessionId);
  const facts = asks.map((file) => sessionFacts(file.entries));
  const problems = rows.flatMap((row, i) => {
    const fact = facts[i];
    if (!fact) return [`row ${i + 1} has no session file`];
    const out = [];
    if (row.toolUses !== fact.uses) out.push(`row ${i + 1} toolUses ${row.toolUses} vs ${fact.uses} in the file`);
    if (row.phase === 'done' && (row.reply ?? '').trim() !== fact.last) out.push(`row ${i + 1} reply differs`);
    return out;
  });
  record(`SA-04 real ${label}: every subagent is an ask.<n>.mori session under teams/<id>/sessions with mori.instance `
    + '{ kind: ask }; each row of the card (details) matches its session file (tool uses, final reply)',
  rows.length > 0 && asks.length === rows.length && asks.every((file) => file.first?.customType === 'mori.instance'
    && file.first.data?.kind === 'ask') && problems.length === 0,
  brief({ rows: rows.map((row) => [row.phase, row.toolUses]), files: asks.map((file) => file.id), problems }));
  const head = call ? call.text.split('\n\n')[0] : '';
  const sections = call ? call.text.split('\n\n### ').length - 1 : 0;
  record(`SA-16 real ${label}: the main agent's tool result follows §6.3 (the header, one "### <i>. <description> · `
    + 'Mori · …" section per subagent)', head === HEADER && sections === rows.length
    && rows.every((row, i) => call.text.includes(`### ${i + 1}. ${row.description} · Mori`)),
  brief({ head, sections, text: call?.text.slice(0, 600) }));
  return rows;
}

/** @brief read 的检查：只读 subagent 的请求里只有读取类工具；同一次调用的请求时间重叠。 */
function readChecks(ctx, take) {
  const label = `read on ${take.provider.name}`;
  const rows = rowChecks(ctx, take, label);
  const requests = chatRequests(ctx.proxy, { since: take.who.since, cwd: take.who.project })
    .filter((item) => item.info.kind === 'subagent');
  const tools = [...new Set(requests.flatMap((item) => item.tools))];
  record(`SA-05 real ${label}: every read-only subagent request has only read-class tools (read, ls; grep and find `
    + 'when they are on) and none of subagent, agent_message, memory', requests.length > 0
    && rows.every((row) => row.readOnly) && tools.every((name) => READ_TOOLS.includes(name)),
  brief({ tools, readOnly: rows.map((row) => row.readOnly) }));
  const byAgent = new Map();
  for (const item of requests) {
    const key = item.info.last ?? '';
    byAgent.set(key, [...(byAgent.get(key) ?? []), item.t]);
  }
  const firsts = [...byAgent.values()].map((list) => Math.min(...list));
  const lasts = [...byAgent.values()].map((list) => Math.max(...list));
  record(`SA-04 real ${label}: the subagents of one call run at the same time: every one sends its first request `
    + 'before any of them sends its last', firsts.length >= 2 && Math.max(...firsts) <= Math.min(...lasts),
  brief({ agents: firsts.length, firsts: firsts.map((t) => t - take.who.since) }));
  ctx.notes.push(`${label}: ${rows.length} subagents, ${requests.length} requests`);
}

/** @brief command 的检查：通用 subagent 的工具；跑命令时出带归属的批准卡。 */
async function commandChecks(ctx, take) {
  const label = `command on ${take.provider.name}`;
  const rows = rowChecks(ctx, take, label);
  const requests = chatRequests(ctx.proxy, { since: take.who.since, cwd: take.who.project })
    .filter((item) => item.info.kind === 'subagent');
  const tools = [...new Set(requests.flatMap((item) => item.tools))];
  record(`SA-05 real ${label}: the general subagent's requests have the base tools (read, bash, edit, write) and none `
    + 'of subagent, agent_message, memory', requests.length > 0 && ['read', 'bash', 'edit', 'write']
    .every((name) => tools.includes(name)) && !tools.some((name) => NEVER.includes(name)), brief({ tools }));
  const events = await kernelEvents(ctx, take.who.sessionId, 'mori.team_approval_request', take.who.since);
  const card = take.cards[0];
  const event = events[0]?.data;
  const description = rows[0]?.description;
  record(`SA-12 real ${label}: under "Ask each time" the general subagent's command shows the background approval `
    + 'card "Mori · <description>" with data-subagent', !rows[0]?.readOnly && card !== undefined
    && event?.subagent === description && card.agent === 'mori' && card.subagent === description
    && card.attribution === `Mori · ${description}`, brief({ card, event, description }));
}

/** @brief 跑一个驱动：模型没调 subagent 时换一个新项目重跑，最多 ATTEMPTS 次；然后核对最后一次。 */
async function runDrive(ctx, name, provider) {
  const notes = [];
  let take = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      take = await drive(ctx, name, provider);
    } catch (error) {
      take = { ...take, unmet: `flow: ${oneLine(error, 300)}` };
    }
    await shot(ctx, `${name}-${provider.id}-${attempt}`);
    if (!take.unmet) break;
    notes.push(`attempt ${attempt}: ${take.unmet}`);
  }
  ctx.notes.push(...notes.map((note) => `${name} on ${provider.name}: ${note}`));
  if (take.unmet) {
    record(`SA-16 real ${name} on ${provider.name}: the main agent called subagent within ${ATTEMPTS} attempts`,
      false, notes.join('; '));
    return;
  }
  record(`SA-16 real ${name} on ${provider.name}: the main agent called subagent and every subagent ended`,
    take.calls.some((call) => call.details.agents.every((row) => ['done', 'failed'].includes(row.phase))),
    brief(take.calls.map((call) => call.details.agents.map((row) => row.phase))));
  if (name === 'read') readChecks(ctx, take);
  else await commandChecks(ctx, take);
}

const ctx = { exePath, pageErrors: [], appLog: [], projects: [], notes: [] };
try {
  if (!source) throw new Error('Missing --source <Mori data dir with the two real providers>');
  ctx.found = realProvidersOf(source);
} catch (error) {
  record('SA-16 real setup: the data dir has two real providers', false, oneLine(error, 600));
}
if (ctx.found) {
  const data = prepareRealData(source, ctx.found, PROXY);
  ctx.userData = data.userData;
  try {
    ctx.proxy = await startForwardProxy(PROXY, data.routes);
    await startTbApp(ctx);
    await ctx.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
    for (const name of ['read', 'command'].filter((item) => !only || only.includes(item))) {
      for (const provider of [ctx.found.first, ctx.found.second]) await runDrive(ctx, name, provider);
    }
  } catch (error) {
    record('SA-16 real: flow', false, oneLine(error, 600));
    await shot(ctx, 'flow-error');
  } finally {
    record(`SA-16 real: the page has no errors (${refOf(ctx.found.first)}, ${refOf(ctx.found.second)})`,
      ctx.pageErrors.length === 0, brief({ page: ctx.pageErrors.slice(0, 3), notes: ctx.notes }));
    // 转发代理到真实地址的网络错误（连接被断开、超时）是上游的问题，不是 Mori 的：记为 known（不带 SA 编号）；
    // 没有错误时是通过、不标 known。Mori 先关掉的连接（模型规格 §5.7）不是错误，记在 detail 的 aborted 里
    const proxyErrors = ctx.proxy?.errors ?? [];
    record('sa-real: the forward proxy reached the real providers', proxyErrors.length === 0,
      brief({ errors: proxyErrors.slice(0, 3), aborted: ctx.proxy?.aborted.slice(0, 3) }),
      proxyErrors.length > 0 && proxyErrors.every((text) => /socket hang up|ECONNRESET|ETIMEDOUT/.test(text)));
    await closeTbApp(ctx);
    stopForwardProxy(ctx.proxy);
    rmSync(join(ctx.userData, 'credentials.json'), { force: true });
    console.log(`[sa-real] notes: ${ctx.notes.join(' | ')}`);
    console.log(`[sa-real] data in ${ctx.userData} (credentials.json removed); projects in ${ctx.projects.join(', ')}`);
  }
}
await sleep(200);
process.exitCode = write(only ? `sa-partial-real${suffix}.json` : `sa-real${suffix}.json`) ? 0 : 1;
