// 提问卡（ask_user_question，docs/specs/file-system-permissions.md §10.4；状态表 docs/v1/screens/fs-question.md "提问卡"）：
// 一次调用一张卡，卡头是各问题的 header，下面按参数的顺序列出每个问题：header、问题原文、选项（单选是单选按钮，multiSelect
// 是勾选框；label 一行、description 在下面用次要文字色），最后一项 Other（选中后出现输入框，焦点移到输入框）。推荐项只在
// label 后面加 " (Recommended)"，不预先选中、不改顺序。每个问题都有答案（选了选项，或 Other 里有非空文字）时 Submit 才可用。
// 停在输入框上方，不抢焦点、没有默认按钮，输入框里的 Enter 仍是发送。键盘：Tab 进卡，↑ ↓ 在组内移动（不选中），Space 选中
// 或勾选，Tab 到下一组、Other 的输入框、Submit；Other 输入框里 Enter 在全部答完时等于 Submit；焦点在卡上、没有浮层时
// Esc 等于拒绝回答。卡上的选择只在界面里，提交前不发给后台进程：批准卡插到前面、提问卡暂时让位时还在，界面重新载入后
// 不保留；你不在、到时后台进程一律用推荐项（§9.4）。

import { useEffect, useId, useRef, useState } from 'react';
import type { AskQuestion } from '../../../shared/workspace';
import { answerAsk } from '../state/actions';
import { ASK_OTHER_MAX, askReply, type AskChoice } from '../state/asks';
import type { PendingAsk } from '../state/model';
import { closeTopOverlay } from '../state/overlays';
import { AwayCountdown, useFocusBack } from './ApprovalCard';

/** 还没作答的问题 */
const EMPTY_CHOICE: AskChoice = { selected: [], other: null };

/**
 * 每个会话面板上提问卡还没提交的选择，按会话 key，只记最前面那张卡：有批准卡时提问卡让位（卸载），批准卡处理完它重新出现，
 * 选择还在。按 requestId 与 askedAt 认是不是同一张卡（后台进程重新载入后 ask-<n> 从 1 重新编号）；换成别的提问卡时被它
 * 取代；界面重新载入后为空
 */
const drafts = new Map<string, { requestId: string; askedAt: number; choices: AskChoice[] }>();

/**
 * @brief 你在一个问题上点了一项后的选择：单选时这一项（或 Other）取代同一问题里的其他项；多选时勾上或取消，Other 可以
 *        和选项同时选。Other 刚选上时输入框是空的，取消 Other 时丢掉输入框里的字。
 * @param label 选项的 label；Other 为 null
 * @param on 选中（单选按钮只会是 true）
 */
function nextChoice(question: AskQuestion, choice: AskChoice, label: string | null, on: boolean): AskChoice {
  if (!question.multiSelect) {
    return label === null ? { selected: [], other: choice.other ?? '' } : { selected: [label], other: null };
  }
  if (label === null) return { ...choice, other: on ? choice.other ?? '' : null };
  const selected = on ? [...choice.selected, label] : choice.selected.filter((item) => item !== label);
  return { ...choice, selected };
}

/** @brief 这一项是不是推荐项（后台进程按去掉首尾空白后逐字比较核对过，§10.2）。 */
function isRecommended(question: AskQuestion, label: string): boolean {
  return label.trim() === question.recommended.trim();
}

/** @brief 方向键在组内移动的步长；不是 ↑ ↓ ← → 时为 0。 */
function arrowStep(key: string): number {
  if (key === 'ArrowDown' || key === 'ArrowRight') return 1;
  return key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 0;
}

/**
 * @brief 一组（一个问题的选项与 Other）的键盘：方向键在组内移动焦点、不选中（单选按钮也不随方向键选中），Space 由浏览器
 *        选中或勾选；整组只有一个 Tab 停靠点（最后聚焦的那一项），Tab 到下一组。单选按钮不设 name，免得浏览器自己的
 *        单选组规则（只有选中的那一个能 Tab 到）跟这里的停靠点冲突；互斥由选择本身保证。
 * @param count 组内的项数（选项加 Other）
 */
function useRoving(count: number) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const [stop, setStop] = useState(0);
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const at = inputs.current.indexOf(event.target as HTMLInputElement);
    const step = arrowStep(event.key);
    if (at < 0 || step === 0) return;
    event.preventDefault();
    inputs.current[(at + step + count) % count]?.focus();
  }
  const item = (at: number) => ({
    ref: (element: HTMLInputElement | null) => { inputs.current[at] = element; },
    tabIndex: at === stop ? 0 : -1,
    onFocus: () => setStop(at),
  });
  return { onKeyDown, item };
}

/**
 * @brief 选上 Other 之后焦点移到它的输入框（fs-question.md "选了 Other"）：只在你刚选上时移，卡重新出现、输入框跟着
 *        草稿出现时不移（卡不抢焦点）。
 * @return 输入框的 ref 与"刚选上 Other"的记号（选上时调用）
 */
function useOtherFocus() {
  const input = useRef<HTMLInputElement>(null);
  const wanted = useRef(false);
  useEffect(() => {
    if (!wanted.current || !input.current) return;
    wanted.current = false;
    input.current.focus();
  });
  return { input, request: () => { wanted.current = true; } };
}

