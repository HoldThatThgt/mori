// 界面的状态函数（docs/specs/finish-check.md §10，验收 FC-17、FC-23 的单元层）：任何地方都不画 finish
// （blocksFromContent、增量、开始执行、执行中、结束、mori.tool_gate），只有 finish 的助手消息不留项（实时、打开会话、
// 接上运行中的会话），回复下操作行的位置（replyTurns），这次运行的模式（withRunMode），错误卡的放回链接（afterReply）。
// 事件、会话条目与接上时的快照都是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const { applyEvent, withRunMode } = await loadKernelModule('src/renderer/src/state/transcript.ts');
const { afterReplyOf, blocksFromContent, emptyTranscript, finishOnly } =
  await loadKernelModule('src/renderer/src/state/model.ts');
const { attachLive, transcriptFromEntries } = await loadKernelModule('src/renderer/src/state/history.ts');
const { replyTurns } = await loadKernelModule('src/renderer/src/state/turns.ts');
const { FINISH_CHECK_TYPE, FINISH_TOOL } = await loadKernelModule('src/shared/finishCheck.ts');

const NOW = 1_000_000;
const ASK = 'Run the tests';
const REPLY = 'The tests passed.';
const WAKE_TEXT = '[Mori] Request 1 closed. Tell the user.';
const CHECK_TEXT = "[Mori] This is Mori's end-of-turn check, not a message from the user.";

// ---- synthetic 的内容块、事件与条目 ----

const text = (value) => ({ type: 'text', text: value });
const thinking = (value) => ({ type: 'thinking', thinking: value });
const call = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });
const FINISH = call('call_finish', FINISH_TOOL);
const BASH = call('call_bash', 'bash', { command: 'npm test' });

/** @brief 依次归并一组事件。 */
const play = (state, events) => events.reduce((next, event) => applyEvent(next, event, NOW), state);
/** @brief 一条 role 为 user 的 message_start。 */
const userStart = (value) => ({ type: 'message_start', message: { role: 'user', content: value, timestamp: NOW } });
/** @brief 助手消息的开始（内容还没有）。 */
const assistantStart = (time = NOW + 1) => ({ type: 'message_start',
  message: { role: 'assistant', content: [], timestamp: time } });
/** @brief 助手消息的结束：pi 给出的完整内容。 */
const assistantEnd = (content, stopReason = 'stop', errorMessage = undefined) => ({ type: 'message_end',
  message: { role: 'assistant', content, stopReason, errorMessage, timestamp: NOW + 1 } });
/** @brief 一条 message_update。 */
const update = (fields) => ({ type: 'message_update', update: fields });
/** @brief finish 的执行事件（开始、执行中、结束）。 */
const finishExecution = [
  { type: 'tool_execution_start', toolCallId: FINISH.id, toolName: FINISH_TOOL, args: {} },
  { type: 'tool_execution_update', toolCallId: FINISH.id, toolName: FINISH_TOOL, args: {}, partialResult: {} },
  { type: 'tool_execution_end', toolCallId: FINISH.id, toolName: FINISH_TOOL,
    result: { content: [text('Confirmed.')], details: {} }, isError: false },
];
/** @brief 运行中出错：出错的助手消息与 agent_end。 */
const failed = [assistantStart(NOW + 5), assistantEnd([], 'error', 'Connection error.'),
  { type: 'agent_end', messages: [] }];
/** @brief 压缩失败的 compaction_end。 */
const compactionFailed = { type: 'compaction_end', reason: 'overflow', result: undefined, aborted: false,
  willRetry: false, errorMessage: 'Context overflow recovery failed.' };

let entrySeq = 0;
/** @brief 会话文件里的一条消息条目。 */
const entry = (message) => {
  entrySeq += 1;
  return { type: 'message', id: `e${entrySeq}`, parentId: null, timestamp: '2026-10-27T09:00:00.000Z',
    message: { timestamp: NOW + entrySeq, ...message } };
};
const userEntry = (value) => entry({ role: 'user', content: value });
const assistantEntry = (content, stopReason = 'stop', errorMessage = undefined) => entry({ role: 'assistant', content,
  stopReason, errorMessage });
