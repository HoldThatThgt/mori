// 从真实的 App 对合成端点录制记忆回放用的 fixture（tests/fixtures/mem/*.json；docs/specs/memory.md §14.1 的回放层、
// §0 第 4 条：这台机器没有带 key 的数据目录，回放的 fixture 从真实的 App 对合成端点录制，source 为 synthetic）。
// 做法同 tb-record.mjs：页面里的录制器直接通过 window.mori（与界面相同的进程桥）发命令，命令的写法与界面发出的相同
// （state/projects.ts 的 trust.check 后 session.create、state/memory.ts 的 memory.* 与 enhance.*、MemoryEnhance.tsx 的
// 设置对话框），记下命令、结果和后台进程转发的全部事件及其时间。
// 界面在记忆页上发的只读查询（memory.list、memory.get、memory.revisions、enhance.get）由录制器照 state/memory.ts 的取法
// 补发：进入页面、换层、换分节、选中、写入之后、详情里的 [[slug]]；收到 mori.memory_changed、mori.enhance_progress 时按
// 界面的规则重读（进度之后等 300 毫秒再读，后台进程在那之前已放下跑完的那一项）。回放桥按参数配对回答它们
// （harness/replay.js 的 KEYED）。
// 准备（synthetic test setup）：model-config.json 只有一个本机地址的提供商 MEM（fake-coder；fake-think 标支持思考；
// fake-coder-404，合成端点对它回 404），默认范围 mem/fake-coder，档案直接给出已验证（tb-helpers.mjs seedTeamUserData，
// 跳过探针）；增强会话的回复来自增强脚本（FAKE_ENHANCE_SCRIPT，tests/fake-endpoint/enhance.mjs，synthetic），依据是录制里
// 那个会话的会话文件与你那条消息的条目 id；mem-settings 另有一个 enhance.json 写坏的项目（synthetic）。用户会话的回复全部
// 来自合成端点的关键词（plain、call tool: memory {…}，tests/fake-endpoint/server.mjs 开头）。
//   mem-tool（MEM-10）：主 Agent 用 memory 记事实（本项目、用户级）、记 TASTE 规则、改事实、一次被拒绝的调用、删 TASTE；
//     每次之后照 View in Memory 读记忆页；重启后打开同一个会话，再照两张卡读（删掉的那条读到 null）。
//   mem-page（MEM-14、MEM-30）：记忆页新增三条事实（第三条的 Details 链到第二条）、改第二条、删第一条、把第二条提升到
//     用户级、在用户级 Revisions 回滚这次移动；最后一段只有查询：换分节、打开两条、修订列表与一次修订。
//   mem-settings（MEM-17）：打开增强、设置对话框保存四项、关掉再打开；enhance.json 写坏的项目：开关与保存都失败；
//     每个 EnhanceInfo 的 effortPicks 里 fake-coder、fake-coder-404 为假，fake-think 为真（§8，Effort 的回放检查用）。
//   mem-enhance（MEM-25、MEM-30）：打开增强，在 Revisions 上 Run now（TASTE 加一条，另两种没有改动）；再 Run now（没有
//     新内容，全部跳过）；设置里换成 fake-coder-404、发一条消息、Run now（三种都失败）。
//   mem-notice（MEM-26）：增强加了一条之后新建会话（带提示）、照 View 读、再新建（没有提示）；再发消息、Run now（TASTE 与
//     STRATEGY 各加一条），再新建会话（提示是两次之和）。
//   mem-feedback（MEM-27）：开了增强的项目与没开的项目各有一条回复，录下反馈表单要的 enhance.get。
// 录完先核对场景要的东西真的发生了（check）；不符合时不写进 fixtures，写到 test-results/mem-record/<名字>.rejected.json。
// 用法（在 app/ 下，out/ 是当前的构建；MORI_APP_DIR 可指向别的构建）：
//   node tests/ui/mem-record.mjs [--only mem-tool,mem-page] [--out <目录>]
// 端口：4770（合成端点；§14.1 的 4700–4799 里本脚本用 4770–4779）。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import { seedTeamUserData, tbModel, tbProvider, tempUserData } from './tb-helpers.mjs';
import { baseOf, startEndpoint, stopEndpoint } from './v1-switch-helpers.mjs';

const only = arg('only')?.split(',');
const outDir = arg('out') ? resolve(arg('out')) : join(appRoot, 'tests/fixtures/mem');
const rejectedDir = join(appRoot, 'test-results/mem-record');
/** 合成端点的端口 */
const PORT = 4770;
/** 提供商、默认范围与另两个模型（synthetic test setup） */
const PROVIDER = 'mem';
const MODEL = `${PROVIDER}/fake-coder`;
const THINK_MODEL = `${PROVIDER}/fake-think`;
const BROKEN_MODEL = `${PROVIDER}/fake-coder-404`;
/** 等一件事的时限 */
const WAIT_MS = 120000;

// ---------- 页面里的录制器 ----------

/**
 * @brief 页面里的录制器（同 tb-record.mjs）：记录命令、结果和事件；turn_end 后读一次 session.state。rec.view 是界面此刻
 *        在记忆页上的位置（{ cwd, layer, section, entry, revision }，不在记忆页时为 null）：收到全局事件时照
 *        state/memory.ts 的 memoryChanged / enhanceProgress 重读。命令一条接一条发（上一条有了结果才发下一条）：
 *        回放桥把结果配给它之前最近一条同类型命令，两条同类型的查询交错时会配错。
 */
