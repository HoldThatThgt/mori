// 记忆页的条目表单（docs/specs/memory.md §10.1"编辑与新增"）：Abstract 单行（粘贴进来的换行换成空格）、Details 多行、
// Save / Cancel。表单 noValidate：按 Save 时先查，有问题时在字段下方显示、不发命令；后台进程按同样的规则再查。
// 有未保存的改动时登记离开检查（标题 Discard changes to this entry?），你选 Keep editing 后焦点回到表单。

import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type RefObject } from 'react';
import { MEMORY_DEFAULTS } from '../../../shared/memory';
import { setLeaveGuard, useLeave } from '../state/leaveGuard';
import { closeForm, saveEntry, useMemory, useUnavailable } from '../state/memory';
import { LEAVE_TEXT } from './AgentsSection';
import { unavailableTitle } from './MemoryCommon';

/** 有未保存的改动时离开确认框的标题（临时，§12） */
const LEAVE_TITLE = 'Discard changes to this entry?';

/** @brief 表单两个字段的问题；没有问题的字段不在里面。 */
interface FieldErrors {
  abstract?: string;
  details?: string;
}

/** @brief 字符数（按码点）。 */
function length(text: string): number {
  return [...text].length;
}

/** @brief 按 Save 时的检查（§10.1 的三句）。 */
function fieldErrors(abstract: string, details: string): FieldErrors {
  const errors: FieldErrors = {};
  const trimmed = abstract.trim();
  if (!trimmed) errors.abstract = 'Abstract is required.';
  else if (length(trimmed) > MEMORY_DEFAULTS.abstractMax) {
    errors.abstract = `Abstract must be at most ${MEMORY_DEFAULTS.abstractMax} characters.`;
  }
  if (length(details) > MEMORY_DEFAULTS.detailMax) {
    errors.details = `Details must be at most ${MEMORY_DEFAULTS.detailMax.toLocaleString('en-US')} characters.`;
  }
  return errors;
}

/**
 * @brief 有未保存的改动时登记离开检查：你选 Discard 时关掉表单，选 Keep editing 后焦点回到上次所在的字段。
 * @param last 表单里上次有焦点的字段
 */
function useFormGuard(dirty: boolean, form: RefObject<HTMLFormElement | null>,
  last: RefObject<HTMLElement | null>): void {
  const asking = useLeave((state) => state.proceed !== null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard({ title: LEAVE_TITLE, text: LEAVE_TEXT, discard: closeForm });
    return () => setLeaveGuard(null);
  }, [dirty]);
  useEffect(() => {
    if (wasAsking.current && !asking && dirty) {
      (last.current ?? form.current?.querySelector<HTMLElement>('input'))?.focus();
    }
    wasAsking.current = asking;
  }, [asking, dirty, form, last]);
}

/** @brief 把粘贴的文字放进单行输入框：换行换成空格。 */
function pasteFlat(event: ClipboardEvent<HTMLInputElement>, value: string, set: (next: string) => void): void {
  const text = event.clipboardData.getData('text');
  if (!/[\r\n]/.test(text)) return;
  event.preventDefault();
  const input = event.currentTarget;
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? start;
  const flat = text.replace(/\r\n|\r|\n/g, ' ');
  set(value.slice(0, start) + flat + value.slice(end));
  const caret = start + flat.length;
  requestAnimationFrame(() => input.setSelectionRange(caret, caret));
}

/**
 * @brief 条目表单：initial 为 null 时是新增（空表单），否则是编辑（读到的 abstract 与 Details）。
 */
export function MemoryForm({ initial }: { initial: { abstract: string; details: string } | null }) {
  const [abstract, setAbstract] = useState(initial?.abstract ?? '');
  const [details, setDetails] = useState(initial?.details ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const busy = useMemory((state) => state.busy === 'save');
  const unavailable = useUnavailable();
  const form = useRef<HTMLFormElement>(null);
  const last = useRef<HTMLElement | null>(null);
  const dirty = abstract !== (initial?.abstract ?? '') || details !== (initial?.details ?? '');
  useFormGuard(dirty, form, last);
  useEffect(() => form.current?.querySelector<HTMLElement>('input')?.focus(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || unavailable !== null) return;
    const found = fieldErrors(abstract, details);
    setErrors(found);
    if (found.abstract || found.details) return;
    await saveEntry(abstract.trim(), details);
  }
  return (
    <form ref={form} className="memory-form" data-testid="memory-form" noValidate
      onSubmit={(event) => void submit(event)} onFocus={(event) => { last.current = event.target as HTMLElement; }}>
      <label className="memory-field">
        <span>Abstract</span>
        <input type="text" data-testid="memory-abstract" value={abstract} aria-invalid={Boolean(errors.abstract)}
          onPaste={(event) => pasteFlat(event, abstract, setAbstract)}
          onChange={(event) => setAbstract(event.target.value.replace(/[\r\n]+/g, ' '))} />
      </label>
      {errors.abstract && <span className="field-error" role="alert">{errors.abstract}</span>}
      <label className="memory-field">
        <span>Details</span>
        <textarea data-testid="memory-details" value={details} aria-invalid={Boolean(errors.details)}
          spellCheck={false} onChange={(event) => setDetails(event.target.value)} />
      </label>
      {errors.details && <span className="field-error" role="alert">{errors.details}</span>}
      <div className="form-actions">
        <button type="submit" className="button primary" data-testid="memory-save"
          disabled={busy || unavailable !== null} title={unavailableTitle(unavailable)}>Save</button>
        <button type="button" className="button" disabled={busy} onClick={closeForm}>Cancel</button>
      </div>
    </form>
  );
}
