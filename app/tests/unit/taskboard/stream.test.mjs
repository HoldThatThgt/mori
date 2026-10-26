// 界面里对话流的纯函数（renderer/src/state/transcript.ts、turns.ts、history.ts）的单元测试
// （docs/specs/parallel-agents-taskboard.md §5.6、§11.4、§13.2、§13.7、§13.11）：程序投递的 wake 只在它自己没能发出时去掉；
// Esc 交回文字时下一次投递已经开始准备，它的“发送中”与 wake 留着；分开时紧跟你新消息的回执不让上一轮重新算作正在进行；
// 模式改变的提示行（实时与重新打开）。事件与会话条目是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const { applyEvent } = await loadKernelModule('src/renderer/src/state/transcript.ts');
const { emptyTranscript } = await loadKernelModule('src/renderer/src/state/model.ts');
const { lastTurnEnded } = await loadKernelModule('src/renderer/src/state/turns.ts');
const { STOPPED_BEFORE_SENDING } = await loadKernelModule('src/shared/models.ts');

const NOW = 1_000_000;
const WAKE_TEXT = '[Mori] Request 1 closed. Tell the user.';

/** @brief 依次归并一组事件。 */
const play = (state, events) => events.reduce((next, event) => applyEvent(next, event, NOW), state);
/** @brief 一条 role 为 user 的 message_start。 */
const userStart = (text) => ({ type: 'message_start', message: { role: 'user', content: text, timestamp: NOW } });
/** @brief 准备中被停止的 mori.prompt_error。 */
const stopped = (text, queued = [], running = false) => ({ type: 'mori.prompt_error', message: STOPPED_BEFORE_SENDING,
  text, refs: text === null ? null : [], running, queued });

test('TB-31 Esc gives back the withdrawn messages (text set) after the next program delivery started preparing: its '
  + 'wake and "sending" stay, and its [Mori] message is not shown as yours', () => {
  const preparing = play(emptyTranscript, [{ type: 'mori.wake', text: WAKE_TEXT, kind: 'request_closed' }]);
  assert.equal(preparing.sending, true);
  const after = play(preparing, [stopped('A second message', ['A third message'], true)]);
  assert.equal(after.sending, true);
  assert.equal(after.wakes.length, 1);
  const started = play(after, [userStart(WAKE_TEXT)]);
  assert.deepEqual(started.items.map((item) => item.kind), ['wake']);
  assert.equal(started.lastUserText, null);
});

test('TB-31 a program delivery that could not be sent (text null) drops only the oldest recorded wake', () => {
  const two = play(emptyTranscript, [{ type: 'mori.wake', text: WAKE_TEXT, kind: 'request_closed' },
    { type: 'mori.wake', text: '[Mori] Request 2 closed. Tell the user.', kind: 'request_closed' }]);
  const after = play(two, [stopped(null)]);
  assert.deepEqual(after.wakes.map((wake) => wake.text), ['[Mori] Request 2 closed. Tell the user.']);
  const unavailable = play(two, [{ type: 'mori.model_unavailable', candidates: [], firstRequest: true, text: null,
    queued: [] }]);
  assert.equal(unavailable.wakes.length, 1);
});

test('TB-31 with no recorded wake the Esc withdrawal ends sending as before (nothing is preparing)', () => {
  const sending = { ...emptyTranscript, sending: true, pendingQueue: ['held'] };
  const after = play(sending, [stopped('A second message')]);
  assert.equal(after.sending, false);
  assert.deepEqual(after.pendingQueue, []);
});

/** @brief 对话流里的一项（只有 lastTurnEnded 看的 kind）。 */
const item = (kind, key) => ({ kind, key });

test('TB-08 a receipt right after your new message does not make the finished turn the live one again', () => {
  assert.equal(lastTurnEnded([item('user', 'u1'), item('assistant', 'a1'), item('user', 'u2'),
    item('receipt', 'r2')]), true);
  assert.equal(lastTurnEnded([item('user', 'u1'), item('assistant', 'a1'), item('wake', 'w1'),
    item('progress', 'p1')]), true);
  assert.equal(lastTurnEnded([item('user', 'u1'), item('assistant', 'a1'), item('progress', 'p1')]), false);
  assert.equal(lastTurnEnded([item('user', 'u1'), item('assistant', 'a1')]), false);
  assert.equal(lastTurnEnded([item('user', 'u1'), item('assistant', 'a1'), item('stopped', 's1')]), false);
  assert.equal(lastTurnEnded([]), false);
});

// ---- 模式改变的提示（§13.11，TB-58） ----

const { transcriptFromEntries } = await loadKernelModule('src/renderer/src/state/history.ts');
const { addPendingPrompt } = await loadKernelModule('src/renderer/src/state/model.ts');

/** @brief 对话流里的项，只看种类与模式（提示）或文字（消息）。 */
const shape = (state) => state.items.map((one) => (one.kind === 'team-mode' ? `mode:${one.mode}`
  : one.kind === 'user' ? `user:${one.text}${one.pending ? '*' : ''}` : one.kind));

test('TB-58 live: each mori.team_mode adds one notice line at the end; two changes in a row stay two lines', () => {
  const state = play(emptyTranscript, [{ type: 'mori.team_mode', mode: 'always' },
    { type: 'mori.team_mode', mode: 'once' }, { type: 'mori.team_mode', mode: 'off' }]);
  assert.deepEqual(shape(state), ['mode:always', 'mode:once', 'mode:off']);
});

test('TB-58 live: the notice for /task <text> goes before the message shown while it is being prepared, as when '
  + 'the session is reopened', () => {
  const pending = addPendingPrompt(emptyTranscript, 'List the files', []);
  const state = play(pending, [{ type: 'mori.team_mode', mode: 'once' }]);
  assert.deepEqual(shape(state), ['mode:once', 'user:List the files*']);
  assert.equal(new Set(state.items.map((one) => one.key)).size, 2, 'keys stay unique');
  assert.equal(state.sending, true);
});

test('TB-58 reopened: every mori.team entry is a notice line in place, and runs keep their mode for tool titles',
  () => {
  let n = 0;
  const entry = (customType, data) => ({ type: 'custom', id: `e${n += 1}`, customType, data });
  const message = (role, value) => ({ type: 'message', id: `e${n += 1}`, message: { role, content: value,
    timestamp: NOW } });
  const entries = [entry('mori.team', { mode: 'once', tools: ['read'] }), message('user', 'List the files'),
    message('assistant', [{ type: 'text', text: 'Registered.' }]), entry('mori.team', { mode: 'always' }),
    entry('mori.team', { mode: 'once' }), entry('mori.team', { mode: 'off' }), message('user', 'ok'),
    entry('mori.team', { mode: 'bogus' })];
  const state = transcriptFromEntries(entries);
  assert.deepEqual(shape(state), ['mode:once', 'user:List the files', 'assistant', 'mode:always', 'mode:once',
    'mode:off', 'user:ok']);
  assert.equal(state.runTeamMode, 'off');
});
