// 合成端点（synthetic）的脚本：tests/ui/tb-app-modes.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-05 协作模式的进入与结束、TB-06 立项的决定、TB-07 用户原话照记、TB-08 回执、TB-11 立项看着整个对话、
// TB-54 阶段行与 Stop team、TB-56 待判断的消息），格式见 scripts.mjs 开头；名字都以 tb-modes- 开头。
// 每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是这个会话里的投递序号。
// 对话会话的回复多数是通用的一句（chatTeam / chatOff 按 k 生成，个别 k 另写），task 与结案用 quickTask / quickClose。
// 这里另外导出套件要比较的文字（MODES_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, fail, say, think, together, wait } from '../steps.mjs';

/** @brief 1..n。 */
const upTo = (n) => Array.from({ length: n }, (_, i) => i + 1);

/** 长消息（立项程序唤醒的回合里引用它的一段，回执截到 120 个字符）；中间有连续空白，quote 里写成一个空格 */
const LONG_WORDS = 'Plan the  release   notes: collect every merged change, group the changes by area, and write one '
  + 'short line for each group so that readers see what changed and why it matters to them.';

/** 套件要比较的文字 */
export const MODES_TEXT = {
  /** 同名提示词模板 .pi/prompts/team.md 展开后的标记（不应出现在任何请求里） */
  teamTemplate: 'TEAM-TEMPLATE-EXPANDED',
  /** 提示词模板 .pi/prompts/tbtmpl.md 展开后的开头 */
  tmplBody: 'TEMPLATE-BODY for',
  /** 扩展命令 /tbcmd 用 sendUserMessage 发出的文字（后面接参数） */
  cmdText: 'Command message tb-scenario:tb-modes-cmd',
  /** 关闭模式下对话回复里的思考（立项的投递里不应出现） */
  thinking: 'SECRET-THINKING-ONE',
  /** tb-modes-error 的消息（/team 之后的文字） */
  longMessage: `tb-scenario:tb-modes-error ${LONG_WORDS}`,
  /** 程序唤醒的回合里引用的原话（连续空白写成一个空格；对应 longMessage 里原样的一段） */
  quote: LONG_WORDS.replace(/\s+/g, ' '),
  /** 合并会话里补充的长消息（超过 120 个字符） */
  mergedLong: 'Also make sure that every heading in the summary uses sentence case and that the summary never '
    + 'mentions internal ticket numbers or names of people.',
  /** 并发为 1 的提供商 tbq 上的模型（tb-modes-held 在它上面 429） */
  modelQ: 'fake-coder-tbmodes-q',
  /** 关闭模式下可以引用的回复 */
  quotable: 'QUOTE-ME alpha beta gamma delta',
};

/** @brief 协作模式下（分开时）对话 chat 的回复：k = 1..n 各一句，overrides 另写。 */
const chatTeam = (overrides = {}, n = 12) => ({ role: 'chat', kind: 'team-dialog',
  deliveries: Object.fromEntries(upTo(n).map((k) => [k, overrides[k] ?? [say(`Chat team reply ${k}.`)]])) });

/** @brief 关闭模式下对话 chat 的回复（有别的角色）。 */
const chatOff = (overrides = {}, n = 12) => ({ role: 'chat', kind: 'off-dialog',
  deliveries: Object.fromEntries(upTo(n).map((k) => [k, overrides[k] ?? [say(`Chat off reply ${k}.`)]])) });

/** @brief 立项 planner 按投递序号的步骤。 */
const planner = (deliveries) => ({ role: 'planner', kind: 'create', deliveries });

/** @brief 一个 task 实例：读一个文件（可先等 waitMs），再带它的证据交接 done。 */
const quickTask = (role = 'executor', waitMs = 0) => ({ role, kind: 'task', deliveries: {
  1: [together(wait(waitMs), call('read', { path: 'README.md' })),
    call('task_handoff', { task: '{task}', conclusion: 'README.md was read', outcome: 'done',
      evidence: ['{tag:read}'] })],
} });

/** @brief 一个很久不结束的 task 实例（之后撤销或 Stop team）。 */
const longTask = (role = 'executor') => ({ role, kind: 'task', deliveries: {
  1: [together(wait(60000), call('read', { path: 'README.md' })), say('Too late.')],
} });

/** @brief 结案：关闭交来的 task 与需求（一个需求一个 task）。 */
const quickClose = (role = 'planner') => ({ role, kind: 'close', deliveries: {
  1: [call('task_handoff', { task: '{task}', conclusion: 'Done and verified', outcome: 'close_done' }),
    call('request_close', { request: '{request}', outcome: 'done', conclusion: 'All done' }), say('Closed.')],
} });

/** @brief 登记一个需求并建一个只读 task。 */
const registerOne = (title, assignee = 'executor', after = say('Registered request 1.')) => [
  call('request_submit', { title, goal: `${title} is done` }),
  call('task_create', { request: 1, title: 'Read it', description: 'Read README.md', assignee,
    limits: { write: false } }),
  after];

