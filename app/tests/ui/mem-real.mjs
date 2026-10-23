// 记忆规格的真实模型一层（docs/specs/memory.md §14.1“真实模型一层”，§14.2 的 MEM-05、MEM-10、MEM-22、MEM-34）：
// 真正的 Mori 对负责人的两个真实模型（默认 DeepSeek 与 GLM），全部经界面操作。这台机器没有带 key 的数据目录，交付时
// 未运行（§0 第 4 条），由负责人用数据目录跑。
// 准备（synthetic test setup，见 tb-real-helpers.mjs、mem-real-helpers.mjs）：复制数据目录（只复制加密的文件，不读 key，
// 不写来源目录）；分组 [DeepSeek, GLM] 为默认范围（对话用它）；临时项目授权公网；两个提供商的地址改指本机 4795 端口的
// 转发代理（只记请求体，不记请求头），用来读请求的 system 与工具；增强的 Model range 在设置对话框里选第二个提供商（GLM），
// 两个真实模型都用到。
// 三个驱动，共用一个只有 README 的临时项目（关闭模式、Ask each time；出现的批准卡都点 Allow once）：
//   dialog：新会话里依次说 “The intranet model is at 10.0.0.9, note it.” 与 “From now on, start every answer with the
//           conclusion.”，等主 Agent 用 memory 工具记下事实与规则。
//   page：记忆页 Project → TASTE → New entry 写一条（synthetic 文字），Ctrl+N 新会话发一句，看它第一条请求的 system。
//   enhance：记忆页打开增强、Settings… 选第二个提供商、对话会话里再发一句纠正（给增强的材料）、Run now，等三个任务都结束；
//            之后新会话看第一条请求的 system，再在 Revisions 里回滚一次有改动的运行。
// 检查只断言程序保证的事（§14.1）：memory 工具的调用写出合格的条目与修订、source 为 user、依据是说这句话的那条用户消息；
// 新会话请求的 system 里有记忆页写的那条（四个分节等于盘上的条目）；增强运行结束、修订 done 或跳过、一次运行一条修订、
// Notes 是最后一条回复、每处改动的依据都在列出的范围内、增强会话里没有成功的 write/edit、水位推进到片段的最后一个条目、
// 之后的新会话用新版、Roll back this revision 恢复整次。模型写了什么（abstract、种类、层、回复、token）只写进 note。
// 前提没满足（模型没用 memory 记下、请求没发出、增强运行失败、三次运行都没有改动）时最多重跑 2 次，记在 note 里；
// 仍不满足按失败。
// --source 缺失、不存在、不合格（缺 model-config.json、credentials.json、Local State，找不到两个提供商，提供商没有 key）时
// 立即以退出码 1 结束、不写结果文件：test-results 里有了失败的 mem-real.json，覆盖检查带 --allow-missing-real 时也会按失败算。
// 用法（在 app/ 下，用 out/ 的构建或 MORI_APP_DIR 指的构建）：
//   node tests/ui/mem-real.mjs --source <数据目录> [--exe <Mori.exe>] [--only dialog,page,enhance]
// 结果写到 test-results/mem-real(-packaged).json（--only 时 mem-partial-real…，不计入覆盖检查），截图在 test-results/mem-real/。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allowProjectsLive, appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import {
  approvalCardsOf, bridge, brief, closeTbApp, contentText, kernelEvents, liveInfo, newSession, openProject, paneSel,
  paneState, readJsonl, sendMessage, showTab, startTbApp, userSession,
} from './tb-helpers.mjs';
import { prepareRealData, refOf, startForwardProxy, stopForwardProxy } from './tb-real-helpers.mjs';
import {
  addPageEntry, backToApp, chatBodies, checkSource, clickRunNow, clip60, dayNow, enhanceSessions, entryFiles, entryIds,
  entryText, expectedSections, flat, KIND_LABEL, lastAssistantText, LAYER_PROSE, layerEntries, lineId, localDate,
  memoryCalls, memoryCards, memoryDirs, monthDay, PAGE_TASTE, parseFront, parseMaterial, pathKey, PROMPTS, readIndex,
  readmeProject, readRevision, readText, revisionFiles, rollbackInUi, sectionsOf, succeeded, TASKS, toolCallsOf,
  turnOnEnhancement, userEntryBefore,
} from './mem-real-helpers.mjs';

/** 转发代理的端口（§14.1 的 4700–4799 里本套件用 4790–4799） */
const PROXY = 4795;
/** 一句对话的时限 */
const DRIVE_MS = 10 * 60 * 1000;
/** 一次 Run now（三个任务）的时限 */
const ENHANCE_MS = 30 * 60 * 1000;
/** 每个驱动最多跑几次（第一次加最多 2 次重跑，§14.1） */
const ATTEMPTS = 3;
/** 进度事件的终态（§8） */
const TERMINAL = ['done', 'skipped', 'failed'];
/** 驱动的名字（--only） */
const DRIVE_NAMES = ['dialog', 'page', 'enhance'];

/** @brief --name 的值；缺失或紧跟着另一个 --参数时为 null。 */
function argValue(name) {
  const value = arg(name);
  return value && !value.startsWith('--') ? value : null;
}

const source = argValue('source') ? resolve(argValue('source')) : null;
const exePath = argValue('exe') ? resolve(argValue('exe')) : null;
const only = argValue('only')?.split(',').filter(Boolean) ?? null;
const suffix = exePath ? '-packaged' : '';
const resultFile = only ? `mem-partial-real${suffix}.json` : `mem-real${suffix}.json`;
const shots = join(appRoot, `test-results/mem-real${suffix}`);
const { record, write } = createRecorder(exePath ?? 'dev build');
const ctx = { exePath, pageErrors: [], appLog: [], roots: [], dates: new Set([localDate()]) };

/** @brief 截图（失败也不报错）。 */
const shot = (name) => ctx.page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
/** @brief 检查的 detail：问题列表加 note。 */
const detail = (problems, note) => `${brief(problems, 1500)} — ${note}`;
/** @brief note：没满足的前提（每次一条）加上模型的表现。 */
const noteOf = (notes, model) => `${notes.join('; ')}${notes.length ? '; ' : ''}model: ${brief(model, 1800)}`;
/** @brief 每个编号各记一条同样的检查。 */
function recordAll(ids, name, ok, text) {
  for (const id of ids) record(`${id} ${name}`, ok, text);
}

// ---------- 会话与驱动的小步骤 ----------

/** @brief 会话的标识：{ tab, sessionId, sessionFile, since, project, cards }；侧栏还没有它的文件时抛错。 */
async function sessionOf(tab, since, project) {
  const found = await userSession(ctx, tab);
  if (!found?.sessionFile) throw new Error(`the session in pane ${tab} has no session file in the sidebar`);
  return { tab, ...found, since, project, cards: [] };
}

/** @brief 用户会话此刻空闲（后台进程里不在运行或准备中、协作空闲，界面不在生成或发送）。 */
async function idleNow(who) {
  const info = await liveInfo(ctx, who.sessionFile).catch(() => null);
  const pane = await paneState(ctx.page, who.tab);
  return Boolean(info && !info.team.busy && !info.live?.running && !info.live?.preparing && pane && !pane.running
    && !pane.sending);
}

/**
 * @brief 等会话空闲（连续 3 秒）；期间出现的批准卡记下工具名并点 Allow once（§14.1 驱动：命令照常要批准，memory 不要）。
 * @return 空闲时为 true，超时为 false
 */
