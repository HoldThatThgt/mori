// 合成端点（synthetic）的脚本：tests/ui/tb-app-flow.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-10 合并会话、TB-12 持久化、TB-21 每个 task 一组实例、TB-37 进展摘要，以及几条主路径），格式见 scripts.mjs 开头；
// 名字都以 tb-flow- 开头。每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是这个会话里的投递序号。
// 测试准备（synthetic test setup）：套件启动端点时给 TB_FLOW_SPLIT（分开配置的临时项目），read 用它的绝对路径，
// 检查进展摘要与工具卡的标题都把工作目录里的绝对路径写成相对路径；没有时（例如 selfcheck 载入）用 "."。
// 这里另外导出套件要比较的文字（FLOW_TEXT），scripts.mjs 只并入 SCENARIOS。

import { join } from 'node:path';
import { call, end, handoff, say, together, wait } from '../steps.mjs';

/** 分开配置的项目（套件给的环境变量） */
const SPLIT = process.env.TB_FLOW_SPLIT ?? '.';

/** 套件要比较的文字 */
export const FLOW_TEXT = {
  /** 第一行超过 80 个字符的两行命令：标题只取第一行、截到 80 个字符加 … */
  longCommand: `echo tb-flow-${'x'.repeat(100)}\necho second-line`,
  /** 第一行不到 80 个字符的两行命令：标题取第一行、加 " …"（§13.8，同 v0 工具卡） */
  multiCommand: 'echo tb-flow-multi\necho second-line',
  /** 带行范围的 read（offset、limit）：标题加 " · lines 3–4" */
  readRange: { offset: 3, limit: 2 },
  /** 分开配置项目里 README.md 的绝对路径（标题写成 README.md） */
  absReadme: join(SPLIT, 'README.md'),
  /** need_user 的问题 */
  question: 'Which section should I summarize?',
  /** 合并会话程序唤醒回合的回复（问你一次） */
  askReply: 'T1 needs your decision: which section should I summarize?',
};

/** @brief 一次 read，再带它的证据以 outcome 交接（task 实例）。 */
const readThenHandoff = (path, conclusion, outcome = 'done') => [call('read', { path }),
  call('task_handoff', { task: '{task}', conclusion, outcome, evidence: ['{tag:read}'] })];

/** @brief 结案关闭交来的 task（close_done），然后说一句。 */
const closeTask = (conclusion, after) => [call('task_handoff', { task: '{task}', conclusion, outcome: 'close_done' }),
  say(after)];

