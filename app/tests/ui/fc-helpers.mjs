// 收尾检查的 App 套件（tests/ui/fc-app-check.mjs）共用的准备、读取与小工具（docs/specs/finish-check.md §14.1、§14.2；
// 状态表 §10.4）：
// - 命令行与结果文件：test-results/fc-app-<suite>(-packaged).json；--only 时写 fc-partial-app-<suite>(-packaged).json
//   （不计入覆盖检查，§14.3）；
// - 模型看到的文字（§7.1 检查那一行的四种、§7.3 finish 的说明与结果），从请求的 system prompt 算出这次运行应有的
//   检查块（§6.3、§7.2：与 system prompt 的 <taste>、<review> 同一写法）；
// - 记录代理收到的请求（含检查请求：scripts.mjs sessionOf 的 check、checks，§14.4）与合成端点的日志行，按时间窗取；
// - 会话文件：检查那一行的 custom_message、只有 finish 的助手消息、finish 的结果、system 消息（补丁）；
// - 页面：对话流的每一项（正文、思考块、工具卡、回复操作行、错误卡与放回链接）、侧栏行状态、回复操作行与批准卡的
//   出现时刻（MutationObserver，window.__fc）、范围菜单、界面重新载入；
// - 数据目录（synthetic test setup）：记忆文件（按记忆规格 §3 的格式）、模型配置与档案（推理必须回传的模型改写档案的
//   第 4 步结果，同探针会记下的）。
// 只读页面和磁盘、发界面操作，不改 Mori 的源码；模型的回复全部来自合成端点（tests/fake-endpoint/，synthetic）。
// 检查结果由调用方记录。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHECK_LINE_HEAD, isCheckLine } from '../fake-endpoint/scripts.mjs';
import { appRoot, arg } from './lib.mjs';
import {
  contentText, eventsOf, paneSel, poll, readJsonl, scenarioRequests, seedTeamUserData, showTab, startTbApp,
} from './tb-helpers.mjs';
import { captureEvents, watchStages } from './v1-switch-helpers.mjs';

export { CHECK_LINE_HEAD, isCheckLine };

// ---------- 命令行与结果文件 ----------

/**
 * @brief 解析套件的命令行：--exe <Mori.exe>（打包版）、--only a,b（只跑这些步骤，结果写成 partial）。
 * @param suite 套件名（fc-app-<suite>.mjs 的 <suite>）
 * @return { suite（fc-app-<suite>）, exePath, only, file（结果文件名）, shots（截图目录） }
 */
