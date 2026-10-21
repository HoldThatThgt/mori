// 从真实会话录制 M2（批准）界面测试用的 fixture（tests/fixtures/m2/*.json）。做法与 m1-record.mjs 相同：
// 直接通过 window.mori（与界面相同的进程桥）发命令，记录命令、命令结果和后台进程转发的全部事件及其时间；
// 批准卡由页面里的录制器答复：等到 mori.approval_request，再用它的 requestId 发 approval.answer。
// 每个场景用一个新的临时项目（README.md + src/a.ts，见 lib.mjs prepareProject），互不影响。
// 录完先核对场景要的东西真的发生了（例如"本会话已允许"真的放行了第二条命令）；不符合时不写进 fixtures，
// 而是写到 test-results/m2-record/<名字>.rejected.json 供查看，并以退出码 1 结束，换个时间再录。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m2-record.mjs --source <走查数据目录> [--only name1,name2] [--exe <Mori.exe>]
// 走查数据目录是负责人在 Mori 里填过连接的目录（key 由 Mori 加密保存）；脚本只复制密文文件，不读取 key。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allowProjectsLive, allowRealProject, appRoot, arg, launch, oneLine, prepareProject, realProviders, scratchUserData,
} from './lib.mjs';

const source = arg('source');
const exePath = arg('exe');
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const outDir = join(appRoot, 'tests/fixtures/m2');
const rejectedDir = join(appRoot, 'test-results/m2-record');

// 与 src/shared/protocol.ts 的 READ_ONLY_TOOLS、REJECTED_* 相同。
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];
const REJECTED_REASON_PREFIX = 'Rejected by the user. Reason: ';
const REJECTED_BY_STOP = 'Rejected: the user stopped the run.';
const COMMAND_TOOLS = ['bash', 'powershell'];

