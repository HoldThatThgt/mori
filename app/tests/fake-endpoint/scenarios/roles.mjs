// 合成端点（synthetic）的脚本：tests/ui/tb-app-roles.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-01 角色文件的各字段、TB-09 对话只传话、TB-43 实例会话、TB-53 协作开关），格式见 scripts.mjs 开头；名字都以
// tb-roles- 开头。每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是那个会话里的投递序号。
// 这里另外导出套件要比较的文字（ROLES_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, end, say, together, wait } from '../steps.mjs';

/** 套件要比较的文字 */
export const ROLES_TEXT = {
  /** tb-roles-fields 里立项最后一段文字（对话工作卡的 their note） */
  fieldsNote: 'Registered request 1 with T1 for executor.',
  /** executor 写的文件与内容 */
  noteFile: 'note.txt',
  noteContent: 'tb-roles note\n',
  /** tb-roles-tools：对话想跑的命令写出的文件、想写的文件 */
  bashFile: 'made-by-bash.txt',
  writeFile: 'made-by-write.txt',
  /** tb-roles-mcp：合成 MCP 服务的名字（工具名 mcp__late__echo） */
  mcpTool: 'mcp__late__echo',
};

/** @brief 对话想用命令、编辑、写入（以及给出时的一个 MCP 工具）改动工作区，每个调用单独一步。 */
const tryChanges = (mcp = null) => [
  call('bash', { command: `echo changed > ${ROLES_TEXT.bashFile}` }),
  call('edit', { path: 'README.md', edits: [{ oldText: 'Mori fixture project', newText: 'Changed by dialog' }] }),
  call('write', { path: ROLES_TEXT.writeFile, content: 'changed' }),
  ...(mcp ? [call(mcp, { text: 'from dialog' })] : []),
];

export const SCENARIOS = {
  // TB-01 / TB-09（分开配置：chat、planner、executor、reviewer、watcher）：关闭模式一问 → /task 登记 T1 给 executor →
  // executor 写 note.txt、continue 给 reviewer → reviewer 读、pass → planner 结案关闭 → watcher 订阅被唤醒 →
  // chat 汇报 → 回到关闭模式再问一次。
  'tb-roles-fields': [
    { role: 'chat', kind: 'off-dialog', deliveries: {
      1: [say('Off-mode answer.')],
      4: [say('Off-mode answer again.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      2: [say('Planner registered request 1.')],
      3: [say('Request 1 is done: note.txt was written and checked.')],
    } },
    { role: 'planner', kind: 'create', deliveries: {
      // 订阅的投递只带需求标题，所以标题里写上脚本名（§17.1）
      1: [call('request_submit', { title: 'Write the note tb-scenario:tb-roles-fields', goal: 'note.txt exists' }),
        call('task_create', { request: 1, title: 'Write note.txt', description: 'Write note.txt and hand it on',
          assignee: 'executor', read_only: false }),
        say(ROLES_TEXT.fieldsNote)],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('write', { path: ROLES_TEXT.noteFile, content: ROLES_TEXT.noteContent }),
        call('task_handoff', { task: '{task}', conclusion: 'Wrote note.txt', outcome: 'continue', next: 'reviewer',
          evidence: ['{tag:write}'] })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: ROLES_TEXT.noteFile }),
        call('task_handoff', { task: '{task}', conclusion: 'note.txt is there', outcome: 'pass',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: 'T1', conclusion: 'note.txt written and checked', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'note.txt is written' }),
        say('Closed request 1.')],
    } },
    { role: 'watcher', kind: 'subscription', deliveries: { 1: [end()] } },
  ],
  // TB-09：chat.md 写 tools: [read]，关闭模式下对话想跑命令、编辑、写入（都被拒绝），最后说一句。
  'tb-roles-tools': [
    { role: 'chat', kind: 'off-dialog', deliveries: { 1: [...tryChanges(), say('I could not change anything.')] } },
  ],
  // TB-09：协作模式下，会话打开之后才注册工具的 MCP 服务（合成 MCP 服务连上 8 秒后才列出工具）；对话第一次请求的
  // 回复等到工具注册之后才来，然后想跑命令、编辑、写入、调用 MCP 工具（都被拒绝）。立项按不需要协作。
  'tb-roles-mcp': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('reply_via_dialog', { note: 'Answer it directly' }), say('No collaboration needed.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [together(wait(12000), call('read', { path: 'README.md' })), ...tryChanges(ROLES_TEXT.mcpTool),
        say('Relayed only.')],
    } },
  ],
  // TB-09：分开配置，关闭模式问一次 → 协作模式（开关）问一次（立项按不需要协作）→ 重启 App、重新打开、关掉协作模式
  // 再问一次。
  'tb-roles-restart': [
    { role: 'chat', kind: 'off-dialog', deliveries: {
      1: [say('Off answer one.')],
      3: [say('Off answer two.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: { 2: [say('Team answer.')] } },
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('reply_via_dialog', { note: 'Answer directly' }), say('No collaboration needed.')],
    } },
  ],
  // TB-53：合并会话（没有角色文件）：/task 登记需求 1、T1 → T1 need_user → 程序唤醒立项、回复问你 → 你撤销需求。
  'tb-roles-switch': [
    { role: 'mori', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Pick a file', goal: 'Know which file to read' }),
        call('task_create', { request: 1, title: 'Ask which file', description: 'Ask the user which file',
          assignee: 'mori', read_only: true }),
        say('Registered request 1.')],
      2: [say('T1 needs your decision: which file?')],
      3: [call('request_cancel', { request: 1 }), say('Cancelled request 1.')],
    } },
    { role: 'mori', kind: 'task', task: 'T1', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Which file should I read?', outcome: 'need_user' })],
    } },
  ],
  // TB-43（分开配置，项目扩展在实例里询问）：/task 登记 T1 给 executor → executor 读 README、done → planner 结案关闭 →
  // chat 汇报。
  'tb-roles-instances': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Read the README', goal: 'Know what README.md says' }),
        call('task_create', { request: 1, title: 'Read README', description: 'Read README.md',
          assignee: 'executor', read_only: true }),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')],
      2: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'README read', outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: 'T1', conclusion: 'README was read', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'README was read' }), say('Closed.')],
    } },
  ],
};
