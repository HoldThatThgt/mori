// 合成端点（synthetic）的脚本：协作模式下的增强（docs/specs/memory.md §14.1、MEM-31）用的场景，格式见 scripts.mjs 开头；
// 名字以 mem- 开头。增强会话打开协作模式时请求里有 "tb-scenario:<名字>"，走脚本模式（不走 enhance.mjs 的增强脚本）。
// 两种角色配置都写了：
//   分开（MEM_TEAM_ROLES：chat 持有对话、planner 持有立项与结案、executor 做 task、watcher 订阅 request_closed；
//     正文带 tb-scenario，写法同 tb-helpers writeRoles）；
//   合并（没有角色文件，全是基座 mori）：tb-scenario 要从别处进请求，例如项目的 AGENTS.md（memTeamAgentsMd，
//     进每个会话的 system），或测试写好的那个会话的第一条用户消息（它就是第一条消息里列出的会话名，task 实例的工作卡
//     User's words 里也有）。
// 'mem-team'：立项（planner 或合并会话）先用 memory 改一条你写的条目、一条别的种类的条目（都被拒绝，看调用方是
//   enhance:<task>），再提交需求、建写 task T1 与依赖它的只读 task T2；T1 先用 memory save（依据是测试写好的会话文件与
//   条目 id），再 write 一次（增强会话里被拒绝，§9.6），然后交接；T2 用 memory update 只加依据印证同一条（按 abstract
//   匹配），分开配置下再问基座 mori 一个问题（临时提问实例），然后交接；结案依次关闭 T1、T2 与需求；对话最后汇报。
//   分开配置下对话自己也调用一次 memory（协作模式分开时对话没有它，§7.6）。
// 'mem-team-need'：立项提交需求、建只读 task T1；T1 用 memory save 之后以 need_user 交接，等你拿主意（没人回答），
//   这次运行就此结束（§9.6 结束条件）。
// 测试准备（synthetic test setup）：套件启动端点前设环境变量（同 scenarios/flow.mjs 的做法，载入时读一次）：
//   MEM_TEAM_SESSION   依据的会话文件（测试写好的、这次运行第一条消息列出的会话文件）的绝对路径
//   MEM_TEAM_ENTRY     那个文件里一行的条目 id
//   MEM_TEAM_USER_ENTRY  本项目这一种里一条你写的（source: user）条目的 id（改它被拒绝）
//   MEM_TEAM_OTHER_ENTRY 另一种（别的种类）里的一条条目的 id（改它被拒绝）
// 没设时为空字符串（例如 selfcheck 载入），对应的调用按"找不到条目"或依据不在范围被拒绝。
// 这里另外导出套件要比较的文字（MEM_TEAM_TEXT）与角色（MEM_TEAM_ROLES），scripts.mjs 只并入 SCENARIOS。

import { call, end, say } from '../steps.mjs';

/** 套件给的环境变量（synthetic test setup） */
const env = {
  session: process.env.MEM_TEAM_SESSION ?? '',
  entry: process.env.MEM_TEAM_ENTRY ?? '',
  userEntry: process.env.MEM_TEAM_USER_ENTRY ?? '',
  otherEntry: process.env.MEM_TEAM_OTHER_ENTRY ?? '',
};

