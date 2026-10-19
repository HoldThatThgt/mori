// 批准卡和权限菜单里的工具名：按工具名说人话（运行命令 / 修改文件 / 写入文件 / 服务 · 工具 / 原名）。
// 对照表见 docs/v0/screens/approval.md 的"选项"。

/** @brief 是否是命令工具（bash / powershell）。 */
export function isCommandTool(toolName: string): boolean {
  return toolName === 'bash' || toolName === 'powershell';
}

/** @brief "本会话不再询问"和"本会话已允许"列表里的工具名。 */
export function approvalLabel(toolName: string): string {
  if (isCommandTool(toolName)) return '运行命令';
  if (toolName === 'edit') return '修改文件';
  if (toolName === 'write') return '写入文件';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : toolName;
}

/** @brief "本会话不再询问"下方的小字。 */
export function allowSessionHint(toolName: string): string {
  return isCommandTool(toolName) ? '之后本会话的所有命令都会直接执行'
    : `之后本会话的所有"${approvalLabel(toolName)}"都会直接执行`;
}
