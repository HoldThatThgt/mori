// F8 报告里“最近的操作”对平行 Agent 与 TaskBoard 命令的文字（docs/specs/parallel-agents-taskboard.md §13.10，
// 2026-10-26 WP-09 改为 Task mode 的说法）：actionLog.ts 的 describeCommand。命令先经 protocol.ts 的 CommandSchema
// 校验，保证测的是界面真会发出的形状。会话标识与消息文字为 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const P = await loadKernelModule('src/shared/protocol.ts');
const A = await loadKernelModule('src/renderer/src/state/actionLog.ts');

const sessionId = 's-1';

test('TB-53 F8 action log words for the task mode commands (§13.10)', () => {
  const cases = [
    [{ type: 'session.setTeam', sessionId, mode: 'on' }, 'Task mode on'],
    [{ type: 'session.setTeam', sessionId, mode: 'off' }, 'Task mode off'],
    [{ type: 'session.stopTeam', sessionId }, 'Stop agents'],
    [{ type: 'session.recheckAgents', sessionId }, 'Check agent files'],
    [{ type: 'session.prompt', sessionId, text: 'Fix the login page', team: 'once' },
      'Send (task mode): Fix the login page'],
    // 生成中以 /team <文字> 排队也记 Send (task mode)：消息进待判断队列，不是 pi 的排队
    [{ type: 'session.prompt', sessionId, text: 'Then  add\na test', behavior: 'followUp', team: 'once' },
      'Send (task mode): Then add a test'],
    [{ type: 'session.prompt', sessionId, text: 'Fix the login page' }, 'Send: Fix the login page'],
    [{ type: 'board.get', sessionId }, null],
  ];
  for (const [command, text] of cases) {
    assert.equal(A.describeCommand(P.CommandSchema.parse(command)), text, JSON.stringify(command));
  }
});

test('TB-53 F8 action log cuts a long task mode message like a plain send', () => {
  const text = 'x'.repeat(100);
  const once = A.describeCommand(P.CommandSchema.parse({ type: 'session.prompt', sessionId, text, team: 'once' }));
  const plain = A.describeCommand(P.CommandSchema.parse({ type: 'session.prompt', sessionId, text }));
  assert.equal(once, plain.replace(/^Send: /, 'Send (task mode): '));
  assert.ok(once.endsWith('…'), once);
});