const resultEntry = (tool, output, isError = false) => entry({ role: 'toolResult', toolCallId: tool.id,
  toolName: tool.name, content: [text(output)], isError });
/** @brief 检查那一行的 custom_message 条目（界面不画它）。 */
const checkEntry = () => {
  entrySeq += 1;
  return { type: 'custom_message', id: `e${entrySeq}`, parentId: null, timestamp: '2026-10-27T09:00:00.000Z',
    customType: FINISH_CHECK_TYPE, content: CHECK_TEXT, display: false };
};
/** @brief 接上运行中的会话时的快照（attachLive 读到的字段；提问卡与你不在的计时为空，file-system-permissions.md §9、§10）。 */
const live = (streaming = null) => ({ running: true, preparing: false, streaming, runningTools: [], approvals: [],
  teamApprovals: [], questions: [], asks: [], awayTimers: [], steering: [], followUp: [] });

const assistants = (state) => state.items.filter((item) => item.kind === 'assistant');
const kinds = (state) => state.items.map((item) => item.kind);
const lastItem = (state) => state.items[state.items.length - 1];
/** @brief 一项助手回复里界面会显示的段（同 AssistantMessage.tsx：工具卡、非空的正文与思考）。 */
const visibleBlocks = (item) => item.blocks.filter((block) => block.type === 'tool' || block.text.trim());

/** @brief 你的消息之后一段文字回复已经结束、还在运行（检查那次请求之前）。 */
const afterTextReply = () => play(emptyTranscript, [{ type: 'agent_start' }, userStart(ASK), { type: 'turn_start' },
  assistantStart(), update({ type: 'text_delta', contentIndex: 0, delta: REPLY }), assistantEnd([text(REPLY)])]);
/** @brief 你的消息之后一条带 bash 调用的回复与它的执行。 */
const afterToolCall = () => play(emptyTranscript, [{ type: 'agent_start' }, userStart(ASK), { type: 'turn_start' },
  assistantStart(), assistantEnd([text('Running them.'), BASH], 'toolUse'),
  { type: 'tool_execution_start', toolCallId: BASH.id, toolName: 'bash', args: BASH.arguments },
  { type: 'tool_execution_end', toolCallId: BASH.id, toolName: 'bash', result: { content: [text('ok')] },
    isError: false }]);

// ---- FC-17 错误卡的放回链接 ----

test('FC-17 afterReplyOf: true after a text reply, a finish-only message keeps it, other tool calls make it false, '
  + 'error and aborted messages never change it', () => {
  assert.equal(afterReplyOf([text(REPLY)], 'stop', false), true);
  assert.equal(afterReplyOf([text(REPLY), FINISH], 'toolUse', false), true);
  assert.equal(afterReplyOf([text('Cut off')], 'length', false), true);
  assert.equal(afterReplyOf([FINISH], 'toolUse', true), true);
  assert.equal(afterReplyOf([FINISH], 'toolUse', false), false);
  assert.equal(afterReplyOf([thinking('Fine.'), FINISH], 'toolUse', true), true);
  assert.equal(afterReplyOf([thinking('Fine.')], 'stop', false), false);
  assert.equal(afterReplyOf([], 'stop', true), true);
  assert.equal(afterReplyOf([text('   ')], 'stop', false), false);
  assert.equal(afterReplyOf([text('Running them.'), BASH], 'toolUse', true), false);
  assert.equal(afterReplyOf([BASH, FINISH], 'toolUse', true), false);
  for (const stopReason of ['error', 'aborted']) {
    assert.equal(afterReplyOf([text('Half a rep')], stopReason, false), false);
    assert.equal(afterReplyOf([text('Half a rep'), BASH], stopReason, true), true);
    assert.equal(afterReplyOf([FINISH], stopReason, true), true);
  }
});

