// 从真实会话录制 v1 模型层回放用的 fixture（tests/fixtures/v1/*.json，docs/specs/model-providers.md §14.1、§14.2 的
// 回放层：换模型、重做、回到首选、拒绝启动、顶栏范围、顶栏思考强度）。
// 做法同原 m7-record.mjs（随工作回顾删除，docs/specs/memory.md §14.4）：页面里的录制器直接通过 window.mori（与界面相同的进程桥）发会话命令，记下命令、结果和后台进程
// 转发的全部事件及其时间。不同的是故障与恢复按 §14.1 用真实方式触发：
//   - 准备（synthetic test setup，v1-real-helpers.mjs）：复制负责人的数据目录（只复制加密的文件，不读 key），在复制出的
//     model-config.json 里建分组 [首选提供商, 第二个提供商] 作为默认范围、给临时项目授权公网（blocked 场景不授权），
//     把首选提供商 key 的密文另存到备用 ref。
//   - 故障：在界面里（设置 → Models → Keys）给首选提供商加一个错的 key（sk-invalid）、删掉原来的 key，之后它的请求得到
//     真实的 401：在回复开始前做就是段开始时换模型（switch-start），在一个连续调用工具的回复进行中做就是段内换模型
//     （switch-mid）。window.mori 是冻结的，录制器包不住界面自己的调用，所以界面上的这几步不进命令序列，只在 fixture 里
//     记一个 { note } 步骤；它们引起的事件（mori.key_status 等）照常录下。
//   - 恢复：退出 App，把复制出的配置里首选提供商的 key 改指备用 ref，重新启动；前后的步骤都留在 fixture 里，中间是
//     { restart: true }（同 M7，回放用 ?part=before|after）。
//   - 写配置的 models.* 命令由回放桥像 connection.save 一样直接应答、不占回放顺序（§14.4）：授权公网经 window.mori 直接发、
//     记一个 { note } 步骤；标"支持思考"的 models.saveModel 照常录下（同 m6-record.mjs，m6-replay.mjs 照它在设置页里勾选）。
//     只读的 models.get、session.pickOptions 照常录下。
// 录完先核对场景要的东西真的发生了（check）；不符合时不写进 fixtures，写到 test-results/v1-models-record/<名字>.rejected.json。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/v1-models-record.mjs --source <走查数据目录> [--only switch-start,switch-mid] [--exe <Mori.exe>]
//        [--first <提供商 id>] [--second <提供商 id>] [--out <目录>]
// --out 只用来检查本脚本自己（例如对两个合成端点录，写到临时目录）；tests/fixtures/v1 里只放对真实提供商录的。
// 走查数据目录要先用 v1 打开过一次、两个真实提供商（默认 DeepSeek 与 GLM）的区域已确认（§14.1）。

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import {
  addNotes, findRealProviders, injectWrongKey, prepareRealConfig, projectKey, readJson, restoreFirstKey,
  scratchModelData, sourceProblems, spareRef, TEST_GROUP, waitProfiles, WRONG_KEY,
} from './v1-real-helpers.mjs';

const source = arg('source') ? resolve(arg('source')) : null;
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
const outDir = arg('out') ? resolve(arg('out')) : join(appRoot, 'tests/fixtures/v1');
const rejectedDir = join(appRoot, 'test-results/v1-models-record');

/** 场景里发的文字 */
const PROMPTS = {
  ONE_LINE: '用一句话介绍你自己。不要调用任何工具。',
  ONE_LINE_2: '用一句话说说今天适合做什么。不要调用任何工具。',
  WHICH: '用一句话说说你是哪个模型。不要调用任何工具。',
  REASON_1: '笼子里有鸡和兔共 35 只，脚共 94 只。鸡兔各几只？只给出答案，不要调用任何工具。',
  REASON_2: '一个数加上它的一半等于 45，这个数是多少？只给出答案，不要调用任何工具。',
  /** 连续调五次 read：段内换模型要在回复进行中换 key */
  MULTI: '请依次读取 notes-1.md、notes-2.md、notes-3.md、notes-4.md、notes-5.md 这五个文件：每次只调用一次 read 工具，'
    + '读完一个再读下一个，不要同时调用多个工具。全部读完后用一句话说明它们的共同点。不要修改任何文件，不要运行命令。',
};

