// 从真实会话录制 M3（项目与会话）界面测试用的 fixture（tests/fixtures/m3/*.json）。做法与 m2-record.mjs 相同：
// 直接通过 window.mori（与界面相同的进程桥）发命令，记录命令、命令结果和后台进程转发的全部事件及其时间；
// 批准请求和扩展的询问由页面里的录制器答复。录完先核对场景要的东西真的发生了；不符合时不写进 fixtures，
// 而是写到 test-results/m3-record/<名字>.rejected.json 供查看，并以退出码 1 结束，换个时间再录。
// 与 M2 不同的几点：
// 1. 会话列表是全局的（<agentDir>/sessions），信任记录也是（<agentDir>/trust.json），所以每个场景用一个新的临时
//    数据目录、重新启动一次 Mori，开头的 session.list 才是空的，场景之间互不影响。
// 2. 回放桥（tests/ui/harness/replay.js）用录下的结果回答 session.list 与 trust.check，所以每个场景开头读一次
//    会话列表、在改动之后（改名、删除、归档）再读一次；每次 session.create / session.open 之前都像界面一样先发
//    trust.check，trust.check 说要问时才带上信任回答。例外：会话列表里带 live（还在后台进程里开着）的会话，
//    界面点开时不问信任，直接 session.open。
// 3. 每个 fixture 只录界面在一次运行里会发的命令。要测"重启之后"的场景（没打开的会话改名、记住的信任）先在同一个
//    数据目录里做准备（不录），再关掉 Mori 重新启动（restart 段），从启动时的 session.list 开始录。
//    要测"界面重新加载之后"的场景（接上还在生成的会话）同样先做准备，再像 Ctrl+R 一样只重新加载页面（reload 段，
//    不关 Mori，后台进程里的会话照常运行），从重新加载后的 session.list 开始录。
// 每个场景的项目文件夹名不同（m3-alpha、m3-beta……），内容是 README.md + src/a.ts（见 lib.mjs prepareProject）；
// 信任场景另带一个项目扩展 .pi/extensions/project-hello.ts，注册工具 project_hello（返回 hello from project）；
// 扩展询问场景带 .pi/extensions/project-ask.ts，注册工具 project_ask（依次确认、选择、输入，再发一条通知）。
// 删除场景不碰会话目录之外的东西：用 node 把会话文件移出会话目录，代替主进程的"删除会话文件"
// （回放时这一步也不经过后台进程）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m3-record.mjs --source <走查数据目录> [--only name1,name2] [--exe <Mori.exe>]
// 走查数据目录是负责人在 Mori 里填过连接的目录（key 由 Mori 加密保存）；脚本只复制密文文件，不读取 key。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { appRoot, arg, launch, oneLine, prepareProject, scratchUserData } from './lib.mjs';

const source = arg('source');
const exePath = arg('exe');
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const outDir = join(appRoot, 'tests/fixtures/m3');
const rejectedDir = join(appRoot, 'test-results/m3-record');

/** 项目扩展注册的工具名和它返回的文字 */
const HELLO_TOOL = 'project_hello';
const HELLO_TEXT = 'hello from project';
/** pi 的内置工具名（问模型能用哪些工具时，回答里至少要有一个） */
const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
/** 项目扩展的源文件：普通 JSON Schema 参数，不依赖 pi 的包 */
const EXTENSION = [
  'export default function (pi) {',
  '  pi.registerTool({',
  `    name: '${HELLO_TOOL}',`,
  "    label: 'Project hello',",
  "    description: 'Returns a greeting from the project extension (test tool).',",
  "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
  '    async execute() {',
  `      return { content: [{ type: 'text', text: '${HELLO_TEXT}' }], details: {} };`,
  '    },',
  '  });',
  '}',
  '',
].join('\n');

/**
 * 扩展询问场景的项目扩展：工具 project_ask 依次确认、选择、输入（ctx.ui），再发一条通知，把三个回答作为结果返回。
 * answers 是录制器的回答（按询问种类），result 是工具应返回的文字。
 */
const ASK = {
  tool: 'project_ask',
  confirm: { title: '继续吗？', message: '这个工具想问你几个问题' },
  select: { title: '选一个', options: ['甲', '乙'] },
  input: { title: '写点什么', placeholder: '随便写' },
  notify: 'project_ask 完成',
  answers: { confirm: true, select: '乙', input: '来自 Mori 的回答' },
};
ASK.result = JSON.stringify(ASK.answers);
/** 写进扩展源文件的字面值 */
const q = JSON.stringify;
/** 项目扩展 project-ask.ts 的源文件 */
const ASK_EXTENSION = [
  'export default function (pi) {',
  '  pi.registerTool({',
  `    name: '${ASK.tool}',`,
  "    label: 'Project ask',",
  "    description: 'Asks the user three questions via the extension UI (test tool).',",
  "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
  '    async execute(toolCallId, params, signal, onUpdate, ctx) {',
  `      const confirm = await ctx.ui.confirm(${q(ASK.confirm.title)}, ${q(ASK.confirm.message)});`,
  `      const select = await ctx.ui.select(${q(ASK.select.title)}, ${q(ASK.select.options)});`,
  `      const input = await ctx.ui.input(${q(ASK.input.title)}, ${q(ASK.input.placeholder)});`,
  `      ctx.ui.notify(${q(ASK.notify)}, 'info');`,
  '      const text = JSON.stringify({ confirm, select: select ?? null, input: input ?? null });',
  "      return { content: [{ type: 'text', text }], details: {} };",
  '    },',
  '  });',
  '}',
  '',
].join('\n');
/** 项目扩展：场景的 extension 为 true 时是 project-hello，为 'ask' 时是 project-ask */
const EXTENSION_FILES = { hello: ['project-hello.ts', EXTENSION], ask: ['project-ask.ts', ASK_EXTENSION] };

