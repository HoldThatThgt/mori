// 设置页（docs/v0/screens/settings.md）的状态与命令：当前分节、"连接与模型"里显示的列表或表单、列表上方的一行、
// 每个模型的测试；设为默认、删除、保存模型。打开设置页时重新读取配置，写入之后用 loadConfig 重新读取。

import { create } from 'zustand';
import type {
  ConfigInfo, ConnectionInfo, ModelForm as ModelFields, SaveResult, TestResult,
} from '../../../shared/protocol';
import { loadConfig } from './actions';
import { describe, request } from './bridge';
import { guardLeave } from './leaveGuard';
import { activeTab, useApp } from './store';

/** @brief 一行结果文字。 */
export interface Notice {
  /** 语气：成功、失败、说明 */
  tone: 'ok' | 'error' | 'info';
  /** 文字 */
  text: string;
}

/** @brief 设置页的分节。 */
export type SettingsSection = 'connections' | 'agents';

/** @brief "连接与模型"里显示什么：列表、添加连接、编辑连接、添加或编辑模型。 */
export type ConnectionsView =
  | { kind: 'list' }
  | { kind: 'add' }
  | {
    kind: 'edit';
    /** 要编辑的连接；"去设置"时是出错会话所用模型的 provider，不知道时为 null（落在默认模型的连接上） */
    providerId: string | null;
    /** 大于 0 时把焦点放到 API key（"去设置"的序号） */
    focusKey: number;
  }
  | {
    kind: 'model';
    /** 模型所在的连接 */
    providerId: string;
    /** 编辑的模型 ID；添加时为 null */
    modelId: string | null;
  };

/** @brief 设置页的状态；每次打开设置页时回到"连接与模型"的列表。 */
interface SettingsState {
  /** 当前分节 */
  section: SettingsSection;
  /** "连接与模型"里显示的内容 */
  view: ConnectionsView;
  /** 打开设置页时重新读取配置失败的原文；没有时为 null */
  readError: string | null;
  /** 列表上方的一行（保存、设为默认、删除之后）；没有时为 null */
  notice: Notice | null;
  /** 正在测试的模型（provider/id）；没有时为 null */
  testing: string | null;
  /** 每个模型最近一次测试的结果，按 provider/id */
  tests: Record<string, Notice>;
}

/** @brief 设置页的状态（只在界面里，不跨重启保存）。 */
export const useSettings = create<SettingsState>(() => ({
  section: 'connections', view: { kind: 'list' }, readError: null, notice: null, testing: null, tests: {},
}));

/** 保存连接或模型之后列表上方的一行 */
export const SAVED_NOTICE = '已保存 · 已经打开的会话下一条消息起用新的设置';

/** @brief 测试结果的文字（connection.md "测试成功 / 失败 / 已取消"）。 */
function testMessage(result: TestResult): Notice {
  if (result.cancelled) return { tone: 'info', text: '已取消测试' };
  if (!result.ok) return { tone: 'error', text: `连接失败：${result.error ?? '没有收到回复'}` };
  const thinking = result.thinking ? ' · 有思考内容' : '';
  const reply = result.text ? ` · 回复：${result.text}` : '';
  return { tone: 'ok', text: `连接成功 · 首字 ${result.firstTokenMs} ms · 共 ${result.totalMs} ms${thinking}${reply}` };
}

/** @brief Mori 的全部连接；M6 之前的配置里没有这一项时为空。 */
export function connectionsOf(config: ConfigInfo | null): ConnectionInfo[] {
  return config?.connections ?? [];
}

/**
 * @brief 要编辑的连接：providerId 指定的；为 null（"去设置"时不知道出错会话的模型）时取默认模型的连接，再取第一个。
 *        找不到时为 null。
 */
export function connectionFor(config: ConfigInfo, providerId: string | null): ConnectionInfo | null {
  const connections = connectionsOf(config);
  const byId = (id: string | undefined) => connections.find((item) => item.providerId === id);
  if (providerId !== null) return byId(providerId) ?? null;
  return byId(config.defaultModel?.split('/')[0]) ?? connections[0] ?? null;
}

/** @brief 打开设置页时重新读取配置；失败时原文显示在设置页里。 */
async function rereadConfig(): Promise<void> {
  try {
    const config = await request<ConfigInfo>({ type: 'config.get' });
    useApp.setState({ config });
    useSettings.setState({ readError: null });
  } catch (error) {
    useSettings.setState({ readError: describe('config.get', error) });
  }
}

/**
 * @brief 打开设置页时落在"连接与模型"的列表，并重新读取配置（修好 models.json 后重新打开设置页就能看到）；
 *        "去设置"（settingsFocus 加一）时打开出错会话所用模型的连接的"编辑连接"，焦点放到 API key。
 */