// ---------- 页面里的录制器 ----------

/** @brief 页面里的录制器（同原 m7-record.mjs）：记录命令、结果和事件；turn_end 后读一次 session.state（像界面一样）。 */
function installRecorder(offset) {
  const rec = {
    t0: performance.now() - offset,
    steps: [],
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
  };
  window.mori.onEvent((envelope) => {
    rec.log({ envelope });
    if (envelope.event.type === 'turn_end') {
      void rec.cmd({ type: 'session.state', sessionId: envelope.sessionId }).catch(() => {});
    }
  });
  window.__rec = rec;
}

/** @brief 一个场景运行时的操作（node 这边驱动页面里的录制器）。 */
function driver(state) {
  const page = () => state.page;
  const d = {
    page,
    cmd: (command) => page().evaluate((c) => window.__rec.cmd(c), command),
    /** 不进命令序列的写命令（回放桥直接应答，§14.4）：经 window.mori 直接发，记一个 note 步骤 */
    async direct(command, note) {
      const result = await page().evaluate((c) => window.mori.request(c), command);
      await d.note(`${note} (${command.type}, sent outside the recorded command sequence; result error: `
        + `${result?.error ?? null})`);
      if (result?.error) throw new Error(`${command.type}: ${result.error}`);
      return result;
    },
    note: (text) => page().evaluate((t) => window.__rec.log({ note: t }), text),
    steps: () => page().evaluate(() => window.__rec.steps),
    events: async (sessionId, type) => (await d.steps()).filter((s) => s.envelope?.sessionId === sessionId
      && (!type || s.envelope.event.type === type)).map((s) => s.envelope.event),
    /** 等 fn(steps) 为真 */
    async until(fn, what, timeout = 300000) {
      const deadline = Date.now() + timeout;
      while (!fn(await d.steps())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(200);
      }
    },
    settled: async (sessionId) => (await d.events(sessionId, 'agent_settled')).length,
    /** 像界面一样新建会话：先 trust.check（临时项目没有要信任的内容） */
    async create(cwd) {
      await d.cmd({ type: 'trust.check', cwd });
      return d.cmd({ type: 'session.create', cwd });
    },
    /** 发一条消息，等它的这一轮结束（read 是只读工具，不问批准） */
    async say(session, text) {
      const before = await d.settled(session.sessionId);
      await d.cmd({ type: 'session.prompt', sessionId: session.sessionId, text });
      await d.until((steps) => steps.filter((s) => s.envelope?.sessionId === session.sessionId
        && s.envelope.event.type === 'agent_settled').length > before, `${session.sessionId} to settle`);
    },
    /** 开头像界面一样读会话列表、设置与模型配置 */
    async start() {
      await d.cmd({ type: 'session.list' });
      await d.cmd({ type: 'config.get' });
      return d.cmd({ type: 'models.get' });
    },
  };
  return d;
}

// ---------- 录完后的核对（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
const eventsOf = (steps, sessionId, type) => steps.filter((s) => s.envelope?.sessionId === sessionId
  && s.envelope.event.type === type).map((s) => s.envelope.event);
/** @brief 一个会话有正文或工具调用的助手回复（message_end）的实际模型 <provider>/<model>，按顺序。 */
const replyRefs = (steps, sessionId) => eventsOf(steps, sessionId, 'message_end')
  .filter((e) => e.message.role === 'assistant').map((e) => `${e.message.provider}/${e.message.model}`);
const errorReplies = (steps, sessionId) => eventsOf(steps, sessionId, 'message_end')
  .filter((e) => e.message.role === 'assistant' && e.message.stopReason === 'error');
