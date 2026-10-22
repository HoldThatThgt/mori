// Groups：每个分组一行，有序的成员可以加入、去掉、上移、下移，每次改动立即保存（models.saveGroup，§9.1）；
// New group 内联表单；Delete 先确认。状态表见 docs/v1/screens/models-settings.md "Groups"。

import { useState } from 'react';
import { ID_PATTERN, type ModelConfig, type ModelGroup } from '../../../../shared/models';
import { useOverlay } from '../../state/overlays';
import { writeModels } from '../../state/settings';
import { DeleteDialog, MoveButtons, useDeleteFlow, useImmediateSave } from './common';

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

/** @brief 一个分组的成员行。 */
function MemberRow({ config, members, index, busy, onSave }: {
  config: ModelConfig; members: string[]; index: number; busy: boolean; onSave: (members: string[]) => void;
}) {
  const member = members[index];
  function move(delta: -1 | 1) {
    const next = [...members];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onSave(next);
  }
  return (
    <li className="group-member" data-testid="group-member" data-member={member}>
      <span>{memberLabel(config, member)}</span>
      <span className="row-actions">
        <MoveButtons index={index} count={members.length} busy={busy} actions={['member-up', 'member-down']}
          onMove={move} />
        <button className="button compact" data-action="member-remove" disabled={busy || members.length === 1}
          onClick={() => onSave(members.filter((item) => item !== member))}>Remove</button>
      </span>
    </li>
  );
}

/** @brief 一个分组：成员的每次改动立即保存；失败时原文，列表回到保存前。 */
function GroupRow({ config, group }: { config: ModelConfig; group: ModelGroup }) {
  const { pending, busy, error, save } = useImmediateSave<string[]>();
  const [picking, setPicking] = useState(false);
  const flow = useDeleteFlow((dryRun) => ({ type: 'models.deleteGroup', id: group.id, dryRun }));
  const members = pending?.value ?? group.members;
  const saveMembers = (next: string[]) => void save(next, { type: 'models.saveGroup', id: group.id, members: next,
    creating: false });
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
        {members.map((member, index) => <MemberRow key={member} config={config} members={members} index={index}
          busy={busy} onSave={saveMembers} />)}
      </ol>
      {members.length === 1 && (
        <p className="field-hint">A group needs at least one member; delete the group instead.</p>
      )}
      {picking && <MemberPicker config={config} chosen={members} lockChosen onClose={() => setPicking(false)}
        onPick={(member) => { setPicking(false); saveMembers([...members, member]); }} />}
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
