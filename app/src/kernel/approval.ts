// 路径闸（docs/specs/file-system-permissions.md §6，后台进程第 3 件事“转达批准请求”）：inline extension mori-approval 的
// tool_call 处理器按 §6.1 的顺序判断每个调用，第一条有结果的就是结论：按职责给的工具放行 → 分类一次（pathGate.ts，
// 命令经 commandScan.ts）→ 收窄（limits.ts 的 checkLimits，§8）→ 写到工作路径外或受保护路径：按目录放行、没人能批时拒绝、
// 否则出卡 → 工作路径里：读取、只读命令（§7.7 末尾）与写 .work 的 edit、write 放行，再按权限模式（Ask each time / Full access）与
// “Allow for this session”的工具名 → 出卡挂起，等界面的答复。拒绝时返回 { block: true, reason }，pi 把 reason 原样作为
// 工具结果回给模型。处理器不抛错：分类出错记日志，按写到外面、看不出目标处理。
// 放行命令与写进 .work 的 edit、write 之前先建 .work（workspace.ts 的 ensureWork，§7.10），建不起来时拒绝这次调用。
// 每个挂起的请求绑定 ctx.signal：pi 不会替处理器取消等待，中止时不放手 session.abort() 会一直等着。
// 权限模式、“Allow for this session”的工具名与目录一个用户会话一份（ApprovalPolicy），对话会话与它的全部实例共用，
// 只在内存里；挂起的请求按 pi 会话各自记录（ApprovalGate）。实例的请求不在自己的信封上出卡，而是交给 Team
// （GateOutput.onRequest / onEnd），由它在用户会话的信封上发后台批准卡。收窄是每个 gate 自己的一层（GateOutput.narrowing，
// §8.5），共用的 ApprovalPolicy 不知道收窄：被收窄拒绝的调用从不挂起。
// 挂起的请求发出之后交给无人应答模块计时（away.ts，§9）：你不在、到时按拒绝结束；工厂另注册 agent_before_settle，
// 一次运行里有自动处理时补一次提醒（§9.8）。状态表见 docs/v1/screens/fs-permissions.md 与 fs-question.md。

import type {
  ExtensionContext, ExtensionFactory, ToolCallEvent, ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_APPROVAL, REJECTED_BY_STOP, REJECTED_REASON_PREFIX, REJECTED_TEXT,
  type ApprovalDecision, type ApprovalEndBy, type ApprovalMode, type ApprovalRequestInfo, type ApprovalState,
  type ApprovalTarget, type KernelEvent, type ToolGate,
} from '../shared/protocol';
import type { TeamApprovalEnd } from '../shared/team';
import { DENIED_BY_MORI_PREFIX, type AwayDecision, type AwayTimeout, type RequestKind } from '../shared/workspace';
import { awayArgs, awayDenialText, awayNow, awayReminder, registerAway, unregisterAway } from './away';
import { checkLimits, type Narrowing } from './limits';
import {
  allowDirsOf, approvalTargets, callKind, classifyCall, coveredByDirs, samePath, type CallKind, type ClassifiedCall,
} from './pathGate';
import { ensureWork, workDenialText } from './workspace';

/** 停止时等被拒绝的调用在 pi 里结束的上限：先让 pi 记下拒绝，再中止（否则 pi 只记"Operation aborted"） */
const STOP_SETTLE_MS = 2000;

/** 停止中仍照常判断的调用种类（§6.1）：按职责给的工具与读取 */
const STOP_KINDS: ReadonlySet<CallKind> = new Set<CallKind>(['duty', 'read']);

/** 对 scope 不是 inside 的请求答 allowSession 时命令失败的原文（§6.8） */
const SESSION_NOT_INSIDE =
  'Allow for this session doesn’t apply to writes outside the working directory or to protected paths.';
/** 对没有 allowDirs 的请求答 allowDir 时命令失败的原文（§6.9） */
const NO_FOLDER = 'This request can’t be allowed by folder.';

