// 回放界面测试的入口：先装好回放进程桥（window.mori），再载入真正的界面（src/renderer/src/main.tsx）。
// ?fixture=<名字>&speed=<倍数>&maxGap=<毫秒>&keepDrafts=1&part=before|after&holdList=1。录制文件来自 tests/fixtures/m1–m6、
// v1、tb、mem（m7 随工作回顾删除，docs/specs/memory.md §14.4）、discovery/ui（docs/specs/model-discovery.md §13.1）与
// finish（docs/specs/finish-check.md §14.1），名字不能重复。part：录制里有一次重启时，取重启前或重启后的一段回放（见
// replay.js 的 partOf）。holdList=1 是测试控制（不改录制的回答）：session.list 的回答等 window.__replay.releaseList()
// （m3-replay 的 loading 看"Loading sessions…"）。
// 每次载入先清掉上一个录制留下的草稿、已归档列表和 UI issues 的已处理标记（localStorage 的 mori.review，记忆规格 §10.8
// 沿用这个键），keepDrafts=1 时保留（测"重启后草稿还在"）。
// synthetic-long-history 是手写拼出的长会话（synthetic），由真实录制的 queue-steer 会话记录重复 15 次得到，
// 只用来测"先显示 50 条、上滚载入更早的"。synthetic-long-steps 是同一份会话记录拼出的一轮 60 次调用（synthetic，见
// longSteps），测被切开的步骤组（2026-10-26 走查 M18）。synthetic-mcp-setup 是 m6 的 mcp 录制前面补一个先打开的会话（synthetic，
// 见 mcpSetup），让界面能照录制的顺序在工具页里添加 MCP 服务。synthetic-mermaid 是 markdown 录制换了回复正文
// （synthetic，见 replyWith），测 mermaid 代码块流式时显示代码、写完画成图（六种图）、画不出来显示代码（语法错误、
// 超过上限）（2026-10-26 走查 M16）。synthetic-mermaid-stop-line / -label 同样由 markdown 录制换了回复正文（synthetic）：
// 回复停在一个 mermaid 代码块中间、以停止结束（结束事件的 stopReason 为 aborted，agent_settled 的 aborted 为真），
// 测"停在代码块中间"按写完处理：截在一整行边之后（-line）画成图，截在节点标签中间（-label）显示代码（2026-10-26 补测）。
// synthetic-code-stream 同样由 markdown 录制换了回复正文（synthetic）：一段短代码块和一段 60 行的长代码块，正文增量
// 改成匀速（每 30ms 一段），长代码块写到第 30、45、60 行时回放各停 2.5 秒，测生成中"Copy code"不可用、长代码块
// 跟着往下滚（2026-10-26 补，U14）。synthetic-openrouter-first-run 是 md-openrouter 录制的 config.get 改成首次启动
// （synthetic，见 openrouterFirstRun），测首次启动表单的清单里取自 pi 模型表的值（2026-10-26，WP-15）。
// synthetic-deepseek-pi-thinking 是 md-deepseek 最后的设置页、一个档案补了取自 pi 的 catalog（synthetic，见
// deepseekPiThinking），测第四种提示让给 pi 的那一条。
// synthetic-deepseek-no-profile 是 md-deepseek 最后的设置页、去掉一个已配置模型的档案（synthetic，见 deepseekNoProfile，
// 2026-10-26 补），测没有档案、不在探测的模型行。

import { createReplayBridge } from './replay.js';

const globbed = {
  ...import.meta.glob('../../fixtures/m1/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m2/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m3/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m4/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m5/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m6/*.json', { eager: true, import: 'default' }),
  // v1（docs/specs/model-providers.md §14.4）：模型层的录制；文件夹为空或还没有时 glob 得到空对象
  ...import.meta.glob('../../fixtures/v1/*.json', { eager: true, import: 'default' }),
  // 平行 Agent（docs/specs/parallel-agents-taskboard.md §17.4）：TaskBoard 的录制；文件夹为空或还没有时同样是空对象
  ...import.meta.glob('../../fixtures/tb/*.json', { eager: true, import: 'default' }),
  // 普通模式的 subagent 工具（docs/specs/subagent.md §14.1）：tb-record.mjs 从真实会话录下；文件夹还没有时同样是空对象
  ...import.meta.glob('../../fixtures/sa/*.json', { eager: true, import: 'default' }),
  // 记忆（docs/specs/memory.md §14.1）：从真实的 App 对合成端点录下（synthetic）；文件夹为空或还没有时同样是空对象
  ...import.meta.glob('../../fixtures/mem/*.json', { eager: true, import: 'default' }),
  // 一键拉取模型（docs/specs/model-discovery.md §13.1）：md-record.mjs 从真实的 App 录下（各文件的 source 写明 real 或
  // synthetic）；文件夹为空或还没有时同样是空对象
  ...import.meta.glob('../../fixtures/discovery/ui/*.json', { eager: true, import: 'default' }),
  // 收尾检查（docs/specs/finish-check.md §14.1）：fc-record.mjs 从真实的 App 对合成端点录下的（source 为 synthetic）与
  // fc-real.mjs 的真实录制 fc-*-real.json（source 为 real）；文件夹为空或还没有时同样是空对象
  ...import.meta.glob('../../fixtures/finish/*.json', { eager: true, import: 'default' }),
};
const params = new URLSearchParams(location.search);
const name = params.get('fixture') ?? 'readme';