/** 场景里发的文字；前四条开头各不相同，侧栏的前 20 个字能区分 */
const prompts = {
  Q1: '请用一句话介绍你自己，并说明你能帮我做什么。不要调用任何工具。',
  Q2: '请用一句话说明 README 文件通常写些什么内容。不要调用任何工具。',
  Q3: '请用一句话解释什么是版本控制以及它为什么有用。不要调用任何工具。',
  Q4: '请用一句话说说写单元测试有哪些好处，越简短越好。不要调用任何工具。',
  NAME1: 'M3 录制改名',
  NAME2: 'M3 没打开时改名',
  /** 重启或重新加载之后的场景里，准备阶段新建的会话（session.create 的结果），由 runPhases 填上 */
  setup: [],
  LIST_TOOLS: '不要调用任何工具。请列出你现在可以调用的全部工具名，用逗号分隔。',
  CALL_HELLO: `请调用 ${HELLO_TOOL} 工具，然后告诉我它返回了什么。`,
  LONG: '不要调用任何工具。请写三段简短的文字，每段两三句话：第一段讲春天，第二段讲夏天，第三段讲秋天。',
  SHORT: '不要调用任何工具，用一句话回答：一年有几个季节？',
  /** 接上场景：要生成好几秒的长回复，重新加载页面之后它还在生成 */
  LONGER: '不要调用任何工具。请写五段文字，每段四到五句话：第一段讲春天，第二段讲夏天，第三段讲秋天，'
    + '第四段讲冬天，第五段讲四季轮回给人的启发。',
  CALL_ASK: `请调用 ${ASK.tool} 工具，然后告诉我它返回了什么。`,
  HELLO_TOOL,
  ASK_TOOL: ASK.tool,
  ASK_ANSWERS: ASK.answers,
};