export const SCENARIOS = {
  // TB-05 /team <文字>（带引用芯片、同名模板不展开）进入 once，需求关闭、汇报的回合结束时回到 off；TB-08 分开时回执的位置。
  'tb-modes-once': [
    chatOff({ 1: [say(MODES_TEXT.quotable)] }),
    planner({ 1: registerOne('Once request') }),
    chatTeam({ 2: [together(wait(1500), say('Planner registered request 1.'))], 3: [say('Request 1 is done.')] }),
    quickTask('executor', 5000), quickClose(),
  ],
  // TB-05 开关、/team on、/team off、只有 /team（只有一条关闭模式的回复可以引用）。
  'tb-modes-switch': [chatOff({ 1: [say('CHIP-SOURCE one two three four')] })],
  // TB-05 回到 off 的条件只缺“没有未关闭的需求”：task 还在做时关掉开关 → once。
  'tb-modes-open': [
    planner({ 1: registerOne('Open request') }), chatTeam(), quickTask('executor', 9000), quickClose(),
  ],
  // TB-05 只缺“待判断队列为空”：对话发消息给 planner（立项会话里一次程序唤醒的回合，很久），这时你发的消息在等。
  'tb-modes-queue': [
    planner({ 1: [say('Answer directly.')], 2: [together(wait(8000), say('Thought about it.'))],
      3: [say('No work.')] }),
    chatTeam({ 1: [call('agent_message', { to: 'planner', text: 'Think about the roadmap please.' }),
      say('Asked planner.')] }),
  ],
  // TB-05 只缺“立项没有在判断的消息”（合并会话：判断就在用户会话这次运行里）；TB-54 合并会话不显示 is deciding。
  'tb-modes-judging': [
    { role: 'mori', kind: 'merged-create',
      deliveries: { 1: [together(wait(6000), say('No collaboration needed.'))] } },
  ],
  // TB-05 关闭模式的运行中打开协作模式：这次运行的第二个请求仍是关闭模式的工具、没有工作卡、关闭模式的段。
  'tb-modes-runon': [
    chatOff({ 1: [together(wait(5000), call('read', { path: 'README.md' })), say('Read it.')] }),
    planner({ 1: [say('Answer directly.')] }), chatTeam({ 2: [say('Team reply.')] }),
  ],
  // TB-05 协作模式的运行中关掉：这次运行的第二个请求仍是协作模式的工具、工作卡与段。
  'tb-modes-runoff': [
    planner({ 1: [say('Direct answer.')] }),
    chatTeam({ 1: [together(wait(5000), call('read', { path: 'README.md' })), say('Read it.')] }),
    chatOff({ 2: [say('Off reply.')] }),
  ],
  // TB-06、TB-07、TB-08：一次判断一种决定、先记原话；立项判断第一条时又来两条，各自一次判断；没做决定按直接回答。
  'tb-modes-decide': [
    planner({
      1: [together(wait(4000), call('task_create', { request: 1, title: 'Too early', description: 'Read README.md',
        assignee: 'executor', limits: { write: false } })),
      call('request_submit', { title: 'First request', goal: 'The first thing works' }),
      call('request_submit', { title: 'Second request', goal: 'The second thing works' }),
      call('request_cancel', { request: 1, reason: 'Changed my mind' }),
      call('reply_via_dialog', { note: 'Nothing to do' }),
      call('task_create', { request: 1, title: 'Task one', description: 'Read README.md', assignee: 'executor',
        limits: { write: false } }),
      call('task_create', { request: 2, title: 'Task two', description: 'Read README.md', assignee: 'executor',
        limits: { write: false } }),
      say('Two requests registered.')],
      2: [say('No work needed.')],
      3: [call('request_update', { request: 1 }), call('reply_via_dialog', { note: 'Also answer' }),
        say('Added the constraint.')],
    }),
    chatTeam(), quickTask('executor', 8000), quickClose(),
  ],
  // TB-06 立项出错（已登记的照常有效，对话卡片 couldn't decide）、没有 task 的提醒与唤醒结案、程序唤醒的回合不能登记撤销；
  // TB-07 程序唤醒的回合 quote 必须给出且必须是原话；TB-08 程序唤醒回合的回执在末尾、120 个字符截断。
  'tb-modes-error': [
    planner({
      1: [call('request_submit', { title: 'Release notes', goal: 'The release notes are written' }), fail(400)],
      2: [together(wait(4000), call('request_submit', { title: 'Another', goal: 'Not allowed here' })),
        call('request_cancel', { request: 1, reason: 'Not allowed here' }),
        call('request_update', { request: 1 }),
        call('request_update', { request: 1, quote: 'words the user never said' }),
        call('request_update', { request: 1, quote: MODES_TEXT.quote }),
        say('Still no tasks.')],
    }),
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('request_close', { request: 1, outcome: 'failed', conclusion: 'Nobody split it into tasks' }),
        say('Closed request 1.')],
    } },
    chatTeam(),
  ],
  // TB-11 立项的投递带自上次以来的对话（含关闭模式、不含工具调用与思考）、超过上限去掉最早的、重新打开后接着游标。
  'tb-modes-catch': [
    chatOff({
      1: [together(think(MODES_TEXT.thinking), call('read', { path: 'README.md' })), say('OFF-REPLY-ONE')],
      2: [say('OFF-REPLY-TWO')], 5: [say('BIG-REPLY-A')], 6: [say('BIG-REPLY-B')],
    }),
    chatTeam({ 3: [say('TEAM-REPLY-THREE')], 4: [say('TEAM-REPLY-FOUR')], 7: [say('TEAM-REPLY-SEVEN')],
      8: [say('TEAM-REPLY-EIGHT')] }),
    planner(Object.fromEntries(upTo(6).map((k) => [k, [say(`Answer directly ${k}.`)]]))),
  ],
  // TB-54 阶段行：对话没在运行时 planner is deciding… · Ns；对话在回复时是它自己的阶段；只有后台在运行时 Stop team 与侧栏。
  'tb-modes-stage': [
    planner({ 1: [together(wait(5000), say('Answer directly.'))], 2: [together(wait(3000), say('Answer two.'))],
      3: registerOne('Background work') }),
    chatTeam({ 1: [together(wait(5000), say('Stage reply one.'))] }), quickTask('executor', 15000), quickClose(),
  ],
  // TB-56 对话回复中发三条（Enter、Ctrl+Enter、Enter）：按顺序判断；判断完排队、插话；最后一条判断完时对话已空闲。
  'tb-modes-q3': [
    planner({ 1: [say('Direct.')], 2: [together(wait(1500), say('A ok.'))], 3: [together(wait(1500), say('B ok.'))],
      4: [together(wait(9000), say('C ok.'))] }),
    chatTeam({ 1: [together(wait(9000), say('LONG-REPLY-ONE'))] }),
  ],
  // TB-56 撤回：交给 pi 排队的与还没开始判断的回到输入框，正在判断的留下；TB-08 撤回的那条的回执与进展摘要写在末尾
  // （对话这时在等它问 executor 的回答：在运行、没有正在输出的助手消息）。
  'tb-modes-wd': [
    planner({ 1: [say('Direct.')], 2: registerOne('Withdrawn request', 'executor', say('Registered.')),
      3: [together(wait(8000), say('B ok.'))], 4: [say('C ok.')] }),
    chatTeam({ 1: [call('agent_message', { to: 'executor', text: 'Is README.md fine? tb-scenario:tb-modes-wd' }),
      say('LONG-REPLY')] }),
    { role: 'executor', kind: 'ask', deliveries: { 1: [together(wait(14000), say('README.md is fine.'))] } },
    longTask(),
  ],
  // TB-56 对话在为另一条消息准备中时判断完的消息排在它之后（另一套角色：chat 只用 tbq，executor 用 tbq、tbb，planner 用 tbb）：
  // executor 在 tbq 上的第一个请求 429 带 Retry-After，tbq 冷却期间 chat 为第一条消息准备中（等模型）。
  'tb-modes-held': [
    planner({ 1: registerOne('Held request', 'executor', together(wait(2500), say('Registered.'))),
      2: [say('Q ok.')] }),
    chatTeam(),
    { role: 'executor', kind: 'task', deliveries: {
      1: [fail(429, { model: MODES_TEXT.modelQ, retryAfter: 8 }), call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'README.md was read', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    quickClose(),
  ],
  // TB-56 扩展命令不经立项，它用 sendUserMessage 开始的运行的工作卡写 No decision；
  // TB-05 关闭模式下以 /team /tbcmd 发出（另一个会话，同一个脚本）：先进入 once，这次运行同样按协作模式。
  'tb-modes-cmd': [chatTeam({ 1: [say('Command reply.')] })],
  // TB-56 对话为你的消息准备中（planner 判断它时等很久）时发的扩展命令照 v0 暂存，排队区显示它；Esc 之后都回到输入框。
  'tb-modes-cmdheld': [planner({ 1: [together(wait(60000), say('Too late.'))] }), chatTeam()],
  // TB-56 提示词模板：立项的投递附上展开后的文字，需求记原文。
  'tb-modes-tmpl': [planner({ 1: registerOne('Template request') }), chatTeam(), quickTask(), quickClose()],
  // TB-08 合并会话：三种写入的回执（文字、120 个字符截断），在工具调用之后、工具结果之前。
  'tb-modes-mrec': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Merged request', goal: 'The merged request is done' }),
        call('task_create', { request: 1, title: 'Wait long', description: 'Read README.md', assignee: 'mori',
          limits: { write: false } }), say('Registered.')],
      2: [call('request_update', { request: 1 }), say('Added.')],
      3: [call('request_cancel', { request: 1, reason: 'The user cancelled it' }), say('Cancelled.')],
    } },
    longTask('mori'),
  ],
};