export function fcArgs(suite) {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `fc-partial-app-${suite}${packaged}.json` : `fc-app-${suite}${packaged}.json`;
  const shots = join(appRoot, `test-results/fc-app-${suite}${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite: `fc-app-${suite}`, exePath, only, file, shots };
}

// ---------- 模型看到的文字（§7） ----------

/** finish 的工具名与检查那一行的条目种类（同 src/shared/finishCheck.ts） */
export const FINISH_TOOL = 'finish';
export const FINISH_CHECK_TYPE = 'mori.finish_check';
/** finish 的结果（§4.1）与说明的第一行（§7.3，Customize 页显示） */
export const FINISH_RESULT = 'Confirmed.';
export const FINISH_FIRST_LINE = 'Confirm that your last reply is your final reply.';
/** finish 参数校验失败时 pi 的结果开头（§3 第 11 条） */
export const FINISH_INVALID = 'Validation failed for tool "finish"';
/** 检查那一行的第一、二、四行（§7.1，逐字） */
export const CHECK_FIRST = "[Mori] This is Mori's end-of-turn check, not a message from the user. "
  + 'It is about your reply just before it.';
export const CHECK_TOOLS = "If you said you would do something and haven't done it, or a tool call you meant to make "
  + "was never sent, do it now with your tools. Don't retry calls that were rejected or denied.";
export const CHECK_REPLY = 'Anything you write now is shown to the user as your reply. If that reply is final, '
  + "including a question that waits for the user's answer, only call finish. To change it, write the new reply, "
  + 'then call finish.';
/** 错误卡上的放回链接（§10.3） */
export const PUT_BACK = 'Put your last message back in the message box';
/** 模型层的重做说明的开头（合成端点 server.mjs 的 MORI_NOTE）与隐藏过程的提示（模型层规格 §6.1） */
export const NOTE_HEAD = '[Mori] The previous model';
export const REDO_TEXT = 'The new model redoes this response.';
/** pi 的内置工具（有 promptSnippet，进 <tools>；记忆规格 MEM-01 的比较） */
export const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];

/**
 * @brief 检查那一行（§7.1）：四行以 \n 分隔，第三行按 kinds 点名，kinds 为空时没有第三行。
 * @param kinds 这次运行有内容的分节（'taste'、'review'，按这个顺序）
 */
export function checkLineOf(kinds) {
  const names = kinds.map((kind) => `<${kind}>`);
  const third = names.length === 0 ? [] : [`Otherwise check that reply against ${names.join(' and ')} below.`];
  return [CHECK_FIRST, CHECK_TOOLS, ...third, CHECK_REPLY].join('\n');
}

/**
 * @brief system prompt 里的一个分节原样（pi 的写法 "\n\n<名字>\n内容\n</名字>"）；没有时为 null。
 * @param system 请求的 system prompt 全文
 * @param name 分节名（taste、review 等）
 * @return "<名字>\n内容\n</名字>"
 */
export function sectionOf(system, name) {
  const match = new RegExp(`\\n\\n<${name}>\\n([\\s\\S]*?)\\n</${name}>(?=\\n\\n<|$)`).exec(system ?? '');
  return match ? `<${name}>\n${match[1]}\n</${name}>` : null;
}

/**
 * @brief 按一个请求的 system prompt 算出这次运行的检查那一行与检查块（§6.3、§7.2）。
 * @return { kinds, line（会话文件里的原文）, block（没有时 null）, text（检查那次请求里的全文：原文加 \n\n 检查块） }
 */
export function expectedCheck(system) {
  const taste = sectionOf(system, 'taste');
  const review = sectionOf(system, 'review');
  const kinds = [...(taste ? ['taste'] : []), ...(review ? ['review'] : [])];
  const block = taste || review ? [taste, review].filter(Boolean).join('\n') : null;
  const line = checkLineOf(kinds);
  return { kinds, line, block, text: block ? `${line}\n\n${block}` : line };
}

/**
 * @brief 身份段的 <tools> 列出的工具名与 <rules> 的各行（记忆规格 §4.1 的格式）；切不开时为 null。
 * @param system 请求的 system prompt 全文
 */
export function identityLists(system) {
  const text = system ?? '';
  const start = text.indexOf('<tools>\n');
  const end = text.indexOf('\n</tools>', start);
  const rulesStart = text.indexOf('<rules>\n', end);
  const rulesEnd = text.indexOf('\n</rules>', rulesStart);
  if (start < 0 || end < 0 || rulesStart < 0 || rulesEnd < 0) return null;
  const tools = text.slice(start + '<tools>\n'.length, end).split('\n')
    .map((row) => /^- ([^\s:]+): /.exec(row)?.[1]).filter(Boolean);
  return { tools, rules: text.slice(rulesStart + '<rules>\n'.length, rulesEnd).split('\n') };
}

// ---------- 请求与日志 ----------

/**
 * @brief 记录代理收到的对话请求（含检查请求），收到时刻在 [since, until)；每项是 tb-helpers scenarioRequests 的一项
 *        加上 check（这次是检查请求）、checks（起点之后检查那一行的条数）、last（最后一条消息的文字）。
 */
export function requestsIn(ep, since, until = Infinity) {
  return scenarioRequests(ep, null, { since, check: true }).filter((item) => item.t < until)
    .map((item) => ({ ...item, check: item.info.check === true, checks: item.info.checks,
      last: contentText(item.messages.at(-1)?.content) }));
}

/** @brief 合成端点的对话日志行（不含探针），收到时刻在 [since, until)。 */
export const linesIn = (ep, since, until = Infinity) => ep.logs.filter((line) => !line.probe && line.t >= since
  && line.t < until);

/** @brief 一组请求的“是不是检查请求”序列（检查的 detail 与断言用）。 */
export const checkFlags = (reqs) => reqs.map((item) => item.check);

/** @brief 消息里有没有连着的两条 user 消息（system 消息不算）。 */
export function consecutiveUsers(messages) {
  const list = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
  return list.some((m, index) => index > 0 && m.role === 'user' && list[index - 1].role === 'user');
}

/** @brief 请求里 user 消息的文字（按顺序）。 */
export const userTexts = (messages) => messages.filter((m) => m.role === 'user').map((m) => contentText(m.content));

/**
 * @brief 主进程与后台进程输出里这个会话的收尾检查日志（§7.4），去掉 "[kernel] <id>: " 的部分：
 *        "finish check <n> (<reason>)"、"finish check passed (<reason>)"、"the finish check request failed (…)…"。
 */
export function checkLogs(ctx, sessionId, since = 0) {
  const id = String(sessionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\[kernel\\] ${id}: ((?:finish check|the finish check request failed).*)$`);
  return ctx.appLog.filter((item) => item.t >= since).map((item) => pattern.exec(item.line)?.[1]?.trim())
    .filter(Boolean);
}

