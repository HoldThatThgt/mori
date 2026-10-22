// Project access：已知项目各一行，本机为项目在 allowedZones 之外额外授权的区域；勾选立即保存
// （models.setProjectZones），勾 Public 先确认（§4.3、§9.1）。状态表见 docs/v1/screens/models-settings.md "Project access"。

import { useState } from 'react';
import { ZONES, type ModelConfig, type ProjectAccess as Project, type Zone } from '../../../../shared/models';
import { ModelDialog, useImmediateSave, ZONE_LABELS } from './common';

/** @brief 这个项目允许的区域：(allowedZones ∪ zones) 再与 projectZones（不为 null 时）取交集（§4.3）。 */
function allowedOf(config: ModelConfig, zones: readonly Zone[], projectZones: Zone[] | null): Zone[] {
  return ZONES.filter((zone) => ((config.allowedZones as readonly Zone[]).includes(zone) || zones.includes(zone))
    && (projectZones === null || projectZones.includes(zone)));
}

/** @brief 加上一个区域，按 local、intranet、public 的顺序。 */
function withZone(zones: readonly Zone[], zone: Zone): Zone[] {
  return ZONES.filter((item) => item === zone || zones.includes(item));
}

/** @brief 一个项目一行。 */
function ProjectRow({ config, project }: { config: ModelConfig; project: Project }) {
  const { pending, busy, error, save } = useImmediateSave<Zone[]>();
  const [asking, setAsking] = useState(false);
  const zones = pending?.value ?? project.zones;
  const extra = ZONES.filter((zone) => !(config.allowedZones as readonly Zone[]).includes(zone));
  const allowed = allowedOf(config, zones, project.projectZones);
  const write = (next: Zone[]) => save(next, { type: 'models.setProjectZones', path: project.path, zones: next });
  function toggle(zone: Zone, on: boolean) {
    if (on && zone === 'public') return setAsking(true);
    void write(on ? withZone(zones, zone) : zones.filter((item) => item !== zone));
  }
  const publicNames = config.providers.filter((item) => item.zone === 'public').map((item) => item.name).join(', ');
  return (
    <li className="project-row" data-testid="project-row" data-path={project.path}>
      <span className="project-path">{project.path}</span>
      <span className="muted">
        Allowed: {allowed.length ? allowed.map((zone) => ZONE_LABELS[zone]).join(' · ') : 'None'}</span>
      {project.projectConfig !== null && (
        <p className="form-message error" data-testid="project-config-error">
          .mori/models.json: {project.projectConfig}</p>
      )}
      <div className="radio-line">
        {extra.map((zone) => {
          const excluded = project.projectZones !== null && !project.projectZones.includes(zone);
          return (
            <span key={zone} className="zone-check">
              <label className="check-row">
                <input type="checkbox" data-testid="project-zone" data-zone={zone} disabled={busy || excluded}
                  checked={zones.includes(zone)} onChange={(event) => toggle(zone, event.target.checked)} />
                <span>{ZONE_LABELS[zone]}</span>
              </label>
              {excluded && <span className="field-hint">.mori/models.json in this project doesn’t allow {zone}.</span>}
            </span>
          );
        })}
      </div>
      {error && <p className="form-message error" role="alert">{error}</p>}
      {asking && (
        <ModelDialog testId="public-dialog" title="Allow public providers for this project?" confirmLabel="Allow"
          tone="primary" busy={busy} error={null} onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); void write(withZone(zones, 'public')); }}>
          <p>Code and files from {project.path} may be sent to: {publicNames}.</p>
        </ModelDialog>
      )}
    </li>
  );
}

/** @brief Project access 一节。 */
export function ProjectAccess({ config, projects }: { config: ModelConfig; projects: Project[] }) {
  return (
    <section className="models-block" data-testid="project-access">
      <h3>Project access</h3>
      {projects.length === 0 && (
        <p className="settings-empty" data-testid="projects-empty">No projects yet. Open a folder to add one.</p>
      )}
      <ul className="row-list">
        {projects.map((project) => <ProjectRow key={project.path} config={config} project={project} />)}
      </ul>
    </section>
  );
}
