// 批准卡和权限菜单里的工具名：按工具名说人话（Run commands / Edit files / Write files / 服务 · 工具 / 原名）。
// 对照表见 docs/v0/screens/approval.md 的"选项"。

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

/** @brief "Allow “…” for this session"按钮下方的小字。 */
export function allowSessionHint(toolName: string): string {
  return isCommandTool(toolName) ? 'You won’t be asked again for any command in this session.'
    : `You won’t be asked again for “${approvalLabel(toolName)}” in this session.`;
}
