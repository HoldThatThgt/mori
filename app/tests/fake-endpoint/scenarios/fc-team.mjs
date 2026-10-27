// 合成端点（synthetic）的脚本：tests/ui/fc-app-team.mjs 用的场景（docs/specs/finish-check.md §14.2 FC-02、FC-03、
// FC-10、FC-11、FC-18、FC-19、FC-20 在协作模式与 Team 里的 App 部分），格式见 scripts.mjs 开头；
// 名字都以 tb-fcteam- 开头。
// 每个场景在自己的临时项目里跑：项目的 AGENTS.md 带 "tb-scenario:<名字>"（fcTeamAgentsMd），进每个会话的 system，
// 所以用户会话与它的每个实例都按这里的脚本回答。
// 用户会话的检查请求（收尾检查那一行在末尾的请求）由合成端点默认只回一个 finish（finish.mjs），不占这里的步骤；
// 检查那一行不算投递，投递序号 k 与步骤 j 不变。要别的回应时，你的消息或 agent_message 的正文写 "fc-scenario:<名字>"，
// 那次运行的每个请求由 finish.mjs 的场景回答（不用这里的步骤，但那次投递照样算进 k）。
// 这里另外导出套件要比较的文字（FC_TEAM_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, end, say, together, wait } from '../steps.mjs';

/** 套件要比较的文字 */
export const FC_TEAM_TEXT = {
  /** tb-fcteam-split：你的第一条消息（协作模式，登记需求 1）、第二条（fc-b 回答）、回到关闭模式后的两条 */
  splitFirst: 'Read the README and tell me what it says',
  splitFcB: 'Run the tests fc-scenario:fc-b',
  offOne: 'Off one',
  offTwo: 'Off two',
  /** 对话转述登记、汇报 */
  splitRelay: 'Planner registered request 1.',
  splitReport: 'Request 1 is done: README.md was read.',
  /** executor 问 reviewer 的问题（临时提问实例）与回答 */
  askQuestion: 'Is README.md the file to read?',
  askAnswer: 'Yes, README.md is the file.',
  /** tb-fcteam-merged：你的消息、T1 等合并会话回答的问题与回答、第二个问题（带 fc-a-text：确认时另写一句）、汇报 */
  mergedFirst: 'Summarize the README',
  mergedQuestion: 'Which section should I read first?',
  mergedAnswer: 'Start with the intro section.',
  mergedConfirm: 'Is the intro enough? fc-scenario:fc-a-text',
  mergedReport: 'Request 1 is done: the README was summarized.',
  /** tb-fcteam-fail：你的消息、T1 的两个问题（各带一个 fc 场景名） */
  failFirst: 'Ask Mori two questions',
  failQuestion: 'First question fc-scenario:fc-fail',
  workFailQuestion: 'Second question fc-scenario:fc-work-fail',
  failReport: 'Request 1 is done.',
  /** tb-fcteam-runmode：关闭模式下慢慢回答的消息（运行中打开协作模式）、协作模式下的消息 */
  runmodeFirst: 'Slow question',
  runmodeSecond: 'Team question',
  /** tb-fcteam-restore：协作模式的消息 */
  restoreFirst: 'Team question before the restart',
};

/** tb-fcteam-runmode 关闭模式那次回复前多等多久（套件在这段时间里打开协作模式） */
export const RUNMODE_WAIT_MS = 5000;

/** @brief 合成配置的项目 AGENTS.md（synthetic test setup）：把脚本名带进每个会话的 system。 */
export const fcTeamAgentsMd = (scenario) => `# Synthetic project notes\n\ntb-scenario:${scenario}\n`;

/** @brief 立项按不需要协作：reply_via_dialog，再说一句。 */
const noCollaboration = () => [call('reply_via_dialog', { note: 'Answer it directly' }),
  say('No collaboration needed.')];

/** @brief 一次 read，再带它的证据交接（task 实例）。 */
const readThenHandoff = (conclusion) => [call('read', { path: 'README.md' }),
  call('task_handoff', { task: '{task}', conclusion, outcome: 'done', evidence: ['{tag:read}'] })];

/** @brief 结案关闭交来的 task 与需求 1，再说一句。 */
const closeRequest = (conclusion) => [
  call('task_handoff', { task: '{task}', conclusion, outcome: 'close_done' }),
  call('request_close', { request: 1, outcome: 'done', conclusion }),
  say('Request 1 closed.')];

/** @brief 合并会话登记需求 1 与给基座的 T1（limits { write: false }，文件系统规格的只读写法）。 */
const mergedRegister = (title, description) => [
  call('request_submit', { title, goal: description }),
  call('task_create', { request: 1, title, description, assignee: 'mori', limits: { write: false } }),
  say('Registered request 1.')];

