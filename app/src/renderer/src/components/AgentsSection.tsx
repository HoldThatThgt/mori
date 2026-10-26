// Customize 的"Instructions"一节（docs/v1/screens/customize-agents-md.md；2026-10-26 负责人走查 M4 从设置页挪来，
// 负责人定名 Instructions、放在最后一节，第一行说明它就是每个会话都读的 AGENTS.md）：
// 用户级 AGENTS.md 的编辑器（有未保存的改动时离开先问），和 Customize 跟随的会话的项目加载了哪些文件（只列出，可以用
// "Open in default app"打开）。每个文件的 token 数与合计超过 AGENTS_LIMIT 的警告（docs/specs/memory.md §10.3）写在单独的
// 元素里，路径与生效说明的文字不变。这一节不读 tools.get，不受它的读取中与读取失败影响。
// 后台进程不在时（退出、重新载入中）读到过的不重新读取，连上后重新读取。

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AGENTS_LIMIT } from '../../../shared/memory';
import type { AgentsInfo } from '../../../shared/protocol';
import { describe, request } from '../state/bridge';
import { setLeaveGuard, useLeave } from '../state/leaveGuard';
import type { Notice } from '../state/settings';
import { useApp } from '../state/store';
import { folderName } from './ChatPane';
import { thousands } from './settings/format';

/** 这一节的第一行：说明写在这里的就是每个会话都读的 AGENTS.md（照 Claude 桌面版 Global instructions 的说明） */
const INTRO_TEXT = 'Instructions here are saved in the AGENTS.md file that every session reads. Use this for '
  + 'preferences, conventions, or context that Mori should always know.';

/** 后台进程退出后项目一栏的说明（同侧栏入口的悬停） */
const CRASHED_TEXT = 'Mori’s background process crashed. Restart it to continue.';

/** 有未保存的改动时离开确认框的标题 */
const LEAVE_TITLE = 'Discard changes to AGENTS.md?';
/** 有未保存的改动时离开确认框的说明 */
export const LEAVE_TEXT = 'Your edits haven’t been saved. Leaving now discards them.';

/** @brief AGENTS.md 合计超过提醒线时的警告（§10.3，Customize 与记忆页的 AGENT 节共用）。 */
export const AGENTS_OVER_TEXT = `Over ${thousands(AGENTS_LIMIT)} tokens. Mori doesn’t shorten AGENTS.md; edit the `
  + 'files to keep prompts short.';

/** @brief 一个文件的 token 数：`<n> tokens`（1000 起按千分位写），1 时 `1 token`（§10.3）。 */
export function tokenCount(count: number): string {
  return count === 1 ? '1 token' : `${thousands(count)} tokens`;
}

/** @brief Instructions 一节跟随的项目：Customize 跟随的会话。 */
export interface AgentsProject {
  /** pi 会话 id；会话还在打开中时为 null（打开好后重新读取） */
  sessionId: string | null;
  /** 会话的工作目录（标题里写它的文件夹名） */
  cwd: string;
}

/** @brief 读到的 AGENTS.md 信息与读它时带的会话。 */
interface AgentsRead {
  /** agents.get 的结果；还没读到时为 null */
  info: AgentsInfo | null;
  /** 读这份结果时带的会话 id；没带会话时为 null */
  readFor: string | null;
}

/** @brief 保存的状态。 */
type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; error: string };

/** @brief 文件所在的文件夹（用系统编辑器打开时的工作目录；路径本身是绝对路径）。 */
function parentDir(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}

/**
 * @brief 读取 AGENTS.md 的信息（agents.get，带跟随的会话）；跟随的会话换了、后台进程重新连上时重新读取，只有最后一次读取的
 *        结果生效。失败时记下原文，之前读到的内容留着（编辑框里没保存的字不丢）。setContent 在保存成功后先记下新内容。
 * @param live 后台进程已连上；为假时（退出、重新载入中）读到过就不再读（退出时跟随的会话 id 清掉也不重新读），
 *        还没读到过时照常读（失败时显示原文，连上后再读）
 */
function useAgentsInfo(sessionId: string | null, live: boolean) {
  const [read, setRead] = useState<AgentsRead>({ info: null, readFor: null });
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const known = useRef(false);
  const load = useCallback(async () => {
    latest.current += 1;
    const current = latest.current;
    try {
      const info = await request<AgentsInfo>({ type: 'agents.get', sessionId: sessionId ?? undefined });
      if (current !== latest.current) return;
      known.current = true;
      setRead({ info, readFor: sessionId });
      setError(null);
    } catch (failure) {
      const message = describe('agents.get', failure);
      if (current === latest.current) setError(message);
    }
  }, [sessionId]);
  useEffect(() => {
    if (live || !known.current) void load();
  }, [load, live]);
  const setContent = useCallback((content: string) => {
    setRead((current) => (current.info ? { ...current, info: { ...current.info, content } } : current));
  }, []);
  return { ...read, error, load, setContent };
}

