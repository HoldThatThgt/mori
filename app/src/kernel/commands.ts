// 执行界面发来的、已经过 zod 校验的命令。

import type { Command, EventEnvelope } from '../shared/protocol';
import { readAgents, saveAgents } from './agents';
import { cancelTest, readConfig, testConnection } from './config';
import { removeMcpServer, saveMcpServer, setMcpDirect, setMcpEnabled } from './mcpConfig';
import { handleMemoryCommand } from './memoryCommands';
import { handleModelsCommand, isModelsCommand } from './modelCommands';
import { loadPi } from './pi';
import {
  addPackage, readTools, removePackage, setDefaultTool, setPackageEnabled, toggleResource,
} from './resources';
import {
  abort, answerApproval, answerQuestion, boardView, clearQueue, closeSession, createSession, forgetApproval,
  listSessions, openSession, prompt, readSession, recheckAgents, renameSession, sessionCommands, sessionPickOptions,
  sessionState, setApprovalMode, setSessionPick, setSessionThinking, setTeamMode, stopTeam,
} from './sessions';
import { checkTrust } from './trust';

type Emit = (envelope: EventEnvelope) => void;

/** @brief AGENTS.md 的命令（M6）；不是这两种时返回 undefined。 */
async function handleAgentsCommand(command: Command): Promise<unknown> {
  switch (command.type) {
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
    case 'tools.setDefault':
      return setDefaultTool(command.sessionId, command.name, command.enabled);
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
    case 'session.read': return readSession(command.sessionFile, command.anchor);
    case 'session.rename': return renameSession(command.sessionId, command.sessionFile, command.name);
    case 'session.close': return closeSession(command.sessionId);
    case 'ui.answer': return answerQuestion(command.sessionId, command.requestId, command.value);
    case 'session.prompt':
      return prompt(command.sessionId, command.text,
        { behavior: command.behavior, refs: command.refs, team: command.team });
    case 'session.clearQueue': return clearQueue(command.sessionId);
    case 'session.abort': return abort(command.sessionId);
    case 'session.state': return sessionState(command.sessionId);
    case 'session.setThinking': return setSessionThinking(command.sessionId, command.level);
    // 模型层（docs/specs/model-providers.md §9.5）：换选择范围、范围菜单的各项
    case 'session.setPick': return setSessionPick(command.sessionId, command.pick);
    case 'session.pickOptions': return sessionPickOptions(command.sessionId);
    case 'session.commands': return sessionCommands(command.sessionId);
    case 'approval.answer':
      return answerApproval(command.sessionId, command.requestId, command.decision, command.reason);
    case 'approval.setMode': return setApprovalMode(command.sessionId, command.mode);
    case 'approval.forget': return forgetApproval(command.sessionId, command.toolName);
    // 平行 Agent 与 TaskBoard（docs/specs/parallel-agents-taskboard.md §13.10）
    case 'session.setTeam': return setTeamMode(command.sessionId, command.mode);
    case 'board.get': return boardView(command.sessionId);
    case 'session.recheckAgents': return recheckAgents(command.sessionId);
    case 'session.stopTeam': return stopTeam(command.sessionId);
    default: return undefined;
  }
}

/** @brief 执行一条命令并返回结果；失败时抛错，由调用方回复给界面。 */
export async function handleCommand(command: Command, emit: Emit): Promise<unknown> {
  switch (command.type) {
    case 'config.get':
      return readConfig((await loadPi()).getAgentDir());
    case 'connection.test':
      return testConnection(command);
    case 'connection.testCancel':
      return { cancelled: cancelTest() };
  }
  if (isModelsCommand(command)) return handleModelsCommand(command);
  const agents = await handleAgentsCommand(command);
  if (agents !== undefined) return agents;
  const tools = await handleToolsCommand(command);
  if (tools !== undefined) return tools;
  // 记忆与增强（docs/specs/memory.md §8）：在会话命令之前
  const memory = await handleMemoryCommand(command);
  if (memory !== undefined) return memory;
  return handleSessionCommand(command, emit);
}
