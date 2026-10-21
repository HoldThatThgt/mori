// "Connections and models"的列表（docs/v0/screens/settings.md）：每个连接一张卡，卡里每个模型一行；设为默认、测试、编辑、删除。

import { useEffect, useState } from 'react';
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

/** @brief 正在确认删除的模型，和删除成功后焦点去的按钮（打开确认框时算好；null 时去"Add connection"）。 */
interface Deleting {
  /** 要删除的模型 */
  target: DeleteTarget;
  /** 删除成功后焦点去的按钮的选择器 */
  next: string | null;
}

/**
 * @brief 模型行上一个按钮的选择器（回到列表、关掉确认框之后放焦点用）。
 * @param ref provider/模型 ID
 */
export function modelButton(ref: string, action: 'edit' | 'delete'): string {
  return `[data-testid="model-row"][data-model="${CSS.escape(ref)}"] [data-action="${action}"]`;
}

/** @brief 连接卡上一个按钮的选择器："Edit connection"或"Add model"。 */
export function connectionButton(providerId: string, action: 'edit-connection' | 'add-model'): string {
  return `[data-testid="connection-card"][data-provider="${CSS.escape(providerId)}"] [data-action="${action}"]`;
}

/** @brief 下一帧（列表重新渲染之后）把焦点放到 selector 指的按钮；为 null 或找不到时放到"Add connection"。 */
function focusInList(selector: string | null): void {
  requestAnimationFrame(() => {
    const target = selector ? document.querySelector<HTMLElement>(selector) : null;
    (target ?? document.querySelector<HTMLElement>('[data-action="add-connection"]'))?.focus();
  });
}

/**
 * @brief 删除成功后焦点去哪：同一张卡里下一个（没有时上一个）模型的"Edit"；整张卡一起删掉时下一张卡的"Edit connection"，
 *        没有下一张卡时为 null（"Add connection"）。
 */
function afterDelete(connections: ConnectionInfo[], { connection, model }: DeleteTarget): string | null {
  const index = connection.models.findIndex((item) => item.id === model.id);
  const neighbour = connection.models[index + 1] ?? connection.models[index - 1];
  if (neighbour) return modelButton(`${connection.providerId}/${neighbour.id}`, 'edit');
  const cards = connections.map((item) => item.providerId);
  const next = cards[cards.indexOf(connection.providerId) + 1];
  return next ? connectionButton(next, 'edit-connection') : null;
}

/** @brief 一行模型的思考设置。 */
function thinkingText(model: ModelInfo): string {
  return model.reasoning ? `Supports thinking · Default effort: ${THINKING_LABELS[model.thinkingLevel]}`
    : 'Doesn’t support thinking';
}

/**
 * @brief 不能删除的原因；能删时为 null。
 * @param total 全部连接下模型的个数
 */
function deleteBlock(isDefault: boolean, total: number): string | null {
  if (total <= 1) return 'Keep at least one model';
  return isDefault ? 'Can’t delete the default model. Set another model as default first.' : null;
}

/**
 * @brief 模型行的按钮：设为默认（不是默认时）、测试（测试中可以取消）、编辑、删除。
 *        设为默认之后这个按钮消失，焦点放到这一行的"Edit"；失败时按钮还在，焦点不动（再按一次就是重试）。
 */
function ModelActions({ connection, model, isDefault, total, onDelete }: {
  connection: ConnectionInfo; model: ModelInfo; isDefault: boolean; total: number; onDelete: () => void;
}) {
  const ref = `${connection.providerId}/${model.id}`;
  const testing = useSettings((state) => state.testing);
  const blocked = deleteBlock(isDefault, total);
  const { providerId } = connection;
  const makeDefault = async () => {
    if (await setDefaultModel(providerId, model.id)) focusInList(modelButton(ref, 'edit'));
  };
  return (
    <div className="model-actions">
      {!isDefault && <button className="button compact" onClick={() => void makeDefault()}>Set as default</button>}
      {testing === ref ? (
        <>
          <button className="button compact" disabled>Testing…</button>
          <button className="button compact" onClick={cancelTest}>Cancel</button>
        </>
      ) : (
        <button className="button compact" disabled={testing !== null}
          onClick={() => void testModel(providerId, model.id)}>Test</button>
      )}
      <button className="button compact" data-action="edit"
        onClick={() => showView({ kind: 'model', providerId, modelId: model.id })}>Edit</button>
      <button className="button compact danger" data-action="delete" disabled={blocked !== null}
        title={blocked ?? undefined} onClick={onDelete}>Delete…</button>
    </div>
  );
}

