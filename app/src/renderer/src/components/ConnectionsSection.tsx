// 设置页的"Connections and models"（docs/v0/screens/settings.md）：列表，或添加连接、编辑连接、添加 / 编辑模型的表单。

import { useEffect, useRef, type ReactNode } from 'react';
import type { ConfigInfo } from '../../../shared/protocol';
import { connectionFor, SAVED_NOTICE, showView, useSettings, type ConnectionsView } from '../state/settings';
import { useApp } from '../state/store';
import { ConnectionForm } from './ConnectionForm';
import { ConnectionsList } from './ConnectionsList';
import { ModelForm } from './ModelForm';

/** 回到列表时上方的一行：添加连接之后 */
const ADDED_NOTICE = { tone: 'ok', text: 'Saved' } as const;

/** "Add connection"表单的说明 */
const ADD_HINT = 'Enter the base URL, API key, and model ID. '
  + 'When you save, the new connection is added at the end of the list.';

/** @brief 一张表单和它的标题、说明；打开时焦点放到第一个输入框（autoFocus 为假时不动，例如"Go to settings"放到 API key）。 */
function FormPanel({ title, hint, autoFocus, children }: {
  title: string; hint: string; autoFocus: boolean; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) panel.current?.querySelector<HTMLElement>('input:not([readonly]), select')?.focus();
  }, [autoFocus]);
  return (
    <div className="settings-form" ref={panel}>
      <h3>{title}</h3>
      <p className="field-hint">{hint}</p>
      {children}
    </div>
  );
}

/** @brief 编辑连接：只改连接，不含模型字段；保存后留在表单里（可以接着测试），回到列表时上方说明已经打开的会话怎样。 */
function EditConnection({ config, view }: { config: ConfigInfo; view: Extract<ConnectionsView, { kind: 'edit' }> }) {
  const connection = connectionFor(config, view.providerId);
  if (!connection) return <ConnectionsList config={config} />;
  const count = connection.models.length;
  const hint = count === 1 ? `${count} model in this connection uses this base URL and key`
    : `All ${count} models in this connection use this base URL and key`;
  return (
    <FormPanel title={`Edit connection · ${connection.endpoint.name}`} hint={hint} autoFocus={view.focusKey === 0}>
      <ConnectionForm key={connection.providerId} mode="endpoint" providerId={connection.providerId}
        focusKey={view.focusKey}
        onClose={(saved) => showView({ kind: 'list' }, saved ? { tone: 'ok', text: SAVED_NOTICE } : null)} />
    </FormPanel>
  );
}

/** @brief 添加或编辑模型；连接已经不在时回到列表。 */
function EditModel({ config, view }: { config: ConfigInfo; view: Extract<ConnectionsView, { kind: 'model' }> }) {
  const connection = connectionFor(config, view.providerId);
  if (!connection) return <ConnectionsList config={config} />;
  const model = view.modelId === null ? undefined : connection.models.find((item) => item.id === view.modelId);
  return (
    <FormPanel title={`${model ? 'Edit model' : 'Add model'} · ${connection.endpoint.name}`}
      hint="Uses this connection’s base URL and key. You don’t need to enter the key again." autoFocus>
      <ModelForm key={`${view.providerId}/${view.modelId ?? ''}`} connection={connection} model={model} />
    </FormPanel>
  );
}

/** @brief 当前显示的列表或表单。 */
function SectionContent({ config, view }: { config: ConfigInfo; view: ConnectionsView }) {
  switch (view.kind) {
    case 'list':
      return <ConnectionsList config={config} />;
    case 'add':
      return (
        <FormPanel title="Add connection" hint={ADD_HINT} autoFocus>
          <ConnectionForm mode="full" providerId={null} onSaved={() => showView({ kind: 'list' }, ADDED_NOTICE)}
            onClose={(saved) => showView({ kind: 'list' }, saved ? ADDED_NOTICE : null)} />
        </FormPanel>
      );
    case 'edit':
      return <EditConnection config={config} view={view} />;
    case 'model':
      return <EditModel config={config} view={view} />;
  }
}

/**
 * @brief 上方要显示的错误原文：config.get 报错时只有它；显示列表时还有 pi 读 models.json 和 settings.json 的错误
 *        （表单里保存的结果自己带着原文）。
 */
function sectionErrors(readError: string | null, config: ConfigInfo | null, view: ConnectionsView): string[] {
  if (readError) return [readError];
  if (!config || view.kind !== 'list') return [];
  return [config.modelsError, config.settingsError].filter((item): item is string => Boolean(item));
}

/**
 * @brief "Connections and models"一节：读取中、读取失败（config.get 报错时只显示原文；pi 读 models.json、settings.json 的错误
 *        显示在列表上方，列表照常显示）、列表或表单。
 */
export function ConnectionsSection() {
  const config = useApp((state) => state.config);
  const view = useSettings((state) => state.view);
  const readError = useSettings((state) => state.readError);
  const errors = sectionErrors(readError, config, view);
  return (
    <div className="settings-section" data-section="connections">
      <h2>Connections and models</h2>
      <p className="muted">Each connection is a base URL with its key, and it can have several models.</p>
      {!config && <p className="muted" role="status">Loading…</p>}
      {errors.length > 0 && (
        <div className="settings-error" role="alert">
          {errors.map((text, index) => <p key={index} className="form-message error">{text}</p>)}
          <p className="muted">Fix the file, then reopen Settings.</p>
        </div>
      )}
      {config && !readError && <SectionContent config={config} view={view} />}
    </div>
  );
}
