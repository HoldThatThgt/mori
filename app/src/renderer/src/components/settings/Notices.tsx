// Models 分节顶部：迁移说明（§4.5）。状态表见 docs/v1/screens/models-settings.md "迁移说明"。

import { useState } from 'react';
import type { MigrationNotice as Notice, ModelConfig } from '../../../../shared/models';
import { writeModels } from '../../state/settings';

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
