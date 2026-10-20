// 连接表单（方案 5.2）：首次启动和"添加连接"填连接和它的第一个模型（full），"编辑连接"只改连接（endpoint）。
// 状态表见 docs/v0/screens/connection.md 和 settings.md。

import { useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';
import {
  API_TYPES, COMPAT_OPTIONS, ConnectionSchema, EndpointSchema, THINKING_LABELS, THINKING_LEVELS, type Connection,
  type ConfigInfo, type ConnectionInfo, type ConnectionSaveResult, type ModelForm as ModelFields, type ModelInfo,
  type SaveResult, type ThinkingLevel,
} from '../../../shared/protocol';
import { loadConfig } from '../state/actions';
import { describe, request } from '../state/bridge';
import { cancelTest, connectionsOf, runTest, type Notice } from '../state/settings';
import { useApp } from '../state/store';

/**
 * @brief 新模型的字段：上下文长度是临时默认值（docs/v0/defaults.md）；思考强度是 pi 现在会用的
 *        （新模型没有 modelThinkingLevels，即 defaultThinkingLevel，没有时 medium，后台进程在 config.get 里给出）。
 */
function emptyModel(level: ThinkingLevel): ModelFields {
  return { modelId: '', contextWindow: 128000, reasoning: false, thinkingLevel: level };
}

/** @brief 首次启动、"添加连接"的空表单。 */
function emptyForm(level: ThinkingLevel): Connection {
  return { name: '', baseUrl: '', api: 'openai-completions', apiKey: '', compat: [], ...emptyModel(level) };
}

/** @brief 新模型的思考强度初始值：pi 设置的 defaultThinkingLevel（M1–M5 的回放里没有时为 medium）。 */
export function defaultLevel(config: ConfigInfo | null): ThinkingLevel {
  return config?.defaultThinkingLevel ?? 'medium';
}

/** @brief 接口类型的界面文字。 */
export const apiLabels: Record<(typeof API_TYPES)[number], string> = {
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

/** 必填项的界面文字（保存前的检查用） */
const fieldLabels: Record<string, string> = {
  name: '名称', baseUrl: '服务地址', modelId: '模型 ID', contextWindow: '上下文长度',
};

/** 标了支持思考、没有 thinkingLevelMap 的模型可选的强度：off–high（m6-checks.md） */
const BASIC_LEVELS: ThinkingLevel[] = THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf('high') + 1);

/** @brief 表单可选的思考强度：已经支持思考的模型用 pi 给出的，新模型和刚勾上"支持思考"的用 off–high。 */
export function levelOptions(model: ModelInfo | undefined): ThinkingLevel[] {
  return model?.reasoning ? model.thinkingLevels : BASIC_LEVELS;
}

/** @brief 在界面上先检查必填项，给出中文说明；通过时返回 null。 */
export function validate(schema: ZodType, form: Partial<Connection>): string | null {
  const parsed = schema.safeParse(form);
  if (parsed.success) return null;
  const field = String(parsed.error.issues[0]?.path[0] ?? '');
  if (field === 'baseUrl' && form.baseUrl?.trim()) return '服务地址不是有效的网址，例如 http://host:8000/v1';
  if (field === 'contextWindow') return '上下文长度要填正整数';
  return `请填写${fieldLabels[field] ?? field}`;
}

/**
 * @brief 已有模型的字段（不支持思考时强度先放 level，勾上"支持思考"时用）；没有模型时为新模型的字段。
 * @param level 新模型的思考强度初始值（defaultLevel）
 */
export function modelFields(model: ModelInfo | undefined, level: ThinkingLevel): ModelFields {
  if (!model) return emptyModel(level);
  return { modelId: model.id, contextWindow: model.contextWindow, reasoning: model.reasoning,
    thinkingLevel: model.reasoning ? model.thinkingLevel : level };
}

/** @brief 表单的初始值：已有的连接和它的第一个模型（key 不回填）；没有时为空表单。 */
function formFrom(info: ConnectionInfo | undefined, level: ThinkingLevel): Connection {
  return info ? { ...info.endpoint, apiKey: '', ...modelFields(info.models[0], level) } : emptyForm(level);
}

/** @brief 表单的参数。 */
export interface ConnectionFormProps {
  /** 保存到的连接；null 表示新建（首次启动、"添加连接"） */
  providerId: string | null;
  /** full：连接和它的一个模型；endpoint：只改连接（"编辑连接"，不含模型字段） */
  mode: 'full' | 'endpoint';
  /** 测试结束（首次启动据此进入"打开文件夹…"） */
  onTested?: (ok: boolean, text: string) => void;
  /** 大于 0 且变化时把焦点放到 API key（"去设置"） */
  focusKey?: number;
  /** 用"保存"按钮保存成功、pi 没有报告配置错误时 */
  onSaved?: () => void;
  /** 回到列表；saved 为这张表单保存过。不传时没有这个按钮（首次启动） */
  onClose?: (saved: boolean) => void;
}

/** @brief 保存的结果：保存到的连接和 pi 报告的配置错误。 */
type Saved = ConnectionSaveResult;

/** @brief 发出保存命令：full 用 connection.save（providerId 为 null 时新建），endpoint 用 endpoint.save。 */
async function saveForm(mode: ConnectionFormProps['mode'], target: string | null, form: Connection): Promise<Saved> {
  if (mode === 'full') return request<Saved>({ type: 'connection.save', providerId: target, connection: form });
  if (!target) throw new Error('Missing connection id');
  const { name, baseUrl, api, apiKey, compat } = form;
  const endpoint = { name, baseUrl, api, apiKey, compat };
  const result = await request<SaveResult>({ type: 'endpoint.save', providerId: target, endpoint });
  return { providerId: target, error: result.error };
}

/** @brief 保存成功时表单下方的文字：pi 报告了配置错误时显示原文。 */
function savedMessage(saved: Saved): Notice {
  return saved.error ? { tone: 'error', text: `已保存，但配置有错误：${saved.error}` } : { tone: 'ok', text: '已保存' };
}

/** @brief 表单状态与保存、测试。 */
function useConnectionForm({ providerId, mode, onTested }: ConnectionFormProps) {
  const config = useApp((state) => state.config);
  const [created, setCreated] = useState<string | null>(null);
  const target = providerId ?? created;
  const info = connectionsOf(config).find((item) => item.providerId === target);
  const [form, setForm] = useState<Connection>(() => formFrom(info, defaultLevel(config)));
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'testing'>('idle');
  const [message, setMessage] = useState<Notice | null>(null);
  async function save(): Promise<Saved | null> {
    const problem = validate(mode === 'full' ? ConnectionSchema : EndpointSchema, form);
    if (problem) {
      setMessage({ tone: 'error', text: problem });
      return null;
    }
    setPhase('saving');
    try {
      const saved = await saveForm(mode, target, form);
      setCreated(saved.providerId);
      setMessage(savedMessage(saved));
      setForm((current) => ({ ...current, apiKey: '' }));
      setDirty(false);
      await loadConfig();
      return saved;
    } catch (error) {
      const command = mode === 'full' ? 'connection.save' : 'endpoint.save';
      setMessage({ tone: 'error', text: `保存失败：${describe(command, error)}` });
      return null;
    } finally {
      setPhase('idle');
    }
  }
  async function test() {
    // full 测表单里的模型（没填时经保存前的检查提示）；endpoint 测这个连接的第一个模型，
    // 没有模型时不测（不带模型时后台进程会测默认模型）。
    const modelId = mode === 'full' ? form.modelId.trim() : info?.models[0]?.id;
    if (!modelId && mode === 'endpoint') return setMessage({ tone: 'error', text: '这个连接下还没有模型，先添加模型' });
    const saved = dirty || !target || !modelId ? await save() : { providerId: target, error: null };
    if (!saved) return;
    setPhase('testing');
    setMessage(null);
    const outcome = await runTest(saved.providerId, modelId);
    setMessage(outcome.notice);
    setPhase('idle');
    onTested?.(outcome.ok, outcome.notice.text);
  }
  const edit = (patch: Partial<Connection>) => { setForm((current) => ({ ...current, ...patch })); setDirty(true); };
  return { form, edit, dirty, phase, message, save, test, info, everSaved: created !== null,
    keySaved: info?.keySaved ?? false };
}

/** @brief 兼容选项（只对 OpenAI 兼容端点显示）。 */
function CompatOptions({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <details className="compat-options" open={value.length > 0}>
      <summary>兼容选项{value.length > 0 ? `（已选 ${value.length} 项）` : ''}</summary>
      <p className="field-hint">只在端点确实不支持时勾选；不勾选时由 pi 自动判断。</p>
      {COMPAT_OPTIONS.map((option) => (
        <label key={option.id} className="check-row">
          <input type="checkbox" checked={value.includes(option.id)}
            onChange={(event) => onChange(event.target.checked ? [...value, option.id]
              : value.filter((id) => id !== option.id))} />
          <span>{option.label}<small>{option.hint}</small></span>
        </label>
      ))}
    </details>
  );
}

/** @brief "支持思考"和"新会话默认的思考强度"（只在勾了支持思考时出现）。 */
export function ThinkingFields({ reasoning, level, levels, onChange }: {
  reasoning: boolean; level: ThinkingLevel; levels: ThinkingLevel[];
  onChange: (patch: { reasoning?: boolean; thinkingLevel?: ThinkingLevel }) => void;
}) {
  return (
    <div className="thinking-fields">
      <label className="check-row">
        <input type="checkbox" checked={reasoning}
          onChange={(event) => onChange({ reasoning: event.target.checked })} />
        <span>支持思考
          <small>勾选后 pi 才会发送思考参数；不勾时端点按自己的默认处理（DeepSeek 默认会思考，但不能控制）</small>
        </span>
      </label>
      {reasoning && (
        <label className="thinking-level">新会话默认的思考强度
          <select value={level} onChange={(event) => onChange({ thinkingLevel: event.target.value as ThinkingLevel })}>
            {levels.map((item) => <option key={item} value={item}>{THINKING_LABELS[item]}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

/** @brief 模型字段（full 才有）：模型 ID、上下文长度、思考；info 为已保存的连接（可选的思考强度按其中同 ID 的模型）。 */
function ModelInputs({ form, info, edit }: {
  form: Connection; info: ConnectionInfo | undefined; edit: (patch: Partial<Connection>) => void;
}) {
  const model = info?.models.find((item) => item.id === form.modelId.trim());
  return (
    <>
      <label>模型 ID
        <input value={form.modelId} onChange={(e) => edit({ modelId: e.target.value })} placeholder="qwen3-coder" />
      </label>
      <label>上下文长度
        <input type="number" min={1} value={form.contextWindow}
          onChange={(e) => edit({ contextWindow: Number(e.target.value) })} />
      </label>
      <ThinkingFields reasoning={form.reasoning} level={form.thinkingLevel} levels={levelOptions(model)}
        onChange={edit} />
    </>
  );
}

/** @brief 表单的按钮：保存、测试连接（测试中可以取消）、取消或返回列表（保存过之后）。 */
function FormActions({ phase, dirty, everSaved, onTest, onClose }: {
  phase: 'idle' | 'saving' | 'testing'; dirty: boolean; everSaved: boolean; onTest: () => void;
  onClose?: (saved: boolean) => void;
}) {
  const busy = phase !== 'idle';
  return (
    <div className="form-actions">
      <button type="submit" className="button" disabled={busy || !dirty}>{phase === 'saving' ? '保存中…' : '保存'}</button>
      <button type="button" className="button primary" disabled={busy} onClick={onTest}>
        {phase === 'testing' ? '测试中…' : '测试连接'}
      </button>
      {phase === 'testing' && <button type="button" className="button" onClick={cancelTest}>取消</button>}
      {onClose && !busy && (
        <button type="button" className="button" onClick={() => onClose(everSaved)}>{everSaved ? '返回列表' : '取消'}</button>
      )}
    </div>
  );
}

/** @brief 连接表单。 */
export function ConnectionForm(props: ConnectionFormProps) {
  const { mode, focusKey = 0, onSaved, onClose } = props;
  const { form, edit, dirty, phase, message, save, test, info, everSaved, keySaved } = useConnectionForm(props);
  const keyInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey > 0) keyInput.current?.focus();
  }, [focusKey]);
  const keyHint = keySaved ? '已加密保存（不显示）；改了服务地址就要重新填写' : '保存后由 Mori 加密存放在本机';
  async function submit() {
    const saved = await save();
    if (saved && !saved.error) onSaved?.();
  }
  return (
    <form className="connection-form" data-testid="connection-form"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>名称<input value={form.name} onChange={(e) => edit({ name: e.target.value })} placeholder="内网模型" /></label>
      <label>服务地址
        <input value={form.baseUrl} onChange={(e) => edit({ baseUrl: e.target.value })}
          placeholder="http://host:8000/v1" />
      </label>
      <label>接口类型
        <select value={form.api} onChange={(e) => edit({ api: e.target.value as Connection['api'] })}>
          {API_TYPES.map((type) => <option key={type} value={type}>{apiLabels[type]}</option>)}
        </select>
      </label>
      <label>API key
        <input ref={keyInput} type="password" value={form.apiKey} onChange={(e) => edit({ apiKey: e.target.value })}
          placeholder={keyHint} autoComplete="off" />
      </label>
      {mode === 'full' && <ModelInputs form={form} info={info} edit={edit} />}
      {form.api === 'openai-completions' && (
        <CompatOptions value={form.compat} onChange={(compat) => edit({ compat })} />
      )}
      <FormActions phase={phase} dirty={dirty} everSaved={everSaved} onTest={() => void test()} onClose={onClose} />
      {message && (
        <p className={`form-message ${message.tone}`} role="status" data-testid="form-message">{message.text}</p>
      )}
    </form>
  );
}