/** @brief 页面里的录制器：记录命令、结果和事件（与 m2-record.mjs 相同），加上等待条件的工具。 */
function installRecorder() {
  const rec = {
    t0: performance.now(),
    steps: [],
    /** 已经取走（答复）的批准请求和扩展询问数 */
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

/**
 * @brief 在页面里的录制器上加"等几个会话各自结束、途中答复批准请求和扩展询问"的工具（多个会话可以同时在生成）。
 */
function installSettleHelpers() {
  Object.assign(window.__rec, {
    /** 没有工具要批准的场景：途中出现的批准请求一律拒绝（check 会因为调用了工具而拒绝这段录制） */
    rejectAll: () => ({ decision: 'reject' }),
    /** 某个会话收到的 agent_settled 数 */
    settledCount(sessionId) {
      return this.events().filter((e) => e.sessionId === sessionId && e.event.type === 'agent_settled').length;
    },
    /** 下一个还没答复的批准请求或扩展询问（按到达的顺序）；没有时为 null */
    nextAsk() {
      const asks = this.events().filter((e) => ['mori.approval_request', 'mori.ui_request'].includes(e.event.type));
      return asks[this.asked] ?? null;
    },
    /** 答复一个批准请求（decide 返回 { decision, reason }）或扩展询问（reply 返回 ui.answer 的 value） */
    answer(envelope, decide, reply) {
      const { sessionId, event } = envelope;
      if (event.type === 'mori.ui_request') {
        return this.cmd({ type: 'ui.answer', sessionId, requestId: event.requestId, value: reply(event) });
      }
      const { decision, reason } = decide(event);
      return this.cmd({ type: 'approval.answer', sessionId, requestId: event.requestId, decision, reason });
    },
    /**
     * 等 targets 里每个会话的 agent_settled 都到 n 次；途中的每个批准请求按 decide(请求) 答复：{ decision, reason }，
     * 每个扩展询问按 reply(询问) 答复（默认取消）。targets: [{ sessionId, n }]
     */
    async settle(targets, decide, reply = () => null, timeout = 240000) {
      const deadline = Date.now() + timeout;
      while (targets.some((target) => this.settledCount(target.sessionId) < target.n)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${targets.length} session(s) to settle`);
        const envelope = this.nextAsk();
        if (!envelope) {
          await this.sleep(50);
          continue;
        }
        this.asked += 1;
        await this.answer(envelope, decide, reply);
      }
    },
  });
}

// ---------- 页面里的共用操作（经 wrap 注入，页面里没有模块作用域） ----------

/** @brief 像界面一样新建会话：先 trust.check，要问时才带上信任回答（answer）；要问却没有回答时报错。 */
const create = async (rec, cwd, answer) => {
  const check = await rec.cmd({ type: 'trust.check', cwd });
  if (check.ask && !answer) throw new Error(`trust.check asks about ${cwd}, but the scenario has no answer`);
  return rec.cmd(check.ask ? { type: 'session.create', cwd, trust: answer } : { type: 'session.create', cwd });
};
/** @brief 像界面一样打开会话文件：先 trust.check（会话的工作目录），要问时才带上信任回答。 */
const reopen = async (rec, sessionFile, cwd, answer) => {
  const check = await rec.cmd({ type: 'trust.check', cwd });
  if (check.ask && !answer) throw new Error(`trust.check asks about ${cwd}, but the scenario has no answer`);
  return rec.cmd(check.ask ? { type: 'session.open', sessionFile, trust: answer }
    : { type: 'session.open', sessionFile });
};
const say = (rec, s, text) => rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text });
const list = (rec) => rec.cmd({ type: 'session.list' });

// ---------- 录完后的核对（在 node 里） ----------

/** @brief 条件不成立时给出一条问题。 */
const need = (ok, problem) => (ok ? [] : [problem]);
/** @brief 某种命令。 */
const commands = (steps, type) => steps.filter((s) => s.command?.type === type).map((s) => s.command);
/** @brief 某种命令的成功结果。 */
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
/** @brief 失败的命令。 */
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
/** @brief 某种事件；sessionId 不为空时只取这个会话的。 */
const eventsOf = (steps, type, sessionId) => steps.filter((s) => s.envelope?.event.type === type
  && (!sessionId || s.envelope.sessionId === sessionId)).map((s) => s.envelope.event);
/** @brief 某个会话第一次 agent_settled 的位置；没有时为 -1。 */
const settledAt = (steps, sessionId) => steps.findIndex((s) => s.envelope?.sessionId === sessionId
  && s.envelope.event.type === 'agent_settled');
/** @brief 消息的文字（content 可以是字符串或分段）。 */
const textOf = (message) => (typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map((part) => part.text ?? '').join(''));

/** @brief 某个会话里助手回复的全部正文。 */
function replyText(steps, sessionId) {
  return eventsOf(steps, 'message_end', sessionId).filter((e) => e.message.role === 'assistant')
    .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
    .filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
}

/** @brief 会话列表里带 live（还在后台进程里开着）的会话文件。 */
const liveFiles = (steps) => new Set(values(steps, 'session.list').flat().filter((item) => item.live)
  .map((item) => item.sessionFile));

/**
 * @brief 每次 session.create / session.open 之前的那条命令（不算录制器自己发的 session.state）是同一文件夹的
 *        trust.check；打开列表里带 live 的会话时反过来，界面不问信任，也不带信任回答。
 */
function trustBeforeOpen(steps) {
  const sent = steps.filter((s) => s.command && s.command.type !== 'session.state').map((s) => s.command);
  const live = liveFiles(steps);
  return sent.flatMap((command, index) => {
    if (command.type !== 'session.create' && command.type !== 'session.open') return [];
    const previous = sent[index - 1];
    if (command.type === 'session.open' && live.has(command.sessionFile)) {
      return need(previous?.type !== 'trust.check' && !command.trust, `session.open #${index} of a live session `
        + 'checks trust');
    }
    const sameFolder = command.type === 'session.open' || previous?.cwd === command.cwd;
    return need(previous?.type === 'trust.check' && sameFolder,
      `${command.type} #${index} is not preceded by trust.check`);
  });
}

/**
 * @brief 共同的要求：开头是会话列表（重启之后的场景 afterRestart 为真：列表不空，否则是空的）；没有失败的命令；
 *        新建、打开之前先 trust.check。
 */
function common(steps, afterRestart = false) {
  const first = steps.find((s) => s.command)?.command;
  const startList = values(steps, 'session.list')[0];
  const startOk = Array.isArray(startList) && (afterRestart ? startList.length > 0 : startList.length === 0);
  return [...need(first?.type === 'session.list' && startOk,
    `the recording does not start with ${afterRestart ? 'a non-empty' : 'an empty'} session.list`),
  ...need(failures(steps).length === 0, `failed commands: ${failures(steps).join('; ')}`),
  ...trustBeforeOpen(steps)];
}

/** @brief 没有调用任何工具，也没有批准请求。 */
function noTools(steps) {
  const tools = eventsOf(steps, 'tool_execution_start').map((e) => e.toolName);
  const asked = eventsOf(steps, 'mori.approval_request').map((e) => e.toolName);
  return need(tools.length === 0 && asked.length === 0, `the model called tools: ${[...tools, ...asked].join(', ')}`);
}

/** @brief 每个会话都结束了一轮，并有带文字的回复。 */
function allReplied(steps, sessions) {
  return sessions.flatMap((s) => need(settledAt(steps, s?.sessionId) >= 0 && replyText(steps, s?.sessionId),
    `no settled reply in ${s?.sessionId}`));
}

/** @brief 只为 project_hello 出过批准卡，它执行成功并返回 hello from project。 */
function helloCalled(steps) {
  const asked = eventsOf(steps, 'mori.approval_request').map((e) => e.toolName);
  const end = eventsOf(steps, 'tool_execution_end').find((e) => e.toolName === HELLO_TOOL && !e.isError);
  return [...need(asked.length >= 1 && asked.every((tool) => tool === HELLO_TOOL),
    `approval requests: ${asked.join(', ')}`),
  ...need(textOf(end?.result).includes(HELLO_TEXT), `project_hello result: ${JSON.stringify(end?.result)}`)];
}

/** @brief 一个询问与期望的内容（只比较期望里写了的字段）一致。 */
const askMatches = (event, expected) => Object.entries(expected)
  .every(([key, value]) => JSON.stringify(event?.[key]) === JSON.stringify(value));

/**
 * @brief 扩展询问场景：只为 project_ask 出过一张批准卡（允许）；依次是确认、选择、输入三个询问，每个都由 ui.answer
 *        按录制器的回答答复并以 mori.ui_end 结束；一条 info 通知；工具返回三个回答。
 */
function askCalled(steps) {
  const approvals = eventsOf(steps, 'mori.approval_end').map((e) => `${e.decision}`);
  const asked = eventsOf(steps, 'mori.approval_request').map((e) => e.toolName);
  const asks = eventsOf(steps, 'mori.ui_request');
  const ends = eventsOf(steps, 'mori.ui_end').map((e) => e.requestId);
  const answers = commands(steps, 'ui.answer');
  const expected = ['confirm', 'select', 'input'].map((method) => ({ method, ...ASK[method] }));
  const notes = eventsOf(steps, 'mori.notify');
  const end = eventsOf(steps, 'tool_execution_end').find((e) => e.toolName === ASK.tool && !e.isError);
  return [...need(asked.length === 1 && asked[0] === ASK.tool && approvals.join() === 'allow',
    `approval requests: ${asked.join(', ')}; ends: ${approvals.join(', ')}`),
  ...need(asks.length === 3 && asks.every((event, index) => askMatches(event, expected[index])),
    `ui requests: ${JSON.stringify(asks)}`),
  ...need(answers.length === 3 && asks.every((event, index) => answers[index]?.requestId === event.requestId
    && answers[index].value === ASK.answers[event.method] && ends.includes(event.requestId)),
  `ui answers: ${JSON.stringify(answers)}; ends: ${ends.join(', ')}`),
  ...need(notes.length === 1 && notes[0].message === ASK.notify && notes[0].level === 'info',
    `notify: ${JSON.stringify(notes)}`),
  ...need(textOf(end?.result) === ASK.result, `project_ask result: ${JSON.stringify(end?.result)}`)];
}

/**
 * @brief 接上场景：启动时（重新加载后）的列表里这个会话 live.running；没有 trust.check，session.open 不带信任回答，
 *        返回同一个会话、live.running 为真、对话里有你的消息；打开之后还有正文增量，并在打开之后结束、有回复。
 * @param s 准备阶段新建的会话（session.create 的结果）
 */
function reattachProblems(steps, s) {
  const listed = values(steps, 'session.list')[0]?.find((item) => item.sessionFile === s?.sessionFile);
  const opened = values(steps, 'session.open')[0];
  const openAt = steps.findIndex((step) => step.result?.type === 'session.open');
  const after = openAt >= 0 ? steps.slice(openAt + 1) : [];
  const deltas = eventsOf(after, 'message_update', s?.sessionId).filter((e) => e.update?.type === 'text_delta');
  const userKept = (opened?.entries ?? []).some((e) => e.type === 'message' && e.message.role === 'user'
    && textOf(e.message) === prompts.LONGER);
  const live = opened?.live ? { ...opened.live, streaming: Boolean(opened.live.streaming) } : null;
  return [...common(steps, true), ...noTools(steps),
    ...need(listed?.live?.running === true, `the start list: ${JSON.stringify(listed)}`),
    ...need(commands(steps, 'trust.check').length === 0, 'trust.check was sent for the live session'),
    ...need(opened?.sessionId === s?.sessionId && live?.running === true && userKept,
      `opened: ${JSON.stringify({ id: opened?.sessionId, live, userKept })}`),
    ...need(deltas.length > 0 && settledAt(steps, s?.sessionId) > openAt && Boolean(replyText(after, s?.sessionId)),
      `no reply text after the open (${deltas.length} text deltas)`)];
}

/** @brief 删除场景的 node 一步：把会话文件移出会话目录（代替主进程删除会话文件），移到数据目录里另一个文件夹。 */
function moveOutOfSessions(steps, state) {
  const file = values(steps, 'session.create')[0]?.sessionFile;
  const sessionsDir = join(state.userData, 'pi', 'sessions');
  const inside = file ? relative(sessionsDir, file) : '';
  if (!file || !inside || inside.startsWith('..') || isAbsolute(inside) || !existsSync(file)) {
    throw new Error(`Session file not found in ${sessionsDir}: ${file}`);
  }
  const target = join(state.userData, 'm3-record-trash', basename(file));
  mkdirSync(dirname(target), { recursive: true });
  renameSync(file, target);
  state.moved = { from: file, to: target };
}

/**
 * @brief 录制的场景。folders 是要准备的项目（参数名 → 文件夹名），extension 为真时带项目扩展（见 EXTENSION_FILES）；
 *        phases 依次执行：page 在页面里运行（rec 是录制器，args 带 create / reopen / say / list、文件夹和 prompts），
 *        node 在 node 里运行（拿到目前录下的步骤和 state），restart / reload 见 runPhases。
 *        check 在录完后核对，返回问题列表；note 返回追加到说明里的实际情况。
 */
const scenarios = [
  { name: 'two-projects', folders: { alpha: 'm3-alpha', beta: 'm3-beta' },
    description: '两个文件夹各建两个会话并各发一条消息（第二个会话照 Ctrl+N 的做法用第一个会话的工作目录）；'
      + '开头读到空的会话列表，最后读到四个会话、两个工作目录',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      for (const [folder, first, second] of [[args.alpha, args.Q1, args.Q2], [args.beta, args.Q3, args.Q4]]) {
        const s1 = await args.create(rec, folder);
        await args.say(rec, s1, first);
        await rec.settle([{ sessionId: s1.sessionId, n: 1 }], rec.rejectAll);
        const s2 = await args.create(rec, s1.cwd);
        await args.say(rec, s2, second);
        await rec.settle([{ sessionId: s2.sessionId, n: 1 }], rec.rejectAll);
      }
      await args.list(rec);
    } }],
    check: (steps) => {
      const made = values(steps, 'session.create');
      const final = values(steps, 'session.list').at(-1) ?? [];
      const listed = made.map((s) => final.find((item) => item.sessionFile === s.sessionFile));
      const texts = [prompts.Q1, prompts.Q2, prompts.Q3, prompts.Q4];
      return [...common(steps), ...noTools(steps), ...allReplied(steps, made),
        ...need(made.length === 4 && new Set(made.map((s) => s.cwd)).size === 2,
          `expected 4 sessions in 2 folders, got ${made.length}`),
        ...need(made.every((s) => s.projectTrust === 'none'), 'a session is not projectTrust none'),
        ...need(final.length === 4 && new Set(final.map((item) => item.cwd)).size === 2,
          `the final session.list has ${final.length} sessions`),
        ...need(listed.every((item, index) => item?.firstMessage === texts[index] && item.name === null),
          `session.list firstMessage/name do not match: ${JSON.stringify(listed.map((item) => item?.firstMessage))}`)];
    } },
  { name: 'rename', folders: { cwd: 'm3-rename' },
    description: '打开中的会话改名（带 sessionId 与会话文件，pi 发 session_info_changed）',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await args.say(rec, s, args.Q1);
      await rec.settle([{ sessionId: s.sessionId, n: 1 }], rec.rejectAll);
      await rec.cmd({ type: 'session.rename', sessionId: s.sessionId, sessionFile: s.sessionFile, name: args.NAME1 });
      await rec.until(() => rec.events().some((e) => e.sessionId === s.sessionId
        && e.event.type === 'session_info_changed' && e.event.name === args.NAME1), 'session_info_changed', 10000)
        .catch(() => {});
    } }],
    check: (steps) => {
      const s = values(steps, 'session.create')[0];
      const renames = values(steps, 'session.rename');
      return [...common(steps), ...noTools(steps), ...allReplied(steps, [s]),
        ...need(renames[0]?.name === prompts.NAME1, `rename result: ${JSON.stringify(renames)}`),
        ...need(eventsOf(steps, 'session_info_changed', s?.sessionId).some((e) => e.name === prompts.NAME1),
          'no session_info_changed with the name')];
    } },
  { name: 'rename-unopened', folders: { cwd: 'm3-rename-unopened' },
    description: '重启之后：启动时的会话列表里有上次的会话；没打开就按会话文件改名，重新读取列表；再点开它，'
      + '名字是新名字、对话还在（准备阶段在同一数据目录里新建会话并发一条消息，不录）',
    phases: [
      { page: async (rec, args) => {
        const s = await args.create(rec, args.cwd);
        await args.say(rec, s, args.Q3);
        await rec.settle([{ sessionId: s.sessionId, n: 1 }], rec.rejectAll);
      } },
      { restart: true },
      { page: async (rec, args) => {
        const [s] = args.setup;
        await args.list(rec);
        await rec.cmd({ type: 'session.rename', sessionFile: s.sessionFile, name: args.NAME2 });
        await args.list(rec);
        await args.reopen(rec, s.sessionFile, s.cwd);
      } },
    ],
    check: (steps, state) => {
      const s = values(state.setup, 'session.create')[0];
      const lists = values(steps, 'session.list');
      const nameIn = (found) => found?.find((item) => item.sessionFile === s?.sessionFile);
      const opened = values(steps, 'session.open')[0];
      const userKept = (opened?.entries ?? []).some((e) => e.type === 'message' && e.message.role === 'user'
        && textOf(e.message) === prompts.Q3);
      return [...common(steps, true), ...noTools(steps),
        ...need(nameIn(lists[0])?.firstMessage === prompts.Q3 && nameIn(lists[0])?.name === null,
          `the start list does not have the saved session: ${JSON.stringify(lists[0])}`),
        ...need(values(steps, 'session.rename')[0]?.name === prompts.NAME2, 'rename did not return the new name'),
        ...need(nameIn(lists[1])?.name === prompts.NAME2, 'the name is not in session.list after the rename'),
        ...need(opened?.name === prompts.NAME2 && userKept,
          `reopened: name ${opened?.name}, user message ${userKept}`)];
    } },
  { name: 'delete', folders: { cwd: 'm3-delete' },
    description: '会话列表里有它；关闭会话（session.close），把会话文件移出会话目录（代替主进程删除会话文件）；'
      + '重新读取列表，它不见了',
    phases: [
      { page: async (rec, args) => {
        await args.list(rec);
        const s = await args.create(rec, args.cwd);
        await args.say(rec, s, args.Q2);
        await rec.settle([{ sessionId: s.sessionId, n: 1 }], rec.rejectAll);
        await args.list(rec);
        await rec.cmd({ type: 'session.close', sessionId: s.sessionId });
      } },
      { node: moveOutOfSessions },
      { page: async (rec, args) => {
        await args.list(rec);
      } },
    ],
    check: (steps, state) => {
      const s = values(steps, 'session.create')[0];
      const lists = values(steps, 'session.list');
      const has = (found) => Boolean(found?.some((item) => item.sessionFile === s?.sessionFile));
      return [...common(steps), ...noTools(steps), ...allReplied(steps, [s]),
        ...need(has(lists[1]), 'the session is not in session.list before the delete'),
        ...need(values(steps, 'session.close')[0]?.closed === true, 'session.close did not close the session'),
        ...need(Boolean(state.moved) && existsSync(state.moved.to), 'the session file was not moved'),
        ...need(lists.length === 3 && !has(lists[2]), 'the session is still in session.list after the delete')];
    } },
  { name: 'trust-deny', folders: { cwd: 'm3-trust-deny' }, extension: true,
    description: '带 .pi/extensions 的文件夹：trust.check 要问；不信任（不记住）打开，project_hello 不在工具里；'
      + '问模型能用哪些工具，回答里没有它',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd, { trusted: false, remember: false });
      await args.say(rec, s, args.LIST_TOOLS);
      await rec.settle([{ sessionId: s.sessionId, n: 1 }], rec.rejectAll);
    } }],
    check: (steps) => {
      const s = values(steps, 'session.create')[0];
      const check = values(steps, 'trust.check')[0];
      const trust = commands(steps, 'session.create')[0]?.trust;
      const reply = replyText(steps, s?.sessionId);
      return [...common(steps), ...noTools(steps), ...allReplied(steps, [s]),
        ...need(check?.ask === true && check.readError === null, `trust.check: ${JSON.stringify(check)}`),
        ...need(trust?.trusted === false && trust.remember === false, `trust answer: ${JSON.stringify(trust)}`),
        ...need(s?.projectTrust === 'untrusted' && !s.trustRemembered && !s.tools.includes(HELLO_TOOL)
          && s.extensionErrors.length === 0, `session: ${JSON.stringify({ trust: s?.projectTrust, tools: s?.tools })}`),
        ...need(!reply.toLowerCase().includes(HELLO_TOOL), 'the reply mentions project_hello'),
        ...need(BUILTIN_TOOLS.some((tool) => reply.includes(tool)),
          `the reply lists no built-in tool: ${oneLine(reply)}`)];
    } },
  { name: 'trust-allow', folders: { cwd: 'm3-trust-allow' }, extension: true,
    description: '同样的文件夹：信任并记住；project_hello 在工具里，调用时出批准卡，允许后返回 hello from project',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd, { trusted: true, remember: true });
      await args.say(rec, s, args.CALL_HELLO);
      await rec.settle([{ sessionId: s.sessionId, n: 1 }],
        (request) => (request.toolName === args.HELLO_TOOL ? { decision: 'allow' } : { decision: 'reject' }));
    } }],
    check: (steps) => {
      const first = values(steps, 'session.create')[0];
      const checks = values(steps, 'trust.check');
      return [...common(steps), ...allReplied(steps, [first]),
        ...need(checks[0]?.ask === true, `trust.check: ${JSON.stringify(checks)}`),
        ...need(first?.projectTrust === 'trusted' && first.trustRemembered === true && first.tools.includes(HELLO_TOOL)
          && first.trustSaveError === null && first.extensionErrors.length === 0,
        `first session: ${JSON.stringify({ trust: first?.projectTrust, remembered: first?.trustRemembered,
          tools: first?.tools, errors: first?.extensionErrors, saveError: first?.trustSaveError })}`),
        ...helloCalled(steps)];
    } },
  { name: 'trust-remembered', folders: { cwd: 'm3-trust-remembered' }, extension: true,
    description: '重启之后：上次信任并记住的文件夹；点开里面的会话不再问（trust.check 不用问），直接信任、来自记住的选择，'
      + 'project_hello 可以用（准备阶段信任并记住、发一条不用工具的消息，不录）',
    phases: [
      { page: async (rec, args) => {
        const s = await args.create(rec, args.cwd, { trusted: true, remember: true });
        await args.say(rec, s, args.SHORT);
        await rec.settle([{ sessionId: s.sessionId, n: 1 }], rec.rejectAll);
      } },
      { restart: true },
      { page: async (rec, args) => {
        const [s] = args.setup;
        await args.list(rec);
        const opened = await args.reopen(rec, s.sessionFile, s.cwd);
        await args.say(rec, opened, args.CALL_HELLO);
        await rec.settle([{ sessionId: opened.sessionId, n: 1 }],
          (request) => (request.toolName === args.HELLO_TOOL ? { decision: 'allow' } : { decision: 'reject' }));
      } },
    ],
    check: (steps) => {
      const opened = values(steps, 'session.open')[0];
      const checks = values(steps, 'trust.check');
      return [...common(steps, true),
        ...need(checks[0]?.ask === false && !commands(steps, 'session.open')[0]?.trust,
          `trust.check / answer: ${JSON.stringify(checks)}`),
        ...need(opened?.projectTrust === 'trusted' && opened.trustRemembered === true
          && opened.tools.includes(HELLO_TOOL), `reopened: ${JSON.stringify({ trust: opened?.projectTrust,
          remembered: opened?.trustRemembered, tools: opened?.tools })}`),
        ...helloCalled(steps)];
    } },
  { name: 'background', folders: { cwd: 'm3-background' },
    description: 'A 发一段较长的问题后不等它结束，在同一文件夹新建 B（照 Ctrl+N 的做法）并发一个短问题；两个会话各自结束',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const a = await args.create(rec, args.cwd);
      await args.say(rec, a, args.LONG);
      const b = await args.create(rec, a.cwd);
      await args.say(rec, b, args.SHORT);
      await rec.settle([{ sessionId: a.sessionId, n: 1 }, { sessionId: b.sessionId, n: 1 }], rec.rejectAll);
    } }],
    check: (steps) => {
      const [a, b] = values(steps, 'session.create');
      const bCreated = steps.findIndex((s) => s.result?.type === 'session.create'
        && s.result.value?.sessionId === b?.sessionId);
      return [...common(steps), ...noTools(steps), ...allReplied(steps, [a, b]),
        ...need(Boolean(a && b) && a.cwd === b.cwd, 'A and B are not in the same folder'),
        ...need(settledAt(steps, a?.sessionId) > bCreated, 'A had already settled when B was created')];
    },
    note: (steps) => {
      const [a, b] = values(steps, 'session.create');
      return settledAt(steps, b?.sessionId) < settledAt(steps, a?.sessionId) ? '（实际：B 先结束，A 后结束）'
        : '（实际：A 先结束；创建 B 时 A 仍在生成）';
    } },
  { name: 'archive', folders: { cwd: 'm3-archive' },
    description: '归档（界面的归档是 session.close、在本机记下、重新读取列表）：发一条不用工具的消息，结束后关闭会话；'
      + '重新读取列表，它还在（live 为 null，后台进程里已经没有它）',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await args.say(rec, s, args.Q4);
      await rec.settle([{ sessionId: s.sessionId, n: 1 }], rec.rejectAll);
      await rec.cmd({ type: 'session.close', sessionId: s.sessionId });
      await args.list(rec);
    } }],
    check: (steps) => {
      const s = values(steps, 'session.create')[0];
      const lists = values(steps, 'session.list');
      const listed = lists.at(-1)?.find((item) => item.sessionFile === s?.sessionFile);
      return [...common(steps), ...noTools(steps), ...allReplied(steps, [s]),
        ...need(values(steps, 'session.close')[0]?.closed === true, 'session.close did not close the session'),
        ...need(lists.length === 2 && listed?.live === null && listed.firstMessage === prompts.Q4,
          `the final session.list: ${JSON.stringify(listed)}`)];
    } },
  { name: 'reattach', folders: { cwd: 'm3-reattach' },
    description: '界面重新加载之后：会话列表里那个会话还在后台进程里生成（live.running）；不问信任直接打开，'
      + '带回这一刻的样子，回复接着流入直到结束（准备阶段新建会话、发一个长问题，回复开始流入后像 Ctrl+R 一样'
      + '重新加载页面，不录）',
    phases: [
      { page: async (rec, args) => {
        const s = await args.create(rec, args.cwd);
        await args.say(rec, s, args.LONGER);
        await rec.until(() => rec.events().some((e) => e.sessionId === s.sessionId
          && e.event.type === 'message_update' && e.event.update?.type === 'text_delta'), 'the reply to start', 60000);
      } },
      { reload: true },
      { page: async (rec, args) => {
        const [s] = args.setup;
        const listed = (await args.list(rec)).find((item) => item.sessionFile === s.sessionFile);
        // 界面对带 live 的会话不问信任（projects.ts openSaved）；不带时照常先 trust.check（check 会拒绝这段录制）。
        const opened = listed?.live ? await rec.cmd({ type: 'session.open', sessionFile: s.sessionFile })
          : await args.reopen(rec, s.sessionFile, s.cwd);
        await rec.settle([{ sessionId: opened.sessionId, n: 1 }], rec.rejectAll);
      } },
    ],
    check: (steps, state) => reattachProblems(steps, values(state.setup, 'session.create')[0]),
    note: (steps) => (values(steps, 'session.open')[0]?.live?.streaming
      ? '（实际：打开时回复正在流入，带回了已生成的部分）' : '（实际：打开时回复还没开始流入）') },
  { name: 'ext-ui', folders: { cwd: 'm3-ext-ui' }, extension: 'ask',
    description: '扩展的询问：信任并记住带项目扩展的文件夹；让模型调用 project_ask，允许后它依次确认、选择、输入'
      + '（录制器依次答"是""乙""来自 Mori 的回答"），再发一条通知；工具返回三个回答',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd, { trusted: true, remember: true });
      await args.say(rec, s, args.CALL_ASK);
      await rec.settle([{ sessionId: s.sessionId, n: 1 }],
        (request) => (request.toolName === args.ASK_TOOL ? { decision: 'allow' } : { decision: 'reject' }),
        (request) => args.ASK_ANSWERS[request.method] ?? null);
    } }],
    check: (steps) => {
      const s = values(steps, 'session.create')[0];
      const check = values(steps, 'trust.check')[0];
      return [...common(steps), ...allReplied(steps, [s]),
        ...need(check?.ask === true, `trust.check: ${JSON.stringify(check)}`),
        ...need(s?.projectTrust === 'trusted' && s.tools.includes(ASK.tool) && s.extensionErrors.length === 0,
          `session: ${JSON.stringify({ trust: s?.projectTrust, tools: s?.tools, errors: s?.extensionErrors })}`),
        ...askCalled(steps)];
    } },
];