/** @brief 按文件名（不含目录和扩展名）索引录制文件；m1 与 m2 里有同名文件时报错。 */
function indexByName(files) {
  const byName = new Map();
  for (const [path, data] of Object.entries(files)) {
    const key = path.split('/').pop().replace(/\.json$/, '');
    if (byName.has(key)) throw new Error(`Duplicate fixture name ${key}`);
    byName.set(key, data);
  }
  return byName;
}

const fixtures = indexByName(globbed);

/** @brief 按名字取录制文件。 */
function fixture(fixtureName) {
  const found = fixtures.get(fixtureName);
  if (!found) throw new Error(`Unknown fixture ${fixtureName}`);
  return found;
}

/** @brief synthetic：把 queue-steer 的会话记录重复 15 次，作为 session.open 的结果。 */
function longHistory() {
  const base = fixture('queue-steer');
  const created = base.steps.find((step) => step.result?.type === 'session.create');
  const opened = base.steps.find((step) => step.result?.type === 'session.open');
  const entries = [];
  for (let round = 0; round < 15; round += 1) {
    for (const entry of opened.result.value.entries) {
      if (entry.type !== 'message' || entry.message.role === 'system') continue;
      const message = structuredClone(entry.message);
      if (message.role === 'user') {
        const text = typeof message.content === 'string' ? message.content
          : message.content.map((part) => part.text ?? '').join('');
        message.content = [{ type: 'text', text: `第 ${round + 1} 轮 · ${text}` }];
      }
      if (message.role === 'assistant') {
        message.content = message.content.map((part) => (part.type === 'toolCall'
          ? { ...part, id: `${part.id}-${round}` } : part));
      }
      if (message.role === 'toolResult') message.toolCallId = `${message.toolCallId}-${round}`;
      entries.push({ ...entry, id: `${entry.id}-${round}`, message });
    }
  }
  return { ...base, source: 'synthetic', name: 'synthetic-long-history', steps: [
    { t: 0, command: { type: 'session.create', cwd: created.result.value.cwd } },
    { t: 1, result: created.result },
    { t: 2, command: { type: 'session.open', sessionFile: created.result.value.sessionFile } },
    { t: 3, result: { type: 'session.open', value: { ...opened.result.value, entries } } },
  ] };
}

/** synthetic-long-steps 里那一轮的调用次数：60 条只有调用的回复，重新打开时只载入最近 50 条，组被切开 */
const LONG_STEPS = 60;

/**
 * @brief synthetic：一轮里 LONG_STEPS 条只有一次 bash 调用的助手回复，最后一条只有正文的回答（取 queue-steer 会话记录里
 *        第一条你的消息、第一次调用与它的结果、最后一条回答的正文，调用换编号重复），作为 session.open 的结果（打开两次）。
 *        重新打开时只载入最近 50 条，这一轮的步骤组被"Scroll up to load earlier messages"切开（docs/v0/screens/chat.md
 *        "步骤组"的"只载入了一部分"，2026-10-26 走查 M18）。
 */
