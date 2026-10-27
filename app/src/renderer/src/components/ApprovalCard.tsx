// 批准卡：停靠在输入框上方，显示一个会话最前面那个等你选择的请求（docs/v0/screens/approval.md）。
// 出现时不抢焦点、没有默认按钮；Alt+1 / Alt+2 / Alt+3 由 App 的全局按键经 answerFrontApproval 转到这里；
// 焦点在卡上时 Esc 先关开着的浮层，没有浮层才等于拒绝（生成继续），卡片消失时焦点如果在卡上就回到输入框。
// 卡上的文字里不可见的控制字符都换成可见的标记，免得显示顺序与实际执行的不同。
// 平行 Agent（docs/v1/screens/team-approvals.md）：后台实例的卡与对话的卡相同，卡头上面多一行归属；
// 答复经 approval.answer（requestId 是 <实例 id>:<编号>），后台进程交给那个实例。
// 文件系统（docs/specs/file-system-permissions.md §6.13，状态表 docs/v1/screens/fs-permissions.md）：警示区按后台进程判定的
// targets 每个一行原因（最多 5 行），第二个选项按请求是按工具名放行、按目录放行或没有（Alt+2 这时不起作用）；
// 你不在时最后 20 秒卡头下一行显示倒计时（§9.9，docs/v1/screens/fs-question.md "倒计时"）。

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalTarget } from '../../../shared/protocol';
import { roleLabel } from '../../../shared/team';
import { answerApproval } from '../state/actions';
import { awayCountdownDelay, awayCountdownText, awaySecondsLeft, type AwayCardKind } from '../state/away';
import { newTool, type PendingApproval, type PendingTeamApproval } from '../state/model';
import { closeTopOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { isCommandTool, secondOption, targetText, type SecondOption } from './approvalLabel';
import { useNow } from './ToolCard';
import { toolTitle, type ToolTitle } from './toolTitle';

/** 双向文字控制符和零宽字符（approval.md "内容里有不可见的控制字符"） */
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** 原因行最多显示几行，多的写 "and {n} more"（§6.13 的临时默认值） */
const REASON_LINES = 5;

/** 每个会话面板上那张卡的"作出选择"，按会话 key；返回 false 表示这张卡没有这个选项 */
const answerers = new Map<string, (decision: ApprovalDecision) => boolean>();

/**
 * @brief 对会话最前面那张卡作出选择（拒绝时带上理由框里的文字）。Alt+2 传 allowSession：卡按请求换成按工具名或按目录放行。
 * @return 没有卡，或这张卡没有第二个选项（Alt+2）时为 false：调用方不吞这个按键
 */
export function answerFrontApproval(tabKey: string, decision: ApprovalDecision): boolean {
  return answerers.get(tabKey)?.(decision) ?? false;
}

/** @brief edit 的一处替换。 */
interface Replacement {
  /** 原文 */
  oldText: string;
  /** 新文 */
  newText: string;
}

/** @brief 一行原因（警示区）。 */
interface ReasonLine {
  /** 原因（data-reason） */
  reason: ApprovalTarget['reason'];
  /** 这一行的文字 */
  text: string;
}

/** @brief 卡的内容区：路径、替换、内容、命令或参数。 */
interface CardContent {
  /** 修改 / 写入的完整路径（参数原样）；其他工具为 null */
  path: string | null;
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
}

/** @brief 卡上要显示的内容；其中的文字都已把不可见的控制字符标出。 */
interface CardView extends CardContent {
  /** 标题 */
  title: ToolTitle;
  /** 警示区的原因行（最多 REASON_LINES 行，按 targets 的顺序） */
  reasons: ReasonLine[];
  /** 没显示的原因行数（"and {n} more"） */
  moreReasons: number;
  /** 第二个选项；没有时为 null */
  second: SecondOption | null;
  /** 有不可见的控制字符被标出 */
  hidden: boolean;
}

/** @brief 把不可见的控制字符换成可见的"⟨U+202E⟩"。 */
function markHidden(text: string): string {
  return text.replace(HIDDEN_CHARS, (char) => `⟨U+${char.charCodeAt(0).toString(16).toUpperCase()}⟩`);
}

/** @brief edit 参数 edits 里的每处替换。 */
function replacements(args: Record<string, unknown>): Replacement[] {
  const list: unknown[] = Array.isArray(args.edits) ? args.edits : [];
  return list.filter((item): item is Replacement => typeof (item as Replacement)?.oldText === 'string'
    && typeof (item as Replacement).newText === 'string');
}

/** @brief 卡片标题：命令是"Run a command"，其余与工具卡标题相同（Edit / Write <路径>、服务 · 工具、原名）。 */
function cardTitle(approval: PendingApproval, cwd: string): ToolTitle {
  if (isCommandTool(approval.toolName)) return { verb: 'Run a command', target: '', suffix: '' };
  return toolTitle({ ...newTool(approval.toolCallId, approval.toolName), args: approval.args }, cwd);
}

/** @brief 卡的内容区（路径一行是参数里的原文，界面不再自己判断在不在工作路径里，§6.13）。 */
function cardContent(approval: PendingApproval, mark: (text: string) => string): CardContent {
  const { toolName, args } = approval;
  const rawPath = (toolName === 'edit' || toolName === 'write') && typeof args.path === 'string' ? args.path : null;
  const path = rawPath === null ? null : mark(rawPath);
  const edits = toolName === 'edit'
    ? replacements(args).map((edit) => ({ oldText: mark(edit.oldText), newText: mark(edit.newText) })) : [];
  const content = toolName === 'write' && typeof args.content === 'string' ? mark(args.content) : null;
  const command = isCommandTool(toolName) && typeof args.command === 'string' ? mark(args.command) : null;
  const timeout = command !== null && typeof args.timeout === 'number' ? args.timeout : null;
  const shownArgs = edits.length === 0 && content === null && command === null
    ? mark(JSON.stringify(args, null, 2)) : null;
  return { path, edits, content, command, timeout, args: shownArgs };
}

/** @brief 整理卡上要显示的内容（标题、原因行、内容区、第二个选项），并标出其中不可见的控制字符。 */
function cardView(approval: PendingApproval, cwd: string): CardView {
  let hidden = false;
  const mark = (text: string): string => {
    const shown = markHidden(text);
    hidden ||= shown !== text;
    return shown;
  };
  const raw = cardTitle(approval, cwd);
  const title = { verb: mark(raw.verb), target: mark(raw.target), suffix: mark(raw.suffix) };
  const shownTargets = approval.targets.slice(0, REASON_LINES);
  const reasons = shownTargets.map((target) => ({ reason: target.reason, text: mark(targetText(target)) }));
  const option = secondOption(approval);
  const second = option && { ...option, label: mark(option.label), hint: mark(option.hint) };
  const content = cardContent(approval, mark);
  return { ...content, title, reasons, moreReasons: approval.targets.length - shownTargets.length, second, hidden };
}

/** @brief 警示区：每个原因一行（多的写 "and {n} more"）；内容里有不可见的控制字符。都没有时不显示。 */
function ApprovalWarnings({ view }: { view: CardView }) {
  if (view.reasons.length === 0 && !view.hidden) return null;
  return (
    <div className="approval-warnings">
      {view.reasons.map((line, index) => (
        <p key={index} className="approval-warn approval-scope" data-testid="approval-scope"
          data-reason={line.reason}>{line.text}</p>
      ))}
      {view.moreReasons > 0 && (
        <p className="approval-warn approval-scope" data-testid="approval-scope-more">and {view.moreReasons} more</p>
      )}
      {view.hidden && (
        <p className="approval-warn" data-testid="approval-hidden">Contains hidden characters, shown as ⟨U+XXXX⟩</p>
      )}
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
          <span className="approval-meta">Path</span><code>{view.path}</code>
        </div>
      )}
      {edits.map((edit, index) => (
        <div key={index} className="approval-edit" data-testid="approval-edit">
          {edits.length > 1 && <div className="approval-meta">Change {index + 1}</div>}
          <pre className="approval-pre approval-old">{edit.oldText}</pre>
          <pre className="approval-pre approval-new">{edit.newText}</pre>
        </div>
      ))}
      {view.content !== null && <pre className="approval-pre" data-testid="approval-content">{view.content}</pre>}
      {view.command !== null && <pre className="approval-pre" data-testid="approval-command">{view.command}</pre>}
      {view.timeout !== null && <div className="approval-meta">Timeout: {view.timeout}s</div>}
      {view.args !== null && <pre className="approval-pre" data-testid="approval-args">{view.args}</pre>}
    </div>
  );
}

