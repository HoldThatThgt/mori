// 合成测试端点（synthetic）自检的文件系统第 3 步部分（docs/specs/file-system.md §19.1“合成端点”、§19.4）：脚本里不再有
// read_only（task_create 的 limits 是对象或 {lastJson:} 模板）；SEGMENT_SENTENCES 与 FORCED_MARKS 的文字在
// app/src/kernel/boardText.ts 里逐字出现，ENHANCE_MARK 在 memoryText.ts 里；scripts.mjs 新加的 {lastJson:} 模板与
// whenDelivery / unlessDelivery 修饰；场景 fs-limits（scenarios/fs-team.mjs）的立项、task 实例、结案、对话、临时提问与
// 订阅；场景 fs-enhance（增强会话按第一条消息认出，同一项目里你自己的会话按 fs66-user 行做事）与增强脚本的
// fsEnhanceSteps；TaskBoard 的脚本只换了 limits（§19.4）与 fs-team 的 fs-task-limits 行；scenarios/fs-worktree.mjs
// 的写法（端点认得出、Mori 的命令分析按文件开头说的归类，提交与合并在 Git Bash 里对真实 git 跑一次）。
// 由 selfcheck.mjs 调用（teamChecks），帮助函数从那里传进来；名字以 "fs-limits"、"fs-enhance"、"fs-tb"、"fs-worktree"
// 开头。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SCENARIOS, SEGMENT_SENTENCES, SHARED_SENTENCE } from './scripts.mjs';
import { gitBash } from './selfcheck-git.mjs';
import { ENHANCE_MARK, ENHANCE_SCENARIO, ENHANCE_TEXT, ENHANCE_USER_KEY, FORCED_MARKS, LIMITS_SCENARIO, LIMITS_TEXT,
  askStep, enhanceCalls, fsEnhanceSteps, limitsMessage, limitsTask, limitsTaskTitle } from './scenarios/fs-team.mjs';
import { WT_GIT_USER, WT_TEXT, wtStep } from './scenarios/fs-worktree.mjs';
import { loadKernelModule } from '../unit/load.mjs';

const appRoot = resolve(import.meta.dirname, '..', '..');

// ---------- 结构：read_only 不在了、文字与 boardText.ts 一致 ----------

/** @brief 一个场景条目里全部回复步骤的项（展平 deliveries）。 */
const itemsOf = (entry) => Object.values(entry.deliveries).flat().flatMap((step) => step.items ?? []);

/** @brief 全部场景里的 task_create、task_edit 调用：[场景名, 工具名, 参数]。 */
function taskCalls() {
  return Object.entries(SCENARIOS).flatMap(([name, entries]) => entries.flatMap((entry) => itemsOf(entry)
    .filter((item) => ['task_create', 'task_edit'].includes(item.call?.name))
    .map((item) => [name, item.call.name, item.call.args])));
}

/** @brief limits 参数合格：对象，或整个就是 {lastJson:<key>} 的模板。 */
const limitsShape = (value) => (typeof value === 'string' ? /^\{lastJson:[\w-]+\}$/.test(value)
  : value !== null && typeof value === 'object' && !Array.isArray(value));

/**
 * @brief 没有场景再写 read_only；task_create 的 limits 是对象或模板；SEGMENT_SENTENCES、FORCED_MARKS 在 boardText.ts
 *        里（普通模式 subagent 段的第一句在 subagent.ts，subagent 规格 §6.1）。
 */
function checkStructure(kit) {
  const calls = taskCalls();
  const wrong = calls.filter(([, , args]) => 'read_only' in args || ('limits' in args && !limitsShape(args.limits)));
  kit.record('fs-limits structure: no scenario calls task_create or task_edit with read_only; every limits argument '
    + 'is an object or a {lastJson:} template (§19.4)', calls.length > 100 && wrong.length === 0,
  `${calls.length} calls, wrong: ${JSON.stringify(wrong.slice(0, 3))}`);
  const kernel = (name) => readFileSync(join(appRoot, 'src', 'kernel', name), 'utf8');
  // subagent 段的第一句在 subagent.ts 里分两段字面量写（'…' + '…'），比较前接起来
  const source = `${kernel('boardText.ts')}\n${kernel('subagent.ts').replace(/['"]\s*\n\s*\+\s*['"]/g, '')}`;
  const texts = [...Object.values(SEGMENT_SENTENCES), ...Object.values(FORCED_MARKS).flat()];
  const missing = texts.filter((text) => !source.includes(text));
  const memoryText = readFileSync(join(appRoot, 'src', 'kernel', 'memoryText.ts'), 'utf8');
  const first = memoryText.includes(`\`${ENHANCE_MARK} \${`);
  kit.record('fs-limits structure: every SEGMENT_SENTENCES sentence (the first sentences did not change) and every '
    + 'FORCED_MARKS text is in src/kernel/boardText.ts (the subagent segment in subagent.ts) word for word; '
    + 'ENHANCE_MARK starts the enhancement\'s first '
    + 'line in src/kernel/memoryText.ts', missing.length === 0 && first, `${missing.join(' | ')} | mark: ${first}`);
}

