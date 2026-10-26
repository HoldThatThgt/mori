// 从真实会话录制 M5（分屏与会话引用）界面测试用的 fixture（tests/fixtures/m5/*.json）。做法与 m4-record.mjs 相同：
// 直接通过 window.mori（与界面相同的进程桥）发命令，记录命令、结果和后台进程转发的全部事件及其时间；批准请求由页面里的
// 录制器答复。每个场景用新的临时数据目录和一次新的启动，开头读一次会话列表，新建、打开会话前先 trust.check（像界面一样）。
// M5 多录的：
// 1. 会话引用读原会话（session.read）的结果，回放桥按会话文件、按顺序用它们回答界面（界面加芯片读一次，打开预览再读一次）。
// 2. 带会话引用的消息：发出的全文和 refs 用界面的代码算——把 src/renderer/src/state/sessionRefs.ts、quoteText.ts
//    用 esbuild 打包后在 node 里直接调用（不照搬），回放时界面发出的 session.prompt 要与录制一致（含 refs）。
// 录完先核对场景要的东西真的发生了；不符合时不写进 fixtures，写到 test-results/m5-record/<名字>.rejected.json。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m5-record.mjs --source <走查数据目录> [--only name1,name2] [--exe <Mori.exe>]
// 走查数据目录是负责人在 Mori 里填过连接的目录（key 由 Mori 加密保存）；脚本只复制密文文件，不读取 key。

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  appRoot, arg, launch, oneLine, prepareProject, realProviders, scratchUserData, useRealGroup,
} from './lib.mjs';

const source = arg('source');
const exePath = arg('exe');
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const outDir = join(appRoot, 'tests/fixtures/m5');
const rejectedDir = join(appRoot, 'test-results/m5-record');

/** 场景里发的文字 */
const prompts = {
  EDIT_LEFT: '请用 edit 工具把 README.md 的第一行改成 "# Mori M5 左栏"。不要运行命令，改完用一句话告诉我。',
  WRITE_RIGHT: '请用 write 工具新建 notes.md，内容只有一行 "Mori M5 右栏"。不要运行命令，写完用一句话告诉我。',
  SLEEP: '请运行命令 `sleep 37`，然后告诉我它的输出。',
  LONGER: '不要调用任何工具。请写五段文字，每段四到五句话：第一段讲春天，第二段讲夏天，第三段讲秋天，'
    + '第四段讲冬天，第五段讲四季轮回给人的启发。',
  TURNS: [
    '用一句话介绍你自己。不要调用任何工具。',
    '请读取 README.md，然后用一句话说明它的内容。',
    '我们来讨论一个小功能：给 src/a.ts 加一个减法函数。先用两句话说说思路，不要调用任何工具。',
    '函数名用 sub 还是 subtract 好？一句话回答，不要调用任何工具。',
    '参数要不要做类型检查？一句话回答，不要调用任何工具。',
    '好的，用一句话总结我们定下来的做法。不要调用任何工具。',
  ],
  ASK_REF: '根据上面引用的讨论，用一句话说明我们定下来的函数名。不要调用任何工具。',
  RENAME: '减法函数的讨论',
  SHORT: ['用一句话介绍你自己。不要调用任何工具。', '用一句话说说今天适合做什么。不要调用任何工具。'],
  ASK_RUNNING: '用一句话概括引用的内容。不要调用任何工具。',
  LONG_REPLY_ONLY: '请只回复"收到"两个字，不要调用任何工具。',
  ASK_LONG: '用一句话说说引用的内容大概在讲什么。不要调用任何工具。',
};

/** @brief ref-long 场景里一条很长的你的消息（第 n 条）：约 4,500 字的说明文字，最后要求只回"收到"。 */
function longMessage(n) {
  const sentence = `这是第 ${n} 条较长的说明，用来测试会话引用在内容超过两万字时默认只取最近五轮。`;
  return `${sentence.repeat(Math.ceil(4500 / sentence.length))}\n${prompts.LONG_REPLY_ONLY}`;
}
prompts.LONGS = [1, 2, 3, 4, 5, 6].map(longMessage);