function longSteps() {
  const base = fixture('queue-steer');
  const created = base.steps.find((step) => step.result?.type === 'session.create');
  const opened = base.steps.find((step) => step.result?.type === 'session.open');
  const messages = opened.result.value.entries.filter((entry) => entry.type === 'message');
  const roleOf = (role) => (entry) => entry.message.role === role;
  const user = messages.find(roleOf('user'));
  const call = messages.find(roleOf('assistant'));
  const result = messages.find(roleOf('toolResult'));
  const answer = messages.findLast(roleOf('assistant'));
  const entries = [user];
  for (let n = 0; n < LONG_STEPS; n += 1) {
    const content = call.message.content.map((part) => ({ ...part, id: `${part.id}-${n}` }));
    entries.push({ ...call, id: `${call.id}-${n}`, message: { ...call.message, content } },
      { ...result, id: `${result.id}-${n}`, message: { ...result.message, toolCallId: content[0].id } });
  }
  const text = answer.message.content.filter((part) => part.type === 'text');
  entries.push({ ...answer, message: { ...answer.message, content: text } });
  // 重新打开两次（m1-replay steps-history：第二次 Restart 之后看你展开过的组回到折起）
  const open = (t) => [{ t, command: { type: 'session.open', sessionFile: created.result.value.sessionFile } },
    { t: t + 1, result: { type: 'session.open', value: { ...opened.result.value, entries } } }];
  return { ...base, source: 'synthetic', name: 'synthetic-long-steps', steps: [
    { t: 0, command: { type: 'session.create', cwd: created.result.value.cwd } },
    { t: 1, result: created.result }, ...open(2), ...open(4),
  ] };
}

/**
 * @brief synthetic：mcp 的录制在打开任何会话之前就用 mcp.save 加了三个服务，而界面只在有会话时才有"MCP"一节
 *        （docs/v0/screens/tools.md），照录制的顺序点不出来。这里在第一条 mcp.save 之前补一个先打开的会话（同一个
 *        文件夹；会话信息照录制的 session.create 结果，换一个 id 和会话文件），并补上它在工具页读到的内容：照录制里
 *        第一个 tools.get 的结果（那时新会话还没连上任何服务），MCP 服务按保存的进度列出（保存前没有，每保存一个多一个），
 *        工具名为空（补上的会话打开时还没有这些服务）。其余的命令、结果和事件都是录制的原样：界面在补上的会话的工具页里
 *        添加服务，再点"New session"建出录制里的会话。
 */
function mcpSetup() {
  const base = fixture('mcp');
  const created = base.steps.find((step) => step.result?.type === 'session.create').result.value;
  const firstTools = base.steps.find((step) => step.result?.type === 'tools.get').result.value;
  const id = 'synthetic-setup-session';
  const setup = { ...created, sessionId: id, sessionFile: created.sessionFile.replace(created.sessionId, id) };
  const toolsWith = (t, count) => ({ t, synthetic: true, result: { type: 'tools.get', value: { ...firstTools,
    mcp: { ...firstTools.mcp, servers: firstTools.mcp.servers.slice(0, count) } } } });
  const firstSave = base.steps.findIndex((step) => step.command?.type === 'mcp.save');
  const steps = [];
  let saved = 0;
  for (const [index, step] of base.steps.entries()) {
    if (index === firstSave) {
      steps.push({ t: step.t, synthetic: true, command: { type: 'session.create', cwd: created.cwd } },
        { t: step.t, synthetic: true, result: { type: 'session.create', value: setup } }, toolsWith(step.t, 0));
    }
    steps.push(step);
    if (step.result?.type === 'mcp.save') {
      saved += 1;
      steps.push(toolsWith(step.t, saved));
    }
  }
  return { ...base, source: 'synthetic', name: 'synthetic-mcp-setup', steps };
}

/**
 * synthetic：mermaid 回复里能画的图（2026-10-26 走查 M16，docs/v0/screens/chat.md"图"）：一张流程图（中文标签、
 * 引号里的 <br/>，同你两个会话里的写法），再加时序、类、状态、甘特和 pie（langium 解析）各一张小图，
 * 看各种图在内容安全策略下都画得出来（m1-replay 按 SVG 的 aria-roledescription 认图的种类）
 */
const MERMAID_DRAWN = [
  ['flowchart LR', '  A["读取配置<br/>settings.json"] --> B{"找到 Git Bash？"}', '  B -- 是 --> C["设置 shellPath"]',
    '  B -- 否 --> D["提示安装<br/>Git for Windows"]'],
  ['sequenceDiagram', '  participant U as 用户', '  participant M as Mori', '  U->>M: 发送消息', '  M-->>U: 回复'],
  ['classDiagram', '  class Session {', '    +string id', '    +send(text)', '  }', '  Session --> Tab'],
  ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> Running: send', '  Running --> Idle: done'],
  ['gantt', '  title 发布计划', '  dateFormat YYYY-MM-DD', '  section 构建', '  检查 :a1, 2026-10-26, 1d',
    '  打包 :after a1, 1d'],
  ['pie title 用量', '  "输入" : 60', '  "输出" : 40'],
];

