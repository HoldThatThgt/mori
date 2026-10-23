// 首次启动表单（docs/specs/model-discovery.md §6.6，规格 §9.1 "首次启动表单"；状态表见 docs/v1/screens/first-run.md）：
// 先填 Base URL 和 API key，Fetch models 之后预填 Name、API type、Network zone，在清单里勾选模型（拉取的状态、清单与
// 其中的视图和 Add provider 共用 settings/Checklist.tsx）。"Test connection"有改动时先保存（models.firstRun：一次写入
// 提供商、勾选的全部模型、key 和 normalDefault；同一张表单再次保存时带上次的 providerId 整体替换，§5.4），再测第一个
// 勾选的模型；成功后显示"Open folder…"和表单下方这个模型的探针状态。表单卸载时拉取还在进行就先发
// models.discoverCancel（useFetch），内存里的 key 一起丢掉；内存里的 key 只在 Base URL 框与保存的提供商是同一个
// origin 时使用（§6.6，2026-10-23 负责人决定）。

import { useRef, useState } from 'react';
import type {
  DiscoverResult, ModelsResult, ProfileView, ProviderForm, ProviderModel, ProviderSaved,
} from '../../../shared/models';
import { openFolder } from '../state/projects';
import { describe, request } from '../state/bridge';
import { cancelTest, runTest, useProfile, type Notice } from '../state/settings';
import { useApp } from '../state/store';
import { Icon } from '../icons';
import { folderName } from './ChatPane';
import {
  BaseUrlNote, ChecklistView, DetectedLine, FetchRow, MoreSettings, ProbeCostNote, useChecklist, useNewFetch,
} from './settings/Checklist';
import { NoticeLine } from './settings/common';
import {
  ApiRow, CompatChecks, emptyProvider, hasErrors, originOf, providerErrors, shownErrors, TextRow, toProviderForm,
  useDraft, ZoneRadios, type ProviderDraft,
} from './settings/fields';
import '../styles/models-settings.css';

/** @brief 表单所处的阶段。 */
type Phase = 'idle' | 'saving' | 'testing';

/** 新提供商还没有模型：Add a model ID 只和清单里的行比重复（§6.4） */
const NO_MODELS: readonly string[] = [];

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

// ---- 保存与测试（§5.4、§6.6） ----

/** @brief 上次保存（models.firstRun）的结果与内容。 */
interface Saved {
  /** 保存到的提供商 id：再次保存时带上它，整体替换这个提供商和它的全部模型（§5.4） */
  providerId: string;
  /** 这次写下的提供商与勾选的模型（JSON）：表单当前的值与它相同、API key 框为空时表单没有改动，不再保存 */
  payload: string;
  /** 保存的提供商 Base URL 的 origin（协议、主机、端口）：内存里的 key 只在 Base URL 框是这个 origin 时使用（§6.6） */
  origin: string | null;
  /**
   * 提供商存着 key（内存里有这张表单最后保存过的 key）。带着不同的 origin、框空着保存后为假：后台进程按模型层规格
   * §4.1 删了已存的 key，内存里的 key 一起丢掉（§6.6，2026-10-23 负责人决定）
   */
  key: boolean;
}

/**
 * @brief 保存成功后的 Saved（§6.6）：框里有 key 时存下的是它；框空着时照旧保留已存的 key，但 origin 变了时
 *        后台进程按模型层规格 §4.1 删了它（2026-10-23 负责人决定）。
 * @param previous 上次保存；第一次为 null
 * @param written 这次写下的提供商 id、内容与 origin
 * @param secret 这次 API key 框的值
 */
function savedAfter(previous: Saved | null, written: Omit<Saved, 'key'>, secret: string): Saved {
  const moved = previous !== null && previous.origin !== written.origin;
  return { ...written, key: Boolean(secret) || (!moved && Boolean(previous?.key)) };
}

/**
 * @brief 内存里的 key 用不用（§6.6，2026-10-23 负责人决定）：存着 key、且 Base URL 框的地址与上次保存的提供商是同一个
 *        origin（协议、主机、端口）时为真。这时拉取带它、API key 的占位写"Saved. Leave empty to keep it."；
 *        origin 不同时都不用（这时保存会按模型层规格 §4.1 删除已存的 key），改回保存时的 origin 后恢复。
 * @param saved 上次保存；没保存过为 null
 * @param baseUrl Base URL 框的值
 */
function keptKeyApplies(saved: Saved | null, baseUrl: string): boolean {
  return saved !== null && saved.key && saved.origin !== null && originOf(baseUrl) === saved.origin;
}

