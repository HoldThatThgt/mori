// 合成端点（synthetic）的脚本：tests/ui/tb-app-sched.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-22 同时运行上限、TB-23 写入排队、TB-24 只读 task、TB-25 依赖、TB-26 补充到达正在做的实例、TB-32 撤销需求、
// TB-51 投递队列），格式见 scripts.mjs 开头；名字都以 tb-sched- 开头。每个场景在自己的用户会话里跑（脚本按请求里
// 第一个 tb-scenario 认），k 是那条会话里的投递序号。
// 结案会话的投递可能合并（§8.2），所以除了 TB-51 合并那一步，结案每次运行都把这个场景里可能交给它的 task 逐个交接一遍
// （不在它那里的被拒绝，无害），最后试一次 request_close（还有未结束的 task 时被拒绝）：不依赖投递到达的先后。
// 这里另外导出套件要比较的文字（SCHED_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, fail, say, together, wait } from '../steps.mjs';

/** 套件要比较的文字与模型 id */
export const SCHED_TEXT = {
  /** TB-25：T1 最后一棒（executor）的结论与结案的关闭结论 */
  depWork: 'The cause is in a.ts',
  depClosed: 'Cause confirmed',
  /** TB-26：实例运行中你补充的原话 */
  update: 'Also check the tests folder before you finish',
  /** TB-51：task 等你拿主意的两个问题 */
  askT1: 'Which file should I read?',
  askT2: 'Which section should I check?',
  /** TB-51：在立项运行中你发的消息 */
  userFirst: 'Read README.md first',
  /** TB-51：段开始时选不到模型那一步的三个模型（synthetic）：X 在立项的请求上 404（之后不可用），Y 窗口小 */
  modelX: 'fake-x-tbsched',
  modelY: 'fake-y-tbsched',
  /** TB-24：只读 task 的说明改动（task_edit 同时写了 read_only: false） */
  roEdited: 'Look around again, and you may change files now',
};

/** @brief 一次 read（第一个回复前先等 ms），再带它的证据以 outcome 交接（task 实例）。 */
const readThenHandoff = (conclusion, { outcome = 'done', ms = 0, path = 'README.md', next } = {}) => [
  together(wait(ms), call('read', { path })),
  call('task_handoff', { task: '{task}', conclusion, outcome, evidence: ['{tag:read}'], ...(next ? { next } : {}) }),
];

/**
 * @brief 结案的一次运行：按 outcomes 逐个交接（不在它那里的被拒绝），然后试 request_close，最后说一句。
 * @param outcomes task → [outcome, conclusion]
 * @param ms 第一个回复前多等的毫秒数
 */
const closeAll = (outcomes, ms = 0) => [
  ...Object.entries(outcomes).map(([task, [outcome, conclusion]], index) => together(wait(index === 0 ? ms : 0),
    call('task_handoff', { task, conclusion, outcome }))),
  call('request_close', { request: '{request}', outcome: 'done', conclusion: 'All tasks are settled' }),
  say('Closed what was with me.'),
];

/** @brief 每次投递都一样的回复：投递序号 1..n 都用 steps。 */
const every = (steps, n = 16) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, steps]));

/** @brief 分开配置里对话（chat）的回复：每次投递说一句。 */
const chatSays = { role: 'chat', kind: 'team-dialog', deliveries: every([say('Noted.')]) };

/** @brief 只读 task 的 task_create 参数。 */
const readTask = (title, assignee, extra = {}) => ({ request: 1, title, description: `${title} in README.md`,
  assignee, read_only: true, ...extra });