// ---------- 帮助：按顺序跑一个会话 ----------

/**
 * @brief 一个会话接连的请求：回复里的第一个调用当作已执行（结果为 result(工具名)），接着请求，直到回复没有调用、调用了
 *        stopAt（task 实例的 task_handoff 带 terminate，Mori 在它之后结束运行）或满 max 次。
 * @param kit selfcheck.mjs 的帮助函数
 * @param endpoint 端点
 * @param session { head（前面的消息）, tail（每次请求最后的消息，例如工作卡）, stopAt, max, result }
 * @return 每次回复：{ name, args } 或 { text }
 */
async function drive(kit, endpoint, session) {
  const { head, tail = [], stopAt = null, max = 12, result = () => 'ok' } = session;
  const steps = [];
  const turns = [];
  for (let i = 0; i < max; i += 1) {
    const out = await kit.chat(endpoint.port, { messages: [...head, ...turns, ...tail] });
    if (out.calls.length === 0) {
      steps.push({ text: out.text });
      return steps;
    }
    const args = kit.argsOf(out) ?? {};
    steps.push({ name: out.calls[0].name, args });
    if (out.calls[0].name === stopAt) return steps;
    turns.push(...kit.toolTurn(`drive_${i}`, out.calls[0].name, args, result(out.calls[0].name)));
  }
  return steps;
}

/** @brief drive 结果的简写：调用写工具名，文字写 "say:<文字>"。 */
const brief = (steps) => steps.map((step) => (step.name ? step.name : `say:${step.text}`));
/** @brief 函数调用（tool_choice 指定的那一个）的工具定义（非严格，A 级交接单用）。 */
const tool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
/** @brief tool_choice 指定 name。 */
const forcedBody = (name) => ({ tools: [tool(name)], tool_choice: { type: 'function', function: { name } } });

/** @brief fs-limits 各种会话的 system（synthetic）。 */
function limitSessions(kit) {
  const { sys, sample } = kit;
  return {
    merged: sys('Body. no role mark', sample(SEGMENT_SENTENCES['merged-create'])),
    planner: sys('MORI-ROLE-planner', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.create),
    task: sys('You change files. MORI-ROLE-executor', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.task),
    close: sys('MORI-ROLE-planner', sample(SHARED_SENTENCE), sample(SEGMENT_SENTENCES.close)),
    chat: sys('MORI-ROLE-chat', sample(SHARED_SENTENCE), SEGMENT_SENTENCES['team-dialog']),
    ask: sys('MORI-ROLE-reviewer', sample(SEGMENT_SENTENCES.ask)),
    sub: sys('MORI-ROLE-watcher', sample(SEGMENT_SENTENCES.subscription)),
    off: sys('Body text without a role mark.', SEGMENT_SENTENCES['off-dialog']),
  };
}

// ---------- 场景 fs-limits ----------

/** fs-limits 立项检查用的消息：三个 task（只读、不带 limits、不是 JSON 的 limits）与立项自己的一步 */
const CREATE_ROWS = [...limitsTask(1, ['run: ls', 'say: Stop'], { write: false }),
  ...limitsTask(2, ['write file: src/a.md :: x']), ...limitsTask(3, ['run: ls'], 'not json'),
  ['lim-create', ['run: echo c > c.txt']]];

