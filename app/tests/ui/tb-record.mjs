// 从真实会话录制平行 Agent 与 TaskBoard 回放用的 fixture（tests/fixtures/tb/*.json，
// docs/specs/parallel-agents-taskboard.md §17.1 的回放层：关闭模式下的临时提问、/task 的回执与进展摘要、后台实例的批准卡）。
// 做法同 v1-models-record.mjs：页面里的录制器直接通过 window.mori（与界面相同的进程桥）发会话命令，命令的写法与界面
// 发出的相同（trust.check 后 session.create、/task <文字> 去掉前缀以 team: 'once' 发出、开关是 session.setTeam、
// 后台批准卡的回答是 approval.answer），记下命令、结果和后台进程转发的全部事件及其时间。模型是负责人的两个真实模型
// （默认 DeepSeek 与 GLM，都是 C 级），数据目录的做法见 tb-real-helpers.mjs（只复制加密的文件，不读 key；
// 分组 [DeepSeek, GLM] 为默认范围，synthetic test setup）。角色文件 executor、reviewer
// （reviewer 的 models 是第二个提供商），基座持有对话、立项与结案（合并会话）。
//   tb-ask（TB-04、TB-53）：关闭模式下让对话用 agent_message 问 reviewer 一个问题（开只读的临时提问实例，由 GLM 回答）；
//     之后点开关两次：off → always → off。
//   tb-team（TB-08、TB-37、TB-53）：切到 Full access（文件系统规格 §6.7 取代 Allow all），/task 让 executor 修好失败的
//     测试、reviewer 复核；登记之后点开关两次：
//     once → always → once（需求还开着，回不到 off）；等需求到终态、对话汇报完、模式回到 off；退出、重新启动，
//     打开同一个会话（{ restart: true } 之后的一段，回放用 ?part=after）。
//   tb-receipts（TB-08、TB-37）：Full access 下 /task 让 executor 跑一个 90 秒的命令；它运行时发一条超过 120 字符的补充、
//     再发一条撤销：三种回执都有，需求以 cancelled 结束。
//   tb-approval（TB-34）：“Ask each time”下 /task 让 executor 运行 node --version：后台实例的批准卡出现后先发一条问进展的消息，
//     等那一轮结束（卡不清掉）再允许；之后的卡一律允许。
//   stop-task（TB-89）：Full access 下 /task 让 executor 跑一个 30 秒的命令；它运行时发 session.stopTask（Stop this task），
//     再发一条消息让立项把它交回，等需求到终态。
//   sa-subagent（docs/specs/subagent.md SA-11、SA-14、SA-17）：普通模式、没有角色文件，主 Agent 用 subagent 开两个
//     （只读的读 README.md，通用的跑 node --version，后台批准卡允许）；重启后打开同一个会话。fixture 在 tests/fixtures/sa。
// 录完先核对场景要的东西真的发生了（check）；模型没照做时（例如没调 agent_message、需求没到终态）最多重录 2 次，
// 仍不符合时不写进 fixtures，写到 test-results/tb-record/<名字>.rejected.json。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs real）：
//   MORI_APP_DIR=.tb-runs/real node tests/ui/tb-record.mjs --source <数据目录> [--only tb-ask,tb-team] [--exe <Mori.exe>]
//        [--out <目录>]
// --out 只用来检查本脚本自己；tests/fixtures/tb 里只放对真实提供商录的。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, launch, oneLine, sleep, snapshotsDirFor } from './lib.mjs';
import {
  prepareRealData, PROMPTS, realProvidersOf, refOf, removeScratch, sumProject, TB_GROUP, writeRealRoles,
} from './tb-real-helpers.mjs';

const source = arg('source') ? resolve(arg('source')) : null;
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const outDir = arg('out') ? resolve(arg('out')) : join(appRoot, 'tests/fixtures/tb');
const rejectedDir = join(appRoot, 'test-results/tb-record');
/** 一个场景最多录几次（第一次加最多 2 次重录，§17.1） */
const TRIES = 3;
/** 驱动脚本的时限（§17.1：15 分钟只是驱动的时限） */
const DRIVE_MS = 15 * 60 * 1000;

// ---------- 页面里的录制器 ----------

