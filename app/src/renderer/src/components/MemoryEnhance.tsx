// 记忆页 Project 时分节上面的增强一块（docs/specs/memory.md §10.4；状态表见 docs/v1/screens/memory-enhance.md）：
// 开关 Enhancement（失败时下面一行原因，开关回到 info.enabled，同协作开关）、状态行（enhanceStatusText）、Run now、
// Settings…（对话框 Enhancement settings：Model range、Effort、Run with team mode、Daily time；保存失败时不关闭）。

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { enhanceStatusText, type EnhanceInfo } from '../../../shared/memory';
import type { ModelConfig, ModelsInfo, ThinkingLevel } from '../../../shared/models';
import { THINKING_LABELS, THINKING_LEVELS } from '../../../shared/protocol';
import { describe, request } from '../state/bridge';
import {
  runEnhanceNow, saveEnhanceSettings, setEnhanceEnabled, useMemory, useUnavailable,
} from '../state/memory';
import { useOverlay } from '../state/overlays';
import { unavailableTitle } from './MemoryCommon';
import '../styles/models-settings.css';

/** 范围的第一个候选没标支持思考时 Effort 的悬停说明（同顶栏） */
const UNSUPPORTED_EFFORT = 'This model isn’t marked “Supports thinking”';
/** 没有选中范围、范围取不到候选时 Effort 的悬停说明（临时，memory-enhance.md） */
const NO_RANGE_EFFORT = 'Choose a model first.';
/** 开关失败的那一行多久后消失（同协作开关） */
const SWITCH_ERROR_MS = 10_000;

/** @brief 状态行：Run now 失败、enhance.get 命令失败、或 §10.4 的表（读到之前留空）。 */
function statusText(info: EnhanceInfo | null, readError: string | null, runError: string | null): string {
  if (runError) return `Couldn’t run enhancement: ${runError}`;
  if (readError) return `Couldn’t read the enhancement settings: ${readError}`;
  return info ? enhanceStatusText(info) : '';
}

/** @brief Run now 不可用：这个项目正在跑或排着、开关关、没有模型、读不出设置、读取中、后台进程不可用。 */
function runBlocked(info: EnhanceInfo | null, unavailable: string | null): boolean {
  return !info || !info.enabled || info.pick === null || info.running !== null || info.queued > 0
    || info.error !== null || unavailable !== null;
}

/**
 * @brief 开关（同协作开关）：请求期间保持原来的状态、不可用；失败时下面一行原因，开关回到 info.enabled，
 *        这一行在下次点开关或 10 秒后消失。
 */
function useEnhanceSwitch(info: EnhanceInfo | null) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), SWITCH_ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);
  async function toggle() {
    setPending(true);
    setError(null);
    setError(await setEnhanceEnabled(!(info?.enabled ?? false)));
    setPending(false);
  }
  return { pending, error, toggle };
}

/** @brief 增强一块。 */
export function MemoryEnhance() {
  const { info, readError, runError } = useMemory(useShallow((state) => ({ info: state.enhance,
    readError: state.enhanceError, runError: state.runError })));
  const unavailable = useUnavailable();
  const enhanceSwitch = useEnhanceSwitch(info);
  const [sending, setSending] = useState(false);
  const [dialog, setDialog] = useState(false);
  const title = unavailableTitle(unavailable);
  async function run() {
    setSending(true);
    await runEnhanceNow();
    setSending(false);
  }
  return (
    <div className="memory-enhance" data-testid="memory-enhance">
      <div className="memory-enhance-row">
        <button type="button" className="memory-switch" role="switch" aria-checked={info?.enabled ?? false}
          data-testid="enhance-switch" disabled={!info || enhanceSwitch.pending || unavailable !== null}
          title={title} onClick={() => void enhanceSwitch.toggle()}>
          <span className="tools-switch" aria-hidden="true"><span className="tools-switch-knob" /></span>Enhancement
        </button>
        <span className="memory-enhance-status" data-testid="enhance-status" role="status">
          {statusText(info, readError, runError)}</span>
        <span className="memory-enhance-actions">
          <button type="button" className="button" data-testid="enhance-run" title={title}
            disabled={sending || runBlocked(info, unavailable)} onClick={() => void run()}>Run now</button>
          <button type="button" className="button" data-testid="enhance-settings"
            disabled={!info || unavailable !== null} title={title} onClick={() => setDialog(true)}>Settings…</button>
        </span>
      </div>
      {enhanceSwitch.error && (
        <p className="form-message error memory-enhance-error" role="alert" data-testid="enhance-error">
          Couldn’t change enhancement: {enhanceSwitch.error}</p>
      )}
      {dialog && info && <EnhanceDialog info={info} onClose={() => setDialog(false)} />}
    </div>
  );
}

