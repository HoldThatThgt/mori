// 界面测试用的回放进程桥：代替 preload 提供 window.mori，回放 tests/fixtures/m1 里从真实会话录下的命令与事件。
// 界面发出的每条命令都要与录制时的下一条命令一致（类型、送达方式、文字），否则记为不一致并拒绝；
// 一致时按录制的时间间隔（可加速）发出这条命令之后、下一条命令之前的事件，并在录制时的位置回复结果。
// session.state 是界面按事件自己发的，用录制时最近一次的结果回答。只用于测试，不在 src/ 中。

/** @brief 录制里由界面主动发出的命令（session.state 除外）的下标。 */
function boundaries(steps) {
  return steps.flatMap((step, index) => (step.command && step.command.type !== 'session.state' ? [index] : []));
}

/** @brief 两条命令是否一致。 */
function sameCommand(expected, actual) {
  if (expected.type !== actual.type) return false;
  if (expected.type !== 'session.prompt') return true;
  return expected.text === actual.text && (expected.behavior ?? null) === (actual.behavior ?? null);
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
  const status = { cursor: 0, clock: 0, exited: false, errors: [], commands: [], playing: Promise.resolve(), idle: true };
  const created = steps.find((step) => step.result?.type === 'session.create')?.result.value;
  const saved = { connection: { name: 'replay', baseUrl: fixture.endpoint, api: 'openai-completions', apiKey: '',
    modelId: fixture.model.split('/').pop(), contextWindow: created?.contextUsage?.contextWindow ?? 128000, compat: [] },
  keySaved: true };
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
        else resolve(result.value);
      })).finally(() => { status.idle = status.cursor >= marks.length; });
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
  };
  const control = {
    status,
    /** @brief 模拟后台进程退出。 */
    exit(code = 1) {
      status.exited = true;
      for (const listener of listeners.exit) listener(code);
    },
  };
  return { bridge, control };
}
