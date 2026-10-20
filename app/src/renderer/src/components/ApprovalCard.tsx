// 批准卡：停靠在输入框上方，显示一个会话最前面那个等你选择的请求（docs/v0/screens/approval.md）。
// 出现时不抢焦点、没有默认按钮；Alt+1 / Alt+2 / Alt+3 由 App 的全局按键经 answerFrontApproval 转到这里；
// 焦点在卡上时 Esc 先关开着的浮层，没有浮层才等于拒绝（生成继续），卡片消失时焦点如果在卡上就回到输入框。
// 卡上的文字里不可见的控制字符都换成可见的标记，免得显示顺序与实际执行的不同。

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalDecision } from '../../../shared/protocol';
import { answerApproval } from '../state/actions';
import { newTool, type PendingApproval } from '../state/model';
import { closeTopOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { allowSessionHint, approvalLabel, isCommandTool } from './approvalLabel';
import { displayPath, toolTitle, type ToolTitle } from './toolTitle';

/** 双向文字控制符和零宽字符（approval.md "内容里有不可见的控制字符"） */
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** 每个会话面板上那张卡的"作出选择"，按会话 key */
const answerers = new Map<string, (decision: ApprovalDecision) => void>();

/** @brief 对会话最前面那张卡作出选择（拒绝时带上理由框里的文字）；没有卡时返回 false。 */
export function answerFrontApproval(tabKey: string, decision: ApprovalDecision): boolean {
  const answer = answerers.get(tabKey);
  answer?.(decision);
  return Boolean(answer);
}

/** @brief edit 的一处替换。 */
interface Replacement {
  /** 原文 */
  oldText: string;
  /** 新文 */
  newText: string;
}

/** @brief 卡上要显示的内容；其中的文字都已把不可见的控制字符标出。 */
interface CardView {
  /** 标题 */
  title: ToolTitle;
  /** 修改 / 写入的完整路径（参数原样）；其他工具为 null */
  path: string | null;
  /** 修改 / 写入的路径在会话文件夹之外 */
  outside: boolean;
  /** 每处替换（edit）；不是 edit 或参数里没有替换时为空 */
  edits: Replacement[];
  /** 将写入的完整内容（write）；没有时为 null */
  content: string | null;
  /** 完整命令行（命令工具）；没有时为 null */
  command: string | null;
  /** 命令的超时秒数；没有时为 null */
  timeout: number | null;
  /** 格式化后的参数（替换、内容、命令都没有时显示）；否则为 null */
  args: string | null;
  /** 有不可见的控制字符被标出 */
  hidden: boolean;
}

/** @brief 把不可见的控制字符换成可见的"⟨U+202E⟩"。 */
function markHidden(text: string): string {
  return text.replace(HIDDEN_CHARS, (char) => `⟨U+${char.charCodeAt(0).toString(16).toUpperCase()}⟩`);
}

/**
 * @brief 路径是否在会话文件夹之外：含 ".." 一段，或是不在会话文件夹之下的绝对路径。
 *        按 pi 解析路径的写法认绝对路径：盘符、/ 或 \ 开头、~ 开头、file: 网址；开头的 @ 会被 pi 去掉。
 */
function outsideFolder(path: string, cwd: string): boolean {
  const normalized = path.replace(/^@/, '').replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) return true;
  if (!/^([a-z]:|\/|~(\/|$)|file:)/i.test(normalized)) return false;
  return displayPath(normalized, cwd) === normalized;
}

/** @brief edit 参数 edits 里的每处替换。 */
function replacements(args: Record<string, unknown>): Replacement[] {
  const list: unknown[] = Array.isArray(args.edits) ? args.edits : [];
  return list.filter((item): item is Replacement => typeof (item as Replacement)?.oldText === 'string'
    && typeof (item as Replacement).newText === 'string');
}

/** @brief 卡片标题：命令是"运行命令"，其余与工具卡标题相同（修改 / 写入 路径、服务 · 工具、原名）。 */
function cardTitle(approval: PendingApproval, cwd: string): ToolTitle {
  if (isCommandTool(approval.toolName)) return { verb: '运行命令', target: '', suffix: '' };
  return toolTitle({ ...newTool(approval.toolCallId, approval.toolName), args: approval.args }, cwd);
}

