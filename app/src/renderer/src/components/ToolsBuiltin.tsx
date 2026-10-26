// 工具页的"Built-in tools"一节（docs/v0/screens/tools.md"内置工具"）：跟随的会话注册的全部工具（pi getAllTools，不含 hidden），
// 启用的才给模型。pi 的 8 个内置工具各有开关，决定新会话默认给不给模型（写用户级 settings.json 的 defaultTools，
// 2026-10-26 负责人走查 M12）；别的工具没有开关，下面一行写由谁开关。

import type { DefaultToolState, ToolEntry } from '../../../shared/protocol';
import { isTeamTool } from '../../../shared/team';
import { useApp } from '../state/store';
import { defaultToolCommand, useChange } from '../state/tools';
import { ResourceNotes, ToolSwitch, useSwitch } from './ToolsCommon';
import { MEMORY_TOOL } from './toolTitle';

/** grep、find 要的程序：pi 先找 <agentDir>\bin 再看 PATH，Mori 让 pi 离线运行，不下载（docs/v0/defaults.md） */
const TOOL_NEEDS: Readonly<Record<string, string>> = { grep: 'rg.exe', find: 'fd.exe' };
/** 后台进程给 Mori 自己的工具（TaskBoard、memory）写的来源 */
const MORI_SOURCE = 'Mori';
/** 没有开关的行下面的原因（docs/v0/screens/tools.md"内置工具"） */
const NOTES = {
  task: 'Mori turns this on and off with Task mode.',
  memory: 'Mori turns this on for the main agent.',
  mcp: 'Turn its server on or off in MCP.',
  plugin: 'Turn it on or off in Plugins.',
  extension: 'Set by this extension. To change it, edit the extension file.',
};

/** @brief 工具的来源：Built-in / Extension <路径> / MCP · <服务> / Plugin <包>；Mori 的工具写 Mori。 */
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

/** @brief Mori 自己的工具的原因：TaskBoard 的工具随 Task mode，memory 给主 Agent；别的为 null。 */
function moriNote(tool: ToolEntry): string | null {
  if (tool.sourceLabel !== MORI_SOURCE) return null;
  if (isTeamTool(tool.name)) return NOTES.task;
  return tool.name === MEMORY_TOOL ? NOTES.memory : null;
}

/**
 * @brief 一行下面的说明：pi 的内置工具只有 grep、find 写要的程序（不检查在不在）；别的行写由谁开关。没有时为 null。
 * @param agentDir pi 的配置目录（rg.exe、fd.exe 可以放在它的 bin 里）
 */
function toolNote(tool: ToolEntry, agentDir: string): string | null {
  switch (tool.source) {
    case 'builtin': {
      const program = TOOL_NEEDS[tool.name];
      return program ? `Needs ${program} in ${agentDir}\\bin or on PATH. Mori doesn’t download it.` : null;
    }
    case 'mcp':
      return NOTES.mcp;
    case 'package':
      return NOTES.plugin;
    case 'extension':
      return NOTES.extension;
    default:
      return moriNote(tool);
  }
}

/** @brief 一行的框架：名字、来源、这个会话里的状态、说明的第一行（展开看完整说明），后面接开关和说明（children）。 */
function RowFrame({ tool, children }: { tool: ToolEntry; children: React.ReactNode }) {
  const firstLine = tool.description.split(/\r?\n/)[0] ?? '';
  const source = toolSource(tool);
  return (
    <li className={`tools-row tools-tool-row${tool.active ? '' : ' off'}`} data-testid="tool-row" data-tool={tool.name}
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
      {children}
    </li>
  );
}

/**
 * @brief pi 的一个内置工具：开关是新会话的默认（tools.setDefault，之后重新读取；失败时回到原来的样子，下面写原文）；
 *        受信任项目的设置改了它时开关不可用，下面写原因。
 */
function PiToolRow({ tool, state, agentDir }: { tool: ToolEntry; state: DefaultToolState; agentDir: string }) {
  const change = useChange();
  const power = useSwitch(change, state.enabled, (enabled) => defaultToolCommand(tool.name, enabled));
  const note = toolNote(tool, agentDir);
  return (
    <RowFrame tool={tool}>
      <ToolSwitch checked={power.checked} label={`Enable tool ${tool.name}`} disabled={change.busy || !!state.readOnly}
        title={state.readOnly ?? undefined} onChange={power.toggle} />
      {note && <p className="tools-row-note">{note}</p>}
      <ResourceNotes readOnly={state.readOnly} error={change.error} />
    </RowFrame>
  );
}

/** @brief 一个工具：pi 的内置工具有开关；别的工具没有，下面一行原因。 */
function ToolRow({ tool, agentDir }: { tool: ToolEntry; agentDir: string }) {
  if (tool.byDefault) return <PiToolRow tool={tool} state={tool.byDefault} agentDir={agentDir} />;
  const note = toolNote(tool, agentDir);
  return <RowFrame tool={tool}>{note && <p className="tools-row-note">{note}</p>}</RowFrame>;
}

/** @brief "Built-in tools"一节。 */
export function BuiltinSection({ tools }: { tools: ToolEntry[] }) {
  const agentDir = useApp((state) => state.config?.agentDir ?? '');
  return (
    <>
      <h2>Built-in tools</h2>
      <p className="tools-lead">
        All tools in this session. Only enabled tools are available to the model. Switches apply to new sessions.
      </p>
      <ul className="tools-list">
        {tools.map((tool) => <ToolRow key={tool.name} tool={tool} agentDir={agentDir} />)}
      </ul>
    </>
  );
}
