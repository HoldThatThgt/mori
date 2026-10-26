// 最近的操作记录：只在本次运行的内存里，F8 报告界面问题时附上（方案 5.15，见 docs/v0/screens/f8.md）。
// 只记操作的类型和不含机密的摘要：发送的消息只取前几十个字，模型层的命令（models.*）只记类型和 id
// （拉取模型的新提供商记 Base URL 的主机，docs/specs/model-discovery.md §5.5），
// 从不记 key 的明文（secret、keySecret，docs/specs/model-providers.md §9.4）。

import type { DiscoverTarget } from '../../../shared/models';
import { KIND_ONE, type Command } from '../../../shared/protocol';
import type { IssueAction } from '../../../shared/issues';

/** 保留的条数，临时默认值，见 docs/v0/defaults.md */
export const ACTION_LOG_SIZE = 30;
/** 消息摘要的字数 */
const TEXT_PREVIEW = 40;

const entries: IssueAction[] = [];

/** @brief 当前本地时间 HH:mm:ss。 */
function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** @brief 截取文字的前几十个字，换行压成空格。 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].length > TEXT_PREVIEW ? `${[...flat].slice(0, TEXT_PREVIEW).join('')}…` : flat;
}

/** @brief 记一条操作。 */
export function recordAction(text: string): void {
  entries.push({ time: clock(), text });
  if (entries.length > ACTION_LOG_SIZE) entries.splice(0, entries.length - ACTION_LOG_SIZE);
}

/** @brief 信任回答的说明（" (trusted, remembered)"，接在路径后面，所以带开头的空格）；没问时为空串。 */
function trustText(trust: { trusted: boolean; remember: boolean } | undefined): string {
  if (!trust) return '';
  return ` (${trust.trusted ? 'trusted' : 'not trusted'}${trust.remember ? ', remembered' : ''})`;
}

/** @brief 一条发给后台进程的命令的摘要；不需要记的（例如读取上下文用量）返回 null。 */
export function describeCommand(command: Command): string | null {
  switch (command.type) {
    case 'config.get':
    case 'session.state':
    case 'session.list':
    case 'session.read':
    case 'trust.check':
      return null;
    case 'connection.test':
      return `Test connection ${command.providerId}/${command.modelId}`
        + (command.keyRef ? ` with key ${command.keyRef}` : '');
    case 'connection.testCancel':
      return 'Cancel connection test';
    case 'session.create':
      return `New session in ${command.cwd}${trustText(command.trust)}`;
    case 'session.open':
      return `Open session ${command.sessionFile}${trustText(command.trust)}`;
    case 'session.rename':
      return `Rename: ${preview(command.name)}`;
    case 'session.close':
      return 'Close session (before archiving or deleting)';
    case 'ui.answer':
      return command.value === null ? 'Extension question: cancelled' : 'Extension question: answered';
    case 'session.prompt': {
      // 带 team: 'once'（/team <文字>）的发送记 Send (team)（平行 Agent 规格 §13.10）。
      if (command.team === 'once') return `Send (team): ${preview(command.text)}`;
      const how = command.behavior === 'steer' ? 'Steer' : command.behavior === 'followUp' ? 'Queue' : 'Send';
      return `${how}: ${preview(command.text)}`;
    }
    case 'session.clearQueue':
      return 'Withdraw queued messages';
    case 'session.abort':
      return 'Stop';
    case 'approval.answer': {
      const choice = { allow: 'Allow once', allowSession: 'Allow for this session', reject: 'Deny' }[command.decision];
      return `Permission request: ${choice}${command.reason?.trim() ? ` (reason: ${preview(command.reason)})` : ''}`;
    }
    case 'approval.setMode':
      return `Permission mode: ${command.mode === 'all' ? 'Allow all' : 'Ask each time'}`;
    case 'approval.forget':
      return `Forget “Allow for this session”: ${command.toolName}`;
    default:
      return describeM6Command(command);
  }
}

/** @brief M6 的命令（设置页、输入框下面一行、工具页）的摘要；只读的查询返回 null。 */
function describeM6Command(command: Command): string | null {
  switch (command.type) {
    case 'session.setThinking': return `Change effort for this session: ${command.level}`;
    case 'agents.save': return 'Save user-level AGENTS.md';
    case 'resource.toggle':
      return `${command.enabled ? 'Enable' : 'Disable'} ${KIND_ONE[command.kind]} ${command.path}`;
    case 'tools.setDefault': return `${command.enabled ? 'Enable' : 'Disable'} tool ${command.name}`;
    case 'package.add': return `Add plugin from folder ${command.path}`;
    case 'package.setAll': return `${command.enabled ? 'Enable' : 'Disable'} all in plugin ${command.source}`;
    case 'package.remove': return `Remove plugin ${command.source}`;
    case 'mcp.save': return `Save MCP server ${command.name}`;
    case 'mcp.setEnabled': return `${command.enabled ? 'Enable' : 'Disable'} MCP server ${command.name}`;
    case 'mcp.setDirect': return `Switch MCP server ${command.name} to direct calls`;
    case 'mcp.remove': return `Remove MCP server ${command.name}`;
    // Customize › Agents（docs/specs/customize-agents.md §5.6）：roles.get 是只读的查询，不记
    case 'roles.save': return `Save agent ${command.agent.name}`;
    case 'roles.delete': return `Delete agent ${command.name}`;
    case 'roles.get': return null;
    default: return describeModelCommand(command);
  }
}

