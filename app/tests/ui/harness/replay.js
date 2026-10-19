// 界面测试用的回放进程桥：代替 preload 提供 window.mori，回放 tests/fixtures/m1、m2 里从真实会话录下的命令与事件。
// 界面发出的每条命令都要与录制时的下一条命令一致（类型、送达方式、文字、批准的选择），否则记为不一致并拒绝；
// 一致时按录制的时间间隔（可加速）发出这条命令之后、下一条命令之前的事件，并在录制时的位置回复结果。
// session.state 是界面按事件自己发的，用录制时最近一次的结果回答。只用于测试，不在 src/ 中。
// 任务栏闪烁与 F8 不经过后台进程：这里只记下调用，截图和保存的结果由测试通过 window.__replay.f8 控制。

/** 截图返回的 1×1 PNG */
const PIXEL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * @brief synthetic：M1 录下的 session.create / session.open 结果里还没有批准设置（M2 才加），
 *        按后台进程对新会话的默认值（每次询问、没有已允许的工具）补上；M2 录下的原样返回。
 */
function withApproval(type, value) {
  if ((type !== 'session.create' && type !== 'session.open') || !value || value.approval) return value;
  return { ...value, approval: { mode: 'ask', allowed: [] } };
}

/** @brief 录制里由界面主动发出的命令（session.state 除外）的下标。 */
function boundaries(steps) {
  return steps.flatMap((step, index) => (step.command && step.command.type !== 'session.state' ? [index] : []));
}

/** @brief 拒绝理由的比较形式：去掉首尾空白，空串等于没写。 */
function reasonText(reason) {
  return reason?.trim() ?? '';
}

/**
 * @brief 两条命令是否一致。
 *        approval.answer 也比较 requestId：界面只能答复回放发出的请求，id 与录制时相同；比较它能发现答错了卡。
 */
function sameCommand(expected, actual) {
  if (expected.type !== actual.type) return false;
  switch (expected.type) {
    case 'session.prompt':
      return expected.text === actual.text && (expected.behavior ?? null) === (actual.behavior ?? null);
    case 'approval.answer':
      return expected.requestId === actual.requestId && expected.decision === actual.decision
        && reasonText(expected.reason) === reasonText(actual.reason);
    case 'approval.setMode':
      return expected.mode === actual.mode;
    case 'approval.forget':
      return expected.toolName === actual.toolName;
    default:
      return true;
  }
}

/**
 * @brief 不经过后台进程的桌面能力（任务栏闪烁、F8 截图与保存、打开所在文件夹）：只记下调用。
 *        返回的 f8 由测试改写，制造截图失败、保存失败或较慢的截图与保存。
 */
function desktopStubs(status) {
  const f8 = { captureDelayMs: 0, captureError: null, saveDelayMs: 0, saveError: null };
  const wait = (ms) => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
  const stubs = {
    requestAttention() {
      status.attention += 1;
      return Promise.resolve();
    },
    async captureWindow() {
      status.captures += 1;
      // 截图那一刻报告框在不在页面上：截图里不能有报告框（f8.md 反例）。
      status.dialogAtCapture.push(Boolean(document.querySelector('[data-testid="issue-dialog"]')));
      await wait(f8.captureDelayMs);
      if (f8.captureError) return { captureId: null, dataUrl: null, error: f8.captureError };
      return { captureId: `replay-capture-${status.captures}`, dataUrl: PIXEL, error: null };
    },
    async saveIssue(report) {
      await wait(f8.saveDelayMs);
      if (f8.saveError) throw new Error(f8.saveError);
      status.issues.push(structuredClone(report));
      return { file: `C:\\replay\\ui-issues\\replay-${status.issues.length}.md` };
    },
    showIssueInFolder(file) {
      status.shown.push(file);
      return Promise.resolve();
    },
  };
  return { f8, stubs };
}

/**
 * @brief 创建回放进程桥。
 * @param fixture 录制文件内容
 * @param options.speed 加速倍数
 * @param options.maxGap 两个事件之间最多等待的毫秒数（加速后）
 */
