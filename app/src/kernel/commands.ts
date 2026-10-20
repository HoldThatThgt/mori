// 执行界面发来的、已经过 zod 校验的命令。

import type { Command, ConfigInfo, EventEnvelope } from '../shared/protocol';
import { cancelTest, readConnection, saveConnection, testConnection } from './config';
import { loadPi } from './pi';
import {
  abort, answerApproval, answerQuestion, clearQueue, closeSession, createSession, forgetApproval, listSessions,
  openSession, prompt, renameSession, sessionState, setApprovalMode,
} from './sessions';
import { checkTrust } from './trust';

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
    case 'trust.check':
      return checkTrust(command.cwd);
    case 'session.create':
      return createSession(command.cwd, emit, command.trust);
    case 'session.open':
      return openSession(command.sessionFile, emit, command.trust);
    case 'session.list':
      return listSessions();
    case 'session.rename':
      return renameSession(command.sessionId, command.sessionFile, command.name);
    case 'session.close':
      return closeSession(command.sessionId);
    case 'ui.answer':
      return answerQuestion(command.sessionId, command.requestId, command.value);
    case 'session.prompt':
      return prompt(command.sessionId, command.text, { behavior: command.behavior, refs: command.refs }, emit);
    case 'session.clearQueue':
      return clearQueue(command.sessionId);
    case 'session.abort':
      return abort(command.sessionId);
    case 'session.state':
      return sessionState(command.sessionId);
    case 'approval.answer':
      return answerApproval(command.sessionId, command.requestId, command.decision, command.reason);
    case 'approval.setMode':
      return setApprovalMode(command.sessionId, command.mode);
    case 'approval.forget':
      return forgetApproval(command.sessionId, command.toolName);
  }
}