/** @brief 页面里的录制器（同 v1-models-record.mjs）：记录命令、结果和事件；turn_end 后读一次 session.state。 */
function installRecorder(offset) {
  const rec = {
    t0: performance.now() - offset,
    steps: [],
    log(entry) { this.steps.push({ t: Math.round(performance.now() - this.t0), ...entry }); },
    async cmd(command) {
      this.log({ command });
      try {
        const result = await window.mori.request(command);
        this.log({ result: { type: command.type, value: result } });
        return result;
      } catch (error) {
        this.log({ result: { type: command.type, error: error.message } });
        throw error;
      }
    },
  };
  window.mori.onEvent((envelope) => {
    rec.log({ envelope });
    if (envelope.event.type === 'turn_end') {
      void rec.cmd({ type: 'session.state', sessionId: envelope.sessionId }).catch(() => {});
    }
  });
  window.__rec = rec;
}

/**
 * @brief 这个会话不在运行：它最后一个 agent_start / agent_settled 是 agent_settled，或两种都还没有。不按两种的个数比：
 *        收尾检查在同一次运行里再发一个 agent_start（finish-check.md §3 第 2 条），agent_settled 每次运行只有一个。
 * @param page 页面
 * @param sessionId 会话 id
 */
function sessionIdle(page, sessionId) {
  return page.evaluate((id) => {
    const step = window.__rec.steps.findLast((s) => s.envelope?.sessionId === id
      && ['agent_start', 'agent_settled'].includes(s.envelope.event.type));
    return !step || step.envelope.event.type === 'agent_settled';
  }, sessionId);
}

/** @brief 一个场景运行时的操作（node 这边驱动页面里的录制器；查询在页面里筛，不把全部步骤搬回来）。 */
function driver(state) {
  const page = () => state.page;
  const d = {
    cmd: (command) => page().evaluate((c) => window.__rec.cmd(c), command),
    /** 某个会话的某种事件（按顺序） */
    events: (sessionId, type) => page().evaluate(({ id, kind }) => window.__rec.steps
      .filter((s) => s.envelope?.sessionId === id && s.envelope.event.type === kind)
      .map((s) => ({ t: s.t, ...s.envelope.event })), { id: sessionId, kind: type }),
    count: (sessionId, type) => page().evaluate(({ id, kind }) => window.__rec.steps
      .filter((s) => s.envelope?.sessionId === id && s.envelope.event.type === kind).length,
    { id: sessionId, kind: type }),
    /** 这个会话不在运行（sessionIdle） */
    idle: (sessionId) => sessionIdle(page(), sessionId),
    /** 某个会话某种事件的最后一个；没有时为 null */
    last: (sessionId, type) => page().evaluate(({ id, kind }) => {
      const step = window.__rec.steps.findLast((s) => s.envelope?.sessionId === id && s.envelope.event.type === kind);
      return step ? { t: step.t, ...step.envelope.event } : null;
    }, { id: sessionId, kind: type }),
    /** 等 fn() 为真 */
    async until(fn, what, timeout = DRIVE_MS) {
      const deadline = Date.now() + timeout;
      while (!(await fn())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(500);
      }
    },
    /** 像界面一样新建会话：先 trust.check（临时项目没有要信任的内容） */
    async create(cwd) {
      await d.cmd({ type: 'trust.check', cwd });
      return d.cmd({ type: 'session.create', cwd });
    },
    /** 发一条消息（team 为真时以 team: 'once' 发出，即 /task <文字>），等这一次运行结束 */
    async say(session, text, team = false) {
      const before = await d.count(session.sessionId, 'agent_settled');
      await d.cmd({ type: 'session.prompt', sessionId: session.sessionId, text, ...(team ? { team: 'once' } : {}) });
      await d.until(async () => (await d.count(session.sessionId, 'agent_settled')) > before,
        `${session.sessionId} to settle`);
    },
    /** 开头像界面一样读会话列表、设置与模型配置 */
    async start() {
      await d.cmd({ type: 'session.list' });
      await d.cmd({ type: 'config.get' });
      return d.cmd({ type: 'models.get' });
    },
  };
  return d;
}