function installRecorder(offset) {
  const rec = {
    t0: performance.now() - offset,
    steps: [],
    view: null,
    chain: Promise.resolve(),
    log(entry) { this.steps.push({ t: Math.round(performance.now() - this.t0), ...entry }); },
    cmd(command) {
      const send = async () => {
        this.log({ command });
        try {
          const result = await window.mori.request(command);
          this.log({ result: { type: command.type, value: result } });
          return result;
        } catch (error) {
          this.log({ result: { type: command.type, error: error.message } });
          throw error;
        }
      };
      const sent = this.chain.then(send, send);
      this.chain = sent.catch(() => {});
      return sent;
    },
  };
  window.mori.onEvent((envelope) => {
    rec.log({ envelope });
    if (envelope.event.type === 'turn_end') {
      void rec.cmd({ type: 'session.state', sessionId: envelope.sessionId }).catch(() => {});
    }
    if (envelope.sessionId === null && rec.view) void rec.reread?.(envelope.event, { ...rec.view }).catch(() => {});
  });
  window.__rec = rec;
}

/**
 * @brief 页面里：录制器收到全局事件时的重读（window.__rec.reread），照 state/memory.ts：mori.enhance_progress 在看同一个
 *        项目时读 enhance.get（等 300 毫秒）；mori.memory_changed 改到当前分节时读列表或修订列表，再读开着的右栏。
 */
function installReread() {
  const rec = window.__rec;
  rec.reread = async (event, view) => {
    const listCwd = view.layer === 'user' ? null : view.cwd;
    if (event.type === 'mori.enhance_progress') {
      if (view.layer !== 'project' || event.cwd !== view.cwd) return;
      await new Promise((done) => setTimeout(done, 300));
      await rec.cmd({ type: 'enhance.get', cwd: view.cwd });
      return;
    }
    if (event.type !== 'mori.memory_changed' || view.section === 'agent') return;
    const touches = (layer) => event.layers.includes(layer) && (layer === 'user' || event.cwd === view.cwd);
    const kind = view.section !== 'revisions';
    const hit = kind ? event.kinds.includes(view.section)
      && (touches(view.layer) || (view.layer === 'project' && touches('user'))) : touches(view.layer);
    if (!hit) return;
    await rec.cmd(kind ? { type: 'memory.list', cwd: listCwd, layer: view.layer, kind: view.section }
      : { type: 'memory.revisions', cwd: listCwd, layer: view.layer });
    if (view.entry) await rec.cmd({ type: 'memory.get', cwd: view.cwd, layer: view.layer, id: view.entry });
    if (view.revision) await rec.cmd({ type: 'memory.revisions', cwd: listCwd, layer: view.layer, id: view.revision });
  };
}

