// 设置页（docs/v1/screens/models-settings.md）的状态与命令：当前分节、Models 分节的数据（models.get 的结果，
// 两次读取之间由全局事件 mori.profiles、mori.key_status 更新）、正在跑的探针、测试连接的结果、进入时要落到的位置。
// 写命令成功后重新 models.get（models-settings.md "来源"）；拉取模型（models.discover、models.discoverCancel）不是写命令，
// 不重新 models.get，结果只交给表单（docs/specs/model-discovery.md §5.1）。进入设置页默认落在 Models；
// F8 的"View in Settings"落在 UI issues（docs/specs/memory.md §10.8，showSettingsSection）。

import { create } from 'zustand';
import type {
  ConfigInfo, DiscoverResult, DiscoverTarget, KeyStatus, ModelCommand, ModelsInfo, ModelsResult, ProbeProgress,
  ProfileView,
} from '../../../shared/models';
import type { EventEnvelope, GlobalEventEnvelope, TestResult } from '../../../shared/protocol';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { guardLeave } from './leaveGuard';
import { useApp } from './store';

/** @brief 一行结果文字。 */
export interface Notice {
  /** 语气：成功、失败、说明 */
  tone: 'ok' | 'error' | 'info';
  /** 文字 */
  text: string;
}

/** @brief 设置页的分节：Models、UI issues（docs/specs/memory.md §10.8；AGENTS.md 2026-10-26 起在 Customize）。 */
export type SettingsSection = 'models' | 'issues';

/** @brief 打开 设置 → Models 时要落到的位置（拒绝启动卡、说明卡、范围菜单）。 */
export interface ModelsTarget {
  /** 滚到这个提供商的卡；focus 为 zones 时是要确认区域的提供商 */
  providerId?: string;
  /** keys：焦点在这个提供商的 Keys 第一行；zones：区域未确认的那几行；project：Project access 的这个项目 */
  focus?: 'keys' | 'zones' | 'project';
  /** focus 为 project 时的项目文件夹（按 §4.1 规范化后比较） */
  projectPath?: string;
}

/** @brief 设置页的状态（只在界面里，不跨重启保存）。 */
interface SettingsState {
  /** 当前分节 */
  section: SettingsSection;
  /** 最近一次 models.get / models.reload 的结果；还没读到时为 null */
  info: ModelsInfo | null;
  /** models.get 读取中 */
  loading: boolean;
  /** models.get 失败的原文（命令出错或结果带 error）；没有时为 null */
  readError: string | null;
  /** 打开设置页时重新读取 config.get 失败的原文；没有时为 null */
  configReadError: string | null;
  /** 档案：models.get 的结果，之后由 mori.profiles 更新（首次启动表单也用） */
  profiles: Record<string, ProfileView>;
  /** 正在跑的探针（mori.profiles） */
  running: ProbeProgress[];
  /** key 的不可用记录：models.get 的结果，之后由 mori.key_status 更新 */
  keyStatus: Record<string, KeyStatus>;
  /**
   * 等 Models 分节处理的落点；nonce 每次打开加一。loaded：这次打开发起的 models.get 已读到，
   * 落点只按它的结果找（之前缓存的数据里可能还没有新的项目或提供商）
   */
  target: (ModelsTarget & { nonce: number; loaded: boolean }) | null;
  /** 正在测试的位置（testKey）；没有时为 null。同一时刻只测一个 */
  testing: string | null;
  /** 每个位置最近一次测试的结果 */
  tests: Record<string, Notice>;
}

/** @brief 设置页的状态。 */
export const useSettings = create<SettingsState>(() => ({
  section: 'models', info: null, loading: false, readError: null, configReadError: null, profiles: {}, running: [],
  keyStatus: {}, target: null, testing: null, tests: {},
}));

let targetNonce = 0;

/**
 * @brief 读取 Models 分节的数据（models.get，或配置读不出时的 models.reload）。读到后，开始读取时等着的落点标为可处理；
 *        这次打开之前发起的读取（例如写命令之后的重新读取）不会标记新的落点。
 */
export async function loadModels(type: 'models.get' | 'models.reload' = 'models.get'): Promise<void> {
  const nonce = useSettings.getState().target?.nonce;
  useSettings.setState((state) => ({ loading: state.info === null }));
  try {
    const info = await request<ModelsInfo>({ type });
    useSettings.setState((state) => ({ info, loading: false,
      readError: info.loadError === null ? info.error : null, profiles: info.profiles, keyStatus: info.keyStatus,
      target: state.target && state.target.nonce === nonce ? { ...state.target, loaded: true } : state.target }));
  } catch (error) {
    useSettings.setState({ loading: false, readError: describe(type, error) });
  }
}