/**
 * @brief 等这个用户会话的需求都到终态、协作空闲（最后的 mori.team_state 的 busy 为假、mode 为 off）、对话不在运行；
 *        连续 3 秒保持这样。
 */
async function teamDone(d, sessionId, timeout = DRIVE_MS) {
  let since = null;
  await d.until(async () => {
    const board = await d.last(sessionId, 'mori.board');
    const state = await d.last(sessionId, 'mori.team_state');
    const idle = await d.idle(sessionId);
    const requests = board?.requests ?? [];
    const done = requests.length > 0 && requests.every((r) => r.status !== 'open') && state?.busy === false
      && state?.mode === 'off' && idle;
    since = done ? since ?? Date.now() : null;
    return done && Date.now() - since >= 3000;
  }, 'the request to end and the team to be idle', timeout);
}

/** @brief 后台批准卡（mori.team_approval_request）里还没结束、也没回答过的。 */
async function pendingApprovals(d, sessionId, answered) {
  const asked = await d.events(sessionId, 'mori.team_approval_request');
  const ended = new Set((await d.events(sessionId, 'mori.team_approval_end')).map((e) => e.requestId));
  return asked.filter((e) => !ended.has(e.requestId) && !answered.has(e.requestId));
}

/** @brief 像界面一样允许一张后台批准卡（approval.answer，requestId 是 <实例 id>:<编号>）。 */
async function allow(d, sessionId, requestId, answered) {
  answered.add(requestId);
  await d.cmd({ type: 'approval.answer', sessionId, requestId, decision: 'allow' });
}

// ---------- 录完后的核对（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
const eventsOf = (steps, sessionId, type) => steps.filter((s) => s.envelope?.sessionId === sessionId
  && s.envelope.event.type === type).map((s) => ({ t: s.t, ...s.envelope.event }));
/** @brief 重启前（before）或重启后（after）的步骤；没有重启时 before 是全部。 */
const partOf = (steps, part) => {
  const at = steps.findIndex((s) => s.restart);
  if (at < 0) return part === 'before' ? steps : [];
  return part === 'before' ? steps.slice(0, at) : steps.slice(at + 1);
};
/** @brief 最后一个 TaskBoard 视图。 */
const lastBoard = (steps, sessionId) => eventsOf(steps, sessionId, 'mori.board').at(-1) ?? null;

/** @brief 共同的要求：开头是会话列表；没有失败的命令；没有 No model available；有一个用户会话。 */
function common(steps) {
  const first = steps.find((s) => s.command)?.command;
  const unavailable = steps.filter((s) => s.envelope?.event.type === 'mori.model_unavailable');
  return [...need(first?.type === 'session.list', 'the recording does not start with session.list'),
    ...need(failures(steps).length === 0, `failed commands: ${failures(steps).join('; ')}`),
    ...need(unavailable.length === 0, 'a No model available card was recorded'),
    ...need(values(steps, 'session.create').length === 1, 'not exactly one session.create')];
}

/** @brief 需求都到了终态，汇报的投递（request_closed）来过，最后模式回到 off。 */
function closedProblems(steps, id) {
  const board = lastBoard(steps, id);
  const wakes = eventsOf(steps, id, 'mori.wake');
  const states = eventsOf(steps, id, 'mori.team_state');
  return [...need(board?.requests.length > 0 && board.requests.every((r) => r.status !== 'open'),
    `requests ${JSON.stringify(board?.requests.map((r) => r.status))}`),
  ...need(wakes.some((w) => w.kind === 'request_closed'), 'no request_closed delivery'),
  ...need(states.at(-1)?.mode === 'off', `last mode ${states.at(-1)?.mode}`)];
}

// ---------- 场景 ----------

