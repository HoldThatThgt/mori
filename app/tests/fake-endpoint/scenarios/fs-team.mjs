// 合成端点（synthetic）的脚本：文件系统第 3 步（收窄与增强会话：docs/specs/file-system-permissions.md §8）的 App 套件
// tests/ui/fs-app-team.mjs（docs/specs/file-system.md §19.1、§19.2 的 FS-57、FS-59–FS-62、FS-65、FS-66、FS-68）用的场景，
// 格式见 scripts.mjs 开头；名字以 fs- 开头。另导出写消息的帮助函数（limitsMessage、limitsTask、askStep）、Mori 强制填写
// 投递里的固定文字（FORCED_MARKS）与 FS-66 的调用（enhanceCalls、fsEnhanceSteps）。
//
// 一、场景 fs-limits（通用，同 scenarios/fs.mjs 的做法：每个会话做什么由你的消息里的“行”给出）。写消息的约定：每个 key
//   单独一行 "<key>: <值>"，值到行尾；最后一行写 LIMITS_SCENARIO（limitsMessage 拼好；工作卡的 User's words 把原话放在
//   引号里，最后一行末尾多一个引号，所以 key 不放在最后一行）。步骤的值按 " ;; " 分成几段（scripts.mjs 的 chain，每一段
//   是关键词的单步写法：run:、ps:、write file:、edit file:、call tool:、calls:、say: …，修饰 [wait]、[fail-once] 照样
//   生效）；没写的行一个位置也不占。
//   - lim-t<n>（n = 1…LIMITS_TASKS）：task n 要做的步骤。消息里有 lim-t1 时立项先 request_submit（LIMITS_TEXT.title），
//     再为每个写了 lim-t<n> 的 n 建一个 task：task_create { request: 刚登记的编号（{submitted}）, title:
//     limitsTaskTitle(n), assignee: 合并会话 mori、分开时 executor, description: "lim-run: <lim-t<n> 的值>",
//     limits: <lim-l<n> 的 JSON> }。没有 lim-t1 时一个 task 也不建（lim-t2 等要和 lim-t1 一起写）。
//   - lim-l<n>：task n 的 limits，一段 JSON，原样交给 task_create（例如 {"write":false}、{"commands":false}、
//     {"mcp":false}、{"write_paths":["src/"]}，不合格的 {"write_paths":["C:/x"]}、{"write_paths":["~/x"]}、
//     {"write_paths":["../x"]}、{"write_paths":["."]} 由 Mori 按 §8.2 两行拒绝，TaskBoard 不变）；没有这一行时
//     task_create 不带 limits（不限，写 task）。不是合法的 JSON 时原样作为字符串交出（pi 的 schema 校验拒绝），
//     端点在 stderr 记一行错误。
//   - lim-create：立项在建 task 之后自己做的步骤（合并会话在协作模式下是对话会话，得到 RELAY_ONLY；分开时的 planner
//     得到 "Not allowed while deciding requests: …"）。
//   - lim-dialog：分开时对话（team-dialog）的步骤（RELAY_ONLY）。lim-off：关闭模式下对话（off-dialog、dialog）的步骤
//     （不收窄）。上面的 lim-t<n>、lim-l<n>、lim-create 与这两行只在最后一次投递里找（一直开着的会话，工作卡里可能还
//     抄着上一个需求的原话）。
//   - lim-close：结案第一次投递做的步骤（从工作卡的 User's words 读，"Not allowed while closing a request: …"）。
//   - lim-ask：临时提问实例的步骤，写在 agent_message 的问题里（askStep 拼好，问题里也带 LIMITS_SCENARIO：临时提问的
//     请求靠它认脚本）。askStep 写成一个 call tool: 步骤，能放进 lim-t<n>、lim-create、lim-dialog、lim-off 的值里。
//   - lim-sub：订阅的步骤：结案关闭需求时结论的第二行写 "lim-sub: <值>"，订阅从需求关闭的投递里读（订阅的请求靠需求
//     标题里的 tb-scenario 认脚本）。
//   各会话（角色都写 "*"：任何角色都匹配）：
//   - 立项（merged-create 与 create），每次投递：request_submit（有 lim-t1）→ 每个 lim-t<n> 的 task_create →
//     lim-create 的各段 → LIMITS_TEXT.handled。
//   - task 实例，每次投递：lim-run 的各段（从工作卡的 What to do 读）→ task_handoff done（LIMITS_TEXT.conclusion）；
//     强制填写与格式重试的投递（含 FORCED_MARKS.task 的文字）只按请求的形状交接（handoff）。lim-run 写 "say: …" 时这次
//     运行在交接前结束，由 Mori 的强制填写交接。
//   - 结案，每次投递：（第一次投递先做 lim-close）task_handoff close_done（投递里的 T<n>）→ request_close（工作卡里的
//     需求，结论见 lim-sub；还有没结束的 task 时被拒绝，无害）→ LIMITS_TEXT.closed。强制填写（FORCED_MARKS.close）只交接，
//     强制关闭（FORCED_MARKS.request）只关闭。所以一个需求的几个 task 先后交给结案都能关上，投递合并时后一个 task 由
//     强制填写交接。
//   - 分开时的对话、关闭模式的对话、订阅：每次投递做自己那一行，再回各自的文字；临时提问：做 lim-ask，再回答。
//   每个列表最后一项是 LIMITS_TEXT.reminded：只有你不在时补了提醒才用到（fs-app 套件设 away never）。
//   例（分开配置，T1 只读、T2 只能写 src/，T1 想跑命令、T2 想写 docs/）：
//     limitsMessage([...limitsTask(1, ['run: ls'], { write: false }),
//       ...limitsTask(2, ['write file: docs/a.md :: x', 'write file: src/a.md :: y'], { write_paths: ['src/'] })])
//
// 二、场景 fs-enhance（FS-66 协作模式下的增强；增强会话的步骤写死）。增强会话的第一条消息是 Mori 写的，所以脚本名
//   要从别处进请求：项目的 AGENTS.md 写 ENHANCE_SCENARIO（scenarios/mem.mjs memTeamAgentsMd('fs-enhance')，进每个会话的
//   system），分开配置时也可以写在角色正文里。这样这个项目里所有会话都走这个脚本，你自己的会话也是；不要在同一个
//   项目里再用别的 tb-scenario。增强会话按它的第一条消息认：最后一次投递含 ENHANCE_MARK（memoryText.ts 第一行的开头
//   "You are running Mori's daily"；分开时立项收到的 "[Mori] New user message: …" 里也有）时做下面增强的步骤，
//   不含时（增强会话之后的投递、你自己的会话）做 "你自己的会话" 的步骤。各会话：
//   - 合并会话（merged-create），含 ENHANCE_MARK 的投递：bash 写 ENHANCE_TEXT.merged（RELAY_ONLY）→ request_submit
//     （ENHANCE_TEXT.title）→ task_create（不带 limits，assignee mori）→ ENHANCE_TEXT.registered。
//   - 分开时的立项（create），含 ENHANCE_MARK 的投递：bash 写 ENHANCE_TEXT.create（"Not allowed while deciding
//     requests: …"）→ 同上（assignee executor）；其余投递只回 ENHANCE_TEXT.report（不读 fs66-user 行，所以分开时
//     那一行只由对话做一次）。
//   - task 实例 k = 1：enhanceCalls() 的七个调用依次一个一个做，再 task_handoff done；k = 2、3 是强制填写与格式重试。
//   - 结案 k = 1：bash 写 ENHANCE_TEXT.close（"Not allowed while closing a request: …"）→ task_handoff close_done →
//     request_close → ENHANCE_TEXT.closed；k = 2 强制填写，k = 3 强制关闭。
//   - 分开时的对话（team-dialog），含 ENHANCE_MARK 的投递回 ENHANCE_TEXT.relayed；订阅只回 END_TEXT。
//   - 关闭模式（dialog、off-dialog），含 ENHANCE_MARK 的投递：enhanceCalls() 的七个调用，再回 ENHANCE_TEXT.done
//     （同 fsEnhanceSteps）。
//   - 你自己的会话（合并会话、分开时的对话、关闭模式的对话里不含 ENHANCE_MARK 的投递）：你的消息里有
//     ENHANCE_USER_KEY 行（"fs66-user: <几段>"，同 fs-limits 按 " ;; " 分段的关键词步骤）时一段一段做它，再回
//     ENHANCE_TEXT.own；没有这一行时只回 ENHANCE_TEXT.report（增强会话之后的程序唤醒也是这样）。FS-66 的 This session
//     两种情形：增强运行时你的会话空闲（之前的消息例如 "fs66-user: say: Ready."，或一条也没发），或增强运行时你的会话
//     正在运行（例如 "fs66-user: [wait 8000] say: Still working."；协作模式下合并会话与对话的 bash 被 RELAY_ONLY
//     拒绝，所以用 [wait] 拉长）。你的会话不写 enhanceCalls 的那几个文件。
//   enhanceCalls() 的调用与在增强会话里的结果（file-system-permissions.md §8.10、§6.15）：
//     write ENHANCE_TEXT.note、edit README.md、write ENHANCE_TEXT.draft（.work 里）：被 mori-memory 拒绝
//     （"Enhancement runs can only change memory, with the memory tool."）；
//     bash 写 ENHANCE_TEXT.inside：工作路径里，不出卡就执行；bash 写 ENHANCE_TEXT.outside（工作路径外）、
//     ENHANCE_TEXT.protectedFile（受保护路径 .pi）：直接拒绝（"Denied by Mori: nobody can approve …"，原因分别是
//     writes outside the working directory、writes to a protected path；项目放在 Mori 的 worktree 里时 "../" 落在
//     .mori 下，两条都是 protected，见 scenarios/fs-worktree.mjs）；
//     ENHANCE_TEXT.mcpTool（tests/mcp-server 的合成服务 srv，项目 .pi/mcp.json 配好、项目被信任时才有）：不出卡就执行。
//     立项、结案与合并会话的那一条 bash 被收窄拒绝（§8.3）。
// 三、fsEnhanceSteps()：不走脚本模式的增强会话（项目里没有 tb-scenario）用 enhance.mjs 的增强脚本，这是一种的步骤列表，
//   例如 writeFileSync(<FAKE_ENHANCE_SCRIPT>, JSON.stringify({ taste: fsEnhanceSteps() }))：同样七个调用，再说
//   ENHANCE_TEXT.done。

