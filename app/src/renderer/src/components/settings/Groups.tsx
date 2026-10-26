// Groups：每个分组一行，有序的成员可以加入、去掉、拖动排序（2026-10-26 负责人走查 M5，取代上移下移，见 Reorder.tsx），
// 每次改动立即保存（models.saveGroup，§9.1）；New group 内联表单；Delete 先确认。
// 状态表见 docs/v1/screens/models-settings.md "Groups"与"拖动排序"。

import { useState } from 'react';
import { ID_PATTERN, movedItems, type ModelConfig, type ModelGroup } from '../../../../shared/models';
import { useOverlay } from '../../state/overlays';
import { writeModels } from '../../state/settings';
import { DeleteDialog, useDeleteFlow, useImmediateSave } from './common';
import { ReorderHandle, ReorderStatus, useReorderRow, type ReorderList } from './Reorder';

/** @brief 成员的写法：提供商成员"<name> · all models"，模型成员"<name> · <model id>"。 */
export function memberLabel(config: ModelConfig, member: string): string {
  const slash = member.indexOf('/');
  const providerId = slash < 0 ? member : member.slice(0, slash);
  const name = config.providers.find((item) => item.id === providerId)?.name ?? providerId;
  return slash < 0 ? `${name} · all models` : `${name} · ${member.slice(slash + 1)}`;
}

/**
 * @brief 成员选择：每个提供商一节，第一项"<name> · all models"，其后是它的各个模型；chosen 里的项打勾。
 * @param lockChosen 为真时已选的项不可再选（Add member）；为假时再点取消选择（New group）
 */