/**
 * @brief models.discover 的摘要（拉取规格 §5.5）：已有提供商记它的 id；新提供商记 Base URL 的主机（非默认端口时带端口），
 *        不是 URL（或没有主机）时只记 Fetch models。不含 keySecret。
 */
function discoverText(target: DiscoverTarget): string {
  if (target.kind === 'provider') return `Fetch models ${target.providerId}`;
  const text = target.baseUrl.trim();
  const host = URL.canParse(text) ? new URL(text).host : '';
  return host ? `Fetch models ${host}` : 'Fetch models';
}

/** @brief 删除类命令的摘要：dryRun（确认框先算连带改动）不记。 */
function deleteText(what: string, dryRun: boolean): string | null {
  return dryRun ? null : `Delete ${what}`;
}

/**
 * @brief 模型层的写命令（§9.4、§9.5）与拉取模型（拉取规格 §5.5）的摘要：只记类型和 id，不含 secret、keySecret；
 *        只读的查询返回 null。
 */
function describeModelCommand(command: Command): string | null {
  switch (command.type) {
    case 'models.firstRun': return `Save first-run provider ${command.providerId ?? command.provider.name}`;
    case 'models.saveProvider':
      return command.id ? `Save provider ${command.id}` : `Add provider ${command.provider.name}`;
    case 'models.deleteProvider': return deleteText(`provider ${command.id}`, command.dryRun);
    // 拉取规格 §5.4：saveModel 只改已有的模型；加模型是 saveProvider、firstRun 与 addModels
    case 'models.saveModel': return `Save model ${command.providerId}/${command.model.id}`;
    case 'models.addModels': return `Add models ${command.providerId} · ${command.models.length}`;
    case 'models.discover': return discoverText(command.target);
    case 'models.discoverCancel': return 'Cancel fetch models';
    case 'models.deleteModel': return deleteText(`model ${command.providerId}/${command.modelId}`, command.dryRun);
    case 'models.moveModel': return `Move model ${command.providerId}/${command.modelId} ${command.delta}`;
    case 'models.addKey': return `Add key ${command.providerId}`;
    case 'models.removeKey': return `Remove key ${command.ref}`;
    case 'models.moveKey': return `Move key ${command.ref} ${command.delta}`;
    case 'models.saveGroup': return `${command.creating ? 'Create' : 'Save'} group ${command.id}`;
    case 'models.deleteGroup': return deleteText(`group ${command.id}`, command.dryRun);
    case 'models.setDefaults': return `Set defaults ${command.normalDefault ?? 'None'}`;
    case 'models.dismissMigration': return 'Dismiss migration notice';
    case 'models.reload': return 'Reload model settings';
    case 'models.verify': return `Verify ${command.refs.join(' ')}`;
    case 'session.setPick': return `Set model range ${command.pick}`;
    default: return describeTeamCommand(command);
  }
}

/** @brief 平行 Agent 与 TaskBoard 的命令（§13.10）的摘要；board.get 是只读查询，不记。 */
function describeTeamCommand(command: Command): string | null {
  switch (command.type) {
    case 'session.setTeam': return `Team ${command.mode}`;
    case 'session.recheckAgents': return 'Check agent files';
    case 'session.stopTeam': return 'Stop team';
    default: return describeMemoryCommand(command);
  }
}

/** @brief enhance.set 只带开关（记忆页的 Enhancement 开关），不带设置对话框的各项。 */
function onlySwitch(command: Extract<Command, { type: 'enhance.set' }>): boolean {
  return command.enabled !== undefined && command.pick === undefined && command.thinking === undefined
    && command.team === undefined && command.time === undefined;
}

/**
 * @brief 记忆与增强的写命令（docs/specs/memory.md §8）的摘要；读取类（memory.list、memory.get、memory.revisions、
 *        enhance.get）不记。
 */
function describeMemoryCommand(command: Command): string | null {
  switch (command.type) {
    case 'memory.save': return command.id === undefined ? 'Save memory entry' : 'Edit memory entry';
    case 'memory.delete': return 'Delete memory entry';
    case 'memory.move': return command.from === 'project' ? 'Move to user level' : 'Move to this project';
    case 'memory.rollback': return 'Roll back revision';
    case 'enhance.set':
      if (!onlySwitch(command)) return `Save enhancement settings ${command.cwd}`;
      return `${command.enabled ? 'Turn on' : 'Turn off'} enhancement ${command.cwd}`;
    case 'enhance.run': return `Run enhancement now ${command.cwd}`;
    default: return null;
  }
}

/** @brief 记一条发给后台进程的命令。 */
export function logCommand(command: Command): void {
  const text = describeCommand(command);
  if (text) recordAction(text);
}

/** @brief 最近的操作，从早到晚。 */
export function recentActions(): IssueAction[] {
  return [...entries];
}
