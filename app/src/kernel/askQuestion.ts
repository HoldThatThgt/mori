// 提问工具 ask_user_question（docs/specs/file-system-permissions.md §10，file-system.md §12、§14）：inline extension
// mori-question，只加进用户会话（不是增强任务的看不见的会话），注册即启用。格式照 Claude 的 AskUserQuestion：1–4 个问题、
// 每个 2–4 个选项、multiSelect，卡上总有 Other；Mori 加必填的 recommended。执行时先校验（不合格整次调用报错、不出卡，
// 第二行 Correct form，同 TaskBoard 工具的 errorText），再挂起一个提问 ask-<n>：发 mori.question_request，交给 away.ts 计时
// （§9.2），直到你提交、拒绝回答、你不在到时、你按了停止或会话关闭；结束时发 mori.question_end，工具结果按结束方式写（§14）。
// 拒绝回答与停止、关闭的结果是 isError（界面重新打开时只对错误结果认拒绝）；提交与按推荐项不是。
// 挂起的提问只在这里的内存里，每个用户会话一个；后台进程重启后作废（§10.6）。

import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { KernelEvent } from '../shared/protocol';
import {
  ASK_DECLINED_TEXT, ASK_STOPPED_TEXT, ASK_TOOL, AWAY_DURATION_TEXT, REJECTED_AWAY_PREFIX,
  type AskAnswer, type AskEndBy, type AskQuestion, type AskRequest, type AwayDecision, type AwayTimeout,
} from '../shared/workspace';
import { awayNow, registerAway, unregisterAway } from './away';
import type { JsonSchema } from './handoffForm';

/** @brief 提问扩展的名字；pi 用 `<inline:名字>` 标出它的加载错误，工具页按它把来源写成 Mori（§10.1）。 */
export const QUESTION_EXTENSION = 'mori-question';
export const QUESTION_EXTENSION_PATH = `<inline:${QUESTION_EXTENSION}>`;

/** 数量与文字长度（§10.2；长度是临时默认值，file-system.md §17） */
const LIMITS = Object.freeze({
  questionsMin: 1, questionsMax: 4, optionsMin: 2, optionsMax: 4,
  question: 500, header: 12, label: 60, description: 300, other: 2000,
});

/**
 * 工具给模型的说明（§14）：Customize › Tools 展开一行时显示全文，所以撇号用 ’（docs/v0/ui-strings.md；
 * docs/v1/walkthrough-1026-checks.md 的 U60）
 */
const ASK_DESCRIPTION = 'Ask the user 1-4 questions, each with 2-4 options, and wait for the answers. Use it when you '
  + 'need the user’s decision or preference to go on: a choice between approaches, a missing requirement, or which of '
  + 'several things they meant. Don’t use it for what you can find out yourself, or to ask permission to run a tool. '
  + 'The user can always type their own answer instead of picking an option, so don’t add an "Other" option. Set '
  + 'recommended to the label of the option you would pick; if the user is away and doesn’t answer in time, Mori uses '
  + 'it and tells you.';

/** 参数的说明（§14，原文） */
const PARAM_TEXT = Object.freeze({
  questions: 'The questions, 1-4, shown together on one card in this order.',
  question: 'The full question, ending with a question mark.',
  header: 'A short tag for the question, at most 12 characters, e.g. Database.',
  options: '2-4 options.',
  label: 'What the user picks, in a few words.',
  description: 'What this option means, or what happens if the user picks it.',
  multiSelect: 'true if the user may pick more than one option.',
  recommended: 'The label of the option you recommend; it must be one of the labels.',
});

/** 校验错误的第二行（§14，原文） */
const CORRECT_FORM = 'Correct form: ask_user_question {"questions":[{"question":"Which database should I use?",'
  + '"header":"Database","options":[{"label":"PostgreSQL","description":"Server database"},'
  + '{"label":"SQLite","description":"Single file"}],"multiSelect":false,"recommended":"PostgreSQL"}]}';

/** question.answer 的答复对不上问题时命令失败的原文（§10.5） */
const ANSWERS_MISMATCH = 'Answers don’t match the questions.';

/** 结果是 isError 的结束方式：拒绝回答、停止、关闭（§10.3） */
const ERROR_ENDS: ReadonlySet<AskEndBy> = new Set<AskEndBy>(['declined', 'stop', 'closed']);

