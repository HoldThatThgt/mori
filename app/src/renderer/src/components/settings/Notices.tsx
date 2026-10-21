// Models 分节顶部：迁移说明（§4.5）与区域未确认的提供商（§4.1、§9.1 "Confirm zone…"）。
// 状态表见 docs/v1/screens/models-settings.md "迁移说明""区域未确认"。

import { useState } from 'react';
import { suggestZone, type MigrationNotice as Notice, type ModelConfig, type ModelProvider, type Zone } from
  '../../../../shared/models';
import { writeModels } from '../../state/settings';
import { ModelDialog } from './common';
import { ZoneRadios } from './fields';

/** @brief 提供商 id 的显示名：配置里的名称，其次迁移说明里的名称，都没有时是 id。 */
function nameOf(id: string, config: ModelConfig, notice: Notice): string {
  return config.providers.find((item) => item.id === id)?.name
    ?? notice.providers.find((item) => item.id === id)?.name ?? id;
}

/** @brief 迁移说明的各行（没有内容的行不显示）。 */
function migrationLines(notice: Notice, config: ModelConfig): string[] {
  const names = (ids: string[]) => ids.map((id) => nameOf(id, config, notice)).join(', ');
  return [
    notice.providers.length ? `Imported: ${notice.providers.map((item) => item.name).join(', ')}` : '',
    ...notice.providers.filter((item) => item.from !== item.id)
      .map((item) => `Renamed provider ${item.from} to ${item.id}`),
    ...notice.dropped.map((item) => `Dropped ${item.subject}: ${item.reason}`),
    notice.reenterKeys.length ? `Add the API key again for: ${names(notice.reenterKeys)}` : '',
    notice.keptCiphertext.length
      ? `Kept the saved key for: ${names(notice.keptCiphertext)}; the key written in models.json was ignored.` : '',
  ].filter(Boolean);
}

/** @brief 迁移说明：一直显示到你点 Dismiss（models.dismissMigration）。 */
export function MigrationNotice({ notice, config }: { notice: Notice; config: ModelConfig }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function dismiss() {
    setBusy(true);
    const result = await writeModels({ type: 'models.dismissMigration' });
    setBusy(false);
    setError(result.error);
  }
  return (
    <section className="models-notice" data-testid="migration-notice">
      <h3>Imported your model settings from models.json</h3>
      <ul>{migrationLines(notice, config).map((line) => <li key={line}>{line}</li>)}</ul>
      <button className="button compact" data-action="dismiss" disabled={busy} onClick={() => void dismiss()}>
        Dismiss
      </button>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </section>
  );
}

/** @brief 确认区域的对话框：预选建议值；失败时原文留在框里。 */
function ZoneDialog({ provider, suggested, onClose }: {
  provider: ModelProvider; suggested: Zone; onClose: () => void;
}) {
  const [zone, setZone] = useState<Zone>(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    const result = await writeModels({ type: 'models.confirmZone', providerId: provider.id, zone });
    setBusy(false);
    if (result.error === null) onClose();
    else setError(result.error);
  }
  return (
    <ModelDialog testId="zone-dialog" title="Confirm network zone" confirmLabel="Confirm" tone="primary" busy={busy}
      error={error} focus="checked" onConfirm={() => void confirm()} onCancel={onClose}>
      <p>{provider.name}</p>
      <p className="dialog-path">{provider.baseUrl}</p>
      <form className="mf-grid" onSubmit={(event) => event.preventDefault()}>
        <ZoneRadios value={zone} onChange={setZone} />
      </form>
    </ModelDialog>
  );
}

/** @brief 区域未确认的提供商：每个一行"<name> · <address>"与"Confirm zone…"。没有时不显示。 */
export function UnconfirmedZones({ providers, suggestions }: {
  providers: ModelProvider[]; suggestions: Record<string, Zone>;
}) {
  const [open, setOpen] = useState<ModelProvider | null>(null);
  const pending = providers.filter((provider) => provider.zone === null);
  if (pending.length === 0) return null;
  return (
    <section className="models-notice zones-unconfirmed" data-testid="zones-unconfirmed">
      <p>Confirm the network zone of these providers. Sessions don't use them until you do.</p>
      <ul>
        {pending.map((provider) => (
          <li key={provider.id} data-testid="zone-unconfirmed" data-provider={provider.id}>
            <span>{provider.name} · {provider.baseUrl}</span>
            <button className="button compact" data-action="confirm-zone" onClick={() => setOpen(provider)}>
              Confirm zone…
            </button>
          </li>
        ))}
      </ul>
      {open && <ZoneDialog provider={open} onClose={() => setOpen(null)}
        suggested={suggestions[open.id] ?? suggestZone(open.baseUrl)} />}
    </section>
  );
}