/** @brief 把共用的操作注入页面里的场景函数（页面里没有模块作用域）。 */
function wrap(body) {
  return `async (rec, args) => {
    args.create = ${create.toString()};
    args.reopen = ${reopen.toString()};
    args.say = ${say.toString()};
    args.list = ${list.toString()};
    return (${body.toString()})(rec, args);
  }`;
}

/** @brief 在页面里执行一段场景，返回到目前为止录下的全部步骤；reset 为真时先清空录制器（场景的第一段）。 */
function recordInPage(page, body, args, reset) {
  return page.evaluate(async ({ source: text, values: params, fresh }) => {
    const rec = window.__rec;
    if (fresh) rec.reset();
    try {
      // eslint-disable-next-line no-new-func
      await new Function('rec', 'args', `return (${text})(rec, args);`)(rec, params);
    } catch (error) {
      const seen = rec.steps.map((s) => s.command?.type ?? s.result?.type ?? s.envelope?.event.type);
      const last = JSON.stringify(rec.steps.at(-1)).slice(0, 600);
      throw new Error(`${error.message}; steps: ${seen.join(' ')}; last: ${last}`);
    }
    await rec.sleep(300);
    return rec.steps;
  }, { source: wrap(body), values: args, fresh: reset });
}

/**
 * @brief 在 root 下准备名为 name 的项目（内容见 lib.mjs prepareProject）；extension 为真时带项目扩展：
 *        true 为 project-hello，其余按 EXTENSION_FILES 的名字。
 */