/**
 * @brief 这张卡的"作出选择"：按钮、理由框和 Alt+1 / Alt+2 / Alt+3 共用；拒绝时带上理由框里的文字。
 *        allowSession（Alt+2）换成这张卡的第二个选项；没有第二个选项时什么都不发，返回 false。
 * @param second 第二个选项发的选择；没有第二个选项时为 null
 */
function useAnswer(tabKey: string, requestId: string, reason: string,
  second: SecondOption['decision'] | null): (decision: ApprovalDecision) => boolean {
  const latest = useRef(reason);
  latest.current = reason;
  const answer = useCallback((decision: ApprovalDecision): boolean => {
    const chosen = decision === 'allowSession' || decision === 'allowDir' ? second : decision;
    if (chosen === null) return false;
    void answerApproval(tabKey, requestId, chosen, latest.current);
    return true;
  }, [tabKey, requestId, second]);
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

/**
 * @brief 倒计时要显示的剩下秒数（§9.9）：界面不自己计时，剩下多于 20 秒时只设一个到 deadline − 20 秒的 setTimeout，
 *        进入最后 20 秒才每秒重画（useNow）；deadline 变了（你切回 Mori 时为 null）就重来。卡什么时候结束由后台进程决定。
 * @return 不显示时为 null
 */
function useAwaySeconds(deadline: number | null): number | null {
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    setSince(null);
    const delay = awayCountdownDelay(deadline, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => setSince(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [deadline]);
  const now = useNow(since !== null);
  return since === null ? null : awaySecondsLeft(deadline, Math.max(now, since));
}

/**
 * @brief 你不在时卡头下一行的倒计时（三种卡共用，警示色）：批准卡 You’re away · Denying in 12s，提问卡 … Using the
 *        recommended options in 12s，扩展询问卡 … Cancelling in 12s。没在计时或剩下多于 20 秒时不显示。
 */
export function AwayCountdown({ kind, deadline }: { kind: AwayCardKind; deadline: number | null }) {
  const left = useAwaySeconds(deadline);
  if (left === null || deadline === null) return null;
  return (
    <p className="away-countdown" data-testid="away-countdown" data-deadline={deadline}>
      {awayCountdownText(kind, left)}
    </p>
  );
}

/** @brief 按钮上的快捷键提示（读屏用 aria-keyshortcuts）。 */
function KeyHint({ keys }: { keys: string }) {
  return <span className="approval-key" aria-hidden="true">{keys}</span>;
}

/**
 * @brief 选项和理由框：Allow once、第二个选项（按请求定，没有时不放这个按钮，下方小字同样没有）、理由框、Deny。
 *        在理由框里按 Enter 等于拒绝。
 */
function ApprovalActions({ second, reason, onReason, answer }: {
  second: SecondOption | null; reason: string; onReason: (text: string) => void;
  answer: (decision: ApprovalDecision) => boolean;
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
          onClick={() => answer('allow')}>Allow once<KeyHint keys="Alt+1" /></button>
        {second && (
          <button className="button approval-session" data-testid="approval-allow-session" data-kind={second.kind}
            aria-keyshortcuts="Alt+2" aria-describedby={hintId} onClick={() => answer(second.decision)}>
            {second.label}<KeyHint keys="Alt+2" />
          </button>
        )}
        <input className="approval-reason" data-testid="approval-reason" aria-label="Reason for denying"
          placeholder="Tell the model why (optional)" value={reason} onChange={(event) => onReason(event.target.value)}
          onKeyDown={onReasonKeyDown} />
        <button className="button danger" data-testid="approval-reject" aria-keyshortcuts="Alt+3"
          onClick={() => answer('reject')}>Deny<KeyHint keys="Alt+3" /></button>
      </div>
      {second && <p id={hintId} className="approval-hint">{second.hint}</p>}
    </>
  );
}

/** @brief 批准卡要显示的一个请求：对话自己的，或后台实例的（team 带归属）。 */
interface CardRequest {
  /** 请求（后台实例的 requestId 是 <实例 id>:<编号>） */
  approval: PendingApproval;
  /** 后台实例的请求；对话自己的为 null */
  team: PendingTeamApproval | null;
}

/** @brief 后台实例的请求去掉归属，按对话的卡画（原因行、第二个选项、倒计时都相同，§6.12）。 */
function teamCardApproval(team: PendingTeamApproval): PendingApproval {
  const { requestId, toolCallId, toolName, args, scope, targets, allowDirs, deadline } = team;
  return { requestId, toolCallId, toolName, args, scope, targets, allowDirs, deadline };
}

/** @brief 后台卡的归属行（§11.3）：<role> · T1 · <task title>，没有 task 时 <role>；基座显示 Mori。 */
function attributionText(team: PendingTeamApproval): string {
  const role = roleLabel(team.role);
  return team.task === null ? role : `${role} · ${team.task} · ${team.taskTitle ?? ''}`;
}

/** @brief 一张批准卡。more 是排在后面的张数。 */
function Card({ tabKey, cwd, request, more }: {
  tabKey: string; cwd: string; request: CardRequest; more: number;
}) {
  const { approval, team } = request;
  const ref = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const view = cardView(approval, cwd);
  const answer = useAnswer(tabKey, approval.requestId, reason, view.second?.decision ?? null);
  useFocusBack(ref);
  const { title } = view;
  const titleText = [title.verb, title.target].filter(Boolean).join(' ') + title.suffix;

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    // 焦点在卡上时 Esc：有开着的浮层（"Queue"的下拉、权限菜单、报告框……）先关它，卡不变；
    // 没有浮层才只拒绝这张卡、生成继续。两种情况全局 Esc 都看到 defaultPrevented 就跳过。
    event.preventDefault();
    event.stopPropagation();
    if (closeTopOverlay()) return;
    answer('reject');
  }

  return (
    <div ref={ref} className="approval-card" role="group" aria-label={`Waiting for your approval: ${titleText}`}
      data-testid="approval-card" data-tool={approval.toolName} data-request={approval.requestId}
      data-scope={approval.scope} data-agent={team?.role} data-task={team?.task ?? undefined} onKeyDown={onKeyDown}>
      {team && <div className="approval-attribution" data-testid="approval-attribution">{attributionText(team)}</div>}
      <div className="approval-head">
        <span className="approval-title" data-testid="approval-title">
          {title.verb}{title.target && <>{' '}<code>{title.target}</code></>}{title.suffix}
        </span>
        {more > 0 && <span className="approval-more" data-testid="approval-more">{more} more</span>}
      </div>
      <AwayCountdown kind="approval" deadline={approval.deadline} />
      <ApprovalWarnings view={view} />
      <ApprovalBody view={view} />
      <ApprovalActions second={view.second} reason={reason} onReason={setReason} answer={answer} />
    </div>
  );
}

/**
 * @brief 一个会话的批准卡：只显示一张，处理完下一张接着出现。对话自己的卡排在后台实例的卡之前，各按到达顺序；
 *        正在显示的卡不因新到的卡而换掉（Alt+1 总是作用于看得到的那张，team-approvals.md）。
 */
export function ApprovalCard({ tab }: { tab: Tab }) {
  const { approvals, teamApprovals } = tab.transcript;
  const shown = useRef<string | null>(null);
  const requests: CardRequest[] = [...approvals.map((approval) => ({ approval, team: null })),
    ...teamApprovals.map((team) => ({ approval: teamCardApproval(team), team }))];
  const front = requests.find((item) => item.approval.requestId === shown.current) ?? requests[0];
  shown.current = front?.approval.requestId ?? null;
  if (!front) return null;
  return <Card key={front.approval.requestId} tabKey={tab.key} cwd={tab.cwd} request={front}
    more={requests.length - 1} />;
}
