// 设置 → Models（规格 §9.1）：从上到下迁移说明 → Defaults → Providers → Groups（2026-10-26 起没有区域未确认与
// Project access，负责人走查 M3）。
// 配置读不出时只显示这条错误和 Reload。进入时按 openModelsSettings 的落点滚动并放好焦点。
// 状态表见 docs/v1/screens/models-settings.md。

import { useEffect, useRef } from 'react';
import type { ModelsInfo } from '../../../../shared/models';
import { useApp } from '../../state/store';
import { clearTarget, loadModels, useSettings, type ModelsTarget } from '../../state/settings';
import { Defaults } from './Defaults';
import { Groups } from './Groups';
import { MigrationNotice } from './Notices';
import { Providers } from './Providers';
import '../../styles/models-settings.css';

/** @brief 落点对应的元素与要放焦点的元素；找不到时为 null。 */
function locate(root: HTMLElement, target: ModelsTarget): { scroll: HTMLElement; focus: HTMLElement } | null {
  const card = target.providerId
    ? root.querySelector<HTMLElement>(`[data-testid="provider-card"][data-provider="${CSS.escape(target.providerId)}"]`)
    : null;
  if (!card) return null;
  const keys = card.querySelector<HTMLElement>('[data-testid="key-row"] button, [data-action="add-key"]');
  return { scroll: card, focus: target.focus === 'keys' && keys ? keys : card };
}

/**
 * @brief 处理落点：这次打开发起的读取读到数据后（target.loaded）滚到目标并放好焦点；没有落点时停在顶部。
 *        之前缓存的数据里可能还没有新的提供商，不按它找。
 */
function useTarget(root: React.RefObject<HTMLDivElement | null>, info: ModelsInfo | null): void {
  const target = useSettings((state) => state.target);
  useEffect(() => {
    if (!target || !target.loaded || !info || !root.current) return;
    const found = locate(root.current, target);
    if (found) {
      found.scroll.scrollIntoView({ block: 'start' });
      found.focus.focus({ preventScroll: true });
    } else {
      root.current.closest('.settings-body')?.scrollTo({ top: 0 });
    }
    clearTarget(target.nonce);
  }, [target, info, root]);
}

/** @brief 配置读不出：只显示错误和 Reload。 */
function LoadError({ error }: { error: string }) {
  return (
    <div className="settings-error" data-testid="models-load-error">
      <p className="form-message error" role="alert">Couldn’t read model settings: {error}</p>
      <button className="button" data-action="reload" onClick={() => void loadModels('models.reload')}>Retry</button>
    </div>
  );
}

/** @brief Models 分节。 */
export function ModelsSection() {
  const { info, loading, readError, configReadError } = useSettings();
  const settingsError = useApp((state) => state.config?.settingsError ?? null);
  const root = useRef<HTMLDivElement>(null);
  useTarget(root, info);
  const top = (configReadError || settingsError) && (
    <p className="form-message error settings-error" role="alert">{configReadError ?? settingsError}</p>
  );
  if (loading || (!info && !readError)) return <p className="muted" data-testid="models-loading">Loading…</p>;
  if (info?.loadError) return <div className="settings-section">{top}<LoadError error={info.loadError} /></div>;
  if (!info?.config || readError) {
    return <div className="settings-section">{top}<p className="form-message error" role="alert">{readError}</p></div>;
  }
  const { config } = info;
  return (
    <div ref={root} className="settings-section models-section" data-testid="models-section">
      <h2>Models</h2>
      {top}
      {info.migration && <MigrationNotice notice={info.migration} config={config} />}
      <Defaults config={config} />
      <Providers providers={config.providers} />
      <Groups config={config} reserved={info.reserved} />
    </div>
  );
}
