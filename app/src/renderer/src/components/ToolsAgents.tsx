// Customize 的“Agents”一节（docs/specs/customize-agents.md §6；状态表 docs/v1/screens/customize-agents.md）：
// 基座 Mori 和这个项目 .mori/agents 里的每个文件一行（名字、标记、说明的第一行、职责、模型的一句话、有问题的文件的问题行），
// 点一行展开（Models、Model needs、Tools、Other settings、Prompt、File）；New agent 与 Edit 的表单、Delete… 的确认框。
// 只在有跟随的会话时出现；自己读 roles.get，不等 tools.get。表单有改动时登记离开检查（换分节、Back to app、点侧栏的会话、
// 打开别的表单都先问）。保存、删除之后已经打开的会话不变（§5.5），页面顶部本来就写着这一点。

import { useCallback, useEffect, useState } from 'react';
import {
  HANDOFF_TIER_NOTE, hasTierNeed, modelLine, modelsHeading, needText, otherSettings, seatsText, toolsText,
  type AgentView, type RolesInfo,
} from '../../../shared/roles';
import { guardLeave, setLeaveGuard } from '../state/leaveGuard';
import { deleteAgent, saveAgent, useRolesInfo } from '../state/roles';
import { Icon } from '../icons';
import { ConfirmDialog } from './ConfirmDialog';
import { OpenInEditor } from './ToolsCommon';
import { AgentForm, canSave, draftOf, initialValues, type FormStatus, type FormValues } from './ToolsAgentForm';

/** 这一节的说明（临时，§7） */
const INTRO = 'Agents Mori can hand work to in Task mode. They’re files in this project’s .mori/agents folder.';
/** 没有 agent 文件时（临时，§7） */
const EMPTY = 'No agents in this project yet. Mori does everything in Task mode until you add one.';
/** 有问题的文件时列表上方的警示 */
const INVALID = 'New sessions in this project won’t start until these agent files are fixed.';
/** 有改动时离开的确认（同 AGENTS.md 编辑器的离开确认） */
const LEAVE_TITLE = 'Discard this agent?';
const LEAVE_TEXT = 'Your edits haven’t been saved. Leaving now discards them.';

/** @brief 一行的键：文件的相对路径，基座为 mori。 */
const keyOf = (agent: AgentView) => agent.file ?? agent.name;

/** @brief 打开着的表单：新建，或编辑一个文件。 */
type OpenForm = { agent: AgentView | null; values: FormValues; initial: FormValues };