// ---- 设置对话框 ----

/** @brief 下拉的一项：组、提供商、模型（同设置页 Defaults 的下拉，不提供 None）。 */
interface PickOption {
  /** 选择范围 */
  value: string;
  /** 文字 */
  label: string;
}

/** @brief 下拉的三节。 */
function pickOptions(config: ModelConfig): { label: string; options: PickOption[] }[] {
  const groups = config.groups.map((group) => ({ value: group.id, label: group.id }));
  const providers = config.providers.map((item) => ({ value: item.id, label: item.name }));
  const models = config.providers.flatMap((item) => item.models.map((model) => ({
    value: `${item.id}/${model.id}`, label: `${item.name} · ${model.id}` })));
  return [{ label: 'Groups', options: groups }, { label: 'Providers', options: providers },
    { label: 'Models', options: models }].filter((section) => section.options.length > 0);
}

/** @brief 打开对话框时读一次模型配置（models.get）。 */
function useModelConfig(): { config: ModelConfig | null; error: string | null } {
  const [state, setState] = useState<{ config: ModelConfig | null; error: string | null }>({ config: null,
    error: null });
  useEffect(() => {
    let live = true;
    request<ModelsInfo>({ type: 'models.get' }).then(
      (info) => live && setState({ config: info.config, error: info.config ? null : info.loadError ?? info.error }),
      (error) => live && setState({ config: null, error: describe('models.get', error) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** @brief 对话框里 Tab 只在可用的控件之间切换。 */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
}

/** @brief 对话框四项的草稿。 */
interface Draft {
  pick: string;
  thinking: ThinkingLevel;
  team: boolean;
  time: string;
}

/** @brief Model range 下拉；value 为空串时没有选中项（没有选过范围，或选过的已经不在模型设置里）。 */
function ModelField({ config, value, onChange }: {
  config: ModelConfig | null; value: string; onChange: (pick: string) => void;
}) {
  const id = useId();
  return (
    <div className="mf-row">
      <label htmlFor={id}>Model range</label>
      <select id={id} className="mf-control" data-testid="enhance-model" value={value} disabled={!config}
        onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled hidden />
        {config && pickOptions(config).map((section) => (
          <optgroup key={section.label} label={section.label}>
            {section.options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/**
 * @brief Effort 下拉：pi 的七档；模型设置读到之前不可用；所选范围的第一个候选（后台进程按 §9.1 取，
 *        EnhanceInfo.effortPicks）没标支持思考时不可用；没有选中范围或范围取不到候选时不可用（悬停 Choose a model
 *        first.）；不可用时保持原来的值。第一个候选思考关不掉时（noOff，model-providers.md §7.7）不列 Off，
 *        草稿是 off 时显示 Minimal（草稿与 Save 仍是 off）。
 * @param thinks 第一个候选是否标了支持思考；没有选中范围或范围取不到候选时为 undefined
 * @param noOff 所选范围在 info.noOffPicks 里，且 thinks 为真（§7.7）
 */
function EffortField({ value, ready, thinks, noOff, onChange }: {
  value: ThinkingLevel; ready: boolean; thinks: boolean | undefined; noOff: boolean;
  onChange: (level: ThinkingLevel) => void;
}) {
  const id = useId();
  const hover = !ready ? undefined : thinks === undefined ? NO_RANGE_EFFORT : thinks ? undefined : UNSUPPORTED_EFFORT;
  // §7.7：增强会话里 pi 按实际模型把 Off 提到 Minimal，所以显示 Minimal；存着的 off 不改写，没有悬停说明
  const levels = noOff ? THINKING_LEVELS.filter((level) => level !== 'off') : THINKING_LEVELS;
  return (
    <div className="mf-row">
      <label htmlFor={id}>Effort</label>
      <select id={id} className="mf-control" data-testid="enhance-effort"
        value={noOff && value === 'off' ? 'minimal' : value} disabled={!ready || hover !== undefined} title={hover}
        onChange={(event) => onChange(event.target.value as ThinkingLevel)}>
        {levels.map((level) => <option key={level} value={level}>{THINKING_LABELS[level]}</option>)}
      </select>
    </div>
  );
}

/** @brief Team mode 与 Daily time 两项。 */
function TeamAndTime({ draft, timeError, onChange }: {
  draft: Draft; timeError: string | null; onChange: (patch: Partial<Draft>) => void;
}) {
  const timeId = useId();
  return (
    <>
      <fieldset className="mf-row">
        <legend>Team mode</legend>
        <div className="mf-control">
          <label className="check-row">
            <input type="checkbox" data-testid="enhance-team" checked={draft.team}
              onChange={(event) => onChange({ team: event.target.checked })} />
            <span>Run with team mode</span>
          </label>
          <p className="field-hint">Uses this project’s agents in .mori/agents.</p>
        </div>
      </fieldset>
      <div className="mf-row">
        <label htmlFor={timeId}>Daily time</label>
        <div className="mf-control">
          <input id={timeId} type="time" data-testid="enhance-time" value={draft.time}
            aria-invalid={Boolean(timeError)} onChange={(event) => onChange({ time: event.target.value })} />
          <p className="field-hint">Runs once a day at this time. Conversations before it count as the previous day.</p>
          {timeError && <span className="field-error" role="alert">{timeError}</span>}
        </div>
      </div>
    </>
  );
}

/** @brief 下拉里选中的范围：模型设置里有它时就是它；否则（还没读到、没有选过、已经不在）为空串，没有选中项。 */
function chosenPick(config: ModelConfig | null, pick: string): string {
  if (!config) return '';
  const all = pickOptions(config).flatMap((section) => section.options.map((item) => item.value));
  return all.includes(pick) ? pick : '';
}

/**
 * @brief 对话框的 Save：时间为空时 `Choose a time.`、不发命令；没有选中范围时不带 pick（保留已存的值）；
 *        保存失败时原因留在框里，成功时关闭。
 * @param pick 下拉里选中的范围；没有时为空串
 */
function useDialogSave(draft: Draft, pick: string, onClose: () => void) {
  const [timeError, setTimeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!draft.time) {
      setTimeError('Choose a time.');
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await saveEnhanceSettings({ ...(pick ? { pick } : {}), thinking: draft.thinking,
      team: draft.team, time: draft.time });
    setBusy(false);
    if (failure) setError(`Couldn’t save the enhancement settings: ${failure}`);
    else onClose();
  }
  return { timeError, clearTimeError: () => setTimeError(null), error, busy, save };
}

/**
 * @brief 设置对话框：盖住整个窗口；Esc 等于 Cancel（保存中不能关）；保存失败时原因留在框里；
 *        后台进程退出时 Save 不可用（悬停说明原因），框里的值保留。
 */
function EnhanceDialog({ info, onClose }: { info: EnhanceInfo; onClose: () => void }) {
  const { config, error: configError } = useModelConfig();
  const unavailable = useUnavailable();
  const [draft, setDraft] = useState<Draft>({ pick: info.pick ?? '', thinking: info.thinking, team: info.team,
    time: info.time });
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const pick = chosenPick(config, draft.pick);
  const thinks: boolean | undefined = pick ? info.effortPicks[pick] : undefined;
  // §7.7：effortPicks 为真时才看 noOffPicks（memory-enhance.md"Effort 没有 Off"）；按最近一次 enhance.get，不跟着档案变
  const noOff = thinks === true && pick !== '' && info.noOffPicks.includes(pick);
  const { timeError, clearTimeError, error, busy, save } = useDialogSave(draft, pick, onClose);
  useOverlay(true, () => (busy ? false : onClose()));
  // 打开时焦点在第一个控件上；模型配置读到之前 Model range 不可用，读到后焦点移到它。
  useEffect(() => box.current?.querySelector<HTMLElement>('select:not(:disabled), input')?.focus(),
    [config !== null]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget
      && event.preventDefault()}>
      <div ref={box} className="dialog memory-enhance-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        data-testid="enhance-dialog" onKeyDown={trapTab}>
        <h2 id={titleId}>Enhancement settings</h2>
        <div className="mf-grid">
          <ModelField config={config} value={pick} onChange={(next) => setDraft({ ...draft, pick: next })} />
          <EffortField value={draft.thinking} ready={config !== null || configError !== null} thinks={thinks}
            noOff={noOff} onChange={(thinking) => setDraft({ ...draft, thinking })} />
          <TeamAndTime draft={draft} timeError={timeError} onChange={(patch) => {
            if (patch.time) clearTimeError();
            setDraft({ ...draft, ...patch });
          }} />
        </div>
        {configError && <p className="form-message error" role="alert">Couldn’t load model settings: {configError}</p>}
        {error && <p className="form-message error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button primary" data-testid="enhance-save"
            disabled={busy || (!config && !configError) || unavailable !== null}
            title={unavailableTitle(unavailable)} onClick={() => void save()}>Save</button>
          <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
