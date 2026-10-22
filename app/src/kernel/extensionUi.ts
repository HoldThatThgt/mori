// 扩展的界面上下文（方案第 6 节第 3 件，docs/v0/screens/extension-ui.md）：把扩展的通知、确认、选择、输入这四种转给界面。
// pi 的 RPC 模式另外还转达多行编辑器、状态栏、小部件、标题和编辑器文字，v0 不做（编辑器按取消回答）；页眉页脚、
// 自定义组件等终端界面才有的，照 pi 的空实现什么都不做。
// 询问挂起直到你回答、超时、扩展的 signal 中止、你按了停止或会话关闭；取消时按 pi 没有界面时的默认值回给扩展
// （确认为 false，选择和输入为空）。会话打开过程中（扩展的 session_start，界面还不认识这个会话）、停止过程中和会话关闭后
// 提出的询问不出卡，直接按这个默认值回答（否则打开、停止、关闭会一直等下去）；打开过程中的通知先存着，打开后交给界面。
// 每个会话一个，挂起的询问只在这里的内存里。
// 平行 Agent 的实例会话（docs/specs/parallel-agents-taskboard.md §8.2）不在界面上：它的询问一律不出卡，按上面的默认值回答
// 并记错误日志，通知只记日志。

import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent';
import type { EventEnvelope, ExtensionNotice, KernelEvent, UiRequest } from '../shared/protocol';

type Emit = (envelope: EventEnvelope) => void;
type Answer = boolean | string | null;

/** @brief 一个挂起的询问。 */
interface Pending {
  /** 询问的内容（界面重新加载后接上时再交给界面） */
  request: UiRequest;
  /** 把回答交回扩展；null 表示取消 */
  resolve: (value: Answer) => void;
}

/** @brief 一个会话的扩展询问。 */
export class ExtensionUi {
  /** 所属的 pi 会话 id；会话创建好后才知道 */
  private sessionId = '';
  /** 挂起的询问，按询问 id */
  private readonly pending = new Map<string, Pending>();
  /** 生成询问 id 的序号 */
  private nextId = 1;
  /** 现在不能出卡的原因：打开中、停止中、已关闭、实例会话（一直不能询问）；可以出卡时为 null */
  private blocked: 'starting' | 'stopping' | 'closed' | 'instance' | null = 'starting';
  /** 打开过程中扩展发的通知 */
  private readonly early: ExtensionNotice[] = [];

  /**
   * @param emit 把事件发给界面
   * @param instance 实例会话（§8.2）：以"不能询问"的状态建立，打开之后也不出卡
   */
  constructor(private readonly emit: Emit, private readonly instance = false) {
    if (instance) this.blocked = 'instance';
  }

  /** @brief 会话创建好后记下它的 id（之后的事件都带上它）。 */
  attach(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** @brief 挂起的询问，按提出的顺序。 */
  requests(): UiRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }

  /** @brief 你的回答；询问已经结束时报错。 */
  answer(requestId: string, value: Answer): void {
    if (!this.pending.has(requestId)) throw new Error(`Extension question ${requestId} is no longer pending`);
    this.finish(requestId, value);
  }

  /** @brief 会话打开好了（界面马上会认识它）：之后的询问出卡；返回打开过程中扩展发的通知。 */
  ready(): ExtensionNotice[] {
    if (!this.instance) this.blocked = null;
    return this.early.splice(0);
  }

  /** @brief 你按了停止：取消挂起的询问；到 endStop 为止新的询问直接按取消回答。 */
  beginStop(): void {
    if (this.blocked === null) this.blocked = 'stopping';
    this.cancelAll();
  }

  /** @brief 停止结束：之后的询问照常出卡。 */
  endStop(): void {
    if (this.blocked === 'stopping') this.blocked = null;
  }

  /** @brief 会话关闭（归档、删除、退出）：取消挂起的询问；之后的询问直接按取消回答，通知不再转发。 */
  close(): void {
    if (!this.instance) this.blocked = 'closed';
    this.cancelAll();
  }

  /** @brief 取消全部挂起的询问。 */
  private cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, null);
  }

  /** @brief 结束一个询问：交回扩展，并告诉界面。 */
  private finish(requestId: string, value: Answer): void {
    const item = this.pending.get(requestId);
    if (!item) return;
    this.pending.delete(requestId);
    item.resolve(value);
    this.send({ type: 'mori.ui_end', requestId });
  }

  /** @brief 发出一个询问并挂起；超时或 signal 中止时按取消结束。现在不能出卡时直接按取消回答。 */
  private ask(fields: Omit<UiRequest, 'requestId' | 'timeoutMs' | 'askedAt'>,
    opts: ExtensionUIDialogOptions | undefined) {
    if (opts?.signal?.aborted) return Promise.resolve<Answer>(null);
    if (this.blocked) {
      console.error(`[kernel] extension ${fields.method} "${fields.title}" answered as cancelled (${this.blocked})`);
      return Promise.resolve<Answer>(null);
    }
    const requestId = `question-${this.nextId++}`;
    const request: UiRequest = { requestId, ...fields, timeoutMs: opts?.timeout, askedAt: Date.now() };
    return new Promise<Answer>((resolve) => {
      const onAbort = () => this.finish(requestId, null);
      const timer = opts?.timeout ? setTimeout(onAbort, opts.timeout) : undefined;
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, { request, resolve: (value) => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      } });
      this.send({ type: 'mori.ui_request', ...request });
    });
  }

  /** @brief 交给 pi 的界面上下文（bindExtensions 的 uiContext）。 */
  context(): ExtensionUIContext {
    const ask = this.ask.bind(this);
    const relay = {
      confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
        (await ask({ method: 'confirm', title, message }, opts)) === true,
      select: async (title: string, options: string[], opts?: ExtensionUIDialogOptions) => {
        const value = await ask({ method: 'select', title, options }, opts);
        return typeof value === 'string' && options.includes(value) ? value : undefined;
      },
      input: async (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => {
        const value = await ask({ method: 'input', title, placeholder }, opts);
        return typeof value === 'string' ? value : undefined;
      },
      notify: (message: string, type?: 'info' | 'warning' | 'error') =>
        this.notify({ message, level: type ?? 'info' }),
    };
    return { ...TERMINAL_ONLY, ...relay } as unknown as ExtensionUIContext;
  }

  /** @brief 扩展的通知：实例会话只记日志；打开过程中先存着，关闭后只记日志，其余转给界面。 */
  private notify(notice: ExtensionNotice): void {
    if (this.instance) console.log(`[kernel] extension notice in ${this.sessionId}: ${notice.message}`);
    else if (this.blocked === 'starting') this.early.push(notice);
    else if (this.blocked === 'closed') console.error(`[kernel] extension notice after close: ${notice.message}`);
    else this.send({ type: 'mori.notify', ...notice });
  }

  /** @brief 发一个事件给界面。 */
  private send(event: KernelEvent): void {
    this.emit({ kind: 'event', sessionId: this.sessionId, event });
  }
}

/** 终端界面才有的部分：与 pi 没有界面时的空实现相同（core/extensions/runner.js noOpUIContext），主题不提供 */
const TERMINAL_ONLY = {
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => '',
  editor: async () => undefined,
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  theme: undefined,
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: 'UI not available' }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};
