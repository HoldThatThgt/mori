// 合成端点（synthetic）的脚本：tests/ui/tb-app-models.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-38 模型选择、TB-39 task 中途换模型、TB-40 候选耗尽、TB-41 调度类别、TB-47 继续会话时换了模型、
// TB-52 后台实例的模型提示，含交给结案时清掉），格式见 scripts.mjs 开头；名字都以 tb-models- 开头。
// 每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是这个会话里的投递序号。
// 故障只来自步骤里的 fail（模型 id 以 -404 结尾的模型由 server.mjs 对每个不是探针的请求返回 404）。
// 这里另外导出套件要比较的文字（MODELS_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, end, fail, say, together, wait } from '../steps.mjs';

/** 套件要比较的文字与时长 */
export const MODELS_TEXT = {
  /** 占住并发为 1 的提供商的对话请求各等多久（ms）：调度顺序、立项排队超时、task 与探针不超时 */
  holdOrderMs: 20000,
  holdDecisionMs: 80000,
  holdTaskMs: 100000,
  /** 留出的槽位：前三个 task 的第一个请求等多久（超过 60 秒的排队超时） */
  reserveMs: 70000,
  /** 换模型：fake-sw1 的 429 的 Retry-After（秒），fake-sw2 第一次回复前等多久（比它长，首选在重来时已恢复） */
  sw1RetryAfter: 3,
  sw2WaitMs: 6000,
  /** 重来的那一段第一次回复前等多久（进展摘要这一行没有模型提示） */
  restartWaitMs: 3000,
  /** 交给结案时清掉提示：fake-n2 第一次回复前等多久（这一行带着提示）、结案第一次回复前等多久（交到结案的这一行） */
  noteWaitMs: 3000,
  noteCloseWaitMs: 3000,
};

/** @brief 1..n。 */
const upTo = (n) => Array.from({ length: n }, (_, i) => i + 1);

/** @brief 协作模式下（分开时）对话 chat 的回复：k = 1..n 各一句，overrides 另写。 */
const chatTeam = (overrides = {}, n = 8) => ({ role: 'chat', kind: 'team-dialog',
  deliveries: Object.fromEntries(upTo(n).map((k) => [k, overrides[k] ?? [say(`Chat team reply ${k}.`)]])) });

/** @brief 关闭模式下对话 chat 的回复（有别的角色）。 */
const chatOff = (overrides = {}, n = 8) => ({ role: 'chat', kind: 'off-dialog',
  deliveries: Object.fromEntries(upTo(n).map((k) => [k, overrides[k] ?? [say(`Chat off reply ${k}.`)]])) });

/** @brief 关闭模式下没有角色文件的对话（v0 的会话）：k = 1..n。 */
const plainDialog = (overrides = {}, n = 4) => ({ role: 'mori', kind: 'dialog',
  deliveries: Object.fromEntries(upTo(n).map((k) => [k, overrides[k] ?? [say(`Plain reply ${k}.`)]])) });

/** @brief 立项 planner 按投递序号的步骤。 */
const planner = (deliveries) => ({ role: 'planner', kind: 'create', deliveries });

/** @brief 立项登记一个需求，建这些 task，再说一句。 */
const register = (title, tasks) => [
  call('request_submit', { title, goal: `${title} as asked` }),
  ...tasks.map((task) => call('task_create', { request: 1, description: `${task.title} for the test`,
    read_only: true, ...task })),
  say('Registered request 1.'),
];

/** @brief 结案关闭交来的 task（close_done），再关闭需求。 */
const closeAll = (role = 'planner') => ({ role, kind: 'close', deliveries: {
  1: [call('task_handoff', { task: '{task}', conclusion: 'Checked', outcome: 'close_done' }),
    call('request_close', { request: '{request}', outcome: 'done', conclusion: 'All checked' }),
    say('Request closed.')],
} });