/** @brief 一个场景运行时的操作（node 这边驱动页面里的录制器）。 */
function driver(state) {
  const page = () => state.page;
  const d = {
    page,
    cmd: (command) => page().evaluate((c) => window.__rec.cmd(c), command),
    steps: () => page().evaluate(() => window.__rec.steps),
    count: (sessionId, type) => page().evaluate(({ id, kind }) => window.__rec.steps
      .filter((s) => s.envelope?.sessionId === id && s.envelope.event.type === kind).length,
    { id: sessionId, kind: type }),
    /** 等 fn() 为真 */
    async until(fn, what, timeout = WAIT_MS) {
      const deadline = Date.now() + timeout;
      while (!(await fn())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(250);
      }
    },
    /** 像界面一样新建会话：先 trust.check（临时项目没有要信任的内容），再 session.create */
    async create(cwd) {
      await d.cmd({ type: 'trust.check', cwd });
      return d.cmd({ type: 'session.create', cwd });
    },
    /** 发一条消息，等这一次运行结束（agent_settled） */
    async say(session, text) {
      const before = await d.count(session.sessionId, 'agent_settled');
      await d.cmd({ type: 'session.prompt', sessionId: session.sessionId, text });
      await d.until(async () => (await d.count(session.sessionId, 'agent_settled')) > before,
        `${session.sessionId} to settle`);
      await sleep(300);
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

// ---------- 记忆页的读取（照 state/memory.ts） ----------

/** 详情正文里到别的条目的链接（同 MemoryDetail.tsx） */
const LINK = /\[\[([^\]\n]+)\]\]/g;

/** @brief 详情正文里 [[slug]] 指向的条目（MemoryDetail.tsx resolveLink）：同层先找，找不到再找另一层。 */
async function readLinks(d, view, details) {
  const { cwd, layer } = view;
  for (const slug of new Set([...details.matchAll(LINK)].map((m) => m[1].trim()))) {
    const layers = layer === 'project' ? ['project', 'user'] : cwd ? ['user', 'project'] : ['user'];
    for (const target of layers) {
      if ((await d.cmd({ type: 'memory.get', cwd, layer: target, id: slug })).entry) break;
    }
  }
}

/**
 * @brief 记忆页的读取：位置记在页面里的录制器上（事件之后的重读也按它），每一步发界面会发的只读查询。
 *        memory.get 的 cwd 是跟随的项目（用户级也是，state/memory.ts loadDetail），列表与修订的 cwd 在用户级为 null。
 *        enter / go / after 返回 { section（分节的结果）, detail（右栏的结果或 null）, enhance（读了时） }。
 */
function memoryPage(d) {
  const ui = { view: null };
  const listCwd = () => (ui.view.layer === 'user' ? null : ui.view.cwd);
  const setView = async (view) => {
    ui.view = view;
    await d.page().evaluate((v) => { window.__rec.view = v; }, view);
  };
  const readSection = () => {
    const { layer, section } = ui.view;
    if (section === 'revisions') return d.cmd({ type: 'memory.revisions', cwd: listCwd(), layer });
    return d.cmd({ type: 'memory.list', cwd: listCwd(), layer, kind: section });
  };
  /** @brief 右栏：条目（memory.get，再读正文里 [[slug]] 指向的条目）或修订（memory.revisions 带 id）。 */
  const readDetail = async () => {
    const { cwd, layer, entry, revision } = ui.view;
    if (revision) return d.cmd({ type: 'memory.revisions', cwd: listCwd(), layer, id: revision });
    if (!entry) return null;
    const result = await d.cmd({ type: 'memory.get', cwd, layer, id: entry });
    await readLinks(d, ui.view, result.entry?.details ?? '');
    return result;
  };
  const enhance = () => (ui.view.layer === 'project' ? d.cmd({ type: 'enhance.get', cwd: ui.view.cwd }) : null);
  Object.assign(ui, {
    /** 进入记忆页（左栏 Memory，或 View in Memory 的落点）：清空并读分节、右栏，Project 时读增强 */
    async enter(view) {
      await setView({ entry: null, revision: null, ...view });
      return { section: await readSection(), detail: await readDetail(), enhance: await enhance() };
    },
    /** 换层、换分节、选中（patch 里给出变了的部分；右栏换成 patch 的 entry 或 revision） */
    async go(patch) {
      const rescoped = patch.layer !== undefined && patch.layer !== ui.view.layer;
      const moved = rescoped || (patch.section !== undefined && patch.section !== ui.view.section);
      await setView({ ...ui.view, entry: null, revision: null, ...patch });
      const section = moved ? await readSection() : null;
      return { section, detail: await readDetail(), enhance: rescoped ? await enhance() : null };
    },
    /** 写入之后（state/memory.ts afterWrite）：右栏换成 patch 给的，重读分节与右栏 */
    async after(patch = {}) {
      await setView({ ...ui.view, entry: null, revision: null, ...patch });
      return { section: await readSection(), detail: await readDetail(), enhance: null };
    },
    /** 离开记忆页（Back to app 等）：之后的事件不再引起重读 */
    leave: () => setView(null),
  });
  return ui;
}

// ---------- 会话文件、增强脚本（synthetic） ----------

/** @brief 会话文件里你的消息：{ id, text }，按顺序。 */
function userMessages(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((entry) => entry?.type === 'message' && entry.message?.role === 'user').map((entry) => ({
    id: entry.id, text: typeof entry.message.content === 'string' ? entry.message.content
      : entry.message.content.map((part) => part.text ?? '').join('') }));
}

/** @brief 增强脚本的一步（synthetic）：用 memory 存一条，依据是 session 文件里你的那条消息 message。 */
function saveStep(abstract, session, message) {
  return { wait: 800, call: 'memory', args: { action: 'save', abstract,
    detail: 'Synthetic entry written by the enhancement script of tests/ui/mem-record.mjs.',
    evidence: [{ session, entry: message.id, quote: message.text.slice(0, 120) }] } };
}

/** @brief 增强脚本最后的回复（这次运行的 Notes）。 */
const sayStep = (text) => ({ wait: 400, say: text });

/** @brief 没有改动的一次运行：只回一句话（synthetic）。 */
const quiet = (kind) => [{ wait: 600, say: `No ${kind} changes from this material.` }];

/** @brief 写增强脚本文件（enhance.mjs 每次请求时重新读）：{ taste, strategy, review } 各一串步骤。 */
function writeScript(ctx, script) {
  writeFileSync(ctx.script, `${JSON.stringify(script, null, 2)}\n`);
}

/**
 * @brief 等这个项目在第 from 步之后的 count 个任务都结束（mori.enhance_progress 的 done、skipped、failed），再等录制器的
 *        重读落下。
 * @return 这些结束的进度事件
 */
async function waitRun(d, cwd, from, count = 3) {
  const ends = async () => (await d.steps()).slice(from).map((s) => s.envelope?.event)
    .filter((e) => e?.type === 'mori.enhance_progress' && e.cwd === cwd
      && ['done', 'skipped', 'failed'].includes(e.phase));
  await d.until(async () => (await ends()).length >= count, `${count} enhancement tasks to end in ${cwd}`);
  await sleep(1500);
  return ends();
}

/** @brief Run now（enhance.run）：等三个任务都结束，再像界面一样读一次增强状态与当前分节、右栏。 */
async function runNow(d, ui, cwd) {
  const from = (await d.steps()).length;
  await d.cmd({ type: 'enhance.run', cwd });
  const ends = await waitRun(d, cwd, from);
  await d.cmd({ type: 'enhance.get', cwd });
  if (ui.view) await ui.after({ entry: ui.view.entry, revision: ui.view.revision });
  return ends;
}

/** @brief 发一条 call tool: memory 消息，等它结束，返回这次调用的 details（被拒绝时为 null）。 */
async function callMemory(d, session, args) {
  await d.say(session, `call tool: memory ${JSON.stringify(args)}`);
  const end = (await d.steps()).filter((s) => s.envelope?.sessionId === session.sessionId
    && s.envelope.event.type === 'tool_execution_end' && s.envelope.event.toolName === 'memory').at(-1);
  return end && !end.envelope.event.isError ? end.envelope.event.result.details : null;
}

/** @brief 最后一个 enhance.get 结果（录制器里），给设置对话框的初值用。 */
async function lastInfo(d, cwd) {
  const steps = await d.steps();
  const step = steps.findLast((s, i) => s.result?.type === 'enhance.get' && s.result.value?.cwd === cwd
    && steps.slice(0, i).findLast((x) => x.command?.type === 'enhance.get')?.command.cwd === cwd);
  return step.result.value;
}

// ---------- 场景 ----------

/** mem-tool 里 memory 工具的参数（合成端点按 call tool: memory {…} 调用它） */
const TOOL = {
  fact: { action: 'save', kind: 'fact', abstract: 'The intranet model is at 10.0.0.9',
    quote: 'the intranet model is at 10.0.0.9, note it', asked: true },
  user: { action: 'save', kind: 'fact', layer: 'user', abstract: 'The user writes British English',
    quote: 'I always write British English, remember that for every project', asked: true },
  taste: { action: 'save', kind: 'taste', abstract: 'Start every answer with the conclusion',
    quote: 'from now on, start every answer with the conclusion', asked: true },
  update: (entry) => ({ action: 'update', entry, abstract: 'The intranet model is at 10.0.0.10',
    note: 'The address changed', quote: 'the intranet model moved to 10.0.0.10' }),
  refused: { action: 'save', kind: 'taste', layer: 'user', abstract: 'Keep commit messages short',
    quote: 'keep commit messages short in every project', asked: true },
  forget: (entry) => ({ action: 'forget', entry, note: 'The user withdrew the rule' }),
  // 2026-10-26（记忆规格 §0 第 5 条）：没被要求时主动记的（不给 asked），记忆页标 Added by Mori
  stated: { action: 'save', kind: 'fact', abstract: 'Staging runs PostgreSQL 15',
    quote: 'our staging database runs PostgreSQL 15' },
};

/** @brief mem-tool 重启前：七次调用（一次被拒绝），成功的每次之后照 View in Memory 读记忆页。 */
async function toolBefore(d, ui, cwd) {
  const s = await d.create(cwd);
  const fact = await callMemory(d, s, TOOL.fact);
  await ui.enter({ cwd, layer: 'project', section: 'fact', entry: fact.entry });
  await ui.leave();
  const user = await callMemory(d, s, TOOL.user);
  await ui.enter({ cwd, layer: 'user', section: 'fact', entry: user.entry });
  await ui.leave();
  const taste = await callMemory(d, s, TOOL.taste);
  await ui.enter({ cwd, layer: 'project', section: 'taste', entry: taste.entry });
  await ui.leave();
  await callMemory(d, s, TOOL.update(fact.entry));
  await ui.enter({ cwd, layer: 'project', section: 'fact', entry: fact.entry });
  await ui.leave();
  await callMemory(d, s, TOOL.refused);
  const forget = await callMemory(d, s, TOOL.forget(taste.entry));
  await ui.enter({ cwd, layer: 'project', section: 'revisions', revision: forget.revision });
  await ui.leave();
  const stated = await callMemory(d, s, TOOL.stated);
  await ui.enter({ cwd, layer: 'project', section: 'fact', entry: stated.entry });
  await ui.leave();
  return { s, fact, taste };
}

/** @brief 主动记的那条（TOOL.stated）读回为 Mori 记的：记忆页读到的 memory.get 里它的 source 是 agent（§6.4）。 */
function agentSaved(steps) {
  return values(steps, 'memory.get').some((value) => value?.entry?.abstract === TOOL.stated.abstract
    && value.entry.source === 'agent');
}

/** @brief mem-tool：MEM-10 的对话里记、View in Memory、重新打开后卡片仍有按钮。 */
const toolScenario = {
  name: 'mem-tool', covers: 'MEM-10',
  description: 'The main agent (off mode, Ask each time) calls the memory tool seven times through the synthetic '
    + 'endpoint: save a fact (this project), save a fact at user level, save a TASTE rule (these three as asked), '
    + 'update the fact, a refused call (a TASTE rule at user level), delete the TASTE rule and save a fact on its own '
    + '(no asked: added by Mori). After each successful call the Memory page reads what View in Memory opens. Mori '
    + 'restarts, the session is opened again and two cards are followed again (the deleted TASTE entry reads as '
    + 'null).',
  async run(d, ctx) {
    const ui = memoryPage(d);
    await d.start();
    const { s, fact, taste } = await toolBefore(d, ui, ctx.cwd);
    await ctx.restart('Quit and start again (no configuration change)');
    await d.start();
    await d.cmd({ type: 'trust.check', cwd: ctx.cwd });
    await d.cmd({ type: 'session.open', sessionFile: s.sessionFile });
    await ui.enter({ cwd: ctx.cwd, layer: 'project', section: 'fact', entry: fact.entry });
    await ui.leave();
    await ui.enter({ cwd: ctx.cwd, layer: 'project', section: 'taste', entry: taste.entry });
  },
  check(steps) {
    const before = partOf(steps, 'before');
    const after = partOf(steps, 'after');
    const id = values(before, 'session.create')[0]?.sessionId;
    const ends = before.filter((s) => s.envelope?.sessionId === id && s.envelope.event.type === 'tool_execution_end'
      && s.envelope.event.toolName === 'memory').map((s) => s.envelope.event);
    const gates = before.filter((s) => s.envelope?.event.type === 'mori.tool_gate').map((s) => s.envelope.event.gate);
    const opened = values(after, 'session.open')[0];
    const results = (opened?.entries ?? []).filter((e) => e.type === 'message' && e.message.role === 'toolResult'
      && e.message.toolName === 'memory');
    return [...common(before), ...need(failures(after).length === 0, `failed after: ${failures(after)}`),
      ...need(JSON.stringify(ends.map((e) => Boolean(e.isError))) === '[false,false,false,false,true,false,false]',
        `memory calls ${JSON.stringify(ends.map((e) => [e.isError, e.result?.details?.action]))}`),
      ...need(gates.length > 0 && gates.every((gate) => gate === 'free'), `tool gates ${gates}`),
      ...need(results.filter((r) => r.message.details?.revision).length === 6,
        `reopened memory results ${results.length}`),
      ...need(agentSaved(before), 'the last save (no asked) did not read back as added by Mori')];
  },
};

/** mem-page 的三条事实（第三条的 Details 链到第二条，§3.2 的 [[slug]]） */
const PAGE = {
  a1: 'The staging server is staging.internal', d1: 'Use it for manual checks before a release.',
  a2: 'Releases go out on Tuesdays', d2: 'Freeze changes the evening before.',
  a3: 'The release checklist lives in docs/release.md',
  d3: (slug) => `Follow it in order; [[${slug}]] says which day.`,
  a2b: 'Releases go out on Tuesday mornings',
};

/** @brief 记忆页上新增一条（New entry → Save，memory.save 没有 id），返回结果。 */
async function addEntry(d, ui, abstract, detail) {
  const { cwd, layer, section } = ui.view;
  const result = await d.cmd({ type: 'memory.save', cwd: layer === 'user' ? null : cwd, layer, kind: section,
    abstract, detail });
  await ui.after({ entry: result.id });
  return result;
}

/** @brief mem-page 的写入：新增三条、改第二条、删第一条、提升第二条、在用户级回滚这次移动；返回回滚的结果。 */
async function pageWrites(d, ui, cwd) {
  const r1 = await addEntry(d, ui, PAGE.a1, PAGE.d1);
  const r2 = await addEntry(d, ui, PAGE.a2, PAGE.d2);
  await addEntry(d, ui, PAGE.a3, PAGE.d3(r2.id));
  const shown = (await ui.go({ entry: r2.id })).detail;
  await d.cmd({ type: 'memory.save', cwd, layer: 'project', kind: 'fact', id: r2.id, abstract: PAGE.a2b,
    detail: shown.entry.details });
  await ui.after({ entry: r2.id });
  await ui.go({ entry: r1.id });
  await d.cmd({ type: 'memory.delete', cwd, layer: 'project', id: r1.id });
  await ui.after({});
  await ui.go({ entry: r2.id });
  const moved = await d.cmd({ type: 'memory.move', cwd, from: 'project', id: r2.id });
  await ui.after({});
  await ui.go({ layer: 'user' });
  await ui.go({ entry: moved.id });
  await ui.go({ section: 'revisions' });
  await ui.go({ revision: moved.revision });
  const rolled = await d.cmd({ type: 'memory.rollback', cwd, layer: 'user', id: moved.revision });
  await ui.after({ revision: moved.revision });
  return rolled;
}

/** @brief mem-page：MEM-14 的新增、编辑、删除、移动、回滚；MEM-30 的最后一段只有查询。 */
const pageScenario = {
  name: 'mem-page', covers: 'MEM-14, MEM-30',
  description: 'On the Memory page (Project, Facts) three entries are added with New entry (the third one links to '
    + 'the second with [[slug]]), the second is edited, the first deleted, the second moved to user level, and in '
    + 'User → Revisions the move is rolled back. The last segment has only read-only queries: back to Project, '
    + 'Facts, open two entries, TASTE, Facts, Revisions and one revision.',
  async run(d, ctx) {
    const ui = memoryPage(d);
    const cwd = ctx.cwd;
    await d.start();
    await d.create(cwd);
    await ui.enter({ cwd, layer: 'project', section: 'fact' });
    const rolled = await pageWrites(d, ui, cwd);
    await ui.go({ layer: 'project' });
    const facts = (await ui.go({ section: 'fact' })).section.entries;
    for (const entry of [...facts].reverse()) await ui.go({ entry: entry.id });
    await ui.go({ section: 'taste' });
    await ui.go({ section: 'fact' });
    await ui.go({ section: 'revisions' });
    await ui.go({ revision: rolled.revision });
  },
  check(steps) {
    const saves = pairs(steps, 'memory.save');
    const lists = pairs(steps, 'memory.list').filter((p) => p.command.layer === 'project' && p.command.kind === 'fact');
    const last = lists.at(-1)?.value.entries.map((e) => e.abstract);
    const links = pairs(steps, 'memory.get').filter((p) => p.value.backlinks?.length > 0);
    return [...common(steps), ...need(saves.length === 4, `${saves.length} saves`),
      ...need(JSON.stringify(last) === JSON.stringify([PAGE.a3, PAGE.a2b]), `final facts ${JSON.stringify(last)}`),
      ...need(links.length > 0, 'no entry with backlinks was read'),
      ...need(pairs(steps, 'memory.rollback')[0]?.value.error === null, 'rollback failed')];
  },
};

/** @brief mem-settings 写坏的 enhance.json（synthetic）：<userData>/memory/projects/--<编码后的工作目录>--/enhance.json。 */
function breakEnhanceFile(userData, cwd) {
  const key = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const dir = join(userData, 'memory', 'projects', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'enhance.json'), '{ "enabled": tru');
}

/** @brief 离现在 12 小时的时刻 HH:MM（设置对话框改的时刻：录制期间不会到点）。 */
function farTime() {
  const at = new Date(Date.now() + 12 * 3600 * 1000);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** @brief mem-settings：MEM-17 的开关与设置对话框；读不出设置的项目上开关与保存都失败。 */
const settingsScenario = {
  name: 'mem-settings', covers: 'MEM-17', second: 'mem-broken',
  description: 'Project mem-settings: the enhancement switch is turned on (defaults: the default range, 04:00), the '
    + 'settings dialog saves the fake-think model (marked Supports thinking), effort high, team mode and a daily '
    + 'time 12 hours from now; the switch is turned off and on again (the settings stay). Project mem-broken has an '
    + 'unreadable enhance.json (synthetic): the switch and the dialog Save both fail with the read error.',
  prepare(ctx) {
    breakEnhanceFile(ctx.userData, ctx.second);
    ctx.time = farTime();
    ctx.notes.push(`Setup (synthetic): ${ctx.second} has an unreadable enhance.json; the dialog time is ${ctx.time}`);
  },
  async run(d, ctx) {
    const ui = memoryPage(d);
    const cwd = ctx.cwd;
    await d.start();
    await d.create(cwd);
    await ui.enter({ cwd, layer: 'project', section: 'fact' });
    await d.cmd({ type: 'enhance.set', cwd, enabled: true });
    await d.cmd({ type: 'enhance.set', cwd, pick: THINK_MODEL, thinking: 'high', team: true, time: ctx.time });
    await d.cmd({ type: 'enhance.set', cwd, enabled: false });
    await d.cmd({ type: 'enhance.set', cwd, enabled: true });
    await ui.leave();
    await d.create(ctx.second);
    const info = (await ui.enter({ cwd: ctx.second, layer: 'project', section: 'fact' })).enhance;
    await d.cmd({ type: 'enhance.set', cwd: ctx.second, enabled: true });
    await d.cmd({ type: 'enhance.set', cwd: ctx.second, thinking: info.thinking, team: info.team, time: info.time });
  },
  check(steps, ctx) {
    const sets = pairs(steps, 'enhance.set');
    const info = sets.map((p) => p.value.info);
    const gets = pairs(steps, 'enhance.get').map((p) => p.value);
    return [...common(steps, [ctx.second]),
      ...need([...gets, ...info].every((i) => i?.effortPicks?.[MODEL] === false && i.effortPicks[THINK_MODEL] === true
        && i.effortPicks[BROKEN_MODEL] === false), `effortPicks ${JSON.stringify([...gets, ...info]
        .map((i) => i?.effortPicks))}`),
      ...need(gets.some((i) => i.cwd === ctx.second) && gets.every((i) => i.cwd !== ctx.second || i.pick === null),
        'the broken project has a range'),
      ...need(info[0]?.enabled && info[0].pick === MODEL && info[0].time === '04:00', `on ${JSON.stringify(info[0])}`),
      ...need(info[1]?.pick === THINK_MODEL && info[1].thinking === 'high' && info[1].team && info[1].time === ctx.time,
        `saved ${JSON.stringify(info[1])}`),
      ...need(info[2]?.enabled === false && info[3]?.enabled && info[3].pick === THINK_MODEL && info[3].team
        && info[3].time === ctx.time, `off and on ${JSON.stringify(info.slice(2, 4))}`),
      ...need(sets.slice(4).length === 2 && sets.slice(4).every((p) => p.value.error && p.value.info.error),
        `broken project ${JSON.stringify(sets.slice(4).map((p) => p.value.error))}`)];
  },
};

/** 增强加的条目与回复（synthetic） */
const ENH = {
  material: 'plain: I like answers that start with the conclusion.',
  again: 'plain: one more message for the next enhancement run.',
  taste: 'Lead with the conclusion, then the details',
  tasteSay: 'Added one TASTE entry: the user asked for the conclusion first.',
};

/** @brief mem-enhance：MEM-25 的 Run now、进度与状态行（成功、全部跳过、失败）；MEM-30 的 enhance.run 与进度事件。 */
const enhanceScenario = {
  name: 'mem-enhance', covers: 'MEM-25, MEM-30',
  description: 'One session with a plain message; on the Memory page (Project) enhancement is turned on and the '
    + 'Revisions section is open while Run now runs the three tasks for today (TASTE adds one entry with the session '
    + 'as evidence, STRATEGY and REVIEW change nothing). Run now again: nothing new, all three are skipped. The '
    + 'settings dialog then picks fake-coder-404, another message is sent and Run now fails all three (HTTP 404).',
  async run(d, ctx) {
    const ui = memoryPage(d);
    const cwd = ctx.cwd;
    await d.start();
    const s = await d.create(cwd);
    await d.say(s, ENH.material);
    await ui.enter({ cwd, layer: 'project', section: 'fact' });
    await d.cmd({ type: 'enhance.set', cwd, enabled: true });
    await ui.go({ section: 'revisions' });
    writeScript(ctx, { taste: [saveStep(ENH.taste, s.sessionFile, userMessages(s.sessionFile)[0]),
      sayStep(ENH.tasteSay)], strategy: quiet('STRATEGY'), review: quiet('REVIEW') });
    ctx.ends = [await runNow(d, ui, cwd), await runNow(d, ui, cwd)];
    const info = await lastInfo(d, cwd);
    await d.cmd({ type: 'enhance.set', cwd, pick: BROKEN_MODEL, thinking: info.thinking, team: info.team,
      time: info.time });
    await ui.leave();
    await d.say(s, ENH.again);
    await ui.enter({ cwd, layer: 'project', section: 'revisions' });
    ctx.ends.push(await runNow(d, ui, cwd));
  },
  check(steps, ctx) {
    const phases = ctx.ends.map(phasesOf);
    const done = ctx.ends[0].find((e) => e.task === 'taste');
    return [...common(steps),
      ...need(JSON.stringify(phases) === JSON.stringify([['done', 'done', 'done'], ['skipped', 'skipped', 'skipped'],
        ['failed', 'failed', 'failed']]), `phases ${JSON.stringify(phases)}`),
      ...need(Boolean(done?.revision), 'the TASTE run has no revision'),
      ...need(globals(steps, 'mori.enhance_progress').some((e) => e.phase === 'queued'), 'no queued progress')];
  },
};

/** mem-notice 的消息与增强加的条目（synthetic） */
const NOTICE = {
  first: 'plain: please keep replies short.',
  second: 'plain: and mention the main risk before the plan.',
  taste1: 'Keep replies short',
  taste2: 'Mention the main risk first',
  strategy: 'Name the main risk before planning the work',
};

/** @brief mem-notice 第一次：打开增强，Run now（TASTE 加一条）；之后新建两个会话（第一个带提示），照提示的 View 读。 */
async function noticeFirst(d, ui, ctx, s1) {
  const cwd = ctx.cwd;
  await ui.enter({ cwd, layer: 'project', section: 'fact' });
  await d.cmd({ type: 'enhance.set', cwd, enabled: true });
  writeScript(ctx, { taste: [saveStep(NOTICE.taste1, s1.sessionFile, userMessages(s1.sessionFile)[0]),
    sayStep('Added one TASTE entry.')], strategy: quiet('STRATEGY'), review: quiet('REVIEW') });
  await runNow(d, ui, cwd);
  await ui.leave();
  const s2 = await d.create(cwd);
  const revision = s2.memoryNotice?.revisions.at(-1);
  await ui.enter({ cwd, layer: 'project', section: 'revisions', revision });
  await ui.leave();
  await d.create(cwd);
  return revision;
}

/** @brief mem-notice：MEM-26 的新会话提示。 */
const noticeScenario = {
  name: 'mem-notice', covers: 'MEM-26',
  description: 'Enhancement adds one TASTE entry (Run now); the next new session carries the notice and its View is '
    + 'followed; a second new session has none. Another message in the first session and Run now again (TASTE and '
    + 'STRATEGY each add one entry); the next new session carries a notice that sums both revisions.',
  async run(d, ctx) {
    const ui = memoryPage(d);
    const cwd = ctx.cwd;
    await d.start();
    const s1 = await d.create(cwd);
    await d.say(s1, NOTICE.first);
    const revision = await noticeFirst(d, ui, ctx, s1);
    await d.say(s1, NOTICE.second);
    const message = userMessages(s1.sessionFile).at(-1);
    writeScript(ctx, { taste: [saveStep(NOTICE.taste2, s1.sessionFile, message), sayStep('Added one TASTE entry.')],
      strategy: [saveStep(NOTICE.strategy, s1.sessionFile, message), sayStep('Added one STRATEGY entry.')],
      review: quiet('REVIEW') });
    await ui.enter({ cwd, layer: 'project', section: 'revisions', revision });
    await runNow(d, ui, cwd);
    await ui.leave();
    await d.create(cwd);
  },
  check(steps) {
    const notices = values(steps, 'session.create').map((s) => s.memoryNotice);
    const counts = notices.map((n) => (n ? `${n.counts.taste}/${n.counts.strategy}/${n.counts.review}` : null));
    return [...common(steps),
      ...need(JSON.stringify(counts) === JSON.stringify([null, '1/0/0', null, '1/1/0']), `notices ${counts}`),
      ...need(notices[3]?.revisions.length === 2, `last notice ${JSON.stringify(notices[3])}`)];
  },
};

/** mem-feedback 的消息 */
const FEEDBACK = {
  on: 'plain: tell me what this project is for.',
  off: 'plain: what is in this folder?',
};

/** @brief mem-feedback：MEM-27 的反馈表单（开了增强的项目与没开的项目）。 */
const feedbackScenario = {
  name: 'mem-feedback', covers: 'MEM-27', second: 'mem-feedback-off',
  description: 'Project mem-feedback: a plain reply, then enhancement is turned on from the Memory page and the '
    + 'enhance.get the feedback form sends is recorded (on). Project mem-feedback-off: a plain reply and its '
    + 'enhance.get (enhancement off).',
  async run(d, ctx) {
    const ui = memoryPage(d);
    await d.start();
    const s = await d.create(ctx.cwd);
    await d.say(s, FEEDBACK.on);
    await ui.enter({ cwd: ctx.cwd, layer: 'project', section: 'fact' });
    await d.cmd({ type: 'enhance.set', cwd: ctx.cwd, enabled: true });
    await ui.leave();
    await d.cmd({ type: 'enhance.get', cwd: ctx.cwd });
    const s2 = await d.create(ctx.second);
    await d.say(s2, FEEDBACK.off);
    await d.cmd({ type: 'enhance.get', cwd: ctx.second });
  },
  check(steps, ctx) {
    const gets = pairs(steps, 'enhance.get');
    const on = gets.filter((p) => p.command.cwd === ctx.cwd).at(-1)?.value;
    const off = gets.filter((p) => p.command.cwd === ctx.second).at(-1)?.value;
    return [...common(steps), ...need(on?.enabled === true && on.error === null, `on ${JSON.stringify(on)}`),
      ...need(off?.enabled === false && off.error === null, `off ${JSON.stringify(off)}`)];
  },
};

/** 录制的场景 */
const scenarios = [toolScenario, pageScenario, settingsScenario, enhanceScenario, noticeScenario, feedbackScenario];

// ---------- 核对（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
/** @brief 某种命令的结果与它的命令（结果是它之前最近一条同类型命令的），按顺序。 */
function pairs(steps, type) {
  const out = [];
  steps.forEach((step, index) => {
    if (step.result?.type !== type || step.result.error) return;
    const command = steps.slice(0, index).findLast((s) => s.command?.type === type)?.command;
    out.push({ command, value: step.result.value });
  });
  return out;
}
/** @brief 全局事件（某种），按顺序。 */
const globals = (steps, type) => steps.filter((s) => s.envelope?.sessionId === null
  && s.envelope.event.type === type).map((s) => s.envelope.event);
/** @brief 重启前（before）或重启后（after）的步骤；没有重启时 before 是全部。 */
const partOf = (steps, part) => {
  const at = steps.findIndex((s) => s.restart);
  if (at < 0) return part === 'before' ? steps : [];
  return part === 'before' ? steps.slice(0, at) : steps.slice(at + 1);
};
/** @brief 一次运行的三个任务的结束阶段，按 TASTE、STRATEGY、REVIEW。 */
const phasesOf = (ends) => ['taste', 'strategy', 'review'].map((task) => ends.find((e) => e.task === task)?.phase);

/** @brief 有结果之前就又发了一条命令的位置（录制器应当一条接一条发，回放桥按“之前最近一条同类型命令”配对结果）。 */
function overlaps(steps) {
  let pending = null;
  const out = [];
  steps.forEach((step, index) => {
    if (step.restart) pending = null;
    if (step.command) {
      if (pending) out.push(`${pending.type} then ${step.command.type} at ${index}`);
      pending = step.command;
    }
    if (step.result && pending?.type === step.result.type) pending = null;
  });
  return out;
}

/** @brief 共同的要求：开头是会话列表；没有失败的命令；命令不交错；写入类的结果没有 error（allowed 里的工作目录除外）。 */
function common(steps, allowed = []) {
  const first = steps.find((s) => s.command)?.command;
  const writes = ['memory.save', 'memory.delete', 'memory.move', 'memory.rollback', 'enhance.set', 'enhance.run']
    .flatMap((type) => pairs(steps, type)).filter((p) => p.value?.error && !allowed.includes(p.command?.cwd));
  return [...need(first?.type === 'session.list', 'the recording does not start with session.list'),
    ...need(failures(steps).length === 0, `failed commands: ${failures(steps).join('; ')}`),
    ...need(overlaps(steps).length === 0, `overlapping commands: ${overlaps(steps).slice(0, 3)}`),
    ...need(writes.length === 0, `write errors: ${writes.map((p) => `${p.command.type}: ${p.value.error}`)}`)];
}

// ---------- 执行 ----------

/** @brief 启动 Mori，装好录制器（offset：重启后接着重启前最后一步的时间往后算）。 */
async function startMori(state, offset = 0) {
  state.app = await launch({ userData: state.userData });
  state.page = await state.app.firstWindow();
  await state.page.waitForFunction(() => Boolean(window.mori));
  await state.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
  await state.page.evaluate(installRecorder, offset);
  await state.page.evaluate(installReread);
}

/** @brief 重启：记下重启前的步骤，退出，再启动。 */
async function restartMori(state, note) {
  const steps = await state.page.evaluate(() => window.__rec.steps);
  const last = steps.at(-1)?.t ?? 0;
  state.kept.push(...steps, { t: last, note: `Restart: ${note}` }, { t: last, restart: true });
  await state.app.close();
  await startMori(state, last);
}

/** @brief 一个项目文件夹 <root>/<name>（README 与 src/a.ts，lib.mjs prepareProject 的内容）。 */
function projectAt(root, name, made) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  if (made) renameSync(made, dir);
  else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `# ${name}\n\nA second synthetic project for tests/ui/mem-record.mjs.\n`);
  }
  return dir;
}

