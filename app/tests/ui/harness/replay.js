// 界面测试用的回放进程桥：代替 preload 提供 window.mori，回放 tests/fixtures/m1–m4 里从真实会话录下的命令与事件。
// 界面发出的每条命令都要与录制时的下一条命令一致（类型、送达方式、文字、批准的选择、文件夹、会话文件、信任回答、
// 名字），否则记为不一致并拒绝；一致时按录制的时间间隔（可加速）发出这条命令之后、下一条命令之前的事件，
// 并在录制时的位置回复结果。
// 只读的查询不占顺序，用录制里的结果回答：session.state（录制时这一刻之后的第一个结果）、session.list（界面所在这一段
// 及之前录下的最后一个结果；开头那个即启动时的列表）、trust.check（同一文件夹按顺序取录制的结果；没录过时"不用问"）。
// 界面发过的查询记在 status.queries：接上还在后台进程里的会话时不该问信任，回放桥不会拒绝多出的 trust.check，
// 由测试检查这里没有它。
// 只用于测试，不在 src/ 中。
// 任务栏闪烁、F8 和删除会话文件不经过后台进程：这里只记下调用，截图和保存的结果由测试通过 window.__replay.f8 控制。
// M4：文件阅读器读文件按录制里的 file 步骤回答（同一个文件按录下的顺序，取完后重复最后一个）；用系统编辑器打开、复制、
// 保存反馈只记下调用，保存反馈的失败与延迟由测试通过 window.__replay.feedback 控制。session.prompt 还比较 refs。

/** 截图返回的 1×1 PNG */
const PIXEL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** synthetic：M3 才加进会话信息的字段，M1/M2 录制里没有时按后台进程对没有项目资源的文件夹的取值补上 */
const M3_INFO = { name: null, projectTrust: 'none', trustRemembered: false, trustSaveError: null, extensionErrors: [],
  extensionNotices: [] };

/**
 * @brief synthetic：M1 录下的 session.create / session.open 结果里还没有批准设置（M2 才加），按后台进程对新会话的
 *        默认值（每次询问、没有已允许的工具）补上；M3 的字段同样按 M3_INFO 补上。新录的原样返回。
 */
function withDefaults(type, value) {
  if ((type !== 'session.create' && type !== 'session.open') || !value) return value;
  return { ...M3_INFO, approval: { mode: 'ask', allowed: [] }, ...value };
}

/**
 * @brief synthetic：M1/M2 录下的 mori.prompt_error 还没有 running（M3 才加）；那时发出时就失败、没有开始运行，
 *        按 false 补上。新录的原样转发。
 */
function withEventDefaults(envelope) {
  const { event } = envelope;
  if (event.type !== 'mori.prompt_error' || 'running' in event) return envelope;
  return { ...envelope, event: { ...event, running: false } };
}

