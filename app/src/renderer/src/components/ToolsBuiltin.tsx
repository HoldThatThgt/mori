// 工具页的"Built-in tools"一节（docs/v0/screens/tools.md）：跟随的会话注册的全部工具（pi getAllTools，不含 hidden），
// 启用的才给模型。只读：v0 不在这里启停工具。

import type { ToolEntry } from '../../../shared/protocol';

/** @brief 工具的来源：Built-in / Extension <路径> / MCP · <服务> / Plugin <包>。 */
function toolSource(tool: ToolEntry): string {
  switch (tool.source) {
    case 'builtin':
      return 'Built-in';
    case 'extension':
      return `Extension ${tool.sourceLabel}`;
    case 'mcp':
      return `MCP · ${tool.sourceLabel}`;
    case 'package':
      return `Plugin ${tool.sourceLabel}`;
    default:
      return tool.sourceLabel;
  }
}

/** @brief 一个工具：名字、来源、状态、说明的第一行；展开看完整说明。 */
function ToolRow({ tool }: { tool: ToolEntry }) {
  const firstLine = tool.description.split(/\r?\n/)[0] ?? '';
  const source = toolSource(tool);
  return (
    <li className={`tools-row${tool.active ? '' : ' off'}`} data-testid="tool-row" data-tool={tool.name}
      data-active={tool.active ? 'true' : 'false'}>
      <details className="tools-tool">
        <summary className="tools-row-main">
          <span className="tools-row-name">{tool.name}</span>
          {source && <span className="tools-tag" title={source}>{source}</span>}
          <span className={`tools-state${tool.active ? ' on' : ''}`}>{tool.active ? 'Enabled' : 'Not enabled'}</span>
          <span className="tools-row-desc">{firstLine}</span>
        </summary>
        <pre className="tools-body">{tool.description}</pre>
      </details>
    </li>
  );
}

/** @brief "Built-in tools"一节。 */
export function BuiltinSection({ tools }: { tools: ToolEntry[] }) {
  return (
    <>
      <h2>Built-in tools</h2>
      <p className="tools-lead">All tools in this session. Only enabled tools are available to the model.</p>
      <ul className="tools-list">{tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}</ul>
    </>
  );
}