/** @brief 一个场景的准备：项目、数据目录（模型配置与档案，synthetic）、增强脚本文件、合成端点。 */
async function prepare(scenario) {
  const made = prepareProject('mori-mem-record-');
  const cwd = projectAt(made.root, scenario.name, made.project);
  const second = scenario.second ? projectAt(made.root, scenario.second, null) : null;
  const userData = tempUserData('mori-mem-record-data-');
  const models = [tbModel('fake-coder'), tbModel('fake-think', { reasoning: true }), tbModel('fake-coder-404')];
  seedTeamUserData(userData, { providers: [tbProvider(PROVIDER, PORT, models, { name: 'MEM' })],
    normalDefault: MODEL });
  const script = join(made.root, 'enhance-script.json');
  writeFileSync(script, '{}\n');
  const ctx = { cwd, second, userData, script, root: made.root, logs: [], notes: [`Setup (synthetic test setup, `
    + `docs/specs/memory.md §14.1): model-config.json has one local provider MEM (fake-coder; fake-think marked `
    + `Supports thinking; fake-coder-404) on the synthetic endpoint ${baseOf(PORT)}, default range ${MODEL}, `
    + 'profiles given as verified; enhancement replies come from the synthetic enhancement script '
    + '(FAKE_ENHANCE_SCRIPT)'] };
  scenario.prepare?.(ctx);
  ctx.endpoint = await startEndpoint(PORT, { FAKE_ENHANCE_SCRIPT: script }, ctx.logs);
  return ctx;
}

