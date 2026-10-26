// 合成端点（synthetic）的脚本：tests/ui/tb-app-tasks.mjs 用的场景（docs/specs/parallel-agents-taskboard.md §13.13，
// TB-80–TB-87、TB-89 的 App 层），格式见 scripts.mjs 开头；名字都以 tb-tasks- 开头。每个场景在自己的用户会话里跑
// （脚本按请求里第一个 tb-scenario 认），k 是这个会话里的投递序号。分开配置（chat / planner / executor / reviewer，
// tb-helpers SPLIT_ROLES）：planner 持有立项与结案。等很久的步骤（wait）是让套件在那一刻看、停止或重启。

import { call, end, say, together, wait } from '../steps.mjs';

/** 等到被停止或重启的步骤：比套件里任何一次等待都长 */
const LONG = 120000;
/** T3 等到被停下：套件在它之前要走完入口、列表、视图、会话与键盘几步，给足 10 分钟 */
const UNTIL_STOPPED = 600000;

/** task 的说明（Prompt 里按 Markdown 画出表格） */
export const TASKS_PROMPT = 'Find why the login page is blank.\n\n| step | what |\n| - | - |\n| 1 | read the route |';
/** T1 留在自己 task 上的消息（task 视图的 Messages，含表格与 mermaid 图；T1 开始时立项可能还没建 T2，所以不留给 T2） */
export const TASKS_MESSAGE = 'Check these files:\n\n| file | why |\n| - | - |\n| src/login.ts | blank page |\n\n'
  + '```mermaid\ngraph TD\n  Route --> Login\n```';
/** T1 的结论：超过进展摘要第一句的长度，task 视图里是全文 */
export const TASKS_CONCLUSION = 'The route for /login was missing. '
  + 'The router skipped the page when the session cookie was empty, so nothing rendered. '
  + 'Adding the route back makes the form show again; the test for it is still to be written.';
/** T1 交接写的未结事项 */
export const TASKS_OPEN_ITEM = 'Add a test for the route';

/** @brief 结案关闭交来的 task（close_done），然后说一句。 */
const closeTask = (conclusion, after) => [call('task_handoff', { task: '{task}', conclusion, outcome: 'close_done' }),
  say(after)];

/** @brief 结案关闭交来的 task，再关闭这个需求。 */
const closeLast = (conclusion) => [call('task_handoff', { task: '{task}', conclusion, outcome: 'close_done' }),
  call('request_close', { request: '{request}', outcome: 'done', conclusion }), say('Request closed.')];

/** @brief 一个写 task 的建立参数。 */
const writeTask = (title, assignee, extra = {}) => ({ request: 1, title, description: title, assignee,
  read_only: false, ...extra });
/**
 * @brief 两个会话各自的一个只读 task（tb-app-tasks.mjs 的 sessions：两个会话都有 T1，切换、分屏时各看各的）：
 *        executor 读一个文件后以 done 交接，结案关闭。
 */