/** synthetic：画不出来的三张：语法错误、超过 2 万字（MermaidBlock.tsx MAX_TEXT）、401 条边（maxEdges 400） */
const MERMAID_BROKEN = [
  ['not a diagram at all'],
  ['flowchart LR', `  A["${'x'.repeat(20000)}"] --> B`],
  ['flowchart LR', ...Array.from({ length: 401 }, (_, index) => `  n${index} --> n${index + 1}`)],
];

/** @brief 一个 mermaid 代码块（连同后面的空行）的各行。 */
const mermaidFence = (lines) => ['```mermaid', ...lines, '```', ''];

/**
 * synthetic：mermaid 回复的正文。开头一段 ts 代码块（2026-10-26 补测）：这段正文还在生成时，其中任何语言的代码块
 * "Copy code"都不可用（docs/v0/screens/chat.md"生成中那段正文里的代码块"，2026-10-26 补，U14）
 */
const MERMAID_TEXT = ['先看一段代码：', '', '```ts', 'const steps = 3;', '```', '', '流程如下：', '',
  ...MERMAID_DRAWN.flatMap(mermaidFence), '这几张画不出来：', '', ...MERMAID_BROKEN.flatMap(mermaidFence)].join('\n');

/** synthetic：停在 mermaid 代码块中间的两种正文（没有结束的 ```）：截在一整行边之后、截在节点标签中间 */
const MERMAID_STOPPED = {
  line: ['停止前写到这里：', '', '```mermaid', 'flowchart LR', '  A["开始"] --> B["写完的边"]', ''].join('\n'),
  label: ['停止前写到这里：', '', '```mermaid', 'flowchart LR', '  A["开始"] --> B["写到一半'].join('\n'),
};

/**
 * synthetic：生成中那段正文里的代码块（2026-10-26 补，U14，docs/v0/screens/chat.md"生成中那段正文里的代码块"）：
 * 一段写完的短 ts 代码块，再一段 60 行的 ts 代码块（高过 Streamdown 的 400px 上限，在块里滚动），最后一句话
 */
const CODE_ROWS = Array.from({ length: 60 },
  (_, index) => `const row${String(index + 1).padStart(2, '0')} = ${index + 1};`);
const CODE_STREAM_TEXT = ['先看一段短代码：', '', '```ts', 'const short = 1;', '```', '', '再看一段长代码：', '', '```ts',
  ...CODE_ROWS, '```', '', '写完了。'].join('\n');
/**
 * synthetic-code-stream 的停顿：长代码块写完这几行（连同换行）时回放各停 CODE_PAUSE_MS，m1-replay 在停顿里量代码块的
 * 滚动位置、在块里往上滚、滚回底部（m1-replay.mjs CODE_PAUSES 与它相同）
 */
const CODE_PAUSE_AFTER = ['const row30 = 30;', 'const row45 = 45;', 'const row60 = 60;'];
const CODE_PAUSE_MS = 2500;
/**
 * synthetic-code-stream 的正文增量每隔多少毫秒一段（每段约 6 个字，代码每 3 段多一行）。录制里的增量是一阵一阵的、
 * 几毫秒一段；这里改成匀速，代码多一行的间隔（约 90ms）比 Streamdown 滚到底、scroll 事件送到的两帧长
 */
const CODE_DELTA_MS = 30;

/**
 * @brief 把长度为 length 的正文切成 count 段的分界：均分；cuts 里的每个位置一定是某一段的结尾（把落在它上面的那个分界
 *        挪到它），回放可以正好停在那里。
 */
function deltaBounds(length, count, cuts) {
  const size = Math.ceil(length / count);
  const bounds = Array.from({ length: count + 1 }, (_, index) => Math.min(length, index * size));
  for (const cut of cuts) {
    const at = bounds.findIndex((bound) => bound >= cut);
    if (at > 0) bounds[at] = cut;
  }
  return bounds;
}

/**
 * @brief synthetic：把 markdown 录制（真实会话）的回复正文换成 text：每个 text_delta 按原来的次数和时间切出
 *        一段，message_end / turn_end / agent_end 里的整段正文换成它。其余（命令、结果、思考、用量）是录制的原样。
 *        stopped 为真时这条回复以停止结束：结束事件里的 stopReason 换成 aborted，agent_settled 的 aborted 为真
 *        （界面照常显示"Stopped · …"一行）。cuts：正文里必须是某一段结尾的位置（deltaBounds）。
 */