const thinkingOf = (message) => (message?.content ?? []).filter((c) => c.type === 'thinking').map((c) => c.thinking)
  .join('');
const textOf = (message) => (message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
/** @brief 重启前（before）或重启后（after）的步骤；没有重启时 before 是全部。 */
const partOf = (steps, part) => {
  const at = steps.findIndex((s) => s.restart);
  if (at < 0) return part === 'before' ? steps : [];
  return part === 'before' ? steps.slice(0, at) : steps.slice(at + 1);
};

/** @brief 共同的要求：开头是会话列表；没有失败的命令；没有 No model available。 */
function common(steps) {
  const first = steps.find((s) => s.command)?.command;
  const unavailable = steps.filter((s) => s.envelope?.event.type === 'mori.model_unavailable');
  return [...need(first?.type === 'session.list', 'the recording does not start with session.list'),
    ...need(failures(steps).length === 0, `failed commands: ${failures(steps).join('; ')}`),
    ...need(unavailable.length === 0, 'a No model available card was recorded')];
}

/** @brief 一次换模型事件是否从 first 换到 second、原因 auth、hidden 符合。 */
function switchProblems(sw, ctx, hidden) {
  if (!sw) return ['no mori.model_switch event'];
  return [...need(sw.from === ctx.firstRef && sw.to === ctx.secondRef, `switch ${sw.from} → ${sw.to}`),
    ...need(sw.reason === 'auth', `switch reason ${sw.reason} (${sw.detail})`),
    ...need(sw.hidden === hidden, `switch hidden ${sw.hidden}, want ${hidden}`)];
}

// ---------- 场景 ----------

/** @brief switch-start：首选的 key 换成错的后发消息，第一个请求 401，同一个请求发给第二候选。 */
const switchStart = {
  name: 'switch-start', layer: 'MP-14',
  description: '在设置 → Models 里给首选提供商加一个错的 key 并删掉原来的 key，然后新会话（默认范围是分组 [首选, 第二]）'
    + '发一句不用工具的话：第一个请求得到真实的 401，同一个请求发给第二候选，对话流一行换模型提示，没有错误卡',
  async run(d, ctx) {
    await d.start();
    const { removed, added } = await injectWrongKey(ctx.state.page, ctx.first.id, { back: false });
    await d.note(`UI: Settings → Models → ${ctx.first.id} → Keys: Add key "${WRONG_KEY}" (${added}), `
      + `Remove ${removed}`);
    await d.cmd({ type: 'models.get' });
    const s = await d.create(ctx.cwd);
    await d.say(s, PROMPTS.ONE_LINE);
  },
  check(steps, ctx) {
    const s = values(steps, 'session.create')[0];
    const sw = eventsOf(steps, s?.sessionId, 'mori.model_switch');
    return [...common(steps), ...need(s?.current === ctx.firstRef, `new session current ${s?.current}`),
      ...need(sw.length === 1, `${sw.length} switch events`), ...switchProblems(sw[0], ctx, false),
      ...need(replyRefs(steps, s?.sessionId).at(-1) === ctx.secondRef, `replies ${replyRefs(steps, s?.sessionId)}`),
      ...need(errorReplies(steps, s?.sessionId).length === 0, 'an error reply was recorded')];
  },
};

/** @brief switch-mid：连续调工具的回复进行中把首选的 key 换成错的，段内换模型（重做）；重启恢复 key 后下一段用回首选。 */
const switchMid = {
  name: 'switch-mid', layer: 'MP-15, MP-13',
  description: '新会话让模型一个一个读五个文件；回复开始后在设置 → Models 里给首选提供商加一个错的 key 并删掉原来的 key，'
    + '之后的请求得到真实的 401，段内换到第二候选并重做这段；退出、把首选的 key 改指备份的密文、重新启动，打开同一个会话再问'
    + '一句，用回首选',
  async run(d, ctx) {
    addNotes(ctx.cwd);
    await d.start();
    const s = await d.create(ctx.cwd);
    await d.cmd({ type: 'session.prompt', sessionId: s.sessionId, text: PROMPTS.MULTI });
    // 回复开始（agent_start）时第一个请求已经带着原来的 key 发出；之后的请求用错的 key。
    await d.until((steps) => eventsOf(steps, s.sessionId, 'agent_start').length >= 1, 'the reply to start');
    const { removed, added } = await injectWrongKey(ctx.state.page, ctx.first.id, { back: false });
    await d.note(`UI (mid-reply, after the reply started): Settings → Models → ${ctx.first.id} → Keys: `
      + `Add key "${WRONG_KEY}" (${added}), Remove ${removed}`);
    await d.until((steps) => eventsOf(steps, s.sessionId, 'agent_settled').length >= 1, 'the reply to settle');
    await ctx.restart(`Quit; model-config.json: ${ctx.first.id} keys → [${spareRef(ctx.first.id)}] (the ciphertext `
      + 'backed up before the start); start again');
    await d.start();
    const opened = await d.cmd({ type: 'session.open', sessionFile: s.sessionFile });
    await d.say(opened, PROMPTS.ONE_LINE_2);
  },
  check(steps, ctx) {
    const before = partOf(steps, 'before');
    const after = partOf(steps, 'after');
    const s = values(before, 'session.create')[0];
    const id = s?.sessionId;
    const sw = eventsOf(before, id, 'mori.model_switch');
    const switchAt = before.findIndex((x) => x.envelope?.sessionId === id
      && x.envelope.event.type === 'mori.model_switch');
    const toolsBefore = before.slice(0, Math.max(0, switchAt)).filter((x) => x.envelope?.sessionId === id
      && x.envelope.event.type === 'tool_execution_end').length;
    const opened = values(after, 'session.open')[0];
    const reopened = opened?.sessionId ?? id;
    const entries = (opened?.entries ?? []).filter((e) => e.type === 'custom' && e.customType === 'mori.model_switch');
    return [...common(steps), ...need(after.length > 0, 'no restart'),
      ...need(sw.length === 1, `${sw.length} switch events`), ...switchProblems(sw[0], ctx, true),
      ...need(toolsBefore >= 1, `${toolsBefore} tool results before the switch`),
      ...need(replyRefs(before, id).at(-1) === ctx.secondRef, `replies before ${replyRefs(before, id)}`),
      ...need(errorReplies(before, id).length === 0, 'an error reply was recorded'),
      ...need(opened?.pick === TEST_GROUP, `reopened pick ${opened?.pick}`),
      ...need(entries.length === 1, `${entries.length} mori.model_switch entries in the reopened session`),
      ...need(eventsOf(after, reopened, 'mori.model_switch').length === 0, 'a switch after the restart'),
      ...need(replyRefs(after, reopened).length > 0 && replyRefs(after, reopened).every((ref) => ref === ctx.firstRef),
        `replies after ${replyRefs(after, reopened)}`)];
  },
};

/** @brief blocked：项目没授权公网，会话被拒绝启动（zone_blocked）；授权后卡消失，可以发送。 */
const blocked = {
  name: 'blocked', layer: 'MP-09, MP-23', authorize: false,
  description: '项目没有授权公网：新会话被拒绝启动（no_candidate，候选都是 zone public is not allowed for this project），'
    + '读一次顶栏菜单（全部变淡）；8 秒后给这个项目授权公网（models.setProjectZones），卡消失，发一句话由首选回答',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    await d.cmd({ type: 'session.pickOptions', sessionId: s.sessionId });
    await d.cmd({ type: 'models.get' });
    await sleep(8000);
    const info = await d.page().evaluate(() => window.mori.request({ type: 'models.get' }));
    const path = info.projects.find((p) => p.path === projectKey(ctx.cwd))?.path ?? projectKey(ctx.cwd);
    await d.direct({ type: 'models.setProjectZones', path, zones: ['public'] },
      `UI: Settings → Models → Project access → ${path}: tick Public and confirm`);
    await d.until((steps) => eventsOf(steps, s.sessionId, 'mori.model_state').some((e) => e.blocked === null),
      'the session to be unblocked', 60000);
    await d.say(s, PROMPTS.ONE_LINE);
  },
  check(steps, ctx) {
    const s = values(steps, 'session.create')[0];
    const card = s?.blocked;
    const options = values(steps, 'session.pickOptions')[0]?.options ?? [];
    return [...common(steps), ...need(card?.kind === 'no_candidate', `blocked ${card?.kind}`),
      ...need((card?.candidates ?? []).length > 0 && card.candidates.every((c) => c.reason === 'zone_blocked'),
        `candidates ${JSON.stringify(card?.candidates)}`),
      ...need(card?.zone === 'public', `zone ${card?.zone}`),
      ...need(['allow_zone', 'change_model', 'open_settings'].every((a) => card?.actions?.includes(a)),
        `actions ${card?.actions}`),
      ...need(options.length > 0 && options.every((o) => o.excluded), 'every menu item excluded'),
      ...need(eventsOf(steps, s?.sessionId, 'mori.model_state').some((e) => e.blocked === null), 'never unblocked'),
      ...need(replyRefs(steps, s?.sessionId).at(-1) === ctx.firstRef, `replies ${replyRefs(steps, s?.sessionId)}`)];
  },
};

