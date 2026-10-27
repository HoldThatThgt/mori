// 收尾检查规格的 App 套件 tests/ui/fc-app-team.mjs（docs/specs/finish-check.md §14.2，协作模式与 Team）用的
// 规格原文、测试准备与读取：
// - 规格原文（§7.1 检查那一行的四种、§7.2 检查块的写法、§4.1 finish 的结果），独立写出，用来核对；
// - 命令行与结果文件：fc-app-team(-packaged).json；--only 时 fc-partial-app-team…（不计入覆盖检查，§14.3）；
// - 测试准备（synthetic test setup）：项目的 AGENTS.md 带 tb-scenario（进每个会话的 system）、经进程桥写记忆条目
//   （同记忆页的 New entry → Save）、协作模式增强要的会话文件与 enhance.json（写法同 mem-app-team.mjs）；
// - 读记录代理的请求：检查请求、请求末尾的检查那一行与工作卡、请求的 system 里的记忆分节；
// - 读会话文件：检查那一行的 custom_message 条目、工具的 system 补丁、工具结果、finish 调用。
// 合成端点日志行的 check、checks 与记录代理的 info.check 见 tests/fake-endpoint/finish.mjs、scripts.mjs 开头。
// tests/ui/fc-app-check.mjs 关闭模式的增强（FC-25）也用这里的 headlessSessions、checkEntries、finishCalls、replyTexts。

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHECK_LINE_HEAD, WORK_CARD_OPEN } from '../fake-endpoint/scripts.mjs';
import { fcTeamAgentsMd } from '../fake-endpoint/scenarios/fc-team.mjs';
import { appRoot, arg } from './lib.mjs';
import {
  bridge, contentText, kernelEvents, messagesOf, poll, readJsonl, scenarioLines, scenarioRequests, tempProject,
  writeRoles,
} from './tb-helpers.mjs';

export { CHECK_LINE_HEAD, WORK_CARD_OPEN };

// ---------- 规格原文（独立写出，用来核对） ----------

/** §7.1 检查那一行的第一、二、四行 */
const LINE_HEAD = "[Mori] This is Mori's end-of-turn check, not a message from the user. It is about your reply "
  + 'just before it.';
const LINE_TOOLS = "If you said you would do something and haven't done it, or a tool call you meant to make was "
  + "never sent, do it now with your tools. Don't retry calls that were rejected or denied.";
const LINE_REPLY = 'Anything you write now is shown to the user as your reply. If that reply is final, including a '
  + "question that waits for the user's answer, only call finish. To change it, write the new reply, then call "
  + 'finish.';
/** §7.1 第三行按 kinds（taste、review 的顺序）选，没有时整行去掉 */
const AGAINST = {
  'taste,review': 'Otherwise check that reply against <taste> and <review> below.',
  taste: 'Otherwise check that reply against <taste> below.',
  review: 'Otherwise check that reply against <review> below.',
};

/**
 * @brief 检查那一行的原文（§7.1）。
 * @param kinds 这次运行有内容的分节：[]、['taste']、['review'] 或 ['taste', 'review']
 */
export function checkLineText(kinds) {
  const against = AGAINST[kinds.join(',')];
  return [LINE_HEAD, LINE_TOOLS, ...(against ? [against] : []), LINE_REPLY].join('\n');
}

/** @brief 一个记忆分节（§7.2，同 system prompt 的写法）：`<名字>\n- 摘要…\n</名字>`。 */
export const sectionText = (name, abstracts) => `<${name}>\n${abstracts.map((text) => `- ${text}`).join('\n')}`
  + `\n</${name}>`;

/** @brief finish 的工具名与结果（§4.1、§7.3） */
export const FINISH = 'finish';
export const CONFIRMED = 'Confirmed.';
/** 平行 Agent 规格 §5.5：协作模式下对话调用范围外的工具的理由 */
export const RELAY_ONLY = 'Task mode is on: the dialog agent only relays; the work is done in tasks.';
/** @brief pi 对没有启用的工具的回答（pi-agent-core agent-loop.js prepareToolCall）。 */
export const notFound = (tool) => `Tool ${tool} not found`;

// ---------- 命令行与结果文件 ----------