/** @brief 整理卡上要显示的内容（标题、路径、替换、内容、命令或参数），并标出其中不可见的控制字符。 */
function cardView(approval: PendingApproval, cwd: string): CardView {
  const { toolName, args } = approval;
  let hidden = false;
  const mark = (text: string): string => {
    const shown = markHidden(text);
    hidden ||= shown !== text;
    return shown;
  };
  const raw = cardTitle(approval, cwd);
  const title = { verb: mark(raw.verb), target: mark(raw.target), suffix: mark(raw.suffix) };
  const rawPath = (toolName === 'edit' || toolName === 'write') && typeof args.path === 'string' ? args.path : null;
  const path = rawPath === null ? null : mark(rawPath);
  const edits = toolName === 'edit'
    ? replacements(args).map((edit) => ({ oldText: mark(edit.oldText), newText: mark(edit.newText) })) : [];
  const content = toolName === 'write' && typeof args.content === 'string' ? mark(args.content) : null;
  const command = isCommandTool(toolName) && typeof args.command === 'string' ? mark(args.command) : null;
  const timeout = command !== null && typeof args.timeout === 'number' ? args.timeout : null;
  const shownArgs = edits.length === 0 && content === null && command === null
    ? mark(JSON.stringify(args, null, 2)) : null;
  return { title, path, outside: rawPath !== null && outsideFolder(rawPath, cwd), edits, content, command, timeout,
    args: shownArgs, hidden };
}

/** @brief 警示行：路径在项目文件夹之外；内容里有不可见的控制字符。都没有时不显示。 */
function ApprovalWarnings({ view }: { view: CardView }) {
  if (!view.outside && !view.hidden) return null;
  return (
    <div className="approval-warnings">
      {view.outside && <p className="approval-warn" data-testid="approval-outside">这个路径在项目文件夹之外</p>}
      {view.hidden && <p className="approval-warn" data-testid="approval-hidden">内容里有不可见的控制字符，已标出</p>}
    </div>
  );
}

/** @brief 卡片内容：完整路径；每处替换的原文和新文、将写入的内容、完整命令行，或格式化后的参数。 */
function ApprovalBody({ view }: { view: CardView }) {
  const { edits } = view;
  return (
    <div className="approval-body">
      {view.path !== null && (
        <div className="approval-path" data-testid="approval-path">
          <span className="approval-meta">路径</span><code>{view.path}</code>
        </div>
      )}
      {edits.map((edit, index) => (
        <div key={index} className="approval-edit" data-testid="approval-edit">
          {edits.length > 1 && <div className="approval-meta">第 {index + 1} 处</div>}
          <pre className="approval-pre approval-old">{edit.oldText}</pre>
          <pre className="approval-pre approval-new">{edit.newText}</pre>
        </div>
      ))}
      {view.content !== null && <pre className="approval-pre" data-testid="approval-content">{view.content}</pre>}
      {view.command !== null && <pre className="approval-pre" data-testid="approval-command">{view.command}</pre>}
      {view.timeout !== null && <div className="approval-meta">超时 {view.timeout} 秒</div>}
      {view.args !== null && <pre className="approval-pre" data-testid="approval-args">{view.args}</pre>}
    </div>
  );
}

/** @brief 这张卡的"作出选择"：按钮、理由框和 Alt+1 / Alt+2 / Alt+3 共用；拒绝时带上理由框里的文字。 */
function useAnswer(tabKey: string, requestId: string, reason: string): (decision: ApprovalDecision) => void {
  const latest = useRef(reason);
  latest.current = reason;
  const answer = useCallback((decision: ApprovalDecision) => {
    void answerApproval(tabKey, requestId, decision, latest.current);
  }, [tabKey, requestId]);
  useEffect(() => {
    answerers.set(tabKey, answer);
    return () => {
      if (answerers.get(tabKey) === answer) answerers.delete(tabKey);
    };
  }, [tabKey, answer]);
  return answer;
}