function prepareFolder(root, name, extension) {
  const made = prepareProject('mori-m3-record-');
  const project = join(root, name);
  renameSync(made.project, project);
  rmSync(made.root, { recursive: true, force: true });
  if (extension) {
    const [file, source] = EXTENSION_FILES[extension === true ? 'hello' : extension];
    mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(project, '.pi', 'extensions', file), source);
  }
  return project;
}

/** @brief 录下的步骤的简短说明：步数、事件数、会话数、工具调用与批准、扩展询问的回答。 */
function summarize(steps) {
  const events = steps.filter((s) => s.envelope).length;
  const sessions = values(steps, 'session.create').length + values(steps, 'session.open').length;
  const tools = eventsOf(steps, 'tool_execution_end').map((e) => `${e.toolName}${e.isError ? '(error)' : ''}`);
  const ends = eventsOf(steps, 'mori.approval_end').map((e) => `${e.decision}/${e.by}`);
  const answers = commands(steps, 'ui.answer').map((c) => JSON.stringify(c.value));
  return `${steps.length} steps, ${events} events, ${sessions} session(s), tools: ${tools.join(', ') || 'none'}, `
    + `approvals: ${ends.join(', ') || 'none'}, ui answers: ${answers.join(', ') || 'none'}`;
}

/** @brief 等页面上有 window.mori，装好录制器。 */
async function installInPage(page) {
  await page.waitForFunction(() => Boolean(window.mori));
  await page.evaluate(installRecorder);
  await page.evaluate(installSettleHelpers);
}

