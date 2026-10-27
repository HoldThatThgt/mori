// 合成端点（synthetic）的脚本：文件系统第 1 步（权限）的 App 套件（tests/ui/fs-app-gate.mjs、fs-app-work.mjs、
// fs-app-away.mjs、fs-app-question.mjs，docs/specs/file-system.md §19.1、§19.2）在协作模式与脚本模式下用的场景，
// 格式见 scripts.mjs 开头；名字以 fs- 开头。只有一个通用场景 fs-team：每种会话要做的调用由你的消息里的“行”给出
// （scripts.mjs 的 line 步骤：一行 "<key>: <步骤>"，步骤是关键词的单步写法，例如 "fs-call: write file: ../out.md"、
// "fs-dialog: ask user: db"、"fs-create: [wait 3000] call tool: mcp__srv__echo {"text":"x"}"），没写的行那一步不算。
//
// 写消息的约定（App 套件照做）：每个 key 单独一行，值到行尾为止；最后一行写 "tb-scenario:fs-team"（工作卡的
// User's words 把原话放在引号里，最后一行的末尾会多一个引号，所以 key 不要放在最后一行）。例：
//   fs-call: write file: ../fs-out.md
//   fs-after: say: Pausing to report.
//   tb-scenario:fs-team
//
// 两种配置都能用：合并会话（没有角色文件，基座 mori 持有三项权限）与分开（tb-helpers SPLIT_ROLES：chat 对话、planner
// 立项与结案、executor 做 task）。各会话的步骤（k 是这个会话的投递序号；提醒不算投递，见 scripts.mjs）：
//   - 立项（mori 的 merged-create，planner 的 create），每次投递：这次投递（你的消息，或分开时转来的 "[Mori] New user
//     message: …"）里有 fs-call 行时先 request_submit（FS_TEXT.title）、task_create（request 1，FS_TEXT.taskTitle，
//     assignee 合并时 mori、分开时 executor，limits 是这次投递里 fs-task-limits 行的 JSON（文件系统第 3 步加，例如
//     "fs-task-limits: {"write":false}"；没有这一行时不写 limits，是写 task），description 是 "fs-call: <行值>"、
//     "fs-after: <行值>" 与 "fs-remind: <行值>" 三行）；这次投递里有 fs-create 行时做它；然后回 FS_TEXT.handled。
//     程序唤醒等没有这些行的投递只回 FS_TEXT.handled。所以带 fs-call 的消息在一个会话里只发一次（需求编号写死为 1）。
//   - task 实例（mori 或 executor 的 task），k = 1：fs-call 行 → fs-after 行（没有时不算）→ task_handoff done
//     （FS_TEXT.conclusion）。fs-after 写 "say: …" 时这次运行在交接前结束：你不在、有自动处理时补了提醒，模型对提醒的
//     回复就是 task_handoff（§9.8 有工作卡的实例）；没有提醒时 Mori 的强制填写（k = 2、3）按 handoff 交接。
//   - 结案（mori 或 planner 的 close），k = 1：fs-close 行 → task_handoff close_done → request_close（结论：有 fs-sub
//     行时两行 "All done" 与 "fs-sub: <行值>"，给订阅读；没有时只有 FS_TEXT.requestDone，即 "All done"）→
//     FS_TEXT.closed；k = 2、3 是强制填写与强制关闭（强制关闭的结论同样按有没有 fs-sub 行：scripts.mjs 的 when 与
//     unless 两项，恰好一项算数）。
//   - 分开时的对话（chat 的 team-dialog），每次投递：这次投递里有 fs-dialog 行时先做它，再回 FS_TEXT.dialog。
//   - 临时提问（任何角色的 ask），k = 1：fs-ask 行（在问题文字里），再回 FS_TEXT.answer；问题文字里要写上
//     tb-scenario:fs-team（§17.1 认脚本）。
//   - 订阅（任何角色的 subscription），每次投递：这次投递里有 fs-sub 行时先做它（需求关闭的投递带结论的那一行），
//     再回 FS_TEXT.seen。
//   - 关闭模式的对话（任何角色的 off-dialog、dialog，消息里带 tb-scenario 时），每次投递：这次投递里有 fs-off 行时先做它
//     （例如 "fs-off: call tool: agent_message {"to":"planner","text":"Why? tb-scenario:fs-team"}"），再回 FS_TEXT.off。
// 每个回复步骤列表的最后两项是 fs-remind 行与 FS_TEXT.reminded：只有补了提醒、多跑一次请求时才用到，没有提醒时
// 不会请求到它们。fs-remind 行（没写时不算，回 FS_TEXT.reminded）让套件控制对提醒的回复，例如
// "fs-remind: [wait 3000] say: Noted the reminder." 把多跑的那次请求拉长（FS-79：等 agent_settled 的程序投递要在它
// 之后才开始，按 FAKE_REQUEST_LOG 的顺序断言），"fs-remind: [fail-once 503] say: Noted." 让它先失败一次。
// 一直开着的会话（立项、对话、订阅、关闭模式的对话）只在最后一次投递里找它；task 实例、结案、临时提问在全部 user
// 消息（含工作卡的 User's words 与 task 的 description）里找，所以同一行对看得到你的原话的每个会话都生效。
// task 实例里它在 task_handoff 之后（对提醒的回复本来是交接，见上），结案里在 FS_TEXT.closed 之后。
// 文件系统第 3 步：task_create 不再有 read_only，limits 可选（file-system-permissions.md §8.2），由 fs-task-limits 行给
// （scripts.mjs 的 {lastJson:} 模板）；一条消息建几个 task、各种会话按步骤串做被收窄的调用用 scenarios/fs-team.mjs 的
// 场景 fs-limits。

