// 依据跳转的落点（docs/specs/memory.md §8 session.read 的 anchor、§10.2）：没开着的会话在完整的当前分支上找这个条目，
// 或它之上最近的一条你的消息或助手回复（程序投递的 [Mori] 消息不算）；不在分支上为 null；没带 anchor 时结果没有这个字段。
// 会话文件由 pi 的 SessionManager 写出，消息内容为 synthetic。开着、在生成的会话走同一个查找，留给 App 层。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';

const { readSession } = await loadKernelModule('src/kernel/sessions.ts');

/** synthetic 的消息。 */
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
const reply = (content) => ({ role: 'assistant', content, provider: 'fake', model: 'm', api: 'openai-completions',
  stopReason: 'stop', usage: {}, timestamp: Date.now() });
const said = (text) => reply([{ type: 'text', text }]);
const toolResult = (id) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text',
  text: 'code' }], isError: false, timestamp: Date.now() });

/** 写一个会话：提问、工具调用与结果、回答、一条程序投递（mori.wake 指向它）和一条自定义条目。 */
function writeSession(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-mem-anchor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const manager = SessionManager.create(dir, dir);
  const ids = {};
  ids.ask = manager.appendMessage(user('Why is the login page blank?'));
  ids.call = manager.appendMessage(reply([{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }]));
  ids.result = manager.appendMessage(toolResult('c1'));
  ids.answer = manager.appendMessage(said('The router drops the token.'));
  ids.wake = manager.appendMessage(user('[Mori] relay: Tell them it works.'));
  ids.wakeEntry = manager.appendCustomEntry('mori.wake', { messageId: ids.wake, kind: 'relay' });
  ids.custom = manager.appendCustomEntry('mori.pick', { pick: 'strong' });
  return { manager, ids, file: manager.getSessionFile() };
}

test('MEM-15 session.read anchor: the entry itself, or the nearest message above it on the whole branch', async (t) => {
  const { ids, file } = writeSession(t);
  const anchorOf = async (id) => (await readSession(file, id)).anchor;
  assert.equal(await anchorOf(ids.ask), ids.ask, 'your message');
  assert.equal(await anchorOf(ids.answer), ids.answer, 'an assistant reply');
  assert.equal(await anchorOf(ids.result), ids.call, 'a tool result goes up to the tool call');
  assert.equal(await anchorOf(ids.wake), ids.answer, 'a program delivery is not a message you wrote');
  assert.equal(await anchorOf(ids.wakeEntry), ids.answer);
  assert.equal(await anchorOf(ids.custom), ids.answer);
  assert.equal(await anchorOf('no-such-entry'), null);
  assert.equal('anchor' in await readSession(file), false, 'no anchor asked, no anchor field');
});

test('MEM-15 session.read anchor is null for an entry on a branch that was left', async (t) => {
  const { manager, ids, file } = writeSession(t);
  manager.branch(ids.ask);
  const retry = manager.appendMessage(said('Let me look again.'));
  const content = await readSession(file, ids.result);
  assert.equal(content.anchor, null);
  assert.equal((await readSession(file, retry)).anchor, retry);
  assert.equal((await readSession(file, ids.ask)).anchor, ids.ask);
});