import { call, chain, end, handoff, say, unless, unlessDelivery, when, whenDelivery } from '../steps.mjs';

/** 认脚本 fs-limits 的标记（消息的最后一行；临时提问的问题里也要有） */
export const LIMITS_SCENARIO = 'tb-scenario:fs-limits';
/** 一条消息最多建几个 task（lim-t1 … lim-t4） */
export const LIMITS_TASKS = 4;

/** 套件要比较的文字（fs-limits） */
export const LIMITS_TEXT = {
  /** 立项登记的需求（标题带 tb-scenario：订阅实例的请求里只有需求标题能认出脚本，§17.1） */
  title: 'Limits check tb-scenario:fs-limits',
  goal: 'The limited tasks are done',
  /** 立项每次投递的回复 */
  handled: 'Handled this limits message.',
  /** task 实例交接的结论 */
  conclusion: 'The limited task is done',
  /** 结案关闭交来的 task 的结论 */
  checked: 'Checked the limited task',
  /** 结案关闭需求的结论（有 lim-sub 行时之后还有一行 "lim-sub: <行值>"） */
  requestDone: 'Limits request done',
  /** 结案的回复 */
  closed: 'Closed the limits request.',
  /** 分开时对话的回复 */
  dialog: 'Chat limits reply.',
  /** 关闭模式对话的回复 */
  off: 'Off mode limits reply.',
  /** 临时提问的回答 */
  answer: 'Answer from the limits question.',
  /** 订阅的回复 */
  seen: 'Seen the limits moment.',
  /** 对你不在时的提醒的回复 */
  reminded: 'Noted the limits reminder.',
};