/** @brief range：顶栏选提供商、选模型，各回答一句；重启后打开会话，范围沿用。 */
const range = {
  name: 'range', layer: 'MP-23',
  description: '新会话（默认范围是分组）先在顶栏选第二个提供商、问一句，再选首选提供商的第一个模型、问一句；'
    + '重启后打开这个会话，范围仍是那个模型',
  async run(d, ctx) {
    await d.start();
    const s = await d.create(ctx.cwd);
    await d.cmd({ type: 'session.pickOptions', sessionId: s.sessionId });
    await d.cmd({ type: 'session.setPick', sessionId: s.sessionId, pick: ctx.second.id });
    await d.say(s, PROMPTS.WHICH);
    await d.cmd({ type: 'session.pickOptions', sessionId: s.sessionId });
    await d.cmd({ type: 'session.setPick', sessionId: s.sessionId, pick: ctx.firstRef });
    await d.say(s, PROMPTS.ONE_LINE_2);
    await ctx.restart('Quit and start again (no configuration change)');
    await d.start();
    const opened = await d.cmd({ type: 'session.open', sessionFile: s.sessionFile });
    await d.cmd({ type: 'session.pickOptions', sessionId: opened.sessionId });
  },
  check(steps, ctx) {
    const before = partOf(steps, 'before');
    const s = values(before, 'session.create')[0];
    const picks = values(before, 'session.setPick');
    const refs = replyRefs(before, s?.sessionId);
    const opened = values(partOf(steps, 'after'), 'session.open')[0];
    return [...common(steps), ...need(s?.pick === TEST_GROUP && s?.current === ctx.firstRef,
      `new session ${s?.pick} · ${s?.current}`),
    ...need(picks[0]?.pick === ctx.second.id && picks[0]?.current === ctx.secondRef,
      `first pick ${JSON.stringify(picks[0])}`),
    ...need(picks[1]?.pick === ctx.firstRef && picks[1]?.current === ctx.firstRef,
      `second pick ${JSON.stringify(picks[1])}`),
    ...need(refs[0] === ctx.secondRef && refs.at(-1) === ctx.firstRef, `replies ${refs}`),
    ...need(opened?.pick === ctx.firstRef, `reopened pick ${opened?.pick}`)];
  },
};

