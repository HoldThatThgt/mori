// 合成端点（synthetic）的脚本：tests/ui/tb-app-handoff.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-14 交接路由、TB-15 一回合一次交接、TB-16 证据、TB-17 改过代码不能给自己写通过、TB-18 强制填写、TB-19 兜底交给结案、
// TB-20 需要用户拿主意、TB-31 结案与需求关闭），格式见 scripts.mjs 开头；名字都以 tb-handoff- 开头。
// 每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是那条会话里的投递序号。
// 三个临时项目（测试准备，synthetic test setup）：分开配置（chat / planner 持有立项与结案 / executor / reviewer，
// 全部用 A 级模型）、写入等级配置（chat / planner 立项 / closer 结案用 C 级模型 / 每种等级一个 exec-* 角色）、
// 没有角色文件（合并会话）。几个 task 先后交给结案时用 wait 错开（每段 3 秒），让结案会话一次只收到一个 task。
// 这里另外导出套件要比较的文字（HANDOFF_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, end, fail, handoff, say, together, wait } from '../steps.mjs';

/** 套件要比较的文字 */
export const HANDOFF_TEXT = {
  /** TB-14 need_user 的问题（同时写了 next） */
  routeQuestion: 'Should T5 keep the old wording?',
  /** TB-14 结案交给立项的问题 */
  closeQuestion: 'Which of the two fixes should T4 keep?',
  /** TB-20 executor 的问题 */
  needQuestion: 'Which section should I summarize?',
  /** TB-20 你的回答 */
  needAnswer: 'Use section two, please',
  /** TB-20 reviewer 的问题 */
  reviewQuestion: 'Should I accept the change as it is?',
  /** TB-20 你对 reviewer 的回答 */
  reviewAnswer: 'Yes, accept it as it is',
  /** TB-20 合并会话里问你的回复 */
  mergedAsk: 'T1 needs your decision: which part of the README matters?',
  /** TB-19 没交接的运行最后一段文字（程序写的一棒的结论） */
  lastText: 'I could not hand it off.',
  /** TB-31 失败关闭的结论（已排除的方案） */
  ruledOut: 'Approach one was ruled out',
  /** TB-17 edit 的参数 */
  edit: { path: 'src/a.ts', edits: [{ oldText: 'return a + b;', newText: 'return b + a;' }] },
};

/** @brief 一个只读 task（request 1，limits: { write: false }）。 */
const task = (title, assignee, extra = {}) => call('task_create', { request: 1, title, description: title, assignee,
  limits: { write: false }, ...extra });
/** @brief 一个写 task（request 1，不带 limits）。 */
const writeTask = (title, assignee) => call('task_create', { request: 1, title, description: title, assignee });
/** @brief 登记需求 1。 */
const submit = (title) => call('request_submit', { title, goal: `${title}, as the user asked` });
/** @brief 读一个文件。 */
const read = (path = 'README.md') => call('read', { path });
/** @brief task 实例的交接（task 取会话的 task）。 */
const pass = (outcome, conclusion, extra = {}) => call('task_handoff', { task: '{task}', conclusion, outcome,
  ...extra });
/** @brief 一次 read，再带它的证据交接。 */
const readThen = (outcome, conclusion, extra = {}) => [read(), pass(outcome, conclusion,
  { evidence: ['{tag:read}'], ...extra })];
/** @brief 结案的交接。 */
const decide = (taskId, outcome, conclusion, extra = {}) => call('task_handoff', { task: taskId, conclusion, outcome,
  ...extra });
/** @brief request_close。 */
const closeRequest = (outcome, conclusion) => call('request_close', { request: 1, outcome, conclusion });
/** @brief k = 1..n 每次投递都是同样的步骤。 */
const every = (n, steps) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, steps]));

/**
 * 通用的结案：关闭这次投递里第一个 task，再试着关闭需求（还有没结束的 task 时被拒绝）；强制填写的运行里
 * 表单工具之外的那个调用被拒绝。结案的输出不是这些场景要验的。
 */