async function waitIdleAnswering(who, timeout = DRIVE_MS) {
  const deadline = Date.now() + timeout;
  let calm = null;
  while (Date.now() < deadline) {
    for (const card of await approvalCardsOf(ctx, who.tab)) {
      if (who.cards.some((seen) => seen.request === card.request)) continue;
      who.cards.push({ request: card.request, tool: card.tool });
      await ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"][data-request="${card.request}"] `
        + '[data-testid="approval-allow"]').click({ timeout: 5000 }).catch(() => {});
    }
    calm = (await idleNow(who)) ? calm ?? Date.now() : null;
    if (calm && Date.now() - calm >= 3000) return true;
    await sleep(500);
  }
  return false;
}

/** @brief 在会话里发一句并等它空闲；返回是否空闲。 */
async function say(who, text) {
  await sendMessage(ctx, who.tab, text);
  return waitIdleAnswering(who);
}

/** @brief 新的只有 README 的临时项目：经进程桥授权公网（synthetic test setup），点 Open folder… 打开它。 */
async function newProject() {
  const project = readmeProject();
  ctx.roots.push(resolve(project, '..'));
  await allowProjectsLive(ctx.page, [project]);
  return { project, tab: await openProject(ctx, project) };
}

/** @brief 记下后面的驱动共用的项目与对话会话；cwd 取会话文件头部记的工作目录（Mori 用的原文）。 */
function adopt(who) {
  ctx.project = who.project;
  ctx.cwd = readJsonl(who.sessionFile)[0]?.cwd ?? who.project;
  ctx.dirs = memoryDirs(ctx.userData, ctx.cwd);
  ctx.dialog = who;
}

/** @brief 没跑 dialog 时（--only）也要有项目和一个有对话的会话：新项目里发一句。 */
async function ensureProject() {
  if (ctx.dialog) return;
  const { project, tab } = await newProject();
  const since = Date.now();
  await sendMessage(ctx, tab, PROMPTS.HELLO);
  const who = await sessionOf(tab, since, project);
  if (!(await waitIdleAnswering(who))) throw new Error('the first session did not settle');
  adopt(who);
}

/** @brief Ctrl+N 新会话发一句（文字要在这次运行里唯一），等它空闲；返回会话、打开时盘上的分节与第一条请求。 */
async function freshSession(text) {
  await backToApp(ctx.page);
  await showTab(ctx, ctx.dialog.tab);
  const tab = await newSession(ctx);
  const expected = expectedSections(ctx.dirs);
  const since = Date.now();
  await sendMessage(ctx, tab, text);
  const who = await sessionOf(tab, since, ctx.project);
  const idle = await waitIdleAnswering(who);
  const request = chatBodies(ctx.proxy, { since, cwd: ctx.cwd }).find((r) => r.lastUser.includes(text)) ?? null;
  return { who, expected, request, idle };
}

/**
 * @brief 前提没满足时重跑（最多 ATTEMPTS 次）：once(attempt, 上一次的结果) 返回 { unmet, … }，抛错算没满足。
 *        仍没满足时给 ids 各记一条失败。
 * @return { take（最后一次的结果）, notes（每次没满足的原因） }
 */
async function withRetries(drive, once) {
  const notes = [];
  let take = {};
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      take = await once(attempt, take);
    } catch (error) {
      take = { ...take, unmet: `flow: ${oneLine(error, 300)}` };
    }
    await shot(`${drive.name}-${attempt}`);
    if (!take.unmet) break;
    notes.push(`attempt ${attempt}: ${take.unmet}`);
  }
  if (notes.length) console.log(`[mem-real] ${drive.name}: ${notes.join('; ')}`);
  if (take.unmet) {
    recordAll(drive.ids, `real ${drive.name}: the drive's precondition holds within ${ATTEMPTS} attempts`, false,
      notes.join('; '));
  }
  return { take, notes };
}

// ---------- 修订与条目的核对（§3、§6.5） ----------

/** @brief 修订小节的动作 → counts。 */
function countsOf(changes) {
  const n = (action) => changes.filter((c) => c.action === action).length;
  return { added: n('Added'), changed: n('Changed'), deleted: n('Deleted'),
    moved: changes.filter((c) => c.action.startsWith('Moved')).length };
}

/**
 * @brief 修订 frontmatter（§3.3）：id 与 time 的写法，want 里给出的 by、title、status、layers、kinds、counts、rollbackOf、
 *        cwd（路径比较不分大小写与斜杠）。
 */
