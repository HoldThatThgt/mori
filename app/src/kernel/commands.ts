// 执行界面发来的、已经过 zod 校验的命令。

import type { Command, ConfigInfo, EventEnvelope } from '../shared/protocol';
import { cancelTest, readConnection, saveConnection, testConnection } from './config';
import { loadPi } from './pi';
import { abort, clearQueue, createSession, openSession, prompt, sessionState } from './sessions';

/** @brief 执行一条命令并返回结果；失败时抛错，由调用方回复给界面。 */
export async function handleCommand(command: Command, emit: (envelope: EventEnvelope) => void): Promise<unknown> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  switch (command.type) {
    case 'config.get': {
      const info: ConfigInfo = { agentDir, saved: await readConnection(agentDir) };
      return info;
    }
    case 'connection.save':
      return { error: await saveConnection(agentDir, command.connection) };
    case 'connection.test':
      return testConnection();
    case 'connection.testCancel':
      return { cancelled: cancelTest() };
    case 'session.create':
      return createSession(command.cwd, emit);
    case 'session.open':
      return openSession(command.sessionFile, emit);
    case 'session.prompt':
      return prompt(command.sessionId, command.text, command.behavior, emit);
    case 'session.clearQueue':
      return clearQueue(command.sessionId);
    case 'session.abort':
      return abort(command.sessionId);
    case 'session.state':
      return sessionState(command.sessionId);
  }
}
