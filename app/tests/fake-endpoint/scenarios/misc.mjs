// 合成端点（synthetic）的脚本：tests/ui/tb-app-misc.mjs 用的场景（docs/specs/parallel-agents-taskboard.md
// TB-30 工作卡、TB-55 工具卡标题、TB-57 右栏与后台改动），格式见 scripts.mjs 开头；名字都以 tb-misc- 开头。
// 每个场景在自己的用户会话里跑（脚本按请求里第一个 tb-scenario 认），k 是那条会话里的投递序号。
// 这里另外导出套件要比较的文字（MISC_TEXT），scripts.mjs 只并入 SCENARIOS。

import { call, fail, say, together, wait } from '../steps.mjs';

/**
 * @brief 恰好 length 个字符的文字（synthetic）：以 "<tag> " 开头、以 " <tag>-END" 结尾，中间是固定的词；
 *        套件按开头与 -END 认出它在工作卡里是全文还是被截断。
 */
export function filler(tag, length) {
  const head = `${tag} `;
  const tail = ` ${tag}-END`;
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike ';
  let body = '';
  while (body.length < length - head.length - tail.length) body += words;
  return `${head}${body.slice(0, length - head.length - tail.length)}${tail}`;
}

/** 交接结论的上限（shared/team.ts TEXT_LIMITS.handoffConclusion） */
const CONCLUSION_MAX = 600;

/** TB-30 超出上限的工作卡用的文字（长度按 §8.3 的压缩顺序选好，套件里注明） */
const OVER = {
  /** 需求最初的原话（/task 之后的全文）：超过 2000 字符，第 4 步才截断 */
  original: `Plan the big change tb-scenario:tb-misc-overflow ${filler('ORIGINAL', 3950)}`,
  /** T1 最后一棒的结论与结案的关闭结论：T3 的依赖行，第 3 步各截到 200 字符 */
  dep: filler('DEPWORK', CONCLUSION_MAX),
  depClose: filler('DEPCLOSE', CONCLUSION_MAX),
  /** T2 失败关闭的结论：已排除的方案，第 3 步截到 200 字符 */
  ruled: filler('RULED', CONCLUSION_MAX),
  /** T3 上第 n 棒的结论 */
  handoff: (n) => filler(`HANDOFF${n}`, CONCLUSION_MAX),
  /** 立项留给 T3 的第 n 条消息（10 条），第 2 步只留最近 3 条 */
  note: (n) => filler(`NOTE${String(n).padStart(2, '0')}`, 110),
  /** 你的四条补充：第 1 条把卡推过上限（第 1 步就够），之后每条推到下一步，最后一条让只剩补充也超出 */
  supplements: [filler('SUPPLEMENT1', 400), filler('SUPPLEMENT2', 900), filler('SUPPLEMENT3', 1500),
    filler('SUPPLEMENT4', 3000)],
};

/** 套件要比较的文字 */
export const MISC_TEXT = {
  over: OVER,
  /** TB-30 压缩用的长消息（每条约 6000 token，第 3 条之后超过 pi 的压缩阈值） */
  compactMessage: (n) => `tb-scenario:tb-misc-compact C${n} ${filler(`COMPACT${n}`, 24000)}`,
  /** TB-55 dialog 留给 T1 的消息、问 executor 的问题 */
  noteForT1: 'Mind the intro section.',
};

/** @brief task 实例的交接（T3 上的一棒）。 */
const pass = (n, outcome, next) => call('task_handoff', { task: '{task}', conclusion: OVER.handoff(n), outcome, next });

/** @brief 等 ms 再调用一个工具（进展摘要的 task 行显示这个工具的标题至少 ms 毫秒）。 */
const slow = (ms, name, args) => together(wait(ms), call(name, args));