/** @brief 立项建的第 n 个 task 的标题。 */
export const limitsTaskTitle = (n) => `Limited task ${n}`;

/**
 * Mori 强制填写、格式重试与强制关闭的投递里固定的文字（app/src/kernel/boardText.ts 的 forcedHead、retryHead）：
 * task 实例的强制填写、结案交接 task 的强制填写、结案关闭需求的强制关闭；投递含其中一段时按那一种处理
 */
export const FORCED_MARKS = Object.freeze({
  task: Object.freeze(['Your turn ended without task_handoff.', 'Your handoff could not be used:']),
  close: Object.freeze(['Hand it off now.', 'Your handoff could not be used:']),
  request: Object.freeze(['Close it now with request_close.', 'Your request_close could not be used:']),
});

/** @brief 一行的值：字符串原样；数组是 chain 的几段（以 " ;; " 相接）；其余（limits 的对象）写成 JSON。 */
function rowValue(value) {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.join(' ;; ') : JSON.stringify(value);
}

/**
 * @brief 场景 fs-limits 的一条消息：每个 [key, 值] 一行（值见 rowValue），最后一行是 LIMITS_SCENARIO。
 * @param rows 例如 [...limitsTask(1, ['run: ls'], { write: false }), ['lim-create', ['run: echo x > a.txt']]]
 */