/**
 * @brief 发一条 models.* 写命令：成功（error 为 null）后重新 models.get；命令本身出错时把原文当作 error 返回。
 * @return 命令的结果；失败时 error 为原文
 */
export async function writeModels<T extends ModelsResult>(command: ModelCommand): Promise<T> {
  try {
    const result = await request<T>(command);
    if (result.error === null) await loadModels();
    return result;
  } catch (error) {
    return { error: describe(command.type, error) } as T;
  }
}

// ---- 拉取模型（docs/specs/model-discovery.md §5.1–§5.3） ----

/**
 * @brief 读服务的模型列表（models.discover，§5.1）：不进写入队列、不重新 models.get，结果只放进表单状态（§9）。
 *        命令本身出错时返回 error 为原文的失败结果（§5.2：cancelled 为假，其余为空）。
 * @param target 新提供商（Base URL 框的值、改过的 API type、临时 key）或已有提供商
 */
export async function discoverModels(target: DiscoverTarget): Promise<DiscoverResult> {
  try {
    return await request<DiscoverResult>({ type: 'models.discover', target });
  } catch (error) {
    return { error: describe('models.discover', error), cancelled: false, server: null, api: 'openai-completions',
      baseUrl: '', name: '', anthropicShape: false, listError: null, models: [], truncated: false, notListed: [] };
  }
}

/** @brief 取消正在进行的 models.discover（§5.3）；被取消的那次随后返回 cancelled: true。 */
export function cancelDiscover(): void {
  void request({ type: 'models.discoverCancel' }).catch((error) => describe('models.discoverCancel', error));
}

/** @brief 打开设置页时重新读取 config.get（pi 设置读不出时的原文）；失败时原文显示在设置页里。 */
async function rereadConfig(): Promise<void> {
  try {
    const config = await request<ConfigInfo>({ type: 'config.get' });
    useApp.setState({ config });
    useSettings.setState({ configReadError: null });
  } catch (error) {
    useSettings.setState({ configReadError: describe('config.get', error) });
  }
}

/** 下一次进入设置页时要落到的分节（showSettingsSection 记下，进入时用掉）；平常为 null，落在 Models */
let landing: SettingsSection | null = null;

/**
 * @brief 进入设置页：落在 Models（或 showSettingsSection 指定的分节），重新读取配置和 Models 的数据，
 *        清掉上次的测试结果。
 */
useApp.subscribe((state, previous) => {
  if (state.view === 'settings' && previous.view !== 'settings') {
    useSettings.setState({ section: landing ?? 'models', readError: null, configReadError: null, tests: {} });
    landing = null;
    void rereadConfig();
    void loadModels();
  }
});

/**
 * @brief 打开设置页的某一节（F8 的"View in Settings"打开 UI issues）：已经在设置页时直接换过去，否则进入设置页并落在
 *        这一节。不再问离开：调用方已经经过 guardLeave。
 */
export function showSettingsSection(section: SettingsSection): void {
  if (useApp.getState().view === 'settings') {
    useSettings.setState({ section });
    return;
  }
  landing = section;
  useApp.setState({ view: 'settings' });
}

/**
 * @brief 打开 设置 → Models，并落到 target 指定的位置（不带时停在顶部）。拒绝启动卡、说明卡、范围菜单调用。
 *        有未保存的改动时先问（Customize 的 Instructions（AGENTS.md）、记忆页的表单）。
 */
export function openModelsSettings(target: ModelsTarget = {}): void {
  guardLeave(() => {
    recordAction(`Open Settings → Models${target.focus ? ` (${target.focus})` : ''}`);
    targetNonce += 1;
    // 先记下落点，再读取（两条路都在这之后调 loadModels：进入设置页的订阅在 setState 里同步执行）。
    useSettings.setState({ section: 'models', target: { ...target, nonce: targetNonce, loaded: false } });
    if (useApp.getState().view === 'settings') void loadModels();
    else useApp.setState({ view: 'settings' });
  });
}

/** @brief Models 分节处理完落点后清掉它。 */
export function clearTarget(nonce: number): void {
  if (useSettings.getState().target?.nonce === nonce) useSettings.setState({ target: null });
}

