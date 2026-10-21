// 工具页的"MCP"一节（docs/v0/screens/tools.md）：用户级 mcp.json 和项目的 .pi/mcp.json 里的服务。
// 工具名来自跟随的会话（getAllTools），错误来自它对话流里 pi 的 MCP 通知；进程状态来自后台进程的共享服务表
// （McpServerEntry.shared，docs/v0/m6-mcp-shared.md）。不显示"Connected"，也不凭工具列表推断连接状态。
// pi 不会加载的条目（后台进程照 pi 的检查，McpServerEntry.problem）也列出，说明原因。
// 改动只对新建的会话生效。

import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { McpServerEntry, SharedServerState } from '../../../shared/protocol';
import { newSession } from '../state/projects';
import type { Item } from '../state/model';
import { useApp, type AppState } from '../state/store';
import { mcpNotices, serverLines, useChange } from '../state/tools';
import { ConfirmDialog } from './ConfirmDialog';
import { McpForm, type McpFormMode } from './ToolsMcpForm';
import { OpenInEditor, ToolSwitch, useSwitch } from './ToolsCommon';

/** pi 的调用方式（exposure）的界面文字 */
const EXPOSURE_TEXT: Record<string, string> = {
  direct: 'Direct', codemode: 'codemode', deferred: 'Deferred', hidden: 'Hidden',
};

/** @brief 调用方式的文字；不认识的原样显示。 */
function exposureText(exposure: string): string {
  return EXPOSURE_TEXT[exposure] ?? exposure;
}

/** @brief 命令行（command 加 args）或地址。 */
function commandLine(server: McpServerEntry): string {
  if (server.command !== null) return [server.command, ...server.args].join(' ');
  return server.url ?? '';
}

/**
 * @brief 正在添加或编辑哪个服务；重新读取后按名字找回用户级的那一行（只有用户级的能编辑；同名的本项目一行不算），
 *        表单不随之关闭。
 */
interface Editing {
  /** 编辑的服务的名字；添加时为 null */
  name: string | null;
  /** 打开表单时的服务（表单的初始内容）；添加时为 null */
  server: McpServerEntry | null;
  /** 打开时的写法 */
  mode: McpFormMode;
}

/** @brief 跟随的会话的对话流；会话已经不在界面里时为 undefined。 */
function followedItems(state: AppState, tabKey: string | null): Item[] | undefined {
  return state.tabs.find((tab) => tab.key === tabKey)?.transcript.items;
}

/** 配置问题原文里的 mcp.json 路径（盘符路径或绝对路径），后面紧跟 ": " */
const CONFIG_PATH = /([A-Za-z]:[\\/].*?mcp\.json|\/.*?mcp\.json)(?=: )/;

/** @brief 配置问题原文里的 mcp.json 路径，给"Open in default app"；没有时为 null。 */
function errorFile(error: string): string | null {
  return CONFIG_PATH.exec(error)?.[1] ?? null;
}

/** @brief 用户级 mcp.json 整个读不出来（不能解析等，不是某一个服务的问题）：这时不能添加，免得覆盖坏文件。 */
function userFileBroken(errors: string[]): boolean {
  return errors.some((error) => {
    const file = errorFile(error);
    return file !== null && !/[\\/]\.pi[\\/]mcp\.json$/.test(file) && !error.includes('server "');
  });
}

/**
 * @brief 不能在这里改的原因：被项目覆盖的用户级服务说明改了哪些字段（"Overridden by this project: <字段>"），
 *        本项目的条目用 readOnly；能改时为 null。
 */
function lockReason(server: McpServerEntry): string | null {
  if (server.overrides.length > 0) return `Overridden by this project: ${server.overrides.join(', ')}`;
  return server.readOnly;
}

/**
 * @brief 这个用户级服务那一行的"Edit"按钮（行里的第一个按钮）；没有时为 null。
 *        同名的还可能有本项目的一行（pi 不加载的条目也列出），只找用户级的。
 */
