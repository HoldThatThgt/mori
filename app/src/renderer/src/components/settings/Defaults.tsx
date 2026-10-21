// Defaults：新会话的默认范围与所有项目默认允许的区域，改了立即保存（models.setDefaults，§9.1）。
// 状态表见 docs/v1/screens/models-settings.md "Defaults"。

import { useId } from 'react';
import { DEFAULT_ZONES, type ModelConfig, type ModelPick } from '../../../../shared/models';
import { useImmediateSave, ZONE_LABELS } from './common';

/** @brief 保存的两项。 */
interface DefaultsValue {
  /** 默认范围 */
  normalDefault: ModelPick | null;
  /** 所有项目默认允许的区域 */
  allowedZones: ('local' | 'intranet')[];
}

/** @brief 默认范围下拉：None 在第一项，再按 Groups、Providers、Models 三节（同顶栏菜单）。 */
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
  const { pending, busy, error, save } = useImmediateSave<DefaultsValue>();
  const value: DefaultsValue = pending?.value ?? { normalDefault: config.normalDefault,
    allowedZones: config.allowedZones };
  function change(next: DefaultsValue) {
    void save(next, { type: 'models.setDefaults', ...next });
  }
  function toggle(zone: 'local' | 'intranet', on: boolean) {
    const zones = DEFAULT_ZONES.filter((item) => (item === zone ? on : value.allowedZones.includes(item)));
    change({ ...value, allowedZones: zones });
  }
  return (
    <section className="models-block" data-testid="defaults">
      <h3>Defaults</h3>
      <div className="mf-grid">
        <PickSelect config={config} value={value.normalDefault} busy={busy}
          onChange={(normalDefault) => change({ ...value, normalDefault })} />
        <fieldset className="mf-row">
          <legend>Allowed zones for all projects</legend>
          <div className="mf-control">
            <div className="radio-line">
              {DEFAULT_ZONES.map((zone) => (
                <label key={zone} className="check-row">
                  <input type="checkbox" data-testid="allowed-zone" data-zone={zone} disabled={busy}
                    checked={value.allowedZones.includes(zone)}
                    onChange={(event) => toggle(zone, event.target.checked)} />
                  <span>{ZONE_LABELS[zone]}</span>
                </label>
              ))}
            </div>
            <p className="field-hint">Public providers can only be allowed per project, below.</p>
          </div>
        </fieldset>
      </div>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </section>
  );
}
