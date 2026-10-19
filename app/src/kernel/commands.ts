// 执行界面发来的、已经过 zod 校验的命令。

import type { Command, ConfigInfo, EventEnvelope } from '../shared/protocol';
import { readConnection, saveConnection, testConnection } from './config';
import { loadPi } from './pi';
import { abort, createSession, prompt } from './sessions';

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
    case 'session.create':
      return createSession(command.cwd, emit);
    case 'session.prompt':
      return prompt(command.sessionId, command.text, emit);
    case 'session.abort':
      return abort(command.sessionId);
  }
}