function headProblems(front, want) {
  const problems = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (front.id !== want.id || !/^\d{8}-\d{6}-[a-z0-9]{4}$/.test(String(front.id))) problems.push(`id ${front.id}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(String(front.time))) {
    problems.push(`time ${front.time}`);
  }
  for (const key of ['by', 'title', 'status']) {
    if (want[key] !== undefined && front[key] !== want[key]) {
      problems.push(`${key} "${front[key]}", want "${want[key]}"`);
    }
  }
  for (const key of ['layers', 'kinds', 'counts']) {
    if (want[key] !== undefined && !same(front[key], want[key])) {
      problems.push(`${key} ${JSON.stringify(front[key])}, want ${JSON.stringify(want[key])}`);
    }
  }
  if ((front.rollbackOf ?? null) !== (want.rollbackOf ?? null)) problems.push(`rollbackOf ${front.rollbackOf}`);
  if (want.cwd !== undefined && pathKey(front.cwd ?? '') !== pathKey(want.cwd ?? '')) problems.push(`cwd ${front.cwd}`);
  return problems;
}

/** @brief 依据行（§3.2）。 */
function evidenceLine(item) {
  const quote = item.quote ? `: “${item.quote}”` : '';
  if (item.feedback !== undefined) return `${monthDay(item.at)} · Feedback${quote}`;
  return `${monthDay(item.at)} · Session “${item.title ?? 'Untitled session'}”${quote}`;
}

/**
 * @brief 一份 detail 文件（§3.2）：frontmatter 有 kind、abstract、source、created、modified、evidence；正文依次是
 *        `## Evidence`（由 evidence 生成的行）、`## Details`、`## Revisions`。
 * @param want { kind, source, by（modified 的谁）, created（新增时 created 的谁；不给时只查写法） }
 */
function detailProblems(text, want) {
  const parsed = parseFront(text);
  if (!parsed) return ['the detail file has no frontmatter'];
  const { front, body } = parsed;
  const problems = [];
  if (front.kind !== want.kind || front.source !== want.source) {
    problems.push(`kind/source ${front.kind}/${front.source}, want ${want.kind}/${want.source}`);
  }
  if (typeof front.abstract !== 'string' || !front.abstract.trim() || front.abstract.includes('\n')) {
    problems.push(`abstract ${JSON.stringify(front.abstract)}`);
  }
  const by = (who) => new RegExp(`^\\d{4}-\\d{2}-\\d{2} · ${who}$`);
  const created = by(want.created ?? '(You|Mori|Enhancement)');
  if (!by(want.by).test(String(front.modified)) || !created.test(String(front.created))) {
    problems.push(`created "${front.created}" / modified "${front.modified}"`);
  }
  const evidence = Array.isArray(front.evidence) ? front.evidence : null;
  if (!evidence) return [...problems, 'evidence is not a list'];
  const lines = evidence.map((item) => `- ${flat(evidenceLine(item))}`).join('\n');
  const head = lines ? `## Evidence\n${lines}\n\n## Details` : '## Evidence\n\n## Details';
  if (!body.startsWith(head) || !body.includes('\n## Revisions')) {
    problems.push('the body is not Evidence, Details, Revisions');
  }
  return problems;
}

/** @brief 条目现在的文件与索引行等于一节的 after（after 为空时文件与索引行都不在）。 */
function currentProblems(dir, kind, slug, after) {
  const now = readText(join(dir, 'entries', `${slug}.md`)) ?? '';
  const line = readIndex(dir, kind).find((item) => item.slug === slug);
  const problems = [];
  if (now !== after) problems.push(`entries/${slug}.md is not the after block`);
  if (Boolean(line) !== (after !== '')) problems.push(`index line for ${slug} is ${line ? 'there' : 'missing'}`);
  if (line && line.text !== parseFront(after)?.front.abstract) problems.push(`index text "${line.text}"`);
  return problems;
}

// ---------- dialog（MEM-10、MEM-34） ----------

/** 工具结果的动词与修订小节的动作（§7.4、§3.3） */
const RESULT_VERB = { save: 'Saved to', update: 'Updated', forget: 'Deleted from' };
const SECTION_VERB = { save: 'Added', update: 'Changed', forget: 'Deleted' };

/**
 * @brief 依据（§7.3 agent）：一项 { at, session, entry, title, quote }，session 是这个用户会话的文件，entry 是这次运行
 *        那条用户消息（不是前一条），at 是写入当天，quote 是调用给的原话。
 */
function agentEvidenceProblems(ev, { item, entries, who }) {
  const problems = [];
  const keys = Object.keys(ev ?? {}).join(',');
  if (keys !== 'at,session,entry,title,quote') problems.push(`evidence keys ${keys}`);
  if (pathKey(ev?.session) !== pathKey(who.sessionFile)) problems.push(`session ${ev?.session}`);
  const said = userEntryBefore(entries, item.entry);
  if (ev?.entry !== said) problems.push(`entry ${ev?.entry}, want ${said} (the user message of that turn)`);
  if (!ctx.dates.has(ev?.at)) problems.push(`at ${ev?.at}`);
  if (typeof ev?.title !== 'string' || !ev.title.trim()) problems.push('no session title');
  const quote = typeof ev?.quote === 'string' ? ev.quote.trim() : '';
  if (!quote || quote !== String(item.args.quote ?? '').trim()) problems.push(`quote ${JSON.stringify(ev?.quote)}`);
  return problems;
}

/** @brief 一节的前后原文按动作（save：前空后为合格的 detail；update：前后都有、依据追加一项；forget：后空、Note 为原因）。 */
function blockProblems(action, change, ctx2) {
  const { item, kind } = ctx2;
  if (action === 'forget') {
    const problems = change.after === '' && change.before !== '' ? [] : ['forget: after must be empty'];
    return change.note === flat(item.args.note ?? '').trim() || change.note === flat(item.args.note ?? '')
      ? problems : [...problems, `Note "${change.note}"`];
  }
  const problems = detailProblems(change.after, { kind, source: 'user', by: 'Mori',
    created: action === 'save' ? 'Mori' : undefined });
  const before = action === 'save' ? [] : parseFront(change.before)?.front.evidence ?? null;
  if (action === 'save' && change.before !== '') problems.push('save: before must be empty');
  if (action === 'update' && !before) problems.push('update: before is not a detail file');
  const history = `· Mori: ${flat(item.args.note ?? '').trim()}`;
  if (action === 'update' && ![...ctx.dates].some((day) => change.after.includes(`\n- ${monthDay(day)} ${history}`))) {
    problems.push(`update: no "## Revisions" line "<Mon D> ${history}"`);
  }
  const evidence = parseFront(change.after)?.front.evidence ?? [];
  if (evidence.length !== (before?.length ?? 0) + 1) problems.push(`evidence has ${evidence.length} items`);
  else problems.push(...agentEvidenceProblems(evidence.at(-1), ctx2));
  return problems;
}

/**
 * @brief 一次成功的 memory 调用（agent 调用方）写出的东西（§3、§6.5、§7.3、§7.4）：结果原文与 details；那一层的修订
 *        （by Mori、done、标题、层、种类、counts、只有这一节、cwd）；这一节的前后原文（blockProblems）；是这个条目最后
 *        一次改动时，现在的文件与索引行等于 after。
 * @param ctx2 { entries, who, latest（这个条目最后一次改动的调用） }
 */
function callProblems(item, ctx2) {
  const d = item.result.details ?? {};
  const action = item.args.action;
  if (d.action !== action || typeof d.revision !== 'string' || !KIND_LABEL[d.kind] || !LAYER_PROSE[d.layer]
    || typeof d.entry !== 'string') return [`details ${brief(d, 300)} for ${action}`];
  const dir = ctx.dirs[d.layer];
  const rev = readRevision(join(dir, 'revisions', `${d.revision}.md`));
  if (!rev || rev.error) return [`revision ${d.revision} in the ${d.layer} layer: ${rev?.error ?? 'missing'}`];
  const change = rev.changes[0] ?? { action: null, slug: null, before: '', after: '' };
  const abstract = parseFront(action === 'forget' ? change.before : change.after)?.front.abstract ?? '';
  const verb = SECTION_VERB[action];
  const problems = headProblems(rev.front, { id: d.revision, by: 'Mori', status: 'done', layers: [d.layer],
    title: `Mori · ${verb} ${KIND_LABEL[d.kind]}: ${clip60(abstract)}`, kinds: [d.kind], counts: countsOf(rev.changes),
    cwd: d.layer === 'project' ? ctx.cwd : undefined });
  if (rev.changes.length !== 1 || change.action !== verb || change.slug !== d.entry) {
    problems.push(`sections ${rev.changes.map((c) => `${c.action} ${c.slug}`).join(', ')}`);
  }
  const want = `${RESULT_VERB[action]} ${KIND_LABEL[d.kind]} (${LAYER_PROSE[d.layer]}): ${abstract}`;
  const text = contentText(item.result.content);
  if (text !== want) problems.push(`result "${oneLine(text, 200)}", want "${want}"`);
  problems.push(...blockProblems(action, change, { ...ctx2, item, kind: d.kind }));
  if (ctx2.latest === item) problems.push(...currentProblems(dir, d.kind, d.entry, change.after));
  return problems.map((problem) => `${action} ${d.layer}/${d.entry}: ${problem}`);
}

/** @brief 这一轮（某句话）引起的、成功的 save：kind 在 kinds 里，引起它的用户消息含 text。 */
function turnSave(entries, calls, text, kinds) {
  return calls.find((item) => succeeded(item) && item.args.action === 'save'
    && kinds.includes(item.result.details?.kind)
    && entryText(entries, userEntryBefore(entries, item.entry)).includes(text)) ?? null;
}

/** @brief dialog 的一次：新项目、新会话，依次说事实与规则。 */
async function dialogOnce() {
  const { project, tab } = await newProject();
  const since = Date.now();
  await sendMessage(ctx, tab, PROMPTS.FACT);
  const who = await sessionOf(tab, since, project);
  const idle = [await waitIdleAnswering(who), await say(who, PROMPTS.RULE)];
  adopt(who);
  const entries = readJsonl(who.sessionFile).slice(1);
  const calls = memoryCalls(entries);
  const saves = { fact: turnSave(entries, calls, PROMPTS.FACT, ['fact']),
    rule: turnSave(entries, calls, PROMPTS.RULE, TASKS) };
  const unmet = idle.includes(false) ? `the dialog did not settle within ${DRIVE_MS / 60000} minutes`
    : !saves.fact ? 'the agent did not save the fact with the memory tool'
      : !saves.rule ? 'the agent did not save the rule with the memory tool' : null;
  return { who, entries, calls, saves, unmet };
}

/** @brief 每个条目最后一次成功改动它的调用（按层与 id）。 */
function latestCalls(calls) {
  const latest = new Map();
  for (const item of calls.filter(succeeded)) {
    const d = item.result.details ?? {};
    latest.set(`${d.layer}/${d.entry}`, item);
  }
  return latest;
}

/** @brief dialog 的检查（MEM-10、MEM-34）：事实、规则两次 save 写出的条目与修订，其余成功的调用，工具卡与批准。 */
async function dialogChecks(take, notes) {
  const { who, entries, calls, saves } = take;
  const latest = latestCalls(calls);
  const latestOf = (item) => latest.get(`${item.result.details?.layer}/${item.result.details?.entry}`);
  const note = noteOf(notes, { calls: calls.map((c) => [c.args.action, c.args.kind, c.args.layer, c.args.abstract,
    c.result ? oneLine(contentText(c.result.content), 160) : 'no result']), cards: who.cards.map((c) => c.tool) });
  for (const [key, what, layer] of [['fact', 'fact', null], ['rule', 'rule', 'project']]) {
    const item = saves[key];
    const problems = item ? callProblems(item, { entries, who, latest: latestOf(item) }) : [`no save for the ${what}`];
    if (item && layer && item.result.details?.layer !== layer) {
      problems.push(`the rule went to ${item.result.details?.layer}`);
    }
    recordAll(['MEM-10', 'MEM-34'], `real dialog: the main agent's memory save of the ${what} writes a well-formed `
      + `entry (source user, created by Mori${layer ? ', this project' : ''}), its index line and one "Mori · Added" `
      + 'revision (done, one Added section whose after block is the entry file), and its evidence is the user\'s '
      + 'quote with this session file and the id of the user message that said it', problems.length === 0,
    detail(problems, note));
  }
  const others = calls.filter((item) => succeeded(item) && item !== saves.fact && item !== saves.rule);
  if (others.length) {
    const problems = others.flatMap((item) => callProblems(item, { entries, who, latest: latestOf(item) }));
    recordAll(['MEM-10', 'MEM-34'], `real dialog: every other successful memory call (${others.length}: `
      + `${others.map((c) => c.args.action).join(', ')}) wrote its entry change and one revision`,
    problems.length === 0, detail(problems, note));
  }
  await cardChecks(take, note);
  await viewInMemoryCheck(take, note);
}

/** @brief MEM-10：memory 不要批准（mori.tool_gate 为 free、没有批准卡）；完成的 memory 卡有 View in Memory，失败的没有。 */
async function cardChecks(take, note) {
  const { who, calls } = take;
  await showTab(ctx, who.tab);
  const cards = await memoryCards(ctx.page, who.tab);
  const gates = await kernelEvents(ctx, who.sessionId, 'mori.tool_gate', who.since);
  const gateOf = (id) => gates.filter((e) => e.data?.toolCallId === id).at(-1)?.data.gate ?? null;
  const problems = [
    ...calls.filter((c) => succeeded(c) && gateOf(c.call.id) !== 'free')
      .map((c) => `gate ${gateOf(c.call.id)} for ${c.call.id}`),
    ...who.cards.filter((c) => c.tool === 'memory').map((c) => `approval card ${c.request} for memory`),
  ];
  const done = cards.filter((c) => c.status === 'done');
  const ok = calls.filter(succeeded).length;
  if (done.length !== ok || done.some((c) => !c.view)) {
    problems.push(`done cards ${brief(done)}, successful calls ${ok}`);
  }
  if (cards.some((c) => c.status !== 'done' && c.view)) problems.push('a card that is not done shows View in Memory');
  record('MEM-10 real dialog: memory calls need no approval (mori.tool_gate free, no approval card), and each done '
    + 'memory card shows View in Memory while failed ones do not', problems.length === 0, detail(problems, note));
}

/** @brief MEM-10：事实那张卡的 View in Memory 打开记忆页那一层的 Facts，选中那一条、右栏是它的详情。 */
async function viewInMemoryCheck(take, note) {
  const item = take.saves.fact;
  if (!item) return;
  const d = item.result.details;
  const card = ctx.page.locator(`${paneSel(take.who.tab)} [data-testid="tool-card"]`)
    .filter({ hasText: 'Save to Facts' }).filter({ has: ctx.page.getByTestId('tool-memory-view') }).first();
  await card.getByTestId('tool-memory-view').click();
  const ok = await ctx.page.waitForFunction(({ layer, entry }) => {
    const pressed = (css) => document.querySelector(css)?.getAttribute('aria-pressed') === 'true';
    return pressed(`[data-testid="memory-scope-${layer}"]`) && pressed('[data-testid="memory-section-facts"]')
      && pressed(`[data-testid="memory-row"][data-id="${entry}"]`)
      && Boolean(document.querySelector('[data-testid="memory-detail"]'));
  }, { layer: d.layer, entry: d.entry }, { timeout: 15000 }).then(() => true, () => false);
  await shot('view-in-memory');
  record('MEM-10 real dialog: View in Memory on the fact card opens the Memory page at that layer and Facts with the '
    + 'entry selected and its details open', ok, `${d.layer}/${d.entry} — ${note}`);
  await backToApp(ctx.page);
}

// ---------- page（MEM-05、MEM-34） ----------

/** @brief 记忆页写的那条在盘上：条目（本项目 TASTE，source user，You）与它的 “You · Added TASTE” 修订。 */
function pageWriteProblems(write) {
  const entry = layerEntries(ctx.dirs.project, 'taste').find((e) => e.abstract === PAGE_TASTE.abstract);
  if (!entry) return ['no project TASTE entry with that abstract'];
  const problems = detailProblems(entry.text, { kind: 'taste', source: 'user', by: 'You', created: 'You' });
  if ((entry.front.evidence ?? []).length !== 0) problems.push('a page entry has evidence');
  if (!entry.text.includes(`## Details\n${PAGE_TASTE.details}\n`)) problems.push('Details is not the text typed');
  const rev = write.revision ? readRevision(write.revision.file) : null;
  if (!rev || rev.error) return [...problems, `revision: ${rev?.error ?? 'none written'}`];
  problems.push(...headProblems(rev.front, { id: write.revision.id, by: 'You', status: 'done', layers: ['project'],
    kinds: ['taste'], title: `You · Added TASTE: ${clip60(PAGE_TASTE.abstract)}`,
    counts: { added: 1, changed: 0, deleted: 0, moved: 0 }, cwd: ctx.cwd }));
  const change = rev.changes[0];
  if (rev.changes.length !== 1 || change.action !== 'Added' || change.slug !== entry.slug || change.before !== ''
    || change.after !== entry.text) problems.push('the revision section is not Added with the entry file as after');
  return problems;
}

/** @brief page 的一次：记忆页写一条（已有时不再写），新会话发一句，取它第一条请求。 */
async function pageOnce() {
  if (!ctx.pageWrite) {
    const before = new Set(revisionFiles(ctx.dirs.project).map((r) => r.id));
    await addPageEntry(ctx.page, PAGE_TASTE);
    await shot('page-entry');
    ctx.pageWrite = { revision: revisionFiles(ctx.dirs.project).find((r) => !before.has(r.id)) ?? null };
  }
  const fresh = await freshSession(PROMPTS.HELLO);
  return { ...fresh, unmet: fresh.request ? null : 'no request of the new session reached the provider' };
}

/** @brief page 的检查：记忆页写下的（MEM-05），新会话第一条请求的分节（MEM-05、MEM-34）。 */
function pageChecks(take, notes) {
  const note = noteOf(notes, { provider: take.request?.provider, model: take.request?.model, idle: take.idle });
  const written = pageWriteProblems(ctx.pageWrite ?? {});
  record('MEM-05 real page: New entry on the Memory page writes a project TASTE entry (source user, by You, the typed '
    + 'Details, no evidence) and one "You · Added TASTE" revision', written.length === 0, detail(written, note));
  const got = take.request ? sectionsOf(take.request.system) : null;
  const line = `- ${PAGE_TASTE.abstract}`;
  const problems = !got ? ['no request'] : [
    ...(got.taste?.split('\n').includes(line) ? [] : [`<taste> has no "${line}": ${JSON.stringify(got.taste)}`]),
    ...Object.keys(take.expected).filter((key) => got[key] !== take.expected[key])
      .map((key) => `<${key}> ${JSON.stringify(got[key])}, want ${JSON.stringify(take.expected[key])}`),
  ];
  recordAll(['MEM-05', 'MEM-34'], 'real page: the first request of the next new session has the Memory page\'s TASTE '
    + 'entry in its system <taste> section, and its four sections equal the entries on disk (user level first)',
  problems.length === 0, detail(problems, note));
}

// ---------- enhance（MEM-22、MEM-34） ----------

/** @brief 这个项目从 since 起的增强进度事件（§8 mori.enhance_progress），按收到的顺序：[{ t, …data }]。 */
async function progressSince(since) {
  const events = await kernelEvents(ctx, null, 'mori.enhance_progress', since);
  return events.filter((e) => pathKey(e.data?.cwd) === pathKey(ctx.cwd)).map((e) => ({ t: e.t, ...e.data }));
}

/** @brief 等三个任务都到终态、这个项目没有在跑也没有排着（enhance.get）；超时为 false。 */
async function waitEnhanceIdle(since) {
  const deadline = Date.now() + ENHANCE_MS;
  while (Date.now() < deadline) {
    const info = await bridge(ctx, { type: 'enhance.get', cwd: ctx.cwd }).catch(() => null);
    const events = await progressSince(since);
    const ended = TASKS.every((task) => events.some((e) => e.task === task && TERMINAL.includes(e.phase)));
    if (ended && info && info.running === null && info.queued === 0) return true;
    await sleep(2000);
  }
  return false;
}

/**
 * @brief 这次 Run now 的每次运行（终态事件一项）：修订、增强会话（这次运行 running 到终态之间建的、第一条消息是这个
 *        任务的）、第一条消息列出的材料、运行前的条目快照。
 */
async function runsSince(since, attempt, snapshot) {
  const events = await progressSince(since);
  const sessions = enhanceSessions(ctx.dirs.project, since - 5000);
  return events.filter((e) => TERMINAL.includes(e.phase)).map((end) => {
    const start = events.filter((e) => e.task === end.task && e.phase === 'running' && e.t <= end.t).at(-1)?.t ?? since;
    const session = sessions.find((s) => s.task === end.task && s.t >= start - 5000 && s.t <= end.t + 5000) ?? null;
    const rev = end.revision ? readRevision(join(ctx.dirs.project, 'revisions', `${end.revision}.md`)) : null;
    return { attempt, task: end.task, day: end.day, phase: end.phase, error: end.error ?? null,
      revision: end.revision ?? null, rev, session, material: session ? parseMaterial(session.first) : null, snapshot };
  });
}

/** @brief 一次运行改到的条目数（added + changed + deleted）。 */
const changedCount = (run) => (run.rev?.changes ?? []).length;

/** @brief enhance 的一次：对话会话里发一句纠正（材料），快照条目，Run now，等三个任务都结束。 */
async function enhanceOnce(attempt, runs) {
  await backToApp(ctx.page);
  await showTab(ctx, ctx.dialog.tab);
  if (!(await say(ctx.dialog, PROMPTS.CORRECTIONS[attempt - 1]))) return { unmet: 'the dialog did not settle' };
  const snapshot = entryFiles(ctx.dirs.project);
  const since = Date.now();
  await clickRunNow(ctx.page);
  const finished = await waitEnhanceIdle(since);
  const mine = await runsSince(since, attempt, snapshot);
  runs.push(...mine);
  const failed = mine.filter((r) => r.phase === 'failed');
  const unmet = !finished ? `the runs did not finish within ${ENHANCE_MS / 60000} minutes`
    : failed.length ? `failed: ${failed.map((r) => `${r.task}: ${r.error}`).join('; ')}`
      : !runs.some((r) => r.phase === 'done' && changedCount(r) > 0) ? 'no run changed an entry' : null;
  return { unmet };
}

/**
 * @brief 一次完成的运行的修订（§3.3、§9.8）：by Enhancement、done、标题 `<KIND> enhancement · <Mon D>`、层只有本项目、
 *        种类是这个任务、counts 按节、cwd、run（task、day、tokens 为数、sessions 与 feedback 等于列出的数）。
 */
function runHeadProblems(run) {
  if (!run.rev || run.rev.error) return [`no readable revision ${run.revision}: ${run.rev?.error ?? 'missing'}`];
  const front = run.rev.front;
  const problems = headProblems(front, { id: run.revision, by: 'Enhancement', status: 'done',
    title: `${KIND_LABEL[run.task]} enhancement · ${monthDay(run.day)}`, counts: countsOf(run.rev.changes),
    cwd: ctx.cwd });
  if (!(front.layers ?? []).every((layer) => layer === 'project')) {
    problems.push(`layers ${JSON.stringify(front.layers)}`);
  }
  const kinds = front.kinds ?? [];
  if (!kinds.every((kind) => kind === run.task) || (changedCount(run) > 0 && kinds.length !== 1)) {
    problems.push(`kinds ${JSON.stringify(kinds)}`);
  }
  const r = front.run ?? {};
  if (r.task !== run.task || r.day !== run.day || typeof r.tokens !== 'number') {
    problems.push(`run ${JSON.stringify(r)}`);
  }
  if (!run.session) problems.push('no enhancement session file for this run');
  else if (r.sessions !== run.material.sessions.length || r.feedback !== run.material.feedback.length) {
    problems.push(`run counts ${r.sessions}/${r.feedback}, listed ${run.material.sessions.length}/`
      + `${run.material.feedback.length}`);
  }
  return problems;
}

/** @brief 每个任务最后一次运行：没有失败；enhance.json 的 last 与 running；跳过的没有修订。 */
function endProblems(runs, json) {
  const problems = [];
  for (const task of TASKS) {
    const last = runs.filter((r) => r.task === task).at(-1);
    const state = json?.tasks?.[task];
    if (!last || last.phase === 'failed') problems.push(`${task}: ${last ? `failed (${last.error})` : 'no run'}`);
    else if (state?.last?.status !== last.phase || (state.last.revision ?? null) !== last.revision || state.running) {
      problems.push(`${task}: enhance.json last ${JSON.stringify(state?.last)} running ${state?.running}`);
    }
  }
  for (const run of runs.filter((r) => r.phase === 'skipped' && r.revision)) {
    problems.push(`${run.task}: a skipped run has revision ${run.revision}`);
  }
  for (const run of runs.filter((r) => r.phase === 'done')) {
    problems.push(...runHeadProblems(run).map((p) => `${run.task} ${run.revision}: ${p}`));
  }
  return problems;
}

/**
 * @brief 一次运行一条修订（§9.8）：成功的 memory 调用都记在这条修订里；每个条目一节（before 是运行前的文件，最后一次运行的
 *        after 是现在的文件）；先加后删的不出现；只改本项目这一种的 learned 条目。
 * @param last 这个任务最后一次完成的运行
 */
function sectionProblems(run, last) {
  const problems = [];
  const changes = run.rev?.changes ?? [];
  const slugs = changes.map((c) => c.slug);
  if (new Set(slugs).size !== slugs.length) problems.push(`an entry has more than one section: ${slugs.join(', ')}`);
  for (const c of changes) {
    if (c.kind !== KIND_LABEL[run.task] || !['Added', 'Changed', 'Deleted'].includes(c.action)) {
      problems.push(`section ${c.action} · ${c.kind} · ${c.slug}`);
    }
    if (c.before !== (run.snapshot[c.slug] ?? '')) problems.push(`${c.slug}: before is not the file before the run`);
    if ((c.action === 'Added') !== (c.before === '') || (c.action === 'Deleted') !== (c.after === '')) {
      problems.push(`${c.slug}: ${c.action} with before/after ${Boolean(c.before)}/${Boolean(c.after)}`);
    }
    for (const text of [c.before, c.after].filter(Boolean)) {
      const front = parseFront(text)?.front;
      if (front?.kind !== run.task || front?.source !== 'learned') {
        problems.push(`${c.slug}: ${front?.kind}/${front?.source}`);
      }
    }
    if (run === last) problems.push(...currentProblems(ctx.dirs.project, run.task, c.slug, c.after));
  }
  const calls = run.session ? memoryCalls(run.session.entries).filter(succeeded) : [];
  const elsewhere = calls.filter((item) => item.result.details?.revision !== run.revision);
  if (elsewhere.length) problems.push(`${elsewhere.length} successful memory calls name another revision`);
  const touched = new Set(calls.map((item) => item.result.details?.entry));
  for (const slug of slugs.filter((s) => !touched.has(s))) problems.push(`${slug}: a section without a memory call`);
  for (const slug of [...touched].filter((s) => !slugs.includes(s))) {
    const left = run === last && existsSync(join(ctx.dirs.project, 'entries', `${slug}.md`));
    if (run.snapshot[slug] !== undefined || left) {
      problems.push(`${slug}: changed by the run but has no section`);
    }
  }
  return problems.map((p) => `${run.task} ${run.revision}: ${p}`);
}

/** @brief 一个会话路径在列出的材料里（列出的会话文件或列出的 TaskBoard 目录 sessions/ 下）：exact 时要求原样。 */
function listedFile(material, path, exact) {
  const same = (a, b) => (exact ? a === b : pathKey(a) === pathKey(b));
  const session = material.sessions.find((s) => same(s.file, path));
  if (session) return session.file;
  const team = material.sessions.find((s) => s.team && (exact ? String(path).startsWith(join(s.team, 'sessions'))
    : pathKey(path).startsWith(pathKey(join(s.team, 'sessions')))));
  return team && existsSync(path) ? path : null;
}

/** @brief 一项依据在材料里（§7.3、§9.7）：反馈名列出了；会话文件列出了、条目 id 在那个文件里。 */
function evidenceRangeProblem(ev, material, exact) {
  if (ev?.feedback !== undefined) return material.feedback.includes(ev.feedback) ? null : `feedback ${ev.feedback}`;
  const file = listedFile(material, ev?.session, exact);
  if (!file) return `session ${ev?.session} is not listed${exact ? ' verbatim' : ''}`;
  return entryIds(file).has(ev.entry) ? null : `entry ${ev.entry} is not in ${file}`;
}

/**
 * @brief 每处改动的依据都在这次运行的材料里（§7.3、§9.7）：成功调用给的依据（会话路径不分大小写与斜杠），以及条目
 *        这次新增的依据（存的是列出的路径原样）。
 */
function evidenceProblems(run) {
  if (!run.session || !run.material) return [];
  const problems = [];
  for (const item of memoryCalls(run.session.entries).filter(succeeded)) {
    for (const [n, ev] of (Array.isArray(item.args.evidence) ? item.args.evidence : []).entries()) {
      // 两种写法都不是的项不会通过 schema；成功的调用里没有这样的项，这里只看两种写法
      if (typeof ev.session !== 'string' && typeof ev.feedback !== 'string') continue;
      const problem = evidenceRangeProblem(ev, run.material, false);
      if (problem) problems.push(`call ${item.call.id} evidence ${n + 1}: ${problem}`);
    }
  }
  for (const c of (run.rev?.changes ?? []).filter((change) => change.after)) {
    const old = new Set((parseFront(c.before)?.front.evidence ?? []).map((ev) => JSON.stringify(ev)));
    for (const ev of (parseFront(c.after)?.front.evidence ?? []).filter((e) => !old.has(JSON.stringify(e)))) {
      const problem = evidenceRangeProblem(ev, run.material, true);
      if (problem) problems.push(`${c.slug} stored evidence: ${problem}`);
    }
  }
  return problems.map((p) => `${run.task} ${run.revision}: ${p}`);
}

/** @brief 增强会话（与它的 TaskBoard 实例会话）里的 write、edit（§9.6：一律被拒绝）：成功的是问题。 */
function writeProblems(runs) {
  const files = runs.filter((r) => r.session).flatMap((r) => {
    const team = join(ctx.userData, 'teams', r.session.id ?? '-', 'sessions');
    const instances = existsSync(team) ? readdirSync(team).filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(team, name)) : [];
    return [r.session.file, ...instances];
  });
  const calls = files.flatMap((file) => toolCallsOf(readJsonl(file).slice(1), ['write', 'edit']));
  return { calls: calls.length,
    problems: calls.filter(succeeded).map((item) => `${item.call.name} ${item.args.path ?? ''} succeeded`) };
}

/** @brief 每个任务最后一次完成的运行之后，列出的每个会话的水位是片段的最后一个条目（第一条消息里的止行，§9.5、§9.8）。 */
function watermarkProblems(lastDone, json) {
  const problems = [];
  for (const run of Object.values(lastDone).filter(Boolean)) {
    const marks = json?.tasks?.[run.task]?.watermarks ?? {};
    if (!run.material?.sessions.length) problems.push(`${run.task}: the first message lists no session`);
    for (const session of run.material?.sessions ?? []) {
      const want = lineId(session.file, session.to);
      if (!want || marks[session.file] !== want) {
        problems.push(`${run.task}: watermark of ${session.file} is ${marks[session.file]}, want ${want} `
          + `(line ${session.to})`);
      }
    }
  }
  return problems;
}

/** @brief Notes 是这次运行最后一条回复（去掉首尾空白，超过 4000 字符截断并注明，§3.3、§9.8）；没有回复时没有 Notes。 */
function notesProblems(run) {
  if (!run.session) return [];
  const text = lastAssistantText(run.session.entries);
  const chars = [...text];
  const want = text === '' ? null : chars.length > 4000 ? `${chars.slice(0, 4000).join('')}\n(truncated)` : text;
  const got = run.rev?.notes ?? null;
  return got === want ? [] : [`${run.task} ${run.revision}: Notes ${JSON.stringify(oneLine(got ?? 'null', 120))}, `
    + `want the last reply ${JSON.stringify(oneLine(want ?? 'null', 120))}`];
}

/** @brief 增强请求发给设置里选的提供商、带 memory 工具；增强会话不在侧栏与 session.list 里（§9.6）。 */
async function routingProblems(since) {
  const requests = chatBodies(ctx.proxy, { since })
    .filter((r) => r.firstUser.startsWith('You are running Mori\'s daily'));
  const problems = requests.length ? [] : ['no enhancement request was captured'];
  for (const r of requests) {
    if (r.provider !== ctx.found.second.id) problems.push(`a request went to ${r.provider} (${r.model})`);
    if (!r.tools.includes('memory')) problems.push(`a request to ${r.provider} has no memory tool`);
  }
  const listed = (await bridge(ctx, { type: 'session.list' })).flatMap((group) => group.sessions ?? [group])
    .map((s) => s.sessionFile ?? s.file ?? '');
  const rows = await ctx.page.locator('.session-item').evaluateAll((els) => els.map((el) => el.dataset.file ?? ''));
  const root = pathKey(join(ctx.userData, 'memory'));
  for (const file of new Set([...listed, ...rows].filter((f) => pathKey(f).startsWith(root)))) {
    problems.push(`${file} is listed`);
  }
  return { problems: [...new Set(problems)], requests };
}

/** @brief 读 JSON 文件；不存在或读不出时为 null。 */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @brief enhance 的检查（MEM-22、MEM-34）：结束与修订、一次运行一条修订、Notes、依据、write/edit、水位、模型与隐藏。 */
async function enhanceChecks(runs, notes, since) {
  const json = readJsonFile(join(ctx.dirs.project, 'enhance.json'));
  const done = runs.filter((r) => r.phase === 'done');
  const lastDone = Object.fromEntries(TASKS.map((task) => [task, done.filter((r) => r.task === task).at(-1) ?? null]));
  const status = await ctx.page.getByTestId('enhance-status').textContent({ timeout: 2000 }).catch(() => null);
  const note = noteOf(notes, { status, runs: runs.map((r) => [r.attempt, r.task, r.day, r.phase, r.error,
    r.rev?.front?.counts, r.rev?.front?.run?.tokens, r.material?.sessions.length, oneLine(r.rev?.notes ?? '', 160)]) });
  const ids = ['MEM-22', 'MEM-34'];
  const ended = endProblems(runs, json);
  recordAll(ids, 'real enhance: every task\'s last run ended done or skipped (enhance.json last and running agree), '
    + 'and each done run has its revision: done, by Enhancement, "<KIND> enhancement · <Mon D>", this project only, '
    + 'run task, day, tokens, sessions and feedback as listed', ended.length === 0, detail(ended, note));
  const sections = done.flatMap((run) => sectionProblems(run, lastDone[run.task]));
  recordAll(ids, 'real enhance: one revision per run: every successful memory call of the run names that revision, '
    + 'each entry has one section (before = the file before the run, after = the file after it; entries added then '
    + 'deleted left out), counts follow the sections, and only this project\'s learned entries of the task\'s kind '
    + 'changed', sections.length === 0 && done.length > 0, detail(done.length ? sections : ['no done run'], note));
  const replies = done.flatMap(notesProblems);
  recordAll(ids, 'real enhance: each done run\'s revision (with or without changes) has the run\'s last reply as Notes',
    replies.length === 0 && done.length > 0, detail(done.length ? replies : ['no done run'], note));
  const evidence = done.flatMap(evidenceProblems);
  record('MEM-34 real enhance: every change\'s evidence is in the run\'s material (listed session files and their line '
    + 'ids, listed feedback), and newly stored evidence keeps the listed path verbatim', evidence.length === 0,
  detail(evidence, note));
  const writes = writeProblems(runs);
  record(`MEM-34 real enhance: the enhancement sessions have no successful write or edit (${writes.calls} calls)`,
    writes.problems.length === 0, detail(writes.problems, note));
  const marks = watermarkProblems(lastDone, json);
  record('MEM-34 real enhance: each done run moved its watermark of every listed session to the last entry of the '
    + 'slice', marks.length === 0 && done.length > 0, detail(done.length ? marks : ['no done run'], note));
  const routed = await routingProblems(since);
  record(`MEM-34 real enhance: enhancement requests (${routed.requests.length}) go to the provider chosen in `
    + `Enhancement settings (${ctx.found.second.id}) and carry the memory tool, and enhancement sessions are `
    + 'neither in the sidebar nor in session.list', routed.problems.length === 0, detail(routed.problems, note));
  return note;
}

/** @brief 记忆页打开增强、设置里选第二个提供商（§9.1）：enhance.get 与 enhance.json 记下了；没打开时抛错（跑不了）。 */
async function turnOnCheck() {
  await turnOnEnhancement(ctx.page, ctx.found.second.id);
  const info = await bridge(ctx, { type: 'enhance.get', cwd: ctx.cwd });
  const json = readJsonFile(join(ctx.dirs.project, 'enhance.json'));
  const problems = [];
  if (!info.enabled || info.pick !== ctx.found.second.id || info.time !== '04:00' || info.team !== false
    || info.error) {
    problems.push(`enhance.get ${brief({ enabled: info.enabled, pick: info.pick, time: info.time, team: info.team,
      error: info.error })}`);
  }
  if (info.since !== dayNow(info.time)) problems.push(`since ${info.since}, want ${dayNow(info.time)}`);
  if (json?.enabled !== true || json?.pick !== ctx.found.second.id) problems.push(`enhance.json ${brief(json, 300)}`);
  await shot('enhance-on');
  record(`MEM-34 real enhance: turning Enhancement on in the Memory page and choosing ${ctx.found.second.id} in `
    + 'Enhancement settings is saved (enabled, pick, time 04:00, team off, since today)', problems.length === 0,
  brief(problems));
  if (!info.enabled || !info.pick) throw new Error(`enhancement is not on with a model: ${brief(info, 300)}`);
}

/** @brief MEM-22：运行之后新建的会话用新版：第一条请求的四个分节等于盘上的条目（§5.2、§9.8）。 */
async function newSessionCheck(note) {
  const fresh = await freshSession(PROMPTS.AFTER);
  const got = fresh.request ? sectionsOf(fresh.request.system) : null;
  const problems = !got ? ['no request of the new session reached the provider']
    : Object.keys(fresh.expected).filter((key) => got[key] !== fresh.expected[key])
      .map((key) => `<${key}> ${JSON.stringify(got[key])}, want ${JSON.stringify(fresh.expected[key])}`);
  const banner = await ctx.page.locator(`${paneSel(fresh.who.tab)} [data-testid="memory-notice"]`)
    .textContent({ timeout: 2000 }).catch(() => null);
  recordAll(['MEM-22', 'MEM-34'], 'real enhance: a new session after the runs gets the new version: its first '
    + 'request\'s <taste>, <strategy>, <review> and <facts> sections equal the entries on disk', problems.length === 0,
  detail(problems, `${note}; notice: ${banner ?? 'none'}`));
}

/** @brief 等回滚 id 的那条修订写出来（最多 30 秒）。 */
async function waitRollback(id, before) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const made = revisionFiles(ctx.dirs.project).filter((r) => !before.has(r.id))
      .map((r) => ({ ...r, rev: readRevision(r.file) })).find((r) => r.rev?.front?.rollbackOf === id);
    if (made) return made;
    await sleep(500);
  }
  return null;
}