/** @brief 这个用户会话的提问把事件交给谁（会话表建立时给出）。 */
export interface AskSetup {
  /** 这个用户会话的 id（away.ts 登记的 userSessionId 与 sessionId 都是它） */
  sessionId: string;
  /** @brief 在这个会话的信封上发事件（mori.question_request、mori.question_end）。 */
  send(event: KernelEvent): void;
  /**
   * @brief 提问以 user / away 结束、有答案时调用（Team 按 §10.7 决定要不要转给立项）；没有 Team 时省略。
   * @param questions 这次提问的问题（校验、归一之后）
   * @param answers 每个问题的答案，按问题的顺序
   */
  onAnswered?(questions: AskQuestion[], answers: AskAnswer[]): void;
}

/** @brief question.answer 里一个问题的答复（界面给的，还没核对）。 */
export interface GivenAnswer {
  /** 选中的 label */
  selected: string[];
  /** Other 里填的文字；没选 Other 为 null */
  other: string | null;
}

/** @brief ask_user_question 工具结果的 details（§10.3）：界面从会话文件读出已答的内容。 */
export interface AskDetails {
  /** 每个问题的答案；拒绝回答、停止、关闭时为 null */
  answers: AskAnswer[] | null;
  /** 怎样结束 */
  by: AskEndBy;
}

/** @brief 工具的参数（已经 pi 按 schema 校验：数量与必填）。 */
interface AskParams {
  /** 模型给的问题（数量与必填已由 pi 校验，其余在执行时查） */
  questions: AskQuestion[];
}

/** @brief 一个提问怎样结束：方式、答案（只有 user、away 有）、工具结果原文。 */
interface Ending {
  /** 结束方式 */
  by: AskEndBy;
  /** 每个问题的答案，按问题的顺序；只有 user、away 有，其余为 null */
  answers: AskAnswer[] | null;
  /** 交给模型的工具结果原文（§14） */
  text: string;
}

/** @brief pi 的工具结果。 */
type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;

/** @brief 一个挂起的提问。 */
interface Pending {
  /** mori.question_request 的载荷（界面重新载入后接上时再交给界面） */
  request: AskRequest;
  /** 把工具结果交还给 pi */
  resolve: (result: ToolResult) => void;
  /** 解除对 signal 的监听 */
  release: () => void;
}

// ---- schema（§10.2） ----

/** @brief 带说明的字符串属性。 */
function text(description: string): JsonSchema {
  return { type: 'string', description };
}

/** @brief 工具的参数 schema：数量与必填由 pi 在执行前校验，其余在执行时查（§10.2 的表）。 */
function askSchema(): JsonSchema {
  const option = { type: 'object', properties: { label: text(PARAM_TEXT.label),
    description: text(PARAM_TEXT.description) }, required: ['label', 'description'] };
  const question = { type: 'object', properties: {
    question: text(PARAM_TEXT.question),
    header: { ...text(PARAM_TEXT.header), maxLength: LIMITS.header },
    options: { type: 'array', items: option, minItems: LIMITS.optionsMin, maxItems: LIMITS.optionsMax,
      description: PARAM_TEXT.options },
    multiSelect: { type: 'boolean', description: PARAM_TEXT.multiSelect },
    recommended: text(PARAM_TEXT.recommended),
  }, required: ['question', 'header', 'options', 'multiSelect', 'recommended'] };
  return { type: 'object', properties: {
    questions: { type: 'array', items: question, minItems: LIMITS.questionsMin, maxItems: LIMITS.questionsMax,
      description: PARAM_TEXT.questions },
  }, required: ['questions'] };
}

// ---- 执行时的校验（§10.2、§14） ----

/** @brief 字符数（按码点，同 JSON Schema 的 maxLength）。 */
function chars(value: string): number {
  return [...value].length;
}

/** @brief 长度在 [min, max] 之内。 */
function within(value: string, min: number, max: number): boolean {
  const length = chars(value);
  return length >= min && length <= max;
}

/**
 * @brief 一个问题的校验（§10.2）：question 1–500、header 1–12、label 1–60、description ≤ 300（question、header、label
 *        按去掉首尾空白后的写法）；label 不等于 Other、同一问题里互不相同（都不分大小写）；recommended 去掉首尾空白后
 *        等于某个 label。
 * @param question 模型给的问题
 * @param n 问题的序号（从 1 起）
 * @return 第一处错误的原文；合格时为 null
 */
