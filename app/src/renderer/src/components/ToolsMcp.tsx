// 工具页的"MCP"一节（docs/v0/screens/tools.md）：用户级 mcp.json 和项目的 .pi/mcp.json 里的服务。
// 工具名来自跟随的会话（getAllTools），错误来自它对话流里 pi 的 MCP 通知；pi 不提供连接状态，所以不显示"已连接"。
// 改动只对新建的会话生效。

import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { McpServerEntry } from '../../../shared/protocol';
import { newSession } from '../state/projects';
import type { Item } from '../state/model';
import { useApp, type AppState } from '../state/store';
import { mcpNotices, serverLines, useChange } from '../state/tools';
import { ConfirmDialog } from './ConfirmDialog';
import { McpForm, type McpFormMode } from './ToolsMcpForm';
import { OpenInEditor, ToolSwitch, useSwitch } from './ToolsCommon';

/** pi 的调用方式（exposure）的界面文字 */
const EXPOSURE_TEXT: Record<string, string> = {
  direct: '直接调用', codemode: 'codemode', deferred: '延迟加载', hidden: '隐藏',
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

/** @brief 正在添加或编辑哪个服务；重新读取后按名字找回它，表单不随之关闭。 */
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

/** @brief 配置问题原文里的 mcp.json 路径，给"用系统编辑器打开"；没有时为 null。 */
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
 * @brief 不能在这里改的原因：被项目覆盖的用户级服务说明改了哪些字段（后台进程给它的 readOnly 是"本项目的"那句），
 *        本项目的条目用 readOnly；能改时为 null。
 */
function lockReason(server: McpServerEntry): string | null {
  if (server.overrides.length > 0) return `本项目改了它的 ${server.overrides.join('、')}`;
  return server.readOnly;
}

/** @brief 这个服务那一行的"编辑"按钮（行里的第一个按钮）；没有时为 null。 */
function editButton(name: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-testid="mcp-row"][data-server="${CSS.escape(name)}"] .tools-row-actions button`);
}

/** @brief 通知里以"<服务名>:"开头的行（警示色），完整通知可以展开。 */
function McpErrors({ name, notices }: { name: string; notices: string[] }) {
  const related = notices.filter((notice) => serverLines(notice, name).length > 0);
  if (related.length === 0) return null;
  const lines = [...new Set(related.flatMap((notice) => serverLines(notice, name)))];
  return (
    <div className="tools-warn" data-testid="mcp-error">
      {lines.map((line) => <p key={line}>{line}</p>)}
      <details className="tools-full-notice">
        <summary>完整通知</summary>
        {related.map((notice, index) => <pre key={index}>{notice}</pre>)}
      </details>
    </div>
  );
}

/** @brief 服务行的说明：注册的工具、调用方式的警示、错误、不能改的原因、项目的覆盖、没能保存的原文。 */
function McpNotes({ server, notices, locked, error, onDirect }: {
  server: McpServerEntry; notices: string[]; locked: boolean; error: string | null; onDirect: () => void;
}) {
  const tools = server.tools;
  return (
    <>
      <p className="tools-mono">{commandLine(server)}</p>
      {tools && (
        <p className="tools-row-note" data-testid="mcp-tools">
          {tools.length > 0 ? `当前会话里注册的工具：${tools.join('、')}` : '当前会话里它没有注册工具'}</p>
      )}
      {server.exposure !== 'direct' && (
        <p className="tools-warn">
          v0 只支持直接调用（现在是 {exposureText(server.exposure)}）：模型调用不到它的工具
          <button type="button" className="text-link" data-testid="mcp-direct" disabled={locked}
            onClick={onDirect}>改为直接调用</button>
        </p>
      )}
      <McpErrors name={server.name} notices={notices} />
      {lockReason(server) && <p className="tools-row-note">{lockReason(server)}</p>}
      {error && <p className="form-message error" role="alert">没能保存：{error}</p>}
    </>
  );
}

/**
 * @brief 一个服务：名字、来源、调用方式、开关；命令行、工具名、错误；编辑、以 JSON 编辑、移除。
 *        它的表单开着时这一行的开关和按钮不可用（表单里切换写法；免得保存时盖掉刚做的启停）。
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
  // 表单没有地址一栏：HTTP 服务的"编辑"直接以 JSON 编辑。
  const editMode: McpFormMode = server.command === null ? 'json' : 'fields';
  return (
    <li className={`tools-row${power.checked ? '' : ' off'}`} data-testid="mcp-row" data-server={server.name}>
      <div className="tools-row-head">
        <div className="tools-row-main">
          <span className="tools-row-name">{server.name}</span>
          <span className="tools-tag">{server.scope === 'user' ? '用户级' : '本项目'}</span>
          <span className="tools-tag">{exposureText(server.exposure)}</span>
        </div>
        <ToolSwitch checked={power.checked} label={`启用 MCP 服务 ${server.name}`} disabled={locked}
          title={reason ?? undefined} onChange={power.toggle} />
      </div>
      <McpNotes server={server} notices={notices} locked={locked} error={change.error}
        onDirect={() => void change.run({ type: 'mcp.setDirect', name: server.name })} />
      <div className="tools-row-actions">
        <button type="button" className="text-link" disabled={locked} onClick={() => onEdit(editMode)}>编辑</button>
        <button type="button" className="text-link" disabled={locked} onClick={() => onEdit('json')}>以 JSON 编辑</button>
        <button type="button" className="text-link danger" disabled={locked} onClick={onRemove}>移除</button>
      </div>
    </li>
  );
}

/** @brief 移除确认框："移除 MCP 服务 <名字>？已经打开的会话不受影响。" */
function RemoveDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const change = useChange();
  async function confirm() {
    if (await change.run({ type: 'mcp.remove', name })) onClose();
  }
  return (
    <ConfirmDialog title={`移除 MCP 服务 ${name}？`} text="已经打开的会话不受影响。" confirmLabel="移除" tone="danger"
      testId="remove-dialog" busyText={change.busy ? '正在移除…' : null} error={change.error}
      onConfirm={() => void confirm()} onCancel={onClose} />
  );
}

/** @brief 配置读不出来的原文（警示色），每个文件一个"用系统编辑器打开"。 */
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
    // 焦点回到打开表单的按钮："添加"，或这个服务的"编辑"（改了名时找不到，焦点留在原处）。
    requestAnimationFrame(() => (name === null ? addButton.current : editButton(name))?.focus());
  }
  const form = (name: string | null) => editing && editing.name === name && (
    <McpForm server={editing.server} mode={editing.mode} onSaved={() => close(true)} onCancel={() => close(false)} />
  );
  return (
    <>
      <h2>MCP</h2>
      {saved && (
        <p className="form-message ok" role="status">已保存 · 新建的会话才会连接它
          <button type="button" className="text-link" onClick={() => void newSession()}>新建会话</button></p>
      )}
      <ConfigErrors errors={mcp.errors} cwd={cwd} />
      {mcp.servers.length === 0 && <p className="tools-empty">还没有 MCP 服务</p>}
      <ul className="tools-list">
        {mcp.servers.map((server) => (
          <McpServerItem key={`${server.scope}:${server.name}`} server={server} notices={notices}
            form={form(server.name)}
            onEdit={(mode) => open({ name: server.name, server, mode })} onRemove={() => setRemoving(server.name)} />
        ))}
      </ul>
      {form(null) || (
        <button ref={addButton} type="button" className="button" disabled={broken}
          title={broken ? '先修好读不出来的 mcp.json，免得覆盖它' : undefined}
          onClick={() => open({ name: null, server: null, mode: 'fields' })}>添加</button>
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
