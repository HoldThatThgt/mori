// 合成端点（synthetic）的脚本：文件系统第 2 步（git、快照与 Rewind）的 App 套件（tests/ui/fs-app-changes.mjs、
// fs-app-rewind.mjs，docs/specs/file-system.md §19.1、§19.2 的 FS-11、FS-12、FS-14、FS-15 等）在协作模式下用的场景
// fs-git，格式见 scripts.mjs 开头。另导出这些套件写消息的帮助函数（gitStep、keywordSteps、gitMessage、
// gitOpenRequest）、关键词写下的内容（writtenText、binaryBytes、manyFileName，断言 Rewind 后的文件内容用）与
// App 测试自己写很多个文件的 writeManyFiles（FS-10）。
//
// 一、关键词模式（没有 tb-scenario 的会话：关闭模式下的对话 Agent，规则见 server.mjs 开头）。一条消息就是一轮；
//   每个会话只看它自己最后一条你的消息，所以两个会话各发各的消息就各做各的（同一文件夹的重叠、<R> 与 <R>/app）。
//   - 改、建、删：write file: <路径> :: <文字>（指定内容，"\n" 是换行）、write file: <路径>（"hello from mori\n"）、
//     edit file: <路径> :: <原文> => <新文>、run: rm <路径>、run: echo x > a.txt（bash 改的文件）。
//   - 二进制：binary file: <路径> [:: <标记>]（bash 的 printf，内容 binaryBytes(标记)，git 认作二进制，记录里行数为 null）。
//   - 一段改很多文件：many files: <目录> <n>（一条 bash 命令建 n 个文件 <目录>/f00000.txt…，FS-11 的 501 个）。
//   - 上面几条写得不对（binary file: x.bin :: a b、write file: a.txt ::x、edit file: a.txt :: x 没有 =>、many files: d
//     没有个数等）时回 "Unknown step: <原文>"，没有调用，不会拿整段当路径。
//   - 一轮里几步：steps: <步骤> ;; <步骤> …（关键词链；最后一步 say: <文字> 让这次运行结束）。
//   - 让运行一直在跑：[wait <毫秒>] 修饰（这一步的回复推迟，没有工具调用也没有卡）、wait <秒>s（整条消息只回一段
//     推迟的文字）、run: sleep <秒>（bash 在跑；Ask each time 下先出命令的卡，Full access 下直接跑）。例：
//     "steps: write file: a.txt :: A1 ;; [wait 6000] write file: a2.txt :: A2 ;; say: A done" 写完 a.txt 之后运行
//     还要跑 6 秒，期间另一个会话的运行与它重叠（FS-11、FS-16 的 overlap）；"steps: [wait 20000] say: Late" 让运行跑
//     20 秒（FS-15 运行中的 Rewind、FS-24、有序退出 FS-22），"wait 20s" 同样。
//     修饰开头的一行单独作一条消息（"[wait 6000] write file: a.txt :: x"）时当作只有这一步的关键词链（replies.mjs
//     HELD），修饰照样生效；"say:" 不带修饰时只在链里认（单独发 "say: x" 不认），只回文字的一轮写 steps: say: <文字>
//     或 plain。
//   - 运行开始的快照要跑一会儿（FS-10：Taking a snapshot… 时按停止、关闭会话，结束的要是开始快照自己的 git 进程）：
//     端点在开始快照之后才收到请求，管不到快照本身，要让开始快照自己有很多新文件要加。做法：会话空闲时（第一条消息
//     之前，或上一轮的记录已经到了之后）App 测试自己用 writeManyFiles(<项目>/big, 4000) 在项目里写很多个没跟踪的
//     小文件（少于默认的 20000 个新文件上限、多于默认的每批 2000 个，所以开始快照分批 git add，每批一个 git 进程），
//     再发一条普通消息（例如 plain）：这时开始快照自己的 git add 在跑。2026-10-27 在本机量过（os.tmpdir() 下，
//     同 snapshots.ts 的分批：每批 git add --pathspec-from-file 2000 个，最后 add -A）：Node 写 15000 个 11 秒，
//     每批 6–10 秒，15000 个共 71 秒，删掉 10.5 秒；4000 个 4.3 秒写完、两批共 15 秒、删掉 8 秒。停止之后已经加进
//     内部仓库 index 的那几批不再算新文件，下一次开始快照只加剩下的；想让它快可以先用 fs.rmSync 删掉这个目录。
//     不要用上一轮的 many files: 代替：那一轮的结束快照已经把这些文件加进去了，下一次开始快照很快；紧接着发消息时
//     开始快照只是排在上一轮的结束快照后面等，没有自己的 git 进程，而关闭会话还要等这个会话自己的结束快照
//     （docs/v1/fs-checks.md 负责人不在时定下的选择 #11）。
//   上面这些命令 Mori 的命令分析都认作只写工作路径里面（scope inside），Full access 下不出卡。
//
// 二、脚本 fs-git（协作模式下 task 改文件：FS-14，后台 Agent 的 agents 标注 FS-11，[Mori] 投递与 Turn 编号 FS-12，
//   只有后台实例在运行 FS-15）。写消息的约定同 scenarios/fs.mjs：每个 key 单独一行，值到行尾；最后一行写
//   "tb-scenario:fs-git"（gitMessage 拼好）。各会话：
//   - 立项（合并会话 mori 的 merged-create；分开时 planner 的 create），每次投递：这次投递里有 git-task 行时先
//     request_submit（GIT_TEXT.title），再 task_create（request 为刚登记的编号 {submitted}，所以同一会话里每条带
//     git-task 的消息各登记一个需求、各建一个 task；assignee 合并时 mori、分开时 executor；read_only false；
//     description 是 "git-task: <这次投递里的行值>"）；有 git-create 行时按 chain 一段一段做它；然后回
//     GIT_TEXT.handled。程序唤醒（[Mori] 投递）没有这些行，只回 GIT_TEXT.handled。
//   - task 实例（mori 或 executor 的 task），k = 1：git-task 行按 " ;; " 分成几段依次做（chain，例如
//     "git-task: edit file: notes.md :: hello => hello from the task ;; run: echo made > from-task.txt"：先 edit
//     再 bash），再 task_handoff done（GIT_TEXT.conclusion）；k = 2、3 是强制填写与格式重试。一段写成
//     "[wait 15000] run: …" 时这个实例跑 15 秒，对话那边已经空闲（FS-15“只有后台实例在运行”）。
//   - 结案（mori 或 planner 的 close），k = 1：task_handoff close_done → request_close（{request}，
//     GIT_TEXT.requestDone）→ GIT_TEXT.closed；k = 2 强制填写，k = 3 强制关闭。
//   - 分开时的对话（chat 的 team-dialog）：每次投递有 git-dialog 行时按 chain 做它，再回 GIT_TEXT.dialog。
//   - 关闭模式的对话（任何角色的 off-dialog、dialog）：一个会话发过 tb-scenario 之后，关掉协作模式再发的消息仍是脚本
//     模式（scripts.mjs 在全部消息里找 tb-scenario），这时每次投递有 git-off 行时按 chain 做它（对话 Agent 自己改文件），
//     再回 GIT_TEXT.off。例："git-off: write file: b.txt :: B2 ;; run: rm c.txt" 加最后一行 tb-scenario:fs-git。
//   - 临时提问、订阅：只回 GIT_TEXT.answer、GIT_TEXT.seen。
//   每个列表最后一项是 GIT_TEXT.reminded：只有你不在时补了提醒才用到（fs-app 套件设了 away never，不会用到）。
//   一直开着的会话（立项、对话）只在最后一次投递里找行（工作卡里可能还抄着上一个需求的原话）；task 实例在全部 user
//   消息（工作卡的 User's words 与 task 的 description）里找。
//   read_only 是 task_create 现在的必填参数；文件系统第 3 步把它换成 limits 时同 scenarios/fs.mjs 一并改这里。
//
// 三、fs-app-rewind.mjs 的两种情形。
//   - 有未关闭的需求而什么都没在跑（FS-18：这条消息之后登记的需求没关时两个恢复对话的选项不可选）：只登记不建 task
//     不够，Mori 会给立项补一条 "[Mori] Request <n> has no tasks. …"，那次运行之后交给结案，fs-git 的结案会把需求关掉
//     （kernel/teamRuns.ts endJudgment 与 closeRunEnded）。所以让登记之后的运行被停止（被停止时不补提醒，
//     docs/specs/parallel-agents-taskboard.md §9.4 第 0 行）：合并会话发 gitOpenRequest()（即
//     gitMessage([['git-create', [gitStep.submit(), gitStep.hold(30000, gitStep.say(GIT_TEXT.deciding))]]])），
//     立项先 request_submit（标题 GIT_TEXT.openTitle），下一段推迟 30 秒；等 TaskBoard 上出现这个需求（登记的回执）
//     后按停止。之后需求一直是 open，没有运行，Restore code 仍可用。
//   - 让 Rewinding… 停留得久一点（FS-24）：被恢复的那一轮多建一些文件（many files: big 4000），恢复代码时要删掉它们；
//     App 里恢复要多久没有量过（上面量过的只是 fs.rmSync 删 4000 个约 8 秒）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINARY_TAG, EDIT_NEW, EDIT_OLD, MANY_FILES_MAX, WRITE_CONTENT, binaryBytes, manyFileName,
  writtenText } from '../replies.mjs';