/** @brief tb-ask：关闭模式下对话用 agent_message 问 reviewer（只读的临时提问实例）；之后点开关 off → always → off。 */
const askScenario = {
  name: 'tb-ask', covers: 'TB-04, TB-53',
  description: 'Off mode with role files executor and reviewer (reviewer uses the second provider): the dialog is told '
    + 'to ask reviewer one question with agent_message; reviewer answers in a read-only ask instance and the answer '
    + 'becomes the tool result. Then the team switch is clicked twice: off → always → off.',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    await d.say(s, PROMPTS.ASK);
    await d.cmd({ type: 'session.setTeam', sessionId: s.sessionId, mode: 'on' });
    await d.cmd({ type: 'session.setTeam', sessionId: s.sessionId, mode: 'off' });
  },
  check(steps) {
    const s = values(steps, 'session.create')[0];
    const id = s?.sessionId;
    const starts = eventsOf(steps, id, 'tool_execution_start').filter((e) => e.toolName === 'agent_message');
    const ends = eventsOf(steps, id, 'tool_execution_end').filter((e) => e.toolName === 'agent_message');
    const text = (ends[0]?.result?.content ?? []).map((part) => part.text ?? '').join('');
    const modes = values(steps, 'session.setTeam').map((v) => v.mode);
    return [...common(steps), ...need(s?.team?.mode === 'off', `new session mode ${s?.team?.mode}`),
      ...need(starts.length === 1 && starts[0].args?.to === 'reviewer',
        `agent_message calls ${JSON.stringify(starts.map((e) => e.args))}`),
      ...need(ends.length === 1 && !ends[0].isError && text.trim().length > 0,
        `agent_message result ${oneLine(text, 200)}`),
      ...need(eventsOf(steps, id, 'mori.receipt').length === 0, 'a receipt in off mode'),
      ...need(JSON.stringify(modes) === '["always","off"]', `switch results ${modes}`)];
  },
};

/**
 * @brief tb-team：Full access 下 /task 修好失败的测试；登记之后开关 once → always → once；等需求关闭、汇报完、回到 off；
 *        重启后打开同一个会话。
 */
const teamScenario = {
  name: 'tb-team', covers: 'TB-08, TB-37, TB-53',
  description: 'Full access, then "/task" asks to fix the failing npm test (executor) and verify it (reviewer) in a '
    + 'merged session (the base agent holds dialog, create and close). After the registered receipt the switch is '
    + 'clicked twice (once → always → once, the request is still open). The request runs to a terminal state, the '
    + 'dialog reports, the mode returns to off. Then Mori restarts and the same session is opened again.',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    await d.cmd({ type: 'approval.setMode', sessionId: s.sessionId, mode: 'full' });
    await d.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: PROMPTS.TEAM, team: 'once' });
    await d.until(async () => (await d.events(s.sessionId, 'mori.receipt')).some((r) => r.kind === 'registered'),
      'the registered receipt');
    await d.cmd({ type: 'session.setTeam', sessionId: s.sessionId, mode: 'on' });
    await d.cmd({ type: 'session.setTeam', sessionId: s.sessionId, mode: 'off' });
    await teamDone(d, s.sessionId);
    await ctx.restart('Quit and start again (no configuration change)');
    await d.start();
    await d.cmd({ type: 'session.open', sessionFile: s.sessionFile });
  },
  check(steps) {
    const before = partOf(steps, 'before');
    const after = partOf(steps, 'after');
    const id = values(before, 'session.create')[0]?.sessionId;
    const receipts = eventsOf(before, id, 'mori.receipt');
    const modes = values(before, 'session.setTeam').map((v) => v.mode);
    const notices = eventsOf(before, id, 'mori.team_mode').map((e) => e.mode);
    const opened = values(after, 'session.open')[0];
    const entries = (opened?.entries ?? []).filter((e) => e.type === 'custom');
    return [...common(before), ...need(failures(after).length === 0, `failed after: ${failures(after)}`),
      ...need(receipts.some((r) => r.kind === 'registered'), 'no registered receipt'),
      ...need(eventsOf(before, id, 'mori.progress').length > 0, 'no mori.progress'),
      ...need(JSON.stringify(modes) === '["always","once"]', `switch results ${modes}`),
      ...need(JSON.stringify(notices) === '["once","always","once","off"]', `mori.team_mode events ${notices}`),
      ...closedProblems(before, id), ...need(after.length > 0, 'no restart'),
      ...need(entries.some((e) => e.customType === 'mori.receipt')
        && entries.some((e) => e.customType === 'mori.progress'), 'reopened session has no receipt or progress'),
      ...need(opened?.board?.requests.length > 0, 'reopened session has no board')];
  },
};