/** @brief 启动 Mori 并在页面里装好录制器。 */
async function startMori(userData) {
  const app = await launch({ exePath, userData });
  const page = await app.firstWindow();
  await installInPage(page);
  return { app, page };
}

/**
 * @brief 依次执行场景的各段：page 在页面里录，node 在 node 里做；restart 关掉 Mori 再在同一数据目录启动，
 *        reload 不关 Mori、只像 Ctrl+R 一样重新加载页面（后台进程里的会话照常运行）。两者之前录下的都作为准备
 *        （state.setup，不进 fixture），新建的会话交给之后的段（args.setup），从头开始录。
 */
async function runPhases(scenario, args, state) {
  let steps = [];
  let fresh = true;
  for (const phase of scenario.phases) {
    if (phase.node) {
      phase.node(steps, state);
    } else if (phase.restart || phase.reload) {
      state.setup = steps;
      args.setup = values(steps, 'session.create');
      if (phase.restart) {
        await state.mori.app.close();
        state.mori = await startMori(state.userData);
      } else {
        await state.mori.page.reload();
        await installInPage(state.mori.page);
      }
      steps = [];
      fresh = true;
    } else {
      steps = await recordInPage(state.mori.page, phase.page, args, fresh);
      fresh = false;
    }
  }
  return steps;
}