import { call, chain, handoff, say, when } from '../steps.mjs';

export { BINARY_TAG, EDIT_NEW, EDIT_OLD, MANY_FILES_MAX, WRITE_CONTENT, binaryBytes, manyFileName, writtenText };

/** 套件要比较的文字 */
export const GIT_TEXT = {
  /** 立项登记的需求（标题带 tb-scenario：订阅实例的请求里只有需求标题能认出脚本，§17.1） */
  title: 'Git check tb-scenario:fs-git',
  goal: 'The files are changed',
  /** 立项建的 task */
  taskTitle: 'Change the files',
  /** 立项每次投递的回复 */
  handled: 'Handled this git message.',
  /** task 实例交接的结论 */
  conclusion: 'The files were changed',
  /** 结案关闭需求的结论 */
  requestDone: 'Git request done',
  /** 结案的回复 */
  closed: 'Closed the git request.',
  /** 分开时对话的回复 */
  dialog: 'Chat git reply.',
  /** 关闭模式对话的回复 */
  off: 'Off mode git reply.',
  /** 临时提问的回答 */
  answer: 'Answer from the git question.',
  /** 订阅的回复 */
  seen: 'Seen the git moment.',
  /** 对你不在时的提醒的回复 */
  reminded: 'Noted the git reminder.',
  /** gitStep.submit 登记的、一直不关的需求（FS-18，见文件开头第三节；标题带 tb-scenario 同 title） */
  openTitle: 'Open git check tb-scenario:fs-git',
  openGoal: 'Stay open',
  /** gitOpenRequest 里推迟的那一段的文字（在它出来之前按停止） */
  deciding: 'Deciding.',
};

