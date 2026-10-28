// 普通模式的 subagent 工具的 App 套件用的脚本（synthetic，tests/ui/sa-app.mjs；docs/specs/subagent.md §14.1）。
// 主 Agent 是关闭模式的对话（没有角色文件时种类为 dialog，有别的角色时为 off-dialog）；每个 subagent 的种类为 subagent，
// 同一次调用开出的几个按提示里的关键词（match）分开。提示里带 tb-scenario:<名字>，subagent 的请求才进脚本模式。
// 文字与关键词导出给套件核对。

// 2026-10-28 起 echo 是只读命令，在每种模式下都不问（file-system-permissions.md §6.1）；要批准的命令写成
// echo … | tee（tee 不在只读名单里，没有文件参数时不写文件，输出不变）。
import { call, say, together, wait } from '../steps.mjs';

/** 套件要核对的固定文字 */
export const SA_TEXT = {
  hello: 'Hello from the main agent.',
  partA: 'PART-A: README.md describes the project.',
  partB: 'PART-B: src/a.ts exports add.',
  partC: 'PART-C: the folder has README.md and src.',
  parallelDone: 'All three subagents reported back.',
  refusedDone: 'The call was refused.',
  slotDone: 'Six subagents finished.',
  ran: 'RAN-THE-ECHO',
  denied: 'DENIED-AND-STOPPED',
  readOnly: 'READ-ONLY-SAW-README',
  readOnlyRan: 'READ-ONLY-RAN-THE-COMMAND',
  approvalDone: 'The approval round is over.',
  reloadOne: 'RELOAD-ONE-DONE',
  reloadTwo: 'RELOAD-TWO-DONE',
  edited: 'EDITED-A-TS',
  looked: 'LOOKED-AT-README',
  reviewed: 'REVIEWED-A-TS',
  base: 'BASE-PART-DONE',
  rolesDone: 'Roles round over.',
  taskMode: 'Hello from task mode.',
  queuedDone: 'The queued call ran after the command.',
  queueRead: 'QUEUED-READ-DONE',
  queueList: 'QUEUED-LIST-DONE',
};

/** @brief 一项（提示里带脚本名与关键词）。 */
const item = (scenario, key, description, rest, extra = {}) => ({ description,
  prompt: `tb-scenario:${scenario} ${key}: ${rest}`, ...extra });

/** sa-parallel 的三项：两个只读、一个通用 */
export const PARALLEL_TASKS = [
  item('sa-parallel', 'part-a', 'Map the readme', 'read README.md and say what it covers.', { read_only: true }),
  item('sa-parallel', 'part-b', 'Check the source', 'read src/a.ts and report what it exports.'),
  item('sa-parallel', 'part-c', 'List the folder', 'list the project folder.', { read_only: true }),
];

/** sa-parallel 第二回合被拒绝的一项：没有别的角色却写了 role */
export const REFUSED_TASKS = [item('sa-parallel', 'refused', 'Ask a role', 'this never runs.', { role: 'reviewer' })];

/** sa-slots 的六项（都是只读的） */
export const SLOT_TASKS = [1, 2, 3, 4, 5, 6].map((n) => item('sa-slots', `slot-${n}`, `Slot part ${n}`,
  `answer with SLOT-${n}.`, { read_only: true }));

/** sa-approval 的三项：两个通用（一个被允许、一个被拒绝）、一个只读 */
export const APPROVAL_TASKS = [
  item('sa-approval', 'appr-run', 'Run the echo', 'run echo sa-approved.'),
  item('sa-approval', 'appr-deny', 'Try a command', 'run echo deny-me.'),
  item('sa-approval', 'appr-read', 'Read the readme', 'read README.md.', { read_only: true }),
];

/** sa-ro-approval 的一项：只读 subagent 跑一条不是只读命令的命令（2026-10-28 起要批准，subagent.md SA-12） */
export const RO_APPROVAL_TASKS = [
  item('sa-ro-approval', 'ro-cmd', 'Pipe the note', 'run echo sa-ro-ran | tee.', { read_only: true }),
];

/** sa-stop 的两项：一个通用的跑命令（等批准）、一个只读的很慢 */
export const STOP_TASKS = [
  item('sa-stop', 'stop-1', 'Slow part one', 'take your time.'),
  item('sa-stop', 'stop-2', 'Slow part two', 'take your time.', { read_only: true }),
];

/** sa-reload 的两项：只读的慢慢读、通用的跑命令（等批准） */
export const RELOAD_TASKS = [
  item('sa-reload', 'reload-1', 'Reload part one', 'read README.md slowly.', { read_only: true }),
  item('sa-reload', 'reload-2', 'Reload part two', 'answer slowly.'),
];

