// 增强调度（docs/specs/memory.md §9.1–§9.4、§9.9、§9.10）：每个项目的 enhance.json（经记忆模块的写入队列原子写）、
// 开关与设置、每天的时刻与补跑、只有一个的定时器、全应用串行的队列、新会话的提示。一次运行本身在 enhanceRun.ts。
// 队列只在内存里：后台进程退出时丢掉，下次启动按 doneThrough 重新算出来（§9.4）。不监视文件、不轮询（§0）。
// 时钟（now、setTimeout、clearTimeout）可以注入，默认系统时钟（同模型池的 PoolClock），单元测试用它驱动日子与定时器。

import { z } from 'zod';
import {
  ENHANCE_TASKS, MEMORY_DEFAULTS, type EnhanceInfo, type EnhanceTask, type MemoryGlobalEvent, type MemoryNotice,
  type RevisionCounts,
} from '../shared/memory';
import {
  PickSchema, THINKING_LEVELS, type ModelConfig, type ModelPick, type ThinkingLevel,
} from '../shared/models';
import { addDays, dayOf, dueDays, nextBoundary, retime, type DayKey } from './enhanceDays';
import { runTask, type EnhanceSettings, type RunOutcome, type TaskState } from './enhanceRun';
import {
  RUN_CLOSED, enqueue, failStaleRun, listProjectDirs, projectDir, readProjectJson, revision as readRevision,
  writeProjectJson,
} from './memory';
import { localIso } from './memoryFiles';
import { findProvider, splitRef } from './modelConfig';
import { currentModelLayer, getModelLayer, type ModelLayer, type ProjectContext } from './modelLayer';
import type { PoolClock } from './modelPool';
import type { ModelRef } from './modelTypes';
import { loadPi } from './pi';
import { staticCheck } from './selector';
import { decideTrust } from './trust';

// ---- 对外的类型 ----

/** @brief 增强调度的时钟（§9.3）：同模型池的 PoolClock（now、setTimeout、clearTimeout）。 */
export type EnhanceClock = PoolClock;

/** @brief enhance.set 能改的项（§8）；没给的不变。 */
export interface EnhancePatch {
  /** 开关 */
  enabled?: boolean;
  /** 选择范围 */
  pick?: ModelPick;
  /** 思考强度 */
  thinking?: ThinkingLevel;
  /** 用协作模式跑 */
  team?: boolean;
  /** 每天的时刻 `HH:MM` */
  time?: string;
}

/** @brief startEnhance 的参数。 */
export interface EnhanceOptions {
  /** Electron 的 userData 目录 */
  userData: string;
  /** 发全局事件（mori.enhance_progress） */
  emitGlobal: (event: MemoryGlobalEvent) => void;
  /** 时钟；省略时用系统时钟 */
  clock?: EnhanceClock;
}

// ---- 文字与常量 ----

/** 每个项目的增强设置与状态（§3、§9.1） */
const ENHANCE_FILE = 'enhance.json';
/** 关掉增强时正在跑的那一次的原因（§9.6） */
const TURNED_OFF = 'Enhancement was turned off';
/** 没有模型时 enhance.run 的原因（§9.9：§10.4“没有模型”那一行的原因） */
const NO_MODEL = 'Choose a model in enhancement settings';
/** 关着时 enhance.run 的原因（这时界面不让点 Run now，§10.4；原文是本文件定的） */
const TURNED_OFF_ALREADY = 'Enhancement is off for this project.';
/**
 * 还没定下思考强度（从没打开过、也没在设置对话框保存过）时 enhance.get 报的值：newSessionThinking 规则最后的默认；
 * 打开增强时才按规则定下（§9.1）
 */
const UNSET_THINKING: ThinkingLevel = 'medium';

/** 系统时钟 */
const SYSTEM_CLOCK: EnhanceClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// ---- enhance.json（§9.1） ----

/** 日子 `YYYY-MM-DD` */
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Not a day');
/** 每天的时刻 `HH:MM`（同 shared/memory.ts 的 enhance.set） */
const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Not a time');
/** ISO 时刻 */
const InstantSchema = z.string().refine((text) => !Number.isNaN(Date.parse(text)), 'Not a time');
/** 上次结果（EnhanceLast） */
const LastSchema = z.object({
  day: DaySchema, at: InstantSchema, status: z.enum(['done', 'failed', 'skipped']), error: z.string().nullable(),
  revision: z.string().nullable(), tokens: z.number(),
  counts: z.object({ added: z.number(), changed: z.number(), deleted: z.number() }).nullable(),
});
/** 一个任务的状态（TaskState） */
const TaskSchema = z.object({
  doneThrough: DaySchema.nullable(), watermarks: z.record(z.string(), z.string()),
  feedbackSeen: InstantSchema.nullable(), running: z.string().nullable(), last: LastSchema.nullable(),
});
/** 待显示的提示（MemoryNotice） */
const NoticeSchema = z.object({
  revisions: z.array(z.string()), counts: z.object({ taste: z.number(), strategy: z.number(), review: z.number() }),
  from: DaySchema, to: DaySchema,
});
/** 整个文件；开着时一定有 since 与 thinking（打开时定下，§9.1） */
const FileSchema = z.object({
  enabled: z.boolean(), pick: PickSchema.nullable(), thinking: z.enum(THINKING_LEVELS).nullable(), team: z.boolean(),
  time: TimeSchema, since: DaySchema.nullable(),
  tasks: z.object({ taste: TaskSchema, strategy: TaskSchema, review: TaskSchema }), notice: NoticeSchema.nullable(),
}).refine((file) => !file.enabled || (file.since !== null && file.thinking !== null),
  'An enabled project needs since and thinking');