/** @brief 立项：登记、按 lim-t<n> 建 task（{submitted}、{lastJson:} 的 limits、没有 lim-l 时不写）、lim-create、回 handled。 */
async function checkLimitsCreate(kit, d) {
  const s = limitSessions(kit);
  const msg = kit.user(limitsMessage(CREATE_ROWS));
  const result = (name) => (name === 'request_submit' ? '[#1] Registered request 3: Limits check. Split it into '
    + 'tasks with task_create.' : 'ok');
  const steps = await drive(kit, d, { head: [s.merged, msg], result });
  const [submit, t1, t2, t3, own, last] = steps;
  kit.record('fs-limits create (merged): request_submit, then one task_create per lim-t<n> (request from '
    + '{submitted}, title limitsTaskTitle(n), assignee mori, description "lim-run: <value>", limits from lim-l<n>: '
    + 'an object, left out without the line, the text when it is not JSON), then lim-create, then handled',
  kit.same(brief(steps), ['request_submit', 'task_create', 'task_create', 'task_create', 'bash',
    `say:${LIMITS_TEXT.handled}`]) && submit.args.title === LIMITS_TEXT.title
    && kit.same(t1.args, { request: 3, title: limitsTaskTitle(1), assignee: 'mori',
      description: 'lim-run: run: ls ;; say: Stop', limits: { write: false } })
    && !('limits' in t2.args) && t2.args.description === 'lim-run: write file: src/a.md :: x'
    && t3.args.limits === 'not json' && own.args.command === 'echo c > c.txt' && last.text === LIMITS_TEXT.handled,
  JSON.stringify(steps.map((step) => step.args ?? step.text)));
  const split = await drive(kit, d, { head: [s.planner, kit.user(`[Mori] New user message: ${limitsMessage(
    limitsTask(1, ['run: ls'], { mcp: false }))}\nMake exactly one decision for it.`)], result, max: 3 });
  const wake = await drive(kit, d, { head: [s.merged, msg, kit.said(LIMITS_TEXT.handled),
    kit.user('[Mori] T1 was handed off: done.')] });
  kit.record('fs-limits create (split planner): assignee executor, limits { mcp: false }; a next delivery without '
    + 'the lines only answers handled', split[1]?.args?.assignee === 'executor'
    && kit.same(split[1]?.args?.limits, { mcp: false }) && kit.same(brief(wake), [`say:${LIMITS_TEXT.handled}`]),
  JSON.stringify([split, wake]));
}

/** @brief fs-limits task 实例的工作卡（User's words 里另有一行 lim-t1，task 只认 What to do 的 lim-run）。 */
const taskCard = (kit, run) => kit.card('You are executor on T1 (request 3).', `Request 3: ${LIMITS_TEXT.title}`,
  "User's words:", `- [10:00] "lim-t1: run: echo user-words\n${LIMITS_SCENARIO}"`,
  'Task T1: Limited task 1 · Limits: no file changes or commands', `What to do: lim-run: ${run}`);

/** @brief task 实例：lim-run 的各段（从工作卡的 What to do）、交接；强制填写的投递只交接（A 级）。 */
async function checkLimitsTask(kit, d) {
  const s = limitSessions(kit);
  const start = kit.user('[Mori] You are executor on T1 (request 3). Start work.');
  const card = taskCard(kit, 'run: ls ;; write file: a.txt :: x');
  const steps = await drive(kit, d, { head: [s.task, start], tail: [card], stopAt: 'task_handoff' });
  kit.record('fs-limits task: the lim-run steps come from the work card\'s What to do (not the lim-t1 line in the '
    + 'User\'s words), then task_handoff done with LIMITS_TEXT.conclusion',
  kit.same(brief(steps), ['bash', 'write', 'task_handoff'])
    && steps[0].args.command === 'ls' && kit.same(steps[1].args, { path: 'a.txt', content: 'x\n' })
    && kit.same(steps[2].args, { task: 'T1', conclusion: LIMITS_TEXT.conclusion, outcome: 'done' }),
  JSON.stringify(steps));
  const stopped = await drive(kit, d, { head: [s.task, start], tail: [taskCard(kit, 'say: Stop here.')] });
  const forced = [s.task, start, kit.said('Stop here.'),
    kit.user('[Mori] Your turn ended without task_handoff. Hand off T1 now.\nCall task_handoff now; no other tool '
      + 'works in this turn.')];
  const filled = await kit.chatLogged(d, { messages: [...forced, card], ...forcedBody('task_handoff') });
  kit.record('fs-limits task: a say: step ends the run before the handoff; the forced fill delivery '
    + '(FORCED_MARKS.task) only hands off, in the requested shape (k=2)', kit.same(brief(stopped), ['say:Stop here.'])
    && filled.log.k === 2 && filled.out.calls.length === 1 && filled.out.calls[0].name === 'task_handoff'
    && kit.argsOf(filled.out)?.outcome === 'done', `${JSON.stringify(stopped)} | ${filled.out.calls[0]?.args}`);
}

/** @brief fs-limits 结案的工作卡：User's words 是 rows 几行加 LIMITS_SCENARIO。 */
const closeCard = (kit, rows) => kit.card('You are planner, closing request 3.', `Request 3: ${LIMITS_TEXT.title}`,
  "User's words:", `- [10:00] "${[...rows, LIMITS_SCENARIO].join('\n')}"`, 'With you:', '- T1 Limited task 1: done');