/** @brief 按键名排序后的 JSON（比较 refs：界面和录制器拼对象时键的先后可能不同）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** @brief 文件的比较形式：相对路径接在工作目录后面，统一反斜杠、不分大小写（与主进程解析后的绝对路径比较）。 */
function fileKey(path, cwd) {
  const absolute = /^[a-zA-Z]:[\\/]/.test(path) ? path : `${cwd.replace(/[\\/]+$/, '')}\\${path}`;
  return absolute.replace(/\//g, '\\').toLowerCase();
}

/**
 * @brief 按录制里的 file 步骤回答 readFile：同一个文件（按主进程解析后的路径）按录下的顺序，取完后重复最后一个。
 *        synthetic：没录过的文件按"文件已被删除或移动"回答，测试不该用到。
 */
function fileReader(fixture) {
  const reads = fixture.steps.filter((step) => step.file).map((step) => step.file);
  const taken = new Map();
  return (path, cwd) => {
    const key = fileKey(path, cwd);
    const matching = reads.filter((read) => read.result.path.toLowerCase() === key);
    const count = taken.get(key) ?? 0;
    taken.set(key, count + 1);
    const pick = matching[Math.min(count, matching.length - 1)];
    return pick ? structuredClone(pick.result) : { status: 'missing', path: key };
  };
}

/** 不占回放顺序的只读查询 */
const QUERIES = ['session.state', 'session.list', 'trust.check'];

/** @brief 录制里由界面主动发出的命令（只读查询除外）的下标。 */
function boundaries(steps) {
  return steps.flatMap((step, index) => (step.command && !QUERIES.includes(step.command.type) ? [index] : []));
}

/** @brief 信任回答的比较形式；没带时为空串。 */
function trustText(trust) {
  return trust ? `${trust.trusted}/${trust.remember}` : '';
}

/** @brief 拒绝理由的比较形式：去掉首尾空白，空串等于没写。 */
function reasonText(reason) {
  return reason?.trim() ?? '';
}

/**
 * @brief 两条命令是否一致。
 *        approval.answer、ui.answer 也比较 requestId：界面只能答复回放发出的请求，id 与录制时相同；比较它能发现答错了卡。
 *        ui.answer 的回答（真假、选中的那一项、输入的文字，取消为 null）要完全相同。
 */
function sameCommand(expected, actual) {
  if (expected.type !== actual.type) return false;
  switch (expected.type) {
    case 'session.prompt':
      return expected.text === actual.text && (expected.behavior ?? null) === (actual.behavior ?? null)
        && canonical(expected.refs) === canonical(actual.refs);
    case 'approval.answer':
      return expected.requestId === actual.requestId && expected.decision === actual.decision
        && reasonText(expected.reason) === reasonText(actual.reason);
    case 'ui.answer':
      return expected.requestId === actual.requestId && expected.value === actual.value;
    case 'approval.setMode':
      return expected.mode === actual.mode;
    case 'approval.forget':
      return expected.toolName === actual.toolName;
    case 'session.create':
      return expected.cwd === actual.cwd && trustText(expected.trust) === trustText(actual.trust);
    case 'session.open':
      return expected.sessionFile === actual.sessionFile && trustText(expected.trust) === trustText(actual.trust);
    case 'session.rename':
      return expected.name === actual.name && (expected.sessionId ?? null) === (actual.sessionId ?? null)
        && (expected.sessionFile ?? null) === (actual.sessionFile ?? null);
    case 'session.close':
      return expected.sessionId === actual.sessionId;
    default:
      return true;
  }
}

/**
 * @brief 不经过后台进程的桌面能力（任务栏闪烁、F8 截图与保存、打开所在文件夹）：只记下调用。
 *        返回的 f8 由测试改写，制造截图失败、保存失败或较慢的截图与保存。
 */
function desktopStubs(status, fixture) {
  const f8 = { captureDelayMs: 0, captureError: null, saveDelayMs: 0, saveError: null };
  const feedback = { delayMs: 0, error: null };
  const files = fileReader(fixture);
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
    deleteSessionFile(file) {
      status.deleted.push(file);
      return Promise.resolve({ deleted: true, error: null });
    },
    readFile(path, cwd) {
      status.reads.push({ path, cwd });
      return Promise.resolve(files(path, cwd));
    },
    openPath(path, cwd) {
      status.opened.push({ path, cwd });
      return Promise.resolve({ error: null, revealed: false });
    },
    copyText(text) {
      status.copied.push(text);
      return Promise.resolve();
    },
    async saveFeedback(record) {
      await wait(feedback.delayMs);
      if (feedback.error) throw new Error(feedback.error);
      status.feedback.push(structuredClone(record));
      return { file: `C:\\replay\\feedback\\replay-${status.feedback.length}.json` };
    },
  };
  return { f8, feedback, stubs };
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
  const status = { cursor: 0, played: 0, clock: 0, exited: false, errors: [], commands: [], queries: [],
    playing: Promise.resolve(), idle: true, attention: 0, captures: 0, dialogAtCapture: [], issues: [], shown: [],
    deleted: [], reads: [], opened: [], copied: [], feedback: [], failed: [] };
  const { f8, feedback, stubs } = desktopStubs(status, fixture);
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
      if (step.envelope) {
        for (const listener of listeners.event) listener(withEventDefaults(structuredClone(step.envelope)));
      }
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

  /**
   * @brief 回答 session.list：界面现在所在的这一段（上一条已回放的命令之后、下一条命令之前）里录下的最后一个结果，
   *        这一段没有时取更早的；还没回放任何命令时就是录制开头的那个（启动时的列表）。按段而不按回放时钟取，
   *        界面在一条命令之后马上读列表（例如删除之后）时也能拿到这一段录下的结果。
   */
  function listResult() {
    const end = marks[status.cursor] ?? steps.length;
    const found = steps.slice(0, end).filter((step) => step.result?.type === 'session.list' && !step.result.error);
    return structuredClone(found.at(-1)?.result.value ?? []);
  }

  /** 每个文件夹已经取走的 trust.check 结果数 */
  const trustTaken = new Map();

  /** @brief 录制里某个文件夹的 trust.check 结果，按顺序。 */
  function trustResults(cwd) {
    return steps.filter((step, index) => step.result?.type === 'trust.check'
      && steps.slice(0, index).reverse().find((s) => s.command?.type === 'trust.check')?.command.cwd === cwd);
  }

  /** @brief 回答 trust.check：同一文件夹按录制顺序取结果，取完后重复最后一个；没录过时"不用问"。 */
  function trustResult(cwd) {
    const recorded = trustResults(cwd);
    const taken = trustTaken.get(cwd) ?? 0;
    trustTaken.set(cwd, taken + 1);
    const step = recorded[Math.min(taken, recorded.length - 1)];
    return structuredClone(step?.result.value ?? { ask: false, readError: null });
  }

  /** @brief 下一条还没回放的 session.create 的文件夹（系统选文件夹对话框的结果）。 */
  function nextFolder() {
    const index = marks.slice(status.cursor).find((mark) => steps[mark].command.type === 'session.create');
    return index === undefined ? created?.cwd ?? null : steps[index].command.cwd;
  }

  /** @brief 按录制回放一条界面命令。control.failNext 有值时（synthetic）这一条直接以它失败，不占回放顺序。 */
  function replayCommand(command) {
    if (control.failNext) {
      const message = control.failNext;
      control.failNext = null;
      status.failed.push(command);
      return Promise.reject(new Error(message));
    }
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
        else resolve(withDefaults(command.type, result.value));
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
        case 'session.list':
          status.queries.push(command);
          return Promise.resolve(listResult());
        case 'trust.check':
          status.queries.push(command);
          return Promise.resolve(trustResult(command.cwd));
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
    pickFolder() { return Promise.resolve(nextFolder()); },
    ...stubs,
  };
  const control = {
    status,
    f8,
    feedback,
    /** synthetic：下一条界面命令直接以这段原文失败（测发送时就失败）；null 表示照常回放 */
    failNext: null,
    /** @brief 模拟后台进程退出。 */
    exit(code = 1) {
      status.exited = true;
      for (const listener of listeners.exit) listener(code);
    },
  };
  return { bridge, control };
}
