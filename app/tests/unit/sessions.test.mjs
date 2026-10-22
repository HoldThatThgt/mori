// kernel/sessions.ts 的单元测试：排队消息记给模型层的是 pi 真正排进排队区的文字（§11.4、K13），
// 界面重新加载时准备中的会话按“准备中”交出（§11.4）。会话与 pi 都是替身（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const { streamingOptions, snapshot } = await loadKernelModule('src/kernel/sessions.ts');

/** 替身会话：pi 的排队区里是 queue，模型层记下的文字进 noted。 */
function fakeEntry(queue = []) {
  const noted = [];
  const model = { noteFollowUp: (text) => noted.push(text) };
  return { noted, entry: { session: { getFollowUpMessages: () => queue }, model } };
}

test('MP-13 a queued /skill command is noted as the expanded text pi queued, so it starts a new reply', () => {
  const expanded = '<skill name="review">Review the code…</skill>';
  const { noted, entry } = fakeEntry(['earlier', expanded]);
  const options = streamingOptions(entry, 'followUp');
  assert.equal(options.streamingBehavior, 'followUp');
  options.preflightResult('queued');
  assert.deepEqual(noted, [expanded]);
});

test('MP-13 queued text handled by an extension command or input handler is not noted', () => {
  const { noted, entry } = fakeEntry(['earlier']);
  streamingOptions(entry, 'followUp').preflightResult('handled');
  assert.deepEqual(noted, []);
});

test('MP-13 a steer is never noted (it does not start a new reply); idle sends get no streaming options', () => {
  const { noted, entry } = fakeEntry(['steer text']);
  const options = streamingOptions(entry, 'steer');
  assert.equal(options.streamingBehavior, 'steer');
  options.preflightResult('queued');
  assert.deepEqual(noted, []);
  assert.equal(streamingOptions(entry, undefined), undefined);
});

/** 替身会话条目：准备中（preparing 不为空）或在生成。 */
function liveEntry({ preparing, streaming }) {
  return {
    running: true, preparing, toolStarts: new Map(),
    session: { isStreaming: streaming, state: { pendingToolCalls: new Set(), streamingMessage: null },
      getSteeringMessages: () => [], getFollowUpMessages: () => [] },
    gate: { requests: () => [] }, ui: { requests: () => [] },
  };
}

test('MP-34 a session reattached while preparing reports preparing, with its held messages in the queue', () => {
  const preparing = { text: 'first', held: [{ text: 'second' }], phase: 'preparing' };
  const live = snapshot(liveEntry({ preparing, streaming: false }));
  assert.equal(live.preparing, true);
  assert.equal(live.running, true);
  assert.deepEqual(live.followUp, ['second']);
});

test('MP-34 once pi is running the snapshot is a run, not preparing', () => {
  const starting = { text: 'first', held: [], phase: 'starting' };
  assert.equal(snapshot(liveEntry({ preparing: starting, streaming: true })).preparing, false);
  assert.equal(snapshot(liveEntry({ preparing: null, streaming: true })).preparing, false);
});
