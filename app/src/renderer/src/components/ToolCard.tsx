// 工具卡：标题用人话，状态来自 pi 的工具事件和批准事件（等你批准、已拒绝、自动放行的原因）。
// 默认折叠，展开看参数、输出和 diff。读取、修改、写入的标题里的路径是按钮，点它在右栏打开文件阅读器（M4）。

import { memo, useEffect, useState } from 'react';
import { seatRolesOf } from '../../../shared/team';
import type { ToolCall, ToolStatus } from '../state/model';
import { openFile } from '../state/quotes';
import { useApp } from '../state/store';
import { Diff } from './Diff';
import { toolTitle } from './toolTitle';

/** 标题里的路径能打开阅读器的工具（参数里有 path 的文件工具） */
const FILE_TOOLS = ['read', 'edit', 'write'];

/** 展开后输出最多显示的字数（取最后一段），临时默认值，见 docs/v0/defaults.md */
export const OUTPUT_MAX = 20_000;

/** 状态行里拒绝理由最多显示的字数，超过时截断加"…"，悬停看全文（tool-cards.md "已拒绝"） */
const REASON_MAX = 40;
/** 状态行里失败原文最多显示的字数 */
const FAILURE_MAX = 80;

const statusText: Record<ToolStatus, string> = {
  preparing: '准备中', queued: '等待执行', awaiting: '等你批准', running: '执行中', done: '完成', failed: '失败',
  rejected: '已拒绝', stopped: '已停止', interrupted: '已中断',
};

/** 自动放行的卡上的标签 */
const badgeText: Record<NonNullable<ToolCall['allowedBy']>, string> = { session: '本会话已允许', all: '全部允许' };

/** @brief 每秒刷新一次的当前时间；active 为假时不计时。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** @brief 秒数文字。 */
export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s` : `${Math.round(ms / 1000)}s`;
}

/** @brief 超过 max 个字时截断加"…"。 */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** @brief 失败时的简短说明：退出码，或错误原文的第一行。 */
function failureDetail(output: string): string {
  const code = /Command exited with code (\d+)/.exec(output);
  if (code) return `退出码 ${code[1]}`;
  return cut(output.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? '', FAILURE_MAX);
}

/** @brief 状态文字（含耗时、退出码、理由）；已拒绝时为"已拒绝"、"已拒绝 · 理由"（长理由截断）或"已拒绝 · 你按了停止"。 */
function statusLine(tool: ToolCall, now: number): string {
  const base = statusText[tool.status];
  if (tool.status === 'running' && tool.startedAt) return `${base} ${seconds(Math.max(0, now - tool.startedAt))}`;
  if (tool.status === 'done' && tool.durationMs !== null) return `${base} · ${seconds(tool.durationMs)}`;
  if (tool.status === 'failed') return [base, failureDetail(tool.output)].filter(Boolean).join(' · ');
  if (tool.status === 'rejected' && tool.reason) return `${base} · ${cut(tool.reason, REASON_MAX)}`;
  return base;
}

/** @brief 状态行的悬停文字：已拒绝且有理由时是完整的"已拒绝 · 理由"，其余没有。 */
function statusTitle(tool: ToolCall): string | undefined {
  return tool.status === 'rejected' && tool.reason ? `${statusText.rejected} · ${tool.reason}` : undefined;
}

/** @brief 展开后的内容：参数、写入的内容、diff、输出。 */
function ToolBody({ tool }: { tool: ToolCall }) {
  const content = tool.name === 'write' && typeof tool.args?.content === 'string' ? tool.args.content : null;
  const args = tool.args ?? tool.argsText;
  const output = tool.output.length > OUTPUT_MAX ? `…\n${tool.output.slice(-OUTPUT_MAX)}` : tool.output;
  return (
    <div className="tool-body">
      <div className="tool-section-label">参数</div>
      <pre className="tool-pre">{typeof args === 'string' ? args : JSON.stringify(args, null, 2)}</pre>
      {content !== null && (
        <><div className="tool-section-label">写入的内容</div><pre className="tool-pre">{content}</pre></>
      )}
      {tool.patch && (
        // diff 画在 shadow DOM 里，页面的选区读不到里面的字：不当作引用来源（docs/v0/screens/selection.md）。
        <div className="tool-diff" data-testid="tool-diff" data-no-quote><Diff patch={tool.patch} /></div>
      )}
      {output && <><div className="tool-section-label">输出</div><pre className="tool-pre">{output}</pre></>}
    </div>
  );
}

/** @brief 标题里的对象：文件工具的完整路径是打开阅读器的按钮（点它不展开工具卡），其余是等宽文字。 */
function TitleTarget({ tool, target, tabKey }: { tool: ToolCall; target: string; tabKey: string }) {
  const path = tool.args?.path;
  if (!FILE_TOOLS.includes(tool.name) || typeof path !== 'string' || !path) {
    return <code className="tool-target">{target}</code>;
  }
  return (
    <button className="tool-path" title={`在右栏打开 ${target}`} data-testid="tool-path"
      onClick={(event) => { event.preventDefault(); openFile(tabKey, path); }}>
      <code className="tool-target">{target}</code>
    </button>
  );
}

/** @brief 一张工具卡。 */
export const ToolCard = memo(function ToolCard({ tool, cwd, tabKey }: { tool: ToolCall; cwd: string; tabKey: string }) {
  const now = useNow(tool.status === 'running');
  const [open, setOpen] = useState(false);
  // agent_message 的标题按协作模式分 Message / Ask（平行 Agent 规格 §13.8）。
  const team = useApp((state) => state.tabs.find((item) => item.key === tabKey)?.team);
  const title = toolTitle(tool, cwd, team ? seatRolesOf(team) : []);
  return (
    <details className={`tool-card status-${tool.status}`} data-testid="tool-card" data-status={tool.status}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary data-no-quote>
        <span className="tool-title">
          <span className="tool-verb">{title.verb}</span>
          {title.target && <TitleTarget tool={tool} target={title.target} tabKey={tabKey} />}
          {title.suffix && <span className="tool-suffix">{title.suffix}</span>}
        </span>
        {tool.allowedBy && <span className="tool-badge" data-testid="tool-badge">{badgeText[tool.allowedBy]}</span>}
        <span className="tool-status" data-testid="tool-status" title={statusTitle(tool)}>
          {statusLine(tool, now)}
        </span>
      </summary>
      {open && <ToolBody tool={tool} />}
    </details>
  );
});