/** @brief 展开里 Models 一块：标题与每个候选（模型全名，Ready 或原因）。 */
function ModelsBlock({ agent, pick }: { agent: AgentView; pick: string | null }) {
  return (
    <section data-block="models">
      <h4>Models</h4>
      <p data-testid="agent-models-heading">{modelsHeading(agent.models, pick)}</p>
      {agent.candidates.length > 0 && (
        <ul className="agent-candidates">
          {agent.candidates.map((item) => (
            <li key={item.ref} data-testid="agent-candidate" data-ref={item.ref} data-ready={item.reason === null}>
              <span className="tools-mono">{item.ref}</span>
              <span className={item.reason === null ? 'agent-ready' : 'agent-reason'}>{item.reason ?? 'Ready'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** @brief 展开的一行（§6.3）；有问题的文件只有 File 一块。 */
function AgentDetail({ agent, info, onEdit, onDelete }: {
  agent: AgentView; info: RolesInfo; onEdit: () => void; onDelete: () => void;
}) {
  const valid = agent.problems.length === 0;
  const other = otherSettings(agent);
  return (
    <div className="tools-detail agent-detail" data-testid="agent-detail">
      {valid && <ModelsBlock agent={agent} pick={info.pick} />}
      {valid && agent.needs.length > 0 && (
        <section data-block="needs">
          <h4>Model needs</h4>
          <ul>{agent.needs.map((need) => <li key={need}>{needText(need)}</li>)}</ul>
          {hasTierNeed(agent.needs) && <p className="agent-note" data-testid="agent-tier-note">{HANDOFF_TIER_NOTE}</p>}
        </section>
      )}
      {valid && (
        <section data-block="tools"><h4>Tools</h4>
          <p data-testid="agent-tools">{toolsText(agent.tools, info.baseTools)}</p></section>)}
      {valid && other.length > 0 && (
        <section data-block="other"><h4>Other settings</h4>
          <ul>{other.map((line) => <li key={line}>{line}</li>)}</ul></section>)}
      {valid && (
        <section data-block="prompt"><h4>Prompt</h4>
          {agent.body ? <pre className="tools-body" data-testid="agent-prompt">{agent.body}</pre>
            : <p className="muted" data-testid="agent-prompt">No prompt</p>}</section>)}
      {agent.file && agent.path && (
        <section data-block="file"><h4>File</h4>
          <p className="tools-mono" data-testid="agent-file">{agent.file}</p>
          <div className="tools-row-actions">
            {valid && (
              <button type="button" className="text-link" data-action="edit-agent" onClick={onEdit}>Edit</button>)}
            <OpenInEditor path={agent.path} cwd={info.cwd} />
            <button type="button" className="text-link danger" data-action="delete-agent" onClick={onDelete}>
              Delete…</button>
          </div>
        </section>
      )}
    </div>
  );
}

/** @brief 一行的属性。 */
interface RowProps {
  agent: AgentView;
  info: RolesInfo;
  open: boolean;
  saved: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** @brief 一个 agent 一行（§6.2）。 */
function AgentRow({ agent, info, open, saved, onToggle, onEdit, onDelete }: RowProps) {
  const builtin = agent.file === null;
  const valid = agent.problems.length === 0;
  const jobs = seatsText(agent.seats);
  const line = modelLine(agent.candidates);
  const description = agent.description.split('\n')[0];
  return (
    <li className="tools-row agent-row" data-testid="agent-row" data-name={agent.name}
      data-scope={builtin ? 'builtin' : 'project'} data-valid={valid} aria-expanded={open}>
      <div className="tools-row-head">
        <button type="button" className="tools-row-main" data-testid="agent-toggle" aria-expanded={open}
          onClick={onToggle}>
          <Icon name="chevron" className="tools-chevron" />
          <span className="tools-row-name" data-testid="agent-name">{builtin ? 'Mori' : agent.name}</span>
          <span className="tools-tag" data-testid="agent-tag">{builtin ? 'Built-in' : 'Project'}</span>
          {!valid && <span className="tools-tag warn" data-testid="agent-tag">Can’t be used</span>}
          {description && <span className="tools-row-desc" data-testid="agent-description"
            title={agent.description}>{description}</span>}
        </button>
      </div>
      {valid && jobs && <p className="tools-row-note" data-testid="agent-jobs">{jobs}</p>}
      {valid && <p className={`tools-row-note agent-models ${line.state}`} data-testid="agent-models"
        data-state={line.state}>{line.text}</p>}
      {agent.problems.map((problem, index) => (
        <p key={index} className="tools-warn" data-testid="agent-problem">{`${agent.file}: ${problem}`}</p>))}
      {saved && <p className="form-message ok" data-testid="agent-saved">Saved · Applies to new sessions</p>}
      {open && <AgentDetail agent={agent} info={info} onEdit={onEdit} onDelete={onDelete} />}
    </li>
  );
}

/** @brief 表单有改动时登记离开检查；Discard 时收起表单。 */
function useFormGuard(form: OpenForm | null, close: () => void): void {
  const dirty = form !== null && JSON.stringify(form.values) !== JSON.stringify(form.initial);
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard({ title: LEAVE_TITLE, text: LEAVE_TEXT, discard: close });
    return () => setLeaveGuard(null);
  }, [dirty, close]);
}

/** @brief 等确认的删除。 */
interface Deleting {
  agent: AgentView;
  busy: boolean;
  error: string | null;
}

/** @brief 表单、展开、刚保存的行与删除确认的状态和操作。 */
function useAgentsPage(sessionId: string, read: ReturnType<typeof useRolesInfo>) {
  const [form, setForm] = useState<OpenForm | null>(null);
  const [status, setStatus] = useState<FormStatus>({ saving: false, error: null });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const close = useCallback(() => {
    setForm(null);
    setStatus({ saving: false, error: null });
  }, []);
  useFormGuard(form, close);
  const openForm = (agent: AgentView | null) => guardLeave(() => {
    const values = initialValues(agent);
    setForm({ agent, values, initial: values });
    setStatus({ saving: false, error: null });
  });
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  async function save() {
    if (!form || !canSave(form.values)) return;
    setStatus({ saving: true, error: null });
    const result = await saveAgent(sessionId, form.agent?.file ?? null, draftOf(form.values));
    if (result.error !== null || !result.info || !result.file) {
      setStatus({ saving: false, error: result.error ?? 'No result' });
      return;
    }
    read.replace(result.info);
    close();
    setOpen((current) => new Set(current).add(result.file as string));
    setSaved(result.file);
  }
  async function remove() {
    if (!deleting?.agent.file) return;
    setDeleting({ ...deleting, busy: true, error: null });
    const result = await deleteAgent(sessionId, deleting.agent.file, deleting.agent.name);
    if (result.error !== null || !result.info) {
      setDeleting({ ...deleting, busy: false, error: result.error ?? 'No result' });
      return;
    }
    read.replace(result.info);
    setDeleting(null);
  }
  return { form, setForm, status, open, saved, deleting, setDeleting, close, openForm, toggle, save, remove };
}

/** @brief 标题、右边的 New agent（读到之后才有）与一行说明（§6.1）。 */
function Header({ onNew }: { onNew?: () => void }) {
  return (
    <>
      <div className="agents-roles-head">
        <h2>Agents</h2>
        {onNew && <button type="button" className="button" data-action="new-agent" onClick={onNew}>New agent</button>}
      </div>
      <p className="tools-lead" data-testid="agents-intro">{INTRO}</p>
    </>
  );
}

/** @brief 读到之后的内容：标题、警示、表单、列表、空状态、删除确认。 */
function AgentsContent({ sessionId, info, read, failure }: {
  sessionId: string; info: RolesInfo; read: ReturnType<typeof useRolesInfo>; failure: React.ReactNode;
}) {
  const page = useAgentsPage(sessionId, read);
  const { form, deleting } = page;
  const set = (next: Partial<FormValues>) => page.setForm((current) => (current
    ? { ...current, values: { ...current.values, ...next } } : current));
  return (
    <>
      <Header onNew={() => page.openForm(null)} />
      {failure}
      {info.problems.length > 0 && <p className="tools-warn" role="status" data-testid="agents-invalid">{INVALID}</p>}
      {form && (
        <AgentForm agent={form.agent} values={form.values} set={set} info={info} status={page.status}
          onSave={() => void page.save()} onCancel={page.close} />)}
      <ul className="tools-list">
        {info.agents.map((agent) => (
          <AgentRow key={keyOf(agent)} agent={agent} info={info} open={page.open.has(keyOf(agent))}
            saved={page.saved !== null && page.saved === agent.file} onToggle={() => page.toggle(keyOf(agent))}
            onEdit={() => page.openForm(agent)}
            onDelete={() => page.setDeleting({ agent, busy: false, error: null })} />
        ))}
      </ul>
      {info.agents.length === 1 && <p className="tools-empty" data-testid="agents-empty">{EMPTY}</p>}
      {deleting && (
        <ConfirmDialog title={`Delete agent “${deleting.agent.name}”?`}
          text={`${deleting.agent.file} will be permanently deleted. This can’t be undone. Sessions already open `
            + 'aren’t affected.'}
          confirmLabel="Delete" tone="danger" testId="agent-delete-dialog" busyText={deleting.busy ? 'Deleting…' : null}
          error={deleting.error && `Couldn’t delete: ${deleting.error}`}
          onConfirm={() => void page.remove()} onCancel={() => page.setDeleting(null)} />
      )}
    </>
  );
}

/**
 * @brief “Agents”一节（§6.1）：跟随的会话还在打开中、或还没读到时标题、说明与 Loading…；读不出时原文与 Retry。
 * @param sessionId 跟随的会话；还在打开中时为 null
 */
export function AgentsRolesSection({ sessionId }: { sessionId: string | null }) {
  const read = useRolesInfo(sessionId);
  const { info, error } = read;
  const failure = error && (
    <p className="form-message error" role="alert" data-testid="agents-error">Couldn’t load agents: {error}
      <button type="button" className="text-link" onClick={() => void read.reload()}>Retry</button></p>);
  return (
    <div className="agents-roles" data-testid="agents-page">
      {info && sessionId ? <AgentsContent sessionId={sessionId} info={info} read={read} failure={failure} /> : (
        <>
          <Header />
          {failure}
          {!error && <p className="tools-empty" role="status">Loading…</p>}
        </>
      )}
    </div>
  );
}