/** @brief MEM-22：在 Revisions 里回滚最后一次有改动的运行，那次改过的条目都恢复原样，写一条 Rolled back 修订（§6.6）。 */
async function rollbackCheck(runs, note) {
  const ids = ['MEM-22', 'MEM-34'];
  const name = 'real enhance: Roll back this revision on a run that changed entries restores every entry it changed '
    + '(files equal the before blocks, added entries removed with their index lines) and writes a "Rolled back:" '
    + 'revision (by Rollback, rollbackOf, counts reversed)';
  const target = [...runs].reverse().find((r) => r.phase === 'done' && r.rev && !r.rev.error && changedCount(r) > 0);
  if (!target) {
    recordAll(ids, name, false, `precondition: no enhancement run changed an entry — ${note}`);
    return;
  }
  const before = new Set(revisionFiles(ctx.dirs.project).map((r) => r.id));
  const { title, counts } = target.rev.front;
  const problems = [];
  await rollbackInUi(ctx.page, target.revision, title).catch((error) => problems.push(`UI: ${oneLine(error, 300)}`));
  await shot('rollback');
  const made = await waitRollback(target.revision, before);
  if (!made) problems.push('no rollback revision was written');
  else {
    problems.push(...headProblems(made.rev.front ?? {}, { id: made.id, by: 'Rollback', status: 'done',
      title: `Rolled back: ${title}`, layers: ['project'], rollbackOf: target.revision,
      counts: { added: counts.deleted, changed: counts.changed, deleted: counts.added, moved: counts.moved } }));
  }
  for (const c of target.rev.changes) {
    const now = readText(join(ctx.dirs.project, 'entries', `${c.slug}.md`));
    const listed = readIndex(ctx.dirs.project, target.task).some((item) => item.slug === c.slug);
    if (c.before === '' ? now !== null || listed : now !== c.before || !listed) {
      problems.push(`${c.slug} is not back to its before block`);
    }
  }
  recordAll(ids, name, problems.length === 0, detail(problems, `${target.task} ${target.revision} `
    + `${JSON.stringify(counts)} — ${note}`));
}