/** @brief enhance.json 的内容。thinking 为 null：还没定下（打开增强时按规则定）。 */
type EnhanceFile = z.infer<typeof FileSchema>;

/** @brief 一个任务的空状态。 */
function freshTask(): TaskState {
  return { doneThrough: null, watermarks: {}, feedbackSeen: null, running: null, last: null };
}

/** @brief 文件不存在时（= 关，§9.1）的内容。 */
function freshFile(): EnhanceFile {
  return { enabled: false, pick: null, thinking: null, team: false, time: MEMORY_DEFAULTS.dailyTime, since: null,
    tasks: { taste: freshTask(), strategy: freshTask(), review: freshTask() }, notice: null };
}

/** @brief 错误的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @brief 读一个项目的 enhance.json（§9.1）：项目目录被别的工作目录占用（§3）、读不出来或内容不对时给出原因（这个项目按关处理），
 *        记错误日志；文件不存在时 file 为 null。
 */
async function loadFile(cwd: string): Promise<{ file: EnhanceFile | null; error: string | null }> {
  try {
    const owner = projectDir(cwd).error;
    if (owner !== null) {
      console.error(`[kernel] enhancement of ${cwd} is unavailable: ${owner}`);
      return { file: null, error: owner };
    }
    const raw = await readProjectJson<unknown>(cwd, ENHANCE_FILE);
    if (raw === null) return { file: null, error: null };
    const parsed = FileSchema.safeParse(raw);
    if (parsed.success) return { file: parsed.data, error: null };
    const error = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');
    console.error(`[kernel] ${ENHANCE_FILE} of ${cwd} can't be read: ${error}`);
    return { file: null, error };
  } catch (failure) {
    const error = errorText(failure);
    console.error(`[kernel] ${ENHANCE_FILE} of ${cwd} can't be read: ${error}`);
    return { file: null, error };
  }
}

/**
 * @brief 在记忆模块的写入队列里读改写 enhance.json（§9.1、§6.7）。
 * @param cwd 项目的工作目录
 * @param change 改法：拿到现在的内容，给出新的内容
 * @param create 文件不存在时从关着的空文件开始；为假时文件不存在就不写
 * @return 改之前与之后的内容；没写时为 null
 * @throws Error 项目目录被占用、读不出来、改法出错或写失败
 */
async function mutate(cwd: string, change: (file: EnhanceFile) => EnhanceFile | Promise<EnhanceFile>,
  create: boolean): Promise<{ previous: EnhanceFile; next: EnhanceFile } | null> {
  return enqueue(async () => {
    const { file, error } = await loadFile(cwd);
    if (error !== null) throw new Error(error);
    if (file === null && !create) return null;
    const previous = file ?? freshFile();
    const next = await change(previous);
    await writeProjectJson(cwd, ENHANCE_FILE, next);
    return { previous, next };
  });
}

/** @brief 三个任务各自按 change 改。 */
function mapTasks(file: EnhanceFile, change: (task: EnhanceTask, state: TaskState) => TaskState): EnhanceFile['tasks'] {
  return { taste: change('taste', file.tasks.taste), strategy: change('strategy', file.tasks.strategy),
    review: change('review', file.tasks.review) };
}

/** @brief 能跑时的设置：开着、有选择范围；否则为 null（§9.1“pick 为 null 时开关可以打开，但不跑”）。 */
function runSettings(file: EnhanceFile): EnhanceSettings | null {
  if (!file.enabled || file.pick === null || file.since === null || file.thinking === null) return null;
  return { pick: file.pick, thinking: file.thinking, team: file.team, time: file.time, since: file.since };
}

// ---- 打开、改时刻（§9.1） ----

/** @brief 设置里新会话的默认范围（model-config.json 的 normalDefault）；没有时为 null。 */
async function defaultPick(): Promise<ModelPick | null> {
  return (await getModelLayer()).getConfig()?.normalDefault ?? null;
}

/**
 * @brief 取第一个候选与它的档案要用到的模型层部分（§9.1 的取法；§8 effortPicks、noOffPicks，model-providers.md §7.7）。
 */
export type PickLayer = Pick<ModelLayer, 'expandPickIn' | 'staticBase' | 'profileOf'>;

/**
 * @brief 范围在这个项目里的第一个候选（§9.1，同 ModelSession.newSessionThinking 的规则）：静态校验后的第一个候选，
 *        没有时展开的第一个；都没有时为 null。
 * @param layer 模型层
 * @param context 这个项目的项目配置与允许的区域（projectContext）
 * @param pick 选择范围；没有时为 null
 */
function firstCandidate(layer: PickLayer, context: ProjectContext, pick: ModelPick | null): ModelRef | null {
  const candidates = pick === null ? null : layer.expandPickIn(context, pick);
  return staticCheck({ ...layer.staticBase(context), pick, candidates }).first ?? candidates?.[0] ?? null;
}

/**
 * @brief 范围的第一个候选（firstCandidate）的默认思考强度（§9.1，同 ModelSession.newSessionThinking 的规则：
 *        它的 modelThinkingLevels → defaultThinkingLevel → medium）。设置按这个项目的信任结果读
 *        （同增强会话，§9.6：decideTrust(cwd, undefined)）。
 */
