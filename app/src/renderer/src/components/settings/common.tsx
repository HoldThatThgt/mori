// 设置 → Models 与首次启动表单共用的小件（docs/v1/screens/models-settings.md）：对话框、字段错误、测试中与测试结果、
// 上移下移按钮、数字的写法。

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DeleteResult, ModelCommand } from '../../../../shared/models';
import { describe, request } from '../../state/bridge';
import { Icon } from '../../icons';
import { useOverlay } from '../../state/overlays';
import { cancelTest, useSettings, writeModels, type Notice } from '../../state/settings';

/**
 * @brief 立即保存（§9.1）：保存中显示要保存的值、控件不可用；失败时显示原文，控件回到保存前的值；成功时没有提示，
 *        值来自重新读取的 models.get。
 */
export function useImmediateSave<T>() {
  const [pending, setPending] = useState<{ value: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save(value: T, command: ModelCommand): Promise<boolean> {
    setPending({ value });
    setError(null);
    const result = await writeModels(command);
    setPending(null);
    setError(result.error);
    return result.error === null;
  }
  return { pending, busy: pending !== null, error, save };
}

/** @brief 数字按千分位写（models-settings.md "模型行"）。 */
export function thousands(value: number): string {
  return value.toLocaleString('en-US');
}

/** @brief 对话框的内容与状态。 */
export interface ModelDialogProps {
  /** 测试标识：confirm-dialog */
  testId: string;
  /** confirm-dialog 的种类（data-kind） */
  kind?: string;
  /** 标题 */
  title: string;
  /** 正文：说明、连带改动等 */
  children: ReactNode;
  /** 确认按钮的文字 */
  confirmLabel: string;
  /** 确认按钮的样式：danger 删除，primary 其他 */
  tone: 'danger' | 'primary';
  /** 进行中：按钮不可用，不能关 */
  busy: boolean;
  /** 失败的原文；没有时为 null */
  error: string | null;
  /** 点了确认 */
  onConfirm: () => void;
  /** 点了取消或按了 Esc */
  onCancel: () => void;
}

/** 对话框里 Tab 可以停留的控件 */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)';

/** @brief 对话框里 Tab 只在可用的控件之间切换。 */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const index = items.indexOf(document.activeElement as HTMLElement);
  items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
}