// ---------- 会话文件 ----------

/** @brief 一条消息的内容块（字符串内容时为空列表）。 */
const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : []);

/**
 * @brief 会话文件里与收尾检查有关的部分：entries（头部之后的全部条目）、messages、checks（检查那一行的
 *        custom_message 条目）、systems（system 消息：第一条与之后的补丁）、finishOnly（只有一个 finish 调用、没有
 *        非空文字的助手消息）、results（finish 的工具结果 { isError, text }）。
 */
export function fileView(file) {
  const entries = readJsonl(file).slice(1);
  const messages = entries.filter((entry) => entry.type === 'message').map((entry) => entry.message);
  const calls = (m) => blocksOf(m).filter((block) => block.type === 'toolCall');
  const texts = (m) => blocksOf(m).filter((block) => block.type === 'text' && block.text.trim());
  return {
    entries, messages,
    checks: entries.filter((entry) => entry.type === 'custom_message' && entry.customType === FINISH_CHECK_TYPE),
    systems: messages.filter((m) => m.role === 'system'),
    finishOnly: messages.filter((m) => m.role === 'assistant' && texts(m).length === 0 && calls(m).length === 1
      && calls(m)[0].name === FINISH_TOOL),
    results: messages.filter((m) => m.role === 'toolResult' && m.toolName === FINISH_TOOL)
      .map((m) => ({ isError: m.isError === true, text: contentText(m.content) })),
  };
}

/**
 * @brief 测试准备（synthetic test setup）：把会话文件改成收尾检查之前存下的样子——从第一行检查那一行起的条目
 *        （检查那一行、只有 finish 的助手消息与它的结果、之后的条目）都去掉，system 消息的 toolsAdded 里去掉 finish。
 *        条目是一条线（parentId 依次相接），去掉尾部不破坏它。Mori 必须已经关掉（不再写这个文件）。
 * @return { kept（留下的条目数）, cut（去掉的条目数） }
 */