test('FC-17 live: a text reply sets afterReply, the finish-only and the failed check message keep it, your next '
  + 'message and a program delivery clear it, a tool call clears it', () => {
  const reply = afterTextReply();
  assert.equal(reply.afterReply, true);
  const confirmed = play(reply, [{ type: 'turn_start' }, assistantStart(NOW + 2), assistantEnd([FINISH], 'toolUse'),
    ...finishExecution]);
  assert.equal(confirmed.afterReply, true);
  const errored = play(reply, [assistantStart(NOW + 2), assistantEnd([text('Par')], 'error', 'Connection error.')]);
  assert.equal(errored.afterReply, true);
  const aborted = play(reply, [assistantStart(NOW + 2), assistantEnd([], 'aborted', 'Request was aborted')]);
  assert.equal(aborted.afterReply, true);
  const settled = play(confirmed, [{ type: 'agent_end', messages: [] }, { type: 'agent_settled', aborted: false }]);
  assert.equal(play(settled, [userStart('Thanks')]).afterReply, false);
  const delivered = play(settled, [{ type: 'mori.wake', text: WAKE_TEXT, kind: 'request_closed' },
    userStart(WAKE_TEXT)]);
  assert.deepEqual(kinds(delivered).slice(-1), ['wake']);
  assert.equal(delivered.afterReply, false);
  const worked = play(reply, [assistantStart(NOW + 2), assistantEnd([BASH], 'toolUse')]);
  assert.equal(worked.afterReply, false);
  assert.equal(lastItem(play(worked, failed)).restore, ASK);
  assert.equal(afterToolCall().afterReply, false);
});

test('FC-17 the check request fails after a text reply: the error card shows the text without "Put your last message '
  + 'back in the message box"; when the first request fails the card keeps it', () => {
  const card = lastItem(play(afterTextReply(), failed));
  assert.equal(card.kind, 'error');
  assert.equal(card.text, 'Connection error.');
  assert.equal(card.restore, null);
  const first = play(emptyTranscript, [{ type: 'agent_start' }, userStart(ASK), { type: 'turn_start' }, ...failed]);
  assert.equal(lastItem(first).kind, 'error');
  assert.equal(lastItem(first).restore, ASK);
  const afterTool = lastItem(play(afterToolCall(), failed));
  assert.equal(afterTool.kind, 'error');
  assert.equal(afterTool.restore, ASK);
});

test('FC-17 opening a session keeps the same rule: transcriptFromEntries sets afterReply like the live path', () => {
  const user = userEntry(ASK);
  assert.equal(transcriptFromEntries([user, assistantEntry([text(REPLY)])]).afterReply, true);
  assert.equal(transcriptFromEntries([user, assistantEntry([text(REPLY)]), checkEntry(),
    assistantEntry([FINISH], 'toolUse'), resultEntry(FINISH, 'Confirmed.')]).afterReply, true);
  assert.equal(transcriptFromEntries([user, assistantEntry([text(REPLY)]), checkEntry(),
    assistantEntry([text('Par')], 'error', 'Connection error.')]).afterReply, true);
  assert.equal(transcriptFromEntries([user, assistantEntry([text('Running them.'), BASH], 'toolUse'),
    resultEntry(BASH, 'ok')]).afterReply, false);
  assert.equal(transcriptFromEntries([user, assistantEntry([text(REPLY)]), userEntry('Thanks')]).afterReply, false);
  assert.equal(transcriptFromEntries([user]).afterReply, false);
});

test('FC-17 transcriptFromEntries([your message, text reply]) then attachLive (running): the failed message_end and '
  + 'agent_end push an error card with restore null; after a tool call the same sequence keeps the restore', () => {
  const opened = transcriptFromEntries([userEntry(ASK), assistantEntry([text(REPLY)])]);
  const resumed = attachLive(opened, live(), NOW);
  assert.equal(resumed.running, true);
  assert.equal(resumed.afterReply, true);
  const card = lastItem(play(resumed, failed));
  assert.equal(card.kind, 'error');
  assert.equal(card.live, true);
  assert.equal(card.restore, null);
  const withTool = transcriptFromEntries([userEntry(ASK), assistantEntry([text('Running them.'), BASH], 'toolUse'),
    resultEntry(BASH, 'ok')]);
  const toolCard = lastItem(play(attachLive(withTool, live(), NOW), failed));
  assert.equal(toolCard.kind, 'error');
  assert.equal(toolCard.restore, ASK);
});