function questionError(question: AskQuestion, n: number): string | null {
  const at = `Question ${n}: `;
  if (!within(question.question.trim(), 1, LIMITS.question)) return `${at}question must be 1-500 characters.`;
  if (!within(question.header.trim(), 1, LIMITS.header)) return `${at}header must be 1-12 characters.`;
  for (const option of question.options) {
    if (!within(option.label.trim(), 1, LIMITS.label)) return `${at}option label must be 1-60 characters.`;
    if (chars(option.description) > LIMITS.description) {
      return `${at}option description must be at most 300 characters.`;
    }
  }
  const labels = question.options.map((option) => option.label.trim());
  const keys = labels.map((label) => label.toLowerCase());
  if (keys.includes('other')) {
    return `${at}don’t add an "Other" option; the user can always type their own answer.`;
  }
  if (new Set(keys).size !== keys.length) return `${at}option labels must be different.`;
  if (!labels.includes(question.recommended.trim())) {
    return `${at}recommended "${question.recommended}" is not one of its option labels: ${labels.join(', ')}.`;
  }
  return null;
}

/** @brief 合格的问题归一：question、header、label 去掉首尾空白，recommended 换成它对上的那个 label。 */
function normalizeQuestion(question: AskQuestion): AskQuestion {
  const options = question.options.map((option) => ({ label: option.label.trim(), description: option.description }));
  return { question: question.question.trim(), header: question.header.trim(), options,
    multiSelect: question.multiSelect, recommended: question.recommended.trim() };
}

/**
 * @brief 执行时的校验（§10.2）：先逐个问题查，再查各问题的 question 去掉首尾空白后互不相同。
 * @param questions 模型给的问题（数量与必填已由 pi 校验）
 * @return 归一后的问题；不合格时为第一处错误的原文（工具结果的第一行）
 */
export function checkQuestions(questions: readonly AskQuestion[]): { questions: AskQuestion[] } | { error: string } {
  for (const [index, question] of questions.entries()) {
    const error = questionError(question, index + 1);
    if (error) return { error };
  }
  const texts = questions.map((question) => question.question.trim());
  if (new Set(texts).size !== texts.length) return { error: 'Each question must be different.' };
  return { questions: questions.map(normalizeQuestion) };
}

// ---- 答复（§10.5） ----

/**
 * @brief 核对一个问题的答复：selected 都是这个问题的 label、不重复；other 去掉首尾空白后 1–2000 字符；
 *        单选时 selected 与 other 合起来恰好一个，多选时至少一个。
 * @return 这个问题的答案（selected 按选项的顺序，other 去掉首尾空白）；不合格时为 null
 */
function answerOf(question: AskQuestion, given: GivenAnswer): AskAnswer | null {
  const labels = question.options.map((option) => option.label);
  if (given.selected.some((label) => !labels.includes(label))) return null;
  if (new Set(given.selected).size !== given.selected.length) return null;
  const other = given.other === null ? null : given.other.trim();
  if (other !== null && !within(other, 1, LIMITS.other)) return null;
  const count = given.selected.length + (other === null ? 0 : 1);
  if (question.multiSelect ? count < 1 : count !== 1) return null;
  const selected = labels.filter((label) => given.selected.includes(label));
  return { question: question.question, header: question.header, selected, other, auto: false };
}

/**
 * @brief 核对 question.answer 的答复（§10.5）：项数等于问题数，每项按 answerOf 核对。
 * @param questions 这次提问的问题
 * @param given 界面给的答复，按问题的顺序
 * @return 每个问题的答案；不合格时为 null
 */
export function checkAnswers(questions: readonly AskQuestion[], given: readonly GivenAnswer[]): AskAnswer[] | null {
  if (given.length !== questions.length) return null;
  const answers: AskAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = answerOf(question, given[index]);
    if (!answer) return null;
    answers.push(answer);
  }
  return answers;
}

/** @brief 你不在时的答案（§9.4、§10.5）：每个问题只用 recommended，多选也只用这一个。 */
function recommendedAnswers(questions: readonly AskQuestion[]): AskAnswer[] {
  return questions.map((question) => ({ question: question.question, header: question.header,
    selected: [question.recommended], other: null, auto: true }));
}

/** @brief `"<问题>"="<答案>"`，用 `, ` 连接；一个问题的答案是 selected 用 `, ` 连接，other 接在最后（§10.5）。 */
function pairsText(answers: readonly AskAnswer[]): string {
  return answers.map((answer) => {
    const parts = answer.other === null ? answer.selected : [...answer.selected, answer.other];
    return `"${answer.question}"="${parts.join(', ')}"`;
  }).join(', ');
}