function MemberPicker({ config, chosen, lockChosen, onPick, onClose }: {
  config: ModelConfig; chosen: readonly string[]; lockChosen: boolean; onPick: (member: string) => void;
  onClose?: () => void;
}) {
  useOverlay(Boolean(onClose), () => onClose?.());
  return (
    <div className="member-picker" data-testid="member-picker" role="group" aria-label="Members">
      {config.providers.map((provider) => (
        <div key={provider.id} className="picker-section">
          {[provider.id, ...provider.models.map((model) => `${provider.id}/${model.id}`)].map((member) => {
            const checked = chosen.includes(member);
            return (
              <button key={member} type="button" role="checkbox" className="picker-item" data-member={member}
                aria-checked={checked} disabled={lockChosen && checked} onClick={() => onPick(member)}>
                {memberLabel(config, member)}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** @brief 新分组 id 的错误（§4.1：与提供商、分组 id 共用名字空间，含保留 id）；没有时为 null。 */
function idError(id: string, config: ModelConfig, reserved: readonly string[]): string | null {
  if (!ID_PATTERN.test(id)) return 'Use lowercase letters, digits, and hyphens.';
  if (reserved.includes(id)) return `${id} is reserved.`;
  const taken = config.providers.some((item) => item.id === id) || config.groups.some((item) => item.id === id);
  return taken ? `${id} is already used by a provider or group.` : null;
}

/** @brief 成员的读屏名（柄的“Reorder <名字>”与播报）：“ · ”换成“, ”，读屏不念分隔符（ui-strings 写法约定）。 */
const spokenMember = (config: ModelConfig, member: string): string => memberLabel(config, member).replace(' · ', ', ');

/** @brief 一个分组的成员行：拖动柄、成员的写法、Remove。 */
function MemberRow({ config, list, members, index, onSave }: {
  config: ModelConfig; list: ReorderList; members: string[]; index: number; onSave: (members: string[]) => void;
}) {
  const member = members[index];
  const drop = useReorderRow(list, index);
  return (
    <li className="group-member" data-testid="group-member" data-member={member} {...drop}>
      <ReorderHandle list={list} index={index} />
      <span>{memberLabel(config, member)}</span>
      <span className="row-actions">
        <button className="button compact" data-action="member-remove" disabled={list.busy || members.length === 1}
          onClick={() => onSave(members.filter((item) => item !== member))}>Remove</button>
      </span>
    </li>
  );
}

/** @brief 一个分组：成员的每次改动（加入、去掉、拖动排序）立即保存；失败时原文，列表回到保存前。 */
function GroupRow({ config, group }: { config: ModelConfig; group: ModelGroup }) {
  const { pending, busy, error, save } = useImmediateSave<string[]>();
  const [picking, setPicking] = useState(false);
  const flow = useDeleteFlow((dryRun) => ({ type: 'models.deleteGroup', id: group.id, dryRun }));
  const members = pending?.value ?? group.members;
  const saveMembers = (next: string[]) => save(next, { type: 'models.saveGroup', id: group.id, members: next,
    creating: false });
  const list: ReorderList = { id: `members:${group.id}`, labels: members.map((item) => spokenMember(config, item)),
    busy, move: (from, to) => saveMembers(movedItems(members, from, to)) };
  return (
    <li className="group-row" data-testid="group-row" data-group={group.id}>
      <div className="row-line">
        <span className="group-id">{group.id}</span>
        <span className="row-actions">
          <button className="button compact" data-action="add-member" disabled={busy}
            onClick={() => setPicking(!picking)} aria-expanded={picking}>Add member</button>
          <button className="button compact danger" data-action="delete-group" onClick={() => void flow.start()}>
            Delete…</button>
        </span>
      </div>
      <ol className="member-list">
        {members.map((member, index) => <MemberRow key={member} config={config} list={list} members={members}
          index={index} onSave={(next) => void saveMembers(next)} />)}
      </ol>
      <ReorderStatus list={list} />
      {members.length === 1 && (
        <p className="field-hint">A group needs at least one member; delete the group instead.</p>
      )}
      {picking && <MemberPicker config={config} chosen={members} lockChosen onClose={() => setPicking(false)}
        onPick={(member) => { setPicking(false); void saveMembers([...members, member]); }} />}
      {error && <p className="form-message error" role="alert">{error}</p>}
      <DeleteDialog flow={flow} kind="delete-group" title={`Delete group ${group.id}?`} />
    </li>
  );
}

/** @brief New group 的内联表单：id 合规且至少选了一个成员时 Create 可用。 */
function GroupForm({ config, reserved, onClose }: {
  config: ModelConfig; reserved: readonly string[]; onClose: () => void;
}) {
  const [id, setId] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = idError(id, config, reserved);
  async function create() {
    setBusy(true);
    const result = await writeModels({ type: 'models.saveGroup', id, members, creating: true });
    setBusy(false);
    if (result.error === null) onClose();
    else setError(result.error);
  }
  const toggle = (member: string) => setMembers(members.includes(member)
    ? members.filter((item) => item !== member) : [...members, member]);
  return (
    <form className="group-form" data-testid="group-form" noValidate
      onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>Group ID
        <input value={id} spellCheck={false} onChange={(event) => setId(event.target.value)}
          aria-invalid={Boolean(id && problem)} />
      </label>
      {id && problem && <p className="field-error" data-testid="group-error" role="alert">{problem}</p>}
      <MemberPicker config={config} chosen={members} lockChosen={false} onPick={toggle} />
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={busy || problem !== null || members.length === 0}>
          Create</button>
        <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </form>
  );
}

/** @brief Groups 一节。 */
export function Groups({ config, reserved }: { config: ModelConfig; reserved: readonly string[] }) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="models-block" data-testid="groups">
      <h3>Groups</h3>
      {config.groups.length === 0 && (
        <p className="settings-empty" data-testid="groups-empty">
          No groups. A group lists the models to try, in order.</p>
      )}
      <ul className="row-list">
        {config.groups.map((group) => <GroupRow key={group.id} config={config} group={group} />)}
      </ul>
      {creating ? <GroupForm config={config} reserved={reserved} onClose={() => setCreating(false)} /> : (
        <button className="button" data-action="new-group" onClick={() => setCreating(true)}>New group</button>
      )}
    </section>
  );
}