const GENERIC_CLOSE = every(12, [together(decide('{task}', 'close_done', 'Closed by the script'),
  call('request_close', { request: '{request}', outcome: 'done', conclusion: 'Every task was handed off' })),
say('Checked.')]);
/** 通用的对话：每次投递回一句 */
const GENERIC_CHAT = every(8, [say('Noted.')]);
/** 通用的程序唤醒的立项回合：什么都不做 */
const IDLE_CREATE = (from, to) => Object.fromEntries(Array.from({ length: to - from + 1 },
  (_, i) => [from + i, [say('Nothing to do here.')]]));

/** 强制填写用的交接单 */
const TASK_FORM = { task: '{task}', conclusion: 'Filled by the forced turn', outcome: 'done' };
const CLOSE_FORM = { task: '{task}', conclusion: 'Decided in the forced turn', outcome: 'close_done' };
const REQUEST_FORM = { request: '{request}', outcome: 'done', conclusion: 'Closed in the forced turn' };

/** @brief 写入等级配置里 task 不交接就结束（第一次投递），之后由强制填写处理。 */
const readEnd = () => [read(), end()];

export const SCENARIOS = {
  // TB-14 task 实例的路由（§7.1 表的前四行，按顺序）：T1 done、T2 pass、T3 blocked 都写了 next 仍交结案（记为建议）；
  // T4 continue → reviewer、dead_end → executor、fail → reviewer（写了 next 的三种结果），reviewer 没写 next → 结案；
  // T5 need_user 同时写了 next → 立项（next 记为建议）。立项什么都不做，程序请对话问你。
  'tb-handoff-route': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Route five tasks'), task('Done with next', 'executor'), task('Pass with next', 'executor'),
        task('Blocked with next', 'executor'), task('Relay chain', 'executor'), task('Ask the user', 'executor'),
        say('Registered request 1 with five tasks.')],
      ...IDLE_CREATE(2, 4),
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: readThen('done', 'T1 is done', { next: 'reviewer' }) } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(3000), read()), pass('pass', 'T2 passes', { next: 'reviewer', evidence: ['{tag:read}'] })] } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [together(wait(6000), read()), pass('blocked', 'T3 is blocked', { next: 'reviewer' })] } },
    { role: 'executor', kind: 'task', task: 'T4', deliveries: {
      1: [together(wait(9000), read()), pass('continue', 'T4 half done', { next: 'reviewer' })],
      2: [read(), pass('fail', 'T4 still fails', { next: 'reviewer' })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T4', deliveries: {
      1: [read(), pass('dead_end', 'T4 approach is a dead end', { next: 'executor' })],
      2: [read(), pass('continue', 'T4 reviewed, no next')],
    } },
    { role: 'executor', kind: 'task', task: 'T5', deliveries: {
      1: [together(wait(13000), read()), pass('need_user', HANDOFF_TEXT.routeQuestion, { next: 'reviewer' })] } },
    { role: 'planner', kind: 'close', deliveries: GENERIC_CLOSE },
  ],

  // TB-14 结案会话的四种结果：T1 continue 没写 next 被拒绝，continue + next reviewer 改派；T2 close_done；T3 close_failed；
  // T4 need_user → 立项（立项什么都不做）；T1 从 reviewer 回来后 close_done。
  'tb-handoff-closeres': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Four close results'), task('Reassign me', 'executor'), task('Close me done', 'executor'),
        task('Close me failed', 'executor'), task('Ask about me', 'executor'), say('Registered request 1.')],
      ...IDLE_CREATE(2, 4),
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('done', 'T1 first pass') } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(3000), read()), pass('done', 'T2 done', { evidence: ['{tag:read}'] })] } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [together(wait(6000), read()), pass('done', 'T3 done', { evidence: ['{tag:read}'] })] } },
    { role: 'executor', kind: 'task', task: 'T4', deliveries: {
      1: [together(wait(9000), read()), pass('done', 'T4 done', { evidence: ['{tag:read}'] })] } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(10000), read()), pass('pass', 'T1 verified', { evidence: ['{tag:read}'] })] } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [decide('T1', 'continue', 'Needs a review'), decide('T1', 'continue', 'Needs a review', { next: 'reviewer' }),
        say('T1 goes to reviewer.')],
      2: [decide('T2', 'close_done', 'T2 is fine'), say('T2 closed.')],
      3: [decide('T3', 'close_failed', 'T3 did not work'), say('T3 closed as failed.')],
      4: [decide('T4', 'need_user', HANDOFF_TEXT.closeQuestion), say('Asked about T4.')],
      5: [decide('T1', 'close_done', 'T1 verified by reviewer'), say('T1 closed.')],
    } },
  ],

  // TB-15 一回合一次交接：T1 [task_handoff, read] 一批，read 被拒绝且这批之后没有请求；T2 [read, task_handoff] 一批，
  // 端点再收到一次请求，里面的两个 read 都被拒绝，之后没有请求。结案一次运行里关闭 T1、T2 并关闭需求（第一个请求等 5 秒，
  // 让 T2 在这次运行里交过来）。
  'tb-handoff-once': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('One handoff per turn'), task('Hand off then read', 'executor'),
        task('Read then hand off', 'executor'), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [read(), together(pass('done', 'T1 read README', { evidence: ['{tag:read}'] }), read('src/a.ts'))],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(1500), read(), pass('continue', 'T2 read README')), together(read('src/a.ts'), read()),
        say('This request should never be sent.')],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [together(wait(5000), decide('T1', 'close_done', 'T1 is fine')), decide('T2', 'close_done', 'T2 is fine'),
        closeRequest('done', 'Both reads are done'), say('Closed T1, T2 and request 1.')],
    } },
  ],

  // TB-19 运行中才交给结案的 task 不算没处理：结案第一次运行等 5 秒，T2 在这期间交过来；它只关闭 T1，
  // T2 不强制填写，下一次运行收到 T2 的普通投递。
  'tb-handoff-midrun': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Two reads'), task('First read', 'executor'), task('Second read', 'executor'),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('done', 'First read done') } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(2000), read()), pass('done', 'Second read done', { evidence: ['{tag:read}'] })] } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [together(wait(5000), decide('T1', 'close_done', 'First read is fine')), say('T1 closed; T2 is next.')],
      2: [decide('{task}', 'close_done', 'Second read is fine'), closeRequest('done', 'Both reads are done'),
        say('Request 1 closed.')],
    } },
  ],

  // TB-16 证据、TB-17 改过代码不能给自己写通过（分开配置，全部允许）：T1 六个工具结果（#3 是失败的命令）后，
  // 不存在的编号、没有证据、只有失败的证据（done、pass）被拒绝，fail 引用失败的命令被接受；T2（依赖 T1）引用 T1 会话里的
  // #5 被拒绝；T3 edit、T4 write 之后写 pass 被拒绝、done 被接受；T5 只跑过命令，pass 被接受。
  'tb-handoff-evidence': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Check the evidence rules'),
        writeTask('Probe evidence', 'executor'),
        task('Cite another session', 'executor', { depends_on: ['T1'] }),
        writeTask('Edit then pass', 'executor'),
        writeTask('Write then pass', 'executor'),
        writeTask('Command then pass', 'executor'),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [read(), read('src/a.ts'), call('bash', { command: 'exit 3' }), read(), read('src/a.ts'), read(),
        pass('done', 'Probe', { evidence: ['#99'] }),
        pass('done', 'Probe', { evidence: [] }),
        pass('done', 'Probe', { evidence: ['#3'] }),
        pass('pass', 'Probe', { evidence: ['#3'] }),
        pass('fail', 'exit 3 fails as expected', { evidence: ['#3', '[#1]'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [read(), read('src/a.ts'), pass('done', 'Cited', { evidence: ['#5'] }),
        pass('done', 'Cited my own', { evidence: ['1'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [call('edit', HANDOFF_TEXT.edit), pass('pass', 'Edited and verified', { evidence: ['{tag:edit}'] }),
        pass('done', 'Edited', { evidence: ['{tag:edit}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T4', deliveries: {
      1: [call('write', { path: 'notes.txt', content: 'notes from T4\n' }),
        pass('pass', 'Wrote and verified', { evidence: ['{tag:write}'] }),
        pass('done', 'Wrote notes', { evidence: ['{tag:write}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T5', deliveries: {
      1: [call('bash', { command: 'echo checked' }), pass('pass', 'The command passes', { evidence: ['{tag:bash}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: GENERIC_CLOSE },
  ],

  // TB-16 只有执行了的调用有编号（§7.3）：T1 read（#1）、参数校验失败的 read（没有 path，pi 不执行，没有编号）、
  // 引用 #2 的交接被拒绝（#2 还不存在；这个被拒绝的交接执行了，它的结果是 #2）、引用 #1 的交接被接受（#3）。
  // T2 读一次就结束（不交接）→ 强制填写的运行里调 read 被 tool_call 处理器拒绝（没有编号）→ 重试时引用 #2 被拒绝
  // （只有 #1）→ 程序写一棒交给结案。
  'tb-handoff-tags': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Number executed calls'), task('Invalid call', 'executor'), task('Blocked call', 'executor'),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [read(), call('read', {}), pass('done', 'Cite the invalid call', { evidence: ['#2'] }),
        pass('done', 'README read', { evidence: ['#1'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(3000), read()), end()],
      2: [read('src/a.ts')],
      3: [handoff({ ...TASK_FORM, evidence: ['#2'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: GENERIC_CLOSE },
  ],

  // TB-16 重新打开后继续编号（合并会话）：T1 两个工具结果后第三个请求等很久，这时重启 Mori；重新打开后你说继续，
  // 立项交回 T1，同一条实例会话里下一个工具结果是 #3。
  'tb-handoff-renum': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [submit('Read slowly'), task('Read twice', 'mori'), say('Registered request 1.')],
      2: [call('task_edit', { task: 'T1' }), say('Handed T1 back.')],
      3: [say('Request 1 is done.')],
    } },
    { role: 'mori', kind: 'dialog', deliveries: { 3: [say('Request 1 is done.')] } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [read(), read('src/a.ts'), together(wait(120000), read()), say('Too late.')],
      2: readThen('done', 'Read after the restart'),
    } },
    { role: 'mori', kind: 'close', deliveries: {
      1: [decide('T1', 'close_done', 'Read'), closeRequest('done', 'Read after the restart'), say('Closed.')],
    } },
  ],

  // TB-20 need_user（分开配置）：executor 问 → 立项被唤醒、reply_via_dialog → 对话问你（relay，不显示）→ 你的回答经立项
  // 记为补充并交回 → executor 的会话继续，工作卡里有补充 → 完成。
  'tb-handoff-need': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Summarize a section'), task('Summarize', 'executor'), say('Registered request 1.')],
      2: [call('reply_via_dialog', { note: `Ask the user: ${HANDOFF_TEXT.needQuestion}` }),
        say('Asked chat to ask the user.')],
      3: [call('request_update', { request: 1 }), call('task_edit', { task: 'T1' }),
        say('Added the answer and handed T1 back.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')],
      2: [say(`Question for you: ${HANDOFF_TEXT.needQuestion}`)],
      3: [say('Thanks, passing it on.')],
      4: [say('Request 1 is done: section two is summarized.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [read(), pass('need_user', HANDOFF_TEXT.needQuestion)],
      2: [together(wait(1500), read()), pass('done', 'Summarized section two', { evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [decide('T1', 'close_done', 'Section two summarized'), closeRequest('done', 'Section two is summarized'),
        say('Closed.')],
    } },
  ],

  // TB-20 reviewer 提问（分开配置）：executor → reviewer，reviewer need_user → 立项什么都不做 → 程序请对话问你
  // （Needs your decision）→ 你的回答经立项交回 reviewer → reviewer 的会话继续、pass。
  'tb-handoff-review': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Review a change'), task('Change and review', 'executor'), say('Registered request 1.')],
      2: [say('I will leave this to the user.')],
      3: [call('request_update', { request: 1 }), call('task_edit', { task: 'T1' }), say('Handed T1 back.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')],
      2: [say(`T1 needs your decision: ${HANDOFF_TEXT.reviewQuestion}`)],
      3: [say('Thanks, passing it on.')],
      4: [say('Request 1 is done: the change was accepted.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [read(), pass('continue', 'Change ready for review', { next: 'reviewer' })] } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [read(), pass('need_user', HANDOFF_TEXT.reviewQuestion)],
      2: [together(wait(1500), read()), pass('pass', 'Accepted as it is', { evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [decide('T1', 'close_done', 'Accepted'), closeRequest('done', 'The change was accepted'), say('Closed.')],
    } },
  ],

  // TB-20 默认配置（合并会话）下 need_user 只问你一次：T1 need_user → 一次不显示的 create_wake，回复就是问你。
  'tb-handoff-mergedneed': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [submit('Read the README'), task('Read README', 'mori'), say('Registered request 1.')],
      2: [say(HANDOFF_TEXT.mergedAsk)],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [read(), pass('need_user', 'Which part of the README matters?')] } },
  ],

  // TB-19 没交接（§7.4 第 1 行，含 next 写错被参数校验拒绝后没改正）与 TB-18 格式错误重试：强制填写两次都格式错误，
  // 端点日志里恰好两次强制写法的请求，之后程序写一棒交给结案，结论是没交接那次运行的最后一段文字。
  'tb-handoff-nohandoff': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('A task that does not hand off'), task('Forget the handoff', 'executor'),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [read(), pass('continue', 'Handing to nobody', { next: 'nobody' }), say(HANDOFF_TEXT.lastText)],
      2: [handoff(TASK_FORM, { malformed: true }), say('Still no handoff.')],
      3: [handoff(TASK_FORM, { malformed: true }), say('No handoff again.')],
    } },
    { role: 'planner', kind: 'close', deliveries: GENERIC_CLOSE },
  ],

  // TB-19 依赖失败与 TB-18 结案的 A 级强制填写：T1 dead_end → 结案第一次运行没决定 → 强制填写一次（close_failed）→
  // 依赖 T1 的 T2 交给结案（dependency_failed）→ 结案关闭 T2 与需求。
  'tb-handoff-depfail': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Try then build'), task('Try approach one', 'executor'),
        task('Build on it', 'executor', { depends_on: ['T1'] }), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('dead_end', 'Approach one is stuck') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [say('Let me think about T1 later.')],
      2: [handoff({ task: '{task}', conclusion: 'Approach one does not work', outcome: 'close_failed' })],
      3: [decide('{task}', 'close_failed', 'Nothing to build on'), closeRequest('failed', 'Approach one failed'),
        say('Request 1 closed as failed.')],
    } },
  ],

  // TB-19 结案没处理（§7.4 最后一行）：结案的运行没决定 T1 → 强制填写两次都格式错误 → T1 交给立项（need_user，
  // 问题为 planner didn’t decide on T1）→ 立项什么都不做 → 程序请对话问你。
  'tb-handoff-undecided': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('A read for close'), task('Simple read', 'executor'), say('Registered request 1.')],
      ...IDLE_CREATE(2, 3),
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('done', 'README read') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [say('Not deciding T1 now.')],
      2: [handoff(CLOSE_FORM, { malformed: true }), say('I could not decide.')],
      3: [handoff(CLOSE_FORM, { malformed: true }), say('Still undecided.')],
    } },
  ],

  // TB-18 各写入等级的强制填写（写入等级配置）：每个 exec-* 角色读一次就结束（不交接），强制填写按它的模型的等级。
  // 被拒绝的调用的结果没有编号（pi 不对它们调 tool_result 钩子），所以 T2 重试时直接写 #1。
  // T1 A（交接 continue + next → 结案，next 记为建议）；T2 A 不能关思考 → B，第一次强制运行里调 read 被拒绝并结束，
  // 重试时交出 JSON；T3 A 不能关思考、B 也不过 → C；T4 B；T5 C；T6 没有等级（不强制填写）；T7 强制运行的第一个请求在
  // A 级模型上 404，换到 B 级模型按 B；T8 A 级填写 done 没有证据被拒绝，这次运行没有第二个请求，重试时带证据。
  'tb-handoff-tiers': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Force every tier'), task('Tier A', 'exec-a'), task('A without thinking off', 'exec-anod'),
        task('A, B fails', 'exec-anodc'), task('Tier B', 'exec-b'), task('Tier C', 'exec-c'),
        task('No tier', 'exec-none'), task('Switch on the first request', 'exec-sw'),
        task('Evidence in the forced turn', 'exec-a'), say('Registered request 1 with eight tasks.')],
      ...IDLE_CREATE(2, 4),
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'exec-a', kind: 'task', task: 'T1', deliveries: {
      1: readEnd(), 2: [handoff({ ...TASK_FORM, outcome: 'continue', next: 'exec-b' })] } },
    { role: 'exec-anod', kind: 'task', task: 'T2', deliveries: {
      1: readEnd(), 2: [read('src/a.ts'), say('Read instead of handing off.')],
      3: [handoff({ ...TASK_FORM, evidence: ['#1'] })] } },
    { role: 'exec-anodc', kind: 'task', task: 'T3', deliveries: {
      1: readEnd(), 2: [handoff({ ...TASK_FORM, outcome: 'continue', next: 'exec-a', open_items: ['One more check'] })],
    } },
    { role: 'exec-b', kind: 'task', task: 'T4', deliveries: {
      1: readEnd(), 2: [handoff({ ...TASK_FORM, evidence: ['{tag:read}'] })] } },
    { role: 'exec-c', kind: 'task', task: 'T5', deliveries: {
      1: readEnd(), 2: [handoff({ ...TASK_FORM, evidence: ['{tag:read}'] })] } },
    { role: 'exec-none', kind: 'task', task: 'T6', deliveries: { 1: [read(), say('No tier, no handoff.')] } },
    { role: 'exec-sw', kind: 'task', task: 'T7', deliveries: {
      1: readEnd(), 2: [together(fail(404, { model: 'fake-tbx-sw1' }),
        handoff({ ...TASK_FORM, evidence: ['{tag:read}'] }))] } },
    { role: 'exec-a', kind: 'task', task: 'T8', deliveries: {
      1: readEnd(), 2: [handoff(TASK_FORM)], 3: [handoff({ ...TASK_FORM, evidence: ['{tag:read}'] })] } },
    { role: 'closer', kind: 'close', deliveries: GENERIC_CLOSE },
  ],

  // TB-18 结案与强制关闭的 C 级标签（写入等级配置，结案 closer 用 C 级模型）：结案没决定 T1 → 强制填写（标签）→
  // T1 关闭；全部结束后结案没关闭 → 强制关闭（标签）→ 需求关闭。
  'tb-handoff-closec': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Close with tags'), task('One read', 'exec-a'), say('Registered request 1.')] } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'exec-a', kind: 'task', task: 'T1', deliveries: { 1: readThen('done', 'README read') } },
    { role: 'closer', kind: 'close', deliveries: {
      1: [say('I will decide later.')],
      2: [handoff({ ...CLOSE_FORM, conclusion: 'Decided by tags' })],
      3: [say('Not closing yet.')],
      4: [handoff({ ...REQUEST_FORM, conclusion: 'Closed by tags' })],
    } },
  ],

  // TB-19 出错与候选耗尽（写入等级配置）：T1 的请求以 400 结束（出错，结论是错误原文）；T2 的角色只有一个模型，它 404
  // 之后没有别的候选（no_model，结论是各候选被排除的原因）。
  'tb-handoff-errors': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Two failing tasks'), task('Fails with 400', 'exec-a'), task('No model left', 'exec-gone'),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'exec-a', kind: 'task', task: 'T1', deliveries: {
      1: [fail(400)] } },
    { role: 'exec-gone', kind: 'task', task: 'T2', deliveries: {
      1: [fail(404)] } },
    { role: 'closer', kind: 'close', deliveries: GENERIC_CLOSE },
  ],

  // TB-31 request_close 在有未结束的 task 时被拒绝、已排除的方案、需求关闭后对话汇报（分开配置）。
  'tb-handoff-close': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Two approaches'), task('Approach one', 'executor'), task('Approach two', 'executor'),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')],
      2: [say('Request 1 is done: approach two works.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('dead_end', 'Approach one is stuck') } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(5000), read()), pass('done', 'Approach two works', { evidence: ['{tag:read}'] })] } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [decide('T1', 'close_failed', HANDOFF_TEXT.ruledOut), closeRequest('done', 'Too early'),
        say('T2 is still running.')],
      2: [decide('T2', 'close_done', 'Approach two works'), closeRequest('done', 'Approach two works'),
        say('Request 1 closed.')],
    } },
  ],

  // TB-31 结案不关闭 → 强制关闭（两次都格式错误）→ 需求级问题交给立项 → 立项什么都不做 → 程序请对话问你。
  'tb-handoff-forceclose': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Close it for me'), task('Only task', 'executor'), say('Registered request 1.')],
      ...IDLE_CREATE(2, 3),
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')],
      2: [say('Request 1 needs your decision: it has no open tasks and was not closed.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('done', 'Only task done') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [decide('{task}', 'close_done', 'Only task is fine'), say('T1 closed.')],
      2: [say('I will not close it yet.')],
      3: [handoff(REQUEST_FORM, { malformed: true }), say('Could not close.')],
      4: [handoff(REQUEST_FORM, { malformed: true }), say('Still could not close.')],
    } },
  ],

  // TB-31 结案请立项建 task 而立项没建：结案关闭 T1 并请 planner 再建 task（等回复）→ 立项不建 → 结案再被唤醒一次
  // （planner made no new tasks）→ 那次回合结束时强制关闭 → 需求关闭。
  'tb-handoff-closeask': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Maybe more work'), task('First part', 'executor'), say('Registered request 1.')],
      2: [say('No more tasks are needed.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')],
      2: [say('Request 1 is done: one part was enough.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('done', 'First part done') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [decide('T1', 'close_done', 'First part is fine'),
        call('agent_message', { to: 'planner', request: 1, wait: true, text: 'Request 1 may need one more task.' }),
        say('Asked planner for more.')],
      2: [say('Still open.')],
      3: [handoff({ ...REQUEST_FORM, conclusion: 'Only one part was needed' })],
    } },
  ],

  // TB-31 §7.6 的竞争：结案关闭最后一个 task（"全部已结束"的唤醒排进结案的队列）并给 planner 发消息但不等（没有 wait）；
  // 结案被"全部已结束"唤醒的那次回合在立项还在处理这条消息时结束 → 不强制关闭；立项的运行结束、没建 task → 结案再被
  // 唤醒一次（planner made no new tasks）→ 那次回合结束时强制关闭 → 需求关闭。立项处理消息的那次请求等 6 秒。
  'tb-handoff-closerace': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [submit('Race the close'), task('Only part', 'executor'), say('Registered request 1.')],
      2: [together(wait(6000), say('No more tasks are needed.'))],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: GENERIC_CHAT },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThen('done', 'Only part done') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [decide('T1', 'close_done', 'Only part is fine'),
        call('agent_message', { to: 'planner', request: 1, text: 'Request 1 may need one more task.' }),
        say('Told planner.')],
      2: [say('Waiting for planner.')],
      3: [say('Still open.')],
      4: [handoff({ ...REQUEST_FORM, conclusion: 'One part was enough' })],
    } },
  ],
};
