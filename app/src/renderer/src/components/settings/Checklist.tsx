// 拉取模型与清单（docs/specs/model-discovery.md §6.1–§6.6；状态表见 docs/v1/screens/models-settings.md "清单"
// "列表错误""Add a model ID"与 first-run.md）。Add provider 表单、卡上的 Fetch models 与首次启动表单共用这里的：
// 拉取的状态（useFetch；新提供商另有 useNewFetch：拉取后预填、Base URL 的说明）、拉取的按钮（FetchControls、FetchRow）、
// 清单的状态（useChecklist）与视图（ChecklistView），以及 Detected 一行、Base URL 的说明、More settings、探针代价的说明。
// 结果只在表单状态里，表单关闭就丢掉（§9）；关闭时拉取还在进行就先发 models.discoverCancel（§6.1）。

import {
  memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react';
import {
  serverKindLabel, suggestZone, UNREPORTED_CONTEXT_WINDOW, unreportedMaxTokens, type DiscoveredModel,
  type DiscoverHint, type DiscoverListError, type DiscoverResult, type DiscoverTarget, type ProviderModel,
} from '../../../../shared/models';
import { cancelDiscover, discoverModels } from '../../state/settings';
import { FieldError } from './common';
import {
  defaultMaxOutput, hasErrors, idError, positiveInt, sizeErrors, type DraftForm, type ProviderDraft,
} from './fields';

/** 清单的行数（含手填的行）超过它时显示过滤框（§6.2、§11） */
const FILTER_ROWS = 20;

// ---- 拉取（§6.1、§6.5） ----

/**
 * 最近一次发起的拉取的编号（各表单共用）。后台进程同一时刻只做一次发现，新的一次取消旧的（§5.3）：
 * 丢掉一次拉取时只在它仍是最近一次时才发 models.discoverCancel，免得取消掉别处刚发起的那次。
 */
let latestFetch = 0;

/** @brief 拉取的状态。 */
export interface FetchState {
  /** 拉取中：models.discover 还没返回 */
  fetching: boolean;
  /** 上一次拉取被取消（显示"Fetch cancelled"） */
  cancelled: boolean;
  /** 上一次拉取的命令本身失败的原文（地址或 key 不合格、提供商不存在，§5.1）；没有时为 null */
  error: string | null;
  /** 拉取后的结果（没被取消、命令没失败，不论有没有拿到列表）；开始与拉取中为 null */
  result: DiscoverResult | null;
}

/** @brief 拉取的状态与操作。 */
export interface FetchControl extends FetchState {
  /** 发起一次拉取；返回拉取后的结果，被取消、命令失败或这次拉取已被丢掉时为 null */
  start: (target: DiscoverTarget) => Promise<DiscoverResult | null>;
  /** 拉取中的 Cancel：发 models.discoverCancel，这次拉取随后以 cancelled 结束 */
  cancel: () => void;
  /**
   * 关掉卡上的清单：丢掉正在进行的拉取与结果。拉取还在进行时按已取消结束，显示"Fetch cancelled"
   * （models-settings.md "卡上的 Fetch models"已取消一行：另一处发起了新的一次发现，或打开别的表单先发了
   * models.discoverCancel）；"Fetch cancelled"与命令的原文留到再点 Fetch models
   */
  close: () => void;
  /** 回到开始（改了 Base URL 或 API key）：丢掉正在进行的拉取、结果、"Fetch cancelled"与原文 */
  reset: () => void;
}

/** 开始（§6.1）：没有拉取，也没有上一次的结果 */
const IDLE: FetchState = { fetching: false, cancelled: false, error: null, result: null };

/** @brief 一次拉取返回后的状态：取消后回到开始并显示"Fetch cancelled"；命令失败停在开始并显示原文（§6.1）。 */
function settled(result: DiscoverResult): FetchState {
  if (result.cancelled) return { ...IDLE, cancelled: true };
  if (result.error !== null) return { ...IDLE, error: result.error };
  return { ...IDLE, result };
}

/**
 * @brief 拉取的状态（三处表单共用）。卸载时（关闭表单、打开别的表单、离开设置页）拉取还在进行就先发
 *        models.discoverCancel（§6.1、§6.5），之后返回的结果不再用。
 */
export function useFetch(): FetchControl {
  const [state, setState] = useState<FetchState>(IDLE);
  /** 正在进行的这次拉取的编号；没有时为 null */
  const running = useRef<number | null>(null);
  const abandon = useCallback(() => {
    const id = running.current;
    running.current = null;
    if (id !== null && id === latestFetch) cancelDiscover();
  }, []);
  useEffect(() => abandon, [abandon]);
  const start = useCallback(async (target: DiscoverTarget) => {
    latestFetch += 1;
    const id = latestFetch;
    running.current = id;
    setState({ ...IDLE, fetching: true });
    const result = await discoverModels(target);
    if (running.current !== id) return null;
    running.current = null;
    const next = settled(result);
    setState(next);
    return next.result;
  }, []);
  const cancel = useCallback(() => {
    if (running.current !== null && running.current === latestFetch) cancelDiscover();
  }, []);
  const close = useCallback(() => {
    abandon();
    // 被丢掉的那次之后返回的 cancelled: true 不再用（running 已清），这里直接按已取消结束（models-settings.md
    // "卡上的 Fetch models"已取消一行、"本表定下的界面细节"）
    setState((current) => (current.fetching ? { ...IDLE, cancelled: true } : current.result ? IDLE : current));
  }, [abandon]);
  const reset = useCallback(() => {
    abandon();
    setState(IDLE);
  }, [abandon]);
  return { ...state, start, cancel, close, reset };
}

// ---- 新提供商的拉取：Add provider 与首次启动表单（§6.1、§6.6） ----

/** @brief 去掉首尾空白和结尾的 / 的地址（§6.1 第 3 项：建议的 Base URL 与你填的这样比较）。 */
function bareUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * @brief 新提供商的 models.discover 目标（§5.1、§3.4）：Base URL 框的值；API type 你在这张表单里改过时作为 api 发出，
 *        没改过为 null。
 * @param edited 你改过的字段（useDraft 的 touched）
 * @param keySecret 这次拉取用的 key（API key 框的值，首次启动另有内存里的 key，§6.6）；没有时为 null
 */
export function newTarget(draft: ProviderDraft, edited: ReadonlySet<string>, keySecret: string | null):
  DiscoverTarget {
  return { kind: 'new', baseUrl: draft.baseUrl, api: edited.has('api') ? draft.api : null, keySecret };
}

/** @brief 拉取后的预填。 */
export interface Prefill {
  /** 预填后的草稿 */
  draft: ProviderDraft;
  /** Base URL 框换成了建议的地址、且拿到了列表时为这个地址（显示"Updated to …"）；否则为 null */
  note: string | null;
}

/**
 * @brief 拉取后预填（§6.1 第 3、4 项）：建议的 Base URL 与框里的不同时换进框（不算你改了 Base URL）；Name、API type、
 *        Network zone 你在这张表单里改过的留着，没改过的 Name、API type 取结果，区域按框里的地址用 suggestZone 预选
 *        （§3.4；models-settings.md "区域的建议值"）。More settings 里的值不在结果里，原样留着。
 * @param edited 你改过的字段（useDraft 的 touched）
 */
export function prefillDraft(draft: ProviderDraft, edited: ReadonlySet<string>, result: DiscoverResult): Prefill {
  const replace = bareUrl(result.baseUrl) !== bareUrl(draft.baseUrl);
  const baseUrl = replace ? result.baseUrl : draft.baseUrl;
  return {
    draft: { ...draft, baseUrl, name: edited.has('name') ? draft.name : result.name,
      api: edited.has('api') ? draft.api : result.api, zone: edited.has('zone') ? draft.zone : suggestZone(baseUrl) },
    note: replace && result.listError === null ? result.baseUrl : null,
  };
}

/** @brief 新提供商的拉取的状态与操作。 */
export interface NewFetchControl extends FetchControl {
  /** Base URL 的说明里的地址；没有说明时为 null */
  note: string | null;
  /** 用表单当前的值拉取（keySecret 为这次用的 key，没有时为 null），返回后预填 */
  run: (keySecret: string | null) => Promise<void>;
}

/**
 * @brief 新提供商的拉取：用表单的值发 models.discover，返回后按 prefillDraft 预填草稿（setDraft，不算你改过）
 *        并记下 Base URL 的说明；reset（改了 Base URL 或 API key）同时清掉说明（§6.1）。
 * @param form 提供商草稿。拉取中 Base URL、API key 只读，其余字段收起，所以返回时草稿还是发出时的值
 */
export function useNewFetch(form: DraftForm<ProviderDraft>): NewFetchControl {
  const fetcher = useFetch();
  const [note, setNote] = useState<string | null>(null);
  async function run(keySecret: string | null) {
    const { draft, touched } = form;
    setNote(null);
    const result = await fetcher.start(newTarget(draft, touched, keySecret));
    if (!result) return;
    const next = prefillDraft(draft, touched, result);
    form.setDraft(next.draft);
    setNote(next.note);
  }
  const reset = () => {
    fetcher.reset();
    setNote(null);
  };
  return { ...fetcher, note, run, reset };
}

// ---- 清单的行（§6.2–§6.4） ----

/** @brief 清单的一行：服务列出的或你手填的模型；数字按输入框的文字保存，加入时再转成配置里的类型。 */
export interface ChecklistRow {
  /** 模型 id：服务的 id 原样，或你手填的；不能改 */
  id: string;
  /** 上下文窗口（输入框的文字） */
  contextWindow: string;
  /** 最大输出（输入框的文字） */
  maxTokens: string;
  /** 你改过 Max output（之后不再随窗口变） */
  maxChosen: boolean;
  /** 支持思考 */
  reasoning: boolean;
  /** 图像输入 */
  image: boolean;
  /** 勾选 */
  picked: boolean;
  /** 窗口不是服务报告的：旁边写 Not reported，你改了值也留着 */
  windowUnreported: boolean;
  /** Max output 不是服务报告的，或随窗口按 §4.3 退回了默认值：旁边写 Not reported，你改了值也留着 */
  maxUnreported: boolean;
  /** 服务报告的输出上限；没报告为 null（改窗口时按 §4.3 用它） */
  reportedMax: number | null;
  /** 服务列出的这一项（标记、提示、模型族从它取）；手填的行为 null */
  source: DiscoveredModel | null;
}

/** @brief 改一行：勾选或四个值。 */
export type RowPatch = Partial<Pick<ChecklistRow, 'contextWindow' | 'maxTokens' | 'reasoning' | 'image' | 'picked'>>;

/** @brief 能勾的行（§6.2）：不是已加入的（added）、不是不能加入的（unusable）。 */
function pickable(row: ChecklistRow): boolean {
  return row.source === null || (!row.source.added && row.source.unusable === null);
}

/**
 * @brief 默认勾选（§6.2；proposal §12 第 4 条）：added、unusable 不勾；服务报告是聊天模型的勾上，不是的不勾；
 *        不报告类型时，列表里能加入的行只有一行就勾上，否则不勾。
 * @param usable 列表里能加入的行数
 */
function defaultPick(model: DiscoveredModel, usable: number): boolean {
  if (model.added || model.unusable !== null) return false;
  return model.chat ?? usable === 1;
}

/** @brief 服务列出的行（列表顺序）与默认勾选（§6.2）。 */
function listedRows(models: readonly DiscoveredModel[]): ChecklistRow[] {
  const usable = models.filter((model) => !model.added && model.unusable === null).length;
  return models.map((model) => ({
    id: model.id, contextWindow: String(model.contextWindow), maxTokens: String(model.maxTokens), maxChosen: false,
    reasoning: model.reasoning, image: model.image, picked: defaultPick(model, usable),
    windowUnreported: !model.reported.contextWindow, maxUnreported: !model.reported.maxTokens,
    reportedMax: model.reported.maxTokens ? model.maxTokens : null, source: model,
  }));
}

/** @brief 手填的一行（§6.4）：勾上；窗口与 Max output 取没报告时的默认值并标 Not reported；思考、图片不勾。 */
function enteredRow(id: string): ChecklistRow {
  return { id, contextWindow: String(UNREPORTED_CONTEXT_WINDOW),
    maxTokens: String(unreportedMaxTokens(UNREPORTED_CONTEXT_WINDOW)), maxChosen: false, reasoning: false,
    image: false, picked: true, windowUnreported: true, maxUnreported: true, reportedMax: null, source: null };
}

/**
 * @brief Max output 随窗口变（§4.3、§6.2）：服务报告了输出上限、且它小于新窗口时用报告的值；
 *        否则为 16384 与新窗口一半中较小的，并标 Not reported。
 * @param window 新窗口输入框的文字
 */
function followWindow(reportedMax: number | null, window: string): Pick<ChecklistRow, 'maxTokens' | 'maxUnreported'> {
  const value = positiveInt(window);
  if (reportedMax !== null && value !== null && reportedMax < value) {
    return { maxTokens: String(reportedMax), maxUnreported: false };
  }
  return { maxTokens: defaultMaxOutput(window), maxUnreported: true };
}

/** @brief 改一行（§6.2）：改了 Max output 之后它不再随窗口变；没改过时随窗口按 §4.3 变。 */
function patchRow(row: ChecklistRow, patch: RowPatch): ChecklistRow {
  if (patch.maxTokens !== undefined) return { ...row, ...patch, maxChosen: true };
  if (patch.contextWindow === undefined || row.maxChosen) return { ...row, ...patch };
  return { ...row, ...patch, ...followWindow(row.reportedMax, patch.contextWindow) };
}

/** @brief 勾选的行转成配置里的模型；模型族按服务的 family 原样保存（§6.2），手填的行为空。 */
function toProviderModel(row: ChecklistRow): ProviderModel {
  return { id: row.id, family: row.source?.family ?? '', contextWindow: Number(row.contextWindow),
    maxTokens: Number(row.maxTokens), reasoning: row.reasoning, input: row.image ? ['text', 'image'] : ['text'] };
}

/** @brief 这一行显示着：过滤框为空，或 id 含过滤框的文字（不分大小写，§6.2）。 */
function matches(row: ChecklistRow, needle: string): boolean {
  return needle === '' || row.id.toLowerCase().includes(needle);
}

// ---- 清单的状态 ----

/** @brief Add a model ID 一行的状态与操作（§6.4）。 */
export interface ManualControl {
  /** 输入框的文字 */
  text: string;
  /** 要显示的错误：改过输入框之后才显示；没有时为 undefined */
  shownError: string | undefined;
  /** 有错误，Add to list 不可用 */
  blocked: boolean;
  /** 改输入框 */
  setText: (text: string) => void;
  /** Add to list：加在清单末尾，输入框清空 */
  add: () => void;
}

/** @brief 清单的状态与操作。 */
export interface ChecklistControl {
  /** 拉取的结果；还没拉取时为 null */
  result: DiscoverResult | null;
  /** 全部行：服务列出的（列表顺序）加手填的（加入顺序） */
  rows: ChecklistRow[];
  /** 显示着的行：过滤框藏起来的不在其中 */
  shown: ChecklistRow[];
  /** 有过滤框：拿到了列表，且行数（含手填的行）超过 20 */
  filterable: boolean;
  /** 过滤框的文字 */
  filter: string;
  /** 改过滤框（只改显示，不改勾选） */
  setFilter: (text: string) => void;
  /** 改一行（按 id） */
  edit: (id: string, patch: RowPatch) => void;
  /** Select all（true）/ Clear selection（false）：只作用于显示着的、能勾的行 */
  selectShown: (picked: boolean) => void;
  /** Add a model ID 一行 */
  manual: ManualControl;
  /** 勾选的行转成的模型，按清单顺序（含过滤框藏起来的） */
  picked: ProviderModel[];
  /** 勾选的行里有字段错误（Add 不可用） */
  invalid: boolean;
}

/** @brief Add a model ID 输入框：文字与改过没有。 */
interface Entry {
  /** 输入框的文字 */
  text: string;
  /** 改过输入框（错误这之后才显示） */
  touched: boolean;
}

/** 输入框空着、还没改过 */
const NO_ENTRY: Entry = { text: '', touched: false };

/**
 * @brief Add a model ID（§6.4）：id 按 §4.1 检查，不能与清单里的任一行（含 Added、没勾的行）或这个提供商已有的模型重复。
 * @param setRows 改清单的行
 */
function manualControl(rows: readonly ChecklistRow[], existing: readonly string[], entry: Entry,
  setEntry: (entry: Entry) => void, setRows: (update: (rows: ChecklistRow[]) => ChecklistRow[]) => void):
  ManualControl {
  const error = idError(entry.text, [...rows.map((row) => row.id), ...existing]);
  return {
    text: entry.text,
    shownError: entry.touched ? error : undefined,
    blocked: error !== undefined,
    setText: (text) => setEntry({ text, touched: true }),
    add: () => {
      if (error !== undefined) return;
      setRows((current) => [...current, enteredRow(entry.text)]);
      setEntry(NO_ENTRY);
    },
  };
}

/**
 * @brief 清单的状态（§6.2–§6.4）。拉取的结果换了（再拉一次、改了地址或 key 后重新拉取）时，行、勾选、改过的值、
 *        手填的行与过滤框都从头来（§6.1）；改 API type 不换结果，清单不变。
 * @param existing 这个提供商已有的模型 id（卡上的清单，Add a model ID 查重复用）；新提供商为空
 */
export function useChecklist(result: DiscoverResult | null, existing: readonly string[]): ChecklistControl {
  const [source, setSource] = useState(result);
  const [rows, setRows] = useState(() => listedRows(result?.models ?? []));
  const [filter, setFilter] = useState('');
  const [entry, setEntry] = useState(NO_ENTRY);
  // §6.1：结果换了就从头来（渲染中按新结果重设，React 随即用新状态重新渲染）
  if (source !== result) {
    setSource(result);
    setRows(listedRows(result?.models ?? []));
    setFilter('');
    setEntry(NO_ENTRY);
  }
  const filterable = result?.listError === null && rows.length > FILTER_ROWS;
  const needle = filterable ? filter.toLowerCase() : '';
  const shown = useMemo(() => (needle ? rows.filter((row) => matches(row, needle)) : rows), [rows, needle]);
  const edit = useCallback((id: string, patch: RowPatch) => {
    setRows((current) => current.map((row) => (row.id === id ? patchRow(row, patch) : row)));
  }, []);
  const selectShown = (picked: boolean) => setRows((current) => current.map((row) => (
    pickable(row) && row.picked !== picked && matches(row, needle) ? { ...row, picked } : row)));
  const picked = useMemo(() => rows.filter((row) => row.picked).map(toProviderModel), [rows]);
  const invalid = useMemo(() => rows.some((row) => row.picked
    && hasErrors(sizeErrors(row.contextWindow, row.maxTokens))), [rows]);
  const manual = manualControl(rows, existing, entry, setEntry, setRows);
  return { result, rows, shown, filterable, filter, setFilter, edit, selectShown, manual, picked, invalid };
}

// ---- 拉取的按钮与说明 ----

/** @brief 拉取的按钮的参数。 */
export interface FetchControlsProps {
  /** 拉取的状态 */
  fetcher: FetchControl;
  /**
   * Fetch models 不可用：Base URL 不是 http/https URL；Add provider 加入中（models-settings.md "本表定下的界面细节"）；
   * 首次启动保存中、测试中（first-run.md "本表定下的界面细节"）；卡上的清单开着（§6.5）
   */
  disabled: boolean;
  /** 卡上的小按钮 */
  compact?: boolean;
  /** 点了 Fetch models */
  onFetch: () => void;
}

/**
 * @brief Fetch models（拉取中为"Fetching models…"、不可用）、拉取中旁边的 Cancel（models.discoverCancel）与拉取的状态
 *        （拉取中 data-state="fetching"；取消后"Fetch cancelled"，§6.1、§6.5）。
 */
export function FetchControls({ fetcher, disabled, compact, onFetch }: FetchControlsProps) {
  const size = compact ? ' compact' : '';
  const state = fetcher.fetching ? 'fetching' : fetcher.cancelled ? 'cancelled' : null;
  return (
    <>
      <button type="button" className={`button${size}`} data-action="fetch-models"
        disabled={disabled || fetcher.fetching} onClick={onFetch}>
        {fetcher.fetching ? 'Fetching models…' : 'Fetch models'}</button>
      {fetcher.fetching && <button type="button" className={`button${size}`} data-action="fetch-cancel"
        onClick={fetcher.cancel}>Cancel</button>}
      {state && <span className="fetch-status" data-testid="fetch-status" data-state={state} role="status">
        {state === 'cancelled' && 'Fetch cancelled'}</span>}
    </>
  );
}

/** @brief 拉取的命令本身失败的原文（§6.1：表单里在 Fetch models 下方；§6.5：卡里）。 */
export function FetchError({ fetcher }: { fetcher: FetchState }) {
  if (fetcher.error === null) return null;
  return <p className="form-message error" role="alert" data-testid="form-message">{fetcher.error}</p>;
}

/** @brief 表单里 API key 下面的一行（Add provider 与首次启动表单，§6.1 第 1 项）：拉取的按钮和下方命令失败的原文。 */
export function FetchRow(props: FetchControlsProps) {
  return (
    <div className="mf-row">
      <span />
      <div className="mf-control">
        <div className="fetch-line"><FetchControls {...props} /></div>
        <FetchError fetcher={props.fetcher} />
      </div>
    </div>
  );
}

/** @brief "Detected: <种类名> <版本>"（§3.3、§6.1 第 2 项）；没拿到列表（server 为 null）时不显示。卡里不用（§6.5）。 */
export function DetectedLine({ result }: { result: DiscoverResult }) {
  if (!result.server) return null;
  const { kind, version } = result.server;
  const text = `Detected: ${serverKindLabel(kind, result.anthropicShape)}${version ? ` ${version}` : ''}`;
  return <p className="fetch-note" data-testid="detected-server" data-kind={kind}>{text}</p>;
}

/** @brief Base URL 换成建议的地址后的说明（§6.1 第 3 项，只在拿到了列表时）。 */
export function BaseUrlNote({ url }: { url: string }) {
  return <p className="fetch-note" data-testid="base-url-note">{`Updated to ${url} so the model list loads.`}</p>;
}

/** @brief 探针代价的说明（§6.1 第 8 项、§6.6、§11；proposal §12 第 5 条）。 */
export function ProbeCostNote() {
  return (
    <p className="fetch-note" data-testid="probe-cost-note">Each model is verified with up to 13 short requests.</p>
  );
}

/** @brief More settings（§6.1 第 7 项、§6.6）：收起时只有这一行，点开后是 children。 */
export function MoreSettings({ children }: { children: ReactNode }) {
  return (
    <details className="more-settings" data-testid="more-settings">
      <summary>More settings</summary>
      <div className="more-settings-body">{children}</div>
    </details>
  );
}

/** @brief Add 按钮的文字（§6.1 第 8 项）：Add 1 model / Add N models；勾选数为 0 时 Add models。 */
export function addModelsLabel(count: number): string {
  if (count === 0) return 'Add models';
  return count === 1 ? 'Add 1 model' : `Add ${count} models`;
}

/** @brief 清单底部的参数。 */
export interface AddFooterProps {
  /** 勾选数 */
  count: number;
  /** Add 不可用：勾选的行有错误，或表单字段有错误 */
  blocked: boolean;
  /** 加入中 */
  busy: boolean;
  /** 关闭表单（不写） */
  onClose: () => void;
}

/**
 * @brief 清单底部（Add provider 与卡上的清单，§6.1 第 8 项、§6.5）：探针代价的说明、Add（提交外面的表单；
 *        加入中"Adding…"；勾选数为 0 时不可用）和关闭表单的 Cancel。
 */
export function AddFooter({ count, blocked, busy, onClose }: AddFooterProps) {
  return (
    <>
      <ProbeCostNote />
      <div className="form-actions">
        <button type="submit" className="button primary" data-action="add-models"
          disabled={busy || blocked || count === 0}>{busy ? 'Adding…' : addModelsLabel(count)}</button>
        <button type="button" className="button" data-action="close-form" disabled={busy} onClick={onClose}>
          Cancel</button>
      </div>
    </>
  );
}

// ---- 清单的视图（§6.2–§6.5） ----

/** @brief 行上的提示的文字（§6.2）。 */
const HINT_TEXTS: Readonly<Record<DiscoverHint, string>> = {
  no_tools: 'The server doesn’t list tool support for this model.',
  trained_window: 'Trained context window. Ollama may use a smaller one; run the long-input test after adding.',
};

/** @brief 行里两个数字框的列名（§6.2；读屏名"<列名> for <id>"，models-settings.md "清单的行"）。 */
const SIZE_LABELS = { contextWindow: 'Context window', maxTokens: 'Max output' } as const;

/** @brief 行上的一个标记（一行小字，§6.2、§6.4）。 */
function Tag({ kind, text }: { kind: string; text: string }) {
  return <span className="row-note" data-testid="row-tag" data-kind={kind}>{text}</span>;
}

/** @brief 行上的标记与提示（§6.2、§6.4），每个一行小字。 */
function RowNotes({ row }: { row: ChecklistRow }) {
  const { source } = row;
  return (
    <>
      {source?.chat === false && <Tag kind="not-chat" text="Not a chat model" />}
      {source?.added && <Tag kind="added" text="Added" />}
      {source && source.unusable !== null && <Tag kind="unusable" text={`Can’t add this model: ${source.unusable}`} />}
      {source === null && <Tag kind="entered" text="Entered by you" />}
      {source?.hints.map((hint) => (
        <span key={hint} className="row-note" data-testid="row-hint" data-kind={hint}>{HINT_TEXTS[hint]}</span>
      ))}
    </>
  );
}

/** @brief 一行里的数字框的参数。 */
interface SizeCellProps {
  /** 这一行 */
  row: ChecklistRow;
  /** 哪个数字 */
  field: 'contextWindow' | 'maxTokens';
  /** 字段错误；没有时为 undefined */
  error: string | undefined;
  /** 改这一行 */
  onEdit: (id: string, patch: RowPatch) => void;
}

/** @brief Context window 或 Max output 的数字框（不写千分位）、Not reported 与字段错误（§6.2）；Added 的行不能改。 */
function SizeCell({ row, field, error, onEdit }: SizeCellProps) {
  const unreported = field === 'contextWindow' ? row.windowUnreported : row.maxUnreported;
  const change = (value: string) => onEdit(row.id, field === 'contextWindow' ? { contextWindow: value }
    : { maxTokens: value });
  return (
    <td>
      <input inputMode="numeric" data-field={field} aria-label={`${SIZE_LABELS[field]} for ${row.id}`}
        value={row[field]} disabled={row.source?.added} aria-invalid={error ? true : undefined}
        onChange={(event) => change(event.target.value)} />
      {unreported && <span className="not-reported" data-testid="not-reported" data-field={field}>Not reported</span>}
      <FieldError field={field} error={error} />
    </td>
  );
}

/** @brief 一行的参数。 */
interface RowViewProps {
  /** 这一行 */
  row: ChecklistRow;
  /** 改一行（稳定的函数，行没变时不重新渲染） */
  onEdit: (id: string, patch: RowPatch) => void;
}

/**
 * @brief 清单的一行（§6.2）：勾选框（读屏名"Add <id>"）、Model ID 与标记、Context window、Max output、
 *        Supports thinking、Image input。memo：改一行或过滤时别的行不重新渲染（OpenRouter 的列表有几百行）。
 */
const RowView = memo(function RowView({ row, onEdit }: RowViewProps) {
  const { id, source } = row;
  const errors = sizeErrors(row.contextWindow, row.maxTokens);
  const chat = source?.chat ?? null;
  const locked = source?.added === true;
  return (
    <tr data-testid="discovered-row" data-model={id} data-chat={chat === null ? 'unknown' : String(chat)}
      data-added={locked ? 'true' : undefined}
      data-unusable={source && source.unusable !== null ? 'true' : undefined}>
      <td><input type="checkbox" name="pick" aria-label={`Add ${id}`} checked={row.picked}
        disabled={!pickable(row)} onChange={(event) => onEdit(id, { picked: event.target.checked })} /></td>
      <td className="checklist-model"><span className="model-id">{id}</span><RowNotes row={row} /></td>
      <SizeCell row={row} field="contextWindow" error={errors.contextWindow} onEdit={onEdit} />
      <SizeCell row={row} field="maxTokens" error={errors.maxTokens} onEdit={onEdit} />
      <td><input type="checkbox" data-field="reasoning" aria-label={`Supports thinking for ${id}`}
        checked={row.reasoning} disabled={locked}
        onChange={(event) => onEdit(id, { reasoning: event.target.checked })} /></td>
      <td><input type="checkbox" data-field="image" aria-label={`Image input for ${id}`} checked={row.image}
        disabled={locked} onChange={(event) => onEdit(id, { image: event.target.checked })} /></td>
    </tr>
  );
});

/**
 * @brief 清单的行（§6.2；列表错误下手填的行同样，§6.3）：有行时才有表头（列名即 §6.2 每行的各列）；
 *        行多时在框里滚动，表头留在上面。
 */
function RowsTable({ rows, onEdit }: { rows: readonly ChecklistRow[]; onEdit: RowViewProps['onEdit'] }) {
  if (rows.length === 0) return null;
  return (
    <div className="checklist-scroll">
      <table className="checklist-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Model ID</th>
            <th scope="col">Context window</th>
            <th scope="col">Max output</th>
            <th scope="col">Supports thinking</th>
            <th scope="col">Image input</th>
          </tr>
        </thead>
        <tbody>{rows.map((row) => <RowView key={row.id} row={row} onEdit={onEdit} />)}</tbody>
      </table>
    </div>
  );
}

/**
 * @brief 过滤框与 Add a model ID 的输入框里按 Enter 不提交外面的表单：加入只由点 Add 按钮发出
 *        （§6.1 第 8 项、§6.5），浏览器的隐式提交不会在过滤或填 id 时误加入。
 */
function keepEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') event.preventDefault();
}