/**
 * @brief tb-receipts：Full access 下 /task 让 executor 跑一个 90 秒的命令；它运行时再发一条超过 120 字符的补充、一条撤销：
 *        合并会话写下三种回执（registered、added、cancelled），运行中的实例被停止，需求以 cancelled 结束。
 */
const receiptsScenario = {
  name: 'tb-receipts', covers: 'TB-08, TB-37',
  description: 'Full access, then "/task" asks executor to run a 90-second command. While the task runs, a second '
    + 'message adds a constraint in the user’s words (longer than 120 characters) and a third message cancels the '
    + 'request. The merged session writes all three kinds of receipt (registered, added, cancelled); the running task '
    + 'instance is stopped and the request ends cancelled; the mode returns to off.',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    await d.cmd({ type: 'approval.setMode', sessionId: s.sessionId, mode: 'full' });
    await d.say(s, PROMPTS.SLOW, true);
    await d.until(async () => (await d.last(s.sessionId, 'mori.board'))?.requests[0]?.tasks
      .some((t) => t.phase === 'running'), 'the task to run');
    await d.say(s, PROMPTS.SUPPLEMENT);
    await d.say(s, PROMPTS.CANCEL);
    await teamDone(d, s.sessionId);
  },
  check(steps) {
    const id = values(steps, 'session.create')[0]?.sessionId;
    const kinds = eventsOf(steps, id, 'mori.receipt').map((r) => r.kind);
    const added = eventsOf(steps, id, 'mori.receipt').find((r) => r.kind === 'added');
    const board = lastBoard(steps, id);
    const states = eventsOf(steps, id, 'mori.team_state');
    return [...common(steps),
      ...need(JSON.stringify(kinds) === '["registered","added","cancelled"]', `receipts ${kinds}`),
      ...need([...(added?.quote ?? '')].length > 120, `added quote ${added?.quote?.length}`),
      ...need(board?.requests[0]?.status === 'cancelled', `request ${board?.requests[0]?.status}`),
      ...need(board?.requests[0]?.tasks.length > 0 && board.requests[0].tasks.every((t) => t.status === 'cancelled'),
        `tasks ${JSON.stringify(board?.requests[0]?.tasks.map((t) => t.status))}`),
      ...need(states.at(-1)?.mode === 'off', `last mode ${states.at(-1)?.mode}`)];
  },
};

/** @brief tb-approval：“Ask each time”下 task 实例运行命令出后台批准卡；卡挂着时问一次进展，那一轮结束后再允许。 */
const approvalScenario = {
  name: 'tb-approval', covers: 'TB-34',
  description: 'Ask each time: "/task" asks executor to run node --version. The task instance\'s bash shows a '
    + 'background approval card in the user session; while it is pending another message asks for progress and that '
    + 'turn ends (the card stays); then the card is allowed, and any later card is allowed too. The request runs to '
    + 'a terminal state and the dialog reports.',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    const answered = new Set();
    await d.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: PROMPTS.APPROVAL, team: 'once' });
    await d.until(async () => (await pendingApprovals(d, s.sessionId, answered)).length > 0,
      'a background approval card');
    await d.until(() => d.idle(s.sessionId), 'the dialog to be idle');
    await d.say(s, PROMPTS.PROGRESS);
    const first = (await pendingApprovals(d, s.sessionId, answered))[0];
    if (!first) throw new Error('the approval card ended before it was answered');
    await allow(d, s.sessionId, first.requestId, answered);
    await answerUntilDone(d, s.sessionId, answered);
  },
  check(steps) {
    const id = values(steps, 'session.create')[0]?.sessionId;
    const asked = eventsOf(steps, id, 'mori.team_approval_request');
    const answers = steps.filter((x) => x.command?.type === 'approval.answer');
    const firstAnswer = steps.findIndex((x) => x.command?.type === 'approval.answer');
    const firstAsk = steps.findIndex((x) => x.envelope?.sessionId === id
      && x.envelope.event.type === 'mori.team_approval_request');
    const settledBetween = steps.slice(firstAsk, firstAnswer).some((x) => x.envelope?.sessionId === id
      && x.envelope.event.type === 'agent_settled');
    return [...common(steps), ...need(asked.length > 0 && asked[0].task && asked[0].role === 'executor',
      `approval requests ${JSON.stringify(asked.map((a) => [a.role, a.task, a.toolName]))}`),
    ...need(answers.length === asked.length, `${answers.length} answers for ${asked.length} cards`),
    ...need(firstAsk >= 0 && firstAnswer > firstAsk && settledBetween,
      'no dialog turn ended while the first card was pending'),
    ...closedProblems(steps, id)];
  },
};

