// 从真实会话录制 M4（改动与选区）界面测试用的 fixture（tests/fixtures/m4/*.json）。做法与 m3-record.mjs 相同：
// 直接通过 window.mori（与界面相同的进程桥）发命令，记录命令、结果和后台进程转发的全部事件及其时间；批准请求由页面里的
// 录制器答复。每个场景用新的临时数据目录和一次新的启动，开头读一次会话列表，新建、打开会话前先 trust.check（像界面一样）。
// M4 多录两样东西：
// 1. 文件阅读器读到的内容：rec.read(path, cwd) 经主进程真的读一次，记成 { file: { path, cwd, result } }，
//    回放桥（tests/ui/harness/replay.js）按顺序用它们回答界面的 readFile。
// 2. 带引用的消息：发出的全文用界面的代码算——把 src/renderer/src/state/quoteText.ts 用 esbuild 打包后在 node 里
//    直接调用（不照搬，做法与 m5-record.mjs 相同），回放时界面发出的 session.prompt 要与录制一致（含 refs）。
//    所以带引用的场景分三段：页面里先读文件或等回复，node 里按录下的结果拼出引用和全文，页面里再发出。
// 反馈只经主进程保存，不经过后台进程，不录。
// 录完先核对场景要的东西真的发生了；不符合时不写进 fixtures，写到 test-results/m4-record/<名字>.rejected.json。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m4-record.mjs --source <走查数据目录> [--only name1,name2] [--exe <Mori.exe>]
// 走查数据目录是负责人在 Mori 里填过连接的目录（key 由 Mori 加密保存）；脚本只复制密文文件，不读取 key。

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  appRoot, arg, launch, oneLine, prepareProject, realProviders, scratchUserData, useRealGroup,
} from './lib.mjs';

const source = arg('source');
const exePath = arg('exe');
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const outDir = join(appRoot, 'tests/fixtures/m4');
const rejectedDir = join(appRoot, 'test-results/m4-record');

/** 场景里发的文字 */
const prompts = {
  EDIT_TWO: '请用 edit 工具做两处修改：1. 把 README.md 第一行改成 "# Mori M4 project"；'
    + '2. 在 src/a.ts 末尾加一个函数 export function sub(a: number, b: number): number { return a - b; }。'
    + '不要运行命令，改完用一句话告诉我。',
  WRITE: '请用 write 工具新建 docs/notes.md，内容是三行：第一行 "# Notes"，第二行空行，第三行 "Mori M4 walkthrough."。'
    + '不要运行命令，写完用一句话告诉我。',
  READ: '请读取 src/a.ts，然后用一句话说明它做什么。不要修改任何文件。',
  ASK_FILE: '这段代码有什么可以改进的地方？用一两句话回答，不要调用任何工具。',
  RENAME: '请用 edit 工具把这里的函数名 add 改成 plus，只改这一处，不要运行命令，改完用一句话告诉我。',
  ASK_REPLY_FIRST: '用两三句话介绍一下什么是单元测试。不要调用任何工具。',
  ASK_REPLY: '请把上面这段话缩短成一句。不要调用任何工具。',
  LONGER: '不要调用任何工具。请写五段文字，每段四到五句话：第一段讲春天，第二段讲夏天，第三段讲秋天，'
    + '第四段讲冬天，第五段讲四季轮回给人的启发。',
};