/** @brief 结案：第一次投递 lim-close、交接、带 lim-sub 的关闭、回复；第二次普通投递交接 T2（不再做 lim-close）。 */
async function checkLimitsClose(kit, d) {
  const s = limitSessions(kit);
  const card = closeCard(kit, ['lim-close: run: echo c > c.txt', 'lim-sub: say: Subscribed.']);
  const first = kit.user('[Mori] T1 was handed to you: done.');
  const steps = await drive(kit, d, { head: [s.close, first], tail: [card] });
  kit.record('fs-limits close: at its first delivery lim-close, then task_handoff close_done for the delivered task, '
    + 'request_close with "lim-sub: <value>" in the conclusion, then LIMITS_TEXT.closed',
  kit.same(brief(steps), ['bash', 'task_handoff', 'request_close', `say:${LIMITS_TEXT.closed}`])
    && kit.same(steps[1].args, { task: 'T1', conclusion: LIMITS_TEXT.checked, outcome: 'close_done' })
    && kit.same(steps[2].args, { request: 3, outcome: 'done',
      conclusion: `${LIMITS_TEXT.requestDone}\nlim-sub: say: Subscribed.` }), JSON.stringify(steps));
  const second = await drive(kit, d, { head: [s.close, first, kit.said(LIMITS_TEXT.closed),
    kit.user('[Mori] T2 was handed to you: done.')], tail: [card] });
  const plain = closeCard(kit, ['lim-close: run: echo c > c.txt']);
  const fillText = "[Mori] T2 was handed to you and you didn't decide. Hand it off now.\nCall task_handoff now.";
  const closeText = '[Mori] All tasks of request 3 have ended and it is still open. Close it now with '
    + 'request_close.\nCall request_close now.';
  const head = [s.close, first, kit.said(LIMITS_TEXT.closed)];
  const fill = await kit.chatLogged(d, { messages: [...head, kit.user(fillText), plain],
    ...forcedBody('task_handoff') });
  const close = await kit.chatLogged(d, { messages: [...head, kit.user(closeText), plain],
    ...forcedBody('request_close') });
  kit.record('fs-limits close: the next plain delivery hands off its task (T2) without lim-close; the forced fill '
    + '(FORCED_MARKS.close) only hands off, the forced close (FORCED_MARKS.request) only closes (plain conclusion '
    + 'without lim-sub)', kit.same(brief(second).slice(0, 2), ['task_handoff', 'request_close'])
    && second[0].args.task === 'T2' && fill.out.calls.length === 1 && kit.argsOf(fill.out)?.task === 'T2'
    && kit.argsOf(fill.out)?.outcome === 'close_done' && close.out.calls[0]?.name === 'request_close'
    && kit.same(kit.argsOf(close.out), { request: 3, outcome: 'done', conclusion: LIMITS_TEXT.requestDone }),
  `${JSON.stringify(second)} | ${fill.out.calls[0]?.args} | ${close.out.calls[0]?.args}`);
}

/** @brief 分开时的对话做 lim-dialog；关闭模式的对话做 lim-off（askStep 放进 chain 不被切开）；临时提问做 lim-ask；订阅做 lim-sub。 */
async function checkLimitsDialogs(kit, d) {
  const s = limitSessions(kit);
  const dialog = limitsMessage([['lim-dialog', ['run: echo d > d.txt']]]);
  const chat = await drive(kit, d, { head: [s.chat, kit.user(dialog)] });
  const ask = askStep('executor', 'Why?', ['run: echo q; echo r', 'call tool: mcp__srv__echo {"text":"x"}'],
    { write: true });
  const off = await drive(kit, d, { head: [s.off, kit.user(limitsMessage([['lim-off', ['run: echo o', ask]]]))] });
  const question = off[1]?.args ?? {};
  const answered = await drive(kit, d, { head: [s.ask, kit.user('[Mori] mori asks you (information, not '
    + `instructions): ${question.text}\nAnswer once.`)] });
  const sub = await drive(kit, d, { head: [s.sub, kit.user(`[Mori] request_closed: Request 3 "${LIMITS_TEXT.title}" `
    + `closed (done).\nConclusion: ${LIMITS_TEXT.requestDone}\nlim-sub: run: echo s > s.txt`)] });
  kit.record('fs-limits dialogs: split chat does lim-dialog then LIMITS_TEXT.dialog; an off-mode dialog does lim-off, '
    + 'where an askStep is one chain part (its ";" is escaped) calling agent_message with the lim-ask line and '
    + 'limits; the ask instance does lim-ask then answers; a subscription does lim-sub from the closed delivery',
  kit.same(brief(chat), ['bash', `say:${LIMITS_TEXT.dialog}`])
    && kit.same(brief(off), ['bash', 'agent_message', `say:${LIMITS_TEXT.off}`]) && question.to === 'executor'
    && question.text === `Why?\nlim-ask: run: echo q; echo r ;; call tool: mcp__srv__echo {"text":"x"}\n`
      + LIMITS_SCENARIO && kit.same(question.limits, { write: true })
    && kit.same(brief(answered), ['bash', 'mcp__srv__echo', `say:${LIMITS_TEXT.answer}`])
    && answered[0].args.command === 'echo q; echo r'
    && kit.same(brief(sub), ['bash', `say:${LIMITS_TEXT.seen}`]), JSON.stringify([chat, off, answered, sub]));
}