const pairScenario = (title, description) => [
  { role: 'planner', kind: 'create', deliveries: {
    1: [call('request_submit', { title, goal: description }),
      call('task_create', { request: 1, title, description, assignee: 'executor', read_only: true }),
      say('Registered request 1.')],
  } },
  { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')], 2: [say('Done.')] } },
  { role: 'executor', kind: 'task', task: 'T1', deliveries: {
    1: [call('read', { path: 'README.md' }), call('task_handoff', { task: '{task}', conclusion: `${title} done`,
      outcome: 'done', evidence: ['{tag:read}'] })],
  } },
  { role: 'planner', kind: 'close', deliveries: { 1: closeLast(`${title} closed`) } },
];

/** @brief 一个只读 task 的建立参数。 */
const readTask = (title, assignee, extra = {}) => ({ request: 1, title, description: title, assignee,
  read_only: true, ...extra });

export const SCENARIOS = {
  // TB-80–TB-87、TB-89：T1（只读，executor）在自己的 task 上留一条带表格的消息、读一个文件后带证据与未结事项以 done 交接；
  // T2（只读，reviewer，依赖 T1）读一个文件后 pass；T3（写，executor）跑一条命令后等很久（套件在这时停下它）；
  // T4（写，executor）等 T3 的写入锁。你的第二条消息让立项把 T3 交回 executor（继续原来的会话，先等 3 秒，套件在这时看
  // 停止按钮），T3、T4 做完后关闭。
  'tb-tasks-flow': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Fix the login page', goal: 'The login page shows the form' }),
        call('task_create', readTask('Find the cause', 'executor', { description: TASKS_PROMPT })),
        call('task_create', readTask('Review the cause', 'reviewer', { depends_on: ['T1'] })),
        call('task_create', writeTask('Long change', 'executor')),
        call('task_create', writeTask('Second change', 'executor')),
        say('Registered request 1 with four tasks.')],
      2: [call('request_update', { request: 1 }), call('task_edit', { task: 'T3' }), say('Handed T3 back.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], 2: [say('Continuing T3.')], 3: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('agent_message', { to: '{task}', text: TASKS_MESSAGE }), call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: TASKS_CONCLUSION, outcome: 'done',
          evidence: ['{tag:read}'], open_items: [TASKS_OPEN_ITEM] })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T2', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'The cause is right.', outcome: 'pass',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [call('bash', { command: 'echo started' }), together(wait(UNTIL_STOPPED), say('Still going.'))],
      2: [together(wait(3000), call('bash', { command: 'echo resumed' })),
        call('task_handoff', { task: '{task}', conclusion: 'Long change done', outcome: 'done',
          evidence: ['{tag:bash}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T4', deliveries: {
      1: [call('write', { path: 'second.txt', content: 'second\n' }),
        call('task_handoff', { task: '{task}', conclusion: 'Second change done', outcome: 'done',
          evidence: ['{tag:write}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: closeTask('Found the cause', 'T1 closed.'),
      2: closeTask('Reviewed', 'T2 closed.'),
      3: closeTask('Long change closed', 'T3 closed.'),
      4: closeLast('The login page is fixed'),
    } },
  ],

  // TB-83、TB-89：T1（写）的命令挂着批准卡（权限从“每次询问”开始），套件在这时打开它的会话（没有结果的调用为
  // Running…），再停下它：批准卡按拒绝处理、消失。
  'tb-tasks-approval': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Run a command', goal: 'A command runs' }),
        call('task_create', writeTask('Run a command', 'executor')), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('bash', { command: 'echo needs-approval' }), end()],
    } },
  ],

  // team-tasks.md“task 的视图”：交接的结果与去向、程序写的一棒、建议的下一棒、两个角色的 View transcript，以及运行中的会话
  // 随 TaskView 重新读、运行结束的不再重新读。T1（只读）：executor continue → reviewer（等 8 秒）fail → executor dead_end →
  // reviewer（等 8 秒）blocked → 结案 close_failed；T2：executor need_user（立项不做决定，对话问你）；T3 依赖 T1：T1 失败后
  // 程序写一棒交给结案，结案 close_failed；T4：executor 带 next 以 done 交接（next 不生效，成为建议），结案 close_done。
  'tb-tasks-outcomes': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Try every outcome', goal: 'Each outcome shows in the task view' }),
        call('task_create', readTask('Chain of batons', 'executor')),
        call('task_create', readTask('Ask the user', 'executor')),
        call('task_create', readTask('After the chain', 'executor', { depends_on: ['T1'] })),
        call('task_create', readTask('Quick read', 'executor')),
        say('Registered request 1 with four tasks.')],
      2: [say('The user decides this one.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], 2: [say('Which database should T2 use?')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Ready for review', outcome: 'continue',
          next: 'reviewer' })],
      2: [call('task_handoff', { task: '{task}', conclusion: 'No way forward from here', outcome: 'dead_end',
        next: 'reviewer' })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(8000), call('task_handoff', { task: '{task}', conclusion: 'The change is wrong',
        outcome: 'fail', next: 'executor' }))],
      2: [together(wait(8000), call('task_handoff', { task: '{task}', conclusion: 'Blocked on the database',
        outcome: 'blocked' }))],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Which database should I use?', outcome: 'need_user' })],
    } },
    { role: 'executor', kind: 'task', task: 'T4', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'README read', outcome: 'done', next: 'reviewer',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: closeTask('Read', 'T4 closed.'),
      2: [call('task_handoff', { task: '{task}', conclusion: 'Closing as failed', outcome: 'close_failed' }),
        say('T1 failed.')],
      3: [call('task_handoff', { task: '{task}', conclusion: 'Nothing to do without T1', outcome: 'close_failed' }),
        say('T3 failed.')],
    } },
  ],

  // team-tasks.md“实例的会话”的“还没有条目”：这个项目的扩展让会话 8 秒才建好（tb-app-tasks.mjs 的 noactivity，synthetic）；
  // T1 的实例会话还在建的时候套件停下它，投递不发出，会话里没有消息。T1 的步骤不应被用到（停得晚了才会有请求）。
  'tb-tasks-idle': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Start slowly', goal: 'A task stopped before its first delivery' }),
        call('task_create', readTask('Start slowly', 'executor')), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')] } },
  ],

  // TB-82：打开着的 task 视图随 TaskView 重新读。T1（只读）：executor 等 5 秒后 continue → reviewer（等 5 秒）fail →
  // executor dead_end → reviewer blocked → 结案 close_failed。套件在第一棒之前打开 T1 的视图，一直不关。
  'tb-tasks-live': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Watch the view', goal: 'The open view follows the task' }),
        call('task_create', readTask('Chain in view', 'executor')), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')], 2: [say('T1 failed.')] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(5000), call('task_handoff', { task: '{task}', conclusion: 'Ready for review',
        outcome: 'continue', next: 'reviewer' }))],
      2: [call('task_handoff', { task: '{task}', conclusion: 'No way forward', outcome: 'dead_end', next: 'reviewer' })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(5000), call('task_handoff', { task: '{task}', conclusion: 'Wrong', outcome: 'fail',
        next: 'executor' }))],
      2: [call('task_handoff', { task: '{task}', conclusion: 'Blocked', outcome: 'blocked' })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Closing as failed', outcome: 'close_failed' }),
        call('request_close', { request: '{request}', outcome: 'failed', conclusion: 'T1 failed' }),
        say('Request closed.')],
    } },
  ],

  // TB-82、TB-83：程序写的一棒的 View transcript 打开那个实例的会话。executor 的模型没有写入等级（tb-app-tasks.mjs 的
  // tbplain，synthetic），读一个文件后不交接就结束：程序写一棒 no handoff 交给结案，结案 close_done。
  'tb-tasks-program': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'End without a handoff', goal: 'The program writes the baton' }),
        call('task_create', readTask('Read and stop', 'executor')), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')], 2: [say('Done.')] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }), say('I read it and stopped here.')],
    } },
    { role: 'planner', kind: 'close', deliveries: { 1: closeLast('Read and closed') } },
  ],

  // TB-80、TB-82、team-tasks.md“入口”：两个会话都有 T1（标题、说明不同），切换与分屏时各看各的。
  'tb-tasks-pair-a': pairScenario('Alpha task', 'Alpha description: read the readme for alpha'),
  'tb-tasks-pair-b': pairScenario('Beta task', 'Beta description: read the readme for beta'),

  // TB-80：立项登记一个 task 后，对话的回复等 10 秒才开始写；套件在回复进行中打开模型菜单，点
  // See background tasks。T1（只读）读一个文件后等很久（之后的步骤让后台进程退出、重启 App）。
  'tb-tasks-menu': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Look at the menu', goal: 'The menu opens Background tasks' }),
        call('task_create', readTask('Read in the background', 'executor')), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [together(wait(10000), say('Planner registered it.'))] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }), together(wait(LONG), say('Never reached.'))],
    } },
  ],

  // TB-85：T1（只读）读一个文件后等很久，套件在这时重启 App；重新打开后它在 Finished，Stopped (Mori restarted)，
  // 会话从文件读出。
  'tb-tasks-restart': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Read slowly', goal: 'A slow read' }),
        call('task_create', readTask('Read slowly', 'executor')), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }), together(wait(LONG), say('Never reached.'))],
    } },
  ],
};