/**
 * @brief 有未保存的改动时登记离开检查；你选"Discard"时 discard 丢掉改动，选"Keep editing"后焦点回到编辑框。
 * @param discard 回到读到的内容（不随渲染变化）
 */
function useLeaveCheck(dirty: boolean, editor: RefObject<HTMLTextAreaElement | null>, discard: () => void): void {
  const asking = useLeave((state) => state.proceed !== null);
  const wasAsking = useRef(false);
  // 你选"Discard"时 leaveGuard 先取消检查再丢掉改动：编辑框回到读到的内容，不再有未保存的改动。
  // 离开没有发生（例如"Open folder…"时取消了选择）时也一样，屏幕上不会留下没有检查的改动。
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard({ title: LEAVE_TITLE, text: LEAVE_TEXT, discard });
    return () => setLeaveGuard(null);
  }, [dirty, discard]);
  useEffect(() => {
    if (wasAsking.current && !asking && dirty) editor.current?.focus();
    wasAsking.current = asking;
  }, [asking, dirty, editor]);
}

/** @brief 编辑框里的文字、是否有未保存的改动、保存（Ctrl+S 也可以）与"Discard changes"。 */
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
  // "Discard changes"、离开确认框的"Discard"：回到读到的内容。只用 setState，登记离开检查时拿到的函数一直可用。
  const revert = useCallback(() => {
    setDraft(null);
    setStatus((current) => (current.kind === 'saving' ? current : { kind: 'idle' }));
  }, []);
  return { value, dirty, status, save, change, revert };
}

/** @brief 编辑框旁边的一行：保存中、保存失败、有未保存的改动、已保存。 */
function statusNotice(status: SaveStatus, dirty: boolean): Notice | null {
  if (status.kind === 'saving') return { tone: 'info', text: 'Saving…' };
  if (status.kind === 'failed') return { tone: 'error', text: `Couldn’t save: ${status.error}` };
  if (dirty) return { tone: 'info', text: 'Unsaved changes' };
  return status.kind === 'saved' ? { tone: 'ok', text: 'Saved · Applies to new sessions' } : null;
}

/**
 * @brief "Open in default app"（主进程 openPath）；打不开时显示原文。disabled 时不可用、悬停 title
 *        （记忆页在后台进程退出时，§10.10）。
 */
export function OpenInEditor({ path, cwd, disabled = false, title }: {
  path: string; cwd: string; disabled?: boolean; title?: string;
}) {
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
      <button className="text-link" disabled={disabled} title={title} onClick={() => void open()}>
        Open in default app</button>
      {error && (
        <p className="form-message error agents-open-error" role="alert">
          Couldn’t open this file with the default app: {error}
        </p>
      )}
    </>
  );
}

/** pi 在一个目录里排在 AGENTS.md 前面的只有它（resource-loader.js loadContextFileFromDir 的候选顺序） */
const OVERRIDE_FILE = /[\\/]AGENTS\.override\.md$/;

/**
 * @brief 生效的文件那一行的文字。pi 在 agentDir 里取 AGENTS.override.md、AGENTS.md、AGENTS.MD、CLAUDE.md、CLAUDE.MD
 *        中第一个存在的：是用户级 AGENTS.md 时"In effect"；是 AGENTS.override.md 时这里写的不会生效；
 *        是 CLAUDE.md（还没有 AGENTS.md）时保存后改读 AGENTS.md，它不再加载。
 */
function effectiveText(path: string, userPath: string): { warn: boolean; text: string } {
  if (path === userPath) return { warn: false, text: `In effect: ${path}` };
  if (OVERRIDE_FILE.test(path)) {
    return { warn: true, text: `${path} takes precedence, so what you write here has no effect.` };
  }
  return { warn: true, text: `${path} is in effect now. After you save, this AGENTS.md is loaded instead.` };
}

/**
 * @brief 生效的文件：文字见 effectiveText，后面单独一个元素写它的 token 数（§10.3）；可以用"Open in default app"打开它
 *        （例如先把 CLAUDE.md 的内容抄过来）。
 */
function EffectiveFile({ info }: { info: AgentsInfo }) {
  const path = info.effectivePath;
  if (!path) return null;
  const { warn, text } = effectiveText(path, info.userPath);
  return (
    <div className="agents-line">
      <span className={warn ? 'agents-effective warn' : 'agents-effective'} data-testid="agents-effective">{text}</span>
      <span className="agents-token-count" data-testid="agents-tokens">{tokenCount(info.userTokens)}</span>
      <OpenInEditor path={path} cwd={parentDir(path)} />
    </div>
  );
}

/** @brief 合计超过提醒线时的警告（§10.3）；没有超过时不显示。 */
function AgentsOver({ total }: { total: number }) {
  if (total <= AGENTS_LIMIT) return null;
  return <p className="form-message agents-over" role="status" data-testid="agents-over">{AGENTS_OVER_TEXT}</p>;
}