/** @brief 命令行：--exe（打包版）、--only a,b（只跑这些步骤，结果写成 fc-partial-…，不计入覆盖检查）。 */
export function fcArgs() {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `fc-partial-app-team${packaged}.json` : `fc-app-team${packaged}.json`;
  const shots = join(appRoot, `test-results/fc-app-team${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite: 'fc-app-team', exePath, only, file, shots };
}

// ---------- 测试准备（synthetic test setup） ----------

/**
 * @brief 一个临时项目：AGENTS.md 带脚本名（fcTeamAgentsMd，进每个会话的 system），roles 不为空时写角色文件。
 * @param prefix 临时目录的前缀
 * @param scenario 脚本名（tb-fcteam-…，或 mem-team）
 * @param roles writeRoles 的角色列表；合并配置为 []
 */
export function fcProject(prefix, scenario, roles = []) {
  const project = tempProject(prefix);
  writeFileSync(join(project, 'AGENTS.md'), fcTeamAgentsMd(scenario));
  if (roles.length > 0) writeRoles(project, roles);
  return project;
}

/** @brief 经进程桥写一条本项目的记忆条目（同记忆页的 New entry → Save）；出错时报错。 */
export async function saveEntry(ctx, cwd, kind, abstract) {
  const result = await bridge(ctx, { type: 'memory.save', cwd, layer: 'project', kind, abstract,
    detail: 'Synthetic entry written by fc-app-team.' });
  if (result?.error) throw new Error(`memory.save ${kind} in ${cwd}: ${result.error}`);
}

/** @brief 两位数。 */
const pad = (n) => String(n).padStart(2, '0');
/** @brief 本地日期 YYYY-MM-DD。 */
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** @brief 记忆目录与 pi 会话目录的项目目录名（同 pi session-manager 的编码）。 */
const projectDirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/**
 * @brief 增强的日子与时刻（同 mem-app-team.mjs）：每天的时刻取现在之前两小时，于是今天 = 那一刻的本地日期，
 *        下一次到点约 22 小时后（套件跑完之前定时器不会到）。
 */
export function dayClock(now) {
  const shifted = new Date(now - 2 * 3600000);
  const yesterday = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate() - 1, 12);
  return { now, time: `${pad(shifted.getHours())}:${pad(shifted.getMinutes())}`, today: localDay(shifted),
    yesterday: localDay(yesterday) };
}

/**
 * @brief 写一个用户会话文件（pi 会话文件的格式，synthetic）：今天的一问一答，增强的第一条消息列出它、依据用它。
 * @return { file, userEntry（用户消息的条目 id）, lastEntry（最后一条，TASTE、REVIEW 的水位） }
 */
export function writeSeedSession(userData, project, now) {
  const id = randomUUID();
  const at = now - 20 * 60000;
  const dir = join(userData, 'pi', 'sessions', projectDirName(project));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date(at).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const user = { type: 'message', id: 'c1d2e3f4', parentId: null, timestamp: new Date(at + 1000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'Refactor the payment module, tell me the plan first' }],
      timestamp: at + 1000 } };
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const reply = { type: 'message', id: 'd2e3f4a5', parentId: user.id, timestamp: new Date(at + 60000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Plan: change the payment module in two steps.' }],
      api: 'openai-completions', provider: 'fake', model: 'fake-model', stopReason: 'stop', timestamp: at + 60000,
      usage } };
  const header = { type: 'session', version: 3, id, timestamp: new Date(at).toISOString(), cwd: resolve(project) };
  writeFileSync(file, `${[header, user, reply].map((line) => JSON.stringify(line)).join('\n')}\n`);
  return { file, userEntry: user.id, lastEntry: reply.id };
}

/**
 * @brief 写项目的 project.json 与 enhance.json（synthetic，记忆规格 §3、§9.1 的格式）：开着、pick 为 provider、
 *        team 为真；TASTE、REVIEW 的水位已到会话的最后一条（运行时跳过），只有 STRATEGY 跑。
 */
export function seedEnhance(userData, project, { provider, seed, clock }) {
  const dir = join(userData, 'memory', 'projects', projectDirName(project));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ cwd: resolve(project) }, null, 2)}\n`);
  const task = (watermarks) => ({ doneThrough: clock.yesterday, watermarks, feedbackSeen: null, running: null,
    last: null });
  const read = { [seed.file]: seed.lastEntry };
  const file = { enabled: true, pick: provider, thinking: 'off', team: true, time: clock.time, since: clock.today,
    tasks: { taste: task(read), strategy: task({}), review: task(read) }, notice: null };
  writeFileSync(join(dir, 'enhance.json'), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * @brief 测试准备（synthetic）：把会话文件里每条带 tools 的 mori.team 条目去掉 finish，模拟收尾检查之前写下的条目
 *        （平行 Agent 规格 §5.5：回到关闭模式时按最后一条恢复）。只在 Mori 退出之后调用；读不出的行原样留着。
 * @return { entries（带 tools 的 mori.team 条数）, before（原来的各组）, after（改过的各组） }
 */
export function dropFinishFromTeamEntries(file) {
  const before = [];
  const after = [];
  const lines = readFileSync(file, 'utf8').split('\n').map((line) => {
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }
    if (entry?.type !== 'custom' || entry.customType !== 'mori.team' || !Array.isArray(entry.data?.tools)) return line;
    const tools = entry.data.tools.filter((name) => name !== FINISH);
    before.push(entry.data.tools);
    after.push(tools);
    return JSON.stringify({ ...entry, data: { ...entry.data, tools } });
  });
  writeFileSync(file, lines.join('\n'));
  return { entries: before.length, before, after };
}

/** @brief 增强会话（看不见的会话）的文件：memory/projects/<key>/sessions/*.jsonl，每项 { file, id, entries }。 */
export function headlessSessions(userData, project) {
  const dir = join(userData, 'memory', 'projects', projectDirName(project), 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().map((name) => {
    const all = readJsonl(join(dir, name));
    return { file: join(dir, name), id: all[0]?.id ?? null, entries: all.slice(1) };
  });
}

/** @brief 这个项目从 since 起的增强进度事件：[{ t, task, phase, error, revision }]。 */
export async function enhanceProgress(ctx, cwd, since) {
  const events = await kernelEvents(ctx, null, 'mori.enhance_progress', since);
  return events.filter((item) => item.data?.cwd === cwd).map((item) => ({ t: item.t, task: item.data.task,
    phase: item.data.phase, error: item.data.error ?? null, revision: item.data.revision ?? null }));
}

// ---------- 合成端点的日志与记录代理的请求 ----------

/**
 * @brief 等合成端点收到某个会话的一个请求（日志行，含检查请求），最多 timeout；返回那一行，没等到时报错。
 * @param where { agent?, kind?, k?, j?, check? }
 */
export async function waitLine(ep, scenario, where, timeout = 30000) {
  const { k, j, check, ...rest } = where;
  const pick = () => scenarioLines(ep, scenario, { ...rest, check: true }).find((line) => (k === undefined
    || line.k === k) && (j === undefined || line.j === j) && (check === undefined || line.check === check));
  const line = await poll(() => pick() ?? null, timeout, 50);
  if (!line) throw new Error(`no request ${JSON.stringify(where)} for ${scenario}`);
  return line;
}

/** @brief 某个脚本从 since 起的全部请求（记录代理，含检查请求，按收到的顺序）。 */
export const allRequests = (ep, scenario, since) => scenarioRequests(ep, scenario, { since, check: true });

/** @brief 一条消息的文字。 */
export const textOf = (message) => contentText(message?.content);
/** @brief 是不是检查那一行（pi-ai 形状：去掉首部空白后以 CHECK_LINE_HEAD 开头的 user 消息）。 */
export const isCheckMessage = (message) => message?.role === 'user'
  && textOf(message).trimStart().startsWith(CHECK_LINE_HEAD);
/** @brief 是不是工作卡（整条 user 消息以 <mori-work-card> 开头）。 */
export const isCardMessage = (message) => message?.role === 'user' && textOf(message).trimStart()
  .startsWith(WORK_CARD_OPEN);
/** @brief 请求的 tools 里有没有 finish。 */
export const hasFinish = (request) => request.tools.includes(FINISH);

/**
 * @brief 检查请求的末尾：{ line（检查那一行的全文，没有时 null）, lineRole, card（最后一条是工作卡）, cards（请求里
 *        工作卡的条数）, before（检查那一行之前紧挨着的那条消息的角色，应是 assistant：没有连着的两条 user 消息） }。
 */
export function checkTail(request) {
  const messages = request.messages;
  const card = isCardMessage(messages.at(-1));
  const index = messages.length - (card ? 2 : 1);
  const lineMessage = messages[index];
  return { line: isCheckMessage(lineMessage) ? textOf(lineMessage) : null, lineRole: lineMessage?.role ?? null, card,
    cards: messages.filter(isCardMessage).length, before: messages[index - 1]?.role ?? null };
}

/** @brief 请求里不在末尾的检查那一行（更早的检查留在上下文里的原文）。 */
export function earlierCheckLines(request) {
  const messages = request.messages;
  const tail = request.info.check ? checkTail(request) : null;
  const last = tail ? messages.length - (tail.card ? 2 : 1) : messages.length;
  return messages.slice(0, last).filter(isCheckMessage).map(textOf);
}

/** @brief 请求的 system 里某个记忆分节的原文 `<名字>\n…\n</名字>`；没有时 null。 */
export function systemSection(request, name) {
  return new RegExp(`<${name}>\\n[\\s\\S]*?\\n</${name}>`).exec(request?.system ?? '')?.[0] ?? null;
}

// ---------- 会话文件 ----------

/** @brief 会话文件的条目（去掉第一行的会话头部）。 */
export const fileEntries = (file) => readJsonl(file).slice(1);

/** @brief 检查那一行的 custom_message 条目（customType mori.finish_check）。 */
export const checkEntries = (entries) => entries.filter((entry) => entry.type === 'custom_message'
  && entry.customType === 'mori.finish_check');

/** @brief 第一个文字满足 test 的 user 消息条目的下标（from 之后）；没有时 -1。 */
export function userIndex(entries, test, from = -1) {
  return entries.findIndex((entry, index) => index > from && entry.type === 'message'
    && entry.message?.role === 'user' && test(contentText(entry.message.content)));
}

/**
 * @brief 工具的 system 补丁（启用的工具变了时 pi 记的 role: system 消息，带 toolsAdded 或 toolsRemoved）在条目里的
 *        下标，只取 (from, to) 之间的。
 */
export function toolPatches(entries, from, to = entries.length) {
  const out = [];
  entries.forEach((entry, index) => {
    const message = entry.type === 'message' ? entry.message : null;
    if (index <= from || index >= to || message?.role !== 'system') return;
    if ((message.toolsAdded?.length ?? 0) > 0 || (message.toolsRemoved?.length ?? 0) > 0) out.push(index);
  });
  return out;
}

/**
 * @brief index 之前最后一条不是 system 的消息条目的下标（上一次运行的最后一条消息；下一次运行开头的工具补丁在它之后）；
 *        没有时 -1。
 */
export function lastMessageBefore(entries, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const message = entries[i].type === 'message' ? entries[i].message : null;
    if (message && message.role !== 'system') return i;
  }
  return -1;
}

/** @brief 工具结果的文字去掉 task 实例的证据编号 "[#n] "（平行 Agent 规格 §7.3）。 */
const untag = (text) => text.replace(/^\s*\[#\d+\] /, '');

/** @brief 会话条目里某个工具的结果：[{ index, text（去掉证据编号）, isError }]，按顺序。 */
export function toolResultsIn(entries, tool) {
  const out = [];
  entries.forEach((entry, index) => {
    const message = entry.type === 'message' ? entry.message : null;
    if (message?.role !== 'toolResult' || message.toolName !== tool) return;
    out.push({ index, text: untag(contentText(message.content)), isError: message.isError === true });
  });
  return out;
}

/** @brief 会话条目里助手消息调用 finish 的次数。 */
export const finishCalls = (entries) => messagesOf(entries, 'assistant').flatMap((message) => (
  Array.isArray(message.content) ? message.content : [])).filter((block) => block?.type === 'toolCall'
  && block.name === FINISH).length;

/** @brief 会话条目里 (from, to) 之间有文字的助手消息的文字（text 块相接，去掉首尾空白），按顺序。 */
export function replyTexts(entries, from = -1, to = entries.length) {
  return entries.slice(from + 1, to).filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => (Array.isArray(entry.message.content) ? entry.message.content : [])
      .filter((block) => block?.type === 'text').map((block) => block.text).join('').trim())
    .filter((text) => text !== '');
}