/** 认脚本的标记（消息的最后一行） */
export const GIT_SCENARIO = 'tb-scenario:fs-git';

/**
 * @brief 脚本 fs-git 的一条消息：每个 [key, 步骤] 一行（步骤是数组时以 " ;; " 相接，即 chain 的几段），最后一行是
 *        GIT_SCENARIO。
 * @param rows 例如 [['git-task', [gitStep.edit('notes.md', 'hello', 'hi'), gitStep.run('echo x > b.txt')]]]
 */
export const gitMessage = (rows) => `${rows.map(([key, steps]) => `${key}: ${[steps].flat().join(' ;; ')}`)
  .join('\n')}\n${GIT_SCENARIO}`;

/** @brief 关键词链（关键词模式下一轮里的几步）："steps: a ;; b ;; c"。 */
export const keywordSteps = (...steps) => `steps: ${steps.flat().join(' ;; ')}`;

/**
 * 一步的写法（规则见 server.mjs 开头）。write、edit、remove、binary、many、run、sleep、submit 单独就是关键词模式的
 * 一条消息，也能作 keywordSteps 的一步、gitMessage 行值的一段；say 只在 keywordSteps 与 gitMessage 的行值里认
 * （单独发 "say: x" 不认）；hold(ms, step) 能作链的一步、行值的一段，单独作一条消息时当作只有这一步的关键词链
 * （replies.mjs HELD），这时 step 也可以是 say。
 */
export const gitStep = Object.freeze({
  /** @brief 写文件，内容为 writtenText(text)。 */
  write: (path, text) => `write file: ${path} :: ${text}`,
  /** @brief 把文件里的 from 换成 to（edit 工具）。 */
  edit: (path, from, to) => `edit file: ${path} :: ${from} => ${to}`,
  /** @brief 用 bash 删掉文件。 */
  remove: (path) => `run: rm '${path}'`,
  /** @brief 用 bash 写二进制文件，内容为 binaryBytes(tag)。 */
  binary: (path, tag = BINARY_TAG) => `binary file: ${path} :: ${tag}`,
  /** @brief 一条 bash 命令在 dir 里建 n 个文件（manyFileName(0..n-1)）。 */
  many: (dir, n) => `many files: ${dir} ${n}`,
  /** @brief 任意 bash 命令。 */
  run: (command) => `run: ${command}`,
  /** @brief bash 在跑 seconds 秒（sleep）。 */
  sleep: (seconds) => `run: sleep ${seconds}`,
  /** @brief 只回文字（链里，或 fs-git 行值的一段）；这次运行在这一步结束。 */
  say: (text) => `say: ${text}`,
  /** @brief 修饰：这一步的回复推迟 ms 毫秒（运行在这期间一直在跑）。 */
  hold: (ms, step) => `[wait ${ms}] ${step}`,
  /** @brief 登记一个需求（call tool: request_submit，协作模式下立项用；FS-18）。 */
  submit: (title = GIT_TEXT.openTitle, goal = GIT_TEXT.openGoal) => `call tool: request_submit ${JSON.stringify({
    title, goal })}`,
});

