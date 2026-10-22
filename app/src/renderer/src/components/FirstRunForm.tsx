// 首次启动表单（规格 §9.1 "首次启动表单"，docs/v1/screens/first-run.md）：填一个提供商和它的一个模型，
// "Test connection"有改动时先保存（models.firstRun：一次写入提供商、模型、key 和 normalDefault；同一张表单再次保存时
// 整体替换这个提供商和它唯一的模型），再测；成功后显示"Open folder…"和表单下方的探针状态。

import { useState } from 'react';
import type { ModelsResult, ProfileView, ProviderSaved } from '../../../shared/models';
import { openFolder } from '../state/projects';
import { describe, request } from '../state/bridge';
import { cancelTest, runTest, useProfile, type Notice } from '../state/settings';
import { useApp } from '../state/store';
import { Icon } from '../icons';
import { folderName } from './ChatPane';
import { NoticeLine } from './settings/common';
import {
  ApiRow, CompatChecks, emptyModel, emptyProvider, hasErrors, modelErrors, ModelFields, providerErrors,
  providerPatch, shownErrors, TextRow, toModel, toProviderForm, useDraft, ZoneRadios,
} from './settings/fields';
import '../styles/models-settings.css';

/** @brief 表单所处的阶段。 */
type Phase = 'idle' | 'saving' | 'testing';

/** @brief 探针状态与文字：验证中、已验证、验证失败（detail 取第 3、4 步里判定不通过的那一步）。 */
function probeText(profile: ProfileView | null, running: boolean): { state: string; text: string } {
  if (running || !profile || profile.status === 'probing' || profile.tool_calling.state === 'unverified') {
    return { state: 'verifying', text: 'Verifying tool calling…' };
  }
  if (profile.tool_calling.state === 'verified') return { state: 'verified', text: 'Tool calling verified' };
  const { call, result } = profile.tool_calling;
  const detail = [call, result].find((step) => step.outcome === 'fail')?.detail ?? '';
  return { state: 'failed', text: `Tool calling failed verification: ${detail}. Mori needs tool calling for the main`
    + ' agent; pick another model or check the server’s tool-call settings.' };
}

/** @brief 表单下方的探针状态（first-run.md "探针状态"）；探针出错时"Couldn't verify"与"Verify again"。 */
function ProbeStatus({ modelRef }: { modelRef: string }) {
  const { profile, running } = useProfile(modelRef);
  const [error, setError] = useState<string | null>(null);
  async function verify() {
    try {
      const result = await request<ModelsResult>({ type: 'models.verify', refs: [modelRef], tests: 'auto' });
      setError(result.error);
    } catch (failure) {
      setError(describe('models.verify', failure));
    }
  }
  if (!running && profile?.status === 'error') {
    return (
      <div className="probe-status" data-testid="probe-status" data-state="error">
        <p className="form-message error">Couldn’t verify: {profile.error}</p>
        <button className="button compact" data-action="verify" onClick={() => void verify()}>Verify again</button>
        {error && <p className="form-message error" role="alert">{error}</p>}
      </div>
    );
  }
  const { state, text } = probeText(profile, running);
  const tone = state === 'failed' ? 'error' : state === 'verified' ? 'ok' : 'info';
  return <p className={`form-message ${tone}`} data-testid="probe-status" data-state={state}>{text}</p>;
}

/** @brief 测试成功后的"Open folder…"：正在打开时显示文件夹名，失败时显示原文。 */
function OpenFolder() {
  const tabs = useApp((state) => state.tabs);
  const last = tabs[tabs.length - 1];
  const opening = last?.phase === 'opening';
  return (
    <div className="first-run-open" data-testid="open-folder">
      <button className="button primary" disabled={opening} onClick={() => void openFolder()}>
        <Icon name="folder" />Open folder…
      </button>
      {opening && <p className="muted">Opening {folderName(last.cwd)}…</p>}
      {last?.phase === 'failed' && <p className="form-message error">Failed to open session: {last.error}</p>}
    </div>
  );
}