useApp.subscribe((state, previous) => {
  if (state.view === 'settings' && previous.view !== 'settings') {
    useSettings.setState({ section: 'connections', view: { kind: 'list' }, readError: null, notice: null, tests: {} });
    void rereadConfig();
  }
  if (state.settingsFocus !== previous.settingsFocus) {
    const view: ConnectionsView = { kind: 'edit', providerId: state.settingsProvider, focusKey: state.settingsFocus };
    guardLeave(() => useSettings.setState({ section: 'connections', view, notice: null }));
  }
});

/** @brief 换到另一节；AGENTS.md 有未保存的改动时先问。 */
export function selectSection(section: SettingsSection): void {
  if (useSettings.getState().section === section) return;
  guardLeave(() => useSettings.setState({ section, view: { kind: 'list' }, notice: null }));
}

/** @brief "连接与模型"里换成列表或一张表单；notice 为回到列表时上方的一行。 */
export function showView(view: ConnectionsView, notice: Notice | null = null): void {
  useSettings.setState({ view, notice });
}

/**
 * @brief 测试一次连接（connection.test），返回是否成功和结果文字。
 * @param modelId 要测的模型；不带时后台进程测默认模型
 */
export async function runTest(providerId: string | undefined, modelId: string | undefined):
  Promise<{ ok: boolean; notice: Notice }> {
  try {
    const result = await request<TestResult>({ type: 'connection.test', providerId, modelId });
    return { ok: result.ok, notice: testMessage(result) };
  } catch (error) {
    return { ok: false, notice: { tone: 'error', text: `测试失败：${describe('connection.test', error)}` } };
  }
}

/** @brief 测试列表里的一个模型；结果写在这一行下面。同一时刻只测一个。 */
export async function testModel(providerId: string, modelId: string): Promise<void> {
  const ref = `${providerId}/${modelId}`;
  useSettings.setState((state) => {
    const { [ref]: _previous, ...tests } = state.tests;
    return { testing: ref, tests };
  });
  const { notice } = await runTest(providerId, modelId);
  useSettings.setState((state) => ({ testing: null, tests: { ...state.tests, [ref]: notice } }));
}

/** @brief 取消正在进行的测试；测试随后以"已取消"结束。 */
export function cancelTest(): void {
  void request({ type: 'connection.testCancel' }).catch((error) => describe('connection.testCancel', error));
}

/** @brief 设为默认模型；结果写在列表上方，pi 报告写设置的错误时显示原文。 */
export async function setDefaultModel(providerId: string, modelId: string): Promise<void> {
  try {
    const result = await request<SaveResult>({ type: 'model.setDefault', providerId, modelId });
    await loadConfig();
    const text = `已把 ${modelId} 设为默认`;
    showView({ kind: 'list' }, result.error ? { tone: 'error', text: `${text}，但配置有错误：${result.error}` }
      : { tone: 'ok', text: `${text} · 新会话用默认模型；已经打开的会话不变` });
  } catch (error) {
    showView({ kind: 'list' }, { tone: 'error', text: `设为默认失败：${describe('model.setDefault', error)}` });
  }
}

/** @brief 删除模型（是连接的最后一个模型时连接和 key 一起删除）；失败时抛错，由确认框显示原文。 */
export async function deleteModel(connection: ConnectionInfo, modelId: string): Promise<void> {
  const result = await request<SaveResult | null>({ type: 'model.delete', providerId: connection.providerId, modelId });
  await loadConfig();
  const last = connection.models.length === 1;
  const text = last ? `已删除模型 ${modelId} 和连接 ${connection.endpoint.name}` : `已删除模型 ${modelId}`;
  showView({ kind: 'list' }, result?.error ? { tone: 'error', text: `${text}，但配置有错误：${result.error}` }
    : { tone: 'ok', text });
}

/** @brief 添加或修改一个模型；失败时抛错。返回 pi 报告的配置错误。 */
export async function saveModel(providerId: string, model: ModelFields, adding: boolean): Promise<SaveResult> {
  const result = await request<SaveResult>({ type: 'model.save', providerId, model, adding });
  await loadConfig();
  return result;
}

/** @brief 焦点会话（AGENTS.md 一节列出它的项目加载的文件）。 */
export interface FocusedSession {
  /** pi 会话 id */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
}

/** @brief 当前会话（分屏时焦点所在的那一栏）；还没打开好或没有时为 null。 */
export function focusedSession(): FocusedSession | null {
  const tab = activeTab();
  return tab?.phase === 'ready' && tab.sessionId ? { sessionId: tab.sessionId, cwd: tab.cwd } : null;
}
