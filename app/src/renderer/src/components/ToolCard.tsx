// 工具卡：标题用人话，状态来自 pi 的工具事件和批准事件（等你批准、已拒绝、自动放行的原因）。
// 默认折叠，展开看参数、输出和 diff。

import { memo, useEffect, useState } from 'react';
import type { ToolCall, ToolStatus } from '../state/model';
import { Diff } from './Diff';
import { toolTitle } from './toolTitle';

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
        <div className="tool-diff" data-testid="tool-diff"><Diff patch={tool.patch} /></div>
      )}
      {output && <><div className="tool-section-label">输出</div><pre className="tool-pre">{output}</pre></>}
    </div>
  );
}

/** @brief 一张工具卡。 */
export const ToolCard = memo(function ToolCard({ tool, cwd }: { tool: ToolCall; cwd: string }) {
  const now = useNow(tool.status === 'running');
  const [open, setOpen] = useState(false);
  const title = toolTitle(tool, cwd);
  return (
    <details className={`tool-card status-${tool.status}`} data-testid="tool-card" data-status={tool.status}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="tool-title">
          <span className="tool-verb">{title.verb}</span>
          {title.target && <code className="tool-target">{title.target}</code>}
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
