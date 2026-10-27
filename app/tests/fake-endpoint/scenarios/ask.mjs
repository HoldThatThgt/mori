// 合成端点（synthetic）的脚本：tests/ui/tb-app-ask.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-04 临时提问、TB-27 留给 task 的消息、TB-28 发给座位会话的消息、TB-29 read_session、TB-33 订阅），格式见 scripts.mjs
// 开头；名字都以 tb-ask- 开头。每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是这个会话里的投递序号。
// 需求标题、临时提问的问题里都写上 tb-scenario（订阅与协作模式下临时提问的请求靠它们认脚本，§17.1）。
// 同一会话里几次投递的先后靠 wait 拉开（一次投递处理完、下一次才到），这样 k 是确定的。
// 这里另外导出套件要比较的文字（ASK_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, fail, handoff, say, together, wait } from '../steps.mjs';

/** @brief 一段很长的助手正文（read_session 的目录与翻页用）：开头是标记，后面重复到 n 个字符左右。 */
const longText = (mark, n) => `${mark} ${'lorem ipsum dolor '.repeat(Math.ceil(n / 18))}`.slice(0, n);

/** 套件要比较的文字 */
export const ASK_TEXT = {
  // TB-04
  memoryQuestion: 'What do you remember about README.md? tb-scenario:tb-ask-off',
  memoryAnswer: 'Memory answer: README.md describes the fixture project.',
  plannerQuestion: 'Planner, how would you split this? tb-scenario:tb-ask-off',
  plannerAnswer: 'Planner answer: one task is enough.',
  lonerQuestion: 'Loner, are you there? tb-scenario:tb-ask-off',
  executorAnswer: 'Executor answer.',
  // TB-28
  execToPlanner: 'Executor note one for planner',
  execToCloser: 'Executor note for closer',
  execQuestion: 'Executor question: is the plan still right? tb-scenario:tb-ask-seats',
  plannerReply: 'Planner says the plan is still right.',
  plannerToCloser: 'Planner note for closer',
  execToChat: 'Executor asks chat a question tb-scenario:tb-ask-seats',
  chatAnswer: 'Chat answer from the ask instance.',
  closerQuestion: 'Closer asks planner whether more tasks are needed',
  plannerToCloserBack: 'Planner asks closer back',
  plannerAnswersCloser: 'Planner answers closer: no more tasks.',
  createToClose: 'Create seat note for the close seat',
  closeToCreate: 'Close seat note for the create seat',
  baseCreateToClose: 'Base create note for the base close session',
  baseCloseToCreate: 'Base close note for the base create seat',
  // TB-27
  noteT1: 'Reviewer note for T1: mind the second section',
  noteT3: 'Reviewer note for T3: start from the summary',
  noteT2Late: 'Late note for a task that is done',
  // TB-29
  longA: longText('LONG-A-MARK', 7000),
  longB: longText('LONG-B-MARK', 7000),
  otherMark: 'OTHER-SESSION-MARK from the other user session',
  // TB-33
  ruledOut: 'Approach A does not work',
  memoryNote: 'Remember: approach A is ruled out',
  memoryFinal: 'MEMORY-FINAL kept a note for later.',
};

/** @brief 一次 read，再带它的证据以 outcome 交接（task 实例）。 */
const readThenHandoff = (path, conclusion, outcome = 'done') => [call('read', { path }),
  call('task_handoff', { task: '{task}', conclusion, outcome, evidence: ['{tag:read}'] })];

/** @brief 只说一句话的投递：k 从 from 到 to（合并与否不确定的程序投递都这样回）。 */
const sayFor = (from, to, text) => Object.fromEntries(Array.from({ length: to - from + 1 },
  (_, i) => [from + i, [say(text)]]));

/** @brief 结案处理交来的 task（close_done）；all 时随后关闭需求（全部 task 都已结束时才成功，否则被拒绝也无妨）。 */
const closeStep = (conclusion, all) => [call('task_handoff', { task: '{task}', conclusion, outcome: 'close_done' }),
  ...(all ? [call('request_close', { request: '{request}', outcome: 'done', conclusion: 'All tasks are done' })] : []),
  say('Handled {task}.')];

/** @brief 强制关闭的交接单（§7.5 第 4 步；只在投递合并、强制关闭时用到）。 */
const forcedClose = [handoff({ request: '{request}', outcome: 'done', conclusion: 'All tasks are done' })];

