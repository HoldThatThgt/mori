// 从真实会话录制 M7（工作回顾）界面测试用的 fixture（tests/fixtures/m7/*.json）。做法与 m4-record.mjs 相同：
// 直接通过 window.mori（与界面相同的进程桥）发命令，记录命令、结果和后台进程转发的全部事件及其时间。每个场景用新的
// 临时数据目录和一次新的启动，开头读一次会话列表，新建、打开会话前先 trust.check（像界面一样）。
// M7 多录的几种步骤（回放桥按它们回答界面）：
// 1. file：文件阅读器读到的内容（同 M4），{ file: { path, cwd, result } }。
// 2. feedback：交给主进程保存的反馈和主进程的结果，{ feedback: { record, result } }。record 与界面拼出的一样：
//    "Give feedback"照搬 src/renderer/src/state/turns.ts；回复里的选区照搬 components/selectionSource.ts 的 messagePick，
//    选的是回复原文里不含 Markdown 记号的一句（界面里选中它得到的字与原文相同）；阅读器里的选区是 filePick 选整行时的结果；
//    session 照搬 components/FeedbackForm.tsx 的 save 和 ChatPane.tsx 的 displayTitle。
// 3. issue：F8 报告。window.mori 是冻结的，录制器包不住界面自己的调用，所以这一步真的在界面里按 F8、填两栏、点"Save"，
//    记下填的字、截图是否成功和报告框显示的"Saved to <路径>"（主进程 saveIssue 的结果）；"Current view""Recent activity"由界面
//    生成，报告的原文在随后的 review 步骤里。截图时界面上没有录制器建的会话（录制器不经过界面），截图里是空的工作区。
// 4. review：主进程 listReview 的结果（两类记录），{ review: { result } }。
// 5. shot：主进程 reviewShot 的结果（截图的 data URL，原样记下，fixture 因此较大），{ shot: { name, result } }。
// 6. seed（只在 review-changed）：node 写进反馈文件夹的 synthetic 记录（内容里写明 synthetic），{ seed: { … } }。
//    pi 和 Mori 都没有让一条回复离开当前分支的操作（不手改会话文件），所以"回复不在了"用这份指向会话里不存在的
//    条目 id 和消息时间的 synthetic 反馈；会话和 session.read 的结果是真的。
// 场景里的 restart 段关掉 Mori 再用同一个数据目录启动；前后的步骤都留在 fixture 里，中间是一个 { restart: true } 步骤，
// 重启后的时间接着重启前最后一步往后算（不含重启花的时间）。
// 录完先核对场景要的东西真的发生了；不符合时不写进 fixtures，写到 test-results/m7-record/<名字>.rejected.json。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m7-record.mjs --source <走查数据目录> [--only name1,name2] [--exe <Mori.exe>]
// 走查数据目录是负责人在 Mori 里填过连接的目录（key 由 Mori 加密保存）；脚本只复制密文文件，不读取 key。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { appRoot, arg, launch, oneLine, prepareProject, scratchUserData } from './lib.mjs';

const source = arg('source');
const exePath = arg('exe');
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const outDir = join(appRoot, 'tests/fixtures/m7');
const rejectedDir = join(appRoot, 'test-results/m7-record');

/** 场景里发的文字和写下的反馈、报告 */
const prompts = {
  SUMMARY: '请用 read 工具读取 README.md，然后用两句话概括它的内容。不要修改任何文件，不要运行命令。',
  ASK: '用两句话介绍一下 Markdown 是什么。不要调用任何工具。',
  EXPECT_REPLY: '希望概括里直接说出这个项目是做什么用的',
  EXPECT_SELECTION: '希望这句话说得更具体一些',
  EXPECT_FILE: '希望 README 把这两行合成一句完整的话',
  EXPECT_SHORT: '希望回答再短一点',
  /** 阅读器里选的行（prepareProject 的 README 第 5–6 行是两条列表项） */
  FILE_FROM: 5,
  FILE_TO: 6,
  ISSUE_WHAT: '（m7-record 录制）侧栏里看不到录制器建的会话',
  ISSUE_EXPECT: '（m7-record 录制）这份报告只用来测试工作回顾',
};