// ---------- 驱动与执行 ----------

/** @brief dialog：前提没满足时换新项目重跑；之后核对最后一次。 */
async function dialogDrive(drive) {
  const { take, notes } = await withRetries(drive, () => dialogOnce());
  ctx.dates.add(localDate());
  if (take.who) await dialogChecks(take, notes);
}

/** @brief page：请求没发出时重跑新会话（记忆页的条目只写一次）；之后核对。 */
async function pageDrive(drive) {
  await ensureProject();
  const { take, notes } = await withRetries(drive, () => pageOnce());
  if (take.expected) pageChecks(take, notes);
}

/** @brief enhance：打开增强、选模型；运行失败或都没有改动时再给材料、重跑 Run now；之后核对、新会话、回滚。 */
async function enhanceDrive(drive) {
  await ensureProject();
  await turnOnCheck();
  const runs = [];
  const since = Date.now();
  const { notes } = await withRetries(drive, (attempt) => enhanceOnce(attempt, runs));
  ctx.dates.add(localDate());
  const note = await enhanceChecks(runs, notes, since);
  await newSessionCheck(note);
  await rollbackCheck(runs, note);
}

/** 驱动：名字、编号、做法 */
const DRIVES = [
  { name: 'dialog', ids: ['MEM-10', 'MEM-34'], run: dialogDrive },
  { name: 'page', ids: ['MEM-05', 'MEM-34'], run: pageDrive },
  { name: 'enhance', ids: ['MEM-22', 'MEM-34'], run: enhanceDrive },
];

