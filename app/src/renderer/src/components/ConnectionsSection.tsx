// 设置页的"连接与模型"（docs/v0/screens/settings.md）：列表，或添加连接、编辑连接、添加 / 编辑模型的表单。

import { useEffect, useRef, type ReactNode } from 'react';
import type { ConfigInfo } from '../../../shared/protocol';
import { connectionFor, SAVED_NOTICE, showView, useSettings, type ConnectionsView } from '../state/settings';
import { useApp } from '../state/store';
import { ConnectionForm } from './ConnectionForm';
import { ConnectionsList } from './ConnectionsList';
import { ModelForm } from './ModelForm';

/** 回到列表时上方的一行：添加连接之后 */
const ADDED_NOTICE = { tone: 'ok', text: '已保存' } as const;

/** @brief 一张表单和它的标题、说明；打开时焦点放到第一个输入框（autoFocus 为假时不动，例如"去设置"放到 API key）。 */
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
  return (
    <FormPanel title={`编辑连接 · ${connection.endpoint.name}`} hint={`这个连接下的 ${count} 个模型都用这里的地址和 key`}
      autoFocus={view.focusKey === 0}>
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
    <FormPanel title={`${model ? '编辑模型' : '添加模型'} · ${connection.endpoint.name}`}
      hint="用这个连接的地址和 key，不用再填 key" autoFocus>
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
        <FormPanel title="添加连接" hint="填好服务地址、API key 和模型 ID；保存后新连接排在最后。" autoFocus>
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
 * @brief "连接与模型"一节：读取中、读取失败（config.get 报错时只显示原文；pi 读 models.json 的错误显示在列表上方，
 *        列表照常显示，表单里保存的结果自己带着原文）、列表或表单。
 */
export function ConnectionsSection() {
  const config = useApp((state) => state.config);
  const view = useSettings((state) => state.view);
  const readError = useSettings((state) => state.readError);
  const error = readError ?? (view.kind === 'list' ? config?.modelsError ?? null : null);
  return (
    <div className="settings-section" data-section="connections">
      <h2>连接与模型</h2>
      <p className="muted">每个连接是一个服务地址和它的 key，下面可以有多个模型。</p>
      {!config && <p className="muted" role="status">正在读取…</p>}
      {error && (
        <div className="settings-error" role="alert">
          <p className="form-message error">{error}</p>
          <p className="muted">修好文件后重新打开设置页。</p>
        </div>
      )}
      {config && !readError && <SectionContent config={config} view={view} />}
    </div>
  );
}