/** @brief 录一个场景：准备、录制、核对，写出 fixture（不符合时写到 rejected）。 */
async function recordScenario(scenario) {
  const ctx = await prepare(scenario);
  const state = { userData: ctx.userData, app: null, page: null, kept: [] };
  ctx.restart = (note) => restartMori(state, note);
  let steps = [];
  let problems;
  try {
    await startMori(state);
    await state.page.evaluate(() => { window.__rec.steps = []; window.__rec.t0 = performance.now(); });
    await scenario.run(driver(state), ctx);
    await sleep(800);
    steps = [...state.kept, ...(await state.page.evaluate(() => window.__rec.steps))];
    problems = scenario.check(steps, ctx);
  } catch (error) {
    steps = [...state.kept, ...(await state.page?.evaluate(() => window.__rec.steps).catch(() => []) ?? [])];
    problems = [`flow: ${oneLine(error?.stack ?? error, 600)}`];
  } finally {
    await state.app?.close().catch(() => {});
    await stopEndpoint(ctx.endpoint);
    for (const dir of [ctx.userData, ctx.root]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }
  writeFixture(scenario, ctx, steps, problems);
}

/** @brief 写出 fixture；不符合时写到 test-results/mem-record/<名字>.rejected.json。 */
function writeFixture(scenario, ctx, steps, problems) {
  const fixture = { source: 'synthetic', note: 'Recorded from the real App against the synthetic endpoint by '
    + 'tests/ui/mem-record.mjs (docs/specs/memory.md §0 item 4: no data directory with a key on this machine); '
    + 'do not edit by hand.', name: scenario.name, description: scenario.description, covers: scenario.covers,
  endpoint: baseOf(PORT), model: MODEL, notes: ctx.notes, recordedAt: new Date().toISOString(),
  // 录制机器的时区：内核按它算增强的下次运行等时刻，回放按它显示（mem-replay-helpers.mjs 的 useZone）
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, steps };
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

for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordScenario(scenario);
}