/**
 * @brief thinking：首选模型在 Models 里标"支持思考"（models.saveModel 录进命令序列，同 m6-record.mjs：m6-replay.mjs 照它
 *        在设置页里勾选），顶栏切到 high 有思考内容，切到 off 没有（§14.4，取代 m6/thinking.json）。
 */
const thinking = {
  name: 'thinking', layer: 'MP-37',
  description: '在 Models 里把首选提供商的第一个模型标为支持思考（新会话默认"中"，等探针重新跑完）；新会话在顶栏切到 high，'
    + '问一道要推理的题，回复带思考内容；切到 off 再问一道，回复没有思考内容',
  async run(d, ctx) {
    const info = await d.start();
    const model = info.config.providers.find((item) => item.id === ctx.first.id).models[0];
    const before = info.profiles[ctx.firstRef]?.probedAt ?? null;
    // 保存之后不再录 models.get：回放时界面保存后读到的仍是保存前的配置（回放桥直接应答写命令，同 m6-record.mjs）。
    await d.cmd({ type: 'models.saveModel', providerId: ctx.first.id, adding: false,
      model: { ...model, reasoning: true }, thinkingLevel: 'medium' });
    if (!model.reasoning) await waitReprobe(d.page(), ctx.firstRef, before);
    const s = await d.create(ctx.cwd);
    await d.cmd({ type: 'session.setThinking', sessionId: s.sessionId, level: 'high' });
    await d.say(s, PROMPTS.REASON_1);
    await d.cmd({ type: 'session.setThinking', sessionId: s.sessionId, level: 'off' });
    await d.say(s, PROMPTS.REASON_2);
  },
  check(steps, ctx) {
    const s = values(steps, 'session.create')[0];
    const saved = steps.find((step) => step.command?.type === 'models.saveModel')?.command;
    const replies = eventsOf(steps, s?.sessionId, 'message_end').map((e) => e.message)
      .filter((m) => m.role === 'assistant' && textOf(m));
    return [...common(steps), ...need(saved?.model.reasoning === true && saved.thinkingLevel === 'medium',
      'models.saveModel (reasoning, medium) recorded'),
    ...need(s?.reasoning === true && s?.thinkingLevel === 'medium' && s?.current === ctx.firstRef,
      `new session reasoning ${s?.reasoning} at ${s?.thinkingLevel} on ${s?.current}`),
    ...need(thinkingOf(replies[0]).length > 0, 'thinking at high'),
    ...need(replies[1] && !thinkingOf(replies[1]), 'no thinking at off')];
  },
};