/** @brief 页面里的录制器：记录命令、结果和事件（与 m1-record.mjs 相同），加上等待条件的工具。 */
function installRecorder() {
  const rec = {
    t0: performance.now(),
    steps: [],
    /** 已经取走（答复或交给场景处理）的批准请求数 */
    asked: 0,
    reset() { this.t0 = performance.now(); this.steps = []; this.asked = 0; },
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
    events() { return this.steps.filter((s) => s.envelope).map((s) => s.envelope); },
    count(type) { return this.events().filter((e) => e.event.type === type).length; },
    requests() { return this.events().filter((e) => e.event.type === 'mori.approval_request').map((e) => e.event); },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    /** 等 condition() 为真；condition 可以抛错提前结束 */
    async until(condition, what, timeout = 180000) {
      const deadline = Date.now() + timeout;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await this.sleep(50);
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

/** @brief 在页面里的录制器上加答复批准请求的工具。 */
function installApprovalHelpers() {
  Object.assign(window.__rec, {
    /** 等下一个批准请求并取走它 */
    async request() {
      const n = this.asked + 1;
      await this.until(() => this.requests().length >= n, `approval request #${n}`);
      this.asked = n;
      return this.requests()[n - 1];
    },
    answer(s, request, decision, reason) {
      return this.cmd({ type: 'approval.answer', sessionId: s.sessionId, requestId: request.requestId, decision,
        reason });
    },
    /** 等第 n 次 agent_settled；中途出现没人取走的批准请求时立即报错（否则要等到超时） */
    async settled(n) {
      await this.until(() => {
        const extra = this.requests()[this.asked];
        if (extra) throw new Error(`Unexpected approval request for ${extra.toolName}: ${JSON.stringify(extra.args)}`);
        return this.count('agent_settled') >= n;
      }, `agent_settled #${n}`);
    },
    /** 直到第 n 次 agent_settled，每个批准请求都按 decide(request, 序号) 答复：{ decision, reason } */
    async answerUntilSettled(s, n, decide) {
      const deadline = Date.now() + 240000;
      while (this.count('agent_settled') < n) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for agent_settled #${n}`);
        if (this.requests().length > this.asked) {
          const index = this.asked;
          const request = await this.request();
          const { decision, reason } = decide(request, index);
          await this.answer(s, request, decision, reason);
        } else await this.sleep(50);
      }
    },
  });
}

/** @brief 某种录下的事件。 */
const eventsOfType = (steps, type) => steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);
/** @brief 条件不成立时给出一条问题。 */
const need = (ok, problem) => (ok ? [] : [problem]);
/** @brief 第 index 个批准请求。 */
const requestAt = (steps, index) => eventsOfType(steps, 'mori.approval_request')[index];

/** @brief 第 index 个批准请求的结束事件。 */
function endOf(steps, index) {
  const request = requestAt(steps, index);
  return request ? eventsOfType(steps, 'mori.approval_end').find((e) => e.requestId === request.requestId) : undefined;
}

/** @brief 一次调用的结果原文（tool_execution_end）。 */
function resultText(steps, toolCallId) {
  const end = eventsOfType(steps, 'tool_execution_end').find((e) => e.toolCallId === toolCallId);
  return end ? { isError: end.isError, text: (end.result?.content ?? []).map((p) => p.text ?? '').join('') } : null;
}

/** @brief 每条带工具调用的助手回复里有几个调用。 */
function callsPerReply(steps) {
  return eventsOfType(steps, 'message_end').filter((e) => e.message.role === 'assistant')
    .map((e) => (Array.isArray(e.message.content) ? e.message.content : []).filter((p) => p.type === 'toolCall').length)
    .filter((n) => n > 0);
}

/** @brief 批准经过的简短说明：工具 选择/由谁，以及每次调用的处理方式。 */
function approvalSummary(steps) {
  const ends = eventsOfType(steps, 'mori.approval_end');
  const asked = eventsOfType(steps, 'mori.approval_request').map((r) => {
    const end = ends.find((e) => e.requestId === r.requestId);
    return `${r.toolName} ${end ? `${end.decision}/${end.by}` : 'pending'}`;
  });
  const gates = eventsOfType(steps, 'mori.tool_gate').map((g) => `${g.toolName}:${g.gate}`);
  return `approvals: ${asked.join('; ') || 'none'}; gates: ${gates.join(', ') || 'none'}`;
}

/** @brief 共同的要求：只读工具不出卡（读取不出卡）；第一个批准请求是 tools 里的工具。 */
function basics(steps, tools) {
  const readOnly = eventsOfType(steps, 'mori.approval_request').filter((r) => READ_ONLY_TOOLS.includes(r.toolName));
  const first = requestAt(steps, 0)?.toolName;
  return [...need(readOnly.length === 0, `read-only tool asked: ${readOnly.map((r) => r.toolName).join(', ')}`),
    ...need(tools.includes(first), `the first approval request is ${first ?? 'missing'}, expected ${tools.join('/')}`)];
}

/** @brief 有一次成功的 toolName 调用。 */
function succeeded(steps, toolName) {
  return need(eventsOfType(steps, 'tool_execution_end').some((e) => e.toolName === toolName && !e.isError),
    `no successful ${toolName}`);
}

/** @brief 第 index 个请求被拒绝：工具结果等于拒绝原文 reason，且模型之后又回复了一段文字。 */
function rejectedThenReplied(steps, index, reason) {
  const end = endOf(steps, index);
  const result = end && resultText(steps, end.toolCallId);
  const at = steps.findIndex((s) => s.envelope?.event.type === 'mori.approval_end'
    && s.envelope.event.requestId === end?.requestId);
  const replied = at >= 0 && eventsOfType(steps.slice(at), 'message_end').some((e) => e.message.role === 'assistant'
    && e.message.content.some((p) => p.type === 'text' && p.text.trim()));
  const rejected = end?.decision === 'reject' && end.reason === reason;
  return [...need(rejected, `approval #${index + 1} not rejected: ${reason}`),
    ...need(result?.isError && result.text === reason, `tool result is not the rejection: ${JSON.stringify(result)}`),
    ...need(replied, 'the model did not reply after the rejection')];
}

const create = async (rec, args) => rec.cmd({ type: 'session.create', cwd: args.cwd });
const say = (rec, s, text, behavior) => rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text, behavior });
const allow = () => ({ decision: 'allow' });

