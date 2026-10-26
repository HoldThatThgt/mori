// 合成端点（synthetic）的脚本：tests/ui/tb-app-stop.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-34 后台批准卡、TB-35 停止、TB-36 重新载入与重启、TB-42 归档、删除与关闭；另有 TB-54 输入框下面一行的宽度），
// 格式见 scripts.mjs 开头；
// 名字都以 tb-stop- 开头。每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是这个会话里的投递序号。
// 分开配置（chat / planner / executor / reviewer，tb-helpers SPLIT_ROLES）的场景里 planner 持有立项与结案；
// 合并会话的场景（没有角色文件）里基座 mori 持有三项权限。等很久的步骤（wait）是让套件在那一刻停止、重新载入或退出。

import { call, end, say, together, wait } from '../steps.mjs';

/** 等到被停止、重新载入或退出的步骤：比套件里任何一次等待都长 */
const LONG = 120000;

/** @brief 一次 read，再带它的证据以 done 交接（task 实例）。 */
const readThenDone = (path, conclusion) => [call('read', { path }),
  call('task_handoff', { task: '{task}', conclusion, outcome: 'done', evidence: ['{tag:read}'] })];

/** @brief 结案关闭交来的 task（close_done），然后说一句。 */
const closeTask = (conclusion, after) => [call('task_handoff', { task: '{task}', conclusion, outcome: 'close_done' }),
  say(after)];

/** @brief 结案关闭交来的 task，再关闭这个需求。 */
const closeLast = (conclusion) => [call('task_handoff', { task: '{task}', conclusion, outcome: 'close_done' }),
  call('request_close', { request: '{request}', outcome: 'done', conclusion }), say('Request closed.')];

/** @brief 一个写 task 的建立参数。 */
const writeTask = (title, assignee, extra = {}) => ({ request: 1, title, description: title, assignee,
  read_only: false, ...extra });
/** @brief 一个只读 task 的建立参数。 */
const readTask = (title, assignee, extra = {}) => ({ request: 1, title, description: title, assignee,
  read_only: true, ...extra });