import { call, handoff, line, say, unless, when } from '../steps.mjs';

/** 套件要比较的文字 */
export const FS_TEXT = {
  /** 立项登记的需求（标题带 tb-scenario：订阅实例的请求里只有需求标题能认出脚本，§17.1） */
  title: 'File system check tb-scenario:fs-team',
  goal: 'The file system check is done',
  /** 立项建的 task */
  taskTitle: 'Make the call',
  /** 立项每次投递的回复 */
  handled: 'Handled this message.',
  /** task 实例交接的结论 */
  conclusion: 'The call was made',
  /** 结案的回复 */
  closed: 'Closed.',
  /** 结案关闭需求的结论（有 fs-sub 行时之后还有一行 "fs-sub: <行值>"） */
  requestDone: 'All done',
  /** 分开时对话的回复 */
  dialog: 'Chat reply.',
  /** 临时提问的回答 */
  answer: 'Answer from the question.',
  /** 订阅的回复 */
  seen: 'Seen the moment.',
  /** 关闭模式对话的回复 */
  off: 'Off mode reply.',
  /** 对你不在时的提醒的回复（补了提醒、多跑的那一次请求） */
  reminded: 'Noted the reminder.',
};

/** 一直开着的会话的投递数上限（每次投递同样的步骤） */
const MAX_DELIVERIES = 12;
/** 只在最后一次投递里找行 */
const LAST = { last: true };
/** 对提醒的回复：有 fs-remind 行时是它（在全部 user 消息里找），没有时是 FS_TEXT.reminded（见文件开头） */
const reminded = [line('fs-remind'), say(FS_TEXT.reminded)];
/** 同上，一直开着的会话只在最后一次投递里找 fs-remind 行 */
const remindedLast = [line('fs-remind', LAST), say(FS_TEXT.reminded)];

/** @brief k = 1..MAX_DELIVERIES 每次投递都是 steps。 */
const everyDelivery = (steps) => Object.fromEntries(Array.from({ length: MAX_DELIVERIES }, (_, i) => [i + 1, steps]));

