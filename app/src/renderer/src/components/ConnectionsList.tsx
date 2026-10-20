// "连接与模型"的列表（docs/v0/screens/settings.md）：每个连接一张卡，卡里每个模型一行；设为默认、测试、编辑、删除。

import { useState } from 'react';
import { THINKING_LABELS, type ConfigInfo, type ConnectionInfo, type ModelInfo } from '../../../shared/protocol';
import { Icon } from '../icons';
import { describe } from '../state/bridge';
import {
  cancelTest, connectionsOf, deleteModel, setDefaultModel, showView, testModel, useSettings,
} from '../state/settings';
import { ConfirmDialog } from './ConfirmDialog';
import { apiLabels } from './ConnectionForm';

/** @brief 要删除的模型和它所在的连接。 */
interface DeleteTarget {
  /** 所在的连接 */
  connection: ConnectionInfo;
  /** 模型 */
  model: ModelInfo;
}

/** @brief 一行模型的思考设置。 */
function thinkingText(model: ModelInfo): string {
  return model.reasoning ? `支持思考 · 新会话默认 ${THINKING_LABELS[model.thinkingLevel]}` : '不支持思考';
}

/**
 * @brief 不能删除的原因；能删时为 null。
 * @param total 全部连接下模型的个数
 */
function deleteBlock(isDefault: boolean, total: number): string | null {
  if (total <= 1) return '至少要留一个模型';
  return isDefault ? '默认模型不能删除，先把别的模型设为默认' : null;
}

/** @brief 模型行的按钮：设为默认（不是默认时）、测试（测试中可以取消）、编辑、删除。 */
function ModelActions({ connection, model, isDefault, total, onDelete }: {
  connection: ConnectionInfo; model: ModelInfo; isDefault: boolean; total: number; onDelete: () => void;
}) {
  const ref = `${connection.providerId}/${model.id}`;
  const testing = useSettings((state) => state.testing);
  const blocked = deleteBlock(isDefault, total);
  const { providerId } = connection;
  return (
    <div className="model-actions">
      {!isDefault && (
        <button className="button compact" onClick={() => void setDefaultModel(providerId, model.id)}>设为默认</button>
      )}
      {testing === ref ? (
        <>
          <button className="button compact" disabled>测试中…</button>
          <button className="button compact" onClick={cancelTest}>取消</button>
        </>
      ) : (
        <button className="button compact" disabled={testing !== null}
          onClick={() => void testModel(providerId, model.id)}>测试</button>
      )}
      <button className="button compact" onClick={() => showView({ kind: 'model', providerId, modelId: model.id })}>
        编辑</button>
      <button className="button compact danger" disabled={blocked !== null} title={blocked ?? undefined}
        onClick={onDelete}>删除</button>
    </div>
  );
}

/** @brief 一行模型：ID、"默认"、上下文长度、思考；下面是测试结果。 */
function ModelRow({ connection, model, defaultModel, total, onDelete }: {
  connection: ConnectionInfo; model: ModelInfo; defaultModel: string | null; total: number; onDelete: () => void;
}) {
  const ref = `${connection.providerId}/${model.id}`;
  const isDefault = ref === defaultModel;
  const result = useSettings((state) => state.tests[ref]);
  return (
    <li className="model-row" data-testid="model-row" data-model={ref} data-default={isDefault ? 'true' : undefined}>
      <div className="model-line">
        <div className="model-info">
          <span className="model-id">{model.id}</span>
          {isDefault && <span className="default-badge">默认</span>}
          <span className="model-meta">上下文 {model.contextWindow.toLocaleString('en-US')} · {thinkingText(model)}</span>
        </div>
        <ModelActions connection={connection} model={model} isDefault={isDefault} total={total} onDelete={onDelete} />
      </div>
      {result && (
        <p className={`form-message ${result.tone}`} role="status" data-testid="model-test">{result.text}</p>
      )}
    </li>
  );
}

/** @brief 一个连接：名称、服务地址、接口类型、key 状态；编辑连接、添加模型；下面每个模型一行。 */
function ConnectionCard({ connection, defaultModel, total, onDelete }: {
  connection: ConnectionInfo; defaultModel: string | null; total: number; onDelete: (target: DeleteTarget) => void;
}) {
  const { providerId, endpoint, keySaved, models } = connection;
  return (
    <section className="connection-card" data-testid="connection-card" data-provider={providerId}
      aria-label={endpoint.name}>
      <header className="connection-head">
        <div className="connection-info">
          <span className="connection-name">{endpoint.name}</span>
          <span className="connection-meta">{endpoint.baseUrl} · {apiLabels[endpoint.api]}</span>
          <span className={`connection-key${keySaved ? '' : ' missing'}`}>{keySaved ? 'key 已加密保存' : '没有 key'}</span>
        </div>
        <div className="model-actions">
          <button className="button compact" onClick={() => showView({ kind: 'edit', providerId, focusKey: 0 })}>
            编辑连接</button>
          <button className="button compact" onClick={() => showView({ kind: 'model', providerId, modelId: null })}>
            <Icon name="plus" />添加模型</button>
        </div>
      </header>
      <ul className="model-list">
        {models.map((model) => (
          <ModelRow key={model.id} connection={connection} model={model} defaultModel={defaultModel} total={total}
            onDelete={() => onDelete({ connection, model })} />
        ))}
      </ul>
    </section>
  );
}

/** @brief 删除确认：焦点先在"取消"；是连接的最后一个模型时说明连接和 key 一起删除。失败时显示原文。 */
function DeleteModelDialog({ target, onClose }: { target: DeleteTarget; onClose: () => void }) {
  const { connection, model } = target;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = connection.endpoint.name;
  const text = connection.models.length === 1 ? `连接 ${name} 也会删除，它的 key 一起删除。`
    : `从连接 ${name} 里删除这个模型。`;
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteModel(connection, model.id);
      onClose();
    } catch (failure) {
      setError(`删除失败：${describe('model.delete', failure)}`);
      setBusy(false);
    }
  }
  return (
    <ConfirmDialog title={`删除模型 ${model.id}？`} text={text} confirmLabel="删除" tone="danger" testId="delete-dialog"
      busyText={busy ? '正在删除…' : null} error={error} onConfirm={() => void confirm()} onCancel={onClose} />
  );
}

/** @brief 列表：上方一行结果，连接卡，底部"添加连接"。 */
export function ConnectionsList({ config }: { config: ConfigInfo }) {
  const notice = useSettings((state) => state.notice);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const connections = connectionsOf(config);
  const total = connections.reduce((sum, item) => sum + item.models.length, 0);
  return (
    <>
      {notice && (
        <p className={`form-message ${notice.tone}`} role="status" data-testid="settings-notice">{notice.text}</p>
      )}
      {connections.length === 0 && <p className="settings-empty">还没有模型</p>}
      {connections.map((connection) => (
        <ConnectionCard key={connection.providerId} connection={connection} defaultModel={config.defaultModel ?? null}
          total={total} onDelete={setDeleting} />
      ))}
      <div className="form-actions">
        <button className="button" onClick={() => showView({ kind: 'add' })}><Icon name="plus" />添加连接</button>
      </div>
      {deleting && <DeleteModelDialog target={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}