export function rewriteWithoutFinish(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const parsed = lines.map((line) => JSON.parse(line));
  const at = parsed.findIndex((entry) => entry.type === 'custom_message' && entry.customType === FINISH_CHECK_TYPE);
  const kept = at < 0 ? parsed : parsed.slice(0, at);
  for (const entry of kept) {
    const message = entry.type === 'message' ? entry.message : null;
    if (message?.role === 'system' && Array.isArray(message.toolsAdded)) {
      message.toolsAdded = message.toolsAdded.filter((tool) => tool.name !== FINISH_TOOL);
    }
  }
  writeFileSync(file, `${kept.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { kept: kept.length, cut: parsed.length - kept.length };
}

// ---------- 页面 ----------

/**
 * @brief 某个会话面板（隐藏的也算）对话流里按顺序的每一项（Transcript.tsx 的 [data-item]）：
 *        { kind, text（前 200 个字）, empty（没有任何文字）, prose（正文段，\n 相接）, thinking（[{ open, summary }]）,
 *          tools（工具卡标题）, actions（这一项下面有回复操作行）, error（{ text, putBack } 或 null） }。
 */
export function itemsOf(ctx, tab) {
  return ctx.page.locator(`${paneSel(tab)} [data-testid="transcript"]`).evaluate((root, putBack) => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return [...root.querySelectorAll('[data-item]')].map((el) => {
      const error = el.querySelector('[data-testid="error-card"]');
      return {
        kind: el.dataset.item, text: text(el).slice(0, 200), empty: text(el) === '',
        prose: [...el.querySelectorAll('.prose')].map(text).join('\n'),
        thinking: [...el.querySelectorAll('[data-testid="thinking"]')].map((details) => ({ open: details.open,
          summary: text(details.querySelector('summary')) })),
        tools: [...el.querySelectorAll('[data-testid="tool-card"]')]
          .map((card) => text(card.querySelector('.tool-title'))),
        actions: Boolean(el.querySelector('[data-testid="reply-actions"]')),
        error: error ? { text: text(error), putBack: [...error.querySelectorAll('button')]
          .some((button) => text(button) === putBack) } : null,
      };
    });
  }, PUT_BACK);
}

/** @brief 对话流里的助手项（itemsOf 的 kind 为 assistant 的项）。 */
export const assistantItems = (items) => items.filter((item) => item.kind === 'assistant');

/** @brief 侧栏里这个会话那一行此刻的状态（data-status：running、approval、error、unseen…；没有时为 null）。 */
export function rowStatus(ctx, tab) {
  return ctx.page.locator(`.session-item[data-row="${tab}"] [data-testid="session-status"]`).first()
    .getAttribute('data-status', { timeout: 1000 }).catch(() => null);
}

/**
 * @brief 在页面里装一个记录器（window.__fc）：每个侧栏行的状态（rows：{ t, row, status }）、每个会话面板里回复操作行的
 *        个数（actions：{ t, tab, count }）与批准卡的张数（cards：{ t, tab, count }），变化时记一项（短暂的状态轮询抓不到）。
 */
export function watchFc(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__fc) return;
    window.__fc = { rows: [], actions: [], cards: [] };
    const last = new Map();
    const note = (list, key, value, item) => {
      if (last.get(key) === value) return;
      last.set(key, value);
      list.push({ t: Date.now(), ...item });
    };
    const scan = () => {
      for (const row of document.querySelectorAll('.session-item')) {
        const status = row.querySelector('[data-testid="session-status"]')?.dataset.status ?? null;
        note(window.__fc.rows, `row|${row.dataset.row}`, String(status), { row: row.dataset.row, status });
      }
      for (const pane of document.querySelectorAll('[data-testid="chat-pane"]')) {
        const actions = pane.querySelectorAll('[data-testid="reply-actions"]').length;
        note(window.__fc.actions, `actions|${pane.dataset.tab}`, String(actions), { tab: pane.dataset.tab,
          count: actions });
        const cards = pane.querySelectorAll('[data-testid="approval-card"]').length;
        note(window.__fc.cards, `cards|${pane.dataset.tab}`, String(cards), { tab: pane.dataset.tab, count: cards });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true,
      characterData: true });
    scan();
  });
}

/**
 * @brief watchFc 记下的变化。
 * @param kind 'rows' | 'actions' | 'cards'
 * @param key 只取这个侧栏行或会话面板（界面里的标识）
 */
export const fcSeen = (ctx, kind, key, since = 0) => ctx.page.evaluate(({ list, id, from }) => (window.__fc?.[list]
  ?? []).filter((item) => item.t >= from && (item.row ?? item.tab) === id), { list: kind, id: key, from: since });

/** @brief 启动 Mori（tb-helpers startTbApp：事件与阶段行的记录），再装上 watchFc。 */
export async function startFcApp(ctx) {
  await startTbApp(ctx);
  await watchFc(ctx);
  return ctx.page;
}

/**
 * @brief 界面重新载入（page.reload，与 Ctrl+R 相同，后台进程不停）：等会话列表读完，重新装上页面里的记录；
 *        之前记下的会话面板标识作废（重新打开会话时编号会变）。
 */
export async function reloadUi(ctx) {
  ctx.projectTabs = {};
  await ctx.page.reload();
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await ctx.page.getByTestId('session-tree').waitFor({ timeout: 30000 });
  await ctx.page.waitForFunction(() => document.querySelectorAll('.session-item').length > 0
    && !document.querySelector('[data-testid="session-tree"]')?.textContent?.includes('Loading sessions…'), null,
  { timeout: 20000 });
  await captureEvents(ctx.page);
  await watchStages(ctx.page);
  await watchFc(ctx);
}

/**
 * @brief 在某个会话的范围菜单里选 pick（分组 id 或 <provider>/<model>），等按钮的 data-pick 变过去、不再切换中，
 *        并等后台进程发出这个范围的 mori.model_state。
 */
export async function choosePick(ctx, tab, pick) {
  const since = Date.now();
  const button = `${paneSel(tab)} [data-testid="model-button"]`;
  await ctx.page.locator(button).click();
  await ctx.page.getByTestId('model-menu').locator(`[role="menuitemradio"][data-pick="${pick}"]`).click();
  await ctx.page.waitForFunction(({ css, want }) => {
    const el = document.querySelector(css);
    return el?.dataset.pick === want && el.dataset.pending !== 'true';
  }, { css: button, want: pick }, { timeout: 15000 });
  const state = await poll(async () => (await eventsOf(ctx.page, null, since))
    .some((item) => item.type === 'mori.model_state' && item.data.pick === pick), 5000);
  if (!state) throw new Error(`no mori.model_state for ${pick}`);
}

/** @brief 系统剪贴板里的文字（Electron 主进程的 clipboard）。 */
export const clipboardText = (ctx) => ctx.app.evaluate(({ clipboard }) => clipboard.readText());

/** @brief 点这个会话最新一轮回复下的 "Copy"，返回剪贴板里的文字。 */
export async function copyLatest(ctx, tab) {
  const row = ctx.page.locator(`${paneSel(tab)} [data-testid="reply-actions"].latest`);
  await ctx.app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await row.getByRole('button', { name: 'Copy' }).click();
  await row.getByRole('button', { name: 'Copied' }).waitFor({ timeout: 3000 }).catch(() => {});
  return clipboardText(ctx);
}

/**
 * @brief 点这个会话最新一轮回复下的 "Attach message as context"，返回输入框上方引用芯片的全文（悬停说明 title），
 *        再把芯片去掉（输入框回到空的）。
 */
export async function attachLatest(ctx, tab) {
  const pane = ctx.page.locator(paneSel(tab));
  await pane.locator('[data-testid="reply-actions"].latest').getByRole('button',
    { name: 'Attach message as context' }).click();
  const chip = pane.locator('[data-testid="quote-chip"] .quote-chip-main').first();
  await chip.waitFor({ timeout: 5000 });
  const title = await chip.getAttribute('title');
  await pane.getByRole('button', { name: /^Remove context: / }).first().click();
  return title ?? '';
}

// ---------- 数据目录（synthetic test setup） ----------

/** 记忆的四种、索引文件名与标题（记忆规格 §3.1） */
const MEMORY_KINDS = ['taste', 'strategy', 'review', 'fact'];
const INDEX_FILE = { fact: 'MEMORY.md', taste: 'TASTE.md', strategy: 'STRATEGY.md', review: 'REVIEW.md' };
const INDEX_TITLE = { fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };

/** @brief 一个 detail 文件（记忆规格 §3.2 的版式）。 */
function detailText(kind, abstract) {
  const by = JSON.stringify('2026-10-27 · You');
  return ['---', `kind: ${kind}`, `abstract: ${JSON.stringify(abstract)}`, 'source: user', `created: ${by}`,
    `modified: ${by}`, 'evidence: []', '---', '## Evidence', '', '## Details',
    'Synthetic entry written by tests/ui/fc-helpers.mjs.', '', '## Revisions', ''].join('\n');
}

/** @brief 写一层的索引与 detail（synthetic）：每种一个索引文件（没有条目的种类不写），slug 为 <prefix>-<kind>-<n>。 */
function writeLayer(base, prefix, entries) {
  mkdirSync(join(base, 'entries'), { recursive: true });
  for (const kind of MEMORY_KINDS) {
    const items = (entries[kind] ?? []).map((abstract, index) => ({ abstract,
      slug: `${prefix}-${kind}-${index + 1}` }));
    if (items.length === 0) continue;
    for (const item of items) writeFileSync(join(base, 'entries', `${item.slug}.md`), detailText(kind, item.abstract));
    const lines = items.map((item) => `- [${item.abstract}](entries/${item.slug}.md)`);
    writeFileSync(join(base, INDEX_FILE[kind]), `${[`# ${INDEX_TITLE[kind]}`, ...lines].join('\n')}\n`);
  }
}

/** @brief 项目的记忆目录名（记忆规格 §3，同 pi 的会话目录编码）。 */
const projectDirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/**
 * @brief 测试准备的记忆文件（synthetic）：用户级一层，加若干项目各一层（project.json 与条目）。
 * @param userData 数据目录
 * @param user 用户级：种类 → abstract 列表
 * @param projects [{ cwd, prefix, entries }]
 */
export function seedMemory(userData, user, projects) {
  const root = join(userData, 'memory');
  writeLayer(join(root, 'user'), 'u', user);
  for (const project of projects) {
    const base = join(root, 'projects', projectDirName(project.cwd));
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'project.json'), `${JSON.stringify({ cwd: resolve(project.cwd) }, null, 2)}\n`);
    writeLayer(base, project.prefix, project.entries);
  }
}

/**
 * @brief 写数据目录（tb-helpers seedTeamUserData），再把 replay 里的模型的档案改成探针在推理必须回传的模型上会记下的
 *        样子（第 4 步不带推理内容被拒：steps.replay 为 fail，推理字段 reasoning_content；kernel/modelProfiles.ts
 *        reasoningOf 据此给出 reasoning.replay: required）。
 * @param setup seedTeamUserData 的 setup，另加 replay（模型 id 的列表）
 */
export function seedFcUserData(userData, setup) {
  seedTeamUserData(userData, setup);
  const file = join(userData, 'model-profiles.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const profile of data.profiles) {
    if (!(setup.replay ?? []).includes(profile.modelId)) continue;
    profile.auto.steps.replay = { outcome: 'fail', detail: null };
    profile.auto.field = 'reasoning_content';
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * @brief 在记忆页加一条（记忆规格 §10.1 New entry）：让 tab 这个会话有焦点（Project 跟随它的项目），打开记忆页、选层与
 *        分节、New entry、填 Abstract 与 Details、Save，等列表里出现它，再点 Back to app。
 * @param entry { scope: 'user' | 'project', section, abstract }
 */
export async function addEntryOnPage(ctx, tab, entry) {
  const { page } = ctx;
  await showTab(ctx, tab);
  await page.getByTestId('nav-memory').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  const enabled = (id) => page.waitForFunction((testId) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    return el && !el.disabled;
  }, id, { timeout: 15000 });
  await enabled(`memory-scope-${entry.scope}`);
  const layer = page.getByTestId(`memory-scope-${entry.scope}`);
  if ((await layer.getAttribute('aria-pressed')) !== 'true') await layer.click();
  await page.getByTestId(`memory-section-${entry.section}`).click();
  await enabled('memory-new');
  await page.getByTestId('memory-new').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 10000 });
  await page.getByTestId('memory-abstract').fill(entry.abstract);
  await page.getByTestId('memory-details').fill('Added on the Memory page by tests/ui/fc-app-check.mjs.');
  await page.getByTestId('memory-save').click();
  await page.locator('[data-testid="memory-row"]', { hasText: entry.abstract }).waitFor({ timeout: 15000 });
  await page.locator('[data-testid="memory-page"] .topbar button', { hasText: 'Back to app' }).click();
  await page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 10000 });
}