/** @brief 等 ref 的探针在改动后重新跑完（经 window.mori 读 models.get，不进录制）。 */
async function waitReprobe(page, ref, before) {
  const deadline = Date.now() + 600000;
  for (;;) {
    const info = await page.evaluate(() => window.mori.request({ type: 'models.get' }));
    const profile = info.profiles[ref];
    if (profile && profile.status !== 'probing' && profile.probedAt !== before) return;
    if (Date.now() > deadline) throw new Error(`Probes for ${ref} did not finish after the change`);
    await sleep(2000);
  }
}

/** 录制的场景 */
const scenarios = [switchStart, switchMid, blocked, range, thinking];

// ---------- 执行 ----------

/** @brief 启动 Mori，装好录制器（offset：重启后接着重启前最后一步的时间往后算）。 */
async function startMori(state, offset = 0) {
  state.app = await launch({ exePath, userData: state.userData });
  state.page = await state.app.firstWindow();
  await state.page.waitForFunction(() => Boolean(window.mori));
  await state.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
  await state.page.evaluate(installRecorder, offset);
}

/** @brief 重启：记下重启前的步骤，退出，恢复首选的 key（只有 switch-mid 要），再启动。 */
async function restartMori(state, ctx, note) {
  const steps = await state.page.evaluate(() => window.__rec.steps);
  const last = steps.at(-1)?.t ?? 0;
  state.kept.push(...steps, { t: last, note: `Restart: ${note}` }, { t: last, restart: true });
  await state.app.close();
  if (ctx.restoreOnRestart) restoreFirstKey(state.userData, ctx.first.id, ctx.cipher);
  await startMori(state, last);
}