/** @brief 一个录制场景：准备项目，依次执行各段，核对后写出 fixture（不符合时写到 rejected）。 */
async function runScenario(scenario, context, state) {
  const root = mkdtempSync(join(tmpdir(), 'mori-m3-record-'));
  let steps = [];
  try {
    const args = { ...prompts };
    for (const [key, name] of Object.entries(scenario.folders)) {
      args[key] = prepareFolder(root, name, scenario.extension);
    }
    steps = await runPhases(scenario, args, state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const note = scenario.note?.(steps) ?? '';
  const fixture = {
    source: 'real',
    note: 'Recorded from a real session by tests/ui/m3-record.mjs; do not edit by hand.',
    name: scenario.name,
    description: `${scenario.description}${note}`,
    endpoint: context.endpoint,
    model: context.model,
    recordedAt: new Date().toISOString(),
    steps,
  };
  const problems = scenario.check(steps, state);
  const dir = problems.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${problems.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  if (problems.length) {
    console.log(`FAIL ${scenario.name}: ${problems.join('; ')} — ${summarize(steps)}${note}`);
    process.exitCode = 1;
  } else {
    console.log(`RECORDED ${scenario.name}: ${summarize(steps)}${note}`);
  }
}

/** @brief 每个场景一个新的临时数据目录和一次新的启动；出错也会关掉 Mori、删掉临时目录。 */
async function recordFresh(scenario, context) {
  const userData = scratchUserData(source);
  const state = { userData, moved: null, setup: [], mori: null };
  try {
    state.mori = await startMori(userData);
    await runScenario(scenario, context, state);
  } catch (error) {
    console.error(`FAIL recording ${scenario.name}: ${oneLine(error, 600)}`);
    process.exitCode = 1;
  } finally {
    await state.mori?.app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
}

/** @brief 读取走查连接的非机密信息。 */
function connectionInfo(dir) {
  const provider = JSON.parse(readFileSync(join(dir, 'pi', 'models.json'), 'utf8')).providers['mori-endpoint'];
  return { endpoint: provider.baseUrl, model: `mori-endpoint/${provider.models[0].id}` };
}

// 先读连接信息：数据目录不对时在复制密文之前就失败。
const context = connectionInfo(source);
for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordFresh(scenario, context);
}
