// 界面里对话流的纯函数（renderer/src/state/transcript.ts、turns.ts）的单元测试（docs/specs/parallel-agents-taskboard.md
// §5.6、§11.4、§13.2、§13.7）：程序投递的 wake 只在它自己没能发出时去掉；Esc 交回文字时下一次投递已经开始准备，
// 它的“发送中”与 wake 留着；分开时紧跟你新消息的回执不让上一轮重新算作正在进行。事件是手写的（synthetic）。

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