/** sa-kill 的一项：慢到后台进程被结束 */
export const KILL_TASKS = [item('sa-kill', 'kill-1', 'Outlive the kernel', 'take a long time.')];

/** sa-edit 的两次：一个只读的看文件，一个通用的改文件 */
export const LOOK_TASKS = [item('sa-edit', 'look', 'Look at the readme', 'read README.md.', { read_only: true })];
export const EDIT_TASKS = [item('sa-edit', 'edit', 'Edit a.ts', 'change src/a.ts.')];

/** sa-roles 的三项：reviewer（范围里的模型）、loner（只有范围外的模型）、基座 */
export const ROLE_TASKS = [
  item('sa-roles', 'roles-rev', 'Review a.ts', 'review src/a.ts.', { role: 'reviewer', read_only: true }),
  item('sa-roles', 'roles-lone', 'Lonely part', 'this cannot run.', { role: 'loner' }),
  item('sa-roles', 'roles-base', 'Base part', 'say you are done.'),
];

/** sa-roles 第三回合：role 写了这个项目没有的角色（被 §3.3 的检查拒绝，不开实例） */
export const GHOST_TASKS = [item('sa-roles', 'roles-ghost', 'Ghost part', 'this never runs.', { role: 'ghost' })];

/** sa-queued 的两项（只读）：同一个回复里排在一条要批准的命令之后 */
export const QUEUED_TASKS = [
  item('sa-queued', 'queue-read', 'Read after the command', 'read README.md.', { read_only: true }),
  item('sa-queued', 'queue-list', 'List after the command', 'list the project folder.', { read_only: true }),
];

/** @brief 一个 subagent 条目（基座或 role），按关键词认出。 */
const helper = (scenario, match, steps, role = 'mori') => ({ role, kind: 'subagent', match,
  deliveries: { 1: steps } });