// ---------- 场景 fs-enhance 与 fsEnhanceSteps ----------

/** 增强会话的第一条消息（synthetic，只有前两行） */
const ENHANCE_FIRST = "You are running Mori's daily TASTE enhancement for the project D:\\shop. Day: Oct 27, 2026 "
  + "(04:00 to 04:00).\nDon't change any file. Commands and MCP tools run without approval.";
/** enhanceCalls 的工具名（七个，按顺序） */
const ENHANCE_NAMES = enhanceCalls().map(([name]) => name);

/** @brief fs-enhance 的合并会话、task 实例、结案与关闭模式的对话按文件开头的顺序调用。 */
async function checkEnhanceScenario(kit, d) {
  const { sys, sample, user, card } = kit;
  const merged = await drive(kit, d, { head: [sys('Body', ENHANCE_SCENARIO,
    sample(SEGMENT_SENTENCES['merged-create'])), user(ENHANCE_FIRST)],
  result: (name) => (name === 'request_submit' ? 'Registered request 1: Enhancement check.' : 'ok') });
  const task = await drive(kit, d, { head: [sys('MORI-ROLE-executor', ENHANCE_SCENARIO, sample(SHARED_SENTENCE),
    SEGMENT_SENTENCES.task), user('[Mori] You are executor on T1 (request 1). Start work.')],
  tail: [card('You are executor on T1 (request 1).', 'Task T1: Try the tools')], stopAt: 'task_handoff' });
  const close = await drive(kit, d, { head: [sys('MORI-ROLE-planner', ENHANCE_SCENARIO, sample(SHARED_SENTENCE),
    sample(SEGMENT_SENTENCES.close)), user('[Mori] T1 was handed to you: done.')],
  tail: [card('You are planner, closing request 1.', 'With you:', '- T1 Try the tools: done')] });
  const off = await drive(kit, d, { head: [sys('Body', ENHANCE_SCENARIO), user(ENHANCE_FIRST)] });
  kit.record('fs-enhance: the merged session tries bash, registers and creates a task without limits; the task makes '
    + 'the seven enhanceCalls then hands off; close tries bash, then closes; an off-mode dialog makes the seven '
    + 'calls then says ENHANCE_TEXT.done', kit.same(brief(merged), ['bash', 'request_submit', 'task_create',
    `say:${ENHANCE_TEXT.registered}`]) && merged[0].args.command === `echo changed > ${ENHANCE_TEXT.merged}`
    && merged[2].args.request === 1 && !('limits' in merged[2].args)
    && kit.same(brief(task), [...ENHANCE_NAMES, 'task_handoff'])
    && kit.same(brief(close), ['bash', 'task_handoff', 'request_close', `say:${ENHANCE_TEXT.closed}`])
    && kit.same(brief(off), [...ENHANCE_NAMES, `say:${ENHANCE_TEXT.done}`]),
  JSON.stringify([brief(merged), brief(task), brief(close), brief(off)]));
}

/** @brief 立项收到的你的消息（boardText.ts userMessageText 的写法，synthetic）。 */
const newUserMessage = (text) => `[Mori] New user message: ${text}\nMake exactly one decision for it.`;

/** @brief fs-enhance 各会话的 system（synthetic）：合并会话、分开时的立项与对话、关闭模式的对话。 */
function enhanceSessions(kit) {
  const { sys, sample } = kit;
  return {
    merged: sys('Body', ENHANCE_SCENARIO, sample(SEGMENT_SENTENCES['merged-create'])),
    planner: sys('MORI-ROLE-planner', ENHANCE_SCENARIO, sample(SHARED_SENTENCE), SEGMENT_SENTENCES.create),
    chat: sys('MORI-ROLE-chat', ENHANCE_SCENARIO, sample(SHARED_SENTENCE), SEGMENT_SENTENCES['team-dialog']),
    off: sys('Body', ENHANCE_SCENARIO),
  };
}