export const limitsMessage = (rows) => [...rows.map(([key, value]) => `${key}: ${rowValue(value)}`),
  LIMITS_SCENARIO].join('\n');

/**
 * @brief task n 的行：lim-t<n>（步骤，数组是 chain 的几段）与 lim-l<n>（limits）。
 * @param limits 对象时写成 JSON，字符串时原样（写不合法的 JSON 用）；undefined 时没有这一行，task 不带 limits
 */
export const limitsTask = (n, steps, limits) => [[`lim-t${n}`, steps],
  ...(limits === undefined ? [] : [[`lim-l${n}`, limits]])];

/**
 * @brief 一个 agent_message 调用的单步写法（call tool: agent_message {…}）：问题是 question，下一行是临时提问实例的
 *        步骤 "lim-ask: <几段>"（askSteps 为空时没有这一行），最后一行是 LIMITS_SCENARIO。JSON 里的 ";" 写成 \u003b，
 *        所以它能作外面一行 chain 的一段（" ;; " 不会把问题里的几段切开）；JSON 里没有换行，整个在一行里。
 * @param to 角色名，或 task（例如 T1，这时是留给 task 的消息）
 * @param question 问题的第一行
 * @param askSteps 临时提问实例的步骤（字符串数组）
 * @param limits agent_message.limits（例如 { mcp: false }、想放宽的 { write: true }）；undefined 时不写
 */
export function askStep(to, question, askSteps = [], limits) {
  const rows = [question, ...(askSteps.length > 0 ? [`lim-ask: ${askSteps.join(' ;; ')}`] : []), LIMITS_SCENARIO];
  const args = { to, text: rows.join('\n'), ...(limits === undefined ? {} : { limits }) };
  return `call tool: agent_message ${JSON.stringify(args).replace(/;/g, '\\u003b')}`;
}

/** 一直开着的会话的投递数上限（每次投递同样的步骤；协作模式下每个 [Mori] 投递也算一次） */
const MAX_DELIVERIES = 24;
/** 只在最后一次投递里找行 */
const LAST = { last: true };
/** 1 … LIMITS_TASKS */
const TASK_NUMBERS = Array.from({ length: LIMITS_TASKS }, (_, i) => i + 1);

/** @brief k = 1..MAX_DELIVERIES 每次投递都是 steps；first 给出时第一次投递换成它。 */
const everyDelivery = (steps, first = steps) => Object.fromEntries(Array.from({ length: MAX_DELIVERIES },
  (_, i) => [i + 1, i === 0 ? first : steps]));

/** @brief 立项建 task n（这次投递里有 lim-t<n> 时）：编号取刚登记的，limits 取 lim-l<n> 的 JSON（没有时不写）。 */
const createTask = (n, assignee) => when(`lim-t${n}`, call('task_create', { request: '{submitted}',
  title: limitsTaskTitle(n), assignee, description: `lim-run: {lastLine:lim-t${n}}`,
  limits: `{lastJson:lim-l${n}}` }), LAST);

/**
 * @brief 立项（合并会话或分开时的立项）：有 lim-t1 时登记需求，按 lim-t<n> 建 task，再做 lim-create，回 handled。
 * @param kind merged-create 或 create
 * @param assignee task 的角色
 */