/** @brief 允许之后到来的每张卡，直到需求到终态、协作空闲。 */
async function answerUntilDone(d, sessionId, answered) {
  const watcher = (async () => {
    for (;;) {
      for (const item of await pendingApprovals(d, sessionId, answered)) {
        await allow(d, sessionId, item.requestId, answered);
      }
      if (answered.done) return;
      await sleep(500);
    }
  })();
  try {
    await teamDone(d, sessionId);
  } finally {
    answered.done = true;
    await watcher.catch(() => {});
  }
}

/**
 * @brief stop-task（TB-89，§13.13.7）：Full access 下 /task 让 executor 跑一个 30 秒的命令；它运行时像界面一样发
 *        session.stopTask（Background tasks 卡片上的 Stop this task），停下之后再发一条消息让立项把它交回，等需求到终态。
 */
const stopScenario = {
  name: 'stop-task', covers: 'TB-89',
  description: 'Full access, then "/task" asks executor to run a 30-second command. While the task runs, Stop this '
    + 'task (session.stopTask) stops only that task: it becomes stopped with its holder kept and its instance stops. '
    + 'A second message asks the planner to hand it back; the task continues in the same instance session and the '
    + 'request runs to a terminal state.',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    // 文件系统规格 §6.7：Allow all 换成 Full access（mode full）
    await d.cmd({ type: 'approval.setMode', sessionId: s.sessionId, mode: 'full' });
    await d.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: PROMPTS.STOP, team: 'once' });
    let task = null;
    await d.until(async () => {
      task = (await d.last(s.sessionId, 'mori.board'))?.requests.flatMap((r) => r.tasks)
        .find((t) => t.phase === 'running' && t.current?.toolName === 'bash') ?? null;
      return task !== null;
    }, 'a task to run a command');
    await d.cmd({ type: 'session.stopTask', sessionId: s.sessionId, task: task.id });
    await d.until(async () => (await d.last(s.sessionId, 'mori.board'))?.requests.flatMap((r) => r.tasks)
      .find((t) => t.id === task.id)?.status === 'stopped', `${task.id} to be stopped`);
    // 按 sessionIdle 判断：收尾检查让一次运行有两个 agent_start，个数比不出空闲
    await d.until(() => d.idle(s.sessionId), 'the dialog to be idle');
    await sleep(3000);
    await d.say(s, PROMPTS.HAND_BACK);
    await teamDone(d, s.sessionId);
  },
  check(steps) {
    const id = values(steps, 'session.create')[0]?.sessionId;
    const stopAt = steps.findIndex((x) => x.command?.type === 'session.stopTask');
    const task = steps[stopAt]?.command?.task;
    const result = steps.slice(stopAt).find((x) => x.result?.type === 'session.stopTask')?.result.value;
    const views = eventsOf(steps, id, 'mori.board').map((b) => b.requests.flatMap((r) => r.tasks)
      .find((t) => t.id === task)?.status);
    const stopped = views.indexOf('stopped');
    return [...common(steps),
      ...need(stopAt >= 0 && result?.error === null, `session.stopTask ${JSON.stringify(result)}`),
      ...need(stopped >= 0, `${task} never stopped`),
      ...need(stopped >= 0 && views.slice(stopped).includes('active'), `${task} was not handed back`),
      ...closedProblems(steps, id)];
  },
};

/** 普通模式的 subagent 工具的录制（docs/specs/subagent.md §14.1）：fixture 放在 tests/fixtures/sa */
const SA_FIXTURES = join(appRoot, 'tests/fixtures/sa');
/** sa-subagent 的驱动消息（英文：给模型的） */
const SA_PROMPT = 'Use the subagent tool to run two subagents at the same time: a read-only one (read_only: true) that '
  + 'reads README.md and reports its first line, and a general one (read_only: false) that runs the command '
  + '`node --version` in this project and reports the version it prints. Do not do either yourself. Then tell me both '
  + 'results in one sentence.';