/** 没人能批时拒绝原文里每种理由的开头（§6.15），按这个顺序拼；只在增强会话里（没人能批），只给模型看，撇号照原样 */
const WHY_HEADS: Readonly<Record<ApprovalTarget['reason'], string>> = {
  outside: 'writes outside the working directory: ',
  protected: 'writes to a protected path: ',
  unresolved: "writes to a path Mori can't resolve: ",
  leaves: 'runs outside the working directory: ',
  unanalyzed: "can't be analyzed: ",
};
/** 没人能批时每种理由最多列几个（§17） */
const WHY_LIST_LIMIT = 5;

/** @brief 一个等你选择的请求。 */
interface Pending {
  /** 交给界面的载荷（含 scope、targets、allowDirs；界面重新加载后接上时再交给界面） */
  info: ApprovalRequestInfo;
  /** 判断时的分类（切到 Full access、按工具名或目录放行时据此挑出要放行的请求；经 effective 换过） */
  call: ClassifiedCall;
  /** 换之前的分类：Ask each time 下因为还写工作路径里而按第 4 步挂着的调用，切到 Full access 时据此按目录放行 */
  original: ClassifiedCall;
  /** 把答复交还给 pi */
  resolve: (result: ToolCallEventResult | undefined) => void;
  /** 解除对 ctx.signal 的监听 */
  release: () => void;
}

/** @brief 一个要挂起的请求的分类：call 经 ApprovalPolicy.effective 换过，original 是换之前的。 */
interface HeldCalls {
  call: ClassifiedCall;
  original: ClassifiedCall;
}

/** @brief 路径闸对一个调用的结论（§6.1）。 */
interface Verdict {
  /** 处理方式（mori.tool_gate） */
  gate: ToolGate;
  /** 分类结果（经 ApprovalPolicy.effective 换过）；按职责给的工具不分类，为 null */
  call: ClassifiedCall | null;
  /** 换之前的分类；按职责给的工具为 null */
  original: ClassifiedCall | null;
  /** gate 为 deny 时回给模型的原文；其余为 null */
  reason: string | null;
  /** 放行之前要先建 .work：命令，或写进 .work 的 edit、write（§7.10） */
  work: boolean;
}

/** @brief 你拒绝时回给模型的工具结果原文。 */
export function rejectionText(reason: string | undefined): string {
  const text = reason?.trim();
  return text ? `${REJECTED_REASON_PREFIX}${text}` : REJECTED_TEXT;
}

/** @brief 你按了停止时回给 pi 的结果。 */
function stopped(): ToolCallEventResult {
  return { block: true, reason: REJECTED_BY_STOP };
}

/** @brief edit、write 写进 .work（目标归类为 work，§6.4）：任何模式都不问。 */
function writesWork(call: ClassifiedCall): boolean {
  return call.kind === 'file' && call.targets.length > 0 && call.targets.every((target) => target.cls === 'work');
}

/** @brief 调用在工作路径里（含 .work）也有写入目标。 */
function writesInside(call: ClassifiedCall): boolean {
  return call.targets.some((target) => target.cls === 'inside' || target.cls === 'work');
}

/** @brief 一种理由的目标列表：最多 WHY_LIST_LIMIT 个，多的写 and <n> more。 */
function listText(items: readonly string[]): string {
  const shown = items.slice(0, WHY_LIST_LIMIT).join(', ');
  return items.length > WHY_LIST_LIMIT ? `${shown} and ${items.length - WHY_LIST_LIMIT} more` : shown;
}

/**
 * @brief 没人能批（§6.11）时回给模型的原文（§6.15、§14）：<why> 按目标的理由拼，几种之间用 ; 。只在看不见的增强会话里，
 *        只给模型看，撇号照原样。
 */
function nobodyText(call: ClassifiedCall): string {
  const targets = approvalTargets(call);
  const parts: string[] = [];
  for (const reason of Object.keys(WHY_HEADS) as ApprovalTarget['reason'][]) {
    const items = targets.filter((target) => target.reason === reason).map((target) => target.path ?? target.text);
    if (items.length > 0) parts.push(`${WHY_HEADS[reason]}${listText(items)}`);
  }
  const why = parts.length > 0 ? parts.join('; ') : "needs the user's approval";
  return `${DENIED_BY_MORI_PREFIX}nobody can approve tool calls in this run, and this call ${why}. Don't retry it.`;
}