/** @brief 一组 n 次 agent_message（一个回复里依次调用）。 */
const messages = (n, to, text) => together(...Array.from({ length: n }, (_, i) => call('agent_message',
  { to, text: `${text} ${i + 1}` })));

export const SCENARIOS = {
  // TB-04 关闭模式（chat / planner / memory / loner / executor）：问 memory（交集里的候选，先 read 再回答）、
  // 问持有立项的 planner、问没有交集的 loner、发到 T1；第 2 回合连发 6 条给 executor（第 6 条超出），第 3 回合再发 1 条。
  'tb-ask-off': [
    { role: 'chat', kind: 'off-dialog', deliveries: {
      1: [call('agent_message', { to: 'memory', text: ASK_TEXT.memoryQuestion }),
        call('agent_message', { to: 'planner', text: ASK_TEXT.plannerQuestion }),
        call('agent_message', { to: 'loner', text: ASK_TEXT.lonerQuestion }),
        call('agent_message', { to: 'T1', text: 'A note for T1 tb-scenario:tb-ask-off' }),
        say('Asked around.')],
      2: [messages(6, 'executor', 'Question tb-scenario:tb-ask-off'), say('Asked six times.')],
      3: [call('agent_message', { to: 'executor', text: 'One more question tb-scenario:tb-ask-off' }),
        say('Asked once more.')],
    } },
    { role: 'memory', kind: 'ask', deliveries: {
      1: [call('read', { path: 'README.md' }), say(ASK_TEXT.memoryAnswer)],
    } },
    { role: 'planner', kind: 'ask', deliveries: { 1: [say(ASK_TEXT.plannerAnswer)] } },
    { role: 'loner', kind: 'ask', deliveries: { 1: [say('Loner should never be asked.')] } },
    { role: 'executor', kind: 'ask', deliveries: { 1: [say(ASK_TEXT.executorAnswer)] } },
  ],

  // TB-28 座位分开（chat 对话、planner 立项、closer 结案、executor）：executor 留言给 planner、closer（不写 request，
  // 进它所在需求的结案会话）、等 planner 回复、发给 chat（只持有对话：开临时提问）；planner 发给自己、发给 closer 不写
  // request、写 request: 1；closer 等 planner 时 planner 反过来等 closer 被拒绝。
  'tb-ask-seats': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Seats tb-scenario:tb-ask-seats', goal: 'Messages reach the seats' }),
        call('task_create', { request: 1, title: 'Send notes', description: 'Send notes to the seats',
          assignee: 'executor', limits: { write: false } }),
        say('Registered request 1.')],
      2: [call('agent_message', { to: 'planner', text: 'A note to myself' }),
        call('agent_message', { to: 'closer', text: 'Planner note without a request' }),
        call('agent_message', { to: 'closer', request: 1, text: ASK_TEXT.plannerToCloser }),
        say('Noted the executor note.')],
      3: [say(ASK_TEXT.plannerReply)],
      4: [call('agent_message', { to: 'closer', request: 1, wait: true, text: ASK_TEXT.plannerToCloserBack }),
        say(ASK_TEXT.plannerAnswersCloser)],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')], ...sayFor(2, 3, 'Request 1 is done.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('agent_message', { to: 'planner', text: ASK_TEXT.execToPlanner }),
        together(wait(2500), call('agent_message', { to: 'closer', text: ASK_TEXT.execToCloser })),
        together(wait(2500), call('agent_message', { to: 'planner', wait: true, text: ASK_TEXT.execQuestion })),
        call('agent_message', { to: 'chat', text: ASK_TEXT.execToChat }),
        ...readThenHandoff('README.md', 'Notes sent')],
    } },
    { role: 'closer', kind: 'close', deliveries: {
      1: [say('Closer noted the planner note.')],
      2: [say('Closer noted the executor note.')],
      3: [call('task_handoff', { task: '{task}', conclusion: 'Notes were sent', outcome: 'close_done' }),
        call('agent_message', { to: 'planner', wait: true, text: ASK_TEXT.closerQuestion }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'All notes were delivered' }),
        say('Request 1 closed.')],
      4: forcedClose,
    } },
    { role: 'chat', kind: 'ask', deliveries: { 1: [say(ASK_TEXT.chatAnswer)] } },
  ],

  // TB-28 条数上限（同一项目）：chat（不在需求里）给 planner 发 11 条，executor（需求 1 里）给 planner 发 11 条。
  'tb-ask-caps': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Caps tb-scenario:tb-ask-caps', goal: 'Count the messages' }),
        call('task_create', { request: 1, title: 'Send many', description: 'Send many notes', assignee: 'executor',
          limits: { write: false } }),
        say('Registered request 1.')],
      ...sayFor(2, 30, 'Noted.'),
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [messages(11, 'planner', 'Chat note'), say('Sent the notes.')], ...sayFor(2, 4, 'Request 1 is done.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [messages(11, 'planner', 'Executor note'), ...readThenHandoff('README.md', 'Notes sent')],
    } },
    { role: 'closer', kind: 'close', deliveries: { 1: closeStep('Notes sent', true), 2: forcedClose } },
  ],

  // TB-28 planner 持有立项与结案（chat / planner / executor / reviewer）：立项会话写 request 发给 planner 进结案会话，
  // 结案会话发给 planner 进立项会话。
  'tb-ask-dual': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Dual tb-scenario:tb-ask-dual', goal: 'Both seats get a note' }),
        call('task_create', { request: 1, title: 'Read', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        call('agent_message', { to: 'planner', request: 1, text: ASK_TEXT.createToClose }),
        say('Registered request 1.')],
      2: [say('Create noted the close note.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], ...sayFor(2, 3, 'Request 1 is done.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(2500), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Read', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [say('Close noted the create note.')],
      2: [call('task_handoff', { task: '{task}', conclusion: 'Read it', outcome: 'close_done' }),
        call('agent_message', { to: 'planner', text: ASK_TEXT.closeToCreate }),
        together(wait(2000), call('request_close', { request: 1, outcome: 'done', conclusion: 'Read' })),
        say('Request 1 closed.')],
      3: forcedClose,
    } },
  ],

  // TB-28 基座持有全部（没有角色文件，合并会话）：用户会话（立项）写 request 发给 mori 进结案会话，结案会话发给 mori
  // 进用户会话（create_wake）。
  'tb-ask-base': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Base tb-scenario:tb-ask-base', goal: 'Both seats get a note' }),
        call('task_create', { request: 1, title: 'Read', description: 'Read README.md', assignee: 'mori',
          limits: { write: false } }),
        call('agent_message', { to: 'mori', request: 1, text: ASK_TEXT.baseCreateToClose }),
        say('Registered request 1.')],
      2: [say('Noted the close note.')],
      ...sayFor(3, 4, 'Request 1 is done.'),
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(2500), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Read', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'mori', kind: 'close', deliveries: {
      1: [say('Close noted the create note.')],
      2: [call('task_handoff', { task: '{task}', conclusion: 'Read it', outcome: 'close_done' }),
        call('agent_message', { to: 'mori', text: ASK_TEXT.baseCloseToCreate }),
        together(wait(2500), call('request_close', { request: 1, outcome: 'done', conclusion: 'Read' })),
        say('Request 1 closed.')],
      3: forcedClose,
    } },
  ],

  // TB-27 留给 task 的消息（chat / planner / executor / reviewer）：reviewer 在 T2 上给正在做的 T1、还在等的 T3 留言；
  // T1 executor → reviewer；T3 开始后给已完成的 T2 留言被拒绝。
  'tb-ask-notes': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Notes tb-scenario:tb-ask-notes', goal: 'Notes reach the tasks' }),
        call('task_create', { request: 1, title: 'Main work', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        call('task_create', { request: 1, title: 'Side work', description: 'Read README.md and leave notes',
          assignee: 'reviewer', limits: { write: false } }),
        call('task_create', { request: 1, title: 'After main', description: 'Read src/a.ts', assignee: 'executor',
          limits: { write: false }, depends_on: ['T1'] }),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')], ...sayFor(2, 3, 'Request 1 is done.'),
    } },
    { role: 'reviewer', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(1500), call('agent_message', { to: 'T1', text: ASK_TEXT.noteT1 })),
        call('agent_message', { to: 'T3', text: ASK_TEXT.noteT3 }),
        together(wait(2000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Side work done', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(4500), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Main work done; please check', outcome: 'continue',
          next: 'reviewer' })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Checked', outcome: 'pass', evidence: ['{tag:read}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [call('agent_message', { to: 'T2', text: ASK_TEXT.noteT2Late }),
        ...readThenHandoff('src/a.ts', 'After main done')],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: closeStep('Done', true), 2: closeStep('Done', true), 3: closeStep('Done', true), 4: forcedClose,
    } },
  ],

  // TB-29 另一个用户会话（同一项目，先跑）：T1→T2→T3→T4 依次由 executor 做，T1 的正文带 OTHER 标记。
  'tb-ask-other': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Other tb-scenario:tb-ask-other', goal: 'Four tasks in a row' }),
        call('task_create', { request: 1, title: 'Other first', description: 'Read', assignee: 'executor',
          limits: { write: false } }),
        ...[2, 3, 4].map((n) => call('task_create', { request: 1, title: `Other ${n}`, description: 'Read',
          assignee: 'executor', limits: { write: false }, depends_on: [`T${n - 1}`] })),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], ...sayFor(2, 3, 'Request 1 is done.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(say(ASK_TEXT.otherMark), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Read', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    ...['T2', 'T3', 'T4'].map((task) => ({ role: 'executor', kind: 'task', task,
      deliveries: { 1: readThenHandoff('README.md', 'Read') } })),
    { role: 'planner', kind: 'close', deliveries: {
      1: closeStep('Done', true), 2: closeStep('Done', true), 3: closeStep('Done', true), 4: closeStep('Done', true),
      5: forcedClose,
    } },
  ],

  // TB-29 read_session（chat / planner / executor（带思考的模型）/ reviewer / switcher（两个模型））：
  // T1 executor 两个长回合（中间 reviewer 读它、交回），第二回合读自己（still running）；T2 switcher 换模型重来；
  // T3 reviewer 在 T1、T2 都完成后读：目录、翻页、换模型隐藏的部分、读不到对话与座位、读不到别的用户会话的 T4。
  'tb-ask-read': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Read tb-scenario:tb-ask-read', goal: 'Sessions can be read' }),
        call('task_create', { request: 1, title: 'Long work', description: 'Write a lot', assignee: 'executor',
          limits: { write: false } }),
        call('task_create', { request: 1, title: 'Switch work', description: 'Read twice', assignee: 'switcher',
          limits: { write: false } }),
        call('task_create', { request: 1, title: 'Read the work', description: 'Read the sessions',
          assignee: 'reviewer', limits: { write: false }, depends_on: ['T1', 'T2'] }),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], ...sayFor(2, 3, 'Request 1 is done.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(say(ASK_TEXT.longA), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'First part done', outcome: 'continue',
          next: 'reviewer' })],
      2: [together(say(ASK_TEXT.longB), call('read_session', { task: 'T1', role: 'executor' })),
        call('read_session', { task: 'T1' }),
        call('task_handoff', { task: '{task}', conclusion: 'Second part done', outcome: 'done',
          evidence: ['#1'] })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [call('read_session', { task: 'T1' }),
        call('task_handoff', { task: '{task}', conclusion: 'Needs a second part', outcome: 'fail',
          next: 'executor' })],
    } },
    { role: 'switcher', kind: 'task', task: 'T2', deliveries: {
      1: [call('read', { path: 'README.md' }), together(fail(429, { model: 'fake-sw1' }), say('Unused.'))],
      'restart-1': readThenHandoff('src/a.ts', 'Read on the new model'),
    } },
    { role: 'reviewer', kind: 'task', task: 'T3', deliveries: {
      1: [call('read_session', { task: 'T1', role: 'executor' }),
        call('read_session', { task: 'T1', role: 'executor', from: 2, to: 2 }),
        call('read_session', { task: 'T2', role: 'switcher' }),
        call('read_session', { task: 'T1', role: 'chat' }),
        call('read_session', { task: 'T1', role: 'planner' }),
        call('read_session', { task: 'T4', role: 'executor' }),
        call('task_handoff', { task: '{task}', conclusion: 'Read all of it', outcome: 'done', evidence: ['#1'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: closeStep('Done', true), 2: closeStep('Done', true), 3: closeStep('Done', true), 4: forcedClose,
    } },
  ],

  // TB-33 订阅（chat / planner / executor / memory、auditor、picky 三个订阅者）：需求以 done 关闭且有已排除的方案。
  'tb-ask-subs-ro': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Ruled out tb-scenario:tb-ask-subs-ro', goal: 'Try two approaches' }),
        call('task_create', { request: 1, title: 'Try A', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        call('task_create', { request: 1, title: 'Try B', description: 'Read src/a.ts', assignee: 'executor',
          limits: { write: false } }),
        say('Registered request 1.')],
      2: [say('Noted the memory note.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')], ...sayFor(2, 3, 'Request 1 is done.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: readThenHandoff('README.md', ASK_TEXT.ruledOut, 'dead_end'),
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(3000), call('read', { path: 'src/a.ts' })),
        call('task_handoff', { task: '{task}', conclusion: 'B works', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: ASK_TEXT.ruledOut, outcome: 'close_failed' }),
        say('T1 failed.')],
      2: [call('task_handoff', { task: '{task}', conclusion: 'B works', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'Approach B works' }),
        say('Request 1 closed.')],
      3: forcedClose,
    } },
    { role: 'memory', kind: 'subscription', deliveries: {
      1: [call('agent_message', { to: 'planner', text: ASK_TEXT.memoryNote }),
        call('bash', { command: 'echo subscription-should-not-run' }),
        say(ASK_TEXT.memoryFinal)],
    } },
    { role: 'auditor', kind: 'subscription', deliveries: { 1: [say('Auditor should not be woken here.')] } },
    { role: 'picky', kind: 'subscription', deliveries: { 1: [say('Picky should never be woken.')] } },
  ],

  // TB-33：需求以 failed 关闭、没有已排除的方案。
  'tb-ask-subs-fail': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Plain failure tb-scenario:tb-ask-subs-fail', goal: 'Meet a goal' }),
        call('task_create', { request: 1, title: 'Try', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')], ...sayFor(2, 3, 'Request 1 failed.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThenHandoff('README.md', 'Read it') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Read it', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'failed', conclusion: 'The goal was not met' }),
        say('Request 1 closed as failed.')],
      2: forcedClose,
    } },
    { role: 'memory', kind: 'subscription', deliveries: { 1: [say('Memory should not be woken here.')] } },
    { role: 'auditor', kind: 'subscription', deliveries: { 1: [say('Auditor: nothing to keep.')] } },
    { role: 'picky', kind: 'subscription', deliveries: { 1: [say('Picky should never be woken.')] } },
  ],

  // TB-33：需求被撤销（cancelled）、没有已排除的方案。
  'tb-ask-subs-cancel': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'To cancel tb-scenario:tb-ask-subs-cancel', goal: 'A long job' }),
        call('task_create', { request: 1, title: 'Long job', description: 'Read slowly', assignee: 'executor',
          limits: { write: false } }),
        say('Registered request 1.')],
      2: [call('request_cancel', { request: 1, reason: 'Not needed any more' }), say('Cancelled request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')], 2: [say('Request 1 is cancelled.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(60000), call('read', { path: 'README.md' })), say('Too late.')],
    } },
    { role: 'memory', kind: 'subscription', deliveries: { 1: [say('Memory should not be woken here.')] } },
    { role: 'auditor', kind: 'subscription', deliveries: { 1: [say('Auditor: nothing to keep.')] } },
    { role: 'picky', kind: 'subscription', deliveries: { 1: [say('Picky should never be woken.')] } },
  ],

  // TB-33 订阅的调度类别 background（chat / planner / executor / worker、watcher 用并发 2 的 tbq）：T2 的长请求占着
  // tbq 给 task、background 的唯一槽位；需求 1 关闭后 watcher 的订阅先排上，T3 完成后 T4 才排上，T2 的请求结束时 T4 先发。
  'tb-ask-class': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Quick tb-scenario:tb-ask-class', goal: 'A quick read' }),
        call('task_create', { request: 1, title: 'Quick', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        call('request_submit', { title: 'Held tb-scenario:tb-ask-class', goal: 'Reads on the narrow provider' }),
        call('task_create', { request: 2, title: 'Hold the slot', description: 'Read slowly', assignee: 'worker',
          limits: { write: false } }),
        call('task_create', { request: 2, title: 'Gate', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        call('task_create', { request: 2, title: 'After the gate', description: 'Read src/a.ts', assignee: 'worker',
          limits: { write: false }, depends_on: ['T3'] }),
        say('Registered requests 1 and 2.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered two requests.')], ...sayFor(2, 5, 'Reported.'),
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThenHandoff('README.md', 'Quick read') } },
    { role: 'worker', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(9000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Held', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [together(wait(3000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Gate open', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'worker', kind: 'task', task: 'T4', deliveries: {
      1: [call('read', { path: 'src/a.ts' }),
        together(wait(2000), call('task_handoff', { task: '{task}', conclusion: 'After the gate', outcome: 'done',
          evidence: ['{tag:read}'] }))],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: closeStep('Done', true), 2: closeStep('Done', true), 3: closeStep('Done', true), 4: forcedClose,
    } },
    { role: 'watcher', kind: 'subscription', deliveries: { 1: [say('Watcher: nothing to keep.')] } },
  ],
};