/** 套件要比较的文字 */
export const MEM_TEAM_TEXT = {
  /** T1 存下的条目（learned）与它的 detail、依据里的原话 */
  abstract: 'Plan before changing more than three modules',
  detail: 'Synthetic entry saved by the mem-team scenario.',
  quote: 'Tell me how you plan to change it first',
  /** T1 想写的文件与内容（被拒绝，文件不该出现） */
  writePath: 'mem-team-note.txt',
  writeContent: 'written by an enhancement task\n',
  /** 对话想存的条目（协作模式分开时对话没有 memory） */
  dialogAbstract: 'The dialog should not save memory',
  /** T2 印证条目时的说明 */
  confirmNote: 'The same session confirms it',
  /** 立项想改别人的条目时的说明 */
  userNote: 'Try to change an entry the user wrote',
  otherNote: 'Try to change an entry of another kind',
  /** T2 问基座 mori 的问题与回答（分开配置的临时提问实例） */
  askQuestion: 'Is the evidence session about planning? tb-scenario:mem-team',
  askAnswer: 'Yes, it is about planning.',
  /** 立项、对话、结案的最后一段文字 */
  registered: 'Registered request 1 with T1 and T2.',
  relayed: 'Planner registered request 1.',
  report: 'Request 1 is done: the lesson was saved.',
  closedT1: 'T1 closed.',
  closedAll: 'Request 1 closed.',
  /** mem-team-need：T1 要你拿主意的问题，立项与对话的回复 */
  needQuestion: 'Which module should this lesson name?',
  needRelay: 'T1 needs your decision: which module should this lesson name?',
};

/** @brief 依据：测试写好的会话文件与条目 id，带原话。 */
const evidence = () => [{ session: env.session, entry: env.entry, quote: MEM_TEAM_TEXT.quote }];

/** @brief T1 的 memory save（learned 条目，依据是测试写好的会话）。 */
const saveLesson = () => call('memory', { action: 'save', abstract: MEM_TEAM_TEXT.abstract,
  detail: MEM_TEAM_TEXT.detail, evidence: evidence() });

/** @brief 立项想改的两条（都被拒绝）：你写的条目、别的种类的条目。 */
const refusedChanges = () => [
  call('memory', { action: 'update', entry: env.userEntry, note: MEM_TEAM_TEXT.userNote, evidence: evidence() }),
  call('memory', { action: 'update', entry: env.otherEntry, note: MEM_TEAM_TEXT.otherNote, evidence: evidence() }),
];

/** @brief mem-team 的立项：两条被拒绝的 memory，然后提交需求、建 T1（写）与依赖它的 T2（只读）。 */
const createTwoTasks = (assignee) => [...refusedChanges(),
  call('request_submit', { title: 'Remember a lesson', goal: 'A learned entry with evidence' }),
  call('task_create', { request: 1, title: 'Save the lesson', description: 'Save the lesson with memory',
    assignee, read_only: false }),
  call('task_create', { request: 1, title: 'Confirm the lesson', description: 'Add evidence to the lesson',
    assignee, read_only: true, depends_on: ['T1'] }),
  say(MEM_TEAM_TEXT.registered)];

/** @brief T1：memory save → write（被拒绝）→ 带 memory 结果作证据交接。 */
const saveThenHandoff = () => [saveLesson(),
  call('write', { path: MEM_TEAM_TEXT.writePath, content: MEM_TEAM_TEXT.writeContent }),
  call('task_handoff', { task: '{task}', conclusion: 'Saved the lesson', outcome: 'done',
    evidence: ['{tag:memory}'] })];

/** @brief T2：memory update 只加依据（按 abstract 匹配 T1 存的那条）；ask 为真时再问基座 mori 一个问题。 */
const confirmThenHandoff = (ask) => [
  call('memory', { action: 'update', entry: MEM_TEAM_TEXT.abstract, note: MEM_TEAM_TEXT.confirmNote,
    evidence: evidence() }),
  ...(ask ? [call('agent_message', { to: 'mori', text: MEM_TEAM_TEXT.askQuestion })] : []),
  call('task_handoff', { task: '{task}', conclusion: 'Confirmed the lesson', outcome: 'done',
    evidence: ['{tag:memory}'] })];