/** @brief 换到另一节（设置页里没有会登记离开检查的编辑器，不用问）。 */
export function selectSection(section: SettingsSection): void {
  if (useSettings.getState().section !== section) useSettings.setState({ section });
}

/** @brief 全局事件：档案与探针进度、key 的不可用记录（§9.5，信封的 sessionId 为 null）。 */
function onGlobalEvent(envelope: EventEnvelope | GlobalEventEnvelope): void {
  if (envelope.sessionId !== null) return;
  const { event } = envelope;
  if (event.type === 'mori.profiles') useSettings.setState({ profiles: event.profiles, running: event.running });
  else if (event.type === 'mori.key_status') useSettings.setState({ keyStatus: event.keyStatus });
}

window.mori.onEvent(onGlobalEvent);

/** @brief 这个模型的档案与是否有探针在跑。 */
export function useProfile(ref: string): { profile: ProfileView | null; running: boolean } {
  const profile = useSettings((state) => state.profiles[ref] ?? null);
  const running = useSettings((state) => state.running.some((item) => item.ref === ref));
  return { profile, running };
}

/** @brief 这个 key 的不可用记录；没有时为 null。 */
export function useKeyStatus(ref: string): KeyStatus | null {
  return useSettings((state) => state.keyStatus[ref] ?? null);
}

// ---- 测试连接（§9.1 "测试结果"） ----

/** @brief 测试结果的文字（models-settings.md "测试结果的文字"）。 */
export function testMessage(result: TestResult): Notice {
  if (result.cancelled) return { tone: 'info', text: 'Test cancelled' };
  if (!result.ok) return { tone: 'error', text: `Connection failed: ${result.error ?? 'No response'}` };
  const thinking = result.thinking ? ' · Includes thinking' : '';
  const reply = result.text ? ` · Response: ${result.text.slice(0, 200)}` : '';
  const first = result.firstTokenMs === null ? '—' : `${result.firstTokenMs}ms`;
  return { tone: 'ok', text: `Connected · First token ${first} · Total ${result.totalMs}ms${thinking}${reply}` };
}

/** @brief 一次测试连接的目标：模型，和 Keys 行的 Test 用的 key。 */
export interface TestTarget {
  /** 提供商 id */
  providerId: string;
  /** 模型 id */
  modelId: string;
  /** 只用这个 key（Keys 行的 Test）；不带时用第一个可用的 key */
  keyRef?: string;
}

/** @brief 测试一次连接（connection.test），返回是否成功和结果文字。 */
export async function runTest(target: TestTarget): Promise<{ ok: boolean; notice: Notice }> {
  try {
    const result = await request<TestResult>({ type: 'connection.test', ...target });
    return { ok: result.ok, notice: testMessage(result) };
  } catch (error) {
    const text = `Couldn’t test the connection: ${describe('connection.test', error)}`;
    return { ok: false, notice: { tone: 'error', text } };
  }
}

/**
 * @brief 设置页里的一次测试：结果写在 key 指定的位置（提供商卡、key 行；2026-10-26 起模型行没有 Test）。同一时刻只测一个。
 * @param key 位置：provider:<id> 或 key:<ref>
 */
export async function testAt(key: string, target: TestTarget): Promise<void> {
  if (useSettings.getState().testing !== null) return;
  useSettings.setState((state) => {
    const { [key]: _previous, ...tests } = state.tests;
    return { testing: key, tests };
  });
  const { notice } = await runTest(target);
  useSettings.setState((state) => ({ testing: null, tests: { ...state.tests, [key]: notice } }));
}

/** @brief 取消正在进行的测试；测试随后以"Test cancelled"结束。 */
export function cancelTest(): void {
  void request({ type: 'connection.testCancel' }).catch((error) => describe('connection.testCancel', error));
}

// ---- 迁移后第一次启动：直接打开 设置 → Models（§4.5） ----

/** 已经检查过这次启动要不要打开 Models */
let migrationChecked = false;

/** @brief 启动时第一次读到配置：只有这次启动刚迁移完（config.get 的 migratedNow）才打开 设置 → Models，停在顶部。 */
useApp.subscribe((state) => {
  if (migrationChecked || !state.config) return;
  migrationChecked = true;
  if (state.config.migratedNow && !state.firstRun && state.view === 'chat') openModelsSettings();
});
