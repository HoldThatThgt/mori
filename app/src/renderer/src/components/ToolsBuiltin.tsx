// 工具页的"Built-in tools"一节（docs/v0/screens/tools.md"内置工具"）：跟随的会话注册的全部工具（pi getAllTools，不含 hidden），
// 启用的才给模型。pi 的 8 个内置工具各有开关，决定新会话默认给不给模型（写用户级 settings.json 的 defaultTools，
// 2026-10-26 负责人走查 M12）；别的工具没有开关，下面一行写由谁开关。
// 2026-10-29：grep、find 下面不再写要 rg.exe / fd.exe（Mori 随程序带它们，U76）；开关开着、这个会话里没有的内置工具，
// 状态写灰色的 "Available in new sessions"（U77）；开着新会话里也没有它时（没有 bash 时的 bash，heldOff）仍写 "Not enabled"。

import type { DefaultToolState, ToolEntry } from '../../../shared/protocol';
import { FINISH_TOOL } from '../../../shared/finishCheck';
import { SUBAGENT_TOOL } from '../../../shared/subagent';
import { isTeamTool } from '../../../shared/team';
import { ASK_TOOL } from '../../../shared/workspace';
import { defaultToolCommand, useChange } from '../state/tools';
import { ResourceNotes, ToolSwitch, useSwitch } from './ToolsCommon';
import { MEMORY_TOOL } from './toolTitle';

/** 后台进程给 Mori 自己的工具（TaskBoard、memory、subagent、finish、ask_user_question）写的来源 */
const MORI_SOURCE = 'Mori';
/** 没有开关的行下面的原因（docs/v0/screens/tools.md"内置工具"） */
const NOTES = {
  task: 'Mori turns this on and off with Task mode.',
  memory: 'Mori turns this on for the main agent.',
  subagent: 'Mori turns this on when Task mode is off.',
  // finish、ask_user_question 一直给跟你对话的 Agent（docs/v1/walkthrough-1026-checks.md 的 U55）
  talk: 'Mori turns this on for the agent you talk to.',
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

/**
 * @brief Mori 自己的工具的原因：TaskBoard 的工具随 Task mode，memory 给主 Agent，subagent 在 Task mode 关闭时
 *        （docs/specs/subagent.md §2），finish 与 ask_user_question 一直给跟你对话的 Agent（收尾检查规格 §4.3、
 *        file-system-permissions.md §10.1）；别的为 null。
 */
function moriNote(tool: ToolEntry): string | null {
  if (tool.sourceLabel !== MORI_SOURCE) return null;
  if (tool.name === SUBAGENT_TOOL) return NOTES.subagent;
  if (tool.name === FINISH_TOOL || tool.name === ASK_TOOL) return NOTES.talk;
  if (isTeamTool(tool.name)) return NOTES.task;
  return tool.name === MEMORY_TOOL ? NOTES.memory : null;
}

/** @brief 一行下面的说明：别的行写由谁开关；pi 的内置工具没有（开关就在这一行）。没有时为 null。 */
function toolNote(tool: ToolEntry): string | null {
  switch (tool.source) {
    case 'builtin':
      return null;
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

/** @brief 一行的状态：文字与加在 tools-state 后面的类名（on 是绿色，next 是灰色）。 */
interface RowState {
  /** 显示的文字 */
  text: string;
  /** 类名（带前导空格；没有时为空串） */
  className: string;
}

/**
 * @brief 一行的状态（tools.md"pi 内置工具的开关"）：这个会话里有它时 Enabled（开关关着也是）；没有它、按显示出来的开关
 *        新会话里有它时 Available in new sessions（U77）；否则 Not enabled。
 * @param inNewSessions 显示出来的开关开着（按下后、写完之前已是新的样子），且开着时新会话里真有它（不是 heldOff）
 */
function stateOf(active: boolean, inNewSessions: boolean): RowState {
  if (active) return { text: 'Enabled', className: ' on' };
  return inNewSessions ? { text: 'Available in new sessions', className: ' next' }
    : { text: 'Not enabled', className: '' };
}

/**
 * @brief 一行的框架：名字、来源、这个会话里的状态、说明的第一行（展开看完整说明），后面接开关和说明（children）。
 * @param inNewSessions 按显示出来的开关，新会话里有它；没有开关的行为 false
 */
function RowFrame({ tool, inNewSessions, children }: { tool: ToolEntry; inNewSessions: boolean;
  children: React.ReactNode }) {
  const firstLine = tool.description.split(/\r?\n/)[0] ?? '';
  const source = toolSource(tool);
  const state = stateOf(tool.active, inNewSessions);
  return (
    <li className={`tools-row tools-tool-row${tool.active ? '' : ' off'}`} data-testid="tool-row" data-tool={tool.name}
      data-active={tool.active ? 'true' : 'false'}>
      <details className="tools-tool">
        <summary className="tools-row-main">
          <span className="tools-row-name">{tool.name}</span>
          {source && <span className="tools-tag" title={source}>{source}</span>}
          <span className={`tools-state${state.className}`}>{state.text}</span>
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
 *        这一行的状态跟着显示出来的开关（U77；开着新会话里也没有它时不写 Available in new sessions，heldOff）。
 *        受信任项目的设置改了它时开关不可用，下面写原因。
 */
function PiToolRow({ tool, state }: { tool: ToolEntry; state: DefaultToolState }) {
  const change = useChange();
  const power = useSwitch(change, state.enabled, (enabled) => defaultToolCommand(tool.name, enabled));
  return (
    <RowFrame tool={tool} inNewSessions={power.checked && !state.heldOff}>
      <ToolSwitch checked={power.checked} label={`Enable tool ${tool.name}`} disabled={change.busy || !!state.readOnly}
        title={state.readOnly ?? undefined} onChange={power.toggle} />
      <ResourceNotes readOnly={state.readOnly} error={change.error} />
    </RowFrame>
  );
}

/** @brief 一个工具：pi 的内置工具有开关；别的工具没有，下面一行原因。 */
function ToolRow({ tool }: { tool: ToolEntry }) {
  if (tool.byDefault) return <PiToolRow tool={tool} state={tool.byDefault} />;
  const note = toolNote(tool);
  return <RowFrame tool={tool} inNewSessions={false}>{note && <p className="tools-row-note">{note}</p>}</RowFrame>;
}

/** @brief "Built-in tools"一节。 */
export function BuiltinSection({ tools }: { tools: ToolEntry[] }) {
  return (
    <>
      <h2>Built-in tools</h2>
      <p className="tools-lead">
        All tools in this session. Only enabled tools are available to the model. Switches apply to new sessions.
      </p>
      <ul className="tools-list">
        {tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
      </ul>
    </>
  );
}