export const SCENARIOS = {
  // TB-22（合并会话，基座）：六个只读 task；T1 4 秒、T2 6 秒、T3 与 T4 12 秒、T5 5 秒、T6 2 秒。前四个在跑时 T5、T6 排队；
  // T1 结束后 T5 开始，T2 结束后 T6 开始。
  'tb-sched-cap': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Six reads', goal: 'Read README.md six times' }),
        ...[1, 2, 3, 4, 5, 6].map((n) => call('task_create', readTask(`Read ${n}`, 'mori'))),
        say('Registered request 1 with six tasks.')],
      ...Object.fromEntries([2, 3, 4, 5].map((k) => [k, [say('Request 1 is done.')]])),
    } },
    ...[[1, 4000], [2, 6000], [3, 12000], [4, 12000], [5, 5000], [6, 2000]].map(([n, ms]) => ({
      role: 'mori', kind: 'task', task: `T${n}`, deliveries: { 1: readThenHandoff(`Read ${n} done`, { ms }) } })),
    { role: 'mori', kind: 'close', deliveries: every(closeAll(Object.fromEntries([1, 2, 3, 4, 5, 6]
      .map((n) => [`T${n}`, ['close_done', `Read ${n} checked`]])))) },
  ],

  // TB-23（分开配置）：写 task T1（executor → reviewer 评审 → 结案）持有写入锁；写 task T2 等锁；只读的 T3 与 T1 同时跑。
  'tb-sched-lock': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Two edits', goal: 'Change README.md twice, in order' }),
        call('task_create', { request: 1, title: 'First edit', description: 'Edit README.md', assignee: 'executor',
          read_only: false }),
        call('task_create', { request: 1, title: 'Second edit', description: 'Edit README.md again',
          assignee: 'executor', read_only: false }),
        call('task_create', readTask('Count words', 'executor')),
        say('Registered request 1.')],
    } },
    chatSays,
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(3000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Edited the title', outcome: 'continue',
          next: 'reviewer' })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: readThenHandoff('The edit is right', { outcome: 'pass', ms: 4000 }),
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: { 1: readThenHandoff('Second edit done') } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: readThenHandoff('README has 20 words', { ms: 2500, path: 'src/a.ts' }),
    } },
    { role: 'planner', kind: 'close', deliveries: every(closeAll({ T1: ['close_done', 'First edit verified'],
      T2: ['close_done', 'Second edit verified'], T3: ['close_done', 'Counted'] }, 2500)) },
  ],

  // TB-24（分开配置，executor 的工具含 MCP）：写 task T1 与只读 T2；T2 第一个回复前等 6 秒，这期间你补充一句、立项
  // task_edit T2 改说明并写 read_only: false（参数被丢掉，T2 仍只读）。
  'tb-sched-readonly': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Look and write', goal: 'Look around, then write notes' }),
        call('task_create', { request: 1, title: 'Write notes', description: 'Write notes.md', assignee: 'executor',
          read_only: false }),
        call('task_create', readTask('Look around', 'executor')),
        say('Registered request 1.')],
      2: [call('request_update', { request: 1 }),
        call('task_edit', { task: 'T2', description: SCHED_TEXT.roEdited, read_only: false }),
        say('Updated T2.')],
    } },
    chatSays,
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThenHandoff('Notes written') } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(6000), call('read', { path: 'README.md' })),
        together(wait(500), call('read', { path: 'src/a.ts' })),
        call('task_handoff', { task: '{task}', conclusion: 'Looked around', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: every(closeAll({ T1: ['close_done', 'Notes are fine'],
      T2: ['close_done', 'Looked'] })) },
  ],

  // TB-25（分开配置）：T2 依赖 T1（reviewer）；T4 依赖 T3，T3 以失败关闭；T5 依赖 T2（12 秒）；立项第一次判断里
  // 自指与成环的 task_edit、跨需求的 task_create 被拒绝（需求 2 另有 T6）；你第二条消息时立项建依赖已失败的 T3 的 T7。
  'tb-sched-deps': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Fix in order', goal: 'Find the cause, then check the fix' }),
        call('task_create', readTask('Find the cause', 'executor')),
        call('task_create', readTask('Check the fix', 'reviewer', { depends_on: ['T1'] })),
        call('task_create', readTask('Try plan A', 'executor')),
        call('task_create', readTask('Check plan A', 'reviewer', { depends_on: ['T3'] })),
        call('task_create', readTask('Later step', 'executor', { depends_on: ['T2'] })),
        call('task_edit', { task: 'T5', depends_on: ['T5'] }),
        call('task_edit', { task: 'T2', depends_on: ['T1', 'T5'] }),
        call('request_submit', { title: 'Another thing', goal: 'Look at src' }),
        call('task_create', { request: 2, title: 'Across requests', description: 'Wait for T1 of request 1',
          assignee: 'executor', read_only: true, depends_on: ['T1'] }),
        call('task_create', { request: 2, title: 'Quick look', description: 'Read src/a.ts', assignee: 'executor',
          read_only: true }),
        say('Registered requests 1 and 2.')],
      2: [call('request_update', { request: 1 }),
        call('task_create', readTask('Plan A follow-up', 'executor', { depends_on: ['T3'] })),
        say('Added T7.')],
    } },
    chatSays,
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: readThenHandoff(SCHED_TEXT.depWork, { ms: 2000 }) } },
    { role: 'reviewer', kind: 'task', task: 'T2', deliveries: { 1: readThenHandoff('The fix is right') } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: { 1: readThenHandoff('Plan A looked fine') } },
    { role: 'executor', kind: 'task', task: 'T5', deliveries: {
      1: readThenHandoff('Later step done', { ms: 12000 }) } },
    { role: 'executor', kind: 'task', task: 'T6', deliveries: {
      1: readThenHandoff('a.ts read', { path: 'src/a.ts' }) } },
    { role: 'planner', kind: 'close', deliveries: every(closeAll({
      T1: ['close_done', SCHED_TEXT.depClosed], T2: ['close_done', 'Fix checked'],
      T3: ['close_failed', 'Plan A does not work'], T4: ['close_failed', 'Its dependency failed'],
      T5: ['close_done', 'Later step checked'], T6: ['close_done', 'Quick look done'],
      T7: ['close_failed', 'Its dependency failed'] })) },
  ],

  // TB-26（分开配置）：T1 第一个回复前等 6 秒；这期间你补充一句，立项 request_update；T1 的下一次请求的工作卡里有它。
  'tb-sched-update': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Look slowly', goal: 'Look at README.md' }),
        call('task_create', readTask('Long look', 'executor')), say('Registered request 1.')],
      2: [call('request_update', { request: 1 }), say('Added it to request 1.')],
    } },
    chatSays,
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(6000), call('read', { path: 'README.md' })),
        together(wait(1000), call('read', { path: 'src/a.ts' })),
        call('task_handoff', { task: '{task}', conclusion: 'Looked, tests too', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: every(closeAll({ T1: ['close_done', 'Looked'] })) },
  ],

  // TB-32（分开配置）：写 task T1 的第一个请求等 30 秒，写 task T2 等锁；你撤销需求。
  'tb-sched-cancel': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Long edit', goal: 'Edit README.md slowly' }),
        call('task_create', { request: 1, title: 'Slow edit', description: 'Edit README.md', assignee: 'executor',
          read_only: false }),
        call('task_create', { request: 1, title: 'Next edit', description: 'Edit src/a.ts', assignee: 'executor',
          read_only: false }),
        say('Registered request 1.')],
      2: [call('request_cancel', { request: 1, reason: 'The user no longer wants it' }), say('Cancelled request 1.')],
    } },
    chatSays,
    { role: 'executor', kind: 'task', deliveries: {
      1: [together(wait(30000), call('read', { path: 'README.md' })), say('Too late.')],
    } },
    { role: 'planner', kind: 'close', deliveries: every([say('Close should not have been woken.')]) },
  ],

  // TB-51 合并与过期（分开配置）：结案第一次运行（T1）等 8 秒，这期间 T2、T3 先后交给结案；下一次运行的投递是一条、
  // 两段按到达顺序；那次运行关闭需求，排着的“全部已结束”过期、不发出。
  'tb-sched-merge': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Three reads', goal: 'Read three times' }),
        call('task_create', readTask('First read', 'executor')),
        call('task_create', readTask('Second read', 'executor')),
        call('task_create', readTask('Third read', 'reviewer')), say('Registered request 1.')],
    } },
    chatSays,
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThenHandoff('First read done') } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: readThenHandoff('Second read done', { ms: 2500 }) } },
    { role: 'reviewer', kind: 'task', task: 'T3', deliveries: {
      1: readThenHandoff('Third read done', { ms: 4500 }) } },
    { role: 'planner', kind: 'close', deliveries: {
      ...every(closeAll({ T2: ['close_done', 'Second checked'], T3: ['close_done', 'Third checked'] }), 8),
      1: [together(wait(8000), call('task_handoff', { task: 'T1', conclusion: 'First checked',
        outcome: 'close_done' })), say('T1 closed.')],
    } },
  ],

  // TB-51 用户消息排在前面（分开配置）：T1 need_user → 立项程序唤醒的回合等 7 秒；这期间 T2 need_user（程序投递）
  // 先到、你的消息后到；立项下一次运行只有你的消息，再下一次是 T2 的投递。
  'tb-sched-userfirst': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Two questions', goal: 'Read what the user chooses' }),
        call('task_create', readTask('Pick a file', 'executor')),
        call('task_create', readTask('Pick a section', 'reviewer')), say('Registered request 1.')],
      2: [together(wait(7000), call('reply_via_dialog', { note: 'Ask the user which file to read' })),
        say('Asked the user.')],
      3: [call('request_update', { request: 1 }), call('task_edit', { task: 'T1' }), say('T1 continues.')],
      4: [call('reply_via_dialog', { note: 'Ask the user which section to check' }), say('Asked about T2.')],
    } },
    chatSays,
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: SCHED_TEXT.askT1, outcome: 'need_user' })],
      2: readThenHandoff('Read README.md'),
    } },
    { role: 'reviewer', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(2500), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: SCHED_TEXT.askT2, outcome: 'need_user' })],
    } },
    { role: 'planner', kind: 'close', deliveries: every(closeAll({ T1: ['close_done', 'Read'],
      T2: ['close_done', 'Checked'] })) },
  ],

  // TB-51 段开始时选不到模型（chat 的候选 [X, Y]、planner 的 [X, coder]、executor 的 [coder]）：你的大消息到立项时
  // X 404（之后不可用），立项等 9 秒才答；这期间需求 1 关闭，request_closed 排在用户会话的队列里；对话为大消息选模型时
  // X 不可用、Y 窗口放不下（no_handover），消息撤回；之后 request_closed 照常发出（Y 放得下）。
  'tb-sched-unavail': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Quick look', goal: 'Look at README.md' }),
        call('task_create', readTask('Quick look', 'executor')), say('Registered request 1.')],
      2: [together(fail(404, { model: SCHED_TEXT.modelX }), wait(9000), say('No collaboration needed.'))],
    } },
    chatSays,
    { role: 'executor', kind: 'task', deliveries: { 1: readThenHandoff('Looked', { ms: 3000 }) } },
    { role: 'planner', kind: 'close', deliveries: every(closeAll({ T1: ['close_done', 'Looked at it'] })) },
  ],
};