const prompts = {
  EDIT_TITLE: '用 edit 工具把 README.md 第一行的标题改成 `# Mori fixture project (edited)`，只改这一行。',
  EDIT_REASON: '标题保持原样，不要改',
  ESC_REASON: '先不要运行',
};

/**
 * @brief 录制的场景。body 在页面里运行（rec 是录制器，args 带 create / say / allow / cwd 和 prompts 里的文字）；
 *        check 在录完后核对，返回问题列表；note 返回追加到说明里的实际情况。
 */
const scenarios = [
  { name: 'edit-allow', description: '修改文件：批准卡显示每处替换，允许一次后执行并完成（带 diff）',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, args.EDIT_TITLE);
      await rec.answerUntilSettled(s, 1, args.allow);
    },
    check: (steps) => [...basics(steps, ['edit']), ...succeeded(steps, 'edit')] },
  { name: 'edit-reject', description: '同样的修改，拒绝并写理由；模型在拒绝之后回复',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, args.EDIT_TITLE);
      await rec.answerUntilSettled(s, 1, () => ({ decision: 'reject', reason: args.EDIT_REASON }));
    },
    check: (steps) => [...basics(steps, ['edit']),
      ...rejectedThenReplied(steps, 0, `${REJECTED_REASON_PREFIX}${prompts.EDIT_REASON}`)] },
  { name: 'command-session', description: '两条命令分两次调用：第一张卡选"本会话不再询问"，第二条命令不出卡；'
      + '清除"本会话已允许"后再运行命令又出卡',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '先运行命令 `echo one`，看到结果后再运行命令 `echo two`。两条命令分两次调用，不要合并成一条。');
      const first = await rec.request();
      await rec.answer(s, first, 'allowSession');
      await rec.settled(1);
      await rec.cmd({ type: 'approval.forget', sessionId: s.sessionId, toolName: first.toolName });
      await args.say(rec, s, '再运行命令 `echo three`，然后告诉我输出。');
      await rec.answerUntilSettled(s, 2, args.allow);
    },
    check: (steps) => {
      const first = requestAt(steps, 0)?.toolName;
      const forgetAt = steps.findIndex((s) => s.command?.type === 'approval.forget');
      const later = eventsOfType(steps.slice(forgetAt), 'mori.approval_request');
      return [...basics(steps, COMMAND_TOOLS),
        ...need(eventsOfType(steps, 'mori.tool_gate').some((g) => g.gate === 'session' && g.toolName === first),
          'the second command was not allowed by "本会话不再询问"'),
        ...need(forgetAt >= 0 && later[0]?.toolName === first, 'no approval request for the same tool after forget')];
    } },
  { name: 'all-mode', description: '切到全部允许后修改文件不出卡（标"全部允许"）；切回每次询问后命令又出卡',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await rec.cmd({ type: 'approval.setMode', sessionId: s.sessionId, mode: 'all' });
      await args.say(rec, s, '用 edit 工具在 README.md 末尾追加一行 `- It was edited in all-allowed mode.`，不要改别的。');
      await rec.settled(1);
      await rec.cmd({ type: 'approval.setMode', sessionId: s.sessionId, mode: 'ask' });
      await args.say(rec, s, '运行命令 `echo back`，然后告诉我输出。');
      await rec.answerUntilSettled(s, 2, args.allow);
    },
    check: (steps) => [...basics(steps, COMMAND_TOOLS), ...succeeded(steps, 'edit'),
      ...need(eventsOfType(steps, 'mori.tool_gate').some((g) => g.gate === 'all' && g.toolName === 'edit'),
        'the edit was not allowed by all-allowed mode')] },
  { name: 'pending-to-all', description: '批准卡挂着时切到全部允许：挂起的卡按允许处理（由"全部允许"决定）',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '运行命令 `echo all`，然后告诉我输出。');
      await rec.request();
      await rec.sleep(1000);
      await rec.cmd({ type: 'approval.setMode', sessionId: s.sessionId, mode: 'all' });
      await rec.settled(1);
    },
    check: (steps) => [...basics(steps, COMMAND_TOOLS),
      ...need(endOf(steps, 0)?.by === 'all' && endOf(steps, 0)?.decision === 'allow',
        'the pending request was not allowed by all-allowed mode')] },
  { name: 'stop-pending', description: '批准卡挂着时停止：先撤回排队、再停止；卡按拒绝处理（你按了停止）；结束后重新打开',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '运行命令 `sleep 5; echo late`，然后告诉我输出。');
      await rec.request();
      await rec.sleep(1000);
      await rec.cmd({ type: 'session.clearQueue', sessionId: s.sessionId });
      await rec.cmd({ type: 'session.abort', sessionId: s.sessionId });
      await rec.settled(1);
      await rec.cmd({ type: 'session.open', sessionFile: s.sessionFile });
    },
    check: (steps) => {
      const end = endOf(steps, 0);
      const opened = steps.find((s) => s.result?.type === 'session.open')?.result.value;
      const history = (opened?.entries ?? []).some((e) => e.message?.role === 'toolResult' && e.message.isError
        && (e.message.content ?? []).some((p) => p.text === REJECTED_BY_STOP));
      return [...basics(steps, COMMAND_TOOLS),
        ...need(end?.by === 'stop' && end.reason === REJECTED_BY_STOP, 'the pending request was not rejected by stop'),
        ...need(resultText(steps, end?.toolCallId)?.text === REJECTED_BY_STOP, 'tool result is not the stop text'),
        ...need(history, 'the reopened history has no stop rejection')];
    } },
  { name: 'card-esc', description: '焦点在批准卡上按 Esc：带理由拒绝这张卡，生成继续，模型收到拒绝后回复',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '运行命令 `echo skipped`，然后告诉我输出。');
      await rec.answerUntilSettled(s, 1, () => ({ decision: 'reject', reason: args.ESC_REASON }));
    },
    check: (steps) => [...basics(steps, COMMAND_TOOLS),
      ...rejectedThenReplied(steps, 0, `${REJECTED_REASON_PREFIX}${prompts.ESC_REASON}`),
      ...need(!steps.some((s) => s.command?.type === 'session.abort'), 'the run was stopped')] },
  { name: 'write-allow', description: '写入文件：批准卡显示将写入的内容；卡挂着时在输入框排队一条消息（Enter 不批准），'
      + '再允许一次',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '用 write 工具新建 notes.md，内容只有一行 `hello from mori`。');
      const first = await rec.request();
      await rec.sleep(800);
      await args.say(rec, s, '排队：不要调用任何工具，用一句话告诉我 notes.md 里写了什么。', 'followUp');
      await rec.until(() => rec.events().some((e) => e.event.type === 'queue_update' && e.event.followUp.length === 1),
        'queue_update with the follow-up');
      await rec.answer(s, first, 'allow');
      await rec.answerUntilSettled(s, 1, args.allow);
    },
    check: (steps) => [...basics(steps, ['write']), ...succeeded(steps, 'write'),
      ...need(eventsOfType(steps, 'message_end').filter((e) => e.message.role === 'user').length === 2,
        'the queued message was not delivered')] },
  { name: 'two-tools', description: '要求一条回复里调用两次 bash（echo first、echo second）：逐张出卡，各允许一次',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '请在同一条回复里同时调用两次 bash：第一次运行 `echo first`，第二次运行 `echo second`。'
        + '两个都完成后告诉我结果。');
      await rec.answerUntilSettled(s, 1, args.allow);
    },
    check: (steps) => [...basics(steps, COMMAND_TOOLS),
      ...need(eventsOfType(steps, 'mori.approval_request').length >= 2, 'fewer than two approval requests')],
    note: (steps) => {
      const calls = callsPerReply(steps);
      return calls.some((n) => n >= 2) ? `（实际：同一条回复里 ${Math.max(...calls)} 个调用，按顺序逐张出卡）`
        : `（实际：模型分成了 ${calls.length} 条回复，每条 ${calls.join('、')} 个调用）`;
    } },
];