/**
 * @brief 卡片消失（处理完，或换成下一张）时焦点如果在卡上，回到这个会话的输入框。
 *        卸载时的 layout effect 清理在卡片的 DOM 移除之前执行，此时还能判断焦点在不在卡上。
 */
export function useFocusBack(ref: React.RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const card = ref.current;
    return () => {
      if (!card?.contains(document.activeElement)) return;
      const pane = card.closest('[data-testid="chat-pane"]');
      pane?.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea')?.focus();
    };
  }, [ref]);
}

/** @brief 按钮上的快捷键提示（读屏用 aria-keyshortcuts）。 */
function KeyHint({ keys }: { keys: string }) {
  return <span className="approval-key" aria-hidden="true">{keys}</span>;
}

/** @brief 三个选项和理由框；"本会话不再询问"下方是小字说明。在理由框里按 Enter 等于拒绝。 */
function ApprovalActions({ toolName, reason, onReason, answer }: {
  toolName: string; reason: string; onReason: (text: string) => void; answer: (decision: ApprovalDecision) => void;
}) {
  const hintId = useId();
  function onReasonKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    answer('reject');
  }
  return (
    <>
      <div className="approval-actions">
        <button className="button" data-testid="approval-allow" aria-keyshortcuts="Alt+1"
          onClick={() => answer('allow')}>允许一次<KeyHint keys="Alt+1" /></button>
        <button className="button approval-session" data-testid="approval-allow-session" aria-keyshortcuts="Alt+2"
          aria-describedby={hintId} onClick={() => answer('allowSession')}>
          本会话不再询问"{approvalLabel(toolName)}"<KeyHint keys="Alt+2" />
        </button>
        <input className="approval-reason" data-testid="approval-reason" aria-label="拒绝理由"
          placeholder="拒绝理由（可选，会告诉模型）" value={reason} onChange={(event) => onReason(event.target.value)}
          onKeyDown={onReasonKeyDown} />
        <button className="button danger" data-testid="approval-reject" aria-keyshortcuts="Alt+3"
          onClick={() => answer('reject')}>拒绝<KeyHint keys="Alt+3" /></button>
      </div>
      <p id={hintId} className="approval-hint">{allowSessionHint(toolName)}</p>
    </>
  );
}

/** @brief 一张批准卡。more 是排在后面的张数。 */
function Card({ tabKey, cwd, approval, more }: {
  tabKey: string; cwd: string; approval: PendingApproval; more: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const answer = useAnswer(tabKey, approval.requestId, reason);
  useFocusBack(ref);
  const view = cardView(approval, cwd);
  const { title } = view;
  const titleText = [title.verb, title.target].filter(Boolean).join(' ') + title.suffix;

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    // 焦点在卡上时 Esc：有开着的浮层（"排队发送"的下拉、权限菜单、报告框……）先关它，卡不变；
    // 没有浮层才只拒绝这张卡、生成继续。两种情况全局 Esc 都看到 defaultPrevented 就跳过。
    event.preventDefault();
    event.stopPropagation();
    if (closeTopOverlay()) return;
    answer('reject');
  }

  return (
    <div ref={ref} className="approval-card" role="group" aria-label={`等你批准：${titleText}`}
      data-testid="approval-card" data-tool={approval.toolName} data-request={approval.requestId} onKeyDown={onKeyDown}>
      <div className="approval-head">
        <span className="approval-title" data-testid="approval-title">
          {title.verb}{title.target && <>{' '}<code>{title.target}</code></>}{title.suffix}
        </span>
        {more > 0 && <span className="approval-more" data-testid="approval-more">还有 {more} 张</span>}
      </div>
      <ApprovalWarnings view={view} />
      <ApprovalBody view={view} />
      <ApprovalActions toolName={approval.toolName} reason={reason} onReason={setReason} answer={answer} />
    </div>
  );
}

/** @brief 一个会话的批准卡：只显示最前面的那张，处理完下一张接着出现。 */
export function ApprovalCard({ tab }: { tab: Tab }) {
  const { approvals } = tab.transcript;
  const front = approvals[0];
  if (!front) return null;
  return <Card key={front.requestId} tabKey={tab.key} cwd={tab.cwd} approval={front} more={approvals.length - 1} />;
}
