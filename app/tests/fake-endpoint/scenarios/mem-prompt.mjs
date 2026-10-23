// 合成端点（synthetic）的脚本：tests/ui/mem-app-prompt.mjs 用的场景（docs/specs/memory.md §14.2 的 MEM-01–04、MEM-11），
// 格式见 scripts.mjs 开头；名字以 mem-prompt- 开头。套件看的是请求里的 system prompt 与工具，回复只要让流程走完，
// 所以每个会话的步骤与投递序号 k 无关的地方都一样（sameFor），重启、模式切换之后多出的投递也有步骤。
// 'mem-prompt-merged'：没有角色文件的项目（合并会话，全是基座 mori）。tb-scenario 写在项目的 AGENTS.md 里
//   （mergedAgentsMd，进每个会话的 system），关闭模式（kind dialog）只回一句；协作模式（merged-create）用
//   reply_via_dialog 直接回答（不登记需求），再回一句。
// 'mem-prompt-split'：分开配置（MEM_PROMPT_ROLES：chat 持有对话、planner 持有立项与结案、executor、reviewer、
//   watcher 订阅 request_closed；正文都带 tb-scenario）：
//   - 关闭模式第 1 次投递：chat 用 agent_message 问 executor 一个问题（关闭模式的临时提问实例），再回一句；之后只回一句；
//   - 协作模式第 1 条消息（chat 的第 2 次投递）：chat 先调用 memory（协作模式分开时对话没有它，§7.6），再转述；
//     planner 登记需求 1（标题带 tb-scenario，订阅的投递靠它认脚本）、建只读 task T1 给 executor；T1 读 README、
//     用 agent_message 问 reviewer（协作模式的临时提问实例），再带证据交接；planner 结案关闭 T1 与需求；watcher 被唤醒；
//   - 之后的协作模式消息：planner 用 reply_via_dialog 直接回答，chat 回一句。
// 这里另外导出套件要比较的文字（MEM_PROMPT_TEXT）与角色（MEM_PROMPT_ROLES），scripts.mjs 只并入 SCENARIOS。

import { call, end, say } from '../steps.mjs';

/** 套件要比较的文字 */
export const MEM_PROMPT_TEXT = {
  /** 关闭模式的回复 */
  offAnswer: 'Off-mode answer.',
  /** 协作模式下立项直接回答时的说明与回复 */
  directNote: 'Answer it directly',
  directAnswer: 'Answered directly.',
  /** 分开配置：关闭模式问 executor 的问题与回答 */
  offQuestion: 'Executor, what does README.md say? tb-scenario:mem-prompt-split',
  offAnswerAsk: 'Executor answer: README.md describes the fixture project.',
  offAsked: 'Asked executor.',
  /** 分开配置：协作模式下对话想存的事实（对话没有 memory） */
  dialogAbstract: 'MEM11-DIALOG-SAVE The dialog tried to save this',
  dialogQuote: 'Remember this for me',
  relayed: 'Planner registered request 1.',
  teamAnswer: 'Team-mode answer.',
  /** 分开配置：需求与 task */
  requestTitle: 'Read the notes tb-scenario:mem-prompt-split',
  registered: 'Registered request 1 with T1.',
  /** T1 问 reviewer 的问题与回答 */
  teamQuestion: 'Reviewer, is README.md the right file? tb-scenario:mem-prompt-split',
  teamAnswerAsk: 'Reviewer answer: yes, README.md is the right file.',
  closed: 'Closed request 1.',
};

/** @brief k 从 1 到 max 的投递都用同样的步骤；except 里给出的 k 用它自己的步骤。 */
function sameFor(steps, except = {}, max = 30) {
  const out = {};
  for (let k = 1; k <= max; k += 1) out[k] = except[k] ?? steps;
  return out;
}

/** @brief 立项直接回答（不登记需求）。 */
const direct = () => [call('reply_via_dialog', { note: MEM_PROMPT_TEXT.directNote }),
  say(MEM_PROMPT_TEXT.directAnswer)];