/** @brief 一个场景：新的数据目录与项目，准备配置，等探针，录制，核对后写出 fixture（不符合时写到 rejected）。 */
async function recordScenario(scenario, found) {
  const made = prepareProject('mori-v1-record-');
  const cwd = join(made.root, `v1-${scenario.name}`);
  rmSync(cwd, { recursive: true, force: true });
  renameSync(made.project, cwd);
  const userData = scratchModelData(source);
  const state = { userData, app: null, page: null, kept: [] };
  const ctx = { ...found, firstRef: `${found.first.id}/${found.first.models[0].id}`,
    secondRef: `${found.second.id}/${found.second.models[0].id}`, cwd, state, notes: [],
    restoreOnRestart: scenario === switchMid };
  ctx.restart = (note) => restartMori(state, ctx, note);
  try {
    ctx.cipher = prepareRealConfig(userData, found, scenario.authorize === false ? [] : [cwd]);
    const access = scenario.authorize === false ? 'the project is NOT allowed public' : 'the project is allowed public';
    ctx.notes.push(`Setup (synthetic test setup, spec §14.1): copied the encrypted data files; group ${TEST_GROUP} = `
      + `[${found.first.id}, ${found.second.id}] is the default range; ${access}; the ciphertext of `
      + `${found.first.id}'s first key was copied to ${spareRef(found.first.id)}`);
    await startMori(state);
    const d = driver(state);
    await waitProfiles(state.page, [ctx.firstRef, ctx.secondRef]);
    await state.page.evaluate(() => { window.__rec.steps = []; window.__rec.t0 = performance.now(); });
    await scenario.run(d, ctx);
    await sleep(500);
    const steps = [...state.kept, ...(await d.steps())];
    writeFixture(scenario, ctx, steps);
  } catch (error) {
    console.error(`FAIL recording ${scenario.name}: ${oneLine(error, 600)}`);
    process.exitCode = 1;
  } finally {
    await state.app?.close().catch(() => {});
    for (const dir of [userData, made.root]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch (error) {
        console.error(`cannot remove ${dir}: ${oneLine(error)}`);
      }
    }
  }
}

/** @brief 核对后写出 fixture；不符合时写到 test-results/v1-models-record/<名字>.rejected.json。 */
function writeFixture(scenario, ctx, steps) {
  const fixture = { source: 'real', note: 'Recorded from a real session by tests/ui/v1-models-record.mjs; do not edit '
    + 'by hand. Faults are real (a wrong key entered in the UI → HTTP 401), see notes.', name: scenario.name,
  description: scenario.description, covers: scenario.layer, endpoint: ctx.first.baseUrl, model: ctx.firstRef,
  models: { first: ctx.firstRef, second: ctx.secondRef, group: TEST_GROUP }, notes: ctx.notes,
  recordedAt: new Date().toISOString(), steps };
  const problems = scenario.check(steps, ctx);
  // 界面里填的错 key 只该出现在说明（note）里，不该出现在后台进程给出的结果和事件里。
  const leaked = steps.some((step) => !step.note && JSON.stringify(step).includes(WRONG_KEY))
    ? ['the key entered in the UI appears in a recorded result or event'] : [];
  const all = [...problems, ...leaked];
  const dir = all.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${all.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  const summary = `${steps.length} steps, ${steps.filter((s) => s.envelope).length} events`;
  if (all.length) {
    console.log(`FAIL ${scenario.name}: ${all.join('; ')} — ${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`RECORDED ${scenario.name}: ${summary}`);
  }
}

if (!source) throw new Error('Missing --source <Mori v1 user data dir with the two real providers>');
const problems = sourceProblems(source);
if (problems.length) throw new Error(problems.join('; '));
const found = findRealProviders(readJson(join(source, 'model-config.json')), { first: arg('first'),
  second: arg('second') });
console.log(`[v1-models-record] first ${found.first.id}/${found.first.models[0].id}, `
  + `second ${found.second.id}/${found.second.models[0].id}`);
for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordScenario(scenario, found);
}