export const SCENARIOS = {
  // TB-10 合并会话（没有角色文件，基座持有三项权限）：登记 → T1 need_user → 程序唤醒的立项回合（reply_via_dialog 被拒绝、
  // 回复就是问你）→ 你的回答记为补充并交回 → T1 完成 → 结案请立项再建 task（create_wake：对已完成的 T1 的 task_edit
  // 被拒绝（终态不能改），task_create 不用先记原话）→ T2 → 结案关闭需求 → 汇报；最后一条关闭模式的消息。
  'tb-flow-merged': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Summarize the README', goal: 'A short summary of README.md' }),
        call('task_create', { request: 1, title: 'Read README', description: 'Read README.md and summarize it',
          assignee: 'mori', read_only: true }),
        say('Registered request 1.')],
      2: [together(wait(1500), call('reply_via_dialog', { note: 'Ask the user which section' })),
        say(FLOW_TEXT.askReply)],
      3: [call('request_update', { request: 1 }), call('task_edit', { task: 'T1' }),
        say('Added your answer to request 1.')],
      4: [call('task_edit', { task: 'T1', title: 'Renamed after it ended' }),
        call('task_create', { request: 1, title: 'List src', description: 'Read src/a.ts too',
          assignee: 'mori', read_only: true }), say('Created T2.')],
      5: [say('Request 1 is done: the README was summarized.')],
    } },
    { role: 'mori', kind: 'dialog', deliveries: { 6: [say('A plain answer in off mode.')] } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: FLOW_TEXT.question, outcome: 'need_user' })],
      2: readThenHandoff('README.md', 'Summarized the intro section'),
    } },
    { role: 'mori', kind: 'task', task: 'T2', deliveries: { 1: readThenHandoff('src/a.ts', 'a.ts adds numbers') } },
    { role: 'mori', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: 'T1', conclusion: 'The intro is summarized', outcome: 'close_done' }),
        call('agent_message', { to: 'mori', request: 1, wait: true,
          text: 'Request 1 needs one more task: read src/a.ts.' }),
        say('Asked for one more task.')],
      2: [call('task_handoff', { task: 'T2', conclusion: 'a.ts read', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'The README was summarized' }),
        say('Request 1 closed.')],
    } },
  ],

  // TB-10 同一次运行里的插话各算一次判断：登记之后等着，你插话；插话那次判断里先 task_create 被拒绝（要先记原话），
  // 再 request_update（另一类决定）被接受，然后 task_create。
  'tb-flow-steer': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Plan a read', goal: 'Read the files the user names' }),
        together(wait(3000), call('task_create', { request: 1, title: 'Read README', description: 'Read README.md',
          assignee: 'mori', read_only: true }))],
      2: [call('task_create', { request: 1, title: 'Read a.ts', description: 'Read src/a.ts', assignee: 'mori',
        read_only: true }),
      call('request_update', { request: 1 }),
      call('task_create', { request: 1, title: 'Read a.ts', description: 'Read src/a.ts', assignee: 'mori',
        read_only: true }),
      say('Noted both of your messages.')],
      3: [say('Request 1 is done.')],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: { 1: readThenHandoff('README.md', 'README read') } },
    { role: 'mori', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(2000), call('read', { path: 'src/a.ts' })),
        call('task_handoff', { task: '{task}', conclusion: 'a.ts read', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'mori', kind: 'close', deliveries: {
      1: closeTask('README read', 'T1 closed.'),
      2: [call('task_handoff', { task: '{task}', conclusion: 'a.ts read', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'Both files were read' }),
        say('Request 1 closed.')],
    } },
  ],

  // TB-10 项目有 .pi/SYSTEM.md：协作模式的请求里仍有合并会话的立项段；之后关闭模式的一条没有。
  // 判断你的消息时 reply_via_dialog（不需要协作）的结果请它在自己的回复里回答（合并会话）。
  'tb-flow-sysmd': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('reply_via_dialog', {}), say('No collaboration needed; answering directly.')],
    } },
    { role: 'mori', kind: 'dialog', deliveries: { 2: [say('Off mode answer.')] } },
  ],

  // TB-12 编号不复用、终态不能改，TB-37 Cancelled 与 Failed：需求 1（T1、T2）撤销，需求 2 的 task 是 T3，
  // 对已撤销的 T1 的 task_edit 被拒绝；T3 dead_end → 结案 close_failed（已排除的方案）→ 需求以 failed 关闭。
  'tb-flow-renumber': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Two things', goal: 'Do two things in order' }),
        call('task_create', { request: 1, title: 'First thing', description: 'Read README.md', assignee: 'mori',
          read_only: true }),
        call('task_create', { request: 1, title: 'Second thing', description: 'Read src/a.ts', assignee: 'mori',
          read_only: true, depends_on: ['T1'] }),
        say('Registered request 1.')],
      2: [call('request_cancel', { request: 1, reason: 'The user changed their mind' }),
        say('Cancelled request 1.')],
      3: [call('request_submit', { title: 'Read src', goal: 'Find something useful in src' }),
        call('task_edit', { task: 'T1', title: 'Renamed' }),
        call('task_create', { request: 2, title: 'Look in src', description: 'Read src/a.ts', assignee: 'mori',
          read_only: true }),
        say('Registered request 2.')],
      4: [say('Request 2 failed: nothing useful in src.')],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(6000), call('read', { path: 'README.md' })), say('T1 should have been stopped.')],
    } },
    { role: 'mori', kind: 'task', task: 'T3', deliveries: {
      1: readThenHandoff('src/a.ts', 'src has only a.ts. Nothing more to read', 'dead_end'),
    } },
    { role: 'mori', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Reading src did not help', outcome: 'close_failed' }),
        call('request_close', { request: 2, outcome: 'failed', conclusion: 'Nothing useful in src' }),
        say('Request 2 closed as failed.')],
    } },
  ],

  // TB-21、TB-37（分开配置 chat / planner / executor / reviewer）：T1 executor → reviewer → executor（同一条会话），
  // T2 只读、与 T1 同时由 executor 做（各一个实例），T3 依赖 T1（pending），T4 写 task 等写入锁（之后先跑一条第一行很短的
  // 两行命令、读 README.md 的第 3–4 行，进展摘要的标题与工具卡同一规则），T4 没交接、
  // 强制填写两次都格式错误 → 程序写的一棒（Mori: no handoff）；对话回复登记它的消息时你又发了一条。
  'tb-flow-chain': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Fix the README', goal: 'README says the right thing' }),
        call('task_create', { request: 1, title: 'Fix README', description: 'Fix README.md', assignee: 'executor',
          read_only: false }),
        call('task_create', { request: 1, title: 'Count lines', description: 'Count the lines of src/a.ts',
          assignee: 'executor', read_only: true }),
        call('task_create', { request: 1, title: 'Summarize', description: 'Summarize the fixed README',
          assignee: 'reviewer', read_only: true, depends_on: ['T1'] }),
        call('task_create', { request: 1, title: 'Update notes', description: 'Write release notes',
          assignee: 'executor', read_only: false }),
        say('Registered request 1 with four tasks.')],
      2: [say('No new work: answer from the board.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [together(wait(1200), say('Planner registered request 1.'))],
      2: [say('It is under way.')],
      3: [say('Request 1 is done: README fixed.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(3000), call('bash', { command: FLOW_TEXT.longCommand })),
        together(wait(2500), call('read', { path: FLOW_TEXT.absReadme })),
        together(wait(2500), call('task_handoff', { task: '{task}', conclusion: 'Fixed the title. More notes follow.',
          outcome: 'continue', next: 'reviewer' }))],
      2: readThenHandoff('README.md', 'Logout fixed too'),
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(1000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Logout test fails', outcome: 'fail', next: 'executor' })],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(3000), call('read', { path: 'src/a.ts' })),
        call('task_handoff', { task: '{task}', conclusion: 'a.ts has 3 lines', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T3', deliveries: {
      1: [together(wait(1000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Summary written', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T4', deliveries: {
      1: [together(wait(3000), call('bash', { command: FLOW_TEXT.multiCommand })),
        together(wait(1500), call('read', { path: FLOW_TEXT.absReadme, ...FLOW_TEXT.readRange })),
        together(wait(1500), call('read', { path: 'README.md' })), end()],
      2: [handoff({ task: '{task}', conclusion: 'Notes written', outcome: 'done' }, { malformed: true }),
        say('I could not hand off.')],
      3: [handoff({ task: '{task}', conclusion: 'Notes written', outcome: 'done' }, { malformed: true }),
        say('Still could not hand off.')],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [together(wait(1500), call('task_handoff', { task: '{task}', conclusion: 'Counted', outcome: 'close_done' })),
        say('T2 closed.')],
      2: closeTask('Fixed and verified', 'T1 closed.'),
      3: closeTask('Summary is fine', 'T3 closed.'),
      4: [call('task_handoff', { task: '{task}', conclusion: 'Notes approach did not work', outcome: 'close_failed' }),
        together(wait(1500), call('request_close', { request: 1, outcome: 'done', conclusion: 'README fixed' })),
        say('Request 1 closed.')],
    } },
  ],

  // TB-37 Queued 与 Stopped（合并会话）：五个只读 task，前四个在运行（第一个请求等很久），第五个排队；
  // 你按 Stop team 后都为 Stopped；最后撤销这个需求。
  'tb-flow-queue': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Five reads', goal: 'Read README.md five times' }),
        ...[1, 2, 3, 4, 5].map((n) => call('task_create', { request: 1, title: `Read ${n}`,
          description: 'Read README.md', assignee: 'mori', read_only: true })),
        say('Registered request 1 with five tasks.')],
      2: [call('request_cancel', { request: 1, reason: 'Stopped by the user' }), say('Cancelled request 1.')],
    } },
    { role: 'mori', kind: 'task', deliveries: {
      1: [together(wait(60000), call('read', { path: 'README.md' })), say('Too late.')],
    } },
  ],

  // TB-37 "Waiting to change files (T1, stopped)"（合并会话）：写 task T1 持有写入锁、只读的 T2 在做，Stop team 后两个都停下；
  // 你让它继续 T2（交回），T2 完成后依赖它的写 task T3 交出去，等的是已停止的 T1 的锁；最后撤销需求。
  'tb-flow-lockstop': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Two writes', goal: 'Change two files in order' }),
        call('task_create', { request: 1, title: 'Hold the lock', description: 'Edit README.md', assignee: 'mori',
          read_only: false }),
        call('task_create', { request: 1, title: 'Prepare', description: 'Read src/a.ts', assignee: 'mori',
          read_only: true }),
        call('task_create', { request: 1, title: 'Second write', description: 'Edit src/a.ts', assignee: 'mori',
          read_only: false, depends_on: ['T2'] }),
        say('Registered request 1.')],
      2: [call('request_update', { request: 1 }), call('task_edit', { task: 'T2' }), say('Continuing T2.')],
      3: [call('request_cancel', { request: 1, reason: 'Done testing the lock' }), say('Cancelled request 1.')],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(60000), call('read', { path: 'README.md' })), say('Too late.')],
    } },
    { role: 'mori', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(60000), call('read', { path: 'src/a.ts' })), say('Too late.')],
      2: readThenHandoff('src/a.ts', 'a.ts is ready'),
    } },
    { role: 'mori', kind: 'close', deliveries: { 1: closeTask('Prepared', 'T2 closed.') } },
  ],

  // TB-37 与工具卡同一标题规则：关闭模式下对话自己跑同样的两条命令（长的、第一行很短的）、读同一个绝对路径
  // （整个文件、带行范围），工具卡的标题对象与进展摘要的一致。
  'tb-flow-titles': [
    { role: 'chat', kind: 'off-dialog', deliveries: {
      1: [call('bash', { command: FLOW_TEXT.longCommand }), call('read', { path: FLOW_TEXT.absReadme }),
        call('bash', { command: FLOW_TEXT.multiCommand }),
        call('read', { path: FLOW_TEXT.absReadme, ...FLOW_TEXT.readRange }), say('Ran and read.')],
    } },
  ],

  // 主路径：关闭模式下对话问 executor 一个问题（只读的临时提问实例，回答成为工具结果）。
  'tb-flow-ask': [
    { role: 'chat', kind: 'off-dialog', deliveries: {
      1: [call('agent_message', { to: 'executor', text: 'What is in README.md? tb-scenario:tb-flow-ask' }),
        say('Executor answered: {lastResult:agent_message}')],
    } },
    { role: 'executor', kind: 'ask', deliveries: {
      1: [call('read', { path: 'README.md' }), say('README.md describes the fixture project.')],
    } },
  ],

  // 主路径与 TB-37 approval：task 实例的 bash 在"每次询问"下出后台批准卡，允许后执行。
  'tb-flow-approve': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Run a command', goal: 'echo works' }),
        call('task_create', { request: 1, title: 'Echo hello', description: 'Run echo hello', assignee: 'executor',
          read_only: false }),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')], 2: [say('Done.')] } },
    { role: 'executor', kind: 'task', deliveries: {
      1: [call('bash', { command: 'echo hello-from-T1' }),
        call('task_handoff', { task: '{task}', conclusion: 'Echo ran', outcome: 'done', evidence: ['{tag:bash}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Echo ran', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'echo works' }), say('Closed.')],
    } },
  ],

  // TB-12、TB-37 重启：T1 在运行中（第一个请求等很久）时退出 App，重新打开后 T1 为 Stopped (Mori restarted)。
  'tb-flow-restart': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Long job', goal: 'Run a long job' }),
        call('task_create', { request: 1, title: 'Long read', description: 'Read README.md slowly',
          assignee: 'executor', read_only: false }),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')] } },
    { role: 'executor', kind: 'task', deliveries: {
      1: [together(wait(120000), call('read', { path: 'README.md' })), say('Too late.')],
    } },
  ],
};