export const SCENARIOS = {
  // TB-34：关闭模式下对话自己的命令先出一张卡（approval-1）；然后 /task：T1 executor 的 board_read（不出卡）、
  // 允许一次（Alt+1）、拒绝带理由（Alt+3）、并行两条中第一条选本会话不再询问（Alt+2，第二条与之后的不再问）；
  // T2 reviewer 的命令不再问，写入出卡后切到全部允许；T3 executor（新实例）的写入不出卡。
  'tb-stop-approve': [
    { role: 'chat', kind: 'off-dialog', deliveries: {
      1: [call('bash', { command: 'echo from-dialog' }), say('The dialog ran a command.')],
    } },
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Run commands', goal: 'Commands run under approval' }),
        call('task_create', writeTask('Run commands', 'executor')),
        call('task_create', writeTask('Check commands', 'reviewer', { depends_on: ['T1'] })),
        call('task_create', writeTask('Final write', 'executor', { depends_on: ['T2'] })),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      2: [together(wait(8000), say('Planner registered it.'))],
      3: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('board_read', {}), call('bash', { command: 'echo one' }), call('bash', { command: 'echo two' }),
        together(call('bash', { command: 'echo three' }), call('bash', { command: 'echo four' })),
        call('bash', { command: 'echo five' }),
        call('task_handoff', { task: '{task}', conclusion: 'Commands ran', outcome: 'done',
          evidence: ['{tag:bash}'] })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T2', deliveries: {
      1: [call('bash', { command: 'echo six' }), call('write', { path: 'review.txt', content: 'reviewed\n' }),
        call('write', { path: 'review2.txt', content: 'again\n' }),
        call('task_handoff', { task: '{task}', conclusion: 'Checked', outcome: 'done', evidence: ['{tag:write}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [call('write', { path: 'final.txt', content: 'final\n' }),
        call('task_handoff', { task: '{task}', conclusion: 'Written', outcome: 'done', evidence: ['{tag:write}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: closeTask('Commands ran', 'T1 closed.'),
      2: closeTask('Checked', 'T2 closed.'),
      3: closeLast('Commands ran under approval'),
    } },
  ],

  // TB-35 Stop team：T1（写）的命令挂着批准卡；T2 交给结案、结案在处理（等很久）；T3 reviewer 等 planner 的回复
  // （agent_message 进立项会话，立项的这次程序唤醒的运行等很久）；T4 交给结案时结案在忙（排在结案的投递队列里）；
  // 你的第二条消息在待判断。Stop team 之后：第三条消息让立项把 T3 交回 reviewer（继续原来的会话），第四条撤销需求。
  'tb-stop-team': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Big job', goal: 'Several things at once' }),
        call('task_create', writeTask('Run a command', 'executor')),
        call('task_create', readTask('Quick read', 'executor')),
        call('task_create', readTask('Ask planner', 'reviewer')),
        call('task_create', readTask('Late read', 'executor')),
        say('Registered request 1 with four tasks.')],
      2: [together(wait(LONG), say('The planner answers the reviewer.'))],
      3: [call('request_update', { request: 1 }), call('task_edit', { task: 'T3' }), say('Handed T3 back.')],
      4: [call('request_cancel', { request: 1, reason: 'Done testing Stop team' }), say('Cancelled request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], 2: [say('Continuing T3.')], 3: [say('Cancelled.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('bash', { command: 'echo waiting-for-approval' }), end()],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: { 1: readThenDone('README.md', 'README read') } },
    { role: 'reviewer', kind: 'task', task: 'T3', deliveries: {
      1: [call('agent_message', { to: 'planner', text: 'Which file should I check?', wait: true }), end()],
      2: readThenDone('README.md', 'Checked README'),
    } },
    { role: 'executor', kind: 'task', task: 'T4', deliveries: {
      1: [together(wait(5000), call('read', { path: 'src/a.ts' })),
        call('task_handoff', { task: '{task}', conclusion: 'a.ts read', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [together(wait(LONG), call('task_handoff', { task: '{task}', conclusion: 'Late', outcome: 'close_done' })),
        end()],
      2: closeTask('Review done', 'T3 closed.'),
    } },
  ],

  // TB-35 Esc：一次判断登记两个需求（T1 要 8 秒、T2 要 16 秒）；第二条消息的回复等 20 秒，其间需求 1 关闭，
  // request_closed 汇报排在用户会话的投递队列里；Esc 之后它照常开始，T2 照常做完、需求 2 关闭后再汇报一次。
  'tb-stop-esc': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Quick job', goal: 'A quick read' }),
        call('task_create', readTask('Quick read', 'executor')),
        call('request_submit', { title: 'Slow job', goal: 'A slow read' }),
        call('task_create', { ...readTask('Slow read', 'executor'), request: 2 }),
        say('Registered two requests.')],
      2: [say('Nothing to decide.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered two requests.')],
      2: [together(wait(20000), say('A long story.'))],
      3: [say('Request 1 is done.')],
      4: [say('Request 2 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(8000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Quick read done', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [together(wait(16000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Slow read done', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: { 1: closeLast('The read is done') } },
  ],

  // TB-35 Esc 时立项在判断第二条消息：协作模式（开关打开），第一条消息的回复等很久；回复中你又发三条：第一条判断完
  // 交给 pi 排队，判断第二条时等很久，第三条在等判断。Esc 之后都停下，三条按发送顺序回到输入框，没有新的回复。
  'tb-stop-escjudge': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [say('Nothing to register.')],
      2: [say('Nothing to register either.')],
      3: [together(wait(LONG), say('Judged the second message.'))],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [together(wait(LONG), say('A long reply.'))] } },
  ],

  // TB-35 Stop team 时对话在为第一条消息准备中（等立项判断它，等很久），第二条在等判断：两条按发送顺序回到输入框。
  'tb-stop-stopprep': [
    { role: 'planner', kind: 'create', deliveries: { 1: [together(wait(LONG), say('unreachable'))] } },
  ],

  // TB-35 合并会话里 Esc：T1 交接 need_user 时用户会话在回复第二条消息（等 20 秒），create_wake 排在投递队列里；
  // Esc 之后它照常开始（程序唤醒的回合问你）。
  'tb-stop-escmerged': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Summarize a part', goal: 'Summarize the part the user picks' }),
        call('task_create', readTask('Read README', 'mori')), say('Registered request 1.')],
      2: [together(wait(20000), say('A long answer.'))],
      3: [say('T1 needs your decision: which part?')],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(8000), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Which part should I summarize?', outcome: 'need_user' })],
    } },
  ],

  // TB-35 Stop team 拿回 pi 排队区的消息（合并会话）：第一条消息的回复等很久，T1 在后台等很久（Stop team 才显示）；
  // 回复中你又发的一条交给 pi 排队。Stop team 之后它回到输入框，之后没有请求。
  'tb-stop-piqueue': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Queue then stop', goal: 'Stop team takes back the queued message' }),
        call('task_create', readTask('Long read', 'mori')), together(wait(LONG), say('unreachable'))],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(LONG), call('read', { path: 'README.md' })), end()],
    } },
  ],

  // TB-36 界面重新载入：T1 的命令挂着批准卡，第二条消息立项要判断 30 秒；重新载入后都接上，后台照常做完。
  'tb-stop-reload': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Reload job', goal: 'Survive a reload' }),
        call('task_create', writeTask('Reload job', 'executor')), say('Registered request 1.')],
      2: [together(wait(30000), say('No decision needed.'))],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], 2: [say('Answered after the reload.')], 3: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('bash', { command: 'echo before-reload' }),
        together(wait(4000), call('bash', { command: 'echo after-reload' })),
        call('task_handoff', { task: '{task}', conclusion: 'Ran across the reload', outcome: 'done',
          evidence: ['{tag:bash}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: { 1: closeLast('Survived the reload') } },
  ],

  // TB-42：T1 在后台跑很久（对话空闲）；第二条消息立项判断很久（待判断）；Stop team 之后删除会话。
  'tb-stop-del': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Background job', goal: 'Run in the background' }),
        call('task_create', readTask('Background read', 'executor')), say('Registered request 1.')],
      2: [together(wait(LONG), say('unreachable'))],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Planner registered it.')] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(LONG), call('read', { path: 'README.md' })), end()],
    } },
  ],

  // TB-36 重启 R1：T1（写）的命令挂着批准卡，T2 交给结案、结案在处理时退出；重新打开后你让立项交回 T2，结案被唤醒。
  'tb-stop-r1': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Restart job', goal: 'Survive a restart' }),
        call('task_create', writeTask('Pending command', 'executor')),
        call('task_create', readTask('Quick read', 'executor')), say('Registered request 1.')],
      2: [call('request_update', { request: 1 }), call('task_edit', { task: 'T2' }), say('Handed T2 back.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], 2: [say('T2 is back with the planner.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('bash', { command: 'echo pending-at-exit' }), end()],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: { 1: readThenDone('README.md', 'README read') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [together(wait(LONG), call('task_handoff', { task: '{task}', conclusion: 'Late', outcome: 'close_done' })),
        end()],
      2: closeTask('README read after the restart', 'T2 closed.'),
    } },
  ],

  // TB-36 重启 R2：T1 完成、结案关了 T1 之后还没关闭需求就退出；重新打开后你的下一条消息唤醒结案，它关闭需求。
  'tb-stop-r2': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Ended job', goal: 'All tasks end before the exit' }),
        call('task_create', readTask('Done read', 'executor')), say('Registered request 1.')],
      2: [say('Nothing new to decide.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], 2: [say('Nothing new.')], 3: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: readThenDone('README.md', 'README read') } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'README read', outcome: 'close_done' }),
        together(wait(LONG), say('unreachable'))],
      2: [call('request_close', { request: '{request}', outcome: 'done', conclusion: 'Closed after the restart' }),
        say('Request 1 closed.')],
    } },
  ],

  // TB-36 重启 R3：T1 交给 reviewer、reviewer 在做时退出，退出前删掉 reviewer.md；重新打开后交回 T1 时交给结案。
  'tb-stop-r3': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Review job', goal: 'Review the README' }),
        call('task_create', readTask('Check README', 'executor')), say('Registered request 1.')],
      2: [call('request_update', { request: 1 }), call('task_edit', { task: 'T1' }), say('Handed T1 back.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered it.')], 2: [say('T1 went to closing.')], 3: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Ready for review', outcome: 'continue',
          next: 'reviewer' })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(LONG), call('read', { path: 'README.md' })), end()],
    } },
    { role: 'planner', kind: 'close', deliveries: { 1: closeLast('Closed without the reviewer') } },
  ],

  // TB-36 重启 R4（合并会话）：登记需求之后、这次判断结束之前退出（还没写 mori.progress）；重新打开时补写。
  'tb-stop-r4': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Registered then exit', goal: 'Exit right after registering' }),
        together(wait(LONG), say('unreachable'))],
    } },
  ],

  // composer-pickers 输入框下面一行（docs/v0/screens/models.md"窄栏"）：协作模式下 T1 executor 在后台读很久、对话的回复
  // 也等很久，这时套件在各宽度量这一行（Stop team、锁定的模型按钮、≤ 340px 收起"Queue ▾"），量完按 Stop team。
  'tb-stop-row': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Row job', goal: 'Something runs in the background' }),
        call('task_create', readTask('Read for a long time', 'executor')), say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [together(wait(LONG), say('unreachable'))] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [together(wait(LONG), call('read', { path: 'README.md' })), end()],
    } },
  ],
  // 同一步里分屏左边那一栏的会话（关闭模式，回复一句）。
  'tb-stop-row2': [
    { role: 'chat', kind: 'off-dialog', deliveries: { 1: [say('Other pane reply.')] } },
  ],
};