/**
 * @brief 发一次 models.firstRun（§5.4、§6.6）。
 * @param providerId 上次保存的提供商 id（整体替换）；第一次为 null
 * @param provider 表单的提供商（Name、Base URL 框、API type、Network zone、并发上限的默认值、兼容选项）
 * @param models 勾选的行，按清单顺序（含过滤框藏起来的）
 * @param secret API key 框的值；为空时不发 key（照旧保留已存的 key，内存里的 key 不再发送）
 * @return 保存到的提供商 id；失败时抛出原文
 */
async function firstRun(providerId: string | null, provider: ProviderForm, models: ProviderModel[],
  secret: string): Promise<string> {
  const result = await request<ProviderSaved>({ type: 'models.firstRun', providerId, provider, models,
    keySecret: secret || null });
  if (result.error !== null) throw new Error(result.error);
  return result.providerId;
}

/**
 * @brief 保存与测试（first-run.md "保存中"到"测试成功"）：表单有改动时先保存（从没保存过也算），
 *        再对第一个勾选的模型跑 connection.test（§6.6）。
 * @param draft 提供商草稿
 * @param secret API key 框的值
 * @param clearSecret 保存成功后清空 API key 框（不算你改了 key，表单不回到开始）
 */
function useSaveAndTest(draft: ProviderDraft, secret: string, clearSecret: () => void) {
  const [saved, setSaved] = useState<Saved | null>(null);
  /** §6.6：这张表单最后保存过的 key：只在表单内存里、不显示，表单卸载或带着不同的 origin 空框保存后就丢掉 */
  const kept = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<Notice | null>(null);
  /** 测试成功的模型（<provider>/<model>）：表单下方显示它的探针状态与 Open folder…；没有时为 null */
  const [tested, setTested] = useState<string | null>(null);
  async function save(models: ProviderModel[]): Promise<string | null> {
    const provider = toProviderForm(draft);
    const payload = JSON.stringify({ provider, models });
    if (saved && !secret && saved.payload === payload) return saved.providerId;
    setPhase('saving');
    try {
      const providerId = await firstRun(saved?.providerId ?? null, provider, models, secret);
      const next = savedAfter(saved, { providerId, payload, origin: originOf(provider.baseUrl) }, secret);
      kept.current = next.key ? secret || kept.current : null;
      setSaved(next);
      clearSecret();
      return providerId;
    } catch (error) {
      setMessage({ tone: 'error', text: `Couldn’t save: ${describe('models.firstRun', error)}` });
      return null;
    } finally {
      setPhase('idle');
    }
  }
  /** @param models 勾选的行（至少一行），测第一个（§6.6） */
  async function test(models: ProviderModel[]) {
    setMessage(null);
    setTested(null);
    const providerId = await save(models);
    if (providerId === null) return;
    setPhase('testing');
    const modelId = models[0].id;
    const outcome = await runTest({ providerId, modelId });
    setPhase('idle');
    setMessage(outcome.notice);
    setTested(outcome.ok ? `${providerId}/${modelId}` : null);
  }
  const clear = () => {
    setMessage(null);
    setTested(null);
  };
  return { saved, keptKey: () => kept.current, phase, message, tested, test, clear };
}

// ---- 表单 ----

/** @brief 表单的状态（§6.6、first-run.md "状态表"）：草稿、API key 框、拉取、清单、保存与测试。 */
function useFirstRun() {
  const form = useDraft(emptyProvider);
  const [secret, setSecret] = useState('');
  const fetcher = useNewFetch(form);
  const list = useChecklist(fetcher.result, NO_MODELS);
  const run = useSaveAndTest(form.draft, secret, () => setSecret(''));
  const errors = providerErrors(form.draft);
  /** Test connection 不可用（first-run.md "填写"、§6.6）：勾选数为 0、勾选的行有错误，或 Name、Network zone 有错误 */
  const blocked = list.picked.length === 0 || list.invalid || hasErrors(errors);
  /** 保存中、测试中（只能点测试的 Cancel）：Base URL、API key 只读，Fetch models 不可用，表单不会回到开始 */
  const busy = run.phase !== 'idle';
  /** 内存里的 key 用得上：Base URL 框与保存的提供商是同一个 origin（§6.6），框空时拉取带它，占位写已保存 */
  const keyKept = keptKeyApplies(run.saved, form.draft.baseUrl);
  /** §6.1、§6.6：拉取后改了 Base URL 或 API key，清单、列表错误、手填的行与测试结果都清掉，回到开始 */
  const restart = () => {
    fetcher.reset();
    run.clear();
  };
  const setBaseUrl = (baseUrl: string) => {
    form.edit({ baseUrl });
    restart();
  };
  const changeSecret = (value: string) => {
    setSecret(value);
    restart();
  };
  /**
   * Fetch models（第一次或再拉一次，§6.1）：API key 框为空时用内存里最后保存过的 key（保存过、且 Base URL 框与保存的
   * 提供商是同一个 origin 时才用，§6.6），否则不带 key（§5.1）；你改过的 API type 由 useNewFetch 作为 target.api 发出（§3.4）
   */
  const fetchModels = () => {
    run.clear();
    void fetcher.run(secret || (keyKept ? run.keptKey() : null));
  };
  /** Test connection（§6.6）：勾选的行按清单顺序（含过滤框藏起来的）保存，再测第一个；保存中、测试中或不可用时不发 */
  const test = () => {
    if (!busy && !blocked) void run.test(list.picked);
  };
  return { form, secret, fetcher, list, run, errors, blocked, busy, keyKept, setBaseUrl, changeSecret, fetchModels,
    test };
}