/** @brief 设置 → Models 的对话框：盖住整个窗口；Esc 等于 Cancel（进行中不能关）；失败时原文留在框里。 */
export function ModelDialog(props: ModelDialogProps) {
  const { testId, kind, title, children, confirmLabel, tone, busy, error, onConfirm, onCancel } = props;
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlay(true, () => {
    if (busy) return false;
    onCancel();
  });
  useEffect(() => {
    if (busy) return;
    box.current?.querySelector<HTMLElement>('[data-role="cancel"]')?.focus();
  }, [busy, error]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget
      && event.preventDefault()}>
      <div ref={box} className="dialog model-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        data-testid={testId} data-kind={kind} onKeyDown={trapTab}>
        <h2 id={titleId}>{title}</h2>
        {children}
        {error && <p className="form-message error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className={`button ${tone}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
          <button className="button" data-role="cancel" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** @brief 确认框的连带改动（§4.1），每项一行；没有时不显示。 */
export function Cascade({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return <ul className="cascade" data-testid="cascade">{lines.map((line) => <li key={line}>{line}</li>)}</ul>;
}

/** @brief 字段旁的英文错误；没有时不显示。 */
export function FieldError({ field, error }: { field: string; error: string | null | undefined }) {
  if (!error) return null;
  return <span className="field-error" data-testid="field-error" data-field={field} role="alert">{error}</span>;
}

/** @brief 一行结果文字。 */
export function NoticeLine({ notice, testId }: { notice: Notice | null | undefined; testId: string }) {
  if (!notice) return null;
  return <p className={`form-message ${notice.tone}`} role="status" data-testid={testId}>{notice.text}</p>;
}

/**
 * @brief 测试按钮：测试中显示"Testing…"和旁边的"Cancel"（提供商卡与 Keys 的行两处共用 data-action="test-cancel"；
 *        2026-10-26 起模型行没有 Test）。
 * @param at 测试位置（state/settings.ts 的 testAt）
 */
export function TestButton({ at, label, action, onTest }: {
  at: string; label: string; action: string; onTest: () => void;
}) {
  const testing = useSettings((state) => state.testing);
  return (
    <>
      <button className="button compact" data-action={action} disabled={testing !== null} onClick={onTest}>
        {testing === at ? 'Testing…' : label}
      </button>
      {testing === at && <button className="button compact" data-action="test-cancel" onClick={cancelTest}>
        Cancel</button>}
    </>
  );
}

/** @brief 这个位置最近一次的测试结果。 */
export function TestNotice({ at, testId }: { at: string; testId: string }) {
  const notice = useSettings((state) => state.tests[at]);
  return <NoticeLine notice={notice} testId={testId} />;
}

/** @brief 上移、下移：第一行没有上移、最后一行没有下移；读屏名称"Move up""Move down"。 */
export function MoveButtons({ index, count, busy, actions, onMove }: {
  index: number; count: number; busy: boolean; actions: [string, string]; onMove: (delta: -1 | 1) => void;
}) {
  return (
    <>
      {index > 0 && <button className="icon-button move-button" aria-label="Move up" title="Move up"
        data-action={actions[0]} disabled={busy} onClick={() => onMove(-1)}><Icon name="arrow" /></button>}
      {index < count - 1 && <button className="icon-button move-button" aria-label="Move down" title="Move down"
        data-action={actions[1]} disabled={busy} onClick={() => onMove(1)}>
        <Icon name="arrow" className="flip" /></button>}
    </>
  );
}

/** @brief 删除的确认流程：先 dryRun 算出连带改动，确认框列出它们，确认后真正删除（§4.1、§9.5）。 */
export interface DeleteFlow {
  /** 确认框开着 */
  open: boolean;
  /** 连带改动（确认框的各行） */
  lines: string[];
  /** 删除中 */
  busy: boolean;
  /** 失败的原文 */
  error: string | null;
  /** 点了 Delete：算连带改动并打开确认框 */
  start: () => Promise<void>;
  /** 确认框里点了 Delete */
  confirm: () => Promise<void>;
  /** 取消 */
  cancel: () => void;
}

/**
 * @brief 删除的确认流程。
 * @param command 删除命令；dryRun 为真时只算连带改动
 */
export function useDeleteFlow(command: (dryRun: boolean) => ModelCommand): DeleteFlow {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    const dry = command(true);
    try {
      const result = await request<DeleteResult>(dry);
      setLines(result.consequences ?? []);
      setError(result.error);
    } catch (failure) {
      setLines([]);
      setError(describe(dry.type, failure));
    }
    setOpen(true);
  }
  async function confirm() {
    setBusy(true);
    const result = await writeModels<DeleteResult>(command(false));
    setBusy(false);
    if (result.error === null) setOpen(false);
    else setError(result.error);
  }
  return { open, lines, busy, error, start, confirm, cancel: () => setOpen(false) };
}

/** @brief 删除的确认框：data-kind 为 delete-provider、delete-model、delete-group；lead 为连带改动之前的说明。 */
export function DeleteDialog({ flow, kind, title, lead }: {
  flow: DeleteFlow; kind: string; title: string; lead?: string;
}) {
  if (!flow.open) return null;
  return (
    <ModelDialog testId="confirm-dialog" kind={kind} title={title} confirmLabel="Delete" tone="danger"
      busy={flow.busy} error={flow.error} onConfirm={() => void flow.confirm()} onCancel={flow.cancel}>
      {lead && <p>{lead}</p>}
      <Cascade lines={flow.lines} />
    </ModelDialog>
  );
}