/** @brief 一个 task 实例：读一个文件（可先等 waitMs），再带它的证据交接 outcome。 */
const readTask = (role, { task, waitMs = 0, outcome = 'done', next, path = 'README.md' } = {}) => ({ role, kind: 'task',
  ...(task ? { task } : {}), deliveries: {
    1: [together(wait(waitMs), call('read', { path })),
      call('task_handoff', { task: '{task}', conclusion: `${path} was read`, outcome,
        ...(next ? { next } : {}),
        ...(outcome === 'done' || outcome === 'pass' ? { evidence: ['{tag:read}'] } : {}) })],
  } });

/** @brief 一个 task 实例：不做别的，直接以 dead_end 交给结案。 */
const deadEndTask = (role) => ({ role, kind: 'task', deliveries: {
  1: [call('task_handoff', { task: '{task}', conclusion: 'Nothing to do here', outcome: 'dead_end' })],
} });

/** @brief 关闭模式下占住槽位的对话：第一个分块前等 ms。 */
const holder = (ms) => [plainDialog({ 1: [together(wait(ms), say('Released the slot.'))] })];

export const SCENARIOS = {
  // TB-41 调度类别的顺序（并发为 1 的 tbq1）：占住槽位的对话，然后排进队的探针（background）、task、立项（decision）、
  // 对话（conversation）；槽位空出来后端点按 conversation、decision、task、background 收到。
  'tb-models-hold-order': holder(MODELS_TEXT.holdOrderMs),
  'tb-models-order-conv': [plainDialog({ 1: [say('Conversation answered.')] })],
  'tb-models-order-task': [
    planner({ 1: register('Order task', [{ title: 'Queued task', assignee: 'executor' }]) }),
    chatTeam(), deadEndTask('executor'), closeAll(),
  ],
  'tb-models-order-dec': [planner({ 1: [say('No collaboration needed.')] }), chatTeam()],

  // TB-41 decision 排队超时换模型（tbq2 被占住 80 秒）：立项的请求排队 60 秒后换到 tbm/fake-main。
  'tb-models-hold-dec': holder(MODELS_TEXT.holdDecisionMs),
  'tb-models-dectime': [planner({ 1: [say('Answered after the queue timeout.')] }), chatTeam()],

  // TB-41 task、background 不超时（tbq3 被占住 100 秒）：task 的请求与探针一直排队，不换模型。
  'tb-models-hold-task': holder(MODELS_TEXT.holdTaskMs),
  'tb-models-tasknotime': [
    planner({ 1: register('Wait for the slot', [{ title: 'Patient task', assignee: 'executor' }]) }),
    chatTeam(), deadEndTask('executor'), closeAll(),
  ],

  // TB-41 留出的槽位（合并会话，范围 tbr/fake-r，并发 4）：四个只读 task，前三个的第一个请求等 70 秒，第四个排队；
  // 你插一句时对话的请求马上发出；第四个的请求在前面的结束后才发出，之后撤销需求。
  'tb-models-reserve': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: register('Four reads', upTo(4).map((n) => ({ title: `Read ${n}`, assignee: 'mori' }))),
      2: [say('Three tasks are running and one waits for a slot.')],
      3: [call('request_cancel', { request: 1, reason: 'Done measuring the slots' }), say('Cancelled request 1.')],
      4: [say('Request 1 was cancelled.')],
      5: [say('Nothing else to report.')],
    } },
    { role: 'mori', kind: 'task', task: 'T4', deliveries: { 1: [together(wait(60000), end())] } },
    { role: 'mori', kind: 'task', deliveries: {
      1: [together(wait(MODELS_TEXT.reserveMs), call('read', { path: 'README.md' })), together(wait(60000), end())],
    } },
  ],

  // TB-38 角色按自己的 models、requires 选；协作模式下锁定的模型按钮；思考强度只作用于对话会话。
  // chat 用 tbo/fake-other，planner 没写 models（会话的范围），executor 的 requires 排除 C 级的 tbc/fake-c。
  'tb-models-sel': [
    planner({ 1: register('Pick models', [{ title: 'Read with a picked model', assignee: 'executor' }]) }),
    chatTeam(), chatOff(),
    readTask('executor', { waitMs: 8000 }), closeAll(),
  ],

  // TB-38 differ_from: author：T1 executor 写了文件，reviewer 避开它的模型族；T2 只读过，reviewer 用首选。
  'tb-models-fam': [
    planner({ 1: register('Two reviews', [{ title: 'Write notes', assignee: 'executor', read_only: false },
      { title: 'Only read', assignee: 'executor' }]) }),
    chatTeam(),
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('write', { path: 'notes.txt', content: 'notes from T1\n' }),
        call('task_handoff', { task: '{task}', conclusion: 'Wrote notes.txt', outcome: 'continue', next: 'reviewer' })],
    } },
    readTask('executor', { task: 'T2', outcome: 'continue', next: 'reviewer' }),
    readTask('reviewer', { task: 'T1', outcome: 'pass', path: 'notes.txt' }),
    readTask('reviewer', { task: 'T2', outcome: 'pass', waitMs: 5000 }),
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Reviewed', outcome: 'close_done' }), say('Closed one.')],
      2: [call('task_handoff', { task: '{task}', conclusion: 'Reviewed', outcome: 'close_done' }),
        call('request_close', { request: '{request}', outcome: 'done', conclusion: 'Both reviewed' }), say('Closed.')],
    } },
  ],

  // TB-38 协作模式下对话会话被拒绝启动（chat 唯一的模型所在的提供商被删掉）：Turn off team mode，T1 变为 stopped。
  'tb-models-gone': [
    planner({ 1: register('Long work', [{ title: 'Long read', assignee: 'executor' }]) }),
    chatTeam(), chatOff(),
    { role: 'executor', kind: 'task', deliveries: {
      1: [together(wait(90000), call('read', { path: 'README.md' })), say('Too late.')],
    } },
  ],

  // TB-38 requires_unmet 与 probing 的原因，TB-40 task 实例候选耗尽交给结案：T1 picky 的候选一个是 C 级、
  // 一个正在探测（等满 60 秒），T2 pickyc 只有 C 级（不等）。
  'tb-models-picky': [
    planner({ 1: register('Picky models', [{ title: 'Wait for probing', assignee: 'picky' },
      { title: 'Tier C only', assignee: 'pickyc' }]) }),
    chatTeam(),
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'No model for it', outcome: 'close_failed' }),
        say('Closed one.')],
      2: [call('task_handoff', { task: '{task}', conclusion: 'No model for it either', outcome: 'close_failed' }),
        call('request_close', { request: '{request}', outcome: 'failed', conclusion: 'No model fits' }),
        say('Closed.')],
    } },
  ],

  // TB-39 task 中途换模型，TB-52 模型提示，TB-40 订阅候选耗尽：executor 的第一个请求在 fake-sw1 上 429（原地换到
  // fake-sw2）；fake-sw2 读完之后 429（已有过程：结束本轮，在 fake-sw3 上从工作卡重来）；需求关闭后 watcher 订阅
  // （它的模型总是 404）。
  'tb-models-sw': [
    planner({ 1: register('Switch models', [{ title: 'Read across models', assignee: 'executor' }]) }),
    chatTeam(),
    { role: 'executor', kind: 'task', deliveries: {
      1: [fail(429, { model: 'fake-sw1', retryAfter: MODELS_TEXT.sw1RetryAfter }),
        together(wait(MODELS_TEXT.sw2WaitMs), call('read', { path: 'README.md' })),
        fail(429, { model: 'fake-sw2', retryAfter: 60 }), end()],
      'restart-1': [together(wait(MODELS_TEXT.restartWaitMs), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'Read README.md on the new model', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    closeAll(),
  ],

  // TB-52 task 交给结案时清掉模型提示：executor 的第一个请求在 fake-n1 上 429（原地换到 fake-n2，进展摘要这一行
  // 带 Switched model 提示）；fake-n2 读完交给结案（这次运行里没有再换模型），结案等一会儿再关闭 T1 与需求。
  'tb-models-note': [
    planner({ 1: register('Note then close', [{ title: 'Read then hand over', assignee: 'executor' }]) }),
    chatTeam(),
    { role: 'executor', kind: 'task', deliveries: {
      1: [fail(429, { model: 'fake-n1', retryAfter: 60 }),
        together(wait(MODELS_TEXT.noteWaitMs), call('read', { path: 'README.md' })),
        call('task_handoff', { task: '{task}', conclusion: 'README.md was read', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [together(wait(MODELS_TEXT.noteCloseWaitMs), call('task_handoff', { task: '{task}', conclusion: 'Checked',
        outcome: 'close_done' })),
      call('request_close', { request: '{request}', outcome: 'done', conclusion: 'All checked' }),
      say('Request closed.')],
    } },
  ],

  // TB-40 立项判断你的消息时选不到模型（只有 C 级、要求 B）：按不需要协作，对话的工作卡写明 couldn't decide。
  'tb-models-cdead': [chatTeam()],

  // TB-40 程序唤醒的立项选不到模型：T1 need_user 唤醒立项，它的模型这次 404，程序唤醒对话转告你。
  'tb-models-cwake': [
    planner({ 1: register('Wake planner', [{ title: 'Ask the user', assignee: 'executor' }]),
      2: [fail(404, { model: 'fake-cw' }), say('Unreachable.')] }),
    chatTeam(),
    { role: 'executor', kind: 'task', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Which file should I read next?', outcome: 'need_user' })],
    } },
  ],

  // TB-40 结案选不到模型（closer 的模型总是 404）：交给它的 T1 交给立项（need_user）。
  'tb-models-closer': [
    planner({ 1: register('Closer down', [{ title: 'Read once', assignee: 'executor' }]),
      2: [say('Nothing to decide here.')], 3: [say('Still nothing.')] }),
    chatTeam(), readTask('executor'),
  ],

  // TB-40 对话候选耗尽（chat 的模型总是 404）：说明卡。立项不登记，消息交给对话。
  'tb-models-chat404': [planner({ 1: [say('No collaboration needed.')] })],

  // TB-40 临时提问候选耗尽（oracle 的模型总是 404）：发送方的工具结果报错并列出原因。
  'tb-models-ask': [chatOff({ 1: [call('agent_message', { to: 'oracle',
    text: 'What is in README.md? tb-scenario:tb-models-ask' }), say('Oracle said: {lastResult:agent_message}')] })],

  // TB-47 继续会话时首选被排除：executor 与 closer 在 fake-k1 上做完第一段；reviewer 在 fake-k1 上 404（之后它
  // not_found），executor 交回、closer 再次被唤醒时都从 fake-k2（档案要求推理回放）开始，段开始时重建。
  'tb-models-cont': [
    { role: 'planner', kind: 'create', deliveries: {
      1: register('Continue elsewhere', [{ title: 'Read twice', assignee: 'executor' }]),
    } },
    chatTeam(),
    { role: 'executor', kind: 'task', deliveries: {
      1: [call('read', { path: 'README.md' }), call('task_handoff', { task: '{task}', conclusion: 'README.md read',
        outcome: 'done', evidence: ['{tag:read}'] })],
      2: [call('read', { path: 'src/a.ts' }), call('task_handoff', { task: '{task}', conclusion: 'a.ts read too',
        outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'reviewer', kind: 'task', deliveries: {
      1: [fail(404, { model: 'fake-k1' }), call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Read a.ts as well', outcome: 'fail', next: 'executor' })],
    } },
    { role: 'closer', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Needs a review', outcome: 'continue', next: 'reviewer' }),
        say('Sent to review.')],
      2: [call('task_handoff', { task: '{task}', conclusion: 'Reviewed and read', outcome: 'close_done' }),
        call('request_close', { request: '{request}', outcome: 'done', conclusion: 'Read on two models' }),
        say('Closed.')],
    } },
  ],
};
