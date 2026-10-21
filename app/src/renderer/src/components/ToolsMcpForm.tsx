// MCP 服务的添加与编辑（docs/v0/screens/tools.md "添加与编辑"）：表单（名称、命令、参数、环境变量），或"Edit as JSON"
// （名称加 mcpServers 条目的 JSON，与 Claude 桌面版、pi 的写法相同）；两种都发 mcp.save。保存失败时表单保留你写的；
// Esc 等于取消。

import { useEffect, useRef, useState } from 'react';
import type { McpServerEntry } from '../../../shared/protocol';
import { useOverlay } from '../state/overlays';
import { useChange } from '../state/tools';

/** @brief 表单的写法：逐项填写，或以 JSON 编辑。 */
export type McpFormMode = 'fields' | 'json';

/** mcpServers 里的一个条目 */
type Entry = Record<string, unknown>;

/** @brief 表单里逐项填写的内容（原文）。 */
interface Fields {
  /** 命令 */
  command: string;
  /** 参数，每行一个 */
  args: string;
  /** 环境变量，每行"NAME=value" */
  env: string;
}

/** @brief 是不是 JSON 对象（不含数组）。 */
function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief 从条目取出表单的内容。 */
function fieldsOf(entry: Entry): Fields {
  const env = isRecord(entry.env) ? Object.entries(entry.env).map(([key, value]) => `${key}=${String(value)}`) : [];
  return {
    command: typeof entry.command === 'string' ? entry.command : '',
    args: Array.isArray(entry.args) ? entry.args.map(String).join('\n') : '',
    env: env.join('\n'),
  };
}

/** @brief 多行文字里不空的行（去掉首尾空白）。 */
function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** @brief 改一个字段；value 为 null 时删掉它。 */
function setField(entry: Entry, key: string, value: unknown): void {
  if (value === null) delete entry[key];
  else entry[key] = value;
}

/**
 * @brief 表单写回条目：在原来的条目上改 command、args、env（空的删掉），调用方式写成直接调用，其他字段原样保留。
 *        环境变量有一行不是"NAME=value"时返回说明。
 */
function entryOf(base: Entry, fields: Fields): Entry | string {
  const env: Record<string, string> = {};
  for (const line of lines(fields.env)) {
    const at = line.indexOf('=');
    if (at <= 0) return `Environment variable “${line}” must be written as NAME=value.`;
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  const args = lines(fields.args);
  const entry: Entry = { ...base };
  setField(entry, 'command', fields.command.trim() || null);
  setField(entry, 'args', args.length > 0 ? args : null);
  setField(entry, 'env', Object.keys(env).length > 0 ? env : null);
  entry.exposure = 'direct';
  return entry;
}

/** @brief 解析"Edit as JSON"的内容；不是 JSON 对象时返回原文或说明。 */
function parseEntry(text: string): Entry | string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
    return 'The server config must be a JSON object, e.g. {"command": "node", "args": ["server.mjs"]}';
  } catch (error) {
    return (error as Error).message;
  }
}

/** @brief 逐项填写的几个输入框。 */
function FieldInputs({ fields, onChange }: { fields: Fields; onChange: (next: Fields) => void }) {
  return (
    <>
      <label><span>Command</span>
        <input value={fields.command} spellCheck={false} placeholder="e.g. node or npx"
          onChange={(event) => onChange({ ...fields, command: event.target.value })} /></label>
      <label><span>Arguments</span>
        <textarea rows={3} value={fields.args} spellCheck={false} placeholder="One per line"
          onChange={(event) => onChange({ ...fields, args: event.target.value })} /></label>
      <label><span>Environment variables</span>
        <textarea rows={3} value={fields.env} spellCheck={false} placeholder="NAME=value, one per line"
          onChange={(event) => onChange({ ...fields, env: event.target.value })} /></label>
    </>
  );
}

/** @brief 表单的内容与两种写法之间的切换。 */
function useMcpDraft(server: McpServerEntry | null, initialMode: McpFormMode) {
  const original = server?.entry ?? {};
  const [mode, setMode] = useState(initialMode);
  const [base, setBase] = useState<Entry>(original);
  const [fields, setFields] = useState<Fields>(() => fieldsOf(original));
  const [json, setJson] = useState(() => JSON.stringify(original, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  /** @brief 切到另一种写法；当前的内容写不成条目时留在原处并说明。 */
  function switchMode() {
    const entry = mode === 'fields' ? entryOf(base, fields) : parseEntry(json);
    if (typeof entry === 'string') {
      setProblem(entry);
      return;
    }
    setProblem(null);
    setBase(entry);
    setFields(fieldsOf(entry));
    setJson(JSON.stringify(entry, null, 2));
    setMode(mode === 'fields' ? 'json' : 'fields');
  }
  const entry = () => (mode === 'fields' ? entryOf(base, fields) : parseEntry(json));
  return { mode, fields, setFields, json, setJson, problem, setProblem, switchMode, entry };
}

/**
 * @brief 添加（server 为 null）或编辑一个用户级 MCP 服务。
 * @param mode 打开时的写法
 * @param onSaved 保存成功
 * @param onCancel 取消或按了 Esc
 */
export function McpForm({ server, mode, onSaved, onCancel }: {
  server: McpServerEntry | null; mode: McpFormMode; onSaved: () => void; onCancel: () => void;
}) {
  const draft = useMcpDraft(server, mode);
  const [name, setName] = useState(server?.name ?? '');
  const change = useChange();
  const first = useRef<HTMLInputElement>(null);
  useOverlay(true, () => (change.busy ? false : onCancel()));
  useEffect(() => first.current?.focus(), []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const entry = draft.entry();
    const problem = !name.trim() ? 'Name is required.' : typeof entry === 'string' ? entry : null;
    draft.setProblem(problem);
    change.clear();
    if (problem || typeof entry === 'string') return;
    if (await change.run({ type: 'mcp.save', name: name.trim(), previousName: server?.name ?? null, entry })) onSaved();
  }
  const failure = draft.problem ?? change.error;
  return (
    <form className="tools-form" data-testid="mcp-form" data-mode={draft.mode} onSubmit={(event) => void save(event)}>
      <label><span>Name</span>
        <input ref={first} value={name} spellCheck={false} placeholder="Letters, numbers, _, and -"
          onChange={(event) => setName(event.target.value)} /></label>
      {draft.mode === 'fields' ? <FieldInputs fields={draft.fields} onChange={draft.setFields} /> : (
        <label><span>Server config (JSON)</span>
          <textarea data-testid="mcp-json" rows={10} value={draft.json} spellCheck={false}
            onChange={(event) => draft.setJson(event.target.value)} /></label>
      )}
      <p className="field-hint">Servers you add here always use direct calls (exposure: direct)</p>
      {failure && <p className="form-message error" role="alert">Couldn’t save: {failure}</p>}
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={change.busy}>
          {change.busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="button" disabled={change.busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="text-link" disabled={change.busy} onClick={draft.switchMode}>
          {draft.mode === 'fields' ? 'Edit as JSON' : 'Back to form'}</button>
      </div>
    </form>
  );
}