/** @brief 你提交时的工具结果（§14）。 */
export function answeredText(answers: readonly AskAnswer[]): string {
  return `User has answered your questions: ${pairsText(answers)}. `
    + 'You can now continue with the user’s answers in mind.';
}

/** @brief 提问卡到时的工具结果（§14）：时长写当时的设置。 */
export function awayAnswerText(answers: readonly AskAnswer[], timeout: Exclude<AwayTimeout, 'never'>): string {
  return `${REJECTED_AWAY_PREFIX}${AWAY_DURATION_TEXT[timeout]}, so your recommended options were used: `
    + `${pairsText(answers)}. Continue with them, and mention this in your final summary.`;
}

/** @brief 结束时的工具结果：details 为 { answers, by }，拒绝回答、停止、关闭为 isError（§10.3）。 */
function endResult(ending: Ending): ToolResult {
  const details: AskDetails = { answers: ending.answers, by: ending.by };
  const result: ToolResult = { content: [{ type: 'text', text: ending.text }], details };
  if (ERROR_ENDS.has(ending.by)) result.isError = true;
  return result;
}

/** @brief 校验不过的工具结果：第一行原因，第二行 Correct form，isError（§10.3 第 1 步）。 */
function invalidResult(reason: string): ToolResult {
  return { content: [{ type: 'text', text: `${reason}\n${CORRECT_FORM}` }], details: undefined, isError: true };
}

/** @brief 一个用户会话的提问：工具定义、挂起的提问、你的答复、停止与关闭。 */
export class AskQuestions {
  /** 挂起的提问，按请求 id（插入顺序即提出的顺序） */
  private readonly pending = new Map<string, Pending>();
  /** 下一个请求 id 的序号（ask-<n>，每个会话从 1 起） */
  private nextId = 1;
  /** 现在不能出卡的原因：停止中（beginStop 到 endStop）、已关闭；可以出卡时为 null */
  private blocked: 'stopping' | 'closed' | null = null;

  /** @param setup 会话 id、事件的去处与答复的回调 */
  constructor(private readonly setup: AskSetup) {}

  /** @brief 交给 DefaultResourceLoader 的 inline extension（mori-question）：注册 ask_user_question。 */
  extension(): ExtensionFactory {
    return (pi) => {
      pi.registerTool(this.tool());
    };
  }

  /**
   * @brief 你在提问卡上的答复（question.answer）。
   * @param requestId ask-<n>
   * @param answers 每个问题的答复，按问题的顺序；null 为拒绝回答（Esc）
   * @throws 请求已经结束（`Question <id> is no longer pending`），或答复对不上问题
   */
  answer(requestId: string, answers: GivenAnswer[] | null): void {
    const item = this.pending.get(requestId);
    if (!item) throw new Error(`Question ${requestId} is no longer pending`);
    if (answers === null) {
      this.finish(requestId, { by: 'declined', answers: null, text: ASK_DECLINED_TEXT });
      return;
    }
    const checked = checkAnswers(item.request.questions, answers);
    if (!checked) throw new Error(ANSWERS_MISMATCH);
    this.finish(requestId, { by: 'user', answers: checked, text: answeredText(checked) });
  }

