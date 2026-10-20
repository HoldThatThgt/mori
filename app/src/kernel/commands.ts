// 执行界面发来的、已经过 zod 校验的命令。

import type { Command, EventEnvelope } from '../shared/protocol';
import { readAgents, saveAgents } from './agents';
import {
  cancelTest, deleteModel, readConfig, saveConnection, saveEndpoint, saveModel, setDefaultModel, testConnection,
} from './config';
import { removeMcpServer, saveMcpServer, setMcpDirect, setMcpEnabled } from './mcpConfig';
import { loadPi } from './pi';
import { addPackage, readTools, removePackage, setPackageEnabled, toggleResource } from './resources';
import {
  abort, answerApproval, answerQuestion, clearQueue, closeSession, createSession, forgetApproval, listSessions,
  openSession, prompt, readSession, refreshSessionModels, renameSession, sessionCommands, sessionState,
  setApprovalMode, setSessionModel, setSessionThinking,
} from './sessions';
import { checkTrust } from './trust';

type Emit = (envelope: EventEnvelope) => void;

/**
 * @brief 改了 models.json 或默认模型之后：pi 重读 models.json（config.ts 里已 refresh），打开着的会话换成新的模型对象。
 */
async function afterModelsChange<T>(result: Promise<T>, emit: Emit): Promise<T> {
  const value = await result;
  await refreshSessionModels(emit);
  return value;
}

/** @brief 连接、模型与 AGENTS.md 的命令（M6）；不是这几种时返回 undefined。 */
async function handleConfigCommand(command: Command, agentDir: string, emit: Emit): Promise<unknown> {
  switch (command.type) {
    case 'connection.save':
      return afterModelsChange(saveConnection(agentDir, command.providerId, command.connection), emit);
    case 'endpoint.save':
      return afterModelsChange(saveEndpoint(agentDir, command.providerId, command.endpoint), emit);
    case 'model.save':
      return afterModelsChange(saveModel(agentDir, command.providerId, command.model, command.adding), emit);
    case 'model.delete':
      return afterModelsChange(deleteModel(agentDir, command.providerId, command.modelId), emit);
    case 'model.setDefault':
      return setDefaultModel(command.providerId, command.modelId);
    case 'agents.get':
      return readAgents(command.sessionId);
    case 'agents.save':
      return saveAgents(command.content);
    default:
      return undefined;
  }
}

/** @brief 工具页的命令（M6）；不是这几种时返回 undefined。 */
async function handleToolsCommand(command: Command): Promise<unknown> {
  switch (command.type) {
    case 'tools.get':
      return readTools(command.sessionId);
    case 'resource.toggle':
      return toggleResource(command.sessionId, command.kind, command.path, command.enabled);
    case 'package.add':
      return addPackage(command.path);
    case 'package.setAll':
      return setPackageEnabled(command.source, command.enabled);
    case 'package.remove':
      return removePackage(command.source);
    case 'mcp.save':
      return saveMcpServer(command.name, command.previousName, command.entry);
    case 'mcp.setEnabled':
      return setMcpEnabled(command.name, command.enabled);
    case 'mcp.setDirect':
      return setMcpDirect(command.name);
    case 'mcp.remove':
      return removeMcpServer(command.name);
    default:
      return undefined;
  }
}

/** @brief 会话的命令；不是这几种时返回 undefined。 */
function handleSessionCommand(command: Command, emit: Emit): Promise<unknown> | unknown {
  switch (command.type) {
    case 'trust.check': return checkTrust(command.cwd);
    case 'session.create': return createSession(command.cwd, emit, command.trust);
    case 'session.open': return openSession(command.sessionFile, emit, command.trust);
    case 'session.list': return listSessions();
    case 'session.read': return readSession(command.sessionFile);
    case 'session.rename': return renameSession(command.sessionId, command.sessionFile, command.name);
    case 'session.close': return closeSession(command.sessionId);
    case 'ui.answer': return answerQuestion(command.sessionId, command.requestId, command.value);
    case 'session.prompt':
      return prompt(command.sessionId, command.text, { behavior: command.behavior, refs: command.refs }, emit);
    case 'session.clearQueue': return clearQueue(command.sessionId);
    case 'session.abort': return abort(command.sessionId);
    case 'session.state': return sessionState(command.sessionId);
    case 'session.setModel': return setSessionModel(command.sessionId, command.model, emit);
    case 'session.setThinking': return setSessionThinking(command.sessionId, command.level, emit);
    case 'session.commands': return sessionCommands(command.sessionId);
    case 'approval.answer':
      return answerApproval(command.sessionId, command.requestId, command.decision, command.reason);
    case 'approval.setMode': return setApprovalMode(command.sessionId, command.mode);
    case 'approval.forget': return forgetApproval(command.sessionId, command.toolName);
    default: return undefined;
  }
}

/** @brief 执行一条命令并返回结果；失败时抛错，由调用方回复给界面。 */
export async function handleCommand(command: Command, emit: Emit): Promise<unknown> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  switch (command.type) {
    case 'config.get':
      return readConfig(agentDir);
    case 'connection.test':
      return testConnection(command.providerId, command.modelId);
    case 'connection.testCancel':
      return { cancelled: cancelTest() };
  }
  const config = await handleConfigCommand(command, agentDir, emit);
  if (config !== undefined) return config;
  const tools = await handleToolsCommand(command);
  if (tools !== undefined) return tools;
  return handleSessionCommand(command, emit);
}