/**
 * @brief 同一项目里你自己的会话不做增强的步骤：不含 ENHANCE_MARK 的投递做 fs66-user 行再回 own，没有这一行时回
 *        report；分开时立项收到含 ENHANCE_MARK 的 "New user message" 才登记，收到你的消息只回 report。
 */
async function checkEnhanceOwn(kit, d) {
  const { user, said } = kit;
  const s = enhanceSessions(kit);
  const result = (name) => (name === 'request_submit' ? 'Registered request 2: Enhancement check.' : 'ok');
  const own = (head, text) => drive(kit, d, { head: [head, user(text)], result });
  const started = Date.now();
  const busy = await own(s.merged, newUserMessage(`${ENHANCE_USER_KEY}: [wait 400] say: Still working.`));
  const waited = Date.now() - started;
  const runs = await own(s.merged, `${ENHANCE_USER_KEY}: run: echo u ;; write file: own.txt :: x`);
  const wake = await drive(kit, d, { head: [s.merged, user(ENHANCE_FIRST), said(ENHANCE_TEXT.registered),
    user('[Mori] T1 was handed off: done.')] });
  const off = [await own(s.off, `${ENHANCE_USER_KEY}: say: Ready.`), await own(s.off, 'Hello')];
  const chat = [await own(s.chat, ENHANCE_FIRST), await own(s.chat, `${ENHANCE_USER_KEY}: say: Chat ready.`)];
  const plan = [await own(s.planner, newUserMessage(`${ENHANCE_USER_KEY}: say: Planner.`)),
    await own(s.planner, newUserMessage(ENHANCE_FIRST))];
  const report = `say:${ENHANCE_TEXT.report}`;
  kit.record('fs-enhance own session: without ENHANCE_MARK the merged session, the split chat and the off-mode '
    + 'dialog do the fs66-user line (a [wait] holds it) and then own, or only report without the line (also the '
    + 'enhancement\'s next wakes); the split planner registers only for a New user message with ENHANCE_MARK',
  kit.same(brief(busy), ['say:Still working.']) && waited >= 400
    && kit.same(brief(runs), ['bash', 'write', `say:${ENHANCE_TEXT.own}`]) && kit.same(brief(wake), [report])
    && kit.same(off.map(brief), [['say:Ready.'], [report]])
    && kit.same(chat.map(brief), [[`say:${ENHANCE_TEXT.relayed}`], ['say:Chat ready.']])
    && kit.same(brief(plan[0]), [report]) && kit.same(brief(plan[1]), ['bash', 'request_submit', 'task_create',
      `say:${ENHANCE_TEXT.registered}`]) && plan[1][2].args.assignee === 'executor' && plan[1][2].args.request === 2,
  JSON.stringify({ busy, waited, runs, wake, off, chat, plan: plan.map(brief) }));
}

/** @brief fsEnhanceSteps 写进增强脚本文件：增强会话（没有 tb-scenario）依次做七个调用，再说 done。 */
async function checkEnhanceSteps(kit, e, scriptFile) {
  writeFileSync(scriptFile, JSON.stringify({ taste: fsEnhanceSteps() }));
  const steps = await drive(kit, e, { head: [kit.sys('You are Mori.'), kit.user(ENHANCE_FIRST)] });
  const want = enhanceCalls();
  kit.record('fs-enhance: fsEnhanceSteps() in the FAKE_ENHANCE_SCRIPT file makes the enhancement session call the '
    + 'seven enhanceCalls in order with their arguments, then say ENHANCE_TEXT.done',
  kit.same(brief(steps), [...ENHANCE_NAMES, `say:${ENHANCE_TEXT.done}`])
    && want.every(([, args], i) => kit.same(steps[i].args, args)), JSON.stringify(steps));
}

// ---------- 现有场景：TaskBoard 脚本只换 limits，fs-team 的 fs-task-limits 行 ----------

/** @brief 场景里某个会话条目（角色、种类、task）第 k 次投递的步骤简写：调用写工具名，文字写 say。 */
function scriptedNames(scenario, match, k = 1) {
  const entry = SCENARIOS[scenario]?.find((item) => Object.entries(match).every(([key, value]) => item[key] === value));
  return (entry?.deliveries[k] ?? []).flatMap((step) => step.items.map((item) => item.call?.name ?? 'say'));
}

/** @brief 场景里某个会话条目第 k 次投递的 task_edit 调用的参数（没有时为 null）。 */
function taskEditArgs(scenario, match, k) {
  const entry = SCENARIOS[scenario]?.find((item) => Object.entries(match).every(([key, value]) => item[key] === value));
  const items = (entry?.deliveries[k] ?? []).flatMap((step) => step.items);
  return items.find((item) => item.call?.name === 'task_edit')?.call.args ?? null;
}