/**
 * @brief 分类一次（§6.2–§6.4）。classifyCall 自己接住分类与 commandScan 的错误；它之外万一还抛错（例如工作路径本身
 *        解析不了），同样记日志，这个调用按 scope outside、一个理由 unresolved（text 为工具名）处理，不交给 pi
 *        （pi 会把处理器的异常变成 Extension failed, blocking execution）。
 * @param kind 已经算好的调用种类（出错时沿用）
 */
function classify(toolName: string, input: unknown, cwd: string, kind: CallKind): ClassifiedCall {
  try {
    return classifyCall(toolName, input, cwd);
  } catch (error) {
    console.error(`[kernel] path gate: ${error instanceof Error ? error.message : String(error)}`);
    const target = { cls: 'unresolved' as const, path: null, real: null, text: toolName, remove: false, into: false };
    return { kind, toolName, targets: [target], scope: 'outside', realCwd: cwd, readOnly: false };
  }
}

/** @brief 分析不了的命令记一行日志（§17，语料统计与排查用），不写命令原文。 */
function logUnanalyzed(call: ClassifiedCall): void {
  for (const target of call.targets) {
    if (target.cls === 'unanalyzed') console.log(`[kernel] command not analyzed (${call.toolName}): ${target.text}`);
  }
}

/** @brief 一个会话的批准扩展把事件交给谁、在哪个工作路径上判断。 */
export interface GateOutput {
  /** 请求 id 的前缀：对话会话为空串（approval-<n>，与 v0 相同），实例为 `<实例的 pi 会话 id>:`（平行 Agent 规格 §11.3） */
  prefix: string;
  /** @brief 发一个本会话的事件（mori.tool_gate；对话会话另有 mori.approval_request / mori.approval_end）。 */
  send(event: KernelEvent): void;
  /**
   * @brief 实例会话：挂起一个请求时调用，代替在自己的信封上发 mori.approval_request（Team 补上角色与 task，
   *        在用户会话的信封上发 mori.team_approval_request）；对话会话省略。
   */
  onRequest?(request: ApprovalRequestInfo): void;
  /** @brief 实例会话：请求结束时调用，代替 mori.approval_end；对话会话省略。 */
  onEnd?(end: TeamApprovalEnd): void;
  /** 工作路径（createEntry 的 args.cwd，与 ctx.cwd 是同一个值）：预告时没有 ctx，按它判断（§6.14） */
  cwd: string;
  /** 会话种类（setup.kind）：到时原文与提醒的最后一句按它选（§9.4、§9.8） */
  kind: RequestKind;
  /** 卡片所在的用户会话 id（用户会话为自己，实例为 spec.owner）：交给 away.ts 登记 */
  userSessionId: string;
  /** @brief 这个会话的收窄（§8.5）：路径闸第 2 步每次调用时取；省略或为 null 时不收窄。 */
  narrowing?(): Narrowing | null;
  /** @brief 只有实例有：这次运行已经成功交接（§9.8，已交接的 task 实例不补提醒）。 */
  handedOff?(): boolean;
}

/**
 * @brief 一个用户会话的批准状态（§6.7–§6.9）：权限模式、“Allow for this session”的工具名与目录，对话会话与它的全部实例
 *        共用；记下共用它的每个会话的 ApprovalGate，切到 Full access、按工具名或目录放行时一并处理它们挂起的请求。
 */
export class ApprovalPolicy {
  /** 权限模式 */
  private mode: ApprovalMode;
  /** 有人能批（§6.11）：为假时该出卡的调用直接拒绝 */
  private readonly askable: boolean;
  /** “Allow for this session”记下的工具名 */
  private readonly allowed = new Set<string>(DEFAULT_APPROVAL.allowed);
  /** “Allow writes to <目录> for this session”记下的目录（真实路径），按记下的顺序，不分大小写去重 */
  private readonly dirs: string[] = [...DEFAULT_APPROVAL.allowedDirs];
  /** 共用这份状态的会话的批准扩展，按建立的顺序（对话会话在前） */
  private readonly gates = new Set<ApprovalGate>();