/** @brief 用户级 AGENTS.md：路径、生效的文件、编辑框、"Save"与"Discard changes"。 */
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
      <h3>User</h3>
      <p className="muted">Changes apply to new sessions only; sessions already open don’t change.</p>
      {!info && <p className="muted" role="status">Loading…</p>}
      {info && <p className="agents-path">{info.userPath}</p>}
      {info?.content === null && <p className="muted">This file doesn’t exist yet. Saving creates it.</p>}
      {info && <EffectiveFile info={info} />}
      <textarea ref={editor} className="agents-editor" data-testid="agents-editor" aria-label="User-level AGENTS.md"
        value={value} disabled={!info} spellCheck={false} onChange={(event) => change(event.target.value)} />
      <div className="form-actions">
        <button className="button primary" disabled={!dirty || status.kind === 'saving'} onClick={() => void save()}>
          Save</button>
        <button className="button" disabled={!dirty || status.kind === 'saving'} onClick={revert}>
          Discard changes</button>
        {notice && <span className={`form-message ${notice.tone} agents-status`} role="status">{notice.text}</span>}
      </div>
    </div>
  );
}

/** @brief 项目加载的文件：说明、每个文件一行路径与 token 数（可以用"Open in default app"打开），没有时说明没有。 */
function LoadedFiles({ loaded, cwd }: { loaded: NonNullable<AgentsInfo['loaded']>; cwd: string }) {
  return (
    <>
      <p className="muted">
        Read when the session opens. If you change a file later, only new sessions pick it up. Project files can’t be
        edited here.
      </p>
      {loaded.length === 0 && <p className="tools-empty">This project doesn’t load an AGENTS.md or CLAUDE.md</p>}
      <ul className="agents-files">
        {loaded.map((file) => (
          <li key={file.path}>
            <span className="agents-path">{file.path}</span>
            <span className="agents-tokens">{tokenCount(file.tokens)}</span>
            <OpenInEditor path={file.path} cwd={cwd} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * @brief 项目级（只列出）：跟随的会话的资源加载器实际加载的文件与各自的 token 数，不含 agentDir 里的那个。
 *        还没读到这个会话的结果时（会话还在打开中、换了会话）标题下"Loading…"，后台进程退出时换成退出的说明；
 *        没有跟随的会话时说明怎样才看得到。
 * @param loaded 跟随的会话的 loaded；还没读到时为 null
 * @param crashed 后台进程已退出
 */
function ProjectAgents({ project, loaded, crashed }: {
  project: AgentsProject | null; loaded: AgentsInfo['loaded']; crashed: boolean;
}) {
  if (!project) {
    return (
      <div className="agents-project" data-testid="agents-loaded">
        <h3>Files loaded by the project</h3>
        <p className="muted">Open a session to see which files its project loads.</p>
      </div>
    );
  }
  let body = <p className="muted" role="status">Loading…</p>;
  if (loaded) body = <LoadedFiles loaded={loaded} cwd={project.cwd} />;
  else if (crashed) body = <p className="muted">{CRASHED_TEXT}</p>;
  return (
    <div className="agents-project" data-testid="agents-loaded">
      <h3>Files loaded by {folderName(project.cwd)}</h3>
      {body}
    </div>
  );
}

/**
 * @brief "Instructions"一节（标题下第一行说明它就是每个会话都读的 AGENTS.md）：每次换到这一节时重新读取，跟随的会话换了、后台进程重新连上时再读；读取失败时在顶部显示原文
 *        （第一次就失败时没有编辑框；之后的失败留着读到过的内容，还没读到跟随的会话的项目文件时不显示项目一栏，
 *        后台进程退出时项目一栏照样写退出的说明）。
 * @param project Customize 跟随的会话；没有时为 null
 */
export function AgentsSection({ project }: { project: AgentsProject | null }) {
  const kernel = useApp((state) => state.kernel);
  const crashed = kernel === 'exited';
  const sessionId = project?.sessionId ?? null;
  const { info, readFor, error, load, setContent } = useAgentsInfo(sessionId, kernel === 'ready');
  // 跟随的会话的项目文件：读到的就是这个会话的结果时才有（会话还在打开中时没有 pi 会话 id）。
  const listed = info && sessionId !== null && readFor === sessionId ? info.loaded : null;
  // 保存后先记下内容，再重新读取（新建文件后生效的文件可能变了）。
  const onSaved = (content: string) => {
    setContent(content);
    void load();
  };
  return (
    <div className="agents-section" data-testid="agents-section">
      <h2>Instructions</h2>
      <p className="tools-lead" data-testid="agents-intro">{INTRO_TEXT}</p>
      {error && <p className="form-message error" role="alert">Couldn’t load AGENTS.md: {error}</p>}
      {(info || !error) && <UserAgents info={info} onSaved={onSaved} />}
      {info && (listed || !error || crashed) && <ProjectAgents project={project} loaded={listed} crashed={crashed} />}
      {info && readFor === sessionId && <AgentsOver total={info.total} />}
    </div>
  );
}