function editButton(name: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-testid="mcp-row"][data-scope="user"][data-server="${CSS.escape(name)}"] .tools-row-actions button`);
}

/**
 * @brief 通知里关于这个服务的行（警示色）：连接错误和 pi 的 "config:" 配置问题，完整通知可以展开。
 *        与这一行已经显示的"pi won’t load this server"原因相同的配置问题不再重复。
 */
function McpErrors({ server, notices }: { server: McpServerEntry; notices: string[] }) {
  const related = notices.filter((notice) => serverLines(notice, server.name).length > 0);
  const lines = [...new Set(related.flatMap((notice) => serverLines(notice, server.name)))]
    .filter((line) => !server.problem || !line.endsWith(server.problem));
  if (lines.length === 0) return null;
  return (
    <div className="tools-warn" data-testid="mcp-error">
      {lines.map((line) => <p key={line}>{line}</p>)}
      <details className="tools-full-notice">
        <summary>Full notice</summary>
        {related.map((notice, index) => <pre key={index}>{notice}</pre>)}
      </details>
    </div>
  );
}

/**
 * @brief 进程状态的文字（照 Claude 桌面版设置 → 开发者里每个本地服务的 running / failed）；失败时接上原文的第一行。
 *        failed 包括启动失败和运行后连接断了（SharedServerState 的定义），原文说明是哪一种（如 "Connection closed"）。
 */
function processText(shared: SharedServerState): string {
  if (shared.state === 'running') {
    if (shared.sessions === 0) return 'Running · Not in use';
    return `Running · Used by ${shared.sessions} ${shared.sessions === 1 ? 'session' : 'sessions'}`;
  }
  if (shared.state === 'starting') return 'Starting…';
  return shared.error ? `Failed: ${shared.error.split(/\r?\n/)[0]}` : 'Failed';
}

/**
 * @brief 共享连接的进程状态（后台进程的共享服务表里的真实状态）：运行中和在用的会话数、启动中、失败和原文第一行
 *        （警示色）。原文不止一行（stdio 时接上的 stderr 末尾）时可以展开看完整原文，照 Claude 桌面版状态一行、
 *        详情另看。还没有共享连接时不显示；旧的回放录制里没有这个字段（undefined），同样不显示。
 */
function McpProcess({ shared }: { shared: SharedServerState | null | undefined }) {
  if (!shared) return null;
  const tone = shared.state === 'failed' ? 'tools-warn' : 'tools-row-note';
  const full = shared.state === 'failed' && shared.error && /\r?\n/.test(shared.error) ? shared.error : null;
  return (
    <div className={`${tone} tools-process`} data-testid="mcp-process" data-state={shared.state}>
      <p>{processText(shared)}</p>
      {full && (
        <details className="tools-full-notice">
          <summary>Full error</summary>
          <pre>{full}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * @brief 服务行的说明：命令行、进程状态、pi 不会加载它的原因、注册的工具、调用方式的警示、错误、不能改的原因、
 *        项目的覆盖、没能保存的原文。pi 不会加载的条目只说原因，不显示工具名和调用方式的警示。
 */
function McpNotes({ server, notices, locked, error, onDirect }: {
  server: McpServerEntry; notices: string[]; locked: boolean; error: string | null; onDirect: () => void;
}) {
  const tools = server.problem ? null : server.tools;
  return (
    <>
      {commandLine(server) && <p className="tools-mono">{commandLine(server)}</p>}
      <McpProcess shared={server.shared} />
      {server.problem && (
        <p className="tools-warn" data-testid="mcp-problem">pi won’t load this server: {server.problem}</p>)}
      {tools && (
        <p className="tools-row-note" data-testid="mcp-tools">
          {tools.length > 0 ? `Tools in this session: ${tools.join(', ')}`
            : 'This server has no tools in this session'}</p>
      )}
      {server.exposure !== 'direct' && !server.problem && (
        <p className="tools-warn">
          This server is set to “{exposureText(server.exposure)}”. Mori only supports direct calls, so the model
          can’t call its tools.
          <button type="button" className="text-link" data-testid="mcp-direct" disabled={locked}
            onClick={onDirect}>Switch to direct calls</button>
        </p>
      )}
      <McpErrors server={server} notices={notices} />
      {lockReason(server) && <p className="tools-row-note">{lockReason(server)}</p>}
      {error && <p className="form-message error" role="alert">Couldn’t save: {error}</p>}
    </>
  );
}

/**
 * @brief 一个服务：名字、来源、调用方式、开关；命令行、工具名、错误；编辑、以 JSON 编辑、移除。
 *        它的表单开着时这一行的开关和按钮不可用（表单里切换写法；免得保存时盖掉刚做的启停）。
 *        pi 不会加载的条目开关关上、不可用（启停救不了它），不显示调用方式；编辑、以 JSON 编辑、移除照常（用户级的）。
 */
function McpRow({ server, notices, editing, onEdit, onRemove }: {
  server: McpServerEntry; notices: string[]; editing: boolean; onEdit: (mode: McpFormMode) => void;
  onRemove: () => void;
}) {
  const change = useChange();
  const power = useSwitch(change, server.enabled,
    (enabled) => ({ type: 'mcp.setEnabled', name: server.name, enabled }));
  const reason = lockReason(server);
  const locked = change.busy || editing || reason !== null;
  const checked = power.checked && !server.problem;
  // 表单没有地址一栏：HTTP 服务的"Edit"直接以 JSON 编辑。
  const editMode: McpFormMode = server.command === null ? 'json' : 'fields';
  return (
    <li className={`tools-row${checked ? '' : ' off'}`} data-testid="mcp-row" data-server={server.name}
      data-scope={server.scope}>
      <div className="tools-row-head">
        <div className="tools-row-main">
          <span className="tools-row-name">{server.name}</span>
          <span className="tools-tag">{server.scope === 'user' ? 'User' : 'Project'}</span>
          {!server.problem && <span className="tools-tag">{exposureText(server.exposure)}</span>}
        </div>
        <ToolSwitch checked={checked} label={`Enable MCP server ${server.name}`}
          disabled={locked || Boolean(server.problem)} title={reason ?? server.problem ?? undefined}
          onChange={power.toggle} />
      </div>
      <McpNotes server={server} notices={notices} locked={locked} error={change.error}
        onDirect={() => void change.run({ type: 'mcp.setDirect', name: server.name })} />
      <div className="tools-row-actions">
        <button type="button" className="text-link" disabled={locked} onClick={() => onEdit(editMode)}>Edit</button>
        <button type="button" className="text-link" disabled={locked} onClick={() => onEdit('json')}>
          Edit as JSON</button>
        <button type="button" className="text-link danger" disabled={locked} onClick={onRemove}>Remove…</button>
      </div>
    </li>
  );
}

/** @brief 移除确认框："Remove MCP server “<名字>”? Sessions already open aren’t affected." */
function RemoveDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const change = useChange();
  async function confirm() {
    if (await change.run({ type: 'mcp.remove', name })) onClose();
  }
  return (
    <ConfirmDialog title={`Remove MCP server “${name}”?`} text="Sessions already open aren’t affected."
      confirmLabel="Remove" tone="danger" testId="remove-dialog" busyText={change.busy ? 'Removing…' : null}
      error={change.error}
      onConfirm={() => void confirm()} onCancel={onClose} />
  );
}

/** @brief 配置读不出来的原文（警示色），每个文件一个"Open in default app"。 */
function ConfigErrors({ errors, cwd }: { errors: string[]; cwd: string }) {
  if (errors.length === 0) return null;
  return (
    <div className="tools-warn" role="status" data-testid="mcp-config-errors">
      {errors.map((error, index) => {
        const file = errorFile(error);
        return <p key={index}>{error} {file && <OpenInEditor path={file} cwd={cwd} />}</p>;
      })}
    </div>
  );
}

/**
 * @brief "MCP"一节（只在有跟随的会话时）。
 * @param tabKey 跟随的会话（界面里的标识），错误从它的对话流里取
 * @param cwd 跟随的会话的工作目录
 */
export function McpSection({ mcp, tabKey, cwd }: {
  mcp: { servers: McpServerEntry[]; errors: string[] }; tabKey: string | null; cwd: string;
}) {
  const notices = useApp(useShallow((state) => mcpNotices(followedItems(state, tabKey))));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const broken = userFileBroken(mcp.errors);
  function open(next: Editing) {
    setSaved(false);
    setEditing(next);
  }
  function close(done: boolean) {
    const name = editing?.name ?? null;
    setEditing(null);
    setSaved(done);
    // 焦点回到打开表单的按钮："Add"，或这个服务的"Edit"（改了名时找不到，焦点留在原处）。
    requestAnimationFrame(() => (name === null ? addButton.current : editButton(name))?.focus());
  }
  const form = (name: string | null) => editing && editing.name === name && (
    <McpForm server={editing.server} mode={editing.mode} onSaved={() => close(true)} onCancel={() => close(false)} />
  );
  return (
    <>
      <h2>MCP</h2>
      {saved && (
        <p className="form-message ok" role="status">Saved · Only new sessions will connect to it
          <button type="button" className="text-link" onClick={() => void newSession()}>New session</button></p>
      )}
      <ConfigErrors errors={mcp.errors} cwd={cwd} />
      {mcp.servers.length === 0 && <p className="tools-empty">No MCP servers yet</p>}
      <ul className="tools-list">
        {mcp.servers.map((server) => (
          <McpServerItem key={`${server.scope}:${server.name}`} server={server} notices={notices}
            form={server.scope === 'user' && form(server.name)}
            onEdit={(mode) => open({ name: server.name, server, mode })} onRemove={() => setRemoving(server.name)} />
        ))}
      </ul>
      {form(null) || (
        <button ref={addButton} type="button" className="button" disabled={broken}
          title={broken ? 'Fix mcp.json first: it can’t be read, and adding a server would overwrite it' : undefined}
          onClick={() => open({ name: null, server: null, mode: 'fields' })}>Add</button>
      )}
      {removing && <RemoveDialog name={removing} onClose={() => setRemoving(null)} />}
    </>
  );
}

/** @brief 列表里的一个服务；正在编辑它时表单接在它下面。 */
function McpServerItem({ server, notices, form, onEdit, onRemove }: {
  server: McpServerEntry; notices: string[]; form: React.ReactNode; onEdit: (mode: McpFormMode) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <McpRow server={server} notices={notices} editing={Boolean(form)} onEdit={onEdit} onRemove={onRemove} />
      {form && <li className="tools-form-item">{form}</li>}
    </>
  );
}