  /**
   * @param options mode：开始时的模式（默认 Ask each time）；canAsk：有人能批（默认真；增强会话为假）
   */
  constructor(options: { mode?: ApprovalMode; canAsk?: boolean } = {}) {
    this.mode = options.mode ?? DEFAULT_APPROVAL.mode;
    this.askable = options.canAsk ?? true;
  }

  /**
   * @brief 为一个会话建立批准扩展并登记。
   * @param output 事件的去处、请求 id 的前缀、工作路径、会话种类与收窄
   */
  gate(output: GateOutput): ApprovalGate {
    const gate = new ApprovalGate(this, output);
    this.gates.add(gate);
    return gate;
  }

  /** @brief 会话释放时注销它的批准扩展（ApprovalGate.close 调用）。 */
  remove(gate: ApprovalGate): void {
    this.gates.delete(gate);
  }

  /** @brief 当前的批准设置。 */
  state(): ApprovalState {
    return { mode: this.mode, allowed: [...this.allowed], allowedDirs: [...this.dirs] };
  }

  /** @brief 有人能批（§6.11）。 */
  canAsk(): boolean {
    return this.askable;
  }

  /** @brief 身份段的权限句按哪一种写（§6.16）：没人能批时 none，否则为当前模式。 */
  promptMode(): 'ask' | 'full' | 'none' {
    return this.askable ? this.mode : 'none';
  }

  /**
   * @brief 按目录放行覆盖了外面的目标、在 Ask each time 下却还写工作路径里（含 .work）的调用，继续到第 4 步按模式判断
   *        （§6.1 第 3 步、§6.9，2026-10-27 负责人定）：把它当作 scope inside 的调用（卡上没有原因行与按目录放行，
   *        可按工具名放行）；其余调用原样返回。
   */
  effective(call: ClassifiedCall): ClassifiedCall {
    return this.dirsRelease(call) || !coveredByDirs(call, this.dirs) ? call : { ...call, scope: 'inside' };
  }

  /** @brief 按目录放行能不能放行这个调用：全部要问的目标被覆盖，并且不是 Ask each time 下还写工作路径里的调用。 */
  private dirsRelease(call: ClassifiedCall): boolean {
    return coveredByDirs(call, this.dirs) && !(this.mode === 'ask' && writesInside(call));
  }

  /**
   * @brief 路径闸第 3、4 步（§6.1；收窄在第 2 步，由 ApprovalGate 先判断）：这个调用在当前设置下怎样处理。
   *        call 先经 effective 换过（Ask each time 下被目录覆盖、还写里面的调用按第 4 步判断）。
   *        读取与只读命令（§7.7 末尾，照 Claude Code 在每种模式下都不问只读命令）在第 4 步放行，不论会话与模式。
   * @return dir / ask / deny（第 3 步）；free / full / session / ask / deny（第 4 步）
   */
  gateOf(call: ClassifiedCall): ToolGate {
    if (call.scope !== 'inside') {
      if (this.dirsRelease(call)) return 'dir';
      return this.askable ? 'ask' : 'deny';
    }
    if (call.kind === 'read' || call.readOnly || writesWork(call)) return 'free';
    if (this.mode === 'full') return 'full';
    if (this.allowed.has(call.toolName)) return 'session';
    return this.askable ? 'ask' : 'deny';
  }

  /**
   * @brief 切换权限模式（§6.7）：切到 Full access 时这个用户会话里全部 Agent 挂起的请求中 scope 为 inside 的按允许结束
   *        （by: 'full'），outside、protected 的继续挂着；切回 Ask each time 时挂着的请求不变。
   */
  setMode(mode: ApprovalMode): ApprovalState {
    this.mode = mode;
    if (mode !== 'full') return this.state();
    for (const gate of [...this.gates]) {
      // 先按目录放行：Ask each time 下因为还写工作路径里而按第 4 步挂着、外面已被目录覆盖的调用（§6.9，by: 'dir'）
      gate.allowPending((_call, original) => original.scope !== 'inside' && this.dirsRelease(original), 'dir');
      gate.allowPending((call) => call.scope === 'inside', 'full');
    }
    return this.state();
  }