/** task 实例交接（done） */
const TASK_DONE = { task: '{task}', conclusion: FS_TEXT.conclusion, outcome: 'done' };
/** 结案关闭交来的 task */
const CLOSE_DONE = { task: '{task}', conclusion: 'Checked and closed', outcome: 'close_done' };
/** 结案关闭需求，没有 fs-sub 行时：结论只有 FS_TEXT.requestDone */
const REQUEST_PLAIN = { request: '{request}', outcome: 'done', conclusion: FS_TEXT.requestDone };
/** 同上，有 fs-sub 行时：结论的第二行带它的行值（订阅收到的需求关闭投递里有结论） */
const REQUEST_SUB = { ...REQUEST_PLAIN, conclusion: `${FS_TEXT.requestDone}\nfs-sub: {line:fs-sub}` };
/**
 * @brief 关闭需求的一个步骤位置：有 fs-sub 行时 make(REQUEST_SUB)，没有时 make(REQUEST_PLAIN)，恰好一项算数。
 * @param make 字段 → 步骤（request_close 调用或强制关闭的 handoff）
 */
const closeRequest = (make) => [when('fs-sub', make(REQUEST_SUB)), unless('fs-sub', make(REQUEST_PLAIN))];

/**
 * @brief 立项（合并会话或分开时的立项）：这次投递有 fs-call 行时登记需求、建 task，有 fs-create 行时做它，再回 handled。
 * @param role 角色（mori 或 planner）
 * @param kind merged-create 或 create
 * @param assignee task 的角色
 */
const creator = (role, kind, assignee) => ({ role, kind, deliveries: everyDelivery([
  when('fs-call', call('request_submit', { title: FS_TEXT.title, goal: FS_TEXT.goal }), LAST),
  when('fs-call', call('task_create', { request: 1, title: FS_TEXT.taskTitle, assignee,
    description: 'fs-call: {line:fs-call}\nfs-after: {line:fs-after}\nfs-remind: {line:fs-remind}',
    limits: '{lastJson:fs-task-limits}' }), LAST),
  line('fs-create', LAST), say(FS_TEXT.handled), ...remindedLast,
]) });

/** @brief task 实例：fs-call、fs-after，再交接；k = 2、3 是强制填写与格式重试。 */
const worker = (role) => ({ role, kind: 'task', deliveries: {
  1: [line('fs-call'), line('fs-after'), call('task_handoff', TASK_DONE), ...reminded],
  2: [handoff(TASK_DONE)],
  3: [handoff(TASK_DONE)],
} });

/** @brief 结案：fs-close，再关闭交来的 task 与需求；k = 2 强制填写，k = 3 强制关闭。 */
const closer = (role) => ({ role, kind: 'close', deliveries: {
  1: [line('fs-close'), call('task_handoff', CLOSE_DONE), ...closeRequest((fields) => call('request_close', fields)),
    say(FS_TEXT.closed), ...reminded],
  2: [handoff(CLOSE_DONE)],
  3: closeRequest((fields) => handoff(fields)),
} });

/** @brief 一直开着的会话：每次投递里有 key 那一行时先做它，再回 text（对话、订阅、关闭模式的对话）。 */
const lineEach = (role, kind, key, text) => ({ role, kind,
  deliveries: everyDelivery([line(key, LAST), say(text), ...remindedLast]) });

export const SCENARIOS = {
  // 通用场景（见文件开头）：FS-36 后台卡的原因行、FS-53 task 实例的 TMPDIR、FS-72 后台实例的卡到时、FS-78 有工作卡的
  // 实例的提醒、FS-79 提醒与 TaskBoard 投递、FS-83 各种会话的 tools、FS-89 批准卡与提问卡的排序、FS-90 转给立项
  'fs-team': [
    creator('mori', 'merged-create', 'mori'),
    creator('planner', 'create', 'executor'),
    worker('mori'),
    worker('executor'),
    closer('mori'),
    closer('planner'),
    lineEach('chat', 'team-dialog', 'fs-dialog', FS_TEXT.dialog),
    { role: '*', kind: 'ask', deliveries: { 1: [line('fs-ask'), say(FS_TEXT.answer), ...reminded] } },
    lineEach('*', 'subscription', 'fs-sub', FS_TEXT.seen),
    lineEach('*', 'off-dialog', 'fs-off', FS_TEXT.off),
    lineEach('*', 'dialog', 'fs-off', FS_TEXT.off),
  ],
};