export const SCENARIOS = {
  // 分开配置（chat 持有对话，planner 持有立项与结案，executor、reviewer、订阅 request_closed 的 watcher）：
  // 协作模式下你的第一条消息 → planner 登记需求 1、T1 给 executor → executor 问 reviewer（临时提问实例）、读 README、
  // 交接 → planner 结案关闭 → watcher 被唤醒 → chat 汇报（程序投递，k=2）；你的第二条消息（k=3，fc-b 回答，planner
  // 按不需要协作）；回到关闭模式再问两次（k=4、5）。
  'tb-fcteam-split': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Read the README', goal: 'Know what README.md says' }),
        call('task_create', { request: 1, title: 'Read README', description: 'Read README.md',
          assignee: 'executor', limits: { write: false } }),
        say('Registered request 1 with T1.')],
      2: noCollaboration(),
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say(FC_TEAM_TEXT.splitRelay)],
      2: [say(FC_TEAM_TEXT.splitReport)],
    } },
    { role: 'chat', kind: 'off-dialog', deliveries: {
      4: [say('Off answer one.')],
      5: [say('Off answer two.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('agent_message', { to: 'reviewer', text: FC_TEAM_TEXT.askQuestion }),
        ...readThenHandoff('README.md was read')],
    } },
    { role: 'reviewer', kind: 'ask', deliveries: { 1: [say(FC_TEAM_TEXT.askAnswer)] } },
    { role: 'planner', kind: 'close', deliveries: { 1: closeRequest('README.md was read') } },
    { role: 'watcher', kind: 'subscription', deliveries: { 1: [end()] } },
  ],

  // 合并会话（没有角色文件）：登记需求 1、T1 → T1 等合并会话回答两个问题（程序投递）：第一个按这里的脚本回答（k=2），
  // 第二个带 fc-a-text（k=3：回复之后检查时另写一句、调 finish）→ T1 读 README、交接 → 结案关闭 → 合并会话汇报（k=4）。
  'tb-fcteam-merged': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: mergedRegister('Summarize the README', 'Read README.md and summarize it'),
      2: [say(FC_TEAM_TEXT.mergedAnswer)],
      4: [say(FC_TEAM_TEXT.mergedReport)],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [call('agent_message', { to: 'mori', wait: true, text: FC_TEAM_TEXT.mergedQuestion }),
        call('agent_message', { to: 'mori', wait: true, text: FC_TEAM_TEXT.mergedConfirm }),
        ...readThenHandoff('Summarized the intro')],
    } },
    { role: 'mori', kind: 'close', deliveries: { 1: closeRequest('The README was summarized') } },
  ],

  // 合并会话（没有角色文件）：登记需求 1、T1 → T1 等合并会话回答两个问题：第一个带 fc-fail（k=2：回复之后检查那次请求
  // 出错），第二个带 fc-work-fail（k=3：检查之后干了活，再出错）→ T1 读 README、交接 → 结案关闭 → 汇报（k=4）。
  'tb-fcteam-fail': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: mergedRegister('Ask twice', 'Ask Mori two questions'),
      4: [say(FC_TEAM_TEXT.failReport)],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [call('agent_message', { to: 'mori', wait: true, text: FC_TEAM_TEXT.failQuestion }),
        call('agent_message', { to: 'mori', wait: true, text: FC_TEAM_TEXT.workFailQuestion }),
        ...readThenHandoff('Asked twice')],
    } },
    { role: 'mori', kind: 'close', deliveries: { 1: closeRequest('Both questions were asked') } },
  ],

  // 合并配置：关闭模式下的回复晚 RUNMODE_WAIT_MS 到（套件在这段时间里打开协作模式，k=1）；之后协作模式下的一条
  // （合并会话按不需要协作，k=2）。
  'tb-fcteam-runmode': [
    { role: 'mori', kind: 'dialog', deliveries: {
      1: [together(wait(RUNMODE_WAIT_MS), say('Slow off-mode answer.'))],
    } },
    { role: 'mori', kind: 'merged-create', deliveries: {
      2: [call('reply_via_dialog', {}), say('Answering directly in team mode.')],
    } },
  ],

  // 分开配置（tb-helpers SPLIT_ROLES）：协作模式下问一次（planner 按不需要协作，k=1）；套件退出 Mori、把会话文件里
  // mori.team 记下的那一组去掉 finish（早于收尾检查的写法）、重新打开、关掉协作模式，再问两次（k=2、3）。
  'tb-fcteam-restore': [
    { role: 'planner', kind: 'create', deliveries: { 1: noCollaboration() } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 1: [say('Team answer.')] } },
    { role: 'chat', kind: 'off-dialog', deliveries: {
      2: [say('Off answer one.')],
      3: [say('Off answer two.')],
    } },
  ],
};