  /**
   * @brief “Allow for this session”（§6.8，ApprovalGate.answer 调用）：记下工具名，全部 Agent 挂起的同名、
   *        scope 为 inside 的请求按允许结束（by: 'session'）。
   */
  allowSession(toolName: string): void {
    this.allowed.add(toolName);
    for (const gate of [...this.gates]) {
      gate.allowPending((call) => call.scope === 'inside' && call.toolName === toolName, 'session');
    }
  }

  /**
   * @brief “Allow writes to <目录> for this session”（§6.9，ApprovalGate.answer 调用）：记下这些目录（不分大小写去重），
   *        全部 Agent 挂起的请求中现在全部被覆盖的按允许结束（by: 'dir'）。
   */
  allowDirs(dirs: readonly string[]): void {
    for (const dir of dirs) if (!this.dirs.some((known) => samePath(known, dir))) this.dirs.push(dir);
    for (const gate of [...this.gates]) gate.allowPending((_call, original) => this.dirsRelease(original), 'dir');
  }

  /** @brief 从“Allowed for this session”里清除一个工具名；挂起的请求不变。 */
  forget(toolName: string): ApprovalState {
    this.allowed.delete(toolName);
    return this.state();
  }

  /** @brief 从“Allowed for this session”里清除一个目录（不分大小写比；不在列表里时什么都不做）；挂起的请求不变。 */
  forgetDir(dir: string): ApprovalState {
    const index = this.dirs.findIndex((known) => samePath(known, dir));
    if (index >= 0) this.dirs.splice(index, 1);
    return this.state();
  }
}

/** @brief 一个会话的批准扩展：路径闸、挂起的请求；权限与“Allow for this session”在共用的 ApprovalPolicy 里。 */
export class ApprovalGate {
  /** 等你选择的请求，按请求 id */
  private readonly pending = new Map<string, Pending>();
  /** rejectForStop 在等它们在 pi 里结束的调用：toolCallId → 通知 */
  private readonly endWaiters = new Map<string, () => void>();
  /** 已预告给界面、处理器还没判断的调用：toolCallId → 预告的处理方式 */
  private readonly announced = new Map<string, ToolGate>();
  /** 正在停止（rejectForStop 开始到 session.abort() 结束）：除按职责给的工具与读取外的调用一律按拒绝处理 */
  private stopping = false;
  /** 下一个请求 id 的序号 */
  private nextId = 1;

  /**
   * @param policy 共用的批准状态
   * @param output 事件的去处、请求 id 的前缀、工作路径、会话种类与收窄
   */
  constructor(private readonly policy: ApprovalPolicy, private readonly output: GateOutput) {}

  /** @brief 当前的批准设置（共用的那一份）。 */
  state(): ApprovalState {
    return this.policy.state();
  }

  /** @brief 这个请求是否还挂在这个会话上。 */
  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * @brief 路径闸的判断（§6.1）：按职责给的工具放行（不分类）；其余分类一次，第 2–4 步共用；不挂起、不改状态。
   * @param input 调用参数（处理器为 pi 校验之后的 event.input，预告为 tool_execution_start 的 args）
   * @param cwd 工作路径（处理器为 ctx.cwd，预告为 GateOutput.cwd）
   * @param log 记“命令分析不了”的日志（只在处理器里记，预告不记，免得一个调用记两次）
   */
  private decide(toolName: string, input: unknown, cwd: string, log: boolean): Verdict {
    const kind = callKind(toolName, input);
    if (kind === 'duty') return { gate: 'free', call: null, original: null, reason: null, work: false };
    const call = classify(toolName, input, cwd, kind);
    if (log) logUnanalyzed(call);
    const work = call.kind === 'command' || writesWork(call);
    const narrowing = this.output.narrowing?.() ?? null;
    const narrowed = narrowing ? checkLimits(narrowing, call, call.realCwd) : null;
    if (narrowed !== null) return { gate: 'deny', call, original: call, reason: narrowed, work };
    const effective = this.policy.effective(call);
    const gate = this.policy.gateOf(effective);
    return { gate, call: effective, original: call, reason: gate === 'deny' ? nobodyText(effective) : null, work };
  }