test('FC-17 compaction_end with errorMessage: restore null after a text reply, the last message after a tool call',
  () => {
    const afterReply = lastItem(play(afterTextReply(), [compactionFailed]));
    assert.equal(afterReply.kind, 'error');
    assert.equal(afterReply.text, 'Context overflow recovery failed.');
    assert.equal(afterReply.restore, null);
    const afterTool = lastItem(play(afterToolCall(), [compactionFailed]));
    assert.equal(afterTool.kind, 'error');
    assert.equal(afterTool.restore, ASK);
  });

// ---- FC-23 界面不画 finish ----

test('FC-23 blocksFromContent turns a finish call into an empty text block at the same index and keeps it out of '
  + 'tools', () => {
  const { blocks, tools } = blocksFromContent([thinking('Check it.'), text(REPLY), FINISH, BASH]);
  assert.deepEqual(blocks, [{ type: 'thinking', text: 'Check it.', streaming: false }, { type: 'text', text: REPLY },
    { type: 'text', text: '' }, { type: 'tool', id: BASH.id }]);
  assert.deepEqual(tools.map((tool) => tool.name), ['bash']);
  const only = blocksFromContent([FINISH]);
  assert.deepEqual(only.blocks, [{ type: 'text', text: '' }]);
  assert.deepEqual(only.tools, []);
});

test('FC-23 finishOnly: a finish call with no other call, no non-empty text or thinking; content only', () => {
  assert.equal(finishOnly([FINISH]), true);
  assert.equal(finishOnly([text('  \n'), FINISH]), true);
  assert.equal(finishOnly([thinking(''), FINISH]), true);
  assert.equal(finishOnly([text(REPLY), FINISH]), false);
  assert.equal(finishOnly([thinking('Fine.'), FINISH]), false);
  assert.equal(finishOnly([FINISH, BASH]), false);
  assert.equal(finishOnly([BASH]), false);
  assert.equal(finishOnly([text(REPLY)]), false);
  assert.equal(finishOnly([]), false);
  assert.equal(finishOnly('finish'), false);
});

test('FC-23 finish deltas, execution and mori.tool_gate create no card and no block; the delta still sets the '
  + 'generating stage, the rest leave the stage alone', () => {
  const waiting = play(afterTextReply(), [{ type: 'turn_start' }, assistantStart(NOW + 2)]);
  assert.equal(waiting.stage.kind, 'waiting');
  const writing = play(waiting, [
    update({ type: 'toolcall_start', contentIndex: 0, toolName: FINISH_TOOL, toolCallId: FINISH.id }),
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{}', toolName: FINISH_TOOL, toolCallId: FINISH.id }),
    update({ type: 'toolcall_end', contentIndex: 0, toolName: FINISH_TOOL, toolCallId: FINISH.id, args: {} }),
  ]);
  assert.equal(writing.stage.kind, 'generating');
  assert.equal(writing.tools[FINISH.id], undefined);
  assert.deepEqual(assistants(writing).at(-1).blocks, []);
  const ended = play(writing, [assistantEnd([FINISH], 'toolUse')]);
  const gate = { type: 'mori.tool_gate', toolCallId: FINISH.id, toolName: FINISH_TOOL, gate: 'free' };
  for (const event of [gate, ...finishExecution]) assert.equal(applyEvent(ended, event, NOW), ended, event.type);
  const busy = { ...ended, stage: { kind: 'tool', since: NOW, detail: 'call_other' } };
  for (const event of [gate, ...finishExecution]) assert.equal(applyEvent(busy, event, NOW).stage, busy.stage);
});