/** @brief 一行模型：ID、"Default"、上下文长度、思考；下面是测试结果。 */
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
          {isDefault && <span className="default-badge">Default</span>}
          <span className="model-meta">
            Context window: {model.contextWindow.toLocaleString('en-US')} · {thinkingText(model)}
          </span>
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
          <span className={`connection-key${keySaved ? '' : ' missing'}`}>
            {keySaved ? 'Key saved (encrypted)' : 'No key'}
          </span>
        </div>
        <div className="model-actions">
          <button className="button compact" data-action="edit-connection"
            onClick={() => showView({ kind: 'edit', providerId, focusKey: 0 })}>Edit connection</button>
          <button className="button compact" data-action="add-model"
            onClick={() => showView({ kind: 'model', providerId, modelId: null })}>
            <Icon name="plus" />Add model
          </button>
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

/**
 * @brief 删除确认：焦点先在"Cancel"；是连接的最后一个模型时说明连接和 key 一起删除。失败时显示原文。
 *        onClose 的参数为是否删除了。
 */
function DeleteModelDialog({ target, onClose }: { target: DeleteTarget; onClose: (deleted: boolean) => void }) {
  const { connection, model } = target;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = connection.endpoint.name;
  const text = connection.models.length === 1 ? `This also deletes the connection ${name} and its key.`
    : `This deletes the model from the connection ${name}.`;
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteModel(connection, model.id);
      onClose(true);
    } catch (failure) {
      setError(`Couldn’t delete the model: ${describe('model.delete', failure)}`);
      setBusy(false);
    }
  }
  return (
    <ConfirmDialog title={`Delete model ${model.id}?`} text={text} confirmLabel="Delete" tone="danger"
      testId="delete-dialog" busyText={busy ? 'Deleting…' : null} error={error} onConfirm={() => void confirm()}
      onCancel={() => onClose(false)} />
  );
}

/**
 * @brief 列表：上方一行结果，连接卡，底部"Add connection"。从表单回到列表时焦点放到 view.focus 指的按钮；
 *        删除确认框关掉后焦点回到这一行的"Delete…"（取消时），或打开确认框时算好的按钮（删除后）。
 */
export function ConnectionsList({ config }: { config: ConfigInfo }) {
  const notice = useSettings((state) => state.notice);
  const returnTo = useSettings((state) => (state.view.kind === 'list' ? state.view.focus ?? null : null));
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const connections = connectionsOf(config);
  const total = connections.reduce((sum, item) => sum + item.models.length, 0);
  useEffect(() => {
    if (returnTo) focusInList(returnTo);
  }, [returnTo]);
  function closeDelete(deleted: boolean) {
    if (!deleting) return;
    const { target, next } = deleting;
    setDeleting(null);
    focusInList(deleted ? next : modelButton(`${target.connection.providerId}/${target.model.id}`, 'delete'));
  }
  return (
    <>
      {notice && (
        <p className={`form-message ${notice.tone}`} role="status" data-testid="settings-notice">{notice.text}</p>
      )}
      {connections.length === 0 && <p className="settings-empty">No models yet</p>}
      {connections.map((connection) => (
        <ConnectionCard key={connection.providerId} connection={connection} defaultModel={config.defaultModel ?? null}
          total={total} onDelete={(target) => setDeleting({ target, next: afterDelete(connections, target) })} />
      ))}
      <div className="form-actions">
        <button className="button" data-action="add-connection" onClick={() => showView({ kind: 'add' })}>
          <Icon name="plus" />Add connection</button>
      </div>
      {deleting && <DeleteModelDialog target={deleting.target} onClose={closeDelete} />}
    </>
  );
}