/** review-changed 写进的 synthetic 反馈的文件名（日期早于真的记录，排在列表后面） */
const SEED_NAME = '2024-06-15-120000.json';

/** @brief 页面里的录制器（与 m4-record.mjs 相同）：记录命令、结果和事件。 */
function installRecorder() {
  const rec = {
    t0: performance.now(),
    steps: [],
    asked: 0,
    /** offset：重启后接着重启前最后一步的时间往后算 */
    reset(offset = 0) { this.t0 = performance.now() - offset; this.steps = []; this.asked = 0; },
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

/** @brief 录制器的其余操作：读文件、三种主进程调用（保存反馈、读记录、读截图）、等会话结束并答复批准请求。 */
function installCalls() {
  Object.assign(window.__rec, {
    /** 像文件阅读器一样经主进程读一个文件，记下结果 */
    async read(path, cwd) {
      const result = await window.mori.readFile(path, cwd);
      this.log({ file: { path, cwd, result } });
      return result;
    },
    /** 一次主进程调用：记成 { [kind]: { ...fields, result } }，失败时 error 是原文 */
    async main(kind, call, fields) {
      try {
        const result = await call();
        this.log({ [kind]: { ...fields, result } });
        return result;
      } catch (error) {
        this.log({ [kind]: { ...fields, error: error.message } });
        throw error;
      }
    },
    feedback(record) { return this.main('feedback', () => window.mori.saveFeedback(record), { record }); },
    review() { return this.main('review', () => window.mori.listReview(), {}); },
    shot(name) { return this.main('shot', () => window.mori.reviewShot(name), { name }); },
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
  });
}

// ---------- 页面里的共用操作（经 wrap 注入） ----------

/** @brief 像界面一样新建会话：先 trust.check（M7 的项目没有要信任的内容）。 */
const create = async (rec, cwd) => {
  await rec.cmd({ type: 'trust.check', cwd });
  return rec.cmd({ type: 'session.create', cwd });
};
/** @brief 像界面一样打开会话文件（openSaved：先 trust.check）。 */
const reopen = async (rec, sessionFile, cwd) => {
  await rec.cmd({ type: 'trust.check', cwd });
  return rec.cmd({ type: 'session.open', sessionFile });
};
const list = (rec) => rec.cmd({ type: 'session.list' });

/** @brief 消息内容转成纯文本（照搬 src/renderer/src/state/model.ts 的 contentText）。 */
const contentText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n');
};
/** @brief 会话名（照搬 components/ChatPane.tsx 的 displayTitle，TITLE_LENGTH 为 20；这里的消息不是技能调用）。 */
const displayTitle = (name, firstMessage) => {
  if (name?.trim()) return name;
  const first = firstMessage?.replace(/\s+/g, ' ').trim();
  if (!first) return 'New session';
  return [...first].length > 20 ? `${[...first].slice(0, 20).join('')}…` : first;
};
/** @brief 反馈里的 session（照搬 FeedbackForm.tsx 的 save：会话文件、工作目录、侧栏同一规则的会话名）。 */
const sessionOf = (rec, s) => {
  const start = rec.events().find((e) => e.sessionId === s.sessionId && e.event.type === 'message_start'
    && e.event.message.role === 'user');
  return { file: s.sessionFile, cwd: s.cwd, title: displayTitle(s.name, contentText(start?.event.message.content)) };
};
/**
 * @brief 这个会话最近一轮回复（照搬 state/turns.ts）：各条助手回复的条目 id、消息时间和正文段，
 *        整轮的原文（正文段去掉首尾空白，段之间空一行）和锚点（第一条有正文的回复）。
 */
const lastTurn = (rec, s) => {
  const events = rec.events().filter((e) => e.sessionId === s.sessionId).map((e) => e.event);
  const userAt = events.findLastIndex((e) => e.type === 'message_start' && e.message.role === 'user');
  const ends = events.slice(userAt).filter((e) => e.type === 'message_end' && e.message.role === 'assistant');
  const idOf = (message) => events.find((e) => e.type === 'mori.entry_id' && e.role === 'assistant'
    && e.time === message.timestamp)?.entryId ?? null;
  const replies = ends.map((e) => ({ entryId: idOf(e.message), time: e.message.timestamp ?? null,
    texts: e.message.content.filter((p) => p.type === 'text' && p.text.trim()).map((p) => p.text.trim()) }));
  const first = replies.find((reply) => reply.texts.length > 0) ?? replies[0];
  return { text: replies.flatMap((reply) => reply.texts).join('\n\n'), replies,
    anchor: { entryId: first?.entryId ?? null, time: first?.time ?? null } };
};
/** @brief 整轮回复作为反馈的来源（照搬 state/turns.ts 的 turnSource）。 */
const replySource = (s, turn) => ({ kind: 'message', sessionFile: s.sessionFile, entryId: turn.anchor.entryId,
  time: turn.anchor.time, scope: 'reply' });
/**
 * @brief 回复里选中的一句：不跨行、不含 Markdown 记号、不是列表项，界面渲染出来的字与原文相同；来源是这一句所在的
 *        那条助手回复（照搬 selectionSource.ts 的 messagePick）。
 */
const sentencePick = (s, turn) => {
  for (const reply of turn.replies) {
    for (const text of reply.texts) {
      const quote = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).find((part) => [...part].length >= 6
        && !part.includes('\n') && !/[*_`[\]#<>|~\\]/.test(part) && !/^(\d+[.)]|[-+])\s/.test(part));
      if (quote) {
        return { quote, source: { kind: 'message', sessionFile: s.sessionFile, entryId: reply.entryId,
          time: reply.time, scope: 'selection' } };
      }
    }
  }
  throw new Error(`no plain sentence in the reply: ${turn.text.slice(0, 200)}`);
};
/** @brief 文件内容按行拆开（照搬 quotes.ts 的 splitLines）。 */
const splitLines = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
};
/** @brief 读文件并取第 from–to 整行（与在阅读器里选这几行得到的一样：filePick，路径是主进程解析后的）。 */
const fileRef = async (rec, path, cwd, from, to) => {
  const read = await rec.read(path, cwd);
  if (read.status !== 'ok') throw new Error(`cannot read ${path}: ${read.status}`);
  const quote = splitLines(read.text).slice(from - 1, to).join('\n');
  return { quote, source: { kind: 'file', path: read.path, sha256: read.sha256, startLine: from, endLine: to } };
};
/** @brief 会话记录里这一条是不是锚点指向的助手回复（照搬 state/review.ts 的 isAnchor）。 */
const isAnchor = (entry, anchor) => entry.type === 'message' && entry.message.role === 'assistant'
  && ((anchor.entryId !== null && entry.id === anchor.entryId)
    || (anchor.time !== null && entry.message.timestamp === anchor.time));

// ---------- 录完后的核对（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
const failures = (steps) => steps.filter((s) => s.result?.error || s.feedback?.error || s.review?.error
  || s.shot?.error).map((s) => JSON.stringify(s).slice(0, 200));
const eventsOf = (steps, type) => steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope.event);
const commands = (steps, type) => steps.filter((s) => s.command?.type === type).map((s) => s.command);
const reads = (steps) => steps.filter((s) => s.file).map((s) => s.file);
const saves = (steps) => steps.filter((s) => s.feedback?.result).map((s) => s.feedback);
const reviews = (steps) => steps.filter((s) => s.review?.result).map((s) => s.review.result);
/** @brief 按键名排序后的 JSON（主进程按 schema 读出的对象，键的先后可能与保存时不同）。 */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};
/** @brief 重启前、重启后两段（没有重启时后一段为空）。 */
function parts(steps) {
  const at = steps.findIndex((s) => s.restart);
  return at < 0 ? [steps, []] : [steps.slice(0, at), steps.slice(at + 1)];
}

/** @brief 一段的共同要求：开头是会话列表；没有失败的调用；每条你的消息和助手回复都补发了条目 id。 */
function common(steps, afterRestart = false) {
  const first = steps.find((s) => s.command)?.command;
  const startList = values(steps, 'session.list')[0];
  const starts = eventsOf(steps, 'message_end').filter((e) => ['user', 'assistant'].includes(e.message.role));
  const ids = eventsOf(steps, 'mori.entry_id');
  const label = afterRestart ? 'after the restart' : 'before the restart';
  return [...need(first?.type === 'session.list' && Array.isArray(startList)
    && (afterRestart ? startList.length > 0 : startList.length === 0), `${label}: does not start with session.list`),
  ...need(failures(steps).length === 0, `${label}: failed calls: ${failures(steps).join('; ')}`),
  ...need(starts.length === ids.length && starts.every((e) => ids.some((id) => id.role === e.message.role
    && id.time === e.message.timestamp)), `${label}: ${starts.length} messages, ${ids.length} mori.entry_id`)];
}

/** @brief 没有调用工具（除了 allowed 里的）。 */
function toolsOnly(steps, allowed) {
  const used = eventsOf(steps, 'tool_execution_start').map((e) => e.toolName);
  return need(used.every((name) => allowed.includes(name)), `tools used: ${used.join(', ')}`);
}

/** @brief 读出的记录里有这份反馈，内容与保存时交给主进程的相同。 */
function listed(result, save) {
  const record = result?.feedback.find((item) => item.name === basename(save.result.file));
  return record?.status === 'ok' && canonical(record.feedback) === canonical(save.record);
}

/** @brief review-reply 重启前：一次 read，三份反馈（整条回复、回复里的一句、README 的两行）和一份带截图的 F8 报告。 */
function checkReplyBefore(steps) {
  const [reply, selection, file] = saves(steps);
  const read = reads(steps)[0];
  const issue = steps.find((s) => s.issue)?.issue;
  const readOk = eventsOf(steps, 'tool_execution_end').some((e) => e.toolName === 'read' && !e.isError);
  const lines = '- It has one README file.\n- It has one source file in src/.';
  return [...common(steps), ...toolsOnly(steps, ['read']), ...need(readOk, 'the model did not read a file'),
    ...need(saves(steps).length === 3, `${saves(steps).length} feedback saves`),
    ...need(reply?.record.source.scope === 'reply' && reply.record.source.entryId && reply.record.quote.length > 10,
      `reply feedback: ${JSON.stringify(reply?.record.source)}`),
    ...need(selection?.record.source.scope === 'selection' && selection.record.source.entryId
      && reply?.record.quote.includes(selection.record.quote), `selection: ${JSON.stringify(selection?.record)}`),
    ...need(file?.record.source.kind === 'file' && file.record.quote === lines && read?.result.status === 'ok'
      && file.record.source.sha256 === read.result.sha256, `file feedback: ${JSON.stringify(file?.record)}`),
    ...need(issue?.result.file && issue.capture.error === null, `issue: ${JSON.stringify(issue)}`)];
}

/** @brief review-reply 重启后：两节都列出这些记录；读到截图；回复的锚点在会话文件里，打开会话；读一次 README。 */
function checkReplyAfter(steps, before) {
  const saved = saves(before);
  const issueFile = basename(before.find((s) => s.issue)?.issue.result.file ?? '');
  const result = reviews(steps)[0];
  const report = result?.issues.find((item) => item.name === issueFile);
  const shot = steps.find((s) => s.shot)?.shot;
  const anchor = saved[0]?.record.source;
  const read = values(steps, 'session.read')[0];
  const opened = values(steps, 'session.open')[0];
  const file = reads(steps)[0];
  return [...common(steps, true), ...need(reviews(before).length === 1 && saved.every((save) => listed(
    reviews(before)[0], save)), 'the review list before the restart does not match the saves'),
  ...need(saved.every((save) => listed(result, save)), 'the review list does not match the saves'),
  ...need(report?.status === 'ok' && report.what === prompts.ISSUE_WHAT && report.shot, `report: ${report?.name}`),
  ...need(shot?.name === report?.shot && shot?.result.startsWith('data:image/png;base64,'), 'no screenshot'),
  ...need(anchor && read?.entries.some((entry) => isAnchor(entry, anchor)), 'the replied entry is not in session.read'),
  ...need(saved[1] && commands(steps, 'session.open')[0]?.sessionFile === anchor?.sessionFile
    && opened?.entries.some((entry) => isAnchor(entry, saved[1].record.source)), 'session.open'),
  ...need(file?.result.status === 'ok' && file.result.sha256 === saved[2]?.record.source.sha256,
    `README after the restart: ${JSON.stringify(file?.result).slice(0, 200)}`)];
}

/** @brief review-changed：真的回复反馈和 synthetic 反馈都列出；session.read 里找不到 synthetic 的锚点；不打开会话。 */
function checkChanged(steps) {
  const [before, after] = parts(steps);
  const [save] = saves(before);
  const seed = before.find((s) => s.seed)?.seed;
  const result = reviews(after)[0];
  const seeded = result?.feedback.find((item) => item.name === seed?.name);
  const read = values(after, 'session.read')[0];
  return [...common(before), ...common(after, true), ...toolsOnly(before, []),
    ...need(save?.record.source.scope === 'reply' && save.record.source.entryId, 'reply feedback'),
    ...need(seed?.synthetic && seeded?.status === 'ok' && listed(result, save), 'the review list'),
    ...need(read && seeded?.status === 'ok' && save
      && !read.entries.some((entry) => isAnchor(entry, seeded.feedback.source))
      && read.entries.some((entry) => isAnchor(entry, save.record.source)), 'session.read'),
    ...need(commands(after, 'session.open').length === 0, 'the session was opened')];
}

// ---------- node 里的段 ----------

/**
 * @brief 在界面里按 F8，填"What went wrong""What you expected"后保存（同 m7-app.mjs 的 saveReport），关掉报告框；
 *        返回要记下的 issue 步骤（"Saved to"后面的路径是主进程 saveIssue 的结果）。
 */
async function pressF8({ state, args }) {
  const { page } = state.mori;
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.locator('[data-testid="issue-shot"], [data-testid="issue-error"]').first().waitFor({ timeout: 15000 });
  const failed = await dialog.getByTestId('issue-error').count();
  const capture = { error: failed ? (await dialog.getByTestId('issue-error').innerText()).trim() : null };
  await dialog.getByTestId('issue-what').fill(args.ISSUE_WHAT);
  await dialog.getByTestId('issue-expect').fill(args.ISSUE_EXPECT);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  const file = /Saved to\s*(.+?\.md)\s*$/.exec(await saved.innerText())?.[1]?.trim() ?? null;
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  return { issue: { what: args.ISSUE_WHAT, expect: args.ISSUE_EXPECT, capture, result: { file } } };
}

/**
 * @brief synthetic：在真的反馈旁边写一份反馈，会话文件是这个真的会话，条目 id 和消息时间在会话里不存在
 *        （格式与 main/feedback.ts 存的相同，同 m7-app.mjs 的 seedFeedback）；返回要记下的 seed 步骤。
 */
function seedChanged({ steps }) {
  const s = values(steps, 'session.create')[0];
  const saved = saves(steps)[0];
  const record = { createdAt: '2024-06-15T04:00:00.000Z',
    expected: 'synthetic：由 tests/ui/m7-record.mjs 写入，锚点的条目 id 和消息时间在会话里不存在',
    quote: 'synthetic：会话当前分支上找不到的回复',
    source: { kind: 'message', sessionFile: s.sessionFile, entryId: 'synthetic-missing-entry', time: 1,
      scope: 'reply' },
    session: { file: s.sessionFile, cwd: s.cwd, title: 'synthetic 记录里的名字' } };
  writeFileSync(join(dirname(saved.result.file), SEED_NAME), `${JSON.stringify(record, null, 2)}\n`);
  return { seed: { synthetic: true, kind: 'feedback', name: SEED_NAME, record } };
}

/** @brief 重启前留下的、重启后的页面要用的：会话、保存的反馈（文件名和内容）、报告和 synthetic 记录的文件名。 */
function setupOf(steps) {
  const issue = steps.find((s) => s.issue)?.issue;
  return { session: values(steps, 'session.create')[0],
    feedback: saves(steps).map((save) => ({ name: basename(save.result.file), record: save.record })),
    issue: issue?.result.file ? basename(issue.result.file) : null,
    seed: steps.find((s) => s.seed)?.seed.name ?? null };
}

// ---------- 场景 ----------

/** @brief review-reply 重启前：读 README 概括；三份反馈；F8 报告；像"View in Review"一样读一次记录。 */
const replyPhases = [{ page: async (rec, args) => {
  await args.list(rec);
  const s = await args.create(rec, args.cwd);
  await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.SUMMARY });
  await rec.settle(s.sessionId, 1);
  await rec.sleep(500);
  const turn = args.lastTurn(rec, s);
  const session = args.sessionOf(rec, s);
  await rec.feedback({ expected: args.EXPECT_REPLY, quote: turn.text, source: args.replySource(s, turn), session });
  const pick = args.sentencePick(s, turn);
  await rec.feedback({ expected: args.EXPECT_SELECTION, quote: pick.quote, source: pick.source, session });
  const start = rec.events().find((e) => e.sessionId === s.sessionId && e.event.type === 'tool_execution_start'
    && e.event.toolName === 'read');
  if (!start) throw new Error('the model did not call read');
  const ref = await args.fileRef(rec, start.event.args.path, s.cwd, args.FILE_FROM, args.FILE_TO);
  await rec.feedback({ expected: args.EXPECT_FILE, quote: ref.quote, source: ref.source, session });
} }, { node: pressF8 }, { page: async (rec) => {
  await rec.review();
} }];

/**
 * @brief review-reply 重启后：打开工作回顾（读记录）、打开 F8 报告的详情（读截图）；回到原位置——整条回复（会话没开着：
 *        session.read 确认还在，再像侧栏一样打开）、回复里的一句（会话已开着，界面看对话流，不发命令）、README 的两行
 *        （右栏打开阅读器读文件）。
 */
const replyAfter = { page: async (rec, args) => {
  await args.list(rec);
  const records = await rec.review();
  const report = records.issues.find((item) => item.name === args.setup.issue);
  if (!report?.shot) throw new Error(`no screenshot in the report ${args.setup.issue}`);
  await rec.shot(report.shot);
  const [reply, , file] = args.setup.feedback;
  const s = args.setup.session;
  const content = await rec.cmd({ type: 'session.read', sessionFile: reply.record.source.sessionFile });
  if (!content.entries.some((entry) => args.isAnchor(entry, reply.record.source))) {
    throw new Error('the replied entry is not in the session');
  }
  await args.reopen(rec, s.sessionFile, s.cwd);
  await rec.read(file.record.source.path, s.cwd);
} };

/** @brief review-changed 重启后：打开工作回顾；synthetic 那份回到原位置——会话没开着，session.read 里找不到它。 */
const changedAfter = { page: async (rec, args) => {
  await args.list(rec);
  const records = await rec.review();
  const seeded = records.feedback.find((item) => item.name === args.setup.seed);
  if (seeded?.status !== 'ok') throw new Error(`the synthetic record is not listed: ${JSON.stringify(seeded)}`);
  const content = await rec.cmd({ type: 'session.read', sessionFile: seeded.feedback.source.sessionFile });
  if (content.entries.some((entry) => args.isAnchor(entry, seeded.feedback.source))) {
    throw new Error('the synthetic anchor is in the session');
  }
} };

/**
 * @brief 录制的场景：phases 依次执行（page 在页面里录；node 在 node 里做，返回的步骤记进录制；restart 关掉 Mori 再用
 *        同一个数据目录启动，前后的步骤都留着）。check 在录完后核对。
 */
const scenarios = [
  { name: 'review-reply', description: '让模型读 README.md 并用两句话概括；反馈这条回复、反馈回复里的一句、'
      + '在阅读器里反馈 README 第 5–6 行；按 F8 保存一份报告；读一次记录。重启后打开工作回顾（两节都列出）、'
      + '读 F8 报告的截图；回到原位置：整条回复（session.read 后打开会话）、回复里的一句（会话已开着）、文件里的两行（读文件）',
    phases: [...replyPhases, { restart: true }, replyAfter],
    check: (steps) => {
      const [before, after] = parts(steps);
      return [...checkReplyBefore(before), ...checkReplyAfter(after, before)];
    } },
  { name: 'review-changed', description: '问一个问题并反馈这条回复；写进一份 synthetic 反馈（seed 步骤），锚点是这个会话里'
      + '不存在的条目 id 和消息时间。重启后打开工作回顾，synthetic 那份回到原位置：session.read 里找不到它'
      + '（原文已变化），不打开会话',
    phases: [{ page: async (rec, args) => {
      await args.list(rec);
      const s = await args.create(rec, args.cwd);
      await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: args.ASK });
      await rec.settle(s.sessionId, 1);
      await rec.sleep(500);
      const turn = args.lastTurn(rec, s);
      await rec.feedback({ expected: args.EXPECT_SHORT, quote: turn.text, source: args.replySource(s, turn),
        session: args.sessionOf(rec, s) });
    } }, { node: seedChanged }, { restart: true }, changedAfter],
    check: checkChanged },
];

/** @brief 把共用的操作注入页面里的场景函数（页面里没有模块作用域）。 */
function wrap(body) {
  return `async (rec, args) => {
    const contentText = ${contentText.toString()};
    const displayTitle = ${displayTitle.toString()};
    const splitLines = ${splitLines.toString()};
    args.create = ${create.toString()};
    args.reopen = ${reopen.toString()};
    args.list = ${list.toString()};
    args.sessionOf = ${sessionOf.toString()};
    args.lastTurn = ${lastTurn.toString()};
    args.replySource = ${replySource.toString()};
    args.sentencePick = ${sentencePick.toString()};
    args.fileRef = ${fileRef.toString()};
    args.isAnchor = ${isAnchor.toString()};
    return (${body.toString()})(rec, args);
  }`;
}

/** @brief 在页面里执行一段场景，返回到目前为止录下的全部步骤；offset 不为 null 时先清空录制器（时间从 offset 起算）。 */
function recordInPage(page, body, args, offset) {
  return page.evaluate(async ({ source: text, values: params, start }) => {
    const rec = window.__rec;
    if (start !== null) rec.reset(start);
    try {
      await new Function('rec', 'args', `return (${text})(rec, args);`)(rec, params);
    } catch (error) {
      const seen = rec.steps.map((s) => s.command?.type ?? s.result?.type ?? s.envelope?.event.type
        ?? Object.keys(s).find((key) => key !== 't'));
      throw new Error(`${error.message}; steps: ${seen.join(' ')}`);
    }
    await rec.sleep(300);
    return rec.steps;
  }, { source: wrap(body), values: args, start: offset });
}

/** @brief 启动 Mori 并在页面里装好录制器。 */
async function startMori(userData) {
  const app = await launch({ exePath, userData });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.mori));
  await page.evaluate(installRecorder);
  await page.evaluate(installCalls);
  return { app, page };
}

/** @brief node 段：执行它，把它返回的步骤记进页面里的录制器，返回到目前为止录下的步骤。 */
async function runNode(phase, kept, steps, args, state) {
  const entry = await phase.node({ steps: [...kept, ...steps], args, state });
  const { page } = state.mori;
  if (entry) await page.evaluate((logged) => window.__rec.log(logged), entry);
  return page.evaluate(() => window.__rec.steps);
}

/** @brief 依次执行场景的各段（见 scenarios 的说明）；返回全部步骤，重启处是 { restart: true }。 */
async function runPhases(scenario, args, state) {
  let kept = [];
  let steps = [];
  let offset = 0;
  for (const phase of scenario.phases) {
    if (phase.node) {
      steps = await runNode(phase, kept, steps, args, state);
    } else if (phase.restart) {
      const last = [...kept, ...steps].at(-1)?.t ?? 0;
      kept = [...kept, ...steps, { t: last, restart: true }];
      args.setup = setupOf(kept);
      await state.mori.app.close();
      state.mori = await startMori(state.userData);
      steps = [];
      offset = last;
    } else {
      steps = await recordInPage(state.mori.page, phase.page, args, offset);
      offset = null;
    }
  }
  return [...kept, ...steps];
}

/** @brief 一个场景：准备项目，依次执行各段，核对后写出 fixture（不符合时写到 rejected）。 */
async function runScenario(scenario, context, state) {
  const made = prepareProject('mori-m7-record-');
  const cwd = join(made.root, `m7-${scenario.name}`);
  renameSync(made.project, cwd);
  let steps = [];
  try {
    steps = await runPhases(scenario, { ...prompts, cwd }, state);
  } finally {
    // 先关 Mori：后台进程里的会话以项目文件夹为工作目录，开着时删不掉。
    await state.mori?.app.close().catch(() => {});
    state.mori = null;
    removeDir(made.root);
  }
  const fixture = { source: 'real',
    note: 'Recorded from a real session by tests/ui/m7-record.mjs; do not edit by hand.',
    name: scenario.name, description: scenario.description, endpoint: context.endpoint, model: context.model,
    recordedAt: new Date().toISOString(), steps };
  const problems = scenario.check(steps);
  const dir = problems.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${problems.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  const kinds = ['file', 'feedback', 'issue', 'review', 'shot', 'seed'].map((kind) =>
    `${steps.filter((s) => s[kind]).length} ${kind}`);
  const summary = `${steps.length} steps, ${steps.filter((s) => s.envelope).length} events, ${kinds.join(', ')}`;
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
  const state = { userData, mori: null };
  try {
    state.mori = await startMori(userData);
    await runScenario(scenario, context, state);
  } catch (error) {
    console.error(`FAIL recording ${scenario.name}: ${oneLine(error, 600)}`);
    process.exitCode = 1;
  } finally {
    await state.mori?.app.close().catch(() => {});
    removeDir(userData);
  }
}

/** @brief 删掉临时目录；删不掉时只记错误日志。 */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.error(`cannot remove ${dir}: ${oneLine(error)}`);
  }
}

/** @brief 读取走查连接的非机密信息。 */
function connectionInfo(dir) {
  const provider = JSON.parse(readFileSync(join(dir, 'pi', 'models.json'), 'utf8')).providers['mori-endpoint'];
  return { endpoint: provider.baseUrl, model: `mori-endpoint/${provider.models[0].id}` };
}

const context = connectionInfo(source);
for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordFresh(scenario, context);
}