/** @brief 表单状态、保存（models.firstRun）与测试。 */
function useFirstRun() {
  const provider = useDraft(emptyProvider);
  const model = useDraft(emptyModel);
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState<{ providerId: string; modelId: string; key: boolean } | null>(null);
  const [dirty, setDirty] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<Notice | null>(null);
  const [tested, setTested] = useState(false);
  const errors = { ...providerErrors(provider.draft), ...modelErrors(model.draft, []) };
  const touched = new Set([...provider.touched, ...model.touched]);
  const mark = () => setDirty(true);
  async function save(): Promise<{ providerId: string; modelId: string } | null> {
    if (!dirty && saved) return saved;
    setPhase('saving');
    try {
      const result = await request<ProviderSaved>({ type: 'models.firstRun', providerId: saved?.providerId ?? null,
        provider: toProviderForm(provider.draft), model: toModel(model.draft), keySecret: secret || null });
      if (result.error !== null) throw new Error(result.error);
      const key = Boolean(secret) || Boolean(saved?.key);
      const next = { providerId: result.providerId, modelId: model.draft.id, key };
      setSaved(next);
      setDirty(false);
      setSecret('');
      return next;
    } catch (error) {
      setMessage({ tone: 'error', text: `Couldn’t save: ${describe('models.firstRun', error)}` });
      return null;
    } finally {
      setPhase('idle');
    }
  }
  async function test() {
    setMessage(null);
    setTested(false);
    const target = await save();
    if (!target) return;
    setPhase('testing');
    const outcome = await runTest(target);
    setPhase('idle');
    setMessage(outcome.notice);
    setTested(outcome.ok);
  }
  return { provider, model, secret, setSecret, saved, phase, message, tested, errors, touched, mark, test };
}

/** @brief 首次启动表单。 */
export function FirstRunForm() {
  const migrationError = useApp((state) => state.config?.migrationError ?? null);
  const form = useFirstRun();
  const { provider, model, phase, saved, errors } = form;
  const shown = shownErrors(errors, form.touched);
  const setProvider = (patch: Parameters<typeof provider.edit>[0]) => {
    provider.edit(providerPatch(provider.draft, patch, true));
    form.mark();
  };
  const setModel = (patch: Parameters<typeof model.edit>[0]) => { model.edit(patch); form.mark(); };
  const publicNote = provider.draft.zone === 'public' && <p className="field-hint" data-testid="zone-public-note">
    Public providers must be allowed per project. You’ll be asked when you open a folder.</p>;
  return (
    <>
      <h2>Connect a model</h2>
      <p className="muted">Enter the base URL, API key, and model ID, then test the connection.</p>
      {migrationError && <p className="form-message error" data-testid="migration-error">
        Couldn’t import your previous model settings: {migrationError}</p>}
      <form className="mf-grid first-run-form" data-testid="connection-form" noValidate
        onSubmit={(event) => { event.preventDefault(); void form.test(); }}>
        <TextRow label="Name" field="name" error={shown.name} value={provider.draft.name}
          onChange={(name) => setProvider({ name })} />
        <TextRow label="Base URL" field="baseUrl" error={shown.baseUrl} value={provider.draft.baseUrl}
          spellCheck={false} placeholder="http://host:8000/v1" onChange={(baseUrl) => setProvider({ baseUrl })} />
        <ApiRow value={provider.draft.api} onChange={(api) => setProvider({ api })} />
        <ZoneRadios value={provider.draft.zone} onChange={(zone) => setProvider({ zone })} note={publicNote} />
        <TextRow label="API key" field="secret" type="password" autoComplete="off" value={form.secret}
          placeholder={saved?.key ? 'Saved. Leave empty to keep it.' : 'Optional'}
          onChange={(secret) => { form.setSecret(secret); form.mark(); }} />
        <ModelFields draft={model.draft} edit={setModel} errors={shown} editing={false} full={false} thinking={false} />
        <CompatChecks api={provider.draft.api} value={provider.draft.compat}
          onChange={(compat) => setProvider({ compat })} />
        <div className="form-actions">
          <button type="submit" className="button primary" data-action="test"
            disabled={phase !== 'idle' || hasErrors(errors)}>
            {phase === 'saving' ? 'Saving…' : phase === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {phase === 'testing' && <button type="button" className="button" data-action="test-cancel"
            onClick={cancelTest}>Cancel</button>}
        </div>
        <NoticeLine notice={form.message} testId="form-message" />
      </form>
      {form.tested && saved && <ProbeStatus modelRef={`${saved.providerId}/${saved.modelId}`} />}
      {form.tested && <OpenFolder />}
    </>
  );
}