  /** @brief 挂起的提问，按提出的顺序（LiveSnapshot.asks）。 */
  requests(): AskRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }

  /** @brief 你按了停止：挂起的提问按 stop 结束；到 endStop 为止新的调用直接返回停止的原文、不出卡（§10.6）。 */
  beginStop(): void {
    if (this.blocked === null) this.blocked = 'stopping';
    this.endAll('stop');
  }

  /** @brief 停止结束（session.abort() 之后）：之后的调用照常出卡。 */
  endStop(): void {
    if (this.blocked === 'stopping') this.blocked = null;
  }

  /** @brief 会话关闭（归档、删除、退出）：挂起的提问按 closed 结束；之后的调用直接返回停止的原文。 */
  close(): void {
    this.blocked = 'closed';
    this.endAll('closed');
  }

  /** @brief ask_user_question 的定义（§10.1、§10.2）：JSON Schema 参数，说明全在 description 里，注册即启用。 */
  private tool(): ToolDefinition {
    return {
      name: ASK_TOOL,
      label: 'Ask the user',
      description: ASK_DESCRIPTION,
      parameters: askSchema() as unknown as ToolDefinition['parameters'],
      defaultActive: true,
      execute: (toolCallId, params, signal) => this.run(toolCallId, params as AskParams, signal),
    };
  }

  /**
   * @brief 执行一次调用（§10.3）：校验；停止中、已关闭或 signal 已中止时直接返回停止的原文；否则挂起一个提问。
   * @param toolCallId pi 的 toolCallId
   * @param params 参数（数量与必填已经 pi 校验）
   * @param signal 这次运行的中止信号
   */
  private run(toolCallId: string, params: AskParams, signal: AbortSignal | undefined): Promise<ToolResult> {
    const checked = checkQuestions(params.questions);
    if ('error' in checked) return Promise.resolve(invalidResult(checked.error));
    const by = this.blocked === 'stopping' ? 'stop' : this.blocked === 'closed' || signal?.aborted ? 'closed' : null;
    if (by !== null) {
      console.error(`[kernel] ${ASK_TOOL} ${toolCallId} in ${this.setup.sessionId} not asked (${by})`);
      return Promise.resolve(endResult({ by, answers: null, text: ASK_STOPPED_TEXT }));
    }
    return this.ask(toolCallId, checked.questions, signal);
  }

  /**
   * @brief 建请求 ask-<n>，先发 mori.question_request，再交给 away.ts 登记（§9.2），挂起直到结束；
   *        signal 中止时按 closed 结束。
   */
  private ask(toolCallId: string, questions: AskQuestion[], signal: AbortSignal | undefined): Promise<ToolResult> {
    const requestId = `ask-${this.nextId++}`;
    const request: AskRequest = { requestId, toolCallId, questions, askedAt: Date.now() };
    const sessionId = this.setup.sessionId;
    return new Promise<ToolResult>((resolve) => {
      const onAbort = () => this.finish(requestId, { by: 'closed', answers: null, text: ASK_STOPPED_TEXT });
      signal?.addEventListener('abort', onAbort, { once: true });
      const release = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(requestId, { request, resolve, release });
      this.send({ type: 'mori.question_request', ...request });
      registerAway({ userSessionId: sessionId, sessionId, requestId, kind: 'user',
        expire: (timeout: Exclude<AwayTimeout, 'never'>) => this.expire(requestId, timeout) });
    });
  }

  /**
   * @brief 你不在、到时（away.ts 调用，§9.4）：每个问题按 recommended 回答（auto: true），按 away 结束。
   * @param requestId ask-<n>
   * @param timeout 当时的时长
   * @return 这次自动处理的记录（agent 为 null）；提问已经结束时为 null
   */
  private expire(requestId: string, timeout: Exclude<AwayTimeout, 'never'>): AwayDecision | null {
    const item = this.pending.get(requestId);
    if (!item) return null;
    const { toolCallId, questions } = item.request;
    const answers = recommendedAnswers(questions);
    this.finish(requestId, { by: 'away', answers, text: awayAnswerText(answers, timeout) });
    return { requestId, kind: 'question', at: awayNow(), timeout, agent: null, toolCallId, toolName: ASK_TOOL,
      args: null, title: null, answers, result: 'recommended' };
  }

  /**
   * @brief 结束一个提问：注销计时，告诉界面（mori.question_end），把工具结果交还给 pi；有答案时（user、away）
   *        交给 onAnswered。
   * @return 提问还挂着并已结束时为真
   */
  private finish(requestId: string, ending: Ending): boolean {
    const item = this.pending.get(requestId);
    if (!item) return false;
    this.pending.delete(requestId);
    item.release();
    unregisterAway(this.setup.sessionId, requestId);
    const { toolCallId, questions } = item.request;
    this.send({ type: 'mori.question_end', requestId, toolCallId, by: ending.by, answers: ending.answers });
    item.resolve(endResult(ending));
    if (ending.answers !== null) this.answered(questions, ending.answers);
    return true;
  }

  /** @brief 按停止或关闭结束全部挂起的提问。 */
  private endAll(by: 'stop' | 'closed'): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { by, answers: null, text: ASK_STOPPED_TEXT });
  }

  /** @brief 有答案的提问交给 onAnswered（§10.7）；回调出错只记日志，不影响已经交还的工具结果。 */
  private answered(questions: AskQuestion[], answers: AskAnswer[]): void {
    if (!this.setup.onAnswered) return;
    try {
      this.setup.onAnswered(questions, answers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[kernel] forwarding the answer in ${this.setup.sessionId} failed: ${message}`);
    }
  }

  /** @brief 发一个本会话的事件。 */
  private send(event: KernelEvent): void {
    this.setup.send(event);
  }
}