/**
 * @brief FS-18 的消息（文件系统第 2 步，见文件开头第三节）：合并会话的立项登记 GIT_TEXT.openTitle，再推迟 ms 毫秒回
 *        GIT_TEXT.deciding；套件在推迟期间按停止，需求就一直是 open、没有运行。
 * @param ms 推迟的毫秒数
 */
export const gitOpenRequest = (ms = 30000) => gitMessage([['git-create', [gitStep.submit(),
  gitStep.hold(ms, gitStep.say(GIT_TEXT.deciding))]]]);

/**
 * @brief App 测试自己（不经过模型）在 dir 里写 n 个小文件，文件名与内容同 many files:（manyFileName(i)，内容
 *        `${i + 1}\n`）；FS-10 用它让开始快照自己的 git add 跑得久（见文件开头第一节）。
 * @param dir 目录的绝对路径（没有时建出来）
 * @param n 文件数
 */
export function writeManyFiles(dir, n) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i += 1) writeFileSync(join(dir, manyFileName(i)), `${i + 1}\n`);
}

/** 一直开着的会话的投递数上限（每次投递同样的步骤；协作模式下每个 [Mori] 投递也算一次） */
const MAX_DELIVERIES = 24;
/** 只在最后一次投递里找行 */
const LAST = { last: true };

/** @brief k = 1..MAX_DELIVERIES 每次投递都是 steps。 */
const everyDelivery = (steps) => Object.fromEntries(Array.from({ length: MAX_DELIVERIES }, (_, i) => [i + 1, steps]));

/** task 实例交接（done） */
const TASK_DONE = { task: '{task}', conclusion: GIT_TEXT.conclusion, outcome: 'done' };
/** 结案关闭交来的 task */
const CLOSE_DONE = { task: '{task}', conclusion: 'Checked and closed', outcome: 'close_done' };
/** 结案关闭需求 */
const REQUEST_DONE = { request: '{request}', outcome: 'done', conclusion: GIT_TEXT.requestDone };

/**
 * @brief 立项（合并会话或分开时的立项）：这次投递有 git-task 行时登记需求、建 task（编号取刚登记的），有 git-create
 *        行时一段一段做它，再回 handled。
 * @param role 角色（mori 或 planner）
 * @param kind merged-create 或 create
 * @param assignee task 的角色
 */
const creator = (role, kind, assignee) => ({ role, kind, deliveries: everyDelivery([
  when('git-task', call('request_submit', { title: GIT_TEXT.title, goal: GIT_TEXT.goal }), LAST),
  when('git-task', call('task_create', { request: '{submitted}', title: GIT_TEXT.taskTitle, assignee,
    read_only: false, description: 'git-task: {lastLine:git-task}' }), LAST),
  chain('git-create', LAST), say(GIT_TEXT.handled), say(GIT_TEXT.reminded),
]) });

/** @brief task 实例：git-task 的几段，再交接；k = 2、3 是强制填写与格式重试。 */
const worker = (role) => ({ role, kind: 'task', deliveries: {
  1: [chain('git-task'), call('task_handoff', TASK_DONE), say(GIT_TEXT.reminded)],
  2: [handoff(TASK_DONE)],
  3: [handoff(TASK_DONE)],
} });

/** @brief 结案：关闭交来的 task 与需求；k = 2 强制填写，k = 3 强制关闭。 */
const closer = (role) => ({ role, kind: 'close', deliveries: {
  1: [call('task_handoff', CLOSE_DONE), call('request_close', REQUEST_DONE), say(GIT_TEXT.closed),
    say(GIT_TEXT.reminded)],
  2: [handoff(CLOSE_DONE)],
  3: [handoff(REQUEST_DONE)],
} });

/** @brief 一直开着的会话：每次投递里有 key 那一行时一段一段做它，再回 text（对话）。 */
const chainEach = (role, kind, key, text) => ({ role, kind,
  deliveries: everyDelivery([chain(key, LAST), say(text), say(GIT_TEXT.reminded)]) });

export const SCENARIOS = {
  // 协作模式下 task 用 edit 与 bash 改文件、同一会话里几条带 git-task 的消息、关掉协作模式后对话自己改（见文件开头）
  'fs-git': [
    creator('mori', 'merged-create', 'mori'),
    creator('planner', 'create', 'executor'),
    worker('mori'),
    worker('executor'),
    closer('mori'),
    closer('planner'),
    chainEach('chat', 'team-dialog', 'git-dialog', GIT_TEXT.dialog),
    { role: '*', kind: 'ask', deliveries: { 1: [say(GIT_TEXT.answer), say(GIT_TEXT.reminded)] } },
    { role: '*', kind: 'subscription', deliveries: everyDelivery([say(GIT_TEXT.seen), say(GIT_TEXT.reminded)]) },
    chainEach('*', 'off-dialog', 'git-off', GIT_TEXT.off),
    chainEach('*', 'dialog', 'git-off', GIT_TEXT.off),
  ],
};
