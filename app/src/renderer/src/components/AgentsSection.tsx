// 设置页的"AGENTS.md"（docs/v0/screens/settings.md）：用户级 AGENTS.md 的编辑器（有未保存的改动时离开先问），
// 和焦点会话的项目加载了哪些文件（只列出，可以用系统编辑器打开）。

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { AgentsInfo } from '../../../shared/protocol';
import { describe, request } from '../state/bridge';
import { setLeaveGuard, useLeave } from '../state/leaveGuard';
import { focusedSession, type FocusedSession, type Notice } from '../state/settings';
import { folderName } from './ChatPane';

/** 有未保存的改动时离开确认框的说明 */
const LEAVE_TEXT = '你改的内容还没有保存。';

/** @brief 保存的状态。 */
type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; error: string };

/** @brief 文件所在的文件夹（用系统编辑器打开时的工作目录；路径本身是绝对路径）。 */
function parentDir(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}

/** @brief 读取 AGENTS.md 的信息（agents.get，带焦点会话）；load 重新读取，已有信息时失败只记日志。 */
function useAgentsInfo(session: FocusedSession | null) {
  const [info, setInfo] = useState<AgentsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setInfo(await request<AgentsInfo>({ type: 'agents.get', sessionId: session?.sessionId }));
      setError(null);
    } catch (failure) {
      setError(describe('agents.get', failure));
    }
  }, [session]);
  useEffect(() => {
    void load();
  }, [load]);
  return { info, setInfo, error, load };
}

/**
 * @brief 有未保存的改动时登记离开检查；你选"放弃改动"时 discard 丢掉改动，选"继续编辑"后焦点回到编辑框。
 * @param discard 回到读到的内容（不随渲染变化）
 */
function useLeaveCheck(dirty: boolean, editor: RefObject<HTMLTextAreaElement | null>, discard: () => void): void {
  const asking = useLeave((state) => state.proceed !== null);
  const wasAsking = useRef(false);
  // 你选"放弃改动"时 leaveGuard 先取消检查再丢掉改动：编辑框回到读到的内容，不再有未保存的改动。
  // 离开没有发生（例如"打开文件夹"时取消了选择）时也一样，屏幕上不会留下没有检查的改动。
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard({ text: LEAVE_TEXT, discard });
    return () => setLeaveGuard(null);
  }, [dirty, discard]);
  useEffect(() => {
    if (wasAsking.current && !asking && dirty) editor.current?.focus();
    wasAsking.current = asking;
  }, [asking, dirty, editor]);
}