export const SCENARIOS = {
  // TB-55 合并会话（lead 持有对话与立项，closer 持有结案）：对话流里的工具卡与 T1 那一行的标题。
  // lead 的回合：登记、建 T1、三种 board_read、read_session、三种 agent_message（发到 task、问 executor、进 closer 的结案会话）；
  // T1（executor）每次调用前等一会儿，task 行依次显示每个工具的标题：三种 board_read、read_session、问 reviewer、
  // 发进 closer 的结案会话、发到 T1、被拒绝的交接（Hand off T1 停留 3 秒），最后带证据交接；closer 关闭需求，lead 汇报。
  'tb-misc-titles': [
    { role: 'lead', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Check the notes', goal: 'The notes in README.md are fine' }),
        call('task_create', { request: 1, title: 'Review notes', description: 'Look at README.md',
          assignee: 'executor', limits: { write: false } }),
        call('board_read', {}), call('board_read', { request: 1 }), call('board_read', { task: 'T1' }),
        call('read_session', { task: 'T1', role: 'executor' }),
        call('agent_message', { to: 'T1', text: MISC_TEXT.noteForT1 }),
        call('agent_message', { to: 'executor', text: 'What is in README.md? tb-scenario:tb-misc-titles' }),
        call('agent_message', { to: 'closer', request: 1, text: 'Close request 1 when T1 is done.' }),
        say('Registered request 1.')],
      2: [say('Request 1 is done: the notes are fine.')],
    } },
    { role: 'executor', kind: 'ask', deliveries: { 1: [say('README.md describes the fixture project.')] } },
    { role: 'reviewer', kind: 'ask', deliveries: { 1: [together(wait(1500), say('The plan is fine.'))] } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [slow(4000, 'board_read', {}), slow(1500, 'board_read', { request: 1 }),
        slow(1500, 'board_read', { task: 'T1' }), slow(1500, 'read_session', { task: 'T1', role: 'executor' }),
        slow(1500, 'agent_message', { to: 'reviewer', text: 'Is the plan fine? tb-scenario:tb-misc-titles' }),
        slow(1500, 'agent_message', { to: 'closer', text: 'T1 is almost done.' }),
        slow(1500, 'agent_message', { to: 'T1', text: 'Remember the intro.' }),
        slow(1500, 'task_handoff', { task: '{task}', conclusion: 'Looked fine', outcome: 'done' }),
        slow(3000, 'read', { path: 'README.md' }),
        slow(1500, 'task_handoff', { task: '{task}', conclusion: 'The notes are fine', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'closer', kind: 'close', deliveries: {
      1: [say('Noted.')],
      2: [say('Noted.')],
      3: [call('task_handoff', { task: '{task}', conclusion: 'Checked', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'The notes are fine' }),
        say('Request 1 closed.')],
    } },
  ],

  // TB-55 合并会话里立项的其余工具：补充、改 task、直接回答、撤销（T1 一直在等，撤销时停下）。
  'tb-misc-titles2': [
    { role: 'lead', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Slow read', goal: 'Read README.md slowly' }),
        call('task_create', { request: 1, title: 'Slow read', description: 'Read README.md slowly',
          assignee: 'executor', limits: { write: false } }),
        say('Registered request 1.')],
      2: [call('request_update', { request: 1 }),
        call('task_edit', { task: 'T1', description: 'Read README.md slowly, then src/a.ts' }),
        say('Added to request 1.')],
      3: [call('reply_via_dialog', { note: 'Just answer the question' }), say('Here is a direct answer.')],
      4: [call('request_cancel', { request: 1, reason: 'The user changed their mind' }),
        say('Cancelled request 1.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [slow(60000, 'read', { path: 'README.md' }), say('Too late.')],
    } },
  ],

  // TB-57（分开配置 chat / planner / executor / reviewer）：T1 改 README.md（edit），之后等 8 秒再读、交接；
  // 需求关闭后关闭模式下对话自己写 notes.txt（对话流里的写入）。
  'tb-misc-changes': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('request_submit', { title: 'Edit the README', goal: 'README.md has a new heading' }),
        call('task_create', { request: 1, title: 'Edit README', description: 'Change the heading of README.md',
          assignee: 'executor' }),
        say('Registered request 1.')],
    } },
    { role: 'chat', kind: 'team-dialog', deliveries: {
      1: [say('Planner registered request 1.')],
      2: [say('Request 1 is done: README.md has a new heading.')],
    } },
    { role: 'chat', kind: 'off-dialog', deliveries: {
      3: [call('write', { path: 'notes.txt', content: 'notes from the dialog\n' }), say('Wrote notes.txt.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [call('edit', { path: 'README.md', edits: [{ oldText: 'Mori fixture project', newText: 'Changed by T1' }] }),
        slow(8000, 'read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Heading changed', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'planner', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Heading changed', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'README.md has a new heading' }),
        say('Request 1 closed.')],
    } },
  ],

  // TB-57 没有 TaskBoard（没有角色文件、没用过协作模式）：对话自己写一个文件，右栏与 v0 相同。
  'tb-misc-plainwrite': [
    { role: 'mori', kind: 'dialog', deliveries: {
      1: [call('write', { path: 'plain.txt', content: 'plain notes\n' }), say('Wrote plain.txt.')],
    } },
  ],

  // TB-30 超出上限的工作卡（lead 持有三项权限：合并会话，结案是 lead 的结案会话）：T1 带长结论完成并关闭（T3 的依赖），
  // T2 dead_end 后失败关闭（已排除的方案），T3 在 executor 与 reviewer 之间来回 6 轮；reviewer 每轮等 9 秒，
  // 套件这时发补充或请 lead 给 T3 留 10 条消息；executor 第 6 轮第一次请求等 9 秒，套件再发最后一条补充。
  'tb-misc-overflow': [
    { role: 'lead', kind: 'merged-create', deliveries: {
      1: [call('request_submit', { title: 'Big change', goal: 'Do the big change in steps' }),
        call('task_create', { request: 1, title: 'Prepare', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        call('task_create', { request: 1, title: 'Try a shortcut', description: 'Try the shortcut',
          assignee: 'executor', limits: { write: false } }),
        call('task_create', { request: 1, title: 'Main work', description: 'Do the main work',
          assignee: 'executor', limits: { write: false }, depends_on: ['T1'] }),
        say('Registered request 1.')],
      2: [call('request_update', { request: 1 }), say('Added to request 1.')],
      3: [together(...Array.from({ length: 10 },
        (_, i) => call('agent_message', { to: 'T3', text: OVER.note(i + 1) }))),
        say('Left ten notes for T3.')],
      4: [call('request_update', { request: 1 }), say('Added to request 1.')],
      5: [call('request_update', { request: 1 }), say('Added to request 1.')],
      6: [call('request_update', { request: 1 }), say('Added to request 1.')],
      7: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [slow(3000, 'read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: OVER.dep, outcome: 'done', evidence: ['{tag:read}'] })],
    } },
    { role: 'executor', kind: 'task', task: 'T2', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'The shortcut does not work', outcome: 'dead_end' })],
    } },
    { role: 'executor', kind: 'task', task: 'T3', deliveries: {
      1: [pass(1, 'continue', 'reviewer')], 2: [pass(3, 'continue', 'reviewer')], 3: [pass(5, 'continue', 'reviewer')],
      4: [pass(7, 'continue', 'reviewer')], 5: [pass(9, 'continue', 'reviewer')],
      6: [slow(9000, 'read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Main work done', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'reviewer', kind: 'task', task: 'T3', deliveries: {
      1: [pass(2, 'fail', 'executor')],
      2: [together(wait(9000), pass(4, 'fail', 'executor'))], 3: [together(wait(9000), pass(6, 'fail', 'executor'))],
      4: [together(wait(9000), pass(8, 'fail', 'executor'))], 5: [together(wait(9000), pass(10, 'fail', 'executor'))],
    } },
    { role: 'lead', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: OVER.ruled, outcome: 'close_failed' }), say('T2 closed.')],
      2: [call('task_handoff', { task: '{task}', conclusion: OVER.depClose, outcome: 'close_done' }),
        say('T1 closed.')],
      3: [call('task_handoff', { task: '{task}', conclusion: 'Main work checked', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'The big change is done' }),
        say('Request 1 closed.')],
    } },
  ],

  // TB-30 换模型重发（lead 的候选 swa → swb → swc，executor 的候选 ta → tb → tc，都在 tbs 上）：
  // lead 第一次请求在 swa 上 404（原地换到 swb 重发），第二次在 swb 上 404（回复中换到 swc，重做这次回复）；
  // T1 第一次请求在 ta 上 404（原地换到 tb），第二次在 tb 上 404（已有过程：结束本轮，在 tc 上从工作卡重来）。
  'tb-misc-switch': [
    { role: 'lead', kind: 'merged-create', deliveries: {
      1: [fail(404, { model: 'fake-swa' }), call('board_read', {}),
        fail(404, { model: 'fake-swb' }), call('request_submit', { title: 'Switch models', goal: 'Read README.md' }),
        call('task_create', { request: 1, title: 'Read README', description: 'Read README.md', assignee: 'executor',
          limits: { write: false } }),
        say('Registered request 1.')],
      2: [say('Request 1 is done.')],
    } },
    { role: 'executor', kind: 'task', task: 'T1', deliveries: {
      1: [fail(404, { model: 'fake-ta' }), call('read', { path: 'README.md' }),
        fail(404, { model: 'fake-tb' }), call('task_handoff', { task: '{task}', conclusion: 'Read it', outcome: 'done',
          evidence: ['{tag:read}'] })],
      'restart-1': [call('read', { path: 'README.md' }),
        call('task_handoff', { task: '{task}', conclusion: 'Read it on the new model', outcome: 'done',
          evidence: ['{tag:read}'] })],
    } },
    { role: 'lead', kind: 'close', deliveries: {
      1: [call('task_handoff', { task: '{task}', conclusion: 'Read', outcome: 'close_done' }),
        call('request_close', { request: 1, outcome: 'done', conclusion: 'README.md was read' }),
        say('Request 1 closed.')],
    } },
  ],

  // TB-30 压缩之后（lead 的模型窗口 32000，pi 的 reserveTokens 16000）：协作模式一直开着，每条长消息只回一句；
  // 压缩之后的投递序号随保留的消息变化，所以每个序号都回同一句。
  'tb-misc-compact': [
    { role: 'lead', kind: 'merged-create', deliveries: Object.fromEntries(Array.from({ length: 12 },
      (_, i) => [i + 1, [say(`Noted message ${i + 1}.`)]])) },
  ],
};