/** @brief 在页面里执行一个场景的 body，返回录下的步骤。 */
function recordInPage(page, body, args) {
  return page.evaluate(async ({ source: text, values }) => {
    const rec = window.__rec;
    rec.reset();
    try {
      // eslint-disable-next-line no-new-func
      await new Function('rec', 'args', `return (${text})(rec, args);`)(rec, values);
    } catch (error) {
      const seen = rec.steps.map((s) => s.command?.type ?? s.result?.type ?? s.envelope?.event.type);
      const last = JSON.stringify(rec.steps.at(-1)).slice(0, 600);
      throw new Error(`${error.message}; steps: ${seen.join(' ')}; last: ${last}`);
    }
    await rec.sleep(300);
    return rec.steps;
  }, { source: wrap(body), values: args });
}

/** @brief 一个录制场景：新的临时项目，在页面里执行 body，等它结束，核对后写出 fixture。 */
async function runScenario(page, scenario, context) {
  const { project, root } = prepareProject('mori-m2-record-');
  let steps;
  try {
    // 测试准备（synthetic test setup，§14.1）：这个临时项目授权公网
    await allowProjectsLive(page, project);
    steps = await recordInPage(page, scenario.body, { ...context, cwd: project, ...prompts });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const note = scenario.note?.(steps) ?? '';
  const fixture = {
    source: 'real',
    note: 'Recorded from a real session by tests/ui/m2-record.mjs; do not edit by hand.',
    name: scenario.name,
    description: `${scenario.description}${note}`,
    endpoint: context.endpoint,
    model: context.model,
    recordedAt: new Date().toISOString(),
    steps,
  };
  const problems = scenario.check(steps);
  const events = steps.filter((s) => s.envelope).length;
  const tools = eventsOfType(steps, 'tool_execution_end').map((e) => `${e.toolName}${e.isError ? '(error)' : ''}`);
  const summary = `${steps.length} steps, ${events} events, tools: ${tools.join(', ')}; `
    + `${approvalSummary(steps)}${note}`;
  const dir = problems.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${problems.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  if (problems.length) {
    console.log(`FAIL ${scenario.name}: ${problems.join('; ')} — ${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`RECORDED ${scenario.name}: ${summary}`);
  }
}

/** @brief 把共用的 create / say / allow 注入场景函数（页面里没有模块作用域）。 */
function wrap(body) {
  return `async (rec, args) => {
    args.create = ${create.toString()};
    args.say = ${say.toString()};
    args.allow = ${allow.toString()};
    return (${body.toString()})(rec, args);
  }`;
}

/**
 * @brief 读取走查数据目录里首选提供商（DeepSeek）的非机密信息：v1 从 model-config.json 取（lib.mjs realProviders，
 *        规格 §14.4），不再找 pi/models.json 的 mori-endpoint。
 */
function connectionInfo(dir) {
  const [first] = realProviders(dir);
  return { endpoint: first.baseUrl, model: first.ref };
}

// 先读连接信息：数据目录不对时在复制密文之前就失败；复制之后的每一步都在 try 里，出错也会删掉临时目录。
const context = connectionInfo(source);
const userData = scratchUserData(source);
// 测试准备（synthetic test setup，§14.1）：默认范围设为 [DeepSeek, GLM] 的分组；项目建好后再授权公网
allowRealProject(userData, []);
let app = null;
try {
  app = await launch({ exePath, userData });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.mori));
  await page.evaluate(installRecorder);
  await page.evaluate(installApprovalHelpers);
  for (const scenario of scenarios) {
    if (only && !only.includes(scenario.name)) continue;
    try {
      await runScenario(page, scenario, context);
    } catch (error) {
      console.error(`FAIL recording ${scenario.name}: ${oneLine(error, 600)}`);
      process.exitCode = 1;
    }
  }
} finally {
  await app?.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