/**
 * @brief 分开配置的角色（synthetic test setup，写法同 tb-helpers SPLIT_ROLES；正文带脚本名，writeRole 再加 MORI-ROLE）。
 */
export const MEM_PROMPT_ROLES = [
  { name: 'chat', description: 'Talks with the user and relays the team’s work', seats: ['dialog'],
    body: 'You are chat. tb-scenario:mem-prompt-split' },
  { name: 'planner', description: 'Decides how to split each request and closes it', seats: ['create', 'close'],
    body: 'You are planner. tb-scenario:mem-prompt-split' },
  { name: 'executor', description: 'Changes code and runs commands to finish a task',
    body: 'You are executor. tb-scenario:mem-prompt-split' },
  { name: 'reviewer', description: 'Checks the work of another role and reports pass or fail',
    body: 'You are reviewer. tb-scenario:mem-prompt-split' },
  { name: 'watcher', description: 'Keeps notes when a request closes', subscribe: ['request_closed'],
    body: 'You are watcher. tb-scenario:mem-prompt-split' },
];

/** @brief 没有角色文件的项目的 AGENTS.md（synthetic）：把脚本名带进每个会话的 system。 */
export const mergedAgentsMd = () => '# Synthetic project notes\n\ntb-scenario:mem-prompt-merged\n';

export const SCENARIOS = {
  'mem-prompt-merged': [
    { role: 'mori', kind: 'dialog', deliveries: sameFor([say(MEM_PROMPT_TEXT.offAnswer)]) },
    { role: 'mori', kind: 'merged-create', deliveries: sameFor(direct()) },
  ],
  'mem-prompt-split': [
    { role: 'chat', kind: 'off-dialog', deliveries: sameFor([say(MEM_PROMPT_TEXT.offAnswer)], {
      1: [call('agent_message', { to: 'executor', text: MEM_PROMPT_TEXT.offQuestion }), say(MEM_PROMPT_TEXT.offAsked)],
    }) },
    { role: 'executor', kind: 'ask', deliveries: sameFor([say(MEM_PROMPT_TEXT.offAnswerAsk)]) },
    { role: 'chat', kind: 'team-dialog', deliveries: sameFor([say(MEM_PROMPT_TEXT.teamAnswer)], {
      2: [call('memory', { action: 'save', kind: 'fact', abstract: MEM_PROMPT_TEXT.dialogAbstract,
        quote: MEM_PROMPT_TEXT.dialogQuote }), say(MEM_PROMPT_TEXT.relayed)],
    }) },
    { role: 'planner', kind: 'create', deliveries: sameFor(direct(), {
      1: [call('request_submit', { title: MEM_PROMPT_TEXT.requestTitle, goal: 'Know what README.md says' }),
        call('task_create', { request: 1, title: 'Read README', description: 'Read README.md and check it',
          assignee: 'executor', read_only: true }),
        say(MEM_PROMPT_TEXT.registered)],
    }) },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: { 1: [call('read', { path: 'README.md' }),
      call('agent_message', { to: 'reviewer', text: MEM_PROMPT_TEXT.teamQuestion }),
      call('task_handoff', { task: '{task}', conclusion: 'README.md was read and checked', outcome: 'done',
        evidence: ['{tag:read}'] })] } },
    { role: 'reviewer', kind: 'ask', deliveries: sameFor([say(MEM_PROMPT_TEXT.teamAnswerAsk)]) },
    { role: 'planner', kind: 'close', deliveries: sameFor([
      call('task_handoff', { task: 'T1', conclusion: 'README.md was read', outcome: 'close_done' }),
      call('request_close', { request: 1, outcome: 'done', conclusion: 'README.md was read and checked' }),
      say(MEM_PROMPT_TEXT.closed)]) },
    { role: 'watcher', kind: 'subscription', deliveries: sameFor([end()]) },
  ],
};