function replyWith(text, name, { stopped = false, cuts = [] } = {}) {
  const base = fixture('markdown');
  const end = base.steps.find((step) => step.envelope?.event?.type === 'message_end'
    && step.envelope.event.message.role === 'assistant');
  const original = end.envelope.event.message.content.find((part) => part.type === 'text').text;
  const escaped = (value) => JSON.stringify(value).slice(1, -1);
  const deltas = base.steps.filter((step) => step.envelope?.event?.update?.type === 'text_delta').length;
  const bounds = deltaBounds(text.length, deltas, cuts);
  let index = 0;
  const steps = base.steps.map((step) => {
    const update = step.envelope?.event?.update;
    if (update?.type !== 'text_delta') {
      let json = JSON.stringify(step).replaceAll(escaped(original), escaped(text));
      if (stopped) {
        json = json.replaceAll('"stopReason":"stop"', '"stopReason":"aborted"')
          .replace('"type":"agent_settled","aborted":false', '"type":"agent_settled","aborted":true');
      }
      return JSON.parse(json);
    }
    const delta = text.slice(bounds[index], bounds[index + 1]);
    index += 1;
    return { ...step, envelope: { ...step.envelope, event: { ...step.envelope.event, update: { ...update, delta } } } };
  });
  return { ...base, source: 'synthetic', name, steps };
}

/**
 * @brief synthetic：markdown 录制换成 CODE_STREAM_TEXT（replyWith），正文增量从第二段起每 CODE_DELTA_MS 一段，
 *        长代码块写完 CODE_PAUSE_AFTER 的每一行时停 CODE_PAUSE_MS（那一段正好在这一行的换行之后结束）；其余步骤
 *        之间的间隔照录制，整体跟着推后（回放时 maxGap 要大于停顿）。
 */
function codeStream() {
  const cuts = CODE_PAUSE_AFTER.map((line) => CODE_STREAM_TEXT.indexOf(`${line}\n`) + line.length + 1);
  const base = replyWith(CODE_STREAM_TEXT, 'synthetic-code-stream', { cuts });
  let written = 0;
  let pause = 0;
  let clock = 0;
  let previous = 0;
  const steps = base.steps.map((step) => {
    const update = step.envelope?.event?.update;
    const delta = update?.type === 'text_delta' ? update.delta : null;
    clock += (delta !== null && written > 0 ? CODE_DELTA_MS : step.t - previous) + pause;
    previous = step.t;
    pause = 0;
    written += delta?.length ?? 0;
    if (delta && cuts.includes(written)) pause = CODE_PAUSE_MS;
    return { ...step, t: clock };
  });
  return { ...base, steps };
}

/**
 * @brief synthetic：md-openrouter（真实录制：Add provider 里拉取 OpenRouter 的公开列表）的 config.get 改成首次启动
 *        （firstRun 为真），界面因此显示首次启动表单；表单里 Fetch models 发的 models.discover 与 Add provider 的
 *        写法相同（Checklist.tsx newTarget），回放桥按地址用录下的真实结果回答。只用来测首次启动表单的清单里取自 pi
 *        模型表的值（"From pi"）与手填的行（2026-10-26，WP-15，docs/v1/screens/first-run.md "清单""Add a model ID"）。
 */
function openrouterFirstRun() {
  const base = fixture('md-openrouter');
  const steps = base.steps.map((step) => (step.result?.type === 'config.get' && step.result.value
    ? { ...step, result: { ...step.result, value: { ...step.result.value, firstRun: true } } } : step));
  return { ...base, source: 'synthetic', name: 'synthetic-openrouter-first-run', steps };
}

/** synthetic-deepseek-pi-thinking 里补了 catalog 的模型（合成端点总先回一段思考，档案的推理字段是 reasoning_content） */
const PI_THINKING_REF = '127-0-0-1-4860/fake-ds-alwaysthink';

/**
 * @brief synthetic：md-deepseek（对合成端点录下）最后一个 models.get 换掉录制里每一个 models.get（设置页一开始就是加入之后的
 *        样子），并给 PI_THINKING_REF 的档案补一个取自 pi 的 catalog（只有思考为真，提供商名 Z.AI）。真实的后台进程只在
 *        pi 认得的地址上给 catalog，合成端点在 127.0.0.1 造不出这种档案；只用来测模型行的 "This model returned thinking
 *        content." 在 pi 的思考提示出现时不出（2026-10-26，WP-15，models-settings.md "模型行的提示"）。
 */