/** @brief 清单的标题行（Models (N)、Select all、Clear selection）、截断说明、过滤框与空列表的一句（§6.2）。 */
function ChecklistHead({ list, result }: { list: ChecklistControl; result: DiscoverResult }) {
  return (
    <>
      <div className="checklist-head">
        <h4>{`Models (${result.models.length})`}</h4>
        <span className="row-actions">
          <button type="button" className="button compact" data-action="select-all"
            onClick={() => list.selectShown(true)}>Select all</button>
          <button type="button" className="button compact" data-action="clear-selection"
            onClick={() => list.selectShown(false)}>Clear selection</button>
        </span>
      </div>
      {result.truncated && (
        <p className="fetch-note" data-testid="checklist-truncated">Showing the first 1,000 models.</p>
      )}
      {list.filterable && <input className="checklist-filter" data-testid="checklist-filter" placeholder="Filter models"
        aria-label="Filter models" spellCheck={false} value={list.filter} onKeyDown={keepEnter}
        onChange={(event) => list.setFilter(event.target.value)} />}
      {result.models.length === 0 && <p className="fetch-note">The server didn’t list any models.</p>}
    </>
  );
}

/** @brief 地址的主机，非默认端口时带端口（§6.3 unreachable 的"<主机>"）。 */
function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url;
}

