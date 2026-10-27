// 批准卡和权限菜单里的工具名：按工具名说人话（Run commands / Edit files / Write files / 服务 · 工具 / 原名）。
// 对照表见 docs/v0/screens/approval.md 的"选项"。批准卡的原因行与第二个选项按后台进程判定的 scope、targets、allowDirs 定
// （docs/specs/file-system-permissions.md §6.13，状态表 docs/v1/screens/fs-permissions.md），界面不自己猜。

import type { ApprovalRequestInfo, ApprovalTarget } from '../../../shared/protocol';

/** @brief 是否是命令工具（bash / powershell）。 */
export function isCommandTool(toolName: string): boolean {
  return toolName === 'bash' || toolName === 'powershell';
}

/** @brief "Allow “…” for this session"按钮和"Allowed for this session:"列表里的工具名。 */
export function approvalLabel(toolName: string): string {
  if (isCommandTool(toolName)) return 'Run commands';
  if (toolName === 'edit') return 'Edit files';
  if (toolName === 'write') return 'Write files';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : toolName;
}

/**
 * @brief "Allow “…” for this session"按钮下方的小字（§6.13）：命令列出放行之后仍出卡的全部情况；edit、write 说明
 *        写到外面与受保护路径仍会问；其他工具同 v0。
 */
export function allowSessionHint(toolName: string): string {
  const label = approvalLabel(toolName);
  if (isCommandTool(toolName)) {
    return 'You won’t be asked again for commands in this session, unless Mori can’t analyze a command or detects '
      + 'that it writes outside the working directory or to a protected path, or changes to a folder outside it.';
  }
  if (toolName === 'edit' || toolName === 'write') {
    return `You won’t be asked again for “${label}” in this session, except outside the working directory or in `
      + 'protected paths.';
  }
  return `You won’t be asked again for “${label}” in this session.`;
}

/** @brief 批准卡的第二个选项（Alt+2）。 */
export interface SecondOption {
  /** tool 按工具名放行；dir 按目录放行（按钮的 data-kind） */
  kind: 'tool' | 'dir';
  /** 发给 approval.answer 的选择 */
  decision: 'allowSession' | 'allowDir';
  /** 按钮上的字 */
  label: string;
  /** 按钮下方的小字 */
  hint: string;
}

/**
 * @brief 第二个选项按请求定（§6.13 的表）：scope 为 inside 时按工具名放行；allowDirs 有一个或几个时按目录放行；
 *        其余（受保护路径；有看不出的目标、换了目录、分析不了的命令；目录是盘符根或共享根）没有第二个选项。
 * @return 没有第二个选项时为 null（卡上不放这个按钮，Alt+2 不起作用）
 */
export function secondOption(request: Pick<ApprovalRequestInfo, 'toolName' | 'scope' | 'allowDirs'>):
  SecondOption | null {
  const { toolName, scope, allowDirs } = request;
  if (scope === 'inside') {
    return { kind: 'tool', decision: 'allowSession', label: `Allow “${approvalLabel(toolName)}” for this session`,
      hint: allowSessionHint(toolName) };
  }
  if (allowDirs.length === 1) {
    return { kind: 'dir', decision: 'allowDir', label: `Allow writes to ${allowDirs[0]} for this session`,
      hint: 'You won’t be asked again in this session for writes directly in this folder (not its subfolders).' };
  }
  if (allowDirs.length > 1) {
    return { kind: 'dir', decision: 'allowDir', label: 'Allow writes to these folders for this session',
      hint: `You won’t be asked again in this session for writes directly in: ${allowDirs.join(', ')}.` };
  }
  return null;
}

/**
 * @brief 原因行的文字（§6.13）：path 为 null 时显示 text（看不出的目标、分析不了的原因、看不出目录的换目录）。
 */
export function targetText(target: ApprovalTarget): string {
  const where = target.path ?? target.text;
  switch (target.reason) {
    case 'outside':
      return `Writes outside the working directory: ${where}`;
    case 'protected':
      return `Protected path: ${where}`;
    case 'unresolved':
      return `Writes to a path Mori can’t resolve: ${target.text}`;
    case 'leaves':
      return `Runs outside the working directory: ${where}`;
    case 'unanalyzed':
      return `Couldn’t analyze this command: ${target.text}`;
  }
}
