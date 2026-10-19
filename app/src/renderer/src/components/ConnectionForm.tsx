// 连接表单（方案 5.2）：首次启动、"设置 → 连接"和"去设置"都用它。状态表见 docs/v0/screens/connection.md。

import { useEffect, useRef, useState } from 'react';
import {
  API_TYPES, COMPAT_OPTIONS, ConnectionSchema, type Connection, type TestResult,
} from '../../../shared/protocol';
import { describe, loadConfig, request } from '../state/actions';
import { useApp } from '../state/store';

// 上下文长度的默认值是临时默认值，见 docs/v0/defaults.md
const emptyForm: Connection = { name: '', baseUrl: '', api: 'openai-completions', apiKey: '', modelId: '',
  contextWindow: 128000, compat: [] };

const apiLabels: Record<(typeof API_TYPES)[number], string> = {
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

const fieldLabels: Record<string, string> = {
  name: '名称', baseUrl: '服务地址', modelId: '模型 ID', contextWindow: '上下文长度',
};

/** @brief 表单下方的一行结果。 */
type Message = { tone: 'ok' | 'error' | 'info'; text: string } | null;

/** @brief 在界面上先检查必填项，给出中文说明；通过时返回 null。 */
function validate(form: Connection): string | null {
  const parsed = ConnectionSchema.safeParse(form);
  if (parsed.success) return null;
  const field = String(parsed.error.issues[0]?.path[0] ?? '');
  if (field === 'baseUrl' && form.baseUrl.trim()) return '服务地址不是有效的网址，例如 http://host:8000/v1';
  if (field === 'contextWindow') return '上下文长度要填正整数';
  return `请填写${fieldLabels[field] ?? field}`;
}

/** @brief 测试结果的文字。 */
function testMessage(result: TestResult): Message {
  if (result.cancelled) return { tone: 'info', text: '已取消测试' };
  if (!result.ok) return { tone: 'error', text: `连接失败：${result.error ?? '没有收到回复'}` };
  const thinking = result.thinking ? ' · 有思考内容' : '';
  const reply = result.text ? ` · 回复：${result.text}` : '';
  return { tone: 'ok', text: `连接成功 · 首字 ${result.firstTokenMs} ms · 共 ${result.totalMs} ms${thinking}${reply}` };
}

/** @brief 表单状态与保存、测试、取消。 */
function useConnectionForm(onTested?: (ok: boolean, text: string) => void) {
  const saved = useApp((state) => state.config?.saved ?? null);
  const [form, setForm] = useState<Connection>(saved?.connection ?? emptyForm);
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'testing'>('idle');
  const [message, setMessage] = useState<Message>(null);

  async function save(): Promise<boolean> {
    const problem = validate(form);
    if (problem) {
      setMessage({ tone: 'error', text: problem });
      return false;
    }
    setPhase('saving');
    try {
      const result = await request<{ error: string | null }>({ type: 'connection.save', connection: form });
      setMessage(result.error ? { tone: 'error', text: `已保存，但配置有错误：${result.error}` } : { tone: 'ok', text: '已保存' });
      setForm((current) => ({ ...current, apiKey: '' }));
      setDirty(false);
      await loadConfig();
      return true;
    } catch (error) {
      setMessage({ tone: 'error', text: `保存失败：${describe('connection.save', error)}` });
      return false;
    } finally {
      setPhase('idle');
    }
  }

  async function test() {
    if ((dirty || !saved) && !(await save())) return;
    setPhase('testing');
    setMessage(null);
    try {
      const result = await request<TestResult>({ type: 'connection.test' });
      const text = testMessage(result);
      setMessage(text);
      onTested?.(result.ok, text?.text ?? '');
    } catch (error) {
      setMessage({ tone: 'error', text: `测试失败：${describe('connection.test', error)}` });
    } finally {
      setPhase('idle');
    }
  }

  const cancel = () => void request({ type: 'connection.testCancel' }).catch((e) => describe('testCancel', e));
  const edit = (patch: Partial<Connection>) => { setForm((current) => ({ ...current, ...patch })); setDirty(true); };
  return { form, edit, dirty, phase, message, save, test, cancel, keySaved: saved?.keySaved ?? false };
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

/** @brief 连接表单。focusKey 变化时把焦点放到 API key（"去设置"）。 */
export function ConnectionForm({ onTested, focusKey = 0 }: {
  onTested?: (ok: boolean, text: string) => void; focusKey?: number;
}) {
  const { form, edit, dirty, phase, message, save, test, cancel, keySaved } = useConnectionForm(onTested);
  const keyInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey > 0) keyInput.current?.focus();
  }, [focusKey]);
  const busy = phase !== 'idle';
  const keyHint = keySaved ? '已加密保存（不显示）；改了服务地址就要重新填写' : '保存后由 Mori 加密存放在本机';
  return (
    <form className="connection-form" data-testid="connection-form"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
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
      <label>模型 ID
        <input value={form.modelId} onChange={(e) => edit({ modelId: e.target.value })} placeholder="qwen3-coder" />
      </label>
      <label>上下文长度
        <input type="number" min={1} value={form.contextWindow}
          onChange={(e) => edit({ contextWindow: Number(e.target.value) })} />
      </label>
      {form.api === 'openai-completions' && (
        <CompatOptions value={form.compat} onChange={(compat) => edit({ compat })} />
      )}
      <div className="form-actions">
        <button type="submit" className="button" disabled={busy || !dirty}>{phase === 'saving' ? '保存中…' : '保存'}</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => void test()}>
          {phase === 'testing' ? '测试中…' : '测试连接'}
        </button>
        {phase === 'testing' && <button type="button" className="button" onClick={cancel}>取消</button>}
      </div>
      {message && (
        <p className={`form-message ${message.tone}`} role="status" data-testid="form-message">{message.text}</p>
      )}
    </form>
  );
}