/**
 * @brief §19.4：TaskBoard 的脚本只把 read_only 换成 limits，步骤不变（TB-04、TB-24 越界的调用由 tb-app 套件经 fs-team
 *        的行来做）；TB-24 的 task_edit 写 limits: {}（Mori 丢掉）；fs-team 的立项按 fs-task-limits 行给 task_create 的 limits。
 */
async function checkExistingScripts(kit, d) {
  const unchanged = kit.same(scriptedNames('tb-ask-off', { role: 'memory', kind: 'ask' }), ['read', 'say'])
    && kit.same(scriptedNames('tb-sched-readonly', { role: 'executor', kind: 'task', task: 'T2' }),
      ['read', 'read', 'task_handoff'])
    && kit.same(taskEditArgs('tb-sched-readonly', { role: 'planner', kind: 'create' }, 2)?.limits, {});
  const merged = kit.sys('Body. no role mark', kit.sample(SEGMENT_SENTENCES['merged-create']));
  const message = (rows) => kit.user([...rows, 'tb-scenario:fs-team'].join('\n'));
  const submitted = kit.toolTurn('s1', 'request_submit', {}, 'Registered request 1: File system check.');
  const limited = await kit.chat(d.port, { messages: [merged, message(['fs-call: run: ls',
    'fs-task-limits: {"write":false,"mcp":false}']), ...submitted] });
  const plain = await kit.chat(d.port, { messages: [merged, message(['fs-call: run: ls']), ...submitted] });
  kit.record('fs-tb: the TaskBoard scripts keep their steps (tb-ask-off memory ask, tb-sched-readonly T2) and '
    + 'tb-sched-readonly\'s task_edit writes limits: {}; fs-team\'s create takes task_create limits from the '
    + 'fs-task-limits line of this delivery and writes none without it', unchanged
    && kit.same(kit.argsOf(limited)?.limits, { write: false, mcp: false }) && !('limits' in (kit.argsOf(plain) ?? {}))
    && kit.argsOf(plain)?.description?.startsWith('fs-call: run: ls\n'),
  `${limited.calls[0]?.args} | ${plain.calls[0]?.args}`);
}

// ---------- scenarios/fs-worktree.mjs ----------

/** @brief wtStep 的文字、端点按 run: 与 write file: 认出、Mori 的命令分析（classifyCall）的归类。 */
async function checkWorktreeSteps(kit, a) {
  const main = join(tmpdir(), 'mori-wt-main');
  const commit = wtStep.commit('Edit notes');
  const merge = wtStep.merge(main, 'mori/fix-1a2b3c');
  const identity = `-c user.name='${WT_GIT_USER.name}' -c user.email=${WT_GIT_USER.email} -c commit.gpgsign=false`;
  const outs = [];
  for (const text of [commit, merge, wtStep.writeMain(main, 'notes.md', 'M'), wtStep.draft('d.md', 'D')]) {
    outs.push(await kit.chat(a.port, { messages: [kit.user(text)] }, kit.fsKey));
  }
  kit.record('fs-worktree: wtStep.commit, merge, writeMain and draft are keyword steps the endpoint turns into bash '
    + 'and write calls with exactly these commands and paths; busy holds a say: step',
  commit === `run: git add -A && git ${identity} commit -q -m 'Edit notes'`
    && merge === `run: git -C '${main}' ${identity} merge --no-edit 'mori/fix-1a2b3c'`
    && kit.argsOf(outs[0])?.command === commit.slice(5) && kit.argsOf(outs[1])?.command === merge.slice(5)
    && kit.same(kit.argsOf(outs[2]), { path: join(main, 'notes.md'), content: 'M\n' })
    && kit.same(kit.argsOf(outs[3]), { path: '.work/d.md', content: 'D\n' })
    && wtStep.busy(300) === `[wait 300] say: ${WT_TEXT.late}`, outs.map((out) => out.calls[0]?.args).join(' | '));
  return { commit, merge };
}

/**
 * @brief classifyCall（Mori 的路径闸分类，file-system-permissions.md §6.4）：worktree 会话里提交在工作路径里，合并与写
 *        主文件夹在外面，而相对的 ../x 落在 <R>/.mori/worktrees/ 下、整条路径有 .mori 一段，是 protected；普通项目里
 *        FS-66 的三条 bash 依次为 inside、outside、protected。
 */