/** @brief 列表错误的一句（§6.3）。 */
function listErrorText(error: DiscoverListError, baseUrl: string): string {
  switch (error.kind) {
    case 'rejected': return `The server rejected the API key: ${error.detail}`;
    case 'unreachable': return `Couldn’t reach ${hostOf(baseUrl)}: ${error.detail}`;
    case 'no_list': return 'This server doesn’t list its models.';
    case 'invalid': return `Couldn’t read the model list: ${error.detail}`;
  }
}

/** @brief 列表错误（§6.3）：清单的位置换成这一句，后面一句"You can still add model IDs below."。 */
function ListError({ error, baseUrl }: { error: DiscoverListError; baseUrl: string }) {
  return (
    <div className="list-error" data-testid="list-error" data-kind={error.kind}>
      <p>{listErrorText(error, baseUrl)}</p>
      <p>You can still add model IDs below.</p>
    </div>
  );
}

/** @brief Add a model ID 一行（§6.4）：Model ID 输入框和 Add to list；错误在改过输入框之后才显示。 */
function ManualModel({ manual }: { manual: ManualControl }) {
  const id = useId();
  return (
    <div className="mf-row" data-testid="manual-model">
      <label htmlFor={id}>Add a model ID</label>
      <div className="mf-control">
        <div className="manual-line">
          <input id={id} data-field="id" aria-label="Model ID" spellCheck={false} value={manual.text}
            aria-invalid={manual.shownError ? true : undefined} onKeyDown={keepEnter}
            onChange={(event) => manual.setText(event.target.value)} />
          <button type="button" className="button compact" data-action="add-to-list" disabled={manual.blocked}
            onClick={manual.add}>Add to list</button>
        </div>
        <FieldError field="id" error={manual.shownError} />
      </div>
    </div>
  );
}

/**
 * @brief 清单（§6.2）或列表错误（§6.3）、手填的行、Not listed 一行（卡上，§6.5）与 Add a model ID（§6.4）。
 *        列表错误时手填的行列在错误的两句下面，没有 Models (N)、Select all、Clear selection 和过滤框。
 */
export function ChecklistView({ list }: { list: ChecklistControl }) {
  const { result } = list;
  if (!result) return null;
  const rows = <RowsTable rows={list.shown} onEdit={list.edit} />;
  return (
    <>
      {result.listError ? (
        <>
          <ListError error={result.listError} baseUrl={result.baseUrl} />
          {rows}
        </>
      ) : (
        <div className="checklist" data-testid="checklist">
          <ChecklistHead list={list} result={result} />
          {rows}
        </div>
      )}
      {result.notListed.length > 0 && (
        <p className="fetch-note" data-testid="not-listed">
          {`Not listed by the server: ${result.notListed.join(', ')}`}</p>
      )}
      <ManualModel manual={list.manual} />
    </>
  );
}
