// 最近的操作记录：只在本次运行的内存里，F8 报告界面问题时附上（方案 5.15，见 docs/v0/screens/f8.md）。
// 只记操作的类型和不含机密的摘要：发送的消息只取前几十个字，模型层的命令（models.*）只记类型和 id，
// 从不记 key 的明文（secret、keySecret，docs/specs/model-providers.md §9.4）。

import type { Command } from '../../../shared/protocol';
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

/** @brief 信任回答的说明；没问时为空串。 */
function trustText(trust: { trusted: boolean; remember: boolean } | undefined): string {
  if (!trust) return '';
  return `（${trust.trusted ? '信任' : '不信任'}${trust.remember ? '，记住' : ''}）`;
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
      return '取消测试连接';
    case 'session.create':
      return `新建会话 ${command.cwd}${trustText(command.trust)}`;
    case 'session.open':
      return `打开会话 ${command.sessionFile}${trustText(command.trust)}`;
    case 'session.rename':
      return `改名：${preview(command.name)}`;
    case 'session.close':
      return '关闭会话（归档或删除前）';
    case 'ui.answer':
      return command.value === null ? '扩展询问：取消' : '扩展询问：作答';
    case 'session.prompt': {
      // 带 team: 'once'（/team <文字>）的发送记 Send (team)（平行 Agent 规格 §13.10）。
      if (command.team === 'once') return `Send (team): ${preview(command.text)}`;
      const how = command.behavior === 'steer' ? '插话' : command.behavior === 'followUp' ? '排队' : '发送';
      return `${how}：${preview(command.text)}`;
    }
    case 'session.clearQueue':
      return '撤回排队的消息';
    case 'session.abort':
      return '停止';
    case 'approval.answer': {
      const choice = { allow: '允许一次', allowSession: '本会话不再询问', reject: '拒绝' }[command.decision];
      return `批准卡：${choice}${command.reason?.trim() ? `（理由：${preview(command.reason)}）` : ''}`;
    }
    case 'approval.setMode':
      return `权限切到${command.mode === 'all' ? '全部允许' : '每次询问'}`;
    case 'approval.forget':
      return `清除本会话已允许：${command.toolName}`;
    default:
      return describeM6Command(command);
  }
}

/** @brief M6 的命令（设置页、顶栏、工具页）的摘要；只读的查询返回 null。 */
function describeM6Command(command: Command): string | null {
  switch (command.type) {
    case 'session.setThinking': return `这个会话换思考强度 ${command.level}`;
    case 'agents.save': return '保存用户级 AGENTS.md';
    case 'resource.toggle': return `${command.enabled ? '启用' : '停用'} ${command.kind} ${command.path}`;
    case 'package.add': return `添加本地包 ${command.path}`;
    case 'package.setAll': return `${command.enabled ? '启用' : '停用'}整个包 ${command.source}`;
    case 'package.remove': return `移除包 ${command.source}`;
    case 'mcp.save': return `保存 MCP 服务 ${command.name}`;
    case 'mcp.setEnabled': return `${command.enabled ? '启用' : '停用'} MCP 服务 ${command.name}`;
    case 'mcp.setDirect': return `MCP 服务改为直接调用 ${command.name}`;
    case 'mcp.remove': return `移除 MCP 服务 ${command.name}`;
    default: return describeModelCommand(command);
  }
}

/** @brief 删除类命令的摘要：dryRun（确认框先算连带改动）不记。 */
function deleteText(what: string, dryRun: boolean): string | null {
  return dryRun ? null : `Delete ${what}`;
}

/** @brief 模型层的写命令（§9.4、§9.5）的摘要：只记类型和 id，不含 secret、keySecret；只读的查询返回 null。 */
function describeModelCommand(command: Command): string | null {
  switch (command.type) {
    case 'models.firstRun': return `Save first-run provider ${command.providerId ?? command.provider.name}`;
    case 'models.saveProvider':
      return command.id ? `Save provider ${command.id}` : `Add provider ${command.provider.name}`;
    case 'models.deleteProvider': return deleteText(`provider ${command.id}`, command.dryRun);
    case 'models.saveModel':
      return `${command.adding ? 'Add' : 'Save'} model ${command.providerId}/${command.model.id}`;
    case 'models.deleteModel': return deleteText(`model ${command.providerId}/${command.modelId}`, command.dryRun);
    case 'models.moveModel': return `Move model ${command.providerId}/${command.modelId} ${command.delta}`;
    case 'models.addKey': return `Add key ${command.providerId}`;
    case 'models.removeKey': return `Remove key ${command.ref}`;
    case 'models.moveKey': return `Move key ${command.ref} ${command.delta}`;
    case 'models.saveGroup': return `${command.creating ? 'Create' : 'Save'} group ${command.id}`;
    case 'models.deleteGroup': return deleteText(`group ${command.id}`, command.dryRun);
    case 'models.setDefaults':
      return `Set defaults ${command.normalDefault ?? 'None'} · ${command.allowedZones.join(' ')}`;
    case 'models.setProjectZones': return `Set project zones ${command.path} · ${command.zones.join(' ')}`;
    case 'models.confirmZone': return `Confirm zone ${command.providerId} · ${command.zone}`;
    case 'models.dismissMigration': return 'Dismiss migration notice';
    case 'models.reload': return 'Reload model settings';
    case 'models.verify': return `Verify ${command.refs.join(' ')} (${command.tests})`;
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