  /**
   * @brief pi 的 tool_execution_start 转发给界面之前调用：用与处理器相同的判断（§6.1）算出处理方式，发出 mori.tool_gate，
   *        并记下预告，处理器后来判断不同时据此发更正（§6.14）。预告时没有 ctx，按 GateOutput.cwd 判断。
   * @param args tool_execution_start 的 args（pi 准备参数之前的原样）
   */
  announce(toolCallId: string, toolName: string, args: unknown): void {
    const { gate } = this.decide(toolName, args, this.output.cwd, false);
    this.announced.set(toolCallId, gate);
    this.send({ type: 'mori.tool_gate', toolCallId, toolName, gate });
  }

  /** @brief 交给 DefaultResourceLoader 的 inline extension；每个会话一个：路径闸与你不在时的提醒（§9.8）。 */
  extension(): ExtensionFactory {
    return (pi) => {
      pi.on('tool_call', (event, ctx) => this.onToolCall(event, ctx));
      pi.on('agent_before_settle', (event, ctx) =>
        awayReminder(ctx.sessionManager.getSessionId(), event, this.output.handedOff?.() ?? false));
    };
  }

  /**
   * @brief pi 在执行工具前调用：按 §6.1 判断；要批准时挂起，等你在界面上选择；停止中只放过按职责给的工具与读取。
   *        判断与预告不同时再发一次 mori.tool_gate 更正（实际是 ask 时界面靠随后的批准请求进入等批准）。
   */
  private async onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
    const { toolCallId, toolName } = event;
    const announced = this.announced.get(toolCallId);
    this.announced.delete(toolCallId);
    // 停止中：pi 拿到前一个调用的拒绝后会立刻放行排在后面的嵌套调用，它们不再出卡，也不执行（写 .work 的也一样）。
    if (this.stopping && !STOP_KINDS.has(callKind(toolName, event.input))) return stopped();
    const verdict = this.decide(toolName, event.input, ctx.cwd, true);
    if (this.stopping && verdict.gate !== 'free') return stopped();
    if (announced !== undefined && announced !== verdict.gate) {
      this.send({ type: 'mori.tool_gate', toolCallId, toolName, gate: verdict.gate });
    }
    if (verdict.reason !== null) return { block: true, reason: verdict.reason };
    if (verdict.gate === 'ask' && verdict.call && verdict.original) {
      return this.request(event, ctx, { call: verdict.call, original: verdict.original }, verdict.work);
    }
    return this.release(verdict.work, ctx.cwd);
  }

  /**
   * @brief 放行一个调用、交还 pi 之前：命令与写进 .work 的 edit、write 先建 .work（§7.10）；建不起来时拒绝这次调用。
   *        建 .work 的这段时间里你按了停止时按停止拒绝：停止之后不再执行任何写入。错误日志由 ensureWork 记。
   * @param work 要先建 .work
   * @param cwd 工作路径（ctx.cwd）
   */
  private async release(work: boolean, cwd: string): Promise<ToolCallEventResult | undefined> {
    if (!work) return undefined;
    const prepared = await ensureWork(cwd);
    if (!prepared.ok) return { block: true, reason: workDenialText(prepared.reason) };
    return this.stopping ? stopped() : undefined;
  }

  /**
   * @brief 发出批准请求（§6.13 的载荷）并挂起，直到你选择、切换权限、按工具名或目录放行、停止或你不在到时；
   *        signal 中止时按拒绝处理。请求事件发出之后交给 away.ts 登记（§9.2）。允许之后照 release 建 .work。
   * @param calls 这次判断的分类（call 经 effective 换过，original 是换之前的）
   * @param work 放行之前要先建 .work
   */
  private request(event: ToolCallEvent, ctx: ExtensionContext, calls: HeldCalls,
    work: boolean): Promise<ToolCallEventResult | undefined> {
    const { call, original } = calls;
    // 在处理器开始时读取：之后的重试或续跑会换成新的 signal。
    const signal = ctx.signal;
    if (signal?.aborted) return Promise.resolve(stopped());
    const requestId = `${this.output.prefix}approval-${this.nextId++}`;
    const answered = new Promise<ToolCallEventResult | undefined>((resolve) => {
      const onAbort = () => this.finish(requestId, 'reject', 'closed', REJECTED_BY_STOP);
      signal?.addEventListener('abort', onAbort, { once: true });
      const release = () => signal?.removeEventListener('abort', onAbort);
      // 参数取 event.input：先加载的扩展可能改过它，执行的是改过之后的参数。
      const args = { ...(event.input as Record<string, unknown>) };
      const info: ApprovalRequestInfo = { requestId, toolCallId: event.toolCallId, toolName: event.toolName, args,
        scope: call.scope, targets: approvalTargets(call), allowDirs: allowDirsOf(call) };
      this.pending.set(requestId, { info, call, original, resolve, release });
      if (this.output.onRequest) this.output.onRequest(info);
      else this.send({ type: 'mori.approval_request', ...info });
      if (this.pending.has(requestId)) this.register(requestId, ctx.sessionManager.getSessionId());
    });
    return answered.then((result) => (result === undefined ? this.release(work, ctx.cwd) : result));
  }

  /**
   * @brief 交给无人应答模块计时（§9.2）：卡片在 GateOutput.userSessionId 的信封上，提醒清单记在发起请求的 pi 会话上。
   * @param sessionId 这个 pi 会话的 id
   */
  private register(requestId: string, sessionId: string): void {
    registerAway({ userSessionId: this.output.userSessionId, sessionId, requestId, kind: this.output.kind,
      expire: (timeout) => this.expire(requestId, timeout) });
  }

  /**
   * @brief 你不在、到时（away.ts 调用，§9.4）：按拒绝结束（by: 'away'），原文按当时的时长与会话种类写。
   * @return 这次自动处理的记录（agent 为 null；实例的记录由 Team 写，这条只进提醒清单）；请求已经结束时为 null
   */
  private expire(requestId: string, timeout: Exclude<AwayTimeout, 'never'>): AwayDecision | null {
    const item = this.pending.get(requestId);
    if (!item) return null;
    const { toolCallId, toolName, args } = item.info;
    this.finish(requestId, 'reject', 'away', awayDenialText(timeout, this.output.kind));
    return { requestId, kind: 'approval', at: awayNow(), timeout, agent: null, toolCallId, toolName,
      args: awayArgs(args), title: null, answers: null, result: 'denied' };
  }

  /**
   * @brief 结束一个请求：注销计时，把结果交还给 pi，并告诉界面（实例会话告诉 Team）。
   * @param reason 拒绝时回给模型的原文；允许时忽略
   * @return 请求还挂着并已结束时为真
   */
  private finish(requestId: string, decision: 'allow' | 'reject', by: ApprovalEndBy, reason: string | null): boolean {
    const item = this.pending.get(requestId);
    if (!item) return false;
    this.pending.delete(requestId);
    item.release();
    unregisterAway(this.output.userSessionId, requestId);
    const text = decision === 'reject' ? (reason ?? REJECTED_TEXT) : null;
    item.resolve(text === null ? undefined : { block: true, reason: text });
    const { toolCallId } = item.info;
    if (this.output.onEnd) this.output.onEnd({ requestId, decision, by, reason: text });
    else this.send({ type: 'mori.approval_end', requestId, toolCallId, decision, by, reason: text });
    return true;
  }

  /**
   * @brief 你在批准卡上的选择（§6.8、§6.9）。请求已经结束（例如你刚按了停止）时报错，界面那张卡已经收到结束事件；
   *        allowSession 只用于 scope inside、allowDir 只用于有 allowDirs 的请求，否则报错、卡不变。
   */
  answer(requestId: string, decision: ApprovalDecision, reason?: string): ApprovalState {
    const item = this.pending.get(requestId);
    if (!item) throw new Error(`Approval request ${requestId} is no longer pending`);
    if (decision === 'reject') {
      this.finish(requestId, 'reject', 'user', rejectionText(reason));
      return this.state();
    }
    if (decision === 'allowSession' && item.info.scope !== 'inside') throw new Error(SESSION_NOT_INSIDE);
    if (decision === 'allowDir' && item.info.allowDirs.length === 0) throw new Error(NO_FOLDER);
    this.finish(requestId, 'allow', 'user', null);
    // 这个用户会话里全部 Agent 挂起的同名（scope inside）或现在被目录覆盖的请求一并允许，之后也不再询问。
    if (decision === 'allowSession') this.policy.allowSession(item.info.toolName);
    if (decision === 'allowDir') this.policy.allowDirs(item.info.allowDirs);
    return this.state();
  }

  /** @brief 切换权限（共用的那一份，ApprovalPolicy.setMode）。 */
  setMode(mode: ApprovalMode): ApprovalState {
    return this.policy.setMode(mode);
  }

  /** @brief 从“Allowed for this session”里清除一个工具名或一个目录（共用的那一份）。 */
  forget(target: { toolName: string } | { dir: string }): ApprovalState {
    return 'dir' in target ? this.policy.forgetDir(target.dir) : this.policy.forget(target.toolName);
  }

  /**
   * @brief 按允许结束挂起的请求（ApprovalPolicy 调用）。
   * @param match 要结束的请求（按判断时的分类挑：call 经 effective 换过，original 是换之前的）
   * @param by 由“Allow for this session”、按目录放行或切到 Full access 结束
   */
  allowPending(match: (call: ClassifiedCall, original: ClassifiedCall) => boolean,
    by: 'session' | 'dir' | 'full'): void {
    for (const [id, item] of [...this.pending]) if (match(item.call, item.original)) this.finish(id, 'allow', by, null);
  }

  /**
   * @brief 停止前：进入停止状态，挂起的请求按拒绝处理，并等这些调用在 pi 里结束（最多 STOP_SETTLE_MS）。
   *        pi 在处理器返回后先看 signal：先中止的话，它只记下"Operation aborted"，拒绝的原文就丢了。
   *        停止状态由 endStop 在 session.abort() 结束后解除。
   */
  async rejectForStop(): Promise<void> {
    // 先进入停止状态再交还拒绝：等待的这段时间里，排在后面的调用到了处理器也不会出卡或执行。
    this.stopping = true;
    const ids = [...this.pending.entries()].map(([id, item]) => ({ id, toolCallId: item.info.toolCallId }));
    if (ids.length === 0) return;
    const ended = ids.map(({ toolCallId }) => new Promise<void>((done) => this.endWaiters.set(toolCallId, done)));
    for (const { id } of ids) this.finish(id, 'reject', 'stop', REJECTED_BY_STOP);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((done) => { timer = setTimeout(done, STOP_SETTLE_MS); });
    await Promise.race([Promise.all(ended), timeout]);
    clearTimeout(timer);
    for (const { toolCallId } of ids) this.endWaiters.delete(toolCallId);
  }

  /** @brief session.abort() 结束后调用：解除停止状态，之后的调用照常判断。 */
  endStop(): void {
    this.stopping = false;
  }

  /** @brief pi 的 tool_execution_end 经过时调用：rejectForStop 可能在等它；这次调用的预告不再需要。 */
  noteToolEnd(toolCallId: string): void {
    this.announced.delete(toolCallId);
    this.endWaiters.get(toolCallId)?.();
  }

  /** @brief 挂起的批准请求，按提出的顺序（LiveSnapshot.approvals：界面重新加载后接上会话时用）。 */
  requests(): ApprovalRequestInfo[] {
    return [...this.pending.values()].map((item) => ({ ...item.info }));
  }

  /** @brief 会话释放前：挂起的请求按拒绝处理，pi 不会卡在等待上；之后不再共用批准状态。 */
  close(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, 'reject', 'closed', REJECTED_BY_STOP);
    this.policy.remove(this);
  }

  /** @brief 发一个本会话的事件。 */
  private send(event: KernelEvent): void {
    this.output.send(event);
  }
}