/** @brief 把界面算引用内容的代码（sessionRefs.ts、quoteText.ts）打包后载入 node，录制时与界面拼出同样的全文。 */
async function loadRefCode() {
  const contents = "export { defaultRange, sessionRef, sessionTurns } from './src/renderer/src/state/sessionRefs.ts';\n"
    + "export { composePrompt } from './src/renderer/src/state/quoteText.ts';\n";
  const out = await build({ stdin: { contents, resolveDir: appRoot, loader: 'ts', sourcefile: 'm5-refs.ts' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const refCode = await loadRefCode();

/** @brief 侧栏上的会话名（照搬 src/renderer/src/components/ChatPane.tsx 的 displayTitle）。 */
function displayTitle(name, firstMessage) {
  if (name?.trim()) return name;
  const first = firstMessage?.replace(/\s+/g, ' ').trim();
  if (!first) return 'New session';
  return [...first].length > 20 ? `${[...first].slice(0, 20).join('')}…` : first;
}

/**
 * @brief 按界面的做法算会话引用：读出的会话（session.read 的结果）分轮，取 range（不给时取默认范围），
 *        返回引用、发给模型的全文和取到的范围。title 是侧栏上的会话名。
 */
function sessionRefFor(content, title, cwd, text, range) {
  const turns = refCode.sessionTurns(content.entries, content.cwd);
  const picked = range ?? refCode.defaultRange(turns);
  const ref = refCode.sessionRef(content, turns, picked, title);
  return { ref, text: refCode.composePrompt([ref], text, cwd), picked, turns: turns.length };
}

/** @brief 页面里的录制器（与 m4-record.mjs 相同）；等待的方法（等批准时同时看几个会话）见 installWaits。 */
function installRecorder() {
  const rec = {
    t0: performance.now(),
    steps: [],
    asked: 0,
    reset() { this.t0 = performance.now(); this.steps = []; this.asked = 0; },
    log(entry) { this.steps.push({ t: Math.round(performance.now() - this.t0), ...entry }); },
    async cmd(command) {
      this.log({ command });
      try {
        const result = await window.mori.request(command);
        this.log({ result: { type: command.type, value: result } });
        return result;
      } catch (error) {
        this.log({ result: { type: command.type, error: error.message } });
        throw error;
      }
    },
    events() { return this.steps.filter((s) => s.envelope).map((s) => s.envelope); },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
  };
  window.mori.onEvent((envelope) => {
    rec.log({ envelope });
    if (envelope.event.type === 'turn_end') {
      void rec.cmd({ type: 'session.state', sessionId: envelope.sessionId }).catch(() => {});
    }
  });
  window.__rec = rec;
}

/** @brief 给页面里的录制器（installRecorder 之后注入）加上等会话结束、答复批准请求和等条件成立的方法。 */
function installWaits() {
  Object.assign(window.__rec, {
    count(sessionId, type) {
      return this.events().filter((e) => e.sessionId === sessionId && e.event.type === type).length;
    },
    nextAsk() {
      return this.events().filter((e) => e.event.type === 'mori.approval_request')[this.asked] ?? null;
    },
    /** 等 want 里每个会话的 agent_settled 到给定次数；途中的批准请求按到达顺序，工具名在 allow 里的允许，其余拒绝 */
    async settle(want, allow = [], timeout = 300000) {
      const deadline = Date.now() + timeout;
      while (Object.entries(want).some(([id, n]) => this.count(id, 'agent_settled') < n)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(want)} to settle`);
        const envelope = this.nextAsk();
        if (!envelope) {
          await this.sleep(50);
          continue;
        }
        this.asked += 1;
        const { event, sessionId } = envelope;
        await this.cmd({ type: 'approval.answer', sessionId, requestId: event.requestId,
          decision: allow.includes(event.toolName) ? 'allow' : 'reject' });
      }
    },
    /** 等 fn() 为真 */
    async until(fn, what, timeout = 120000) {
      const deadline = Date.now() + timeout;
      while (!fn()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await this.sleep(50);
      }
    },
  });
}

// ---------- 页面里的共用操作（经 wrap 注入） ----------

/** @brief 像界面一样新建会话：先 trust.check（M5 的项目没有要信任的内容）。 */
const create = async (rec, cwd) => {
  await rec.cmd({ type: 'trust.check', cwd });
  return rec.cmd({ type: 'session.create', cwd });
};
/** @brief 像界面一样打开会话文件：先 trust.check。 */
const reopen = async (rec, sessionFile, cwd) => {
  await rec.cmd({ type: 'trust.check', cwd });
  return rec.cmd({ type: 'session.open', sessionFile });
};
const list = (rec) => rec.cmd({ type: 'session.list' });
/** @brief 发一条消息，等它的这一轮结束。 */
const say = async (rec, s, text, allow = []) => {
  const before = rec.count(s.sessionId, 'agent_settled');
  await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text });
  await rec.settle({ [s.sessionId]: before + 1 }, allow);
};

// ---------- 录完后的核对（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
const eventsOf = (steps, type) => steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope);

/** @brief 共同的要求：开头是会话列表；没有失败的命令（allowFail 里的除外）。 */
function common(steps, afterRestart = false, allowFail = []) {
  const first = steps.find((s) => s.command)?.command;
  const startList = values(steps, 'session.list')[0];
  const failed = failures(steps).filter((text) => !allowFail.some((type) => text.startsWith(type)));
  return [...need(first?.type === 'session.list' && Array.isArray(startList)
    && (afterRestart ? startList.length > 0 : startList.length === 0),
    'the recording does not start with session.list'),
  ...need(failed.length === 0, `failed commands: ${failed.join('; ')}`)];
}

/** @brief 带会话引用的那条你的消息：补发的 mori.entry_id 带着与发出时相同的 refs。 */
function refsSaved(steps) {
  const sent = steps.find((s) => s.command?.type === 'session.prompt' && s.command.refs)?.command;
  const saved = eventsOf(steps, 'mori.entry_id').map((e) => e.event).find((e) => e.role === 'user' && e.refs);
  return need(sent && sent.refs[0].source.kind === 'session'
    && JSON.stringify(saved?.refs) === JSON.stringify(sent.refs),
    `refs: sent ${JSON.stringify(sent?.refs)?.slice(0, 200)}, saved ${JSON.stringify(saved?.refs)?.slice(0, 200)}`);
}

/** @brief 某个会话用过的工具。 */
const toolsOf = (steps, sessionId) => eventsOf(steps, 'tool_execution_start')
  .filter((e) => e.sessionId === sessionId).map((e) => e.event.toolName);

/** @brief 重启后第一个列表里的第一个会话（这些场景重启前只有一个会话）。 */
const onlySession = (steps) => values(steps, 'session.list')[0]?.[0];

/** @brief 把第一次 session.read 的结果按界面的做法算成带引用的消息，放进 args.refPrompt 给下一段发出。 */
function prepareRefPrompt(steps, args, { target, title, text, range }) {
  const content = values(steps, 'session.read')[0];
  const made = sessionRefFor(content, title, target.cwd, text, range);
  args.refPrompt = { sessionId: target.sessionId, text: made.text, refs: [made.ref] };
}

/** @brief 发出 args.refPrompt，等这一轮结束。 */
const sendRef = async (rec, args) => {
  const { sessionId, text, refs } = args.refPrompt;
  const before = rec.count(sessionId, 'agent_settled');
  await rec.cmd({ type: 'session.prompt', sessionId, text, refs });
  await rec.settle({ [sessionId]: before + 1 });
};

/** @brief 带会话引用的消息里引用的轮次范围，例如 "3-5"。 */
const sentRange = (steps) => {
  const ref = steps.find((s) => s.command?.refs)?.command.refs[0].source;
  return ref ? `${ref.fromTurn}-${ref.toTurn}` : null;
};

// ---------- 场景 ----------

/** @brief split-approvals：同一项目两个会话各发一条要批准的消息，按到达顺序各自允许。 */
const splitApprovals = { name: 'split-approvals', description: '同一项目的两个会话（界面上左右分屏）各发一条要批准的消息：'
    + '左边用 edit 改 README.md，右边用 write 新建 notes.md；两张批准卡按到达顺序各自允许',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    const a = await args.create(rec, args.cwd);
    const b = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.prompt', sessionId: a.sessionId, text: args.EDIT_LEFT });
    await rec.cmd({ type: 'session.prompt', sessionId: b.sessionId, text: args.WRITE_RIGHT });
    await rec.settle({ [a.sessionId]: 1, [b.sessionId]: 1 }, ['edit', 'write']);
  } }],
  check: (steps) => {
    const [a, b] = values(steps, 'session.create');
    const asked = eventsOf(steps, 'mori.approval_request').map((e) => e.sessionId);
    const used = `${toolsOf(steps, a?.sessionId)} / ${toolsOf(steps, b?.sessionId)}`;
    return [...common(steps), ...need(toolsOf(steps, a?.sessionId).includes('edit')
      && toolsOf(steps, b?.sessionId).includes('write'), `tools: ${used}`),
    ...need(asked.includes(a?.sessionId) && asked.includes(b?.sessionId), 'both sessions asked')];
  } };

/** @brief split-esc：左边的长命令在右边生成时被停止，右边照常写完。 */
const splitEsc = { name: 'split-esc', description: '两个会话：左边运行要 37 秒的命令（允许），右边写一段长回复；'
    + '右边生成时停止左边（先撤回排队、再停止），右边照常写完',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    const a = await args.create(rec, args.cwd);
    const b = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.prompt', sessionId: a.sessionId, text: args.SLEEP });
    await rec.until(() => rec.nextAsk(), 'the sleep approval');
    const ask = rec.nextAsk();
    rec.asked += 1;
    await rec.cmd({ type: 'approval.answer', sessionId: a.sessionId, requestId: ask.event.requestId,
      decision: 'allow' });
    await rec.until(() => rec.count(a.sessionId, 'mori.approval_end') > 0, 'the sleep to start');
    await rec.cmd({ type: 'session.prompt', sessionId: b.sessionId, text: args.LONGER });
    await rec.until(() => rec.count(b.sessionId, 'message_update') > 40, 'the long reply to stream');
    await rec.cmd({ type: 'session.clearQueue', sessionId: a.sessionId });
    await rec.cmd({ type: 'session.abort', sessionId: a.sessionId });
    await rec.settle({ [a.sessionId]: 1, [b.sessionId]: 1 });
  } }],
  check: (steps) => {
    const [a, b] = values(steps, 'session.create');
    const settled = eventsOf(steps, 'agent_settled');
    const of = (s) => settled.find((e) => e.sessionId === s?.sessionId)?.event;
    const seen = settled.map((e) => [e.sessionId === a?.sessionId ? 'a' : 'b', e.event.aborted]);
    return [...common(steps), ...need(toolsOf(steps, a?.sessionId).includes('bash'), 'left did not run the command'),
      ...need(of(a)?.aborted === true && of(b)?.aborted === false, `settled: ${JSON.stringify(seen)}`)];
  } };

/** @brief ref-turns：引用没打开的会话的第 3–5 轮，改名、点引用打开它，再删除它。 */
const refTurns = { name: 'ref-turns', description: '先建会话 C（6 轮，第 2 轮读取 README.md），重启；新会话 A 引用 C 的'
    + '第 3–5 轮发出（读两次 C：加芯片、打开预览）；再把 C 改名、点引用打开 C；最后删除 C（关闭、删文件、重新读取列表）',
  phases: [{ page: async (rec, args) => {
    const c = await args.create(rec, args.cwd);
    for (const text of args.TURNS) await args.say(rec, c, text, ['read', 'bash']);
  } }, { restart: true }, { page: async (rec, args) => {
    const listed = await args.list(rec);
    await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.read', sessionFile: listed[0].sessionFile });
    await rec.cmd({ type: 'session.read', sessionFile: listed[0].sessionFile });
  } }, { node: (steps, args) => {
    const c = onlySession(steps);
    args.c = c;
    prepareRefPrompt(steps, args, { target: values(steps, 'session.create')[0], text: args.ASK_REF,
      title: displayTitle(c.name, c.firstMessage), range: { from: 3, to: 5 } });
  } }, { page: async (rec, args) => {
    await args.sendRef(rec, args);
    await rec.cmd({ type: 'session.rename', sessionFile: args.c.sessionFile, name: args.RENAME });
    await args.list(rec);
    const opened = await args.reopen(rec, args.c.sessionFile, args.c.cwd);
    await rec.cmd({ type: 'session.close', sessionId: opened.sessionId });
  } }, { node: (steps, args) => rmSync(args.c.sessionFile) }, { page: async (rec, args) => {
    await args.list(rec);
  } }],
  check: (steps) => {
    const lists = values(steps, 'session.list');
    const reads = values(steps, 'session.read');
    const names = JSON.stringify(lists.map((l) => l.map((item) => item.name)));
    // session.read 只交出你的消息、助手回复和 mori.ref（工具结果不交给界面）；第 2 轮要有一次工具调用。
    const calls = reads[0]?.entries.filter((e) => e.message?.role === 'assistant'
      && e.message.content.some((part) => part.type === 'toolCall')) ?? [];
    const leaked = reads[0]?.entries.some((e) => e.type === 'message' && e.message.role === 'toolResult');
    return [...common(steps, true), ...refsSaved(steps),
      ...need(sentRange(steps) === '3-5', `range ${sentRange(steps)}`),
      ...need(reads.length === 2 && reads[0].entries.length >= 12 && !reads[0].unfinished, 'two complete reads of C'),
      ...need(calls.length > 0 && !leaked, `tool calls in C: ${calls.length}, tool results leaked: ${leaked}`),
      ...need(lists.some((l) => l.some((item) => item.name === prompts.RENAME)) && lists.at(-1).length === 1,
        `lists: ${names}`)];
  } };

/** @brief ref-reopen：重启后打开带会话引用的会话，点引用打开原会话。 */
const refReopen = { name: 'ref-reopen', description: '先建会话 C（3 轮）和会话 A（引用 C 的第 1–2 轮发出），重启；'
    + '打开 A，点消息里的引用打开 C',
  phases: [{ page: async (rec, args) => {
    const c = await args.create(rec, args.cwd);
    for (const text of [args.TURNS[0], args.TURNS[2], args.TURNS[3]]) await args.say(rec, c, text);
    await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.read', sessionFile: c.sessionFile });
  } }, { node: (steps, args) => {
    const [c, a] = values(steps, 'session.create');
    args.c = c;
    args.a = a;
    prepareRefPrompt(steps, args, { target: a, text: args.ASK_REF, title: displayTitle(null, args.TURNS[0]),
      range: { from: 1, to: 2 } });
  } }, { page: async (rec, args) => {
    await args.sendRef(rec, args);
  } }, { restart: true }, { page: async (rec, args) => {
    await args.list(rec);
    await args.reopen(rec, args.a.sessionFile, args.a.cwd);
    await args.reopen(rec, args.c.sessionFile, args.c.cwd);
  } }],
  check: (steps) => {
    const opened = values(steps, 'session.open');
    const entry = opened[0]?.entries.find((e) => e.type === 'custom' && e.customType === 'mori.ref');
    return [...common(steps, true), ...need(opened.length === 2 && entry?.data.refs[0].source.kind === 'session'
      && entry.data.refs[0].source.fromTurn === 1, `refs entry: ${JSON.stringify(entry)?.slice(0, 300)}`)];
  } };

/** @brief ref-running：原会话正在生成第 3 轮时引用它，只取已完成的 2 轮。 */
const refRunning = { name: 'ref-running', description: '会话 C 已有 2 轮，第 3 轮正在写长回复时，会话 A 引用 C：'
    + '只取已完成的 2 轮（读两次 C），发出；两个会话都结束',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    const c = await args.create(rec, args.cwd);
    for (const text of args.SHORT) await args.say(rec, c, text);
    await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.prompt', sessionId: c.sessionId, text: args.LONGER });
    await rec.until(() => rec.count(c.sessionId, 'message_update') > 30, 'the long reply to stream');
    await rec.cmd({ type: 'session.read', sessionFile: c.sessionFile });
    await rec.cmd({ type: 'session.read', sessionFile: c.sessionFile });
  } }, { node: (steps, args) => {
    const [c, a] = values(steps, 'session.create');
    args.c = c;
    prepareRefPrompt(steps, args, { target: a, text: args.ASK_RUNNING, title: displayTitle(null, args.SHORT[0]) });
  } }, { page: async (rec, args) => {
    await args.sendRef(rec, args);
    await rec.settle({ [args.c.sessionId]: 3 });
  } }],
  check: (steps) => {
    const reads = values(steps, 'session.read');
    return [...common(steps), ...refsSaved(steps), ...need(reads.length === 2 && reads.every((r) => r.unfinished),
      'C was not generating while it was read'), ...need(sentRange(steps) === '1-2', `range ${sentRange(steps)}`)];
  } };

/** @brief ref-long：全部超过 2 万字时默认只取最近 5 轮。 */
const refLong = { name: 'ref-long', description: '会话 C 有 6 轮很长的你的消息（每条约 4,500 字，助手只回"收到"），'
    + '全部超过 2 万字；会话 A 引用 C：默认只取最近 5 轮（第 2–6 轮），发出',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    const c = await args.create(rec, args.cwd);
    for (const text of args.LONGS) await args.say(rec, c, text);
    await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.read', sessionFile: c.sessionFile });
  } }, { node: (steps, args) => {
    const [, a] = values(steps, 'session.create');
    prepareRefPrompt(steps, args, { target: a, text: args.ASK_LONG, title: displayTitle(null, args.LONGS[0]) });
  } }, { page: async (rec, args) => {
    await args.sendRef(rec, args);
  } }],
  check: (steps) => [...common(steps), ...refsSaved(steps),
    ...need(sentRange(steps) === '2-6', `range ${sentRange(steps)}`)] };

/**
 * @brief 录制的场景：phases 依次执行（page 在页面里录，node 在 node 里做，restart 关掉 Mori 再启动、之前的作为准备不进
 *        fixture）。check 在录完后核对。
 */
const scenarios = [splitApprovals, splitEsc, refTurns, refReopen, refRunning, refLong];

// ---------- 执行 ----------

/** @brief 把共用的操作注入页面里的场景函数（页面里没有模块作用域）。 */
function wrap(body) {
  return `async (rec, args) => {
    args.create = ${create.toString()};
    args.reopen = ${reopen.toString()};
    args.list = ${list.toString()};
    args.say = ${say.toString()};
    args.sendRef = ${sendRef.toString()};
    return (${body.toString()})(rec, args);
  }`;
}

/** @brief 在页面里执行一段场景，返回到目前为止录下的全部步骤；reset 为真时先清空录制器。 */
function recordInPage(page, body, args, reset) {
  return page.evaluate(async ({ source: text, values: params, fresh }) => {
    const rec = window.__rec;
    if (fresh) rec.reset();
    try {
      await new Function('rec', 'args', `return (${text})(rec, args);`)(rec, params);
    } catch (error) {
      const seen = rec.steps.map((s) => s.command?.type ?? s.result?.type ?? s.envelope?.event.type);
      throw new Error(`${error.message}; steps: ${seen.join(' ')}`);
    }
    await rec.sleep(300);
    return rec.steps;
  }, { source: wrap(body), values: args, fresh: reset });
}

/** @brief 启动 Mori 并在页面里装好录制器。 */
async function startMori(userData) {
  const app = await launch({ exePath, userData });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.mori));
  await page.evaluate(installRecorder);
  await page.evaluate(installWaits);
  return { app, page };
}

/**
 * @brief 依次执行场景的各段：page 在页面里录；node 在 node 里做（拿到目前的步骤和 args，可以往 args 里放东西给下一段）；
 *        restart 关掉 Mori 再启动，之前的步骤作为准备、不进 fixture（之前的结果放进 args.setup）。
 */
async function runPhases(scenario, args, state) {
  let steps = [];
  let fresh = true;
  for (const phase of scenario.phases) {
    if (phase.node) {
      await phase.node(steps, args, state);
    } else if (phase.restart) {
      args.setup = { creates: values(steps, 'session.create'), lists: values(steps, 'session.list') };
      await state.mori.app.close();
      state.mori = await startMori(state.userData);
      steps = [];
      fresh = true;
    } else {
      steps = await recordInPage(state.mori.page, phase.page, args, fresh);
      fresh = false;
    }
  }
  return steps;
}

/** @brief 一个场景：准备项目，依次执行各段，核对后写出 fixture（不符合时写到 rejected）。 */
async function runScenario(scenario, context, state) {
  const made = prepareProject('mori-m5-record-');
  const cwd = join(made.root, `m5-${scenario.name}`);
  renameSync(made.project, cwd);
  let steps = [];
  try {
    steps = await runPhases(scenario, { ...prompts, cwd }, state);
  } finally {
    rmSync(made.root, { recursive: true, force: true });
  }
  const fixture = { source: 'real',
    note: 'Recorded from a real session by tests/ui/m5-record.mjs; do not edit by hand.',
    name: scenario.name, description: scenario.description, endpoint: context.endpoint, model: context.model,
    recordedAt: new Date().toISOString(), steps };
  const problems = scenario.check(steps);
  const dir = problems.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${problems.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  const summary = `${steps.length} steps, ${steps.filter((s) => s.envelope).length} events`;
  if (problems.length) {
    console.log(`FAIL ${scenario.name}: ${problems.join('; ')} — ${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`RECORDED ${scenario.name}: ${summary}`);
  }
}

/** @brief 每个场景一个新的临时数据目录和一次新的启动；出错也会关掉 Mori、删掉临时目录。 */
async function recordFresh(scenario, context) {
  const userData = scratchUserData(source);
  // 测试准备（synthetic test setup，§14.1）：默认范围设为 [DeepSeek, GLM] 的分组
  useRealGroup(userData);
  const state = { userData, mori: null };
  try {
    state.mori = await startMori(userData);
    await runScenario(scenario, context, state);
  } catch (error) {
    console.error(`FAIL recording ${scenario.name}: ${oneLine(error, 600)}`);
    process.exitCode = 1;
  } finally {
    await state.mori?.app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
}

/**
 * @brief 读取走查数据目录里首选提供商（DeepSeek）的非机密信息：v1 从 model-config.json 取（lib.mjs realProviders，
 *        规格 §14.4），不再找 pi/models.json 的 mori-endpoint。
 */
function connectionInfo(dir) {
  const [first] = realProviders(dir);
  return { endpoint: first.baseUrl, model: first.ref };
}

const context = connectionInfo(source);
for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordFresh(scenario, context);
}