/** 一张后台批准卡挂着多久再允许（像人看一眼再点；subagent 的进展最多每 250 毫秒发一次，这样录下“等你批准”的那一行） */
const CARD_READ_MS = 1500;

/** @brief 一边等 work() 做完，一边允许这期间到来的每张后台批准卡（每张挂满 CARD_READ_MS 再允许）。 */
async function answerWhile(d, sessionId, work) {
  const answered = new Set();
  const seen = new Map();
  const watcher = (async () => {
    while (!answered.done) {
      for (const item of await pendingApprovals(d, sessionId, answered)) {
        if (!seen.has(item.requestId)) seen.set(item.requestId, Date.now());
        if (Date.now() - seen.get(item.requestId) >= CARD_READ_MS) await allow(d, sessionId, item.requestId, answered);
      }
      await sleep(250);
    }
  })();
  try {
    await work();
  } finally {
    answered.done = true;
    await watcher.catch(() => {});
  }
}

/**
 * @brief sa-subagent（SA-11、SA-14、SA-17）：普通模式、没有角色文件，主 Agent 用 subagent 开两个（只读的读 README.md，
 *        通用的跑 node --version，出后台批准卡、允许）；之后重启，打开同一个会话（{ restart: true } 之后的一段）。
 */
const subagentScenario = {
  name: 'sa-subagent', covers: 'SA-11, SA-14, SA-17', dir: SA_FIXTURES, noRoles: true,
  description: 'Normal mode without role files: the main agent is told to run two subagents with the subagent tool — '
    + 'a read-only one that reads README.md and a general one that runs node --version (its command waits for the '
    + 'background approval card, which is allowed). Then Mori restarts and the same session is opened again.',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    await answerWhile(d, s.sessionId, () => d.say(s, SA_PROMPT));
    await ctx.restart('Quit and start again (no configuration change)');
    await d.start();
    await d.cmd({ type: 'session.open', sessionFile: s.sessionFile });
  },
  check(steps) {
    const before = partOf(steps, 'before');
    const after = partOf(steps, 'after');
    const id = values(before, 'session.create')[0]?.sessionId;
    const end = eventsOf(before, id, 'tool_execution_end').find((e) => e.toolName === 'subagent');
    const rows = end?.result?.details?.agents ?? [];
    const updates = eventsOf(before, id, 'tool_execution_update').filter((e) => e.toolName === 'subagent');
    const waiting = updates.some((e) => e.partialResult?.details?.agents?.some((row) => row.phase === 'approval'));
    const asked = eventsOf(before, id, 'mori.team_approval_request');
    const opened = values(after, 'session.open')[0];
    const reopened = (opened?.entries ?? []).some((e) => e.type === 'message' && e.message?.role === 'toolResult'
      && e.message.toolName === 'subagent' && Array.isArray(e.message.details?.agents));
    return [...common(before), ...need(failures(after).length === 0, `failed after: ${failures(after)}`),
      ...need(rows.length === 2 && rows.some((row) => row.readOnly) && rows.some((row) => !row.readOnly),
        `subagent rows ${JSON.stringify(rows.map((row) => [row.readOnly, row.phase]))}`),
      ...need(rows.every((row) => row.phase === 'done'), 'not every subagent is done'),
      ...need(updates.length > 1, `${updates.length} progress updates`),
      ...need(asked.some((a) => a.subagent !== null && a.task === null), 'no attributed approval card'),
      ...need(waiting, 'no progress update with a row waiting for approval'),
      ...need(after.length > 0 && reopened, 'the reopened session has no subagent result with details')];
  },
};

/** 录制的场景 */
const scenarios = [askScenario, teamScenario, receiptsScenario, approvalScenario, stopScenario,
  subagentScenario];

// ---------- 执行 ----------

/** @brief 启动 Mori，装好录制器（offset：重启后接着重启前最后一步的时间往后算）。 */
async function startMori(state, offset = 0) {
  state.app = await launch({ exePath, userData: state.userData });
  state.page = await state.app.firstWindow();
  await state.page.waitForFunction(() => Boolean(window.mori));
  await state.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
  await state.page.evaluate(installRecorder, offset);
}