test('FC-23 a nameless toolcall_start then a finish delta leaves no tool block at that index and no tool; a nameless '
  + 'start then a bash delta still gets its card', () => {
  const started = play(afterTextReply(), [assistantStart(NOW + 2),
    update({ type: 'toolcall_start', contentIndex: 0, toolName: '', toolCallId: FINISH.id })]);
  assert.equal(started.stage.kind, 'generating');
  const named = play(started, [
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{}', toolName: FINISH_TOOL, toolCallId: FINISH.id })]);
  const last = assistants(named).at(-1);
  assert.notEqual(last.blocks[0]?.type, 'tool');
  assert.equal(named.tools[FINISH.id], undefined);
  assert.deepEqual(Object.keys(named.tools), []);
  const bash = play(afterTextReply(), [assistantStart(NOW + 2),
    update({ type: 'toolcall_start', contentIndex: 0, toolName: '', toolCallId: BASH.id }),
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"command"', toolName: 'bash', toolCallId: BASH.id })]);
  assert.deepEqual(assistants(bash).at(-1).blocks, [{ type: 'tool', id: BASH.id }]);
  assert.equal(bash.tools[BASH.id].name, 'bash');
});

test('FC-23 live: a finish-only message drops its item at message_end; finish with thinking keeps one item', () => {
  const reply = afterTextReply();
  const replyItem = assistants(reply).at(-1);
  const confirmed = play(reply, [{ type: 'turn_start' }, assistantStart(NOW + 2), assistantEnd([FINISH], 'toolUse'),
    ...finishExecution, { type: 'agent_end', messages: [] }, { type: 'agent_settled', aborted: false }]);
  assert.deepEqual(kinds(confirmed), ['user', 'assistant']);
  assert.equal(assistants(confirmed).at(-1), replyItem);
  assert.deepEqual(confirmed.tools, {});
  assert.equal(confirmed.stage, null);
  const thought = play(reply, [{ type: 'turn_start' }, assistantStart(NOW + 2),
    update({ type: 'thinking_delta', contentIndex: 0, delta: 'Looks complete.' }),
    update({ type: 'toolcall_start', contentIndex: 1, toolName: FINISH_TOOL, toolCallId: FINISH.id }),
    assistantEnd([thinking('Looks complete.'), FINISH], 'toolUse'), ...finishExecution]);
  assert.deepEqual(kinds(thought), ['user', 'assistant', 'assistant']);
  assert.deepEqual(assistants(thought).at(-1).blocks, [{ type: 'thinking', text: 'Looks complete.', streaming: false },
    { type: 'text', text: '' }]);
  for (const item of assistants(thought)) assert.ok(visibleBlocks(item).length > 0, item.key);
  assert.deepEqual(thought.tools, {});
});

test('FC-23 opening a session: finish calls and results are not drawn, a finish-only message leaves no item; one '
  + 'stopped while writing finish adds a stopped line, one that failed an error card with restore null', () => {
  const head = () => [userEntry(ASK), assistantEntry([text(REPLY)]), checkEntry()];
  const confirmed = transcriptFromEntries([...head(), assistantEntry([FINISH], 'toolUse'),
    resultEntry(FINISH, 'Confirmed.')]);
  assert.deepEqual(kinds(confirmed), ['user', 'assistant']);
  assert.deepEqual(confirmed.tools, {});
  const aborted = transcriptFromEntries([...head(), assistantEntry([FINISH], 'aborted', 'Request was aborted')]);
  assert.deepEqual(kinds(aborted), ['user', 'assistant', 'stopped']);
  const errored = transcriptFromEntries([...head(), assistantEntry([FINISH], 'error', 'Connection error.')]);
  assert.deepEqual(kinds(errored), ['user', 'assistant', 'error']);
  assert.equal(lastItem(errored).restore, null);
  assert.equal(lastItem(errored).text, 'Connection error.');
  const early = transcriptFromEntries([userEntry(ASK), assistantEntry([text(REPLY), FINISH], 'toolUse'),
    resultEntry(FINISH, 'Confirmed.'), checkEntry(), assistantEntry([FINISH], 'toolUse'),
    resultEntry(FINISH, 'Confirmed.')]);
  assert.deepEqual(kinds(early), ['user', 'assistant']);
  assert.deepEqual(early.items[1].blocks, [{ type: 'text', text: REPLY }, { type: 'text', text: '' }]);
  assert.deepEqual(early.tools, {});
});

test('FC-23 attachLive while the check request streams a finish-only message, then its message_end: the reply item '
  + 'stays the last assistant item, no extra item, no tool for the call', () => {
  const opened = transcriptFromEntries([userEntry(ASK), assistantEntry([text(REPLY)]), checkEntry()]);
  const replyItem = assistants(opened).at(-1);
  const partial = { role: 'assistant', content: [call(FINISH.id, FINISH_TOOL)], timestamp: NOW + 9 };
  const resumed = attachLive(opened, live(partial), NOW);
  assert.equal(assistants(resumed).length, 2);
  assert.equal(resumed.tools[FINISH.id], undefined);
  const ended = play(resumed, [assistantEnd([FINISH], 'toolUse'), ...finishExecution]);
  assert.deepEqual(kinds(ended), ['user', 'assistant']);
  assert.equal(assistants(ended).at(-1), replyItem);
  assert.equal(ended.tools[FINISH.id], undefined);
});

test('FC-23 attachLive while a tool call has no name yet: no card; a finish delta keeps it that way, a bash delta '
  + 'brings the card', () => {
  const opened = transcriptFromEntries([userEntry(ASK), assistantEntry([text(REPLY)]), checkEntry()]);
  const nameless = (id) => ({ role: 'assistant', content: [call(id, '')], timestamp: NOW + 9 });
  const resumed = attachLive(opened, live(nameless(FINISH.id)), NOW);
  assert.deepEqual(assistants(resumed).at(-1).blocks, [{ type: 'text', text: '' }]);
  assert.deepEqual(resumed.tools, {});
  const finish = play(resumed, [
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{}', toolName: FINISH_TOOL, toolCallId: FINISH.id })]);
  assert.deepEqual(finish.tools, {});
  assert.ok(assistants(finish).every((item) => item.blocks.every((block) => block.type !== 'tool')));
  const bash = play(attachLive(opened, live(nameless(BASH.id)), NOW), [
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"command"', toolName: 'bash', toolCallId: BASH.id })]);
  assert.deepEqual(assistants(bash).at(-1).blocks, [{ type: 'tool', id: BASH.id }]);
  assert.equal(bash.tools[BASH.id].name, 'bash');
});

/** @brief 对话流里的一项助手回复（replyTurns 只看 kind、key 与正文段）。 */
const replyItem = (key, blocks) => ({ kind: 'assistant', key, blocks, streaming: false, entryId: key, time: null });
const userItem = (key) => ({ kind: 'user', key, text: ASK, refs: null, entryId: key, time: null });
const progressItem = (key) => ({ kind: 'progress', key, request: 1 });

test('FC-23 replyTurns: the reply actions stay under the reply text, not a following thinking-only item; a progress '
  + 'summary after the reply still takes them', () => {
  const reply = replyItem('a1', [text(REPLY)]);
  const thought = replyItem('a2', [{ type: 'thinking', text: 'Looks complete.', streaming: false },
    { type: 'text', text: '' }]);
  assert.deepEqual([...replyTurns([userItem('u1'), reply, thought]).keys()], ['a1']);
  assert.equal(replyTurns([userItem('u1'), reply, thought]).get('a1').text, REPLY);
  assert.deepEqual([...replyTurns([userItem('u1'), reply, progressItem('p1')]).keys()], ['p1']);
  assert.deepEqual([...replyTurns([userItem('u1'), reply, thought, progressItem('p1')]).keys()], ['p1']);
  assert.deepEqual([...replyTurns([userItem('u1'), thought]).keys()], ['a2']);
  const second = replyItem('a3', [text('Final reply.')]);
  assert.deepEqual([...replyTurns([userItem('u1'), reply, thought, second]).keys()], ['a3']);
});

test('FC-23 withRunMode: the first agent_start records the mode, another agent_start in the same run keeps it, tool '
  + 'cards carry the run-start mode, the next run takes the new mode', () => {
  const start = { type: 'agent_start' };
  const idle = emptyTranscript;
  const first = applyEvent(withRunMode(idle, start, 'once'), start, NOW);
  assert.equal(first.runTeamMode, 'once');
  assert.equal(withRunMode(first, { type: 'turn_start' }, 'always'), first);
  const again = withRunMode(first, start, 'always');
  assert.equal(again, first);
  const card = play(applyEvent(again, start, NOW), [assistantStart(),
    { type: 'tool_execution_start', toolCallId: BASH.id, toolName: 'bash', args: BASH.arguments }]);
  assert.equal(card.runTeamMode, 'once');
  assert.equal(card.tools[BASH.id].teamMode, 'once');
  const settled = play(card, [{ type: 'agent_settled', aborted: false }]);
  const next = applyEvent(withRunMode(settled, start, 'always'), start, NOW);
  assert.equal(next.runTeamMode, 'always');
});