/** @brief 编辑框里的文字、是否有未保存的改动、保存（Ctrl+S 也可以）与撤销改动。 */
function useAgentsEditor(info: AgentsInfo | null, onSaved: (content: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const saved = info?.content ?? '';
  const value = draft ?? saved;
  const dirty = info !== null && value !== saved;
  async function save() {
    if (!dirty || status.kind === 'saving') return;
    const content = value;
    setStatus({ kind: 'saving' });
    try {
      await request({ type: 'agents.save', content });
      setStatus({ kind: 'saved' });
      onSaved(content);
    } catch (error) {
      setStatus({ kind: 'failed', error: describe('agents.save', error) });
    }
  }
  function change(next: string) {
    setDraft(next);
    if (status.kind !== 'saving') setStatus({ kind: 'idle' });
  }
  // 撤销改动、放弃改动：回到读到的内容。只用 setState，登记离开检查时拿到的函数一直可用。
  const revert = useCallback(() => {
    setDraft(null);
    setStatus((current) => (current.kind === 'saving' ? current : { kind: 'idle' }));
  }, []);
  return { value, dirty, status, save, change, revert };
}

/** @brief 编辑框旁边的一行：保存中、保存失败、有未保存的改动、已保存。 */
function statusNotice(status: SaveStatus, dirty: boolean): Notice | null {
  if (status.kind === 'saving') return { tone: 'info', text: '保存中…' };
  if (status.kind === 'failed') return { tone: 'error', text: `保存失败：${status.error}` };
  if (dirty) return { tone: 'info', text: '有未保存的改动' };
  return status.kind === 'saved' ? { tone: 'ok', text: '已保存 · 新建的会话才会读到' } : null;
}

/** @brief "用系统编辑器打开"（主进程 openPath）；打不开时显示原文。 */
function OpenInEditor({ path, cwd }: { path: string; cwd: string }) {
  const [error, setError] = useState<string | null>(null);
  async function open() {
    try {
      setError((await window.mori.openPath(path, cwd)).error);
    } catch (failure) {
      setError(describe('openPath', failure));
    }
  }
  return (
    <>
      <button className="text-link" onClick={() => void open()}>用系统编辑器打开</button>
      {error && <p className="form-message error agents-open-error" role="alert">没能用系统编辑器打开：{error}</p>}
    </>
  );
}

/** pi 在一个目录里排在 AGENTS.md 前面的只有它（resource-loader.js loadContextFileFromDir 的候选顺序） */
const OVERRIDE_FILE = /[\\/]AGENTS\.override\.md$/;

/**
 * @brief 生效的文件那一行的文字。pi 在 agentDir 里取 AGENTS.override.md、AGENTS.md、AGENTS.MD、CLAUDE.md、CLAUDE.MD
 *        中第一个存在的：是用户级 AGENTS.md 时"生效中"；是 AGENTS.override.md 时这里写的不会生效；
 *        是 CLAUDE.md（还没有 AGENTS.md）时保存后改读 AGENTS.md，它不再加载。
 */
function effectiveText(path: string, userPath: string): { warn: boolean; text: string } {
  if (path === userPath) return { warn: false, text: `生效中：${path}` };
  if (OVERRIDE_FILE.test(path)) return { warn: true, text: `生效的是 ${path}，这里写的不会生效` };
  return { warn: true, text: `现在生效的是 ${path}；保存后改读这里的 AGENTS.md，它不再加载` };
}

/** @brief 生效的文件：文字见 effectiveText；可以用系统编辑器打开它（例如先把 CLAUDE.md 的内容抄过来）。 */
function EffectiveFile({ info }: { info: AgentsInfo }) {
  const path = info.effectivePath;
  if (!path) return null;
  const { warn, text } = effectiveText(path, info.userPath);
  return (
    <div className="agents-line">
      <span className={warn ? 'agents-effective warn' : 'agents-effective'} data-testid="agents-effective">{text}</span>
      <OpenInEditor path={path} cwd={parentDir(path)} />
    </div>
  );
}

/** @brief 用户级 AGENTS.md：路径、生效的文件、编辑框、保存与撤销改动。 */
function UserAgents({ info, onSaved }: { info: AgentsInfo | null; onSaved: (content: string) => void }) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const { value, dirty, status, save, change, revert } = useAgentsEditor(info, onSaved);
  useLeaveCheck(dirty, editor, revert);
  const notice = statusNotice(status, dirty);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.code !== 'KeyS' || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    event.preventDefault();
    void save();
  }
  return (
    <div className="agents-user" onKeyDown={onKeyDown}>
      <h3>用户级</h3>
      <p className="muted">每个会话都会读到；只对之后新建的会话生效，已经打开的会话不变。</p>
      {!info && <p className="muted" role="status">正在读取…</p>}
      {info && <p className="agents-path">{info.userPath}</p>}
      {info?.content === null && <p className="muted">还没有这个文件，保存后创建</p>}
      {info && <EffectiveFile info={info} />}
      <textarea ref={editor} className="agents-editor" data-testid="agents-editor" aria-label="用户级 AGENTS.md"
        value={value} disabled={!info} spellCheck={false} onChange={(event) => change(event.target.value)} />
      <div className="form-actions">
        <button className="button primary" disabled={!dirty || status.kind === 'saving'} onClick={() => void save()}>
          保存</button>
        <button className="button" disabled={!dirty || status.kind === 'saving'} onClick={revert}>撤销改动</button>
        {notice && <span className={`form-message ${notice.tone} agents-status`} role="status">{notice.text}</span>}
      </div>
    </div>
  );
}

/** @brief 项目级（只列出）：焦点会话的资源加载器实际加载的文件，不含 agentDir 里的那个。 */
function ProjectAgents({ session, loaded }: { session: FocusedSession | null; loaded: string[] | null }) {
  if (!session || !loaded) {
    return (
      <div className="agents-project" data-testid="agents-loaded">
        <h3>项目加载的文件</h3>
        <p className="muted">打开一个会话后，这里列出它的项目加载了哪些文件。</p>
      </div>
    );
  }
  return (
    <div className="agents-project" data-testid="agents-loaded">
      <h3>{folderName(session.cwd)} 加载的文件</h3>
      <p className="muted">会话打开时读取；之后改了文件，新会话才会读到。项目里的文件不能在这里编辑。</p>
      {loaded.length === 0 && <p className="settings-empty">这个项目没有加载 AGENTS.md 或 CLAUDE.md</p>}
      <ul className="agents-files">
        {loaded.map((path) => (
          <li key={path}><span className="agents-path">{path}</span><OpenInEditor path={path} cwd={session.cwd} /></li>
        ))}
      </ul>
    </div>
  );
}

/** @brief "AGENTS.md"一节：每次换到这一节时重新读取；读取失败时显示原文。 */
export function AgentsSection() {
  const [session] = useState(focusedSession);
  const { info, setInfo, error, load } = useAgentsInfo(session);
  // 保存后先记下内容，再重新读取（新建文件后生效的文件可能变了）。
  const onSaved = (content: string) => {
    setInfo((current) => current && { ...current, content });
    void load();
  };
  return (
    <div className="settings-section" data-section="agents">
      <h2>AGENTS.md</h2>
      {error && !info ? <p className="form-message error" role="alert">读取失败：{error}</p> : (
        <>
          <UserAgents info={info} onSaved={onSaved} />
          {info && <ProjectAgents session={session} loaded={info.loaded} />}
        </>
      )}
    </div>
  );
}