function deepseekPiThinking() {
  const base = fixture('md-deepseek');
  const last = base.steps.findLast((step) => step.result?.type === 'models.get' && !step.result.error).result.value;
  const value = structuredClone(last);
  value.profiles[PI_THINKING_REF] = { ...value.profiles[PI_THINKING_REF],
    catalog: { provider: 'Z.AI', contextWindow: null, maxTokens: null, reasoning: true } };
  const steps = base.steps.map((step) => (step.result?.type === 'models.get' && !step.result.error
    ? { ...step, result: { ...step.result, value } } : step));
  return { ...base, source: 'synthetic', name: 'synthetic-deepseek-pi-thinking', steps };
}

/** synthetic-deepseek-no-profile 里去掉档案的模型（md-deepseek 里已配置、探测过的一个） */
const NO_PROFILE_REF = '127-0-0-1-4860/fake-ds-alwaysthink';

/** @brief 一个 mori.profiles 信封去掉 NO_PROFILE_REF 的档案与正在跑的探针。 */
function withoutProfileEnvelope(envelope) {
  const event = envelope?.event;
  if (event?.type !== 'mori.profiles') return envelope;
  const profiles = Object.fromEntries(Object.entries(event.profiles ?? {}).filter(([ref]) => ref !== NO_PROFILE_REF));
  const running = (event.running ?? []).filter((item) => item.ref !== NO_PROFILE_REF);
  return { ...envelope, event: { ...event, profiles, running } };
}

/**
 * @brief synthetic（2026-10-26 补）：md-deepseek（对合成端点录下）最后一个 models.get 换掉录制里每一个 models.get（设置页一开始
 *        就是加入之后的样子），并去掉 NO_PROFILE_REF 的档案（录下的 mori.profiles 信封里也去掉它的档案与正在跑的探针）。
 *        真实的后台进程只在探针抛错、档案没建成、探针没能开始时有这种模型（models-settings.md “Models 行”的“没有档案、
 *        不在探测”），App 测试造不出来；只用来测这一行的状态行“Couldn’t verify”与 Verify again（md-replay.mjs）。
 */
function deepseekNoProfile() {
  const base = fixture('md-deepseek');
  const last = base.steps.findLast((step) => step.result?.type === 'models.get' && !step.result.error).result.value;
  const value = structuredClone(last);
  delete value.profiles[NO_PROFILE_REF];
  const steps = base.steps.map((step) => {
    if (step.result?.type === 'models.get' && !step.result.error) return { ...step, result: { ...step.result, value } };
    return step.envelope ? { ...step, envelope: withoutProfileEnvelope(step.envelope) } : step;
  });
  return { ...base, source: 'synthetic', name: 'synthetic-deepseek-no-profile', steps };
}

/** synthetic 的录制：名字 → 拼法 */
const SYNTHETIC = { 'synthetic-long-history': longHistory, 'synthetic-long-steps': longSteps,
  'synthetic-mcp-setup': mcpSetup,
  'synthetic-mermaid': () => replyWith(MERMAID_TEXT, 'synthetic-mermaid'),
  'synthetic-mermaid-stop-line': () => replyWith(MERMAID_STOPPED.line, 'synthetic-mermaid-stop-line',
    { stopped: true }),
  'synthetic-mermaid-stop-label': () => replyWith(MERMAID_STOPPED.label, 'synthetic-mermaid-stop-label',
    { stopped: true }),
  'synthetic-code-stream': codeStream, 'synthetic-openrouter-first-run': openrouterFirstRun,
  'synthetic-deepseek-pi-thinking': deepseekPiThinking, 'synthetic-deepseek-no-profile': deepseekNoProfile };

if (params.get('keepDrafts') !== '1') {
  localStorage.removeItem('mori.drafts');
  localStorage.removeItem('mori.draftRefs');
  localStorage.removeItem('mori.archived');
  localStorage.removeItem('mori.review');
}
const data = Object.hasOwn(SYNTHETIC, name) ? SYNTHETIC[name]() : fixture(name);
const { bridge, control } = createReplayBridge(data, {
  speed: Number(params.get('speed') ?? 1),
  maxGap: Number(params.get('maxGap') ?? 1500),
  part: params.get('part'),
  holdList: params.get('holdList') === '1',
});
window.mori = bridge;
window.__replay = control;
await import('../../../src/renderer/src/main.tsx');