const creator = (kind, assignee) => ({ role: '*', kind, deliveries: everyDelivery([
  when('lim-t1', call('request_submit', { title: LIMITS_TEXT.title, goal: LIMITS_TEXT.goal }), LAST),
  ...TASK_NUMBERS.map((n) => createTask(n, assignee)),
  chain('lim-create', LAST), say(LIMITS_TEXT.handled), say(LIMITS_TEXT.reminded),
]) });

/** task 实例交接（done） */
const TASK_DONE = { task: '{task}', conclusion: LIMITS_TEXT.conclusion, outcome: 'done' };

/** @brief task 实例：普通投递做 lim-run 再交接；强制填写、格式重试的投递只按形状交接。 */
const worker = { role: '*', kind: 'task', deliveries: everyDelivery([
  unlessDelivery(FORCED_MARKS.task, chain('lim-run')),
  unlessDelivery(FORCED_MARKS.task, call('task_handoff', TASK_DONE)),
  whenDelivery(FORCED_MARKS.task, handoff(TASK_DONE)),
  say(LIMITS_TEXT.reminded),
]) };

/** 结案关闭交来的 task */
const CLOSE_DONE = { task: '{task}', conclusion: LIMITS_TEXT.checked, outcome: 'close_done' };
/** 结案关闭需求，没有 lim-sub 行时 */
const REQUEST_PLAIN = { request: '{request}', outcome: 'done', conclusion: LIMITS_TEXT.requestDone };
/** 同上，有 lim-sub 行时：结论的第二行带它的行值（订阅收到的需求关闭投递里有结论） */
const REQUEST_SUB = { ...REQUEST_PLAIN, conclusion: `${LIMITS_TEXT.requestDone}\nlim-sub: {line:lim-sub}` };
/** 强制填写与强制关闭的投递的文字 */
const CLOSE_FORCED = [...FORCED_MARKS.close, ...FORCED_MARKS.request];

/** @brief 只在普通投递（不是强制填写、强制关闭）里算的一步。 */
const normal = (step) => unlessDelivery(CLOSE_FORCED, step);
/**
 * @brief 关闭需求的一个位置：有 lim-sub 行时 make(REQUEST_SUB)，没有时 make(REQUEST_PLAIN)，恰好一项算数。
 * @param make 字段 → 步骤（request_close 调用或强制关闭的 handoff）
 */
const closeRequest = (make) => [when('lim-sub', make(REQUEST_SUB)), unless('lim-sub', make(REQUEST_PLAIN))];

/** 结案每次投递的步骤（规则见文件开头） */
const CLOSE_STEPS = [
  normal(call('task_handoff', CLOSE_DONE)),
  ...closeRequest((fields) => normal(call('request_close', fields))),
  normal(say(LIMITS_TEXT.closed)),
  whenDelivery(FORCED_MARKS.close, handoff(CLOSE_DONE)),
  ...closeRequest((fields) => whenDelivery(FORCED_MARKS.request, handoff(fields))),
  say(LIMITS_TEXT.reminded),
];

/** @brief 结案：第一次投递先做 lim-close，之后每次投递同 CLOSE_STEPS。 */
const closer = { role: '*', kind: 'close',
  deliveries: everyDelivery(CLOSE_STEPS, [normal(chain('lim-close')), ...CLOSE_STEPS]) };

/** @brief 一直开着的会话：每次投递里有 key 那一行时一段一段做它，再回 text（对话、订阅、关闭模式的对话）。 */
const chainEach = (kind, key, text) => ({ role: '*', kind,
  deliveries: everyDelivery([chain(key, LAST), say(text), say(LIMITS_TEXT.reminded)]) });

// ---------- FS-66：增强会话（场景 fs-enhance 与增强脚本的步骤） ----------

/** 认脚本 fs-enhance 的标记（写进项目的 AGENTS.md 或角色正文，见文件开头第二节） */
export const ENHANCE_SCENARIO = 'tb-scenario:fs-enhance';
/** 增强会话第一条消息的开头（app/src/kernel/memoryText.ts 的第一行）：最后一次投递含它时是增强会话那一次投递 */
export const ENHANCE_MARK = "You are running Mori's daily";
/** 同一个项目里你自己的会话要做的步骤所在的行（见文件开头第二节） */
export const ENHANCE_USER_KEY = 'fs66-user';

