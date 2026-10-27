// Customize › Agents 的 New agent 与 Edit 表单（docs/specs/customize-agents.md §6.4；状态表 docs/v1/screens/customize-agents.md
// “表单（New agent / Edit）”）：Name、Description（n/200）、Jobs（被别的文件认领的不可用）、Models（会话的范围，或按顺序的
// 列表：Add model range 加、拖动排序（同 Settings › Models 的 settings/Reorder.tsx）、移除）、Prompt。2026-10-27 起角色没有
// tools（file-system-permissions.md §8.6），表单没有 Tools（docs/v1/walkthrough-1026-checks.md 的 U50）。
// 保存经 roles.save；不写文件时表单留着你写的，下面 Couldn’t save: 和问题行。有改动时离开先问（离开检查由上一层登记）。

import type { FormEvent } from 'react';
import { movedItems } from '../../../shared/models';
import type { AgentDraft, AgentView, RoleRange, RolesInfo } from '../../../shared/roles';
import { SEAT_TEXT, rangeGroups } from '../../../shared/roles';
import { SEATS, TEXT_LIMITS, type Seat } from '../../../shared/team';
import { ReorderHandle, ReorderStatus, useReorderRow, type ReorderList } from './settings/Reorder';
import '../styles/models-settings.css';

/** @brief 表单里的值：模型有两种选法。 */
export interface FormValues {
  /** Name 框里的文字（保存时去掉首尾空白） */
  name: string;
  /** Description 框里的文字 */
  description: string;
  /** 勾上的职责 */
  seats: Seat[];
  /** session：用会话的范围；list：按 modelList 的顺序 */
  models: 'session' | 'list';
  /** Use these, in order 的范围，按顺序（选 session 时留着，换回 list 时还在） */
  modelList: string[];
  /** Prompt 框里的文字（文件的正文） */
  prompt: string;
}

/** @brief 新建时的值，或编辑时文件现在的值。 */
export function initialValues(agent: AgentView | null): FormValues {
  return {
    name: agent?.name ?? '', description: agent?.description ?? '', seats: agent?.seats ?? [],
    models: agent?.models ? 'list' : 'session', modelList: agent?.models ?? [],
    prompt: agent?.body ?? '',
  };
}

/** @brief 表单的值 → roles.save 的 agent（§5.1）。 */
export function draftOf(values: FormValues): AgentDraft {
  return { name: values.name.trim(), description: values.description, seats: values.seats,
    models: values.models === 'list' ? values.modelList : null, body: values.prompt };
}

/** @brief Save 可用：有名字、说明，按顺序的列表不为空（状态表“不能保存”）。 */
export function canSave(values: FormValues): boolean {
  return values.name.trim() !== '' && values.description.trim() !== ''
    && (values.models === 'session' || values.modelList.length > 0);
}

/** @brief 表单的状态：保存中、不写文件时的问题。 */
export interface FormStatus {
  /** roles.save 还没回来：字段与按钮不可用，Save 写 Saving… */
  saving: boolean;
  /** 上一次 roles.save 不写文件的原因（每条一行）；没有时为 null */
  error: string | null;
}

/** @brief 字段下面的说明（§6.4）。 */
function Hint({ testId, children }: { testId?: string; children: string }) {
  return <p className="field-hint agent-field-hint" data-testid={testId}>{children}</p>;
}

/** @brief Jobs：三项职责；被别的文件认领的那一项不可用，旁边写 <name> does this。 */
function JobsField({ values, set, holders, self }: {
  values: FormValues; set: (next: Partial<FormValues>) => void; holders: RolesInfo['holders']; self: string | null;
}) {
  const toggle = (seat: Seat, on: boolean) => set({ seats: SEATS.filter((item) => (item === seat ? on
    : values.seats.includes(item))) });
  return (
    <fieldset className="agent-fieldset" data-testid="agent-jobs-field">
      <legend>Jobs</legend>
      {SEATS.map((seat) => {
        const holder = holders[seat];
        const taken = holder !== 'mori' && holder !== self;
        return (
          <label key={seat} className="check-row">
            <input type="checkbox" checked={values.seats.includes(seat)} disabled={taken}
              onChange={(event) => toggle(seat, event.target.checked)} />
            {SEAT_TEXT[seat]}
            {taken && <span className="agent-job-holder" data-testid="agent-job-holder">{holder} does this</span>}
          </label>
        );
      })}
      <Hint>Leave all off for an agent that only works on tasks. Jobs no agent takes stay with Mori.</Hint>
    </fieldset>
  );
}

/** @brief 列表的一项：拖动柄、范围的写法、Remove。 */
function ModelItem({ reorder, index, onRemove }: { reorder: ReorderList; index: number; onRemove: () => void }) {
  const drop = useReorderRow(reorder, index);
  const pick = reorder.labels[index];
  return (
    <li data-pick={pick} {...drop}>
      <ReorderHandle list={reorder} index={index} />
      <span className="tools-mono">{pick}</span>
      <button type="button" className="text-link" aria-label={`Remove ${pick}`} onClick={onRemove}>Remove</button>
    </li>
  );
}

