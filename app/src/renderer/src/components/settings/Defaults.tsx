// Defaults：新会话的默认范围，改了立即保存（models.setDefaults，§9.1）。
// 状态表见 docs/v1/screens/models-settings.md "Defaults"。

import { useId } from 'react';
import type { ModelConfig, ModelPick } from '../../../../shared/models';
import { useImmediateSave } from './common';

/** @brief 默认范围下拉：None 在第一项，再按 Groups、Providers、Models 三节（同范围菜单）。 */
function PickSelect({ config, value, busy, onChange }: {
  config: ModelConfig; value: ModelPick | null; busy: boolean; onChange: (pick: ModelPick | null) => void;
}) {
  const id = useId();
  return (
    <div className="mf-row">
      <label htmlFor={id}>Default model range for new sessions</label>
      <select id={id} className="mf-control" data-testid="default-pick" value={value ?? ''} disabled={busy}
        onChange={(event) => onChange(event.target.value || null)}>
        <option value="">None</option>
        {config.groups.length > 0 && (
          <optgroup label="Groups">
            {config.groups.map((group) => <option key={group.id} value={group.id}>{group.id}</option>)}
          </optgroup>
        )}
        {config.providers.length > 0 && (
          <optgroup label="Providers">
            {config.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </optgroup>
        )}
        {config.providers.length > 0 && (
          <optgroup label="Models">
            {config.providers.flatMap((item) => item.models.map((model) => (
              <option key={`${item.id}/${model.id}`} value={`${item.id}/${model.id}`}>{item.name} · {model.id}</option>
            )))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

/** @brief Defaults 一节。 */
export function Defaults({ config }: { config: ModelConfig }) {
  const { pending, busy, error, save } = useImmediateSave<ModelPick | null>();
  const value = pending ? pending.value : config.normalDefault;
  function change(normalDefault: ModelPick | null) {
    void save(normalDefault, { type: 'models.setDefaults', normalDefault });
  }
  return (
    <section className="models-block" data-testid="defaults">
      <h3>Defaults</h3>
      <div className="mf-grid">
        <PickSelect config={config} value={value} busy={busy} onChange={change} />
      </div>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </section>
  );
}