/** FS-66 套件要比较的文字与调用里的路径（相对工作路径） */
export const ENHANCE_TEXT = {
  /** 立项登记的需求（标题带 tb-scenario，同 LIMITS_TEXT.title） */
  title: 'Enhancement check tb-scenario:fs-enhance',
  goal: 'The tools were tried in an enhancement run',
  taskTitle: 'Try the tools',
  /** 立项、合并会话在增强会话第一条消息那次的回复；不含它、也没有 fs66-user 行的投递的回复 */
  registered: 'Registered the enhancement check.',
  report: 'The enhancement check is done.',
  /** 你自己的会话做完 fs66-user 行之后的回复 */
  own: 'Answered in your own session.',
  /** task 实例交接与结案的结论、回复 */
  conclusion: 'The tools were tried',
  checked: 'Checked the tool results',
  requestDone: 'Enhancement check done',
  closed: 'Closed the enhancement check.',
  /** 分开时对话的回复 */
  relayed: 'Planner registered the enhancement check.',
  /** 关闭模式（与 fsEnhanceSteps）最后的回复 */
  done: 'Tried the tools.',
  /** enhanceCalls 的 write、.work 里的 write、bash 的三个目标 */
  note: 'fs66-note.txt',
  draft: '.work/fs66-draft.md',
  inside: 'fs66-inside.txt',
  outside: '../fs66-outside.txt',
  protectedFile: '.pi/fs66.txt',
  /** enhanceCalls 的 edit（README.md 里换的那一段）与 MCP 工具 */
  editFrom: 'Mori fixture project',
  editTo: 'Changed by an enhancement',
  mcpTool: 'mcp__srv__echo',
  /** 合并会话、立项、结案各自想用 bash 写的文件（被收窄拒绝） */
  merged: 'fs66-merged.txt',
  create: 'fs66-create.txt',
  close: 'fs66-close.txt',
};

/** @brief FS-66 每个实例与关闭模式的增强会话依次做的七个调用 [工具名, 参数]（结果见文件开头第二节）。 */
export function enhanceCalls() {
  return [
    ['write', { path: ENHANCE_TEXT.note, content: 'enhancement note\n' }],
    ['edit', { path: 'README.md', edits: [{ oldText: ENHANCE_TEXT.editFrom, newText: ENHANCE_TEXT.editTo }] }],
    ['write', { path: ENHANCE_TEXT.draft, content: 'enhancement draft\n' }],
    ['bash', { command: `echo inside > ${ENHANCE_TEXT.inside}` }],
    ['bash', { command: `echo outside > ${ENHANCE_TEXT.outside}` }],
    ['bash', { command: `echo protected > ${ENHANCE_TEXT.protectedFile}` }],
    [ENHANCE_TEXT.mcpTool, { text: 'fs66' }],
  ];
}

/** @brief enhance.mjs 增强脚本里一种的步骤：enhanceCalls 的七个调用（每步一个），再说 ENHANCE_TEXT.done。 */
export const fsEnhanceSteps = () => [...enhanceCalls().map(([name, args]) => ({ call: name, args })),
  { say: ENHANCE_TEXT.done }];

/** @brief enhanceCalls 的七个调用，每个一个回复步骤。 */
const enhanceSteps = () => enhanceCalls().map(([name, args]) => call(name, args));
/** @brief 用 bash 写一个文件（立项、结案、合并会话想做的那一条，被收窄拒绝）。 */
const bashWrite = (path) => call('bash', { command: `echo changed > ${path}` });

/** @brief 只在增强会话第一条消息那次投递（含 ENHANCE_MARK）里算的几步。 */
const enhancing = (steps) => steps.map((step) => whenDelivery(ENHANCE_MARK, step));

/**
 * @brief 不含 ENHANCE_MARK 的投递（增强会话之后的投递、你自己的会话）：有 fs66-user 行时一段一段做它，再回 own；
 *        没有这一行时回 report。
 */