async function checkClassification(kit, steps) {
  const { classifyCall } = await loadKernelModule('src/kernel/pathGate.ts');
  const dir = mkdtempSync(join(tmpdir(), 'mori-fsc-'));
  try {
    const main = join(dir, 'main');
    const cwd = join(main, '.mori', 'worktrees', 'fix-1a2b3c');
    const project = join(dir, 'project');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project);
    const scope = (name, input, at = cwd) => classifyCall(name, input, at).scope;
    const merge = wtStep.merge(main, 'mori/fix-1a2b3c').slice(5);
    const bash = enhanceCalls().filter(([name]) => name === 'bash').map(([, args]) => scope('bash', args, project));
    const got = [scope('bash', { command: steps.commit.slice(5) }), scope('bash', { command: merge }),
      scope('write', { path: join(main, 'notes.md'), content: 'x' }), scope('write', { path: '../x.md', content: 'x' }),
      ...bash];
    kit.record('fs-worktree: Mori\'s path gate classifies, in a worktree session, wtStep.commit as inside, '
      + 'wtStep.merge (git -C <main>) and wtStep.writeMain as outside, a relative ../x.md as protected (it is under '
      + '<R>/.mori); in a plain project fs-enhance\'s three bash calls as inside, outside and protected',
    kit.same(got, ['inside', 'outside', 'outside', 'protected', 'inside', 'outside', 'protected']),
    JSON.stringify(got));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @brief Git Bash 里的脚本：主文件夹一个提交，Mori 的位置上一个 worktree，在 worktree 里写文件、提交、合并回主文件夹。 */
function worktreeScript(main, cwd) {
  const setup = `-c user.name=Setup -c user.email=setup@example.invalid -c commit.gpgsign=false`;
  return ['set -e', `git init -q -b main '${main}'`, `cd '${main}'`, 'echo base > base.txt', 'git add base.txt',
    `git ${setup} commit -q -m base`, `git worktree add -q -b mori/fix-1a2b3c '${cwd}'`, `cd '${cwd}'`,
    'echo hello > wt.txt', wtStep.commit('Add wt').slice(5), wtStep.merge(main, 'mori/fix-1a2b3c').slice(5)]
    .join('\n');
}

/** @brief 提交与合并的命令在 Git Bash 里对真实 git 跑一次（全局配置为空文件，提交者只来自命令里的 -c）。 */
function checkWorktreeGit(kit, bash) {
  if (!bash) {
    kit.record('fs-worktree: commit and merge run in Git Bash', false, 'no Git Bash');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'mori-fsw-'));
  try {
    const main = join(dir, 'main');
    const cwd = join(main, '.mori', 'worktrees', 'fix-1a2b3c');
    const empty = join(dir, 'empty.gitconfig');
    writeFileSync(empty, '');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync(bash, ['-c', worktreeScript(main, cwd)], { cwd: dir, env, stdio: 'pipe' });
    const log = execFileSync('git', ['-C', main, 'log', '--format=%s|%an'], { encoding: 'utf8', env }).trim();
    const merged = existsSync(join(main, 'wt.txt')) && readFileSync(join(main, 'wt.txt'), 'utf8').trim() === 'hello';
    kit.record('fs-worktree: in Git Bash with an empty global config, wtStep.commit commits in the worktree as '
      + 'WT_GIT_USER and wtStep.merge brings the commit into the main folder (git log, the file)',
    log.split('\n')[0] === `Add wt|${WT_GIT_USER.name}` && merged, log);
  } catch (error) {
    kit.record('fs-worktree: commit and merge run in Git Bash', false, String(error.stderr ?? error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @brief 文件系统第 3 步的全部检查。
 * @param kit selfcheck.mjs 的帮助函数 { chat, chatLogged, record, user, sys, said, toolTurn, card, sample, argsOf,
 *            same, fsKey }
 * @param endpoints { a（关键词端点，FAKE_KEYS 含 fsKey.key）, d（脚本端点）, e（设了 FAKE_ENHANCE_SCRIPT 的端点）,
 *                  scriptFile（e 的增强脚本文件；这里改写它，所以在别的增强检查之后调用） }
 */
export async function teamChecks(kit, { a, d, e, scriptFile }) {
  checkStructure(kit);
  await checkLimitsCreate(kit, d);
  await checkLimitsTask(kit, d);
  await checkLimitsClose(kit, d);
  await checkLimitsDialogs(kit, d);
  await checkEnhanceScenario(kit, d);
  await checkEnhanceOwn(kit, d);
  await checkEnhanceSteps(kit, e, scriptFile);
  await checkExistingScripts(kit, d);
  const steps = await checkWorktreeSteps(kit, a);
  await checkClassification(kit, steps);
  checkWorktreeGit(kit, gitBash());
}