/** @brief 首次启动表单的状态与操作。 */
type FirstRunState = ReturnType<typeof useFirstRun>;

/**
 * @brief 表单底部（§6.6）：探针代价的说明、Test connection（保存中"Saving…"、测试中"Testing…"与旁边测试的 Cancel；
 *        勾选数为 0 或有错误时不可用）和结果文字。没有关闭表单的 Cancel。
 */
function TestActions({ state }: { state: FirstRunState }) {
  const { phase, message } = state.run;
  return (
    <>
      <ProbeCostNote />
      <div className="form-actions">
        <button type="submit" className="button primary" data-action="test" disabled={state.busy || state.blocked}>
          {phase === 'saving' ? 'Saving…' : phase === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        {phase === 'testing' && <button type="button" className="button" data-action="test-cancel"
          onClick={cancelTest}>Cancel</button>}
      </div>
      <NoticeLine notice={message} testId="form-message" />
    </>
  );
}

/**
 * @brief 拉取后（§6.1 第 2–7 项、§6.6，不论有没有拿到列表）：Detected、Base URL 的说明、Name、API type、
 *        Network zone（选 Public 时的说明）、清单或列表错误与 Add a model ID、More settings（只有兼容选项；
 *        API type 不是 OpenAI-compatible 时不显示）、表单底部。
 */
function AfterFetch({ state, result }: { state: FirstRunState; result: DiscoverResult }) {
  const { form, fetcher, list } = state;
  const { draft, edit: set } = form;
  const errors = shownErrors(state.errors, form.touched);
  const publicNote = draft.zone === 'public' && <p className="field-hint" data-testid="zone-public-note">
    Public providers must be allowed per project. You’ll be asked when you open a folder.</p>;
  return (
    <>
      <DetectedLine result={result} />
      {fetcher.note && <BaseUrlNote url={fetcher.note} />}
      <TextRow label="Name" field="name" error={errors.name} value={draft.name} onChange={(name) => set({ name })} />
      <ApiRow value={draft.api} onChange={(api) => set({ api })} />
      <ZoneRadios value={draft.zone} onChange={(zone) => set({ zone })} note={publicNote} />
      <ChecklistView list={list} />
      {draft.api === 'openai-completions' && (
        <MoreSettings>
          <CompatChecks api={draft.api} value={draft.compat} onChange={(compat) => set({ compat })} />
        </MoreSettings>
      )}
      <TestActions state={state} />
    </>
  );
}

/**
 * @brief 首次启动表单（§6.6）：开始只有 Base URL、API key、Fetch models；拉取中两个框只读、旁边拉取的 Cancel；
 *        拉取后其余字段、清单与 Test connection；测试成功后表单下方是测试的那个模型的探针状态与 Open folder…。
 */
export function FirstRunForm() {
  const migrationError = useApp((state) => state.config?.migrationError ?? null);
  const state = useFirstRun();
  const { form, fetcher, run } = state;
  const errors = shownErrors(state.errors, form.touched);
  const locked = fetcher.fetching || state.busy;
  return (
    <>
      <h2>Connect a model</h2>
      <p className="muted">Enter the base URL and API key, then fetch the models.</p>
      {migrationError && <p className="form-message error" data-testid="migration-error">
        Couldn’t import your previous model settings: {migrationError}</p>}
      <form className="mf-grid first-run-form" data-testid="connection-form" noValidate
        onSubmit={(event) => { event.preventDefault(); state.test(); }}>
        <TextRow label="Base URL" field="baseUrl" error={errors.baseUrl} value={form.draft.baseUrl}
          spellCheck={false} placeholder="http://host:8000/v1" readOnly={locked} onChange={state.setBaseUrl} />
        <TextRow label="API key" field="secret" type="password" autoComplete="off" value={state.secret}
          placeholder={state.keyKept ? 'Saved. Leave empty to keep it.' : 'Optional'} readOnly={locked}
          onChange={state.changeSecret} />
        <FetchRow fetcher={fetcher} disabled={state.errors.baseUrl !== undefined || state.busy}
          onFetch={state.fetchModels} />
        {fetcher.result && <AfterFetch state={state} result={fetcher.result} />}
      </form>
      {run.tested && <ProbeStatus modelRef={run.tested} />}
      {run.tested && <OpenFolder />}
    </>
  );
}
