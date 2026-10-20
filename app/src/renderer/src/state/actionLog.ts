// 最近的操作记录：只在本次运行的内存里，F8 报告界面问题时附上（方案 5.15，见 docs/v0/screens/f8.md）。
// 只记操作的类型和不含机密的摘要：发送的消息只取前几十个字，连接表单只记"保存连接"，从不记 key。

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
    case 'connection.save':
      return '保存连接';
    case 'connection.test':
      return '测试连接';
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