export const SCENARIOS = {
  // 没有调用 subagent 的一回合（工具清单、system prompt、没有实例与 teams/ 下的文件）
  // 第二条（会话里的第 2 条消息）用 /task 发：Task mode 下的合并会话（基座持有三项权限）没有 subagent
  'sa-normal': [{ role: 'mori', kind: 'dialog', deliveries: { 1: [say(SA_TEXT.hello)] } },
    { role: 'mori', kind: 'merged-create', deliveries: { 2: [call('reply_via_dialog', {}), say(SA_TEXT.taskMode)] } },
    { role: 'chat', kind: 'off-dialog', deliveries: { 1: [say(SA_TEXT.hello)] } }],
  // 三个 subagent 同时跑；第二回合的调用被拒绝
  'sa-parallel': [
    { role: 'mori', kind: 'dialog', deliveries: {
      1: [call('subagent', { tasks: PARALLEL_TASKS }), say(SA_TEXT.parallelDone)],
      2: [call('subagent', { tasks: REFUSED_TASKS }), say(SA_TEXT.refusedDone)],
    } },
    helper('sa-parallel', 'part-a', [together(wait(1500), call('read', { path: 'README.md' })), say(SA_TEXT.partA)]),
    helper('sa-parallel', 'part-b', [together(wait(1500), call('read', { path: 'src/a.ts' })), say(SA_TEXT.partB)]),
    // 只读 subagent 的工具同基座（没有 ls，2026-10-27 文件系统合并后，U51）：列文件夹改为读 README.md
    helper('sa-parallel', 'part-c', [together(wait(1500), call('read', { path: 'README.md' })), say(SA_TEXT.partC)]),
  ],
  // 并发 4 的 key 上六个 subagent
  'sa-slots': [
    { role: 'mori', kind: 'dialog',
      deliveries: { 1: [call('subagent', { tasks: SLOT_TASKS }), say(SA_TEXT.slotDone)] } },
    ...SLOT_TASKS.map((_, i) => helper('sa-slots', `slot-${i + 1}`, [together(wait(2500), say(`SLOT-${i + 1}`))])),
  ],
  // 通用 subagent 跑命令要批准；只读的不要
  'sa-approval': [
    { role: 'mori', kind: 'dialog', deliveries: {
      1: [call('subagent', { tasks: APPROVAL_TASKS }), say(SA_TEXT.approvalDone)],
      2: [call('subagent', { tasks: APPROVAL_TASKS }), say(SA_TEXT.approvalDone)],
    } },
    helper('sa-approval', 'appr-run', [call('bash', { command: 'echo sa-approved | tee' }), say(SA_TEXT.ran)]),
    helper('sa-approval', 'appr-deny', [together(wait(800), call('bash', { command: 'echo deny-me | tee' })),
      say(`${SA_TEXT.denied} {lastResult:bash}`)]),
    helper('sa-approval', 'appr-read', [call('read', { path: 'README.md' }), say(SA_TEXT.readOnly)]),
  ],
  // 只读 subagent 跑不是只读命令的命令：同通用的出带归属的批准卡，允许后执行（2026-10-28 照 Claude 的做法）
  'sa-ro-approval': [
    { role: 'mori', kind: 'dialog', deliveries: {
      1: [call('subagent', { tasks: RO_APPROVAL_TASKS }), say(SA_TEXT.approvalDone)] } },
    helper('sa-ro-approval', 'ro-cmd', [call('bash', { command: 'echo sa-ro-ran | tee' }),
      say(`${SA_TEXT.readOnlyRan} {lastResult:bash}`)]),
  ],
  // 一个等批准、一个很慢的 subagent，等你停止
  'sa-stop': [
    { role: 'mori', kind: 'dialog', deliveries: { 1: [call('subagent', { tasks: STOP_TASKS }), say('unused')] } },
    helper('sa-stop', 'stop-1', [call('bash', { command: 'echo stop-me | tee' }), say('never')]),
    helper('sa-stop', 'stop-2', [together(wait(30000), say('never'))]),
  ],
  // 界面重新载入时还在跑的两个 subagent（一个在读、一个在等批准）
  'sa-reload': [
    { role: 'mori', kind: 'dialog', deliveries: { 1: [call('subagent', { tasks: RELOAD_TASKS }), say('Reloaded.')] } },
    helper('sa-reload', 'reload-1', [together(wait(3000), call('read', { path: 'README.md' })),
      together(wait(2000), say(SA_TEXT.reloadOne))]),
    helper('sa-reload', 'reload-2', [together(wait(2000), call('bash', { command: 'echo reload-ok | tee' })),
      say(SA_TEXT.reloadTwo)]),
  ],
  // 后台进程被结束时还在跑的 subagent
  'sa-kill': [
    { role: 'mori', kind: 'dialog', deliveries: { 1: [call('subagent', { tasks: KILL_TASKS }), say('unused')] } },
    helper('sa-kill', 'kill-1', [together(wait(60000), say('never'))]),
  ],
  // 只读的看文件、通用的改文件（右栏的说明）
  'sa-edit': [
    { role: 'mori', kind: 'dialog', deliveries: {
      1: [call('subagent', { tasks: LOOK_TASKS }), say('Looked.')],
      2: [call('subagent', { tasks: EDIT_TASKS }), say('Edited.')],
    } },
    helper('sa-edit', 'look', [call('read', { path: 'README.md' }), say(SA_TEXT.looked)]),
    helper('sa-edit', 'edit', [call('edit', { path: 'src/a.ts',
      edits: [{ oldText: 'return a + b;', newText: 'return a + b + 0;' }] }), say(SA_TEXT.edited)]),
  ],
  // 角色：reviewer 用范围里的 fake-b，loner 选不到模型，基座照常；第二回合只开 loner（全部失败）；第三回合写了没有的角色
  'sa-roles': [
    { role: 'chat', kind: 'off-dialog', deliveries: {
      1: [call('subagent', { tasks: ROLE_TASKS }), say(SA_TEXT.rolesDone)],
      2: [call('subagent', { tasks: [ROLE_TASKS[1]] }), say(SA_TEXT.rolesDone)],
      3: [call('subagent', { tasks: GHOST_TASKS }), say(SA_TEXT.rolesDone)],
    } },
    helper('sa-roles', 'roles-rev', [call('read', { path: 'src/a.ts' }), say(SA_TEXT.reviewed)], 'reviewer'),
    helper('sa-roles', 'roles-base', [say(SA_TEXT.base)]),
  ],
  // 同一个回复里先一条要批准的命令、后一次 subagent：命令的批准卡挂着时 subagent 的卡是 Queued
  'sa-queued': [
    { role: 'mori', kind: 'dialog', deliveries: {
      1: [together(call('bash', { command: 'echo before-the-agents | tee' }),
        call('subagent', { tasks: QUEUED_TASKS })),
        say(SA_TEXT.queuedDone)],
    } },
    helper('sa-queued', 'queue-read', [call('read', { path: 'README.md' }), say(SA_TEXT.queueRead)]),
    helper('sa-queued', 'queue-list', [call('read', { path: 'README.md' }), say(SA_TEXT.queueList)]),
  ],
};