async function defaultThinking(cwd: string, pick: ModelPick | null): Promise<ThinkingLevel> {
  const [pi, layer, trust] = await Promise.all([loadPi(), getModelLayer(), decideTrust(cwd, undefined)]);
  const first = firstCandidate(layer, await layer.projectContext(cwd), pick);
  const split = first === null ? null : splitRef(first);
  const settings = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: trust.trusted });
  return (split ? settings.getModelThinkingLevel(split.providerId, split.modelId) : undefined)
    ?? settings.getDefaultThinkingLevel() ?? 'medium';
}

// ---- 设置对话框的 Effort（§8 effortPicks、noOffPicks，§10.4） ----

/** @brief 设置对话框的 Effort 用的两项（EnhanceInfo 的 effortPicks、noOffPicks，§8）。 */
type PickThinking = Pick<EnhanceInfo, 'effortPicks' | 'noOffPicks'>;

/** @brief 模型配置里的每个选择范围（同顶栏菜单的各项，selector.pickOptions）：分组、提供商、`<provider>/<model>`。 */
function configPicks(config: ModelConfig): ModelPick[] {
  return [...config.groups.map((group) => group.id), ...config.providers.map((provider) => provider.id),
    ...config.providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`))];
}

/** @brief 模型在配置里标了 Supports thinking（reasoning）；不在配置里时为假。 */
function marksThinking(config: ModelConfig, ref: ModelRef): boolean {
  const split = splitRef(ref);
  const provider = split === null ? undefined : findProvider(config, split.providerId);
  return provider?.models.find((model) => model.id === split?.modelId)?.reasoning ?? false;
}

/**
 * @brief 设置对话框的 Effort 用（§8 effortPicks 与 noOffPicks、§10.4；model-providers.md §7.7）：模型配置里每个
 *        选择范围在这个项目里按 §9.1 的规则取到的第一个候选（firstCandidate）是否标了 Supports thinking
 *        （effortPicks[pick]），以及它的档案（layer.profileOf）reasoning.off_refused 是否为真（为真时 pick 在
 *        noOffPicks 里；没有档案按假）。取不到候选的范围两边都不出现。
 * @param layer 模型层
 * @param context 这个项目的项目配置与允许的区域（projectContext）
 * @param config 模型配置
 */
export function pickThinking(layer: PickLayer, context: ProjectContext, config: ModelConfig): PickThinking {
  const effortPicks: Record<ModelPick, boolean> = {};
  const noOffPicks: ModelPick[] = [];
  for (const pick of configPicks(config)) {
    const first = firstCandidate(layer, context, pick);
    if (first === null) continue;
    effortPicks[pick] = marksThinking(config, first);
    // §7.7：第一个候选的思考关不掉（档案 off_refused），Effort 不列 Off
    if (layer.profileOf(first)?.reasoning.off_refused === true) noOffPicks.push(pick);
  }
  return { effortPicks, noOffPicks };
}

/**
 * @brief 这个项目的 pickThinking（§8、§10.4）。不在记忆的写入队列里算，也不等模型层启动（currentModelLayer）：
 *        模型层还没启动好（还在启动，或没能启动、启动时已记日志）、没有配置时两项都为空；读项目配置出错时记错误日志，
 *        两项都为空。
 * @param cwd 项目的工作目录
 */
async function pickThinkingIn(cwd: string): Promise<PickThinking> {
  try {
    const layer = currentModelLayer();
    const config = layer?.getConfig() ?? null;
    if (layer === null || config === null) return { effortPicks: {}, noOffPicks: [] };
    return pickThinking(layer, await layer.projectContext(cwd), config);
  } catch (error) {
    console.error(`[kernel] reading the thinking of the model ranges in ${cwd} failed: ${errorText(error)}`);
    return { effortPicks: {}, noOffPicks: [] };
  }
}

/** @brief 打开时没有已存的值要用的默认范围与思考强度（§9.1）。 */
interface EnableDefaults {
  /** 默认范围；设置里没有时为 null */
  pick: ModelPick | null;
  /** 范围第一个候选的默认思考强度 */
  thinking: ThinkingLevel;
}

/**
 * @brief 这次 enhance.set 要打开增强时，先算好没有已存值时用的默认范围与思考强度（要等模型层，所以不在写入队列里算，
 *        不挡住记忆的写入）。不是打开时为 null；已存的值用不到默认值时不问模型层。
 * @throws Error 项目目录被占用、读不出设置（不问模型层，与 mutate 拒绝的原因相同），或模型层没能启动
 */
async function enableDefaults(cwd: string, patch: EnhancePatch): Promise<EnableDefaults | null> {
  if (patch.enabled !== true) return null;
  const { file, error } = await loadFile(cwd);
  if (error !== null) throw new Error(error);
  const pick = patch.pick ?? file?.pick ?? await defaultPick();
  const thinking = patch.thinking ?? file?.thinking ?? await defaultThinking(cwd, pick);
  return { pick, thinking };
}

/**
 * @brief 打开（§9.1）：已有的 pick、thinking、team、time 保留，没有的 pick 取默认范围、thinking 按规则；
 *        since 为打开时属于的日子，每个任务的 doneThrough 不早于 since 的前一天；水位保留。
 */
function turnedOn(file: EnhanceFile, now: number, defaults: EnableDefaults): EnhanceFile {
  const since = dayOf(now, file.time);
  const floor = addDays(since, -1);
  const tasks = mapTasks(file, (_, state) => ({ ...state,
    doneThrough: state.doneThrough === null || state.doneThrough < floor ? floor : state.doneThrough }));
  return { ...file, enabled: true, pick: file.pick ?? defaults.pick, thinking: file.thinking ?? defaults.thinking,
    since, tasks };
}

/**
 * @brief 改了每天的时刻（§9.1、§12）：按新的时刻重新算今天，doneThrough 退到新的今天的前一天、since 不晚于新的今天；
 *        从没打开过（没有 since）时只换时刻。
 */
function retimed(file: EnhanceFile, time: string, now: number): EnhanceFile {
  const since = file.since;
  if (since === null) return { ...file, time };
  // 打开时每个任务的 doneThrough 都已定为不早于 since 的前一天（§9.1）
  const doneThrough = Object.fromEntries(ENHANCE_TASKS.map((task) =>
    [task, file.tasks[task].doneThrough ?? addDays(since, -1)])) as Record<EnhanceTask, DayKey>;
  const result = retime({ since, doneThrough, newTime: time, now });
  return { ...file, time, since: result.since,
    tasks: mapTasks(file, (task, state) => ({ ...state, doneThrough: result.doneThrough[task] })) };
}

/**
 * @brief enhance.set 的改法：先换范围、强度、协作，再改时刻，最后开或关（打开按新的时刻算 since）。
 * @param defaults 打开时没有已存值要用的默认值（enableDefaults）；不是打开时为 null
 */
function patched(file: EnhanceFile, patch: EnhancePatch, defaults: EnableDefaults | null): EnhanceFile {
  const now = clock.now();
  let next: EnhanceFile = { ...file, pick: patch.pick ?? file.pick, thinking: patch.thinking ?? file.thinking,
    team: patch.team ?? file.team };
  if (patch.time !== undefined && patch.time !== file.time) next = retimed(next, patch.time, now);
  if (patch.enabled === true && !file.enabled && defaults) next = turnedOn(next, now, defaults);
  if (patch.enabled === false) next = { ...next, enabled: false };
  return next;
}

// ---- 队列（§9.4） ----

/** @brief 排队的一项：项目、任务、日子。 */
interface QueueItem {
  /** 项目的工作目录 */
  cwd: string;
  /** 任务 */
  task: EnhanceTask;
  /** 日子 D */
  day: DayKey;
}

/** @brief 跑完一项交回给 pump 的：要重新排的项、清掉正在跑的这一项之后要发的结束进度（丢掉的项为 null）。 */
interface Finished {
  /** 要重新排的项 */
  again: QueueItem[];
  /** 发结束的进度 */
  announce: (() => void) | null;
}

/** @brief 正在跑的那一项。 */
interface Current {
  /** 这一项 */
  item: QueueItem;
  /** 停止它（关掉增强、后台进程退出）：abort 的 reason 是失败的原因 */
  controller: AbortController;
  /** 它跑完（结果已写进 enhance.json） */
  done: Promise<void>;
}

/** Mori 的数据目录；startEnhance 收尾完上次的运行之前为 null（这之前排进来的项等它放行再跑） */
let userDataDir: string | null = null;
/** 发全局事件 */
let emitGlobal: (event: MemoryGlobalEvent) => void = () => undefined;
/** 时钟 */
let clock: EnhanceClock = SYSTEM_CLOCK;
/** 排着的项，按 §9.4 的顺序 */
let queue: QueueItem[] = [];
/** 正在跑的那一项 */
let current: Current | null = null;
/** 唯一的定时器；没有时为 null */
let timer: unknown = null;
/**
 * 上次按日界排队的时刻（启动、定时器到点）：到点时它之后过了日界的项目才排队；定时器设在它之后最早的日界，
 * 所以重设定时器（enhance.set）不会跳过已经过了、还没排队的日界（例如睡眠中错过的时刻，§9.3）
 */
let checkedAt = 0;
/** checkedAt 之后的日界还要排队（启动之后、上一次重设时有开着的项目）；为假时下一次重设从现在算 */
let watching = false;
/** 重设定时器的先后（一个接一个，最后一次为准） */
let arming: Promise<void> = Promise.resolve();
/** 后台进程正在退出：不再排队、不再设定时器 */
let stopping = false;

/** @brief 发 mori.enhance_progress（§9.9）；发送出错只记日志。 */
function progress(item: QueueItem, phase: 'queued' | 'running' | RunOutcome['status'], error?: string,
  revision?: string | null): void {
  try {
    emitGlobal({ type: 'mori.enhance_progress', cwd: item.cwd, task: item.task, day: item.day, phase,
      ...(error !== undefined ? { error } : {}), ...(revision ? { revision } : {}) });
  } catch (failure) {
    console.error(`[kernel] sending mori.enhance_progress failed: ${errorText(failure)}`);
  }
}

/** @brief 是同一项（项目、任务、日子都相同）。 */
function sameItem(a: QueueItem, b: QueueItem): boolean {
  return a.cwd === b.cwd && a.task === b.task && a.day === b.day;
}

/** @brief 队列的顺序（§9.4）：日子从早到晚；同一天按项目 cwd 字符串升序；同一个项目同一天按 TASTE、STRATEGY、REVIEW。 */
function queueOrder(a: QueueItem, b: QueueItem): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.cwd !== b.cwd) return a.cwd < b.cwd ? -1 : 1;
  return ENHANCE_TASKS.indexOf(a.task) - ENHANCE_TASKS.indexOf(b.task);
}

/** @brief 排进队列（§9.4）：已在队列里或正在跑的不重复排；每排进一项发 queued。 */
function addItems(items: readonly QueueItem[]): void {
  if (stopping) return;
  for (const item of items) {
    if (queue.some((queued) => sameItem(queued, item)) || (current && sameItem(current.item, item))) continue;
    queue.push(item);
    progress(item, 'queued');
  }
  queue.sort(queueOrder);
  pump();
}

/** @brief 一个项目每个任务该跑的日子（§9.3）：doneThrough 之后、今天之前；不能跑（关、没有模型）时为空。 */
function dueItems(cwd: string, file: EnhanceFile, today: DayKey): QueueItem[] {
  const settings = runSettings(file);
  if (settings === null) return [];
  return ENHANCE_TASKS.flatMap((task) => dueDays(file.tasks[task].doneThrough, settings.since, today)
    .map((day) => ({ cwd, task, day })));
}

/** @brief 读一个项目的 enhance.json，给出它该跑的日子。 */
async function dueOf(cwd: string): Promise<QueueItem[]> {
  const { file } = await loadFile(cwd);
  return file === null ? [] : dueItems(cwd, file, dayOf(clock.now(), file.time));
}

/** @brief 去掉这个项目排着的项。 */
function removeQueued(cwd: string): void {
  queue = queue.filter((item) => item.cwd !== cwd);
}

/** @brief 一个任务的日子 D 失败：这个任务排在 D 之后的日子这一轮不跑（§9.4）。 */
function removeLater(failed: QueueItem): void {
  queue = queue.filter((item) => !(item.cwd === failed.cwd && item.task === failed.task && item.day > failed.day));
}

/** @brief 关掉一个项目（§9.4）：它排着的项去掉；正在跑的那一次停止，算失败。 */
function dropProject(cwd: string, reason: string): void {
  removeQueued(cwd);
  if (current?.item.cwd === cwd) current.controller.abort(reason);
}

/**
 * @brief 同一时刻只跑一项（§9.4）：没有在跑的时候取队首开始；跑完再排上它要重新排的项（processItem 的结果：
 *        正在跑时同一项不重复排，所以跑完才排），然后取下一项。
 */
function pump(): void {
  if (current !== null || stopping || userDataDir === null) return;
  const item = queue.shift();
  if (!item) return;
  const running: Current = { item, controller: new AbortController(), done: Promise.resolve() };
  current = running;
  running.done = processItem(item, running.controller.signal)
    .catch((error: unknown): Finished => {
      console.error(`[kernel] the enhancement queue failed: ${errorText(error)}`);
      return { again: [], announce: null };
    })
    .then((finished) => {
      // 先清掉正在跑的这一项再发结束的进度：界面收到进度就读 enhance.get，读到的不能还是“正在跑”（§10.4）
      current = null;
      finished.announce?.();
      addItems(finished.again);
    });
}

/**
 * @brief 跑队列里的一项：重新读设置（关了、读不出来、日子已不再该跑时丢掉），先收尾这个任务还记着的上一次修订
 *        （§9.10 的做法），发 running，跑（enhanceRun.ts），把结果写进 enhance.json 并发结束的进度；
 *        失败时这个任务之后的日子这一轮不跑。
 * @return 跑完要重新排的项（今天这一次跑的时候日子结束了时，这个项目该跑的日子，endedDays；否则为空）与结束的进度
 *         （pump 清掉正在跑的这一项之后再发；丢掉的项没有）
 */
async function processItem(item: QueueItem, signal: AbortSignal): Promise<Finished> {
  const { file } = await loadFile(item.cwd);
  const settings = file === null ? null : runSettings(file);
  const today = file === null ? null : dayOf(clock.now(), file.time);
  if (file === null || settings === null || today === null || item.day > today || signal.aborted) {
    console.error(`[kernel] the ${item.task} enhancement of ${item.day} in ${item.cwd} was dropped: `
      + 'enhancement is off, has no model, or its settings changed');
    return { again: [], announce: null };
  }
  // 上一次的修订还记在 running 里（endRun 没写成）：先定为 failed，不然它被这次的 id 盖掉后永远是 running（§9.8、§9.10）
  const stale = file.tasks[item.task].running;
  if (stale !== null) await closeStale(item.cwd, item.task, stale);
  progress(item, 'running');
  const outcome = await runTask({ ...item, today: item.day === today, settings, state: file.tasks[item.task],
    userData: userDataDir ?? '', now: () => clock.now(), signal, onBegin: (id) => markRunning(item, id) });
  await record(item, item.day === today, outcome);
  if (outcome.status === 'failed') removeLater(item);
  const again = item.day === today ? await endedDays(item) : [];
  return { again, announce: () => announceEnd(item, outcome) };
}

/** @brief 一项跑完、结果写进 enhance.json 之后的结束进度（§9.9）。 */
function announceEnd(item: QueueItem, outcome: RunOutcome): void {
  if (outcome.status === 'skipped') progress(item, 'skipped');
  else progress(item, outcome.status, outcome.status === 'failed' ? outcome.error : undefined, outcome.revision);
}

/**
 * @brief 今天这一次（现在运行）跑完时它的日子已经结束（§9.3、§9.9）：到点时这一天与正在跑的这一次是同一项，没有排上，
 *        现在把这个项目该跑的日子排上（重新读设置：关了、改了时刻的按现在的算）。日子还没结束时为空。
 * @param item 刚跑完的今天这一次
 */
async function endedDays(item: QueueItem): Promise<QueueItem[]> {
  const { file } = await loadFile(item.cwd);
  if (file === null) return [];
  const today = dayOf(clock.now(), file.time);
  return item.day < today ? dueItems(item.cwd, file, today) : [];
}

/**
 * @brief beginRun 之后在 enhance.json 记下这条修订的 id（§9.8）。
 * @throws Error 没记下（读写失败；文件已经不在，即增强已经关了）：这次运行不建会话、按失败收尾（enhanceRun.ts）
 */
async function markRunning(item: QueueItem, id: string): Promise<void> {
  try {
    const written = await mutate(item.cwd, (file) => ({ ...file,
      tasks: mapTasks(file, (task, state) => (task === item.task ? { ...state, running: id } : state)) }), false);
    if (written === null) throw new Error(TURNED_OFF_ALREADY);
  } catch (error) {
    console.error(`[kernel] recording the running revision ${id} in ${item.cwd} failed: ${errorText(error)}`);
    throw error;
  }
}

// ---- 结果写进 enhance.json（§9.5 第 3 条、§9.8、§9.10） ----

/** @brief 两个日子中晚的一个。 */
function laterDay(a: DayKey | null, b: DayKey): DayKey {
  return a === null || b > a ? b : a;
}

/** @brief 两个 ISO 时刻中晚的一个。 */
function laterInstant(a: string | null, b: string | null): string | null {
  if (b === null) return a;
  return a === null || Date.parse(b) > Date.parse(a) ? b : a;
}

/** @brief 修订的计数去掉 moved（EnhanceLast.counts）。 */
function lastCounts(counts: RevisionCounts | null): { added: number; changed: number; deleted: number } | null {
  return counts && { added: counts.added, changed: counts.changed, deleted: counts.deleted };
}

/**
 * @brief 改了东西的修订加进 notice（§9.8）：追加到 revisions 末尾，这一种加上 added + changed + deleted，
 *        from、to 取最早、最晚的日子；没改东西或没有修订时不变。
 */
function noticeAfter(notice: MemoryNotice | null, task: EnhanceTask, day: DayKey,
  revision: string | null, counts: RevisionCounts | null): MemoryNotice | null {
  const changed = counts ? counts.added + counts.changed + counts.deleted : 0;
  if (revision === null || changed === 0) return notice;
  if (notice === null) {
    return { revisions: [revision], counts: { taste: 0, strategy: 0, review: 0, [task]: changed }, from: day, to: day };
  }
  return { revisions: [...notice.revisions, revision],
    counts: { ...notice.counts, [task]: notice.counts[task] + changed },
    from: day < notice.from ? day : notice.from, to: day > notice.to ? day : notice.to };
}

/** @brief 一次运行的结果与它的日子、是不是今天、写下的时刻。 */
interface Recorded {
  /** 日子 D */
  day: DayKey;
  /** D 是开始时的今天：doneThrough 不推进 */
  today: boolean;
  /** 结果 */
  outcome: RunOutcome;
  /** 写下的时刻（ms） */
  now: number;
  /** last.at（ISO，带时区） */
  at: string;
}

/**
 * @brief 结果之后的任务状态：跳过推进 doneThrough（今天除外）、last 记 skipped（§9.5 第 3 条）；成功推进水位、
 *        feedbackSeen、doneThrough（今天除外），记 last、清掉 running（§9.8）；失败只记 last、清掉 running
 *        （endRun 没写成时留着，下次启动或这个任务下一次运行之前按 §9.10 收尾）。
 */
function taskAfter(state: TaskState, result: Recorded): TaskState {
  const { day, today, outcome, at } = result;
  const doneThrough = today ? state.doneThrough : laterDay(state.doneThrough, day);
  if (outcome.status === 'skipped') {
    return { ...state, doneThrough,
      last: { day, at, status: 'skipped', error: null, revision: null, tokens: 0, counts: null } };
  }
  const error = outcome.status === 'failed' ? outcome.error : null;
  const last = { day, at, status: outcome.status, error, revision: outcome.revision, tokens: outcome.tokens,
    counts: lastCounts(outcome.counts) };
  if (outcome.status === 'failed') return { ...state, running: outcome.keepRunning ? state.running : null, last };
  return { ...state, doneThrough, running: null, last, watermarks: { ...state.watermarks, ...outcome.watermarks },
    feedbackSeen: laterInstant(state.feedbackSeen, outcome.feedbackSeen) };
}

/**
 * @brief 结果写进 enhance.json 之后的内容：这个任务的状态与 notice。运行中改了时刻、D 按现在的时刻还没结束时，
 *        doneThrough 同样不推进（§9.1：doneThrough 不晚于今天的前一天）。
 */
function withOutcome(file: EnhanceFile, task: EnhanceTask, result: Recorded): EnhanceFile {
  const { outcome } = result;
  const open = { ...result, today: result.today || result.day >= dayOf(result.now, file.time) };
  const notice = outcome.status === 'skipped' ? file.notice
    : noticeAfter(file.notice, task, result.day, outcome.revision, outcome.counts);
  return { ...file, notice,
    tasks: mapTasks(file, (each, state) => (each === task ? taskAfter(state, open) : state)) };
}

/** @brief 把一次运行的结果写进 enhance.json（出错只记日志）；结束的进度由 pump 在清掉正在跑的这一项之后发（§9.9）。 */
async function record(item: QueueItem, today: boolean, outcome: RunOutcome): Promise<void> {
  const now = clock.now();
  const result: Recorded = { day: item.day, today, outcome, now, at: localIso(new Date(now)) };
  try {
    await mutate(item.cwd, (file) => withOutcome(file, item.task, result), false);
  } catch (error) {
    console.error(`[kernel] recording the ${item.task} enhancement of ${item.day} in ${item.cwd} failed: `
      + errorText(error));
  }
}

// ---- 启动时收尾上次的运行（§9.10） ----

/** @brief 上次留下的运行收尾之后的 enhance.json：清掉 running；读得到那条修订的日子时记 last 失败、有改动时加进 notice。 */
function staleClosed(file: EnhanceFile, task: EnhanceTask, stale: { id: string; day: DayKey | null;
  counts: RevisionCounts | null; at: string }): EnhanceFile {
  const { id, day, counts, at } = stale;
  const tasks = mapTasks(file, (each, state) => {
    if (each !== task || state.running !== id) return state;
    if (day === null) return { ...state, running: null };
    return { ...state, running: null, last: { day, at, status: 'failed', error: RUN_CLOSED, revision: id,
      tokens: 0, counts: lastCounts(counts) } };
  });
  return { ...file, tasks, notice: day === null ? file.notice : noticeAfter(file.notice, task, day, id, counts) };
}

/**
 * @brief 一条没收尾的 running 修订（上次的后台进程留下的，或这个进程里 endRun 没写成的）：定为 failed
 *        （memory.failStaleRun），再改 enhance.json。出错只记日志。
 */
async function closeStale(cwd: string, task: EnhanceTask, id: string): Promise<void> {
  const { revision } = await readRevision(cwd, 'project', id);
  const day = revision?.run?.day ?? null;
  const counts = await failStaleRun(cwd, id);
  if (day === null) console.error(`[kernel] the stale enhancement revision ${id} in ${cwd} can't be read`);
  const at = localIso(new Date(clock.now()));
  try {
    await mutate(cwd, (file) => staleClosed(file, task, { id, day, counts, at }), false);
  } catch (error) {
    console.error(`[kernel] closing the stale ${task} run in ${cwd} failed: ${errorText(error)}`);
  }
}

/** @brief 一个项目上次留下的运行（§9.10）：每个 running 不为 null 的任务收尾。 */
async function recoverStale(cwd: string): Promise<void> {
  const { file } = await loadFile(cwd);
  if (file === null) return;
  for (const task of ENHANCE_TASKS) {
    const id = file.tasks[task].running;
    if (id !== null) await closeStale(cwd, task, id);
  }
}

// ---- 定时器（§9.3） ----

/** @brief 有 project.json 的项目的工作目录；读不出来时记日志后为空。 */
async function projects(): Promise<string[]> {
  try {
    return (await listProjectDirs()).map((project) => project.cwd);
  } catch (error) {
    console.error(`[kernel] listing the memory projects failed: ${errorText(error)}`);
    return [];
  }
}

/**
 * @brief 重设唯一的定时器：所有开着的项目里上次排队之后最早的那个时刻（已经过了的立即到点）；没有开着的项目时不设。
 */
async function armNow(): Promise<void> {
  if (!watching) checkedAt = clock.now();
  let earliest: number | null = null;
  for (const cwd of await projects()) {
    const { file } = await loadFile(cwd);
    if (!file?.enabled) continue;
    const at = nextBoundary(checkedAt, file.time);
    if (earliest === null || at < earliest) earliest = at;
  }
  if (timer !== null) clock.clearTimeout(timer);
  timer = null;
  watching = earliest !== null && !stopping;
  if (earliest === null || stopping) return;
  timer = clock.setTimeout(() => {
    onTimer().catch((error: unknown) => {
      console.error(`[kernel] the enhancement timer failed: ${errorText(error)}`);
    });
  }, Math.max(0, earliest - clock.now()));
}

/** @brief 重设定时器（一个接一个，最后一次为准）；出错只记日志。 */
function armTimer(): Promise<void> {
  arming = arming.then(armNow).catch((error: unknown) => {
    console.error(`[kernel] setting the enhancement timer failed: ${errorText(error)}`);
  });
  return arming;
}

/**
 * @brief 到点（§9.3）：上次排队之后过了日界的每个开着的项目，把每个任务该跑的日子排进队列
 *        （通常只有刚结束的那一天；之前失败的、睡眠错过的一并排上），再设下一个。
 */
async function onTimer(): Promise<void> {
  const from = checkedAt;
  timer = null;
  const now = clock.now();
  checkedAt = now;
  const items: QueueItem[] = [];
  for (const cwd of await projects()) {
    const { file } = await loadFile(cwd);
    if (!file?.enabled || nextBoundary(from, file.time) > now) continue;
    items.push(...dueItems(cwd, file, dayOf(now, file.time)));
  }
  addItems(items);
  await armTimer();
}

// ---- 对外的操作 ----

/**
 * @brief 启动增强调度（§9.3）：后台进程收到 start、模型层启动之后调用一次。先收尾上次留下的运行（§9.10），
 *        再把每个开着的项目该跑的日子排进队列，然后设定时器。出错只记日志。
 * @param options userData、全局事件的发送、时钟
 */
export async function startEnhance(options: EnhanceOptions): Promise<void> {
  emitGlobal = options.emitGlobal;
  clock = options.clock ?? SYSTEM_CLOCK;
  // 启动时排进每个项目全部该跑的日子：这之前的日界都算排过，之后的由定时器排
  checkedAt = clock.now();
  watching = true;
  const all = await projects();
  for (const cwd of all) await recoverStale(cwd);
  // 收尾完才放行队列（§9.3：先处理上次留下的运行）：这之前排进来的项（现在运行）不跑，
  // 不然它的 processItem 与 recoverStale 会同时收尾同一条修订，或把刚记下的 running 当成上次留下的
  userDataDir = options.userData;
  const items: QueueItem[] = [];
  for (const cwd of all) items.push(...await dueOf(cwd));
  addItems(items);
  await armTimer();
}

/**
 * @brief 后台进程退出前（kernel/index.ts，shutdownSessions 之前）：不再排队，清掉定时器与队列；正在跑的那一次停止，
 *        算失败（Mori closed during the run），等它收尾。
 */
export async function stopEnhance(): Promise<void> {
  stopping = true;
  if (timer !== null) clock.clearTimeout(timer);
  timer = null;
  queue = [];
  const running = current;
  if (!running) return;
  running.controller.abort(RUN_CLOSED);
  await running.done;
}

/**
 * @brief enhance.get（§8）：设置、三个任务的 last、这个项目正在跑的与排着的项数、下次到点的时刻、待显示的提示、
 *        每个选择范围的第一个候选是否支持思考（effortPicks）、思考是否关不掉（noOffPicks，model-providers.md §7.7）、
 *        读设置的错误。文件不存在时是关着、没有运行过的样子。
 * @param cwd 项目的工作目录
 */
export async function enhanceInfo(cwd: string): Promise<EnhanceInfo> {
  const [{ file, error }, picks] = await Promise.all([loadFile(cwd), pickThinkingIn(cwd)]);
  const base = file ?? freshFile();
  const enabled = error === null && base.enabled;
  const running = current?.item.cwd === cwd ? { task: current.item.task, day: current.item.day } : null;
  return { cwd, enabled, pick: base.pick, thinking: base.thinking ?? UNSET_THINKING, team: base.team, time: base.time,
    since: base.since,
    last: { taste: base.tasks.taste.last, strategy: base.tasks.strategy.last, review: base.tasks.review.last },
    running, queued: queue.filter((item) => item.cwd === cwd).length,
    next: enabled ? nextBoundary(clock.now(), base.time) : null, notice: error === null ? base.notice : null,
    effortPicks: picks.effortPicks, noOffPicks: picks.noOffPicks, error };
}

/** @brief 改完 enhance.json 之后的调度（§9.1、§9.3、§9.4）：关掉时停下这个项目；开着时改了时刻重新排；开关或时刻变了重设定时器。 */
async function reschedule(cwd: string, previous: EnhanceFile, next: EnhanceFile): Promise<void> {
  if (previous.enabled && !next.enabled) dropProject(cwd, TURNED_OFF);
  if (next.enabled && previous.enabled && next.time !== previous.time) {
    removeQueued(cwd);
    addItems(await dueOf(cwd));
  }
  if (previous.enabled !== next.enabled || previous.time !== next.time) await armTimer();
}

/**
 * @brief enhance.set（§8、§9.1）：开关与设置写进 enhance.json；之后关掉的停下、改了时刻的重新排队、重设定时器。
 *        项目目录被占用、读不出来时返回原因，不读不写。
 * @param cwd 项目的工作目录
 * @param patch 要改的项
 */
export async function setEnhance(cwd: string, patch: EnhancePatch): Promise<{ error: string | null;
  info: EnhanceInfo }> {
  let result: { previous: EnhanceFile; next: EnhanceFile } | null;
  try {
    const defaults = await enableDefaults(cwd, patch);
    result = await mutate(cwd, (file) => patched(file, patch, defaults), true);
  } catch (error) {
    const message = errorText(error);
    console.error(`[kernel] enhance.set for ${cwd} failed: ${message}`);
    return { error: message, info: await enhanceInfo(cwd) };
  }
  if (result !== null) await reschedule(cwd, result.previous, result.next);
  return { error: null, info: await enhanceInfo(cwd) };
}

/** @brief enhance.run 被拒绝：记日志，返回原因。 */
function refused(cwd: string, error: string): { error: string } {
  console.error(`[kernel] enhance.run for ${cwd} refused: ${error}`);
  return { error };
}

/**
 * @brief enhance.run（§9.9 现在运行）：把这个项目该跑的日子与“今天到现在”的三个任务排进队列。
 *        关着、没有模型（§10.4 那一行的原因）、读不出设置时返回原因，不排。
 * @param cwd 项目的工作目录
 */
export async function runNow(cwd: string): Promise<{ error: string | null }> {
  const { file, error } = await loadFile(cwd);
  if (error !== null) return refused(cwd, error);
  if (!file?.enabled) return refused(cwd, TURNED_OFF_ALREADY);
  if (runSettings(file) === null) return refused(cwd, NO_MODEL);
  const today = dayOf(clock.now(), file.time);
  addItems([...dueItems(cwd, file, today), ...ENHANCE_TASKS.map((task) => ({ cwd, task, day: today }))]);
  return { error: null };
}

/**
 * @brief 新建会话时取走这个项目待显示的提示（§9.9）：返回并清空 notice。项目目录被占用、读不出来、没有提示时为 null
 *        （不带也不清空）。
 * @param cwd 新会话的工作目录
 */
export async function takeNotice(cwd: string): Promise<MemoryNotice | null> {
  try {
    const taken = await enqueue(async () => {
      const { file, error } = await loadFile(cwd);
      if (error !== null || file === null || file.notice === null) return null;
      await writeProjectJson(cwd, ENHANCE_FILE, { ...file, notice: null });
      return file.notice;
    });
    return taken;
  } catch (error) {
    console.error(`[kernel] taking the memory notice of ${cwd} failed: ${errorText(error)}`);
    return null;
  }
}