const ownSteps = () => [unlessDelivery(ENHANCE_MARK, chain(ENHANCE_USER_KEY, LAST)),
  unlessDelivery(ENHANCE_MARK, when(ENHANCE_USER_KEY, say(ENHANCE_TEXT.own), LAST)),
  unlessDelivery(ENHANCE_MARK, unless(ENHANCE_USER_KEY, say(ENHANCE_TEXT.report), LAST))];

/**
 * @brief fs-enhance 的立项（合并会话或分开时的立项）：含 ENHANCE_MARK 的投递先 bash（被拒绝），再登记、建 task，
 *        回 registered；其余投递合并会话做 ownSteps，分开时的立项只回 report。
 */
const enhanceCreator = (kind, assignee, file) => ({ role: '*', kind, deliveries: everyDelivery([
  ...enhancing([bashWrite(file), call('request_submit', { title: ENHANCE_TEXT.title, goal: ENHANCE_TEXT.goal }),
    call('task_create', { request: '{submitted}', title: ENHANCE_TEXT.taskTitle, description: 'Try the tools',
      assignee }),
    say(ENHANCE_TEXT.registered)]),
  ...(kind === 'create' ? [unlessDelivery(ENHANCE_MARK, say(ENHANCE_TEXT.report))] : ownSteps())]) });

/** @brief fs-enhance 的对话（分开时的对话或关闭模式的对话）：含 ENHANCE_MARK 的投递做 steps，其余做 ownSteps。 */
const enhanceDialog = (kind, steps) => ({ role: '*', kind, deliveries: everyDelivery([...enhancing(steps),
  ...ownSteps()]) });

/** fs-enhance 的交接单 */
const ENHANCE_DONE = { task: '{task}', conclusion: ENHANCE_TEXT.conclusion, outcome: 'done' };
const ENHANCE_CLOSE = { task: '{task}', conclusion: ENHANCE_TEXT.checked, outcome: 'close_done' };
const ENHANCE_REQUEST = { request: '{request}', outcome: 'done', conclusion: ENHANCE_TEXT.requestDone };

export const SCENARIOS = {
  // 通用场景（见文件开头第一节）：FS-57 谁受什么收窄、FS-59 收窄先于批准、FS-60 RELAY_ONLY、FS-62 写入锁、FS-65 重新打开
  'fs-limits': [
    creator('merged-create', 'mori'),
    creator('create', 'executor'),
    worker,
    closer,
    chainEach('team-dialog', 'lim-dialog', LIMITS_TEXT.dialog),
    { role: '*', kind: 'ask',
      deliveries: { 1: [chain('lim-ask'), say(LIMITS_TEXT.answer), say(LIMITS_TEXT.reminded)] } },
    chainEach('subscription', 'lim-sub', LIMITS_TEXT.seen),
    chainEach('off-dialog', 'lim-off', LIMITS_TEXT.off),
    chainEach('dialog', 'lim-off', LIMITS_TEXT.off),
  ],
  // FS-66 协作模式下的增强（见文件开头第二节）
  'fs-enhance': [
    enhanceCreator('merged-create', 'mori', ENHANCE_TEXT.merged),
    enhanceCreator('create', 'executor', ENHANCE_TEXT.create),
    { role: '*', kind: 'task', deliveries: {
      1: [...enhanceSteps(), call('task_handoff', ENHANCE_DONE)],
      2: [handoff(ENHANCE_DONE)],
      3: [handoff(ENHANCE_DONE)],
    } },
    { role: '*', kind: 'close', deliveries: {
      1: [bashWrite(ENHANCE_TEXT.close), call('task_handoff', ENHANCE_CLOSE), call('request_close', ENHANCE_REQUEST),
        say(ENHANCE_TEXT.closed)],
      2: [handoff(ENHANCE_CLOSE)],
      3: [handoff(ENHANCE_REQUEST)],
    } },
    enhanceDialog('team-dialog', [say(ENHANCE_TEXT.relayed)]),
    { role: '*', kind: 'subscription', deliveries: everyDelivery([end()]) },
    enhanceDialog('off-dialog', [...enhanceSteps(), say(ENHANCE_TEXT.done)]),
    enhanceDialog('dialog', [...enhanceSteps(), say(ENHANCE_TEXT.done)]),
  ],
};