/** @brief 重启：记下重启前的步骤，退出，再启动。 */
async function restartMori(state, note) {
  const steps = await state.page.evaluate(() => window.__rec.steps);
  const last = steps.at(-1)?.t ?? 0;
  state.kept.push(...steps, { t: last, note: `Restart: ${note}` }, { t: last, restart: true });
  await state.app.close();
  await startMori(state, last);
}

/**
 * @brief 录一次：新的数据目录与项目，录制，核对。
 * @return { steps, problems, ctx }
 */
async function recordOnce(scenario, found) {
  const cwd = sumProject(`mori-tb-record-${scenario.name}-`);
  if (!scenario.noRoles) writeRealRoles(cwd, found);
  const { userData } = prepareRealData(source, found);
  const state = { userData, app: null, page: null, kept: [] };
  const ctx = { ...found, cwd, state, notes: [`Setup (synthetic test setup, spec §17.1 / model spec §14.1): copied `
    + `the encrypted data files; group ${TB_GROUP} = [${found.first.id}, ${found.second.id}] is the default range; `
    + `${scenario.noRoles ? 'no role files (the base agent only)'
      : `role files executor and reviewer (models: [${found.second.id}]) in .mori/agents; the base agent holds `
      + 'dialog, create and close'}`] };
  ctx.restart = (note) => restartMori(state, note);
  try {
    await startMori(state);
    await state.page.evaluate(() => { window.__rec.steps = []; window.__rec.t0 = performance.now(); });
    await scenario.run(driver(state), ctx);
    await sleep(500);
    const steps = [...state.kept, ...(await state.page.evaluate(() => window.__rec.steps))];
    return { steps, problems: scenario.check(steps), ctx };
  } catch (error) {
    const steps = [...state.kept, ...(await state.page?.evaluate(() => window.__rec.steps).catch(() => []) ?? [])];
    return { steps, problems: [`flow: ${oneLine(error, 400)}`], ctx };
  } finally {
    await state.app?.close().catch(() => {});
    removeScratch([userData, snapshotsDirFor(userData), resolve(cwd, '..')]);
  }
}

/** @brief 录一个场景：不符合时重录，最多 TRIES 次；写出 fixture（仍不符合时写到 rejected）。 */
async function recordScenario(scenario, found) {
  const tries = [];
  for (let i = 1; i <= TRIES; i += 1) {
    const take = await recordOnce(scenario, found);
    tries.push(take.problems);
    if (take.problems.length === 0 || i === TRIES) {
      writeFixture(scenario, take, tries);
      return;
    }
    console.log(`RETRY ${scenario.name} (${i}/${TRIES - 1}): ${take.problems.join('; ')}`);
  }
}

/** @brief 写出 fixture；不符合时写到 test-results/tb-record/<名字>.rejected.json。 */
function writeFixture(scenario, take, tries) {
  const { steps, problems, ctx } = take;
  const notes = [...ctx.notes,
    ...tries.slice(0, -1).map((list, i) => `Take ${i + 1} was not used: ${list.join('; ')}`)];
  const fixture = { source: 'real', note: 'Recorded from a real session by tests/ui/tb-record.mjs; do not edit by '
    + 'hand.', name: scenario.name, description: scenario.description, covers: scenario.covers,
  endpoint: ctx.first.baseUrl, model: refOf(ctx.first), models: { first: refOf(ctx.first), second: refOf(ctx.second),
    group: TB_GROUP }, notes, recordedAt: new Date().toISOString(), steps };
  const dir = problems.length ? rejectedDir : arg('out') ? outDir : scenario.dir ?? outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${problems.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  const summary = `${steps.length} steps, ${steps.filter((s) => s.envelope).length} events, ${tries.length} take(s)`;
  if (problems.length) {
    console.log(`FAIL ${scenario.name}: ${problems.join('; ')} — ${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`RECORDED ${scenario.name}: ${summary}`);
  }
}

if (!source) throw new Error('Missing --source <Mori data dir with the two real providers>');
const found = realProvidersOf(source);
console.log(`[tb-record] first ${refOf(found.first)}, second ${refOf(found.second)}`);
for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordScenario(scenario, found);
}