/**
 * @brief 按顺序的模型列表：拖动排序用 Settings › Models 的同一份（settings/Reorder.tsx，customize-agents.md §6.4），
 *        移动只改表单，Save 时才写文件；每项可以移除。
 */
function ModelList({ list, busy, onChange }: { list: string[]; busy: boolean; onChange: (next: string[]) => void }) {
  const reorder: ReorderList = { id: 'agent-models', labels: list, busy, move: async (from, to) => {
    onChange(movedItems(list, from, to));
    return true;
  } };
  return (
    <>
      <ol className="agent-model-list" data-testid="agent-model-list">
        {list.map((pick, index) => (
          <ModelItem key={pick} reorder={reorder} index={index}
            onRemove={() => onChange(list.filter((item) => item !== pick))} />
        ))}
      </ol>
      <ReorderStatus list={reorder} />
    </>
  );
}

/**
 * @brief Models：会话的范围，或按顺序的列表与 Add model range（Groups、Providers，再按提供商各一节
 *        Models · <提供商名称>，同模型菜单；没有项的节不出现）。
 */
function ModelsField({ values, set, ranges, saving }: {
  values: FormValues; set: (next: Partial<FormValues>) => void; ranges: RoleRange[]; saving: boolean;
}) {
  return (
    <fieldset className="agent-fieldset" data-testid="agent-models-field">
      <legend>Models</legend>
      <label className="check-row"><input type="radio" name="agent-models" value="session"
        checked={values.models === 'session'} onChange={() => set({ models: 'session' })} />
        Same as the session’s model range</label>
      <label className="check-row"><input type="radio" name="agent-models" value="list"
        checked={values.models === 'list'} onChange={() => set({ models: 'list' })} />Use these, in order</label>
      {values.models === 'list' && (
        <>
          <ModelList list={values.modelList} busy={saving} onChange={(modelList) => set({ modelList })} />
          <select aria-label="Add model range" value="" onChange={(event) => event.target.value
            && set({ modelList: [...values.modelList, event.target.value] })}>
            <option value="">Add model range</option>
            {rangeGroups(ranges).map((group) => (
              <optgroup key={group.key} label={group.label}>
                {group.ranges.map((range) => (
                  <option key={range.pick} value={range.pick} disabled={values.modelList.includes(range.pick)}>
                    {range.label}</option>))}
              </optgroup>
            ))}
          </select>
        </>
      )}
    </fieldset>
  );
}

/** @brief 表单的属性。 */
export interface AgentFormProps {
  /** 编辑的 agent；新建时为 null */
  agent: AgentView | null;
  /** 现在的值 */
  values: FormValues;
  /** 改一部分值 */
  set: (next: Partial<FormValues>) => void;
  /** 读到的内容（职责的持有者、可选的范围） */
  info: RolesInfo;
  /** 保存中、问题 */
  status: FormStatus;
  /** 点了 Save */
  onSave: () => void;
  /** 点了 Cancel */
  onCancel: () => void;
}

/** @brief New agent / Edit 表单（§6.4）。 */
export function AgentForm({ agent, values, set, info, status, onSave, onCancel }: AgentFormProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave(values) && !status.saving) onSave();
  };
  const count = [...values.description].length;
  return (
    <form className="tools-form agent-form" data-testid="agent-form" data-mode={agent ? 'edit' : 'new'}
      onSubmit={submit}>
      {agent?.headerComments && (
        <p className="tools-warn" data-testid="agent-form-comments">
          Saving rewrites this file’s header and removes its comments.</p>)}
      <fieldset className="agent-fieldset" disabled={status.saving}>
        <label><span>Name</span><input aria-label="Name" value={values.name}
          onChange={(event) => set({ name: event.target.value })} /></label>
        <Hint testId="agent-name-hint">{agent ? `The file name stays ${agent.file}.`
          : 'Lowercase letters, digits, and -. The file is saved as .mori/agents/<name>.md.'}</Hint>
        <label><span>Description</span><input aria-label="Description" value={values.description}
          maxLength={TEXT_LIMITS.roleDescription} onChange={(event) => set({ description: event.target.value })} />
        </label>
        <p className="agent-count" data-testid="agent-desc-count">{count}/{TEXT_LIMITS.roleDescription}</p>
        <Hint>Other agents read this when they decide who does what.</Hint>
        <JobsField values={values} set={set} holders={info.holders} self={agent?.name ?? null} />
        <ModelsField values={values} set={set} ranges={info.ranges} saving={status.saving} />
        <label><span>Prompt</span><textarea aria-label="Prompt" rows={6} value={values.prompt}
          onChange={(event) => set({ prompt: event.target.value })} /></label>
        <Hint>What this agent does and how. Added to its system prompt.</Hint>
      </fieldset>
      {status.error && (
        <p className="form-message error" role="alert" data-testid="agent-form-error">
          {`Couldn’t save:\n${status.error}`}</p>)}
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={!canSave(values) || status.saving}>
          {status.saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="button" disabled={status.saving} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