/** @brief 把界面拼引用全文的代码（quoteText.ts）打包后载入 node，录制时与界面拼出同样的全文。 */
async function loadQuoteCode() {
  const contents = "export { composePrompt } from './src/renderer/src/state/quoteText.ts';\n";
  const out = await build({ stdin: { contents, resolveDir: appRoot, loader: 'ts', sourcefile: 'm4-quotes.ts' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const quoteCode = await loadQuoteCode();

/** @brief 页面里的录制器（与 m3-record.mjs 相同），加上读文件、等会话结束并答复批准请求。 */
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
    /** 像文件阅读器一样经主进程读一个文件，记下结果 */
    async read(path, cwd) {
      const result = await window.mori.readFile(path, cwd);
      this.log({ file: { path, cwd, result } });
      return result;
    },
    events() { return this.steps.filter((s) => s.envelope).map((s) => s.envelope); },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    settledCount(sessionId) {
      return this.events().filter((e) => e.sessionId === sessionId && e.event.type === 'agent_settled').length;
    },
    nextAsk() {
      return this.events().filter((e) => e.event.type === 'mori.approval_request')[this.asked] ?? null;
    },
    /** 等这个会话的 agent_settled 到 n 次；途中的批准请求按 allow 里的工具名允许，其余拒绝 */
    async settle(sessionId, n, allow = [], timeout = 240000) {
      const deadline = Date.now() + timeout;
      while (this.settledCount(sessionId) < n) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${sessionId} to settle`);
        const envelope = this.nextAsk();
        if (!envelope) {
          await this.sleep(50);
          continue;
        }
        this.asked += 1;
        const { event } = envelope;
        await this.cmd({ type: 'approval.answer', sessionId, requestId: event.requestId,
          decision: allow.includes(event.toolName) ? 'allow' : 'reject' });
      }
    },
  };
  window.mori.onEvent((envelope) => {
    rec.log({ envelope });
    if (envelope.event.type === 'turn_end') {
      void rec.cmd({ type: 'session.state', sessionId: envelope.sessionId }).catch(() => {});
    }
  });
  window.__rec = rec;
}

// ---------- 页面里的共用操作（经 wrap 注入） ----------

/** @brief 像界面一样新建会话：先 trust.check（M4 的项目没有要信任的内容）。 */
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
/** @brief 像界面一样在阅读器里读一次模型用 read 读过的文件（点工具卡里的路径）。 */
const readTool = (rec, s) => {
  const start = rec.events().find((e) => e.event.type === 'tool_execution_start' && e.event.toolName === 'read');
  return rec.read(start.event.args.path, s.cwd);
};
/** @brief 发出上一段在 node 里拼好的带引用的消息（args.refPrompt）。 */
const sendQuoted = (rec, args) => {
  const { sessionId, refs, text } = args.refPrompt;
  return rec.cmd({ type: 'session.prompt', sessionId, refs, text });
};

// ---------- 录完后的核对、带引用的消息（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
const eventsOf = (steps, type) => steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);
const reads = (steps) => steps.filter((s) => s.file).map((s) => s.file);
const textOf = (message) => (typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map((part) => part.text ?? '').join(''));

/** @brief 文件内容按行拆开（照搬 src/renderer/src/state/quotes.ts 的 splitLines）。 */
function splitLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** @brief 最后一次读文件的第 from–to 行作为文件引用（与界面在阅读器里选这几行得到的一样）。 */
function fileRef(steps, from, to) {
  const read = reads(steps).at(-1);
  if (read?.result.status !== 'ok') throw new Error(`cannot read ${read?.path}: ${read?.result.status}`);
  const quote = splitLines(read.result.text).slice(from - 1, to).join('\n');
  return { quote, source: { kind: 'file', path: read.result.path, sha256: read.result.sha256, startLine: from,
    endLine: to } };
}

/** @brief 会话 s 最近一轮回复的整轮引用（与界面"Attach message as context"相同：正文段去掉首尾空白，段之间空一行）。 */
function replyRef(steps, s) {
  const events = steps.filter((step) => step.envelope?.sessionId === s.sessionId).map((step) => step.envelope.event);
  const userAt = events.findLastIndex((e) => e.type === 'message_start' && e.message.role === 'user');
  const ends = events.slice(userAt).filter((e) => e.type === 'message_end' && e.message.role === 'assistant');
  const texts = (message) => message.content.filter((p) => p.type === 'text' && p.text.trim()).map((p) => p.text.trim());
  const first = ends.find((e) => texts(e.message).length > 0)?.message;
  const id = events.find((e) => e.type === 'mori.entry_id' && e.role === 'assistant' && e.time === first?.timestamp);
  return { quote: ends.flatMap((e) => texts(e.message)).join('\n\n'), source: { kind: 'message',
    sessionFile: s.sessionFile, entryId: id?.entryId ?? null, time: first?.timestamp ?? null, scope: 'reply' } };
}

/**
 * @brief 按界面的做法拼出带引用的消息（quoteText.ts 的 composePrompt：每个引用一段引用块，接你的文字），
 *        放进 args.refPrompt 给下一段发出。refsOf 拿到录下的步骤和第一个新建的会话，返回引用。
 */
function prepareQuoted(steps, args, refsOf, text) {
  const s = values(steps, 'session.create')[0];
  const refs = refsOf(steps, s);
  args.refPrompt = { sessionId: s.sessionId, cwd: s.cwd, refs, text: quoteCode.composePrompt(refs, text, s.cwd) };
}

/** @brief 引用最后一次读到的文件的第 1–3 行。 */
const firstLines = (steps) => [fileRef(steps, 1, 3)];

/** @brief 共同的要求：开头是会话列表；没有失败的命令；每条你的消息和助手回复都补发了条目 id。 */
function common(steps, afterRestart = false) {
  const first = steps.find((s) => s.command)?.command;
  const startList = values(steps, 'session.list')[0];
  const starts = eventsOf(steps, 'message_end').filter((e) => ['user', 'assistant'].includes(e.message.role));
  const ids = eventsOf(steps, 'mori.entry_id');
  return [...need(first?.type === 'session.list' && Array.isArray(startList)
    && (afterRestart ? startList.length > 0 : startList.length === 0), 'the recording does not start with session.list'),
  ...need(failures(steps).length === 0, `failed commands: ${failures(steps).join('; ')}`),
  ...need(starts.length === ids.length && starts.every((e) => ids.some((id) => id.role === e.message.role
    && id.time === e.message.timestamp)), `entry ids: ${starts.length} messages, ${ids.length} mori.entry_id`)];
}

/** @brief 成功的编辑结果涉及的文件（带 diff 的）。 */
function editedFiles(steps) {
  const starts = eventsOf(steps, 'tool_execution_start');
  return eventsOf(steps, 'tool_execution_end').filter((e) => e.toolName === 'edit' && !e.isError
    && e.result?.details?.patch).map((e) => starts.find((s) => s.toolCallId === e.toolCallId)?.args?.path);
}

/** @brief 带引用的那条你的消息：补发的 mori.entry_id 带着与发出时相同的 refs。 */
function refsSaved(steps) {
  const sent = steps.find((s) => s.command?.type === 'session.prompt' && s.command.refs)?.command;
  const saved = eventsOf(steps, 'mori.entry_id').find((e) => e.role === 'user' && e.refs);
  return need(sent && JSON.stringify(saved?.refs) === JSON.stringify(sent.refs),
    `refs: sent ${JSON.stringify(sent?.refs)?.slice(0, 200)}, saved ${JSON.stringify(saved?.refs)?.slice(0, 200)}`);
}

/** @brief 没有调用工具（除了 allowed 里的）。 */
function toolsOnly(steps, allowed) {
  const used = eventsOf(steps, 'tool_execution_start').map((e) => e.toolName);
  return need(used.every((name) => allowed.includes(name)), `tools used: ${used.join(', ')}`);
}

/**
 * @brief 录制的场景：phases 依次执行（page 在页面里录；node 在 node 里做，拿到目前的步骤和 args，可以往 args 里放东西
 *        给下一段；restart 关掉 Mori 再启动、之前的作为准备不进 fixture）。check 在录完后核对。
 */
const scenarios = [
  { name: 'edit-two', description: '让模型用 edit 改两个文件（README.md、src/a.ts），允许编辑；改完读一次两个文件',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.EDIT_TWO });
      await rec.settle(s.sessionId, 1, ['edit', 'write']);
      await rec.read('README.md', s.cwd);
      await rec.read('src/a.ts', s.cwd);
    } }],
    check: (steps) => {
      const files = new Set(editedFiles(steps).map((path) => path?.replace(/\\/g, '/').split('/').pop()));
      return [...common(steps), ...toolsOnly(steps, ['edit', 'read', 'write']),
        ...need(files.has('README.md') && files.has('a.ts'), `edited files: ${[...files].join(', ')}`)];
    } },
  { name: 'write-delete', description: '让模型用 write 新建 docs/notes.md（允许）；读一次，删掉文件后再读一次（文件已被删除）',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.WRITE });
      await rec.settle(s.sessionId, 1, ['write']);
      const start = rec.events().find((e) => e.event.type === 'tool_execution_start' && e.event.toolName === 'write');
      await rec.read(start.event.args.path, s.cwd);
    } }, { node: (steps) => {
      const ok = reads(steps)[0]?.result;
      if (ok?.status !== 'ok') throw new Error(`the written file was not read: ${JSON.stringify(ok)}`);
      rmSync(ok.path);
    } }, { page: async (rec) => {
      const first = rec.steps.find((s) => s.file).file;
      await rec.read(first.path, first.cwd);
    } }],
    check: (steps) => {
      const [ok, gone] = reads(steps);
      return [...common(steps), ...toolsOnly(steps, ['write', 'read']),
        ...need(ok?.result.status === 'ok' && ok.result.text.includes('Mori M4 walkthrough.')
          && gone?.result.status === 'missing' && gone.path === ok.path, `reads: ${JSON.stringify(reads(steps))}`)];
    } },
  { name: 'quote-file', description: '模型读取 src/a.ts；在阅读器里读到同一个文件，引用第 1–3 行问问题（带 refs 发出）',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.READ });
      await rec.settle(s.sessionId, 1);
      await args.readTool(rec, s);
    } }, { node: (steps, args) => prepareQuoted(steps, args, firstLines, args.ASK_FILE) },
    { page: async (rec, args) => {
      await args.sendQuoted(rec, args);
      await rec.settle(args.refPrompt.sessionId, 2);
    } }],
    check: (steps) => [...common(steps), ...toolsOnly(steps, ['read']), ...refsSaved(steps),
      ...need(eventsOf(steps, 'agent_settled').length === 2, 'expected two settled turns')] },
  { name: 'quote-file-reopen', description: '重启之后：打开上一步（quote-file 的做法）带文件引用的会话，'
      + '会话记录里有 mori.ref 条目；点引用时读一次文件',
    phases: [{ page: async (rec, args) => {
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.READ });
      await rec.settle(s.sessionId, 1);
      await args.readTool(rec, s);
    } }, { node: (steps, args) => prepareQuoted(steps, args, firstLines, args.ASK_FILE) },
    { page: async (rec, args) => {
      await args.sendQuoted(rec, args);
      await rec.settle(args.refPrompt.sessionId, 2);
    } }, { restart: true }, { page: async (rec, args) => {
      await args.list(rec);
      const s = args.setup[0];
      const opened = await args.reopen(rec, s.sessionFile, s.cwd);
      const entry = opened.entries.find((e) => e.type === 'custom' && e.customType === 'mori.ref');
      await rec.read(entry.data.refs[0].source.path, s.cwd);
    } }],
    check: (steps) => {
      const opened = values(steps, 'session.open')[0];
      const refs = (opened?.entries ?? []).filter((e) => e.type === 'custom' && e.customType === 'mori.ref');
      const target = opened?.entries.find((e) => e.id === refs[0]?.data.messageId);
      return [...common(steps, true), ...need(refs.length === 1 && target?.message?.role === 'user'
        && textOf(target.message).startsWith('Quoting src/a.ts, lines 1–3:') && reads(steps)[0]?.result.status === 'ok',
      `refs entries: ${JSON.stringify(refs).slice(0, 300)}`)];
    } },
  { name: 'quote-changed', description: '引用 src/a.ts 第 1–3 行，让模型把 add 改成 plus（允许编辑）；改完再读一次文件，'
      + '引用的原文已经变了',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.READ });
      await rec.settle(s.sessionId, 1);
      await args.readTool(rec, s);
    } }, { node: (steps, args) => prepareQuoted(steps, args, firstLines, args.RENAME) },
    { page: async (rec, args) => {
      const { sessionId, cwd, refs } = args.refPrompt;
      await args.sendQuoted(rec, args);
      await rec.settle(sessionId, 2, ['edit']);
      await rec.read(refs[0].source.path, cwd);
    } }],
    check: (steps) => {
      const [before, after] = reads(steps);
      return [...common(steps), ...toolsOnly(steps, ['read', 'edit']), ...refsSaved(steps),
        ...need(editedFiles(steps).length >= 1 && before?.result.text.includes('function add')
          && after?.result.status === 'ok' && after.result.text.includes('plus') && !after.result.text.includes(
            'function add'), `reads: ${JSON.stringify(reads(steps).map((r) => r.result.text))}`)];
    } },
  { name: 'quote-reply', description: '问一个问题，再用"引用到输入框"的做法引用整轮回复（带 refs 发出）',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.ASK_REPLY_FIRST });
      await rec.settle(s.sessionId, 1);
      await rec.sleep(300);
    } }, { node: (steps, args) => prepareQuoted(steps, args, (all, s) => [replyRef(all, s)], args.ASK_REPLY) },
    { page: async (rec, args) => {
      await args.sendQuoted(rec, args);
      await rec.settle(args.refPrompt.sessionId, 2);
    } }],
    check: (steps) => {
      const sent = steps.find((s) => s.command?.refs)?.command;
      return [...common(steps), ...toolsOnly(steps, []), ...refsSaved(steps),
        ...need(sent?.refs[0].source.entryId && sent.refs[0].quote.length > 10, `ref: ${JSON.stringify(sent?.refs)}`)];
    } },
  { name: 'stream-feedback', description: '一条要生成好几秒的长回复（回放时在生成中选字、反馈；反馈不经过后台进程）',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.LONGER });
      await rec.settle(s.sessionId, 1);
    } }],
    check: (steps) => {
      const deltas = eventsOf(steps, 'message_update').filter((e) => e.update?.type === 'text_delta').length;
      return [...common(steps), ...toolsOnly(steps, []), ...need(deltas > 50, `only ${deltas} text deltas`)];
    } },
];

/** @brief 把共用的操作注入页面里的场景函数（页面里没有模块作用域）。 */
function wrap(body) {
  return `async (rec, args) => {
    args.create = ${create.toString()};
    args.reopen = ${reopen.toString()};
    args.list = ${list.toString()};
    args.readTool = ${readTool.toString()};
    args.sendQuoted = ${sendQuoted.toString()};
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
      const seen = rec.steps.map((s) => s.command?.type ?? s.result?.type ?? s.envelope?.event.type ?? 'file');
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
  return { app, page };
}

/** @brief 依次执行场景的各段（见 scenarios 的说明）。 */
async function runPhases(scenario, args, state) {
  let steps = [];
  let fresh = true;
  for (const phase of scenario.phases) {
    if (phase.node) {
      phase.node(steps, args, state);
    } else if (phase.restart) {
      args.setup = values(steps, 'session.create');
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
  const made = prepareProject('mori-m4-record-');
  const cwd = join(made.root, `m4-${scenario.name}`);
  renameSync(made.project, cwd);
  let steps = [];
  try {
    steps = await runPhases(scenario, { ...prompts, cwd }, state);
  } finally {
    rmSync(made.root, { recursive: true, force: true });
  }
  const fixture = { source: 'real', note: 'Recorded from a real session by tests/ui/m4-record.mjs; do not edit by hand.',
    name: scenario.name, description: scenario.description, endpoint: context.endpoint, model: context.model,
    recordedAt: new Date().toISOString(), steps };
  const problems = scenario.check(steps);
  const dir = problems.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${problems.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  const summary = `${steps.length} steps, ${steps.filter((s) => s.envelope).length} events, ${reads(steps).length} reads`;
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