/** @brief 结案：第 1 次投递关闭 T1；第 2 次关闭 T2 与需求。 */
const closeTwo = () => ({
  1: [call('task_handoff', { task: '{task}', conclusion: 'The lesson is saved', outcome: 'close_done' }),
    say(MEM_TEAM_TEXT.closedT1)],
  2: [call('task_handoff', { task: '{task}', conclusion: 'The lesson is confirmed', outcome: 'close_done' }),
    call('request_close', { request: 1, outcome: 'done', conclusion: 'The lesson was saved and confirmed' }),
    say(MEM_TEAM_TEXT.closedAll)],
});

/** @brief mem-team-need 的立项：提交需求、建只读 T1（给 assignee）；被唤醒（need_user）时转述问题。 */
const createNeed = (assignee) => ({
  1: [call('request_submit', { title: 'Name the module', goal: 'A lesson that names the module' }),
    call('task_create', { request: 1, title: 'Ask which module', description: 'Save the lesson, then ask the user',
      assignee, read_only: true }), say(MEM_TEAM_TEXT.registered)],
  2: [say(MEM_TEAM_TEXT.needRelay)],
});

/** @brief mem-team-need 的 T1：memory save 之后以 need_user 交接。 */
const saveThenNeed = () => [saveLesson(),
  call('task_handoff', { task: '{task}', conclusion: MEM_TEAM_TEXT.needQuestion, outcome: 'need_user' })];

/**
 * @brief 分开配置的角色（synthetic test setup，写法同 tb-helpers SPLIT_ROLES；正文带脚本名，writeRole 再加 MORI-ROLE）。
 * @param scenario 'mem-team' 或 'mem-team-need'
 */
export function memTeamRoles(scenario) {
  const body = (text) => `${text} tb-scenario:${scenario}`;
  return [
    { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'],
      body: body('You are chat.') },
    { name: 'planner', description: 'Decides how to split each request and closes it', seats: ['create', 'close'],
      body: body('You are planner.') },
    { name: 'executor', description: 'Changes code and runs commands to finish a task',
      body: body('You are executor.') },
    { name: 'watcher', description: 'Keeps notes when a request closes', subscribe: ['request_closed'],
      body: body('You are watcher.') },
  ];
}

/** @brief 合并配置（没有角色文件）时项目 AGENTS.md 的内容（synthetic）：把脚本名带进每个会话的 system。 */
export const memTeamAgentsMd = (scenario) => `# Synthetic project notes\n\ntb-scenario:${scenario}\n`;

export const SCENARIOS = {
  'mem-team': [
    // 合并配置：增强会话本身兼立项，基座做 task 与结案
    { role: 'mori', kind: 'merged-create', deliveries: { 1: createTwoTasks('mori'), 2: [say(MEM_TEAM_TEXT.report)] } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: { 1: saveThenHandoff() } },
    { role: 'mori', kind: 'task', task: 'T2', deliveries: { 1: confirmThenHandoff(false) } },
    { role: 'mori', kind: 'close', deliveries: closeTwo() },
    // 分开配置
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [call('memory', { action: 'save', abstract: MEM_TEAM_TEXT.dialogAbstract, evidence: evidence() }),
        say(MEM_TEAM_TEXT.relayed)],
      2: [say(MEM_TEAM_TEXT.report)],
    } },
    { role: 'planner', kind: 'create', deliveries: { 1: createTwoTasks('executor') } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: saveThenHandoff() } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: { 1: confirmThenHandoff(true) } },
    { role: 'mori', kind: 'ask', deliveries: { 1: [say(MEM_TEAM_TEXT.askAnswer)] } },
    { role: 'planner', kind: 'close', deliveries: closeTwo() },
    { role: 'watcher', kind: 'subscription', deliveries: { 1: [end()] } },
  ],
  'mem-team-need': [
    { role: 'mori', kind: 'merged-create', deliveries: createNeed('mori') },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: { 1: saveThenNeed() } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say(MEM_TEAM_TEXT.relayed)],
      2: [say(MEM_TEAM_TEXT.needRelay)] } },
    { role: 'planner', kind: 'create', deliveries: createNeed('executor') },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: saveThenNeed() } },
  ],
};