export function createReplayBridge(fixture, { speed = 1, maxGap = 1500 } = {}) {
  const steps = fixture.steps;
  const marks = boundaries(steps);
  const listeners = { event: new Set(), exit: new Set(), ready: new Set() };
  // played：已经放完的段数（每条命令之后、下一条命令之前算一段）；played 等于 cursor 时回放桥在等界面的下一条命令。
  const status = { cursor: 0, played: 0, clock: 0, exited: false, errors: [], commands: [],
    playing: Promise.resolve(), idle: true, attention: 0, captures: 0, dialogAtCapture: [], issues: [], shown: [] };
  const { f8, stubs } = desktopStubs(status);
  const created = steps.find((step) => step.result?.type === 'session.create')?.result.value;
  const saved = { connection: { name: 'replay', baseUrl: fixture.endpoint, api: 'openai-completions', apiKey: '',
    modelId: fixture.model.split('/').pop(), contextWindow: created?.contextUsage?.contextWindow ?? 128000,
    compat: [] }, keySaved: true };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** @brief 回放一段：从 start 到 end（不含），在命令结果的位置 resolve。 */
  async function play(start, end, commandType, resolve) {
    let previous = steps[start].t;
    let resolved = false;
    for (let index = start + 1; index < end; index += 1) {
      if (status.exited) return;
      const step = steps[index];
      const gap = Math.min(maxGap, Math.max(0, (step.t - previous) / speed));
      previous = step.t;
      if (gap > 0) await sleep(gap);
      status.clock = step.t;
      if (step.envelope) for (const listener of listeners.event) listener(structuredClone(step.envelope));
      if (step.result && !resolved && step.result.type === commandType) {
        resolved = true;
        resolve(step.result);
      }
    }
    if (!resolved) resolve({ type: commandType, value: null });
  }

  /** @brief 回答 session.state：录制时在这个时刻之后收到的第一个结果（录制器也是在 turn_end 后请求的）。 */
  function stateResult() {
    const results = steps.filter((step) => step.result?.type === 'session.state');
    const next = results.find((step) => step.t >= status.clock) ?? results.at(-1);
    return next?.result.value ?? { contextUsage: created?.contextUsage ?? null };
  }

  /** @brief 按录制回放一条界面命令。 */
  function replayCommand(command) {
    const index = marks[status.cursor];
    const expected = index === undefined ? null : steps[index].command;
    status.commands.push(command);
    if (!expected || !sameCommand(expected, command)) {
      const message = `replay mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(command)}`;
      status.errors.push(message);
      return Promise.reject(new Error(message));
    }
    status.cursor += 1;
    const end = marks[status.cursor] ?? steps.length;
    return new Promise((resolve, reject) => {
      status.idle = false;
      status.playing = status.playing.then(() => play(index, end, command.type, (result) => {
        if (result.error) reject(new Error(result.error));
        else resolve(withApproval(command.type, result.value));
      })).finally(() => {
        status.played += 1;
        status.idle = status.cursor >= marks.length;
      });
    });
  }

  const bridge = {
    request(command) {
      if (status.exited) return Promise.reject(new Error('Mori kernel exited (code 1)'));
      switch (command.type) {
        case 'config.get': return Promise.resolve({ agentDir: 'replay', saved });
        case 'connection.save': return Promise.resolve({ error: null });
        case 'connection.testCancel': return Promise.resolve({ cancelled: false });
        case 'connection.test':
          return Promise.resolve({ ok: true, cancelled: false, firstTokenMs: 1, totalMs: 2, text: 'ok', thinking: false,
            error: null });
        case 'session.state': return Promise.resolve(stateResult());
        default: return replayCommand(command);
      }
    },
    onEvent(listener) { listeners.event.add(listener); return () => listeners.event.delete(listener); },
    onKernelExit(listener) { listeners.exit.add(listener); return () => listeners.exit.delete(listener); },
    onKernelReady(listener) {
      listeners.ready.add(listener);
      if (!status.exited) queueMicrotask(listener);
      return () => listeners.ready.delete(listener);
    },
    restartKernel() {
      status.exited = false;
      setTimeout(() => { for (const listener of listeners.ready) listener(); }, 50);
      return Promise.resolve();
    },
    pickFolder() { return Promise.resolve(created?.cwd ?? null); },
    ...stubs,
  };
  const control = {
    status,
    f8,
    /** @brief 模拟后台进程退出。 */
    exit(code = 1) {
      status.exited = true;
      for (const listener of listeners.exit) listener(code);
    },
  };
  return { bridge, control };
}