/** @brief 跑选中的驱动：一个驱动抛错时给它的编号各记一条失败，接着跑下一个。 */
async function runDrives() {
  for (const drive of DRIVES.filter((d) => !only || only.includes(d.name))) {
    try {
      await drive.run(drive);
    } catch (error) {
      recordAll(drive.ids, `real ${drive.name}: the drive and its checks ran to the end`, false, oneLine(error, 600));
      await shot(`${drive.name}-error`);
    }
  }
}

/** @brief 跑之前的检查：--only 的名字、--exe、--source 的数据目录；不合格时返回一句说明。 */
function startProblem() {
  const unknown = (only ?? []).filter((name) => !DRIVE_NAMES.includes(name));
  if (unknown.length) return `Unknown --only ${unknown.join(', ')}; expected ${DRIVE_NAMES.join(', ')}.`;
  if (exePath && !existsSync(exePath)) return `--exe ${exePath} does not exist.`;
  const setup = checkSource(source);
  if (setup.error) return setup.error;
  ctx.found = setup.found;
  return null;
}

/** @brief 整个套件：检查参数（不合格时不启动、不写结果），准备数据目录与代理，启动 Mori，跑驱动，写结果。 */
async function main() {
  const problem = startProblem();
  if (problem) {
    console.error(`[mem-real] not run: ${problem}`);
    console.error('[mem-real] usage: node tests/ui/mem-real.mjs --source <Mori data dir> [--exe <Mori.exe>] '
      + `[--only ${DRIVE_NAMES.join(',')}]`);
    console.error(`[mem-real] no result file was written (test-results/${resultFile} is left as it was)`);
    return 1;
  }
  mkdirSync(shots, { recursive: true });
  record(`MEM-34 real setup: two real providers ${refOf(ctx.found.first)} and ${refOf(ctx.found.second)} with saved `
    + 'keys and confirmed zones', true, `${ctx.found.first.name} (${ctx.found.first.zone}), ${ctx.found.second.name} `
    + `(${ctx.found.second.zone})`);
  const data = prepareRealData(source, ctx.found, [], PROXY);
  ctx.userData = data.userData;
  try {
    ctx.proxy = await startForwardProxy(PROXY, data.routes);
    await startTbApp(ctx);
    await ctx.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
    await runDrives();
  } catch (error) {
    record('MEM-34 real: flow', false, oneLine(error, 600));
    await shot('flow-error');
  } finally {
    record('MEM-34 real: the page has no errors and the proxy forwarded every request', ctx.pageErrors.length === 0
      && (ctx.proxy?.errors.length ?? 0) === 0, brief({ page: ctx.pageErrors.slice(0, 3),
      proxy: ctx.proxy?.errors.slice(0, 3) }));
    await closeTbApp(ctx);
    stopForwardProxy(ctx.proxy);
    rmSync(join(ctx.userData, 'credentials.json'), { force: true });
    console.log(`[mem-real] data in ${ctx.userData} (credentials.json removed); projects in ${ctx.roots.join(', ')}`);
  }
  await sleep(200);
  return write(resultFile) ? 0 : 1;
}

process.exitCode = await main();