/** @brief 一个问题的 Other 输入框：选上 Other 时出现；Enter 在全部答完时等于 Submit，否则不做什么。 */
function OtherInput({ header, value, inputRef, onText, onEnter }: {
  header: string; value: string; inputRef: React.RefObject<HTMLInputElement | null>; onText: (text: string) => void;
  onEnter: () => void;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    onEnter();
  }
  return (
    <input ref={inputRef} className="ask-other-input" data-testid="ask-other-input"
      aria-label={`Other answer for ${header}`} placeholder="Type your answer" maxLength={ASK_OTHER_MAX} value={value}
      onChange={(event) => onText(event.target.value)} onKeyDown={onKeyDown} />
  );
}

/** @brief 一个问题：header、问题原文、选项（推荐项带 " (Recommended)"）、Other 与它的输入框。 */
function AskGroup({ question, index, choice, onChange, onEnter }: {
  question: AskQuestion; index: number; choice: AskChoice; onChange: (choice: AskChoice) => void;
  onEnter: () => void;
}) {
  const textId = useId();
  const roving = useRoving(question.options.length + 1);
  const other = useOtherFocus();
  const type = question.multiSelect ? 'checkbox' : 'radio';
  const pick = (label: string | null, on: boolean) => {
    if (label === null && on) other.request();
    onChange(nextChoice(question, choice, label, on));
  };
  return (
    <div className="ask-question" data-testid="ask-question" data-index={index}
      data-multi={String(question.multiSelect)}>
      <span className="ask-header">{question.header}</span>
      <p id={textId} className="ask-text">{question.question}</p>
      <div className="ask-options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={textId}
        onKeyDown={roving.onKeyDown}>
        {question.options.map((option, at) => (
          <label key={option.label} className="check-row ask-option" data-testid="ask-option"
            data-label={option.label} data-recommended={isRecommended(question, option.label) ? 'true' : undefined}>
            <input type={type} checked={choice.selected.includes(option.label)} {...roving.item(at)}
              onChange={(event) => pick(option.label, event.target.checked)} />
            <span className="ask-option-text">
              {option.label}
              {isRecommended(question, option.label) && <span data-testid="ask-recommended">{' (Recommended)'}</span>}
              {option.description && <small>{option.description}</small>}
            </span>
          </label>
        ))}
        <label className="check-row ask-option" data-testid="ask-other">
          <input type={type} checked={choice.other !== null} {...roving.item(question.options.length)}
            onChange={(event) => pick(null, event.target.checked)} />
          <span className="ask-option-text">Other</span>
        </label>
        {choice.other !== null && <OtherInput header={question.header} value={choice.other} inputRef={other.input}
          onEnter={onEnter} onText={(text) => onChange({ ...choice, other: text })} />}
      </div>
    </div>
  );
}

/**
 * @brief 卡上每个问题的选择（与 questions 同序）：从这个会话记下的草稿接着来（同一张卡），否则都还没作答；
 *        每次改动记回草稿。
 * @return 选择与改一个问题的选择
 */
function useChoices(tabKey: string, ask: PendingAsk): [AskChoice[], (index: number, choice: AskChoice) => void] {
  const [choices, setChoices] = useState<AskChoice[]>(() => {
    const draft = drafts.get(tabKey);
    const same = draft?.requestId === ask.requestId && draft.askedAt === ask.askedAt;
    return same ? draft.choices : ask.questions.map(() => EMPTY_CHOICE);
  });
  useEffect(() => {
    drafts.set(tabKey, { requestId: ask.requestId, askedAt: ask.askedAt, choices });
  }, [tabKey, ask.requestId, ask.askedAt, choices]);
  const change = (index: number, choice: AskChoice) => {
    setChoices((list) => list.map((item, at) => (at === index ? choice : item)));
  };
  return [choices, change];
}

/**
 * @brief 一张提问卡。more 是排在后面的询问卡张数（提问卡与扩展询问卡都算）。Submit 发 question.answer，Esc（焦点在卡上、
 *        没有浮层时）发 answers: null 拒绝回答；卡随后由 mori.question_end 去掉，焦点在卡上时回到输入框。
 */
export function AskCard({ tabKey, ask, more }: { tabKey: string; ask: PendingAsk; more: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [choices, change] = useChoices(tabKey, ask);
  useFocusBack(ref);
  const replies = askReply(ask.questions, choices);
  const headers = ask.questions.map((question) => question.header);
  const submit = () => {
    if (replies) void answerAsk(tabKey, ask.requestId, replies);
  };

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    // 同批准卡：有开着的浮层先关它，卡不变；没有浮层才拒绝回答。全局 Esc 看到 defaultPrevented 就不停止。
    event.preventDefault();
    event.stopPropagation();
    if (closeTopOverlay()) return;
    void answerAsk(tabKey, ask.requestId, null);
  }

  return (
    <div ref={ref} className="approval-card ask-card" role="group"
      aria-label={`Waiting for your answer: ${headers.join(', ')}`} data-testid="ask-card"
      data-request={ask.requestId} onKeyDown={onKeyDown}>
      <div className="approval-head">
        <span className="approval-title ask-headers">
          {headers.map((header, index) => <span key={index} className="ask-header">{header}</span>)}
        </span>
        {more > 0 && <span className="approval-more" data-testid="approval-more">{more} more</span>}
      </div>
      <AwayCountdown kind="ask" deadline={ask.deadline} />
      <div className="ask-body">
        {ask.questions.map((question, index) => (
          <AskGroup key={index} question={question} index={index} choice={choices[index] ?? EMPTY_CHOICE}
            onChange={(choice) => change(index, choice)} onEnter={submit} />
        ))}
      </div>
      <div className="approval-actions">
        <button className="button ask-submit" data-testid="ask-submit"
          aria-disabled={replies === null ? true : undefined} onClick={submit}>Submit</button>
      </div>
    </div>
  );
}
